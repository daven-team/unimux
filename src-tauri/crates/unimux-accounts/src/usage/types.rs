//! The limits of the user's Claude and Codex accounts: types and pure helpers (port of src/shared/usage.ts, the parts the
//! main process uses). JSON shapes are built by hand so whole numbers are written like JSON.stringify writes them.

use serde_json::{Map, Value};

use crate::js;
use crate::rules::RenewRule;

/// `UsageProvider`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Provider {
    Claude,
    Codex,
}

impl Provider {
    pub const ALL: [Provider; 2] = [Provider::Claude, Provider::Codex];

    pub fn as_str(self) -> &'static str {
        match self {
            Provider::Claude => "claude",
            Provider::Codex => "codex",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "claude" => Some(Provider::Claude),
            "codex" => Some(Provider::Codex),
            _ => None,
        }
    }

    /// "Claude" / "Codex" (the fallback name of an account without an e-mail).
    pub fn label(self) -> &'static str {
        match self {
            Provider::Claude => "Claude",
            Provider::Codex => "Codex",
        }
    }
}

/// `UsageStatus`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Ok,
    SignedOut,
    Expired,
    /// The main Claude login's access token is past its expiry but a refresh token exists (Claude Code renews it).
    Dormant,
    ApiKey,
    Error,
    /// A saved account whose tokens this app must not renew (R6) and whose access token ran out.
    Elsewhere,
    /// The usage endpoint answered 403 (e.g. a paused subscription); the sign-in itself is valid.
    Forbidden,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Ok => "ok",
            Status::SignedOut => "signedOut",
            Status::Expired => "expired",
            Status::Dormant => "dormant",
            Status::ApiKey => "apiKey",
            Status::Error => "error",
            Status::Elsewhere => "elsewhere",
            Status::Forbidden => "forbidden",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "ok" => Status::Ok,
            "signedOut" => Status::SignedOut,
            "expired" => Status::Expired,
            "dormant" => Status::Dormant,
            "apiKey" => Status::ApiKey,
            "error" => Status::Error,
            "elsewhere" => Status::Elsewhere,
            "forbidden" => Status::Forbidden,
            _ => return None,
        })
    }
}

/// `UsageSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Live,
    Log,
    Cache,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Source::Live => "live",
            Source::Log => "log",
            Source::Cache => "cache",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "live" => Some(Source::Live),
            "log" => Some(Source::Log),
            "cache" => Some(Source::Cache),
            _ => None,
        }
    }
}

/// `heldBy`: why a saved account's tokens are not renewed here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HeldBy {
    Live,
    Cswap,
    SwitchedOut,
}

impl HeldBy {
    pub fn as_str(self) -> &'static str {
        match self {
            HeldBy::Live => "live",
            HeldBy::Cswap => "cswap",
            HeldBy::SwitchedOut => "switched-out",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "live" => Some(HeldBy::Live),
            "cswap" => Some(HeldBy::Cswap),
            "switched-out" => Some(HeldBy::SwitchedOut),
            _ => None,
        }
    }
}

/// `heldByOf`: undefined when renewal is allowed.
pub fn held_by_of(renew: Option<RenewRule>) -> Option<HeldBy> {
    match renew? {
        RenewRule::Allowed => None,
        RenewRule::HeldByLive => Some(HeldBy::Live),
        RenewRule::HeldByCswap => Some(HeldBy::Cswap),
        RenewRule::SwitchedOut => Some(HeldBy::SwitchedOut),
    }
}

/// `UsageWindow['id']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum WindowId {
    FiveHour,
    SevenDay,
}

impl WindowId {
    pub fn as_str(self) -> &'static str {
        match self {
            WindowId::FiveHour => "5h",
            WindowId::SevenDay => "7d",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "5h" => Some(WindowId::FiveHour),
            "7d" => Some(WindowId::SevenDay),
            _ => None,
        }
    }
}

/// `UsageWindow`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct UsageWindow {
    pub id: WindowId,
    /// 0 to 100 as reported when the data was read.
    pub used_percent: f64,
    /// Epoch seconds when the window resets; 0 when the provider reports no active window.
    pub resets_at: f64,
}

impl UsageWindow {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), self.id.as_str().into());
        m.insert("usedPercent".into(), js::num(self.used_percent));
        m.insert("resetsAt".into(), js::num(self.resets_at));
        Value::Object(m)
    }
}

