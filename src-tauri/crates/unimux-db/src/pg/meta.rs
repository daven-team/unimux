//! D6: Postgres catalog reads (1.1.4 src/dbhost/pgMeta.ts): databases, schemas, objects, a table's columns, keys, indexes
//! and constraints, and the CREATE statement (DDL) of a table, view, materialized view, sequence or function, rebuilt from
//! the catalogs. Every query is parameterized (values go as text, like node-postgres sends JS strings and numbers); values
//! arrive as text. Works with Postgres 12 and newer. The JSON shapes and key orders are those of the TS objects.

use futures::future::BoxFuture;
use serde_json::{Map, Value, json};
use unimux_core::utf16::{js_trim, js_trim_end};

use crate::sql::pg::{js_number, value_kind};
use crate::sql::values::js_to_number;
use crate::sql::{DbSqlError, Dialect, qualified_name, quote_ident};

/// A catalog row: every value as text.
pub type PgRow = Vec<Option<String>>;

/// A read on the session's connection (`CatalogQuery`): rows in array mode, every value as text. `params` empty: the
/// simple protocol (node-postgres without values), else one extended statement with text parameters.
pub trait CatalogQuery: Send {
    type Error: Send;
    fn q<'a>(&'a mut self, sql: &'a str, params: &'a [String]) -> BoxFuture<'a, Result<Vec<PgRow>, Self::Error>>;
}

/// Why a catalog read failed: the connection / server, or a name the SQL builders refuse (`DbSqlError`).
#[derive(Debug)]
pub enum MetaError<E> {
    Query(E),
    Sql(DbSqlError),
}

impl<E> From<DbSqlError> for MetaError<E> {
    fn from(e: DbSqlError) -> Self {
        MetaError::Sql(e)
    }
}

type MetaResult<T, E> = Result<T, MetaError<E>>;

async fn run<Q: CatalogQuery + ?Sized>(q: &mut Q, sql: &str, params: &[String]) -> MetaResult<Vec<PgRow>, Q::Error> {
    q.q(sql, params).await.map_err(MetaError::Query)
}

fn at(r: &PgRow, i: usize) -> Option<&str> {
    r.get(i).and_then(|v| v.as_deref())
}

/// `r[i] ?? ''`.
fn s(r: &PgRow, i: usize) -> String {
    at(r, i).unwrap_or("").to_owned()
}

/// `num(v)`: `Number(v)`, 0 for null.
fn num(v: Option<&str>) -> f64 {
    v.map_or(0.0, js_to_number)
}

/// `bool(v)`: 't' or 'true'.
fn bool_(v: Option<&str>) -> bool {
    matches!(v, Some("t" | "true"))
}

/// JS truthiness of a text value (a non-empty string).
fn truthy(v: Option<&str>) -> bool {
    v.is_some_and(|v| !v.is_empty())
}

/// A JS number as JSON (NaN and the infinities are `null`, as JSON.stringify writes them).
pub(crate) fn num_json(n: f64) -> Value {
    if !n.is_finite() {
        return Value::Null;
    }
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        // -0 is written as 0 by JSON.stringify
        return json!(n as i64);
    }
    json!(n)
}

/// JS `Math.round`.
fn js_round(n: f64) -> f64 {
    (n + 0.5).floor()
}

/// `estimate === null || estimate < 0 ? null : Math.round(estimate)`.
fn estimate(v: Option<&str>) -> Option<f64> {
    let e = v.map(js_to_number)?;
    // NaN < 0 is false in JS: Math.round(NaN) is NaN (null in JSON)
    if e < 0.0 { None } else { Some(js_round(e)) }
}

fn estimate_json(v: Option<f64>) -> Value {
    v.map_or(Value::Null, num_json)
}

/// `opt(key, v)`: the key only for a truthy (non-empty) value.
fn opt(m: &mut Map<String, Value>, key: &str, v: Option<&str>) {
    if let Some(v) = v.filter(|v| !v.is_empty()) {
        m.insert(key.into(), json!(v));
    }
}

/// `attnums`: int2vector ("1 2") or int2[] ("{1,2}") as numbers (NaN for a piece that is not one).
fn attnums(v: Option<&str>) -> Vec<f64> {
    let Some(v) = v.filter(|v| !v.is_empty()) else { return Vec::new() };
    let cleaned: String = v.chars().filter(|c| *c != '{' && *c != '}').collect();
    cleaned
        .split(|c: char| c == ',' || unimux_core::utf16::is_js_space_char(c))
        .filter(|p| !p.is_empty())
        .map(js_to_number)
        .collect()
}

/// `RELKIND[k] ?? 'table'`.
fn relkind(k: Option<&str>) -> &'static str {
    match k {
        Some("r") => "table",
        Some("p") => "partitioned",
        Some("v") => "view",
        Some("m") => "matview",
        Some("f") => "foreign",
        Some("S") => "sequence",
        _ => "table",
    }
}

/// `${v}` of a template string (null is "null").
fn tpl(v: Option<&str>) -> &str {
    v.unwrap_or("null")
}

