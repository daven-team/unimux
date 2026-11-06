# SP2: Electron safeStorage (OSCrypt v10) both directions

Status: **Windows half verified** (2026-11-06, Windows 11 26200). **Mac half open**: no Mac yet; the macOS code is written from
the Electron 45.2.2 / Chromium 156 source, compiled and clippy clean for `aarch64-apple-darwin`, and its crypto is tested
byte for byte against Node vectors, but it never ran against a real Keychain.

## Questions and answers

| question | answer | how we know |
|---|---|---|
| Is Electron 45 safeStorage still the sync OSCrypt 'v10', not app-bound 'v20'? | **Yes, v10.** All 4 blobs 1.1.4 wrote start with `v10`; `Local State` has only `os_crypt.{audit_enabled, encrypted_key}` (no `app_bound_encrypted_key`). Chromium 156 itself has no `components/os_crypt/sync` any more; Electron keeps it with its patch `revert_oscrypt_remove_sync_backend.patch`, and `safeStorage.encryptString/decryptString` call `OSCrypt::EncryptString/DecryptString` (shell/browser/api/electron_api_safe_storage.cc at v45.2.2). | spike run (check B), Electron source |
| Can Rust decrypt what 1.1.4 stored? | **Yes**: an SSH host password, an SSH key secret (JSON with the OpenSSH private key and its passphrase), a DB password and a GitHub token, including non-ASCII text, emoji, quotes and backslashes. | spike checks B |
| Can 1.1.4 decrypt what Rust wrote? | **Yes**: after Rust replaced every blob in place, 1.1.4 started on the same dir reports nothing locked (`ssh:vault:info`, `db:vault:info`), its own `safeStorage.decryptString` gives the same 4 texts, and it does not rewrite the vault files or the key. | spike checks C |
| Fresh install: can Rust create `Local State` so 1.1.4 uses the same key? | **Yes**, if it is wrapped like Chromium does it: `CryptProtectData(description "Chromium", CRYPTPROTECT_AUDIT)` and `"audit_enabled": true`. Our first try (empty description, no audit flag, no `audit_enabled`) still worked (1.1.4 read our key), but Chromium then re-wrapped the key and wrote a new `encrypted_key`. With the Chromium wrapping 1.1.4 keeps our `encrypted_key` byte for byte (it adds `uninstall_metrics` and rewrites the file, which is its right). | spike checks D, DPAPI blob header (flags 0x10, description `Chromium\0`) decoded from Electron's own key |
| Does "Local State exists but has no key" happen? | **Not with 1.1.4**: even an idle run (no secret stored) writes `os_crypt.encrypted_key`. OSCrypt::Init runs at startup on Windows; the pref store writes `Local State` about 9 s later (8.8 to 9.5 s measured), and on quit. So the rule "never create a key while `Local State` exists" (stay unavailable) costs nothing in practice. | spike check E, timing lines |
| macOS Keychain names? | Service `unimux Safe Storage`, account **`unimux Key`**. Electron sets account = app name (`electron_browser_main_parts.cc`: `KeychainPassword::GetAccountName() = app_name`), its patch `feat_ensure_mas_builds_of_the_same_application_can_use_safestorage.patch` looks up `app_name + " Key"` (non-MAS), and if that is missing it migrates the legacy account `app_name` (copy, then delete the old item); if neither exists Chromium stores base64 of 16 random bytes. The app name of 1.1.4 is `unimux` (`app.getName()`, productName). | Electron v45.2.2 source, Chromium 156.0.8078.80 `keychain_password_mac.mm` |
| ajzakomator / MultiCoding Keychain fallbacks? | **None needed for parity**: 1.1.4 only ever looks under its current name. A data dir copied from MultiCoding/ajzakomator has blobs under the old Keychain service, which 1.1.4 cannot read either (they show as locked). | source |
| Decrypt edge cases | `safeStorage.decryptString`: empty buffer -> `""`; no `v10`/`v11` prefix -> throws before OSCrypt runs. So Chromium's legacy paths (plain DPAPI blobs on Windows, unencrypted text on macOS) are unreachable from safeStorage; Rust refuses them too. | Electron source; unit test `decrypt_follows_electron_safe_storage` |

## Measurements (Windows 11, this machine)

