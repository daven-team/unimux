//! The one owner of "which version is being updated to" (port of src/main/updateCoordinator.ts). The feed lookup and the
//! download are injected ([`Backend`]), so every race (a newer release appearing while an older one is offered, downloading,
//! ready or being installed) is tested without an app.
//!
//! Rules:
//! - The target is whatever the newest feed answer says. A different answer supersedes the target: the running download is
//!   cancelled, a downloaded copy of the old version is forgotten and every listener is told.
//! - Once the hand-over to the installer started ([`UpdateCoordinator::lock_handover`]) nothing changes the state any more: a
//!   newer version is only remembered ([`UpdateCoordinator::newer_version`]) and offered by the normal flow after the relaunch.
//! - One download per target; later callers join it. A download of a superseded version ends with
//!   [`UpdateError::Superseded`].
//!
//! Concurrency: the state sits behind one mutex that is never held while a callback (emit, listeners) runs or while anything
//! is awaited; the side effects of a step are collected and run after the lock is released, in the order the TS code ran them.

use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use tokio_util::sync::CancellationToken;

use crate::settled::{self, Settle, Settled};
use crate::state::{Status, UpdateState};
use crate::version::is_newer;

pub type BoxFut<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// A download's progress (`ProgressInfo` of electron-updater).
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Progress {
    pub percent: f64,
    pub transferred: Option<f64>,
    pub total: Option<f64>,
    pub bytes_per_second: Option<f64>,
}

impl Progress {
    pub fn percent(percent: f64) -> Self {
        Self { percent, ..Default::default() }
    }
}

pub type ProgressFn = Arc<dyn Fn(Progress) + Send + Sync>;
pub type Listener = Arc<dyn Fn() + Send + Sync>;
pub type PercentListener = Arc<dyn Fn(f64) + Send + Sync>;
pub type Unsubscribe = Box<dyn FnOnce() + Send>;

/// Why an update step did not complete.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UpdateError {
    /// The download (or offer) this caller waited for was replaced by a newer version (`SupersededError`).
    Superseded,
    /// Anything else, with the message the status shows.
    Failed(String),
}

impl fmt::Display for UpdateError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            UpdateError::Superseded => f.write_str("update superseded by a newer version"),
            UpdateError::Failed(m) => f.write_str(m),
        }
    }
}

impl std::error::Error for UpdateError {}

/// An update the feed announces. `manual`: this app cannot install it by itself (portable build, an app that cannot replace
/// itself); only the download page is offered, with the reason.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FoundUpdate {
    pub version: String,
    pub manual: Option<Manual>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Manual {
    pub message: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct LookupResult {
    pub latest: Option<String>,
    pub update: Option<FoundUpdate>,
}

pub trait Backend: Send + Sync + 'static {
    /// Asks the feed (never downloads). Fails when the feed cannot be read.
    fn lookup(&self) -> BoxFut<Result<LookupResult, String>>;
    /// Downloads and verifies `version` (the one the last lookup announced). Must end promptly once `cancel` fires.
    fn download(&self, version: &str, on_progress: ProgressFn, cancel: CancellationToken) -> BoxFut<Result<(), String>>;
    /// The backend limits silent transfers itself and has phases without progress: the stalled-download watchdog is kept
    /// quiet by a beat every 20 s.
    fn self_watched(&self) -> bool {
        false
    }
}

/// startup: before the main window exists; background: the periodic check; manual: the user asked; recheck: the last look
/// before handing over (a failure of it never changes the state).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckReason {
    Startup,
    Background,
    Manual,
    Recheck,
}

pub const STALL: Duration = Duration::from_secs(2 * 60);
pub const LOOKUP_TIMEOUT: Duration = Duration::from_secs(90);
const SELF_WATCHED_BEAT: Duration = Duration::from_secs(20);
pub const NO_RESPONSE: &str = "Brak odpowiedzi serwera aktualizacji. Spróbuj ponownie.";
pub const CHECK_FAILED: &str = "Nie udało się sprawdzić aktualizacji.";
pub const INSTALL_FAILED: &str = "Nie udało się zainstalować aktualizacji.";

