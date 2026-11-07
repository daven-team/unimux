//! Formatting and parsing of cell values (src/shared/dbSql.ts): how a cell reads, what typed input a column accepts, and the
//! copy / export formats (CSV, TSV, JSON). The 1.2.0 renderer keeps using its TS copies (DbGrid, DbTabView); these ports
//! exist so the whole module answers the same vectors in Rust, and for exports done without the renderer.
//!
//! A cell is a JSON value as the DB port sends it: a string (the server's text form), null, or `{t: 'trunc', head, chars}`.

use serde_json::{Map, Number, Value};

use super::ValueKind;
use super::mysql::hex_value;
use unimux_core::js_json;
use unimux_core::utf16::{is_js_space_char, js_trim};

/// `isTruncated`.
pub fn is_truncated(v: &Value) -> bool {
    v.is_object()
}

/// `dbValueText`: the full text of a value (a truncated one: its head), None for NULL.
pub fn db_value_text(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Object(o) => Some(o.get("head").and_then(Value::as_str).unwrap_or_default().to_owned()),
        other => Some(other.to_string()),
    }
}

/// `formatDbValue`: booleans as true / false, JSON pretty when asked (not when truncated), the rest as the server sent it.
pub fn format_db_value(v: &Value, kind: ValueKind, pretty: bool) -> Option<String> {
    let text = db_value_text(v)?;
    if kind == ValueKind::Bool {
        return Some(match text.as_str() {
            "t" => "true".into(),
            "f" => "false".into(),
            _ => text,
        });
    }
    if kind == ValueKind::Json && pretty && !is_truncated(v) {
        return Some(match parse_json(&text, PRETTY_DEPTH) {
            Some(parsed) => js_json::stringify_pretty(&parsed, 2),
            None => text,
        });
    }
    Some(text)
}

/// Nesting deeper than this is shown and exported as its text (V8 would hit its stack limit somewhere in the thousands).
const PRETTY_DEPTH: usize = 1000;

/// What `parseDbInput` answers: the text the server reads (None: NULL), or the message key of the error.
pub type DbParsed = Result<Option<String>, &'static str>;

const NUMERIC_ERROR: &str = "Wpisz liczbę";

/// `/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/`.
fn numeric_text(t: &str) -> bool {
    let b = t.as_bytes();
    let mut i = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let digits = |i: &mut usize| {
        let s = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i - s
    };
    if digits(&mut i) > 0 {
        if b.get(i) == Some(&b'.') {
            i += 1;
            digits(&mut i);
        }
    } else if b.get(i) == Some(&b'.') {
        i += 1;
        if digits(&mut i) == 0 {
            return false;
        }
    } else {
        return false;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if digits(&mut i) == 0 {
            return false;
        }
    }
    i == b.len()
}

/// `^[+-]?WORD$` with the word compared case-insensitively.
fn signed_word_ci(t: &str, words: &[&str]) -> bool {
    let w = t.strip_prefix(['+', '-']).unwrap_or(t);
    words.iter().any(|x| w.eq_ignore_ascii_case(x))
}

/// `^\{?[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}\}?$` (case-insensitive).
fn uuid_text(t: &str) -> bool {
    let b = t.as_bytes();
    let mut i = usize::from(b.first() == Some(&b'{'));
    for (k, len) in [8, 4, 4, 4, 12].into_iter().enumerate() {
        if k > 0 && b.get(i) == Some(&b'-') {
            i += 1;
        }
        if b.len() < i + len || !b[i..i + len].iter().all(u8::is_ascii_hexdigit) {
            return false;
        }
        i += len;
    }
    if b.get(i) == Some(&b'}') {
        i += 1;
    }
    i == b.len()
}

/// `/^\{[\s\S]*\}$/.test(t) || /^\[[^\]]*\]=\{[\s\S]*\}$/.test(t)`.
fn array_text(t: &str) -> bool {
    let braces = |s: &str| s.len() >= 2 && s.starts_with('{') && s.ends_with('}');
    if braces(t) {
        return true;
    }
    let Some(rest) = t.strip_prefix('[') else { return false };
    let Some(close) = rest.find(']') else { return false };
    rest[close + 1..].strip_prefix('=').is_some_and(braces)
}

