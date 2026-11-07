//! The `pty.*` ops: the surface of src/ptyhost/manager.ts's PtyManager that test/ptyhost.int.test.ts drives (spawn, write,
//! resize, has, histories, kill, killAll), over the Rust pty layer.
//!
//! Windows runs on `unimux_pty::conpty` (SP5, the base of P1: bundled conpty.dll 1.23 + OpenConsole, Job Object, node-pty's
//! kill order). Until P1 / P2 land their production manager, output engine and Unix backend, the bookkeeping here (entry
//! per id with a generation, exit reported once the output ended, the 150 ms typed startup command, a 512 Ki character
//! replay tail) and the Unix backend (`unix.rs`: openpty, setsid, TIOCSCTTY, killpg) are a stand-in with 1.1.4's rules;
//! P1 / P2 switch this module to their manager and the same suite then checks their code.
//!
//! Events: `pty.data {id, data}` (UTF-8 decoded like node-pty's onData) and `pty.exit {id, code}` (only for a terminal that
//! ended by itself; a killed one is gone without an exit, as in PtyManager).

#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod win;

use std::collections::HashMap;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use serde_json::{Value, json};

use crate::protocol::{Args, Out, Reply};
use crate::utf8::Utf8Stream;

/// PTY_REPLAY_CHARS (src/shared/terminalLimits.ts): the replay tail keeps the newest 512 Ki UTF-16 code units.
const REPLAY_UNITS: usize = 512 * 1024;
/// PtyManager types the startup command this long after the first output (the shell finishes drawing its prompt).
const COMMAND_DELAY: Duration = Duration::from_millis(150);
/// PtyManager.kill / killAll default bound.
const KILL_TIMEOUT: Duration = Duration::from_millis(3000);

