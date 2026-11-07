//! A small stand-in for the automation service (feature `fake-automation`: the crate's tests and the check build's test
//! bridge, never a release build). It answers the operations the tool checks drive (get_context, list_agents, read_inbox,
//! send_message, create_task, update_task, get_tasks, create_grid, close_grid, wait_for) with the 1.1.4 result shapes
//! and error texts of automation.ts, over a state it reads from its owner and edits in a copy of its own. Everything else is
//! M3 (the real AutomationService); this fake refuses it with a clear text.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::automation::{Automation, OpError, find_cell, profile, role_in_state};
use crate::catalog::{self, Role};
use crate::js;
use crate::schemas;
use crate::tools::BoxFuture;

/// Where the fake reads the state until it edits it (then it keeps its own copy).
pub type StateSource = Arc<dyn Fn() -> Arc<Value> + Send + Sync>;
/// The server's connection probe (mcp.ts connection: connected / waiting / off).
pub type Probe = Arc<dyn Fn(&str) -> &'static str + Send + Sync>;

struct Inner {
    source: StateSource,
    own: Mutex<Option<Arc<Value>>>,
    changed: Notify,
    shown: Mutex<HashMap<String, Arc<Mutex<HashSet<String>>>>>,
    seen: Mutex<HashMap<String, HashSet<String>>>,
    probe: Mutex<Option<Probe>>,
}

/// The fake automation service.
#[derive(Clone)]
pub struct FakeAutomation(Arc<Inner>);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn uid() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn err<T>(text: impl Into<String>) -> Result<T, OpError> {
    Err(OpError::Message(text.into()))
}

const DISABLED: &str = "Agent MCP integration is disabled or the cell is no longer available.";
const COORDINATOR_ONLY: &str = "This operation requires the coordinator role: ask your coordinator (send_message) instead.";
const TARGET: &str = "Target must be an active agent cell with MCP enabled: see list_agents for cell IDs.";

impl FakeAutomation {
    /// Over a state the owner keeps (the app's StateController in the check build).
    pub fn new(source: StateSource) -> Self {
        Self(Arc::new(Inner {
            source,
            own: Mutex::new(None),
            changed: Notify::new(),
            shown: Mutex::default(),
            seen: Mutex::default(),
            probe: Mutex::new(None),
        }))
    }

    /// Over a fixed starting state (tests).
    pub fn with_state(state: Value) -> Self {
        let state = Arc::new(state);
        Self::new(Arc::new(move || state.clone()))
    }

    /// The server's connection probe for list_agents' `mcp` (off without one).
    pub fn set_probe(&self, probe: Probe) {
        *self.0.probe.lock() = Some(probe);
    }

    /// Edits the state (its own copy from then on) and wakes the waiting wait_for calls.
    pub fn change(&self, edit: impl FnOnce(&mut Value)) {
        {
            let mut own = self.0.own.lock();
            let mut next = own.clone().unwrap_or_else(|| (self.0.source)()).as_ref().clone();
            edit(&mut next);
            *own = Some(Arc::new(next));
        }
        self.0.changed.notify_waiters();
    }

    fn snapshot(&self) -> Arc<Value> {
        self.0.own.lock().clone().unwrap_or_else(|| (self.0.source)())
    }

    fn actor(&self, state: &Value, actor: &str) -> Result<(Value, Value, Value, Role), OpError> {
        let role = role_in_state(state, actor).ok_or_else(|| OpError::message(DISABLED))?;
        let (p, t, c) = find_cell(state, actor).ok_or_else(|| OpError::message(DISABLED))?;
        Ok((p.clone(), t.clone(), c.clone(), role))
    }

    fn coordinator(&self, role: Role) -> Result<(), OpError> {
        if role == Role::Coordinator { Ok(()) } else { err(COORDINATOR_ONLY) }
    }

    fn cwd(project: &Value, cell: &Value) -> Value {
        cell.get("worktree")
            .and_then(|w| w.get("path"))
            .or_else(|| cell.get("dir"))
            .or_else(|| project.get("path"))
            .cloned()
            .unwrap_or(Value::Null)
    }

    fn target(&self, state: &Value, cell: &str, project_id: &Value) -> Result<(), OpError> {
        let Some((p, _, _)) = find_cell(state, cell) else { return err(TARGET) };
        if role_in_state(state, cell).is_none() {
            return err(TARGET);
        }
        if p.get("id") != Some(project_id) {
            return err("Project access denied.");
        }
        Ok(())
    }

