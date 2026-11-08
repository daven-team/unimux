//! The per-window batcher of the pty data plane (SP5 decision 3, SP1 data plane): the frames of every terminal shown in
//! one window are collected and leave as one message ([`crate::frame`]) per window:
//!
//! - bulk output at most once per [`BULK_WINDOW`] (16 ms, leading edge: output after a quiet window leaves at once),
//! - output of the focused terminal on the [`FOCUS_WINDOW`] (4 ms),
//! - a keystroke's echo, an exit, a replay and control messages at once (with everything queued before them, in order),
//! - anything over [`BATCH_NOW`] at once.
//!
//! A message is handed to the window's [`Transport`], which blocks until it took it: the WebView2 UI thread posted the
//! shared buffer (Windows; at most one post queued on the UI thread), the page pulled it (pull transport) or the Channel
//! took it. Renderer back-pressure: a gated transport (the page answers every message with a release ack, `released`)
//! may have only a few messages posted and not yet released ([`MAX_IN_FLIGHT`] once they hold [`SMALL_IN_FLIGHT_BYTES`],
//! [`MAX_IN_FLIGHT_SMALL`] while they are small); while the cap is reached the batch keeps growing (one bigger message
//! instead of many). The terminals themselves are held back by their FlowGate byte acks. A release is an IPC call, so the
//! page delays it (and sends it with its next call) unless the message it answers says the host is at the cap
//! ([`Transport::post_hinted`]).
//! The page releases by the host's message number (`upto` = the `n` it was posted with). A cap that sees no release for
//! [`CAP_TIMEOUT`] is lifted (a release that never comes, like the pty pause watchdog), so a window never freezes for good.

use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use serde_json::{Value, json};

use crate::frame;

pub const BULK_WINDOW: Duration = Duration::from_millis(16);
pub const FOCUS_WINDOW: Duration = Duration::from_millis(4);
/// Bulk and focused output of a window nobody sees (minimized or hidden, R2): every message costs a shared buffer, a page
/// wake-up and a release call, and nothing is drawn, so a trickle (agents printing) leaves at most this often. Echoes, exits
/// and anything over [`BATCH_NOW`] still leave at once.
pub const HIDDEN_WINDOW: Duration = Duration::from_millis(100);
/// A batch this large leaves at once.
pub const BATCH_NOW: usize = 256 * 1024;
/// Messages a window may have posted and not yet released (gated transports) once they hold SMALL_IN_FLIGHT_BYTES.
pub const MAX_IN_FLIGHT: u64 = 2;
/// The same for small messages: a busy grid sends many of them and each page release is an IPC call, so the page releases
/// them lazily, in one call (see the module text).
pub const MAX_IN_FLIGHT_SMALL: u64 = 8;
/// Below this many unreleased bytes the messages count as small.
pub const SMALL_IN_FLIGHT_BYTES: usize = 64 * 1024;
/// A keystroke's echo may use one more: it does not wait for a release of the bulk output before it (the page still
/// handles the messages in order, but the release round trip is saved).
pub const ECHO_SLOT: u64 = 1;
/// A reached cap without any release for this long is lifted (the page lost a message or its acks).
pub const CAP_TIMEOUT: Duration = Duration::from_secs(3);

/// How soon a frame has to leave.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Urgency {
    /// A keystroke's echo: at once, with the extra in-flight slot.
    Echo,
    /// Exit, replay, control messages.
    Now,
    /// Output of the focused terminal.
    Focus,
    Bulk,
}

/// Host -> page side of one window.
pub trait Transport: Send + Sync {
    /// Posts message number `seq` (from 1 per attach); blocks until the transport took it. False when the window is gone
    /// (the message is lost).
    fn post(&self, seq: u64, bytes: Vec<u8>) -> bool;
    /// The page answers every message with a release ack (`{t:'released', upto}`): the in-flight cap applies.
    fn gated(&self) -> bool;
    /// [`Transport::post`] with a hint for a gated transport: `release_now` tells the page that the host is at its cap, so
    /// the release of this message must not wait (without it the page may delay the release; ignored where it cannot be
    /// carried, those pages release at once).
    fn post_hinted(&self, seq: u64, bytes: Vec<u8>, release_now: bool) -> bool {
        let _ = release_now;
        self.post(seq, bytes)
    }
    /// "sharedBuffer", "channel", "pull" (stats, logs).
    fn name(&self) -> &'static str;
    /// The batcher stops (the window reloaded or closed): wake a blocked post.
    fn close(&self) {}
}

