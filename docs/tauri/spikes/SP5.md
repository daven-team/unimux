# SP5: Rust ConPTY + Channel data plane (spike result)

Date: 2026-11-06. Machine: Windows 11 26200, WebView2 156, 240 Hz display, shared with other agents' builds (numbers are
noisy; every comparison below was run interleaved, Electron and Tauri back to back). Branch `tauri-pkg-SP5`.

## Questions and answers

| question | answer |
|---|---|
| portable-pty 0.9 or an own wrapper? | **Own wrapper** over the `windows` crate (`unimux-pty::conpty`, about 600 lines). portable-pty always creates the pseudoconsole with INHERIT_CURSOR, RESIZE_QUIRK and WIN32_INPUT_MODE (node-pty 1.1.0 uses flags 0, so the shell would see a different console), has no Job Object, no ConptyReleasePseudoConsole and closes the console on the caller's thread. |
| Sideloaded conpty.dll 1.23 works from Rust? | Yes. `ConptyApi::load(dir)` loads `conpty.dll` with LOAD_WITH_ALTERED_SEARCH_PATH (it starts the `OpenConsole.exe` next to it) and uses `ConptyCreate/Resize/Close/ReleasePseudoConsole`; without the files it falls back to kernel32. Same calls as node-pty with `useConptyDll`: flags 0, `STARTF_USESTDHANDLES` with null std handles, `bInheritHandles` false, `CREATE_UNICODE_ENVIRONMENT`, release right after CreateProcess, node-pty's command line quoting (golden cases written by node-pty itself). |
| ClosePseudoConsole deadlock? | None in 50 + 10 rounds of close-under-flood with the reader paused by flow control (the worst case: OpenConsole blocked on a full pipe). The close runs on its own thread and opens the pause gate, the reader drains to EOF, then the exit is reported. Close took p50 5 to 20 ms, p95 89 to 115 ms, max 142 to 313 ms (bundled), inbox kernel32 p50 19 to 29 ms. |
| Job Object | Child created suspended, assigned to a job without limits (no kill-on-close), resumed. A kill goes in node-pty's order: input closed, ClosePseudoConsole (attached programs get CTRL_CLOSE), TerminateProcess(shell, 1), then TerminateJobObject for the rest (a detached `start /min` child dies too). A shell that ends by itself leaves detached programs running, as in 1.1.4 (only its killAll timeout tree-kills). With the bundled dll a console-attached grandchild also dies without the job (OpenConsole's close); 1.1.4 needed `taskkill /T` for detached ones. 30 parallel kills: all exits in 43 to 75 ms. |
| Output after exit | Delivered before the exit in 10 of 10 rounds (3,000 lines, exit reported only after EOF). With the dll + Release the exit is reported when the output pipe ends, like node-pty's dll path: a `start /b` child that outlives the shell keeps running and printing (4 of 4 ping replies before the exit at about 3.2 s, the shell ended at about 0.1 s). Only the in-box API closes the console 1 s after the shell ended (node-pty's FLUSH_DATA_INTERVAL). |
| Binary frames + byte acks into 20 xterm cells | Works through one `Channel<InvokeResponseBody::Raw>` per page: frames `[u8 kind][u16 LE idLen][id][u32 LE len][payload]`, several frames per message, xterm `write(Uint8Array)`, acks of parsed bytes batched per 16 ms, FlowGate 1 MiB / 256 KiB pauses the reader (149 pauses in one 15 s flood, no stall). Decoding costs 1 to 2 percent of the main thread. |
| Channel message cost | **The deciding number.** At 20 MB/s into 20 cells: one message per read 10 fps, a 4 ms batch window 32 to 39 fps, a 16 ms window 192 to 231 fps. A per-window batcher with a 16 ms window and a 4 ms window for the focused cell's output (1.1.4's ECHO 4 ms / BULK 12 ms / BACKGROUND 33 ms) is required. |
| timeBeginPeriod(1) | Held by `TimerResolution` while terminals run (refcounted guard). The pty layer itself is event driven (echo 0.1 ms with or without it); it matters for the batch windows (condvar timeouts tick at 15.6 ms otherwise). |
| win32-input-mode, focus 1004 | OpenConsole 1.23 asks for both at start (`CSI ? 9001 h`, `CSI ? 1004 h`) exactly as under node-pty; keys encoded by `shared/win32input.ts` reach PowerShell and cmd, xterm's focus in / out reports reach the pty. |
| DA1 | **New finding:** OpenConsole 1.23 sends DA1 (`CSI c`) and holds the client's first output until the terminal answers, up to about 3 s (measured 128 ms answered, 3,077 ms unanswered). xterm answers at once, so cells with a renderer are fine; a terminal started with no xterm attached (headless agents, a window that is still loading) waits 3 s. Same dll and behaviour as 1.1.4; P2 should answer DA1 host-side when no renderer is attached within about 100 ms. |

