//! Case-by-case ports of test/usage-service.test.ts and test/usage-restart.test.ts. The fake clock is tokio's paused time:
//! `now` follows it, so `advance` moves the polls, the watcher, the fetch timeout and the numbers' ages together.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use futures::future::BoxFuture;
use serde_json::json;
use tokio::sync::Semaphore;

use super::*;
use crate::rules::RenewRule;
use crate::usage::types::{CardState, HeldBy, UsageWindow, WindowId, card_state};

/// 2026-10-11T12:00:00Z (usage-service).
const NOW: f64 = 1_791_720_000_000.0;
/// 2026-10-31T12:00:00Z (usage-restart).
const NOW_RESTART: f64 = 1_793_448_000_000.0;

#[derive(Clone)]
struct Clock {
    base: f64,
    start: tokio::time::Instant,
}

impl Clock {
    fn now(&self) -> f64 {
        self.base + self.start.elapsed().as_millis() as f64
    }
}

type Answer = Arc<dyn Fn(&AccountRef) -> BoxFuture<'static, FetchResult> + Send + Sync>;

struct Fx {
    _tmp: tempfile::TempDir,
    cache: PathBuf,
    clock: Clock,
    calls: Arc<Mutex<Vec<AccountRef>>>,
}

fn ready(r: FetchResult) -> BoxFuture<'static, FetchResult> {
    async move { r }.boxed()
}

fn provider_of(r: &AccountRef) -> Provider {
    Provider::parse(&r.provider).unwrap()
}

fn main_accounts() -> Vec<AccountRef> {
    vec![
        AccountRef { id: "claude:main".into(), provider: "claude".into(), ..Default::default() },
        AccountRef { id: "codex:main".into(), provider: "codex".into(), ..Default::default() },
    ]
}

fn aref(id: &str, key: &str) -> AccountRef {
    AccountRef { id: id.into(), provider: "claude".into(), key: Some(key.into()), ..Default::default() }
}

fn live_ref(id: &str, key: &str) -> AccountRef {
    AccountRef { active: Some(true), ..aref(id, key) }
}

fn saved_ref(id: &str, key: Option<&str>, dir: &str, renew: Option<RenewRule>) -> AccountRef {
    AccountRef {
        id: id.into(),
        provider: "claude".into(),
        key: key.map(str::to_string),
        config_dir: Some(PathBuf::from(dir)),
        renew,
        ..Default::default()
    }
}

async fn settle() {
    for _ in 0..200 {
        tokio::task::yield_now().await;
    }
}

async fn advance(ms: u64) {
    tokio::time::advance(Duration::from_millis(ms)).await;
    settle().await;
}

impl Fx {
    fn new() -> Self {
        Self::at(NOW)
    }

    fn at(base: f64) -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("usage-cache.json");
        Self { _tmp: tmp, cache, clock: Clock { base, start: tokio::time::Instant::now() }, calls: Arc::default() }
    }

    fn now(&self) -> f64 {
        self.clock.now()
    }

    fn usage(&self, provider: Provider, id: &str, status: Status) -> ProviderUsage {
        ProviderUsage::new(id, provider, status, self.now(), Source::Live)
    }

    /// `ok(provider, percent, accountId)`.
    fn ok(&self, provider: Provider, percent: f64, id: &str) -> FetchResult {
        let mut u = self.usage(provider, id, Status::Ok);
        u.plan = Some("Max 5x".into());
        u.windows.push(UsageWindow {
            id: WindowId::FiveHour,
            used_percent: percent,
            resets_at: (self.now() / 1000.0).floor() + 3600.0,
        });
        FetchResult { usage: u, retry_after_ms: None, failed: false }
    }

    /// `failing(provider, status, retryAfterMs, accountId)`.
    fn failing(&self, provider: Provider, status: Status, retry: Option<f64>, id: &str) -> FetchResult {
        let mut u = self.usage(provider, id, status);
        if status == Status::Error {
            u.error = Some("http-500".into());
        }
        FetchResult { usage: u, retry_after_ms: retry, failed: false }
    }

    fn error(&self, id: &str, error: &str, retry: Option<f64>) -> FetchResult {
        let mut u = self.usage(Provider::Claude, id, Status::Error);
        u.error = Some(error.into());
        FetchResult { usage: u, retry_after_ms: retry, failed: false }
    }

    fn options(
        &self,
        accounts: impl Fn() -> Vec<AccountRef> + Send + Sync + 'static,
        answer: impl Fn(&AccountRef) -> BoxFuture<'static, FetchResult> + Send + Sync + 'static,
    ) -> UsageOptions {
        let calls = self.calls.clone();
        let answer: Answer = Arc::new(answer);
        let mut o = UsageOptions::new(
            Arc::new(accounts),
            Arc::new(move |r: AccountRef| {
                calls.lock().push(r.clone());
                answer(&r)
            }),
            self.cache.clone(),
            Arc::new(|| true),
            Arc::new(|| 300_000.0),
            tokio::runtime::Handle::current(),
        );
        let clock = self.clock.clone();
        o.now = Arc::new(move || clock.now());
        o
    }

    /// The options of `make()`: spacing and the Retry-After margin off.
    fn legacy(&self, o: UsageOptions) -> UsageOptions {
        UsageOptions { min_identity_gap_ms: 0.0, retry_after_margin_ms: 0.0, ..o }
    }

    fn total(&self) -> usize {
        self.calls.lock().len()
    }

    fn count(&self, id: &str) -> usize {
        self.calls.lock().iter().filter(|r| r.id == id).count()
    }

    fn count_key(&self, key: &str) -> usize {
        self.calls.lock().iter().filter(|r| r.key.as_deref() == Some(key)).count()
    }

    fn cache_json(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(&self.cache).unwrap()).unwrap()
    }

    fn cache_text(&self) -> String {
        std::fs::read_to_string(&self.cache).unwrap_or_default()
    }

    fn write_cache(&self, v: &Value) {
        std::fs::write(&self.cache, v.to_string()).unwrap();
    }
}

/// `make()`: claude answers 40, codex 8, both main accounts, interval 5 min.
fn make(f: &Fx) -> Arc<UsageService> {
    UsageService::new(make_opts(f))
}

fn make_opts(f: &Fx) -> UsageOptions {
    let c = f.clock.clone();
    f.legacy(f.options(main_accounts, move |r: &AccountRef| {
        let pct = if r.provider == "codex" { 8.0 } else { 40.0 };
        let mut u = ProviderUsage::new(&r.id, provider_of(r), Status::Ok, c.now(), Source::Live);
        u.plan = Some("Max 5x".into());
        u.windows.push(UsageWindow { id: WindowId::FiveHour, used_percent: pct, resets_at: (c.now() / 1000.0).floor() + 3600.0 });
        ready(FetchResult { usage: u, retry_after_ms: None, failed: false })
    }))
}

fn percents(s: &UsageService) -> Vec<(String, f64)> {
    s.state().providers.iter().map(|p| (p.account_id.clone(), p.windows.first().map_or(-1.0, |w| w.used_percent))).collect()
}

/// A gate a fetch waits on: `release` lets one waiting (or the next) fetch through.
fn gate() -> Arc<Semaphore> {
    Arc::new(Semaphore::new(0))
}

async fn pass(g: &Semaphore) {
    g.acquire().await.unwrap().forget();
}

// ---- UsageService ---------------------------------------------------------------------------------------------------

/// "reads both providers at start, orders them and tells listeners"
#[tokio::test(start_paused = true)]
async fn reads_both_providers_at_start_orders_them_and_tells_listeners() {
    let f = Fx::new();
    let s = make(&f);
    let heard = Arc::new(AtomicUsize::new(0));
    let h = heard.clone();
    s.on_change(Arc::new(move |_| {
        h.fetch_add(1, Ordering::SeqCst);
    }));
    s.start();
    settle().await;
    assert_eq!((f.count("claude:main"), f.count("codex:main")), (1, 1));
    assert_eq!(percents(&s), [("claude:main".to_string(), 40.0), ("codex:main".to_string(), 8.0)]);
    assert_eq!(heard.load(Ordering::SeqCst), 1);
    s.stop();
}

/// "polls at the configured interval and stops when asked", "does nothing while disabled and resumes when enabled
/// again", "applies a new interval after rescheduling"
#[tokio::test(start_paused = true)]
async fn polls_on_the_interval_stops_pauses_while_disabled_and_reschedules() {
    let f = Fx::new();
    let c = f.clock.clone();
    let answer = move |r: &AccountRef| {
        let mut u = ProviderUsage::new(&r.id, provider_of(r), Status::Ok, c.now(), Source::Live);
        u.windows.push(UsageWindow { id: WindowId::FiveHour, used_percent: 1.0, resets_at: 0.0 });
        ready(FetchResult { usage: u, retry_after_ms: None, failed: false })
    };
    let s = UsageService::new(UsageOptions {
        interval_ms: Arc::new(|| 60_000.0),
        ..f.legacy(f.options(main_accounts, answer.clone()))
    });
    s.start();
    settle().await;
    advance(60_000).await;
    assert_eq!(f.count("claude:main"), 2);
    advance(60_000).await;
    assert_eq!(f.count("claude:main"), 3);
    s.stop();
    advance(300_000).await;
    assert_eq!(f.count("claude:main"), 3);

    let f = Fx::new();
    let enabled = Arc::new(AtomicBool::new(false));
    let e = enabled.clone();
    let s = UsageService::new(UsageOptions {
        enabled: Arc::new(move || e.load(Ordering::SeqCst)),
        ..f.legacy(f.options(main_accounts, answer.clone()))
    });
    s.start();
    advance(300_000).await;
    assert_eq!(f.total(), 0);
    enabled.store(true, Ordering::SeqCst);
    s.reschedule();
    settle().await;
    assert_eq!(f.count("claude:main"), 1);
    s.stop();

    let f = Fx::new();
    let interval = Arc::new(Mutex::new(600_000.0));
    let i = interval.clone();
    let s = UsageService::new(UsageOptions {
        interval_ms: Arc::new(move || *i.lock()),
        ..f.legacy(f.options(main_accounts, answer))
    });
    s.start();
    settle().await;
    *interval.lock() = 60_000.0;
    s.reschedule();
    settle().await;
    advance(60_001).await;
    assert_eq!(f.count("claude:main"), 2);
    s.stop();
}

