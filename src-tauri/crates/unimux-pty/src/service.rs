//! The pty service (P3): what 1.1.4's Pty Host process and its client did around the terminals (src/ptyhost/index.ts
//! `handleMain` / `sink`, src/main/ptyHostClient.ts), on top of the output engine of P2.
//!
//! - Control commands (spawn, host input, kill, kill with an answer, kill all) run in order on one supervised actor thread
//!   ([`crate::supervisor`]), as the host's `parentPort` messages did. A spawn answers with [`HostEvent::Spawned`] (the
//!   shell's pid) or [`HostEvent::SpawnError`]; a terminal that ends by itself reports [`HostEvent::Exit`] after its output.
//! - A panic on the actor thread, or in the output path on a terminal's reader thread, is a crash of the "host": every
//!   terminal is killed and forgotten (no exit reports) and [`HostEvent::Crashed`] follows; the actor runs again after
//!   500 * 2^(n-1) ms and keeps the commands sent meanwhile (up to 500). More than 5 crashes in 60 s are fatal
//!   ([`HostEvent::Fatal`]): nothing runs until [`PtyService::restart_after_fatal`].
//! - Tap (the install window, login terminals): the output of a terminal spawned with `tap` also reaches main as text
//!   ([`HostEvent::Tap`], UTF-8 decoded across reads), and Ctrl+C typed into it in its window is reported
//!   ([`HostEvent::Interrupt`]).
//! - Renderer messages of the pty port go straight to the engine (they never waited for the host's control queue either);
//!   a panic while one is handled is logged (rate-limited by the app) and the terminals keep running, as an uncaught
//!   exception of the 1.1.4 host was.
//! - Routes of terminals to detached windows live in the engine and survive a crash (1.1.4 re-sent them to a new host).

use std::collections::HashMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::sync::mpsc::{Receiver, Sender, channel};
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use serde_json::Value;

use crate::batch::Transport;
use crate::engine::PtyEngine;
use crate::manager::{SpawnRequest, panic_message};
use crate::supervisor::{CrashInjector, CrashPolicy, Supervisor, SupervisorEvent};

/// How long `killAndWait` waits for a terminal's end (PtyHostClient.killAndWait default).
pub const KILL_AND_WAIT: Duration = Duration::from_millis(4000);
/// How long the quit waits for every terminal (PtyHostClient.shutdown default).
pub const SHUTDOWN_WAIT: Duration = Duration::from_millis(4000);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LogLevel {
    Warn,
    Error,
}

/// What the service tells main (HostToMain of src/shared/ipc.ts without the SSH messages, plus the client's
/// `crashed` / `fatal` events).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostEvent {
    /// `spawned`: the terminal runs; `pid` is the shell's.
    Spawned { id: String, pid: u32 },
    /// `spawnError`: the terminal could not start.
    SpawnError { id: String, message: String },
    /// `exit`: the terminal ended by itself (killed terminals never report).
    Exit { id: String, code: i64 },
    /// `tap`: output of a terminal spawned with `tap`.
    Tap { id: String, data: String },
    /// `interrupt`: the user typed Ctrl+C into a tapped terminal.
    Interrupt { id: String },
    /// `log`: an error inside the service for main's crash log (never a message payload).
    Log { level: LogLevel, message: String },
    /// The "host" crashed and restarts; its terminals are gone. `message` stands in for the stderr tail.
    Crashed { message: String, count: usize },
    /// The "host" crashed too often; nothing runs until `restart_after_fatal`.
    Fatal { message: String, count: usize },
    /// A new "host" runs after a crash.
    Restarted,
}

type Listener = Arc<dyn Fn(HostEvent) + Send + Sync>;

enum Cmd {
    Spawn(Box<SpawnRequest>, bool),
    Write(String, Vec<u8>),
    /// `kill`, with `ack`: the answer once the terminal ended or the time passed (the actor does not wait).
    Kill(String, Option<(Duration, Sender<bool>)>),
    /// `killAll`, then `killedAll` (true when every terminal ended in time).
    KillAll(Duration, Sender<bool>),
    /// Tests and the check build: a crash on the actor thread.
    Panic(String),
}

