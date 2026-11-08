//! M3: the automation service of this run (unimux-mcp `AutomationService`, 1.1.4 src/main/automation.ts) and its wiring in
//! the app (index.ts `new AutomationService(controller, {...})` and the runtime calls around it):
//!
//! - [`AppDeps`], what the service needs from the app: worktrees through the one git engine (G4, `commands::git`), the
//!   new cells' start (`automation:start-cells`, routed to the windows that own the cells), the cached CLI detection for
//!   create_grid's `unavailable`, stopCells over the pty service (`kill_cells_and_wait`), the running cells, the context
//!   tracker, the safe restart / start of an exited agent through the cell spawn (P4's `cell:spawn`), and the inbox
//!   notice (M4: a verified Codex session through `codex queue`, every other agent through its prompt queue).
//! - `automation:execute` (the renderer, no actor: the user), `automation:statuses` pushed at most every 250 ms (pushLater).
//! - The runtime: a spawn / exit / kill / crash of a cell's process (pty `on_cell`), the renderer's statuses (`cell:runtime`
//!   observers, cliEnd), the hook hints, cancelOrphans after a projects change settled and forgetCell.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::RwLock;
use serde_json::{Value, json};
use unimux_agents::hooks::HookSignal;
use unimux_agents::hooks::route::find_cell;
use unimux_ipc::{RouterBuilder, Scope};
use unimux_mcp::service::{AutomationDeps, Restart, model};
use unimux_mcp::tools::BoxFuture;
use unimux_mcp::{AutomationService, OpError};
use unimux_state::normalize::js::truthy;

use crate::cells::CellReport;
use crate::commands::pty::CellEvent;
use crate::context::AppContext;

const NOT_RUNNING: &str = "Agent is not running. The item is available in its MCP inbox.";
const QUEUE_FULL: &str = "The prompt queue of this agent is full. The item is available in its MCP inbox.";
/// `pathExists` (src/main/fsProbe.ts `EXISTS_TIMEOUT_MS`).
const EXISTS_TIMEOUT: Duration = Duration::from_millis(4000);

fn not_done(reason: &str) -> Result<Restart, String> {
    Ok(Restart { done: false, reason: Some(reason.to_string()) })
}

/// The answer of `cell:spawn` as a restart outcome (`{ok, error}`).
fn spawn_outcome(answer: &Value) -> Restart {
    let ok = answer.get("ok") == Some(&Value::Bool(true));
    let reason = if ok { None } else { Some(answer.get("error").and_then(Value::as_str).unwrap_or("").to_string()) };
    Restart { done: ok, reason }
}

/// The cell's working folder (`cellCwd`) when it is a string, and whether it exists (4 s).
async fn existing_cwd(project: &Value, cell: &Value) -> Option<String> {
    let cwd = model::cell_cwd(project, cell).and_then(|v| v.as_str().map(str::to_string))?;
    unimux_git::path_exists(&cwd, EXISTS_TIMEOUT).await.then_some(cwd)
}

/// index.ts `restartAgent`: a running agent restarts on the conversation the user confirmed (never a new one, never a typed
/// shell command); the renderer is told (`cell:restarted`) so its terminal follows the new process.
async fn restart_running(ctx: Arc<AppContext>, cell: String) -> Result<Restart, String> {
    let state = ctx.state.get();
    let Some((project, _, found)) = model::find(&state, &cell) else { return not_done("Agent is not running.") };
    if !ctx.cells.is_alive(&cell) {
        return not_done("Agent is not running.");
    }
    let profile = unimux_mcp::automation::profile(&state, found.get("profileId")).cloned().unwrap_or(Value::Null);
    let session = found.get("session").filter(|s| s.is_object());
    let Some(session) = session.filter(|s| s.get("cli") == profile.get("cli") && truthy(s.get("confirmed"))) else {
        return not_done("Choose a compatible conversation from History before restarting through MCP.");
    };
    let Some(cwd) = existing_cwd(&project, &found).await else { return not_done("Project folder does not exist.") };
    if !ctx.cells.is_alive(&cell) {
        return not_done("Agent is not running.");
    }
    // endCellMcp, verifiedCodex, alive and the status go with the kill (before_kill), then the old process is gone.
    crate::commands::pty::kill_cells_and_wait(&ctx, std::slice::from_ref(&cell)).await;
    let request = json!({
        "cellId": cell, "cwd": cwd, "profile": profile, "mode": "resume", "sessionId": session.get("id").cloned().unwrap_or(Value::Null),
        "sessionConfirmed": true, "cols": 100, "rows": 30,
    });
    let answer = crate::commands::pty::spawn::spawn_cell(&ctx, &request).await;
    let outcome = spawn_outcome(&answer);
    if outcome.done {
        ctx.events.emit(Scope::Cell(cell.clone()), "cell:restarted", vec![json!(cell)]);
    }
    Ok(outcome)
}

