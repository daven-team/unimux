//! The pieces of src/shared the automation service uses, over the state as JSON: the task model (shared/automation.ts
//! `isClosedTask`, `projectCount`, `pruneAutomation` with room, `taskPrompt`), the grid edits of shared/state.ts (`addTab`,
//! `closeTab`, `updateCell`, `setActiveTab`, `upsert*`, `CELL_COLORS`, `nextCellColor`, `cellCwd`), `layoutFromRows`
//! (shared/layout.ts), `delegationRefusal` (shared/delegation.ts), the inbox notice of the prompt queue (shared/promptQueue.ts
//! `enqueuePrompt`, automation.ts `queueNotice`) and the runtime status mapping (shared/runtimeStatus.ts).

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};
use unimux_core::utf16;
use unimux_state::normalize::js::{self, truthy};

/// Tasks and messages kept per project (PROJECT_ITEM_LIMIT).
pub const PROJECT_ITEM_LIMIT: usize = 500;
/// Closed grids a project keeps (ARCHIVE_LIMIT).
pub const ARCHIVE_LIMIT: usize = 50;
/// Events the automation log keeps.
pub const EVENT_LIMIT: usize = 200;
/// Prompts a cell's queue holds (QUEUE_MAX_ITEMS) and the longest one (QUEUE_MAX_TEXT, UTF-16 units).
pub const QUEUE_MAX_ITEMS: usize = 50;
pub const QUEUE_MAX_TEXT: usize = 20_000;
/// Queue items of unimux notices carry this id prefix (NOTICE_PREFIX).
pub const NOTICE_PREFIX: &str = "unimux-";

/// Accent colors handed out to new cells, in order (CELL_COLORS).
pub const CELL_COLORS: [&str; 20] = [
    "#60a5fa", "#a78bfa", "#34d399", "#fbbf24", "#fb7185", "#22d3ee", "#c084fc", "#a3e635", "#818cf8", "#2dd4bf", "#f472b6",
    "#fb923c", "#38bdf8", "#4ade80", "#e879f9", "#facc15", "#93c5fd", "#6ee7b7", "#fda4af", "#d8b4fe",
];

/// `crypto.randomUUID()`.
pub fn uid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/// The array under `key` (empty for anything else).
pub fn list<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// A string field (None for a missing or non-string one).
pub fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

/// `v.id` as a string ('' when it is not one).
pub fn id(v: &Value) -> &str {
    text(v, "id").unwrap_or_default()
}

pub fn tasks(state: &Value) -> &[Value] {
    state.get("automation").map_or(&[], |a| list(a, "tasks"))
}

pub fn messages(state: &Value) -> &[Value] {
    state.get("automation").map_or(&[], |a| list(a, "messages"))
}

pub fn paused(state: &Value) -> bool {
    truthy(state.pointer("/automation/paused"))
}

/// `state.automation` as an object to edit (created with the defaults when missing).
pub fn automation_mut(state: &mut Value) -> &mut Map<String, Value> {
    if !state.get("automation").is_some_and(Value::is_object) {
        state["automation"] = json!({ "paused": false, "tasks": [], "messages": [], "events": [] });
    }
    let a = state["automation"].as_object_mut().expect("object");
    for key in ["tasks", "messages", "events"] {
        if !a.get(key).is_some_and(Value::is_array) {
            a.insert(key.into(), json!([]));
        }
    }
    a
}

/// `state.automation[key]` as a list to edit.
pub fn items_mut<'a>(state: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    automation_mut(state).get_mut(key).and_then(Value::as_array_mut).expect("array")
}

/// `isClosedTask`: completed or cancelled.
pub fn is_closed(task: &Value) -> bool {
    matches!(text(task, "status"), Some("completed" | "cancelled"))
}

/// `projectCount(items, projectId)`.
pub fn project_count(items: &[Value], project: &str) -> usize {
    items.iter().filter(|i| text(i, "projectId") == Some(project)).count()
}

/// The project ids of the state.
pub fn project_ids(state: &Value) -> Vec<String> {
    list(state, "projects").iter().map(|p| id(p).to_string()).collect()
}