#[derive(Default)]
struct Pending {
    buf: Vec<u8>,
    frames: u64,
    deadline: Option<Instant>,
    posted: u64,
    released: u64,
    /// The last post or release (the start of a CAP_TIMEOUT wait).
    progress: Option<Instant>,
    /// An echo is queued: the batch may use the echo slot.
    echo: bool,
    stop: bool,
    /// (number, bytes) of each message posted and not yet released.
    unreleased: VecDeque<(u64, usize)>,
    unreleased_bytes: usize,
}

impl Pending {
    /// Whether another post has to wait for a release (`extra`: the echo slot).
    fn capped(&self, extra: u64) -> bool {
        let n = self.posted - self.released;
        n >= MAX_IN_FLIGHT_SMALL + extra || (n >= MAX_IN_FLIGHT + extra && self.unreleased_bytes >= SMALL_IN_FLIGHT_BYTES)
    }

    /// Everything up to number `upto` is released.
    fn release_to(&mut self, upto: u64) {
        self.released = self.released.max(upto);
        while let Some(&(seq, bytes)) = self.unreleased.front() {
            if seq > self.released {
                break;
            }
            self.unreleased_bytes -= bytes;
            self.unreleased.pop_front();
        }
    }
}

#[derive(Default)]
pub struct BatchStats {
    pub posts: AtomicU64,
    pub frames: AtomicU64,
    pub bytes: AtomicU64,
    pub lost: AtomicU64,
    /// Highest number of messages posted and not released seen when a message was posted.
    pub max_in_flight: AtomicU64,
    /// Posts that waited for the in-flight cap.
    pub gated_waits: AtomicU64,
    /// Caps lifted after CAP_TIMEOUT without a release.
    pub cap_timeouts: AtomicU64,
}

struct Inner {
    pending: Mutex<Pending>,
    cv: Condvar,
    transport: Arc<dyn Transport>,
    stats: BatchStats,
    last_send: Mutex<Instant>,
    dead: AtomicBool,
    /// The window is minimized or hidden (see [`HIDDEN_WINDOW`]).
    hidden: AtomicBool,
}

/// One window's batcher and its sender thread (ends when the batcher is dropped or stopped).
pub struct WindowBatcher {
    inner: Arc<Inner>,
}

impl WindowBatcher {
    pub fn new(label: &str, transport: Arc<dyn Transport>) -> Self {
        let inner = Arc::new(Inner {
            pending: Mutex::new(Pending::default()),
            cv: Condvar::new(),
            transport,
            stats: BatchStats::default(),
            last_send: Mutex::new(Instant::now() - BULK_WINDOW),
            dead: AtomicBool::new(false),
            hidden: AtomicBool::new(false),
        });
        let worker = inner.clone();
        let _ = std::thread::Builder::new().name(format!("pty-send-{label}")).spawn(move || send_loop(&worker));
        Self { inner }
    }

