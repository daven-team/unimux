//! Commands of the `agents` domain: H1-H6: CLI detection and install, sessions, context, conversation search, agent prompts (cli:*, install:*, codex:*, context:*, sessions:*, conv:*, agents:*).
//!
//! Registered by `register` only; nothing else in the app is edited when a package lands. Until then the router answers
//! the domain's channels with `MC_NOT_YET` (see `npm run ipc:report`).
//!
//! H3 (CLI detector): `cli:status`, `cli:recheck`, `cli:openDocs`, the `cli:changed` broadcast, the startup scan and the
//! registry refresh on a main-window focus ([`app_started`]). Later packages (P4 cell spawn, H6 install, M4 automation) reach
//! the detector through [`cli_detector`].
//!
//! H4 (context meter, sessions, codex bind): `context:get`, the `cell:context` events of the context tracker (poked by the
//! hook server's signals), `sessions:list` and `codex:bind`. P3 (cell removal) and M4 (list_agents) reach the tracker through
//! [`context_tracker`].

use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::{Manager, WindowEvent};
use unimux_agents::cli::{CliDetector, CliHandlers, SystemCliDeps, SystemOptions};
use unimux_agents::context::{ContextTarget, ContextTracker, ContextTrackerDeps, ContextUsage};
use unimux_agents::conv::service::{self, ConvSearchService};
use unimux_agents::hooks::HookSignal;
use unimux_agents::hooks::route;
use unimux_agents::sessions::{self, SessionIndex, state as sessions_state};
use unimux_core::home;
use unimux_ipc::{RouterBuilder, Scope};

use crate::context::AppContext;

/// The one detector of this app run (index.ts `cliDetector`).
static DETECTOR: OnceLock<Arc<CliDetector>> = OnceLock::new();

/// The detector, created on first use with the real I/O: settings.shell of the live state decides the probe shell;
/// `MC_CLI_NO_REGISTRY` / `MC_CLI_PROBE_PROFILE` only in dev-overrides builds (the struct is empty in release).
pub fn cli_detector(ctx: &Arc<AppContext>) -> Arc<CliDetector> {
    DETECTOR
        .get_or_init(|| {
            let state = ctx.state.clone();
            let detector = CliDetector::new(SystemCliDeps::new(SystemOptions {
                disable_registry: ctx.overrides.cli_no_registry,
                shell: Some(Arc::new(move || {
                    state.get().get("settings").and_then(|s| s.get("shell")).and_then(Value::as_str).map(str::to_string)
                })),
                probe_profile: ctx.overrides.cli_probe_profile.clone().filter(|p| !p.is_empty()),
            }));
            // Every announced change goes to every window (`cli:changed` is a broadcast channel).
            let events = ctx.events.clone();
            detector.on_change(move |map| {
                events.emit(Scope::Broadcast, "cli:changed", vec![serde_json::to_value(map).unwrap_or(Value::Null)]);
            });
            detector
        })
        .clone()
}

fn register_cli(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let detector = cli_detector(ctx);
    let handlers = Arc::new(CliHandlers::new(detector, |url: &str| unimux_platform::open_url(url)));

    // Open channel (any app window): the cached detection, never a new one.
    let h = handlers.clone();
    r.invoke("cli:status", move |_| {
        let h = h.clone();
        async move { Ok(serde_json::to_value(h.status()).unwrap_or(Value::Null)) }
    });

    // Starts processes: guarded by the router (only app windows reach it). Repeated clicks share one recheck.
    let h = handlers.clone();
    r.invoke("cli:recheck", move |call| {
        let h = h.clone();
        async move {
            let run = h.recheck(call.arg(0)).map_err(|m| call.fail(m))?;
            Ok(serde_json::to_value(run.await).unwrap_or(Value::Null))
        }
    });

    let h = handlers.clone();
    r.send("cli:openDocs", move |call| {
        let h = h.clone();
        async move {
            h.open_docs(call.arg(0));
        }
    });
}

