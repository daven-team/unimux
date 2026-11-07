//! `new RegExp(source, flags)` of V8 for the project search: the pattern runs on regress (an ECMAScript engine) over UTF-16
//! code units, so indexes, case folding (`u`: simple case folding, otherwise the Annex B uppercase rule), `.` on surrogate
//! pairs, lookbehind, named groups and modifiers are those of 1.1.4's RegExp. A pattern V8 refuses without `u` gets V8's own
//! message from [`annex_b_error`], a check of the Annex B grammar in the order V8's parser reports (regexp-parser.cc).
//! Golden rows: test/golden/search-pattern.jsonl and search-compile.jsonl.

use regress::{Flags, Match, Regex};

/// A compiled pattern with the flags 1.1.4 gave it (`g` is the caller's loop).
#[derive(Debug, Clone)]
pub struct JsRegex {
    re: Regex,
    unicode: bool,
    icase: bool,
}

impl JsRegex {
    /// `new RegExp(source, flags)` for the flags `i` and `u` (others are not used by the search).
    pub fn new(source: &str, icase: bool, unicode: bool) -> Result<Self, String> {
        let flags = Flags { icase, unicode, ..Flags::default() };
        if !unicode && let Some(reason) = annex_b_error(source) {
            return Err(reason.to_string());
        }
        if unicode && quantified_assertion(source) {
            // regress takes `\b?` and `(?=a)*` with `u`; V8 refuses them (only Annex B quantifies a lookahead).
            return Err(NOTHING_TO_REPEAT.to_string());
        }
        // Without `u` the pattern is code units too: an emoji typed into it is two characters (its surrogates).
        let compiled = if unicode {
            Regex::with_flags(source, flags)
        } else {
            Regex::from_unicode(source.encode_utf16().map(u32::from), flags)
        };
        match compiled {
            Ok(re) => Ok(Self { re, unicode, icase }),
            Err(e) => Err(e.text),
        }
    }

    pub fn unicode(&self) -> bool {
        self.unicode
    }

    /// `regex.flags` with `g` (V8's order: "giu").
    pub fn flags(&self) -> String {
        format!("g{}{}", if self.icase { "i" } else { "" }, if self.unicode { "u" } else { "" })
    }

    /// `regex.lastIndex = from; regex.exec(text)`: the leftmost match starting at `from` or later (`None` past the end).
    pub fn exec(&self, text: &[u16], from: usize) -> Option<Match> {
        if from > text.len() {
            return None;
        }
        // Without `u` every code unit is a character (a pair is two), as in V8.
        if self.unicode { self.re.find_from_utf16(text, from).next() } else { self.re.find_from_ucs2(text, from).next() }
    }

    /// Where the loop goes on after an empty match at `at`. 1.1.4 did `lastIndex++`; with `u` that lands inside a surrogate
    /// pair, V8 steps back to the pair's start and the same empty match comes again forever (1.1.4 froze). 1.2.0 skips the
    /// whole code point (what `String.prototype.matchAll` does); without `u` it is `lastIndex++` as before.
    pub fn after_empty(&self, text: &[u16], at: usize) -> usize {
        let pair =
            self.unicode && matches!(text.get(at), Some(0xd800..=0xdbff)) && matches!(text.get(at + 1), Some(0xdc00..=0xdfff));
        at + if pair { 2 } else { 1 }
    }
}

/// `Invalid regular expression: /<source>/<flags>: <reason>` (V8's SyntaxError message).
pub fn v8_message(source: &str, flags: &str, reason: &str) -> String {
    format!("Invalid regular expression: /{source}/{flags}: {reason}")
}