    pub fn transport_name(&self) -> &'static str {
        self.inner.transport.name()
    }

    /// The window is minimized or hidden (true) or shown again (false): see [`HIDDEN_WINDOW`]. Shown again, what waits for
    /// the longer window leaves at once.
    pub fn set_hidden(&self, hidden: bool) {
        if self.inner.hidden.swap(hidden, Ordering::SeqCst) && !hidden {
            self.flush_soon();
        }
    }

    /// Queues one frame.
    pub fn push(&self, kind: u8, id: &str, payload: &[u8], urgency: Urgency) {
        let now = Instant::now();
        let last = *self.inner.last_send.lock();
        let mut p = self.inner.pending.lock();
        if p.stop {
            return;
        }
        frame::encode(&mut p.buf, kind, id, payload);
        p.frames += 1;
        p.echo |= urgency == Urgency::Echo;
        let due = match urgency {
            Urgency::Now | Urgency::Echo => now,
            Urgency::Focus | Urgency::Bulk if self.inner.hidden.load(Ordering::Relaxed) => (last + HIDDEN_WINDOW).max(now),
            Urgency::Focus => (last + FOCUS_WINDOW).max(now),
            Urgency::Bulk => (last + BULK_WINDOW).max(now),
        };
        let due = if p.buf.len() >= BATCH_NOW { now } else { due };
        p.deadline = Some(p.deadline.map_or(due, |d| d.min(due)));
        drop(p);
        self.inner.cv.notify_one();
    }

    /// What is queued leaves as soon as the transport allows (a terminal moved to another window).
    pub fn flush_soon(&self) {
        let mut p = self.inner.pending.lock();
        if !p.buf.is_empty() {
            p.deadline = Some(Instant::now());
        }
        drop(p);
        self.inner.cv.notify_one();
    }

    /// The page handled every message up to number `upto` (counted from 1 per attach).
    pub fn released(&self, upto: u64) {
        let mut p = self.inner.pending.lock();
        if upto > p.released && upto <= p.posted {
            p.release_to(upto);
            p.progress = Some(Instant::now());
        }
        drop(p);
        self.inner.cv.notify_one();
    }

    /// Forgets what is queued and stops the sender (a new renderer gets the replay tails, which already hold it).
    pub fn stop(&self) {
        let mut p = self.inner.pending.lock();
        p.stop = true;
        p.buf.clear();
        drop(p);
        self.inner.cv.notify_all();
        self.inner.transport.close();
    }

    /// The transport refused a message (the window is gone).
    pub fn is_dead(&self) -> bool {
        self.inner.dead.load(Ordering::SeqCst)
    }

    pub fn in_flight(&self) -> u64 {
        let p = self.inner.pending.lock();
        p.posted - p.released
    }

    pub fn stats_json(&self) -> Value {
        let s = &self.inner.stats;
        let p = self.inner.pending.lock();
        json!({
            "transport": self.inner.transport.name(),
            "posts": s.posts.load(Ordering::Relaxed),
            "frames": s.frames.load(Ordering::Relaxed),
            "bytes": s.bytes.load(Ordering::Relaxed),
            "lost": s.lost.load(Ordering::Relaxed),
            "maxInFlight": s.max_in_flight.load(Ordering::Relaxed),
            "gatedWaits": s.gated_waits.load(Ordering::Relaxed),
            "capTimeouts": s.cap_timeouts.load(Ordering::Relaxed),
            "inFlight": p.posted - p.released,
            "queued": p.buf.len(),
        })
    }
}

impl Drop for WindowBatcher {
    fn drop(&mut self) {
        self.stop();
    }
}

