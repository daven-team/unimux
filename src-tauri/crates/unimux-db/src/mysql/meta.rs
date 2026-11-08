//! MySQL / MariaDB catalog reads (1.1.4 src/dbhost/mysqlMeta.ts): databases, the tables, views, routines, triggers and
//! events of a database, a table's columns, keys, indexes and constraints (information_schema), and the CREATE statement of
//! an object (SHOW CREATE ...). A MySQL database is what Postgres calls a schema: every request names it as `schema`.
//! Values are written as hex literals (`mysql_literal`), never escaped on the client. Works with MySQL 5.7 / 8 / 9 and
//! MariaDB 10.3 and newer.

use std::cmp::Ordering;
use std::collections::HashMap;

use futures::future::BoxFuture;
use serde_json::{Map, Value, json};
use unimux_core::utf16::{is_js_space_char, js_trim_end};

use crate::sql::mysql::{my_ident, my_qualified, mysql_column_kind, mysql_literal};
use crate::sql::values::js_to_number;
use crate::sql::{DbSqlError, ValueKind};

/// A catalog row: every value as text.
pub type MyRow = Vec<Option<String>>;

/// Why a catalog read failed: the connection / server, or a name the SQL builders refuse.
#[derive(Debug, Clone, PartialEq)]
pub enum MetaError {
    My(super::MyError),
    Sql(DbSqlError),
}

/// A read on the session's connection (rows in array mode, every value as text).
pub trait MyQuery: Send {
    fn q<'a>(&'a mut self, sql: &'a str) -> BoxFuture<'a, Result<Vec<MyRow>, MetaError>>;
}

fn at(r: &MyRow, i: usize) -> Option<&str> {
    r.get(i).and_then(|v| v.as_deref())
}

fn s(r: &MyRow, i: usize) -> String {
    at(r, i).unwrap_or("").to_owned()
}

fn lit(v: &str) -> String {
    mysql_literal(Some(v), false)
}

fn sql_err(e: DbSqlError) -> MetaError {
    MetaError::Sql(e)
}

/// `opt(key, v)`: the key only for a non-empty value.
fn opt(m: &mut Map<String, Value>, key: &str, v: Option<&str>) {
    if let Some(v) = v.filter(|v| !v.is_empty()) {
        m.insert(key.into(), json!(v));
    }
}

/// `Number(text)` as JSON (NaN and infinities are `null`, as JSON.stringify writes them).
pub(crate) fn number_json(text: &str) -> Value {
    let n = js_to_number(text);
    if !n.is_finite() {
        return Value::Null;
    }
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        return json!(n as i64);
    }
    json!(n)
}

const SYSTEM_DATABASES: [&str; 4] = ["information_schema", "mysql", "performance_schema", "sys"];

/// The primary level of ICU's root collation for the characters database names hold: blanks, punctuation and symbols
/// before digits before letters; letters without case.
fn collation_class(c: char) -> u8 {
    if c.is_alphabetic() {
        2
    } else if c.is_numeric() {
        1
    } else {
        0
    }
}

/// `a.localeCompare(b)` (ICU root collation, approximated: primary class and case-folded character first, lower case
/// before upper case on a tie, then the code points).
pub fn locale_compare(a: &str, b: &str) -> Ordering {
    let fold = |s: &str| -> Vec<(u8, String)> { s.chars().map(|c| (collation_class(c), c.to_lowercase().collect())).collect() };
    let (fa, fb) = (fold(a), fold(b));
    fa.cmp(&fb)
        .then_with(|| {
            for (x, y) in a.chars().zip(b.chars()) {
                if x != y {
                    // lower case first
                    return match (x.is_lowercase(), y.is_lowercase()) {
                        (true, false) => Ordering::Less,
                        (false, true) => Ordering::Greater,
                        _ => x.cmp(&y),
                    };
                }
            }
            Ordering::Equal
        })
        .then_with(|| a.cmp(b))
}

struct Database {
    name: String,
    encoding: String,
    system: bool,
}