/// What to start (after resolveShell).
pub struct Launch {
    pub file: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

pub type DataFn = Box<dyn FnMut(&[u8]) + Send>;
pub type ExitFn = Box<dyn FnOnce(u32) + Send>;

/// One running pseudo-terminal of a backend.
pub trait Term: Send + Sync {
    fn pid(&self) -> u32;
    /// Queues input (never blocks).
    fn write(&self, data: &[u8]);
    fn resize(&self, cols: u16, rows: u16);
    /// node-pty's kill (the shell, and on Windows the job's tree); the exit follows once the output ended.
    fn kill(&self);
    /// Ends the whole process tree at once (PtyManager.killAll's treeKill for terminals still running at the deadline).
    fn kill_tree(&self);
    /// Where the pty implementation came from (`bundled:<dir>`, `inbox`, `openpty`).
    fn source(&self) -> String;
}

fn spawn_term(launch: &Launch, on_data: DataFn, on_exit: ExitFn) -> io::Result<Arc<dyn Term>> {
    #[cfg(windows)]
    {
        win::spawn(launch, on_data, on_exit)
    }
    #[cfg(unix)]
    {
        unix::spawn(launch, on_data, on_exit)
    }
}

/// resolveShell of src/ptyhost/manager.ts.
pub fn resolve_shell(kind: &str, env: &[(String, String)], platform: &str) -> (String, Vec<String>) {
    if platform != "win32" {
        let shell = if kind == "bash" || (platform != "darwin" && kind != "zsh") { "bash" } else { "zsh" };
        return (format!("/bin/{shell}"), vec!["-il".into()]);
    }
    if kind == "cmd" {
        return ("cmd.exe".into(), vec![]);
    }
    let get = |name: &str| env.iter().find(|(k, _)| k == name).map(|(_, v)| v.as_str());
    let find_on_path = |exe: &str| -> Option<String> {
        let path = get("PATH").or_else(|| get("Path")).unwrap_or("");
        path.split(';').filter(|d| !d.is_empty()).map(|d| PathBuf::from(d).join(exe)).find(|p| p.exists()).map(|p| {
            // Node's path.join normalizes separators to backslashes.
            p.to_string_lossy().replace('/', "\\")
        })
    };
    if kind == "pwsh"
        && let Some(pwsh) = find_on_path("pwsh.exe")
    {
        return (pwsh, vec!["-NoLogo".into()]);
    }
    let system_root = get("SystemRoot").or_else(|| get("SYSTEMROOT")).unwrap_or("C:\\Windows");
    let fallback = PathBuf::from(system_root).join("System32").join("WindowsPowerShell").join("v1.0").join("powershell.exe");
    let file = find_on_path("powershell.exe")
        .or_else(|| fallback.exists().then(|| fallback.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "powershell.exe".into());
    (file, vec!["-NoLogo".into()])
}

pub fn platform() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/// The newest REPLAY_UNITS UTF-16 code units of a stream (TailBuffer's result, without its chunking).
#[derive(Default)]
struct Tail {
    text: String,
    units: usize,
}

impl Tail {
    fn push(&mut self, data: &str) {
        self.text.push_str(data);
        self.units += data.encode_utf16().count();
        if self.units > REPLAY_UNITS * 2 {
            self.trim();
        }
    }

    fn trim(&mut self) {
        let mut drop_units = self.units.saturating_sub(REPLAY_UNITS);
        let mut cut = 0;
        for (i, c) in self.text.char_indices() {
            if drop_units == 0 {
                cut = i;
                break;
            }
            let n = c.len_utf16();
            // JS slice(-limit) may cut a surrogate pair in half; keeping the whole character is the closest a String gets.
            drop_units = drop_units.saturating_sub(n);
            cut = i + c.len_utf8();
        }
        self.text.drain(..cut);
        self.units = self.text.encode_utf16().count();
    }

    fn replay(&mut self) -> String {
        if self.units > REPLAY_UNITS {
            self.trim();
        }
        self.text.clone()
    }
}

/// Set once a terminal's exit was reported (or it was killed and its process ended).
#[derive(Default)]
struct Exited {
    done: Mutex<bool>,
    cv: Condvar,
}

impl Exited {
    fn set(&self) {
        *self.done.lock() = true;
        self.cv.notify_all();
    }

    fn wait_until(&self, deadline: Instant) -> bool {
        let mut done = self.done.lock();
        while !*done {
            if self.cv.wait_until(&mut done, deadline).timed_out() {
                return *done;
            }
        }
        true
    }
}

type Slot = Arc<Mutex<Option<Arc<dyn Term>>>>;

struct Entry {
    generation: u64,
    /// Filled right after the backend started the terminal (the entry exists before, so no early output is lost).
    term: Slot,
    tail: Arc<Mutex<Tail>>,
    exited: Arc<Exited>,
}

impl Entry {
    fn term(&self) -> Option<Arc<dyn Term>> {
        self.term.lock().clone()
    }
}

#[derive(Default)]
struct Inner {
    entries: HashMap<String, Entry>,
    /// Terminals whose process has not ended yet, killed ones included (PtyManager.running).
    running: HashMap<u64, (Arc<dyn Term>, Arc<Exited>)>,
}

#[derive(Clone)]
pub struct PtyHost {
    inner: Arc<Mutex<Inner>>,
    next: Arc<AtomicU64>,
    out: Out,
}

impl PtyHost {
    pub fn new(out: Out) -> Self {
        Self { inner: Arc::default(), next: Arc::new(AtomicU64::new(1)), out }
    }

    pub fn handle(&self, op: &str, args: &Value, reply: Reply) {
        let a = Args(args);
        match op {
            "spawn" => reply.send(self.spawn(&a)),
            "write" => reply.send(a.str("id").and_then(|id| {
                let data = a.str("data")?;
                if let Some(term) = self.inner.lock().entries.get(id).and_then(Entry::term) {
                    term.write(data.as_bytes());
                }
                Ok(Value::Null)
            })),
            "resize" => reply.send(a.str("id").and_then(|id| {
                let (cols, rows) = (a.num("cols")?, a.num("rows")?);
                if let Some(term) = self.inner.lock().entries.get(id).and_then(Entry::term) {
                    term.resize(clamp_size(cols, 2), clamp_size(rows, 1));
                }
                Ok(Value::Null)
            })),
            "has" => reply.send(a.str("id").map(|id| json!(self.inner.lock().entries.contains_key(id)))),
            "histories" => reply.ok(self.histories()),
            "kill" => match a.str("id") {
                Ok(id) => self.kill(id.to_string(), timeout_of(&a), reply),
                Err(e) => reply.err(e),
            },
            "killAll" => self.kill_all(timeout_of(&a), reply),
            "resolveShell" => reply.send(a.str("shell").and_then(|kind| {
                let env = a.str_map("env")?;
                let (file, args) = resolve_shell(kind, &env, a.opt_str("platform").unwrap_or(platform()));
                Ok(json!({ "file": file, "args": args }))
            })),
            other => reply.err(format!("unknown op pty.{other}")),
        }
    }

    fn spawn(&self, a: &Args) -> Result<Value, String> {
        let id = a.str("id")?.to_string();
        let shell = a.str("shell")?;
        let mut env = a.str_map("env")?;
        let (file, args) = resolve_shell(shell, &env, platform());
        // PtyManager's env: the request's env plus TERM / COLORTERM / TERM_PROGRAM (later keys win, as in the object spread).
        for (k, v) in [("TERM", "xterm-256color"), ("COLORTERM", "truecolor"), ("TERM_PROGRAM", "unimux")] {
            env.retain(|(key, _)| key != k);
            env.push((k.into(), v.into()));
        }
        let launch = Launch {
            file,
            args,
            cwd: a.opt_str("cwd").map(PathBuf::from),
            env,
            cols: clamp_size(a.num("cols")?, 2),
            rows: clamp_size(a.num("rows")?, 1),
        };
        let command = a.opt_str("command").filter(|c| !c.is_empty()).map(str::to_string);

        // An id that is still running is killed first (PtyManager.spawn).
        if self.inner.lock().entries.contains_key(&id) {
            self.kill(id.clone(), KILL_TIMEOUT, Reply::discard());
        }

        let generation = self.next.fetch_add(1, Ordering::SeqCst);
        let tail = Arc::new(Mutex::new(Tail::default()));
        let exited = Arc::new(Exited::default());
        let term_slot: Slot = Arc::default();
        let da1 = Arc::new(Da1::default());

        let decoder: Arc<Mutex<Utf8Stream>> = Arc::default();
        let on_data: DataFn = {
            let (host, id, tail, slot, da1) = (self.clone(), id.clone(), tail.clone(), term_slot.clone(), da1.clone());
            let decoder = decoder.clone();
            let mut command = command;
            Box::new(move |bytes: &[u8]| {
                if crate::protocol::trace() {
                    eprintln!("pty {id}: {} bytes {:?}", bytes.len(), String::from_utf8_lossy(bytes));
                }
                da1.scan(bytes, &slot);
                let text = decoder.lock().push(bytes);
                if !host.is_current(&id, generation) {
                    return;
                }
                if !text.is_empty() {
                    tail.lock().push(&text);
                    host.out.event("pty.data", json!({ "id": id, "data": text }));
                }
                if let Some(cmd) = command.take() {
                    let (host, id, slot) = (host.clone(), id.clone(), slot.clone());
                    std::thread::spawn(move || {
                        std::thread::sleep(COMMAND_DELAY);
                        if host.is_current(&id, generation)
                            && let Some(term) = slot.lock().as_ref()
                        {
                            term.write(format!("{cmd}\r").as_bytes());
                        }
                    });
                }
            })
        };
        let on_exit: ExitFn = {
            let (host, id, exited, tail) = (self.clone(), id.clone(), exited.clone(), tail.clone());
            Box::new(move |code: u32| {
                // An incomplete UTF-8 sequence at the very end of the output (the decoder's U+FFFD).
                let rest = decoder.lock().finish();
                if !rest.is_empty() && host.is_current(&id, generation) {
                    tail.lock().push(&rest);
                    host.out.event("pty.data", json!({ "id": id, "data": rest }));
                }
                let reported = {
                    let mut inner = host.inner.lock();
                    inner.running.remove(&generation);
                    // Under the lock: spawn checks it before it records the terminal as running.
                    exited.set();
                    if inner.entries.get(&id).is_some_and(|e| e.generation == generation) {
                        inner.entries.remove(&id);
                        true
                    } else {
                        false
                    }
                };
                if reported {
                    host.out.event("pty.exit", json!({ "id": id, "code": code }));
                }
            })
        };

        self.inner.lock().entries.insert(id.clone(), Entry { generation, term: term_slot.clone(), tail, exited: exited.clone() });
        let term = match spawn_term(&launch, on_data, on_exit) {
            Ok(term) => term,
            Err(e) => {
                let mut inner = self.inner.lock();
                if inner.entries.get(&id).is_some_and(|e| e.generation == generation) {
                    inner.entries.remove(&id);
                }
                return Err(format!("spawn {}: {e}", launch.file));
            }
        };
        let pid = term.pid();
        *term_slot.lock() = Some(term.clone());
        {
            let mut inner = self.inner.lock();
            // The exit may already have been reported (a program that ended at once); it is not running then.
            if !*exited.done.lock() {
                inner.running.insert(generation, (term.clone(), exited.clone()));
            }
        }
        da1.answer_if_asked(&term_slot);
        Ok(json!({ "pid": pid, "source": term.source() }))
    }

    fn is_current(&self, id: &str, generation: u64) -> bool {
        self.inner.lock().entries.get(id).is_some_and(|e| e.generation == generation)
    }

    fn histories(&self) -> Value {
        let inner = self.inner.lock();
        // Map order of PtyManager: oldest spawn first.
        let mut list: Vec<(&String, &Entry)> = inner.entries.iter().collect();
        list.sort_by_key(|(_, e)| e.generation);
        Value::Array(list.into_iter().map(|(id, e)| json!({ "id": id, "data": e.tail.lock().replay() })).collect())
    }

    /// PtyManager.kill: the entry goes at once (no exit event), the answer comes once the process ended or after `timeout`.
    fn kill(&self, id: String, timeout: Duration, reply: Reply) {
        let Some(entry) = self.inner.lock().entries.remove(&id) else {
            reply.ok(Value::Null);
            return;
        };
        std::thread::spawn(move || {
            if let Some(term) = entry.term() {
                term.kill();
            }
            entry.exited.wait_until(Instant::now() + timeout);
            reply.ok(Value::Null);
        });
    }

    /// PtyManager.killAll: kills every terminal, waits (bounded), then ends the tree of every one still running.
    fn kill_all(&self, timeout: Duration, reply: Reply) {
        let entries: Vec<Entry> = self.inner.lock().entries.drain().map(|(_, e)| e).collect();
        let host = self.clone();
        std::thread::spawn(move || {
            let deadline = Instant::now() + timeout;
            for term in entries.iter().filter_map(Entry::term) {
                term.kill();
            }
            for e in &entries {
                e.exited.wait_until(deadline);
            }
            host.kill_running_trees();
            reply.ok(Value::Null);
        });
    }

    fn kill_running_trees(&self) {
        let running: Vec<Arc<dyn Term>> = self.inner.lock().running.values().map(|(t, _)| t.clone()).collect();
        for term in running {
            term.kill_tree();
        }
    }

    /// stdin closed (the test process is gone): nothing it started may outlive it.
    pub fn shutdown(&self, timeout: Duration) {
        let entries: Vec<Entry> = self.inner.lock().entries.drain().map(|(_, e)| e).collect();
        for term in entries.iter().filter_map(Entry::term) {
            term.kill();
        }
        let deadline = Instant::now() + timeout;
        let waits: Vec<Arc<Exited>> = self.inner.lock().running.values().map(|(_, x)| x.clone()).collect();
        for x in waits {
            x.wait_until(deadline);
        }
        self.kill_running_trees();
    }
}

fn clamp_size(v: f64, min: u16) -> u16 {
    if v.is_nan() { min } else { v.clamp(min as f64, u16::MAX as f64) as u16 }
}

fn timeout_of(a: &Args) -> Duration {
    a.opt_num("timeoutMs").filter(|t| t.is_finite() && *t >= 0.0).map(|t| Duration::from_millis(t as u64)).unwrap_or(KILL_TIMEOUT)
}

/// OpenConsole 1.23 asks a new terminal for its device attributes (`ESC [ c`) and holds the output up to about 3 s for
/// the answer, which xterm.js gives in the app. With no renderer the host answers like xterm.js (P2 does the same while no
/// renderer is attached). Only the start of the output is looked at.
#[derive(Default)]
struct Da1 {
    seen: Mutex<Vec<u8>>,
    asked: AtomicBool,
    answered: AtomicBool,
}

impl Da1 {
    const SCAN: usize = 4096;
    const REPLY: &'static [u8] = b"\x1b[?1;2c";

    fn scan(&self, bytes: &[u8], slot: &Slot) {
        if !cfg!(windows) || self.asked.load(Ordering::SeqCst) {
            return;
        }
        {
            let mut seen = self.seen.lock();
            if seen.len() >= Self::SCAN {
                return;
            }
            seen.extend_from_slice(&bytes[..bytes.len().min(Self::SCAN)]);
            if !seen.windows(3).any(|w| w == b"\x1b[c") {
                return;
            }
        }
        self.asked.store(true, Ordering::SeqCst);
        self.answer_if_asked(slot);
    }

    fn answer_if_asked(&self, slot: &Slot) {
        if !self.asked.load(Ordering::SeqCst) {
            return;
        }
        if let Some(term) = slot.lock().as_ref()
            && !self.answered.swap(true, Ordering::SeqCst)
        {
            if crate::protocol::trace() {
                eprintln!("pty: DA1 answered");
            }
            term.write(Self::REPLY);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn resolve_shell_unix_rules() {
        let e = env(&[]);
        assert_eq!(resolve_shell("bash", &e, "darwin"), ("/bin/bash".into(), vec!["-il".into()]));
        assert_eq!(resolve_shell("zsh", &e, "darwin"), ("/bin/zsh".into(), vec!["-il".into()]));
        assert_eq!(resolve_shell("pwsh", &e, "darwin"), ("/bin/zsh".into(), vec!["-il".into()]));
        assert_eq!(resolve_shell("zsh", &e, "linux"), ("/bin/zsh".into(), vec!["-il".into()]));
        assert_eq!(resolve_shell("pwsh", &e, "linux"), ("/bin/bash".into(), vec!["-il".into()]));
    }

    #[test]
    fn resolve_shell_windows_rules() {
        let dir = std::env::temp_dir().join(format!("unimux-hostd-shell-{}", std::process::id()));
        let bin = dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("pwsh.exe"), b"").unwrap();
        let path = bin.to_string_lossy().into_owned();
        let e = env(&[("PATH", &path), ("SystemRoot", "Z:\\NoWindows")]);
        assert_eq!(resolve_shell("cmd", &e, "win32"), ("cmd.exe".into(), vec![]));
        let (file, args) = resolve_shell("pwsh", &e, "win32");
        assert_eq!(file, bin.join("pwsh.exe").to_string_lossy().replace('/', "\\"));
        assert_eq!(args, vec!["-NoLogo".to_string()]);
        // powershell: neither on PATH nor under SystemRoot -> the bare name
        assert_eq!(resolve_shell("powershell", &e, "win32"), ("powershell.exe".into(), vec!["-NoLogo".into()]));
        // Path (Windows spelling) is used when PATH is missing
        let e2 = env(&[("Path", &path)]);
        assert_eq!(resolve_shell("pwsh", &e2, "win32").0, file);
        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn tail_keeps_the_newest_units() {
        let mut t = Tail::default();
        let chunk = "x".repeat(100_000);
        for _ in 0..20 {
            t.push(&chunk);
        }
        t.push("END");
        let r = t.replay();
        assert_eq!(r.encode_utf16().count(), REPLAY_UNITS);
        assert!(r.ends_with("xEND"));
        let mut t = Tail::default();
        t.push("short");
        assert_eq!(t.replay(), "short");
    }

    #[test]
    fn sizes_are_clamped_like_math_max() {
        assert_eq!(clamp_size(0.0, 2), 2);
        assert_eq!(clamp_size(80.0, 2), 80);
        assert_eq!(clamp_size(f64::NAN, 1), 1);
        assert_eq!(clamp_size(1e9, 1), u16::MAX);
    }
}