/// `pruneAutomation(s.automation, projectIds, now, room)` applied to the state (AutomationService.makeRoom).
pub fn make_room(state: &mut Value, now: i64, tasks: Option<(&str, usize)>, messages: Option<(&str, usize)>) {
    let ids = project_ids(state);
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let mut automation = automation_mut(state).clone();
    let room_tasks: Vec<(&str, usize)> = tasks.into_iter().collect();
    let room_messages: Vec<(&str, usize)> = messages.into_iter().collect();
    // A null item made 1.1.4 throw a TypeError; the state then stays as it is (normalizeState never keeps one).
    if unimux_state::normalize::windows::prune_automation_room(&mut automation, &refs, now as f64, &room_tasks, &room_messages)
        .is_ok()
    {
        *automation_mut(state) = automation;
    }
}

/// AutomationService.log: one event at the end of the log (the last 200 kept).
pub fn log(state: &mut Value, project: &str, action: &str, detail: &str, cell: Option<&str>, now: i64) {
    let mut event = Map::new();
    event.insert("id".into(), json!(uid()));
    event.insert("projectId".into(), json!(project));
    event.insert("action".into(), json!(action));
    event.insert("detail".into(), json!(detail));
    if let Some(cell) = cell {
        event.insert("cellId".into(), json!(cell));
    }
    event.insert("createdAt".into(), json!(now));
    let events = items_mut(state, "events");
    events.push(Value::Object(event));
    if events.len() > EVENT_LIMIT {
        let cut = events.len() - EVENT_LIMIT;
        events.drain(..cut);
    }
}

// ── cells and grids ───────────────────────────────────────────────────────────

/// Where a cell is: indices of its project, tab and cell (findCell).
pub fn locate(state: &Value, cell: &str) -> Option<(usize, usize, usize)> {
    for (pi, project) in list(state, "projects").iter().enumerate() {
        for (ti, tab) in list(project, "tabs").iter().enumerate() {
            if let Some(ci) = list(tab, "cells").iter().position(|c| text(c, "id") == Some(cell)) {
                return Some((pi, ti, ci));
            }
        }
    }
    None
}

/// findCell as owned values (project, tab, cell).
pub fn find(state: &Value, cell: &str) -> Option<(Value, Value, Value)> {
    let (pi, ti, ci) = locate(state, cell)?;
    let project = &state["projects"][pi];
    let tab = &project["tabs"][ti];
    Some((project.clone(), tab.clone(), tab["cells"][ci].clone()))
}

/// getProfile(...).cli of a profile id (the shell profile, else the first, for an unknown one).
pub fn profile_cli(state: &Value, profile: Option<&Value>) -> Option<String> {
    crate::automation::profile(state, profile).and_then(|p| text(p, "cli")).map(str::to_string)
}

/// The cell is an agent MCP may name: no SSH cell, no shell profile.
pub fn is_agent_cell(state: &Value, cell: &Value) -> bool {
    !truthy(cell.get("ssh")) && profile_cli(state, cell.get("profileId")).as_deref() != Some("shell")
}

/// `cellCwd(project, cell)`: the worktree's folder, else the cell's own, else the project's (`??`).
pub fn cell_cwd(project: &Value, cell: &Value) -> Option<Value> {
    let some = |v: Option<&Value>| v.filter(|v| !v.is_null()).cloned();
    some(cell.get("worktree").and_then(|w| w.get("path"))).or_else(|| some(cell.get("dir"))).or_else(|| some(project.get("path")))
}

fn project_mut<'a>(state: &'a mut Value, project: &str) -> Option<&'a mut Map<String, Value>> {
    state
        .get_mut("projects")
        .and_then(Value::as_array_mut)?
        .iter_mut()
        .find(|p| text(p, "id") == Some(project))
        .and_then(Value::as_object_mut)
}

/// `nextCellColor(used)`: the first accent no cell uses yet; once all are taken the palette repeats.
pub fn next_cell_color(used: &[Option<String>]) -> String {
    let taken: HashSet<String> = used.iter().flatten().map(|c| c.to_lowercase()).collect();
    CELL_COLORS
        .iter()
        .find(|c| !taken.contains(**c))
        .map_or_else(|| CELL_COLORS[used.len() % CELL_COLORS.len()].to_string(), |c| c.to_string())
}

