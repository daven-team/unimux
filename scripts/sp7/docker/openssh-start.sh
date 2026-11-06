#!/bin/sh
# SP7 OpenSSH container start: authorized_keys from the mount, then sshd in the foreground with the chosen config.
set -eu
for u in sp7 kbd; do
  mkdir -p /home/$u/.ssh
  if [ -f /sp7/authorized_keys ]; then cp /sp7/authorized_keys /home/$u/.ssh/authorized_keys; fi
  chown -R $u:$u /home/$u/.ssh
  chmod 700 /home/$u/.ssh
  chmod 600 /home/$u/.ssh/authorized_keys 2>/dev/null || true
done
exec /usr/sbin/sshd -D -e -f "/etc/ssh/sshd-$1.conf"