/// index.ts `startExitedAgent`: update_agent restart:true of a team agent whose CLI or terminal ended starts the cell again the
/// way a restart from the cell menu does (its conversation resumes when it has one, else a new one starts with the stored
/// startup prompt); the renderer is told so its terminal follows the new process.
async fn start_exited(ctx: Arc<AppContext>, cell: String) -> Result<Restart, String> {
    let state = ctx.state.get();
    let Some((project, _, found)) = model::find(&state, &cell).filter(|(_, _, c)| !truthy(c.get("ssh"))) else {
        return not_done("Agent cell not found.");
    };
    let profile = unimux_mcp::automation::profile(&state, found.get("profileId")).cloned().unwrap_or(Value::Null);
    let cli = profile.get("cli").and_then(Value::as_str).unwrap_or_default().to_string();
    if cli == "shell" {
        return not_done("Choose an AI agent profile.");
    }
    let Some(cwd) = existing_cwd(&project, &found).await else {
        return not_done("Project folder does not exist; ask the user.");
    };
    if ctx.cells.is_alive(&cell) {
        crate::commands::pty::kill_cells_and_wait(&ctx, std::slice::from_ref(&cell)).await;
    }
    let session = found.get("session").filter(|s| s.is_object() && s.get("cli") == profile.get("cli")).cloned();
    let mut session_id = session.as_ref().and_then(|s| s.get("id")).cloned();
    if session.is_none() && cli == "claude" {
        // A new Claude conversation gets its id up front, so the cell can resume it later.
        let id = model::uid();
        let (c, sid) = (cell.clone(), id.clone());
        let _ = ctx.state.change(
            move |s| {
                let mut s = s.clone();
                model::update_cell(&mut s, &c, &[("session", Some(json!({ "cli": "claude", "id": sid })))]);
                Ok(s)
            },
            None,
            false,
        );
        session_id = Some(json!(id));
    }
    let confirmed = session.as_ref().is_some_and(|s| s.get("confirmed") == Some(&Value::Bool(true)));
    let startup_prompt = model::find(&ctx.state.get(), &cell)
        .and_then(|(_, _, c)| c.get("startupPrompt").and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_string));
    let mut request = json!({
        "cellId": cell, "cwd": cwd, "profile": profile, "mode": if session.is_some() { "resume" } else { "new" },
        "sessionId": session_id.unwrap_or(Value::Null), "sessionConfirmed": confirmed, "cols": 100, "rows": 30,
    });
    if let Some(prompt) = startup_prompt.filter(|_| session.is_none() || !confirmed) {
        request["startupPrompt"] = json!(prompt);
    }
    let answer = crate::commands::pty::spawn::spawn_cell(&ctx, &request).await;
    let outcome = spawn_outcome(&answer);
    if outcome.done {
        if answer.get("startedWithPrompt") == Some(&Value::Bool(true)) {
            let c = cell.clone();
            let _ = ctx.state.change(
                move |s| {
                    if model::find(s, &c).is_none_or(|(_, _, cell)| cell.get("startupPrompt").is_none()) {
                        return Err("unchanged".into());
                    }
                    let mut s = s.clone();
                    model::update_cell(&mut s, &c, &[("startupPrompt", None)]);
                    Ok(s)
                },
                None,
                false,
            );
        }
        ctx.events.emit(Scope::Cell(cell.clone()), "cell:restarted", vec![json!(cell)]);
    }
    Ok(outcome)
}

/// The prompt queue half of index.ts `deliver`: the notice joins the cell's prompt queue (merged into a notice that has not
/// gone out yet), which sends it when the agent sits idle at its prompt.
fn queue_notice(ctx: &AppContext, cell: &str, notice: &str) -> Result<(), String> {
    let mut queued = false;
    let changed = ctx.state.change(
        |s| {
            let Some((pi, ti, ci)) = model::locate(s, cell) else { return Err(String::new()) };
            let current = s["projects"][pi]["tabs"][ti]["cells"][ci].get("promptQueue");
            let pending =
                current.is_some_and(|q| model::list(q, "items").iter().any(|i| model::id(i).starts_with(model::NOTICE_PREFIX)));
            let next = model::queue_notice(current, notice, &model::uid());
            queued = pending || next.as_ref() != current;
            if !queued {
                return Err(String::new());
            }
            let mut s = s.clone();
            model::update_cell(&mut s, cell, &[("promptQueue", next)]);
            Ok(s)
        },
        None,
        true,
    );
    if changed.is_err() || !queued {
        return Err(QUEUE_FULL.to_string());
    }
    Ok(())
}

