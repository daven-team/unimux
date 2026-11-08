//! 1.1.2: switching the main AI account automatically when it nears a limit (ports of src/shared/autoSwitch.ts and
//! src/main/autoSwitch.ts). The pure part decides (cooldown, no ping-pong, one notice per limit period); [`AutoSwitcher`]
//! runs it after every new state of the limits, keeps `auto-switch.json` (version 1) and does the switch through the same
//! "make main" as the card's menu, with the family rules checked again right before it.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Map, Value};

use crate::js;
use crate::limit_alerts::{WindowAlert, threshold_percent};
use crate::results::{SwapError, SwapResult};
use crate::usage::types::{
    CardState, Provider, ProviderUsage, Source, Status, WindowId, card_state, effective_percent, js_round,
};

/// `AutoSwitchMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// A notification with "Switch to X".
    Ask,
    /// At once, then a notification what happened.
    Switch,
}

pub const AUTO_SWITCH_COOLDOWNS: [u32; 4] = [5, 15, 30, 60];

/// `AutoSwitchSettings`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AutoSwitchSettings {
    pub enabled: bool,
    pub codex: bool,
    pub five_hour: WindowAlert,
    pub seven_day: WindowAlert,
    pub mode: Mode,
    pub cooldown_minutes: u32,
    /// Per provider: the account (an account key) to switch to; absent: the one with the most room.
    pub target: BTreeMap<Provider, String>,
    /// Per provider: the primary account the app returns to.
    pub primary: BTreeMap<Provider, String>,
    pub return_home: bool,
}

impl Default for AutoSwitchSettings {
    /// `defaultAutoSwitch`.
    fn default() -> Self {
        Self {
            enabled: false,
            codex: false,
            five_hour: WindowAlert { enabled: true, percent: 95 },
            seven_day: WindowAlert { enabled: true, percent: 98 },
            mode: Mode::Ask,
            cooldown_minutes: 15,
            target: BTreeMap::new(),
            primary: BTreeMap::new(),
            return_home: true,
        }
    }
}

fn is_key(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty() && js::len16(s) <= 160)
}

fn per_provider(v: Option<&Value>) -> BTreeMap<Provider, String> {
    let mut out = BTreeMap::new();
    if let Some(m) = js::record(v) {
        for p in Provider::ALL {
            if let Some(k) = is_key(m.get(p.as_str())) {
                out.insert(p, k.to_lowercase());
            }
        }
    }
    out
}

impl AutoSwitchSettings {
    /// `normalizeAutoSwitch` (`state.settings.accountSwitch`).
    pub fn from_value(v: Option<&Value>) -> Self {
        let r = js::record(v);
        let d = Self::default();
        let get = |k: &str| r.and_then(|r| r.get(k));
        Self {
            enabled: get("enabled").and_then(Value::as_bool).unwrap_or(d.enabled),
            codex: get("codex").and_then(Value::as_bool).unwrap_or(d.codex),
            five_hour: WindowAlert::from_value(get("fiveHour"), d.five_hour),
            seven_day: WindowAlert::from_value(get("sevenDay"), d.seven_day),
            mode: match get("mode").and_then(Value::as_str) {
                Some("switch") => Mode::Switch,
                Some("ask") => Mode::Ask,
                _ => d.mode,
            },
            cooldown_minutes: threshold_percent(get("cooldownMinutes"))
                .filter(|m| AUTO_SWITCH_COOLDOWNS.contains(m))
                .unwrap_or(d.cooldown_minutes),
            target: per_provider(get("target")),
            primary: per_provider(get("primary")),
            return_home: get("returnHome").and_then(Value::as_bool).unwrap_or(d.return_home),
        }
    }

    fn threshold(&self, window: WindowId) -> WindowAlert {
        if window == WindowId::FiveHour { self.five_hour } else { self.seven_day }
    }
}

/// `autoSwitchOn`: whether the automatic switch looks at this provider at all.
pub fn auto_switch_on(settings: &AutoSwitchSettings, provider: Provider) -> bool {
    if !settings.enabled || (!settings.five_hour.enabled && !settings.seven_day.enabled) {
        return false;
    }
    provider == Provider::Claude || settings.codex
}

/// `LeftMark` / `OfferMark`.
#[derive(Debug, Clone, PartialEq)]
pub struct Mark {
    pub provider: Provider,
    pub key: String,
    pub window: WindowId,
    pub resets_at: f64,
}

impl Mark {
    fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("provider".into(), self.provider.as_str().into());
        m.insert("key".into(), self.key.clone().into());
        m.insert("window".into(), self.window.as_str().into());
        m.insert("resetsAt".into(), js::num(self.resets_at));
        Value::Object(m)
    }
}

/// `AutoSwitchMemory`.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct AutoSwitchMemory {
    /// Epoch ms of the last switch or attempt per provider (the cooldown).
    pub last: BTreeMap<Provider, f64>,
    pub left: Vec<Mark>,
    pub offered: Vec<Mark>,
    /// Per provider: the primary account the app left; it returns there after the reset.
    pub away: BTreeMap<Provider, String>,
}