fn send_loop(inner: &Inner) {
    let gated = inner.transport.gated();
    loop {
        let (bytes, frames, seq, in_flight, release_now) = {
            let mut p = inner.pending.lock();
            let mut waited = false;
            loop {
                if p.stop {
                    return;
                }
                let now = Instant::now();
                let ready = p.deadline.is_some_and(|d| d <= now) && !p.buf.is_empty();
                let capped = gated && p.capped(if p.echo { ECHO_SLOT } else { 0 });
                if ready && !capped {
                    break;
                }
                let lift = p.progress.map(|t| t + CAP_TIMEOUT);
                if ready && capped {
                    if lift.is_some_and(|t| t <= now) {
                        // Nothing was released for CAP_TIMEOUT: a release was lost; the page is not held for ever.
                        let upto = p.posted;
                        p.release_to(upto);
                        inner.stats.cap_timeouts.fetch_add(1, Ordering::Relaxed);
                        continue;
                    }
                    if !waited {
                        waited = true;
                        inner.stats.gated_waits.fetch_add(1, Ordering::Relaxed);
                    }
                }
                match (p.deadline, lift) {
                    (Some(d), _) if !capped && d > now => {
                        let _ = inner.cv.wait_until(&mut p, d);
                    }
                    (Some(_), Some(t)) if capped => {
                        let _ = inner.cv.wait_until(&mut p, t);
                    }
                    _ => inner.cv.wait(&mut p),
                }
            }
            let bytes = std::mem::take(&mut p.buf);
            let frames = std::mem::take(&mut p.frames);
            p.deadline = None;
            p.echo = false;
            p.posted += 1;
            p.progress = Some(Instant::now());
            let seq = p.posted;
            p.unreleased.push_back((seq, bytes.len()));
            p.unreleased_bytes += bytes.len();
            let release_now = gated && p.capped(0);
            (bytes, frames, seq, p.posted - p.released, release_now)
        };
        *inner.last_send.lock() = Instant::now();
        let s = &inner.stats;
        s.posts.fetch_add(1, Ordering::Relaxed);
        s.frames.fetch_add(frames, Ordering::Relaxed);
        s.bytes.fetch_add(bytes.len() as u64, Ordering::Relaxed);
        s.max_in_flight.fetch_max(in_flight, Ordering::Relaxed);
        if !inner.transport.post_hinted(seq, bytes, release_now) {
            s.lost.fetch_add(1, Ordering::Relaxed);
            inner.dead.store(true, Ordering::SeqCst);
            // A page that never got it never releases it: released at its own number (the page releases by number, so a
            // later release covers what came before).
            let mut p = inner.pending.lock();
            p.release_to(seq);
            drop(p);
            inner.cv.notify_one();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frame::{KIND_DATA, KIND_EXIT, decode};
    use std::sync::mpsc;

    struct Recorder {
        tx: Mutex<mpsc::Sender<(Instant, Vec<u8>)>>,
        gated: bool,
    }
    impl Transport for Recorder {
        fn post(&self, _seq: u64, bytes: Vec<u8>) -> bool {
            self.tx.lock().send((Instant::now(), bytes)).is_ok()
        }
        fn gated(&self) -> bool {
            self.gated
        }
        fn name(&self) -> &'static str {
            "test"
        }
    }

    fn batcher(gated: bool) -> (WindowBatcher, mpsc::Receiver<(Instant, Vec<u8>)>) {
        let (tx, rx) = mpsc::channel();
        (WindowBatcher::new("t", Arc::new(Recorder { tx: Mutex::new(tx), gated })), rx)
    }

    fn ids(bytes: &[u8]) -> Vec<String> {
        decode(bytes).unwrap().iter().map(|f| format!("{}:{}", f.id, String::from_utf8_lossy(f.payload))).collect()
    }

    #[test]
    fn bulk_after_a_quiet_window_leaves_at_once_then_waits_for_the_window() {
        let (b, rx) = batcher(false);
        let t0 = Instant::now();
        b.push(KIND_DATA, "a", b"1", Urgency::Bulk);
        let (at, m) = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(ids(&m), vec!["a:1"]);
        // Leading edge (no 16 ms wait; generous for a loaded machine).
        assert!(at - t0 < Duration::from_millis(100), "{:?}", at - t0);
        b.push(KIND_DATA, "a", b"2", Urgency::Bulk);
        b.push(KIND_DATA, "b", b"3", Urgency::Bulk);
        let (at2, m) = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(ids(&m), vec!["a:2", "b:3"]);
        assert!(at2 - at >= Duration::from_millis(14), "{:?}", at2 - at);
    }

    #[test]
    fn an_echo_takes_everything_queued_before_it_at_once() {
        let (b, rx) = batcher(false);
        b.push(KIND_DATA, "x", b"0", Urgency::Bulk);
        let (at, _) = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        b.push(KIND_DATA, "agent", b"stream", Urgency::Bulk);
        b.push(KIND_DATA, "ssh", b"e", Urgency::Now);
        let (at2, m) = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(ids(&m), vec!["agent:stream", "ssh:e"]);
        // Not on its own 16 ms window: it left with the echo (timing is not asserted, the machine may be loaded).
        let _ = (at, at2);
    }

    #[test]
    fn exit_frames_keep_their_place_behind_the_output() {
        let (b, rx) = batcher(false);
        b.push(KIND_DATA, "a", b"out", Urgency::Bulk);
        b.push(KIND_EXIT, "a", &3i32.to_le_bytes(), Urgency::Now);
        // Until the exit arrived (not "until a quiet gap": a loaded machine can pause the sender longer than any gap).
        let mut all = Vec::new();
        while !all.contains(&KIND_EXIT) {
            let (_, m) = rx.recv_timeout(Duration::from_secs(5)).expect("the exit frame");
            all.extend(decode(&m).unwrap().into_iter().map(|f| f.kind).collect::<Vec<_>>());
        }
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
        assert_eq!(all, vec![KIND_DATA, KIND_EXIT]);
    }

    /// Posts `n` messages one by one (each waited for, so no thread scheduling decides how they are batched).
    fn fill(b: &WindowBatcher, rx: &mpsc::Receiver<(Instant, Vec<u8>)>, n: u64, payload: &[u8]) -> Vec<(Instant, Vec<u8>)> {
        let mut out = Vec::new();
        for _ in 0..n {
            b.push(KIND_DATA, "a", payload, Urgency::Now);
            out.push(rx.recv_timeout(Duration::from_secs(5)).unwrap());
        }
        out
    }

    #[test]
    fn a_gated_transport_has_few_unreleased_messages_and_batches_grow() {
        let (b, rx) = batcher(true);
        let first = fill(&b, &rx, MAX_IN_FLIGHT_SMALL, b"0;");
        for _ in MAX_IN_FLIGHT_SMALL..200 {
            b.push(KIND_DATA, "a", b"0;", Urgency::Now);
        }
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err(), "posted beyond the cap");
        assert_eq!(b.in_flight(), MAX_IN_FLIGHT_SMALL);
        b.released(MAX_IN_FLIGHT_SMALL);
        let (_, rest) = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        // Everything that waited leaves as one message, in order.
        let n: usize = first.iter().map(|(_, m)| decode(m).unwrap().len()).sum::<usize>() + decode(&rest).unwrap().len();
        assert_eq!(n, 200);
        let st = b.stats_json();
        assert!(st["maxInFlight"].as_u64().unwrap() <= MAX_IN_FLIGHT_SMALL);
        assert!(st["gatedWaits"].as_u64().unwrap() >= 1);
    }

    #[test]
    fn big_messages_are_capped_at_two() {
        let (b, rx) = batcher(true);
        fill(&b, &rx, MAX_IN_FLIGHT, &vec![b'x'; SMALL_IN_FLIGHT_BYTES]);
        b.push(KIND_DATA, "a", b"held", Urgency::Now);
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err(), "posted beyond the big-message cap");
        assert_eq!(b.in_flight(), MAX_IN_FLIGHT);
        b.released(1);
        assert_eq!(ids(&rx.recv_timeout(Duration::from_secs(2)).unwrap().1), vec!["a:held"]);
    }

    #[test]
    fn an_echo_uses_one_more_slot_but_no_more() {
        let (b, rx) = batcher(true);
        fill(&b, &rx, MAX_IN_FLIGHT_SMALL, b"0");
        b.push(KIND_DATA, "a", b"3", Urgency::Now);
        std::thread::sleep(Duration::from_millis(30));
        assert!(rx.try_recv().is_err());
        assert_eq!(b.in_flight(), MAX_IN_FLIGHT_SMALL);
        b.push(KIND_DATA, "e", b"x", Urgency::Echo);
        let (_, m) = rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(ids(&m), vec!["a:3", "e:x"]);
        assert_eq!(b.in_flight(), MAX_IN_FLIGHT_SMALL + ECHO_SLOT);
        b.push(KIND_DATA, "e", b"y", Urgency::Echo);
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
        b.released(1);
        assert_eq!(ids(&rx.recv_timeout(Duration::from_secs(2)).unwrap().1), vec!["e:y"]);
    }

    /// Transport that records the hints.
    struct Hinted(Mutex<mpsc::Sender<(u64, bool)>>);
    impl Transport for Hinted {
        fn post(&self, _seq: u64, _bytes: Vec<u8>) -> bool {
            unreachable!("the batcher posts with the hint")
        }
        fn post_hinted(&self, seq: u64, _bytes: Vec<u8>, release_now: bool) -> bool {
            self.0.lock().send((seq, release_now)).is_ok()
        }
        fn gated(&self) -> bool {
            true
        }
        fn name(&self) -> &'static str {
            "test"
        }
    }

    #[test]
    fn the_page_is_asked_to_release_at_once_when_the_host_reaches_its_cap() {
        let (tx, rx) = mpsc::channel();
        let b = WindowBatcher::new("t", Arc::new(Hinted(Mutex::new(tx))));
        for i in 1..=MAX_IN_FLIGHT_SMALL {
            b.push(KIND_DATA, "a", b"0", Urgency::Now);
            let (seq, hint) = rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(seq, i);
            // A release can go lazily until this post fills the last slot.
            assert_eq!(hint, i == MAX_IN_FLIGHT_SMALL, "message {i}");
        }
        b.released(MAX_IN_FLIGHT_SMALL);
        b.push(KIND_DATA, "a", &vec![b'x'; SMALL_IN_FLIGHT_BYTES], Urgency::Now);
        assert_eq!(
            rx.recv_timeout(Duration::from_secs(5)).unwrap(),
            (MAX_IN_FLIGHT_SMALL + 1, false),
            "one big message is below the cap of 2"
        );
        b.push(KIND_DATA, "a", b"0", Urgency::Now);
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap(), (MAX_IN_FLIGHT_SMALL + 2, true), "the cap of big messages");
    }

    #[test]
    fn a_release_beyond_what_was_posted_is_ignored() {
        let (b, rx) = batcher(true);
        b.released(5);
        b.push(KIND_DATA, "a", b"1", Urgency::Now);
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert_eq!(b.in_flight(), 1);
    }

    #[test]
    fn a_cap_without_any_release_is_lifted_after_the_timeout() {
        let (b, rx) = batcher(true);
        fill(&b, &rx, MAX_IN_FLIGHT_SMALL, b"0");
        let capped_at = Instant::now();
        b.push(KIND_DATA, "a", b"held", Urgency::Now);
        assert!(rx.recv_timeout(Duration::from_millis(300)).is_err());
        // The page lost a release (or its acks): the window is not frozen for good.
        let (at, m) = rx.recv_timeout(CAP_TIMEOUT + Duration::from_secs(5)).unwrap();
        assert_eq!(ids(&m), vec!["a:held"]);
        assert!(at - capped_at >= CAP_TIMEOUT - Duration::from_millis(50), "{:?}", at - capped_at);
        assert_eq!(b.stats_json()["capTimeouts"], 1);
        assert_eq!(b.in_flight(), 1);
    }

    struct Refusing;
    impl Transport for Refusing {
        fn post(&self, _seq: u64, _bytes: Vec<u8>) -> bool {
            false
        }
        fn gated(&self) -> bool {
            true
        }
        fn name(&self) -> &'static str {
            "test"
        }
    }

    #[test]
    fn a_lost_post_does_not_take_an_in_flight_slot() {
        let b = WindowBatcher::new("t", Arc::new(Refusing));
        for i in 0..5 {
            b.push(KIND_DATA, "a", i.to_string().as_bytes(), Urgency::Now);
            let deadline = Instant::now() + Duration::from_secs(5);
            while (b.stats_json()["lost"].as_u64() != Some(i + 1) || b.in_flight() != 0) && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(2));
            }
            assert_eq!(b.stats_json()["lost"], i + 1);
            assert_eq!(b.in_flight(), 0);
        }
        assert_eq!(b.stats_json()["capTimeouts"], 0);
    }

    #[test]
    fn stop_drops_what_is_queued() {
        let (b, rx) = batcher(false);
        b.push(KIND_DATA, "a", b"1", Urgency::Now);
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        b.push(KIND_DATA, "a", b"2", Urgency::Bulk);
        b.stop();
        assert!(rx.recv_timeout(Duration::from_millis(100)).is_err());
    }

    #[test]
    fn a_large_batch_leaves_without_waiting_for_the_window() {
        // A capped gated batcher keeps what is queued, so its deadline can be read.
        let (b, rx) = batcher(true);
        fill(&b, &rx, MAX_IN_FLIGHT_SMALL, b"0");
        let before = Instant::now();
        b.push(KIND_DATA, "a", b"small", Urgency::Bulk);
        assert!(b.inner.pending.lock().deadline.unwrap() >= before + BULK_WINDOW - Duration::from_millis(1));
        b.push(KIND_DATA, "a", &vec![b'x'; BATCH_NOW], Urgency::Bulk);
        assert!(b.inner.pending.lock().deadline.unwrap() <= Instant::now());
    }

    #[test]
    fn a_hidden_window_sends_output_less_often_but_echoes_at_once() {
        // Capped, so the deadlines can be read.
        let (b, rx) = batcher(true);
        fill(&b, &rx, MAX_IN_FLIGHT_SMALL, b"0");
        b.set_hidden(true);
        let before = Instant::now();
        b.push(KIND_DATA, "a", b"trickle", Urgency::Bulk);
        assert!(b.inner.pending.lock().deadline.unwrap() >= before + HIDDEN_WINDOW - Duration::from_millis(1));
        b.push(KIND_DATA, "a", b"focused", Urgency::Focus);
        assert!(b.inner.pending.lock().deadline.unwrap() >= before + HIDDEN_WINDOW - Duration::from_millis(1));
        // Shown again: what waits leaves at once.
        b.set_hidden(false);
        assert!(b.inner.pending.lock().deadline.unwrap() <= Instant::now());
        b.set_hidden(true);
        b.push(KIND_DATA, "a", b"echo", Urgency::Echo);
        assert!(b.inner.pending.lock().deadline.unwrap() <= Instant::now());
    }
}
