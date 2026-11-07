//! The real tool layer (host::McpTools) behind the real server, over HTTP: the tool cases of 1.1.4's
//! mcp-tasks-elicit.test.ts (close_grid confirmation, agent names, wait_for as an MCP task), mcp.test.ts (a client lists
//! the tools, calls them and the results persist) and mcp-protocol.test.ts (role-aware instructions, the worker's list,
//! progress while a wait_for waits). The automation service is the stand-in of src/fake.rs (M3 ports the real one).

mod support;

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Value, json};
use support::http::{ACCEPT, Flow, Request, Res};
use support::{call, init};
use tokio_util::sync::CancellationToken;
use unimux_mcp::catalog;
use unimux_mcp::fake::FakeAutomation;
use unimux_mcp::tools::BoxFuture;
use unimux_mcp::{Automation, Config, McpServer, McpTools, OpError};

const LEAD: &str = "lead";
const WORKER: &str = "backend";
const REVIEWER: &str = "review";

fn harness_state() -> Value {
    json!({
        "version": 1,
        "projects": [{ "id": "p1", "name": "Project", "path": "D:/project", "tabs": [{ "id": "g1", "name": "Team", "cells": [
            { "id": LEAD, "profileId": "claude", "role": "coordinator", "name": "Lead" },
            { "id": WORKER, "profileId": "codex", "role": "worker", "name": "Backend" },
            { "id": REVIEWER, "profileId": "claude", "role": "worker", "name": "Review" },
        ] }] }],
        "profiles": [{ "id": "claude", "name": "Claude", "cli": "claude" }, { "id": "codex", "name": "Codex", "cli": "codex" }, { "id": "shell", "name": "Terminal", "cli": "shell" }],
        "settings": { "delegation": { "mode": "auto", "maxAgents": 4 } },
        "automation": { "paused": false, "tasks": [], "messages": [], "events": [] },
    })
}

/// The stand-in service as the tool layer sees it, recording how every wait_for of the service ended (its result).
struct Watched {
    inner: FakeAutomation,
    waits_ended: Arc<Mutex<Vec<Value>>>,
}

impl Automation for Watched {
    fn state(&self) -> Arc<Value> {
        self.inner.state()
    }
    fn role_of(&self, cell: &str) -> Option<catalog::Role> {
        self.inner.role_of(cell)
    }
    fn prompts_shown(&self, cell: &str) -> Arc<Mutex<std::collections::HashSet<String>>> {
        self.inner.prompts_shown(cell)
    }
    fn execute(
        &self,
        op: &str,
        args: Value,
        actor: &str,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<'static, Result<Value, OpError>> {
        let run = self.inner.execute(op, args, actor, cancel);
        if op != "wait_for" {
            return run;
        }
        let ended = self.waits_ended.clone();
        Box::pin(async move {
            let r = run.await;
            ended.lock().push(r.as_ref().map_or_else(|e| json!({ "error": format!("{e:?}") }), Clone::clone));
            r
        })
    }
}

struct H {
    server: Arc<McpServer>,
    service: FakeAutomation,
    waits_ended: Arc<Mutex<Vec<Value>>>,
    addr: String,
}

