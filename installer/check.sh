#!/usr/bin/env bash
# ============================================================
# callcenter-web verifier / checker
#
#   ./check.sh --selftest
#       CI mode: validates the REPO itself (templates, sounds, js, panels).
#       No root, no host changes. Used by GitHub Actions.
#
#   sudo ./check.sh --config my.conf --preflight
#       Target-host mode: reports whether this machine can host
#       the selected roles. READ-ONLY, changes nothing.
#
#   sudo ./check.sh --config my.conf --full [--pbx] [--app] [--nginx] [--turn]
#       Post-install mode: verifies services, ports, endpoints, DB,
#       AMI, WSS, sounds, recordings. Exit 0 only when all PASS.
# ============================================================
set -Eeuo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SELF_DIR")"
MODE=""; CONFIG_FILE=""; WANT_PBX=0; WANT_APP=0; WANT_NGINX=0; WANT_TURN=0
PASS=0; FAIL=0; WARN=0

if [ -t 2 ]; then C_G="\033[32m"; C_R="\033[31m"; C_Y="\033[33m"; C_B="\033[36m"; C_0="\033[0m"; else C_G=""; C_R=""; C_Y=""; C_B=""; C_0=""; fi
p_ok(){ echo -e "  ${C_G}[PASS]${C_0} $*"; PASS=$((PASS+1)); }
p_fail(){ echo -e "  ${C_R}[FAIL]${C_0} $*"; FAIL=$((FAIL+1)); }
p_warn(){ echo -e "  ${C_Y}[WARN]${C_0} $*"; WARN=$((WARN+1)); }
p_head(){ echo -e "${C_B}==> $*${C_0}"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --selftest) MODE=selftest; shift;;
    --preflight) MODE=preflight; shift;;
    --full) MODE=full; shift;;
    --config) CONFIG_FILE="$2"; shift 2;;
    --pbx) WANT_PBX=1; shift;;
    --app) WANT_APP=1; shift;;
    --nginx) WANT_NGINX=1; shift;;
    --turn) WANT_TURN=1; shift;;
    -h|--help) sed -n '2,17p' "$0"; exit 0;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$MODE" ] || { sed -n '2,17p' "$0"; exit 2; }

summary(){ echo ""; echo "======================================"; echo " PASS=$PASS FAIL=$FAIL WARN=$WARN"; echo "======================================"; [ "$FAIL" = 0 ]; }

have(){ command -v "$1" >/dev/null 2>&1; }

