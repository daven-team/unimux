//! U1: the updater of the app process (port of src/main/updater.ts and the update parts of src/main/index.ts): the
//! coordinator over the Tauri feed, the background checks (8 s after start, then every 30 min), the startup gate before the
//! main window, the window of the status bar button, and the hand-over: lock, the U2 update window started and visible, then
//! the full W6 wind-down (state saved) and the exit; the window runs the installer once this process is gone.
//!
//! macOS has no in-place engine yet (U5): an update there is offered as the download page only, like a 1.1.4 app that
//! cannot replace itself.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Value, json};
use tauri::{AppHandle, Manager as _};
use tokio_util::sync::CancellationToken;

use unimux_core::VERSION;
use unimux_core::time::now_ms;
use unimux_update::coordinator::{
    BoxFut, CheckReason, CoordinatorOptions, INSTALL_FAILED, Manual, Unsubscribe, UpdateCoordinator, UpdateError,
};
use unimux_update::gate::{
    self, GateDeps, GateEnv, GateHandle, GateOptions, GateResult, GateTimings, GateView, HideFn, UpdateMode, UpdateUiGuard,
    UpdateUiOwner,
};
use unimux_update::net::{NetBackend, NetBackendOptions};
use unimux_update::state::{Status, UpdateState};
use unimux_update::window as uw;

use crate::context::AppContext;
use crate::update_gate::{GateTexts, GateWindow};

const CHECK_EVERY: Duration = Duration::from_secs(30 * 60);
const FIRST_CHECK: Duration = Duration::from_secs(8);
const UNAVAILABLE: &str = "Aktualizacje są dostępne w zainstalowanej aplikacji.";
/// How long the gate waits for the update window of the update that just finished before anything of this start appears.
const UPDATE_WINDOW_GONE_WAIT: Duration = Duration::from_secs(4);

/// What the update question waits for (1.1.2 `update:busy`): an account swap or login in progress. A2 / A3 register their
/// probes; until then nothing is busy.
pub type BusyProbe = Arc<dyn Fn() -> (bool, bool) + Send + Sync>;

pub struct UpdateService {
    ctx: Weak<AppContext>,
    pub coordinator: Arc<UpdateCoordinator>,
    backend: Arc<NetBackend>,
    /// The installed app, or a development feed (MC_UPDATE_FEED with dev-overrides).
    active: bool,
    portable: bool,
    ui: UpdateUiGuard,
    /// True once the update window was started for the installer: the hand-over can no longer be abandoned.
    committed: AtomicBool,
    gate: Mutex<Option<Arc<GateWindow>>>,
    /// The startup gate's hidden window until [`dispose_after_main`] destroys it. Every gate window has the label
    /// `update-gate`: the install window takes this one down first, so its own can be created and the late disposal never
    /// destroys it.
    lingering: Mutex<Option<Arc<GateWindow>>>,
    staged: Mutex<Option<String>>,
    /// One staging of the runtime copy at a time: the pre-stage and a hand-over of this process share the staging folder
    /// (`runtime-<ver>.partial-<pid>`), and the hand-over must not remove the copy the warm-up start still runs from.
    stage_lock: Arc<Mutex<()>>,
    started: AtomicBool,
    busy: Mutex<Vec<BusyProbe>>,
}

/// Builds that never install on their own: electron-builder's portable exe set these (a 1.2.0 portable build would too).
fn portable_build() -> bool {
    ["PORTABLE_EXECUTABLE_DIR", "PORTABLE_EXECUTABLE_FILE"].iter().any(|v| std::env::var(v).is_ok_and(|v| !v.is_empty()))
}

fn language(ctx: &AppContext) -> String {
    crate::lifecycle::language(ctx)
}

