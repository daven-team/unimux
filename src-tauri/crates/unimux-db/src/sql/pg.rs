//! The Postgres helpers of src/shared/dbSql.ts: the first keyword, code without quotes and comments, which statements
//! return rows, only read or may run on a read-only connection, staged edits, table pages, whole cells and value kinds.

use std::collections::{HashMap, HashSet};

use super::scan::{
    self, block_comment_end, has_any_word, has_words, is_ascii_letter, is_space, newline_from, quoted_end, starts_with_words,
    units,
};
use super::{
    DbSqlError, Dialect, EditOp, Fields, PageSqlInput, Sort, SqlResult, StagedEdit, ValueKind, field, limits, qualified_name,
    quote_ident, quote_literal, string_or_null,
};

/// `firstKeyword`: the first keyword of a statement (upper case), skipping blanks, comments and opening parentheses:
/// `/^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/|\()*([A-Za-z]+)/`, with the regex's backtracking (a block comment may end at
/// a later `*/` when the first ending leads nowhere).
pub fn first_keyword(sql: &str) -> String {
    let u = units(sql);
    first_keyword_units(&u).map(|(s, e)| scan::text(&u[s..e]).to_ascii_uppercase()).unwrap_or_default()
}

pub(crate) fn first_keyword_units(u: &[u16]) -> Option<(usize, usize)> {
    // solve(p): the start of the letters the regex captures when its star loop is at p, in V8's backtracking order. It only
    // depends on positions after p, so one pass from the end works it out for every p (linear time, 4 bytes per unit):
    // - a letter: no alternative fits, so the letters from p;
    // - \s+: every shorter run reaches the end of the run anyway, so solve(p + 1); `(`: solve(p + 1) too;
    // - --...: the position after the next newline (none: the end, which never solves);
    // - /*...*/ (lazy): the first `*/` from p + 2 whose following position solves (`reach`, kept for 3 positions);
    // - anything else: no match.
    const NONE: u32 = u32::MAX;
    let n = u.len();
    let mut solve: Vec<u32> = vec![NONE; n + 1];
    // reach[k] for i = p + 1 + k: the answer behind the first `*/` at or after i that leads to one.
    let mut reach = [NONE; 3];
    let mut next_newline: Option<usize> = None;
    let (slash, star, dash, open, newline) =
        (u16::from(b'/'), u16::from(b'*'), u16::from(b'-'), u16::from(b'('), u16::from(b'\n'));
    for p in (0..n).rev() {
        let c = u[p];
        if c == newline {
            next_newline = Some(p);
        }
        let answer = if is_ascii_letter(c) {
            u32::try_from(p).unwrap_or(NONE)
        } else if is_space(c) || c == open {
            solve[p + 1]
        } else if c == dash && u.get(p + 1) == Some(&dash) {
            next_newline.map_or(NONE, |nl| solve[nl + 1])
        } else if c == slash && u.get(p + 1) == Some(&star) {
            reach[1]
        } else {
            NONE
        };
        solve[p] = answer;
        let here = if c == star && u.get(p + 1) == Some(&slash) && solve[p + 2] != NONE { solve[p + 2] } else { reach[0] };
        reach = [here, reach[0], reach[1]];
    }
    if solve[0] == NONE {
        return None;
    }
    let s = usize::try_from(solve[0]).ok()?;
    let mut e = s;
    while e < n && is_ascii_letter(u[e]) {
        e += 1;
    }
    Some((s, e))
}

/// `codeOnly`: the text with quotes, comments and dollar-quoted bodies each replaced by one blank (for keyword checks).
pub fn code_only(sql: &str) -> String {
    scan::text(&code_only_units(&units(sql)))
}

