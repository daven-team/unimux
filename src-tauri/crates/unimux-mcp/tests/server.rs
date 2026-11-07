//! HTTP-level behaviour of the MCP server that the 52 protocol cases (tests/protocol.rs) do not drive: the 1.1.4 vitest
//! cases of mcp.test.ts, mcp-protocol.test.ts ('server hardening', revoke, disconnect), mcp-lazy.test.ts and the session /
//! task cases of mcp-tasks-elicit.test.ts (rows in test/PORTING.md), plus the SP8 checks with a shortened config (ttl
//! expiry, elicitation timeout, mid-body revoke) and the timeouts, limits and keepalive SP8 left untested.

mod support;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Value, json};
use support::fake::Fake;
use support::http::{ACCEPT, Flow};
use support::{LEAD, Srv, WORKER, call, init, wait_for};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use unimux_mcp::{Config, Connection, McpServer};

fn quick() -> Config {
    Config { rate: None, progress_every: Duration::from_millis(300), ..Config::default() }
}

fn ping(id: u64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "ping" })
}

fn tools_list(id: u64) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": "tools/list" })
}

/// Reads a raw answer to the end.
async fn raw_exchange(addr: &str, bytes: &[u8]) -> String {
    let mut stream = TcpStream::connect(addr).await.unwrap();
    stream.write_all(bytes).await.unwrap();
    let mut out = Vec::new();
    let _ = stream.read_to_end(&mut out).await;
    String::from_utf8_lossy(&out).to_string()
}

// ---------- mcp.test.ts ----------

#[tokio::test]
async fn rejects_missing_credentials_foreign_origins_and_invalid_hosts_before_handling_tools() {
    let srv = Srv::start(quick()).await;
    assert_eq!(srv.req("POST", "/mcp").send().await.status, 401);
    let auth = format!("Bearer {}", srv.issue(WORKER));
    let r = srv.req("POST", "/mcp").header("authorization", &auth).header("origin", "https://untrusted.example").send().await;
    assert_eq!(r.status, 403);
    let r = srv.req("POST", "/mcp").header("authorization", &auth).header("host", "untrusted.example").send().await;
    assert_eq!(r.status, 403);
    assert_eq!(srv.req("GET", "/mcp").header("authorization", &auth).send().await.status, 405);
    assert!(srv.fake.events.all().is_empty(), "no tool ran");
}