pub struct CoordinatorOptions {
    pub backend: Arc<dyn Backend>,
    pub emit: Arc<dyn Fn(&UpdateState) + Send + Sync>,
    /// Builds that never install on their own (portable): updates are only announced with the download link.
    pub portable: Arc<dyn Fn() -> bool + Send + Sync>,
    pub releases_url: String,
    /// Date.now() in ms (checkedAt, lastCheckAt).
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    pub stall: Duration,
    pub lookup_timeout: Duration,
    /// console.error of the TS code (crash.log in the app).
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
    /// Where the lookups, downloads and timers run.
    pub runtime: tokio::runtime::Handle,
}

impl CoordinatorOptions {
    /// Options with the defaults of updateCoordinator.ts, on the current tokio runtime.
    pub fn new(backend: Arc<dyn Backend>, emit: Arc<dyn Fn(&UpdateState) + Send + Sync>, releases_url: &str) -> Self {
        Self {
            backend,
            emit,
            portable: Arc::new(|| false),
            releases_url: releases_url.to_string(),
            now: Arc::new(|| unimux_core::time::now_ms() as f64),
            stall: STALL,
            lookup_timeout: LOOKUP_TIMEOUT,
            log: Arc::new(|_| {}),
            runtime: tokio::runtime::Handle::current(),
        }
    }
}

type DownloadResult = Result<(), UpdateError>;

struct DownloadEntry {
    id: u64,
    version: String,
    cancel: CancellationToken,
    done: Settled<DownloadResult>,
}

enum Effect {
    Emit(UpdateState),
    Watchdog(u64),
    Listeners(Vec<Listener>),
    Percent(Vec<PercentListener>, f64),
    Log(String),
    SpawnDownload {
        id: u64,
        version: String,
        cancel: CancellationToken,
        settle: Settle<DownloadResult>,
        previous: Option<Settled<DownloadResult>>,
    },
    SpawnCheck {
        id: u64,
        visible: bool,
        reason: CheckReason,
        settle: Settle<Result<(), String>>,
    },
}

#[derive(Default)]
struct Inner {
    state: UpdateState,
    target: Option<String>,
    manual: Option<Manual>,
    downloaded: Option<String>,
    download: Option<DownloadEntry>,
    /// The previous download winding down; the next one starts only after it, so the backend never runs two.
    settling: Option<Settled<DownloadResult>>,
    locked: Option<String>,
    newer: Option<String>,
    blocked: Option<String>,
    last_check: f64,
    percent: f64,
    checking: Option<(u64, Settled<Result<(), String>>)>,
    watchdog: u64,
    next_id: u64,
    target_listeners: Vec<(u64, Listener)>,
    progress_listeners: Vec<(u64, PercentListener)>,
    effects: Vec<Effect>,
}

pub struct UpdateCoordinator {
    inner: Mutex<Inner>,
    o: CoordinatorOptions,
    me: Weak<UpdateCoordinator>,
}

fn clamp_percent(value: f64) -> f64 {
    if value.is_finite() { value.clamp(0.0, 100.0) } else { 0.0 }
}

/// `Math.max(0, value || 0)`.
fn non_negative(value: Option<f64>) -> f64 {
    value.filter(|v| v.is_finite()).unwrap_or(0.0).max(0.0)
}

impl UpdateCoordinator {
    pub fn new(o: CoordinatorOptions) -> Arc<Self> {
        Arc::new_cyclic(|me| Self { inner: Mutex::new(Inner::default()), o, me: me.clone() })
    }

    /// Runs `f` under the lock, then the side effects it collected (outside the lock).
    fn with<R>(&self, f: impl FnOnce(&mut Inner, &CoordinatorOptions) -> R) -> R {
        let (result, effects) = {
            let mut inner = self.inner.lock();
            let result = f(&mut inner, &self.o);
            (result, std::mem::take(&mut inner.effects))
        };
        self.run(effects);
        result
    }

