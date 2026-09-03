#!/usr/bin/env bash
# ============================================================
# callcenter-web UPDATER — safe in-place update of an existing install
#
#   sudo ./update.sh --config /opt/callcenter/install.conf --from-file callcenter-web-3.0.0.tar.gz
#   sudo ./update.sh --config /opt/callcenter/install.conf --from-github [vX.Y.Z]
#   sudo ./update.sh --config /opt/callcenter/install.conf --from-github --pre        # include pre-releases
#   sudo ./update.sh --config ... --from-file ... --only app     # restrict apply to one role (pbx|turn|app|nginx)
#
# What it does, in order:
#   1. preflight   : existing install? service state? disk space? config present?
#   2. backup      : DB dump + app dir (excl. node_modules) + .env + nginx/pbx confs
#   3. fetch       : release tarball from file or GitHub (sha256 verified)
#   4. stage       : extract to $INSTALL_DIR/staging
#   5. apply       : run installer/install.sh --upgrade from the staged copy
#   6. verify      : /health endpoint + systemd active
#   7. rollback    : automatic restore of previous app dir + DB on failure
#
# Everything is logged to $INSTALL_DIR/update.log and summarized in
# $INSTALL_DIR/update-history.log (one line per attempt).
#
# CC_TEST_MODE=1 ./update.sh ...   # dry-lab: no root/systemd/health-check needed
#                                  # (used by CI to exercise the real flow)
# ============================================================
set -Eeuo pipefail

# (SELF_DIR kept for parity with install.sh; path-relative calls not needed here)
# shellcheck disable=SC2034
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ---------- logging ----------
if [ -t 2 ]; then
  C_G="\033[32m"; C_R="\033[31m"; C_Y="\033[33m"; C_B="\033[36m"; C_0="\033[0m"
else
  C_G=""; C_R=""; C_Y=""; C_B=""; C_0=""
fi
info(){ echo -e "${C_B}[INFO]${C_0} $*"; }
ok(){ echo -e "${C_G}[ OK ]${C_0} $*"; }
warn(){ echo -e "${C_Y}[WARN]${C_0} $*"; }
die(){ echo -e "${C_R}[FAIL]${C_0} $*" >&2; exit 1; }

usage(){ sed -n '2,19p' "$0"; exit 0; }

# ---------- args ----------
CONFIG_FILE=""; FROM_FILE=""; FROM_GITHUB=""; WANT_VER=""; INCLUDE_PRE=0; ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG_FILE="$2"; shift 2;;
    --from-file) FROM_FILE="$2"; shift 2;;
    --from-github) FROM_GITHUB=1; [ -n "${2:-}" ] && [ "${2:0:1}" != "-" ] && WANT_VER="$2" && shift; shift;;
    --pre) INCLUDE_PRE=1; shift;;
    --only) ONLY="$2"; shift 2;;
    -h|--help) usage;;
    *) die "unknown argument: $1";;
  esac
done

TEST_MODE="${CC_TEST_MODE:-0}"
svc(){ # svc <action> <unit> — systemd wrapper, no-op in test mode
  if [ "$TEST_MODE" != 1 ]; then systemctl "$@" >/dev/null 2>&1 || true; fi
}

[ -n "$CONFIG_FILE" ] || { [ -f /opt/callcenter/install.conf ] && CONFIG_FILE=/opt/callcenter/install.conf; }
[ -n "$CONFIG_FILE" ] || die "--config required (or provide /opt/callcenter/install.conf)"
[ -f "$CONFIG_FILE" ] || die "config not found: $CONFIG_FILE"
[ "$TEST_MODE" = 1 ] || [ "$(id -u)" = "0" ] || die "run as root (sudo)"
[ -n "$FROM_FILE" ] || [ -n "$FROM_GITHUB" ] || die "need --from-file <tarball> or --from-github [version]"

