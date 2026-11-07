//! The startup steps behind the main window (index.ts `startMainApp` after `createWindow`) and the gates they open:
//!
//! - in parallel: the cell file prune (H2 registers it, mark `cell-files-pruned`), the hook server (`hooks-started`) and the
//!   MCP server (`mcp-started`); when all three ended: mark `cell-services-ready`, open `cell_services`;
//! - the account work (`recoverAccounts`): the recovery of an interrupted swap (A2) -> open `accounts_recovered`; the account
//!   migration (A1 / A2) -> mark `accounts-migrated`; then open `accounts_ready` and run what waits for it (usage.start and
//!   the swap-pending push, A5 / A2).
//!
//! A step that fails or panics never keeps a gate closed (1.1.4's `.catch` / `finally`).

use std::panic::AssertUnwindSafe;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::BoxFuture;
use parking_lot::Mutex;

use crate::context::AppContext;

pub type Step = Arc<dyn Fn() -> BoxFuture<'static, ()> + Send + Sync>;
type Then = Arc<dyn Fn() + Send + Sync>;

/// What the domains add to the startup (set while the router is built, run once in setup).
#[derive(Default)]
pub struct Steps {
    prune: Mutex<Option<Step>>,
    recovery: Mutex<Option<Step>>,
    migration: Mutex<Option<Step>>,
    accounts_ready: Mutex<Vec<(&'static str, Then)>>,
}

impl Steps {
    /// H2: `pruneCellFiles(dirs, cellIdsOf(state, false))`, before any cell can start.
    #[allow(dead_code, reason = "the cell file prune (H2) registers here")]
    pub fn set_cell_file_prune(&self, step: Step) {
        *self.prune.lock() = Some(step);
    }

    /// A2: `recoverActivation()` (an interrupted swap or "Set as main").
    #[allow(dead_code, reason = "the activation recovery (A2) registers here")]
    pub fn set_account_recovery(&self, step: Step) {
        *self.recovery.lock() = Some(step);
    }

    /// A1 / A2: `migrateAccounts()` (0.9.0 -> 0.9.1 identities and duplicates, once).
    #[allow(dead_code, reason = "the account migration (A1 / A2) registers here")]
    pub fn set_account_migration(&self, step: Step) {
        *self.migration.lock() = Some(step);
    }

    /// Runs once `accounts_ready` opened (usage.start A5, pushSwapPending A2).
    #[allow(dead_code, reason = "usage.start (A5) and the swap-pending push (A2) register here")]
    pub fn on_accounts_ready(&self, name: &'static str, then: impl Fn() + Send + Sync + 'static) {
        self.accounts_ready.lock().push((name, Arc::new(then)));
    }
}

/// Runs a step to its end; a panic is logged and counts as done.
async fn run_step(ctx: &AppContext, name: &str, step: Option<Step>) -> bool {
    let Some(step) = step else { return false };
    if AssertUnwindSafe(step()).catch_unwind().await.is_err() {
        ctx.crash.error(&format!("startup step {name} panicked"));
    }
    true
}

/// The cell services: the prune, the hook server and the MCP server in parallel, then the gate.
pub fn cell_services(
    ctx: &Arc<AppContext>,
    hooks: BoxFuture<'static, ()>,
    mcp: BoxFuture<'static, ()>,
) -> BoxFuture<'static, ()> {
    let ctx = ctx.clone();
    async move {
        let prune = ctx.startup_steps.prune.lock().clone();
        let c = ctx.clone();
        let prune = async move {
            if run_step(&c, "cell file prune", prune).await {
                c.mark("cell-files-pruned");
            }
        };
        let c = ctx.clone();
        let hooks = async move {
            if AssertUnwindSafe(hooks).catch_unwind().await.is_err() {
                c.crash.error("startup step hook server panicked");
            }
        };
        let c = ctx.clone();
        let mcp = async move {
            if AssertUnwindSafe(mcp).catch_unwind().await.is_err() {
                c.crash.error("startup step MCP server panicked");
            }
        };
        futures::join!(prune, hooks, mcp);
        ctx.mark("cell-services-ready");
        ctx.cells.gates.cell_services.open();
    }
    .boxed()
}

/// `recoverAccounts()` and the gates behind it.
pub fn accounts(ctx: &Arc<AppContext>) -> BoxFuture<'static, ()> {
    let ctx = ctx.clone();
    async move {
        let recovery = ctx.startup_steps.recovery.lock().clone();
        run_step(&ctx, "account recovery", recovery).await;
        ctx.cells.gates.accounts_recovered.open();
        let migration = ctx.startup_steps.migration.lock().clone();
        run_step(&ctx, "account migration", migration).await;
        ctx.mark("accounts-migrated");
        ctx.cells.gates.accounts_recovered.open();
        ctx.cells.gates.accounts_ready.open();
        let then: Vec<_> = ctx.startup_steps.accounts_ready.lock().clone();
        for (name, f) in then {
            if std::panic::catch_unwind(AssertUnwindSafe(|| f())).is_err() {
                ctx.crash.error(&format!("startup step {name} panicked"));
            }
        }
    }
    .boxed()
}