    fn tasks(state: &Value) -> Vec<Value> {
        state.pointer("/automation/tasks").and_then(Value::as_array).cloned().unwrap_or_default()
    }

    fn open(t: &Value) -> bool {
        !(js::is_str(t.get("status"), "completed") || js::is_str(t.get("status"), "cancelled"))
    }

    fn push(state: &mut Value, list: &str, item: Value) {
        if !state.get("automation").is_some_and(Value::is_object) {
            state["automation"] = json!({ "paused": false, "tasks": [], "messages": [], "events": [] });
        }
        if !state["automation"].get(list).is_some_and(Value::is_array) {
            state["automation"][list] = json!([]);
        }
        state["automation"][list].as_array_mut().unwrap().push(item);
    }

    fn run(&self, op: &str, a: Value, actor: &str) -> Result<Value, OpError> {
        let state = self.snapshot();
        let (project, tab, cell, role) = self.actor(&state, actor)?;
        let project_id = project.get("id").cloned().unwrap_or(Value::Null);
        match op {
            "get_context" => {
                let profiles: Vec<Value> = state
                    .get("profiles")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|p| {
                        js::Obj::new()
                            .set("id", p.get("id").cloned())
                            .set("name", p.get("name").cloned())
                            .set("cli", p.get("cli").cloned())
                            .value()
                    })
                    .collect();
                Ok(js::Obj::new()
                    .set("cellId", cell.get("id").cloned())
                    .put("role", json!(role.as_str()))
                    .set("projectId", project.get("id").cloned())
                    .set("projectName", project.get("name").cloned())
                    .put("cwd", Self::cwd(&project, &cell))
                    .set("gridId", tab.get("id").cloned())
                    .set("profileId", cell.get("profileId").cloned())
                    .set("model", cell.get("model").cloned())
                    .put("paused", json!(js::truthy(state.pointer("/automation/paused"))))
                    .put("profiles", Value::Array(profiles))
                    .value())
            }
            "list_agents" => {
                if let Some(p) = a.get("projectId")
                    && Some(p) != project.get("id")
                {
                    return err("Project access denied.");
                }
                let probe = self.0.probe.lock().clone();
                let tasks = Self::tasks(&state);
                let mut rows = Vec::new();
                for t in project.get("tabs").and_then(Value::as_array).into_iter().flatten() {
                    for c in t.get("cells").and_then(Value::as_array).into_iter().flatten() {
                        let prof = profile(&state, c.get("profileId"));
                        if js::truthy(c.get("ssh")) || prof.is_some_and(|p| js::is_str(p.get("cli"), "shell")) {
                            continue;
                        }
                        let id = c.get("id").and_then(Value::as_str).unwrap_or_default();
                        let mcp = match (&probe, js::truthy(c.get("role"))) {
                            (Some(probe), true) => probe(id),
                            _ => "off",
                        };
                        let open: Vec<Value> = tasks
                            .iter()
                            .filter(|x| js::is_str(x.get("cellId"), id) && Self::open(x))
                            .map(|x| {
                                js::Obj::new()
                                    .set("id", x.get("id").cloned())
                                    .set("title", x.get("title").cloned())
                                    .set("status", x.get("status").cloned())
                                    .value()
                            })
                            .collect();
                        rows.push(
                            js::Obj::new()
                                .put("cellId", json!(id))
                                .set("name", c.get("name").or_else(|| prof.and_then(|p| p.get("name"))).cloned())
                                .set("gridId", t.get("id").cloned())
                                .set("gridName", t.get("name").cloned())
                                .set("gridColor", t.get("color").cloned())
                                .set("profileId", c.get("profileId").cloned())
                                .set("model", c.get("model").cloned())
                                .set("color", c.get("color").cloned())
                                .put("role", c.get("role").cloned().unwrap_or(Value::Null))
                                .put("status", json!("unknown"))
                                .put("cwd", Self::cwd(&project, c))
                                .put("mcp", json!(mcp))
                                .put("tasks", Value::Array(open))
                                .value(),
                        );
                    }
                }
                Ok(Value::Array(rows))
            }
            "read_inbox" => {
                let limit = a["limit"].as_u64().unwrap_or(50) as usize;
                let offset = a["offset"].as_u64().unwrap_or(0) as usize;
                let open_only = a["openOnly"] == json!(true);
                let own: Vec<Value> = Self::tasks(&state)
                    .into_iter()
                    .filter(|t| js::is_str(t.get("cellId"), actor) && (!open_only || Self::open(t)))
                    .collect();
                let unread: Vec<Value> = state
                    .pointer("/automation/messages")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|m| js::is_str(m.get("toCellId"), actor) && !js::truthy(m.get("readAt")))
                    .cloned()
                    .collect();
                let tasks: Vec<Value> = own.iter().skip(offset).take(limit).cloned().collect();
                let messages: Vec<Value> = unread.iter().skip(offset).take(limit).cloned().collect();
                let max = a.get("ackMaxChars").and_then(Value::as_u64).map(|n| n as usize);
                let acknowledged: Vec<Value> = if a["acknowledge"] == json!(true) {
                    messages
                        .iter()
                        .filter(|m| max.is_none_or(|max| m["text"].as_str().is_some_and(|t| unimux_core::utf16::len(t) <= max)))
                        .filter_map(|m| m.get("id").cloned())
                        .collect()
                } else {
                    Vec::new()
                };
                if !acknowledged.is_empty() {
                    let at = now_ms();
                    let ids = acknowledged.clone();
                    self.change(|s| {
                        for m in s.pointer_mut("/automation/messages").and_then(Value::as_array_mut).into_iter().flatten() {
                            if ids.contains(&m["id"]) {
                                m["readAt"] = json!(at);
                            }
                        }
                    });
                }
                {
                    let mut seen = self.0.seen.lock();
                    let seen = seen.entry(actor.to_string()).or_default();
                    for m in &messages {
                        seen.insert(js::to_string_opt(m.get("id")));
                    }
                }
                Ok(json!({ "tasks": tasks, "messages": messages, "acknowledgedMessageIds": acknowledged,
                    "hasMoreTasks": own.len() > offset + limit, "hasMoreMessages": unread.len() > offset + limit }))
            }
            "send_message" => {
                let to = a["toCellId"].as_str().unwrap_or_default().to_string();
                self.target(&state, &to, &project_id)?;
                let message = js::Obj::spread(Some(&a))
                    .put("id", json!(uid()))
                    .put("projectId", project_id)
                    .put("fromCellId", json!(actor))
                    .put("delivery", json!("pending"))
                    .put("createdAt", json!(now_ms()))
                    .value();
                let m = message.clone();
                self.change(|s| Self::push(s, "messages", m));
                Ok(message)
            }
            "create_task" => {
                let to = a["cellId"].as_str().unwrap_or_default().to_string();
                if to != actor {
                    self.coordinator(role)?;
                }
                self.target(&state, &to, &project_id)?;
                let task = self.new_task(&project_id, &to, Some(actor), &a["title"], &a["prompt"], a.get("dependsOn"));
                let t = task.clone();
                self.change(|s| Self::push(s, "tasks", t));
                Ok(task)
            }
            "update_task" => {
                let id = a["taskId"].clone();
                let Some(task) = Self::tasks(&state).into_iter().find(|t| t.get("id") == Some(&id)) else {
                    return err("Task not found.");
                };
                if !js::is_str(task.get("cellId"), actor) && role != Role::Coordinator {
                    return err("Task not found.");
                }
                if !Self::open(&task) {
                    return err("Closed tasks cannot be reopened.");
                }
                let mut next = task.clone();
                for key in ["status", "blockedReason", "result", "cellId"] {
                    if let Some(v) = a.get(key) {
                        next[key] = v.clone();
                    }
                }
                next["updatedAt"] = json!(now_ms());
                let n = next.clone();
                self.change(|s| {
                    for t in s.pointer_mut("/automation/tasks").and_then(Value::as_array_mut).into_iter().flatten() {
                        if t.get("id") == Some(&id) {
                            *t = n.clone();
                        }
                    }
                });
                Ok(next)
            }
            "get_tasks" => {
                self.coordinator(role)?;
                let limit = a["limit"].as_u64().unwrap_or(50) as usize;
                let offset = a["offset"].as_u64().unwrap_or(0) as usize;
                Ok(Value::Array(
                    Self::tasks(&state)
                        .into_iter()
                        .filter(|t| t.get("projectId") == Some(&project_id))
                        .filter(|t| a.get("cellId").is_none_or(|c| t.get("cellId") == Some(c)))
                        .filter(|t| a.get("status").is_none_or(|s| t.get("status") == Some(s)))
                        .skip(offset)
                        .take(limit)
                        .collect(),
                ))
            }
            "create_grid" => {
                self.coordinator(role)?;
                let grid = uid();
                let mut cells = Vec::new();
                let mut tasks = Vec::new();
                let mut by_cell = Map::new();
                for c in a.get("cells").and_then(Value::as_array).into_iter().flatten() {
                    let id = uid();
                    let cell = js::Obj::new()
                        .put("id", json!(id))
                        .set("name", c.get("name").cloned())
                        .set("profileId", c.get("profileId").cloned())
                        .set("role", c.get("role").cloned())
                        .set("model", c.get("model").cloned())
                        .set("color", c.get("color").cloned())
                        .value();
                    if c.get("role").is_some()
                        && let Some(prompt) = c.get("prompt")
                    {
                        let title = json!(prompt.as_str().unwrap_or_default().chars().take(60).collect::<String>());
                        let task = self.new_task(&project_id, &id, Some(actor), &title, prompt, None);
                        by_cell.insert(id.clone(), task["id"].clone());
                        tasks.push(task);
                    }
                    cells.push(cell);
                }
                let ids: Vec<Value> = cells.iter().map(|c| c["id"].clone()).collect();
                let tab = json!({ "id": grid, "name": a["name"], "cells": cells });
                let pid = project_id.clone();
                self.change(|s| {
                    for p in s.get_mut("projects").and_then(Value::as_array_mut).into_iter().flatten() {
                        if p.get("id") == Some(&pid)
                            && let Some(tabs) = p.get_mut("tabs").and_then(Value::as_array_mut)
                        {
                            tabs.push(tab.clone());
                        }
                    }
                    for t in tasks {
                        Self::push(s, "tasks", t);
                    }
                });
                let mut out = js::Obj::new().put("gridId", json!(grid)).put("cellIds", Value::Array(ids));
                if !by_cell.is_empty() {
                    out = out.put("tasks", Value::Object(by_cell));
                }
                Ok(out.value())
            }
            "close_grid" => {
                self.coordinator(role)?;
                let grid = a["gridId"].clone();
                let Some(target) = project
                    .get("tabs")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .find(|t| t.get("id") == Some(&grid))
                    .cloned()
                else {
                    return err("Grid not found.");
                };
                let ids: Vec<Value> = target
                    .get("cells")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|c| c.get("id").cloned())
                    .collect();
                if ids.iter().any(|id| id == &json!(actor)) {
                    return err("A coordinator cannot close its own grid.");
                }
                let unfinished = Self::tasks(&state)
                    .iter()
                    .filter(|t| t.get("cellId").is_some_and(|c| ids.contains(c)) && Self::open(t))
                    .count();
                if a["cancelTasks"] != json!(true) && unfinished > 0 {
                    return err("Grid has unfinished tasks. Complete them or explicitly set cancelTasks:true.");
                }
                let at = now_ms();
                let cells = ids.clone();
                self.change(|s| {
                    for p in s.get_mut("projects").and_then(Value::as_array_mut).into_iter().flatten() {
                        if let Some(tabs) = p.get_mut("tabs").and_then(Value::as_array_mut) {
                            tabs.retain(|t| t.get("id") != Some(&grid));
                        }
                    }
                    for t in s.pointer_mut("/automation/tasks").and_then(Value::as_array_mut).into_iter().flatten() {
                        if t.get("cellId").is_some_and(|c| cells.contains(c)) && Self::open(t) {
                            t["status"] = json!("cancelled");
                            t["updatedAt"] = json!(at);
                        }
                    }
                });
                Ok(json!({ "archivedGridId": a["gridId"], "stoppedCellIds": ids }))
            }
            other => err(format!("{other} is not part of the fake automation (the automation operations are M3).")),
        }
    }

    fn new_task(
        &self,
        project: &Value,
        cell: &str,
        from: Option<&str>,
        title: &Value,
        prompt: &Value,
        depends: Option<&Value>,
    ) -> Value {
        let at = now_ms();
        js::Obj::new()
            .put("id", json!(uid()))
            .put("projectId", project.clone())
            .put("cellId", json!(cell))
            .set("fromCellId", from.map(|f| json!(f)))
            .put("title", title.clone())
            .put("prompt", prompt.clone())
            .put("status", json!("queued"))
            .set("dependsOn", depends.cloned())
            .put("delivery", json!("pending"))
            .put("createdAt", json!(at))
            .put("updatedAt", json!(at))
            .value()
    }

    /// wait_for: the inbox (an unread message or a startable task not reported before) or the watched tasks, until the
    /// timeout (capped by the caller's CLI) or the cancellation.
    async fn wait(self, a: Value, actor: String, cancel: Option<CancellationToken>) -> Result<Value, OpError> {
        let state = self.snapshot();
        let (_, _, cell, _) = self.actor(&state, &actor)?;
        let cli = profile(&state, cell.get("profileId"))
            .and_then(|p| p.get("cli"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let cap = match cli.as_str() {
            "claude" => catalog::WAIT_MAX_CLAUDE,
            "codex" => catalog::WAIT_MAX_CODEX,
            _ => catalog::WAIT_MAX_SECONDS,
        } as u64;
        let timeout = a.get("timeoutSec").and_then(Value::as_u64).unwrap_or(cap.min(60));
        if timeout > cap {
            return err(format!("timeoutSec is at most {cap} for your CLI; call wait_for again after a timeout."));
        }
        let ids: Option<Vec<Value>> = a.get("taskIds").and_then(Value::as_array).cloned();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(timeout);
        let cancel = cancel.unwrap_or_default();
        loop {
            let notified = self.0.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let state = self.snapshot();
            self.actor(&state, &actor)?;
            if let Some(ids) = &ids {
                let listed: Vec<Value> =
                    ids.iter().filter_map(|id| Self::tasks(&state).into_iter().find(|t| t.get("id") == Some(id))).collect();
                let finished = listed
                    .iter()
                    .filter(|t| !js::is_str(t.get("status"), "queued") && !js::is_str(t.get("status"), "in_progress"))
                    .count();
                let all = a["all"] == json!(true);
                if (all && !listed.is_empty() && finished == listed.len()) || (!all && finished > 0) {
                    let rows: Vec<Value> = listed
                        .iter()
                        .map(|t| {
                            js::Obj::new()
                                .set("id", t.get("id").cloned())
                                .set("status", t.get("status").cloned())
                                .set("summary", t.pointer("/result/summary").cloned())
                                .set("blockedReason", t.get("blockedReason").cloned())
                                .value()
                        })
                        .collect();
                    return Ok(json!({ "event": "tasks", "tasks": rows }));
                }
            } else {
                let mut seen = self.0.seen.lock();
                let seen = seen.entry(actor.clone()).or_default();
                let unread: Vec<String> = state
                    .pointer("/automation/messages")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter(|m| js::is_str(m.get("toCellId"), &actor) && !js::truthy(m.get("readAt")))
                    .map(|m| js::to_string_opt(m.get("id")))
                    .filter(|id| !seen.contains(id))
                    .collect();
                let startable: Vec<String> = Self::tasks(&state)
                    .iter()
                    .filter(|t| js::is_str(t.get("cellId"), &actor) && js::is_str(t.get("status"), "queued"))
                    .map(|t| js::to_string_opt(t.get("id")))
                    .filter(|id| !seen.contains(id))
                    .collect();
                if !unread.is_empty() || !startable.is_empty() {
                    for id in unread.iter().chain(startable.iter()) {
                        seen.insert(id.clone());
                    }
                    return Ok(json!({ "event": "inbox", "unreadMessages": unread.len(), "queuedTasks": startable.len() }));
                }
            }
            tokio::select! {
                _ = &mut notified => {}
                _ = tokio::time::sleep_until(deadline) => return Ok(json!({ "event": "timeout" })),
                _ = cancel.cancelled() => return Ok(json!({ "event": "cancelled" })),
            }
        }
    }
}

impl Automation for FakeAutomation {
    fn state(&self) -> Arc<Value> {
        self.snapshot()
    }
    fn role_of(&self, cell: &str) -> Option<Role> {
        role_in_state(&self.snapshot(), cell)
    }
    fn prompts_shown(&self, cell: &str) -> Arc<Mutex<HashSet<String>>> {
        self.0.shown.lock().entry(cell.to_string()).or_default().clone()
    }
    fn execute(
        &self,
        op: &str,
        args: Value,
        actor: &str,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<'static, Result<Value, OpError>> {
        let parsed = match schemas::operation(op).map(|s| s.parse(&args)) {
            Some(Ok(v)) => v,
            Some(Err(issues)) => return Box::pin(async move { Err(OpError::Invalid(issues)) }),
            None => {
                let op = op.to_string();
                return Box::pin(async move { err(format!("Unknown operation: {op}")) });
            }
        };
        if op == "wait_for" {
            return Box::pin(self.clone().wait(parsed, actor.to_string(), cancel));
        }
        let result = self.run(op, parsed, actor);
        Box::pin(async move { result })
    }
}
