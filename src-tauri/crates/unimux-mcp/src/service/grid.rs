//! The team operations of automation.ts: create_grid / add_agents (`createGrid`), close_grid (`closeGrid`) and update_agent
//! (`updateAgent`), with the cell and layout checks they share with save_preset.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use serde_json::{Map, Value, json};
use tokio_util::sync::CancellationToken;
use unimux_state::normalize::js::{self, truthy};

use super::model::{self, id, list, text};
use super::{AutomationService, Restart, coordinator_in, fail, grid_in, project_in, put};
use crate::automation::OpError;

const CANCELLED: &str = "The request ended (the MCP client disconnected or timed out) before the grid was created; nothing was kept. Retry if it is still wanted.";

/// AutomationService.validateCells: every profile exists; a shell profile takes no startup task.
pub(super) fn validate_cells(state: &Value, cells: &[Value]) -> Result<(), OpError> {
    for cell in cells {
        let wanted = cell.get("profileId");
        let Some(profile) = list(state, "profiles").iter().find(|p| p.get("id").is_some() && p.get("id") == wanted) else {
            return fail(format!("Unknown profile: {}", js::to_string(wanted)));
        };
        if text(profile, "cli") == Some("shell") && truthy(cell.get("prompt")) {
            return fail("Startup tasks require an AI agent profile.");
        }
    }
    Ok(())
}

/// AutomationService.layout: rows (their sizes must add up to the count) or the default layout of the count.
pub(super) fn layout(count: usize, rows: Option<&Value>) -> Result<Value, OpError> {
    match rows.and_then(Value::as_array) {
        Some(rows) => {
            let sizes: Vec<i64> = rows.iter().map(|r| r.as_f64().unwrap_or(0.0) as i64).collect();
            if sizes.iter().sum::<i64>() != count as i64 {
                return fail("Row sizes must match the number of cells.");
            }
            Ok(model::layout_from_rows(&sizes))
        }
        None => Ok(model::layout_for_count(count)),
    }
}

fn num(v: &Value, key: &str) -> i64 {
    v.get(key).and_then(Value::as_f64).map_or(i64::MIN / 4, |f| f as i64)
}

/// The areas lie inside the layout, never overlap and cover it fully.
fn check_areas(layout: &Value) -> Result<(), OpError> {
    let (cols, rows) = (num(layout, "cols"), num(layout, "rows"));
    let mut covered: HashSet<(i64, i64)> = HashSet::new();
    for area in list(layout, "areas") {
        let (col, row, cs, rs) = (num(area, "col"), num(area, "row"), num(area, "colSpan"), num(area, "rowSpan"));
        if col + cs > cols || row + rs > rows {
            return fail("Grid area is outside its bounds.");
        }
        // Bounded by the checks above and the schema (60 x 4); a damaged preset cannot make this loop long.
        for r in row.max(0)..(row + rs).min(rows).max(0) {
            for c in col.max(0)..(col + cs).min(cols).max(0) {
                if !covered.insert((c, r)) {
                    return fail("Grid areas overlap.");
                }
            }
        }
    }
    if covered.len() as i64 != cols.saturating_mul(rows) {
        return fail("Grid areas must cover the full layout.");
    }
    Ok(())
}

fn project_cells(project: &Value) -> usize {
    list(project, "tabs").iter().map(|t| list(t, "cells").len()).sum()
}

