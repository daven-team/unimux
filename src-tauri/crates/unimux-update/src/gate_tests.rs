//! test/startup-gate.test.ts, and test/update-coordinator.test.ts "the update window follows the newest target" / "single
//! update UI", on tokio's paused clock.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::oneshot;

use super::*;
use crate::coordinator::tests::{Harness, settle};
use crate::coordinator::{CheckReason, UpdateCoordinator};
use crate::state::Status;

type CheckFn = Box<dyn FnMut() -> BoxFut<Result<Option<String>, UpdateError>> + Send>;
type DownloadFn = Box<dyn FnMut(Arc<dyn Fn(f64) + Send + Sync>) -> BoxFut<Result<(), UpdateError>> + Send>;
type HandoffFn = Box<dyn FnMut(String, HideFn, CancellationToken) -> BoxFut<Result<bool, UpdateError>> + Send>;

struct Fake {
    views: Mutex<Vec<GateView>>,
    hides: AtomicUsize,
    abandons: AtomicUsize,
    checks: AtomicUsize,
    downloads: AtomicUsize,
    handoffs: Mutex<Vec<String>>,
    records: Mutex<Vec<String>>,
    order: Mutex<Vec<&'static str>>,
    committed: AtomicBool,
    check: Mutex<CheckFn>,
    download: Mutex<DownloadFn>,
    handoff: Mutex<HandoffFn>,
}

fn ok_none() -> CheckFn {
    Box::new(|| Box::pin(async { Ok(None) }))
}

fn found(version: &'static str) -> CheckFn {
    Box::new(move || Box::pin(async move { Ok(Some(version.to_string())) }))
}

fn delayed(value: Option<&'static str>, ms: u64) -> CheckFn {
    Box::new(move || {
        Box::pin(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            Ok(value.map(str::to_string))
        })
    })
}

fn never_check() -> CheckFn {
    Box::new(|| Box::pin(std::future::pending()))
}

fn failing_check() -> CheckFn {
    Box::new(|| Box::pin(async { Err(UpdateError::Failed("offline".into())) }))
}

fn never_download() -> DownloadFn {
    Box::new(|_| Box::pin(std::future::pending()))
}

fn failing_download() -> DownloadFn {
    Box::new(|_| Box::pin(async { Err(UpdateError::Failed("disk full".into())) }))
}

impl Fake {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            views: Mutex::default(),
            hides: AtomicUsize::new(0),
            abandons: AtomicUsize::new(0),
            checks: AtomicUsize::new(0),
            downloads: AtomicUsize::new(0),
            handoffs: Mutex::default(),
            records: Mutex::default(),
            order: Mutex::default(),
            committed: AtomicBool::new(false),
            check: Mutex::new(ok_none()),
            download: Mutex::new(Box::new(|progress| {
                Box::pin(async move {
                    progress(50.0);
                    Ok(())
                })
            })),
            handoff: Mutex::new(Box::new(|_, hide, _| {
                Box::pin(async move {
                    hide();
                    Ok(true)
                })
            })),
        })
    }

    fn with_check(self: Arc<Self>, check: CheckFn) -> Arc<Self> {
        *self.check.lock() = check;
        self
    }

    fn with_download(self: Arc<Self>, download: DownloadFn) -> Arc<Self> {
        *self.download.lock() = download;
        self
    }

    fn with_handoff(self: Arc<Self>, handoff: HandoffFn) -> Arc<Self> {
        *self.handoff.lock() = handoff;
        self
    }

    fn views(&self) -> Vec<GateView> {
        self.views.lock().clone()
    }

    fn hides(&self) -> usize {
        self.hides.load(Ordering::SeqCst)
    }

    fn records(&self) -> Vec<String> {
        self.records.lock().clone()
    }
}

impl GateDeps for Fake {
    fn check(&self) -> BoxFut<Result<Option<String>, UpdateError>> {
        self.checks.fetch_add(1, Ordering::SeqCst);
        (self.check.lock())()
    }
    fn abandon_check(&self) {
        self.abandons.fetch_add(1, Ordering::SeqCst);
    }
    fn download(&self, on_progress: Arc<dyn Fn(f64) + Send + Sync>) -> BoxFut<Result<(), UpdateError>> {
        self.downloads.fetch_add(1, Ordering::SeqCst);
        (self.download.lock())(on_progress)
    }
    fn show(&self, view: GateView) {
        self.views.lock().push(view);
    }
    fn hide(&self) {
        self.hides.fetch_add(1, Ordering::SeqCst);
    }
    fn handoff(&self, version: String, hide: HideFn, deadline: CancellationToken) -> BoxFut<Result<bool, UpdateError>> {
        self.order.lock().push("handoff");
        self.handoffs.lock().push(version.clone());
        (self.handoff.lock())(version, hide, deadline)
    }
    fn handoff_committed(&self) -> bool {
        self.committed.load(Ordering::SeqCst)
    }
    fn mark_attempt(&self, _version: &str) {
        self.order.lock().push("mark");
    }
    fn record_failure(&self, version: &str) {
        self.records.lock().push(version.to_string());
    }
}