/// `listDatabases`.
pub async fn list_databases<Q: CatalogQuery + ?Sized>(q: &mut Q) -> MetaResult<Value, Q::Error> {
    let rows = run(
        q,
        "SELECT d.datname, pg_get_userbyid(d.datdba), pg_encoding_to_char(d.encoding), d.datistemplate, d.datallowconn,
    CASE WHEN d.datallowconn AND has_database_privilege(d.oid, 'CONNECT') THEN pg_database_size(d.oid) END,
    shobj_description(d.oid, 'pg_database')
    FROM pg_database d ORDER BY d.datistemplate, d.datname",
        &[],
    )
    .await?;
    Ok(Value::Array(
        rows.iter()
            .map(|r| {
                let mut m = Map::new();
                m.insert("name".into(), json!(s(r, 0)));
                m.insert("owner".into(), json!(s(r, 1)));
                m.insert("encoding".into(), json!(s(r, 2)));
                m.insert("isTemplate".into(), json!(bool_(at(r, 3))));
                m.insert("allowConnections".into(), json!(bool_(at(r, 4))));
                m.insert("sizeBytes".into(), at(r, 5).map_or(Value::Null, |v| num_json(js_to_number(v))));
                opt(&mut m, "comment", at(r, 6));
                Value::Object(m)
            })
            .collect(),
    ))
}

/// `listSchemas`.
pub async fn list_schemas<Q: CatalogQuery + ?Sized>(q: &mut Q) -> MetaResult<Value, Q::Error> {
    let rows = run(
        q,
        "SELECT n.nspname, pg_get_userbyid(n.nspowner),
    n.nspname IN ('pg_catalog', 'information_schema'), obj_description(n.oid, 'pg_namespace')
    FROM pg_namespace n
    WHERE n.nspname NOT LIKE 'pg\\_toast%' AND n.nspname NOT LIKE 'pg\\_temp\\_%'
    ORDER BY 3, 1",
        &[],
    )
    .await?;
    Ok(Value::Array(
        rows.iter()
            .map(|r| {
                let mut m = Map::new();
                m.insert("name".into(), json!(s(r, 0)));
                m.insert("owner".into(), json!(s(r, 1)));
                m.insert("system".into(), json!(bool_(at(r, 2))));
                opt(&mut m, "comment", at(r, 3));
                Value::Object(m)
            })
            .collect(),
    ))
}

/// `listObjects`: relations, then functions and procedures.
pub async fn list_objects<Q: CatalogQuery + ?Sized>(q: &mut Q, schema: &str) -> MetaResult<Value, Q::Error> {
    let p = [schema.to_owned()];
    let rels = run(
        q,
        "SELECT c.relname, c.relkind, c.oid, c.reltuples, obj_description(c.oid, 'pg_class')
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
    ORDER BY c.relname",
        &p,
    )
    .await?;
    let funcs = run(
        q,
        "SELECT p.proname, p.prokind, p.oid, pg_get_function_identity_arguments(p.oid), pg_get_function_result(p.oid), obj_description(p.oid, 'pg_proc')
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1 AND p.prokind IN ('f', 'p')
    ORDER BY p.proname, 4",
        &p,
    )
    .await?;
    let mut out = Vec::with_capacity(rels.len() + funcs.len());
    for r in &rels {
        let kind = relkind(at(r, 1));
        let mut m = Map::new();
        m.insert("schema".into(), json!(schema));
        m.insert("name".into(), json!(s(r, 0)));
        m.insert("kind".into(), json!(kind));
        m.insert("oid".into(), num_json(num(at(r, 2))));
        if matches!(kind, "table" | "partitioned" | "matview" | "foreign") {
            m.insert("rowEstimate".into(), estimate_json(estimate(at(r, 3))));
        }
        opt(&mut m, "comment", at(r, 4));
        out.push(Value::Object(m));
    }
    for r in &funcs {
        let mut m = Map::new();
        m.insert("schema".into(), json!(schema));
        m.insert("name".into(), json!(s(r, 0)));
        m.insert("kind".into(), json!(if at(r, 1) == Some("p") { "procedure" } else { "function" }));
        m.insert("oid".into(), num_json(num(at(r, 2))));
        m.insert("args".into(), json!(s(r, 3)));
        opt(&mut m, "returns", at(r, 4));
        opt(&mut m, "comment", at(r, 5));
        out.push(Value::Object(m));
    }
    Ok(Value::Array(out))
}

/// A relation of `relation()`.
#[derive(Debug, Clone, PartialEq)]
struct Relation {
    oid: f64,
    kind: &'static str,
    estimate: Option<f64>,
    comment: Option<String>,
    persistence: String,
}

impl Relation {
    /// The oid as node-postgres sends a JS number parameter.
    fn param(&self) -> String {
        js_number(self.oid)
    }
}

