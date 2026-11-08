//! The terminals of the app (port of `PtyManager` in src/ptyhost/manager.ts without the output engine, which P2 puts
//! between the pty and the sink): spawn with the resolved shell and the terminal environment, the launch command typed
//! 150 ms after the first output, write, resize, pause, kill (bounded wait), kill_all with a tree kill for terminals still
//! running after the time limit.
//!
//! Differences to 1.1.4 that do not change behaviour: kills run in parallel (node-pty 1.1.0 needed them one at a time for
//! its "remove_pty_baton" assertion; the own ConPTY wrapper has no shared list), and the tree kill uses the terminal's own
//! handles (the Job Object / its session) instead of `taskkill /T /F <pid>`, so it can never hit a reused pid.

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex, RwLock};

use crate::shell::{Launch, Platform, ShellKind, resolve_shell, terminal_env};
use crate::shell_integration::{default_shell_dir, integrated_launch};

#[cfg(windows)]
use crate::conpty as sys;
#[cfg(unix)]
use crate::unix as sys;

/// The time `kill_and_wait` and `kill_all` give the terminals to end (PtyManager.kill / killAll).
pub const KILL_TIMEOUT: Duration = Duration::from_millis(3000);
/// The launch command is typed this long after the shell's first output (it finishes drawing its prompt meanwhile).
pub const COMMAND_DELAY: Duration = Duration::from_millis(150);

/// `SpawnRequest` of src/shared/ipc.ts (without `tap`, which the pty service of P3 handles) plus the cell id.
#[derive(Debug, Clone)]
pub struct SpawnRequest {
    pub id: String,
    pub cwd: PathBuf,
    pub cols: u16,
    pub rows: u16,
    /// The cell environment (already cleaned by the caller), in order.
    pub env: Vec<(String, String)>,
    pub shell: ShellKind,
    /// Typed into the shell (with a CR) 150 ms after its first output: the agent launch command.
    pub command: Option<String>,
    /// MC_CELL_ID of the terminal's environment.
    pub cell_id: Option<String>,
    /// The program instead of the resolved shell (shell integration of P4, tests).
    pub launch: Option<Launch>,
}

impl SpawnRequest {
    pub fn new(id: impl Into<String>, cwd: impl Into<PathBuf>, shell: ShellKind) -> Self {
        Self {
            id: id.into(),
            cwd: cwd.into(),
            cols: 80,
            rows: 24,
            env: Vec::new(),
            shell,
            command: None,
            cell_id: None,
            launch: None,
        }
    }
}

/// Where the terminals' output and exits go (P2's OutputChannel, the pty service of P3, tests). Called on the terminals'
/// reader threads.
pub trait PtySink: Send + Sync + 'static {
    fn data(&self, id: &str, data: &[u8]);
    /// The exit code (Windows: the DWORD of GetExitCodeProcess; Unix: the exit status, 0 after a signal).
    fn exit(&self, id: &str, code: i64);
}

/// One spawned terminal. Lives in `entries` while it is the terminal of its id, and in `running` until its exit was reported.
struct Slot {
    id: String,
    serial: u64,
    pty: OnceLock<Arc<sys::Pty>>,
    /// What came for the terminal before its pty was in the slot: the first output reaches the sink before spawn returned,
    /// and an answer to it (DA1), a flow-control pause or a resize must not be lost. Applied when the pty is set; the lock orders
    /// that hand-over.
    early: Mutex<Early>,
    killed: AtomicBool,
    exited: Mutex<bool>,
    exited_cv: Condvar,
}

#[derive(Default)]
struct Early {
    input: Vec<u8>,
    paused: Option<bool>,
    size: Option<(u16, u16)>,
}

impl Slot {
    fn write(&self, data: &[u8]) {
        let mut early = self.early.lock();
        match self.pty.get() {
            Some(pty) => pty.write(data),
            None => early.input.extend_from_slice(data),
        }
    }

    fn set_paused(&self, paused: bool) {
        let mut early = self.early.lock();
        match self.pty.get() {
            Some(pty) => pty.set_paused(paused),
            None => early.paused = Some(paused),
        }
    }

    fn resize(&self, cols: u16, rows: u16) {
        let mut early = self.early.lock();
        match self.pty.get() {
            // Errors of a terminal that is ending are ignored.
            Some(pty) => {
                let _ = pty.resize(cols, rows);
            }
            None => early.size = Some((cols, rows)),
        }
    }

    fn set_pty(&self, pty: Arc<sys::Pty>) {
        let mut early = self.early.lock();
        if let Some((cols, rows)) = early.size.take() {
            let _ = pty.resize(cols, rows);
        }
        if let Some(paused) = early.paused.take() {
            pty.set_paused(paused);
        }
        if !early.input.is_empty() {
            pty.write(&std::mem::take(&mut early.input));
        }
        let _ = self.pty.set(pty);
    }

