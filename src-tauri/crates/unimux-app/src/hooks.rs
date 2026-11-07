//! The hook server of this run (H1): started next to the main window (1.1.4 index.ts: `hooks.start()` in parallel with the
//! cell file prune and the MCP server, mark `hooks-started`), its signals turned into `cell:hook` / `cell:session` for the
//! window that shows the cell (`Scope::Cell`, routed by W5), stopped on exit.
//!
//! Later packages hook in here instead of editing the routing: P3 sets which cells run a process (`set_alive`), H2 / H4 / M3
//! add observers (hookWatch, the context tracker, automation statuses, the CLI exit codes) and read the server for the URLs
//! and nonces of a spawn (`server`).

use std::collections::HashSet;
use std::sync::{Arc, Weak};

use parking_lot::{Mutex, RwLock};

use unimux_agents::hooks::route::deliveries;
use unimux_agents::hooks::{HookServer, HookSignal};
use unimux_ipc::Scope;

use crate::context::AppContext;

type Alive = Arc<dyn Fn(&str) -> bool + Send + Sync>;
type Observer = Arc<dyn Fn(&HookSignal) + Send + Sync>;

pub struct Hooks {
    pub server: Arc<HookServer>,
    alive: RwLock<Option<Alive>>,
    observers: RwLock<Vec<Observer>>,
    /// Cells whose Codex notify hook reported in this process (index.ts `codexHooked`): codex:bind (H4) never guesses for them.
    codex_hooked: Mutex<HashSet<String>>,
}

impl Default for Hooks {
    fn default() -> Self {
        Self {
            server: Arc::new(HookServer::new()),
            alive: RwLock::new(None),
            observers: RwLock::new(Vec::new()),
            codex_hooked: Mutex::new(HashSet::new()),
        }
    }
}

impl Hooks {
    /// Which cells run a process now: W7 points it at `AppContext::cells` (the pty service's `alive` set, P3). Until a cell
    /// counts as alive its session switches and Codex turn ends are dropped like late hooks of an old process.
    pub fn set_alive(&self, alive: impl Fn(&str) -> bool + Send + Sync + 'static) {
        *self.alive.write() = Some(Arc::new(alive));
    }

    /// Sees every signal before it is routed (it does its own checks, as the 1.1.4 handlers do).
    #[allow(dead_code, reason = "the extension point of H2 (hookWatch), H4 (context tracker), M3 / P3 (statuses, exit codes)")]
    pub fn observe(&self, observer: impl Fn(&HookSignal) + Send + Sync + 'static) {
        self.observers.write().push(Arc::new(observer));
    }

    pub fn is_alive(&self, cell: &str) -> bool {
        self.alive.read().as_ref().is_some_and(|f| f(cell))
    }

    #[allow(dead_code, reason = "read by codex:bind (H4)")]
    pub fn codex_hooked(&self, cell: &str) -> bool {
        self.codex_hooked.lock().contains(cell)
    }

    /// A Codex spawn of the cell (index.ts: `hooks.prepareCodex(cellId)` then `codexHooked.delete(cellId)`): a fresh nonce
    /// and the notify URL; the cell counts as hooked again only once the new process reports.
    #[allow(dead_code, reason = "called by the Codex spawn (P3)")]
    pub fn prepare_codex(&self, cell: &str) -> String {
        let url = self.server.prepare_codex(cell);
        self.codex_hooked.lock().remove(cell);
        url
    }

    /// The cell is gone for good (index.ts `forgetCell`: `codexHooked.delete(id)`, the hook nonce is dropped). W7's
    /// forgetCell calls the two halves itself: the nonce stays while a process of the cell still runs.
    #[cfg(test)]
    pub fn forget(&self, cell: &str) {
        self.forget_codex_hooked(cell);
        self.server.forget(cell);
    }

    /// `codexHooked.delete(id)` alone (forgetCell drops it even while the process runs).
    pub fn forget_codex_hooked(&self, cell: &str) {
        self.codex_hooked.lock().remove(cell);
    }

