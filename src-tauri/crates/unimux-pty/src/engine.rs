//! The pty output engine (P2): what 1.1.4's Pty Host did between node-pty and the renderer windows (src/ptyhost/index.ts,
//! router.ts, routes.ts and the OutputChannel glue of manager.ts):
//!
//! - every terminal's output goes through its [`OutputChannel`] (coalescing, replay tail, FlowGate, exit drain) into the
//!   [`WindowBatcher`] of the window that shows it ([`WindowRoutes`]), as binary frames ([`crate::frame`]);
//! - renderer -> host messages of the pty port (`write`, `resize`, `ack`, `focus`, `released`) are accepted only for the
//!   terminals the sending window owns; sizes for terminals that do not exist yet go to the early-size LRU (200);
//! - a window that attaches (page load or reload) gets the replay tail of each of its terminals at the sizes it was
//!   written at; the main window's attach turns flow control on (and resets every gate), its detach turns it off;
//! - DA1: OpenConsole 1.23 holds a new terminal's output up to 3 s until the terminal answers its device-attributes query
//!   (`ESC [ c`); while no renderer window that could answer is attached, the engine answers like xterm.js (SP5);
//! - timeBeginPeriod(1) is held while terminals exist (Windows), so the coalescing timers and the batch windows fire on time.
//!
//! The pty service of P3 (spawn requests from the cells, kill routing, tap, crash handling) sits on top of this.

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};

use crate::batch::{Transport, Urgency, WindowBatcher};
use crate::frame::{self, KIND_DATA, KIND_EXIT, KIND_JSON, KIND_REPLAY, KIND_RESET};
use crate::manager::{KillWait, PtyHandle, PtyManager, PtySink, SpawnRequest};
use crate::output::{Focus, OutputChannel, OutputControl, OutputSink};
use crate::routes::{EarlySizes, MAIN_WINDOW, WindowRoutes};
use crate::timers::{Scheduler, ThreadScheduler};

/// xterm.js's answer to DA1.
pub const DA1_REPLY: &[u8] = b"\x1b[?1;2c";
/// Only the start of a terminal's output is searched for the DA1 query.
const DA1_SCAN: usize = 4096;

type ExitHook = Arc<dyn Fn(&str, i64) + Send + Sync>;
type TapHook = Arc<dyn Fn(&str, &[u8]) + Send + Sync>;

struct Term {
    out: Arc<OutputChannel>,
    /// The first output bytes, searched for the DA1 query (cleared once it was seen or the scan limit passed).
    da1: Mutex<Da1>,
    /// Sizes that came while PtyManager::spawn was still running (its slot may not exist yet): applied when it returned.
    spawning: Mutex<Spawning>,
    /// The output also goes to the tap hook (P3: the install window and the login terminals, `tap` of 1.1.4).
    tap: bool,
}

#[derive(Default)]
struct Spawning {
    done: bool,
    size: Option<(u16, u16)>,
}

#[derive(Default)]
struct Da1 {
    seen: Vec<u8>,
    done: bool,
}

struct Link {
    batcher: WindowBatcher,
}

#[derive(Default)]
struct Counters {
    da1_answers: AtomicU64,
    replays: AtomicU64,
}

struct Inner {
    me: Weak<Inner>,
    manager: PtyManager,
    pty: PtyHandle,
    sched: Arc<dyn Scheduler>,
    focus: Arc<Focus>,
    flow_on: Arc<AtomicBool>,
    terms: Mutex<HashMap<String, Arc<Term>>>,
    links: RwLock<HashMap<String, Arc<Link>>>,
    routes: Mutex<WindowRoutes>,
    early: Mutex<EarlySizes>,
    on_exit: RwLock<Option<ExitHook>>,
    on_tap: RwLock<Option<TapHook>>,
    #[cfg(windows)]
    timer: Mutex<Option<crate::conpty::TimerResolution>>,
    counters: Counters,
}

/// The engine; cheap to clone (one per app, shared by the pty port and the pty service).
#[derive(Clone)]
pub struct PtyEngine {
    inner: Arc<Inner>,
}

struct EngineSink(Weak<Inner>);

impl PtySink for EngineSink {
    fn data(&self, id: &str, data: &[u8]) {
        if let Some(inner) = self.0.upgrade() {
            inner.data(id, data);
        }
    }
    fn exit(&self, id: &str, code: i64) {
        if let Some(inner) = self.0.upgrade() {
            inner.exit(id, code);
        }
    }
}

impl OutputSink for EngineSink {
    fn data(&self, id: &str, data: Vec<u8>, echo: bool) -> bool {
        self.0.upgrade().is_some_and(|inner| inner.deliver(id, &data, echo))
    }
}

