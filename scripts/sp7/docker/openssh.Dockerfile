# SP7: OpenSSH 10 (Debian trixie) with PAM (keyboard-interactive), every host key type and four sshd configs:
#   current  defaults of OpenSSH 10 (+ a banner), keyboard-interactive only for user kbd
#   old      what OpenSSH 5.x/6.x offered (CentOS 6 era): gex-sha256 + SHA-1 kex, ssh-rsa host key, hmac-sha1/md5, aes-ctr/cbc
#   sha1     SHA-1 only: SHA-1 kex, ssh-rsa host key and user keys, hmac-sha1, aes-ctr
#   cbc      modern kex and MACs but only CBC ciphers
# Users: sp7 / sp7-pw (password, publickey, keyboard-interactive), kbd / kbd-pw (keyboard-interactive only).
# authorized_keys is mounted at /sp7/authorized_keys and copied at start (bind mounts from Windows have mode 0777).
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /run/sshd \
 && useradd -m -s /bin/sh sp7 && echo 'sp7:sp7-pw' | chpasswd \
 && useradd -m -s /bin/sh kbd && echo 'kbd:kbd-pw' | chpasswd \
 && rm -f /etc/ssh/ssh_host_* \
 && ssh-keygen -q -t ed25519 -N '' -f /etc/ssh/ssh_host_ed25519_key \
 && ssh-keygen -q -t ecdsa -b 256 -N '' -f /etc/ssh/ssh_host_ecdsa_key \
 && ssh-keygen -q -t ecdsa -b 384 -N '' -f /etc/ssh/ssh_host_ecdsa384_key \
 && ssh-keygen -q -t ecdsa -b 521 -N '' -f /etc/ssh/ssh_host_ecdsa521_key \
 && ssh-keygen -q -t rsa -b 3072 -N '' -f /etc/ssh/ssh_host_rsa_key \
 && printf 'SP7 banner: authorized use only\n' > /etc/ssh/banner
COPY sshd-current.conf sshd-old.conf sshd-sha1.conf sshd-cbc.conf /etc/ssh/
COPY openssh-start.sh /start.sh
ENTRYPOINT ["/bin/sh", "/start.sh"]
CMD ["current"]
