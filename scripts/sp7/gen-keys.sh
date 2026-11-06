#!/bin/sh
# SP7 fixture corpus: private keys in every format a user may paste into unimux. Runs inside the keytools image
# (scripts/sp7/docker/keytools.Dockerfile) with the output directory mounted at /out. The passphrase is always "sp7-pass".
# Throwaway test keys only; they never protect anything.
set -eu
P=sp7-pass
cd /out

# Added after the SP7 review: the other DEK-Info ciphers 1.1.4 decrypts (AES-CTR, Blowfish-CBC), ciphers it refuses, and
# malformed DEK-Info IVs (ssh2 reads the IV with Buffer.from(hex), which stops at the first non-hex pair). Needs the base
# files pem-rsa2048.key, pem-ec256.key and pem-rsa2048-aes128.key. `sh /gen-keys.sh --review-additions` writes only these.
review_additions() {
  for c in aes-128-ctr aes-192-ctr aes-256-ctr bf-cbc aes-256-cfb aes-128-ofb des-cbc des-ede-cbc; do
    openssl rsa -traditional -in pem-rsa2048.key -$c -provider legacy -provider default -passout pass:$P -out pem-rsa2048-$c.key 2>/dev/null
  done
  for c in aes-128-ctr aes-256-ctr bf-cbc; do
    openssl ec -in pem-ec256.key -$c -provider legacy -provider default -passout pass:$P -out pem-ec256-$c.key 2>/dev/null
  done
  iv=$(sed -n 's/^DEK-Info: AES-128-CBC,//p' pem-rsa2048-aes128.key)
  dek() { sed "s/^DEK-Info: .*/DEK-Info: $1/" pem-rsa2048-aes128.key > "pem-rsa2048-aes128-$2.key"; }
  dek "AES-128-CBC,0é$(echo "$iv" | cut -c3-)" iv-nonascii
  dek "AES-128-CBC,$(echo "$iv" | cut -c1-16)" iv-short
  dek "AES-128-CBC,g$(echo "$iv" | cut -c2-)" iv-badhex
  dek "AES-128-CBC,${iv}zz" iv-trailing-junk
  dek "AES-128-CBC,${iv}0" iv-odd-length
  dek "AES-128-CBC" no-iv
  dek "aes-128-cbc,$(echo "$iv" | tr 'A-F' 'a-f')" lowercase
}
if [ "${1:-}" = --review-additions ]; then
  review_additions
  ls | wc -l
  exit 0
fi

