//! The hostd binary over its stdio wire, like test/helpers/nodeHost.ts drives it: protocol answers, a real terminal's
//! output / exit events, kill and killAll, respawn of an id, and the end of every terminal when stdin closes. Runs on every
//! OS (Windows: cmd in ConPTY; Unix: bash -il in openpty).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use serde_json::{Value, json};

#[derive(Default)]
struct Seen {
    answers: Vec<Value>,
    data: Vec<(String, String)>,
    exits: Vec<(String, u64)>,
}

struct Host {
    child: Child,
    stdin: Option<ChildStdin>,
    seen: Arc<(Mutex<Seen>, Condvar)>,
    next: u64,
}

const WAIT: Duration = Duration::from_secs(20);

impl Host {
    fn start() -> Self {
        let mut cmd = Command::new(env!("CARGO_BIN_EXE_unimux-hostd"));
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        if let Some(dir) = conpty_dir() {
            cmd.env("UNIMUX_CONPTY_DIR", dir);
        }
        let mut child = cmd.spawn().expect("start unimux-hostd");
        let stdout = child.stdout.take().unwrap();
        let seen: Arc<(Mutex<Seen>, Condvar)> = Arc::default();
        let s = seen.clone();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let msg: Value = serde_json::from_str(&line).expect("one JSON object per line");
                let mut seen = s.0.lock();
                match msg.get("event").and_then(Value::as_str) {
                    Some("pty.data") => seen.data.push((
                        msg["args"]["id"].as_str().unwrap().to_string(),
                        msg["args"]["data"].as_str().unwrap().to_string(),
                    )),
                    Some("pty.exit") => {
                        seen.exits.push((msg["args"]["id"].as_str().unwrap().to_string(), msg["args"]["code"].as_u64().unwrap()))
                    }
                    Some(other) => panic!("unexpected event {other}"),
                    None => seen.answers.push(msg),
                }
                s.1.notify_all();
            }
        });
        let stdin = child.stdin.take();
        Host { child, stdin, seen, next: 1 }
    }

    fn send_raw(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        writeln!(stdin, "{line}").unwrap();
        stdin.flush().unwrap();
    }

    fn request(&mut self, op: &str, args: Value) -> Value {
        let id = self.next;
        self.next += 1;
        self.send_raw(&json!({ "id": id, "op": op, "args": args }).to_string());
        self.wait(&format!("answer to {op}"), |s| s.answers.iter().find(|a| a["id"] == json!(id)).cloned())
    }

    fn ok(&mut self, op: &str, args: Value) -> Value {
        let answer = self.request(op, args);
        assert_eq!(answer["ok"], json!(true), "{op}: {answer}");
        answer["result"].clone()
    }

    fn wait<T>(&self, what: &str, mut f: impl FnMut(&Seen) -> Option<T>) -> T {
        let deadline = Instant::now() + WAIT;
        let mut seen = self.seen.0.lock();
        loop {
            if let Some(v) = f(&seen) {
                return v;
            }
            if self.seen.1.wait_until(&mut seen, deadline).timed_out() {
                let out: String = seen.data.iter().map(|(id, d)| format!("[{id}] {d}")).collect();
                panic!("timeout waiting for {what}; output so far: {out:?}");
            }
        }
    }

    fn output(&self, id: &str) -> String {
        self.seen.0.lock().data.iter().filter(|(i, _)| i == id).map(|(_, d)| d.as_str()).collect()
    }

    fn wait_output(&self, id: &str, needle: &str) {
        self.wait(&format!("{needle:?} from {id}"), |s| {
            let all: String = s.data.iter().filter(|(i, _)| i == id).map(|(_, d)| d.as_str()).collect();
            all.contains(needle).then_some(())
        });
    }

    fn exits(&self) -> Vec<(String, u64)> {
        self.seen.0.lock().exits.clone()
    }

    /// Closes stdin and waits for the host to end.
    fn close(mut self) -> std::process::ExitStatus {
        drop(self.stdin.take());
        let deadline = Instant::now() + WAIT;
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                return status;
            }
            assert!(Instant::now() < deadline, "unimux-hostd did not end after stdin closed");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

