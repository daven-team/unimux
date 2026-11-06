//! unimux-hostd: a stdio test host (PLAN B1). One JSON request per line on stdin, one JSON answer per line on stdout:
//! `{"id": 1, "op": "ping"}` -> `{"id": 1, "ok": true, "result": "pong"}`. Package B1 adds the ported primitives (pty,
//! ssh, sftp, db) so test/helpers/nodeHost.ts can run the existing `.int` suites against Rust. Never shipped.

use std::io::{self, BufRead, Write};

use serde_json::{Value, json};

fn handle(op: &str, _args: &Value) -> Result<Value, String> {
    match op {
        "ping" => Ok(json!("pong")),
        "version" => Ok(json!(unimux_core::VERSION)),
        other => Err(format!("unknown op {other}")),
    }
}

fn main() {
    let stdin = io::stdin();
    let mut out = io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let answer = match serde_json::from_str::<Value>(&line) {
            Ok(req) => {
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                match handle(req.get("op").and_then(Value::as_str).unwrap_or(""), req.get("args").unwrap_or(&Value::Null)) {
                    Ok(result) => json!({ "id": id, "ok": true, "result": result }),
                    Err(error) => json!({ "id": id, "ok": false, "error": error }),
                }
            }
            Err(e) => json!({ "id": null, "ok": false, "error": format!("bad request: {e}") }),
        };
        if writeln!(out, "{answer}").and_then(|_| out.flush()).is_err() {
            break;
        }
    }
}
