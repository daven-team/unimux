//! The provider state of the limits panel (port of src/main/usage/service.ts): polling, spacing of reads, backoff after
//! failures, the on-disk cache (`usage-cache.json`, version 2). Everything is keyed by the account (`AccountRef.key`, else
//! the card id), never by the card slot: a switched main card never shows the previous account's numbers or inherits its
//! backoff.
//!
//! Runs on a tokio runtime: a refresh is one spawned task shared by every caller that joins it (like the promise of
//! 1.1.4), the poll timer and the credentials watcher are tasks that are aborted when they are re-armed.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use serde_json::{Map, Value};
use tokio::task::JoinHandle;

use super::fetchers::FetchResult;
use super::sanitize::{sanitize, sanitize_usage};
use super::types::{Provider, ProviderUsage, Source, Status, held_by_of};
use crate::js;
use crate::refs::AccountRef;

pub const MIN_GAP_MS: f64 = 20_000.0;
/// At most one read of an account in this window: the usage endpoint allows about 28-30 reads an hour per account.
pub const MIN_IDENTITY_GAP_MS: f64 = 180_000.0;
/// The first run after a start and the refresh button read every account at once, except one read in this window.
pub const EAGER_GUARD_MS: f64 = 30_000.0;
/// Added to the Retry-After of a usage 429: the limit often re-triggers right after the stated deadline.
pub const RETRY_AFTER_MARGIN_MS: f64 = 15.0 * 60_000.0;
pub const WATCH: Duration = Duration::from_secs(20);
const BACKOFF_BASE_MS: f64 = 60_000.0;
const BACKOFF_MAX_MS: f64 = 30.0 * 60_000.0;
pub const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
const CACHE_VERSION: i64 = 2;
/// A 403 does not go away in minutes: the account is asked again after this.
const FORBIDDEN_HOLD_MS: f64 = 30.0 * 60_000.0;
/// The card id of the live Claude login in 0.9.0; as a refresh subject it means the live Claude card.
pub const LIVE_CARD: &str = "claude:main";

/// `/(?:^|-)http-429$/`: any rate limit (the usage endpoint or a token renewal); never bypassed by the refresh button.
fn rate_limited(error: Option<&str>) -> bool {
    error.is_some_and(|e| e == "http-429" || e.ends_with("-http-429"))
}

/// `/^[a-z0-9-]{1,40}$/`.
fn is_reason(s: &str) -> bool {
    (1..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// A running backoff; its reason and attempt time let a restarted app show the same calm card instead of a fresh retry.
#[derive(Debug, Clone, PartialEq)]
struct Backoff {
    until: f64,
    failures: u32,
    error: Option<String>,
    attempt_at: Option<f64>,
}

impl Backoff {
    fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("until".into(), js::num(self.until));
        m.insert("failures".into(), self.failures.into());
        if let Some(e) = &self.error {
            m.insert("error".into(), e.clone().into());
        }
        if let Some(a) = self.attempt_at {
            m.insert("attemptAt".into(), js::num(a));
        }
        Value::Object(m)
    }
}

/// What the accounts part adds to every state (`accountsInfo`).
#[derive(Debug, Clone, Default)]
pub struct AccountsInfo {
    /// Path of accounts.json when it cannot be read safely.
    pub accounts_read_only: Option<String>,
    /// `SetAsideAccount` values.
    pub set_aside: Vec<Value>,
    pub duplicate_copies: Vec<String>,
    /// The current `SwitchOffer`.
    pub switch_offer: Option<Value>,
    /// Per provider, the primary account the automatic switch left.
    pub switch_away: Map<String, Value>,
}

/// `UsageState`.
#[derive(Debug, Clone, Default)]
pub struct UsageState {
    pub providers: Vec<ProviderUsage>,
    /// `AccountNotice` values.
    pub notices: Vec<Value>,
    pub info: AccountsInfo,
}

impl UsageState {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("providers".into(), Value::Array(self.providers.iter().map(ProviderUsage::to_value).collect()));
        if !self.notices.is_empty() {
            m.insert("notices".into(), Value::Array(self.notices.clone()));
        }
        if let Some(p) = &self.info.accounts_read_only {
            m.insert("accountsReadOnly".into(), p.clone().into());
        }
        if !self.info.set_aside.is_empty() {
            m.insert("setAside".into(), Value::Array(self.info.set_aside.clone()));
        }
        if !self.info.duplicate_copies.is_empty() {
            m.insert("duplicateCopies".into(), self.info.duplicate_copies.clone().into());
        }
        if let Some(o) = &self.info.switch_offer {
            m.insert("switchOffer".into(), o.clone());
        }
        if !self.info.switch_away.is_empty() {
            m.insert("switchAway".into(), Value::Object(self.info.switch_away.clone()));
        }
        Value::Object(m)
    }
}