fn provider_map<T>(m: &BTreeMap<Provider, T>, f: impl Fn(&T) -> Value) -> Value {
    Value::Object(m.iter().map(|(p, v)| (p.as_str().to_string(), f(v))).collect())
}

impl AutoSwitchMemory {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("last".into(), provider_map(&self.last, |v| js::num(*v)));
        m.insert("left".into(), Value::Array(self.left.iter().map(Mark::to_value).collect()));
        m.insert("offered".into(), Value::Array(self.offered.iter().map(Mark::to_value).collect()));
        m.insert("away".into(), provider_map(&self.away, |v| v.clone().into()));
        Value::Object(m)
    }

    /// `switchAway` of the usage state.
    pub fn away_value(&self) -> Map<String, Value> {
        self.away.iter().map(|(p, v)| (p.as_str().to_string(), Value::String(v.clone()))).collect()
    }
}

/// Two periods whose reset times differ by less than this are the same period.
const SAME_PERIOD_S: f64 = 10.0 * 60.0;
/// A candidate's numbers older than this are not trusted for a switch.
pub const CANDIDATE_MAX_AGE_MS: f64 = 20.0 * 60_000.0;
/// Two candidates with room within this many percent are equal; the earlier reset decides.
const ROOM_TIE: f64 = 1.0;
const MAX_MARKS: usize = 50;
/// How long a return offer is not repeated.
const RETURN_OFFER_S: f64 = 5.0 * 3600.0;

/// `accountKey`: its e-mail, else its card id (never a token).
pub fn account_key(usage: &ProviderUsage) -> String {
    usage.email.as_deref().filter(|e| !e.is_empty()).unwrap_or(&usage.account_id).to_lowercase()
}

/// `mainCard`: the card of the account each tool uses now.
pub fn main_card(providers: &[ProviderUsage], provider: Provider) -> Option<&ProviderUsage> {
    providers.iter().find(|u| u.provider == provider && u.active)
}

/// `roomOf`: unused part of the tightest window (0-100); an account without numbers has none.
pub fn room_of(usage: &ProviderUsage, now_ms: f64) -> f64 {
    usage.windows.iter().map(|w| 100.0 - effective_percent(w, now_ms)).reduce(f64::min).unwrap_or(0.0)
}

fn next_reset_of(usage: &ProviderUsage, now_ms: f64) -> f64 {
    usage
        .windows
        .iter()
        .map(|w| w.resets_at)
        .filter(|at| *at > 0.0 && at * 1000.0 > now_ms)
        .reduce(f64::min)
        .unwrap_or(f64::INFINITY)
}

/// `Trigger`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Trigger {
    pub window: WindowId,
    pub percent: f64,
    pub resets_at: f64,
}

/// Numbers read now: remembered ones, a failed read or an expired sign-in never count.
fn current(usage: &ProviderUsage) -> bool {
    usage.status == Status::Ok && usage.source != Source::Cache && card_state(usage) != CardState::Expired
}

/// `switchTrigger`: the window of the main account at or above its threshold (the fuller one when both are).
pub fn switch_trigger(main: &ProviderUsage, settings: &AutoSwitchSettings, now_ms: f64) -> Option<Trigger> {
    if !current(main) {
        return None;
    }
    let mut found: Option<Trigger> = None;
    for w in &main.windows {
        let t = settings.threshold(w.id);
        if !t.enabled || w.resets_at <= 0.0 || w.resets_at * 1000.0 <= now_ms {
            continue;
        }
        let percent = effective_percent(w, now_ms);
        if percent < f64::from(t.percent) {
            continue;
        }
        if found.is_none_or(|f| percent > f.percent) {
            found = Some(Trigger { window: w.id, percent: js_round(percent), resets_at: w.resets_at });
        }
    }
    found
}

fn blocked_by_left(memory: &AutoSwitchMemory, provider: Provider, key: &str, now_ms: f64) -> bool {
    memory.left.iter().any(|m| m.provider == provider && m.key == key && m.resets_at * 1000.0 > now_ms)
}

/// A saved account whose sign-in and numbers can be trusted for a switch (no threshold check).
fn usable_copy(usage: &ProviderUsage, provider: Provider, now_ms: f64, max_age_ms: f64) -> bool {
    if usage.provider != provider || usage.active || usage.managed != Some(true) {
        return false;
    }
    if usage.status != Status::Ok || usage.source != Source::Live || card_state(usage) != CardState::Ok {
        return false;
    }
    if now_ms - usage.fetched_at > max_age_ms {
        return false;
    }
    // A copy the live login or an outside switch holds may be outdated; one cswap also holds is checked again by the swap.
    if usage.held_by.is_some_and(|h| h != crate::usage::HeldBy::Cswap) {
        return false;
    }
    !usage.windows.is_empty() && !usage.windows.iter().any(|w| effective_percent(w, now_ms) >= 100.0)
}

