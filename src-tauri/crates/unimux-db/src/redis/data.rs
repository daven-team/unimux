//! The byte helpers of src/dbhost/redisSession.ts (`toData`, `fromData`, `blob`, `cutBytes`, `trimPartialUtf8`, `text`,
//! `int`) and the JS number forms the session's answers and command arguments use.

use serde_json::{Map, Value};

use crate::redis_shared::{RedisData, bytes_to_base64};
use crate::wire::redis::Raw;

/// `toData`: text when the bytes are UTF-8 (Node `isUtf8`; a BOM stays, as `Buffer.toString` keeps it), else base64.
pub fn to_data(b: &[u8]) -> RedisData {
    match std::str::from_utf8(b) {
        Ok(s) => RedisData::Text(s.to_owned()),
        Err(_) => RedisData::B64(bytes_to_base64(b)),
    }
}

/// `toData` as JSON.
pub fn data_json(b: &[u8]) -> Value {
    to_data(b).to_json()
}

/// Node's `Buffer.from(s, 'base64')`: both alphabets (`+/` and `-_`), anything else skipped, the first `=` ends the data, a
/// single leftover character is dropped.
pub fn node_base64(s: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(s.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for c in s.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        buf = (buf << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
            buf &= (1 << bits) - 1;
        }
    }
    out
}

/// `fromData` of the JSON form (`"text"` or `{b64}`); anything else is empty (main validated the shape before).
pub fn from_data(v: &Value) -> Vec<u8> {
    match v {
        Value::String(s) => s.as_bytes().to_vec(),
        Value::Object(o) => o.get("b64").and_then(Value::as_str).map(node_base64).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// `trimPartialUtf8`.
pub fn trim_partial_utf8(b: &[u8]) -> &[u8] {
    crate::wire::redis::trim_partial_utf8(b)
}

/// `cutBytes`.
pub fn cut_bytes(b: &[u8], max: usize) -> &[u8] {
    crate::wire::redis::cut_bytes(b, max)
}

/// `blob(b, max, total)`: `{data, bytes, truncated?: true}`.
pub fn blob_with_total(b: &[u8], max: usize, total: f64) -> Value {
    let part = cut_bytes(b, max);
    let mut m = Map::new();
    m.insert("data".into(), data_json(part));
    m.insert("bytes".into(), num(total));
    if (part.len() as f64) < total {
        m.insert("truncated".into(), Value::Bool(true));
    }
    Value::Object(m)
}

/// `blob(b, max)`.
pub fn blob(b: &[u8], max: usize) -> Value {
    blob_with_total(b, max, b.len() as f64)
}

/// `asBuffer`: a bulk / status reply's bytes, anything else as `String(v ?? '')`.
pub fn as_buffer(v: &Raw) -> Vec<u8> {
    match v {
        Raw::Bytes(b) => b.clone(),
        _ => text(v).into_bytes(),
    }
}

/// `text`: a Buffer decoded as UTF-8, anything else `String(v ?? '')`.
pub fn text(v: &Raw) -> String {
    match v {
        Raw::Bytes(b) => String::from_utf8_lossy(b).into_owned(),
        Raw::Integer(s) => s.clone(),
        Raw::Error(m) => format!("ReplyError: {m}"),
        Raw::Null => String::new(),
        Raw::Array(items) => items.iter().map(text).collect::<Vec<_>>().join(","),
    }
}

/// `int`: `Number(text(v))`.
pub fn int(v: &Raw) -> f64 {
    crate::sql::values::js_to_number(&text(v))
}

/// A JS number as JSON (`JSON.stringify`: integers without a fraction, NaN and the infinities as null).
pub fn num(f: f64) -> Value {
    if !f.is_finite() {
        return Value::Null;
    }
    if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 {
        return Value::from(f as i64);
    }
    serde_json::Number::from_f64(f).map_or(Value::Null, Value::Number)
}

/// `String(n)` of a JS number (a command argument).
pub fn js_num(f: f64) -> String {
    if f.fract() == 0.0 && f.abs() < 1e21 {
        return format!("{}", f as i128);
    }
    let mut b = ryu_js::Buffer::new();
    b.format(f).to_owned()
}

/// `Math.min(Math.max(x, lo), hi)` (NaN stays NaN like JS).
pub fn clamp(x: f64, lo: f64, hi: f64) -> f64 {
    if x.is_nan() {
        return x;
    }
    x.max(lo).min(hi)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_forms() {
        assert_eq!(to_data("\u{feff}a".as_bytes()), RedisData::Text("\u{feff}a".into()));
        assert_eq!(to_data(&[0xff, 0]), RedisData::B64("/wA=".into()));
        assert_eq!(from_data(&serde_json::json!({ "b64": "/wA=" })), vec![0xff, 0]);
        assert_eq!(node_base64("_w-A"), vec![0xff, 0x0f, 0x80]);
        assert_eq!(node_base64("AP8 =ignored"), vec![0, 0xff]);
        assert_eq!(node_base64("QUJD\nRA"), b"ABCD");
        assert_eq!(node_base64("Q"), Vec::<u8>::new());
    }

    #[test]
    fn blobs_and_numbers() {
        assert_eq!(blob("aé".as_bytes(), 2), serde_json::json!({ "data": "a", "bytes": 3, "truncated": true }));
        assert_eq!(blob(b"abc", 10), serde_json::json!({ "data": "abc", "bytes": 3 }));
        assert_eq!(num(3.0), serde_json::json!(3));
        assert_eq!(num(1.5), serde_json::json!(1.5));
        assert_eq!(num(f64::NAN), Value::Null);
        assert_eq!(js_num(10.0), "10");
        assert_eq!(js_num(-1.0), "-1");
        assert_eq!(js_num(1.5), "1.5");
        assert_eq!(int(&Raw::Integer("42".into())), 42.0);
        assert!(int(&Raw::Bytes(b"x".to_vec())).is_nan());
        assert_eq!(int(&Raw::Null), 0.0);
    }
}
