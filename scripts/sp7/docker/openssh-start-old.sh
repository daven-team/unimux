#!/bin/sh
# SP7 Ubuntu 12.04 container start (OpenSSH 5.9 has no AuthenticationMethods; kbd is limited with a Match block instead).
set -eu
for u in sp7 kbd; do
  mkdir -p /home/$u/.ssh
  if [ -f /sp7/authorized_keys ]; then cp /sp7/authorized_keys /home/$u/.ssh/authorized_keys; fi
  chown -R $u:$u /home/$u/.ssh
  chmod 700 /home/$u/.ssh
  chmod 600 /home/$u/.ssh/authorized_keys 2>/dev/null || true
done
exec /usr/sbin/sshd -D -e -f /etc/ssh/sshd_config-sp7
