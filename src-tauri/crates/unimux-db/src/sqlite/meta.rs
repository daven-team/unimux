//! SQLite catalog reads (1.1.4 src/dbhost/sqliteMeta.ts): the tables, views, indexes and triggers of the main database
//! (sqlite_schema), a table's columns, keys, indexes and foreign keys (the table-valued PRAGMA functions, names bound as
//! parameters), and the CREATE statement of an object (sqlite_schema.sql; a table's indexes and triggers follow it).

use std::collections::{HashMap, HashSet};

use futures::future::BoxFuture;
use serde_json::{Value, json};
use unimux_core::utf16::{is_js_space_char, js_trim_end};

use super::Fail;
use crate::sql::sqlite::{Affinity, SqliteParam, sq_ident, sqlite_affinity, sqlite_value_kind};
use crate::sql::{SQLITE_MAIN, ValueKind};

/// A catalog row: every value as text.
pub type SqRow = Vec<Option<String>>;

/// A catalog read on the session's connection.
pub trait SqQuery: Sync {
    fn q<'a>(&'a self, sql: &'a str, params: Vec<SqliteParam>) -> BoxFuture<'a, Result<Vec<SqRow>, Fail>>;
}

fn at(r: &SqRow, i: usize) -> Option<&str> {
    r.get(i).and_then(|v| v.as_deref())
}

fn s(r: &SqRow, i: usize) -> String {
    at(r, i).unwrap_or("").to_owned()
}

fn text(v: &str) -> SqliteParam {
    SqliteParam::Text(v.to_owned())
}

fn ascii_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// Case-insensitive ASCII `word` at char index `i` of `c`.
fn word_at(c: &[char], i: usize, word: &str) -> bool {
    let w: Vec<char> = word.chars().collect();
    i + w.len() <= c.len() && c[i..i + w.len()].iter().zip(&w).all(|(a, b)| a.eq_ignore_ascii_case(b))
}

/// JS `\b` at char index `i` (ASCII word characters).
fn boundary(c: &[char], i: usize) -> bool {
    let before = i > 0 && ascii_word(c[i - 1]);
    let after = i < c.len() && ascii_word(c[i]);
    before != after
}

fn spaces(c: &[char], mut i: usize) -> usize {
    while i < c.len() && is_js_space_char(c[i]) {
        i += 1;
    }
    i
}

/// `/^\s*CREATE\s+VIRTUAL\b/i`.
pub fn is_virtual(sql: &str) -> bool {
    let c: Vec<char> = sql.chars().collect();
    let i = spaces(&c, 0);
    if !word_at(&c, i, "CREATE") {
        return false;
    }
    let j = spaces(&c, i + 6);
    j > i + 6 && word_at(&c, j, "VIRTUAL") && boundary(&c, j + 7)
}

/// `/\bWITHOUT\s+ROWID\s*;?\s*$/i`.
fn without_rowid_text(sql: &str) -> bool {
    let c: Vec<char> = sql.chars().collect();
    (0..c.len()).any(|i| {
        if !boundary(&c, i) || !word_at(&c, i, "WITHOUT") {
            return false;
        }
        let j = spaces(&c, i + 7);
        if j == i + 7 || !word_at(&c, j, "ROWID") {
            return false;
        }
        let mut k = spaces(&c, j + 5);
        if k < c.len() && c[k] == ';' {
            k = spaces(&c, k + 1);
        }
        k == c.len()
    })
}

