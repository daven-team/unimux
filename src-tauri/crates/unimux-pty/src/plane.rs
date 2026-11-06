//! Spike SP5 data plane: terminals in ConPTY, their output as binary frames ([`crate::frame`]) to ONE sink per window (a
//! Tauri Channel in the app), batched with a leading-edge window, and byte acks driving a pause gate per terminal. P2 grows
//! this into the OutputChannel / FlowGate / TailBuffer engine; the spike keeps only what the measurements need.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use serde_json::{Value, json};

use crate::conpty::{ConptyApi, PauseHandle, Pty, SpawnOptions, TimerResolution};
use crate::frame::{self, KIND_DATA, KIND_EXIT};

/// Pause a terminal's reader above this many unacknowledged bytes, resume below `FLOW_LOW` (P2: FlowGate 1 MiB / 256 KiB).
pub const FLOW_HIGH: usize = 1024 * 1024;
pub const FLOW_LOW: usize = 256 * 1024;
/// A batch is sent at once when it grows past this.
const BATCH_MAX: usize = 256 * 1024;

/// Host -> renderer: one Channel message (one or more frames). False when the window is gone.
pub type Sink = Arc<dyn Fn(Vec<u8>) -> bool + Send + Sync>;

#[derive(Debug, Clone)]
pub struct PlaneConfig {
    /// Batch window of the window's channel; 0: every read goes out as its own message (no batching).
    pub batch_ms: u64,
    /// Shorter window while the focused terminal has output (its echo), like 1.1.4's 4 ms window for the focused cell.
    pub focus_ms: u64,
    /// Hold timeBeginPeriod(1) while terminals run.
    pub timer_1ms: bool,
    /// Byte-ack flow control.
    pub flow: bool,
}

impl Default for PlaneConfig {
    fn default() -> Self {
        Self { batch_ms: 16, focus_ms: 4, timer_1ms: true, flow: true }
    }
}

#[derive(Default)]
struct Pending {
    /// Frames of the other terminals (the long window).
    buf: Vec<u8>,
    /// Frames of the focused terminal: their own message on the short window, never behind the bulk.
    focus_buf: Vec<u8>,
    /// The focus moved: everything pending leaves at once, before any frame of the new focus.
    flush_bulk: bool,
    stop: bool,
}

struct Batcher {
    pending: Mutex<Pending>,
    cv: Condvar,
    focused: Mutex<Option<String>>,
}

#[derive(Default)]
pub struct Stats {
    pub messages: AtomicU64,
    pub frames: AtomicU64,
    pub bytes: AtomicU64,
    pub pauses: AtomicU64,
}

struct Flow {
    unacked: AtomicUsize,
    paused: AtomicBool,
    pauser: OnceLock<PauseHandle>,
}

impl Flow {
    fn add(&self, n: usize, stats: &Stats) {
        let total = self.unacked.fetch_add(n, Ordering::SeqCst) + n;
        if total > FLOW_HIGH && !self.paused.swap(true, Ordering::SeqCst) {
            stats.pauses.fetch_add(1, Ordering::Relaxed);
            if let Some(p) = self.pauser.get() {
                p.set_paused(true);
            }
        }
    }
    fn ack(&self, n: usize) {
        let mut prev = self.unacked.load(Ordering::SeqCst);
        while let Err(now) = self.unacked.compare_exchange(prev, prev.saturating_sub(n), Ordering::SeqCst, Ordering::SeqCst) {
            prev = now;
        }
        if prev.saturating_sub(n) < FLOW_LOW
            && self.paused.swap(false, Ordering::SeqCst)
            && let Some(p) = self.pauser.get()
        {
            p.set_paused(false);
        }
    }
}

struct Term {
    pty: Pty,
    flow: Arc<Flow>,
    generation: u64,
}

static GENERATION: AtomicU64 = AtomicU64::new(1);

/// A synthetic stream: its flow counter and its stop switch.
type Synthetic = (Arc<Flow>, Arc<AtomicBool>);