/// "refreshes at most once per minimum gap and shares a request in flight", "chains exactly one forced follow-up run
/// after a run in flight"
#[tokio::test(start_paused = true)]
async fn one_run_per_minimum_gap_shared_in_flight_and_one_forced_follow_up() {
    let f = Fx::new();
    let g = gate();
    let gated = Arc::new(AtomicBool::new(true));
    let (gg, gd, c) = (g.clone(), gated.clone(), f.clock.clone());
    let answer = move |r: &AccountRef| {
        let (gg, gd, c, r) = (gg.clone(), gd.clone(), c.clone(), r.clone());
        async move {
            if r.provider == "claude" && gd.load(Ordering::SeqCst) {
                pass(&gg).await;
            }
            let mut u = ProviderUsage::new(&r.id, provider_of(&r), Status::Ok, c.now(), Source::Live);
            u.windows.push(UsageWindow { id: WindowId::FiveHour, used_percent: 10.0, resets_at: 0.0 });
            FetchResult { usage: u, retry_after_ms: None, failed: false }
        }
        .boxed()
    };
    let s = UsageService::new(f.legacy(f.options(main_accounts, answer)));
    let first = s.refresh(false, false, None);
    let second = s.refresh(false, false, None);
    settle().await;
    assert_eq!(f.count("claude:main"), 1);
    g.add_permits(1);
    futures::join!(first, second);
    s.refresh(false, false, None).await;
    assert_eq!(f.count("claude:main"), 1);
    advance(MIN_GAP_MS as u64 + 1).await;
    gated.store(false, Ordering::SeqCst);
    s.refresh(false, false, None).await;
    assert_eq!(f.count("claude:main"), 2);

    // Forced callers during a run share one follow-up.
    gated.store(true, Ordering::SeqCst);
    advance(MIN_GAP_MS as u64 + 1).await;
    let first = s.refresh(false, false, None);
    let forced_a = s.refresh(true, true, None);
    let forced_b = s.refresh(true, true, None);
    settle().await;
    assert_eq!(f.count("claude:main"), 3);
    g.add_permits(1);
    first.await;
    settle().await;
    assert_eq!(f.count("claude:main"), 4);
    g.add_permits(1);
    futures::join!(forced_a, forced_b);
    assert_eq!(f.count("claude:main"), 4);
}

/// "keeps the last numbers when a read fails and backs off exponentially"
#[tokio::test(start_paused = true)]
async fn keeps_the_last_numbers_on_a_failure_and_backs_off_exponentially() {
    let f = Fx::new();
    let step = Arc::new(AtomicUsize::new(0));
    let (st, c) = (step.clone(), f.clock.clone());
    let answer = move |r: &AccountRef| {
        let mut u = ProviderUsage::new(&r.id, provider_of(r), Status::Ok, c.now(), Source::Live);
        if r.provider == "claude" && st.fetch_add(1, Ordering::SeqCst) > 0 {
            u.status = Status::Error;
            u.error = Some("http-500".into());
        } else {
            u.windows.push(UsageWindow { id: WindowId::FiveHour, used_percent: 55.0, resets_at: 0.0 });
        }
        ready(FetchResult { usage: u, retry_after_ms: None, failed: false })
    };
    let s = UsageService::new(f.legacy(f.options(main_accounts, answer)));
    s.refresh(false, false, None).await;
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(false, false, None).await;
    let kept = s.state().providers[0].clone();
    assert_eq!((kept.status, kept.error.as_deref(), kept.source), (Status::Error, Some("http-500"), Source::Cache));
    assert_eq!(kept.windows[0].used_percent, 55.0);
    assert_eq!(f.count("claude:main"), 2);
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(false, false, None).await;
    assert_eq!(f.count("claude:main"), 2);
    advance(60_000).await;
    s.refresh(false, false, None).await;
    assert_eq!(f.count("claude:main"), 3);
    advance(60_001).await;
    s.refresh(false, false, None).await;
    assert_eq!(f.count("claude:main"), 3);
}

/// "honours Retry-After and clears the backoff after a success", "keeps the last good numbers on a 429 and tells the card
/// when it tries again", "lets a manual refresh bypass a backoff but not the minimum gap"
#[tokio::test(start_paused = true)]
async fn retry_after_a_429_card_and_the_manual_bypass_of_an_error_backoff() {
    let f = Arc::new(Fx::new());
    let mode = Arc::new(Mutex::new("limited"));
    let (m, fx) = (mode.clone(), f.clone());
    let answer = move |r: &AccountRef| {
        ready(match (r.provider.as_str(), *m.lock()) {
            ("claude", "limited") => fx.failing(Provider::Claude, Status::Error, Some(300_000.0), &r.id),
            ("claude", "429") => fx.error(&r.id, "http-429", Some(600_000.0)),
            _ => fx.ok(provider_of(r), 20.0, &r.id),
        })
    };
    let s = UsageService::new(f.legacy(f.options(main_accounts, answer)));
    s.refresh(false, false, None).await;
    advance(120_000).await;
    s.refresh(false, false, None).await;
    assert_eq!(f.count("claude:main"), 1);
    *mode.lock() = "fine";
    advance(181_000).await;
    s.refresh(false, false, None).await;
    assert_eq!(f.count("claude:main"), 2);
    assert_eq!(s.state().providers[0].status, Status::Ok);
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(false, false, None).await;
    assert_eq!(f.count("claude:main"), 3);

    // A 429: the good numbers stay, with when it was tried and when it is tried again.
    let good = s.state().providers[0].clone();
    *mode.lock() = "429";
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(true, false, None).await;
    let held = s.state().providers[0].clone();
    assert_eq!((held.status, held.error.as_deref(), held.source), (Status::Error, Some("http-429"), Source::Cache));
    assert_eq!((held.fetched_at, &held.windows), (good.fetched_at, &good.windows));
    assert_eq!((held.attempt_at, held.retry_at), (Some(f.now()), Some(f.now() + 600_000.0)));

    // An error backoff: the refresh button goes through it, never through the minimum gap.
    let f = Arc::new(Fx::new());
    let fx = f.clone();
    let s = UsageService::new(f.legacy(f.options(main_accounts, move |r: &AccountRef| {
        ready(if r.provider == "claude" {
            fx.failing(Provider::Claude, Status::Error, Some(600_000.0), &r.id)
        } else {
            fx.ok(Provider::Codex, 1.0, &r.id)
        })
    })));
    s.refresh(false, false, None).await;
    assert_eq!(f.count("claude:main"), 1);
    s.refresh(true, false, None).await;
    assert_eq!(f.count("claude:main"), 1);
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(false, false, None).await;
    assert_eq!(f.count("claude:main"), 1);
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(true, false, None).await;
    assert_eq!(f.count("claude:main"), 2);
}

/// "does not keep an old failure when the numbers come back from the cache file after a restart", "ignores a corrupt cache
/// file", "loads a cache with garbage window entries and keeps only the valid ones", "ignores cache entries from an older
/// file without an account id"
#[tokio::test(start_paused = true)]
async fn a_loaded_cache_keeps_only_valid_numbers_and_no_old_failure() {
    let f = Fx::new();
    let mut failed = f.ok(Provider::Claude, 100.0, "claude:main").usage.to_value();
    failed["status"] = json!("error");
    failed["error"] = json!("http-429");
    failed["attemptAt"] = json!(NOW);
    failed["retryAt"] = json!(NOW + 1000.0);
    f.write_cache(&json!({ "providers": [failed] }));
    let loaded = make(&f).state().providers[0].clone();
    assert_eq!((loaded.status, loaded.source), (Status::Ok, Source::Cache));
    assert_eq!((loaded.error, loaded.retry_at, loaded.attempt_at), (None, None, None));

    std::fs::write(&f.cache, "{broken").unwrap();
    assert!(make(&f).state().providers.is_empty());

    f.write_cache(&json!({ "providers": [
        null, "x",
        { "accountId": "claude:main", "provider": "claude", "status": "error", "source": "live", "fetchedAt": 5, "token": "SECRET-123",
          "windows": [null, 7, { "id": "5h", "usedPercent": "a", "resetsAt": 1 }, { "id": "9h", "usedPercent": 1, "resetsAt": 1 },
                      { "id": "7d", "usedPercent": 250, "resetsAt": 10 }] },
        { "accountId": "codex:main", "provider": "codex", "status": "ok", "source": "live", "fetchedAt": 5, "windows": [null] },
    ] }));
    let providers = make(&f).state().providers;
    assert_eq!(providers.len(), 1);
    assert_eq!((providers[0].provider, providers[0].status, providers[0].source), (Provider::Claude, Status::Ok, Source::Cache));
    assert_eq!(providers[0].windows, [UsageWindow { id: WindowId::SevenDay, used_percent: 100.0, resets_at: 10.0 }]);
    assert!(!s_json(&providers).contains("SECRET-123"));

    f.write_cache(&json!({ "providers": [{ "provider": "claude", "status": "ok", "source": "live", "fetchedAt": 5,
        "windows": [{ "id": "5h", "usedPercent": 3, "resetsAt": 10 }] }] }));
    assert!(make(&f).state().providers.is_empty());
}

fn s_json(p: &[ProviderUsage]) -> String {
    Value::Array(p.iter().map(ProviderUsage::to_value).collect()).to_string()
}

