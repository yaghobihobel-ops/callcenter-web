#!/usr/bin/env bash
# ============================================================
# callcenter-web installer
# Installs: PBX (Asterisk) | TURN (coturn) | APP (backend+panels+widget)
#           NGINX (vhost)  — on this host, in any combination.
# Re-runnable (idempotent); backs up every file it overwrites.
#
# Usage:
#   sudo ./install.sh --config my.conf                     # everything this host needs
#   sudo ./install.sh --config my.conf --only pbx,app
#   sudo ./install.sh --config my.conf --only app --skip-deps
#   sudo ./install.sh --config my.conf --upgrade           # in-place update (keeps .env/DB/creds)
#   sudo ./install.sh --config my.conf --only pbx --asterisk-bundle cc-ast.tar.gz
#
# Component selection:
#   pbx    Asterisk + dialplan + Persian IVR sounds + AMI + SSH key for recordings
#   turn   coturn TURN/STUN relay (needed for restricted networks)
#   app    Node backend + operator/admin panels + widget + MariaDB schema
#   nginx  vhost (panel + SIP-over-WSS proxy)
# "everything" = components inferred from config (APP_HOST/PBX_HOST of this machine).
# ============================================================
set -Eeuo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SELF_DIR")"
CONFIG_FILE=""
ONLY=""
SKIP_DEPS=0
UPGRADE=0
AST_BUNDLE=""
TEST_MODE="${CC_TEST_MODE:-0}"
[ "$TEST_MODE" = 1 ] && SKIP_DEPS=1
RELEASE_VER="$(cat "$REPO_DIR/VERSION" 2>/dev/null || echo unknown)"

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
trap 'die "line $LINENO failed. Fix the issue and re-run (idempotent)."' ERR

usage(){ sed -n '2,20p' "$0"; exit 0; }

# ---------- args ----------
while [ $# -gt 0 ]; do
  case "$1" in
    --config) CONFIG_FILE="$2"; shift 2;;
    --only) ONLY="$2"; shift 2;;
    --skip-deps) SKIP_DEPS=1; shift;;
    --upgrade) UPGRADE=1; shift;;
    --asterisk-bundle) AST_BUNDLE="$2"; shift 2;;
    -h|--help) usage;;
    *) die "unknown argument: $1";;
  esac
done
[ -n "$CONFIG_FILE" ] || die "--config is required (see config.example.conf)"
[ -f "$CONFIG_FILE" ] || die "config file not found: $CONFIG_FILE"
[ "$TEST_MODE" = 1 ] || [ "$(id -u)" = "0" ] || die "run as root (sudo)"

# ---------- config ----------
# shellcheck disable=SC1090
source "$CONFIG_FILE"
CC_DOMAIN="${CC_DOMAIN:?CC_DOMAIN required}"
APP_HOST="${APP_HOST:?APP_HOST required}"
PBX_HOST="${PBX_HOST:?PBX_HOST required}"
PUBLIC_IP="${PUBLIC_IP:?PUBLIC_IP required}"
APP_PORT="${APP_PORT:-3006}"
PBX_WS_PORT="${PBX_WS_PORT:-8088}"
AMI_PORT="${AMI_PORT:-5038}"
INSTALL_DIR="${INSTALL_DIR:-/opt/callcenter}"
TLS_MODE="${TLS_MODE:-selfsigned}"
CERT_FILE="${CERT_FILE:-/etc/nginx/ssl-callcenter/${CC_DOMAIN}.crt}"
KEY_FILE="${KEY_FILE:-/etc/nginx/ssl-callcenter/${CC_DOMAIN}.key}"

MY_IPS="$(hostname -I 2>/dev/null || echo "")"
IS_APP=0; IS_PBX=0
echo "$MY_IPS" | grep -qw "${APP_HOST}" && IS_APP=1
echo "$MY_IPS" | grep -qw "${PBX_HOST}" && IS_PBX=1

# test mode: redirect cert paths into sandbox too
if [ "$TEST_MODE" = 1 ]; then
  CERT_FILE="$INSTALL_DIR/testroot${CERT_FILE}"
  KEY_FILE="$INSTALL_DIR/testroot${KEY_FILE}"
fi