/// With `u`: a quantifier right after `\b`, `\B` or a lookaround group (escapes and classes skipped).
fn quantified_assertion(source: &str) -> bool {
    let p: Vec<char> = source.chars().collect();
    let quantifier = |i: usize| match p.get(i) {
        Some('*' | '+' | '?') => true,
        // With `u` a lone '{' is an error anyway; any '{' after an assertion is refused.
        Some('{') => true,
        _ => false,
    };
    let mut groups: Vec<bool> = Vec::new(); // true = lookaround
    let mut i = 0;
    let mut in_class = false;
    while i < p.len() {
        match p[i] {
            '\\' => {
                if !in_class && matches!(p.get(i + 1), Some('b' | 'B')) && quantifier(i + 2) {
                    return true;
                }
                i += 2;
                continue;
            }
            '[' if !in_class => in_class = true,
            ']' if in_class => in_class = false,
            '(' if !in_class => {
                let look = p.get(i + 1) == Some(&'?')
                    && (matches!(p.get(i + 2), Some('=' | '!'))
                        || (p.get(i + 2) == Some(&'<') && matches!(p.get(i + 3), Some('=' | '!'))));
                groups.push(look);
            }
            // The pop runs for every closing parenthesis outside a class (a failed guard falls through to `_`).
            ')' if !in_class && groups.pop() == Some(true) && quantifier(i + 1) => return true,
            _ => {}
        }
        i += 1;
    }
    false
}

// ── the Annex B syntax check ─────────────────────────────────────────────────

const NOTHING_TO_REPEAT: &str = "Nothing to repeat";

#[derive(Clone, Copy, PartialEq)]
enum Group {
    Capture,
    NonCapture,
    Lookahead,
    Lookbehind,
}

struct Open {
    kind: Group,
    /// The disjunction this group opens (an index into `alternatives`).
    disjunction: usize,
    /// A named group's name and path, registered when the group closes (V8 checks duplicates there).
    name: Option<Named>,
}

/// One named group: the (disjunction, alternative) of every enclosing level when it was opened.
struct Named {
    name: Vec<u32>,
    path: Vec<(usize, usize)>,
}

struct Parser<'a> {
    p: &'a [u32],
    at: usize,
    /// Capturing groups of the whole pattern (V8 scans for them before a decimal escape is read).
    captures: usize,
    has_named: bool,
    /// The current alternative of every disjunction (0 = the pattern itself).
    alternatives: Vec<usize>,
    stack: Vec<Open>,
    named: Vec<Named>,
    references: Vec<Vec<u32>>,
}

/// What V8 reports for `source` compiled without the `u` flag, or `None` when it compiles.
pub fn annex_b_error(source: &str) -> Option<&'static str> {
    let units: Vec<u32> = source.encode_utf16().map(u32::from).collect();
    let (captures, has_named) = scan_captures(&units);
    let mut parser = Parser {
        p: &units,
        at: 0,
        captures,
        has_named,
        alternatives: vec![0],
        stack: Vec::new(),
        named: Vec::new(),
        references: Vec::new(),
    };
    parser.disjunction().err()
}

/// V8's ScanForCaptures: the number of capturing groups and whether one has a name (escapes and classes skipped).
fn scan_captures(p: &[u32]) -> (usize, bool) {
    let (mut count, mut named) = (0, false);
    let mut i = 0;
    let mut in_class = false;
    while i < p.len() {
        match p[i] {
            0x5c => i += 1, // '\\': skip the escaped unit
            0x5b if !in_class => in_class = true,
            0x5d if in_class => in_class = false,
            0x28 if !in_class => {
                if p.get(i + 1) != Some(&0x3f) {
                    count += 1;
                } else if p.get(i + 2) == Some(&0x3c) && !matches!(p.get(i + 3), Some(0x3d) | Some(0x21)) {
                    count += 1;
                    named = true;
                }
            }
            _ => {}
        }
        i += 1;
    }
    (count, named)
}

fn is_digit(c: u32) -> bool {
    (0x30..=0x39).contains(&c)
}

fn is_hex(c: u32) -> bool {
    is_digit(c) || (0x41..=0x46).contains(&c) || (0x61..=0x66).contains(&c)
}

fn hex_value(c: u32) -> u32 {
    char::from_u32(c).and_then(|c| c.to_digit(16)).unwrap_or(0)
}

const END: u32 = u32::MAX;

