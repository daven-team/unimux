//! The app lifecycle (PLAN W6): quit, the end of the OS session, renderer crash and hang. Port of index.ts:716-741 (quit
//! question), 980-1090 (renderer gone / unresponsive), 1982-2265 (second instance while quitting, exitNow, before-quit and its
//! wind-down, window-all-closed) and quitConfirm.ts / quitWait.ts / stability.ts.
//!
//! How a quit runs:
//! - The close button, Alt+F4 or the taskbar's "Close window" (CloseRequested on the main window), `app.exit` from anywhere
//!   (ExitRequested), Cmd+Q / Dock Quit / log-out on macOS (`applicationShouldTerminate:`) all end in [`request_quit`]; Tauri
//!   never closes the main window or exits by itself.
//! - [`request_quit`] is 1.1.4's `before-quit`: the quit question may hold it ([`quit_confirm`]); otherwise the wind-down runs
//!   ([`wind_down`]: every service registered its steps) within the 20 s hard limit, and [`exit_now`] ends the process (with a
//!   relaunch when another start arrived meanwhile).
//! - Windows session end: WM_QUERYENDSESSION marks the session as ending (no quit is held for a minute, an open question lets
//!   the quit go on), tells the renderers to push their last edits and starts the save at once; WM_ENDSESSION waits for that
//!   save (3 s at most) before Windows ends the process. macOS: NSWorkspaceWillPowerOff does the same, the quit follows through
//!   `applicationShouldTerminate:`.
//! - Renderer: WebView2's ProcessFailed (macOS: the web content process terminated) reloads the page, 3 times a minute, then
//!   asks Reload / Quit; a renderer that stops running scripts (heartbeat, [`renderer`]) is asked about after the grace period
//!   (Wait / Reload; Reload ends the hung renderer process and the crash path reloads it). Detached windows always reload.
//!
//! Dialogs are native message boxes parented to the window. In an unattended run (MC_OFFSCREEN, the real-app harness) they
//! are recorded instead and answered through the test bridge: no test ever shows a dialog on the desktop.

pub mod quit_confirm;
pub mod renderer;
pub mod webview;
pub mod wind_down;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex, RwLock};
use serde_json::Value;
#[cfg(feature = "test-bridge")]
use serde_json::json;
use tauri::{Manager, WebviewWindow, WindowEvent};

use unimux_core::crash_log::RollingLog;
use unimux_core::i18n::{is_language, translate};
use unimux_core::time::now_ms;
use unimux_ipc::{Events, Scope};
use unimux_platform::lifecycle::{DialogKind, MessageDialog};
use unimux_state::broadcast::StateBroadcaster;
use unimux_state::store::Saver;

use crate::context::AppContext;
use crate::windows::MAIN;
use quit_confirm::{Effect, QuitAnswer, QuitConfirm, SESSION_END_WINDOW_MS, session_ending_now};
use renderer::{Heartbeat, ReloadLimiter, Tick, UNRESPONSIVE_GRACE};
use wind_down::{SHUTDOWN_HARD_LIMIT, WindDown, phase};

/// Where a quit request came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuitSource {
    /// The main window's close (button, Alt+F4, taskbar): the window goes away at once, like 1.1.4's closed window.
    WindowClose,
    /// `app.exit`, Cmd+Q, Dock Quit, the test bridge.
    Request,
    /// The quit question was answered "quit" or ran out.
    Confirmed,
    /// "Quit" in the renderer crash dialog.
    Dialog,
}

/// The longest WM_ENDSESSION waits for the save that WM_QUERYENDSESSION started.
#[cfg_attr(not(windows), allow(dead_code, reason = "WM_ENDSESSION is Windows only"))]
pub const SESSION_END_SAVE_WAIT: Duration = Duration::from_secs(3);
/// After [`exit_now`] asked the event loop to end: the process ends anyway after this (a stuck loop must not keep it).
const EXIT_BACKSTOP: Duration = Duration::from_secs(5);

/// The wall clock in ms (the session-end window and the reload limiter count real time, like Date.now()).
fn wall_ms() -> u64 {
    now_ms().max(0) as u64
}

