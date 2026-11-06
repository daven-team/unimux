# SP6: custom update window process

Status 2026-11-06: **Windows half green, macOS half open (no Mac).** Branch `tauri-pkg-SP6`.

Question (PLAN.md SP6): can `unimux.exe --update-window <config>`, started from a copy in `%LOCALAPPDATA%\unimux-updater\runtime-<ver>\` with its own WebView2 data folder, survive the parent exiting, show the `resources/update-splash` page, run an NSIS `/S` installer that overwrites the install dir while the copy runs, and relaunch the new exe? Acceptance: install dir fully replaced (no locked file), the window stays until the new app writes `update/ready`, no console, no orphan process; macOS swap passes `codesign --verify`. Fallback: a separate `unimux-update.exe` binary.

Answer: yes on Windows, with the same binary. The fallback binary is not needed. Several details of the design change (below).

## What was built (working code, kept for U2)

| piece | where |
|---|---|
| `UpdateProgressModel` + `closeAction` port (1:1 with src/shared/updateProgress.ts; goldens are U2) | `src-tauri/crates/unimux-update/src/progress.rs` |
| `UpdateSplashConfig` (1.1.x keys + optional `installer`, `installerArgs`, `webviewDir`), translated `UpdateStrings`, `stage_runtime`, `hand_over`, `signal_update_ready`, `directory_bytes`, guarded cleanup | `src-tauri/crates/unimux-update/src/window.rs` |
| `--update-window <config>` process (own Tauri builder, window `update-window`, own lock `work/window.lock`, 250 ms loop, installer run, relaunch, close on `ready`, Escape/X hide while working) and `--update-cleanup --wait=<pids> <dirs>` | `src-tauri/crates/unimux-app/src/update_window.rs`, dispatched first thing in `main.rs` |
| `window.updateSplash` over Tauri: an initialization script maps `init/onState/close/open` onto the existing `update_splash_*` commands (ipc.rs, shared with the U1 gate) and the `update-splash:state` event | `update_window.rs` (`BRIDGE`), `ipc.rs` |
| `spawn_detached_child` (keeps the Child for the installer's exit code) and `process_alive` | `src-tauri/crates/unimux-exec/src/lib.rs` |
| new app writes `update/ready` when its main window shows and `work/config.json` names its version | `windows.rs` -> `unimux_update::window::signal_update_ready` |
| test bridge ops `update-stage` and `update-handover` (check flavour only) | `test_bridge.rs` |
| real-app harness | `scripts/spike-update-window.mjs` |
| splash page CSP: `connect-src ipc: http://ipc.localhost` added | `resources/update-splash/index.html` |

## How it was tested

