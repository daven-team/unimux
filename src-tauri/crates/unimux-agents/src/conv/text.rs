//! JavaScript string semantics the conversation search depends on: texts are UTF-16 code units (every offset the renderer
//! gets is one), `toLowerCase()`, the same-length `fold()` of src/shared/convSearch.ts, `\s` / `trim()`, and `indexOf` /
//! `lastIndexOf` over code units.
//!
//! A JavaScript string can hold an unpaired surrogate (a message cut by `.slice()` in the middle of an emoji); the index keeps
//! it as a code unit. Text that leaves Rust (JSON to the renderer) turns such a unit into U+FFFD, which is also one code unit,
//! so every offset stays valid; the renderer and any file written from it show U+FFFD for a lone surrogate either way.

use std::sync::OnceLock;

use memchr::memmem;

/// A UTF-16 text (JavaScript string).
pub type U16s = Vec<u16>;

pub fn utf16(s: &str) -> U16s {
    s.encode_utf16().collect()
}

/// The text as a Rust string; an unpaired surrogate becomes U+FFFD (one code unit, so offsets stay valid).
pub fn lossy(units: &[u16]) -> String {
    char::decode_utf16(units.iter().copied()).map(|r| r.unwrap_or('\u{FFFD}')).collect()
}

/// `s.length`.
pub fn len16(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// ECMAScript WhiteSpace and LineTerminator (`\s`, `trim()`).
pub fn is_space16(u: u16) -> bool {
    matches!(
        u,
        0x09 | 0x0a | 0x0b | 0x0c | 0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000
            ..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff
    )
}

pub fn is_space(c: char) -> bool {
    (c as u32) < 0x10000 && is_space16(c as u32 as u16)
}

/// `s.trim()`.
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}

/// `s.replace(/\s+/g, ' ')`.
pub fn collapse_space(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if is_space(c) {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    out
}

/// `s.slice(0, end)` in code units, as a Rust string (half a pair at the cut becomes U+FFFD).
pub fn slice16(s: &str, end: usize) -> String {
    let units = utf16(s);
    if units.len() <= end {
        return s.to_string();
    }
    lossy(&units[..end])
}

/// `a < b` as JavaScript compares strings (by UTF-16 code units).
pub fn js_less(a: &str, b: &str) -> bool {
    a.encode_utf16().lt(b.encode_utf16())
}

// ── lower case and fold ──────────────────────────────────────────────────────

/// `s.toLowerCase()` over code units: full Unicode lower case with the final-sigma rule; an unpaired surrogate stays (it is
/// neither cased nor case-ignorable, so it ends a final-sigma context like any other such character).
pub fn to_lower(units: &[u16]) -> U16s {
    if units.iter().all(|&u| u < 0x80) {
        return units.iter().map(|&u| if (0x41..=0x5a).contains(&u) { u + 32 } else { u }).collect();
    }
    let mut out = Vec::with_capacity(units.len());
    let mut run = String::new();
    let flush = |run: &mut String, out: &mut U16s| {
        if !run.is_empty() {
            out.extend(run.to_lowercase().encode_utf16());
            run.clear();
        }
    };
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        if (0xd800..0xdc00).contains(&u) && i + 1 < units.len() && (0xdc00..0xe000).contains(&units[i + 1]) {
            let c = 0x10000 + (((u as u32) - 0xd800) << 10) + ((units[i + 1] as u32) - 0xdc00);
            run.push(char::from_u32(c).unwrap_or('\u{FFFD}'));
            i += 2;
        } else if (0xd800..0xe000).contains(&u) {
            flush(&mut run, &mut out);
            out.push(u);
            i += 1;
        } else {
            run.push(char::from_u32(u as u32).unwrap_or('\u{FFFD}'));
            i += 1;
        }
    }
    flush(&mut run, &mut out);
    out
}

/// `s.toLowerCase()` of a Rust string.
pub fn to_lower_str(s: &str) -> String {
    if s.is_ascii() { s.to_ascii_lowercase() } else { s.to_lowercase() }
}

fn lower_unit(c: u16) -> U16s {
    if (0xd800..0xe000).contains(&c) {
        return vec![c];
    }
    let ch = char::from_u32(c as u32).unwrap_or('\u{FFFD}');
    let mut out = Vec::new();
    for l in ch.to_lowercase() {
        let mut buf = [0u16; 2];
        out.extend_from_slice(l.encode_utf16(&mut buf));
    }
    out
}

/// `foldNonAscii(c)` of one code unit.
fn fold_non_ascii(c: u16) -> u16 {
    let lower = lower_unit(c);
    let one = if lower.len() == 1 { lower[0] } else { c };
    let special = match one {
        0x142 => Some('l'), // ł
        0x111 => Some('d'), // đ
        0xf8 => Some('o'),  // ø
        0xdf => Some('s'),  // ß
        0xe6 => Some('a'),  // æ
        0x153 => Some('o'), // œ
        0x131 => Some('i'), // ı
        _ => None,
    };
    let mut hit = match special {
        Some(c) => c as u16,
        None if one < 0x0530 || (0x1e00..0x1f00).contains(&one) => {
            // `one.normalize('NFD')[0] ?? one`: the first code unit of the canonical decomposition.
            match char::from_u32(one as u32) {
                Some(ch) => {
                    let mut first: Option<char> = None;
                    unicode_normalization::char::decompose_canonical(ch, |d| {
                        if first.is_none() {
                            first = Some(d);
                        }
                    });
                    let mut buf = [0u16; 2];
                    first.map(|d| d.encode_utf16(&mut buf)[0]).unwrap_or(one)
                }
                None => one,
            }
        }
        None => one,
    };
    let lower_hit = lower_unit(hit);
    if lower_hit.len() == 1 {
        hit = lower_hit[0];
    }
    hit
}

