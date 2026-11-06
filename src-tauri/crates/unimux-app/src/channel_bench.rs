//! Check-build only (feature `test-bridge`): the Rust -> page data-plane bench of spike SP1 (docs/tauri/spikes/SP1.md),
//! kept for P1 / SP5 / perf work.
//!
//! `test_channel_bench` runs `streams` producer threads (one per terminal, like the pty reader threads of P1), each emitting
//! terminal-like output at `bytesPerSec` in frames of `chunk` bytes. Every frame starts with a 16-byte header: the time it
//! was produced (f64 LE, ms since the Unix epoch), its number (u32 LE) and the stream id (u32 LE); the page subtracts the
//! production time from its own clock (calibrated with the `clock` op of test_bridge), so batching delay counts as latency.
//!
//! How the frames reach the page (`mode`):
//! - `perFrame`: every frame is one `Channel::send(InvokeResponseBody::Raw)` (Tauri: an eval plus a fetch per frame).
//! - `batched`: frames are queued per window; a flusher sends everything queued as ONE raw Channel message, at once when
//!   idle and then at most every `flushMs` (leading edge + throttle). Message body: `[u32 LE len][frame]...`.
//! - `pull`: the same queue, drained by the page with `test_channel_pull` (a raw invoke answered as soon as data is queued,
//!   or after 100 ms empty): one request in flight, no eval.
//! - `sharedBuffer` (Windows): the flusher writes the queue into a WebView2 shared buffer and posts it with
//!   `ICoreWebView2_17::PostSharedBufferToScript` (the page gets `sharedbufferreceived`), no eval, no fetch. One closure
//!   in flight on the UI thread; no backpressure from the renderer (see `post_shared_buffer`).
//!
//! The command answers when every stream has ended and the queue is drained, with the sender-side numbers.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use tauri::Webview;
use tauri::ipc::{Channel, InvokeResponseBody, Response};

use unimux_ipc::IpcError;

/// Frame header: production time f64, frame number u32, stream id u32.
pub const HEADER: usize = 16;

fn fail(m: &str) -> IpcError {
    IpcError::failed("test_channel_bench", m)
}

/// Milliseconds since the Unix epoch with sub-millisecond precision (the page compares it with timeOrigin + now()).
pub fn epoch_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64() * 1000.0).unwrap_or(0.0)
}