async fn relation<Q: CatalogQuery + ?Sized>(q: &mut Q, schema: &str, name: &str) -> MetaResult<Option<Relation>, Q::Error> {
    let rows = run(
        q,
        "SELECT c.oid, c.relkind, c.reltuples, obj_description(c.oid, 'pg_class'), c.relispartition, c.relpersistence
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')",
        &[schema.to_owned(), name.to_owned()],
    )
    .await?;
    let Some(r) = rows.first() else { return Ok(None) };
    Ok(Some(Relation {
        oid: num(at(r, 0)),
        kind: relkind(at(r, 1)),
        estimate: estimate(at(r, 2)),
        comment: at(r, 3).map(str::to_owned),
        persistence: at(r, 5).unwrap_or("p").to_owned(),
    }))
}

/// `DbColumnInfo` (plus what the DDL needs).
#[derive(Debug, Clone, PartialEq)]
pub struct PgColumnInfo {
    pub name: String,
    pub position: f64,
    pub type_name: String,
    pub type_oid: f64,
    pub kind: &'static str,
    pub nullable: bool,
    pub default: Option<String>,
    pub identity: bool,
    pub generated: bool,
    pub comment: Option<String>,
    attnum: f64,
    collation: Option<String>,
    identity_kind: String,
    generation_expression: Option<String>,
}

impl PgColumnInfo {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("name".into(), json!(self.name));
        m.insert("position".into(), num_json(self.position));
        m.insert("typeName".into(), json!(self.type_name));
        m.insert("typeOid".into(), num_json(self.type_oid));
        m.insert("kind".into(), json!(self.kind));
        m.insert("nullable".into(), json!(self.nullable));
        m.insert("default".into(), self.default.as_ref().map_or(Value::Null, |d| json!(d)));
        m.insert("identity".into(), json!(self.identity));
        m.insert("generated".into(), json!(self.generated));
        opt(&mut m, "comment", self.comment.as_deref());
        Value::Object(m)
    }
}

/// `valueKind(num(oid), category ?? undefined)` (a non-integer oid matches no built-in type).
fn kind_of(oid: f64, category: Option<&str>) -> &'static str {
    let oid = if oid.is_finite() && oid.fract() == 0.0 && oid.abs() < 9e15 { oid as i64 } else { -1 };
    value_kind(oid, category).as_str()
}

async fn columns_of<Q: CatalogQuery + ?Sized>(q: &mut Q, oid: &str) -> MetaResult<Vec<PgColumnInfo>, Q::Error> {
    // A domain column edits like its base type.
    let rows = run(
        q,
        "SELECT a.attname, a.attnum, format_type(a.atttypid, a.atttypmod), a.atttypid,
      CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE a.atttypid END, bt.typcategory,
      NOT a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity, a.attgenerated, col_description(a.attrelid, a.attnum),
      (SELECT quote_ident(cn.nspname) || '.' || quote_ident(co.collname) FROM pg_collation co JOIN pg_namespace cn ON cn.oid = co.collnamespace
        WHERE co.oid = a.attcollation AND a.attcollation <> t.typcollation)
    FROM pg_attribute a
    JOIN pg_type t ON t.oid = a.atttypid
    JOIN pg_type bt ON bt.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE a.atttypid END
    LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
    WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped
    ORDER BY a.attnum",
        &[oid.to_owned()],
    )
    .await?;
    // A generated column's expression sits where a default would (pg_attrdef).
    Ok(rows
        .iter()
        .map(|r| {
            let generated = truthy(at(r, 9));
            PgColumnInfo {
                name: s(r, 0),
                position: num(at(r, 1)),
                type_name: s(r, 2),
                type_oid: num(at(r, 3)),
                kind: kind_of(num(at(r, 4)), at(r, 5)),
                nullable: bool_(at(r, 6)),
                default: if generated { None } else { at(r, 7).map(str::to_owned) },
                identity: truthy(at(r, 8)),
                generated,
                comment: at(r, 10).map(str::to_owned),
                attnum: num(at(r, 1)),
                collation: at(r, 11).map(str::to_owned),
                identity_kind: s(r, 8),
                generation_expression: if generated { at(r, 7).map(str::to_owned) } else { None },
            }
        })
        .collect())
}

/// `DbConstraintInfo`.
#[derive(Debug, Clone, PartialEq)]
pub struct PgConstraintInfo {
    pub name: String,
    pub kind: String,
    pub definition: String,
    pub columns: Vec<String>,
}

/// `DbIndexInfo`.
#[derive(Debug, Clone, PartialEq)]
pub struct PgIndexInfo {
    pub name: String,
    pub definition: String,
    pub unique: bool,
    pub primary: bool,
    pub columns: Vec<String>,
}

/// `DbTableInfo`.
#[derive(Debug, Clone, PartialEq)]
pub struct PgTableInfo {
    pub schema: String,
    pub name: String,
    pub kind: &'static str,
    pub oid: f64,
    pub row_estimate: Option<f64>,
    pub columns: Vec<PgColumnInfo>,
    pub primary_key: Option<Vec<String>>,
    pub unique_keys: Vec<Vec<String>>,
    pub edit_key: Option<Vec<String>>,
    pub indexes: Vec<PgIndexInfo>,
    pub constraints: Vec<PgConstraintInfo>,
    pub comment: Option<String>,
}