/// "keeps the numbers of an expired login and does not hammer the provider", "replaces the entry when a login disappears and
/// refreshes numbers when an expired login returns", "stores an expired result that carries its own log windows as given
/// and starts no backoff"
#[tokio::test(start_paused = true)]
async fn expired_and_signed_out_logins_and_log_windows() {
    let f = Arc::new(Fx::new());
    let mode = Arc::new(Mutex::new("ok"));
    let (m, fx) = (mode.clone(), f.clone());
    let log = UsageWindow { id: WindowId::FiveHour, used_percent: 21.0, resets_at: 1_781_010_642.0 };
    let answer = move |r: &AccountRef| {
        let mode = *m.lock();
        ready(match (r.provider.as_str(), mode) {
            ("claude", "out") => {
                FetchResult { usage: fx.usage(Provider::Claude, &r.id, Status::SignedOut), retry_after_ms: None, failed: false }
            }
            ("codex", "expired") => fx.failing(Provider::Codex, Status::Expired, None, &r.id),
            ("codex", "back") => fx.ok(Provider::Codex, 12.0, &r.id),
            ("codex", "log") => {
                let mut u = ProviderUsage::new(&r.id, Provider::Codex, Status::Expired, 5.0, Source::Log);
                u.windows.push(log);
                FetchResult { usage: u, retry_after_ms: None, failed: false }
            }
            ("codex", _) => fx.ok(Provider::Codex, 33.0, &r.id),
            _ => fx.ok(Provider::Claude, 40.0, &r.id),
        })
    };
    let s = UsageService::new(f.legacy(f.options(main_accounts, answer)));
    s.refresh(false, false, None).await;
    *mode.lock() = "out";
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(false, false, None).await;
    let p = &s.state().providers[0];
    assert_eq!((p.status, p.windows.len()), (Status::SignedOut, 0));
    *mode.lock() = "expired";
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(false, false, None).await;
    let p = &s.state().providers[1];
    assert_eq!((p.status, p.source, p.windows[0].used_percent), (Status::Expired, Source::Cache, 33.0));
    *mode.lock() = "back";
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(false, false, None).await;
    let p = &s.state().providers[1];
    assert_eq!((p.status, p.source, p.windows[0].used_percent), (Status::Ok, Source::Live, 12.0));
    // An expired answer with its own (log) windows is stored as given, and starts no backoff.
    *mode.lock() = "log";
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(false, false, None).await;
    let p = s.state().providers[1].clone();
    assert_eq!((p.status, p.source, p.fetched_at, p.windows), (Status::Expired, Source::Log, 5.0, vec![log]));
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(false, false, None).await;
    assert_eq!(f.count("codex:main"), 6);
}

/// "survives a fetcher that throws"
#[tokio::test(start_paused = true)]
async fn survives_a_fetcher_that_panics() {
    let f = Fx::new();
    let fx_ok = f.ok(Provider::Codex, 8.0, "codex:main");
    let s = UsageService::new(f.legacy(f.options(main_accounts, move |r: &AccountRef| {
        if r.provider == "claude" { async { panic!("unexpected") }.boxed() } else { ready(fx_ok.clone()) }
    })));
    s.refresh(false, false, None).await;
    let p = &s.state().providers[0];
    assert_eq!(
        (p.account_id.as_str(), p.provider, p.status, p.error.as_deref()),
        ("claude:main", Provider::Claude, Status::Error, Some("network"))
    );
    // The service is not stuck: the next run reads again.
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(true, false, None).await;
    assert_eq!(f.count("claude:main"), 2);
}

/// "remembers the last good result on disk and shows it as cached after a restart", "never lets unknown fields from a
/// fetcher reach state, listeners or the cache file" (a ProviderUsage has no place for an unknown field; every result and
/// cache entry goes through sanitize)
#[tokio::test(start_paused = true)]
async fn remembers_the_last_good_result_on_disk_and_shows_it_as_cached() {
    let f = Fx::new();
    let heard = Arc::new(Mutex::new(String::new()));
    let s = make(&f);
    let h = heard.clone();
    s.on_change(Arc::new(move |state| h.lock().push_str(&state.to_value().to_string())));
    s.refresh(false, false, None).await;
    assert!(f.cache.exists());
    assert!(heard.lock().contains("\"usedPercent\":40"));
    assert_eq!(s.state().providers[0].windows[0].used_percent, 40.0);
    let second = UsageService::new(f.options(main_accounts, |_| futures::future::pending().boxed()));
    let shown: Vec<_> = second.state().providers.iter().map(|p| (p.provider, p.source, p.status)).collect();
    assert_eq!(shown, [(Provider::Claude, Source::Cache, Status::Ok), (Provider::Codex, Source::Cache, Status::Ok)]);
}

/// "backs off after a failed read even when another source answered, and clears it on success"
#[tokio::test(start_paused = true)]
async fn backs_off_after_a_failed_read_although_the_log_answered() {
    let f = Arc::new(Fx::new());
    let fine = Arc::new(AtomicBool::new(false));
    let (fi, fx) = (fine.clone(), f.clone());
    let s = UsageService::new(f.legacy(f.options(main_accounts, move |r: &AccountRef| {
        let mut res = fx.ok(provider_of(r), if fi.load(Ordering::SeqCst) { 31.0 } else { 30.0 }, &r.id);
        if r.provider == "codex" && !fi.load(Ordering::SeqCst) {
            res.usage.source = Source::Log;
            res.failed = true;
            res.retry_after_ms = Some(300_000.0);
        }
        ready(res)
    })));
    s.refresh(false, false, None).await;
    let p = &s.state().providers[1];
    assert_eq!((p.status, p.source), (Status::Ok, Source::Log));
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(false, false, None).await;
    assert_eq!(f.count("codex:main"), 1);
    fine.store(true, Ordering::SeqCst);
    advance(300_000).await;
    s.refresh(false, false, None).await;
    assert_eq!(f.count("codex:main"), 2);
    let p = &s.state().providers[1];
    assert_eq!((p.status, p.source), (Status::Ok, Source::Live));
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(false, false, None).await;
    assert_eq!(f.count("codex:main"), 3);
}

/// "pauses while inactive and catches up when active again with stale data"
#[tokio::test(start_paused = true)]
async fn pauses_while_inactive_and_catches_up() {
    let f = Fx::new();
    let s = UsageService::new(UsageOptions { interval_ms: Arc::new(|| 60_000.0), ..make_opts(&f) });
    s.start();
    settle().await;
    s.set_active(false);
    advance(300_000).await;
    assert_eq!(f.count("claude:main"), 1);
    s.set_active(true);
    settle().await;
    assert_eq!(f.count("claude:main"), 2);
    s.set_active(true);
    settle().await;
    assert_eq!(f.count("claude:main"), 2);
    s.stop();
}

/// "gives up on a read that never settles and keeps polling"
#[tokio::test(start_paused = true)]
async fn gives_up_on_a_read_that_never_settles_and_keeps_polling() {
    let f = Arc::new(Fx::new());
    let hang = Arc::new(AtomicBool::new(true));
    let (h, fx) = (hang.clone(), f.clone());
    let s = UsageService::new(UsageOptions {
        interval_ms: Arc::new(|| 60_000.0),
        ..f.legacy(f.options(main_accounts, move |r: &AccountRef| {
            if r.provider == "claude" && h.load(Ordering::SeqCst) {
                futures::future::pending().boxed()
            } else {
                ready(fx.ok(provider_of(r), 12.0, &r.id))
            }
        }))
    });
    s.start();
    settle().await;
    advance(30_000).await;
    let p = &s.state().providers[0];
    assert_eq!((p.provider, p.status, p.error.as_deref()), (Provider::Claude, Status::Error, Some("timeout")));
    hang.store(false, Ordering::SeqCst);
    advance(30_000).await;
    assert_eq!(f.count("claude:main"), 2);
    assert_eq!(s.state().providers[0].status, Status::Ok);
    s.stop();
}

/// "is not disturbed by a listener that throws"
#[tokio::test(start_paused = true)]
async fn is_not_disturbed_by_a_listener_that_panics() {
    let f = Fx::new();
    let s = make(&f);
    let heard = Arc::new(Mutex::new(Vec::new()));
    s.on_change(Arc::new(|_| panic!("bad listener")));
    let h = heard.clone();
    s.on_change(Arc::new(move |state| h.lock().push(state.providers.len())));
    let state = s.refresh(false, false, None).await;
    assert_eq!(state.providers.len(), 2);
    assert_eq!(*heard.lock(), [2]);
}

// ---- accounts ---------------------------------------------------------------------------------------------------------

fn extra() -> AccountRef {
    saved_ref("claude:abc", None, "/profiles/abc", None)
}

/// "polls every listed account and returns them in accounts() order", "shows a newly added account after the next
/// refresh", "backs off per account id"
#[tokio::test(start_paused = true)]
async fn polls_every_listed_account_in_order_adds_new_ones_and_backs_off_per_account() {
    let f = Arc::new(Fx::new());
    let fx = f.clone();
    let s = UsageService::new(f.legacy(f.options(
        || [vec![extra()], main_accounts()].concat(),
        move |r: &AccountRef| ready(fx.ok(provider_of(r), if r.id == "claude:abc" { 71.0 } else { 5.0 }, &r.id)),
    )));
    s.refresh(false, false, None).await;
    assert_eq!(f.total(), 3);
    let want: Vec<(String, f64)> =
        [("claude:abc", 71.0), ("claude:main", 5.0), ("codex:main", 5.0)].iter().map(|(a, b)| (a.to_string(), *b)).collect();
    assert_eq!(percents(&s), want);

    let f = Arc::new(Fx::new());
    let list = Arc::new(Mutex::new(main_accounts()));
    let (l, fx) = (list.clone(), f.clone());
    let s = UsageService::new(
        f.legacy(f.options(move || l.lock().clone(), move |r: &AccountRef| ready(fx.ok(provider_of(r), 9.0, &r.id)))),
    );
    s.refresh(false, false, None).await;
    list.lock().push(extra());
    assert_eq!(s.state().providers.len(), 2);
    s.refresh(false, true, None).await;
    let ids: Vec<String> = s.state().providers.iter().map(|p| p.account_id.clone()).collect();
    assert_eq!(ids, ["claude:main", "codex:main", "claude:abc"]);

    let f = Arc::new(Fx::new());
    let fx = f.clone();
    let s = UsageService::new(f.legacy(f.options(
        || [vec![extra()], main_accounts()].concat(),
        move |r: &AccountRef| {
            ready(if r.id == "claude:abc" {
                fx.failing(Provider::Claude, Status::Error, Some(600_000.0), &r.id)
            } else {
                fx.ok(provider_of(r), 9.0, &r.id)
            })
        },
    )));
    s.refresh(false, false, None).await;
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(false, false, None).await;
    assert_eq!((f.count("claude:abc"), f.count("claude:main"), f.count("codex:main")), (1, 2, 2));
}

