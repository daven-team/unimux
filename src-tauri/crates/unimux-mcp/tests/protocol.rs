//! The 57 HTTP-level protocol cases of SP8 and the M1 review (scripts/spike-mcp-protocol.mjs), ported to cargo and compared with the
//! outcomes of the 1.1.4 TypeScript server (mcp.ts + SDK 1.32.2) recorded in tests/fixtures/protocol-ts.json by
//! `node scripts/spike-mcp-wire.mjs ts --protocol --golden`. Each case runs the same requests in the same order against
//! the Rust server with the fake tool layer, normalizes the answers the same way (ids, tokens, ports, times masked;
//! tool-specific texts dropped where the fake cannot reproduce them) and must equal the TS outcome byte for byte.

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use regex::Regex;
use serde_json::{Map, Value, json};
use support::http::{ACCEPT, Flow, Res};
use support::{Srv, WORKER, call, init};

const GOLDEN: &str = include_str!("fixtures/protocol-ts.json");

fn mask_text(s: &str) -> String {
    let masks = [
        (r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", "<uuid>"),
        (r"(?-u:\b)[0-9a-f]{32}(?-u:\b)", "<hex32>"),
        (r"(?-u:\b)[0-9a-f]{64}(?-u:\b)", "<hex64>"),
        (r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z", "<iso>"),
        (r"127\.0\.0\.1:\d+", "127.0.0.1:<port>"),
    ];
    masks.iter().fold(s.to_string(), |t, (re, to)| Regex::new(re).unwrap().replace_all(&t, *to).to_string())
}

/// Masks every string; keys in `drop` become '<masked>'.
fn mask(value: &Value, drop: &[&str]) -> Value {
    match value {
        Value::String(s) => Value::String(mask_text(s)),
        Value::Array(items) => Value::Array(items.iter().map(|v| mask(v, drop)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(k, v)| (k.clone(), if drop.contains(&k.as_str()) { json!("<masked>") } else { mask(v, drop) }))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// The comparable form of an answer (spike-mcp-protocol.mjs `outcome`).
fn outcome_with(res: &Res, drop: &[&str], keep: &[&str], extra: Option<Value>) -> Value {
    let mut out = Map::new();
    out.insert("status".into(), json!(res.status));
    let kind = res.content_type().map(|t| t.split(';').next().unwrap_or("").to_string()).filter(|t| !t.is_empty());
    out.insert("type".into(), json!(kind));
    if !keep.is_empty() {
        let headers: Map<String, Value> =
            keep.iter().map(|h| (h.to_string(), res.header(h).map_or(Value::Null, |v| json!(mask_text(v))))).collect();
        out.insert("headers".into(), Value::Object(headers));
    }
    out.insert("messages".into(), mask(&Value::Array(res.messages()), drop));
    if let Some(extra) = extra {
        out.insert("extra".into(), extra);
    }
    Value::Object(out)
}

fn outcome(res: &Res) -> Value {
    outcome_with(res, &[], &[], None)
}

fn drop_keys(res: &Res, drop: &[&str]) -> Value {
    outcome_with(res, drop, &[], None)
}

fn keep_headers(res: &Res, keep: &[&str]) -> Value {
    outcome_with(res, &[], keep, None)
}

fn first(res: &Res) -> Value {
    res.messages().into_iter().next().unwrap_or(Value::Null)
}

fn bearer(token: &str) -> String {
    format!("Bearer {token}")
}

fn rpc(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

fn task_call(id: u64, timeout_sec: f64, task: Value) -> Value {
    let mut body = support::wait_for(id, timeout_sec);
    body["params"]["task"] = task;
    body
}

/// A session POST read as it arrives (spike-mcp-protocol.mjs `stream`): (status, the messages seen).
async fn stream(
    srv: &Srv,
    token: &str,
    session: &str,
    body: Value,
    limit: Duration,
    on_frame: impl FnMut(&Value) -> Flow,
) -> (u16, Vec<Value>) {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let s = seen.clone();
    let mut on_frame = on_frame;
    let res = srv
        .post_req(token, body)
        .header("mcp-session-id", session)
        .header("mcp-protocol-version", "2025-11-25")
        .stream(limit, move |m| {
            s.lock().push(m.clone());
            on_frame(m)
        })
        .await;
    let seen = seen.lock().clone();
    (res.status, seen)
}

/// Fire-and-forget POST of a session (the JS `void inSession(...)` inside a frame handler).
fn spawn_in_session(srv: &Srv, token: &str, session: &str, body: Value) {
    let (addr, token, session) = (srv.addr.clone(), token.to_string(), session.to_string());
    tokio::spawn(async move {
        support::http::Request::new(&addr, "POST", "/mcp")
            .header("content-type", "application/json")
            .header("accept", ACCEPT)
            .header("authorization", &bearer(&token))
            .header("mcp-session-id", &session)
            .header("mcp-protocol-version", "2025-11-25")
            .body(body)
            .send()
            .await
    });
}

/// 'client goes away during ...': the call-end of wait_for after the client closed the connection 500 ms in.
async fn vanished(srv: &Srv, token: &str, session: Option<&str>) -> Value {
    let before = srv.fake.events.all().len();
    let at = support::fake::now_ms() as i64;
    let mut req = srv.post_req(token, support::wait_for(1, 20.0));
    if let Some(id) = session {
        req = req.header("mcp-session-id", id).header("mcp-protocol-version", "2025-11-25");
    }
    req.send_and_drop(Duration::from_millis(500)).await;
    for _ in 0..40 {
        let end = srv.fake.events.all().into_iter().skip(before).find(|e| e["kind"] == "call-end" && e["tool"] == "wait_for");
        if let Some(end) = end {
            let delay = end["at"].as_i64().unwrap_or(0) - at - 500;
            let within = if delay < 1000 { "under 1 s".to_string() } else { format!("{delay} ms") };
            return json!({ "outcome": end["outcome"], "within": within });
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    json!({ "outcome": "not noticed within 4 s" })
}

async fn run_case(srv: &Srv, id: &str) -> Value {
    let port = srv.addr.rsplit(':').next().unwrap().to_string();
    let instr: &[&str] = &["instructions"];
    match id {
        "Host other than 127.0.0.1/localhost -> 403" => {
            let t = srv.lead();
            outcome(
                &srv.req("POST", "/mcp")
                    .header("host", &format!("evil.example:{port}"))
                    .header("authorization", &bearer(&t))
                    .send()
                    .await,
            )
        }
        "foreign Origin -> 403" => {
            let t = srv.lead();
            let r = srv.post_req(&t, init(json!({}))).header("origin", "http://evil.example").send().await;
            outcome(&r)
        }
        "other path -> 404" => outcome(&srv.req("POST", "/mcp2").header("authorization", &bearer(&srv.lead())).send().await),
        "query string on /mcp -> 404" => {
            outcome(&srv.req("POST", "/mcp?x=1").header("authorization", &bearer(&srv.lead())).send().await)
        }
        "no bearer -> 401" => outcome(
            &srv.req("POST", "/mcp")
                .header("content-type", "application/json")
                .header("accept", ACCEPT)
                .body(init(json!({})))
                .send()
                .await,
        ),
        "unknown bearer -> 401" => outcome(&srv.post(&"f".repeat(64), init(json!({}))).await),
        "GET -> 405 Allow: POST" => {
            let t = srv.lead();
            keep_headers(
                &srv.req("GET", "/mcp").header("accept", "text/event-stream").header("authorization", &bearer(&t)).send().await,
                &["allow"],
            )
        }
        "GET in a session -> 405" => {
            let t = srv.lead();
            let s = srv.session(&t).await;
            let r = srv
                .req("GET", "/mcp")
                .header("accept", "text/event-stream")
                .header("authorization", &bearer(&t))
                .header("mcp-session-id", &s)
                .header("mcp-protocol-version", "2025-11-25")
                .send()
                .await;
            keep_headers(&r, &["allow"])
        }
        "DELETE unknown session -> 404" => {
            let t = srv.lead();
            outcome(&srv.req("DELETE", "/mcp").header("authorization", &bearer(&t)).header("mcp-session-id", "nope").send().await)
        }
        "PUT -> 405" => {
            keep_headers(&srv.req("PUT", "/mcp").header("authorization", &bearer(&srv.lead())).send().await, &["allow"])
        }
        "body over 256 KB -> 413 -32000" => {
            let raw = unimux_core::js_json::stringify(
                &json!({ "jsonrpc": "2.0", "id": 1, "method": "ping", "params": { "pad": "x".repeat(300 * 1024) } }),
            );
            outcome(&srv.post(&srv.lead(), raw.as_str()).await)
        }
        "invalid JSON -> 400 -32700" => outcome(&srv.post(&srv.lead(), "{\"jsonrpc\":").await),
        "Accept without SSE -> 406" => {
            let t = srv.lead();
            outcome(&srv.post_req(&t, init(json!({}))).header("accept", "application/json").send().await)
        }
        "Content-Type text/plain -> 415" => {
            let t = srv.lead();
            outcome(&srv.post_req(&t, init(json!({}))).header("content-type", "text/plain").send().await)
        }
        "not JSON-RPC -> 400 -32700" => outcome(&srv.post(&srv.lead(), json!({ "hello": 1 })).await),
        "stateless initialize -> JSON, no session" => {
            outcome_with(&srv.post(&srv.lead(), init(json!({}))).await, instr, &["mcp-session-id"], None)
        }
        "initialize with an unknown version -> 2025-11-25" => {
            let mut body = init(json!({}));
            body["params"]["protocolVersion"] = json!("1999-01-01");
            drop_keys(&srv.post(&srv.lead(), body).await, instr)
        }
        "initialize 2025-06-18 echoes it" => {
            let mut body = init(json!({}));
            body["params"]["protocolVersion"] = json!("2025-06-18");
            drop_keys(&srv.post(&srv.lead(), body).await, instr)
        }
        "server/discover (2026-07-28 probe) -> 400 -32000" => {
            let t = srv.lead();
            let body = json!({ "jsonrpc": "2.0", "id": "server-discover-probe-1", "method": "server/discover", "params": {} });
            outcome(&srv.post_req(&t, body).header("mcp-protocol-version", "2026-07-28").send().await)
        }
        "stateless tools/list -> JSON, verbatim tools" => {
            outcome(&srv.post(&srv.lead(), json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await)
        }
        "worker tools/list" => {
            outcome(&srv.post(&srv.issue(WORKER), json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await)
        }
        "stateless ping" => outcome(&srv.post(&srv.lead(), json!({ "jsonrpc": "2.0", "id": 7, "method": "ping" })).await),
        "unknown method -> -32601" => {
            outcome(&srv.post(&srv.lead(), json!({ "jsonrpc": "2.0", "id": 2, "method": "nope/nope" })).await)
        }
        "unknown tool -> -32602" => outcome(&srv.post(&srv.lead(), call(3, "no_such_tool", json!({}))).await),
        "notification only -> 202" => {
            outcome(&srv.post(&srv.lead(), json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await)
        }
        "stateless tools/call -> JSON" => drop_keys(&srv.post(&srv.lead(), support::wait_for(4, 1.0)).await, &["text"]),
        "stateless tools/call with progressToken -> SSE + progress" => {
            let mut body = support::wait_for(5, 3.0);
            body["params"]["_meta"] = json!({ "progressToken": "p1" });
            drop_keys(&srv.post(&srv.lead(), body).await, &["text"])
        }
        "batch of two requests -> JSON array" => outcome(
            &srv.post(
                &srv.lead(),
                json!([{ "jsonrpc": "2.0", "id": 1, "method": "ping" }, { "jsonrpc": "2.0", "id": 2, "method": "nope/nope" }]),
            )
            .await,
        ),
        "elicitation initialize -> SSE session; tools/list in it; DELETE; then 404 -32001" => {
            let t = srv.lead();
            let first_res = srv.post(&t, init(json!({ "elicitation": { "form": {} } }))).await;
            let id = first_res.session().unwrap_or_default();
            let note = srv.in_session(&t, &id, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
            let list = srv.in_session(&t, &id, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await;
            let del = srv
                .req("DELETE", "/mcp")
                .header("authorization", &bearer(&t))
                .header("mcp-session-id", &id)
                .header("mcp-protocol-version", "2025-11-25")
                .send()
                .await;
            let after = srv.in_session(&t, &id, json!({ "jsonrpc": "2.0", "id": 2, "method": "tools/list" })).await;
            let tools = list.json()["result"]["tools"].as_array().map(Vec::len);
            json!({
                "initialize": outcome_with(&first_res, instr, &["mcp-session-id"], None),
                "initialized": outcome(&note),
                "list": { "status": list.status, "type": list.content_type(), "tools": tools },
                "delete": outcome(&del),
                "after": outcome(&after),
            })
        }
        "elicitation: {} (old spelling) also gets a session" => {
            let r = srv.post(&srv.lead(), init(json!({ "elicitation": {} }))).await;
            json!({ "status": r.status, "type": r.content_type().map(|t| t.split(';').next().unwrap_or("")), "session": r.session().is_some() })
        }
        "url-only elicitation stays stateless" => {
            let r = srv.post(&srv.lead(), init(json!({ "elicitation": { "url": {} } }))).await;
            json!({ "status": r.status, "type": r.content_type().map(|t| t.split(';').next().unwrap_or("")), "session": r.session().is_some() })
        }
        "re-initialize inside a session -> 400 -32600" => {
            let t = srv.lead();
            let s = srv.session(&t).await;
            outcome(&srv.in_session(&t, &s, init(json!({ "elicitation": { "form": {} } }))).await)
        }
        "session of another token -> 404 -32001" => {
            let s = srv.session(&srv.lead()).await;
            outcome(&srv.in_session(&srv.issue(WORKER), &s, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await)
        }
        "revoked token: its session answers 401" => {
            let t = srv.issue(WORKER);
            let s = srv.session(&t).await;
            srv.server.revoke_cell(WORKER);
            outcome(&srv.in_session(&t, &s, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await)
        }
        "fifth session of a token closes the first" => {
            let t = srv.lead();
            let mut ids = Vec::new();
            for _ in 0..5 {
                ids.push(srv.session(&t).await);
            }
            let oldest = srv.in_session(&t, &ids[0], json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })).await;
            let newest = srv.in_session(&t, &ids[4], json!({ "jsonrpc": "2.0", "id": 1, "method": "ping" })).await;
            json!({ "oldest": outcome(&oldest), "newest": outcome(&newest) })
        }
        "elicitation round trip inside a session (accept)" => {
            let t = srv.lead();
            let s = srv.session(&t).await;
            srv.in_session(&t, &s, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
            let reply_status = Arc::new(Mutex::new(None::<u16>));
            let asked = Arc::new(Mutex::new(None::<Value>));
            let a = asked.clone();
            let body = call(9, "close_grid", json!({ "gridId": "grid-side3" }));
            let req = srv.post_req(&t, body).header("mcp-session-id", &s).header("mcp-protocol-version", "2025-11-25");
            // The answer is posted from inside the read loop in JS; here the frame handler hands the id to a task.
            let (addr, token, session, rs) = (srv.addr.clone(), t.clone(), s.clone(), reply_status.clone());
            let res = req
                .stream(Duration::from_secs(20), move |m| {
                    if m["method"] == "elicitation/create" && a.lock().is_none() {
                        *a.lock() = Some(m["id"].clone());
                        let (addr, token, session, rs, id) = (addr.clone(), token.clone(), session.clone(), rs.clone(), m["id"].clone());
                        tokio::spawn(async move {
                            let answer = json!({ "jsonrpc": "2.0", "id": id, "result": { "action": "accept", "content": { "confirm": true } } });
                            let r = support::http::Request::new(&addr, "POST", "/mcp")
                                .header("content-type", "application/json")
                                .header("accept", ACCEPT)
                                .header("authorization", &bearer(&token))
                                .header("mcp-session-id", &session)
                                .header("mcp-protocol-version", "2025-11-25")
                                .body(answer)
                                .send()
                                .await;
                            *rs.lock() = Some(r.status);
                        });
                    }
                    Flow::Continue
                })
                .await;
            // The answer's own 202 may come back just after the call's stream ended.
            for _ in 0..100 {
                if reply_status.lock().is_some() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            let extra = reply_status.lock().map(|status| json!({ "replyStatus": status }));
            outcome_with(&res, &["text", "message", "title"], &[], extra)
        }
        "MCP task: create, get, list, result, get after" => {
            let t = srv.lead();
            let created = srv.post(&t, task_call(1, 1.0, json!({ "ttl": 1000 }))).await;
            let task_id = created.json()["result"]["task"]["taskId"].clone();
            let get = srv.post(&t, rpc(2, "tasks/get", json!({ "taskId": task_id }))).await;
            let list = srv.post(&t, rpc(3, "tasks/list", json!({}))).await;
            let result = srv.post(&t, rpc(4, "tasks/result", json!({ "taskId": task_id }))).await;
            let after = srv.post(&t, rpc(5, "tasks/get", json!({ "taskId": task_id }))).await;
            let other = srv.post(&srv.issue(WORKER), rpc(6, "tasks/get", json!({ "taskId": task_id }))).await;
            let mut result_outcome = drop_keys(&result, &["text"]);
            result_outcome["ms"] = json!(if result.ms > 500 { "blocked until done" } else { "immediate" });
            json!({ "created": outcome(&created), "get": outcome(&get), "list": outcome(&list), "result": result_outcome,
                "after": outcome(&after), "otherToken": outcome(&other) })
        }
        "MCP task for a tool without task support -> error" => {
            let body = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "get_context", "arguments": {}, "task": {} } });
            outcome(&srv.post(&srv.lead(), body).await)
        }
        "MCP task cancel, then cancel again" => {
            let t = srv.lead();
            let created = srv.post(&t, task_call(1, 30.0, json!({}))).await;
            let task_id = created.json()["result"]["task"]["taskId"].clone();
            let cancel = srv.post(&t, rpc(2, "tasks/cancel", json!({ "taskId": task_id }))).await;
            let again = srv.post(&t, rpc(3, "tasks/cancel", json!({ "taskId": task_id }))).await;
            json!({ "created": outcome(&created), "cancel": outcome(&cancel), "again": outcome(&again) })
        }
        "in-flight cap: the 9th parallel call of a token -> 429 Retry-After 1" => {
            let t = srv.lead();
            let calls = (0..9).map(|i| srv.post(&t, support::wait_for(i, 2.0)));
            let all = futures::future::join_all(calls).await;
            let mut statuses: Vec<String> = all.iter().map(|r| r.status.to_string()).collect();
            statuses.sort();
            let statuses: Vec<u16> = statuses.iter().map(|s| s.parse().unwrap()).collect();
            let retry = all.iter().find(|r| r.status == 429).and_then(|r| r.header("retry-after").map(str::to_string));
            json!({ "statuses": statuses, "retryAfter": retry })
        }
        "client goes away during a stateless JSON call" => vanished(srv, &srv.lead(), None).await,
        "client goes away during a session SSE call" => {
            let t = srv.lead();
            let s = srv.session(&t).await;
            vanished(srv, &t, Some(&s)).await
        }
        "tasks/list pages 10 at a time (nextCursor), unknown cursor -> -32602" => {
            let t = srv.lead();
            let mut ids = Vec::new();
            for i in 0..12 {
                let r = srv.post(&t, task_call(i, 30.0, json!({}))).await;
                ids.push(r.json()["result"]["task"]["taskId"].clone());
            }
            let first_page = srv.post(&t, rpc(20, "tasks/list", json!({}))).await;
            let cursor = first_page.json()["result"]["nextCursor"].clone();
            let second = srv.post(&t, rpc(21, "tasks/list", json!({ "cursor": cursor }))).await;
            let bad = srv.post(&t, rpc(22, "tasks/list", json!({ "cursor": "nope" }))).await;
            let bad_type = srv.post(&t, rpc(23, "tasks/list", json!({ "cursor": 5 }))).await;
            for (i, task_id) in ids.iter().enumerate() {
                srv.post(&t, rpc(100 + i as u64, "tasks/cancel", json!({ "taskId": task_id }))).await;
            }
            let page = |r: &Res| {
                let m = r.json()["result"].clone();
                let keys: Vec<String> = m.as_object().map(|o| o.keys().cloned().collect()).unwrap_or_default();
                let tasks = m["tasks"].as_array().cloned().unwrap_or_default();
                let order: Vec<i64> =
                    tasks.iter().map(|x| ids.iter().position(|i| *i == x["taskId"]).map_or(-1, |p| p as i64)).collect();
                json!({ "keys": keys, "count": tasks.len(), "order": order })
            };
            json!({ "first": page(&first_page), "cursorIsTenth": cursor == ids[9], "second": page(&second),
                "bad": outcome(&bad), "badType": outcome(&bad_type) })
        }
        "strict JSON-RPC messages (ids, params, extra keys, error responses)" => {
            let t = srv.lead();
            let mut out = Map::new();
            let cases: Vec<(&str, support::http::Body)> = vec![
                ("fractionId", json!({ "jsonrpc": "2.0", "id": 1.5, "method": "ping" }).into()),
                ("wholeFloatId", "{\"jsonrpc\":\"2.0\",\"id\":2.0,\"method\":\"ping\"}".into()),
                ("unsafeId", json!({ "jsonrpc": "2.0", "id": 9_007_199_254_740_992u64, "method": "ping" }).into()),
                ("paramsArray", json!({ "jsonrpc": "2.0", "id": 1, "method": "ping", "params": [] }).into()),
                ("paramsNull", json!({ "jsonrpc": "2.0", "id": 1, "method": "ping", "params": null }).into()),
                ("extraKey", json!({ "jsonrpc": "2.0", "id": 1, "method": "ping", "foo": 1 }).into()),
                (
                    "badProgressToken",
                    json!({ "jsonrpc": "2.0", "id": 1, "method": "ping", "params": { "_meta": { "progressToken": 1.5 } } })
                        .into(),
                ),
                (
                    "notificationWithParamsString",
                    json!({ "jsonrpc": "2.0", "method": "notifications/initialized", "params": "x" }).into(),
                ),
                ("errorWithoutId", json!({ "jsonrpc": "2.0", "error": { "code": -1, "message": "x" } }).into()),
                ("errorWithNullId", json!({ "jsonrpc": "2.0", "id": null, "error": { "code": -1, "message": "x" } }).into()),
                ("errorFractionCode", json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": 1.5, "message": "x" } }).into()),
                ("resultArray", json!({ "jsonrpc": "2.0", "id": 1, "result": [] }).into()),
                ("resultObject", json!({ "jsonrpc": "2.0", "id": 1, "result": {} }).into()),
            ];
            for (name, body) in cases {
                out.insert(name.into(), outcome(&srv.post(&t, body).await));
            }
            Value::Object(out)
        }
        "invalid UTF-8 in the body becomes U+FFFD (not -32700)" => {
            let mut raw = b"{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\",\"params\":{\"x\":\"a".to_vec();
            raw.extend([0xff, 0xc3]);
            raw.extend(b"\"}}");
            outcome(&srv.post(&srv.lead(), support::http::Body::Raw(raw)).await)
        }
        "tasks/result after tasks/cancel -> -32603 without prefix" => {
            let t = srv.lead();
            let created = srv.post(&t, task_call(1, 30.0, json!({}))).await;
            let task_id = created.json()["result"]["task"]["taskId"].clone();
            srv.post(&t, rpc(2, "tasks/cancel", json!({ "taskId": task_id }))).await;
            outcome(&srv.post(&t, rpc(3, "tasks/result", json!({ "taskId": task_id }))).await)
        }
        "request params failing the method schema -> -32603 zod issues" => {
            let t = srv.lead();
            let send = |method: &str, params: Option<Value>| {
                let mut body = json!({ "jsonrpc": "2.0", "id": 1, "method": method });
                if let Some(p) = params {
                    body["params"] = p;
                }
                srv.post(&t, body)
            };
            json!({
                "callNoName": outcome(&send("tools/call", Some(json!({ "arguments": {} }))).await),
                "callNameNumber": outcome(&send("tools/call", Some(json!({ "name": 5 }))).await),
                "callNoParams": outcome(&send("tools/call", None).await),
                "callArgumentsArray": outcome(&send("tools/call", Some(json!({ "name": "get_context", "arguments": [] }))).await),
                "callTaskString": outcome(&send("tools/call", Some(json!({ "name": "wait_for", "task": "x" }))).await),
                "callTtlString": outcome(&send("tools/call", Some(json!({ "name": "get_context", "task": { "ttl": "x" } }))).await),
                "getNoTaskId": outcome(&send("tasks/get", Some(json!({}))).await),
                "resultNoParams": outcome(&send("tasks/result", None).await),
                "cancelTaskIdNumber": outcome(&send("tasks/cancel", Some(json!({ "taskId": 1 }))).await),
            })
        }
        "MCP task ttl with a fraction is kept" => {
            outcome(&srv.post(&srv.lead(), task_call(1, 1.0, json!({ "ttl": 70000.5 }))).await)
        }
        "session tools/call cancelled by notifications/cancelled gets no answer" => {
            let t = srv.lead();
            let s = srv.session(&t).await;
            srv.in_session(&t, &s, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
            let mut body = support::wait_for(7, 20.0);
            body["params"]["_meta"] = json!({ "progressToken": "p" });
            let (srv_addr, tk, sid) = (srv.addr.clone(), t.clone(), s.clone());
            let streaming = tokio::spawn(async move {
                let seen = Arc::new(Mutex::new(Vec::new()));
                let sn = seen.clone();
                let res = support::http::Request::new(&srv_addr, "POST", "/mcp")
                    .header("content-type", "application/json")
                    .header("accept", ACCEPT)
                    .header("authorization", &bearer(&tk))
                    .header("mcp-session-id", &sid)
                    .header("mcp-protocol-version", "2025-11-25")
                    .body(body)
                    .stream(Duration::from_millis(3500), move |m| {
                        sn.lock().push(m.clone());
                        Flow::Continue
                    })
                    .await;
                let seen = seen.lock().clone();
                (res.status, seen)
            });
            tokio::time::sleep(Duration::from_millis(500)).await;
            let cancel_status = srv
                .in_session(&t, &s, json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 7, "reason": "user" } }))
                .await
                .status;
            let (status, seen) = streaming.await.unwrap();
            json!({ "status": status, "cancelStatus": cancel_status, "messages": mask(&Value::Array(seen), &["message"]) })
        }
        "elicitation aborted by notifications/cancelled (with and without reason)" => {
            let mut out = Map::new();
            for (name, reason) in [("withReason", Some("user closed")), ("withoutReason", None)] {
                let t = srv.lead();
                let s = srv.session(&t).await;
                srv.in_session(&t, &s, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
                let mut params = json!({ "requestId": 9 });
                if let Some(r) = reason {
                    params["reason"] = json!(r);
                }
                let note = json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": params });
                let body = call(9, "close_grid", json!({ "gridId": "grid-side4" }));
                let (status, seen) = stream(srv, &t, &s, body, Duration::from_millis(2500), |m| {
                    if m["method"] == "elicitation/create" {
                        spawn_in_session(srv, &t, &s, note.clone());
                    }
                    Flow::Continue
                })
                .await;
                out.insert(
                    name.into(),
                    json!({ "status": status, "messages": mask(&Value::Array(seen), &["message", "title"]) }),
                );
            }
            Value::Object(out)
        }
        "elicitation answers failing ElicitResultSchema or the requested schema count as cancel" => {
            let replies = [
                ("contentNotMatchingSchema", json!({ "result": { "action": "accept", "content": { "confirm": "yes" } } })),
                ("missingRequired", json!({ "result": { "action": "accept", "content": {} } })),
                ("unknownAction", json!({ "result": { "action": "yes", "content": { "confirm": true } } })),
                ("nestedContent", json!({ "result": { "action": "accept", "content": { "confirm": { "v": true } } } })),
                ("errorAnswer", json!({ "error": { "code": -1, "message": "no" } })),
                ("declineWithNullContent", json!({ "result": { "action": "decline", "content": null } })),
                (
                    "confirmPlusNestedValue",
                    json!({ "result": { "action": "accept", "content": { "confirm": true, "extra": { "a": 1 } } } }),
                ),
                (
                    "confirmPlusNumberArray",
                    json!({ "result": { "action": "accept", "content": { "confirm": true, "list": [1] } } }),
                ),
            ];
            let mut out = Map::new();
            for (name, reply) in replies {
                let t = srv.lead();
                let s = srv.session(&t).await;
                srv.in_session(&t, &s, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
                let body = call(9, "close_grid", json!({ "gridId": "grid-side4" }));
                let (status, seen) = stream(srv, &t, &s, body, Duration::from_millis(4000), |m| {
                    if m["method"] == "elicitation/create" {
                        let mut answer = json!({ "jsonrpc": "2.0", "id": m["id"] });
                        for (k, v) in reply.as_object().unwrap() {
                            answer[k] = v.clone();
                        }
                        spawn_in_session(srv, &t, &s, answer);
                    }
                    if m["id"] == 9 { Flow::Finish } else { Flow::Continue }
                })
                .await;
                let answer = seen.iter().find(|m| m["id"] == 9).cloned().unwrap_or(Value::Null);
                let is_error = answer["result"]["isError"].clone();
                let text = answer["result"]["content"][0]["text"].as_str().map(|t| t.chars().take(40).collect::<String>());
                out.insert(name.into(), json!({ "status": status, "isError": is_error, "text": text }));
            }
            Value::Object(out)
        }
        "a task created in a session is hidden from other sessions of the token, not from stateless calls" => {
            let t = srv.lead();
            let a = srv.session(&t).await;
            let b = srv.session(&t).await;
            let created = first(&srv.in_session(&t, &a, task_call(1, 30.0, json!({}))).await);
            let task_id = created["result"]["task"]["taskId"].clone();
            let stateless = first(&srv.post(&t, task_call(2, 30.0, json!({}))).await)["result"]["task"]["taskId"].clone();
            let count = |r: &Res| {
                let m = first(r);
                match m["result"]["tasks"].as_array() {
                    Some(tasks) => json!(tasks.len()),
                    None => m,
                }
            };
            let status = |r: &Res| first(r)["result"]["status"].clone();
            let out = json!({
                "getFromB": mask(&first(&srv.in_session(&t, &b, rpc(3, "tasks/get", json!({ "taskId": task_id }))).await), &[]),
                "getFromA": status(&srv.in_session(&t, &a, rpc(4, "tasks/get", json!({ "taskId": task_id }))).await),
                "getStateless": status(&srv.post(&t, rpc(5, "tasks/get", json!({ "taskId": task_id }))).await),
                "listA": count(&srv.in_session(&t, &a, rpc(6, "tasks/list", json!({}))).await),
                "listB": count(&srv.in_session(&t, &b, rpc(7, "tasks/list", json!({}))).await),
                "listStateless": count(&srv.post(&t, rpc(8, "tasks/list", json!({}))).await),
                "cancelFromB": mask(&first(&srv.in_session(&t, &b, rpc(9, "tasks/cancel", json!({ "taskId": task_id }))).await), &[]),
                "resultFromB": mask(&first(&srv.in_session(&t, &b, rpc(10, "tasks/result", json!({ "taskId": task_id }))).await), &[]),
            });
            srv.post(&t, rpc(11, "tasks/cancel", json!({ "taskId": task_id }))).await;
            srv.post(&t, rpc(12, "tasks/cancel", json!({ "taskId": stateless }))).await;
            out
        }
        // ----- added with the M1 review fixes -----
        "initialize failing InitializeRequestSchema: no session, no version skip, -32603 zod issues" => {
            let t = srv.lead();
            let sid = srv.session(&t).await;
            let base = init(json!({}))["params"].clone();
            let send = async |params: Option<Value>, version: Option<&str>| {
                let mut body = json!({ "jsonrpc": "2.0", "id": 0, "method": "initialize" });
                if let Some(p) = params {
                    body["params"] = p;
                }
                let mut req = srv.post_req(&t, body);
                if let Some(v) = version {
                    req = req.header("mcp-protocol-version", v);
                }
                outcome_with(&req.send().await, instr, &["mcp-session-id"], None)
            };
            let with = |key: &str, value: Value| {
                let mut p = base.clone();
                p[key] = value;
                Some(p)
            };
            json!({
                "elicitationWithoutClientInfo":
                    send(Some(json!({ "protocolVersion": "2025-06-18", "capabilities": { "elicitation": {} } })), None).await,
                "withoutClientInfoBogusHeader":
                    send(Some(json!({ "protocolVersion": "2025-06-18", "capabilities": {} })), Some("bogus")).await,
                "protocolVersionNumber": send(with("protocolVersion", json!(5)), None).await,
                "noParams": send(None, None).await,
                "nestedCapabilities": send(with("capabilities", json!({
                    "roots": { "listChanged": "y" }, "sampling": { "context": 1, "tools": [] }, "elicitation": "x",
                    "tasks": { "list": 1, "requests": { "elicitation": { "create": "s" }, "sampling": [] } },
                    "experimental": { "a": null, "b": {} }, "extensions": [] })), None).await,
                "formElicitationNull": send(with("capabilities", json!({ "elicitation": { "form": null, "url": "s" } })), None).await,
                "formApplyDefaults":
                    send(with("capabilities", json!({ "elicitation": { "url": {}, "form": { "applyDefaults": 1 } } })), None).await,
                "clientInfoFields": send(with("clientInfo", json!({ "name": 1, "title": 2,
                    "icons": [{ "src": 1, "mimeType": 2, "sizes": [3, "x"], "theme": "blue" }, 5], "websiteUrl": 3, "description": 4 })), None).await,
                "clientInfoMissing": send(Some(json!({ "protocolVersion": 1, "capabilities": [], "clientInfo": null })), None).await,
                "validWithBogusHeader": send(Some(base.clone()), Some("bogus")).await,
                "invalidInSession": outcome(&srv.in_session(&t, &sid, json!({ "jsonrpc": "2.0", "id": 3, "method": "initialize",
                    "params": { "protocolVersion": "2025-11-25", "capabilities": {} } })).await),
                "validNotificationInSession":
                    outcome(&srv.in_session(&t, &sid, json!({ "jsonrpc": "2.0", "method": "initialize", "params": base })).await),
            })
        }
        "tools/list params failing the schema -> -32603 zod issues" => {
            let t = srv.lead();
            let sid = srv.session(&t).await;
            let list = srv.post(&t, rpc(3, "tools/list", json!({ "cursor": "x" }))).await;
            let batch = srv
                .in_session(
                    &t,
                    &sid,
                    json!([{ "jsonrpc": "2.0", "id": 1, "method": "ping" }, rpc(2, "tools/list", json!({ "cursor": 3 }))]),
                )
                .await;
            let mut by_id = outcome(&batch);
            let mut seen = batch.messages();
            seen.sort_by_key(|m| m["id"].as_i64());
            by_id["messages"] = Value::Array(seen);
            json!({
                "cursorNumber": outcome(&srv.post(&t, rpc(1, "tools/list", json!({ "cursor": 5 }))).await),
                "cursorNull": outcome(&srv.post(&t, rpc(2, "tools/list", json!({ "cursor": null }))).await),
                "cursorString": { "status": list.status, "tools": first(&list)["result"]["tools"].as_array().map(Vec::len) },
                "sessionBatch": by_id,
            })
        }
        "a closed session ends its open call streams without an answer (DELETE, trim, revoke)" => {
            let mut out = Map::new();
            for kind in ["delete", "trim", "revoke"] {
                let t = srv.lead();
                let s = srv.session(&t).await;
                srv.in_session(&t, &s, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
                let at = Instant::now();
                let mut body = support::wait_for(7, 3.0);
                body["params"]["_meta"] = json!({ "progressToken": "p" });
                let (addr, tk, sid) = (srv.addr.clone(), t.clone(), s.clone());
                let streaming = tokio::spawn(async move {
                    let seen = Arc::new(Mutex::new(Vec::new()));
                    let sn = seen.clone();
                    let res = support::http::Request::new(&addr, "POST", "/mcp")
                        .header("content-type", "application/json")
                        .header("accept", ACCEPT)
                        .header("authorization", &bearer(&tk))
                        .header("mcp-session-id", &sid)
                        .header("mcp-protocol-version", "2025-11-25")
                        .body(body)
                        .stream(Duration::from_millis(4500), move |m| {
                            sn.lock().push(m.clone());
                            Flow::Continue
                        })
                        .await;
                    let seen = seen.lock().clone();
                    (res.status, seen)
                });
                tokio::time::sleep(Duration::from_millis(500)).await;
                let closed = match kind {
                    "delete" => json!(
                        srv.req("DELETE", "/mcp")
                            .header("authorization", &bearer(&t))
                            .header("mcp-session-id", &s)
                            .header("mcp-protocol-version", "2025-11-25")
                            .send()
                            .await
                            .status
                    ),
                    "trim" => {
                        for _ in 0..4 {
                            srv.session(&t).await;
                        }
                        json!("trimmed")
                    }
                    _ => {
                        srv.server.revoke_cell(support::LEAD);
                        json!("revoked")
                    }
                };
                let (status, seen) = streaming.await.unwrap();
                let ended = if at.elapsed() < Duration::from_millis(2500) { "with the close" } else { "later" };
                out.insert(
                    kind.into(),
                    json!({ "status": status, "closed": closed, "messages": mask(&Value::Array(seen), &["text", "message"]), "ended": ended }),
                );
            }
            Value::Object(out)
        }
        "notifications/cancelled failing its schema (reason null) is dropped" => {
            let t = srv.lead();
            let s = srv.session(&t).await;
            srv.in_session(&t, &s, json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await;
            let at = Instant::now();
            let (addr, tk, sid) = (srv.addr.clone(), t.clone(), s.clone());
            let streaming = tokio::spawn(async move {
                let res = support::http::Request::new(&addr, "POST", "/mcp")
                    .header("content-type", "application/json")
                    .header("accept", ACCEPT)
                    .header("authorization", &bearer(&tk))
                    .header("mcp-session-id", &sid)
                    .header("mcp-protocol-version", "2025-11-25")
                    .body(support::wait_for(7, 2.0))
                    .stream(Duration::from_millis(4000), |_| Flow::Continue)
                    .await;
                (res.status, res.messages())
            });
            tokio::time::sleep(Duration::from_millis(500)).await;
            let null_reason = srv
                .in_session(&t, &s, json!({ "jsonrpc": "2.0", "method": "notifications/cancelled", "params": { "requestId": 7, "reason": null } }))
                .await
                .status;
            let (status, seen) = streaming.await.unwrap();
            let answered = if at.elapsed() > Duration::from_millis(1500) { "after the wait" } else { "early" };
            json!({ "status": status, "nullReason": null_reason, "messages": mask(&Value::Array(seen), &["text"]), "answered": answered })
        }
        "a request id with a lone surrogate is echoed unchanged" => {
            let t = srv.lead();
            let sid = srv.session(&t).await;
            let raw = |r: &Res| {
                let kind = r.content_type().unwrap_or("").split(';').next().unwrap_or("").to_string();
                json!({ "status": r.status, "type": kind, "text": r.text })
            };
            json!({
                "stateless": raw(&srv.post(&t, r#"{"jsonrpc":"2.0","id":"\ud800","method":"ping"}"#).await),
                "upperCaseAndEscapes": raw(&srv.post(&t, r#"{"jsonrpc":"2.0","id":"a\uDC00\nA\/","method":"ping"}"#).await),
                "batch": raw(&srv.post(&t, r#"[{"jsonrpc":"2.0","id":"\ud800","method":"ping"},{"jsonrpc":"2.0","id":"\udbff","method":"nope/nope"}]"#).await),
                "session": raw(&srv.in_session(&t, &sid, r#"{"jsonrpc":"2.0","id":"\ud83d","method":"ping"}"#).await),
            })
        }
        other => json!({ "error": format!("case not ported: {other}") }),
    }
}

/// All 57 cases in the recorded order on one server, as the JS driver runs them (later cases see the earlier ones' grids).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_57_protocol_cases_match_1_1_4() {
    let golden: Value = serde_json::from_str(GOLDEN).unwrap();
    let golden = golden.as_object().unwrap();
    assert_eq!(golden.len(), 57, "the TS reference has 57 cases");
    let srv = Srv::start(Srv::wire_config()).await;
    let started = Instant::now();
    let mut diffs = Vec::new();
    for (id, expected) in golden {
        let got = run_case(&srv, id).await;
        let (got_text, expected_text) = (unimux_core::js_json::stringify(&got), unimux_core::js_json::stringify(expected));
        if got_text != expected_text {
            diffs.push(format!("{id}\n  rust: {got_text}\n  1.1.4: {expected_text}"));
        }
    }
    assert!(diffs.is_empty(), "{} / 57 cases differ from 1.1.4:\n{}", diffs.len(), diffs.join("\n"));
    eprintln!("57 / 57 cases identical to 1.1.4 in {:?}", started.elapsed());
}
