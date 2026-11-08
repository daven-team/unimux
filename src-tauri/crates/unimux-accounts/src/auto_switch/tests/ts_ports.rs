//! Case-by-case ports of the auto-switch.test.ts cases the parent module ports only in part (its fixture).

use super::*;

fn ask() -> AutoSwitchSettings {
    AutoSwitchSettings { mode: Mode::Ask, ..on() }
}

fn with_primary(settings: AutoSwitchSettings, key: &str) -> AutoSwitchSettings {
    let mut s = settings;
    s.primary.insert(Provider::Claude, key.into());
    s
}

/// "is off by default with 95 % / 98 %, asks, returns home and reads damaged settings as defaults", "keeps any whole
/// threshold from 1 to 100 (1.1.2: a slider instead of fixed steps)"
#[test]
fn ts_defaults_damaged_settings_and_whole_thresholds() {
    let d = AutoSwitchSettings::default();
    assert_eq!((d.enabled, d.codex, d.mode, d.cooldown_minutes, d.return_home), (false, false, Mode::Ask, 15, true));
    assert_eq!(
        (d.five_hour, d.seven_day),
        (WindowAlert { enabled: true, percent: 95 }, WindowAlert { enabled: true, percent: 98 })
    );
    let damaged = AutoSwitchSettings::from_value(Some(
        &json!({ "enabled": "yes", "fiveHour": { "percent": 300 }, "mode": "now", "cooldownMinutes": 7, "target": { "claude": "A@X.COM", "codex": 5 } }),
    ));
    let mut want = d.clone();
    want.target.insert(Provider::Claude, "a@x.com".into());
    assert_eq!(damaged, want);
    assert_eq!(AutoSwitchSettings::from_value(None), d);
    for percent in [1, 50, 63, 95, 100] {
        let s = AutoSwitchSettings::from_value(Some(&json!({ "fiveHour": { "enabled": true, "percent": percent } })));
        assert_eq!(s.five_hour.percent, percent);
    }
    for percent in [json!(0), json!(101), json!(72.5), json!(-5), json!("80"), json!(null)] {
        let s = AutoSwitchSettings::from_value(Some(&json!({ "sevenDay": { "enabled": true, "percent": percent } })));
        assert_eq!(s.seven_day.percent, d.seven_day.percent, "{percent}");
    }
}

/// "reads a saved memory and drops damaged marks"
#[test]
fn ts_a_saved_memory_keeps_only_sound_marks() {
    let m = normalize_auto_switch_memory(Some(&json!({
        "last": { "claude": 5, "codex": "x" },
        "left": [{ "provider": "claude", "key": "a", "window": "5h", "resetsAt": 9 }, { "provider": "x" }],
        "offered": 3,
        "away": { "claude": "A" },
    })));
    assert_eq!(m.last, [(Provider::Claude, 5.0)].into());
    assert_eq!(m.left, [Mark { provider: Provider::Claude, key: "a".into(), window: WindowId::FiveHour, resets_at: 9.0 }]);
    assert!(m.offered.is_empty());
    assert_eq!(m.away, [(Provider::Claude, "a".to_string())].into());
}

/// "triggers at the 5-hour or 7-day threshold only with current numbers" (the expired sign-in and the disabled window)
#[test]
fn ts_an_expired_sign_in_and_a_disabled_window_never_trigger() {
    let main = main_card_of("a@x.com", 95.0, 10.0);
    let mut expired = main.clone();
    expired.status = Status::Expired;
    assert!(switch_trigger(&expired, &on(), NOW).is_none());
    let off = AutoSwitchSettings { five_hour: WindowAlert { enabled: false, percent: 95 }, ..on() };
    assert!(switch_trigger(&main, &off, NOW).is_none());
}

