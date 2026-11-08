//! 1.1.1 limit warnings as OS notifications (ports of src/shared/limitAlerts.ts, the quiet hours of src/shared/alerts.ts
//! and src/main/limitAlerts.ts): which account windows crossed their threshold (once per account, window and reset period),
//! which of those reset since, and `limit-alerts.json` (version 1) that keeps both across restarts.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Map, Value};

use crate::js;
use crate::localtime::local_fields;
use crate::usage::types::{CardState, Provider, ProviderUsage, Source, Status, WindowId, card_state, clamp_percent, js_round};

/// `LimitWindowAlert`: on/off and the used percent at which it fires.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowAlert {
    pub enabled: bool,
    pub percent: u32,
}

/// `isThresholdPercent`: a whole percent from 1 to 100.
pub fn threshold_percent(v: Option<&Value>) -> Option<u32> {
    let f = v?.as_f64()?;
    (f.fract() == 0.0 && (1.0..=100.0).contains(&f)).then_some(f as u32)
}

impl WindowAlert {
    /// `windowAlert(raw, fallback)`.
    pub fn from_value(raw: Option<&Value>, fallback: WindowAlert) -> Self {
        let w = js::record(raw);
        Self {
            enabled: w.and_then(|w| w.get("enabled")).and_then(Value::as_bool).unwrap_or(fallback.enabled),
            percent: threshold_percent(w.and_then(|w| w.get("percent"))).unwrap_or(fallback.percent),
        }
    }
}

/// `LimitAlertSettings`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LimitAlertSettings {
    pub enabled: bool,
    pub five_hour: WindowAlert,
    pub seven_day: WindowAlert,
    /// Also tell when a window that crossed its threshold reset.
    pub resets: bool,
}

impl Default for LimitAlertSettings {
    /// `defaultLimitAlerts`.
    fn default() -> Self {
        Self {
            enabled: true,
            five_hour: WindowAlert { enabled: true, percent: 80 },
            seven_day: WindowAlert { enabled: true, percent: 90 },
            resets: false,
        }
    }
}

impl LimitAlertSettings {
    /// `normalizeLimitAlerts`.
    pub fn from_value(v: Option<&Value>) -> Self {
        let r = js::record(v);
        let d = Self::default();
        let get = |k: &str| r.and_then(|r| r.get(k));
        Self {
            enabled: get("enabled").and_then(Value::as_bool).unwrap_or(d.enabled),
            five_hour: WindowAlert::from_value(get("fiveHour"), d.five_hour),
            seven_day: WindowAlert::from_value(get("sevenDay"), d.seven_day),
            resets: get("resets").and_then(Value::as_bool).unwrap_or(d.resets),
        }
    }

    fn threshold(&self, window: WindowId) -> WindowAlert {
        if window == WindowId::FiveHour { self.five_hour } else { self.seven_day }
    }
}

/// `QuietHours` ('HH:MM' local time; start inclusive, end exclusive, may wrap midnight).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuietHours {
    pub enabled: bool,
    pub start: String,
    pub end: String,
}

/// `/^([01]\d|2[0-3]):([0-5]\d)$/` to minutes.
fn minutes_of(time: &str) -> Option<u32> {
    let b = time.as_bytes();
    if b.len() != 5 || b[2] != b':' || !b.iter().enumerate().all(|(i, c)| i == 2 || c.is_ascii_digit()) {
        return None;
    }
    let h = u32::from(b[0] - b'0') * 10 + u32::from(b[1] - b'0');
    let m = u32::from(b[3] - b'0') * 10 + u32::from(b[4] - b'0');
    (h <= 23 && m <= 59).then_some(h * 60 + m)
}

