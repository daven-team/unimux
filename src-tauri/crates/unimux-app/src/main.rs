//! unimux 1.2.0: the Tauri application. Order of `main()` (ARCHITECTURE section 1, PLAN F5/F6/F11):
//! legacy entry points -> data dir -> single instance -> crash log -> state -> context and router -> tauri::Builder ->
//! startup gate -> main window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "test-bridge")]
mod channel_bench;
mod commands;
mod context;
mod ipc;
#[cfg(feature = "test-bridge")]
mod spike_pty;
#[cfg(feature = "test-bridge")]
mod spike_windows;
mod startup;
#[cfg(feature = "test-bridge")]
mod test_bridge;
mod update_window;
mod windows;

/// The Tauri context (config, embedded frontend, capabilities). Expanded once: the app and the update window mode share it,
/// so the frontend is embedded only once.
fn tauri_context() -> tauri::Context<tauri::Wry> {
    tauri::generate_context!()
}

use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::RunEvent;

use unimux_core::crash_log::RollingLog;
use unimux_core::dev_overrides::DevOverrides;
use unimux_core::startup_timing::{StartupLog, StartupTimer};
use unimux_ipc::{Call, Contract, RouterBuilder, SendQueue};
use unimux_platform::instance::{Acquire, acquire};
use unimux_state::normalize::unless_restoring;
use unimux_state::store::{LoadOptions, load_state};
use unimux_state::{Normalizer, Platform, StateNormalizer};

use crate::context::AppContext;

/// AUMID of the installed app; a run from the repository gets its own (never the installed app's taskbar entry).
const AUMID: &str = if unimux_core::PACKAGED { "com.unimux.app" } else { "com.unimux.app.dev" };

fn build_router(ctx: &Arc<AppContext>) -> RouterBuilder {
    let mut builder = RouterBuilder::new(Contract::embedded());
    commands::register_all(&mut builder, ctx);
    builder
}

/// `unimux --ipc-routes`: every contract channel with its status, for `npm run ipc:report` (dev and check builds).
fn print_routes() -> i32 {
    let dir = std::env::temp_dir().join(format!("unimux-ipc-routes-{}", std::process::id()));
    let ctx = AppContext::new(
        dir.clone(),
        DevOverrides::default(),
        Arc::new(RollingLog::new(dir.join("crash.log"), None)),
        Arc::new(StartupTimer::new(Instant::now())),
        Arc::new(StartupLog::new(dir.join("startup.log"), "")),
        StateNormalizer.default_state(Platform::current()),
    );
    let builder = build_router(&ctx);
    let errors = builder.errors().to_vec();
    let router = builder.build(ctx.guard.clone());
    let out = serde_json::json!({ "routes": router.report(), "errors": errors });
    println!("{out}");
    ctx.saver.stop();
    let _ = std::fs::remove_dir_all(&dir);
    if errors.is_empty() { 0 } else { 1 }
}