/// `/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g` -> ' '.
pub(crate) fn code_only_units(u: &[u16]) -> Vec<u16> {
    let n = u.len();
    let mut out = Vec::with_capacity(n);
    let mut i = 0;
    while i < n {
        let c = u[i];
        let end = if c == u16::from(b'-') && u.get(i + 1) == Some(&u16::from(b'-')) {
            Some(newline_from(u, i).unwrap_or(n))
        } else if c == u16::from(b'/') && u.get(i + 1) == Some(&u16::from(b'*')) {
            block_comment_end(u, i)
        } else if c == u16::from(b'\'') || c == u16::from(b'"') {
            quoted_end(u, i, c, false)
        } else if c == u16::from(b'$') {
            let mut j = i + 1;
            while j < n && (is_ascii_letter(u[j]) || u[j] == u16::from(b'_')) {
                j += 1;
            }
            if j < n && u[j] == u16::from(b'$') {
                let tag = &u[i..=j];
                scan::index_of(u, tag, j + 1).map(|close| close + tag.len())
            } else {
                None
            }
        } else {
            None
        };
        match end {
            Some(e) => {
                out.push(u16::from(b' '));
                i = e;
            }
            None => {
                out.push(c);
                i += 1;
            }
        }
    }
    out
}

const ROW_KEYWORDS: [&str; 9] = ["SELECT", "WITH", "VALUES", "TABLE", "SHOW", "EXPLAIN", "FETCH", "EXECUTE", "CALL"];
const WRITE_WORDS: [&str; 5] = ["INSERT", "UPDATE", "DELETE", "MERGE", "TRUNCATE"];

/// `returnsRows`: read through a cursor, page by page.
pub fn returns_rows(sql: &str) -> bool {
    let kw = first_keyword(sql);
    if ROW_KEYWORDS.contains(&kw.as_str()) {
        return true;
    }
    has_any_word(&code_only_units(&units(sql)), &["RETURNING"])
}

const FOR_LOCKS: [&[&str]; 6] = [
    &["FOR", "UPDATE"],
    &["FOR", "SHARE"],
    &["FOR", "KEY", "SHARE"],
    &["FOR", "NO", "KEY", "UPDATE"],
    &["FOR", "NO", "KEY", "SHARE"],
    &["FOR", "NO", "KEY", "KEY", "SHARE"],
];

/// `isReadStatement`: its cursor may stay open for "load more".
pub fn is_read_statement(sql: &str) -> bool {
    let kw = first_keyword(sql);
    let code = code_only_units(&units(sql));
    match kw.as_str() {
        "SELECT" => !has_any_word(&code, &["INTO"]) && !has_words(&code, &FOR_LOCKS, true),
        "VALUES" | "TABLE" | "SHOW" | "FETCH" => true,
        "EXPLAIN" => !has_any_word(&code, &["ANALYSE", "ANALYZE"]),
        "WITH" => !has_any_word(&code, &WRITE_WORDS) && !has_any_word(&code, &["INTO"]),
        _ => false,
    }
}

const RO_ALLOWED: [&str; 19] = [
    "SELECT",
    "WITH",
    "VALUES",
    "TABLE",
    "SHOW",
    "EXPLAIN",
    "FETCH",
    "MOVE",
    "CLOSE",
    "DECLARE",
    "BEGIN",
    "START",
    "COMMIT",
    "END",
    "ROLLBACK",
    "ABORT",
    "SAVEPOINT",
    "RELEASE",
    "SET",
];

/// `readOnlyAllows`: what a read-only connection may run without the explicit override (one statement of a split script):
/// reads and transaction control; never anything that writes, SET / RESET / DISCARD (except SET TRANSACTION), READ WRITE,
/// set_config, dblink or the read-only settings by name.
pub fn read_only_allows(sql: &str) -> bool {
    let kw = first_keyword(sql);
    if !RO_ALLOWED.contains(&kw.as_str()) {
        return false;
    }
    if kw == "SHOW" {
        return true;
    }
    let code = code_only_units(&units(sql));
    if has_any_word(&code, &["set_config", "transaction_read_only", "default_transaction_read_only"])
        || has_words(&code, &[&["dblink"]], false)
    {
        return false;
    }
    if has_words(&code, &[&["READ", "WRITE"]], true) {
        return false;
    }
    match kw.as_str() {
        "SET" => starts_with_words(&code, &[&["SET", "TRANSACTION"]]),
        "SELECT" => !has_any_word(&code, &["INTO"]),
        "WITH" | "EXPLAIN" | "DECLARE" => !has_any_word(&code, &WRITE_WORDS) && !has_any_word(&code, &["INTO"]),
        _ => true,
    }
}

