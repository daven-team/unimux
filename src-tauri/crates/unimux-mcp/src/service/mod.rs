//! M3: the automation service of 1.1.4 (src/main/automation.ts `AutomationService`) over the StateController: the 27
//! operations with the paused rules and the actor's permissions, the task model and its transitions, create_grid / add_agents
//! (20 per grid, 100 per project for agents, layouts, `after` chains, worktrees with rollback), close_grid, update_agent, the
//! idempotent team calls (5 min), cancelOrphans, the retention on every insert, the runtime statuses ([`StatusMap`]) and
//! wait_for (inbox / tasks / alreadyClosed / exited / stalled / timeout / cancelled).
//!
//! What runs programs or touches the cells' processes is the app's ([`AutomationDeps`]): worktrees (G4), starting and
//! stopping cells, the inbox notice delivery (prompt queue, Codex queue), restarts (P4). The tool layer (M2) reaches the
//! service through [`Automation`]; the renderer through `automation:execute` (no actor: the user).

mod grid;
mod idempotent;
pub mod model;
pub mod status;
mod wait;

#[cfg(test)]
mod tests;

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;
use unimux_core::utf16;
use unimux_state::StateController;
use unimux_state::normalize::js::{self, truthy};

use crate::automation::{Automation, OpError};
use crate::catalog::Role;
use crate::schemas;
use crate::tools::BoxFuture;
use model::{TaskIndex, id, is_closed, list, text};
pub use status::StatusMap;

/// Milliseconds since the epoch (`Date.now()`), injectable for tests.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
/// Runs a background task (the app's async runtime; tests use their tokio runtime).
pub type Spawner = Arc<dyn Fn(BoxFuture<'static, ()>) + Send + Sync>;
/// The MCP server's view of a cell's client: "connected", "waiting" or "off" (mcp.ts connection).
pub type Probe = Arc<dyn Fn(&str) -> &'static str + Send + Sync>;

/// An agent of a watched open task that never connected to MCP this long after its start counts as stalled (wait_for).
pub const STALL_CONNECT_MS: i64 = 90_000;
/// An agent of a watched open task that waits for the user (permission, question) this long counts as stalled.
pub const STALL_ATTENTION_MS: i64 = 120_000;
/// How long after an agent's exit wait_for tells it.
pub const EXIT_GRACE_MS: i64 = 1000;
/// How long an identical create_grid / add_agents / close_grid call of the same agent returns the first call's answer.
pub const IDEMPOTENT_MS: i64 = 5 * 60_000;

/// The answer of a restart or start of an agent's CLI (`{restarted|started, reason?}`).
#[derive(Debug, Clone, PartialEq)]
pub struct Restart {
    pub done: bool,
    pub reason: Option<String>,
}

/// What the service needs from the app (automation.ts `AutomationDependencies`). Optional parts answer None while the app
/// has no such runtime (1.1.4's optional members).
pub trait AutomationDeps: Send + Sync + 'static {
    /// `createWorktree(projectPath, name)`: the new worktree as stored in a cell (`{path, branch}`).
    fn create_worktree(&self, project_path: &str, name: &str) -> BoxFuture<'static, Result<Value, String>>;
    /// The rollback of a worktree just created (nothing is in it yet, so the unforced removal goes through).
    fn remove_worktree(&self, project_path: &str, worktree: &Value) -> BoxFuture<'static, Result<(), String>>;
    /// The windows start the new cells (`automation:start-cells`).
    fn start_cells(&self, ids: &[String]);
    /// The CLI a profile needs when it is known not to be installed (cached knowledge only, never blocks).
    fn missing_cli(&self, _profile_id: &str) -> Option<String> {
        None
    }
    /// Stops the cells' processes and waits for them (None: grid shutdown is unavailable).
    fn stop_cells(&self, _ids: Vec<String>) -> Option<BoxFuture<'static, ()>> {
        None
    }
    /// Whether the cell's terminal runs (None: unknown, counts as running).
    fn is_cell_running(&self, _cell: &str) -> Option<bool> {
        None
    }
    /// How full the cell's context window is (`{percent, tokens, window, ...}`), when known.
    fn context_of(&self, _cell: &str) -> Option<Value> {
        None
    }
    /// Restarts a running agent on its confirmed session (None: unavailable). Never types a shell command.
    fn restart_agent(&self, _cell: &str) -> Option<BoxFuture<'static, Result<Restart, String>>> {
        None
    }
    /// Starts an agent whose CLI or terminal ended (None: unavailable).
    fn start_agent(&self, _cell: &str) -> Option<BoxFuture<'static, Result<Restart, String>>> {
        None
    }
    /// Tells a running agent that something waits in its MCP inbox (a short notice).
    fn deliver(&self, cell: &str, notice: &str) -> BoxFuture<'static, Result<(), String>>;
}

const DISABLED: &str = "Agent MCP integration is disabled or the cell is no longer available.";
const TARGET: &str = "Target must be an active agent cell with MCP enabled: see list_agents for cell IDs.";
const COORDINATOR_ONLY: &str = "This operation requires the coordinator role: ask your coordinator (send_message) instead.";
const PAUSED: &str = "Automation is paused by the user.";
const ACCESS_DENIED: &str = "Project access denied.";
const AGENT_NOT_FOUND: &str = "Agent cell not found.";

fn task_limit() -> String {
    format!("Task limit reached ({} open tasks in this project). Complete or cancel some first.", model::PROJECT_ITEM_LIMIT)
}
fn message_limit() -> String {
    format!("Message limit reached ({} unread messages in this project). Read some first.", model::PROJECT_ITEM_LIMIT)
}

const READS: [&str; 8] =
    ["get_context", "read_inbox", "list_agents", "list_library", "get_snippet", "get_tasks", "get_messages", "wait_for"];
const UI_ONLY: [&str; 4] = ["set_paused", "set_role", "mark_pasted", "remove_items"];
const PAUSE_FREE: [&str; 5] = ["set_paused", "set_role", "update_task", "acknowledge_message", "remove_items"];

pub(crate) fn fail<T>(text: impl Into<String>) -> Result<T, OpError> {
    Err(OpError::Message(text.into()))
}

/// A cell as findCell answers it, owned.
#[derive(Clone)]
pub(crate) struct Found {
    pub project: Value,
    pub tab: Value,
    pub cell: Value,
}

impl Found {
    fn project_id(&self) -> &str {
        id(&self.project)
    }
}

// ── the checks, over one state ───────────────────────────────────────────────