fn below_thresholds(usage: &ProviderUsage, settings: &AutoSwitchSettings, now_ms: f64) -> bool {
    usage.windows.iter().all(|w| {
        let t = settings.threshold(w.id);
        !t.enabled || effective_percent(w, now_ms) < f64::from(t.percent)
    })
}

/// `Array.prototype.sort` for short arrays as V8 does it (stable binary insertion), so a comparator that is not a strict
/// total order (the room tie) orders exactly like 1.1.4.
fn js_sort<T>(items: &mut Vec<T>, cmp: impl Fn(&T, &T) -> f64) {
    for i in 1..items.len() {
        let mut left = 0;
        let mut right = i;
        while left < right {
            let mid = left + ((right - left) >> 1);
            if cmp(&items[i], &items[mid]) < 0.0 { right = mid } else { left = mid + 1 }
        }
        let pivot = items.remove(i);
        items.insert(left, pivot);
    }
}

/// `rankCandidates`: saved accounts of `provider` that could take over, best first.
pub fn rank_candidates(
    providers: &[ProviderUsage],
    provider: Provider,
    settings: &AutoSwitchSettings,
    memory: &AutoSwitchMemory,
    now_ms: f64,
    ignore_left: bool,
) -> Vec<ProviderUsage> {
    let main_key = main_card(providers, provider).map(account_key);
    let mut usable: Vec<ProviderUsage> = providers
        .iter()
        .filter(|u| {
            if !usable_copy(u, provider, now_ms, CANDIDATE_MAX_AGE_MS) {
                return false;
            }
            let key = account_key(u);
            if Some(&key) == main_key.as_ref() {
                return false;
            }
            if !ignore_left && blocked_by_left(memory, provider, &key, now_ms) {
                return false;
            }
            below_thresholds(u, settings, now_ms)
        })
        .cloned()
        .collect();
    js_sort(&mut usable, |a, b| {
        let room = room_of(b, now_ms) - room_of(a, now_ms);
        if room.abs() >= ROOM_TIE {
            return room;
        }
        let (ra, rb) = (next_reset_of(a, now_ms), next_reset_of(b, now_ms));
        if ra != rb {
            return if ra < rb { -1.0 } else { 1.0 };
        }
        if room != 0.0 {
            return room;
        }
        match account_key(a).cmp(&account_key(b)) {
            std::cmp::Ordering::Less => -1.0,
            std::cmp::Ordering::Equal => 0.0,
            std::cmp::Ordering::Greater => 1.0,
        }
    });
    usable
}

fn chosen(candidates: Vec<ProviderUsage>, settings: &AutoSwitchSettings, provider: Provider) -> Vec<ProviderUsage> {
    match settings.target.get(&provider) {
        Some(t) => candidates.into_iter().filter(|u| account_key(u) == *t).collect(),
        None => candidates,
    }
}

/// `nextAvailable`: when the first account is back below the thresholds (with its e-mail).
pub fn next_available(
    providers: &[ProviderUsage],
    provider: Provider,
    settings: &AutoSwitchSettings,
    now_ms: f64,
    only_key: Option<&str>,
) -> Option<(Option<String>, f64)> {
    let mut best: Option<(Option<String>, f64)> = None;
    for u in providers {
        if u.provider != provider
            || only_key.is_some_and(|k| !k.is_empty() && account_key(u) != k)
            || card_state(u) == CardState::Expired
            || u.windows.is_empty()
        {
            continue;
        }
        let at = u
            .windows
            .iter()
            .filter(|w| {
                let t = settings.threshold(w.id);
                t.enabled && effective_percent(w, now_ms) >= f64::from(t.percent) && w.resets_at * 1000.0 > now_ms
            })
            .map(|w| w.resets_at)
            .reduce(f64::max);
        let Some(at) = at else { continue };
        if best.as_ref().is_none_or(|(_, b)| at < *b) {
            best = Some((u.email.clone().filter(|e| !e.is_empty()), at));
        }
    }
    best
}

/// Why nothing happens (`AutoSwitchSkip`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Skip {
    Off,
    NoMain,
    Below,
    Cooldown,
    Offered,
    NoCandidate,
}

/// `reason` of a switch or offer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Limit,
    /// Back to the primary account (no trigger: the main account may be fine).
    Return,
}

/// `AutoSwitchPlan`.
#[derive(Debug, Clone, PartialEq)]
pub enum Plan {
    None(Skip),
    Act {
        switch: bool,
        reason: Reason,
        from: ProviderUsage,
        trigger: Option<Trigger>,
        candidates: Vec<ProviderUsage>,
    },
    /// No account has room: told once per limit period of the main account.
    Exhausted {
        from: ProviderUsage,
        trigger: Trigger,
        next: Option<(Option<String>, f64)>,
        target: Option<String>,
    },
}

