//! `defaultState`, `normalizeState` (src/shared/state.ts) and the normalization of a renderer edit
//! (src/main/stateController.ts `normalizeEditedState`), on `serde_json::Value` with JavaScript semantics.

use super::Platform;
use super::grid::{self, MAX_CELLS};
use super::js::{self, Js, Throw};
use super::remote;
use super::settings;
use super::shortcuts;
use super::windows;
use serde_json::{Map, Value, json};

/// What normalizeState takes from the world: the clock (inbox retention) and new ids (grids whose id was used twice).
pub struct Env<'a> {
    pub now_ms: f64,
    pub uid: &'a mut dyn FnMut() -> String,
}

/// `defaultState(platform)`.
pub fn default_state(platform: Platform) -> Value {
    let shell_name = if platform == Platform::Win32 { "PowerShell" } else { "Terminal" };
    json!({
        "version": 1,
        "automation": {"paused": false, "tasks": [], "messages": [], "events": []},
        "projects": [],
        "activeProjectId": null,
        "profiles": [
            {"id": "claude", "name": "Claude", "cli": "claude", "args": "", "color": "#d97757"},
            {"id": "codex", "name": "Codex", "cli": "codex", "args": "", "color": "#10a37f"},
            {"id": "shell", "name": shell_name, "cli": "shell", "args": "", "color": "#7a7a7a"},
        ],
        "presets": [],
        "snippets": [],
        "notes": [],
        "sshHosts": [],
        "sshIdentities": [],
        "sftp": {"remotePaths": {}},
        "dbConnections": [],
        "dbGroupColors": {},
        "settings": {
            "language": null, "fontSize": 13, "shell": default_shell(platform), "lastProfileId": "claude", "updateMode": "manual",
            "showAiUsage": true, "usageIntervalMinutes": 5, "usageCollapsed": false, "alerts": settings::default_alerts(),
            "accountSwitch": settings::default_auto_switch(), "backgroundLoad": "project", "shortcuts": {}, "confirmCloseWorking": true,
            "scrollbackLines": 5000, "sshTheme": settings::DEFAULT_SSH_THEME, "stripScope": "all",
            "delegation": {"mode": "auto", "maxAgents": 4},
        },
        "sidebarCollapsed": false,
        "snippetsOpen": true,
        "notesOpen": false,
        "sidebarWidth": 228,
        "snippetsWidth": 280,
    })
}

fn default_shell(platform: Platform) -> &'static str {
    if platform == Platform::Win32 { "pwsh" } else { "zsh" }
}

fn shells(platform: Platform) -> &'static [&'static str] {
    if platform == Platform::Win32 { &["pwsh", "powershell", "cmd"] } else { &["zsh", "bash"] }
}

fn arr(v: Option<&Value>) -> Option<&Vec<Value>> {
    v.and_then(Value::as_array)
}

/// `p.id in RETIRED_PROFILES` (own keys and the names Object.prototype has).
fn retired(p: &Value) -> Js<bool> {
    let id = js::get_strict(Some(p), "id")?;
    let key = js::to_string(id);
    Ok(key == "claude-opus" || key == "codex-high" || js::is_proto_key(&key))
}