async fn databases(q: &mut dyn MyQuery) -> Result<Vec<Database>, MetaError> {
    let rows =
        q.q("SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME").await?;
    let mut out: Vec<Database> = rows
        .iter()
        .map(|r| {
            let name = s(r, 0);
            let system = SYSTEM_DATABASES.contains(&name.to_lowercase().as_str());
            Database { name, encoding: s(r, 1), system }
        })
        .collect();
    out.sort_by(|a, b| a.system.cmp(&b.system).then_with(|| locale_compare(&a.name, &b.name)));
    Ok(out)
}

/// `listDatabases`.
pub async fn list_databases(q: &mut dyn MyQuery) -> Result<Value, MetaError> {
    let list = databases(q).await?;
    Ok(Value::Array(
        list.into_iter()
            .map(|d| {
                let mut v = json!({
                    "name": d.name, "owner": "", "encoding": d.encoding, "isTemplate": false, "allowConnections": true,
                    "sizeBytes": null,
                });
                if d.system {
                    v["system"] = json!(true);
                }
                v
            })
            .collect(),
    ))
}

/// `listSchemas`: MySQL has no schemas inside a database: the databases are the schemas.
pub async fn list_schemas(q: &mut dyn MyQuery) -> Result<Value, MetaError> {
    let list = databases(q).await?;
    Ok(Value::Array(list.into_iter().map(|d| json!({ "name": d.name, "owner": "", "system": d.system })).collect()))
}

fn table_kind(t: Option<&str>) -> &'static str {
    match t {
        Some("VIEW" | "SYSTEM VIEW") => "view",
        Some("SEQUENCE") => "sequence",
        _ => "table",
    }
}

/// `listObjects`.
pub async fn list_objects(q: &mut dyn MyQuery, db: &str) -> Result<Value, MetaError> {
    let l = lit(db);
    let tables = q
        .q(&format!(
            "SELECT TABLE_NAME, TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = {l} ORDER BY TABLE_NAME"
        ))
        .await?;
    // routines are a bonus: a server that refuses them still shows its tables
    let routines = q
        .q(&format!(
            "SELECT ROUTINE_NAME, ROUTINE_TYPE, DTD_IDENTIFIER, ROUTINE_COMMENT FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = {l} ORDER BY ROUTINE_NAME"
        ))
        .await
        .unwrap_or_default();
    let mut out: Vec<Value> = Vec::new();
    for r in &tables {
        let kind = table_kind(at(r, 1));
        // InnoDB views carry "VIEW" as their comment.
        let comment = if kind == "view" && at(r, 3) == Some("VIEW") { None } else { at(r, 3) };
        let mut m = Map::new();
        m.insert("schema".into(), json!(db));
        m.insert("name".into(), json!(s(r, 0)));
        m.insert("kind".into(), json!(kind));
        m.insert("oid".into(), json!(0));
        if kind == "table" {
            m.insert("rowEstimate".into(), at(r, 2).map_or(Value::Null, number_json));
        }
        opt(&mut m, "comment", comment);
        out.push(Value::Object(m));
    }
    for r in &routines {
        let mut m = Map::new();
        m.insert("schema".into(), json!(db));
        m.insert("name".into(), json!(s(r, 0)));
        m.insert("kind".into(), json!(if at(r, 1) == Some("PROCEDURE") { "procedure" } else { "function" }));
        m.insert("oid".into(), json!(0));
        opt(&mut m, "returns", at(r, 2));
        opt(&mut m, "comment", at(r, 3));
        out.push(Value::Object(m));
    }
    // Triggers and events (1.0.6) are bonuses too: a user without the TRIGGER or EVENT privilege on the database sees none.
    if let Ok(triggers) = q
        .q(&format!(
            "SELECT TRIGGER_NAME, ACTION_TIMING, EVENT_MANIPULATION, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = {l} ORDER BY TRIGGER_NAME"
        ))
        .await
    {
        for r in &triggers {
            let on = at(r, 3).filter(|t| !t.is_empty()).map(|t| format!("ON {t}"));
            let detail = [at(r, 1).map(str::to_owned), at(r, 2).map(str::to_owned), on]
                .into_iter()
                .flatten()
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
                .join(" ");
            let mut m = Map::new();
            m.insert("schema".into(), json!(db));
            m.insert("name".into(), json!(s(r, 0)));
            m.insert("kind".into(), json!("trigger"));
            m.insert("oid".into(), json!(0));
            opt(&mut m, "detail", Some(&detail));
            out.push(Value::Object(m));
        }
    }
    if let Ok(events) = q
        .q(&format!(
            "SELECT EVENT_NAME, EVENT_TYPE, INTERVAL_VALUE, INTERVAL_FIELD, EXECUTE_AT, STATUS, EVENT_COMMENT FROM information_schema.EVENTS WHERE EVENT_SCHEMA = {l} ORDER BY EVENT_NAME"
        ))
        .await
    {
        for r in &events {
            let when: Option<String> = if at(r, 1) == Some("RECURRING") {
                Some(
                    unimux_core::utf16::js_trim(&format!("EVERY {} {}", at(r, 2).unwrap_or("?"), at(r, 3).unwrap_or("")))
                        .to_owned(),
                )
            } else if let Some(x) = at(r, 4).filter(|x| !x.is_empty()) {
                Some(format!("AT {x}"))
            } else {
                at(r, 1).map(str::to_owned)
            };
            let detail = [when, at(r, 5).map(str::to_owned)]
                .into_iter()
                .flatten()
                .filter(|p| !p.is_empty())
                .collect::<Vec<_>>()
                .join(" \u{b7} ");
            let mut m = Map::new();
            m.insert("schema".into(), json!(db));
            m.insert("name".into(), json!(s(r, 0)));
            m.insert("kind".into(), json!("event"));
            m.insert("oid".into(), json!(0));
            opt(&mut m, "detail", Some(&detail));
            opt(&mut m, "comment", at(r, 6));
            out.push(Value::Object(m));
        }
    }
    Ok(Value::Array(out))
}

