//! The settings normalizers of 1.1.4: alerts (shared/alerts.ts), the automatic account switch (shared/autoSwitch.ts),
//! delegation (shared/delegation.ts), update mode, panels, scrollback, SSH theme / bar, side panels, strip scope, background
//! load and the defaults they fall back to.

use super::js::{self, Js, Throw};
use serde_json::{Map, Value, json};

pub const LANGUAGES: [&str; 6] = ["en", "pl", "de", "es", "fr", "pt"];
pub const SSH_THEME_IDS: [&str; 7] = [
    "unimux-dark",
    "unimux-midnight",
    "unimux-cyberpunk",
    "unimux-fjord",
    "unimux-lagoon",
    "unimux-nightshade",
    "unimux-daylight",
];
pub const DEFAULT_SSH_THEME: &str = "unimux-dark";
const PRESET_IDS: [&str; 8] = ["ding-dong", "chime", "soft-bell", "marimba", "pluck", "retro", "alert", "low-warn"];
const SSH_BAR_ITEMS: [&str; 7] = ["host", "cpu", "mem", "net", "uptime", "user", "disk"];
const OPTIONAL_PANELS: [&str; 2] = ["monitor", "waiting"];
pub const LEGACY_ALERT_KEYS: [&str; 5] =
    ["notifications", "waitingSound", "waitingSoundFile", "waitingSoundVolume", "notifyWhenFocused"];

fn one_of(v: Option<&Value>, list: &[&str]) -> bool {
    js::string(v).is_some_and(|s| list.contains(&s))
}

fn num_one_of(v: Option<&Value>, list: &[f64]) -> bool {
    js::number(v).is_some_and(|n| list.contains(&n))
}

pub fn is_language(v: Option<&Value>) -> bool {
    one_of(v, &LANGUAGES)
}

pub fn default_limit_alerts() -> Value {
    json!({"enabled": true, "fiveHour": {"enabled": true, "percent": 80}, "sevenDay": {"enabled": true, "percent": 90}, "resets": false})
}

pub fn default_alerts() -> Value {
    json!({
        "enabled": true,
        "volume": 0.7,
        "notifyWhenFocused": false,
        "quietHours": {"enabled": false, "start": "22:00", "end": "07:00"},
        "events": {
            "done": {"notify": true, "sound": {"kind": "preset", "id": "ding-dong"}},
            "attention": {"notify": true, "sound": {"kind": "preset", "id": "alert"}},
            "error": {"notify": true, "sound": {"kind": "preset", "id": "low-warn"}},
        },
        "notificationActions": true,
        "flashWindow": true,
        "taskbarBadge": true,
        "limits": default_limit_alerts(),
    })
}

pub fn default_auto_switch() -> Value {
    json!({
        "enabled": false, "codex": false, "fiveHour": {"enabled": true, "percent": 95}, "sevenDay": {"enabled": true, "percent": 98},
        "mode": "ask", "cooldownMinutes": 15, "target": {}, "primary": {}, "returnHome": true,
    })
}

fn bool_or(v: Option<&Value>, fallback: bool) -> Value {
    Value::Bool(js::boolean(v).unwrap_or(fallback))
}

fn is_threshold(v: Option<&Value>) -> bool {
    js::integer(v).is_some_and(|n| (1.0..=100.0).contains(&n))
}

/// `{ enabled, percent }` of a limit window (alerts and the automatic switch read it the same way).
fn window(raw: Option<&Value>, fallback: &Value) -> Value {
    let w = js::record(raw).map(|o| Value::Object(o.clone()));
    let w = w.as_ref();
    json!({
        "enabled": bool_or(js::get(w, "enabled"), fallback["enabled"].as_bool().unwrap_or(true)),
        "percent": if is_threshold(js::get(w, "percent")) { js::get(w, "percent").cloned().unwrap_or(Value::Null) } else { fallback["percent"].clone() },
    })
}

pub fn normalize_volume(v: Option<&Value>) -> Value {
    match js::number(v) {
        Some(n) => js::num(js::round(n.clamp(0.0, 1.0) * 100.0) / 100.0),
        None => js::num(0.7),
    }
}

/// `/^([01]\d|2[0-3]):([0-5]\d)$/`.
fn is_time(v: Option<&Value>) -> bool {
    let Some(s) = js::string(v) else { return false };
    let b = s.as_bytes();
    b.len() == 5
        && b[2] == b':'
        && ((matches!(b[0], b'0' | b'1') && b[1].is_ascii_digit()) || (b[0] == b'2' && (b'0'..=b'3').contains(&b[1])))
        && (b'0'..=b'5').contains(&b[3])
        && b[4].is_ascii_digit()
}

fn normalize_quiet_hours(v: Option<&Value>) -> Value {
    json!({
        "enabled": js::is_true(js::get(v, "enabled")),
        "start": if is_time(js::get(v, "start")) { js::get(v, "start").cloned().unwrap_or(Value::Null) } else { Value::from("22:00") },
        "end": if is_time(js::get(v, "end")) { js::get(v, "end").cloned().unwrap_or(Value::Null) } else { Value::from("07:00") },
    })
}