impl UpdateService {
    pub fn new(ctx: &Arc<AppContext>) -> Arc<Self> {
        let overrides = &ctx.overrides;
        let active = unimux_core::PACKAGED || overrides.update_feed.is_some();
        let portable = portable_build();
        let crash = ctx.crash.clone();
        let log: Arc<dyn Fn(&str) + Send + Sync> = Arc::new(move |line: &str| crash.warn(line));
        let backend = NetBackend::new(NetBackendOptions {
            client: None,
            dev_feed: overrides.update_feed.clone(),
            public_key: overrides.update_pubkey.clone().unwrap_or_else(|| unimux_update::UPDATER_PUBLIC_KEY.to_string()),
            current_version: VERSION.to_string(),
            download_dir: uw::updater_root().join("pending"),
            // U5: no macOS engine yet, so a Mac gets the download page (with no reason line, like a portable build).
            manual: cfg!(target_os = "macos").then(Manual::default),
            log: log.clone(),
            download_stall: unimux_update::net::DOWNLOAD_STALL,
        });
        Arc::new_cyclic(|me: &Weak<UpdateService>| {
            let weak_ctx = Arc::downgrade(ctx);
            let me_emit = me.clone();
            let emit: Arc<dyn Fn(&UpdateState) + Send + Sync> = Arc::new(move |state: &UpdateState| {
                if let Some(ctx) = weak_ctx.upgrade() {
                    ctx.events.send("update:state", vec![serde_json::to_value(state).unwrap_or(Value::Null)]);
                }
                if let Some(me) = me_emit.upgrade() {
                    me.on_state(state);
                }
            });
            let o = CoordinatorOptions {
                backend: backend.clone(),
                emit,
                portable: Arc::new(move || portable),
                releases_url: unimux_update::RELEASES_URL.to_string(),
                now: Arc::new(|| now_ms() as f64),
                stall: unimux_update::coordinator::STALL,
                lookup_timeout: unimux_update::coordinator::LOOKUP_TIMEOUT,
                log,
                runtime: tauri::async_runtime::handle().inner().clone(),
            };
            Self {
                ctx: Arc::downgrade(ctx),
                coordinator: UpdateCoordinator::new(o),
                backend,
                active,
                portable,
                ui: UpdateUiGuard::default(),
                committed: AtomicBool::new(false),
                gate: Mutex::new(None),
                lingering: Mutex::new(None),
                staged: Mutex::new(None),
                stage_lock: Arc::new(Mutex::new(())),
                started: AtomicBool::new(false),
                busy: Mutex::new(Vec::new()),
            }
        })
    }

    fn ctx(&self) -> Option<Arc<AppContext>> {
        self.ctx.upgrade()
    }

