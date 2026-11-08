//! The usage endpoints' answers (port of src/main/usage/parse.ts).

use serde_json::{Map, Value};

use super::types::{UsageWindow, WindowId, clamp_percent};
use crate::js;
use crate::localtime::{days_from_civil, local_to_utc};

type Json = Map<String, Value>;

/// `Number(value)` of a string: JS white space trimmed, decimal (with exponent) or 0x / 0o / 0b integers; NaN otherwise.
fn js_number_of(text: &str) -> f64 {
    let t = js::trim(text);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |digits: &str, radix: u32| -> f64 {
        if digits.is_empty() {
            return f64::NAN;
        }
        digits
            .chars()
            .try_fold(0f64, |acc, c| c.to_digit(radix).map(|d| acc * f64::from(radix) + f64::from(d)))
            .unwrap_or(f64::NAN)
    };
    let lower = t.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("0x") {
        return radix(rest, 16);
    }
    if let Some(rest) = lower.strip_prefix("0o") {
        return radix(rest, 8);
    }
    if let Some(rest) = lower.strip_prefix("0b") {
        return radix(rest, 2);
    }
    let body = t.strip_prefix(['+', '-']).unwrap_or(t);
    if body == "Infinity" {
        return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    // Rust also reads "inf" / "nan" and accepts nothing JS would not, apart from those.
    if !body.bytes().all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-')) {
        return f64::NAN;
    }
    t.parse::<f64>().unwrap_or(f64::NAN)
}

/// `num`: a finite number, or a non-blank string whose `Number()` is finite.
pub fn num(value: Option<&Value>) -> Option<f64> {
    match value? {
        Value::Number(n) => n.as_f64().filter(|f| f.is_finite()),
        Value::String(s) if !js::trim(s).is_empty() => Some(js_number_of(s)).filter(|f| f.is_finite()),
        _ => None,
    }
}

fn to_seconds(value: f64) -> f64 {
    (if value > 1e12 { value / 1000.0 } else { value }).floor()
}

fn digits(s: &str, len: usize) -> Option<i64> {
    (s.len() == len && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten()
}

/// `Date.parse` of the ISO forms the endpoints write: `YYYY-MM-DD` (UTC) and `YYYY-MM-DDTHH:MM[:SS[.fraction]]` with `Z` or
/// `±HH:MM` (without one: local time). NaN for anything else.
pub fn parse_iso_date(text: &str) -> f64 {
    let t = text.trim();
    let (date, rest) = match t.split_once(['T', 't', ' ']) {
        Some((d, r)) => (d, Some(r)),
        None => (t, None),
    };
    let mut parts = date.split('-');
    let (Some(y), Some(mo), Some(d), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
        return f64::NAN;
    };
    let (Some(y), Some(mo), Some(d)) = (digits(y, 4), digits(mo, 2), digits(d, 2)) else { return f64::NAN };
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) {
        return f64::NAN;
    }
    let day_ms = (days_from_civil(y, mo, d) * 86_400_000) as f64;
    let Some(rest) = rest else { return day_ms };
    let (clock, offset) = if let Some(c) = rest.strip_suffix(['Z', 'z']) {
        (c, Some(0i64))
    } else if let Some(i) = rest.rfind(['+', '-']) {
        let (c, o) = rest.split_at(i);
        let sign = if o.starts_with('-') { -1 } else { 1 };
        let o = &o[1..];
        let (h, m) = match o.split_once(':') {
            Some((h, m)) => (digits(h, 2), digits(m, 2)),
            None if o.len() == 4 => (digits(&o[..2], 2), digits(&o[2..], 2)),
            _ => (None, None),
        };
        let (Some(h), Some(m)) = (h, m) else { return f64::NAN };
        (c, Some(sign * (h * 60 + m)))
    } else {
        (rest, None)
    };
    let mut fields = clock.split(':');
    let (Some(h), Some(mi)) = (fields.next().and_then(|h| digits(h, 2)), fields.next().and_then(|m| digits(m, 2))) else {
        return f64::NAN;
    };
    let (s, ms) = match fields.next() {
        None => (0, 0.0),
        Some(sec) => {
            let (whole, frac) = sec.split_once('.').map_or((sec, None), |(w, f)| (w, Some(f)));
            let Some(s) = digits(whole, 2) else { return f64::NAN };
            let ms = match frac {
                None => 0.0,
                Some(f) if !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()) => {
                    let three: String = f.chars().chain(std::iter::repeat('0')).take(3).collect();
                    three.parse::<f64>().unwrap_or(0.0)
                }
                Some(_) => return f64::NAN,
            };
            (s, ms)
        }
    };
    if fields.next().is_some() || h > 24 || mi > 59 || s > 59 {
        return f64::NAN;
    }
    let wall = day_ms + ((h * 3600 + mi * 60 + s) * 1000) as f64 + ms;
    match offset {
        Some(minutes) => wall - (minutes * 60_000) as f64,
        None => local_to_utc(wall),
    }
}