/// Starts both on the async runtime (the window does not wait for them).
pub fn start(ctx: &Arc<AppContext>, hooks: BoxFuture<'static, ()>, mcp: BoxFuture<'static, ()>) {
    tauri::async_runtime::spawn(cell_services(ctx, hooks, mcp));
    tauri::async_runtime::spawn(accounts(ctx));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use crate::cells::test_ctx;

    fn marks(ctx: &AppContext) -> String {
        ctx.timer.line()
    }

    /// The cell services gate opens only when the prune, the hook server and the MCP server all ended, with the marks of
    /// 1.1.4 (`cell-files-pruned` only when a prune ran); a step that panics still opens it.
    #[tokio::test]
    async fn the_cell_services_gate_waits_for_all_three_steps_and_always_opens() {
        let (_dir, ctx, _router) = test_ctx(serde_json::json!({ "version": 1, "projects": [] }));
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let slow_mcp = async move {
            let _ = rx.await;
        }
        .boxed();
        let task = tokio::spawn(cell_services(&ctx, async {}.boxed(), slow_mcp));
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!ctx.cells.gates.cell_services.is_open(), "the MCP server still starts");
        let _ = tx.send(());
        task.await.unwrap();
        assert!(ctx.cells.gates.cell_services.is_open());
        assert!(marks(&ctx).contains("cell-services-ready="));
        assert!(!marks(&ctx).contains("cell-files-pruned"), "no prune registered (H2), no mark");

        let (_dir2, ctx2, _router2) = test_ctx(serde_json::json!({ "version": 1, "projects": [] }));
        ctx2.startup_steps.set_cell_file_prune(Arc::new(|| async { panic!("prune failed") }.boxed()));
        cell_services(&ctx2, async { panic!("hooks failed") }.boxed(), async {}.boxed()).await;
        assert!(ctx2.cells.gates.cell_services.is_open());
        assert!(marks(&ctx2).contains("cell-files-pruned="));
        let crash = std::fs::read_to_string(ctx2.crash.path()).unwrap_or_default();
        assert!(crash.contains("startup step cell file prune panicked"), "{crash}");
        ctx.saver.stop();
        ctx2.saver.stop();
    }

    /// recoverAccounts: `accounts_recovered` opens after the recovery (before the migration), `accounts_ready` after both,
    /// then what waits for it runs; without the A1 / A2 steps both open at once.
    #[tokio::test]
    async fn the_account_gates_open_in_order() {
        let (_dir, ctx, _router) = test_ctx(serde_json::json!({ "version": 1, "projects": [] }));
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        let rx = Arc::new(Mutex::new(Some(rx)));
        ctx.startup_steps.set_account_migration(Arc::new(move || {
            let rx = rx.lock().take();
            async move {
                if let Some(rx) = rx {
                    let _ = rx.await;
                }
            }
            .boxed()
        }));
        let order: Arc<Mutex<Vec<&'static str>>> = Arc::default();
        let o = order.clone();
        ctx.startup_steps.set_account_recovery(Arc::new(move || {
            let o = o.clone();
            async move { o.lock().push("recovery") }.boxed()
        }));
        let (o, c) = (order.clone(), ctx.clone());
        ctx.startup_steps.on_accounts_ready("usage", move || {
            assert!(c.cells.gates.accounts_ready.is_open());
            o.lock().push("usage.start");
        });
        let task = tokio::spawn(accounts(&ctx));
        tokio::time::timeout(Duration::from_secs(2), ctx.cells.gates.accounts_recovered.wait()).await.unwrap();
        assert!(!ctx.cells.gates.accounts_ready.is_open(), "the migration still runs");
        let _ = tx.send(());
        task.await.unwrap();
        assert!(ctx.cells.gates.accounts_ready.is_open());
        assert_eq!(*order.lock(), vec!["recovery", "usage.start"]);
        assert!(marks(&ctx).contains("accounts-migrated="));

        let (_dir2, ctx2, _router2) = test_ctx(serde_json::json!({ "version": 1, "projects": [] }));
        accounts(&ctx2).await;
        assert!(ctx2.cells.gates.accounts_recovered.is_open() && ctx2.cells.gates.accounts_ready.is_open());
        ctx.saver.stop();
        ctx2.saver.stop();
    }
}
