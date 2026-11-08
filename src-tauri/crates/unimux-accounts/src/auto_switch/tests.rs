//! Ports of test/auto-switch.test.ts (the plan and the AutoSwitcher cases).

use std::sync::atomic::{AtomicBool, Ordering};

use futures::FutureExt;
use serde_json::json;

use super::*;
use crate::usage::types::UsageWindow;
use crate::usage::{HeldBy, Source, Status};

// Date.UTC(2026, 10, 3, 12, 0, 0)
const NOW: f64 = 1_793_707_200_000.0;
const S: f64 = 1_793_707_200.0;
const H: f64 = 3600.0;

#[derive(Default, Clone)]
struct P {
    active: bool,
    status: Option<Status>,
    source: Option<Source>,
    held_by: Option<HeldBy>,
    fetched_at: Option<f64>,
    account_id: Option<String>,
    five: Option<f64>,
    seven: Option<f64>,
    no_windows: bool,
}

fn card(email: &str, five: f64, seven: f64, p: P) -> ProviderUsage {
    let id = p.account_id.clone().unwrap_or_else(|| if p.active { "claude:main".into() } else { format!("claude:{email}") });
    let mut u = ProviderUsage::new(
        &id,
        Provider::Claude,
        p.status.unwrap_or(Status::Ok),
        p.fetched_at.unwrap_or(NOW - 60_000.0),
        p.source.unwrap_or(Source::Live),
    );
    u.email = Some(email.into());
    if !p.no_windows {
        u.windows = vec![
            UsageWindow { id: WindowId::FiveHour, used_percent: five, resets_at: S + p.five.unwrap_or(2.0 * H) },
            UsageWindow { id: WindowId::SevenDay, used_percent: seven, resets_at: S + p.seven.unwrap_or(3.0 * 24.0 * H) },
        ];
    }
    u.managed = Some(!p.active);
    u.active = p.active;
    u.held_by = p.held_by;
    u
}

fn main_card_of(email: &str, five: f64, seven: f64) -> ProviderUsage {
    card(email, five, seven, P { active: true, ..P::default() })
}

fn on() -> AutoSwitchSettings {
    AutoSwitchSettings { enabled: true, mode: Mode::Switch, ..AutoSwitchSettings::default() }
}

fn plan(providers: &[ProviderUsage], settings: &AutoSwitchSettings, memory: &AutoSwitchMemory, now: f64) -> Plan {
    plan_auto_switch(providers, Provider::Claude, settings, memory, now)
}

fn keys(v: &[ProviderUsage]) -> Vec<String> {
    v.iter().map(account_key).collect()
}

#[test]
fn settings_defaults_and_damaged_values() {
    let d = AutoSwitchSettings::from_value(Some(&json!({ "mode": "x", "cooldownMinutes": 7, "fiveHour": { "percent": 0 } })));
    assert_eq!(d, AutoSwitchSettings::default());
    let s = AutoSwitchSettings::from_value(Some(
        &json!({ "enabled": true, "cooldownMinutes": 30, "target": { "claude": "B@X.com" }, "sevenDay": { "enabled": false, "percent": 42 } }),
    ));
    assert_eq!((s.cooldown_minutes, s.target.get(&Provider::Claude).map(String::as_str)), (30, Some("b@x.com")));
    assert_eq!(s.seven_day, WindowAlert { enabled: false, percent: 42 });
    let m = normalize_auto_switch_memory(Some(
        &json!({ "last": { "claude": 5, "codex": -1 }, "left": [{ "provider": "claude", "key": "a", "window": "5h", "resetsAt": 9 }, { "provider": "claude", "key": "", "window": "5h", "resetsAt": 9 }], "away": { "codex": "X@y" } }),
    ));
    assert_eq!(m.last.get(&Provider::Claude), Some(&5.0));
    assert_eq!(m.last.len(), 1);
    assert_eq!(m.left.len(), 1);
    assert_eq!(m.away.get(&Provider::Codex).map(String::as_str), Some("x@y"));
}