pub struct Plane {
    api: &'static ConptyApi,
    config: PlaneConfig,
    sink: Arc<Mutex<Option<Sink>>>,
    batcher: Arc<Batcher>,
    terms: Mutex<HashMap<String, Term>>,
    /// Synthetic output streams (no pty): the data plane and the renderer alone at a given rate.
    synthetic: Mutex<HashMap<String, Synthetic>>,
    timer: Mutex<Option<TimerResolution>>,
    pub stats: Arc<Stats>,
}

fn send(sink: &Mutex<Option<Sink>>, stats: &Stats, buf: Vec<u8>) {
    let Some(sink) = sink.lock().clone() else { return };
    stats.messages.fetch_add(1, Ordering::Relaxed);
    sink(buf);
}

impl Plane {
    pub fn new(api: &'static ConptyApi, config: PlaneConfig) -> Arc<Self> {
        let plane = Arc::new(Self {
            api,
            config,
            sink: Arc::new(Mutex::new(None)),
            batcher: Arc::new(Batcher { pending: Mutex::new(Pending::default()), cv: Condvar::new(), focused: Mutex::new(None) }),
            terms: Mutex::new(HashMap::new()),
            synthetic: Mutex::new(HashMap::new()),
            timer: Mutex::new(None),
            stats: Arc::new(Stats::default()),
        });
        if plane.config.batch_ms > 0 {
            let (batcher, sink, stats, window, focus_window) = (
                plane.batcher.clone(),
                plane.sink.clone(),
                plane.stats.clone(),
                Duration::from_millis(plane.config.batch_ms),
                Duration::from_millis(plane.config.focus_ms.min(plane.config.batch_ms)),
            );
            let _ = std::thread::Builder::new().name("pty-batch".into()).spawn(move || {
                // Leading edge: output after a quiet window goes out at once (a keystroke's echo); output while a window
                // is open waits for its end and leaves together with everything else that arrived meanwhile.
                let (mut last_bulk, mut last_focus) = (Instant::now() - window, Instant::now() - focus_window);
                loop {
                    let mut p = batcher.pending.lock();
                    let (bulk_due, focus_due) = loop {
                        if p.stop {
                            return;
                        }
                        let now = Instant::now();
                        let bulk_at = last_bulk + window;
                        let focus_at = last_focus + focus_window;
                        let bulk_due = !p.buf.is_empty() && (now >= bulk_at || p.buf.len() >= BATCH_MAX || p.flush_bulk);
                        let focus_due = !p.focus_buf.is_empty() && now >= focus_at;
                        if bulk_due || focus_due {
                            break (bulk_due, focus_due);
                        }
                        let next = match (p.buf.is_empty(), p.focus_buf.is_empty()) {
                            (true, true) => None,
                            (false, true) => Some(bulk_at),
                            (true, false) => Some(focus_at),
                            (false, false) => Some(bulk_at.min(focus_at)),
                        };
                        match next {
                            Some(at) => {
                                let _ = batcher.cv.wait_until(&mut p, at);
                            }
                            None => batcher.cv.wait(&mut p),
                        }
                    };
                    let bulk = if bulk_due { std::mem::take(&mut p.buf) } else { Vec::new() };
                    let focus = if focus_due { std::mem::take(&mut p.focus_buf) } else { Vec::new() };
                    p.flush_bulk = false;
                    drop(p);
                    if !bulk.is_empty() {
                        last_bulk = Instant::now();
                        send(&sink, &stats, bulk);
                    }
                    if !focus.is_empty() {
                        last_focus = Instant::now();
                        send(&sink, &stats, focus);
                    }
                }
            });
        }
        plane
    }

    pub fn source(&self) -> String {
        format!("{:?}", self.api.source)
    }

    /// The window's channel (a reload replaces it).
    pub fn attach(&self, sink: Sink) {
        *self.sink.lock() = Some(sink);
    }

    fn push(&self, id: &str, kind: u8, payload: &[u8]) {
        Self::push_to(&self.batcher, &self.sink, &self.stats, self.config.batch_ms, id, kind, payload);
    }