/// After the main window exists (index.ts: `void cliDetector.refreshAll()` after the window, and `win.on('focus')`): the
/// startup scan runs in the background (the window never waits; spawns wait only for their own CLI), and a focus of the main
/// window makes the next spawn re-read the registry PATH (the user may come back from an installer).
pub fn app_started(ctx: &Arc<AppContext>) {
    let detector = cli_detector(ctx);
    let d = detector.clone();
    tauri::async_runtime::spawn(async move {
        d.refresh_all().await;
    });
    if let Some(window) = ctx.app().and_then(|app| app.get_webview_window("main")) {
        window.on_window_event(move |event| {
            if let WindowEvent::Focused(true) = event {
                detector.invalidate_registry();
            }
        });
    }
}

/// The conversation search of the app (H5), kept so the exit can let it save its index (the last registered one).
static CONV: Mutex<Option<Arc<ConvSearchService>>> = Mutex::new(None);

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    register_cli(r, ctx);
    register_conv(r, ctx);
    register_context(r, ctx);
    register_sessions(r, ctx);
}

// ── H4: context meter, sessions, codex bind ──────────────────────────────────

/// `process.env.X?.trim() || fallback` of index.ts.
fn env_dir(var: &str, fallback: impl FnOnce() -> PathBuf) -> PathBuf {
    match std::env::var(var) {
        Ok(v) if !unimux_agents::conv::text::trim(&v).is_empty() => PathBuf::from(unimux_agents::conv::text::trim(&v)),
        _ => fallback(),
    }
}

/// The context tracker's view of the app: the live state, the cell's window for `cell:context`, the CLI folders.
struct TrackerDeps {
    ctx: Weak<AppContext>,
    /// Claude's config folder and Codex's home when not the environment's (tests: scratch folders).
    dirs: Option<(PathBuf, PathBuf)>,
}

impl ContextTrackerDeps for TrackerDeps {
    fn target(&self, cell: &str) -> Option<ContextTarget> {
        let ctx = self.ctx.upgrade()?;
        let snapshot = ctx.state.snapshot();
        sessions_state::context_target(&snapshot.state, cell)
    }
    fn emit(&self, cell: &str, usage: Option<&ContextUsage>) {
        if let Some(ctx) = self.ctx.upgrade() {
            let usage = usage.map_or(Value::Null, ContextUsage::to_json);
            ctx.events.emit(Scope::Cell(cell.to_string()), "cell:context", vec![json!(cell), usage]);
        }
    }
    fn claude_dir(&self) -> PathBuf {
        match &self.dirs {
            Some((claude, _)) => claude.clone(),
            None => env_dir("CLAUDE_CONFIG_DIR", || home::home_dir().join(".claude")),
        }
    }
    fn codex_home(&self) -> PathBuf {
        match &self.dirs {
            Some((_, codex)) => codex.clone(),
            None => env_dir("CODEX_HOME", || home::home_dir().join(".codex")),
        }
    }
}

/// The context tracker of each app context (index.ts `contextTracker`), created by [`register`]. Kept per context, so a
/// context (a test's) never sees the tracker another one registered.
static TRACKERS: Mutex<Vec<(Weak<AppContext>, Arc<ContextTracker>)>> = Mutex::new(Vec::new());

/// The tracker of `ctx` for P3 (`forget` when a cell leaves the state for good) and M4 (`current` for list_agents).
#[allow(dead_code, reason = "read by P3 (forgetCell) and M4 (list_agents) once they land")]
pub fn context_tracker(ctx: &AppContext) -> Option<Arc<ContextTracker>> {
    TRACKERS.lock().iter().find(|(c, _)| std::ptr::eq(c.as_ptr(), ctx)).map(|(_, t)| t.clone())
}