/// What the automation service needs from the app (index.ts `AutomationDependencies`).
pub struct AppDeps {
    ctx: Weak<AppContext>,
    /// The service itself (its statuses), set right after it was made.
    service: RwLock<Weak<AutomationService>>,
}

impl AppDeps {
    fn ctx(&self) -> Result<Arc<AppContext>, String> {
        self.ctx.upgrade().ok_or_else(|| "The app is closing.".to_string())
    }

    fn exited(&self, cell: &str) -> bool {
        self.service.read().upgrade().is_some_and(|s| s.statuses.get(cell).as_deref() == Some("exited"))
    }
}

impl AutomationDeps for AppDeps {
    fn create_worktree(&self, project_path: &str, name: &str) -> BoxFuture<'static, Result<Value, String>> {
        let (ctx, path, name) = (self.ctx(), project_path.to_string(), name.to_string());
        Box::pin(async move {
            let ctx = ctx?;
            let wt = crate::commands::git::create_worktree(&ctx, &path, &name).await?;
            serde_json::to_value(wt).map_err(|e| e.to_string())
        })
    }

    fn remove_worktree(&self, project_path: &str, worktree: &Value) -> BoxFuture<'static, Result<(), String>> {
        let (ctx, path, wt) = (self.ctx(), project_path.to_string(), worktree.clone());
        Box::pin(async move {
            let ctx = ctx?;
            let wt: unimux_git::worktree::Worktree = serde_json::from_value(wt).map_err(|e| e.to_string())?;
            crate::commands::git::remove_worktree(&ctx, &path, &wt).await
        })
    }

    fn start_cells(&self, ids: &[String]) {
        if let Ok(ctx) = self.ctx() {
            ctx.events.send("automation:start-cells", vec![json!(ids)]);
        }
    }

    fn missing_cli(&self, profile_id: &str) -> Option<String> {
        let ctx = self.ctx().ok()?;
        let state = ctx.state.get();
        let profile = model::list(&state, "profiles").iter().find(|p| model::text(p, "id") == Some(profile_id))?;
        let snapshot = crate::commands::agents::cli_detector(&ctx).snapshot();
        unimux_agents::cli::status::missing_cli(model::text(profile, "cli").unwrap_or_default(), Some(&snapshot))
            .map(|cli| cli.as_str().to_string())
    }

    fn stop_cells(&self, ids: Vec<String>) -> Option<BoxFuture<'static, ()>> {
        let ctx = self.ctx().ok()?;
        // before_kill: noteKill, ssh.killed, endCellMcp, verifiedCodex, status exited (CellEvent::Killed), alive.delete.
        Some(Box::pin(async move { crate::commands::pty::kill_cells_and_wait(&ctx, &ids).await }))
    }

    fn is_cell_running(&self, cell: &str) -> Option<bool> {
        self.ctx().ok().map(|ctx| ctx.cells.is_alive(cell))
    }

    fn context_of(&self, cell: &str) -> Option<Value> {
        let ctx = self.ctx().ok()?;
        crate::commands::agents::context_tracker(&ctx)?.current(cell).map(|u| u.to_json())
    }

    fn restart_agent(&self, cell: &str) -> Option<BoxFuture<'static, Result<Restart, String>>> {
        let ctx = self.ctx().ok()?;
        Some(Box::pin(restart_running(ctx, cell.to_string())))
    }

    fn start_agent(&self, cell: &str) -> Option<BoxFuture<'static, Result<Restart, String>>> {
        let ctx = self.ctx().ok()?;
        Some(Box::pin(start_exited(ctx, cell.to_string())))
    }

    /// 1.1.4: a short inbox notice ("unimux: new task ...: read_inbox") reaches every running team agent. A Codex session the
    /// user chose (verified) takes it through `codex queue`; any other agent (Claude, a fresh Codex), and a Codex whose
    /// native delivery failed, gets it through its prompt queue, which sends it when the agent sits idle at its prompt and
    /// pauses for permissions, questions and the user typing.
    fn deliver(&self, cell: &str, notice: &str) -> BoxFuture<'static, Result<(), String>> {
        let ctx = match self.ctx() {
            Ok(ctx) => ctx,
            Err(e) => return Box::pin(async move { Err(e) }),
        };
        if find_cell(&ctx.state.get(), cell).is_none() || !ctx.cells.is_alive(cell) || self.exited(cell) {
            return Box::pin(async { Err(NOT_RUNNING.to_string()) });
        }
        let (cell, notice) = (cell.to_string(), notice.to_string());
        Box::pin(async move {
            match crate::commands::agents::prompt::deliver_native(&ctx, &cell, &notice).await {
                Some(Ok(())) => return Ok(()),
                // The prompt queue below still reaches it.
                Some(Err(e)) => ctx.crash.warn(&format!("codex queue delivery to {cell} failed: {e}")),
                None => {}
            }
            queue_notice(&ctx, &cell, &notice)
        })
    }
}