type Fn0<T> = Arc<dyn Fn() -> T + Send + Sync>;
pub type FetchAccount = Arc<dyn Fn(AccountRef) -> BoxFuture<'static, FetchResult> + Send + Sync>;
pub type Listener = Arc<dyn Fn(&UsageState) + Send + Sync>;

/// `UsageServiceOptions`.
#[derive(Clone)]
pub struct UsageOptions {
    /// The accounts to poll right now; read on every run and state read, so changes apply without a restart.
    pub accounts: Fn0<Vec<AccountRef>>,
    pub fetch_account: FetchAccount,
    /// Where the last good result is remembered (no credentials are stored there).
    pub cache_file: PathBuf,
    pub enabled: Fn0<bool>,
    /// Polling interval in ms; 0 or less disables polling.
    pub interval_ms: Fn0<f64>,
    pub now: Fn0<f64>,
    /// Change marker of an account's credentials file (`None` when unknown). Blocking but cheap (a stat).
    pub credentials_stamp: Option<Arc<dyn Fn(&AccountRef) -> Option<String> + Send + Sync>>,
    pub watch: Duration,
    /// Runs before every poll (reconciles the live Claude login with the saved accounts).
    pub before_run: Option<Fn0<BoxFuture<'static, ()>>>,
    /// Watch the live Claude login's file also while it is fine (an external switch or `/login`).
    pub watch_live: bool,
    pub min_identity_gap_ms: f64,
    pub retry_after_margin_ms: f64,
    pub notices: Option<Fn0<Vec<Value>>>,
    pub accounts_info: Option<Fn0<AccountsInfo>>,
    /// Keep polling while the window is hidden or minimized (limit warnings or the automatic switch are on).
    pub poll_hidden: Option<Fn0<bool>>,
    /// E-mail of the account signed in to Claude Code (checks a 0.9.0 cache entry of the live card).
    pub live_email: Option<Fn0<Option<String>>>,
    pub fetch_timeout: Duration,
    pub rt: tokio::runtime::Handle,
}

impl UsageOptions {
    /// The defaults of 1.1.4 for everything but the callbacks.
    pub fn new(
        accounts: Fn0<Vec<AccountRef>>,
        fetch_account: FetchAccount,
        cache_file: PathBuf,
        enabled: Fn0<bool>,
        interval_ms: Fn0<f64>,
        rt: tokio::runtime::Handle,
    ) -> Self {
        Self {
            accounts,
            fetch_account,
            cache_file,
            enabled,
            interval_ms,
            now: Arc::new(|| unimux_core::time::now_ms() as f64),
            credentials_stamp: None,
            watch: WATCH,
            before_run: None,
            watch_live: false,
            min_identity_gap_ms: MIN_IDENTITY_GAP_MS,
            retry_after_margin_ms: RETRY_AFTER_MARGIN_MS,
            notices: None,
            accounts_info: None,
            poll_hidden: None,
            live_email: None,
            fetch_timeout: FETCH_TIMEOUT,
            rt,
        }
    }
}

type SharedState = Shared<BoxFuture<'static, UsageState>>;

#[derive(Default)]
struct Inner {
    providers: HashMap<String, ProviderUsage>,
    backoff: HashMap<String, Backoff>,
    last_read: HashMap<String, f64>,
    read_as_profile: HashMap<String, bool>,
    subjects: HashSet<String>,
    legacy_usage: HashMap<String, ProviderUsage>,
    legacy_hold: HashMap<String, Backoff>,
    legacy_live: Option<(String, ProviderUsage)>,
    stamps: HashMap<String, Option<String>>,
    timer: Option<JoinHandle<()>>,
    watcher: Option<JoinHandle<()>>,
    pending: Option<SharedState>,
    follow_up: Option<SharedState>,
    follow_up_manual: bool,
    eager_requested: bool,
    first_run: bool,
    last_run: f64,
    running: bool,
    active: bool,
}

