#!/bin/sh
set -eu
asterisk -rx 'core show version' >/dev/null
supervisorctl -c /etc/supervisor/conf.d/callcenter.conf status asterisk | grep -q RUNNING
supervisorctl -c /etc/supervisor/conf.d/callcenter.conf status recordings-sftp | grep -q RUNNING
