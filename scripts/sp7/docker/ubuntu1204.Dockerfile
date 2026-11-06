# SP7: a real old OpenSSH build, Ubuntu 12.04 (OpenSSH 5.9p1, OpenSSL 1.0.1, EOL 2017) from old-releases.ubuntu.com.
# No curve25519 and no ed25519; ecdh-sha2-nistp*, gex-sha256 and the SHA-1 kex; host keys ecdsa-sha2-nistp256, ssh-rsa and
# ssh-dss (all signed with SHA-1 for RSA). CentOS 6 (OpenSSH 5.3) was tried first: its glibc 2.12 segfaults (exit 139) on the
# WSL2 kernel (no vsyscall emulation). Users sp7 / sp7-pw and kbd / kbd-pw.
FROM ubuntu:12.04
RUN sed -i -e 's|http://archive.ubuntu.com|http://old-releases.ubuntu.com|g' -e 's|http://security.ubuntu.com|http://old-releases.ubuntu.com|g' /etc/apt/sources.list \
 && apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends openssh-server && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /var/run/sshd \
 && useradd -m -s /bin/sh sp7 && echo 'sp7:sp7-pw' | chpasswd \
 && useradd -m -s /bin/sh kbd && echo 'kbd:kbd-pw' | chpasswd \
 && rm -f /etc/ssh/ssh_host_* \
 && ssh-keygen -q -t rsa -b 2048 -N '' -f /etc/ssh/ssh_host_rsa_key \
 && ssh-keygen -q -t ecdsa -b 256 -N '' -f /etc/ssh/ssh_host_ecdsa_key \
 && ssh-keygen -q -t dsa -N '' -f /etc/ssh/ssh_host_dsa_key \
 && printf 'Port 22\nProtocol 2\nHostKey /etc/ssh/ssh_host_rsa_key\nHostKey /etc/ssh/ssh_host_ecdsa_key\nHostKey /etc/ssh/ssh_host_dsa_key\nUsePAM yes\nChallengeResponseAuthentication yes\nPasswordAuthentication yes\nPubkeyAuthentication yes\nPermitRootLogin no\nUsePrivilegeSeparation yes\nLogLevel VERBOSE\nSubsystem sftp internal-sftp\nMatch User kbd\n  PasswordAuthentication no\n  PubkeyAuthentication no\n' > /etc/ssh/sshd_config-sp7
COPY openssh-start-old.sh /start.sh
ENTRYPOINT ["/bin/sh", "/start.sh"]