/// 256 KiB of output like an agent CLI prints it: SGR colours, a progress line with CR, CRLF line ends, some UTF-8.
fn pool() -> &'static [u8] {
    static POOL: OnceLock<Vec<u8>> = OnceLock::new();
    POOL.get_or_init(|| {
        let mut out = Vec::with_capacity(256 * 1024 + 256);
        let mut n: u32 = 0;
        while out.len() < 256 * 1024 {
            n += 1;
            let colour = 31 + (n % 7);
            let line = match n % 5 {
                0 => format!("\x1b[{colour}m\u{25cf}\x1b[0m Read \x1b[1msrc/renderer/src/terminals/TerminalManager.ts\x1b[0m ({n} lines)\r\n"),
                1 => format!("  \x1b[2m\u{2502}\x1b[0m {n:>6} \x1b[32m+\x1b[0m   const value = compute(\"za\u{17c}\u{f3}\u{142}\u{107} g\u{119}\u{15b}l\u{105} ja\u{17a}\u{144}\", {n});\r\n"),
                2 => format!("\r\x1b[K\x1b[36m\u{280b}\x1b[0m Thinking\u{2026} ({}s \u{b7} \u{2193} {} tokens)", n % 60, n * 7),
                3 => format!("\r\n\x1b[38;5;{}m{}\x1b[0m\r\n", n % 256, "\u{2500}".repeat(40)),
                _ => format!("{n:08x}  64 61 74 61 20 66 72 61 6d 65 20 74 65 73 74 21  |data frame test!|\r\n"),
            };
            out.extend_from_slice(line.as_bytes());
        }
        out
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Mode {
    PerFrame,
    Batched,
    Pull,
    SharedBuffer,
}

#[derive(Debug, Clone, Copy)]
struct Plan {
    id: u32,
    streams: u32,
    frame: usize,
    interval: Duration,
    frames: u64,
    mode: Mode,
    flush: Duration,
}

fn plan(args: &Value) -> Result<Plan, IpcError> {
    let id = args.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
    let streams = args.get("streams").and_then(Value::as_u64).unwrap_or(1) as u32;
    let rate = args.get("bytesPerSec").and_then(Value::as_f64).unwrap_or(1_048_576.0);
    let chunk = args.get("chunk").and_then(Value::as_u64).unwrap_or(16 * 1024) as usize;
    let seconds = args.get("seconds").and_then(Value::as_f64).unwrap_or(10.0);
    let flush_ms = args.get("flushMs").and_then(Value::as_f64).unwrap_or(4.0);
    let mode = match args.get("mode").and_then(Value::as_str).unwrap_or("perFrame") {
        "perFrame" => Mode::PerFrame,
        "batched" => Mode::Batched,
        "pull" => Mode::Pull,
        "sharedBuffer" => Mode::SharedBuffer,
        other => return Err(fail(&format!("unknown mode {other}"))),
    };
    if !(1..=64).contains(&streams)
        || !(1.0..=1e9).contains(&rate)
        || !(HEADER + 1..=4 * 1024 * 1024).contains(&chunk)
        || !(0.0..=600.0).contains(&seconds)
        || !(0.0..=1000.0).contains(&flush_ms)
    {
        return Err(fail("streams 1..64, bytesPerSec 1..1e9, chunk 17..4 MiB, seconds 0..600, flushMs 0..1000"));
    }
    let interval = Duration::from_secs_f64(chunk as f64 / rate);
    let frames = ((seconds * rate) / chunk as f64).ceil() as u64;
    Ok(Plan { id, streams, frame: chunk, interval, frames, mode, flush: Duration::from_secs_f64(flush_ms / 1000.0) })
}

fn frame(size: usize, stream: u32, seq: u64, offset: &mut usize) -> Vec<u8> {
    let pool = pool();
    let mut buf = Vec::with_capacity(size);
    buf.extend_from_slice(&[0u8; HEADER]);
    while buf.len() < size {
        let take = (size - buf.len()).min(pool.len() - *offset);
        buf.extend_from_slice(&pool[*offset..*offset + take]);
        *offset = (*offset + take) % pool.len();
    }
    buf[8..12].copy_from_slice(&(seq as u32).to_le_bytes());
    buf[12..16].copy_from_slice(&stream.to_le_bytes());
    buf
}

/// The frames waiting for the page (batched, pull, sharedBuffer), as `[u32 LE len][frame]...`.
#[derive(Default)]
struct Hub {
    queue: Mutex<Vec<u8>>,
    ready: Condvar,
    producers_done: AtomicBool,
    messages: AtomicU64,
    max_message: AtomicU64,
    /// sharedBuffer: posts whose UI-thread closure took longer than 2 s (still awaited, not counted as errors).
    post_stalls: AtomicU64,
}

impl Hub {
    fn push(&self, frame: &[u8]) {
        let mut q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        q.extend_from_slice(&(frame.len() as u32).to_le_bytes());
        q.extend_from_slice(frame);
        self.ready.notify_all();
    }

    /// Everything queued, waiting up to `wait` for the first byte. Empty when nothing came.
    fn take(&self, wait: Duration) -> Vec<u8> {
        let mut q = self.queue.lock().unwrap_or_else(|e| e.into_inner());
        if q.is_empty() && !self.producers_done.load(Ordering::SeqCst) {
            q = self.ready.wait_timeout(q, wait).unwrap_or_else(|e| e.into_inner()).0;
        }
        let out = std::mem::take(&mut *q);
        if !out.is_empty() {
            self.messages.fetch_add(1, Ordering::Relaxed);
            self.max_message.fetch_max(out.len() as u64, Ordering::Relaxed);
        }
        out
    }

    fn finish(&self) {
        self.producers_done.store(true, Ordering::SeqCst);
        self.ready.notify_all();
    }

    fn is_empty(&self) -> bool {
        self.queue.lock().unwrap_or_else(|e| e.into_inner()).is_empty()
    }
}

fn hubs() -> &'static Mutex<HashMap<u32, Arc<Hub>>> {
    static HUBS: OnceLock<Mutex<HashMap<u32, Arc<Hub>>>> = OnceLock::new();
    HUBS.get_or_init(Default::default)
}

#[derive(Default)]
struct ProducerStats {
    frames: u64,
    bytes: u64,
    send_errors: u64,
    total_send: Duration,
    max_send: Duration,
    max_lag: Duration,
}

/// One stream, paced against its start time so a late frame does not shift the rest (`maxLagMs` shows how late it was).
fn produce(plan: Plan, stream: u32, start: Instant, out: &dyn Fn(Vec<u8>) -> bool) -> ProducerStats {
    let mut s = ProducerStats::default();
    let mut offset = (stream as usize * 7919) % pool().len();
    // Streams start spread over one interval, like terminals that do not print in lockstep.
    let phase = plan.interval.mul_f64(f64::from(stream) / f64::from(plan.streams.max(1)));
    for seq in 0..plan.frames {
        let due = start + phase + plan.interval * seq as u32;
        let now = Instant::now();
        if due > now {
            std::thread::sleep(due - now);
        } else {
            s.max_lag = s.max_lag.max(now - due);
        }
        let mut buf = frame(plan.frame, stream, seq, &mut offset);
        buf[0..8].copy_from_slice(&epoch_ms().to_le_bytes());
        let len = buf.len() as u64;
        let t = Instant::now();
        if out(buf) {
            s.frames += 1;
            s.bytes += len;
        } else {
            s.send_errors += 1;
        }
        let took = t.elapsed();
        s.total_send += took;
        s.max_send = s.max_send.max(took);
    }
    s
}

/// Sends what the hub holds: at once when idle, then at most every `flush` (batched / sharedBuffer modes).
fn flusher(hub: Arc<Hub>, flush: Duration, send: Box<dyn Fn(Vec<u8>) -> bool + Send>) -> u64 {
    let mut errors = 0;
    loop {
        let batch = hub.take(Duration::from_millis(50));
        if batch.is_empty() {
            if hub.producers_done.load(Ordering::SeqCst) && hub.is_empty() {
                break;
            }
            continue;
        }
        if !send(batch) {
            errors += 1;
        }
        if !flush.is_zero() {
            std::thread::sleep(flush);
        }
    }
    errors
}

/// Posts one batch as a WebView2 shared buffer and waits until the UI thread has called `PostSharedBufferToScript`.
///
/// What "one post in flight" covers: the flusher does not queue a second closure on the UI thread while one is pending,
/// so a busy UI thread makes the next batch bigger. It does NOT cover the renderer: `PostSharedBufferToScript` returns
/// before the page handled the buffer, so when the page is the bottleneck the posts (each its own shared-memory section
/// until `releaseBuffer`) queue in the renderer with about one frame each (SP1: 287 ms arrive p50 into 20 xterm at
/// 20 x 1 MB/s). The production sender (P2) must bound that with the FlowGate byte acks or a page-side release ack.
///
/// A UI thread that takes longer than 2 s is waited for (counted in `post_stalls`), never answered with a second post:
/// giving up would leave the first closure queued and post the next batch while it is still pending. Only a dropped
/// closure (the window is gone) or a failed COM call returns false, and that batch is lost.
#[cfg(windows)]
fn post_shared_buffer(webview: &Webview, hub: &Hub, bytes: Vec<u8>) -> bool {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY, ICoreWebView2_17, ICoreWebView2Environment12,
    };
    use windows::core::{Interface, w};
    let (tx, rx) = std::sync::mpsc::channel::<bool>();
    let queued = webview
        .with_webview(move |platform| {
            // SAFETY: COM calls on the live environment and webview, on the thread Tauri runs this closure on; the copy
            // stays inside the buffer's own size.
            let posted = unsafe {
                (|| -> windows::core::Result<()> {
                    let env = platform.environment().cast::<ICoreWebView2Environment12>()?;
                    let buffer = env.CreateSharedBuffer(bytes.len() as u64)?;
                    let mut ptr: *mut u8 = std::ptr::null_mut();
                    buffer.Buffer(&mut ptr)?;
                    if ptr.is_null() {
                        return Err(windows::core::Error::empty());
                    }
                    std::ptr::copy_nonoverlapping(bytes.as_ptr(), ptr, bytes.len());
                    let core = platform.controller().CoreWebView2()?.cast::<ICoreWebView2_17>()?;
                    core.PostSharedBufferToScript(&buffer, COREWEBVIEW2_SHARED_BUFFER_ACCESS_READ_ONLY, w!("{\"sp1\":1}"))
                })()
            };
            let _ = tx.send(posted.is_ok());
        })
        .is_ok();
    if !queued {
        return false;
    }
    await_post(&rx, hub, Duration::from_secs(2))
}

