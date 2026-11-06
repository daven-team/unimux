# SP1: WebView2 shell behaviour (spike result)

Date: 2026-11-06. Branch `tauri-pkg-SP1`. Machine: Windows 11 26200, 16 logical CPUs, WebView2 Runtime 156, tauri 2.12.5 / wry 0.57.1. Every number below comes from the real `check` build of the app (not a toy app), driven by `scripts/spike-sp1.mjs` over WebView2 CDP on a scratch data dir and scratch home. The full numbers of the reference run are in `docs/tauri/spikes/SP1-results.json`.

**Load caveat.** The machine was at 94-100 percent CPU during every run (other programs of the user, a game among them; sampled with `os.cpus()` for every bench row, `machineCpuPercent`). Absolute numbers are therefore pessimistic and vary between runs; the comparisons between transports were made in the same run, back to back, and the ranking was the same in all four runs.

## How to run

```
npm run build:check
node scripts/spike-sp1.mjs                       # about 4 minutes
node scripts/spike-sp1.mjs --long                # + 390 s minimized (Chromium's intensive throttling starts after 5 min)
node scripts/spike-sp1.mjs --no-timers --modes=sharedBuffer,local --bench-seconds=10
```

What the script uses (check build only, feature `test-bridge`, absent from release builds):

- `src-tauri/crates/unimux-app/src/spike_windows.rs`: test_bridge ops `openWindow` (a second app window on the same WebView2 data folder, same or different browser args, hidden or visible, registered with the guard like a detached window) and `window` (minimize / unminimize / hide / show / WebView2 controller `IsVisible` false and true, and the resulting Tauri, Win32 and WebView2 state).
- `src-tauri/crates/unimux-app/src/channel_bench.rs`: `test_channel_bench` (20 producer threads like the P1 pty readers, terminal-like output with SGR colours, CR progress lines and UTF-8, 16-byte frame header with the production time) and `test_channel_pull`, plus test_bridge ops `clock` (clock offset, calibrated to +-0.15 ms) and `marks` (renderer startup marks per window).
- A fixture state with one 5x4 tab (20 cells), so the 20 xterm instances are the app's own (TerminalManager, WebGL addon, real CSS), not test terminals.

## Results

Final run: 17 checks, 17 PASS (the reference run with `--long` had 18/19; its one FAIL was the "minimized + IsVisible(false)" phase, which is informational now, see question 2).

### 1. Full browser-args string on two windows: no 0x8007139F

- Main window plus a second window (`detached-sp1`) with the identical string from `windows::browser_args` on `DATA_DIR/webview2`: opens in 219-376 ms, loads the app, IPC works.
- Third window with ONE extra switch (`--disable-gpu-vsync`) on the same data folder: `failed to create webview: WebView2 error: HRESULT(0x8007139F)` after 11-16 ms, every run. That confirms the rule of ARCHITECTURE section 5: every app webview must use exactly `windows::browser_args()` (the debug port included); the update window keeps its own data folder.
- `cargo test windows::tests::browser_args_are_the_same_for_every_webview` guards the string.

### 2. 400 ms timer while minimized

The plan assumed wry sets the WebView2 controller to `IsVisible(false)` on minimize. **It does not**: wry 0.57.1 `parent_subclass_proc` ignores `WM_SIZE` with `SIZE_MINIMIZED`, and `IsVisible` is only changed by `Webview::hide()` / `show()` (`tauri-runtime-wry` `WebviewMessage::Hide`). Measured with the real 400 ms status tick of TerminalManager (patched instance method) and a plain `setInterval(400)`:

| phase | 400 ms ticks | max gap | rAF | `document.visibilityState` |
|---|---|---|---|---|
| visible | 30 / 30 | 404 ms | 240/s | visible |
| minimized (`window.minimize()`, IsIconic) | 30 / 30 | 404 ms | 240/s | visible |
| minimized 390 s (past the 5 min intensive-throttling point) | 975 / 975 | 418 ms | 239/s | visible |
| window hidden (`window.hide()`, SW_HIDE) | 30 / 30 | 410 ms | 239/s | visible |
| a window that was never shown (`visible(false)`) | 1209 in 8 min | 412 ms | 240/s | visible |
| controller `IsVisible(false)` (informational) | 18-24 / 30 | 1432-2853 ms | 0 | hidden |
| minimized + `IsVisible(false)` (informational) | 11-21 / 20-36 | 405-5019 ms | 0 | hidden |

Answers:

- The timer keeps running minimized, hidden and never shown, also after 6.5 minutes (the browser args disable background timer throttling and intensive wake-up throttling as long as the page counts as visible). No Rust tick mitigation is needed.
- `IsVisible(false)` does throttle (about one wake-up per 1.4 to 5 s, rAF stops). **Rule for W5 / W6 / U1: never call `Webview::hide()` or `SetIsVisible(false)` on an app webview; hide and minimize the WINDOW.** Should a later package need it, the mitigation is the Rust tick (a 400 ms tokio interval emitting to the window).
- `document.visibilityState` stays `visible` while minimized or hidden (CalculateNativeWinOcclusion is off), so the renderer cannot use the Page Visibility API to notice it; `window:shown` from Rust (F11, `html[data-window-shown]`) is the only source, as ARCHITECTURE section 5 already says.
- A minimized or hidden window keeps painting at the display rate (240/s here). 1.1.4 runs with `backgroundThrottling: false` too; perf work that wants to save CPU while minimized must key on `window:shown`.

### 3. A hidden window reaches renderer-boot

- `detached-sp1` created with `visible(false)` and never shown: the full App boots (`app:startupMark('renderer-boot')` arrives from that label, test_bridge `marks`), `IsWindowVisible` false, controller IsVisible true, timers and IPC work (113 IPC fetches during its boot).
- The main window is created hidden too and shows on page load; renderer-boot arrives in every run.

### 4. IPC transport under the F2 CSP

- `window.__TAURI_INTERNALS__.invoke` uses the custom protocol: 302 `http://ipc.localhost/<command>` resource entries for 300 probe invokes, **0 calls of `chrome.webview.postMessage`** (the fallback; counted by wrapping it), also in the hidden second window. (WebView2 maps the `ipc:` scheme to `http://ipc.localhost`; WKWebView uses `ipc://localhost`, both are in `connect-src`.)
- The CSP header Tauri serves is `tauri.conf.json`'s policy plus script hashes; a `fetch('http://127.0.0.1:9/')` is blocked with a `connect-src` violation, and the IPC itself causes none.
- Invoke round trip (`test_bridge clock`, tiny JSON): p50 4.2-5.0 ms, p95 8.9-12.2 ms, min 2.3 ms at 95-100 percent machine CPU (3.0 ms p50 in a quieter moment). `state:load` (a full state snapshot): p50 4.9 ms.

### 5. Binary data into 20 xterm: Tauri Channel vs alternatives

All runs: 20 streams, 16 KiB frames (4 KiB where stated), 10 s, latency from frame PRODUCTION in Rust to arrival in the page handler ("arrive") and to the xterm write callback ("parsed"). Reference run, machine CPU 94-100 percent:

**Transport only (the page receives and checks every frame; nothing parses), 20 x 1 MB/s:**

| transport | messages | arrive p50 | p95 | p99 | delivered |
|---|---|---|---|---|---|
| Tauri `Channel<InvokeResponseBody>`, one `Raw` per frame | 12,800 | 4,408 ms | 7,139 ms | 7,488 ms | 20 MB/s, after a 4.4 s backlog |
| Tauri Channel, per-window batch, flush at once | 12,352 | 976 ms | 1,216 ms | 1,351 ms | backlog |
| Tauri Channel, per-window batch, 4 ms throttle | 2,126 | 7.3 ms | 12.5 ms | 20.4 ms | 20 MB/s |
| pull: raw invoke long poll, one in flight | 2,498 | 4.6 ms | 8.4 ms | 21.4 ms | 20 MB/s |
| **WebView2 shared buffer, one post in flight, no timer** | 12,504 | **0.33 ms** | **1.24 ms** | 6.9 ms | 20 MB/s |
| shared buffer, 1 / 2 / 4 ms throttle | 5,869 / 3,608 / 1,717 | 1.4 / 2.2 / 3.8 ms | 3.1 / 4.1 / 8.1 ms | 7.9 / 7.6 / 18.8 ms | 20 MB/s |
| shared buffer, 4 KiB frames | 12,336 | 0.99 ms | 27 ms | 49 ms | 20 MB/s |
| shared buffer, 20 x 2 MB/s | 18,606 | 0.52 ms | 5.9 ms | 43 ms | 40 MB/s |

Three other runs of the chosen transport: p50 0.28 / 0.98 / 0.56 ms (p95 2.5 / 9.9 / 10.4 ms; the first one before the one-post-in-flight rule); in every run it was the only transport with p50 under 2 ms.

Why the Tauri Channel misses: for a raw body of 1 KiB or more, `Channel::send` evaluates a script in the page, which then FETCHES the body from `plugin:__TAURI_CHANNEL__|fetch` (tauri 2.12.5 `ipc/channel.rs`): two UI-thread hops and one custom-protocol round trip (2.3 ms minimum, 4-5 ms p50 here) per message. At 1,280 frames/s it cannot keep up and the queue grows without bound; batching helps only with a throttle, and then the throttle is the latency. Smaller raw bodies go as a JSON array of numbers in an eval (worse for bulk data).