impl H {
    async fn start() -> Self {
        Self::start_with(Config { rate: None, progress_every: Duration::from_millis(300), ..Config::default() }).await
    }
    async fn start_with(cfg: Config) -> Self {
        let service = FakeAutomation::with_state(harness_state());
        let waits_ended: Arc<Mutex<Vec<Value>>> = Arc::default();
        let watched = Watched { inner: service.clone(), waits_ended: waits_ended.clone() };
        let server = Arc::new(McpServer::new(McpTools::new(Arc::new(watched)), cfg));
        server.start().await.unwrap();
        let weak = Arc::downgrade(&server);
        service.set_probe(Arc::new(move |cell| weak.upgrade().map_or("off", |s| s.connection(cell).as_str())));
        let addr = server.url().unwrap().trim_start_matches("http://").trim_end_matches("/mcp").to_string();
        Self { server, service, waits_ended, addr }
    }
    /// The result of the next service wait_for that ends within `limit` (None: none ended).
    async fn wait_ended(&self, limit: Duration) -> Option<Value> {
        let until = Instant::now() + limit;
        while Instant::now() < until {
            if let Some(v) = self.waits_ended.lock().first().cloned() {
                return Some(v);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        None
    }
    fn req(&self, token: &str) -> Request<'_> {
        Request::new(&self.addr, "POST", "/mcp")
            .header("content-type", "application/json")
            .header("accept", ACCEPT)
            .header("authorization", &format!("Bearer {token}"))
    }
    async fn post(&self, token: &str, body: Value) -> Res {
        self.req(token).body(body).send().await
    }
    async fn session(&self, token: &str) -> String {
        self.post(token, init(json!({ "elicitation": { "form": {} } }))).await.session().expect("a session")
    }
    /// A tool call; the text of its result and whether it is an error.
    async fn tool(&self, token: &str, name: &str, args: Value) -> (String, bool) {
        let r = self.post(token, call(1, name, args)).await.json();
        let result = &r["result"];
        (result["content"][0]["text"].as_str().unwrap_or_default().to_string(), result["isError"] == json!(true))
    }
    /// A tool call in a session: elicitation requests are answered with `answer` (and collected).
    async fn tool_in_session(
        &self,
        token: &str,
        session: &str,
        name: &str,
        args: Value,
        answer: impl Fn(&Value) -> Value + Send + Sync + 'static,
    ) -> (String, bool, Vec<Value>) {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let (a, addr, t, s) = (asked.clone(), self.addr.clone(), token.to_string(), session.to_string());
        let answer = Arc::new(answer);
        let res = self
            .req(token)
            .header("mcp-session-id", session)
            .header("mcp-protocol-version", "2025-11-25")
            .body(call(7, name, args))
            .stream(Duration::from_secs(20), move |m| {
                if m["method"] == "elicitation/create" {
                    a.lock().push(m.clone());
                    let reply = json!({ "jsonrpc": "2.0", "id": m["id"], "result": answer(m) });
                    let (addr, t, s) = (addr.clone(), t.clone(), s.clone());
                    tokio::spawn(async move {
                        let r = Request::new(&addr, "POST", "/mcp")
                            .header("content-type", "application/json")
                            .header("accept", ACCEPT)
                            .header("authorization", &format!("Bearer {t}"))
                            .header("mcp-session-id", &s)
                            .header("mcp-protocol-version", "2025-11-25")
                            .body(reply)
                            .send()
                            .await;
                        assert_eq!(r.status, 202);
                    });
                }
                if m["id"] == json!(7) { Flow::Finish } else { Flow::Continue }
            })
            .await;
        let done = res.messages().into_iter().find(|m| m["id"] == json!(7)).unwrap_or(Value::Null);
        let result = &done["result"];
        let asked = asked.lock().clone();
        (result["content"][0]["text"].as_str().unwrap_or_default().to_string(), result["isError"] == json!(true), asked)
    }
    fn tabs(&self) -> Vec<Value> {
        self.service.state()["projects"][0]["tabs"].as_array().cloned().unwrap_or_default()
    }
    /// A second grid with one worker that has an open task (close_grid cannot close the caller's own grid).
    async fn grid_with_open_task(&self) -> Value {
        self.service
            .execute("create_grid", json!({ "name": "Side", "cells": [{ "profileId": "codex", "role": "worker", "name": "Side worker", "prompt": "Work" }] }), LEAD, None)
            .await
            .unwrap()
    }
}

#[tokio::test]
async fn close_grid_with_unfinished_tasks_asks_the_user_and_closes_only_after_a_confirmation() {
    let h = H::start().await;
    let team = h.grid_with_open_task().await;
    let token = h.server.issue_token(LEAD);
    let session = h.session(&token).await;
    let grid = team["gridId"].clone();
    let (text, error, asked) =
        h.tool_in_session(&token, &session, "close_grid", json!({ "gridId": grid }), |_| json!({ "action": "decline" })).await;
    assert!(error && text.contains("did not confirm"), "{text}");
    assert_eq!(asked.len(), 1);
    let message = asked[0]["params"]["message"].as_str().unwrap();
    assert!(message.contains("Side") && message.contains("(1)"), "{message}");
    assert_eq!(asked[0]["params"]["mode"], "form");
    assert_eq!(asked[0]["params"]["requestedSchema"]["properties"]["confirm"]["title"], "Close the grid and cancel the tasks");
    assert!(h.tabs().iter().any(|t| t["id"] == grid));

    let (text, error, asked) = h
        .tool_in_session(
            &token,
            &session,
            "close_grid",
            json!({ "gridId": grid }),
            |_| json!({ "action": "accept", "content": { "confirm": true } }),
        )
        .await;
    assert!(!error, "{text}");
    assert_eq!(asked.len(), 1);
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), json!({ "archived": grid, "stopped": 1 }));
    let cell = &team["cellIds"][0];
    let task =
        h.service.state()["automation"]["tasks"].as_array().unwrap().iter().find(|t| &t["cellId"] == cell).cloned().unwrap();
    assert_eq!(task["status"], "cancelled");
}

