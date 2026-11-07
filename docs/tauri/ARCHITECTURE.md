# unimux 1.2.0 on Tauri 2: architecture

Status: migration spec. First written 2026-11-06 from three competing designs and three judge reports; rewritten the same day for the user's ALL-AT-ONCE decision (see PROGRESS.md decision log).

## 0. Decision summary

Three designs were judged:

| Design | Idea | Judge totals | Effort |
|---|---|---|---|
| 1. Full Rust backend | Everything in src/main and the 4 utility hosts becomes Rust crates in one Tauri process | 5.3, 4.9, 7.4 | about 256 agent-days before the first release |
| 2. Rust OS layer + hidden TS service webview "svc" | src/main runs inside a hidden webview, hot paths in Rust | 6.0, 6.1, 5.3 | about 150 + 35 agent-days |
| 3. Staged strangler | 1.2.0 = Tauri 2 shell + Node SEA sidecar running src/main; subsystems ported to Rust in 1.3.0 to 1.6.0 | 7.3, 7.6, 6.3 | about 70 agent-days to 1.2.0, 278 total |

The judges preferred design 3, but the user decided on 2026-11-06: **1.2.0 ships only when the whole app is Rust + Tauri v2 with full parity, no Node sidecar in the shipped app** (Node stays a build tool for the React UI, vitest and scripts). This spec is therefore **design 1 (full Rust backend)** with the grafts from the judged designs that do not depend on a sidecar:

- Terminal data plane in Rust (ConPTY with sideloaded conpty.dll + OpenConsole.exe, Job Objects, FlowGate/TailBuffer/OutputChannel, binary frames posted as WebView2 shared buffers on Windows, decided in SP1; `tauri::ipc::Channel` only for low-rate traffic).
- `unimux-oscrypt` reads AND writes the Chromium 'v10' format, so 1.1.4 can still read files written by 1.2.0 (downgrade safety).
- Rust `http_fetch` (reqwest with system proxy incl. PAC/WPAD) for every network call that used Chromium networking.
- Golden corpus + `test/PORTING.md` before the first port of business logic; every port is gated by both.
- Generated IPC contract from `src/preload/api.d.ts` with a typed "not yet" error, so the real UI runs from wave 0 and the contract counter shows progress.
- `unimux-hostd` stdio test binary so the existing Node `.int` suites and fake servers drive the Rust code.
- Session-end flush starts on WM_QUERYENDSESSION, not WM_ENDSESSION.
- StateController actor with a revision watch, owned by Rust from the first wave.

Further user decisions that shape this spec: Windows caption buttons are drawn to look exactly like today (section 5); the custom update window (progress, stages, restart) is kept for Tauri -> Tauri updates too (section 8); latest.yml / latest-mac.yml keep being published so Electron 1.1.x installs update into 1.2.0 (section 8).

## 1. Process model

```
unimux.exe (Rust, tauri 2.12.5, windows_subsystem = "windows", panic = "unwind")
 |- tao/wry event loop, windows, WebView2/WKWebView glue, HWND subclass (session end, NCHITTEST, minimize)
 |- tokio runtime (one process, one actor per subsystem):
 |    state (StateController, saver), ipc router + event routing
 |    pty service (ConPTY / openpty, output engine, Channel data plane)
 |    hooks server (axum), MCP server (custom hyper/axum dispatcher, SP8), automation
 |    git, files, search, monitor, notes, changelog
 |    cli detect/install, context tracker, sessions, conversation search
 |    ssh (russh), sftp, db (postgres-protocol, mysql_common, own RESP2, rusqlite)
 |    accounts, logins, usage, auto-switch, limit alerts, github
 |    oscrypt, http_fetch, notifications, update coordinator
 |- WebView2 / WKWebView: "main", "detached-<uuid>", "update-gate"
 '- children: shells and agent CLIs in ConPTY / pty (Job Object per terminal), git, CLI probes,
    editors (spawn_detached, breakaway), installers

unimux-update.exe --update-window <config>   (same binary, copied to %LOCALAPPDATA%\unimux-updater\runtime-<ver>\
                                        as unimux-update.exe, own WebView2 folder, label "update-window"; section 8)
```

- No Node at runtime. The two workers that 1.1.4 evaluated from disk (convsearch, sqliteworker) become Rust threads; the `--host=pty|sftp|db|exec` forks become tokio tasks or threads.
- Crash isolation inside one process: every session (terminal, SSH, SFTP, DB) runs in its own task; `JoinError::is_panic()` ends only that session and emits the existing crash events (`ptyhost:crashed` / `ptyhost:fatal`, `db:hostCrashed`, `sftp:hostCrashed`) with the old counters (more than 5 crashes in 60 s = fatal, else restart after 500*2^(n-1) ms). FFI code that can abort (conpty.dll, SQLite) is covered by SP5 / D11 flood and interrupt tests. Blocking FS work (offline shares) runs on `spawn_blocking` with timeouts, never on the event loop.
- `crash.log` has one writer (unimux-app). The update window logs to `update/updater.log` as today.

## 2. Rust workspace layout

```
src-tauri/
  Cargo.toml                    [workspace], resolver 3, [workspace.dependencies] pins,
                                profile.release lto="thin", codegen-units=1, strip=true, panic="unwind"
                                features: dev-overrides (= Electron !app.isPackaged), test-bridge (debug commands)
  tauri.conf.json               identifier com.unimux.app, productName unimux, mainBinaryName unimux, version 1.2.0,
                                app.windows [], security.csp, bundle nsis/app/dmg
  tauri.macos.conf.json         identifier com.ajzakomator.app (keeps TCC grants; 1.1.x engine accepts it)
  capabilities/main.json        main, detached-*: mc_invoke, mc_send, mc_invoke_raw, attach commands, window_*, event listen
  capabilities/gate.json        update-gate: update_splash_* only
  capabilities/update-window.json  update-window: update_splash_* only
  resources/conpty/x64/         conpty.dll + OpenConsole.exe 1.23.x (arm64 not built)
  resources/installer-hooks.nsh
  gen/ipc-contract.json         generated from src/preload/api.d.ts (scripts/gen-ipc-contract.mjs), CI drift check
  gen/messages.json             generated from src/shared/messages.ts (scripts/gen-messages.mjs), CI drift check
  crates/
    unimux-app/       bin: main.rs (legacy argv -> data dir -> instance lock -> crash log -> gate -> Builder),
                      windows/ (main, detached, gate, caption, webview2 settings), lifecycle/, commands/<domain>.rs
                      (one file per domain, pre-created), update_window.rs (--update-window mode), test_bridge.rs
    unimux-core/      pure: data_dir migration, atomic_write, json_file (.bak-<ISO>[-n]), crash.log, startup timing,
                      home dir (Node os.homedir semantics), utf16 helpers, i18n translate, golden harness
    unimux-ipc/       contract types, Router, IpcError (NotYet), guard(), OPEN_COMMANDS, emit + routing (routeMessage)
    unimux-state/     AppState (serde_json::Value preserve_order + typed views), normalize, merge, diff,
                      StateController actor, saver, broadcaster
    unimux-platform/  win.rs / mac.rs: AUMID, subclass, session end, notifications, badge, clipboard secret,
                      file drop, localStorage import, single instance (incl. Electron singleton compat)
    unimux-exec/      process spawn, Job Objects / process groups, cleanEnv, kill tree, spawn_detached
    unimux-pty/       ConPTY wrapper, Unix pty, OutputChannel/FlowGate/EchoClock/TailBuffer, batcher, router,
                      shell integration, launch line, cell spawn, install manager
    unimux-net/       http_fetch (reqwest, proxy resolution incl. PAC/WPAD), exact header control
    unimux-oscrypt/   Electron safeStorage compat, read + write
    unimux-git/       runner, caches, parsers, trust, mutations, worktrees, GitHub publish
    unimux-files/     listing, preview, save, file ops, search/replace, notes, fs probes, monitor, changelog
    unimux-agents/    hook server, Claude/Codex settings, CLI detector, context, sessions, conversation search, delivery
    unimux-mcp/       MCP HTTP server, tools, automation, wait_for, team prompts
    unimux-ssh/       vault, known hosts, keys, russh login core, coordinator, command history
    unimux-sftp/      service, sides, queue, manage ops, sudo over exec
    unimux-db/        service, vault, history, PG / MySQL / Redis / SQLite sessions, tunnels, result routing
    unimux-accounts/  stores, locks, activation/swap, reconcile/refresh, logins, usage, auto-switch, limit alerts, github token
    unimux-update/    coordinator, startup gate flow, feed + minisign verify, progress model, Windows/macOS install
    unimux-hostd/     test bin: stdio host so Node .int suites and fake servers drive Rust code
src/renderer/src/bridge/mc.ts   window.mc implementation (generated part + hand part); api.d.ts stays the contract
vite.config.ts                  plain Vite for the renderer (replaces electron.vite.config.ts at R1)
```

