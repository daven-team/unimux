//! SP8 spike: HTTP-level checks of the custom dispatcher (examples/sp8/custom.rs) with a raw HTTP/1.1 client, plus the
//! rmcp candidate's behaviour where it differs (cancellation). The full comparison with the 1.1.4 TypeScript server and the
//! real CLIs is scripts/spike-mcp-wire.mjs.

#[allow(dead_code)]
#[path = "../examples/sp8/custom.rs"]
mod custom;
#[allow(dead_code)]
#[path = "../examples/sp8/fake.rs"]
mod fake;
#[allow(dead_code)]
#[path = "../examples/sp8/rmcp_impl.rs"]
mod rmcp_impl;

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

fn fixture() -> Value {
    json!({ "tools": [{ "name": "wait_for", "description": "Block.", "inputSchema": { "type": "object", "properties": {} },
        "execution": { "taskSupport": "optional" } }], "workerTools": [], "instructions": "Unimux test." })
}

async fn start() -> (custom::CustomServer, Arc<fake::Fake>) {
    start_with(custom::Config::default()).await
}

async fn start_with(cfg: custom::Config) -> (custom::CustomServer, Arc<fake::Fake>) {
    let fake = Arc::new(fake::Fake::new(&fixture()));
    let cfg = custom::Config { rate: None, progress_every: Duration::from_millis(300), ..cfg };
    (custom::CustomServer::start(fake.clone(), cfg).await.unwrap(), fake)
}

fn initialize() -> Value {
    json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": { "protocolVersion": "2025-11-25", "capabilities": { "elicitation": { "form": {} } }, "clientInfo": { "name": "t", "version": "1" } } })
}

async fn open_session(url: &str, token: &str) -> String {
    let (status, head, _) = exchange(url, request(url, token, &[], &initialize())).await;
    assert_eq!(status, 200);
    head.lines().find_map(|l| l.strip_prefix("mcp-session-id: ")).unwrap().trim().to_string()
}

async fn json_call(url: &str, token: &str, body: &Value) -> Value {
    let (_, _, text) = exchange(url, request(url, token, &[], body)).await;
    serde_json::from_str(&text).unwrap_or(Value::Null)
}

fn addr(url: &str) -> String {
    url.trim_start_matches("http://").trim_end_matches("/mcp").to_string()
}

fn request(url: &str, token: &str, extra: &[(&str, &str)], body: &Value) -> String {
    let body = body.to_string();
    let mut head = format!(
        "POST /mcp HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: {}\r\n",
        addr(url),
        body.len()
    );
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    format!("{head}Connection: close\r\n\r\n{body}")
}