#[test]
fn triggers_only_with_current_numbers() {
    let main = main_card_of("a@x.com", 95.0, 10.0);
    assert_eq!(
        switch_trigger(&main, &on(), NOW),
        Some(Trigger { window: WindowId::FiveHour, percent: 95.0, resets_at: S + 2.0 * H })
    );
    assert!(switch_trigger(&main_card_of("a@x.com", 94.0, 97.0), &on(), NOW).is_none());
    assert_eq!(switch_trigger(&main_card_of("a@x.com", 10.0, 98.0), &on(), NOW).map(|t| t.window), Some(WindowId::SevenDay));
    let mut cached = main.clone();
    cached.source = Source::Cache;
    assert!(switch_trigger(&cached, &on(), NOW).is_none());
    let past = card("a@x.com", 99.0, 10.0, P { active: true, five: Some(-60.0), ..P::default() });
    assert!(switch_trigger(&past, &on(), NOW).is_none());
}

#[test]
fn ranks_by_room_then_the_earlier_reset() {
    let providers = vec![
        main_card_of("a@x.com", 96.0, 50.0),
        card("b@x.com", 40.0, 60.0, P::default()),
        card("c@x.com", 20.0, 30.0, P::default()),
        card("d@x.com", 20.0, 30.0, P { five: Some(H), ..P::default() }),
    ];
    let ranked = rank_candidates(&providers, Provider::Claude, &on(), &AutoSwitchMemory::default(), NOW, false);
    assert_eq!(keys(&ranked), ["d@x.com", "c@x.com", "b@x.com"]);
    match plan(&providers, &on(), &AutoSwitchMemory::default(), NOW) {
        Plan::Act { switch: true, candidates, .. } => assert_eq!(candidates[0].email.as_deref(), Some("d@x.com")),
        other => panic!("{other:?}"),
    }
}

#[test]
fn never_offers_unusable_accounts_but_keeps_a_cswap_copy() {
    let providers = vec![
        main_card_of("a@x.com", 96.0, 10.0),
        card("expired@x.com", 0.0, 0.0, P { status: Some(Status::Expired), ..P::default() }),
        card(
            "elsewhere@x.com",
            0.0,
            0.0,
            P { status: Some(Status::Elsewhere), held_by: Some(HeldBy::SwitchedOut), ..P::default() },
        ),
        card("held@x.com", 0.0, 0.0, P { held_by: Some(HeldBy::Live), ..P::default() }),
        card("cached@x.com", 0.0, 0.0, P { source: Some(Source::Cache), ..P::default() }),
        card("old@x.com", 0.0, 0.0, P { fetched_at: Some(NOW - 3_600_000.0), ..P::default() }),
        card("full@x.com", 96.0, 10.0, P::default()),
        card("week@x.com", 10.0, 99.0, P::default()),
        card("error@x.com", 0.0, 0.0, P { status: Some(Status::Error), ..P::default() }),
    ];
    assert!(rank_candidates(&providers, Provider::Claude, &on(), &AutoSwitchMemory::default(), NOW, false).is_empty());
    let mut more = providers.clone();
    more.push(card("cswap@x.com", 5.0, 5.0, P { held_by: Some(HeldBy::Cswap), ..P::default() }));
    assert_eq!(keys(&rank_candidates(&more, Provider::Claude, &on(), &AutoSwitchMemory::default(), NOW, false)), ["cswap@x.com"]);
}

#[test]
fn offers_in_ask_mode_once_per_period_and_waits_for_the_cooldown() {
    let ask = AutoSwitchSettings { mode: Mode::Ask, ..on() };
    let providers = vec![main_card_of("a@x.com", 96.0, 10.0), card("b@x.com", 10.0, 10.0, P::default())];
    assert!(matches!(plan(&providers, &ask, &AutoSwitchMemory::default(), NOW), Plan::Act { switch: false, .. }));
    let told = AutoSwitchMemory {
        offered: vec![Mark {
            provider: Provider::Claude,
            key: "a@x.com".into(),
            window: WindowId::FiveHour,
            resets_at: S + 2.0 * H + 60.0,
        }],
        ..AutoSwitchMemory::default()
    };
    assert_eq!(plan(&providers, &ask, &told, NOW), Plan::None(Skip::Offered));
    let cooling = AutoSwitchMemory { last: [(Provider::Claude, NOW - 5.0 * 60_000.0)].into(), ..AutoSwitchMemory::default() };
    assert_eq!(plan(&providers, &on(), &cooling, NOW), Plan::None(Skip::Cooldown));
    assert!(matches!(plan(&providers, &on(), &cooling, NOW + 11.0 * 60_000.0), Plan::Act { switch: true, .. }));
}

