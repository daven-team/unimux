//! `splitSql` per dialect, `statementAt` and `errorSpan` (src/shared/dbSql.ts). Offsets are UTF-16 code units.

use super::Dialect;
use super::scan::{
    block_comment_end, index_of, is_ident_char, is_ident_start, is_space, newline_from, starts_with_at, text, units, upper,
    word_ci_at,
};

/// A statement of a script: [start, end) in the text (UTF-16 units), without the separator, surrounding blanks or leading
/// comments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SqlSpan {
    pub start: usize,
    pub end: usize,
    pub text: String,
}

const SEMI: u16 = b';' as u16;
const QUOTE: u16 = b'\'' as u16;
const DQUOTE: u16 = b'"' as u16;
const BACKTICK: u16 = b'`' as u16;
const DOLLAR: u16 = b'$' as u16;
const SLASH: u16 = b'/' as u16;
const STAR: u16 = b'*' as u16;
const DASH: u16 = b'-' as u16;
const BACKSLASH: u16 = b'\\' as u16;

/// The statement collector shared by the three splitters (`mark` / `flush`).
struct Spans<'a> {
    u: &'a [u16],
    out: Vec<SqlSpan>,
    start: Option<usize>,
    end: usize,
}

impl<'a> Spans<'a> {
    fn new(u: &'a [u16]) -> Self {
        Spans { u, out: Vec::new(), start: None, end: 0 }
    }
    fn mark(&mut self, from: usize, to: usize) {
        if self.start.is_none() {
            self.start = Some(from);
        }
        self.end = to;
    }
    fn open(&self) -> bool {
        self.start.is_some()
    }
    fn flush(&mut self) {
        if let Some(s) = self.start.take() {
            self.out.push(SqlSpan { start: s, end: self.end, text: text(&self.u[s..self.end]) });
        }
    }
}

/// `splitSql(text, dialect)`.
pub fn split_sql(sql: &str, dialect: Dialect) -> Vec<SqlSpan> {
    let u = units(sql);
    match dialect {
        Dialect::Postgres => split_postgres(&u),
        Dialect::Mysql => split_mysql(&u),
        Dialect::Sqlite => split_sqlite(&u),
    }
}

/// `^\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$` on `text.slice(i, i + 200)`: the length of the tag.
fn dollar_tag(u: &[u16], i: usize) -> Option<usize> {
    let lim = (i + 200).min(u.len());
    let mut j = i + 1;
    if j < lim && is_ident_start(u[j]) {
        j += 1;
        while j < lim && is_ident_char(u[j]) && u[j] != DOLLAR {
            j += 1;
        }
    }
    (j < lim && u[j] == DOLLAR).then_some(j + 1 - i)
}

