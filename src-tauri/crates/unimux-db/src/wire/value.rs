//! Cell values for the DB port, byte-compatible with 1.1.4 (`toValue` in src/dbhost/pgSession.ts and mysqlSession.ts).
//!
//! A value is the server's text form. Text bytes are decoded like Node's `Buffer.toString('utf8')` (WHATWG decoder: every
//! maximal invalid subpart becomes one U+FFFD, which is what `String::from_utf8_lossy` does too; checked by the golden in
//! test/golden/db-wire/utf8-decode.jsonl). Binary MySQL columns become `\x` + lowercase hex. A text longer than
//! `CELL_CHARS` UTF-16 code units (JS `s.length`) is cut to that many code units: `{t:'trunc', head, chars}`. The cut can
//! fall between the two halves of a surrogate pair; JS then keeps a lone high surrogate at the end of `head`, which a Rust
//! `String` cannot hold, so `Head::dangling` keeps it and the JSON writer emits it as `\udXXX` (what JSON.stringify writes).

use std::fmt::Write as _;
use unimux_core::js_json::write_string;

/// DB_LIMITS.cellChars (src/shared/db.ts).
pub const CELL_CHARS: usize = 64 * 1024;

/// The start of a cut text: `text` plus, when the cut split a surrogate pair, the lone high surrogate JS keeps after it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Head {
    pub text: String,
    pub dangling: Option<u16>,
}

/// One cell (`DbValue` in src/shared/db.ts).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DbValue {
    Null,
    Text(String),
    /// `chars` is the full length in UTF-16 code units.
    Trunc {
        head: Head,
        chars: usize,
    },
}

/// `Buffer.toString('utf8')`.
pub fn node_utf8(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// `\x` + lowercase hex (Node `buf.toString('hex')`).
pub fn hex_text(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("\\x");
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// JS `s.length`.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// JS `s.slice(0, max)` (max in UTF-16 code units).
pub fn utf16_head(s: &str, max: usize) -> Head {
    let mut units = 0;
    for (at, ch) in s.char_indices() {
        let n = ch.len_utf16();
        if units + n > max {
            let dangling = if units < max {
                // a pair split in the middle: JS keeps the high surrogate
                let mut buf = [0u16; 2];
                ch.encode_utf16(&mut buf);
                Some(buf[0])
            } else {
                None
            };
            return Head { text: s[..at].to_owned(), dangling };
        }
        units += n;
    }
    Head { text: s.to_owned(), dangling: None }
}

/// DB_LIMITS.serverText (src/shared/db.ts): server error texts, notices and warnings are cut to this many UTF-16 units.
pub const SERVER_TEXT_CHARS: usize = 4000;

/// `s.slice(0, DB_LIMITS.serverText)` of pgSession (`cap`, notices), mysqlSession (`mysqlServerError`, warnings) and
/// redisSession (error replies). Like a cell, a cut inside a surrogate pair keeps the lone high surrogate (`write_head`).
pub fn server_text(s: &str) -> Head {
    utf16_head(s, SERVER_TEXT_CHARS)
}

/// `JSON.stringify` of a cut text.
pub fn head_json(head: &Head) -> String {
    let mut s = String::new();
    write_head(&mut s, head);
    s
}

/// `toValue` for a text the session already decoded.
pub fn text_value(s: String, max: usize) -> DbValue {
    let chars = utf16_len(&s);
    if chars > max { DbValue::Trunc { head: utf16_head(&s, max), chars } } else { DbValue::Text(s) }
}

/// `toValue` for the raw bytes of one field: `binary` (MySQL binary columns) gives hex, otherwise the bytes are text.
pub fn to_value(field: Option<&[u8]>, binary: bool) -> DbValue {
    match field {
        None => DbValue::Null,
        Some(b) => text_value(if binary { hex_text(b) } else { node_utf8(b) }, CELL_CHARS),
    }
}

impl DbValue {
    /// `JSON.stringify(value)`.
    pub fn write_json(&self, out: &mut String) {
        match self {
            DbValue::Null => out.push_str("null"),
            DbValue::Text(s) => write_string(out, s),
            DbValue::Trunc { head, chars } => {
                out.push_str("{\"t\":\"trunc\",\"head\":");
                write_head(out, head);
                let _ = write!(out, ",\"chars\":{chars}}}");
            }
        }
    }

    pub fn to_json(&self) -> String {
        let mut s = String::new();
        self.write_json(&mut s);
        s
    }

    /// Characters the 1.1.4 batching counts for this cell (`sendRows`: null 4, text length, truncated head length).
    pub fn batch_chars(&self) -> usize {
        match self {
            DbValue::Null => 4,
            DbValue::Text(s) => utf16_len(s),
            DbValue::Trunc { head, .. } => utf16_len(&head.text) + usize::from(head.dangling.is_some()),
        }
    }
}

/// A cut text as JSON.stringify writes it (a dangling high surrogate as `\udXXX`). Every DB port text that is cut in
/// UTF-16 units (cells, and the DB_LIMITS.serverText cut of server errors and notices) must be written with it.
pub fn write_head(out: &mut String, head: &Head) {
    write_string(out, &head.text);
    if let Some(u) = head.dangling {
        out.pop();
        let _ = write!(out, "\\u{u:04x}\"");
    }
}

/// `JSON.stringify(row)`.
pub fn row_json(row: &[DbValue]) -> String {
    let mut s = String::from("[");
    for (i, v) in row.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        v.write_json(&mut s);
    }
    s.push(']');
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_text_and_hex() {
        assert_eq!(to_value(None, false), DbValue::Null);
        assert_eq!(to_value(Some(b"abc"), false), DbValue::Text("abc".into()));
        assert_eq!(to_value(Some(&[0, 0xab, 0xff]), true), DbValue::Text("\\x00abff".into()));
        assert_eq!(to_value(Some(b""), true), DbValue::Text("\\x".into()));
    }

    #[test]
    fn cuts_in_utf16_units_and_keeps_a_split_high_surrogate() {
        let v = text_value("ab\u{1F600}c".into(), 3);
        assert_eq!(v, DbValue::Trunc { head: Head { text: "ab".into(), dangling: Some(0xd83d) }, chars: 5 });
        assert_eq!(v.to_json(), r#"{"t":"trunc","head":"ab\ud83d","chars":5}"#);
        let v = text_value("ab\u{1F600}c".into(), 4);
        assert_eq!(v.to_json(), "{\"t\":\"trunc\",\"head\":\"ab\u{1F600}\",\"chars\":5}");
        assert_eq!(text_value("ab\u{1F600}".into(), 4), DbValue::Text("ab\u{1F600}".into()));
    }
}