/// "BEFORE INSERT" from a CREATE TRIGGER statement: `/\b(BEFORE|AFTER|INSTEAD\s+OF)?\s*(INSERT|DELETE|UPDATE)\b/i` on the
/// text after the first word TRIGGER.
pub fn trigger_timing(sql: &str) -> String {
    let all: Vec<char> = sql.chars().collect();
    // `sql.replace(/^[\s\S]*?\bTRIGGER\b/i, '')`
    let from =
        (0..all.len()).find(|&i| boundary(&all, i) && word_at(&all, i, "TRIGGER") && boundary(&all, i + 7)).map_or(0, |i| i + 7);
    let c = &all[from..];
    let event = |i: usize| -> Option<(usize, &'static str)> {
        ["INSERT", "DELETE", "UPDATE"].into_iter().find(|w| word_at(c, i, w) && boundary(c, i + 6)).map(|w| (i + 6, w))
    };
    for p in 0..=c.len() {
        if !boundary(c, p) {
            continue;
        }
        // with the timing group (greedy), then without it
        let timing: Option<(usize, &str)> = if word_at(c, p, "BEFORE") {
            Some((p + 6, "BEFORE"))
        } else if word_at(c, p, "AFTER") {
            Some((p + 5, "AFTER"))
        } else if word_at(c, p, "INSTEAD") {
            let j = spaces(c, p + 7);
            (j > p + 7 && word_at(c, j, "OF")).then_some((j + 2, "INSTEAD OF"))
        } else {
            None
        };
        if let Some((end, t)) = timing
            && let Some((_, e)) = event(spaces(c, end))
        {
            return format!("{t} {e}");
        }
        if let Some((_, e)) = event(spaces(c, p)) {
            return e.to_owned();
        }
    }
    String::new()
}

fn kind_of(t: &str) -> Option<&'static str> {
    match t {
        "table" => Some("table"),
        "view" => Some("view"),
        "index" => Some("index"),
        "trigger" => Some("trigger"),
        _ => None,
    }
}

/// `listObjects`.
pub async fn list_objects(q: &dyn SqQuery, schema: &str) -> Result<Vec<Value>, Fail> {
    if schema != SQLITE_MAIN {
        return Ok(Vec::new());
    }
    let rows = q
        .q(
            "SELECT type, name, tbl_name, sql FROM main.sqlite_schema WHERE type IN ('table', 'view', 'index', 'trigger') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name",
            Vec::new(),
        )
        .await?;
    let mut out = Vec::new();
    for r in &rows {
        let Some(kind) = kind_of(at(r, 0).unwrap_or("")) else { continue };
        let sql = at(r, 3).unwrap_or("");
        // An index SQLite made for a UNIQUE or PRIMARY KEY constraint has no SQL of its own: the table shows it.
        if kind == "index" && sql.is_empty() {
            continue;
        }
        let virtual_ = kind == "table" && is_virtual(sql);
        let detail = if kind == "index" || kind == "trigger" {
            let timing = if kind == "trigger" { format!(" \u{b7} {}", trigger_timing(sql)) } else { String::new() };
            Some(format!("ON {}{timing}", at(r, 2).unwrap_or("")))
        } else if virtual_ {
            Some("VIRTUAL".to_owned())
        } else {
            None
        };
        let mut o = json!({ "schema": schema, "name": s(r, 1), "kind": kind, "oid": 0 });
        if kind == "table" {
            o["rowEstimate"] = Value::Null;
        }
        if let Some(d) = detail.filter(|d| !d.is_empty()) {
            o["detail"] = json!(d);
        }
        out.push(o);
    }
    Ok(out)
}

/// `DbColumnInfo`.
#[derive(Debug, Clone, PartialEq)]
pub struct ColumnInfo {
    pub name: String,
    pub position: usize,
    pub type_name: String,
    pub kind: ValueKind,
    pub nullable: bool,
    pub default: Option<String>,
    pub identity: bool,
    pub generated: bool,
}

impl ColumnInfo {
    fn to_json(&self) -> Value {
        json!({
            "name": self.name, "position": self.position, "typeName": self.type_name, "typeOid": 0, "kind": self.kind.as_str(),
            "nullable": self.nullable, "default": self.default, "identity": self.identity, "generated": self.generated,
        })
    }
}

/// `SqliteTableInfo`: `DbTableInfo` plus the rowid name and the columns' affinities.
#[derive(Debug, Clone, PartialEq)]
pub struct TableInfo {
    pub schema: String,
    pub name: String,
    /// "table" or "view".
    pub kind: &'static str,
    pub columns: Vec<ColumnInfo>,
    pub primary_key: Option<Vec<String>>,
    pub unique_keys: Vec<Vec<String>>,
    pub edit_key: Option<Vec<String>>,
    pub indexes: Vec<Value>,
    pub constraints: Vec<Value>,
    /// The name the rowid is read as (a rowid table without a primary key is edited by it); None: keyed by its primary key,
    /// or not editable.
    pub rowid: Option<String>,
    /// Each real column's affinity (edits bind values by it).
    pub affinities: HashMap<String, Affinity>,
}

