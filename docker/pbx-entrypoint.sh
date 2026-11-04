#!/bin/sh
set -eu

mkdir -p /run/asterisk /run/sshd /run/callcenter-keys /run/callcenter-ssh \
         /var/spool/asterisk/monitor /var/lib/asterisk /var/log/asterisk /srv/sftp/monitor
CC_ASTERISK_GID="$(id -g asterisk)"
export CC_ASTERISK_GID
render-config.py pbx

# Keep the existing SFTP recording retrieval flow. This SSH daemon is distinct
# from the VM's SSH daemon, listens only on loopback:2222, and permits only
# key-authenticated, read-only SFTP for the dedicated ccrec account.
if [ ! -s /run/callcenter-keys/cc_ed25519 ]; then
  ssh-keygen -q -t ed25519 -N '' -C callcenter-recordings \
    -f /run/callcenter-keys/cc_ed25519.tmp
  mv /run/callcenter-keys/cc_ed25519.tmp /run/callcenter-keys/cc_ed25519
  mv /run/callcenter-keys/cc_ed25519.tmp.pub /run/callcenter-keys/cc_ed25519.pub
fi
# The app image uses the standard node user's GID 1000. Only the group may read
# the private key; it is never written to the image or the host's SSH directory.
chown root:1000 /run/callcenter-keys/cc_ed25519
chmod 640 /run/callcenter-keys/cc_ed25519
chmod 644 /run/callcenter-keys/cc_ed25519.pub
install -d -o root -g root -m 755 /etc/ccrec-ssh
install -o root -g root -m 644 /run/callcenter-keys/cc_ed25519.pub /etc/ccrec-ssh/authorized_keys
if [ ! -s /run/callcenter-ssh/ssh_host_ed25519_key ]; then
  ssh-keygen -q -t ed25519 -N '' -f /run/callcenter-ssh/ssh_host_ed25519_key
fi
chown root:root /run/callcenter-ssh/ssh_host_ed25519_key
chmod 600 /run/callcenter-ssh/ssh_host_ed25519_key
# A system account starts with a locked password shadow. '*' disables password
# login without marking the account expired for public-key-only SSH.
usermod -p '*' ccrec
/usr/sbin/sshd -t -f /opt/callcenter-templates/cc_sshd_config

chown -R asterisk:asterisk /run/asterisk /var/spool/asterisk/monitor \
          /var/lib/asterisk /var/log/asterisk
# The chroot root must remain root-owned and not writable by the SFTP user.
chown root:root /srv/sftp
chmod 755 /srv/sftp
chown asterisk:asterisk /srv/sftp/monitor
chmod 750 /srv/sftp/monitor
# Allow the read-only recording account to traverse the shared spool mount.
usermod -aG asterisk ccrec
exec "$@"