    fn wait(&self, deadline: Instant) -> bool {
        let mut done = self.exited.lock();
        while !*done {
            if self.exited_cv.wait_until(&mut done, deadline).timed_out() {
                return *done;
            }
        }
        true
    }

    fn kill(&self) {
        self.killed.store(true, Ordering::SeqCst);
        if let Some(pty) = self.pty.get() {
            pty.kill();
        }
    }
}

type PanicHook = Arc<dyn Fn(String) + Send + Sync>;
type TreeKillProbe = Arc<dyn Fn(u32) + Send + Sync>;

struct Inner {
    sink: RwLock<Arc<dyn PtySink>>,
    entries: Mutex<HashMap<String, Arc<Slot>>>,
    /// Terminals whose exit was not reported yet (also killed ones that left `entries`), by serial.
    running: Mutex<HashMap<u64, Arc<Slot>>>,
    serial: AtomicU64,
    /// Called (instead of unwinding the reader thread) when the sink panicked; the supervised actor turns it into a crash.
    panic_hook: RwLock<Option<PanicHook>>,
    /// Observes the tree kills of kill_all (tests).
    tree_kill_probe: RwLock<Option<TreeKillProbe>>,
    /// Holds spawn this long between the start of the pty and putting it into its slot (tests: a slow machine).
    spawn_hold: RwLock<Option<Duration>>,
}

impl Inner {
    fn current(&self, id: &str, serial: u64) -> Option<Arc<Slot>> {
        self.entries.lock().get(id).filter(|s| s.serial == serial).cloned()
    }

    fn sink(&self) -> Arc<dyn PtySink> {
        self.sink.read().clone()
    }

    /// Runs a sink call; a panic in it is reported to the panic hook (or re-raised when there is none).
    fn guarded(&self, f: impl FnOnce()) {
        if let Err(payload) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)) {
            let hook = self.panic_hook.read().clone();
            match hook {
                Some(hook) => hook(panic_message(payload.as_ref())),
                None => std::panic::resume_unwind(payload),
            }
        }
    }

    fn kill_slot(&self, slot: &Arc<Slot>) {
        slot.kill();
    }
}

/// The text of a panic payload.
pub fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "panic".to_string()
    }
}

/// A kill in progress; [`KillWait::wait`] blocks until the terminal ended or the time is up.
pub struct KillWait(Option<Arc<Slot>>);

impl KillWait {
    /// True when the terminal's exit was reported (or there was nothing to kill).
    pub fn wait(&self, timeout: Duration) -> bool {
        self.0.as_ref().is_none_or(|s| s.wait(Instant::now() + timeout))
    }
}

/// Writes to the terminals without owning the manager (answers from a sink, the DA1 reply of P2).
#[derive(Clone)]
pub struct PtyHandle(Weak<Inner>);

impl PtyHandle {
    pub fn write(&self, id: &str, data: &[u8]) {
        let Some(inner) = self.0.upgrade() else { return };
        let slot = inner.entries.lock().get(id).cloned();
        if let Some(slot) = slot {
            slot.write(data);
        }
    }

    /// Flow control from the output engine (P2): stops or resumes reading the terminal's output.
    pub fn set_paused(&self, id: &str, paused: bool) {
        let Some(inner) = self.0.upgrade() else { return };
        let slot = inner.entries.lock().get(id).cloned();
        if let Some(slot) = slot {
            slot.set_paused(paused);
        }
    }
}

pub struct PtyManager {
    inner: Arc<Inner>,
}

impl PtyManager {
    pub fn new(sink: Arc<dyn PtySink>) -> Self {
        Self {
            inner: Arc::new(Inner {
                sink: RwLock::new(sink),
                entries: Mutex::new(HashMap::new()),
                running: Mutex::new(HashMap::new()),
                serial: AtomicU64::new(1),
                panic_hook: RwLock::new(None),
                tree_kill_probe: RwLock::new(None),
                spawn_hold: RwLock::new(None),
            }),
        }
    }

    pub fn set_sink(&self, sink: Arc<dyn PtySink>) {
        *self.inner.sink.write() = sink;
    }

    /// Where a panic of the sink goes (the supervised actor of [`crate::supervisor`]); without one it unwinds the reader.
    pub fn set_panic_hook(&self, hook: Option<PanicHook>) {
        *self.inner.panic_hook.write() = hook;
    }

    /// Tests: sees the pid of every terminal kill_all tree-kills.
    pub fn set_tree_kill_probe(&self, probe: Option<TreeKillProbe>) {
        *self.inner.tree_kill_probe.write() = probe;
    }

