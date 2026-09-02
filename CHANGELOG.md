# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