fn ask(version: &str) -> GateView {
    GateView::Ask { version: version.into() }
}
fn downloading(version: &str, percent: f64) -> GateView {
    GateView::Downloading { version: version.into(), percent }
}
fn installing(version: &str) -> GateView {
    GateView::Installing { version: version.into() }
}

/// `make()` of the TS tests: by default the user answers "Install now" at once.
fn start(fake: &Arc<Fake>, options: GateOptions) -> (Arc<GateHandle>, tokio::task::JoinHandle<GateResult>) {
    let handle = GateHandle::new();
    handle.install();
    let task = tokio::spawn(run_startup_gate(fake.clone(), handle.clone(), options));
    (handle, task)
}

/// The ask-mode tests answer by hand.
fn start_asking(fake: &Arc<Fake>, options: GateOptions) -> (Arc<GateHandle>, tokio::task::JoinHandle<GateResult>) {
    let handle = GateHandle::new();
    let task = tokio::spawn(run_startup_gate(fake.clone(), handle.clone(), options));
    (handle, task)
}

async fn advance(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
    settle().await;
}

fn skip(version: &str) -> GateOptions {
    GateOptions { skip_version: Some(version.into()), ..Default::default() }
}

// ── shouldGateOnStartup, records ────────────────────────────────────────────────────────────────

const ENV: GateEnv =
    GateEnv { supported_platform: true, packaged: true, portable: false, mode: UpdateMode::Ask, recent_failure: false };

#[test]
fn gates_only_the_installed_windows_and_macos_builds_in_the_automatic_ask_mode() {
    assert!(should_gate_on_startup(&ENV));
    assert!(!should_gate_on_startup(&GateEnv { mode: UpdateMode::Manual, ..ENV }));
    assert!(!should_gate_on_startup(&GateEnv { supported_platform: false, ..ENV }));
    assert!(!should_gate_on_startup(&GateEnv { packaged: false, ..ENV }));
    assert!(!should_gate_on_startup(&GateEnv { portable: true, ..ENV }));
    assert!(!should_gate_on_startup(&GateEnv { recent_failure: true, ..ENV }));
    assert_eq!(UpdateMode::parse(Some("ask")), UpdateMode::Ask);
    assert_eq!(UpdateMode::parse(Some("manual")), UpdateMode::Manual);
    assert_eq!(UpdateMode::parse(None), UpdateMode::Manual);
}

#[test]
fn a_record_of_the_version_that_is_now_running_is_no_failure() {
    let record = FailureRecord { version: "0.5.98".into(), at: 1000.0 };
    assert!(is_active_failure(Some(&record), "0.5.97", 2000.0));
    assert!(!is_active_failure(Some(&record), "0.5.98", 2000.0));
    assert!(!is_active_failure(Some(&record), "0.5.99", 2000.0));
    assert!(!is_active_failure(Some(&record), "0.5.97", 1000.0 + FAILURE_COOLDOWN_MS));
    assert!(!is_active_failure(None, "0.5.97", 2000.0));
}

#[test]
fn keeps_a_failure_for_the_cooldown_only_and_ignores_malformed_records() {
    let r = |at: f64| FailureRecord { version: "1.0.0".into(), at };
    assert!(is_recent_failure(Some(&r(1000.0)), 1000.0 + FAILURE_COOLDOWN_MS - 1.0));
    assert!(!is_recent_failure(Some(&r(1000.0)), 1000.0 + FAILURE_COOLDOWN_MS));
    assert!(!is_recent_failure(Some(&r(5000.0)), 1000.0));
    assert!(!is_recent_failure(None, 1000.0));
    use serde_json::json;
    assert_eq!(parse_failure(&json!({"version": "1.0.0", "at": 5})), Some(FailureRecord { version: "1.0.0".into(), at: 5.0 }));
    assert_eq!(parse_failure(&json!({"version": 1, "at": 5})), None);
    assert_eq!(parse_failure(&json!(null)), None);
    assert_eq!(parse_failure(&json!({"version": "1", "at": "x"})), None);
}

#[test]
fn skips_a_failed_version_only_while_the_failure_is_recent() {
    let failure = FailureRecord { version: "0.6.6".into(), at: 1000.0 };
    assert_eq!(gate_skip_version(Some(&failure), "0.6.5", 2000.0).as_deref(), Some("0.6.6"));
    assert_eq!(gate_skip_version(Some(&failure), "0.6.5", 1000.0 + FAILURE_COOLDOWN_MS), None);
    assert_eq!(gate_skip_version(Some(&failure), "0.6.6", 2000.0), None);
    assert_eq!(gate_skip_version(None, "0.6.5", 2000.0), None);
}