/// "switches only to the chosen account when one is set, and never over its thresholds"
#[test]
fn ts_switches_only_to_the_chosen_account_and_never_over_its_thresholds() {
    let mut chosen = on();
    chosen.target.insert(Provider::Claude, "c@x.com".into());
    let providers = vec![
        main_card_of("a@x.com", 96.0, 10.0),
        card("b@x.com", 10.0, 10.0, P::default()),
        card("c@x.com", 50.0, 10.0, P::default()),
    ];
    match plan(&providers, &chosen, &AutoSwitchMemory::default(), NOW) {
        Plan::Act { switch: true, candidates, .. } => assert_eq!(keys(&candidates), ["c@x.com"]),
        other => panic!("{other:?}"),
    }
    let over =
        vec![providers[0].clone(), providers[1].clone(), card("c@x.com", 97.0, 10.0, P { five: Some(3.0 * H), ..P::default() })];
    match plan(&over, &chosen, &AutoSwitchMemory::default(), NOW) {
        Plan::Exhausted { target, next, .. } => {
            assert_eq!((target.as_deref(), next), (Some("c@x.com"), Some((Some("c@x.com".into()), S + 3.0 * H))));
        }
        other => panic!("{other:?}"),
    }
}

/// "offers instead of switching in ask mode, once per limit period" (a new period of the main account is offered again)
#[test]
fn ts_a_new_limit_period_is_offered_again() {
    let told = AutoSwitchMemory {
        offered: vec![Mark {
            provider: Provider::Claude,
            key: "a@x.com".into(),
            window: WindowId::FiveHour,
            resets_at: S + 2.0 * H + 60.0,
        }],
        ..AutoSwitchMemory::default()
    };
    let providers = vec![
        card("a@x.com", 96.0, 10.0, P { active: true, five: Some(5.0 * H), ..P::default() }),
        card("b@x.com", 10.0, 10.0, P::default()),
    ];
    assert!(matches!(plan(&providers, &ask(), &told, NOW), Plan::Act { switch: false, .. }));
}

/// "never goes back to an account left because of a limit before that limit reset (no ping-pong)"
#[test]
fn ts_no_ping_pong_before_the_limit_that_was_left_reset() {
    let a = main_card_of("a@x.com", 96.0, 10.0);
    let memory = remember_switch(
        &AutoSwitchMemory::default(),
        Provider::Claude,
        &a,
        switch_trigger(&a, &on(), NOW),
        NOW,
        Some("b@x.com"),
        None,
    );
    // Now B is main and also over; A still shows old low numbers (a stale read): it is not chosen until its 5 h reset.
    let later = NOW + 20.0 * 60_000.0;
    let providers = vec![
        card("b@x.com", 97.0, 10.0, P { active: true, fetched_at: Some(later), ..P::default() }),
        card("a@x.com", 10.0, 10.0, P { account_id: Some("claude:a".into()), fetched_at: Some(later), ..P::default() }),
    ];
    assert!(matches!(plan(&providers, &on(), &memory, later), Plan::Exhausted { .. }));
    let after = NOW + 2.0 * H * 1000.0 + 60_000.0;
    let fresh = vec![
        card("b@x.com", 97.0, 10.0, P { active: true, fetched_at: Some(after), five: Some(3.0 * H), ..P::default() }),
        card(
            "a@x.com",
            0.0,
            10.0,
            P { account_id: Some("claude:a".into()), fetched_at: Some(after), five: Some(7.0 * H), ..P::default() },
        ),
    ];
    match plan(&fresh, &on(), &memory, after) {
        Plan::Act { switch: true, candidates, .. } => assert_eq!(keys(&candidates), ["a@x.com"]),
        other => panic!("{other:?}"),
    }
}