fn told(memory: &AutoSwitchMemory, provider: Provider, key: &str, window: WindowId, resets_at: f64) -> bool {
    memory
        .offered
        .iter()
        .any(|m| m.provider == provider && m.key == key && m.window == window && (m.resets_at - resets_at).abs() <= SAME_PERIOD_S)
}

/// `offerKey`.
pub fn offer_key(kind: &str, key: &str) -> String {
    if kind == "limit" { key.to_string() } else { format!("{kind}:{key}") }
}

/// `planAutoSwitch`.
pub fn plan_auto_switch(
    providers: &[ProviderUsage],
    provider: Provider,
    settings: &AutoSwitchSettings,
    memory: &AutoSwitchMemory,
    now_ms: f64,
) -> Plan {
    if !auto_switch_on(settings, provider) {
        return Plan::None(Skip::Off);
    }
    let Some(from) = main_card(providers, provider) else { return Plan::None(Skip::NoMain) };
    let cooling = memory
        .last
        .get(&provider)
        .is_some_and(|last| now_ms >= *last && now_ms - last < f64::from(settings.cooldown_minutes) * 60_000.0);
    let switch = settings.mode == Mode::Switch;
    let key = account_key(from);
    let candidates = rank_candidates(providers, provider, settings, memory, now_ms, false);
    // Back to the primary account once it was left and is usable again.
    if let Some(primary) = settings.primary.get(&provider)
        && settings.return_home
        && memory.away.get(&provider) == Some(primary)
        && key != *primary
        && !cooling
    {
        let home = candidates.iter().find(|u| account_key(u) == *primary);
        let offered_back = memory
            .offered
            .iter()
            .any(|m| m.provider == provider && m.key == offer_key("return", primary) && m.resets_at * 1000.0 > now_ms);
        if let Some(home) = home
            && !(!switch && offered_back)
        {
            return Plan::Act {
                switch,
                reason: Reason::Return,
                from: from.clone(),
                trigger: None,
                candidates: vec![home.clone()],
            };
        }
    }
    let Some(trigger) = switch_trigger(from, settings, now_ms) else { return Plan::None(Skip::Below) };
    if cooling {
        return Plan::None(Skip::Cooldown);
    }
    if !switch && told(memory, provider, &offer_key("limit", &key), trigger.window, trigger.resets_at) {
        return Plan::None(Skip::Offered);
    }
    let usable = chosen(candidates, settings, provider);
    if usable.is_empty() {
        // "All accounts are over the threshold" only when that is known: some other saved account exists and none of them
        // is still waiting for its numbers.
        let target = settings.target.get(&provider);
        let others: Vec<&ProviderUsage> = providers
            .iter()
            .filter(|u| {
                u.provider == provider
                    && u.managed == Some(true)
                    && !u.active
                    && card_state(u) != CardState::Expired
                    && target.is_none_or(|t| account_key(u) == *t)
            })
            .collect();
        let unknown = others.iter().any(|u| {
            u.status != Status::Ok
                || u.source != Source::Live
                || u.windows.is_empty()
                || now_ms - u.fetched_at > CANDIDATE_MAX_AGE_MS
        });
        if others.is_empty() || unknown {
            return Plan::None(Skip::NoCandidate);
        }
        if told(memory, provider, &offer_key("exhausted", &key), trigger.window, trigger.resets_at) {
            return Plan::None(Skip::NoCandidate);
        }
        let next = next_available(providers, provider, settings, now_ms, target.map(String::as_str));
        return Plan::Exhausted { from: from.clone(), trigger, next, target: target.cloned() };
    }
    Plan::Act { switch, reason: Reason::Limit, from: from.clone(), trigger: Some(trigger), candidates: usable }
}

/// `manualCandidates`: the user's "switch now": the chosen account (`to`) or every usable saved account with more room than
/// the main one, best first. Thresholds still apply; the no-ping-pong marks do not.
pub fn manual_candidates(
    providers: &[ProviderUsage],
    provider: Provider,
    settings: &AutoSwitchSettings,
    now_ms: f64,
    to: Option<&str>,
) -> Vec<ProviderUsage> {
    let all = rank_candidates(providers, provider, settings, &AutoSwitchMemory::default(), now_ms, true);
    if let Some(to) = to.filter(|t| !t.is_empty()) {
        return all.into_iter().filter(|u| account_key(u) == to).collect();
    }
    let main_room = match main_card(providers, provider) {
        Some(m) if current(m) && !m.windows.is_empty() => room_of(m, now_ms),
        _ => -1.0,
    };
    all.into_iter().filter(|u| room_of(u, now_ms) > main_room).collect()
}

fn prune(memory: AutoSwitchMemory, now_ms: f64) -> AutoSwitchMemory {
    let ahead = |marks: Vec<Mark>| {
        let kept: Vec<Mark> = marks.into_iter().filter(|m| m.resets_at * 1000.0 > now_ms).collect();
        let skip = kept.len().saturating_sub(MAX_MARKS);
        kept.into_iter().skip(skip).collect::<Vec<_>>()
    };
    AutoSwitchMemory { last: memory.last, left: ahead(memory.left), offered: ahead(memory.offered), away: memory.away }
}

