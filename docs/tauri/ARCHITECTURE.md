# unimux 1.2.0+ on Tauri 2: architecture

Status: migration spec, written 2026-11-06 from three competing designs and three judge reports.

## 0. Decision summary

Three designs were judged:

| Design | Idea | Judge totals | Effort |
|---|---|---|---|
| 1. Full Rust backend | Everything in src/main and the 4 utility hosts becomes Rust crates in one Tauri process | 5.3, 4.9, 7.4 | about 256 agent-days before the first release |
| 2. Rust OS layer + hidden TS service webview "svc" | src/main runs inside a hidden webview, hot paths in Rust | 6.0, 6.1, 5.3 | about 150 + 35 agent-days |
| 3. Staged strangler | 1.2.0 = Tauri 2 shell + Node 24 SEA sidecar running src/main; subsystems ported to Rust in 1.3.0 to 1.6.0 | 7.3, 7.6, 6.3 | about 70 agent-days to 1.2.0, 278 total |

Winner by votes: **design 3** (2 of 3 judges; the third judge preferred design 1 because it matches the user's literal request "w calosci na Rust w 1.2.0").

This spec is design 3 with grafts from designs 1 and 2. The grafts that matter most:

- The **terminal data plane moves to Rust in 1.2.0** (ConPTY with sideloaded conpty.dll + OpenConsole.exe, Job Objects, FlowGate/TailBuffer/OutputChannel, binary frames over `tauri::ipc::Channel`). node-pty and the `--host=pty` fork are gone in 1.2.0. This is the biggest perceived speed gain and it removes Node from the hot path.
- **Electron safeStorage compatibility is a Rust crate (`unimux-oscrypt`) that reads AND writes** the Chromium 'v10' format, so 1.1.4 can still read files written by 1.2.0 (downgrade safety).
- **Network calls that used Chromium networking** (token refresh, usage polling, changelog, GitHub) go through a Rust `http_fetch` command (reqwest with system proxy incl. PAC/WPAD), so corporate proxies do not regress.
- **Golden corpus + PORTING.md** exist before the first Rust port of business logic.
- **Contract test + Rust guard scan** from 1.2.0 on.
- **`unimux-blob://`** custom protocol for large binary payloads.
- **Dual host interface + `unimux-hostd`** stdio test binary so the existing Node `.int` suites drive each Rust port.
- **Session-end flush starts on WM_QUERYENDSESSION**, not WM_ENDSESSION.
- **StateController actor with revision watch** as the target design when state ownership moves to Rust (1.6.0).

The user asked for a full Rust rewrite shipped as 1.2.0. That conflicts with the winning design. It is listed as a user decision in PROGRESS.md. If the user insists on everything-in-Rust before any release, design 1's package list (256 agent-days, 8 to 10 calendar weeks with 6 to 8 agents) is the alternative, and design 3 stays the plan B if its spikes fail.

## 1. Process model

### 1.2.0

```
unimux.exe (Rust, tauri 2.12.5, windows_subsystem = "windows", panic = "unwind")
 |- tao/wry event loop, windows, WebView2/WKWebView glue, HWND subclass (session end, NCHITTEST)
 |- tokio runtime:
 |    pty actor (ConPTY / openpty, output engine, Channel data plane)       <- Rust in 1.2.0
 |    oscrypt, http_fetch, blob protocol, updater, notifications, windows   <- Rust in 1.2.0
 |    bridge_host (stdio JSON-lines to the sidecar), routing table
 |- WebView2 / WKWebView: "main", "detached-<uuid>", "update-gate"
 |- unimux-backend(.exe)  Node 24 SEA = esbuild bundle of src/main + src/backend/*
 |     spawned with CREATE_NO_WINDOW, ALL stdio piped (never inherit), in a Job Object (KILL_ON_JOB_CLOSE)
 |     |- unimux-backend --host=sftp   (lazy, ssh2)
 |     |- unimux-backend --host=db     (lazy, pg/mysql2/ioredis, node:sqlite workers)
 |     |- unimux-backend --host=ssh    (SSH shell cells on ssh2, bytes forwarded into the Rust pty engine)
 |     '- unimux-backend --host=exec   (short-lived `codex queue` calls)
```

- Rust <-> sidecar: stdio JSON-lines bridge (crate `unimux-bridge`, TS twin `src/backend/bridge.ts`). Request/response by id plus events both ways. First message is `config`: `{dataDir, appPaths, version, locale, platform, isPackaged, devFlags, wsPort?, windowTokens, systemProxy}`. Secrets are NOT passed in config: the sidecar's `safeStorage` shim calls Rust `secret_seal` / `secret_unseal` over the bridge (synchronous from the TS point of view is not required; the current callers are already async around decryption except SshVault eager decrypt, which becomes an awaited init step).
- Sidecar <-> renderer: one loopback WebSocket per window (`127.0.0.1:0`), token per window label, Origin check (`http://tauri.localhost` | `tauri://localhost`). Frames: JSON `{t:'i'|'r'|'s'|'e'}` for invoke/reply/send/event, binary sub-streams for sftp and db port messages. One socket per window keeps `ipcRenderer.send` ordering.
- Rust <-> renderer: `invoke` only for the new Rust commands (pty, blob, caption buttons); every existing channel, including notify/update/clipboard/dialog/shell, stays on the WS to the sidecar in 1.2.0 because its handler runs TS logic or the sender guard first, and the sidecar reaches the OS through bridge calls and `tauri::ipc::Channel<InvokeResponseBody::Raw>` for pty output.
- Sidecar crash: Rust shows Restart / Quit (translated). Restart re-spawns the sidecar; the renderer reconnects and gets `{full}` state. Terminals survive because the pty engine is in Rust; the sidecar re-adopts live terminals via `pty_list` (same as renderer adoption today).
- Rust panics in a session task: `tokio::spawn` + `JoinError::is_panic()` end only that terminal; the supervisor keeps the old counter (more than 5 crashes in 60 s = fatal, else restart after 500*2^(n-1) ms) and emits the unchanged `ptyhost:crashed` / `ptyhost:fatal` events. Native aborts (segfault in conpty.dll) cannot be caught; S6 must show none under the 50-iteration flood test.

### Later releases

Each subsystem moves into a Rust crate in-process on tokio; its channels flip from 'backend' to 'rust' in `src/shared/channelRoutes.ts`. The sidecar shrinks and is deleted in 1.6.0.

| Release | Moves to Rust | Removed npm deps |
|---|---|---|
| 1.2.0 | shell, windows, lifecycle, pty data plane, oscrypt, http_fetch, updater, transition | electron, electron-vite, electron-builder, electron-updater, node-pty |
| 1.3.0 | git, files, search, monitor, notes, changelog, hooks server, CLI detection, context, sessions, conversation search | hyparquet (if parquet crate used) |
| 1.4.0 | SSH core, vault, keys, SSH shell cells (russh), shell integration + spawn, SFTP | ssh2 |
| 1.5.0 | databases (PG/MySQL wire clients, Redis, SQLite, tunnels) | pg, pg-cursor, mysql2, ioredis |
| 1.6.0 | accounts, usage, GitHub, state core, MCP, automation, update coordinator; sidecar deleted | Node runtime, @modelcontextprotocol/sdk at runtime |

## 2. Rust workspace layout

```
src-tauri/
  Cargo.toml                    [workspace], resolver 3, [workspace.dependencies] pins,
                                profile.release lto="thin", codegen-units=1, strip=true, panic="unwind"
  tauri.conf.json               identifier com.unimux.app, productName unimux, mainBinaryName unimux, version 1.2.0
  tauri.macos.conf.json         identifier com.ajzakomator.app (keeps TCC grants; 1.1.x engine accepts it)
  capabilities/main.json        windows: main, detached-*  (mc commands, pty_*, window ops)
  capabilities/gate.json        window: update-gate (update_splash_* only)
  resources/conpty/{x64,arm64}/ conpty.dll + OpenConsole.exe 1.23.x
  resources/installer-hooks.nsh
  resources/backend/            unimux-backend SEA (no native addons once node-pty is gone; ssh2 runs without cpu-features)
  gen/messages.json             generated from src/shared/messages.ts (scripts/gen-messages.mjs), CI diff check
  crates/
    unimux-app/        bin: main.rs (legacy argv -> data dir -> instance lock -> crash log -> Builder),
                       windows/, lifecycle/, notify/, platform/{win,mac}.rs, updater/, bridge_host.rs,
                       commands/ (one file per domain), blob.rs, test_bridge.rs (feature "test-bridge", debug only)
    unimux-core/       pure, no Tauri: data_dir migration, atomic_write, json_file (.bak-<ISO>[-n]), crash.log,
                       startup timing, home dir (Node os.homedir semantics), utf16 helpers, i18n translate,
                       routing tables; grows with golden-tested ports (state in 1.6.0)
    unimux-bridge/     sidecar protocol types (serde camelCase)
    unimux-oscrypt/    Electron safeStorage compat, read + write
    unimux-pty/        ConPTY wrapper, Unix pty, OutputChannel/FlowGate/EchoClock/TailBuffer, batcher,
                       router, WindowRoutes, early-size LRU 200, binary frame codec
    unimux-net/        http_fetch (reqwest, proxy resolution incl. PAC/WPAD), exact header control
    -- added later --
    unimux-git, unimux-files, unimux-agents (1.3.0); unimux-ssh (1.4.0); unimux-db (1.5.0);
    unimux-accounts, unimux-mcp, unimux-update (1.6.0); unimux-hostd (test bin, 1.3.0)
src/backend/                    sidecar entry + electronShim/ (app, ipcMain->WS router, BrowserWindow proxy,
                                dialog, clipboard, shell, Notification, screen, powerMonitor, safeStorage,
                                net.fetch -> Rust http_fetch, utilityProcess -> child fork, MessageChannelMain -> WS stream)
src/renderer/src/bridge/mc.ts   window.mc implementation (replaces src/preload); api.d.ts stays the contract
src/shared/channelRoutes.ts     generated: each of the 215 channels -> 'backend' | 'rust'
scripts/build-backend.mjs       esbuild (alias electron -> electronShim) + SEA (sea-config + postject)
```

Version pins (checked with cargo search/info on 2026-11-06; crates.io and npm already list 3.0.0-alpha, never use it, CI greps Cargo.lock and package-lock.json for `3.0.0-alpha`):

- tauri 2.12.5, tauri-build 2.7.4, @tauri-apps/api and @tauri-apps/cli ~2.12.4
- plugins: dialog 2.8.4, clipboard-manager 2.5.0, opener 2.7.2, updater 2.14.1, process 2.4.0, notification 2.8.0 (permission prompt only), os 2.4.0
- tokio 1.54.1, serde 1.0.229, serde_json 1.0.154 (preserve_order, float_roundtrip), thiserror 2.0.21, parking_lot 0.13.0, uuid 1.29.0, sha2 0.11.1, base64 0.23.1
- windows 0.62.2, webview2-com 0.39.1, tauri-winrt-notification 0.8.1, objc2-* 0.3.2, security-framework 3.7.0
- aes-gcm 0.11.1, aes 0.9.4, cbc 0.2.1, pbkdf2 0.13.0, zeroize 1.9.1
- reqwest 0.13.5 (rustls, no gzip), junction 2.1.0, dunce 1.0.5, fs4 (instance lock), interprocess 2.x (second-instance socket), rusty-leveldb 4.0.2, process-wrap 10.0.1
- later: russh 0.65.1, russh-sftp 3.0.1, postgres-protocol 0.6.12, mysql_common 0.38.2, redis 1.8.1, rusqlite 0.41.1 (bundled, column_metadata), rustls 0.23.46 + tokio-rustls 0.26.6 (ring provider), axum 0.8.9, hyper 1.12.0, rmcp 3.9.0 (model types), fancy-regex 0.20.0, icu_collator 2.4.0, encoding_rs 0.8.44, trash 5.3.0

Node: Node 24 LTS for the SEA build (22.19 is installed locally; 24 needed).

## 3. The window.mc contract

`src/preload/api.d.ts` (319 lines) is the contract and changes only for `pathForFile` (see below) and the new Windows caption-button methods (`window.minimize/toggleMaximize/close/isMaximized` + `window:maximized` event, see section 5). The renderer has 540 `window.mc` references in 111 files; 245 methods map to 215 channels (177 invoke + 38 send channels; 207 of the methods are invoke-style because `db:pg` and `db:redis` multiplex) and 43 push events; 3 MessagePorts (pty, sftp, db).

`src/renderer/src/bridge/mc.ts`:

- Typed as `McApi`, so `tsc` fails on any missing method.
- Imported first in `main.tsx` and the detached entry, before any module reads `window.mc`.
- Sync values (`platform`, `windowsBuild`, window label, detached id, WS URL and token) come from `window.__MC_BOOT__`, injected by `WebviewWindowBuilder::initialization_script` in Rust (windowsBuild via RtlGetVersion; 26200 on the dev box).
- Per channel the generated table `channelRoutes.ts` says 'backend' (WS to sidecar) or 'rust' (`invoke(snake_case(ch), {args})`). Sends routed to Rust go through a per-window serial queue with sequence numbers, so ordering matches `ipcRenderer.send`.
- `on(ch, cb)` merges WS events and `listen()` events, returns a synchronous unsubscribe that also handles unsubscribe-before-listen-resolved, spreads positional args, normalizes `null -> undefined` where api.d.ts marks optional.
- Argument shaping from the preload is kept verbatim: reportError truncation 24/4000/8000, `listProjectDirectory` path `''`, ssh object wrapping, `db.history.clear` `stars === true`, `db.sqlite.create` `path ?? null`, `detach.attach` `overMain === true`, `getChangelog` `!!force`, `switchToBest` `{provider, to?}`, undefined optional keys omitted for pg/redis ops, redis subscribe target spread.
- Ports: the adapter posts fake MessagePort objects as `mc:pty-port` / `mc:sftp-port` / `mc:db-port`, so `TerminalManager.ts`, `sftp.ts`, `dbClient.ts` and `redisClient.ts` change minimally. pty is backed by `pty_attach(Channel)` + `pty_post(seq, msgs)`; sftp and db by WS binary sub-streams. Re-attached on load and after reload or sidecar restart (renderer-initiated handshake, never push-on-load).
- `pathForFile(file)` becomes async `pathsForFiles(files)`; 3 call sites change: `pathDrop.ts:77`, `FilePane.tsx:352`, `NewKeyEditor.tsx:81`.
- `window.__mc` (main.tsx:29) stays for CDP scripts.

Sender guard:

- WS: the token identifies the label; `ipcGuard.ts` rules apply in the sidecar unchanged (main or `detached-*`, `OPEN_IPC_CHANNELS`, per-channel fallbacks). A closed socket = renderer gone (feeds `quitConfirm.rendererGone` and sftp/db/localFiles `rendererGone`).
- Rust commands: every mutating command takes `webview: WebviewWindow` and calls `guard()` (label `main` or a registered `detached-<uuid>`, app origin). `OPEN_COMMANDS` mirrors `OPEN_IPC_CHANNELS`. A Rust test scans the generated command list so every command outside `OPEN_COMMANDS` calls `guard()`. Capabilities grant commands only to those labels; `gate.json` only `update_splash_*`.
- Ownership for hot paths (pty_post, pty_attach routes): Rust keeps a routing table `{cellWindow, alive, projectRoots}` pushed by the sidecar (`routing_update`), never a window field from JS.

Contract tests (from 1.2.0 on):

- parse `src/preload/index.ts` (until deleted; then a frozen copy `test/contract/preload-channels.json`): every channel has a route; every 'rust' route has a registered command (Rust-generated `commands.json`); every 'backend' route has an `ipcMain` registration in the sidecar bundle.
- event-name parity for the 43 events plus `window:shown`.
- `routeMessage` cases (BROADCAST_CHANNELS, CELL_CHANNELS, `automation:start-cells` split) shared as JSON fixtures between vitest and cargo.

Event routing stays in TS (`sendRouted`, `routeMessage`, `stateBroadcast` 16 ms coalescer, flush of `state:changed` before any other outgoing message). Rust-emitted events (`window:shown`, `ptyhost:*`, `notify:answer`, `update:state`) route through the same table: Rust asks the sidecar to `flush` before emitting a cell-scoped event.

## 4. State ownership

- 1.2.0 to 1.5.x: the sidecar's `StateController` is the single writer. `store.ts`, the saver, `atomicWriteFileSync` and `normalizeState` / `mergeStateEdit` / `diffState` are the same TS code, so state.json bytes are identical by construction. Rust holds a read mirror fed by bridge `state:patch` events (needed for window bounds and the routing table). Rust-owned subsystems mutate state only through named RPCs (`state.mutate {op, ...}`) that the sidecar applies inside `controller.change`.
- Session end: WM_QUERYENDSESSION / NSWorkspaceWillPowerOff -> Rust emits `session-ending` to the sidecar -> `markSessionEnding` + `saver.flush()` starts at once. WM_ENDSESSION only waits on a Rust condvar (cap 3 s) signalled when the flush finishes. The flush must have started on QUERYENDSESSION.
- 1.6.0: state ownership moves to Rust. `unimux-core::state` keeps AppState as `serde_json::Value` with `preserve_order` plus typed views (unknown keys kept), a JS-compatible number writer (whole floats as integers), and ports normalizeState with all normalizers, mergeStateEdit (JSON.stringify equality in insertion order, no resurrection, neighbour inserts, prototype keys skipped) and diffState (exact Patch shapes `{v}`, `{o,d}`, `{a}`, `{s:{drop,at,add}}`, `{full}` fallback), gated by the golden corpus. The StateController becomes an mpsc actor `{state: Arc<Value>, revision: u64}` with a `tokio::sync::watch<u64>` revision channel; edits are acknowledged in the same order as `state:changed`; subscribers (MCP wait_for) never hold the lock across an await. Saver: 500 ms debounce, compact JSON, temp `state.json.<pid>.<base36ms><counter>.tmp`, retries 1..30 s, hourly `.bak`, `flush_until_saved(3 s)`.
- The renderer keeps the TS `applyStateChange` and `pruneEdit` forever.

## 5. Multi-window

- Labels: `main` (index.html), `detached-<uuid>` (index.html?detached=<uuid>, registry in state.json `detachedWindows`), `update-gate` (440x200 frameless, `resources/update-splash`).
- `detachedWindows.ts` stays TS in the sidecar and drives Rust windows through a BrowserWindow proxy (create, setBounds, show/showInactive, focus, close, flash, setTitle, isFocused, getBounds from a mirror pushed on Moved/Resized/Focused). `screen` API: monitors in DIPs, primary, cursor point.
- Bounds: state.json keeps Electron DIPs; Rust converts with the monitor scale_factor. Normal (unmaximized) bounds are tracked in Rust from Moved/Resized while not maximized (no getNormalBounds in Tauri). Display ids become monitor name + position; a stale id falls back to the primary display.
- Main window: 1600x1000 (1100x700 offscreen), min 800x500, bg #0d0d0d. Created in code when the sidecar asks for it after the startup gate (`app.windows: []`). Hidden until the first page load finished or renderer-boot, with a 5 s fallback show (1.1.4 showed on ready-to-show, index.ts:961, which also triggers signalUpdateReady/markReady/clearGateFailureIfUpdated).
- Windows chrome: `decorations(false)`, React caption buttons in the existing 140 px titlebar reserve (new tr() keys in 6 languages), `SetWindowSubclass` WM_NCHITTEST returning HTMAXBUTTON for Windows 11 snap layouts, WebView2 `IsNonClientRegionSupportEnabled` so `-webkit-app-region: drag` works. macOS: `TitleBarStyle::Overlay`, traffic lights (12,10), detached (12,11).
- WebView2 settings on every UI webview (via `with_webview` + webview2-com): default context menus off, browser accelerator keys off (Ctrl+R/F5/P/F reach the app), zoom control off, spellcheck off, devtools only in debug. Navigation to non-app URLs denied; http(s) opened externally.
- WebView2 browser args, identical for every webview sharing the data folder (a mismatch fails with 0x8007139F):
  `--max-active-webgl-contexts=96 --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --autoplay-policy=no-user-gesture-required --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion`, plus `--remote-debugging-port=N` only in debug or test-bridge builds.
- Renderer crash/hang: WebView2 `ProcessFailed` (webview2-com), WKWebView `webViewWebContentProcessDidTerminate` (objc2), plus a 2 s renderer heartbeat with 10 s grace; they feed the unchanged `createReloadLimiter` (3 per 60 s) and Wait/Reload dialogs in the sidecar.
- `MC_OFFSCREEN` (debug builds only): position (-6000, 0), skip_taskbar, focusable(false), never `set_focus` / `request_user_attention`.

## 6. Data dir and state.json compatibility

- `main()` resolves DATA_DIR before `tauri::Builder`: `dirs::data_dir()/unimux` (Windows `%APPDATA%\unimux`, macOS `~/Library/Application Support/unimux`), `MC_DATA_DIR` only in debug/test builds. Tauri's `app_data_dir()` (identifier-based) is never used; DATA_DIR is passed explicitly.
- `migrateDataDir` is ported 1:1 to `unimux-core` (ajzakomator -> unimux rename, junction via `junction` 2.1 or symlink, `migrated-from.json {from, at}`, busy case via `update/work/heartbeat`, `unimux.pre-migration-<stamp>`, re-create a missing legacy link), plus the one-time `MultiCoding/state.json` copy. Cases ported from `test/data-dir-migration.test.ts`.
- Home dir follows Node `os.homedir()` semantics (USERPROFILE, then HOME), because `dirs::home_dir` and Tauri path APIs ignore env overrides and the scratch-home tests would otherwise touch the real `~/.claude`, `~/.codex`. CLAUDE_CONFIG_DIR and CODEX_HOME honoured as today.
- Every file keeps its name and format (written by the same TS in 1.2.0): state.json (+ `.bak`, `.bak-<ISO>[-n]`), crash.log/crash.old.log, startup.log, update-gate.json, limit-alerts.json, usage-cache.json, refresh-limits.json, auto-switch.json, accounts/, codex-accounts/, git-trust.json, ssh/*.json, db/*.json, github/token.json, note-images/, hooks/, mcp/, prompts/, claude-hook-fallback.json, changelog.json, conversation-index.bin.
- Electron Chromium files (`Local State`, `Local Storage`, caches) are never modified or deleted in 1.2.0. WebView2 data folder: `DATA_DIR/webview2`. WKWebView: default store.
- localStorage: origin changes from `file://` to `http://tauri.localhost` / `tauri://localhost`. On first start Rust reads `DATA_DIR/Local Storage/leveldb` (rusty-leveldb; keys `_file://\x00\x01<key>`, values prefixed 0x00 UTF-16LE or 0x01 Latin-1) and injects the entries via the boot script on the first load; marker `DATA_DIR/webview-import.json`. Covers unsaved file drafts, detached drafts, Redis console history, DB tree, panel sizes, Git panel layouts.
- Instance lock: fs4 exclusive lock on `DATA_DIR/instance.lock` plus an interprocess local socket for second-instance focus / relaunchRequested. Keyed by data dir, so parallel `MC_DATA_DIR` dev runs coexist. On packaged Windows, `updateInstalling(START_BLOCK_MS=90 s)` refuses the start.
- Downgrade to 1.1.4 stays possible: no format change, same secret format; conversation-index (when ported in 1.3.0) uses a new file `conversation-index-v2.bin` and leaves the old one.

## 7. Secrets migration (Electron safeStorage)

No re-encryption. `unimux-oscrypt` implements Chromium OSCrypt 'v10' read and write:

- Windows: `DATA_DIR/Local State` JSON `os_crypt.encrypted_key` -> base64 -> strip `DPAPI` prefix -> `CryptUnprotectData` (user scope) -> 32-byte key. Blob = `v10` + nonce12 + ciphertext + tag16, AES-256-GCM. Encrypt the same way with a random nonce.
- macOS: Keychain generic password service `unimux Safe Storage` (account expected `unimux Key`; exact names and ajzakomator/MultiCoding fallbacks confirmed in spike S3 on a real Mac), PBKDF2-HMAC-SHA1(password, `saltysalt`, 1003, 16) -> AES-128-CBC, IV 16 spaces, PKCS7, `v10` prefix.
- S3 must confirm Electron 45 safeStorage is still sync OSCrypt 'v10', not app-bound 'v20'.
- Rules: never create a key while `Local State` exists; never rewrite `Local State`; if `Local State` is missing (fresh install), create it in Chromium format; storage labels `dpapi|keychain|unavailable`; `MC_SSH_NO_SAFESTORAGE=1` (debug) forces unavailable (memory-only secrets); a blob that does not decrypt shows as locked and a file with locked entries is never rewritten (existing SshVault/DbVault/GithubTokenStore rules); decrypted material in `Zeroizing`.
- Users: `ssh/vault.json` (keys, passwords, identityPasswords), `db/vault.json`, `github/token.json`.
- 1.2.0 wiring: the sidecar's `safeStorage` shim calls `secret_seal` / `secret_unseal` over the bridge. The key never leaves Rust.
- macOS: the re-signed (ad-hoc) binary triggers one Keychain "Always Allow" prompt. Documented in the release note.

## 8. Update path from Electron 1.1.x to Tauri 1.2.0

### Windows

1.1.4's electron-updater reads `latest.yml` and runs `unimux-Setup-1.2.0.exe --updated /S --force-run`. That file is the Tauri NSIS installer (`installMode currentUser`, `mainBinaryName unimux`, identifier `com.unimux.app`, languages pl/en/de/es/fr/pt) with `installer-hooks.nsh`:

- NSIS_HOOK_PREINSTALL:
  1. Read `HKCU\Software\214279c4-b798-5d4e-848f-0b9245114cd1` `InstallLocation`; if present and the Tauri key `HKCU\Software\unimux\unimux` is absent, set `$INSTDIR` to it (default `%LOCALAPPDATA%\Programs\unimux` or the user's custom dir). Keeps pins, exe path and the 1.1.x splash `appExe`.
  2. Wait up to 30 s for old `unimux.exe` processes to exit (nsis_tauri_utils FindProcess loop) BEFORE Tauri's CheckIfAppIsRunning RmForceShutdown, so the Electron wind-down saves state.
  3. `SetOutPath $TEMP`, copy `Uninstall unimux.exe` to `$PLUGINSDIR\old-uninstaller.exe`, run `/S /KEEP_APP_DATA /currentuser --keep-shortcuts --updated _?=<oldDir>`. Fallback: delete `Uninstall\214279c4-...` and `Software\214279c4-...` keys and the Electron files by hand. Then `SetOutPath $INSTDIR`.
- NSIS_HOOK_POSTINSTALL:
  1. When `--updated`, write `installer-done` (content `${VERSION}`) to `$APPDATA\ajzakomator\update` if it exists, else `$APPDATA\unimux\update` (port of `resources/installer.nsh`).
  2. Re-stamp AUMID `com.unimux.app` on Start menu, desktop and `User Pinned\TaskBar\unimux.lnk`.
  3. If `--force-run` is in `$CMDLINE`, launch via `RunAsUser "$INSTDIR\unimux.exe"` (Tauri relaunches only with /R).
- A forked NSIS template (`bundle.windows.nsis.template`, from tauri-bundler 2.10.4) only if hooks cannot redirect `$INSTDIR` early enough (decided in S4).
- New app `main()`, before anything else:
  - `ELECTRON_RUN_AS_NODE=1` + `-e <script>`: the 1.1.x splash's cleanup call. Sleep 3 s, remove `<data>/update/runtime`, exit 0 without a window and without single-instance forwarding.
  - `installInProgress` / START_BLOCK_MS refusal.
  - `signalUpdateReady`: write `<data>/update/ready` when `work/config.json` names the running version (the 1.1.x splash then reaches 'done'), then wait up to 4 s for its heartbeat to go stale.
  - `clearGateFailureIfUpdated` on update-gate.json.
  - Remove `%LOCALAPPDATA%\unimux-updater`; remove `<data>/update` 30 s after start (scheduleUpdateCleanup rules).
  - `SetCurrentProcessExplicitAppUserModelID('com.unimux.app')` (`.dev` when not packaged).

Optional: `stagingPercentage` in latest.yml for a gradual Windows rollout.

### macOS

The 1.1.4 custom engine reads `releases/latest/download/latest-mac.yml` and downloads `unimux-1.2.0-mac-<arch>.zip`. Requirements: `ditto -c -k --keepParent`, exactly one `.app`, `CFBundleShortVersionString` 1.2.0, `CFBundleIdentifier` `com.ajzakomator.app`, executable `unimux` with the exec bit, `codesign --verify --deep --strict` passing for the ad-hoc signature with the SEA sidecar inside. The 1.1.4 install script swaps the bundle; the new app ports `finishPrevious` / `markReady` (writes `updates/mac/ready` within 30 s, deletes `pending.json`, cleans `.old-*` / `.new-*` siblings and staged zips).

### Tauri -> Tauri (from 1.2.0)

- The TS `UpdateCoordinator` and `startupGate` stay in the sidecar with a new 'tauri' backend over the bridge (check, download with progress and cancel, install). Endpoint `https://github.com/daven-team/unimux/releases/latest/download/latest.json`, minisign pubkey in tauri.conf.json, `Cache-Control: no-cache`, 90 s timeout, version comparator matching `compareVersions`.
- `install()` exits the process at once, so the full wind-down (pty kill, `flushUntilSaved`, MCP and hooks stop, account-swap waits) runs BEFORE install; `updateHandoverCommitted` set first.
- Windows `installMode: 'passive'` (NSIS progress window) replaces the copied Electron splash runtime: `updateRuntime.ts`, `updateSplash.ts`, `src/updatesplash` and the electron-updater code are deleted in 1.2.0, but the `update/ready`, `installer-done`, `-e` legacy entry points stay forever. The startup gate window (`update-gate`) and its flow are kept. (One judge preferred a Rust detached splash `--update-config` mode; it can be added later without format changes.)
- macOS: keep `evaluateInstallTarget` / `probeBundleWrite` refusals (translocated, read-only, not-owner, app-management -> download page) before the plugin's bundle swap.

### Release assets, every release from now on

`latest.yml` + `unimux-Setup-X.exe` (for Windows clients still on Electron), `latest-mac.yml` + ditto zips + dmgs (macOS clients still on Electron), `latest.json` + `.sig` + `unimux-X-mac-<arch>.app.tar.gz` (Tauri clients), `SHA256SUMS.txt`. 1.2.0 is published as latest, never as a prerelease. Signing key `TAURI_SIGNING_PRIVATE_KEY` must never be lost.

Fallback if S4 or S5 fail: Electron bridge release 1.1.5 whose splash and macOS engine know about Tauri.

## 9. macOS vs Windows

| Area | Windows (WebView2) | macOS (WKWebView) |
|---|---|---|
| Title bar | decorations(false) + React caption buttons + WM_NCHITTEST snap layouts + IsNonClientRegionSupportEnabled | Overlay, traffic lights (12,10) / (12,11) |
| PTY | ConPTY via sideloaded conpty.dll + OpenConsole.exe 1.23, Job Object per terminal, ClosePseudoConsole off-thread while draining, timeBeginPeriod(1) while terminals are active | openpty + setsid + TIOCSCTTY, zsh/bash `-il`, killpg SIGHUP then SIGKILL |
| WebGL | 96 contexts via browser args, renderer pool 64 | WebKit caps about 16 per page: `MAX_WEBGL_CONTEXTS` about 12, WebglLimit learning, DOM renderer fallback |
| Background | throttling flags; verify wry IsVisible(false) on minimize does not stop the 400 ms tick (else move it to Rust) | `backgroundThrottling: 'disabled'` (macOS 14+), App Nap off via NSProcessInfo activity |
| OS file drop | dragDropEnabled(false) + `chrome.webview.postMessageWithAdditionalObjects` -> ICoreWebView2File.Path (HTML5 DnD keeps working) | native DragDropEvent routed by `elementFromPoint` |
| Notifications with buttons | tauri-winrt-notification, AUMID com.unimux.app | UNUserNotificationCenter categories (objc2); verify with ad-hoc signing |
| Badge / attention | request_user_attention | NSDockTile badge |
| Session end | HWND subclass WM_QUERYENDSESSION / WM_ENDSESSION | NSWorkspaceWillPowerOffNotification |
| Renderer crash | ProcessFailed + heartbeat | webContentProcessDidTerminate + heartbeat |
| Secrets | DPAPI Local State key | Keychain, one re-approval prompt |
| Keys | no app menu | tauri::menu app + edit (no reload/close); verify Cmd+V does not double paste; text substitutions off; requestIdleCallback, randomUUID, AudioContext resume polyfills |
| Dev automation | CDP via `--remote-debugging-port` | no CDP: debug-only eval bridge; sidecar `--inspect` |
| Updater | NSIS hooks + plugin passive | ditto zip for 1.1.x, plugin bundle swap later |

Fonts: terminal stack `"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, Menlo, "SF Mono", "Courier New", monospace`.

## 10. Testing strategy

1. **vitest stays** for the renderer, src/shared and i18n (104 shared-only files, 1,489 tests, plus renderer files). In 1.2.0 the main-side vitest suites (about 1,815 tests) also keep running, because src/main is still TS; the 3 `vi.mock('electron')` suites mock the shim. New vitest: bridge argument shaping, send ordering (1,000 interleaved sends), unsubscribe-before-listen, contract test, routeMessage fixtures.
2. **cargo** on windows-latest and macos-latest: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --workspace`. 1.2.0 Rust tests: data-dir migration, atomic write, crash log, startup timing, oscrypt fixtures, pty flow/output/tail/echo/router (ported from flow, output-channel, pty-flow, host-router, replay-sizes, pty-kill-tree, pty-shell-path), ConPTY integration (echo, 50 MB flood pause/resume, output after exit, tree kill, 30 parallel kills, killAll 30 in 3 s), http_fetch header assertions on a mock server, guard scan.
3. **Golden corpus** (`scripts/dump-goldens.mjs` -> `test/golden/*.jsonl`, `crates/unimux-core/tests/golden.rs`, insta/similar diffs; CI regenerates and fails on diff) and **`test/PORTING.md`** (it() -> #[test] map with a counter) exist before any business-logic port. Every port in 1.3.0 to 1.6.0 is gated by both.
4. **Dual host + `unimux-hostd`** (1.3.0): `test/helpers/nodeHost.ts` and a Rust stdio test binary, so `.int` suites (ptyhost.int, ssh.int, sftp-host.int, db-*.int, db-tunnel.int) and the Node fake servers (pgFakeServer, mysqlFakeServer, respServer, sshServer, pglite-socket) drive the Rust code unchanged.
5. **Real-app checks over WebView2 CDP**: `scripts/app-env.mjs appBinary()` and `ssh-ui-lib.mjs launchApp` start the Tauri exe with `MC_DATA_DIR`, `MC_OFFSCREEN=1`, `MC_DEBUG_PORT` and a scratch USERPROFILE/HOME/APPDATA/LOCALAPPDATA; target filter `http://tauri.localhost/index.html` without `?detached=`; `Browser.close` replaced by process-tree kill incl. `msedgewebview2.exe`. `mainInspector()` (12 scripts) attaches to the sidecar `--inspect` (`MC_BACKEND_INSPECT`, debug only) where `require('electron')` is the shim; Rust-side hooks via a `test-bridge` cargo feature (debug only, CI asserts it is off in release). All 44 `verify-*.mjs` must pass; `verify-cli-contract` and `verify-team-start` are release gates.
6. **Isolation test**: real `%APPDATA%\unimux`, `~/.claude`, `~/.codex` and `%LOCALAPPDATA%\com.unimux.app` unchanged after a run (hash snapshot).
7. **Upgrade tests**: copy of a 1.1.4 data dir with secret fixtures (state, accounts, ssh/db vault, github token, drafts, detached windows): loads unchanged, no-op edit gives byte-identical state.json, secrets decrypt both ways, drafts imported, restart with existing saved data; Windows VM 1.1.4 -> 1.2.0 installer hand-over (default and custom dir, taskbar pin); macOS harness running the v1.1.4 MacUpdater against the Tauri zip.
8. **Performance vs 1.1.4**: perf-latency (keystroke echo), bench-jank and perf-grid (20 busy cells), perf-hidden (minimized 60 s), measure-startup, idle CPU and RSS of unimux.exe + msedgewebview2.exe + unimux-backend.
9. **smoke-start**: installed exe without console and std handles, plus the `ELECTRON_RUN_AS_NODE=1 unimux.exe -e ...` call (exit 0, no window).
10. **macOS**: build in CI; Keychain, notifications, keyboard, WebGL and updater transition checked manually on a real Mac plus a smoke subset through the eval bridge.

## 11. Build flavours, CSP, OS integrations (added by the critic review)

### Build flavours

1.1.4 gates every run/debug override on `!app.isPackaged` (index.ts:173 `devEnv`), and real-app checks run an optimized but unpackaged build. A Tauri debug build is not comparable for performance, so:

| Flavour | How | isPackaged | MC_* overrides, CDP port, test-bridge | Used for |
|---|---|---|---|---|
| dev | `tauri dev` (debug) | false | yes | development |
| check | `tauri build --features dev-overrides` (release profile, no bundle, no updater) | false | yes | verify-*.mjs, perf, capture-readme |
| release | `tauri build` in CI | true | no (CI asserts the feature is off and `--remote-debugging-port` absent) | installers |

"Debug builds only" elsewhere in this spec means dev + check. The shim's `app.isPackaged` and the Rust `MC_DATA_DIR` / `MC_OFFSCREEN` / `MC_DEBUG_PORT` handling follow this table. The overrides read by the sidecar unchanged: MC_HOOK_DEBUG, MC_SSH_DEBUG, MC_SSH_NO_SAFESTORAGE, MC_TRASH_DIR, MC_DB_EXPORT_DIR, MC_NOTES_EXPORT_DIR, MC_CLI_NO_REGISTRY, MC_CLI_PROBE_PROFILE, MC_INSTALL_COMMAND_OVERRIDE, MC_USAGE_CLAUDE_URL, MC_USAGE_CODEX_URL, MC_USAGE_CLAUDE_TOKEN_URL, MC_UPDATE_FEED (Rust passes the environment through to the sidecar). MC_CELL_ID is the per-terminal env var, not an override.

### CSP

src/renderer/index.html has a meta CSP `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; script-src 'self'`. A meta CSP is enforced in addition to any Tauri-injected one, so as-is it blocks the WS to `ws://127.0.0.1:<port>`, the Tauri IPC custom protocol (Tauri then falls back to slower postMessage IPC) and `unimux-blob` fetches. 1.2.0 moves the policy to `app.security.csp` in tauri.conf.json (Tauri adds the `ipc:` / `http://ipc.localhost` sources) with `connect-src 'self' ipc: http://ipc.localhost ws://127.0.0.1:*` and `unimux-blob:` / `http://unimux-blob.localhost` in img-src, media-src and connect-src, and removes the meta tag. Custom scheme URLs differ per OS: `http://unimux-blob.localhost/<token>` on Windows (WebView2), `unimux-blob://localhost/<token>` on macOS; the renderer builds them through a `convertFileSrc`-style helper, never a hard-coded string. resources/update-splash/index.html keeps its own stricter meta CSP (no WS needed).

### OS integrations: inventory

Used by 1.1.4 and covered: single instance (+ relaunch while quitting, index.ts:1984), AUMID, taskbar flash / Dock bounce (attention:flash), Dock badge, Dock icon in dev (appIcon.ts), toasts with buttons, system beep, save/open dialogs, clipboard incl. secret, shell openExternal/openPath/showItemInFolder/trashItem, open in Cursor/VS Code (detached spawn), session end (query-session-end, session-end, powerMonitor 'shutdown'), renderer crash and unresponsive, macOS app + edit menu, getAppMetrics (Monitor panel; Rust must report WebView2 processes via ICoreWebView2Environment.GetProcessInfos and the sidecar tree), screen API for detached placement, crash.log, startup.log.

Not used by 1.1.4 (verified by grep on 2026-11-06), so NOT added in 1.2.0: tray icon, global shortcuts, deep links / protocol handlers (`setAsDefaultProtocolClient`, `open-url`), file associations (`open-file`), login item / autostart, jump lists / thumbar buttons / overlay icon / taskbar progress, power-save blocker, nativeTheme, crashReporter (no minidumps; crash.log only). Tauri plugins for these (single-instance, deep-link, window-state, global-shortcut, autostart) are not needed; tauri-plugin-single-instance is deliberately not used because it is keyed by the identifier, not the data dir.

### Cross-generation instance check

Electron 1.1.x's ProcessSingleton does not see the fs4 lock. While a 1.1.x process owns the same data dir (hand-over wind-down, a second install, a downgrade test), 1.2.0 must refuse to start (and 1.1.4 cannot see 1.2.0, so the NSIS hook's 30 s wait stays). Windows: a message-only window of class `Chrome_MessageWindow` titled with the user-data dir; macOS: `SingletonLock` symlink `<hostname>-<pid>` in DATA_DIR with a live pid.

### Process tree rules

- The sidecar and every `--host=` child exit on stdin/IPC EOF (macOS has no Job Object; an orphaned sidecar would keep the MCP and hook ports).
- The sidecar's Job Object allows breakaway; detached launches (editors) use CREATE_BREAKAWAY_FROM_JOB through a Rust command, else they die with the app.
- crash.log has one writer (Rust); the sidecar forwards log lines over the bridge.

## Critic review (2026-11-06)

Changes made in this file:

1. Section 1: Rust `invoke` is used only for new commands; all existing channels stay on the sidecar WS in 1.2.0 (the old list sent notify/update/clipboard/dialog to Rust, bypassing their TS handlers).
2. Section 3: corrected channel numbers (177 invoke + 38 send channels = 215; 207 invoke-style methods) and recorded the api.d.ts additions for the Windows caption buttons.
3. Section 5: the main window is created after the startup gate on the sidecar's request, with a 5 s show fallback; 1.1.4 shows it on ready-to-show, not on renderer-boot.
4. New section 11: build flavours (`dev-overrides`), CSP rewrite (the existing meta CSP blocks the WS, Tauri IPC and the blob protocol), per-OS custom scheme URLs, the full list of OS integrations used and explicitly not used (no tray, global shortcuts, deep links, autostart, jump lists), Electron/Tauri cross-generation instance check, process tree rules (EOF exit, Job breakaway, single crash.log writer), WebView2 process reporting for the Monitor panel.