    /// The private runtime of the update window is copied and started once as soon as the download is verified (SP6 / U2:
    /// the first start of a new file pays the antivirus scan), not when the user clicks.
    fn on_state(&self, state: &UpdateState) {
        if !cfg!(windows) || self.portable || state.status != Status::Ready {
            return;
        }
        let Some(version) = state.version.clone() else { return };
        {
            let mut staged = self.staged.lock();
            if staged.as_deref() == Some(&version) {
                return;
            }
            *staged = Some(version.clone());
        }
        let crash = self.ctx().map(|c| c.crash.clone());
        let lock = self.stage_lock.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let Ok(exe) = std::env::current_exe() else { return };
            let _staging = lock.lock();
            match uw::prestage(&exe, &uw::updater_root(), &version) {
                Ok(p) => {
                    if let Some(c) = &crash {
                        c.info(&format!("update window staged for {version} ({} ms copy, {:?} ms warm)", p.copy_ms, p.warm_ms));
                    }
                }
                Err(e) => {
                    if let Some(c) = &crash {
                        c.warn(&format!("update window staging failed: {e}"));
                    }
                }
            }
        });
    }

    pub fn gate_window(&self) -> Option<Arc<GateWindow>> {
        self.gate.lock().clone()
    }

    #[allow(dead_code, reason = "A2 / A3 register the account swap and login probes")]
    pub fn add_busy_probe(&self, probe: BusyProbe) {
        self.busy.lock().push(probe);
    }

    /// `update:busy`.
    pub fn busy(&self) -> Value {
        let (mut swap, mut login) = (false, false);
        for probe in self.busy.lock().iter() {
            let (s, l) = probe();
            swap |= s;
            login |= l;
        }
        json!({ "swap": swap, "login": login })
    }

    /// `update:get`.
    pub fn get(&self) -> Value {
        let mut state = serde_json::to_value(self.coordinator.get_state()).unwrap_or_else(|_| json!({}));
        if let Some(obj) = state.as_object_mut() {
            obj.insert("currentVersion".into(), json!(VERSION));
        }
        state
    }

    /// `checkForUpdates`: the shared entry point of manual and scheduled checks.
    pub async fn check_for_updates(&self, reason: CheckReason) {
        if !self.active {
            let mut s = UpdateState::new(Status::Unavailable);
            s.message = Some(UNAVAILABLE.into());
            self.coordinator.set_status(s);
            return;
        }
        let _ = self.coordinator.check(reason).await;
    }

    /// `initUpdater`: the first background check 8 s after the start (skipped when the startup gate just looked), then every
    /// 30 minutes; stopped by the quit.
    pub fn start(self: &Arc<Self>) {
        if self.started.swap(true, Ordering::SeqCst) || !self.active {
            return;
        }
        let me = Arc::downgrade(self);
        let timers = tauri::async_runtime::spawn(async move {
            tokio::time::sleep(FIRST_CHECK).await;
            if let Some(svc) = me.upgrade()
                && now_ms() as f64 - svc.coordinator.last_check_at() > 60_000.0
            {
                svc.check_for_updates(CheckReason::Background).await;
            }
            let mut every = tokio::time::interval(CHECK_EVERY);
            // 1.1.4's setInterval fired once after a sleep or hibernation; Burst would run one check per missed half hour.
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            every.tick().await;
            loop {
                every.tick().await;
                let Some(svc) = me.upgrade() else { return };
                svc.check_for_updates(CheckReason::Background).await;
            }
        });
        if let Some(ctx) = self.ctx() {
            let coordinator = self.coordinator.clone();
            ctx.lifecycle.on_exit(move || {
                timers.abort();
                coordinator.dispose();
            });
        }
    }

    /// `canInstallNow`: whether the status bar button may open the update window.
    pub fn can_install_now(&self) -> bool {
        let state = self.coordinator.get_state();
        !self.portable
            && state.portable != Some(true)
            && self.coordinator.installable()
            && matches!(state.status, Status::Available | Status::Downloading | Status::Ready)
    }

    pub fn handover_committed(&self) -> bool {
        self.committed.load(Ordering::SeqCst)
    }

    fn record_failure(&self, version: &str) {
        if let Some(ctx) = self.ctx() {
            gate::write_gate_record(&ctx.data_dir, version, now_ms());
        }
        self.coordinator.block(Some(version));
    }

    /// `handOver`: starts the update window for the installer of the downloaded `version` and quits. `hide` closes the
    /// in-app window once the update window is visible. False: nothing was handed over (the state already says why).
    /// `deadline`: the caller gave up before the window was up, so the hand-over is abandoned (lock released, the download
    /// kept); from the commit on it no longer applies.
    pub async fn hand_over(self: Arc<Self>, version: String, hide: HideFn, deadline: CancellationToken) -> bool {
        let Some(ctx) = self.ctx() else { return false };
        if self.portable || !self.coordinator.lock_handover(Some(&version)) {
            return false;
        }
        self.committed.store(false, Ordering::SeqCst);
        let give_up = |svc: &UpdateService| {
            svc.coordinator.fail_handover(INSTALL_FAILED);
            false
        };
        // U5 brings the macOS engine; the Mac never gets an installable offer before that (see the module comment).
        if !cfg!(windows) {
            return give_up(&self);
        }
        let Some(installer) = self.backend.artifact(&version) else {
            ctx.crash.warn(&format!("update {version}: the downloaded installer is gone"));
            return give_up(&self);
        };
        let Ok(app_exe) = std::env::current_exe() else { return give_up(&self) };
        let hand = uw::HandOver {
            installer,
            version: version.clone(),
            from_version: VERSION.to_string(),
            data_dir: ctx.data_dir.clone(),
            updater_root: uw::updater_root(),
            app_exe,
            language: language(&ctx),
            timeout_ms: uw::INSTALL_TIMEOUT_MS,
            env: None,
            webview_dir: None,
            // The macOS bundle swap (U5) is not wired into the coordinator yet: the Mac still only gets the download page.
            swap: None,
        };
        let started = Instant::now();
        let lock = self.stage_lock.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let _staging = lock.lock();
            uw::hand_over(&hand)
        })
        .await;
        let handed = match result {
            Ok(Ok(handed)) => handed,
            Ok(Err(e)) => {
                ctx.crash.warn(&format!("update window failed: {e}"));
                return give_up(&self);
            }
            Err(e) => {
                ctx.crash.warn(&format!("update window failed: {e}"));
                return give_up(&self);
            }
        };
        ctx.crash.info(&format!(
            "update {version}: window pid {} started in {} ms (shown: {:?} ms)",
            handed.pid,
            started.elapsed().as_millis(),
            handed.shown_ms
        ));
        if deadline.is_cancelled() {
            uw::abort_update_window(&ctx.data_dir);
            return give_up(&self);
        }
        hide();
        // From here the update runs: the window starts the installer once this process is gone.
        self.committed.store(true, Ordering::SeqCst);
        ctx.lifecycle.set_handoff_started();
        // The full wind-down (terminals, the last save, MCP and hooks), then the exit; while the startup gate decides nothing
        // was started, so the exit is immediate.
        let quit = ctx.clone();
        if let Some(app) = ctx.app() {
            let _ = app.run_on_main_thread(move || crate::lifecycle::request_quit(&quit, crate::lifecycle::QuitSource::Request));
        }
        true
    }
}

