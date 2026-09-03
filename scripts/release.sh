#!/usr/bin/env bash
# ============================================================
# release.sh — build a versioned, updatable install package
#
#   bash scripts/release.sh                     # -> dist/callcenter-web-<ver>.tar.gz + .sha256
#   bash scripts/release.sh --upload <TOKEN>    # + create GitHub Release with assets
#   bash scripts/release.sh --upload <TOKEN> v3.0.0
#
# The tarball is exactly what update.sh --from-file / --from-github consumes.
# It excludes .git, node_modules, dist, local secrets.
# ============================================================
set -euo pipefail
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SELF_DIR")"
cd "$REPO_DIR"

VER="$(cat VERSION | tr -d '[:space:]')"
OUT="$REPO_DIR/dist"
NAME="callcenter-web-${VER}"
mkdir -p "$OUT"

# version sanity: VERSION == backend/package.json version
PKG_VER="$(python3 -c "import json;print(json.load(open('backend/package.json'))['version'])" 2>/dev/null || echo "?")"
if [ "$PKG_VER" != "$VER" ]; then
  echo "[FAIL] VERSION ($VER) != backend/package.json version ($PKG_VER) — align first" >&2
  exit 1
fi

echo "[INFO] building $NAME.tar.gz"
tar -czf "$OUT/$NAME.tar.gz" \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='dist' \
  --exclude='*.log' \
  --exclude='.env' \
  --transform "s,^\.,$NAME," \
  .
(cd "$OUT" && sha256sum "$NAME.tar.gz" > "$NAME.tar.gz.sha256")
echo "[ OK ] $OUT/$NAME.tar.gz ($(du -h "$OUT/$NAME.tar.gz" | cut -f1))"
echo "[ OK ] $OUT/$NAME.tar.gz.sha256"

# self-test the staged tarball: VERSION + installer + check.sh present
STAGE="$(mktemp -d)"
tar -xzf "$OUT/$NAME.tar.gz" -C "$STAGE"
[ -f "$STAGE/$NAME/VERSION" ] || { echo "[FAIL] tarball missing VERSION" >&2; exit 1; }
[ -f "$STAGE/$NAME/installer/install.sh" ] || { echo "[FAIL] tarball missing installer" >&2; exit 1; }
[ -f "$STAGE/$NAME/installer/update.sh" ] || { echo "[FAIL] tarball missing updater" >&2; exit 1; }
rm -rf "$STAGE"
echo "[ OK ] tarball structure verified"

# ---------- optional GitHub release ----------
if [ "${1:-}" = "--upload" ]; then
  TOKEN="${2:?usage: release.sh --upload <TOKEN> [tag]}"
  TAG="${3:-v$VER}"
  REPO_SLUG="${GITHUB_REPO:-yaghobihobel-ops/callcenter-web}"
  API="https://api.github.com/repos/$REPO_SLUG/releases"

  # build release notes from CHANGELOG section of this version
  NOTES="$(awk -v ver="## [$VER]" 'index($0,ver){flag=1;next} /^## \[/{if(flag)exit} flag' CHANGELOG.md)"
  [ -n "$NOTES" ] || NOTES="Release $TAG — see CHANGELOG.md"

  if curl -fsS -X POST -H "Authorization: token $TOKEN" -H "Accept: application/vnd.github+json" \
      "$API" -d "$(python3 -c "
import json,sys
print(json.dumps({
 'tag_name':'$TAG','target_commitish':'main',
 'name':'$TAG',
 'body':'''$NOTES'''.replace('\"','\\\\\"'),
 'draft':False,'prerelease':False}))" 2>/dev/null)" > /tmp/rel.json 2>/dev/null; then
    REL_ID="$(python3 -c "import json;print(json.load(open('/tmp/rel.json'))['id'])")"
    echo "[ OK ] release $TAG created (id $REL_ID)"
  else
    # release already exists? find it
    curl -fsS -H "Authorization: token $TOKEN" "$API/tags/$TAG" > /tmp/rel.json 2>/dev/null \
      || { echo "[FAIL] cannot create nor find release $TAG" >&2; cat /tmp/rel.json; exit 1; }
    REL_ID="$(python3 -c "import json;print(json.load(open('/tmp/rel.json'))['id'])")"
    echo "[INFO] release $TAG already exists (id $REL_ID)"
  fi

  # delete same-named assets first (idempotent re-upload)
  for an in "$NAME.tar.gz" "$NAME.tar.gz.sha256"; do
    AID="$(curl -fsS -H "Authorization: token $TOKEN" "$API/tags/$TAG" 2>/dev/null | python3 -c "
import json,sys
rel=json.load(sys.stdin)
for a in rel.get('assets',[]):
    if a['name']=='$an': print(a['id']); break" 2>/dev/null || true)"
    [ -n "$AID" ] && curl -fsS -X DELETE -H "Authorization: token $TOKEN" "$API/assets/$AID" >/dev/null 2>&1 && echo "[INFO] replaced existing asset $an"
  done

  for f in "$OUT/$NAME.tar.gz" "$OUT/$NAME.tar.gz.sha256"; do
    echo "[INFO] uploading $(basename "$f")"
    curl -fsS -X POST \
      -H "Authorization: token $TOKEN" \
      -H "Content-Type: application/gzip" \
      --data-binary @"$f" \
      "https://uploads.github.com/repos/$REPO_SLUG/releases/$REL_ID/assets?name=$(basename "$f")" \
      > /tmp/up.json 2>/dev/null \
      && echo "[ OK ] uploaded" || { echo "[FAIL] upload $(basename "$f")" >&2; cat /tmp/up.json; exit 1; }
  done
  echo "[ OK ] release live: https://github.com/$REPO_SLUG/releases/tag/$TAG"
fi
