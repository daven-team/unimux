//! unimux-hostd: a stdio test host (PLAN B1), never shipped. The Node side is test/helpers/nodeHost.ts: it starts this
//! binary, sends one JSON request per line and gets answers and events back (wire in `protocol.rs`), so the existing `.int`
//! suites and the Node fake servers (pgFakeServer, mysqlFakeServer, respServer, sshServer, pglite-socket) drive the Rust
//! code instead of the TS one.
//!
//! Ops are `<domain>.<name>`. Built-in: `ping`, `version`, `info`. Domains: `pty.*` (`pty/`). A package that ports a
//! host adds its domain module and one arm in [`Host::dispatch`] (ssh, sftp, db, ...); see docs/tauri/HOSTD.md.
//!
//! Lifetime: the host ends when stdin closes (the test process ended or called `close()`); every terminal it started is
//! killed with its process tree first, so nothing outlives a test run.

mod protocol;
mod pty;
mod utf8;

use std::io::{self, BufRead};
use std::time::Duration;

use serde_json::{Value, json};

use protocol::{Out, Reply};

struct Host {
    pty: pty::PtyHost,
}

impl Host {
    fn new(out: Out) -> Self {
        Self { pty: pty::PtyHost::new(out) }
    }

    fn dispatch(&self, op: &str, args: &Value, reply: Reply) {
        match op.split_once('.') {
            Some(("pty", name)) => self.pty.handle(name, args, reply),
            None => match op {
                "ping" => reply.ok(json!("pong")),
                "version" => reply.ok(json!(unimux_core::VERSION)),
                "info" => reply.ok(json!({
                    "version": unimux_core::VERSION,
                    "platform": pty::platform(),
                    "pid": std::process::id(),
                    "domains": ["pty"],
                })),
                other => reply.err(format!("unknown op {other}")),
            },
            Some(_) => reply.err(format!("unknown op {op}")),
        }
    }

    fn shutdown(&self) {
        self.pty.shutdown(Duration::from_secs(3));
    }
}

fn main() {
    let out = Out::stdout();
    let host = Host::new(out.clone());
    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match protocol::parse(&line) {
            Ok(req) => host.dispatch(&req.op, &req.args, Reply::new(req.id, out.clone())),
            Err(error) => Reply::new(Value::Null, out.clone()).err(error),
        }
        if out.is_broken() {
            break;
        }
    }
    host.shutdown();
    // Reader / waiter threads of killed terminals may still be draining; the process ends regardless.
    std::process::exit(0);
}