#[test]
fn update_gate_json_is_written_read_and_cleared_once_the_target_runs() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(read_gate_failure(dir.path()), None);
    write_gate_record(dir.path(), "1.2.1", 1_700_000_000_000);
    assert_eq!(std::fs::read_to_string(dir.path().join(GATE_FILE)).unwrap(), r#"{"version":"1.2.1","at":1700000000000}"#);
    assert_eq!(read_gate_failure(dir.path()), Some(FailureRecord { version: "1.2.1".into(), at: 1_700_000_000_000.0 }));
    assert!(!clear_gate_failure_if_updated(dir.path(), "1.2.0"));
    assert!(dir.path().join(GATE_FILE).exists());
    assert!(clear_gate_failure_if_updated(dir.path(), "1.2.1"));
    assert!(!dir.path().join(GATE_FILE).exists());
    std::fs::write(dir.path().join(GATE_FILE), "{broken").unwrap();
    assert_eq!(read_gate_failure(dir.path()), None);
}

#[test]
fn the_handoff_watchdog_waits_only_while_the_update_window_supervises() {
    assert!(handoff_watchdog_waits(true, Duration::from_secs(15)));
    assert!(!handoff_watchdog_waits(true, HANDOFF_QUIT_WAIT_MAX));
    assert!(!handoff_watchdog_waits(false, Duration::from_secs(15)));
}

#[test]
fn lets_only_one_of_the_startup_prompt_and_the_status_bar_window_exist_at_a_time() {
    let guard = UpdateUiGuard::default();
    assert!(guard.acquire(UpdateUiOwner::StartupGate));
    assert!(!guard.acquire(UpdateUiOwner::InstallWindow));
    assert!(!guard.acquire(UpdateUiOwner::StartupGate));
    guard.release(UpdateUiOwner::InstallWindow);
    assert_eq!(guard.owner(), Some(UpdateUiOwner::StartupGate));
    guard.release(UpdateUiOwner::StartupGate);
    assert!(guard.acquire(UpdateUiOwner::InstallWindow));
    assert!(!guard.acquire(UpdateUiOwner::StartupGate));
    assert!(!guard.acquire(UpdateUiOwner::InstallWindow));
    guard.release(UpdateUiOwner::InstallWindow);
    assert_eq!(guard.owner(), None);
}