/// `endsTransaction`: COMMIT, END, ROLLBACK or ABORT.
pub fn ends_transaction(sql: &str) -> bool {
    matches!(first_keyword(sql).as_str(), "COMMIT" | "END" | "ROLLBACK" | "ABORT")
}

/// `DbBuiltStatement`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltStatement {
    pub op: EditOp,
    pub index: usize,
    pub sql: String,
    pub params: Vec<Option<String>>,
}

/// `buildEditStatements`: the parameterized statement of each staged edit, identified by `key_columns`. `columns`: the
/// table's columns (another name, or one of `read_only_columns`, is refused). `column_types`: each column's format_type,
/// for the conflict check of `original`.
pub fn build_edit_statements(
    schema: &str,
    table: &str,
    key_columns: Option<&[String]>,
    edits: &[StagedEdit],
    columns: Option<&[String]>,
    read_only_columns: &[String],
    column_types: Option<&HashMap<String, String>>,
) -> SqlResult<Vec<BuiltStatement>> {
    if edits.is_empty() || edits.len() > limits::EDITS {
        return Err(DbSqlError::Invalid);
    }
    let target = qualified_name(schema, table, Dialect::Postgres)?;
    let known: Option<HashSet<&str>> = columns.map(|c| c.iter().map(String::as_str).collect());
    let fixed: HashSet<&str> = read_only_columns.iter().map(String::as_str).collect();
    let check_column = |c: &str| -> SqlResult<()> {
        if known.as_ref().is_some_and(|k| !k.contains(c)) || c.is_empty() { Err(DbSqlError::Invalid) } else { Ok(()) }
    };
    let writable = |c: &str| -> SqlResult<()> {
        check_column(c)?;
        if fixed.contains(c) { Err(DbSqlError::Invalid) } else { Ok(()) }
    };
    let ident = |c: &str| quote_ident(c, Dialect::Postgres);
    let where_ = |key: &Fields, params: &mut Vec<Option<String>>| -> SqlResult<String> {
        let kc = match key_columns {
            Some(k) if !k.is_empty() => k,
            _ => return Err(DbSqlError::NoKey),
        };
        if key.len() != kc.len() || !kc.iter().all(|k| field(key, k).is_some()) {
            return Err(DbSqlError::Invalid);
        }
        let mut parts = Vec::with_capacity(kc.len());
        for k in kc {
            let Some(serde_json::Value::String(v)) = field(key, k) else { return Err(DbSqlError::Invalid) };
            params.push(Some(v.clone()));
            parts.push(format!("{} = ${}", ident(k)?, params.len()));
        }
        Ok(parts.join(" AND "))
    };
    let unchanged = |original: &Option<Fields>, params: &mut Vec<Option<String>>| -> SqlResult<String> {
        let Some(original) = original else { return Ok(String::new()) };
        let mut out = String::new();
        for (c, v) in original {
            check_column(c)?;
            let v = string_or_null(v)?;
            let col = ident(c)?;
            let Some(v) = v else {
                out.push_str(&format!(" AND {col} IS NULL"));
                continue;
            };
            params.push(Some(v.to_owned()));
            let p = format!("${}", params.len());
            let ty = column_types.and_then(|t| t.get(c.as_str())).map(String::as_str);
            if matches!(ty, Some("json" | "jsonb")) {
                out.push_str(&format!(" AND {col}::jsonb = {p}::jsonb"));
            } else {
                let right = match ty {
                    Some(t) if !t.is_empty() => format!("format('%s', {p}::{t})"),
                    _ => format!("{p}::text"),
                };
                out.push_str(&format!(" AND ({col} IS NOT NULL AND format('%s', {col}) = {right})"));
            }
        }
        Ok(out)
    };
    let mut built = Vec::with_capacity(edits.len());
    for (index, e) in edits.iter().enumerate() {
        let mut params: Vec<Option<String>> = Vec::new();
        let (op, sql) = match e {
            StagedEdit::Update { key, set, original } => {
                if set.is_empty() {
                    return Err(DbSqlError::Invalid);
                }
                let mut sets = Vec::with_capacity(set.len());
                for (c, v) in set {
                    writable(c)?;
                    params.push(string_or_null(v)?.map(str::to_owned));
                    sets.push(format!("{} = ${}", ident(c)?, params.len()));
                }
                for (k, _) in key {
                    check_column(k)?;
                }
                let w = where_(key, &mut params)?;
                let u = unchanged(original, &mut params)?;
                (EditOp::Update, format!("UPDATE {target} SET {} WHERE {w}{u}", sets.join(", ")))
            }
            StagedEdit::Delete { key, original } => {
                for (k, _) in key {
                    check_column(k)?;
                }
                let w = where_(key, &mut params)?;
                let u = unchanged(original, &mut params)?;
                (EditOp::Delete, format!("DELETE FROM {target} WHERE {w}{u}"))
            }
            StagedEdit::Insert { values } => {
                if values.is_empty() {
                    (EditOp::Insert, format!("INSERT INTO {target} DEFAULT VALUES"))
                } else {
                    let mut cols = Vec::with_capacity(values.len());
                    for (c, v) in values {
                        writable(c)?;
                        params.push(string_or_null(v)?.map(str::to_owned));
                        cols.push(ident(c)?);
                    }
                    let marks: Vec<String> = (1..=cols.len()).map(|i| format!("${i}")).collect();
                    (EditOp::Insert, format!("INSERT INTO {target} ({}) VALUES ({})", cols.join(", "), marks.join(", ")))
                }
            }
        };
        built.push(BuiltStatement { op, index, sql, params });
    }
    Ok(built)
}

