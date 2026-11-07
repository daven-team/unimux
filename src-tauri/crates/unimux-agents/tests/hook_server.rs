//! The hook server over real HTTP (ports of the HookServer cases of test/session-hook, main-misc, codex-hooks and
//! background-stop, plus the H1 acceptance: a 2 MB Stop, a 1.5 MB Codex payload, a stale nonce and a bad token give
//! 204 / 403 / 400 as in 1.1.4, the 5 s request timeout, bodies split anywhere, and parallel requests).

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use unimux_agents::hooks::{HookServer, HookSignal, log_stop_debug};

const ID: &str = "3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091";

struct Fixture {
    server: HookServer,
    seen: Arc<Mutex<Vec<HookSignal>>>,
    port: u16,
}

impl Fixture {
    async fn new() -> Self {
        let server = HookServer::new();
        let seen: Arc<Mutex<Vec<HookSignal>>> = Arc::default();
        let sink = seen.clone();
        server.set_handler(Arc::new(move |s| sink.lock().push(s)));
        let port = server.start().await.expect("listen");
        Self { server, seen, port }
    }

    /// `cell:event` for every `hook` signal (the TS tests' `seen.push(`${cell}:${ev}`)`).
    fn hooks(&self) -> Vec<String> {
        self.seen
            .lock()
            .iter()
            .filter_map(|s| match s {
                HookSignal::Hook { cell, event, .. } => Some(format!("{cell}:{event}")),
                _ => None,
            })
            .collect()
    }

    fn take(&self) -> Vec<HookSignal> {
        std::mem::take(&mut *self.seen.lock())
    }
}

/// Path of a URL the server handed out.
fn path_of(url: &str) -> String {
    let rest = url.strip_prefix("http://127.0.0.1:").unwrap();
    rest[rest.find('/').unwrap()..].to_string()
}

