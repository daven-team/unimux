//! Rebuilds a usage object from whitelisted fields only (port of src/main/usage/sanitize.ts), so nothing unknown reaches the
//! state, the listeners or the cache file.

use serde_json::Value;

use super::types::{HeldBy, Provider, ProviderUsage, Source, Status, UsageWindow, WindowId, clamp_percent};
use crate::js;

fn text(value: Option<&Value>, max: usize) -> Option<String> {
    match value {
        Some(Value::String(s)) if !s.is_empty() => Some(unimux_core::utf16::slice(s, 0, max)),
        _ => None,
    }
}

fn stamp(value: Option<&Value>) -> Option<f64> {
    js::finite(value).filter(|v| *v >= 0.0)
}

/// `sanitizeUsage` of a JSON value (the cache file).
pub fn sanitize_usage(raw: &Value) -> Option<ProviderUsage> {
    let raw = raw.as_object()?;
    let account_id = raw.get("accountId").and_then(Value::as_str).filter(|a| !a.is_empty() && js::len16(a) <= 80)?;
    let provider = Provider::parse(raw.get("provider").and_then(Value::as_str)?)?;
    let status = Status::parse(raw.get("status").and_then(Value::as_str)?)?;
    let source = Source::parse(raw.get("source").and_then(Value::as_str)?)?;
    let fetched_at = js::finite(raw.get("fetchedAt"))?;
    let mut windows = Vec::new();
    for entry in raw.get("windows").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
        let Some(e) = entry.as_object() else { continue };
        let Some(id) = e.get("id").and_then(Value::as_str).and_then(WindowId::parse) else { continue };
        let Some(used) = js::finite(e.get("usedPercent")) else { continue };
        let Some(resets) = js::finite(e.get("resetsAt")).filter(|r| *r >= 0.0) else { continue };
        windows.push(UsageWindow { id, used_percent: clamp_percent(used), resets_at: resets });
    }
    Some(ProviderUsage {
        account_id: account_id.to_string(),
        provider,
        status,
        plan: text(raw.get("plan"), 120),
        email: text(raw.get("email"), 120),
        org: text(raw.get("org"), 120),
        managed: raw.get("managed").and_then(Value::as_bool),
        windows,
        fetched_at,
        source,
        error: text(raw.get("error"), 64),
        attempt_at: stamp(raw.get("attemptAt")),
        retry_at: stamp(raw.get("retryAt")),
        active: raw.get("active") == Some(&Value::Bool(true)),
        held_by: raw.get("heldBy").and_then(Value::as_str).and_then(HeldBy::parse),
    })
}

/// `sanitizeUsage` of a usage the fetchers built (the same limits on texts, ids and numbers).
pub fn sanitize(usage: &ProviderUsage) -> Option<ProviderUsage> {
    if !usage.fetched_at.is_finite() {
        return None;
    }
    sanitize_usage(&usage.to_value())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn keeps_only_whitelisted_fields_and_valid_windows() {
        let raw = json!({
            "accountId": "claude:main", "provider": "claude", "status": "ok", "source": "live", "fetchedAt": 5,
            "windows": [{ "id": "5h", "usedPercent": 140, "resetsAt": 10 }, { "id": "1d", "usedPercent": 1, "resetsAt": 1 },
                        { "id": "7d", "usedPercent": 1, "resetsAt": -1 }],
            "plan": "x".repeat(130), "token": "secret", "error": "", "attemptAt": -3, "retryAt": 7, "active": "yes",
            "heldBy": "cswap", "managed": false,
        });
        let u = sanitize_usage(&raw).unwrap();
        assert_eq!(u.windows, vec![UsageWindow { id: WindowId::FiveHour, used_percent: 100.0, resets_at: 10.0 }]);
        assert_eq!(u.plan.as_deref().map(str::len), Some(120));
        assert_eq!((u.error.clone(), u.attempt_at, u.retry_at, u.active), (None, None, Some(7.0), false));
        assert_eq!((u.held_by, u.managed), (Some(HeldBy::Cswap), Some(false)));
        assert!(!u.to_value().to_string().contains("secret"));
        assert!(sanitize_usage(&json!({ "accountId": "", "provider": "claude" })).is_none());
        assert!(sanitize_usage(&json!({ "accountId": "a", "provider": "x", "status": "ok", "source": "live", "fetchedAt": 1 })).is_none());
    }
}