#[derive(Default)]
struct RendererState {
    limiter: ReloadLimiter,
    /// The user chose to reload a hung renderer: the crash that ends it is reloaded without counting or asking.
    hung_reload_requested: bool,
    heartbeat: Heartbeat,
    /// The grace period of an unresponsive renderer that is running (its id).
    hung_timer: Option<u64>,
    next_timer: u64,
    /// The main page's renderer process ended and the page has not loaded again (Electron's `isCrashed()`).
    dead: bool,
    crash_dialog_open: bool,
}

/// A dialog of an unattended run, kept for the test bridge.
#[cfg_attr(not(feature = "test-bridge"), allow(dead_code, reason = "read by the test bridge only"))]
struct RecordedDialog {
    id: u64,
    window: String,
    dialog: MessageDialog,
    answer: Option<usize>,
    reply: Option<Box<dyn FnOnce(usize) + Send>>,
}

#[derive(Default)]
struct SessionFlush {
    running: bool,
}

type LabelHook = Arc<dyn Fn(&str) + Send + Sync>;

pub struct Lifecycle {
    started: Instant,
    quitting: AtomicBool,
    gating: AtomicBool,
    superseded: AtomicBool,
    handoff_started: AtomicBool,
    exit_allowed: AtomicBool,
    exiting: AtomicBool,
    relaunch_requested: AtomicBool,
    session_ending_at: Mutex<Option<u64>>,
    confirm: Mutex<QuitConfirm>,
    /// The wind-down steps; every service registers its own (see [`wind_down::phase`]).
    pub wind_down: WindDown,
    renderer: Mutex<RendererState>,
    page_gone_hooks: RwLock<Vec<LabelHook>>,
    exit_hooks: Mutex<Vec<Box<dyn FnOnce() + Send>>>,
    instance: Mutex<Option<Box<dyn Send>>>,
    dialogs: Mutex<(u64, Vec<RecordedDialog>)>,
    session_flush: Arc<(Mutex<SessionFlush>, Condvar)>,
}

impl Default for Lifecycle {
    fn default() -> Self {
        Self::new()
    }
}

impl Lifecycle {
    pub fn new() -> Self {
        Self {
            started: Instant::now(),
            quitting: AtomicBool::new(false),
            gating: AtomicBool::new(false),
            superseded: AtomicBool::new(false),
            handoff_started: AtomicBool::new(false),
            exit_allowed: AtomicBool::new(false),
            exiting: AtomicBool::new(false),
            relaunch_requested: AtomicBool::new(false),
            session_ending_at: Mutex::new(None),
            confirm: Mutex::new(QuitConfirm::default()),
            wind_down: WindDown::new(),
            renderer: Mutex::new(RendererState::default()),
            page_gone_hooks: RwLock::new(Vec::new()),
            exit_hooks: Mutex::new(Vec::new()),
            instance: Mutex::new(None),
            dialogs: Mutex::new((0, Vec::new())),
            session_flush: Arc::new((Mutex::new(SessionFlush::default()), Condvar::new())),
        }
    }

    /// The app winds down (no new account work, no dialogs, no SSH resume flags).
    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    pub fn is_gating(&self) -> bool {
        self.gating.load(Ordering::SeqCst)
    }

    /// The OS announced a session end less than a minute ago (`sessionEndingNow`).
    pub fn session_ending(&self) -> bool {
        session_ending_now(*self.session_ending_at.lock(), wall_ms(), SESSION_END_WINDOW_MS)
    }

    /// The single-instance guard: released before a relaunch so the new process can take the data dir.
    pub fn keep_instance(&self, guard: impl Send + 'static) {
        *self.instance.lock() = Some(Box::new(guard));
    }

    fn mono_ms(&self) -> u64 {
        self.started.elapsed().as_millis() as u64
    }
}

/// The hooks of the packages that land after W6 (the gate and hand-over U1, the page-bound services H6 / T1 / D1 / G5 / W7,
/// the secret clipboard W4). W6 only provides them.
#[allow(dead_code, reason = "called by the packages that own these services")]
impl Lifecycle {
    /// The startup gate decides (U1): a closed gate window does not end the app, an explicit quit ends it at once.
    pub fn set_gating(&self, value: bool) {
        self.gating.store(value, Ordering::SeqCst);
    }

    /// The update hand-over started (U1): no quit is held, no relaunch after the exit.
    pub fn set_handoff_started(&self) {
        self.handoff_started.store(true, Ordering::SeqCst);
    }

