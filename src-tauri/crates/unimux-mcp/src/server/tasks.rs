//! MCP tasks of protocol 2025-11-25 as the SDK's InMemoryTaskStore keeps them for 1.1.4 (mcp.ts startTask): one store per
//! token, a task private to the session that created it (InMemoryTaskStore.lookup), tasks/list paged 10 at a time, the ttl
//! clamped to 60 s..1 h and restarted when the result is stored or the task is cancelled, a working task that expires is
//! aborted (mcp.ts's 1 s watch), at most 16 working tasks per token.

use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;
use unimux_core::time::iso_now;

use super::{Inner, ReqCtx, Shared, call_outcome};
use crate::jsonrpc::{error, js_number, mcp_error, result};
use crate::tools::{CallCtx, error_content};

pub const MAX_RUNNING_TASKS: usize = 16;
pub const TASK_TTL_MS: f64 = 60.0 * 60_000.0;
pub const TASK_POLL_MS: u64 = 2000;
const PAGE_SIZE: usize = 10;
const TERMINAL: [&str; 3] = ["completed", "failed", "cancelled"];

pub struct TaskEntry {
    pub task: Value,
    result: Option<Value>,
    pub cancel: CancellationToken,
    changed: Arc<tokio::sync::Notify>,
    /// The session the task was created in (None: a stateless request).
    session: Option<String>,
    /// Bumped whenever the cleanup timer is (re)armed; an older timer that fires finds a newer value and does nothing.
    expiry: u64,
}

/// InMemoryTaskStore.lookup: a task of a session is visible to that session and to callers without a session.
fn visible(entry: &TaskEntry, session: Option<&str>) -> bool {
    match (session, entry.session.as_deref()) {
        (Some(caller), Some(owner)) => caller == owner,
        _ => true,
    }
}

fn find<'a>(inner: &'a Inner, token: &str, session: Option<&str>, task_id: &str) -> Option<&'a TaskEntry> {
    inner.tasks.get(token)?.iter().find(|(i, t)| i == task_id && visible(t, session)).map(|(_, t)| t)
}

fn ttl_of(entry: &TaskEntry) -> Duration {
    Duration::from_secs_f64(entry.task["ttl"].as_f64().unwrap_or(0.0).max(0.0) / 1000.0)
}

pub fn get(ctx: &ReqCtx, id: &Value, task_id: &str) -> Value {
    let inner = ctx.shared.inner.lock();
    match find(&inner, &ctx.token, ctx.session_id(), task_id) {
        Some(t) => result(id, t.task.clone()),
        None => mcp_error(id, -32602, "Failed to retrieve task: Task not found"),
    }
}

pub fn cancel(ctx: &ReqCtx, id: &Value, task_id: &str) -> Value {
    let mut inner = ctx.shared.inner.lock();
    let session = ctx.session_id();
    let Some(entry) = inner
        .tasks
        .get_mut(&ctx.token)
        .and_then(|v| v.iter_mut().find(|(i, t)| i == task_id && visible(t, session)))
        .map(|(_, t)| t)
    else {
        return mcp_error(id, -32602, &format!("Task not found: {task_id}"));
    };
    let status = entry.task["status"].as_str().unwrap_or("").to_string();
    if TERMINAL.contains(&status.as_str()) {
        return mcp_error(id, -32602, &format!("Cannot cancel task in terminal status: {status}"));
    }
    entry.task["status"] = json!("cancelled");
    entry.task["statusMessage"] = json!("Client cancelled task execution.");
    entry.task["lastUpdatedAt"] = json!(iso_now());
    entry.cancel.cancel();
    entry.changed.notify_waiters();
    let mut answer = Map::new();
    answer.insert("_meta".into(), json!({}));
    for (k, v) in entry.task.as_object().cloned().unwrap_or_default() {
        answer.insert(k, v);
    }
    // updateTaskStatus to a terminal status restarts the cleanup timer.
    let ttl = ttl_of(entry);
    drop(inner);
    arm_expiry(&ctx.shared, &ctx.token, task_id, ttl);
    result(id, Value::Object(answer))
}

/// InMemoryTaskStore.listTasks: the tasks the caller can look up, in creation order, 10 per page; `nextCursor` is the last
/// id of the page when more remain, and a cursor that is not one of those ids is refused.
pub fn list(ctx: &ReqCtx, id: &Value, cursor: Option<&str>) -> Value {
    let inner = ctx.shared.inner.lock();
    let session = ctx.session_id();
    let all: Vec<&(String, TaskEntry)> =
        inner.tasks.get(&ctx.token).map(|v| v.iter().filter(|(_, t)| visible(t, session)).collect()).unwrap_or_default();
    let start = match cursor.filter(|c| !c.is_empty()) {
        None => 0,
        Some(c) => match all.iter().position(|(i, _)| i == c) {
            Some(index) => index + 1,
            None => return mcp_error(id, -32602, &format!("Failed to list tasks: Invalid cursor: {c}")),
        },
    };
    let page: Vec<&(String, TaskEntry)> = all.iter().skip(start).take(PAGE_SIZE).copied().collect();
    let mut answer = Map::new();
    answer.insert("tasks".into(), Value::Array(page.iter().map(|(_, t)| t.task.clone()).collect()));
    if start + PAGE_SIZE < all.len()
        && let Some((last, _)) = page.last()
    {
        answer.insert("nextCursor".into(), json!(last));
    }
    answer.insert("_meta".into(), json!({}));
    result(id, Value::Object(answer))
}

