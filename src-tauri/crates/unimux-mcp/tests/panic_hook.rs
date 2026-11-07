//! The app's panic hook asks `unimux_mcp::in_request()` to leave panics inside MCP requests to the server (one cut
//! `MCP request failed` line, no dialog; 1.1.4 handle().catch). Its own test binary: the hook is process-wide.

mod support;

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::json;
use support::{LEAD, Srv, call};
use unimux_mcp::Config;

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn panics_inside_mcp_requests_are_marked_for_the_app_hook() {
    let seen = Arc::new(Mutex::new(Vec::<(bool, String)>::new()));
    let s = seen.clone();
    std::panic::set_hook(Box::new(move |info| {
        let text = info.payload().downcast_ref::<&str>().map(|t| t.to_string()).unwrap_or_default();
        s.lock().push((unimux_mcp::in_request(), text));
    }));
    let logged = Arc::new(Mutex::new(Vec::<String>::new()));
    let l = logged.clone();
    let srv = Srv::start(Config { rate: None, log: Arc::new(move |m| l.lock().push(m.to_string())), ..Config::default() }).await;
    let token = srv.issue(LEAD);
    // Stateless JSON (respond) and a session call (the SSE task).
    assert_eq!(srv.post(&token, call(1, "panic", json!({}))).await.status, 500);
    let session = srv.session(&token).await;
    let r = srv.in_session(&token, &session, call(2, "panic", json!({}))).await;
    assert_eq!((r.status, r.messages().len()), (200, 0), "{}", r.text);
    // Outside a request: not marked.
    let _ = std::thread::spawn(|| panic!("tool exploded")).join();
    tokio::time::sleep(Duration::from_millis(100)).await;
    let _ = std::panic::take_hook();
    let seen = seen.lock().clone();
    let expected: Vec<(bool, String)> =
        vec![(true, "tool exploded".into()), (true, "tool exploded".into()), (false, "tool exploded".into())];
    assert_eq!(seen, expected);
    assert!(!unimux_mcp::in_request(), "the flag does not leak out of the request");
    let logged = logged.lock().clone();
    assert_eq!(logged, vec!["MCP request failed: Error: tool exploded".to_string(); 2]);
}