    fn run(&self, effects: Vec<Effect>) {
        for effect in effects {
            match effect {
                Effect::Emit(state) => (self.o.emit)(&state),
                Effect::Log(line) => (self.o.log)(&line),
                Effect::Listeners(listeners) => {
                    for listener in listeners {
                        // A listener must not break the update.
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener()));
                    }
                }
                Effect::Percent(listeners, percent) => {
                    for listener in listeners {
                        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| listener(percent)));
                    }
                }
                Effect::Watchdog(generation) => {
                    let me = self.me.clone();
                    let stall = self.o.stall;
                    self.o.runtime.spawn(async move {
                        tokio::time::sleep(stall).await;
                        if let Some(me) = me.upgrade() {
                            me.with(|i, o| {
                                if i.watchdog == generation {
                                    fail(i, o, NO_RESPONSE);
                                }
                            });
                        }
                    });
                }
                Effect::SpawnCheck { id, visible, reason, settle } => {
                    let me = self.me.clone();
                    let lookup = self.o.backend.lookup();
                    let timeout = self.o.lookup_timeout;
                    self.o.runtime.spawn(async move {
                        let result = match tokio::time::timeout(timeout, lookup).await {
                            Ok(result) => result,
                            Err(_) => Err(NO_RESPONSE.to_string()),
                        };
                        let Some(me) = me.upgrade() else { return };
                        let outcome = me.with(|i, o| {
                            let outcome = match result {
                                Err(error) => {
                                    // A failing look while an update is already offered or downloading must not turn that into
                                    // an error.
                                    if visible && reason != CheckReason::Recheck {
                                        fail(i, o, &error);
                                    }
                                    Err(error)
                                }
                                Ok(found) => {
                                    apply(i, o, found);
                                    Ok(())
                                }
                            };
                            if i.checking.as_ref().is_some_and(|(c, _)| *c == id) {
                                i.checking = None;
                            }
                            outcome
                        });
                        settle.settle(outcome);
                    });
                }
                Effect::SpawnDownload { id, version, cancel, settle, previous } => {
                    let me = self.me.clone();
                    self.o.runtime.spawn(async move {
                        if let Some(previous) = previous {
                            let _ = previous.wait().await;
                        }
                        let Some(me) = me.upgrade() else { return };
                        let result = me.run_download(id, &version, cancel).await;
                        settle.settle(result);
                    });
                }
            }
        }
    }

    async fn run_download(self: Arc<Self>, id: u64, version: &str, cancel: CancellationToken) -> DownloadResult {
        let go = self.with(|i, o| {
            if cancel.is_cancelled() || i.target.as_deref() != Some(version) {
                clear_entry(i, id);
                return false;
            }
            i.percent = 0.0;
            let mut s = UpdateState::with_version(Status::Downloading, version);
            s.percent = Some(0.0);
            set(i, o, s);
            true
        });
        if !go {
            return Err(UpdateError::Superseded);
        }
        let beat = self.o.backend.self_watched().then(|| {
            let me = self.me.clone();
            let v = version.to_string();
            self.o.runtime.spawn(async move {
                let mut tick = tokio::time::interval(SELF_WATCHED_BEAT);
                tick.tick().await;
                loop {
                    tick.tick().await;
                    let Some(me) = me.upgrade() else { return };
                    me.with(|i, o| {
                        if i.state.status == Status::Downloading && i.state.version_is(&v) {
                            let again = i.state.clone();
                            set(i, o, again);
                        }
                    });
                }
            })
        });
        let reporter = {
            let me = self.me.clone();
            let v = version.to_string();
            Arc::new(move |progress: Progress| {
                if let Some(me) = me.upgrade() {
                    me.report(&v, progress);
                }
            }) as ProgressFn
        };
        let outcome = self.o.backend.download(version, reporter, cancel.clone()).await;
        if let Some(beat) = beat {
            beat.abort();
        }
        self.with(|i, o| {
            let result = if cancel.is_cancelled() || i.target.as_deref() != Some(version) {
                Err(UpdateError::Superseded)
            } else {
                match outcome {
                    Err(error) => {
                        fail(i, o, &error);
                        Err(UpdateError::Failed(error))
                    }
                    Ok(()) => {
                        i.downloaded = Some(version.to_string());
                        set(i, o, UpdateState::with_version(Status::Ready, version));
                        Ok(())
                    }
                }
            };
            clear_entry(i, id);
            result
        })
    }

    fn report(&self, version: &str, progress: Progress) {
        self.with(|i, o| {
            if i.target.as_deref() != Some(version) || i.locked.is_some() || i.downloaded.as_deref() == Some(version) {
                return;
            }
            let percent = clamp_percent(progress.percent);
            i.percent = percent;
            let listeners = i.progress_listeners.iter().map(|(_, l)| l.clone()).collect();
            i.effects.push(Effect::Percent(listeners, percent));
            let mut s = UpdateState::with_version(Status::Downloading, version);
            s.percent = Some(percent);
            s.transferred = Some(non_negative(progress.transferred));
            s.total = Some(non_negative(progress.total));
            s.bytes_per_second = Some(non_negative(progress.bytes_per_second));
            set(i, o, s);
        });
    }

    // ── state ───────────────────────────────────────────────────────────────

    pub fn get_state(&self) -> UpdateState {
        self.inner.lock().state.clone()
    }

    /// The version the update is heading for (what every window, the status bar and the installer refer to).
    pub fn current_target(&self) -> Option<String> {
        self.inner.lock().target.clone()
    }

    /// The version being handed to the installer, once that started.
    pub fn handover_version(&self) -> Option<String> {
        self.inner.lock().locked.clone()
    }

    /// A newer version seen after the hand-over started; offered after the relaunch.
    pub fn newer_version(&self) -> Option<String> {
        self.inner.lock().newer.clone()
    }

    /// Whether `version` (default: the target) is downloaded and verified.
    pub fn is_downloaded(&self, version: Option<&str>) -> bool {
        let i = self.inner.lock();
        let version = version.map(str::to_string).or_else(|| i.target.clone());
        version.is_some() && i.downloaded == version
    }

    pub fn last_check_at(&self) -> f64 {
        self.inner.lock().last_check
    }

    /// Whether the target can be downloaded and installed by this app.
    pub fn installable(&self) -> bool {
        let i = self.inner.lock();
        i.target.is_some() && i.manual.is_none() && !(self.o.portable)()
    }

    pub fn publish(&self) {
        let state = self.get_state();
        (self.o.emit)(&state);
    }

    /// Reports a failure. A failed hand-over releases the lock, so the user can try again.
    pub fn fail(&self, message: &str) {
        self.with(|i, o| fail(i, o, message));
    }

    /// Stops the stalled-download watchdog (shutdown).
    pub fn dispose(&self) {
        self.inner.lock().watchdog += 1;
    }

    /// Shows a status that does not come from a lookup (unavailable in development, a failed previous update).
    pub fn set_status(&self, next: UpdateState) {
        self.with(|i, o| set(i, o, next));
    }

    pub fn on_target_change(&self, listener: Listener) -> Unsubscribe {
        let id = {
            let mut i = self.inner.lock();
            i.next_id += 1;
            let id = i.next_id;
            i.target_listeners.push((id, listener));
            id
        };
        let me = self.me.clone();
        Box::new(move || {
            if let Some(me) = me.upgrade() {
                me.inner.lock().target_listeners.retain(|(l, _)| *l != id);
            }
        })
    }

    pub fn on_progress(&self, listener: PercentListener) -> Unsubscribe {
        let id = {
            let mut i = self.inner.lock();
            i.next_id += 1;
            let id = i.next_id;
            i.progress_listeners.push((id, listener));
            id
        };
        let me = self.me.clone();
        Box::new(move || {
            if let Some(me) = me.upgrade() {
                me.inner.lock().progress_listeners.retain(|(l, _)| *l != id);
            }
        })
    }

    // ── lookups ─────────────────────────────────────────────────────────────

    /// Asks the feed and applies the answer. The installable update that is now the target (None: up to date, only a
    /// download link is offered, or the hand-over is running). Fails only for `Startup` and `Recheck`; the other reasons report
    /// the failure as status.
    pub fn check(&self, reason: CheckReason) -> BoxFut<Result<Option<String>, UpdateError>> {
        // While the hand-over runs the feed is still looked at, but only to remember a newer version (see `apply`).
        let waiting = self.with(|i, o| {
            if let Some((_, running)) = &i.checking {
                return running.clone();
            }
            let visible = matches!(i.state.status, Status::Idle | Status::Current | Status::Error | Status::Unavailable);
            i.last_check = (o.now)();
            i.next_id += 1;
            let id = i.next_id;
            let (settle, waiting) = settled::pending();
            i.checking = Some((id, waiting.clone()));
            if visible {
                set(i, o, UpdateState::new(Status::Checking));
            }
            i.effects.push(Effect::SpawnCheck { id, visible, reason, settle });
            waiting
        });
        let me = self.me.clone();
        Box::pin(async move {
            let outcome = waiting.wait().await.unwrap_or_else(|| Err(CHECK_FAILED.to_string()));
            if let Err(error) = outcome {
                return if matches!(reason, CheckReason::Startup | CheckReason::Recheck) {
                    Err(UpdateError::Failed(error))
                } else {
                    Ok(None)
                };
            }
            let Some(me) = me.upgrade() else { return Ok(None) };
            let i = me.inner.lock();
            // An update this app cannot install (portable, macOS without write access) is not "found" for the callers that
            // install.
            Ok(if i.locked.is_some() || i.manual.is_some() { None } else { i.target.clone() })
        })
    }

    // ── downloading ─────────────────────────────────────────────────────────

    /// Downloads the target, or joins the download that is running for it; completes when it is downloaded and verified.
    /// Ends with [`UpdateError::Superseded`] when a newer target replaced it meanwhile.
    pub fn download(&self) -> BoxFut<DownloadResult> {
        let waiting = self.with(download_locked);
        Box::pin(async move { waiting.wait().await.unwrap_or(Err(UpdateError::Superseded)) })
    }

    // ── hand-over ───────────────────────────────────────────────────────────

    /// Takes the hand-over lock for the downloaded target (`expected`, when given, must still be it). From here on the state
    /// is frozen until the app quits or the hand-over fails. False: nothing may be installed now.
    pub fn lock_handover(&self, expected: Option<&str>) -> bool {
        self.with(|i, o| {
            let Some(version) = i.target.clone() else { return false };
            if i.locked.is_some() || expected.is_some_and(|e| e != version) {
                return false;
            }
            if i.manual.is_some()
                || (o.portable)()
                || i.blocked.as_deref() == Some(&version)
                || i.downloaded.as_deref() != Some(&version)
            {
                return false;
            }
            i.locked = Some(version.clone());
            set(i, o, UpdateState::with_version(Status::Installing, version));
            true
        })
    }

    /// The hand-over could not start: release the lock and show the failure.
    pub fn fail_handover(&self, message: &str) {
        self.fail(message);
    }

    /// The app turned out not to be replaceable (macOS): only the download page is offered for this version.
    pub fn refuse_install(&self, version: &str, message: Option<String>) {
        self.with(|i, o| {
            i.locked = None;
            i.downloaded = None;
            i.target = Some(version.to_string());
            i.manual = Some(Manual { message });
            settle(i, o);
        });
    }

    // ── blocking ────────────────────────────────────────────────────────────

    /// A version that failed to install is never offered again (until unblocked); a copy of it is withdrawn.
    pub fn block(&self, version: Option<&str>) {
        self.with(|i, o| {
            i.blocked = version.map(str::to_string);
            // An offer that only links to the download page (the install was refused) stays; it can never be installed anyway.
            if let Some(v) = version
                && i.target.as_deref() == Some(v)
                && i.locked.is_none()
                && i.manual.is_none()
            {
                clear_target(i);
                let mut s = UpdateState::new(Status::Current);
                s.checked_at = Some((o.now)());
                set(i, o, s);
            }
        });
    }

    pub fn blocked_version(&self) -> Option<String> {
        self.inner.lock().blocked.clone()
    }
}

