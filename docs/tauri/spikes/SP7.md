# SP7: russh coverage

Status: done (Windows, 2026-11-06), review findings fixed the same day. Branch `tauri-pkg-SP7`.

Question: can russh 0.65.1 replace ssh2 1.17 with the same keys, the same servers, the same login flow and the same
`known_hosts.json` bytes as 1.1.4, and where it cannot, what own code closes the gap?

Answer: yes. For every file of a 116-key corpus and every input (no passphrase, the right one, a wrong one) the S2
prototype `port_parse` (1.1.4's text checks, refusals before russh, the own `legacy_pem` reader for traditional PEM, then
russh) answers exactly like 1.1.4: the same public blob, type, bits, fingerprint, comment and publicKey line, or the same
error code (348 of 348). russh alone loads 57 of the 76 keys 1.1.4 accepts; the other 19 are traditional encrypted PEM
keys. On 8 server builds (OpenSSH 10 with 4 configurations, OpenSSH 5.9, Dropbear 2025 twice, Dropbear 2016) a russh
login that picks its methods in 1.1.4's SshLogin order, given the 1.1.4 algorithm offer, ends like 1.1.4 in all 104
logins: same success or SshErrorCode, the same methods sent in the same order, the same negotiated algorithms; its host
keys are byte-identical to the entries 1.1.4's KnownHostsStore wrote (21 of 21). PPK v2 needs no own parser.

## What was run