/// `isLocalAbsolutePath`: a drive path or a POSIX path, never UNC.
fn is_local_absolute(path: &str) -> bool {
    let b = path.as_bytes();
    if b.len() >= 2 && matches!(b[0], b'\\' | b'/') && matches!(b[1], b'\\' | b'/') {
        return false;
    }
    (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'\\' | b'/')) || path.starts_with('/')
}

fn is_usable_path(v: Option<&Value>) -> bool {
    js::string(v).is_some_and(|s| {
        let n = js::len16(s);
        n > 0 && n <= 1024 && !s.contains('\0') && is_local_absolute(s)
    })
}

fn normalize_sound(v: Option<&Value>, fallback: &Value) -> Value {
    if js::record(v).is_none() {
        return fallback.clone();
    }
    let kind = js::string(js::get(v, "kind"));
    match kind {
        Some("off") => json!({"kind": "off"}),
        Some("system") => json!({"kind": "system"}),
        Some("preset") if one_of(js::get(v, "id"), &PRESET_IDS) => json!({"kind": "preset", "id": js::get(v, "id")}),
        Some("file") if is_usable_path(js::get(v, "path")) => json!({"kind": "file", "path": js::get(v, "path")}),
        _ => fallback.clone(),
    }
}

fn normalize_limit_alerts(v: Option<&Value>) -> Value {
    let r = js::record(v).map(|o| Value::Object(o.clone()));
    let r = r.as_ref();
    let d = default_limit_alerts();
    json!({
        "enabled": bool_or(js::get(r, "enabled"), true),
        "fiveHour": window(js::get(r, "fiveHour"), &d["fiveHour"]),
        "sevenDay": window(js::get(r, "sevenDay"), &d["sevenDay"]),
        "resets": bool_or(js::get(r, "resets"), false),
    })
}

/// `normalizeAlerts`: every missing or damaged field falls back to its default.
pub fn normalize_alerts(v: Option<&Value>) -> Value {
    let r = js::record(v).map(|o| Value::Object(o.clone()));
    let r = r.as_ref();
    let d = default_alerts();
    let events = js::record(js::get(r, "events")).map(|o| Value::Object(o.clone()));
    let event = |id: &str| {
        let e = js::record(js::get(events.as_ref(), id)).map(|o| Value::Object(o.clone()));
        let e = e.as_ref();
        json!({"notify": bool_or(js::get(e, "notify"), true), "sound": normalize_sound(js::get(e, "sound"), &d["events"][id]["sound"])})
    };
    json!({
        "enabled": bool_or(js::get(r, "enabled"), true),
        "volume": normalize_volume(js::get(r, "volume")),
        "notifyWhenFocused": bool_or(js::get(r, "notifyWhenFocused"), false),
        "quietHours": normalize_quiet_hours(js::get(r, "quietHours")),
        "events": {"done": event("done"), "attention": event("attention"), "error": event("error")},
        "notificationActions": bool_or(js::get(r, "notificationActions"), true),
        "flashWindow": bool_or(js::get(r, "flashWindow"), true),
        "taskbarBadge": bool_or(js::get(r, "taskbarBadge"), true),
        "limits": normalize_limit_alerts(js::get(r, "limits")),
    })
}

/// `readAlerts(settings)`: the saved alerts, or the migration of the retired keys. `in` on a primitive throws.
pub fn read_alerts(settings: Option<&Value>) -> Js<Value> {
    let s = match settings {
        None | Some(Value::Null) => return Ok(default_alerts()),
        Some(v @ (Value::Object(_) | Value::Array(_))) => v,
        Some(_) => return Err(Throw),
    };
    if let Some(alerts) = js::record(js::get(Some(s), "alerts")) {
        return Ok(normalize_alerts(Some(&Value::Object(alerts.clone()))));
    }
    // migrateLegacyAlerts
    let Some(o) = s.as_object() else { return Ok(default_alerts()) };
    if !LEGACY_ALERT_KEYS.iter().any(|k| o.contains_key(*k)) {
        return Ok(default_alerts());
    }
    let notify = js::boolean(o.get("notifications")).unwrap_or(true);
    let volume = match js::number(o.get("waitingSoundVolume")) {
        Some(n) => normalize_volume(Some(&js::num(n / 100.0))),
        None => js::num(0.7),
    };
    let file = o.get("waitingSoundFile");
    let waiting = match js::string(o.get("waitingSound")) {
        Some("system") => json!({"kind": "system"}),
        Some("custom") if is_usable_path(file) => json!({"kind": "file", "path": file}),
        Some("custom") => json!({"kind": "system"}),
        _ => json!({"kind": "off"}),
    };
    let mut d = default_alerts();
    d["volume"] = volume;
    d["notifyWhenFocused"] = Value::Bool(js::is_true(o.get("notifyWhenFocused")));
    d["events"] = json!({
        "done": {"notify": notify, "sound": waiting},
        "attention": {"notify": notify, "sound": waiting},
        "error": {"notify": notify, "sound": waiting},
    });
    Ok(d)
}

