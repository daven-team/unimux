//! The SQLite helpers of src/shared/dbSqlite.ts: type affinity and value kinds, bound parameters in the column's type, what a
//! read-only connection may run (reads, the PRAGMAs that only read, transaction control), table pages, whole cells, staged
//! edits with their previews and error positions.

use std::collections::HashMap;

use super::pg::{cell_key, first_keyword, js_number, order_columns, page_filter, page_limit, page_offset};
use super::scan::{self, has_any_word, is_word, units};
use super::{
    DbSqlError, Dialect, EditOp, Fields, PageSqlInput, SQLITE_MAIN, SqlResult, StagedEdit, ValueKind, field, limits,
    quote_literal, string_or_null,
};

/// `SqliteAffinity`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Affinity {
    Integer,
    Text,
    Blob,
    Real,
    Numeric,
}

impl Affinity {
    pub fn as_str(self) -> &'static str {
        match self {
            Affinity::Integer => "integer",
            Affinity::Text => "text",
            Affinity::Blob => "blob",
            Affinity::Real => "real",
            Affinity::Numeric => "numeric",
        }
    }

    pub fn parse(s: &str) -> Option<Affinity> {
        [Affinity::Integer, Affinity::Text, Affinity::Blob, Affinity::Real, Affinity::Numeric]
            .into_iter()
            .find(|a| a.as_str() == s)
    }
}

/// `sqliteAffinity`: the affinity of a declared type (https://sqlite.org/datatype3.html#determination_of_column_affinity).
pub fn sqlite_affinity(declared: Option<&str>) -> Affinity {
    let t = declared.unwrap_or("").to_uppercase();
    if t.contains("INT") {
        Affinity::Integer
    } else if t.contains("CHAR") || t.contains("CLOB") || t.contains("TEXT") {
        Affinity::Text
    } else if t.contains("BLOB") || unimux_core::utf16::js_trim(&t).is_empty() {
        Affinity::Blob
    } else if t.contains("REAL") || t.contains("FLOA") || t.contains("DOUB") {
        Affinity::Real
    } else {
        Affinity::Numeric
    }
}

/// `sqliteValueKind`: how a column of a declared type is shown and edited (no declared type: other).
pub fn sqlite_value_kind(declared: Option<&str>) -> ValueKind {
    let upper = declared.unwrap_or("").to_uppercase();
    let t = unimux_core::utf16::js_trim(&upper);
    if t.is_empty() {
        return ValueKind::Other;
    }
    if t.starts_with("BOOL") {
        return ValueKind::Int;
    }
    if t.contains("JSON") {
        return ValueKind::Json;
    }
    if t.contains("UUID") || t.contains("GUID") {
        return ValueKind::Text;
    }
    match sqlite_affinity(Some(t)) {
        Affinity::Integer => ValueKind::Bigint,
        Affinity::Real => ValueKind::Float,
        Affinity::Blob => ValueKind::Bytea,
        Affinity::Text => ValueKind::Text,
        Affinity::Numeric => {
            if t.contains("DEC") || t.contains("NUM") {
                ValueKind::Numeric
            } else {
                ValueKind::Text
            }
        }
    }
}

/// `SqliteParam`: a bound value.
#[derive(Debug, Clone, PartialEq)]
pub enum SqliteParam {
    Null,
    Integer(i64),
    Real(f64),
    Blob(Vec<u8>),
    Text(String),
}

/// `/^\\x((?:[0-9a-f]{2})*)$/i` -> the bytes.
fn hex_bytes(v: &str) -> Option<Vec<u8>> {
    let h = super::mysql::hex_value(v)?;
    Some((0..h.len() / 2).map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap_or(0)).collect())
}

/// `/^[+-]?\d{1,19}$/` and inside int64: the integer.
fn int64(v: &str) -> Option<i64> {
    let b = v.as_bytes();
    let digits = match b.first() {
        Some(b'+' | b'-') => &b[1..],
        _ => b,
    };
    if digits.is_empty() || digits.len() > 19 || !digits.iter().all(u8::is_ascii_digit) {
        return None;
    }
    let n: i128 = v.trim_start_matches('+').parse().ok()?;
    i64::try_from(n).ok()
}