/// foldNonAscii for every code unit (built once; ASCII entries are unused).
pub fn fold_table() -> &'static [u16] {
    static TABLE: OnceLock<Vec<u16>> = OnceLock::new();
    TABLE.get_or_init(|| (0..=0xffffu32).map(|u| if u < 0x80 { u as u16 } else { fold_non_ascii(u as u16) }).collect())
}

/// `fold(s)`: case and diacritics folded text of the same length as `s` ("Zażółć" and "zazolc" fold alike).
pub fn fold(units: &[u16]) -> U16s {
    let table = fold_table();
    if units.iter().all(|&u| u < 0x80) {
        return to_lower(units);
    }
    let lower = to_lower(units);
    if lower.len() == units.len() {
        return lower.into_iter().map(|u| if u < 0x80 { u } else { table[u as usize] }).collect();
    }
    // A character whose lower case is longer (U+0130): one unit at a time.
    units
        .iter()
        .map(|&u| if u < 0x80 { if (0x41..=0x5a).contains(&u) { u + 32 } else { u } } else { table[u as usize] })
        .collect()
}

pub fn fold_str(s: &str) -> U16s {
    fold(&utf16(s))
}

// ── search over code units ───────────────────────────────────────────────────

fn as_bytes(units: &[u16]) -> &[u8] {
    // SAFETY: u16 has no padding and any byte pattern is a valid u8; the length is twice the unit count.
    unsafe { std::slice::from_raw_parts(units.as_ptr().cast::<u8>(), units.len() * 2) }
}

/// A term prepared for repeated `indexOf` calls (SIMD byte search, matches at odd byte offsets skipped).
pub struct Needle {
    pub units: U16s,
    finder: memmem::Finder<'static>,
}

impl Needle {
    pub fn new(units: U16s) -> Self {
        let finder = memmem::Finder::new(as_bytes(&units)).into_owned();
        Self { units, finder }
    }

    pub fn len(&self) -> usize {
        self.units.len()
    }

    pub fn is_empty(&self) -> bool {
        self.units.is_empty()
    }

    /// `hay.indexOf(term, from)`.
    pub fn find(&self, hay: &[u16], from: usize) -> Option<usize> {
        if self.units.is_empty() {
            return Some(from.min(hay.len()));
        }
        if from >= hay.len() {
            return None;
        }
        let bytes = as_bytes(&hay[from..]);
        let mut pos = 0;
        while pos < bytes.len() {
            let i = self.finder.find(&bytes[pos..])?;
            let at = pos + i;
            if at % 2 == 0 {
                return Some(from + at / 2);
            }
            pos = at + 1;
        }
        None
    }

    /// `hay.includes(term)`.
    pub fn found_in(&self, hay: &[u16]) -> bool {
        self.find(hay, 0).is_some()
    }
}

/// `hay.indexOf(String.fromCharCode(unit), from)`.
pub fn index_of_unit(hay: &[u16], unit: u16, from: usize) -> Option<usize> {
    hay.get(from..)?.iter().position(|&u| u == unit).map(|i| i + from)
}

/// `hay.lastIndexOf(String.fromCharCode(unit), from)`.
pub fn last_index_of_unit(hay: &[u16], unit: u16, from: usize) -> Option<usize> {
    if hay.is_empty() {
        return None;
    }
    let end = from.min(hay.len() - 1);
    hay[..=end].iter().rposition(|&u| u == unit)
}

/// `a.includes(b)` for short texts.
pub fn contains(hay: &[u16], needle: &[u16]) -> bool {
    needle.is_empty() || hay.windows(needle.len()).any(|w| w == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(s: &str) -> String {
        lossy(&fold_str(s))
    }

    #[test]
    fn folds_like_the_ts_reference_test() {
        let s = "Zażółć GĘŚLĄ Jaźń İx ß";
        assert_eq!(f(s), "zazolc gesla jazn ix s");
        assert_eq!(fold_str(s).len(), len16(s));
        assert_eq!(f("한국어"), "한국어");
        assert_eq!(fold_str("emoji 😀 ok").len(), len16("emoji 😀 ok"));
    }

    #[test]
    fn needle_skips_odd_byte_offsets() {
        // 0x0100 0x0001 contains the byte pair 01 00 at an odd offset when looking for 0x0001 0x....
        let hay = [0x0100u16, 0x0001, 0x4141];
        let n = Needle::new(vec![0x0001]);
        assert_eq!(n.find(&hay, 0), Some(1));
        let n = Needle::new(vec![0x0041]);
        assert_eq!(n.find(&hay, 0), None);
        let n = Needle::new(vec![0x4141]);
        assert_eq!(n.find(&hay, 0), Some(2));
        assert_eq!(n.find(&hay, 3), None);
    }

    #[test]
    fn last_index_of_clamps_like_js() {
        let hay = utf16("a b c");
        assert_eq!(last_index_of_unit(&hay, 32, 100), Some(3));
        assert_eq!(last_index_of_unit(&hay, 32, 2), Some(1));
        assert_eq!(last_index_of_unit(&hay, 32, 0), None);
    }
}
