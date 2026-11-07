//! The JavaScript semantics the ports of src/shared/git.ts and gitTrust.ts depend on (G2): numbers that print like JS numbers,
//! `Number(text)`, the default `Array.prototype.sort` order of strings (UTF-16 code units), `s[0]` / `s.slice()` in UTF-16
//! units, and the line terminators JS's `.` does not match.

use serde::{Serialize, Serializer};
use unimux_core::utf16;

/// What JS's `.` does not match (without the `s` flag): LF, CR, U+2028, U+2029. As a regex class body.
pub const JS_LINE_TERMINATORS: &str = r"\n\r\x{2028}\x{2029}";

/// A JS number in a result: a whole value prints without `.0` (also through serde_json), NaN and the infinities as null
/// (what JSON.stringify writes).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct JsNum(pub f64);

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

impl Serialize for JsNum {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let n = self.0;
        if !n.is_finite() {
            s.serialize_unit()
        } else if n.fract() == 0.0 && n.abs() <= MAX_SAFE_INTEGER {
            s.serialize_i64(n as i64)
        } else {
            s.serialize_f64(n)
        }
    }
}

impl From<f64> for JsNum {
    fn from(n: f64) -> Self {
        Self(n)
    }
}

impl From<u32> for JsNum {
    fn from(n: u32) -> Self {
        Self(f64::from(n))
    }
}

/// `Number(text)` (StringToNumber): JS white space trimmed, "" is 0, decimal with an optional exponent, 0x / 0o / 0b
/// integers, Infinity; anything else NaN.
pub fn js_number(text: &str) -> f64 {
    let t = utf16::js_trim(text);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |digits: &str, r: u32| -> f64 {
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(r)) {
            return f64::NAN;
        }
        digits.chars().fold(0.0, |acc, c| acc * f64::from(r) + f64::from(c.to_digit(r).unwrap_or(0)))
    };
    let prefix = t.get(..2).map(str::to_ascii_lowercase);
    match prefix.as_deref() {
        Some("0x") => return radix(&t[2..], 16),
        Some("0o") => return radix(&t[2..], 8),
        Some("0b") => return radix(&t[2..], 2),
        _ => {}
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if decimal_literal(t) { t.parse().unwrap_or(f64::NAN) } else { f64::NAN }
}

/// StrDecimalLiteral without Infinity: `[+-]? (digits [. digits?] | . digits) ([eE] [+-]? digits)?`.
fn decimal_literal(t: &str) -> bool {
    let b = t.as_bytes();
    let mut i = 0;
    if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
        i += 1;
    }
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - start;
    }
    if int_digits == 0 && frac_digits == 0 {
        return false;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == b.len()
}

/// `a < b` the way JS's default sort compares strings: by UTF-16 code units (U+FFFF sorts after an emoji).
pub fn js_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `list.sort()` of an array of strings.
pub fn js_sort(list: &mut [String]) {
    list.sort_by(|a, b| js_cmp(a, b));
}

/// `s[0]` as a string (one UTF-16 unit; half of a pair becomes U+FFFD), None for "" (JS undefined).
pub fn first_unit(s: &str) -> Option<String> {
    let c = s.chars().next()?;
    Some(if c.len_utf16() == 1 { c.to_string() } else { '\u{FFFD}'.to_string() })
}

/// `s[i]` as a string (one UTF-16 unit), None past the end.
pub fn unit_at(s: &str, i: usize) -> Option<String> {
    let units = utf16::units(s);
    units.get(i).map(|u| utf16::text(std::slice::from_ref(u)))
}

/// `s.slice(start)` in UTF-16 units.
pub fn slice_from(s: &str, start: usize) -> String {
    if s.is_ascii() {
        return s.get(start..).unwrap_or("").to_string();
    }
    utf16::slice(s, start, usize::MAX)
}

/// `s.slice(start, end)` in UTF-16 units.
pub fn slice(s: &str, start: usize, end: usize) -> String {
    if s.is_ascii() {
        let end = end.min(s.len());
        return s.get(start.min(end)..end).unwrap_or("").to_string();
    }
    utf16::slice(s, start, end)
}

/// `s.length`.
pub fn len(s: &str) -> usize {
    utf16::len(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_like_js() {
        assert_eq!(js_number(" 12 "), 12.0);
        assert_eq!(js_number(""), 0.0);
        assert_eq!(js_number("0x1F"), 31.0);
        assert_eq!(js_number("1e3"), 1000.0);
        assert_eq!(js_number(".5"), 0.5);
        assert_eq!(js_number("5."), 5.0);
        assert!(js_number("1_000").is_nan());
        assert!(js_number("inf").is_nan());
        assert!(js_number("-0x5").is_nan());
        assert_eq!(js_number("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(serde_json::to_string(&JsNum(2.0)).unwrap(), "2");
        assert_eq!(serde_json::to_string(&JsNum(-0.0)).unwrap(), "0");
        assert_eq!(serde_json::to_string(&JsNum(f64::NAN)).unwrap(), "null");
        assert_eq!(serde_json::to_string(&JsNum(1.5)).unwrap(), "1.5");
    }

    #[test]
    fn sorts_by_utf16_units() {
        let mut v = vec!["\u{FFFF}".to_string(), "😀".to_string(), "b".into(), "B".into(), "a".into()];
        js_sort(&mut v);
        assert_eq!(v, ["B", "a", "b", "😀", "\u{FFFF}"]);
    }

    #[test]
    fn slices_in_utf16_units() {
        assert_eq!(slice_from("?é", 2), "");
        assert_eq!(slice("😀abc", 2, 4), "ab");
        assert_eq!(first_unit("😀").as_deref(), Some("\u{FFFD}"));
        assert_eq!(first_unit(""), None);
        assert_eq!(unit_at("ab", 1).as_deref(), Some("b"));
        assert_eq!(unit_at("ab", 2), None);
    }
}