/// `rememberSwitch`: the cooldown starts; an account left because of a limit stays out until that limit resets; leaving
/// the primary account remembers it (return home), reaching it forgets that.
pub fn remember_switch(
    memory: &AutoSwitchMemory,
    provider: Provider,
    from: &ProviderUsage,
    trigger: Option<Trigger>,
    now_ms: f64,
    to_key: Option<&str>,
    primary: Option<&str>,
) -> AutoSwitchMemory {
    let from_key = account_key(from);
    let left = match trigger {
        Some(t) => {
            let mut left: Vec<Mark> =
                memory.left.iter().filter(|m| !(m.provider == provider && m.key == from_key)).cloned().collect();
            left.push(Mark { provider, key: from_key.clone(), window: t.window, resets_at: t.resets_at });
            left
        }
        None => memory.left.clone(),
    };
    let mut away = memory.away.clone();
    match (to_key, primary) {
        (Some(to), Some(p)) if to == p => {
            away.remove(&provider);
        }
        (Some(_), Some(p)) if from_key == p => {
            away.insert(provider, p.to_string());
        }
        _ => {}
    }
    let mut last = memory.last.clone();
    last.insert(provider, now_ms);
    prune(AutoSwitchMemory { last, left, offered: memory.offered.clone(), away }, now_ms)
}

/// `rememberTold`: the memory after a notice was shown.
pub fn remember_told(
    memory: &AutoSwitchMemory,
    provider: Provider,
    key: &str,
    window: WindowId,
    resets_at: f64,
    now_ms: f64,
) -> AutoSwitchMemory {
    let mut m = memory.clone();
    m.offered.push(Mark { provider, key: key.to_string(), window, resets_at });
    prune(m, now_ms)
}

/// `returnOfferMark`: a return offer has no limit period; it is not repeated for a few hours.
pub fn return_offer_mark(now_ms: f64) -> (WindowId, f64) {
    (WindowId::FiveHour, (now_ms / 1000.0).floor() + RETURN_OFFER_S)
}

/// `normalizeAutoSwitchMemory`: damaged entries are dropped.
pub fn normalize_auto_switch_memory(value: Option<&Value>) -> AutoSwitchMemory {
    let Some(v) = js::record(value) else { return AutoSwitchMemory::default() };
    let mut last = BTreeMap::new();
    if let Some(l) = js::record(v.get("last")) {
        for p in Provider::ALL {
            if let Some(at) = js::finite(l.get(p.as_str())).filter(|a| *a > 0.0) {
                last.insert(p, at);
            }
        }
    }
    let marks = |raw: Option<&Value>| -> Vec<Mark> {
        let all: Vec<Mark> = raw
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter_map(|m| {
                        let m = m.as_object()?;
                        let provider = m.get("provider").and_then(Value::as_str).and_then(Provider::parse)?;
                        let key = is_key(m.get("key"))?.to_string();
                        let window = m.get("window").and_then(Value::as_str).and_then(WindowId::parse)?;
                        let resets_at = js::finite(m.get("resetsAt")).filter(|r| *r > 0.0)?;
                        Some(Mark { provider, key, window, resets_at })
                    })
                    .collect()
            })
            .unwrap_or_default();
        let skip = all.len().saturating_sub(MAX_MARKS);
        all.into_iter().skip(skip).collect()
    };
    AutoSwitchMemory { last, left: marks(v.get("left")), offered: marks(v.get("offered")), away: per_provider(v.get("away")) }
}

/// `SwitchOffer`: shown in the limits panel until taken, dismissed or no longer true.
#[derive(Debug, Clone, PartialEq)]
pub struct SwitchOffer {
    pub provider: Provider,
    pub reason: Reason,
    /// Card id of the proposed account (`claude:<record>` / `codex:<record>`).
    pub to: String,
    pub to_email: Option<String>,
    pub from_email: Option<String>,
    pub window: Option<WindowId>,
    pub percent: Option<f64>,
}

impl SwitchOffer {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("provider".into(), self.provider.as_str().into());
        m.insert("reason".into(), (if self.reason == Reason::Return { "return" } else { "limit" }).into());
        m.insert("to".into(), self.to.clone().into());
        if let Some(e) = &self.to_email {
            m.insert("toEmail".into(), e.clone().into());
        }
        if let Some(e) = &self.from_email {
            m.insert("fromEmail".into(), e.clone().into());
        }
        if let Some(w) = self.window {
            m.insert("window".into(), w.as_str().into());
        }
        if let Some(p) = self.percent {
            m.insert("percent".into(), js::num(p));
        }
        Value::Object(m)
    }
}

/// `SwitchNoticeKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeKind {
    Switched,
    Returned,
    Offer,
    ReturnOffer,
    Exhausted,
    Failed,
}