    fn push_to(batcher: &Batcher, sink: &Mutex<Option<Sink>>, stats: &Stats, batch_ms: u64, id: &str, kind: u8, payload: &[u8]) {
        stats.frames.fetch_add(1, Ordering::Relaxed);
        stats.bytes.fetch_add(payload.len() as u64, Ordering::Relaxed);
        if batch_ms == 0 {
            let mut buf = Vec::with_capacity(payload.len() + id.len() + 7);
            frame::encode(&mut buf, kind, id, payload);
            send(sink, stats, buf);
            return;
        }
        let focused = batcher.focused.lock();
        let mut p = batcher.pending.lock();
        if focused.as_deref() == Some(id) {
            frame::encode(&mut p.focus_buf, kind, id, payload);
        } else {
            frame::encode(&mut p.buf, kind, id, payload);
        }
        drop(p);
        drop(focused);
        batcher.cv.notify_one();
    }

    pub fn spawn(self: &Arc<Self>, id: &str, opts: &SpawnOptions) -> std::io::Result<u32> {
        self.kill(id);
        let flow = Arc::new(Flow { unacked: AtomicUsize::new(0), paused: AtomicBool::new(false), pauser: OnceLock::new() });
        let (batcher, sink, stats, batch_ms) =
            (self.batcher.clone(), self.sink.clone(), self.stats.clone(), self.config.batch_ms);
        let (data_id, data_flow, use_flow) = (id.to_string(), flow.clone(), self.config.flow);
        let on_data = Box::new(move |bytes: &[u8]| {
            if use_flow {
                data_flow.add(bytes.len(), &stats);
            }
            Self::push_to(&batcher, &sink, &stats, batch_ms, &data_id, KIND_DATA, bytes);
        });
        let me = Arc::downgrade(self);
        let exit_id = id.to_string();
        let generation = GENERATION.fetch_add(1, Ordering::Relaxed);
        let on_exit = Box::new(move |code: u32| {
            if let Some(plane) = me.upgrade() {
                plane.push(&exit_id, KIND_EXIT, &(code as i32).to_le_bytes());
                plane.forget(&exit_id, generation);
            }
        });
        let pty = Pty::spawn(self.api, opts, on_data, on_exit)?;
        let _ = flow.pauser.set(pty.pause_handle());
        let pid = pty.pid();
        let mut terms = self.terms.lock();
        terms.insert(id.to_string(), Term { pty, flow, generation });
        if self.config.timer_1ms {
            let mut timer = self.timer.lock();
            if timer.is_none() {
                *timer = Some(TimerResolution::acquire());
            }
        }
        Ok(pid)
    }

    fn forget(&self, id: &str, generation: u64) {
        let mut terms = self.terms.lock();
        if terms.get(id).is_some_and(|t| t.generation == generation) {
            terms.remove(id);
        }
        if terms.is_empty() {
            self.timer.lock().take();
        }
    }

    /// The terminal with the keyboard focus (its output uses the short window).
    pub fn focus(&self, id: Option<&str>) {
        let mut focused = self.batcher.focused.lock();
        if focused.as_deref() == id {
            return;
        }
        // Frames queued under the old focus keep their order: they all leave (as bulk) before the new focus's next one.
        let mut p = self.batcher.pending.lock();
        let old = std::mem::take(&mut p.focus_buf);
        p.buf.extend_from_slice(&old);
        p.flush_bulk = !p.buf.is_empty();
        *focused = id.map(str::to_string);
        drop(p);
        drop(focused);
        self.batcher.cv.notify_one();
    }

    pub fn write(&self, id: &str, data: &[u8]) {
        if let Some(t) = self.terms.lock().get(id) {
            t.pty.write(data);
        }
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if let Some(t) = self.terms.lock().get(id) {
            let _ = t.pty.resize(cols, rows);
        }
    }