/// Which hook signals ask the tracker for a refresh (the `contextTracker` lines of the index.ts hook handlers).
fn poke_for(tracker: &Arc<ContextTracker>, ctx: &AppContext, signal: &HookSignal) {
    match signal {
        HookSignal::Hook { cell, event, .. } => {
            if route::find_cell(&ctx.state.snapshot().state, cell).is_some() {
                tracker.poke(cell, matches!(event.as_str(), "stop" | "stopbg" | "fail" | "compacted"));
            }
        }
        HookSignal::SessionStart { cell, .. } => {
            if route::find_cell(&ctx.state.snapshot().state, cell).is_some() {
                tracker.poke(cell, true);
            }
        }
        HookSignal::Transcript { session_id, path, .. } => tracker.note_transcript(session_id, path),
        HookSignal::Codex { cell, .. } => {
            let snapshot = ctx.state.snapshot();
            let codex =
                route::find_cell(&snapshot.state, cell).is_some_and(|c| route::cell_cli(&snapshot.state, c) == Some("codex"));
            if codex && ctx.hooks.is_alive(cell) {
                tracker.poke(cell, true);
            }
        }
        HookSignal::Session { .. } | HookSignal::CliExit { .. } => {}
    }
}

fn register_context(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    register_context_with(r, ctx, None);
}

/// [`register_context`] with the CLI folders given (`dirs`: Claude's config folder and Codex's home) or, for None, taken
/// from the environment. Returns the tracker the handlers use.
fn register_context_with(r: &mut RouterBuilder, ctx: &Arc<AppContext>, dirs: Option<(PathBuf, PathBuf)>) -> Arc<ContextTracker> {
    let rt = tauri::async_runtime::handle().inner().clone();
    let tracker = ContextTracker::new(TrackerDeps { ctx: Arc::downgrade(ctx), dirs }, rt);
    {
        let mut trackers = TRACKERS.lock();
        trackers.retain(|(c, _)| c.strong_count() > 0 && !std::ptr::eq(c.as_ptr(), Arc::as_ptr(ctx)));
        trackers.push((Arc::downgrade(ctx), tracker.clone()));
    }
    let weak = Arc::downgrade(ctx);
    let t = tracker.clone();
    ctx.hooks.observe(move |signal| {
        if let Some(ctx) = weak.upgrade() {
            poke_for(&t, &ctx, signal);
        }
    });

    // guardedHandle('context:get'): a known cell's usage, read now (null for anything else).
    let weak = Arc::downgrade(ctx);
    let handler = tracker.clone();
    r.invoke("context:get", move |call| {
        let (t, weak) = (handler.clone(), weak.clone());
        async move {
            let Some(ctx) = weak.upgrade() else { return Ok(Value::Null) };
            let Some(cell) = call.arg(0).as_str().map(str::to_string) else { return Ok(Value::Null) };
            if route::find_cell(&ctx.state.snapshot().state, &cell).is_none() {
                return Ok(Value::Null);
            }
            Ok(t.get(&cell).await.map_or(Value::Null, |u| u.to_json()))
        }
    });
    tracker
}

/// The session listing of this run (the sessions.ts module caches) and the Codex session ids handed to cells this run
/// (index.ts `claimedCodex`).
static SESSIONS: OnceLock<Arc<SessionIndex>> = OnceLock::new();
static CLAIMED_CODEX: Mutex<Option<HashSet<String>>> = Mutex::new(None);

fn session_index() -> Arc<SessionIndex> {
    SESSIONS.get_or_init(|| Arc::new(SessionIndex::new())).clone()
}

/// `currentBranch(path)` of src/main/worktree.ts: `git rev-parse --abbrev-ref HEAD` (15 s), None for a detached HEAD or any
/// failure. Called on the blocking pool.
fn current_branch(rt: &tokio::runtime::Handle, path: &str) -> Option<String> {
    use unimux_git::runner::{GitOptions, RunOptions, Runner};
    let timeout = Duration::from_secs(15);
    let runner = Runner::new(GitOptions { read_timeout: timeout, ..GitOptions::default() });
    let options = RunOptions::read(timeout);
    let out = rt.block_on(runner.run(path, &["rev-parse", "--abbrev-ref", "HEAD"], &options, || None)).ok()?;
    let branch = out.stdout.trim();
    (!branch.is_empty() && branch != "HEAD").then(|| branch.to_string())
}