## Code (stays for P1 / P2)

- `src-tauri/crates/unimux-pty/src/conpty.rs`: ConptyApi (bundled / inbox), SpawnOptions, Pty (reader thread with pause gate, writer thread so input never blocks, waiter with exit drain, close off-thread while draining, kill = job terminate + close, resize, pause handle), TimerResolution.
- `src/cmdline.rs` + `tests/fixtures/cmdline.json` (25 cases from node-pty 1.1.0 via `scripts/sp5/cmdline-golden.cjs`).
- `src/frame.rs`: frame encode / decode.
- `src/plane.rs`: the measured data plane (per-window batcher with focus window, byte-ack flow gate, synthetic streams for measurements). P2 replaces it with OutputChannel / FlowGate / TailBuffer.
- `src/bin/unimux-pty-flood.rs`: paced colored-line generator used by the tests and the real-app runs.
- `tests/conpty.rs` (10 cases), `examples/sp5_echo.rs` (pty-layer echo).
- `src-tauri/crates/unimux-app/src/spike_pty.rs`: check-flavour-only commands `spike_pty_attach` / `spike_pty` (feature test-bridge; the release build has neither).
- `scripts/sp5/run.mjs` (Tauri), `scripts/sp5/electron-ref.mjs`, `scripts/sp5/electron-grid.mjs` (1.1.4), `scripts/sp5/latency-probe.mjs` (the perf-latency.mjs probe shared by both), `scripts/sp5/page.ts` (xterm with TerminalManager's options, served under the app origin through the DevTools Fetch domain, so the shipped renderer is untouched), `scripts/sp5/echo-node-pty.mjs`.

## Measurements

### Rendering (PowerShell and Claude Code)

`node scripts/sp5/run.mjs render` (Tauri) and `node scripts/sp5/electron-ref.mjs` (1.1.4, Electron build of this tree). No
pwsh is installed here, so both resolve to Windows PowerShell like 1.1.4's resolveShell does. Claude Code 2.1.319 with a
scratch CLAUDE_CONFIG_DIR (theme picker, no model use).

| check | 1.1.4 | Tauri + Rust ConPTY |
|---|---|---|
| ConPTY asked for win32-input-mode | yes | yes (22 keys sent as CSI ... _) |
| typed `echo w32ok` echoed and run | yes | yes |
| focus 1004 in / out reach the pty | (not scripted) | yes / yes |
| wrapped 95-char command, cell narrowed, typing continued: command and output intact | yes (50 -> 11 cols) | yes (152 -> 40 cols) |
| Claude theme picker drawn completely | yes | yes |

Screenshots: `sp5/electron-1.1.4-powershell-claude.png`, `sp5/tauri-powershell-claude.png`, `sp5/tauri-resize-narrow.png`.
Same glyphs, colors, block art and box drawing; the only differences are the app chrome (1.1.4 has its cell headers) and the
widths. Not a pixel diff: the 1.1.4 cells sit inside the full UI.

### Echo latency (keystroke -> drawn, ms)

The probe of `scripts/perf-latency.mjs` (keydown -> echo parsed -> next xterm render, cmd.exe, 60 keys per pace), shared
by both apps (`scripts/sp5/latency-probe.mjs`). 1.1.4: `node scripts/perf-latency.mjs 60 --json` (local shell cell).
Tauri: `node scripts/sp5/run.mjs latency` (16 ms batch, 4 ms focus window, timeBeginPeriod on). Median / p95.

| run | 1.1.4 spaced | 1.1.4 burst | Tauri spaced | Tauri burst |
|---|---|---|---|---|
| quiet machine, interleaved pair 1 | 2.2 / 8.1 | 6.1 / 8.1 | 2.1 / 4.6 | 2.6 / 7.0 |
| pair 2 | 7.0 / 54.0 | 8.5 / 57.9 | 3.2 / 8.4 | 5.3 / 8.7 |
| pair 3 | 7.2 / 52.7 | 7.5 / 71.0 | 2.7 / 4.9 | 3.0 / 5.6 |
| after the focus-message change | | | 2.3 / 3.4 | 2.3 / 4.8 |
| earlier, loaded machine (4 ms batch) | 7.0 / 38.6, 12.4 / 89.0, 7.2 / 24.3 | 6.9 / 8.4, 11.1 / 40.3, 18.8 / 76.7 | 5.3 / 21.9, 3.0 / 5.3, 3.9 / 8.2 | 8.1 / 86.3, 2.9 / 6.5, 4.8 / 70.3 |

Tauri is at or below 1.1.4 in every interleaved pair, median and p95 (p95 well under 1.1x).

Pty layer only (no renderer, `examples/sp5_echo.rs` vs `scripts/sp5/echo-node-pty.mjs`, cmd.exe, 60 keys): Rust p50 0.10 to
0.12, p95 0.22 to 0.42 (bare Pty and full plane alike); node-pty 1.1.0 in Node (own conout worker) p50 10 to 25, p95 53 to
65; with 1.1.4's shared conout thread p50 0.4 to 3.8, p95 6 to 57. The pty layer is never the bottleneck.

Echo while the 19 other cells of a 5x4 grid run unimux-pty-flood at 1 MB/s (`electron-grid.mjs 20 1000000 5 --latency=60`
vs `run.mjs latency --load=19`), median / p95 drawn:

| run | 1.1.4 spaced | 1.1.4 burst | Tauri spaced | Tauri burst |
|---|---|---|---|---|
| pair 1 | 12.9 / 32.8 | 9.5 / 33.4 | 19.3 / 35.7 | 20.0 / 32.0 |
| pair 2 | 9.5 / 413.8 | 9.0 / 42.5 | 13.3 / 30.3 | 99.2 / 857.6 |
| Tauri, focused output in its own message | | | 28.0 / 58.1, 26.0 / 72.5 | 29.1 / 170.6, 18.8 / 61.9 |
| Tauri, synthetic load (4 ms batch, early) | | | 91.4 / 147.7 | 50.8 / 170.1 |

Under load the spike is slower than 1.1.4 in the median (13 to 28 ms vs 9 to 13 ms): the echo waits on the renderer main
thread behind xterm's write queues of the other 19 terminals (up to 1 MiB unacked each), not in Rust. Not part of SP5's
acceptance; an input for P2 (see open issues).

### 20 cells at 1 MB/s

Grid 5x4 at font 11 in the 1100x700 offscreen window, WebGL in all 20 cells, 15 s of rAF intervals.

| source | app | delivered to xterm | fps | p95 frame | max | frames > 50 ms | app CPU |
|---|---|---|---|---|---|---|---|
| unimux-pty-flood 1 MB/s in ConPTY | 1.1.4 (run 1) | 4.5 MB/s | 217 | 8.3 ms | 117 ms | 25 | 134 % |
| same | 1.1.4 (run 2) | 24.0 MB/s | 30 | 112.6 ms | 125 ms | 126 | 229 % |
| same, 4 ms batch | Tauri | 0.9 / 1.2 / 2.9 / 13.0 MB/s | 237 / 238 / 211 / 116 | 4.3 / 4.3 / 4.3 / 37.4 ms | 17 / 17 / 117 / 117 ms | 0 / 0 / 10 / 72 | 150 to 213 % |
| same, 16 ms + 4 ms focus | Tauri | 20.1 MB/s | 82 | 41.7 ms | 108 ms | 45 | 213 % |
| synthetic 20 x 1 MB/s (no ConPTY) | Tauri, no batching | 20.0 MB/s | 10 | 104 ms | 113 ms | 148 | 362 % |
| same | Tauri, 4 ms batch | 20.0 MB/s | 32 / 39 | 54 ms | 75 to 100 ms | 39 / 41 | 252 to 267 % |
| same | Tauri, 16 ms batch | 20.0 MB/s | 231 | 4.3 ms | 21 ms | 0 | 173 % |
| same | Tauri, 16 ms + 4 ms focus | 19.9 MB/s | 192 | 8.5 ms | 79 ms | 2 | 209 % |
| synthetic 20 x 0.25 / 0.5 / 0.75 MB/s | Tauri, 4 ms batch | 5 / 10 / 15 MB/s | 221 / 209 / 240 | 4.3 / 8.4 / 4.3 ms | 458 / 17 / 8 ms | 1 / 0 / 0 | 222 to 283 % |

ConPTY repaints its viewport and drops lines that scroll past between two of its frames, so what reaches xterm from a 1 MB/s
program varies from run to run (0.9 to 24 MB/s for 20 cells, in both apps). The renderer is the limit at around 20 MB/s
of xterm parsing, in 1.1.4 as in Tauri; the Rust side (reader, frames, Channel, decode) is not. Electron 1.1.4 with its
own writer (`scripts/perf-grid.mjs sp5-1mb 20 600`, bursts every 66 ms): 227 fps, p95 12.4 ms, max 46 ms.

### Close under flood in the app

20 flooding cells killed at once: all exit frames in 236 to 450 ms, no terminal left in Rust.

## Acceptance (PLAN.md SP5)

| criterion | result |
|---|---|
| pwsh and claude render like 1.1.4 (screenshots, resize reflow, win32-input-mode, focus 1004) | met (Windows PowerShell, no pwsh on this machine; screenshots compared by eye, not pixel-diffed) |
| 50 ClosePseudoConsole-under-flood iterations without deadlock | met (cargo test `close_under_flood_50_rounds_no_deadlock`) |
| echo p50/p95 within 1.1x of 1.1.4 | met (idle, the case perf-latency.mjs measures): Tauri at or below 1.1.4 in all interleaved pairs; under a 19-cell flood the Tauri median is worse (open issue for P2) |
| 20 cells at 1 MB/s keep 60 fps | partly: met for what ConPTY delivers in most runs and for synthetic 20 MB/s with the 16 ms batcher (192 to 231 fps); NOT met in the runs where ConPTY passed about 13 to 20 MB/s (82 to 116 fps on average but 45 to 72 frames over 50 ms). 1.1.4 fails the same load harder (30 fps at 24 MB/s). |

## Decisions for the plan

1. P1 uses `unimux-pty::conpty` (own wrapper), not portable-pty.
2. Frames carry a u32 payload length so one Channel message holds many terminals' output: `[u8 kind][u16 LE idLen][id][u32 LE len][payload]`.
3. P2's per-window batcher sends at most one Channel message per 16 ms, with the focused terminal's output (and the echo after a keystroke) on the 4 ms window; the 4/12/33 ms per-terminal windows of 1.1.4 stay for the per-terminal OutputChannel, but the Channel itself must be batched across terminals.
4. Input goes through a writer thread per terminal (a blocked console never blocks the IPC handler).
5. P2 answers DA1 host-side when no renderer is attached (OpenConsole 1.23 otherwise holds the start for 3 s).
6. The conpty.dll / OpenConsole.exe 1.23.251008001 x64 files are taken from node-pty's third_party copy for now (tests find them in node_modules or `UNIMUX_CONPTY_DIR`); P1 commits them under `src-tauri/resources/conpty/x64/` and the app loads them from its resource dir.

## Open issues

- Echo under load: with 19 cells flooding, the focused cell's echo waits for xterm's write queue of the other terminals (each may hold 1 MiB unacked). See the loaded latency numbers above; P2 should give background terminals a smaller unacked window (or pause them while the focused one is typed into).
- ConPTY output volume under flood varies strongly between runs (its frame collapse), which makes fps comparisons noisy; a fixed-load comparison of 1.1.4 is only possible through ConPTY.
- One unreproduced flake in about 15 runs of the conpty suite (`job_object_kills_the_whole_tree`: no exit 5 s after the kill, under heavy load); the assertion now prints the process and close state.
- Separate messages for the focused terminal (implemented in plane.rs) did not measurably help the loaded echo; the cost is on the renderer.
- No macOS half (Unix pty is P1).
- No pixel diff of the renders; the claude screen in 1.1.4 runs through the launch line, the spike starts `claude` directly.
