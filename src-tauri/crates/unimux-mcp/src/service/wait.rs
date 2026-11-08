//! automation.ts `waitFor`: a bounded wait that replaces polling loops. Without taskIds it waits for an unread message or a
//! startable queued task in the caller's own inbox; with taskIds for any (or, with all, every) listed task to be completed,
//! blocked or cancelled, and it also returns when the agent of a watched open task exited (told once per waiter until that
//! agent starts again) or is stalled (never connected to MCP 90 s after its start, or waits for the user 120 s).
//!
//! Event-driven: the state's revision watch and the statuses' watch wake it, plus one timer for the moment a stall or an
//! exit grace ends; no lock is held across an await. The cancellation (the client went away, the token was revoked, the MCP
//! task was cancelled) ends it at once with `cancelled`.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;
use unimux_state::normalize::js;

use super::model::{self, TaskIndex, id, is_closed, text};
use super::{
    AutomationService, EXIT_GRACE_MS, STALL_ATTENTION_MS, STALL_CONNECT_MS, actor_in, fail, has, project_in, put, role_in,
};
use crate::automation::OpError;

enum Stall {
    Now { reason: &'static str, key: String, since: i64 },
    At(i64),
}

fn row(t: &Value) -> Value {
    let mut o = Map::new();
    put(&mut o, "id", t.get("id").cloned());
    put(&mut o, "status", t.get("status").cloned());
    put(&mut o, "summary", t.get("result").and_then(|r| r.get("summary")).cloned());
    put(&mut o, "blockedReason", t.get("blockedReason").cloned());
    put(&mut o, "reason", t.get("cancelReason").cloned());
    Value::Object(o)
}

fn open(t: &Value) -> bool {
    matches!(text(t, "status"), Some("queued" | "in_progress"))
}

impl AutomationService {
    /// Why an agent of an open task is stalled now (with a key that is new for each episode), or when it would be.
    fn stall(&self, cell: &str, now: i64) -> Option<Stall> {
        let status = self.statuses.get(cell)?;
        if status == "exited" {
            return None;
        }
        let started = self.book.lock().started_at.get(cell).copied();
        if let (Some(started), Some(connection)) = (started, self.connection(cell))
            && connection != "connected"
        {
            if now - started >= STALL_CONNECT_MS {
                return Some(Stall::Now {
                    reason: "never connected to unimux MCP since its start (stuck at a login, trust or startup question?): tell the user",
                    key: format!("connect@{started}"),
                    since: started,
                });
            }
            return Some(Stall::At(started + STALL_CONNECT_MS));
        }
        let since = self.statuses.since(cell);
        if let (true, Some(since)) = (status == "needs_attention", since) {
            if now - since >= STALL_ATTENTION_MS {
                return Some(Stall::Now {
                    reason: "waits for the user (a permission or a question): tell the user",
                    key: format!("attention@{since}"),
                    since,
                });
            }
            return Some(Stall::At(since + STALL_ATTENTION_MS));
        }
        None
    }