#[tokio::test]
async fn limits_request_bodies_without_modifying_application_state() {
    let srv = Srv::start(quick()).await;
    let body = call(1, "save_snippet", json!({ "name": "Too large", "text": "x".repeat(300_000) }));
    let r = srv.post(&srv.issue(LEAD), body).await;
    assert_eq!(r.status, 413);
    assert_eq!(r.text, r#"{"jsonrpc":"2.0","error":{"code":-32000,"message":"Request body too large."},"id":null}"#);
    assert!(srv.fake.events.all().is_empty());
}

#[tokio::test]
async fn distinguishes_configured_tokens_from_authenticated_connections_and_clears_on_revoke_and_stop() {
    let srv = Srv::start(quick()).await;
    let changes = Arc::new(AtomicUsize::new(0));
    let c = changes.clone();
    srv.server.on_change(move || {
        c.fetch_add(1, Ordering::SeqCst);
    });
    assert_eq!(srv.server.connection(WORKER), Connection::Off);
    let token = srv.issue(WORKER);
    assert_eq!(changes.load(Ordering::SeqCst), 1);
    let info = srv.server.info();
    assert_eq!(info["running"], true);
    assert_eq!(info["url"], json!(srv.url));
    assert_eq!((info["configuredCellIds"].clone(), info["connectedCellIds"].clone()), (json!([WORKER]), json!([])));
    assert_eq!(srv.server.connection(WORKER), Connection::Waiting);
    srv.req("POST", "/mcp").header("authorization", "Bearer bad").send().await;
    srv.req("GET", "/mcp").header("authorization", &format!("Bearer {token}")).send().await; // 405: not a working client
    // An initialize alone does not count: only a tool list (or call) that succeeded shows the client really works.
    srv.post(&token, init(json!({}))).await;
    assert_eq!(srv.server.info()["connectedCellIds"], json!([]));
    srv.post(&token, tools_list(1)).await;
    assert_eq!(srv.server.info()["connectedCellIds"], json!([WORKER]));
    assert_eq!(srv.server.connection(WORKER), Connection::Connected);
    assert_eq!(changes.load(Ordering::SeqCst), 2, "the first sighting is a change");
    srv.post(&token, tools_list(2)).await;
    assert_eq!(changes.load(Ordering::SeqCst), 2, "a later sighting within 10 minutes is not");
    srv.issue(WORKER);
    let info = srv.server.info();
    assert_eq!((info["configuredCellIds"].clone(), info["connectedCellIds"].clone()), (json!([WORKER]), json!([])));
    srv.server.revoke_cell(WORKER);
    let info = srv.server.info();
    assert_eq!((info["configuredCellIds"].clone(), info["connectedCellIds"].clone()), (json!([]), json!([])));
    assert_eq!(srv.server.connection(WORKER), Connection::Off);
    srv.issue(LEAD);
    srv.server.stop();
    assert_eq!(srv.server.info(), json!({ "running": false, "configuredCellIds": [], "connectedCellIds": [] }));
}

#[tokio::test]
async fn a_cell_counts_as_connected_for_ten_minutes_after_its_last_tool_use() {
    let clock = Arc::new(Mutex::new(0.0f64));
    let c = clock.clone();
    let srv = Srv::start(Config { now: Arc::new(move || *c.lock()), ..quick() }).await;
    let token = srv.issue(WORKER);
    srv.post(&token, call(1, "get_context", json!({}))).await;
    assert_eq!(srv.server.info()["connectedCellIds"], json!([WORKER]));
    *clock.lock() += 10.0 * 60_000.0 - 1.0;
    assert_eq!(srv.server.info()["connectedCellIds"], json!([WORKER]));
    *clock.lock() += 1.0;
    assert_eq!(srv.server.info()["connectedCellIds"], json!([]));
    // A tool error still means the client works.
    srv.post(&token, call(2, "update_task", json!({ "taskId": "x" }))).await;
    assert_eq!(srv.server.info()["connectedCellIds"], json!([WORKER]));
}

// ---------- mcp-lazy.test.ts ----------

#[tokio::test]
async fn a_failed_listen_rejects_and_a_retry_starts_the_server() {
    let srv = Srv::start(quick()).await;
    srv.server.stop();
    srv.server.fail_next_listen("listen EACCES: permission denied 127.0.0.1");
    let err = srv.server.start().await.unwrap_err();
    assert!(err.to_string().contains("EACCES"));
    assert_eq!(srv.server.info()["running"], false);
    srv.server.start().await.unwrap();
    assert_eq!(srv.server.info()["running"], true);
    let url = srv.server.url().unwrap();
    let addr = url.trim_start_matches("http://").trim_end_matches("/mcp");
    let token = srv.issue(WORKER);
    let r = support::http::Request::new(addr, "POST", "/mcp")
        .header("content-type", "application/json")
        .header("accept", ACCEPT)
        .header("authorization", &format!("Bearer {token}"))
        .body(ping(1))
        .send()
        .await;
    assert_eq!(r.status, 200);
}

#[tokio::test]
async fn a_start_while_another_start_runs_joins_it() {
    let server = Arc::new(McpServer::new(Fake::from_fixture_file(), quick()));
    let (a, b, c) = (server.clone(), server.clone(), server.clone());
    let (ra, rb, rc) = tokio::join!(a.start(), b.start(), c.start());
    assert!(ra.is_ok() && rb.is_ok() && rc.is_ok());
    let url = server.url();
    assert!(url.is_some());
    server.start().await.unwrap();
    assert_eq!(server.url(), url);
    server.stop();
    assert_eq!(server.url(), None);
}

// ---------- mcp-protocol.test.ts ----------

#[tokio::test]
async fn initializes_statelessly_with_the_instructions_and_text_only_json_results() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(WORKER);
    let r = srv.post(&token, init(json!({}))).await;
    assert_eq!(r.session(), None);
    assert!(r.content_type().unwrap().contains("application/json"));
    let result = &r.json()["result"];
    assert_eq!(result["serverInfo"]["name"], "unimux");
    assert_eq!(
        result["capabilities"],
        json!({ "tools": {}, "tasks": { "list": {}, "cancel": {}, "requests": { "tools": { "call": {} } } } })
    );
    assert_eq!(result["instructions"], json!(srv.fake.instructions));
    let r = srv.post(&token, call(1, "get_context", json!({}))).await;
    let result = &r.json()["result"];
    assert!(result.get("structuredContent").is_none());
    assert_eq!(result["content"][0]["type"], "text");
    assert_eq!(result["content"].as_array().unwrap().len(), 1);
    let r = srv.post(&srv.issue("cell-reviewer"), ping(1)).await;
    assert_eq!(r.session(), None);
    assert_eq!(r.text, r#"{"result":{},"jsonrpc":"2.0","id":1}"#);
}

#[tokio::test]
async fn an_empty_instruction_is_left_out_of_initialize() {
    let srv = Srv::start_with(Fake::new(&json!({ "tools": [], "instructions": "" })), quick()).await;
    let r = srv.post(&srv.issue(LEAD), init(json!({}))).await;
    assert!(r.json()["result"].get("instructions").is_none(), "{}", r.text);
}

#[tokio::test]
async fn stops_listing_tools_when_mcp_is_disabled_for_the_cell_and_refuses_calls() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(WORKER);
    assert!(!srv.post(&token, tools_list(1)).await.json()["result"]["tools"].as_array().unwrap().is_empty());
    srv.fake.no_role.lock().insert(WORKER.to_string());
    assert_eq!(srv.post(&token, tools_list(2)).await.json()["result"]["tools"], json!([]));
    assert_eq!(srv.post(&token, call(3, "get_context", json!({}))).await.json()["result"]["isError"], true);
}

#[tokio::test]
async fn handles_concurrent_calls_and_a_body_up_to_the_limit() {
    let srv = Srv::start(Config { max_in_flight_per_token: 64, ..quick() }).await;
    let token = srv.issue(LEAD);
    let calls = (0..50).map(|i| srv.post(&token, call(i, if i % 2 == 1 { "get_context" } else { "list_agents" }, json!({}))));
    let results = futures::future::join_all(calls).await;
    assert!(results.iter().all(|r| r.status == 200 && r.json()["result"].get("isError").is_none()));
    // Exactly 256 KB is accepted (the limit is inclusive), one byte more is 413.
    let pad = |n: usize| {
        let head = r#"{"jsonrpc":"2.0","id":1,"method":"ping","params":{"pad":""#;
        let tail = r#""}}"#;
        format!("{head}{}{tail}", "x".repeat(n - head.len() - tail.len()))
    };
    assert_eq!(srv.post(&token, pad(256 * 1024).as_str()).await.status, 200);
    assert_eq!(srv.post(&token, pad(256 * 1024 + 1).as_str()).await.status, 413);
}

