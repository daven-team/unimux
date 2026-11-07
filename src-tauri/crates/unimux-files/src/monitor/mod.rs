//! The Monitor panel's data (1.0.6, src/main/monitor.ts). Nothing runs on its own: the panel asks for a sample every 2 s while
//! it is on screen, and a sample takes one system-wide process snapshot. 1.1.4 kept a resident PowerShell helper for that
//! (NtQuerySystemInformation through Add-Type, about 7 ms per answer) and ran `ps` on macOS; 1.2.0 calls the system directly:
//! NtQuerySystemInformation(SystemProcessInformation) on Windows, libproc on macOS. No helper process exists any more, so the
//! 15 s idle stop of 1.1.4 has nothing to stop.

#[cfg(target_os = "macos")]
pub mod mac;
pub mod model;
pub mod webview;
#[cfg(windows)]
pub mod win;

use std::sync::Arc;
use std::time::Instant;

use parking_lot::{Mutex, RwLock};
use serde_json::Value;

pub use model::{AppProcInfo, MonitorSample, RawProc};
use model::{CpuMemo, MonitorInput, build_monitor, cpu_memo, cpu_percents, killable_pid};

/// A pause longer than a few ticks (the panel was closed) starts the CPU arithmetic over (monitor.ts: 10 s).
const MEMO_FRESH_MS: f64 = 10_000.0;

/// One system snapshot per call.
pub trait ProcessSource: Send + Sync {
    fn snapshot(&self) -> Result<Vec<RawProc>, String>;
}

/// The real snapshot of this OS.
pub struct SystemProcesses {
    #[cfg(windows)]
    buffer: Mutex<win::SnapshotBuffer>,
}

impl SystemProcesses {
    pub fn new() -> Self {
        Self {
            #[cfg(windows)]
            buffer: Mutex::new(win::SnapshotBuffer::default()),
        }
    }
}

impl Default for SystemProcesses {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcessSource for SystemProcesses {
    fn snapshot(&self) -> Result<Vec<RawProc>, String> {
        #[cfg(windows)]
        {
            self.buffer.lock().snapshot()
        }
        #[cfg(target_os = "macos")]
        {
            mac::snapshot()
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            Err("no process snapshot on this platform".into())
        }
    }
}

/// The logical processors as Node's `os.cpus().length` counts them (libuv: GetSystemInfo's processor count on Windows).
pub fn logical_cores() -> u32 {
    #[cfg(windows)]
    {
        win::logical_cores()
    }
    #[cfg(not(windows))]
    {
        std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1)
    }
}

/// Ends a process the way Node's `process.kill(pid)` does: TerminateProcess with exit code 1 on Windows, SIGTERM on Unix.
pub fn kill_process(pid: u32) -> bool {
    #[cfg(windows)]
    {
        win::terminate(pid)
    }
    #[cfg(unix)]
    {
        i32::try_from(pid).is_ok_and(|pid| {
            // SAFETY: a plain signal to a pid.
            unsafe { libc::kill(pid, libc::SIGTERM) == 0 }
        })
    }
    #[cfg(not(any(windows, unix)))]
    {
        let _ = pid;
        false
    }
}

/// The app's own processes for a snapshot (the `main` process first, then WebView2 / WebKit processes by kind).
pub type AppProcs = Arc<dyn Fn(&[RawProc]) -> Vec<AppProcInfo> + Send + Sync>;
/// The pty shell of each running cell (`cellId`, pid).
pub type Cells = Arc<dyn Fn() -> Vec<(String, u32)> + Send + Sync>;
pub type Kill = Arc<dyn Fn(u32) -> bool + Send + Sync>;

/// `Monitor` of monitor.ts. Every method blocks (one snapshot); the commands run them on the blocking pool.
pub struct Monitor {
    source: Box<dyn ProcessSource>,
    app_procs: AppProcs,
    cells: RwLock<Cells>,
    kill: Kill,
    cores: u32,
    main_pid: u32,
    /// The previous snapshot (CPU arithmetic) and when it was taken, by the clock of `started`.
    memo: Mutex<Option<(CpuMemo, f64)>>,
    /// One snapshot at a time (monitor.ts queued them).
    taking: Mutex<()>,
    started: Instant,
}

impl Monitor {
    pub fn new(source: Box<dyn ProcessSource>, main_pid: u32, app_procs: AppProcs, kill: Kill) -> Self {
        Self {
            source,
            app_procs,
            cells: RwLock::new(Arc::new(Vec::new)),
            kill,
            cores: logical_cores().max(1),
            main_pid,
            memo: Mutex::new(None),
            taking: Mutex::new(()),
            started: Instant::now(),
        }
    }

    /// The real monitor of this process: system snapshots, `process.kill` semantics.
    pub fn system(app_procs: AppProcs) -> Self {
        Self::new(Box::new(SystemProcesses::new()), std::process::id(), app_procs, Arc::new(kill_process))
    }

    /// Where the running cells come from (the pty service sets it; until then no cell runs).
    pub fn set_cells(&self, cells: Cells) {
        *self.cells.write() = cells;
    }

    pub fn main_pid(&self) -> u32 {
        self.main_pid
    }

    pub fn cores(&self) -> u32 {
        self.cores
    }

    fn now_ms(&self) -> f64 {
        self.started.elapsed().as_secs_f64() * 1000.0
    }

    fn take(&self) -> Result<Vec<RawProc>, String> {
        let _one = self.taking.lock();
        self.source.snapshot()
    }

