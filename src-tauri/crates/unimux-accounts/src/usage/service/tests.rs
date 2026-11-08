//! Ports of the main cases of test/usage-service.test.ts.

use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::json;

use super::*;
use crate::usage::types::{UsageWindow, WindowId};

struct Fx {
    _tmp: tempfile::TempDir,
    cache: PathBuf,
    now: Arc<Mutex<f64>>,
    refs: Arc<Mutex<Vec<AccountRef>>>,
    answer: Arc<Mutex<FetchResult>>,
    calls: Arc<AtomicUsize>,
}

const T0: f64 = 1_791_720_000_000.0;

fn ok(id: &str, used: f64) -> FetchResult {
    let mut u = ProviderUsage::new(id, Provider::Claude, Status::Ok, T0, Source::Live);
    u.windows.push(UsageWindow { id: WindowId::FiveHour, used_percent: used, resets_at: 1_791_730_000.0 });
    u.email = Some("a@x.io".into());
    FetchResult { usage: u, retry_after_ms: None, failed: false }
}

fn err(id: &str, error: &str, retry: Option<f64>) -> FetchResult {
    let mut u = ProviderUsage::new(id, Provider::Claude, Status::Error, T0, Source::Live);
    u.error = Some(error.into());
    FetchResult { usage: u, retry_after_ms: retry, failed: false }
}

fn live_ref() -> AccountRef {
    AccountRef {
        id: "claude:main".into(),
        provider: "claude".into(),
        key: Some("a@x.io".into()),
        active: Some(true),
        ..Default::default()
    }
}