#[tokio::test]
async fn a_client_without_elicitation_gets_the_plain_error_and_cancel_tasks_never_asks() {
    let h = H::start().await;
    let team = h.grid_with_open_task().await;
    let token = h.server.issue_token(LEAD);
    let (text, error) = h.tool(&token, "close_grid", json!({ "gridId": team["gridId"] })).await;
    assert!(error && text.contains("cancelTasks:true"), "{text}");
    let session = h.session(&token).await;
    let (text, error, asked) = h
        .tool_in_session(&token, &session, "close_grid", json!({ "gridId": team["gridId"], "cancelTasks": true }), |_| {
            panic!("must not ask")
        })
        .await;
    assert!(!error && asked.is_empty(), "{text}");
}

#[tokio::test]
async fn resolves_an_exact_agent_name_and_asks_which_one_when_several_agents_share_it() {
    let h = H::start().await;
    let token = h.server.issue_token(LEAD);
    let session = h.session(&token).await;
    // A unique name needs no question.
    let (text, error, asked) = h
        .tool_in_session(&token, &session, "send_message", json!({ "toCellId": "backend ", "text": "hi" }), |_| {
            panic!("no question")
        })
        .await;
    assert!(!error && asked.is_empty(), "{text}");
    assert_eq!(h.service.state()["automation"]["messages"].as_array().unwrap().last().unwrap()["toCellId"], WORKER);
    // Two agents named "Twin": the user picks the second.
    let team = h
        .service
        .execute("create_grid", json!({ "name": "Twins", "cells": [{ "profileId": "codex", "role": "worker", "name": "Twin" }, { "profileId": "codex", "role": "worker", "name": "Twin" }] }), LEAD, None)
        .await
        .unwrap();
    let (text, error, asked) = h
        .tool_in_session(&token, &session, "create_task", json!({ "cellId": "Twin", "title": "T", "prompt": "P" }), |m| {
            let second = m["params"]["requestedSchema"]["properties"]["cellId"]["oneOf"][1]["const"].clone();
            json!({ "action": "accept", "content": { "cellId": second } })
        })
        .await;
    assert!(!error, "{text}");
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0]["params"]["message"], "Several agents are named \"Twin\". Which one?");
    let options = &asked[0]["params"]["requestedSchema"]["properties"]["cellId"]["oneOf"];
    assert_eq!(options[0]["title"], "Twin (Twins)");
    assert_eq!(h.service.state()["automation"]["tasks"].as_array().unwrap().last().unwrap()["cellId"], team["cellIds"][1]);
    // Without elicitation the ambiguity is an error naming the candidates.
    let plain = h.server.issue_token(REVIEWER);
    let (text, error) = h.tool(&plain, "send_message", json!({ "toCellId": "twin", "text": "x" })).await;
    assert!(error, "{text}");
    assert!(text.contains(team["cellIds"][0].as_str().unwrap()) && text.contains(team["cellIds"][1].as_str().unwrap()), "{text}");
}