/// The gate's side effects in the app (index.ts runUpdateGate / openInstallWindow).
struct AppGateDeps {
    svc: Arc<UpdateService>,
    window: Arc<GateWindow>,
    /// The startup gate remembers a failure for the next start; the status bar window shows it in the status bar only.
    remember_failure: bool,
    handed: Arc<Mutex<Option<String>>>,
}

impl GateDeps for AppGateDeps {
    fn check(&self) -> BoxFut<Result<Option<String>, UpdateError>> {
        if !self.svc.active || self.svc.portable {
            return Box::pin(async { Ok(None) });
        }
        self.svc.coordinator.check(CheckReason::Startup)
    }
    fn recheck(&self) -> BoxFut<Result<Option<String>, UpdateError>> {
        if !self.svc.active || self.svc.portable {
            return Box::pin(async { Ok(None) });
        }
        self.svc.coordinator.check(CheckReason::Recheck)
    }
    fn is_downloaded(&self, version: &str) -> bool {
        self.svc.coordinator.is_downloaded(Some(version))
    }
    fn target(&self) -> Option<String> {
        self.svc.coordinator.current_target()
    }
    fn on_target_change(&self, listener: Arc<dyn Fn() + Send + Sync>) -> Option<Unsubscribe> {
        Some(self.svc.coordinator.on_target_change(listener))
    }
    fn download(&self, on_progress: Arc<dyn Fn(f64) + Send + Sync>) -> BoxFut<Result<(), UpdateError>> {
        let off = self.svc.coordinator.on_progress(on_progress);
        let download = self.svc.coordinator.download();
        Box::pin(async move {
            let result = download.await;
            off();
            result
        })
    }
    fn show(&self, view: GateView) {
        self.window.show(&view);
    }
    fn hide(&self) {
        self.window.hide();
    }
    fn handoff(&self, version: String, hide: HideFn, deadline: CancellationToken) -> BoxFut<Result<bool, UpdateError>> {
        *self.handed.lock() = Some(version.clone());
        let svc = self.svc.clone();
        Box::pin(async move { Ok(svc.hand_over(version, hide, deadline).await) })
    }
    fn handoff_committed(&self) -> bool {
        self.svc.handover_committed()
    }
    fn mark_attempt(&self, version: &str) {
        if let Some(ctx) = self.svc.ctx() {
            gate::write_gate_record(&ctx.data_dir, version, now_ms());
        }
    }
    fn record_failure(&self, version: &str) {
        if self.remember_failure {
            self.svc.record_failure(version);
        }
    }
    fn log(&self, line: &str) {
        if let Some(ctx) = self.svc.ctx() {
            ctx.crash.warn(line);
        }
    }
}

