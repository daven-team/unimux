//! `JSON.stringify` compatible output for `serde_json::Value` (with `preserve_order`).
//!
//! The TS code compares values with `JSON.stringify(a) === JSON.stringify(b)` and writes state.json with `JSON.stringify(state)`.
//! A load and save without an edit must give the same bytes, so numbers use ECMAScript's Number::toString (ryu-js: `1` for a
//! whole float, `1e21`, `1.5e-7`) and strings use the JSON.stringify escaping (`\"`, `\\`, `\b \f \n \r \t`, other control
//! characters as lowercase `\u00xx`, nothing else escaped).

use serde_json::{Number, Value};
use std::fmt::Write as _;

/// `JSON.stringify(value)` (compact).
pub fn stringify(value: &Value) -> String {
    let mut out = String::with_capacity(256);
    write_value(&mut out, value, None, 0);
    out
}

/// `JSON.stringify(value, null, indent)` (indent in spaces; 0 means compact).
pub fn stringify_pretty(value: &Value, indent: usize) -> String {
    let mut out = String::with_capacity(256);
    write_value(&mut out, value, if indent == 0 { None } else { Some(indent) }, 0);
    out
}

/// Equality as the TS code decides it: `a === b || JSON.stringify(a) === JSON.stringify(b)`.
pub fn js_equal(a: &Value, b: &Value) -> bool {
    if std::ptr::eq(a, b) {
        return true;
    }
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => number_text(x) == number_text(y),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| js_equal(a, b)),
        // Insertion order matters for JSON.stringify, so the key sequences must match one to one.
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len() && x.iter().zip(y.iter()).all(|((ka, va), (kb, vb))| ka == kb && js_equal(va, vb))
        }
        _ => false,
    }
}

/// ECMAScript Number::toString of a JSON number. NaN and infinities cannot occur in a parsed Value (JSON.stringify writes null).
pub fn number_text(n: &Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        // Above 2^53 JavaScript would already have rounded it; keep the float formatting for parity.
        if u <= (1u64 << 53) {
            return u.to_string();
        }
        return format_f64(u as f64);
    }
    match n.as_f64() {
        Some(f) => format_f64(f),
        None => n.to_string(),
    }
}

fn format_f64(f: f64) -> String {
    if !f.is_finite() {
        return "null".into();
    }
    let mut buf = ryu_js::Buffer::new();
    buf.format(f).to_string()
}

fn write_value(out: &mut String, value: &Value, indent: Option<usize>, depth: usize) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Number(n) => out.push_str(&number_text(n)),
        Value::String(s) => write_string(out, s),
        Value::Array(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return;
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                write_value(out, item, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push(']');
        }
        Value::Object(map) => {
            if map.is_empty() {
                out.push_str("{}");
                return;
            }
            out.push('{');
            for (i, (key, item)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                newline(out, indent, depth + 1);
                write_string(out, key);
                out.push(':');
                if indent.is_some() {
                    out.push(' ');
                }
                write_value(out, item, indent, depth + 1);
            }
            newline(out, indent, depth);
            out.push('}');
        }
    }
}

fn newline(out: &mut String, indent: Option<usize>, depth: usize) {
    if let Some(n) = indent {
        out.push('\n');
        for _ in 0..n * depth {
            out.push(' ');
        }
    }
}

/// JSON.stringify's QuoteJSONString.
pub fn write_string(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn numbers_like_javascript() {
        let v: Value = serde_json::from_str("[1, 1.0, 1.5, -0.25, 1e21, 1e-7, 123456789012, 0.1]").unwrap();
        assert_eq!(stringify(&v), "[1,1,1.5,-0.25,1e+21,1e-7,123456789012,0.1]");
    }

    #[test]
    fn strings_like_javascript() {
        let v = json!({"a": "x\"y\\z\n\t\u{1}\u{1f}é€😀\u{2028}"});
        assert_eq!(stringify(&v), "{\"a\":\"x\\\"y\\\\z\\n\\t\\u0001\\u001fé€😀\u{2028}\"}");
    }

    #[test]
    fn key_order_is_kept() {
        let text = r#"{"z":1,"a":{"y":[],"b":{}},"m":null}"#;
        let v: Value = serde_json::from_str(text).unwrap();
        assert_eq!(stringify(&v), text);
    }

    #[test]
    fn pretty_like_javascript() {
        let v = json!({"a": [1, {"b": true}], "c": {}});
        assert_eq!(stringify_pretty(&v, 2), "{\n  \"a\": [\n    1,\n    {\n      \"b\": true\n    }\n  ],\n  \"c\": {}\n}");
    }

    #[test]
    fn equality_respects_key_order() {
        let a: Value = serde_json::from_str(r#"{"a":1,"b":2}"#).unwrap();
        let b: Value = serde_json::from_str(r#"{"b":2,"a":1}"#).unwrap();
        let c: Value = serde_json::from_str(r#"{"a":1.0,"b":2}"#).unwrap();
        assert!(!js_equal(&a, &b));
        assert!(js_equal(&a, &c));
    }
}
