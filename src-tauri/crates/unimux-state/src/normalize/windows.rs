//! The strip order (shared/workspaceOrder.ts `normalizeWorkspaceOrder`), detached windows (shared/detached.ts
//! `normalizeDetachedWindows`) and the retention of the MCP inboxes (shared/automation.ts `pruneAutomation`).

use super::js::{self, Js, Throw};
use super::remote::valid_remote_path;
use super::timsort;
use serde_json::{Map, Value, json};

/// `normalizeWorkspaceOrder(raw, gridIds)`: None (absent stays absent) or the repaired list.
pub fn normalize_workspace_order(raw: Option<&Value>, grid_ids: &[&str]) -> Option<Value> {
    let raw = raw?;
    let Some(list) = raw.as_array() else { return Some(json!([])) };
    let mut seen: Vec<&str> = Vec::new();
    let mut out = Vec::new();
    for key in list {
        let Some(k) = key.as_str() else { continue };
        if js::len16(k) > 4096 || seen.contains(&k) {
            continue;
        }
        let ok = k == "settings"
            || (k.starts_with("grid:") && grid_ids.contains(&&k[5..]))
            || (k.starts_with("file:") && js::len16(k) > 5);
        if !ok {
            continue;
        }
        seen.push(k);
        out.push(Value::from(k));
        if out.len() >= 1000 {
            break;
        }
    }
    Some(Value::Array(out))
}

fn is_id(v: Option<&Value>) -> bool {
    js::string(v).is_some_and(|s| (1..=128).contains(&js::len16(s)))
}

pub(crate) fn is_text(v: Option<&Value>) -> bool {
    js::string(v).is_some_and(|s| (1..=4096).contains(&js::len16(s)))
}

fn clean_rect(raw: Option<&Value>) -> Option<Value> {
    let r = js::record(raw)?;
    let n = |k: &str| js::number(r.get(k));
    let (x, y, w, h) = (n("x")?, n("y")?, n("width")?, n("height")?);
    if w < 1.0 || h < 1.0 || x.abs() > 1e6 || y.abs() > 1e6 || w > 1e5 || h > 1e5 {
        return None;
    }
    Some(
        json!({"x": js::num(js::round(x)), "y": js::num(js::round(y)), "width": js::num(js::round(w)), "height": js::num(js::round(h))}),
    )
}

fn ok_name(v: Option<&Value>) -> bool {
    js::string(v).is_some_and(|s| (1..=1024).contains(&js::len16(s)) && !s.contains('\0'))
}

const OBJECT_KINDS: [&str; 11] =
    ["table", "partitioned", "view", "matview", "foreign", "sequence", "function", "procedure", "trigger", "event", "index"];

/// `validDbTabRef` (shared/dbTabs.ts).
fn valid_db_tab_ref(v: Option<&Value>) -> bool {
    if !js::object_like(v) {
        return false;
    }
    let g = |k: &str| js::get(v, k);
    if !js::is_uuid(g("connectionId")) || !(js::string(g("database")) == Some("") || ok_name(g("database"))) {
        return false;
    }
    let kind_of = js::string(g("objectKind")).filter(|k| OBJECT_KINDS.contains(k));
    match js::string(g("kind")) {
        Some("sql") => js::is_uuid(g("uid")),
        Some("table") => {
            ok_name(g("schema"))
                && ok_name(g("table"))
                && kind_of.is_some_and(|k| ["table", "partitioned", "view", "matview", "foreign"].contains(&k))
        }
        Some("ddl") => {
            ok_name(g("schema"))
                && ok_name(g("name"))
                && kind_of.is_some()
                && match g("args") {
                    None => true,
                    Some(a) => a.as_str().is_some_and(|s| js::len16(s) <= 8192),
                }
        }
        _ => false,
    }
}

/// `validRedisTabRef` (shared/redisView.ts).
fn valid_redis_tab_ref(v: Option<&Value>) -> bool {
    if !js::object_like(v) {
        return false;
    }
    let g = |k: &str| js::get(v, k);
    js::string(g("kind")) == Some("redis")
        && js::string(g("view")).is_some_and(|s| ["keys", "console", "pubsub", "info"].contains(&s))
        && js::is_uuid(g("connectionId"))
        && js::is_uuid(g("uid"))
        && js::integer(g("db")).is_some_and(|d| (0.0..=10_000.0).contains(&d))
}

