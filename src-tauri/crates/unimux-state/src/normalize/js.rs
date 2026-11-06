//! The JavaScript semantics the normalizers of 1.1.4 rely on, for `serde_json::Value`: property reads (`undefined` is
//! `None`), `typeof`, truthiness, strict equality, `ToString` / `ToNumber`, UTF-16 lengths and `slice`, `trim` with the JS
//! white space set, `Math.round`, and the names every plain object inherits from `Object.prototype` (a lookup like
//! `RETIRED_PROFILES[id]` finds them). [`Throw`] marks a place where the TS code would throw a TypeError (reading a property
//! of null, `in` on a primitive, iterating a number): normalizeState is caught by loadState then and the file counts as corrupt.

use serde_json::{Map, Number, Value};

/// The TS code would throw here (a TypeError).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Throw;

pub type Js<T> = Result<T, Throw>;

/// `isRecord(v)`: a non-null object that is not an array.
pub fn record(v: Option<&Value>) -> Option<&Map<String, Value>> {
    v.and_then(Value::as_object)
}

/// `!!v && typeof v === 'object'`: an object or an array.
pub fn object_like(v: Option<&Value>) -> bool {
    matches!(v, Some(Value::Object(_) | Value::Array(_)))
}

/// `v.key` for an own data property (arrays and primitives have none of the names the state code reads).
pub fn get<'a>(v: Option<&'a Value>, key: &str) -> Option<&'a Value> {
    v.and_then(Value::as_object).and_then(|o| o.get(key))
}

/// `v.key` where the TS code does not guard against null / undefined.
pub fn get_strict<'a>(v: Option<&'a Value>, key: &str) -> Js<Option<&'a Value>> {
    match v {
        None | Some(Value::Null) => Err(Throw),
        other => Ok(get(other, key)),
    }
}

pub fn string(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// `typeof v === 'number'` (a parsed JSON number is always finite).
pub fn number(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64)
}

/// `Number.isInteger(v)`.
pub fn integer(v: Option<&Value>) -> Option<f64> {
    number(v).filter(|n| n.fract() == 0.0)
}

pub fn is_true(v: Option<&Value>) -> bool {
    v == Some(&Value::Bool(true))
}

pub fn boolean(v: Option<&Value>) -> Option<bool> {
    v.and_then(Value::as_bool)
}

/// JavaScript truthiness (`undefined` is `None`).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// `a === b` (two distinct objects are never equal; the state code only compares primitives).
pub fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(x)), Some(Value::Bool(y))) => x == y,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(Value::String(x)), Some(Value::String(y))) => x == y,
        _ => false,
    }
}

/// A number as JSON.parse would hold it (whole values as integers, so the text stays the same).
pub fn num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 {
        return Value::from(f as i64);
    }
    Number::from_f64(f).map_or(Value::Null, Value::Number)
}