/// `inlineParams`: one statement with its parameters written in as literals (display only).
pub fn inline_params(sql: &str, params: &[Option<String>]) -> String {
    let b = sql.as_bytes();
    let mut out = String::with_capacity(sql.len());
    let mut copied = 0;
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'$' && i + 1 < b.len() && b[i + 1].is_ascii_digit() {
            let mut e = i + 1;
            while e < b.len() && b[e].is_ascii_digit() {
                e += 1;
            }
            // Number(d) - 1 as an index (a huge number is simply out of range).
            let index = sql[i + 1..e]
                .trim_start_matches('0')
                .parse::<usize>()
                .ok()
                .or_else(|| if sql[i + 1..e].bytes().all(|c| c == b'0') { Some(0) } else { None });
            if let Some(k) = index
                && k >= 1
                && k <= params.len()
            {
                out.push_str(&sql[copied..i]);
                out.push_str(&quote_literal(params[k - 1].as_deref()));
                copied = e;
            }
            i = e;
            continue;
        }
        i += 1;
    }
    out.push_str(&sql[copied..]);
    out
}

/// `editPreview`: "BEGIN; ...; COMMIT;" as the save runs it.
pub fn edit_preview(statements: &[BuiltStatement]) -> String {
    let mut lines = vec!["BEGIN;".to_owned()];
    lines.extend(statements.iter().map(|s| format!("{};", inline_params(&s.sql, &s.params))));
    lines.push("COMMIT;".into());
    lines.join("\n")
}

/// The page SQL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PageSql {
    pub sql: String,
    pub params: Vec<String>,
    pub keyset: bool,
}

/// `Math.floor(limit)` checked like the TS code: finite, 1..=rowCapMax.
pub(crate) fn page_limit(limit: f64) -> SqlResult<u64> {
    let limit = limit.floor();
    if !limit.is_finite() || limit < 1.0 || limit > limits::ROW_CAP_MAX as f64 {
        Err(DbSqlError::Invalid)
    } else {
        Ok(limit as u64)
    }
}