fn clean_reopen(raw: Option<&Value>) -> Option<Value> {
    let r = js::record(raw)?;
    let g = |k: &str| r.get(k);
    let kind = js::string(g("kind"));
    if kind == Some("project") && is_id(g("projectId")) && is_text(g("relativePath")) {
        return Some(json!({"kind": "project", "projectId": g("projectId"), "relativePath": g("relativePath")}));
    }
    if kind == Some("local") && is_text(g("path")) {
        return Some(json!({"kind": "local", "path": g("path")}));
    }
    if kind == Some("remote") && js::is_uuid(g("hostId")) && valid_remote_path(g("path")) {
        return Some(json!({"kind": "remote", "hostId": g("hostId"), "path": g("path")}));
    }
    if kind == Some("db") && valid_db_tab_ref(g("ref")) && is_text(g("path")) {
        return Some(json!({"kind": "db", "ref": g("ref"), "path": g("path")}));
    }
    if kind == Some("redis") && valid_redis_tab_ref(g("ref")) && is_text(g("path")) {
        return Some(json!({"kind": "redis", "ref": g("ref"), "path": g("path")}));
    }
    if kind == Some("diff") && is_id(g("projectId")) {
        let d = js::record(g("diff"))?;
        if !is_text(d.get("path"))
            || !js::string(d.get("source")).is_some_and(|s| ["working", "staged", "commit", "untracked"].contains(&s))
        {
            return None;
        }
        let mut diff = Map::new();
        diff.insert("source".into(), d["source"].clone());
        diff.insert("path".into(), d["path"].clone());
        for k in ["oldPath", "hash", "worktree"] {
            if is_text(d.get(k)) {
                diff.insert(k.into(), d[k].clone());
            }
        }
        return Some(json!({"kind": "diff", "projectId": g("projectId"), "diff": Value::Object(diff)}));
    }
    None
}

/// `cleanTarget`.
pub fn clean_target(raw: Option<&Value>) -> Option<Value> {
    let r = js::record(raw)?;
    let g = |k: &str| r.get(k);
    match js::string(g("kind")) {
        Some("grid") if is_id(g("projectId")) && is_id(g("tabId")) => {
            Some(json!({"kind": "grid", "projectId": g("projectId"), "tabId": g("tabId")}))
        }
        Some("file")
            if is_text(g("fileId")) && js::string(g("projectId")).is_some_and(|p| js::len16(p) <= 128) && is_text(g("name")) =>
        {
            let reopen = clean_reopen(g("reopen"))?;
            Some(json!({"kind": "file", "fileId": g("fileId"), "projectId": g("projectId"), "name": g("name"), "reopen": reopen}))
        }
        _ => None,
    }
}

/// `openGrids(projects)`: tab id -> project id of every open grid (a later tab with the same id wins, like `new Map`).
pub fn open_grids(projects: &[Value]) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = Vec::new();
    for p in projects {
        let pid = p.get("id").cloned().unwrap_or(Value::Null);
        for t in p.get("tabs").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default() {
            // Map keys are compared with SameValueZero: only string tab ids can match a target's tab id.
            let Some(id) = t.get("id").and_then(Value::as_str) else { continue };
            match out.iter_mut().find(|(k, _)| k == id) {
                Some(slot) => slot.1 = pid.clone(),
                None => out.push((id.to_string(), pid.clone())),
            }
        }
    }
    out
}

/// `normalizeDetachedWindows(raw, grids)`: known shapes, one window per tab, open grids only, at most 8; None when empty.
pub fn normalize_detached_windows(raw: Option<&Value>, grids: &[(String, Value)]) -> Option<Value> {
    let list = raw?.as_array()?;
    let mut out = Vec::new();
    let mut ids: Vec<&str> = Vec::new();
    let mut targets: Vec<String> = Vec::new();
    for item in list {
        let Some(o) = item.as_object() else { continue };
        if !is_id(o.get("id")) {
            continue;
        }
        let id = o["id"].as_str().unwrap_or_default();
        if ids.contains(&id) {
            continue;
        }
        let Some(mut target) = clean_target(o.get("target")) else { continue };
        if target["kind"] == "grid" {
            let tab = target["tabId"].as_str().unwrap_or_default();
            let Some((_, project)) = grids.iter().find(|(k, _)| k == tab) else { continue };
            if !js::truthy(Some(project)) {
                continue;
            }
            if !js::strict_eq(Some(project), target.get("projectId")) {
                target["projectId"] = project.clone();
            }
        }
        let key = if target["kind"] == "grid" {
            format!("grid:{}", target["tabId"].as_str().unwrap_or_default())
        } else {
            format!("file:{}", target["fileId"].as_str().unwrap_or_default())
        };
        if targets.contains(&key) {
            continue;
        }
        let mut w = Map::new();
        w.insert("id".into(), o["id"].clone());
        w.insert("target".into(), target);
        if let Some(b) = clean_rect(o.get("bounds")) {
            w.insert("bounds".into(), b);
        }
        if js::number(o.get("displayId")).is_some() {
            w.insert("displayId".into(), o["displayId"].clone());
        }
        if js::is_true(o.get("maximized")) {
            w.insert("maximized".into(), Value::Bool(true));
        }
        out.push(Value::Object(w));
        ids.push(id);
        targets.push(key);
        if out.len() >= 8 {
            break;
        }
    }
    (!out.is_empty()).then_some(Value::Array(out))
}

const RETENTION_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;
const PROJECT_ITEM_LIMIT: f64 = 500.0;

fn is_closed_task(task: &Value) -> Js<bool> {
    if task.is_null() {
        return Err(Throw);
    }
    Ok(js::string(js::get(Some(task), "status")).is_some_and(|s| s == "completed" || s == "cancelled"))
}

