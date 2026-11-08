//! Ports of test/automation.test.ts, test/automation-team.test.ts and test/automation-retention.test.ts (the cases the
//! service owns; the tool layer's are in M2's tests).

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;
use unimux_state::{PassThrough, StateController};

use super::model::{self, list};
use super::*;

#[derive(Default)]
struct Calls {
    worktrees: Vec<String>,
    removed: Vec<Value>,
    started: Vec<Vec<String>>,
    delivered: Vec<(String, String)>,
    stopped: Vec<Vec<String>>,
    restarts: usize,
}

struct FakeDeps {
    calls: Mutex<Calls>,
    /// Errors the next create_worktree calls answer (in order; None = succeed).
    worktree_errors: Mutex<Vec<Option<String>>>,
    deliver_error: Mutex<Option<String>>,
    running: Mutex<bool>,
    restart: Mutex<Option<Result<Restart, String>>>,
    start: Mutex<Option<Result<Restart, String>>>,
    can_stop: bool,
    /// A create_worktree waits for this (the idempotent case).
    gate: Option<Arc<Notify>>,
}

impl FakeDeps {
    fn new() -> Self {
        Self {
            calls: Mutex::default(),
            worktree_errors: Mutex::default(),
            deliver_error: Mutex::default(),
            running: Mutex::new(true),
            restart: Mutex::new(Some(Ok(Restart { done: true, reason: None }))),
            start: Mutex::new(None),
            can_stop: true,
            gate: None,
        }
    }
}

impl AutomationDeps for FakeDeps {
    fn create_worktree(&self, path: &str, name: &str) -> BoxFuture<'static, Result<Value, String>> {
        self.calls.lock().worktrees.push(name.to_string());
        let error = {
            let mut errors = self.worktree_errors.lock();
            if errors.is_empty() { None } else { errors.remove(0) }
        };
        let wt = json!({ "path": format!("{path}-wt-{name}"), "branch": format!("mc/{name}") });
        let gate = self.gate.clone();
        Box::pin(async move {
            if let Some(gate) = gate {
                gate.notified().await;
            }
            match error {
                Some(e) => Err(e),
                None => Ok(wt),
            }
        })
    }
    fn remove_worktree(&self, _path: &str, worktree: &Value) -> BoxFuture<'static, Result<(), String>> {
        self.calls.lock().removed.push(worktree.clone());
        Box::pin(async { Ok(()) })
    }
    fn start_cells(&self, ids: &[String]) {
        self.calls.lock().started.push(ids.to_vec());
    }
    fn stop_cells(&self, ids: Vec<String>) -> Option<BoxFuture<'static, ()>> {
        if !self.can_stop {
            return None;
        }
        self.calls.lock().stopped.push(ids);
        Some(Box::pin(async {}))
    }
    fn is_cell_running(&self, _cell: &str) -> Option<bool> {
        Some(*self.running.lock())
    }
    fn restart_agent(&self, _cell: &str) -> Option<BoxFuture<'static, Result<Restart, String>>> {
        self.calls.lock().restarts += 1;
        let r = self.restart.lock().clone()?;
        Some(Box::pin(async move { r }))
    }
    fn start_agent(&self, _cell: &str) -> Option<BoxFuture<'static, Result<Restart, String>>> {
        let r = self.start.lock().clone()?;
        Some(Box::pin(async move { r }))
    }
    fn deliver(&self, cell: &str, notice: &str) -> BoxFuture<'static, Result<(), String>> {
        self.calls.lock().delivered.push((cell.to_string(), notice.to_string()));
        let e = self.deliver_error.lock().clone();
        Box::pin(async move { e.map_or(Ok(()), Err) })
    }
}

struct Fixture {
    service: Arc<AutomationService>,
    state: Arc<StateController>,
    deps: Arc<FakeDeps>,
    clock: Arc<AtomicI64>,
}

const PROJECT: &str = "p-own";
const COORDINATOR: &str = "c-lead";
const WORKER: &str = "c-worker";
const OUTSIDER: &str = "c-out";
const TEAM: &str = "g-team";

fn initial() -> Value {
    json!({
        "version": 1,
        "automation": { "paused": false, "tasks": [], "messages": [], "events": [] },
        "projects": [
            { "id": PROJECT, "name": "Own project", "path": "D:/own", "activeTabId": TEAM, "archive": [], "tabs": [
                { "id": TEAM, "name": "Team", "color": "#3b82f6", "layout": model::layout_for_count(2), "cells": [
                    { "id": COORDINATOR, "profileId": "codex", "color": "#60a5fa", "role": "coordinator" },
                    { "id": WORKER, "profileId": "claude", "color": "#a78bfa", "role": "worker" }] }] },
            { "id": "p-other", "name": "Other project", "path": "D:/other", "activeTabId": "g-out", "archive": [], "tabs": [
                { "id": "g-out", "name": "Grid 1", "color": "#3b82f6", "layout": model::layout_for_count(1), "cells": [
                    { "id": OUTSIDER, "profileId": "codex", "color": "#60a5fa", "role": "coordinator" }] }] }
        ],
        "activeProjectId": PROJECT,
        "profiles": [
            { "id": "claude", "name": "Claude", "cli": "claude", "args": "" },
            { "id": "codex", "name": "Codex", "cli": "codex", "args": "" },
            { "id": "shell", "name": "PowerShell", "cli": "shell", "args": "" }
        ],
        "presets": [], "snippets": [], "notes": [],
        "settings": { "language": null, "delegation": { "mode": "auto", "maxAgents": 4 } }
    })
}

fn fixture_with(deps: FakeDeps, state: Value) -> Fixture {
    let state = Arc::new(StateController::new(state, Arc::new(PassThrough)));
    let deps = Arc::new(deps);
    let clock = Arc::new(AtomicI64::new(1_800_000_000_000));
    let c = clock.clone();
    let service = AutomationService::new(
        state.clone(),
        deps.clone(),
        Arc::new(move || c.load(Ordering::SeqCst)),
        Arc::new(|f| {
            tokio::spawn(f);
        }),
    );
    Fixture { service, state, deps, clock }
}

fn fixture() -> Fixture {
    fixture_with(FakeDeps::new(), initial())
}

impl Fixture {
    async fn run(&self, op: &str, input: Value, actor: Option<&str>) -> Result<Value, String> {
        self.service.execute_op(op, input, actor, None).await.map_err(|e| e.describe())
    }
    async fn ok(&self, op: &str, input: Value, actor: Option<&str>) -> Value {
        self.run(op, input, actor).await.unwrap_or_else(|e| panic!("{op}: {e}"))
    }
    async fn err(&self, op: &str, input: Value, actor: Option<&str>) -> String {
        self.run(op, input, actor).await.expect_err(op)
    }
    fn get(&self) -> Arc<Value> {
        self.state.get()
    }
    fn tab(&self, grid: &str) -> Value {
        list(&self.get()["projects"][0], "tabs").iter().find(|t| t["id"] == grid).cloned().unwrap_or(Value::Null)
    }
    fn task(&self, id: &str) -> Value {
        model::tasks(&self.get()).iter().find(|t| t["id"] == id).cloned().unwrap_or(Value::Null)
    }
    fn advance(&self, ms: i64) {
        self.clock.fetch_add(ms, Ordering::SeqCst);
    }
}

fn str_of(v: &Value) -> String {
    v.as_str().unwrap_or_default().to_string()
}

#[tokio::test]
async fn keeps_roles_and_mcp_optional_and_revokes_access_when_disabled() {
    let f = fixture();
    f.ok("set_paused", json!({ "paused": true }), None).await;
    let created = f
        .ok(
            "create_grid",
            json!({ "projectId": PROJECT, "name": "Plain", "cells": [
            { "profileId": "claude", "prompt": "Just my original prompt" }, { "profileId": "codex" }] }),
            None,
        )
        .await;
    let grid = f.tab(created["gridId"].as_str().unwrap());
    assert!(list(&grid, "cells").iter().all(|c| c.get("role").is_none()));
    assert_eq!(grid["cells"][0]["startupPrompt"], "Just my original prompt");
    assert_eq!(model::tasks(&f.get()).len(), 0);
    let first = str_of(&created["cellIds"][0]);
    assert!(f.err("get_context", json!({}), Some(&first)).await.contains("disabled"));
    f.ok("set_role", json!({ "cellId": first, "role": "worker" }), None).await;
    assert_eq!(f.ok("get_context", json!({}), Some(&first)).await["role"], "worker");
    f.ok("set_role", json!({ "cellId": first, "role": null }), None).await;
    assert!(f.err("get_context", json!({}), Some(&first)).await.contains("disabled"));
    // The user's own grid keeps the user's selection: no colors are handed out by an agent here.
    assert_eq!(f.get()["projects"][0]["activeTabId"], TEAM);
}

#[tokio::test]
async fn identifies_the_actor_and_scopes_reads_and_writes_to_its_project() {
    let f = fixture();
    let ctx = f.ok("get_context", json!({}), Some(WORKER)).await;
    assert_eq!(
        (ctx["cellId"].clone(), ctx["projectId"].clone(), ctx["role"].clone()),
        (json!(WORKER), json!(PROJECT), json!("worker"))
    );
    assert_eq!(ctx["cwd"], "D:/own");
    assert!(f.err("list_agents", json!({ "projectId": "p-other" }), Some(WORKER)).await.contains("access denied"));
    assert!(
        f.err("send_message", json!({ "toCellId": OUTSIDER, "text": "outside" }), Some(WORKER)).await.contains("access denied")
    );
    assert!(
        f.err("set_role", json!({ "cellId": WORKER, "role": "coordinator" }), Some(WORKER))
            .await
            .contains("controlled by the user")
    );
    assert!(
        f.err("create_grid", json!({ "name": "U", "cells": [{ "profileId": "codex" }] }), Some(WORKER))
            .await
            .contains("coordinator")
    );
    assert!(
        f.err("create_task", json!({ "cellId": COORDINATOR, "title": "O", "prompt": "Do" }), Some(WORKER))
            .await
            .contains("coordinator")
    );
    // A malformed call gets the zod issues.
    assert!(matches!(
        f.service.execute_op("read_inbox", json!({ "limit": 101 }), Some(WORKER), None).await,
        Err(crate::automation::OpError::Invalid(_))
    ));
}

