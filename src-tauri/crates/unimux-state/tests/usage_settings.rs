//! Ports of the usage settings cases of test/usage-shared.test.ts: the defaults of the limits panel and how a saved state's
//! choices are kept or repaired.

use serde_json::{Value, json};
use unimux_state::Platform;
use unimux_state::normalize::state::{Env, default_state, normalize_state};

fn normalized(raw: &Value) -> Value {
    let mut n = 0u64;
    let mut uid = || {
        n += 1;
        format!("00000000-0000-4000-8000-{n:012}")
    };
    let mut env = Env { now_ms: 1_791_720_000_000.0, uid: &mut uid };
    normalize_state(raw, Platform::Win32, &mut env).unwrap()
}

fn usage_settings(state: &Value) -> (Value, Value, Value) {
    let s = &state["settings"];
    (s["showAiUsage"].clone(), s["usageIntervalMinutes"].clone(), s["usageCollapsed"].clone())
}

/// "shows the limits expanded and refreshes every 5 minutes by default"
#[test]
fn the_limits_are_shown_expanded_and_read_every_5_minutes_by_default() {
    for platform in [Platform::Win32, Platform::Darwin] {
        assert_eq!(usage_settings(&default_state(platform)), (json!(true), json!(5), json!(false)));
    }
}

/// "keeps valid choices and repairs invalid ones"
#[test]
fn valid_usage_choices_are_kept_and_invalid_ones_repaired() {
    let mut raw = default_state(Platform::Win32);
    let set = |raw: &mut Value, a: Value, b: Value, c: Value| {
        let s = raw["settings"].as_object_mut().unwrap();
        s.insert("showAiUsage".into(), a);
        s.insert("usageIntervalMinutes".into(), b);
        s.insert("usageCollapsed".into(), c);
    };
    set(&mut raw, json!(false), json!(15), json!(true));
    assert_eq!(usage_settings(&normalized(&raw)), (json!(false), json!(15), json!(true)));
    set(&mut raw, json!("yes"), json!(7), json!(1));
    assert_eq!(usage_settings(&normalized(&raw)), (json!(true), json!(5), json!(false)));
    for key in ["showAiUsage", "usageIntervalMinutes", "usageCollapsed"] {
        raw["settings"].as_object_mut().unwrap().remove(key);
    }
    assert_eq!(usage_settings(&normalized(&raw)), (json!(true), json!(5), json!(false)));
}