impl Fx {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("usage-cache.json");
        Self {
            _tmp: tmp,
            cache,
            now: Arc::new(Mutex::new(T0)),
            refs: Arc::new(Mutex::new(vec![live_ref()])),
            answer: Arc::new(Mutex::new(ok("claude:main", 10.0))),
            calls: Arc::default(),
        }
    }

    fn service(&self) -> Arc<UsageService> {
        let (refs, answer, calls, now) = (self.refs.clone(), self.answer.clone(), self.calls.clone(), self.now.clone());
        let mut o = UsageOptions::new(
            Arc::new(move || refs.lock().clone()),
            Arc::new(move |r: AccountRef| {
                calls.fetch_add(1, Ordering::SeqCst);
                let mut a = answer.lock().clone();
                a.usage.account_id = r.id.clone();
                async move { a }.boxed()
            }),
            self.cache.clone(),
            Arc::new(|| true),
            Arc::new(|| 0.0),
            tokio::runtime::Handle::current(),
        );
        o.now = Arc::new(move || *now.lock());
        UsageService::new(o)
    }

    fn advance(&self, ms: f64) {
        *self.now.lock() += ms;
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[tokio::test]
async fn spacing_per_account_and_the_refresh_button_guard() {
    let f = Fx::new();
    let s = f.service();
    let state = s.refresh(false, false, None).await;
    assert_eq!(state.providers.len(), 1);
    assert_eq!(state.providers[0].attempt_at, Some(T0));
    assert_eq!(f.calls(), 1);
    // Within 20 s: no run at all; after it, the 3 minute spacing per account.
    f.advance(10_000.0);
    s.refresh(false, false, None).await;
    f.advance(30_000.0);
    s.refresh(false, false, None).await;
    assert_eq!(f.calls(), 1);
    // A subject is read at once.
    s.refresh(true, true, Some(LIVE_CARD)).await;
    assert_eq!(f.calls(), 2);
    // The refresh button reads again after the 30 s guard.
    f.advance(31_000.0);
    s.refresh_now().await;
    assert_eq!(f.calls(), 3);
    // The cache was written with the account key and the read time.
    let cache: Value = serde_json::from_str(&std::fs::read_to_string(&f.cache).unwrap()).unwrap();
    assert_eq!(cache["version"], 2);
    assert_eq!(cache["entries"][0]["key"], "a@x.io");
    // Written like JSON.stringify: a whole number without ".0".
    assert_eq!(cache["reads"]["a@x.io"].as_f64(), Some(T0 + 71_000.0));
}

#[tokio::test]
async fn backoff_keeps_the_numbers_and_a_rate_limit_is_never_bypassed() {
    let f = Fx::new();
    let s = f.service();
    s.refresh(false, false, None).await;
    *f.answer.lock() = err("claude:main", "http-429", Some(60_000.0));
    f.advance(200_000.0);
    let state = s.refresh(false, false, None).await;
    let card = &state.providers[0];
    assert_eq!((card.status, card.source, card.error.as_deref()), (Status::Error, Source::Cache, Some("http-429")));
    assert_eq!(card.windows.len(), 1);
    // Retry-After + the 15 minute margin.
    assert_eq!(card.retry_at, Some(T0 + 200_000.0 + 60_000.0 + RETRY_AFTER_MARGIN_MS));
    f.advance(200_000.0);
    s.refresh_now().await;
    assert_eq!(f.calls(), 2, "the refresh button never bypasses a rate limit");
    // Another failure: the button goes through; the backoff doubles without a Retry-After.
    *f.answer.lock() = err("claude:main", "http-500", None);
    f.advance(RETRY_AFTER_MARGIN_MS);
    s.refresh(false, false, None).await;
    assert_eq!(f.calls(), 3);
    f.advance(30_000.0);
    let state = s.refresh_now().await;
    assert_eq!(f.calls(), 4);
    let now = *f.now.lock();
    assert_eq!(state.providers[0].retry_at, Some(now + 4.0 * 60_000.0));
    // A good read clears the hold.
    *f.answer.lock() = ok("claude:main", 50.0);
    s.refresh(true, true, Some("a@x.io")).await;
    let state = s.state();
    assert_eq!((state.providers[0].status, state.providers[0].retry_at), (Status::Ok, None));
}

#[tokio::test]
async fn the_cache_survives_a_restart_as_remembered_numbers() {
    let f = Fx::new();
    let s = f.service();
    s.refresh(false, false, None).await;
    drop(s);
    let s = f.service();
    let state = s.state();
    assert_eq!((state.providers[0].status, state.providers[0].source), (Status::Ok, Source::Cache));
    // The first run of a process is eager: only the 30 s guard counts.
    f.advance(40_000.0);
    s.refresh(false, false, None).await;
    assert_eq!(f.calls(), 2);
}

#[tokio::test]
async fn a_legacy_cache_moves_to_the_saved_card_with_the_same_id() {
    let f = Fx::new();
    let legacy = json!({ "providers": [
        { "accountId": "claude:r1", "provider": "claude", "status": "ok", "source": "live", "fetchedAt": 1,
          "windows": [{ "id": "5h", "usedPercent": 33, "resetsAt": 5 }] },
    ], "backoff": { "claude:r1": { "until": T0 + 1e6, "failures": 2, "error": "http-500" } } });
    std::fs::write(&f.cache, legacy.to_string()).unwrap();
    f.refs.lock().push(AccountRef {
        id: "claude:r1".into(),
        provider: "claude".into(),
        config_dir: Some(PathBuf::from("/p/r1")),
        key: Some("b@x.io".into()),
        ..Default::default()
    });
    let s = f.service();
    let state = s.state();
    let saved = state.providers.iter().find(|p| p.account_id == "claude:r1").unwrap();
    assert_eq!((saved.windows[0].used_percent, saved.managed), (33.0, Some(true)));
    // Its hold came along: the first run reads the live card only.
    s.refresh(false, false, None).await;
    assert_eq!(f.calls(), 1);
}

#[tokio::test]
async fn joining_callers_share_one_run_and_a_forced_one_follows() {
    let f = Fx::new();
    let s = f.service();
    let a = s.refresh(false, false, None);
    let b = s.refresh(false, false, None);
    let c = s.refresh(true, true, Some(LIVE_CARD));
    let (a, b, c) = futures::join!(a, b, c);
    assert_eq!(a.providers.len(), b.providers.len());
    assert_eq!(c.providers.len(), 1);
    // The subject was taken by the run already queued; the forced follow-up keeps the account's spacing.
    assert_eq!(f.calls(), 1);
    let g = s.inner.lock();
    assert!(g.pending.is_none() && g.follow_up.is_none());
}

// limit-alerts "${pollHidden ? 'goes on' : 'stops'} when pollHidden is ${pollHidden}"
#[tokio::test(start_paused = true)]
async fn polling_goes_on_while_hidden_only_with_poll_hidden() {
    for poll_hidden in [true, false] {
        let f = Fx::new();
        let (refs, answer, calls) = (f.refs.clone(), f.answer.clone(), f.calls.clone());
        let mut o = UsageOptions::new(
            Arc::new(move || refs.lock().clone()),
            Arc::new(move |r: AccountRef| {
                calls.fetch_add(1, Ordering::SeqCst);
                let mut a = answer.lock().clone();
                a.usage.account_id = r.id.clone();
                async move { a }.boxed()
            }),
            f.cache.clone(),
            Arc::new(|| true),
            Arc::new(|| 300_000.0),
            tokio::runtime::Handle::current(),
        );
        let start = tokio::time::Instant::now();
        o.now = Arc::new(move || T0 + start.elapsed().as_millis() as f64);
        o.poll_hidden = Some(Arc::new(move || poll_hidden));
        let s = UsageService::new(o);
        s.start();
        tokio::time::sleep(Duration::ZERO).await;
        s.set_active(false);
        tokio::time::sleep(Duration::from_millis(601_000)).await;
        assert_eq!(f.calls(), if poll_hidden { 3 } else { 1 }, "pollHidden {poll_hidden}");
        s.stop();
    }
}