/// `UsageService`.
pub struct UsageService {
    o: UsageOptions,
    inner: Mutex<Inner>,
    listeners: Mutex<Vec<Listener>>,
}

fn key_of(r: &AccountRef) -> String {
    r.key.clone().unwrap_or_else(|| r.id.clone())
}

fn is_live_claude(r: &AccountRef) -> bool {
    r.provider == "claude" && r.config_dir.is_none()
}

impl UsageService {
    pub fn new(o: UsageOptions) -> Arc<Self> {
        let me = Arc::new(Self {
            o,
            inner: Mutex::new(Inner { first_run: true, active: true, ..Inner::default() }),
            listeners: Mutex::new(Vec::new()),
        });
        me.load_cache();
        me
    }

    fn now(&self) -> f64 {
        (self.o.now)()
    }

    /// The listed accounts, with any 0.9.0 cache entries moved to their accounts first.
    fn refs(&self, after_reconcile: bool) -> Vec<AccountRef> {
        let refs = (self.o.accounts)();
        self.adopt_legacy(&refs, after_reconcile);
        refs
    }

    /// `getState`.
    pub fn state(&self) -> UsageState {
        let refs = self.refs(false);
        let providers = {
            let g = self.inner.lock();
            refs.iter()
                .filter_map(|r| {
                    let mut u = g.providers.get(&key_of(r))?.clone();
                    // The card's slot and role are the current ones, whatever they were when the numbers were read.
                    u.account_id = r.id.clone();
                    u.managed = r.config_dir.is_some().then_some(true);
                    u.active = r.active == Some(true);
                    u.held_by = if r.config_dir.is_some() { held_by_of(r.renew) } else { None };
                    Some(u)
                })
                .collect()
        };
        let notices = self.o.notices.as_ref().map(|n| n()).unwrap_or_default();
        let info = self.o.accounts_info.as_ref().map(|i| i()).unwrap_or_default();
        UsageState { providers, notices, info }
    }

    pub fn on_change(&self, listener: Listener) {
        self.listeners.lock().push(listener);
    }

    pub fn start(self: &Arc<Self>) {
        self.inner.lock().running = true;
        self.kick();
        self.schedule();
    }

    pub fn stop(self: &Arc<Self>) {
        let mut g = self.inner.lock();
        g.running = false;
        if let Some(t) = g.timer.take() {
            t.abort();
        }
        drop(g);
        self.sync_watch();
    }

    /// The window was hidden or shown: no polling while hidden (unless `poll_hidden`), a catch-up read on return when stale.
    pub fn set_active(self: &Arc<Self>, active: bool) {
        self.inner.lock().active = active;
        self.sync_watch();
        if !active {
            if !self.poll_hidden() {
                self.clear_timer();
            }
            return;
        }
        let interval = (self.o.interval_ms)();
        let (running, last_run) = {
            let g = self.inner.lock();
            (g.running, g.last_run)
        };
        if running && (self.o.enabled)() && interval > 0.0 && self.now() - last_run >= interval {
            self.kick();
        }
        self.schedule();
    }

    /// Call after the enabled flag or the interval changed.
    pub fn reschedule(self: &Arc<Self>) {
        if self.inner.lock().running && (self.o.enabled)() {
            self.kick();
        }
        self.schedule();
    }

    fn poll_hidden(&self) -> bool {
        self.o.poll_hidden.as_ref().is_some_and(|p| p())
    }