/// The service of this app run over `ctx`'s state (cancelOrphans runs at once, as 1.1.4's constructor does).
pub fn create(ctx: &Arc<AppContext>) -> Arc<AutomationService> {
    let deps = Arc::new(AppDeps { ctx: Arc::downgrade(ctx), service: RwLock::new(Weak::new()) });
    let service = AutomationService::new(
        ctx.state.clone(),
        deps.clone(),
        Arc::new(unimux_core::time::now_ms),
        Arc::new(|f| {
            tauri::async_runtime::spawn(f);
        }),
    );
    *deps.service.write() = Arc::downgrade(&service);
    service
}

/// `automationStatusFor` / cliEnd for a `cell:runtime` report of a cell that exists and runs.
fn runtime_report(service: &AutomationService, report: &CellReport) {
    // 1.1.3: the agent CLI ended inside a shell that still runs: for the team it has exited (a coordinator's wait_for hears it).
    if report.cli_ended {
        service.statuses.set(&report.cell, "exited");
        return;
    }
    let current = service.statuses.get(&report.cell);
    if let Some(next) = model::automation_status_for(&report.status, report.reason.as_deref(), report.hooked, current.as_deref())
    {
        service.statuses.set(&report.cell, next);
    }
}

/// What a cell's process did (index.ts ptyHost `spawned` / `exit` / `spawnError`, cell:kill, the crash).
fn cell_event(service: &AutomationService, event: &CellEvent) {
    match event {
        // P4's cell:spawn started the terminal (index.ts: runtimeStarted, status `starting`).
        CellEvent::Spawning { cell } => {
            service.runtime_started(cell);
            service.statuses.set(cell, "starting");
        }
        CellEvent::Started { cell, .. } => {
            service.runtime_started(cell);
            service.statuses.set(cell, "unknown");
        }
        CellEvent::Exited { cell, code } => {
            service.statuses.set(cell, "exited");
            service.note_exit(cell, Some(*code));
        }
        CellEvent::SpawnFailed { cell } | CellEvent::Killed { cell } | CellEvent::Lost { cell } => {
            service.statuses.set(cell, "exited");
        }
    }
}

/// The hook signals automation hears: the immediate status hints and the end of a CLI the launch line reported.
fn hook_signal(ctx: &AppContext, service: &AutomationService, signal: &HookSignal) {
    match signal {
        HookSignal::Hook { cell, event, .. } => {
            if find_cell(&ctx.state.get(), cell).is_none() {
                return; // stale or foreign id
            }
            // Busy is left to the tracker (it may ignore late tool hooks) and reaches automation through cell:runtime.
            if let Some(hint) = model::automation_hint_for_hook(event) {
                service.statuses.set(cell, hint);
            }
        }
        HookSignal::CliExit { cell, .. } if find_cell(&ctx.state.get(), cell).is_some() && ctx.cells.is_alive(cell) => {
            service.statuses.set(cell, "exited");
        }
        _ => {}
    }
}

