//! The hook server of this run (H1): started next to the main window (1.1.4 index.ts: `hooks.start()` in parallel with the
//! cell file prune and the MCP server, mark `hooks-started`), its signals turned into `cell:hook` / `cell:session` for the
//! window that shows the cell (`Scope::Cell`, routed by W5), stopped on exit.
//!
//! H2 adds what a Claude spawn needs around it: the per-cell settings file in `hooks/` with the hook form of the cell's
//! claude version ([`Hooks::claude_spawn`], called by P4's cell:spawn), the http hook watch (20 s grace,
//! `claude-hook-fallback.json`, one `app:notice` per run; fed by the hook signals here, the renderer statuses of
//! `cell:runtime` through [`Hooks::cell_status`] and the process ends through [`Hooks::process_ended`]), the startup prompt
//! files ([`Hooks::write_prompt`], [`Hooks::queue_prompt`] / [`Hooks::release_prompt`]) and the cell file cleanup (prune at
//! startup, mark `cell-files-pruned`, awaitable as [`Hooks::cell_files_pruned`]; [`Hooks::forget`]). The proxy bypass of
//! a Claude cell's environment is `unimux_agents::hooks::claude::bypass_proxy_for_hooks(env, PLATFORM)`.
//!
//! Later packages hook in here instead of editing the routing: P3 sets which cells run a process (`set_alive`), H4 / M3
//! add observers (the context tracker, automation statuses, the CLI exit codes) and read the server for the URLs and nonces
//! of a spawn (`server`).

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use serde_json::json;

use unimux_agents::cell_files::{self, CellFileDirs, Kind, PromptFiles};
use unimux_agents::hooks::claude::{ClaudeHookForm, claude_hook_form};
use unimux_agents::hooks::fallback::{
    self, FALLBACK_FILE, HttpHookWatch, HttpHookWatchDeps, TimerId, Timers, claude_settings_files, http_hook_url_allowed,
    read_settings_texts,
};
use unimux_agents::hooks::route::{deliveries, find_cell};
use unimux_agents::hooks::{HookServer, HookSignal};
use unimux_core::i18n::translate;
use unimux_ipc::Scope;

use crate::context::AppContext;

/// The `app:notice` of a fallback to command hooks (index.ts `hookWatch.onFallback`).
const FALLBACK_NOTICE: &str = "Statusy Claude nie docierają przez hooki HTTP (blokuje je polityka allowedHttpHookUrls albo komórka uruchamia starszą wersję claude). Od następnego uruchomienia agenta unimux użyje hooków poleceń.";

/// Node's `process.platform` of this build.
pub const PLATFORM: &str = if cfg!(windows) {
    "win32"
} else if cfg!(target_os = "macos") {
    "darwin"
} else {
    "linux"
};

/// `setTimeout` on the async runtime for the http hook watch.
#[derive(Default)]
struct RuntimeTimers {
    next: AtomicU64,
    tasks: Arc<Mutex<HashMap<TimerId, tauri::async_runtime::JoinHandle<()>>>>,
}

impl Timers for RuntimeTimers {
    fn set(&self, ms: u64, f: Box<dyn FnOnce() + Send>) -> TimerId {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let tasks = self.tasks.clone();
        // The map lock is held while the task is stored, so a timer that fires at once still finds (and drops) its entry.
        let mut map = self.tasks.lock();
        let task = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            let mine = tasks.lock().remove(&id).is_some();
            if mine {
                f();
            }
        });
        map.insert(id, task);
        id
    }

    fn clear(&self, id: TimerId) {
        let task = self.tasks.lock().remove(&id);
        if let Some(task) = task {
            task.abort();
        }
    }
}

type Notice = Arc<dyn Fn() + Send + Sync>;

type Alive = Arc<dyn Fn(&str) -> bool + Send + Sync>;
type Observer = Arc<dyn Fn(&HookSignal) + Send + Sync>;

