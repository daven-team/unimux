#![allow(dead_code)]
//! Shared helpers of the ConPTY tests: the bundled conpty.dll (committed under src-tauri/resources/conpty/x64), output
//! collection, process trees.

use std::path::PathBuf;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use unimux_pty::conpty::{ConptyApi, ConptySource, Pty, PtyWriter, SpawnOptions};

/// xterm.js's answer to DA1 (`CSI c`). OpenConsole 1.23 asks at start and waits up to about 3 s for it, so a test terminal
/// answers like the renderer does.
pub const DA1_REPLY: &[u8] = b"\x1b[?1;2c";

/// The folder with conpty.dll + OpenConsole.exe 1.23 x64: UNIMUX_CONPTY_DIR, else the committed src-tauri/resources/conpty/x64.
pub fn bundled_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("UNIMUX_CONPTY_DIR") {
        return Some(PathBuf::from(dir));
    }
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../resources/conpty/x64");
    dir.join("conpty.dll").is_file().then_some(dir)
}

/// The bundled API (the tests are about it); panics when the files are missing so CI cannot silently test kernel32 only.
pub fn bundled() -> &'static ConptyApi {
    static API: OnceLock<ConptyApi> = OnceLock::new();
    API.get_or_init(|| {
        let dir = bundled_dir().expect("conpty.dll 1.23 not found (npm ci, or set UNIMUX_CONPTY_DIR)");
        let api = ConptyApi::load(Some(&dir)).expect("load conpty.dll");
        assert!(matches!(api.source, ConptySource::Bundled(_)));
        api
    })
}

pub fn inbox() -> &'static ConptyApi {
    static API: OnceLock<ConptyApi> = OnceLock::new();
    API.get_or_init(|| ConptyApi::load(None).expect("kernel32 ConPTY"))
}

/// Everything a terminal printed, and its exit.
#[derive(Default)]
pub struct Output {
    pub bytes: Vec<u8>,
    pub exit: Option<u32>,
    /// Output length when the exit was reported (must be the full output).
    pub at_exit: usize,
}

#[derive(Clone, Default)]
pub struct Collector(
    pub Arc<(Mutex<Output>, Condvar)>,
    pub Arc<Mutex<Option<PtyWriter>>>,
    pub Arc<std::sync::atomic::AtomicBool>,
);

impl Collector {
    /// A collector that does NOT answer DA1 (to measure the start delay without a terminal).
    pub fn mute() -> Self {
        let c = Self::default();
        c.2.store(true, std::sync::atomic::Ordering::SeqCst);
        c
    }

    fn answer_da1(&self) {
        if self.2.load(std::sync::atomic::Ordering::SeqCst) {
            return;
        }
        let asked = self.0.0.lock().bytes.windows(3).any(|w| w == b"\x1b[c");
        if asked
            && let Some(w) = self.1.lock().as_ref()
            && !self.2.swap(true, std::sync::atomic::Ordering::SeqCst)
        {
            w.write(DA1_REPLY);
        }
    }

    pub fn spawn(&self, api: &'static ConptyApi, opts: &SpawnOptions) -> Pty {
        let (a, b) = (self.clone(), self.clone());
        let pty = Pty::spawn(
            api,
            opts,
            Box::new(move |d| {
                a.0.0.lock().bytes.extend_from_slice(d);
                a.0.1.notify_all();
                a.answer_da1();
            }),
            Box::new(move |code| {
                let mut o = b.0.0.lock();
                o.exit = Some(code);
                o.at_exit = o.bytes.len();
                b.0.1.notify_all();
            }),
        )
        .expect("spawn");
        *self.1.lock() = pty.writer();
        self.answer_da1();
        pty
    }

    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.0.0.lock().bytes).into_owned()
    }

    pub fn len(&self) -> usize {
        self.0.0.lock().bytes.len()
    }

    /// Waits until `pred(output)` holds; false on timeout.
    pub fn wait(&self, timeout: Duration, mut pred: impl FnMut(&Output) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        let mut o = self.0.0.lock();
        while !pred(&o) {
            if self.0.1.wait_until(&mut o, deadline).timed_out() {
                return pred(&o);
            }
        }
        true
    }

    pub fn wait_text(&self, timeout: Duration, needle: &str) -> bool {
        self.wait(timeout, |o| String::from_utf8_lossy(&o.bytes).contains(needle))
    }

    pub fn wait_exit(&self, timeout: Duration) -> Option<u32> {
        self.wait(timeout, |o| o.exit.is_some());
        self.0.0.lock().exit
    }
}

pub fn cmd(args: &[&str]) -> SpawnOptions {
    let mut o = SpawnOptions::new("cmd.exe", args);
    o.cols = 120;
    o.rows = 30;
    o
}

/// Child process ids of `pid` (one level), from a ToolHelp snapshot.
pub fn children(pid: u32) -> Vec<u32> {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    let mut out = Vec::new();
    // SAFETY: the documented snapshot walk; the handle is closed.
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return out };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                if e.th32ParentProcessID == pid {
                    out.push(e.th32ProcessID);
                }
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    out
}

/// `pid` and all its descendants.
pub fn tree(pid: u32) -> Vec<u32> {
    let mut all = vec![pid];
    let mut i = 0;
    while i < all.len() {
        for c in children(all[i]) {
            if !all.contains(&c) {
                all.push(c);
            }
        }
        i += 1;
    }
    all
}

pub fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    let i = ((sorted.len() as f64 - 1.0) * p).round() as usize;
    sorted[i.min(sorted.len() - 1)]
}

/// Running processes with this image name (leak checks).
pub fn count_processes(name: &str) -> usize {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    let mut n = 0;
    // SAFETY: the documented snapshot walk; the handle is closed.
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else { return 0 };
        let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
        if Process32FirstW(snap, &mut e).is_ok() {
            loop {
                let len = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
                if String::from_utf16_lossy(&e.szExeFile[..len]).eq_ignore_ascii_case(name) {
                    n += 1;
                }
                if Process32NextW(snap, &mut e).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    n
}
