//! unimux 1.2.0: the Tauri application. Order of `main()` (ARCHITECTURE section 1, PLAN F5/F6/F11):
//! legacy entry points -> data dir -> single instance -> crash log -> state -> context and router -> tauri::Builder ->
//! startup gate -> main window.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod caption;
#[cfg(all(windows, feature = "test-bridge"))]
mod caption_test;
mod cells;
#[cfg(feature = "test-bridge")]
mod channel_bench;
mod commands;
mod context;
mod detached;
#[cfg(feature = "test-bridge")]
mod eval_bridge;
mod file_drop;
mod hooks;
mod ipc;
mod lifecycle;
mod mac_chrome;
mod port_message;
mod pty_transport;
#[cfg(feature = "test-bridge")]
mod spike_pty;
#[cfg(feature = "test-bridge")]
mod spike_windows;
mod startup;
#[cfg(feature = "test-bridge")]
mod test_bridge;
#[cfg(feature = "test-bridge")]
mod test_record;
mod update;
mod update_gate;
mod update_window;
mod webview_import;
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
    // Check build: `--launch-line <json>` prints the launch line of a cell for scripts/verify-cli-contract.mjs (P4), and never
    // starts the app (an unknown flag would).
    #[cfg(feature = "test-bridge")]
    if let Some(code) = test_bridge::launch_line_cli() {
        std::process::exit(code);
    }

    // A relaunch (a start during the last wind-down) waits for the old process to end before it touches the data dir.
    lifecycle::wait_for_relaunching_process();

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
                // Focus, or (while winding down) start again after the exit.
                let _ = app.run_on_main_thread(move || lifecycle::second_instance(&c));
            }
        }
    });
    let instance = match acquire(&data_dir, on_second) {
        Ok(Acquire::Primary(guard)) => guard,
        Ok(Acquire::Forwarded) => std::process::exit(0),
        Ok(Acquire::Busy) => {
            crash.warn("another instance holds the data directory and did not answer; not starting");
            std::process::exit(0);
        }
        Err(e) => startup::startup_failed(&format!("single instance: {e}"), None),
    };
    // The installer an update window started is replacing this build's files right now: starting would crash (1.1.4).
    if startup::install_in_progress_at_start(&data_dir) {
        crash.warn("an update is being installed; not starting");
        drop(instance);
        std::process::exit(0);
    }
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
    // Held for the whole run; released before a relaunch (W6).
    ctx.lifecycle.keep_instance(instance);
    let builder = build_router(&ctx);
    for error in builder.errors() {
        crash.error(&format!("ipc registration: {error}"));
    }
    let _ = ctx.router.set(Arc::new(builder.build(ctx.guard.clone())));
    *second.lock() = Some(ctx.clone());
    // Windows: Chromium's OSCrypt::Init runs at 1.1.4's start (an idle run already writes Local State); here off the main
    // thread so the window never waits for DPAPI. macOS opens the Keychain on first use only (B2).
    if cfg!(windows) {
        let storage = ctx.safe_storage.clone();
        let _ = std::thread::Builder::new().name("safe-storage".into()).spawn(move || {
            storage.warm();
        });
    }

    // WebKit reads its text defaults once per process: before the first webview (W2).
    #[cfg(target_os = "macos")]
    mac_chrome::prepare_process();

    let tauri_ctx = tauri_context();
    let setup_ctx = ctx.clone();
    let builder = tauri::Builder::default();
    // 1.1.4's macOS menu bar (app + Edit menu, no reload / close); Windows has none.
    #[cfg(target_os = "macos")]
    let builder = builder.menu(mac_chrome::app_menu).on_menu_event(|_app, event| mac_chrome::on_menu_event(event.id().as_ref()));
    // The web content process of a WKWebView ended (WebView2 reports it through ProcessFailed, lifecycle/webview.rs).
    #[cfg(target_os = "macos")]
    let builder = {
        let c = ctx.clone();
        builder.on_web_content_process_terminate(move |webview| {
            lifecycle::renderer_gone(&c, webview.label(), "crashed", 0);
        })
    };
    let app = builder
        .manage(ctx.clone())
        .invoke_handler(handlers())
        .setup(move |app| {
            let ctx = setup_ctx.clone();
            let _ = ctx.sink.app.set(app.handle().clone());
            // The bundled conpty.dll + OpenConsole.exe (tauri.windows.conf.json `bundle.resources`), before any terminal.
            #[cfg(windows)]
            if let Ok(dir) = tauri::Manager::path(&*app).resource_dir() {
                unimux_pty::conpty::ConptyApi::set_resource_dir(dir.join("resources").join("conpty").join("x64"));
            }
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
            // macOS: how the previous update ended, recorded for the gate before it runs (U5).
            #[cfg(target_os = "macos")]
            startup::previous_mac_update(&ctx.data_dir, &ctx.overrides);
            // U1: the background update checks (8 s after the start, then every 30 min).
            if let Some(updates) = ctx.update.get() {
                updates.start();
            }
            // The update window of the update that just finished may say "done" now (U3, 1.1.4 signalUpdateReady); while it
            // still supervises, the gate and the main window wait for it (at most 4 s) off the main thread.
            if update::signal_ready_before_gate(&ctx) {
                let (app, ctx) = (app.handle().clone(), ctx.clone());
                let _ = std::thread::Builder::new().name("update-window-wait".into()).spawn(move || {
                    update::wait_update_window_gone(&ctx.data_dir);
                    let on_main = app.clone();
                    let _ = app.run_on_main_thread(move || {
                        if let Err(e) = gate_or_start(&on_main, &ctx) {
                            startup::startup_failed(&format!("{e}"), None);
                        }
                    });
                });
            } else {
                gate_or_start(app.handle(), &ctx)?;
            }
            Ok(())
        })
        .build(tauri_ctx);
    let app = match app {
        Ok(app) => app,
        Err(e) => startup::startup_failed(&format!("{e}"), None),
    };

    let run_ctx = ctx.clone();
    app.run(move |_app, event| match event {
        // Tauri never ends the app by itself: the last window closing (code None) or app.exit (Some) goes through the quit
        // (question, wind-down), which allows the exit it asks for at the end. While the startup gate decides, a closed gate
        // window does not end the app (1.1.4 window-all-closed with `gating`).
        RunEvent::ExitRequested { code, api, .. } => {
            if lifecycle::exit_allowed(&run_ctx) {
                return;
            }
            api.prevent_exit();
            if code.is_none() && run_ctx.lifecycle.is_gating() {
                return;
            }
            lifecycle::request_quit(&run_ctx, lifecycle::QuitSource::Request);
        }
        RunEvent::Exit => {
            // A copied key that still waits is cleared before the process ends (W4, 1.1.4 will-quit).
            commands::os::on_exit(&run_ctx);
            // The conversation index saves itself (1.1.4's will-quit convSearch.stop()).
            commands::agents::on_exit();
            // The MCP and hook servers stop at the latest here (the wind-down stops them in their own phases).
            commands::mcp::stop();
            hooks::stop(&run_ctx);
            // After the wind-down (or a forced exit): whatever came in after the last save, then a pending relaunch.
            lifecycle::after_exit(&run_ctx);
        }
        _ => {}
    });
}

