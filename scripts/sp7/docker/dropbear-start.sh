#!/bin/sh
# SP7 Dropbear container start: authorized_keys from the mount, then dropbear in the foreground with every host key.
set -eu
for u in sp7 kbd; do
  mkdir -p /home/$u/.ssh
  if [ -f /sp7/authorized_keys ]; then cp /sp7/authorized_keys /home/$u/.ssh/authorized_keys; fi
  chown -R $u:$u /home/$u/.ssh
  chmod 700 /home/$u/.ssh
  chmod 600 /home/$u/.ssh/authorized_keys 2>/dev/null || true
done
# Dropbear refuses more than a few -r keys ("Too many hostkeys"): one per type, the ECDSA curve chosen by $1 (default 256).
keys=''
for k in ed25519 "ecdsa${1:-256}" rsa; do
  if [ -f "/etc/dropbear-sp7/$k" ]; then keys="$keys -r /etc/dropbear-sp7/$k"; fi
done
# shellcheck disable=SC2086
exec dropbear -F -E -p 22 $keys
