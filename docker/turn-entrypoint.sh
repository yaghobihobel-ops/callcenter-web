#!/bin/sh
set -eu
render-config.py turn
# coturn reads the secret-bearing config as root, then drops to its own user.
exec "$@"
