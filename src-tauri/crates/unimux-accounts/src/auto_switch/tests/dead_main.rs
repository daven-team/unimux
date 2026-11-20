//! 1.2.6: switching away from a dead main account (a lapsed subscription, a 403 that persists) and the notices of the
//! at-limit escape and of the dead main account.

use super::*;

const MIN: f64 = 60_000.0;

/// The main account whose latest read is `status`, `gap_ms` after its last good numbers (kept, like the usage service does).
fn dead(email: &str, status: Status, gap_ms: f64) -> ProviderUsage {
    let mut u = card(email, 40.0, 40.0, P { active: true, status: Some(status), source: Some(Source::Cache), ..P::default() });
    u.fetched_at = NOW - gap_ms - MIN;
    u.attempt_at = Some(NOW - MIN);
    if status == Status::Lapsed {
        u.windows.clear();
    }
    u
}

fn lapsed_main() -> ProviderUsage {
    dead("a@x.com", Status::Lapsed, 0.0)
}

fn ask() -> AutoSwitchSettings {
    AutoSwitchSettings { mode: Mode::Ask, ..on() }
}

#[test]
fn a_lapsed_main_is_dead_at_once_a_forbidden_one_only_when_it_persists() {
    assert_eq!(dead_main(&lapsed_main()), Some(Dead::Lapsed));
    // A one-off 403 (the first refused read right after good numbers) is not dead.
    assert_eq!(dead_main(&dead("a@x.com", Status::Forbidden, 5.0 * MIN)), None);
    // The read after the 30-minute hold was refused again: dead.
    assert_eq!(dead_main(&dead("a@x.com", Status::Forbidden, 30.0 * MIN)), Some(Dead::Forbidden));
    // No earlier numbers: the refused read is all there is, never taken as dead.
    let mut bare = dead("a@x.com", Status::Forbidden, 0.0);
    bare.windows.clear();
    bare.fetched_at = NOW - MIN;
    assert_eq!(dead_main(&bare), None);
    // An expired or signed-out login and a failed read are other flows.
    for status in [Status::Expired, Status::SignedOut, Status::Error, Status::Elsewhere, Status::Dormant] {
        assert_eq!(dead_main(&dead("a@x.com", status, 60.0 * MIN)), None, "{status:?}");
    }
    let mut no_attempt = dead("a@x.com", Status::Forbidden, 60.0 * MIN);
    no_attempt.attempt_at = None;
    assert_eq!(dead_main(&no_attempt), None);
}

#[test]
fn a_dead_main_switches_like_a_hit_limit() {
    let providers = vec![
        lapsed_main(),
        card("b@x.com", 50.0, 10.0, P::default()),
        card("c@x.com", 10.0, 10.0, P::default()),
        card("gone@x.com", 1.0, 1.0, P { status: Some(Status::Lapsed), ..P::default() }),
        card("refused@x.com", 1.0, 1.0, P { status: Some(Status::Forbidden), ..P::default() }),
        card("expired@x.com", 1.0, 1.0, P { status: Some(Status::Expired), ..P::default() }),
    ];
    match plan(&providers, &on(), &AutoSwitchMemory::default(), NOW) {
        Plan::Act { switch: true, reason: Reason::Dead(Dead::Lapsed), trigger: None, candidates, .. } => {
            assert_eq!(keys(&candidates), ["c@x.com", "b@x.com"]);
        }
        other => panic!("{other:?}"),
    }
    // A persisting 403 the same way.
    let forbidden = [vec![dead("a@x.com", Status::Forbidden, 45.0 * MIN)], providers[1..].to_vec()].concat();
    assert!(matches!(
        plan(&forbidden, &on(), &AutoSwitchMemory::default(), NOW),
        Plan::Act { reason: Reason::Dead(Dead::Forbidden), .. }
    ));
    // A one-off 403 (numbers below the thresholds): nothing happens.
    let once = [vec![dead("a@x.com", Status::Forbidden, 5.0 * MIN)], providers[1..].to_vec()].concat();
    assert_eq!(plan(&once, &on(), &AutoSwitchMemory::default(), NOW), Plan::None(Skip::Below));
    // The strategy applies and a chosen account wins.
    let weekly = AutoSwitchSettings { strategy: Strategy::WeeklyFirst, ..on() };
    assert!(matches!(plan(&providers, &weekly, &AutoSwitchMemory::default(), NOW), Plan::Act { .. }));
    let mut target = on();
    target.target.insert(Provider::Claude, "b@x.com".into());
    match plan(&providers, &target, &AutoSwitchMemory::default(), NOW) {
        Plan::Act { candidates, .. } => assert_eq!(keys(&candidates), ["b@x.com"]),
        other => panic!("{other:?}"),
    }
    // Off, and the cooldown.
    assert_eq!(
        plan(&providers, &AutoSwitchSettings { enabled: false, ..on() }, &AutoSwitchMemory::default(), NOW),
        Plan::None(Skip::Off)
    );
    let cooling = AutoSwitchMemory { last: [(Provider::Claude, NOW - MIN)].into(), ..AutoSwitchMemory::default() };
    assert_eq!(plan(&providers, &on(), &cooling, NOW), Plan::None(Skip::Cooldown));
}