Version pins (checked with cargo search/info on 2026-11-06; crates.io and npm already list 3.0.0-alpha, never use it, CI greps Cargo.lock and package-lock.json for `3.0.0-alpha`):

- tauri 2.12.5, tauri-build 2.7.4, @tauri-apps/api and @tauri-apps/cli ~2.12.4
- plugins: dialog 2.8.4, clipboard-manager 2.5.0, opener 2.7.2, process 2.4.0, notification 2.8.0 (permission prompt only), os 2.4.0. tauri-plugin-updater is not used for installing (section 8); single-instance, window-state, deep-link, global-shortcut, autostart are not used.
- tokio 1.54.1, serde 1.0.229, serde_json 1.0.154 (preserve_order, float_roundtrip), thiserror 2.0.21, parking_lot 0.13.0, uuid 1.29.0, sha2 0.11.1, base64 0.23.1
- windows 0.62.2, webview2-com 0.39.1, tauri-winrt-notification 0.8.1, objc2-* 0.3.2, security-framework 3.7.0
- aes-gcm 0.11.1, aes 0.9.4, cbc 0.2.1, pbkdf2 0.13.0, zeroize 1.9.1
- reqwest 0.13.5 (rustls, no gzip), junction 2.1.0, dunce 1.0.5, fs4 (instance lock), interprocess 2.x (second-instance socket), rusty-leveldb 4.0.2, process-wrap 10.0.1
- russh 0.65.1 (SP7: `default-features = false, features = ["ring", "rsa", "flate2"]`, the same ring backend as rustls, no aws-lc-sys) with its pinned ssh-key =0.7.0-rc.11 plus feature `tdes`; legacy encrypted PEM through aes 0.9.4 / cbc 0.2.1 / ctr 0.10.1 / des 0.9.0 / blowfish 0.10.0 / md5 0.8.1 (own code, S2); the client offers exactly the 1.1.4 algorithm list (ssh2 1.17 defaults under Electron 45), see docs/tauri/spikes/SP7.md
- russh-sftp 3.0.1, postgres-protocol 0.6.12, mysql_common 0.38.2, redis 1.8.1, rusqlite 0.41.1 (bundled, column_metadata), rustls 0.23.46 + tokio-rustls 0.26.6 (ring provider), axum 0.8.9, hyper 1.12.0, rmcp 3.9.0 (decided in SP8), fancy-regex 0.20.0, icu_collator 2.4.0, encoding_rs 0.8.44, trash 5.3.0

- russh 0.65.1, russh-sftp 3.0.1, postgres-protocol 0.6.12, mysql_common 0.38.2, redis 1.8.1, rusqlite 0.41.1 (bundled, column_metadata), rustls 0.23.46 + tokio-rustls 0.26.6 (ring provider), axum 0.8.9, hyper 1.12.0 + hyper-util 0.1.21, http-body-util 0.1.5, tokio-util 0.7.20 (the MCP server is a custom dispatcher on hyper/axum, decided in SP8; rmcp is not used, see spikes/SP8.md), fancy-regex 0.20.0, icu_collator 2.4.0, encoding_rs 0.8.44, trash 5.3.0

- russh 0.65.1, russh-sftp 3.0.1, postgres-protocol 0.6.12 (with an own frame layer for BackendKeyData 3.2, NegotiateProtocolVersion and lossy strings, SP9), mysql_common 0.38.2 (default features off, flate2 `rust_backend`; own framing, COM_QUERY and column parser, SP9), Redis through an own RESP2 client (the redis crate was measured in SP9 and dropped: non-UTF-8 status lines end its connection, 500 ms default timeout), rusqlite 0.41.1 (bundled, column_metadata), rustls 0.23.46 + tokio-rustls 0.26.6 (ring provider), axum 0.8.9, hyper 1.12.0, rmcp 3.9.0 (decided in SP8), fancy-regex 0.20.0, icu_collator 2.4.0, encoding_rs 0.8.44, trash 5.3.0
- minisign-verify, tar + flate2 (macOS .app.tar.gz), memchr: versions pinned in F1 with cargo info
- conversation search (H5): memchr 2.8.3, indexmap 2.14.2, unicode-normalization 0.1.26 (NFD for the fold table), rayon-core 1.13.0 (the pass workers kept between passes)

Node: Node 26 LTS is installed and used only to build the renderer (Vite), run vitest, generators and the real-app scripts.

## 3. The window.mc contract

`src/preload/api.d.ts` (319 lines) is the contract. It changes only for `pathForFile` -> async `pathsForFiles` and the new Windows caption-button methods (`window.minimize/toggleMaximize/close/isMaximized` + `window:maximized`). The renderer has 540 `window.mc` references in 111 files; 245 methods map to 215 channels (177 invoke + 38 send; `db:pg` and `db:redis` multiplex) and 43 push events; 3 MessagePorts (pty, sftp, db). The separate `window.updateSplash` contract (init, onState, close, open) serves the startup gate and the update window.

Generation and checking:

- `scripts/gen-ipc-contract.mjs` walks api.d.ts with the TypeScript compiler API and writes `src-tauri/gen/ipc-contract.json` (path, kind invoke/send/event/sync/port, command id, parameter names and types, return type, events). CI regenerates it and fails on a diff.
- Rust: one `Router` (unimux-ipc) maps command ids to typed async handlers. Every domain registers its handlers in `unimux-app/src/commands/<domain>.rs`. A command in the contract without a handler answers `IpcError::NotYet {command}`. A cargo contract test fails on router keys outside the contract and `npm run ipc:report` prints implemented/total per domain; the release gate needs 245/245 and all events.
- Tauri commands: `mc_invoke(cmd, args)`, `mc_send(seq, cmd, args)` (per-window serial queue, ordering matches `ipcRenderer.send`), `mc_invoke_raw` (a Uint8Array argument such as notes:image:save is the raw body, the command and the other arguments travel in the `mc-cmd` / `mc-args` (ASCII JSON) / `mc-raw-index` headers; the bridge picks it whenever an argument is a Uint8Array or ArrayBuffer). Binary results (sound:load's `{ data: Uint8Array | null }`, previews) leave any command as one raw `tauri::ipc::Response`, no base64, framed by `unimux_ipc::binary`: `MCB1`, u32 LE header length, header `{"value": <json with {"$mcBytes": i} placeholders>, "parts": [len...]}`, then the parts; the bridge (`decodeBinaryReply`) puts a Uint8Array wherever a placeholder sits, and a plain `Reply::Bytes` is the frame with value `{"$mcBytes": 0}`. Every renderer payload is made well-formed first (a lone UTF-16 surrogate becomes U+FFFD; serde_json would refuse the whole call), and Rust reads state.json the way JSON.parse does (`unimux_core::js_json::parse`, same replacement), the attach commands for the three ports, and `window_*` for the caption buttons.
- Guard: the router calls `guard()` for every command not in `OPEN_COMMANDS` (mirrors `OPEN_IPC_CHANNELS`): caller label `main` or a registered `detached-<uuid>`, page on the app origin, and the IPC request's `Origin` header (when the transport has one) equal to that origin, which refuses a cross-origin frame. A same-origin iframe cannot be told apart from the page by a Tauri command, so the frame rule of Electron's isFromWindow rests on the CSP (`default-src 'self'`) and on the renderer creating no same-origin iframes. Capabilities grant the mc commands only to those labels; `update-gate` and `update-window` only get `update_splash_*`. Ownership for hot paths (pty_post, attach routes) comes from the Rust routing table `{cellWindow, alive, projectRoots}` kept by the StateController, never from a window field in JS.

`src/renderer/src/bridge/mc.ts`:

- Generated part plus hand part, `satisfies McApi`, so tsc fails on any missing method. Imported first in `main.tsx` and the detached entry.
- Sync values (`platform`, `windowsBuild`, label, detached id) come from `window.__MC_BOOT__`, injected by `initialization_script` (windowsBuild via RtlGetVersion; 26200 on the dev box).
- `on(ch, cb)` uses `listen()`, returns a synchronous unsubscribe that also handles unsubscribe-before-listen-resolved, spreads positional args, normalizes `null -> undefined` where api.d.ts marks optional.
- Argument shaping from the preload is kept verbatim: reportError truncation 24/4000/8000, `listProjectDirectory` path `''`, ssh object wrapping, `db.history.clear` `stars === true`, `db.sqlite.create` `path ?? null`, `detach.attach` `overMain === true`, `getChangelog` `!!force`, `switchToBest` `{provider, to?}`, undefined optional keys omitted for pg/redis ops, redis subscribe target spread.
- Ports: fake MessagePort objects posted as `mc:pty-port` / `mc:sftp-port` / `mc:db-port`, backed by `Channel` attach commands (JSON and control messages) and, for bulk binary data on Windows, WebView2 shared buffers (see "Data plane" below), so `TerminalManager.ts`, `sftp.ts`, `dbClient.ts` and `redisClient.ts` change minimally. Re-attached on load and after reload (renderer-initiated handshake, never push-on-load).
- Unimplemented commands reject with `McNotYetError` (`code: 'MC_NOT_YET'`, `command`); sends to unimplemented commands are logged once. This keeps the real UI usable from wave 0 while domains land.
- `window.__mc` (main.tsx:29) stays for CDP scripts.

Data plane (SP1, docs/tauri/spikes/SP1.md): `tauri::ipc::Channel` costs an eval plus a custom-protocol fetch per message of 1 KiB or more (tauri 2.12.5), so at 20 x 1 MB/s it sits above 2 ms p50 with a tail of 100+ ms (seconds of backlog on a loaded machine). Bulk Rust -> page data therefore goes, on Windows, through `ICoreWebView2Environment12::CreateSharedBuffer` + `ICoreWebView2_17::PostSharedBufferToScript` (read-only, additional data names the port): one sender per window, frames queued by the producers and written as `[u32 LE len][frame]...` into one buffer per post, at most one post queued on the WebView2 UI thread (the next batch waits until the UI thread posted the last one; no fixed timer; a slow UI thread is waited for, never answered with a second post). Measured transport-only 0.31 ms p50 (+-0.8 ms clock bound) / 3.7 ms p95 at 20 x 1 MB/s. That limit is against the UI thread only: `PostSharedBufferToScript` returns before the page handled the buffer, so a busy renderer gets one post per frame queued without bound (SP1, into 20 xterm at 20 x 1 MB/s: 18,369 posts for 19,200 frames, 39 ms arrive p50, worse than the consumer-gated pull). Renderer backpressure therefore comes from a page-side release ack that caps the buffers in flight per window (batches grow while the page is busy) together with the FlowGate byte acks; P2's acceptance checks that the posts in flight stay bounded with the renderer saturated. The bridge receives `sharedbufferreceived`, copies the frames into the fake port's `message` events and calls `chrome.webview.releaseBuffer`. Byte acks and other renderer -> host messages stay on `mc_port_post`. Channel stays for progress, control and JSON messages, and as the fallback when `ICoreWebView2_17` is missing. macOS (no shared buffer): a pull transport (raw invoke long poll, one in flight) unless the Mac measurement in SP5 / W2 says otherwise. The renderer's own limit (20 xterm cannot parse 20 MB/s on the dev box even without IPC) is handled by the FlowGate, not by the transport.

Event routing is Rust: `emit_scoped` applies `routeMessage` (BROADCAST_CHANNELS to all windows, CELL_CHANNELS to the owner window, `automation:start-cells` split, rest to main; JSON fixtures shared with vitest), and `state:changed` is flushed before any other outgoing event.

## 4. State ownership

- Rust owns state from wave 0 (F7-F9). `unimux-state` keeps AppState as `serde_json::Value` with `preserve_order` plus typed views (unknown keys kept), a JS-compatible number writer (whole floats as integers, JSON.stringify escaping), and ports normalizeState with all normalizers (incl. the ones in renderer-shared modules), mergeStateEdit (JSON.stringify equality in insertion order, no resurrection, neighbour inserts, prototype keys skipped) and diffState (exact Patch shapes `{v}`, `{o,d}`, `{a}`, `{s:{drop,at,add}}`, `{full}` fallback), gated by the golden corpus.
- StateController: mpsc actor `{state: Arc<Value>, revision: u64}` with a `tokio::sync::watch<u64>` revision channel; edits acknowledged in the same order as `state:changed`; subscribers (MCP wait_for) never hold the lock across an await; change hooks registered by domains (revokeCell, forgetCell, cancelOrphans, ssh/db/detached stateChanged, taskbar, limit alerts, usage reschedule).
- Saver: 500 ms debounce, compact JSON, temp `state.json.<pid>.<base36ms><counter>.tmp`, retries 1..30 s, hourly `.bak`, `flush_until_saved(3 s)`; loadState rules from INVENTORY section 1.
- Session end: WM_QUERYENDSESSION / NSWorkspaceWillPowerOff -> `markSessionEnding` + saver flush start at once; WM_ENDSESSION only waits on a condvar (cap 3 s).
- The renderer keeps the TS `applyStateChange` and `pruneEdit`; the TS normalizers stay for renderer use and the corpus guards drift.
- Normalization (F8, `unimux-state/src/normalize/`): `StateNormalizer` runs normalizeState on load and `normalizeEditedState` (the pure part of `StateController.apply`, extracted in src/main/stateController.ts) after every renderer edit. It works on `Value` with the JavaScript semantics the TS code depends on (`normalize/js.rs`): spread key order, `undefined` fields dropped (an optional field the TS code sets to undefined is simply absent; on disk that is identical), UTF-16 lengths and `slice` (half a surrogate pair at a cut becomes U+FFFD, as the file reads back anyway), JS `trim` / `\s`, `Math.round`, `ToNumber` / `ToString`, and the names every object inherits from `Object.prototype` (a profile id `constructor` folds into nothing, `__proto__` into `{}`, a DB folder of that name gets no colour, a project of that name skips the inbox limit). Where the TS code throws (a null profile, primitive settings, a null inbox item, an iterable `dependsOn` that is not one), normalize answers None and loadState treats the file as corrupt like 1.1.4. Decision (F8): `js_json::parse` puts array-index keys first in ascending order, like JSON.parse, so a state with keys such as `"2024"` (a DB folder) or `"123"` (an SFTP host key) is ordered and cut (`slice(-200)`) like in 1.1.4.
- Corpus of the normalization: `test/golden/normalize-state.jsonl` (normalizeState of 1.1.4 for both platforms, with `now` and the ids a repeated grid gets fixed) and `state-after-edit.jsonl`, written by scripts/dump-goldens.mjs + goldens-normalize.mjs. Inputs: the states the vitest suite itself hands to normalizeState (`normalize-seeds.jsonl`, recorded by scripts/capture-normalize-seeds.mjs; no user's real state.json is read), a hand-made 1.1.4 state using every domain, older formats, JavaScript corner cases and seeded random damage of all of them.

## 5. Multi-window and window chrome

- Labels: `main` (index.html), `detached-<uuid>` (index.html?detached=<uuid>, registry in state.json `detachedWindows`), `update-gate` (440x200 frameless, `resources/update-splash`). The update window is a separate process (section 8).
- Bounds: state.json keeps Electron DIPs; Rust converts with the monitor scale_factor. Normal (unmaximized) bounds are tracked from Moved/Resized while not maximized (no getNormalBounds in Tauri). Display ids become monitor name + position; a stale id falls back to the primary display. 1.1.4 persists bounds only for detached windows; the main window is not persisted (parity).
- Main window: 1600x1000 (1100x700 offscreen), min 800x500, bg #0d0d0d. Created in code after the startup gate (`app.windows: []`). Hidden until the first page load finished or renderer-boot, with a 5 s fallback show. The show also triggers signalUpdateReady / markReady / clearGateFailureIfUpdated (1.1.4 did it on ready-to-show, index.ts:961).
- Window state: minimize/restore/hide/show detected in the Windows subclass (WM_SIZE SIZE_MINIMIZED) and via NSWindowDidMiniaturize / NSApplicationDidHide on macOS -> `window:shown` + `html[data-window-shown]`; maximized -> `window:maximized`; focus -> registry invalidate + flash off.
- **Windows caption buttons, same look as today (user decision 2026-11-06).** 1.1.4 uses Electron's native `titleBarOverlay {color #0d0d0d, symbolColor #8a8a8a, height 36}` (detached windows: `DETACHED_TITLE_HEIGHT` 36). 1.2.0 uses `decorations(false)` and a React `CaptionButtons` component in the existing 140 px titlebar reserve (styles.css:95), reproducing the overlay pixel for pixel: button size, glyph shapes, colors, hover/pressed/inactive states, the red close hover, the restore glyph when maximized. Reference images are captured from 1.1.4 with an OS-level window capture (CDP screenshots do not contain the overlay) at 100/125/150/200 percent and committed; W1 diffs against them. Native behaviour kept: `WM_NCHITTEST` returns HTMAXBUTTON over maximize (Windows 11 snap layouts) and HTCAPTION over the drag region (right-click system menu, double-click maximize, Aero snap drag); WebView2 `IsNonClientRegionSupportEnabled` so `-webkit-app-region: drag` works. Tooltips through tr() in 6 languages. macOS: `TitleBarStyle::Overlay`, traffic lights (12,10), detached (12,11).
- Never `Webview::hide()` / `SetIsVisible(false)` on an app webview (SP1: it throttles timers to one wake-up per 1.4-5 s and stops painting); minimize and hide the window instead, which keeps the 400 ms tick exact (verified for 390 s minimized like a user does it, WS_VISIBLE + iconic via SC_MINIMIZE, and for a hidden and a never-shown window). `document.visibilityState` stays `visible` while minimized, so `window:shown` is the only signal.
- WebView2 settings on every UI webview (`with_webview` + webview2-com): default context menus off, browser accelerator keys off (Ctrl+R/F5/P/F reach the app), zoom control off, spellcheck off, devtools only with `dev-overrides`. Navigation to non-app URLs denied; http(s) opened externally.
- WebView2 browser args, identical for every webview sharing the data folder (a mismatch fails with 0x8007139F):
  `--max-active-webgl-contexts=96 --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --autoplay-policy=no-user-gesture-required --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,CalculateNativeWinOcclusion`, plus `--remote-debugging-port=N` only with `dev-overrides`. The update window uses its own data folder, so its args may differ.
- Renderer crash/hang: WebView2 `ProcessFailed`, WKWebView `webViewWebContentProcessDidTerminate`, plus a 2 s renderer heartbeat with 10 s grace; they feed the reload limiter (3 per 60 s) and translated Wait/Reload/Quit dialogs.
- `MC_OFFSCREEN` (dev-overrides only): position (-6000, 0), skip_taskbar, focusable(false), never `set_focus` / `request_user_attention`.

## 6. Data dir and state.json compatibility

- `main()` resolves DATA_DIR before `tauri::Builder`: `dirs::data_dir()/unimux` (Windows `%APPDATA%\unimux`, macOS `~/Library/Application Support/unimux`); `MC_DATA_DIR` only with `dev-overrides`. Tauri's `app_data_dir()` is never used.
- `migrateDataDir` ported 1:1 to `unimux-core` (ajzakomator -> unimux rename, junction via `junction` 2.1 or symlink, `migrated-from.json {from, at}`, busy case via `update/work/heartbeat`, `unimux.pre-migration-<stamp>`, re-create a missing legacy link), plus the one-time `MultiCoding/state.json` copy.
- Home dir follows Node `os.homedir()` semantics (USERPROFILE, then HOME), because `dirs::home_dir` and Tauri path APIs ignore env overrides and scratch-home tests would otherwise touch the real `~/.claude`, `~/.codex`. CLAUDE_CONFIG_DIR and CODEX_HOME honoured as today.
- Every file keeps its name and format: state.json (+ `.bak`, `.bak-<ISO>[-n]`), crash.log/crash.old.log, startup.log, update-gate.json, limit-alerts.json, usage-cache.json, refresh-limits.json, auto-switch.json, accounts/, codex-accounts/, git-trust.json, ssh/*.json, db/*.json, github/token.json, note-images/, hooks/, mcp/, prompts/, claude-hook-fallback.json, changelog.json. The conversation index moves to a new file `conversation-index-v2.bin` and leaves the old v8-serialized one untouched.
- Electron Chromium files (`Local State`, `Local Storage`, caches) are never modified or deleted. WebView2 data folder: `DATA_DIR/webview2`. WKWebView: default store.
- localStorage: origin changes from `file://` to `http://tauri.localhost` / `tauri://localhost`. On first start Rust reads `DATA_DIR/Local Storage/leveldb` (rusty-leveldb; keys `_file://\x00\x01<key>`, values prefixed 0x00 UTF-16LE or 0x01 Latin-1) and injects the entries through the boot script on the first load; marker `DATA_DIR/webview-import.json`.
- Instance lock: section 11 "Single instance".
- Downgrade to 1.1.4 stays possible: no format change, same secret format.

## 7. Secrets (Electron safeStorage)

No re-encryption. `unimux-oscrypt` implements Chromium OSCrypt 'v10' read and write (SP2: measured against the real 1.1.4 build, Electron 45.2.2 / Chromium 156, see spikes/SP2.md):

- Windows: `DATA_DIR/Local State` JSON `os_crypt.encrypted_key` -> base64 -> strip `DPAPI` prefix -> `CryptUnprotectData` (user scope) -> 32-byte key. Blob = `v10` + nonce12 + ciphertext + tag16, AES-256-GCM. Encrypt the same way with a random nonce. A key we create is wrapped exactly like Chromium wraps it: `CryptProtectData` with description `Chromium` and `CRYPTPROTECT_AUDIT`, written as `{"os_crypt":{"audit_enabled":true,"encrypted_key":"..."}}` (without `audit_enabled` Chromium re-wraps the key on its next start and rewrites `Local State`).
- macOS: Keychain generic password service `unimux Safe Storage`, account `unimux Key` (Electron sets account = app name, its patch `feat_ensure_mas_builds_of_the_same_application_can_use_safestorage` appends ` Key`); not found -> legacy account `unimux` is copied to `unimux Key` and deleted; neither -> base64 of 16 random bytes is stored. PBKDF2-HMAC-SHA1(password, `saltysalt`, 1003, 16) -> AES-128-CBC, IV 16 spaces, PKCS7, `v10` prefix. No ajzakomator / MultiCoding fallback: 1.1.4 has none either (it only ever uses the current app name). Names are from the Electron 45.2.2 source; the run on a real Mac is still open (SP2 Mac half).
- Confirmed: Electron 45 `safeStorage.encryptString/decryptString` is the sync OSCrypt (kept by Electron's `revert_oscrypt_remove_sync_backend` patch), blobs start with `v10`, `Local State` has no `app_bound_encrypted_key` (no 'v20').
- `decrypt` follows `safeStorage.decryptString`: an empty buffer gives "", a blob without `v10`/`v11` is refused (so Chromium's legacy paths, plain DPAPI blobs and unencrypted macOS text, are not supported), invalid UTF-8 becomes U+FFFD.
- Rules (decision 2026-11-06, SP2 review: match 1.1.4, which is Chromium's OSCryptImpl::Init): a `Local State` with a usable key is never rewritten; if it is missing (fresh install), create it in Chromium format (temp file with a unique name + hard link, so a `Local State` that Electron created meanwhile is never replaced); if it has no `os_crypt.encrypted_key`, a DPAPI blob that does not unwrap (another Windows user's data dir, a password reset by an administrator), or is JSON but not an object, store a new key in it with every other pref kept (temp file + rename), `Origin::Replaced` in startup.log, old blobs show as locked, new ones are saved; if it is not JSON, move it to `Local State.bad` and create it anew (Chromium's JsonPrefStore); a key that is not base64 with the `DPAPI` prefix (Chromium kInvalidKeyFormat) stays unavailable and the file is left alone. `Cipher::open` is single-flight per process (one key even when several stores open it at once). Storage labels `dpapi|keychain|unavailable`; `MC_SSH_NO_SAFESTORAGE=1` (dev-overrides) forces unavailable; a blob that does not decrypt shows as locked and a file with locked entries is never rewritten; decrypted material in `Zeroizing`. The key never leaves unimux-oscrypt. All of these paths were checked against the real 1.1.4 (spike checks F, G, H): it behaves the same way and keeps the key Rust stored.
- Users: `ssh/vault.json`, `db/vault.json`, `github/token.json`.
- macOS: the re-signed (ad-hoc) binary triggers one Keychain "Always Allow" prompt; documented in the release note.

## 8. Updates

### Electron 1.1.x -> Tauri 1.2.0, Windows (latest.yml kept forever)

1.1.4's electron-updater reads `latest.yml` and runs `unimux-Setup-1.2.0.exe --updated /S --force-run` from its own detached splash. That file is the Tauri NSIS installer (`installMode currentUser`, `mainBinaryName unimux`, identifier `com.unimux.app`, languages pl/en/de/es/fr/pt) with `installer-hooks.nsh`:

- NSIS_HOOK_PREINSTALL:
  1. Read `HKCU\Software\214279c4-b798-5d4e-848f-0b9245114cd1` `InstallLocation`; if present and the Tauri key `HKCU\Software\unimux\unimux` is absent, set `$INSTDIR` to it (default `%LOCALAPPDATA%\Programs\unimux` or the user's custom dir). Keeps pins, exe path and the 1.1.x splash `appExe`.
  2. Wait up to 30 s for old `unimux.exe` processes to exit BEFORE Tauri's CheckIfAppIsRunning, so the Electron wind-down saves state.
  3. `SetOutPath $TEMP`, copy `Uninstall unimux.exe` to `$PLUGINSDIR\old-uninstaller.exe`, run `/S /KEEP_APP_DATA /currentuser --keep-shortcuts --updated _?=<oldDir>`. Fallback: delete the `Uninstall\214279c4-...` and `Software\214279c4-...` keys and the Electron files by hand. Then `SetOutPath $INSTDIR`.
- NSIS_HOOK_POSTINSTALL:
  1. When `--updated`, write `installer-done` (content `${VERSION}`) to `$APPDATA\ajzakomator\update` if it exists, else `$APPDATA\unimux\update` (port of `resources/installer.nsh`).
  2. Re-stamp AUMID `com.unimux.app` on Start menu, desktop and `User Pinned\TaskBar\unimux.lnk`.
  3. If `--force-run` is in `$CMDLINE`, launch via `RunAsUser "$INSTDIR\unimux.exe"`.
- A forked NSIS template only if hooks cannot redirect `$INSTDIR` early enough (decided in SP3).
- New app `main()`, before anything else:
  - `ELECTRON_RUN_AS_NODE=1` + `-e <script>`: the 1.1.x splash's cleanup call. Sleep 3 s, remove `<data>/update/runtime`, exit 0 without a window and without single-instance forwarding.
  - `installInProgress` / START_BLOCK_MS refusal.
  - `signalUpdateReady`: write `<data>/update/ready` when `work/config.json` names the running version, then wait up to 4 s for the splash heartbeat to go stale.
  - `clearGateFailureIfUpdated` on update-gate.json.
  - Remove old `%LOCALAPPDATA%\unimux-updater` Electron runtimes; remove `<data>/update` 30 s after start (scheduleUpdateCleanup rules).
  - `SetCurrentProcessExplicitAppUserModelID('com.unimux.app')` (`.dev` when not release).

Optional: `stagingPercentage` in latest.yml for a gradual rollout.

### Electron 1.1.x -> Tauri 1.2.0, macOS (latest-mac.yml kept forever)

The 1.1.4 engine reads `releases/latest/download/latest-mac.yml` and downloads `unimux-1.2.0-mac-<arch>.zip`. Requirements: `ditto -c -k --keepParent`, exactly one `.app`, `CFBundleShortVersionString` 1.2.0, `CFBundleIdentifier` `com.ajzakomator.app`, executable `unimux` with the exec bit, `codesign --verify --deep --strict` passing for the ad-hoc signature. The 1.1.4 install script swaps the bundle; the new app ports `finishPrevious` / `markReady` (writes `updates/mac/ready` within 30 s, deletes `pending.json`, cleans `.old-*` / `.new-*` siblings and staged zips).

### Tauri -> Tauri (from 1.2.0): custom update window kept (user decision 2026-11-06)

- Coordinator (unimux-update, port of updateCoordinator.ts + startupGate.ts): first check 8 s after start then every 30 min, `latest.json` from `https://github.com/daven-team/unimux/releases/latest/download/latest.json` via `http_fetch` (`Cache-Control: no-cache`, 90 s, system proxy), version comparator = `compareVersions`, newest target wins, single download with progress and cancel, stall 2 min, lockHandover, startup gate flow (update-gate window, update-gate.json, cooldowns) unchanged, `MC_UPDATE_FEED` with dev-overrides.
- Verification: minisign signature of the downloaded artifact checked with the public key embedded at build time (key id `817A07BB564AC8D0`, file `D:\Projekty\_unimux-tauri-keys\unimux-updater.key.pub`, base64 value below). `latest.json` keeps the tauri-plugin-updater format so the plugin could be used later, but install is our own code so the custom window owns every stage. The private key and its password exist only as GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` / `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (and the user's offline backup); agents never read them.

  `dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDgxN0EwN0JCNTY0QUM4RDAKUldUUXlFcFd1d2Q2Z1ZRNXN5VVZnaUMzVE9PcUhkaWRpYnJON0RzUFN5K2F0eVJHUGJvRjIrNFcK`

- Staging (Windows, SP6): as soon as the download is verified, copy the running `unimux.exe` to `%LOCALAPPDATA%\unimux-updater\runtime-<ver>\unimux-update.exe` (frontend assets are embedded in the binary; one file, about 11 MB, 12-60 ms) and start the copy once with `--update-cleanup` (a no-op that exits): the first start of a new file pays the antivirus scan (SP6: CreateProcess 514-1476 ms for a fresh copy, 185 ms for a staged and warmed one). The copy is named `unimux-update.exe` like 1.1.4's window, never `unimux.exe`.
- Hand-over (Windows): set `updateHandoverCommitted`, write `<data>/update/work/config.json` (the 1.1.x `UpdateSplashConfig` plus `installer`, `installerArgs`, `webviewDir`), start the copy with `--update-window <config>` via `spawn_detached` (breakaway, no console), wait for `work/shown` (4 s as in 1.1.4), THEN run the full wind-down (pty kill, `flush_until_saved`, MCP and hooks stop, account-swap waits) and exit. The window first shows "closing" and waits for the old pid; starting it before the wind-down hides its WebView2 start (SP6: 0.8-1.1 s idle, up to 8.9 s on a loaded machine) behind the wind-down instead of leaving the user without any window.
- Update window process (`--update-window`, handled in `main()` before the data dir, instance lock and crash.log): no main window, own lock `work/window.lock`, own WebView2 data folder per hand-over `%LOCALAPPDATA%\unimux-updater\webview2-<id>` (`--disable-gpu`), one frameless 440x200 window (never always-on-top; shown inactive with a taskbar flash, never takes the focus) labelled `update-window` loading `resources/update-splash` with the unchanged `window.updateSplash` contract (an initialization script maps it onto the `update_splash_*` commands and the `update-splash:state` event); the page's meta CSP gains `connect-src ipc: http://ipc.localhost` (without it Tauri's ipc: requests are refused by the page CSP and every call falls back to postMessage); `UpdateProgressModel` port (stages preparing / closing / installing / launching / done / error, notes, ceilings, forward-only bar, closeAction: hide while working, exit on done/error) driven by the same file signals as 1.1.x (`heartbeat`, `abort`, `installer-done`, `ready`) and an install-dir size estimate; supervises from the process start, independent of WebView2 (a window that cannot be created or a page that never loads stops neither the install nor the relaunch); runs the NSIS installer `/S /UPDATE --updated /D=<installDir>` once the old pid is gone through `ShellExecuteExW` (owner = the window, `runas` when this user cannot write the install dir, `AllowSetForegroundWindow(ASFW_ANY)` first) (`/UPDATE` keeps the user's shortcuts and pins and skips the WebView2 step, `/D=` last and unquoted puts the files where the running app is; no `/R`, no `--force-run`), treats exit code 0 as `installer-done` when no hook wrote it, starts the new `unimux.exe`, closes 1.1 s after the new app writes `update/ready`. Behind the timeout card it keeps supervising (up to 15 min) and still starts the new app (the outcome of 1.1.4's `--force-run`); closing that card while work is left only hides the window; a failed install has its own text ("Nie udało się zainstalować aktualizacji."). Because the protocol is the 1.1.x one, the new app's `signalUpdateReady` and the NSIS `installer-done` hook serve both the Electron and the Tauri path.
- Cleanup: the window starts `<installDir>\unimux.exe --update-cleanup --wait=<window pid>,<WebView2 browser pid> <runtimeDir> <webviewDir>` (cwd %TEMP%), which waits for both processes (max 30 s), then removes the two folders (only `runtime-*` / `webview2` / `webview2-*` directly inside a folder named `unimux-updater` are ever removed). The runtime copy goes only while `work/window.lock` is free (`--lock=`, taken per attempt), since a newer window of the same version may run from it. Staging copies through `runtime-<ver>.partial-<pid>`; stale ones are removed by the next staging.
- The Tauri NSIS template's running-app check is the Restart Manager on the full path `$INSTDIR\unimux.exe` (RmShutdown with RmForceShutdown in `/S` mode): it never touches the copy, nor a unimux.exe running from another folder (a 1.1.x install, a dev build).
- macOS (not verified yet, no Mac): the same window mode runs from a copy in a temp dir, downloads the `.app.tar.gz` (or ditto zip), applies `evaluateInstallTarget` / `probeBundleWrite` refusals (translocated, read-only, not owner, app management -> download page), swaps the bundle with rollback (port of the 1.1.4 install script), relaunches and waits for `updates/mac/ready`.
- Deleted at R1: updateRuntime.ts, updateSplash.ts, src/updatesplash/index.ts, electron-updater, the macUpdate engine TS (ported). Kept forever: the `update/ready`, `installer-done`, `-e` legacy entry points, resources/update-splash.

### Release assets, every release from now on

`latest.yml` + `unimux-Setup-X.exe` (Windows clients still on Electron), `latest-mac.yml` + ditto zips + dmgs (macOS clients still on Electron), `latest.json` + `.sig` + `unimux-X-mac-<arch>.app.tar.gz` (Tauri clients; Windows entry points at the signed setup exe), `SHA256SUMS.txt`. 1.2.0 is published as latest, never as a prerelease. The signing key must never be lost.

Fallback if SP3 or SP4 fail: Electron bridge release 1.1.5 whose splash and macOS engine know about Tauri (needs the user's approval).

## 9. macOS vs Windows

| Area | Windows (WebView2) | macOS (WKWebView) |
|---|---|---|
| Title bar | decorations(false) + React caption buttons identical to the 1.1.4 overlay + WM_NCHITTEST snap layouts + IsNonClientRegionSupportEnabled | Overlay, traffic lights (12,10) / (12,11) |
| Data plane | WebView2 shared buffers, one post queued on the UI thread per window, renderer gated by a release ack + FlowGate (SP1, P2) | pull transport (raw invoke long poll) until measured on a Mac |
| PTY | ConPTY via sideloaded conpty.dll + OpenConsole.exe 1.23 through an own `windows`-crate wrapper (SP5: flags 0 and ConptyReleasePseudoConsole like node-pty; portable-pty sets other flags), Job Object per terminal, ClosePseudoConsole off-thread while draining, input on a writer thread, timeBeginPeriod(1) while terminals are active; output as frames `[u8 kind][u16 idLen][id][u32 len][payload]`, many per Channel message, batched per window (16 ms, focused terminal 4 ms) | openpty + setsid + TIOCSCTTY, zsh/bash `-il`, killpg SIGHUP then SIGKILL |
| WebGL | 96 contexts via browser args, renderer pool 64 | WebKit caps about 16 per page: `MAX_WEBGL_CONTEXTS` about 12, WebglLimit learning, DOM renderer fallback |
| Background | throttling flags; SP1: wry never sets IsVisible(false) on minimize or window hide, the 400 ms tick stays exact minimized (WS_VISIBLE + iconic, 390 s), hidden and never shown (8 min); no Rust tick needed | `backgroundThrottling: 'disabled'` (macOS 14+), App Nap off via NSProcessInfo activity |
| OS file drop | dragDropEnabled(false) + `chrome.webview.postMessageWithAdditionalObjects` -> ICoreWebView2File.Path (HTML5 DnD keeps working) | native DragDropEvent routed by `elementFromPoint` |
| Notifications with buttons | tauri-winrt-notification, AUMID com.unimux.app | UNUserNotificationCenter categories (objc2); verify with ad-hoc signing |
| Badge / attention | request_user_attention | NSDockTile badge |
| Session end | HWND subclass WM_QUERYENDSESSION / WM_ENDSESSION | NSWorkspaceWillPowerOffNotification, applicationShouldTerminate |
| Renderer crash | ProcessFailed + heartbeat | webContentProcessDidTerminate + heartbeat |
| Secrets | DPAPI Local State key | Keychain, one re-approval prompt |
| Single instance | fs4 lock + local socket + own `Chrome_MessageWindow` (Electron 1.1.x compat) | fs4 lock + local socket + `SingletonLock`/`SingletonSocket` (Electron compat) |
| Keys | no app menu | tauri::menu app + edit (no reload/close); Cmd+V no double paste; text substitutions off; requestIdleCallback, randomUUID, AudioContext resume polyfills |
| Dev automation | CDP via `--remote-debugging-port` (dev-overrides) | no CDP: debug-only eval bridge (test-bridge) |
| Updater | NSIS hooks (from Electron) + custom update window running NSIS `/S` (Tauri -> Tauri) | ditto zip for 1.1.x, custom update window bundle swap later |

Fonts: terminal stack `"Cascadia Mono", "Cascadia Code", Consolas, ui-monospace, Menlo, "SF Mono", "Courier New", monospace`.

## 10. Testing strategy

1. **vitest stays** for the renderer, src/shared and i18n, plus new suites for the bridge (argument shaping, send ordering, unsubscribe-before-listen, NotYet), the contract generator and routeMessage fixtures. The main-side suites (about 1,815 tests) keep running against the TS reference until R1; each case is ported to cargo and tracked in `test/PORTING.md` (100 percent at the gate).
2. **cargo** on windows-latest and macos-latest: `cargo fmt --check`, `cargo clippy -D warnings`, `cargo test --workspace`, incl. ConPTY integration (echo, 50 MB flood pause/resume, output after exit, tree kill, 30 parallel kills, killAll 30 in 3 s), http_fetch header assertions on a mock server, guard and contract tests.
3. **Golden corpus** (`scripts/dump-goldens.mjs` -> `test/golden/*.jsonl`, `crates/unimux-core/tests/golden.rs`; CI regenerates and fails on diff): state normalize/merge/diff, translate, routeMessage, launch lines, Claude settings, trust hashes, encodings, UTF-16 search offsets, DB values, MCP tools/list, update progress model.
4. **Dual host + `unimux-hostd`**: `test/helpers/nodeHost.ts` and the Rust stdio test binary, so `.int` suites (ptyhost.int, ssh.int, sftp-host.int, db-*.int, db-tunnel.int) and the Node fake servers (pgFakeServer, mysqlFakeServer, respServer, sshServer, pglite-socket) drive the Rust code unchanged.
5. **Real-app checks over WebView2 CDP**: `scripts/app-env.mjs appBinary()` and `launchApp` start the Tauri `check` build with `MC_DATA_DIR`, `MC_OFFSCREEN`, `MC_DEBUG_PORT` and a scratch USERPROFILE/HOME/APPDATA/LOCALAPPDATA; target filter `http://tauri.localhost/index.html` without `?detached=`; process-tree kill of our own pids incl. `msedgewebview2.exe`. The 12 mainInspector scripts use `test-bridge` commands instead (debug only, CI asserts the feature is off in release). All verify-*.mjs must pass; `verify-cli-contract` and `verify-team-start` are release gates. Scripts report `MC_NOT_YET` as "blocked by <package>" until the package lands.
6. **Isolation test**: real `%APPDATA%\unimux`, `~/.claude`, `~/.codex` and `%LOCALAPPDATA%\com.unimux.app` unchanged after a run (hash snapshot).
7. **Upgrade tests**: copy of a 1.1.4 data dir with secret fixtures (state, accounts, ssh/db vault, github token, drafts, detached windows): loads unchanged, no-op edit gives byte-identical state.json, secrets decrypt both ways, drafts imported, restart with existing saved data; Windows VM (VirtualBox) 1.1.4 -> 1.2.0 installer hand-over (default and custom dir, taskbar pin); macOS harness running the v1.1.4 MacUpdater against the Tauri zip; Tauri -> Tauri through the custom update window.
8. **Docker** for DB and SSH matrices (Postgres 13-18, MySQL 8.4/9, MariaDB 11, Redis, OpenSSH current and old, Dropbear). Agents remove only their own containers/images/volumes by id; never `docker prune`.
9. **Performance vs 1.1.4**: perf-latency (keystroke echo), bench-jank and perf-grid (20 busy cells), perf-hidden (minimized 60 s), measure-startup, idle CPU and RSS of unimux.exe + msedgewebview2.exe.
10. **smoke-start**: installed exe without console and std handles, plus the `ELECTRON_RUN_AS_NODE=1 unimux.exe -e ...` call (exit 0, no window).
11. **macOS**: build and cargo tests in CI; Keychain, notifications, keyboard, WebGL, single instance and both updater paths checked manually on a real Mac plus a smoke subset through the eval bridge.

## 11. Build flavours, CSP, OS integrations

### Build flavours

| Flavour | How | `dev-overrides` | MC_* overrides, CDP port, test-bridge | Used for |
|---|---|---|---|---|
| dev | `npm run tauri dev` (debug) | on | yes | development |
| check | `npm run build:check` (release profile, no bundle, features dev-overrides + test-bridge) | on | yes | verify-*.mjs, perf, capture-readme |
| release | `npm run build:release` / CI `tauri build` | off | no (CI asserts both features off and no `--remote-debugging-port`) | installers |

`dev-overrides` is Electron's `!app.isPackaged`. The overrides it enables (all read by Rust): MC_DATA_DIR, MC_DEBUG_PORT, MC_OFFSCREEN, MC_HOOK_DEBUG, MC_SSH_DEBUG, MC_SSH_NO_SAFESTORAGE, MC_TRASH_DIR, MC_DB_EXPORT_DIR, MC_NOTES_EXPORT_DIR, MC_CLI_NO_REGISTRY, MC_CLI_PROBE_PROFILE, MC_INSTALL_COMMAND_OVERRIDE, MC_USAGE_CLAUDE_URL, MC_USAGE_CODEX_URL, MC_USAGE_CLAUDE_TOKEN_URL, MC_UPDATE_FEED. They are read in one `DevOverrides` struct (F5); release builds compile them out. MC_CELL_ID is the per-terminal env var, not an override.

### CSP

The meta CSP in src/renderer/index.html is removed; the policy moves to `app.security.csp` (Tauri adds its IPC sources): `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; script-src 'self'; connect-src 'self' ipc: http://ipc.localhost`. No WebSocket and no custom blob protocol are needed (binary data goes over raw IPC responses and Channels; images become blob: URLs). resources/update-splash/index.html keeps its own stricter meta CSP.

### OS integrations: inventory

Used by 1.1.4 and covered: single instance (+ relaunch while quitting), AUMID, taskbar flash / Dock bounce (attention:flash), Dock badge, Dock icon in dev, toasts with buttons, system beep, save/open dialogs, clipboard incl. secret, shell openExternal/openPath/showItemInFolder/trashItem, open in Cursor/VS Code (detached spawn), session end (query-session-end, session-end, powerMonitor 'shutdown'), renderer crash and unresponsive, macOS app + edit menu, getAppMetrics (Monitor panel; Rust reports WebView2 processes via ICoreWebView2Environment.GetProcessInfos and the cell trees), screen API for detached placement, crash.log, startup.log.

Not used by 1.1.4 (verified by grep on 2026-11-06), so NOT added: tray icon, global shortcuts, deep links / protocol handlers, file associations, login item / autostart, jump lists / thumbar buttons / overlay icon / taskbar progress, power-save blocker, nativeTheme, crashReporter (crash.log only).

### Single instance and Electron 1.1.x on the same data dir

- fs4 exclusive lock on `DATA_DIR/instance.lock` plus an interprocess local socket for second-instance focus / relaunchRequested. Keyed by data dir, so parallel `MC_DATA_DIR` dev runs coexist. tauri-plugin-single-instance is not used (keyed by identifier). On packaged Windows, `updateInstalling(START_BLOCK_MS=90 s)` refuses the start.
- Electron's ProcessSingleton does not see the fs4 lock, so 1.2.0 speaks its protocol in both directions. Windows: if a message-only window of class `Chrome_MessageWindow` titled with DATA_DIR exists, 1.2.0 forwards its argv with WM_COPYDATA (1.1.x focuses itself) and exits without touching state; while running, 1.2.0 owns such a window itself and answers WM_COPYDATA, so a 1.1.x started later forwards to us and quits instead of writing state.json. macOS: a live `SingletonLock` (`<host>-<pid>`) makes 1.2.0 exit; while running, 1.2.0 creates `SingletonLock`, `SingletonSocket`, `SingletonCookie` and answers Chromium's `START\0...` message with `ACK` (an unanswered socket makes Chromium kill the "hung" pid).

### Process tree rules

- Every child is spawned through unimux-exec: CREATE_NO_WINDOW, stdio piped or null (never inherit, never mixed), in a Job Object (Windows) or process group (macOS) killed on exit.
- Detached launches (editors, `open -a`, the update window) use `spawn_detached` with CREATE_BREAKAWAY_FROM_JOB, else they would die with the app.
- crash.log has one writer.

## History

- 2026-11-06, first version: design 3 (staged strangler with a Node 24 SEA sidecar in 1.2.0, ports in 1.3.0 to 1.6.0) plus a critic review (routing table, CSP, build flavours, cross-generation lock, minimize detection, gate exit prevention, worker assets, Job breakaway, WebView2 process reporting).
- 2026-11-06, SP5 (docs/tauri/spikes/SP5.md): own ConPTY wrapper instead of portable-pty; frames get a u32 payload length and are batched per window, because the Channel's per-message cost (not Rust, not decoding) limits the frame rate at 20 MB/s.
- 2026-11-06, this version: rewritten for the user's ALL-AT-ONCE decision. Removed: sidecar, stdio bridge, loopback WebSocket transport and its CSP entries, Electron shim, `channelRoutes.ts` backend/rust routing, `unimux-blob://` protocol, state mirror, release table 1.3.0 to 1.6.0. Added: generated IPC contract with NotYet stubs, Rust-owned state from wave 0, full crate list, caption buttons matching the 1.1.4 overlay, custom update window process for Tauri -> Tauri, two-way Electron singleton compatibility, embedded updater public key.
- 2026-11-06, SP6 (Windows half): the update window copy is `unimux-update.exe`, staged and warmed when the download is verified; the window starts before the wind-down; installer arguments `/S /UPDATE --updated /D=<installDir>`; cleanup through `--update-cleanup --wait=...`; the splash page CSP gains `connect-src ipc: http://ipc.localhost` (docs/tauri/spikes/SP6.md).

- 2026-11-06, SP8: the MCP server is a custom dispatcher on hyper 1.12 / axum 0.8.9 that reproduces the 1.1.4 wire (52 / 52 HTTP-level cases after the review fixes, both CLIs green); rmcp 3.9 dropped (7 / 52: no 2025-11-25 MCP tasks, global session mode, no abort of vanished clients, sessions not bound to tokens). See spikes/SP8.md.
