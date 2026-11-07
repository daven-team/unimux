//! `compareVersions` of src/main/updateCoordinator.ts: numeric comparison of dotted versions, prerelease and build suffixes
//! ignored (`1.2.0-test.1` equals `1.2.0`). Every part is read like JS `Number.parseInt(part, 10) || 0`.

use std::cmp::Ordering;

/// One dotted part as `Number.parseInt(part, 10) || 0`: leading whitespace, an optional sign, then the leading digits; no
/// digits gives 0 (NaN || 0). Large values keep their order (compared as f64, like JS numbers).
fn part(value: &str) -> f64 {
    let text = value.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
    let (negative, rest) = match text.as_bytes().first() {
        Some(b'-') => (true, &text[1..]),
        Some(b'+') => (false, &text[1..]),
        _ => (false, text),
    };
    let digits: &str = &rest[..rest.bytes().take_while(u8::is_ascii_digit).count()];
    if digits.is_empty() {
        return 0.0;
    }
    let n: f64 = digits.parse().unwrap_or(0.0);
    // `-0 || 0` is 0.
    if negative && n != 0.0 { -n } else { n }
}

fn parts(value: &str) -> Vec<f64> {
    let core = value.split(['-', '+']).next().unwrap_or("");
    core.split('.').map(part).collect()
}

/// Negative (Less) when `a` is older than `b`.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let left = parts(a);
    let right = parts(b);
    for i in 0..left.len().max(right.len()) {
        let l = left.get(i).copied().unwrap_or(0.0);
        let r = right.get(i).copied().unwrap_or(0.0);
        match l.partial_cmp(&r) {
            Some(Ordering::Equal) | None => {}
            Some(order) => return order,
        }
    }
    Ordering::Equal
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_like_the_ts_reference() {
        assert_eq!(compare_versions("1.2.0", "1.1.4"), Ordering::Greater);
        assert_eq!(compare_versions("1.2.0-test.1", "1.2.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.10.0", "1.9.9"), Ordering::Greater);
        assert_eq!(compare_versions("1.2", "1.2.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.2.0.1", "1.2.0"), Ordering::Greater);
        assert_eq!(compare_versions("x.2", "0.2"), Ordering::Equal);
        assert_eq!(compare_versions("1a.0", "1.0"), Ordering::Equal);
        assert_eq!(compare_versions("", "0"), Ordering::Equal);
    }
}