    /// Another instance owns the data dir: nothing is wound down, the exit is immediate.
    pub fn set_superseded(&self) {
        self.superseded.store(true, Ordering::SeqCst);
    }

    /// A page started loading or its renderer died (Electron's `did-start-loading` / `render-process-gone`): the hooks of the
    /// services that pin something to a page (install window H6, SFTP / DB sessions T1 / D1, local files G5, taskbar W7).
    pub fn on_page_gone(&self, hook: impl Fn(&str) + Send + Sync + 'static) {
        self.page_gone_hooks.write().push(Arc::new(hook));
    }

    /// Runs right before the process ends, also after a hand-over or an overrun wind-down (W4: the secret clipboard).
    pub fn on_exit(&self, hook: impl FnOnce() + Send + 'static) {
        self.exit_hooks.lock().push(Box::new(hook));
    }
}

/// W6's own wind-down steps: `app:before-quit` to every window, the renderers' 150 ms, the save, the last save.
pub fn register_own_steps(
    lifecycle: &Lifecycle,
    events: Arc<Events>,
    broadcaster: Arc<StateBroadcaster>,
    saver: Arc<Saver>,
    crash: Arc<RollingLog>,
) {
    let wd = &lifecycle.wind_down;
    wd.register(phase::BEFORE_QUIT, "app:before-quit", Duration::from_secs(1), move || async move {
        events.emit(Scope::Broadcast, "app:before-quit", vec![]);
    });
    wd.register(phase::RENDERER_GRACE, "renderer grace", Duration::from_secs(1), || async {
        tokio::time::sleep(wind_down::RENDERER_GRACE).await;
    });
    let (b, s) = (broadcaster.clone(), saver.clone());
    wd.register(phase::SAVE, "state save", Duration::from_secs(2), move || async move {
        b.flush();
        let _ = tokio::task::spawn_blocking(move || s.flush()).await;
    });
    // A save that hit a lock gets a few more seconds (well inside the hard limit) instead of being lost.
    wd.register(phase::FINAL_SAVE, "last state save", wind_down::FINAL_SAVE + Duration::from_millis(500), move || async move {
        broadcaster.flush();
        if !saver.has_pending() {
            return;
        }
        let s = saver.clone();
        let saved = tokio::task::spawn_blocking(move || s.flush_until_saved(wind_down::FINAL_SAVE, Duration::from_millis(250)))
            .await
            .unwrap_or(false);
        if !saved {
            crash.error("the last state changes could not be saved");
        }
    });
}

fn main_window(ctx: &AppContext) -> Option<WebviewWindow> {
    ctx.app().and_then(|app| app.get_webview_window(MAIN))
}

/// The language of the app's own dialogs: the user's setting, else the OS language (index.ts `tr`).
fn language(ctx: &AppContext) -> String {
    let state = ctx.state.get();
    match state.pointer("/settings/language").and_then(Value::as_str) {
        Some(l) if is_language(l) => l.to_string(),
        _ => crate::startup::os_language(),
    }
}

/// Never hold this quit: winding down already, the gate decides, superseded, the session ends, an update took over, or no
/// live renderer could ask.
fn exempt(ctx: &AppContext) -> bool {
    let lc = &ctx.lifecycle;
    lc.is_quitting()
        || lc.is_gating()
        || lc.superseded.load(Ordering::SeqCst)
        || lc.session_ending()
        || lc.handoff_started.load(Ordering::SeqCst)
        || main_window(ctx).is_none()
        || lc.renderer.lock().dead
}

fn run_effects(ctx: &Arc<AppContext>, effects: Vec<Effect>) {
    for effect in effects {
        match effect {
            Effect::Ask => ask_renderer(ctx),
            Effect::Quit => request_quit(ctx, QuitSource::Confirmed),
            Effect::Arm { timer, id, ms } => {
                let c = ctx.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(ms)).await;
                    let effects = c.lifecycle.confirm.lock().fire(timer, id);
                    run_effects(&c, effects);
                });
            }
        }
    }
}