impl PgTableInfo {
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("schema".into(), json!(self.schema));
        m.insert("name".into(), json!(self.name));
        m.insert("kind".into(), json!(self.kind));
        m.insert("oid".into(), num_json(self.oid));
        m.insert("rowEstimate".into(), estimate_json(self.row_estimate));
        m.insert("columns".into(), Value::Array(self.columns.iter().map(PgColumnInfo::to_json).collect()));
        m.insert("primaryKey".into(), json!(self.primary_key));
        m.insert("uniqueKeys".into(), json!(self.unique_keys));
        m.insert("editKey".into(), json!(self.edit_key));
        m.insert(
            "indexes".into(),
            Value::Array(
                self.indexes
                    .iter()
                    .map(|i| {
                        json!({ "name": i.name, "definition": i.definition, "unique": i.unique, "primary": i.primary,
                            "columns": i.columns })
                    })
                    .collect(),
            ),
        );
        m.insert(
            "constraints".into(),
            Value::Array(
                self.constraints
                    .iter()
                    .map(|c| json!({ "name": c.name, "type": c.kind, "definition": c.definition, "columns": c.columns }))
                    .collect(),
            ),
        );
        opt(&mut m, "comment", self.comment.as_deref());
        Value::Object(m)
    }
}

/// `tableInfo`: None for a missing relation or a sequence.
pub async fn table_info<Q: CatalogQuery + ?Sized>(
    q: &mut Q,
    schema: &str,
    name: &str,
) -> MetaResult<Option<PgTableInfo>, Q::Error> {
    let Some(rel) = relation(q, schema, name).await? else { return Ok(None) };
    if rel.kind == "sequence" {
        return Ok(None);
    }
    let oid = rel.param();
    let cols = columns_of(q, &oid).await?;
    // new Map(cols.map(c => [c.attnum, c.info.name])): a later entry wins
    let names = |nums: &[f64]| -> Vec<String> {
        nums.iter()
            .filter_map(|n| cols.iter().rev().find(|c| c.attnum == *n).map(|c| c.name.clone()))
            .filter(|n| !n.is_empty())
            .collect()
    };
    let cons = run(
        q,
        "SELECT conname, contype, pg_get_constraintdef(oid, true), conkey FROM pg_constraint WHERE conrelid = $1 ORDER BY contype, conname",
        std::slice::from_ref(&oid),
    )
    .await?;
    let constraints: Vec<PgConstraintInfo> = cons
        .iter()
        .map(|r| PgConstraintInfo {
            name: s(r, 0),
            kind: at(r, 1).unwrap_or("c").to_owned(),
            definition: s(r, 2),
            columns: names(&attnums(at(r, 3))),
        })
        .collect();
    let idx = run(
        q,
        "SELECT i.relname, pg_get_indexdef(x.indexrelid), x.indisunique, x.indisprimary, x.indkey, x.indpred IS NULL AND x.indexprs IS NULL AND x.indisvalid
    FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid WHERE x.indrelid = $1 ORDER BY x.indisprimary DESC, i.relname",
        std::slice::from_ref(&oid),
    )
    .await?;
    let indexes: Vec<PgIndexInfo> = idx
        .iter()
        .map(|r| {
            let nums: Vec<f64> = attnums(at(r, 4)).into_iter().filter(|n| *n > 0.0).collect();
            PgIndexInfo {
                name: s(r, 0),
                definition: s(r, 1),
                unique: bool_(at(r, 2)),
                primary: bool_(at(r, 3)),
                columns: names(&nums),
            }
        })
        .collect();
    let not_null: Vec<&str> = cols.iter().filter(|c| !c.nullable).map(|c| c.name.as_str()).collect();
    let mut unique_keys: Vec<Vec<String>> = Vec::new();
    let mut add_key = |key: &[String]| {
        if !key.is_empty()
            && key.iter().all(|k| not_null.contains(&k.as_str()))
            && !unique_keys.iter().any(|u| u.as_slice() == key)
        {
            unique_keys.push(key.to_vec());
        }
    };
    for c in &constraints {
        if c.kind == "u" {
            add_key(&c.columns);
        }
    }
    for (i, r) in idx.iter().enumerate() {
        let plain = bool_(at(r, 5)) && attnums(at(r, 4)).iter().all(|n| *n > 0.0);
        if bool_(at(r, 2)) && !bool_(at(r, 3)) && plain {
            add_key(&indexes[i].columns);
        }
    }
    let primary_key = constraints.iter().find(|c| c.kind == "p").filter(|pk| !pk.columns.is_empty()).map(|pk| pk.columns.clone());
    let editable = matches!(rel.kind, "table" | "partitioned" | "foreign");
    // [...uniqueKeys].sort((a, b) => a.length - b.length)[0]: a stable sort, so the first of the shortest
    let edit_key =
        if !editable { None } else { primary_key.clone().or_else(|| unique_keys.iter().min_by_key(|k| k.len()).cloned()) };
    Ok(Some(PgTableInfo {
        schema: schema.to_owned(),
        name: name.to_owned(),
        kind: rel.kind,
        oid: rel.oid,
        row_estimate: rel.estimate,
        columns: cols,
        primary_key,
        unique_keys,
        edit_key,
        indexes,
        constraints,
        comment: rel.comment.filter(|c| !c.is_empty()),
    }))
}