#[tokio::test]
async fn lists_wait_for_as_task_capable_and_runs_it_as_a_task_past_the_plain_limit() {
    let h = H::start().await;
    let token = h.server.issue_token(WORKER);
    let list = h.post(&token, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await.json();
    let wait = list["result"]["tools"].as_array().unwrap().iter().find(|t| t["name"] == "wait_for").cloned().unwrap();
    assert_eq!(wait["execution"], json!({ "taskSupport": "optional" }));
    // The worker runs Codex: a plain call may wait 170 s at most.
    let (text, error) = h.tool(&token, "wait_for", json!({ "timeoutSec": 600 })).await;
    assert!(error && text.contains("at most 170"), "{text}");
    let mut body = call(2, "wait_for", json!({ "timeoutSec": 600 }));
    body["params"]["task"] = json!({ "ttl": 120000 });
    let created = h.post(&token, body).await.json();
    let task = created["result"]["task"].clone();
    assert_eq!(task["status"], "working");
    let get = json!({ "jsonrpc": "2.0", "id": 3, "method": "tasks/get", "params": { "taskId": task["taskId"] } });
    assert_eq!(h.post(&token, get).await.json()["result"]["status"], "working");
    h.service.execute("send_message", json!({ "toCellId": WORKER, "text": "wake up" }), LEAD, None).await.unwrap();
    let result = json!({ "jsonrpc": "2.0", "id": 4, "method": "tasks/result", "params": { "taskId": task["taskId"] } });
    let r = h.post(&token, result).await.json();
    let text = r["result"]["content"][0]["text"].as_str().unwrap();
    assert_eq!(serde_json::from_str::<Value>(text).unwrap(), json!({ "event": "inbox", "unreadMessages": 1, "queuedTasks": 0 }));
}

#[tokio::test]
async fn connects_lists_the_tools_and_persists_results_of_agent_calls() {
    let h = H::start().await;
    let token = h.server.issue_token(LEAD);
    let list = h.post(&token, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await.json();
    let names: Vec<String> =
        list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap().to_string()).collect();
    for name in ["create_grid", "close_grid", "read_inbox", "wait_for", "update_grid", "update_agent", "snippets", "get_tasks"] {
        assert!(names.iter().any(|n| n == name), "{name}");
    }
    assert!(!names.iter().any(|n| n == "set_role" || n == "set_paused" || n == "deliver"));
    let (text, error) = h.tool(&token, "get_context", json!({})).await;
    assert!(!error, "{text}");
    let context: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        (context["cellId"].clone(), context["role"].clone(), context["inbox"]["openTasks"].clone()),
        (json!(LEAD), json!("coordinator"), json!(0))
    );
    let (text, error) =
        h.tool(&token, "create_task", json!({ "cellId": WORKER, "title": "Review", "prompt": "Review changes" })).await;
    assert!(!error, "{text}");
    assert_eq!(serde_json::from_str::<Value>(&text).unwrap()["note"], catalog::QUEUED_NOTE);
    let task = h.service.state()["automation"]["tasks"][0].clone();
    assert_eq!((task["title"].clone(), task["delivery"].clone()), (json!("Review"), json!("pending")));
    let (text, error) = h
        .tool(
            &token,
            "update_task",
            json!({ "taskId": task["id"], "status": "completed", "result": { "summary": "Reviewed", "tests": ["passed"] } }),
        )
        .await;
    assert!(!error, "{text}");
    assert_eq!(h.service.state()["automation"]["tasks"][0]["result"]["tests"], json!(["passed"]));
    // A worker's read_inbox of an empty inbox.
    let worker = h.server.issue_token(REVIEWER);
    let (text, _) = h.tool(&worker, "read_inbox", json!({ "acknowledge": true })).await;
    assert_eq!(text, r#"{"tasks":[],"messages":[]}"#);
    // The coordinator-only tools refuse a worker; the grid is not created.
    let (text, error) = h.tool(&worker, "create_grid", json!({ "name": "Denied", "cells": [{ "profileId": "codex" }] })).await;
    assert!(error, "{text}");
    assert_eq!(h.tabs().len(), 1);
    let (text, error) = h.tool(&worker, "snippets", json!({})).await;
    assert!(error && text == "This tool requires the coordinator role.", "{text}");
}

#[tokio::test]
async fn initializes_with_a_role_aware_instruction_and_workers_see_none_of_the_coordinator_tools() {
    let h = H::start().await;
    let token = h.server.issue_token(WORKER);
    let init = h.post(&token, init(json!({}))).await.json();
    let instructions = init["result"]["instructions"].as_str().unwrap();
    assert!(
        instructions.starts_with("Unimux: you are cell backend \"Backend\" (worker) in project Project. You are a worker:"),
        "{instructions}"
    );
    let list = h.post(&token, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await.json();
    let names: Vec<&str> = list["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    for name in ["create_grid", "close_grid", "update_grid", "save_preset", "create_task", "get_tasks", "deliver", "snippets"] {
        assert!(!names.contains(&name), "{name}");
    }
    for name in ["get_context", "read_inbox", "wait_for", "update_task", "send_message", "update_agent", "list_agents", "help"] {
        assert!(names.contains(&name), "{name}");
    }
    // A coordinator in "ask" mode reads the old rule; the instructions follow the delegation setting of the state.
    let lead = h.server.issue_token(LEAD);
    h.service.change(|s| s["settings"]["delegation"] = json!({ "mode": "ask", "maxAgents": 4 }));
    let init = h.post(&lead, support::init(json!({}))).await.json();
    assert!(init["result"]["instructions"].as_str().unwrap().contains("only when the user asked to delegate"));
    // A cell whose role is gone gets the disabled text and no tools.
    h.service.change(|s| s["projects"][0]["tabs"][0]["cells"][2]["role"] = Value::Null);
    let plain = h.server.issue_token(REVIEWER);
    let init = h.post(&plain, support::init(json!({}))).await.json();
    assert_eq!(init["result"]["instructions"], "Unimux MCP is disabled for this cell.");
    let list = h.post(&plain, json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" })).await.json();
    assert_eq!(list["result"]["tools"], json!([]));
    let (text, error) = h.tool(&plain, "help", json!({})).await;
    assert!(error && text == "Agent MCP integration is disabled or the cell is no longer available.", "{text}");
}

#[tokio::test]
async fn a_waiting_wait_for_sends_progress_until_its_result() {
    let h = H::start().await;
    let token = h.server.issue_token(REVIEWER);
    let mut body = call(5, "wait_for", json!({ "timeoutSec": 1 }));
    body["params"]["_meta"] = json!({ "progressToken": "p1" });
    let r = h.post(&token, body).await;
    assert_eq!(r.content_type(), Some("text/event-stream"));
    let messages = r.messages();
    let progress: Vec<&Value> = messages.iter().filter(|m| m["method"] == "notifications/progress").collect();
    assert!(progress.len() >= 2, "{}", r.text);
    for p in &progress {
        assert_eq!(
            (p["params"]["progressToken"].clone(), p["params"]["total"].clone(), p["params"]["message"].clone()),
            (json!("p1"), json!(1), json!("waiting"))
        );
    }
    assert_eq!(messages.last().unwrap()["result"]["content"][0]["text"], r#"{"event":"timeout"}"#);
    // Without a progress token: a plain JSON answer and no notifications.
    let r = h.post(&token, call(6, "wait_for", json!({ "timeoutSec": 1 }))).await;
    assert_eq!(r.content_type(), Some("application/json"));
    assert_eq!(r.json()["result"]["content"][0]["text"], r#"{"event":"timeout"}"#);
}

#[tokio::test]
async fn texts_over_32000_characters_and_bad_arguments_are_refused_with_the_zod_text() {
    let h = H::start().await;
    let token = h.server.issue_token(LEAD);
    let (text, error) = h.tool(&token, "send_message", json!({ "toCellId": WORKER, "text": "x".repeat(32001) })).await;
    assert!(error);
    assert_eq!(text, "Invalid arguments - text: Too big: expected string to have <=32000 characters");
    let (text, error) = h.tool(&token, "update_task", json!({ "taskId": "t", "status": "completed", "extra": 1 })).await;
    assert!(error);
    assert_eq!(text, "Invalid arguments - arguments: Unrecognized key: \"extra\"");
    let (text, error) = h.tool(&token, "update_task", json!({ "taskId": "nope", "status": "completed" })).await;
    assert!(error);
    assert_eq!(text, "Task not found: nope. Task IDs come from read_inbox or get_tasks.");
    let r = h.post(&token, call(9, "no_such_tool", json!({}))).await.json();
    assert_eq!(r["error"], json!({ "code": -32602, "message": "MCP error -32602: Unknown tool: no_such_tool" }));
}

/// 1.1.4 passes ctx.signal to wait_for (and to the long wait's slices): a revoke, a closed session or tasks/cancel ends
/// the service's wait at once, not when its timeout runs out.
#[tokio::test]
async fn a_revoke_ends_a_waiting_plain_wait_for_in_the_service_at_once() {
    let h = H::start().await;
    let token = h.server.issue_token(REVIEWER);
    let started = Instant::now();
    let revoke = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        h.server.revoke_cell(REVIEWER);
    };
    let (r, ()) = tokio::join!(h.post(&token, call(1, "wait_for", json!({ "timeoutSec": 60 }))), revoke);
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    assert_eq!(r.json()["result"]["isError"], true, "{}", r.text);
    assert_eq!(h.wait_ended(Duration::from_secs(1)).await, Some(json!({ "event": "cancelled" })));
}

#[tokio::test]
async fn closing_the_session_ends_its_waiting_wait_for_in_the_service_at_once() {
    let h = H::start().await;
    let token = h.server.issue_token(REVIEWER);
    let session = h.session(&token).await;
    let started = Instant::now();
    let close = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let r = Request::new(&h.addr, "DELETE", "/mcp")
            .header("authorization", &format!("Bearer {token}"))
            .header("mcp-session-id", &session)
            .header("mcp-protocol-version", "2025-11-25")
            .send()
            .await;
        assert_eq!(r.status, 200);
    };
    let waiting = h
        .req(&token)
        .header("mcp-session-id", &session)
        .header("mcp-protocol-version", "2025-11-25")
        .body(call(2, "wait_for", json!({ "timeoutSec": 60 })))
        .send();
    let (_, ()) = tokio::join!(waiting, close);
    assert_eq!(h.wait_ended(Duration::from_secs(5)).await, Some(json!({ "event": "cancelled" })));
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
}

#[tokio::test]
async fn tasks_cancel_and_a_revoke_end_a_task_mode_long_wait_in_the_service_at_once() {
    for revoke in [false, true] {
        let h = H::start().await;
        // The worker runs Codex: a 600 s task wait loops over slices of at most 170 s, each with the task's signal.
        let token = h.server.issue_token(WORKER);
        let mut body = call(1, "wait_for", json!({ "timeoutSec": 600 }));
        body["params"]["task"] = json!({ "ttl": 120000 });
        let task = h.post(&token, body).await.json()["result"]["task"]["taskId"].clone();
        assert!(task.is_string(), "{task}");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(h.waits_ended.lock().is_empty());
        let started = Instant::now();
        if revoke {
            h.server.revoke_cell(WORKER);
        } else {
            let cancel = json!({ "jsonrpc": "2.0", "id": 2, "method": "tasks/cancel", "params": { "taskId": task } });
            assert_eq!(h.post(&token, cancel).await.json()["result"]["status"], "cancelled");
        }
        assert_eq!(h.wait_ended(Duration::from_secs(5)).await, Some(json!({ "event": "cancelled" })), "revoke {revoke}");
        assert!(started.elapsed() < Duration::from_secs(5));
        // The long wait stops after the cancelled slice: no further slice starts and ends later.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(h.waits_ended.lock().len(), 1);
    }
}

#[test]
fn the_server_defaults_are_the_tool_layer_constants() {
    let cfg = Config::default();
    assert_eq!(cfg.elicit_timeout, Duration::from_millis(catalog::ELICIT_TIMEOUT_MS));
    assert_eq!(cfg.progress_every, Duration::from_millis(catalog::PROGRESS_EVERY_MS));
}