/// A UTF-8 decoder that keeps an incomplete character at the end of a read for the next one (StringDecoder).
#[derive(Debug, Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    /// Decodes `bytes` after what was left over; an incomplete character at the end waits, invalid bytes become U+FFFD.
    pub fn push(&mut self, bytes: &[u8]) -> String {
        let mut buf = std::mem::take(&mut self.pending);
        buf.extend_from_slice(bytes);
        let mut out = String::with_capacity(buf.len());
        let mut rest: &[u8] = &buf;
        loop {
            match std::str::from_utf8(rest) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let (good, after) = rest.split_at(e.valid_up_to());
                    out.push_str(std::str::from_utf8(good).unwrap_or_default());
                    match e.error_len() {
                        Some(n) => {
                            out.push('\u{FFFD}');
                            rest = &after[n..];
                        }
                        None => {
                            self.pending = after.to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }
}

struct Shared {
    engine: PtyEngine,
    listener: RwLock<Option<Listener>>,
    /// The tapped terminals and their decoders (`tapped` of the host).
    taps: Mutex<HashMap<String, Utf8Stream>>,
    /// Held while a spawn runs and its `spawned` goes out, and while an exit goes out: a terminal that ends at once still
    /// reports its exit after its `spawned`, as the single-threaded host did.
    order: Mutex<()>,
}

impl Shared {
    fn emit(&self, event: HostEvent) {
        let listener = self.listener.read().clone();
        if let Some(listener) = listener {
            listener(event);
        }
    }

    /// What a dead host took along: its terminals and their taps.
    fn forget_all(&self) {
        self.taps.lock().clear();
        self.engine.forget_all();
    }
}

/// The state the supervisor builds (again after every crash): one "host" generation. Dropping it (a crash, the stop)
/// kills and forgets its terminals.
struct Generation {
    shared: Arc<Shared>,
}

impl Drop for Generation {
    fn drop(&mut self) {
        self.shared.forget_all();
    }
}

/// The pty service of one app run.
pub struct PtyService {
    shared: Arc<Shared>,
    sup: Supervisor<Cmd>,
    injector: CrashInjector<Cmd>,
}

impl PtyService {
    /// The service over `engine` with the 1.1.4 crash policy.
    pub fn new(engine: PtyEngine) -> Self {
        Self::with_policy(engine, CrashPolicy::default())
    }

    pub fn with_policy(engine: PtyEngine, policy: CrashPolicy) -> Self {
        let shared = Arc::new(Shared {
            engine: engine.clone(),
            listener: RwLock::new(None),
            taps: Mutex::new(HashMap::new()),
            order: Mutex::new(()),
        });
        let weak = Arc::downgrade(&shared);
        engine.on_exit(move |id, code| {
            let Some(shared) = weak.upgrade() else { return };
            let _order = shared.order.lock();
            shared.taps.lock().remove(id);
            shared.emit(HostEvent::Exit { id: id.to_string(), code });
        });
        let weak = Arc::downgrade(&shared);
        engine.on_tap(move |id, data| {
            let Some(shared) = weak.upgrade() else { return };
            let text = {
                let mut taps = shared.taps.lock();
                let Some(stream) = taps.get_mut(id) else { return };
                stream.push(data)
            };
            if !text.is_empty() {
                shared.emit(HostEvent::Tap { id: id.to_string(), data: text });
            }
        });
        let factory_shared = shared.clone();
        let events_shared = Arc::downgrade(&shared);
        let sup = Supervisor::start(
            "pty-service",
            policy,
            move |injector: CrashInjector<Cmd>| {
                // A panic in the output path on a reader thread crashes the generation (the actor kills its terminals).
                factory_shared.engine.manager().set_panic_hook(Some(Arc::new(move |message: String| injector.crash(message))));
                Generation { shared: factory_shared.clone() }
            },
            handle,
            move |event| {
                let Some(shared) = events_shared.upgrade() else { return };
                shared.emit(match event {
                    SupervisorEvent::Crashed { message, count, .. } => HostEvent::Crashed { message, count },
                    SupervisorEvent::Fatal { message, count } => HostEvent::Fatal { message, count },
                    SupervisorEvent::Restarted => HostEvent::Restarted,
                });
            },
        );
        let injector = sup.crash_injector();
        Self { shared, sup, injector }
    }

    /// Where the events go (main's `ptyHost.on('message' | 'crashed' | 'fatal')`). Called on the actor thread, the
    /// terminals' reader threads and the engine's timer thread: it must not block.
    pub fn set_listener(&self, listener: impl Fn(HostEvent) + Send + Sync + 'static) {
        *self.shared.listener.write() = Some(Arc::new(listener));
    }

    pub fn engine(&self) -> &PtyEngine {
        &self.shared.engine
    }

    /// True after the service crashed too often; nothing runs until [`PtyService::restart_after_fatal`].
    pub fn is_fatal(&self) -> bool {
        self.sup.is_fatal()
    }

    /// A "host" runs (not between a crash and its restart, not fatal, not stopped).
    pub fn is_running(&self) -> bool {
        self.sup.is_running()
    }

    /// The user chose "Restart terminals" after a fatal crash: the crash count starts again.
    pub fn restart_after_fatal(&self) {
        self.sup.restart_after_fatal();
    }

    /// `spawn`: starts a terminal; the answer is a `Spawned` or `SpawnError` event. False when it was dropped (fatal,
    /// stopped, or the restart queue is full).
    pub fn spawn(&self, req: SpawnRequest, tap: bool) -> bool {
        self.sup.send(Cmd::Spawn(Box::new(req), tap))
    }

    /// Input from main itself (agent delivery, the install window), in order with the spawns and kills.
    pub fn write(&self, id: &str, data: &[u8]) -> bool {
        self.sup.send(Cmd::Write(id.to_string(), data.to_vec()))
    }

    /// `kill`: the terminal is killed and forgotten (no exit report).
    pub fn kill(&self, id: &str) -> bool {
        self.sup.send(Cmd::Kill(id.to_string(), None))
    }

    /// `killAndWait`: kills the terminal; the receiver gets true once it ended, false when `timeout` passed first. None when
    /// no host runs (PtyHostClient answered at once and sent nothing).
    pub fn kill_and_wait(&self, id: &str, timeout: Duration) -> Option<Receiver<bool>> {
        if !self.is_running() {
            return None;
        }
        let (tx, rx) = channel();
        self.sup.send(Cmd::Kill(id.to_string(), Some((timeout, tx)))).then_some(rx)
    }

    /// `shutdown`: kills every terminal and waits (bounded) for them; true when all ended in time or none ran.
    pub fn kill_all(&self, timeout: Duration) -> bool {
        if !self.is_running() {
            return true;
        }
        let (tx, rx) = channel();
        if !self.sup.send(Cmd::KillAll(timeout, tx)) {
            return true;
        }
        // The actor may still finish a spawn first; the command itself is bounded by `timeout`.
        rx.recv_timeout(timeout + Duration::from_secs(1)).unwrap_or(false)
    }

    /// `forceKill`: the shutdown overran its limit: every terminal is killed at once and the actor stops.
    pub fn force_kill(&self) {
        self.sup.stop();
        self.shared.forget_all();
    }

    /// Stops the actor (its terminals are killed with it).
    pub fn stop(&self) {
        self.sup.stop();
    }

    /// Routes a terminal to a window label (None: the main window); the new window gets its replay.
    pub fn route(&self, id: &str, window: Option<&str>) {
        self.shared.engine.route(id, window);
    }

    /// A window's page attached the pty port.
    pub fn attach(&self, label: &str, transport: Arc<dyn Transport>) {
        self.shared.engine.attach(label, transport);
    }

    /// A window's page or the window is gone.
    pub fn detach(&self, label: &str) {
        self.shared.engine.detach(label);
    }

    /// One renderer message of the pty port from window `label`. A panic while it is handled is logged, the terminals keep
    /// running. Ctrl+C typed into a tapped terminal by its window is reported after the input went to it.
    pub fn post(&self, label: &str, message: &Value) {
        let engine = &self.shared.engine;
        if let Err(p) = catch_unwind(AssertUnwindSafe(|| engine.post(label, message))) {
            self.shared.emit(HostEvent::Log {
                level: LogLevel::Error,
                message: format!("pty host uncaught exception: {}", cut(&panic_message(p.as_ref()), 4000)),
            });
            return;
        }
        if message.get("t").and_then(Value::as_str) != Some("write") {
            return;
        }
        let (Some(id), Some(data)) = (message.get("id").and_then(Value::as_str), message.get("data").and_then(Value::as_str))
        else {
            return;
        };
        if data.contains('\u{3}') && engine.owner_of(id) == label && self.shared.taps.lock().contains_key(id) {
            self.shared.emit(HostEvent::Interrupt { id: id.to_string() });
        }
    }

    /// The shell's pid of a live terminal.
    pub fn pid(&self, id: &str) -> Option<u32> {
        self.shared.engine.pid(id)
    }

    /// The live terminals.
    pub fn ids(&self) -> Vec<String> {
        self.shared.engine.ids()
    }

    /// Check build and tests: a panic on the actor thread (the crash flow).
    pub fn inject_panic(&self, message: &str) -> bool {
        self.sup.send(Cmd::Panic(message.to_string()))
    }

    /// Check build and tests: a crash as from a terminal's reader thread.
    pub fn inject_reader_crash(&self, message: &str) {
        self.injector.crash(message.to_string());
    }
}

impl Drop for PtyService {
    fn drop(&mut self) {
        self.sup.stop();
    }
}

fn cut(text: &str, max: usize) -> &str {
    match text.char_indices().nth(max) {
        Some((i, _)) => &text[..i],
        None => text,
    }
}

fn handle(g: &mut Generation, cmd: Cmd) {
    let shared = &g.shared;
    match cmd {
        Cmd::Spawn(req, tap) => {
            let id = req.id.clone();
            let _order = shared.order.lock();
            if tap {
                shared.taps.lock().insert(id.clone(), Utf8Stream::default());
            } else {
                shared.taps.lock().remove(&id);
            }
            match shared.engine.spawn_tapped(*req, tap) {
                Ok(pid) => shared.emit(HostEvent::Spawned { id, pid }),
                Err(e) => {
                    shared.taps.lock().remove(&id);
                    shared.emit(HostEvent::SpawnError { id, message: e.to_string() });
                }
            }
        }
        Cmd::Write(id, data) => shared.engine.write(&id, &data),
        Cmd::Kill(id, ack) => {
            shared.taps.lock().remove(&id);
            let wait = shared.engine.kill(&id);
            if let Some((timeout, done)) = ack {
                let waiter = move || {
                    let _ = done.send(wait.wait(timeout));
                };
                if let Err(e) = std::thread::Builder::new().name("pty-kill-ack".into()).spawn(waiter) {
                    shared.emit(HostEvent::Log { level: LogLevel::Warn, message: format!("pty kill wait failed: {e}") });
                }
            }
        }
        Cmd::KillAll(timeout, done) => {
            shared.taps.lock().clear();
            let all = shared.engine.kill_all(timeout);
            let _ = done.send(all);
        }
        Cmd::Panic(message) => panic!("{message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_stream_keeps_a_split_character_for_the_next_read() {
        let mut s = Utf8Stream::default();
        let bytes = "zażółć".as_bytes();
        // "ż" is two bytes: cut inside it.
        assert_eq!(s.push(&bytes[..3]), "za");
        assert_eq!(s.push(&bytes[3..]), "żółć");
        assert_eq!(s.push(b""), "");
    }

    #[test]
    fn utf8_stream_replaces_invalid_bytes_and_goes_on() {
        let mut s = Utf8Stream::default();
        assert_eq!(s.push(b"a\xffb"), "a\u{FFFD}b");
        // A lone continuation byte, then a four-byte character split in three reads.
        let emoji = "\u{1F600}".as_bytes();
        assert_eq!(s.push(&[0x80, emoji[0]]), "\u{FFFD}");
        assert_eq!(s.push(&emoji[1..3]), "");
        assert_eq!(s.push(&emoji[3..]), "\u{1F600}");
    }

    #[test]
    fn cut_counts_characters() {
        assert_eq!(cut("ąbc", 2), "ąb");
        assert_eq!(cut("ab", 5), "ab");
    }
}