impl Parser<'_> {
    fn cur(&self) -> u32 {
        self.p.get(self.at).copied().unwrap_or(END)
    }
    fn peek(&self, n: usize) -> u32 {
        self.p.get(self.at + n).copied().unwrap_or(END)
    }

    fn disjunction(&mut self) -> Result<(), &'static str> {
        loop {
            // The atom (or assertion) at the head of the loop; `quantifiable` says whether a quantifier may follow.
            let quantifiable: Option<bool> = match self.cur() {
                END => {
                    if !self.stack.is_empty() {
                        return Err("Unterminated group");
                    }
                    return self.check_references();
                }
                0x29 => {
                    // ')'
                    let Some(open) = self.stack.pop() else { return Err("Unmatched ')'") };
                    self.at += 1;
                    self.alternatives.truncate(open.disjunction);
                    if let Some(named) = open.name {
                        self.add_name(named)?;
                    }
                    Some(open.kind != Group::Lookbehind)
                }
                0x7c => {
                    // '|'
                    self.at += 1;
                    *self.alternatives.last_mut().expect("the pattern level") += 1;
                    None
                }
                0x2a | 0x2b | 0x3f => return Err(NOTHING_TO_REPEAT),
                0x5e | 0x24 => {
                    self.at += 1;
                    None
                }
                0x2e => {
                    self.at += 1;
                    Some(true)
                }
                0x28 => {
                    self.open_group()?;
                    None
                }
                0x5b => {
                    self.class()?;
                    Some(true)
                }
                0x5c => self.atom_escape()?,
                0x7b => {
                    if self.interval(self.at).is_some() {
                        return Err(NOTHING_TO_REPEAT);
                    }
                    self.at += 1;
                    Some(true)
                }
                _ => {
                    self.at += 1;
                    Some(true)
                }
            };
            let Some(quantifiable) = quantifiable else { continue };
            // A quantifier after the atom.
            let quantified = match self.cur() {
                0x2a | 0x2b | 0x3f => {
                    self.at += 1;
                    true
                }
                0x7b => match self.interval(self.at) {
                    Some((min, max, end)) => {
                        if max < min {
                            return Err("numbers out of order in {} quantifier");
                        }
                        self.at = end;
                        true
                    }
                    None => false,
                },
                _ => false,
            };
            if quantified {
                if self.cur() == 0x3f {
                    self.at += 1;
                }
                if !quantifiable {
                    return Err("Invalid quantifier");
                }
            }
        }
    }

    /// `{min}`, `{min,}` or `{min,max}` at `at`: (min, max, index after '}'), or `None` when it is no quantifier.
    fn interval(&self, at: usize) -> Option<(f64, f64, usize)> {
        let mut i = at + 1;
        let digits = |i: &mut usize| -> Option<f64> {
            let start = *i;
            let mut value = 0f64;
            while let Some(&c) = self.p.get(*i).filter(|c| is_digit(**c)) {
                value = (value * 10.0 + f64::from(c - 0x30)).min(f64::from(i32::MAX));
                *i += 1;
            }
            (*i > start).then_some(value)
        };
        let min = digits(&mut i)?;
        let mut max = min;
        if self.p.get(i) == Some(&0x2c) {
            i += 1;
            max = if self.p.get(i) == Some(&0x7d) { f64::INFINITY } else { digits(&mut i)? };
        }
        (self.p.get(i) == Some(&0x7d)).then_some((min, max, i + 1))
    }

    fn open_group(&mut self) -> Result<(), &'static str> {
        // At '('.
        self.at += 1;
        let mut name = None;
        let kind = if self.cur() == 0x3f {
            self.at += 1;
            match self.cur() {
                0x3a => {
                    self.at += 1;
                    Group::NonCapture
                }
                0x3d | 0x21 => {
                    self.at += 1;
                    Group::Lookahead
                }
                0x3c => {
                    self.at += 1;
                    match self.cur() {
                        0x3d | 0x21 => {
                            self.at += 1;
                            Group::Lookbehind
                        }
                        _ => {
                            let path = self.alternatives.iter().copied().enumerate().collect();
                            name = Some(Named { name: self.group_name()?, path });
                            Group::Capture
                        }
                    }
                }
                0x2d | 0x69 | 0x6d | 0x73 => {
                    self.modifiers()?;
                    Group::NonCapture
                }
                _ => return Err("Invalid group"),
            }
        } else {
            Group::Capture
        };
        self.alternatives.push(0);
        self.stack.push(Open { kind, disjunction: self.alternatives.len() - 1, name });
        Ok(())
    }

    /// `(?ims-ims:` after the `?`.
    fn modifiers(&mut self) -> Result<(), &'static str> {
        let mut seen = 0u8;
        let mut dash = false;
        loop {
            let flag = match self.cur() {
                0x2d => {
                    if dash {
                        return Err("Multiple dashes in flag group");
                    }
                    dash = true;
                    self.at += 1;
                    continue;
                }
                0x69 => 1,
                0x6d => 2,
                0x73 => 4,
                0x3a => {
                    if dash && seen == 0 {
                        return Err("Invalid flag group");
                    }
                    self.at += 1;
                    return Ok(());
                }
                // `(?i)` and an unfinished `(?i`: V8 takes them for a group of another kind.
                0x29 | END => return Err("Invalid group"),
                _ => return Err("Invalid flag group"),
            };
            if seen & flag != 0 {
                return Err("Repeated flag in flag group");
            }
            seen |= flag;
            self.at += 1;
        }
    }

    /// The `RegExpIdentifierName` of a group or a `\k` reference, through its '>'.
    fn group_name(&mut self) -> Result<Vec<u32>, &'static str> {
        const INVALID: &str = "Invalid capture group name";
        let mut name = Vec::new();
        loop {
            let mut c = self.cur();
            if c == 0x3e {
                self.at += 1;
                break;
            }
            if c == END {
                return Err(INVALID);
            }
            self.at += 1;
            if c == 0x5c {
                if self.cur() != 0x75 {
                    return Err(INVALID);
                }
                self.at += 1;
                c = self.name_unicode_escape().ok_or("Invalid Unicode escape")?;
            } else if (0xd800..=0xdbff).contains(&c) && (0xdc00..=0xdfff).contains(&self.cur()) {
                c = 0x10000 + ((c - 0xd800) << 10) + (self.cur() - 0xdc00);
                self.at += 1;
            }
            let ch = char::from_u32(c).ok_or(INVALID)?;
            let ok = if name.is_empty() {
                ch == '$' || ch == '_' || unicode_ident::is_xid_start(ch) || is_other_id_start(ch)
            } else {
                ch == '$' || ch == '\u{200c}' || ch == '\u{200d}' || unicode_ident::is_xid_continue(ch) || is_other_id_start(ch)
            };
            if !ok {
                return Err(INVALID);
            }
            name.push(c);
        }
        if name.is_empty() {
            return Err(INVALID);
        }
        Ok(name)
    }

    /// `\uXXXX` (a pair of them for an astral character) or `\u{...}` in a group name, after the `\u`.
    fn name_unicode_escape(&mut self) -> Option<u32> {
        if self.cur() == 0x7b {
            self.at += 1;
            let mut value = 0u32;
            let start = self.at;
            while is_hex(self.cur()) {
                value = value.checked_mul(16)? + hex_value(self.cur());
                if value > 0x10ffff {
                    return None;
                }
                self.at += 1;
            }
            if self.at == start || self.cur() != 0x7d {
                return None;
            }
            self.at += 1;
            return Some(value);
        }
        let lead = self.hex4()?;
        if (0xd800..=0xdbff).contains(&lead) && self.cur() == 0x5c && self.peek(1) == 0x75 {
            let save = self.at;
            self.at += 2;
            match self.hex4() {
                Some(trail) if (0xdc00..=0xdfff).contains(&trail) => {
                    return Some(0x10000 + ((lead - 0xd800) << 10) + (trail - 0xdc00));
                }
                _ => self.at = save,
            }
        }
        Some(lead)
    }

    fn hex4(&mut self) -> Option<u32> {
        let mut value = 0;
        for k in 0..4 {
            let c = self.peek(k);
            if !is_hex(c) {
                return None;
            }
            value = value * 16 + hex_value(c);
        }
        self.at += 4;
        Some(value)
    }

    fn add_name(&mut self, named: Named) -> Result<(), &'static str> {
        for other in self.named.iter().filter(|n| n.name == named.name) {
            // Two groups of one name are allowed only in different alternatives of a shared disjunction.
            let apart = other.path.iter().zip(&named.path).any(|(a, b)| a.0 == b.0 && a.1 != b.1);
            if !apart {
                return Err("Duplicate capture group name");
            }
        }
        self.named.push(named);
        Ok(())
    }

    fn check_references(&self) -> Result<(), &'static str> {
        for reference in &self.references {
            if !self.named.iter().any(|n| &n.name == reference) {
                return Err("Invalid named capture referenced");
            }
        }
        Ok(())
    }

    /// An escape outside a class, at the '\\': `Some(quantifiable)` (`None` for an assertion).
    fn atom_escape(&mut self) -> Result<Option<bool>, &'static str> {
        self.at += 1;
        let c = self.cur();
        match c {
            END => Err("\\ at end of pattern"),
            0x62 | 0x42 => {
                self.at += 1;
                Ok(None)
            }
            0x31..=0x39 => {
                // A back reference when the number is at most the capture count, else an octal or identity escape.
                let start = self.at;
                let mut value = 0usize;
                while is_digit(self.cur()) {
                    value = value.saturating_mul(10).saturating_add((self.cur() - 0x30) as usize);
                    self.at += 1;
                }
                if value <= self.captures {
                    return Ok(Some(true));
                }
                self.at = start;
                if c >= 0x38 {
                    self.at += 1;
                } else {
                    self.octal();
                }
                Ok(Some(true))
            }
            0x6b if self.has_named => {
                self.at += 1;
                if self.cur() != 0x3c {
                    return Err("Invalid named reference");
                }
                self.at += 1;
                let name = self.group_name()?;
                self.references.push(name);
                Ok(Some(true))
            }
            _ => {
                self.character_escape(false)?;
                Ok(Some(true))
            }
        }
    }

    /// Up to three octal digits (value at most 0o377), at the first digit.
    fn octal(&mut self) {
        let mut value = 0;
        for _ in 0..3 {
            let c = self.cur();
            if !(0x30..=0x37).contains(&c) || value * 8 + (c - 0x30) > 0o377 {
                break;
            }
            value = value * 8 + (c - 0x30);
            self.at += 1;
        }
    }

    /// The character escape after a '\\' (at the escaped unit). In a class `\k` is refused when the pattern has a named group.
    fn character_escape(&mut self, in_class: bool) -> Result<(), &'static str> {
        let c = self.cur();
        match c {
            0x63 => {
                // '\c' + a letter is a control character; otherwise the '\' stands for itself and 'c' is read next.
                let next = self.peek(1);
                let letter = (0x41..=0x5a).contains(&next) || (0x61..=0x7a).contains(&next);
                let class_extra = in_class && (is_digit(next) || next == 0x5f);
                if letter || class_extra {
                    self.at += 2;
                }
            }
            0x30..=0x37 => self.octal(),
            0x78 => {
                self.at += 1;
                if is_hex(self.cur()) && is_hex(self.peek(1)) {
                    self.at += 2;
                }
            }
            0x75 => {
                self.at += 1;
                let _ = self.hex4();
            }
            0x6b if in_class && self.has_named => return Err("Invalid escape"),
            _ => self.at += 1,
        }
        Ok(())
    }

    /// `[...]` at the '['.
    fn class(&mut self) -> Result<(), &'static str> {
        const UNTERMINATED: &str = "Unterminated character class";
        self.at += 1;
        if self.cur() == 0x5e {
            self.at += 1;
        }
        loop {
            match self.cur() {
                END => return Err(UNTERMINATED),
                0x5d => {
                    self.at += 1;
                    return Ok(());
                }
                _ => {}
            }
            let first = self.class_atom()?;
            if self.cur() != 0x2d {
                continue;
            }
            self.at += 1;
            match self.cur() {
                END => return Err(UNTERMINATED),
                0x5d => continue, // '-' at the end is literal
                _ => {}
            }
            let second = self.class_atom()?;
            if let (Some(a), Some(b)) = (first, second)
                && a > b
            {
                return Err("Range out of order in character class");
            }
        }
    }

    /// One class atom: its code unit value, or `None` for a class escape (`\d`, `\w`, ...).
    fn class_atom(&mut self) -> Result<Option<u32>, &'static str> {
        let c = self.cur();
        if c != 0x5c {
            self.at += 1;
            return Ok(Some(c));
        }
        self.at += 1;
        let e = self.cur();
        let simple = |v: u32| Ok(Some(v));
        match e {
            END => Err("\\ at end of pattern"),
            0x64 | 0x44 | 0x73 | 0x53 | 0x77 | 0x57 => {
                self.at += 1;
                Ok(None)
            }
            0x62 => {
                self.at += 1;
                simple(8)
            }
            0x2d => {
                self.at += 1;
                simple(0x2d)
            }
            0x63 => {
                let next = self.peek(1);
                if (0x41..=0x5a).contains(&next) || (0x61..=0x7a).contains(&next) || is_digit(next) || next == 0x5f {
                    self.at += 2;
                    simple(next & 0x1f)
                } else {
                    // The '\' stands for itself; 'c' is the next atom.
                    simple(0x5c)
                }
            }
            0x30..=0x37 => {
                let start = self.at;
                self.octal();
                let mut value = 0;
                for &d in &self.p[start..self.at] {
                    value = value * 8 + (d - 0x30);
                }
                simple(value)
            }
            0x78 => {
                self.at += 1;
                if is_hex(self.cur()) && is_hex(self.peek(1)) {
                    let v = hex_value(self.cur()) * 16 + hex_value(self.peek(1));
                    self.at += 2;
                    simple(v)
                } else {
                    simple(0x78)
                }
            }
            0x75 => {
                self.at += 1;
                match self.hex4() {
                    Some(v) => simple(v),
                    None => simple(0x75),
                }
            }
            0x66 => {
                self.at += 1;
                simple(0x0c)
            }
            0x6e => {
                self.at += 1;
                simple(0x0a)
            }
            0x72 => {
                self.at += 1;
                simple(0x0d)
            }
            0x74 => {
                self.at += 1;
                simple(0x09)
            }
            0x76 => {
                self.at += 1;
                simple(0x0b)
            }
            0x6b if self.has_named => Err("Invalid escape"),
            _ => {
                self.at += 1;
                simple(e)
            }
        }
    }
}