impl QuietHours {
    pub fn from_value(v: Option<&Value>) -> Self {
        let q = js::record(v);
        let time = |k: &str, d: &str| {
            q.and_then(|q| q.get(k)).and_then(Value::as_str).filter(|t| minutes_of(t).is_some()).unwrap_or(d).to_string()
        };
        Self {
            enabled: q.and_then(|q| q.get("enabled")) == Some(&Value::Bool(true)),
            start: time("start", "22:00"),
            end: time("end", "07:00"),
        }
    }

    /// `inQuietHours(quiet, now)` at the local time of `now_ms`. An empty range (start = end) never suppresses.
    pub fn contains(&self, now_ms: f64) -> bool {
        let (Some(start), Some(end)) = (minutes_of(&self.start), minutes_of(&self.end)) else { return false };
        if !self.enabled || start == end {
            return false;
        }
        let t = local_fields(now_ms);
        let minute = t.hour * 60 + t.minute;
        if start < end { minute >= start && minute < end } else { minute >= start || minute < end }
    }
}

/// The part of `AlertSettings` the limit warnings read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AlertSettings {
    /// The master switch.
    pub enabled: bool,
    pub quiet_hours: QuietHours,
    pub limits: LimitAlertSettings,
}

impl AlertSettings {
    /// From `state.settings.alerts` (normalized by the state; missing fields take their defaults).
    pub fn from_value(v: Option<&Value>) -> Self {
        let r = js::record(v);
        Self {
            enabled: r.and_then(|r| r.get("enabled")).and_then(Value::as_bool).unwrap_or(true),
            quiet_hours: QuietHours::from_value(r.and_then(|r| r.get("quietHours"))),
            limits: LimitAlertSettings::from_value(r.and_then(|r| r.get("limits"))),
        }
    }

    /// `limitPollingWanted`: whether any limit warning can be raised (polling continues while the window is hidden).
    pub fn limit_polling_wanted(&self) -> bool {
        self.enabled && self.limits.enabled && (self.limits.five_hour.enabled || self.limits.seven_day.enabled)
    }
}

/// `LimitMark`.
#[derive(Debug, Clone, PartialEq)]
pub struct LimitMark {
    pub provider: Provider,
    pub email: Option<String>,
    /// Epoch seconds when the period the mark is about ends.
    pub resets_at: f64,
    pub notified: bool,
}

impl LimitMark {
    fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("provider".into(), self.provider.as_str().into());
        if let Some(e) = &self.email {
            m.insert("email".into(), e.clone().into());
        }
        m.insert("resetsAt".into(), js::num(self.resets_at));
        m.insert("notified".into(), self.notified.into());
        Value::Object(m)
    }
}

/// `LimitMemory`, in insertion order (like the JS object).
pub type LimitMemory = Vec<(String, LimitMark)>;

fn get<'a>(memory: &'a LimitMemory, key: &str) -> Option<&'a LimitMark> {
    memory.iter().find(|(k, _)| k == key).map(|(_, m)| m)
}

fn set(memory: &mut LimitMemory, key: &str, mark: LimitMark) {
    match memory.iter_mut().find(|(k, _)| k == key) {
        Some((_, m)) => *m = mark,
        None => memory.push((key.to_string(), mark)),
    }
}

pub fn memory_to_value(memory: &LimitMemory) -> Value {
    Value::Object(memory.iter().map(|(k, m)| (k.clone(), m.to_value())).collect())
}

/// `LimitNotice`.
#[derive(Debug, Clone, PartialEq)]
pub struct LimitNotice {
    pub reset: bool,
    pub provider: Provider,
    pub email: Option<String>,
    pub window: WindowId,
    /// Used percent (threshold notices).
    pub percent: Option<f64>,
    /// Epoch seconds of the reset.
    pub resets_at: f64,
}

/// A reset time that moved by more than this is another period (the endpoints report the same period with some jitter).
const SAME_PERIOD_S: f64 = 10.0 * 60.0;
/// A reset older than this when it is noticed (the app was closed or asleep) is not announced any more.
pub const RESET_NOTICE_MAX_AGE_MS: f64 = 60.0 * 60_000.0;
const MAX_MARKS: usize = 200;

