//! 1.2.6 (after cswap 0.29-0.30): the `weekly-first` candidate choice, the at-limit escape when every account is over its
//! thresholds, and accounts without a 5-hour window (Ultra).

use super::*;

const D: f64 = 24.0 * H;

fn weekly() -> AutoSwitchSettings {
    AutoSwitchSettings { strategy: Strategy::WeeklyFirst, ..on() }
}

fn ranked(providers: &[ProviderUsage], settings: &AutoSwitchSettings) -> Vec<String> {
    keys(&rank_candidates(providers, Provider::Claude, settings, &AutoSwitchMemory::default(), NOW, false))
}

/// A card with the 7-day window only (an Ultra account: no 5-hour limit).
fn weekly_only(email: &str, seven: f64, p: P) -> ProviderUsage {
    let mut u = card(email, 0.0, seven, p);
    u.windows.retain(|w| w.id == WindowId::SevenDay);
    u
}

#[test]
fn strategy_setting_defaults_to_most_room_and_old_settings_load_unchanged() {
    assert_eq!(AutoSwitchSettings::default().strategy, Strategy::MostRoom);
    let old = json!({ "enabled": true, "mode": "switch", "cooldownMinutes": 30, "returnHome": false });
    let s = AutoSwitchSettings::from_value(Some(&old));
    assert_eq!(
        s,
        AutoSwitchSettings {
            enabled: true,
            mode: Mode::Switch,
            cooldown_minutes: 30,
            return_home: false,
            ..AutoSwitchSettings::default()
        }
    );
    for bad in [json!("x"), json!(1), json!(null), json!("room")] {
        assert_eq!(AutoSwitchSettings::from_value(Some(&json!({ "strategy": bad }))).strategy, Strategy::MostRoom);
    }
    assert_eq!(AutoSwitchSettings::from_value(Some(&json!({ "strategy": "weekly-first" }))).strategy, Strategy::WeeklyFirst);
}

#[test]
fn weekly_first_takes_the_soonest_weekly_reset_with_room_breaking_ties() {
    let providers = vec![
        main_card_of("a@x.com", 96.0, 50.0),
        card("late@x.com", 10.0, 10.0, P { seven: Some(6.0 * D), ..P::default() }),
        card("soon@x.com", 40.0, 80.0, P { seven: Some(D), ..P::default() }),
        // The same weekly reset as "soon" (within the 10-minute jitter) and more room: it wins the tie.
        card("soon2@x.com", 20.0, 70.0, P { seven: Some(D + 300.0), ..P::default() }),
        // Resets first but only 5 points under its 5-hour line: it would be left again within the cooldown.
        card("tight@x.com", 90.0, 10.0, P { seven: Some(12.0 * H), ..P::default() }),
        // No weekly reset known: last among the roomy ones.
        card("unknown@x.com", 0.0, 0.0, P { seven: Some(-S), ..P::default() }),
    ];
    assert_eq!(ranked(&providers, &on()), ["unknown@x.com", "late@x.com", "soon2@x.com", "soon@x.com", "tight@x.com"]);
    assert_eq!(ranked(&providers, &weekly()), ["soon2@x.com", "soon@x.com", "late@x.com", "unknown@x.com", "tight@x.com"]);
    match plan(&providers, &weekly(), &AutoSwitchMemory::default(), NOW) {
        Plan::Act { switch: true, reason: Reason::Limit, candidates, .. } => {
            assert_eq!(account_key(&candidates[0]), "soon2@x.com")
        }
        other => panic!("{other:?}"),
    }
    // A chosen account still wins over the strategy; thresholds still hold.
    let mut chosen = weekly();
    chosen.target.insert(Provider::Claude, "late@x.com".into());
    match plan(&providers, &chosen, &AutoSwitchMemory::default(), NOW) {
        Plan::Act { candidates, .. } => assert_eq!(keys(&candidates), ["late@x.com"]),
        other => panic!("{other:?}"),
    }
    let over = vec![main_card_of("a@x.com", 96.0, 50.0), card("over@x.com", 10.0, 98.0, P { seven: Some(H), ..P::default() })];
    assert!(ranked(&over, &weekly()).is_empty());
}

