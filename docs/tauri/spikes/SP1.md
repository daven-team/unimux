# SP1: WebView2 shell behaviour (spike result)

Date: 2026-11-06. Branch `tauri-pkg-SP1`. Machine: Windows 11 26200, 16 logical CPUs, WebView2 Runtime 156, tauri 2.12.5 / wry 0.57.1 / tao 0.37.2. Every number below comes from the real `check` build of the app (not a toy app), driven by `scripts/spike-sp1.mjs` over WebView2 CDP on a scratch data dir and scratch home. The full numbers of the reference run (`node scripts/spike-sp1.mjs --long`, 2026-11-06 15:56 UTC, 27/27 checks) are in `docs/tauri/spikes/SP1-results.json`; every figure in this file can be traced to it unless it says "earlier runs".

**Status: done on Windows with a SUBSTITUTED acceptance, user decision pending.** The PLAN acceptance "Channel p50 < 2 ms at 20 x 1 MB/s" for "binary `Channel<InvokeResponseBody::Raw>` throughput into 20 xterm instances" is not met as written: no transport, `tauri::ipc::Channel` included, reaches p50 < 2 ms into 20 xterm at 20 x 1 MB/s, and the renderer alone (no IPC) cannot keep 60 fps there either. What SP1 does show is a transport-only p50 < 2 ms with the WebView2 shared buffer (not with Channel). The proposed substitute, recorded in the PLAN SP1 row: transport-only p50 + clock bound < 2 ms with the shared buffer; the into-xterm criterion moves to SP5 (60 fps against Electron 1.1.4); the WKWebView IPC item moves to W2 / the first Mac run and stays an open blocker for macOS.

**Load.** Machine CPU (other programs of the user, sampled with `os.cpus()` for every bench row, `machineCpuPercent`) was 27-100 percent during the reference run, most rows 35-70 percent. Earlier runs on the same day were at 94-100 percent; their absolute numbers were much worse (Tauri Channel per frame, transport only: 4.4 s p50 backlog then, 2.7 ms p50 / 129 ms p95 now) but the ranking of the transports was the same.

## How to run

```
npm run build:check
node scripts/spike-sp1.mjs                       # about 5 minutes
node scripts/spike-sp1.mjs --long                # + 390 s minimized (Chromium's intensive throttling starts after 5 min)
node scripts/spike-sp1.mjs --no-timers --modes=sharedBuffer,local --bench-seconds=10
```

What the script uses (check build only, feature `test-bridge`, absent from release builds):

- `src-tauri/crates/unimux-app/src/spike_windows.rs`: test_bridge ops `openWindow` (a second app window on the same WebView2 data folder, same or different browser args, hidden or visible, registered with the guard like a detached window; a label that a live window has is refused) and `window` (minimize / unminimize through tao, `sysMinimize` / `sysRestore` through `WM_SYSCOMMAND`, `sysHide` through `ShowWindow(SW_HIDE)`, show, WebView2 controller `IsVisible` false and true, and the resulting Tauri, Win32 and WebView2 state).
- `src-tauri/crates/unimux-app/src/channel_bench.rs`: `test_channel_bench` (20 producer threads like the P1 pty readers, terminal-like output with SGR colours, CR progress lines and UTF-8, 16-byte frame header with the production time) and `test_channel_pull`, plus test_bridge ops `clock` (Rust wall clock for the clock offset) and `marks` (renderer startup marks per window).
- A fixture state with one 5x4 tab (20 cells), so the 20 xterm instances are the app's own (TerminalManager, WebGL addon, real CSS), not test terminals.
- Clock: the latency of a frame is the page clock (`timeOrigin + performance.now()`) minus the Rust production time (`SystemTime`), corrected by an offset taken as the midpoint of the fastest of 80 `clock` round trips. The offset's error bound is half that round trip (the Rust stamp can lie anywhere inside it), +-0.55 to +-1.3 ms in the reference run; the spread of the best samples says nothing about it. The wall clock also drifts against the monotonic clock (up to about 0.3 ms in 2 to 3 minutes on the dev box), so every bench calibrates right before and right after itself, the latencies use the mean of the two offsets, and every row records `clock.driftMs` and `clock.boundMs` (half the slower best round trip plus the correction). Sub-millisecond figures are therefore only good to that bound; the gate is p50 + bound < 2 ms.
- Window states: minimize and restore go through `WM_SYSCOMMAND` `SC_MINIMIZE` / `SC_RESTORE`, what a click on the caption button or the taskbar does; hiding uses `ShowWindow(SW_HIDE)`. The harness runs offscreen, where the main window is shown with a raw `ShowWindow(SW_SHOWNOACTIVATE)` (`windows::show_without_focus`), so tao's VISIBLE flag stays unset: tao's `minimize()` then adds `SW_HIDE` after `SW_MINIMIZE` (tao 0.37.2 `WindowFlags::apply_diff`) and tao's `hide()` does nothing. The first SP1 run used `minimize()` and so measured a hidden + iconic window and called it minimized. Every timer phase now records the window state and is gated on it: minimized = `IsWindowVisible` and `IsIconic` (a user's window on the taskbar), hidden = not `IsWindowVisible`, shown = `IsWindowVisible` and not iconic.