/// node-pty's conpty.dll 1.23 in node_modules (the one 1.1.4 ships); the host falls back to the in-box API without it.
fn conpty_dir() -> Option<std::path::PathBuf> {
    if !cfg!(windows) {
        return None;
    }
    if let Some(dir) = std::env::var_os("UNIMUX_CONPTY_DIR") {
        return Some(dir.into());
    }
    let root = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../node_modules/node-pty/third_party/conpty");
    let mut versions: Vec<_> = std::fs::read_dir(&root).ok()?.filter_map(|e| e.ok().map(|e| e.path())).collect();
    versions.sort();
    versions.into_iter().rev().map(|v| v.join("win10-x64")).find(|d| d.join("conpty.dll").is_file())
}

fn shell() -> &'static str {
    if cfg!(windows) { "cmd" } else { "bash" }
}

/// The command typed into the shell and the text only its output (not the echo of the typed line) contains.
fn marker_command(mark: &str) -> (String, String) {
    if cfg!(windows) {
        ("echo %HOSTD_MARK%-done".into(), format!("{mark}-done"))
    } else {
        ("echo \"$HOSTD_MARK-done\"".into(), format!("{mark}-done"))
    }
}

fn spawn_args(id: &str, mark: &str, command: Option<&str>) -> Value {
    let mut env: serde_json::Map<String, Value> =
        std::env::vars().map(|(k, v)| (k, Value::String(v))).filter(|(k, _)| k != "HOSTD_MARK").collect();
    env.insert("HOSTD_MARK".into(), json!(mark));
    let mut args = json!({
        "id": id,
        "cwd": std::env::temp_dir(),
        "cols": 80,
        "rows": 24,
        "env": env,
        "shell": shell(),
    });
    if let Some(c) = command {
        args["command"] = json!(c);
    }
    args
}

fn process_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        unimux_pty::conpty::Pty::process_alive(pid)
    }
    #[cfg(unix)]
    {
        // SAFETY: signal 0 only checks that the pid exists.
        unsafe { libc::kill(pid as libc::pid_t, 0) == 0 }
    }
}

#[test]
fn protocol_answers() {
    let mut h = Host::start();
    assert_eq!(h.ok("ping", json!({})), json!("pong"));
    let info = h.ok("info", json!({}));
    assert_eq!(info["domains"], json!(["pty"]));
    assert_eq!(info["version"], json!(env!("CARGO_PKG_VERSION")));
    let a = h.request("nope", json!({}));
    assert_eq!(a, json!({ "id": a["id"], "ok": false, "error": "unknown op nope" }));
    let a = h.request("pty.nope", json!({}));
    assert_eq!(a["error"], json!("unknown op pty.nope"));
    let a = h.request("pty.spawn", json!({ "id": 5 }));
    assert_eq!(a["error"], json!("id: expected a string"));
    h.send_raw("{not json");
    let bad = h.wait("bad request answer", |s| s.answers.iter().find(|a| a["id"].is_null()).cloned());
    assert!(bad["error"].as_str().unwrap().starts_with("bad request:"), "{bad}");
    // ops on unknown terminals are no-ops, like PtyManager
    assert_eq!(h.ok("pty.write", json!({ "id": "none", "data": "x" })), Value::Null);
    assert_eq!(h.ok("pty.resize", json!({ "id": "none", "cols": 10, "rows": 5 })), Value::Null);
    assert_eq!(h.ok("pty.kill", json!({ "id": "none" })), Value::Null);
    assert_eq!(h.ok("pty.has", json!({ "id": "none" })), json!(false));
    assert_eq!(h.ok("pty.histories", json!({})), json!([]));
    assert!(h.close().success());
}

#[test]
fn terminal_output_replay_and_exit() {
    let mut h = Host::start();
    let (command, want) = marker_command("m1");
    let spawned = h.ok("pty.spawn", spawn_args("a", "m1", Some(&command)));
    assert!(spawned["pid"].as_u64().unwrap() > 0);
    if cfg!(windows) && conpty_dir().is_some() {
        assert!(spawned["source"].as_str().unwrap().starts_with("bundled:"), "{spawned}");
    }
    h.wait_output("a", &want);
    assert_eq!(h.ok("pty.has", json!({ "id": "a" })), json!(true));
    let histories = h.ok("pty.histories", json!({}));
    assert_eq!(histories[0]["id"], json!("a"));
    assert!(histories[0]["data"].as_str().unwrap().contains(&want));
    h.ok("pty.resize", json!({ "id": "a", "cols": 100, "rows": 30 }));
    h.ok("pty.write", json!({ "id": "a", "data": "exit\r" }));
    h.wait("exit of a", |s| s.exits.iter().any(|(id, _)| id == "a").then_some(()));
    // The entry is gone before the exit event (PtyManager deletes, then calls sink.exit).
    assert_eq!(h.ok("pty.has", json!({ "id": "a" })), json!(false));
    assert_eq!(h.exits(), vec![("a".to_string(), 0)]);
    assert!(h.output("a").contains(&want));
    assert!(h.close().success());
}

