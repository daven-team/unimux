//! P1 acceptance (cargo half), on Windows (bundled ConPTY from src-tauri/resources/conpty/x64) and Unix (openpty): echo
//! round trip with the launch command, the terminal environment, a 50 MB flood paused and resumed, output after exit,
//! a dev server's tree killed, 30 parallel kills, kill_all of 30 terminals within 3 s, the pty-kill-tree cases of 1.1.4,
//! respawn under the same id, spawn errors and the supervised actor (crash kills the terminals, restart).

#[cfg(windows)]
mod common;

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use unimux_pty::actor::{self, PtyCommand};
use unimux_pty::manager::{KILL_TIMEOUT, PtyHandle, PtyManager, PtySink, SpawnRequest};
use unimux_pty::shell::{Launch, ShellKind};
use unimux_pty::supervisor::{CrashPolicy, SupervisorEvent};

/// xterm.js's answer to DA1; OpenConsole 1.23 holds a new terminal's output up to 3 s for it (the renderer answers it).
const DA1_REPLY: &[u8] = b"\x1b[?1;2c";

#[cfg(windows)]
fn init() {
    let dir = common::bundled_dir().expect("src-tauri/resources/conpty/x64");
    unimux_pty::conpty::ConptyApi::set_resource_dir(dir);
    let api = unimux_pty::conpty::ConptyApi::shared().expect("conpty");
    assert!(
        matches!(api.source, unimux_pty::conpty::ConptySource::Bundled(_)),
        "the manager must use the bundled conpty.dll, got {:?}",
        api.source
    );
}

#[cfg(unix)]
fn init() {}

fn alive(pid: u32) -> bool {
    #[cfg(windows)]
    return unimux_pty::conpty::Pty::process_alive(pid);
    #[cfg(unix)]
    return unimux_pty::unix::Pty::process_alive(pid);
}

/// `pid` and all its descendants.
#[cfg(windows)]
fn tree(pid: u32) -> Vec<u32> {
    common::tree(pid)
}

#[cfg(unix)]
fn tree(pid: u32) -> Vec<u32> {
    let parents: Vec<(u32, u32)> = if cfg!(target_os = "linux") {
        std::fs::read_dir("/proc")
            .unwrap()
            .filter_map(|e| {
                let p: u32 = e.ok()?.file_name().to_str()?.parse().ok()?;
                let stat = std::fs::read_to_string(format!("/proc/{p}/stat")).ok()?;
                let rest = &stat[stat.rfind(')')? + 2..];
                let ppid: u32 = rest.split(' ').nth(1)?.parse().ok()?;
                Some((p, ppid))
            })
            .collect()
    } else {
        let out = std::process::Command::new("ps").args(["-A", "-o", "pid=,ppid="]).output().unwrap();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter_map(|l| {
                let mut it = l.split_whitespace();
                Some((it.next()?.parse().ok()?, it.next()?.parse().ok()?))
            })
            .collect()
    };
    let mut all = vec![pid];
    let mut i = 0;
    while i < all.len() {
        for (p, pp) in &parents {
            if *pp == all[i] && !all.contains(p) {
                all.push(*p);
            }
        }
        i += 1;
    }
    all
}

#[derive(Default)]
struct Seen {
    out: HashMap<String, Vec<u8>>,
    first: HashMap<String, Instant>,
    /// Exits in order, with the output length at the moment of the exit.
    exits: Vec<(String, i64, usize)>,
    da1: HashMap<String, bool>,
}

#[derive(Default)]
struct Sink {
    seen: Mutex<Seen>,
    cv: Condvar,
    handle: Mutex<Option<PtyHandle>>,
    /// Panics on output containing this text (supervisor test).
    panic_on: Mutex<Option<String>>,
}