# ============================================================
# 1) SELFTEST — validate repo contents (CI)
# ============================================================
if [ "$MODE" = selftest ]; then
  p_head "repo structure"
  for f in README.md README.fa.md CHANGELOG.md VERSION \
           backend/server.js backend/runtime.js backend/package.json \
           backend/lib/ami.js backend/lib/db.js backend/lib/remote.js backend/lib/state.js \
           backend/public/widget.js backend/public/sip.js \
           backend/public/operator/index.html backend/public/admin/index.html \
           backend/.env.example \
           installer/install.sh installer/check.sh installer/config.example.conf \
           asterisk/conf/pjsip.conf.tmpl asterisk/conf/extensions.conf.tmpl \
           asterisk/conf/manager.conf.tmpl asterisk/conf/modules.conf \
           asterisk/conf/queues.conf asterisk/conf/rtp.conf asterisk/conf/http.conf \
           nginx/call-firuzo.conf.tmpl nginx/turnserver.conf.tmpl \
           worker/fz-call-widget-edge.js widget/widget-demo.html \
           docs/USER-MANUAL-FA.md docs/INSTALL-FA.md docs/ARCHITECTURE.md \
           docs/INTEGRATION-FA.md docs/TROUBLESHOOTING-FA.md; do
    [ -f "$REPO_DIR/$f" ] && p_ok "$f" || p_fail "missing $f"
  done

  p_head "templates contain placeholders"
  grep -q "__VISITOR_PASS__" "$REPO_DIR/asterisk/conf/pjsip.conf.tmpl" && p_ok "pjsip.tmpl visitor pass" || p_fail "pjsip.tmpl placeholder"
  grep -q "__CCAPI__" "$REPO_DIR/asterisk/conf/extensions.conf.tmpl" && p_ok "extensions.tmpl CCAPI" || p_fail "extensions.tmpl placeholder"
  grep -q "__CC_DOMAIN__" "$REPO_DIR/nginx/call-firuzo.conf.tmpl" && p_ok "vhost.tmpl domain" || p_fail "vhost.tmpl placeholder"
  grep -q "__PUBLIC_IP__" "$REPO_DIR/nginx/turnserver.conf.tmpl" && p_ok "turn.tmpl public ip" || p_fail "turn.tmpl placeholder"

  p_head "persian IVR sounds (WAV magic)"
  n=0; bad=0
  for w in "$REPO_DIR"/asterisk/sounds/fa/custom/*.wav; do
    [ -f "$w" ] || continue; n=$((n+1))
    head -c 4 "$w" | grep -q "RIFF" || bad=$((bad+1))
  done
  [ "$n" -ge 5 ] && p_ok "$n wav files present" || p_fail "too few wav files ($n)"
  [ "$bad" = 0 ] && p_ok "all wavs have RIFF header" || p_fail "$bad corrupt wav files"

  p_head "backend javascript"
  if have node; then
    for j in server.js runtime.js lib/ami.js lib/db.js lib/remote.js lib/state.js; do
      node --check "$REPO_DIR/backend/$j" 2>/dev/null && p_ok "node --check $j" || p_fail "syntax $j"
    done
  else
    p_warn "node not available here (CI image installs node separately)"
  fi

  p_head "widget requirements"
  grep -q "data-fz-call" "$REPO_DIR/backend/public/widget.js" && p_ok "hooks existing contact buttons" || p_fail "widget hooks"
  grep -q "FiruzoCall" "$REPO_DIR/backend/public/widget.js" && p_ok "JS API exposed" || p_fail "widget JS API"
  grep -q "getUserMedia\|mediaDevices" "$REPO_DIR/backend/public/widget.js" && p_ok "mic permission flow" || p_fail "mic flow"
  wsize=$(wc -c < "$REPO_DIR/backend/public/widget.js")
  [ "$wsize" -lt 61440 ] && p_ok "widget size ${wsize}B < 60KB (fast CDN)" || p_warn "widget ${wsize}B"

  p_head "panels requirements"
  for p in operator admin; do
    h="$REPO_DIR/backend/public/$p/index.html"
    grep -qi "viewport" "$h" && p_ok "$p: mobile viewport" || p_fail "$p: viewport"
    grep -q "socket.io" "$h" && p_ok "$p: socket.io live" || p_fail "$p: socket.io"
  done

  p_head "shell scripts"
  for s in installer/install.sh installer/check.sh; do bash -n "$REPO_DIR/$s" && p_ok "bash -n $s" || p_fail "bash -n $s"; done
  summary; exit $?
fi

# ============================================================
# load config for host modes
# ============================================================
[ -n "$CONFIG_FILE" ] || { echo "--config required for --preflight/--full" >&2; exit 2; }
[ -f "$CONFIG_FILE" ] || { echo "config not found: $CONFIG_FILE" >&2; exit 2; }
# shellcheck disable=SC1090
source "$CONFIG_FILE"
CC_DOMAIN="${CC_DOMAIN:?set CC_DOMAIN in config}"
APP_HOST="${APP_HOST:-127.0.0.1}"
PBX_HOST="${PBX_HOST:-$APP_HOST}"
APP_PORT="${APP_PORT:-3006}"

MY_IPS="$(hostname -I 2>/dev/null || echo "")"
IS_APP=0; IS_PBX=0
echo "$MY_IPS" | grep -qw "${APP_HOST}" && IS_APP=1
echo "$MY_IPS" | grep -qw "${PBX_HOST}" && IS_PBX=1
[ "$WANT_PBX$WANT_APP$WANT_NGINX$WANT_TURN" = "0000" ] && { WANT_PBX=$IS_PBX; WANT_APP=$IS_APP; WANT_NGINX=$IS_APP; WANT_TURN=$IS_APP; }

port_free(){ ! ss -tlnH 2>/dev/null | awk '{print $4}' | grep -Eq "(:${1})$"; }
svc_active(){ systemctl is-active --quiet "$1" 2>/dev/null; }
tcp_open(){ (echo > /dev/tcp/"$1"/"$2") >/dev/null 2>&1; }

# ============================================================
# 2) PREFLIGHT — read-only environment report
# ============================================================
if [ "$MODE" = preflight ]; then
  p_head "os / resources"
  . /etc/os-release 2>/dev/null && p_ok "${PRETTY_NAME:-unknown OS}" || p_warn "unknown OS"
  have systemctl && p_ok "systemd present" || p_fail "systemd missing"
  mem=$(free -m | awk '/^Mem:/{print $2}'); [ "${mem:-0}" -ge 1024 ] && p_ok "RAM ${mem}MB" || p_fail "RAM ${mem}MB < 1GB"
  disk=$(df -m / | awk 'NR==2{print $4}'); [ "${disk:-0}" -ge 5120 ] && p_ok "disk free ${disk}MB" || p_warn "disk free ${disk}MB < 5GB"

  p_head "distro support"
  case "${ID_LIKE:-}${ID:-}" in
    *debian*) p_ok "apt family (recommended: Asterisk + coturn from repo)";;
    *) p_warn "non-apt distro: Asterisk may need manual install (see docs/INSTALL-FA.md)";;
  esac

  p_head "existing software"
  have node && p_ok "node $(node -v)" || p_warn "node missing (installer will add)"
  have asterisk && p_ok "asterisk present" || p_warn "asterisk missing (pbx role will install)"
  have mysql || have mariadb && p_ok "mysql/mariadb present" || p_warn "mysql missing (app role will install)"
  have nginx && p_ok "nginx present" || p_warn "nginx missing (nginx role will install)"
  have turnserver && p_ok "coturn present" || p_warn "coturn missing (turn role will install)"

  p_head "port availability (before install)"
  for pt in 3006 3478 8088 5038; do port_free "$pt" && p_ok "port $pt free" || p_warn "port $pt in use"; done
  port_free 443 && p_ok "port 443 free" || p_warn "port 443 in use (nginx?)"

  p_head "network"
  ipub=$(curl -s --max-time 5 https://api.ipify.org || echo "")
  [ -n "$ipub" ] && p_ok "public egress IP: $ipub (config PUBLIC_IP=${PUBLIC_IP:-?})" || p_warn "cannot detect public IP"
  [ "$ipub" = "${PUBLIC_IP:-x}" ] && p_ok "PUBLIC_IP matches egress" || p_warn "PUBLIC_IP != detected egress (NAT? set external-ip correctly)"
  summary; exit $?
fi

# ============================================================
# 3) FULL — post-install verification
# ============================================================
INST="/opt/callcenter"
if [ "$WANT_PBX" = 1 ]; then
  p_head "pbx: asterisk service"
  svc_active asterisk && p_ok "asterisk active" || p_fail "asterisk not active"
  if have asterisk; then
    asterisk -rx "core show version" >/dev/null 2>&1 && p_ok "asterisk CLI responsive" || p_fail "asterisk CLI"
    asterisk -rx "pjsip show endpoints" 2>/dev/null | grep -q "visitor" && p_ok "pjsip endpoint visitor loaded" || p_fail "pjsip visitor endpoint"
    asterisk -rx "queue show support" 2>/dev/null | grep -q "support" && p_ok "queue support exists" || p_fail "queue support"
    asterisk -rx "module show like chan_sip" 2>/dev/null | grep -q "0 modules loaded" && p_ok "legacy chan_sip disabled" || p_warn "chan_sip may be loaded"
    for s in welcome queue-wait survey-intro survey-thanks; do
      f="/usr/share/asterisk/sounds/fa/custom/${s}.wav"; [ -f "$f" ] || f="/var/lib/asterisk/sounds/fa/custom/${s}.wav"
      [ -f "$f" ] && p_ok "sound $s" || p_fail "sound $s missing"
    done
    grep -q "^\[modules\]" /etc/asterisk/modules.conf && p_ok "modules.conf intact" || p_fail "modules.conf corrupted (missing [modules])"
    tcp_open 127.0.0.1 5038 && p_ok "AMI port 5038 listening" || p_fail "AMI 5038 closed"
  else
    p_fail "asterisk CLI not found"
  fi
fi

if [ "$WANT_APP" = 1 ]; then
  p_head "app: backend service"
  svc_active callcenter-app && p_ok "callcenter-app active" || p_fail "callcenter-app not active"
  tcp_open 127.0.0.1 "$APP_PORT" && p_ok "backend listening :$APP_PORT" || p_fail "backend port closed"
  if have mysql; then
    DB_USER="${DB_USER:-callcenter}"; DB_NAME="${DB_NAME:-callcenter}"; DB_PASS="${DB_PASS:-}"
    mysql -u"$DB_USER" -p"$DB_PASS" -h127.0.0.1 "$DB_NAME" -e "SELECT 1;" >/dev/null 2>&1 && p_ok "mysql auth + db ok" || p_warn "mysql CLI check skipped/failed"
    if mysql -u"$DB_USER" -p"$DB_PASS" -h127.0.0.1 "$DB_NAME" -N -e "SHOW TABLES;" 2>/dev/null | grep -q "^users$"; then
      p_ok "schema tables present"
      mysql -u"$DB_USER" -p"$DB_PASS" -h127.0.0.1 "$DB_NAME" -N -e "SELECT CONCAT('admin user: ',username) FROM users WHERE role='admin' LIMIT 1;" 2>/dev/null | while read -r l; do p_ok "$l"; done
    else p_fail "schema missing (app first boot failed?)"; fi
  fi
  [ -d "$INST/recordings" ] && p_ok "recordings dir exists" || p_fail "recordings dir missing"
  if [ "$IS_PBX" = 1 ]; then
    [ -f "$INST/secrets/cc_rsa" ] && p_ok "SFTP keypair present" || p_warn "SFTP key missing (pbx phase creates it)"
  fi
  if have curl; then
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${APP_PORT}/health" || echo 000)
    [ "$code" = 200 ] && p_ok "GET /health = 200" || p_fail "GET /health = $code"
    code=$(curl -s -o /dev/null -w '%{http_code}' -H "Origin: https://${CC_DOMAIN}" "http://127.0.0.1:${APP_PORT}/api/widget/config" || echo 000)
    [ "$code" = 200 ] && p_ok "GET /api/widget/config = 200" || p_fail "widget config = $code"
    curl -s -H "Origin: https://${CC_DOMAIN}" -D - -o /dev/null "http://127.0.0.1:${APP_PORT}/api/widget/config" 2>/dev/null | grep -qi "access-control-allow-origin" && p_ok "CORS header present" || p_fail "CORS header missing (widget breaks!)"
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${APP_PORT}/operator/" || echo 000)
    [ "$code" = 200 ] && p_ok "operator panel = 200" || p_fail "operator panel = $code"
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${APP_PORT}/admin/" || echo 000)
    [ "$code" = 200 ] && p_ok "admin panel = 200" || p_fail "admin panel = $code"
    code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${APP_PORT}/widget.js" || echo 000)
    [ "$code" = 200 ] && p_ok "widget.js served = 200" || p_fail "widget.js = $code"
  fi
fi

if [ "$WANT_TURN" = 1 ]; then
  p_head "turn: coturn service"
  svc_active coturn && p_ok "coturn active" || { svc_active turnserver && p_ok "turnserver active" || p_fail "coturn not active"; }
  tcp_open 0.0.0.0 3478 && p_ok "TURN :3478 listening" || p_fail "TURN :3478 closed"
fi

if [ "$WANT_NGINX" = 1 ]; then
  p_head "nginx: vhost + WSS"
  svc_active nginx && p_ok "nginx active" || p_fail "nginx not active"
  nginx -t >/dev/null 2>&1 && p_ok "nginx -t OK" || p_fail "nginx -t fails"
  if have curl; then
    code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "${CC_DOMAIN}:443:127.0.0.1" "https://${CC_DOMAIN}/health" || echo 000)
    [ "$code" = 200 ] && p_ok "https /health via vhost = 200" || p_fail "https /health = $code"
    ws=$(curl -sk -o /dev/null -w '%{http_code}' --http1.1 --resolve "${CC_DOMAIN}:443:127.0.0.1" \
         -H "Upgrade: websocket" -H "Connection: Upgrade" -H "Sec-WebSocket-Key: c2VsZW5pdW1jb2xsZWN0aXZl" -H "Sec-WebSocket-Version: 13" \
         "https://${CC_DOMAIN}/ws" || echo 000)
    [ "$ws" = 101 ] && p_ok "WSS handshake /ws = 101" || p_warn "WSS handshake = $ws (behind Cloudflare this test still should pass)"
    code=$(curl -sk -o /dev/null -w '%{http_code}' --resolve "${CC_DOMAIN}:443:127.0.0.1" "https://${CC_DOMAIN}/widget.js" || echo 000)
    [ "$code" = 200 ] && p_ok "https widget.js = 200" || p_fail "https widget.js = $code"
  fi
fi

p_head "remote sanity (from internet path)"
if have curl; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://${CC_DOMAIN}/health" || echo 000)
  [ "$code" = 200 ] && p_ok "public https://${CC_DOMAIN}/health = 200" || p_warn "public URL = $code (DNS/Cloudflare not pointed yet?)"
fi

summary; exit $?