    /// `sample()`: one snapshot with the CPU since the previous one; `ok: false` when the snapshot failed.
    pub fn sample(&self) -> MonitorSample {
        let t0 = self.now_ms();
        let procs = match self.take() {
            Ok(procs) => procs,
            Err(_) => return MonitorSample::failed(self.cores, (self.now_ms() - t0).round()),
        };
        let now = self.now_ms();
        let cpu = {
            let mut memo = self.memo.lock();
            let prev = memo.as_ref().filter(|(_, at)| now - at < MEMO_FRESH_MS);
            let wall = prev.map(|(_, at)| now - at).unwrap_or(now);
            let cpu = cpu_percents(&procs, prev.map(|(m, _)| m), wall, self.cores);
            *memo = Some((cpu_memo(&procs), now));
            cpu
        };
        let app = (self.app_procs)(&procs);
        let cells = (self.cells.read())();
        let query_ms = (self.now_ms() - t0).round();
        let console_parent = Some(self.main_pid);
        build_monitor(&MonitorInput {
            procs: &procs,
            cpu: &cpu,
            cores: self.cores,
            app: &app,
            cells: &cells,
            console_parent,
            query_ms,
        })
    }

    /// `kill(pid)`: ends one process of a cell's tree; anything else (the app, a WebView2 process, a console host, a pid that
    /// is no longer ours, a value that is not a positive safe integer) is refused.
    pub fn kill(&self, pid: &Value) -> bool {
        let Some(pid) = pid.as_f64().filter(|p| p.fract() == 0.0 && *p > 0.0 && *p <= 9_007_199_254_740_991.0) else {
            return false;
        };
        let Ok(pid) = u32::try_from(pid as u64) else { return false };
        let Ok(procs) = self.take() else { return false };
        // The cell trees do not depend on the app's process kinds: the main process alone roots the console hosts.
        let app = [AppProcInfo::new(self.main_pid, "main", None)];
        let cells = (self.cells.read())();
        let cpu = Default::default();
        let console_parent = Some(self.main_pid);
        let input =
            MonitorInput { procs: &procs, cpu: &cpu, cores: self.cores, app: &app, cells: &cells, console_parent, query_ms: 0.0 };
        let fresh = build_monitor(&input);
        killable_pid(&fresh, pid) && (self.kill)(pid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Fixed(Vec<RawProc>);
    impl ProcessSource for Fixed {
        fn snapshot(&self) -> Result<Vec<RawProc>, String> {
            Ok(self.0.clone())
        }
    }
    struct Broken;
    impl ProcessSource for Broken {
        fn snapshot(&self) -> Result<Vec<RawProc>, String> {
            Err("no".into())
        }
    }

    fn p(pid: u32, ppid: u32, name: &str, start: f64) -> RawProc {
        RawProc { pid, ppid, name: name.into(), start, cpu_ms: 0.0, mem: 1000.0 }
    }

    fn procs() -> Vec<RawProc> {
        vec![
            p(100, 1, "unimux.exe", 1.0),
            p(300, 100, "msedgewebview2.exe", 4.0),
            p(200, 100, "OpenConsole.exe", 10.0),
            p(201, 100, "cmd.exe", 11.0),
            p(202, 201, "node.exe", 12.0),
        ]
    }

    fn app_procs() -> AppProcs {
        Arc::new(|_: &[RawProc]| vec![AppProcInfo::new(100, "main", None), AppProcInfo::new(300, "webview", None)])
    }

    #[test]
    fn names_the_webview_processes_by_kind_and_matches_the_console_hosts_to_the_cells() {
        let monitor = Monitor::new(Box::new(Fixed(procs())), 100, app_procs(), Arc::new(|_| true));
        monitor.set_cells(Arc::new(|| vec![("c".to_string(), 201)]));
        let sample = monitor.sample();
        assert!(sample.ok);
        assert_eq!(sample.app.iter().find(|a| a.pid == 300).unwrap().kind, "webview");
        assert_eq!(sample.cells[0].rows.iter().map(|r| r.pid).collect::<Vec<_>>(), [201, 202, 200]);
        // A second sample has a previous snapshot to compare with.
        assert!(monitor.memo.lock().is_some());
        assert!(monitor.sample().ok);
    }

    #[test]
    fn kills_only_processes_of_a_cell_tree() {
        let killed = Arc::new(Mutex::new(Vec::new()));
        let k = killed.clone();
        let monitor = Monitor::new(
            Box::new(Fixed(procs())),
            100,
            app_procs(),
            Arc::new(move |pid| {
                k.lock().push(pid);
                true
            }),
        );
        monitor.set_cells(Arc::new(|| vec![("c".to_string(), 201)]));
        assert!(monitor.kill(&json!(202)));
        assert!(!monitor.kill(&json!(100)));
        assert!(!monitor.kill(&json!(300)));
        assert!(!monitor.kill(&json!(200)));
        assert!(!monitor.kill(&json!("202")));
        assert!(!monitor.kill(&json!(202.5)));
        assert!(!monitor.kill(&json!(-202)));
        assert!(!monitor.kill(&json!(0)));
        assert_eq!(*killed.lock(), vec![202]);
        // A kill that fails (the process is gone) answers false.
        let monitor = Monitor::new(Box::new(Fixed(procs())), 100, app_procs(), Arc::new(|_| false));
        monitor.set_cells(Arc::new(|| vec![("c".to_string(), 201)]));
        assert!(!monitor.kill(&json!(202)));
    }

    #[test]
    fn a_failed_snapshot_answers_ok_false() {
        let monitor = Monitor::new(Box::new(Broken), 100, app_procs(), Arc::new(|_| true));
        let sample = monitor.sample().to_json();
        assert_eq!(sample["ok"], false);
        assert_eq!(sample["app"], json!([]));
        assert_eq!(sample["cells"], json!([]));
        assert!(sample["cores"].as_u64().unwrap() >= 1);
        assert!(!monitor.kill(&json!(5)));
    }
}
