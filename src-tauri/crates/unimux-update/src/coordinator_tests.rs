//! test/update-coordinator.test.ts "UpdateCoordinator state machine" and "supersede", and the coordinator side of
//! test/updater.test.ts, on tokio's paused clock.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use super::*;

pub(crate) struct FakeDownload {
    pub version: String,
    pub cancel: CancellationToken,
    pub progress: ProgressFn,
    finish: Mutex<Option<oneshot::Sender<Result<(), String>>>>,
}

impl FakeDownload {
    pub fn progress(&self, percent: f64) {
        (self.progress)(Progress::percent(percent));
    }
    pub fn finish(&self) {
        if let Some(tx) = self.finish.lock().take() {
            let _ = tx.send(Ok(()));
        }
    }
    pub fn fail(&self, message: &str) {
        if let Some(tx) = self.finish.lock().take() {
            let _ = tx.send(Err(message.into()));
        }
    }
}

#[derive(Default)]
pub(crate) struct FakeBackend {
    pub feed: Mutex<LookupResult>,
    pub downloads: Mutex<Vec<Arc<FakeDownload>>>,
    pub lookups: AtomicUsize,
    /// The next lookups: Some(Err) fails, None hangs forever; consumed one per lookup before the feed is used.
    pub next: Mutex<Vec<Option<Result<LookupResult, String>>>>,
}

impl Backend for FakeBackend {
    fn lookup(&self) -> BoxFut<Result<LookupResult, String>> {
        self.lookups.fetch_add(1, Ordering::SeqCst);
        let scripted = {
            let mut next = self.next.lock();
            if next.is_empty() { None } else { Some(next.remove(0)) }
        };
        let feed = self.feed.lock().clone();
        Box::pin(async move {
            match scripted {
                Some(Some(result)) => result,
                Some(None) => std::future::pending().await,
                None => Ok(feed),
            }
        })
    }

    fn download(&self, version: &str, on_progress: ProgressFn, cancel: CancellationToken) -> BoxFut<Result<(), String>> {
        let (tx, rx) = oneshot::channel();
        let download = Arc::new(FakeDownload {
            version: version.to_string(),
            cancel: cancel.clone(),
            progress: on_progress,
            finish: Mutex::new(Some(tx)),
        });
        self.downloads.lock().push(download);
        Box::pin(async move {
            tokio::select! {
                _ = cancel.cancelled() => Err("cancelled".to_string()),
                result = rx => result.unwrap_or_else(|_| Err("dropped".into())),
            }
        })
    }
}

type Emitted = Arc<Mutex<Vec<(Status, Option<String>)>>>;

pub(crate) struct Harness {
    pub coordinator: Arc<UpdateCoordinator>,
    pub backend: Arc<FakeBackend>,
    pub emitted: Emitted,
}

impl Harness {
    pub fn new(portable: bool) -> Self {
        let backend = Arc::new(FakeBackend::default());
        *backend.feed.lock() = LookupResult { latest: Some("0.6.4".into()), update: None };
        let emitted: Emitted = Arc::default();
        let sink = emitted.clone();
        let mut o = CoordinatorOptions::new(
            backend.clone(),
            Arc::new(move |s: &UpdateState| sink.lock().push((s.status, s.version.clone()))),
            "https://releases.test",
        );
        o.portable = Arc::new(move || portable);
        Self { coordinator: UpdateCoordinator::new(o), backend, emitted }
    }

    pub fn publish(&self, version: Option<&str>) {
        *self.backend.feed.lock() = match version {
            Some(v) => LookupResult { latest: Some(v.into()), update: Some(FoundUpdate { version: v.into(), manual: None }) },
            None => LookupResult { latest: Some("0.6.4".into()), update: None },
        };
    }

    pub fn download(&self, n: usize) -> Arc<FakeDownload> {
        self.backend.downloads.lock()[n].clone()
    }

    pub fn downloads(&self) -> usize {
        self.backend.downloads.lock().len()
    }

    pub fn statuses(&self) -> Vec<Status> {
        self.emitted.lock().iter().map(|(s, _)| *s).collect()
    }

    pub fn state(&self) -> UpdateState {
        self.coordinator.get_state()
    }

    pub async fn check(&self, reason: CheckReason) -> Result<Option<String>, UpdateError> {
        self.coordinator.check(reason).await
    }
}