impl TableInfo {
    /// The `DbTableInfo` the renderer gets (without rowid and affinities).
    pub fn to_json(&self) -> Value {
        json!({
            "schema": self.schema, "name": self.name, "kind": self.kind, "oid": 0, "rowEstimate": null,
            "columns": self.columns.iter().map(ColumnInfo::to_json).collect::<Vec<_>>(),
            "primaryKey": self.primary_key, "uniqueKeys": self.unique_keys, "editKey": self.edit_key,
            "indexes": self.indexes, "constraints": self.constraints,
        })
    }

    pub fn affinity(&self, column: &str) -> Affinity {
        self.affinities.get(column).copied().unwrap_or(Affinity::Blob)
    }
}

const ROWID_NAMES: [&str; 3] = ["rowid", "_rowid_", "oid"];

/// One foreign key while it is collected: id, referenced table, from columns, to columns (null: the referenced primary key).
type ForeignKey = (String, String, Vec<String>, Vec<Option<String>>);

fn idents(names: &[String]) -> Result<String, Fail> {
    Ok(names.iter().map(|n| sq_ident(n)).collect::<Result<Vec<_>, _>>().map_err(Fail::Sql)?.join(", "))
}

/// JS `Number(text)` of a pk column (0 for anything that is not a number).
fn pk_number(v: Option<&str>) -> f64 {
    match v {
        None => 0.0,
        Some(t) => crate::sql::values::js_to_number(t),
    }
}