/// "drops a removed account from state, the next cache write and a result still in flight"
#[tokio::test(start_paused = true)]
async fn drops_a_removed_account_from_state_the_cache_and_a_result_in_flight() {
    let f = Arc::new(Fx::new());
    let list = Arc::new(Mutex::new([main_accounts(), vec![extra()]].concat()));
    let g = gate();
    let slow = Arc::new(AtomicBool::new(false));
    let (l, fx, gg, sl) = (list.clone(), f.clone(), g.clone(), slow.clone());
    let s = UsageService::new(f.legacy(f.options(
        move || l.lock().clone(),
        move |r: &AccountRef| {
            let (fx, gg, r, slow) = (fx.clone(), gg.clone(), r.clone(), sl.load(Ordering::SeqCst));
            async move {
                if r.id == "claude:abc" && slow {
                    pass(&gg).await;
                    return fx.ok(Provider::Claude, 99.0, &r.id);
                }
                fx.ok(provider_of(&r), 9.0, &r.id)
            }
            .boxed()
        },
    )));
    s.refresh(false, false, None).await;
    assert_eq!(s.state().providers.len(), 3);
    assert!(f.cache_text().contains("claude:abc"));
    slow.store(true, Ordering::SeqCst);
    advance(MIN_GAP_MS as u64 + 1).await;
    let run = s.refresh(false, false, None);
    settle().await;
    assert_eq!(f.count("claude:abc"), 2);
    *list.lock() = main_accounts();
    let ids = |s: &UsageService| s.state().providers.iter().map(|p| p.account_id.clone()).collect::<Vec<_>>();
    assert_eq!(ids(&s), ["claude:main", "codex:main"]);
    g.add_permits(1);
    run.await;
    assert_eq!(ids(&s), ["claude:main", "codex:main"]);
    assert!(!f.cache_text().contains("claude:abc"));
}

/// "ignores the minimum gap only when forced, and shares one follow-up run for forced callers during a run"
#[tokio::test(start_paused = true)]
async fn ignores_the_minimum_gap_only_when_forced() {
    let f = Arc::new(Fx::new());
    let g = gate();
    let gated = Arc::new(AtomicBool::new(false));
    let (gg, gd, fx) = (g.clone(), gated.clone(), f.clone());
    let s = UsageService::new(f.legacy(f.options(main_accounts, move |r: &AccountRef| {
        let (gg, fx, r, wait) = (gg.clone(), fx.clone(), r.clone(), gd.load(Ordering::SeqCst) && r.provider == "claude");
        async move {
            if wait {
                pass(&gg).await;
            }
            fx.ok(provider_of(&r), 1.0, &r.id)
        }
        .boxed()
    })));
    s.refresh(false, false, None).await;
    s.refresh(false, false, None).await;
    assert_eq!(f.count("claude:main"), 1);
    s.refresh(false, true, None).await;
    assert_eq!(f.count("claude:main"), 2);
    gated.store(true, Ordering::SeqCst);
    let a = s.refresh(false, true, None);
    let b = s.refresh(false, true, None);
    settle().await;
    assert_eq!(f.count("claude:main"), 3);
    g.add_permits(1);
    a.await;
    settle().await;
    assert_eq!(f.count("claude:main"), 4);
    g.add_permits(1);
    b.await;
}

// ---- dormant main login, beforeRun, watchLive ---------------------------------------------------------------------

/// "keeps the last windows with their age and starts no backoff"
#[tokio::test(start_paused = true)]
async fn a_dormant_login_keeps_the_last_windows_with_their_age_and_starts_no_backoff() {
    let f = Arc::new(Fx::new());
    let step = Arc::new(AtomicUsize::new(0));
    let (st, fx) = (step.clone(), f.clone());
    let s = UsageService::new(f.legacy(f.options(main_accounts, move |r: &AccountRef| {
        ready(if r.provider == "claude" && st.fetch_add(1, Ordering::SeqCst) > 0 {
            let mut u = fx.usage(Provider::Claude, &r.id, Status::Dormant);
            u.plan = Some("Max 5x".into());
            FetchResult { usage: u, retry_after_ms: None, failed: false }
        } else {
            fx.ok(provider_of(r), 40.0, &r.id)
        })
    })));
    s.refresh(false, false, None).await;
    let first_at = s.state().providers[0].fetched_at;
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(false, false, None).await;
    let p = s.state().providers[0].clone();
    assert_eq!((p.status, p.source, p.fetched_at, p.windows[0].used_percent), (Status::Dormant, Source::Cache, first_at, 40.0));
    advance(MIN_GAP_MS as u64 + 1).await;
    s.refresh(false, false, None).await;
    assert_eq!(f.count("claude:main"), 3);
}

fn stamped(f: &Fx, o: UsageOptions, stamp: Arc<Mutex<String>>, stats: Arc<AtomicUsize>, live: bool) -> UsageOptions {
    let _ = f;
    UsageOptions {
        interval_ms: Arc::new(|| 3_600_000.0),
        credentials_stamp: Some(Arc::new(move |_: &AccountRef| {
            stats.fetch_add(1, Ordering::SeqCst);
            Some(stamp.lock().clone())
        })),
        watch: Duration::from_secs(20),
        watch_live: live,
        ..o
    }
}

/// "refreshes at once when the credentials file changes, polling only while dormant"
#[tokio::test(start_paused = true)]
async fn a_changed_credentials_file_refreshes_at_once_and_is_watched_only_while_dormant() {
    let f = Arc::new(Fx::new());
    let renewed = Arc::new(AtomicBool::new(false));
    let (rn, fx) = (renewed.clone(), f.clone());
    let o = f.legacy(f.options(
        || vec![main_accounts().remove(0)],
        move |r: &AccountRef| {
            ready(if rn.load(Ordering::SeqCst) {
                fx.ok(Provider::Claude, 12.0, &r.id)
            } else {
                FetchResult { usage: fx.usage(Provider::Claude, &r.id, Status::Dormant), retry_after_ms: None, failed: false }
            })
        },
    ));
    let stamp = Arc::new(Mutex::new("a".to_string()));
    let stats = Arc::new(AtomicUsize::new(0));
    let s = UsageService::new(stamped(&f, o, stamp.clone(), stats.clone(), false));
    s.start();
    settle().await;
    assert_eq!(s.state().providers[0].status, Status::Dormant);
    let before = stats.load(Ordering::SeqCst);
    advance(20_000).await;
    assert_eq!(f.total(), 1, "an unchanged file reads nothing");
    assert!(stats.load(Ordering::SeqCst) > before);
    *stamp.lock() = "b".into();
    renewed.store(true, Ordering::SeqCst);
    advance(20_000).await;
    assert_eq!(f.total(), 2);
    let p = &s.state().providers[0];
    assert_eq!((p.status, p.source), (Status::Ok, Source::Live));
    let after = stats.load(Ordering::SeqCst);
    advance(60_000).await;
    assert_eq!(stats.load(Ordering::SeqCst), after, "no longer dormant: watching stopped");
    s.stop();
}

/// "runs beforeRun before every poll and survives it throwing"
#[tokio::test(start_paused = true)]
async fn runs_before_run_before_every_poll_and_survives_it_panicking() {
    let f = Fx::new();
    let order = Arc::new(Mutex::new(Vec::<&str>::new()));
    let (o1, o2) = (order.clone(), order.clone());
    let c = f.clock.clone();
    let mut o = f.legacy(f.options(
        || vec![main_accounts().remove(0)],
        move |r: &AccountRef| {
            o1.lock().push("fetch");
            let mut u = ProviderUsage::new(&r.id, Provider::Claude, Status::Ok, c.now(), Source::Live);
            u.windows.push(UsageWindow { id: WindowId::FiveHour, used_percent: 1.0, resets_at: 0.0 });
            ready(FetchResult { usage: u, retry_after_ms: None, failed: false })
        },
    ));
    o.interval_ms = Arc::new(|| 0.0);
    o.before_run = Some(Arc::new(move || {
        let order = o2.clone();
        async move {
            order.lock().push("before");
            if order.lock().len() > 2 {
                panic!("x");
            }
        }
        .boxed()
    }));
    let s = UsageService::new(o);
    s.refresh(true, true, None).await;
    s.refresh(true, true, None).await;
    assert_eq!(*order.lock(), ["before", "fetch", "before", "fetch"]);
}

/// "watchLive: a changed live credentials file triggers a poll even when the login is fine"
#[tokio::test(start_paused = true)]
async fn watch_live_a_changed_live_file_triggers_a_poll() {
    let f = Arc::new(Fx::new());
    let fx = f.clone();
    let o = f
        .legacy(f.options(|| vec![main_accounts().remove(0)], move |r: &AccountRef| ready(fx.ok(Provider::Claude, 10.0, &r.id))));
    let stamp = Arc::new(Mutex::new("a".to_string()));
    let s = UsageService::new(stamped(&f, o, stamp.clone(), Arc::default(), true));
    s.start();
    advance(100).await;
    let calls = f.total();
    *stamp.lock() = "b".into();
    advance(25_000).await;
    assert_eq!(f.total(), calls + 1);
    s.stop();
}

// ---- a held account across a restart --------------------------------------------------------------------------------

fn held_saved() -> AccountRef {
    saved_ref("claude:abc", None, "/tmp/ajza-profile", None)
}

/// "does not try again right after a restart and shows the same calm card until the window passes"
#[tokio::test(start_paused = true)]
async fn a_held_account_is_not_tried_again_right_after_a_restart() {
    let f = Arc::new(Fx::new());
    let fx = f.clone();
    let limited = Arc::new(AtomicBool::new(true));
    let li = limited.clone();
    let build = |f: &Fx| {
        let (fx, li) = (fx.clone(), li.clone());
        UsageService::new(UsageOptions {
            interval_ms: Arc::new(|| 60_000.0),
            ..f.legacy(f.options(
                || vec![held_saved()],
                move |r: &AccountRef| {
                    ready(if li.load(Ordering::SeqCst) {
                        let mut res = fx.error(&r.id, "refresh-http-429", Some(900_000.0));
                        res.usage.managed = Some(true);
                        res
                    } else {
                        fx.ok(Provider::Claude, 10.0, &r.id)
                    })
                },
            ))
        })
    };
    let before = build(&f);
    before.refresh(false, false, None).await;
    assert_eq!(f.total(), 1);
    let p = &before.state().providers[0];
    assert_eq!((p.status, p.error.as_deref(), p.retry_at), (Status::Error, Some("refresh-http-429"), Some(NOW + 900_000.0)));
    let stored = &f.cache_json()["backoff"]["claude:abc"];
    assert_eq!((stored["until"].as_f64(), stored["failures"].as_f64()), (Some(NOW + 900_000.0), Some(1.0)));
    assert_eq!((&stored["error"], stored["attemptAt"].as_f64()), (&json!("refresh-http-429"), Some(NOW)));
    drop(before);

    advance(120_000).await;
    limited.store(false, Ordering::SeqCst);
    let after = build(&f);
    after.start();
    settle().await;
    assert_eq!(f.total(), 1);
    let p = after.state().providers[0].clone();
    assert_eq!(
        (p.account_id.as_str(), p.status, p.error.as_deref(), p.managed),
        ("claude:abc", Status::Error, Some("refresh-http-429"), Some(true))
    );
    assert_eq!((p.retry_at, p.attempt_at), (Some(NOW + 900_000.0), Some(NOW)));
    advance(900_000).await;
    assert_eq!(f.total(), 2);
    assert_eq!(after.state().providers[0].status, Status::Ok);
    after.stop();
}

