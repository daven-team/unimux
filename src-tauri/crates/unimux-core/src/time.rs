//! Wall-clock helpers with JavaScript formatting (`Date.prototype.toISOString`), without a date crate.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Milliseconds since the Unix epoch (`Date.now()`).
pub fn now_ms() -> i64 {
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(e) => -(e.duration().as_millis() as i64),
    }
}

/// `new Date(ms).toISOString()`: `YYYY-MM-DDTHH:MM:SS.mmmZ` (years 0..=9999).
pub fn iso_from_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, m, d) = civil_from_days(days);
    let h = rem / 3_600_000;
    let min = (rem / 60_000) % 60;
    let s = (rem / 1000) % 60;
    let milli = rem % 1000;
    format!("{y:04}-{m:02}-{d:02}T{h:02}:{min:02}:{s:02}.{milli:03}Z")
}

/// The current time as `toISOString()`.
pub fn iso_now() -> String {
    iso_from_ms(now_ms())
}

/// A file-name-safe stamp: the ISO time with `:` and `.` replaced by `-` (as the TS code does with `.replace(/[:.]/g, '-')`).
pub fn file_stamp(ms: i64) -> String {
    iso_from_ms(ms).replace([':', '.'], "-")
}

/// Days since 1970-01-01 to (year, month, day) in the proleptic Gregorian calendar (Howard Hinnant's algorithm).
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// `ms.toString(36)` of a non-negative integer (temp file names).
pub fn base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// A duration as whole milliseconds (saturating).
pub fn ms(d: Duration) -> u64 {
    d.as_millis().min(u64::MAX as u128) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn iso_matches_javascript() {
        assert_eq!(iso_from_ms(0), "1970-01-01T00:00:00.000Z");
        // new Date(1762430400123).toISOString()
        assert_eq!(iso_from_ms(1_762_430_400_123), "2025-11-06T12:00:00.123Z");
        assert_eq!(iso_from_ms(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(file_stamp(1_762_430_400_123), "2025-11-06T12-00-00-123Z");
    }

    #[test]
    fn base36_matches_javascript() {
        assert_eq!(base36(0), "0");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        assert_eq!(base36(1_762_430_400_123), "mhndk03f");
    }
}