## Results

Reference run: 27 checks, 27 PASS.

### 1. Full browser-args string on two windows: no 0x8007139F

- Main window plus a second window (`detached-sp1`) with the identical string from `windows::browser_args` on `DATA_DIR/webview2`: opens in 202 ms (219-447 ms in earlier runs), loads the app, IPC works.
- Third window with ONE extra switch (`--disable-gpu-vsync`) on the same data folder: `failed to create webview: WebView2 error: HRESULT(0x8007139F)` after 16 ms, every run. That confirms the rule of ARCHITECTURE section 5: every app webview must use exactly `windows::browser_args()` (the debug port included); the update window keeps its own data folder.
- `cargo test windows::tests::browser_args_are_the_same_for_every_webview` guards the string.

### 2. 400 ms timer while minimized

The plan assumed wry sets the WebView2 controller to `IsVisible(false)` on minimize. **It does not**: wry 0.57.1 `parent_subclass_proc` ignores `WM_SIZE` with `SIZE_MINIMIZED`, and `IsVisible` is only changed by `Webview::hide()` / `show()` (`tauri-runtime-wry` `WebviewMessage::Hide`). Measured with the real 400 ms status tick of TerminalManager (patched instance method) and a plain `setInterval(400)`; window state as read back during the phase:

| phase | window state | plain 400 ms ticks | status ticks | max gap | rAF | `document.visibilityState` |
|---|---|---|---|---|---|---|
| visible | WS_VISIBLE | 30 / 30 | 31 | 403 ms | 240/s | visible |
| minimized (`SC_MINIMIZE`) | WS_VISIBLE + iconic | 30 / 30 | 30 | 403 ms | 240/s | visible |
| minimized 390 s (past the 5 min intensive-throttling point) | WS_VISIBLE + iconic | 975 / 975 | 975 | 424 ms | 239/s | visible |
| window hidden (`SW_HIDE`) | not WS_VISIBLE | 30 / 30 | 30 | 404 ms | 240/s | visible |
| a window that was never shown (`visible(false)`), from the timer install on | not WS_VISIBLE | 1176 / 1176 in 471 s | (no cells) | 425 ms | 239/s | visible |
| controller `IsVisible(false)` (informational) | WS_VISIBLE | 16 / 31 | 14 | 2806 ms | 0 | hidden |
| minimized + `IsVisible(false)` (informational) | WS_VISIBLE + iconic | 28 / 30 | 28 | 849 ms | 0 | hidden |

Earlier runs also measured the hidden + iconic state that tao's `minimize()` produces offscreen: 975 / 975 over 390 s as well, so the timer runs in all three states.

Answers:

- The timer keeps running minimized like a user minimizes, hidden and never shown, also after 6.5 minutes minimized and 8 minutes never shown (the browser args disable background timer throttling and intensive wake-up throttling as long as the page counts as visible). No Rust tick mitigation is needed. The never-shown window is gated too (count >= 90 percent of elapsed / 400 ms, max gap < 1200 ms, measured from the moment the recorder was installed).
- `IsVisible(false)` does throttle (one wake-up per 0.7 to 2.8 s in this run, up to 5 s in earlier ones; rAF stops). **Rule for W5 / W6 / U1: never call `Webview::hide()` or `SetIsVisible(false)` on an app webview; hide and minimize the WINDOW.** Should a later package need it, the mitigation is the Rust tick (a 400 ms tokio interval emitting to the window).
- `document.visibilityState` stays `visible` while minimized or hidden (CalculateNativeWinOcclusion is off), so the renderer cannot use the Page Visibility API to notice it; `window:shown` from Rust (F11, `html[data-window-shown]`) is the only source, as ARCHITECTURE section 5 already says.
- A minimized or hidden window keeps painting at the display rate (240/s here). 1.1.4 runs with `backgroundThrottling: false` too; perf work that wants to save CPU while minimized must key on `window:shown`.
- Harness note for later packages: in an offscreen run, use `WM_SYSCOMMAND` / raw `ShowWindow` (or a non-offscreen run) to put a window into a user-like state; tao's `minimize()` / `hide()` act on tao's flags, which the raw offscreen show leaves unset.

### 3. A hidden window reaches renderer-boot

- `detached-sp1` created with `visible(false)` and never shown: the full App boots (`app:startupMark('renderer-boot')` arrives from that label, test_bridge `marks`), `IsWindowVisible` false, controller IsVisible true, timers and IPC work (113 IPC fetches during its boot).
- The main window is created hidden too and shows on page load; renderer-boot arrives in every run.

### 4. IPC transport under the F2 CSP