struct Pause {
    pty: PtyHandle,
    id: String,
}

impl OutputControl for Pause {
    fn pause(&self) {
        self.pty.set_paused(&self.id, true);
    }
    fn resume(&self) {
        self.pty.set_paused(&self.id, false);
    }
}

fn num(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn size_of(v: &Value, key: &str, min: u16) -> Option<u16> {
    num(v, key).map(|n| n.clamp(min as f64, u16::MAX as f64) as u16)
}

impl Inner {
    fn term(&self, id: &str) -> Option<Arc<Term>> {
        self.terms.lock().get(id).cloned()
    }

    fn link_of(&self, id: &str) -> Option<Arc<Link>> {
        let owner = self.routes.lock().owner_of(id).to_string();
        self.links.read().get(&owner).cloned()
    }

    /// A read of terminal `id` (on its reader thread).
    fn data(&self, id: &str, data: &[u8]) {
        let Some(term) = self.term(id) else { return };
        self.scan_da1(id, &term, data);
        if term.tap {
            let hook = self.on_tap.read().clone();
            if let Some(hook) = hook {
                hook(id, data);
            }
        }
        term.out.push(data);
    }

    fn scan_da1(&self, id: &str, term: &Term, data: &[u8]) {
        if !cfg!(windows) {
            return;
        }
        let asked = {
            let mut d = term.da1.lock();
            if d.done {
                return;
            }
            let room = DA1_SCAN.saturating_sub(d.seen.len());
            d.seen.extend_from_slice(&data[..data.len().min(room)]);
            let asked = d.seen.windows(3).any(|w| w == b"\x1b[c") || d.seen.windows(4).any(|w| w == b"\x1b[0c");
            if asked || d.seen.len() >= DA1_SCAN {
                d.done = true;
                d.seen = Vec::new();
            }
            asked
        };
        // A window that shows the terminal answers itself (xterm.js); nobody else would within OpenConsole's 3 s.
        if asked && self.link_of(id).is_none() {
            self.counters.da1_answers.fetch_add(1, Ordering::Relaxed);
            self.pty.write(id, DA1_REPLY);
        }
    }

    /// A flushed piece of output: into the batcher of the window that shows the terminal. False when none is attached.
    fn deliver(&self, id: &str, data: &[u8], echo: bool) -> bool {
        let Some(link) = self.link_of(id) else { return false };
        let urgency = if echo {
            Urgency::Echo
        } else if self.focus.is(id) {
            Urgency::Focus
        } else {
            Urgency::Bulk
        };
        link.batcher.push(KIND_DATA, id, data, urgency);
        true
    }

    fn exit(&self, id: &str, code: i64) {
        let Some(term) = self.term(id) else { return };
        let me = self.me.clone();
        let id = id.to_string();
        let out = term.out.clone();
        // A paused pty still holds unread output: it is drained before the exit is reported.
        out.drain(Box::new(move || {
            let Some(inner) = me.upgrade() else { return };
            let current = inner.terms.lock().get(&id).is_some_and(|t| Arc::ptr_eq(t, &term));
            if !current {
                return;
            }
            term.out.flush(false);
            term.out.dispose();
            inner.forget(&id, &term);
            if let Some(link) = inner.link_of(&id) {
                // Output of a terminal always arrives before its exit: same queue, queued after it.
                link.batcher.push(KIND_EXIT, &id, &(code as i32).to_le_bytes(), Urgency::Now);
            }
            let hook = inner.on_exit.read().clone();
            if let Some(hook) = hook {
                hook(&id, code);
            }
        }));
    }

    fn forget(&self, id: &str, term: &Arc<Term>) {
        let mut terms = self.terms.lock();
        if terms.get(id).is_some_and(|t| Arc::ptr_eq(t, term)) {
            terms.remove(id);
        }
        #[cfg(windows)]
        if terms.is_empty() {
            self.timer.lock().take();
        }
    }

    /// Queues the replay tail in the same critical section as its snapshot, so output flushed after the snapshot always
    /// follows the replay frame (the renderer resets the terminal on a replay).
    fn replay_to(&self, link: &Link, id: &str, term: &Term) {
        self.counters.replays.fetch_add(1, Ordering::Relaxed);
        term.out.replay_with(|data, sizes| {
            link.batcher.push(KIND_REPLAY, id, &frame::replay_payload(&data, &sizes), Urgency::Now);
        });
    }

    fn set_flow_control(&self, on: bool) {
        self.flow_on.store(on, Ordering::SeqCst);
        let terms: Vec<Arc<Term>> = self.terms.lock().values().cloned().collect();
        for t in terms {
            t.out.reset_flow();
        }
    }
}

impl PtyEngine {
    /// An engine with its own timer thread.
    pub fn new() -> Self {
        Self::with_scheduler(ThreadScheduler::new("pty-timers"))
    }

    pub fn with_scheduler(sched: Arc<dyn Scheduler>) -> Self {
        let inner = Arc::new_cyclic(|me: &Weak<Inner>| {
            let manager = PtyManager::new(Arc::new(EngineSink(me.clone())));
            let pty = manager.handle();
            Inner {
                me: me.clone(),
                manager,
                pty,
                sched,
                focus: Arc::new(Focus::default()),
                flow_on: Arc::new(AtomicBool::new(false)),
                terms: Mutex::new(HashMap::new()),
                links: RwLock::new(HashMap::new()),
                routes: Mutex::new(WindowRoutes::default()),
                early: Mutex::new(EarlySizes::default()),
                on_exit: RwLock::new(None),
                on_tap: RwLock::new(None),
                #[cfg(windows)]
                timer: Mutex::new(None),
                counters: Counters::default(),
            }
        });
        Self { inner }
    }

    pub fn manager(&self) -> &PtyManager {
        &self.inner.manager
    }

    /// Exits of terminals that ended by themselves, after their output (the pty service reports them to main).
    pub fn on_exit(&self, hook: impl Fn(&str, i64) + Send + Sync + 'static) {
        *self.inner.on_exit.write() = Some(Arc::new(hook));
    }

    /// The raw output of tapped terminals (see [`PtyEngine::spawn_tapped`]), on their reader threads, before it is coalesced.
    pub fn on_tap(&self, hook: impl Fn(&str, &[u8]) + Send + Sync + 'static) {
        *self.inner.on_tap.write() = Some(Arc::new(hook));
    }

    pub fn has(&self, id: &str) -> bool {
        self.inner.terms.lock().contains_key(id)
    }

    /// The live terminal `id` was spawned with a tap.
    pub fn is_tapped(&self, id: &str) -> bool {
        self.inner.term(id).is_some_and(|t| t.tap)
    }

    /// The ids of the live terminals, sorted.
    pub fn ids(&self) -> Vec<String> {
        let mut ids: Vec<String> = self.inner.terms.lock().keys().cloned().collect();
        ids.sort();
        ids
    }

    /// The shell's pid of a live terminal.
    pub fn pid(&self, id: &str) -> Option<u32> {
        self.inner.manager.pid(id)
    }

    /// Kills and forgets every terminal without waiting (the pty service crashed: no exit reports, like the terminals of a
    /// Pty Host process that died).
    pub fn forget_all(&self) {
        let ids: Vec<String> = self.inner.terms.lock().keys().cloned().collect();
        for id in ids {
            let _ = self.kill(&id);
        }
        // Terminals whose spawn had not put them into the table yet, or that ended without an output channel.
        for id in self.inner.manager.ids() {
            let _ = self.inner.manager.kill(&id);
        }
    }

    /// Starts a terminal (one of the same id is killed first); a size the renderer reported before takes the request's.
    pub fn spawn(&self, req: SpawnRequest) -> io::Result<u32> {
        self.spawn_tapped(req, false)
    }

    /// [`PtyEngine::spawn`], with the raw output also going to the tap hook when `tap` is set.
    pub fn spawn_tapped(&self, mut req: SpawnRequest, tap: bool) -> io::Result<u32> {
        let inner = &self.inner;
        if self.has(&req.id) {
            let _ = self.kill(&req.id);
        }
        if let Some((cols, rows)) = inner.early.lock().take(&req.id) {
            req.cols = cols;
            req.rows = rows;
        }
        req.cols = req.cols.max(2);
        req.rows = req.rows.max(1);
        let sink = Arc::new(EngineSink(inner.me.clone()));
        let flow = inner.flow_on.clone();
        let out = OutputChannel::new(
            req.id.clone(),
            sink,
            Arc::new(Pause { pty: inner.pty.clone(), id: req.id.clone() }),
            Arc::new(move || flow.load(Ordering::SeqCst)),
            inner.focus.clone(),
            inner.sched.clone(),
        );
        out.resized(req.cols, req.rows);
        let term = Arc::new(Term { out, da1: Mutex::new(Da1::default()), spawning: Mutex::new(Spawning::default()), tap });
        // The window starts this id's output afresh (the old terminal of the id was killed above: nothing of it follows).
        if let Some(link) = inner.link_of(&req.id) {
            link.batcher.push(KIND_RESET, &req.id, &[], Urgency::Now);
        }
        // In the table before the pty starts: its first output can come before spawn returns.
        inner.terms.lock().insert(req.id.clone(), term.clone());
        #[cfg(windows)]
        {
            let mut timer = inner.timer.lock();
            if timer.is_none() {
                *timer = Some(crate::conpty::TimerResolution::acquire());
            }
        }
        let id = req.id.clone();
        match inner.manager.spawn(req) {
            Ok(pid) => {
                let mut spawning = term.spawning.lock();
                spawning.done = true;
                if let Some((cols, rows)) = spawning.size.take() {
                    inner.manager.resize(&id, cols, rows);
                }
                Ok(pid)
            }
            Err(e) => {
                term.out.dispose();
                inner.forget(&id, &term);
                Err(e)
            }
        }
    }

    /// Kills a terminal: forgotten at once (no more output, no exit report). Wait on the handle for its end.
    pub fn kill(&self, id: &str) -> KillWait {
        let term = self.inner.terms.lock().get(id).cloned();
        if let Some(term) = &term {
            term.out.dispose();
            self.inner.forget(id, term);
        }
        self.inner.manager.kill(id)
    }

    pub fn kill_and_wait(&self, id: &str, timeout: Duration) -> bool {
        self.kill(id).wait(timeout)
    }

    /// Kills every terminal (bounded wait, tree kill of the rest; see PtyManager::kill_all).
    pub fn kill_all(&self, timeout: Duration) -> bool {
        let terms: Vec<(String, Arc<Term>)> = self.inner.terms.lock().drain().collect();
        for (_, t) in &terms {
            t.out.dispose();
        }
        #[cfg(windows)]
        self.inner.timer.lock().take();
        self.inner.manager.kill_all(timeout)
    }

    /// Input from the host itself (the launch command of P3, tests); not counted as typing.
    pub fn write(&self, id: &str, data: &[u8]) {
        self.inner.manager.write(id, data);
    }

    /// Typing from the renderer: its echo is flushed fast.
    pub fn typed(&self, id: &str, data: &[u8]) {
        if let Some(t) = self.inner.term(id) {
            t.out.wrote();
            self.inner.manager.write(id, data);
        }
    }

    /// Resizes a live terminal (and records the size in its tail); a size for a terminal that does not exist yet is kept
    /// for its spawn.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        let (cols, rows) = (cols.max(2), rows.max(1));
        match self.inner.term(id) {
            Some(t) => {
                // A resize during the spawn goes to the pty when spawn returned (it starts at the request's size).
                let mut spawning = t.spawning.lock();
                if spawning.done {
                    self.inner.manager.resize(id, cols, rows);
                } else {
                    spawning.size = Some((cols, rows));
                }
                t.out.resized(cols, rows);
            }
            None => self.inner.early.lock().set(id, cols, rows),
        }
    }

    /// A window's page attached its pty port (load or reload): it gets the replay tail of each of its terminals.
    pub fn attach(&self, label: &str, transport: Arc<dyn Transport>) {
        let inner = &self.inner;
        let link = Arc::new(Link { batcher: WindowBatcher::new(label, transport) });
        // Queued output of the old page is part of the replay tails the new one gets below.
        if let Some(old) = inner.links.write().insert(label.to_string(), link.clone()) {
            old.batcher.stop();
        }
        if label == MAIN_WINDOW {
            // The new renderer reports its focused terminal itself.
            inner.focus.set(None);
            inner.set_flow_control(true);
        }
        let mine: Vec<(String, Arc<Term>)> = {
            let routes = inner.routes.lock();
            let terms = inner.terms.lock();
            let mut v: Vec<(String, Arc<Term>)> =
                terms.iter().filter(|(id, _)| routes.owner_of(id) == label).map(|(id, t)| (id.clone(), t.clone())).collect();
            v.sort_by(|a, b| a.0.cmp(&b.0));
            v
        };
        for (id, term) in mine {
            inner.replay_to(&link, &id, &term);
        }
    }

    /// The window is gone (closed, or its webview was destroyed).
    pub fn detach(&self, label: &str) {
        let old = self.inner.links.write().remove(label);
        if let Some(old) = old {
            old.batcher.stop();
            if label == MAIN_WINDOW {
                self.inner.set_flow_control(false);
            }
        }
    }

    /// One renderer -> host message of the pty port from window `label` (src/shared/ipc.ts RendererToHost, plus the
    /// bridge's `released` ack).
    pub fn post(&self, label: &str, m: &Value) {
        let inner = &self.inner;
        let t = m.get("t").and_then(Value::as_str).unwrap_or("");
        match t {
            "released" => {
                if let Some(upto) = num(m, "upto").filter(|n| *n >= 0.0) {
                    let link = inner.links.read().get(label).cloned();
                    if let Some(link) = link {
                        link.batcher.released(upto as u64);
                    }
                }
                return;
            }
            "focus" => {
                let id = m.get("id").and_then(Value::as_str);
                let report = inner.routes.lock().focus(label, id);
                if let Some(focused) = report {
                    inner.focus.set(focused.clone());
                    if let Some(id) = focused
                        && let Some(t) = inner.term(&id)
                    {
                        t.out.rearm();
                    }
                }
                return;
            }
            _ => {}
        }
        let Some(id) = m.get("id").and_then(Value::as_str) else { return };
        // A window speaks only for its own terminals (a detached grid's cells are not the main window's any more).
        if !inner.routes.lock().accepts(label, id) {
            return;
        }
        match t {
            "write" => {
                let Some(data) = m.get("data").and_then(Value::as_str) else { return };
                let reply = m.get("reply").and_then(Value::as_bool) == Some(true);
                if let Some(term) = inner.term(id) {
                    // A terminal reply (device / focus / mouse report) is not typing: it does not shorten the window.
                    if !reply {
                        term.out.wrote();
                    }
                    inner.manager.write(id, data.as_bytes());
                }
            }
            "resize" => {
                if let (Some(cols), Some(rows)) = (size_of(m, "cols", 0), size_of(m, "rows", 0)) {
                    self.resize(id, cols, rows);
                }
            }
            "ack" => {
                if let Some(n) = num(m, "chars").filter(|n| *n > 0.0)
                    && let Some(term) = inner.term(id)
                {
                    term.out.ack(n.min(usize::MAX as f64) as usize);
                }
            }
            // sshList / sshStats: the SSH backend (P5).
            _ => {}
        }
    }

    /// A terminal moved to another window (None: the main window): the old window's queued output goes out first, the new
    /// one gets the replay tail.
    pub fn route(&self, id: &str, window: Option<&str>) {
        let inner = &self.inner;
        let Some(before) = inner.routes.lock().set(id, window) else { return };
        let old = inner.links.read().get(&before).cloned();
        if let Some(old) = old {
            old.batcher.flush_soon();
        }
        let Some(term) = inner.term(id) else { return };
        // Acks of output the old window parsed never come from the new one.
        term.out.reset_flow();
        if let Some(link) = inner.link_of(id) {
            inner.replay_to(&link, id, &term);
        }
    }

    /// The owner window of a terminal.
    pub fn owner_of(&self, id: &str) -> String {
        self.inner.routes.lock().owner_of(id).to_string()
    }

    /// Any other message of the pty port to one window (sshListResult, sshStatsResult of P5), in order with the output.
    pub fn post_json(&self, label: &str, message: &Value) -> bool {
        let link = self.inner.links.read().get(label).cloned();
        let Some(link) = link else { return false };
        link.batcher.push(KIND_JSON, "", message.to_string().as_bytes(), Urgency::Now);
        true
    }

    /// The replay tail of a live terminal and the sizes it was written at.
    pub fn replay(&self, id: &str) -> Option<(Vec<u8>, Vec<crate::flow::ReplaySize>)> {
        self.inner.term(id).map(|t| t.out.replay())
    }

    /// Stats for the harness: windows (transport, posts, in flight), terminals (unacked bytes), DA1 answers.
    pub fn stats_json(&self) -> Value {
        let inner = &self.inner;
        let links: serde_json::Map<String, Value> =
            inner.links.read().iter().map(|(l, link)| (l.clone(), link.batcher.stats_json())).collect();
        // The table's lock is not held while a channel's state is read (a flush holds that one and takes `routes`, and
        // attach holds `routes` while it takes `terms`).
        let list: Vec<(String, Arc<Term>)> = inner.terms.lock().iter().map(|(id, t)| (id.clone(), t.clone())).collect();
        let terms: serde_json::Map<String, Value> = list
            .into_iter()
            .map(|(id, t)| (id, json!({ "unacked": t.out.unacked(), "paused": t.out.paused_or_watched() })))
            .collect();
        json!({
            "windows": links,
            "terminals": terms,
            "flowControl": inner.flow_on.load(Ordering::SeqCst),
            "focused": inner.focus.get(),
            "da1Answers": inner.counters.da1_answers.load(Ordering::Relaxed),
            "replays": inner.counters.replays.load(Ordering::Relaxed),
            "earlySizes": inner.early.lock().len(),
        })
    }
}

impl Default for PtyEngine {
    fn default() -> Self {
        Self::new()
    }
}
