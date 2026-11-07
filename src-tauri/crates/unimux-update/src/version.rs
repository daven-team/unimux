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

/// `compareVersions(a, b) > 0`.
pub fn is_newer(a: &str, b: &str) -> bool {
    compare_versions(a, b) == Ordering::Greater
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

    /// update-coordinator.test.ts "compares versions numerically" and startup-gate.test.ts "compares dotted versions
    /// numerically".
    #[test]
    fn compares_dotted_versions_numerically() {
        assert_eq!(compare_versions("0.6.10", "0.6.9"), Ordering::Greater);
        assert_eq!(compare_versions("0.6.6", "0.6.5"), Ordering::Greater);
        assert_eq!(compare_versions("0.5.9", "0.5.10"), Ordering::Less);
        assert_eq!(compare_versions("1.0.0", "0.9.9"), Ordering::Greater);
        assert_eq!(compare_versions("0.6", "0.6.0"), Ordering::Equal);
        assert_eq!(compare_versions("0.6.0-beta.1", "0.6.0"), Ordering::Equal);
        assert_eq!(compare_versions("1.2.1-test.1", "1.2.0"), Ordering::Greater);
        assert_eq!(compare_versions("1.2.0+build.7", "1.2.0"), Ordering::Equal);
        // parseInt semantics: leading digits count, anything else is 0.
        assert_eq!(compare_versions("1.2x.0", "1.2.0"), Ordering::Equal);
        assert_eq!(compare_versions("v1.0.0", "0.0.1"), Ordering::Less);
        assert_eq!(compare_versions("", "0"), Ordering::Equal);
    }
}