/// EXTRA of a generated column ("VIRTUAL GENERATED", "STORED GENERATED", MariaDB "PERSISTENT"), not MySQL 8's
/// DEFAULT_GENERATED: `/(?:^|\s)(?:VIRTUAL|STORED|PERSISTENT)(?:\s+GENERATED)?(?:\s|$)/i`, which is a blank-separated word.
pub fn is_generated(extra: &str) -> bool {
    extra.split(is_js_space_char).any(|w| ["VIRTUAL", "STORED", "PERSISTENT"].iter().any(|k| w.eq_ignore_ascii_case(k)))
}

/// One column of [`TableInfo`] (`DbColumnInfo`).
#[derive(Debug, Clone, PartialEq)]
pub struct ColumnInfo {
    pub name: String,
    pub position: Value,
    pub type_name: String,
    pub kind: ValueKind,
    pub nullable: bool,
    pub default: Option<String>,
    pub identity: bool,
    pub generated: bool,
    pub comment: Option<String>,
}

/// `MysqlTableInfo`: `DbTableInfo` plus the information_schema DATA_TYPE of each column (edits pick literals and checks by
/// it).
#[derive(Debug, Clone, PartialEq)]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    pub kind: &'static str,
    pub row_estimate: Value,
    pub columns: Vec<ColumnInfo>,
    pub primary_key: Option<Vec<String>>,
    pub unique_keys: Vec<Vec<String>>,
    pub edit_key: Option<Vec<String>>,
    pub indexes: Vec<Value>,
    pub constraints: Vec<Value>,
    pub comment: Option<String>,
    pub data_types: HashMap<String, String>,
}