/// The Postgres split: semicolons outside of quotes ('...', E'...', "..."), dollar quoting, comments (--, nested slash-star)
/// and BEGIN ATOMIC ... END bodies.
fn split_postgres(u: &[u16]) -> Vec<SqlSpan> {
    let n = u.len();
    let mut s = Spans::new(u);
    let mut i = 0;
    let mut atomic = 0usize;
    let mut case_depth = 0usize;
    let mut prev_word = String::new();
    while i < n {
        let c = u[i];
        let next = u.get(i + 1).copied();
        if c == DASH && next == Some(DASH) {
            i = newline_from(u, i).map_or(n, |nl| nl + 1);
            continue;
        }
        if c == SLASH && next == Some(STAR) {
            let mut depth = 1;
            i += 2;
            while i < n && depth > 0 {
                if u[i] == SLASH && u.get(i + 1) == Some(&STAR) {
                    depth += 1;
                    i += 2;
                } else if u[i] == STAR && u.get(i + 1) == Some(&SLASH) {
                    depth -= 1;
                    i += 2;
                } else {
                    i += 1;
                }
            }
            continue;
        }
        if is_space(c) {
            i += 1;
            continue;
        }
        if c == QUOTE {
            let start = i;
            let escapes =
                i > 0 && (u[i - 1] == u16::from(b'E') || u[i - 1] == u16::from(b'e')) && (i < 2 || !is_ident_char(u[i - 2]));
            i += 1;
            while i < n {
                if escapes && u[i] == BACKSLASH {
                    i += 2;
                    continue;
                }
                if u[i] == QUOTE {
                    if u.get(i + 1) == Some(&QUOTE) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            s.mark(start, i.min(n));
            prev_word.clear();
            continue;
        }
        if c == DQUOTE {
            let start = i;
            i += 1;
            while i < n {
                if u[i] == DQUOTE {
                    if u.get(i + 1) == Some(&DQUOTE) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            s.mark(start, i.min(n));
            prev_word.clear();
            continue;
        }
        if c == DOLLAR
            && (i == 0 || !is_ident_char(u[i - 1]))
            && let Some(len) = dollar_tag(u, i)
        {
            let tag = &u[i..i + len];
            let end = index_of(u, tag, i + len).map_or(n, |close| close + len);
            s.mark(i, end);
            i = end;
            prev_word.clear();
            continue;
        }
        if c == SEMI && atomic == 0 {
            s.flush();
            atomic = 0;
            case_depth = 0;
            prev_word.clear();
            i += 1;
            continue;
        }
        if is_ident_start(c) {
            let start = i;
            while i < n && is_ident_char(u[i]) {
                i += 1;
            }
            let word = upper(&u[start..i]);
            s.mark(start, i);
            if word == "ATOMIC" && prev_word == "BEGIN" {
                atomic += 1;
            } else if atomic > 0 && word == "CASE" {
                case_depth += 1;
            } else if atomic > 0 && word == "END" {
                if case_depth > 0 {
                    case_depth -= 1;
                } else {
                    atomic -= 1;
                }
            }
            prev_word = word;
            continue;
        }
        s.mark(i, i + 1);
        prev_word.clear();
        i += 1;
    }
    s.flush();
    s.out
}

/// `/^\s*([A-Za-z_]+)/.exec(text.slice(from, from + 64))?.[1]?.toUpperCase() ?? ''`.
fn next_word(u: &[u16], from: usize) -> String {
    let lim = (from + 64).min(u.len());
    let mut i = from.min(lim);
    while i < lim && is_space(u[i]) {
        i += 1;
    }
    let start = i;
    while i < lim && (super::scan::is_ascii_letter(u[i]) || u[i] == u16::from(b'_')) {
        i += 1;
    }
    upper(&u[start..i])
}

/// The MySQL / MariaDB split: semicolons outside of quotes (backslash escapes, backticks), comments (-- with a blank after
/// it, #, slash-star; the executable /*! ... */ ones are code), routine bodies and the client's DELIMITER lines.
fn split_mysql(u: &[u16]) -> Vec<SqlSpan> {
    let n = u.len();
    let mut s = Spans::new(u);
    let mut i = 0;
    let mut delimiter: Vec<u16> = vec![SEMI];
    let mut first = String::new();
    let mut routine = false;
    let mut depth = 0usize;
    let mut case_depth = 0usize;
    let mut prev_word = String::new();
    while i < n {
        let c = u[i];
        let next = u.get(i + 1).copied();
        if c == DASH && next == Some(DASH) && (i + 2 >= n || is_space(u[i + 2])) {
            i = newline_from(u, i).map_or(n, |nl| nl + 1);
            continue;
        }
        if c == u16::from(b'#') {
            i = newline_from(u, i).map_or(n, |nl| nl + 1);
            continue;
        }
        if c == SLASH && next == Some(STAR) {
            let end = block_comment_end(u, i).unwrap_or(n);
            if u.get(i + 2) == Some(&u16::from(b'!'))
                || (u.get(i + 2) == Some(&u16::from(b'M')) && u.get(i + 3) == Some(&u16::from(b'!')))
            {
                s.mark(i, end);
            }
            i = end;
            continue;
        }
        if is_space(c) {
            i += 1;
            continue;
        }
        if !s.open() && i + 9 < n && word_ci_at(u, i, "delimiter") && is_space(u[i + 9]) {
            let nl = newline_from(u, i);
            let line_end = nl.unwrap_or(n);
            let line = text(&u[(i + 9).min(line_end)..line_end]);
            let token = unimux_core::utf16::js_trim(&line).split(unimux_core::utf16::is_js_space_char).next().unwrap_or("");
            if !token.is_empty() {
                delimiter = units(token);
            }
            i = nl.map_or(n, |nl| nl + 1);
            continue;
        }
        if c == QUOTE || c == DQUOTE || c == BACKTICK {
            let start = i;
            i += 1;
            while i < n {
                if c != BACKTICK && u[i] == BACKSLASH {
                    i += 2;
                    continue;
                }
                if u[i] == c {
                    if u.get(i + 1) == Some(&c) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            s.mark(start, i.min(n));
            prev_word.clear();
            continue;
        }
        if depth == 0 && starts_with_at(u, i, &delimiter) {
            s.flush();
            first.clear();
            prev_word.clear();
            routine = false;
            depth = 0;
            case_depth = 0;
            i += delimiter.len();
            continue;
        }
        if is_ident_start(c) {
            let start = i;
            let semi = delimiter.as_slice() == [SEMI];
            while i < n && is_ident_char(u[i]) && !(!semi && starts_with_at(u, i, &delimiter)) {
                i += 1;
            }
            let word = upper(&u[start..i]);
            s.mark(start, i);
            if first.is_empty() {
                first = word.clone();
            }
            if first == "CREATE" && matches!(word.as_str(), "PROCEDURE" | "FUNCTION" | "TRIGGER" | "EVENT") {
                routine = true;
            }
            if semi {
                if word == "BEGIN" && (routine || depth > 0 || (first == "BEGIN" && next_word(u, i) == "NOT")) {
                    depth += 1;
                } else if depth > 0 && word == "CASE" && prev_word != "END" {
                    case_depth += 1;
                } else if depth > 0 && word == "END" {
                    let after = next_word(u, i);
                    if matches!(after.as_str(), "IF" | "LOOP" | "WHILE" | "REPEAT") {
                        // END IF / LOOP / WHILE / REPEAT: those blocks are not counted
                    } else if after == "CASE" || case_depth > 0 {
                        case_depth = case_depth.saturating_sub(1);
                    } else {
                        depth -= 1;
                    }
                }
            }
            prev_word = word;
            continue;
        }
        s.mark(i, i + 1);
        prev_word.clear();
        i += 1;
    }
    s.flush();
    s.out
}

/// The SQLite split: semicolons outside of quotes ('...', "...", `...`, [...]), comments (-- and slash-star, not nested)
/// and the BEGIN ... END body of CREATE TRIGGER.
fn split_sqlite(u: &[u16]) -> Vec<SqlSpan> {
    let n = u.len();
    let mut s = Spans::new(u);
    let mut i = 0;
    let mut first = String::new();
    let mut trigger = false;
    let mut depth = 0usize;
    let mut case_depth = 0usize;
    while i < n {
        let c = u[i];
        let next = u.get(i + 1).copied();
        if c == DASH && next == Some(DASH) {
            i = newline_from(u, i).map_or(n, |nl| nl + 1);
            continue;
        }
        if c == SLASH && next == Some(STAR) {
            i = block_comment_end(u, i).unwrap_or(n);
            continue;
        }
        if is_space(c) {
            i += 1;
            continue;
        }
        if c == QUOTE || c == DQUOTE || c == BACKTICK || c == u16::from(b'[') {
            let close = if c == u16::from(b'[') { u16::from(b']') } else { c };
            let start = i;
            i += 1;
            while i < n {
                if u[i] == close {
                    if close != u16::from(b']') && u.get(i + 1) == Some(&close) {
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                i += 1;
            }
            s.mark(start, i.min(n));
            continue;
        }
        if c == SEMI && depth == 0 {
            s.flush();
            first.clear();
            trigger = false;
            depth = 0;
            case_depth = 0;
            i += 1;
            continue;
        }
        if is_ident_start(c) {
            let start = i;
            while i < n && is_ident_char(u[i]) {
                i += 1;
            }
            let word = upper(&u[start..i]);
            s.mark(start, i);
            if first.is_empty() {
                first = word.clone();
            }
            if first == "CREATE" && word == "TRIGGER" {
                trigger = true;
            }
            if trigger && word == "BEGIN" {
                depth += 1;
            } else if depth > 0 && word == "CASE" {
                case_depth += 1;
            } else if depth > 0 && word == "END" {
                if case_depth > 0 {
                    case_depth -= 1;
                } else {
                    depth -= 1;
                }
            }
            continue;
        }
        s.mark(i, i + 1);
        i += 1;
    }
    s.flush();
    s.out
}

/// `statementAt`: the statement whose text (or the separator right after it) contains `offset`; between statements the one
/// before; before the first, the first. None when the script has none.
pub fn statement_at(sql: &str, offset: f64, dialect: Dialect) -> Option<SqlSpan> {
    let spans = split_sql(sql, dialect);
    let mut before: Option<usize> = None;
    for (k, s) in spans.iter().enumerate() {
        if offset >= s.start as f64 && offset <= (s.end + 1) as f64 {
            return Some(s.clone());
        }
        if s.end as f64 <= offset {
            before = Some(k);
        }
    }
    spans.get(before.unwrap_or(0)).cloned()
}

/// `errorSpan`: the text an error position underlines, from the 0-based `at` to the end of the word (or quoted name)
/// starting there (at least one character); at the very end of the text its last character.
pub fn error_span(sql: &str, at: i64) -> (usize, usize) {
    let u = units(sql);
    let len = u.len();
    let mut from = at.clamp(0, len as i64) as usize;
    if from >= len {
        let mut end = len;
        while end > 0 && is_space(u[end - 1]) {
            end -= 1;
        }
        return (end.saturating_sub(1), end.max(1));
    }
    let c = u[from];
    let mut to = from + 1;
    if c == DQUOTE || c == BACKTICK || c == QUOTE || c == u16::from(b'[') {
        let close_char = if c == u16::from(b'[') { u16::from(b']') } else { c };
        to = match index_of(&u, &[close_char], from + 1) {
            Some(close) if close - from <= 200 => close + 1,
            _ => from + 1,
        };
    } else if is_ident_char(c) {
        while to < len && to - from < 200 && is_ident_char(u[to]) {
            to += 1;
        }
    }
    if is_space(c) {
        while from > 0 && is_space(u[from]) {
            from -= 1;
        }
        to = from + 1;
    }
    (from, to)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn texts(sql: &str, d: Dialect) -> Vec<String> {
        split_sql(sql, d).into_iter().map(|s| s.text).collect()
    }

    #[test]
    fn postgres_scripts() {
        assert_eq!(
            texts("SELECT 'a;b'; SELECT \"x;y\" FROM t;SELECT 3", Dialect::Postgres),
            ["SELECT 'a;b'", "SELECT \"x;y\" FROM t", "SELECT 3"]
        );
        assert_eq!(
            texts(
                "CREATE FUNCTION g(x int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN x > 0 THEN 1 ELSE 0 END; SELECT 2; END; SELECT 3",
                Dialect::Postgres
            ),
            [
                "CREATE FUNCTION g(x int) RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN x > 0 THEN 1 ELSE 0 END; SELECT 2; END",
                "SELECT 3"
            ]
        );
        let s = &split_sql("-- heading\n  SELECT 1;\n\n", Dialect::Postgres)[0];
        assert_eq!((s.start, s.end, s.text.as_str()), (13, 21, "SELECT 1"));
        assert_eq!(
            texts("DO $body$ BEGIN PERFORM 1; END $body$; SELECT $1, a$b FROM t", Dialect::Postgres),
            ["DO $body$ BEGIN PERFORM 1; END $body$", "SELECT $1, a$b FROM t"]
        );
    }

    #[test]
    fn mysql_scripts() {
        assert_eq!(
            texts("DELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END$$\nDELIMITER ;\nCALL p();", Dialect::Mysql),
            ["CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END", "CALL p()"]
        );
        assert_eq!(texts("SELECT 5--1; SELECT 2", Dialect::Mysql), ["SELECT 5--1", "SELECT 2"]);
    }

    #[test]
    fn positions() {
        let sql = "SELECT 1;\nSELECT 2;\n\nSELECT 3";
        assert_eq!(statement_at(sql, 9.0, Dialect::Postgres).unwrap().text, "SELECT 1");
        assert_eq!(statement_at(sql, 20.0, Dialect::Postgres).unwrap().text, "SELECT 2");
        assert_eq!(statement_at("-- nothing", 3.0, Dialect::Postgres), None);
        assert_eq!(error_span("SELECT \"my col\" x", 7), (7, 15));
        assert_eq!(error_span("SELECT (", 8), (7, 8));
    }
}