/// Lets every spawned task run until it waits again (the `vi.advanceTimersByTimeAsync(0)` of the TS tests).
pub(crate) async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

#[tokio::test(start_paused = true)]
async fn idle_checking_available_downloading_ready_one_download_for_repeated_looks() {
    let h = Harness::new(false);
    assert_eq!(h.state().status, Status::Idle);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    assert_eq!(h.statuses(), vec![Status::Checking, Status::Available, Status::Downloading]);
    let s = h.state();
    assert_eq!((s.status, s.version.as_deref(), s.percent), (Status::Downloading, Some("0.6.5"), Some(0.0)));
    h.download(0).progress(42.0);
    assert_eq!(h.state().percent, Some(42.0));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    assert_eq!(h.downloads(), 1);
    h.download(0).finish();
    settle().await;
    assert_eq!((h.state().status, h.state().version.as_deref()), (Status::Ready, Some("0.6.5")));
    assert!(h.coordinator.is_downloaded(None));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    assert_eq!(h.downloads(), 1);
    assert_eq!(h.state().status, Status::Ready);
}

#[tokio::test(start_paused = true)]
async fn a_background_look_while_an_update_is_offered_is_silent_and_a_failure_of_it_does_not_turn_ready_into_an_error() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    h.download(0).finish();
    settle().await;
    let count = h.emitted.lock().len();
    h.backend.next.lock().push(Some(Err("offline".into())));
    assert_eq!(h.check(CheckReason::Background).await, Ok(None));
    assert_eq!(h.state().status, Status::Ready);
    assert_eq!(h.emitted.lock().len(), count);
}

#[tokio::test(start_paused = true)]
async fn shows_an_error_with_the_target_version_and_retries_by_looking_again() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    h.download(0).fail("disk full");
    settle().await;
    let s = h.state();
    assert_eq!((s.status, s.version.as_deref(), s.message.as_deref()), (Status::Error, Some("0.6.5"), Some("disk full")));
    h.check(CheckReason::Manual).await.unwrap();
    settle().await;
    assert_eq!(h.downloads(), 2);
    h.download(1).finish();
    settle().await;
    assert_eq!(h.state().status, Status::Ready);
}

#[tokio::test(start_paused = true)]
async fn reports_current_when_the_feed_has_nothing_newer_and_drops_a_target_the_feed_no_longer_announces() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    h.publish(None);
    h.check(CheckReason::Background).await.unwrap();
    assert_eq!(h.state().status, Status::Current);
    assert_eq!(h.state().version.as_deref(), Some("0.6.4"));
    assert!(h.state().checked_at.is_some());
    assert_eq!(h.coordinator.current_target(), None);
    assert!(h.download(0).cancel.is_cancelled());
}

#[tokio::test(start_paused = true)]
async fn announces_only_a_download_link_for_builds_that_cannot_install_by_themselves() {
    let h = Harness::new(true);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    let s = h.state();
    assert_eq!((s.status, s.portable, s.url.as_deref()), (Status::Available, Some(true), Some("https://releases.test")));
    assert_eq!(h.downloads(), 0);
    assert!(!h.coordinator.installable());
    assert!(!h.coordinator.lock_handover(Some("0.6.5")));
}

#[tokio::test(start_paused = true)]
async fn stalled_download_watchdog_no_progress_for_two_minutes_is_an_error_later_progress_recovers() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    tokio::time::sleep(Duration::from_secs(2 * 60)).await;
    settle().await;
    assert_eq!(h.state().status, Status::Error);
    assert_eq!(h.state().message.as_deref(), Some(NO_RESPONSE));
    h.download(0).progress(10.0);
    assert_eq!(h.state().status, Status::Downloading);
}

#[tokio::test(start_paused = true)]
async fn a_look_that_never_answers_ends_in_an_error_instead_of_blocking_every_later_check() {
    let h = Harness::new(false);
    h.backend.next.lock().push(None);
    let first = h.coordinator.check(CheckReason::Manual);
    tokio::time::sleep(Duration::from_secs(90)).await;
    assert_eq!(first.await, Ok(None));
    assert_eq!(h.state().status, Status::Error);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Manual).await.unwrap();
    settle().await;
    assert_eq!(h.state().status, Status::Downloading);
}