/// `Math.floor(input.offset ?? 0)` when it is above 0, as JS prints it.
pub(crate) fn page_offset(offset: Option<f64>) -> Option<String> {
    let o = offset.unwrap_or(0.0).floor();
    (o > 0.0).then(|| js_number(o))
}

/// JS `String(n)` of a number.
pub(crate) fn js_number(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    let mut buf = ryu_js::Buffer::new();
    buf.format(n).to_owned()
}

/// The order of a page: the user's sort, then the key as a tiebreaker in the direction of the last sorted column.
pub(crate) fn order_columns(sort: &[Sort], key: Option<&[String]>) -> Vec<Sort> {
    let mut order: Vec<Sort> = sort.to_vec();
    if let Some(key) = key {
        let dir = sort.last().is_some_and(|s| s.desc);
        for k in key {
            if !order.iter().any(|s| &s.column == k) {
                order.push(Sort { column: k.clone(), desc: dir });
            }
        }
    }
    order
}

/// The trimmed filter on lines of its own, checked (UTF-16 length, no NUL).
pub(crate) fn page_filter(filter: Option<&str>) -> SqlResult<Option<String>> {
    let Some(f) = filter.map(unimux_core::utf16::js_trim).filter(|f| !f.is_empty()) else { return Ok(None) };
    if unimux_core::utf16::len(f) > limits::FILTER || f.contains('\0') {
        return Err(DbSqlError::Invalid);
    }
    Ok(Some(format!("(\n{f}\n)")))
}

/// `pageSql`: the SELECT of one table page (limit + 1 rows), ordered by the sort with the key as a tiebreaker, keyset paging
/// (`after`) when the order is the key alone.
pub fn page_sql(input: &PageSqlInput, key_columns: Option<&[String]>) -> SqlResult<PageSql> {
    let limit = page_limit(input.limit)?;
    let sort = input.sort.as_deref().unwrap_or(&[]);
    if sort.len() > limits::SORT_COLUMNS {
        return Err(DbSqlError::Invalid);
    }
    let key = key_columns.filter(|k| !k.is_empty());
    let order = order_columns(sort, key);
    let by_key_only = key.is_some_and(|key| {
        order.len() == key.len() && order.iter().enumerate().all(|(i, s)| s.column == key[i] && s.desc == order[0].desc)
    });
    let mut params = Vec::new();
    let mut conditions = Vec::new();
    if let Some(f) = page_filter(input.filter.as_deref())? {
        conditions.push(f);
    }
    let mut keyset = false;
    if let Some(after) = input.after.as_ref().filter(|a| !a.is_empty()) {
        let Some(key) = key.filter(|k| by_key_only && after.len() == k.len()) else { return Err(DbSqlError::Invalid) };
        params.extend(after.iter().cloned());
        let op = if order[0].desc { '<' } else { '>' };
        let names = key.iter().map(|k| quote_ident(k, Dialect::Postgres)).collect::<SqlResult<Vec<_>>>()?;
        let marks: Vec<String> = (1..=key.len()).map(|i| format!("${i}")).collect();
        conditions.push(format!("({}) {op} ({})", names.join(", "), marks.join(", ")));
        keyset = true;
    }
    let mut parts = vec![format!("SELECT * FROM {}", qualified_name(&input.schema, &input.table, Dialect::Postgres)?)];
    if !conditions.is_empty() {
        parts.push(format!("WHERE {}", conditions.join("\nAND ")));
    }
    if !order.is_empty() {
        let cols = order
            .iter()
            .map(|s| {
                Ok(format!(
                    "{} {}",
                    quote_ident(&s.column, Dialect::Postgres)?,
                    if s.desc { "DESC NULLS LAST" } else { "ASC NULLS FIRST" }
                ))
            })
            .collect::<SqlResult<Vec<_>>>()?;
        parts.push(format!("ORDER BY {}", cols.join(", ")));
    }
    parts.push(format!("LIMIT {}", limit + 1));
    if !keyset && let Some(o) = page_offset(input.offset) {
        parts.push(format!("OFFSET {o}"));
    }
    Ok(PageSql { sql: parts.join("\n"), params, keyset })
}