fn set(i: &mut Inner, o: &CoordinatorOptions, mut next: UpdateState) {
    i.watchdog += 1;
    if next.portable.is_none() {
        next.portable = Some((o.portable)());
    }
    let watch = matches!(next.status, Status::Checking | Status::Downloading);
    i.state = next.clone();
    i.effects.push(Effect::Emit(next));
    if watch {
        i.effects.push(Effect::Watchdog(i.watchdog));
    }
}

fn fail(i: &mut Inner, o: &CoordinatorOptions, message: &str) {
    i.locked = None;
    i.effects.push(Effect::Log(format!("auto-update failed: {message}")));
    let mut s = UpdateState::new(Status::Error);
    s.version = i.target.clone().or_else(|| i.state.version.clone());
    s.message = Some(if message.is_empty() { CHECK_FAILED.to_string() } else { message.to_string() });
    set(i, o, s);
}

fn clear_entry(i: &mut Inner, id: u64) {
    if i.download.as_ref().is_some_and(|d| d.id == id) {
        i.download = None;
    }
}

fn notify_target(i: &mut Inner) {
    let listeners = i.target_listeners.iter().map(|(_, l)| l.clone()).collect();
    i.effects.push(Effect::Listeners(listeners));
}

/// Applies a feed answer; see the module comment for the rules.
fn apply(i: &mut Inner, o: &CoordinatorOptions, result: LookupResult) {
    let now = (o.now)();
    let found = result.update;
    if let Some(locked) = &i.locked {
        if let Some(found) = &found
            && is_newer(&found.version, locked)
        {
            i.newer = Some(found.version.clone());
        }
        return;
    }
    if let Some(f) = &found
        && i.blocked.as_deref() == Some(&f.version)
        && i.target.as_deref() == Some(&f.version)
        && i.manual.is_some()
    {
        // The install of this version was refused (macOS): the download page stays offered, it is only never installed.
        settle(i, o);
        return;
    }
    let found_version = found.as_ref().map(|f| f.version.clone());
    let Some(found) = found.filter(|f| i.blocked.as_deref() != Some(&f.version)) else {
        clear_target(i);
        let mut s = UpdateState::new(Status::Current);
        // `found?.version ?? result.latest`: a blocked answer still names its version.
        s.version = found_version.or(result.latest);
        s.checked_at = Some(now);
        set(i, o, s);
        return;
    };
    let manual = found.manual.clone().or_else(|| (o.portable)().then(Manual::default));
    match &i.target {
        None => retarget(i, &found.version, manual),
        Some(target) if is_newer(&found.version, target) => retarget(i, &found.version, manual),
        // An older answer (a stale copy of the feed on a CDN or proxy) never replaces the target and never starts a second
        // download.
        Some(target) if *target == found.version => i.manual = manual,
        Some(_) => {}
    }
    settle(i, o);
}