# remember the exact config used, so update.sh can re-install unattended
mkdir -p "$INSTALL_DIR"
cp -a "$CONFIG_FILE" "$INSTALL_DIR/install.conf.tmp" && mv "$INSTALL_DIR/install.conf.tmp" "$INSTALL_DIR/install.conf"
chmod 600 "$INSTALL_DIR/install.conf" 2>/dev/null || true

if [ -n "$ONLY" ]; then
  WANT_PBX=0; WANT_TURN=0; WANT_APP=0; WANT_NGINX=0
  IFS=',' read -ra comps <<< "$ONLY"
  for c in "${comps[@]}"; do
    case "$c" in
      pbx) WANT_PBX=1;; turn) WANT_TURN=1;; app) WANT_APP=1;; nginx) WANT_NGINX=1;;
      *) die "unknown component: $c (pbx|turn|app|nginx)";;
    esac
  done
else
  WANT_PBX=$IS_PBX; WANT_APP=$IS_APP; WANT_NGINX=$IS_APP; WANT_TURN=$IS_APP
  [ "$IS_PBX" = 1 ] || [ "$IS_APP" = 1 ] || die "this host is neither APP_HOST nor PBX_HOST; use --only"
fi

# ---------- helpers ----------
gen_pass(){ head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20; }
backup(){ local f="$1"; if [ -f "$f" ]; then mkdir -p "$(dirname "$f")"; cp -a "$f" "${f}.bak-$(date +%Y%m%d-%H%M%S)"; fi; }
render(){ # render <src.tmpl> <dst> <pairs: __VAR__=value ...>
  local src="$1" dst="$2"; shift 2
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst"
  local kv
  for kv in "$@"; do
    local k="${kv%%=*}" v="${kv#*=}"
    sed -i "s|${k}|${v}|g" "$dst"
  done
}
CREDS_FILE="${INSTALL_DIR}/.generated-creds"
save_cred(){ # save_cred <KEY> <value>
  mkdir -p "$INSTALL_DIR"; touch "$CREDS_FILE"; chmod 600 "$CREDS_FILE"
  grep -q "^$1=" "$CREDS_FILE" 2>/dev/null || echo "$1=$2" >> "$CREDS_FILE"
}
# ETCP <abs-path> — in test mode, redirect all /etc-style writes into the sandbox
if [ "$TEST_MODE" = 1 ]; then
  mkdir -p "$INSTALL_DIR/testroot"
  ETCP(){ echo "$INSTALL_DIR/testroot$1"; }
else
  ETCP(){ echo "$1"; }
fi
require_cred(){ # require_cred <VARNAME> <configvalue>
  local name="$1" val="$2"
  if [ -z "$val" ]; then
    if [ -f "$CREDS_FILE" ] && grep -q "^$name=" "$CREDS_FILE"; then
      val="$(grep "^$name=" "$CREDS_FILE" | head -1 | cut -d= -f2-)"
    else
      val="$(gen_pass)"; save_cred "$name" "$val"
    fi
    eval "$name=\"$val\""
  fi
}

# ---------- package managers ----------
if [ "$TEST_MODE" != 1 ]; then
  PKG=""; if command -v apt-get >/dev/null; then PKG=apt;
  elif command -v dnf >/dev/null; then PKG=dnf;
  elif command -v yum >/dev/null; then PKG=yum; fi
  [ -n "$PKG" ] || die "unsupported distro: need apt-get/dnf/yum"
else
  PKG=none
fi

APT_UPDATED=0
pkg_install(){
  [ "$SKIP_DEPS" = 1 ] && { warn "skip-deps: not installing $*"; return 0; }
  case "$PKG" in
    apt)
      if [ "$APT_UPDATED" = 0 ]; then apt-get update -qq >/dev/null 2>&1 || true; APT_UPDATED=1; fi
      DEBIAN_FRONTEND=noninteractive apt-get install -y "$@" >/dev/null;;
    dnf) dnf install -y "$@" >/dev/null;;
    yum) yum install -y "$@" >/dev/null;;
  esac
}

ensure_node(){
  if command -v node >/dev/null; then ok "node $(node -v)"; return; fi
  [ "$TEST_MODE" = 1 ] && { warn "test mode: node missing — assume runtime provides it"; return; }
  info "installing Node.js 20.x"
  case "$PKG" in
    apt)
      curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
      pkg_install nodejs
      ;;
    *) die "automatic Node.js install supported on apt distros; install Node 18+ manually then re-run with --skip-deps";;
  esac
  command -v node >/dev/null || die "node install failed"
}

