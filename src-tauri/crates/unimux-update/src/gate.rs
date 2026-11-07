//! The update check before the main window exists and the update window of the status bar button (port of
//! src/main/startupGate.ts `runStartupGate` / `runInstallWindow`). Every side effect is injected ([`GateDeps`]), so the
//! fail-open rules are tested with tokio's paused clock.
//!
//! Every failure path (offline, error, timeout, a closed window) ends in [`GateResult::StartApp`]; only a completed hand-over
//! to the installer ends in [`GateResult::Installing`].

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::coordinator::{BoxFut, Unsubscribe, UpdateError};
use crate::version::compare_versions;

pub const CHECK_TIMEOUT: Duration = Duration::from_secs(8);
/// The window stays hidden for this long, so a quick "no update" answer never flashes it. A window that did appear closes the
/// moment the answer is in: no answer is ever held back to keep a window on screen.
pub const SHOW_AFTER: Duration = Duration::from_millis(800);
/// A download that reports nothing for this long counts as failed.
pub const DOWNLOAD_STALL: Duration = Duration::from_secs(60);
/// The whole download may not take longer than this, however steadily it progresses.
pub const DOWNLOAD_TOTAL: Duration = Duration::from_secs(3 * 60);
/// The macOS archive is about 140 MB: more for the whole download (index.ts MAC_GATE_DOWNLOAD_TOTAL_MS).
pub const MAC_DOWNLOAD_TOTAL: Duration = Duration::from_secs(10 * 60);
/// The last look at the feed before the hand-over may take this long; without an answer the downloaded update proceeds.
pub const RECHECK_TIMEOUT: Duration = Duration::from_secs(5);
/// Showing the installing window and starting the installer is expected to take seconds.
pub const HANDOFF_TIMEOUT: Duration = Duration::from_secs(20);
/// How long the failure notice stays visible before the current version starts.
pub const ERROR_HOLD: Duration = Duration::from_millis(2500);
/// After a failed update the gate is skipped for this long, so a broken release cannot delay every launch.
pub const FAILURE_COOLDOWN_MS: f64 = 6.0 * 60.0 * 60.0 * 1000.0;
/// If the installer has not quit the app this long after the hand-over, the app starts normally (index.ts
/// HANDOFF_QUIT_WATCHDOG_MS).
pub const HANDOFF_QUIT_WATCHDOG: Duration = Duration::from_secs(15);
/// How long the app keeps waiting while the update window still supervises (safeWindow.ts HANDOFF_QUIT_WAIT_MAX_MS).
pub const HANDOFF_QUIT_WAIT_MAX: Duration = Duration::from_secs(75);

// ── when the gate runs, update-gate.json ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateMode {
    Manual,
    Ask,
}

