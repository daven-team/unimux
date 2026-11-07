//! The tool layer of src/main/mcpTools.ts on top of an [`Automation`]: callTool (role checks, argument schemas, the legacy
//! names), every tool's `run` (result shaping, clipping, agent names resolved to cell IDs, the close_grid confirmation,
//! wait_for progress and the task-mode long wait) and the [`ToolHost`] the server (M1) talks to.

use std::sync::Arc;
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

use crate::automation::{Automation, OpError, find_cell};
use crate::catalog::{self, Delegation, Role, Who};
use crate::js::{self, Obj, truthy};
use crate::schemas;
use crate::tools::{BoxFuture, CallCtx, CallError, ToolHost};
use unimux_core::utf16;

/// Translates a text the user reads (an elicitation prompt) into the app language: (Polish key, params).
pub type Tr = Arc<dyn Fn(&str, &[(&str, String)]) -> String + Send + Sync>;

/// The MCP tools over an automation service.
pub struct McpTools<A: Automation> {
    automation: Arc<A>,
    tr: Option<Tr>,
}

impl<A: Automation> McpTools<A> {
    pub fn new(automation: Arc<A>) -> Arc<Self> {
        Arc::new(Self { automation, tr: None })
    }
    /// With the app's translation of the elicitation texts (mcp.ts `tr`; English without it).
    pub fn with_tr(automation: Arc<A>, tr: Tr) -> Arc<Self> {
        Arc::new(Self { automation, tr: Some(tr) })
    }
    pub fn automation(&self) -> &Arc<A> {
        &self.automation
    }
}

impl<A: Automation> ToolHost for McpTools<A> {
    fn instructions(&self, cell: &str) -> String {
        let state = self.automation.state();
        let found = find_cell(&state, cell);
        let who =
            Who { cell, name: found.and_then(|(_, _, c)| c.get("name")), project: found.and_then(|(p, _, _)| p.get("name")) };
        catalog::instructions(self.automation.role_of(cell), &who, &Delegation::of_state(&state))
    }
    fn tools(&self, cell: &str) -> Vec<Value> {
        catalog::tools_for_role(self.automation.role_of(cell)).to_vec()
    }
    fn supports_task(&self, name: &str) -> bool {
        catalog::supports_task(name)
    }
    fn call(self: Arc<Self>, name: String, args: Option<Value>, ctx: CallCtx) -> BoxFuture<'static, Result<Value, CallError>> {
        Box::pin(async move {
            let run = Run { a: &*self.automation, tr: self.tr.as_ref(), ctx: &ctx };
            match run.call_tool(&name, args.unwrap_or_else(|| json!({}))).await {
                Ok(Some(v)) => Ok(v),
                Ok(None) => Err(CallError::Unknown),
                Err(OpError::Aborted) => Err(CallError::Aborted),
                Err(e) => Err(CallError::Tool(e.describe())),
            }
        })
    }
}

type R<T> = Result<T, OpError>;

fn fail<T>(text: impl Into<String>) -> R<T> {
    Err(OpError::Message(text.into()))
}

/// The open (not completed / cancelled) statuses.
fn is_open(status: Option<&Value>) -> bool {
    !(js::is_str(status, "completed") || js::is_str(status, "cancelled"))
}

/// `clip(text, max, hint)`: a string longer than `max` UTF-16 units is cut with a marker; anything else stays.
fn clip(text: Option<&Value>, max: usize, hint: &str) -> Option<Value> {
    match text {
        Some(Value::String(s)) => {
            let len = utf16::len(s);
            if len > max {
                Some(Value::String(format!("{}...[truncated {} chars; {hint}]", utf16::slice(s, 0, max), len - max)))
            } else {
                Some(Value::String(s.clone()))
            }
        }
        other => other.cloned(),
    }
}

/// resultView: a falsy result stays as it is; otherwise the summary is clipped and long file / test lists end in "+n more".
fn result_view(result: Option<&Value>, full: bool) -> Option<Value> {
    if !truthy(result) {
        return result.cloned();
    }
    let list = |key: &str, keep: usize| -> Option<Value> {
        let v = js::get(result, key);
        if full {
            return v.cloned();
        }
        match v {
            Some(Value::Array(items)) if items.len() > keep => {
                let mut out: Vec<Value> = items[..keep].to_vec();
                out.push(Value::String(format!("+{} more", items.len() - keep)));
                Some(Value::Array(out))
            }
            other => other.cloned(),
        }
    };
    let summary =
        if full { js::get(result, "summary").cloned() } else { clip(js::get(result, "summary"), 400, "verbose:true for all") };
    Some(
        Obj::new()
            .set("summary", summary)
            .set("files", list("files", 5))
            .set("tests", list("tests", 3))
            .set("branch", js::get(result, "branch").cloned())
            .set("commit", js::get(result, "commit").cloned())
            .compact()
            .value(),
    )
}