/// A cell spec of addTab (`CellInput`), as an object with the fields create_grid passes.
fn new_cell(spec: &Value, color: Option<String>) -> Value {
    let mut cell = Map::new();
    cell.insert("id".into(), json!(uid()));
    cell.insert("profileId".into(), spec.get("profileId").cloned().unwrap_or(Value::Null));
    let own = spec.get("color").filter(|c| !c.is_null()).cloned().or(color.map(Value::String));
    if truthy(own.as_ref()) {
        cell.insert("color".into(), own.unwrap());
    }
    for key in ["model", "role"] {
        if truthy(spec.get(key)) {
            cell.insert(key.into(), spec[key].clone());
        }
    }
    if let Some(name) = text(spec, "name").map(js::trim).filter(|n| !n.is_empty()) {
        cell.insert("name".into(), json!(name));
    }
    if text(spec, "startupPrompt").is_some_and(|p| !js::trim(p).is_empty()) {
        cell.insert("startupPrompt".into(), spec["startupPrompt"].clone());
    }
    for key in ["worktree", "session"] {
        if truthy(spec.get(key)) {
            cell.insert(key.into(), spec[key].clone());
        }
    }
    if let Some(ssh) = spec.get("ssh").filter(|s| truthy(Some(s))) {
        cell.insert("ssh".into(), json!({ "hostId": ssh.get("hostId").cloned().unwrap_or(Value::Null) }));
    }
    if truthy(spec.get("dir")) && !truthy(spec.get("ssh")) && !truthy(spec.get("worktree")) {
        cell.insert("dir".into(), spec["dir"].clone());
    }
    if truthy(spec.get("muted")) {
        cell.insert("muted".into(), json!(true));
    }
    Value::Object(cell)
}

fn next_tab_name(project: &Value) -> String {
    let used: HashSet<&str> =
        list(project, "tabs").iter().chain(list(project, "archive")).filter_map(|t| text(t, "name")).collect();
    (1..).map(|i| format!("Grid {i}")).find(|n| !used.contains(n.as_str())).expect("a free name")
}

/// `addTab(s, projectId, {name, color, layout, cells})`: the new tab becomes the project's active one. Answers the new tab's id
/// (None when the project does not exist; the state is unchanged then).
pub fn add_tab(
    state: &mut Value,
    project: &str,
    name: Option<&str>,
    color: Option<&str>,
    layout: Value,
    specs: &[Value],
) -> Option<String> {
    let count = layout.get("areas").and_then(Value::as_array).map_or(0, Vec::len);
    let p = project_mut(state, project)?;
    let mut cells: Vec<Value> = Vec::with_capacity(count);
    let shell = json!({ "profileId": "shell" });
    for i in 0..count {
        let spec = specs.get(i).or_else(|| specs.first()).unwrap_or(&shell);
        let color = if truthy(spec.get("color")) {
            None
        } else {
            Some(next_cell_color(&cells.iter().map(|c| text(c, "color").map(str::to_string)).collect::<Vec<_>>()))
        };
        cells.push(new_cell(spec, color));
    }
    let project_value = Value::Object(p.clone());
    let color = match color.filter(|c| !c.is_empty()) {
        Some(c) => c.to_string(),
        None => next_cell_color(
            &list(&project_value, "tabs").iter().map(|t| text(t, "color").map(str::to_string)).collect::<Vec<_>>(),
        ),
    };
    let name = name.map_or_else(|| next_tab_name(&project_value), str::to_string);
    let tab_id = uid();
    let tab = json!({ "id": tab_id, "color": color, "name": name, "layout": layout, "cells": cells });
    match p.get_mut("tabs").and_then(Value::as_array_mut) {
        Some(tabs) => tabs.push(tab),
        None => {
            p.insert("tabs".into(), json!([tab]));
        }
    }
    p.insert("activeTabId".into(), json!(tab_id));
    Some(tab_id)
}

/// `setActiveTab(s, projectId, tabId)`.
pub fn set_active_tab(state: &mut Value, project: &str, tab: Value) {
    if let Some(p) = project_mut(state, project) {
        p.insert("activeTabId".into(), tab);
    }
}