/// `repairTab(raw)`: a tab with an id and 1..MAX_CELLS usable cells (layout rebuilt when it does not fit), else None.
fn repair_tab(raw: &Value) -> Option<Map<String, Value>> {
    let o = raw.as_object()?;
    o.get("id")?.as_str()?;
    let cells: Vec<Value> = arr(o.get("cells"))
        .map(|c| {
            c.iter()
                .filter(|c| {
                    c.get("id").is_some_and(Value::is_string) && c.get("profileId").is_some_and(Value::is_string) && c.is_object()
                })
                .take(MAX_CELLS)
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    if cells.is_empty() {
        return None;
    }
    let layout = if grid::is_usable_layout(o.get("layout"), cells.len()) {
        o["layout"].clone()
    } else {
        grid::layout_for_count(cells.len() as f64)
    };
    let mut t = o.clone();
    let name = o.get("name").filter(|n| n.is_string()).cloned().unwrap_or(Value::from(""));
    t.insert("name".into(), name);
    t.insert("cells".into(), Value::Array(cells));
    t.insert("layout".into(), layout);
    Some(t)
}

/// `cleanCells`: retired profiles remapped; path mode, SSH reference, prompt queue (paused at launch) and folder kept only in
/// their known shapes, moved to the end of the cell; the running shell dropped.
fn clean_cell(c: &Value) -> Value {
    let o = c.as_object().cloned().unwrap_or_default();
    let mut rest = o.clone();
    if let Some(id) = o.get("profileId") {
        grid::put_remapped(&mut rest, "profileId", id);
    }
    for k in ["pathMode", "ssh", "shell", "promptQueue", "dir"] {
        rest.shift_remove(k);
    }
    if let Some(mode) = js::string(o.get("pathMode")).filter(|m| ["claude", "codex", "shell"].contains(m)) {
        rest.insert("pathMode".into(), Value::from(mode));
    }
    if let Some(r) = remote::normalize_ssh_cell_ref(o.get("ssh")) {
        rest.insert("ssh".into(), r);
    }
    if let Some(q) = grid::normalize_prompt_queue(o.get("promptQueue"), true) {
        rest.insert("promptQueue".into(), q);
    }
    if let Some(d) = grid::normalize_cell_dir(o.get("dir")) {
        rest.insert("dir".into(), Value::from(d));
    }
    Value::Object(rest)
}

fn repaired_tabs(list: Option<&Value>) -> Vec<Value> {
    arr(list)
        .map(|tabs| {
            tabs.iter()
                .filter_map(repair_tab)
                .map(|mut t| {
                    let cells: Vec<Value> = t["cells"].as_array().map(|c| c.iter().map(clean_cell).collect()).unwrap_or_default();
                    t.insert("cells".into(), Value::Array(cells));
                    Value::Object(t)
                })
                .collect()
        })
        .unwrap_or_default()
}

fn normalize_settings(rs: Option<&Value>, d: &Map<String, Value>, platform: Platform) -> Js<Value> {
    // readAlerts runs `in` on the saved settings: a primitive there throws (the file counts as corrupt).
    let alerts = settings::read_alerts(rs)?;
    let rs = match rs {
        Some(Value::Null) => None,
        other => other,
    };
    let g = |k: &str| js::get(rs, k);
    let mut s = d.clone();
    js::spread_into(&mut s, rs);
    let language = match g("language") {
        None => Value::from("pl"),
        Some(l) if settings::is_language(Some(l)) => l.clone(),
        Some(_) => Value::Null,
    };
    s.insert("language".into(), language);
    let shell = js::string(g("shell")).filter(|sh| shells(platform).contains(sh)).unwrap_or(default_shell(platform));
    s.insert("shell".into(), Value::from(shell));
    let last = match g("lastProfileId") {
        None | Some(Value::Null) => Value::from("claude"),
        Some(v) => v.clone(),
    };
    grid::put_remapped(&mut s, "lastProfileId", &last);
    s.insert("updateMode".into(), settings::normalize_update_mode(g("updateMode"), g("autoInstallUpdates")));
    s.insert("showAiUsage".into(), Value::Bool(js::boolean(g("showAiUsage")).unwrap_or(true)));
    let interval = g("usageIntervalMinutes").filter(|v| js::number(Some(v)).is_some_and(|n| [1.0, 5.0, 15.0].contains(&n)));
    s.insert("usageIntervalMinutes".into(), interval.cloned().unwrap_or(Value::from(5)));
    s.insert("usageCollapsed".into(), Value::Bool(js::boolean(g("usageCollapsed")).unwrap_or(false)));
    s.insert("confirmCloseWorking".into(), Value::Bool(js::boolean(g("confirmCloseWorking")).unwrap_or(true)));
    s.insert("backgroundLoad".into(), settings::normalize_background_load(g("backgroundLoad")));
    s.insert("scrollbackLines".into(), settings::normalize_scrollback(g("scrollbackLines")));
    s.insert("sshTheme".into(), settings::normalize_ssh_theme(g("sshTheme")));
    put_opt(&mut s, "sshStatusBarItems", settings::normalize_bar_items(g("sshStatusBarItems")));
    s.insert("stripScope".into(), settings::normalize_strip_scope(g("stripScope")));
    put_opt(&mut s, "sidePanels", settings::normalize_side_panels(g("sidePanels")));
    s.insert("shortcuts".into(), shortcuts::normalize_overrides(g("shortcuts"), platform));
    s.insert("alerts".into(), alerts);
    s.insert("accountSwitch".into(), settings::normalize_auto_switch(g("accountSwitch")));
    s.insert("delegation".into(), settings::normalize_delegation(g("delegation")));
    for k in settings::LEGACY_ALERT_KEYS {
        s.shift_remove(k);
    }
    Ok(Value::Object(s))
}

/// An optional field: set when there is a value, gone when it is undefined (JSON.stringify drops it).
fn put_opt(map: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    match value {
        Some(v) => {
            map.insert(key.into(), v);
        }
        None => {
            map.shift_remove(key);
        }
    }
}

fn tab_ids(projects: &[Value]) -> Vec<String> {
    projects
        .iter()
        .flat_map(|p| p.get("tabs").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default())
        .filter_map(|t| t.get("id").and_then(Value::as_str).map(str::to_string))
        .collect()
}

/// `normalizeState(raw, platform)`: None for something that is not a state (also where the TS code throws).
pub fn normalize_state(raw: &Value, platform: Platform, env: &mut Env<'_>) -> Option<Value> {
    normalize_inner(raw, platform, env).ok().flatten()
}

fn normalize_inner(raw: &Value, platform: Platform, env: &mut Env<'_>) -> Js<Option<Value>> {
    let Some(r) = raw.as_object() else { return Ok(None) };
    let Some(raw_projects) = arr(r.get("projects")) else { return Ok(None) };
    if !js::strict_eq(r.get("version"), Some(&Value::from(1))) {
        return Ok(None);
    }
    let d = default_state(platform);
    let dm = d.as_object().cloned().unwrap_or_default();
    let g = |k: &str| r.get(k);
    let db_connections = remote::normalize_db_connections(g("dbConnections"));

    let source = match arr(g("profiles")) {
        Some(p) if !p.is_empty() => p.clone(),
        _ => dm["profiles"].as_array().cloned().unwrap_or_default(),
    };
    let mut profiles = Vec::new();
    for p in source {
        if !retired(&p)? {
            profiles.push(p);
        }
    }
    if profiles.is_empty() {
        profiles = dm["profiles"].as_array().cloned().unwrap_or_default();
    }

    let a = g("automation");
    let list = |k: &str| arr(js::get(a, k)).cloned().unwrap_or_default();
    let mut automation = Map::new();
    automation.insert("paused".into(), Value::Bool(js::is_true(js::get(a, "paused"))));
    automation.insert("tasks".into(), Value::Array(list("tasks")));
    automation.insert("messages".into(), Value::Array(list("messages")));
    automation.insert("events".into(), Value::Array(js::last_n(&list("events"), 200)));

    let settings_value = normalize_settings(g("settings"), dm["settings"].as_object().unwrap_or(&Map::new()), platform)?;

    let mut projects: Vec<Value> = Vec::new();
    for p in raw_projects {
        let Some(o) = p.as_object() else { continue };
        if !o.get("id").is_some_and(Value::is_string) || !o.get("path").is_some_and(Value::is_string) {
            continue;
        }
        let mut np = o.clone();
        np.insert("tabs".into(), Value::Array(repaired_tabs(o.get("tabs"))));
        np.insert("archive".into(), Value::Array(repaired_tabs(o.get("archive"))));
        projects.push(Value::Object(np));
    }

    let mut out = dm.clone();
    js::spread_into(&mut out, Some(raw));
    out.insert("automation".into(), Value::Object(automation));
    out.insert("sidebarCollapsed".into(), Value::Bool(js::is_true(g("sidebarCollapsed"))));
    out.insert("sidebarWidth".into(), settings::panel_width(g("sidebarWidth"), 200.0, 480.0, 228));
    out.insert("snippetsWidth".into(), settings::panel_width(g("snippetsWidth"), 220.0, 520.0, 280));
    out.insert("profiles".into(), Value::Array(profiles));
    out.insert("presets".into(), grid::normalize_presets(g("presets")));
    out.insert("snippets".into(), arr(g("snippets")).map_or(json!([]), |s| Value::Array(s.clone())));
    out.insert("notes".into(), grid::normalize_notes(g("notes")));
    out.insert("notesOpen".into(), Value::Bool(js::is_true(g("notesOpen"))));
    out.insert("sshHosts".into(), remote::normalize_ssh_hosts(g("sshHosts")));
    out.insert("sshIdentities".into(), remote::normalize_ssh_identities(g("sshIdentities")));
    out.insert("sftp".into(), remote::normalize_sftp_places(g("sftp")));
    out.insert("dbGroupColors".into(), remote::normalize_db_group_colors(g("dbGroupColors"), &db_connections));
    out.insert("dbConnections".into(), db_connections);
    out.insert("settings".into(), settings_value);

    // Grid ids are unique across all projects: a repeated one gets a new id, the active tab follows its grid.
    let mut seen: Vec<String> = Vec::new();
    let mut fresh = |id: &str, uid: &mut dyn FnMut() -> String| -> String {
        if !seen.iter().any(|s| s == id) {
            seen.push(id.to_string());
            return id.to_string();
        }
        let next = uid();
        seen.push(next.clone());
        next
    };
    for p in projects.iter_mut() {
        let Some(o) = p.as_object_mut() else { continue };
        let old_tabs = o["tabs"].as_array().cloned().unwrap_or_default();
        let mut changed = false;
        let mut tabs = old_tabs.clone();
        for t in tabs.iter_mut() {
            let id = t["id"].as_str().unwrap_or_default().to_string();
            let next = fresh(&id, env.uid);
            if next != id {
                t["id"] = Value::from(next);
                changed = true;
            }
        }
        let mut archive = o["archive"].as_array().cloned().unwrap_or_default();
        for t in archive.iter_mut() {
            let id = t["id"].as_str().unwrap_or_default().to_string();
            let next = fresh(&id, env.uid);
            if next != id {
                t["id"] = Value::from(next);
                changed = true;
            }
        }
        if changed {
            let active = o.get("activeTabId");
            let kept = tabs.iter().any(|t| js::strict_eq(t.get("id"), active));
            let moved = old_tabs.iter().position(|t| js::strict_eq(t.get("id"), active));
            let next_active = match moved {
                Some(i) if !kept => Some(tabs[i]["id"].clone()),
                _ => active.cloned(),
            };
            o.insert("tabs".into(), Value::Array(tabs));
            o.insert("archive".into(), Value::Array(archive));
            if let Some(v) = next_active {
                o.insert("activeTabId".into(), v);
            }
        }
    }
    // An active tab or project dropped by the repair falls back to the first one left.
    for p in projects.iter_mut() {
        let Some(o) = p.as_object_mut() else { continue };
        let active = o.get("activeTabId");
        if js::truthy(active) && !o["tabs"].as_array().is_some_and(|t| t.iter().any(|t| js::strict_eq(t.get("id"), active))) {
            let first = o["tabs"].as_array().and_then(|t| t.first()).and_then(|t| t.get("id")).cloned().unwrap_or(Value::Null);
            o.insert("activeTabId".into(), first);
        }
    }
    let active_project = out.get("activeProjectId").cloned();
    if js::truthy(active_project.as_ref()) && !projects.iter().any(|p| js::strict_eq(p.get("id"), active_project.as_ref())) {
        let first = projects.first().and_then(|p| p.get("id")).cloned().unwrap_or(Value::Null);
        out.insert("activeProjectId".into(), first);
    }

    let ids = tab_ids(&projects);
    let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    put_opt(&mut out, "workspaceOrder", windows::normalize_workspace_order(g("workspaceOrder"), &id_refs));
    let grids = windows::open_grids(&projects);
    put_opt(&mut out, "detachedWindows", windows::normalize_detached_windows(g("detachedWindows"), &grids));

    let project_ids: Vec<String> =
        projects.iter().filter_map(|p| p.get("id").and_then(Value::as_str).map(str::to_string)).collect();
    let pid_refs: Vec<&str> = project_ids.iter().map(String::as_str).collect();
    let mut automation = out["automation"].as_object().cloned().unwrap_or_default();
    windows::prune_automation(&mut automation, &pid_refs, env.now_ms)?;
    out.insert("automation".into(), Value::Object(automation));
    out.insert("projects".into(), Value::Array(projects));

    let mut state = Value::Object(out);
    unimux_core::js_json::order_like_js(&mut state);
    Ok(Some(state))
}

const CELL_LIMIT_ERROR: &str = "Concurrent grid change exceeds the cell limit.";

/// `normalizeEditedState(next, state)`: a renderer edit after the merge, `previous` being main's state before it.
pub fn normalize_edited_state(next: Value, previous: &Value) -> Result<Value, String> {
    edited(next, previous).map_err(|e| match e {
        Edit::Limit => CELL_LIMIT_ERROR.to_string(),
        Edit::Type => "TypeError: the edited state has a damaged field".to_string(),
    })
}

enum Edit {
    Limit,
    Type,
}

impl From<Throw> for Edit {
    fn from(_: Throw) -> Self {
        Edit::Type
    }
}

fn edited(next: Value, previous: &Value) -> Result<Value, Edit> {
    let Value::Object(n) = next else { return Err(Edit::Type) };
    let g = |k: &str| n.get(k);
    let sftp = remote::normalize_sftp_places(g("sftp"));
    let db_connections = remote::normalize_db_connections(g("dbConnections"));
    let identities = remote::normalize_ssh_identities(g("sshIdentities"));
    let Some(raw_projects) = arr(g("projects")) else { return Err(Edit::Type) };
    let mut projects = Vec::with_capacity(raw_projects.len());
    for project in raw_projects {
        let Some(tabs) = arr(js::get_strict(Some(project), "tabs")?) else { return Err(Edit::Type) };
        let mut out_tabs = Vec::with_capacity(tabs.len());
        let mut changed = false;
        for tab in tabs {
            let cells = js::length(js::get_strict(Some(tab), "cells")?)?;
            if cells.is_some_and(|c| c < 1.0 || c > MAX_CELLS as f64) {
                return Err(Edit::Limit);
            }
            let areas = js::length(js::get_strict(js::get_strict(Some(tab), "layout")?, "areas")?)?;
            if areas == cells {
                out_tabs.push(tab.clone());
                continue;
            }
            // layoutForCount(undefined) throws (no grow step fits NaN).
            let Some(count) = cells else { return Err(Edit::Type) };
            let mut t = tab.as_object().cloned().ok_or(Edit::Type)?;
            t.insert("layout".into(), grid::layout_for_count(count));
            out_tabs.push(Value::Object(t));
            changed = true;
        }
        if changed {
            let mut p = project.as_object().cloned().ok_or(Edit::Type)?;
            p.insert("tabs".into(), Value::Array(out_tabs));
            projects.push(Value::Object(p));
        } else {
            projects.push(project.clone());
        }
    }
    let raw_settings = js::get_strict(g("settings"), "alerts").map(|_| g("settings"))?;
    let mut s = Map::new();
    js::spread_into(&mut s, raw_settings);
    let sg = |k: &str| js::get(raw_settings, k);
    let alerts = settings::normalize_alerts(sg("alerts"));
    let scrollback = settings::normalize_scrollback(sg("scrollbackLines"));
    let theme = settings::normalize_ssh_theme(sg("sshTheme"));
    s.insert("alerts".into(), alerts);
    s.insert("scrollbackLines".into(), scrollback);
    s.insert("sshTheme".into(), theme);

    let empty = Value::Object(Map::new());
    let colors_raw = match g("dbGroupColors") {
        None | Some(Value::Null) => &empty,
        Some(v) => v,
    };
    let group_colors = remote::normalize_db_group_colors(Some(colors_raw), &db_connections);
    let ids = tab_ids(&projects);
    let id_refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let order = windows::normalize_workspace_order(g("workspaceOrder"), &id_refs);
    let grids = windows::open_grids(&projects);
    let detached = windows::normalize_detached_windows(previous.get("detachedWindows"), &grids);

    let mut out = n.clone();
    out.insert("sshHosts".into(), remote::normalize_ssh_hosts(g("sshHosts")));
    out.insert("sshIdentities".into(), identities);
    out.insert("dbConnections".into(), db_connections);
    out.insert("dbGroupColors".into(), group_colors);
    out.insert("sftp".into(), sftp);
    out.insert("settings".into(), js::js_object(s));
    out.insert("projects".into(), Value::Array(projects));
    put_opt(&mut out, "workspaceOrder", order);
    put_opt(&mut out, "detachedWindows", detached);
    Ok(Value::Object(out))
}