fn register_sessions(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    // sessions:list (an open channel, as in 1.1.4): the project's conversations and those of its worktree folders.
    let weak = Arc::downgrade(ctx);
    r.invoke("sessions:list", move |call| {
        let weak = weak.clone();
        async move {
            let ctx = weak.upgrade().ok_or_else(|| call.fail("The app is closing."))?;
            // A non-string path made normalizeProjectPath throw: the call was rejected.
            let Some(project) = call.arg(0).as_str().map(str::to_string) else {
                return Err(call.fail("path.replace is not a function"));
            };
            let worktrees = sessions_state::project_worktrees(&ctx.state.snapshot().state, &project);
            let rt = tauri::async_runtime::handle().inner().clone();
            let listed = tauri::async_runtime::spawn_blocking(move || {
                let branch_of = |path: &str| current_branch(&rt, path);
                session_index().list_sessions(&home::home_dir(), &project, &worktrees, Some(&branch_of))
            })
            .await;
            match listed {
                Ok(Ok(list)) => Ok(sessions::to_json(&list)),
                Ok(Err(e)) => Err(call.fail(e.to_string())),
                Err(e) => Err(call.fail(e.to_string())),
            }
        }
    });

    // guardedHandle('codex:bind'): Codex picks its own session id; right after a Codex cell finished a turn its rollout file
    // was just written, so the freshest unclaimed one in that cwd is the cell's.
    let weak = Arc::downgrade(ctx);
    r.invoke("codex:bind", move |call| {
        let weak = weak.clone();
        async move {
            let Some(ctx) = weak.upgrade() else { return Ok(Value::Null) };
            let (Some(cell), Some(cwd)) = (call.arg(0).as_str().map(str::to_string), call.arg(1).as_str().map(str::to_string))
            else {
                return Ok(Value::Null);
            };
            let alive = |c: &str| ctx.hooks.is_alive(c);
            // Shared-directory simultaneous starts are ambiguous: never guess a message recipient.
            if !sessions_state::sole_codex_cell_in(&ctx.state.snapshot().state, &alive, &cell, &cwd) {
                return Ok(Value::Null);
            }
            // Its notify hook binds the exact thread; a timestamp guess must never overwrite it.
            if ctx.hooks.codex_hooked(&cell) {
                return Ok(Value::Null);
            }
            let bound = || {
                let claimed = CLAIMED_CODEX.lock().clone().unwrap_or_default();
                sessions_state::bound_codex_ids(&ctx.state.snapshot().state, &claimed)
            };
            let exclude = bound();
            let found = tauri::async_runtime::spawn_blocking(move || {
                session_index().find_recent_codex_session(&home::home_dir(), &cwd, Duration::from_secs(20), &exclude)
            })
            .await
            .map_err(|e| call.fail(e.to_string()))?
            .map_err(|e| call.fail(e.to_string()))?;
            // Re-checked after the file reads: the cell may have been closed, hooked or the id claimed meanwhile.
            let Some(id) = found else { return Ok(Value::Null) };
            if !ctx.hooks.is_alive(&cell) || ctx.hooks.codex_hooked(&cell) || id.as_str().is_some_and(|i| bound().contains(i)) {
                return Ok(Value::Null);
            }
            if let Some(i) = id.as_str() {
                CLAIMED_CODEX.lock().get_or_insert_with(HashSet::new).insert(i.to_string());
            }
            ctx.events.emit(
                Scope::Cell(cell.clone()),
                "cell:session",
                vec![json!(cell), json!({ "cli": "codex", "id": id, "confirmed": false })],
            );
            Ok(id)
        }
    });
}

/// What the app does for this domain when it exits: the conversation index saves itself (1.1.4's `will-quit` stop).
pub fn on_exit() {
    let conv = CONV.lock().clone();
    if let Some(conv) = conv {
        conv.stop();
    }
}

/// Runs a blocking conversation search call off the async runtime; a failed join answers `fallback`.
async fn blocking(work: impl FnOnce() -> Value + Send + 'static, fallback: impl FnOnce() -> Value) -> Value {
    tauri::async_runtime::spawn_blocking(work).await.unwrap_or_else(|_| fallback())
}

