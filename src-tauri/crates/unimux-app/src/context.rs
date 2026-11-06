//! The services of one app run, shared by every command (`Arc<AppContext>`). Built before `tauri::Builder` (state is loaded
//! and owned by Rust from the first wave); the AppHandle is filled in by `setup`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::Value;
use tauri::{AppHandle, Emitter, EventTarget, Manager};

use unimux_core::crash_log::{ReportLimiter, RollingLog};
use unimux_core::dev_overrides::DevOverrides;
use unimux_core::startup_timing::{StartupLog, StartupTimer};
use unimux_ipc::{Call, EventSink, Events, Ports, Router, Scope, SendQueue, WindowGuard};
use unimux_state::broadcast::StateBroadcaster;
use unimux_state::store::Saver;
use unimux_state::{Normalizer, Platform, StateController, StateNormalizer};

/// Origins the app windows load from: production (WebView2 `http://tauri.localhost`, WKWebView `tauri://localhost`) and the
/// Vite dev server of `npm run tauri dev`.
pub fn app_origins() -> Vec<String> {
    let mut origins =
        vec!["http://tauri.localhost".to_string(), "https://tauri.localhost".to_string(), "tauri://localhost".to_string()];
    if cfg!(dev_overrides) {
        origins.push("http://localhost:5174".to_string());
        origins.push("http://127.0.0.1:5174".to_string());
    }
    origins
}

/// Emits through Tauri once the app exists (events before that are dropped: no window can listen yet).
#[derive(Default)]
pub struct TauriSink {
    pub app: OnceLock<AppHandle>,
}

impl EventSink for TauriSink {
    fn app_windows(&self) -> Vec<String> {
        let Some(app) = self.app.get() else { return vec![] };
        let mut labels: Vec<String> =
            app.webview_windows().into_keys().filter(|l| l == "main" || l.starts_with("detached-")).collect();
        labels.sort_by_key(|l| l != "main");
        labels
    }
    fn emit_to(&self, label: &str, event: &str, payload: &Value) {
        if let Some(app) = self.app.get() {
            let _ = app.emit_to(EventTarget::webview_window(label), event, payload);
        }
    }
}

pub struct AppContext {
    pub data_dir: PathBuf,
    pub overrides: DevOverrides,
    pub platform: Platform,
    pub windows_build: u32,
    pub crash: Arc<RollingLog>,
    pub timer: Arc<StartupTimer>,
    pub startup_log: Arc<StartupLog>,
    pub state: Arc<StateController>,
    pub saver: Arc<Saver>,
    pub broadcaster: Arc<StateBroadcaster>,
    pub sink: Arc<TauriSink>,
    pub events: Arc<Events>,
    pub guard: Arc<WindowGuard>,
    pub ports: Arc<Ports>,
    pub router: OnceLock<Arc<Router>>,
    pub sends: OnceLock<SendQueue<Call>>,
    /// The renderer -> host port messages, in order per window and port (lanes `<label>\0port:<kind>`).
    pub port_posts: OnceLock<SendQueue<crate::ipc::PortPost>>,
    /// `claimAppStart`: true only for the first renderer load of this run.
    pub app_start_unclaimed: AtomicBool,
    pub report_limiter: Mutex<ReportLimiter>,
    /// The main window was shown (first page load, renderer-boot or the 5 s fallback).
    pub main_shown: AtomicBool,
    /// W4: notifications, the copied secret, shell, dialogs, Dock badge (set by commands::os::register).
    pub os: OnceLock<Arc<crate::commands::os::OsService>>,
    /// Check build only: every renderer startup mark with the window label and the time (test_bridge `marks`).
    #[cfg(feature = "test-bridge")]
    pub test_marks: Mutex<Vec<(String, String, f64)>>,
}

impl AppContext {
    pub fn new(
        data_dir: PathBuf,
        overrides: DevOverrides,
        crash: Arc<RollingLog>,
        timer: Arc<StartupTimer>,
        startup_log: Arc<StartupLog>,
        state: Value,
    ) -> Arc<Self> {
        let normalizer: Arc<dyn Normalizer> = Arc::new(StateNormalizer);
        let controller = Arc::new(StateController::new(state, normalizer.clone()));
        let crash_for_saver = crash.clone();
        let saver = Saver::new(data_dir.clone(), Arc::new(move |m: &str| crash_for_saver.warn(m)));
        let sink = Arc::new(TauriSink::default());
        let events = Arc::new(Events::new(sink.clone()));
        let ev = events.clone();
        let broadcaster = StateBroadcaster::new(
            controller.snapshot(),
            Arc::new(move |change: Value| ev.emit_raw(&Scope::Broadcast, "state:changed", &Value::Array(vec![change]))),
        );
        // Every change: saved (debounced) and sent to the windows, in revision order.
        let saver_hook = saver.clone();
        let b = broadcaster.clone();
        controller.on_change(move |change| {
            saver_hook.save(change.snapshot.state.clone());
            b.changed(change.snapshot, change.batch);
        });
        // A waiting batched state change leaves before any other event (stateBroadcast.ts flush).
        let b = broadcaster.clone();
        events.before_emit(move || b.flush());
        Arc::new(Self {
            data_dir,
            overrides,
            platform: Platform::current(),
            windows_build: unimux_platform::windows_build(),
            crash,
            timer,
            startup_log,
            state: controller,
            saver,
            broadcaster,
            sink,
            events,
            guard: Arc::new(WindowGuard::new(app_origins())),
            ports: Arc::new(Ports::new()),
            router: OnceLock::new(),
            sends: OnceLock::new(),
            port_posts: OnceLock::new(),
            app_start_unclaimed: AtomicBool::new(true),
            report_limiter: Mutex::new(ReportLimiter::default()),
            main_shown: AtomicBool::new(false),
            os: OnceLock::new(),
            #[cfg(feature = "test-bridge")]
            test_marks: Mutex::new(Vec::new()),
        })
    }

    pub fn app(&self) -> Option<&AppHandle> {
        self.sink.app.get()
    }

    pub fn router(&self) -> &Arc<Router> {
        self.router.get().expect("router is built before the app runs")
    }

    /// Records a startup mark and rewrites this launch's line of startup.log.
    pub fn mark(&self, name: &str) {
        self.timer.mark(name);
        self.startup_log.flush(&self.timer);
    }

    /// The last save (quit, session end): retried for up to 3 s.
    pub fn flush_state(&self) -> bool {
        self.broadcaster.flush();
        self.saver.flush_until_saved(Duration::from_secs(3), Duration::from_millis(250))
    }

    /// A window is gone (WindowEvent::Destroyed): its send and port lanes (and their worker tasks), its port sinks and its
    /// detached registration go with it. Labels of detached windows are unique, so nothing else would ever free them.
    pub fn window_destroyed(&self, label: &str) {
        if let Some(q) = self.sends.get() {
            q.forget(label);
        }
        if let Some(q) = self.port_posts.get() {
            q.forget(label);
        }
        self.ports.detach_window(label);
        self.guard.forget_detached(label);
    }

    pub fn claim_app_start(&self) -> bool {
        self.app_start_unclaimed.swap(false, Ordering::SeqCst)
    }
}
