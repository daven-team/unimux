# SP7: russh coverage

Status: done (Windows, 2026-11-06). Branch `tauri-pkg-SP7`.

Question: can russh 0.65.1 replace ssh2 1.17 with the same keys, the same servers, the same login flow and the same
`known_hosts.json` bytes as 1.1.4, and where it cannot, what own code closes the gap?

Answer: yes. Every key 1.1.4 accepts loads with the same public blob, type, bits, fingerprint and comment (53 of 62 through
russh alone, the other 9 through a 90-line legacy PEM decryptor that is prototyped and tested here). On 8 server builds
(OpenSSH 10 with 4 configurations, OpenSSH 5.9, Dropbear 2025 twice, Dropbear 2016) russh, given the 1.1.4 algorithm
offer, succeeds and fails in exactly the same cases as 1.1.4, negotiates the same algorithms, and presents host keys that
are byte-identical to the entries 1.1.4's KnownHostsStore wrote (21 of 21). PPK v2 needs no own parser.

## What was run

| piece | file | what it does |
|---|---|---|
| key corpus | `scripts/sp7/gen-keys.sh` in `scripts/sp7/docker/keytools.Dockerfile` (OpenSSH 10.0p2, OpenSSL 3.5.7, PuTTYgen 0.83) + 1.1.4's own `generateKey` | 91 private keys in `test/golden/sp7/keys` (passphrase `sp7-pass`, throwaway test keys) |
| 1.1.4 answers | `scripts/sp7/golden-keys.mjs` | the real `parsePrivateKey` of `src/main/ssh/keys.ts` (ssh2 1.17) for every key, with and without the passphrase -> `test/golden/sp7/keys.json` |
| russh keys | `src-tauri/crates/unimux-ssh/tests/sp7_keys.rs` | `russh::keys::decode_secret_key` (and the `legacy_pem` prototype) against keys.json; asserts the gap list and the "russh loads what 1.1.4 refuses" list exactly; `-- --nocapture` prints the per-file matrix |
| 1.1.4 runtime offer | `scripts/sp7/ssh2-defaults.cjs` | ssh2's DEFAULT_* lists under Electron 45.2.2 (BoringSSL) |
| 1.1.4 login side | `scripts/sp7/ssh2-side.mjs` (Electron as Node) | real `SshLogin` (src/sshcore/login.ts: connect options, auth order, prompts), `mapSshError`, `KnownHostsStore` writing the app's `known_hosts.json` |
| russh login side | `src-tauri/crates/unimux-ssh/examples/sp7_probe.rs` | one russh login per JSON spec; profiles `ssh2` (the 1.1.4 offer), `russh` (`Preferred::DEFAULT`), `legacy` (1.1.4 offer + SHA-1 kex + AES-CBC) |
| servers | `scripts/sp7/docker/*.Dockerfile` | OpenSSH 10.0p2 (Debian trixie, PAM) with configs current / old / sha1 / cbc, OpenSSH 5.9p1 (Ubuntu 12.04), Dropbear 2025.89 (ECDSA 256 and 521 variants), Dropbear 2016.74 (Debian stretch) |
| matrix | `scripts/sp7/matrix.mjs` | starts the containers (ids recorded, removed by id), runs both sides, compares, writes `test/golden/sp7/matrix.json` and `test/golden/sp7/known_hosts/<server>.json`, prints the tables in the appendix |

How to run (Windows, Docker Desktop running):

```
docker build --load -t unimux-sp7-keytools -f scripts/sp7/docker/keytools.Dockerfile scripts/sp7/docker   # only to regenerate the corpus
MSYS_NO_PATHCONV=1 docker run --rm -v "<repo>/test/golden/sp7/keys:/out" -v "<repo>/scripts/sp7/gen-keys.sh:/gen-keys.sh:ro" unimux-sp7-keytools sh /gen-keys.sh
node scripts/sp7/golden-keys.mjs [--ssh2]          # --ssh2 regenerates the ssh2-*.key files with 1.1.4's generator
cd src-tauri && cargo test -p unimux-ssh --test sp7_keys -- --nocapture
cargo build --release -p unimux-ssh --example sp7_probe
cd .. && SP7_PROBE_PROFILE=release node scripts/sp7/matrix.mjs --build      # about 12 minutes; --only <server> for one
```

## Keys

91 files, 62 accepted by 1.1.4. "Identical" = same public blob (so the same fingerprint), type, bits and comment.

