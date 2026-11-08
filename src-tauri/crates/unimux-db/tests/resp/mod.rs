//! The RESP server of the TS suites (test/helpers/respServer.ts) in a Node child, driven over its stdin / stdout through
//! tests/node/resp-control.mjs. `Resp::start` is None (with a note) when Node is missing.
#![allow(dead_code)]

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Value, json};

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

pub fn node_available() -> bool {
    Command::new("node").arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

pub struct Resp {
    child: Child,
    stdin: Mutex<Option<ChildStdin>>,
    stdout: Mutex<BufReader<ChildStdout>>,
    next: AtomicU64,
    pub port: u16,
}

impl Resp {
    pub fn start(options: Value) -> Option<Resp> {
        if !node_available() {
            eprintln!("node is not installed: skipped");
            return None;
        }
        let root = repo_root();
        let mut child = Command::new("node")
            .arg("--no-warnings")
            .arg(root.join("src-tauri/crates/unimux-db/tests/node/resp-control.mjs"))
            .arg(root.join("test/helpers/respServer.ts"))
            .arg(options.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("node");
        let mut stdout = BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        let first: Value = serde_json::from_str(&line).unwrap_or_else(|e| panic!("{e}: {line:?}"));
        let port = first["port"].as_u64().unwrap() as u16;
        let stdin = Mutex::new(child.stdin.take());
        Some(Resp { child, stdin, stdout: Mutex::new(stdout), next: AtomicU64::new(1), port })
    }

    /// One control request (see resp-control.mjs for the commands).
    pub fn call(&self, cmd: &str, args: Value) -> Value {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let mut out = self.stdout.lock();
        writeln!(self.stdin.lock().as_mut().unwrap(), "{}", json!({ "id": id, "cmd": cmd, "args": args })).unwrap();
        let mut line = String::new();
        out.read_line(&mut line).unwrap();
        let answer: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(answer["id"], id);
        assert!(answer["error"].is_null(), "{cmd}: {}", answer["error"]);
        answer["result"].clone()
    }

    pub fn set_string(&self, key: &str, value: &str) {
        self.call("setString", json!([key, value]));
    }

    pub fn set_strings(&self, prefix: &str, from: u32, to: u32) {
        self.call("setStrings", json!([prefix, from, to, "x"]));
    }

    pub fn count(&self, prefix: &str) -> u64 {
        self.call("count", json!([prefix])).as_u64().unwrap()
    }

    pub fn ops(&self, name: &str) -> u64 {
        self.call("ops", json!([name])).as_u64().unwrap()
    }
}

impl Drop for Resp {
    fn drop(&mut self) {
        // Closing stdin ends the server; the child is waited for briefly and killed if it hangs.
        drop(self.stdin.lock().take());
        let start = Instant::now();
        while start.elapsed() < Duration::from_secs(5) {
            if let Ok(Some(_)) = self.child.try_wait() {
                return;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let _ = self.child.kill();
    }
}