pub struct Hooks {
    pub server: Arc<HookServer>,
    alive: RwLock<Option<Alive>>,
    observers: RwLock<Vec<Observer>>,
    /// Cells whose Codex notify hook reported in this process (index.ts `codexHooked`): codex:bind (H4) never guesses for them.
    codex_hooked: Mutex<HashSet<String>>,
    /// H2: Claude cells whose http hooks never arrive fall back to command hooks (index.ts `hookWatch`).
    pub watch: Arc<HttpHookWatch>,
    /// H2: `hooks/`, `prompts/`, `mcp/` in the data dir.
    pub cell_files: CellFileDirs,
    /// The startup prompt file of each spawn of a cell, oldest first (index.ts `prompts`).
    prompts: Mutex<PromptFiles>,
    prompt_seq: AtomicU64,
    /// Shows the fallback's `app:notice` (set by [`start`]; before that nothing can spawn).
    notice: Arc<RwLock<Option<Notice>>>,
    /// True once the startup prune of the cell files ran (part of 1.1.4's `cellServicesReady` gate a spawn waits for).
    pruned: tokio::sync::watch::Sender<bool>,
}

impl Hooks {
    pub fn new(data_dir: &Path) -> Self {
        let notice: Arc<RwLock<Option<Notice>>> = Arc::default();
        let show = notice.clone();
        let (load, save) = fallback::fallback_store(data_dir.join(FALLBACK_FILE));
        let watch = HttpHookWatch::new(HttpHookWatchDeps {
            load,
            save,
            on_fallback: Box::new(move || {
                let notice = show.read().clone();
                if let Some(n) = notice {
                    n();
                }
            }),
            timers: Arc::new(RuntimeTimers::default()),
        });
        Self {
            server: Arc::new(HookServer::new()),
            alive: RwLock::new(None),
            observers: RwLock::new(Vec::new()),
            codex_hooked: Mutex::new(HashSet::new()),
            watch,
            cell_files: CellFileDirs::in_data_dir(data_dir),
            // The shell read the startup prompt when it started the agent; the task text does not stay on disk.
            prompts: Mutex::new(PromptFiles::new(|file| {
                let _ = std::fs::remove_file(file);
            })),
            prompt_seq: AtomicU64::new(0),
            notice,
            pruned: tokio::sync::watch::Sender::new(false),
        }
    }

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

    /// The cell is gone for good (index.ts `forgetCell`: `codexHooked.delete(id)`; unless a process still runs, the hook
    /// nonce is dropped and its hook settings, prompt and MCP files go; a running process keeps them, the next start prunes
    /// them). W7's forgetCell calls the two halves itself ([`Hooks::forget_codex_hooked`], [`Hooks::forget_files`]).
    #[cfg(test)]
    pub fn forget(&self, cell: &str) {
        self.forget_codex_hooked(cell);
        if self.is_alive(cell) {
            return;
        }
        self.forget_files(cell);
    }

    /// The half of forgetCell that waits until no process of the cell runs: the hook nonce and the cell's hook settings,
    /// prompt and MCP files.
    pub fn forget_files(&self, cell: &str) {
        self.server.forget(cell);
        cell_files::remove_cell_files(&self.cell_files, cell, &Kind::ALL);
    }