/// `ProviderUsage`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProviderUsage {
    pub account_id: String,
    pub provider: Provider,
    pub status: Status,
    pub plan: Option<String>,
    pub email: Option<String>,
    pub org: Option<String>,
    /// The account lives in an isolated profile managed by this app.
    pub managed: Option<bool>,
    pub windows: Vec<UsageWindow>,
    /// Epoch milliseconds of the read this data comes from.
    pub fetched_at: f64,
    pub source: Source,
    /// Short machine-readable reason (`http-429`, `refresh-http-429`, `bad-response`); never a token.
    pub error: Option<String>,
    pub attempt_at: Option<f64>,
    pub retry_at: Option<f64>,
    pub active: bool,
    pub held_by: Option<HeldBy>,
}

impl ProviderUsage {
    /// A fresh card of `provider` (`{ accountId, provider, status, windows: [], fetchedAt, source }`).
    pub fn new(account_id: &str, provider: Provider, status: Status, fetched_at: f64, source: Source) -> Self {
        Self {
            account_id: account_id.into(),
            provider,
            status,
            plan: None,
            email: None,
            org: None,
            managed: None,
            windows: Vec::new(),
            fetched_at,
            source,
            error: None,
            attempt_at: None,
            retry_at: None,
            active: false,
            held_by: None,
        }
    }

    /// The JSON the renderer and the cache get (sanitizeUsage's field order; `managed`, `active` and `heldBy` last, as
    /// UsageService.getState sets them).
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("accountId".into(), self.account_id.clone().into());
        m.insert("provider".into(), self.provider.as_str().into());
        m.insert("status".into(), self.status.as_str().into());
        for (k, v) in [("plan", &self.plan), ("email", &self.email), ("org", &self.org)] {
            if let Some(v) = v {
                m.insert(k.into(), v.clone().into());
            }
        }
        m.insert("windows".into(), Value::Array(self.windows.iter().map(UsageWindow::to_value).collect()));
        m.insert("fetchedAt".into(), js::num(self.fetched_at));
        m.insert("source".into(), self.source.as_str().into());
        if let Some(e) = &self.error {
            m.insert("error".into(), e.clone().into());
        }
        if let Some(a) = self.attempt_at {
            m.insert("attemptAt".into(), js::num(a));
        }
        if let Some(r) = self.retry_at {
            m.insert("retryAt".into(), js::num(r));
        }
        if let Some(managed) = self.managed {
            m.insert("managed".into(), managed.into());
        }
        if self.active {
            m.insert("active".into(), true.into());
        }
        if let Some(h) = self.held_by {
            m.insert("heldBy".into(), h.as_str().into());
        }
        Value::Object(m)
    }
}

/// `clampPercent`.
pub fn clamp_percent(value: f64) -> f64 {
    if value.is_finite() { value.clamp(0.0, 100.0) } else { 0.0 }
}

/// `effectivePercent`: a window that already reset counts as unused until fresh data arrives.
pub fn effective_percent(window: &UsageWindow, now_ms: f64) -> f64 {
    if window.resets_at > 0.0 && window.resets_at * 1000.0 <= now_ms { 0.0 } else { clamp_percent(window.used_percent) }
}

/// `CardState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardState {
    Ok,
    Stale,
    Expired,
    Unavailable,
    ApiKey,
}

/// `cardState`.
pub fn card_state(usage: &ProviderUsage) -> CardState {
    if usage.status == Status::ApiKey {
        return CardState::ApiKey;
    }
    if usage.status == Status::Expired {
        return CardState::Expired;
    }
    // Held only by the live login (its numbers are on the main card) is not a sign-in problem.
    if usage.status == Status::Elsewhere && usage.held_by != Some(HeldBy::Live) {
        return CardState::Expired;
    }
    if usage.windows.is_empty() {
        return CardState::Unavailable;
    }
    if usage.status == Status::Ok && usage.source == Source::Live { CardState::Ok } else { CardState::Stale }
}