fn per_provider(v: Option<&Value>) -> Value {
    let mut out = Map::new();
    if js::record(v).is_some() {
        for provider in ["claude", "codex"] {
            if let Some(s) = js::string(js::get(v, provider)) {
                let n = js::len16(s);
                if n > 0 && n <= 160 {
                    out.insert(provider.into(), Value::from(s.to_lowercase()));
                }
            }
        }
    }
    Value::Object(out)
}

pub fn normalize_auto_switch(v: Option<&Value>) -> Value {
    let r = js::record(v).map(|o| Value::Object(o.clone()));
    let r = r.as_ref();
    let d = default_auto_switch();
    let cooldown = js::get(r, "cooldownMinutes");
    json!({
        "enabled": bool_or(js::get(r, "enabled"), false),
        "codex": bool_or(js::get(r, "codex"), false),
        "fiveHour": window(js::get(r, "fiveHour"), &d["fiveHour"]),
        "sevenDay": window(js::get(r, "sevenDay"), &d["sevenDay"]),
        "mode": if one_of(js::get(r, "mode"), &["switch", "ask"]) { js::get(r, "mode").cloned().unwrap_or(Value::Null) } else { Value::from("ask") },
        "cooldownMinutes": if num_one_of(cooldown, &[5.0, 15.0, 30.0, 60.0]) { cooldown.cloned().unwrap_or(Value::Null) } else { Value::from(15) },
        "target": per_provider(js::get(r, "target")),
        "primary": per_provider(js::get(r, "primary")),
        "returnHome": bool_or(js::get(r, "returnHome"), true),
    })
}

pub fn normalize_delegation(v: Option<&Value>) -> Value {
    // `value && typeof value === 'object'`: arrays pass too (and have no such fields).
    let v = if js::object_like(v) { v } else { None };
    let mode = js::get(v, "mode");
    let max = js::get(v, "maxAgents");
    let max_agents = match max {
        None => Value::from(4),
        Some(m) => {
            let n = match m {
                Value::Number(_) => js::number(Some(m)).unwrap_or(f64::NAN),
                Value::String(s) if !js::trim(s).is_empty() => js::string_to_number(s),
                _ => f64::NAN,
            };
            if n.is_finite() { js::num(js::round(n).clamp(1.0, 20.0)) } else { Value::from(4) }
        }
    };
    json!({"mode": if one_of(mode, &["auto", "ask"]) { mode.cloned().unwrap_or(Value::Null) } else { Value::from("auto") }, "maxAgents": max_agents})
}

pub fn normalize_update_mode(v: Option<&Value>, legacy: Option<&Value>) -> Value {
    if one_of(v, &["manual", "ask"]) {
        return v.cloned().unwrap_or(Value::Null);
    }
    if js::string(v) == Some("auto") {
        return Value::from("ask");
    }
    match js::boolean(legacy) {
        Some(true) => Value::from("ask"),
        _ => Value::from("manual"),
    }
}

/// `normalizePanelWidth` (sidebar 200..480, default 228; snippets 220..520, default 280).
pub fn panel_width(v: Option<&Value>, min: f64, max: f64, default: i64) -> Value {
    match js::number(v) {
        Some(n) => js::num(js::round(n.clamp(min, max))),
        None => Value::from(default),
    }
}

pub fn normalize_scrollback(v: Option<&Value>) -> Value {
    if num_one_of(v, &[1000.0, 2500.0, 5000.0, 10_000.0, 25_000.0]) {
        v.cloned().unwrap_or(Value::Null)
    } else {
        Value::from(5000)
    }
}

pub fn normalize_ssh_theme(v: Option<&Value>) -> Value {
    if one_of(v, &SSH_THEME_IDS) { v.cloned().unwrap_or(Value::Null) } else { Value::from(DEFAULT_SSH_THEME) }
}

pub fn is_ssh_theme(v: Option<&Value>) -> bool {
    one_of(v, &SSH_THEME_IDS)
}

fn flags(v: Option<&Value>, names: &[&str], keep: bool) -> Option<Value> {
    if !js::object_like(v) {
        return None;
    }
    let mut out = Map::new();
    for name in names {
        if js::get(v, name) == Some(&Value::Bool(keep)) {
            out.insert((*name).into(), Value::Bool(keep));
        }
    }
    (!out.is_empty()).then_some(Value::Object(out))
}

/// `normalizeBarItems`: only `false` toggles of known items; undefined when none.
pub fn normalize_bar_items(v: Option<&Value>) -> Option<Value> {
    flags(v, &SSH_BAR_ITEMS, false)
}

/// `normalizeSidePanels`: only `true` switches of known optional panels; undefined when none.
pub fn normalize_side_panels(v: Option<&Value>) -> Option<Value> {
    flags(v, &OPTIONAL_PANELS, true)
}

pub fn normalize_strip_scope(v: Option<&Value>) -> Value {
    if one_of(v, &["all", "project"]) { v.cloned().unwrap_or(Value::Null) } else { Value::from("all") }
}

pub fn normalize_background_load(v: Option<&Value>) -> Value {
    if one_of(v, &["visible", "project", "all"]) { v.cloned().unwrap_or(Value::Null) } else { Value::from("project") }
}
