//! The hook server against the 1.1.4 reference (test/golden/hook-payloads.jsonl and hook-server.jsonl, written by
//! scripts/goldens-hooks.mjs from the real src/main/hooks.ts): the payload helpers give the same answers, and the same HTTP
//! requests get the same status and the same events in the same order.

use std::path::PathBuf;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use unimux_agents::hooks::payload::{self, DebugKind};
use unimux_agents::hooks::{HookServer, HookSignal, encode_uri_component};
use unimux_core::js_json;

const NOW: i64 = 1_767_225_600_123;

fn golden(name: &str) -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/golden").join(name);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    text.lines().filter(|l| !l.is_empty()).map(|l| js_json::parse(l).expect("golden row")).collect()
}

fn opt<T>(v: Option<T>, f: impl FnOnce(T) -> Value) -> Value {
    v.map_or(Value::Null, f)
}

fn mapped(m: Option<payload::Mapped>) -> Value {
    opt(m, |m| {
        let mut o = Map::new();
        o.insert("event".into(), json!(m.event));
        if let Some(info) = m.info {
            o.insert("info".into(), info);
        }
        Value::Object(o)
    })
}

fn body_out(body: &str) -> Value {
    let parsed = payload::parse_object(body);
    json!({
        "stopInfo": payload::stop_info(parsed.as_ref()),
        "active": payload::has_active_background_work(parsed.as_ref()),
        "failure": payload::parse_failure(body),
        "stopLine": payload::stop_debug_line("c1", body, NOW),
        "failLine": payload::hook_debug_line(DebugKind::Fail, "c1", body, NOW),
        "sessionLine": payload::hook_debug_line(DebugKind::Session, "c1", body, NOW),
        "transcript": opt(payload::transcript_of(parsed.as_ref()), |(s, p)| json!({ "sessionId": s, "path": p })),
        "notification": mapped(payload::notification_event(body)),
        "attention": payload::is_attention_notification(body),
        "sessionStart": opt(payload::parse_session_start(body), |s| {
            let mut o = Map::new();
            o.insert("sessionId".into(), json!(s.session_id));
            if let Some(src) = s.source {
                o.insert("source".into(), json!(src));
            }
            Value::Object(o)
        }),
        "codex": opt(payload::parse_codex_notify(body), |n| n.to_json()),
    })
}

