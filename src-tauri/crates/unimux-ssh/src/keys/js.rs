//! The JavaScript and Node rules 1.1.4's key code relies on: `String.prototype.trim`, `/^.../m` line starts,
//! `Buffer.from(text, 'base64' | 'hex')` and the `metaOf` comment rule.

/// The JS `String.prototype.trim` set: WhiteSpace (including U+FEFF and every Zs) and LineTerminator. Not U+0085, which
/// Rust's `trim` would strip.
pub fn js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// Lines in the sense of a JS `/^.../m` regex (LineTerminator: LF, CR, U+2028, U+2029).
pub fn js_lines(text: &str) -> impl Iterator<Item = &str> {
    text.split(['\n', '\r', '\u{2028}', '\u{2029}'])
}

/// The JS `length` of a string (UTF-16 code units).
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// A JS LineTerminator.
pub fn is_line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// JS `\b` after a match: the next character is not an ASCII word character.
pub fn word_end(rest: &str) -> bool {
    !rest.starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_')
}

/// `Buffer.from(text, 'base64')` (Node 22+ and Electron 45): the standard and the URL alphabet, other characters skipped,
/// decoding stops at the first `=`, leftover bits are dropped and a single leftover character is ignored.
pub fn node_base64(text: &str) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut n = 0;
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
        acc = acc << 6 | u32::from(v);
        n += 1;
        if n == 4 {
            out.extend_from_slice(&[(acc >> 16) as u8, (acc >> 8) as u8, acc as u8]);
            acc = 0;
            n = 0;
        }
    }
    match n {
        2 => out.push((acc >> 4) as u8),
        3 => out.extend_from_slice(&[(acc >> 10) as u8, (acc >> 2) as u8]),
        _ => {}
    }
    out
}

/// `Buffer.from(text, 'hex')`: pairs of hex digits until the first pair that is not one; an odd last digit is dropped.
/// Works on the UTF-8 bytes: a non-ASCII character stops it at the same pair as the UTF-16 units do in Node.
pub fn node_hex(text: &str) -> Vec<u8> {
    let digit = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in text.as_bytes().as_chunks::<2>().0 {
        match (digit(pair[0]), digit(pair[1])) {
            (Some(h), Some(l)) => out.push(h << 4 | l),
            _ => break,
        }
    }
    out
}

/// The 1.1.4 comment rule (metaOf): `.replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 200)`, with 200 UTF-16 code units.
/// When the cut splits a surrogate pair, JS keeps the lone high surrogate; a Rust string cannot hold one, so it becomes
/// U+FFFD (the rule of `unimux_core::js_json::parse`, which reads 1.1.4's JSON the same way).
pub fn clean_comment(c: &str) -> String {
    let s: String = c.chars().map(|ch| if (ch as u32) < 0x20 { ' ' } else { ch }).collect();
    let mut out = String::new();
    let mut units = 0;
    for ch in js_trim(&s).chars() {
        let n = ch.len_utf16();
        if units + n > 200 {
            if units < 200 {
                out.push('\u{fffd}');
            }
            break;
        }
        units += n;
        out.push(ch);
    }
    out
}

