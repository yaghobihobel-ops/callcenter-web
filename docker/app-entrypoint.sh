#!/bin/sh
set -eu

: "${CC_PUBLIC_ORIGIN:?CC_PUBLIC_ORIGIN is required}"
node - <<'NODE'
const fs = require('fs');
const origin = process.env.CC_PUBLIC_ORIGIN;
const url = new URL(origin);
if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password) {
  throw new Error('CC_PUBLIC_ORIGIN must be an HTTPS origin without a path or trailing slash');
}
// Equivalent to the existing installer's branding step, but performed on the
// container copy. The checked-in widget and its fallback API origin stay intact.
const template = fs.readFileSync('/opt/widget.js.template', 'utf8');
fs.writeFileSync('/app/public/widget.js', template.replaceAll('https://call.firuzo.online', origin));
NODE

exec "$@"