fn main() {
    let started = Instant::now();
    if let Some(code) = startup::legacy_entry() {
        std::process::exit(code);
    }
    // The update window process (a copy of this exe in %LOCALAPPDATA%\unimux-updater) and its cleanup: before the data dir,
    // the instance lock and crash.log, none of which they touch.
    if let Some(config) = update_window::config_arg() {
        std::process::exit(update_window::run(&config, tauri_context()));
    }
    if let Some(cleanup) = update_window::cleanup_arg() {
        std::process::exit(update_window::run_cleanup(&cleanup));
    }
    if std::env::args().any(|a| a == "--ipc-routes") && !unimux_core::PACKAGED {
        std::process::exit(print_routes());
    }

    let timer = Arc::new(StartupTimer::new(started));
    timer.mark("process-start");
    let overrides = DevOverrides::from_env();
    if overrides.offscreen {
        startup::set_quiet();
    }
    let early_log: Vec<String> = Vec::new();
    let early = parking_lot::Mutex::new(early_log);
    let data_dir = startup::data_dir(&overrides, &|m: &str| early.lock().push(m.to_string()));

    // crash.log first: everything after this point that fails leaves a trace.
    let crash = Arc::new(RollingLog::crash_log(&data_dir));
    startup::install_crash_handling(crash.clone());
    for line in early.lock().drain(..) {
        crash.warn(&line);
    }

    // One instance per data dir, Electron 1.1.x included (it forwards to us; we forward to it).
    let second: Arc<parking_lot::Mutex<Option<Arc<AppContext>>>> = Arc::new(parking_lot::Mutex::new(None));
    let second_ctx = second.clone();
    let on_second = Arc::new(move |_s: unimux_platform::instance::SecondInstance| {
        if let Some(ctx) = second_ctx.lock().clone() {
            let c = ctx.clone();
            if let Some(app) = ctx.app() {
                let _ = app.run_on_main_thread(move || windows::focus_main(&c));
            }
        }
    });
    let _instance = match acquire(&data_dir, on_second) {
        Ok(Acquire::Primary(guard)) => guard,
        Ok(Acquire::Forwarded) => std::process::exit(0),
        Ok(Acquire::Busy) => {
            crash.warn("another instance holds the data directory and did not answer; not starting");
            std::process::exit(0);
        }
        Err(e) => startup::startup_failed(&format!("single instance: {e}"), None),
    };
    timer.mark("instance-lock");
    unimux_platform::set_app_user_model_id(AUMID);
    // Before any webview: a WebView2 data folder that cannot be created would make Edge show its own dialog. Windows only:
    // WKWebView keeps its default store and 1.1.4 never had <data>/webview2 on macOS.
    #[cfg(windows)]
    windows::init_webview_dir(&data_dir, &crash);

    let startup_log = Arc::new(StartupLog::new(
        data_dir.join("startup.log"),
        format!("{} {} {}", unimux_core::time::iso_now(), unimux_core::VERSION, Platform::current().as_str()),
    ));

    // The state is Rust's from the first wave: a locked state.json stops the start (nothing is overwritten).
    let crash_for_load = crash.clone();
    let log = move |m: &str| crash_for_load.warn(m);
    let state = match load_state(&data_dir, Platform::current(), &StateNormalizer, &LoadOptions { log: &log, seams: None }) {
        Ok(state) => unless_restoring(state),
        Err(e) => startup::startup_failed(&e.to_string(), Some(&e.path)),
    };
    timer.mark("state-loaded");

    let ctx = AppContext::new(data_dir.clone(), overrides, crash.clone(), timer.clone(), startup_log, state);
    let builder = build_router(&ctx);
    for error in builder.errors() {
        crash.error(&format!("ipc registration: {error}"));
    }
    let _ = ctx.router.set(Arc::new(builder.build(ctx.guard.clone())));
    *second.lock() = Some(ctx.clone());

    let tauri_ctx = tauri_context();
    let setup_ctx = ctx.clone();
    let app = tauri::Builder::default()
        .manage(ctx.clone())
        .invoke_handler(handlers())
        .setup(move |app| {
            let ctx = setup_ctx.clone();
            let _ = ctx.sink.app.set(app.handle().clone());
            // Sends run in order per window on the async runtime (ipcRenderer.send ordering).
            let router = ctx.router().clone();
            let _ = ctx.sends.set(SendQueue::new(
                Duration::from_secs(2),
                Arc::new(move |call: Call| {
                    let router = router.clone();
                    Box::pin(async move { router.run_send(call).await })
                }),
            ));
            // Port messages (pty write/resize/ack) in order per window and port, like a MessagePort.
            let ports = ctx.ports.clone();
            let crash = ctx.crash.clone();
            let _ = ctx.port_posts.set(SendQueue::new(
                Duration::from_secs(2),
                Arc::new(move |post: ipc::PortPost| {
                    for message in post.messages {
                        if let Err(e) = ports.post(&post.kind, &post.label, message) {
                            crash.warn(&format!("port {} post from {}: {e}", post.kind, post.label));
                            break;
                        }
                    }
                    Box::pin(async {})
                }),
            ));
            ctx.mark("app-ready");
            // The startup gate (U1) runs here and may hold the main window back; wave 0 always proceeds.
            windows::create_main(app.handle(), &ctx)?;
            startup::mark_started();
            Ok(())
        })
        .build(tauri_ctx);
    let app = match app {
        Ok(app) => app,
        Err(e) => startup::startup_failed(&format!("{e}"), None),
    };

    let run_ctx = ctx.clone();
    app.run(move |_app, event| {
        if let RunEvent::Exit = event {
            // The last save (W6 adds the full wind-down: quit confirmation, hosts, MCP, hooks).
            if !run_ctx.flush_state() {
                run_ctx.crash.error("state could not be saved before exit");
            }
            run_ctx.saver.stop();
        }
    });
}

fn handlers() -> impl Fn(tauri::ipc::Invoke) -> bool + Send + Sync + 'static {
    #[cfg(feature = "test-bridge")]
    {
        tauri::generate_handler![
            ipc::mc_invoke,
            ipc::mc_send,
            ipc::mc_invoke_raw,
            ipc::mc_port_attach,
            ipc::mc_port_post,
            ipc::update_splash_init,
            ipc::update_splash_close,
            ipc::update_splash_open,
            test_bridge::test_bridge,
            channel_bench::test_channel_bench,
            channel_bench::test_channel_pull,
            spike_pty::spike_pty_attach,
            spike_pty::spike_pty
        ]
    }
    #[cfg(not(feature = "test-bridge"))]
    {
        tauri::generate_handler![
            ipc::mc_invoke,
            ipc::mc_send,
            ipc::mc_invoke_raw,
            ipc::mc_port_attach,
            ipc::mc_port_post,
            ipc::update_splash_init,
            ipc::update_splash_close,
            ipc::update_splash_open
        ]
    }
}