/// A minimized or hidden window (taskbar "Close window", Dock Quit after Cmd+H) is brought up first: the question must be
/// seen. Then the renderer asks (`app:confirm-quit`).
fn ask_renderer(ctx: &Arc<AppContext>) {
    if let Some(window) = main_window(ctx) {
        if ctx.overrides.offscreen {
            crate::windows::show_without_focus(&window);
        } else {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
    }
    ctx.events.emit(Scope::Main, "app:confirm-quit", vec![]);
}

/// `app:quitGuard`: whether quitting must ask first (an agent works, transfers run, unsaved database work).
pub fn set_quit_guard(ctx: &AppContext, ask: bool) {
    ctx.lifecycle.confirm.lock().set_guard(ask);
}

/// `app:quitAnswer`: 'asking' at once, then 'quit' or 'cancel'.
pub fn quit_answer(ctx: &Arc<AppContext>, answer: QuitAnswer) {
    let effects = ctx.lifecycle.confirm.lock().answer(answer);
    run_effects(ctx, effects);
}

/// 1.1.4's `before-quit`: asks first when agents work, else winds down and exits. Never blocks.
pub fn request_quit(ctx: &Arc<AppContext>, source: QuitSource) {
    let lc = &ctx.lifecycle;
    if lc.exit_allowed.load(Ordering::SeqCst) {
        return;
    }
    let exempt = exempt(ctx);
    let (held, effects) = lc.confirm.lock().hold(exempt);
    run_effects(ctx, effects);
    if held {
        return;
    }
    // The installer took over before anything was started, or another instance owns the dir: nothing to wind down.
    if lc.is_gating() || lc.superseded.load(Ordering::SeqCst) {
        exit_now(ctx);
        return;
    }
    if lc.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    crate::startup::set_shutting_down();
    if source == QuitSource::WindowClose
        && let Some(window) = main_window(ctx)
    {
        let _ = window.hide();
    }
    // However the wind-down goes, the process must end: a running installer waits for it. The tokio limit covers a slow
    // step; this thread covers a runtime that no longer runs at all.
    std::thread::Builder::new()
        .name("quit-backstop".into())
        .spawn(|| {
            std::thread::sleep(SHUTDOWN_HARD_LIMIT + EXIT_BACKSTOP);
            std::process::exit(0);
        })
        .ok();
    let c = ctx.clone();
    tauri::async_runtime::spawn(async move {
        let crash = c.crash.clone();
        let log = move |m: &str| crash.warn(m);
        if c.lifecycle.wind_down.run_bounded(SHUTDOWN_HARD_LIMIT, &log).await.is_err() {
            c.crash.warn("shutdown overran its limit, exiting");
            c.lifecycle.wind_down.force_exit();
        }
        exit_now(&c);
    });
}

/// Ends the process; a launch that was swallowed during the wind-down is repeated, unless an update took over.
pub fn exit_now(ctx: &Arc<AppContext>) {
    let lc = &ctx.lifecycle;
    if lc.exiting.swap(true, Ordering::SeqCst) {
        return;
    }
    lc.exit_allowed.store(true, Ordering::SeqCst);
    let hooks = std::mem::take(&mut *lc.exit_hooks.lock());
    for hook in hooks {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(hook));
    }
    if should_relaunch_after_quit(lc.relaunch_requested.load(Ordering::SeqCst), lc.handoff_started.load(Ordering::SeqCst)) {
        relaunch(ctx);
    }
    std::thread::Builder::new()
        .name("exit-backstop".into())
        .spawn(|| {
            std::thread::sleep(EXIT_BACKSTOP);
            std::process::exit(0);
        })
        .ok();
    match ctx.app() {
        Some(app) => app.exit(0),
        None => std::process::exit(0),
    }
}

/// The exit was decided by [`exit_now`]: Tauri may end the event loop.
pub fn exit_allowed(ctx: &AppContext) -> bool {
    ctx.lifecycle.exit_allowed.load(Ordering::SeqCst)
}

/// A launch that arrived while the app was winding down is repeated afterwards, unless an update took over.
pub fn should_relaunch_after_quit(launch_requested: bool, update_started: bool) -> bool {
    launch_requested && !update_started
}

/// Starts this exe again (Electron's `app.relaunch()` at exit) once the single-instance guard is gone.
fn relaunch(ctx: &AppContext) {
    drop(ctx.lifecycle.instance.lock().take());
    unimux_platform::instance::wait_released(&ctx.data_dir, Duration::from_secs(2));
    let Ok(exe) = std::env::current_exe() else { return };
    let args: Vec<std::ffi::OsString> = std::env::args_os().skip(1).collect();
    let program = unimux_exec::Program::Args { program: exe, args };
    let env = std::env::vars_os().collect();
    if let Err(e) = unimux_exec::spawn_detached(&program, Some(env), std::env::current_dir().ok()) {
        ctx.crash.warn(&format!("relaunch failed: {e}"));
    }
}