/// `limitKey`: provider, account (e-mail, else card id) and window.
pub fn limit_key(usage: &ProviderUsage, window: WindowId) -> String {
    let who = usage.email.as_deref().filter(|e| !e.is_empty()).unwrap_or(&usage.account_id);
    format!("{}:{}:{}", usage.provider.as_str(), who.to_lowercase(), window.as_str())
}

/// Numbers current enough to warn about: a valid sign-in read now.
fn warnable(usage: &ProviderUsage) -> bool {
    usage.status == Status::Ok && usage.source != Source::Cache && card_state(usage) != CardState::Expired
}

/// `evaluateLimits`.
pub fn evaluate_limits(
    memory: &LimitMemory,
    providers: &[ProviderUsage],
    settings: &LimitAlertSettings,
    now_ms: f64,
) -> (LimitMemory, Vec<LimitNotice>) {
    // Periods that ended go first (with their "available again" notices), so a new period starts from a clean mark.
    let (mut next, mut notices) = due_resets(memory, providers, settings, now_ms);
    if settings.enabled {
        for usage in providers.iter().filter(|u| warnable(u)) {
            for window in &usage.windows {
                let threshold = settings.threshold(window.id);
                if !threshold.enabled || window.resets_at <= 0.0 || window.resets_at * 1000.0 <= now_ms {
                    continue;
                }
                let key = limit_key(usage, window.id);
                let mark = get(&next, &key).cloned();
                let same_period = mark.as_ref().is_some_and(|m| {
                    m.resets_at * 1000.0 > now_ms && (window.resets_at - m.resets_at).abs() <= SAME_PERIOD_S
                });
                let mut current = match (&mark, same_period) {
                    (Some(m), true) => LimitMark {
                        resets_at: window.resets_at,
                        email: usage.email.clone().or(m.email.clone()),
                        ..m.clone()
                    },
                    _ => LimitMark {
                        provider: usage.provider,
                        email: usage.email.clone(),
                        resets_at: window.resets_at,
                        notified: false,
                    },
                };
                let percent = clamp_percent(window.used_percent);
                if !current.notified && percent >= f64::from(threshold.percent) {
                    current.notified = true;
                    notices.push(LimitNotice {
                        reset: false,
                        provider: usage.provider,
                        email: usage.email.clone(),
                        window: window.id,
                        percent: Some(js_round(percent)),
                        resets_at: window.resets_at,
                    });
                }
                // Nothing to remember for a window below its threshold whose period was not told about.
                if current.notified || mark.is_some() {
                    set(&mut next, &key, current);
                }
            }
        }
    }
    (prune(next, now_ms), notices)
}

/// `dueResets`: windows told about whose reset time passed: their marks go and, with `resets` on, each gets an "available
/// again" notice (not for an account whose sign-in expired since, and not for a reset long past).
pub fn due_resets(
    memory: &LimitMemory,
    providers: &[ProviderUsage],
    settings: &LimitAlertSettings,
    now_ms: f64,
) -> (LimitMemory, Vec<LimitNotice>) {
    let mut next = memory.clone();
    let mut notices = Vec::new();
    for (key, mark) in memory {
        if mark.resets_at * 1000.0 > now_ms {
            continue;
        }
        next.retain(|(k, _)| k != key);
        if !mark.notified || !settings.enabled || !settings.resets || now_ms - mark.resets_at * 1000.0 > RESET_NOTICE_MAX_AGE_MS {
            continue;
        }
        let window = if key.ends_with(":5h") { WindowId::FiveHour } else { WindowId::SevenDay };
        if !settings.threshold(window).enabled {
            continue;
        }
        if providers.iter().find(|u| limit_key(u, window) == *key).is_some_and(|u| card_state(u) == CardState::Expired) {
            continue;
        }
        notices.push(LimitNotice {
            reset: true,
            provider: mark.provider,
            email: mark.email.clone(),
            window,
            percent: None,
            resets_at: mark.resets_at,
        });
    }
    (next, notices)
}

