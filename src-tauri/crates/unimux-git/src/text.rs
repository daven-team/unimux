//! The two text helpers of src/shared/git.ts the runner needs for its error messages: `redactSecrets` and `trimGitText`
//! (the rest of shared/git.ts is G2). JavaScript semantics are kept: `\s` / `trim()` use the ECMAScript white space set (not
//! Unicode White_Space: U+FEFF is in, U+0085 is out), `/i` folds ASCII letters only (non-unicode regexes), `\b` is the ASCII
//! word boundary, and lengths and cuts count UTF-16 units. Checked against test/golden/git-text.jsonl.

use std::sync::LazyLock;

use regex::Regex;

/// ECMAScript `\s` (WhiteSpace + LineTerminator) as a regex class body.
pub(crate) const JS_SPACE: &str =
    r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// Is `c` in ECMAScript's `\s` (what String.prototype.trim removes)?
pub fn is_js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0B}' | '\u{0C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// `String.prototype.trim`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// An ASCII word matched case-insensitively the way a non-unicode JS `/i` regex does (ASCII letters only).
fn ascii_ci(word: &str) -> String {
    word.chars()
        .map(|c| {
            if c.is_ascii_alphabetic() {
                format!("[{}{}]", c.to_ascii_lowercase(), c.to_ascii_uppercase())
            } else {
                c.to_string()
            }
        })
        .collect()
}

static URL_USER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"([a-zA-Z][a-zA-Z0-9+.\-]*://)[^{JS_SPACE}/@]+@")).expect("url regex"));
static AUTH_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"({}:[{JS_SPACE}]*(?:{}|{}|{})[{JS_SPACE}]+)[^{JS_SPACE}]+",
        ascii_ci("authorization"),
        ascii_ci("basic"),
        ascii_ci("bearer"),
        ascii_ci("token")
    ))
    .expect("auth regex")
});
static TOKENS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_\-]{16,})(?-u:\b)")
        .expect("token regex")
});
static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").expect("ansi regex"));
static BLANK_RUNS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").expect("blank regex"));

/// `redactSecrets`: credentials in URLs, Authorization headers and GitHub / GitLab tokens become `***`.
pub fn redact_secrets(value: &str) -> String {
    let a = URL_USER.replace_all(value, "${1}***@");
    let b = AUTH_HEADER.replace_all(&a, "${1}***");
    TOKENS.replace_all(&b, "***").into_owned()
}

fn starts_with_hint(line: &str) -> bool {
    line.len() >= 5 && line.as_bytes()[..5].eq_ignore_ascii_case(b"hint:")
}

/// `trimGitText(value, max = 600)`: what the user sees of git's output. No credentials, no ANSI, no `hint:` lines (unless they
/// are all there is), collapsed blank lines, the tail when it is long (`…` + the last `max` UTF-16 units, trimmed at the start).
pub fn trim_git_text(value: &str, max: usize) -> String {
    let redacted = redact_secrets(value);
    let clean = ANSI.replace_all(&redacted, "").replace('\r', "");
    let without_hints: Vec<&str> = clean.split('\n').filter(|line| !starts_with_hint(line)).collect();
    let without_hints = without_hints.join("\n");
    let chosen = if js_trim(&without_hints).is_empty() { &clean } else { &without_hints };
    let collapsed = BLANK_RUNS.replace_all(chosen, "\n\n");
    let text = js_trim(&collapsed);
    let units: Vec<u16> = text.encode_utf16().collect();
    if units.len() > max {
        let tail = String::from_utf16_lossy(&units[units.len() - max..]);
        format!("…{}", tail.trim_start_matches(is_js_space))
    } else {
        text.to_string()
    }
}

/// `trimGitText(value)` with the default 600.
pub fn trim_git_text_default(value: &str) -> String {
    trim_git_text(value, 600)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_urls_headers_and_tokens() {
        assert_eq!(redact_secrets("fatal: https://user:s3cr3t@host/x.git"), "fatal: https://***@host/x.git");
        assert_eq!(redact_secrets("Authorization: Bearer abc.def"), "Authorization: Bearer ***");
        assert_eq!(redact_secrets("AUTHORIZATION:basic   Zm9v"), "AUTHORIZATION:basic   ***");
        assert_eq!(redact_secrets("x ghp_0123456789abcdefghijABCD y"), "x *** y");
        // the ASCII word boundary of a non-unicode JS regex: a Polish letter is not a word character
        assert_eq!(redact_secrets("żghp_0123456789abcdefghijABCD"), "ż***");
        assert_eq!(redact_secrets("aghp_0123456789abcdefghijABCD"), "aghp_0123456789abcdefghijABCD");
    }

    #[test]
    fn trims_like_the_reference() {
        assert_eq!(trim_git_text_default("hint: a\nhint: b"), "hint: a\nhint: b");
        assert_eq!(trim_git_text_default("error: x\r\nhint: y\n\n\n\nfatal: z\n"), "error: x\n\nfatal: z");
        assert_eq!(trim_git_text_default("\x1b[31mred\x1b[0m"), "red");
        let long = format!("{}end", "a".repeat(700));
        let out = trim_git_text_default(&long);
        assert!(out.starts_with('…'));
        assert_eq!(out.encode_utf16().count(), 601);
    }
}