#[tokio::test]
async fn rejects_revoked_tokens_at_the_http_layer_and_mid_session() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(WORKER);
    assert_eq!(srv.post(&token, ping(1)).await.status, 200);
    srv.server.revoke_cell(WORKER);
    assert_eq!(srv.post(&token, ping(1)).await.status, 401);
    let second = srv.issue(WORKER);
    srv.issue(WORKER);
    assert_eq!(srv.post(&second, ping(1)).await.status, 401);
}

#[tokio::test]
async fn stops_waiting_when_the_client_disconnects_and_frees_the_request_slot() {
    let srv = Srv::start(Config { max_in_flight_per_token: 1, ..quick() }).await;
    let token = srv.issue(WORKER);
    let waiting = srv.post_req(&token, wait_for(1, 30.0)).send_and_drop(Duration::from_millis(400));
    let checked = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        // The waiting request occupies the only slot...
        assert_eq!(srv.post(&token, ping(2)).await.status, 429);
    };
    tokio::join!(waiting, checked);
    // ...and releases it as soon as the client is gone, long before the 30 s wait would end.
    let started = Instant::now();
    let mut status = 429;
    while status == 429 && started.elapsed() < Duration::from_secs(3) {
        status = srv.post(&token, ping(3)).await.status;
        if status == 429 {
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
    assert_eq!(status, 200);
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
async fn ends_an_in_flight_wait_for_with_an_expiry_error_when_its_token_is_revoked() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(WORKER);
    let started = Instant::now();
    let revoke = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        srv.server.revoke_cell(WORKER);
    };
    let (r, ()) = tokio::join!(srv.post(&token, wait_for(1, 30.0)), revoke);
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(
        r.json()["result"],
        json!({ "isError": true, "content": [{ "type": "text", "text": "Agent connection has expired." }] })
    );
    // Re-issuing a token (cell restart) ends the old agent's wait the same way.
    let first = srv.issue("cell-reviewer");
    let reissue = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        srv.issue("cell-reviewer");
    };
    let (r, ()) = tokio::join!(srv.post(&first, wait_for(1, 30.0)), reissue);
    assert_eq!(r.json()["result"]["isError"], true);
}

#[tokio::test]
async fn listens_on_loopback_only_and_issues_unique_256_bit_tokens() {
    let srv = Srv::start(quick()).await;
    assert!(srv.url.starts_with("http://127.0.0.1:"));
    let mut seen = std::collections::HashSet::new();
    for i in 0..200 {
        seen.insert(srv.issue(&format!("cell-{i}")));
    }
    assert_eq!(seen.len(), 200);
    assert!(seen.iter().all(|t| t.len() == 64 && t.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))));
}

#[tokio::test]
async fn does_not_grow_with_issued_and_revoked_tokens() {
    let srv = Srv::start(Config { rate: Some((120.0, 60.0)), ..quick() }).await;
    for i in 0..5000 {
        let token = srv.issue(&format!("cell-{}", i % 50));
        if i % 500 == 0 {
            srv.post(&token, ping(1)).await;
        }
    }
    assert_eq!(srv.server.info()["configuredCellIds"].as_array().unwrap().len(), 50);
    for i in 0..50 {
        srv.server.revoke_cell(&format!("cell-{i}"));
    }
    assert_eq!(srv.server.info()["configuredCellIds"], json!([]));
    assert_eq!(srv.server.table_sizes(), [0, 0, 0, 0]);
}

#[tokio::test]
async fn rate_limits_per_token_with_a_monotonic_clock() {
    let clock = Arc::new(Mutex::new(1000.0f64));
    let c = clock.clone();
    let srv = Srv::start(Config { rate: Some((5.0, 1.0)), now: Arc::new(move || *c.lock()), ..quick() }).await;
    let a = srv.issue(WORKER);
    let b = srv.issue("cell-reviewer");
    let run = |n: usize| {
        let srv = &srv;
        let a = a.clone();
        async move {
            let mut out = Vec::new();
            for _ in 0..n {
                out.push(srv.post(&a, ping(1)).await.status);
            }
            out
        }
    };
    assert_eq!(run(7).await, [200, 200, 200, 200, 200, 429, 429]);
    assert_eq!(srv.post(&b, ping(1)).await.status, 200);
    let limited = srv.post(&a, ping(1)).await;
    assert_eq!((limited.status, limited.header("retry-after")), (429, Some("1")));
    *clock.lock() += 2000.0;
    assert_eq!(run(3).await, [200, 200, 429]);
    // The clock jumps back an hour: nothing is refilled (and nothing breaks), the new time is the reference.
    *clock.lock() -= 3_600_000.0;
    assert_eq!(run(2).await, [429, 429]);
    *clock.lock() += 1000.0;
    assert_eq!(run(2).await, [200, 429]);
    // A long idle period refills up to the burst only.
    *clock.lock() += 10_000_000.0;
    assert_eq!(run(7).await, [200, 200, 200, 200, 200, 429, 429]);
}