/// Waits for the UI-thread closure's answer however long it takes; every `stall` without one counts once in
/// `hub.post_stalls`. False when the closure was dropped without answering or answered with a failure.
#[cfg_attr(not(windows), allow(dead_code))]
fn await_post(rx: &std::sync::mpsc::Receiver<bool>, hub: &Hub, stall: Duration) -> bool {
    use std::sync::mpsc::RecvTimeoutError;
    loop {
        match rx.recv_timeout(stall) {
            Ok(posted) => return posted,
            Err(RecvTimeoutError::Timeout) => {
                hub.post_stalls.fetch_add(1, Ordering::Relaxed);
            }
            Err(RecvTimeoutError::Disconnected) => return false,
        }
    }
}

#[cfg(not(windows))]
fn post_shared_buffer(_webview: &Webview, _hub: &Hub, _bytes: Vec<u8>) -> bool {
    false
}

fn run(plan: Plan, channel: Channel<InvokeResponseBody>, webview: Webview) -> Value {
    let hub = Arc::new(Hub::default());
    if plan.mode == Mode::Pull {
        hubs().lock().unwrap_or_else(|e| e.into_inner()).insert(plan.id, hub.clone());
    }
    let flush_thread = match plan.mode {
        Mode::Batched => {
            let (h, c) = (hub.clone(), channel.clone());
            Some(std::thread::spawn(move || {
                flusher(h, plan.flush, Box::new(move |b| c.send(InvokeResponseBody::Raw(b)).is_ok()))
            }))
        }
        Mode::SharedBuffer => {
            let (h, w) = (hub.clone(), webview.clone());
            let posting = h.clone();
            Some(std::thread::spawn(move || flusher(h, plan.flush, Box::new(move |b| post_shared_buffer(&w, &posting, b)))))
        }
        Mode::PerFrame | Mode::Pull => None,
    };
    let start = Instant::now() + Duration::from_millis(20);
    let producers: Vec<_> = (0..plan.streams)
        .map(|stream| {
            let (hub, channel) = (hub.clone(), channel.clone());
            std::thread::Builder::new()
                .name(format!("channel-bench-{stream}"))
                .spawn(move || {
                    let out = |buf: Vec<u8>| match plan.mode {
                        Mode::PerFrame => channel.send(InvokeResponseBody::Raw(buf)).is_ok(),
                        _ => {
                            hub.push(&buf);
                            true
                        }
                    };
                    produce(plan, stream, start, &out)
                })
                .expect("bench thread")
        })
        .collect();
    let stats: Vec<ProducerStats> = producers.into_iter().map(|h| h.join().unwrap_or_default()).collect();
    hub.finish();
    let flush_errors = flush_thread.map(|h| h.join().unwrap_or(0)).unwrap_or(0);
    if plan.mode == Mode::Pull {
        // The page drains the rest; it stops pulling once the bench answered and a pull came back empty.
        let deadline = Instant::now() + Duration::from_secs(30);
        while !hub.is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
        hubs().lock().unwrap_or_else(|e| e.into_inner()).remove(&plan.id);
    }
    let elapsed = (Instant::now().saturating_duration_since(start)).as_secs_f64();
    let frames: u64 = stats.iter().map(|s| s.frames).sum();
    let bytes: u64 = stats.iter().map(|s| s.bytes).sum();
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    json!({
        "mode": format!("{:?}", plan.mode),
        "frames": frames,
        "bytes": bytes,
        "sendErrors": stats.iter().map(|s| s.send_errors).sum::<u64>() + flush_errors,
        "seconds": elapsed,
        "bytesPerSec": if elapsed > 0.0 { bytes as f64 / elapsed } else { 0.0 },
        "intervalMs": ms(plan.interval),
        "avgSendMs": if frames > 0 { stats.iter().map(|s| ms(s.total_send)).sum::<f64>() / frames as f64 } else { 0.0 },
        "maxSendMs": stats.iter().map(|s| ms(s.max_send)).fold(0.0, f64::max),
        "maxLagMs": stats.iter().map(|s| ms(s.max_lag)).fold(0.0, f64::max),
        "messages": if plan.mode == Mode::PerFrame { frames } else { hub.messages.load(Ordering::Relaxed) },
        "maxMessageBytes": hub.max_message.load(Ordering::Relaxed),
        "postStalls": hub.post_stalls.load(Ordering::Relaxed),
    })
}

