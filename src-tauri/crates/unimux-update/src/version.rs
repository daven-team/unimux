//! `compareVersions` of src/main/updateCoordinator.ts: numeric comparison of dotted versions, prerelease and build suffixes
//! ignored (`1.2.0-test.1` equals `1.2.0`, like 1.1.4).

use std::cmp::Ordering;

/// `Number.parseInt(part, 10) || 0`: the leading digits of the part (after whitespace and an optional sign), else 0.
fn part(value: &str) -> f64 {
    let s = value.trim_start();
    let (sign, rest) = match s.as_bytes().first() {
        Some(b'-') => (-1.0, &s[1..]),
        Some(b'+') => (1.0, &s[1..]),
        _ => (1.0, s),
    };
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        return 0.0;
    }
    let n: f64 = digits.parse().unwrap_or(0.0);
    if n == 0.0 { 0.0 } else { sign * n }
}

fn parts(value: &str) -> Vec<f64> {
    let core = value.split(['-', '+']).next().unwrap_or("");
    core.split('.').map(part).collect()
}

/// Negative when `a` is older than `b`, 0 when equal, positive when newer.
pub fn compare_versions(a: &str, b: &str) -> Ordering {
    let (left, right) = (parts(a), parts(b));
    for i in 0..left.len().max(right.len()) {
        let diff = left.get(i).copied().unwrap_or(0.0) - right.get(i).copied().unwrap_or(0.0);
        if diff != 0.0 {
            return if diff < 0.0 { Ordering::Less } else { Ordering::Greater };
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