#[derive(Clone, Copy, Default)]
struct RowOpts {
    prompt: bool,
    full: bool,
    cell: bool,
    own: bool,
}

/// taskRow
fn task_row(t: &Value, o: RowOpts) -> Obj {
    let t = Some(t);
    let g = |k: &str| js::get(t, k).cloned();
    Obj::new()
        .set("id", g("id"))
        .set("cell", if o.cell { g("cellId") } else { None })
        .set("title", g("title"))
        .set("status", g("status"))
        .set("from", g("fromCellId"))
        .set(
            "prompt",
            if o.prompt { clip(js::get(t, "prompt"), if o.full { 32000 } else { 12000 }, "full:true for all") } else { None },
        )
        .set("dependsOn", g("dependsOn"))
        .set("blockedBy", g("blockedBy"))
        .set("blockedReason", g("blockedReason"))
        .set("result", result_view(js::get(t, "result"), o.full))
        .set("delivery", if !o.own && js::is_str(js::get(t, "delivery"), "pending") { Some(json!("pending")) } else { None })
        .set("deliveryError", if o.own { None } else { clip(js::get(t, "deliveryError"), 200, "") })
        .compact()
}

/// created: a new task or message as the model sees it (notified, startup or queued with a note).
fn created(item: &Value, blocked_by: Option<Value>) -> Value {
    if !truthy(Some(item)) {
        return item.clone();
    }
    let delivery = js::get(Some(item), "delivery");
    let shown = if js::is_str(delivery, "native") || js::is_str(delivery, "pasted") {
        "notified"
    } else if js::is_str(delivery, "startup") {
        "startup"
    } else {
        "queued"
    };
    Obj::new()
        .set("id", js::get(Some(item), "id").cloned())
        .set("status", js::get(Some(item), "status").cloned())
        .put("delivery", json!(shown))
        .set("note", if js::is_str(delivery, "pending") { Some(json!(catalog::QUEUED_NOTE)) } else { None })
        .set("blockedBy", blocked_by)
        .compact()
        .value()
}

fn tasks_of(state: &Value) -> &[Value] {
    state.get("automation").and_then(|a| a.get("tasks")).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}
fn messages_of(state: &Value) -> &[Value] {
    state.get("automation").and_then(|a| a.get("messages")).and_then(Value::as_array).map_or(&[], Vec::as_slice)
}

/// Repeats cells that carry `count` (named ones get a " 1", " 2" suffix).
fn expand_cells(cells: &[Value]) -> R<Vec<Value>> {
    let mut out = Vec::new();
    for raw in cells {
        let Some(map) = raw.as_object().filter(|m| m.contains_key("count")) else {
            out.push(raw.clone());
            continue;
        };
        let count = &map["count"];
        let n = count.as_f64().filter(|f| f.fract() == 0.0 && *f >= 1.0 && *f <= 20.0);
        let Some(n) = n else { return fail("count must be an integer from 1 to 20.") };
        let n = n as usize;
        let mut cell = map.clone();
        cell.shift_remove("count");
        let name = cell.get("name").cloned();
        for i in 1..=n {
            if n > 1 && truthy(name.as_ref()) {
                let mut c = cell.clone();
                c.insert("name".into(), Value::String(format!("{} {i}", js::to_string_opt(name.as_ref()))));
                out.push(Value::Object(c));
            } else {
                out.push(Value::Object(cell.clone()));
            }
        }
        if out.len() > 20 {
            return fail("A grid has at most 20 cells.");
        }
    }
    Ok(out)
}

/// One call: the service, the translation and the server's call context.
struct Run<'a, A: Automation> {
    a: &'a A,
    tr: Option<&'a Tr>,
    ctx: &'a CallCtx,
}