#[tokio::test(start_paused = true)]
async fn while_available_downloading_cancels_the_old_download_restarts_for_the_newest_notifies_listeners() {
    let h = Harness::new(false);
    let notified = Arc::new(AtomicUsize::new(0));
    let n = notified.clone();
    let _off = h.coordinator.on_target_change(Arc::new(move || {
        n.fetch_add(1, Ordering::SeqCst);
    }));
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    h.download(0).progress(60.0);
    h.publish(Some("0.6.6"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    assert!(h.download(0).cancel.is_cancelled());
    assert_eq!(h.downloads(), 2);
    assert_eq!(h.download(1).version, "0.6.6");
    assert_eq!(notified.load(Ordering::SeqCst), 2);
    let s = h.state();
    assert_eq!((s.status, s.version.as_deref(), s.percent), (Status::Downloading, Some("0.6.6"), Some(0.0)));
    // Late progress of the cancelled download is ignored.
    h.download(0).progress(99.0);
    assert_eq!((h.state().version.as_deref(), h.state().percent), (Some("0.6.6"), Some(0.0)));
    h.download(1).finish();
    settle().await;
    assert_eq!((h.state().status, h.state().version.as_deref()), (Status::Ready, Some("0.6.6")));
    assert!(!h.emitted.lock().iter().any(|(s, v)| *s == Status::Ready && v.as_deref() == Some("0.6.5")));
}

#[tokio::test(start_paused = true)]
async fn while_ready_the_old_version_is_forgotten() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    h.download(0).finish();
    settle().await;
    h.publish(Some("0.6.6"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    assert!(!h.coordinator.is_downloaded(Some("0.6.5")));
    assert!(!h.coordinator.lock_handover(Some("0.6.5")));
    assert_eq!((h.state().status, h.state().version.as_deref()), (Status::Downloading, Some("0.6.6")));
}

#[tokio::test(start_paused = true)]
async fn a_joined_download_of_the_superseded_version_ends_superseded() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    let joined = h.coordinator.download();
    h.publish(Some("0.6.6"));
    h.check(CheckReason::Background).await.unwrap();
    assert_eq!(joined.await, Err(UpdateError::Superseded));
}

#[tokio::test(start_paused = true)]
async fn during_the_hand_over_nothing_changes_the_newer_version_is_only_remembered() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    h.download(0).finish();
    settle().await;
    assert!(h.coordinator.lock_handover(Some("0.6.5")));
    assert!(!h.coordinator.lock_handover(Some("0.6.5")));
    let count = h.emitted.lock().len();
    h.publish(Some("0.6.6"));
    assert_eq!(h.check(CheckReason::Background).await, Ok(None));
    assert_eq!((h.state().status, h.state().version.as_deref()), (Status::Installing, Some("0.6.5")));
    assert_eq!(h.coordinator.newer_version().as_deref(), Some("0.6.6"));
    assert_eq!(h.coordinator.current_target().as_deref(), Some("0.6.5"));
    assert_eq!(h.downloads(), 1);
    assert_eq!(h.backend.lookups.load(Ordering::SeqCst), 2); // looked, but only to remember
    assert_eq!(h.emitted.lock().len(), count);
}

#[tokio::test(start_paused = true)]
async fn a_failed_hand_over_releases_the_lock_then_the_newest_version_is_offered_normally() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    h.download(0).finish();
    settle().await;
    h.coordinator.lock_handover(Some("0.6.5"));
    h.coordinator.fail_handover("installer failed");
    assert_eq!(h.coordinator.handover_version(), None);
    assert_eq!((h.state().status, h.state().version.as_deref()), (Status::Error, Some("0.6.5")));
    h.publish(Some("0.6.6"));
    h.check(CheckReason::Manual).await.unwrap();
    settle().await;
    assert_eq!((h.state().status, h.state().version.as_deref()), (Status::Downloading, Some("0.6.6")));
}