/// `/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$|^[+-]?Infinity$/`.
fn real_text(v: &str) -> bool {
    let b = v.as_bytes();
    let mut i = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    if &b[i..] == b"Infinity" {
        return true;
    }
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

/// JS `Number(text)` of a text `real_text` accepted (after trimming): a decimal or an infinity.
fn real_number(v: &str) -> f64 {
    let t = unimux_core::utf16::js_trim(v);
    let unsigned = t.trim_start_matches(['+', '-']);
    if unsigned == "Infinity" {
        return if t.starts_with('-') { f64::NEG_INFINITY } else { f64::INFINITY };
    }
    t.parse().unwrap_or(f64::NAN)
}

/// `sqliteParam`: a value (text form) as the parameter its column reads it as.
pub fn sqlite_param(value: Option<&str>, affinity: Affinity) -> SqliteParam {
    let Some(v) = value else { return SqliteParam::Null };
    if affinity == Affinity::Integer
        && let Some(n) = int64(v)
    {
        return SqliteParam::Integer(n);
    }
    if affinity == Affinity::Real && real_text(unimux_core::utf16::js_trim(v)) {
        return SqliteParam::Real(real_number(v));
    }
    if affinity == Affinity::Blob
        && let Some(bytes) = hex_bytes(v)
    {
        return SqliteParam::Blob(bytes);
    }
    SqliteParam::Text(v.to_owned())
}

/// `storedForms`: the ways a loaded text may have been stored in a column of this affinity.
fn stored_forms(value: &str, affinity: Affinity) -> Vec<SqliteParam> {
    if affinity != Affinity::Blob {
        return vec![sqlite_param(Some(value), affinity)];
    }
    let mut forms = vec![SqliteParam::Text(value.to_owned())];
    if let Some(bytes) = hex_bytes(value) {
        forms.push(SqliteParam::Blob(bytes));
    }
    if let Some(n) = int64(value) {
        forms.push(SqliteParam::Integer(n));
    } else if real_text(value) {
        forms.push(SqliteParam::Real(real_number(value)));
    }
    forms
}

/// `sqIdent`.
pub fn sq_ident(name: &str) -> SqlResult<String> {
    super::quote_ident(name, Dialect::Sqlite)
}

/// `sqQualified`: "main"."orders" (SQLite connections show the main database only).
pub fn sq_qualified(schema: &str, name: &str) -> SqlResult<String> {
    if schema != SQLITE_MAIN {
        return Err(DbSqlError::Invalid);
    }
    Ok(format!("{}.{}", sq_ident(schema)?, sq_ident(name)?))
}

/// `sqliteCodeOnly`: quotes and comments blanked (every unit but newlines), so every offset stays:
/// `/--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]/g`.
pub fn sqlite_code_only(sql: &str) -> String {
    scan::text(&code_only_units(&units(sql)))
}

fn code_only_units(u: &[u16]) -> Vec<u16> {
    let n = u.len();
    let mut out = u.to_vec();
    let mut i = 0;
    while i < n {
        let c = u[i];
        let end = if c == u16::from(b'-') && u.get(i + 1) == Some(&u16::from(b'-')) {
            Some(scan::newline_from(u, i).unwrap_or(n))
        } else if c == u16::from(b'/') && u.get(i + 1) == Some(&u16::from(b'*')) {
            Some(scan::block_comment_end(u, i).unwrap_or(n))
        } else if c == u16::from(b'\'') || c == u16::from(b'"') || c == u16::from(b'`') {
            scan::quoted_end(u, i, c, false)
        } else if c == u16::from(b'[') {
            (i + 1..n).find(|&k| u[k] == u16::from(b']')).map(|k| k + 1)
        } else {
            None
        };
        match end {
            Some(e) => {
                for x in &mut out[i..e] {
                    if *x != u16::from(b'\n') {
                        *x = u16::from(b' ');
                    }
                }
                i = e;
            }
            None => i += 1,
        }
    }
    out
}

const WRITE_WORDS: [&str; 13] = [
    "INSERT", "UPDATE", "DELETE", "REPLACE", "UPSERT", "CREATE", "DROP", "ALTER", "ATTACH", "DETACH", "VACUUM", "REINDEX",
    "ANALYZE",
];
const READ_PRAGMAS: [&str; 35] = [
    "table_info",
    "table_xinfo",
    "table_list",
    "index_list",
    "index_info",
    "index_xinfo",
    "foreign_key_list",
    "foreign_key_check",
    "integrity_check",
    "quick_check",
    "database_list",
    "collation_list",
    "function_list",
    "module_list",
    "pragma_list",
    "compile_options",
    "page_count",
    "page_size",
    "freelist_count",
    "encoding",
    "user_version",
    "application_id",
    "schema_version",
    "data_version",
    "journal_mode",
    "foreign_keys",
    "auto_vacuum",
    "cache_size",
    "busy_timeout",
    "synchronous",
    "temp_store",
    "max_page_count",
    "recursive_triggers",
    "case_sensitive_like",
    "stats",
];
const ARG_READ_PRAGMAS: [&str; 10] = [
    "table_info",
    "table_xinfo",
    "table_list",
    "index_list",
    "index_info",
    "index_xinfo",
    "foreign_key_list",
    "foreign_key_check",
    "integrity_check",
    "quick_check",
];
const RO_ALLOWED: [&str; 11] =
    ["SELECT", "WITH", "VALUES", "EXPLAIN", "PRAGMA", "BEGIN", "COMMIT", "END", "ROLLBACK", "SAVEPOINT", "RELEASE"];

/// `[A-Za-z_]\w*` from `at`: its end.
fn name_end(u: &[u16], at: usize) -> Option<usize> {
    if at < u.len() && (scan::is_ascii_letter(u[at]) || u[at] == u16::from(b'_')) {
        let mut e = at + 1;
        while e < u.len() && is_word(u[e]) {
            e += 1;
        }
        Some(e)
    } else {
        None
    }
}

/// `/^\s*PRAGMA\s+(?:[A-Za-z_]\w*\s*\.\s*)?([A-Za-z_]\w*)\s*(=|\()?/i` on the code: the name and what follows it.
fn pragma(code: &[u16]) -> Option<(String, Option<u16>)> {
    let i = scan::skip_spaces(code, 0);
    if !scan::word_ci_at(code, i, "PRAGMA") {
        return None;
    }
    let j = scan::skip_spaces(code, i + 6);
    if j == i + 6 {
        return None;
    }
    // The optional schema (a name, blanks, a dot, blanks) counts only when a name follows it; otherwise the regex
    // backtracks and reads the first name as the PRAGMA's.
    let mut start = j;
    if let Some(e) = name_end(code, j) {
        let d = scan::skip_spaces(code, e);
        if d < code.len() && code[d] == u16::from(b'.') {
            let after_dot = scan::skip_spaces(code, d + 1);
            if name_end(code, after_dot).is_some() {
                start = after_dot;
            }
        }
    }
    let end = name_end(code, start)?;
    let after = scan::skip_spaces(code, end);
    let op = code.get(after).copied().filter(|&c| c == u16::from(b'=') || c == u16::from(b'('));
    Some((scan::text(&code[start..end]).to_ascii_lowercase(), op))
}

/// `sqliteReadOnlyAllows`: reads, the PRAGMAs that only read (queried, never set) and transaction control.
pub fn sqlite_read_only_allows(sql: &str) -> bool {
    let kw = first_keyword(sql);
    if !RO_ALLOWED.contains(&kw.as_str()) {
        return false;
    }
    let code = code_only_units(&units(sql));
    if kw == "PRAGMA" {
        let Some((name, op)) = pragma(&code) else { return false };
        return match op {
            Some(c) if c == u16::from(b'=') => false,
            Some(_) => ARG_READ_PRAGMAS.contains(&name.as_str()),
            None => READ_PRAGMAS.contains(&name.as_str()),
        };
    }
    if matches!(kw.as_str(), "SELECT" | "WITH" | "VALUES" | "EXPLAIN") {
        return !has_any_word(&code, &WRITE_WORDS);
    }
    true
}

/// `sqliteIsReadStatement`: its cursor may stay open for "load more".
pub fn sqlite_is_read_statement(sql: &str) -> bool {
    let kw = first_keyword(sql);
    if !matches!(kw.as_str(), "SELECT" | "WITH" | "VALUES" | "EXPLAIN") {
        return false;
    }
    let code = code_only_units(&units(sql));
    !has_any_word(&code, &WRITE_WORDS) && !has_any_word(&code, &["RETURNING"])
}

/// `sqliteEndsTransaction`.
pub fn sqlite_ends_transaction(sql: &str) -> bool {
    matches!(first_keyword(sql).as_str(), "COMMIT" | "END" | "ROLLBACK")
}

/// `sqliteErrorPosition`: the 1-based position (UTF-16 units) of the token 'near "FRM": syntax error' names (its first
/// place in the code); the end for "incomplete input"; None otherwise.
pub fn sqlite_error_position(message: &str, sql: &str) -> Option<usize> {
    let m = units(message);
    let Some(token) = near_token(&m) else {
        let needle = units("incomplete input");
        return scan::index_of(&m, &needle, 0).map(|_| units(sql).len() + 1);
    };
    if token.is_empty() {
        return None;
    }
    let s = units(sql);
    let code = code_only_units(&s);
    let quoted = matches!(token[0], 0x27 | 0x22 | 0x60 | 0x5b);
    let ident = |c: u16| is_word(c) || c == u16::from(b'$');
    // /(^|[^A-Za-z0-9_$])(token)/g, from lastIndex on.
    let mut last = 0usize;
    while last <= s.len() {
        let mut found: Option<(usize, usize)> = None;
        for i in last..=s.len() {
            if i == 0 && scan::starts_with_at(&s, 0, &token) {
                found = Some((0, token.len()));
                break;
            }
            if i < s.len() && !ident(s[i]) && scan::starts_with_at(&s, i + 1, &token) {
                found = Some((i + 1, i + 1 + token.len()));
                break;
            }
        }
        let (pos, end) = found?;
        if quoted || code[pos..pos + token.len()] == token[..] {
            return Some(pos + 1);
        }
        last = end;
    }
    None
}

/// `/near "((?:[^"]|"")*)": syntax error/.exec(message)` -> the token with "" read as ".
fn near_token(m: &[u16]) -> Option<Vec<u16>> {
    let head = units("near \"");
    let tail = units("\": syntax error");
    let q = u16::from(b'"');
    let mut from = 0;
    while let Some(s) = scan::index_of(m, &head, from) {
        // (?:[^"]|"")* then `": syntax error`, with backtracking over the "" pairs.
        let mut i = s + head.len();
        let mut pairs: Vec<usize> = Vec::new();
        let close = loop {
            if i >= m.len() {
                break None;
            }
            if m[i] == q {
                if m.get(i + 1) == Some(&q) {
                    pairs.push(i);
                    i += 2;
                    continue;
                }
                break Some(i);
            }
            i += 1;
        };
        let ok = |at: usize| scan::starts_with_at(m, at, &tail);
        let end = match close {
            Some(c) if ok(c) => Some(c),
            _ => pairs.iter().rev().copied().find(|&p| ok(p)),
        };
        if let Some(e) = end {
            let raw = &m[s + head.len()..e];
            let mut token = Vec::with_capacity(raw.len());
            let mut k = 0;
            while k < raw.len() {
                token.push(raw[k]);
                k += if raw[k] == q && raw.get(k + 1) == Some(&q) { 2 } else { 1 };
            }
            return Some(token);
        }
        from = s + 1;
    }
    None
}

/// `sqlitePageSql`: the SELECT of one table page (limit + 1 rows), the rowid read first when it keys the table, offset paging.
pub fn sqlite_page_sql(input: &PageSqlInput, key_columns: Option<&[String]>, rowid: Option<&str>) -> SqlResult<String> {
    let limit = page_limit(input.limit)?;
    let sort = input.sort.as_deref().unwrap_or(&[]);
    if sort.len() > limits::SORT_COLUMNS {
        return Err(DbSqlError::Invalid);
    }
    if input.after.as_ref().is_some_and(|a| !a.is_empty()) {
        return Err(DbSqlError::Invalid);
    }
    let order = order_columns(sort, key_columns.filter(|k| !k.is_empty()));
    let rowid = rowid.filter(|r| !r.is_empty());
    let mut parts = vec![format!(
        "SELECT {}* FROM {}",
        rowid.map(|r| format!("{r}, ")).unwrap_or_default(),
        sq_qualified(&input.schema, &input.table)?
    )];
    if let Some(f) = page_filter(input.filter.as_deref())? {
        parts.push(format!("WHERE {f}"));
    }
    let col = |c: &str| -> SqlResult<String> { if rowid == Some(c) { Ok(c.to_owned()) } else { sq_ident(c) } };
    if !order.is_empty() {
        let cols = order
            .iter()
            .map(|s| Ok(format!("{} {}", col(&s.column)?, if s.desc { "DESC NULLS LAST" } else { "ASC NULLS FIRST" })))
            .collect::<SqlResult<Vec<_>>>()?;
        parts.push(format!("ORDER BY {}", cols.join(", ")));
    }
    parts.push(format!("LIMIT {}", limit + 1));
    if let Some(o) = page_offset(input.offset) {
        parts.push(format!("OFFSET {o}"));
    }
    Ok(parts.join("\n"))
}

/// `SqliteColumnMeta`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnMeta {
    pub name: String,
    pub affinity: Affinity,
    pub generated: bool,
}

