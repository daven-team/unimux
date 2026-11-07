//! W7: the core cell bookkeeping of src/main/index.ts, the one place every domain plugs its per-cell cleanup into.
//!
//! - The state change hook (index.ts `new StateController(state, ...)`): when the projects change, the MCP tokens of team
//!   cells that left the grids are revoked (`mcp.revokeCell`), every cell that left the state for good (archive emptied,
//!   project removed) is forgotten (`forgetCell`, the domain parts only while no process of it runs), and the open tasks of
//!   agents the user closed or archived are cancelled after the change settled (`automation.cancelOrphans`). Every change
//!   then reaches the domains' `stateChanged` hooks (ssh / db / taskbar / limit alerts / usage).
//! - The cells whose terminal runs (`alive`, filled by the pty service, P3), read by the taskbar count, the hook routing, the
//!   detached windows and forgetCell.
//! - `cell:runtime` (a window's StatusTracker reports a cell's status): relayed to the main window for detached grids, counted
//!   by the taskbar, and handed to the observers (hookWatch H2, CLI ends P3 / M3, automation statuses M3) for cells that exist
//!   and run.
//! - The startup gates (gates.rs) and the startup steps that open them (startup.rs).
//!
//! Hooks are registered by the domains while the router is built (commands::register_all) or in setup; they run inside the
//! controller's change, so they must not change the state themselves (the settled hooks run outside it).

pub mod gates;
pub mod startup;

use std::collections::HashSet;
use std::sync::Arc;

use parking_lot::RwLock;
use serde_json::Value;

use unimux_state::normalize::js::truthy;

type CellFn = Arc<dyn Fn(&str) + Send + Sync>;
type ChangeFn = Arc<dyn Fn(&Value, &Value) + Send + Sync>;
type SettledFn = Arc<dyn Fn() + Send + Sync>;
type RuntimeFn = Arc<dyn Fn(&CellReport) + Send + Sync>;
/// Runs a settled hook after the change that queued it (queueMicrotask): on the async runtime in the app, inline in tests.
type Defer = Arc<dyn Fn(Box<dyn FnOnce() + Send>) + Send + Sync>;

/// One `cell:runtime` report of a cell that exists and runs: what the observers hear.
#[derive(Debug, Clone, PartialEq)]
pub struct CellReport {
    pub cell: String,
    /// One of the CellStatus values (idle, working, waiting, exited) or anything the renderer sent; observers check it.
    pub status: String,
    pub reason: Option<String>,
    /// The status came from the agent's hooks (heuristics never yield "ready").
    pub hooked: bool,
    /// 1.1.3: the agent CLI ended inside a shell that still runs.
    pub cli_ended: bool,
    /// The CLI's exit code (an integer only).
    pub exit_code: Option<i64>,
}