/// Another start of unimux (or a 1.1.x on the same dir): focus the window, or, while winding down, start again afterwards.
pub fn second_instance(ctx: &Arc<AppContext>) {
    if ctx.lifecycle.is_quitting() {
        ctx.lifecycle.relaunch_requested.store(true, Ordering::SeqCst);
        return;
    }
    crate::windows::focus_main(ctx);
}

/// The OS ends the session (WM_QUERYENDSESSION, NSWorkspaceWillPowerOff): quits within the next minute are never held, an
/// open question lets the quit go on, the renderers push their last edits and the save starts now.
pub fn mark_session_ending(ctx: &Arc<AppContext>) {
    *ctx.lifecycle.session_ending_at.lock() = Some(wall_ms());
    start_session_flush(ctx);
    // Off the window procedure: the quit (window calls) and the emit must not run inside it.
    let c = ctx.clone();
    std::thread::spawn(move || {
        let effects = c.lifecycle.confirm.lock().release();
        run_effects(&c, effects);
        c.events.emit(Scope::Broadcast, "app:before-quit", vec![]);
    });
}

fn start_session_flush(ctx: &Arc<AppContext>) {
    let pair = ctx.lifecycle.session_flush.clone();
    {
        let mut st = pair.0.lock();
        if st.running {
            return;
        }
        st.running = true;
    }
    let c = ctx.clone();
    std::thread::spawn(move || {
        if !c.flush_state() {
            c.crash.error("state could not be saved at the end of the session");
        }
        pair.0.lock().running = false;
        pair.1.notify_all();
    });
}

/// WM_ENDSESSION: `ending` false = the shutdown was cancelled (nothing to do; quits stay unheld for the rest of the minute).
/// Otherwise waits for the save started at the query (at most [`SESSION_END_SAVE_WAIT`]) and writes what came after it.
#[cfg_attr(not(windows), allow(dead_code, reason = "WM_ENDSESSION is Windows only"))]
pub fn session_end(ctx: &Arc<AppContext>, ending: bool) {
    if !ending {
        return;
    }
    let deadline = Instant::now() + SESSION_END_SAVE_WAIT;
    {
        let (lock, cvar) = &*ctx.lifecycle.session_flush;
        let mut st = lock.lock();
        while st.running {
            if cvar.wait_until(&mut st, deadline).timed_out() {
                break;
            }
        }
    }
    ctx.broadcaster.flush();
    let left = deadline.saturating_duration_since(Instant::now());
    if ctx.saver.has_pending() && !ctx.saver.flush_until_saved(left, Duration::from_millis(100)) {
        ctx.crash.error("the last state changes could not be saved before the session ended");
    }
}

/// Everything the lifecycle watches on the main window: the close, the renderer process, the heartbeat, the session end.
pub fn attach_main(window: &WebviewWindow, ctx: &Arc<AppContext>) {
    let c = ctx.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            if c.lifecycle.exit_allowed.load(Ordering::SeqCst) {
                return;
            }
            api.prevent_close();
            request_quit(&c, QuitSource::WindowClose);
        }
    });
    watch_renderer(window, ctx);
    start_heartbeat(window.clone(), ctx.clone());

    #[cfg(windows)]
    if let (Some(hwnd), Some(app)) = (webview::window_handle(window), ctx.app()) {
        let (q, e) = (ctx.clone(), ctx.clone());
        let hooks = Arc::new(unimux_platform::lifecycle::SessionEndHooks {
            query: Box::new(move || mark_session_ending(&q)),
            end: Box::new(move |ending| session_end(&e, ending)),
        });
        let crash = ctx.crash.clone();
        let _ = app.run_on_main_thread(move || {
            if let Err(err) = unimux_platform::lifecycle::watch_session_end(hwnd, hooks) {
                crash.warn(&format!("session end hook: {err}"));
            }
        });
    }

    #[cfg(target_os = "macos")]
    if let Some(app) = ctx.app() {
        let c = ctx.clone();
        unimux_platform::lifecycle::watch_power_off(Arc::new(move || mark_session_ending(&c)));
        let c = ctx.clone();
        let _ = app.run_on_main_thread(move || {
            let decide = Arc::new(move || {
                if c.lifecycle.exit_allowed.load(Ordering::SeqCst) {
                    return true;
                }
                let c = c.clone();
                tauri::async_runtime::spawn(async move { request_quit(&c, QuitSource::Request) });
                false
            });
            unimux_platform::lifecycle::intercept_terminate(decide);
        });
    }
}