/// conv:search, conv:transcript, conv:export (H5): the index lives in a Rust thread instead of 1.1.4's eval'd worker.
fn register_conv(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let conv = ConvSearchService::for_data_dir(ctx.data_dir.clone());
    *CONV.lock() = Some(conv.clone());

    let c = conv.clone();
    r.invoke("conv:search", move |call| {
        let c = c.clone();
        async move {
            let query = service::sanitize_query(call.arg(0));
            Ok(blocking(move || c.search(query), || service::search_failed(None)).await)
        }
    });

    let c = conv.clone();
    r.invoke("conv:transcript", move |call| {
        let c = c.clone();
        async move {
            let Some(file) = call.arg(0).as_str().filter(|f| !f.is_empty()).map(str::to_string) else {
                return Ok(service::transcript_failed(None));
            };
            Ok(blocking(move || c.transcript(file), || service::transcript_failed(None)).await)
        }
    });

    let c = conv;
    r.invoke("conv:export", move |call| {
        let c = c.clone();
        async move {
            let Some(source) = service::sanitize_export_source(call.arg(0)) else { return Ok(service::no_export()) };
            Ok(blocking(move || c.export_data(source), service::no_export).await)
        }
    });
}

#[cfg(test)]
mod tests {
    //! The conv:* wiring. Only answers that never start the index (a search would read the CLI folders of the environment);
    //! the index itself is tested in unimux-agents (tests/conv_index.rs, tests/conv_golden.rs).
    use super::*;
    use std::time::Instant;
    use unimux_core::crash_log::RollingLog;
    use unimux_core::dev_overrides::DevOverrides;
    use unimux_core::startup_timing::{StartupLog, StartupTimer};
    use unimux_ipc::router::Status;
    use unimux_ipc::{Call, Caller, Contract, Guard, Reply};

    struct Open;
    impl Guard for Open {
        fn allowed(&self, _: &Caller) -> bool {
            true
        }
    }

    #[test]
    fn conv_channels_answer_bad_requests_like_main_without_starting_the_index() {
        let _one = crate::commands::REGISTER_LOCK.lock();
        let dir = tempfile::tempdir().unwrap();
        let ctx = AppContext::new(
            dir.path().to_path_buf(),
            DevOverrides::default(),
            Arc::new(RollingLog::crash_log(dir.path())),
            Arc::new(StartupTimer::new(Instant::now())),
            Arc::new(StartupLog::new(dir.path().join("startup.log"), "")),
            serde_json::json!({"version": 1, "projects": []}),
        );
        let mut builder = RouterBuilder::new(Contract::embedded());
        register(&mut builder, &ctx);
        assert!(builder.errors().is_empty(), "{:?}", builder.errors());
        let router = builder.build(Arc::new(Open));
        for channel in ["conv:search", "conv:transcript", "conv:export"] {
            assert_eq!(router.status(channel), Status::Implemented, "{channel}");
        }
        let ask = |channel: &str, args: Vec<Value>| match tauri::async_runtime::block_on(router.invoke(Call::new(
            channel,
            Caller::new("main", "http://tauri.localhost/"),
            args,
        ))) {
            Ok(Reply::Json(v)) => v,
            _ => panic!("{channel}: no JSON answer"),
        };
        let refused = serde_json::json!({"ok": false, "messages": [], "capped": false});
        assert_eq!(ask("conv:transcript", vec![]), refused);
        assert_eq!(ask("conv:transcript", vec![serde_json::json!("")]), refused);
        assert_eq!(ask("conv:transcript", vec![serde_json::json!(5)]), refused);
        assert_eq!(ask("conv:export", vec![]), service::no_export());
        assert_eq!(ask("conv:export", vec![serde_json::json!({"cli": "claude", "id": "../x"})]), service::no_export());
        assert_eq!(ask("conv:export", vec![serde_json::json!({"cli": "gemini", "id": "abc"})]), service::no_export());
        let conv = CONV.lock().clone().expect("registered");
        assert!(!conv.running(), "a refused request must not start the index");
        on_exit();
        assert!(!dir.path().join("conversation-index-v2.bin").exists());
        ctx.saver.stop();
    }

