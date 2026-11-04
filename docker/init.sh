#!/bin/sh
# Prepare local configuration only. Does not install Docker, open ports or start services.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"
umask 077
if [ -e .env ]; then
  echo '.env already exists; leaving it unchanged.'
else
  command -v python3 >/dev/null 2>&1 || { echo 'python3 is required to generate secrets.' >&2; exit 1; }
  python3 - <<'PY'
from pathlib import Path
import secrets
text = Path('.env.docker.example').read_text(encoding='utf-8')
markers = {
    '__GENERATE_DB_ROOT__': secrets.token_hex(24),
    '__GENERATE_DB__': secrets.token_hex(24),
    '__GENERATE_JWT__': secrets.token_hex(32),
    '__GENERATE_VISITOR__': secrets.token_hex(24),
    '__GENERATE_AMI__': secrets.token_hex(24),
    '__GENERATE_TURN__': secrets.token_hex(24),
    '__GENERATE_OPERATORS__': secrets.token_hex(24),
}
for marker, value in markers.items():
    text = text.replace(marker, value)
path = Path('.env')
with path.open('x', encoding='utf-8') as output:
    output.write(text)
path.chmod(0o600)
print('Created .env with random secrets (mode 0600).')
PY
fi
cat <<'EOF'
Next steps (nothing has been deployed):
  1. Edit CC_DOMAIN, PUBLIC_IP and CC_HOST_IP in .env.
     CC_HOST_IP is the VM interface address; PUBLIC_IP is the address clients reach.
  2. Supply a trusted TLS full chain and private key at TLS_CERT_FILE/TLS_KEY_FILE.
  3. Review docker/README-FA.md, then run: docker compose config --quiet
  4. Only when ready: docker compose up -d --build
Keep .env and the certificate private key private.
EOF