    pub(super) async fn wait_for(
        self: &Arc<Self>,
        a: Value,
        actor: Option<&str>,
        cancel: Option<CancellationToken>,
    ) -> Result<Value, OpError> {
        let Some(actor) = actor else { return fail("Waiting requires an authenticated agent.") };
        let state = self.state.get();
        let own = actor_in(&state, actor)?;
        let mut ids: Option<Vec<String>> = None;
        if let Some(list) = a.get("taskIds").and_then(Value::as_array) {
            let mut unique: Vec<String> = Vec::new();
            for v in list {
                let s = js::to_string(Some(v));
                if !unique.contains(&s) {
                    unique.push(s);
                }
            }
            ids = Some(unique);
        }
        let mut closed_at_start: HashSet<String> = HashSet::new();
        for task_id in ids.iter().flatten() {
            let Some(task) = model::tasks(&state).iter().find(|t| id(t) == task_id) else {
                return fail(format!("Task not found: {task_id}. Task IDs come from get_tasks or read_inbox."));
            };
            if is_closed(task) {
                closed_at_start.insert(task_id.clone());
            }
            project_in(&state, text(task, "projectId"), Some(actor))?;
            // Same visibility as get_tasks: workers only see their own tasks, coordinators the project's.
            if text(task, "cellId") != Some(actor) && role_in(&state, actor)? != json!("coordinator") {
                return fail("Task not found.");
            }
        }
        let cli = model::profile_cli(&state, own.cell.get("profileId"));
        let cap = model::wait_max_for(cli.as_deref());
        let timeout = a.get("timeoutSec").and_then(Value::as_u64).unwrap_or(cap.min(60));
        if timeout > cap {
            return fail(format!("timeoutSec is at most {cap} for your CLI; call wait_for again after a timeout."));
        }
        // Already closed ids would make every call return at once (a hot loop): they are answered once, with a hint.
        if let Some(ids) = &ids {
            let listed: Vec<&Value> = ids.iter().filter_map(|i| model::tasks(&state).iter().find(|t| id(t) == i)).collect();
            if listed.iter().all(|t| is_closed(t)) {
                return Ok(json!({ "event": "alreadyClosed", "tasks": listed.iter().map(|t| row(t)).collect::<Vec<_>>(),
                    "hint": "These tasks are closed already; wait_for only open task IDs (get_tasks lists them)." }));
            }
        }
        let cancel = cancel.unwrap_or_default();
        if cancel.is_cancelled() {
            return Ok(json!({ "event": "cancelled" }));
        }
        let own_project = id(&own.project).to_string();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
        let mut state_rx = self.state.watch();
        let mut status_rx = self.statuses.subscribe();
        loop {
            state_rx.borrow_and_update();
            status_rx.borrow_and_update();
            let mut next_check: Option<i64> = None;
            if let Some(result) =
                self.check(actor, &own_project, ids.as_deref(), a["all"] == json!(true), &closed_at_start, &mut next_check)?
            {
                return Ok(result);
            }
            let recheck = next_check.map(|at| {
                let wait = (at - self.now()).max(0) as u64 + 50;
                tokio::time::Instant::now() + Duration::from_millis(wait)
            });
            tokio::select! {
                r = state_rx.changed() => if r.is_err() { std::future::pending::<()>().await },
                r = status_rx.changed() => if r.is_err() { std::future::pending::<()>().await },
                _ = async { match recheck { Some(at) => tokio::time::sleep_until(at).await, None => std::future::pending().await } } => {}
                _ = tokio::time::sleep_until(deadline) => return Ok(json!({ "event": "timeout" })),
                _ = cancel.cancelled() => return Ok(json!({ "event": "cancelled" })),
            }
        }
    }