/// AutomationService.actor: a cell with a role, no SSH cell, no shell profile.
pub(crate) fn actor_in(state: &Value, actor: &str) -> Result<Found, OpError> {
    let Some((project, tab, cell)) = model::find(state, actor) else { return fail(DISABLED) };
    if !truthy(cell.get("role")) || !model::is_agent_cell(state, &cell) {
        return fail(DISABLED);
    }
    Ok(Found { project, tab, cell })
}

/// AutomationService.role.
pub(crate) fn role_in(state: &Value, actor: &str) -> Result<Value, OpError> {
    Ok(actor_in(state, actor)?.cell.get("role").cloned().unwrap_or(Value::Null))
}

/// AutomationService.coordinator: an agent caller must be a coordinator (the user always may).
pub(crate) fn coordinator_in(state: &Value, actor: Option<&str>) -> Result<(), OpError> {
    match actor {
        Some(a) if !js::strict_eq(Some(&role_in(state, a)?), Some(&json!("coordinator"))) => fail(COORDINATOR_ONLY),
        _ => Ok(()),
    }
}

/// AutomationService.project: the given project (an agent only its own), else the agent's own.
pub(crate) fn project_in(state: &Value, project: Option<&str>, actor: Option<&str>) -> Result<Value, OpError> {
    let own = match actor {
        Some(a) => Some(actor_in(state, a)?.project),
        None => None,
    };
    let wanted = project.map(str::to_string).or_else(|| own.as_ref().and_then(|p| text(p, "id")).map(str::to_string));
    let Some(wanted) = wanted.filter(|w| !w.is_empty()) else { return fail(ACCESS_DENIED) };
    if own.as_ref().is_some_and(|o| text(o, "id") != Some(wanted.as_str())) {
        return fail(ACCESS_DENIED);
    }
    match list(state, "projects").iter().find(|p| text(p, "id") == Some(wanted.as_str())) {
        Some(p) => Ok(p.clone()),
        None => fail("Project not found."),
    }
}

/// AutomationService.target: an agent cell with MCP in the actor's project.
pub(crate) fn target_in(state: &Value, cell: &str, actor: Option<&str>) -> Result<Found, OpError> {
    let Some((project, tab, c)) = model::find(state, cell) else { return fail(TARGET) };
    if !truthy(c.get("role")) || !model::is_agent_cell(state, &c) {
        return fail(TARGET);
    }
    project_in(state, Some(id(&project)), actor)?;
    Ok(Found { project, tab, cell: c })
}

/// AutomationService.grid: the grid and its project, within the actor's project.
pub(crate) fn grid_in(state: &Value, grid: &str, actor: Option<&str>) -> Result<(Value, Value), OpError> {
    let Some(project) = list(state, "projects").iter().find(|p| list(p, "tabs").iter().any(|t| text(t, "id") == Some(grid)))
    else {
        return fail("Grid not found.");
    };
    project_in(state, Some(id(project)), actor)?;
    let tab = list(project, "tabs").iter().find(|t| text(t, "id") == Some(grid)).cloned().unwrap_or(Value::Null);
    Ok((project.clone(), tab))
}

#[derive(Default)]
struct Book {
    pending_restart: HashSet<String>,
    /// When each cell's agent was last started in this run of the app.
    started_at: HashMap<String, i64>,
    exit_codes: HashMap<String, i64>,
    /// Task prompts read_inbox has shown an agent in full during this run of its CLI.
    shown: HashMap<String, Arc<Mutex<HashSet<String>>>>,
    /// Inbox items an agent has already been shown; wait_for reports only new ones.
    seen: HashMap<String, HashSet<String>>,
    delivering: HashSet<String>,
    recent: HashMap<String, idempotent::EntryRef>,
    /// Stalled agents a waiter was told about (cellId:episode).
    stall_noticed: HashMap<String, HashSet<String>>,
    /// Agents that exited while a waiter watched their tasks, per waiter: told once, until that agent starts again.
    exit_noticed: HashMap<String, HashSet<String>>,
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Task,
    Message,
}

/// The automation service of one app run.
pub struct AutomationService {
    me: Weak<AutomationService>,
    pub state: Arc<StateController>,
    pub statuses: StatusMap,
    deps: Arc<dyn AutomationDeps>,
    book: Mutex<Book>,
    probe: RwLock<Option<Probe>>,
    clock: Clock,
    spawn: Spawner,
}

impl AutomationService {
    /// The service over the app's state; orphans of an earlier version are cancelled at once (1.1.4's constructor).
    pub fn new(state: Arc<StateController>, deps: Arc<dyn AutomationDeps>, clock: Clock, spawn: Spawner) -> Arc<Self> {
        let service = Arc::new_cyclic(|me| Self {
            me: me.clone(),
            state,
            statuses: StatusMap::new(clock.clone()),
            deps,
            book: Mutex::default(),
            probe: RwLock::new(None),
            clock,
            spawn,
        });
        service.cancel_orphans();
        service
    }

    /// With the wall clock and tokio's spawn (the caller runs inside a tokio runtime).
    pub fn with_defaults(state: Arc<StateController>, deps: Arc<dyn AutomationDeps>) -> Arc<Self> {
        Self::new(
            state,
            deps,
            Arc::new(unimux_core::time::now_ms),
            Arc::new(|f| {
                tokio::spawn(f);
            }),
        )
    }

    fn arc(&self) -> Arc<Self> {
        self.me.upgrade().expect("the service is alive while it is used")
    }

    pub(crate) fn now(&self) -> i64 {
        (self.clock)()
    }

    /// The MCP server tells whether a cell's client connected.
    pub fn set_probe(&self, probe: Probe) {
        *self.probe.write() = Some(probe);
    }