impl PtySink for Sink {
    fn data(&self, id: &str, data: &[u8]) {
        let answer = {
            let mut s = self.seen.lock();
            s.first.entry(id.to_string()).or_insert_with(Instant::now);
            let out = s.out.entry(id.to_string()).or_default();
            // Only the new bytes (and 2 before them) are searched: scanning the whole output per chunk is quadratic and
            // made the 50 MB flood crawl with Linux's 4 KiB pty reads.
            let from = out.len().saturating_sub(2);
            out.extend_from_slice(data);
            let asked = out[from..].windows(3).any(|w| w == b"\x1b[c");
            let answered = s.da1.entry(id.to_string()).or_default();
            let answer = asked && !*answered;
            *answered |= asked;
            answer
        };
        self.cv.notify_all();
        if answer && let Some(h) = self.handle.lock().as_ref() {
            h.write(id, DA1_REPLY);
        }
        if let Some(needle) = self.panic_on.lock().as_ref()
            && String::from_utf8_lossy(data).contains(needle.as_str())
        {
            panic!("sink panicked on {needle}");
        }
    }

    fn exit(&self, id: &str, code: i64) {
        let mut s = self.seen.lock();
        let len = s.out.get(id).map_or(0, Vec::len);
        s.exits.push((id.to_string(), code, len));
        self.cv.notify_all();
    }
}

impl Sink {
    fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn text(&self, id: &str) -> String {
        String::from_utf8_lossy(self.seen.lock().out.get(id).map_or(&[][..], |v| v.as_slice())).into_owned()
    }

    fn len(&self, id: &str) -> usize {
        self.seen.lock().out.get(id).map_or(0, Vec::len)
    }

    fn wait(&self, timeout: Duration, mut pred: impl FnMut(&Seen) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        let mut s = self.seen.lock();
        while !pred(&s) {
            if self.cv.wait_until(&mut s, deadline).timed_out() {
                return pred(&s);
            }
        }
        true
    }

    fn wait_text(&self, id: &str, timeout: Duration, needle: &str) -> bool {
        self.wait(timeout, |s| s.out.get(id).is_some_and(|o| String::from_utf8_lossy(o).contains(needle)))
    }

    fn wait_output(&self, id: &str, timeout: Duration) -> bool {
        self.wait(timeout, |s| s.out.get(id).is_some_and(|o| !o.is_empty()))
    }

    fn exit_of(&self, id: &str) -> Option<(i64, usize)> {
        self.seen.lock().exits.iter().find(|e| e.0 == id).map(|e| (e.1, e.2))
    }

    fn wait_exit(&self, id: &str, timeout: Duration) -> Option<(i64, usize)> {
        self.wait(timeout, |s| s.exits.iter().any(|e| e.0 == id));
        self.exit_of(id)
    }
}

fn manager(sink: &Arc<Sink>) -> PtyManager {
    init();
    let m = PtyManager::new(sink.clone());
    *sink.handle.lock() = Some(m.handle());
    m
}

fn process_env() -> Vec<(String, String)> {
    std::env::vars().collect()
}

fn scratch() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("unimux-p1-").tempdir().unwrap()
}

/// The quick interactive shell of the platform (cmd / bash).
fn quick_shell() -> ShellKind {
    if cfg!(windows) { ShellKind::Cmd } else { ShellKind::Bash }
}

fn req(id: &str, cwd: &std::path::Path, shell: ShellKind) -> SpawnRequest {
    let mut r = SpawnRequest::new(id, cwd, shell);
    r.cols = 120;
    r.rows = 30;
    r.env = process_env();
    r
}

/// A one-shot shell script (`cmd /d /c` / `/bin/sh -c`).
fn script(id: &str, cwd: &std::path::Path, windows: &str, unix: &str) -> SpawnRequest {
    let mut r = req(id, cwd, quick_shell());
    r.launch =
        Some(if cfg!(windows) { Launch::new("cmd.exe", &["/d", "/c", windows]) } else { Launch::new("/bin/sh", &["-c", unix]) });
    r
}

fn flood(id: &str, cwd: &std::path::Path, args: &[&str]) -> SpawnRequest {
    let mut r = req(id, cwd, quick_shell());
    r.launch = Some(Launch::new(env!("CARGO_BIN_EXE_unimux-pty-flood"), args));
    r
}