#[derive(Default)]
struct Registry {
    revoke: Vec<(&'static str, CellFn)>,
    forget_always: Vec<(&'static str, CellFn)>,
    forget_unless_alive: Vec<(&'static str, CellFn)>,
    settled: Vec<(&'static str, SettledFn)>,
    changed: Vec<(&'static str, ChangeFn)>,
    runtime: Vec<(&'static str, RuntimeFn)>,
}

/// The cell bookkeeping of one run (`AppContext::cells`).
pub struct Cells {
    alive: RwLock<HashSet<String>>,
    registry: RwLock<Registry>,
    pub gates: gates::Gates,
    defer: Defer,
}

impl Default for Cells {
    fn default() -> Self {
        Self::with_defer(Arc::new(|f| {
            tauri::async_runtime::spawn(async move { f() });
        }))
    }
}

impl Cells {
    pub fn with_defer(defer: Defer) -> Self {
        Self { alive: RwLock::new(HashSet::new()), registry: RwLock::new(Registry::default()), gates: Default::default(), defer }
    }

    // ── registration (the domains) ───────────────────────────────────────────

    /// A team cell (one with a role) left the grids (closed or archived): its MCP token goes (`mcp.revokeCell`).
    pub fn on_revoke(&self, name: &'static str, hook: impl Fn(&str) + Send + Sync + 'static) {
        self.registry.write().revoke.push((name, Arc::new(hook)));
    }

    /// A cell left the state for good: what is dropped even while its process still runs (codexHooked, verifiedCodex).
    pub fn on_forget(&self, name: &'static str, hook: impl Fn(&str) + Send + Sync + 'static) {
        self.registry.write().forget_always.push((name, Arc::new(hook)));
    }

    /// A cell left the state for good and no process of it runs: hook settings, MCP config, context tracker, taskbar,
    /// cell files, automation bookkeeping (a process that still runs keeps them; the next start prunes them).
    pub fn on_forget_unless_alive(&self, name: &'static str, hook: impl Fn(&str) + Send + Sync + 'static) {
        self.registry.write().forget_unless_alive.push((name, Arc::new(hook)));
    }

    /// After a change of the projects settled, outside the controller (`automation.cancelOrphans`, M3).
    #[allow(dead_code, reason = "automation.cancelOrphans (M3) registers here")]
    pub fn on_projects_settled(&self, name: &'static str, hook: impl Fn() + Send + Sync + 'static) {
        self.registry.write().settled.push((name, Arc::new(hook)));
    }

    /// Every state change, `(previous, next)` (ssh / db stateChanged, taskbar invalidate, limit alerts, usage reschedule).
    pub fn on_state_changed(&self, name: &'static str, hook: impl Fn(&Value, &Value) + Send + Sync + 'static) {
        self.registry.write().changed.push((name, Arc::new(hook)));
    }

    /// `cell:runtime` of a cell that exists in a grid and runs (hookWatch H2, CLI ends P3 / M3, automation statuses M3).
    #[allow(dead_code, reason = "hookWatch (H2), cliEnd (P3 / M3) and the automation statuses (M3) register here")]
    pub fn on_runtime(&self, name: &'static str, hook: impl Fn(&CellReport) + Send + Sync + 'static) {
        self.registry.write().runtime.push((name, Arc::new(hook)));
    }

    // ── the cells whose terminal runs (P3) ───────────────────────────────────

    pub fn is_alive(&self, cell: &str) -> bool {
        self.alive.read().contains(cell)
    }

    /// The pty service started (`true`) or lost (`false`) a cell's process (index.ts `alive.add` / `alive.delete`).
    #[cfg_attr(not(test), allow(dead_code, reason = "the pty service (P3) calls it on spawn and exit"))]
    pub fn set_alive(&self, cell: &str, alive: bool) {
        let mut set = self.alive.write();
        if alive {
            set.insert(cell.to_string());
        } else {
            set.remove(cell);
        }
    }

    /// The running cells are exactly `cells` (the check build's test bridge stands in for P3 with it).
    #[cfg(feature = "test-bridge")]
    pub fn replace_alive(&self, cells: impl IntoIterator<Item = String>) {
        *self.alive.write() = cells.into_iter().collect();
    }

    /// Every running cell (the pty host crashed: none run any more).
    #[allow(dead_code, reason = "the pty host crash path (P3) clears it")]
    pub fn clear_alive(&self) {
        self.alive.write().clear();
    }

    /// The running cells now, sorted (the taskbar count, `cell:alive`, the test bridge).
    #[cfg_attr(not(feature = "test-bridge"), allow(dead_code, reason = "cell:alive (P3) answers it; the test bridge reads it"))]
    pub fn alive(&self) -> Vec<String> {
        let mut list: Vec<String> = self.alive.read().iter().cloned().collect();
        list.sort();
        list
    }

    pub fn alive_set(&self) -> HashSet<String> {
        self.alive.read().clone()
    }

    // ── what happens ─────────────────────────────────────────────────────────

    /// The controller's change hook: the per-cell bookkeeping when the projects changed, then the domains' hooks.
    pub fn state_changed(&self, previous: &Value, next: &Value) {
        let (revoke, forget_always, forget_unless_alive, settled, changed) = {
            let r = self.registry.read();
            (r.revoke.clone(), r.forget_always.clone(), r.forget_unless_alive.clone(), r.settled.clone(), r.changed.clone())
        };
        if previous.get("projects") != next.get("projects") {
            // One pass over each state (a lookup per cell was quadratic in the number of cells).
            let roles = cell_ids_of(next, true, has_role);
            for id in cell_ids_of(previous, true, has_role) {
                if !roles.contains(&id) {
                    for (_, hook) in &revoke {
                        hook(&id);
                    }
                }
            }
            let kept = cell_ids_of(next, false, |_| true);
            for id in cell_ids_of(previous, false, |_| true) {
                if !kept.contains(&id) {
                    self.forget_cell(&id, &forget_always, &forget_unless_alive);
                }
            }
            // 1.1.4: open tasks of agents the user closed or archived are cancelled ("agent closed"), after this change settled.
            if !settled.is_empty() {
                (self.defer)(Box::new(move || {
                    for (_, hook) in &settled {
                        hook();
                    }
                }));
            }
        }
        for (_, hook) in &changed {
            hook(previous, next);
        }
    }

    /// `forgetCell(id)`: a cell left the state for good.
    fn forget_cell(&self, id: &str, always: &[(&'static str, CellFn)], unless_alive: &[(&'static str, CellFn)]) {
        for (_, hook) in always {
            hook(id);
        }
        // A process that still runs keeps its hook settings and MCP config (Claude may read them again).
        if self.is_alive(id) {
            return;
        }
        for (_, hook) in unless_alive {
            hook(id);
        }
    }

    /// The observers of a `cell:runtime` report; called for cells that exist and run only (`findCell && alive.has`).
    pub fn runtime_report(&self, report: &CellReport) {
        let hooks = self.registry.read().runtime.clone();
        for (_, hook) in &hooks {
            hook(report);
        }
    }

    /// What is registered, by kind (test bridge `cells`, so a real-app check sees which domains are wired).
    #[cfg_attr(not(feature = "test-bridge"), allow(dead_code, reason = "read by the test bridge"))]
    pub fn report(&self) -> Value {
        let r = self.registry.read();
        let names = |list: &[&'static str]| Value::Array(list.iter().map(|n| Value::String((*n).to_string())).collect());
        serde_json::json!({
            "alive": self.alive(),
            "gates": self.gates.report(),
            "hooks": {
                "revoke": names(&r.revoke.iter().map(|(n, _)| *n).collect::<Vec<_>>()),
                "forget": names(&r.forget_always.iter().map(|(n, _)| *n).collect::<Vec<_>>()),
                "forgetUnlessAlive": names(&r.forget_unless_alive.iter().map(|(n, _)| *n).collect::<Vec<_>>()),
                "projectsSettled": names(&r.settled.iter().map(|(n, _)| *n).collect::<Vec<_>>()),
                "stateChanged": names(&r.changed.iter().map(|(n, _)| *n).collect::<Vec<_>>()),
                "runtime": names(&r.runtime.iter().map(|(n, _)| *n).collect::<Vec<_>>()),
            },
        })
    }
}

fn list(v: Option<&Value>) -> &[Value] {
    v.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// `!!cell.role` (JavaScript truthiness).
fn has_role(cell: &Value) -> bool {
    truthy(cell.get("role"))
}

/// `cellIdsOf(state, tabsOnly, keep)`: ids of the cells of every project's grids (and, unless `tabs_only`, its archive), in
/// the order a JavaScript Set keeps them (first sight), without repeats.
pub fn cell_ids_of(state: &Value, tabs_only: bool, keep: impl Fn(&Value) -> bool) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut ids = Vec::new();
    for project in list(state.get("projects")) {
        let archive = if tabs_only { &[][..] } else { list(project.get("archive")) };
        for tab in list(project.get("tabs")).iter().chain(archive) {
            for cell in list(tab.get("cells")) {
                if !keep(cell) {
                    continue;
                }
                if let Some(id) = cell.get("id").and_then(Value::as_str)
                    && seen.insert(id.to_string())
                {
                    ids.push(id.to_string());
                }
            }
        }
    }
    ids
}

/// The `cell:runtime` arguments `(cellId, status, reason?, hooked?, cliEnded?, exitCode?)` as the 1.1.4 handler reads them:
/// `hooked` / `cliEnded` only when `true`, the exit code only when it is an integer. None when the cell id or the status is
/// not a string.
pub fn parse_runtime(args: &[Value]) -> Option<CellReport> {
    let arg = |i: usize| args.get(i).unwrap_or(&Value::Null);
    let cell = arg(0).as_str()?.to_string();
    let status = arg(1).as_str()?.to_string();
    let exit_code = arg(5).as_f64().filter(|f| f.fract() == 0.0 && f.is_finite()).map(|f| f as i64);
    Some(CellReport {
        cell,
        status,
        reason: arg(2).as_str().map(str::to_string),
        hooked: arg(3) == &Value::Bool(true),
        cli_ended: arg(4) == &Value::Bool(true),
        exit_code,
    })
}

#[cfg(test)]
mod tests;

/// An app context on a scratch data dir with every domain registered (tests of the wiring); stop its saver at the end.
#[cfg(test)]
pub(crate) fn test_ctx(state: Value) -> (tempfile::TempDir, Arc<crate::context::AppContext>, unimux_ipc::Router) {
    use unimux_core::crash_log::RollingLog;
    use unimux_core::dev_overrides::DevOverrides;
    use unimux_core::startup_timing::{StartupLog, StartupTimer};
    let dir = tempfile::tempdir().unwrap();
    let ctx = crate::context::AppContext::new(
        dir.path().to_path_buf(),
        DevOverrides::default(),
        Arc::new(RollingLog::crash_log(dir.path())),
        Arc::new(StartupTimer::new(std::time::Instant::now())),
        Arc::new(StartupLog::new(dir.path().join("startup.log"), "header")),
        state,
    );
    let mut builder = unimux_ipc::RouterBuilder::new(unimux_ipc::Contract::embedded());
    crate::commands::register_all(&mut builder, &ctx);
    assert!(builder.errors().is_empty(), "{:?}", builder.errors());
    let router = builder.build(ctx.guard.clone());
    (dir, ctx, router)
}