/// `SwitchNotice`.
#[derive(Debug, Clone, PartialEq)]
pub struct SwitchNotice {
    pub kind: NoticeKind,
    pub provider: Provider,
    pub from_email: Option<String>,
    pub to_email: Option<String>,
    pub window: Option<WindowId>,
    pub percent: Option<f64>,
    /// `Exhausted`: epoch seconds when the first account is usable again.
    pub resets_at: Option<f64>,
    /// `Exhausted` with a chosen target account.
    pub target_only: bool,
}

impl SwitchNotice {
    pub fn new(kind: NoticeKind, provider: Provider) -> Self {
        Self {
            kind,
            provider,
            from_email: None,
            to_email: None,
            window: None,
            percent: None,
            resets_at: None,
            target_only: false,
        }
    }
}

type Fn0<T> = Arc<dyn Fn() -> T + Send + Sync>;

/// `AutoSwitcherOptions`.
pub struct AutoSwitcherOptions {
    /// `auto-switch.json`: switches and notices (cooldown, no ping-pong, return home); never a credential.
    pub file: PathBuf,
    pub settings: Fn0<AutoSwitchSettings>,
    pub providers: Fn0<Vec<ProviderUsage>>,
    /// Whether switching this provider is possible on this system (Claude profiles need Windows or Linux).
    pub supported: Arc<dyn Fn(Provider) -> bool + Send + Sync>,
    /// A swap, a login or a recovery runs or is unresolved: nothing is switched (tried again on the next state).
    pub busy: Fn0<bool>,
    /// The family rules for the target, right before the switch; a refusal skips that candidate.
    pub validate: Arc<dyn Fn(Provider, String) -> BoxFuture<'static, Option<SwapResult>> + Send + Sync>,
    /// "Make main" of the card's account.
    pub swap: Arc<dyn Fn(Provider, String) -> BoxFuture<'static, SwapResult> + Send + Sync>,
    pub notify: Arc<dyn Fn(&SwitchNotice) + Send + Sync>,
    /// The offer or the memory shown in the limits panel changed.
    pub changed: Fn0<()>,
    pub now: Fn0<f64>,
    pub rt: tokio::runtime::Handle,
}

const RETRY_BUSY: Duration = Duration::from_secs(5);

struct Inner {
    memory: AutoSwitchMemory,
    offer: Option<SwitchOffer>,
    running: bool,
    pending: Option<Vec<ProviderUsage>>,
    retry: Option<tokio::task::JoinHandle<()>>,
}

/// `AutoSwitcher`.
pub struct AutoSwitcher {
    o: AutoSwitcherOptions,
    inner: Mutex<Inner>,
}

/// Clears `running` however the evaluation ends.
struct Running<'a>(&'a AutoSwitcher);

impl Drop for Running<'_> {
    fn drop(&mut self) {
        self.0.inner.lock().running = false;
    }
}

impl AutoSwitcher {
    pub fn new(o: AutoSwitcherOptions) -> Arc<Self> {
        let memory = Self::load(&o.file);
        Arc::new(Self { o, inner: Mutex::new(Inner { memory, offer: None, running: false, pending: None, retry: None }) })
    }

    pub fn current_offer(&self) -> Option<SwitchOffer> {
        self.inner.lock().offer.clone()
    }

    pub fn away(&self) -> Map<String, Value> {
        self.inner.lock().memory.away_value()
    }

    pub fn snapshot(&self) -> AutoSwitchMemory {
        self.inner.lock().memory.clone()
    }

    fn now(&self) -> f64 {
        (self.o.now)()
    }

    /// A new state of the accounts (after every poll). One evaluation runs at a time; a state meanwhile is looked at next.
    pub async fn on_state(self: &Arc<Self>, providers: Vec<ProviderUsage>) {
        {
            let mut g = self.inner.lock();
            if g.running {
                g.pending = Some(providers);
                return;
            }
            g.running = true;
        }
        let _running = Running(self.as_ref());
        let mut next = Some(providers);
        while let Some(state) = next {
            self.inner.lock().pending = None;
            self.drop_stale_offer(&state);
            for provider in Provider::ALL {
                self.evaluate(provider, &state).await;
            }
            next = self.inner.lock().pending.take();
        }
    }

    pub fn dispose(&self) {
        if let Some(t) = self.inner.lock().retry.take() {
            t.abort();
        }
    }

    /// Busy now: the same evaluation runs again in a few seconds with the latest state.
    fn later(self: &Arc<Self>) {
        let mut g = self.inner.lock();
        if g.retry.is_some() {
            return;
        }
        let weak = Arc::downgrade(self);
        g.retry = Some(self.o.rt.spawn(async move {
            tokio::time::sleep(RETRY_BUSY).await;
            let Some(me) = weak.upgrade() else { return };
            me.inner.lock().retry = None;
            let providers = (me.o.providers)();
            me.on_state(providers).await;
        }));
    }

    fn memory(&self) -> AutoSwitchMemory {
        self.inner.lock().memory.clone()
    }