/// `literal`: a string literal ('' for each ').
fn literal(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// `commentLine(target, comment)`.
fn comment_line(out: &mut Vec<String>, target: &str, comment: Option<&str>) {
    if let Some(c) = comment.filter(|c| !c.is_empty()) {
        out.push(format!("COMMENT ON {target} IS {};", literal(c)));
    }
}

/// `objectDdl`: the CREATE statement of an object, rebuilt from the catalogs (tables) or from pg_get_*def (views,
/// functions). None: not found.
pub async fn object_ddl<Q: CatalogQuery + ?Sized>(
    q: &mut Q,
    schema: &str,
    name: &str,
    kind: &str,
    args: Option<&str>,
) -> MetaResult<Option<String>, Q::Error> {
    let target = qualified_name(schema, name, Dialect::Postgres)?;
    if kind == "function" || kind == "procedure" {
        // `args` is pg_get_function_identity_arguments as listObjects reported it (names included, so to_regprocedure
        // cannot read it).
        let args = args.unwrap_or("");
        let rows = run(
            q,
            "SELECT pg_get_functiondef(p.oid), obj_description(p.oid, 'pg_proc') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = $1 AND p.proname = $2 AND pg_get_function_identity_arguments(p.oid) = $3 AND p.prokind IN ('f', 'p')",
            &[schema.to_owned(), name.to_owned(), args.to_owned()],
        )
        .await?;
        let Some(r) = rows.first() else { return Ok(None) };
        let Some(def) = at(r, 0) else { return Ok(None) };
        let def = js_trim_end(def);
        let mut out = vec![if def.ends_with(';') { def.to_owned() } else { format!("{def};") }];
        let what = if kind == "procedure" { "PROCEDURE" } else { "FUNCTION" };
        comment_line(&mut out, &format!("{what} {target}({args})"), at(r, 1));
        return Ok(Some(out.join("\n")));
    }
    let Some(rel) = relation(q, schema, name).await? else { return Ok(None) };
    let oid = rel.param();
    if rel.kind == "view" || rel.kind == "matview" {
        let rows = run(q, "SELECT pg_get_viewdef($1::oid, true)", std::slice::from_ref(&oid)).await?;
        let body = js_trim(rows.first().and_then(|r| at(r, 0)).unwrap_or(""));
        let body = body.strip_suffix(';').unwrap_or(body);
        let matview = rel.kind == "matview";
        let head =
            if matview { format!("CREATE MATERIALIZED VIEW {target} AS") } else { format!("CREATE OR REPLACE VIEW {target} AS") };
        let mut extra = Vec::new();
        if matview {
            let idx = run(
                q,
                "SELECT pg_get_indexdef(x.indexrelid) FROM pg_index x WHERE x.indrelid = $1 ORDER BY 1",
                std::slice::from_ref(&oid),
            )
            .await?;
            for r in &idx {
                if let Some(d) = at(r, 0).filter(|d| !d.is_empty()) {
                    extra.push(format!("{d};"));
                }
            }
        }
        let mut out = vec![head, format!("{body}{};", if matview { "\nWITH DATA" } else { "" })];
        out.extend(extra);
        let what = if matview { "MATERIALIZED VIEW" } else { "VIEW" };
        comment_line(&mut out, &format!("{what} {target}"), rel.comment.as_deref());
        return Ok(Some(out.join("\n")));
    }
    if rel.kind == "sequence" {
        let rows = run(
            q,
            "SELECT format_type(s.seqtypid, NULL), s.seqstart, s.seqincrement, s.seqmin, s.seqmax, s.seqcache, s.seqcycle FROM pg_sequence s WHERE s.seqrelid = $1",
            std::slice::from_ref(&oid),
        )
        .await?;
        let Some(r) = rows.first() else { return Ok(None) };
        let mut out = vec![
            format!("CREATE SEQUENCE {target}"),
            format!("    AS {}", tpl(at(r, 0))),
            format!("    INCREMENT BY {}", tpl(at(r, 2))),
            format!("    MINVALUE {}", tpl(at(r, 3))),
            format!("    MAXVALUE {}", tpl(at(r, 4))),
            format!("    START WITH {}", tpl(at(r, 1))),
            format!("    CACHE {}{};", tpl(at(r, 5)), if bool_(at(r, 6)) { "\n    CYCLE" } else { "" }),
        ];
        comment_line(&mut out, &format!("SEQUENCE {target}"), rel.comment.as_deref());
        return Ok(Some(out.join("\n")));
    }
    table_ddl(q, &target, &rel).await.map(Some)
}

async fn table_ddl<Q: CatalogQuery + ?Sized>(q: &mut Q, target: &str, rel: &Relation) -> MetaResult<String, Q::Error> {
    let oid = rel.param();
    let cols = columns_of(q, &oid).await?;
    let cons = run(
        q,
        "SELECT conname, contype, pg_get_constraintdef(oid, true), conislocal FROM pg_constraint
    WHERE conrelid = $1 AND contype <> 'n' ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'f' THEN 3 ELSE 4 END, conname",
        std::slice::from_ref(&oid),
    )
    .await?;
    let mut lines: Vec<String> = Vec::new();
    for c in &cols {
        let mut line = format!("    {} {}", quote_ident(&c.name, Dialect::Postgres)?, c.type_name);
        if let Some(coll) = c.collation.as_deref().filter(|s| !s.is_empty()) {
            line.push_str(&format!(" COLLATE {coll}"));
        }
        if !c.identity_kind.is_empty() {
            line.push_str(&format!(" GENERATED {} AS IDENTITY", if c.identity_kind == "a" { "ALWAYS" } else { "BY DEFAULT" }));
        } else if let Some(g) = c.generation_expression.as_deref().filter(|g| !g.is_empty()) {
            line.push_str(&format!(" GENERATED ALWAYS AS ({g}) STORED"));
        } else if let Some(d) = c.default.as_deref() {
            line.push_str(&format!(" DEFAULT {d}"));
        }
        if !c.nullable {
            line.push_str(" NOT NULL");
        }
        lines.push(line);
    }
    for r in &cons {
        if bool_(at(r, 3)) {
            lines.push(format!("    CONSTRAINT {} {}", quote_ident(at(r, 0).unwrap_or(""), Dialect::Postgres)?, s(r, 2)));
        }
    }
    let head = format!(
        "CREATE {}{}TABLE {target}",
        if rel.persistence == "u" { "UNLOGGED " } else { "" },
        if rel.kind == "foreign" { "FOREIGN " } else { "" }
    );
    let mut out: Vec<String> = Vec::new();
    let extras = run(
        q,
        "SELECT CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END,
      (SELECT quote_ident(pn.nspname) || '.' || quote_ident(pc.relname) FROM pg_inherits i JOIN pg_class pc ON pc.oid = i.inhparent JOIN pg_namespace pn ON pn.oid = pc.relnamespace WHERE i.inhrelid = c.oid AND c.relispartition LIMIT 1),
      CASE WHEN c.relispartition THEN pg_get_expr(c.relpartbound, c.oid) END
    FROM pg_class c WHERE c.oid = $1",
        std::slice::from_ref(&oid),
    )
    .await?;
    let e = extras.first();
    let part_key = e.and_then(|r| at(r, 0)).filter(|v| !v.is_empty());
    let parent = e.and_then(|r| at(r, 1)).filter(|v| !v.is_empty());
    let bound = e.and_then(|r| at(r, 2)).filter(|v| !v.is_empty());
    if let (Some(parent), Some(bound)) = (parent, bound) {
        out.push(format!("{head} PARTITION OF {parent}"));
        out.push(format!("    {bound};"));
    } else {
        out.push(format!("{head} ("));
        out.push(lines.join(",\n"));
        out.push(format!("){};", part_key.map(|k| format!(" PARTITION BY {k}")).unwrap_or_default()));
    }
    let idx = run(
        q,
        "SELECT pg_get_indexdef(x.indexrelid) FROM pg_index x
    WHERE x.indrelid = $1 AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = x.indexrelid AND k.conrelid = x.indrelid)
    ORDER BY 1",
        std::slice::from_ref(&oid),
    )
    .await?;
    for r in &idx {
        if let Some(d) = at(r, 0).filter(|d| !d.is_empty()) {
            out.push(format!("{d};"));
        }
    }
    comment_line(&mut out, &format!("TABLE {target}"), rel.comment.as_deref());
    for c in &cols {
        comment_line(&mut out, &format!("COLUMN {target}.{}", quote_ident(&c.name, Dialect::Postgres)?), c.comment.as_deref());
    }
    Ok(out.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Answers each catalog query by the start of its text.
    struct Fake {
        answers: Vec<(&'static str, Vec<PgRow>)>,
        log: Vec<(String, Vec<String>)>,
    }

    impl CatalogQuery for Fake {
        type Error = ();
        fn q<'a>(&'a mut self, sql: &'a str, params: &'a [String]) -> BoxFuture<'a, Result<Vec<PgRow>, ()>> {
            self.log.push((sql.to_owned(), params.to_vec()));
            let rows = self.answers.iter().find(|(p, _)| sql.starts_with(p)).map(|(_, r)| r.clone()).unwrap_or_default();
            Box::pin(async move { Ok(rows) })
        }
    }

    fn row(v: &[Option<&str>]) -> PgRow {
        v.iter().map(|x| x.map(str::to_owned)).collect()
    }

    fn table_fake() -> Fake {
        Fake {
            answers: vec![
                (
                    "SELECT c.oid, c.relkind",
                    vec![row(&[Some("16400"), Some("r"), Some("-1"), Some("orders"), Some("f"), Some("p")])],
                ),
                (
                    "SELECT a.attname",
                    vec![
                        row(&[
                            Some("id"),
                            Some("1"),
                            Some("integer"),
                            Some("23"),
                            Some("23"),
                            Some("N"),
                            Some("f"),
                            None,
                            Some("a"),
                            Some(""),
                            None,
                            None,
                        ]),
                        row(&[
                            Some("code"),
                            Some("2"),
                            Some("text"),
                            Some("25"),
                            Some("25"),
                            Some("S"),
                            Some("f"),
                            None,
                            Some(""),
                            Some(""),
                            Some("the code"),
                            Some("pg_catalog.\"C\""),
                        ]),
                        row(&[
                            Some("total"),
                            Some("3"),
                            Some("numeric(10,2)"),
                            Some("1700"),
                            Some("1700"),
                            Some("N"),
                            Some("t"),
                            Some("(1 + 1)"),
                            Some(""),
                            Some("s"),
                            None,
                            None,
                        ]),
                        row(&[
                            Some("note"),
                            Some("4"),
                            Some("d_text"),
                            Some("70000"),
                            Some("25"),
                            Some("S"),
                            Some("t"),
                            Some("'x'::text"),
                            Some(""),
                            Some(""),
                            None,
                            None,
                        ]),
                    ],
                ),
                (
                    "SELECT conname, contype, pg_get_constraintdef(oid, true), conkey",
                    vec![row(&[Some("orders_code_key"), Some("u"), Some("UNIQUE (code)"), Some("{2}")])],
                ),
                (
                    "SELECT conname, contype, pg_get_constraintdef(oid, true), conislocal",
                    vec![row(&[Some("orders_code_key"), Some("u"), Some("UNIQUE (code)"), Some("t")])],
                ),
                (
                    "SELECT i.relname",
                    vec![
                        row(&[
                            Some("orders_code_key"),
                            Some("CREATE UNIQUE INDEX orders_code_key ON public.orders USING btree (code)"),
                            Some("t"),
                            Some("f"),
                            Some("2"),
                            Some("t"),
                        ]),
                        row(&[
                            Some("orders_id_idx"),
                            Some("CREATE UNIQUE INDEX orders_id_idx ON public.orders USING btree (id)"),
                            Some("t"),
                            Some("f"),
                            Some("1"),
                            Some("t"),
                        ]),
                        row(&[
                            Some("orders_expr"),
                            Some("CREATE UNIQUE INDEX orders_expr ON public.orders USING btree (lower(code))"),
                            Some("t"),
                            Some("f"),
                            Some("0"),
                            Some("f"),
                        ]),
                    ],
                ),
                ("SELECT CASE WHEN c.relkind", vec![row(&[None, None, None])]),
                (
                    "SELECT pg_get_indexdef(x.indexrelid) FROM pg_index x\n",
                    vec![row(&[Some("CREATE INDEX orders_note ON public.orders USING btree (note)")])],
                ),
            ],
            log: Vec::new(),
        }
    }

    fn block<F: std::future::Future>(f: F) -> F::Output {
        futures::executor::block_on(f)
    }

    #[test]
    fn table_info_keys_and_json() {
        let mut q = table_fake();
        let info = block(table_info(&mut q, "public", "orders")).unwrap().unwrap();
        // the first shortest unique key of not-null columns; the expression index adds none
        assert_eq!(info.unique_keys, vec![vec!["code".to_owned()], vec!["id".to_owned()]]);
        assert_eq!(info.edit_key, Some(vec!["code".to_owned()]));
        assert_eq!(info.primary_key, None);
        assert_eq!(info.row_estimate, None);
        assert_eq!(q.log[1].1, vec!["16400".to_owned()]);
        let j = info.to_json();
        assert_eq!(
            serde_json::to_string(&j["columns"][2]).unwrap(),
            r#"{"name":"total","position":3,"typeName":"numeric(10,2)","typeOid":1700,"kind":"numeric","nullable":true,"default":null,"identity":false,"generated":true}"#
        );
        assert_eq!(j["columns"][3]["kind"], "text");
        assert_eq!(j["columns"][1]["comment"], "the code");
        assert_eq!(j["indexes"][2]["columns"], json!([]));
        assert_eq!(
            j.as_object().unwrap().keys().cloned().collect::<Vec<_>>(),
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
                "constraints",
                "comment"
            ]
        );
    }

    #[test]
    fn table_ddl_from_the_catalogs() {
        let mut q = table_fake();
        let ddl = block(object_ddl(&mut q, "public", "orders", "table", None)).unwrap().unwrap();
        assert_eq!(
            ddl,
            "CREATE TABLE \"public\".\"orders\" (\n    \"id\" integer GENERATED ALWAYS AS IDENTITY NOT NULL,\n    \"code\" text COLLATE pg_catalog.\"C\" NOT NULL,\n    \"total\" numeric(10,2) GENERATED ALWAYS AS ((1 + 1)) STORED,\n    \"note\" d_text DEFAULT 'x'::text,\n    CONSTRAINT \"orders_code_key\" UNIQUE (code)\n);\nCREATE INDEX orders_note ON public.orders USING btree (note);\nCOMMENT ON TABLE \"public\".\"orders\" IS 'orders';\nCOMMENT ON COLUMN \"public\".\"orders\".\"code\" IS 'the code';"
        );
    }

    #[test]
    fn view_sequence_and_function_ddl() {
        let mut q = Fake {
            answers: vec![
                ("SELECT c.oid, c.relkind", vec![row(&[Some("5"), Some("m"), Some("10.5"), Some("it's"), Some("f"), Some("p")])]),
                ("SELECT pg_get_viewdef", vec![row(&[Some("  SELECT 1;\n")])]),
                ("SELECT pg_get_indexdef", vec![row(&[Some("CREATE INDEX i ON s.v USING btree (x)")]), row(&[None])]),
            ],
            log: Vec::new(),
        };
        let ddl = block(object_ddl(&mut q, "s", "v", "matview", None)).unwrap().unwrap();
        assert_eq!(
            ddl,
            "CREATE MATERIALIZED VIEW \"s\".\"v\" AS\nSELECT 1\nWITH DATA;\nCREATE INDEX i ON s.v USING btree (x);\nCOMMENT ON MATERIALIZED VIEW \"s\".\"v\" IS 'it''s';"
        );
        let mut q = Fake {
            answers: vec![
                ("SELECT c.oid, c.relkind", vec![row(&[Some("6"), Some("S"), Some("-1"), None, Some("f"), Some("p")])]),
                (
                    "SELECT format_type(s.seqtypid",
                    vec![row(&[Some("bigint"), Some("1"), Some("1"), Some("1"), Some("9"), Some("1"), Some("t")])],
                ),
            ],
            log: Vec::new(),
        };
        let ddl = block(object_ddl(&mut q, "s", "q", "sequence", None)).unwrap().unwrap();
        assert_eq!(
            ddl,
            "CREATE SEQUENCE \"s\".\"q\"\n    AS bigint\n    INCREMENT BY 1\n    MINVALUE 1\n    MAXVALUE 9\n    START WITH 1\n    CACHE 1\n    CYCLE;"
        );
        let mut q = Fake {
            answers: vec![("SELECT pg_get_functiondef", vec![row(&[Some("CREATE FUNCTION f(a int)\n BEGIN END\n"), Some("c")])])],
            log: Vec::new(),
        };
        let ddl = block(object_ddl(&mut q, "s", "f", "procedure", Some("a integer"))).unwrap().unwrap();
        assert_eq!(ddl, "CREATE FUNCTION f(a int)\n BEGIN END;\nCOMMENT ON PROCEDURE \"s\".\"f\"(a integer) IS 'c';");
        assert_eq!(q.log[0].1, ["s", "f", "a integer"]);
        assert!(matches!(block(object_ddl(&mut q, "", "f", "function", None)), Err(MetaError::Sql(DbSqlError::Invalid))));
    }

    #[test]
    fn lists() {
        let mut q = Fake {
            answers: vec![
                (
                    "SELECT c.relname",
                    vec![
                        row(&[Some("t"), Some("r"), None, Some("1.23457e+06"), None]),
                        row(&[Some("v"), Some("v"), None, Some("-1"), Some("")]),
                    ],
                ),
                ("SELECT p.proname", vec![row(&[Some("f"), Some("p"), Some("9"), Some(""), None, Some("doc")])]),
                ("SELECT d.datname", vec![row(&[Some("db"), Some("me"), Some("UTF8"), Some("f"), Some("t"), None, Some("")])]),
            ],
            log: Vec::new(),
        };
        let objects = block(list_objects(&mut q, "public")).unwrap();
        assert_eq!(
            objects,
            json!([
                { "schema": "public", "name": "t", "kind": "table", "oid": 0, "rowEstimate": 1_234_570 },
                { "schema": "public", "name": "v", "kind": "view", "oid": 0 },
                { "schema": "public", "name": "f", "kind": "procedure", "oid": 9, "args": "", "comment": "doc" },
            ])
        );
        let dbs = block(list_databases(&mut q)).unwrap();
        assert_eq!(
            serde_json::to_string(&dbs).unwrap(),
            r#"[{"name":"db","owner":"me","encoding":"UTF8","isTemplate":false,"allowConnections":true,"sizeBytes":null}]"#
        );
    }

    #[test]
    fn attnum_lists() {
        assert_eq!(attnums(Some("1 2")), vec![1.0, 2.0]);
        assert_eq!(attnums(Some("{3,1}")), vec![3.0, 1.0]);
        assert!(attnums(Some("")).is_empty());
        assert!(attnums(None).is_empty());
        assert!(attnums(Some("x"))[0].is_nan());
    }
}