| what | value |
|---|---|
| Rust `Cipher::open` on an existing `Local State` (read + JSON + CryptUnprotectData) | 4.3 to 8.6 ms (first call in the process) |
| Rust `Cipher::open` creating `Local State` (random key + CryptProtectData + write) | 4.4 to 7.7 ms |
| Rust AES-256-GCM decrypt per blob (debug profile) | 1.2 to 2 us; the first call 60 to 115 us (one-time setup) |
| Electron 1.1.4 `safeStorage.decryptString` per blob | 1.6 to 4.2 us |
| Electron writes `Local State` after start | 8.8 to 9.5 s (pref store commit), plus on quit |

## What is in the code

`src-tauri/crates/unimux-oscrypt` (B2 builds on it):

- `v10.rs`: both blob formats as pure functions (AES-256-GCM with nonce, AES-128-CBC with the 16-space IV, PBKDF2-HMAC-SHA1 `saltysalt` 1003), tested on every OS.
- `local_state.rs`: read `os_crypt.encrypted_key` (other keys ignored), the fresh text, `create_new` (temp file + hard link: never replaces a `Local State` that appeared meanwhile).
- `dpapi.rs` (Windows): CryptProtectData / CryptUnprotectData like Chromium.
- `keychain.rs` (macOS): SecItem lookup with the Electron names, legacy migration and random-password creation.
- `lib.rs`: `Cipher { open, storage, available, encrypt, decrypt, origin }`, `Storage` labels `dpapi|keychain|unavailable`, `Origin` (Existing / Created / Off / Failed / Given) for startup.log, key material in `Zeroizing`, Debug never prints the key.
- `examples/sp2_tool.rs`: inspect / rewrite / export-key / fresh, used by the spike script.
- `tests/fixtures/win-electron45/`: a throwaway profile made by the real 1.1.4 build: its `Local State`, the 3 vault files as 1.1.4 wrote them (`electron/`) and after the Rust rewrite (`rust/`), `expected.json`, `key.hex` (the unwrapped throwaway key, so CI tests the AES layer on every OS), `Local State.after-fresh` (1.1.4's rewrite of a Rust-created file), `mac-v10.json` (Node crypto vectors of the macOS format).
- `tests/fixtures.rs`: both sides decrypt to the expected texts; same layout, fresh nonces; Chromium shape of both `Local State` files; macOS vectors decrypt and re-encrypt byte for byte; on Windows, the fixture `Local State` unwraps to `key.hex` for the user who ran the spike (skipped with a note for anyone else: DPAPI is per user).

## How to run

1. A built 1.1.4 checkout outside the repo: `git worktree add --detach <dir> main`, junction its `node_modules` to the repo's, `npx electron-vite build`.
2. `node scripts/spike-sp2-safestorage.mjs --electron <dir> [--fixtures src-tauri/crates/unimux-oscrypt/tests/fixtures/win-electron45] [--keep]`. It builds `sp2_tool`, uses only `D:\Projekty\_tmp-sp2-*` scratch roots (data dir, scratch home and AppData), starts the unpackaged 1.1.4 with `MC_DATA_DIR`, `MC_OFFSCREEN`, `MC_DEBUG_PORT` and `--inspect`, quits it with `app.quit()` and removes the scratch dir. Result on 2026-11-06: 28/28 checks in the last two runs (the earlier runs found the Chromium key wrapping and the lazy `Local State` write, both handled now).
3. `cd src-tauri && node ../scripts/msvc-run.mjs cargo test -p unimux-oscrypt` (17 tests) and `cargo clippy -p unimux-oscrypt --all-targets --target aarch64-apple-darwin -- -D warnings` for the macOS code.

The GitHub token blob is made by 1.1.4's own `safeStorage.encryptString` in its main process (through the inspector) and written in `GithubTokenStore`'s exact format: 1.1.4 ships with an empty `GITHUB_OAUTH_CLIENT_ID`, so its device flow can never store one, and `github:status` would check the fake token with api.github.com and forget it.

## Open

1. **Mac half** (needs a Mac): run the same round trip with 1.1.4 on macOS (Keychain item `unimux Safe Storage` / `unimux Key` created by 1.1.4, Rust reads it, Rust blobs read by 1.1.4), confirm the "Always Allow" prompt once for the re-signed binary, and the legacy-account migration. The spike script is Windows-only today (`D:\Projekty` scratch, `taskkill`, `export-key`); the Mac run needs a small port of the launcher part.
2. A `Local State` whose DPAPI key belongs to another Windows user (a data dir copied between accounts or machines) is reported as `Origin::Failed` and stays unavailable (secrets show as locked, nothing written). What Electron does there (we expect: unavailable too, no new key) was not measured: it needs a second Windows account.
3. B2 decides when the Keychain is first touched on macOS (today `Cipher::open` reads it eagerly; 1.1.x touches it at OSCrypt's first use).