impl AutomationService {
    /// createGrid: `a` is the parsed create_grid input, or add_agents' with `name: ''` and its `gridId`.
    pub(super) async fn create_grid(
        self: Arc<Self>,
        a: Value,
        actor: Option<String>,
        signal: Option<CancellationToken>,
    ) -> Result<Value, OpError> {
        let actor = actor.as_deref();
        let state = self.state.get();
        coordinator_in(&state, actor)?;
        let existing = match a.get("gridId").and_then(Value::as_str) {
            Some(grid) => Some(grid_in(&state, grid, actor)?),
            None => None,
        };
        let project = match &existing {
            Some((p, _)) => p.clone(),
            None => project_in(&state, a.get("projectId").and_then(Value::as_str), actor)?,
        };
        let pid = id(&project).to_string();
        let preset = a.get("presetId").and_then(|wanted| {
            list(&state, "presets").iter().find(|p| {
                p.get("id") == Some(wanted) && (!truthy(p.get("projectId")) || text(p, "projectId") == Some(pid.as_str()))
            })
        });
        if a.get("presetId").is_some() && preset.is_none() {
            return fail("Preset not found in this project.");
        }
        if a.get("presetId").is_some() && a.get("cells").is_some() {
            return fail("Specify either cells or presetId.");
        }
        let cells: Vec<Value> = match a.get("cells") {
            Some(c) => list_of(c),
            None => preset.map(|p| list(p, "cells").to_vec()).unwrap_or_default(),
        };
        if cells.is_empty() || cells.len() > 20 {
            return fail("Specify 1 to 20 cells or a presetId.");
        }
        if actor.is_some() && a.get("cells").is_some() && cells.iter().any(|c| truthy(c.get("dir"))) {
            return fail("Cell folders are not available to agents.");
        }
        validate_cells(&state, &cells)?;
        let after_of =
            |i: usize| -> Vec<i64> { list(&cells[i], "after").iter().filter_map(Value::as_f64).map(|f| f as i64).collect() };
        let tracked = |i: usize| truthy(cells[i].get("prompt")) && truthy(cells[i].get("role"));
        for i in 0..cells.len() {
            for j in after_of(i) {
                if j >= i as i64 {
                    return fail(format!("Cell {i}: after must reference earlier cells (got {j})."));
                }
                if !tracked(i) || !tracked(j as usize) {
                    return fail(format!("Cell {i}: after needs a role and prompt on both cells ({i} and {j})."));
                }
            }
        }
        if a.get("rows").is_some() && a.get("layout").is_some() {
            return fail("Specify rows or layout, not both.");
        }
        let existing_len = existing.as_ref().map_or(0, |(_, t)| list(t, "cells").len());
        let count = existing_len + cells.len();
        if count > 20 {
            return fail("Grid cell limit reached (20).");
        }
        let layout = match (a.get("layout"), a.get("rows"), preset) {
            (Some(l), _, _) => l.clone(),
            (None, None, Some(p)) => p.get("layout").cloned().unwrap_or(Value::Null),
            (None, rows, _) => layout(count, rows)?,
        };
        if list(&layout, "areas").len() != count {
            return fail("Preset layout must match its cells.");
        }
        check_areas(&layout)?;
        if actor.is_some() && project_cells(&project) + cells.len() > 100 {
            return fail("Agent-created grids are limited to 100 project cells.");
        }
        if let Some(act) = actor
            && let Some(refusal) = model::delegation_refusal(&state, act, cells.len(), None)
        {
            return fail(refusal);
        }
        let new_tasks = cells.iter().filter(|c| truthy(c.get("prompt")) && truthy(c.get("role"))).count();
        if new_tasks > 0 {
            let mut room = (*state).clone();
            model::make_room(&mut room, self.now(), Some((&pid, new_tasks)), None);
            if model::project_count(model::tasks(&room), &pid) + new_tasks > model::PROJECT_ITEM_LIMIT {
                return fail(super::task_limit());
            }
        }
        let project_path = js::to_string(project.get("path"));
        let base_name = match a.get("name").and_then(Value::as_str).filter(|n| !n.is_empty()) {
            Some(n) => n.to_string(),
            None => existing.as_ref().map_or_else(|| "undefined".into(), |(_, t)| js::to_string(t.get("name"))),
        };
        let mut created: Vec<Value> = Vec::new();
        let result = self
            .create_grid_inner(
                &a,
                actor,
                &signal,
                &project,
                &cells,
                &layout,
                existing.as_ref().map(|(_, t)| t),
                &base_name,
                new_tasks,
                &mut created,
            )
            .await;
        if result.is_err() {
            for worktree in created.iter().rev() {
                let _ = self.deps.remove_worktree(&project_path, worktree).await;
            }
        }
        result
    }