/// A JS-flavoured regex source made fit for the `regex` crate: `.` is any character but a JS LineTerminator, `\s` / `\S`
/// are the JS whitespace set (with U+FEFF, without U+0085), `\d` / `\D` are ASCII digits only (the regex crate's `\d`
/// is every Unicode decimal digit). Only used on the fixed ssh2 patterns of this crate.
pub fn js_regex(source: &str) -> regex::Regex {
    const SPACE: &str = r"\t\n\x0B\x0C\r \u{A0}\u{1680}\u{2000}-\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}";
    let mut out = String::new();
    let mut chars = source.chars().peekable();
    let mut in_class = false;
    while let Some(c) = chars.next() {
        // `[\s\S]` (any character, line terminators included) is the one class with `\S` inside the ported patterns.
        if c == '[' && !in_class && chars.clone().take(5).eq(r"\s\S]".chars()) {
            chars.nth(4);
            out.push_str("(?s:.)");
            continue;
        }
        if c == '[' && !in_class && chars.clone().take(3).eq(r"\S]".chars()) {
            chars.nth(2);
            out.push_str(&format!("[^{SPACE}]"));
            continue;
        }
        match c {
            '\\' => {
                let next = chars.next().unwrap_or('\\');
                match (next, in_class) {
                    ('s', false) => out.push_str(&format!("[{SPACE}]")),
                    ('S', false) => out.push_str(&format!("[^{SPACE}]")),
                    ('s', true) => out.push_str(SPACE),
                    ('S', true) => panic!("\\S inside a class is not used by the ported patterns"),
                    ('d', false) => out.push_str("[0-9]"),
                    ('D', false) => out.push_str("[^0-9]"),
                    ('d', true) => out.push_str("0-9"),
                    ('D', true) => panic!("\\D inside a class is not used by the ported patterns"),
                    _ => {
                        out.push('\\');
                        out.push(next);
                    }
                }
            }
            '[' if !in_class => {
                in_class = true;
                out.push(c);
            }
            ']' if in_class => {
                in_class = false;
                out.push(c);
            }
            '.' if !in_class => out.push_str(r"[^\n\r\u{2028}\u{2029}]"),
            _ => out.push(c),
        }
    }
    regex::Regex::new(&out).expect("ported ssh2 pattern")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_reads_like_node() {
        // Checked against Electron 45 (`Buffer.from(s, 'base64')`).
        let hex = |b: Vec<u8>| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
        for (input, want) in [
            ("QQ==QQ==", "41"),
            ("QUJD*RA", "41424344"),
            ("QUJ-_D", "41427efc"),
            ("QQ=QQ", "41"),
            ("QUJDR", "414243"),
            ("QUJDRA=", "41424344"),
            ("QUJDRB", "41424344"),
            ("Q=", ""),
            ("QUI=x", "4142"),
            ("=QUJD", ""),
            ("QU JD\nRA\r\n", "41424344"),
            ("QQ", "41"),
            ("QR==", "41"),
        ] {
            assert_eq!(hex(node_base64(input)), want, "{input:?}");
        }
    }

    #[test]
    fn hex_stops_at_the_first_bad_pair() {
        assert_eq!(node_hex("0aFFg1"), vec![0x0a, 0xff]);
        assert_eq!(node_hex("0a1"), vec![0x0a]);
        assert_eq!(node_hex("0\u{e9}11"), Vec::<u8>::new());
    }

    #[test]
    fn comments_follow_the_js_utf16_rules() {
        let emoji = "\u{1F600}";
        assert_eq!(clean_comment(&emoji.repeat(150)), emoji.repeat(100));
        assert_eq!(clean_comment(&format!("x{}", emoji.repeat(150))), format!("x{}\u{fffd}", emoji.repeat(99)));
        assert_eq!(clean_comment("\u{feff}\u{85} a \u{85}\u{3000}\u{feff}"), "\u{85} a \u{85}");
        assert_eq!(clean_comment("\tsp7\u{2028}ctrl\u{1}x\u{2029}"), "sp7\u{2028}ctrl x");
        assert_eq!(clean_comment(&"a".repeat(300)).len(), 200);
    }

    #[test]
    fn js_regex_translates_dot_and_space() {
        let r = js_regex(r"^a.b\s+c[\s,]$");
        assert!(r.is_match("a-b\u{feff}c,"));
        assert!(!r.is_match("a\rb c,"));
        assert!(!r.is_match("a-b\u{85}c,"));
        let any = js_regex(r"^x([\s\S]+)y$");
        assert_eq!(&any.captures("x\r\n\u{2028}y").unwrap()[1], "\r\n\u{2028}");
    }

    #[test]
    fn js_regex_digits_are_ascii_only() {
        let r = js_regex(r"^Lines: \d+$");
        assert!(r.is_match("Lines: 06"));
        // U+0666 (Arabic-Indic six) and U+FF16 (fullwidth six) are Unicode digits, not JS `\d`.
        assert!(!r.is_match("Lines: \u{666}"));
        assert!(!r.is_match("Lines: \u{ff16}"));
        let not = js_regex(r"^\D[\d,]$");
        assert!(not.is_match("\u{666}7"));
        assert!(not.is_match("x,"));
        assert!(!not.is_match("1,"));
        assert!(!not.is_match("x\u{666}"));
    }

    #[test]
    fn utf16_length_counts_code_units() {
        assert_eq!(utf16_len("a\u{1F600}"), 3);
    }
}