/// `SqliteBuilt`.
#[derive(Debug, Clone, PartialEq)]
pub struct Built {
    pub sql: String,
    pub params: Vec<SqliteParam>,
}

/// `sqliteCellSql`: the SELECT of one whole cell by the row's key (cut by SQLite).
pub fn sqlite_cell_sql(
    schema: &str,
    table: &str,
    column: &str,
    key: &Fields,
    key_columns: &[String],
    columns: &[ColumnMeta],
    rowid: Option<&str>,
) -> SqlResult<Built> {
    let values = cell_key(key, key_columns)?;
    let rowid = rowid.filter(|r| !r.is_empty());
    let aff = |c: &str| -> Affinity {
        if rowid == Some(c) {
            Affinity::Integer
        } else {
            columns.iter().find(|x| x.name == c).map_or(Affinity::Text, |x| x.affinity)
        }
    };
    let conds = key_columns
        .iter()
        .map(|k| Ok(format!("{} = ?", if rowid == Some(k.as_str()) { k.clone() } else { sq_ident(k)? })))
        .collect::<SqlResult<Vec<_>>>()?;
    let sql = format!(
        "SELECT substr({}, 1, {}) FROM {} WHERE {} LIMIT 2",
        sq_ident(column)?,
        limits::FULL_VALUE_CHARS + 1,
        sq_qualified(schema, table)?,
        conds.join(" AND ")
    );
    Ok(Built { sql, params: key_columns.iter().zip(values).map(|(k, v)| sqlite_param(Some(v), aff(k))).collect() })
}