fn gate_options(skip_version: Option<String>) -> GateOptions {
    let mut timings = GateTimings::default();
    if cfg!(target_os = "macos") {
        // The macOS archive is about 140 MB: allow more than the default for the whole download.
        timings.download_total = gate::MAC_DOWNLOAD_TOTAL;
    }
    GateOptions { skip_version, timings }
}

/// The hidden gate window goes once the main window's page is up (see [`GateWindow::hide`]); at most 30 s later anyway.
fn dispose_after_main(ctx: &Arc<AppContext>, svc: &Arc<UpdateService>, window: Arc<GateWindow>) {
    *svc.lingering.lock() = Some(window);
    let (ctx, svc) = (ctx.clone(), svc.clone());
    tauri::async_runtime::spawn(async move {
        let deadline = Instant::now() + Duration::from_secs(30);
        while !ctx.main_shown.load(Ordering::SeqCst) && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
        // None: the install window already took it down (and the label now belongs to its own window).
        let lingering = svc.lingering.lock().take();
        if let Some(window) = lingering {
            window.dispose();
        }
    });
}

/// `runUpdateGate`: decides whether the startup check runs before the main window. False: start the app now (nothing was
/// started). True: the gate runs and calls `start_app` when the current version is to start (it never does when the
/// installer took over).
pub fn startup_gate(ctx: &Arc<AppContext>, app: &AppHandle, start_app: Arc<dyn Fn() + Send + Sync>) -> bool {
    let Some(svc) = ctx.update.get().cloned() else { return false };
    let now = now_ms() as f64;
    let failure = gate::read_gate_failure(&ctx.data_dir);
    let recent = gate::is_active_failure(failure.as_ref(), VERSION, now);
    let state = ctx.state.get();
    let mode = UpdateMode::parse(state.pointer("/settings/updateMode").and_then(Value::as_str));
    if let Some(f) = &failure
        && recent
        && mode != UpdateMode::Manual
    {
        svc.coordinator.block(Some(&f.version));
    }
    let env = GateEnv {
        supported_platform: cfg!(any(windows, target_os = "macos")),
        packaged: svc.active,
        portable: svc.portable,
        mode,
        recent_failure: recent,
    };
    if !gate::should_gate_on_startup(&env) || !svc.ui.acquire(UpdateUiOwner::StartupGate) {
        return false;
    }
    ctx.lifecycle.set_gating(true);
    let skip = gate::gate_skip_version(failure.as_ref(), VERSION, now);
    let (ctx, app) = (ctx.clone(), app.clone());
    tauri::async_runtime::spawn(async move {
        // The update window of the update that just finished may say "done" now, and nothing of this start may appear next
        // to it (the prompt of a still newer release comes after it has gone).
        if cfg!(windows) {
            let dir = ctx.data_dir.clone();
            let _ = tauri::async_runtime::spawn_blocking(move || {
                uw::signal_update_ready(&dir, VERSION);
                let deadline = Instant::now() + UPDATE_WINDOW_GONE_WAIT;
                while Instant::now() < deadline && uw::update_window_alive(&dir, now_ms() as f64) {
                    std::thread::sleep(Duration::from_millis(100));
                }
            })
            .await;
        }
        let texts = GateTexts::new(&language(&ctx), "Aktualizacja nie powiodła się - uruchamiam obecną wersję");
        let handle = GateHandle::new();
        let window = GateWindow::new(&ctx, app.clone(), texts, handle.clone());
        *svc.gate.lock() = Some(window.clone());
        let handed = Arc::new(Mutex::new(None));
        let deps =
            Arc::new(AppGateDeps { svc: svc.clone(), window: window.clone(), remember_failure: true, handed: handed.clone() });
        let result = gate::run_startup_gate(deps, handle, gate_options(skip)).await;
        *svc.gate.lock() = None;
        ctx.mark("update-gate-done");
        if result != GateResult::Installing {
            ctx.lifecycle.set_gating(false);
            svc.ui.release(UpdateUiOwner::StartupGate);
            start_app();
            dispose_after_main(&ctx, &svc, window);
            return;
        }
        // After a hand-over the app is quitting for the installer. If it has not quit this long after, it starts normally
        // instead of hanging unseen (the update window still supervising means the installer is only slow: keep waiting).
        let armed = Instant::now();
        tokio::time::sleep(gate::HANDOFF_QUIT_WATCHDOG).await;
        while gate::handoff_watchdog_waits(
            uw::install_in_progress(&ctx.data_dir, VERSION, uw::START_BLOCK_MS, now_ms() as f64),
            armed.elapsed(),
        ) {
            tokio::time::sleep(gate::HANDOFF_QUIT_WATCHDOG / 3).await;
        }
        ctx.crash.error("the installer did not quit the app, starting normally");
        if let Some(version) = handed.lock().clone() {
            svc.record_failure(&version);
        }
        uw::abort_update_window(&ctx.data_dir);
        ctx.lifecycle.set_gating(false);
        svc.ui.release(UpdateUiOwner::StartupGate);
        start_app();
        dispose_after_main(&ctx, &svc, window);
    });
    true
}

