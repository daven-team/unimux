//! The pure SQL helpers of the database viewer (D3), ported from src/shared/dbSql.ts, dbMysql.ts, dbSqlite.ts and
//! `redactSql` of dbTabs.ts: quoting, splitting scripts per dialect, the statement under the cursor, what a read-only
//! connection may run (a security boundary: the server's read-only transaction is only the second line), the SQL of table
//! pages, whole cells and staged edits with their previews, value kinds, error positions and the copy / export formats.
//!
//! Every offset and length is in UTF-16 code units, like the TS code (`SqlSpan.start`, `DB_LIMITS.identifier`, error
//! positions), and every answer is checked against the TS reference by `tests/sql_golden.rs` (test/golden/db-sql.jsonl, the
//! same vectors `test/db-sql-vectors.test.ts` runs through the TS code).

pub mod mysql;
pub mod pg;
mod scan;
pub mod split;
pub mod sqlite;
pub mod values;

pub use pg::{
    BuiltStatement, PageSql, build_edit_statements, cell_sql, code_only, edit_preview, ends_transaction, first_keyword,
    inline_params, is_read_statement, page_sql, read_only_allows, returns_rows, value_kind,
};
pub use split::{SqlSpan, error_span, split_sql, statement_at};

use serde_json::{Map, Value};

/// `DB_LIMITS` of src/shared/db.ts.
pub mod limits {
    pub const CONNECTIONS: usize = 500;
    pub const NAME: usize = 80;
    pub const GROUP: usize = 60;
    pub const HOST: usize = 253;
    pub const USER: usize = 128;
    pub const DATABASE: usize = 64;
    pub const PASSWORD: usize = 4096;
    pub const CA_PATH: usize = 4096;
    pub const CA_BYTES: usize = 1024 * 1024;
    pub const STATEMENT_TIMEOUT_MAX_MS: u64 = 24 * 3_600_000;
    pub const ROW_CAP: usize = 1000;
    pub const ROW_CAP_MAX: usize = 100_000;
    pub const PAGE_SIZES: [usize; 3] = [100, 500, 1000];
    pub const CELL_CHARS: usize = 64 * 1024;
    pub const FULL_VALUE_CHARS: usize = 16 * 1024 * 1024;
    pub const CHUNK_ROWS: usize = 500;
    pub const CHUNK_CHARS: usize = 2 * 1024 * 1024;
    pub const PAGE_CHARS: usize = 32 * 1024 * 1024;
    pub const CURSOR_IDLE_MS: u64 = 2 * 60_000;
    pub const SESSIONS_PER_CONNECTION: usize = 32;
    pub const SESSIONS_TOTAL: usize = 128;
    pub const SQL: usize = 8 * 1024 * 1024;
    pub const FILTER: usize = 64 * 1024;
    pub const IDENTIFIER: usize = 1024;
    pub const EDITS: usize = 5000;
    pub const SORT_COLUMNS: usize = 16;
    pub const SERVER_TEXT: usize = 4000;
    pub const IDLE_MS: u64 = 5 * 60_000;
}

/// `SQLITE_MAIN`: SQLite connections show the main database only.
pub const SQLITE_MAIN: &str = "main";

/// `SqlDialect`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Dialect {
    #[default]
    Postgres,
    Mysql,
    Sqlite,
}

impl Dialect {
    pub fn parse(s: &str) -> Option<Dialect> {
        match s {
            "postgres" => Some(Dialect::Postgres),
            "mysql" => Some(Dialect::Mysql),
            "sqlite" => Some(Dialect::Sqlite),
            _ => None,
        }
    }
}

/// `DbSqlError`: what the builders refuse. The DB Host answers `invalid` for every other error of a builder too.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DbSqlError {
    Invalid,
    NoKey,
}

impl DbSqlError {
    pub fn code(self) -> &'static str {
        match self {
            DbSqlError::Invalid => "invalid",
            DbSqlError::NoKey => "noKey",
        }
    }
}

impl std::fmt::Display for DbSqlError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for DbSqlError {}

pub type SqlResult<T> = Result<T, DbSqlError>;

/// `DbValueKind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ValueKind {
    Text,
    Int,
    Bigint,
    Float,
    Numeric,
    Bool,
    Json,
    Bytea,
    Uuid,
    Date,
    Time,
    Timestamp,
    Timestamptz,
    Interval,
    Array,
    Enum,
    Other,
}