#[test]
fn a_dead_main_escapes_to_any_room_when_everyone_is_over_the_thresholds() {
    let providers = vec![
        lapsed_main(),
        card("thin@x.com", 99.0, 10.0, P::default()),
        card("more@x.com", 96.0, 10.0, P::default()),
        card("spent@x.com", 100.0, 10.0, P::default()),
        card("old@x.com", 95.0, 10.0, P { fetched_at: Some(NOW - 3_600_000.0), ..P::default() }),
    ];
    match plan(&providers, &on(), &AutoSwitchMemory::default(), NOW) {
        Plan::Act { reason: Reason::Dead(Dead::Lapsed), candidates, .. } => {
            assert_eq!(keys(&candidates), ["more@x.com", "thin@x.com"]);
        }
        other => panic!("{other:?}"),
    }
    // Nobody with room at all: the app stays (the card itself says the subscription lapsed).
    let none = vec![lapsed_main(), providers[3].clone(), providers[4].clone()];
    assert_eq!(plan(&none, &on(), &AutoSwitchMemory::default(), NOW), Plan::None(Skip::NoCandidate));
    assert_eq!(plan(&[lapsed_main()], &on(), &AutoSwitchMemory::default(), NOW), Plan::None(Skip::NoCandidate));
}

#[test]
fn the_dead_offer_is_told_once_in_a_few_hours() {
    let providers = vec![lapsed_main(), card("b@x.com", 10.0, 10.0, P::default())];
    assert!(matches!(plan(&providers, &ask(), &AutoSwitchMemory::default(), NOW), Plan::Act { switch: false, .. }));
    let (window, resets_at) = dead_offer_mark(NOW);
    let told =
        remember_told(&AutoSwitchMemory::default(), Provider::Claude, &offer_key("dead", "a@x.com"), window, resets_at, NOW);
    assert_eq!(plan(&providers, &ask(), &told, NOW), Plan::None(Skip::Offered));
    assert_eq!(plan(&providers, &ask(), &told, NOW + 2.9 * H * 1000.0), Plan::None(Skip::Offered));
    // Card numbers are 20 minutes fresh at most: the later state reads them again.
    let later = NOW + 3.1 * H * 1000.0;
    let fresh = vec![lapsed_main(), card("b@x.com", 10.0, 10.0, P { fetched_at: Some(later - MIN), ..P::default() })];
    assert!(matches!(plan(&fresh, &ask(), &told, later), Plan::Act { switch: false, .. }));
    // A limit offer of the same account is another mark.
    let limit = remember_told(&AutoSwitchMemory::default(), Provider::Claude, "a@x.com", window, resets_at, NOW);
    assert!(matches!(plan(&providers, &ask(), &limit, NOW), Plan::Act { .. }));
}

#[test]
fn never_returns_home_to_a_dead_primary() {
    let mut settings = on();
    settings.primary.insert(Provider::Claude, "a@x.com".into());
    let away = AutoSwitchMemory { away: [(Provider::Claude, "a@x.com".to_string())].into(), ..AutoSwitchMemory::default() };
    for status in [Status::Lapsed, Status::Forbidden] {
        let providers =
            vec![main_card_of("b@x.com", 10.0, 10.0), card("a@x.com", 1.0, 1.0, P { status: Some(status), ..P::default() })];
        assert_eq!(plan(&providers, &settings, &away, NOW), Plan::None(Skip::Below), "{status:?}");
    }
    // Once it reads fine again it is home.
    let providers = vec![main_card_of("b@x.com", 10.0, 10.0), card("a@x.com", 1.0, 1.0, P::default())];
    assert!(matches!(plan(&providers, &settings, &away, NOW), Plan::Act { reason: Reason::Return, .. }));
    // Leaving a dead primary remembers it; no "left" mark (no trigger).
    let m = remember_switch(
        &AutoSwitchMemory::default(),
        Provider::Claude,
        &lapsed_main(),
        None,
        NOW,
        Some("b@x.com"),
        Some("a@x.com"),
    );
    assert_eq!((m.away.get(&Provider::Claude).map(String::as_str), m.left.len()), (Some("a@x.com"), 0));
}

#[tokio::test]
async fn a_dead_main_is_offered_with_its_own_notice_and_the_offer_holds() {
    // The only other account is over its threshold: the escape of a dead main account, acceptable from the offer.
    let providers = vec![lapsed_main(), card("b@x.com", 97.0, 10.0, P::default())];
    let t = setup(ask(), providers.clone(), &[], false);
    t.switcher.on_state(providers.clone()).await;
    assert_eq!(*t.notices.lock(), ["DeadOffer:b@x.com"]);
    let offer = t.switcher.current_offer().unwrap();
    assert_eq!(offer.reason, Reason::Dead(Dead::Lapsed));
    let v = offer.to_value();
    assert_eq!((v["reason"].as_str(), v["lapsed"].as_bool()), (Some("dead"), Some(true)));
    // The next state keeps the offer and does not tell it again.
    t.switcher.on_state(providers).await;
    assert!(t.switcher.current_offer().is_some());
    assert_eq!(t.notices.lock().len(), 1);
    assert_eq!(t.switcher.accept_offer().await, SwapResult::ok(Some("b@x.com".into())));
    assert_eq!(*t.swaps.lock(), ["claude:b@x.com"]);
}

#[tokio::test]
async fn a_dead_main_is_switched_at_once_in_switch_mode() {
    let providers = vec![dead("a@x.com", Status::Forbidden, 40.0 * MIN), card("b@x.com", 10.0, 10.0, P::default())];
    let t = setup(on(), providers.clone(), &[], false);
    t.switcher.on_state(providers).await;
    assert_eq!(*t.swaps.lock(), ["claude:b@x.com"]);
    assert_eq!(*t.notices.lock(), ["DeadSwitched:b@x.com"]);
}