/// `Math.round` (halves up).
pub fn js_round(v: f64) -> f64 {
    (v + 0.5).floor()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_states_follow_the_shared_rules() {
        let mut u = ProviderUsage::new("claude:main", Provider::Claude, Status::Ok, 1.0, Source::Live);
        assert_eq!(card_state(&u), CardState::Unavailable);
        u.windows.push(UsageWindow { id: WindowId::FiveHour, used_percent: 10.0, resets_at: 0.0 });
        assert_eq!(card_state(&u), CardState::Ok);
        u.source = Source::Cache;
        assert_eq!(card_state(&u), CardState::Stale);
        u.status = Status::Elsewhere;
        assert_eq!(card_state(&u), CardState::Expired);
        u.held_by = Some(HeldBy::Live);
        assert_eq!(card_state(&u), CardState::Stale);
        u.status = Status::ApiKey;
        assert_eq!(card_state(&u), CardState::ApiKey);
    }

    #[test]
    fn whole_numbers_are_written_like_json_stringify() {
        let mut u = ProviderUsage::new("codex:main", Provider::Codex, Status::Ok, 1_700_000_000_000.0, Source::Live);
        u.windows.push(UsageWindow { id: WindowId::SevenDay, used_percent: 12.5, resets_at: 1_700_000_100.0 });
        u.active = true;
        assert_eq!(
            serde_json::to_string(&u.to_value()).unwrap(),
            r#"{"accountId":"codex:main","provider":"codex","status":"ok","windows":[{"id":"7d","usedPercent":12.5,"resetsAt":1700000100}],"fetchedAt":1700000000000,"source":"live","active":true}"#
        );
        assert_eq!(effective_percent(&u.windows[0], 1_700_000_100_000.0), 0.0);
        assert_eq!(clamp_percent(f64::NAN), 0.0);
        assert_eq!(clamp_percent(130.0), 100.0);
    }

    /// accounts-dead-login "keeps the other states apart: current, stale, unavailable"
    #[test]
    fn ts_card_states_stay_apart() {
        let mut base = ProviderUsage::new("claude:x", Provider::Claude, Status::Ok, 1.0, Source::Live);
        base.windows.push(UsageWindow { id: WindowId::SevenDay, used_percent: 96.0, resets_at: 2.0 });
        let with = |f: &dyn Fn(&mut ProviderUsage)| {
            let mut u = base.clone();
            f(&mut u);
            card_state(&u)
        };
        assert_eq!(card_state(&base), CardState::Ok);
        assert_eq!(with(&|u| u.source = Source::Cache), CardState::Stale);
        assert_eq!(with(&|u| (u.status, u.source) = (Status::Dormant, Source::Cache)), CardState::Stale);
        assert_eq!(with(&|u| (u.status, u.error) = (Status::Error, Some("http-429".into()))), CardState::Stale);
        assert_eq!(
            with(&|u| (u.status, u.held_by, u.source) = (Status::Elsewhere, Some(HeldBy::Live), Source::Cache)),
            CardState::Stale
        );
        assert_eq!(with(&|u| (u.status, u.windows) = (Status::Error, vec![])), CardState::Unavailable);
        assert_eq!(with(&|u| (u.status, u.windows) = (Status::Forbidden, vec![])), CardState::Unavailable);
        assert_eq!(with(&|u| (u.provider, u.status, u.windows) = (Provider::Codex, Status::ApiKey, vec![])), CardState::ApiKey);
    }

    /// usage-shared "clamps percentages and rejects non-numbers", "treats a window that already reset as unused", "names who
    /// holds a saved account whose tokens are not renewed"
    #[test]
    fn ts_clamp_effective_percent_and_held_by() {
        assert_eq!([142.0, -3.0, f64::NAN, 41.5].map(clamp_percent), [100.0, 0.0, 0.0, 41.5]);
        let now = 1_791_720_000_000.0;
        let past = (now / 1000.0f64).floor() - 1.0;
        let w = |id, used_percent, resets_at| UsageWindow { id, used_percent, resets_at };
        assert_eq!(effective_percent(&w(WindowId::FiveHour, 80.0, past), now), 0.0);
        assert_eq!(effective_percent(&w(WindowId::FiveHour, 80.0, past + 3600.0), now), 80.0);
        assert_eq!(effective_percent(&w(WindowId::FiveHour, 12.0, 0.0), now), 12.0);
        assert_eq!(effective_percent(&w(WindowId::SevenDay, 250.0, past + 60.0), now), 100.0);
        assert_eq!(held_by_of(None), None);
        assert_eq!(held_by_of(Some(RenewRule::Allowed)), None);
        assert_eq!(held_by_of(Some(RenewRule::HeldByLive)), Some(HeldBy::Live));
        assert_eq!(held_by_of(Some(RenewRule::HeldByCswap)), Some(HeldBy::Cswap));
        assert_eq!(held_by_of(Some(RenewRule::SwitchedOut)), Some(HeldBy::SwitchedOut));
        assert_eq!(HeldBy::SwitchedOut.as_str(), "switched-out");
    }
}