/// `tableInfo`.
pub async fn table_info(q: &dyn SqQuery, schema: &str, name: &str) -> Result<Option<TableInfo>, Fail> {
    if schema != SQLITE_MAIN {
        return Ok(None);
    }
    let rel =
        q.q("SELECT type, sql FROM main.sqlite_schema WHERE name = ? AND type IN ('table', 'view')", vec![text(name)]).await?;
    let Some(rel) = rel.into_iter().next() else { return Ok(None) };
    let kind = if at(&rel, 0) == Some("view") { "view" } else { "table" };
    let rel_sql = at(&rel, 1).unwrap_or("");
    let virtual_ = kind == "table" && is_virtual(rel_sql);
    let col_rows = q
        .q(
            "SELECT cid, name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo(?, 'main') ORDER BY cid",
            vec![text(name)],
        )
        .await?;
    let mut affinities = HashMap::new();
    let mut pk_order: Vec<(f64, String)> = Vec::new();
    let mut columns: Vec<ColumnInfo> = Vec::new();
    for r in col_rows.iter().filter(|r| at(r, 6) != Some("1")) {
        let col = s(r, 1);
        let ty = s(r, 2);
        affinities.insert(col.clone(), sqlite_affinity(Some(&ty)));
        let pk = pk_number(at(r, 5));
        if pk > 0.0 {
            pk_order.push((pk, col.clone()));
        }
        columns.push(ColumnInfo {
            name: col,
            position: columns.len() + 1,
            kind: sqlite_value_kind(Some(&ty)),
            type_name: ty,
            nullable: at(r, 3) != Some("1") && pk == 0.0,
            default: at(r, 4).map(str::to_owned),
            identity: false,
            generated: matches!(at(r, 6), Some("2" | "3")),
        });
    }
    let primary_key = if pk_order.is_empty() {
        None
    } else {
        pk_order.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        Some(pk_order.into_iter().map(|p| p.1).collect::<Vec<_>>())
    };
    // INTEGER PRIMARY KEY is the rowid itself: SQLite numbers new rows (like an identity column).
    if let Some(pk) = primary_key.as_ref().filter(|p| p.len() == 1)
        && let Some(c) = columns.iter_mut().find(|c| c.name == pk[0])
        && c.type_name.to_uppercase() == "INTEGER"
    {
        c.identity = true;
    }
    let mut without_rowid = false;
    if kind == "table" && !virtual_ {
        without_rowid = match q.q("SELECT wr FROM pragma_table_list(?, 'main')", vec![text(name)]).await {
            Ok(rows) => rows.first().and_then(|r| at(r, 0)) == Some("1"),
            Err(_) => without_rowid_text(rel_sql),
        };
    }
    let not_null: HashSet<String> = columns.iter().filter(|c| !c.nullable).map(|c| c.name.clone()).collect();
    let idx_rows = if kind == "table" {
        q.q("SELECT name, \"unique\", origin, partial FROM pragma_index_list(?, 'main')", vec![text(name)]).await?
    } else {
        Vec::new()
    };
    let idx_sql: HashMap<String, Option<String>> = q
        .q("SELECT name, sql FROM main.sqlite_schema WHERE type = 'index' AND tbl_name = ?", vec![text(name)])
        .await?
        .into_iter()
        .map(|r| (s(&r, 0), at(&r, 1).map(str::to_owned)))
        .collect();
    let mut indexes = Vec::new();
    let mut unique_keys: Vec<Vec<String>> = Vec::new();
    let mut constraints = Vec::new();
    if let Some(pk) = &primary_key {
        constraints.push(
            json!({ "name": "PRIMARY KEY", "type": "p", "definition": format!("PRIMARY KEY ({})", idents(pk)?), "columns": pk }),
        );
    }
    for r in &idx_rows {
        let idx = s(r, 0);
        let cols = q.q("SELECT name FROM pragma_index_info(?, 'main') ORDER BY seqno", vec![text(&idx)]).await?;
        let names: Vec<Option<String>> = cols.into_iter().map(|c| c.into_iter().next().flatten()).collect();
        let expression = names.iter().any(Option::is_none);
        let columns_of: Vec<String> = names.into_iter().flatten().collect();
        let unique = at(r, 1) == Some("1");
        let origin = at(r, 2).unwrap_or("c");
        let partial = at(r, 3) == Some("1");
        let definition = match idx_sql.get(&idx) {
            Some(Some(sql)) => sql.clone(),
            _ => format!("{} ({})", if origin == "pk" { "PRIMARY KEY" } else { "UNIQUE" }, idents(&columns_of)?),
        };
        indexes.push(
            json!({ "name": idx, "definition": definition, "unique": unique, "primary": origin == "pk", "columns": columns_of }),
        );
        if origin == "u" {
            constraints.push(json!({ "name": idx, "type": "u", "definition": format!("UNIQUE ({})", idents(&columns_of)?), "columns": columns_of }));
        }
        if unique
            && origin != "pk"
            && !partial
            && !expression
            && !columns_of.is_empty()
            && columns_of.iter().all(|c| not_null.contains(c))
        {
            unique_keys.push(columns_of);
        }
    }
    if kind == "table" {
        let fks = q
            .q(
                "SELECT id, \"table\", \"from\", \"to\" FROM pragma_foreign_key_list(?, 'main') ORDER BY id, seq",
                vec![text(name)],
            )
            .await?;
        // a Map in insertion order of the ids
        let mut by_id: Vec<ForeignKey> = Vec::new();
        for r in &fks {
            let id = s(r, 0);
            let pos = match by_id.iter().position(|e| e.0 == id) {
                Some(p) => p,
                None => {
                    by_id.push((id, s(r, 1), Vec::new(), Vec::new()));
                    by_id.len() - 1
                }
            };
            by_id[pos].2.push(s(r, 2));
            by_id[pos].3.push(at(r, 3).map(str::to_owned));
        }
        for (id, table, from, to) in by_id {
            let to = if to.iter().all(Option::is_some) {
                let names: Vec<String> = to.into_iter().flatten().collect();
                format!(" ({})", idents(&names)?)
            } else {
                String::new()
            };
            constraints.push(json!({
                "name": format!("fk_{id}_{table}"), "type": "f",
                "definition": format!("FOREIGN KEY ({}) REFERENCES {}{to}", idents(&from)?, sq_ident(&table).map_err(Fail::Sql)?),
                "columns": from,
            }));
        }
    }
    // A rowid table without a primary key is edited by its rowid, read under a name no column hides.
    let taken: HashSet<String> = columns.iter().map(|c| c.name.to_lowercase()).collect();
    let rowid = if kind == "table" && !virtual_ && !without_rowid && primary_key.is_none() {
        ROWID_NAMES.iter().find(|n| !taken.contains(**n)).map(|n| (*n).to_owned())
    } else {
        None
    };
    if let Some(r) = &rowid {
        columns.insert(
            0,
            ColumnInfo {
                name: r.clone(),
                position: 0,
                type_name: "ROWID".into(),
                kind: ValueKind::Bigint,
                nullable: false,
                default: None,
                identity: true,
                generated: true,
            },
        );
    }
    let edit_key = if kind != "table" || virtual_ {
        None
    } else {
        primary_key.clone().or_else(|| rowid.as_ref().map(|r| vec![r.clone()])).or_else(|| unique_keys.first().cloned())
    };
    Ok(Some(TableInfo {
        schema: schema.to_owned(),
        name: name.to_owned(),
        kind,
        columns,
        primary_key,
        unique_keys,
        edit_key,
        indexes,
        constraints,
        rowid,
        affinities,
    }))
}