/// `pruneAutomation(automation, projectIds, now)` with no room reserved. Items of removed projects go; per project, closed
/// tasks and read messages older than 7 days go, and beyond 500 the oldest finished ones. Throws like the TS code on a null item.
pub fn prune_automation(automation: &mut Map<String, Value>, project_ids: &[&str], now: f64) -> Js<()> {
    prune_automation_room(automation, project_ids, now, &[], &[])
}

/// `pruneAutomation(automation, projectIds, now, room)`: as [`prune_automation`], keeping `room` places free per project for
/// items about to be added (`room.tasks` / `room.messages`, `{[projectId]: n}`), as the automation service does on every insert.
pub fn prune_automation_room(
    automation: &mut Map<String, Value>,
    project_ids: &[&str],
    now: f64,
    room_tasks: &[(&str, usize)],
    room_messages: &[(&str, usize)],
) -> Js<()> {
    let tasks = automation.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default();
    let messages = automation.get("messages").and_then(Value::as_array).cloned().unwrap_or_default();
    let events = automation.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut needed: Vec<Value> = Vec::new();
    for task in &tasks {
        if is_closed_task(task)? {
            continue;
        }
        match js::get(Some(task), "dependsOn") {
            None | Some(Value::Null) => {}
            Some(Value::Array(ids)) => needed.extend(ids.iter().cloned()),
            Some(Value::String(s)) => needed.extend(s.chars().map(|c| Value::from(c.to_string()))),
            Some(_) => return Err(Throw),
        }
    }
    let in_projects = |item: &Value| js::string(js::get(Some(item), "projectId")).is_some_and(|p| project_ids.contains(&p));
    let is_needed = |item: &Value| {
        let id = js::get(Some(item), "id");
        needed.iter().any(|n| !n.is_object() && !n.is_array() && js::strict_eq(Some(n), id))
    };
    let keep = |items: &[Value],
                finished: &dyn Fn(&Value) -> Js<bool>,
                finished_at: &dyn Fn(&Value) -> f64,
                free: &[(&str, usize)]|
     -> Js<Vec<Value>> {
        let mut by_project: Vec<(String, Vec<usize>)> = Vec::new();
        for (i, item) in items.iter().enumerate() {
            if item.is_null() {
                return Err(Throw);
            }
            if !in_projects(item) {
                continue;
            }
            let pid = js::string(js::get(Some(item), "projectId")).unwrap_or_default();
            match by_project.iter_mut().find(|(p, _)| p == pid) {
                Some(slot) => slot.1.push(i),
                None => by_project.push((pid.to_string(), vec![i])),
            }
        }
        let mut dropped: Vec<bool> = vec![false; items.len()];
        let mut dropped_count = 0usize;
        for (pid, list) in &by_project {
            let mut removable = Vec::new();
            for &i in list {
                if finished(&items[i])? && !is_needed(&items[i]) {
                    removable.push(i);
                }
            }
            for &i in &removable {
                if now - finished_at(&items[i]) > RETENTION_MS && !dropped[i] {
                    dropped[i] = true;
                    dropped_count += 1;
                }
            }
            // `free[projectId] ?? 0`: a name Object.prototype has (and the object lacks) gives NaN, so nothing more is dropped.
            let reserved = match free.iter().find(|(p, _)| p == pid) {
                Some((_, n)) => *n as f64,
                None if js::is_proto_key(pid) => continue,
                None => 0.0,
            };
            let mut over = list.len() as f64 - dropped_count as f64 - (PROJECT_ITEM_LIMIT - reserved);
            if over > 0.0 {
                let mut sorted = removable.clone();
                // `[...removable].sort((a, b) => finishedAt(a) - finishedAt(b))`: a damaged timestamp makes the comparator
                // inconsistent (NaN), so this follows V8's TimSort to keep the order 1.1.4 keeps (and never panics).
                timsort::sort_by(&mut sorted, |a, b| finished_at(&items[*a]) - finished_at(&items[*b]));
                for i in sorted {
                    if over <= 0.0 {
                        break;
                    }
                    if dropped[i] {
                        continue;
                    }
                    dropped[i] = true;
                    dropped_count += 1;
                    over -= 1.0;
                }
            }
        }
        Ok(items.iter().enumerate().filter(|(i, item)| in_projects(item) && !dropped[*i]).map(|(_, v)| v.clone()).collect())
    };
    let tasks = keep(&tasks, &|t| is_closed_task(t), &|t| js::to_number(js::get(Some(t), "updatedAt")), room_tasks)?;
    let messages = keep(
        &messages,
        &|m| Ok(js::get(Some(m), "readAt").is_some()),
        &|m| match js::get(Some(m), "readAt") {
            None | Some(Value::Null) => js::to_number(js::get(Some(m), "createdAt")),
            read => js::to_number(read),
        },
        room_messages,
    )?;
    if events.iter().any(Value::is_null) {
        return Err(Throw);
    }
    let events: Vec<Value> = events.into_iter().filter(|e| in_projects(e)).collect();
    automation.insert("tasks".into(), Value::Array(tasks));
    automation.insert("messages".into(), Value::Array(messages));
    automation.insert("events".into(), Value::Array(events));
    Ok(())
}