#[test]
fn payload_helpers_answer_like_the_ts_reference() {
    let rows = golden("hook-payloads.jsonl");
    assert!(rows.len() > 600, "corpus too small: {}", rows.len());
    let mut failures = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let got = if let Some(body) = row.get("body").and_then(Value::as_str) {
            body_out(body)
        } else {
            let event = row["event"].as_str().unwrap();
            let head = row["head"].as_str().unwrap();
            let tail = row["tail"].as_str().unwrap();
            json!({
                "facts": payload::tool_hook_facts(head, tail).to_json(),
                "mapped": mapped(payload::tool_hook_event(event, head, tail)),
            })
        };
        let want = js_json::stringify(&row["out"]);
        let got = js_json::stringify(&got);
        if want != got && failures.len() < 10 {
            failures.push(format!("row {i}: {}\n  want {want}\n  got  {got}", js_json::stringify(row)));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

// ---------------------------------------------------------------------------------------------------------------------

fn body_text(spec: &Value) -> String {
    match spec {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        o => {
            let s = |k: &str| o.get(k).and_then(Value::as_str).unwrap_or("").to_string();
            let count = o["count"].as_u64().unwrap() as usize;
            format!("{}{}{}", s("prefix"), s("repeat").repeat(count), s("suffix"))
        }
    }
}

struct Ids {
    token: String,
    nonce: String,
    stale: String,
    other: String,
}

/// buildRequest of scripts/goldens-hooks.mjs.
fn build(req: &Value, ids: &Ids) -> (String, Vec<(String, String)>, Vec<u8>) {
    let s = |k: &str| req.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let nonce = match s("nonce").as_str() {
        "current" | "forgotten" => Some(ids.nonce.clone()),
        "stale" => Some(ids.stale.clone()),
        "other" => Some(ids.other.clone()),
        _ => None,
    };
    let path = match s("route").as_str() {
        "raw" => s("path").replace("{token}", &ids.token).replace("{nonce}", &ids.nonce),
        "x" => {
            let code = req.get("code").and_then(Value::as_str).map_or(String::new(), |c| format!("/{c}"));
            format!("/x/{}/{}{code}", s("cell"), nonce.clone().unwrap_or_else(|| "null".into()))
        }
        route => {
            let head = if route == "k" { "/k".to_string() } else { format!("/h/{}", ids.token) };
            let tail = nonce.map_or(String::new(), |n| format!("/{n}"));
            format!("{head}/{}/{}{tail}", encode_uri_component(&s("cell")), s("event"))
        }
    };
    let mut headers = Vec::new();
    match s("auth").as_str() {
        "good" => headers.push(("Authorization".into(), format!("Bearer {}", ids.token))),
        "bad" => headers.push(("Authorization".into(), "Bearer 00000000000000000000000000000000".into())),
        "lower" => headers.push(("Authorization".into(), format!("bearer {}", ids.token))),
        _ => {}
    }
    let body = match req.get("bytes").and_then(Value::as_array) {
        Some(bytes) => bytes.iter().map(|b| b.as_u64().unwrap() as u8).collect(),
        None => body_text(req.get("body").unwrap_or(&Value::Null)).into_bytes(),
    };
    (path, headers, body)
}

/// One HTTP/1.1 request on its own connection; the status code.
async fn send(port: u16, method: &str, path: &str, headers: &[(String, String)], body: &[u8]) -> u16 {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
    let mut head =
        format!("{method} {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Length: {}\r\nConnection: close\r\n", body.len());
    for (k, v) in headers {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    stream.write_all(head.as_bytes()).await.unwrap();
    stream.write_all(body).await.unwrap();
    let mut answer = Vec::new();
    stream.read_to_end(&mut answer).await.unwrap();
    let text = String::from_utf8_lossy(&answer);
    text.split(' ').nth(1).and_then(|c| c.parse().ok()).unwrap_or_else(|| panic!("no status in {text:?}"))
}

/// Events as the TS recorder writes them: a `hook` without info (emitted with two arguments) has no trailing null.
fn normalize(events: &Value) -> String {
    let list: Vec<Value> = events
        .as_array()
        .unwrap()
        .iter()
        .map(|e| {
            let mut a = e.as_array().unwrap().clone();
            if a.len() == 4 && a[0] == "hook" && a[3].is_null() {
                a.pop();
            }
            Value::Array(a)
        })
        .collect();
    js_json::stringify(&Value::Array(list))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn the_server_answers_and_emits_like_the_ts_reference() {
    let server = HookServer::new();
    let seen: Arc<Mutex<Vec<HookSignal>>> = Arc::default();
    let sink = seen.clone();
    server.set_handler(Arc::new(move |s| sink.lock().push(s)));
    let port = server.start().await.unwrap();
    let rows = golden("hook-server.jsonl");
    assert!(rows.len() > 100);
    let mut failures = Vec::new();
    for row in &rows {
        let req = &row["request"];
        let cell = req["cell"].as_str().unwrap();
        let nonce_of = |c: &str| server.exit_url(c).rsplit('/').next().unwrap().to_string();
        server.prepare_codex(cell);
        let stale = nonce_of(cell);
        server.prepare_codex(cell);
        let ids = Ids { token: server.token().to_string(), nonce: nonce_of(cell), stale, other: nonce_of("other-cell") };
        if req["nonce"] == "forgotten" {
            server.forget(cell);
        }
        let (path, headers, body) = build(req, &ids);
        seen.lock().clear();
        let status = send(port, req["method"].as_str().unwrap(), &path, &headers, &body).await;
        let events = Value::Array(seen.lock().iter().map(HookSignal::to_json).collect());
        let (want_status, want_events) = (row["status"].as_u64().unwrap(), normalize(&row["events"]));
        let got_events = normalize(&events);
        if u64::from(status) != want_status || got_events != want_events {
            failures.push(format!(
                "{}: want {want_status} {}\n  got {status} {}",
                row["name"],
                want_events.chars().take(300).collect::<String>(),
                got_events.chars().take(300).collect::<String>()
            ));
        }
    }
    server.stop();
    assert!(failures.is_empty(), "{} of {} rows differ:\n{}", failures.len(), rows.len(), failures.join("\n"));
}