rm -f ./*.key ./*.ppk
{ ssh -V 2>&1; openssl version; puttygen --version | head -1; } > tools.txt

# OpenSSH format (openssh-key-v1), ssh-keygen defaults (aes256-ctr, bcrypt 16 rounds when encrypted).
ssh-keygen -q -t ed25519 -N '' -C 'sp7 ed25519' -f openssh-ed25519.key
ssh-keygen -q -t ed25519 -N "$P" -C 'sp7 ed25519 enc' -f openssh-ed25519-enc.key
for b in 256 384 521; do
  ssh-keygen -q -t ecdsa -b $b -N '' -C "sp7 ecdsa$b" -f openssh-ecdsa$b.key
  ssh-keygen -q -t ecdsa -b $b -N "$P" -C "sp7 ecdsa$b enc" -f openssh-ecdsa$b-enc.key
done
for b in 2048 3072 4096; do
  ssh-keygen -q -t rsa -b $b -N '' -C "sp7 rsa$b" -f openssh-rsa$b.key
done
ssh-keygen -q -t rsa -b 3072 -N "$P" -C 'sp7 rsa3072 enc' -f openssh-rsa3072-enc.key
# Other OpenSSH key ciphers (ssh-keygen -Z).
for c in aes128-ctr aes192-ctr aes128-cbc aes192-cbc aes256-cbc 3des-cbc aes128-gcm@openssh.com aes256-gcm@openssh.com chacha20-poly1305@openssh.com; do
  n=$(echo "$c" | sed 's/@openssh.com//')
  ssh-keygen -q -t ed25519 -N "$P" -Z "$c" -C "sp7 ed25519 $n" -f "openssh-ed25519-enc-$n.key"
done
ssh-keygen -q -t rsa -b 2048 -N "$P" -Z aes256-gcm@openssh.com -C 'sp7 rsa2048 aes256-gcm' -f openssh-rsa2048-enc-aes256-gcm.key
ssh-keygen -q -t ed25519 -N "$P" -a 64 -C 'sp7 ed25519 rounds64' -f openssh-ed25519-enc-rounds64.key

# PEM PKCS#1 (BEGIN RSA PRIVATE KEY) and SEC1 (BEGIN EC PRIVATE KEY), ssh-keygen -m PEM (AES-128-CBC when encrypted).
ssh-keygen -q -t rsa -b 2048 -m PEM -N '' -C '' -f pem-rsa2048-sshkeygen.key
ssh-keygen -q -t rsa -b 2048 -m PEM -N "$P" -C '' -f pem-rsa2048-sshkeygen-enc.key
for b in 256 384 521; do
  ssh-keygen -q -t ecdsa -b $b -m PEM -N '' -C '' -f pem-ec$b-sshkeygen.key
  ssh-keygen -q -t ecdsa -b $b -m PEM -N "$P" -C '' -f pem-ec$b-sshkeygen-enc.key
done
# OpenSSL traditional PEM with the common ciphers.
openssl genrsa -traditional -out pem-rsa2048.key 2048 2>/dev/null
for c in aes128 aes192 aes256 des3 camellia256; do
  openssl rsa -traditional -in pem-rsa2048.key -$c -passout pass:$P -out pem-rsa2048-$c.key 2>/dev/null
done
openssl genrsa -traditional -out pem-rsa4096.key 4096 2>/dev/null
openssl ecparam -name prime256v1 -genkey -noout -out pem-ec256.key
openssl ecparam -name secp384r1 -genkey -noout -out pem-ec384.key
for c in aes128 aes256 des3; do
  openssl ec -in pem-ec256.key -$c -passout pass:$P -out pem-ec256-$c.key 2>/dev/null
done
# An EC key with explicit curve parameters instead of the named curve.
openssl ec -in pem-ec256.key -param_enc explicit -out pem-ec256-explicit.key 2>/dev/null
# DSA (1.1.4 refuses it: unsupportedType).
openssl dsaparam -genkey -noout -out pem-dsa1024.key 1024 2>/dev/null

# PKCS#8 (BEGIN PRIVATE KEY / BEGIN ENCRYPTED PRIVATE KEY).
ssh-keygen -q -t rsa -b 2048 -m PKCS8 -N '' -C '' -f pkcs8-rsa2048-sshkeygen.key
ssh-keygen -q -t rsa -b 2048 -m PKCS8 -N "$P" -C '' -f pkcs8-rsa2048-sshkeygen-enc.key
ssh-keygen -q -t ecdsa -b 256 -m PKCS8 -N '' -C '' -f pkcs8-ec256-sshkeygen.key
openssl genpkey -algorithm ed25519 -out pkcs8-ed25519.key
openssl pkcs8 -topk8 -nocrypt -in pem-rsa2048.key -out pkcs8-rsa2048.key
openssl pkcs8 -topk8 -nocrypt -in pem-ec256.key -out pkcs8-ec256.key
openssl pkcs8 -topk8 -v2 aes-256-cbc -passout pass:$P -in pem-rsa2048.key -out pkcs8-rsa2048-aes256.key
openssl pkcs8 -topk8 -v2 des3 -passout pass:$P -in pem-rsa2048.key -out pkcs8-rsa2048-des3.key
openssl pkcs8 -topk8 -scrypt -passout pass:$P -in pem-rsa2048.key -out pkcs8-rsa2048-scrypt.key
openssl pkcs8 -topk8 -v2 aes-256-cbc -passout pass:$P -in pkcs8-ed25519.key -out pkcs8-ed25519-aes256.key
openssl pkcs8 -topk8 -v2 aes-256-cbc -passout pass:$P -in pem-ec256.key -out pkcs8-ec256-aes256.key

# PuTTY PPK v2 and v3 (v3 is refused by 1.1.4: ppkV3).
printf '%s\n' "$P" > /tmp/pass
for t in rsa ed25519 ecdsa dsa; do
  extra=''
  [ $t = rsa ] && extra='-b 2048'
  [ $t = dsa ] && extra='-b 1024'
  # PuTTYgen refuses a PPK -> PPK conversion as "no useful action": the source is an OpenSSH file.
  puttygen -q -t $t $extra -C "sp7 ppk $t" -O private-openssh-new --new-passphrase /dev/null -o /tmp/src.ppk
  puttygen /tmp/src.ppk -O private --ppk-param version=2 -o ppk2-$t.ppk
  puttygen /tmp/src.ppk -O private --ppk-param version=2 --new-passphrase /tmp/pass -o ppk2-$t-enc.ppk
  puttygen /tmp/src.ppk -O private --ppk-param version=3 -o ppk3-$t.ppk
  puttygen /tmp/src.ppk -O private --ppk-param version=3 --new-passphrase /tmp/pass -o ppk3-$t-enc.ppk
  rm -f /tmp/src.ppk
done
puttygen -q -t rsa -b 4096 -C 'sp7 ppk rsa4096' -O private-openssh-new --new-passphrase /dev/null -o /tmp/src.ppk
puttygen /tmp/src.ppk -O private --ppk-param version=2 -o ppk2-rsa4096.ppk
rm -f /tmp/src.ppk
# A PPK v2 RSA key converted from an OpenSSH key (puttygen import, keeps the comment).
puttygen openssh-rsa2048.key -O private --ppk-param version=2 -o ppk2-rsa2048-from-openssh.ppk
rm -f /tmp/pass

# CRLF line endings (keys pasted on Windows).
for f in openssh-ed25519-enc.key pem-rsa2048-aes128.key ppk2-rsa-enc.ppk; do
  sed 's/$/\r/' "$f" > "crlf-$f"
done
rm -f ./*.pub
review_additions
ls | wc -l