/// `closeTab(s, projectId, tabId)`: the grid goes to the top of the project's archive (50 kept).
pub fn close_tab(state: &mut Value, project: &str, tab: &str, now: i64) {
    let Some(p) = project_mut(state, project) else { return };
    let tabs = p.get("tabs").and_then(Value::as_array).cloned().unwrap_or_default();
    let Some(idx) = tabs.iter().position(|t| text(t, "id") == Some(tab)) else { return };
    let mut closed = tabs[idx].clone();
    let rest: Vec<Value> = tabs.into_iter().filter(|t| text(t, "id") != Some(tab)).collect();
    let active = if p.get("activeTabId").and_then(Value::as_str) == Some(tab) {
        Some(
            rest.get(idx.min(rest.len().saturating_sub(1))).filter(|_| !rest.is_empty()).map_or(Value::Null, |t| t["id"].clone()),
        )
    } else {
        p.get("activeTabId").cloned()
    };
    if let Some(o) = closed.as_object_mut() {
        o.insert("closedAt".into(), json!(now));
    }
    let mut archive = vec![closed];
    archive.extend(p.get("archive").and_then(Value::as_array).cloned().unwrap_or_default());
    archive.truncate(ARCHIVE_LIMIT);
    p.insert("tabs".into(), Value::Array(rest));
    match active {
        Some(v) => {
            p.insert("activeTabId".into(), v);
        }
        // `activeTabId: undefined` (JSON.stringify drops it).
        None => {
            p.shift_remove("activeTabId");
        }
    }
    p.insert("archive".into(), Value::Array(archive));
}

/// `updateCell(s, cellId, patch)`: `None` in the patch removes the field.
pub fn update_cell(state: &mut Value, cell: &str, patch: &[(&str, Option<Value>)]) {
    let Some((pi, ti, ci)) = locate(state, cell) else { return };
    let Some(c) = state["projects"][pi]["tabs"][ti]["cells"][ci].as_object_mut() else { return };
    for (key, value) in patch {
        match value {
            Some(v) => {
                c.insert((*key).to_string(), v.clone());
            }
            None => {
                c.shift_remove(*key);
            }
        }
    }
}

/// `upsert(list, item)` of `state[key]` (presets, snippets): replaced in place, else appended.
pub fn upsert(state: &mut Value, key: &str, item: Value) {
    if !state.get(key).is_some_and(Value::is_array) {
        state[key] = json!([]);
    }
    let items = state[key].as_array_mut().expect("array");
    let item_id = item.get("id").cloned();
    match items.iter_mut().find(|x| x.get("id") == item_id.as_ref()) {
        Some(slot) => *slot = item,
        None => items.push(item),
    }
}

// ── layouts ───────────────────────────────────────────────────────────────────

const MAX_COLS: i64 = 5;
const MAX_ROWS: usize = 4;

fn create_layout(cols: i64, rows: usize) -> Value {
    let mut areas = Vec::new();
    for row in 0..rows {
        for col in 0..cols {
            areas.push(json!({ "col": col, "row": row, "colSpan": 1, "rowSpan": 1 }));
        }
    }
    json!({ "cols": cols, "rows": rows, "areas": areas })
}

fn gcd(a: i64, b: i64) -> i64 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// `layoutFromRows(counts)`: each row gets its own number of equally wide cells, e.g. [3, 2].
pub fn layout_from_rows(counts: &[i64]) -> Value {
    let rows: Vec<i64> = counts.iter().map(|n| (*n).clamp(1, MAX_COLS)).take(MAX_ROWS).collect();
    if rows.is_empty() {
        return create_layout(1, 1);
    }
    if rows.iter().all(|n| *n == rows[0]) {
        return create_layout(rows[0], rows.len());
    }
    let cols = rows.iter().fold(1, |a, b| a * b / gcd(a, *b));
    let mut areas = Vec::new();
    for (row, n) in rows.iter().enumerate() {
        for i in 0..*n {
            areas.push(json!({ "col": i * (cols / n), "row": row, "colSpan": cols / n, "rowSpan": 1 }));
        }
    }
    json!({ "cols": cols, "rows": rows.len(), "areas": areas, "rowCounts": rows })
}

/// `layoutForCount(n)`.
pub fn layout_for_count(n: usize) -> Value {
    unimux_state::normalize::grid::layout_for_count(n as f64)
}

// ── tasks ─────────────────────────────────────────────────────────────────────

/// Tasks by id, for the dependency checks of a listing.
pub struct TaskIndex<'a>(HashMap<&'a str, &'a Value>);

impl<'a> TaskIndex<'a> {
    pub fn new(tasks: &'a [Value]) -> Self {
        let mut map = HashMap::with_capacity(tasks.len());
        for t in tasks {
            // A Map built from entries keeps the last one of a repeated id.
            map.insert(id(t), t);
        }
        Self(map)
    }