/// `openInstallWindow`: the status bar button of an offered, downloading or downloaded update opens the one update window,
/// which shows the download (joining the running one), then the hand-over.
pub fn open_install_window(ctx: &Arc<AppContext>) {
    let Some(svc) = ctx.update.get().cloned() else { return };
    let Some(version) = svc.coordinator.current_target() else { return };
    if !svc.can_install_now() || !svc.ui.acquire(UpdateUiOwner::InstallWindow) {
        return;
    }
    let Some(app) = ctx.app().cloned() else {
        svc.ui.release(UpdateUiOwner::InstallWindow);
        return;
    };
    let ctx = ctx.clone();
    tauri::async_runtime::spawn(async move {
        // The startup gate's hidden window still holds the label (the button can be clicked within a second of the main
        // window showing): it goes first, the main window keeps the WebView2 browser process.
        let lingering = svc.lingering.lock().take();
        if let Some(old) = lingering {
            old.dispose();
            // The label is free once the event loop has handled the destruction.
            let deadline = Instant::now() + Duration::from_secs(5);
            while app.get_webview_window(crate::update_gate::LABEL).is_some() && Instant::now() < deadline {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        }
        let texts = GateTexts::new(&language(&ctx), "Aktualizacja nie powiodła się");
        let handle = GateHandle::new();
        let window = GateWindow::new(&ctx, app, texts, handle.clone());
        *svc.gate.lock() = Some(window.clone());
        let deps = Arc::new(AppGateDeps {
            svc: svc.clone(),
            window: window.clone(),
            // The failure is shown by the status bar (with a retry); nothing is remembered for the next start.
            remember_failure: false,
            handed: Arc::new(Mutex::new(None)),
        });
        let result = gate::run_install_window(deps, handle, gate_options(None), version).await;
        *svc.gate.lock() = None;
        if result != GateResult::Installing {
            // The main window keeps the WebView2 browser process: the window can go at once.
            window.dispose();
            svc.ui.release(UpdateUiOwner::InstallWindow);
        }
    });
}