/// Spawns `n` quick shells and waits until each printed something (a prompt), plus a moment to settle.
fn shells(m: &PtyManager, sink: &Sink, cwd: &std::path::Path, prefix: &str, n: usize) -> Vec<(String, u32)> {
    let ids: Vec<(String, u32)> = (0..n)
        .map(|i| {
            let id = format!("{prefix}{i}");
            let pid = m.spawn(req(&id, cwd, quick_shell())).expect("spawn");
            (id, pid)
        })
        .collect();
    for (id, _) in &ids {
        assert!(sink.wait_output(id, Duration::from_secs(30)), "{id}: no output");
    }
    std::thread::sleep(Duration::from_millis(300));
    ids
}

#[test]
fn echo_round_trip_with_the_launch_command_typed_after_the_first_output() {
    let sink = Sink::new();
    let m = manager(&sink);
    let dir = scratch();
    let cwd = dir.path().join("p1-cwd-marker");
    std::fs::create_dir(&cwd).unwrap();
    // pwsh, or Windows PowerShell when pwsh is not on the PATH (1.1.4's resolveShell); bash on Unix.
    let mut r = req("a", &cwd, if cfg!(windows) { ShellKind::Pwsh } else { ShellKind::Bash });
    r.command = Some(
        if cfg!(windows) { "echo \"mc-$((1+1))-ok\"; (Get-Location).Path" } else { "printf \"mc-%s-ok\\n\" \"$((1+1))\"; pwd" }
            .into(),
    );
    let pid = m.spawn(r).unwrap();
    assert_eq!(m.pid("a"), Some(pid));
    assert!(sink.wait_text("a", Duration::from_secs(30), "mc-2-ok"), "{:?}", sink.text("a"));
    // The command went in no earlier than 150 ms after the first output.
    let first = sink.seen.lock().first["a"];
    let typed_after = first.elapsed();
    assert!(typed_after >= Duration::from_millis(150), "command result {} ms after the first output", typed_after.as_millis());
    assert!(sink.wait_text("a", Duration::from_secs(10), "p1-cwd-marker"), "cwd: {:?}", sink.text("a"));

    m.resize("a", 80, 20);
    let started = Instant::now();
    m.write("a", if cfg!(windows) { b"echo ('rt-' + (2+3))\r" } else { b"echo rt-$((2+3))\r" });
    assert!(sink.wait_text("a", Duration::from_secs(10), "rt-5"), "{:?}", sink.text("a"));
    println!("P1 echo round trip (write to echo in the sink): {:.1} ms", started.elapsed().as_secs_f64() * 1000.0);
    m.write("a", b"exit 3\r");
    assert_eq!(sink.wait_exit("a", Duration::from_secs(15)).map(|e| e.0), Some(3));
    assert!(!m.has("a"));
    assert_eq!(m.running(), 0);
}

#[test]
fn the_terminal_environment_reaches_the_shell() {
    let sink = Sink::new();
    let m = manager(&sink);
    let dir = scratch();
    let mut r = script("env", dir.path(), "set", "env");
    r.cols = 250;
    r.cell_id = Some("cell-p1-7".into());
    unimux_pty::shell::env_set(&mut r.env, "UNIMUX_P1_TEST", "yes");
    unimux_pty::shell::env_set(&mut r.env, "TERM", "dumb");
    m.spawn(r).unwrap();
    assert!(sink.wait_exit("env", Duration::from_secs(15)).is_some());
    let text = sink.text("env");
    for line in
        ["TERM=xterm-256color", "COLORTERM=truecolor", "TERM_PROGRAM=unimux", "MC_CELL_ID=cell-p1-7", "UNIMUX_P1_TEST=yes"]
    {
        assert!(text.contains(line), "{line} missing: {text:?}");
    }
    assert!(!text.contains("TERM=dumb"));
    #[cfg(unix)]
    assert!(text.contains(&format!("PWD={}", dir.path().display())), "PWD: {text:?}");
}