impl TableInfo {
    /// The `DbTableInfo` the renderer gets (without `dataTypes`).
    pub fn to_json(&self) -> Value {
        let columns: Vec<Value> = self
            .columns
            .iter()
            .map(|c| {
                let mut m = Map::new();
                m.insert("name".into(), json!(c.name));
                m.insert("position".into(), c.position.clone());
                m.insert("typeName".into(), json!(c.type_name));
                m.insert("typeOid".into(), json!(0));
                m.insert("kind".into(), json!(c.kind.as_str()));
                m.insert("nullable".into(), json!(c.nullable));
                m.insert("default".into(), json!(c.default));
                m.insert("identity".into(), json!(c.identity));
                m.insert("generated".into(), json!(c.generated));
                opt(&mut m, "comment", c.comment.as_deref());
                Value::Object(m)
            })
            .collect();
        let mut m = Map::new();
        m.insert("schema".into(), json!(self.schema));
        m.insert("name".into(), json!(self.name));
        m.insert("kind".into(), json!(self.kind));
        m.insert("oid".into(), json!(0));
        m.insert("rowEstimate".into(), self.row_estimate.clone());
        m.insert("columns".into(), Value::Array(columns));
        m.insert("primaryKey".into(), json!(self.primary_key));
        m.insert("uniqueKeys".into(), json!(self.unique_keys));
        m.insert("editKey".into(), json!(self.edit_key));
        m.insert("indexes".into(), Value::Array(self.indexes.clone()));
        m.insert("constraints".into(), Value::Array(self.constraints.clone()));
        opt(&mut m, "comment", self.comment.as_deref());
        Value::Object(m)
    }
}

struct IndexEntry {
    unique: bool,
    columns: Vec<String>,
    prefix: bool,
    expression: bool,
    kind: String,
}

struct ConEntry {
    kind: &'static str,
    columns: Vec<String>,
    ref_db: Option<String>,
    ref_table: Option<String>,
    ref_columns: Vec<String>,
}

/// An insertion-ordered map (JS `Map`).
struct Ordered<T> {
    keys: Vec<String>,
    map: HashMap<String, T>,
}

impl<T> Ordered<T> {
    fn new() -> Self {
        Ordered { keys: Vec::new(), map: HashMap::new() }
    }
    fn entry(&mut self, key: &str, make: impl FnOnce() -> T) -> &mut T {
        if !self.map.contains_key(key) {
            self.keys.push(key.to_owned());
            self.map.insert(key.to_owned(), make());
        }
        self.map.get_mut(key).expect("just inserted")
    }
    fn iter(&self) -> impl Iterator<Item = (&String, &T)> {
        self.keys.iter().map(|k| (k, &self.map[k]))
    }
    fn get(&self, key: &str) -> Option<&T> {
        self.map.get(key)
    }
}