impl ValueKind {
    pub const ALL: [ValueKind; 17] = [
        ValueKind::Text,
        ValueKind::Int,
        ValueKind::Bigint,
        ValueKind::Float,
        ValueKind::Numeric,
        ValueKind::Bool,
        ValueKind::Json,
        ValueKind::Bytea,
        ValueKind::Uuid,
        ValueKind::Date,
        ValueKind::Time,
        ValueKind::Timestamp,
        ValueKind::Timestamptz,
        ValueKind::Interval,
        ValueKind::Array,
        ValueKind::Enum,
        ValueKind::Other,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            ValueKind::Text => "text",
            ValueKind::Int => "int",
            ValueKind::Bigint => "bigint",
            ValueKind::Float => "float",
            ValueKind::Numeric => "numeric",
            ValueKind::Bool => "bool",
            ValueKind::Json => "json",
            ValueKind::Bytea => "bytea",
            ValueKind::Uuid => "uuid",
            ValueKind::Date => "date",
            ValueKind::Time => "time",
            ValueKind::Timestamp => "timestamp",
            ValueKind::Timestamptz => "timestamptz",
            ValueKind::Interval => "interval",
            ValueKind::Array => "array",
            ValueKind::Enum => "enum",
            ValueKind::Other => "other",
        }
    }

    pub fn parse(s: &str) -> Option<ValueKind> {
        ValueKind::ALL.into_iter().find(|k| k.as_str() == s)
    }
}

/// `isNumericKind`: right-aligned in the grid.
pub fn is_numeric_kind(kind: ValueKind) -> bool {
    matches!(kind, ValueKind::Int | ValueKind::Bigint | ValueKind::Float | ValueKind::Numeric)
}

/// `DbSort`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sort {
    pub column: String,
    pub desc: bool,
}

/// `PageSqlInput` (numbers as JS numbers: the host floors them).
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PageSqlInput {
    pub schema: String,
    pub table: String,
    pub limit: f64,
    pub offset: Option<f64>,
    pub after: Option<Vec<String>>,
    pub sort: Option<Vec<Sort>>,
    pub filter: Option<String>,
}

impl PageSqlInput {
    /// A `DbTablePageRequest` as the page builders read it (main validated it with zod); an `after` holding a non-string
    /// is refused.
    pub fn from_json(v: &Value) -> SqlResult<PageSqlInput> {
        let str_of = |o: &Value, key: &str| o.get(key).and_then(Value::as_str).unwrap_or("").to_owned();
        let after = match v.get("after") {
            Some(Value::Array(items)) => Some(
                items.iter().map(|x| x.as_str().map(str::to_owned).ok_or(DbSqlError::Invalid)).collect::<SqlResult<Vec<_>>>()?,
            ),
            _ => None,
        };
        let sort = v.get("sort").and_then(Value::as_array).map(|items| {
            items
                .iter()
                .map(|x| Sort { column: str_of(x, "column"), desc: x.get("desc").and_then(Value::as_bool).unwrap_or(false) })
                .collect()
        });
        Ok(PageSqlInput {
            schema: str_of(v, "schema"),
            table: str_of(v, "table"),
            limit: v.get("limit").and_then(Value::as_f64).unwrap_or(f64::NAN),
            offset: v.get("offset").and_then(Value::as_f64),
            after,
            sort,
            filter: v.get("filter").and_then(Value::as_str).map(str::to_owned),
        })
    }
}

/// `DbStagedEdit['op']`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EditOp {
    Update,
    Insert,
    Delete,
}

impl EditOp {
    pub fn as_str(self) -> &'static str {
        match self {
            EditOp::Update => "update",
            EditOp::Insert => "insert",
            EditOp::Delete => "delete",
        }
    }
}

/// The column / value pairs of a staged edit in the order JS `Object.keys` gives them (array-index names first, ascending,
/// then insertion order); values as they arrived (the builders check that each is a string or null where the TS code does).
pub type Fields = Vec<(String, Value)>;

/// `DbStagedEdit`.
#[derive(Debug, Clone, PartialEq)]
pub enum StagedEdit {
    Update { key: Fields, set: Fields, original: Option<Fields> },
    Insert { values: Fields },
    Delete { key: Fields, original: Option<Fields> },
}