    /// AutomationService.blockedBy: the prerequisites that are missing, of another project or not completed.
    pub fn blocked_by(&self, task: &Value) -> Vec<String> {
        list(task, "dependsOn")
            .iter()
            .filter(|d| {
                let prerequisite = d.as_str().and_then(|d| self.0.get(d));
                prerequisite.is_none_or(|p| p.get("projectId") != task.get("projectId") || text(p, "status") != Some("completed"))
            })
            .map(|d| js::to_string(Some(d)))
            .collect()
    }

    /// AutomationService.listed: the task with what still blocks it and whether it can be claimed.
    pub fn listed(&self, task: &Value) -> Value {
        let blocked = self.blocked_by(task);
        let ready = text(task, "status") == Some("queued") && blocked.is_empty();
        let mut out = task.as_object().cloned().unwrap_or_default();
        out.insert("blockedBy".into(), json!(blocked));
        out.insert("ready".into(), json!(ready));
        Value::Object(out)
    }
}

/// `taskPrompt(task)`: the startup prompt of a team agent's task.
pub fn task_prompt(task: &Value) -> String {
    format!(
        "[Unimux task {}] {}\n\n{}\n\nUnimux MCP: update_task in_progress before working; finish with completed (result: summary, files, tests, branch/commit) or blocked (blockedReason). read_inbox for new tasks and messages; wait_for instead of polling. Claim a task only after its dependsOn tasks completed. Do not create agents unless explicitly asked.",
        js::to_string(task.get("id")),
        js::to_string(task.get("title")),
        js::to_string(task.get("prompt")),
    )
}

/// `waitingPrompt(task)`: the startup prompt of an agent whose task waits for other tasks (create_grid after).
pub fn waiting_prompt(task: &Value) -> String {
    let deps: Vec<String> = list(task, "dependsOn").iter().map(|d| js::to_string(Some(d))).collect();
    format!(
        "[Unimux] Your task {} \"{}\" starts after tasks {} complete. Do not start it and do not poll: unimux will tell you here when it is ready (then read_inbox). Reply only \"waiting\" now.",
        js::to_string(task.get("id")),
        js::to_string(task.get("title")),
        deps.join(", "),
    )
}

/// `waitMaxFor(cli)`: the longest bounded wait of a caller's CLI.
pub fn wait_max_for(cli: Option<&str>) -> u64 {
    match cli {
        Some("claude") => crate::catalog::WAIT_MAX_CLAUDE as u64,
        Some("codex") => crate::catalog::WAIT_MAX_CODEX as u64,
        _ => crate::catalog::WAIT_MAX_SECONDS as u64,
    }
}

/// `delegationRefusal(state, coordinatorId, {newAgents, taskCellId})`: why a coordinator's call would go over the team limit.
pub fn delegation_refusal(state: &Value, coordinator: &str, new_agents: usize, task_cell: Option<&str>) -> Option<String> {
    let delegation =
        unimux_state::normalize::settings::normalize_delegation(state.get("settings").and_then(|s| s.get("delegation")));
    let limit = delegation.get("maxAgents").and_then(Value::as_f64).unwrap_or(4.0) as usize;
    let mut busy: Vec<&str> = Vec::new();
    for t in tasks(state) {
        let cell = text(t, "cellId").unwrap_or_default();
        if text(t, "fromCellId") == Some(coordinator) && cell != coordinator && !is_closed(t) && !busy.contains(&cell) {
            busy.push(cell);
        }
    }
    let mut total = busy.len() + new_agents;
    if let Some(cell) = task_cell
        && cell != coordinator
        && !busy.contains(&cell)
    {
        total += 1;
    }
    (total > limit).then(|| {
        format!(
            "Team limit: at most {limit} agents at once (the user's setting in Settings > Agents). {} already hold open tasks from you. Wait for them (wait_for) or give the work to agents you already use, or do it yourself.",
            busy.len()
        )
    })
}

// ── the prompt queue notice ───────────────────────────────────────────────────

fn settle(items: Vec<Value>, paused: Option<&Value>) -> Option<Value> {
    if items.is_empty() {
        return None;
    }
    Some(match paused.filter(|p| truthy(Some(p))) {
        Some(p) => json!({ "items": items, "paused": p }),
        None => json!({ "items": items }),
    })
}