/// `SqliteBuiltStatement`.
#[derive(Debug, Clone, PartialEq)]
pub struct BuiltStatement {
    pub op: EditOp,
    pub index: usize,
    pub sql: String,
    pub params: Vec<SqliteParam>,
    pub preview: String,
}

/// `previewLiteral`.
pub fn preview_literal(p: &SqliteParam) -> String {
    match p {
        SqliteParam::Null => "NULL".into(),
        SqliteParam::Integer(n) => n.to_string(),
        SqliteParam::Real(f) => js_number(*f),
        SqliteParam::Blob(b) => format!("X'{}'", b.iter().map(|x| format!("{x:02x}")).collect::<String>()),
        SqliteParam::Text(s) => quote_literal(Some(s)),
    }
}

/// `sqliteInline`: one statement with its parameters written in (display only).
pub fn sqlite_inline(sql: &str, params: &[SqliteParam]) -> String {
    let mut out = String::with_capacity(sql.len());
    let mut next = params.iter();
    for ch in sql.chars() {
        if ch == '?' {
            match next.next() {
                Some(p) => out.push_str(&preview_literal(p)),
                None => out.push('?'),
            }
        } else {
            out.push(ch);
        }
    }
    out
}

/// `sqliteEditStatements`: the statements of staged edits on a table, identified by `key_columns` (its primary key, or the
/// rowid); `original` values are checked exactly, in every form an untyped column may have stored them.
pub fn sqlite_edit_statements(
    schema: &str,
    table: &str,
    key_columns: Option<&[String]>,
    edits: &[StagedEdit],
    columns: &[ColumnMeta],
    rowid: Option<&str>,
) -> SqlResult<Vec<BuiltStatement>> {
    if edits.is_empty() || edits.len() > limits::EDITS {
        return Err(DbSqlError::Invalid);
    }
    let target = sq_qualified(schema, table)?;
    let rowid = rowid.filter(|r| !r.is_empty());
    let by_name: HashMap<&str, &ColumnMeta> = columns.iter().map(|c| (c.name.as_str(), c)).collect();
    let rowid_meta = rowid.map(|r| ColumnMeta { name: r.to_owned(), affinity: Affinity::Integer, generated: true });
    let col = |c: &str| -> SqlResult<&ColumnMeta> {
        let m = if rowid == Some(c) { rowid_meta.as_ref() } else { by_name.get(c).copied() };
        match m {
            Some(m) if !c.is_empty() => Ok(m),
            _ => Err(DbSqlError::Invalid),
        }
    };
    let writable = |c: &str| -> SqlResult<&ColumnMeta> {
        let m = col(c)?;
        if m.generated { Err(DbSqlError::Invalid) } else { Ok(m) }
    };
    let ident = |c: &str| -> SqlResult<String> { if rowid == Some(c) { Ok(c.to_owned()) } else { sq_ident(c) } };
    let where_ = |key: &Fields, params: &mut Vec<SqliteParam>| -> SqlResult<String> {
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
            params.push(sqlite_param(Some(v), col(k)?.affinity));
            parts.push(format!("{} = ?", ident(k)?));
        }
        Ok(parts.join(" AND "))
    };
    let unchanged = |original: &Option<Fields>, params: &mut Vec<SqliteParam>| -> SqlResult<String> {
        let Some(original) = original else { return Ok(String::new()) };
        let mut out = String::new();
        for (c, v) in original {
            let m = col(c)?;
            let v = string_or_null(v)?;
            let Some(v) = v else {
                out.push_str(&format!(" AND {} IS NULL", ident(c)?));
                continue;
            };
            let forms = stored_forms(v, m.affinity);
            let id = ident(c)?;
            let alts: Vec<String> = forms.iter().map(|_| format!("{id} IS ?")).collect();
            params.extend(forms);
            out.push_str(&format!(" AND ({})", alts.join(" OR ")));
        }
        Ok(out)
    };
    let built = |op: EditOp, index: usize, sql: String, params: Vec<SqliteParam>| {
        let preview = sqlite_inline(&sql, &params);
        BuiltStatement { op, index, sql, params, preview }
    };
    let mut out = Vec::with_capacity(edits.len());
    for (index, e) in edits.iter().enumerate() {
        let mut params: Vec<SqliteParam> = Vec::new();
        let st = match e {
            StagedEdit::Update { key, set, original } => {
                if set.is_empty() {
                    return Err(DbSqlError::Invalid);
                }
                let mut sets = Vec::with_capacity(set.len());
                for (c, v) in set {
                    let m = writable(c)?;
                    params.push(sqlite_param(string_or_null(v)?, m.affinity));
                    sets.push(format!("{} = ?", sq_ident(c)?));
                }
                for (k, _) in key {
                    col(k)?;
                }
                let w = where_(key, &mut params)?;
                let u = unchanged(original, &mut params)?;
                built(EditOp::Update, index, format!("UPDATE {target} SET {} WHERE {w}{u}", sets.join(", ")), params)
            }
            StagedEdit::Delete { key, original } => {
                for (k, _) in key {
                    col(k)?;
                }
                let w = where_(key, &mut params)?;
                let u = unchanged(original, &mut params)?;
                built(EditOp::Delete, index, format!("DELETE FROM {target} WHERE {w}{u}"), params)
            }
            StagedEdit::Insert { values } => {
                if values.is_empty() {
                    built(EditOp::Insert, index, format!("INSERT INTO {target} DEFAULT VALUES"), params)
                } else {
                    let mut cols = Vec::with_capacity(values.len());
                    for (c, v) in values {
                        let m = writable(c)?;
                        params.push(sqlite_param(string_or_null(v)?, m.affinity));
                        cols.push(sq_ident(c)?);
                    }
                    let marks = vec!["?"; cols.len()].join(", ");
                    built(EditOp::Insert, index, format!("INSERT INTO {target} ({}) VALUES ({marks})", cols.join(", ")), params)
                }
            }
        };
        out.push(st);
    }
    Ok(out)
}