/// `tableInfo`: None when the table does not exist.
pub async fn table_info(q: &mut dyn MyQuery, db: &str, name: &str) -> Result<Option<TableInfo>, MetaError> {
    let (ldb, lname) = (lit(db), lit(name));
    let rel = q
        .q(&format!(
            "SELECT TABLE_TYPE, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = {ldb} AND TABLE_NAME = {lname}"
        ))
        .await?;
    let Some(rel) = rel.into_iter().next() else { return Ok(None) };
    let kind = table_kind(at(&rel, 0));
    let col_rows = q
        .q(&format!(
            "SELECT COLUMN_NAME, ORDINAL_POSITION, COLUMN_TYPE, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT\n    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = {ldb} AND TABLE_NAME = {lname} ORDER BY ORDINAL_POSITION"
        ))
        .await?;
    let mut data_types = HashMap::new();
    let columns: Vec<ColumnInfo> = col_rows
        .iter()
        .map(|r| {
            let col_name = s(r, 0);
            let column_type = s(r, 2);
            let data_type = s(r, 3).to_lowercase();
            let extra = s(r, 6);
            data_types.insert(col_name.clone(), data_type.clone());
            ColumnInfo {
                name: col_name,
                position: number_json(at(r, 1).unwrap_or("0")),
                kind: mysql_column_kind(&data_type, &column_type),
                type_name: column_type,
                nullable: at(r, 4) == Some("YES"),
                default: at(r, 5).map(str::to_owned),
                identity: extra.to_lowercase().contains("auto_increment"),
                generated: is_generated(&extra),
                comment: at(r, 7).map(str::to_owned),
            }
        })
        .collect();
    let not_null: Vec<&str> = columns.iter().filter(|c| !c.nullable).map(|c| c.name.as_str()).collect();
    let idx_rows = q
        .q(&format!(
            "SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SUB_PART, INDEX_TYPE FROM information_schema.STATISTICS\n    WHERE TABLE_SCHEMA = {ldb} AND TABLE_NAME = {lname} ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX"
        ))
        .await?;
    let mut by_index: Ordered<IndexEntry> = Ordered::new();
    for r in &idx_rows {
        let idx = s(r, 0);
        let e = by_index.entry(&idx, || IndexEntry {
            unique: at(r, 1) == Some("0"),
            columns: Vec::new(),
            prefix: false,
            expression: false,
            kind: s(r, 4),
        });
        match at(r, 2) {
            None => e.expression = true,
            Some(c) => e.columns.push(c.to_owned()),
        }
        if at(r, 3).is_some() {
            e.prefix = true;
        }
    }
    let mut indexes = Vec::new();
    for (idx, e) in by_index.iter() {
        let cols = e.columns.iter().map(|c| my_ident(c)).collect::<Result<Vec<_>, _>>().map_err(sql_err)?.join(", ");
        let head = if idx == "PRIMARY" {
            "PRIMARY KEY".to_owned()
        } else {
            format!("{}INDEX {}", if e.unique { "UNIQUE " } else { "" }, my_ident(idx).map_err(sql_err)?)
        };
        let expr = if e.expression { format!("{}(...)", if e.columns.is_empty() { "" } else { ", " }) } else { String::new() };
        let using = if !e.kind.is_empty() && e.kind != "BTREE" { format!(" USING {}", e.kind) } else { String::new() };
        indexes.push(json!({
            "name": idx, "unique": e.unique, "primary": idx == "PRIMARY", "columns": e.columns,
            "definition": format!("{head} ({cols}{expr}){using}"),
        }));
    }
    let primary_key = by_index.get("PRIMARY").filter(|pk| !pk.prefix && !pk.expression).map(|pk| pk.columns.clone());
    let unique_keys: Vec<Vec<String>> = by_index
        .iter()
        .filter(|(idx, e)| {
            idx.as_str() != "PRIMARY"
                && e.unique
                && !e.prefix
                && !e.expression
                && !e.columns.is_empty()
                && e.columns.iter().all(|c| not_null.contains(&c.as_str()))
        })
        .map(|(_, e)| e.columns.clone())
        .collect();
    let con_rows = q
        .q(&format!(
            "SELECT tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME\n    FROM information_schema.TABLE_CONSTRAINTS tc\n    LEFT JOIN information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = tc.CONSTRAINT_NAME AND k.TABLE_SCHEMA = tc.TABLE_SCHEMA AND k.TABLE_NAME = tc.TABLE_NAME\n    WHERE tc.TABLE_SCHEMA = {ldb} AND tc.TABLE_NAME = {lname} ORDER BY tc.CONSTRAINT_NAME, k.ORDINAL_POSITION"
        ))
        .await?;
    let mut by_con: Ordered<ConEntry> = Ordered::new();
    let mut con_names: HashMap<String, String> = HashMap::new();
    for r in &con_rows {
        let kind = match at(r, 1) {
            Some("PRIMARY KEY") => "p",
            Some("UNIQUE") => "u",
            Some("FOREIGN KEY") => "f",
            Some("CHECK") => "c",
            _ => continue,
        };
        let key = format!("{kind}\0{}", s(r, 0));
        con_names.insert(key.clone(), s(r, 0));
        let e = by_con.entry(&key, || ConEntry {
            kind,
            columns: Vec::new(),
            ref_db: at(r, 3).map(str::to_owned),
            ref_table: at(r, 4).map(str::to_owned),
            ref_columns: Vec::new(),
        });
        if let Some(c) = at(r, 2) {
            e.columns.push(c.to_owned());
        }
        if let Some(c) = at(r, 5) {
            e.ref_columns.push(c.to_owned());
        }
    }
    let mut checks: HashMap<String, String> = HashMap::new();
    if by_con.iter().any(|(_, c)| c.kind == "c") {
        // older servers: the name is enough
        if let Ok(rows) = q
            .q(&format!(
                "SELECT CONSTRAINT_NAME, CHECK_CLAUSE FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = {ldb}"
            ))
            .await
        {
            for r in &rows {
                checks.insert(s(r, 0), s(r, 1));
            }
        }
    }
    let idents = |cols: &[String]| -> Result<String, MetaError> {
        Ok(cols.iter().map(|c| my_ident(c)).collect::<Result<Vec<_>, _>>().map_err(sql_err)?.join(", "))
    };
    let mut constraints = Vec::new();
    for (key, c) in by_con.iter() {
        let con_name = con_names.get(key).cloned().unwrap_or_default();
        let cols = idents(&c.columns)?;
        let definition = match c.kind {
            "p" => format!("PRIMARY KEY ({cols})"),
            "u" => format!("UNIQUE ({cols})"),
            "f" => {
                let target = match (&c.ref_table, &c.ref_db) {
                    (Some(t), Some(rdb)) if !t.is_empty() && !rdb.is_empty() && rdb != db => {
                        my_qualified(rdb, t).map_err(sql_err)?
                    }
                    (Some(t), _) if !t.is_empty() => my_ident(t).map_err(sql_err)?,
                    _ => "?".to_owned(),
                };
                format!("FOREIGN KEY ({cols}) REFERENCES {target} ({})", idents(&c.ref_columns)?)
            }
            _ => format!("CHECK ({})", checks.get(&con_name).map_or("...", String::as_str)),
        };
        constraints.push(json!({
            "name": if con_name == "PRIMARY" { "PRIMARY KEY".to_owned() } else { con_name },
            "type": c.kind, "definition": definition, "columns": c.columns,
        }));
    }
    // Views have no keys of their own: they are not edited (like Postgres views).
    let edit_key = if kind == "table" { primary_key.clone().or_else(|| unique_keys.first().cloned()) } else { None };
    let row_estimate = match at(&rel, 1) {
        Some(n) if kind == "table" => number_json(n),
        _ => Value::Null,
    };
    let comment = if kind == "view" && at(&rel, 2) == Some("VIEW") { None } else { at(&rel, 2).map(str::to_owned) };
    Ok(Some(TableInfo {
        schema: db.to_owned(),
        name: name.to_owned(),
        kind,
        row_estimate,
        columns,
        primary_key,
        unique_keys,
        edit_key,
        indexes,
        constraints,
        comment,
        data_types,
    }))
}