    async fn evaluate(self: &Arc<Self>, provider: Provider, providers: &[ProviderUsage]) {
        if !(self.o.supported)(provider) {
            return;
        }
        let settings = (self.o.settings)();
        let now = self.now();
        let plan = plan_auto_switch(providers, provider, &settings, &self.memory(), now);
        let (switch, reason, from, trigger, candidates) = match plan {
            Plan::None(_) => return,
            Plan::Exhausted { from, trigger, next, target } => {
                // Nobody has room: stay, and say so once in this limit period (with the account that is usable first).
                let key = offer_key("exhausted", &account_key(&from));
                self.remember(remember_told(&self.memory(), provider, &key, trigger.window, trigger.resets_at, now));
                let mut n = SwitchNotice::new(NoticeKind::Exhausted, provider);
                n.from_email = from.email.clone();
                n.to_email = match &next {
                    Some((Some(email), _)) => Some(email.clone()),
                    _ => target.clone(),
                };
                n.resets_at = next.map(|(_, at)| at);
                n.target_only = target.is_some();
                self.tell(&n);
                return;
            }
            Plan::Act { switch, reason, from, trigger, candidates } => (switch, reason, from, trigger, candidates),
        };
        if (self.o.busy)() {
            self.later();
            return;
        }
        let returning = reason == Reason::Return;
        let from_key = account_key(&from);
        if !switch {
            // The first candidate the family rules allow is offered; the offer is told once per limit period.
            let to = self.first_allowed(provider, &candidates).await;
            let (window, resets_at) = match (returning, trigger) {
                (true, _) | (false, None) => return_offer_mark(now),
                (false, Some(t)) => (t.window, t.resets_at),
            };
            let key = if returning {
                offer_key("return", settings.primary.get(&provider).map_or("", String::as_str))
            } else {
                offer_key("limit", &from_key)
            };
            self.remember(remember_told(&self.memory(), provider, &key, window, resets_at, now));
            let Some(to) = to else { return };
            self.set_offer(Some(SwitchOffer {
                provider,
                reason,
                to: to.account_id.clone(),
                to_email: to.email.clone(),
                from_email: from.email.clone(),
                window: trigger.map(|t| t.window),
                percent: trigger.map(|t| t.percent),
            }));
            let mut n = SwitchNotice::new(if returning { NoticeKind::ReturnOffer } else { NoticeKind::Offer }, provider);
            n.from_email = from.email.clone();
            n.to_email = to.email.clone();
            n.window = trigger.map(|t| t.window);
            n.percent = trigger.map(|t| t.percent);
            self.tell(&n);
            return;
        }
        // Switch at once: the cooldown starts with the attempt, also when every candidate is refused.
        self.remember(remember_switch(&self.memory(), provider, &from, trigger, now, None, None));
        for candidate in &candidates {
            if (self.o.busy)() {
                self.later();
                return;
            }
            if self.validate(provider, candidate).await.is_some() {
                continue;
            }
            let result = self.swap(provider, candidate).await;
            if result.ok {
                let primary = settings.primary.get(&provider).map(String::as_str);
                let to_key = account_key(candidate);
                self.remember(remember_switch(&self.memory(), provider, &from, trigger, self.now(), Some(&to_key), primary));
                if self.current_offer().is_some_and(|o| o.provider == provider) {
                    self.set_offer(None);
                }
                let mut n = SwitchNotice::new(if returning { NoticeKind::Returned } else { NoticeKind::Switched }, provider);
                n.from_email = from.email.clone();
                n.to_email = result.email.clone().or(candidate.email.clone());
                if !returning {
                    n.window = trigger.map(|t| t.window);
                    n.percent = trigger.map(|t| t.percent);
                }
                self.tell(&n);
            } else {
                let mut n = SwitchNotice::new(NoticeKind::Failed, provider);
                n.from_email = from.email.clone();
                n.to_email = candidate.email.clone();
                self.tell(&n);
            }
            return;
        }
    }

    /// "Switch to X" of an offer (notification button or the panel): only while the offer is still current and X is still
    /// usable; counts like an automatic switch.
    pub async fn accept_offer(self: &Arc<Self>) -> SwapResult {
        let Some(offer) = self.current_offer() else { return SwapResult::fail(SwapError::Invalid) };
        if (self.o.busy)() || self.inner.lock().running {
            return SwapResult::fail(SwapError::Busy);
        }
        let providers = (self.o.providers)();
        let Some(target) = providers.iter().find(|u| u.account_id == offer.to).cloned() else {
            self.set_offer(None);
            return SwapResult::fail(SwapError::NoTarget);
        };
        // Thresholds hold in every mode: an offer whose account went over one meanwhile is withdrawn.
        let key = account_key(&target);
        if manual_candidates(&providers, offer.provider, &(self.o.settings)(), self.now(), Some(&key)).is_empty() {
            self.set_offer(None);
            return SwapResult::fail_named(SwapError::NoTarget, target.email.clone());
        }
        self.run(offer.provider, vec![target]).await
    }