    pub(super) fn check(
        self: &Arc<Self>,
        actor: &str,
        own_project: &str,
        ids: Option<&[String]>,
        all: bool,
        closed_at_start: &HashSet<String>,
        next_check: &mut Option<i64>,
    ) -> Result<Option<Value>, OpError> {
        let snapshot = self.state.get();
        actor_in(&snapshot, actor)?;
        let tasks = model::tasks(&snapshot);
        let Some(ids) = ids else {
            let index = TaskIndex::new(tasks);
            let mut book = self.book.lock();
            let seen = book.seen.entry(actor.to_string()).or_default();
            let unread: Vec<String> = model::messages(&snapshot)
                .iter()
                .filter(|m| {
                    text(m, "projectId") == Some(own_project)
                        && text(m, "toCellId") == Some(actor)
                        && !has(m, "readAt")
                        && !seen.contains(id(m))
                })
                .map(|m| id(m).to_string())
                .collect();
            let startable: Vec<String> = tasks
                .iter()
                .filter(|t| {
                    text(t, "projectId") == Some(own_project)
                        && text(t, "cellId") == Some(actor)
                        && text(t, "status") == Some("queued")
                        && !seen.contains(id(t))
                        && index.blocked_by(t).is_empty()
                })
                .map(|t| id(t).to_string())
                .collect();
            if unread.is_empty() && startable.is_empty() {
                return Ok(None);
            }
            let (m, q) = (unread.len(), startable.len());
            seen.extend(unread);
            seen.extend(startable);
            return Ok(Some(json!({ "event": "inbox", "unreadMessages": m, "queuedTasks": q })));
        };
        let listed: Vec<&Value> = ids.iter().filter_map(|i| tasks.iter().find(|t| id(t) == i)).collect();
        let rows = || listed.iter().map(|t| row(t)).collect::<Vec<_>>();
        // Tasks that were closed when the wait began do not end it (the caller passed them along with open ones).
        let finished = listed.iter().filter(|t| !open(t) && !closed_at_start.contains(id(t))).count();
        let done = listed.iter().filter(|t| !open(t)).count();
        if if all { !listed.is_empty() && done == listed.len() } else { finished > 0 } {
            return Ok(Some(json!({ "event": "tasks", "tasks": rows() })));
        }
        let mut open_cells: Vec<String> = Vec::new();
        for t in listed.iter().filter(|t| open(t)) {
            let cell = js::to_string(t.get("cellId"));
            if !open_cells.contains(&cell) {
                open_cells.push(cell);
            }
        }
        // An agent that left the grids has its tasks cancelled ("agent closed"): that change ends the wait with "tasks".
        if open_cells.iter().any(|c| model::locate(&snapshot, c).is_none()) && self.cancel_orphans() > 0 {
            return Ok(None);
        }
        let now = self.now();
        let noticed = self.book.lock().exit_noticed.get(actor).cloned().unwrap_or_default();
        // An exit is told after a short grace: a grid the user closes stops its agents first and leaves the tabs a moment
        // later, and then the waiter hears the cancellation instead of an exit.
        let mut exited: Vec<String> = Vec::new();
        for cell in &open_cells {
            if noticed.contains(cell) {
                continue;
            }
            if model::locate(&snapshot, cell).is_none() {
                exited.push(cell.clone());
                continue;
            }
            if self.statuses.get(cell).as_deref() != Some("exited") {
                continue;
            }
            let since = self.statuses.since(cell).unwrap_or(0);
            if now - since >= EXIT_GRACE_MS {
                exited.push(cell.clone());
            } else {
                *next_check = Some(next_check.map_or(since + EXIT_GRACE_MS, |n| n.min(since + EXIT_GRACE_MS)));
            }
        }
        if !exited.is_empty() {
            self.book.lock().exit_noticed.entry(actor.to_string()).or_default().extend(exited.iter().cloned());
            return Ok(Some(json!({ "event": "exited", "exitedCellIds": exited, "tasks": rows() })));
        }
        // Agents that never got going or wait for the user: told once per waiter and episode.
        let mut seen = self.book.lock().stall_noticed.get(actor).cloned().unwrap_or_default();
        let mut stalled = Vec::new();
        for cell in &open_cells {
            match self.stall(cell, now) {
                None => {}
                Some(Stall::At(at)) => *next_check = Some(next_check.map_or(at, |n| n.min(at))),
                Some(Stall::Now { reason, key, since }) => {
                    if !seen.insert(format!("{cell}:{key}")) {
                        continue;
                    }
                    stalled.push(json!({ "cellId": cell, "reason": reason,
                        "sinceSec": js::round((now - since) as f64 / 1000.0) as i64 }));
                }
            }
        }
        if !stalled.is_empty() {
            self.book.lock().stall_noticed.insert(actor.to_string(), seen);
            return Ok(Some(json!({ "event": "stalled", "stalled": stalled, "tasks": rows() })));
        }
        Ok(None)
    }
}
