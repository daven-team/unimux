# SP7: the key tools that write the fixture corpus (OpenSSH ssh-keygen, OpenSSL, PuTTYgen).
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssh-client openssl putty-tools ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /out
