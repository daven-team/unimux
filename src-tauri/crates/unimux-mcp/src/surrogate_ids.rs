//! Request ids with lone UTF-16 surrogates, echoed back unchanged.
//!
//! 1.1.4 reads the body with JSON.parse, which keeps an escaped unpaired surrogate (`"\ud800"`), and its answer echoes
//! the id through JSON.stringify (`"\ud800"` again), so the client can match the answer. A Rust string cannot hold a lone
//! surrogate: [`unimux_core::js_json::parse`] turns it into U+FFFD. To keep ids byte-identical, [`protect`] replaces every
//! string literal with a lone surrogate by a marker string that carries its UTF-16 code units (U+10FFFF, a per-process
//! secret, the units in hex), [`restore`] turns every marker outside the JSON-RPC ids back into the U+FFFD text the rest
//! of the server (tools, tasks, error texts) has always seen, and [`expose`] writes the remaining markers (ids in answers)
//! as JSON.stringify writes the original string.

use std::sync::OnceLock;

use serde_json::Value;

const MARK: char = '\u{10FFFF}';

fn prefix() -> &'static str {
    static PREFIX: OnceLock<String> = OnceLock::new();
    PREFIX.get_or_init(|| format!("{MARK}{}:", crate::server::random_hex::<8>()))
}

/// The UTF-16 code units of a JSON string literal's inside (escapes decoded, lone surrogates kept); None when the
/// literal is not valid JSON (JSON.parse would refuse the body, so it is left alone).
fn units_of(inner: &str) -> Option<Vec<u16>> {
    let mut units = Vec::with_capacity(inner.len());
    let mut chars = inner.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            let unit = match chars.next()? {
                '"' => b'"' as u16,
                '\\' => b'\\' as u16,
                '/' => b'/' as u16,
                'b' => 0x08,
                'f' => 0x0c,
                'n' => b'\n' as u16,
                'r' => b'\r' as u16,
                't' => b'\t' as u16,
                'u' => {
                    let hex: String = chars.by_ref().take(4).collect();
                    if hex.len() != 4 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
                        return None;
                    }
                    u16::from_str_radix(&hex, 16).ok()?
                }
                _ => return None,
            };
            units.push(unit);
        } else if (c as u32) < 0x20 {
            return None;
        } else {
            let mut buf = [0u16; 2];
            units.extend_from_slice(c.encode_utf16(&mut buf));
        }
    }
    Some(units)
}

fn has_lone_surrogate(units: &[u16]) -> bool {
    char::decode_utf16(units.iter().copied()).any(|r| r.is_err())
}

/// The body text with every string literal that holds an escaped lone surrogate replaced by a marker; None when there
/// is none (the common case: one cheap scan).
pub fn protect(text: &str) -> Option<String> {
    unimux_core::js_json::replace_lone_surrogates(text)?;
    let b = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut copied = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i] != b'"' {
            i += 1;
            continue;
        }
        // A string literal: up to the next unescaped quote.
        let start = i;
        let mut j = i + 1;
        while j < b.len() && b[j] != b'"' {
            j += if b[j] == b'\\' { 2 } else { 1 };
        }
        if j >= b.len() {
            break;
        }
        // Quotes and backslashes are ASCII, so these are character boundaries.
        if let Some(units) = units_of(&text[start + 1..j])
            && has_lone_surrogate(&units)
        {
            out.push_str(&text[copied..start]);
            out.push('"');
            out.push_str(prefix());
            for u in &units {
                out.push_str(&format!("{u:04x}"));
            }
            out.push('"');
            copied = j + 1;
        }
        i = j + 1;
    }
    out.push_str(&text[copied..]);
    Some(out)
}

fn units_of_marker(s: &str) -> Option<Vec<u16>> {
    let hex = s.strip_prefix(prefix())?;
    if hex.len() % 4 != 0 {
        return None;
    }
    (0..hex.len()).step_by(4).map(|k| u16::from_str_radix(hex.get(k..k + 4)?, 16).ok()).collect()
}

