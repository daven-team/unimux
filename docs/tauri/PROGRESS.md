| F14 | undefined | verified (Windows) | 2026-11-06 | 2026-11-06 | 2026-11-06 | unimux-exec: CREATE_NO_WINDOW, suspended start + Job Object kill-on-close (tree killed on timeout / cap), process group on Unix, cleanEnv, raw command lines, 256 KiB caps, timeouts, spawn_detached with breakaway fallback; 7 tests. Open: macOS run, survives-app-exit test for detached launches |

The orchestrator updates this file after every step. Status values: `todo`, `in progress`, `done` (code merged into `tauri-1.2.0`), `verified` (acceptance tests from PLAN.md passed). Dates are filled in when a status changes.

Branch: `tauri-1.2.0`. Specs: ARCHITECTURE.md, PLAN.md, INVENTORY.md. Plan: ALL AT ONCE (one release, 1.2.0, fully Rust + Tauri v2, no Node sidecar).

## Decision log

| date | decision | by | effect |
|---|---|---|---|
| 2026-11-06 | **ALL AT ONCE.** 1.2.0 ships only when the WHOLE app is Rust + Tauri v2 with full parity. No Node sidecar in the shipped app; Node only as a build tool for the React UI and tests. | user | Staged plan (sidecar in 1.2.0, ports in 1.3.0 to 1.6.0) dropped; ARCHITECTURE.md = design 1 + grafts; PLAN.md rewritten into waves 0 to 7 (93 packages, 291.5 agent-days). |
| 2026-11-06 | Installs done: Node 26 LTS, Docker Desktop (WSL2), VirtualBox (Windows VM image not downloaded yet), cargo on PATH. | user | Node 24 / SEA no longer needed. VM image needed for SP3 / U3 / B3 PAC check. |
| 2026-11-06 | Updater signing key generated. GitHub secrets `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` exist. Public key `D:\Projekty\_unimux-tauri-keys\unimux-updater.key.pub` (minisign key id 817A07BB564AC8D0) is embedded; agents never read, print or copy the private key or password. | user | Public key recorded in ARCHITECTURE section 8; used by F2 / U1 / U4. |
| 2026-11-06 | **Keep the current look.** Windows caption buttons drawn to look exactly like today (Electron titleBarOverlay #0d0d0d / #8a8a8a, height 36). | user | Package W1 (reference images from 1.1.4, pixel diff at 4 scaling levels); release gate item 8. |
| 2026-11-06 | **Keep the custom update window** (progress, stages, restart) for updates between Tauri versions too, not the stock installer UI. | user | Packages SP6, U2 (Windows), U5 (macOS); tauri-plugin-updater not used for install; NSIS `passive` mode dropped. |
| 2026-11-06 | **Keep publishing latest.yml / latest-mac.yml** so Electron 1.1.x installs update into 1.2.0. | user | U3 transition, U4 asset list, every release from now on. |

Still open (see the Polish section at the end): macOS identifier com.ajzakomator.app + one Keychain prompt, fallback bridge release 1.1.5 if SP3/SP4 fail, Mac access, 1.1.4 test data.

## Status

### Wave 0a: foundation

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| F1 | Cargo workspace, Vite and build scripts | done | 2026-11-06 | 2026-11-06 |  | workspace with all 19 crates (members fixed from wave 0), tauri 2.12.5 / tauri-build 2.7.4, @tauri-apps/api + cli 2.12.4; vite.config.tauri.ts next to electron.vite.config.ts; npm scripts tauri, dev:ui, build:ui, build:check (own target dir src-tauri/target/check), build:release, cargo; release build gives unimux.exe + NSIS (5.1 MB). Open: `npm run tauri dev` not exercised yet |
| F2 | tauri.conf, capabilities, CSP, sender guard | done | 2026-11-06 | 2026-11-06 |  | tauri.conf.json + tauri.macos.conf.json live in crates/unimux-app (not src-tauri/), capabilities main / gate / update-window granting app-command permissions (build.rs app manifest), CSP in app.security.csp (meta CSP stripped only in the Tauri build, Electron keeps it), navigation lock (http(s) opens the browser), guard() in unimux-ipc applied centrally by the router; updater public key constant in unimux-update (decoded and checked against key id 817A07BB564AC8D0). Open: automated CSP-violation count and external-link check |
| F3 | IPC contract generator, Rust router, not-yet stubs | verified | 2026-11-06 | 2026-11-06 | 2026-11-06 | scripts/gen-ipc-contract.mjs (oxc parser via rolldown/parseAst: TypeScript 7 has no JS compiler API) writes gen/ipc-contract.json and src/renderer/src/bridge/contract.gen.ts: 245 methods on 215 channels (177 invoke + 38 send), 44 events, the update-splash contract. Router with MC_NOT_YET / UNKNOWN / REFUSED / BAD_ARGS / FAILED, wave-0 fallbacks, ordered SendQueue (1,000 interleaved sends test), Events with scopes and before-emit state flush, Ports registry. `npm run ipc:report` |
| F4 | Renderer window.mc adapter | done | 2026-11-06 | 2026-11-06 |  | window.mc is built from the SAME table as the Electron preload (new src/preload/mcApi.ts, so argument shaping cannot drift) over a Tauri transport; the bridge is bundled on its own as a classic script run in <head> (inside the app bundle, hoisted shared chunks ran before it); McNotYetError, sync unsubscribe incl. before listen() resolved, null -> undefined for optional event args, in-flight state:edit journaled and replayed after a reload (Rust dedupes by edit id), ports as MessageChannel + tauri Channel. 12 vitest cases. Open: pathForFile -> pathsForFiles and the caption-button methods (left to W3 / W1) |
| F5 | Process start: data dir, dev overrides, crash log | done | 2026-11-06 | 2026-11-06 |  | data dir + migrateDataDir port (all 18 cases), MultiCoding copy, DevOverrides (16 MC_* switches; on in debug builds and with feature dev-overrides, compiled out of release), Node os.homedir semantics, atomic_write, backup_path, crash.log (200 KB rotation) + panic hook + translated startupFailed / runtime error dialogs (no dialog under MC_OFFSCREEN), startup.log, AUMID. Legacy entry: only the `ELECTRON_RUN_AS_NODE=1 -e` no-window exit; the rest is U3 |
| F6 | Single instance, compatible with Electron 1.1.x | verified (Windows) | 2026-11-06 | 2026-11-06 | 2026-11-06 | instance.lock (std File::try_lock) + our own Chrome_MessageWindow titled with the data dir answering WM_COPYDATA START; checked against the real Electron build of this tree in both directions (scripts/check-electron-compat.mjs 7/7, state.json untouched by the refused side). macOS: lock + Unix socket only; the Electron SingletonLock compatibility is the R3 half. updateInstalling START_BLOCK refusal belongs to U3 |
| F7 | State store: load, save, controller | verified | 2026-11-06 | 2026-11-06 | 2026-11-06 | loadState rules (temp sweep, locked-read retries 4 s, unreadable -> stop + dialog, corrupt -> backup -> .bak -> defaults), saver (500 ms debounce, 1..30 s retries, hourly .bak, flush_until_saved 3 s), StateController (mutex single writer, revision watch, change hooks in revision order, edit-id dedupe). Load + save without an edit is byte-identical (store test + smoke check) |
| F8 | State normalize port | todo |  |  |  | only the seam: PassThrough keeps a valid state (version 1 + projects) exactly as it is; defaultState comes from the golden corpus written by the TS code; the real normalizeState port and the edit normalizers are open |
| F9 | State edits, patches, broadcast, state commands | done | 2026-11-06 | 2026-11-06 |  | mergeStateEdit, diffState / applyPatch, the state:changed broadcaster (16 ms batching, flushed before every other event), state:load / snapshot / edit; detachedWindows always from main. 400 merge + 400 diff golden cases byte-identical to TS (they found the JS Map last-wins rule for repeated ids). Open: edit normalizers (F8), vitest fixture of Rust patches through the renderer applyStateChange |
| F10 | Golden corpus, PORTING.md, messages export | done (corpus partial) | 2026-11-06 | 2026-11-06 |  | dump-goldens.mjs (default-state, state-merge, state-diff, translate x 6 languages, atomic-write names), gen-messages.mjs + Rust translate (2,720 rows), test/PORTING.md + porting-count.mjs (baseline 2,138 main-side cases in 140 files, 57 done), `npm run gen:check`. Open: normalize, routeMessage, launch lines, update-progress goldens |
| F11 | Main window, startup gate order, window state, WebView settings | done (partial) | 2026-11-06 | 2026-11-06 |  | main window created in code (1600x1000 / 1100x700 offscreen, min 800x500, #0d0d0d, hidden until page load or renderer-boot, 5 s fallback), __MC_BOOT__ init script, identical browser args for every webview, WebView2 data folder DATA_DIR/webview2, default context menus / browser accelerators / zoom / status bar off, devtools only with dev overrides, NonClientRegion support on, window:shown + window:maximized, offscreen shows without activation. Native title bar kept until W1. Open: StartupGate trait and the update-gate window (only the hook point in setup), automated key / zoom / minimize checks |
| F12 | CI skeleton | done (not run) | 2026-11-06 | 2026-11-06 |  | .github/workflows/tauri.yml: Windows + macOS checks (gen drift, porting check, 3.0.0-alpha grep, typecheck, vitest, fmt, clippy x2, cargo test incl. --release), 3 build jobs with the U4 names, release asserts no --remote-debugging-port, artifacts. Not pushed, so no CI run yet; macOS never compiled |
| F13 | Real-app harness base | done | 2026-11-06 | 2026-11-06 | 2026-11-06 | scripts/tauri-app.mjs (check build only, scratch home + data dir, CDP client, kill of our own tree, real-profile markers), scripts/smoke-tauri.mjs 26/26 (3 runs), test-bridge commands state / flush / paths / emit / panic / probe / report / quit. Open: X1 moves the 44 verify scripts |
| F14 | Exec helper and env | todo | | | | |

### Wave 0b: spikes

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| SP1 | WebView2 shell behaviour | todo | | | | |
| SP2 | Electron safeStorage both directions | todo | | | | Mac half needs a Mac |
| SP3 | Windows 1.1.4 -> Tauri NSIS hand-over | todo | | | | needs the VirtualBox Windows VM image |
| SP4 | macOS 1.1.4 engine accepts the Tauri zip | todo | | | | needs a Mac |
| SP5 | Rust ConPTY + Channel | todo | | | | |
| SP6 | Custom update window process | todo | | | | |
| SP7 | russh coverage | verified (Windows) | 2026-11-06 | 2026-11-06 | 2026-11-06 | docs/tauri/spikes/SP7.md. Keys: 91-file corpus (ssh-keygen 10.0p2, OpenSSL 3.5.7, PuTTYgen 0.83, 1.1.4's generateKey) vs the real 1.1.4 parsePrivateKey: 62 accepted, russh 0.65.1 loads 53 identically, the `legacy_pem` prototype (AES-128/192/256-CBC, DES-EDE3-CBC PEM, RSA + EC) the other 9 -> 62/62; PPK v2 through ssh-key (no own parser); 26 keys russh loads that 1.1.4 refuses are listed for S2 refusal checks (cargo test sp7_keys asserts both lists). Servers (scripts/sp7/matrix.mjs, Docker, containers removed by id): OpenSSH 10 current / old offer / SHA-1 only / CBC only, OpenSSH 5.9, Dropbear 2025 x2, Dropbear 2016; real 1.1.4 SshLogin under Electron 45 vs the russh probe with the 1.1.4 offer: same outcome and algorithms in all 104 logins, 21/21 host keys byte-identical to the 1.1.4 known_hosts.json entries; russh DEFAULT fails on the OpenSSH 5.x/6.x offer (no common MAC), so S3 uses `ssh2_preferred()`; login p50 87 ms (ssh2) vs 100 ms (russh) |
| SP8 | MCP wire with real CLIs | todo | | | | scratch home |
| SP9 | DB wire fidelity | todo | | | | Docker |

### Wave 1

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| P1 | Rust pty core | todo | | | | |
| B1 | Dual host test harness (unimux-hostd) | todo | | | | |
| B2 | unimux-oscrypt production | todo | | | | |
| B3 | Rust http_fetch | todo | | | | PAC check in the VM |
| W1 | Windows caption buttons that look like today | todo | | | | reference images from 1.1.4 first |
| W2 | macOS window chrome, app menu, WebKit compatibility | todo | | | | |
| W3 | OS file drop and localStorage import | todo | | | | |
| W4 | Notifications, attention, badge, beep, dialogs, clipboard, shell, sound files | todo | | | | |
| W5 | Detached windows and event routing | todo | | | | |
| W6 | Lifecycle: quit, session end, renderer crash and hang | todo | | | | |
| G1 | Git runner, env scrub, caches, canonical paths | todo | | | | |
| G5 | Project files: listing, preview, save, local files | todo | | | | |
| H1 | Hook server | todo | | | | |
| H3 | CLI detector | todo | | | | |
| H5 | Conversation search | todo | | | | |
| D3 | SQL helper ports | todo | | | | |
| A1 | Accounts stores and Claude Code locks | todo | | | | |
| M1 | MCP HTTP server | todo | | | | |
| S2 | SSH key handling | todo | | | | |
| U2 | Custom update window (Windows) | todo | | | | |
| X1 | Real-app script migration | todo | | | | |

### Wave 2

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| P2 | Pty output engine and Channel data plane | todo | | | | |
| G2 | Git parsers, validators, trust | todo | | | | |
| G6 | File operations with progress | todo | | | | |
| G7 | Project search and replace | todo | | | | |
| G8 | Notes, fs probes, monitor, changelog | todo | | | | |
| H2 | Claude settings, Codex hooks, fallback, cell files | todo | | | | |
| H4 | Context tracker, sessions, codex bind | todo | | | | |
| S1 | SSH stores | todo | | | | |
| D1 | DB service, vault, history, sqlite files | todo | | | | |
| A2 | Activation, swap journal, recovery | todo | | | | |
| A6 | GitHub token store, device flow, status | todo | | | | |
| M2 | MCP tools, validation, elicitation | todo | | | | |
| U1 | Update coordinator and startup gate flow | todo | | | | |
| U5 | macOS update engine in the update window | todo | | | | Mac check in R3 |
| W7 | Core cell bookkeeping, startup gates, taskbar, misc commands | todo | | | | |

### Wave 3

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| P3 | Pty service: spawn, routing, replay, supervision | todo | | | | |
| G3 | Git reads, mutations, commands, publish | todo | | | | |
| G4 | Worktrees, clone, init, installGit | todo | | | | |
| S3 | russh login core and SshCoordinator | todo | | | | Docker |
| A3 | Reconcile, resync, token refresh | todo | | | | |
| D4 | Postgres client: connect, simple query, TLS | todo | | | | Docker |
| D7 | MySQL/MariaDB client core | todo | | | | Docker |
| D9 | Redis sessions and browsing | todo | | | | |
| D11 | SQLite sessions | todo | | | | |
| U3 | Electron 1.1.x -> 1.2.0 transition | todo | | | | needs VM + Mac |

### Wave 4

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| P4 | Shell integration, launch line, cell spawn | todo | | | | |
| P5 | SSH shell cells on russh | todo | | | | |
| H6 | Install manager, login terminals, agent delivery | todo | | | | |
| S4 | SSH IPC and russh test server | todo | | | | Docker |
| T1 | SFTP service and sessions | todo | | | | |
| D2 | SSH tunnels for databases | todo | | | | |
| D5 | Postgres cursors and read-only | todo | | | | |
| D8 | MySQL session, meta, edits | todo | | | | |
| D10 | Redis writes, console, pattern ops, pub/sub | todo | | | | |
| A4 | Login managers | todo | | | | |
| A5 | Usage, auto-switch, limit alerts | todo | | | | |
| M3 | Automation operations | todo | | | | |
| U4 | CI and release pipeline | todo | | | | uses the signing secrets in CI only |

### Wave 5

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| D6 | Postgres metadata, pages, edits | todo | | | | |
| T2 | SFTP remote and local sides | todo | | | | |
| M4 | wait_for, delivery, team prompts | todo | | | | |

### Wave 6

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| T3 | SFTP transfer queue | todo | | | | |
| T4 | SFTP manage ops and editor files | todo | | | | |
| T5 | Sudo SFTP over exec | todo | | | | Docker |
| D12 | DB result routing and detached DB windows | todo | | | | |

### Wave 7: release

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| R1 | Remove Electron | todo | | | | |
| R2 | Parity and performance sweep | todo | | | | |
| R3 | macOS pass | todo | | | | needs a Mac |
| R4 | 1.2.0 docs, i18n, release | todo | | | | user approves the test build and notes |

## Contract and porting counters

Updated after every merge (`npm run ipc:report`, `node scripts/porting-count.mjs`; both exist after F3 / F10).

| date | window.mc implemented | events implemented | PORTING.md ported | verify scripts green |
|---|---|---|---|---|
| 2026-11-06 | 0 / 245 | 0 / 45 | 0 / about 1,815 | 0 / 44 |
| 2026-11-06 (wave 0) | 6 / 245 (+2 fallbacks) | 4 / 44 emitted (state:changed, window:shown, window:maximized, test emit) | 57 / 2,138 | 0 / 44 (smoke-tauri 26/26 and check-electron-compat 7/7 are new) |

## 1.2.0 release gate checklist

See PLAN.md "1.2.0 release gate". Tick here when verified.

- [ ] 1. Spikes SP1 to SP9 green or fallback re-tested
- [ ] 2. typecheck, npm test, cargo fmt/clippy/test green on Windows and macOS CI
- [ ] 3. No Node in the shipped app (installer and .app checked)
- [ ] 4. Contract 245/245 and all events, PORTING.md 100 percent, goldens no diff, guard tests, no 3.0.0-alpha
- [ ] 5. verify-cli-contract, verify-team-start and all other verify scripts green
- [ ] 6. Upgrade test on a 1.1.4 data copy + downgrade check + no parallel 1.1.4/1.2.0 on one data dir
- [ ] 7. Windows VM transition, macOS harness transition, Tauri -> Tauri update through the custom window
- [ ] 8. Look kept: caption buttons match 1.1.4 references; update window as in 1.1.4
- [ ] 9. Isolation test (real profile untouched)
- [ ] 10. No-console start and `-e` legacy call
- [ ] 11. Performance vs 1.1.4
- [ ] 12. macOS manual checklist
- [ ] 13. CI rehearsal assets incl. latest.yml, latest-mac.yml, latest.json + .sig, signatures verified
- [ ] 14. User tested a test build and approved the release note
- [ ] 15. Published via `npm run publish-release` (dry run first)

## Install status (2026-11-06)

| item | status |
|---|---|
| Visual Studio 2026 C++ tools (VC Tools x86/x64) | installed |
| Windows 11 SDK | **missing** (2026-11-06: no kernel32.lib / rc.exe on the machine, vswhere does not list the VS 18 install). Wave 0 builds use a user-level copy of Microsoft's NuGet packages Microsoft.Windows.SDK.CPP + .x64 10.0.28000.2957 in `%LOCALAPPDATA%\unimux-build\winsdk-10.0.28000.2957`, picked up by `scripts/msvc-run.mjs` (which also loads vcvars64.bat). Proper fix: add "Windows 11 SDK" in the Visual Studio installer; that folder can be deleted afterwards |
| Rust 1.99.1 MSVC, cargo on PATH | installed |
| Node 26 LTS (npm) | installed (build tool only) |
| WebView2 Runtime 156 | installed |
| Docker Desktop with WSL2 | installed |
| VirtualBox | installed |
| Windows VM image for VirtualBox | **not downloaded yet**; needed for SP3 (wave 0 spike), B3 PAC check, U3 |
| Tauri CLI | project dependency (`@tauri-apps/cli` 2.12.4, `@tauri-apps/api` 2.12.4), nothing global; NSIS was downloaded by the first `tauri build` into the Tauri tools cache |
| Updater signing key + GitHub secrets | done; public key embedded |
| Mac access | not available yet; needed for SP2 (Mac half), SP4, R3 |

## Log

| date | step | result |
|---|---|---|
| 2026-11-06 | Inventory of 12 units, 3 designs, 3 judge reports | Winner by votes: design 3 (staged strangler), with grafts from designs 1 and 2 |
| 2026-11-06 | docs/tauri/ARCHITECTURE.md, PLAN.md, INVENTORY.md, PROGRESS.md written | 92 packages, 293 agent-days total; 1.2.0 = 33 packages, 93 agent-days. Waiting for user decisions. |
| 2026-11-06 | Critic review of the four docs against the source | 1.2.0 = 34 packages, 98 agent-days; total 93 / 298. |
| 2026-11-06 | User decisions recorded (decision log above) | ALL AT ONCE: PLAN.md rewritten into waves 0 to 7 (93 packages, 291.5 agent-days + 20-25 percent integration, about 11 to 13 calendar weeks with 6 agents); sidecar-only packages dropped (S2, A3, A4, A5, A7, P3b, N2, B2 mirror, I10, R1-R4 sweeps); 1.3-1.6 packages folded in; new packages: F1-F14 foundation, SP6 + U2 + U5 custom update window, W1 caption buttons, F6 Electron singleton compat, X1 script migration, R1 Electron removal. ARCHITECTURE.md rewritten for the single Rust process. |
| 2026-11-06 | Wave 0 foundation (F1-F14) implemented on `tauri-1.2.0` | See "Wave 0 report" below: 116 cargo tests, 3,946 vitest cases, smoke-tauri 26/26, Electron compat 7/7; F8 open, F11 / F12 partial; spikes SP1-SP9 not started |
| 2026-11-06 | Review findings on wave 0 fixed (3 major, 11 minor; none skipped) | See "Review fixes" below: 123 cargo tests, 3,951 vitest cases, smoke-tauri 34/34, Electron compat 21/21 (14 simultaneous-start offsets) |


## Wave 0 report (2026-11-06)

### Layout

- `src-tauri/Cargo.toml`: workspace (resolver 3, edition 2024, pins in `[workspace.dependencies]`, release profile lto thin / codegen-units 1 / strip / panic unwind), `rustfmt.toml` (width 130). All 19 crates exist; the domain crates are documented skeletons.
- `src-tauri/crates/unimux-app`: `tauri.conf.json`, `tauri.macos.conf.json`, `capabilities/`, `permissions/`, `build.rs` (app-command permissions, `dev_overrides` cfg), `src/main.rs` (start order), `context.rs` (AppContext), `ipc.rs` (mc_invoke, mc_send, mc_invoke_raw, mc_port_attach, mc_port_post, update_splash_*), `windows.rs`, `startup.rs`, `test_bridge.rs`, `commands/<domain>.rs` (one file per domain: app, state, window, os, pty, agents, mcp, files, git, github, ssh, sftp, db, accounts, update, plus fallbacks).
- How a package adds a command: in its `commands/<domain>.rs`, `r.invoke("git:status", move |call| async move { ... })` (or `r.send`, or `r.invoke_reply` for raw bytes). The router checks every registration against the contract, applies the guard, and a real handler replaces a wave-0 fallback. Events: `ctx.events.emit(Scope::Cell(id), "cell:hook", args)`. Ports: `ctx.ports.register("pty", owner)`. State: `ctx.state.change(...)` and `ctx.state.on_change(...)`.
- Generated: `src-tauri/gen/ipc-contract.json`, `src/renderer/src/bridge/contract.gen.ts`, `src-tauri/gen/messages.json`, `test/golden/*` (`npm run gen:check` fails on drift).
- Renderer: `src/preload/mcApi.ts` (the method table, used by the Electron preload AND the Tauri bridge), `src/renderer/src/bridge/transport.ts` + `mc.ts`, `vite.config.tauri.ts` (out/tauri-renderer, dev server 5174).

### Verified (Windows 11 26200, 2026-11-06)

| command | result |
|---|---|
| `cargo fmt --all --check` | clean |
| `cargo clippy --workspace --all-targets -- -D warnings` (default, with dev-overrides + test-bridge, and --release) | clean |
| `cargo test --workspace` (default, with the features, and `--release`) | 123 passed each (core 47 + 2 golden, ipc 24, state 33 + 3 golden, exec 7, platform 2, update 1, app 3); the release run covers the `cfg(not(dev_overrides))` branches and "release build ignores MC_DATA_DIR" |
| `cargo build --workspace` and `--release` | ok |
| `npm run build:check` | src-tauri/target/check/release/unimux.exe |
| `npm run build:release` | src-tauri/target/release/unimux.exe + bundle/nsis/unimux_1.2.0_x64-setup.exe (5.14 MB); grep counts release / check: `MC_DATA_DIR` 0 / 1, `MC_DEBUG_PORT` 0 / 1, `test_bridge` 0 / 2, `--remote-debugging-port` 0 / 1, `test-bridge` (capability) 0 / 1 |
| `npm run typecheck`, `npm test` | ok; 258 files / 3,951 tests passed (10 skipped as before) |
| `npm run build` (Electron) | ok; the Electron app starts and window.mc works (compat check) |
| `npm run gen:check`, `node scripts/porting-count.mjs --check` | up to date; 57 / 2,138 main-side cases done |
| `npm run ipc:report` | 6 / 245 methods implemented (state 3/3, app 3/5), fallbacks cell:alive and mcp:info |
| `npm run smoke:tauri` | 34/34 (after the review fixes; 26/26 before, three runs): a 1.1.4-shaped state.json in a scratch dir loads (2 projects, 3 grids incl. 2x2 and 3x2, visible), a renderer edit is saved atomically within 4 s in JSON.stringify form with unknown keys and key order kept, crash.log gets renderer reports and panics, McNotYetError for unported calls, the guard refuses update-gate, a second start exits 0, quit + restart keeps the edit, startup.log gets a line per launch, no Tauri files appear in the real profile. Screenshots: artifacts/tauri-smoke/*.png |
| `node scripts/check-electron-compat.mjs` | 21/21: Tauri refused while Electron runs on the dir and the reverse; the refused side never writes state.json; Electron and Tauri started together at 14 offsets (-40 to +1000 ms): always exactly one runs (Tauri wins up to +110 ms, Electron from +120 ms) |
| grep `3.0.0-alpha` in Cargo.lock / package-lock.json | none |

### Review fixes (2026-11-06)

All 14 confirmed findings of the wave 0 review are fixed; none was skipped.

| finding | fix | checked by |
|---|---|---|
| major: a state.json with a lone UTF-16 surrogate (JSON.stringify writes `\udXXX`, JSON.parse reads it) was treated as corrupt, renamed and replaced by defaults | `unimux_core::js_json::parse`: serde_json first, on failure every unpaired `\uD800-\uDFFF` escape becomes `\ufffd` (a Rust string cannot hold a lone surrogate; byte parity is kept for every other string). `read_state` uses it. The bridge makes every renderer payload well-formed (`wellFormed` in transport.ts, values and keys), because Tauri's own IPC parse would refuse the whole call | golden `test/golden/state-load.jsonl` (9 texts written by Node, lone high / low in values and keys, valid pairs, an escaped backslash) through parse and the whole load_state; store test; vitest; smoke: a fixture with half an emoji loads with no `state.json.bak-*`, a renderer edit with a lone surrogate is saved |
| major: a send refused before it was queued (not yet / refused / unknown) used a sequence number that never reached the SendQueue, so the next send waited the 2 s gap timeout (renderer-boot was 3074 ms) | `SendQueue::skip(label, session, seq)` fills the slot (pending items are `Option<T>`); `mc_send` calls it before returning the error | cargo `a_refused_send_does_not_hold_the_next_one`; smoke: reportError after two not-yet sends reaches crash.log in 35 ms; startup.log now shows renderer-boot 871-1062 ms |
| minor: `app_data_dir()` honoured %APPDATA% (Electron ignores it) | Windows: `dirs::data_dir()` (SHGetKnownFolderPath FOLDERID_RoamingAppData) only; doc fixed. Scratch runs keep using MC_DATA_DIR | code; smoke isolation check |
| minor: startup race when 1.1.x and 1.2.0 start at the same moment | under Electron's named startup mutex we look for the window again, take `<data dir>/lockfile` like Chromium (write, share read, delete on close; a held one means Electron owns the dir) and create our window before releasing it. The mutex name is NOT Chromium's `ChromeProcessSingletonStartup!`: Electron 45 uses `Local\<app name>ProcessSingletonStartup`, verified by holding candidate names while starting a scratch Electron app named unimux (only `Local\unimuxProcessSingletonStartup` made `requestSingleInstanceLock()` wait, 2.1 s) | check-electron-compat: 14 simultaneous-start offsets, always exactly one instance |
| minor: JS event listeners leaked in Rust on every reload | the transport tracks every subscription; mc.ts disposes them all on `pagehide` (not for a persisted bfcache page) | vitest (late listens too); smoke: 46 subscriptions before a reload, 0 at pagehide, events reach the reloaded page. Not measured: Tauri's internal listener table (pub(crate)) |
| minor: pty port posts could be reordered | port messages are batched per task and numbered per page load (`createPortPoster`); `mc_port_post(session, seq, kind, messages)` goes through a second SendQueue with lanes `<label>\0port:<kind>` | vitest batching/numbering; the SendQueue ordering tests |
| minor: SendQueue::forget / Ports::detach_window never called | `forget_on_destroy` (WindowEvent::Destroyed) on the main window builder (W5 adds it to detached windows) calls `AppContext::window_destroyed`: send and port lanes (forget also drops `<label>\0...` sub-lanes, so the worker task ends), port sinks, detached registration | cargo `forget_removes_the_window_and_its_sub_lanes`; smoke: test-bridge `lanes` = 1 send lane |
| minor: Uint8Array never used the raw path; nested binary results had no defined form | the transport sends a Uint8Array / ArrayBuffer argument as the raw body of `mc_invoke_raw` (`mc-cmd`, ASCII-escaped `mc-args`, `mc-raw-index` headers). Binary results: `Reply::Binary { value, parts }` and `Reply::Bytes` leave as one frame (`unimux_ipc::binary`: `MCB1`, header length, `{value, parts}` with `{"$mcBytes": i}` placeholders, the parts), decoded by `decodeBinaryReply`; ARCHITECTURE section 3 documents it | cargo binary tests; vitest (notes.saveImage headers, a nested frame); smoke: notes.saveImage reaches the router through mc_invoke_raw |
| minor: release capability granted test_bridge | `allow-test-bridge` moved to `capabilities-check/test-bridge.json`; build.rs picks `./capabilities*/*.json` only with the test-bridge feature, else `./capabilities/*.json`. `allow-mc-invoke-raw` stays: the bridge uses it now | release binary has no `test-bridge` capability string; the check build has it and the smoke uses it |
| minor: macOS reused Electron's entitlements | own `crates/unimux-app/entitlements.mac.plist`, empty dict with the reason; packages add keys when they prove the need | config (macOS not built yet) |
| minor: CI release check only grepped `--remote-debugging-port` | fails on `MC_DATA_DIR`, `MC_DEBUG_PORT`, `test_bridge` on every OS; `--remote-debugging-port` on Windows only (built in cfg(windows) only) | local grep counts above |
| minor: CI never clippy'd / tested the release-only code of unimux-app | `cargo clippy --workspace --all-targets --release -- -D warnings` and `cargo test --workspace --release` replace the core/state-only release test | run locally: clean, 123 passed |
| minor: Tauri's drag-drop handler broke HTML5 drag and drop on Windows | `.disable_drag_drop_handler()` on the main window builder (OS file paths come with W3) | code; HTML5 drags are not exercised by a script yet (W3 real-app list) |
| minor: the guard's "top-level frame only" rule was never enforced | `Caller.main_frame` removed. The guard now also compares the IPC request's `Origin` header (from `tauri::ipc::Request`) with the page origin, which refuses a cross-origin frame; a same-origin iframe cannot be told apart by a Tauri command, so the docs (guard.rs, ARCHITECTURE, PLAN F2) say it rests on the CSP and on the renderer creating no iframes (it creates none) | cargo `a_request_from_another_origin_is_refused`; smoke: real requests carry `Origin: http://tauri.localhost` and are allowed, a probe with another origin is refused |

### Open issues after wave 0

1. **F8 not started**: no normalizeState port. Valid 1.1.4 states pass unchanged; the renderer-edit normalizers (layout repair, cell limit, SFTP places, scrollback, alerts, ssh/db normalizers, workspace order) are missing, so a renderer edit is stored as merged.
2. **Windows SDK** is not installed (see install status). Builds work through `scripts/msvc-run.mjs` and a user-level SDK copy; CI runners have the SDK.
3. **CI never ran** (branch not pushed). macOS was never compiled; the Unix code paths (instance socket, process groups, setsid) are untested.
4. F11: no StartupGate trait / update-gate window yet, the native title bar is kept (W1), Ctrl+R / F5 / zoom / minimize behaviour is not checked by a script, renderer crash handling is W6.
5. Quit is the plain Tauri exit plus a final state flush: no quit confirmation, wind-down registry or session-end handling (W6).
6. Cells show "cell:spawn is not available yet" and the status bar shows the update:get not-yet error: expected until P4 / U1.
7. `pathForFile` returns '' in Tauri (an HTML5 File has no path in WebView2) until W3 adds `pathsForFiles`.
8. The installer file name is Tauri's default (`unimux_1.2.0_x64-setup.exe`); U4 renames it to `unimux-Setup-X.exe`.
9. The golden corpus covers state merge/diff, translate and temp names only; normalize, routeMessage, launch lines and the update progress model come with their packages.
10. Detached windows, the gate and the update window are not created yet, so the guard's detached registration and the destroy cleanup (`forget_on_destroy`) are only unit-tested and wired on the main window.
11. HTML5 drag and drop (tab reorder / detach, snippets, notes, tree, SFTP) is enabled again by `disable_drag_drop_handler()` but no script drags yet; W3 adds the real-app drag checks with the OS file drop.
12. The macOS half of the startup race (Electron's SingletonLock / SingletonSocket) is still R3; the Windows half (startup mutex + lockfile) is done.

### Open issues: SP7

1. russh pins ssh-key `=0.7.0-rc.11` (a release candidate); a russh update moves it, rerun `cargo test -p unimux-ssh --test sp7_keys` and the matrix.
2. S2 must add the refusal checks before russh (PKCS#8, explicit-curve EC, PPK v3, PPK v2 non-RSA, chacha20-poly1305 key files, camellia PEM); explicit-curve EC detection and the chacha20 refusal are described in SP7.md but not prototyped.
3. The matrix compared the 1.1.4 modules (SshLogin, KnownHostsStore) under this tree's Electron 45 runtime, not an installed 1.1.4 app; macOS not run.
4. OpenSSH 9.8+ `PerSourcePenalties` blocks repeated failing test logins; the SP7 configs turn it off and S4's CI matrix must too. CentOS 6 (OpenSSH 5.3) does not run on WSL2 (vsyscall), so the oldest real build is OpenSSH 5.9.
5. The unimux-ssh dev-dependencies (russh, ssh-key, aes, cbc, des, md5) become normal dependencies in S2/S3; the prototype `legacy_pem` moves from tests/sp7_keys.rs into the crate.

### How to run

- Dev: `npm run tauri dev` (Vite on 5174 + a debug build; MC_* overrides are on in debug builds). Not exercised in wave 0.
- Check flavour (what the scripts drive): `npm run build:check`, then `npm run smoke:tauri` (`--keep` keeps the scratch dir) and `node scripts/check-electron-compat.mjs` (after `npm run build`).
- Manual run on scratch data: `MC_DATA_DIR=<scratch> MC_DEBUG_PORT=9333 src-tauri/target/check/release/unimux.exe` (add `MC_OFFSCREEN=1` for a window that never takes focus); DevTools at http://127.0.0.1:9333.
- Release flavour: `npm run build:release` (unsigned NSIS installer; the MC_* overrides are compiled out, so it always uses %APPDATA%\unimux: do not run it for tests).
- cargo directly: `cd src-tauri && node ../scripts/msvc-run.mjs cargo test --workspace` (loads the MSVC environment and the SDK fallback).

## Do zainstalowania / do decyzji użytkownika

### Decyzje podjęte 2026-11-06

1. Wszystko naraz: 1.2.0 wychodzi dopiero, gdy cała aplikacja jest w Rust + Tauri v2 i działa jak 1.1.4. Bez sidecara Node.
2. Wygląd zostaje: przyciski okna na Windows rysowane tak, żeby wyglądały jak dziś; własne okno aktualizacji (postęp, etapy, restart) także przy aktualizacjach między wersjami Tauri.
3. latest.yml i latest-mac.yml publikowane przy każdym wydaniu (aktualizacja z Electron 1.1.x do 1.2.0).
4. Klucz podpisywania aktualizacji wygenerowany, sekrety GitHub ustawione.

Szacunek: około 290 dni pracy agentów + 20-25 procent na integrację, czyli realnie 11-13 tygodni przy 6 agentach równolegle. Wersja testowa do sprawdzenia przed wydaniem.

### Nadal otwarte

1. **macOS: identyfikator com.ajzakomator.app zostaje** (zachowuje uprawnienia systemowe i zgodność z aktualizatorem 1.1.x). Po aktualizacji macOS raz zapyta o dostęp do pęku kluczy ("Zawsze zezwalaj"). Akceptujesz?
2. **Plan awaryjny.** Jeśli testy przejścia (SP3/SP4) nie wyjdą, potrzebne będzie wydanie pomostowe 1.1.5 na Electronie. Zgoda?
3. **Kopia testowych danych 1.1.4** (KOPIA, nie oryginał `%APPDATA%\unimux`) albo zgoda, żebym utworzył syntetyczne dane w 1.1.4 pod `MC_DATA_DIR` z testowymi hasłami SSH/DB i tokenem GitHub.

### Do zrobienia po Twojej stronie (gdy będzie potrzebne)

1. **Obraz Windows dla VirtualBox** (np. oficjalna maszyna deweloperska Windows 11 albo ISO z licencją) do testu aktualizacji 1.1.4 -> 1.2.0 (spike SP3, potem U3). Nigdy na Twoim prawdziwym profilu.
2. **Dostęp do Maca** (Apple Silicon, Xcode Command Line Tools, Rust) do testu pęku kluczy, aktualizatora 1.1.4 -> 1.2.0, okna aktualizacji i ręcznej listy kontrolnej (SP2, SP4, R3).
3. **Kopia zapasowa klucza podpisywania offline.** W folderze `D:\Projekty\_unimux-tauri-keys` leży też plik z hasłem; warto przenieść hasło do menedżera haseł i zrobić kopię klucza na nośniku offline (utrata klucza = koniec aktualizacji dla wersji Tauri). Agenci nie czytają tych plików.
4. **Brakuje Windows 11 SDK** (sprawdzone 2026-11-06: nie ma kernel32.lib ani rc.exe). Proszę doinstalować w instalatorze Visual Studio składnik "Windows 11 SDK" (obciążenie "Programowanie aplikacji klasycznych w C++"). Do tego czasu buildy używają kopii SDK z oficjalnych pakietów NuGet Microsoftu w `%LOCALAPPDATA%\unimux-build` (po instalacji SDK można ten folder usunąć).
5. Akceptacja wersji testowej przed wydaniem i przeczytanie `docs/releases/1.2.0.md`.