/// `sqliteEditPreview`: "BEGIN; ...; COMMIT;" as the save runs it (parameters written in).
pub fn sqlite_edit_preview(statements: &[BuiltStatement]) -> String {
    let mut lines = vec!["BEGIN;".to_owned()];
    lines.extend(statements.iter().map(|s| format!("{};", s.preview)));
    lines.push("COMMIT;".into());
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn affinities_and_params() {
        let affs: Vec<&str> =
            ["INTEGER", "BIGINT", "varchar(20)", "BLOB", "", "REAL", "DOUBLE", "NUMERIC", "DECIMAL(10,2)", "DATETIME"]
                .iter()
                .map(|t| sqlite_affinity(Some(t)).as_str())
                .collect();
        assert_eq!(affs, ["integer", "integer", "text", "blob", "blob", "real", "real", "numeric", "numeric", "numeric"]);
        assert_eq!(sqlite_param(Some("9007199254740993"), Affinity::Integer), SqliteParam::Integer(9_007_199_254_740_993));
        assert_eq!(
            sqlite_param(Some("99999999999999999999"), Affinity::Integer),
            SqliteParam::Text("99999999999999999999".into())
        );
        assert_eq!(sqlite_param(Some("\\x00ff"), Affinity::Blob), SqliteParam::Blob(vec![0, 255]));
        assert_eq!(sqlite_param(Some(" -Infinity "), Affinity::Real), SqliteParam::Real(f64::NEG_INFINITY));
    }

    #[test]
    fn read_only_and_positions() {
        assert!(sqlite_read_only_allows("PRAGMA main.index_list(t)"));
        assert!(!sqlite_read_only_allows("PRAGMA journal_mode(WAL)"));
        assert!(sqlite_read_only_allows("PRAGMA table_info('t')"));
        assert!(!sqlite_read_only_allows("PRAGMA query_only = 0"));
        assert_eq!(sqlite_error_position("near \"FRM\": syntax error", "SELECT 'FRM' AS a\nFRM t"), Some(19));
        assert_eq!(sqlite_error_position("incomplete input", "SELECT ("), Some(9));
        assert_eq!(sqlite_error_position("no such table: t", "SELECT * FROM t"), None);
    }
}