/// `parseDbInput`: what the user typed into a cell, checked for the column's kind. `as_null`: the user chose NULL.
pub fn parse_db_input(kind: ValueKind, text: &str, as_null: bool, type_name: Option<&str>) -> DbParsed {
    use ValueKind::*;
    if as_null {
        return Ok(None);
    }
    if text.contains('\0') {
        return Err("Wartość nie może zawierać znaku NUL");
    }
    let t = js_trim(text);
    match kind {
        Int | Bigint => {
            let b = t.as_bytes();
            let digits = b.strip_prefix(b"+").or_else(|| b.strip_prefix(b"-")).unwrap_or(b);
            if digits.is_empty() || !digits.iter().all(u8::is_ascii_digit) {
                return Err("Wpisz liczbę całkowitą");
            }
            let (lo, hi) = if kind == Int { (-(1i128 << 31), (1i128 << 31) - 1) } else { (-(1i128 << 63), (1i128 << 63) - 1) };
            let significant = t.trim_start_matches(['+', '-']).trim_start_matches('0');
            // BigInt(t): any length; more than 30 significant digits is far outside both ranges.
            let n: Option<i128> = if significant.len() > 30 { None } else { t.strip_prefix('+').unwrap_or(t).parse().ok() };
            match n {
                Some(n) if n >= lo && n <= hi => Ok(Some(t.strip_prefix('+').unwrap_or(t).to_owned())),
                _ => Err("Liczba jest poza zakresem tego typu"),
            }
        }
        Float => {
            if numeric_text(t) || signed_word_ci(t, &["Infinity", "inf"]) || t.eq_ignore_ascii_case("NaN") {
                Ok(Some(t.to_owned()))
            } else {
                Err(NUMERIC_ERROR)
            }
        }
        Numeric => {
            let money = type_name == Some("money");
            if numeric_text(t)
                || t.eq_ignore_ascii_case("NaN")
                || (!money && signed_word_ci(t, &["Infinity"]))
                || (money && !t.is_empty())
            {
                Ok(Some(t.to_owned()))
            } else {
                Err(NUMERIC_ERROR)
            }
        }
        Bool => {
            let b = t.to_lowercase();
            if ["t", "true", "y", "yes", "on", "1"].contains(&b.as_str()) {
                Ok(Some("t".into()))
            } else if ["f", "false", "n", "no", "off", "0"].contains(&b.as_str()) {
                Ok(Some("f".into()))
            } else {
                Err("Wpisz true albo false")
            }
        }
        Json => {
            if json_valid(text) {
                Ok(Some(text.to_owned()))
            } else {
                Err("To nie jest poprawny JSON")
            }
        }
        Uuid => {
            if uuid_text(t) {
                Ok(Some(t.to_owned()))
            } else {
                Err("To nie jest poprawny UUID")
            }
        }
        Bytea => {
            if hex_value(t).is_some() {
                Ok(Some(t.to_owned()))
            } else {
                Err("Wpisz bajty szesnastkowo, np. \\x0aff")
            }
        }
        Array => {
            if array_text(t) {
                Ok(Some(t.to_owned()))
            } else {
                Err("Tablicę wpisz w nawiasach klamrowych, np. {1,2,3}")
            }
        }
        Date | Time | Timestamp | Timestamptz | Interval => {
            if t.is_empty() {
                Err("Wpisz wartość albo wybierz NULL")
            } else {
                Ok(Some(t.to_owned()))
            }
        }
        _ => Ok(Some(text.to_owned())),
    }
}

/// `csvField`: quoted when it holds the separator, a quote, a line break or blanks at either end.
fn csv_field(s: &str, sep: &str) -> String {
    let edge = s.chars().next().is_some_and(is_js_space_char) || s.chars().next_back().is_some_and(is_js_space_char);
    if s.contains(sep) || s.contains(['"', '\r', '\n']) || edge {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_owned()
    }
}

/// `rowsToCsv`: a header line, RFC 4180 quoting, NULL as an empty field, CRLF line ends.
pub fn rows_to_csv(columns: &[String], rows: &[Vec<Value>], sep: &str) -> String {
    let mut lines = vec![columns.iter().map(|c| csv_field(c, sep)).collect::<Vec<_>>().join(sep)];
    for row in rows {
        lines.push(
            row.iter().map(|v| db_value_text(v).map(|t| csv_field(&t, sep)).unwrap_or_default()).collect::<Vec<_>>().join(sep),
        );
    }
    format!("{}\r\n", lines.join("\r\n"))
}

/// `rowsToTsv`: tab-separated, NULL empty, runs of tabs and line breaks inside values as one space.
pub fn rows_to_tsv(rows: &[Vec<Value>]) -> String {
    let cell = |v: &Value| {
        let t = db_value_text(v).unwrap_or_default();
        let mut out = String::with_capacity(t.len());
        let mut in_run = false;
        for ch in t.chars() {
            if matches!(ch, '\t' | '\r' | '\n') {
                if !in_run {
                    out.push(' ');
                }
                in_run = true;
            } else {
                out.push(ch);
                in_run = false;
            }
        }
        out
    };
    rows.iter().map(|row| row.iter().map(cell).collect::<Vec<_>>().join("\t")).collect::<Vec<_>>().join("\n")
}