    /// Tests: holds every spawn this long after its pty started and before the pty is in its slot (the first output and
    /// the launch command then come before spawn returned, as on a loaded machine).
    pub fn set_spawn_hold(&self, hold: Option<Duration>) {
        *self.inner.spawn_hold.write() = hold;
    }

    pub fn handle(&self) -> PtyHandle {
        PtyHandle(Arc::downgrade(&self.inner))
    }

    pub fn has(&self, id: &str) -> bool {
        self.inner.entries.lock().contains_key(id)
    }

    pub fn ids(&self) -> Vec<String> {
        self.inner.entries.lock().keys().cloned().collect()
    }

    /// The shell's pid of a live terminal.
    pub fn pid(&self, id: &str) -> Option<u32> {
        self.inner.entries.lock().get(id).and_then(|s| s.pty.get().map(|p| p.pid()))
    }

    /// Terminals whose exit was not reported yet (live ones and killed ones still ending).
    pub fn running(&self) -> usize {
        self.inner.running.lock().len()
    }

    /// Starts a terminal (a running terminal of the same id is killed first) and returns the shell's pid.
    pub fn spawn(&self, req: SpawnRequest) -> io::Result<u32> {
        let inner = &self.inner;
        let cols = req.cols.max(2);
        let rows = req.rows.max(1);
        // A terminal without its own launch gets the resolved shell with its prompt marks (PtyManager.spawn's
        // integratedLaunch; the cmd prompt lives in the environment).
        let (launch, env) = match &req.launch {
            Some(launch) => (launch.clone(), terminal_env(&req.env, req.cell_id.as_deref())),
            None => {
                let shell = resolve_shell(req.shell, &req.env, Platform::current());
                let (launch, env) = integrated_launch(req.shell, &shell, &req.env, Platform::current(), &default_shell_dir());
                (launch, terminal_env(&env, req.cell_id.as_deref()))
            }
        };

        let slot = Arc::new(Slot {
            id: req.id.clone(),
            serial: inner.serial.fetch_add(1, Ordering::SeqCst),
            pty: OnceLock::new(),
            early: Mutex::new(Early::default()),
            killed: AtomicBool::new(false),
            exited: Mutex::new(false),
            exited_cv: Condvar::new(),
        });
        // In the table before the pty exists: an exit that comes before spawn returned still finds its entry.
        let old = inner.entries.lock().insert(req.id.clone(), slot.clone());
        if let Some(old) = old {
            inner.kill_slot(&old);
        }

        let serial = slot.serial;
        let id = req.id.clone();
        let weak = Arc::downgrade(inner);
        let mut pending_command = req.command.clone();
        let on_data = {
            let (weak, id) = (weak.clone(), id.clone());
            move |data: &[u8]| {
                let Some(inner) = weak.upgrade() else { return };
                if inner.current(&id, serial).is_none() {
                    return;
                }
                inner.guarded(|| inner.sink().data(&id, data));
                if let Some(cmd) = pending_command.take() {
                    let (weak, id) = (weak.clone(), id.clone());
                    // Through the slot: a pty that is not in it yet (spawn still running on a slow machine) gets the
                    // command with the rest of the early input when it is set.
                    let typed = move || {
                        std::thread::sleep(COMMAND_DELAY);
                        if let Some(inner) = weak.upgrade()
                            && let Some(slot) = inner.current(&id, serial)
                        {
                            slot.write(format!("{cmd}\r").as_bytes());
                        }
                    };
                    let _ = std::thread::Builder::new().name("pty-command".into()).spawn(typed);
                }
            }
        };
        let on_exit = {
            let slot = slot.clone();
            move |code: i64| {
                if let Some(inner) = weak.upgrade() {
                    let current = inner.current(&id, serial).is_some();
                    if current {
                        // Still in `entries` while the sink handles the exit: its flow control can still resume the
                        // terminal (PtyHandle::set_paused) for the last output.
                        inner.guarded(|| inner.sink().exit(&id, code));
                        let mut entries = inner.entries.lock();
                        if entries.get(&id).is_some_and(|s| s.serial == serial) {
                            entries.remove(&id);
                        }
                    }
                    inner.running.lock().remove(&serial);
                }
                *slot.exited.lock() = true;
                slot.exited_cv.notify_all();
            }
        };

        inner.running.lock().insert(serial, slot.clone());
        let spawned = spawn_sys(&launch, &req.cwd, env, cols, rows, Box::new(on_data), Box::new(on_exit));
        let pty = match spawned {
            Ok(pty) => Arc::new(pty),
            Err(e) => {
                inner.running.lock().remove(&serial);
                let mut entries = inner.entries.lock();
                if entries.get(&req.id).is_some_and(|s| s.serial == serial) {
                    entries.remove(&req.id);
                }
                return Err(e);
            }
        };
        let pid = pty.pid();
        let hold = *inner.spawn_hold.read();
        if let Some(hold) = hold {
            std::thread::sleep(hold);
        }
        slot.set_pty(pty.clone());
        // A kill that came while the pty was being created.
        if slot.killed.load(Ordering::SeqCst) {
            pty.kill();
        }
        Ok(pid)
    }