/// 50 MB by default (the acceptance item); `UNIMUX_P1_FLOOD_MB` changes it. The wait is on progress, not on a fixed time:
/// ConPTY's throughput depends on the machine's load (19 s idle, 45-250 KB/s at 100 percent CPU), so the test fails only
/// when no output arrives for 60 s.
#[test]
fn flood_of_50_mb_pauses_and_resumes() {
    let mb: u64 = std::env::var("UNIMUX_P1_FLOOD_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(50);
    let sink = Sink::new();
    let m = manager(&sink);
    let dir = scratch();
    let started = Instant::now();
    let pid = m.spawn(flood("f", dir.path(), &["0", "0", &(mb * 1_000_000).to_string()])).unwrap();
    assert!(sink.wait(Duration::from_secs(30), |s| s.out.get("f").is_some_and(|o| o.len() > 64 * 1024)), "no flood");
    m.set_paused("f", true);
    std::thread::sleep(Duration::from_millis(300));
    let paused_at = sink.len("f");
    std::thread::sleep(Duration::from_millis(1000));
    let after = sink.len("f");
    assert_eq!(after, paused_at, "output kept coming while paused");
    assert!(alive(pid), "the writer ended while the reader was paused (it should block)");
    assert!(sink.exit_of("f").is_none());
    m.set_paused("f", false);
    let (mut last_len, mut last_progress) = (after, Instant::now());
    let exit = loop {
        if let Some(exit) = sink.wait_exit("f", Duration::from_secs(1)) {
            break Some(exit);
        }
        let len = sink.len("f");
        if len != last_len {
            (last_len, last_progress) = (len, Instant::now());
        } else if last_progress.elapsed() > Duration::from_secs(60) {
            break None;
        }
    };
    let secs = started.elapsed().as_secs_f64();
    assert_eq!(exit.map(|e| e.0), Some(0), "no output for 60 s after {} bytes", sink.len("f"));
    let text = sink.text("f");
    let done = format!("FLOOD-DONE {}", mb * 1000);
    assert!(text.contains(&done), "last line missing: {:?}", &text[text.len().saturating_sub(300)..]);
    println!(
        "P1 {mb} MB flood: paused at {paused_at} bytes (held 1 s), {:.1} MB delivered in {secs:.1} s",
        sink.len("f") as f64 / 1e6
    );
}

#[test]
fn output_after_exit_is_delivered_before_the_exit() {
    let sink = Sink::new();
    let m = manager(&sink);
    let dir = scratch();
    // A program that writes 2 MB as fast as it can and exits right after its last line, and a shell script whose last
    // line comes just before its exit code. (A cmd `for /L` loop of 3000 echoes took 129 s on the loaded dev box even into
    // a plain pipe, so the shell rounds stay short.)
    for round in 0..10 {
        let id = format!("o{round}");
        let (r, last, code) = if round % 2 == 0 {
            (flood(&id, dir.path(), &["0", "0", "2000000"]), "FLOOD-DONE 2000", 0)
        } else {
            let r = script(
                &id,
                dir.path(),
                "(for /L %i in (1,1,200) do @echo line %i) & echo last-line & exit 4",
                "i=1; while [ $i -le 200 ]; do echo line $i; i=$((i+1)); done; echo last-line; exit 4",
            );
            (r, "last-line", 4)
        };
        m.spawn(r).unwrap();
        let Some((exit, at_exit)) = sink.wait_exit(&id, Duration::from_secs(60)) else {
            let text = sink.text(&id);
            panic!("round {round}: no exit, {} bytes, tail {:?}", text.len(), &text[text.len().saturating_sub(300)..]);
        };
        assert_eq!(exit, code, "round {round}");
        let text = sink.text(&id);
        assert_eq!(at_exit, sink.len(&id), "round {round}: output after the exit report");
        assert!(text.contains(last), "round {round}: tail {:?}", &text[text.len().saturating_sub(200)..]);
    }
}

#[test]
fn a_dev_server_tree_is_killed_with_its_terminal() {
    let sink = Sink::new();
    let m = manager(&sink);
    let dir = scratch();
    let ids = shells(&m, &sink, dir.path(), "dev", 1);
    let (id, pid) = &ids[0];
    // A background server that ignores the hangup, and one in the foreground (what an agent's `npm run dev` looks like).
    if cfg!(windows) {
        m.write(id, b"start /b ping -n 120 127.0.0.1 >nul\r");
        m.write(id, b"ping -n 300 127.0.0.1 >nul\r");
    } else {
        m.write(id, b"nohup sleep 120 >/dev/null 2>&1 &\r");
        m.write(id, b"sleep 300\r");
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    let mut descendants = Vec::new();
    while Instant::now() < deadline {
        descendants = tree(*pid).into_iter().skip(1).filter(|p| alive(*p)).collect();
        if descendants.len() >= 2 {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(descendants.len() >= 2, "children not started: {descendants:?}");
    let started = Instant::now();
    assert!(m.kill_and_wait(id, KILL_TIMEOUT), "no exit within 3 s");
    println!("P1 dev-server kill: terminal ended after {} ms", started.elapsed().as_millis());
    // Unix: the SIGKILL for what ignored the SIGHUP comes 1 s after the kill.
    let deadline = Instant::now() + Duration::from_secs(3);
    let mut left: Vec<u32> = descendants.clone();
    while Instant::now() < deadline && !left.is_empty() {
        left.retain(|p| alive(*p));
        std::thread::sleep(Duration::from_millis(50));
    }
    assert!(left.is_empty(), "still alive after the kill: {left:?}");
    assert!(!alive(*pid));
    // A killed terminal is forgotten: no exit report.
    assert!(sink.exit_of(id).is_none());
}

#[test]
fn thirty_parallel_kills_end_within_3_seconds() {
    let sink = Sink::new();
    let m = manager(&sink);
    let dir = scratch();
    let ids = shells(&m, &sink, dir.path(), "k", 30);
    let started = Instant::now();
    let ended: Vec<bool> = std::thread::scope(|s| {
        let handles: Vec<_> = ids.iter().map(|(id, _)| s.spawn(|| m.kill_and_wait(id, KILL_TIMEOUT))).collect();
        handles.into_iter().map(|h| h.join().unwrap()).collect()
    });
    let took = started.elapsed();
    println!("P1 30 parallel kills: {} ms", took.as_millis());
    assert!(ended.iter().all(|e| *e), "{ended:?}");
    assert!(took < Duration::from_secs(3));
    assert_eq!(m.running(), 0);
    for (_, pid) in &ids {
        assert!(!alive(*pid));
    }
}

#[test]
fn kill_all_ends_30_terminals_within_3_seconds() {
    let sink = Sink::new();
    let m = manager(&sink);
    let tree_killed = Arc::new(Mutex::new(Vec::new()));
    let probe = tree_killed.clone();
    m.set_tree_kill_probe(Some(Arc::new(move |pid| probe.lock().push(pid))));
    let dir = scratch();
    let ids = shells(&m, &sink, dir.path(), "all", 30);
    let started = Instant::now();
    assert!(m.kill_all(KILL_TIMEOUT));
    let took = started.elapsed();
    println!("P1 kill_all 30: {} ms", took.as_millis());
    assert!(took < Duration::from_secs(3));
    assert!(tree_killed.lock().is_empty(), "every terminal ended in time, nothing to tree-kill");
    assert_eq!(m.running(), 0);
    assert!(m.ids().is_empty());
    for (_, pid) in &ids {
        assert!(!alive(*pid));
    }
}

// test/pty-kill-tree.test.ts: only terminals whose exit was not reported yet are tree-killed after the time limit; one that
// ended by itself or was killed and ended earlier is never touched again.
#[test]
fn kill_all_tree_kills_only_terminals_still_running_after_the_limit() {
    let sink = Sink::new();
    let m = manager(&sink);
    let tree_killed = Arc::new(Mutex::new(Vec::new()));
    let probe = tree_killed.clone();
    m.set_tree_kill_probe(Some(Arc::new(move |pid| probe.lock().push(pid))));
    let dir = scratch();
    let exited_by_itself = m.spawn(script("a", dir.path(), "exit 0", "exit 0")).unwrap();
    assert!(sink.wait_exit("a", Duration::from_secs(15)).is_some());
    let live = shells(&m, &sink, dir.path(), "b", 2);
    let (killed_earlier, stuck) = (live[0].1, live[1].1);
    assert!(m.kill_and_wait("b0", KILL_TIMEOUT));
    // Unix: the stuck shell ignores the SIGHUP (a bash dies of it within microseconds, before kill_all looks again); only
    // the SIGKILL 1 s later or the tree kill ends it.
    #[cfg(unix)]
    {
        // "hup-ignored-2" is not in the echoed command line, so the trap ran once it shows.
        m.write("b1", b"trap '' HUP; echo hup-ignored-$((1+1))\r");
        assert!(sink.wait_text("b1", Duration::from_secs(10), "hup-ignored-2"), "{:?}", sink.text("b1"));
    }
    // No time at all: the live terminal is still running when the limit is reached.
    assert!(!m.kill_all(Duration::ZERO));
    assert_eq!(*tree_killed.lock(), vec![stuck]);
    assert!(!tree_killed.lock().contains(&exited_by_itself));
    assert!(!tree_killed.lock().contains(&killed_earlier));
    let deadline = Instant::now() + Duration::from_secs(5);
    while m.running() > 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(m.running(), 0);
    assert!(!alive(stuck));

    // Every terminal ends in time: nothing is tree-killed.
    tree_killed.lock().clear();
    shells(&m, &sink, dir.path(), "c", 2);
    assert!(m.kill_all(KILL_TIMEOUT));
    assert!(tree_killed.lock().is_empty());
}

#[test]
fn a_respawn_under_the_same_id_mutes_the_old_terminal() {
    let sink = Sink::new();
    let m = manager(&sink);
    let dir = scratch();
    let old = m.spawn(flood("r", dir.path(), &["200000", "0"])).unwrap();
    assert!(sink.wait_text("r", Duration::from_secs(20), "lorem"));
    m.spawn(script("r", dir.path(), "echo second-terminal & exit 5", "echo second-terminal; exit 5")).unwrap();
    let (code, _) = sink.wait_exit("r", Duration::from_secs(15)).expect("exit");
    assert_eq!(code, 5);
    std::thread::sleep(Duration::from_millis(500));
    let text = sink.text("r");
    let at = text.find("second-terminal").expect("second output");
    assert!(!text[at..].contains("lorem"), "old output after the respawn: {:?}", &text[at..]);
    assert_eq!(sink.seen.lock().exits.iter().filter(|e| e.0 == "r").count(), 1, "the old terminal's exit was reported");
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(old) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!alive(old), "the replaced terminal still runs");
}

/// A cell restarted at once (the renderer respawns it, the user closes a fresh cell): the kill right after the spawn,
/// before the shell printed anything, ends in time, with and without a terminal that answers DA1.
#[test]
fn a_kill_right_after_the_spawn_ends_in_time() {
    for answer_da1 in [true, false] {
        let sink = Sink::new();
        let m = manager(&sink);
        if !answer_da1 {
            *sink.handle.lock() = None;
        }
        let dir = scratch();
        for round in 0..5 {
            let id = format!("q{round}");
            let pid = m.spawn(req(&id, dir.path(), quick_shell())).unwrap();
            let started = Instant::now();
            let w = m.kill(&id);
            if !w.wait(KILL_TIMEOUT) {
                let late = w.wait(Duration::from_secs(20));
                panic!(
                    "da1 {answer_da1} round {round}: no exit in 3 s; shell alive {}, exit after {} ms ({late}), tree {:?}, out {:?}",
                    alive(pid),
                    started.elapsed().as_millis(),
                    tree(pid),
                    sink.text(&id)
                );
            }
            println!("P1 kill right after spawn (DA1 answered {answer_da1}): {} ms", started.elapsed().as_millis());
            assert!(!alive(pid));
        }
    }
}

/// Windows: CreateProcess fails for a missing program or cwd, so spawn fails (node-pty throws there too) and nothing is
/// left behind.
#[cfg(windows)]
#[test]
fn a_spawn_error_leaves_nothing_behind() {
    let sink = Sink::new();
    let m = manager(&sink);
    let dir = scratch();
    let mut r = req("bad", dir.path(), quick_shell());
    r.launch = Some(Launch::new(dir.path().join("no-such-program.exe").to_string_lossy(), &[]));
    assert!(m.spawn(r).is_err());
    let missing_cwd: PathBuf = dir.path().join("missing");
    assert!(m.spawn(req("bad2", &missing_cwd, quick_shell())).is_err());
    assert!(!m.has("bad") && !m.has("bad2"));
    assert_eq!(m.running(), 0);
    assert!(sink.exit_of("bad").is_none());
}

/// Unix: like node-pty (forkpty / spawn-helper), the chdir and the exec happen in the child, so a missing cwd or program is
/// a terminal that exits with code 1 (Linux prints perror's text first), not a spawn error.
#[cfg(unix)]
#[test]
fn a_missing_cwd_or_program_is_a_terminal_that_exits_with_1() {
    let sink = Sink::new();
    let m = manager(&sink);
    let dir = scratch();
    let mut r = req("bad", dir.path(), quick_shell());
    r.launch = Some(Launch::new(dir.path().join("no-such-program").to_string_lossy(), &[]));
    assert!(m.spawn(r).is_ok());
    let missing_cwd: PathBuf = dir.path().join("missing");
    assert!(m.spawn(req("bad2", &missing_cwd, quick_shell())).is_ok());
    let mut by_name = req("bad3", dir.path(), quick_shell());
    by_name.launch = Some(Launch::new("unimux-no-such-program-on-path", &[]));
    assert!(m.spawn(by_name).is_ok());
    for id in ["bad", "bad2", "bad3"] {
        assert_eq!(sink.wait_exit(id, Duration::from_secs(10)).map(|e| e.0), Some(1), "{id}: {:?}", sink.text(id));
    }
    if cfg!(target_os = "linux") {
        assert!(sink.text("bad").contains("execvp(3) failed.: No such file or directory"), "{:?}", sink.text("bad"));
        assert!(sink.text("bad2").contains("chdir(2) failed.: No such file or directory"), "{:?}", sink.text("bad2"));
        assert!(sink.text("bad3").contains("execvp(3) failed."), "{:?}", sink.text("bad3"));
    }
    assert!(!m.has("bad") && !m.has("bad2") && !m.has("bad3"));
    assert_eq!(m.running(), 0);
}

/// The launch command is typed even when spawn is still busy (a loaded machine) 150 ms after the first output: it waits in
/// the slot's early input until the pty is set.
#[test]
fn the_launch_command_is_typed_when_spawn_returns_late() {
    let sink = Sink::new();
    let m = manager(&sink);
    m.set_spawn_hold(Some(Duration::from_millis(1500)));
    let dir = scratch();
    let mut r = req("late", dir.path(), quick_shell());
    r.command = Some(if cfg!(windows) { "echo late-%COMPUTERNAME:~0,0%cmd-ok" } else { "echo late-$((1+1))-ok" }.into());
    m.spawn(r).unwrap();
    m.set_spawn_hold(None);
    let want = if cfg!(windows) { "late-cmd-ok" } else { "late-2-ok" };
    assert!(sink.wait_text("late", Duration::from_secs(30), want), "{:?}", sink.text("late"));
    assert!(m.kill_and_wait("late", KILL_TIMEOUT));
}

/// An agent cell (launch command typed) killed while its DA1 was never answered (no renderer attached): the typed command
/// is not the answer, so the kill still sends it and ends within the 3 s limit instead of sitting out OpenConsole's hold.
#[test]
fn an_agent_cell_without_a_da1_answer_is_killed_in_time() {
    let sink = Sink::new();
    let m = manager(&sink);
    *sink.handle.lock() = None;
    let dir = scratch();
    for round in 0..3 {
        let id = format!("agent{round}");
        let mut r = req(&id, dir.path(), quick_shell());
        r.command = Some("echo agent-launch".into());
        let pid = m.spawn(r).unwrap();
        assert!(sink.wait_output(&id, Duration::from_secs(30)), "{id}: no output");
        // The command went in (150 ms after the first output).
        std::thread::sleep(Duration::from_millis(400));
        let started = Instant::now();
        assert!(m.kill_and_wait(&id, KILL_TIMEOUT), "{id}: no exit in 3 s");
        let took = started.elapsed();
        println!("P1 agent cell kill without DA1 answer: {} ms", took.as_millis());
        // OpenConsole's DA1 hold is about 2.8 s idle (3.1 s under load); a kill that sent the answer takes well under 1 s.
        assert!(took < Duration::from_millis(2000), "{id}: the kill sat out the DA1 hold ({} ms)", took.as_millis());
        assert!(!alive(pid));
    }
}

#[test]
fn the_supervised_actor_kills_the_terminals_on_a_crash_and_restarts() {
    init();
    let sink = Sink::new();
    let (tx, events) = mpsc::channel();
    let tx = Mutex::new(tx);
    let policy = CrashPolicy { base_delay: Duration::from_millis(50), ..CrashPolicy::default() };
    let sup = actor::start(sink.clone(), policy, move |e| {
        let _ = tx.lock().send(e);
    });
    let dir = scratch();
    let spawn = |id: &str| {
        let (reply, rx) = mpsc::channel();
        assert!(sup.send(PtyCommand::Spawn(Box::new(req(id, dir.path(), quick_shell())), Some(reply))));
        rx.recv_timeout(Duration::from_secs(10)).unwrap().expect("spawn")
    };
    // The DA1 answer goes through the actor here (no PtyHandle).
    let pid = spawn("s1");
    if cfg!(windows) {
        assert!(sup.send(PtyCommand::Write("s1".into(), DA1_REPLY.to_vec())));
    }
    assert!(sink.wait_output("s1", Duration::from_secs(20)));

    assert!(sup.send(PtyCommand::Panic("injected".into())));
    match events.recv_timeout(Duration::from_secs(5)).unwrap() {
        SupervisorEvent::Crashed { message, count, restart_in } => {
            assert_eq!((message.as_str(), count, restart_in), ("injected", 1, Duration::from_millis(50)));
        }
        e => panic!("{e:?}"),
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!alive(pid), "the crash left the terminal running");
    assert!(sink.exit_of("s1").is_none(), "a crashed manager reports no exits");
    assert_eq!(events.recv_timeout(Duration::from_secs(5)).unwrap(), SupervisorEvent::Restarted);

    // A panic in the sink on a reader thread is a crash too.
    *sink.panic_on.lock() = Some("p1-sink-panic".into());
    let pid = spawn("s2");
    if cfg!(windows) {
        sup.send(PtyCommand::Write("s2".into(), DA1_REPLY.to_vec()));
    }
    assert!(sink.wait_output("s2", Duration::from_secs(20)));
    sup.send(PtyCommand::Write("s2".into(), b"echo p1-sink-panic\r".to_vec()));
    match events.recv_timeout(Duration::from_secs(10)).unwrap() {
        SupervisorEvent::Crashed { message, count, .. } => {
            assert!(message.contains("sink panicked on p1-sink-panic"), "{message}");
            assert_eq!(count, 2);
        }
        e => panic!("{e:?}"),
    }
    *sink.panic_on.lock() = None;
    let deadline = Instant::now() + Duration::from_secs(5);
    while alive(pid) && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(!alive(pid));
    assert_eq!(events.recv_timeout(Duration::from_secs(5)).unwrap(), SupervisorEvent::Restarted);

    let pid = spawn("s3");
    let (done, rx) = mpsc::channel();
    sup.send(PtyCommand::KillAll(KILL_TIMEOUT, Some(done)));
    assert!(rx.recv_timeout(Duration::from_secs(5)).unwrap());
    assert!(!alive(pid));
    sup.stop();
}
