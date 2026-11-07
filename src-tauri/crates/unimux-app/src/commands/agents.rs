//! Commands of the `agents` domain: H1-H6: CLI detection and install, sessions, context, conversation search, agent prompts (cli:*, install:*, codex:*, context:*, sessions:*, conv:*, agents:*).
//!
//! Registered by `register` only; nothing else in the app is edited when a package lands. Until then the router answers
//! the domain's channels with `MC_NOT_YET` (see `npm run ipc:report`).
//!
//! H3 (CLI detector): `cli:status`, `cli:recheck`, `cli:openDocs`, the `cli:changed` broadcast, the startup scan and the
//! registry refresh on a main-window focus ([`app_started`]). Later packages (P4 cell spawn, H6 install, M4 automation) reach
//! the detector through [`cli_detector`].

use std::sync::{Arc, OnceLock};

use serde_json::Value;
use tauri::{Manager, WindowEvent};
use unimux_agents::cli::{CliDetector, CliHandlers, SystemCliDeps, SystemOptions};
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

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
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