    fn connection(&self, cell: &str) -> Option<&'static str> {
        self.probe.read().as_ref().map(|p| p(cell))
    }

    // ── the runtime (the app calls these) ────────────────────────────────────

    /// A confirmed runtime spawn: a user-initiated restart clears deferred launch settings, and what could not be told while
    /// the agent did not run is told a second later (its prompt queue waits until it sits idle at its prompt).
    pub fn runtime_started(&self, cell: &str) {
        {
            let mut book = self.book.lock();
            book.pending_restart.remove(cell);
            book.seen.remove(cell);
            book.exit_noticed.remove(cell);
            book.shown.remove(cell);
            book.started_at.insert(cell.to_string(), self.now());
            book.exit_codes.remove(cell);
            // It runs again: a later exit is news to the agents waiting on its tasks.
            for noticed in book.exit_noticed.values_mut() {
                noticed.remove(cell);
            }
        }
        let me = self.arc();
        let cell = cell.to_string();
        (self.spawn)(Box::pin(async move {
            tokio::time::sleep(Duration::from_secs(1)).await;
            me.deliver_pending_to(&cell).await;
        }));
    }

    /// The cell's terminal ended with this exit code (list_agents `lastExitCode`).
    pub fn note_exit(&self, cell: &str, code: Option<i64>) {
        if let Some(code) = code {
            self.book.lock().exit_codes.insert(cell.to_string(), code);
        }
    }

    /// The cell left the state for good.
    pub fn forget_cell(&self, cell: &str) {
        {
            let mut book = self.book.lock();
            book.pending_restart.remove(cell);
            book.seen.remove(cell);
            book.exit_noticed.remove(cell);
            book.shown.remove(cell);
            book.started_at.remove(cell);
            book.exit_codes.remove(cell);
        }
        self.statuses.delete(cell);
    }

    /// Cancels open tasks whose cell is in no grid of its project any more ("agent closed"), so nobody waits for them
    /// forever. Answers how many it cancelled.
    pub fn cancel_orphans(&self) -> usize {
        let state = self.state.get();
        let mut in_tabs = HashSet::new();
        for project in list(&state, "projects") {
            for tab in list(project, "tabs") {
                for cell in list(tab, "cells") {
                    in_tabs.insert(format!("{}/{}", js::to_string(project.get("id")), js::to_string(cell.get("id"))));
                }
            }
        }
        let key = |t: &Value| format!("{}/{}", js::to_string(t.get("projectId")), js::to_string(t.get("cellId")));
        let orphans: Vec<Value> =
            model::tasks(&state).iter().filter(|t| !is_closed(t) && !in_tabs.contains(&key(t))).cloned().collect();
        if orphans.is_empty() {
            return 0;
        }
        let ids: HashSet<String> = orphans.iter().map(|t| id(t).to_string()).collect();
        let now = self.now();
        let _ = self.edit(true, |s| {
            for t in model::items_mut(s, "tasks") {
                if ids.contains(id(t)) && !is_closed(t) && t.is_object() {
                    t["status"] = json!("cancelled");
                    t["cancelReason"] = json!("agent closed");
                    t["updatedAt"] = json!(now);
                }
            }
            for t in &orphans {
                let detail = format!("{} (agent closed)", js::to_string(t.get("title")));
                model::log(s, text(t, "projectId").unwrap_or_default(), "task_cancelled", &detail, text(t, "cellId"), now);
            }
            Ok(())
        });
        orphans.len()
    }

    /// AutomationService.roleOf: the MCP role of a cell, None while MCP is disabled for it.
    pub fn role(&self, cell: &str) -> Option<String> {
        actor_in(&self.state.get(), cell).ok().and_then(|f| f.cell.get("role").and_then(Value::as_str).map(str::to_string))
    }

    /// `state.change(fn, undefined, batch)` over an editable copy.
    fn edit(&self, batch: bool, f: impl FnOnce(&mut Value) -> Result<(), String>) -> Result<(), OpError> {
        self.state
            .change(
                |s| {
                    let mut next = s.clone();
                    f(&mut next)?;
                    Ok(next)
                },
                None,
                batch,
            )
            .map(|_| ())
            .map_err(OpError::Message)
    }

    fn seen_add(&self, cell: &str, ids: impl IntoIterator<Item = String>) {
        self.book.lock().seen.entry(cell.to_string()).or_default().extend(ids);
    }

    // ── execute ───────────────────────────────────────────────────────────────

    /// AutomationService.execute(operation, input, actorId, signal). `actor` None is the user (the renderer).
    pub fn execute_op(
        &self,
        op: &str,
        input: Value,
        actor: Option<&str>,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<'static, Result<Value, OpError>> {
        let me = self.arc();
        let (op, actor) = (op.to_string(), actor.map(str::to_string));
        Box::pin(async move { me.run(op, input, actor, cancel).await })
    }

    async fn run(
        self: Arc<Self>,
        op: String,
        input: Value,
        actor: Option<String>,
        cancel: Option<CancellationToken>,
    ) -> Result<Value, OpError> {
        let Some(schema) = schemas::operation(&op) else { return fail("Unknown operation.") };
        let a = schema.parse(&input).map_err(OpError::Invalid)?;
        let actor = actor.as_deref();
        let state = self.state.get();
        if let Some(act) = actor {
            actor_in(&state, act)?;
            if UI_ONLY.contains(&op.as_str()) {
                return fail("This operation is controlled by the user.");
            }
        }
        if model::paused(&state)
            && !READS.contains(&op.as_str())
            && !PAUSE_FREE.contains(&op.as_str())
            && !(op == "create_grid" && actor.is_none())
        {
            return fail(PAUSED);
        }
        let str_arg = |k: &str| a.get(k).and_then(Value::as_str).map(str::to_string);
        let num_arg = |k: &str, d: usize| a.get(k).and_then(Value::as_u64).map_or(d, |n| n as usize);
        let now = self.now();
        let batch = actor.is_some();
        match op.as_str() {
            "get_context" => {
                let Some(act) = actor else { return Ok(json!({ "paused": model::paused(&state) })) };
                let f = actor_in(&state, act)?;
                let profiles: Vec<Value> = list(&state, "profiles")
                    .iter()
                    .map(|p| {
                        let mut o = Map::new();
                        for k in ["id", "name", "cli"] {
                            if let Some(v) = p.get(k) {
                                o.insert(k.into(), v.clone());
                            }
                        }
                        Value::Object(o)
                    })
                    .collect();
                let mut o = Map::new();
                o.insert("cellId".into(), f.cell["id"].clone());
                o.insert("role".into(), role_in(&state, act)?);
                o.insert("projectId".into(), f.project["id"].clone());
                put(&mut o, "projectName", f.project.get("name").cloned());
                put(&mut o, "cwd", model::cell_cwd(&f.project, &f.cell));
                put(&mut o, "gridId", f.tab.get("id").cloned());
                put(&mut o, "profileId", f.cell.get("profileId").cloned());
                put(&mut o, "model", f.cell.get("model").cloned());
                o.insert("paused".into(), json!(model::paused(&state)));
                o.insert("profiles".into(), Value::Array(profiles));
                Ok(Value::Object(o))
            }
            "read_inbox" => {
                let Some(act) = actor else { return fail("Inbox requires an authenticated agent.") };
                let project = actor_in(&state, act)?.project;
                let pid = id(&project);
                let (offset, limit) = (num_arg("offset", 0), num_arg("limit", 50));
                let open_only = a["openOnly"] == json!(true);
                let all = model::tasks(&state);
                let index = TaskIndex::new(all);
                let own: Vec<&Value> = all
                    .iter()
                    .filter(|t| {
                        text(t, "projectId") == Some(pid) && text(t, "cellId") == Some(act) && (!open_only || !is_closed(t))
                    })
                    .collect();
                let tasks: Vec<Value> = own.iter().skip(offset).take(limit).map(|t| index.listed(t)).collect();
                let unread: Vec<&Value> = model::messages(&state)
                    .iter()
                    .filter(|m| text(m, "projectId") == Some(pid) && text(m, "toCellId") == Some(act) && !has(m, "readAt"))
                    .collect();
                let page: Vec<&Value> = unread.iter().skip(offset).take(limit).copied().collect();
                // A message longer than ackMaxChars was only shown clipped by the caller: it stays unread until fetched in full.
                let max = a.get("ackMaxChars").and_then(Value::as_u64).map(|n| n as usize);
                let acked: Vec<String> = if a["acknowledge"] == json!(true) {
                    page.iter()
                        .filter(|m| max.is_none_or(|max| utf16::len(text(m, "text").unwrap_or_default()) <= max))
                        .map(|m| id(m).to_string())
                        .collect()
                } else {
                    Vec::new()
                };
                if !acked.is_empty() {
                    let ids: HashSet<&str> = acked.iter().map(String::as_str).collect();
                    self.edit(batch, |s| {
                        for m in model::items_mut(s, "messages") {
                            if ids.contains(id(m)) && text(m, "toCellId") == Some(act) && m.is_object() {
                                m["readAt"] = json!(now);
                            }
                        }
                        Ok(())
                    })?;
                }
                self.seen_add(
                    act,
                    page.iter()
                        .map(|m| id(m).to_string())
                        .chain(tasks.iter().filter(|t| t["ready"] == json!(true)).map(|t| id(t).to_string())),
                );
                let messages: Vec<Value> = page
                    .iter()
                    .map(|m| {
                        let mut m = (*m).clone();
                        if acked.iter().any(|x| x == id(&m)) && m.is_object() {
                            m["readAt"] = json!(now);
                        }
                        m
                    })
                    .collect();
                Ok(json!({ "tasks": tasks, "messages": messages, "acknowledgedMessageIds": acked,
                    "hasMoreTasks": own.len() > offset + limit, "hasMoreMessages": unread.len() > offset + limit }))
            }
            "list_agents" => {
                let project = project_in(&state, str_arg("projectId").as_deref(), actor)?;
                Ok(Value::Array(self.list_agents(&state, &project, now)))
            }
            "list_library" => {
                let project = project_in(&state, str_arg("projectId").as_deref(), actor)?;
                let pid = id(&project);
                let scoped = |x: &Value| !truthy(x.get("projectId")) || text(x, "projectId") == Some(pid);
                let snippets: Vec<Value> = list(&state, "snippets")
                    .iter()
                    .filter(|s| scoped(s))
                    .map(|s| {
                        let mut o = Map::new();
                        for k in ["id", "name", "autoSend", "projectId"] {
                            put(&mut o, k, s.get(k).cloned());
                        }
                        Value::Object(o)
                    })
                    .collect();
                // SSH hosts never reach MCP (R4, spec 11): preset cells lose their host reference.
                let presets: Vec<Value> = list(&state, "presets")
                    .iter()
                    .filter(|p| scoped(p))
                    .map(|p| {
                        let mut p = p.clone();
                        if let Some(cells) = p.get_mut("cells").and_then(Value::as_array_mut) {
                            for c in cells.iter_mut().filter_map(Value::as_object_mut) {
                                c.shift_remove("sshHostId");
                            }
                        }
                        p
                    })
                    .collect();
                Ok(json!({ "snippets": snippets, "presets": presets }))
            }
            "get_snippet" => {
                let wanted = str_arg("snippetId").unwrap_or_default();
                let Some(snippet) = list(&state, "snippets").iter().find(|s| id(s) == wanted) else {
                    return fail("Snippet not found.");
                };
                if actor.is_some() && truthy(snippet.get("projectId")) {
                    project_in(&state, text(snippet, "projectId"), actor)?;
                }
                Ok(snippet.clone())
            }
            "apply_snippet" => {
                let (snippet_id, cell) = (str_arg("snippetId").unwrap_or_default(), str_arg("cellId").unwrap_or_default());
                let found = target_in(&state, &cell, actor)?;
                let snippet = list(&state, "snippets").iter().find(|s| id(s) == snippet_id);
                let Some(snippet) =
                    snippet.filter(|s| !truthy(s.get("projectId")) || text(s, "projectId") == Some(found.project_id()))
                else {
                    return fail("Snippet not found in this project.");
                };
                let input = json!({ "cellId": cell, "title": snippet.get("name"), "prompt": snippet.get("text") });
                self.execute_op("create_task", input, actor, None).await
            }
            "close_grid" => {
                // Not cancelled by a disconnect: stopped agents are archived either way; a retry gets the first answer.
                let me = self.clone();
                let (args, act) = (a.clone(), actor.map(str::to_string));
                self.idempotent(&op, &a, actor, None, move |_| Box::pin(async move { me.close_grid(args, act).await })).await
            }
            "add_agents" | "create_grid" => {
                let me = self.clone();
                let mut args = a.clone();
                if op == "add_agents" {
                    args["name"] = json!("");
                }
                let act = actor.map(str::to_string);
                self.idempotent(&op, &a, actor, cancel, move |token| {
                    Box::pin(async move { me.create_grid(args, act, Some(token)).await })
                })
                .await
            }
            "update_grid" => {
                coordinator_in(&state, actor)?;
                let (project, tab) = grid_in(&state, &str_arg("gridId").unwrap_or_default(), actor)?;
                let mut patch: Vec<(&str, Option<Value>)> = Vec::new();
                if let Some(name) = a.get("name") {
                    patch.push(("name", Some(name.clone())));
                }
                if let Some(color) = a.get("color") {
                    patch.push(("color", (!color.is_null()).then(|| color.clone())));
                }
                let (pid, tid) = (id(&project).to_string(), id(&tab).to_string());
                let detail = js::to_string(a.get("name").or(tab.get("name")));
                self.edit(false, |s| {
                    if let Some(t) = s
                        .get_mut("projects")
                        .and_then(Value::as_array_mut)
                        .and_then(|ps| ps.iter_mut().find(|p| id(p) == pid))
                        .and_then(|p| p.get_mut("tabs"))
                        .and_then(Value::as_array_mut)
                        .and_then(|ts| ts.iter_mut().find(|t| id(t) == tid))
                        .and_then(Value::as_object_mut)
                    {
                        for (k, v) in &patch {
                            match v {
                                Some(v) => {
                                    t.insert((*k).to_string(), v.clone());
                                }
                                None => {
                                    t.shift_remove(*k);
                                }
                            }
                        }
                    }
                    model::log(s, &pid, "grid_updated", &detail, actor, now);
                    Ok(())
                })?;
                let mut out = Map::new();
                out.insert("gridId".into(), json!(tid));
                for (k, v) in patch {
                    put(&mut out, k, v);
                }
                Ok(Value::Object(out))
            }
            "update_agent" => self.update_agent(a, actor).await,
            "save_snippet" => {
                let project = project_in(&state, str_arg("projectId").as_deref(), actor)?;
                let pid = id(&project).to_string();
                let existing =
                    a.get("id").and_then(|wanted| list(&state, "snippets").iter().find(|s| s.get("id") == Some(wanted)));
                if existing.is_some_and(|e| text(e, "projectId") != Some(pid.as_str())) {
                    return fail("Snippet belongs to another scope.");
                }
                let mut snippet = a.as_object().cloned().unwrap_or_default();
                let new_id = str_arg("id").unwrap_or_else(model::uid);
                snippet.insert("id".into(), json!(new_id));
                snippet.insert("projectId".into(), json!(pid));
                let snippet = Value::Object(snippet);
                let name = js::to_string(snippet.get("name"));
                let item = snippet.clone();
                self.edit(false, |s| {
                    model::upsert(s, "snippets", item);
                    model::log(s, &pid, "snippet", &name, actor, now);
                    Ok(())
                })?;
                Ok(snippet)
            }
            "save_preset" => {
                coordinator_in(&state, actor)?;
                let project = project_in(&state, str_arg("projectId").as_deref(), actor)?;
                let pid = id(&project).to_string();
                let existing =
                    a.get("id").and_then(|wanted| list(&state, "presets").iter().find(|p| p.get("id") == Some(wanted)));
                if existing.is_some_and(|e| text(e, "projectId") != Some(pid.as_str())) {
                    return fail("Preset belongs to another scope.");
                }
                let cells = list(&a, "cells").to_vec();
                grid::validate_cells(&state, &cells)?;
                if actor.is_some() && cells.iter().any(|c| truthy(c.get("dir"))) {
                    return fail("Cell folders are not available to agents.");
                }
                let layout = grid::layout(cells.len(), a.get("rows"))?;
                let preset = json!({ "id": str_arg("id").unwrap_or_else(model::uid), "name": a["name"], "projectId": pid,
                    "layout": layout, "cells": cells });
                let name = js::to_string(a.get("name"));
                let item = preset.clone();
                self.edit(false, |s| {
                    model::upsert(s, "presets", item);
                    model::log(s, &pid, "preset", &name, actor, now);
                    Ok(())
                })?;
                Ok(preset)
            }
            "create_task" => {
                let cell = str_arg("cellId").unwrap_or_default();
                let found = target_in(&state, &cell, actor)?;
                if actor.is_some_and(|act| act != cell) {
                    coordinator_in(&state, actor)?;
                }
                let pid = found.project_id().to_string();
                for dependency in list(&a, "dependsOn") {
                    let ok = model::tasks(&state)
                        .iter()
                        .find(|t| t.get("id") == Some(dependency))
                        .is_some_and(|t| text(t, "projectId") == Some(pid.as_str()));
                    if !ok {
                        return fail(format!(
                            "Task dependency not found in this project: {}. Task IDs come from get_tasks.",
                            js::to_string(Some(dependency))
                        ));
                    }
                }
                if let Some(act) = actor.filter(|act| *act != cell)
                    && let Some(refusal) = model::delegation_refusal(&state, act, 0, Some(&cell))
                {
                    return fail(refusal);
                }
                let mut task = a.as_object().cloned().unwrap_or_default();
                if let Some(deps) = a.get("dependsOn").and_then(Value::as_array) {
                    let mut unique: Vec<Value> = Vec::new();
                    for d in deps {
                        if !unique.contains(d) {
                            unique.push(d.clone());
                        }
                    }
                    task.insert("dependsOn".into(), Value::Array(unique));
                }
                let task_id = model::uid();
                task.insert("id".into(), json!(task_id));
                task.insert("projectId".into(), json!(pid));
                set_opt(&mut task, "fromCellId", actor.map(|x| json!(x)));
                task.insert("status".into(), json!("queued"));
                task.insert("delivery".into(), json!("pending"));
                task.insert("createdAt".into(), json!(now));
                task.insert("updatedAt".into(), json!(now));
                let task = Value::Object(task);
                let title = js::to_string(task.get("title"));
                self.edit(batch, |s| {
                    model::make_room(s, now, Some((&pid, 1)), None);
                    if model::project_count(model::tasks(s), &pid) >= model::PROJECT_ITEM_LIMIT {
                        return Err(task_limit());
                    }
                    model::items_mut(s, "tasks").push(task);
                    model::log(s, &pid, "task_created", &title, actor, now);
                    Ok(())
                })?;
                self.deliver(Kind::Task, &task_id, actor).await?;
                Ok(model::tasks(&self.state.get()).iter().find(|t| id(t) == task_id).cloned().unwrap_or(Value::Null))
            }
            "get_tasks" => {
                let project = project_in(&state, str_arg("projectId").as_deref(), actor)?;
                let pid = id(&project);
                let coordinator = match actor {
                    Some(act) => js::strict_eq(Some(&role_in(&state, act)?), Some(&json!("coordinator"))),
                    None => true,
                };
                let all = model::tasks(&state);
                let index = TaskIndex::new(all);
                let ids = a.get("ids").and_then(Value::as_array);
                let rows: Vec<Value> = all
                    .iter()
                    .filter(|t| {
                        text(t, "projectId") == Some(pid)
                            && a.get("cellId").is_none_or(|c| t.get("cellId") == Some(c))
                            && ids.is_none_or(|ids| t.get("id").is_some_and(|i| ids.contains(i)))
                            && a.get("status").is_none_or(|st| t.get("status") == Some(st))
                            && (coordinator || text(t, "cellId") == actor)
                    })
                    .map(|t| index.listed(t))
                    .filter(|t| a["readyOnly"] != json!(true) || t["ready"] == json!(true))
                    .skip(num_arg("offset", 0))
                    .take(num_arg("limit", 50))
                    .collect();
                Ok(Value::Array(rows))
            }
            "update_task" => self.update_task(a, actor).await,
            "send_message" => {
                let to = str_arg("toCellId").unwrap_or_default();
                let found = target_in(&state, &to, actor)?;
                let pid = found.project_id().to_string();
                let mut message = a.as_object().cloned().unwrap_or_default();
                let message_id = model::uid();
                message.insert("id".into(), json!(message_id));
                message.insert("projectId".into(), json!(pid));
                set_opt(&mut message, "fromCellId", actor.map(|x| json!(x)));
                message.insert("delivery".into(), json!("pending"));
                message.insert("createdAt".into(), json!(now));
                let message = Value::Object(message);
                let detail = utf16::slice(text(&message, "text").unwrap_or_default(), 0, 140);
                self.edit(batch, |s| {
                    model::make_room(s, now, None, Some((&pid, 1)));
                    if model::project_count(model::messages(s), &pid) >= model::PROJECT_ITEM_LIMIT {
                        return Err(message_limit());
                    }
                    model::items_mut(s, "messages").push(message);
                    model::log(s, &pid, "message", &detail, actor, now);
                    Ok(())
                })?;
                self.deliver(Kind::Message, &message_id, actor).await?;
                Ok(model::messages(&self.state.get()).iter().find(|m| id(m) == message_id).cloned().unwrap_or(Value::Null))
            }
            "get_messages" => {
                let project = project_in(&state, str_arg("projectId").as_deref(), actor)?;
                let pid = id(&project);
                let unread_only = a["unreadOnly"] != json!(false);
                Ok(Value::Array(
                    model::messages(&state)
                        .iter()
                        .filter(|m| {
                            text(m, "projectId") == Some(pid)
                                && actor.is_none_or(|act| text(m, "toCellId") == Some(act))
                                && (!unread_only || !has(m, "readAt"))
                        })
                        .skip(num_arg("offset", 0))
                        .take(num_arg("limit", 50))
                        .cloned()
                        .collect(),
                ))
            }
            "wait_for" => self.wait_for(a, actor, cancel).await,
            "acknowledge_message" => {
                let wanted = str_arg("messageId").unwrap_or_default();
                let Some(message) = model::messages(&state).iter().find(|m| id(m) == wanted) else {
                    return fail("Message not found.");
                };
                project_in(&state, text(message, "projectId"), actor)?;
                if actor.is_some_and(|act| text(message, "toCellId") != Some(act)) {
                    return fail("Only the recipient can acknowledge a message.");
                }
                self.edit(batch, |s| {
                    for m in model::items_mut(s, "messages") {
                        if id(m) == wanted && m.is_object() {
                            m["readAt"] = json!(now);
                        }
                    }
                    Ok(())
                })?;
                Ok(json!({ "acknowledged": true }))
            }
            "set_paused" => {
                let paused = a["paused"] == json!(true);
                self.edit(false, |s| {
                    model::automation_mut(s).insert("paused".into(), json!(paused));
                    Ok(())
                })?;
                Ok(json!({ "paused": paused }))
            }
            "set_role" => {
                let cell = str_arg("cellId").unwrap_or_default();
                let role = a.get("role").cloned().unwrap_or(Value::Null);
                let Some((project, _, c)) = model::find(&state, &cell) else { return fail(AGENT_NOT_FOUND) };
                if !model::is_agent_cell(&state, &c) {
                    return fail(AGENT_NOT_FOUND);
                }
                let detail = role.as_str().unwrap_or("disabled").to_string();
                self.edit(false, |s| {
                    model::update_cell(s, &cell, &[("role", (!role.is_null()).then(|| role.clone()))]);
                    model::log(s, id(&project), "role", &detail, Some(&cell), now);
                    Ok(())
                })?;
                Ok(json!({ "cellId": cell, "role": role }))
            }
            "deliver_task" => self.deliver(Kind::Task, &str_arg("taskId").unwrap_or_default(), actor).await,
            "deliver_message" => self.deliver(Kind::Message, &str_arg("messageId").unwrap_or_default(), actor).await,
            "remove_items" => {
                let project = project_in(&state, str_arg("projectId").as_deref(), actor)?;
                let pid = id(&project).to_string();
                let ids: Option<HashSet<String>> =
                    a.get("ids").and_then(Value::as_array).map(|l| l.iter().map(|v| js::to_string(Some(v))).collect());
                let kind = str_arg("kind").unwrap_or_default();
                let mut removed = 0usize;
                self.edit(false, |s| {
                    // A closed task an open task still depends on stays (its result is what unblocks the other one).
                    let needed: HashSet<String> = model::tasks(s)
                        .iter()
                        .filter(|t| !is_closed(t))
                        .flat_map(|t| list(t, "dependsOn").iter().map(|d| js::to_string(Some(d))))
                        .collect();
                    let gone = |item: &Value, finished: bool| {
                        text(item, "projectId") == Some(pid.as_str())
                            && finished
                            && ids.as_ref().is_none_or(|ids| ids.contains(id(item)))
                            && !needed.contains(id(item))
                    };
                    let key = if kind == "task" { "tasks" } else { "messages" };
                    let before = model::items_mut(s, key).len();
                    model::items_mut(s, key).retain(|item| {
                        let finished = if key == "tasks" { is_closed(item) } else { has(item, "readAt") };
                        !gone(item, finished)
                    });
                    removed = before - model::items_mut(s, key).len();
                    Ok(())
                })?;
                Ok(json!({ "removed": removed }))
            }
            "mark_pasted" => {
                let (kind, wanted) = (str_arg("kind").unwrap_or_default(), str_arg("id").unwrap_or_default());
                self.edit(false, |s| {
                    let key = if kind == "task" { "tasks" } else { "messages" };
                    for item in model::items_mut(s, key) {
                        if id(item) == wanted
                            && let Some(o) = item.as_object_mut()
                        {
                            o.insert("delivery".into(), json!("pasted"));
                            o.shift_remove("deliveryError");
                        }
                    }
                    Ok(())
                })?;
                Ok(json!({ "pasted": true }))
            }
            _ => fail("Unknown operation."),
        }
    }

    fn list_agents(&self, state: &Value, project: &Value, now: i64) -> Vec<Value> {
        let mut rows = Vec::new();
        for tab in list(project, "tabs") {
            for cell in list(tab, "cells") {
                if !model::is_agent_cell(state, cell) {
                    continue;
                }
                let cid = id(cell);
                let profile = crate::automation::profile(state, cell.get("profileId"));
                let mut o = Map::new();
                o.insert("cellId".into(), json!(cid));
                put(&mut o, "name", cell.get("name").filter(|n| !n.is_null()).or(profile.and_then(|p| p.get("name"))).cloned());
                put(&mut o, "gridId", tab.get("id").cloned());
                put(&mut o, "gridName", tab.get("name").cloned());
                put(&mut o, "gridColor", tab.get("color").cloned());
                put(&mut o, "profileId", cell.get("profileId").cloned());
                put(&mut o, "model", cell.get("model").cloned());
                put(&mut o, "color", cell.get("color").cloned());
                o.insert("role".into(), cell.get("role").cloned().unwrap_or(Value::Null));
                o.insert("status".into(), json!(self.statuses.get(cid).unwrap_or_else(|| "unknown".into())));
                put(&mut o, "cwd", model::cell_cwd(project, cell));
                let mcp = if truthy(cell.get("role")) { self.connection(cid).unwrap_or("off") } else { "off" };
                o.insert("mcp".into(), json!(mcp));
                if let Some(since) = self.statuses.since(cid) {
                    o.insert("since".into(), js::num(js::round(((now - since) as f64 / 1000.0).max(0.0))));
                }
                if let Some(code) = self.book.lock().exit_codes.get(cid) {
                    o.insert("lastExitCode".into(), json!(code));
                }
                if let Some(usage) = self.deps.context_of(cid) {
                    let mut c = Map::new();
                    for k in ["percent", "tokens", "window"] {
                        put(&mut c, k, usage.get(k).cloned());
                    }
                    o.insert("context".into(), Value::Object(c));
                }
                let open: Vec<Value> = model::tasks(state)
                    .iter()
                    .filter(|t| text(t, "cellId") == Some(cid) && !is_closed(t))
                    .map(|t| {
                        let mut r = Map::new();
                        for k in ["id", "title", "status"] {
                            put(&mut r, k, t.get(k).cloned());
                        }
                        Value::Object(r)
                    })
                    .collect();
                o.insert("tasks".into(), Value::Array(open));
                rows.push(Value::Object(o));
            }
        }
        rows
    }

    async fn update_task(self: &Arc<Self>, a: Value, actor: Option<&str>) -> Result<Value, OpError> {
        let state = self.state.get();
        let task_id = js::to_string(a.get("taskId"));
        let Some(task) = model::tasks(&state).iter().find(|t| id(t) == task_id).cloned() else {
            return fail("Task not found.");
        };
        project_in(&state, text(&task, "projectId"), actor)?;
        let task_cell = text(&task, "cellId").unwrap_or_default().to_string();
        if actor.is_some_and(|act| act != task_cell) {
            coordinator_in(&state, actor)?;
        }
        if let Some(cell) = a.get("cellId").and_then(Value::as_str) {
            return self.reassign(&task, cell, actor).await;
        }
        let Some(status) = a.get("status").and_then(Value::as_str).map(str::to_string) else {
            return fail("Pass status (in_progress, blocked, completed, cancelled), or cellId to reassign the task.");
        };
        if is_closed(&task) {
            return fail(format!(
                "Task is already closed ({}) and cannot be reopened; update_task {{taskId, cellId}} makes a new task of a cancelled one.",
                js::to_string(task.get("status"))
            ));
        }
        let blocked = TaskIndex::new(model::tasks(&state)).blocked_by(&task);
        if status == "in_progress" && !blocked.is_empty() {
            return fail(format!("Task dependencies have not completed: blockedBy [{}]; wait_for them.", blocked.join(", ")));
        }
        if status == "completed" && !truthy(a.get("result")) {
            return fail("Completed tasks require a result: pass result {summary, files, tests}.");
        }
        if status == "blocked" && !truthy(a.get("blockedReason")) {
            return fail("Blocked tasks require a reason: pass blockedReason.");
        }
        let now = self.now();
        let mut next = task.as_object().cloned().unwrap_or_default();
        next.insert("status".into(), json!(status));
        set_opt(&mut next, "result", a.get("result").cloned());
        set_opt(&mut next, "blockedReason", a.get("blockedReason").cloned());
        next.insert("updatedAt".into(), json!(now));
        let next = Value::Object(next);
        let (pid, title) = (js::to_string(task.get("projectId")), js::to_string(task.get("title")));
        let item = next.clone();
        self.edit(actor.is_some(), |s| {
            for t in model::items_mut(s, "tasks") {
                if id(t) == task_id {
                    *t = item.clone();
                }
            }
            model::log(s, &pid, &format!("task_{status}"), &title, actor, now);
            Ok(())
        })?;
        // Only the agent's own report says what it does now; a coordinator closing a dead worker's task must not hide "exited".
        let alive =
            self.deps.is_cell_running(&task_cell).unwrap_or(true) && self.statuses.get(&task_cell).as_deref() != Some("exited");
        if status != "cancelled" && actor == Some(task_cell.as_str()) && alive {
            let s = match status.as_str() {
                "in_progress" => "working",
                "blocked" => "needs_attention",
                _ => "ready",
            };
            self.statuses.set(&task_cell, s);
        }
        if status == "completed" {
            self.deliver_ready(&task_id).await;
        }
        Ok(next)
    }

    /// update_task {taskId, cellId} (coordinator): a queued task moves to another agent and is delivered there; a cancelled
    /// one becomes a new task for that agent (teamPanel.reassignInput). Others cannot move.
    async fn reassign(self: &Arc<Self>, task: &Value, cell: &str, actor: Option<&str>) -> Result<Value, OpError> {
        let state = self.state.get();
        coordinator_in(&state, actor)?;
        let found = target_in(&state, cell, actor)?;
        if task.get("projectId").and_then(Value::as_str) != Some(found.project_id()) {
            return fail("Target must be an agent of the task's project: see list_agents.");
        }
        let status = text(task, "status").unwrap_or_default();
        if status == "completed" {
            return fail("Task is already completed; use create_task for new work.");
        }
        if status == "cancelled" {
            let mut input = json!({ "cellId": cell, "title": task.get("title"), "prompt": task.get("prompt") });
            if !list(task, "dependsOn").is_empty() {
                input["dependsOn"] = task["dependsOn"].clone();
            }
            return self.execute_op("create_task", input, actor, None).await;
        }
        if status != "queued" {
            return fail(format!(
                "Only a queued task can move to another agent (this one is {status}); cancel it and create_task instead."
            ));
        }
        if text(task, "cellId") == Some(cell) {
            return Ok(task.clone());
        }
        let now = self.now();
        let mut next = task.as_object().cloned().unwrap_or_default();
        next.insert("cellId".into(), json!(cell));
        next.insert("delivery".into(), json!("pending"));
        next.shift_remove("deliveryError");
        next.insert("updatedAt".into(), json!(now));
        let next = Value::Object(next);
        let task_id = id(task).to_string();
        let (pid, title) = (js::to_string(task.get("projectId")), js::to_string(task.get("title")));
        let item = next.clone();
        self.edit(actor.is_some(), |s| {
            for t in model::items_mut(s, "tasks") {
                if id(t) == task_id {
                    *t = item.clone();
                }
            }
            model::log(s, &pid, "task_reassigned", &title, actor, now);
            Ok(())
        })?;
        let _ = self.deliver(Kind::Task, &task_id, actor).await;
        Ok(model::tasks(&self.state.get()).iter().find(|t| id(t) == task_id).cloned().unwrap_or(next))
    }

    // ── delivery ──────────────────────────────────────────────────────────────

    async fn deliver(self: &Arc<Self>, kind: Kind, item_id: &str, actor: Option<&str>) -> Result<Value, OpError> {
        let state = self.state.get();
        let key = if kind == Kind::Task { "tasks" } else { "messages" };
        let Some(item) =
            model::list(state.get("automation").unwrap_or(&Value::Null), key).iter().find(|i| id(i) == item_id).cloned()
        else {
            return fail("Inbox item not found.");
        };
        project_in(&state, text(&item, "projectId"), actor)?;
        let cell = text(&item, if kind == Kind::Task { "cellId" } else { "toCellId" }).unwrap_or_default().to_string();
        if actor.is_some_and(|act| kind == Kind::Task && act != cell) {
            coordinator_in(&state, actor)?;
        }
        if actor.is_some_and(|act| kind == Kind::Message && text(&item, "fromCellId") != Some(act)) {
            return fail("Only the sender can retry delivery.");
        }
        if kind == Kind::Task && is_closed(&item) {
            return fail("Task is already closed.");
        }
        let delivery = item.get("delivery").cloned().unwrap_or(Value::Null);
        if kind == Kind::Task {
            let blocked = TaskIndex::new(model::tasks(&state)).blocked_by(&item);
            if !blocked.is_empty() {
                return Ok(json!({ "delivery": delivery, "blockedBy": blocked }));
            }
        }
        {
            let mut book = self.book.lock();
            if text(&item, "delivery") != Some("pending") || book.delivering.contains(item_id) {
                return Ok(json!({ "delivery": delivery }));
            }
            book.delivering.insert(item_id.to_string());
        }
        let outcome: Result<(), String> = async {
            let state = self.state.get();
            if model::paused(&state) {
                return Err(PAUSED.to_string());
            }
            target_in(&state, &cell, actor).map_err(|e| e.describe())?;
            // A short notice, not the text: the agent reads the item itself (read_inbox), so nothing long is typed.
            let from = match item.get("fromCellId").filter(|f| truthy(Some(f))) {
                Some(f) => {
                    let f = js::to_string(Some(f));
                    model::find(&state, &f)
                        .and_then(|(_, _, c)| c.get("name").filter(|n| !n.is_null()).map(|n| js::to_string(Some(n))))
                        .unwrap_or(f)
                }
                None => "the user".to_string(),
            };
            let notice = if kind == Kind::Task {
                let title = utf16::slice(text(&item, "title").unwrap_or_default(), 0, 80);
                format!("unimux: new task {item_id} \"{title}\" from {from}: read_inbox")
            } else {
                format!("unimux: new message {item_id} from {from}: read_inbox")
            };
            self.deps.deliver(&cell, &notice).await
        }
        .await;
        self.book.lock().delivering.remove(item_id);
        let error = outcome.err();
        let status = if error.is_some() { "pending" } else { "native" };
        let e = error.clone();
        self.edit(actor.is_some(), |s| {
            for i in model::items_mut(s, key) {
                if id(i) == item_id
                    && let Some(o) = i.as_object_mut()
                {
                    o.insert("delivery".into(), json!(status));
                    set_opt(o, "deliveryError", e.clone().map(Value::String));
                }
            }
            Ok(())
        })?;
        let mut out = Map::new();
        out.insert("delivery".into(), json!(status));
        set_opt(&mut out, "deliveryError", error.map(Value::String));
        Ok(Value::Object(out))
    }

    /// A task completed: the pending tasks that waited only for it are delivered now (create_task dependsOn, create_grid after).
    async fn deliver_ready(self: &Arc<Self>, completed: &str) {
        let state = self.state.get();
        let index = TaskIndex::new(model::tasks(&state));
        let ready: Vec<String> = model::tasks(&state)
            .iter()
            .filter(|t| {
                text(t, "status") == Some("queued")
                    && text(t, "delivery") == Some("pending")
                    && list(t, "dependsOn").iter().any(|d| d.as_str() == Some(completed))
                    && index.blocked_by(t).is_empty()
            })
            .map(|t| id(t).to_string())
            .collect();
        for task in ready {
            let _ = self.deliver(Kind::Task, &task, None).await;
        }
    }

    /// The agent started: its pending items (not told while it did not run) are told now.
    async fn deliver_pending_to(self: &Arc<Self>, cell: &str) {
        let state = self.state.get();
        if model::paused(&state) || self.statuses.get(cell).as_deref() == Some("exited") {
            return;
        }
        let index = TaskIndex::new(model::tasks(&state));
        let tasks: Vec<String> = model::tasks(&state)
            .iter()
            .filter(|t| {
                text(t, "cellId") == Some(cell)
                    && text(t, "status") == Some("queued")
                    && text(t, "delivery") == Some("pending")
                    && index.blocked_by(t).is_empty()
            })
            .map(|t| id(t).to_string())
            .collect();
        for task in tasks {
            let _ = self.deliver(Kind::Task, &task, None).await;
        }
        let messages: Vec<String> = model::messages(&state)
            .iter()
            .filter(|m| text(m, "toCellId") == Some(cell) && !has(m, "readAt") && text(m, "delivery") == Some("pending"))
            .map(|m| id(m).to_string())
            .collect();
        for message in messages {
            let _ = self.deliver(Kind::Message, &message, None).await;
        }
    }
}

