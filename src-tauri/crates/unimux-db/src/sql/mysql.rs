//! The MySQL / MariaDB helpers of src/shared/dbMysql.ts (and `mysqlFlavorOf` / `mysqlServerLabel` of db.ts): literals (values
//! run as hex literals with a character set introducer, so no escaping can go wrong under any sql_mode), what a read-only
//! connection may run, statement timeouts, value kinds of result fields and columns, table pages, whole cells, staged edits
//! and error positions.

use std::collections::{HashMap, HashSet};
use std::fmt::Write as _;

use super::pg::{cell_key, first_keyword, js_number, order_columns, page_filter, page_limit, page_offset};
use super::scan::{self, has_any_word, has_words, is_space, newline_from, quoted_end, starts_with_words, units};
use super::{DbSqlError, Dialect, EditOp, Fields, PageSqlInput, SqlResult, StagedEdit, ValueKind, field, limits, string_or_null};

/// `DbMysqlFlavor`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    Mysql,
    Mariadb,
}

impl Flavor {
    pub fn as_str(self) -> &'static str {
        match self {
            Flavor::Mysql => "mysql",
            Flavor::Mariadb => "mariadb",
        }
    }
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// `/^\\x((?:[0-9a-f]{2})*)$/i`: the hex digits of a "\x..." value (the `i` flag lets "\X..." in too).
pub(crate) fn hex_value(v: &str) -> Option<&str> {
    let h = v.strip_prefix("\\x").or_else(|| v.strip_prefix("\\X"))?;
    (h.len() % 2 == 0 && h.bytes().all(|b| b.is_ascii_hexdigit())).then_some(h)
}

/// `mysqlLiteral`: NULL, '' , `_utf8mb4 X'...'` (the UTF-8 bytes) or, for binary columns, `X'...'` ("\x0aff" means the bytes).
pub fn mysql_literal(value: Option<&str>, binary: bool) -> String {
    let Some(v) = value else { return "NULL".into() };
    if binary {
        return format!("X'{}'", hex_value(v).map_or_else(|| hex(v.as_bytes()), str::to_ascii_lowercase));
    }
    if v.is_empty() {
        return "''".into();
    }
    format!("_utf8mb4 X'{}'", hex(v.as_bytes()))
}

/// `mysqlDisplayLiteral`: a readable literal for previews only (never run).
pub fn mysql_display_literal(value: Option<&str>) -> String {
    match value {
        None => "NULL".into(),
        Some(v) => format!("'{}'", v.replace('\0', "").replace('\\', "\\\\").replace('\'', "''")),
    }
}

/// `myIdent`.
pub fn my_ident(name: &str) -> SqlResult<String> {
    super::quote_ident(name, Dialect::Mysql)
}

/// `myQualified`.
pub fn my_qualified(db: &str, name: &str) -> SqlResult<String> {
    super::qualified_name(db, name, Dialect::Mysql)
}

/// `mysqlCodeOnly`: the text outside quotes and comments, MySQL's way (each part replaced by one blank):
/// `/--\s[^\n]*|#[^\n]*|\/\*(?![!M])[\s\S]*?\*\/|'(?:[^'\\]|\\[\s\S]|'')*'|"(?:[^"\\]|\\[\s\S]|"")*"|`(?:[^`]|``)*`/g`.
pub fn mysql_code_only(sql: &str) -> String {
    scan::text(&code_only_units(&units(sql)))
}