/// The renderer-process events of an app window (main: counted reloads and questions; detached: always reloaded). W5 calls
/// it for its windows.
pub fn watch_renderer(window: &WebviewWindow, ctx: &Arc<AppContext>) {
    let c = ctx.clone();
    let label = window.label().to_string();
    webview::watch_process_failed(
        window,
        Arc::new(move |event| match event {
            webview::ProcessEvent::RendererExited { reason, exit_code } => {
                renderer_gone(&c, &label, renderer::gone_reason(reason), exit_code)
            }
            webview::ProcessEvent::RendererUnresponsive => {
                if label == MAIN && c.lifecycle.renderer.lock().heartbeat.mark_unresponsive() {
                    unresponsive(&c);
                }
            }
            webview::ProcessEvent::BrowserExited { exit_code } => {
                c.crash.error(&format!("webview browser process gone (exit code {exit_code})"));
            }
        }),
    );
}

/// The page of a window starts loading (Electron's `did-start-loading`, also a reload after a crash) or finished it.
pub fn page_load(ctx: &Arc<AppContext>, label: &str, finished: bool) {
    if !finished {
        page_gone(ctx, label);
        return;
    }
    if label == MAIN {
        let mut st = ctx.lifecycle.renderer.lock();
        st.dead = false;
        st.hung_reload_requested = false;
        st.hung_timer = None;
        st.heartbeat.reset();
    }
}

fn page_gone(ctx: &Arc<AppContext>, label: &str) {
    if label == MAIN {
        ctx.lifecycle.confirm.lock().renderer_gone();
        let mut st = ctx.lifecycle.renderer.lock();
        st.heartbeat.reset();
        st.hung_timer = None;
    }
    let hooks: Vec<LabelHook> = ctx.lifecycle.page_gone_hooks.read().clone();
    for hook in hooks {
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| hook(label)));
    }
}

fn reload(ctx: &AppContext, label: &str) {
    let Some(window) = ctx.app().and_then(|a| a.get_webview_window(label)) else { return };
    if let Err(e) = window.reload() {
        ctx.crash.error(&format!("reload failed: {e}"));
    }
}

fn tr(language: &str, key: &str) -> String {
    translate(language, key, &[])
}

/// The renderer of a window died (out of memory in a busy grid, a GPU or renderer crash): the terminals live on, and a reload
/// adopts them and replays their output, so the window is reloaded instead of staying blank.
pub fn renderer_gone(ctx: &Arc<AppContext>, label: &str, reason: &str, exit_code: i32) {
    page_gone(ctx, label);
    let lc = &ctx.lifecycle;
    if label != MAIN {
        if reason == "clean-exit" || lc.is_quitting() {
            return;
        }
        ctx.crash.warn(&format!("detached window renderer gone ({reason})"));
        reload(ctx, label);
        return;
    }
    enum Next {
        Nothing,
        Reload,
        Ask,
        /// The question of an earlier crash is still open.
        Asking,
    }
    let next = {
        let mut st = lc.renderer.lock();
        st.dead = true;
        // The user's reload covers this one crash only: any later one is counted again.
        let asked = std::mem::take(&mut st.hung_reload_requested);
        if reason == "clean-exit" || lc.is_quitting() || lc.is_gating() {
            Next::Nothing
        } else if asked || st.limiter.allow(wall_ms()) {
            Next::Reload
        } else if std::mem::replace(&mut st.crash_dialog_open, true) {
            Next::Asking
        } else {
            Next::Ask
        }
    };
    if matches!(next, Next::Nothing) {
        return;
    }
    ctx.crash.error(&format!("renderer gone ({reason}, exit code {exit_code})"));
    match next {
        Next::Reload => {
            reload(ctx, MAIN);
            return;
        }
        Next::Asking | Next::Nothing => return,
        Next::Ask => {}
    }
    let language = language(ctx);
    let dialog = MessageDialog {
        kind: DialogKind::Error,
        title: "unimux".into(),
        message: tr(&language, "Okno aplikacji kilka razy przestało działać."),
        detail: tr(&language, "Terminale działają dalej. Możesz wczytać okno ponownie albo zamknąć aplikację."),
        buttons: vec![tr(&language, "Wczytaj ponownie"), tr(&language, "Zamknij aplikację")],
        default_id: 0,
        cancel_id: 0,
    };
    let c = ctx.clone();
    show_dialog(ctx, MAIN, dialog, move |response| {
        c.lifecycle.renderer.lock().crash_dialog_open = false;
        if c.lifecycle.is_quitting() || main_window(&c).is_none() {
            return;
        }
        if response == 1 {
            c.lifecycle.confirm.lock().confirm();
            request_quit(&c, QuitSource::Dialog);
        } else {
            reload(&c, MAIN);
        }
    });
}