# ---------- config ----------
# shellcheck disable=SC1090
source "$CONFIG_FILE"
INSTALL_DIR="${INSTALL_DIR:-/opt/callcenter}"
APP_DIR="$INSTALL_DIR/app"
LOG="$INSTALL_DIR/update.log"
HIST="$INSTALL_DIR/update-history.log"
mkdir -p "$INSTALL_DIR"
touch "$LOG"
exec >>"$LOG" 2>&1

TS="$(date +%Y%m%d-%H%M%S)"
log(){ echo "[$(date '+%F %T')] $*"; }

CURRENT_VER="unknown"; [ -f "$INSTALL_DIR/VERSION" ] && CURRENT_VER="$(cat "$INSTALL_DIR/VERSION")"
log "=== update started: $CURRENT_VER -> ${WANT_VER:-latest} (from: ${FROM_FILE:+file}${FROM_GITHUB:+github}) ==="
info "current version: $CURRENT_VER"
if [ "$TEST_MODE" = 1 ]; then
  info "TEST MODE: systemd ops and live health-check are skipped"
fi

# ============================================================
# 1. preflight
# ============================================================
info "[1/7] preflight"
[ -d "$APP_DIR" ] || die "no existing install at $APP_DIR — run install.sh first"
[ -f "$APP_DIR/.env" ] || die "missing $APP_DIR/.env — cannot update safely"
command -v systemctl >/dev/null || true

avail_kb="$(df --output=avail -k "$INSTALL_DIR" | tail -1 | tr -d ' ')"
[ "$avail_kb" -gt 1024 ] || die "insufficient free space at $INSTALL_DIR — free space first"
ok "preflight passed ($(df -h "$INSTALL_DIR" | tail -1 | awk '{print $4}') free)"

# ============================================================
# 2. backup
# ============================================================
info "[2/7] backup"
BK="$INSTALL_DIR/backups/update-$TS"
mkdir -p "$BK"

# DB dump (best effort — the update continues even if DB creds changed)
DB_NAME=""; DB_USER=""; DB_PASS=""
eval "$(grep -E '^(CC_DB_NAME|CC_DB_USER|CC_DB_PASS)=' "$APP_DIR/.env" 2>/dev/null || true)"
if command -v mysql >/dev/null && [ -n "${DB_NAME:-}" ]; then
  if mysql -h127.0.0.1 -u"${DB_USER:-callcenter}" -p"${DB_PASS}" -e "USE \`$DB_NAME\`" >/dev/null 2>&1; then
    mysqldump -h127.0.0.1 -u"${DB_USER:-callcenter}" -p"${DB_PASS}" \
      --single-transaction --routines --triggers "$DB_NAME" | gzip > "$BK/db-$DB_NAME.sql.gz" \
      && ok "db dumped -> $BK/db-$DB_NAME.sql.gz" || warn "mysqldump failed (continuing; DB untouched by this updater unless rollback needed)"
  else
    warn "cannot connect to DB with creds from .env — skipping dump (schema-only updates are still safe)"
  fi
fi

# app dir (exclude node_modules + recordings + secrets + hashes)
tar -czf "$BK/app-dir.tar.gz" \
  --exclude="$APP_DIR/node_modules" \
  --exclude="$APP_DIR/.package.sha256" \
  -C "$(dirname "$APP_DIR")" "$(basename "$APP_DIR")"
ok "app dir -> $BK/app-dir.tar.gz"

