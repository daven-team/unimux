//! JavaScript string lengths and offsets. Every limit and position the TS code checks (`s.length`, `s.slice(a, b)`,
//! `s.indexOf(x)`) counts UTF-16 code units, so the Rust ports count the same way: a character outside the BMP (an emoji)
//! is 2, every other character 1.

/// JS `s.length`.
pub fn len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// The UTF-16 code units of a string (what JS indexes).
pub fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// A string from UTF-16 code units; an unpaired surrogate (a JS string cut inside a pair) becomes U+FFFD, the only form a
/// Rust string can hold.
pub fn text(units: &[u16]) -> String {
    String::from_utf16_lossy(units)
}

/// JS `s.slice(start, end)` with offsets in UTF-16 code units (clamped like JS; an end before the start gives "").
pub fn slice(s: &str, start: usize, end: usize) -> String {
    let u = units(s);
    let end = end.min(u.len());
    let start = start.min(end);
    text(&u[start..end])
}

/// JS `haystack.indexOf(needle, from)` over code units: `from` is clamped to the length, an empty needle is found at `from`.
pub fn index_of(haystack: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    let from = from.min(haystack.len());
    if needle.is_empty() {
        return Some(from);
    }
    if needle.len() > haystack.len() {
        return None;
    }
    (from..=haystack.len() - needle.len()).find(|&i| haystack[i..i + needle.len()] == *needle)
}

/// JS `s.startsWith(prefix, at)` over code units.
pub fn starts_with_at(haystack: &[u16], at: usize, prefix: &[u16]) -> bool {
    at <= haystack.len() && haystack.len() - at >= prefix.len() && haystack[at..at + prefix.len()] == *prefix
}

/// JS `\s` (WhiteSpace and LineTerminator): what `/\s/`, `String.prototype.trim` and `Number(text)` skip.
pub fn is_js_space(c: u16) -> bool {
    matches!(c, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}

/// [`is_js_space`] for a char.
pub fn is_js_space_char(c: char) -> bool {
    u16::try_from(u32::from(c)).is_ok_and(is_js_space)
}

/// JS `s.trim()`.
pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space_char)
}

/// JS `s.trimStart()`.
pub fn js_trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_space_char)
}

/// JS `s.trimEnd()`.
pub fn js_trim_end(s: &str) -> &str {
    s.trim_end_matches(is_js_space_char)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn counts_and_cuts_like_js() {
        assert_eq!(len("zażółć 🙂"), 9);
        assert_eq!(slice("a🙂b", 0, 2), "a\u{fffd}");
        assert_eq!(slice("a🙂b", 3, 9), "b");
        assert_eq!(slice("abc", 2, 1), "");
        let h = units("abcabc");
        assert_eq!(index_of(&h, &units("bc"), 2), Some(4));
        assert_eq!(index_of(&h, &units(""), 99), Some(6));
        assert_eq!(index_of(&h, &units("x"), 0), None);
        assert!(starts_with_at(&h, 3, &units("abc")));
        assert!(!starts_with_at(&h, 4, &units("abc")));
        assert_eq!(js_trim("\u{feff}\u{a0} x \u{2028}"), "x");
        assert_eq!(js_trim("\u{85}x"), "\u{85}x");
    }
}