    pub fn dismiss_offer(&self) {
        self.set_offer(None);
    }

    /// The user's "switch now": to the chosen account (`to`, an account key) or the best usable saved account with more
    /// room than the main one; `noTarget` when there is none.
    pub async fn switch_now(self: &Arc<Self>, provider: Provider, to: Option<&str>) -> SwapResult {
        if !(self.o.supported)(provider) {
            return SwapResult::fail(SwapError::Unsupported);
        }
        if (self.o.busy)() || self.inner.lock().running {
            return SwapResult::fail(SwapError::Busy);
        }
        let candidates = manual_candidates(&(self.o.providers)(), provider, &(self.o.settings)(), self.now(), to);
        self.run(provider, candidates).await
    }

    async fn run(self: &Arc<Self>, provider: Provider, candidates: Vec<ProviderUsage>) -> SwapResult {
        self.inner.lock().running = true;
        let _running = Running(self.as_ref());
        let from = main_card(&(self.o.providers)(), provider).cloned();
        let mut refusal: Option<SwapResult> = None;
        for candidate in &candidates {
            refusal = self.validate(provider, candidate).await;
            if refusal.is_some() {
                continue;
            }
            let result = self.swap(provider, candidate).await;
            if result.ok {
                let settings = (self.o.settings)();
                if let Some(from) = &from {
                    let trigger = switch_trigger(from, &settings, self.now());
                    let to_key = account_key(candidate);
                    let primary = settings.primary.get(&provider).map(String::as_str);
                    self.remember(remember_switch(&self.memory(), provider, from, trigger, self.now(), Some(&to_key), primary));
                }
                if self.current_offer().is_some_and(|o| o.provider == provider) {
                    self.set_offer(None);
                }
            }
            return result;
        }
        refusal.unwrap_or_else(|| SwapResult::fail(SwapError::NoTarget))
    }

    async fn first_allowed(&self, provider: Provider, candidates: &[ProviderUsage]) -> Option<ProviderUsage> {
        for c in candidates {
            if self.validate(provider, c).await.is_none() {
                return Some(c.clone());
            }
        }
        None
    }

    async fn validate(&self, provider: Provider, candidate: &ProviderUsage) -> Option<SwapResult> {
        (self.o.validate)(provider, candidate.account_id.clone()).await
    }

    async fn swap(&self, provider: Provider, candidate: &ProviderUsage) -> SwapResult {
        (self.o.swap)(provider, candidate.account_id.clone()).await
    }

    /// An offer whose main account changed, whose reason is gone or whose account disappeared is withdrawn.
    fn drop_stale_offer(&self, providers: &[ProviderUsage]) {
        let Some(offer) = self.current_offer() else { return };
        let main = main_card(providers, offer.provider);
        let settings = (self.o.settings)();
        let same_main =
            main.is_some_and(|m| offer.from_email.as_ref().is_none_or(|f| f.is_empty() || account_key(m) == f.to_lowercase()));
        let reason = offer.reason == Reason::Return || main.is_some_and(|m| switch_trigger(m, &settings, self.now()).is_some());
        let target = providers.iter().any(|u| u.account_id == offer.to);
        if !settings.enabled || !same_main || !reason || !target {
            self.set_offer(None);
        }
    }

    fn set_offer(&self, offer: Option<SwitchOffer>) {
        {
            let mut g = self.inner.lock();
            if g.offer == offer {
                return;
            }
            g.offer = offer;
        }
        // The panel catches up with the next state when this fails.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.o.changed)()));
    }

    fn tell(&self, notice: &SwitchNotice) {
        // A failed notification must not stop the switch logic.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.o.notify)(notice)));
    }

    fn remember(&self, memory: AutoSwitchMemory) {
        let away_changed = {
            let mut g = self.inner.lock();
            let changed = g.memory.away != memory.away;
            g.memory = memory.clone();
            changed
        };
        let mut m = Map::new();
        m.insert("version".into(), 1.into());
        m.insert("memory".into(), memory.to_value());
        let text = serde_json::to_string(&Value::Object(m)).unwrap_or_default();
        // Optional: at worst a cooldown restarts after a restart.
        if let Some(dir) = self.o.file.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = unimux_core::atomic_write::atomic_write(
            &self.o.file,
            text.as_bytes(),
            &unimux_core::atomic_write::AtomicWriteOptions::default(),
        );
        if away_changed {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (self.o.changed)()));
        }
    }

    fn load(file: &std::path::Path) -> AutoSwitchMemory {
        let Ok(text) = js::read_text(file) else { return AutoSwitchMemory::default() };
        match unimux_core::js_json::parse(&text) {
            Ok(raw) if raw.get("version").and_then(Value::as_f64) == Some(1.0) => normalize_auto_switch_memory(raw.get("memory")),
            _ => AutoSwitchMemory::default(),
        }
    }
}

#[cfg(test)]
mod tests;