/// `key: value` of an object literal: `undefined` (None) leaves the key out.
pub(crate) fn put(o: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(v) = value {
        o.insert(key.to_string(), v);
    }
}

/// `{...o, key: value}`: `undefined` removes the key (JSON.stringify drops it), a value replaces it in place.
pub(crate) fn set_opt(o: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(v) => {
            o.insert(key.to_string(), v);
        }
        None => {
            o.shift_remove(key);
        }
    }
}

/// `item.key !== undefined` after a JSON round trip (`readAt`): present and not null.
pub(crate) fn has(item: &Value, key: &str) -> bool {
    item.get(key).is_some_and(|v| !v.is_null())
}

impl Automation for AutomationService {
    fn state(&self) -> Arc<Value> {
        self.state.get()
    }
    fn role_of(&self, cell: &str) -> Option<Role> {
        self.role(cell).as_deref().and_then(Role::parse)
    }
    fn prompts_shown(&self, cell: &str) -> Arc<Mutex<HashSet<String>>> {
        self.book.lock().shown.entry(cell.to_string()).or_default().clone()
    }
    fn execute(
        &self,
        op: &str,
        args: Value,
        actor: &str,
        cancel: Option<CancellationToken>,
    ) -> BoxFuture<'static, Result<Value, OpError>> {
        self.execute_op(op, args, Some(actor), cancel)
    }
}