fn code_only_units(u: &[u16]) -> Vec<u16> {
    let n = u.len();
    let mut out = Vec::with_capacity(n);
    let mut i = 0;
    while i < n {
        let c = u[i];
        let end = if c == u16::from(b'-') && u.get(i + 1) == Some(&u16::from(b'-')) && u.get(i + 2).is_some_and(|&s| is_space(s))
        {
            Some(newline_from(u, i + 3).unwrap_or(n))
        } else if c == u16::from(b'#') {
            Some(newline_from(u, i).unwrap_or(n))
        } else if c == u16::from(b'/')
            && u.get(i + 1) == Some(&u16::from(b'*'))
            && !matches!(u.get(i + 2), Some(&x) if x == u16::from(b'!') || x == u16::from(b'M'))
        {
            scan::block_comment_end(u, i)
        } else if c == u16::from(b'\'') || c == u16::from(b'"') {
            quoted_end(u, i, c, true)
        } else if c == u16::from(b'`') {
            quoted_end(u, i, c, false)
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

const MY_RO_ALLOWED: [&str; 17] = [
    "SELECT",
    "WITH",
    "VALUES",
    "TABLE",
    "SHOW",
    "EXPLAIN",
    "DESCRIBE",
    "DESC",
    "HELP",
    "USE",
    "BEGIN",
    "START",
    "COMMIT",
    "ROLLBACK",
    "SAVEPOINT",
    "RELEASE",
    "SET",
];
const MY_WRITE_WORDS: [&str; 8] = ["INSERT", "UPDATE", "DELETE", "REPLACE", "MERGE", "TRUNCATE", "CALL", "LOAD"];

/// `mysqlReadOnlyAllows`: reads, USE and transaction control; never writes, SET (except SET [SESSION] TRANSACTION without
/// READ WRITE), SELECT ... INTO, CALL, or the read-only settings by name.
pub fn mysql_read_only_allows(sql: &str) -> bool {
    let kw = first_keyword(sql);
    if !MY_RO_ALLOWED.contains(&kw.as_str()) {
        return false;
    }
    let code = code_only_units(&units(sql));
    if has_any_word(&code, &["transaction_read_only", "tx_read_only", "read_only"]) {
        return false;
    }
    if has_words(&code, &[&["READ", "WRITE"]], true) {
        return false;
    }
    match kw.as_str() {
        "SET" => starts_with_words(&code, &[&["SET", "TRANSACTION"], &["SET", "SESSION", "TRANSACTION"]]),
        "SHOW" | "DESCRIBE" | "DESC" | "HELP" | "USE" => true,
        "SELECT" | "WITH" | "EXPLAIN" | "VALUES" | "TABLE" => {
            !has_any_word(&code, &MY_WRITE_WORDS) && !has_any_word(&code, &["INTO"])
        }
        _ => true,
    }
}

/// `mysqlIsReadStatement`: its result may stay open for "load more".
pub fn mysql_is_read_statement(sql: &str) -> bool {
    let kw = first_keyword(sql);
    let code = code_only_units(&units(sql));
    match kw.as_str() {
        "SELECT" | "WITH" | "VALUES" | "TABLE" => {
            !has_any_word(&code, &MY_WRITE_WORDS)
                && !has_any_word(&code, &["INTO"])
                && !has_words(&code, &[&["FOR", "UPDATE"]], true)
        }
        "SHOW" | "DESCRIBE" | "DESC" | "HELP" => true,
        "EXPLAIN" => !has_any_word(&code, &["ANALYZE"]),
        _ => false,
    }
}

/// `mysqlEndsTransaction`.
pub fn mysql_ends_transaction(sql: &str) -> bool {
    matches!(first_keyword(sql).as_str(), "COMMIT" | "ROLLBACK")
}

/// `mysqlIsUse`.
pub fn mysql_is_use(sql: &str) -> bool {
    first_keyword(sql) == "USE"
}

/// `mysqlTimeoutSql`: MySQL's max_execution_time (ms), MariaDB's max_statement_time (s); None restores the default.
pub fn mysql_timeout_sql(flavor: Flavor, ms: Option<f64>) -> String {
    let Some(ms) = ms else {
        return match flavor {
            Flavor::Mariadb => "SET SESSION max_statement_time = DEFAULT".into(),
            Flavor::Mysql => "SET SESSION max_execution_time = DEFAULT".into(),
        };
    };
    // Math.max(0, Math.floor(ms)); NaN stays NaN.
    let v = if ms.is_nan() { f64::NAN } else { ms.floor().max(0.0) };
    match flavor {
        Flavor::Mariadb => format!("SET SESSION max_statement_time = {}", to_fixed_3(v / 1000.0, v)),
        Flavor::Mysql => format!("SET SESSION max_execution_time = {}", js_number(v)),
    }
}

/// `(ms / 1000).toFixed(3)` for a whole, non-negative `ms` (the digits of ms itself: the double nearest ms / 1000 is always
/// closer to it than to its neighbours at 3 decimals).
fn to_fixed_3(x: f64, ms: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x >= 1e21 || ms > 9_007_199_254_740_991.0 {
        // Far beyond any timeout DB_LIMITS allows; JS would print exponent / rounded forms here.
        return if x >= 1e21 { js_number(x) } else { format!("{x:.3}") };
    }
    let m = ms as u64;
    format!("{}.{:03}", m / 1000, m % 1000)
}

/// `mysqlFlavorOf`: MariaDB when its version or version comment says so.
pub fn mysql_flavor_of(version: &str, comment: &str) -> Flavor {
    let all = units(&format!("{version} {comment}"));
    if (0..all.len()).any(|i| scan::word_ci_at(&all, i, "mariadb")) { Flavor::Mariadb } else { Flavor::Mysql }
}

/// `mysqlServerLabel`: "MariaDB 11.4.2" or "MySQL 8.0.36" from VERSION() and its comment.
pub fn mysql_server_label(version: &str, comment: &str) -> String {
    let flavor = mysql_flavor_of(version, comment);
    let b = version.as_bytes();
    let digits = |from: usize| -> usize {
        let mut e = from;
        while e < b.len() && b[e].is_ascii_digit() {
            e += 1;
        }
        e
    };
    // /^5\.5\.5-(?=\d+\.\d+)/
    let mut start = 0;
    if version.starts_with("5.5.5-") {
        let a = digits(6);
        if a > 6 && b.get(a) == Some(&b'.') && digits(a + 1) > a + 1 {
            start = 6;
        }
    }
    // /^\d+(?:\.\d+){0,2}/
    let mut end = digits(start);
    let v = if end > start {
        for _ in 0..2 {
            if b.get(end) == Some(&b'.') && digits(end + 1) > end + 1 {
                end = digits(end + 1);
            } else {
                break;
            }
        }
        version[start..end].to_owned()
    } else {
        // version.slice(0, 40) of the replaced text (nothing was replaced: a match needs a digit right after "5.5.5-").
        unimux_core::utf16::slice(&version[start..], 0, 40)
    };
    format!("{} {v}", if flavor == Flavor::Mariadb { "MariaDB" } else { "MySQL" })
}

/// Column type codes of the protocol (`MY_TYPE`).
pub mod my_type {
    pub const DECIMAL: i64 = 0x00;
    pub const TINY: i64 = 0x01;
    pub const SHORT: i64 = 0x02;
    pub const LONG: i64 = 0x03;
    pub const FLOAT: i64 = 0x04;
    pub const DOUBLE: i64 = 0x05;
    pub const NULL: i64 = 0x06;
    pub const TIMESTAMP: i64 = 0x07;
    pub const LONGLONG: i64 = 0x08;
    pub const INT24: i64 = 0x09;
    pub const DATE: i64 = 0x0a;
    pub const TIME: i64 = 0x0b;
    pub const DATETIME: i64 = 0x0c;
    pub const YEAR: i64 = 0x0d;
    pub const NEWDATE: i64 = 0x0e;
    pub const VARCHAR: i64 = 0x0f;
    pub const BIT: i64 = 0x10;
    pub const VECTOR: i64 = 0xf2;
    pub const JSON: i64 = 0xf5;
    pub const NEWDECIMAL: i64 = 0xf6;
    pub const ENUM: i64 = 0xf7;
    pub const SET: i64 = 0xf8;
    pub const TINY_BLOB: i64 = 0xf9;
    pub const MEDIUM_BLOB: i64 = 0xfa;
    pub const LONG_BLOB: i64 = 0xfb;
    pub const BLOB: i64 = 0xfc;
    pub const VAR_STRING: i64 = 0xfd;
    pub const STRING: i64 = 0xfe;
    pub const GEOMETRY: i64 = 0xff;
}

/// `MY_BINARY_CHARSET`.
pub const MY_BINARY_CHARSET: i64 = 63;
const UNSIGNED_FLAG: i64 = 32;
const ENUM_FLAG: i64 = 256;
const SET_FLAG: i64 = 2048;

fn stringish(t: i64) -> bool {
    use my_type::*;
    matches!(t, VARCHAR | VAR_STRING | STRING | TINY_BLOB | MEDIUM_BLOB | LONG_BLOB | BLOB | ENUM | SET)
}

/// `MysqlFieldLike`: what the kind of a result field depends on.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct FieldLike {
    pub column_type: i64,
    pub character_set: i64,
    pub flags: i64,
    pub extended_type_name: Option<String>,
    pub extended_format: Option<String>,
}

/// JS `a & b` of two numbers (ToInt32 of both).
fn js_and(a: i64, b: i64) -> i64 {
    i64::from((a as i32) & (b as i32))
}

/// `mysqlFieldBinary`: binary strings and blobs, BIT, GEOMETRY and VECTOR are shown as "\x..." hex.
pub fn mysql_field_binary(f: &FieldLike) -> bool {
    if f.extended_format.as_deref() == Some("json") {
        return false;
    }
    if matches!(f.column_type, my_type::BIT | my_type::GEOMETRY | my_type::VECTOR) {
        return true;
    }
    stringish(f.column_type) && f.character_set == MY_BINARY_CHARSET
}

/// `mysqlFieldKind`: the kind and type name of a result field.
pub fn mysql_field_kind(f: &FieldLike) -> (ValueKind, String) {
    use ValueKind::*;
    use my_type::*;
    let unsigned = js_and(f.flags, UNSIGNED_FLAG) != 0;
    let u = |name: &str| if unsigned { format!("{name} unsigned") } else { name.to_owned() };
    let binary = mysql_field_binary(f);
    if f.extended_format.as_deref() == Some("json") {
        return (Json, "json".into());
    }
    if f.extended_type_name.as_deref() == Some("uuid") {
        return (Uuid, "uuid".into());
    }
    if let Some(name) = f.extended_type_name.as_deref().filter(|n| !n.is_empty()) {
        return (if binary { Bytea } else { Text }, name.to_owned());
    }
    let t = |k: ValueKind, n: &str| (k, n.to_owned());
    match f.column_type {
        TINY => (Int, u("tinyint")),
        SHORT => (Int, u("smallint")),
        INT24 => (Int, u("mediumint")),
        LONG => (if unsigned { Bigint } else { Int }, u("int")),
        LONGLONG => (if unsigned { Numeric } else { Bigint }, u("bigint")),
        YEAR => t(Int, "year"),
        FLOAT => t(Float, "float"),
        DOUBLE => t(Float, "double"),
        DECIMAL | NEWDECIMAL => t(Numeric, "decimal"),
        DATE | NEWDATE => t(Date, "date"),
        TIME => t(Time, "time"),
        DATETIME => t(Timestamp, "datetime"),
        TIMESTAMP => t(Timestamp, "timestamp"),
        JSON => t(Json, "json"),
        BIT => t(Bytea, "bit"),
        GEOMETRY => t(Other, "geometry"),
        VECTOR => t(Other, "vector"),
        NULL => t(Text, "null"),
        ENUM => t(Enum, "enum"),
        SET => t(Enum, "set"),
        TINY_BLOB | MEDIUM_BLOB | LONG_BLOB | BLOB => {
            if binary {
                t(Bytea, "blob")
            } else {
                t(Text, "text")
            }
        }
        VAR_STRING | VARCHAR | STRING => {
            if js_and(f.flags, ENUM_FLAG) != 0 {
                t(Enum, "enum")
            } else if js_and(f.flags, SET_FLAG) != 0 {
                t(Enum, "set")
            } else if binary {
                t(Bytea, if f.column_type == STRING { "binary" } else { "varbinary" })
            } else {
                t(Text, if f.column_type == STRING { "char" } else { "varchar" })
            }
        }
        other => (Other, other.to_string()),
    }
}

const BINARY_TYPES: [&str; 7] = ["binary", "varbinary", "tinyblob", "blob", "mediumblob", "longblob", "bit"];
const STRING_TYPES: [&str; 8] = ["char", "varchar", "tinytext", "text", "mediumtext", "longtext", "enum", "set"];
const GEOMETRY_TYPES: [&str; 10] = [
    "geometry",
    "point",
    "linestring",
    "polygon",
    "multipoint",
    "multilinestring",
    "multipolygon",
    "geometrycollection",
    "geomcollection",
    "vector",
];

/// `mysqlBinaryType`: whether a table column (information_schema DATA_TYPE) holds bytes.
pub fn mysql_binary_type(data_type: &str) -> bool {
    let t = data_type.to_lowercase();
    BINARY_TYPES.contains(&t.as_str()) || GEOMETRY_TYPES.contains(&t.as_str())
}

/// `mysqlColumnKind`: the kind of a table column from information_schema (DATA_TYPE, COLUMN_TYPE).
pub fn mysql_column_kind(data_type: &str, column_type: &str) -> ValueKind {
    use ValueKind::*;
    let t = data_type.to_lowercase();
    let unsigned = has_any_word(&units(column_type), &["unsigned"]);
    match t.as_str() {
        "tinyint" | "smallint" | "mediumint" | "year" => Int,
        "int" | "integer" => {
            if unsigned {
                Bigint
            } else {
                Int
            }
        }
        "bigint" => {
            if unsigned {
                Numeric
            } else {
                Bigint
            }
        }
        "float" | "double" | "real" => Float,
        "decimal" | "numeric" => Numeric,
        "date" => Date,
        "time" => Time,
        "datetime" | "timestamp" => Timestamp,
        "json" => Json,
        "uuid" => Uuid,
        "enum" | "set" => Enum,
        t if BINARY_TYPES.contains(&t) => Bytea,
        t if GEOMETRY_TYPES.contains(&t) => Other,
        _ => Text,
    }
}

/// `mysqlPageSql`: the SELECT of one table page (limit + 1 rows), MySQL's NULL order, keyset paging when the order is the
/// key alone. `binary`: the key columns that hold bytes (their values are hex).
pub fn mysql_page_sql(
    input: &PageSqlInput,
    key_columns: Option<&[String]>,
    binary: &HashSet<String>,
) -> SqlResult<(String, bool)> {
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
    let mut conditions = Vec::new();
    if let Some(f) = page_filter(input.filter.as_deref())? {
        conditions.push(f);
    }
    let mut keyset = false;
    if let Some(after) = input.after.as_ref().filter(|a| !a.is_empty()) {
        let Some(key) = key.filter(|k| by_key_only && after.len() == k.len()) else { return Err(DbSqlError::Invalid) };
        let op = if order[0].desc { '<' } else { '>' };
        let names = key.iter().map(|k| my_ident(k)).collect::<SqlResult<Vec<_>>>()?;
        let values: Vec<String> =
            key.iter().enumerate().map(|(i, k)| mysql_literal(Some(&after[i]), binary.contains(k))).collect();
        conditions.push(format!("({}) {op} ({})", names.join(", "), values.join(", ")));
        keyset = true;
    }
    let mut parts = vec![format!("SELECT * FROM {}", my_qualified(&input.schema, &input.table)?)];
    if !conditions.is_empty() {
        parts.push(format!("WHERE {}", conditions.join("\nAND ")));
    }
    if !order.is_empty() {
        let cols = order
            .iter()
            .map(|s| Ok(format!("{} {}", my_ident(&s.column)?, if s.desc { "DESC" } else { "ASC" })))
            .collect::<SqlResult<Vec<_>>>()?;
        parts.push(format!("ORDER BY {}", cols.join(", ")));
    }
    parts.push(format!("LIMIT {}", limit + 1));
    if !keyset && let Some(o) = page_offset(input.offset) {
        parts.push(format!("OFFSET {o}"));
    }
    Ok((parts.join("\n"), keyset))
}

/// `mysqlCellSql`: the SELECT of one whole cell by the row's key (cut on the server).
pub fn mysql_cell_sql(
    db: &str,
    table: &str,
    column: &str,
    key: &Fields,
    key_columns: &[String],
    binary: &HashSet<String>,
) -> SqlResult<String> {
    let values = cell_key(key, key_columns)?;
    let conds = key_columns
        .iter()
        .zip(values)
        .map(|(k, v)| Ok(format!("{} = {}", my_ident(k)?, mysql_literal(Some(v), binary.contains(k)))))
        .collect::<SqlResult<Vec<_>>>()?;
    Ok(format!(
        "SELECT SUBSTRING({}, 1, {}) FROM {} WHERE {} LIMIT 2",
        my_ident(column)?,
        limits::FULL_VALUE_CHARS + 1,
        my_qualified(db, table)?,
        conds.join(" AND ")
    ))
}

/// `MysqlColumnMeta`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub generated: bool,
}

/// `MysqlBuiltStatement`: the statement as it runs (`sql`, hex literals) and as the preview shows it (`preview`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BuiltStatement {
    pub op: EditOp,
    pub index: usize,
    pub sql: String,
    pub preview: String,
}