#[test]
fn at_limit_escapes_to_the_account_with_the_most_room_when_all_are_over_the_thresholds() {
    let providers = vec![
        main_card_of("a@x.com", 100.0, 40.0),
        card("b@x.com", 96.0, 10.0, P::default()),
        card("c@x.com", 95.0, 10.0, P { five: Some(3.0 * H), ..P::default() }),
        card("thin@x.com", 98.0, 10.0, P::default()),
        card("spent@x.com", 100.0, 10.0, P::default()),
        card("expired@x.com", 96.0, 10.0, P { status: Some(Status::Expired), ..P::default() }),
        card("old@x.com", 95.0, 10.0, P { fetched_at: Some(NOW - 3_600_000.0), ..P::default() }),
    ];
    for settings in [on(), weekly()] {
        match plan(&providers, &settings, &AutoSwitchMemory::default(), NOW) {
            Plan::Act { switch: true, reason: Reason::Escape, trigger: Some(t), candidates, .. } => {
                assert_eq!(keys(&candidates), ["c@x.com", "b@x.com"]);
                assert_eq!((t.window, t.percent), (WindowId::FiveHour, 100.0));
            }
            other => panic!("{other:?}"),
        }
    }
    // "ask": offered, not switched.
    let ask = AutoSwitchSettings { mode: Mode::Ask, ..on() };
    assert!(matches!(plan(&providers, &ask, &AutoSwitchMemory::default(), NOW), Plan::Act { switch: false, .. }));
    // Below 100% the app stays: no escape before the limit is really hit.
    let near = [vec![main_card_of("a@x.com", 99.0, 40.0)], providers[1..].to_vec()].concat();
    assert!(!matches!(plan(&near, &on(), &AutoSwitchMemory::default(), NOW), Plan::Act { .. }));
    let near_known = vec![main_card_of("a@x.com", 99.0, 40.0), providers[1].clone()];
    assert!(matches!(plan(&near_known, &on(), &AutoSwitchMemory::default(), NOW), Plan::Exhausted { .. }));
    // Less than 3 points of room is no gain worth a switch.
    let thin = vec![providers[0].clone(), providers[3].clone(), providers[4].clone()];
    assert!(matches!(plan(&thin, &on(), &AutoSwitchMemory::default(), NOW), Plan::Exhausted { .. }));
    // No ping-pong: an account left because of a limit is not escaped to before that limit reset.
    let left = AutoSwitchMemory {
        left: ["b@x.com", "c@x.com"]
            .map(|key| Mark { provider: Provider::Claude, key: key.into(), window: WindowId::FiveHour, resets_at: S + 5.0 * H })
            .to_vec(),
        ..AutoSwitchMemory::default()
    };
    assert!(!matches!(plan(&providers, &on(), &left, NOW), Plan::Act { .. }));
    // The cooldown holds.
    let cooling = AutoSwitchMemory { last: [(Provider::Claude, NOW - 60_000.0)].into(), ..AutoSwitchMemory::default() };
    assert_eq!(plan(&providers, &on(), &cooling, NOW), Plan::None(Skip::Cooldown));
    // A chosen account is the only one looked at.
    let mut target = on();
    target.target.insert(Provider::Claude, "b@x.com".into());
    match plan(&providers, &target, &AutoSwitchMemory::default(), NOW) {
        Plan::Act { candidates, .. } => assert_eq!(keys(&candidates), ["b@x.com"]),
        other => panic!("{other:?}"),
    }
    // A saved account below the thresholds still wins the normal way.
    let roomy = [providers.clone(), vec![card("free@x.com", 50.0, 10.0, P::default())]].concat();
    match plan(&roomy, &on(), &AutoSwitchMemory::default(), NOW) {
        Plan::Act { candidates, .. } => assert_eq!(keys(&candidates), ["free@x.com"]),
        other => panic!("{other:?}"),
    }
}

#[tokio::test]
async fn an_escape_offer_can_be_accepted() {
    let providers = vec![main_card_of("a@x.com", 100.0, 40.0), card("b@x.com", 96.0, 10.0, P::default())];
    let t = setup(AutoSwitchSettings { mode: Mode::Ask, ..on() }, providers.clone(), &[], false);
    t.switcher.on_state(providers).await;
    assert_eq!(*t.notices.lock(), ["EscapeOffer:b@x.com"]);
    let offer = t.switcher.current_offer().unwrap();
    assert_eq!((offer.reason, offer.room, offer.to_value()["reason"].as_str()), (Reason::Escape, Some(4.0), Some("escape")));
    assert_eq!(t.switcher.accept_offer().await, SwapResult::ok(Some("b@x.com".into())));
    assert_eq!(*t.swaps.lock(), ["claude:b@x.com"]);
}

#[test]
fn accounts_without_a_five_hour_window_are_judged_on_the_weekly_one() {
    // An Ultra main account: no 5-hour window, the weekly one decides alone.
    let ultra_main = weekly_only("u@x.com", 50.0, P { active: true, ..P::default() });
    assert!(switch_trigger(&ultra_main, &on(), NOW).is_none());
    let ultra_full = weekly_only("u@x.com", 98.0, P { active: true, ..P::default() });
    assert_eq!(switch_trigger(&ultra_full, &on(), NOW).map(|t| t.window), Some(WindowId::SevenDay));
    // An Ultra candidate counts its weekly room only (not 0 %, not unknown), and lands like any other account.
    let providers = vec![
        main_card_of("a@x.com", 96.0, 10.0),
        weekly_only("ultra@x.com", 20.0, P::default()),
        card("pro@x.com", 85.0, 10.0, P::default()),
    ];
    assert_eq!(room_of(&providers[1], NOW), 80.0);
    assert_eq!(ranked(&providers, &on()), ["ultra@x.com", "pro@x.com"]);
    assert_eq!(ranked(&providers, &weekly())[0], "ultra@x.com");
    // Over its weekly line it is no candidate; with the main account at its limit it is an escape by its weekly room.
    let over = vec![main_card_of("a@x.com", 100.0, 10.0), weekly_only("ultra@x.com", 99.0, P::default())];
    assert!(ranked(&over, &on()).is_empty());
    assert!(matches!(plan(&over, &on(), &AutoSwitchMemory::default(), NOW), Plan::Exhausted { .. }));
    let escape =
        vec![main_card_of("a@x.com", 100.0, 10.0), weekly_only("ultra@x.com", 98.0, P { seven: Some(H), ..P::default() })];
    assert!(matches!(plan(&escape, &on(), &AutoSwitchMemory::default(), NOW), Plan::Exhausted { .. }));
    let escape = vec![main_card_of("a@x.com", 100.0, 10.0), weekly_only("ultra@x.com", 96.0, P::default())];
    match plan(
        &escape,
        &AutoSwitchSettings { seven_day: WindowAlert { enabled: true, percent: 90 }, ..on() },
        &AutoSwitchMemory::default(),
        NOW,
    ) {
        Plan::Act { candidates, .. } => assert_eq!(keys(&candidates), ["ultra@x.com"]),
        other => panic!("{other:?}"),
    }
}