fn number(n: f64) -> Value {
    Number::from_f64(n).map_or(Value::Null, Value::Number)
}

/// `jsonValue`: a cell as a JSON value; numbers that fit a double exactly, booleans and JSON documents as such, the rest as
/// strings. A NaN or infinite number is null (what JSON.stringify writes for it).
pub fn json_value(v: &Value, kind: ValueKind) -> Value {
    let Some(text) = db_value_text(v) else { return Value::Null };
    if is_truncated(v) {
        return Value::String(text);
    }
    match kind {
        ValueKind::Int => number(js_to_number(&text)),
        ValueKind::Float => {
            let n = js_to_number(&text);
            if n.is_finite() { number(n) } else { Value::String(text) }
        }
        ValueKind::Bigint => {
            let n = js_to_number(&text);
            if n.is_finite() && n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 { number(n) } else { Value::String(text) }
        }
        ValueKind::Bool => match text.as_str() {
            "t" => Value::Bool(true),
            "f" => Value::Bool(false),
            _ => Value::String(text),
        },
        ValueKind::Json => parse_json(&text, PRETTY_DEPTH).unwrap_or(Value::String(text)),
        _ => Value::String(text),
    }
}

/// `rowsToJson`: an array of objects (column name -> jsonValue), pretty with 2 blanks.
pub fn rows_to_json(columns: &[(String, ValueKind)], rows: &[Vec<Value>]) -> String {
    let list: Vec<Value> = rows
        .iter()
        .map(|row| {
            let mut o = Map::new();
            for (i, (name, kind)) in columns.iter().enumerate() {
                o.insert(name.clone(), json_value(row.get(i).unwrap_or(&Value::Null), *kind));
            }
            js_json::order_map_like_js(&mut o);
            Value::Object(o)
        })
        .collect();
    js_json::stringify_pretty(&Value::Array(list), 2)
}

/// JS `Number(text)` (StringToNumber): blanks trimmed, "" is 0, decimal, 0x / 0o / 0b integers, Infinity; else NaN.
pub fn js_to_number(text: &str) -> f64 {
    let t = js_trim(text);
    if t.is_empty() {
        return 0.0;
    }
    let radix = |digits: &str, r: u32| -> f64 {
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(r)) {
            return f64::NAN;
        }
        match u128::from_str_radix(digits, r) {
            Ok(v) => v as f64,
            Err(_) => digits.chars().fold(0.0, |acc, c| acc * f64::from(r) + f64::from(c.to_digit(r).unwrap_or(0))),
        }
    };
    let lower2 = t.get(..2).map(str::to_ascii_lowercase);
    match lower2.as_deref() {
        Some("0x") => return radix(&t[2..], 16),
        Some("0o") => return radix(&t[2..], 8),
        Some("0b") => return radix(&t[2..], 2),
        _ => {}
    }
    match t {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if numeric_text(t) { t.parse().unwrap_or(f64::NAN) } else { f64::NAN }
}

// ── JSON.parse ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/// `JSON.parse(text)` succeeds (any nesting depth).
pub fn json_valid(text: &str) -> bool {
    Parser { b: text.as_bytes(), i: 0, build: false, depth_limit: usize::MAX }.run().is_some()
}

/// `JSON.parse(text)` as a value: object keys in JS order, a repeated key keeps its first place with the last value, numbers
/// as doubles (one that overflows to Infinity is null, as JSON.stringify writes it), an unpaired escaped surrogate as U+FFFD.
/// None when the text is not JSON or nests deeper than `depth_limit`.
pub fn parse_json(text: &str, depth_limit: usize) -> Option<Value> {
    Parser { b: text.as_bytes(), i: 0, build: true, depth_limit }.run()
}

enum Frame {
    Array(Vec<Value>),
    Object(Map<String, Value>, String),
}

struct Parser<'a> {
    b: &'a [u8],
    i: usize,
    build: bool,
    depth_limit: usize,
}