/// `parseClaudeUsage`: `{ five_hour: { utilization, resets_at }, seven_day: {...} }`. `None` when the body is not a usage
/// object at all; an empty list when it is one without a usable window.
pub fn parse_claude_usage(body: &Value) -> Option<Vec<UsageWindow>> {
    let body = body.as_object()?;
    if !body.contains_key("five_hour") && !body.contains_key("seven_day") {
        return None;
    }
    let mut windows = Vec::new();
    for (key, id) in [("five_hour", WindowId::FiveHour), ("seven_day", WindowId::SevenDay)] {
        let Some(raw) = js::record(body.get(key)) else { continue };
        let Some(used) = num(raw.get("utilization")) else { continue };
        let resets = match raw.get("resets_at") {
            Some(Value::String(s)) => parse_iso_date(s),
            _ => f64::NAN,
        };
        windows.push(UsageWindow {
            id,
            used_percent: clamp_percent(used),
            resets_at: if resets.is_finite() { (resets / 1000.0).floor() } else { 0.0 },
        });
    }
    Some(windows)
}

fn codex_window(raw: Option<&Value>, fallback: WindowId, now_ms: f64) -> Option<UsageWindow> {
    let raw = js::record(raw)?;
    let used = num(raw.get("used_percent")).or_else(|| num(raw.get("utilization")))?;
    let seconds = num(raw.get("limit_window_seconds"));
    let minutes = num(raw.get("window_minutes")).or_else(|| seconds.filter(|s| *s > 0.0).map(|s| s / 60.0));
    let id = match minutes {
        None => fallback,
        Some(m) if m <= 24.0 * 60.0 => WindowId::FiveHour,
        Some(_) => WindowId::SevenDay,
    };
    let at = num(raw.get("resets_at")).or_else(|| num(raw.get("reset_at")));
    let after = num(raw.get("reset_after_seconds")).or_else(|| num(raw.get("resets_in_seconds")));
    let resets_at = match (at, after) {
        (Some(at), _) => to_seconds(at),
        (None, Some(after)) => (now_ms / 1000.0 + after).floor(),
        _ => 0.0,
    };
    Some(UsageWindow { id, used_percent: clamp_percent(used), resets_at })
}

/// `parseCodexRateLimits`: the live response or a session log event (`primary` / `secondary`, optionally nested).
pub fn parse_codex_rate_limits(body: &Value, now_ms: f64) -> Option<Vec<UsageWindow>> {
    let body = body.as_object()?;
    fn has_windows(candidate: Option<&Value>) -> Option<&Json> {
        let c = js::record(candidate)?;
        ["primary_window", "primary", "secondary_window", "secondary"]
            .iter()
            .any(|k| js::record(c.get(*k)).is_some())
            .then_some(c)
    }
    let flat = ["primary_window", "primary", "secondary_window", "secondary"].iter().any(|k| js::record(body.get(*k)).is_some());
    let source = has_windows(body.get("rate_limit")).or_else(|| has_windows(body.get("rate_limits"))).or(flat.then_some(body))?;
    // `a ?? b`: a present non-null value wins even when it is not an object.
    let pick = |a: &str, b: &str| -> Option<&Value> {
        match source.get(a) {
            Some(Value::Null) | None => source.get(b),
            v => v,
        }
    };
    let primary = codex_window(pick("primary_window", "primary"), WindowId::FiveHour, now_ms);
    let mut secondary = codex_window(pick("secondary_window", "secondary"), WindowId::SevenDay, now_ms);
    if let (Some(p), Some(s)) = (&primary, &mut secondary)
        && p.id == s.id
    {
        s.id = if p.id == WindowId::FiveHour { WindowId::SevenDay } else { WindowId::FiveHour };
    }
    let mut windows: Vec<UsageWindow> = [primary, secondary].into_iter().flatten().collect();
    // A stable sort, 5h first.
    windows.sort_by_key(|w| if w.id == WindowId::FiveHour { 0 } else { 1 });
    (!windows.is_empty()).then_some(windows)
}