#[tokio::test(start_paused = true)]
async fn a_stale_older_answer_never_replaces_the_target_cancels_nothing_and_starts_no_second_download() {
    let h = Harness::new(false);
    h.publish(Some("0.6.6"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    h.download(0).finish();
    settle().await;
    let notified = Arc::new(AtomicUsize::new(0));
    let n = notified.clone();
    let _off = h.coordinator.on_target_change(Arc::new(move || {
        n.fetch_add(1, Ordering::SeqCst);
    }));
    h.publish(Some("0.6.5"));
    assert_eq!(h.check(CheckReason::Recheck).await, Ok(Some("0.6.6".into())));
    settle().await;
    assert_eq!(h.coordinator.current_target().as_deref(), Some("0.6.6"));
    assert_eq!((h.state().status, h.state().version.as_deref()), (Status::Ready, Some("0.6.6")));
    assert!(h.coordinator.is_downloaded(Some("0.6.6")));
    assert_eq!(h.downloads(), 1);
    assert_eq!(notified.load(Ordering::SeqCst), 0);
    assert!(h.coordinator.lock_handover(Some("0.6.6")));
}

#[tokio::test(start_paused = true)]
async fn a_stale_older_answer_while_the_newer_one_is_still_downloading_keeps_that_download() {
    let h = Harness::new(false);
    h.publish(Some("0.6.6"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    h.download(0).progress(30.0);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    assert!(!h.download(0).cancel.is_cancelled());
    assert_eq!(h.downloads(), 1);
    let s = h.state();
    assert_eq!((s.status, s.version.as_deref(), s.percent), (Status::Downloading, Some("0.6.6"), Some(30.0)));
}

#[tokio::test(start_paused = true)]
async fn a_download_page_offer_survives_blocking_and_later_looks_a_real_block_still_drops_a_normal_target() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    h.download(0).finish();
    settle().await;
    assert!(h.coordinator.lock_handover(Some("0.6.5")));
    h.coordinator.refuse_install("0.6.5", Some("App Management denied".into()));
    h.coordinator.block(Some("0.6.5"));
    let s = h.state();
    assert_eq!(
        (s.status, s.version.as_deref(), s.portable, s.url.as_deref(), s.message.as_deref()),
        (Status::Available, Some("0.6.5"), Some(true), Some("https://releases.test"), Some("App Management denied"))
    );
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    assert_eq!((h.state().status, h.state().portable), (Status::Available, Some(true)));
    assert!(!h.coordinator.lock_handover(Some("0.6.5")));
    let other = Harness::new(false);
    other.publish(Some("0.6.5"));
    other.check(CheckReason::Background).await.unwrap();
    settle().await;
    other.coordinator.block(Some("0.6.5"));
    assert_eq!(other.state().status, Status::Current);
}

#[tokio::test(start_paused = true)]
async fn a_blocked_version_is_not_offered_a_newer_one_is() {
    let h = Harness::new(false);
    h.coordinator.block(Some("0.6.5"));
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    assert_eq!(h.state().status, Status::Current);
    assert_eq!(h.state().version.as_deref(), Some("0.6.5"));
    assert_eq!(h.downloads(), 0);
    h.publish(Some("0.6.6"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    assert_eq!(h.download(0).version, "0.6.6");
}

// ── updater.test.ts (the coordinator side; electron-updater specifics are obsolete) ─────────────────

/// updater.test.ts "publishes checking synchronously and errors on a failed look, then allows retry".
#[tokio::test(start_paused = true)]
async fn publishes_checking_synchronously_and_errors_on_a_failed_look_then_allows_retry() {
    let h = Harness::new(false);
    h.backend.next.lock().push(Some(Err("offline".into())));
    let pending = h.coordinator.check(CheckReason::Manual);
    assert_eq!(h.statuses(), vec![Status::Checking]);
    assert_eq!(pending.await, Ok(None));
    assert_eq!((h.state().status, h.state().message.as_deref()), (Status::Error, Some("offline")));
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Manual).await.unwrap();
    settle().await;
    assert_eq!(h.state().status, Status::Downloading);
}

/// updater.test.ts "deduplicates checks".
#[tokio::test(start_paused = true)]
async fn deduplicates_checks() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    let (a, b) = (h.coordinator.check(CheckReason::Manual), h.coordinator.check(CheckReason::Background));
    let (a, b) = tokio::join!(a, b);
    assert_eq!((a, b), (Ok(Some("0.6.5".into())), Ok(Some("0.6.5".into()))));
    assert_eq!(h.backend.lookups.load(Ordering::SeqCst), 1);
}

/// updater.test.ts "available -> downloading (clamped progress) -> ready, one download".
#[tokio::test(start_paused = true)]
async fn available_downloading_clamped_progress_ready_one_download() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    (h.download(0).progress)(Progress { percent: 150.0, transferred: Some(-5.0), total: None, bytes_per_second: Some(f64::NAN) });
    let s = h.state();
    assert_eq!((s.percent, s.transferred, s.total, s.bytes_per_second), (Some(100.0), Some(0.0), Some(0.0), Some(0.0)));
    h.download(0).progress(f64::NAN);
    assert_eq!(h.state().percent, Some(0.0));
    h.download(0).finish();
    settle().await;
    assert_eq!(h.state().status, Status::Ready);
    assert_eq!(h.downloads(), 1);
}

/// updater.test.ts "what the status bar button may do in each state" (canInstallNow is the app's; installable is here).
#[tokio::test(start_paused = true)]
async fn installable_only_for_an_in_app_target() {
    let h = Harness::new(false);
    assert!(!h.coordinator.installable());
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    assert!(h.coordinator.installable());
    *h.backend.feed.lock() = LookupResult {
        latest: Some("0.6.6".into()),
        update: Some(FoundUpdate { version: "0.6.6".into(), manual: Some(Manual { message: Some("why".into()) }) }),
    };
    h.check(CheckReason::Background).await.unwrap();
    assert!(!h.coordinator.installable());
    assert_eq!((h.state().status, h.state().message.as_deref()), (Status::Available, Some("why")));
}

/// updater.test.ts "returns a defensive state snapshot".
#[tokio::test(start_paused = true)]
async fn returns_a_defensive_state_snapshot() {
    let h = Harness::new(false);
    let mut s = h.state();
    s.status = Status::Ready;
    assert_eq!(h.state().status, Status::Idle);
}

/// updater.test.ts "asks for fresh release data and remembers when the last check found nothing".
#[tokio::test(start_paused = true)]
async fn remembers_when_the_last_check_found_nothing() {
    let h = Harness::new(false);
    h.check(CheckReason::Manual).await.unwrap();
    let s = h.state();
    assert_eq!((s.status, s.version.as_deref()), (Status::Current, Some("0.6.4")));
    assert!(s.checked_at.unwrap() > 0.0);
    assert!(h.coordinator.last_check_at() > 0.0);
}

/// updater.test.ts "a failing last look changes nothing".
#[tokio::test(start_paused = true)]
async fn a_failing_last_look_changes_nothing() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    h.download(0).finish();
    settle().await;
    let count = h.emitted.lock().len();
    h.backend.next.lock().push(Some(Err("offline".into())));
    assert!(h.check(CheckReason::Recheck).await.is_err());
    assert_eq!(h.state().status, Status::Ready);
    assert_eq!(h.emitted.lock().len(), count);
    // A failed startup look of an idle app is an error the caller sees, and the status says so.
    let fresh = Harness::new(false);
    fresh.backend.next.lock().push(Some(Err("offline".into())));
    assert_eq!(fresh.check(CheckReason::Startup).await, Err(UpdateError::Failed("offline".into())));
    assert_eq!(fresh.state().status, Status::Error);
}

/// updater.test.ts "withdraws an already downloaded version once it is blocked, and downloads again after the block is lifted".
#[tokio::test(start_paused = true)]
async fn withdraws_a_downloaded_version_once_it_is_blocked_and_downloads_again_after_the_block_is_lifted() {
    let h = Harness::new(false);
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    h.download(0).finish();
    settle().await;
    h.coordinator.block(Some("0.6.5"));
    assert_eq!(h.state().status, Status::Current);
    assert!(!h.coordinator.is_downloaded(Some("0.6.5")));
    assert_eq!(h.coordinator.blocked_version().as_deref(), Some("0.6.5"));
    h.coordinator.block(None);
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    assert_eq!(h.downloads(), 2);
}

/// A listener that panics does not break the update.
#[tokio::test(start_paused = true)]
async fn a_panicking_listener_does_not_break_the_update() {
    let h = Harness::new(false);
    let _off = h.coordinator.on_target_change(Arc::new(|| panic!("listener")));
    let off = h.coordinator.on_progress(Arc::new(|_| panic!("listener")));
    h.publish(Some("0.6.5"));
    h.check(CheckReason::Background).await.unwrap();
    settle().await;
    h.download(0).progress(5.0);
    off();
    h.download(0).finish();
    settle().await;
    assert_eq!(h.state().status, Status::Ready);
}