/// Electron's `unresponsive`: after the grace period the user may reload (the terminals keep running).
fn unresponsive(ctx: &Arc<AppContext>) {
    if ctx.lifecycle.is_quitting() {
        return;
    }
    let id = {
        let mut st = ctx.lifecycle.renderer.lock();
        if st.hung_timer.is_some() {
            return;
        }
        st.next_timer += 1;
        st.hung_timer = Some(st.next_timer);
        st.next_timer
    };
    let c = ctx.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(UNRESPONSIVE_GRACE).await;
        let due = {
            let mut st = c.lifecycle.renderer.lock();
            if st.hung_timer == Some(id) {
                st.hung_timer = None;
                true
            } else {
                false
            }
        };
        if due {
            ask_about_hung_renderer(&c);
        }
    });
}

/// Electron's `responsive`.
fn responsive(ctx: &AppContext) {
    ctx.lifecycle.renderer.lock().hung_timer = None;
}

/// The renderer has not answered for a while: waiting is the default, reloading ends whatever blocks it.
fn ask_about_hung_renderer(ctx: &Arc<AppContext>) {
    let lc = &ctx.lifecycle;
    if lc.is_quitting() || lc.is_gating() || main_window(ctx).is_none() {
        return;
    }
    ctx.crash.warn("renderer unresponsive");
    let language = language(ctx);
    let dialog = MessageDialog {
        kind: DialogKind::Warning,
        title: "unimux".into(),
        message: tr(&language, "Okno aplikacji nie odpowiada."),
        detail: tr(&language, "Terminale działają dalej. Możesz poczekać albo wczytać okno ponownie."),
        buttons: vec![tr(&language, "Czekaj"), tr(&language, "Wczytaj ponownie")],
        default_id: 0,
        cancel_id: 0,
    };
    let c = ctx.clone();
    show_dialog(ctx, MAIN, dialog, move |response| {
        let Some(window) = main_window(&c) else { return };
        if response != 1 || c.lifecycle.is_quitting() {
            return;
        }
        c.crash.warn("hung renderer reloaded by the user");
        // A renderer stuck in a loop does not navigate: it is ended first, and the crash path reloads it.
        c.lifecycle.renderer.lock().hung_reload_requested = true;
        let ended = webview::renderer_pid(&window).is_some_and(webview::end_process);
        if !ended {
            c.lifecycle.renderer.lock().hung_reload_requested = false;
            reload(&c, MAIN);
        }
    });
}

/// The heartbeat of the main window's page ([`renderer`]); ends with the window or the exit.
fn start_heartbeat(window: WebviewWindow, ctx: Arc<AppContext>) {
    let _ = std::thread::Builder::new().name("renderer-heartbeat".into()).spawn(move || {
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let lc = &ctx.lifecycle;
            if lc.exiting.load(Ordering::SeqCst) || main_window(&ctx).is_none() {
                return;
            }
            let tick = {
                let mut st = lc.renderer.lock();
                if st.dead {
                    continue;
                }
                st.heartbeat.tick(lc.mono_ms())
            };
            match tick {
                Tick::Nothing => {}
                Tick::Unresponsive => unresponsive(&ctx),
                Tick::Ping(id) => {
                    let c = ctx.clone();
                    webview::ping(&window, move || {
                        if c.lifecycle.renderer.lock().heartbeat.answered(id) {
                            responsive(&c);
                        }
                    });
                }
            }
        }
    });
}