# ============================================================
# PBX — Asterisk
# ============================================================
install_pbx(){
  info "[pbx] Asterisk installation"
  if ! command -v asterisk >/dev/null; then
    case "$PKG" in
      apt) pkg_install asterisk asterisk-modules asterisk-config;;
      *) die "Asterisk for $PKG distros: install Asterisk 18+ manually (packages or source), then re-run";;
    esac
  fi
  command -v asterisk >/dev/null || die "asterisk not installed"
  ok "Asterisk $(asterisk -V 2>/dev/null | head -1)"

  local astconf; astconf="$(ETCP /etc/asterisk)"
  mkdir -p "$astconf"
  local soundsdir="/usr/share/asterisk/sounds"
  [ -d "$soundsdir" ] || soundsdir="/var/lib/asterisk/sounds"
  [ "$TEST_MODE" = 1 ] && soundsdir="$INSTALL_DIR/testroot/sounds"

  require_cred VISITOR_SIP_PASS "${VISITOR_SIP_PASS:-}"
  require_cred AMI_PASS "${AMI_PASS:-}"
  AMI_USER="${AMI_USER:-callcenter}"

  # resolve operator pass pattern into per-ext values
  local p1000 p1001 p1002 p1003 p1004 p1005
  for i in 0 1 2 3 4 5; do
    local v="p100$i" pass
    pass="$(eval echo "$OP_SIP_PASS_PATTERN" | sed "s/{ext}/100$i/g")"
    eval "$v=\"$pass\""
  done

  backup "$astconf/pjsip.conf"
  render "$REPO_DIR/asterisk/conf/pjsip.conf.tmpl" "$astconf/pjsip.conf" \
    "__VISITOR_PASS__=$VISITOR_SIP_PASS" \
    "__OP_PASS_1000__=$p1000" "__OP_PASS_1001__=$p1001" "__OP_PASS_1002__=$p1002" \
    "__OP_PASS_1003__=$p1003" "__OP_PASS_1004__=$p1004" "__OP_PASS_1005__=$p1005"

  backup "$astconf/extensions.conf"
  render "$REPO_DIR/asterisk/conf/extensions.conf.tmpl" "$astconf/extensions.conf" \
    "__CCAPI__=http://${APP_HOST}:${APP_PORT}/api/internal"

  backup "$astconf/manager.conf"
  render "$REPO_DIR/asterisk/conf/manager.conf.tmpl" "$astconf/manager.conf" \
    "__AMI_USER__=$AMI_USER" "__AMI_PASS__=$AMI_PASS" "__APP_HOST__=$APP_HOST"

  for f in queues rtp http logger cdr ari modules; do
    backup "$astconf/$f.conf"
    cp "$REPO_DIR/asterisk/conf/$f.conf" "$astconf/$f.conf"
  done

  # Persian IVR sounds
  mkdir -p "$soundsdir/fa/custom"
  cp "$REPO_DIR/asterisk/sounds/fa/custom/"*.wav "$soundsdir/fa/custom/"
  ok "Persian IVR sounds -> $soundsdir/fa/custom/"

  # pre-configured bundle (exact deployed config from a reference PBX)
  if [ -n "$AST_BUNDLE" ]; then
    [ -f "$AST_BUNDLE" ] || die "asterisk bundle not found: $AST_BUNDLE"
    info "[pbx] applying pre-configured bundle: $AST_BUNDLE"
    local bstage="/tmp/cc-ast-bundle.$$"
    mkdir -p "$bstage"
    tar -xzf "$AST_BUNDLE" -C "$bstage"
    [ -f "$bstage/manifest.json" ] || die "bundle missing manifest.json"
    if [ -f "$bstage/install-bundle.sh" ]; then
      bash "$bstage/install-bundle.sh" "$bstage" "$astconf" "$soundsdir"
    else
      local bf
      for bf in "$bstage"/etc-asterisk/*.conf; do
        [ -f "$bf" ] || continue
        backup "$astconf/$(basename "$bf")"
        cp "$bf" "$astconf/"
      done
      [ -d "$bstage/sounds" ] && cp -r "$bstage/sounds/." "$soundsdir/"
    fi
    rm -rf "$bstage"
    ok "bundle applied — reloading"
    asterisk -rx "core reload" >/dev/null 2>&1 || true
  fi

  # recordings SSH key (backend host pulls recordings via SFTP)
  local keydir="${INSTALL_DIR}/secrets"
  mkdir -p "$keydir"
  if [ ! -f "$keydir/cc_rsa" ]; then
    ssh-keygen -t rsa -b 2048 -N "" -f "$keydir/cc_rsa" -C "callcenter-recordings" >/dev/null
    ok "generated SFTP keypair $keydir/cc_rsa"
  fi
  if [ "$TEST_MODE" != 1 ]; then
    local pub
    pub="$(cat "$keydir/cc_rsa.pub")"
    grep -qF "$pub" /root/.ssh/authorized_keys 2>/dev/null || { mkdir -p /root/.ssh; echo "$pub" >> /root/.ssh/authorized_keys; }
  fi

  if [ "$IS_APP" != 1 ]; then
    info "PBX is a separate host: copy $keydir/cc_rsa (private) to APP_HOST:$keydir/"
    info "e.g.:  scp $keydir/cc_rsa* root@${APP_HOST}:$keydir/"
  fi

  if [ "$TEST_MODE" != 1 ]; then
    systemctl enable --now asterisk 2>/dev/null || systemctl restart asterisk
    sleep 2
    asterisk -rx "pjsip show endpoints" >/dev/null 2>&1 && ok "PJSIP endpoints loaded" \
      || warn "asterisk reload needed: asterisk -rx 'core restart now'"
  else
    warn "test mode: skipping asterisk service ops"
  fi
}

# ============================================================
# TURN — coturn
# ============================================================
install_turn(){
  info "[turn] coturn installation"
  pkg_install coturn
  require_cred TURN_PASS "${TURN_PASS:-}"
  TURN_USER="${TURN_USER:-callcenter}"
  local turnconf; turnconf="$(ETCP /etc/turnserver.conf)"
  backup "$turnconf"
  render "$REPO_DIR/nginx/turnserver.conf.tmpl" "$turnconf" \
    "__PUBLIC_IP__=$PUBLIC_IP" "__LAN_IP__=$APP_HOST" \
    "__TURN_USER__=$TURN_USER" "__TURN_PASS__=$TURN_PASS" \
    "__REALM__=${CC_DOMAIN#call.}"
  if [ "$TEST_MODE" != 1 ]; then
    systemctl enable --now coturn 2>/dev/null || systemctl enable --now turnserver
  fi
  ok "coturn active on :3478"
}

# ============================================================
# APP — Node backend + panels + widget + DB
# ============================================================
install_app(){
  info "[app] backend installation"
  ensure_node
  pkg_install curl ca-certificates

  # MariaDB (skip if an external DB is configured)
  if [ "$TEST_MODE" != 1 ]; then
    if ! command -v mysql >/dev/null; then
      case "$PKG" in
        apt) pkg_install mariadb-server mariadb-client; systemctl enable --now mariadb;;
        *) pkg_install mariadb-server mariadb; systemctl enable --now mariadb;;
      esac
    fi
  fi
  require_cred DB_PASS "${DB_PASS:-}"
  DB_NAME="${DB_NAME:-callcenter}"; DB_USER="${DB_USER:-callcenter}"
  if [ "$TEST_MODE" != 1 ] && command -v mysql >/dev/null; then
    mysql -e "CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4;"
    mysql -e "CREATE USER IF NOT EXISTS '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';"
    mysql -e "CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';"
    mysql -e "GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'127.0.0.1';"
    mysql -e "GRANT ALL PRIVILEGES ON \`${DB_NAME}\`.* TO '${DB_USER}'@'localhost';"
    mysql -e "FLUSH PRIVILEGES;"
  elif [ "$TEST_MODE" = 1 ]; then
    warn "test mode: skipping DB provisioning"
  fi
  ok "database ${DB_NAME} ready"

  # app tree
  mkdir -p "$INSTALL_DIR/app" "$INSTALL_DIR/recordings" "$INSTALL_DIR/backups" "$INSTALL_DIR/secrets"
  cp -r "$REPO_DIR/backend/." "$INSTALL_DIR/app/"
  rm -f "$INSTALL_DIR/app/.env.example"

  # secrets: reuse SFTP key generated by pbx phase (same box) — else instruct
  if [ ! -f "$INSTALL_DIR/secrets/cc_rsa" ] && [ "$IS_PBX" = 1 ]; then
    info "[app] SFTP key will be created by the pbx phase"
  fi

  # .env — MERGE semantics: never clobber an existing .env (update safety).
  # Existing keys keep their values; only brand-new keys get appended.
  require_cred JWT_SECRET "${JWT_SECRET:-}"
  require_cred AMI_PASS "${AMI_PASS:-}"
  require_cred TURN_PASS "${TURN_PASS:-}"
  require_cred VISITOR_SIP_PASS "${VISITOR_SIP_PASS:-}"
  OP_SIP_PASS_PATTERN="${OP_SIP_PASS_PATTERN:-Op{ext}!Call2026}"
  local envnew="$INSTALL_DIR/app/.env.new"
  cat > "$envnew" <<EOF
CC_PORT=${APP_PORT}
CC_PUBLIC_ORIGIN=https://${CC_DOMAIN}
CC_JWT=${JWT_SECRET}
CC_DB_HOST=127.0.0.1
CC_DB_PORT=3306
CC_DB_USER=${DB_USER}
CC_DB_PASS=${DB_PASS}
CC_DB_NAME=${DB_NAME}
CC_PBX_HOST=${PBX_HOST}
CC_AMI_HOST=${PBX_HOST}
CC_AMI_PORT=${AMI_PORT}
CC_AMI_USER=${AMI_USER:-callcenter}
CC_AMI_PASS=${AMI_PASS}
CC_APP_LAN_IP=${APP_HOST}
CC_DIAL_EXT=200
CC_VISITOR_SIP_PASS=${VISITOR_SIP_PASS}
CC_OP_SIP_PASS=${OP_SIP_PASS_PATTERN}
CC_TURN_PUBLIC_IP=${PUBLIC_IP}
CC_TURN_LAN_IP=${APP_HOST}
CC_TURN_USER=${TURN_USER:-callcenter}
CC_TURN_PASS=${TURN_PASS}
CC_REC_SPOOL=/var/spool/asterisk/monitor
CC_REC_LOCAL=${INSTALL_DIR}/recordings
CC_SFTP_KEY=${INSTALL_DIR}/secrets/cc_rsa
CC_SUPPORT_PHONE=${SUPPORT_PHONE:-+982191000000}
CC_SUPPORT_PHONE_DISPLAY=${SUPPORT_PHONE_DISPLAY:-}
CC_BRAND_NAME=${BRAND_NAME:-CallCenter}
CC_BRAND_COLOR=#0ea5e9
EOF
  if [ -f "$INSTALL_DIR/app/.env" ]; then
    backup "$INSTALL_DIR/app/.env"
    local envold="$INSTALL_DIR/app/.env"
    { grep -vE '^\s*#' "$envold" | grep -E '^[A-Za-z_]+=' | cut -d= -f1 | sort -u > /tmp/cc-env-keys.$$ || true
      grep -vE '^\s*#' "$envnew" | grep -E '^[A-Za-z_]+=' | while IFS= read -r line; do
        k="${line%%=*}"
        grep -qxF "$k" /tmp/cc-env-keys.$$ || echo "$line"
      done >> "$envold"
      rm -f /tmp/cc-env-keys.$$ "$envnew"; }
    ok ".env preserved (existing values kept, new keys merged)"
  else
    mv "$envnew" "$INSTALL_DIR/app/.env"
  fi
  chmod 600 "$INSTALL_DIR/app/.env"

  # brand the widget (patch API origin inside widget.js)
  sed -i "s|https://call.firuzo.online|https://${CC_DOMAIN}|g" "$INSTALL_DIR/app/public/widget.js"

  # node_modules — reinstall when package.json changed (update support)
  local need_npm=0
  if [ ! -d "$INSTALL_DIR/app/node_modules" ]; then
    need_npm=1
  else
    local new_hash old_hash
    new_hash="$(sha256sum "$INSTALL_DIR/app/package.json" | cut -d' ' -f1)"
    old_hash="$(cat "$INSTALL_DIR/app/.package.sha256" 2>/dev/null || echo "")"
    [ "$new_hash" != "$old_hash" ] && need_npm=1
  fi
  sha256sum "$INSTALL_DIR/app/package.json" | cut -d' ' -f1 > "$INSTALL_DIR/app/.package.sha256"
  if [ "$need_npm" = 1 ]; then
    info "[app] npm install (deps changed or first run)"
    (cd "$INSTALL_DIR/app" && npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1) \
      || die "npm install failed (check node version >= 18)"
  fi
  ok "node_modules present"

  # systemd unit
  backup "$(ETCP /etc/systemd/system/callcenter-app.service)"
  local unit; unit="$(ETCP /etc/systemd/system/callcenter-app.service)"
  mkdir -p "$(dirname "$unit")"
  cat > "$unit" <<EOF
[Unit]
Description=Call Center app (API + panel + AMI)
After=network.target mariadb.service

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}/app
ExecStart=/usr/bin/node runtime.js
Restart=always
RestartSec=3
Environment=NODE_ENV=production
StandardOutput=append:${INSTALL_DIR}/app.log
StandardError=append:${INSTALL_DIR}/app.err.log
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload 2>/dev/null || true
  if [ "$TEST_MODE" != 1 ]; then
    systemctl enable --now callcenter-app
    sleep 2
    systemctl is-active --quiet callcenter-app && ok "callcenter-app active" || die "callcenter-app failed — see ${INSTALL_DIR}/app.err.log"
  else
    warn "test mode: skipping service start"
  fi

  # default users are seeded by the app itself on first boot
  ok "panel users: admin / operator (bootstrap passwords from config)"
}

# ============================================================
# NGINX — vhost
# ============================================================
install_nginx(){
  info "[nginx] vhost installation"
  if ! command -v nginx >/dev/null; then pkg_install nginx; fi
  local cdir; cdir="$(ETCP /etc/nginx/ssl-callcenter)"
  if [ "$TLS_MODE" = "selfsigned" ]; then
    mkdir -p "$cdir"
    if [ ! -f "$CERT_FILE" ]; then
      openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
        -keyout "$KEY_FILE" -out "$CERT_FILE" -subj "/CN=${CC_DOMAIN}" >/dev/null 2>&1
      ok "self-signed certificate generated (put the host behind Cloudflare or install a real cert)"
    fi
  fi
  [ -f "$CERT_FILE" ] || die "cert missing: $CERT_FILE (TLS_MODE=existing but file absent)"

  local vhost; vhost="$(ETCP /etc/nginx/conf.d)/${CC_DOMAIN}.conf"
  mkdir -p "$(dirname "$vhost")"
  backup "$vhost"
  render "$REPO_DIR/nginx/call-firuzo.conf.tmpl" "$vhost" \
    "__CC_DOMAIN__=$CC_DOMAIN" "__APP_HOST__=127.0.0.1" "__APP_PORT__=$APP_PORT" \
    "__PBX_HOST__=$PBX_HOST" "__CERT__=$CERT_FILE" "__KEY__=$KEY_FILE"
  if [ "$TEST_MODE" != 1 ]; then
    nginx -t || die "nginx config test failed"
    systemctl reload nginx 2>/dev/null || systemctl restart nginx
  else
    warn "test mode: skipping nginx reload"
  fi
  ok "vhost active: https://${CC_DOMAIN}"
}

# ---------- run ----------
echo "============================================================"
echo " callcenter-web installer"
echo "  host roles: app=$IS_APP pbx=$IS_PBX"
echo "  components: pbx=$WANT_PBX turn=$WANT_TURN app=$WANT_APP nginx=$WANT_NGINX"
echo "  domain    : https://${CC_DOMAIN}"
echo "============================================================"

[ "$WANT_PBX"   = 1 ] && install_pbx
[ "$WANT_TURN"  = 1 ] && install_turn
[ "$WANT_APP"   = 1 ] && install_app
[ "$WANT_NGINX" = 1 ] && install_nginx

echo ""
echo "$RELEASE_VER" > "$INSTALL_DIR/VERSION"
ok "install/update complete — version $RELEASE_VER stamped at $INSTALL_DIR/VERSION"
ok "Now verify:  sudo $SELF_DIR/check.sh --config $CONFIG_FILE --full --pbx --app --nginx --turn"
ok "If creds were generated, view them at: $CREDS_FILE"
