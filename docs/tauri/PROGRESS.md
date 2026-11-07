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
| 2026-11-06 | **`Local State` without a usable key: match 1.1.4.** A missing `encrypted_key`, a DPAPI key that does not unwrap or a non-object file gets a new key with the other prefs kept; a non-JSON file goes to `Local State.bad` first; only a key in an unknown format stays unavailable. | SP2 review (parity rule) | ARCHITECTURE section 7, PLAN B2, spikes/SP2.md; unimux-oscrypt `Origin::Replaced`; verified against real 1.1.4 (spike checks F/G/H). |
| 2026-11-06 | **Keep publishing latest.yml / latest-mac.yml** so Electron 1.1.x installs update into 1.2.0. | user | U3 transition, U4 asset list, every release from now on. |

Still open (see the Polish section at the end): macOS identifier com.ajzakomator.app + one Keychain prompt, fallback bridge release 1.1.5 if SP3/SP4 fail, Mac access, VM image, 1.1.4 test data, the SP1 acceptance substitute, SP5 criterion 4 (60 fps under a 20 x 1 MB/s flood) partly met.

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
| F8 | State normalize port | verified (Windows) | 2026-11-06 | 2026-11-06 | 2026-11-06 | branch `tauri-pkg-F8`. unimux-state `normalize/` (js, settings, shortcuts, grid, remote, windows, state): defaultState, normalizeState with every normalizer it calls (profiles + RETIRED_PROFILES, language rule, settings incl. alerts migration / autoSwitch / delegation / shortcuts / bar items / side panels, projects / repairTab / cleanCells, unique grid ids, active fallbacks, presets, notes, prompt queues, SSH hosts / identities / cell refs, SFTP places, DB connections + folder colours, workspace order, detached windows, pruneAutomation) and `normalizeEditedState` (extracted from src/main/stateController.ts apply, Electron behaviour unchanged), with JS semantics (UTF-16, JS trim, Object.prototype names, throws -> corrupt). `StateNormalizer` replaces PassThrough in the app (load + every renderer edit). `js_json::parse` now orders array-index keys like JSON.parse. Corpus: 1,258 normalize rows (win32 + darwin) and 234 after-edit rows (44 errors, cell limit included) byte-identical to TS; a normalized 1.1.4 state loads and saves unchanged (1,015 stable rows); controller ports of 3 state-edits cases; PORTING.md +4 ported. Real app (`node scripts/verify-tauri-normalize.mjs` after `npm run build:check`): 11/11, load at revision 0 equals normalizeState + unlessRestoring, renderer edit equals normalizeEditedState, cell limit refused, restart loads like 1.1.4; smoke-tauri 34/34. cargo fmt / clippy -D warnings (core, state, app) / cargo test --workspace, typecheck, vitest 3,951 (4 timing tests flaked under the parallel release build, pass alone), npm run build, gen:check. Review fixes: the inbox retention sort is a port of V8's Array.prototype.sort (timsort.rs: TimSort, binary insertion under 8 elements, NaN as +0), so a project over 500 items with damaged readAt / updatedAt orders like 1.1.4 instead of panicking `sort_by` on a non-total order (the old comparator panicked on the new rows); load_state counts a normalizer panic as a corrupt file (.bak / defaults, not a crash loop); the edit normalization reads an own `length` of an object `cells` / `areas` like TS (ToNumber for the limit, `===` for the match, layoutForCount of the number). Corpus +24 retention rows (1,282 normalize rows), +34 `length`-shape edit rows (268), new js-sort.jsonl (400 V8 sort orders with NaN keys; a 20,000-row scratch fuzz up to 3,000 items matched too). After the fixes: cargo test -p unimux-state 48 + 7 golden, cargo test --workspace (unimux-exec output_over_the_cap timing test flaked under the parallel run, passes alone), clippy -D warnings, fmt, typecheck, vitest 3,950 (background-stop timing test flaked, passes alone), gen:check, verify-tauri-normalize 11/11 (one run hit a session field race in the restart check, the next passed), smoke-tauri 34/34. Open: F8a, F8b, F8d, F8e below |
| F9 | State edits, patches, broadcast, state commands | done | 2026-11-06 | 2026-11-06 |  | mergeStateEdit, diffState / applyPatch, the state:changed broadcaster (16 ms batching, flushed before every other event), state:load / snapshot / edit; detachedWindows always from main. 400 merge + 400 diff golden cases byte-identical to TS (they found the JS Map last-wins rule for repeated ids). Open: edit normalizers (F8), vitest fixture of Rust patches through the renderer applyStateChange |
| F10 | Golden corpus, PORTING.md, messages export | done (corpus partial) | 2026-11-06 | 2026-11-06 |  | dump-goldens.mjs (default-state, state-merge, state-diff, translate x 6 languages, atomic-write names), gen-messages.mjs + Rust translate (2,720 rows), test/PORTING.md + porting-count.mjs (baseline 2,138 main-side cases in 140 files, 57 done), `npm run gen:check`. Open: normalize, routeMessage, launch lines, update-progress goldens |
| F11 | Main window, startup gate order, window state, WebView settings | done (partial) | 2026-11-06 | 2026-11-06 |  | main window created in code (1600x1000 / 1100x700 offscreen, min 800x500, #0d0d0d, hidden until page load or renderer-boot, 5 s fallback), __MC_BOOT__ init script, identical browser args for every webview, WebView2 data folder DATA_DIR/webview2, default context menus / browser accelerators / zoom / status bar off, devtools only with dev overrides, NonClientRegion support on, window:shown + window:maximized, offscreen shows without activation. Native title bar kept until W1. Open: StartupGate trait and the update-gate window (only the hook point in setup), automated key / zoom / minimize checks |
| F12 | CI skeleton | done (not run) | 2026-11-06 | 2026-11-06 |  | .github/workflows/tauri.yml: Windows + macOS checks (gen drift, porting check, 3.0.0-alpha grep, typecheck, vitest, fmt, clippy x2, cargo test incl. --release), 3 build jobs with the U4 names, release asserts no --remote-debugging-port, artifacts. Not pushed, so no CI run yet; macOS never compiled |
| F13 | Real-app harness base | done | 2026-11-06 | 2026-11-06 | 2026-11-06 | scripts/tauri-app.mjs (check build only, scratch home + data dir, CDP client, kill of our own tree, real-profile markers), scripts/smoke-tauri.mjs 26/26 (3 runs), test-bridge commands state / flush / paths / emit / panic / probe / report / quit. Open: X1 moves the 44 verify scripts |
| F14 | Exec helper and env | verified (Windows) | 2026-11-06 | 2026-11-06 | 2026-11-06 | unimux-exec: CREATE_NO_WINDOW, suspended start + Job Object kill-on-close (tree killed on timeout / cap), process group on Unix, cleanEnv, raw command lines, 256 KiB caps, timeouts, spawn_detached with breakaway fallback; 7 tests. Open: macOS run, survives-app-exit test for detached launches |

### Wave 0b: spikes

| id | title | status | started | done | verified | notes |
|---|---|---|---|---|---|---|
| SP1 | WebView2 shell behaviour | done (Windows, acceptance substituted; user decision pending) | 2026-11-06 | 2026-11-06 | | branch `tauri-pkg-SP1`, docs/tauri/spikes/SP1.md, reference run `node scripts/spike-sp1.mjs --long` 27/27, committed as docs/tauri/spikes/SP1-results.json: same browser args on 2 windows ok, different args give 0x8007139F; wry never sets IsVisible(false) on minimize, the 400 ms status tick stays exact minimized like a user (WM_SYSCOMMAND, WS_VISIBLE + iconic, gated on the window state) for 390 s, hidden (SW_HIDE) and never shown (1176/1176 in 471 s, gated) (no Rust tick needed; never call Webview::hide()); hidden window reaches renderer-boot; IPC = http://ipc.localhost custom protocol (300 fetches / 300 invokes, 0 postMessage) under the F2 CSP. **PLAN acceptance as written (Channel p50 < 2 ms into 20 xterm at 20 x 1 MB/s) not met by any transport**; substitute (recorded in the PLAN SP1 row, needs the user's OK): transport-only WebView2 shared buffer p50 0.31 ms +-0.81 ms clock bound / p95 3.7 ms (tauri Channel 2.7 ms p50 / 129 ms p95); into-xterm criterion moved to SP5. The shared buffer has no renderer backpressure (P2 must gate it with a page release ack + FlowGate; P2 acceptance extended). **Open blocker for macOS: WKWebView IPC check not run** (no Mac, CI not run); macOS data plane not measured. Review fixes 2026-11-06: user-like minimize/hide in the harness, window-state and never-shown gates, clock recalibrated per bench with its bound, no second post on a slow UI thread, guard label fix; cargo test --workspace (test-bridge) 128/0, clippy -D warnings clean, typecheck + vitest 3951 passed |
| SP2 | Electron safeStorage both directions | verified (Windows) | 2026-11-06 | 2026-11-06 | 2026-11-06 | spikes/SP2.md. Real 1.1.4 (Electron 45.2.2) on a scratch MC_DATA_DIR: SSH password, SSH key secret, DB password, GitHub token decrypt in Rust; Rust re-encryptions decrypt in 1.1.4 (nothing locked, files and key untouched); Rust-created `Local State` is kept by 1.1.4 byte for byte once wrapped like Chromium (description `Chromium`, CRYPTPROTECT_AUDIT, `audit_enabled`). v10 confirmed, no v20. Keychain names from source: `unimux Safe Storage` / `unimux Key` (+ legacy `unimux` migration). `scripts/spike-sp2-safestorage.mjs` 39/39, unimux-oscrypt 24 tests, fixtures committed. Review fixes: unique temp names + single-flight `Cipher::open` (concurrent first opens lost the key), temp file removed on every error path, a `Local State` without a usable key handled like 1.1.4 (new key, other prefs kept, `Local State.bad` for non-JSON; checked against real 1.1.4, checks F/G/H), macOS `Origin` tells Created / Migrated. Open: Mac half (needs a Mac) |
| SP3 | Windows 1.1.4 -> Tauri NSIS hand-over | todo | | | | needs the VirtualBox Windows VM image |
| SP4 | macOS 1.1.4 engine accepts the Tauri zip | todo | | | | needs a Mac |
| SP5 | Rust ConPTY + Channel | done (partly verified) | 2026-11-06 | 2026-11-06 | | branch `tauri-pkg-SP5`, findings in spikes/SP5.md. Own windows-crate ConPTY wrapper in unimux-pty (bundled conpty.dll 1.23, flags 0 + Release like node-pty, Job Object, close off-thread while draining, writer thread, TimerResolution), frames + per-window batcher + byte-ack flow gate, check-only spike commands. Met: render parity (PowerShell, Claude Code, resize reflow, win32-input-mode, focus 1004), 50 close-under-flood rounds no deadlock, idle echo at or below 1.1.4 in all interleaved pairs. Partly: 20 x 1 MB/s at 60 fps (met with the 16 ms batcher for synthetic 20 MB/s and for most ConPTY runs; runs where ConPTY passed 13 to 20 MB/s dropped 45 to 72 frames over 50 ms, 1.1.4 drops more). See SP5 open issues. Review fixes (2026-11-06): with the dll + Release the exit is reported when the output pipe ends, so a `start /b` child that outlives the shell keeps running and printing as in 1.1.4 (the 1 s close stays for the in-box API only); kill in node-pty's order (input, ClosePseudoConsole, TerminateProcess(shell, 1), then TerminateJobObject); job without kill-on-close, so detached programs survive a shell that ended by itself; Job created before the pseudoconsole, a Drop on Shared closes a pseudoconsole a failed spawn left, ResumeThread checked, threads started writer, waiter, reader; plane: a respawn mutes the old pty's data and exit frames, an entry whose exit came before its insert is dropped, flow counter, paused flag and gate change under one lock. New cargo cases: start /b child after shell exit, detached child survives a normal exit and dies with a kill, close alone under flood with a paused reader, plane respawn without stale frames (fails on the old code), 40 terminals ending at once leave the plane empty. Verified: cargo test -p unimux-pty 18 of 18 (twice, parallel), clippy clean, npm test 3951 passed, run.mjs render / close / latency / flood (20 cells exited in 246 ms, idle echo p50 1.6 ms, flood 179 fps over50 0) |
| SP6 | Custom update window process | done (Windows verified, macOS open) | 2026-11-06 | 2026-11-06 | 2026-11-06 (Windows) | `node scripts/spike-update-window.mjs --build`: after the review fixes (rebased on tauri-1.2.0) 88/88 in 3 consecutive full runs (cases main, guard, failed, headless; scratch install dirs, spike product `unimux-sp6`), `--visible` 51/51, `--prestage` 32/32; copy `unimux-update.exe`, installer `/S /UPDATE --updated /D=` through ShellExecuteExW, never topmost / never focused, supervision independent of WebView2 and after the timeout; findings and timings in spikes/SP6.md; macOS swap + `codesign --verify` and the real UAC prompt not done (no Mac, no VM). See "SP6 open issues" |
| SP7 | russh coverage | verified (Windows), review fixed | 2026-11-06 | 2026-11-06 | 2026-11-06 | docs/tauri/spikes/SP7.md. Keys: 116-file corpus (ssh-keygen 10.0p2, OpenSSL 3.5.7, PuTTYgen 0.83, 1.1.4's generateKey, 3 hand-made DEK-Info files) vs the real 1.1.4 parsePrivateKey under Electron 45, each with no / the right / a wrong passphrase: 76 accepted; the S2 prototype `port_parse` (1.1.4 text checks, refusals, `legacy_pem` for traditional PEM: AES-128/192/256-CBC and -CTR, DES-EDE3-CBC, BF-CBC; then russh 0.65.1) gives all 348 answers identically (ok + metadata or the error code); russh alone loads 57 of the 76 (19 PEM gaps) and 26 files 1.1.4 refuses (both lists asserted); PPK v2 through ssh-key (no own parser); malformed DEK-Info never panics. Servers (scripts/sp7/matrix.mjs, Docker, containers and images removed by id): OpenSSH 10 current / old offer / SHA-1 only / CBC only, OpenSSH 5.9, Dropbear 2025 x2, Dropbear 2016; real 1.1.4 SshLogin under Electron 45 vs the russh probe (SshLogin method order over the server's lists, 1.1.4 offer): same outcome and SshErrorCode, the same methods sent and the same algorithms in all 104 logins, 21/21 host keys byte-identical to the 1.1.4 known_hosts.json entries; russh DEFAULT fails on the OpenSSH 5.x/6.x offer (no common MAC), so S3 uses `ssh2_preferred()`; connect to authenticated p50 81 ms (ssh2) vs 80 ms (russh) |
| SP8 | MCP wire with real CLIs | verified (Windows) | 2026-11-06 | 2026-11-06 | 2026-11-06 | **Decision: custom dispatcher on hyper 1.12 / axum 0.8.9, no rmcp** (spikes/SP8.md). Prototype `crates/unimux-mcp/examples/sp8/custom.rs`: 52 / 52 HTTP-level cases identical to the 1.1.4 TS server (rmcp 3.9: 7 / 52); Claude Code 2.1.319 and codex-cli 0.162.1 on a scratch home with mock models: tools/list + tools/call + progress + elicitation round trip (Claude cancel and hook accept, Codex decline) + abort 1 ms after a killed CLI closes its connection; cargo `sp8_wire` 10 tests + 2 unit tests. Review fixes (2026-11-06): tasks/list cursor paging, ttl restarted on completion / cancel and abort on expiry, `notifications/cancelled` for a timed-out or aborted elicitation, no answer for a client-cancelled request, strict JSONRPCMessageSchema, lossy UTF-8 body, 1.1.4 error texts (no prefix on "has no result stored", zod issues for bad method params), elicitation answer validation, session-scoped tasks, no session for a token revoked mid-body. Open: see "Open issues after SP8" |
| SP9 | DB wire fidelity | verified (Windows) | 2026-11-06 | 2026-11-06 | 2026-11-06 | docs/tauri/spikes/SP9.md. Value goldens byte-identical to 1.1.4 (written through the real 1.1.4 DB host): PG 13.23 + 18.6 39/39 statements on both paths, MySQL 8.4.13 28/28, MariaDB 11.8.9 29/29, Redis 8 39/39, plus startup / connect bytes and logins. Custom paths: PG own frame layer (3.2 BackendKeyData, NegotiateProtocolVersion, lossy strings, node-postgres' CopyFail text), MySQL own framing / COM_QUERY in the session charset / column parser (MariaDB extended metadata, names in the column charset) / mysql2's LOAD DATA LOCAL error, Redis own RESP2 client (resumable reader, `RedisConn` with fail-all-pending and no resend, `reconnect` 300 / 1000 / 2000 ms; connect bytes and drop / reconnect measured on it; redis crate dropped: non-UTF-8 status lines end its connection, 500 ms default timeout). All serverText cuts keep a split high surrogate like JS. Review fixes 2026-11-06 (3 major, 7 minor findings, all fixed): see SP9.md. Spike code in unimux-db `wire/`; `node scripts/spike-db-wire.mjs` (own Docker containers, `--rm`, removed by id also on Ctrl+C; server tests `#[ignore]`d in a plain cargo test) |

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
| D3 | SQL helper ports | verified (Windows) | 2026-11-07 | 2026-11-07 | 2026-11-07 | branch `tauri-pkg-D3`. unimux-db `sql/` (mod: quoting, limits, DbSqlError, ValueKind, StagedEdit, redactSql; `split`: splitSql postgres / mysql (DELIMITER, routine bodies, executable comments) / sqlite (trigger bodies), statementAt, errorSpan; `pg`: firstKeyword, codeOnly, returnsRows, isReadStatement, readOnlyAllows, endsTransaction, edit / page / cell builders, inlineParams, editPreview, valueKind; `sqlite` and `mysql`: their equivalents incl. affinities, bound params, literals, field / column kinds, timeouts, flavour, error texts and positions; `values`: formatDbValue, parseDbInput, CSV / TSV / JSON export with a V8-like JSON.parse) and `redis_shared` (RedisData, base64 like atob, console line parser, quoteRedisArg, command classes, INFO / keyspace / CLIENT LIST, stream ids), unimux-core `utf16` (len, slice, indexOf, JS trim; `wire::value::utf16_len` re-exports it). All offsets and limits in UTF-16 units. Vectors: `scripts/goldens-db.mjs` (via `npm run gen:goldens`, checked by `gen:check`) writes test/golden/db-sql.jsonl (110.7k rows, 64 functions: the cases of db-sql / db-sqlite-shared / db-mysql / db-redis-shared plus seeded random scripts, names, pages, cells and edits; about 30k of them through the six read-only / read checks) and db-redis.jsonl (8.9k rows, 19 functions); `cargo test -p unimux-db --test sql_golden` answers every row like TS, `test/db-sql-vectors.test.ts` runs the same rows through the TS code. Bugs the vectors found and fixed: `\X...` hex values (the `/i` flag) were refused, `__proto__=` in CLIENT LIST was kept. Plus an 8 MiB script (DB_LIMITS.sql) split in all 3 dialects and through the checks in about 3 s, and 8 MiB statements of block comments / parentheses through firstKeyword in about 0.1 s each. Review fixes (exact toFixed for huge MariaDB timeouts, linear firstKeyword, the JSON nesting cut-off recorded as open issue 6): see "D3 open issues". Verified: cargo fmt, clippy -D warnings (unimux-db, unimux-core, all targets), cargo test -p unimux-db -p unimux-core, npm run typecheck, npm run gen:check, npm test 3,946 passed, 9 failed: real-shell PowerShell ConPTY tests (launch-reset.int, ptyhost.int) and one timing test each in context-usage and mcp-protocol, under machine load with empty shell output; the set varies between runs, ptyhost.int, context-usage and mcp-protocol pass alone, launch-reset.int still times out on empty PowerShell output here; no D3 change touches them. See "D3 open issues" |
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
| 2026-11-06 (wave 0b merged) | 6 / 245 (+2 fallbacks; contract 248 incl. 3 sync members) | 4 / 44 emitted | 69 / 2,146 | 0 / 44 (smoke-tauri 34/34, check-electron-compat 21/21, spike-sp1 25/25, sp5 render + close ok) |

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
| Windows 11 SDK | installed (10.0.28000, checked 2026-11-06: kernel32.lib under Windows Kits\10\Lib\10.0.28000.0; `scripts/msvc-run.mjs` now takes the installed SDK from vcvars and no longer needs the user-level copy in `%LOCALAPPDATA%\unimux-build\winsdk-10.0.28000.2957`, which can be deleted) |
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
| 2026-11-06 | Wave 0b integration: F8, SP1, SP2, SP5, SP6, SP7, SP8, SP9 merged into `tauri-1.2.0` (with their review fixes) | See "Wave 0b integration" below: fmt / clippy x3 clean, cargo test 244 / 249 (features) / 244 (release) passed, 8 Docker-only ignored; vitest 3,952 passed; smoke-tauri 34/34; Electron build + compat 21/21 |


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

1. ~~F8 not started~~ Done on `tauri-pkg-F8` (see the F8 row). What is left of F8:
   - F8a: the corpus has no anonymized real user state files (the rules forbid reading %APPDATA%\unimux); the realistic inputs are the 118 states the vitest suite hands to normalizeState, a hand-made 1.1.4 state using every domain and their damage. A user who wants to can drop anonymized files into the seeds.
   - F8b: an optional field the TS code sets to `undefined` (sshStatusBarItems, sidePanels, a cell's profileId `constructor`) is absent in Rust. On disk that is identical; in memory a later `{...settings, x}` puts the key at the end in Rust where JS keeps its old slot, so the next save can order that one key differently from 1.1.4. Not seen in the corpus (after-edit rows are byte-identical).
   - ~~F8c~~ fixed: the inbox retention sorts with a port of V8's TimSort (normalize/timsort.rs), so NaN timestamps order like 1.1.4 and never panic (golden js-sort.jsonl and the retention rows of normalize-state.jsonl).
   - F8d: `linux` is not a Platform (only win32 / darwin are shipped); 1.1.4 never ran there.
   - F8e: the corpus is 11 MB (normalize-state 7.3 MB, after-edit 3.8 MB, seeds 0.2 MB); `npm run gen:check` regenerates it in about 10 s.
2. ~~Windows SDK missing~~ installed 2026-11-06 (see install status).
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

### Open issues after SP1 (2026-11-06)

0. **User decision needed: the SP1 acceptance substitute.** As written ("Channel p50 < 2 ms at 20 x 1 MB/s", into 20 xterm) it is not met by any transport. Proposed: transport-only p50 + clock bound < 2 ms with the WebView2 shared buffer (met: 0.31 +-0.81 ms), the into-xterm criterion moves to SP5, the WKWebView item to W2. Until the user agrees SP1 stays "done (acceptance substituted)", not verified.
1. **WKWebView IPC not checked (open blocker for macOS)**: the SP1 scope item "WKWebView in CI uses the same IPC" was not run (no Mac, CI never ran, no CDP on macOS; needs the W2 eval bridge). Tauri 2.12.5 uses `ipc://localhost` there by default, which the CSP allows.
2. **macOS data plane not measured**: WKWebView has no shared buffer; the plan is the pull transport (raw invoke long poll, 2.8 ms p50 transport-only on WebView2, best into xterm) until SP5 / W2 measure it on a Mac.
3. **Renderer limit**: 20 xterm parse 20 x 1 MB/s with no IPC at 109 fps / 22.8 ms p50 on a moderately loaded dev box, but only 20 fps at 94-100 percent machine CPU; the FlowGate (P2) must hold producers back, and SP5's 60 fps target has to be compared with Electron 1.1.4 on the same machine and load.
4. **No renderer backpressure in the shared-buffer sender**: "one post in flight" only waits for the WebView2 UI thread, not the page; into a saturated renderer the posts queue with about one frame each (18,369 posts for 19,200 frames, 39 ms arrive p50, 36 fps, worse than pull's 26.6 ms / 133 fps). P2 adds a page-side release ack capping the buffers in flight per window plus the FlowGate byte acks; its acceptance now checks that the posts in flight stay bounded. SP5 compares the gated sender with pull into xterm.
5. The shared-buffer sender exists only as the check-build bench (`channel_bench.rs`); P2 builds the production one (per-window sender, renderer gate as in 4, fallback to Channel when `ICoreWebView2_17` is missing, bridge `sharedbufferreceived` -> fake port, a UI thread slower than 2 s waited for and counted, never answered with a second post).
5a. Harness: in offscreen runs tao's `minimize()` / `hide()` act on tao's VISIBLE flag, which the raw `SW_SHOWNOACTIVATE` show leaves unset (`minimize()` then hides the window, `hide()` does nothing). Real-app checks that need a user-like window state use the test_bridge `window` actions `sysMinimize` / `sysRestore` / `sysHide` and gate on the read-back state.
6. `unimux-exec` `output_over_the_cap_is_truncated_and_the_tree_ends` failed once (20 s timeout) in a full workspace run at 100 percent machine CPU and passed on rerun; not touched by SP1, looks load-sensitive.

### SP2 open issues

1. **Mac half not run** (no Mac): the Keychain round trip with 1.1.4 on macOS, the one "Always Allow" prompt for the re-signed binary, and the legacy-account migration. The macOS code is compiled and clippy clean for aarch64-apple-darwin and its crypto matches Node vectors byte for byte, nothing more. The spike script is Windows-only and needs a small launcher port for the Mac run.
2. Resolved (review 2026-11-06): the earlier expectation ("Electron stays unavailable, no new key") was wrong. Chromium's OSCryptImpl::Init generates and stores a new key on kKeyDoesNotExist and kDecryptionFailed, and real 1.1.4 does so on a DPAPI blob nobody can unwrap (spike check F) and on a non-JSON file (moved to `Local State.bad`, check H). Rust now does the same (`Origin::Replaced`, checks G/H; 1.1.4 keeps the key Rust stored). Not measured with a real second Windows account: the foreign key is simulated with a DPAPI blob that does not unwrap (CryptUnprotectData 0x8007000D), which is the same code path.
3. B2: when to touch the Keychain first on macOS (`Cipher::open` is eager today), the callers and IPC, `MC_SSH_NO_SAFESTORAGE` through DevOverrides, `Origin` in startup.log.

### SP5 open issues

1. Echo under a 19-cell flood is slower than 1.1.4 in the median (13 to 28 ms vs 9 to 13 ms): the renderer main thread works through xterm's write queues of the other terminals (1 MiB unacked each). P2: smaller unacked window for unfocused terminals or pausing them while the focused one is typed into; re-measure with `scripts/sp5/run.mjs latency --load=19` vs `scripts/sp5/electron-grid.mjs 20 1000000 5 --latency=60`.
2. "20 cells at 1 MB/s keep 60 fps" is not met when ConPTY passes 13 to 20 MB/s to xterm (the renderer saturates near 20 MB/s of parsing, in 1.1.4 as well); what ConPTY passes varies from 1 to 24 MB/s between runs (it drops lines that scroll past between its frames).
3. OpenConsole 1.23 holds a new terminal's first output until DA1 is answered (3 s without a renderer): P2 answers it host-side.
4. conpty.dll / OpenConsole.exe come from node-pty's third_party copy (node_modules) for tests and the check run (`UNIMUX_CONPTY_DIR`); P1 commits them under src-tauri/resources/conpty/x64 and wires the resource dir.
5. One unreproduced flake in about 15 runs of the conpty suite: `job_object_kills_the_whole_tree` saw no exit 5 s after kill once under heavy machine load (the assertion now prints the process exit and close state).
6. Renders compared by screenshot and scripted checks, not pixel-diffed; no pwsh on this machine (Windows PowerShell used, as 1.1.4's resolveShell would).
7. Unix pty and the macOS run are P1.

How to run SP5: `npm run build:check`, `cd src-tauri && node ../scripts/msvc-run.mjs cargo build --release -p unimux-pty --bins`, then `node scripts/sp5/run.mjs [render] [latency] [flood] [close]` (options in the file header); 1.1.4 references after `npm run build`: `node scripts/sp5/electron-ref.mjs`, `node scripts/sp5/electron-grid.mjs`, `node scripts/perf-latency.mjs 60 --json`; cargo: `node ../scripts/msvc-run.mjs cargo test -p unimux-pty`.

### SP6 open issues (2026-11-06)

Review fixes 2026-11-06 (branch rebased on tauri-1.2.0 at 6868341; details in spikes/SP6.md "Review fixes"): never always-on-top, shown inactive with a taskbar flash on every show (first show and error card), raw SW_HIDE (tao's hide() was a no-op after the raw show); installer through ShellExecuteExW (owner HWND, `runas` when the install dir is not writable, AllowSetForegroundWindow(ASFW_ANY) first); supervision starts with the process, independent of WebView2 (headless fallback, 3 s exit watchdog); supervision goes on behind the timeout card and still relaunches (1.1.4 `--force-run` outcome), closing that card only hides; own failed-install text; `runtime-<ver>.partial-<pid>` staging; per-hand-over `webview2-<id>` and a lock-guarded runtime cleanup.

Verified on Windows after the fixes: `cargo fmt --all --check`; `cargo clippy -p unimux-exec -p unimux-update -p unimux-app --all-targets -- -D warnings` with and without `dev-overrides,test-bridge`; `cargo test` of those crates (exec 8, update 12, app 6); `npm run typecheck`; `npm run gen:check`; `npm test` (3951 passed); harness 88/88 in three consecutive full runs, `--visible --case=main,guard` 51/51, `--prestage --case=main` 32/32.

1. macOS half of SP6 not done (no Mac): bundle swap from a temp-dir copy, `codesign --verify`; the window mode was never compiled on macOS (CI not run). Goes with U5 / R3.
2. The UAC path is tested for the decision only (icacls deny ACL); a real per-machine install with the consent prompt in front, and a real full-screen app staying in front, need the VM (U2/U4). The harness proves: never foreground, never WS_EX_TOPMOST, no activation.
3. The positive path with a different target version needs a second payload build (1.2.0 -> 1.2.0-test.1, U2); the guard case covers "an old build started mid-install writes no ready".
4. `work/shown` later than the 4 s SHOWN_WAIT still happens on the loaded machine (2 of 7 full runs); the update no longer depends on it.
5. A WebView2 whose environment fails keeps its own processes for minutes (WebView2 behaviour, no update file held); stale `webview2-<id>` folders of a killed window are not swept.
6. Session end (logout / shutdown) does not yet let the window close at once (W6).
7. `UpdateProgressModel` port has unit tests only; TS goldens are U2.
8. `signal_update_ready` is the minimal form (no heartbeat wait, no clearGateFailureIfUpdated): U3.
9. The real productName `unimux` installer was not run on this machine on purpose (second Apps & features entry, the user's real app runs); U2/U4 in the VM.
10. Run it: `node scripts/spike-update-window.mjs --build` (builds the spike installer into `src-tauri/target/sp6`, then runs the cases main, guard, failed, headless, each installing into its own scratch dir and uninstalling); later runs without `--build`; `--case=main,guard` picks cases; the headless case (broken WebView2 folder, shows an Edge dialog on the desktop) runs only with `UNIMUX_SPIKE_BROKEN_WEBVIEW=1`; `--visible` keeps the main case's window on screen (MC_UPDATE_VISIBLE=1, never takes the focus); `--prestage` stages and warms the copy first; `--keep` keeps the scratch dir. Screenshots and timings in artifacts/tauri-sp6/.
11. Observation for W6: after `quit` the main app's WebView2 processes took 3-30 s to end on the loaded machine.

### Review fixes: SP7 (2026-11-06)

All 8 confirmed findings of the SP7 review are fixed (the two timing findings were the same defect); none was skipped.

| finding | fix | checked by |
|---|---|---|
| major: `legacy_pem` refused DEK-Info AES-128/192/256-CTR and BF-CBC, which 1.1.4 (ssh2 under Electron's BoringSSL) loads | CTR (ctr 0.10.1, Ctr128BE) and BF-CBC (blowfish 0.10.0) added with ssh2's key derivation and IV lengths; the cipher list is the ssh2 CIPHER_INFO x Electron getCiphers() intersection that decrypts (GCM / ECB / RC4 have no working path in ssh2); golden-keys.mjs now runs under Electron (Node 26's OpenSSL cannot decrypt bf-cbc) | 7 new fixtures (RSA AES-128/192/256-CTR, BF-CBC; EC AES-128/256-CTR, BF-CBC) load identically; 8 refused-cipher fixtures (camellia, CFB, OFB, DES-CBC, DES-EDE-CBC, hand-made GCM / ECB / DES-EDE3) answer like 1.1.4; SP7.md and PLAN S2 corrected |
| major: the key test compared one input per file; an unencrypted SEC1 EC key given a passphrase loads in 1.1.4 but not through russh | keys.json holds the 1.1.4 answer for no / the right / a wrong passphrase; `port_parse` (the S2 prototype of parsePrivateKey) must match all of them (ok-ness, error code, `encrypted`, metadata); a passphrase reaches the key reader only when `isEncrypted` says so (traditional PEM always goes through `legacy_pem`, which ignores it without DEK-Info) | 348/348 answers equal; PLAN S2 lists the rule |
| minor: unencrypted PPK v2 + passphrase is notAKey in 1.1.4 but loads in russh | refused before russh in `s2_load` (ssh2's MAC key includes the passphrase); SP7.md names all three callers that pass a user passphrase | ppk2-rsa*.ppk with the right and a wrong passphrase -> notAKey; a mutation that drops the check fails the test |
| minor: `clean_comment` cut at 200 scalar values and used Rust `trim()` | 200 UTF-16 units, a split pair's lone high surrogate becomes U+FFFD (as `js_json::parse` reads 1.1.4's JSON), the JS whitespace set (U+FEFF yes, U+0085 no); keys.json is read with `js_json::parse` | 4 comment fixtures from 1.1.4's generateKey (150 emoji, `x` + 150 emoji, BOM / NEL / U+3000, control + U+2028/2029) and a unit test |
| minor: a non-ASCII DEK-Info IV panicked (`&str` byte slicing), the IV length was not checked | IV parsed as bytes like `Buffer.from(hex)` (stops at the first non-hex pair), checked against the cipher's IV length (16 AES, 8 DES-EDE3 / Blowfish) before the passphrase; a header without a comma is skipped like ssh2 does | 7 fixtures (IV short, bad hex, `é`, no IV, trailing junk, odd length, lower-case name) match 1.1.4; `malformed_dek_info_headers_never_panic` (179 hand-made values, no / wrong passphrase) |
| minor: the matrix compared only the ok boolean and the russh probe ran a fixed step list | the probe chooses methods like SshLogin.nextAuth from the server's lists (`AuthOrder`) and maps errors to SshErrorCode (`error_code`, the S3 table); the matrix compares outcome + code, the methods sent and the algorithms | full rerun: 104/104 logins same outcome, code, method sequence and algorithms (Dropbear: `password, false` on both sides); 21/21 host keys |
| minor (twice): russh timing included the disconnect | probe records `ms.authenticated` right after the auth success; the matrix uses it against ssh2's 'ready' | rerun: p50 81 ms (ssh2) vs 80 ms (russh); SP7.md explains the earlier 87 vs 100 |

### Open issues: SP7

1. russh pins ssh-key `=0.7.0-rc.11` (a release candidate); a russh update moves it, rerun `cargo test -p unimux-ssh --test sp7_keys` and the matrix.
2. S2 ports `port_parse` / `s2_load` / `legacy_pem` / `clean_comment` from tests/sp7_keys.rs (all refusals are prototyped there now) and keeps the keys.json comparison; ssh2's anchoring of the PEM regex to the whole text is not prototyped yet. RC4 DEK-Info (ssh2 throws) answers badPassphrase by decision.
3. The matrix compared the 1.1.4 modules (SshLogin, KnownHostsStore) under this tree's Electron 45 runtime, not an installed 1.1.4 app; macOS not run.
4. OpenSSH 9.8+ `PerSourcePenalties` blocks repeated failing test logins; the SP7 configs turn it off and S4's CI matrix must too. CentOS 6 (OpenSSH 5.3) does not run on WSL2 (vsyscall), so the oldest real build is OpenSSH 5.9.
5. The unimux-ssh dev-dependencies (russh, ssh-key, aes, cbc, ctr, des, blowfish, md5) become normal dependencies in S2/S3; the prototype `legacy_pem` moves from tests/sp7_keys.rs into the crate.

### Open issues after SP8 (2026-11-06)

Verification: `cargo fmt --all --check`, `cargo clippy -p unimux-mcp --all-targets -- -D warnings`, `cargo test -p unimux-mcp` (10 sp8_wire tests + 2 unit tests), `node scripts/spike-mcp-wire.mjs` (ts / custom / rmcp: 52 protocol cases + 8 CLI scenarios each; ts and custom all PASS, custom 52 / 52 identical, rmcp gaps reported). Run: see spikes/SP8.md "How to run".

1. Codex `accept` of an elicitation is not exercised: `codex exec` always answers `decline`; the accept path needs the Codex TUI in a pty (M4 real-app checks). Accept is proven with Claude (Elicitation hook).
2. Long waits through the Rust server (Claude 600 s, Codex 170 s, `MCP_CLI_WAIT`) not run; the 15 s SSE keepalive is in the prototype (M4, verify-mcp-cli).
3. The 10 s header / 30 s body timeouts, the 120 / 60 per s bucket and the 256-session cap are in the prototype but no test drives them (M1 ports the mcp-protocol cases).
4. No CLI declares or uses MCP tasks; the 2025-11-25 task wire is proven only at HTTP level against the TS server.
5. macOS not run (hyper's drop-on-disconnect behaviour to be confirmed in CI / R3).
6. The spike's `cap_result` uses `String::from_utf16_lossy`; 1.1.4 can emit a lone surrogate escape when the cut splits a pair (M2, with the F7 lone-surrogate handling).
7. rmcp 3.9 stays a dev-dependency of the spike only (examples, tests); M1 removes it together with `examples/sp8/rmcp_impl.rs` when it moves the dispatcher into the crate.
8. Deliberate deviation: after a client's `notifications/cancelled` for a session call, 1.1.4 sends no answer and keeps that call's SSE stream open until the client closes it (the in-flight slot stays taken meanwhile); the prototype also sends no answer but ends the stream once nothing else is pending on it. Same frames on the wire (protocol case "session tools/call cancelled by notifications/cancelled gets no answer").
9. The elicitation timeout (120 s) and the ttl expiry (clamp 60 s) are driven only by cargo tests with a shortened `Config` (`elicit_timeout`, `min_task_ttl`); the TS server has the constants built in, so these two are not compared case by case with 1.1.4 (the abort path of the elicitation is).

### Open issues after SP9 (DB wire fidelity)

1. TLS was not part of the spike for any of the three clients (rustls over the same generic streams): D4 / D7 / D9 cover it in their Docker matrices. MySQL 9 and Valkey are not in the SP9 matrix yet.
2. D4 / D7 / D12 must send DB port messages through a JSON writer that can emit a lone `\udXXX`: a 64K cell cut inside a surrogate pair, and every `DB_LIMITS.serverText` (4,000) cut too (PG error fields and notices, MySQL errors and warnings, Redis error replies). `unimux_db::wire::value` (`DbValue::write_json`, `server_text` + `write_head`) is the template, serde_json alone cannot.
3. D7 decisions: MySQL connection attributes (`_client_name` is `Node-MySQL-2` in 1.1.4, `unimux` in the spike, visible only in performance_schema), keeping the `LOCAL_FILES` client flag that mysql2 advertises (1.1.4 and the spike answer LOAD DATA LOCAL with an empty file and fail the statement with mysql2's streamFactory message, reported as `dbClosed`), and whether to add MariaDB client_ed25519 (1.1.4 / mysql2 cannot log in with it; PLAN D7 lists it).
4. D4 note: node-postgres takes `PGOPTIONS` (and other PG* variables) from the environment; the Rust client does not. Recommended to keep it that way and mention it in the 1.2.0 notes.
5. The server checks need Docker: they are `#[ignore]`d in a plain `cargo test` (shown as ignored, not passed); `node scripts/spike-db-wire.mjs` runs them with `--include-ignored` and fails a server test that has no server of its kind. CI does not start the containers yet.
6. The redis crate stays a dev-dependency of unimux-db only to keep the measured gaps reproducible; D9 can drop it (and the workspace pin) once its own tests replace that comparison.
7. D7: after `SET NAMES` / `SET CHARACTER SET` mysql2 encodes queries and decodes column names in the session charset; `wire::mycharset` does it for utf8, latin1 / binary, ascii, ucs2 / utf16-le and cesu8 and refuses queries in the iconv-lite-only encodings (cp1250, koi8r, sjis, big5 ...). D7 adds iconv-lite's tables for those.
8. D9: the reconnect handshake (`auth`, `client setname unimux`, `select` of the previously selected DB) is taken from the ioredis source (`wire::redis::reconnect_sequence`); D9 adds a golden for it through RedisSession.

### D3 open issues (2026-11-07)

1. Unpaired surrogates: a Rust string cannot hold one, so 201 generated rows whose input or answer holds one are left out of the vectors (`dump-goldens` prints the count). Text cut by a helper inside a pair (e.g. `mysqlServerLabel`'s `slice(0, 40)`) becomes U+FFFD in Rust. D1 / D12: renderer strings with lone surrogates never reach these helpers through serde (the IPC layer decides what such a call answers).
2. Shapes the Rust types cannot hold (an `after` entry that is not a string, an edit with an unknown `op` or a missing `set` / `values`) are refused as `invalid` in the vectors' harness, matching where the TS loop throws. D1's IPC validation must refuse them the same way (1.1.4's zod answers `invalid` before the builders run).
3. `values::json_value` answers what `JSON.stringify` writes (NaN / infinities as null) instead of a NaN; it is only used by `rows_to_json`, whose text is identical. The renderer keeps its TS copies of formatDbValue / parseDbInput / the exports; the Rust ports exist for host-side use.
4. `redis_shared::data_display` / `quote_arg` give a string for broken base64 where TS throws (atob): D10 must check `data_bytes(..).is_some()` for renderer argv first (the harness does).
5. test/golden/db-sql.jsonl is 17 MB (normalize-state.jsonl is 11 MB); shrink the random part if the repository size matters.
6. Accepted deviation: `values::format_db_value(pretty)`, `json_value` and `rows_to_json` treat JSON nested deeper than 1000 levels (`PRETTY_DEPTH`) as text: shown unformatted and exported as a JSON string. 1.1.4 (V8) pretty-prints and exports it as a value up to a stack-dependent limit (about 2500 levels in node, different in the renderer) and past that `rowsToJson` throws RangeError and the export fails. A fixed cut-off cannot match a stack-dependent one; 1000 keeps the recursive pretty-printer and serde_json's drop safe on any thread. `values::tests::json_nesting_cut_off` pins depth 1000 (pretty, same text as TS) and 1001 (text).

Review fixes (2026-11-07): `mysql_timeout_sql` (MariaDB) now prints `(ms / 1000).toFixed(3)` from the exact value of the double (round half up at 3 decimals, like V8) for every ms, so huge timeouts (past about 8.8e15 ms, unreachable through DB_LIMITS.statementTimeoutMaxMs) match too; `pg::first_keyword_units` is one linear pass from the end (a 4-byte answer per unit) instead of memoized backtracking (8 MiB of `/**/` or `(` took minutes or about 1.1 GB, now about 0.1 s). New vectors: 1.4k huge / random mysqlTimeoutSql rows and 2.65k firstKeyword backtracking rows (comments that only lead somewhere at a later `*/`), plus `comment_and_parenthesis_heavy_statements_are_checked_in_linear_time` at the 8 MiB limit. Verified: cargo fmt, clippy -D warnings (unimux-db, unimux-core, all targets), cargo test -p unimux-db -p unimux-core, npm run gen:check, npm run typecheck, npm test 3,955 passed (none failed this run).

### How to run

- Dev: `npm run tauri dev` (Vite on 5174 + a debug build; MC_* overrides are on in debug builds). Not exercised in wave 0.
- Check flavour (what the scripts drive): `npm run build:check`, then `npm run smoke:tauri` (`--keep` keeps the scratch dir) and `node scripts/check-electron-compat.mjs` (after `npm run build`).
- Manual run on scratch data: `MC_DATA_DIR=<scratch> MC_DEBUG_PORT=9333 src-tauri/target/check/release/unimux.exe` (add `MC_OFFSCREEN=1` for a window that never takes focus); DevTools at http://127.0.0.1:9333.
- Release flavour: `npm run build:release` (unsigned NSIS installer; the MC_* overrides are compiled out, so it always uses %APPDATA%\unimux: do not run it for tests).
- cargo directly: `cd src-tauri && node ../scripts/msvc-run.mjs cargo test --workspace` (loads the MSVC environment and the SDK fallback).

## Wave 0b integration (2026-11-06)

### Merged into `tauri-1.2.0` (all with `--no-ff`)

| package | merged branch | merge | status after the merge |
|---|---|---|---|
| F8 | `tauri-pkg-F8-fixes` (= `tauri-pkg-F8` + its review fixes) | 0604fcc | verified (Windows) |
| SP1 | `tauri-pkg-SP1` (review fixes on the branch) | 41fb8ac | done (Windows, acceptance substituted; user decision pending) |
| SP2 | `tauri-pkg-SP2-fixes` (= `tauri-pkg-SP2` + review fixes) | e6016c7 | verified (Windows); Mac half open |
| SP5 | `worktree-wf_b57fdc79-7b0-32` (= `tauri-pkg-SP5` + review fixes) | 8692640 | done (partly verified) |
| SP6 | `tauri-pkg-SP6-fixes` (review fixes, rebased on 6868341; replaces `tauri-pkg-SP6`, whose commit 1d26bd7 is the same change before the rebase) | cd51ec2 | done (Windows verified, macOS open) |
| SP7 | `tauri-pkg-SP7` (review fixes on the branch) | e709a16 | verified (Windows) |
| SP8 | `tauri-pkg-SP8` (review fixes on the branch) | 8bd91ec | verified (Windows) |
| SP9 | `worktree-wf_b57fdc79-7b0-16` (= `tauri-pkg-SP9` + review fixes) | ea210c2 | verified (Windows) |

Conflicts were only in the docs (PLAN / PROGRESS / ARCHITECTURE rows, merged per package; the P2 row of PLAN.md combines SP1's shared-buffer decision and bounded-posts acceptance with SP5's frame format, 16 / 4 ms batcher and host-side DA1), in unimux-app (`build.rs` command list, `main.rs` modules and handlers, `capabilities-check/test-bridge.json`, `test_bridge.rs`: both sides kept, so the check build has the SP1 channel bench, the SP5 pty spike commands and the SP6 update commands together) and in the workspace `Cargo.toml` / `Cargo.lock` (union of the dependencies: `aes` / `cbc` pinned `=0.9.4` / `=0.2.1` for SP2 and SP7, `getrandom` 0.4.3 for oscrypt and the SP8 spike, which only calls `getrandom::fill`, one `bytes` entry for SP8 and SP9; every package version of the SP7, SP8 and SP9 lock files is in the merged lock).

Integration fixes: the SP7 review-findings table moved back under its heading in this file (merge resolution); the SP6 spike's broken-WebView2 case (`headless`) runs only with `UNIMUX_SPIKE_BROKEN_WEBVIEW=1`, so no Edge "cannot create data directory" box appears on the desktop. No code breakage came out of the merges.

### Verified after the merges (Windows 11 26200, 2026-11-06)

| command | result |
|---|---|
| `cargo fmt --all --check` | clean |
| `cargo clippy --workspace --all-targets -- -D warnings` (default; `--features unimux-app/dev-overrides,unimux-app/test-bridge`; `--release`) | clean, all three |
| `cargo test --workspace` (default / with the features / `--release`) | 244 / 249 / 244 passed, 0 failed; 8 ignored each (the SP9 Docker server tests, run by `node scripts/spike-db-wire.mjs`) |
| `npm run typecheck` | ok |
| `npm test` | 259 files / 3,952 tests passed (10 skipped as before) |
| `npm run gen:check`, `node scripts/porting-count.mjs --check` | up to date (contract 248 members / 215 channels / 44 events; messages 2,720 rows; goldens); 69 / 2,146 main-side cases done |
| `npm run build:check` | src-tauri/target/check/release/unimux.exe |
| `npm run smoke:tauri` | 34/34 |
| `node scripts/spike-sp1.mjs` (short run) | 25/25 (shared buffer p50 0.20 ms, real profile untouched) |
| `node scripts/sp5/run.mjs render close` | render parity checks ok (win32-input-mode, DA1, focus 1004, resize reflow, Claude cell); 20 cells exited in 241 ms, 0 terminals left |
| `npm run build` (Electron) | ok |
| `node scripts/check-electron-compat.mjs` | 21/21 |

Not run at the integration: the SP6 harness (`spike-update-window.mjs`, installs a spike product; its own 88/88 runs are recorded in the SP6 row), the SP7 / SP9 Docker matrices, the SP8 CLI scenarios, the SP2 1.1.4 round trip and `spike-sp1.mjs --long`; each was run by its package (see the rows). The release build (`npm run build:release`) was not rebuilt.

### Not done after wave 0b

1. **SP3 and SP4 are not started** (VirtualBox Windows image and a Mac are missing), so release gate item 1 stays open.
2. **No macOS run at all**: SP1 WKWebView IPC, SP2 Keychain half, SP5 Unix pty, SP6 bundle swap + `codesign --verify`, SP7 / SP8 / SP9 macOS; CI was never run (branch not pushed).
3. **Two acceptance items wait for the user**: the SP1 substitute (transport-only shared buffer instead of "Channel p50 < 2 ms into 20 xterm") and SP5 criterion 4 (20 cells x 1 MB/s at 60 fps only partly met; 1.1.4 drops more frames under the same load).
4. Echo under a 19-cell flood is slower than 1.1.4 in the median (SP5 issue 1): input for P2.
5. conpty.dll / OpenConsole.exe still come from node-pty's copy in node_modules (`UNIMUX_CONPTY_DIR`); P1 commits them under src-tauri/resources/conpty/x64.
6. Spike-only dependencies stay as dev-dependencies until their packages: rmcp (M1 removes), redis crate (D9 drops), russh / ssh-key / aes / cbc / des / md5 / ctr / blowfish in unimux-ssh (S2 / S3 make them normal ones).
7. Load-sensitive tests seen by the packages (not at this integration): `unimux-exec output_over_the_cap_is_truncated_and_the_tree_ends`, `unimux-pty job_object_kills_the_whole_tree`, a few vitest timing cases. All passed in the runs above.
8. Branches and worktrees: all 16 package / review worktrees under `.claude/worktrees` were clean or held only a stale pre-fix index (the review fixes were committed from detached worktrees), had no junctions and were removed; `git worktree prune` run. Deleted: tauri-pkg-F8, -F8-fixes, -SP1, -SP2, -SP2-fixes, -SP5, -SP6-fixes, -SP7, -SP8, -SP9 and the worktree-wf_b57fdc79-7b0-* branches (`git branch -d`); `tauri-pkg-SP6` with `-D` because its commit 1d26bd7 is in `tauri-1.2.0` only as the rebased 599fb11 (`git cherry` shows it as applied). This also removed the 1.3 GB `src-tauri/target/sp6` of the SP6 worktree.

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
3. **Kopia testowych danych 1.1.4** (KOPIA, nie oryginał `%APPDATA%\unimux`) albo zgoda, żebym utworzył syntetyczne dane w 1.1.4 pod `MC_DATA_DIR` z testowymi hasłami SSH/DB i tokenem GitHub. Przyda się też F8: zanonimizowane prawdziwe pliki state.json można dopisać jako ziarna do `test/golden/normalize-seeds.jsonl` i uruchomić `npm run gen:goldens` (opcjonalnie).
4. **SP1: zastępcze kryterium akceptacji.** "Channel p50 < 2 ms przy 20 x 1 MB/s do 20 terminali xterm" nie spełnia żaden transport (sam renderer xterm nie wyrabia 60 fps przy takim obciążeniu). Propozycja: liczyć sam transport (wspólny bufor WebView2: p50 0,2-0,3 ms, spełnione), kryterium "do xterm" przenieść do SP5, a sprawdzenie WKWebView do W2 / pierwszego uruchomienia na Macu. Zgoda? Do tego czasu SP1 ma status "done", nie "verified".
5. **SP5: kryterium 4 spełnione częściowo.** 20 terminali po 1 MB/s trzyma 60 fps przy syntetycznym 20 MB/s i w większości przebiegów ConPTY, ale gdy ConPTY przepuszcza 13-20 MB/s, 45-72 klatki trwają ponad 50 ms (1.1.4 przy tym samym obciążeniu gubi ich więcej). Akceptujesz SP5 tak jak jest, czy zostawiamy to jako cel wydajności dla P2? Przy okazji: echo przy 19 zalewanych terminalach jest w medianie wolniejsze niż w 1.1.4 (13-28 ms wobec 9-13 ms); to zadanie dla P2.

### Do zrobienia po Twojej stronie (gdy będzie potrzebne)

1. **Obraz Windows dla VirtualBox** (np. oficjalna maszyna deweloperska Windows 11 albo ISO z licencją) do testu aktualizacji 1.1.4 -> 1.2.0 (spike SP3, potem U3). Nigdy na Twoim prawdziwym profilu.
2. **Dostęp do Maca** (Apple Silicon, Xcode Command Line Tools, Rust) do testu pęku kluczy, aktualizatora 1.1.4 -> 1.2.0, okna aktualizacji i ręcznej listy kontrolnej (SP2, SP4, R3).
3. **Kopia zapasowa klucza podpisywania offline.** W folderze `D:\Projekty\_unimux-tauri-keys` leży też plik z hasłem; warto przenieść hasło do menedżera haseł i zrobić kopię klucza na nośniku offline (utrata klucza = koniec aktualizacji dla wersji Tauri). Agenci nie czytają tych plików.
4. ~~Brakuje Windows 11 SDK~~ zainstalowany (10.0.28000, sprawdzone 2026-11-06), buildy go używają. Można usunąć folder `%LOCALAPPDATA%\unimux-build` (kopia SDK z NuGet, już niepotrzebna).
5. Akceptacja wersji testowej przed wydaniem i przeczytanie `docs/releases/1.2.0.md`.
6. **Sprzątanie po spike SP5** (opcjonalnie): usuń folder `D:\Projekty\_tmp-094rend-zQPAwx` (agent nie mógł go usunąć, EPERM) oraz dzisiejsze foldery `D:\Projekty\_tmp-ssh-latency-*`, jeśli żaden inny agent ich nie używa.
7. **Opcjonalnie: powtórzyć pomiar SP1 na bezczynnym komputerze** (bez gry i ciężkich programów): `npm run build:check && node scripts/spike-sp1.mjs --long`. Pomiary wave 0b szły przy 94-100 procent obciążenia CPU; kolejność transportów była zawsze ta sama, ale liczby bezwzględne warto powtórzyć.
8. **Opcjonalnie: drugie konto Windows**, żeby zmierzyć, co robi Electron 1.1.4 z kluczem DPAPI innego użytkownika w `Local State` (SP2; dziś symulowane blobem, który się nie rozpakowuje).
9. **Mac** (punkt 2) blokuje teraz konkretnie: WKWebView IPC i transport danych na macOS (SP1), pęk kluczy z 1.1.4 i jedno "Zawsze zezwalaj" (SP2), podmianę paczki .app i `codesign --verify` (SP6), SP4 oraz testy F8 / SP5 / SP7 / SP8 / SP9 na macOS. **Obraz VM Windows** (punkt 1) blokuje SP3 i próbę prawdziwego instalatora `unimux` z monitem UAC (SP6 / U2).


## User feedback 2026-11-06

- Update window: the text arrow looked wrong (fixed in resources/update-splash: drawn chevron), the window must not be always-on-top (fixed in src/updatesplash for Electron; required for U2), and the UAC prompt must come to the front (U2 requirement).
- Tauri check build: the system title bar shows above unimux's own title bar; W1 must remove it (decorations: false, own drag region, caption buttons like 1.1.4).
- 2026-11-06: an Edge dialog "cannot create data directory ...\unimux-sp6-*\headless\unimux-updater\webview2-broken\EBWebView" popped up on the user's desktop several times. Source: scripts/spike-update-window.mjs (SP6 fixes, worktree -22) deliberately hands WebView2 a file as its data folder. Gated at the wave 0b integration: the headless case runs only with UNIMUX_SPIKE_BROKEN_WEBVIEW=1 (commit "fix: SP6 spike runs the broken-WebView2 case only ..."). Still to do in U2: the writable-folder pre-check in the updater and the main app (PLAN.md U2/SP6).
