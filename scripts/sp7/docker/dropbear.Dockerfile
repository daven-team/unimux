# SP7: Dropbear. BASE=debian:trixie-slim (Dropbear 2025.x) or the archived debian:stretch-slim (Dropbear 2016.74, the
# kind of build old routers and NAS boxes still run). Users sp7 / sp7-pw and kbd / kbd-pw; authorized_keys mounted at
# /sp7/authorized_keys. Host keys of every type the build knows (stretch: no ed25519).
ARG BASE=debian:trixie-slim
FROM ${BASE}
ARG ARCHIVE=0
RUN if [ "$ARCHIVE" = 1 ]; then \
      printf 'deb http://archive.debian.org/debian stretch main\n' > /etc/apt/sources.list; \
      printf 'Acquire::Check-Valid-Until "false";\n' > /etc/apt/apt.conf.d/99archive; fi \
 && apt-get update && (apt-get install -y --no-install-recommends dropbear-bin || apt-get install -y --no-install-recommends dropbear) \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -m -s /bin/sh sp7 && echo 'sp7:sp7-pw' | chpasswd \
 && useradd -m -s /bin/sh kbd && echo 'kbd:kbd-pw' | chpasswd \
 && mkdir -p /etc/dropbear-sp7 \
 && (dropbearkey -t ed25519 -f /etc/dropbear-sp7/ed25519 || true) \
 && dropbearkey -t ecdsa -s 256 -f /etc/dropbear-sp7/ecdsa256 \
 && dropbearkey -t ecdsa -s 384 -f /etc/dropbear-sp7/ecdsa384 \
 && dropbearkey -t ecdsa -s 521 -f /etc/dropbear-sp7/ecdsa521 \
 && dropbearkey -t rsa -s 3072 -f /etc/dropbear-sp7/rsa
COPY dropbear-start.sh /start.sh
ENTRYPOINT ["/bin/sh", "/start.sh"]