    fn route(&self, ctx: &AppContext, signal: HookSignal) {
        let observers: Vec<Observer> = self.observers.read().clone();
        for o in observers {
            o(&signal);
        }
        let snapshot = ctx.state.snapshot();
        let list = deliveries(&snapshot.state, &|cell| self.is_alive(cell), &signal);
        if let (HookSignal::Codex { cell, .. }, false) = (&signal, list.is_empty()) {
            self.codex_hooked.lock().insert(cell.clone());
        }
        for d in list {
            ctx.events.emit(Scope::Cell(d.cell), d.channel, d.args);
        }
    }
}

/// The server's start (W7's startup runs it next to the cell file prune and the MCP server, then opens the cell services
/// gate): a failed listen is logged and the app runs on (hooks fall back to the terminal heuristics, as in 1.1.4).
pub fn start(ctx: &Arc<AppContext>) -> futures::future::BoxFuture<'static, ()> {
    let weak: Weak<AppContext> = Arc::downgrade(ctx);
    ctx.hooks.server.set_handler(Arc::new(move |signal| {
        if let Some(ctx) = weak.upgrade() {
            ctx.hooks.route(&ctx, signal);
        }
    }));
    if ctx.overrides.hook_debug {
        ctx.hooks.server.set_debug_dir(Some(ctx.data_dir.clone()));
    }
    let ctx = ctx.clone();
    Box::pin(async move {
        if let Err(e) = ctx.hooks.server.start().await {
            ctx.crash.error(&format!("hook server did not start: {e}"));
        }
        ctx.mark("hooks-started");
    })
}

/// The wind-down (W6 adds it to the full quit sequence): no new connections.
pub fn stop(ctx: &AppContext) {
    ctx.hooks.server.stop();
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Instant;
    use unimux_agents::hooks::payload::CodexNotice;
    use unimux_core::crash_log::RollingLog;
    use unimux_core::dev_overrides::DevOverrides;
    use unimux_core::startup_timing::{StartupLog, StartupTimer};

    #[test]
    fn observers_see_every_signal_and_a_routed_codex_turn_end_marks_the_cell_hooked() {
        let dir = tempfile::tempdir().unwrap();
        let state = serde_json::json!({
            "version": 1,
            "profiles": [{ "id": "cx", "cli": "codex" }],
            "projects": [{ "tabs": [{ "cells": [{ "id": "c1", "profileId": "cx" }] }] }],
        });
        let ctx = AppContext::new(
            dir.path().to_path_buf(),
            DevOverrides::default(),
            Arc::new(RollingLog::crash_log(dir.path())),
            Arc::new(StartupTimer::new(Instant::now())),
            Arc::new(StartupLog::new(dir.path().join("startup.log"), "")),
            state,
        );
        let seen = Arc::new(AtomicUsize::new(0));
        let s = seen.clone();
        ctx.hooks.observe(move |_| {
            s.fetch_add(1, Ordering::SeqCst);
        });
        let codex = || HookSignal::Codex { cell: "c1".into(), notice: CodexNotice::default() };
        ctx.hooks.route(&ctx, codex());
        assert!(!ctx.hooks.codex_hooked("c1"), "not alive: dropped like a late hook");
        ctx.hooks.set_alive(|cell| cell == "c1");
        ctx.hooks.route(&ctx, codex());
        assert!(ctx.hooks.codex_hooked("c1"));
        ctx.hooks.route(&ctx, HookSignal::CliExit { cell: "c1".into(), code: Some(1) });
        assert_eq!(seen.load(Ordering::SeqCst), 3);
        // A respawn starts unhooked: codex:bind may guess again until the new process reports.
        let old_nonce = ctx.hooks.server.nonce("c1");
        let url = ctx.hooks.prepare_codex("c1");
        assert!(url.ends_with(&format!("/codex/{}", ctx.hooks.server.nonce("c1").unwrap())));
        assert_ne!(ctx.hooks.server.nonce("c1"), old_nonce);
        assert!(!ctx.hooks.codex_hooked("c1"));
        ctx.hooks.route(&ctx, codex());
        assert!(ctx.hooks.codex_hooked("c1"));
        ctx.hooks.forget("c1");
        assert!(!ctx.hooks.codex_hooked("c1"));
        assert_eq!(ctx.hooks.server.nonce("c1"), None);
        ctx.saver.stop();
    }
}
