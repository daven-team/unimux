//! The first prompt of an AI team agent (port of src/shared/teamPrompts.ts and `taskPrompt` of src/shared/automation.ts),
//! built from the inbox at every start: a NEW conversation gets the tasks it has not claimed, a conversation the user resumes
//! by hand gets a short "continue" note. Tasks are the `automation.tasks` objects of the state.

use serde_json::Value;
use unimux_core::utf16::{js_trim, js_trim_start};

/// `${value}` of a JavaScript template literal for the task fields (strings as they are).
fn text(task: &Value, key: &str) -> String {
    match task.get(key) {
        None => "undefined".into(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Null) => "null".into(),
        Some(Value::Number(n)) => unimux_core::js_json::number_text(n),
        Some(Value::Bool(b)) => b.to_string(),
        Some(_) => "[object Object]".into(),
    }
}

fn is(task: &Value, key: &str, value: &str) -> bool {
    task.get(key).and_then(Value::as_str) == Some(value)
}

/// `isClosedTask`: completed or cancelled.
pub fn is_closed_task(task: &Value) -> bool {
    is(task, "status", "completed") || is(task, "status", "cancelled")
}

/// `taskPrompt(task)`: the prompt create_grid / create_task give an agent for one task.
pub fn task_prompt(task: &Value) -> String {
    format!(
        "[Unimux task {}] {}\n\n{}\n\nUnimux MCP: update_task in_progress before working; finish with completed (result: summary, files, tests, branch/commit) or blocked (blockedReason). read_inbox for new tasks and messages; wait_for instead of polling. Claim a task only after its dependsOn tasks completed. Do not create agents unless explicitly asked.",
        text(task, "id"),
        text(task, "title"),
        text(task, "prompt")
    )
}

fn own<'a>(tasks: &'a [Value], cell: &str, status: &str) -> Vec<&'a Value> {
    tasks.iter().filter(|t| is(t, "cellId", cell) && is(t, "status", status)).collect()
}

fn line(t: &Value) -> String {
    format!("- {}: {}", text(t, "id"), text(t, "title"))
}

/// `readyStartupTasks`: queued tasks of the cell whose prerequisites (dependsOn) all completed.
pub fn ready_startup_tasks<'a>(tasks: &'a [Value], cell: &str) -> Vec<&'a Value> {
    let done: Vec<&Value> = tasks.iter().filter(|t| is(t, "status", "completed")).filter_map(|t| t.get("id")).collect();
    own(tasks, cell, "queued")
        .into_iter()
        .filter(|t| match t.get("dependsOn") {
            Some(Value::Array(ids)) => ids.iter().all(|id| done.contains(&id)),
            _ => true,
        })
        .collect()
}

/// `startupTaskPrompt(tasks, cellId, role, fallback)`: the prompt a role cell's NEW conversation starts with. `fallback` is
/// the cell's stored startupPrompt (a plain text goes first; a copy of a task prompt is replaced by the inbox).
pub fn startup_task_prompt(tasks: &[Value], cell: &str, role: &str, fallback: Option<&str>) -> Option<String> {
    let queued = ready_startup_tasks(tasks, cell);
    let claimed = own(tasks, cell, "in_progress");
    let has_fallback = fallback.is_some_and(|f| !js_trim(f).is_empty());
    let plain = fallback
        .filter(|f| !js_trim(f).is_empty() && !js_trim_start(f).starts_with("[Unimux task "))
        .map(|f| js_trim(f).to_string());
    if queued.is_empty() && claimed.is_empty() {
        return if has_fallback { fallback.map(str::to_string) } else { None };
    }
    let body = if queued.len() == 1 && claimed.is_empty() {
        task_prompt(queued[0])
    } else {
        let mut parts = vec![format!("[Unimux tasks] You have {} open tasks in unimux.", queued.len() + claimed.len())];
        if !queued.is_empty() {
            parts.push(format!("New tasks:\n{}", queued.iter().map(|t| line(t)).collect::<Vec<_>>().join("\n")));
        }
        if !claimed.is_empty() {
            parts.push(format!(
                "Tasks you had already started (in_progress) before this agent started again; continue them:\n{}",
                claimed.iter().map(|t| line(t)).collect::<Vec<_>>().join("\n")
            ));
        }
        parts.push(format!(
            "Unimux MCP: call read_inbox to read each task prompt, then work through them: update_task in_progress before working on a new one; finish each with completed (result: summary, files, tests, branch/commit) or blocked (blockedReason). Claim a task only after its dependsOn tasks completed. {}",
            if role == "coordinator" { "Follow your delegation rules." } else { "Do not create agents unless explicitly asked." }
        ));
        parts.join("\n\n")
    };
    Some(match plain {
        Some(p) => format!("{p}\n\n{body}"),
        None => body,
    })
}

/// `resumeTaskPrompt(tasks, cellId, role)`: the note a RESUMED conversation gets when the user restarted the agent: its
/// open tasks, and for a coordinator the open tasks it gave others. None when nothing is open.
pub fn resume_task_prompt(tasks: &[Value], cell: &str, role: &str) -> Option<String> {
    let mine: Vec<&Value> =
        tasks.iter().filter(|t| is(t, "cellId", cell) && (is(t, "status", "queued") || is(t, "status", "in_progress"))).collect();
    let waiting: Vec<&Value> = if role == "coordinator" {
        tasks.iter().filter(|t| is(t, "fromCellId", cell) && !is(t, "cellId", cell) && !is_closed_task(t)).collect()
    } else {
        Vec::new()
    };
    if mine.is_empty() && waiting.is_empty() {
        return None;
    }
    let mut parts = vec!["unimux: this agent was restarted and the conversation resumed.".to_string()];
    if !mine.is_empty() {
        let list: Vec<String> =
            mine.iter().map(|t| format!("{} {} ({})", text(t, "id"), text(t, "title"), text(t, "status"))).collect();
        parts.push(format!("Your open tasks: {}. Continue them (read_inbox shows them).", list.join("; ")));
    }
    if !waiting.is_empty() {
        let ids: Vec<String> = waiting.iter().map(|t| text(t, "id")).collect();
        parts.push(format!("You were waiting for tasks {}: call wait_for with these taskIds.", ids.join(", ")));
    }
    Some(parts.join(" "))
}

/// The ids of the tasks a new start hands over in its startup prompt (`readyStartupTasks(...).filter(delivery ===
/// 'pending')`); they count as delivered there.
pub fn handed_over_ids(tasks: &[Value], cell: &str) -> Vec<String> {
    ready_startup_tasks(tasks, cell)
        .into_iter()
        .filter(|t| is(t, "delivery", "pending"))
        .filter_map(|t| t.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// The state with `delivery: 'startup'` on the given tasks (index.ts cell:spawn `controller.change`); None when no task
/// changes.
pub fn mark_startup_delivery(state: &Value, ids: &[String]) -> Option<Value> {
    let tasks = state.get("automation")?.get("tasks")?.as_array()?;
    if !tasks.iter().any(|t| t.get("id").and_then(Value::as_str).is_some_and(|id| ids.iter().any(|i| i == id))) {
        return None;
    }
    let mut next = state.clone();
    for task in next.get_mut("automation")?.get_mut("tasks")?.as_array_mut()? {
        let handed = task.get("id").and_then(Value::as_str).is_some_and(|id| ids.iter().any(|i| i == id));
        if handed && let Some(obj) = task.as_object_mut() {
            obj.insert("delivery".into(), Value::String("startup".into()));
        }
    }
    Some(next)
}