/// `parseCodexPlan`.
pub fn parse_codex_plan(body: &Value) -> Option<String> {
    let body = body.as_object()?;
    let nested = js::record(body.get("rate_limits")).and_then(|r| r.get("plan_type"));
    let plan = match body.get("plan_type") {
        Some(Value::Null) | None => nested,
        v => v,
    };
    plan.and_then(Value::as_str).filter(|p| !p.is_empty()).map(str::to_string)
}

/// `decodeJwtClaims`: the claims of a JWT; the signature is not checked (the token only labels the account).
pub fn decode_jwt_claims(token: &str) -> Option<Json> {
    let part = token.split('.').nth(1).filter(|p| !p.is_empty())?;
    let bytes = js::base64url_decode(part);
    let text = String::from_utf8_lossy(&bytes);
    match unimux_core::js_json::parse(&text) {
        Ok(Value::Object(m)) => Some(m),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn claude_windows_with_an_exhausted_window_and_extra_keys() {
        let body = json!({
            "five_hour": { "utilization": 104, "resets_at": null },
            "seven_day": { "utilization": "37.5", "resets_at": "2026-11-06T12:30:00.123456+00:00" },
            "seven_day_opus": { "utilization": 1 },
        });
        let w = parse_claude_usage(&body).unwrap();
        assert_eq!(w.len(), 2);
        assert_eq!((w[0].id, w[0].used_percent, w[0].resets_at), (WindowId::FiveHour, 100.0, 0.0));
        assert_eq!((w[1].id, w[1].used_percent, w[1].resets_at), (WindowId::SevenDay, 37.5, 1_793_968_200.0));
        assert_eq!(parse_claude_usage(&json!({ "five_hour": "x" })).unwrap(), vec![]);
        assert!(parse_claude_usage(&json!({ "error": 1 })).is_none());
        assert!(parse_claude_usage(&json!([1])).is_none());
    }

    #[test]
    fn codex_windows_nested_or_flat_with_ids_from_their_length() {
        let now = 1_000_000_000_000.0;
        let body = json!({ "plan_type": "plus", "rate_limit": {
            "primary_window": { "used_percent": 12, "limit_window_seconds": 18000, "reset_after_seconds": 60 },
            "secondary_window": { "used_percent": 50, "limit_window_seconds": 604800, "reset_at": 1_700_000_000_000u64 },
        }});
        let w = parse_codex_rate_limits(&body, now).unwrap();
        assert_eq!((w[0].id, w[0].resets_at), (WindowId::FiveHour, 1_000_000_060.0));
        assert_eq!((w[1].id, w[1].resets_at), (WindowId::SevenDay, 1_700_000_000.0));
        assert_eq!(parse_codex_plan(&body).as_deref(), Some("plus"));
        // Two windows of the same length: the second takes the other id; sorted 5h first.
        let same = json!({ "primary": { "used_percent": 1, "window_minutes": 10080 }, "secondary": { "used_percent": 2, "window_minutes": 10080 } });
        let w = parse_codex_rate_limits(&same, now).unwrap();
        assert_eq!((w[0].id, w[0].used_percent), (WindowId::FiveHour, 2.0));
        assert_eq!((w[1].id, w[1].used_percent), (WindowId::SevenDay, 1.0));
        assert!(parse_codex_rate_limits(&json!({ "primary": 1 }), now).is_none());
        assert_eq!(parse_codex_plan(&json!({ "rate_limits": { "plan_type": "pro" } })).as_deref(), Some("pro"));
    }

    #[test]
    fn jwt_claims_and_numbers() {
        // {"email":"a@b.c"}
        assert_eq!(decode_jwt_claims("x.eyJlbWFpbCI6ImFAYi5jIn0.sig").unwrap()["email"], "a@b.c");
        assert!(decode_jwt_claims("x").is_none());
        assert!(decode_jwt_claims("x.bm90IGpzb24.y").is_none());
        assert_eq!(num(Some(&json!(" 0x10 "))), Some(16.0));
        assert_eq!(num(Some(&json!("1e2"))), Some(100.0));
        assert_eq!(num(Some(&json!("inf"))), None);
        assert_eq!(num(Some(&json!(""))), None);
        assert_eq!(parse_iso_date("2026-11-06"), 1_793_923_200_000.0);
        assert_eq!(parse_iso_date("2026-11-06T13:30:00+01:00"), 1_793_968_200_000.0);
        assert!(parse_iso_date("soon").is_nan());
    }
}