impl UpdateMode {
    /// The normalized setting (`settings.updateMode`); anything else is the default, manual.
    pub fn parse(value: Option<&str>) -> Self {
        if value == Some("ask") { UpdateMode::Ask } else { UpdateMode::Manual }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct GateEnv {
    /// `process.platform` is win32 or darwin.
    pub supported_platform: bool,
    pub packaged: bool,
    pub portable: bool,
    pub mode: UpdateMode,
    /// An update failed less than the cooldown ago.
    pub recent_failure: bool,
}

/// The gate exists only for the installed Windows build and the macOS app in the 'ask' (Automatic) mode; 'manual' starts the
/// app at once.
pub fn should_gate_on_startup(env: &GateEnv) -> bool {
    env.supported_platform && env.packaged && !env.portable && env.mode == UpdateMode::Ask && !env.recent_failure
}

/// update-gate.json `{version, at}`.
#[derive(Debug, Clone, PartialEq)]
pub struct FailureRecord {
    pub version: String,
    pub at: f64,
}

/// Parses a persisted failure record; anything malformed counts as no failure.
pub fn parse_failure(raw: &serde_json::Value) -> Option<FailureRecord> {
    let version = raw.get("version")?.as_str()?.to_string();
    let at = raw.get("at")?.as_f64().filter(|a| a.is_finite())?;
    Some(FailureRecord { version, at })
}

pub fn is_recent_failure(failure: Option<&FailureRecord>, now: f64) -> bool {
    failure.is_some_and(|f| now - f.at >= 0.0 && now - f.at < FAILURE_COOLDOWN_MS)
}

/// A record of an attempt only counts while the version it targeted is not running yet: after a successful update the
/// record names the running version, and the next start (which may offer a still newer release) must not be held back by it.
pub fn is_active_failure(failure: Option<&FailureRecord>, current_version: &str, now: f64) -> bool {
    failure.is_some_and(|f| compare_versions(&f.version, current_version).is_gt()) && is_recent_failure(failure, now)
}

/// The version the startup prompt must not offer again: only while its failure is active.
pub fn gate_skip_version(failure: Option<&FailureRecord>, current_version: &str, now: f64) -> Option<String> {
    failure.filter(|f| is_active_failure(Some(f), current_version, now)).map(|f| f.version.clone())
}

pub const GATE_FILE: &str = "update-gate.json";

pub fn read_gate_failure(data_dir: &std::path::Path) -> Option<FailureRecord> {
    let text = std::fs::read_to_string(data_dir.join(GATE_FILE)).ok()?;
    parse_failure(&serde_json::from_str(&text).ok()?)
}

/// `writeGateRecord`: `{"version":..., "at":...}` like JSON.stringify (best effort).
pub fn write_gate_record(data_dir: &std::path::Path, version: &str, now_ms: i64) {
    let json = serde_json::json!({ "version": version, "at": now_ms }).to_string();
    let _ = unimux_core::atomic_write::atomic_write(&data_dir.join(GATE_FILE), json.as_bytes(), &Default::default());
}

/// `clearGateFailureIfUpdated`: the record of an attempt or failure ends once the version it targeted (or a newer one) runs.
pub fn clear_gate_failure_if_updated(data_dir: &std::path::Path, running_version: &str) -> bool {
    match read_gate_failure(data_dir) {
        Some(record) if compare_versions(running_version, &record.version).is_ge() => {
            std::fs::remove_file(data_dir.join(GATE_FILE)).is_ok()
        }
        _ => false,
    }
}

/// `handoffWatchdogAction`: keep waiting while the update window still supervises (a late administrator prompt), up to the
/// limit.
pub fn handoff_watchdog_waits(installing: bool, waited: Duration) -> bool {
    installing && waited < HANDOFF_QUIT_WAIT_MAX
}

// ── one update UI at a time ───────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateUiOwner {
    StartupGate,
    InstallWindow,
}

/// At most one update window or prompt exists at any time (updateUiGuard.ts).
#[derive(Default)]
pub struct UpdateUiGuard(Mutex<Option<UpdateUiOwner>>);

impl UpdateUiGuard {
    /// True when `owner` now holds the lock; false when any owner (also the same one) already holds it.
    pub fn acquire(&self, owner: UpdateUiOwner) -> bool {
        let mut held = self.0.lock();
        if held.is_some() {
            return false;
        }
        *held = Some(owner);
        true
    }

    pub fn release(&self, owner: UpdateUiOwner) {
        let mut held = self.0.lock();
        if *held == Some(owner) {
            *held = None;
        }
    }