#[tokio::test]
async fn does_not_spend_rate_budget_on_requests_rejected_by_the_in_flight_cap() {
    let srv =
        Srv::start(Config { rate: Some((3.0, 0.0001)), max_in_flight_per_token: 1, now: Arc::new(|| 0.0), ..quick() }).await;
    let token = srv.issue(WORKER);
    let rejected = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        for i in 0..10 {
            assert_eq!(srv.post(&token, ping(10 + i)).await.status, 429);
        }
    };
    tokio::join!(srv.post(&token, wait_for(1, 1.0)), rejected);
    // One token went to the wait_for, none to the ten rejected pings: two pings remain.
    let mut out = Vec::new();
    for i in 2..5 {
        out.push(srv.post(&token, ping(i)).await.status);
    }
    assert_eq!(out, [200, 200, 429]);
}

#[tokio::test]
async fn caps_simultaneous_requests_per_token_so_a_waiting_agent_cannot_exhaust_the_server() {
    let srv = Srv::start(Config { max_in_flight_per_token: 2, ..quick() }).await;
    let token = srv.issue(WORKER);
    let other = srv.issue("cell-reviewer");
    let checks = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert_eq!(srv.post(&token, ping(9)).await.status, 429);
        // Another cell is unaffected.
        assert_eq!(srv.post(&other, ping(9)).await.status, 200);
    };
    tokio::join!(srv.post(&token, wait_for(1, 2.0)), srv.post(&token, wait_for(2, 2.0)), checks);
    assert_eq!(srv.post(&token, ping(10)).await.status, 200);
}

#[tokio::test]
async fn caps_simultaneous_stateless_requests_in_total() {
    let srv = Srv::start(Config { max_in_flight: 2, ..quick() }).await;
    let (a, b, c) = (srv.issue("cell-a"), srv.issue("cell-b"), srv.issue("cell-c"));
    let checks = async {
        tokio::time::sleep(Duration::from_millis(200)).await;
        let r = srv.post(&c, ping(9)).await;
        assert_eq!((r.status, r.header("retry-after")), (429, Some("1")));
    };
    tokio::join!(srv.post(&a, wait_for(1, 1.0)), srv.post(&b, wait_for(2, 1.0)), checks);
    assert_eq!(srv.post(&c, ping(10)).await.status, 200);
}

#[tokio::test]
async fn rejects_foreign_host_and_origin_headers_other_paths_and_methods_and_oversize_bodies() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(WORKER);
    let auth = format!("Bearer {token}");
    let port = srv.addr.rsplit(':').next().unwrap().to_string();
    let status = |host: Option<&str>, origin: Option<&str>, path: &'static str, method: &'static str| {
        let mut r = srv.req(method, path).header("authorization", &auth);
        if let Some(h) = host {
            r = r.header("host", h);
        }
        if let Some(o) = origin {
            r = r.header("origin", o);
        }
        async move { r.send().await.status }
    };
    assert_eq!(status(Some("evil.example"), None, "/mcp", "POST").await, 403);
    assert_eq!(status(Some(&format!("evil.example:{port}")), None, "/mcp", "POST").await, 403);
    assert_eq!(status(None, Some("null"), "/mcp", "POST").await, 403);
    assert_eq!(status(None, Some("https://evil.example"), "/mcp", "POST").await, 403);
    assert_eq!(status(None, None, "/other", "POST").await, 404);
    assert_eq!(status(None, None, "/mcp", "DELETE").await, 405);
    assert_eq!(status(None, None, "/mcp", "GET").await, 405);
    // An empty Origin is no Origin (mcp.ts: `if (req.headers.origin && ...)`), localhost is a local origin.
    assert_ne!(status(None, Some(""), "/mcp", "POST").await, 403);
    assert_ne!(status(Some(&format!("localhost:{port}")), Some(&format!("http://localhost:{port}")), "/mcp", "POST").await, 403);
    assert_eq!(srv.req("POST", "/mcp").header("authorization", "Basic abc").send().await.status, 401);
    let big = call(1, "snippets", json!({ "action": "save", "name": "x", "text": "x".repeat(300_000) }));
    assert_eq!(srv.post(&token, big).await.status, 413);
    // An absolute-form request target is not `/mcp` for Node either.
    let raw = format!(
        "POST http://127.0.0.1:{port}/mcp HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: {auth}\r\nConnection: close\r\n\r\n"
    );
    assert!(raw_exchange(&srv.addr, raw.as_bytes()).await.starts_with("HTTP/1.1 404"));
}

#[tokio::test]
async fn never_echoes_the_bearer_token_in_responses() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(WORKER);
    let mut bodies = Vec::new();
    for body in [
        call(1, "bogus", json!({})),
        json!({ "jsonrpc": "2.0", "id": 2, "method": "nope" }),
        call(3, "update_task", json!({ "taskId": 5 })),
    ] {
        bodies.push(srv.post(&token, body).await.text);
    }
    let malformed = srv.post(&token, "{not json").await;
    assert_eq!(malformed.status, 400);
    bodies.push(malformed.text);
    assert!(bodies.iter().all(|b| !b.contains(&token)));
}

#[tokio::test]
async fn answers_tools_list_quickly_and_cheaply_for_repeated_calls() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(LEAD);
    let started = Instant::now();
    for i in 0..100 {
        assert_eq!(srv.post(&token, tools_list(i)).await.status, 200);
    }
    assert!(started.elapsed() / 100 < Duration::from_millis(25), "{:?} per call", started.elapsed() / 100);
}

// ---------- mcp-tasks-elicit.test.ts (sessions, tasks) ----------

