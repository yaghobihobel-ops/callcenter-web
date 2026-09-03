#!/usr/bin/env bash
# Deploys this pre-configured Asterisk bundle onto a target PBX.
# Usage: bash install-bundle.sh <bundle-dir> <asterisk-conf-dir> <sounds-dir>
set -Eeuo pipefail
B="${1:?bundle dir}"; AC="${2:?asterisk conf dir}"; SD="${3:?sounds dir}"
ts="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$AC" "$SD/fa/custom"
for f in "$B"/etc-asterisk/*.conf; do
  [ -f "$f" ] || continue
  [ -f "$AC/$(basename "$f")" ] && cp -a "$AC/$(basename "$f")" "$AC/$(basename "$f").pre-bundle-$ts"
  cp "$f" "$AC/"
done
cp -r "$B/sounds/." "$SD/"
echo "[bundle] deployed $(ls "$B"/etc-asterisk/*.conf | wc -l) configs + $(ls "$B"/sounds/fa/custom/ | wc -l) sounds"
echo "[bundle] previous configs kept as *.pre-bundle-$ts"
