#!/bin/sh
set -eu
render-config.py nginx
nginx -t
exec "$@"