/// `enqueuePrompt(queue, text, id, auto)`: appends a prompt (a blank text and a full queue change nothing).
pub fn enqueue_prompt(queue: Option<&Value>, text: &str, item_id: &str, auto: bool) -> Option<Value> {
    let items = queue.map(|q| list(q, "items").to_vec()).unwrap_or_default();
    if js::trim(text).is_empty() || items.len() >= QUEUE_MAX_ITEMS {
        return queue.cloned();
    }
    let mut item = json!({ "id": item_id, "text": utf16::slice(text, 0, QUEUE_MAX_TEXT) });
    if auto {
        item["auto"] = json!(true);
    }
    let mut next = items;
    next.push(item);
    settle(next, queue.and_then(|q| q.get("paused")))
}

/// automation.ts `queueNotice`: adds an inbox notice to a cell's prompt queue; a notice that has not gone out yet is merged
/// with the new one, so a burst of tasks costs the agent one turn.
pub fn queue_notice(queue: Option<&Value>, notice: &str, item_id: &str) -> Option<Value> {
    let items = queue.map(|q| list(q, "items")).unwrap_or(&[]);
    let Some(pending) = items.iter().position(|i| id(i).starts_with(NOTICE_PREFIX)) else {
        return enqueue_prompt(queue, notice, &format!("{NOTICE_PREFIX}{item_id}"), true);
    };
    let strip = |t: &str| -> String {
        let t = t.strip_prefix("unimux: ").unwrap_or(t);
        t.strip_suffix(": read_inbox").unwrap_or(t).to_string()
    };
    let pending_text = text(&items[pending], "text").unwrap_or_default();
    let mut parts: Vec<String> = strip(pending_text).split("; ").map(str::to_string).collect();
    let next = if parts.len() >= 5 || pending_text.starts_with("unimux: several ") {
        "unimux: several new tasks and messages: read_inbox".to_string()
    } else {
        parts.push(strip(notice));
        format!("unimux: {}: read_inbox", parts.join("; "))
    };
    let mut q = queue.cloned().unwrap_or_else(|| json!({}));
    q["items"][pending]["text"] = json!(next);
    Some(q)
}

// ── runtime statuses ──────────────────────────────────────────────────────────

/// `automationStatusFor(status, reason, hooked, current)`: what the renderer's StatusTracker decided, as automation sees it
/// (None: keep what it has).
pub fn automation_status_for(status: &str, reason: Option<&str>, hooked: bool, current: Option<&str>) -> Option<&'static str> {
    match status {
        "working" => Some("working"),
        "waiting" if hooked => Some(if matches!(reason, Some("attention" | "error")) { "needs_attention" } else { "ready" }),
        "waiting" => (!matches!(current, Some("ready" | "exited"))).then_some("needs_attention"),
        "idle" => (!matches!(current, Some("ready" | "exited"))).then_some("unknown"),
        _ => None,
    }
}

/// `automationHintForHook(event)`: the immediate status hint of a hook event.
pub fn automation_hint_for_hook(event: &str) -> Option<&'static str> {
    match event {
        "prompt" | "stopbg" => Some("working"),
        "stop" => Some("ready"),
        "notify" | "fail" => Some("needs_attention"),
        _ => None,
    }
}