/// "keeps the last numbers on the restored card and ignores damaged or finished backoff entries"
#[tokio::test(start_paused = true)]
async fn the_restored_held_card_keeps_its_numbers_and_damaged_holds_are_ignored() {
    let f = Arc::new(Fx::new());
    f.write_cache(&json!({
        "providers": [{ "accountId": "claude:abc", "provider": "claude", "status": "ok", "windows": [{ "id": "7d", "usedPercent": 100, "resetsAt": 1 }], "fetchedAt": NOW - 600_000.0, "source": "live" }],
        "backoff": {
            "claude:abc": { "until": NOW + 60_000.0, "failures": 2, "error": "refresh-http-429", "attemptAt": NOW - 1000.0 },
            "old": { "until": NOW - 1.0, "failures": 1 }, "bad": { "until": "x", "failures": 1 }, "evil": { "until": NOW + 5.0, "failures": 1, "error": "<script>" },
        },
    }));
    let fx = f.clone();
    let s = UsageService::new(
        f.legacy(f.options(|| vec![held_saved()], move |r: &AccountRef| ready(fx.ok(Provider::Claude, 1.0, &r.id)))),
    );
    {
        let g = s.inner.lock();
        assert!(!g.legacy_hold.contains_key("old") && !g.legacy_hold.contains_key("bad"));
        assert_eq!(g.legacy_hold.get("evil").map(|h| h.error.clone()), Some(None));
    }
    s.refresh(false, false, None).await;
    assert_eq!(f.total(), 0);
    let p = s.state().providers[0].clone();
    assert_eq!((p.status, p.error.as_deref(), p.source), (Status::Error, Some("refresh-http-429"), Source::Cache));
    assert_eq!((p.windows[0].id, p.windows[0].used_percent), (WindowId::SevenDay, 100.0));
}

// ---- usage keyed by account identity (W1) ---------------------------------------------------------------------------

/// "never shows the previous account's numbers or backoff on the main card after a switch (investigation test 7)", "reads
/// an account again when it moved between the live login and a saved profile (another copy of its sign-in)"
#[tokio::test(start_paused = true)]
async fn a_switch_never_shows_the_previous_accounts_numbers_and_a_moved_account_is_read_again() {
    let f = Arc::new(Fx::new());
    let listed = Arc::new(Mutex::new(vec![live_ref("claude:main", "uuid:A:-")]));
    let (l, fx) = (listed.clone(), f.clone());
    let answer = move |r: &AccountRef| {
        ready(if r.key.as_deref() == Some("uuid:A:-") {
            fx.ok(Provider::Claude, 40.0, &r.id)
        } else {
            fx.failing(Provider::Claude, Status::Error, None, &r.id)
        })
    };
    let s =
        UsageService::new(UsageOptions { interval_ms: Arc::new(|| 0.0), ..f.options(move || l.lock().clone(), answer.clone()) });
    s.refresh(true, true, None).await;
    assert_eq!(s.state().providers[0].windows[0].used_percent, 40.0);
    *listed.lock() = vec![live_ref("claude:main", "uuid:G:-"), saved_ref("claude:a", Some("uuid:A:-"), "/a", None)];
    s.refresh(true, true, None).await;
    let st = s.state().providers;
    assert_eq!((st[0].account_id.as_str(), st[0].status, st[0].windows.len()), ("claude:main", Status::Error, 0));
    assert_eq!((st[1].account_id.as_str(), st[1].windows[0].used_percent, st[1].active), ("claude:a", 40.0, false));
    assert_eq!(f.count_key("uuid:A:-"), 2, "the account moved from the live login to a profile: read again");
    let again = UsageService::new(f.options(|| vec![live_ref("claude:main", "uuid:A:-")], answer.clone()));
    let p = &again.state().providers[0];
    assert_eq!((p.source, p.windows[0].used_percent), (Source::Cache, 40.0));
    let other = UsageService::new(f.options(|| vec![live_ref("claude:main", "uuid:G:-")], answer.clone()));
    assert!(other.state().providers.first().is_none_or(|p| p.windows.is_empty()));

    // Moved again within its spacing as the same copy: not read again.
    let f = Arc::new(Fx::new());
    let listed = Arc::new(Mutex::new(vec![live_ref("claude:main", "uuid:A:-")]));
    let (l, fx) = (listed.clone(), f.clone());
    let s =
        UsageService::new(f.options(move || l.lock().clone(), move |r: &AccountRef| ready(fx.ok(Provider::Claude, 10.0, &r.id))));
    s.refresh(true, true, None).await;
    advance(30_000).await;
    *listed.lock() = vec![live_ref("claude:main", "uuid:G:-"), saved_ref("claude:a", Some("uuid:A:-"), "/a", None)];
    s.refresh(true, true, None).await;
    assert_eq!(f.count_key("uuid:A:-"), 2);
    advance(30_000).await;
    s.refresh(true, true, None).await;
    assert_eq!(f.count_key("uuid:A:-"), 2);
}

/// "reads one account at most every 3 minutes, also when forced, unless the action was about it (investigation test 8)",
/// "keeps a short read guard across a restart (1.1.1: the start read ignores older reads, see usage-restart.test.ts)"
#[tokio::test(start_paused = true)]
async fn one_read_per_account_every_3_minutes_unless_it_is_the_subject_and_a_short_guard_across_a_restart() {
    let f = Arc::new(Fx::new());
    let fx = f.clone();
    let answer = move |r: &AccountRef| ready(fx.ok(Provider::Claude, 10.0, &r.id));
    let s = UsageService::new(f.options(|| vec![live_ref("claude:main", "uuid:A:-")], answer.clone()));
    s.refresh(true, true, None).await;
    advance(60_000).await;
    s.refresh(true, true, None).await;
    assert_eq!(f.total(), 1);
    s.refresh(true, true, Some("claude:main")).await;
    assert_eq!(f.total(), 2);
    advance(MIN_IDENTITY_GAP_MS as u64).await;
    s.refresh(true, true, None).await;
    assert_eq!(f.total(), 3);

    let f = Arc::new(Fx::new());
    let fx = f.clone();
    let answer = move |r: &AccountRef| ready(fx.ok(Provider::Claude, 10.0, &r.id));
    UsageService::new(f.options(|| vec![live_ref("claude:main", "uuid:A:-")], answer.clone())).refresh(true, true, None).await;
    advance(EAGER_GUARD_MS as u64 - 1_000).await;
    UsageService::new(f.options(|| vec![live_ref("claude:main", "uuid:A:-")], answer)).refresh(true, true, None).await;
    assert_eq!(f.total(), 1);
}

/// "never bypasses a 429 hold of an unrelated account and adds a margin to Retry-After", "adds the margin only to a 429 of
/// the usage endpoint, not to a rate-limited token renewal (F23)", "adds the margin to a usage 429 without Retry-After too"
#[tokio::test(start_paused = true)]
async fn the_retry_after_margin_and_a_429_hold_of_an_unrelated_account() {
    let f = Arc::new(Fx::new());
    let fx = f.clone();
    let saved = saved_ref("claude:abc", Some("uuid:B:-"), "/p", None);
    let sv = saved.clone();
    let s = UsageService::new(UsageOptions {
        min_identity_gap_ms: 0.0,
        ..f.options(
            move || vec![live_ref("claude:main", "uuid:A:-"), sv.clone()],
            move |r: &AccountRef| {
                ready(if r.key.as_deref() == Some("uuid:B:-") {
                    fx.error(&r.id, "http-429", Some(46.0 * 60_000.0))
                } else {
                    fx.ok(Provider::Claude, 10.0, &r.id)
                })
            },
        )
    });
    s.refresh(true, true, None).await;
    let retry = s.state().providers.iter().find(|p| p.account_id == "claude:abc").unwrap().retry_at;
    assert_eq!(retry, Some(f.now() + 46.0 * 60_000.0 + RETRY_AFTER_MARGIN_MS));
    s.refresh(true, true, Some("claude:main")).await;
    advance(21_000).await;
    s.refresh(true, false, None).await;
    assert_eq!(f.count_key("uuid:B:-"), 1);

    let f = Arc::new(Fx::new());
    let fx = f.clone();
    let s = UsageService::new(
        f.options(move || vec![saved.clone()], move |r: &AccountRef| ready(fx.error(&r.id, "refresh-http-429", Some(600_000.0)))),
    );
    s.refresh(true, true, None).await;
    assert_eq!(s.state().providers[0].retry_at, Some(f.now() + 600_000.0));

    let f = Arc::new(Fx::new());
    let fx = f.clone();
    let s = UsageService::new(
        f.options(|| vec![live_ref("claude:main", "uuid:A:-")], move |r: &AccountRef| ready(fx.error(&r.id, "http-429", None))),
    );
    s.refresh(true, true, None).await;
    assert_eq!(s.state().providers[0].retry_at, Some(NOW + 60_000.0 + RETRY_AFTER_MARGIN_MS));
}