    /// `manual` (the refresh button) also reads accounts in an error backoff, never one held by a rate limit; `force` skips
    /// the 20 s gap between runs. `subject` (a card id or key; `claude:main` = the live Claude card) is read now whatever
    /// its spacing or hold.
    pub fn refresh(self: &Arc<Self>, manual: bool, force: bool, subject: Option<&str>) -> BoxFuture<'static, UsageState> {
        if !(self.o.enabled)() {
            let state = self.state();
            return async move { state }.boxed();
        }
        let mut g = self.inner.lock();
        if let Some(s) = subject {
            g.subjects.insert(s.to_string());
        }
        if let Some(pending) = g.pending.clone() {
            if !force {
                return pending.boxed();
            }
            // The follow-up is manual only when a caller was (a file-change run must not bypass error holds by joining).
            g.follow_up_manual |= manual;
            if g.follow_up.is_none() {
                let me = self.clone();
                let task = self.o.rt.spawn(async move {
                    pending.await;
                    let as_manual = {
                        let mut g = me.inner.lock();
                        g.follow_up = None;
                        std::mem::take(&mut g.follow_up_manual)
                    };
                    me.refresh(as_manual, true, None).await
                });
                let fallback = Arc::downgrade(self);
                g.follow_up = Some(Self::shared(task, fallback));
            }
            return g.follow_up.clone().map(FutureExt::boxed).unwrap_or_else(|| async { UsageState::default() }.boxed());
        }
        if !force && g.last_run > 0.0 && self.now() - g.last_run < MIN_GAP_MS {
            drop(g);
            let state = self.state();
            return async move { state }.boxed();
        }
        let me = self.clone();
        let task = self.o.rt.spawn(async move {
            let state = me.run(manual).await;
            me.inner.lock().pending = None;
            state
        });
        let shared = Self::shared(task, Arc::downgrade(self));
        g.pending = Some(shared.clone());
        drop(g);
        shared.boxed()
    }

    fn shared(task: JoinHandle<UsageState>, me: std::sync::Weak<Self>) -> SharedState {
        async move {
            match task.await {
                Ok(state) => state,
                Err(_) => me.upgrade().map(|m| m.state()).unwrap_or_default(),
            }
        }
        .boxed()
        .shared()
    }

    /// The refresh button: reads every account now (only one read in the last EAGER_GUARD_MS and a rate-limit hold are
    /// skipped) and resolves once all reads finished. A run already in flight is followed by one.
    pub fn refresh_now(self: &Arc<Self>) -> BoxFuture<'static, UsageState> {
        if !(self.o.enabled)() {
            let state = self.state();
            return async move { state }.boxed();
        }
        self.inner.lock().eager_requested = true;
        self.refresh(true, true, None)
    }

    /// Fire-and-forget refresh.
    fn kick(self: &Arc<Self>) {
        let f = self.refresh(false, false, None);
        self.o.rt.spawn(f);
    }

    fn clear_timer(&self) {
        if let Some(t) = self.inner.lock().timer.take() {
            t.abort();
        }
    }

    fn schedule(self: &Arc<Self>) {
        self.clear_timer();
        let interval = (self.o.interval_ms)();
        let (running, active) = {
            let g = self.inner.lock();
            (g.running, g.active)
        };
        if !running || (!active && !self.poll_hidden()) || !(self.o.enabled)() || interval <= 0.0 || !interval.is_finite() {
            return;
        }
        let weak = Arc::downgrade(self);
        let task = self.o.rt.spawn(async move {
            tokio::time::sleep(Duration::from_millis(interval as u64)).await;
            let Some(me) = weak.upgrade() else { return };
            let run = me.refresh(false, false, None);
            // The next timer is armed by a separate task: aborting this one (a re-arm meanwhile) must not stop it.
            me.o.rt.spawn(async move {
                run.await;
                if let Some(me) = weak.upgrade() {
                    me.schedule();
                }
            });
        });
        self.inner.lock().timer = Some(task);
    }

    async fn run(self: &Arc<Self>, manual: bool) -> UsageState {
        let started = self.now();
        let (subjects, eager) = {
            let mut g = self.inner.lock();
            g.last_run = started;
            let subjects = std::mem::take(&mut g.subjects);
            // The first run of this process and the refresh button read every account now (only the short guard).
            let eager = g.eager_requested || g.first_run;
            g.eager_requested = false;
            g.first_run = false;
            (subjects, eager)
        };
        let spacing = self.o.min_identity_gap_ms;
        let gap = if eager { EAGER_GUARD_MS.min(spacing) } else { spacing };
        if let Some(before) = &self.o.before_run {
            // A failure (a panic in the task) never stops the poll.
            let _ = self.o.rt.spawn(before()).await;
        }
        let accounts = self.refs(true);
        self.prune(&accounts);
        // An action about any card of an account (also the saved card sharing the live login's account) makes it a subject.
        let subject_keys: HashSet<String> = accounts
            .iter()
            .filter(|r| {
                subjects.contains(&r.id)
                    || subjects.contains(&key_of(r))
                    || (subjects.contains(LIVE_CARD) && is_live_claude(r))
            })
            .map(key_of)
            .collect();
        let reads = Self::one_per_account(&accounts)
            .into_iter()
            .map(|r| {
                let subject = subject_keys.contains(&key_of(&r));
                self.update(r, started, manual, subject, gap)
            })
            .collect::<Vec<_>>();
        futures::future::join_all(reads).await;
        self.prune(&(self.o.accounts)());
        {
            // Whatever of a 0.9.0 cache found no account by now is history.
            let mut g = self.inner.lock();
            g.legacy_usage.clear();
            g.legacy_hold.clear();
            g.legacy_live = None;
        }
        self.save_cache();
        self.sync_watch();
        let state = self.state();
        let listeners = self.listeners.lock().clone();
        for l in listeners {
            // A bad listener must not affect the others or the run.
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| l(&state)));
        }
        state
    }

    /// Forgets everything about accounts that are no longer listed.
    fn prune(&self, accounts: &[AccountRef]) {
        let keys: HashSet<String> = accounts.iter().map(key_of).collect();
        let mut g = self.inner.lock();
        g.providers.retain(|k, _| keys.contains(k));
        g.backoff.retain(|k, _| keys.contains(k));
        g.stamps.retain(|k, _| keys.contains(k));
        g.last_read.retain(|k, _| keys.contains(k));
        g.read_as_profile.retain(|k, _| keys.contains(k));
    }

    fn watched_live(&self, r: &AccountRef) -> bool {
        self.o.watch_live && is_live_claude(r)
    }

    fn watched(&self, g: &Inner, r: &AccountRef) -> bool {
        let key = key_of(r);
        g.stamps.contains_key(&key)
            && (g.providers.get(&key).is_some_and(|u| u.status == Status::Dormant) || self.watched_live(r))
    }

    /// Polls the credentials file of dormant (and, with watchLive, live) accounts only, a cheap stat, and refreshes when it
    /// changed.
    fn sync_watch(self: &Arc<Self>) {
        let accounts = (self.o.accounts)();
        let mut g = self.inner.lock();
        let wanted = g.running
            && g.active
            && (self.o.enabled)()
            && self.o.credentials_stamp.is_some()
            && accounts.iter().any(|r| self.watched(&g, r));
        if !wanted {
            if let Some(w) = g.watcher.take() {
                w.abort();
            }
            return;
        }
        if g.watcher.is_some() {
            return;
        }
        let weak = Arc::downgrade(self);
        let every = self.o.watch;
        g.watcher = Some(self.o.rt.spawn(async move {
            let mut tick = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
            loop {
                tick.tick().await;
                let Some(me) = weak.upgrade() else { return };
                // The check runs on its own task: a stop meanwhile aborts the watcher, never a run it started.
                me.o.rt.spawn({
                    let me = me.clone();
                    async move { me.check_stamps().await }
                });
            }
        }));
    }

    async fn check_stamps(self: &Arc<Self>) {
        let Some(stamp_of) = self.o.credentials_stamp.clone() else { return };
        if self.inner.lock().pending.is_some() {
            return;
        }
        for r in (self.o.accounts)() {
            if !self.watched(&self.inner.lock(), &r) {
                continue;
            }
            let key = key_of(&r);
            let current = stamp_of(&r);
            {
                let mut g = self.inner.lock();
                if g.stamps.get(&key) == Some(&current) {
                    continue;
                }
                // The file changed: one run now, which reconciles the live login first. It is no action about the
                // account; the change is noted, so it triggers one run, not one every watch period.
                g.stamps.insert(key, current);
            }
            self.refresh(false, true, None).await;
            return;
        }
    }

    /// One card per account and run: the live login and a saved record of the same account share a key, so the account is
    /// read once (through the live login) and its spacing applies.
    fn one_per_account(refs: &[AccountRef]) -> Vec<AccountRef> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for r in refs.iter().filter(|r| is_live_claude(r)).chain(refs.iter().filter(|r| !is_live_claude(r))) {
            if seen.insert(key_of(r)) {
                out.push(r.clone());
            }
        }
        out
    }

    fn failure(r: &AccountRef, now: f64, error: &str) -> FetchResult {
        let provider = Provider::parse(&r.provider).unwrap_or(Provider::Claude);
        let mut u = ProviderUsage::new(&r.id, provider, Status::Error, now, Source::Live);
        u.error = Some(error.into());
        FetchResult { usage: u, retry_after_ms: None, failed: false }
    }

    async fn update(self: &Arc<Self>, r: AccountRef, now: f64, manual: bool, subject: bool, gap: f64) {
        let key = key_of(&r);
        let as_profile = r.config_dir.is_some();
        let hold = {
            let mut g = self.inner.lock();
            let hold = g.backoff.get(&key).cloned();
            // A rate limit is never bypassed (not even by the refresh button): hitting the limiter again keeps it engaged.
            if let Some(h) = &hold
                && h.until > now
                && !subject
                && (!manual || rate_limited(h.error.as_deref()))
            {
                Self::restore_held(&mut g, &r, &key, h, now);
                return;
            }
            let last = g.last_read.get(&key).copied();
            // Spacing applies to the same copy of the sign-in; an account that moved between the live login and a profile
            // is read once.
            let same_role = g.read_as_profile.get(&key).copied().unwrap_or(as_profile) == as_profile;
            if !subject && same_role && last.is_some_and(|l| now - l < gap) {
                return;
            }
            g.last_read.insert(key.clone(), now);
            g.read_as_profile.insert(key.clone(), as_profile);
            hold
        };
        let stamp = self.o.credentials_stamp.as_ref().and_then(|s| s(&r));
        let result = match tokio::time::timeout(self.o.fetch_timeout, (self.o.fetch_account)(r.clone())).await {
            Ok(result) => result,
            Err(_) => Self::failure(&r, now, "timeout"),
        };
        // A result for an account removed (or switched to another identity) while it was in flight is dropped.
        if !(self.o.accounts)().iter().any(|l| key_of(l) == key) {
            return;
        }
        let read = match sanitize(&result.usage) {
            Some(u) if u.account_id == r.id => u,
            _ => Self::failure(&r, now, "bad-response").usage,
        };
        let mut g = self.inner.lock();
        Self::verify_legacy_live(&mut g, &key, &read);
        let failed = read.status == Status::Error || result.failed;
        let forbidden = read.status == Status::Forbidden;
        let previous_failures = hold.as_ref().map_or(0, |h| h.failures);
        let retry_at = if failed {
            Some(self.start_backoff(&mut g, &key, now, previous_failures, result.retry_after_ms, read.error.clone()))
        } else if forbidden {
            let error = read.error.clone().unwrap_or_else(|| "http-403".into());
            Some(self.start_backoff(&mut g, &key, now, previous_failures, Some(FORBIDDEN_HOLD_MS), Some(error)))
        } else {
            g.backoff.remove(&key);
            None
        };
        let mut usage = read;
        usage.attempt_at = Some(now);
        if let Some(at) = retry_at {
            usage.retry_at = Some(at);
        }
        if usage.status == Status::Dormant || self.watched_live(&r) {
            g.stamps.insert(key.clone(), stamp);
        } else {
            g.stamps.remove(&key);
        }
        if matches!(usage.status, Status::Ok | Status::SignedOut | Status::ApiKey) {
            g.providers.insert(key, usage);
            return;
        }
        // Expired or failed: keep the last numbers of THIS account, marked as remembered, so the panel is never blank.
        let previous = g.providers.get(&key);
        let kept = match previous {
            Some(p) if usage.windows.is_empty() && !p.windows.is_empty() => {
                let mut u = usage.clone();
                u.windows = p.windows.clone();
                u.fetched_at = p.fetched_at;
                u.source = Source::Cache;
                u
            }
            _ => usage,
        };
        g.providers.insert(key, kept);
    }

    /// Returns when the next automatic attempt may happen.
    fn start_backoff(
        &self,
        g: &mut Inner,
        key: &str,
        now: f64,
        previous_failures: u32,
        retry_after_ms: Option<f64>,
        error: Option<String>,
    ) -> f64 {
        let failures = previous_failures + 1;
        // A usage-endpoint 429 waits the margin longer, with or without a Retry-After.
        let margin = if error.as_deref() == Some("http-429") { self.o.retry_after_margin_ms } else { 0.0 };
        let base = retry_after_ms
            .unwrap_or_else(|| BACKOFF_MAX_MS.min(BACKOFF_BASE_MS * 2f64.powi(failures.saturating_sub(1).min(60) as i32)));
        let wait = base + margin;
        g.backoff.insert(key.to_string(), Backoff { until: now + wait, failures, error, attempt_at: Some(now) });
        now + wait
    }

    /// While held the card shows why and when it is tried next (the attempt itself is skipped).
    fn restore_held(g: &mut Inner, r: &AccountRef, key: &str, hold: &Backoff, now: f64) {
        let Some(error) = &hold.error else { return };
        let current = g.providers.get(key);
        if current.is_some_and(|c| c.error.as_deref() == Some(error)) {
            return;
        }
        let mut u = current.cloned().unwrap_or_else(|| {
            let provider = Provider::parse(&r.provider).unwrap_or(Provider::Claude);
            ProviderUsage::new(&r.id, provider, Status::Error, hold.attempt_at.unwrap_or(now), Source::Cache)
        });
        u.status = if error == "http-403" { Status::Forbidden } else { Status::Error };
        u.error = Some(error.clone());
        if let Some(a) = hold.attempt_at {
            u.attempt_at = Some(a);
        }
        u.retry_at = Some(hold.until);
        g.providers.insert(key.to_string(), u);
    }

    /// Moves 0.9.0 cache entries (keyed by card id) to the accounts now listed. The 0.9.0 live card's numbers and backoff
    /// go to the live account only when its e-mail is the live account's (known now, or proven by the first read).
    fn adopt_legacy(&self, refs: &[AccountRef], after_reconcile: bool) {
        let mut g = self.inner.lock();
        if g.legacy_usage.is_empty() && g.legacy_hold.is_empty() {
            return;
        }
        let adopt = |g: &mut Inner, key: String, from: &str| {
            let usage = g.legacy_usage.remove(from);
            let hold = g.legacy_hold.remove(from);
            if let Some(u) = usage
                && !g.providers.contains_key(&key)
            {
                g.providers.insert(key.clone(), u);
            }
            if let Some(h) = hold
                && !g.backoff.contains_key(&key)
            {
                g.backoff.insert(key, h);
            }
        };
        // Same card id, same account (a card without identity is keyed by its id, as in 0.9.0).
        for r in refs {
            if r.id != LIVE_CARD || key_of(r) == r.id {
                adopt(&mut g, key_of(r), &r.id);
            }
        }
        if !after_reconcile {
            return;
        }
        let Some(live) = refs.iter().find(|r| is_live_claude(r)) else { return };
        let key = key_of(live);
        let hold = g.legacy_hold.remove(LIVE_CARD);
        let usage = g.legacy_usage.remove(LIVE_CARD);
        let live_email = self.o.live_email.as_ref().and_then(|f| f()).map(|e| e.to_lowercase());
        let same = matches!((&live_email, usage.as_ref().and_then(|u| u.email.as_ref())), (Some(l), Some(e)) if !l.is_empty() && e.to_lowercase() == *l);
        if same {
            if let Some(u) = usage
                && !g.providers.contains_key(&key)
            {
                g.providers.insert(key.clone(), u);
            }
            if let Some(h) = hold
                && !g.backoff.contains_key(&key)
            {
                g.backoff.insert(key, h);
            }
        } else if let Some(u) = usage
            && live_email.as_deref().is_none_or(str::is_empty)
        {
            g.legacy_live = Some((key, u));
        }
    }

    fn verify_legacy_live(g: &mut Inner, key: &str, read: &ProviderUsage) {
        let Some((k, usage)) = g.legacy_live.take() else { return };
        if k != key {
            g.legacy_live = Some((k, usage));
            return;
        }
        let same = matches!((&read.email, &usage.email), (Some(a), Some(b)) if a.to_lowercase() == b.to_lowercase());
        if same && !g.providers.contains_key(key) {
            g.providers.insert(key.to_string(), usage);
        }
    }

    fn load_cache(&self) {
        let Ok(text) = js::read_text(&self.o.cache_file) else { return };
        let Ok(raw) = unimux_core::js_json::parse(&text) else { return };
        let now = self.now();
        let mut g = self.inner.lock();
        // Version 2 is keyed by account; a 0.9.0 cache (version-less) is keyed by card id and moved to the accounts on use.
        let legacy = raw.get("version").and_then(Value::as_f64) != Some(CACHE_VERSION as f64);
        let entries: Vec<(String, Value)> = if !legacy {
            raw.get("entries")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|e| {
                            let key = e.as_object()?.get("key")?.as_str()?;
                            Some((key.to_string(), e.get("usage").cloned().unwrap_or(Value::Null)))
                        })
                        .collect()
                })
                .unwrap_or_default()
        } else {
            raw.get("providers")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .map(|u| (u.get("accountId").and_then(Value::as_str).unwrap_or("").to_string(), u.clone()))
                        .collect()
                })
                .unwrap_or_default()
        };
        for (key, entry) in entries {
            let usage = sanitize_usage(&entry);
            // An expired sign-in survives a restart as such: its card says "Sign-in expired" at once (1.1.1).
            let sign_in = !legacy && usage.as_ref().is_some_and(|u| matches!(u.status, Status::Expired | Status::Elsewhere));
            let Some(usage) = usage else { continue };
            if key.is_empty() || (usage.windows.is_empty() && !sign_in) {
                continue;
            }
            // Otherwise only the numbers survive a restart; the failure stored with them is history.
            let mut numbers = usage.clone();
            numbers.retry_at = None;
            numbers.attempt_at = None;
            numbers.source = Source::Cache;
            if !sign_in {
                numbers.error = None;
                numbers.status = Status::Ok;
            }
            if legacy {
                g.legacy_usage.insert(key, numbers);
            } else {
                g.providers.insert(key, numbers);
            }
        }
        if let Some(held) = raw.get("backoff").and_then(Value::as_object) {
            for (key, value) in held {
                let Some(e) = value.as_object() else { continue };
                let Some(until) = js::finite(e.get("until")) else { continue };
                let Some(failures) = js::finite(e.get("failures")).filter(|f| f.fract() == 0.0 && *f >= 1.0) else { continue };
                if until <= now {
                    continue;
                }
                let hold = Backoff {
                    until,
                    failures: failures.min(f64::from(u32::MAX)) as u32,
                    error: e.get("error").and_then(Value::as_str).filter(|s| is_reason(s)).map(str::to_string),
                    attempt_at: js::finite(e.get("attemptAt")),
                };
                if legacy {
                    g.legacy_hold.insert(key.clone(), hold);
                } else {
                    g.backoff.insert(key.clone(), hold);
                }
            }
        }
        if !legacy && let Some(reads) = raw.get("reads").and_then(Value::as_object) {
            for (key, at) in reads {
                if let Some(at) = js::finite(Some(at)).filter(|a| *a <= now) {
                    g.last_read.insert(key.clone(), at);
                }
            }
        }
    }

    fn save_cache(&self) {
        let accounts = (self.o.accounts)();
        let now = self.now();
        let mut keys: Vec<String> = Vec::new();
        for r in &accounts {
            let k = key_of(r);
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
        let (entries, backoff, reads) = {
            let g = self.inner.lock();
            let entries: Vec<Value> = keys
                .iter()
                .filter_map(|k| {
                    let u = g.providers.get(k)?;
                    let kept = !u.windows.is_empty() || matches!(u.status, Status::Expired | Status::Elsewhere);
                    kept.then(|| {
                        let mut m = Map::new();
                        m.insert("key".into(), k.clone().into());
                        m.insert("usage".into(), u.to_value());
                        Value::Object(m)
                    })
                })
                .collect();
            let mut backoff = Map::new();
            for k in &keys {
                if let Some(h) = g.backoff.get(k).filter(|h| h.until > now) {
                    backoff.insert(k.clone(), h.to_value());
                }
            }
            let mut reads = Map::new();
            for k in &keys {
                if let Some(at) = g.last_read.get(k) {
                    reads.insert(k.clone(), js::num(*at));
                }
            }
            (entries, backoff, reads)
        };
        let mut m = Map::new();
        m.insert("version".into(), CACHE_VERSION.into());
        m.insert("entries".into(), Value::Array(entries));
        m.insert("backoff".into(), Value::Object(backoff));
        m.insert("reads".into(), Value::Object(reads));
        let text = serde_json::to_string(&Value::Object(m)).unwrap_or_default();
        // The cache is optional.
        if let Some(dir) = self.o.cache_file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = unimux_core::atomic_write::atomic_write(
            &self.o.cache_file,
            text.as_bytes(),
            &unimux_core::atomic_write::AtomicWriteOptions::default(),
        );
    }
}

#[cfg(test)]
mod tests;