#[test]
fn returns_home_after_the_reset_a_b_a() {
    let mut settings = on();
    settings.primary.insert(Provider::Claude, "a@x.com".into());
    let a = main_card_of("a@x.com", 95.0, 10.0);
    let t = switch_trigger(&a, &settings, NOW);
    let memory = remember_switch(&AutoSwitchMemory::default(), Provider::Claude, &a, t, NOW, Some("b@x.com"), Some("a@x.com"));
    assert_eq!(memory.away.get(&Provider::Claude).map(String::as_str), Some("a@x.com"));
    let t2 = NOW + 2.0 * H * 1000.0 + 5.0 * 60_000.0;
    let b = card("b@x.com", 60.0, 10.0, P { active: true, fetched_at: Some(t2), ..P::default() });
    let a_back = card(
        "a@x.com",
        1.0,
        10.0,
        P { account_id: Some("claude:a".into()), fetched_at: Some(t2), five: Some(7.0 * H), ..P::default() },
    );
    let p = plan(&[b.clone(), a_back.clone()], &settings, &memory, t2);
    assert!(matches!(p, Plan::Act { switch: true, reason: Reason::Return, .. }), "{p:?}");
    let back = remember_switch(&memory, Provider::Claude, &b, None, t2, Some("a@x.com"), Some("a@x.com"));
    assert!(back.away.is_empty());
}

#[test]
fn exhausted_with_the_earliest_reset_and_not_while_a_card_is_unread() {
    let providers = vec![
        card("a@x.com", 97.0, 10.0, P { active: true, five: Some(4.0 * H), ..P::default() }),
        card("b@x.com", 99.0, 10.0, P { five: Some(H), ..P::default() }),
        card("c@x.com", 20.0, 99.0, P { seven: Some(2.0 * 24.0 * H), ..P::default() }),
    ];
    match plan(&providers, &on(), &AutoSwitchMemory::default(), NOW) {
        Plan::Exhausted { next, .. } => assert_eq!(next, Some((Some("b@x.com".into()), S + H))),
        other => panic!("{other:?}"),
    }
    let unread = vec![
        main_card_of("a@x.com", 97.0, 10.0),
        card("b@x.com", 0.0, 0.0, P { status: Some(Status::Error), no_windows: true, ..P::default() }),
    ];
    assert_eq!(plan(&unread, &on(), &AutoSwitchMemory::default(), NOW), Plan::None(Skip::NoCandidate));
    assert_eq!(plan(&unread[..1], &on(), &AutoSwitchMemory::default(), NOW), Plan::None(Skip::NoCandidate));
}

#[test]
fn switch_now_never_picks_an_account_over_a_threshold() {
    let providers = vec![
        main_card_of("a@x.com", 50.0, 10.0),
        card("b@x.com", 10.0, 10.0, P::default()),
        card("c@x.com", 96.0, 10.0, P::default()),
        card("d@x.com", 70.0, 10.0, P::default()),
    ];
    assert_eq!(keys(&manual_candidates(&providers, Provider::Claude, &on(), NOW, None)), ["b@x.com"]);
    assert!(manual_candidates(&providers, Provider::Claude, &on(), NOW, Some("c@x.com")).is_empty());
    assert_eq!(keys(&manual_candidates(&providers, Provider::Claude, &on(), NOW, Some("d@x.com"))), ["d@x.com"]);
}

struct Setup {
    _dir: tempfile::TempDir,
    file: PathBuf,
    switcher: Arc<AutoSwitcher>,
    swaps: Arc<Mutex<Vec<String>>>,
    notices: Arc<Mutex<Vec<String>>>,
    busy: Arc<AtomicBool>,
}

fn setup(settings: AutoSwitchSettings, providers: Vec<ProviderUsage>, refuse: &[&str], busy: bool) -> Setup {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("auto-switch.json");
    type Log = Arc<Mutex<Vec<String>>>;
    let (swaps, notices): (Log, Log) = Default::default();
    let busy = Arc::new(AtomicBool::new(busy));
    let refuse: Vec<String> = refuse.iter().map(|s| s.to_string()).collect();
    let (sw, no, b) = (swaps.clone(), notices.clone(), busy.clone());
    let switcher = AutoSwitcher::new(AutoSwitcherOptions {
        file: file.clone(),
        settings: Arc::new(move || settings.clone()),
        providers: Arc::new(move || providers.clone()),
        supported: Arc::new(|_| true),
        busy: Arc::new(move || b.load(Ordering::SeqCst)),
        validate: Arc::new(move |_, id| {
            let refused = refuse.contains(&id);
            async move { refused.then(|| SwapResult::fail(SwapError::Foreign)) }.boxed()
        }),
        swap: Arc::new(move |_, id| {
            sw.lock().push(id.clone());
            async move { SwapResult::ok(Some(id.replace("claude:", ""))) }.boxed()
        }),
        notify: Arc::new(move |n| no.lock().push(format!("{:?}:{}", n.kind, n.to_email.clone().unwrap_or_default()))),
        changed: Arc::new(|| {}),
        now: Arc::new(|| NOW),
        rt: tokio::runtime::Handle::current(),
    });
    Setup { _dir: dir, file, switcher, swaps, notices, busy }
}