/// "sends the account notices along with the state", "sends the state of the saved accounts file and the set-aside cards
/// along with the state, only when there is any"
#[tokio::test(start_paused = true)]
async fn sends_the_notices_and_the_accounts_info_along_with_the_state() {
    let f = Arc::new(Fx::new());
    let fx = f.clone();
    let base =
        f.options(|| vec![live_ref("claude:main", "uuid:A:-")], move |r: &AccountRef| ready(fx.ok(Provider::Claude, 1.0, &r.id)));
    let notices = vec![json!({ "id": "n1", "kind": "switchedOut", "at": 1, "email": "g@x.com" })];
    let n = notices.clone();
    let s = UsageService::new(UsageOptions { notices: Some(Arc::new(move || n.clone())), ..base.clone() });
    assert_eq!(s.state().notices, notices);
    let set_aside = vec![json!({ "recordId": "r1", "email": "g@x.com", "restoring": false })];
    let sa = set_aside.clone();
    let s = UsageService::new(UsageOptions {
        accounts_info: Some(Arc::new(move || AccountsInfo {
            accounts_read_only: Some("/d/accounts.json".into()),
            set_aside: sa.clone(),
            ..Default::default()
        })),
        ..base.clone()
    });
    let v = s.state().to_value();
    assert_eq!((&v["accountsReadOnly"], &v["setAside"]), (&json!("/d/accounts.json"), &Value::Array(set_aside)));
    let quiet = UsageService::new(UsageOptions { accounts_info: Some(Arc::new(AccountsInfo::default)), ..base });
    assert_eq!(quiet.state().to_value().as_object().unwrap().keys().collect::<Vec<_>>(), ["providers"]);
}

/// "re-derives the main, managed and held flags from the current card on every result, also while held or failed"
#[tokio::test(start_paused = true)]
async fn re_derives_the_main_managed_and_held_flags_from_the_current_card() {
    let f = Arc::new(Fx::new());
    let a = live_ref("claude:a", "uuid:A:-");
    let b = saved_ref("claude:b", Some("uuid:B:-"), "/b", Some(RenewRule::HeldByCswap));
    let listed = Arc::new(Mutex::new(vec![a, b]));
    let round = Arc::new(AtomicUsize::new(0));
    let (l, rd, fx) = (listed.clone(), round.clone(), f.clone());
    let s = UsageService::new(f.options(
        move || l.lock().clone(),
        move |r: &AccountRef| {
            let mut res = if r.key.as_deref() == Some("uuid:B:-") {
                fx.error(&r.id, "http-429", Some(46.0 * 60_000.0))
            } else if rd.load(Ordering::SeqCst) == 0 {
                fx.ok(Provider::Claude, 40.0, &r.id)
            } else {
                fx.failing(Provider::Claude, Status::Error, None, &r.id)
            };
            // The fetcher mirrors the card it was asked for; the service must not trust that later.
            res.usage.active = r.active == Some(true);
            res.usage.managed = r.config_dir.as_ref().map(|_| true);
            ready(res)
        },
    ));
    let flags = |s: &UsageService| {
        s.state().providers.iter().map(|p| (p.account_id.clone(), p.active, p.managed, p.held_by)).collect::<Vec<_>>()
    };
    s.refresh(true, true, None).await;
    assert_eq!(flags(&s), [("claude:a".into(), true, None, None), ("claude:b".into(), false, Some(true), Some(HeldBy::Cswap))]);
    round.store(1, Ordering::SeqCst);
    *listed.lock() =
        vec![live_ref("claude:b", "uuid:B:-"), saved_ref("claude:a", Some("uuid:A:-"), "/a", Some(RenewRule::SwitchedOut))];
    s.refresh(true, true, None).await;
    assert_eq!(
        flags(&s),
        [("claude:b".into(), true, None, None), ("claude:a".into(), false, Some(true), Some(HeldBy::SwitchedOut))]
    );
    let st = s.state().providers;
    assert_eq!(st.iter().filter(|p| p.active).count(), 1);
    assert_eq!((st[0].status, st[0].error.as_deref()), (Status::Error, Some("http-429")));
    assert_eq!((st[1].status, st[1].source, st[1].windows[0].used_percent), (Status::Error, Source::Cache, 40.0));
}

/// watchLive (F23): "does not bypass the 3-minute spacing of the same account", "does not bypass a backoff", "reads a
/// newly signed-in account at once"
#[tokio::test(start_paused = true)]
async fn a_changed_live_login_file_keeps_spacing_and_backoff_and_reads_a_new_account_at_once() {
    let f = Arc::new(Fx::new());
    let fx = f.clone();
    let befores = Arc::new(AtomicUsize::new(0));
    let b = befores.clone();
    let mut o = f
        .options(|| vec![live_ref("claude:main", "uuid:A:-")], move |r: &AccountRef| ready(fx.ok(Provider::Claude, 10.0, &r.id)));
    o.before_run = Some(Arc::new(move || {
        b.fetch_add(1, Ordering::SeqCst);
        async {}.boxed()
    }));
    let stamp = Arc::new(Mutex::new("a".to_string()));
    let s = UsageService::new(stamped(&f, o, stamp.clone(), Arc::default(), true));
    s.start();
    advance(100).await;
    assert_eq!(f.total(), 1);
    *stamp.lock() = "b".into();
    advance(60_000).await;
    assert_eq!(befores.load(Ordering::SeqCst), 2, "the change is looked at (reconcile) once");
    assert_eq!(f.total(), 1);
    s.stop();

    let f = Arc::new(Fx::new());
    let fx = f.clone();
    let o = UsageOptions {
        min_identity_gap_ms: 0.0,
        ..f.options(
            || vec![live_ref("claude:main", "uuid:A:-")],
            move |r: &AccountRef| ready(fx.failing(Provider::Claude, Status::Error, Some(600_000.0), &r.id)),
        )
    };
    let stamp = Arc::new(Mutex::new("a".to_string()));
    let s = UsageService::new(stamped(&f, o, stamp.clone(), Arc::default(), true));
    s.start();
    advance(100).await;
    *stamp.lock() = "b".into();
    advance(60_000).await;
    assert_eq!(f.total(), 1);
    s.stop();

    let f = Arc::new(Fx::new());
    let fx = f.clone();
    let listed = Arc::new(Mutex::new(vec![live_ref("claude:main", "uuid:A:-")]));
    let stamp = Arc::new(Mutex::new("a".to_string()));
    let (l, l2, st) = (listed.clone(), listed.clone(), stamp.clone());
    let mut o = f.options(
        move || l.lock().clone(),
        move |r: &AccountRef| {
            ready(fx.ok(Provider::Claude, if r.key.as_deref() == Some("uuid:G:-") { 70.0 } else { 10.0 }, &r.id))
        },
    );
    o.before_run = Some(Arc::new(move || {
        if *st.lock() == "b" {
            *l2.lock() = vec![live_ref("claude:main", "uuid:G:-")];
        }
        async {}.boxed()
    }));
    let s = UsageService::new(stamped(&f, o, stamp.clone(), Arc::default(), true));
    s.start();
    advance(100).await;
    *stamp.lock() = "b".into();
    advance(20_000).await;
    assert_eq!(f.total(), 2);
    assert_eq!(s.state().providers[0].windows[0].used_percent, 70.0);
    s.stop();
}

// ---- a 0.9.0 cache (keyed by card) ----------------------------------------------------------------------------------

fn card(account_id: &str, percent: f64, email: &str) -> Value {
    json!({ "accountId": account_id, "provider": "claude", "status": "ok", "source": "live", "fetchedAt": NOW - 60_000.0, "email": email,
            "windows": [{ "id": "5h", "usedPercent": percent, "resetsAt": 10 }] })
}

fn legacy_both(f: &Fx) {
    f.write_cache(&json!({
        "providers": [card("claude:main", 40.0, "a@x.com"), card("claude:rec1", 33.0, "b@x.com")],
        "backoff": { "claude:rec1": { "until": NOW + 600_000.0, "failures": 1, "error": "http-429", "attemptAt": NOW - 1000.0 } },
    }));
}

fn legacy_held(f: &Fx) {
    f.write_cache(&json!({
        "providers": [card("claude:main", 40.0, "a@x.com")],
        "backoff": { "claude:main": { "until": NOW + 600_000.0, "failures": 1, "error": "http-429", "attemptAt": NOW - 1000.0 } },
    }));
}

fn failed_as(f: &Fx, id: &str, email: &str) -> FetchResult {
    let mut res = f.error(id, "http-500", None);
    res.usage.email = Some(email.into());
    res
}

/// "moves a saved card to its account at once, its backoff too, and saves the account-keyed cache"
#[tokio::test(start_paused = true)]
async fn a_legacy_saved_card_moves_to_its_account_with_its_backoff() {
    let f = Arc::new(Fx::new());
    legacy_both(&f);
    let fx = f.clone();
    let s = UsageService::new(f.options(
        || vec![live_ref("claude:main", "uuid:A:-"), saved_ref("claude:rec1", Some("uuid:B:-"), "/b", None)],
        move |r: &AccountRef| ready(failed_as(&fx, &r.id, "a@x.com")),
    ));
    assert_eq!(percents(&s), [("claude:rec1".to_string(), 33.0)]);
    s.refresh(true, true, None).await;
    assert_eq!(f.calls.lock().iter().map(|r| r.id.clone()).collect::<Vec<_>>(), ["claude:main"]);
    let stored = f.cache_json();
    assert_eq!(stored["version"], 2);
    let mut keys: Vec<String> =
        stored["entries"].as_array().unwrap().iter().map(|e| e["key"].as_str().unwrap().to_string()).collect();
    keys.sort();
    assert_eq!(keys, ["uuid:A:-", "uuid:B:-"]);
    assert_eq!(
        (stored["backoff"]["uuid:B:-"]["until"].as_f64(), &stored["backoff"]["uuid:B:-"]["error"]),
        (Some(NOW + 600_000.0), &json!("http-429"))
    );
    assert!(stored["backoff"].get("claude:rec1").is_none());
}

