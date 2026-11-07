#![allow(dead_code)]

pub mod fake;
pub mod http;

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use unimux_mcp::{Config, McpServer};

use fake::Fake;
use http::{ACCEPT, Body, Request, Res};

/// A started server with the fake tool layer and the 1.1.4 tool fixture.
pub struct Srv {
    pub server: McpServer,
    pub fake: Arc<Fake>,
    pub url: String,
    pub addr: String,
}

pub const LEAD: &str = "cell-lead";
pub const WORKER: &str = "cell-worker";

impl Srv {
    pub async fn start(cfg: Config) -> Self {
        Self::start_with(Fake::from_fixture_file(), cfg).await
    }

    pub async fn start_with(fake: Arc<Fake>, cfg: Config) -> Self {
        let server = McpServer::new(fake.clone(), cfg);
        server.start().await.unwrap();
        let url = server.url().unwrap();
        let addr = url.trim_start_matches("http://").trim_end_matches("/mcp").to_string();
        Self { server, fake, url, addr }
    }

    /// The config of the wire driver: no rate limit, progress every 2 s, version 1.2.0.
    pub fn wire_config() -> Config {
        Config { rate: None, progress_every: Duration::from_millis(2000), version: "1.2.0".into(), ..Config::default() }
    }

    pub fn issue(&self, cell: &str) -> String {
        self.server.issue_token(cell)
    }

    pub fn lead(&self) -> String {
        self.issue(LEAD)
    }

    pub fn req<'a>(&'a self, method: &'a str, path: &'a str) -> Request<'a> {
        Request::new(&self.addr, method, path)
    }

    /// A POST to /mcp the way the MCP clients send it.
    pub fn post_req(&self, token: &str, body: impl Into<Body>) -> Request<'_> {
        self.req("POST", "/mcp")
            .header("content-type", "application/json")
            .header("accept", ACCEPT)
            .header("authorization", &format!("Bearer {token}"))
            .body(body)
    }

    pub async fn post(&self, token: &str, body: impl Into<Body>) -> Res {
        self.post_req(token, body).send().await
    }

    pub async fn in_session(&self, token: &str, session: &str, body: impl Into<Body>) -> Res {
        self.post_req(token, body).header("mcp-session-id", session).header("mcp-protocol-version", "2025-11-25").send().await
    }

    /// An elicitation-capable initialize: the session id.
    pub async fn session(&self, token: &str) -> String {
        self.post(token, init(json!({ "elicitation": { "form": {} } }))).await.session().expect("a session")
    }

    /// Waits for an event of the fake tool layer after index `from`.
    pub async fn wait_event(&self, from: usize, pred: impl Fn(&Value) -> bool, limit: Duration) -> Option<Value> {
        let until = tokio::time::Instant::now() + limit;
        while tokio::time::Instant::now() < until {
            if let Some(e) = self.fake.events.all().into_iter().skip(from).find(&pred) {
                return Some(e);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        None
    }
}

pub fn init(capabilities: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": { "protocolVersion": "2025-11-25", "capabilities": capabilities, "clientInfo": { "name": "sp8", "version": "1" } } })
}

pub fn call(id: u64, name: &str, args: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": name, "arguments": args } })
}

pub fn wait_for(id: u64, timeout_sec: f64) -> Value {
    call(id, "wait_for", json!({ "timeoutSec": timeout_sec }))
}