/// The key of a whole-cell read: every key column has a string value and nothing else is named.
pub(crate) fn cell_key<'a>(key: &'a Fields, key_columns: &[String]) -> SqlResult<Vec<&'a str>> {
    if key_columns.is_empty() || key.len() != key_columns.len() {
        return Err(DbSqlError::Invalid);
    }
    key_columns
        .iter()
        .map(|k| match field(key, k) {
            Some(serde_json::Value::String(v)) => Ok(v.as_str()),
            _ => Err(DbSqlError::Invalid),
        })
        .collect()
}

/// `cellSql`: the SELECT of one whole cell by the row's key (cut on the server by left()).
pub fn cell_sql(
    schema: &str,
    table: &str,
    column: &str,
    key: &Fields,
    key_columns: &[String],
) -> SqlResult<(String, Vec<String>)> {
    let values = cell_key(key, key_columns)?;
    let conds = key_columns
        .iter()
        .enumerate()
        .map(|(i, k)| Ok(format!("{} = ${}", quote_ident(k, Dialect::Postgres)?, i + 1)))
        .collect::<SqlResult<Vec<_>>>()?;
    let sql = format!(
        "SELECT left({}::text, {}) FROM {} WHERE {} LIMIT 2",
        quote_ident(column, Dialect::Postgres)?,
        limits::FULL_VALUE_CHARS + 1,
        qualified_name(schema, table, Dialect::Postgres)?,
        conds.join(" AND ")
    );
    Ok((sql, values.into_iter().map(str::to_owned).collect()))
}

/// `valueKind`: the kind of a type from its OID and, for others, pg_type.typcategory.
pub fn value_kind(oid: i64, category: Option<&str>) -> ValueKind {
    use ValueKind::*;
    match oid {
        16 => Bool,
        17 => Bytea,
        18 | 19 | 25 | 142 | 1042 | 1043 | 4072 => Text,
        20 => Bigint,
        21 | 23 | 26 => Int,
        114 | 3802 => Json,
        700 | 701 => Float,
        790 | 1700 => Numeric,
        1082 => Date,
        1083 | 1266 => Time,
        1114 => Timestamp,
        1184 => Timestamptz,
        1186 => Interval,
        2950 => Uuid,
        _ => match category {
            Some("A") => Array,
            Some("E") => Enum,
            Some("B") => Bool,
            Some("S") => Text,
            Some("N") => Numeric,
            _ => Other,
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_keywords() {
        assert_eq!(first_keyword("/* c */ -- d\n (SELECT 1)"), "SELECT");
        assert_eq!(first_keyword("/* a */ 1 */ select"), "SELECT");
        assert_eq!(first_keyword("/* open"), "");
        assert_eq!(first_keyword(&format!("{}x", "(".repeat(100_000))), "X");
        assert_eq!(first_keyword(&format!("{}1", " ".repeat(100_000))), "");
    }

    #[test]
    fn read_only() {
        assert!(read_only_allows("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"));
        assert!(!read_only_allows("SET statement_timeout = 0"));
        assert!(!read_only_allows("SELECT dblink_exec('x')"));
        assert!(read_only_allows("SELECT 'set_config'"));
        assert!(!is_read_statement("SELECT * FROM t FOR NO KEY UPDATE"));
    }

    #[test]
    fn previews() {
        assert_eq!(
            inline_params("a = $1, b = $2, c = $3, d = $01", &[Some("x".into()), None]),
            "a = 'x', b = NULL, c = $3, d = 'x'"
        );
        assert_eq!(js_number(1e21), "1e+21");
    }
}
