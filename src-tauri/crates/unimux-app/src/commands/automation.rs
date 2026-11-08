//! M3: the automation service of this run (unimux-mcp `AutomationService`, 1.1.4 src/main/automation.ts) and its wiring in
//! the app (index.ts `new AutomationService(controller, {...})` and the runtime calls around it):
//!
//! - [`AppDeps`], what the service needs from the app: worktrees through the one git engine (G4, `commands::git`), the
//!   new cells' start (`automation:start-cells`, routed to the windows that own the cells), the cached CLI detection for
//!   create_grid's `unavailable`, stopCells over the pty service (`kill_cells_and_wait`), the running cells, the context
//!   tracker, and the inbox notice through the cell's prompt queue.
//! - `automation:execute` (the renderer, no actor: the user), `automation:statuses` pushed at most every 250 ms (pushLater).
//! - The runtime: a spawn / exit / kill / crash of a cell's process (pty `on_cell`), the renderer's statuses (`cell:runtime`
//!   observers, cliEnd), the hook hints, cancelOrphans after a projects change settled and forgetCell.
//!
//! Open slots: the safe restart and the start of an exited agent need P4's spawn (`restart_agent` / `start_agent` answer
//! "unavailable" until P4 fills [`set_spawner`]); the Codex `codex queue` delivery of a verified session is M4 (the prompt
//! queue reaches every agent meanwhile).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::RwLock;
use serde_json::{Value, json};
use unimux_agents::hooks::HookSignal;
use unimux_agents::hooks::route::find_cell;
use unimux_ipc::RouterBuilder;
use unimux_mcp::service::{AutomationDeps, Restart, model};
use unimux_mcp::tools::BoxFuture;
use unimux_mcp::{AutomationService, OpError};

use crate::cells::CellReport;
use crate::commands::pty::CellEvent;
use crate::context::AppContext;

/// The restart / start of an agent's CLI through the cell spawn (P4 fills it): `(cell, resume_only)`. `resume_only` true is
/// the safe restart on the confirmed session (restartAgent), false the start of an exited agent (startExitedAgent).
pub type AgentSpawner = Arc<dyn Fn(String, bool) -> BoxFuture<'static, Result<Restart, String>> + Send + Sync>;

static SPAWNER: RwLock<Option<AgentSpawner>> = RwLock::new(None);

/// P4 registers how update_agent restart:true restarts or starts an agent (index.ts `restartAgent` / `startExitedAgent`).
#[allow(dead_code, reason = "the cell spawn (P4) registers here")]
pub fn set_spawner(spawner: AgentSpawner) {
    *SPAWNER.write() = Some(spawner);
}

const NOT_RUNNING: &str = "Agent is not running. The item is available in its MCP inbox.";
const QUEUE_FULL: &str = "The prompt queue of this agent is full. The item is available in its MCP inbox.";

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
        let spawner = SPAWNER.read().clone()?;
        Some(spawner(cell.to_string(), true))
    }

    fn start_agent(&self, cell: &str) -> Option<BoxFuture<'static, Result<Restart, String>>> {
        let spawner = SPAWNER.read().clone()?;
        Some(spawner(cell.to_string(), false))
    }

    /// 1.1.4: a short inbox notice reaches every running team agent through its prompt queue, which sends it when the agent
    /// sits idle at its prompt and pauses for permissions, questions and the user typing. (A verified Codex session takes it
    /// through `codex queue` first: M4.)
    fn deliver(&self, cell: &str, notice: &str) -> BoxFuture<'static, Result<(), String>> {
        let result = (|| {
            let ctx = self.ctx()?;
            let state = ctx.state.get();
            if find_cell(&state, cell).is_none() || !ctx.cells.is_alive(cell) || self.exited(cell) {
                return Err(NOT_RUNNING.to_string());
            }
            let mut queued = false;
            let changed = ctx.state.change(
                |s| {
                    let Some((pi, ti, ci)) = model::locate(s, cell) else { return Err(String::new()) };
                    let current = s["projects"][pi]["tabs"][ti]["cells"][ci].get("promptQueue");
                    let pending = current
                        .is_some_and(|q| model::list(q, "items").iter().any(|i| model::id(i).starts_with(model::NOTICE_PREFIX)));
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
        })();
        Box::pin(async move { result })
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
}