    pub fn ack(&self, id: &str, bytes: usize) {
        if let Some(t) = self.terms.lock().get(id) {
            t.flow.ack(bytes);
        }
        if let Some((flow, _)) = self.synthetic.lock().get(id) {
            flow.ack(bytes);
        }
    }

    /// Colored lines at `rate` bytes/s for `seconds` (0 = until killed) straight into the plane, without ConPTY (which
    /// repaints its viewport and drops lines that scroll past between two of its frames). Held back while more than
    /// FLOW_HIGH bytes are unacknowledged, like a paused pty.
    pub fn synthetic(self: &Arc<Self>, id: &str, rate: u64, seconds: u64) {
        let flow = Arc::new(Flow { unacked: AtomicUsize::new(0), paused: AtomicBool::new(false), pauser: OnceLock::new() });
        let stop = Arc::new(AtomicBool::new(false));
        if let Some((_, old)) = self.synthetic.lock().insert(id.to_string(), (flow.clone(), stop.clone())) {
            old.store(true, Ordering::SeqCst);
        }
        let me = Arc::downgrade(self);
        let id = id.to_string();
        let _ = std::thread::Builder::new().name("pty-synthetic".into()).spawn(move || {
            let colors = [31, 32, 33, 34, 35, 36, 90];
            let started = Instant::now();
            let (mut sent, mut n) = (0u64, 0u64);
            let mut chunk = Vec::new();
            while !stop.load(Ordering::SeqCst) && (seconds == 0 || started.elapsed() < Duration::from_secs(seconds)) {
                let Some(plane) = me.upgrade() else { return };
                if flow.unacked.load(Ordering::SeqCst) > FLOW_HIGH {
                    if !flow.paused.swap(true, Ordering::SeqCst) {
                        plane.stats.pauses.fetch_add(1, Ordering::Relaxed);
                    }
                } else {
                    flow.paused.store(false, Ordering::SeqCst);
                    let target = (rate as f64 * started.elapsed().as_secs_f64()) as u64;
                    chunk.clear();
                    while sent + (chunk.len() as u64) < target {
                        use std::io::Write;
                        let _ = write!(
                            chunk,
                            "\x1b[{}m{:>8}\x1b[0m lorem ipsum dolor sit amet, consectetur \x1b[1madipiscing\x1b[22m elit sed do eiusmod\r\n",
                            colors[(n % colors.len() as u64) as usize],
                            n
                        );
                        n += 1;
                    }
                    if !chunk.is_empty() {
                        sent += chunk.len() as u64;
                        flow.unacked.fetch_add(chunk.len(), Ordering::SeqCst);
                        plane.push(&id, KIND_DATA, &chunk);
                    }
                }
                drop(plane);
                std::thread::sleep(Duration::from_millis(10));
            }
            if let Some(plane) = me.upgrade() {
                plane.push(&id, KIND_EXIT, &0i32.to_le_bytes());
                plane.synthetic.lock().remove(&id);
            }
        });
    }

    pub fn kill(&self, id: &str) {
        if let Some(t) = self.terms.lock().get(id) {
            t.pty.kill();
        }
    }

    pub fn kill_all(&self) {
        for t in self.terms.lock().values() {
            t.pty.kill();
        }
        for (_, stop) in self.synthetic.lock().values() {
            stop.store(true, Ordering::SeqCst);
        }
    }

    pub fn count(&self) -> usize {
        self.terms.lock().len()
    }

    pub fn stats_json(&self) -> Value {
        let s = &self.stats;
        json!({
            "messages": s.messages.load(Ordering::Relaxed),
            "frames": s.frames.load(Ordering::Relaxed),
            "bytes": s.bytes.load(Ordering::Relaxed),
            "pauses": s.pauses.load(Ordering::Relaxed),
            "terminals": self.count(),
            "source": self.source(),
            "batchMs": self.config.batch_ms,
            "focusMs": self.config.focus_ms,
            "timer1ms": self.config.timer_1ms,
        })
    }
}

impl Drop for Plane {
    fn drop(&mut self) {
        self.batcher.pending.lock().stop = true;
        self.batcher.cv.notify_all();
    }
}
