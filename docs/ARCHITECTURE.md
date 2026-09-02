# Architecture

> English reference for developers who want to extend the system.
> For day-to-day operation in Persian see `docs/USER-MANUAL-FA.md`.

## 1. Components & trust boundaries

```
                    ┌──────────────────────────────┐
   Internet         │        Cloudflare (proxy)    │  TLS termination #1
   visitors ───────►│  DNS call.<domain>, WSS ok,  │
                    │  Worker: edge-cache widget.js│
                    └───────────────┬──────────────┘
                                    │ HTTPS 443
                    ┌───────────────▼──────────────┐
   DMZ / app host   │  nginx (vhost call-*.conf)   │
   (APP_HOST)       │  /ws  ─────────────┐         │
                    │  /    ──► Node app │ │ :3006 │──► MySQL/MariaDB (callcenter)
                    │  coturn :3478 ◄────┘ │       │      (users,calls,call_events,
                    └───────────────┬──────┘        │       visitors,surveys,settings)
                                    │ LAN           │ SFTP pull recordings
                    ┌───────────────▼──────────────┐
   LAN / PBX host   │  Asterisk                    │
   (PBX_HOST)       │  PJSIP WSS/WS :8088 (HTTP)   │
                    │  AMI :5038 (LAN only)        │
                    │  RTP 10000-10199             │
                    │  recordings → /var/spool/... │
                    └──────────────────────────────┘
```

- The PBX is **never** exposed to the internet. Signaling terminates on nginx,
  media reaches Asterisk via the LAN (same-host installs) or via TURN/TCP 3478
  (split networks / restrictive upstream).
- The Node app listens on `127.0.0.1:3006`; only nginx talks to it.

## 2. Runtime flow (visitor call)

1. `widget.js` (v2) is embedded on the site. It lazily loads `sip.js` (vendored
   in `backend/public/`) only when the visitor actually calls.
2. Widget fetches runtime config from `GET /api/widget/config` — WS URL, dial
   extension, ICE/TURN servers, branding. **All behavior is server-driven.**
3. On `startCall`: permission flow → `getUserMedia` → SIP REGISTER (`visitor`
   account, shared, `max_contacts=30`) → INVITE to dial ext.
4. Asterisk `from-widget` context: Answer → MixMonitor (recording) →
   Persian IVR prompts → `Queue(support,tT,,,600)` → after queue exit →
   `Read(RATING,beep)` (1–5) → `UserEvent(CallSurvey)`.
5. AMI events (`Newchannel`, `QueueCallerJoin`, `AgentConnect`, `Hangup`,
   `UserEvent CallSurvey`, `QueueMember*`) drive the backend state machine in
   `runtime.js` which writes `calls` / `call_events` / `surveys` and emits
   Socket.IO events (`call:new`, `call:incoming`, `pop:data`, `queue:status`).
6. Recordings: backend pulls `*.wav` from the PBX spool over SFTP ~6 s after
   hangup (`pullRecording`), stores in `/opt/callcenter/recordings`, links in CDR.

## 3. Data model (MySQL `callcenter`)

| Table | Purpose |
|---|---|
| `users` | admin/operator accounts; `sip_ext` maps to PJSIP endpoints 1000–1005 |
| `calls` | one row per visitor call: visitor meta, status lifecycle, wait/talk secs, operator ext, survey rating, recording path |
| `call_events` | raw AMI-derived timeline per call |
| `visitors` | widget-side identity (visitor_id in localStorage, announced with page/IP/name/phone/email) |
| `surveys` | rating rows (source: ivr or widget) |
| `settings` | key/value (remote DB connector config, etc.) |

## 4. Socket.IO rooms & auth

- JWT (12 h) required for REST (`Authorization: Bearer`) and Socket.IO
  (`handshake.auth.token`).
- Rooms: `admin` (role=admin), `operators`, `op:<ext>` (targeted push: ringing,
  CRM popup data, call ended).

## 5. Extension points

| Want to… | Touch |
|---|---|
| Add operator extensions | `asterisk/conf/pjsip.conf.tmpl` (copy a block), backend `SIP_CREDS` loop range, admin panel mapping |
| Change IVR wording/languages | `asterisk/sounds/fa/custom/*.wav` + `scripts/generate-ivr-audio.mjs` (edge-tts) |
| Change queue strategy/limits | `asterisk/conf/queues.conf` |
| Add REST endpoints | `backend/server.js` (follow the `auth(["admin"])` pattern) |
| New CRM source (Postgres, HTTP API…) | `backend/lib/remote.js` — implement `lookupCustomer({phone,email})` + `getConfig()/saveConfig()` |
| Rebrand widget | `CC_BRAND_*` env or serve custom `brand` in `/api/widget/config` |
| Ship widget via other CDN | any static host; the widget only needs its API origin (patch in installer step) |
| Multi-tenant | run one stack per domain; templates + `.env` already isolate domain, DB, SIP creds |

## 6. Design decisions worth knowing

- **ulaw only**: codec-safe across WebRTC implementations without extra
  modules; opus silently breaks IVR audio when the module is missing.
- **shared `visitor` account**: one REGISTER per visitor connection is wasteful;
  shared account with high `max_contacts` keeps REGISTER storms away and is
  protected by the widget's single-flight register logic.
- **register after connect**: SIP.js must send REGISTER after the WS is open —
  doing it earlier produces ghost offline endpoints (v2 fix).
- **CORS reflect-origin**: the widget is cross-origin (site → call.<domain>),
  the backend reflects the Origin header; missing header was the production
  "button does nothing" bug.
- **modules.conf guard**: CI validates the `[modules]` header because the live
  server once shipped a corrupted header that silently disabled `noload`.
- **maxAge=0 on panels**: operator/admin HTML must never be cached by proxies;
  widget.js is cacheable (edge Worker uses version keys).

## 7. Security model

- Internet-facing: 443 (nginx), 3478 (TURN) only.
- AMI restricted by `permit=<APP_HOST>`; dialplan internal callback endpoint is
  IP-allowlisted (`internalGuard`).
- All passwords rotatable via `installer/config.example.conf` (empty → generated,
  saved chmod 600) or `backend/.env`; rotate the defaults before public repos.
- Remote DB connector is read-only by contract (user grants SELECT-only).