/// "returns to the primary account once it is usable again after its reset (example of the user: A -> B -> A)" (before the
/// reset and with "return after the reset" off), "does not return home within the cooldown"
#[test]
fn ts_the_return_home_waits_for_the_reset_the_setting_and_the_cooldown() {
    let settings = with_primary(on(), "a@x.com");
    let a = main_card_of("a@x.com", 95.0, 10.0);
    let memory = remember_switch(
        &AutoSwitchMemory::default(),
        Provider::Claude,
        &a,
        switch_trigger(&a, &settings, NOW),
        NOW,
        Some("b@x.com"),
        Some("a@x.com"),
    );
    let t1 = NOW + 30.0 * 60_000.0;
    let before = vec![
        card("b@x.com", 40.0, 10.0, P { active: true, fetched_at: Some(t1), ..P::default() }),
        card("a@x.com", 95.0, 10.0, P { account_id: Some("claude:a".into()), fetched_at: Some(t1), ..P::default() }),
    ];
    assert!(matches!(plan(&before, &settings, &memory, t1), Plan::None(_)));
    let t2 = NOW + 2.0 * H * 1000.0 + 5.0 * 60_000.0;
    let after = vec![
        card("b@x.com", 60.0, 10.0, P { active: true, fetched_at: Some(t2), ..P::default() }),
        card(
            "a@x.com",
            1.0,
            10.0,
            P { account_id: Some("claude:a".into()), fetched_at: Some(t2), five: Some(7.0 * H), ..P::default() },
        ),
    ];
    let stay = AutoSwitchSettings { return_home: false, ..settings.clone() };
    let away = AutoSwitchMemory { away: [(Provider::Claude, "a@x.com".to_string())].into(), ..AutoSwitchMemory::default() };
    assert!(matches!(plan(&after, &stay, &away, t2), Plan::None(_)));

    let cooling = AutoSwitchMemory {
        last: [(Provider::Claude, NOW - 60_000.0)].into(),
        away: [(Provider::Claude, "a@x.com".to_string())].into(),
        ..AutoSwitchMemory::default()
    };
    let providers = vec![main_card_of("b@x.com", 50.0, 10.0), card("a@x.com", 1.0, 10.0, P::default())];
    assert!(matches!(plan(&providers, &settings, &cooling, NOW), Plan::None(_)));
}

/// "when every account is over a threshold it stays and says so once, with the earliest reset" (nextAvailable and the told
/// mark)
#[test]
fn ts_everyone_over_the_threshold_is_told_once_with_the_earliest_reset() {
    let providers = vec![
        card("a@x.com", 97.0, 10.0, P { active: true, five: Some(4.0 * H), ..P::default() }),
        card("b@x.com", 99.0, 10.0, P { five: Some(H), ..P::default() }),
        card("c@x.com", 20.0, 99.0, P { seven: Some(2.0 * 24.0 * H), ..P::default() }),
    ];
    assert_eq!(next_available(&providers, Provider::Claude, &on(), NOW, None), Some((Some("b@x.com".into()), S + H)));
    let told = AutoSwitchMemory {
        offered: vec![Mark {
            provider: Provider::Claude,
            key: "exhausted:a@x.com".into(),
            window: WindowId::FiveHour,
            resets_at: S + 4.0 * H,
        }],
        ..AutoSwitchMemory::default()
    };
    assert_eq!(plan(&providers, &on(), &told, NOW), Plan::None(Skip::NoCandidate));
}

/// "is off for Codex unless chosen"
#[test]
fn ts_codex_is_off_unless_chosen() {
    let codex = |email: &str, five: f64, active: bool| {
        let mut u = card(email, five, 10.0, P { active, ..P::default() });
        u.provider = Provider::Codex;
        u.account_id = if active { "codex:main".into() } else { format!("codex:{email}") };
        u
    };
    let providers = vec![codex("a@x.com", 96.0, true), codex("b@x.com", 10.0, false)];
    let memory = AutoSwitchMemory::default();
    assert_eq!(plan_auto_switch(&providers, Provider::Codex, &on(), &memory, NOW), Plan::None(Skip::Off));
    let chosen = AutoSwitchSettings { codex: true, ..on() };
    assert!(matches!(plan_auto_switch(&providers, Provider::Codex, &chosen, &memory, NOW), Plan::Act { switch: true, .. }));
}