/// "keeps the 0.9.0 live card's backoff and numbers only when the live account has its e-mail, also under its record's
/// id", "never gives the 0.9.0 live card's backoff to another account, nor keeps one it cannot check"
#[tokio::test(start_paused = true)]
async fn the_legacy_live_card_goes_only_to_the_live_account_with_its_e_mail() {
    let live = || vec![live_ref("claude:rec9", "uuid:A:-")];
    let f = Arc::new(Fx::new());
    legacy_held(&f);
    let fx = f.clone();
    let s = UsageService::new(UsageOptions {
        live_email: Some(Arc::new(|| Some("A@x.com".into()))),
        ..f.options(live, move |r: &AccountRef| ready(failed_as(&fx, &r.id, "a@x.com")))
    });
    s.refresh(true, true, None).await;
    assert_eq!(f.total(), 0);
    let p = s.state().providers[0].clone();
    assert_eq!(
        (p.account_id.as_str(), p.status, p.error.as_deref(), p.active),
        ("claude:rec9", Status::Error, Some("http-429"), true)
    );
    assert_eq!(p.windows[0].used_percent, 40.0);

    for email in [Some("g@x.com"), None] {
        let f = Arc::new(Fx::new());
        legacy_held(&f);
        let fx = f.clone();
        let s = UsageService::new(UsageOptions {
            live_email: Some(Arc::new(move || email.map(str::to_string))),
            ..f.options(live, move |r: &AccountRef| ready(failed_as(&fx, &r.id, "g@x.com")))
        });
        s.refresh(true, true, None).await;
        assert_eq!(f.total(), 1);
        let p = s.state().providers[0].clone();
        assert_eq!((p.error.as_deref(), p.windows.len()), (Some("http-500"), 0));
        assert_eq!(f.cache_json()["backoff"]["uuid:A:-"]["error"], "http-500");
    }
}

/// "gives the live card the old numbers only once a read proves it is the same account"
#[tokio::test(start_paused = true)]
async fn the_legacy_live_numbers_need_a_read_that_proves_the_account() {
    let f = Arc::new(Fx::new());
    legacy_both(&f);
    let email = Arc::new(Mutex::new("a@x.com".to_string()));
    let (e, fx) = (email.clone(), f.clone());
    let answer = move |r: &AccountRef| ready(failed_as(&fx, &r.id, &e.lock()));
    let s = UsageService::new(f.options(|| vec![live_ref("claude:main", "uuid:A:-")], answer.clone()));
    assert!(s.state().providers.is_empty());
    s.refresh(true, true, None).await;
    let p = s.state().providers[0].clone();
    assert_eq!((p.status, p.source, p.windows[0].used_percent), (Status::Error, Source::Cache, 40.0));
    legacy_both(&f);
    *email.lock() = "other@x.com".into();
    let other = UsageService::new(f.options(|| vec![live_ref("claude:main", "uuid:A:-")], answer));
    other.refresh(true, true, None).await;
    let p = other.state().providers[0].clone();
    assert_eq!((p.status, p.windows.len()), (Status::Error, 0));
}

// ---- task 12 fix round 1 --------------------------------------------------------------------------------------------

/// "reads an account shared by the live login and a saved record once per run, keeps its spacing and one stable card
/// state"
#[tokio::test(start_paused = true)]
async fn an_account_shared_by_the_live_login_and_a_saved_record_is_read_once() {
    let f = Arc::new(Fx::new());
    let n = Arc::new(AtomicUsize::new(0));
    let (nn, fx) = (n.clone(), f.clone());
    let s = UsageService::new(f.options(
        || {
            vec![
                saved_ref("claude:rec1", Some("uuid:A:-"), "/a", Some(RenewRule::HeldByLive)),
                live_ref("claude:main", "uuid:A:-"),
            ]
        },
        move |r: &AccountRef| ready(fx.ok(Provider::Claude, (nn.fetch_add(1, Ordering::SeqCst) + 1) as f64, &r.id)),
    ));
    s.refresh(true, true, None).await;
    assert_eq!(f.total(), 1);
    assert!(f.calls.lock()[0].config_dir.is_none(), "read through the live login");
    let first = s.state().providers;
    advance(30_000).await;
    s.refresh(true, true, None).await;
    s.refresh(true, true, None).await;
    assert_eq!(f.total(), 1);
    assert_eq!(s.state().providers, first);
    let shown: Vec<_> = first.iter().map(|p| (p.account_id.clone(), p.windows[0].used_percent, p.active, p.held_by)).collect();
    assert_eq!(shown, [("claude:rec1".into(), 1.0, false, Some(HeldBy::Live)), ("claude:main".into(), 1.0, true, None)]);
    advance(MIN_IDENTITY_GAP_MS as u64).await;
    s.refresh(true, true, None).await;
    assert_eq!(f.total(), 2);
    s.refresh(true, true, Some("claude:rec1")).await;
    assert_eq!(f.total(), 3);
}

/// "makes the follow-up run manual only when a manual caller joined it"
#[tokio::test(start_paused = true)]
async fn the_follow_up_run_is_manual_only_when_a_manual_caller_joined() {
    let f = Arc::new(Fx::new());
    let g = gate();
    let slow = Arc::new(AtomicBool::new(false));
    let (gg, sl, fx) = (g.clone(), slow.clone(), f.clone());
    let s = UsageService::new(f.legacy(f.options(
        || vec![live_ref("claude:main", "uuid:A:-"), saved_ref("claude:x", Some("uuid:X:-"), "/x", None)],
        move |r: &AccountRef| {
            if r.key.as_deref() == Some("uuid:X:-") {
                return ready(fx.failing(Provider::Claude, Status::Error, Some(600_000.0), &r.id));
            }
            let (gg, fx, r, slow) = (gg.clone(), fx.clone(), r.clone(), sl.load(Ordering::SeqCst));
            async move {
                if slow {
                    pass(&gg).await;
                }
                fx.ok(Provider::Claude, 1.0, &r.id)
            }
            .boxed()
        },
    )));
    s.refresh(true, true, None).await;
    assert_eq!(f.count_key("uuid:X:-"), 1);
    slow.store(true, Ordering::SeqCst);
    let run = s.refresh(false, true, None);
    let joined = s.refresh(false, true, None);
    g.add_permits(1);
    run.await;
    settle().await;
    g.add_permits(1);
    joined.await;
    assert_eq!(f.count_key("uuid:X:-"), 1, "its error hold stands");
    let run2 = s.refresh(false, true, None);
    let button = s.refresh(true, true, None);
    g.add_permits(1);
    run2.await;
    settle().await;
    g.add_permits(1);
    button.await;
    assert_eq!(f.count_key("uuid:X:-"), 2);
}

/// "keeps the short start guard after a restart also when the last read left no numbers"
#[tokio::test(start_paused = true)]
async fn the_short_start_guard_holds_also_without_numbers() {
    for status in [Status::Forbidden, Status::Expired, Status::SignedOut] {
        let f = Arc::new(Fx::new());
        let fx = f.clone();
        let answer = move |r: &AccountRef| {
            let mut u = fx.usage(Provider::Claude, &r.id, status);
            if status == Status::Forbidden {
                u.error = Some("http-403".into());
            }
            ready(FetchResult { usage: u, retry_after_ms: None, failed: false })
        };
        UsageService::new(f.options(|| vec![live_ref("claude:main", "uuid:A:-")], answer.clone()))
            .refresh(true, true, None)
            .await;
        advance(EAGER_GUARD_MS as u64 - 1_000).await;
        UsageService::new(f.options(|| vec![live_ref("claude:main", "uuid:A:-")], answer)).refresh(true, true, None).await;
        assert_eq!(f.total(), 1, "{status:?}");
    }
}

/// "holds a forbidden account for 30 minutes and shows it as forbidden, also after a restart"
#[tokio::test(start_paused = true)]
async fn a_forbidden_account_is_held_for_30_minutes_also_after_a_restart() {
    let f = Arc::new(Fx::new());
    let fx = f.clone();
    let answer = move |r: &AccountRef| {
        let mut u = fx.usage(Provider::Claude, &r.id, Status::Forbidden);
        u.error = Some("http-403".into());
        ready(FetchResult { usage: u, retry_after_ms: None, failed: false })
    };
    let live = || vec![live_ref("claude:main", "uuid:A:-")];
    let s = UsageService::new(f.options(live, answer.clone()));
    s.refresh(true, true, None).await;
    let p = s.state().providers[0].clone();
    assert_eq!((p.status, p.retry_at), (Status::Forbidden, Some(NOW + 30.0 * 60_000.0)));
    advance(MIN_IDENTITY_GAP_MS as u64 + 1).await;
    s.refresh(false, true, None).await;
    assert_eq!(f.total(), 1);
    let after = UsageService::new(f.options(live, answer));
    after.refresh(false, true, None).await;
    let p = after.state().providers[0].clone();
    assert_eq!((p.status, p.error.as_deref(), p.retry_at), (Status::Forbidden, Some("http-403"), Some(NOW + 30.0 * 60_000.0)));
    assert_eq!(f.total(), 1);
    advance(30 * 60_000).await;
    after.refresh(false, true, None).await;
    assert_eq!(f.total(), 2);
}

// ---- usage-restart.test.ts --------------------------------------------------------------------------------------------

fn r_live() -> AccountRef {
    live_ref("claude:support", "uuid:S:o")
}
fn r_switched() -> AccountRef {
    saved_ref("claude:daniel", Some("uuid:D:o"), "/p/daniel", Some(RenewRule::SwitchedOut))
}
fn r_dead() -> AccountRef {
    saved_ref("claude:app", Some("uuid:A:o"), "/p/app", Some(RenewRule::Allowed))
}
fn r_codex() -> AccountRef {
    AccountRef { id: "codex:main".into(), provider: "codex".into(), ..Default::default() }
}
fn all() -> Vec<AccountRef> {
    vec![r_live(), r_switched(), r_dead(), r_codex()]
}

fn r_windows(five: f64, seven: f64) -> Value {
    let s = (NOW_RESTART / 1000.0).floor();
    json!([{ "id": "5h", "usedPercent": five, "resetsAt": s + 3600.0 }, { "id": "7d", "usedPercent": seven, "resetsAt": s + 86_400.0 }])
}