#[tauri::command]
pub async fn test_channel_bench(
    webview: Webview,
    channel: Channel<InvokeResponseBody>,
    args: Option<Value>,
) -> Result<Value, IpcError> {
    let plan = plan(&args.unwrap_or(Value::Null))?;
    if plan.mode == Mode::SharedBuffer && !cfg!(windows) {
        return Err(fail("sharedBuffer is WebView2 only"));
    }
    tauri::async_runtime::spawn_blocking(move || run(plan, channel, webview)).await.map_err(|e| fail(&e.to_string()))
}

/// Pull mode: everything queued for bench `id` as one raw body (`[u32 LE len][frame]...`), as soon as there is data or
/// after 100 ms empty (an unknown or finished bench answers empty at once).
#[tauri::command]
pub async fn test_channel_pull(id: u32) -> Result<Response, IpcError> {
    let hub = hubs().lock().unwrap_or_else(|e| e.into_inner()).get(&id).cloned();
    let Some(hub) = hub else { return Ok(Response::new(InvokeResponseBody::Raw(Vec::new()))) };
    let bytes = tauri::async_runtime::spawn_blocking(move || hub.take(Duration::from_millis(100)))
        .await
        .map_err(|e| fail(&e.to_string()))?;
    Ok(Response::new(InvokeResponseBody::Raw(bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frames_have_the_header_and_the_planned_size() {
        let p =
            plan(&json!({ "streams": 20, "bytesPerSec": 1_048_576, "chunk": 16_384, "seconds": 2, "mode": "batched" })).unwrap();
        assert_eq!(p.frames, 128);
        assert_eq!(p.mode, Mode::Batched);
        assert!((p.interval.as_secs_f64() - 0.015_625).abs() < 1e-9);
        let mut offset = 0;
        let a = frame(p.frame, 7, 3, &mut offset);
        assert_eq!(a.len(), 16_384);
        assert_eq!(u32::from_le_bytes(a[8..12].try_into().unwrap()), 3);
        assert_eq!(u32::from_le_bytes(a[12..16].try_into().unwrap()), 7);
        // The payload continues where the last frame stopped (one long output, not the same frame again).
        let b = frame(p.frame, 7, 4, &mut offset);
        assert_ne!(a[HEADER..], b[HEADER..]);
        assert!(std::str::from_utf8(pool()).is_ok());
    }

    #[test]
    fn bad_plans_are_refused() {
        assert!(plan(&json!({ "chunk": 4 })).is_err());
        assert!(plan(&json!({ "bytesPerSec": 0 })).is_err());
        assert!(plan(&json!({ "seconds": 1000 })).is_err());
        assert!(plan(&json!({ "streams": 0 })).is_err());
        assert!(plan(&json!({ "mode": "carrier-pigeon" })).is_err());
    }

    #[test]
    fn the_hub_hands_out_length_prefixed_frames_in_order() {
        let hub = Hub::default();
        hub.push(b"abc");
        hub.push(b"de");
        let all = hub.take(Duration::ZERO);
        assert_eq!(all, [3, 0, 0, 0, b'a', b'b', b'c', 2, 0, 0, 0, b'd', b'e']);
        assert!(hub.take(Duration::from_millis(1)).is_empty());
        hub.finish();
        // After the producers ended an empty take does not wait.
        let t = Instant::now();
        assert!(hub.take(Duration::from_secs(5)).is_empty());
        assert!(t.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn a_slow_post_is_waited_for_and_counted_not_failed() {
        let hub = Hub::default();
        let (tx, rx) = std::sync::mpsc::channel();
        let late = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(120));
            tx.send(true).unwrap();
        });
        assert!(await_post(&rx, &hub, Duration::from_millis(25)));
        late.join().unwrap();
        assert!(hub.post_stalls.load(Ordering::Relaxed) >= 2);
        // A dropped closure (window gone) is a failure, not a hang.
        let (tx, rx) = std::sync::mpsc::channel::<bool>();
        drop(tx);
        assert!(!await_post(&rx, &hub, Duration::from_millis(25)));
    }

    #[test]
    fn producers_keep_the_rate() {
        let p = plan(&json!({ "streams": 2, "bytesPerSec": 100_000, "chunk": 1000, "seconds": 0.2, "mode": "batched" })).unwrap();
        let hub = Hub::default();
        let start = Instant::now();
        let s = produce(p, 1, start, &|b: Vec<u8>| {
            hub.push(&b);
            true
        });
        assert_eq!(s.frames, 20);
        assert!(start.elapsed() >= Duration::from_millis(190));
        assert_eq!(hub.take(Duration::ZERO).len(), 20 * 1004);
    }
}
