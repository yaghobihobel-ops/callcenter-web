# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [3.0.1] - 2026-09-03

### Fixed
- **better-sqlite3 pinned to 8.5.2** (exact) — v11 needs `-std=c++20` which
  AlmaLinux 8 / CentOS 8 gcc 8.5 cannot build; this broke `npm install` during
  the first production update (auto-rollback caught it).
- `update.sh` now parses `.env` **without `eval`** (safe under `set -u` for
  passwords containing `$ ! # { }`); installer quotes secret values in the
  `.env` template for the same reason.
- `update.sh --only <role>` passthrough added (e.g. `--only app` keeps the live
  nginx vhost and pbx untouched during app-only updates).
- installer logs npm output to `$INSTALL_DIR/npm-install.log` instead of
  discarding it, so native-build failures are diagnosable.

## [3.0.0] - 2026-09-03

### Added — Dashboard v3 (owner-grade redesign)
- **Admin console, 11 sections**: dash (KPI + today trend + alerts), live wallboard
  (active calls with listen/whisper/barge), quality (MOS/loss/jitter reports),
  ops (team management + pause reasons), queue (members + live status), CDR deep
  search, missed-call workbench, CRM customers, survey results, system health,
  settings (remote DB connector).
- **Operator console, 6 sections**: softphone (SIP.js over WSS, mute/hold/DTMF/
  blind + attended transfer), CRM 360 pop on incoming, my history, team chat,
  team presence board, settings.
- **Realtime**: Socket.IO presence + wallboard + chat; AMI event pipeline in
  `runtime.js` (Newchannel/Bridge/Hangup → call state machine).
- **Transfers**: blind (AMI Redirect → cc-transfer context) and attended
  (consult + AMI Bridge completion), admin monitor (ChanSpy listen/whisper/barge).
- **Callback queue**: missed calls become callbacks with SLA tracking and
  claim/done lifecycle.
- **Quality reporting**: per-call MOS/loss/jitter from both agent and visitor,
  aggregated summary for admin.
- MySQL/MariaDB storage (schema v3) with user-space MySQL test harness.

### Fixed
- `lib/pbx.js`: restored corrupted monitor/ChanSpy option parsing and added
  `listChannels()` (CoreShowChannels) export.
- Node 24 compatibility: `better-sqlite3` replaced by MariaDB-only storage
  (mysql2); version alignment across VERSION/package/CFG.

## [2.0.3] - 2026-09-02

### Added
- GitHub repository packaging: full source, docs, user manual, installer + verifier.
- `installer/install.sh` — idempotent, template-driven installer for the four
  roles `pbx` / `turn` / `app` / `nginx` (single-host or split LAN hosts).
- `installer/check.sh` — three modes: `--selftest` (CI), `--preflight`
  (read-only environment report), `--full` (post-install verification).
- `scripts/validate-asterisk.py` — static dialplan/pjsip/sounds validation.
- GitHub Actions for every component + scheduled live service monitor
  (07-monitor.yml) that opens/closes an incident issue automatically.
- Backend fully configurable via `.env` (CC_* variables) so the same code
  runs on any domain/host without code edits.

### Fixed
- `asterisk/conf/modules.conf` shipped with a proper section header
  (the live server file had a corrupted header that silently disabled
  every directive in the section).
- Backend widget config endpoint now derives `ws_url`, ICE/TURN servers and
  branding from environment instead of hard-coded values.

## [2.0.2] - 2026-09-01

### Fixed
- Widget: register timing (REGISTER sent only after WS connect), duplicate
  REGISTER single-flight, INVITE waits for `Connected`.
- Widget: queue-members panel binding failed outside panel context, which
  killed the `tel:` hook binding (the "contact button does nothing" bug).
- Asterisk: `allow=opus` removed (no codec on server → silent IVR, empty
  recordings); recordings start at Answer.

## [2.0.0] - 2026-09-01

### Added
- Widget v2: hooks existing contact buttons (`tel:`, `[data-fz-call]`,
  `.fz-call-trigger`), mobile bottom-sheet + desktop card, per-browser
  microphone-permission recovery guidance, `tel:` fallback card, lazy SIP.js.
- Operator panel v2 (blue glass theme): ready/break with automatic queue
  membership, ringing incoming-call modal + browser Notification, CRM popup,
  notes, mute, timer.
- Admin panel v2: stat tiles, 7-day chart, live queue, CDR + CSV + recording
  playback, operator management, remote-DB connector settings, live updates.
- Recordings pulled to app host via SFTP key.
- Cloudflare edge Worker caching for `widget.js` (version-keyed cache).