    /// The hook settings of a Claude spawn (index.ts cell:spawn): the version's hook form, command hooks once http hooks were
    /// found blocked or when an `allowedHttpHookUrls` list (managed policy, user or project settings) does not allow
    /// 127.0.0.1; writes `hooks/claude-<cell>.json` (a fresh nonce) and starts watching the cell. `env` is the cell's
    /// environment (CLAUDE_CONFIG_DIR, ProgramFiles), `version` the `claude --version` its PATH starts.
    #[allow(dead_code, reason = "called by cell:spawn (P4)")]
    pub fn claude_spawn(
        &self,
        cell: &str,
        version: Option<&str>,
        env: &[(String, String)],
        cwd: &str,
    ) -> std::io::Result<PathBuf> {
        let mut form = self.watch.form_for(claude_hook_form(version), version);
        if form != ClaudeHookForm::Shell {
            let home = unimux_core::home::home_dir().to_string_lossy().into_owned();
            let files = claude_settings_files(PLATFORM, &home, env, cwd);
            let url = format!("http://127.0.0.1:{}/k/{cell}/stop/0", self.server.port());
            if !http_hook_url_allowed(&read_settings_texts(&files), &url) {
                form = ClaudeHookForm::Shell;
            }
        }
        let path = self.server.write_claude_settings(&self.cell_files.hooks, cell, version, Some(form))?;
        self.watch.spawned(cell, form, version);
        Ok(path)
    }

    /// A spawn of a cell that does not run Claude (index.ts `hookWatch.forget` in cell:spawn).
    #[allow(dead_code, reason = "called by cell:spawn (P4)")]
    pub fn other_spawn(&self, cell: &str) {
        self.watch.forget(cell);
    }

    /// The renderer's status of a live cell (`cell:runtime`: `hookWatch.status`); the caller checks the cell exists and runs.
    #[allow(dead_code, reason = "called by cell:runtime (P3 / W7)")]
    pub fn cell_status(&self, cell: &str, status: &str, hooked: bool) {
        self.watch.status(cell, status, hooked);
    }

    /// The cell's process ended or was killed (the pty exit, cell:kill: `hookWatch.forget`).
    #[allow(dead_code, reason = "called by the pty exit and cell:kill (P3)")]
    pub fn process_ended(&self, cell: &str) {
        self.watch.forget(cell);
    }

    /// Writes the startup prompt of a spawn to `prompts/<cell>-<seq36>.txt` (index.ts cell:spawn) and returns its path.
    #[allow(dead_code, reason = "called by cell:spawn (P4)")]
    pub fn write_prompt(&self, cell: &str, text: &str) -> std::io::Result<PathBuf> {
        std::fs::create_dir_all(&self.cell_files.prompts)?;
        let seq = self.prompt_seq.fetch_add(1, Ordering::Relaxed) + 1;
        let file = self.cell_files.prompts.join(format!("{cell}-{}.txt", base36(seq)));
        std::fs::write(&file, text)?;
        Ok(file)
    }

    /// The spawn's prompt file (None for a spawn without one), released when that process ends.
    #[allow(dead_code, reason = "called by cell:spawn (P4)")]
    pub fn queue_prompt(&self, cell: &str, file: Option<PathBuf>) {
        self.prompts.lock().queue(cell, file);
    }

    /// An exit or a failed spawn of the cell's oldest process: its prompt file goes.
    #[allow(dead_code, reason = "called by the pty exit and spawnError (P3)")]
    pub fn release_prompt(&self, cell: &str) {
        self.prompts.lock().release(cell);
    }

    /// Resolves once the startup prune of the cell files ran (at once afterwards). P4's cell:spawn waits for it with the
    /// hook and MCP servers (index.ts `cellServicesReady`): a spawn must not write files the prune would remove.
    #[allow(dead_code, reason = "awaited by cell:spawn (P4)")]
    pub async fn cell_files_pruned(&self) {
        let mut rx = self.pruned.subscribe();
        let _ = rx.wait_for(|done| *done).await;
    }