/// (Re)arms the task's cleanup timer to `ttl` from now (InMemoryTaskStore createTask, storeTaskResult and a terminal
/// updateTaskStatus). When it fires the task is deleted, and a task still working is aborted.
fn arm_expiry(shared: &Arc<Shared>, token: &str, task_id: &str, ttl: Duration) {
    let generation = {
        let mut inner = shared.inner.lock();
        let Some((_, entry)) = inner.tasks.get_mut(token).and_then(|v| v.iter_mut().find(|(i, _)| i == task_id)) else {
            return;
        };
        entry.expiry += 1;
        entry.expiry
    };
    let (shared, token, task_id) = (shared.clone(), token.to_string(), task_id.to_string());
    tokio::spawn(async move {
        tokio::time::sleep(ttl).await;
        let mut inner = shared.inner.lock();
        let Some(tasks) = inner.tasks.get_mut(&token) else { return };
        let Some(index) = tasks.iter().position(|(i, t)| *i == task_id && t.expiry == generation) else { return };
        let (_, entry) = tasks.remove(index);
        entry.cancel.cancel();
        entry.changed.notify_waiters();
    });
}

/// A task-augmented tools/call: answered at once with the task; the tool runs in the background with the token's
/// permissions and its result is kept for the task's ttl.
pub fn start(ctx: &Arc<ReqCtx>, id: &Value, name: &str, args: Option<Value>, ttl: Option<f64>) -> Value {
    let shared = &ctx.shared;
    let mut inner = shared.inner.lock();
    // The running cap counts every task of the token (store.getAllTasks(), no session filter).
    let running =
        inner.tasks.get(&ctx.token).map(|v| v.iter().filter(|(_, t)| t.task["status"] == "working").count()).unwrap_or(0);
    if running >= MAX_RUNNING_TASKS {
        return mcp_error(id, -32600, &format!("At most {MAX_RUNNING_TASKS} tasks may run at once; wait for one to finish."));
    }
    let Some(token_cancel) = inner.token_cancel.get(&ctx.token).cloned() else {
        return mcp_error(id, -32600, "Agent connection has expired.");
    };
    let task_id = super::random_hex::<16>();
    // `Math.min(Math.max(ttl ?? TASK_TTL_MS, MIN_TASK_TTL_MS), TASK_TTL_MS)` in ms; any number (a fraction stays).
    let min_ttl = shared.cfg.min_task_ttl.as_secs_f64() * 1000.0;
    let ttl_ms = ttl.unwrap_or(TASK_TTL_MS).max(min_ttl).min(TASK_TTL_MS);
    let ttl = Duration::from_secs_f64(ttl_ms / 1000.0);
    let created = iso_now();
    let task = json!({ "taskId": task_id, "status": "working", "ttl": js_number(ttl_ms), "createdAt": created,
        "lastUpdatedAt": created, "pollInterval": TASK_POLL_MS });
    let cancel = token_cancel.child_token();
    let changed = Arc::new(tokio::sync::Notify::new());
    let entry = TaskEntry {
        task: task.clone(),
        result: None,
        cancel: cancel.clone(),
        changed,
        session: ctx.session_id().map(str::to_string),
        expiry: 0,
    };
    inner.tasks.entry(ctx.token.clone()).or_default().push((task_id.clone(), entry));
    drop(inner);
    arm_expiry(shared, &ctx.token, &task_id, ttl);
    let (shared, token, cell, name) = (shared.clone(), ctx.token.clone(), ctx.cell.clone(), name.to_string());
    let tid = task_id.clone();
    tokio::spawn(async move {
        let call = CallCtx {
            cell: cell.clone(),
            cancel: cancel.clone(),
            elicit: None,
            progress: None,
            progress_every: shared.cfg.progress_every,
            task: true,
        };
        let outcome = shared.host.clone().call(name.clone(), args, call).await;
        let content = match call_outcome(&shared, &token, &cell, &name, outcome, false) {
            Ok(content) => content,
            // A task has no protocol error: the unknown tool is a tool error (`throw new Error('Unknown tool: x')`).
            Err(text) => error_content(&text),
        };
        let mut inner = shared.inner.lock();
        let mut stored = false;
        if let Some((_, entry)) = inner.tasks.get_mut(&token).and_then(|v| v.iter_mut().find(|(i, _)| *i == tid))
            && entry.task["status"] == "working"
        {
            entry.task["status"] = json!("completed");
            entry.task["lastUpdatedAt"] = json!(iso_now());
            entry.result = Some(content);
            entry.changed.notify_waiters();
            stored = true;
        }
        drop(inner);
        // storeTaskResult restarts the cleanup timer: the result is kept for a full ttl after completion.
        if stored {
            arm_expiry(&shared, &token, &tid, ttl);
        }
    });
    result(id, json!({ "task": task }))
}

/// tasks/result blocks until the task is terminal, then answers its result with the related-task meta.
pub async fn result_of(ctx: &ReqCtx, id: &Value, task_id: &str, cancel: CancellationToken) -> Value {
    loop {
        let changed = {
            let inner = ctx.shared.inner.lock();
            let Some(entry) = find(&inner, &ctx.token, ctx.session_id(), task_id) else {
                return mcp_error(id, -32602, &format!("Task not found: {task_id}"));
            };
            let status = entry.task["status"].as_str().unwrap_or("");
            if TERMINAL.contains(&status) {
                let Some(mut answer) = entry.result.clone() else {
                    // getTaskResult throws a plain Error: no `MCP error` prefix.
                    return error(id, -32603, &format!("Task {task_id} has no result stored"));
                };
                answer["_meta"] = json!({ "io.modelcontextprotocol/related-task": { "taskId": task_id } });
                return result(id, answer);
            }
            entry.changed.clone()
        };
        tokio::select! {
            () = changed.notified() => {}
            () = tokio::time::sleep(Duration::from_millis(TASK_POLL_MS)) => {}
            () = cancel.cancelled() => return mcp_error(id, -32603, crate::tools::ABORTED),
        }
    }
}