async fn request(port: u16, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> u16 {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut head =
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    status_of(&mut stream).await
}

async fn status_of(stream: &mut TcpStream) -> u16 {
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.unwrap();
    let text = String::from_utf8_lossy(&answer);
    assert!(text.ends_with("\r\n\r\n"), "an answer without a body: {text:?}");
    text.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or_else(|| panic!("no status in {text:?}"))
}

async fn post(port: u16, url: &str, body: &str) -> u16 {
    request(port, "POST", &path_of(url), &[], body.as_bytes()).await
}

fn bg(tasks: Value) -> String {
    json!({ "background_tasks": tasks }).to_string()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn emits_hook_events_for_a_valid_token_and_rejects_others() {
    let f = Fixture::new().await;
    assert_eq!(post(f.port, &f.server.url("cell-1", "stop"), "").await, 204);
    assert_eq!(request(f.port, "POST", "/h/wrong/cell-1/stop/x", &[], b"").await, 403);
    assert_eq!(f.hooks(), vec!["cell-1:stop"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reports_idle_prompt_as_its_own_event_and_permission_prompts_as_notify() {
    let f = Fixture::new().await;
    post(f.port, &f.server.url("c1", "notify"), r#"{"notification_type":"idle_prompt"}"#).await;
    post(f.port, &f.server.url("c1", "notify"), r#"{"notification_type":"permission_prompt"}"#).await;
    post(f.port, &f.server.url("c1", "busy"), "{}").await;
    assert_eq!(f.hooks(), vec!["c1:idle", "c1:notify", "c1:busy"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn rejects_malformed_ids_and_oversized_bodies_without_crashing() {
    let f = Fixture::new().await;
    let token = f.server.token().to_string();
    assert_eq!(request(f.port, "POST", &format!("/h/{token}/%E0%A4%A/stop"), &[], b"").await, 400);
    assert_eq!(request(f.port, "POST", &format!("/h/{token}/a%20b/stop"), &[], b"").await, 400);
    assert_eq!(post(f.port, &f.server.url("c2", "notify"), &"x".repeat(200_000)).await, 204);
    assert!(f.hooks().is_empty());
    assert_eq!(post(f.port, &f.server.url("c2", "stop"), "").await, 204);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn session_start_emits_a_session_event_never_a_status_event_and_rejects_bad_requests() {
    let f = Fixture::new().await;
    let base = f.server.url("c1", "session");
    assert_eq!(post(f.port, &base, &json!({ "session_id": ID, "source": "resume" }).to_string()).await, 204);
    post(f.port, &base, r#"{"session_id":"../../etc/passwd-aaaa"}"#).await;
    post(f.port, &base, r#"{"session_id":42}"#).await;
    post(f.port, &base, "not json").await;
    assert_eq!(request(f.port, "POST", "/h/wrongtoken/c1/session/x", &[], ID.as_bytes()).await, 403);
    post(f.port, &base, &"x".repeat(200_000)).await;
    assert_eq!(request(f.port, "GET", &path_of(&base), &[], b"").await, 403);
    let signals = f.take();
    assert_eq!(
        signals,
        vec![
            HookSignal::Session { cell: "c1".into(), session_id: ID.into(), source: Some("resume".into()) },
            HookSignal::SessionStart { cell: "c1".into(), source: Some("resume".into()) },
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ignores_stale_or_missing_nonces_for_every_event_and_accepts_the_current_one_after_a_restart() {
    let f = Fixture::new().await;
    f.server.renew_nonce("c1");
    let old_stop = f.server.url("c1", "stop");
    let old_session = f.server.url("c1", "session");
    f.server.renew_nonce("c1"); // restart (writeClaudeSettings)
    assert_ne!(f.server.url("c1", "stop"), old_stop);
    assert_eq!(post(f.port, &old_stop, "{}").await, 204);
    post(f.port, &old_session, &json!({ "session_id": ID }).to_string()).await;
    let token = f.server.token().to_string();
    request(f.port, "POST", &format!("/h/{token}/c1/stop"), &[], b"{}").await; // old format, no nonce
    post(f.port, &f.server.url("c1", "stop"), "{}").await;
    post(f.port, &f.server.url("c1", "session"), &json!({ "session_id": ID }).to_string()).await;
    let seen: Vec<String> = f
        .take()
        .into_iter()
        .filter_map(|s| match s {
            HookSignal::Hook { cell, event, .. } => Some(format!("{cell}:{event}")),
            HookSignal::Session { cell, session_id, .. } => Some(format!("{cell}:session:{session_id}")),
            _ => None,
        })
        .collect();
    assert_eq!(seen, vec!["c1:stop".to_string(), format!("c1:session:{ID}")]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn emits_stopbg_or_stop_and_rejects_oversized_and_wrong_token_requests() {
    let f = Fixture::new().await;
    let url = |ev: &str| f.server.url("c1", ev);
    post(f.port, &url("stop"), &bg(json!([{ "status": "running" }]))).await;
    post(f.port, &url("stop"), &bg(json!([{ "status": "done" }]))).await;
    post(f.port, &url("stop"), &json!({ "last_assistant_message": "y".repeat(100_000) }).to_string()).await;
    post(f.port, &url("stopbg"), &bg(json!([{ "status": "running" }]))).await;
    post(f.port, &url("stop"), &"z".repeat(600_000)).await;
    post(f.port, &url("notify"), &"z".repeat(20_000)).await;
    request(f.port, "POST", "/h/bad/c1/stop/x", &[], bg(json!([{ "status": "running" }])).as_bytes()).await;
    // The oversized Stop still counts as a plain Stop.
    assert_eq!(f.hooks(), vec!["c1:stopbg", "c1:stop", "c1:stop", "c1:stop"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn emits_stopbg_for_a_workflow_and_stop_when_the_task_list_is_absent() {
    let f = Fixture::new().await;
    let url = f.server.url("c1", "stop");
    post(f.port, &url, &bg(json!([{ "type": "workflow", "status": "running" }]))).await;
    post(f.port, &url, r#"{"last_assistant_message":"x"}"#).await;
    let seen: Vec<String> = f
        .take()
        .into_iter()
        .filter_map(|s| match s {
            HookSignal::Hook { event, info, .. } => {
                let w = info.and_then(|i| i.get("workflows").cloned()).map_or("-".into(), |w| w.to_string());
                Some(format!("{event}:{w}"))
            }
            _ => None,
        })
        .collect();
    assert_eq!(seen, vec!["stopbg:1", "stop:0"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn codex_emits_a_notice_per_valid_request_of_the_current_process_and_drops_every_other_one() {
    let f = Fixture::new().await;
    let payload = json!({ "type": "agent-turn-complete", "thread-id": ID, "turn-id": "turn-1" }).to_string();
    let old = f.server.prepare_codex("c1");
    let url = f.server.prepare_codex("c1"); // a respawn invalidates the previous process
    assert!(url.contains(&format!("/h/{}/c1/codex/", f.server.token())));
    assert_eq!(post(f.port, &old, &payload).await, 204);
    assert_eq!(post(f.port, &url, &payload).await, 204);
    post(f.port, &url, "not json").await;
    post(f.port, &url, r#"{"type":"other"}"#).await;
    request(f.port, "POST", "/h/wrong/c1/codex/x", &[], payload.as_bytes()).await;
    post(f.port, &url.replace("/c1/", "/c2/"), &payload).await;
    assert_eq!(request(f.port, "GET", &path_of(&url), &[], b"").await, 403);
    let notice = unimux_agents::hooks::payload::CodexNotice { thread_id: Some(ID.into()), turn_id: Some("turn-1".into()) };
    assert_eq!(f.take(), vec![HookSignal::Codex { cell: "c1".into(), notice }]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn codex_accepts_a_large_payload_and_counts_an_oversized_one_as_a_turn_end_without_ids() {
    let f = Fixture::new().await;
    let url = f.server.prepare_codex("c1");
    let big = json!({ "type": "agent-turn-complete", "thread-id": ID, "turn-id": "turn-1", "last-assistant-message": "y".repeat(200_000) });
    post(f.port, &url, &big.to_string()).await;
    post(f.port, &url, &"x".repeat(1_200_000)).await;
    let notices: Vec<Value> = f
        .take()
        .into_iter()
        .map(|s| match s {
            HookSignal::Codex { notice, .. } => notice.to_json(),
            other => panic!("{other:?}"),
        })
        .collect();
    assert_eq!(notices, vec![json!({ "threadId": ID, "turnId": "turn-1" }), json!({})]);
}

/// PLAN H1 acceptance: 2 MB Stop, 1.5 MB Codex, stale nonce, bad token -> 204 / 403 / 400.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn acceptance_large_bodies_stale_nonces_and_bad_tokens() {
    let f = Fixture::new().await;
    let stop = format!(r#"{{"background_tasks":[{{"type":"agent","status":"running"}}],"m":"{}"}}"#, "x".repeat(2_000_000));
    assert_eq!(post(f.port, &f.server.url("c1", "stop"), &stop).await, 204);
    let codex = format!(r#"{{"type":"agent-turn-complete","thread-id":"{ID}","m":"{}"}}"#, "y".repeat(1_500_000));
    let codex_url = f.server.prepare_codex("c2");
    assert_eq!(post(f.port, &codex_url, &codex).await, 204);
    let stale = f.server.url("c3", "stop");
    f.server.renew_nonce("c3");
    assert_eq!(post(f.port, &stale, "{}").await, 204);
    let token = f.server.token().to_string();
    let nonce = f.server.nonce("c1").unwrap();
    assert_eq!(request(f.port, "POST", &format!("/h/{}/c1/stop/{nonce}", "0".repeat(32)), &[], stop.as_bytes()).await, 403);
    assert_eq!(request(f.port, "POST", &format!("/k/c1/stop/{nonce}"), &[("Authorization", "Bearer nope")], b"{}").await, 403);
    assert_eq!(request(f.port, "POST", &format!("/h/{token}/c%201/stop/{nonce}"), &[], b"{}").await, 400);
    assert_eq!(request(f.port, "POST", &format!("/h/{token}/%ZZ/stop/{nonce}"), &[], b"{}").await, 400);
    let bearer = format!("Bearer {token}");
    assert_eq!(request(f.port, "POST", &format!("/k/c1/stop/{nonce}"), &[("Authorization", &bearer)], b"{}").await, 204);
    assert_eq!(
        f.take(),
        vec![
            HookSignal::Hook {
                cell: "c1".into(),
                event: "stop".into(),
                info: Some(
                    json!({ "tasks": 0, "active": 0, "statuses": [], "types": [], "continuation": false, "workflows": 0, "tasksUnknown": true })
                ),
            },
            HookSignal::Codex { cell: "c2".into(), notice: Default::default() },
            HookSignal::Hook {
                cell: "c1".into(),
                event: "stop".into(),
                info: Some(
                    json!({ "tasks": 0, "active": 0, "statuses": [], "types": [], "continuation": false, "workflows": 0 , "tasksUnknown": true })
                ),
            },
        ]
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_cli_exit_route_needs_the_spawns_nonce_only() {
    let f = Fixture::new().await;
    f.server.prepare_codex("c1");
    let exit = f.server.exit_url("c1");
    assert_eq!(post(f.port, &format!("{exit}/7"), "").await, 204);
    assert_eq!(request(f.port, "GET", &format!("{}/7", path_of(&exit)), &[], b"").await, 403);
    f.server.forget("c1");
    assert_eq!(post(f.port, &format!("{exit}/8"), "").await, 204);
    assert_eq!(f.take(), vec![HookSignal::CliExit { cell: "c1".into(), code: Some(7) }]);
}

/// The body arrives in pieces cut inside multi-byte characters, with pauses: the head limit and the payload are the same.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_body_split_anywhere_reads_the_same() {
    let f = Fixture::new().await;
    let body = json!({ "notification_type": "permission_prompt", "message": "zażółć 😀 gęślą".repeat(20) }).to_string();
    let bytes = body.as_bytes();
    let mut stream = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap();
    let head = format!(
        "POST {} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n",
        path_of(&f.server.url("c1", "notify"))
    );
    stream.write_all(head.as_bytes()).await.unwrap();
    for piece in bytes.chunks(3) {
        stream.write_all(format!("{:x}\r\n", piece.len()).as_bytes()).await.unwrap();
        stream.write_all(piece).await.unwrap();
        stream.write_all(b"\r\n").await.unwrap();
        stream.flush().await.unwrap();
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    stream.write_all(b"0\r\n\r\n").await.unwrap();
    assert_eq!(status_of(&mut stream).await, 204);
    assert_eq!(
        f.take(),
        vec![HookSignal::Hook { cell: "c1".into(), event: "notify".into(), info: Some(json!({ "need": "permission" })) }]
    );
}

/// Node's requestTimeout of 5 s: a body that never ends gets 408 and nothing is emitted.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_request_that_does_not_arrive_within_5_s_times_out() {
    let f = Fixture::new().await;
    let mut stream = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap();
    let head =
        format!("POST {} HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{{\"a\":", path_of(&f.server.url("c1", "stop")));
    stream.write_all(head.as_bytes()).await.unwrap();
    let started = Instant::now();
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.unwrap();
    let waited = started.elapsed();
    assert!(String::from_utf8_lossy(&answer).starts_with("HTTP/1.1 408"), "{:?}", String::from_utf8_lossy(&answer));
    assert!(waited >= Duration::from_millis(4500) && waited < Duration::from_secs(8), "{waited:?}");
    assert!(f.take().is_empty());
    // The server still answers.
    assert_eq!(post(f.port, &f.server.url("c1", "prompt"), "").await, 204);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn parallel_requests_of_many_cells() {
    let f = Arc::new(Fixture::new().await);
    let mut tasks = Vec::new();
    for i in 0..60 {
        let f = f.clone();
        tasks.push(tokio::spawn(async move {
            let cell = format!("cell-{i}");
            let url = f.server.url(&cell, if i % 2 == 0 { "prompt" } else { "stop" });
            post(f.port, &url, &bg(json!([{ "type": "agent", "status": "running" }]))).await
        }));
    }
    for t in tasks {
        assert_eq!(t.await.unwrap(), 204);
    }
    let mut seen = f.hooks();
    seen.sort();
    let mut want: Vec<String> = (0..60).map(|i| format!("cell-{i}:{}", if i % 2 == 0 { "prompt" } else { "stopbg" })).collect();
    want.sort();
    assert_eq!(seen, want);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_closes_the_listener() {
    let f = Fixture::new().await;
    f.server.stop();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(TcpStream::connect(("127.0.0.1", f.port)).await.is_err());
}

/// One keep-alive request on an open stream: the status, or None when the server closed the connection instead.
async fn keep_alive_post(stream: &mut TcpStream, port: u16, path: &str) -> Option<u16> {
    let head = format!("POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: 0\r\n\r\n");
    if stream.write_all(head.as_bytes()).await.is_err() {
        return None;
    }
    let mut answer = Vec::new();
    let mut buf = [0u8; 512];
    while !answer.windows(4).any(|w| w == b"\r\n\r\n") {
        match tokio::time::timeout(Duration::from_secs(3), stream.read(&mut buf)).await {
            Ok(Ok(n)) if n > 0 => answer.extend_from_slice(&buf[..n]),
            _ => return None,
        }
    }
    String::from_utf8_lossy(&answer).split(' ').nth(1).and_then(|c| c.parse().ok())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_closes_idle_keep_alive_connections_and_emits_nothing_more() {
    let f = Fixture::new().await;
    let url = f.server.url("c1", "prompt");
    let mut stream = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap();
    assert_eq!(keep_alive_post(&mut stream, f.port, &path_of(&url)).await, Some(204));
    assert_eq!(f.hooks(), ["c1:prompt"]);
    f.server.stop();
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert_eq!(keep_alive_post(&mut stream, f.port, &path_of(&url)).await, None, "the idle connection was closed at stop");
    assert_eq!(f.hooks(), ["c1:prompt"], "nothing emitted after stop");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn stop_lets_a_request_in_flight_finish() {
    let f = Fixture::new().await;
    let path = path_of(&f.server.url("c1", "stop"));
    let mut stream = TcpStream::connect(("127.0.0.1", f.port)).await.unwrap();
    let body = b"{}";
    let head = format!("POST {path} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: {}\r\n\r\n", f.port, body.len());
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(&body[..1]).await.unwrap();
    tokio::time::sleep(Duration::from_millis(100)).await;
    f.server.stop();
    tokio::time::sleep(Duration::from_millis(100)).await;
    stream.write_all(&body[1..]).await.unwrap();
    assert_eq!(status_of(&mut stream).await, 204, "answered, then the connection closes");
    assert_eq!(f.hooks(), ["c1:stop"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn parallel_debug_writes_past_256_kib_keep_every_line() {
    let dir = tempfile::tempdir().unwrap();
    let f = Fixture::new().await;
    f.server.set_debug_dir(Some(dir.path().to_path_buf()));
    let file = dir.path().join("hook-debug.log");
    for round in 0..20 {
        std::fs::write(&file, vec![b'x'; 300 * 1024]).unwrap();
        let mut tasks = Vec::new();
        for i in 0..16 {
            let url = f.server.url(&format!("cell-{i}"), "stop");
            let port = f.port;
            tasks.push(tokio::spawn(async move { post(port, &url, "{}").await }));
        }
        for t in tasks {
            assert_eq!(t.await.unwrap(), 204);
        }
        let log = std::fs::read_to_string(&file).unwrap();
        assert_eq!(log.lines().filter(|l| l.contains(" keys=")).count(), 16, "round {round}");
        assert!(!log.contains('x'), "round {round}: the old log was restarted once");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn mc_hook_debug_logs_payload_shapes_to_hook_debug_log() {
    let dir = tempfile::tempdir().unwrap();
    let f = Fixture::new().await;
    // Without MC_HOOK_DEBUG nothing is written.
    post(f.port, &f.server.url("c1", "stop"), "{}").await;
    post(f.port, &f.server.url("c1", "fail"), "{}").await;
    post(f.port, &f.server.url("c1", "session"), &json!({ "session_id": ID }).to_string()).await;
    assert!(!dir.path().join("hook-debug.log").exists(), "silent when disabled");
    f.server.set_debug_dir(Some(dir.path().to_path_buf()));
    let body = json!({
        "last_assistant_message": "SECRET-MSG",
        "background_tasks": [{ "id": "i1", "type": "subagent", "status": "running", "description": "SECRET-DESC" }],
    })
    .to_string();
    post(f.port, &f.server.url("c1", "stop"), &body).await;
    post(f.port, &f.server.url("c1", "fail"), r#"{"error":"rate_limit","message":"SECRET"}"#).await;
    post(f.port, &f.server.url("c1", "session"), &json!({ "session_id": ID, "source": "clear" }).to_string()).await;
    let log = std::fs::read_to_string(dir.path().join("hook-debug.log")).unwrap();
    let lines: Vec<&str> = log.lines().collect();
    assert_eq!(lines.len(), 3, "{log}");
    assert!(
        lines[0].ends_with(" c1 keys=last_assistant_message,background_tasks tasks=[subagent/running] stop_hook_active=false")
    );
    assert!(lines[1].ends_with(" c1 fail error=rate_limit keys=error,message"));
    assert!(lines[2].ends_with(" c1 session source=clear keys=session_id,source"));
    assert!(!log.contains("SECRET"));
}

#[test]
fn the_debug_log_writes_only_keys_types_and_statuses_and_restarts_past_256_kib() {
    let dir = tempfile::tempdir().unwrap();
    let body = json!({
        "last_assistant_message": "SECRET-MSG",
        "background_tasks": [{ "id": "i1", "type": "subagent", "status": "running", "description": "SECRET-DESC", "command": "SECRET-CMD" }],
    })
    .to_string();
    log_stop_debug(dir.path(), "c1", &body, None);
    let file = dir.path().join("hook-debug.log");
    let log = std::fs::read_to_string(&file).unwrap();
    assert!(log.contains("c1"));
    assert!(log.contains("last_assistant_message,background_tasks"));
    assert!(log.contains("subagent/running"));
    assert!(!log.contains("SECRET"));
    for _ in 0..3000 {
        log_stop_debug(dir.path(), "c1", &body, None);
    }
    assert!(std::fs::metadata(&file).unwrap().len() < 300 * 1024);
}