impl Parser<'_> {
    fn ws(&mut self) {
        while self.i < self.b.len() && matches!(self.b[self.i], b' ' | b'\t' | b'\n' | b'\r') {
            self.i += 1;
        }
    }

    fn peek(&self) -> Option<u8> {
        self.b.get(self.i).copied()
    }

    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn hex4(&mut self) -> Option<u16> {
        let h = self.b.get(self.i..self.i + 4)?;
        let s = std::str::from_utf8(h).ok()?;
        if !s.bytes().all(|c| c.is_ascii_hexdigit()) {
            return None;
        }
        self.i += 4;
        u16::from_str_radix(s, 16).ok()
    }

    fn string(&mut self) -> Option<String> {
        // at the opening quote
        self.i += 1;
        let mut units: Vec<u16> = Vec::new();
        let mut out = String::new();
        loop {
            let c = self.peek()?;
            match c {
                b'"' => {
                    self.i += 1;
                    if !units.is_empty() {
                        out.push_str(&String::from_utf16_lossy(&units));
                    }
                    return Some(out);
                }
                b'\\' => {
                    self.i += 1;
                    let e = self.peek()?;
                    self.i += 1;
                    let unit = match e {
                        b'"' => u16::from(b'"'),
                        b'\\' => u16::from(b'\\'),
                        b'/' => u16::from(b'/'),
                        b'b' => 0x08,
                        b'f' => 0x0c,
                        b'n' => 0x0a,
                        b'r' => 0x0d,
                        b't' => 0x09,
                        b'u' => self.hex4()?,
                        _ => return None,
                    };
                    units.push(unit);
                }
                0x00..=0x1f => return None,
                _ => {
                    if !units.is_empty() {
                        out.push_str(&String::from_utf16_lossy(&units));
                        units.clear();
                    }
                    // A whole UTF-8 character (the input is a &str).
                    let rest = std::str::from_utf8(&self.b[self.i..]).ok()?;
                    let ch = rest.chars().next()?;
                    out.push(ch);
                    self.i += ch.len_utf8();
                }
            }
        }
    }

    fn number(&mut self) -> Option<f64> {
        let start = self.i;
        self.eat(b'-');
        match self.peek()? {
            b'0' => self.i += 1,
            b'1'..=b'9' => {
                while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                    self.i += 1;
                }
            }
            _ => return None,
        }
        if self.eat(b'.') {
            let s = self.i;
            while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                self.i += 1;
            }
            if self.i == s {
                return None;
            }
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.i += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.i += 1;
            }
            let s = self.i;
            while self.peek().is_some_and(|c| c.is_ascii_digit()) {
                self.i += 1;
            }
            if self.i == s {
                return None;
            }
        }
        std::str::from_utf8(&self.b[start..self.i]).ok()?.parse().ok()
    }

    fn literal(&mut self, word: &str) -> bool {
        if self.b[self.i..].starts_with(word.as_bytes()) {
            self.i += word.len();
            true
        } else {
            false
        }
    }

    /// One scalar, or None after opening a container (pushed on the stack).
    fn value(&mut self, stack: &mut Vec<Frame>, depth: &mut usize) -> Option<Option<Value>> {
        self.ws();
        let v = match self.peek()? {
            b'{' | b'[' => {
                let open = self.peek()?;
                self.i += 1;
                *depth += 1;
                if *depth > self.depth_limit {
                    return None;
                }
                stack.push(if open == b'{' { Frame::Object(Map::new(), String::new()) } else { Frame::Array(Vec::new()) });
                return Some(None);
            }
            b'"' => Value::String(self.string()?),
            b't' if self.literal("true") => Value::Bool(true),
            b'f' if self.literal("false") => Value::Bool(false),
            b'n' if self.literal("null") => Value::Null,
            b'-' | b'0'..=b'9' => number(self.number()?),
            _ => return None,
        };
        Some(Some(if self.build { v } else { Value::Null }))
    }

    fn run(mut self) -> Option<Value> {
        let mut stack: Vec<Frame> = Vec::new();
        let mut depth = 0usize;
        // `pending`: a finished value to put into the container on top (or the result when the stack is empty).
        let mut pending = self.value(&mut stack, &mut depth)?;
        loop {
            // A container just opened: it may be empty, else read its first entry.
            if pending.is_none() {
                self.ws();
                match stack.last_mut()? {
                    Frame::Array(_) => {
                        if self.eat(b']') {
                            let Some(Frame::Array(items)) = stack.pop() else { return None };
                            depth -= 1;
                            pending = Some(Value::Array(items));
                        } else {
                            pending = self.value(&mut stack, &mut depth)?;
                        }
                    }
                    Frame::Object(_, key) => {
                        if self.eat(b'}') {
                            let Some(Frame::Object(map, _)) = stack.pop() else { return None };
                            depth -= 1;
                            pending = Some(Value::Object(map));
                        } else {
                            if self.peek()? != b'"' {
                                return None;
                            }
                            *key = self.string()?;
                            self.ws();
                            if !self.eat(b':') {
                                return None;
                            }
                            pending = self.value(&mut stack, &mut depth)?;
                        }
                    }
                }
                continue;
            }
            let v = pending.take()?;
            let Some(top) = stack.last_mut() else {
                self.ws();
                if self.i != self.b.len() {
                    return None;
                }
                if !self.build {
                    return Some(Value::Null);
                }
                let mut v = v;
                js_json::order_like_js(&mut v);
                return Some(v);
            };
            match top {
                Frame::Array(items) => {
                    if self.build {
                        items.push(v);
                    }
                    self.ws();
                    if self.eat(b',') {
                        pending = self.value(&mut stack, &mut depth)?;
                    } else if self.eat(b']') {
                        let Some(Frame::Array(items)) = stack.pop() else { return None };
                        depth -= 1;
                        pending = Some(Value::Array(items));
                    } else {
                        return None;
                    }
                }
                Frame::Object(map, key) => {
                    if self.build {
                        map.insert(std::mem::take(key), v);
                    }
                    self.ws();
                    if self.eat(b',') {
                        self.ws();
                        if self.peek()? != b'"' {
                            return None;
                        }
                        *key = self.string()?;
                        self.ws();
                        if !self.eat(b':') {
                            return None;
                        }
                        pending = self.value(&mut stack, &mut depth)?;
                    } else if self.eat(b'}') {
                        let Some(Frame::Object(map, _)) = stack.pop() else { return None };
                        depth -= 1;
                        pending = Some(Value::Object(map));
                    } else {
                        return None;
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn inputs() {
        assert_eq!(parse_db_input(ValueKind::Int, " +42 ", false, None), Ok(Some("42".into())));
        assert!(parse_db_input(ValueKind::Int, "2147483648", false, None).is_err());
        assert_eq!(parse_db_input(ValueKind::Bigint, "9223372036854775807", false, None), Ok(Some("9223372036854775807".into())));
        assert!(parse_db_input(ValueKind::Bigint, "99999999999999999999999999999999999999999", false, None).is_err());
        assert_eq!(parse_db_input(ValueKind::Bool, "Yes", false, None), Ok(Some("t".into())));
        assert!(parse_db_input(ValueKind::Json, "{a: 1}", false, None).is_err());
        assert!(parse_db_input(ValueKind::Json, " [1e400, \"\\ud800\"] ", false, None).is_ok());
        assert!(parse_db_input(ValueKind::Bytea, "\\x0af", false, None).is_err());
        assert!(parse_db_input(ValueKind::Array, "[1:2]={1,2}", false, None).is_ok());
    }

    #[test]
    fn json_like_v8() {
        assert_eq!(parse_json("{\"b\":1,\"2\":2,\"b\":3,\"1\":0}", 10), Some(json!({"1": 0.0, "2": 2.0, "b": 3.0})));
        assert_eq!(parse_json("1e400", 10), Some(Value::Null));
        assert_eq!(parse_json("[01]", 10), None);
        assert_eq!(parse_json("[[[]]]", 2), None);
        assert!(json_valid(&format!("{}{}", "[".repeat(100_000), "]".repeat(100_000))));
        assert_eq!(js_to_number(" 0x1F "), 31.0);
        assert!(js_to_number("1_000").is_nan());
        assert!(js_to_number("inf").is_nan());
        assert_eq!(js_to_number("-.5e1"), -5.0);
    }

    #[test]
    fn exports() {
        let rows = vec![
            vec![json!("9007199254740993"), json!("a,\"b\""), json!("t"), json!("{\"x\":1}")],
            vec![json!("1"), Value::Null, json!("f"), Value::Null],
        ];
        let cols: Vec<String> = ["id", "note", "ok", "doc"].iter().map(|s| s.to_string()).collect();
        assert_eq!(
            rows_to_csv(&cols, &rows, ","),
            "id,note,ok,doc\r\n9007199254740993,\"a,\"\"b\"\"\",t,\"{\"\"x\"\":1}\"\r\n1,,f,\r\n"
        );
        assert_eq!(rows_to_tsv(&[vec![json!("a\tb"), Value::Null, json!("c\r\nd")]]), "a b\t\tc d");
        assert_eq!(format_db_value(&json!("{\"a\":1}"), ValueKind::Json, true).as_deref(), Some("{\n  \"a\": 1\n}"));
    }
}