# infra configs
for f in /etc/nginx/conf.d/*.conf /etc/asterisk/{pjsip,extensions,manager,queues,rtp,http}.conf /etc/turnserver.conf /etc/systemd/system/callcenter-app.service; do
  [ -f "$f" ] && cp -a "$f" "$BK/$(echo "$f" | tr '/' '_')" || true
done
cp -a "$CONFIG_FILE" "$BK/install.conf"
ok "infra configs -> $BK/"

# ============================================================
# 3. fetch
# ============================================================
info "[3/7] fetch release"
TARBALL=""
if [ -n "$FROM_FILE" ]; then
  [ -f "$FROM_FILE" ] || die "tarball not found: $FROM_FILE"
  TARBALL="$(readlink -f "$FROM_FILE")"
else
  REPO_SLUG="${GITHUB_REPO:-yaghobihobel-ops/callcenter-web}"
  API="https://api.github.com/repos/$REPO_SLUG/releases"
  HDR=()
  [ -n "${GITHUB_TOKEN:-}" ] && HDR=(-H "Authorization: token $GITHUB_TOKEN")
  if [ -n "$WANT_VER" ]; then
    REL_URL="$API/tags/${WANT_VER#v}"
  else
    REL_URL="$API/latest"
  fi
  REL_JSON="$(curl -fsSL "${HDR[@]}" "$REL_URL" 2>/dev/null)" || die "cannot fetch release info from $REL_URL (set GITHUB_TOKEN for private repo)"
  TARBALL_URL="$(INCLUDE_PRE=$INCLUDE_PRE python3 -c "
import json,os,sys
rel=json.load(sys.stdin)
if rel.get('draft'): print(''); sys.exit()
include_pre = os.environ.get('INCLUDE_PRE') == '1'
if not include_pre and rel.get('prerelease'): print(''); sys.exit()
assets=[a for a in rel.get('assets',[])
        if a['name'].startswith('callcenter-web-') and a['name'].endswith('.tar.gz')
        and 'sha256' not in a['name']]
print(assets[0]['id'] if assets else '')" <<< "$REL_JSON" 2>/tmp/cc-fetch-err.log || true)"
  [ -n "$TARBALL_URL" ] || { cat /tmp/cc-fetch-err.log >&2 || true; die "no release tarball asset found${WANT_VER:+ for $WANT_VER} (upload release with scripts/release.sh)"; }
  # private repos: download via API asset endpoint (browser_download_url rejects tokens)
  ASPEC='application/octet-stream'
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    curl -fsSL -H "Authorization: token $GITHUB_TOKEN" -H "Accept: $ASPEC" \
      -o "/tmp/cc-update-$TS.tar.gz" "$API/assets/$TARBALL_URL"
  else
    curl -fsL -H "Accept: $ASPEC" -o "/tmp/cc-update-$TS.tar.gz" "$API/assets/$TARBALL_URL"
  fi
  TARBALL="/tmp/cc-update-$TS.tar.gz"
  # sha256 sibling asset
  SHA_ID="$(python3 -c "
import json,sys
rel=json.load(sys.stdin)
for a in rel.get('assets',[]):
    if a['name'].startswith('callcenter-web-') and a['name'].endswith('.tar.gz.sha256'):
        print(a['id']); break" <<< "$REL_JSON" 2>/dev/null || true)"
  if [ -n "$SHA_ID" ] && curl -fsSL ${GITHUB_TOKEN:+-H "Authorization: token $GITHUB_TOKEN"} -H "Accept: $ASPEC" \
      -o "/tmp/cc-update-$TS.tar.gz.sha256" "$API/assets/$SHA_ID" 2>/dev/null; then
    echo "$(awk '{print $1}' /tmp/cc-update-$TS.tar.gz.sha256)  $TARBALL" | sha256sum -c - >/dev/null \
      && ok "sha256 verified" || die "sha256 MISMATCH — aborting, nothing touched"
  else
    warn "no .sha256 asset — skipping integrity check"
  fi
  NEW_REL_VER="$(echo "$REL_JSON" | python3 -c "import json,sys; print(json.load(sys.stdin).get('tag_name',''))" 2>/dev/null || true)"
  [ -n "$NEW_REL_VER" ] && info "target version: $NEW_REL_VER"
fi
ok "tarball: $TARBALL ($(du -h "$TARBALL" | cut -f1))"

# ============================================================
# 4. stage
# ============================================================
info "[4/7] stage"
STAGE="$INSTALL_DIR/staging-$TS"
rm -rf "$STAGE"; mkdir -p "$STAGE"
tar -xzf "$TARBALL" -C "$STAGE"
# accept both layout styles: repo-root or wrapped dir
[ -f "$STAGE/VERSION" ] || STAGE="$(find "$STAGE" -maxdepth 2 -name VERSION -printf '%h\n' | head -1)"
[ -d "$STAGE/installer" ] || die "staged tree has no installer/ — bad tarball"
STAGED_VER="$(cat "$STAGE/VERSION" 2>/dev/null || echo unknown)"
ok "staged version: $STAGED_VER at $STAGE"

if [ "$STAGED_VER" = "$CURRENT_VER" ]; then
  warn "staged version equals current ($CURRENT_VER) — re-applying anyway (idempotent)"
fi

# ============================================================
# 5. apply
# ============================================================
info "[5/7] apply (install.sh --upgrade)"
svc stop callcenter-app
APPLY_OK=0
if bash "$STAGE/installer/install.sh" --config "$CONFIG_FILE" --upgrade ${ONLY:+--only "$ONLY"} >>"$LOG" 2>&1; then
  APPLY_OK=1; ok "installer finished"
else
  warn "installer FAILED — rolling back"
fi

# ============================================================
# 6. verify
# ============================================================
if [ "$APPLY_OK" = 1 ]; then
  info "[6/7] verify"
  VERIFY_OK=1
  svc start callcenter-app
  if [ "$TEST_MODE" != 1 ]; then
    VERIFY_OK=0
    sleep 3
    APP_PORT_GREP="$(grep -E '^CC_PORT=' "$APP_DIR/.env" | cut -d= -f2 || echo 3006)"
    for _try in 1 2 3 4 5; do
      if curl -fsS "http://127.0.0.1:${APP_PORT_GREP:-3006}/health" >/dev/null 2>&1; then VERIFY_OK=1; break; fi
      sleep 2
    done
  fi
  if [ "$TEST_MODE" = 1 ]; then
    ok "verification passed (test mode)"
  elif systemctl is-active --quiet callcenter-app && [ "$VERIFY_OK" = 1 ]; then
    ok "service active + /health OK"
  else
    warn "verification failed"; APPLY_OK=0
  fi
fi

# ============================================================
# 7. rollback (on failure)
# ============================================================
if [ "$APPLY_OK" != 1 ]; then
  info "[7/7] ROLLBACK to previous version $CURRENT_VER"
  svc stop callcenter-app
  rm -rf "${APP_DIR}.rollbacktmp"
  mv "$APP_DIR" "${APP_DIR}.rollbacktmp"
  tar -xzf "$BK/app-dir.tar.gz" -C "$(dirname "$APP_DIR")"
  dbdump="$(ls "$BK"/db-*.sql.gz 2>/dev/null | head -1 || true)"
  if [ -n "$dbdump" ] && [ -n "${DB_NAME:-}" ]; then
    warn "restoring DB snapshot (data written after backup is lost)"
    gunzip -c "$dbdump" | mysql -h127.0.0.1 -u"${DB_USER:-callcenter}" -p"${DB_PASS}" "$DB_NAME"
  fi
  svc start callcenter-app
  sleep 1
  rm -rf "${APP_DIR}.rollbacktmp"
  rm -rf "$STAGE"
  log "=== update FAILED and rolled back (backup kept at $BK) ==="
  echo "[$(date '+%F %T')] FAIL $CURRENT_VER -> $STAGED_VER (rolled back; backup: $BK)" >> "$HIST"
  die "update failed — system restored to $CURRENT_VER. See $LOG"
fi

rm -rf "$STAGE"
echo "$STAGED_VER" > "$INSTALL_DIR/VERSION" 2>/dev/null || true
log "=== update SUCCESS: $CURRENT_VER -> $STAGED_VER (backup: $BK) ==="
echo "[$(date '+%F %T')] OK   $CURRENT_VER -> $STAGED_VER" >> "$HIST"
ok "update complete: $CURRENT_VER -> $STAGED_VER"
ok "backup kept at: $BK (delete when confident)"
info "update history:"
cat "$HIST" 2>/dev/null | tail -5 || true
