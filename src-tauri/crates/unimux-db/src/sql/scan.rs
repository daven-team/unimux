//! The small regular-expression pieces of the TS helpers, written out over UTF-16 code units so they answer exactly like V8
//! (non-unicode regexes: `\s` is JS white space, `\w` and `\b` are ASCII, `/i` folds ASCII letters only, `.` and classes
//! see each surrogate half on its own). Every function names the regex it stands for.

pub use unimux_core::utf16::{index_of, is_js_space as is_space, starts_with_at, text, units};

/// `[A-Za-z_\u0080-\uffff]` (IDENT_START of dbSql.ts).
pub fn is_ident_start(c: u16) -> bool {
    c >= 0x80 || c == u16::from(b'_') || is_ascii_letter(c)
}

/// `[A-Za-z0-9_$\u0080-\uffff]` (IDENT_CHAR, MYSQL_WORD).
pub fn is_ident_char(c: u16) -> bool {
    is_ident_start(c) || is_digit(c) || c == u16::from(b'$')
}

/// `\w`.
pub fn is_word(c: u16) -> bool {
    is_ascii_letter(c) || is_digit(c) || c == u16::from(b'_')
}

pub fn is_ascii_letter(c: u16) -> bool {
    matches!(c, 0x41..=0x5a | 0x61..=0x7a)
}

pub fn is_digit(c: u16) -> bool {
    matches!(c, 0x30..=0x39)
}

/// One code unit equals an ASCII byte (`/i`: ASCII letters fold, nothing else does).
fn eq_ci(c: u16, b: u8) -> bool {
    c < 0x80 && (c as u8).eq_ignore_ascii_case(&b)
}

/// The ASCII word `w` at `at`, case-insensitively.
pub fn word_ci_at(u: &[u16], at: usize, w: &str) -> bool {
    at <= u.len() && u.len() - at >= w.len() && w.bytes().enumerate().all(|(k, b)| eq_ci(u[at + k], b))
}

/// Skips `\s*` from `at`.
pub fn skip_spaces(u: &[u16], mut at: usize) -> usize {
    while at < u.len() && is_space(u[at]) {
        at += 1;
    }
    at
}

/// The words of `seq` from `at` with `\s+` between them (each word ASCII, case-insensitive); the end of the match.
fn words_at(u: &[u16], at: usize, seq: &[&str]) -> Option<usize> {
    let mut i = at;
    for (k, w) in seq.iter().enumerate() {
        if k > 0 {
            let j = skip_spaces(u, i);
            if j == i {
                return None;
            }
            i = j;
        }
        if !word_ci_at(u, i, w) {
            return None;
        }
        i += w.len();
    }
    Some(i)
}

/// `/\b(?:A\s+B|C|...)\b/i.test(text)`: any of the word sequences, with a word boundary before it and (when `end_boundary`)
/// after it. Every word must start and end with a `\w` character.
pub fn has_words(u: &[u16], seqs: &[&[&str]], end_boundary: bool) -> bool {
    (0..u.len()).any(|i| {
        (i == 0 || !is_word(u[i - 1]))
            && seqs.iter().any(|seq| words_at(u, i, seq).is_some_and(|end| !end_boundary || end >= u.len() || !is_word(u[end])))
    })
}

/// `/\bWORD\b/i.test(text)` for single words.
pub fn has_any_word(u: &[u16], words: &[&str]) -> bool {
    (0..u.len()).any(|i| {
        (i == 0 || !is_word(u[i - 1]))
            && words.iter().any(|w| word_ci_at(u, i, w) && (i + w.len() >= u.len() || !is_word(u[i + w.len()])))
    })
}

/// `/^[\s(]*A\s+B...\b/i.test(text)` (the start of a statement, opening parentheses skipped).
pub fn starts_with_words(u: &[u16], seqs: &[&[&str]]) -> bool {
    let mut i = 0;
    while i < u.len() && (is_space(u[i]) || u[i] == u16::from(b'(')) {
        i += 1;
    }
    seqs.iter().any(|seq| words_at(u, i, seq).is_some_and(|end| end >= u.len() || !is_word(u[end])))
}

/// `quote (?:[^quote] | quote quote)* quote` (and with `backslash`, `[^quote\\] | \\[\s\S]` as well) starting at `at`, which
/// holds the opening quote: the end of the match, or None when it does not match there. Backtracking makes an unterminated
/// string close at its last doubled quote (V8 gives up the last `''` pair and takes its first quote as the closing one).
pub fn quoted_end(u: &[u16], at: usize, quote: u16, backslash: bool) -> Option<usize> {
    let n = u.len();
    let mut i = at + 1;
    let mut last_pair: Option<usize> = None;
    loop {
        if i >= n {
            return last_pair.map(|p| p + 1);
        }
        let c = u[i];
        if c == quote {
            if i + 1 < n && u[i + 1] == quote {
                last_pair = Some(i);
                i += 2;
                continue;
            }
            return Some(i + 1);
        }
        if backslash && c == u16::from(b'\\') {
            if i + 1 >= n {
                return last_pair.map(|p| p + 1);
            }
            i += 2;
            continue;
        }
        i += 1;
    }
}

/// `-?` ... `\n` search helpers: the index of `\n` at or after `from`.
pub fn newline_from(u: &[u16], from: usize) -> Option<usize> {
    (from.min(u.len())..u.len()).find(|&i| u[i] == u16::from(b'\n'))
}

/// `/\*[\s\S]*?\*\/` from `at` (which holds `/*`): the end after the first `*/`, None when the comment is not closed.
pub fn block_comment_end(u: &[u16], at: usize) -> Option<usize> {
    index_of(u, &units("*/"), at + 2).map(|c| c + 2)
}

/// JS `toUpperCase()` of a word (full Unicode mapping: "ſ" reads "S", "ß" "SS").
pub fn upper(u: &[u16]) -> String {
    text(u).to_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoted_strings_backtrack_like_v8() {
        let u = units("'ab''");
        assert_eq!(quoted_end(&u, 0, u16::from(b'\''), false), Some(4));
        let u = units("'abc");
        assert_eq!(quoted_end(&u, 0, u16::from(b'\''), false), None);
        let u = units(r"'a\'b'");
        assert_eq!(quoted_end(&u, 0, u16::from(b'\''), true), Some(6));
        let u = units(r"'a''\");
        assert_eq!(quoted_end(&u, 0, u16::from(b'\''), true), Some(3));
    }

    #[test]
    fn words_and_boundaries() {
        let u = units("select * from t for  no key\tupdate");
        assert!(has_words(&u, &[&["FOR", "NO", "KEY", "UPDATE"]], true));
        assert!(!has_words(&units("xfor update"), &[&["FOR", "UPDATE"]], true));
        assert!(has_any_word(&units("a.INTO,b"), &["INTO"]));
        assert!(!has_any_word(&units("intox"), &["INTO"]));
        assert!(starts_with_words(&units(" ((set transaction x"), &[&["SET", "TRANSACTION"]]));
        assert!(!has_any_word(&units("ſelect"), &["SELECT"]));
    }
}