/// `CLI_NAMES[cli]`.
pub fn cli_name(cli: &str) -> &str {
    match cli {
        "claude" => "Claude Code",
        "codex" => "Codex",
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notices_merge_until_five_then_say_several() {
        let mut queue = queue_notice(None, "unimux: new task t1 \"A\" from Lead: read_inbox", "a");
        queue = queue_notice(queue.as_ref(), "unimux: new message m1 from Lead: read_inbox", "b");
        assert_eq!(
            queue,
            Some(
                json!({ "items": [{ "id": "unimux-a", "text": "unimux: new task t1 \"A\" from Lead; new message m1 from Lead: read_inbox", "auto": true }] })
            )
        );
        for i in 0..6 {
            queue = queue_notice(queue.as_ref(), &format!("unimux: new message m{i} from Lead: read_inbox"), &format!("x{i}"));
        }
        let q = queue.unwrap();
        assert_eq!(list(&q, "items").len(), 1);
        assert_eq!(q["items"][0]["text"], "unimux: several new tasks and messages: read_inbox");
    }

    #[test]
    fn a_full_queue_or_a_blank_text_changes_nothing() {
        let items: Vec<Value> = (0..QUEUE_MAX_ITEMS).map(|i| json!({ "id": format!("u{i}"), "text": "x" })).collect();
        let full = json!({ "items": items, "paused": "user" });
        assert_eq!(enqueue_prompt(Some(&full), "more", "n", true), Some(full.clone()));
        assert_eq!(enqueue_prompt(None, "  ", "n", false), None);
        let one = enqueue_prompt(Some(&json!({ "items": [], "paused": "user" })), "hi", "n", false).unwrap();
        assert_eq!(one, json!({ "items": [{ "id": "n", "text": "hi" }], "paused": "user" }));
    }

    #[test]
    fn rows_layouts_use_the_lcm_of_the_row_sizes() {
        assert_eq!(layout_from_rows(&[2, 2]), create_layout(2, 2));
        let l = layout_from_rows(&[2, 1]);
        assert_eq!(l["cols"], 2);
        assert_eq!(l["rowCounts"], json!([2, 1]));
        assert_eq!(l["areas"][2], json!({ "col": 0, "row": 1, "colSpan": 2, "rowSpan": 1 }));
        let l = layout_from_rows(&[3, 2]);
        assert_eq!(l["cols"], 6);
        assert_eq!(list(&l, "areas").len(), 5);
    }

    #[test]
    fn statuses_follow_the_tracker_and_hooks() {
        assert_eq!(automation_status_for("waiting", Some("attention"), true, None), Some("needs_attention"));
        assert_eq!(automation_status_for("waiting", None, true, None), Some("ready"));
        assert_eq!(automation_status_for("waiting", None, false, Some("ready")), None);
        assert_eq!(automation_status_for("idle", None, false, Some("exited")), None);
        assert_eq!(automation_status_for("idle", None, false, Some("working")), Some("unknown"));
        assert_eq!(automation_hint_for_hook("stop"), Some("ready"));
        assert_eq!(automation_hint_for_hook("tool"), None);
    }

    #[test]
    fn close_tab_archives_and_picks_the_next_active_tab() {
        let mut s =
            json!({ "projects": [{ "id": "p", "tabs": [{ "id": "a" }, { "id": "b" }], "activeTabId": "b", "archive": [] }] });
        close_tab(&mut s, "p", "b", 5);
        assert_eq!(s["projects"][0]["activeTabId"], "a");
        assert_eq!(s["projects"][0]["archive"][0], json!({ "id": "b", "closedAt": 5 }));
        close_tab(&mut s, "p", "a", 6);
        assert_eq!(s["projects"][0]["activeTabId"], Value::Null);
    }

    #[test]
    fn the_team_limit_counts_busy_agents() {
        let s = json!({ "settings": { "delegation": { "mode": "auto", "maxAgents": 1 } }, "automation": { "tasks": [
            { "id": "t", "cellId": "w1", "fromCellId": "lead", "status": "queued" }] } });
        assert!(delegation_refusal(&s, "lead", 0, Some("w1")).is_none());
        assert!(delegation_refusal(&s, "lead", 0, Some("w2")).unwrap().starts_with("Team limit: at most 1 agents"));
        assert!(delegation_refusal(&s, "lead", 0, Some("lead")).is_none());
    }

    // team-start "teamLimit and delegationRefusal count the agents with open tasks from the coordinator", "stays exited while
    // the shell idles, until the agent works again"
    #[test]
    fn the_team_limit_counts_open_tasks_of_the_coordinator_and_exited_stays_until_work() {
        let t = |id: &str, cell: &str, status: &str, from: &str| json!({ "id": id, "cellId": cell, "fromCellId": from, "status": status });
        let mut s = json!({ "settings": { "delegation": { "mode": "auto", "maxAgents": 2 } }, "automation": { "tasks": [
            t("a", "w1", "in_progress", "lead"), t("b", "w1", "queued", "lead"), t("c", "w9", "completed", "lead"),
            t("d", "w5", "queued", "other")] } });
        assert!(delegation_refusal(&s, "lead", 0, Some("w1")).is_none());
        assert!(delegation_refusal(&s, "lead", 0, Some("w2")).is_none());
        assert!(delegation_refusal(&s, "lead", 1, None).is_none());
        assert!(delegation_refusal(&s, "lead", 2, None).unwrap().contains("at most 2 agents"));
        s["automation"]["tasks"].as_array_mut().unwrap().push(t("e", "w2", "queued", "lead"));
        assert!(delegation_refusal(&s, "lead", 0, Some("w3")).unwrap().starts_with("Team limit"));

        assert_eq!(automation_status_for("idle", None, false, Some("exited")), None);
        assert_eq!(automation_status_for("waiting", Some("done"), false, Some("exited")), None);
        assert_eq!(automation_status_for("working", None, true, Some("exited")), Some("working"));
    }
}