#[tokio::test]
async fn gives_an_elicitation_client_a_session_and_leaves_other_clients_stateless() {
    let srv = Srv::start(quick()).await;
    let lead = srv.issue(LEAD);
    let r = srv.post(&lead, init(json!({ "elicitation": { "form": {} } }))).await;
    let session = r.session().unwrap();
    assert!(session.len() == 36 && session.bytes().all(|b| b == b'-' || b.is_ascii_hexdigit()));
    assert!(r.content_type().unwrap().starts_with("text/event-stream"));
    assert_eq!(srv.post(&srv.issue(WORKER), init(json!({}))).await.session(), None);
    assert_eq!(srv.server.session_count(), 1);
    let tools = srv.in_session(&lead, &session, tools_list(1)).await.json();
    assert!(tools["result"]["tools"].as_array().unwrap().iter().any(|t| t["name"] == "create_grid"));
}

#[tokio::test]
async fn refuses_a_session_id_under_another_token_and_closes_the_sessions_of_a_revoked_token() {
    let srv = Srv::start(quick()).await;
    let lead = srv.issue(LEAD);
    let session = srv.session(&lead).await;
    let other = srv.issue(WORKER);
    assert_eq!(srv.in_session(&other, &session, tools_list(7)).await.status, 404);
    srv.server.revoke_cell(LEAD);
    assert_eq!(srv.server.session_count(), 0);
    let again = srv.post_req(&lead, tools_list(8)).header("mcp-session-id", &session).send().await;
    assert_eq!(again.status, 401);
}

#[tokio::test]
async fn keeps_at_most_four_sessions_per_token_and_ends_one_on_delete() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(LEAD);
    let mut sessions = Vec::new();
    for _ in 0..6 {
        sessions.push(srv.session(&token).await);
    }
    assert_eq!(srv.server.session_count(), 4);
    let r = srv
        .req("DELETE", "/mcp")
        .header("authorization", &format!("Bearer {token}"))
        .header("mcp-session-id", &sessions[5])
        .send()
        .await;
    assert_eq!(r.status, 200);
    assert_eq!(srv.server.session_count(), 3);
}

/// Above 256 sessions an elicitation client is served stateless (mcp.ts `this.sessions.size < MAX_SESSIONS`).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn above_256_sessions_a_client_is_served_stateless() {
    let srv = Srv::start(quick()).await;
    for cell in 0..64 {
        let token = srv.issue(&format!("cell-{cell}"));
        for _ in 0..4 {
            srv.session(&token).await;
        }
    }
    assert_eq!(srv.server.session_count(), 256);
    let r = srv.post(&srv.issue("cell-late"), init(json!({ "elicitation": { "form": {} } }))).await;
    assert_eq!((r.status, r.session(), r.content_type()), (200, None, Some("application/json")));
    assert_eq!(srv.server.session_count(), 256);
}

#[tokio::test]
async fn keeps_a_task_private_to_its_token_ends_it_when_the_client_cancels_and_when_the_token_is_revoked() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(WORKER);
    let task_call = |id: u64| {
        let mut body = wait_for(id, 600.0);
        body["params"]["task"] = json!({ "ttl": 120000 });
        body
    };
    let get = |task: &Value| json!({ "jsonrpc": "2.0", "id": 9, "method": "tasks/get", "params": { "taskId": task } });
    let task = srv.post(&token, task_call(1)).await.json()["result"]["task"]["taskId"].clone();
    let other = srv.issue("cell-reviewer");
    assert_eq!(srv.post(&other, get(&task)).await.json()["error"]["code"], -32602);
    let cancel = json!({ "jsonrpc": "2.0", "id": 3, "method": "tasks/cancel", "params": { "taskId": task } });
    assert_eq!(srv.post(&token, cancel).await.json()["result"]["status"], "cancelled");
    assert_eq!(srv.post(&token, get(&task)).await.json()["result"]["status"], "cancelled");
    let second = srv.post(&token, task_call(4)).await.json()["result"]["task"]["taskId"].clone();
    srv.server.revoke_cell(WORKER);
    let fresh = srv.issue(WORKER);
    // The new token's store starts empty: the old task is gone with its token.
    assert_eq!(srv.post(&fresh, get(&second)).await.json()["error"]["code"], -32602);
}

#[tokio::test]
async fn refuses_task_mode_for_tools_that_do_not_support_it() {
    let srv = Srv::start(quick()).await;
    let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "read_inbox", "arguments": {}, "task": {} } });
    let r = srv.post(&srv.issue(WORKER), body).await.json();
    assert_eq!(r["error"], json!({ "code": -32601, "message": "MCP error -32601: Tool read_inbox does not run as a task." }));
}

#[tokio::test]
async fn at_most_16_tasks_of_a_token_run_at_once() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(WORKER);
    for i in 0..16 {
        let mut body = wait_for(i, 30.0);
        body["params"]["task"] = json!({});
        assert_eq!(srv.post(&token, body).await.json()["result"]["task"]["status"], "working");
    }
    let mut body = wait_for(16, 30.0);
    body["params"]["task"] = json!({});
    let r = srv.post(&token, body).await.json();
    assert_eq!(r["error"]["message"], "MCP error -32600: At most 16 tasks may run at once; wait for one to finish.");
}

// ---------- SP8 checks (moved from tests/sp8_wire.rs) ----------