/// Whether an `original` of this type compares exactly (floats, JSON and bytes do not).
fn comparable(data_type: &str) -> bool {
    let t = data_type.to_lowercase();
    !["float", "double", "real", "json"].contains(&t.as_str())
        && !BINARY_TYPES.contains(&t.as_str())
        && !GEOMETRY_TYPES.contains(&t.as_str())
}

/// `mysqlEditStatements`: the statements of staged edits on db.table, identified by `key_columns`; `original` values are
/// checked where the comparison is exact (strings byte for byte, numbers, dates and times by value).
pub fn mysql_edit_statements(
    db: &str,
    table: &str,
    key_columns: Option<&[String]>,
    edits: &[StagedEdit],
    columns: &[ColumnMeta],
) -> SqlResult<Vec<BuiltStatement>> {
    if edits.is_empty() || edits.len() > limits::EDITS {
        return Err(DbSqlError::Invalid);
    }
    let target = my_qualified(db, table)?;
    let by_name: HashMap<&str, &ColumnMeta> = columns.iter().map(|c| (c.name.as_str(), c)).collect();
    let col = |c: &str| -> SqlResult<&ColumnMeta> {
        match by_name.get(c) {
            Some(m) if !c.is_empty() => Ok(*m),
            _ => Err(DbSqlError::Invalid),
        }
    };
    let writable = |c: &str| -> SqlResult<&ColumnMeta> {
        let m = col(c)?;
        if m.generated { Err(DbSqlError::Invalid) } else { Ok(m) }
    };
    let lit = |m: &ColumnMeta, v: Option<&str>| -> (String, String) {
        let binary = mysql_binary_type(&m.data_type);
        let shown = match v.and_then(hex_value) {
            Some(h) if binary => format!("X'{}'", h.to_ascii_lowercase()),
            _ => mysql_display_literal(v),
        };
        (mysql_literal(v, binary), shown)
    };
    let where_ = |key: &Fields| -> SqlResult<(String, String)> {
        let kc = match key_columns {
            Some(k) if !k.is_empty() => k,
            _ => return Err(DbSqlError::NoKey),
        };
        if key.len() != kc.len() || !kc.iter().all(|k| field(key, k).is_some()) {
            return Err(DbSqlError::Invalid);
        }
        let (mut run, mut shown) = (Vec::new(), Vec::new());
        for k in kc {
            let Some(serde_json::Value::String(v)) = field(key, k) else { return Err(DbSqlError::Invalid) };
            let (r, s) = lit(col(k)?, Some(v));
            let id = my_ident(k)?;
            run.push(format!("{id} = {r}"));
            shown.push(format!("{id} = {s}"));
        }
        Ok((run.join(" AND "), shown.join(" AND ")))
    };
    let unchanged = |original: &Option<Fields>| -> SqlResult<(String, String)> {
        let (mut run, mut shown) = (String::new(), String::new());
        let Some(original) = original else { return Ok((run, shown)) };
        for (c, v) in original {
            let m = col(c)?;
            let v = string_or_null(v)?;
            let id = my_ident(c)?;
            let Some(v) = v else {
                let part = format!(" AND {id} IS NULL");
                run.push_str(&part);
                shown.push_str(&part);
                continue;
            };
            if !comparable(&m.data_type) {
                continue;
            }
            let (r, s) = lit(m, Some(v));
            if STRING_TYPES.contains(&m.data_type.to_lowercase().as_str()) {
                let left = format!("CONVERT({id} USING utf8mb4) COLLATE utf8mb4_bin");
                let _ = write!(run, " AND {left} = {r}");
                let _ = write!(shown, " AND {left} = {s}");
            } else {
                let _ = write!(run, " AND {id} = {r}");
                let _ = write!(shown, " AND {id} = {s}");
            }
        }
        Ok((run, shown))
    };
    let mut built = Vec::with_capacity(edits.len());
    for (index, e) in edits.iter().enumerate() {
        let st = match e {
            StagedEdit::Update { key, set, original } => {
                if set.is_empty() {
                    return Err(DbSqlError::Invalid);
                }
                let (mut run, mut shown) = (Vec::new(), Vec::new());
                for (c, v) in set {
                    let m = writable(c)?;
                    let (r, s) = lit(m, string_or_null(v)?);
                    let id = my_ident(c)?;
                    run.push(format!("{id} = {r}"));
                    shown.push(format!("{id} = {s}"));
                }
                for (k, _) in key {
                    col(k)?;
                }
                let w = where_(key)?;
                let u = unchanged(original)?;
                BuiltStatement {
                    op: EditOp::Update,
                    index,
                    sql: format!("UPDATE {target} SET {} WHERE {}{}", run.join(", "), w.0, u.0),
                    preview: format!("UPDATE {target} SET {} WHERE {}{}", shown.join(", "), w.1, u.1),
                }
            }
            StagedEdit::Delete { key, original } => {
                for (k, _) in key {
                    col(k)?;
                }
                let w = where_(key)?;
                let u = unchanged(original)?;
                BuiltStatement {
                    op: EditOp::Delete,
                    index,
                    sql: format!("DELETE FROM {target} WHERE {}{}", w.0, u.0),
                    preview: format!("DELETE FROM {target} WHERE {}{}", w.1, u.1),
                }
            }
            StagedEdit::Insert { values } => {
                if values.is_empty() {
                    let sql = format!("INSERT INTO {target} () VALUES ()");
                    BuiltStatement { op: EditOp::Insert, index, sql: sql.clone(), preview: sql }
                } else {
                    let mut cols = Vec::with_capacity(values.len());
                    for (c, _) in values {
                        writable(c)?;
                        cols.push(my_ident(c)?);
                    }
                    let (mut run, mut shown) = (Vec::new(), Vec::new());
                    for (c, v) in values {
                        let m = col(c)?;
                        let (r, s) = lit(m, string_or_null(v)?);
                        run.push(r);
                        shown.push(s);
                    }
                    let cols = cols.join(", ");
                    BuiltStatement {
                        op: EditOp::Insert,
                        index,
                        sql: format!("INSERT INTO {target} ({cols}) VALUES ({})", run.join(", ")),
                        preview: format!("INSERT INTO {target} ({cols}) VALUES ({})", shown.join(", ")),
                    }
                }
            }
        };
        built.push(st);
    }
    Ok(built)
}