impl StagedEdit {
    /// A staged edit from its JSON form (main validated the shape with zod before; anything else is `invalid`).
    pub fn from_json(v: &Value) -> SqlResult<StagedEdit> {
        let o = v.as_object().ok_or(DbSqlError::Invalid)?;
        let fields = |name: &str| -> SqlResult<Fields> {
            o.get(name).and_then(Value::as_object).map(js_fields).ok_or(DbSqlError::Invalid)
        };
        let optional = |name: &str| -> SqlResult<Option<Fields>> {
            match o.get(name) {
                None => Ok(None),
                Some(Value::Object(m)) => Ok(Some(js_fields(m))),
                Some(_) => Err(DbSqlError::Invalid),
            }
        };
        match o.get("op").and_then(Value::as_str) {
            Some("update") => {
                Ok(StagedEdit::Update { key: fields("key")?, set: fields("set")?, original: optional("original")? })
            }
            Some("insert") => Ok(StagedEdit::Insert { values: fields("values")? }),
            Some("delete") => Ok(StagedEdit::Delete { key: fields("key")?, original: optional("original")? }),
            _ => Err(DbSqlError::Invalid),
        }
    }
}

/// The entries of a JSON object in JS `Object.keys` order.
pub fn js_fields(m: &Map<String, Value>) -> Fields {
    let mut m = m.clone();
    unimux_core::js_json::order_map_like_js(&mut m);
    m.into_iter().collect()
}

/// The value of `name` in fields (own properties only, like `Object.hasOwn` / a JSON-parsed record).
pub(crate) fn field<'a>(fields: &'a Fields, name: &str) -> Option<&'a Value> {
    fields.iter().find(|(k, _)| k == name).map(|(_, v)| v)
}

/// `value(v)` of the builders: a string or null, anything else is refused.
pub(crate) fn string_or_null(v: &Value) -> SqlResult<Option<&str>> {
    match v {
        Value::Null => Ok(None),
        Value::String(s) => Ok(Some(s)),
        _ => Err(DbSqlError::Invalid),
    }
}

/// `quoteIdent`: "My ""odd"" table" (Postgres, SQLite) or `My ``odd`` table` (MySQL); an empty, overlong (UTF-16 units) or
/// NUL-holding name is refused.
pub fn quote_ident(name: &str, dialect: Dialect) -> SqlResult<String> {
    if name.is_empty() || unimux_core::utf16::len(name) > limits::IDENTIFIER || name.contains('\0') {
        return Err(DbSqlError::Invalid);
    }
    Ok(match dialect {
        Dialect::Mysql => format!("`{}`", name.replace('`', "``")),
        _ => format!("\"{}\"", name.replace('"', "\"\"")),
    })
}

/// `qualifiedName`.
pub fn qualified_name(schema: &str, name: &str, dialect: Dialect) -> SqlResult<String> {
    Ok(format!("{}.{}", quote_ident(schema, dialect)?, quote_ident(name, dialect)?))
}

/// `quoteLiteral`: a string literal for display (quotes doubled, NUL dropped), NULL for null.
pub fn quote_literal(value: Option<&str>) -> String {
    match value {
        None => "NULL".into(),
        Some(v) => format!("'{}'", v.replace('\0', "").replace('\'', "''")),
    }
}

/// `redactSql` (src/shared/dbTabs.ts): the query history never keeps a password typed into a script. Quoted secrets after
/// PASSWORD / IDENTIFIED BY become '***', `password=...` in connection strings becomes `password=***`.
pub fn redact_sql(sql: &str) -> String {
    let first = redact_password_literals(&scan::units(sql));
    scan::text(&redact_password_assignments(&first))
}

/// `/\b(PASSWORD|IDENTIFIED\s+BY)(\s+)(E?'(?:[^']|'')*'|\$([A-Za-z_]*)\$[\s\S]*?\$\4\$)/gi` -> `$1$2'***'`.
fn redact_password_literals(u: &[u16]) -> Vec<u16> {
    let n = u.len();
    let mut out = Vec::with_capacity(n);
    let mut i = 0;
    while i < n {
        if let Some((head_end, end)) = password_literal_at(u, i) {
            out.extend_from_slice(&u[i..head_end]);
            out.extend(scan::units("'***'"));
            i = end;
        } else {
            out.push(u[i]);
            i += 1;
        }
    }
    out
}