#[tokio::test]
async fn stateless_json_and_sse_progress() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(LEAD);
    let r = srv.post(&token, tools_list(1)).await;
    assert_eq!(r.status, 200);
    assert_eq!(r.content_type(), Some("application/json"));
    assert_eq!(r.session(), None);
    // The verbatim tools (execution.taskSupport kept), in the SDK's key order.
    assert!(r.text.starts_with(r#"{"result":{"tools":[{"name":""#), "{}", r.text);
    assert!(r.text.contains(r#""execution":{"taskSupport":"optional"}"#));
    let mut progress = wait_for(2, 1.0);
    progress["params"]["_meta"] = json!({ "progressToken": "p" });
    let r = srv.post(&token, progress).await;
    assert_eq!(r.content_type(), Some("text/event-stream"));
    let messages = r.messages();
    assert!(
        messages.iter().any(|m| m["method"] == "notifications/progress" && m["params"]["progressToken"] == "p"),
        "{}",
        r.text
    );
    assert_eq!(messages.last().unwrap()["result"]["content"][0]["text"], r#"{"event":"timeout"}"#);
}

/// The SDK sends one answer of a JSON-mode POST as an object, several as an array, and runs a batch's requests side by side.
#[tokio::test]
async fn a_batch_runs_side_by_side_and_one_answer_is_an_object() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(LEAD);
    let r = srv.post(&token, json!([ping(1), { "jsonrpc": "2.0", "method": "notifications/initialized" }])).await;
    assert_eq!(r.json(), json!({ "result": {}, "jsonrpc": "2.0", "id": 1 }));
    let started = Instant::now();
    let r = srv.post(&token, json!([wait_for(1, 1.0), wait_for(2, 1.0)])).await;
    assert_eq!(r.json().as_array().map(Vec::len), Some(2));
    assert!(started.elapsed() < Duration::from_millis(1800), "{:?}", started.elapsed());
}

/// The spike question "cancellation via body drop": a client that goes away must end its call (1.1.4: res 'close').
#[tokio::test]
async fn a_vanished_json_client_aborts_its_call() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(LEAD);
    let from = srv.fake.events.all().len();
    let mut stream = TcpStream::connect(&srv.addr).await.unwrap();
    stream.write_all(&srv.post_req(&token, wait_for(1, 30.0)).raw()).await.unwrap();
    assert!(srv.wait_event(from, |e| e["kind"] == "call-start", Duration::from_secs(2)).await.is_some());
    let closed = Instant::now();
    drop(stream);
    let end = srv.wait_event(from, |e| e["kind"] == "call-end", Duration::from_secs(3)).await.expect("noticed");
    assert_eq!(end["outcome"], "aborted");
    assert!(closed.elapsed() < Duration::from_secs(1), "noticed after {:?}", closed.elapsed());
}

#[tokio::test]
async fn a_vanished_sse_client_aborts_its_call() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(LEAD);
    let from = srv.fake.events.all().len();
    let mut body = wait_for(1, 30.0);
    body["params"]["_meta"] = json!({ "progressToken": 1 });
    let mut stream = TcpStream::connect(&srv.addr).await.unwrap();
    stream.write_all(&srv.post_req(&token, body).raw()).await.unwrap();
    assert!(srv.wait_event(from, |e| e["kind"] == "call-start", Duration::from_secs(2)).await.is_some());
    let closed = Instant::now();
    drop(stream);
    let end = srv.wait_event(from, |e| e["kind"] == "call-end", Duration::from_secs(3)).await.expect("noticed");
    assert_eq!(end["outcome"], "aborted");
    assert!(closed.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
async fn revoking_a_token_aborts_its_running_call_and_task() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(LEAD);
    let from = srv.fake.events.all().len();
    let mut task = wait_for(2, 30.0);
    task["params"]["task"] = json!({});
    let work = async {
        let created = srv.post(&token, task).await.json();
        assert_eq!(created["result"]["task"]["status"], "working");
        assert_eq!(created["result"]["task"]["ttl"], 3_600_000);
        assert_eq!(created["result"]["task"]["pollInterval"], 2000);
        tokio::time::sleep(Duration::from_millis(200)).await;
        srv.server.revoke_cell(LEAD);
    };
    let (running, ()) = tokio::join!(srv.post(&token, wait_for(1, 30.0)), work);
    let ends = Instant::now() + Duration::from_secs(2);
    while srv.fake.events.all().into_iter().skip(from).filter(|e| e["kind"] == "call-end" && e["outcome"] == "aborted").count()
        < 2
    {
        assert!(Instant::now() < ends, "both calls end on revoke");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(running.status, 200);
    assert!(running.text.contains("Agent connection has expired."), "{}", running.text);
}

#[tokio::test]
async fn session_elicitation_round_trip() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(LEAD);
    let r = srv.post(&token, init(json!({ "elicitation": { "form": {} } }))).await;
    let session = r.session().unwrap();
    assert_eq!(r.messages()[0]["result"]["capabilities"]["tasks"]["requests"]["tools"]["call"], json!({}));
    let ask = call(5, "close_grid", json!({ "gridId": "grid-side" }));
    let asked = Arc::new(Mutex::new(None::<Value>));
    let a = asked.clone();
    let (addr, t, s) = (srv.addr.clone(), token.clone(), session.clone());
    let res = srv
        .post_req(&token, ask)
        .header("mcp-session-id", &session)
        .header("mcp-protocol-version", "2025-11-25")
        .stream(Duration::from_secs(10), move |m| {
            if m["method"] == "elicitation/create" {
                *a.lock() = Some(m.clone());
                let answer =
                    json!({ "jsonrpc": "2.0", "id": m["id"], "result": { "action": "accept", "content": { "confirm": true } } });
                let (addr, t, s) = (addr.clone(), t.clone(), s.clone());
                tokio::spawn(async move {
                    let r = support::http::Request::new(&addr, "POST", "/mcp")
                        .header("content-type", "application/json")
                        .header("accept", ACCEPT)
                        .header("authorization", &format!("Bearer {t}"))
                        .header("mcp-session-id", &s)
                        .body(answer)
                        .send()
                        .await;
                    assert_eq!(r.status, 202);
                });
            }
            Flow::Continue
        })
        .await;
    let asked = asked.lock().clone().expect("asked");
    assert_eq!((asked["params"]["mode"].clone(), asked["id"].clone()), (json!("form"), json!(0)));
    assert!(res.text.contains(r#"{\"archived\":\"grid-side\",\"stopped\":1}"#), "{}", res.text);
    assert!(srv.fake.events.all().iter().any(|e| e["kind"] == "elicit" && e["action"] == "accept"));
    assert_eq!(srv.server.session_count(), 1);
}

/// A token revoked while an initialize body is still arriving must not end up with a session (mcp.ts: 401 after the SDK
/// loaded when `tokens.get(token) !== actorId`).
#[tokio::test]
async fn a_token_revoked_mid_body_gets_no_session() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(LEAD);
    let raw = srv.post_req(&token, init(json!({ "elicitation": { "form": {} } }))).raw();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4 + 10;
    let mut stream = TcpStream::connect(&srv.addr).await.unwrap();
    stream.write_all(&raw[..split]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(200)).await;
    srv.server.revoke_cell(LEAD);
    stream.write_all(&raw[split..]).await.unwrap();
    let mut out = Vec::new();
    stream.read_to_end(&mut out).await.unwrap();
    let text = String::from_utf8_lossy(&out);
    assert!(text.starts_with("HTTP/1.1 401"), "{text}");
    assert!(!text.to_ascii_lowercase().contains("mcp-session-id"), "{text}");
    assert_eq!(srv.server.session_count(), 0);
}

/// InMemoryTaskStore: the ttl restarts when the result is stored, and mcp.ts aborts a working task once it is gone.
#[tokio::test]
async fn task_ttl_restarts_on_completion_and_expiry_aborts_a_working_task() {
    let srv = Srv::start(Config { min_task_ttl: Duration::ZERO, ..quick() }).await;
    let token = srv.issue(LEAD);
    let from = srv.fake.events.all().len();
    let task = |id: u64, timeout: f64, ttl: u64| {
        let mut body = wait_for(id, timeout);
        body["params"]["task"] = json!({ "ttl": ttl });
        body
    };
    let get = |id: &Value| json!({ "jsonrpc": "2.0", "id": 9, "method": "tasks/get", "params": { "taskId": id } });
    let long = srv.post(&token, task(1, 30.0, 600)).await.json()["result"]["task"]["taskId"].clone();
    let short = srv.post(&token, task(2, 0.5, 800)).await.json()["result"]["task"]["taskId"].clone();
    let started = Instant::now();
    // The long one expires at 600 ms while it still works: gone, and its call aborted.
    let end = srv.wait_event(from, |e| e["kind"] == "call-end", Duration::from_secs(3)).await.unwrap();
    assert_eq!(end["outcome"], "ok", "the short call ends first (500 ms)");
    tokio::time::sleep_until(tokio::time::Instant::from_std(started + Duration::from_millis(900))).await;
    let ends: Vec<Value> = srv.fake.events.all().into_iter().skip(from).filter(|e| e["kind"] == "call-end").collect();
    assert_eq!(ends.len(), 2, "the expired working task's call was aborted: {ends:?}");
    assert_eq!(ends[1]["outcome"], "aborted");
    assert_eq!(srv.post(&token, get(&long)).await.json()["error"]["code"], -32602);
    // The short one completed at ~500 ms; created + ttl (800 ms) has passed, completion + ttl (~1300 ms) has not.
    tokio::time::sleep_until(tokio::time::Instant::from_std(started + Duration::from_millis(1000))).await;
    assert_eq!(srv.post(&token, get(&short)).await.json()["result"]["status"], "completed");
    tokio::time::sleep_until(tokio::time::Instant::from_std(started + Duration::from_millis(1700))).await;
    assert_eq!(srv.post(&token, get(&short)).await.json()["error"]["code"], -32602);
}

/// An unanswered elicitation times out: the server sends `notifications/cancelled` for it on the call's stream (SDK
/// Protocol.request timeout), and the call goes on with `cancel`.
#[tokio::test]
async fn an_elicitation_timeout_sends_notifications_cancelled() {
    let srv = Srv::start(Config { elicit_timeout: Duration::from_millis(300), ..quick() }).await;
    let token = srv.issue(LEAD);
    let session = srv.session(&token).await;
    let r = srv.in_session(&token, &session, call(5, "close_grid", json!({ "gridId": "grid-side" }))).await;
    assert_eq!(r.status, 200);
    let messages = r.messages();
    assert_eq!(messages.len(), 3, "{}", r.text);
    assert_eq!(messages[0]["method"], "elicitation/create");
    assert_eq!(
        messages[1],
        json!({ "jsonrpc": "2.0", "method": "notifications/cancelled",
            "params": { "requestId": messages[0]["id"], "reason": "McpError: MCP error -32001: Request timed out" } })
    );
    assert_eq!(messages[2]["id"], 5);
    assert_eq!(messages[2]["result"]["isError"], true);
}

// ---------- timeouts, keepalive, failures, stop ----------

/// Node `server.headersTimeout`: a request head that does not arrive in time is answered 408 and the connection closed.
#[tokio::test]
async fn a_slow_request_head_gets_node_s_408() {
    let srv = Srv::start(Config { header_timeout: Duration::from_millis(400), ..quick() }).await;
    let started = Instant::now();
    let text = raw_exchange(&srv.addr, b"POST /mcp HTTP/1.1\r\nHost: x\r\n").await;
    assert_eq!(text, "HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n");
    assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
}

/// Node `server.requestTimeout`: a body that does not arrive in time is answered 408 and the connection closed.
#[tokio::test]
async fn a_slow_request_body_gets_408() {
    let srv = Srv::start(Config { request_timeout: Duration::from_millis(400), ..quick() }).await;
    let token = srv.issue(LEAD);
    let head = format!(
        "POST /mcp HTTP/1.1\r\nHost: {}\r\nAuthorization: Bearer {token}\r\nContent-Type: application/json\r\nAccept: {ACCEPT}\r\nContent-Length: 100\r\n\r\n{{\"a\":",
        srv.addr
    );
    let started = Instant::now();
    let text = raw_exchange(&srv.addr, head.as_bytes()).await;
    assert!(text.starts_with("HTTP/1.1 408 Request Timeout\r\n"), "{text}");
    assert!(text.to_ascii_lowercase().contains("connection: close"), "{text}");
    assert!(started.elapsed() < Duration::from_secs(3));
    // The in-flight slot was given back.
    assert_eq!(srv.server.table_sizes()[3], 1);
    assert_eq!(srv.post(&token, ping(1)).await.status, 200);
}

/// An idle keep-alive connection is not answered 408 (Node closes it without a word).
#[tokio::test]
async fn an_idle_keep_alive_connection_gets_no_408() {
    let srv = Srv::start(Config { header_timeout: Duration::from_millis(300), ..quick() }).await;
    let token = srv.issue(LEAD);
    let raw = srv.post_req(&token, ping(1)).raw();
    let raw = String::from_utf8(raw).unwrap().replace("connection: close\r\n", "");
    let mut stream = TcpStream::connect(&srv.addr).await.unwrap();
    stream.write_all(raw.as_bytes()).await.unwrap();
    let mut out = Vec::new();
    let started = Instant::now();
    let read = tokio::time::timeout(Duration::from_secs(3), stream.read_to_end(&mut out)).await;
    let text = String::from_utf8_lossy(&out);
    assert!(text.starts_with("HTTP/1.1 200"), "{text}");
    assert!(!text.contains("408"), "{text}");
    eprintln!("idle keep-alive connection: closed={} after {:?}", read.is_ok(), started.elapsed());
}

#[tokio::test]
async fn an_sse_stream_sends_keepalive_comments() {
    let srv = Srv::start(Config { keep_alive: Duration::from_millis(200), ..quick() }).await;
    let token = srv.issue(LEAD);
    let mut body = wait_for(1, 1.0);
    body["params"]["_meta"] = json!({ "progressToken": "k" });
    let r = srv.post(&token, body).await;
    assert!(r.text.matches(": keepalive\n\n").count() >= 3, "{}", r.text);
    assert_eq!(r.header("cache-control"), Some("no-cache, no-transform"));
    assert_eq!(r.header("x-accel-buffering"), Some("no"));
}

/// An internal failure answers 500 `{"error":"MCP request failed."}` and logs one line without the request body.
#[tokio::test]
async fn an_internal_failure_answers_500_without_echoing_the_request() {
    let logged = Arc::new(Mutex::new(Vec::<String>::new()));
    let l = logged.clone();
    let srv = Srv::start(Config { log: Arc::new(move |m| l.lock().push(m.to_string())), ..quick() }).await;
    let token = srv.issue(LEAD);
    let r = srv.post(&token, call(1, "panic", json!({ "secret": "s3cr3t-argument" }))).await;
    assert_eq!((r.status, r.text.as_str()), (500, r#"{"error":"MCP request failed."}"#));
    let logged = logged.lock().clone();
    assert_eq!(logged.len(), 1, "{logged:?}");
    assert!(logged[0].starts_with("MCP request failed: "), "{logged:?}");
    assert!(!logged[0].contains("s3cr3t") && !logged[0].contains(&token));
    // The slot was given back.
    assert_eq!(srv.post(&token, ping(2)).await.status, 200);
}

#[tokio::test]
async fn stop_ends_running_calls_and_closes_the_port() {
    let srv = Srv::start(quick()).await;
    let token = srv.issue(LEAD);
    let from = srv.fake.events.all().len();
    let stop = async {
        srv.wait_event(from, |e| e["kind"] == "call-start", Duration::from_secs(2)).await;
        srv.server.stop();
    };
    let (r, ()) = tokio::join!(srv.post(&token, wait_for(1, 30.0)), stop);
    assert_ne!(r.status, 200, "the connection was closed: {r:?}");
    assert!(srv.wait_event(from, |e| e["kind"] == "call-end", Duration::from_secs(2)).await.is_some());
    assert!(TcpStream::connect(&srv.addr).await.is_err() || srv.post(&token, ping(1)).await.status == 0);
}