#[test]
fn kill_and_kill_all_end_terminals_without_exit_events() {
    let mut h = Host::start();
    let (command, want) = marker_command("k");
    let mut pids = Vec::new();
    for id in ["x", "y", "z"] {
        pids.push(h.ok("pty.spawn", spawn_args(id, "k", Some(&command)))["pid"].as_u64().unwrap() as u32);
    }
    for id in ["x", "y", "z"] {
        h.wait_output(id, &want);
    }
    let t0 = Instant::now();
    h.ok("pty.kill", json!({ "id": "x", "timeoutMs": 5000 }));
    assert!(t0.elapsed() < Duration::from_secs(5));
    assert_eq!(h.ok("pty.has", json!({ "id": "x" })), json!(false));
    assert_eq!(h.ok("pty.has", json!({ "id": "y" })), json!(true));
    let t0 = Instant::now();
    h.ok("pty.killAll", json!({ "timeoutMs": 5000 }));
    assert!(t0.elapsed() < Duration::from_secs(5), "killAll took {:?}", t0.elapsed());
    assert_eq!(h.ok("pty.histories", json!({})), json!([]));
    h.wait("killed shells gone", |_| pids.iter().all(|p| !process_alive(*p)).then_some(()));
    std::thread::sleep(Duration::from_millis(300));
    assert_eq!(h.exits(), vec![], "a killed terminal reports no exit");
    assert!(h.close().success());
}

#[test]
fn respawning_an_id_replaces_the_old_terminal() {
    let mut h = Host::start();
    let (c1, w1) = marker_command("first");
    let first = h.ok("pty.spawn", spawn_args("r", "first", Some(&c1)));
    h.wait_output("r", &w1);
    let (c2, w2) = marker_command("second");
    let second = h.ok("pty.spawn", spawn_args("r", "second", Some(&c2)));
    assert_ne!(first["pid"], second["pid"]);
    h.wait_output("r", &w2);
    let old = first["pid"].as_u64().unwrap() as u32;
    h.wait("old shell gone", |_| (!process_alive(old)).then_some(()));
    let histories = h.ok("pty.histories", json!({}));
    assert_eq!(histories.as_array().unwrap().len(), 1);
    assert!(!histories[0]["data"].as_str().unwrap().contains(&w1), "the replay is the new terminal's only");
    assert_eq!(h.exits(), vec![]);
    assert!(h.close().success());
}

#[test]
fn closing_stdin_ends_every_terminal() {
    let mut h = Host::start();
    let (command, want) = marker_command("c");
    let mut pids = Vec::new();
    for id in ["p", "q"] {
        pids.push(h.ok("pty.spawn", spawn_args(id, "c", Some(&command)))["pid"].as_u64().unwrap() as u32);
    }
    for id in ["p", "q"] {
        h.wait_output(id, &want);
    }
    assert!(pids.iter().all(|p| process_alive(*p)));
    assert!(h.close().success());
    let deadline = Instant::now() + Duration::from_secs(5);
    while pids.iter().any(|p| process_alive(*p)) {
        assert!(Instant::now() < deadline, "a shell outlived the host");
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn utf8_output_arrives_whole() {
    let mut h = Host::start();
    let text = "zażółć-日本-ok";
    let command = if cfg!(windows) { format!("chcp 65001 >nul & echo {text}") } else { format!("printf '%s\\n' '{text}'") };
    h.ok("pty.spawn", spawn_args("u", "u", Some(&command)));
    // the echo of the typed line contains the text too; it must arrive as the same characters, never as U+FFFD
    h.wait_output("u", text);
    assert!(!h.output("u").contains('\u{FFFD}'));
    h.ok("pty.killAll", json!({}));
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || tx.send(h.close()).unwrap());
    assert!(rx.recv_timeout(WAIT).unwrap().success());
}