/// `runUpdateGate` then `startMainApp`: the startup gate (U1) may hold the main window back; it then starts the app itself
/// once the current version is to run (never when the installer took over). On the main thread.
fn gate_or_start(app: &tauri::AppHandle, ctx: &Arc<AppContext>) -> tauri::Result<()> {
    let (gate_app, gate_ctx) = (app.clone(), ctx.clone());
    let start_later: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
        let (app, ctx) = (gate_app.clone(), gate_ctx.clone());
        let on_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            if let Err(e) = start_main_app(&on_main, &ctx) {
                startup::startup_failed(&format!("{e}"), None);
            }
            startup::mark_started();
        });
    });
    if !update::startup_gate(ctx, app, start_later) {
        ctx.mark("update-gate-done");
        start_main_app(app, ctx)?;
        startup::mark_started();
    }
    Ok(())
}

/// `startMainApp`: the window first, then the rest in parallel behind it. Runs after the startup gate (U1), on the main thread.
fn start_main_app(app: &tauri::AppHandle, ctx: &Arc<AppContext>) -> tauri::Result<()> {
    webview_import::prepare(app, ctx);
    let main_window = windows::create_main(app, ctx)?;
    // The macOS stand-in for CDP (MC_EVAL_PORT, check build only).
    #[cfg(feature = "test-bridge")]
    let _ = eval_bridge::start(ctx.clone());
    // Tabs that were in their own window at the last quit open there again (W5). The main window closing closes them as they
    // are (their registry stays for the next start).
    ctx.detached.set_host(detached::host::TauriHost::new(app.clone(), ctx));
    let closing = ctx.detached.clone();
    main_window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            closing.close_all();
        }
    });
    ctx.detached.start();
    // In parallel with the window (1.1.4: hooks.start next to the cell file prune and the MCP server, the MCP server retried
    // twice in the background), then the cell services gate; the account work and its gates beside them (W7).
    cells::startup::start(ctx, hooks::start(ctx), commands::mcp::start(ctx));
    // 1.1.4 scheduleUpdateCleanup: `update/` of a finished update 30 s after the start, plus the 1.1.x updater's cache (U3).
    update::schedule_update_cleanup(ctx);
    // H3: the CLI scan in the background and the registry refresh on focus.
    commands::agents::app_started(ctx);
    // S1: the SSH vault and known hosts open off the main thread; the command history is written at quit.
    commands::ssh::app_started(ctx);
    // P3: the Monitor's running cells and the terminals' wind-down step.
    commands::pty::app_started(ctx);
    // The wind-down stops the hook server in its own phase (1.1.4 before-quit: hooks.stop after the MCP server).
    let stopping = ctx.hooks.clone();
    ctx.lifecycle.wind_down.register(
        lifecycle::wind_down::phase::HOOKS,
        "hooks stop",
        Duration::from_secs(1),
        move || async move {
            stopping.server.stop();
        },
    );
    // M1: the wind-down stops the MCP server in its own phase, before the hook server.
    ctx.lifecycle.wind_down.register(lifecycle::wind_down::phase::MCP, "mcp stop", Duration::from_secs(1), || async {
        commands::mcp::stop();
    });
    Ok(())
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
            pty_transport::mc_port_pull,
            ipc::update_splash_init,
            ipc::update_splash_close,
            ipc::update_splash_open,
            mac_chrome::mac_title_double_click,
            file_drop::mc_dropped_paths,
            webview_import::mc_webview_import_done,
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
            pty_transport::mc_port_pull,
            ipc::update_splash_init,
            ipc::update_splash_close,
            ipc::update_splash_open,
            mac_chrome::mac_title_double_click,
            file_drop::mc_dropped_paths,
            webview_import::mc_webview_import_done
        ]
    }
}