#[tokio::test]
async fn switches_at_once_skipping_a_refused_candidate_then_cools_down() {
    let providers = vec![
        main_card_of("a@x.com", 96.0, 10.0),
        card("b@x.com", 5.0, 5.0, P::default()),
        card("c@x.com", 20.0, 20.0, P::default()),
    ];
    let t = setup(on(), providers.clone(), &["claude:b@x.com"], false);
    t.switcher.on_state(providers.clone()).await;
    assert_eq!(*t.swaps.lock(), ["claude:c@x.com"]);
    assert_eq!(*t.notices.lock(), ["Switched:c@x.com"]);
    t.switcher.on_state(providers).await;
    assert_eq!(t.swaps.lock().len(), 1);
}

#[tokio::test]
async fn never_switches_while_busy() {
    let providers = vec![main_card_of("a@x.com", 96.0, 10.0), card("b@x.com", 5.0, 5.0, P::default())];
    let t = setup(on(), providers.clone(), &[], true);
    t.switcher.on_state(providers.clone()).await;
    assert!(t.swaps.lock().is_empty());
    t.busy.store(false, Ordering::SeqCst);
    t.switcher.on_state(providers).await;
    assert_eq!(*t.swaps.lock(), ["claude:b@x.com"]);
    t.switcher.dispose();
}

#[tokio::test]
async fn offers_and_switches_only_when_accepted_and_the_cooldown_survives_a_restart() {
    let providers = vec![main_card_of("a@x.com", 96.0, 10.0), card("b@x.com", 5.0, 5.0, P::default())];
    let t = setup(AutoSwitchSettings { mode: Mode::Ask, ..on() }, providers.clone(), &[], false);
    t.switcher.on_state(providers.clone()).await;
    assert!(t.swaps.lock().is_empty());
    assert_eq!(*t.notices.lock(), ["Offer:b@x.com"]);
    let offer = t.switcher.current_offer().unwrap();
    assert_eq!((offer.to.as_str(), offer.percent, offer.reason), ("claude:b@x.com", Some(96.0), Reason::Limit));
    t.switcher.on_state(providers).await;
    assert_eq!(t.notices.lock().len(), 1);
    assert_eq!(t.switcher.accept_offer().await, SwapResult::ok(Some("b@x.com".into())));
    assert!(t.switcher.current_offer().is_none());
    let saved: Value = serde_json::from_str(&std::fs::read_to_string(&t.file).unwrap()).unwrap();
    assert_eq!(saved["version"], 1);
    assert_eq!(AutoSwitcher::load(&t.file).last.get(&Provider::Claude), Some(&NOW));
}

#[tokio::test]
async fn tells_exhausted_once_and_switch_now_refuses_over_threshold() {
    let providers = vec![main_card_of("a@x.com", 96.0, 10.0), card("b@x.com", 97.0, 5.0, P { five: Some(H), ..P::default() })];
    let t = setup(on(), providers.clone(), &[], false);
    t.switcher.on_state(providers.clone()).await;
    t.switcher.on_state(providers).await;
    assert!(t.swaps.lock().is_empty());
    assert_eq!(*t.notices.lock(), ["Exhausted:b@x.com"]);

    let providers = vec![
        main_card_of("a@x.com", 50.0, 10.0),
        card("b@x.com", 5.0, 5.0, P::default()),
        card("c@x.com", 99.0, 5.0, P::default()),
    ];
    let t = setup(AutoSwitchSettings { enabled: false, ..on() }, providers, &[], false);
    assert_eq!(t.switcher.switch_now(Provider::Claude, Some("c@x.com")).await, SwapResult::fail(SwapError::NoTarget));
    assert_eq!(t.switcher.switch_now(Provider::Claude, None).await, SwapResult::ok(Some("b@x.com".into())));
}

mod ts_ports;
