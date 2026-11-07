//! The unimux-mcp server with the test fake tool layer, driven by scripts/spike-mcp-wire.mjs over stdin/stdout JSON lines
//! (the protocol cases against the 1.1.4 TypeScript server and the real claude / codex CLIs; see docs/tauri/spikes/SP8.md).
//!
//! `mcp_wire_server [--tools <fixture.json>] [--progress-ms 2000]` prints `{"url": ...}`, then answers
//! `{"cmd":"issue","cell":..}` with `{"token":..}`, `{"cmd":"revoke","cell":..}` with `{}`, and `{"cmd":"events"}` with
//! `{"events":[..],"sessions":n}`. It exits when stdin closes.

#[path = "../tests/support/fake.rs"]
mod fake;

use std::io::{BufRead, Write};
use std::time::Duration;

use serde_json::{Value, json};
use unimux_mcp::{Config, McpServer};

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let fake = match arg(&args, "--tools") {
        Some(path) => {
            fake::Fake::new(&serde_json::from_str(&std::fs::read_to_string(path).expect("tools fixture")).expect("fixture json"))
        }
        None => fake::Fake::from_fixture_file(),
    };
    let progress = Duration::from_millis(arg(&args, "--progress-ms").and_then(|v| v.parse().ok()).unwrap_or(10_000));
    let cfg = Config { rate: None, progress_every: progress, version: "1.2.0".into(), ..Config::default() };
    let server = McpServer::new(fake.clone(), cfg);
    server.start().await.expect("listen");
    let say = |v: Value| {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{v}");
        let _ = out.flush();
    };
    say(json!({ "url": server.url() }));

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break };
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    while let Some(line) = rx.recv().await {
        let Ok(msg) = serde_json::from_str::<Value>(&line) else { continue };
        let cell = msg["cell"].as_str().unwrap_or("").to_string();
        match msg["cmd"].as_str().unwrap_or("") {
            "issue" => say(json!({ "token": server.issue_token(&cell) })),
            "revoke" => {
                server.revoke_cell(&cell);
                say(json!({}));
            }
            "events" => say(json!({ "events": fake.events.all(), "sessions": server.session_count() })),
            _ => say(json!({ "error": "unknown command" })),
        }
    }
    server.stop();
}