    /// H4: context:get through a transcript a hook named (the tracker's CLI folders are scratch ones, so no CLI folder of the
    /// environment is read), the refusals of sessions:list and codex:bind that never read a home folder.
    #[test]
    fn context_sessions_and_codex_bind_channels_answer_like_main() {
        let _one = crate::commands::REGISTER_LOCK.lock();
        let dir = tempfile::tempdir().unwrap();
        const SESSION: &str = "3f2b9c1e-7a4d-4e21-9b0a-5c6d7e8f9a01";
        let state = json!({
            "version": 1,
            "profiles": [{ "id": "cl", "cli": "claude" }, { "id": "cx", "cli": "codex" }],
            "projects": [{ "id": "p", "path": dir.path().join("proj").to_string_lossy(), "tabs": [{ "cells": [
                { "id": "c1", "profileId": "cl", "session": { "cli": "claude", "id": SESSION } },
                { "id": "x1", "profileId": "cx" },
            ] }] }],
        });
        let ctx = AppContext::new(
            dir.path().to_path_buf(),
            DevOverrides::default(),
            Arc::new(RollingLog::crash_log(dir.path())),
            Arc::new(StartupTimer::new(Instant::now())),
            Arc::new(StartupLog::new(dir.path().join("startup.log"), "")),
            state,
        );
        let mut builder = RouterBuilder::new(Contract::embedded());
        let scratch = (dir.path().join("claude-config"), dir.path().join("codex-home"));
        let tracker = register_context_with(&mut builder, &ctx, Some(scratch));
        register_sessions(&mut builder, &ctx);
        assert!(builder.errors().is_empty(), "{:?}", builder.errors());
        let router = builder.build(Arc::new(Open));
        assert!(context_tracker(&ctx).is_some_and(|t| Arc::ptr_eq(&t, &tracker)), "the context's own tracker");
        for channel in ["context:get", "sessions:list", "codex:bind"] {
            assert_eq!(router.status(channel), Status::Implemented, "{channel}");
        }
        let call = |channel: &str, args: Vec<Value>| {
            tauri::async_runtime::block_on(router.invoke(Call::new(
                channel,
                Caller::new("main", "http://tauri.localhost/"),
                args,
            )))
        };
        let ask = |channel: &str, args: Vec<Value>| match call(channel, args) {
            Ok(Reply::Json(v)) => v,
            _ => panic!("{channel}: no JSON answer"),
        };
        let transcript = dir.path().join("account").join(format!("{SESSION}.jsonl"));
        std::fs::create_dir_all(transcript.parent().unwrap()).unwrap();
        let line = json!({ "type": "assistant", "message": { "model": "claude-sonnet-4-5", "usage": { "input_tokens": 4, "cache_read_input_tokens": 50_000, "output_tokens": 6 } } });
        std::fs::write(&transcript, format!("{line}\n")).unwrap();
        poke_for(
            &tracker,
            &ctx,
            &HookSignal::Transcript {
                cell: "c1".into(),
                session_id: SESSION.into(),
                path: transcript.to_string_lossy().into_owned(),
            },
        );
        assert_eq!(
            ask("context:get", vec![json!("c1")]),
            json!({ "cli": "claude", "tokens": 50_010, "window": 200_000, "percent": 25, "model": "claude-sonnet-4-5" })
        );
        assert_eq!(tracker.current("c1").map(|u| u.tokens), Some(50_010.0));
        assert_eq!(ask("context:get", vec![json!("x1")]), Value::Null, "no session");
        assert_eq!(ask("context:get", vec![json!("nope")]), Value::Null);
        assert_eq!(ask("context:get", vec![json!(5)]), Value::Null);
        assert_eq!(ask("context:get", vec![]), Value::Null);
        // A path that is not a string made 1.1.4's handler throw (a rejected call).
        assert!(call("sessions:list", vec![json!(5)]).is_err());
        assert!(call("sessions:list", vec![]).is_err());
        // Not the sole live Codex cell (no cell is alive yet): never guessed.
        let cwd = dir.path().join("proj").to_string_lossy().into_owned();
        assert_eq!(ask("codex:bind", vec![json!("x1"), json!(cwd)]), Value::Null);
        assert_eq!(ask("codex:bind", vec![json!("c1"), json!(cwd)]), Value::Null);
        assert_eq!(ask("codex:bind", vec![json!(5)]), Value::Null);
        ctx.saver.stop();
    }
}