    #[allow(clippy::too_many_arguments)]
    async fn create_grid_inner(
        &self,
        a: &Value,
        actor: Option<&str>,
        signal: &Option<CancellationToken>,
        project: &Value,
        cells: &[Value],
        layout: &Value,
        existing: Option<&Value>,
        base_name: &str,
        new_tasks: usize,
        created: &mut Vec<Value>,
    ) -> Result<Value, OpError> {
        let aborted = || signal.as_ref().is_some_and(CancellationToken::is_cancelled);
        let pid = id(project).to_string();
        let project_path = js::to_string(project.get("path"));
        let existing_len = existing.map_or(0, |t| list(t, "cells").len());
        let own_cells = a.get("cells").is_some();
        let mut specs: Vec<Value> = Vec::with_capacity(cells.len());
        for (i, cell) in cells.iter().enumerate() {
            let worktree = if truthy(cell.get("worktree")) {
                let name = format!("{base_name}-{}-{}", &model::uid()[..8], i + 1);
                let wt = self.deps.create_worktree(&project_path, &name).await.map_err(OpError::Message)?;
                created.push(wt.clone());
                Some(wt)
            } else {
                None
            };
            if aborted() {
                return fail(CANCELLED);
            }
            // A template's folder (resolved and absolute; only the user's own cells) and muted flag (1.1.1). A presetId keeps
            // the template's relative form, so its folders are not used here.
            let dir = if own_cells { unimux_state::normalize::grid::normalize_cell_dir(cell.get("dir")) } else { None };
            let mut spec = Map::new();
            spec.insert("profileId".into(), cell.get("profileId").cloned().unwrap_or(Value::Null));
            put(&mut spec, "role", cell.get("role").cloned());
            put(&mut spec, "name", cell.get("name").cloned());
            let color = cell
                .get("color")
                .filter(|c| !c.is_null())
                .cloned()
                .or_else(|| actor.map(|_| json!(model::CELL_COLORS[(existing_len + i) % model::CELL_COLORS.len()])));
            put(&mut spec, "color", color);
            put(&mut spec, "model", cell.get("model").cloned());
            put(&mut spec, "worktree", worktree);
            put(&mut spec, "dir", dir.map(Value::String));
            if truthy(cell.get("muted")) {
                spec.insert("muted".into(), json!(true));
            }
            specs.push(Value::Object(spec));
        }
        if aborted() {
            return fail(CANCELLED);
        }
        let now = self.now();
        let mut grid_id = String::new();
        let mut cell_ids: Vec<String> = Vec::new();
        let mut task_by_cell = Map::new();
        let grid_name = a.get("name").and_then(Value::as_str).unwrap_or_default().to_string();
        self.edit(false, |s| {
            // Recheck permissions and project after asynchronous git operations.
            let e = |e: OpError| e.describe();
            coordinator_in(s, actor).map_err(e)?;
            let latest = project_in(s, Some(&pid), actor).map_err(e)?;
            validate_cells(s, cells).map_err(e)?;
            if model::paused(s) && actor.is_some() {
                return Err(super::PAUSED.into());
            }
            if latest.get("path") != project.get("path") {
                return Err("Project folder changed while creating worktrees.".into());
            }
            if actor.is_some() && project_cells(&latest) + cells.len() > 100 {
                return Err("Project cell limit reached.".into());
            }
            if new_tasks > 0 {
                model::make_room(s, now, Some((&pid, new_tasks)), None);
                if model::project_count(model::tasks(s), &pid) + new_tasks > model::PROJECT_ITEM_LIMIT {
                    return Err(super::task_limit());
                }
            }
            let grid: Value = if let Some(existing) = existing {
                let current = list(&latest, "tabs").iter().find(|t| t.get("id") == existing.get("id"));
                let unchanged = current.is_some_and(|c| {
                    let (now_cells, then_cells) = (list(c, "cells"), list(existing, "cells"));
                    now_cells.len() == then_cells.len()
                        && now_cells.iter().zip(then_cells).all(|(x, y)| x.get("id") == y.get("id"))
                });
                let Some(current) = current.filter(|_| unchanged) else {
                    return Err("Grid changed while preparing agents; retry with the latest grid.".into());
                };
                let mut grid = current.clone();
                grid["layout"] = layout.clone();
                let mut all = list(current, "cells").to_vec();
                for spec in &specs {
                    let mut c = spec.as_object().cloned().unwrap_or_default();
                    c.insert("id".into(), json!(model::uid()));
                    all.push(Value::Object(c));
                }
                grid["cells"] = Value::Array(all);
                for p in s.get_mut("projects").and_then(Value::as_array_mut).into_iter().flatten() {
                    if id(p) == pid {
                        for t in p.get_mut("tabs").and_then(Value::as_array_mut).into_iter().flatten() {
                            if t.get("id") == grid.get("id") {
                                *t = grid.clone();
                            }
                        }
                    }
                }
                grid
            } else {
                let color = a.get("color").and_then(Value::as_str).map(str::to_string).or_else(|| {
                    actor.map(|_| model::CELL_COLORS[list(&latest, "tabs").len() % model::CELL_COLORS.len()].to_string())
                });
                let tab = model::add_tab(s, &pid, Some(&grid_name), color.as_deref(), layout.clone(), &specs)
                    .ok_or_else(|| "Project not found.".to_string())?;
                list(s, "projects")
                    .iter()
                    .find(|p| id(p) == pid)
                    .and_then(|p| list(p, "tabs").iter().find(|t| id(t) == tab))
                    .cloned()
                    .unwrap_or(Value::Null)
            };
            grid_id = id(&grid).to_string();
            let label = if grid_name.is_empty() { js::to_string(grid.get("name")) } else { grid_name.clone() };
            let mut task_ids: HashMap<usize, String> = HashMap::new();
            let mut tasks: Vec<Value> = Vec::new();
            for (i, spec) in cells.iter().enumerate() {
                let cell = list(&grid, "cells").get(existing_len + i).cloned().unwrap_or(Value::Null);
                let cid = id(&cell).to_string();
                cell_ids.push(cid.clone());
                let Some(prompt) = spec.get("prompt").filter(|p| truthy(Some(p))) else { continue };
                if !truthy(cell.get("role")) {
                    model::update_cell(s, &cid, &[("startupPrompt", Some(prompt.clone()))]);
                    continue;
                }
                let mut depends: Vec<String> = Vec::new();
                for j in list(spec, "after").iter().filter_map(Value::as_f64).map(|f| f as usize) {
                    if let Some(t) = task_ids.get(&j)
                        && !depends.contains(t)
                    {
                        depends.push(t.clone());
                    }
                }
                let task_id = model::uid();
                let mut task = Map::new();
                task.insert("id".into(), json!(task_id));
                task.insert("projectId".into(), json!(pid));
                task.insert("cellId".into(), json!(cid));
                put(&mut task, "fromCellId", actor.map(|x| json!(x)));
                let title =
                    spec.get("name").filter(|n| !n.is_null()).cloned().unwrap_or_else(|| json!(format!("{label} {}", i + 1)));
                task.insert("title".into(), title);
                task.insert("prompt".into(), prompt.clone());
                task.insert("status".into(), json!("queued"));
                task.insert("delivery".into(), json!(if depends.is_empty() { "startup" } else { "pending" }));
                task.insert("createdAt".into(), json!(now));
                task.insert("updatedAt".into(), json!(now));
                if !depends.is_empty() {
                    task.insert("dependsOn".into(), json!(depends));
                }
                let task = Value::Object(task);
                task_ids.insert(i, task_id.clone());
                task_by_cell.insert(cid.clone(), json!(task_id));
                // A task that waits for others (after) is not the startup prompt: the agent would start it at once, or poll
                // wait_for turn after turn. It starts with a short "wait to be told" prompt, and the task goes to it when its
                // prerequisites complete.
                let startup = if depends.is_empty() { model::task_prompt(&task) } else { model::waiting_prompt(&task) };
                model::update_cell(s, &cid, &[("startupPrompt", Some(json!(startup)))]);
                tasks.push(task);
            }
            model::items_mut(s, "tasks").extend(tasks);
            // Automation must preserve the user's active project/tab and keyboard focus.
            let active = latest.get("activeTabId").filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null);
            model::set_active_tab(s, &pid, active);
            let action = if existing.is_some() { "agents_added" } else { "grid_created" };
            model::log(s, &pid, action, &label, actor, now);
            Ok(())
        })?;
        self.deps.start_cells(&cell_ids);
        // Cells whose CLI is not installed show an install prompt instead of starting; say so per cell.
        let mut unavailable = Vec::new();
        for (i, cid) in cell_ids.iter().enumerate() {
            let Some(cli) = self.deps.missing_cli(&js::to_string(cells[i].get("profileId"))) else { continue };
            self.statuses.set(cid, "exited");
            let name = model::cli_name(&cli);
            unavailable.push(json!({ "cellId": cid, "cli": cli, "error": format!(
                "{name} is not installed on this computer, so this cell did not start an agent. It shows an install prompt; ask the user to install {name} or switch the profile."
            ) }));
        }
        let mut out = Map::new();
        out.insert("gridId".into(), json!(grid_id));
        out.insert("cellIds".into(), json!(cell_ids));
        if !task_by_cell.is_empty() {
            out.insert("tasks".into(), Value::Object(task_by_cell));
        }
        if !unavailable.is_empty() {
            out.insert("unavailable".into(), Value::Array(unavailable));
        }
        Ok(Value::Object(out))
    }

    /// closeGrid: stops the grid's agents and archives it (its worktrees stay with the archived cells).
    pub(super) async fn close_grid(self: Arc<Self>, a: Value, actor: Option<String>) -> Result<Value, OpError> {
        let actor = actor.as_deref();
        let state = self.state.get();
        coordinator_in(&state, actor)?;
        let grid_id = js::to_string(a.get("gridId"));
        let (project, tab) = grid_in(&state, &grid_id, actor)?;
        let ids: Vec<String> = list(&tab, "cells").iter().map(|c| id(c).to_string()).collect();
        if actor.is_some_and(|act| ids.iter().any(|i| i == act)) {
            return fail("A coordinator cannot close its own grid.");
        }
        let cancel_tasks = a["cancelTasks"] == json!(true);
        let unfinished = |s: &Value| {
            model::tasks(s).iter().any(|t| ids.iter().any(|i| Some(i.as_str()) == text(t, "cellId")) && !model::is_closed(t))
        };
        if !cancel_tasks && unfinished(&state) {
            return fail("Grid has unfinished tasks. Complete them or explicitly set cancelTasks:true.");
        }
        let Some(stop) = self.deps.stop_cells(ids.clone()) else { return fail("Runtime grid shutdown is unavailable.") };
        stop.await;
        let state = self.state.get();
        coordinator_in(&state, actor)?;
        let (_, latest) = grid_in(&state, &grid_id, actor)?;
        if list(&latest, "cells").iter().map(|c| id(c).to_string()).collect::<Vec<_>>() != ids {
            return fail("Grid changed during shutdown; retry after reviewing its agents.");
        }
        if !cancel_tasks && unfinished(&state) {
            return fail("Grid received new unfinished tasks during shutdown.");
        }
        let (pid, name) = (id(&project).to_string(), js::to_string(tab.get("name")));
        let now = self.now();
        self.edit(false, |s| {
            model::close_tab(s, &pid, &grid_id, now);
            if cancel_tasks {
                for t in model::items_mut(s, "tasks") {
                    if ids.iter().any(|i| Some(i.as_str()) == text(t, "cellId")) && !model::is_closed(t) && t.is_object() {
                        t["status"] = json!("cancelled");
                        t["updatedAt"] = json!(now);
                    }
                }
            }
            model::log(s, &pid, "grid_closed", &name, actor, now);
            Ok(())
        })?;
        for cell in &ids {
            self.statuses.set(cell, "exited");
            self.book.lock().pending_restart.remove(cell);
        }
        // SSH cells are closed too, but never named to MCP (spec 11).
        let ssh: HashSet<&str> = list(&tab, "cells").iter().filter(|c| truthy(c.get("ssh"))).map(id).collect();
        let stopped: Vec<&String> = ids.iter().filter(|i| !ssh.contains(i.as_str())).collect();
        Ok(json!({ "archivedGridId": id(&tab), "stoppedCellIds": stopped }))
    }

    /// updateAgent: name, color, launch settings (coordinators only) and a safe restart.
    pub(super) async fn update_agent(self: &Arc<Self>, a: Value, actor: Option<&str>) -> Result<Value, OpError> {
        let state = self.state.get();
        let cell = js::to_string(a.get("cellId"));
        if actor.is_some_and(|act| act != cell) {
            coordinator_in(&state, actor)?;
        }
        let restart = a["restart"] == json!(true);
        // Launch settings decide what an agent may run: a worker must not change its own profile or model, or restart itself.
        if actor.is_some() && (a.get("profileId").is_some() || a.get("model").is_some() || restart) {
            coordinator_in(&state, actor)?;
        }
        let Some((project, _, found)) = model::find(&state, &cell) else { return fail(super::AGENT_NOT_FOUND) };
        if !model::is_agent_cell(&state, &found) {
            return fail(super::AGENT_NOT_FOUND);
        }
        project_in(&state, Some(id(&project)), actor)?;
        if let Some(profile) = a.get("profileId") {
            let ok = list(&state, "profiles")
                .iter()
                .find(|p| p.get("id") == Some(profile))
                .is_some_and(|p| text(p, "cli") != Some("shell"));
            if !ok {
                return fail("Choose an AI agent profile.");
            }
        }
        let mut patch: Vec<(&str, Option<Value>)> = Vec::new();
        if let Some(v) = a.get("name") {
            patch.push(("name", Some(v.clone())));
        }
        if let Some(v) = a.get("color") {
            patch.push(("color", (!v.is_null()).then(|| v.clone())));
        }
        if let Some(v) = a.get("profileId") {
            patch.push(("profileId", Some(v.clone())));
        }
        if let Some(v) = a.get("model") {
            patch.push(("model", (!v.is_null()).then(|| v.clone())));
        }
        let model_changed = a.get("model").is_some_and(|m| {
            let new = (!m.is_null()).then_some(m);
            !js::strict_eq(new, found.get("model"))
        });
        let launch_changed = a.get("profileId").is_some_and(|p| Some(p) != found.get("profileId")) || model_changed;
        // A terminal whose agent CLI ended (status exited) runs no agent: a restart starts it again instead.
        let running = self.deps.is_cell_running(&cell).unwrap_or(true) && self.statuses.get(&cell).as_deref() != Some("exited");
        let detail = a
            .get("name")
            .or_else(|| found.get("name").filter(|n| !n.is_null()))
            .map_or_else(|| cell.clone(), |n| js::to_string(Some(n)));
        let (pid, now) = (id(&project).to_string(), self.now());
        self.edit(false, |s| {
            model::update_cell(s, &cell, &patch);
            model::log(s, &pid, "agent_updated", &detail, actor, now);
            Ok(())
        })?;
        {
            let mut book = self.book.lock();
            if launch_changed && running {
                book.pending_restart.insert(cell.clone());
            }
            if !running {
                book.pending_restart.remove(&cell);
            }
        }
        let mut restarted = false;
        let mut reason: Option<String> = None;
        if restart && running {
            match self.deps.restart_agent(&cell) {
                None => reason = Some("Safe runtime restart is unavailable.".into()),
                Some(f) => match f.await {
                    Ok(Restart { done, reason: r }) => {
                        restarted = done;
                        reason = r;
                    }
                    Err(e) => reason = Some(e),
                },
            }
        } else if restart {
            // 1.1.4: an exited team agent starts again (its new start carries its open tasks).
            if !truthy(found.get("role")) {
                reason = Some(
                    "Only team agents (with a role) can be started again through MCP; ask the user to restart the cell.".into(),
                );
            } else {
                match self.deps.start_agent(&cell) {
                    None => {
                        reason = Some("Starting an exited agent is unavailable here; ask the user to restart the cell.".into())
                    }
                    Some(f) => match f.await {
                        Ok(Restart { done, reason: r }) => {
                            restarted = done;
                            reason = if done { Some("The agent had exited; it was started again.".into()) } else { r };
                        }
                        Err(e) => reason = Some(e),
                    },
                }
            }
        }
        let pending = {
            let mut book = self.book.lock();
            if restarted {
                book.pending_restart.remove(&cell);
            }
            book.pending_restart.contains(&cell)
        };
        let mut out = Map::new();
        out.insert("cellId".into(), json!(cell));
        for (k, v) in patch {
            put(&mut out, k, v);
        }
        out.insert("restarted".into(), json!(restarted));
        out.insert("needsRestart".into(), json!(running && !restarted && (pending || restart)));
        put(&mut out, "restartReason", reason.map(Value::String));
        Ok(Value::Object(out))
    }
}

fn list_of(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}