| piece | file | what it does |
|---|---|---|
| key corpus | `scripts/sp7/gen-keys.sh` in `scripts/sp7/docker/keytools.Dockerfile` (OpenSSH 10.0p2, OpenSSL 3.5.7, PuTTYgen 0.83) + 1.1.4's own `generateKey` + 3 hand-made DEK-Info files | 116 private keys in `test/golden/sp7/keys` (passphrase `sp7-pass`, throwaway test keys) |
| 1.1.4 answers | `scripts/sp7/golden-keys.mjs` (runs itself under Electron 45 as Node) | the real `parsePrivateKey` of `src/main/ssh/keys.ts` (ssh2 1.17) for every key with no passphrase, the right one and a wrong one -> `test/golden/sp7/keys.json`; also writes the comment fixtures (1.1.4's generateKey) and the hand-made DEK-Info fixtures when they are missing |
| russh keys | `src-tauri/crates/unimux-ssh/tests/sp7_keys.rs` | `port_parse` (the S2 prototype: `legacy_pem`, refusals, russh) must give every 1.1.4 answer of keys.json; the gap list and the "russh alone loads what 1.1.4 refuses" list are asserted exactly; malformed DEK-Info headers never panic; `-- --nocapture` prints the per-file matrix |
| 1.1.4 runtime offer | `scripts/sp7/ssh2-defaults.cjs` | ssh2's DEFAULT_* lists under Electron 45.2.2 (BoringSSL) |
| 1.1.4 login side | `scripts/sp7/ssh2-side.mjs` (Electron as Node) | real `SshLogin` (src/sshcore/login.ts: connect options, auth order, prompts), `mapSshError`, `KnownHostsStore` writing the app's `known_hosts.json` |
| russh login side | `src-tauri/crates/unimux-ssh/examples/sp7_probe.rs` | one russh login per JSON spec, methods chosen like SshLogin.nextAuth from the server's lists (`AuthOrder`), errors mapped to SshErrorCode (`error_code`); profiles `ssh2` (the 1.1.4 offer), `russh` (`Preferred::DEFAULT`), `legacy` (1.1.4 offer + SHA-1 kex + AES-CBC) |
| servers | `scripts/sp7/docker/*.Dockerfile` | OpenSSH 10.0p2 (Debian trixie, PAM) with configs current / old / sha1 / cbc, OpenSSH 5.9p1 (Ubuntu 12.04), Dropbear 2025.89 (ECDSA 256 and 521 variants), Dropbear 2016.74 (Debian stretch) |
| matrix | `scripts/sp7/matrix.mjs` | starts the containers (ids recorded, removed by id), runs both sides, compares outcome + SshErrorCode, the methods sent and the algorithms, writes `test/golden/sp7/matrix.json` and `test/golden/sp7/known_hosts/<server>.json`, prints the tables in the appendix |

How to run (Windows, Docker Desktop running):

```
docker build --load -t unimux-sp7-keytools -f scripts/sp7/docker/keytools.Dockerfile scripts/sp7/docker   # only to regenerate the corpus
MSYS_NO_PATHCONV=1 docker run --rm -v "<repo>/test/golden/sp7/keys:/out" -v "<repo>/scripts/sp7/gen-keys.sh:/gen-keys.sh:ro" unimux-sp7-keytools sh /gen-keys.sh
# --review-additions: only the files added after the review (AES-CTR, BF-CBC, refused ciphers, malformed DEK-Info)
MSYS_NO_PATHCONV=1 docker run --rm -v "<repo>/test/golden/sp7/keys:/out" -v "<repo>/scripts/sp7/gen-keys.sh:/gen-keys.sh:ro" unimux-sp7-keytools sh /gen-keys.sh --review-additions
node scripts/sp7/golden-keys.mjs [--ssh2]          # --ssh2 regenerates the ssh2-*.key files with 1.1.4's generator; --check
cd src-tauri && cargo test -p unimux-ssh --test sp7_keys -- --nocapture
cargo build --release -p unimux-ssh --example sp7_probe
cd .. && SP7_PROBE_PROFILE=release node scripts/sp7/matrix.mjs --build      # about 12 minutes; --only <server> for one
```

## Keys

116 files, 76 accepted by 1.1.4. Every file is answered three times (no passphrase, the right one, a wrong one; keys.json
holds the 1.1.4 answer of each). "Identical" = same public blob (so the same fingerprint), type, bits, comment and publicKey
line. The last column is `port_parse` in `tests/sp7_keys.rs`, the S2 prototype of `parsePrivateKey`; it gives 1.1.4's
answer (ok and metadata, or the same error code and `encrypted` flag) for all 348 inputs.

| group | files | 1.1.4 | russh 0.65.1 alone | `port_parse` (S2 prototype) |
|---|---|---|---|---|
| OpenSSH, unencrypted: ed25519, ecdsa 256/384/521, rsa 2048/3072/4096 (ssh-keygen and 1.1.4's generator) | 14 | loads, with or without a passphrase | identical | identical |
| 1.1.4's generator, comments of 150 emoji, `x` + 150 emoji (the 200-unit cut splits a pair), BOM + U+0085 + U+3000, control characters + U+2028/2029 | 4 | loads; comment cut at 200 UTF-16 units, JS `trim()` | identical key, comment needs the JS rule | identical (`clean_comment`: UTF-16 units, the JS whitespace set with U+FEFF and without U+0085, a split pair's lone high surrogate as U+FFFD like `js_json::parse`) |
| OpenSSH, encrypted aes256-ctr bcrypt 16 (ssh-keygen and 1.1.4's generator), CRLF variant | 13 | needsPassphrase / loads / badPassphrase | identical | identical |
| OpenSSH, other key ciphers: aes128/192-ctr, aes128/192/256-cbc, aes128/256-gcm, 64 rounds | 9 | same | identical | identical |
| OpenSSH, 3des-cbc | 1 | same | identical with ssh-key feature `tdes` (fails without it) | identical |
| OpenSSH, chacha20-poly1305 | 1 | needsPassphrase / badPassphrase / badPassphrase | loads | refused before russh |
| PEM PKCS#1 RSA / SEC1 EC, unencrypted | 8 | loads, with or without a passphrase | identical without a passphrase; refuses SEC1 EC when given one (decrypts it) | identical: a passphrase only reaches the key reader when `isEncrypted` says so |
| PEM RSA, DEK-Info AES-128-CBC (ssh-keygen -m PEM, openssl), CRLF variant | 3 | needsPassphrase / loads / badPassphrase | identical | identical (`legacy_pem`) |
| PEM RSA, AES-128-CBC with a lower-case header, an IV with trailing junk, an odd-length IV | 3 | same (ssh2 lower-cases the name; `Buffer.from(hex)` stops at the first non-hex pair) | fails | identical (`legacy_pem`) |
| PEM RSA, DEK-Info AES-192-CBC, AES-256-CBC, DES-EDE3-CBC | 3 | same | fails (only AES-128-CBC is read) | identical (`legacy_pem`) |
| PEM RSA, DEK-Info AES-128/192/256-CTR, BF-CBC (`openssl rsa -traditional`, legacy provider for Blowfish) | 4 | same | fails | identical (`legacy_pem`) |
| PEM EC, any DEK-Info (ssh-keygen -m PEM AES-128, openssl AES-128/256-CBC, DES-EDE3-CBC, AES-128/256-CTR, BF-CBC) | 9 | same | fails (decrypted as RSA) | identical (`legacy_pem`) |
| PEM RSA, DEK-Info CAMELLIA-256-CBC, AES-256-CFB, AES-128-OFB, DES-CBC, DES-EDE-CBC; hand-made AES-128-GCM, AES-128-ECB, DES-EDE3 (ECB) | 8 | needsPassphrase / badPassphrase / badPassphrase | fails | identical (`legacy_pem`: UnsupportedCipher) |
| PEM RSA, malformed DEK-Info: IV of 8 bytes, IV starting with a non-hex digit, IV with `é` in it, no IV at all | 4 | needsPassphrase / badPassphrase / badPassphrase | fails | identical, no panic (`legacy_pem`: Malformed, or the header is skipped like ssh2 does) |
| PEM EC with explicit curve parameters | 1 | notAKey | loads | refused before russh (DER check of `[0] parameters`) |
| PEM DSA | 1 | notAKey | fails | identical |
| PKCS#8, plain and encrypted (PBES2 AES-256, 3DES, scrypt; RSA, EC, ed25519) | 11 | notAKey (ssh2 reads no PKCS#8) | loads 10 (not PBES2 3DES) | refused before russh |
| PPK v2 ssh-rsa, plain (2048, 4096, imported from OpenSSH) | 3 | loads without a passphrase; notAKey with any passphrase (ssh2's MAC key includes the passphrase) | loads with every input | identical: an unencrypted PPK v2 given a passphrase is refused before russh |
| PPK v2 ssh-rsa, aes256-cbc (+ CRLF variant) | 2 | needsPassphrase / loads / badPassphrase | identical, MAC checked (wrong passphrase -> IncorrectMac) | identical |
| PPK v2 ssh-dss / ecdsa / ed25519 | 6 | unsupportedType | loads | refused before russh (1.1.4's own regex) |
| PPK v3 (all types, plain and Argon2) | 8 | ppkV3 | loads | refused before russh (1.1.4's own regex) |

Totals: russh alone loads 57 of the 76 identically (`GAPS` lists the other 19) and 26 files 1.1.4 refuses with every input
(`EXTRA`); `port_parse` answers 348 of 348 inputs like 1.1.4. No input made `decode_secret_key` or `port_parse` panic
(`malformed_dek_info_headers_never_panic` also feeds 179 hand-made DEK-Info values, each with no passphrase and a wrong one: non-ASCII and NUL at every IV position,
empty, 10 000 digits, other cipher names). A wrong passphrase never yields a key.

How the cipher list was decided: ssh2 1.17 decrypts a DEK-Info cipher when its lower-case name is in
`crypto.getCiphers()` and in its CIPHER_INFO table. Under Electron 45 (BoringSSL) that intersection is aes-128/192/256-cbc,
aes-128/192/256-ctr, aes-128/256-gcm, des-ede3-cbc, bf-cbc, bf-ecb, des-ede3 and rc4. GCM, the ECB names and RC4 have no
working path in ssh2 (no auth tag, an IV the ECB cipher refuses, a zero-length IV); RC4 even throws a RangeError out of
`parseKey` in 1.1.4. OpenSSL does not write any of those, so only the hand-made GCM / ECB files are in the corpus
(badPassphrase, like 1.1.4); `legacy_pem` answers badPassphrase for RC4 too (decided: 1.1.4 has no defined answer there).
The golden script runs under Electron, not Node 26, because Node's OpenSSL 3 lists bf-cbc but cannot decrypt it without
the legacy provider.

Error shapes, for the S2 DraftResult mapping: russh's own errors are not used for the codes. `port_parse` keeps 1.1.4's
rules: `isEncrypted` on the text (`Proc-Type: 4,ENCRYPTED`, `Encryption:` other than none, OpenSSH cipher name), an empty
passphrase counts as none (JS truthiness), ssh2's "no passphrase given" -> needsPassphrase, any other failure ->
needsPassphrase (no passphrase) / badPassphrase (with one) when encrypted, notAKey otherwise; a loaded key outside
KEY_ALGOS -> unsupportedType. A passphrase on an unencrypted OpenSSH or PEM key is ignored (1.1.4 does the same; russh
would refuse an unencrypted SEC1 key with one, so the port never hands it one). An unencrypted PPK v2 given a passphrase
answers notAKey in 1.1.4, and every path that passes a user passphrase reaches that: replacePrivateKey
(src/main/ssh/ipc.ts:179), checkPassphrase (coordinator.ts, ipc.ts:137) and the draft unlock (keys.ts evaluate). The port
copies it.

### Own code (S2)

1. `legacy_pem` (prototype in `tests/sp7_keys.rs`, about 200 lines with comments), read the way ssh2's OpenSSH_Old_Private.parse reads
   `BEGIN RSA|EC|DSA PRIVATE KEY`: headers until the first line without a colon; a `DEK-Info` header without a comma is
   skipped; the cipher name is lower-cased and must be one of AES-128/192/256-CBC, AES-128/192/256-CTR, DES-EDE3-CBC,
   BF-CBC (else UnsupportedCipher, before the passphrase is looked at); the IV is parsed like `Buffer.from(hex)` (bytes,
   pairs of hex digits up to the first pair that is not one, never a `&str` slice) and must have the cipher's IV length
   (16 for AES, 8 for DES-EDE3 and Blowfish; else Malformed); only then a missing passphrase is NoPassphrase; key =
   EVP_BytesToKey(MD5, 1 round, salt = IV[0..8]); CBC without padding removal in the cipher, valid PKCS#7 padding cut off
   afterwards (ssh2 leaves the padding to its DER reader), CTR as a stream. The plain DER (PKCS#1 RSA, SEC1 EC or DSA) is
   armored again and given to russh with no passphrase. Crates: aes 0.9.4, cbc 0.2.1, ctr 0.10.1, des 0.9.0, blowfish
   0.10.0, md5 0.8.1 (all already in the russh / bcrypt-pbkdf dependency tree).
2. ssh-key `=0.7.0-rc.11` (the version russh pins) with feature `tdes` for 3des-cbc OpenSSH key files.
3. Refusals before russh, so the error codes stay 1.1.4's: `PuTTY-User-Key-File-3:` -> ppkV3; `PuTTY-User-Key-File-2:`
   other than ssh-rsa -> unsupportedType (both are 1.1.4's own regexes already); `BEGIN PRIVATE KEY` /
   `BEGIN ENCRYPTED PRIVATE KEY` -> notAKey; an EC key whose `[0] parameters` are not a named-curve OID -> notAKey; an
   OpenSSH key file with cipher chacha20-poly1305@openssh.com -> needsPassphrase / badPassphrase; an unencrypted PPK v2
   given a passphrase -> notAKey (ssh2's MAC check). All of them are prototyped in `s2_load`.
4. The passphrase goes to russh only when `isEncrypted` is true (an unencrypted SEC1 EC key with a passphrase loads in 1.1.4).
5. The 1.1.4 comment rule (`clean_comment`): control characters to spaces, the JS `trim()` set (U+FEFF yes, U+0085 no), at
   most 200 UTF-16 code units, a split surrogate pair ends in U+FFFD.
6. No own PPK v2 parser: ssh-key's PPK reader (feature `ppk`, on in russh) gives identical keys and verifies the MAC.

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

Every login row: same outcome and SshErrorCode (1.1.4's mapSshError vs the probe's `error_code`, the S3 table), the same
methods sent in the same order (ssh2's auth handler choices vs the probe's `AuthOrder`, which follows SshLogin.nextAuth over
the server's method lists: publickey and the saved password while allowed, `none` before the server named its methods,
the password prompt and keyboard-interactive 3 times each, then give up), and the same negotiated kex / host key / cipher /
MAC (MAC ignored for AEAD ciphers). On Dropbear, which offers no keyboard-interactive, both stop right after the refused
password (`password, false`); on OpenSSH both go on to 3 keyboard-interactive tries. User keys
tried on every server: 1.1.4-generated ed25519, ecdsa 256/384/521, rsa3072, encrypted ed25519, encrypted OpenSSH rsa3072,
PEM AES-128 rsa2048, encrypted PPK v2 rsa2048; plus saved password, password prompt (none -> password), keyboard-interactive
(none -> kbd-int, PAM) and a wrong saved password (followed by keyboard-interactive where the server offers it).

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
- russh failures are typed: `NoCommonAlgo` (kex, cipher, MAC), Kex, Version and the other handshake errors map to
  `protocol` like ssh2's handshake errors; auth exhaustion is `auth`; socket errors by io::ErrorKind (`error_code` /
  `io_code` in the probe). The SHA-1-only and CBC-only servers give `protocol` on both sides.
- OpenSSH 9.8+ `PerSourcePenalties` blocks a source after a few failed key exchanges ("Disconnected" for every later
  connection). The test configs turn it off; S4's CI matrix must do the same.
- CentOS 6 (OpenSSH 5.3) cannot run on the WSL2 kernel (glibc 2.12 segfaults, no vsyscall emulation), so the "old SHA-1-only
  build" is OpenSSH 10 with a SHA-1-only configuration plus the real OpenSSH 5.9.
- Legacy algorithms beyond the 1.1.4 offer: russh negotiates diffie-hellman-group14-sha1 / group-exchange-sha1 / group1-sha1
  and aes128/192/256-cbc (shown by the legacy column). 3des-cbc needs russh's `des` feature; hmac-md5, arcfour, blowfish and
  ssh-dss host keys are not in russh (1.1.4 does not offer them either). Decision: parity, the 1.1.4 offer only; adding the
  SHA-1 kex and CBC later is a list change in one place.

Timing (release probe, OpenSSH 10 in Docker, 10 publickey ed25519 logins each, ms from the start of the connect to
authenticated: ssh2's 'ready' event, the probe's `ms.authenticated` taken right after the auth success, before any exec or
disconnect): 1.1.4 p50 81 / p95 81 (kex done at 45); russh p50 80 / p95 81 (kex done at 44). The first run before the review
measured russh up to after the disconnect (`ms.total`) and so reported 87 vs 100; that comparison was biased.

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
- RC4 in DEK-Info makes ssh2 1.17 throw (RangeError) instead of answering; OpenSSL cannot write such a file. The port
  answers badPassphrase (needsPassphrase without one). Deliberate, 1.1.4 has no defined answer.
- ssh2's PEM regex needs the whole (trimmed) text to be one PEM block; russh and `legacy_pem` find the block inside other
  text. Closed by S2: `unimux_ssh::keys::ssh2` uses ssh2's regexes as they are, checked against 1.1.4 on 160 text variants
  (test/golden/ssh-keys.json).

## Appendix: full matrix of the last run (2026-11-06, after the review fixes)

Generated by `scripts/sp7/matrix.mjs`; raw data in `test/golden/sp7/matrix.json`, the 1.1.4 files in
`test/golden/sp7/known_hosts/`. Error cells show the SshErrorCode (plus the cause of a russh protocol failure); "methods
sent" is the sequence of auth requests, identical on both sides in every row.
### openssh-10-current (`SSH-2.0-OpenSSH_10.0p2 Debian-7+deb13u4`)

| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | methods sent (1.1.4 = russh) | same algorithms | russh, legacy offer |
|---|---|---|---|---|---|
| publickey ed25519 | ok | ok | publickey | yes | ok |
| publickey ecdsa256 | ok | ok | publickey | yes | ok |
| publickey ecdsa384 | ok | ok | publickey | yes | ok |
| publickey ecdsa521 | ok | ok | publickey | yes | ok |
| publickey rsa3072 | ok | ok | publickey | yes | ok |
| publickey ed25519 enc (1.1.4 generated) | ok | ok | publickey | yes | ok |
| publickey rsa3072 enc (OpenSSH) | ok | ok | publickey | yes | ok |
| publickey rsa2048 PEM AES-128 | ok | ok | publickey | yes | ok |
| publickey rsa2048 PPK v2 enc | ok | ok | publickey | yes | ok |
| saved password | ok | ok | password | yes | ok |
| password prompt | ok | ok | none, password | yes | ok |
| keyboard-interactive | ok | ok | none, keyboard-interactive | yes | ok |
| wrong saved password | fail (auth) | fail (auth) | password, keyboard-interactive, keyboard-interactive, keyboard-interactive, false | yes | fail (auth) |

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

timing (10 publickey ed25519 logins, ms from connect to authenticated): ssh2 p50 81 p95 81 (kex 45); russh p50 80 p95 81 (kex 44)

### openssh-10-old-offer (`SSH-2.0-OpenSSH_10.0p2 Debian-7+deb13u4`)

| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | methods sent (1.1.4 = russh) | same algorithms | russh, legacy offer |
|---|---|---|---|---|---|
| publickey ed25519 | fail (auth) | fail (auth) | publickey, keyboard-interactive, keyboard-interactive, keyboard-interactive, false | yes | fail (auth) |
| publickey ecdsa256 | fail (auth) | fail (auth) | publickey, keyboard-interactive, keyboard-interactive, keyboard-interactive, false | yes | fail (auth) |
| publickey ecdsa384 | fail (auth) | fail (auth) | publickey, keyboard-interactive, keyboard-interactive, keyboard-interactive, false | yes | fail (auth) |
| publickey ecdsa521 | fail (auth) | fail (auth) | publickey, keyboard-interactive, keyboard-interactive, keyboard-interactive, false | yes | fail (auth) |
| publickey rsa3072 | ok | ok | publickey | yes | ok |
| publickey ed25519 enc (1.1.4 generated) | fail (auth) | fail (auth) | publickey, keyboard-interactive, keyboard-interactive, keyboard-interactive, false | yes | fail (auth) |
| publickey rsa3072 enc (OpenSSH) | ok | ok | publickey | yes | ok |
| publickey rsa2048 PEM AES-128 | ok | ok | publickey | yes | ok |
| publickey rsa2048 PPK v2 enc | ok | ok | publickey | yes | ok |
| saved password | ok | ok | password | yes | ok |
| password prompt | ok | ok | none, password | yes | ok |
| keyboard-interactive | ok | ok | none, keyboard-interactive | yes | ok |
| wrong saved password | fail (auth) | fail (auth) | password, keyboard-interactive, keyboard-interactive, keyboard-interactive, false | yes | fail (auth) |

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
| russh | fail (unknown: no common mac) | - |
| legacy | ok | diffie-hellman-group-exchange-sha256 / ssh-rsa / aes128-ctr / hmac-sha1 |

### openssh-10-sha1-only (`SSH-2.0-OpenSSH_10.0p2 Debian-7+deb13u4`)

| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | methods sent (1.1.4 = russh) | same algorithms | russh, legacy offer |
|---|---|---|---|---|---|
| publickey ed25519 | fail (protocol) | fail (protocol: no common kex) | - | yes | fail (auth) |
| publickey ecdsa256 | fail (protocol) | fail (protocol: no common kex) | - | yes | fail (auth) |
| publickey ecdsa384 | fail (protocol) | fail (protocol: no common kex) | - | yes | fail (auth) |
| publickey ecdsa521 | fail (protocol) | fail (protocol: no common kex) | - | yes | fail (auth) |
| publickey rsa3072 | fail (protocol) | fail (protocol: no common kex) | - | yes | ok |
| publickey ed25519 enc (1.1.4 generated) | fail (protocol) | fail (protocol: no common kex) | - | yes | fail (auth) |
| publickey rsa3072 enc (OpenSSH) | fail (protocol) | fail (protocol: no common kex) | - | yes | ok |
| publickey rsa2048 PEM AES-128 | fail (protocol) | fail (protocol: no common kex) | - | yes | ok |
| publickey rsa2048 PPK v2 enc | fail (protocol) | fail (protocol: no common kex) | - | yes | ok |
| saved password | fail (protocol) | fail (protocol: no common kex) | - | yes | ok |
| password prompt | fail (protocol) | fail (protocol: no common kex) | - | yes | ok |
| keyboard-interactive | fail (protocol) | fail (protocol: no common kex) | - | yes | ok |
| wrong saved password | fail (protocol) | fail (protocol: no common kex) | - | yes | fail (auth) |

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
| ssh2 | fail (unknown: no common kex) | - |
| russh | fail (unknown: no common kex) | - |
| legacy | ok | diffie-hellman-group-exchange-sha1 / ssh-rsa / aes128-ctr / hmac-sha1 |

### openssh-10-cbc-only (`SSH-2.0-OpenSSH_10.0p2 Debian-7+deb13u4`)

| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | methods sent (1.1.4 = russh) | same algorithms | russh, legacy offer |
|---|---|---|---|---|---|
| publickey ed25519 | fail (protocol) | fail (protocol: no common cipher) | - | yes | ok |
| publickey ecdsa256 | fail (protocol) | fail (protocol: no common cipher) | - | yes | ok |
| publickey ecdsa384 | fail (protocol) | fail (protocol: no common cipher) | - | yes | ok |
| publickey ecdsa521 | fail (protocol) | fail (protocol: no common cipher) | - | yes | ok |
| publickey rsa3072 | fail (protocol) | fail (protocol: no common cipher) | - | yes | ok |
| publickey ed25519 enc (1.1.4 generated) | fail (protocol) | fail (protocol: no common cipher) | - | yes | ok |
| publickey rsa3072 enc (OpenSSH) | fail (protocol) | fail (protocol: no common cipher) | - | yes | ok |
| publickey rsa2048 PEM AES-128 | fail (protocol) | fail (protocol: no common cipher) | - | yes | ok |
| publickey rsa2048 PPK v2 enc | fail (protocol) | fail (protocol: no common cipher) | - | yes | ok |
| saved password | fail (protocol) | fail (protocol: no common cipher) | - | yes | ok |
| password prompt | fail (protocol) | fail (protocol: no common cipher) | - | yes | ok |
| keyboard-interactive | fail (protocol) | fail (protocol: no common cipher) | - | yes | ok |
| wrong saved password | fail (protocol) | fail (protocol: no common cipher) | - | yes | fail (auth) |

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
| ssh2 | fail (unknown: no common cipher) | - |
| russh | fail (unknown: no common cipher) | - |
| legacy | ok | curve25519-sha256@libssh.org / ssh-ed25519 / aes256-cbc / hmac-sha2-256-etm@openssh.com |

### openssh-5.9-ubuntu1204 (`SSH-2.0-OpenSSH_5.9p1 Debian-5ubuntu1.10`)

| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | methods sent (1.1.4 = russh) | same algorithms | russh, legacy offer |
|---|---|---|---|---|---|
| publickey ed25519 | fail (auth) | fail (auth) | publickey, keyboard-interactive, keyboard-interactive, keyboard-interactive, false | yes | fail (auth) |
| publickey ecdsa256 | ok | ok | publickey | yes | ok |
| publickey ecdsa384 | ok | ok | publickey | yes | ok |
| publickey ecdsa521 | ok | ok | publickey | yes | ok |
| publickey rsa3072 | ok | ok | publickey | yes | ok |
| publickey ed25519 enc (1.1.4 generated) | fail (auth) | fail (auth) | publickey, keyboard-interactive, keyboard-interactive, keyboard-interactive, false | yes | fail (auth) |
| publickey rsa3072 enc (OpenSSH) | ok | ok | publickey | yes | ok |
| publickey rsa2048 PEM AES-128 | ok | ok | publickey | yes | ok |
| publickey rsa2048 PPK v2 enc | ok | ok | publickey | yes | ok |
| saved password | ok | ok | password | yes | ok |
| password prompt | ok | ok | none, password | yes | ok |
| keyboard-interactive | ok | ok | none, keyboard-interactive | yes | ok |
| wrong saved password | fail (auth) | fail (auth) | password, keyboard-interactive, keyboard-interactive, keyboard-interactive, false | yes | fail (auth) |

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

| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | methods sent (1.1.4 = russh) | same algorithms | russh, legacy offer |
|---|---|---|---|---|---|
| publickey ed25519 | ok | ok | publickey | yes | ok |
| publickey ecdsa256 | ok | ok | publickey | yes | ok |
| publickey ecdsa384 | ok | ok | publickey | yes | ok |
| publickey ecdsa521 | ok | ok | publickey | yes | ok |
| publickey rsa3072 | ok | ok | publickey | yes | ok |
| publickey ed25519 enc (1.1.4 generated) | ok | ok | publickey | yes | ok |
| publickey rsa3072 enc (OpenSSH) | ok | ok | publickey | yes | ok |
| publickey rsa2048 PEM AES-128 | ok | ok | publickey | yes | ok |
| publickey rsa2048 PPK v2 enc | ok | ok | publickey | yes | ok |
| saved password | ok | ok | password | yes | ok |
| password prompt | ok | ok | none, password | yes | ok |
| keyboard-interactive | fail (auth) | fail (auth) | none, false | yes | fail (auth) |
| wrong saved password | fail (auth) | fail (auth) | password, false | yes | fail (auth) |

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

| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | methods sent (1.1.4 = russh) | same algorithms | russh, legacy offer |
|---|---|---|---|---|---|
| publickey ed25519 | ok | ok | publickey | yes | ok |
| publickey ecdsa256 | ok | ok | publickey | yes | ok |
| publickey ecdsa384 | ok | ok | publickey | yes | ok |
| publickey ecdsa521 | ok | ok | publickey | yes | ok |
| publickey rsa3072 | ok | ok | publickey | yes | ok |
| publickey ed25519 enc (1.1.4 generated) | ok | ok | publickey | yes | ok |
| publickey rsa3072 enc (OpenSSH) | ok | ok | publickey | yes | ok |
| publickey rsa2048 PEM AES-128 | ok | ok | publickey | yes | ok |
| publickey rsa2048 PPK v2 enc | ok | ok | publickey | yes | ok |
| saved password | ok | ok | password | yes | ok |
| password prompt | ok | ok | none, password | yes | ok |
| keyboard-interactive | fail (auth) | fail (auth) | none, false | yes | fail (auth) |
| wrong saved password | fail (auth) | fail (auth) | password, false | yes | fail (auth) |

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

| login | 1.1.4 (ssh2) | russh, 1.1.4 offer | methods sent (1.1.4 = russh) | same algorithms | russh, legacy offer |
|---|---|---|---|---|---|
| publickey ed25519 | fail (auth) | fail (auth) | publickey, false | yes | fail (auth) |
| publickey ecdsa256 | ok | ok | publickey | yes | ok |
| publickey ecdsa384 | ok | ok | publickey | yes | ok |
| publickey ecdsa521 | ok | ok | publickey | yes | ok |
| publickey rsa3072 | ok | ok | publickey | yes | ok |
| publickey ed25519 enc (1.1.4 generated) | fail (auth) | fail (auth) | publickey, false | yes | fail (auth) |
| publickey rsa3072 enc (OpenSSH) | ok | ok | publickey | yes | ok |
| publickey rsa2048 PEM AES-128 | ok | ok | publickey | yes | ok |
| publickey rsa2048 PPK v2 enc | ok | ok | publickey | yes | ok |
| saved password | ok | ok | password | yes | ok |
| password prompt | ok | ok | none, password | yes | ok |
| keyboard-interactive | fail (auth) | fail (auth) | none, false | yes | fail (auth) |
| wrong saved password | fail (auth) | fail (auth) | password, false | yes | fail (auth) |

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
