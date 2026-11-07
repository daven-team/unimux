//! The JavaScript value tests 1.1.4's SSH stores make on what `JSON.parse` gave them (`typeof`, `.length`, `Number.isInteger`),
//! over a value read with [`unimux_core::js_json::parse_keeping_infinity`] (a number beyond the f64 range is Infinity there,
//! so `typeof` says number and JSON.stringify writes it back as `null`).

use serde_json::{Number, Value};
use unimux_core::js_json::infinity_of;
use unimux_core::utf16;

/// A value with `typeof v === 'number'`: a finite number as parsed, or an infinity.
#[derive(Debug, Clone, PartialEq)]
pub enum JsNum {
    Finite(Number),
    /// Infinity (`false`) or -Infinity (`true`).
    Infinite(bool),
}

impl JsNum {
    /// `typeof v === 'number' ? v : undefined`.
    pub fn of(v: &Value) -> Option<JsNum> {
        match v {
            Value::Number(n) => Some(JsNum::Finite(n.clone())),
            _ => infinity_of(v).map(|f| JsNum::Infinite(f < 0.0)),
        }
    }

    /// `typeof v === 'number' ? v : 0`.
    pub fn or_zero(v: &Value) -> JsNum {
        Self::of(v).unwrap_or_else(|| JsNum::from(0i64))
    }

    /// The number as a double (what JavaScript holds).
    pub fn as_f64(&self) -> f64 {
        match self {
            JsNum::Finite(n) => n.as_f64().unwrap_or(0.0),
            JsNum::Infinite(false) => f64::INFINITY,
            JsNum::Infinite(true) => f64::NEG_INFINITY,
        }
    }

    /// What JSON.stringify writes: the number, or `null` for an infinity.
    pub fn to_json(&self) -> Value {
        match self {
            JsNum::Finite(n) => Value::Number(n.clone()),
            JsNum::Infinite(_) => Value::Null,
        }
    }
}

impl From<i64> for JsNum {
    fn from(n: i64) -> Self {
        JsNum::Finite(Number::from(n))
    }
}

impl From<u32> for JsNum {
    fn from(n: u32) -> Self {
        JsNum::Finite(Number::from(n))
    }
}

/// `typeof v === 'string' && v.length <= max ? v : undefined` (length in UTF-16 code units; an infinity mark is a number).
pub fn str_max(v: &Value, max: usize) -> Option<&str> {
    let s = v.as_str()?;
    (infinity_of(v).is_none() && utf16::len(s) <= max).then_some(s)
}

/// `typeof v === 'string' ? v : undefined`.
pub fn string(v: &Value) -> Option<&str> {
    let s = v.as_str()?;
    infinity_of(v).is_none().then_some(s)
}

/// `typeof v === 'number' && Number.isInteger(v)`: a finite whole number.
pub fn integer(v: &Value) -> Option<f64> {
    let f = match v {
        Value::Number(n) => n.as_f64()?,
        _ => return None,
    };
    (f.is_finite() && f.fract() == 0.0).then_some(f)
}

/// `typeof v === 'number' && Number.isFinite(v)`.
pub fn finite(v: &Value) -> Option<&Number> {
    match v {
        Value::Number(n) => Some(n),
        _ => None,
    }
}

/// `typeof v === 'object' && v !== null && !Array.isArray(v)`.
pub fn is_object(v: &Value) -> bool {
    v.is_object()
}

/// `!raw || typeof raw !== 'object'` is false: an object or an array.
pub fn is_object_like(v: &Value) -> bool {
    v.is_object() || v.is_array()
}

/// `shared/ssh.ts isUuid`: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
pub fn is_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => *c == b'-',
            _ => c.is_ascii_hexdigit(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use unimux_core::js_json::parse_keeping_infinity;

    #[test]
    fn typeof_rules() {
        let v = parse_keeping_infinity(r#"{"a":1e400,"b":-1e400,"c":"x","d":1.5,"e":3,"f":null,"g":-0}"#).unwrap();
        assert_eq!(JsNum::of(&v["a"]), Some(JsNum::Infinite(false)));
        assert_eq!(JsNum::of(&v["a"]).unwrap().to_json(), Value::Null);
        assert_eq!(JsNum::of(&v["b"]).unwrap().as_f64(), f64::NEG_INFINITY);
        assert_eq!(JsNum::of(&v["c"]), None);
        assert_eq!(JsNum::or_zero(&v["f"]), JsNum::from(0i64));
        assert_eq!(str_max(&v["a"], 100), None);
        assert_eq!(str_max(&v["c"], 1), Some("x"));
        assert_eq!(str_max(&v["c"], 0), None);
        assert_eq!(integer(&v["d"]), None);
        assert_eq!(integer(&v["e"]), Some(3.0));
        assert_eq!(integer(&v["a"]), None);
        assert_eq!(integer(&v["g"]), Some(0.0));
        assert!(finite(&v["a"]).is_none());
        assert_eq!(str_max(&Value::String("\u{1F600}".into()), 1), None, "an emoji is two code units");
    }

    #[test]
    fn uuids() {
        assert!(is_uuid("00000000-0000-4000-8000-00000000000a"));
        assert!(is_uuid("AAAAAAAA-1111-4111-8111-111111111111"));
        assert!(!is_uuid("00000000-0000-4000-8000-00000000000"));
        assert!(!is_uuid("00000000_0000-4000-8000-00000000000a"));
        assert!(!is_uuid("g0000000-0000-4000-8000-00000000000a"));
    }
}
