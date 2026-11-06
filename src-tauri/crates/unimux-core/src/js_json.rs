//! `JSON.stringify` compatible output for `serde_json::Value` (with `preserve_order`).
//!
//! The TS code compares values with `JSON.stringify(a) === JSON.stringify(b)` and writes state.json with `JSON.stringify(state)`.
//! A load and save without an edit must give the same bytes, so numbers use ECMAScript's Number::toString (ryu-js: `1` for a
//! whole float, `1e21`, `1.5e-7`) and strings use the JSON.stringify escaping (`\"`, `\\`, `\b \f \n \r \t`, other control
//! characters as lowercase `\u00xx`, nothing else escaped).
//!
//! [`parse`] accepts what `JSON.parse` accepts in text JSON.stringify wrote: since ES2019 JSON.stringify writes an unpaired
//! UTF-16 surrogate (half an emoji cut by `.slice()`, text pasted from a broken source) as `\udXXX`, which JSON.parse reads back
//! and serde_json rejects. A Rust string cannot hold a lone surrogate, so it becomes U+FFFD.

use serde_json::{Number, Value};
use std::fmt::Write as _;

/// `JSON.parse(text)`: like `serde_json::from_str`, but an escaped unpaired surrogate (in a value or a key) reads as U+FFFD
/// instead of failing the whole text. Valid pairs stay as they are.
pub fn parse(text: &str) -> serde_json::Result<Value> {
    let mut value: Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(e) => match replace_lone_surrogates(text) {
            Some(fixed) => serde_json::from_str(&fixed)?,
            None => return Err(e),
        },
    };
    order_like_js(&mut value);
    Ok(value)
}

/// An array index as a property key ("0", "17", at most 2^32 - 2, no leading zero): JavaScript objects list these first, in
/// ascending order, before every other key (which keep their insertion order).
pub fn index_key(key: &str) -> Option<u32> {
    let b = key.as_bytes();
    if b.is_empty() || b.len() > 10 || !b.iter().all(u8::is_ascii_digit) || (b.len() > 1 && b[0] == b'0') {
        return None;
    }
    let n: u64 = key.parse().ok()?;
    (n < u64::from(u32::MAX)).then_some(n as u32)
}

/// Puts the keys of every object of `value` in the order a JavaScript object has them (array indexes first, ascending, then
/// the rest in insertion order), as JSON.parse and any object built in JS would. Objects already in that order are not touched.
pub fn order_like_js(value: &mut Value) {
    match value {
        Value::Array(items) => items.iter_mut().for_each(order_like_js),
        Value::Object(map) => {
            for (_, item) in map.iter_mut() {
                order_like_js(item);
            }
            order_map_like_js(map);
        }
        _ => {}
    }
}

/// [`order_like_js`] for one object (not its children).
pub fn order_map_like_js(map: &mut serde_json::Map<String, Value>) {
    let mut last: Option<u32> = None;
    let mut seen_named = false;
    let mut in_order = true;
    for key in map.keys() {
        match index_key(key) {
            Some(n) => {
                if seen_named || last.is_some_and(|l| l > n) {
                    in_order = false;
                    break;
                }
                last = Some(n);
            }
            None => seen_named = true,
        }
    }
    if in_order {
        return;
    }
    let old = std::mem::take(map);
    let mut indexed: Vec<(u32, String, Value)> = Vec::new();
    let mut named: Vec<(String, Value)> = Vec::new();
    for (k, v) in old {
        match index_key(&k) {
            Some(n) => indexed.push((n, k, v)),
            None => named.push((k, v)),
        }
    }
    indexed.sort_by_key(|(n, _, _)| *n);
    for (_, k, v) in indexed {
        map.insert(k, v);
    }
    for (k, v) in named {
        map.insert(k, v);
    }
}

fn hex4(b: &[u8], at: usize) -> Option<u32> {
    let digits = b.get(at..at + 4)?;
    let mut n = 0u32;
    for &d in digits {
        n = n * 16 + (d as char).to_digit(16)?;
    }
    Some(n)
}

/// The text with every `\uD800`-`\uDFFF` escape that is not half of a high + low pair replaced by `\ufffd`; None when there is
/// none. Only escapes are looked at: a raw lone surrogate cannot occur in UTF-8 text.
pub fn replace_lone_surrogates(text: &str) -> Option<String> {
    let b = text.as_bytes();
    let is_high = |u: u32| (0xD800..0xDC00).contains(&u);
    let is_low = |u: u32| (0xDC00..0xE000).contains(&u);
    let mut out: Option<String> = None;
    let mut copied = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'\\' {
            i += 1;
            continue;
        }
        if b.get(i + 1) != Some(&b'u') {
            // `\\`, `\"`, `\n` ...: the escaped character never starts another escape.
            i += 2;
            continue;
        }
        let Some(unit) = hex4(b, i + 2) else {
            i += 2;
            continue;
        };
        if is_high(unit) && b.get(i + 6) == Some(&b'\\') && b.get(i + 7) == Some(&b'u') && hex4(b, i + 8).is_some_and(is_low) {
            i += 12;
            continue;
        }
        if !is_high(unit) && !is_low(unit) {
            i += 6;
            continue;
        }
        // Backslashes are ASCII, so `copied` and `i` are always character boundaries.
        let o = out.get_or_insert_with(|| String::with_capacity(text.len()));
        o.push_str(&text[copied..i]);
        o.push_str("\\ufffd");
        i += 6;
        copied = i;
    }
    let mut o = out?;
    o.push_str(&text[copied..]);
    Some(o)
}

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
    fn lone_surrogates_read_as_replacement_characters() {
        let text = r#"{"a":"Proj \ud83d","\udc00k":["x\ude00y","\ud83d\ude00","\\ud800",1],"b":"\ud800\ud800\udc00"}"#;
        assert!(serde_json::from_str::<Value>(text).is_err());
        let v = parse(text).unwrap();
        assert_eq!(v["a"], "Proj \u{fffd}");
        assert_eq!(v["\u{fffd}k"][0], "x\u{fffd}y");
        assert_eq!(v["\u{fffd}k"][1], "😀");
        assert_eq!(v["\u{fffd}k"][2], "\\ud800");
        assert_eq!(v["b"], "\u{fffd}\u{10000}");
        assert_eq!(replace_lone_surrogates(r#"{"a":"\ud83d\ude00 \\udc00"}"#), None);
        assert!(parse("{not json").is_err());
        assert!(parse(r#"{"a":"\ud83d"#).is_err());
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

    #[test]
    fn parse_orders_index_keys_like_json_parse() {
        // JSON.parse lists 2 and 10 first; "01" and 2^32 - 1 are no array indexes and keep their places.
        let v = parse(r#"{"b":1,"10":2,"a":{"z":0,"3":1},"2":4,"01":5,"4294967295":6}"#).unwrap();
        assert_eq!(stringify(&v), r#"{"2":4,"10":2,"b":1,"a":{"3":1,"z":0},"01":5,"4294967295":6}"#);
        assert_eq!(index_key("4294967294"), Some(4_294_967_294));
        assert_eq!(index_key("4294967295"), None);
        assert_eq!(index_key("-1"), None);
        let plain = r#"{"0":1,"7":2,"x":3}"#;
        assert_eq!(stringify(&parse(plain).unwrap()), plain);
    }
}