#[tokio::test]
async fn creates_a_team_in_the_background_with_tracked_startup_tasks() {
    let f = fixture();
    let created = f
        .ok(
            "create_grid",
            json!({ "name": "Feature", "rows": [2, 1], "cells": [
            { "profileId": "codex", "role": "worker", "name": "Backend", "prompt": "Implement backend", "worktree": true },
            { "profileId": "claude", "role": "worker", "name": "Frontend", "prompt": "Implement frontend", "worktree": true },
            { "profileId": "codex", "name": "Review", "role": "worker" }] }),
            Some(COORDINATOR),
        )
        .await;
    assert_eq!(f.get()["activeProjectId"], PROJECT);
    assert_eq!(f.get()["projects"][0]["activeTabId"], TEAM);
    let ids: Vec<String> = list(&created, "cellIds").iter().map(str_of).collect();
    assert_eq!(f.deps.calls.lock().started, vec![ids.clone()]);
    assert_eq!(f.deps.calls.lock().worktrees.len(), 2);
    assert!(f.deps.calls.lock().worktrees[0].starts_with("Feature-"));
    let grid = f.tab(created["gridId"].as_str().unwrap());
    assert_eq!(list(&grid, "cells").len(), 3);
    assert_eq!(grid["layout"]["rowCounts"], json!([2, 1]));
    // Agents' grids get the accents in order.
    assert_eq!(grid["cells"][1]["color"], "#a78bfa");
    assert!(grid["cells"][0]["startupPrompt"].as_str().unwrap().contains("update_task"));
    assert!(grid["cells"][0]["worktree"]["branch"].as_str().unwrap().starts_with("mc/Feature-"));
    let tasks = model::tasks(&f.get()).to_vec();
    assert_eq!(tasks.len(), 2);
    assert_eq!((tasks[0]["status"].clone(), tasks[0]["delivery"].clone()), (json!("queued"), json!("startup")));
    assert_eq!(created["tasks"][&ids[0]], tasks[0]["id"]);
    assert_eq!(f.get()["automation"]["events"].as_array().unwrap().last().unwrap()["action"], "grid_created");
}

#[tokio::test]
async fn rolls_back_only_newly_created_worktrees_when_preparation_fails() {
    let deps = FakeDeps::new();
    *deps.worktree_errors.lock() = vec![Some("git failed".into()), None, Some("second failed".into())];
    let f = fixture_with(deps, initial());
    let e = f
        .err("create_grid", json!({ "name": "Broken", "cells": [{ "profileId": "codex", "worktree": true }] }), Some(COORDINATOR))
        .await;
    assert_eq!(e, "git failed");
    assert_eq!(list(&f.get()["projects"][0], "tabs").len(), 1);
    assert!(f.deps.calls.lock().started.is_empty());
    let e = f
        .err(
            "create_grid",
            json!({ "name": "Broken", "cells": [
            { "profileId": "codex", "worktree": true }, { "profileId": "claude", "worktree": true }] }),
            Some(COORDINATOR),
        )
        .await;
    assert_eq!(e, "second failed");
    let removed = f.deps.calls.lock().removed.clone();
    assert_eq!(removed.len(), 1);
    assert!(removed[0]["path"].as_str().unwrap().starts_with("D:/own-wt-Broken-"));
    assert_eq!(list(&f.get()["projects"][0], "tabs").len(), 1);
}

#[tokio::test]
async fn validates_layouts_and_rows_before_any_worktree() {
    let f = fixture();
    let e = f
        .err(
            "create_grid",
            json!({ "name": "Invalid", "cells": [{ "profileId": "codex", "worktree": true }, { "profileId": "claude" }],
            "layout": { "cols": 2, "rows": 1, "areas": [
                { "col": 0, "row": 0, "colSpan": 1, "rowSpan": 1 }, { "col": 0, "row": 0, "colSpan": 1, "rowSpan": 1 }] } }),
            Some(COORDINATOR),
        )
        .await;
    assert!(e.contains("overlap"), "{e}");
    let e = f
        .err(
            "add_agents",
            json!({ "gridId": TEAM, "rows": [1], "cells": [{ "profileId": "codex", "worktree": true }] }),
            Some(COORDINATOR),
        )
        .await;
    assert!(e.contains("Row sizes"), "{e}");
    assert!(
        f.err("add_agents", json!({ "gridId": "g-out", "cells": [{ "profileId": "codex" }] }), Some(COORDINATOR))
            .await
            .contains("access denied")
    );
    assert!(f.deps.calls.lock().worktrees.is_empty());
    let e = f.err("create_grid", json!({ "name": "C", "cells": [
        { "profileId": "codex", "role": "worker", "prompt": "a" }, { "profileId": "codex", "role": "worker", "prompt": "b", "after": [1] }] }), Some(COORDINATOR)).await;
    assert_eq!(e, "Cell 1: after must reference earlier cells (got 1).");
    let e = f.err("create_grid", json!({ "name": "C", "cells": [{ "profileId": "codex" }, { "profileId": "codex", "role": "worker", "prompt": "b", "after": [0] }] }), Some(COORDINATOR)).await;
    assert_eq!(e, "Cell 1: after needs a role and prompt on both cells (1 and 0).");
}

#[tokio::test]
async fn appends_to_an_existing_grid_and_starts_only_the_additions() {
    let f = fixture();
    let before = f.tab(TEAM);
    let result = f
        .ok(
            "add_agents",
            json!({ "gridId": TEAM, "rows": [2, 1], "cells": [
            { "profileId": "codex", "name": "Reviewer", "role": "worker", "model": "gpt-5.4", "prompt": "Review" }] }),
            Some(COORDINATOR),
        )
        .await;
    let grid = f.tab(TEAM);
    assert_eq!(result["gridId"], TEAM);
    assert_eq!(grid["cells"][0], before["cells"][0]);
    assert_eq!(grid["cells"][1], before["cells"][1]);
    assert_eq!((grid["cells"][2]["name"].clone(), grid["cells"][2]["color"].clone()), (json!("Reviewer"), json!("#34d399")));
    assert_eq!(list(&grid["layout"], "areas").len(), 3);
    assert_eq!(result["cellIds"], json!([grid["cells"][2]["id"]]));
    assert_eq!(model::tasks(&f.get())[0]["cellId"], grid["cells"][2]["id"]);
    // The title of a task of an unnamed grid follows the grid's name.
    let r = f
        .ok(
            "add_agents",
            json!({ "gridId": TEAM, "cells": [{ "profileId": "codex", "role": "worker", "prompt": "x" }] }),
            Some(COORDINATOR),
        )
        .await;
    let cell = str_of(&r["cellIds"][0]);
    assert_eq!(f.task(r["tasks"][&cell].as_str().unwrap())["title"], "Team 1");
}

#[tokio::test]
async fn task_lifecycle_results_reasons_and_closed_tasks() {
    let f = fixture();
    *f.deps.deliver_error.lock() = Some("Native delivery unavailable".into());
    let task = f
        .ok("create_task", json!({ "cellId": WORKER, "title": "Fix login", "prompt": "Fix the login flow" }), Some(COORDINATOR))
        .await;
    assert_eq!((task["delivery"].clone(), task["status"].clone()), (json!("pending"), json!("queued")));
    assert_eq!(task["deliveryError"], "Native delivery unavailable");
    assert_eq!(task["fromCellId"], COORDINATOR);
    let id = str_of(&task["id"]);
    assert_eq!(f.ok("get_tasks", json!({}), Some(WORKER)).await.as_array().unwrap().len(), 1);
    f.ok("update_task", json!({ "taskId": id, "status": "in_progress" }), Some(WORKER)).await;
    assert_eq!(f.service.statuses.get(WORKER).as_deref(), Some("working"));
    assert!(
        f.err("update_task", json!({ "taskId": id, "status": "completed" }), Some(WORKER)).await.contains("require a result")
    );
    assert!(f.err("update_task", json!({ "taskId": id, "status": "blocked" }), Some(WORKER)).await.contains("require a reason"));
    f.ok("set_paused", json!({ "paused": true }), None).await;
    assert!(f.err("send_message", json!({ "toCellId": COORDINATOR, "text": "new" }), Some(WORKER)).await.contains("paused"));
    f.ok("update_task", json!({ "taskId": id, "status": "completed", "result": { "summary": "Fixed", "files": ["login.ts"], "tests": ["ok"], "branch": "mc/login" } }), Some(WORKER)).await;
    assert_eq!(f.task(&id)["result"]["files"], json!(["login.ts"]));
    assert!(
        f.err("update_task", json!({ "taskId": id, "status": "in_progress" }), Some(WORKER)).await.contains("already closed")
    );
}

#[tokio::test]
async fn does_not_resend_items_already_accepted() {
    let f = fixture();
    let task = f.ok("create_task", json!({ "cellId": WORKER, "title": "Task", "prompt": "Work" }), Some(COORDINATOR)).await;
    assert_eq!(task["delivery"], "native");
    f.ok("deliver_task", json!({ "taskId": task["id"] }), Some(COORDINATOR)).await;
    let delivered = f.deps.calls.lock().delivered.clone();
    assert_eq!(delivered.len(), 1);
    assert_eq!(delivered[0].1, format!("unimux: new task {} \"Task\" from {COORDINATOR}: read_inbox", str_of(&task["id"])));
}