/// One exchange over a fresh connection, read to the end: (status, headers lowercased, body).
async fn exchange(url: &str, raw: String) -> (u16, String, String) {
    let mut stream = TcpStream::connect(addr(url)).await.unwrap();
    stream.write_all(raw.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    stream.read_to_end(&mut out).await.unwrap();
    let text = String::from_utf8_lossy(&out).to_string();
    let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
    let status = head.split(' ').nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    (status, head.to_ascii_lowercase(), dechunk(head, body))
}

fn dechunk(head: &str, body: &str) -> String {
    if !head.to_ascii_lowercase().contains("transfer-encoding: chunked") {
        return body.to_string();
    }
    let mut out = String::new();
    let mut rest = body;
    while let Some((size, tail)) = rest.split_once("\r\n") {
        let n = usize::from_str_radix(size.trim(), 16).unwrap_or(0);
        if n == 0 {
            break;
        }
        out.push_str(&tail[..n]);
        rest = &tail[n + 2..];
    }
    out
}

fn sse_messages(body: &str) -> Vec<Value> {
    body.split("\n\n")
        .filter_map(|b| b.strip_prefix("event: message\ndata: "))
        .filter_map(|d| serde_json::from_str(d).ok())
        .collect()
}

async fn wait_event(fake: &fake::Fake, from: usize, kind: &str, deadline: Duration) -> Option<Value> {
    let until = Instant::now() + deadline;
    while Instant::now() < until {
        if let Some(e) = fake.events.all().into_iter().skip(from).find(|e| e["kind"] == kind) {
            return Some(e);
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    None
}

fn call(id: u64, args: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "tools/call", "params": { "name": "wait_for", "arguments": args } })
}

#[tokio::test]
async fn check_order_matches_1_1_4() {
    let (server, _) = start().await;
    let token = server.issue_token("cell-lead");
    let a = addr(&server.url);
    let raw = |method: &str, path: &str, host: &str, auth: &str| {
        format!("{method} {path} HTTP/1.1\r\nHost: {host}\r\n{auth}Connection: close\r\n\r\n")
    };
    let bearer = format!("Authorization: Bearer {token}\r\n");
    assert_eq!(exchange(&server.url, raw("POST", "/mcp", "evil:1", &bearer)).await.0, 403);
    assert_eq!(exchange(&server.url, raw("POST", "/x", &a, &bearer)).await.0, 404);
    assert_eq!(exchange(&server.url, raw("POST", "/mcp", &a, "")).await.0, 401);
    assert_eq!(exchange(&server.url, raw("POST", "/mcp", &a, "Authorization: Bearer nope\r\n")).await.0, 401);
    let (status, head, _) = exchange(&server.url, raw("GET", "/mcp", &a, &bearer)).await;
    assert_eq!(status, 405);
    assert!(head.contains("allow: post"));
    let big = json!({ "jsonrpc": "2.0", "id": 1, "method": "ping", "params": { "pad": "x".repeat(300 * 1024) } });
    let (status, _, body) = exchange(&server.url, request(&server.url, &token, &[], &big)).await;
    assert_eq!(
        (status, body.as_str()),
        (413, r#"{"jsonrpc":"2.0","error":{"code":-32000,"message":"Request body too large."},"id":null}"#)
    );
    server.revoke_cell("cell-lead");
    assert_eq!(exchange(&server.url, raw("POST", "/mcp", &a, &bearer)).await.0, 401);
}

#[tokio::test]
async fn stateless_json_and_sse_progress() {
    let (server, _) = start().await;
    let token = server.issue_token("cell-lead");
    let (status, head, body) =
        exchange(&server.url, request(&server.url, &token, &[], &json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })))
            .await;
    assert_eq!(status, 200);
    assert!(head.contains("content-type: application/json"));
    assert!(!head.contains("mcp-session-id"));
    // The verbatim tool (execution.taskSupport kept), in the SDK's key order.
    assert!(body.starts_with(r#"{"result":{"tools":[{"name":"wait_for""#), "{body}");
    assert!(body.contains(r#""execution":{"taskSupport":"optional"}"#));
    let mut progress = call(2, json!({ "timeoutSec": 1 }));
    progress["params"]["_meta"] = json!({ "progressToken": "p" });
    let (_, head, body) = exchange(&server.url, request(&server.url, &token, &[], &progress)).await;
    assert!(head.contains("content-type: text/event-stream"));
    let messages = sse_messages(&body);
    assert!(messages.iter().any(|m| m["method"] == "notifications/progress" && m["params"]["progressToken"] == "p"), "{body}");
    assert_eq!(messages.last().unwrap()["result"]["content"][0]["text"], r#"{"event":"timeout"}"#);
}

/// The spike question "cancellation via body drop": a client that goes away must end its call (1.1.4: res 'close').
#[tokio::test]
async fn a_vanished_json_client_aborts_its_call() {
    let (server, fake) = start().await;
    let token = server.issue_token("cell-lead");
    let from = fake.events.all().len();
    let mut stream = TcpStream::connect(addr(&server.url)).await.unwrap();
    let raw = request(&server.url, &token, &[], &call(1, json!({ "timeoutSec": 30 }))).replace("Connection: close\r\n", "");
    stream.write_all(raw.as_bytes()).await.unwrap();
    assert!(wait_event(&fake, from, "call-start", Duration::from_secs(2)).await.is_some());
    let closed = Instant::now();
    drop(stream);
    let end = wait_event(&fake, from, "call-end", Duration::from_secs(3)).await.expect("the server noticed the vanished client");
    assert_eq!(end["outcome"], "aborted");
    assert!(closed.elapsed() < Duration::from_secs(1), "noticed after {:?}", closed.elapsed());
}

#[tokio::test]
async fn a_vanished_sse_client_aborts_its_call() {
    let (server, fake) = start().await;
    let token = server.issue_token("cell-lead");
    let from = fake.events.all().len();
    let mut stream = TcpStream::connect(addr(&server.url)).await.unwrap();
    let mut body = call(1, json!({ "timeoutSec": 30 }));
    body["params"]["_meta"] = json!({ "progressToken": 1 });
    stream.write_all(request(&server.url, &token, &[], &body).replace("Connection: close\r\n", "").as_bytes()).await.unwrap();
    assert!(wait_event(&fake, from, "call-start", Duration::from_secs(2)).await.is_some());
    let closed = Instant::now();
    drop(stream);
    let end = wait_event(&fake, from, "call-end", Duration::from_secs(3)).await.expect("the server noticed the vanished client");
    assert_eq!(end["outcome"], "aborted");
    assert!(closed.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
async fn revoking_a_token_aborts_its_running_call_and_task() {
    let (server, fake) = start().await;
    let token = server.issue_token("cell-lead");
    let from = fake.events.all().len();
    let url = server.url.clone();
    let t = token.clone();
    let running =
        tokio::spawn(async move { exchange(&url, request(&url, &t, &[], &call(1, json!({ "timeoutSec": 30 })))).await });
    let mut task = call(2, json!({ "timeoutSec": 30 }));
    task["params"]["task"] = json!({});
    let (_, _, created) = exchange(&server.url, request(&server.url, &token, &[], &task)).await;
    let created: Value = serde_json::from_str(&created).unwrap();
    assert_eq!(created["result"]["task"]["status"], "working");
    assert_eq!(created["result"]["task"]["ttl"], 3_600_000);
    assert_eq!(created["result"]["task"]["pollInterval"], 2000);
    tokio::time::sleep(Duration::from_millis(200)).await;
    server.revoke_cell("cell-lead");
    let ends = Instant::now() + Duration::from_secs(2);
    while fake.events.all().into_iter().skip(from).filter(|e| e["kind"] == "call-end" && e["outcome"] == "aborted").count() < 2 {
        assert!(Instant::now() < ends, "both calls end on revoke");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    let (status, _, body) = running.await.unwrap();
    assert_eq!(status, 200);
    assert!(body.contains("Agent connection has expired.") || body.contains("aborted"), "{body}");
}

#[tokio::test]
async fn session_elicitation_round_trip() {
    let (server, fake) = start().await;
    let token = server.issue_token("cell-lead");
    let init = json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": { "protocolVersion": "2025-11-25", "capabilities": { "elicitation": { "form": {} } }, "clientInfo": { "name": "t", "version": "1" } } });
    let (status, head, body) = exchange(&server.url, request(&server.url, &token, &[], &init)).await;
    assert_eq!(status, 200);
    let session = head.lines().find_map(|l| l.strip_prefix("mcp-session-id: ")).unwrap().trim().to_string();
    assert_eq!(sse_messages(&body)[0]["result"]["capabilities"]["tasks"]["requests"]["tools"]["call"], json!({}));
    let headers = [("Mcp-Session-Id", session.as_str()), ("Mcp-Protocol-Version", "2025-11-25")];
    // close_grid asks; the answer comes back as its own POST of the session.
    let ask = json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "close_grid", "arguments": { "gridId": "grid-side" } } });
    let mut stream = TcpStream::connect(addr(&server.url)).await.unwrap();
    stream.write_all(request(&server.url, &token, &headers, &ask).as_bytes()).await.unwrap();
    let mut seen = String::new();
    let mut buf = [0u8; 4096];
    let elicit = loop {
        let n = stream.read(&mut buf).await.unwrap();
        assert!(n > 0, "stream ended before the elicitation: {seen}");
        seen.push_str(&String::from_utf8_lossy(&buf[..n]));
        if let Some(line) = seen.lines().find(|l| l.contains("elicitation/create")) {
            break serde_json::from_str::<Value>(line.trim_start_matches(|c: char| c != '{')).unwrap();
        }
    };
    assert_eq!(elicit["params"]["mode"], "form");
    assert_eq!(elicit["id"], 0);
    let answer =
        json!({ "jsonrpc": "2.0", "id": elicit["id"], "result": { "action": "accept", "content": { "confirm": true } } });
    assert_eq!(exchange(&server.url, request(&server.url, &token, &headers, &answer)).await.0, 202);
    let mut rest = Vec::new();
    stream.read_to_end(&mut rest).await.unwrap();
    seen.push_str(&String::from_utf8_lossy(&rest));
    assert!(seen.contains(r#"{\"archived\":\"grid-side\",\"stopped\":1}"#), "{seen}");
    assert!(fake.events.all().iter().any(|e| e["kind"] == "elicit" && e["action"] == "accept"));
    assert_eq!(server.session_count(), 1);
}

/// A token revoked while an initialize body is still arriving must not end up with a session (mcp.ts: 401 after the SDK
/// loaded when `tokens.get(token) !== actorId`).
#[tokio::test]
async fn a_token_revoked_mid_body_gets_no_session() {
    let (server, _) = start().await;
    let token = server.issue_token("cell-lead");
    let raw = request(&server.url, &token, &[], &initialize());
    let (head, body) = raw.split_once("\r\n\r\n").unwrap();
    let mut stream = TcpStream::connect(addr(&server.url)).await.unwrap();
    stream.write_all(format!("{head}\r\n\r\n{}", &body[..10]).as_bytes()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    server.revoke_cell("cell-lead");
    stream.write_all(&body.as_bytes()[10..]).await.unwrap();
    let mut out = Vec::new();
    stream.read_to_end(&mut out).await.unwrap();
    let text = String::from_utf8_lossy(&out);
    assert!(text.starts_with("HTTP/1.1 401"), "{text}");
    assert!(!text.to_ascii_lowercase().contains("mcp-session-id"), "{text}");
    assert_eq!(server.session_count(), 0);
}

/// InMemoryTaskStore: the ttl restarts when the result is stored, and mcp.ts aborts a working task once it is gone.
#[tokio::test]
async fn task_ttl_restarts_on_completion_and_expiry_aborts_a_working_task() {
    let (server, fake) = start_with(custom::Config { min_task_ttl: Duration::ZERO, ..custom::Config::default() }).await;
    let token = server.issue_token("cell-lead");
    let from = fake.events.all().len();
    let task = |id: u64, timeout: f64, ttl: u64| {
        let mut body = call(id, json!({ "timeoutSec": timeout }));
        body["params"]["task"] = json!({ "ttl": ttl });
        body
    };
    let get = |id: &str| json!({ "jsonrpc": "2.0", "id": 9, "method": "tasks/get", "params": { "taskId": id } });
    let long = json_call(&server.url, &token, &task(1, 30.0, 600)).await;
    let long = long["result"]["task"]["taskId"].as_str().unwrap().to_string();
    let short = json_call(&server.url, &token, &task(2, 0.5, 800)).await;
    let short = short["result"]["task"]["taskId"].as_str().unwrap().to_string();
    let started = Instant::now();
    // The long one expires at 600 ms while it still works: gone, and its call aborted.
    let end = wait_event(&fake, from, "call-end", Duration::from_secs(3)).await.unwrap();
    assert_eq!(end["outcome"], "ok", "the short call ends first (500 ms)");
    tokio::time::sleep_until(tokio::time::Instant::from_std(started + Duration::from_millis(900))).await;
    let ends: Vec<Value> = fake.events.all().into_iter().skip(from).filter(|e| e["kind"] == "call-end").collect();
    assert_eq!(ends.len(), 2, "the expired working task's call was aborted: {ends:?}");
    assert_eq!(ends[1]["outcome"], "aborted");
    assert_eq!(json_call(&server.url, &token, &get(&long)).await["error"]["code"], -32602);
    // The short one completed at ~500 ms; created + ttl (800 ms) has passed, completion + ttl (~1300 ms) has not.
    tokio::time::sleep_until(tokio::time::Instant::from_std(started + Duration::from_millis(1000))).await;
    assert_eq!(json_call(&server.url, &token, &get(&short)).await["result"]["status"], "completed");
    tokio::time::sleep_until(tokio::time::Instant::from_std(started + Duration::from_millis(1700))).await;
    assert_eq!(json_call(&server.url, &token, &get(&short)).await["error"]["code"], -32602);
}

/// An unanswered elicitation times out: the server sends `notifications/cancelled` for it on the call's stream (SDK
/// Protocol.request timeout), and the call goes on with `cancel`.
#[tokio::test]
async fn an_elicitation_timeout_sends_notifications_cancelled() {
    let (server, _) =
        start_with(custom::Config { elicit_timeout: Duration::from_millis(300), ..custom::Config::default() }).await;
    let token = server.issue_token("cell-lead");
    let session = open_session(&server.url, &token).await;
    let headers = [("Mcp-Session-Id", session.as_str()), ("Mcp-Protocol-Version", "2025-11-25")];
    let ask = json!({ "jsonrpc": "2.0", "id": 5, "method": "tools/call", "params": { "name": "close_grid", "arguments": { "gridId": "grid-side" } } });
    let (status, _, body) = exchange(&server.url, request(&server.url, &token, &headers, &ask)).await;
    assert_eq!(status, 200);
    let messages = sse_messages(&body);
    assert_eq!(messages.len(), 3, "{body}");
    assert_eq!(messages[0]["method"], "elicitation/create");
    assert_eq!(
        messages[1],
        json!({ "jsonrpc": "2.0", "method": "notifications/cancelled",
            "params": { "requestId": messages[0]["id"], "reason": "McpError: MCP error -32001: Request timed out" } })
    );
    assert_eq!(messages[2]["id"], 5);
    assert_eq!(messages[2]["result"]["isError"], true);
}

/// The rmcp candidate keeps a session call running after its client went away (no abort before the tool's own end).
#[tokio::test]
async fn rmcp_does_not_abort_a_vanished_session_call() {
    let fake = Arc::new(fake::Fake::new(&fixture()));
    let server = rmcp_impl::RmcpServer::start(fake.clone(), "1.2.0".into(), Duration::from_secs(10)).await.unwrap();
    let token = server.issue_token("cell-lead");
    let init = json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize",
        "params": { "protocolVersion": "2025-11-25", "capabilities": { "elicitation": { "form": {} } }, "clientInfo": { "name": "t", "version": "1" } } });
    let (_, head, _) = exchange(&server.url, request(&server.url, &token, &[], &init)).await;
    let session = head.lines().find_map(|l| l.strip_prefix("mcp-session-id: ")).unwrap().trim().to_string();
    let headers = [("Mcp-Session-Id", session.as_str()), ("Mcp-Protocol-Version", "2025-11-25")];
    let note = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
    exchange(&server.url, request(&server.url, &token, &headers, &note)).await;
    let from = fake.events.all().len();
    let mut stream = TcpStream::connect(addr(&server.url)).await.unwrap();
    stream.write_all(request(&server.url, &token, &headers, &call(1, json!({ "timeoutSec": 30 }))).as_bytes()).await.unwrap();
    assert!(wait_event(&fake, from, "call-start", Duration::from_secs(2)).await.is_some());
    drop(stream);
    assert!(wait_event(&fake, from, "call-end", Duration::from_secs(3)).await.is_none(), "rmcp aborted the call (gap closed?)");
}