/// `nextReset`: when the next notified window resets (epoch ms).
pub fn next_reset(memory: &LimitMemory) -> Option<f64> {
    memory.iter().filter(|(_, m)| m.notified).map(|(_, m)| m.resets_at * 1000.0).reduce(f64::min)
}

/// Keeps the memory small: the marks of the latest periods only.
fn prune(memory: LimitMemory, now_ms: f64) -> LimitMemory {
    let mut kept: LimitMemory =
        memory.into_iter().filter(|(_, m)| m.resets_at * 1000.0 > now_ms - RESET_NOTICE_MAX_AGE_MS).collect();
    kept.sort_by(|(_, a), (_, b)| b.resets_at.partial_cmp(&a.resets_at).unwrap_or(std::cmp::Ordering::Equal));
    kept.truncate(MAX_MARKS);
    kept
}

/// `/^(claude|codex):.{1,160}:(5h|7d)$/`.
fn is_mark_key(key: &str) -> bool {
    let Some(rest) = key.strip_prefix("claude:").or_else(|| key.strip_prefix("codex:")) else { return false };
    let Some(middle) = rest.strip_suffix(":5h").or_else(|| rest.strip_suffix(":7d")) else { return false };
    let len = js::len16(middle);
    (1..=160).contains(&len) && !middle.chars().any(js::is_line_terminator)
}

/// `normalizeLimitMemory`: damaged entries are dropped.
pub fn normalize_limit_memory(value: Option<&Value>) -> LimitMemory {
    let Some(m) = js::record(value) else { return Vec::new() };
    let mut out = Vec::new();
    for (key, raw) in m {
        let Some(raw) = raw.as_object() else { continue };
        if !is_mark_key(key) {
            continue;
        }
        let Some(provider) = raw.get("provider").and_then(Value::as_str).and_then(Provider::parse) else { continue };
        let Some(resets_at) = js::finite(raw.get("resetsAt")).filter(|r| *r > 0.0) else { continue };
        let Some(notified) = raw.get("notified").and_then(Value::as_bool) else { continue };
        let email = raw.get("email").and_then(Value::as_str).filter(|e| !e.is_empty() && js::len16(e) <= 120).map(str::to_string);
        out.push((key.clone(), LimitMark { provider, email, resets_at, notified }));
    }
    out
}

type Fn0<T> = Arc<dyn Fn() -> T + Send + Sync>;

/// `LimitAlerterOptions`.
pub struct LimitAlerterOptions {
    /// `limit-alerts.json`: the told windows (so a restart does not repeat a warning); no credentials.
    pub file: PathBuf,
    pub alerts: Fn0<AlertSettings>,
    pub show: Arc<dyn Fn(&LimitNotice) + Send + Sync>,
    /// The accounts as last known (for the reset timer, which runs without a new state).
    pub providers: Fn0<Vec<ProviderUsage>>,
    pub now: Fn0<f64>,
    pub rt: tokio::runtime::Handle,
}