fn password_literal_at(u: &[u16], i: usize) -> Option<(usize, usize)> {
    if i > 0 && scan::is_word(u[i - 1]) {
        return None;
    }
    let word_end = if scan::word_ci_at(u, i, "PASSWORD") {
        i + 8
    } else if scan::word_ci_at(u, i, "IDENTIFIED") {
        let j = scan::skip_spaces(u, i + 10);
        if j == i + 10 || !scan::word_ci_at(u, j, "BY") {
            return None;
        }
        j + 2
    } else {
        return None;
    };
    let head_end = scan::skip_spaces(u, word_end);
    if head_end == word_end || head_end >= u.len() {
        return None;
    }
    let quote = u16::from(b'\'');
    let c = u[head_end];
    if c == u16::from(b'E') || c == u16::from(b'e') {
        if head_end + 1 < u.len() && u[head_end + 1] == quote {
            return scan::quoted_end(u, head_end + 1, quote, false).map(|e| (head_end, e));
        }
        return None;
    }
    if c == quote {
        return scan::quoted_end(u, head_end, quote, false).map(|e| (head_end, e));
    }
    if c == u16::from(b'$') {
        // $tag$ ... $tag$, the closing tag compared case-insensitively (the regex has /i).
        let mut j = head_end + 1;
        while j < u.len() && (scan::is_ascii_letter(u[j]) || u[j] == u16::from(b'_')) {
            j += 1;
        }
        if j >= u.len() || u[j] != u16::from(b'$') {
            return None;
        }
        let tag = &u[head_end..=j];
        let mut k = j + 1;
        while k + tag.len() <= u.len() {
            if tag.iter().enumerate().all(|(t, &c)| {
                let d = u[k + t];
                d == c || (c < 0x80 && d < 0x80 && (c as u8).eq_ignore_ascii_case(&(d as u8)))
            }) {
                return Some((head_end, k + tag.len()));
            }
            k += 1;
        }
        return None;
    }
    None
}

/// `/\b(password\s*=\s*)('[^']*'|[^\s']+)/gi` -> `$1***`.
fn redact_password_assignments(u: &[u16]) -> Vec<u16> {
    let n = u.len();
    let mut out = Vec::with_capacity(n);
    let mut i = 0;
    while i < n {
        if let Some((head_end, end)) = password_assignment_at(u, i) {
            out.extend_from_slice(&u[i..head_end]);
            out.extend(scan::units("***"));
            i = end;
        } else {
            out.push(u[i]);
            i += 1;
        }
    }
    out
}

fn password_assignment_at(u: &[u16], i: usize) -> Option<(usize, usize)> {
    if (i > 0 && scan::is_word(u[i - 1])) || !scan::word_ci_at(u, i, "password") {
        return None;
    }
    let j = scan::skip_spaces(u, i + 8);
    if j >= u.len() || u[j] != u16::from(b'=') {
        return None;
    }
    let head_end = scan::skip_spaces(u, j + 1);
    let quote = u16::from(b'\'');
    if head_end < u.len() && u[head_end] == quote {
        return (head_end + 1..u.len()).find(|&k| u[k] == quote).map(|k| (head_end, k + 1));
    }
    let mut k = head_end;
    while k < u.len() && !scan::is_space(u[k]) && u[k] != quote {
        k += 1;
    }
    (k > head_end).then_some((head_end, k))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoting() {
        assert_eq!(quote_ident("users", Dialect::Postgres).unwrap(), "\"users\"");
        assert_eq!(quote_ident("My \"odd\" Table", Dialect::Postgres).unwrap(), "\"My \"\"odd\"\" Table\"");
        assert_eq!(quote_ident("", Dialect::Postgres), Err(DbSqlError::Invalid));
        assert_eq!(quote_ident("a\0b", Dialect::Mysql), Err(DbSqlError::Invalid));
        assert_eq!(quote_ident("we`ird\"name", Dialect::Mysql).unwrap(), "`we``ird\"name`");
        assert_eq!(quote_ident(&"🙂".repeat(512), Dialect::Postgres).map(|s| s.len()), Ok(2050));
        assert_eq!(quote_ident(&format!("{}a", "🙂".repeat(512)), Dialect::Postgres), Err(DbSqlError::Invalid));
        assert_eq!(quote_literal(Some("it's")), "'it''s'");
        assert_eq!(quote_literal(None), "NULL");
    }

    #[test]
    fn redaction() {
        assert_eq!(redact_sql("ALTER USER a PASSWORD 'x''y'"), "ALTER USER a PASSWORD '***'");
        assert_eq!(redact_sql("create user u identified  by E'p'"), "create user u identified  by '***'");
        assert_eq!(redact_sql("ALTER ROLE r PASSWORD $Q$s3cret$q$;"), "ALTER ROLE r PASSWORD '***';");
        assert_eq!(redact_sql("host=x password = 'a b' user=y"), "host=x password = *** user=y");
        assert_eq!(redact_sql("PASSWORD=abc;x"), "PASSWORD=***");
        assert_eq!(redact_sql("xpassword=abc"), "xpassword=abc");
    }
}