/// `mysqlEditPreview`: "START TRANSACTION; ...; COMMIT;" (readable literals).
pub fn mysql_edit_preview(statements: &[BuiltStatement]) -> String {
    let mut lines = vec!["START TRANSACTION;".to_owned()];
    lines.extend(statements.iter().map(|s| format!("{};", s.preview)));
    lines.push("COMMIT;".into());
    lines.join("\n")
}

/// `mysqlErrorText`: "ERROR 1146 (42S02): Table 'x.y' doesn't exist".
pub fn mysql_error_text(errno: Option<f64>, sql_state: Option<&str>, message: &str) -> String {
    match errno {
        Some(e) if e != 0.0 && !e.is_nan() => match sql_state.filter(|s| !s.is_empty()) {
            Some(state) => format!("ERROR {} ({state}): {message}", js_number(e)),
            None => format!("ERROR {}: {message}", js_number(e)),
        },
        _ => message.to_owned(),
    }
}

/// `mysqlErrorPosition`: the 1-based position "... near 'FRM t' at line 2" names in a statement (UTF-16 units); "near ''" is
/// the end. None when the message names no place or the text is not found on that line or after it.
pub fn mysql_error_position(message: &str, sql: &str) -> Option<usize> {
    let m = units(message);
    let (near, line) = near_at_line(&m)?;
    let line_digits = scan::text(line);
    // Number(digits): a huge line number is a huge number (the newline search below runs out first).
    let line_no: u128 =
        line_digits.trim_start_matches('0').parse().unwrap_or(if line_digits.bytes().all(|b| b == b'0') { 0 } else { u128::MAX });
    if line_no < 1 {
        return None;
    }
    let s = units(sql);
    let mut line_start = 0usize;
    let mut l: u128 = 1;
    while l < line_no {
        let nl = newline_from(&s, line_start)?;
        line_start = nl + 1;
        l += 1;
    }
    if near.is_empty() {
        return Some(s.len() + 1);
    }
    if let Some(at) = scan::index_of(&s, near, line_start) {
        return Some(at + 1);
    }
    let head = &near[..near.len().min(20)];
    scan::index_of(&s, head, line_start).map(|at| at + 1)
}