/// `Math.round`: the nearest integer, halves towards +Infinity.
pub fn round(x: f64) -> f64 {
    if !x.is_finite() {
        return x;
    }
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `s.length` (UTF-16 code units).
pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(0, end)` by UTF-16 code units. Half of a surrogate pair at the cut becomes U+FFFD: a Rust string cannot hold the
/// lone surrogate JavaScript keeps, and the state on disk reads it back as U+FFFD anyway (js_json::parse).
pub fn slice16(s: &str, end: usize) -> String {
    let mut out = String::new();
    let mut at = 0;
    for ch in s.chars() {
        let w = ch.len_utf16();
        if at + w > end {
            if at < end {
                out.push('\u{FFFD}');
            }
            break;
        }
        out.push(ch);
        at += w;
    }
    out
}

/// `s.slice(-n)` for a list.
pub fn last_n<T: Clone>(items: &[T], n: usize) -> Vec<T> {
    items[items.len().saturating_sub(n)..].to_vec()
}

/// WhiteSpace and LineTerminator of ECMAScript (what `trim()` and `\s` remove / match).
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// LineTerminator (what `.` in a regular expression does not match).
pub fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

pub fn has_space(s: &str) -> bool {
    s.chars().any(is_space)
}

/// `/[\u0000-\u001f\u007f]/.test(s)`.
pub fn has_control(s: &str) -> bool {
    s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

/// `/^#[0-9a-f]{6}$/i`.
pub fn is_hex_color(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7 && b[0] == b'#' && b[1..].iter().all(u8::is_ascii_hexdigit)
}

/// `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
pub fn is_uuid(v: Option<&Value>) -> bool {
    let Some(s) = string(v) else { return false };
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

/// The properties every plain object inherits from `Object.prototype` (`in` and `obj[key]` find them).
pub const PROTO_KEYS: [&str; 12] = [
    "constructor",
    "__defineGetter__",
    "__defineSetter__",
    "hasOwnProperty",
    "__lookupGetter__",
    "__lookupSetter__",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toString",
    "valueOf",
    "__proto__",
    "toLocaleString",
];

pub fn is_proto_key(key: &str) -> bool {
    PROTO_KEYS.contains(&key)
}

/// `ToString(v)` (also ToPropertyKey). `undefined` is `None`.
pub fn to_string(v: Option<&Value>) -> String {
    match v {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => unimux_core::js_json::number_text(n),
        Some(Value::String(s)) => s.clone(),
        // Array.prototype.join: null and undefined elements are empty.
        Some(Value::Array(items)) => {
            items.iter().map(|x| if x.is_null() { String::new() } else { to_string(Some(x)) }).collect::<Vec<_>>().join(",")
        }
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `ToNumber(v)` (what `now - v` does with it).
pub fn to_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        Some(v @ Value::Array(_)) => string_to_number(&to_string(Some(v))),
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// `Number(text)` (StringToNumber): trimmed; empty is 0; decimal with exponent, Infinity, or 0x / 0o / 0b integers.
pub fn string_to_number(text: &str) -> f64 {
    let t = trim(text);
    if t.is_empty() {
        return 0.0;
    }
    let lower = t.as_bytes();
    if lower.len() > 2 && lower[0] == b'0' {
        let radix = match lower[1] {
            b'x' | b'X' => 16,
            b'o' | b'O' => 8,
            b'b' | b'B' => 2,
            _ => 0,
        };
        if radix != 0 {
            let digits = &t[2..];
            let mut acc = 0f64;
            for c in digits.chars() {
                match c.to_digit(radix) {
                    Some(d) => acc = acc * f64::from(radix) + f64::from(d),
                    None => return f64::NAN,
                }
            }
            return acc;
        }
    }
    let (sign, body) = match t.as_bytes()[0] {
        b'+' => (1.0, &t[1..]),
        b'-' => (-1.0, &t[1..]),
        _ => (1.0, t),
    };
    if body == "Infinity" {
        return sign * f64::INFINITY;
    }
    // StrUnsignedDecimalLiteral: digits [. digits] [e[+-]digits] | . digits [e...]
    let b = body.as_bytes();
    let mut i = 0;
    let int_start = i;
    while i < b.len() && b[i].is_ascii_digit() {
        i += 1;
    }
    let int_digits = i - int_start;
    let mut frac_digits = 0;
    if i < b.len() && b[i] == b'.' {
        i += 1;
        let s = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        frac_digits = i - s;
    }
    if int_digits + frac_digits == 0 {
        return f64::NAN;
    }
    if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
        i += 1;
        if i < b.len() && (b[i] == b'+' || b[i] == b'-') {
            i += 1;
        }
        let s = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i == s {
            return f64::NAN;
        }
    }
    if i != b.len() {
        return f64::NAN;
    }
    body.parse::<f64>().map_or(f64::NAN, |n| sign * n)
}

/// `{...v}` into `out`: own entries of an object, the indexes of an array, the UTF-16 units of a string; nothing for the rest.
pub fn spread_into(out: &mut Map<String, Value>, v: Option<&Value>) {
    match v {
        Some(Value::Object(o)) => {
            for (k, x) in o {
                out.insert(k.clone(), x.clone());
            }
        }
        Some(Value::Array(items)) => {
            for (i, x) in items.iter().enumerate() {
                out.insert(i.to_string(), x.clone());
            }
        }
        Some(Value::String(s)) => {
            let mut i = 0;
            for ch in s.chars() {
                if ch.len_utf16() == 2 {
                    out.insert(i.to_string(), Value::from("\u{FFFD}"));
                    out.insert((i + 1).to_string(), Value::from("\u{FFFD}"));
                    i += 2;
                } else {
                    out.insert(i.to_string(), Value::from(ch.to_string()));
                    i += 1;
                }
            }
        }
        _ => {}
    }
}

/// `v.length` as the TS code reads it: the UTF-16 length of a string, the length of an array, the own `length` property of an
/// object (any JSON value), undefined (`None`) for the rest; null / undefined throw.
pub fn length(v: Option<&Value>) -> Js<Option<Value>> {
    match v {
        None | Some(Value::Null) => Err(Throw),
        Some(Value::Array(a)) => Ok(Some(Value::from(a.len()))),
        Some(Value::String(s)) => Ok(Some(Value::from(len16(s)))),
        Some(Value::Object(o)) => Ok(o.get("length").cloned()),
        Some(_) => Ok(None),
    }
}

/// An object with its keys in JavaScript order (indexes first).
pub fn js_object(mut map: Map<String, Value>) -> Value {
    unimux_core::js_json::order_map_like_js(&mut map);
    Value::Object(map)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn number_conversions_follow_ecmascript() {
        for (text, want) in [
            ("", 0.0),
            ("  12 ", 12.0),
            ("0x1A", 26.0),
            ("0b101", 5.0),
            ("0o17", 15.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("-3e2", -300.0),
        ] {
            assert_eq!(string_to_number(text), want, "{text:?}");
        }
        for text in ["-0x1A", "1_000", "abc", "1e", "Infinityx", "inf", "nan", "0x"] {
            assert!(string_to_number(text).is_nan(), "{text:?}");
        }
        assert_eq!(string_to_number("-Infinity"), f64::NEG_INFINITY);
        assert_eq!(to_number(Some(&json!([5]))), 5.0);
        assert_eq!(to_number(Some(&json!([]))), 0.0);
        assert!(to_number(Some(&json!([1, 2]))).is_nan());
        assert_eq!(to_number(Some(&Value::Null)), 0.0);
        assert!(to_number(None).is_nan());
    }

    #[test]
    fn strings_follow_utf16_and_js_white_space() {
        assert_eq!(len16("a\u{1F600}"), 3);
        assert_eq!(slice16("ab\u{1F600}c", 3), "ab\u{FFFD}");
        assert_eq!(slice16("ab\u{1F600}c", 4), "ab\u{1F600}");
        assert_eq!(trim("\u{feff} x \u{3000}"), "x");
        // U+0085 is white space for Rust but not for JavaScript.
        assert_eq!(trim("\u{85}x"), "\u{85}x");
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(-2.5), -2.0);
        assert_eq!(round(0.49999999999999994), 0.0);
        assert_eq!(to_string(Some(&json!(["claude-opus"]))), "claude-opus");
        assert_eq!(to_string(Some(&json!([1, null, "a"]))), "1,,a");
    }
}