| group | files | 1.1.4 | russh 0.65.1 alone | with the S2 own code |
|---|---|---|---|---|
| OpenSSH, unencrypted: ed25519, ecdsa 256/384/521, rsa 2048/3072/4096 (ssh-keygen and 1.1.4's generator) | 14 | loads | identical | identical |
| OpenSSH, encrypted aes256-ctr bcrypt 16 (ssh-keygen and 1.1.4's generator), CRLF variant | 13 | loads | identical | identical |
| OpenSSH, other key ciphers: aes128/192-ctr, aes128/192/256-cbc, aes128/256-gcm, 64 rounds | 9 | loads | identical | identical |
| OpenSSH, 3des-cbc | 1 | loads | identical with ssh-key feature `tdes` (fails without it) | identical |
| OpenSSH, chacha20-poly1305 | 1 | badPassphrase | loads | refuse before russh (badPassphrase) |
| PEM PKCS#1 RSA / SEC1 EC, unencrypted | 8 | loads | identical | identical |
| PEM RSA, DEK-Info AES-128-CBC (ssh-keygen -m PEM, openssl), CRLF variant | 3 | loads | identical | identical |
| PEM RSA, DEK-Info AES-192-CBC, AES-256-CBC, DES-EDE3-CBC | 3 | loads | fails (only AES-128-CBC is read) | identical (`legacy_pem`) |
| PEM EC, any DEK-Info (ssh-keygen -m PEM AES-128, openssl AES-128/256, DES-EDE3) | 6 | loads | fails (decrypted as RSA) | identical (`legacy_pem`) |
| PEM RSA, DEK-Info CAMELLIA-256-CBC | 1 | badPassphrase | fails | `legacy_pem` -> UnsupportedCipher -> badPassphrase |
| PEM EC with explicit curve parameters | 1 | notAKey | loads | refuse before russh (notAKey) |
| PEM DSA | 1 | notAKey | fails | fails |
| PKCS#8, plain and encrypted (PBES2 AES-256, 3DES, scrypt; RSA, EC, ed25519) | 11 | notAKey (ssh2 reads no PKCS#8) | loads 10 (not PBES2 3DES) | refuse before russh (notAKey) |
| PPK v2 ssh-rsa, plain (2048, 4096, imported from OpenSSH) | 3 | loads | identical | identical |
| PPK v2 ssh-rsa, aes256-cbc (+ CRLF variant) | 2 | loads | identical, MAC checked (wrong passphrase -> IncorrectMac) | identical |
| PPK v2 ssh-dss / ecdsa / ed25519 | 6 | unsupportedType | loads | refuse before russh (unsupportedType) |
| PPK v3 (all types, plain and Argon2) | 8 | ppkV3 | loads | refuse before russh (ppkV3) |

Totals: russh alone loads 53 of the 62 identically; with `legacy_pem` 62 of 62. No input made `decode_secret_key` panic
(the `unimplemented!()` of russh's AES-256 PEM branch is unreachable). A wrong passphrase never yields a key.

Error shapes, for the S2 DraftResult mapping: no passphrase on an encrypted key gives `KeyIsEncrypted` (OpenSSH, PEM
AES-128) or `Ppk(Encrypted)`, but a garbled DER error for the PEM gaps, so S2 keeps 1.1.4's text check (`isEncrypted`:
`Proc-Type: 4,ENCRYPTED`, `Encryption:` other than none, OpenSSH cipher name) and its rule "encrypted + failure =
needsPassphrase without a passphrase, badPassphrase with one". A wrong passphrase gives `SshKey(Crypto)`,
`Ppk(IncorrectMac)` or `Unpad`. A passphrase on an unencrypted key is ignored by russh; 1.1.4 does the same except for an
unencrypted PPK v2, where ssh2 answers notAKey (only reachable through `checkPassphrase` on such a key; the S2 golden corpus
decides whether to copy it).

### Own code (S2)

1. `legacy_pem` (prototype in `tests/sp7_keys.rs`, about 90 lines): `Proc-Type: 4,ENCRYPTED` + `DEK-Info: <cipher>,<iv>`,
   key = EVP_BytesToKey(MD5, 1 round, salt = IV[0..8]), CBC + PKCS#7 for AES-128/192/256-CBC and DES-EDE3-CBC, the plain DER
   (PKCS#1 RSA or SEC1 EC) re-armored and given to russh. Any other DEK-Info cipher is refused like 1.1.4 (badPassphrase).
   Crates: aes 0.9.4, cbc 0.2.1, des 0.9.0, md5 0.8.1 (already in the russh dependency tree).
2. ssh-key `=0.7.0-rc.11` (the version russh pins) with feature `tdes` for 3des-cbc OpenSSH key files.
3. Refusals before russh, so the error codes stay 1.1.4's: `PuTTY-User-Key-File-3:` -> ppkV3; `PuTTY-User-Key-File-2:`
   other than ssh-rsa -> unsupportedType (both are 1.1.4's own regexes already); `BEGIN PRIVATE KEY` /
   `BEGIN ENCRYPTED PRIVATE KEY` -> notAKey; an EC key whose ECParameters are not a named-curve OID -> notAKey; an OpenSSH
   key file with cipher chacha20-poly1305@openssh.com -> needsPassphrase / badPassphrase (what 1.1.4 answers).
4. No own PPK v2 parser: ssh-key's PPK reader (feature `ppk`, on in russh) gives identical keys and verifies the MAC.

## Servers

The 1.1.4 offer (ssh2 1.17 under Electron 45.2.2, from `scripts/sp7/ssh2-defaults.cjs`; BoringSSL drops chacha20-poly1305):

- kex: curve25519-sha256@libssh.org, curve25519-sha256, ecdh-sha2-nistp256/384/521, diffie-hellman-group-exchange-sha256,
  diffie-hellman-group14-sha256, group15/16/17/18-sha512 (+ ext-info-c, kex-strict-c-v00@openssh.com)
- host key: ssh-ed25519, ecdsa-sha2-nistp256/384/521, rsa-sha2-512, rsa-sha2-256, ssh-rsa
- cipher: aes128-gcm@openssh.com, aes256-gcm@openssh.com, aes128-ctr, aes192-ctr, aes256-ctr
- MAC: hmac-sha2-256-etm, hmac-sha2-512-etm, hmac-sha1-etm, hmac-sha2-256, hmac-sha2-512, hmac-sha1; compression none, zlib@openssh.com, zlib

russh's `Preferred::DEFAULT` differs: it adds mlkem768x25519-sha256 and chacha20-poly1305, and lacks ecdh-sha2-*, aes128-gcm
and both SHA-1 MACs. The probe's `ssh2_preferred()` is the 1.1.4 offer in russh terms; S3 uses it.

| server | offer | 1.1.4 | russh, 1.1.4 offer | host keys presented / byte-identical to 1.1.4 known_hosts.json | russh DEFAULT | russh legacy offer |
|---|---|---|---|---|---|---|
| OpenSSH 10.0p2, current defaults + PAM | modern | all 12 logins ok | same 12, same algorithms | 6 / 6 (ed25519, ecdsa 256/384/521, rsa-sha2-512/256) | ok (mlkem / chacha20) | ok |
| OpenSSH 10.0p2, "old" offer (OpenSSH 5.x/6.x: gex-sha256 + SHA-1 kex, ssh-rsa, hmac-sha1/md5) | old | rsa keys, passwords, kbd-int ok; ed25519/ecdsa keys refused by the server | same | 1 / 1 (ssh-rsa) | FAIL: no common MAC | ok |
| OpenSSH 10.0p2, SHA-1 only (kex, host key, user key, MAC) | SHA-1 | all fail (protocol) | all fail (no common kex) | 1 / 1 (ssh-rsa) | fail | rsa keys, passwords, kbd-int ok (gex-sha1, ssh-rsa, hmac-sha1) |
| OpenSSH 10.0p2, CBC ciphers only | CBC | all fail (protocol) | all fail (no common cipher) | 3 / 3 | fail | all ok (aes256-cbc) |
| OpenSSH 5.9p1 (Ubuntu 12.04) | real old build | all ok except ed25519 keys (not in 5.9) | same, same algorithms (ecdh-sha2-nistp256 / ecdsa / aes128-ctr / hmac-sha2-256) | 2 / 2 (ecdsa256, ssh-rsa) | ok, but gex-sha256 / aes256-ctr / hmac-sha2-512 | ok |
| Dropbear 2025.89 (ECDSA 256 and 521 builds) | modern | keys and passwords ok; kbd-int fails (Dropbear has none) | same | 3 / 3 each | ok | ok |
| Dropbear 2016.74 (Debian stretch) | old embedded | all ok except ed25519 keys and kbd-int | same | 2 / 2 (ecdsa256, ssh-rsa) | ok, other cipher/MAC | ok |

Every login row: same outcome and same negotiated kex / host key / cipher / MAC (MAC ignored for AEAD ciphers). User keys
tried on every server: 1.1.4-generated ed25519, ecdsa 256/384/521, rsa3072, encrypted ed25519, encrypted OpenSSH rsa3072,
PEM AES-128 rsa2048, encrypted PPK v2 rsa2048; plus saved password, password prompt (none -> password), keyboard-interactive
(none -> kbd-int, PAM) and a wrong saved password followed by 3 keyboard-interactive tries.

Host keys: for each of the 7 host key algorithms, ssh2 connected with only that algorithm and `KnownHostsStore.trust()`
wrote the entry (1.1.4 code, real `known_hosts.json` format); russh connected with the same single algorithm. 21 keys were
presented on the 8 servers and all 21 russh blobs equal the stored `key` (base64) and `fingerprint`. To reach the SHA-1 and
CBC servers at all, this step used ssh2's SUPPORTED lists and russh's legacy offer.

Other observations for S3 / S4:

- RSA user keys: russh picks the signature from `server-sig-algs` (`best_supported_rsa_hash`): rsa-sha2-512 on OpenSSH 10,
  rsa-sha2-256 on Dropbear 2025, ssh-rsa (SHA-1) on OpenSSH 5.9 and Dropbear 2016 (no ext-info); all logins succeed like 1.1.4.
- Keyboard-interactive on OpenSSH + PAM sends a second, empty info request after the answer. russh hands it to the caller;
  it must be answered with an empty list without showing a prompt (1.1.4's SshLogin does `!prompts.length -> finish([])`).
- `authenticate_none` returns the server's method list in the same order ssh2 passes to the auth handler
  (`publickey,password,keyboard-interactive`); the auth banner text is identical (`auth_banner`).
- russh failures are typed: `No common Kex/Cipher/Mac algorithm` maps to `protocol` like ssh2's handshake errors.
- OpenSSH 9.8+ `PerSourcePenalties` blocks a source after a few failed key exchanges ("Disconnected" for every later
  connection). The test configs turn it off; S4's CI matrix must do the same.
- CentOS 6 (OpenSSH 5.3) cannot run on the WSL2 kernel (glibc 2.12 segfaults, no vsyscall emulation), so the "old SHA-1-only
  build" is OpenSSH 10 with a SHA-1-only configuration plus the real OpenSSH 5.9.
- Legacy algorithms beyond the 1.1.4 offer: russh negotiates diffie-hellman-group14-sha1 / group-exchange-sha1 / group1-sha1
  and aes128/192/256-cbc (shown by the legacy column). 3des-cbc needs russh's `des` feature; hmac-md5, arcfour, blowfish and
  ssh-dss host keys are not in russh (1.1.4 does not offer them either). Decision: parity, the 1.1.4 offer only; adding the
  SHA-1 kex and CBC later is a list change in one place.

Timing (release probe, OpenSSH 10 in Docker, 10 publickey ed25519 logins each, ms from connect to authenticated):
1.1.4 p50 87 / p95 150 (kex done at 58); russh p50 100 / p95 168 (kex done at 64). An earlier run gave 89 vs 90. Same range;
the server side dominates.

## Decisions changed

- PLAN S2: no own PPK v2 parser; own code for legacy encrypted PEM; explicit refusal checks (list above). PKCS#8 stays
  refused (1.1.4 refuses it), so "PKCS#1/8" in the old row meant more than 1.1.4 does.
- PLAN S3: the algorithm offer is the 1.1.4 offer (`ssh2_preferred()`), not russh's default and not a legacy list.
- ARCHITECTURE section 2: russh features `ring`, `rsa`, `flate2` (no aws-lc-sys), ssh-key `tdes`, the legacy PEM crates.

## Open points

- ssh-key 0.7.0-rc.11 is a release candidate pinned by russh with `=`; a russh update moves it.
- The comparison used the 1.1.4 modules under the Electron 45 runtime of this tree, not the installed 1.1.4 app; the code
  paths are the same files.
- macOS not run (no Mac); the code is platform-neutral.
- Explicit-curve EC detection and the chacha20 key-file refusal are described but not prototyped (S2).

## Appendix: full matrix of the last run (2026-11-06)

Generated by `scripts/sp7/matrix.mjs`; raw data in `test/golden/sp7/matrix.json`, the 1.1.4 files in
`test/golden/sp7/known_hosts/`. In the russh columns, `denied,...` lists the failed steps (publickey or password, then 3
keyboard-interactive tries).

### openssh-10-current (`SSH-2.0-OpenSSH_10.0p2 Debian-7+deb13u4`)

| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | same algorithms | russh, legacy offer |
|---|---|---|---|---|
| publickey ed25519 | ok | ok | yes | ok |
| publickey ecdsa256 | ok | ok | yes | ok |
| publickey ecdsa384 | ok | ok | yes | ok |
| publickey ecdsa521 | ok | ok | yes | ok |
| publickey rsa3072 | ok | ok | yes | ok |
| publickey ed25519 enc (1.1.4 generated) | ok | ok | yes | ok |
| publickey rsa3072 enc (OpenSSH) | ok | ok | yes | ok |
| publickey rsa2048 PEM AES-128 | ok | ok | yes | ok |
| publickey rsa2048 PPK v2 enc | ok | ok | yes | ok |
| saved password | ok | ok | yes | ok |
| password prompt | ok | ok | yes | ok |
| keyboard-interactive | ok | ok | yes | ok |
| wrong saved password | fail (auth) | fail (denied,denied,denied,denied) | yes | fail (denied,denied,denied,denied) |

negotiated: 1.1.4 curve25519-sha256@libssh.org / ssh-ed25519 / aes128-gcm@openssh.com; russh curve25519-sha256@libssh.org / ssh-ed25519 / aes128-gcm@openssh.com; russh legacy offer curve25519-sha256@libssh.org / ssh-ed25519 / aes128-gcm@openssh.com

| host key algorithm | ssh2 | russh | known_hosts.json entry equal |
|---|---|---|---|
| ssh-ed25519 | presented | presented | yes (byte-identical) |
| ecdsa-sha2-nistp256 | presented | presented | yes (byte-identical) |
| ecdsa-sha2-nistp384 | presented | presented | yes (byte-identical) |
| ecdsa-sha2-nistp521 | presented | presented | yes (byte-identical) |
| rsa-sha2-512 | presented | presented | yes (byte-identical) |
| rsa-sha2-256 | presented | presented | yes (byte-identical) |
| ssh-rsa | absent | absent | - |

| russh profile | saved-password login | negotiated |
|---|---|---|
| ssh2 | ok | curve25519-sha256@libssh.org / ssh-ed25519 / aes128-gcm@openssh.com |
| russh | ok | mlkem768x25519-sha256 / ssh-ed25519 / chacha20-poly1305@openssh.com |
| legacy | ok | curve25519-sha256@libssh.org / ssh-ed25519 / aes128-gcm@openssh.com |

timing (10 publickey ed25519 logins, ms to authenticated): ssh2 p50 87 p95 150 (kex 58); russh p50 100 p95 168 (kex 64)

### openssh-10-old-offer (`SSH-2.0-OpenSSH_10.0p2 Debian-7+deb13u4`)

| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | same algorithms | russh, legacy offer |
|---|---|---|---|---|
| publickey ed25519 | fail (auth) | fail (denied,denied,denied,denied) | yes | fail (denied,denied,denied,denied) |
| publickey ecdsa256 | fail (auth) | fail (denied,denied,denied,denied) | yes | fail (denied,denied,denied,denied) |
| publickey ecdsa384 | fail (auth) | fail (denied,denied,denied,denied) | yes | fail (denied,denied,denied,denied) |
| publickey ecdsa521 | fail (auth) | fail (denied,denied,denied,denied) | yes | fail (denied,denied,denied,denied) |
| publickey rsa3072 | ok | ok | yes | ok |
| publickey ed25519 enc (1.1.4 generated) | fail (auth) | fail (denied,denied,denied,denied) | yes | fail (denied,denied,denied,denied) |
| publickey rsa3072 enc (OpenSSH) | ok | ok | yes | ok |
| publickey rsa2048 PEM AES-128 | ok | ok | yes | ok |
| publickey rsa2048 PPK v2 enc | ok | ok | yes | ok |
| saved password | ok | ok | yes | ok |
| password prompt | ok | ok | yes | ok |
| keyboard-interactive | ok | ok | yes | ok |
| wrong saved password | fail (auth) | fail (denied,denied,denied,denied) | yes | fail (denied,denied,denied,denied) |

negotiated: 1.1.4 diffie-hellman-group-exchange-sha256 / ssh-rsa / aes128-ctr / hmac-sha1; russh diffie-hellman-group-exchange-sha256 / ssh-rsa / aes128-ctr / hmac-sha1; russh legacy offer diffie-hellman-group-exchange-sha256 / ssh-rsa / aes128-ctr / hmac-sha1

| host key algorithm | ssh2 | russh | known_hosts.json entry equal |
|---|---|---|---|
| ssh-ed25519 | absent | absent | - |
| ecdsa-sha2-nistp256 | absent | absent | - |
| ecdsa-sha2-nistp384 | absent | absent | - |
| ecdsa-sha2-nistp521 | absent | absent | - |
| rsa-sha2-512 | absent | absent | - |
| rsa-sha2-256 | absent | absent | - |
| ssh-rsa | presented | presented | yes (byte-identical) |

| russh profile | saved-password login | negotiated |
|---|---|---|
| ssh2 | ok | diffie-hellman-group-exchange-sha256 / ssh-rsa / aes128-ctr / hmac-sha1 |
| russh | fail (no common mac) | - |
| legacy | ok | diffie-hellman-group-exchange-sha256 / ssh-rsa / aes128-ctr / hmac-sha1 |

### openssh-10-sha1-only (`SSH-2.0-OpenSSH_10.0p2 Debian-7+deb13u4`)

| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | same algorithms | russh, legacy offer |
|---|---|---|---|---|
| publickey ed25519 | fail (protocol) | fail (no common kex) | yes | fail (denied,denied,denied,denied) |
| publickey ecdsa256 | fail (protocol) | fail (no common kex) | yes | fail (denied,denied,denied,denied) |
| publickey ecdsa384 | fail (protocol) | fail (no common kex) | yes | fail (denied,denied,denied,denied) |
| publickey ecdsa521 | fail (protocol) | fail (no common kex) | yes | fail (denied,denied,denied,denied) |
| publickey rsa3072 | fail (protocol) | fail (no common kex) | yes | ok |
| publickey ed25519 enc (1.1.4 generated) | fail (protocol) | fail (no common kex) | yes | fail (denied,denied,denied,denied) |
| publickey rsa3072 enc (OpenSSH) | fail (protocol) | fail (no common kex) | yes | ok |
| publickey rsa2048 PEM AES-128 | fail (protocol) | fail (no common kex) | yes | ok |
| publickey rsa2048 PPK v2 enc | fail (protocol) | fail (no common kex) | yes | ok |
| saved password | fail (protocol) | fail (no common kex) | yes | ok |
| password prompt | fail (protocol) | fail (no common kex) | yes | ok |
| keyboard-interactive | fail (protocol) | fail (no common kex) | yes | ok |
| wrong saved password | fail (protocol) | fail (no common kex) | yes | fail (denied,denied,denied,denied) |

negotiated: 1.1.4 -; russh -; russh legacy offer diffie-hellman-group-exchange-sha1 / ssh-rsa / aes128-ctr / hmac-sha1

| host key algorithm | ssh2 | russh | known_hosts.json entry equal |
|---|---|---|---|
| ssh-ed25519 | absent | absent | - |
| ecdsa-sha2-nistp256 | absent | absent | - |
| ecdsa-sha2-nistp384 | absent | absent | - |
| ecdsa-sha2-nistp521 | absent | absent | - |
| rsa-sha2-512 | absent | absent | - |
| rsa-sha2-256 | absent | absent | - |
| ssh-rsa | presented | presented | yes (byte-identical) |

| russh profile | saved-password login | negotiated |
|---|---|---|
| ssh2 | fail (no common kex) | - |
| russh | fail (no common kex) | - |
| legacy | ok | diffie-hellman-group-exchange-sha1 / ssh-rsa / aes128-ctr / hmac-sha1 |

### openssh-10-cbc-only (`SSH-2.0-OpenSSH_10.0p2 Debian-7+deb13u4`)

| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | same algorithms | russh, legacy offer |
|---|---|---|---|---|
| publickey ed25519 | fail (protocol) | fail (no common cipher) | yes | ok |
| publickey ecdsa256 | fail (protocol) | fail (no common cipher) | yes | ok |
| publickey ecdsa384 | fail (protocol) | fail (no common cipher) | yes | ok |
| publickey ecdsa521 | fail (protocol) | fail (no common cipher) | yes | ok |
| publickey rsa3072 | fail (protocol) | fail (no common cipher) | yes | ok |
| publickey ed25519 enc (1.1.4 generated) | fail (protocol) | fail (no common cipher) | yes | ok |
| publickey rsa3072 enc (OpenSSH) | fail (protocol) | fail (no common cipher) | yes | ok |
| publickey rsa2048 PEM AES-128 | fail (protocol) | fail (no common cipher) | yes | ok |
| publickey rsa2048 PPK v2 enc | fail (protocol) | fail (no common cipher) | yes | ok |
| saved password | fail (protocol) | fail (no common cipher) | yes | ok |
| password prompt | fail (protocol) | fail (no common cipher) | yes | ok |
| keyboard-interactive | fail (protocol) | fail (no common cipher) | yes | ok |
| wrong saved password | fail (protocol) | fail (no common cipher) | yes | fail (denied,denied,denied,denied) |

negotiated: 1.1.4 -; russh -; russh legacy offer curve25519-sha256@libssh.org / ssh-ed25519 / aes256-cbc / hmac-sha2-256-etm@openssh.com

| host key algorithm | ssh2 | russh | known_hosts.json entry equal |
|---|---|---|---|
| ssh-ed25519 | presented | presented | yes (byte-identical) |
| ecdsa-sha2-nistp256 | absent | absent | - |
| ecdsa-sha2-nistp384 | absent | absent | - |
| ecdsa-sha2-nistp521 | absent | absent | - |
| rsa-sha2-512 | presented | presented | yes (byte-identical) |
| rsa-sha2-256 | presented | presented | yes (byte-identical) |
| ssh-rsa | absent | absent | - |

| russh profile | saved-password login | negotiated |
|---|---|---|
| ssh2 | fail (no common cipher) | - |
| russh | fail (no common cipher) | - |
| legacy | ok | curve25519-sha256@libssh.org / ssh-ed25519 / aes256-cbc / hmac-sha2-256-etm@openssh.com |

### openssh-5.9-ubuntu1204 (`SSH-2.0-OpenSSH_5.9p1 Debian-5ubuntu1.10`)

| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | same algorithms | russh, legacy offer |
|---|---|---|---|---|
| publickey ed25519 | fail (auth) | fail (denied,denied,denied,denied) | yes | fail (denied,denied,denied,denied) |
| publickey ecdsa256 | ok | ok | yes | ok |
| publickey ecdsa384 | ok | ok | yes | ok |
| publickey ecdsa521 | ok | ok | yes | ok |
| publickey rsa3072 | ok | ok | yes | ok |
| publickey ed25519 enc (1.1.4 generated) | fail (auth) | fail (denied,denied,denied,denied) | yes | fail (denied,denied,denied,denied) |
| publickey rsa3072 enc (OpenSSH) | ok | ok | yes | ok |
| publickey rsa2048 PEM AES-128 | ok | ok | yes | ok |
| publickey rsa2048 PPK v2 enc | ok | ok | yes | ok |
| saved password | ok | ok | yes | ok |
| password prompt | ok | ok | yes | ok |
| keyboard-interactive | ok | ok | yes | ok |
| wrong saved password | fail (auth) | fail (denied,denied,denied,denied) | yes | fail (denied,denied,denied,denied) |

negotiated: 1.1.4 ecdh-sha2-nistp256 / ecdsa-sha2-nistp256 / aes128-ctr / hmac-sha2-256; russh ecdh-sha2-nistp256 / ecdsa-sha2-nistp256 / aes128-ctr / hmac-sha2-256; russh legacy offer ecdh-sha2-nistp256 / ecdsa-sha2-nistp256 / aes128-ctr / hmac-sha2-256

| host key algorithm | ssh2 | russh | known_hosts.json entry equal |
|---|---|---|---|
| ssh-ed25519 | absent | absent | - |
| ecdsa-sha2-nistp256 | presented | presented | yes (byte-identical) |
| ecdsa-sha2-nistp384 | absent | absent | - |
| ecdsa-sha2-nistp521 | absent | absent | - |
| rsa-sha2-512 | absent | absent | - |
| rsa-sha2-256 | absent | absent | - |
| ssh-rsa | presented | presented | yes (byte-identical) |

| russh profile | saved-password login | negotiated |
|---|---|---|
| ssh2 | ok | ecdh-sha2-nistp256 / ecdsa-sha2-nistp256 / aes128-ctr / hmac-sha2-256 |
| russh | ok | diffie-hellman-group-exchange-sha256 / ecdsa-sha2-nistp256 / aes256-ctr / hmac-sha2-512 |
| legacy | ok | ecdh-sha2-nistp256 / ecdsa-sha2-nistp256 / aes128-ctr / hmac-sha2-256 |

### dropbear-2025 (`SSH-2.0-dropbear_2025.89`)

| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | same algorithms | russh, legacy offer |
|---|---|---|---|---|
| publickey ed25519 | ok | ok | yes | ok |
| publickey ecdsa256 | ok | ok | yes | ok |
| publickey ecdsa384 | ok | ok | yes | ok |
| publickey ecdsa521 | ok | ok | yes | ok |
| publickey rsa3072 | ok | ok | yes | ok |
| publickey ed25519 enc (1.1.4 generated) | ok | ok | yes | ok |
| publickey rsa3072 enc (OpenSSH) | ok | ok | yes | ok |
| publickey rsa2048 PEM AES-128 | ok | ok | yes | ok |
| publickey rsa2048 PPK v2 enc | ok | ok | yes | ok |
| saved password | ok | ok | yes | ok |
| password prompt | ok | ok | yes | ok |
| keyboard-interactive | fail (auth) | fail (denied,denied) | yes | fail (denied,denied) |
| wrong saved password | fail (auth) | fail (denied,denied,denied,denied) | yes | fail (denied,denied,denied,denied) |

negotiated: 1.1.4 curve25519-sha256@libssh.org / ssh-ed25519 / aes128-ctr / hmac-sha2-256; russh curve25519-sha256@libssh.org / ssh-ed25519 / aes128-ctr / hmac-sha2-256; russh legacy offer curve25519-sha256@libssh.org / ssh-ed25519 / aes128-ctr / hmac-sha2-256

| host key algorithm | ssh2 | russh | known_hosts.json entry equal |
|---|---|---|---|
| ssh-ed25519 | presented | presented | yes (byte-identical) |
| ecdsa-sha2-nistp256 | presented | presented | yes (byte-identical) |
| ecdsa-sha2-nistp384 | absent | absent | - |
| ecdsa-sha2-nistp521 | absent | absent | - |
| rsa-sha2-512 | absent | absent | - |
| rsa-sha2-256 | presented | presented | yes (byte-identical) |
| ssh-rsa | absent | absent | - |

| russh profile | saved-password login | negotiated |
|---|---|---|
| ssh2 | ok | curve25519-sha256@libssh.org / ssh-ed25519 / aes128-ctr / hmac-sha2-256 |
| russh | ok | mlkem768x25519-sha256 / ssh-ed25519 / chacha20-poly1305@openssh.com |
| legacy | ok | curve25519-sha256@libssh.org / ssh-ed25519 / aes128-ctr / hmac-sha2-256 |

### dropbear-2025-ecdsa521 (`SSH-2.0-dropbear_2025.89`)

| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | same algorithms | russh, legacy offer |
|---|---|---|---|---|
| publickey ed25519 | ok | ok | yes | ok |
| publickey ecdsa256 | ok | ok | yes | ok |
| publickey ecdsa384 | ok | ok | yes | ok |
| publickey ecdsa521 | ok | ok | yes | ok |
| publickey rsa3072 | ok | ok | yes | ok |
| publickey ed25519 enc (1.1.4 generated) | ok | ok | yes | ok |
| publickey rsa3072 enc (OpenSSH) | ok | ok | yes | ok |
| publickey rsa2048 PEM AES-128 | ok | ok | yes | ok |
| publickey rsa2048 PPK v2 enc | ok | ok | yes | ok |
| saved password | ok | ok | yes | ok |
| password prompt | ok | ok | yes | ok |
| keyboard-interactive | fail (auth) | fail (denied,denied) | yes | fail (denied,denied) |
| wrong saved password | fail (auth) | fail (denied,denied,denied,denied) | yes | fail (denied,denied,denied,denied) |

negotiated: 1.1.4 curve25519-sha256@libssh.org / ssh-ed25519 / aes128-ctr / hmac-sha2-256; russh curve25519-sha256@libssh.org / ssh-ed25519 / aes128-ctr / hmac-sha2-256; russh legacy offer curve25519-sha256@libssh.org / ssh-ed25519 / aes128-ctr / hmac-sha2-256

| host key algorithm | ssh2 | russh | known_hosts.json entry equal |
|---|---|---|---|
| ssh-ed25519 | presented | presented | yes (byte-identical) |
| ecdsa-sha2-nistp256 | absent | absent | - |
| ecdsa-sha2-nistp384 | absent | absent | - |
| ecdsa-sha2-nistp521 | presented | presented | yes (byte-identical) |
| rsa-sha2-512 | absent | absent | - |
| rsa-sha2-256 | presented | presented | yes (byte-identical) |
| ssh-rsa | absent | absent | - |

| russh profile | saved-password login | negotiated |
|---|---|---|
| ssh2 | ok | curve25519-sha256@libssh.org / ssh-ed25519 / aes128-ctr / hmac-sha2-256 |
| russh | ok | mlkem768x25519-sha256 / ssh-ed25519 / chacha20-poly1305@openssh.com |
| legacy | ok | curve25519-sha256@libssh.org / ssh-ed25519 / aes128-ctr / hmac-sha2-256 |

### dropbear-2016 (`SSH-2.0-dropbear_2016.74`)

| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | same algorithms | russh, legacy offer |
|---|---|---|---|---|
| publickey ed25519 | fail (auth) | fail (denied,denied,denied,denied) | yes | fail (denied,denied,denied,denied) |
| publickey ecdsa256 | ok | ok | yes | ok |
| publickey ecdsa384 | ok | ok | yes | ok |
| publickey ecdsa521 | ok | ok | yes | ok |
| publickey rsa3072 | ok | ok | yes | ok |
| publickey ed25519 enc (1.1.4 generated) | fail (auth) | fail (denied,denied,denied,denied) | yes | fail (denied,denied,denied,denied) |
| publickey rsa3072 enc (OpenSSH) | ok | ok | yes | ok |
| publickey rsa2048 PEM AES-128 | ok | ok | yes | ok |
| publickey rsa2048 PPK v2 enc | ok | ok | yes | ok |
| saved password | ok | ok | yes | ok |
| password prompt | ok | ok | yes | ok |
| keyboard-interactive | fail (auth) | fail (denied,denied) | yes | fail (denied,denied) |
| wrong saved password | fail (auth) | fail (denied,denied,denied,denied) | yes | fail (denied,denied,denied,denied) |

negotiated: 1.1.4 curve25519-sha256@libssh.org / ecdsa-sha2-nistp256 / aes128-ctr / hmac-sha2-256; russh curve25519-sha256@libssh.org / ecdsa-sha2-nistp256 / aes128-ctr / hmac-sha2-256; russh legacy offer curve25519-sha256@libssh.org / ecdsa-sha2-nistp256 / aes128-ctr / hmac-sha2-256

| host key algorithm | ssh2 | russh | known_hosts.json entry equal |
|---|---|---|---|
| ssh-ed25519 | absent | absent | - |
| ecdsa-sha2-nistp256 | presented | presented | yes (byte-identical) |
| ecdsa-sha2-nistp384 | absent | absent | - |
| ecdsa-sha2-nistp521 | absent | absent | - |
| rsa-sha2-512 | absent | absent | - |
| rsa-sha2-256 | absent | absent | - |
| ssh-rsa | presented | presented | yes (byte-identical) |

| russh profile | saved-password login | negotiated |
|---|---|---|
| ssh2 | ok | curve25519-sha256@libssh.org / ecdsa-sha2-nistp256 / aes128-ctr / hmac-sha2-256 |
| russh | ok | curve25519-sha256@libssh.org / ecdsa-sha2-nistp256 / aes256-ctr / hmac-sha2-512 |
| legacy | ok | curve25519-sha256@libssh.org / ecdsa-sha2-nistp256 / aes128-ctr / hmac-sha2-256 |

no differences between 1.1.4 and russh (1.1.4 offer)