/// `/near '([\s\S]*)' at line (\d+)\s*$/.exec(message)`: the text and the line digits.
fn near_at_line(m: &[u16]) -> Option<(&[u16], &[u16])> {
    let tail = units("' at line ");
    // The last place the suffix matches (the greedy [\s\S]* takes the longest text).
    let mut best: Option<(usize, usize, usize)> = None;
    for p in (0..m.len()).rev() {
        if !scan::starts_with_at(m, p, &tail) {
            continue;
        }
        let d0 = p + tail.len();
        let mut d1 = d0;
        while d1 < m.len() && scan::is_digit(m[d1]) {
            d1 += 1;
        }
        if d1 == d0 || scan::skip_spaces(m, d1) != m.len() {
            continue;
        }
        best = Some((p, d0, d1));
        break;
    }
    let (p, d0, d1) = best?;
    let start = scan::index_of(m, &units("near '"), 0)?;
    if start + 6 > p {
        return None;
    }
    Some((&m[start + 6..p], &m[d0..d1]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn literals_and_labels() {
        assert_eq!(mysql_literal(Some("O'Brien\\"), false), "_utf8mb4 X'4f27427269656e5c'");
        assert_eq!(mysql_literal(Some("\\x0AFF"), true), "X'0aff'");
        assert_eq!(mysql_display_literal(Some("it's a \\ test")), "'it''s a \\\\ test'");
        assert_eq!(mysql_timeout_sql(Flavor::Mariadb, Some(1500.0)), "SET SESSION max_statement_time = 1.500");
        assert_eq!(mysql_timeout_sql(Flavor::Mysql, Some(-3.5)), "SET SESSION max_execution_time = 0");
        assert_eq!(mysql_server_label("5.5.5-10.6.12-MariaDB-1:10.6.12+maria~ubu2004", ""), "MariaDB 10.6.12");
        assert_eq!(mysql_server_label("8.0.36-log", ""), "MySQL 8.0.36");
        assert_eq!(mysql_server_label("weird", ""), "MySQL weird");
    }

    #[test]
    fn error_positions() {
        let msg = |near: &str, line: u32| {
            format!(
                "ERROR 1064 (42000): You have an error in your SQL syntax; check the manual that corresponds to your MySQL server version for the right syntax to use near '{near}' at line {line}"
            )
        };
        assert_eq!(mysql_error_position(&msg("FRM t", 2), "SELECT *\nFRM t"), Some(10));
        assert_eq!(mysql_error_position(&msg("x", 2), "SELECT x\nFROM x"), Some(15));
        assert_eq!(mysql_error_position(&msg("", 1), "SELECT ("), Some(9));
        assert_eq!(mysql_error_position(&msg("'abc' FRM t", 1), "SELECT 'abc' FRM t"), Some(8));
        assert_eq!(mysql_error_position("ERROR 1146: Table 'a.b' doesn't exist", "SELECT 1"), None);
    }
}