fn seed_cache(f: &Fx, read_ago_ms: f64) {
    let at = NOW_RESTART - read_ago_ms;
    let entry = |r: &AccountRef, extra: Value| {
        let mut usage = json!({ "accountId": r.id, "provider": r.provider, "fetchedAt": at - 3_600_000.0, "source": "live", "windows": r_windows(40.0, 60.0) });
        for (k, v) in extra.as_object().unwrap() {
            usage[k] = v.clone();
        }
        json!({ "key": r.key.clone().unwrap_or_else(|| r.id.clone()), "usage": usage })
    };
    let reads: Map<String, Value> = all().iter().map(|r| (r.key.clone().unwrap_or_else(|| r.id.clone()), json!(at))).collect();
    f.write_cache(&json!({
        "version": 2,
        "entries": [
            entry(&r_live(), json!({ "status": "ok", "email": "support@example.com" })),
            entry(&r_switched(), json!({ "status": "elsewhere", "source": "cache", "heldBy": "switched-out", "email": "daniel@example.com", "windows": r_windows(77.0, 88.0) })),
            entry(&r_dead(), json!({ "status": "expired", "source": "cache", "error": "refresh-dead", "email": "app@example.com", "windows": r_windows(55.0, 66.0) })),
            entry(&r_codex(), json!({ "status": "ok", "email": "codex@example.com" })),
        ],
        "backoff": {},
        "reads": reads,
    }));
}

/// What the accounts answer now: the live one and Codex are fine, the two others still expired.
fn r_answer(f: &Fx, r: &AccountRef) -> FetchResult {
    let mut u = f.usage(provider_of(r), &r.id, Status::Ok);
    if r.id == "claude:app" {
        u.status = Status::Expired;
        u.error = Some("refresh-dead".into());
    } else if r.id == "claude:daniel" {
        u.status = Status::Elsewhere;
    } else {
        let s = (f.now() / 1000.0).floor();
        u.windows = vec![
            UsageWindow { id: WindowId::FiveHour, used_percent: 12.0, resets_at: s + 3600.0 },
            UsageWindow { id: WindowId::SevenDay, used_percent: 30.0, resets_at: s + 86_400.0 },
        ];
    }
    FetchResult { usage: u, retry_after_ms: None, failed: false }
}

fn r_build(f: &Arc<Fx>, accounts: fn() -> Vec<AccountRef>) -> Arc<UsageService> {
    let fx = f.clone();
    UsageService::new(f.options(accounts, move |r: &AccountRef| ready(r_answer(&fx, r))))
}

fn states(s: &UsageService) -> Vec<(String, CardState)> {
    s.state().providers.iter().map(|p| (p.account_id.clone(), card_state(p))).collect()
}

fn st(list: &[(&str, CardState)]) -> Vec<(String, CardState)> {
    list.iter().map(|(a, b)| (a.to_string(), *b)).collect()
}

/// usage-restart: "shows an expired or switched-out sign-in as expired right away, never its old numbers as current",
/// "skips the start read of an account read in the last 30 seconds (a quick restart loop)"
#[tokio::test(start_paused = true)]
async fn restart_shows_expired_sign_ins_at_once_and_skips_a_read_from_the_last_30_seconds() {
    let f = Arc::new(Fx::at(NOW_RESTART));
    seed_cache(&f, 60_000.0);
    let s = r_build(&f, all);
    let want = [
        ("claude:support", CardState::Stale),
        ("claude:daniel", CardState::Expired),
        ("claude:app", CardState::Expired),
        ("codex:main", CardState::Stale),
    ];
    assert_eq!(states(&s), st(&want));
    let app = s.state().providers.into_iter().find(|p| p.account_id == "claude:app").unwrap();
    assert_eq!((app.status, app.error.as_deref()), (Status::Expired, Some("refresh-dead")));

    let f = Arc::new(Fx::at(NOW_RESTART));
    seed_cache(&f, EAGER_GUARD_MS - 5_000.0);
    let s = r_build(&f, all);
    s.start();
    settle().await;
    assert_eq!(f.total(), 0);
    assert!(states(&s).contains(&("claude:app".into(), CardState::Expired)));
    s.stop();
}

/// usage-restart: "reads every account once right away at start although the last reads were a minute ago, then on the
/// interval"
#[tokio::test(start_paused = true)]
async fn restart_reads_every_account_at_once_then_on_the_interval() {
    let f = Arc::new(Fx::at(NOW_RESTART));
    seed_cache(&f, 60_000.0);
    let s = r_build(&f, all);
    s.start();
    settle().await;
    let mut ids: Vec<String> = f.calls.lock().iter().map(|r| r.id.clone()).collect();
    ids.sort();
    assert_eq!(ids, ["claude:app", "claude:daniel", "claude:support", "codex:main"]);
    let want = [
        ("claude:support", CardState::Ok),
        ("claude:daniel", CardState::Expired),
        ("claude:app", CardState::Expired),
        ("codex:main", CardState::Ok),
    ];
    assert_eq!(states(&s), st(&want));
    advance(60_000).await;
    s.refresh(false, true, None).await;
    assert_eq!(f.total(), 4);
    advance(240_000).await;
    assert_eq!(f.total(), 8);
    s.stop();
}

/// usage-restart: "keeps an expired card across a restart also when it has no numbers"
#[tokio::test(start_paused = true)]
async fn restart_keeps_an_expired_card_without_numbers() {
    let f = Arc::new(Fx::at(NOW_RESTART));
    let pair = || vec![r_live(), r_dead()];
    r_build(&f, pair).refresh_now().await;
    let stored = f.cache_json();
    let dead = stored["entries"].as_array().unwrap().iter().find(|e| e["key"] == "uuid:A:o").unwrap();
    assert_eq!((&dead["usage"]["status"], &dead["usage"]["windows"]), (&json!("expired"), &json!([])));
    assert!(states(&r_build(&f, pair)).contains(&("claude:app".into(), CardState::Expired)));
}

/// usage-restart: "still respects a rate-limit hold at start and the card says when it retries"
#[tokio::test(start_paused = true)]
async fn restart_respects_a_rate_limit_hold() {
    let f = Arc::new(Fx::at(NOW_RESTART));
    seed_cache(&f, 60_000.0);
    let mut raw = f.cache_json();
    raw["backoff"] = json!({ "uuid:S:o": { "until": NOW_RESTART + 600_000.0, "failures": 1, "error": "http-429", "attemptAt": NOW_RESTART - 60_000.0 } });
    f.write_cache(&raw);
    let s = r_build(&f, all);
    s.refresh(false, false, None).await;
    assert_eq!(f.count("claude:support"), 0);
    assert_eq!(f.total(), 3);
    let p = s.state().providers.into_iter().find(|p| p.account_id == "claude:support").unwrap();
    assert_eq!((p.status, p.error.as_deref(), p.retry_at), (Status::Error, Some("http-429"), Some(NOW_RESTART + 600_000.0)));
}

/// usage-restart, the refresh button: "reads every account now, not only those past their 3-minute spacing, and resolves
/// when all reads finished", "skips only an account read in the last 30 seconds"
#[tokio::test(start_paused = true)]
async fn the_refresh_button_reads_every_account_but_one_read_in_the_last_30_seconds_and_waits_for_all() {
    let f = Arc::new(Fx::at(NOW_RESTART));
    let g = gate();
    let gated = Arc::new(AtomicBool::new(false));
    let (gg, gd, fx) = (g.clone(), gated.clone(), f.clone());
    let s = UsageService::new(f.options(all, move |r: &AccountRef| {
        let (gg, fx, r, wait) = (gg.clone(), fx.clone(), r.clone(), gd.load(Ordering::SeqCst) && r.provider == "codex");
        async move {
            if wait {
                pass(&gg).await;
            }
            r_answer(&fx, &r)
        }
        .boxed()
    }));
    s.refresh(false, false, None).await;
    assert_eq!(f.total(), 4);
    advance(45_000).await;
    gated.store(true, Ordering::SeqCst);
    let button = tokio::spawn(s.refresh_now());
    settle().await;
    assert_eq!(f.total(), 8);
    assert!(!button.is_finished(), "the spinner stays until the last read is back");
    g.add_permits(1);
    button.await.unwrap();

    let f = Arc::new(Fx::at(NOW_RESTART));
    let s = r_build(&f, all);
    s.refresh(false, false, None).await;
    advance(10_000).await;
    s.refresh_now().await;
    assert_eq!(f.total(), 4);
    advance(EAGER_GUARD_MS as u64).await;
    s.refresh_now().await;
    assert_eq!(f.total(), 8);
}

/// usage-restart: "never bypasses a rate-limit hold; the card tells when the account is retried"
#[tokio::test(start_paused = true)]
async fn the_refresh_button_never_bypasses_a_rate_limit_hold() {
    let f = Arc::new(Fx::at(NOW_RESTART));
    let fx = f.clone();
    let s = UsageService::new(UsageOptions {
        retry_after_margin_ms: 0.0,
        ..f.options(
            || vec![r_live(), r_dead()],
            move |r: &AccountRef| {
                ready(if r.id == "claude:app" { fx.error(&r.id, "http-429", Some(600_000.0)) } else { r_answer(&fx, r) })
            },
        )
    });
    s.refresh(false, false, None).await;
    advance(MIN_IDENTITY_GAP_MS as u64).await;
    s.refresh_now().await;
    assert_eq!((f.count("claude:app"), f.count("claude:support")), (1, 2));
    let p = s.state().providers.into_iter().find(|p| p.account_id == "claude:app").unwrap();
    assert_eq!((p.status, p.error.as_deref(), p.retry_at), (Status::Error, Some("http-429"), Some(NOW_RESTART + 600_000.0)));
}

/// usage-restart: "reads every account after an automatic run that was in flight when it was pressed"
#[tokio::test(start_paused = true)]
async fn the_refresh_button_pressed_during_an_automatic_run_reads_every_account_after_it() {
    let f = Arc::new(Fx::at(NOW_RESTART));
    let fx = f.clone();
    let g = Arc::new(Semaphore::new(1));
    let gg = g.clone();
    let mut o = f.options(all, move |r: &AccountRef| ready(r_answer(&fx, r)));
    o.before_run = Some(Arc::new(move || {
        let gg = gg.clone();
        async move { pass(&gg).await }.boxed()
    }));
    let s = UsageService::new(o);
    s.refresh(false, false, None).await;
    assert_eq!(f.total(), 4);
    advance(60_000).await;
    let auto = s.refresh(false, true, None);
    settle().await;
    let button = s.refresh_now();
    g.add_permits(10);
    futures::join!(auto, button);
    assert_eq!(f.total(), 8);
}