fn lossy(s: &str) -> Option<String> {
    units_of_marker(s).map(|u| String::from_utf16_lossy(&u))
}

/// Every marker (values and keys) back to the text JSON.parse + a Rust string give: lone surrogates as U+FFFD.
pub fn restore(value: &mut Value) {
    match value {
        Value::String(s) => {
            if let Some(text) = lossy(s) {
                *s = text;
            }
        }
        Value::Array(items) => items.iter_mut().for_each(restore),
        Value::Object(map) => {
            if map.keys().any(|k| k.starts_with(MARK)) {
                let old = std::mem::take(map);
                for (k, mut v) in old {
                    restore(&mut v);
                    map.insert(lossy(&k).unwrap_or(k), v);
                }
            } else {
                map.values_mut().for_each(restore);
            }
        }
        _ => {}
    }
}

/// [`restore`] for one JSON-RPC message, except its `id` and a cancelled notification's `params.requestId`: those keep
/// their marker, so the answer echoes the id unchanged and a cancel finds its request.
pub fn restore_message(m: &mut Value) {
    let Some(obj) = m.as_object_mut() else {
        restore(m);
        return;
    };
    let id = obj.remove("id");
    let request_id = obj.get_mut("params").and_then(Value::as_object_mut).and_then(|p| p.remove("requestId"));
    restore(m);
    let obj = m.as_object_mut().expect("still an object");
    if let Some(r) = request_id
        && let Some(p) = obj.get_mut("params").and_then(Value::as_object_mut)
    {
        p.insert("requestId".into(), r);
    }
    if let Some(id) = id {
        // Back in its place: the SDK's answers do not depend on it, but the key order of the message stays as sent.
        obj.insert("id".into(), id);
    }
}

/// JSON text with every quoted marker written as JSON.stringify writes the original string (lone surrogates as
/// lowercase `\udxxx`).
pub fn expose(text: String) -> String {
    if !text.contains(MARK) {
        return text;
    }
    let needle = format!("\"{}", prefix());
    let mut out = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while let Some(at) = rest.find(&needle) {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let Some(end) = after.find('"') else { break };
        match units_of_marker(&after[..end]) {
            Some(units) => {
                out.push('"');
                for r in char::decode_utf16(units) {
                    match r {
                        Ok(c) => {
                            let mut one = String::new();
                            unimux_core::js_json::write_string(&mut one, c.encode_utf8(&mut [0; 4]));
                            out.push_str(&one[1..one.len() - 1]);
                        }
                        Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
                    }
                }
                out.push('"');
            }
            None => out.push_str(&rest[at..at + 1 + end + 1]),
        }
        rest = &after[end + 1..];
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_with_lone_surrogates_round_trip() {
        let body = r#"{"jsonrpc":"2.0","id":"a\uD800b\"","method":"ping","params":{"x":"\udc00","y":"😀"}}"#;
        let text = protect(body).expect("has a lone surrogate");
        let mut m = unimux_core::js_json::parse(&text).unwrap();
        restore_message(&mut m);
        assert_eq!(m["params"]["x"], "\u{fffd}");
        assert_eq!(m["params"]["y"], "\u{1f600}");
        let out = expose(unimux_core::js_json::stringify(&serde_json::json!({ "id": m["id"] })));
        assert_eq!(out, r#"{"id":"a\ud800b\""}"#);
        assert_eq!(protect(r#"{"id":"😀"}"#), None);
        assert_eq!(expose("{\"id\":\"plain\"}".into()), "{\"id\":\"plain\"}");
    }

    #[test]
    fn keys_and_bad_literals() {
        let text = protect(r#"{"\ud800k":1,"bad":"\ud800\q"}"#).unwrap();
        // The invalid literal is left as it was, so the parse still fails as JSON.parse does.
        assert!(text.contains(r"\ud800\q"));
        let mut v = unimux_core::js_json::parse(&protect(r#"{"\ud800k":1}"#).unwrap()).unwrap();
        restore(&mut v);
        assert_eq!(v, serde_json::json!({ "\u{fffd}k": 1 }));
    }
}