    fn slot(&self, id: &str) -> Option<Arc<Slot>> {
        self.inner.entries.lock().get(id).cloned()
    }

    /// Input for a live terminal (never blocks).
    pub fn write(&self, id: &str, data: &[u8]) {
        if let Some(slot) = self.slot(id) {
            slot.write(data);
        }
    }

    /// Resizes a live terminal (at least 2 x 1); errors of a terminal that is ending are ignored. A terminal whose spawn
    /// is still running gets the size when its pty is set.
    pub fn resize(&self, id: &str, cols: u16, rows: u16) {
        if let Some(slot) = self.slot(id) {
            slot.resize(cols.max(2), rows.max(1));
        }
    }

    /// Flow control: stops or resumes reading the terminal's output.
    pub fn set_paused(&self, id: &str, paused: bool) {
        if let Some(slot) = self.slot(id) {
            slot.set_paused(paused);
        }
    }

    /// Kills a terminal (forgotten at once: no more output, no exit report) and returns a handle to wait for its end.
    pub fn kill(&self, id: &str) -> KillWait {
        let slot = self.inner.entries.lock().remove(id);
        if let Some(slot) = &slot {
            self.inner.kill_slot(slot);
        }
        KillWait(slot)
    }

    /// Kills a terminal and waits until its processes are gone or `timeout` passed; true when it ended in time.
    pub fn kill_and_wait(&self, id: &str, timeout: Duration) -> bool {
        self.kill(id).wait(timeout)
    }

    /// Kills every terminal and waits (bounded) for their exits. Terminals still running when the time is up (also killed
    /// ones from before) have their process tree ended, so no dev server an agent started outlives the app. True when all
    /// ended in time.
    pub fn kill_all(&self, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let slots: Vec<Arc<Slot>> = self.inner.entries.lock().drain().map(|(_, s)| s).collect();
        for slot in &slots {
            self.inner.kill_slot(slot);
        }
        let all = slots.iter().all(|s| s.wait(deadline));
        let left: Vec<Arc<Slot>> = self.inner.running.lock().values().cloned().collect();
        let probe = self.inner.tree_kill_probe.read().clone();
        for slot in left {
            if *slot.exited.lock() {
                continue;
            }
            if let Some(pty) = slot.pty.get() {
                if let Some(probe) = &probe {
                    probe(pty.pid());
                }
                pty.kill_tree();
            }
        }
        all
    }
}

impl Drop for PtyManager {
    /// The manager's owner is gone (app exit, or the supervised actor crashed): every terminal is killed and forgotten.
    fn drop(&mut self) {
        let slots: Vec<Arc<Slot>> = self.inner.entries.lock().drain().map(|(_, s)| s).collect();
        for slot in slots {
            slot.kill();
        }
    }
}

impl std::fmt::Debug for Slot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Slot").field("id", &self.id).field("serial", &self.serial).finish()
    }
}

type DataFn = Box<dyn FnMut(&[u8]) + Send>;
type ExitFn = Box<dyn FnOnce(i64) + Send>;

#[cfg(windows)]
fn spawn_sys(
    launch: &Launch,
    cwd: &std::path::Path,
    env: Vec<(String, String)>,
    cols: u16,
    rows: u16,
    on_data: DataFn,
    on_exit: ExitFn,
) -> io::Result<sys::Pty> {
    let api = sys::ConptyApi::shared()?;
    let opts = sys::SpawnOptions {
        file: launch.file.clone(),
        args: launch.args.clone(),
        cwd: Some(cwd.to_path_buf()),
        env: Some(env),
        cols,
        rows,
        flags: 0,
        job: true,
    };
    sys::Pty::spawn(api, &opts, on_data, Box::new(move |code: u32| on_exit(i64::from(code))))
}

#[cfg(unix)]
fn spawn_sys(
    launch: &Launch,
    cwd: &std::path::Path,
    env: Vec<(String, String)>,
    cols: u16,
    rows: u16,
    on_data: DataFn,
    on_exit: ExitFn,
) -> io::Result<sys::Pty> {
    let opts = sys::SpawnOptions {
        file: launch.file.clone(),
        args: launch.args.clone(),
        cwd: Some(cwd.to_path_buf()),
        env: Some(env),
        cols,
        rows,
    };
    sys::Pty::spawn(&opts, on_data, Box::new(move |code: i32| on_exit(i64::from(code))))
}