// ── runStartupGate ──────────────────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn starts_the_app_without_ever_showing_the_window_when_there_is_no_update_quickly() {
    let fake = Fake::new().with_check(delayed(None, 100));
    let (_h, task) = start(&fake, GateOptions::default());
    advance(100).await;
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    advance(1000).await;
    assert!(fake.views().is_empty());
    assert_eq!(fake.downloads.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn shows_the_checking_window_after_the_short_delay_and_closes_it_when_current() {
    let fake = Fake::new().with_check(delayed(None, 1500));
    let (_h, task) = start(&fake, GateOptions::default());
    advance(1500).await;
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(fake.views(), vec![GateView::Checking]);
    assert_eq!(fake.hides(), 1);
}

#[tokio::test(start_paused = true)]
async fn closes_a_checking_window_the_moment_the_answer_arrives_without_holding_it_on_screen() {
    let fake = Fake::new().with_check(delayed(None, 900));
    let (_h, task) = start(&fake, GateOptions::default());
    advance(900).await;
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(fake.views(), vec![GateView::Checking]);
    assert_eq!(fake.hides(), 1);
}

#[tokio::test(start_paused = true)]
async fn returns_at_once_when_the_user_closes_the_checking_window() {
    let fake = Fake::new().with_check(never_check());
    let (h, task) = start(&fake, GateOptions::default());
    advance(850).await;
    h.cancel();
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(fake.hides(), 1);
}

#[tokio::test(start_paused = true)]
async fn fails_open_after_the_hard_timeout_when_the_server_never_answers() {
    let fake = Fake::new().with_check(never_check());
    let (_h, task) = start(&fake, GateOptions::default());
    advance(7999).await;
    assert!(!task.is_finished());
    advance(1).await;
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(fake.abandons.load(Ordering::SeqCst), 1);
    assert_eq!(fake.views(), vec![GateView::Checking]);
    assert_eq!(fake.hides(), 1);
    assert!(fake.records().is_empty());
}

#[tokio::test(start_paused = true)]
async fn fails_open_when_the_check_rejects() {
    let fake = Fake::new().with_check(failing_check());
    let (_h, task) = start(&fake, GateOptions::default());
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(fake.downloads.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn offers_the_update_downloads_and_hands_over_to_the_installer_without_starting_the_app() {
    let fake = Fake::new().with_check(found("2.0.0"));
    let (_h, task) = start(&fake, GateOptions::default());
    assert_eq!(task.await.unwrap(), GateResult::Installing);
    assert_eq!(fake.views(), vec![ask("2.0.0"), installing("2.0.0")]);
    assert_eq!(*fake.handoffs.lock(), vec!["2.0.0".to_string()]);
    assert_eq!(fake.hides(), 1);
    assert!(fake.records().is_empty());
}

#[tokio::test(start_paused = true)]
async fn records_the_failure_shows_it_and_starts_the_current_version_when_the_download_fails() {
    let fake = Fake::new().with_check(found("2.0.0")).with_download(failing_download());
    let (_h, task) = start(&fake, GateOptions::default());
    advance(2500).await;
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(fake.records(), vec!["2.0.0".to_string()]);
    assert_eq!(fake.views().last(), Some(&GateView::Failed { version: "2.0.0".into() }));
    assert!(fake.handoffs.lock().is_empty());
    assert_eq!(fake.hides(), 1);
}

#[tokio::test(start_paused = true)]
async fn records_the_failure_and_starts_the_app_when_the_installer_hand_over_does_not_happen() {
    let fake = Fake::new().with_check(found("2.0.0")).with_handoff(Box::new(|_, _, _| Box::pin(async { Ok(false) })));
    let (_h, task) = start(&fake, GateOptions::default());
    advance(2500).await;
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(fake.records(), vec!["2.0.0".to_string()]);
}

#[tokio::test(start_paused = true)]
async fn treats_a_stalled_download_as_a_failure() {
    let fake = Fake::new().with_check(found("2.0.0")).with_download(never_download());
    let (_h, task) = start(&fake, GateOptions::default());
    advance(60_000 + 2500).await;
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(fake.records(), vec!["2.0.0".to_string()]);
}

type Reporter = Arc<Mutex<Option<Arc<dyn Fn(f64) + Send + Sync>>>>;

/// A download the test drives: (progress handle, finish).
fn driven() -> (DownloadFn, Reporter, Arc<Mutex<Option<oneshot::Sender<()>>>>) {
    let reporter: Reporter = Arc::default();
    let finish: Arc<Mutex<Option<oneshot::Sender<()>>>> = Arc::default();
    let (r, f) = (reporter.clone(), finish.clone());
    let download: DownloadFn = Box::new(move |progress| {
        *r.lock() = Some(progress);
        let (tx, rx) = oneshot::channel();
        *f.lock() = Some(tx);
        Box::pin(async move {
            match rx.await {
                Ok(()) => Ok(()),
                Err(_) => std::future::pending().await,
            }
        })
    });
    (download, reporter, finish)
}

fn report(reporter: &Reporter, percent: f64) {
    let progress = reporter.lock().clone().unwrap();
    progress(percent);
}

#[tokio::test(start_paused = true)]
async fn keeps_a_slow_but_progressing_download_alive() {
    let (download, reporter, finish) = driven();
    let fake = Fake::new().with_check(found("2.0.0")).with_download(download);
    let (_h, task) = start(&fake, GateOptions::default());
    for i in 0..4 {
        advance(40_000).await;
        report(&reporter, f64::from(i) * 10.0);
    }
    let _ = finish.lock().take().unwrap().send(());
    assert_eq!(task.await.unwrap(), GateResult::Installing);
    assert!(fake.records().is_empty());
}

#[tokio::test(start_paused = true)]
async fn never_retries_a_version_that_already_failed() {
    let fake = Fake::new().with_check(found("2.0.0"));
    let (_h, task) = start(&fake, skip("2.0.0"));
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(fake.downloads.load(Ordering::SeqCst), 0);
    assert!(fake.handoffs.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn marks_the_attempt_before_the_installer_starts() {
    let fake = Fake::new().with_check(found("2.0.0"));
    let (_h, task) = start(&fake, GateOptions::default());
    assert_eq!(task.await.unwrap(), GateResult::Installing);
    assert_eq!(*fake.order.lock(), vec!["mark", "handoff"]);
    assert!(fake.records().is_empty());
}

#[tokio::test(start_paused = true)]
async fn starts_the_app_when_the_hand_over_never_answers_and_nothing_says_the_installer_started() {
    let fake = Fake::new().with_check(found("2.0.0")).with_handoff(Box::new(|_, _, _| Box::pin(std::future::pending())));
    let (_h, task) = start(&fake, GateOptions::default());
    advance(20_000 + 2500).await;
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert!(fake.records().is_empty());
}

#[tokio::test(start_paused = true)]
async fn starts_the_app_when_the_hand_over_throws_or_reports_that_nothing_was_handed_over() {
    let fake = Fake::new()
        .with_check(found("2.0.0"))
        .with_handoff(Box::new(|_, _, _| Box::pin(async { Err(UpdateError::Failed("spawn".into())) })));
    let (_h, task) = start(&fake, GateOptions::default());
    advance(2500).await;
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(fake.records(), vec!["2.0.0".to_string()]);
}

#[tokio::test(start_paused = true)]
async fn gives_up_on_a_download_that_keeps_progressing_but_never_finishes() {
    let (download, reporter, _finish) = driven();
    let fake = Fake::new().with_check(found("2.0.0")).with_download(download);
    let (_h, task) = start(&fake, GateOptions::default());
    for i in 0..5 {
        advance(40_000).await;
        if reporter.lock().is_some() {
            report(&reporter, f64::from(i));
        }
    }
    advance(2500).await;
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(fake.records(), vec!["2.0.0".to_string()]);
    assert!(fake.handoffs.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn abandons_the_check_only_on_a_timeout_not_on_an_ordinary_failure() {
    let fake = Fake::new().with_check(failing_check());
    let (_h, task) = start(&fake, GateOptions::default());
    task.await.unwrap();
    assert_eq!(fake.abandons.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn starts_the_app_during_the_check_without_recording_a_failure_and_abandons_the_check() {
    let fake = Fake::new().with_check(never_check());
    let options = GateOptions { timings: GateTimings { show_after: Duration::ZERO, ..Default::default() }, ..Default::default() };
    let (h, task) = start(&fake, options);
    advance(10).await;
    h.cancel();
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert!(fake.abandons.load(Ordering::SeqCst) >= 1);
    assert!(fake.records().is_empty());
    assert_eq!(fake.hides(), 1);
}

#[tokio::test(start_paused = true)]
async fn starts_the_app_during_the_download_leaves_the_window_closed_and_ignores_later_progress() {
    let (download, reporter, _finish) = driven();
    let fake = Fake::new().with_check(found("2.0.0")).with_download(download);
    let (h, task) = start(&fake, GateOptions::default());
    advance(10).await;
    h.cancel();
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    let shown = fake.views().len();
    report(&reporter, 80.0);
    assert_eq!(fake.views().len(), shown);
    assert!(fake.handoffs.lock().is_empty());
    assert!(fake.records().is_empty());
    assert_eq!(fake.hides(), 1);
}

#[tokio::test(start_paused = true)]
async fn a_cancel_is_ignored_once_the_installer_is_being_handed_over() {
    let release: Arc<Mutex<Option<oneshot::Sender<bool>>>> = Arc::default();
    let r = release.clone();
    let fake = Fake::new().with_check(found("2.0.0")).with_handoff(Box::new(move |_, _, _| {
        let (tx, rx) = oneshot::channel();
        *r.lock() = Some(tx);
        Box::pin(async move { Ok(rx.await.unwrap_or(false)) })
    }));
    let (h, task) = start(&fake, GateOptions::default());
    advance(10).await;
    h.cancel();
    let _ = release.lock().take().unwrap().send(true);
    assert_eq!(task.await.unwrap(), GateResult::Installing);
}

#[tokio::test(start_paused = true)]
async fn still_updates_to_a_newer_version_than_the_one_that_failed() {
    let fake = Fake::new().with_check(found("2.0.1"));
    let (_h, task) = start(&fake, skip("2.0.0"));
    assert_eq!(task.await.unwrap(), GateResult::Installing);
}

#[tokio::test(start_paused = true)]
async fn a_slow_hand_over_is_abandoned_through_the_signal_without_recording_a_failure() {
    let signal: Arc<Mutex<Option<CancellationToken>>> = Arc::default();
    let s = signal.clone();
    let fake = Fake::new().with_check(found("2.0.0")).with_handoff(Box::new(move |_, _, deadline| {
        *s.lock() = Some(deadline);
        Box::pin(std::future::pending())
    }));
    let options = GateOptions {
        timings: GateTimings { handoff_timeout: Duration::from_secs(1), ..Default::default() },
        ..Default::default()
    };
    let (_h, task) = start(&fake, options);
    advance(1000).await;
    advance(5000).await;
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert!(signal.lock().as_ref().unwrap().is_cancelled());
    assert!(fake.records().is_empty());
    assert!(fake.views().iter().any(|v| matches!(v, GateView::Failed { .. })));
}

#[tokio::test(start_paused = true)]
async fn a_slow_hand_over_counts_as_installing_when_the_installer_was_already_started_at_the_deadline() {
    let fake = Fake::new().with_check(found("2.0.0")).with_handoff(Box::new(|_, _, _| Box::pin(std::future::pending())));
    fake.committed.store(true, Ordering::SeqCst);
    let options = GateOptions {
        timings: GateTimings { handoff_timeout: Duration::from_secs(1), ..Default::default() },
        ..Default::default()
    };
    let (_h, task) = start(&fake, options);
    advance(1000).await;
    assert_eq!(task.await.unwrap(), GateResult::Installing);
    assert!(fake.records().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_hand_over_that_reports_failure_still_records_a_failure() {
    let fake = Fake::new().with_check(found("2.0.0")).with_handoff(Box::new(|_, _, _| Box::pin(async { Ok(false) })));
    let (_h, task) = start(&fake, GateOptions::default());
    advance(5000).await;
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(fake.records(), vec!["2.0.0".to_string()]);
}

// ── ask mode ────────────────────────────────────────────────────────────────────────────────────

#[tokio::test(start_paused = true)]
async fn ask_offers_the_update_starts_downloading_at_once_and_keeps_the_prompt_on_screen_while_it_runs() {
    let (download, reporter, _finish) = driven();
    let fake = Fake::new().with_check(found("2.0.0")).with_download(download);
    let (h, task) = start_asking(&fake, GateOptions::default());
    advance(10).await;
    assert_eq!(fake.downloads.load(Ordering::SeqCst), 1);
    report(&reporter, 30.0);
    advance(30_000).await;
    report(&reporter, 60.0);
    assert_eq!(fake.views(), vec![ask("2.0.0")]);
    // A window that crashed or failed to load answers "Later" through the same cancel path.
    h.cancel();
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(fake.hides(), 1);
}

#[tokio::test(start_paused = true)]
async fn ask_re_checks_once_when_install_now_fails_and_does_not_record_a_failure_for_a_vanished_version() {
    let calls = Arc::new(AtomicUsize::new(0));
    let c = calls.clone();
    let fake = Fake::new()
        .with_check(Box::new(move || {
            let n = c.fetch_add(1, Ordering::SeqCst);
            Box::pin(async move { Ok((n == 0).then(|| "2.0.0".to_string())) })
        }))
        .with_download(Box::new(|_| Box::pin(async { Err(UpdateError::Failed("404".into())) })));
    let (h, task) = start_asking(&fake, GateOptions::default());
    advance(10).await;
    h.install();
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(fake.records().is_empty());
}

#[tokio::test(start_paused = true)]
async fn ask_still_records_the_failure_when_the_re_check_finds_the_same_version() {
    let fake = Fake::new().with_check(found("2.0.0")).with_download(failing_download());
    let (h, task) = start_asking(&fake, GateOptions::default());
    advance(10).await;
    h.install();
    advance(2500).await;
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(fake.checks.load(Ordering::SeqCst), 2);
    assert_eq!(fake.records(), vec!["2.0.0".to_string()]);
}

#[tokio::test(start_paused = true)]
async fn ask_install_now_while_the_download_is_still_running_shows_its_progress_then_hands_over() {
    let (download, reporter, finish) = driven();
    let fake = Fake::new().with_check(found("2.0.0")).with_download(download);
    let (h, task) = start_asking(&fake, GateOptions::default());
    advance(10).await;
    report(&reporter, 20.0);
    h.install();
    advance(10).await;
    report(&reporter, 70.0);
    let _ = finish.lock().take().unwrap().send(());
    assert_eq!(task.await.unwrap(), GateResult::Installing);
    assert_eq!(fake.views(), vec![ask("2.0.0"), downloading("2.0.0", 20.0), downloading("2.0.0", 70.0), installing("2.0.0")]);
    assert_eq!(fake.downloads.load(Ordering::SeqCst), 1);
    assert_eq!(*fake.handoffs.lock(), vec!["2.0.0".to_string()]);
    assert!(fake.records().is_empty());
}

#[tokio::test(start_paused = true)]
async fn ask_install_now_after_the_download_finished_goes_straight_to_the_hand_over() {
    let fake = Fake::new().with_check(found("2.0.0"));
    let (h, task) = start_asking(&fake, GateOptions::default());
    advance(10).await;
    h.install();
    assert_eq!(task.await.unwrap(), GateResult::Installing);
    assert_eq!(fake.views(), vec![ask("2.0.0"), installing("2.0.0")]);
    assert_eq!(fake.downloads.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn ask_a_download_that_failed_while_the_prompt_was_open_fails_when_install_now_is_chosen() {
    let fake = Fake::new().with_check(found("2.0.0")).with_download(failing_download());
    let (h, task) = start_asking(&fake, GateOptions::default());
    advance(10).await;
    h.install();
    advance(2500).await;
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(fake.records(), vec!["2.0.0".to_string()]);
    assert!(fake.handoffs.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn ask_later_after_a_failed_download_starts_the_app_quietly() {
    let fake = Fake::new().with_check(found("2.0.0")).with_download(failing_download());
    let (h, task) = start_asking(&fake, GateOptions::default());
    advance(10).await;
    h.cancel();
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert!(fake.records().is_empty());
    assert_eq!(fake.downloads.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn ask_a_stalled_download_is_still_a_failure_when_install_now_is_chosen_after_the_stall() {
    let fake = Fake::new().with_check(found("2.0.0")).with_download(never_download());
    let (h, task) = start_asking(&fake, GateOptions::default());
    advance(61_000).await;
    h.install();
    advance(2500).await;
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert_eq!(fake.records(), vec!["2.0.0".to_string()]);
}

#[tokio::test(start_paused = true)]
async fn ask_later_starts_the_app_without_installing_or_recording_a_failure_and_leaves_the_download_running() {
    let fake = Fake::new().with_check(found("2.0.0")).with_download(never_download());
    let (h, task) = start_asking(&fake, GateOptions::default());
    advance(10).await;
    h.cancel();
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert!(fake.handoffs.lock().is_empty());
    assert!(fake.order.lock().is_empty(), "no attempt marker");
    assert!(fake.records().is_empty());
    assert_eq!(fake.hides(), 1);
}

#[tokio::test(start_paused = true)]
async fn ask_never_prompts_or_downloads_when_there_is_no_update_and_never_retries_a_failed_version() {
    let none = Fake::new().with_check(ok_none());
    let (_h, task) = start_asking(&none, GateOptions::default());
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert!(none.views().is_empty());
    let skipped = Fake::new().with_check(found("2.0.0"));
    let (_h, task) = start_asking(&skipped, skip("2.0.0"));
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert!(skipped.views().is_empty());
}

#[tokio::test(start_paused = true)]
async fn ask_closing_during_the_download_after_install_now_still_starts_the_app_without_a_failure_record() {
    let fake = Fake::new().with_check(found("2.0.0")).with_download(never_download());
    let (h, task) = start_asking(&fake, GateOptions::default());
    advance(10).await;
    h.install();
    advance(10).await;
    h.cancel();
    assert_eq!(task.await.unwrap(), GateResult::StartApp);
    assert!(fake.records().is_empty());
}

// ── the update window follows the newest target (wired to a real coordinator) ──────────────────

struct Wired {
    c: Arc<UpdateCoordinator>,
    views: Mutex<Vec<GateView>>,
    handed: Mutex<Vec<String>>,
    records: AtomicUsize,
    /// Some: the hand-over waits for this (the TS `release`).
    hold: Mutex<Option<oneshot::Receiver<bool>>>,
}

impl Wired {
    fn new(h: &Harness) -> Arc<Self> {
        Arc::new(Self {
            c: h.coordinator.clone(),
            views: Mutex::default(),
            handed: Mutex::default(),
            records: AtomicUsize::new(0),
            hold: Mutex::new(None),
        })
    }
    fn last(&self) -> GateView {
        self.views.lock().last().cloned().unwrap()
    }
}

impl GateDeps for Wired {
    fn check(&self) -> BoxFut<Result<Option<String>, UpdateError>> {
        self.c.check(CheckReason::Startup)
    }
    fn recheck(&self) -> BoxFut<Result<Option<String>, UpdateError>> {
        self.c.check(CheckReason::Recheck)
    }
    fn is_downloaded(&self, version: &str) -> bool {
        self.c.is_downloaded(Some(version))
    }
    fn target(&self) -> Option<String> {
        self.c.current_target()
    }
    fn on_target_change(&self, listener: Arc<dyn Fn() + Send + Sync>) -> Option<crate::coordinator::Unsubscribe> {
        Some(self.c.on_target_change(listener))
    }
    fn download(&self, on_progress: Arc<dyn Fn(f64) + Send + Sync>) -> BoxFut<Result<(), UpdateError>> {
        let off = self.c.on_progress(on_progress);
        let download = self.c.download();
        Box::pin(async move {
            let result = download.await;
            off();
            result
        })
    }
    fn show(&self, view: GateView) {
        self.views.lock().push(view);
    }
    fn hide(&self) {}
    fn handoff(&self, version: String, hide: HideFn, _deadline: CancellationToken) -> BoxFut<Result<bool, UpdateError>> {
        if !self.c.lock_handover(Some(&version)) {
            return Box::pin(async { Ok(false) });
        }
        hide();
        self.handed.lock().push(version);
        let hold = self.hold.lock().take();
        Box::pin(async move {
            match hold {
                Some(rx) => Ok(rx.await.unwrap_or(false)),
                None => Ok(true),
            }
        })
    }
    fn record_failure(&self, _version: &str) {
        self.records.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test(start_paused = true)]
async fn ask_prompt_open_a_newer_release_replaces_the_version_in_the_prompt_install_now_installs_the_newest_only() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    let w = Wired::new(&h);
    let handle = GateHandle::new();
    let result = tokio::spawn(run_startup_gate(w.clone(), handle.clone(), GateOptions::default()));
    settle().await;
    assert_eq!(w.last(), ask("0.6.5"));
    h.publish(Some("0.6.6"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    assert_eq!(w.last(), ask("0.6.6"));
    let versions: Vec<String> = h.backend.downloads.lock().iter().map(|d| d.version.clone()).collect();
    assert_eq!(versions, vec!["0.6.5", "0.6.6"]);
    handle.install();
    settle().await;
    assert_eq!(w.last(), downloading("0.6.6", 0.0));
    h.download(1).finish();
    settle().await;
    assert_eq!(result.await.unwrap(), GateResult::Installing);
    assert_eq!(*w.handed.lock(), vec!["0.6.6".to_string()]);
    let installs: Vec<GateView> = w.views.lock().iter().filter(|v| matches!(v, GateView::Installing { .. })).cloned().collect();
    assert_eq!(installs, vec![installing("0.6.6")]);
}

#[tokio::test(start_paused = true)]
async fn chosen_and_downloading_a_newer_release_restarts_the_download_in_the_same_window() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    let w = Wired::new(&h);
    let handle = GateHandle::new();
    let result = tokio::spawn(run_startup_gate(w.clone(), handle.clone(), GateOptions::default()));
    settle().await;
    handle.install();
    settle().await;
    h.download(0).progress(70.0);
    settle().await;
    assert_eq!(w.last(), downloading("0.6.5", 70.0));
    h.publish(Some("0.6.6"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    assert_eq!(w.last(), downloading("0.6.6", 0.0));
    h.download(1).progress(30.0);
    settle().await;
    assert_eq!(w.last(), downloading("0.6.6", 30.0));
    h.download(1).finish();
    settle().await;
    assert_eq!(result.await.unwrap(), GateResult::Installing);
    assert_eq!(*w.handed.lock(), vec!["0.6.6".to_string()]);
    assert!(!w.views.lock().iter().any(|v| *v == installing("0.6.5")));
    assert_eq!(w.records.load(Ordering::SeqCst), 0);
}

#[tokio::test(start_paused = true)]
async fn the_last_look_before_the_hand_over_finds_a_newer_release_after_the_old_one_was_fully_downloaded() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    let w = Wired::new(&h);
    let handle = GateHandle::new();
    let result = tokio::spawn(run_startup_gate(w.clone(), handle.clone(), GateOptions::default()));
    settle().await;
    h.download(0).finish();
    settle().await;
    // The feed changes silently (no periodic check ran); the click triggers the last look.
    h.publish(Some("0.6.6"));
    handle.install();
    settle().await;
    assert_eq!(w.last(), downloading("0.6.6", 0.0));
    assert!(w.handed.lock().is_empty());
    h.download(1).finish();
    settle().await;
    assert_eq!(result.await.unwrap(), GateResult::Installing);
    assert_eq!(*w.handed.lock(), vec!["0.6.6".to_string()]);
}

#[tokio::test(start_paused = true)]
async fn status_bar_click_on_a_ready_update_window_opens_the_last_look_supersedes_the_newest_installs() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    h.download(0).finish();
    settle().await;
    h.publish(Some("0.6.6"));
    let w = Wired::new(&h);
    let result = tokio::spawn(run_install_window(w.clone(), GateHandle::new(), GateOptions::default(), "0.6.5".into()));
    settle().await;
    assert_eq!(w.last(), downloading("0.6.6", 0.0));
    h.download(1).finish();
    settle().await;
    assert_eq!(result.await.unwrap(), GateResult::Installing);
    assert_eq!(*w.handed.lock(), vec!["0.6.6".to_string()]);
}

#[tokio::test(start_paused = true)]
async fn status_bar_click_while_a_background_download_runs_joins_it_and_installs_when_it_ends() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    h.download(0).progress(50.0);
    let w = Wired::new(&h);
    let result = tokio::spawn(run_install_window(w.clone(), GateHandle::new(), GateOptions::default(), "0.6.5".into()));
    settle().await;
    assert_eq!(h.downloads(), 1);
    assert!(matches!(w.last(), GateView::Downloading { .. }));
    h.download(0).finish();
    settle().await;
    assert_eq!(result.await.unwrap(), GateResult::Installing);
    assert_eq!(*w.handed.lock(), vec!["0.6.5".to_string()]);
}

#[tokio::test(start_paused = true)]
async fn status_bar_click_on_a_ready_update_installs_at_once_through_the_window() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    h.download(0).finish();
    settle().await;
    let w = Wired::new(&h);
    let result = tokio::spawn(run_install_window(w.clone(), GateHandle::new(), GateOptions::default(), "0.6.5".into()));
    settle().await;
    assert_eq!(result.await.unwrap(), GateResult::Installing);
    assert_eq!(*w.handed.lock(), vec!["0.6.5".to_string()]);
    assert_eq!(*w.views.lock(), vec![installing("0.6.5")]);
}

#[tokio::test(start_paused = true)]
async fn install_pressed_for_a_and_b_appears_during_the_hand_over_a_finishes_b_is_offered_after_the_relaunch() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    let w = Wired::new(&h);
    let (release, hold) = oneshot::channel();
    *w.hold.lock() = Some(hold);
    let handle = GateHandle::new();
    let result = tokio::spawn(run_startup_gate(w.clone(), handle.clone(), GateOptions::default()));
    settle().await;
    handle.install();
    settle().await;
    h.download(0).finish();
    settle().await;
    assert_eq!(h.coordinator.handover_version().as_deref(), Some("0.6.5"));
    h.publish(Some("0.6.6"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    assert_eq!((h.state().status, h.state().version.as_deref()), (Status::Installing, Some("0.6.5")));
    assert_eq!(h.downloads(), 1);
    assert_eq!(w.last(), installing("0.6.5"));
    let _ = release.send(true);
    assert_eq!(result.await.unwrap(), GateResult::Installing);
    assert_eq!(h.coordinator.newer_version().as_deref(), Some("0.6.6"));
    // After the relaunch (a new process: a fresh coordinator) the normal flow offers B.
    let next = Harness::new(false);
    next.publish(Some("0.6.6"));
    let again = Wired::new(&next);
    let handle = GateHandle::new();
    let second = tokio::spawn(run_startup_gate(again.clone(), handle.clone(), GateOptions::default()));
    settle().await;
    assert_eq!(again.last(), ask("0.6.6"));
    handle.cancel();
    assert_eq!(second.await.unwrap(), GateResult::StartApp);
}

#[tokio::test(start_paused = true)]
async fn closing_the_window_mid_download_leaves_the_download_running_for_the_status_bar() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    let w = Wired::new(&h);
    let handle = GateHandle::new();
    let result = tokio::spawn(run_install_window(w.clone(), handle.clone(), GateOptions::default(), "0.6.5".into()));
    settle().await;
    handle.cancel();
    assert_eq!(result.await.unwrap(), GateResult::StartApp);
    assert_eq!(h.state().status, Status::Downloading);
    h.download(0).finish();
    settle().await;
    assert_eq!(h.state().status, Status::Ready);
    assert!(w.handed.lock().is_empty());
}