/// Other_ID_Start (U+1885, U+1886, U+2118, U+212E, U+309B, U+309C): ID_Start but not XID_Start's closure.
fn is_other_id_start(c: char) -> bool {
    matches!(c, '\u{1885}' | '\u{1886}' | '\u{2118}' | '\u{212e}' | '\u{309b}' | '\u{309c}')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn annex_b_errors_like_v8() {
        let cases = [
            ("(", Some("Unterminated group")),
            (")", Some("Unmatched ')'")),
            ("*", Some(NOTHING_TO_REPEAT)),
            ("a**", Some(NOTHING_TO_REPEAT)),
            ("a{1}{2}", Some(NOTHING_TO_REPEAT)),
            ("{1}", Some(NOTHING_TO_REPEAT)),
            ("{", None),
            ("a{,3}", None),
            ("a{3,2}", Some("numbers out of order in {} quantifier")),
            ("[b-a]", Some("Range out of order in character class")),
            ("[\\d-a]", None),
            ("[", Some("Unterminated character class")),
            ("]", None),
            ("\\", Some("\\ at end of pattern")),
            ("(?<=a)*", Some("Invalid quantifier")),
            ("(?=a)*", None),
            ("(?x)", Some("Invalid group")),
            ("(?<1a>x)", Some("Invalid capture group name")),
            ("(?<a>x)(?<a>y)", Some("Duplicate capture group name")),
            ("(?<a>x)|(?<a>y)", None),
            ("(?<a>x)\\k<b>", Some("Invalid named capture referenced")),
            ("(?<a>x)\\k", Some("Invalid named reference")),
            ("\\k<a>", None),
            ("(?<a>a)[\\k]", Some("Invalid escape")),
            ("(?ii:a)", Some("Repeated flag in flag group")),
            ("(?i-i:a)", Some("Repeated flag in flag group")),
            ("(?-:a)", Some("Invalid flag group")),
            ("(?i)", Some("Invalid group")),
            ("(?<a>(?<a>x", Some("Unterminated group")),
            ("(?--i:a)", Some("Multiple dashes in flag group")),
            ("(?i-:a)", None),
            ("\\8", None),
            ("(?<𝒜>x)", None),
        ];
        for (source, expected) in cases {
            assert_eq!(annex_b_error(source), expected, "{source}");
        }
    }

    #[test]
    fn empty_matches_skip_whole_code_points_with_u() {
        let text: Vec<u16> = "😀x".encode_utf16().collect();
        let u = JsRegex::new("x*", false, true).unwrap();
        assert_eq!(u.after_empty(&text, 0), 2);
        let legacy = JsRegex::new("x*", false, false).unwrap();
        assert_eq!(legacy.after_empty(&text, 0), 1);
    }
}