`node scripts/spike-update-window.mjs [--build] [--prestage] [--keep]` (Windows 11 26200, WebView2 156, machine shared with other agents' cargo builds).

- `--build` makes a spike installer from the check flavour (dev-overrides + test-bridge, so every unimux.exe it starts honours `MC_DATA_DIR`) with productName `unimux-sp6` and identifier `com.unimux.sp6` (registry keys, shortcuts, app data names can never meet the user's unimux), mainBinaryName `unimux` (so the NSIS running-app check is the production one). Target dir `src-tauri/target/sp6`.
- Installs it `/S /NS /D=<scratch>\Install Dir` (a space on purpose), appends 4 MiB to the installed `unimux.exe` (old build: different hash and size), starts it on a scratch data dir, calls `update-handover`, then watches the window over its own DevTools port (`MC_UPDATE_DEBUG_PORT`, dev-overrides only), the file signals and every process whose image or command line is inside the scratch folder (a PowerShell CIM poller, about 300 ms), including any conhost.exe they own.
- Ends with quitting the new app, `uninstall.exe /S`, a registry check, the real-profile markers and the real `%LOCALAPPDATA%\unimux-updater` listing (unchanged in every run).

Result of the final harness: **29/29 in the last three runs** (two plain, one `--prestage`). In about 15 earlier runs (older harness versions) install, replacement, `ready` and no-console passed every time; the failures were harness bugs (process paths, sort order, a race on the cleanup check), `shown` later than the 4 s wait (5 runs, cold exe or loaded machine), the orphan check firing while WebView2 processes were still ending (fixed by the pid wait and a 15 s grace), and one loaded run where the window's DevTools sampling missed the stages.

| check | result |
|---|---|
| runtime copy `unimux-updater\runtime-1.2.0\unimux-update.exe` (one file, 11.2 MB, 10-60 ms) | yes, the window process runs from it |
| window survives the old app exiting | yes (old app exits 0.5 s after `shown`, window lives on 4-10 s) |
| installer `/S /UPDATE --updated /D=<dir with space>` while the copy runs | exit 0 every run, 1.9-3.9 s |
| install dir fully replaced | `unimux.exe` hash = the payload, size 15.4 MB -> 11.2 MB, exactly `unimux.exe, uninstall.exe` |
| stages | preparing > installing > launching > done, bar never moves back, texts from `config.strings` |
| window stays until `update/ready` | yes; exits 1.2-3.4 s after `ready` (1.1 s FINISH_DELAY + tick) |
| new app | started by the window from the install dir, writes `ready` = `1.2.0` |
| no console | both exes are GUI subsystem; no conhost.exe owned by any of our processes in any snapshot |
| no orphan | window, its WebView2, installer and cleanup gone within 15 s; runtime copy and `webview2` folder removed 0.8-5.8 s after the window ended |
| splash IPC | with the added `connect-src`, Tauri's `ipc:` custom protocol works under the page CSP |

### Timings (ms; 8 runs without, 4 with pre-staging)

| | without pre-stage (median, range) | pre-staged + warmed |
|---|---|---|
| CreateProcess of the copy (`spawnMs`) | 904 (469-1478) | 212 (110-514) |
| spawn -> `work/shown` | 3014 (1821-4948) | 2380 (911-2774) |
| window process start -> window created (WebView2 environment + controller, fresh data folder) | 2171 (801-2684) | 2003 (670-2011) |
| installer run | 2126 (1914-3935) | 2747 (2692-3170) |
| old app exit -> new app `ready` | 4286 (3501-10605) | 9470 (5031-10083) |

Cold numbers (first runs right after a new build, so a never-seen exe hash): CreateProcess 1506 ms, window shown 4.7-8.9 s after start, i.e. after the app's 4 s `SHOWN_WAIT` ran out (the app then exits with no window on screen for a few seconds). The ready times above 8 s are the new app's own start on a loaded machine.

## Findings and decisions

1. **The copy is named `unimux-update.exe`**, not `unimux.exe` (Task Manager shows what 1.1.4 showed; nothing that looks for the app by image name can confuse the two). The Tauri 2.12 NSIS template's running-app check is the Restart Manager on the full path `$INSTDIR\unimux.exe` (`RmRegisterFile` + `RmShutdown(RmForceShutdown)` in `/S` mode, utils.nsh `CheckIfAppIsRunning`): it never touches the copy, nor a unimux.exe running from another folder (the user's 1.1.x install, a dev build). It would kill an old app that is still running from the install dir, which is why the window starts the installer only after the old pid is gone.
2. **Installer arguments `/S /UPDATE --updated /D=<installDir>`**: without `/UPDATE` a silent Tauri install creates a desktop shortcut on every update (`CreateOrUpdateDesktopShortcut` in `/S`); `/UPDATE` also skips the WebView2 step and the uninstall-first path. `/D=` last and unquoted (verified with a space in the path) installs where the running app is. No `/R` (the template's relaunch) and no `--force-run`: the window starts the new exe itself once the files are in place.
3. **Exit code 0 counts as `installer-done`** when no NSIS hook wrote it (the U3 hook writes it on `--updated`); a non-zero code or a missing installer goes to the error stage (texts `slow` / `slowHint` for now).
4. **Start the window before the wind-down, not after** (ARCHITECTURE section 8 changed): the WebView2 start of the window takes 0.8-2.7 s idle and up to 8.9 s on a loaded machine. 1.1.4 also showed the window first and quit afterwards; the window's "closing" stage covers the wind-down.
5. **Stage and warm the copy when the download is verified** (like 1.1.4's `stageSplashRuntime`) and start it once with `--update-cleanup` (a no-op without folders): the first start of a new file pays the antivirus scan (CreateProcess median 904 ms vs 212 ms).
6. **Cleanup from the installed exe**: `<installDir>\unimux.exe --update-cleanup --wait=<window pid>,<WebView2 browser pid> <runtimeDir> <webviewDir>`, cwd %TEMP%. It waits for both pids (at most 30 s), then removes only `runtime-*` / `webview2` directly inside a folder named `unimux-updater` (anything else is refused, unit-tested). A fixed 3 s delay was not enough under load: the window's WebView2 processes outlived the window by up to a minute in one loaded run before the pid wait was added.
7. **Splash page CSP**: the page's `default-src 'none'` refused Tauri's `ipc:` fetches (only the init script's first call, made before the meta tag is parsed, went through), so every later call fell back to postMessage after a CSP error. `connect-src ipc: http://ipc.localhost` was added; Electron makes no requests, so the 1.1.4 gate is unaffected.
8. **One `generate_context!`** (`tauri_context()` in main.rs) for both modes, so the frontend is embedded once; the update window is a second `tauri::Builder` in the same binary with no main window and only the `update_splash_*` commands (capability `update-window.json`).
9. **Fallback binary not needed.**

## Not done / open

- **macOS half** (copy in a temp dir swapping the `.app` bundle, `codesign --verify`): no Mac. The window mode compiles for Unix in principle but was never built on macOS; installing there is U5.
- Escape / X / Alt+F4 hide-while-working is implemented (1.1.4 rules) but not driven by the harness (U2 acceptance).
- Session end (1.1.4's `session-end` -> allow close) is not handled in the window (needs WM_QUERYENDSESSION, W6).
- No translated text for "installer failed" (the error stage reuses `slow` / `slowHint`); U2 may add one.
- The `UpdateProgressModel` port has unit tests, not the TS goldens (U2).
- The real Tauri 1.2.0 -> 1.2.x installer (productName `unimux`) was not run on this machine on purpose: it would register a second `unimux` entry in Apps & features and the user runs the real app. U2/U4 run it in the VM.
- Observation for W6: after `quit`, the main app's WebView2 processes took 3-30 s to end (machine under load).