/// `objectDdl`: the CREATE statement of a table, view, sequence (MariaDB), function, procedure, trigger or event; None
/// when the server shows none.
pub async fn object_ddl(q: &mut dyn MyQuery, db: &str, name: &str, kind: &str) -> Result<Option<String>, MetaError> {
    let target = my_qualified(db, name).map_err(sql_err)?;
    // SHOW CREATE TRIGGER: Trigger, sql_mode, SQL Original Statement, ...; SHOW CREATE EVENT: Event, sql_mode, time_zone,
    // Create Event, ...
    let (what, column) = match kind {
        "view" => ("VIEW", 1),
        "sequence" => ("SEQUENCE", 1),
        "function" => ("FUNCTION", 2),
        "procedure" => ("PROCEDURE", 2),
        "trigger" => ("TRIGGER", 2),
        "event" => ("EVENT", 3),
        _ => ("TABLE", 1),
    };
    let rows = q.q(&format!("SHOW CREATE {what} {target}")).await?;
    let text = rows.first().and_then(|r| at(r, column)).filter(|t| !t.is_empty());
    Ok(text.map(|t| format!("{};\n", js_trim_end(t))))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Answers each statement from a list of (prefix, rows); an unknown statement fails like a server error.
    struct Script(Vec<(&'static str, Vec<MyRow>)>, Vec<String>);

    impl MyQuery for Script {
        fn q<'a>(&'a mut self, sql: &'a str) -> BoxFuture<'a, Result<Vec<MyRow>, MetaError>> {
            self.1.push(sql.to_owned());
            let found = self.0.iter().find(|(p, _)| sql.starts_with(p)).map(|(_, r)| r.clone());
            Box::pin(async move {
                found.ok_or(MetaError::My(super::super::MyError::Server(super::super::MyServerError {
                    code: 1142,
                    state: "42000".into(),
                    message: "denied".into(),
                })))
            })
        }
    }

    fn row(v: &[Option<&str>]) -> MyRow {
        v.iter().map(|x| x.map(str::to_owned)).collect()
    }

    #[test]
    fn generated_columns_by_their_extra() {
        assert!(is_generated("VIRTUAL GENERATED"));
        assert!(is_generated("stored generated"));
        assert!(is_generated("PERSISTENT"));
        assert!(!is_generated("DEFAULT_GENERATED"));
        assert!(!is_generated("DEFAULT_GENERATED on update CURRENT_TIMESTAMP"));
        assert!(!is_generated("auto_increment"));
        assert!(!is_generated(""));
    }

    #[test]
    fn databases_sort_like_locale_compare() {
        assert_eq!(locale_compare("a_b", "a1"), Ordering::Less);
        assert_eq!(locale_compare("Shop", "shop"), Ordering::Greater);
        assert_eq!(locale_compare("apple", "Banana"), Ordering::Less);
        assert_eq!(locale_compare("x", "x"), Ordering::Equal);
    }

    #[test]
    fn numbers_as_json_numbers() {
        assert_eq!(number_json("42"), json!(42));
        assert_eq!(number_json(""), json!(0));
        assert_eq!(number_json("x"), Value::Null);
        assert_eq!(number_json("1.5"), json!(1.5));
    }

    #[tokio::test]
    async fn table_info_reads_keys_indexes_and_constraints() {
        let mut q = Script(
            vec![
                ("SELECT TABLE_TYPE", vec![row(&[Some("BASE TABLE"), Some("12"), Some("")])]),
                (
                    "SELECT COLUMN_NAME",
                    vec![
                        row(&[
                            Some("id"),
                            Some("1"),
                            Some("int unsigned"),
                            Some("INT"),
                            Some("NO"),
                            None,
                            Some("auto_increment"),
                            Some(""),
                        ]),
                        row(&[
                            Some("code"),
                            Some("2"),
                            Some("varchar(10)"),
                            Some("varchar"),
                            Some("NO"),
                            None,
                            Some(""),
                            Some("the code"),
                        ]),
                        row(&[
                            Some("total"),
                            Some("3"),
                            Some("int"),
                            Some("int"),
                            Some("YES"),
                            None,
                            Some("STORED GENERATED"),
                            None,
                        ]),
                    ],
                ),
                (
                    "SELECT INDEX_NAME",
                    vec![
                        row(&[Some("PRIMARY"), Some("0"), Some("id"), None, Some("BTREE")]),
                        row(&[Some("code_u"), Some("0"), Some("code"), None, Some("BTREE")]),
                        row(&[Some("ft"), Some("1"), Some("code"), None, Some("FULLTEXT")]),
                        row(&[Some("expr"), Some("1"), None, None, Some("BTREE")]),
                    ],
                ),
                (
                    "SELECT tc.CONSTRAINT_NAME",
                    vec![
                        row(&[Some("PRIMARY"), Some("PRIMARY KEY"), Some("id"), None, None, None]),
                        row(&[Some("fk"), Some("FOREIGN KEY"), Some("code"), Some("other"), Some("codes"), Some("c")]),
                        row(&[Some("chk"), Some("CHECK"), None, None, None, None]),
                    ],
                ),
                ("SELECT CONSTRAINT_NAME, CHECK_CLAUSE", vec![row(&[Some("chk"), Some("`total` > 0")])]),
            ],
            Vec::new(),
        );
        let info = table_info(&mut q, "shop", "t").await.unwrap().unwrap();
        assert!(q.1[0].contains("TABLE_SCHEMA = _utf8mb4 X'73686f70'"));
        assert_eq!(info.primary_key, Some(vec!["id".to_owned()]));
        assert_eq!(info.unique_keys, vec![vec!["code".to_owned()]]);
        assert_eq!(info.edit_key, Some(vec!["id".to_owned()]));
        assert_eq!(info.data_types["id"], "int");
        let v = info.to_json();
        assert_eq!(v["rowEstimate"], json!(12));
        assert_eq!(v["columns"][0]["kind"], json!("bigint"));
        assert_eq!(v["columns"][0]["identity"], json!(true));
        assert_eq!(v["columns"][1]["comment"], json!("the code"));
        assert_eq!(v["columns"][2]["generated"], json!(true));
        assert!(v.get("comment").is_none());
        assert_eq!(v["indexes"][0]["definition"], json!("PRIMARY KEY (`id`)"));
        assert_eq!(v["indexes"][1]["definition"], json!("UNIQUE INDEX `code_u` (`code`)"));
        assert_eq!(v["indexes"][2]["definition"], json!("INDEX `ft` (`code`) USING FULLTEXT"));
        assert_eq!(v["indexes"][3]["definition"], json!("INDEX `expr` ((...))"));
        assert_eq!(
            v["constraints"][0],
            json!({"name": "PRIMARY KEY", "type": "p", "definition": "PRIMARY KEY (`id`)", "columns": ["id"]})
        );
        assert_eq!(v["constraints"][1]["definition"], json!("FOREIGN KEY (`code`) REFERENCES `other`.`codes` (`c`)"));
        assert_eq!(v["constraints"][2]["definition"], json!("CHECK (`total` > 0)"));
        let keys: Vec<&String> = v.as_object().unwrap().keys().collect();
        assert_eq!(
            keys,
            [
                "schema",
                "name",
                "kind",
                "oid",
                "rowEstimate",
                "columns",
                "primaryKey",
                "uniqueKeys",
                "editKey",
                "indexes",
                "constraints"
            ]
        );
    }

    #[tokio::test]
    async fn objects_keep_tables_when_the_bonuses_are_refused() {
        let mut q = Script(
            vec![(
                "SELECT TABLE_NAME",
                vec![
                    row(&[Some("t"), Some("BASE TABLE"), Some("3"), Some("")]),
                    row(&[Some("v"), Some("VIEW"), None, Some("VIEW")]),
                ],
            )],
            Vec::new(),
        );
        let v = list_objects(&mut q, "shop").await.unwrap();
        assert_eq!(
            v,
            json!([
                {"schema": "shop", "name": "t", "kind": "table", "oid": 0, "rowEstimate": 3},
                {"schema": "shop", "name": "v", "kind": "view", "oid": 0},
            ])
        );
        let mut q = Script(
            vec![
                ("SELECT TABLE_NAME", vec![]),
                ("SELECT ROUTINE_NAME", vec![row(&[Some("p"), Some("PROCEDURE"), None, None])]),
                ("SELECT TRIGGER_NAME", vec![row(&[Some("tr"), Some("BEFORE"), Some("INSERT"), Some("t")])]),
                (
                    "SELECT EVENT_NAME",
                    vec![row(&[Some("e"), Some("RECURRING"), Some("1"), Some("DAY"), None, Some("ENABLED"), None])],
                ),
            ],
            Vec::new(),
        );
        let v = list_objects(&mut q, "shop").await.unwrap();
        assert_eq!(v[0], json!({"schema": "shop", "name": "p", "kind": "procedure", "oid": 0}));
        assert_eq!(v[1]["detail"], json!("BEFORE INSERT ON t"));
        assert_eq!(v[2]["detail"], json!("EVERY 1 DAY \u{b7} ENABLED"));
    }

    #[tokio::test]
    async fn ddl_is_trimmed_and_ends_with_a_semicolon() {
        let mut q = Script(
            vec![("SHOW CREATE PROCEDURE", vec![row(&[Some("p"), Some("m"), Some("CREATE PROCEDURE p() BEGIN END \n")])])],
            Vec::new(),
        );
        assert_eq!(object_ddl(&mut q, "db", "p", "procedure").await.unwrap(), Some("CREATE PROCEDURE p() BEGIN END;\n".into()));
        assert_eq!(q.1[0], "SHOW CREATE PROCEDURE `db`.`p`");
        let mut q = Script(vec![("SHOW CREATE TABLE", vec![row(&[Some("t"), None])])], Vec::new());
        assert_eq!(object_ddl(&mut q, "db", "t", "table").await.unwrap(), None);
    }
}