- `window.__TAURI_INTERNALS__.invoke` uses the custom protocol: 300 `http://ipc.localhost/<command>` resource entries for 300 probe invokes (the resource-timing buffer raised to 100000 first; Chromium's default of 250 entries capped the count in the first run), **0 calls of `chrome.webview.postMessage`** (the fallback; counted by wrapping it); the hidden second window uses it too. (WebView2 maps the `ipc:` scheme to `http://ipc.localhost`; WKWebView uses `ipc://localhost`, both are in `connect-src`.)
- The CSP header Tauri serves is `tauri.conf.json`'s policy plus script hashes; a `fetch('http://127.0.0.1:9/')` is blocked with a `connect-src` violation, and the IPC itself causes none.
- Invoke round trip (`test_bridge clock`, tiny JSON): p50 2.0 ms, p95 3.1 ms, min 1.0 ms (4.2-5.0 ms p50 in the earlier runs at 95-100 percent machine CPU). `state:load` (a full state snapshot): p50 1.7 ms.

### 5. Binary data into 20 xterm: Tauri Channel vs alternatives

All runs: 20 streams, 16 KiB frames (4 KiB where stated), 15 s, latency from frame PRODUCTION in Rust to arrival in the page handler ("arrive") and to the xterm write callback ("parsed"). Clock bound per row +-0.55 to +-1.3 ms (see How to run).

**Transport only (the page receives and checks every frame; nothing parses), 20 x 1 MB/s:**

| transport | messages | arrive p50 | p95 | p99 | delivered |
|---|---|---|---|---|---|
| Tauri `Channel<InvokeResponseBody>`, one `Raw` per frame | 19,200 | 2.7 ms | 129 ms | 191 ms | 20 MB/s (4.4 s backlog in the earlier, loaded runs) |
| Tauri Channel, per-window batch, flush at once | 19,103 | 2.6 ms | 109 ms | 203 ms | 20 MB/s |
| Tauri Channel, per-window batch, 4 ms throttle | 3,484 | 5.1 ms | 8.3 ms | 155 ms | 20 MB/s |
| pull: raw invoke long poll, one in flight | 5,985 | 2.8 ms | 8.6 ms | 15.5 ms | 20 MB/s |
| **WebView2 shared buffer, one UI-thread post in flight, no timer** | 17,612 | **0.31 ms (+-0.81)** | **3.7 ms** | 15.1 ms | 20 MB/s |
| shared buffer, 1 / 2 / 4 ms throttle | 9,754 / 5,904 / 3,263 | 1.2 / 1.7 / 2.9 ms | 1.9 / 2.8 / 5.0 ms | 3.4 / 3.5 / 5.6 ms | 20 MB/s |
| shared buffer, 4 KiB frames | 38,172 | 0.43 ms | 1.6 ms | 7.1 ms | 20 MB/s |
| shared buffer, 20 x 2 MB/s | 24,433 | 0.59 ms | 51 ms | 131 ms | 40 MB/s |

Earlier runs of the chosen transport (loaded machine, one calibration for the whole run, so up to about 0.3 ms of uncorrected drift): p50 0.28 / 0.33 / 0.56 / 0.98 ms; in every run it was the only transport with p50 under 2 ms.

Why the Tauri Channel misses: for a raw body of 1 KiB or more, `Channel::send` evaluates a script in the page, which then FETCHES the body from `plugin:__TAURI_CHANNEL__|fetch` (tauri 2.12.5 `ipc/channel.rs`): two UI-thread hops and one custom-protocol round trip (1 ms minimum, 2 ms p50 here) per message. At 1,280 frames/s that is at the limit: the p50 sits above 2 ms and the tail backs up (p95 over 100 ms; seconds at 94-100 percent machine CPU). Batching helps only with a throttle, and then the throttle is the latency. Smaller raw bodies go as a JSON array of numbers in an eval (worse for bulk data).

**Into the 20 cell terminals:**

| run | messages | arrive p50 / p95 | parsed p50 / p95 | fps |
|---|---|---|---|---|
| renderer alone (`local`: the page makes the same output itself, no IPC), 20 x 256 KiB/s | 4,800 | 0 | 5.7 / 7.5 ms | 238 |
| shared buffer, 20 x 256 KiB/s | 4,793 | 1.8 / 11.4 ms | 2.7 / 21 ms | 228 |
| shared buffer, 20 x 256 KiB/s, 4 KiB frames | 17,237 | 11.4 / 24.7 ms | 20 / 38.5 ms | 122 |
| pull, 20 x 256 KiB/s | 3,692 | 4.8 / 8.4 ms | 6.0 / 9.7 ms | 240 |
| Tauri Channel batched, 4 ms throttle, 20 x 256 KiB/s | 3,387 | 30 / 62 ms | 36 / 71 ms | 169 |
| Tauri Channel per frame, 20 x 256 KiB/s | 4,800 | 569 / 1,142 ms | 600 / 1,163 ms | 107 |
| Tauri Channel per frame, 1 x 1 MB/s | 960 | 2.6 / 3.7 ms | 3.2 / 4.5 ms | 240 |
| renderer alone, 20 x 1 MB/s | 19,200 | 0 | 22.8 / 69 ms | 109 |
| pull, 20 x 1 MB/s | 931 | 26.6 / 54.8 ms | 34 / 69 ms | 133 |
| shared buffer, 20 x 1 MB/s | 18,369 | 38.9 / 302 ms | 64 / 643 ms | 36 |
| Tauri Channel per frame, 20 x 1 MB/s | 19,200 | 4,169 / 5,276 ms | 5,889 / 11,520 ms | 10.5 |

Every frame of every run arrived, in order, with no send error and no post stall (in-order check per stream).

Answers:

- **PLAN acceptance as written ("Channel p50 < 2 ms at 20 x 1 MB/s", into 20 xterm): NOT met** by any transport (best: pull, 26.6 ms arrive p50; the renderer alone parses at 22.8 ms p50 and 109 fps). **Transport only, the WebView2 shared buffer meets p50 < 2 ms** (0.31 ms, +-0.81 ms clock bound, p95 3.7 ms); `tauri::ipc::Channel` does not (2.7 ms p50 with a 129 ms p95 at best, seconds of backlog under load). That is the substitute acceptance, pending the user's decision (see Status).
- **The shared buffer has no backpressure from the renderer.** "One post in flight" only means the flusher waits until the WebView2 UI thread has called `PostSharedBufferToScript`; that call returns before the page has handled the buffer. When the page is the bottleneck (into xterm at 20 x 1 MB/s) the posts queue in the renderer with about one frame each (18,369 messages for 19,200 frames) instead of growing into bigger batches, and each holds its own shared-memory section until `releaseBuffer`. The result is worse than the consumer-gated pull (38.9 ms vs 26.6 ms arrive p50, 36 vs 133 fps, 931 messages) at the same load. The production sender (P2) must therefore gate posts on the renderer: a page-side release ack that caps the buffers in flight per window (so batches grow while the page is busy) and/or the FlowGate byte acks (1 MiB / 256 KiB) that hold the producers back. P2's acceptance now includes a check that the posts in flight stay bounded with the renderer saturated; SP5 compares the gated shared buffer with pull into xterm, and pull stays the fallback if the gated shared buffer does not beat it there.
- 20 x 1 MB/s into 20 xterm is at the renderer's own limit: with no IPC at all it kept 109 fps in this run but needed 22.8 ms p50 to parse, and in the earlier runs at 94-100 percent machine CPU it fell to 20 fps (parsed p50 0.9 s). No transport fixes that part; the FlowGate has to hold the producers back. SP5's "20 cells at 1 MB/s keep 60 fps" must be measured against Electron 1.1.4 on the same machine at the same load.
- At a rate the renderer can take (20 x 256 KiB/s) the shared buffer adds nothing measurable (parsed p50 2.7 ms against 5.7 ms for the page's own generator, whose timer loop is coarser); 4 KiB frames there cost more (more, smaller posts).

## Decision: the Windows data plane (changes ARCHITECTURE sections 1, 3, 9 and PLAN P2 / SP5 / D12)

1. **Windows: bulk Rust -> renderer data (pty output, and later large SFTP / DB result chunks) goes through WebView2 shared buffers**: per window one sender thread, frames queued by the producers, the queue written into one `ICoreWebView2Environment12::CreateSharedBuffer` buffer and posted with `ICoreWebView2_17::PostSharedBufferToScript` (read-only, additional data JSON names the port), no fixed timer. At most one post is queued on the WebView2 UI thread (the next batch waits until the UI thread has posted the last one, so a busy UI thread makes batches bigger); a UI thread slower than 2 s is waited for and counted, never answered with a second post. That limit is against the UI thread only: **the renderer side needs its own gate** (page-side release ack capping the buffers in flight per window, plus the FlowGate byte acks), see Answers above. The page listens to `chrome.webview` `sharedbufferreceived`, copies (or parses) the frames and calls `chrome.webview.releaseBuffer`. The bridge exposes it through the existing fake MessagePort (`mc:pty-port`), so TerminalManager does not change. Byte acks back to Rust stay on `mc_port_post` (they are small and few).
2. `tauri::ipc::Channel` stays for low-rate traffic (progress events, control messages, the port's JSON messages) and as the fallback if `ICoreWebView2_17` is missing (a WebView2 Runtime without shared buffers, before about 1.0.1661; the app's installer bootstraps a current runtime, so the fallback is a safety net, not a code path we tune).
3. macOS has no shared buffer. Candidates, to be measured on a Mac (SP5 / W2): the pull transport (raw invoke long poll, one in flight: 2.8 ms p50 transport-only and the best into-xterm result on WebView2; WKWebView's `ipc://` scheme handler is cheaper than WebView2's) or a batched Channel with a throttle. Until then the plan for macOS is pull.
4. Never `Webview::hide()` / `IsVisible(false)` on an app webview (question 2).

## Not done in this spike (open)

- **WKWebView in CI uses the same IPC** (PLAN scope item, open blocker for macOS): not run. There is no Mac and CI was never run (the branch is not pushed); on macOS there is no CDP either, so the check needs the debug-only eval bridge of the plan (W2). What the check must show: invokes go to `ipc://localhost/<cmd>` (not the postMessage fallback) under the same CSP. Tauri 2.12.5 uses the custom protocol on macOS by default (`ipc://localhost`, in `connect-src`), so the risk is low, but it is unverified.
- The macOS data-plane measurement (decision point 3).
- The renderer-gated shared-buffer sender (decision point 1) is not built or measured; P2 builds it, SP5 measures it into xterm against pull.
- The user's decision on the substitute acceptance (Status).