/// `LimitAlerter`: the memory of told windows, what to tell on every state and at the reset times; the alerts master
/// switch and quiet hours silence a notice (the window still counts as told).
pub struct LimitAlerter {
    o: LimitAlerterOptions,
    memory: Mutex<LimitMemory>,
    timer: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl LimitAlerter {
    pub fn new(o: LimitAlerterOptions) -> Arc<Self> {
        let memory = Self::load(&o.file);
        Arc::new(Self { o, memory: Mutex::new(memory), timer: Mutex::new(None) })
    }

    /// A new state of the accounts (after every poll).
    pub fn on_state(self: &Arc<Self>, providers: &[ProviderUsage]) {
        let memory = self.memory.lock().clone();
        let (next, notices) = evaluate_limits(&memory, providers, &(self.o.alerts)().limits, (self.o.now)());
        self.apply(next, notices);
    }

    /// After the settings changed: the reset timer follows the "available again" switch.
    pub fn settings_changed(self: &Arc<Self>) {
        self.arm();
    }

    pub fn dispose(&self) {
        if let Some(t) = self.timer.lock().take() {
            t.abort();
        }
    }

    pub fn snapshot(&self) -> LimitMemory {
        self.memory.lock().clone()
    }

    fn apply(self: &Arc<Self>, next: LimitMemory, notices: Vec<LimitNotice>) {
        let changed = {
            let mut m = self.memory.lock();
            let changed = *m != next;
            *m = next;
            changed
        };
        if changed {
            self.save();
        }
        let alerts = (self.o.alerts)();
        if !notices.is_empty() && alerts.enabled && !alerts.quiet_hours.contains((self.o.now)()) {
            for notice in &notices {
                // One failed notification must not stop the others.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.o.show)(notice)));
            }
        }
        self.arm();
    }

    /// A timer at the next reset of a told window: the "available again" notice comes on time, also without a poll.
    fn arm(self: &Arc<Self>) {
        self.dispose();
        let Some(at) = next_reset(&self.memory.lock()) else { return };
        // At least a second later (the reset must have passed), at most a day (timers drift over sleep; it re-arms).
        let delay = (24.0 * 3_600_000.0f64).min(1_000f64.max(at - (self.o.now)() + 1_000.0));
        let weak = Arc::downgrade(self);
        let task = self.o.rt.spawn(async move {
            tokio::time::sleep(Duration::from_millis(delay as u64)).await;
            let Some(me) = weak.upgrade() else { return };
            // The handle of this task is dropped by the re-arm below (apply -> arm): it is not aborted mid-way.
            me.timer.lock().take();
            let memory = me.memory.lock().clone();
            let (next, notices) = due_resets(&memory, &(me.o.providers)(), &(me.o.alerts)().limits, (me.o.now)());
            me.apply(next, notices);
        });
        *self.timer.lock() = Some(task);
    }

    fn load(file: &std::path::Path) -> LimitMemory {
        let Ok(text) = js::read_text(file) else { return Vec::new() };
        let Ok(raw) = unimux_core::js_json::parse(&text) else { return Vec::new() };
        if raw.get("version").and_then(Value::as_f64) == Some(1.0) { normalize_limit_memory(raw.get("marks")) } else { Vec::new() }
    }

    fn save(&self) {
        let mut m = Map::new();
        m.insert("version".into(), 1.into());
        m.insert("marks".into(), memory_to_value(&self.memory.lock()));
        let text = serde_json::to_string(&Value::Object(m)).unwrap_or_default();
        // The memory is optional: at worst a warning repeats after a restart.
        if let Some(dir) = self.o.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = unimux_core::atomic_write::atomic_write(
            &self.o.file,
            text.as_bytes(),
            &unimux_core::atomic_write::AtomicWriteOptions::default(),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::usage::types::UsageWindow;
    use serde_json::json;

    const NOW: f64 = 1_791_720_000_000.0;

    fn usage(email: &str, five: f64, resets: f64) -> ProviderUsage {
        let mut u = ProviderUsage::new("claude:main", Provider::Claude, Status::Ok, NOW, Source::Live);
        u.email = Some(email.into());
        u.windows.push(UsageWindow { id: WindowId::FiveHour, used_percent: five, resets_at: resets });
        u
    }

    #[test]
    fn a_threshold_is_told_once_per_period_and_a_new_period_re_arms_it() {
        let s = LimitAlertSettings::default();
        let resets = NOW / 1000.0 + 3600.0;
        let (m, n) = evaluate_limits(&Vec::new(), &[usage("A@x.io", 79.0, resets)], &s, NOW);
        assert!(m.is_empty() && n.is_empty());
        let (m, n) = evaluate_limits(&m, &[usage("A@x.io", 81.4, resets)], &s, NOW);
        assert_eq!(n.len(), 1);
        assert_eq!((n[0].percent, n[0].window, n[0].reset), (Some(81.0), WindowId::FiveHour, false));
        assert_eq!(m[0].0, "claude:a@x.io:5h");
        // Jitter of the reset time: same period, nothing new.
        let (m, n) = evaluate_limits(&m, &[usage("a@x.io", 95.0, resets + 300.0)], &s, NOW);
        assert!(n.is_empty());
        // Another period.
        let (_, n) = evaluate_limits(&m, &[usage("a@x.io", 95.0, resets + 7200.0)], &s, NOW);
        assert_eq!(n.len(), 1);
        // Cached numbers never warn.
        let mut cached = usage("b@x.io", 99.0, resets);
        cached.source = Source::Cache;
        assert!(evaluate_limits(&Vec::new(), &[cached], &s, NOW).1.is_empty());
    }

    #[test]
    fn resets_are_announced_only_when_asked_and_recent() {
        let mut s = LimitAlertSettings::default();
        let resets = NOW / 1000.0 + 60.0;
        let (m, _) = evaluate_limits(&Vec::new(), &[usage("a@x.io", 90.0, resets)], &s, NOW);
        assert_eq!(next_reset(&m), Some(resets * 1000.0));
        let later = resets * 1000.0 + 1000.0;
        let (m2, n) = due_resets(&m, &[], &s, later);
        assert!(m2.is_empty() && n.is_empty());
        s.resets = true;
        let (_, n) = due_resets(&m, &[], &s, later);
        assert!(n[0].reset);
        let (_, n) = due_resets(&m, &[], &s, later + RESET_NOTICE_MAX_AGE_MS);
        assert!(n.is_empty());
        let mut expired = usage("a@x.io", 90.0, resets);
        expired.status = Status::Expired;
        assert!(due_resets(&m, &[expired], &s, later).1.is_empty());
    }

    #[test]
    fn memory_round_trip_and_damaged_entries() {
        let raw = json!({
            "claude:a@x.io:5h": { "provider": "claude", "email": "a@x.io", "resetsAt": 5, "notified": true },
            "claude::5h": { "provider": "claude", "resetsAt": 5, "notified": true },
            "codex:b:7d": { "provider": "codex", "resetsAt": 0, "notified": true },
            "codex:c:7d": { "provider": "x", "resetsAt": 1, "notified": true },
        });
        let m = normalize_limit_memory(Some(&raw));
        assert_eq!(m.len(), 1);
        assert_eq!(
            memory_to_value(&m).to_string(),
            r#"{"claude:a@x.io:5h":{"provider":"claude","email":"a@x.io","resetsAt":5,"notified":true}}"#
        );
    }

    #[test]
    fn quiet_hours_wrap_midnight() {
        let at = |h: u32, m: u32| {
            // A local wall time today.
            let f = local_fields(NOW);
            let wall = (crate::localtime::days_from_civil(f.year, i64::from(f.month), i64::from(f.day)) * 86_400_000) as f64
                + f64::from(h * 3600 + m * 60) * 1000.0;
            crate::localtime::local_to_utc(wall)
        };
        let q = QuietHours { enabled: true, start: "22:00".into(), end: "07:00".into() };
        assert!(q.contains(at(23, 0)) && q.contains(at(6, 59)) && !q.contains(at(7, 0)) && !q.contains(at(12, 0)));
        let day = QuietHours { enabled: true, start: "09:00".into(), end: "17:00".into() };
        assert!(day.contains(at(9, 0)) && !day.contains(at(17, 0)));
        assert!(!QuietHours { enabled: true, start: "10:00".into(), end: "10:00".into() }.contains(at(10, 0)));
        assert!(!QuietHours { enabled: false, ..q }.contains(at(23, 0)));
    }
}
