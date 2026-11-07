//! Port of src/main/startupGates.ts and the gate part of index.ts `startMainApp` (0.9.4): the window opens before the
//! startup steps finish, so what must still come first waits on a one-shot gate instead of delaying the window.
//!
//! - `cell_services`: the hook server and the MCP server listen (their ports are known) and files of removed cells were
//!   pruned. Every agent spawn waits for it (a plain shell only with a startup prompt).
//! - `accounts_recovered`: the recovery of an interrupted account switch finished (the live ~/.claude login is consistent
//!   again). Claude cells wait for it; shells, Codex and SSH cells do not.
//! - `accounts_ready`: the recovery and the account migration finished. Every accounts:, auth: and usage: channel that can
//!   start a swap, an activation, a login, a removal or a reconcile waits for it, and the usage polls start after it.
//!
//! The gates always open: the steps log their errors and the gate opens whatever they answered.

use tokio::sync::watch;

/// A one-shot gate (`createStartupGate`): closed until `open`, then open for good.
pub struct StartupGate {
    tx: watch::Sender<bool>,
}

impl Default for StartupGate {
    fn default() -> Self {
        Self { tx: watch::channel(false).0 }
    }
}

impl StartupGate {
    pub fn open(&self) {
        self.tx.send_replace(true);
    }

    #[cfg_attr(not(any(test, feature = "test-bridge")), allow(dead_code, reason = "read by the test bridge and the tests"))]
    pub fn is_open(&self) -> bool {
        *self.tx.borrow()
    }

    /// Resolves once the gate is open (at once when it already is).
    pub fn wait(&self) -> impl std::future::Future<Output = ()> + Send + 'static {
        let mut rx = self.tx.subscribe();
        async move {
            // The sender lives in the gate, which lives as long as the app; a dropped sender ends the wait too.
            let _ = rx.wait_for(|open| *open).await;
        }
    }
}

/// The three gates of one run.
#[derive(Default)]
pub struct Gates {
    pub cell_services: StartupGate,
    pub accounts_recovered: StartupGate,
    pub accounts_ready: StartupGate,
}

/// Which gate a spawn waits for (`spawnWaitsFor` answers the promises, this the gates in the same order).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Gate {
    CellServices,
    AccountsRecovered,
}

/// `spawnWaitsFor(gates, {cli, startupPrompt})`: every agent waits for the hook and MCP servers, a Claude cell also for the
/// account recovery; a plain shell (also an SSH cell) waits for nothing unless it gets a startup prompt (the prompt file must
/// not be pruned before the shell reads it). `startup_prompt` is trimmed like JavaScript's `trim`.
pub fn spawn_waits_for(cli: &str, startup_prompt: Option<&str>) -> Vec<Gate> {
    let mut waits = Vec::new();
    if cli != "shell" || startup_prompt.is_some_and(|p| !unimux_core::utf16::js_trim(p).is_empty()) {
        waits.push(Gate::CellServices);
    }
    if cli == "claude" {
        waits.push(Gate::AccountsRecovered);
    }
    waits
}

impl Gates {
    pub fn gate(&self, gate: Gate) -> &StartupGate {
        match gate {
            Gate::CellServices => &self.cell_services,
            Gate::AccountsRecovered => &self.accounts_recovered,
        }
    }

    /// Waits for every gate a spawn of `cli` (with that startup prompt) needs (P4's `cell:spawn` awaits it).
    #[allow(dead_code, reason = "awaited by cell:spawn (P4)")]
    pub fn before_spawn(
        &self,
        cli: &str,
        startup_prompt: Option<&str>,
    ) -> impl std::future::Future<Output = ()> + Send + 'static {
        let waits: Vec<_> = spawn_waits_for(cli, startup_prompt).into_iter().map(|g| self.gate(g).wait()).collect();
        async move {
            futures::future::join_all(waits).await;
        }
    }

    /// `{cellServices, accountsRecovered, accountsReady}` as booleans (test bridge, `cells`).
    #[cfg_attr(not(feature = "test-bridge"), allow(dead_code, reason = "read by the test bridge"))]
    pub fn report(&self) -> serde_json::Value {
        serde_json::json!({
            "cellServices": self.cell_services.is_open(),
            "accountsRecovered": self.accounts_recovered.is_open(),
            "accountsReady": self.accounts_ready.is_open(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    /// Whether `wait` ends within a few polls (startup-gates.test.ts `settles`).
    async fn settles(wait: impl std::future::Future<Output = ()>) -> bool {
        tokio::time::timeout(Duration::from_millis(30), wait).await.is_ok()
    }

    #[tokio::test]
    async fn a_claude_cell_waits_for_the_hook_mcp_servers_and_for_the_account_recovery() {
        let g = Gates::default();
        assert_eq!(spawn_waits_for("claude", None), vec![Gate::CellServices, Gate::AccountsRecovered]);
        g.cell_services.open();
        assert!(!settles(g.before_spawn("claude", None)).await);
        g.accounts_recovered.open();
        assert!(settles(g.before_spawn("claude", None)).await);
        assert!(g.accounts_recovered.is_open());
    }

    #[tokio::test]
    async fn a_codex_cell_waits_for_the_servers_only_never_for_the_account_recovery() {
        let g = Gates::default();
        assert_eq!(spawn_waits_for("codex", None), vec![Gate::CellServices]);
        assert!(!settles(g.before_spawn("codex", None)).await);
        g.cell_services.open();
        assert!(settles(g.before_spawn("codex", None)).await);
        assert!(!g.accounts_recovered.is_open());
    }

    #[test]
    fn a_plain_shell_also_an_ssh_cell_waits_for_nothing_unless_it_gets_a_startup_prompt() {
        assert_eq!(spawn_waits_for("shell", None), vec![]);
        assert_eq!(spawn_waits_for("shell", Some("  ")), vec![]);
        // JavaScript's trim also drops a no-break space and the line separators.
        assert_eq!(spawn_waits_for("shell", Some("\u{a0}\u{2028}\t\n")), vec![]);
        assert_eq!(spawn_waits_for("shell", Some("echo hi")), vec![Gate::CellServices]);
    }

    /// A waiter that started before the open is woken by it; a gate opened twice stays open; waits after the open end at once.
    #[tokio::test]
    async fn a_gate_opens_once_for_every_waiter() {
        let gate = Arc::new(StartupGate::default());
        let done = Arc::new(AtomicBool::new(false));
        let (g, d) = (gate.clone(), done.clone());
        let task = tokio::spawn(async move {
            g.wait().await;
            d.store(true, Ordering::SeqCst);
        });
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(!done.load(Ordering::SeqCst));
        gate.open();
        gate.open();
        task.await.unwrap();
        assert!(done.load(Ordering::SeqCst));
        assert!(settles(gate.wait()).await);
        assert!(gate.is_open());
    }
}
