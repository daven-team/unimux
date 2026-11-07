//! `Retry-After` of the token endpoint and the usage endpoints (port of src/main/usage/retryAfter.ts; A3, reused by A5).

use std::time::{Duration, UNIX_EPOCH};

/// A server asking for more than this is waited out in steps of it; manual refreshes still go through.
pub const MAX_RETRY_AFTER_MS: f64 = 60.0 * 60_000.0;

/// `/^\d+(\.\d+)?$/` (ASCII digits, like JS `\d`).
fn is_seconds(text: &str) -> bool {
    let (int, frac) = match text.split_once('.') {
        Some((i, f)) => (i, Some(f)),
        None => (text, None),
    };
    !int.is_empty()
        && int.bytes().all(|b| b.is_ascii_digit())
        && frac.is_none_or(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit()))
}

/// JS `String.prototype.trim` for the header value.
fn trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `parseRetryAfter`: `Retry-After` as milliseconds (seconds or an HTTP date), capped; `None` when absent or unusable. A
/// positive wait shorter than a second is rounded up to one second (a 0 would mean "retry at once" in a loop).
pub fn parse_retry_after(value: Option<&str>, now_ms: f64) -> Option<f64> {
    let text = trim(value?);
    if text.is_empty() {
        return None;
    }
    let ms = if is_seconds(text) {
        text.parse::<f64>().ok()? * 1000.0
    } else {
        let at = httpdate::parse_http_date(text).ok()?;
        let at = match at.duration_since(UNIX_EPOCH) {
            Ok(d) => d.as_millis() as f64,
            Err(e) => -(e.duration().as_millis() as f64),
        };
        at - now_ms
    };
    // Math.round: halves go up.
    (ms.is_finite() && ms > 0.0).then(|| MAX_RETRY_AFTER_MS.min(1000f64.max((ms + 0.5).floor())))
}

/// [`parse_retry_after`] as a [`Duration`].
pub fn retry_after_duration(value: Option<&str>, now_ms: f64) -> Option<Duration> {
    parse_retry_after(value, now_ms).map(|ms| Duration::from_millis(ms as u64))
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 1_792_152_000_000.0; // 2026-10-16T12:00:00Z

    #[test]
    fn seconds_dates_and_garbage_like_1_1_4() {
        assert_eq!(parse_retry_after(None, NOW), None);
        assert_eq!(parse_retry_after(Some("  "), NOW), None);
        assert_eq!(parse_retry_after(Some("120"), NOW), Some(120_000.0));
        assert_eq!(parse_retry_after(Some(" 1.5 "), NOW), Some(1_500.0));
        // Shorter than a second: one second; zero: unusable.
        assert_eq!(parse_retry_after(Some("0.2"), NOW), Some(1_000.0));
        assert_eq!(parse_retry_after(Some("0"), NOW), None);
        // Capped at an hour.
        assert_eq!(parse_retry_after(Some("999999"), NOW), Some(MAX_RETRY_AFTER_MS));
        assert_eq!(parse_retry_after(Some("-5"), NOW), None);
        assert_eq!(parse_retry_after(Some("1."), NOW), None);
        assert_eq!(parse_retry_after(Some("soon"), NOW), None);
        // An HTTP date 90 s ahead, and one in the past.
        assert_eq!(parse_retry_after(Some("Fri, 16 Oct 2026 12:01:30 GMT"), NOW), Some(90_000.0));
        assert_eq!(parse_retry_after(Some("Fri, 16 Oct 2026 11:00:00 GMT"), NOW), None);
    }
}
