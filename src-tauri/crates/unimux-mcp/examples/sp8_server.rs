//! SP8 spike server, driven by scripts/spike-mcp-wire.mjs over stdin/stdout JSON lines.
//!
//! `sp8_server --impl custom|rmcp --tools <fixture.json> [--progress-ms 2000]` prints `{"url": ...}`, then answers
//! `{"cmd":"issue","cell":..}` with `{"token":..}`, `{"cmd":"revoke","cell":..}` with `{}`, and `{"cmd":"events"}` with
//! `{"events":[..],"sessions":n}`. It exits when stdin closes.

#[path = "sp8/custom.rs"]
mod custom;
#[path = "sp8/fake.rs"]
mod fake;
#[path = "sp8/rmcp_impl.rs"]
mod rmcp_impl;

use std::io::{BufRead, Write};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};

enum Server {
    Custom(custom::CustomServer),
    Rmcp(rmcp_impl::RmcpServer),
}

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned()
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let kind = arg(&args, "--impl").unwrap_or_else(|| "custom".into());
    let fixture: Value = match arg(&args, "--tools") {
        Some(path) => serde_json::from_str(&std::fs::read_to_string(path).expect("tools fixture")).expect("tools fixture json"),
        None => json!({ "tools": [], "instructions": "" }),
    };
    let progress = Duration::from_millis(arg(&args, "--progress-ms").and_then(|v| v.parse().ok()).unwrap_or(10_000));
    let fake = Arc::new(fake::Fake::new(&fixture));
    let server = match kind.as_str() {
        "rmcp" => Server::Rmcp(rmcp_impl::RmcpServer::start(fake.clone(), "1.2.0".into(), progress).await.expect("listen")),
        _ => {
            let cfg = custom::Config { rate: None, progress_every: progress, ..custom::Config::default() };
            Server::Custom(custom::CustomServer::start(fake.clone(), cfg).await.expect("listen"))
        }
    };
    let url = match &server {
        Server::Custom(s) => s.url.clone(),
        Server::Rmcp(s) => s.url.clone(),
    };
    let say = |v: Value| {
        let mut out = std::io::stdout().lock();
        let _ = writeln!(out, "{v}");
        let _ = out.flush();
    };
    say(json!({ "url": url }));

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
            "issue" => {
                let token = match &server {
                    Server::Custom(s) => s.issue_token(&cell),
                    Server::Rmcp(s) => s.issue_token(&cell),
                };
                say(json!({ "token": token }));
            }
            "revoke" => {
                match &server {
                    Server::Custom(s) => s.revoke_cell(&cell),
                    Server::Rmcp(s) => s.revoke_cell(&cell),
                }
                say(json!({}));
            }
            "events" => {
                let sessions = match &server {
                    Server::Custom(s) => s.session_count(),
                    Server::Rmcp(s) => s.session_count().await,
                };
                say(json!({ "events": fake.events.all(), "sessions": sessions }));
            }
            _ => say(json!({ "error": "unknown command" })),
        }
    }
}