    /// The terminal service is gone: no process will report an exit any more.
    #[allow(dead_code, reason = "called by the pty service crash path (P3)")]
    pub fn release_all_prompts(&self) {
        self.prompts.lock().release_all();
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

/// `(n).toString(36)`.
fn base36(mut n: u64) -> String {
    let mut digits = Vec::new();
    loop {
        digits.push(b"0123456789abcdefghijklmnopqrstuvwxyz"[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    digits.reverse();
    String::from_utf8(digits).expect("ASCII")
}

/// The hook watch hears the hooks of cells of the state (index.ts: `hookWatch.hook` in the 'hook' and 'sessionstart'
/// handlers, after their `findCell` check), and the fallback notice goes to the main window.
fn watch_hooks(ctx: &Arc<AppContext>) {
    let weak: Weak<AppContext> = Arc::downgrade(ctx);
    ctx.hooks.observe(move |signal| {
        let Some(ctx) = weak.upgrade() else { return };
        let (cell, event) = match signal {
            HookSignal::Hook { cell, event, .. } => (cell, event.as_str()),
            HookSignal::SessionStart { cell, .. } => (cell, "session"),
            _ => return,
        };
        if find_cell(&ctx.state.get(), cell).is_some() {
            ctx.hooks.watch.hook(cell, event);
        }
    });
    let weak: Weak<AppContext> = Arc::downgrade(ctx);
    *ctx.hooks.notice.write() = Some(Arc::new(move || {
        let Some(ctx) = weak.upgrade() else { return };
        let text = translate(&crate::commands::os::language(&ctx.state.get()), FALLBACK_NOTICE, &[]);
        ctx.events.emit(Scope::Main, "app:notice", vec![json!(text)]);
    }));
}

/// Before any cell can start: files of removed cells (in no grid and not in the archive) and every old startup prompt go
/// (index.ts `pruneCellFiles`). W7's startup runs it as its cell file prune step next to the hook and MCP servers and marks
/// `cell-files-pruned` when it ended (also after a failure).
fn register_cell_file_prune(ctx: &Arc<AppContext>) {
    let weak: Weak<AppContext> = Arc::downgrade(ctx);
    ctx.startup_steps.set_cell_file_prune(Arc::new(move || {
        let weak = weak.clone();
        Box::pin(async move {
            let Some(ctx) = weak.upgrade() else { return };
            let keep = cell_files::cell_ids_of(&ctx.state.get(), false);
            let dirs = ctx.hooks.cell_files.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || cell_files::prune_cell_files(&dirs, &keep)).await;
            ctx.hooks.pruned.send_replace(true);
        })
    }));
}

/// The server's start (W7's startup runs it next to the cell file prune and the MCP server, then opens the cell services
/// gate): a failed listen is logged and the app runs on (hooks fall back to the terminal heuristics, as in 1.1.4). The cell
/// file prune is registered as W7's prune step here.
pub fn start(ctx: &Arc<AppContext>) -> futures::future::BoxFuture<'static, ()> {
    register_cell_file_prune(ctx);
    watch_hooks(ctx);
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
        // forgetCell: codexHooked always goes; a process that still runs keeps its nonce (H2: and its cell files).
        ctx.hooks.forget("c1");
        assert!(!ctx.hooks.codex_hooked("c1"));
        assert!(ctx.hooks.server.nonce("c1").is_some());
        ctx.hooks.set_alive(|_| false);
        ctx.hooks.forget("c1");
        assert_eq!(ctx.hooks.server.nonce("c1"), None);
        ctx.saver.stop();
    }

    fn context(dir: &Path, state: serde_json::Value) -> Arc<AppContext> {
        AppContext::new(
            dir.to_path_buf(),
            DevOverrides::default(),
            Arc::new(RollingLog::crash_log(dir)),
            Arc::new(StartupTimer::new(Instant::now())),
            Arc::new(StartupLog::new(dir.join("startup.log"), "")),
            state,
        )
    }

    fn one_claude_cell() -> serde_json::Value {
        serde_json::json!({
            "version": 1,
            "profiles": [{ "id": "cl", "cli": "claude" }],
            "projects": [{ "tabs": [{ "cells": [{ "id": "c1", "profileId": "cl" }] }], "archive": [{ "cells": [{ "id": "old" }] }] }],
        })
    }

    fn stop_type(p: &Path) -> String {
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
        v["hooks"]["Stop"][0]["hooks"][0]["type"].as_str().unwrap().to_string()
    }

    #[test]
    fn a_claude_spawn_writes_the_settings_of_its_version_and_a_blocking_allow_list_gives_command_hooks() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context(dir.path(), one_claude_cell());
        let project = dir.path().join("project");
        std::fs::create_dir_all(project.join(".claude")).unwrap();
        let cwd = project.display().to_string();
        let local = project.join(".claude").join("settings.local.json");
        let env = vec![("CLAUDE_CONFIG_DIR".to_string(), dir.path().join("cfg").display().to_string())];
        let spawn = |v: Option<&str>| ctx.hooks.claude_spawn("c1", v, &env, &cwd).unwrap();

        let path = spawn(Some("2.1.310"));
        assert_eq!(path, dir.path().join("hooks").join("claude-c1.json"));
        assert_eq!(stop_type(&path), "http");
        assert!(std::fs::read_to_string(&path).unwrap().contains("\"PermissionRequest\""));
        assert_eq!(stop_type(&spawn(Some("2.1.62"))), "command");
        assert_eq!(stop_type(&spawn(None)), "command");

        // A project list without 127.0.0.1, then one that allows it.
        std::fs::write(&local, r#"{"allowedHttpHookUrls":["https://example.com/*"]}"#).unwrap();
        assert_eq!(stop_type(&spawn(Some("2.1.310"))), "command");
        std::fs::write(&local, r#"{"allowedHttpHookUrls":["http://127.0.0.1:*"]}"#).unwrap();
        assert_eq!(stop_type(&spawn(Some("2.1.310"))), "http");
        // The user's settings of the cell's CLAUDE_CONFIG_DIR count too (any list may allow it).
        std::fs::create_dir_all(dir.path().join("cfg")).unwrap();
        std::fs::write(dir.path().join("cfg").join("settings.json"), r#"{"allowedHttpHookUrls":[]}"#).unwrap();
        assert_eq!(stop_type(&spawn(Some("2.1.310"))), "http");
        std::fs::remove_file(&local).unwrap();
        assert_eq!(stop_type(&spawn(Some("2.1.310"))), "command");
        ctx.saver.stop();
    }

    #[test]
    fn the_watch_hears_hooks_of_cells_of_the_state_and_a_remembered_fallback_gives_command_hooks() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(FALLBACK_FILE), r#"{"claudeVersion":"2.1.300"}"#).unwrap();
        let ctx = context(dir.path(), one_claude_cell());
        watch_hooks(&ctx);
        let cwd = dir.path().display().to_string();
        assert_eq!(stop_type(&ctx.hooks.claude_spawn("c1", Some("2.1.300"), &[], &cwd).unwrap()), "command");
        assert_eq!(stop_type(&ctx.hooks.claude_spawn("c1", Some("2.1.301"), &[], &cwd).unwrap()), "http");
        // A SessionStart, then "working" from output: the grace timer runs; an http hook of the cell ends the watch, a hook
        // of a cell that is not in the state does not.
        ctx.hooks.route(&ctx, HookSignal::SessionStart { cell: "c1".into(), source: None });
        ctx.hooks.cell_status("c1", "working", false);
        ctx.hooks.route(&ctx, HookSignal::Hook { cell: "ghost".into(), event: "prompt".into(), info: None });
        ctx.hooks.route(&ctx, HookSignal::Hook { cell: "c1".into(), event: "prompt".into(), info: None });
        ctx.hooks.cell_status("c1", "working", false);
        assert_eq!(std::fs::read_to_string(dir.path().join(FALLBACK_FILE)).unwrap(), r#"{"claudeVersion":"2.1.300"}"#);
        ctx.hooks.process_ended("c1");
        ctx.hooks.other_spawn("c1");
        ctx.saver.stop();
    }

    #[test]
    fn the_runtime_timers_fire_once_and_a_cleared_one_never() {
        let timers = RuntimeTimers::default();
        let fired = Arc::new(AtomicUsize::new(0));
        let (a, b) = (fired.clone(), fired.clone());
        timers.set(
            30,
            Box::new(move || {
                a.fetch_add(1, Ordering::SeqCst);
            }),
        );
        let cleared = timers.set(
            30,
            Box::new(move || {
                b.fetch_add(10, Ordering::SeqCst);
            }),
        );
        timers.clear(cleared);
        let deadline = Instant::now() + Duration::from_secs(10);
        while fired.load(Ordering::SeqCst) == 0 && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(10));
        }
        std::thread::sleep(Duration::from_millis(200));
        assert_eq!(fired.load(Ordering::SeqCst), 1);
        assert!(timers.tasks.lock().is_empty());
    }

    #[test]
    fn startup_prompts_are_named_per_spawn_and_released_oldest_first() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = context(dir.path(), one_claude_cell());
        let a = ctx.hooks.write_prompt("c1", "task one").unwrap();
        let b = ctx.hooks.write_prompt("c1", "task two").unwrap();
        assert_eq!(a, dir.path().join("prompts").join("c1-1.txt"));
        assert_eq!(b, dir.path().join("prompts").join("c1-2.txt"));
        assert_eq!(std::fs::read_to_string(&a).unwrap(), "task one");
        ctx.hooks.queue_prompt("c1", Some(a.clone()));
        ctx.hooks.queue_prompt("c1", Some(b.clone()));
        ctx.hooks.release_prompt("c1");
        assert!(!a.exists() && b.exists());
        ctx.hooks.release_all_prompts();
        assert!(!b.exists());
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        assert_eq!(base36(1_295), "zz");
        ctx.saver.stop();
    }

    #[test]
    fn startup_prunes_files_of_removed_cells_and_forget_keeps_the_files_of_a_running_process() {
        let dir = tempfile::tempdir().unwrap();
        let d = CellFileDirs::in_data_dir(dir.path());
        for folder in [&d.hooks, &d.prompts, &d.mcp] {
            std::fs::create_dir_all(folder).unwrap();
        }
        for id in ["c1", "old", "gone"] {
            std::fs::write(d.hooks.join(format!("claude-{id}.json")), "{}").unwrap();
            std::fs::write(d.mcp.join(format!("{id}.json")), "{}").unwrap();
            std::fs::write(d.prompts.join(format!("{id}-1.txt")), "task").unwrap();
        }
        let ctx = context(dir.path(), one_claude_cell());
        // The prune runs as W7's cell file prune step (W7 marks `cell-files-pruned` when it ended).
        register_cell_file_prune(&ctx);
        let services = crate::cells::startup::cell_services(
            &ctx,
            Box::pin(futures::future::ready(())),
            Box::pin(futures::future::ready(())),
        );
        tauri::async_runtime::block_on(async {
            tokio::time::timeout(Duration::from_secs(10), services).await.expect("the cell services ran");
            tokio::time::timeout(Duration::from_secs(10), ctx.hooks.cell_files_pruned()).await.expect("the prune ran");
        });
        assert!(ctx.timer.has("cell-files-pruned"));
        let names = |p: &Path| {
            let mut n: Vec<String> =
                std::fs::read_dir(p).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
            n.sort();
            n
        };
        assert_eq!(names(&d.hooks), ["claude-c1.json", "claude-old.json"]);
        assert_eq!(names(&d.mcp), ["c1.json", "old.json"]);
        assert!(names(&d.prompts).is_empty());
        // A running process keeps its files; once it is gone they go with the cell.
        ctx.hooks.set_alive(|cell| cell == "c1");
        ctx.hooks.forget("c1");
        assert!(d.hooks.join("claude-c1.json").exists());
        ctx.hooks.set_alive(|_| false);
        ctx.hooks.forget("c1");
        assert!(!d.hooks.join("claude-c1.json").exists() && !d.mcp.join("c1.json").exists());
        ctx.saver.stop();
    }
}