    pub fn owner(&self) -> Option<UpdateUiOwner> {
        *self.0.lock()
    }
}

// ── the flow ──────────────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, PartialEq)]
pub enum GateView {
    Checking,
    Ask { version: String },
    Downloading { version: String, percent: f64 },
    Installing { version: String },
    Failed { version: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateResult {
    StartApp,
    Installing,
}

pub type HideFn = Arc<dyn Fn() + Send + Sync>;

pub trait GateDeps: Send + Sync + 'static {
    /// The available update, or None when the app is current.
    fn check(&self) -> BoxFut<Result<Option<String>, UpdateError>>;
    /// The last look at the feed before the installer is started; a failure of it never blocks the update.
    fn recheck(&self) -> BoxFut<Result<Option<String>, UpdateError>> {
        self.check()
    }
    /// Whether `version` is already downloaded and verified (the window then goes straight to the hand-over).
    fn is_downloaded(&self, _version: &str) -> bool {
        false
    }
    /// The version the update is currently heading for; it changes when a newer release supersedes the offer.
    fn target(&self) -> Option<String> {
        None
    }
    /// Registers the callback for a changed target; returns the unsubscribe.
    fn on_target_change(&self, _listener: Arc<dyn Fn() + Send + Sync>) -> Option<Unsubscribe> {
        None
    }
    /// The check outlived its timeout; its late answer must not be used by the gate.
    fn abandon_check(&self) {}
    /// Starts downloading the offered update (as soon as the prompt is shown); "Later" leaves it running.
    fn download(&self, on_progress: Arc<dyn Fn(f64) + Send + Sync>) -> BoxFut<Result<(), UpdateError>>;
    /// Shows (creating if needed) and updates the gate window.
    fn show(&self, view: GateView);
    fn hide(&self);
    /// Starts the installing window and installer; calls `hide` once the hand-over is visible. True when it took over.
    fn handoff(&self, version: String, hide: HideFn, deadline: CancellationToken) -> BoxFut<Result<bool, UpdateError>>;
    /// True once the installer is being started: a hand-over that outlived its deadline but is committed is not a failure.
    fn handoff_committed(&self) -> bool {
        false
    }
    /// Written right before the installer starts, so an installer that fails outside the app still counts as a failure.
    fn mark_attempt(&self, _version: &str) {}
    fn record_failure(&self, version: &str);
    /// Why a flow ended in the failure notice (crash.log in the app).
    fn log(&self, _line: &str) {}
}

#[derive(Debug, Clone)]
pub struct GateTimings {
    pub check_timeout: Duration,
    pub show_after: Duration,
    pub download_stall: Duration,
    pub download_total: Duration,
    pub handoff_timeout: Duration,
    pub recheck_timeout: Duration,
    pub error_hold: Duration,
}

impl Default for GateTimings {
    fn default() -> Self {
        Self {
            check_timeout: CHECK_TIMEOUT,
            show_after: SHOW_AFTER,
            download_stall: DOWNLOAD_STALL,
            download_total: DOWNLOAD_TOTAL,
            handoff_timeout: HANDOFF_TIMEOUT,
            recheck_timeout: RECHECK_TIMEOUT,
            error_hold: ERROR_HOLD,
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct GateOptions {
    /// A version that already failed; it is never retried within this launch.
    pub skip_version: Option<String>,
    pub timings: GateTimings,
}

#[derive(Default)]
struct FlowState {
    version: String,
    chosen: bool,
    percent: f64,
    downloaded: bool,
    handing_over: bool,
    shown: bool,
    download: Option<DownloadWait>,
}

#[derive(Clone)]
struct DownloadWait(crate::settled::Settled<Result<(), UpdateError>>);

/// What the gate window (or a test) uses to answer: close (X, Escape, "Later") and "Install now".
pub struct GateHandle {
    cancellable: AtomicBool,
    stopped: AtomicBool,
    cancelled: CancellationToken,
    install: CancellationToken,
    state: Mutex<FlowState>,
}

impl Default for GateHandle {
    fn default() -> Self {
        Self {
            cancellable: AtomicBool::new(true),
            stopped: AtomicBool::new(false),
            cancelled: CancellationToken::new(),
            install: CancellationToken::new(),
            state: Mutex::new(FlowState::default()),
        }
    }
}

impl GateHandle {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    /// The user closed the window (X, Escape, "Later", a window that crashed): honoured only until the installer is handed
    /// over; then the app starts as it is.
    pub fn cancel(&self) {
        if self.cancellable.load(Ordering::SeqCst) {
            self.stopped.store(true, Ordering::SeqCst);
            self.cancelled.cancel();
        }
    }

    /// "Install now" of the prompt.
    pub fn install(&self) {
        self.install.cancel();
    }

    pub fn is_cancellable(&self) -> bool {
        self.cancellable.load(Ordering::SeqCst)
    }
}

/// Why the flow left its happy path.
enum Stop {
    Cancelled,
    Error(UpdateError),
    /// The hand-over outlived its deadline before the installer started (no failure is recorded).
    Abandoned,
}

struct Flow {
    deps: Arc<dyn GateDeps>,
    h: Arc<GateHandle>,
    t: GateTimings,
    /// Target changes arrive from the coordinator's own tasks; the downloads they start run here.
    rt: tokio::runtime::Handle,
}

impl Flow {
    fn show(&self, view: GateView) {
        if self.h.stopped.load(Ordering::SeqCst) {
            return;
        }
        self.h.state.lock().shown = true;
        self.deps.show(view);
    }

    fn hide(&self) {
        let was = std::mem::replace(&mut self.h.state.lock().shown, false);
        if was {
            self.deps.hide();
        }
    }

    fn hide_fn(self: &Arc<Self>) -> HideFn {
        let me = self.clone();
        Arc::new(move || me.hide())
    }

    fn version(&self) -> String {
        self.h.state.lock().version.clone()
    }

    fn start_download(self: &Arc<Self>) {
        let mine = {
            let mut s = self.h.state.lock();
            s.percent = 0.0;
            s.version.clone()
        };
        let downloaded = self.deps.is_downloaded(&mine);
        self.h.state.lock().downloaded = downloaded;
        let me = self.clone();
        let target = mine.clone();
        let on_percent: Arc<dyn Fn(f64) + Send + Sync> = Arc::new(move |percent| {
            let view = {
                let mut s = me.h.state.lock();
                if s.version != target {
                    return;
                }
                s.percent = percent;
                s.chosen.then(|| GateView::Downloading { version: s.version.clone(), percent })
            };
            if let Some(view) = view {
                me.show(view);
            }
        });
        let attempt = download_with_stall(self.deps.clone(), self.t.download_stall, on_percent);
        let (settle, waiting) = crate::settled::pending();
        self.h.state.lock().download = Some(DownloadWait(waiting));
        let me = self.clone();
        // A download nobody waits for any more ("Later", or a newer version replaced it) may still fail; the updater reports
        // that itself.
        self.rt.spawn(async move {
            let result = attempt.await;
            if result.is_ok() {
                let mut s = me.h.state.lock();
                if s.version == mine {
                    s.downloaded = true;
                }
            }
            settle.settle(result);
        });
    }

    /// A newer release became the target: every view moves to it and its download is joined.
    fn retarget(self: &Arc<Self>, next: Option<String>) -> bool {
        let view = {
            let mut s = self.h.state.lock();
            let Some(next) = next else { return false };
            if s.handing_over || next == s.version {
                return false;
            }
            s.version = next.clone();
            if s.chosen { GateView::Downloading { version: next, percent: 0.0 } } else { GateView::Ask { version: next } }
        };
        self.start_download();
        self.show(view);
        true
    }

    async fn race<T>(&self, fut: impl std::future::Future<Output = T>) -> Result<T, Stop> {
        tokio::select! {
            biased;
            _ = self.h.cancelled.cancelled() => Err(Stop::Cancelled),
            value = fut => Ok(value),
        }
    }
}

/// Downloads with a stall watchdog that restarts on every progress report.
fn download_with_stall(
    deps: Arc<dyn GateDeps>,
    stall: Duration,
    on_percent: Arc<dyn Fn(f64) + Send + Sync>,
) -> impl std::future::Future<Output = Result<(), UpdateError>> + Send + 'static {
    let beat = Arc::new(Notify::new());
    let report = beat.clone();
    let download = deps.download(Arc::new(move |percent| {
        report.notify_one();
        on_percent(if percent.is_finite() { percent.clamp(0.0, 100.0) } else { 0.0 });
    }));
    async move {
        tokio::pin!(download);
        loop {
            tokio::select! {
                result = &mut download => return result,
                _ = beat.notified() => continue,
                _ = tokio::time::sleep(stall) => return Err(UpdateError::Failed("download stalled".into())),
            }
        }
    }
}

/// The pre-start check.
pub async fn run_startup_gate(deps: Arc<dyn GateDeps>, handle: Arc<GateHandle>, options: GateOptions) -> GateResult {
    run_flow(deps, handle, options, true, None).await
}

/// The update window opened from the status bar: the version to install is already known, so there is no check and no prompt;
/// the window shows the download (joining a running one), then the hand-over. StartApp means nothing was handed over and the
/// app simply keeps running.
pub async fn run_install_window(
    deps: Arc<dyn GateDeps>,
    handle: Arc<GateHandle>,
    options: GateOptions,
    version: String,
) -> GateResult {
    run_flow(deps, handle, options, false, Some(version)).await
}

async fn run_flow(
    deps: Arc<dyn GateDeps>,
    h: Arc<GateHandle>,
    options: GateOptions,
    prompt: bool,
    known: Option<String>,
) -> GateResult {
    let rt = tokio::runtime::Handle::current();
    let flow = Arc::new(Flow { deps: deps.clone(), h: h.clone(), t: options.timings.clone(), rt });
    let t = &options.timings;
    let show_timer = CancellationToken::new();
    if known.is_none() {
        let (f, timer, after) = (flow.clone(), show_timer.clone(), t.show_after);
        tokio::spawn(async move {
            tokio::select! {
                _ = timer.cancelled() => {}
                _ = tokio::time::sleep(after) => f.show(GateView::Checking),
            }
        });
    }
    let found = match known {
        Some(version) => Some(version),
        None => {
            let pending = deps.check();
            let outcome = flow.race(tokio::time::timeout(t.check_timeout, pending)).await;
            match outcome {
                Ok(Ok(Ok(found))) => found,
                other => {
                    // Only a timeout or the user abandons the check (its late answer must not be used).
                    if matches!(other, Err(Stop::Cancelled) | Ok(Err(_))) {
                        deps.abandon_check();
                    }
                    show_timer.cancel();
                    flow.hide();
                    return GateResult::StartApp;
                }
            }
        }
    };
    show_timer.cancel();
    let Some(found) = found.filter(|f| Some(f) != options.skip_version.as_ref()) else {
        flow.hide();
        return GateResult::StartApp;
    };
    h.state.lock().version = found;

    let unsubscribe = {
        let f = flow.clone();
        let deps = deps.clone();
        deps.clone().on_target_change(Arc::new(move || {
            f.retarget(deps.target());
        }))
    };
    let result = flow_body(&flow, prompt).await;
    let outcome = match result {
        Ok(result) => result,
        Err(stop) => fail_path(&flow, stop).await,
    };
    if let Some(unsubscribe) = unsubscribe {
        unsubscribe();
    }
    outcome
}

async fn flow_body(flow: &Arc<Flow>, prompt: bool) -> Result<GateResult, Stop> {
    let (deps, h, t) = (&flow.deps, &flow.h, &flow.t);
    // The download starts together with the prompt: the offer is already an explicit statement that an update exists, and
    // downloading is not installing. Its progress only reaches the window once "Install now" was chosen.
    h.state.lock().chosen = !prompt;
    flow.start_download();
    if prompt {
        // "Later" (the button, X or Escape) is the cancel path and starts the current version.
        let version = flow.version();
        flow.show(GateView::Ask { version });
        flow.race(h.install.cancelled()).await?;
        // A download that started with the prompt reports and settles first (in the TS code its callbacks ran before the
        // choice was looked at).
        tokio::task::yield_now().await;
        h.state.lock().chosen = true;
    }
    loop {
        let round = flow.version();
        let (downloaded, percent, download) = {
            let s = h.state.lock();
            (s.downloaded, s.percent, s.download.clone())
        };
        if !downloaded {
            flow.show(GateView::Downloading { version: round.clone(), percent });
            let wait = async move {
                match download {
                    Some(d) => d.0.wait().await.unwrap_or(Err(UpdateError::Superseded)),
                    None => Err(UpdateError::Superseded),
                }
            };
            let outcome = flow.race(tokio::time::timeout(t.download_total, wait)).await?;
            let outcome = outcome.unwrap_or_else(|_| Err(UpdateError::Failed("download took too long".into())));
            match outcome {
                Err(UpdateError::Superseded) => {
                    // The coordinator moved on: follow its target; if it has none the offer is simply gone.
                    if !flow.retarget(deps.target()) && flow.version() == round {
                        return Err(Stop::Error(UpdateError::Superseded));
                    }
                    continue;
                }
                Err(error) => {
                    if flow.version() != round {
                        continue;
                    }
                    return Err(Stop::Error(error));
                }
                Ok(()) => {
                    if flow.version() != round {
                        continue;
                    }
                }
            }
        }
        // The last look at the feed: a release published while this one was offered or downloading replaces it.
        let again = match flow.race(tokio::time::timeout(t.recheck_timeout, deps.recheck())).await? {
            Ok(Ok(found)) => Some(found),
            // The feed cannot be read: what is downloaded stays the target.
            _ => None,
        };
        if let Some(Some(next)) = &again {
            flow.retarget(Some(next.clone()));
        }
        if flow.version() != round {
            continue;
        }
        if matches!(again, Some(None)) {
            h.cancellable.store(false, Ordering::SeqCst);
            flow.hide();
            return Ok(GateResult::StartApp);
        }
        let target = deps.target();
        if flow.retarget(target) {
            continue;
        }
        h.state.lock().handing_over = true;
        break;
    }
    h.cancellable.store(false, Ordering::SeqCst);
    let version = flow.version();
    flow.show(GateView::Installing { version: version.clone() });
    deps.mark_attempt(&version);
    let deadline = CancellationToken::new();
    // The hand-over keeps running past its deadline (the window's preparation is slow, not failed); only its signal fires.
    let handed = tokio::spawn(deps.handoff(version, flow.hide_fn(), deadline.clone()));
    match tokio::time::timeout(t.handoff_timeout, handed).await {
        Ok(Ok(Ok(true))) => Ok(GateResult::Installing),
        Ok(Ok(Ok(false))) => Err(Stop::Error(UpdateError::Failed("installer hand-over failed".into()))),
        Ok(Ok(Err(error))) => Err(Stop::Error(error)),
        Ok(Err(join)) => Err(Stop::Error(UpdateError::Failed(join.to_string()))),
        Err(_) => {
            // Slow preparation (the update window runtime) is not a failed installer: if the installer was already started
            // the update runs on, otherwise the hand-over is abandoned and the downloaded update is kept.
            if deps.handoff_committed() {
                return Ok(GateResult::Installing);
            }
            deadline.cancel();
            Err(Stop::Abandoned)
        }
    }
}

async fn fail_path(flow: &Arc<Flow>, stop: Stop) -> GateResult {
    let (deps, h, t) = (&flow.deps, &flow.h, &flow.t);
    let before_handoff = h.cancellable.load(Ordering::SeqCst);
    if matches!(stop, Stop::Cancelled) {
        h.cancellable.store(false, Ordering::SeqCst);
        flow.hide();
        return GateResult::StartApp;
    }
    let version = flow.version();
    // An offer that stood for a long time may be gone (a newer release replaced it): look once more before calling it a
    // failure, and never block a version that was merely not found any more.
    if before_handoff {
        match flow.race(tokio::time::timeout(t.check_timeout, deps.check())).await {
            Err(_) => {
                h.cancellable.store(false, Ordering::SeqCst);
                flow.hide();
                return GateResult::StartApp;
            }
            Ok(Ok(Ok(again))) if again.as_deref() != Some(&version) => {
                h.cancellable.store(false, Ordering::SeqCst);
                flow.hide();
                return GateResult::StartApp;
            }
            // The second look failed too, or found the same version: treat the original error as it is.
            _ => {}
        }
    }
    h.cancellable.store(false, Ordering::SeqCst);
    match &stop {
        Stop::Error(error) => deps.log(&format!("update {version} failed: {error}")),
        _ => deps.log(&format!("update {version}: the hand-over did not start in time")),
    }
    if !matches!(stop, Stop::Abandoned) {
        deps.record_failure(&version);
    }
    flow.show(GateView::Failed { version });
    tokio::time::sleep(t.error_hold).await;
    flow.hide();
    GateResult::StartApp
}

#[cfg(test)]
#[path = "gate_tests.rs"]
mod tests;
