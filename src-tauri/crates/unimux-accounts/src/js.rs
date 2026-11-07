//! The few JavaScript semantics the account files depend on: `trim()` / `\s`, `length` in UTF-16 code units, numbers as
//! JSON.parse holds them, `typeof x === 'object'`, and Node's lenient base64url decoder.

use serde_json::{Map, Number, Value};
use sha2::{Digest, Sha256};

/// WhiteSpace and LineTerminator of ECMAScript (what `trim()` removes and `\s` matches).
pub fn is_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// A LineTerminator (where `^` of a regular expression with the `m` flag matches after).
pub fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `s.trim()`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `s.length` (UTF-16 code units).
pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s?.trim().toLowerCase() || undefined`.
pub fn norm(s: Option<&str>) -> Option<String> {
    let t = trim(s?);
    (!t.is_empty()).then(|| t.to_lowercase())
}

/// A number as JSON.parse would hold it (whole values as integers, so JSON.stringify writes the same text).
pub fn num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 {
        return Value::from(f as i64);
    }
    Number::from_f64(f).map_or(Value::Null, Value::Number)
}

/// `typeof v === 'object' && v !== null && !Array.isArray(v)`.
pub fn record(v: Option<&Value>) -> Option<&Map<String, Value>> {
    match v {
        Some(Value::Object(m)) => Some(m),
        _ => None,
    }
}

/// `typeof v === 'string' ? v : undefined`.
pub fn string(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// `typeof v === 'number' && Number.isFinite(v)` (every JSON number is finite).
pub fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|f| f.is_finite())
}

/// `/^[0-9a-f]{64}$/` (a SHA-256 in lowercase hex).
pub fn is_hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/` (lowercase only, no `i` flag).
pub fn is_lower_uuid(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_digit() || (b'a'..=b'f').contains(c) }
        })
}

/// `createHash('sha256').update(text).digest('hex')`.
pub fn sha256_hex(text: &str) -> String {
    let digest = Sha256::digest(text.as_bytes());
    let mut out = String::with_capacity(64);
    for b in digest.iter() {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// `Buffer.from(text, 'base64url')`: both alphabets, characters outside them skipped, the first `=` ends the data, a lone
/// trailing character dropped (Node's decoder is that lenient).
pub fn base64url_decode(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    for c in text.bytes() {
        let v = match c {
            b'A'..=b'Z' => c - b'A',
            b'a'..=b'z' => c - b'a' + 26,
            b'0'..=b'9' => c - b'0' + 52,
            b'+' | b'-' => 62,
            b'/' | b'_' => 63,
            b'=' => break,
            _ => continue,
        };
        acc = (acc << 6) | u32::from(v);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
            acc &= (1 << bits) - 1;
        }
    }
    out
}

/// `readFileSync(path, 'utf8')`: invalid UTF-8 becomes U+FFFD.
pub fn read_text(path: &std::path::Path) -> std::io::Result<String> {
    let bytes = std::fs::read(path)?;
    Ok(match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64url_like_node() {
        assert_eq!(base64url_decode("eyJhIjoxfQ"), br#"{"a":1}"#);
        assert_eq!(base64url_decode("eyJhIjoxfQ=="), br#"{"a":1}"#);
        // Expected bytes taken from Node 26's Buffer.from(text, 'base64url').
        assert_eq!(base64url_decode("ey Ja\nIjoxfQ"), br#"{"Z":1}"#);
        assert_eq!(base64url_decode("QQ==QUJD"), b"A");
        assert_eq!(base64url_decode("Q"), b"");
        assert_eq!(base64url_decode("QUI*JD"), [0x41, 0x42, 0x09]);
        assert_eq!(base64url_decode("-_-_"), [0xfb, 0xff, 0xbf]);
        assert_eq!(base64url_decode("+/+/"), [0xfb, 0xff, 0xbf]);
        assert_eq!(base64url_decode("QQ=x"), b"A");
        assert_eq!(base64url_decode("QUJDR"), b"ABC");
    }

    #[test]
    fn helpers() {
        assert_eq!(trim("\u{feff} x \u{3000}"), "x");
        assert_eq!(len16("a\u{1F600}"), 3);
        assert_eq!(norm(Some(" A@X ")), Some("a@x".into()));
        assert_eq!(norm(Some("  ")), None);
        assert!(is_lower_uuid("123e4567-e89b-42d3-a456-426614174000"));
        assert!(!is_lower_uuid("123E4567-e89b-42d3-a456-426614174000"));
        assert_eq!(sha256_hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }
}