#[tokio::test]
async fn messages_are_visible_only_to_their_recipient() {
    let f = fixture();
    let message = f.ok("send_message", json!({ "toCellId": WORKER, "text": "The API is ready" }), Some(COORDINATOR)).await;
    assert_eq!(f.ok("get_messages", json!({}), Some(WORKER)).await.as_array().unwrap().len(), 1);
    assert_eq!(f.ok("get_messages", json!({}), Some(COORDINATOR)).await, json!([]));
    assert!(f.err("acknowledge_message", json!({ "messageId": message["id"] }), Some(COORDINATOR)).await.contains("recipient"));
    f.ok("acknowledge_message", json!({ "messageId": message["id"] }), Some(WORKER)).await;
    assert_eq!(f.ok("get_messages", json!({}), Some(WORKER)).await, json!([]));
    assert_eq!(f.ok("get_messages", json!({ "unreadOnly": false }), Some(WORKER)).await.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn read_inbox_pages_and_acknowledges_only_up_to_ack_max_chars() {
    let f = fixture();
    f.ok("create_task", json!({ "cellId": WORKER, "title": "Work", "prompt": "Work" }), Some(COORDINATOR)).await;
    let long = f.ok("send_message", json!({ "toCellId": WORKER, "text": "x".repeat(50) }), Some(COORDINATOR)).await;
    let short = f.ok("send_message", json!({ "toCellId": WORKER, "text": "ok" }), Some(COORDINATOR)).await;
    let page = f.ok("read_inbox", json!({ "limit": 1 }), Some(WORKER)).await;
    assert_eq!((page["hasMoreMessages"].clone(), page["acknowledgedMessageIds"].clone()), (json!(true), json!([])));
    assert_eq!(page["tasks"][0]["ready"], true);
    let inbox = f.ok("read_inbox", json!({ "acknowledge": true, "ackMaxChars": 10 }), Some(WORKER)).await;
    assert_eq!(inbox["acknowledgedMessageIds"], json!([short["id"]]));
    let stored = model::messages(&f.get()).iter().find(|m| m["id"] == long["id"]).cloned().unwrap();
    assert!(stored.get("readAt").is_none());
}

#[tokio::test]
async fn snippets_and_presets_keep_their_scopes() {
    let f = fixture();
    f.state
        .change(|s| {
            let mut s = s.clone();
            model::upsert(&mut s, "snippets", json!({ "id": "global", "name": "Global", "text": "g", "autoSend": true }));
            model::upsert(&mut s, "presets", json!({ "id": "team", "name": "Saved", "layout": model::layout_for_count(2),
                "cells": [{ "profileId": "codex", "worktree": false, "prompt": "Backend", "dir": "web", "muted": true }, { "profileId": "claude", "worktree": false }] }));
            Ok(s)
        }, None, false)
        .unwrap();
    let snippet = f.ok("save_snippet", json!({ "name": "Review", "text": "Review files" }), Some(WORKER)).await;
    assert_eq!(snippet["autoSend"], false);
    assert_eq!(snippet["projectId"], PROJECT);
    assert_eq!(f.ok("get_snippet", json!({ "snippetId": snippet["id"] }), Some(WORKER)).await["text"], "Review files");
    assert!(
        f.err("save_snippet", json!({ "id": "global", "name": "Overwrite", "text": "new" }), Some(WORKER))
            .await
            .contains("another scope")
    );
    let task = f.ok("apply_snippet", json!({ "snippetId": snippet["id"], "cellId": WORKER }), Some(COORDINATOR)).await;
    assert_eq!((task["title"].clone(), task["prompt"].clone()), (json!("Review"), json!("Review files")));
    assert_eq!(list(&f.ok("list_library", json!({}), Some(WORKER)).await, "snippets").len(), 2);
    let created = f.ok("create_grid", json!({ "name": "From preset", "presetId": "team" }), Some(COORDINATOR)).await;
    let grid = f.tab(created["gridId"].as_str().unwrap());
    assert_eq!(list(&created, "cellIds").len(), 2);
    // A presetId keeps the template's relative folder out; the muted flag stays; no role: a plain startup prompt.
    assert!(grid["cells"][0].get("dir").is_none());
    assert_eq!((grid["cells"][0]["muted"].clone(), grid["cells"][0]["startupPrompt"].clone()), (json!(true), json!("Backend")));
    assert!(
        f.err("save_preset", json!({ "name": "A", "cells": [{ "profileId": "codex", "dir": "D:/x" }] }), Some(COORDINATOR))
            .await
            .contains("not available to agents")
    );
}

#[tokio::test]
async fn dependencies_defer_delivery_until_prerequisites_complete() {
    let f = fixture();
    let a = f.ok("create_task", json!({ "cellId": WORKER, "title": "A", "prompt": "p" }), Some(COORDINATOR)).await;
    let b = f
        .ok(
            "create_task",
            json!({ "cellId": WORKER, "title": "B", "prompt": "p", "dependsOn": [a["id"], a["id"]] }),
            Some(COORDINATOR),
        )
        .await;
    assert_eq!(b["dependsOn"], json!([a["id"]]));
    assert_eq!(b["delivery"], "pending");
    assert_eq!(f.deps.calls.lock().delivered.len(), 1);
    assert_eq!(f.ok("get_tasks", json!({ "readyOnly": true, "ids": [b["id"]] }), Some(WORKER)).await, json!([]));
    let e = f.err("update_task", json!({ "taskId": b["id"], "status": "in_progress" }), Some(WORKER)).await;
    assert_eq!(e, format!("Task dependencies have not completed: blockedBy [{}]; wait_for them.", str_of(&a["id"])));
    f.ok("update_task", json!({ "taskId": a["id"], "status": "completed", "result": { "summary": "ok" } }), Some(WORKER)).await;
    let delivered = f.deps.calls.lock().delivered.clone();
    assert_eq!(delivered.len(), 2);
    assert!(delivered[1].1.contains(&format!("new task {} \"B\"", str_of(&b["id"]))));
    assert_eq!(f.task(b["id"].as_str().unwrap())["delivery"], "native");
    assert!(
        f.err(
            "create_task",
            json!({ "cellId": WORKER, "title": "Bad", "prompt": "Bad", "dependsOn": ["missing"] }),
            Some(COORDINATOR)
        )
        .await
        .contains("this project")
    );
}

#[tokio::test]
async fn after_chains_start_with_a_waiting_prompt() {
    let f = fixture();
    let r = f
        .ok(
            "create_grid",
            json!({ "name": "Chain", "cells": [
            { "profileId": "codex", "role": "worker", "name": "Dev", "prompt": "Build it" },
            { "profileId": "claude", "role": "worker", "name": "Review", "prompt": "Review it", "after": [0] }] }),
            Some(COORDINATOR),
        )
        .await;
    let (dev, review) = (str_of(&r["cellIds"][0]), str_of(&r["cellIds"][1]));
    let review_task = f.task(r["tasks"][&review].as_str().unwrap());
    assert_eq!(review_task["delivery"], "pending");
    let grid = f.tab(r["gridId"].as_str().unwrap());
    assert_eq!(grid["cells"][1]["startupPrompt"], json!(model::waiting_prompt(&review_task)));
    assert!(grid["cells"][0]["startupPrompt"].as_str().unwrap().contains("Build it"));
    f.ok(
        "update_task",
        json!({ "taskId": r["tasks"][&dev], "status": "completed", "result": { "summary": "built" } }),
        Some(&dev),
    )
    .await;
    let last = f.deps.calls.lock().delivered.last().cloned().unwrap();
    assert_eq!(last.0, review);
    assert!(last.1.contains(&format!("new task {} \"Review\"", str_of(&review_task["id"]))));
}

#[tokio::test]
async fn close_grid_guards_archives_and_hides_ssh_cells() {
    let f = fixture();
    let created = f
        .ok(
            "create_grid",
            json!({ "name": "Worker", "cells": [
        { "profileId": "claude", "role": "worker", "prompt": "Review", "worktree": true }, { "profileId": "shell" }] }),
            Some(COORDINATOR),
        )
        .await;
    let grid = str_of(&created["gridId"]);
    let ids: Vec<String> = list(&created, "cellIds").iter().map(str_of).collect();
    f.state
        .change(
            |s| {
                let mut s = s.clone();
                model::update_cell(&mut s, &ids[1], &[("ssh", Some(json!({ "hostId": "h" })))]);
                Ok(s)
            },
            None,
            false,
        )
        .unwrap();
    assert!(f.err("close_grid", json!({ "gridId": grid }), Some(WORKER)).await.contains("coordinator"));
    assert!(f.err("close_grid", json!({ "gridId": TEAM }), Some(COORDINATOR)).await.contains("own grid"));
    assert!(f.err("close_grid", json!({ "gridId": grid }), Some(OUTSIDER)).await.contains("access denied"));
    assert!(f.err("close_grid", json!({ "gridId": grid }), Some(COORDINATOR)).await.contains("unfinished"));
    assert!(f.deps.calls.lock().stopped.is_empty());
    f.ok("set_paused", json!({ "paused": true }), None).await;
    assert!(f.err("close_grid", json!({ "gridId": grid, "cancelTasks": true }), Some(COORDINATOR)).await.contains("paused"));
    f.ok("set_paused", json!({ "paused": false }), None).await;
    let result = f.ok("close_grid", json!({ "gridId": grid, "cancelTasks": true }), Some(COORDINATOR)).await;
    assert_eq!(result, json!({ "archivedGridId": grid, "stoppedCellIds": [ids[0]] }));
    assert_eq!(f.deps.calls.lock().stopped, vec![ids.clone()]);
    let project = f.get()["projects"][0].clone();
    assert!(!list(&project, "tabs").iter().any(|t| t["id"] == grid));
    assert!(project["archive"][0]["cells"][0]["worktree"].is_object());
    assert!(f.deps.calls.lock().removed.is_empty());
    assert_eq!(model::tasks(&f.get()).iter().find(|t| t["cellId"] == ids[0]).unwrap()["status"], "cancelled");
    assert_eq!(f.service.statuses.get(&ids[0]).as_deref(), Some("exited"));
}

#[tokio::test]
async fn update_agent_saves_launch_settings_and_restarts_safely() {
    let f = fixture();
    let r = f.ok("update_agent", json!({ "cellId": WORKER, "model": "new" }), Some(COORDINATOR)).await;
    assert_eq!((r["needsRestart"].clone(), r["restarted"].clone()), (json!(true), json!(false)));
    assert_eq!(f.deps.calls.lock().restarts, 0);
    assert_eq!(f.ok("update_agent", json!({ "cellId": WORKER, "name": "Worker" }), Some(WORKER)).await["needsRestart"], true);
    *f.deps.restart.lock() = Some(Ok(Restart { done: false, reason: Some("Session is unconfirmed".into()) }));
    let r = f.ok("update_agent", json!({ "cellId": WORKER, "restart": true }), Some(COORDINATOR)).await;
    assert_eq!((r["needsRestart"].clone(), r["restartReason"].clone()), (json!(true), json!("Session is unconfirmed")));
    *f.deps.restart.lock() = Some(Ok(Restart { done: true, reason: None }));
    let r = f.ok("update_agent", json!({ "cellId": WORKER, "restart": true }), Some(COORDINATOR)).await;
    assert_eq!((r["needsRestart"].clone(), r["restarted"].clone()), (json!(false), json!(true)));
    *f.deps.running.lock() = false;
    let r = f.ok("update_agent", json!({ "cellId": WORKER, "model": null }), Some(COORDINATOR)).await;
    assert_eq!((r["needsRestart"].clone(), r["restarted"].clone()), (json!(false), json!(false)));
    assert!(f.tab(TEAM)["cells"][1].get("model").is_none());
    for patch in [json!({ "model": "gpt-5.4" }), json!({ "profileId": "codex" }), json!({ "restart": true })] {
        let mut input = patch.clone();
        input["cellId"] = json!(WORKER);
        assert!(f.err("update_agent", input, Some(WORKER)).await.contains("coordinator"));
    }
    assert!(
        f.err("update_agent", json!({ "cellId": WORKER, "profileId": "shell" }), Some(COORDINATOR)).await.contains("AI agent")
    );
    assert!(
        f.err("update_agent", json!({ "cellId": OUTSIDER, "model": "new" }), Some(COORDINATOR)).await.contains("access denied")
    );
    // An exited team agent starts again through the runtime, or the answer says it is unavailable.
    *f.deps.running.lock() = true;
    f.service.statuses.set(WORKER, "exited");
    let r = f.ok("update_agent", json!({ "cellId": WORKER, "restart": true }), Some(COORDINATOR)).await;
    assert!(r["restartReason"].as_str().unwrap().contains("unavailable"));
    *f.deps.start.lock() = Some(Ok(Restart { done: true, reason: None }));
    let r = f.ok("update_agent", json!({ "cellId": WORKER, "restart": true }), Some(COORDINATOR)).await;
    assert_eq!(r["restarted"], true);
    assert!(r["restartReason"].as_str().unwrap().contains("started again"));
    assert!(f.deps.calls.lock().delivered.is_empty());
}

#[tokio::test]
async fn orphans_are_cancelled_the_waiting_coordinator_hears_it_and_can_reassign() {
    let f = fixture();
    let extra = f.ok("create_grid", json!({ "projectId": PROJECT, "name": "Extra", "cells": [{ "profileId": "claude", "role": "worker", "name": "Second" }] }), None).await;
    let second = str_of(&extra["cellIds"][0]);
    let open = f.ok("create_task", json!({ "cellId": WORKER, "title": "Open", "prompt": "p" }), Some(COORDINATOR)).await;
    let queued = f.ok("create_task", json!({ "cellId": second, "title": "Move me", "prompt": "p" }), Some(COORDINATOR)).await;
    let moved = f.ok("update_task", json!({ "taskId": queued["id"], "cellId": WORKER }), Some(COORDINATOR)).await;
    assert_eq!((moved["id"].clone(), moved["cellId"].clone()), (queued["id"].clone(), json!(WORKER)));
    assert_eq!(f.deps.calls.lock().delivered.last().unwrap().0, WORKER);
    assert!(
        f.err("update_task", json!({ "taskId": queued["id"], "cellId": WORKER }), Some(WORKER)).await.contains("coordinator")
    );
    let service = f.service.clone();
    let open_id = open["id"].clone();
    let waiting = tokio::spawn(async move {
        service.execute_op("wait_for", json!({ "taskIds": [open_id], "timeoutSec": 30 }), Some(COORDINATOR), None).await
    });
    tokio::task::yield_now().await;
    // The worker leaves its grid (removeCell).
    f.state
        .change(
            |s| {
                let mut s = s.clone();
                let cells = s["projects"][0]["tabs"][0]["cells"].as_array_mut().unwrap();
                cells.retain(|c| c["id"] != WORKER);
                s["projects"][0]["tabs"][0]["layout"] = model::layout_for_count(1);
                Ok(s)
            },
            None,
            false,
        )
        .unwrap();
    let result = waiting.await.unwrap().unwrap();
    assert_eq!(result["event"], "tasks");
    assert_eq!(result["tasks"][0], json!({ "id": open["id"], "status": "cancelled", "reason": "agent closed" }));
    assert_eq!(f.service.cancel_orphans(), 0);
    let again = f.ok("update_task", json!({ "taskId": open["id"], "cellId": second }), Some(COORDINATOR)).await;
    assert_eq!(
        (again["cellId"].clone(), again["title"].clone(), again["status"].clone()),
        (json!(second), json!("Open"), json!("queued"))
    );
    assert_ne!(again["id"], open["id"]);
}

#[tokio::test]
async fn orphans_of_an_older_state_are_cancelled_at_start() {
    let mut s = initial();
    let task = |id: &str, cell: &str, status: &str| {
        json!({ "id": id, "projectId": PROJECT, "cellId": cell, "title": id, "prompt": "p",
        "status": status, "delivery": "pending", "createdAt": 1, "updatedAt": 1 })
    };
    s["automation"]["tasks"] = json!([
        task("removed", "no-such-cell", "in_progress"),
        task("alive", WORKER, "queued"),
        task("done", "no-such-cell", "completed")
    ]);
    let f = fixture_with(FakeDeps::new(), s);
    assert_eq!(
        (f.task("removed")["status"].clone(), f.task("removed")["cancelReason"].clone()),
        (json!("cancelled"), json!("agent closed"))
    );
    assert_eq!(f.task("alive")["status"], "queued");
    assert_eq!(f.task("done")["status"], "completed");
    assert_eq!(f.get()["automation"]["events"][0]["detail"], "removed (agent closed)");
}

#[tokio::test]
async fn wait_for_answers_closed_ids_once_caps_per_cli_and_ends_on_cancel() {
    let f = fixture();
    let task = f.ok("create_task", json!({ "cellId": WORKER, "title": "T", "prompt": "p" }), Some(COORDINATOR)).await;
    f.ok("update_task", json!({ "taskId": task["id"], "status": "cancelled" }), Some(COORDINATOR)).await;
    let r = f.ok("wait_for", json!({ "taskIds": [task["id"]] }), Some(COORDINATOR)).await;
    assert_eq!(r["event"], "alreadyClosed");
    assert!(r["hint"].as_str().unwrap().contains("only open task IDs"));
    assert!(f.err("wait_for", json!({ "timeoutSec": 171 }), Some(COORDINATOR)).await.contains("at most 170"));
    let token = CancellationToken::new();
    let long = f.service.execute_op("wait_for", json!({ "timeoutSec": 600 }), Some(WORKER), Some(token.clone()));
    let handle = tokio::spawn(long);
    tokio::task::yield_now().await;
    token.cancel();
    assert_eq!(handle.await.unwrap().unwrap(), json!({ "event": "cancelled" }));
    // A worker cannot wait on the coordinator's own task.
    let lead =
        f.ok("create_task", json!({ "cellId": COORDINATOR, "title": "Lead only", "prompt": "p" }), Some(COORDINATOR)).await;
    assert_eq!(f.err("wait_for", json!({ "taskIds": [lead["id"]], "timeoutSec": 1 }), Some(WORKER)).await, "Task not found.");
    f.ok("update_task", json!({ "taskId": lead["id"], "status": "blocked", "blockedReason": "private" }), Some(COORDINATOR))
        .await;
    assert_eq!(f.ok("wait_for", json!({ "taskIds": [lead["id"]], "timeoutSec": 1 }), Some(COORDINATOR)).await["event"], "tasks");
}

#[tokio::test]
async fn wait_for_the_inbox_reports_only_new_items() {
    let f = fixture();
    f.ok("send_message", json!({ "toCellId": WORKER, "text": "hello" }), Some(COORDINATOR)).await;
    let r = f.ok("wait_for", json!({ "timeoutSec": 1 }), Some(WORKER)).await;
    assert_eq!(r, json!({ "event": "inbox", "unreadMessages": 1, "queuedTasks": 0 }));
    let service = f.service.clone();
    let waiting =
        tokio::spawn(async move { service.execute_op("wait_for", json!({ "timeoutSec": 30 }), Some(WORKER), None).await });
    tokio::task::yield_now().await;
    f.ok("create_task", json!({ "cellId": WORKER, "title": "T", "prompt": "p" }), Some(COORDINATOR)).await;
    assert_eq!(waiting.await.unwrap().unwrap(), json!({ "event": "inbox", "unreadMessages": 0, "queuedTasks": 1 }));
}

#[tokio::test]
async fn stalled_and_exited_agents_end_a_wait_once_per_episode() {
    let f = fixture();
    f.service.set_probe(Arc::new(|cell| if cell == WORKER { "waiting" } else { "connected" }));
    let task = f.ok("create_task", json!({ "cellId": WORKER, "title": "T", "prompt": "p" }), Some(COORDINATOR)).await;
    f.service.runtime_started(WORKER);
    f.service.statuses.set(WORKER, "starting");
    f.advance(STALL_CONNECT_MS + 1000);
    let r = f.ok("wait_for", json!({ "taskIds": [task["id"]], "timeoutSec": 1 }), Some(COORDINATOR)).await;
    assert_eq!(r["event"], "stalled");
    assert!(r["stalled"][0]["reason"].as_str().unwrap().contains("never connected"));
    assert_eq!(r["stalled"][0]["sinceSec"], 91);
    // Told once: the next wait on the same start times out.
    assert_eq!(
        f.ok("wait_for", json!({ "taskIds": [task["id"]], "timeoutSec": 1 }), Some(COORDINATOR)).await,
        json!({ "event": "timeout" })
    );
    let rows = f.ok("list_agents", json!({}), Some(COORDINATOR)).await;
    let worker = rows.as_array().unwrap().iter().find(|r| r["cellId"] == WORKER).cloned().unwrap();
    assert_eq!(
        (worker["mcp"].clone(), worker["since"].clone(), worker["status"].clone()),
        (json!("waiting"), json!(91), json!("starting"))
    );
    // The agent exits: after the grace the waiter hears it once.
    f.service.statuses.set(WORKER, "exited");
    f.service.note_exit(WORKER, Some(3));
    f.advance(EXIT_GRACE_MS);
    let r = f.ok("wait_for", json!({ "taskIds": [task["id"]], "timeoutSec": 1 }), Some(COORDINATOR)).await;
    assert_eq!((r["event"].clone(), r["exitedCellIds"].clone()), (json!("exited"), json!([WORKER])));
    let rows = f.ok("list_agents", json!({}), Some(COORDINATOR)).await;
    assert_eq!(rows.as_array().unwrap().iter().find(|r| r["cellId"] == WORKER).unwrap()["lastExitCode"], 3);
}

#[tokio::test]
async fn a_retried_team_call_shares_the_running_one() {
    let mut deps = FakeDeps::new();
    let gate = Arc::new(Notify::new());
    deps.gate = Some(gate.clone());
    let f = fixture_with(deps, initial());
    let input = json!({ "name": "Once", "cells": [{ "profileId": "codex", "worktree": true }] });
    let (s1, s2) = (f.service.clone(), f.service.clone());
    let (i1, i2) = (input.clone(), input.clone());
    let first = tokio::spawn(async move { s1.execute_op("create_grid", i1, Some(COORDINATOR), None).await });
    let second = tokio::spawn(async move { s2.execute_op("create_grid", i2, Some(COORDINATOR), None).await });
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    gate.notify_one();
    let (a, b) = (first.await.unwrap().unwrap(), second.await.unwrap().unwrap());
    assert_eq!(a, b);
    assert_eq!(f.deps.calls.lock().worktrees.len(), 1);
    assert_eq!(list(&f.get()["projects"][0], "tabs").len(), 2);
    // The answer arrived: an identical call later is a new one.
    let gate2 = f.deps.gate.clone().unwrap();
    let s3 = f.service.clone();
    let third = tokio::spawn(async move { s3.execute_op("create_grid", input, Some(COORDINATOR), None).await });
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    gate2.notify_one();
    assert_ne!(third.await.unwrap().unwrap()["gridId"], a["gridId"]);
}

#[tokio::test]
async fn a_cancelled_creation_keeps_nothing() {
    let mut deps = FakeDeps::new();
    let gate = Arc::new(Notify::new());
    deps.gate = Some(gate.clone());
    let f = fixture_with(deps, initial());
    let token = CancellationToken::new();
    let s = f.service.clone();
    let t = token.clone();
    let call = tokio::spawn(async move {
        s.execute_op(
            "create_grid",
            json!({ "name": "Gone", "cells": [{ "profileId": "codex", "worktree": true }] }),
            Some(COORDINATOR),
            Some(t),
        )
        .await
    });
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    token.cancel();
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    gate.notify_one();
    let e = call.await.unwrap().unwrap_err().describe();
    assert!(e.starts_with("The request ended"), "{e}");
    assert_eq!(f.deps.calls.lock().removed.len(), 1);
    assert_eq!(list(&f.get()["projects"][0], "tabs").len(), 1);
}

#[tokio::test]
async fn retention_makes_room_for_new_tasks_and_keeps_open_ones() {
    let mut s = initial();
    let mut tasks = Vec::new();
    for i in 0..model::PROJECT_ITEM_LIMIT {
        tasks.push(json!({ "id": format!("t{i}"), "projectId": PROJECT, "cellId": WORKER, "title": "x", "prompt": "p",
            "status": if i < 3 { "completed" } else { "queued" }, "delivery": "native", "createdAt": i, "updatedAt": 1_800_000_000_000i64 + i as i64 }));
    }
    s["automation"]["tasks"] = Value::Array(tasks);
    let f = fixture_with(FakeDeps::new(), s);
    f.ok("create_task", json!({ "cellId": WORKER, "title": "New", "prompt": "p" }), Some(COORDINATOR)).await;
    let tasks = model::tasks(&f.get()).to_vec();
    assert_eq!(tasks.len(), model::PROJECT_ITEM_LIMIT);
    assert!(!tasks.iter().any(|t| t["id"] == "t0"));
    assert!(tasks.iter().any(|t| t["id"] == "t1"));
    // Only open tasks left beyond the room: a new one is refused with the limit text.
    let mut s = initial();
    s["automation"]["tasks"] = Value::Array(
        (0..model::PROJECT_ITEM_LIMIT)
            .map(|i| {
                json!({ "id": format!("o{i}"), "projectId": PROJECT, "cellId": WORKER, "title": "x", "prompt": "p",
                "status": "queued", "delivery": "native", "createdAt": 1, "updatedAt": 1 })
            })
            .collect(),
    );
    let f = fixture_with(FakeDeps::new(), s);
    let e = f.err("create_task", json!({ "cellId": WORKER, "title": "New", "prompt": "p" }), Some(COORDINATOR)).await;
    assert_eq!(e, "Task limit reached (500 open tasks in this project). Complete or cancel some first.");
    // Finished items of the project the user removes go; prerequisites of open tasks stay.
    let f = fixture();
    let a = f.ok("create_task", json!({ "cellId": WORKER, "title": "A", "prompt": "p" }), Some(COORDINATOR)).await;
    f.ok("create_task", json!({ "cellId": WORKER, "title": "B", "prompt": "p", "dependsOn": [a["id"]] }), Some(COORDINATOR))
        .await;
    let c = f.ok("create_task", json!({ "cellId": WORKER, "title": "C", "prompt": "p" }), Some(COORDINATOR)).await;
    for t in [&a, &c] {
        f.ok("update_task", json!({ "taskId": t["id"], "status": "completed", "result": { "summary": "ok" } }), Some(WORKER))
            .await;
    }
    assert_eq!(f.ok("remove_items", json!({ "projectId": PROJECT, "kind": "task" }), None).await, json!({ "removed": 1 }));
    assert!(
        f.err("remove_items", json!({ "projectId": PROJECT, "kind": "task" }), Some(COORDINATOR))
            .await
            .contains("controlled by the user")
    );
}

#[tokio::test]
async fn the_delegation_limit_refuses_agents_beyond_it_but_never_the_user() {
    let mut s = initial();
    s["settings"]["delegation"]["maxAgents"] = json!(1);
    let f = fixture_with(FakeDeps::new(), s);
    let e = f.err("create_grid", json!({ "name": "Big", "cells": [
        { "profileId": "claude", "role": "worker", "prompt": "x" }, { "profileId": "claude", "role": "worker", "prompt": "y" }] }), Some(COORDINATOR)).await;
    assert!(e.starts_with("Team limit: at most 1 agents at once"), "{e}");
    f.ok(
        "create_grid",
        json!({ "projectId": PROJECT, "name": "Mine", "cells": [{ "profileId": "claude" }, { "profileId": "claude" }] }),
        None,
    )
    .await;
}

#[tokio::test]
async fn ssh_cells_and_hosts_never_reach_mcp() {
    let f = fixture();
    f.state
        .change(
            |s| {
                let mut s = s.clone();
                s["sshHosts"] = json!([{ "id": "h1", "label": "secret-host-label", "address": "internal.example" }]);
                model::add_tab(
                    &mut s,
                    PROJECT,
                    None,
                    None,
                    model::layout_for_count(1),
                    &[json!({ "profileId": "claude", "role": "worker", "ssh": { "hostId": "h1" } })],
                );
                model::upsert(
                    &mut s,
                    "presets",
                    json!({ "id": "sp", "name": "ssh", "layout": model::layout_for_count(1),
                "cells": [{ "profileId": "shell", "worktree": false, "sshHostId": "h1" }] }),
                );
                Ok(s)
            },
            None,
            false,
        )
        .unwrap();
    let ssh_cell = str_of(&f.get()["projects"][0]["tabs"][1]["cells"][0]["id"]);
    let agents = f.ok("list_agents", json!({}), Some(COORDINATOR)).await.to_string();
    let library = f.ok("list_library", json!({}), Some(COORDINATOR)).await.to_string();
    assert!(!agents.contains(&ssh_cell));
    for text in [agents, library] {
        assert!(!text.contains("secret-host-label") && !text.contains("internal.example") && !text.contains("h1"));
    }
    assert!(f.run("get_context", json!({}), Some(&ssh_cell)).await.is_err());
}

#[tokio::test]
async fn grid_shutdown_without_a_runtime_says_so() {
    let mut deps = FakeDeps::new();
    deps.can_stop = false;
    let f = fixture_with(deps, initial());
    let created = f
        .ok("create_grid", json!({ "name": "W", "cells": [{ "profileId": "claude", "role": "worker" }] }), Some(COORDINATOR))
        .await;
    assert_eq!(
        f.err("close_grid", json!({ "gridId": created["gridId"] }), Some(COORDINATOR)).await,
        "Runtime grid shutdown is unavailable."
    );
}

// ── R1 group 4: the rest of test/automation.test.ts, automation-team.test.ts and mcp-protocol.test.ts ────────────

/// Runs `op` on its own task while the gated worktree creation waits, does `meanwhile`, then lets the worktree finish.
async fn gated(op: &str, input: Value, meanwhile: impl FnOnce(&Fixture)) -> (Fixture, Result<Value, String>) {
    let mut deps = FakeDeps::new();
    let gate = Arc::new(Notify::new());
    deps.gate = Some(gate.clone());
    let f = fixture_with(deps, initial());
    let s = f.service.clone();
    let op = op.to_string();
    let call = tokio::spawn(async move { s.execute_op(&op, input, Some(COORDINATOR), None).await });
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    meanwhile(&f);
    gate.notify_one();
    let result = call.await.unwrap().map_err(|e| e.describe());
    (f, result)
}

// automation "rechecks pause and project permissions after asynchronous worktree creation", "rolls back worktrees if
// existing grid changes while additions are prepared"
#[tokio::test]
async fn rechecks_pause_and_the_grid_after_the_worktrees_and_rolls_them_back() {
    let (f, r) = gated("create_grid", json!({ "name": "Paused", "cells": [{ "profileId": "codex", "worktree": true }] }), |f| {
        f.state
            .change(
                |s| {
                    let mut s = s.clone();
                    s["automation"]["paused"] = json!(true);
                    Ok(s)
                },
                None,
                false,
            )
            .unwrap();
    })
    .await;
    assert!(r.unwrap_err().contains("paused"));
    assert_eq!(f.deps.calls.lock().removed.len(), 1);
    assert!(f.deps.calls.lock().started.is_empty());
    assert_eq!(list(&f.get()["projects"][0], "tabs").len(), 1);

    let input = json!({ "gridId": TEAM, "cells": [{ "profileId": "codex", "worktree": true }] });
    let (f, r) = gated("add_agents", input, |f| {
        f.state
            .change(
                |s| {
                    let mut s = s.clone();
                    s["projects"][0]["tabs"] = json!([]);
                    Ok(s)
                },
                None,
                false,
            )
            .unwrap();
    })
    .await;
    assert!(r.is_err());
    assert_eq!(f.deps.calls.lock().removed.len(), 1);
    assert!(f.deps.calls.lock().started.is_empty());
}

// automation "applies role changes immediately and blocks workers from reading other task inboxes", mcp-protocol "lets
// workers wait only on their own tasks and denies cross-cell actions" (the get_tasks half)
#[tokio::test]
async fn role_changes_apply_at_once_and_workers_read_only_their_own_tasks() {
    let f = fixture();
    f.ok("create_task", json!({ "cellId": COORDINATOR, "title": "Own", "prompt": "Work" }), Some(COORDINATOR)).await;
    assert_eq!(f.ok("get_tasks", json!({ "cellId": COORDINATOR }), Some(WORKER)).await, json!([]));
    f.state
        .change(
            |s| {
                let mut s = s.clone();
                model::update_cell(&mut s, COORDINATOR, &[("role", Some(json!("worker")))]);
                Ok(s)
            },
            None,
            false,
        )
        .unwrap();
    let e = f.err("create_grid", json!({ "name": "Forbidden", "cells": [{ "profileId": "codex" }] }), Some(COORDINATOR)).await;
    assert!(e.contains("coordinator"), "{e}");
}

// automation "defaults team accents distinctly and honors explicit colors/models", "restricts peer identities and grid
// updates to coordinators, honors pause", "rejects unsafe models and invalid profiles before mutating cells"
#[tokio::test]
async fn colors_models_peer_identities_grid_updates_and_pause() {
    let f = fixture();
    let created = f
        .ok(
            "create_grid",
            json!({ "name": "Team", "color": "#123456", "cells": [
            { "profileId": "codex", "color": "#abcdef", "model": "gpt-5.4" }, { "profileId": "claude" }] }),
            Some(COORDINATOR),
        )
        .await;
    let grid = f.tab(created["gridId"].as_str().unwrap());
    assert_eq!(grid["color"], "#123456");
    assert_eq!((grid["cells"][0]["color"].clone(), grid["cells"][0]["model"].clone()), (json!("#abcdef"), json!("gpt-5.4")));
    assert_eq!(grid["cells"][1]["color"], "#a78bfa");

    let worker_before = f.tab(TEAM)["cells"][1].clone();
    assert!(!f.err("update_agent", json!({ "cellId": WORKER, "model": "x; echo bad" }), Some(COORDINATOR)).await.is_empty());
    assert_eq!(f.tab(TEAM)["cells"][1], worker_before);

    assert!(
        f.err("update_agent", json!({ "cellId": COORDINATOR, "name": "Hijack" }), Some(WORKER)).await.contains("coordinator")
    );
    assert!(f.err("update_grid", json!({ "gridId": TEAM, "name": "Hijack" }), Some(WORKER)).await.contains("coordinator"));
    f.ok("update_agent", json!({ "cellId": WORKER, "name": "Own", "color": "#123456" }), Some(WORKER)).await;
    f.ok("update_grid", json!({ "gridId": TEAM, "name": "Renamed", "color": "#abcdef" }), Some(COORDINATOR)).await;
    let team = f.tab(TEAM);
    assert_eq!((team["name"].clone(), team["color"].clone()), (json!("Renamed"), json!("#abcdef")));
    f.ok("set_paused", json!({ "paused": true }), None).await;
    assert!(f.err("update_agent", json!({ "cellId": WORKER, "model": "new" }), Some(WORKER)).await.contains("paused"));
    assert_eq!(f.deps.calls.lock().restarts, 0);
}

// automation "reports unavailable or failing runtime restart without typing into the agent shell", automation-team "starts
// an exited team agent again and always says whether it restarted" (the refused start)
#[tokio::test]
async fn a_restart_reports_an_unavailable_or_failing_runtime_without_typing() {
    let f = fixture();
    *f.deps.restart.lock() = None;
    let r = f.ok("update_agent", json!({ "cellId": WORKER, "model": "new", "restart": true }), Some(COORDINATOR)).await;
    assert_eq!(
        (r["needsRestart"].clone(), r["restarted"].clone(), r["restartReason"].clone()),
        (json!(true), json!(false), json!("Safe runtime restart is unavailable."))
    );
    *f.deps.restart.lock() = Some(Err("Runtime rejected restart".into()));
    let r = f.ok("update_agent", json!({ "cellId": WORKER, "restart": true }), Some(COORDINATOR)).await;
    assert_eq!(
        (r["needsRestart"].clone(), r["restarted"].clone(), r["restartReason"].clone()),
        (json!(true), json!(false), json!("Runtime rejected restart"))
    );
    f.service.statuses.set(WORKER, "exited");
    *f.deps.running.lock() = false;
    *f.deps.start.lock() = Some(Ok(Restart { done: false, reason: Some("Project folder does not exist; ask the user.".into()) }));
    let r = f.ok("update_agent", json!({ "cellId": WORKER, "restart": true }), Some(COORDINATOR)).await;
    assert_eq!(
        (r["restarted"].clone(), r["restartReason"].clone()),
        (json!(false), json!("Project folder does not exist; ask the user."))
    );
    assert!(f.deps.calls.lock().delivered.is_empty());
}

// automation "defers dependent delivery and claims until prerequisites complete and exposes readiness", "rejects missing or
// foreign prerequisites and does not consider cancelled work completed"
#[tokio::test]
async fn readiness_foreign_prerequisites_and_cancelled_work() {
    let f = fixture();
    let foreign = f.ok("create_task", json!({ "cellId": OUTSIDER, "title": "Other", "prompt": "Other" }), Some(OUTSIDER)).await;
    let e = f
        .err(
            "create_task",
            json!({ "cellId": WORKER, "title": "Bad", "prompt": "Bad", "dependsOn": [foreign["id"]] }),
            Some(COORDINATOR),
        )
        .await;
    assert!(e.contains("this project"), "{e}");
    let pre = f.ok("create_task", json!({ "cellId": COORDINATOR, "title": "API", "prompt": "p" }), Some(COORDINATOR)).await;
    let dep = f
        .ok("create_task", json!({ "cellId": WORKER, "title": "UI", "prompt": "p", "dependsOn": [pre["id"]] }), Some(COORDINATOR))
        .await;
    let rows = f.ok("get_tasks", json!({}), Some(WORKER)).await;
    assert_eq!((rows[0]["blockedBy"].clone(), rows[0]["ready"].clone()), (json!([pre["id"]]), json!(false)));
    f.ok("update_task", json!({ "taskId": pre["id"], "status": "completed", "result": { "summary": "API" } }), Some(COORDINATOR))
        .await;
    let ready = f.ok("get_tasks", json!({ "readyOnly": true }), Some(WORKER)).await;
    assert_eq!((ready[0]["id"].clone(), ready[0]["ready"].clone()), (dep["id"].clone(), json!(true)));
    f.ok("update_task", json!({ "taskId": dep["id"], "status": "in_progress" }), Some(WORKER)).await;

    let first = f.ok("create_task", json!({ "cellId": WORKER, "title": "First", "prompt": "p" }), Some(COORDINATOR)).await;
    let second = f
        .ok(
            "create_task",
            json!({ "cellId": WORKER, "title": "Second", "prompt": "p", "dependsOn": [first["id"]] }),
            Some(COORDINATOR),
        )
        .await;
    f.ok("update_task", json!({ "taskId": first["id"], "status": "cancelled" }), Some(WORKER)).await;
    let e = f.err("update_task", json!({ "taskId": second["id"], "status": "in_progress" }), Some(WORKER)).await;
    assert!(e.contains("dependencies"), "{e}");
}

// automation "batches own tasks/messages and optionally acknowledges only the returned page, including paused"
#[tokio::test]
async fn read_inbox_batches_own_items_and_acknowledges_the_page_while_paused() {
    let f = fixture();
    f.ok("create_task", json!({ "cellId": WORKER, "title": "Work", "prompt": "Work" }), Some(COORDINATOR)).await;
    f.ok("create_task", json!({ "cellId": COORDINATOR, "title": "Private", "prompt": "Private" }), Some(COORDINATOR)).await;
    let first = f.ok("send_message", json!({ "toCellId": WORKER, "text": "First" }), Some(COORDINATOR)).await;
    f.ok("send_message", json!({ "toCellId": WORKER, "text": "Second" }), Some(COORDINATOR)).await;
    f.ok("send_message", json!({ "toCellId": COORDINATOR, "text": "Private" }), Some(WORKER)).await;
    let inbox = f.ok("read_inbox", json!({ "limit": 1 }), Some(WORKER)).await;
    assert_eq!(list(&inbox, "tasks").len(), 1);
    assert_eq!(inbox["tasks"][0]["cellId"], WORKER);
    assert_eq!(list(&inbox, "messages").iter().map(|m| m["id"].clone()).collect::<Vec<_>>(), vec![first["id"].clone()]);
    assert_eq!((inbox["acknowledgedMessageIds"].clone(), inbox["hasMoreMessages"].clone()), (json!([]), json!(true)));
    f.ok("set_paused", json!({ "paused": true }), None).await;
    let acked = f.ok("read_inbox", json!({ "limit": 1, "acknowledge": true }), Some(WORKER)).await;
    assert_eq!(acked["acknowledgedMessageIds"], json!([first["id"]]));
    let left = f.ok("get_messages", json!({}), Some(WORKER)).await;
    assert_eq!(left.as_array().unwrap().iter().map(|m| m["text"].clone()).collect::<Vec<_>>(), vec![json!("Second")]);
    assert_eq!(f.ok("get_messages", json!({}), Some(COORDINATOR)).await[0]["text"], "Private");
}

// automation "keeps folders, muted flags and sizes for the user and refuses folders from agents"
#[tokio::test]
async fn template_folders_muted_flags_and_sizes_stay_for_the_user_only() {
    let f = fixture();
    let mut layout = model::layout_for_count(2);
    layout["colSizes"] = json!([3, 1]);
    let created = f
        .ok(
            "create_grid",
            json!({ "projectId": PROJECT, "name": "From template", "layout": layout, "cells": [
            { "profileId": "claude", "dir": "D:/own/web", "muted": true }, { "profileId": "codex", "dir": "relative" }] }),
            None,
        )
        .await;
    let tab = f.tab(created["gridId"].as_str().unwrap());
    assert_eq!(tab["layout"]["colSizes"], json!([3, 1]));
    assert_eq!((tab["cells"][0]["dir"].clone(), tab["cells"][0]["muted"].clone()), (json!("D:/own/web"), json!(true)));
    assert!(tab["cells"][1].get("dir").is_none());
    let e = f
        .err(
            "create_grid",
            json!({ "name": "Agent", "cells": [{ "profileId": "codex", "dir": "D:/elsewhere" }] }),
            Some(COORDINATOR),
        )
        .await;
    assert!(e.contains("not available to agents"), "{e}");
}

// automation-team "reports an agent that waits for the user longer than the threshold, and its exit code in list_agents",
// "a coordinator updating a dead worker's task leaves "exited"; the worker's own report sets its status"
#[tokio::test]
async fn an_agent_waiting_for_the_user_is_stalled_and_a_coordinator_never_hides_exited() {
    let f = fixture();
    f.service.set_probe(Arc::new(|_| "connected"));
    let task = f.ok("create_task", json!({ "cellId": WORKER, "title": "T", "prompt": "p" }), Some(COORDINATOR)).await;
    f.service.runtime_started(WORKER);
    f.service.statuses.set(WORKER, "needs_attention");
    f.advance(STALL_ATTENTION_MS + 1000);
    let r = f.ok("wait_for", json!({ "taskIds": [task["id"]], "timeoutSec": 1 }), Some(COORDINATOR)).await;
    assert_eq!((r["event"].clone(), r["stalled"][0]["cellId"].clone()), (json!("stalled"), json!(WORKER)));
    assert!(r["stalled"][0]["reason"].as_str().unwrap().contains("waits for the user"));

    f.service.statuses.set(WORKER, "exited");
    f.ok("update_task", json!({ "taskId": task["id"], "status": "blocked", "blockedReason": "worker died" }), Some(COORDINATOR))
        .await;
    assert_eq!(f.service.statuses.get(WORKER).as_deref(), Some("exited"));
    f.service.statuses.set(WORKER, "ready");
    f.ok("update_task", json!({ "taskId": task["id"], "status": "in_progress" }), Some(COORDINATOR)).await;
    assert_eq!(f.service.statuses.get(WORKER).as_deref(), Some("ready"));
}

// automation-team "tells the agent with a short notice, not the task text, and redelivers pending items when it starts"
#[tokio::test]
async fn a_pending_task_reaches_its_agent_as_a_short_notice_when_it_starts() {
    let f = fixture();
    *f.deps.deliver_error.lock() = Some("Agent is not running.".into());
    let task = f
        .ok(
            "create_task",
            json!({ "cellId": WORKER, "title": "Fix login", "prompt": "A very long prompt ".repeat(50) }),
            Some(COORDINATOR),
        )
        .await;
    assert_eq!(task["delivery"], "pending");
    *f.deps.deliver_error.lock() = None;
    f.service.runtime_started(WORKER);
    f.service.statuses.set(WORKER, "starting");
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let last = f.deps.calls.lock().delivered.last().cloned().unwrap();
    assert_eq!(
        last,
        (WORKER.to_string(), format!("unimux: new task {} \"Fix login\" from {COORDINATOR}: read_inbox", str_of(&task["id"])))
    );
    assert_eq!(f.task(task["id"].as_str().unwrap())["delivery"], "native");
}

// automation-team "cancels open tasks of archived or removed cells when the service starts, and keeps the others"
#[tokio::test]
async fn orphans_of_an_archived_grid_are_cancelled_at_start() {
    let mut s = initial();
    s["projects"][0]["archive"] = json!([{ "id": "g-old", "name": "Old", "color": "#3b82f6", "layout": model::layout_for_count(1),
        "cells": [{ "id": "c-gone", "profileId": "claude", "role": "worker" }] }]);
    let task = |id: &str, cell: &str, status: &str| {
        json!({ "id": id, "projectId": PROJECT, "cellId": cell, "title": id, "prompt": "p",
        "status": status, "delivery": "pending", "createdAt": 1, "updatedAt": 1 })
    };
    s["automation"]["tasks"] = json!([task("archived", "c-gone", "queued"), task("alive", WORKER, "queued")]);
    let f = fixture_with(FakeDeps::new(), s);
    assert_eq!(
        (f.task("archived")["status"].clone(), f.task("archived")["cancelReason"].clone()),
        (json!("cancelled"), json!("agent closed"))
    );
    assert_eq!(model::tasks(&f.get()).iter().filter(|t| !model::is_closed(t)).count(), 1);
}

// mcp-protocol "does not hot-loop: wait_for ignores items already shown by read_inbox and reports new ones"
#[tokio::test]
async fn wait_for_ignores_what_read_inbox_showed_and_a_blocked_task_is_news_once_ready() {
    let f = fixture();
    f.ok("send_message", json!({ "toCellId": WORKER, "text": "first" }), Some(COORDINATOR)).await;
    f.ok("create_task", json!({ "cellId": WORKER, "title": "T1", "prompt": "p" }), Some(COORDINATOR)).await;
    assert_eq!(list(&f.ok("read_inbox", json!({}), Some(WORKER)).await, "messages").len(), 1);
    assert_eq!(f.ok("wait_for", json!({ "timeoutSec": 1 }), Some(WORKER)).await, json!({ "event": "timeout" }));
    f.ok("send_message", json!({ "toCellId": WORKER, "text": "second" }), Some(COORDINATOR)).await;
    assert_eq!(
        f.ok("wait_for", json!({ "timeoutSec": 1 }), Some(WORKER)).await,
        json!({ "event": "inbox", "unreadMessages": 1, "queuedTasks": 0 })
    );
    // A wait_for result counts as shown too.
    assert_eq!(f.ok("wait_for", json!({ "timeoutSec": 1 }), Some(WORKER)).await, json!({ "event": "timeout" }));
    let pre = f.ok("create_task", json!({ "cellId": COORDINATOR, "title": "Pre", "prompt": "p" }), Some(COORDINATOR)).await;
    f.ok("create_task", json!({ "cellId": WORKER, "title": "Dep", "prompt": "p", "dependsOn": [pre["id"]] }), Some(COORDINATOR))
        .await;
    f.ok("read_inbox", json!({}), Some(WORKER)).await;
    f.ok("update_task", json!({ "taskId": pre["id"], "status": "completed", "result": { "summary": "ok" } }), Some(COORDINATOR))
        .await;
    assert_eq!(
        f.ok("wait_for", json!({ "timeoutSec": 1 }), Some(WORKER)).await,
        json!({ "event": "inbox", "unreadMessages": 0, "queuedTasks": 1 })
    );
}

// automation-retention "answers a repeated identical call with the first result instead of a second team", "never replays
// a call whose answer was received: add_agents again adds agents, create_grid after close_grid makes a new grid", "a failed
// call is not remembered"
#[tokio::test]
async fn a_call_whose_caller_left_is_answered_again_a_received_or_failed_one_never() {
    let mut deps = FakeDeps::new();
    let gate = Arc::new(Notify::new());
    deps.gate = Some(gate.clone());
    let f = fixture_with(deps, initial());
    let args =
        json!({ "name": "Team B", "cells": [{ "profileId": "codex", "role": "worker", "prompt": "Work", "worktree": true }] });
    let first = CancellationToken::new();
    let (s1, s2, a1, a2, t1) = (f.service.clone(), f.service.clone(), args.clone(), args.clone(), first.clone());
    let running = tokio::spawn(async move { s1.execute_op("create_grid", a1, Some(COORDINATOR), Some(t1)).await });
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    // The client timed out and retried: the retry joins the running call, so leaving the first does not cancel it.
    let retry =
        tokio::spawn(async move { s2.execute_op("create_grid", a2, Some(COORDINATOR), Some(CancellationToken::new())).await });
    for _ in 0..5 {
        tokio::task::yield_now().await;
    }
    first.cancel();
    gate.notify_one();
    let _ = running.await.unwrap();
    let b = retry.await.unwrap().unwrap();
    let named = |name: &str| list(&f.get()["projects"][0], "tabs").iter().filter(|t| t["name"] == name).count();
    assert_eq!(named("Team B"), 1);
    // Later the same call still answers with the first result; another call is a new grid.
    assert_eq!(f.ok("create_grid", args.clone(), Some(COORDINATOR)).await["gridId"], b["gridId"]);
    gate.notify_one();
    let mut other = args.clone();
    other["name"] = json!("Team C");
    assert_ne!(f.ok("create_grid", other, Some(COORDINATOR)).await["gridId"], b["gridId"]);
    assert_eq!(f.deps.calls.lock().worktrees.len(), 2);

    // An answer that was received is never replayed.
    let f = fixture();
    let plain = json!({ "name": "Again", "cells": [{ "profileId": "codex" }] });
    let grid = f.ok("create_grid", plain.clone(), Some(COORDINATOR)).await;
    let more = json!({ "gridId": grid["gridId"], "cells": [{ "profileId": "claude" }] });
    f.ok("add_agents", more.clone(), Some(COORDINATOR)).await;
    f.ok("add_agents", more, Some(COORDINATOR)).await;
    assert_eq!(list(&f.tab(grid["gridId"].as_str().unwrap()), "cells").len(), 3);
    f.ok("close_grid", json!({ "gridId": grid["gridId"] }), Some(COORDINATOR)).await;
    let second = f.ok("create_grid", plain, Some(COORDINATOR)).await;
    assert_ne!(second["gridId"], grid["gridId"]);
    assert_eq!(list(&f.get()["projects"][0], "tabs").iter().filter(|t| t["name"] == "Again").count(), 1);

    // A failed call is not remembered.
    let deps = FakeDeps::new();
    *deps.worktree_errors.lock() = vec![Some("git failed".into())];
    let f = fixture_with(deps, initial());
    let retry_me = json!({ "name": "Retry me", "cells": [{ "profileId": "codex", "worktree": true }] });
    assert_eq!(f.err("create_grid", retry_me.clone(), Some(COORDINATOR)).await, "git failed");
    assert_eq!(list(&f.ok("create_grid", retry_me, Some(COORDINATOR)).await, "cellIds").len(), 1);
}

// wait-for "sends a task prompt once per run of the agent; full:true and a restart send it again" (the tool layer over the
// real service)
#[tokio::test]
async fn read_inbox_sends_a_task_prompt_once_per_run_of_the_agent() {
    use crate::tools::ToolHost as _;
    let f = fixture();
    let tools = crate::host::McpTools::new(f.service.clone());
    let prompt = "Export every report of the quarter as CSV. ".repeat(40);
    let task = f.ok("create_task", json!({ "cellId": WORKER, "title": "Export", "prompt": prompt }), Some(COORDINATOR)).await;
    let read = |args: Value| {
        let t = tools.clone();
        async move {
            match t.call("read_inbox".into(), Some(args), crate::host::plain_ctx(WORKER, false)).await {
                Ok(v) => v,
                Err(_) => panic!("read_inbox failed"),
            }
        }
    };
    let first = read(json!({})).await;
    assert_eq!(
        (first["tasks"][0]["id"].clone(), first["tasks"][0]["prompt"].clone()),
        (task["id"].clone(), json!(prompt.trim()))
    );
    let second = read(json!({})).await;
    assert_eq!(
        second["tasks"][0],
        json!({ "id": task["id"], "title": "Export", "status": "queued", "from": COORDINATOR, "seen": true })
    );
    assert!(second.to_string().len() < first.to_string().len() / 10);
    assert_eq!(read(json!({ "full": true })).await["tasks"][0]["prompt"], json!(prompt.trim()));
    f.service.runtime_started(WORKER);
    assert_eq!(read(json!({})).await["tasks"][0]["prompt"], json!(prompt.trim()));
}

// ── M4: ports of test/wait-for.test.ts ("wait_for in the service") ────────────

/// A wait of `actor` running on its own task.
fn spawn_wait(
    f: &Fixture,
    input: Value,
    actor: &'static str,
    cancel: Option<CancellationToken>,
) -> tokio::task::JoinHandle<Result<Value, String>> {
    let service = f.service.clone();
    tokio::spawn(async move { service.execute_op("wait_for", input, Some(actor), cancel).await.map_err(|e| e.describe()) })
}

/// Lets a spawned wait reach its first await.
async fn settle() {
    tokio::time::sleep(std::time::Duration::from_millis(20)).await;
}

fn edit_state(f: &Fixture, edit: impl FnOnce(&mut Value)) {
    f.state
        .change(
            |s| {
                let mut s = s.clone();
                edit(&mut s);
                Ok(s)
            },
            None,
            false,
        )
        .unwrap();
}

#[tokio::test]
async fn wakes_on_the_change_itself_well_before_any_tick_and_leaves_no_subscription_behind() {
    let f = fixture();
    let waiting = spawn_wait(&f, json!({ "timeoutSec": 30 }), WORKER, None);
    settle().await;
    let sent = std::time::Instant::now();
    f.ok("send_message", json!({ "toCellId": WORKER, "text": "ping" }), Some(COORDINATOR)).await;
    assert_eq!(waiting.await.unwrap().unwrap(), json!({ "event": "inbox", "unreadMessages": 1, "queuedTasks": 0 }));
    assert!(sent.elapsed() < std::time::Duration::from_millis(500), "{:?}", sent.elapsed());
}

#[tokio::test]
async fn times_out_after_timeout_sec_with_one_timer_and_no_polling_however_many_unrelated_changes_happen() {
    let f = fixture();
    let started = std::time::Instant::now();
    let waiting = spawn_wait(&f, json!({ "timeoutSec": 1 }), WORKER, None);
    settle().await;
    for i in 0..100 {
        edit_state(&f, |s| s["settings"]["fontSize"] = json!(12 + (i % 2)));
    }
    assert_eq!(waiting.await.unwrap().unwrap(), json!({ "event": "timeout" }));
    let took = started.elapsed().as_millis();
    assert!((950..1500).contains(&took), "{took} ms");
}

#[tokio::test]
async fn ends_at_once_when_its_signal_aborts_also_when_it_was_aborted_before_it_started() {
    let f = fixture();
    let token = CancellationToken::new();
    let waiting = spawn_wait(&f, json!({ "timeoutSec": 30 }), WORKER, Some(token.clone()));
    settle().await;
    let at = std::time::Instant::now();
    token.cancel();
    assert_eq!(waiting.await.unwrap().unwrap(), json!({ "event": "cancelled" }));
    assert!(at.elapsed() < std::time::Duration::from_millis(500));
    let again = spawn_wait(&f, json!({ "timeoutSec": 30 }), WORKER, Some(token));
    assert_eq!(again.await.unwrap().unwrap(), json!({ "event": "cancelled" }));
}

#[tokio::test]
async fn fails_when_the_waiting_agent_leaves_its_cell_is_removed_instead_of_waiting_out_the_timeout() {
    let f = fixture();
    let waiting = spawn_wait(&f, json!({ "timeoutSec": 30 }), WORKER, None);
    settle().await;
    edit_state(&f, |s| s["projects"][0]["tabs"][0]["cells"].as_array_mut().unwrap().retain(|c| c["id"] != WORKER));
    let ended = tokio::time::timeout(std::time::Duration::from_secs(5), waiting).await.expect("ended at once").unwrap();
    assert!(ended.unwrap_err().contains("no longer available"));
}

#[tokio::test]
async fn reports_an_exited_agent_of_a_watched_open_task_once_and_again_after_it_ran_and_exited_again() {
    let f = fixture();
    let task = f.ok("create_task", json!({ "cellId": WORKER, "title": "T", "prompt": "p" }), Some(COORDINATOR)).await;
    let ids = json!([task["id"]]);
    let waiting = spawn_wait(&f, json!({ "taskIds": ids, "timeoutSec": 30 }), COORDINATOR, None);
    settle().await;
    f.service.statuses.set(WORKER, "exited");
    // The exit is told after its grace (a grid the user closes stops its agents first).
    f.advance(EXIT_GRACE_MS);
    assert_eq!(
        waiting.await.unwrap().unwrap(),
        json!({ "event": "exited", "exitedCellIds": [WORKER], "tasks": [{ "id": task["id"], "status": "queued" }] })
    );
    // Told once: the next wait on the same task waits (no hot loop of instant answers).
    assert_eq!(
        f.ok("wait_for", json!({ "taskIds": ids, "timeoutSec": 1 }), Some(COORDINATOR)).await,
        json!({ "event": "timeout" })
    );
    f.service.runtime_started(WORKER);
    f.service.statuses.set(WORKER, "working");
    let again = spawn_wait(&f, json!({ "taskIds": ids, "timeoutSec": 30 }), COORDINATOR, None);
    settle().await;
    f.service.statuses.set(WORKER, "exited");
    f.advance(EXIT_GRACE_MS);
    let r = again.await.unwrap().unwrap();
    assert_eq!((r["event"].clone(), r["exitedCellIds"].clone()), (json!("exited"), json!([WORKER])));
}

#[tokio::test]
async fn a_finished_task_wins_over_an_exited_agent_and_all_true_waits_for_every_task() {
    let f = fixture();
    let a = f.ok("create_task", json!({ "cellId": WORKER, "title": "A", "prompt": "p" }), Some(COORDINATOR)).await;
    let b = f.ok("create_task", json!({ "cellId": WORKER, "title": "B", "prompt": "p" }), Some(COORDINATOR)).await;
    let all = spawn_wait(&f, json!({ "taskIds": [a["id"], b["id"]], "all": true, "timeoutSec": 30 }), COORDINATOR, None);
    settle().await;
    f.ok("update_task", json!({ "taskId": a["id"], "status": "completed", "result": { "summary": "A done" } }), Some(WORKER))
        .await;
    settle().await;
    assert!(!all.is_finished());
    f.ok("update_task", json!({ "taskId": b["id"], "status": "blocked", "blockedReason": "needs data" }), Some(WORKER)).await;
    let r = all.await.unwrap().unwrap();
    assert_eq!(r["event"], "tasks");
    assert_eq!((r["tasks"][0]["status"].clone(), r["tasks"][1]["status"].clone()), (json!("completed"), json!("blocked")));
}