/// `objectDdl`: the CREATE statement of an object; a table's indexes and triggers follow it. None when there is none.
pub async fn object_ddl(q: &dyn SqQuery, schema: &str, name: &str, kind: &str) -> Result<Option<String>, Fail> {
    if schema != SQLITE_MAIN {
        return Ok(None);
    }
    let ty = match kind {
        "view" => "view",
        "index" => "index",
        "trigger" => "trigger",
        _ => "table",
    };
    let rows = q.q("SELECT sql FROM main.sqlite_schema WHERE name = ? AND type = ?", vec![text(name), text(ty)]).await?;
    let Some(sql) = rows.first().and_then(|r| at(r, 0)).filter(|s| !s.is_empty()) else { return Ok(None) };
    let mut parts = vec![format!("{};", js_trim_end(sql))];
    if ty == "table" {
        let more = q
            .q(
                "SELECT sql FROM main.sqlite_schema WHERE tbl_name = ? AND type IN ('index', 'trigger') AND sql IS NOT NULL ORDER BY type, name",
                vec![text(name)],
            )
            .await?;
        for r in &more {
            if let Some(x) = at(r, 0).filter(|x| !x.is_empty()) {
                parts.push(format!("{};", js_trim_end(x)));
            }
        }
    }
    Ok(Some(format!("{}\n", parts.join("\n\n"))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trigger_timings_and_virtual_tables() {
        assert_eq!(
            trigger_timing("CREATE TRIGGER orders_touch AFTER INSERT ON orders BEGIN UPDATE x SET a = 1; END"),
            "AFTER INSERT"
        );
        assert_eq!(trigger_timing("create trigger t instead  of update on v begin select 1; end"), "INSTEAD OF UPDATE");
        assert_eq!(trigger_timing("CREATE TRIGGER t DELETE ON x BEGIN SELECT 1; END"), "DELETE");
        assert_eq!(trigger_timing("CREATE TRIGGER t BEFORE DELETE ON x BEGIN END"), "BEFORE DELETE");
        assert_eq!(trigger_timing("CREATE TRIGGER inserted_log UPDATE OF a ON x BEGIN END"), "UPDATE");
        assert_eq!(trigger_timing("nothing"), "");
        assert!(is_virtual("  create   VIRTUAL TABLE t USING fts5(a)"));
        assert!(!is_virtual("CREATE VIRTUALX TABLE"));
        assert!(!is_virtual("CREATEVIRTUAL TABLE"));
        assert!(without_rowid_text("CREATE TABLE t (a PRIMARY KEY) WITHOUT  ROWID ; "));
        assert!(without_rowid_text("CREATE TABLE t (a PRIMARY KEY) without rowid"));
        assert!(!without_rowid_text("CREATE TABLE t (a PRIMARY KEY) WITHOUT ROWID, STRICT"));
    }
}