**Into the 20 cell terminals:**

| run | arrive p50 / p95 | parsed p50 / p95 | fps |
|---|---|---|---|
| renderer alone (`local`: the page makes the same output itself, no IPC), 20 x 256 KiB/s | 0 | 6.7 / 1,318 ms | 184 |
| shared buffer, 20 x 256 KiB/s | 1.5 / 88 ms | 2.7 / 99 ms | 227 |
| shared buffer, 20 x 256 KiB/s, 4 KiB frames | 0.85 / 3.3 ms | 1.3 / 4.5 ms | 239 |
| pull, 20 x 256 KiB/s | 5.1 / 19.8 ms | 7.1 / 24.7 ms | 237 |
| Tauri Channel per frame, 20 x 256 KiB/s | 8.7 / 49 ms | 10.2 / 56 ms | 233 |
| Tauri Channel per frame, 1 x 1 MB/s | 3.9 / 8.1 ms | 4.8 / 9.0 ms | 240 |
| renderer alone, 20 x 1 MB/s | 0 | 923 / 2,169 ms | 20 |
| shared buffer, 20 x 1 MB/s | 287 / 315 ms | 936 / 1,900 ms | 10 |
| Tauri Channel per frame, 20 x 1 MB/s | 17,142 / 19,455 ms | 17,550 ms | 60 |

Every frame of every run arrived, in order, with no send error (in-order check per stream).

Answers:

- **Acceptance "Channel p50 < 2 ms at 20 x 1 MB/s": met by the WebView2 shared buffer (p50 0.33 ms), NOT by `tauri::ipc::Channel`** (seconds of backlog per frame, 7.3 ms p50 at best with a 4 ms batch throttle). Decision below.
- 20 x 1 MB/s into 20 xterm is beyond what the renderer itself can parse and paint on this machine at this load, even with no IPC at all (`local`: 20 fps, parsed p50 0.9 s). That part is the renderer's limit, the same code as 1.1.4, and it needs the P2 FlowGate (byte acks, 1 MiB / 256 KiB) to keep the producer from running away; no transport fixes it. SP5's "20 cells at 1 MB/s keep 60 fps" must be measured against Electron 1.1.4 on the same machine at the same load.
- At a rate the renderer can take (20 x 256 KiB/s) the shared buffer adds nothing measurable (parsed p50 1.3-2.7 ms against 6.7 ms for the page's own generator, whose timer loop is coarser).

## Decision: the Windows data plane (changes ARCHITECTURE sections 1, 3, 9 and PLAN P2 / SP5 / D12)

1. **Windows: bulk Rust -> renderer data (pty output, and later large SFTP / DB result chunks) goes through WebView2 shared buffers**: per window one sender thread, frames queued by the producers, the queue written into one `ICoreWebView2Environment12::CreateSharedBuffer` buffer and posted with `ICoreWebView2_17::PostSharedBufferToScript` (read-only, additional data JSON names the port), **one post in flight** (the next batch waits until the UI thread has posted the last one, so a busy UI thread makes batches bigger instead of piling up posts), no fixed timer. The page listens to `chrome.webview` `sharedbufferreceived`, copies (or parses) the frames and calls `chrome.webview.releaseBuffer`. The bridge exposes it through the existing fake MessagePort (`mc:pty-port`), so TerminalManager does not change. Byte acks back to Rust stay on `mc_port_post` (they are small and few).
2. `tauri::ipc::Channel` stays for low-rate traffic (progress events, control messages, the port's JSON messages) and as the fallback if `ICoreWebView2_17` is missing (a WebView2 Runtime without shared buffers, before about 1.0.1661; the app's installer bootstraps a current runtime, so the fallback is a safety net, not a code path we tune).
3. macOS has no shared buffer. Candidates, to be measured on a Mac (SP5 / W2): the pull transport (raw invoke long poll, one in flight: 4.6 ms p50 on WebView2, and WKWebView's `ipc://` scheme handler is cheaper than WebView2's) or a batched Channel with a throttle. Until then the plan for macOS is pull.
4. Never `Webview::hide()` / `IsVisible(false)` on an app webview (question 2).

## Not done in this spike (open)

- **WKWebView in CI uses the same IPC**: not run. There is no Mac and CI was never run (the branch is not pushed); on macOS there is no CDP either, so the check needs the debug-only eval bridge of the plan (W2). What the check must show: invokes go to `ipc://localhost/<cmd>` (not the postMessage fallback) under the same CSP. Tauri 2.12.5 uses the custom protocol on macOS by default (`ipc://localhost`, in `connect-src`), so the risk is low, but it is unverified.
- The macOS data-plane measurement (decision point 3).
- The absolute numbers should be repeated on an idle machine (see the load caveat); the ranking and the pass/fail of the acceptance did not change across the four runs.