impl<A: Automation> Run<'_, A> {
    fn actor(&self) -> &str {
        &self.ctx.cell
    }

    async fn exec(&self, op: &str, args: Value, cancel: bool) -> R<Value> {
        let token = if cancel { Some(self.ctx.cancel.clone()) } else { None };
        self.a.execute(op, args, self.actor(), token).await
    }

    fn say(&self, key: &str, params: &[(&str, String)]) -> String {
        match self.tr {
            Some(tr) => tr(key, params),
            None => {
                let p: Vec<(&str, &str)> = params.iter().map(|(k, v)| (*k, v.as_str())).collect();
                unimux_core::i18n::translate("en", key, &p)
            }
        }
    }

    /// callTool: Ok(None) when the name is unknown.
    async fn call_tool(&self, name: &str, args: Value) -> R<Option<Value>> {
        let tool = catalog::find(name);
        let role = self.a.role_of(self.actor());
        if let Some(tool) = tool
            && let Some(role) = role
            && tool.roles.contains(&role)
        {
            let schema = schemas::tool(name).expect("every tool has a schema");
            let parsed = schema.parse(&args).map_err(OpError::Invalid)?;
            return self.run(name, parsed).await.map(Some);
        }
        if catalog::LEGACY_OPERATIONS.contains(&name) && schemas::operation(name).is_some() {
            return self.exec(name, args, true).await.map(Some);
        }
        if tool.is_some() {
            return fail(if role.is_some() {
                "This tool requires the coordinator role."
            } else {
                "Agent MCP integration is disabled or the cell is no longer available."
            });
        }
        Ok(None)
    }

    async fn run(&self, name: &str, a: Value) -> R<Value> {
        match name {
            "get_context" => self.get_context(&a).await,
            "list_agents" => self.list_agents(&a).await,
            "read_inbox" => self.read_inbox(&a).await,
            "wait_for" => self.wait_for(&a).await,
            "update_task" => self.update_task(&a).await,
            "send_message" => {
                let to = self.resolve_cell_id(js::get(Some(&a), "toCellId")).await?;
                let args = Obj::spread(Some(&a)).set("toCellId", to).value();
                Ok(created(&self.exec("send_message", args, false).await?, None))
            }
            "create_task" => {
                let cell = self.resolve_cell_id(js::get(Some(&a), "cellId")).await?;
                let t = self.exec("create_task", Obj::spread(Some(&a)).set("cellId", cell).value(), false).await?;
                let state = self.a.state();
                let open = js::get(Some(&a), "dependsOn").and_then(Value::as_array).map(|ids| {
                    let tasks = tasks_of(&state);
                    Value::Array(
                        ids.iter()
                            .filter(|id| {
                                let found = tasks.iter().find(|x| js::strict_eq(x.get("id"), Some(id)));
                                !js::is_str(found.and_then(|x| x.get("status")), "completed")
                            })
                            .cloned()
                            .collect(),
                    )
                });
                Ok(created(&t, open))
            }
            "get_tasks" => self.get_tasks(&a).await,
            "snippets" => self.snippets(&a).await,
            "update_agent" => self.update_agent(&a).await,
            "create_grid" => self.create_grid(&a).await,
            "close_grid" => self.close_grid(&a).await,
            "update_grid" => {
                let mut args = Obj::spread(Some(&a));
                if js::is_str(js::get(Some(&a), "color"), "") {
                    args = args.put("color", Value::Null);
                }
                self.exec("update_grid", args.value(), false).await?;
                Ok(Obj::new().set("gridId", js::get(Some(&a), "gridId").cloned()).value())
            }
            "save_preset" => {
                let p = self.exec("save_preset", a, false).await?;
                Ok(Obj::new().set("id", p.get("id").cloned()).set("name", p.get("name").cloned()).value())
            }
            "deliver" => {
                let task = js::get(Some(&a), "taskId");
                let message = js::get(Some(&a), "messageId");
                if task.is_none() == message.is_none() {
                    return fail("Pass exactly one of taskId or messageId.");
                }
                let r = match task {
                    Some(t) => self.exec("deliver_task", json!({ "taskId": t }), false).await?,
                    None => self.exec("deliver_message", json!({ "messageId": message }), false).await?,
                };
                Ok(Obj::new()
                    .set("delivery", r.get("delivery").cloned())
                    .set("deliveryError", clip(r.get("deliveryError"), 200, ""))
                    .set("blockedBy", r.get("blockedBy").cloned())
                    .compact()
                    .value())
            }
            "help" => {
                let topic = js::get(Some(&a), "topic").and_then(Value::as_str).unwrap_or("workflow").to_string();
                let text = catalog::help(&topic);
                Ok(Obj::new().put("topic", json!(topic)).set("text", text.map(Value::String)).value())
            }
            _ => unreachable!("a listed tool without a run: {name}"),
        }
    }

    fn open_count(&self, state: &Value, cell: &str) -> usize {
        tasks_of(state).iter().filter(|t| js::is_str(t.get("cellId"), cell) && is_open(t.get("status"))).count()
    }

    async fn get_context(&self, a: &Value) -> R<Value> {
        let c = self.exec("get_context", json!({}), false).await?;
        let state = self.a.state();
        let actor = self.actor();
        let found = find_cell(&state, actor);
        let g = |k: &str| c.get(k).cloned();
        let unread =
            messages_of(&state).iter().filter(|m| js::is_str(m.get("toCellId"), actor) && !truthy(m.get("readAt"))).count();
        Ok(Obj::new()
            .set("cellId", g("cellId"))
            .set("name", found.and_then(|(_, _, cell)| cell.get("name")).cloned())
            .set("role", g("role"))
            .put("project", Obj::new().set("id", g("projectId")).set("name", g("projectName")).value())
            .set("gridId", g("gridId"))
            .set("cwd", g("cwd"))
            .set("profile", g("profileId"))
            .set("model", g("model"))
            .set("paused", js::or_undefined(c.get("paused")))
            .put("inbox", json!({ "openTasks": self.open_count(&state, actor), "unreadMessages": unread }))
            .set("profiles", if truthy(js::get(Some(a), "profiles")) { g("profiles") } else { None })
            .compact()
            .value())
    }

    async fn list_agents(&self, a: &Value) -> R<Value> {
        let project = js::get(Some(a), "projectId");
        let args = if truthy(project) { json!({ "projectId": project }) } else { json!({}) };
        let rows = self.exec("list_agents", args, false).await?;
        let verbose = truthy(js::get(Some(a), "verbose"));
        let rows = rows.as_array().cloned().unwrap_or_default();
        // A Map keyed by gridId: first appearance keeps its place, the last name wins.
        let mut grids: Vec<(Option<Value>, Option<Value>)> = Vec::new();
        for r in &rows {
            let id = r.get("gridId").cloned();
            let name = r.get("gridName").cloned();
            match grids.iter_mut().find(|(k, _)| same_value_zero(k.as_ref(), id.as_ref())) {
                Some(slot) => slot.1 = name,
                None => grids.push((id, name)),
            }
        }
        let agents: Vec<Value> = rows
            .iter()
            .map(|r| {
                let g = |k: &str| r.get(k).cloned();
                let open = js::array_len(r.get("tasks"));
                Obj::new()
                    .set("id", g("cellId"))
                    .set("name", g("name"))
                    .set("role", g("role"))
                    .set("grid", g("gridId"))
                    .set("status", g("status"))
                    .set("since", g("since"))
                    .set("mcp", if truthy(r.get("role")) { g("mcp") } else { None })
                    .set("open", if open > 0 { Some(json!(open)) } else { None })
                    .set("profile", if verbose { g("profileId") } else { None })
                    .set("model", if verbose { g("model") } else { None })
                    .set("cwd", if verbose { g("cwd") } else { None })
                    .set("tasks", if verbose { g("tasks") } else { None })
                    .set("lastExitCode", if verbose { g("lastExitCode") } else { None })
                    .compact()
                    .value()
            })
            .collect();
        let grids: Vec<Value> = grids.into_iter().map(|(id, name)| Obj::new().set("id", id).set("name", name).value()).collect();
        Ok(json!({ "agents": agents, "grids": grids }))
    }

    async fn read_inbox(&self, a: &Value) -> R<Value> {
        let a = Some(a);
        let full = js::get(a, "full") == Some(&Value::Bool(true));
        let cap = if full { 32000 } else { 8000 };
        let default = |k: &str, v: Value| js::get(a, k).cloned().filter(|x| !x.is_null()).unwrap_or(v);
        let args = Obj::new()
            .put("acknowledge", default("acknowledge", json!(false)))
            .put("openOnly", default("openOnly", json!(!truthy(js::get(a, "closed")))))
            .put("limit", default("limit", json!(20)))
            .put("offset", default("offset", json!(0)))
            .put("ackMaxChars", json!(cap))
            .value();
        let r = self.exec("read_inbox", args, false).await?;
        let shown = self.a.prompts_shown(self.actor());
        let rows: Vec<Value> = {
            let mut shown = shown.lock();
            r.get("tasks")
                .and_then(Value::as_array)
                .map(|tasks| {
                    tasks
                        .iter()
                        .map(|t| {
                            let open = is_open(t.get("status"));
                            let id = t.get("id").map(id_key);
                            let repeat = open && !full && id.as_ref().is_some_and(|k| shown.contains(k));
                            let short = t.get("prompt").and_then(Value::as_str).is_some_and(|p| utf16::len(p) <= 12000);
                            if open
                                && !repeat
                                && short
                                && let Some(k) = id
                            {
                                shown.insert(k);
                            }
                            if repeat {
                                task_row(t, RowOpts { prompt: false, full, own: true, ..Default::default() })
                                    .put("seen", json!(true))
                                    .value()
                            } else {
                                task_row(t, RowOpts { prompt: open, full, own: true, ..Default::default() }).value()
                            }
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        let hint =
            if truthy(js::get(a, "acknowledge")) { "kept unread; read_inbox full:true for all" } else { "full:true for all" };
        let messages: Vec<Value> = r
            .get("messages")
            .and_then(Value::as_array)
            .map(|ms| {
                ms.iter()
                    .map(|m| {
                        Obj::new()
                            .set("id", m.get("id").cloned())
                            .set("from", m.get("fromCellId").cloned())
                            .set("text", clip(m.get("text"), cap, hint))
                            .compact()
                            .value()
                    })
                    .collect()
            })
            .unwrap_or_default();
        let more = js::or(r.get("hasMoreTasks"), r.get("hasMoreMessages"));
        let tail = Obj::new()
            .set("acknowledgedMessageIds", r.get("acknowledgedMessageIds").cloned())
            .set("more", js::or_undefined(more.as_ref()))
            .compact();
        let mut out = Obj::new().put("tasks", Value::Array(rows)).put("messages", Value::Array(messages));
        for (k, v) in tail.0 {
            out = out.put(&k, v);
        }
        Ok(out.value())
    }

    async fn wait_for(&self, a: &Value) -> R<Value> {
        let started = Instant::now();
        let total = js::get(Some(a), "timeoutSec").and_then(Value::as_f64).unwrap_or(60.0);
        let wait = async { if self.ctx.task { self.long_wait(a).await } else { self.exec("wait_for", a.clone(), true).await } };
        let r = match &self.ctx.progress {
            None => wait.await?,
            Some(progress) => {
                let every = self.ctx.progress_every.max(Duration::from_millis(1));
                let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
                tokio::pin!(wait);
                loop {
                    tokio::select! {
                        r = &mut wait => break r?,
                        _ = tick.tick() => {
                            let waited = unimux_state::normalize::js::round(started.elapsed().as_secs_f64());
                            progress(waited, total, "waiting".to_string());
                        }
                    }
                }
            }
        };
        let Some(tasks) = r.get("tasks").filter(|t| truthy(Some(t))) else { return Ok(r) };
        let tasks: Vec<Value> = tasks
            .as_array()
            .map(|ts| {
                ts.iter()
                    .map(|t| {
                        Obj::spread(Some(t))
                            .set("summary", clip(t.get("summary"), 300, "get_tasks ids for all"))
                            .set("blockedReason", clip(t.get("blockedReason"), 300, ""))
                            .compact()
                            .value()
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Obj::spread(Some(&r)).put("tasks", Value::Array(tasks)).value())
    }

    /// longWait: the service's bounded wait in WAIT_MAX_SECONDS slices until something happens or the task's deadline.
    async fn long_wait(&self, a: &Value) -> R<Value> {
        let max = catalog::TASK_WAIT_MAX_SECONDS as f64;
        let requested = js::get(Some(a), "timeoutSec").and_then(Value::as_f64).unwrap_or(catalog::WAIT_MAX_SECONDS as f64);
        if requested.fract() != 0.0 || !(1.0..=max).contains(&requested) {
            return fail(format!("timeoutSec must be an integer from 1 to {} for a task.", catalog::TASK_WAIT_MAX_SECONDS));
        }
        let deadline = Instant::now() + Duration::from_secs_f64(requested);
        loop {
            let left = deadline.saturating_duration_since(Instant::now()).as_secs_f64().ceil();
            let slice = left.min(catalog::WAIT_MAX_SECONDS as f64).max(1.0);
            let args = Obj::spread(Some(a)).put("timeoutSec", js::num(slice)).value();
            let r = self.exec("wait_for", args, true).await?;
            if !js::is_str(r.get("event"), "timeout") || self.ctx.cancel.is_cancelled() || Instant::now() >= deadline {
                return Ok(r);
            }
        }
    }

    async fn update_task(&self, a: &Value) -> R<Value> {
        let reassign = js::get(Some(a), "cellId").is_some();
        let attempt = async {
            let mut args = Obj::spread(Some(a));
            if reassign {
                let cell = self.resolve_cell_id(js::get(Some(a), "cellId")).await?;
                args = args.set("cellId", cell);
            }
            self.exec("update_task", args.value(), false).await
        };
        match attempt.await {
            Ok(t) => Ok(if reassign {
                created(&t, None)
            } else {
                Obj::new().set("id", t.get("id").cloned()).set("status", t.get("status").cloned()).value()
            }),
            // The model guessed or mistyped an id: say where the valid ones are.
            Err(OpError::Message(m)) if m == "Task not found." => {
                let more = if self.a.role_of(self.actor()) == Some(Role::Coordinator) { " or get_tasks" } else { "" };
                fail(format!(
                    "Task not found: {}. Task IDs come from read_inbox{more}.",
                    js::to_string_opt(js::get(Some(a), "taskId"))
                ))
            }
            Err(e) => Err(e),
        }
    }

    async fn get_tasks(&self, a: &Value) -> R<Value> {
        let limit = js::get(Some(a), "limit").and_then(Value::as_f64).unwrap_or(25.0).clamp(1.0, 100.0);
        let offset = js::get(Some(a), "offset").and_then(Value::as_f64).unwrap_or(0.0);
        let filters = Obj::spread(Some(a)).without(&["verbose", "limit", "offset"]);
        let args = filters.put("limit", js::num((limit + 1.0).min(100.0))).put("offset", js::num(offset)).value();
        let rows = self.exec("get_tasks", args, false).await?;
        let rows = rows.as_array().cloned().unwrap_or_default();
        let verbose = js::get(Some(a), "verbose") == Some(&Value::Bool(true));
        let page: Vec<Value> = rows
            .iter()
            .take(limit as usize)
            .map(|t| task_row(t, RowOpts { prompt: verbose, full: verbose, cell: true, own: false }).value())
            .collect();
        let n = rows.len() as f64;
        let next = if n > limit || (limit == 100.0 && n == 100.0) { Some(js::num(offset + limit)) } else { None };
        Ok(Obj::new().put("tasks", Value::Array(page)).set("next", next).compact().value())
    }

    async fn snippets(&self, a: &Value) -> R<Value> {
        let g = |k: &str| js::get(Some(a), k).cloned();
        match js::get(Some(a), "action").and_then(Value::as_str).unwrap_or("list") {
            "list" => {
                let r = self.exec("list_library", json!({}), false).await?;
                let snippets: Vec<Value> = r
                    .get("snippets")
                    .and_then(Value::as_array)
                    .map(|ss| {
                        ss.iter()
                            .map(|s| {
                                Obj::new()
                                    .set("id", s.get("id").cloned())
                                    .set("name", s.get("name").cloned())
                                    .set("global", if truthy(s.get("projectId")) { None } else { Some(json!(true)) })
                                    .compact()
                                    .value()
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let presets: Vec<Value> = r
                    .get("presets")
                    .and_then(Value::as_array)
                    .map(|ps| {
                        ps.iter()
                            .map(|p| {
                                Obj::new()
                                    .set("id", p.get("id").cloned())
                                    .set("name", p.get("name").cloned())
                                    .put("cells", json!(js::array_len(p.get("cells"))))
                                    .value()
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                Ok(json!({ "snippets": snippets, "presets": presets }))
            }
            "get" => {
                let s = self.exec("get_snippet", Obj::new().set("snippetId", g("snippetId")).value(), false).await?;
                Ok(Obj::new()
                    .set("id", s.get("id").cloned())
                    .set("name", s.get("name").cloned())
                    .set("text", s.get("text").cloned())
                    .set("autoSend", js::or_undefined(s.get("autoSend")))
                    .compact()
                    .value())
            }
            "save" => {
                let args = Obj::new()
                    .set("id", g("snippetId"))
                    .set("name", g("name"))
                    .set("text", g("text"))
                    .put("autoSend", g("autoSend").unwrap_or(json!(false)))
                    .value();
                let s = self.exec("save_snippet", args, false).await?;
                Ok(Obj::new().set("id", s.get("id").cloned()).set("name", s.get("name").cloned()).value())
            }
            _ => {
                let cell = self.resolve_cell_id(js::get(Some(a), "cellId")).await?;
                let args = Obj::new().set("snippetId", g("snippetId")).set("cellId", cell).value();
                Ok(created(&self.exec("apply_snippet", args, false).await?, None))
            }
        }
    }

    async fn update_agent(&self, a: &Value) -> R<Value> {
        let cell = js::get(Some(a), "cellId");
        let color = js::get(Some(a), "color");
        let model = js::get(Some(a), "model");
        let cell = match cell {
            None => Some(json!(self.actor())),
            Some(_) => self.resolve_cell_id(cell).await?,
        };
        let clear = |v: &Value| if js::is_str(Some(v), "") { Value::Null } else { v.clone() };
        let args = Obj::spread(Some(a))
            .without(&["cellId", "color", "model"])
            .set("cellId", cell)
            .set("color", color.map(clear))
            .set("model", model.map(clear))
            .value();
        let r = self.exec("update_agent", args, false).await?;
        let restarted =
            if truthy(js::get(Some(a), "restart")) { r.get("restarted").cloned() } else { js::or_undefined(r.get("restarted")) };
        Ok(Obj::new()
            .set("cellId", r.get("cellId").cloned())
            .set("needsRestart", js::or_undefined(r.get("needsRestart")))
            .set("restarted", restarted)
            .set("restartReason", clip(r.get("restartReason"), 200, ""))
            .compact()
            .value())
    }

    async fn create_grid(&self, a: &Value) -> R<Value> {
        let g = |k: &str| js::get(Some(a), k).cloned();
        let rest = Obj::spread(Some(a)).without(&["gridId", "name", "color", "presetId", "cells"]);
        let expanded = match js::get(Some(a), "cells") {
            None => None,
            Some(cells) => Some(Value::Array(expand_cells(cells.as_array().map_or(&[], Vec::as_slice))?)),
        };
        if let Some(grid) = g("gridId") {
            if g("presetId").is_some() {
                return fail("presetId cannot be combined with gridId.");
            }
            let mut args = Obj::new().put("gridId", grid);
            for (k, v) in rest.0 {
                args = args.put(&k, v);
            }
            return self.exec("add_agents", args.set("cells", expanded).value(), false).await;
        }
        let args = rest.set("cells", expanded).set("name", g("name")).set("color", g("color")).set("presetId", g("presetId"));
        self.exec("create_grid", args.value(), false).await
    }

    async fn close_grid(&self, a: &Value) -> R<Value> {
        let mut args = a.clone();
        let (grid, count) =
            if truthy(js::get(Some(a), "cancelTasks")) { (None, 0) } else { self.unfinished_in_grid(js::get(Some(a), "gridId")) };
        // Unfinished tasks: a client that can ask the user gets the user's decision instead of an error the model might "fix"
        // by itself with cancelTasks:true.
        if count > 0
            && let Some(elicit) = &self.ctx.elicit
        {
            let state = self.a.state();
            let me = find_cell(&state, self.actor())
                .and_then(|(_, _, c)| c.get("name"))
                .filter(|n| !n.is_null())
                .map(js::to_string)
                .unwrap_or_else(|| self.actor().to_string());
            let message = self.say(
                "{agent} chce zamknąć grid „{grid}” i anulować niedokończone zadania ({count}). Zgodzić się?",
                &[
                    ("agent", me),
                    ("grid", grid.filter(|g| !g.is_null()).map(|g| js::to_string(&g)).unwrap_or_default()),
                    ("count", count.to_string()),
                ],
            );
            let schema = json!({ "type": "object", "required": ["confirm"], "properties": { "confirm": {
                "type": "boolean", "title": self.say("Zamknij grid i anuluj zadania", &[]), "default": false } } });
            let answer = elicit(message, schema).await;
            let confirmed = answer.content.as_ref().and_then(|c| c.get("confirm")) == Some(&Value::Bool(true));
            if answer.action != "accept" || !confirmed {
                return fail(format!(
                    "The user did not confirm closing the grid ({count} unfinished tasks stay). Do not retry with cancelTasks:true unless the user asks."
                ));
            }
            args = Obj::spread(Some(a)).put("cancelTasks", json!(true)).value();
        }
        let r = self.exec("close_grid", args, false).await?;
        Ok(Obj::new()
            .set("archived", r.get("archivedGridId").cloned())
            .put("stopped", json!(js::array_len(r.get("stoppedCellIds"))))
            .value())
    }

    /// Open tasks of a grid's cells: (the grid's name, how many).
    fn unfinished_in_grid(&self, grid: Option<&Value>) -> (Option<Value>, usize) {
        let state = self.a.state();
        let tab = state
            .get("projects")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .flat_map(|p| p.get("tabs").and_then(Value::as_array).into_iter().flatten())
            .find(|t| js::strict_eq(t.get("id"), grid));
        let Some(tab) = tab else { return (None, 0) };
        let ids: Vec<&Value> =
            tab.get("cells").and_then(Value::as_array).into_iter().flatten().filter_map(|c| c.get("id")).collect();
        let count = tasks_of(&state)
            .iter()
            .filter(|t| ids.iter().any(|id| js::strict_eq(t.get("cellId"), Some(id))) && is_open(t.get("status")))
            .count();
        (tab.get("name").cloned(), count)
    }

    /// resolveCellId: an agent's exact name (case and surrounding space ignored) becomes its cell ID; several matches ask
    /// the user (elicitation) or fail with the candidates; anything else is left to the service.
    async fn resolve_cell_id(&self, value: Option<&Value>) -> R<Option<Value>> {
        let Some(Value::String(text)) = value else { return Ok(value.cloned()) };
        let state = self.a.state();
        if utf16::js_trim(text).is_empty() || find_cell(&state, text).is_some() {
            return Ok(value.cloned());
        }
        let rows = self.exec("list_agents", json!({}), false).await?;
        let rows = rows.as_array().cloned().unwrap_or_default();
        let wanted = utf16::js_trim(text).to_lowercase();
        let matches: Vec<&Value> = rows
            .iter()
            .filter(|r| r.get("name").and_then(Value::as_str).is_some_and(|n| utf16::js_trim(n).to_lowercase() == wanted))
            .collect();
        if matches.len() == 1 {
            return Ok(matches[0].get("cellId").cloned());
        }
        if matches.len() < 2 {
            return Ok(value.cloned());
        }
        if let Some(elicit) = &self.ctx.elicit {
            let options: Vec<Value> = matches
                .iter()
                .map(|m| {
                    Obj::new()
                        .set("const", m.get("cellId").cloned())
                        .put(
                            "title",
                            json!(format!("{} ({})", js::to_string_opt(m.get("name")), js::to_string_opt(m.get("gridName")))),
                        )
                        .value()
                })
                .collect();
            let message =
                self.say("Kilku agentów nazywa się „{name}”. Którego wybrać?", &[("name", utf16::js_trim(text).to_string())]);
            let schema = json!({ "type": "object", "required": ["cellId"], "properties": { "cellId": {
                "type": "string", "title": self.say("Agent", &[]), "oneOf": options } } });
            let answer = elicit(message, schema).await;
            if answer.action == "accept"
                && let Some(Value::String(picked)) = answer.content.as_ref().and_then(|c| c.get("cellId"))
                && matches.iter().any(|m| js::is_str(m.get("cellId"), picked))
            {
                return Ok(Some(Value::String(picked.clone())));
            }
        }
        let list = matches
            .iter()
            .map(|m| format!("{} ({})", js::to_string_opt(m.get("cellId")), js::to_string_opt(m.get("gridName"))))
            .collect::<Vec<_>>()
            .join(", ");
        fail(format!("Ambiguous agent name \"{text}\": {list}. Pass the cell ID from list_agents."))
    }
}

/// The key a prompt ID has in the shown set.
fn id_key(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => format!("\u{0}{}", unimux_core::js_json::stringify(other)),
    }
}

/// Map key equality (SameValueZero) for the primitive grid IDs.
fn same_value_zero(a: Option<&Value>, b: Option<&Value>) -> bool {
    js::strict_eq(a, b)
}

/// For tests and the check build: a [`CallCtx`] without elicitation or progress.
pub fn plain_ctx(cell: &str, task: bool) -> CallCtx {
    CallCtx {
        cell: cell.to_string(),
        cancel: CancellationToken::new(),
        elicit: None,
        progress: None,
        progress_every: Duration::from_millis(catalog::PROGRESS_EVERY_MS),
        task,
    }
}