fn retarget(i: &mut Inner, version: &str, manual: Option<Manual>) {
    if let Some(d) = &i.download
        && d.version != version
    {
        d.cancel.cancel();
        i.download = None;
    }
    if i.downloaded.as_deref() != Some(version) {
        i.downloaded = None;
    }
    i.target = Some(version.to_string());
    i.manual = manual;
    i.percent = 0.0;
    notify_target(i);
}

fn clear_target(i: &mut Inner) {
    let had = i.target.is_some();
    if let Some(d) = i.download.take() {
        d.cancel.cancel();
    }
    i.target = None;
    i.manual = None;
    i.downloaded = None;
    if had {
        notify_target(i);
    }
}

/// Publishes what is known about the target and starts the background download when one is wanted.
fn settle(i: &mut Inner, o: &CoordinatorOptions) {
    let Some(version) = i.target.clone() else { return };
    if let Some(manual) = &i.manual {
        let mut s = UpdateState::with_version(Status::Available, &version);
        s.url = Some(o.releases_url.clone());
        s.message = manual.message.clone();
        s.portable = Some(true);
        set(i, o, s);
        return;
    }
    if i.downloaded.as_deref() == Some(&version) {
        if i.state.status != Status::Ready || !i.state.version_is(&version) {
            set(i, o, UpdateState::with_version(Status::Ready, &version));
        }
        return;
    }
    if i.download.as_ref().is_some_and(|d| d.version == version) {
        if i.state.status != Status::Downloading || !i.state.version_is(&version) {
            let mut s = UpdateState::with_version(Status::Downloading, &version);
            s.percent = Some(i.percent);
            set(i, o, s);
        }
        return;
    }
    set(i, o, UpdateState::with_version(Status::Available, &version));
    if i.blocked.as_deref() != Some(&version) {
        // Reported through the status.
        let _ = download_locked(i, o);
    }
}

fn download_locked(i: &mut Inner, _o: &CoordinatorOptions) -> Settled<DownloadResult> {
    let Some(version) = i.target.clone().filter(|_| i.manual.is_none()) else {
        return settled::ready(Err(UpdateError::Failed(INSTALL_FAILED.to_string())));
    };
    if i.downloaded.as_deref() == Some(&version) {
        return settled::ready(Ok(()));
    }
    if let Some(d) = &i.download
        && d.version == version
    {
        return d.done.clone();
    }
    i.next_id += 1;
    let id = i.next_id;
    let cancel = CancellationToken::new();
    let (settle, done) = settled::pending();
    let previous = i.settling.replace(done.clone());
    i.download = Some(DownloadEntry { id, version: version.clone(), cancel: cancel.clone(), done: done.clone() });
    i.effects.push(Effect::SpawnDownload { id, version, cancel, settle, previous });
    done
}

#[cfg(test)]
#[path = "coordinator_tests.rs"]
pub(crate) mod tests;