/// Wires the service into the app and registers `automation:execute`.
pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>, service: &Arc<AutomationService>) {
    // pushLater: the windows hear the statuses at most every 250 ms.
    let pending = Arc::new(AtomicBool::new(false));
    let (events, weak) = (ctx.events.clone(), Arc::downgrade(service));
    service.statuses.set_on_change(move || {
        if pending.swap(true, Ordering::SeqCst) {
            return;
        }
        let (events, weak, pending) = (events.clone(), weak.clone(), pending.clone());
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(250)).await;
            pending.store(false, Ordering::SeqCst);
            if let Some(s) = weak.upgrade() {
                events.send("automation:statuses", vec![s.statuses.to_json()]);
            }
        });
    });

    let s = Arc::downgrade(service);
    ctx.cells.on_projects_settled("automation", move || {
        if let Some(s) = s.upgrade() {
            s.cancel_orphans();
        }
    });
    let s = Arc::downgrade(service);
    ctx.cells.on_forget_unless_alive("automation", move |cell| {
        if let Some(s) = s.upgrade() {
            s.forget_cell(cell);
        }
    });
    let s = Arc::downgrade(service);
    ctx.cells.on_runtime("automation", move |report| {
        if let Some(s) = s.upgrade() {
            runtime_report(&s, report);
        }
    });
    let s = Arc::downgrade(service);
    crate::commands::pty::host().on_cell("automation", move |event| {
        if let Some(s) = s.upgrade() {
            cell_event(&s, event);
        }
    });
    let (s, c) = (Arc::downgrade(service), Arc::downgrade(ctx));
    ctx.hooks.observe(move |signal| {
        if let (Some(s), Some(c)) = (s.upgrade(), c.upgrade()) {
            hook_signal(&c, &s, signal);
        }
    });

    // The renderer's operations (no actor: the user). Unknown operations are refused before anything else.
    let s = service.clone();
    r.invoke("automation:execute", move |call| {
        let s = s.clone();
        async move {
            let op = call.arg(0).as_str().unwrap_or_default().to_string();
            if unimux_mcp::schemas::operation(&op).is_none() {
                return Err(call.fail("Unknown operation."));
            }
            let input = call.arg(1).clone();
            s.execute_op(&op, input, None, None).await.map_err(|e: OpError| call.fail(e.describe()))
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, Ordering};

    fn service(state: Value) -> Arc<AutomationService> {
        struct NoDeps;
        impl AutomationDeps for NoDeps {
            fn create_worktree(&self, _: &str, _: &str) -> BoxFuture<'static, Result<Value, String>> {
                Box::pin(async { Err("no".into()) })
            }
            fn remove_worktree(&self, _: &str, _: &Value) -> BoxFuture<'static, Result<(), String>> {
                Box::pin(async { Ok(()) })
            }
            fn start_cells(&self, _: &[String]) {}
            fn deliver(&self, _: &str, _: &str) -> BoxFuture<'static, Result<(), String>> {
                Box::pin(async { Ok(()) })
            }
        }
        let now = Arc::new(AtomicI64::new(1000));
        let state = Arc::new(unimux_state::StateController::new(state, Arc::new(unimux_state::PassThrough)));
        AutomationService::new(state, Arc::new(NoDeps), Arc::new(move || now.load(Ordering::SeqCst)), Arc::new(|_f| {}))
    }

    fn report(status: &str, reason: Option<&str>, hooked: bool, cli_ended: bool) -> CellReport {
        CellReport {
            cell: "c".into(),
            status: status.into(),
            reason: reason.map(str::to_string),
            hooked,
            cli_ended,
            exit_code: None,
        }
    }

    #[test]
    fn the_runtime_reports_and_process_events_drive_the_statuses() {
        let s = service(json!({ "version": 1, "projects": [] }));
        cell_event(&s, &CellEvent::Killed { cell: "c".into() });
        assert_eq!(s.statuses.get("c").as_deref(), Some("exited"));
        // Heuristics never turn an exited agent ready or waiting.
        runtime_report(&s, &report("waiting", None, false, false));
        runtime_report(&s, &report("idle", None, false, false));
        assert_eq!(s.statuses.get("c").as_deref(), Some("exited"));
        runtime_report(&s, &report("working", None, false, false));
        assert_eq!(s.statuses.get("c").as_deref(), Some("working"));
        runtime_report(&s, &report("waiting", Some("attention"), true, false));
        assert_eq!(s.statuses.get("c").as_deref(), Some("needs_attention"));
        runtime_report(&s, &report("waiting", None, true, false));
        assert_eq!(s.statuses.get("c").as_deref(), Some("ready"));
        runtime_report(&s, &report("working", None, true, true));
        assert_eq!(s.statuses.get("c").as_deref(), Some("exited"));
        cell_event(&s, &CellEvent::Exited { cell: "c".into(), code: 3 });
        assert_eq!(s.statuses.get("c").as_deref(), Some("exited"));
    }

    fn app(state: Value) -> (tempfile::TempDir, Arc<AppContext>) {
        use std::time::Instant;
        use unimux_core::crash_log::RollingLog;
        use unimux_core::dev_overrides::DevOverrides;
        use unimux_core::startup_timing::{StartupLog, StartupTimer};
        let dir = tempfile::tempdir().unwrap();
        let ctx = AppContext::new(
            dir.path().to_path_buf(),
            DevOverrides::default(),
            Arc::new(RollingLog::crash_log(dir.path())),
            Arc::new(StartupTimer::new(Instant::now())),
            Arc::new(StartupLog::new(dir.path().join("startup.log"), "")),
            state,
        );
        (dir, ctx)
    }

    fn team_state(project: &str) -> Value {
        json!({ "version": 1, "projects": [{ "id": "p", "name": "P", "path": project, "tabs": [{ "id": "g", "name": "G", "cells": [
            { "id": "w1", "name": "Worker", "profileId": "claude", "role": "worker" },
            { "id": "sh", "name": "Shell", "profileId": "shell", "role": "worker" },
        ] }] }],
            "profiles": [{ "id": "claude", "name": "Claude", "cli": "claude", "args": "" }, { "id": "shell", "name": "Terminal", "cli": "shell", "args": "" }] })
    }

    fn deps(ctx: &Arc<AppContext>) -> AppDeps {
        AppDeps { ctx: Arc::downgrade(ctx), service: RwLock::new(Weak::new()) }
    }

    /// The inbox notice: refused for an agent that does not run; a Claude agent gets it through its prompt queue, and a second
    /// notice that has not gone out yet is merged into the first (one turn for a burst).
    #[test]
    fn a_notice_goes_through_the_prompt_queue_of_a_running_agent_and_merges() {
        let (_dir, ctx) = app(team_state("C:\\nowhere"));
        let deps = deps(&ctx);
        let block = |f: BoxFuture<'static, Result<(), String>>| tauri::async_runtime::block_on(f);
        let task = "unimux: new task t1 \"A\" from Lead: read_inbox";
        assert_eq!(block(deps.deliver("w1", task)), Err(NOT_RUNNING.to_string()));
        assert_eq!(block(deps.deliver("gone", task)), Err(NOT_RUNNING.to_string()));
        ctx.cells.set_alive("w1", true);
        block(deps.deliver("w1", task)).unwrap();
        block(deps.deliver("w1", "unimux: new message m1 from Lead: read_inbox")).unwrap();
        let state = ctx.state.get();
        let items = state.pointer("/projects/0/tabs/0/cells/0/promptQueue/items").and_then(Value::as_array).cloned().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["text"], json!("unimux: new task t1 \"A\" from Lead; new message m1 from Lead: read_inbox"));
        assert!(model::id(&items[0]).starts_with(model::NOTICE_PREFIX));
        ctx.saver.stop();
    }

    /// update_agent restart:true answers without touching a terminal when the agent does not qualify.
    #[test]
    fn restart_and_start_refuse_what_they_cannot_start() {
        let project = tempfile::tempdir().unwrap();
        let (_dir, ctx) = app(team_state(project.path().to_str().unwrap()));
        let deps = deps(&ctx);
        let run = |f: BoxFuture<'static, Result<Restart, String>>| tauri::async_runtime::block_on(f).unwrap();
        let r = run(deps.restart_agent("w1").unwrap());
        assert_eq!((r.done, r.reason.as_deref()), (false, Some("Agent is not running.")));
        ctx.cells.set_alive("w1", true);
        let r = run(deps.restart_agent("w1").unwrap());
        assert_eq!(
            (r.done, r.reason.as_deref()),
            (false, Some("Choose a compatible conversation from History before restarting through MCP."))
        );
        let r = run(deps.start_agent("sh").unwrap());
        assert_eq!((r.done, r.reason.as_deref()), (false, Some("Choose an AI agent profile.")));
        let r = run(deps.start_agent("gone").unwrap());
        assert_eq!((r.done, r.reason.as_deref()), (false, Some("Agent cell not found.")));
        ctx.saver.stop();
    }

    #[test]
    fn a_spawn_answer_is_a_restart_outcome() {
        let ok = spawn_outcome(&json!({ "ok": true, "startedWithPrompt": false }));
        assert!(ok.done && ok.reason.is_none());
        let failed = spawn_outcome(&json!({ "ok": false, "error": "Folder nie istnieje: C:\\x" }));
        assert_eq!((failed.done, failed.reason.as_deref()), (false, Some("Folder nie istnieje: C:\\x")));
    }
}