/// Shows a question about a window (native, parented) and calls `on_answer` with the button index, off the event loop. In an
/// unattended run the question is only recorded (test bridge `dialogs` / `dialogAnswer`).
pub fn show_dialog(ctx: &Arc<AppContext>, label: &str, dialog: MessageDialog, on_answer: impl FnOnce(usize) + Send + 'static) {
    if ctx.overrides.offscreen {
        let mut d = ctx.lifecycle.dialogs.lock();
        d.0 += 1;
        let id = d.0;
        d.1.push(RecordedDialog { id, window: label.to_string(), dialog, answer: None, reply: Some(Box::new(on_answer)) });
        return;
    }
    let owner = webview::owner_of(ctx, label);
    std::thread::spawn(move || {
        let response = unimux_platform::lifecycle::message_dialog(owner, &dialog);
        on_answer(response);
    });
}

/// Test bridge: answers a recorded dialog (the reply runs on its own thread, like a native one). False for an unknown or
/// answered id.
#[cfg(feature = "test-bridge")]
pub fn answer_dialog(ctx: &AppContext, id: u64, response: usize) -> bool {
    let reply = {
        let mut d = ctx.lifecycle.dialogs.lock();
        let Some(entry) = d.1.iter_mut().find(|e| e.id == id && e.answer.is_none()) else { return false };
        entry.answer = Some(response);
        entry.reply.take()
    };
    if let Some(reply) = reply {
        std::thread::spawn(move || reply(response));
    }
    true
}

/// Test bridge: the lifecycle as the app sees it, with every recorded dialog.
#[cfg(feature = "test-bridge")]
pub fn report(ctx: &AppContext) -> Value {
    let lc = &ctx.lifecycle;
    let confirm = lc.confirm.lock();
    let renderer = lc.renderer.lock();
    let dialogs: Vec<Value> = lc
        .dialogs
        .lock()
        .1
        .iter()
        .map(|d| {
            json!({
                "id": d.id,
                "window": d.window,
                "kind": if d.dialog.kind == DialogKind::Error { "error" } else { "warning" },
                "title": d.dialog.title,
                "message": d.dialog.message,
                "detail": d.dialog.detail,
                "buttons": d.dialog.buttons,
                "defaultId": d.dialog.default_id,
                "cancelId": d.dialog.cancel_id,
                "answer": d.answer,
            })
        })
        .collect();
    json!({
        "quitting": lc.is_quitting(),
        "gating": lc.is_gating(),
        "guard": confirm.guard(),
        "pending": confirm.is_pending(),
        "sessionEnding": lc.session_ending(),
        "relaunchRequested": lc.relaunch_requested.load(Ordering::SeqCst),
        "rendererDead": renderer.dead,
        "unresponsive": renderer.heartbeat.is_unresponsive(),
        "hungTimer": renderer.hung_timer.is_some(),
        "windDown": lc.wind_down.plan().into_iter().map(|(p, n)| json!({ "phase": p, "name": n })).collect::<Vec<_>>(),
        "dialogs": dialogs,
        "hwnd": main_window(ctx).as_ref().and_then(webview::window_handle),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repeats_a_swallowed_launch_after_quitting_unless_an_update_took_over() {
        assert!(should_relaunch_after_quit(true, false));
        assert!(!should_relaunch_after_quit(true, true));
        assert!(!should_relaunch_after_quit(false, false));
    }

    #[test]
    fn the_dialog_texts_exist_in_every_language() {
        for language in ["pl", "en", "de", "es", "fr", "pt"] {
            for key in [
                "Okno aplikacji kilka razy przestało działać.",
                "Terminale działają dalej. Możesz wczytać okno ponownie albo zamknąć aplikację.",
                "Wczytaj ponownie",
                "Zamknij aplikację",
                "Okno aplikacji nie odpowiada.",
                "Terminale działają dalej. Możesz poczekać albo wczytać okno ponownie.",
                "Czekaj",
            ] {
                let text = tr(language, key);
                assert!(!text.is_empty());
                if language == "pl" {
                    assert_eq!(text, key);
                } else {
                    assert_ne!(text, key, "{language}: {key}");
                }
            }
        }
        assert_eq!(tr("en", "Czekaj"), "Wait");
    }
}
