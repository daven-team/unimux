//! The D3 vectors (scripts/goldens-db.mjs writes them from the TS reference, test/db-sql-vectors.test.ts runs the same rows
//! through the TS code): every SQL and Redis helper of src/shared answers each row exactly like 1.1.4.
//!
//! A row is `{fn, args, out}`; values JSON lacks are tagged ({$num}, {$bigint}, {$bytes}, {$set}, {$undef}) and a throw is
//! {$throws: code}. Numbers compare by value (3 and 3.0 are the same JS number).

use std::collections::{HashMap, HashSet};

use serde_json::{Map, Value, json};
use unimux_core::js_json;
use unimux_db::redis_shared::{self as rs, InfoSection, RedisData};
use unimux_db::sql::mysql::{self as my, FieldLike, Flavor};
use unimux_db::sql::sqlite::{self as sq, Affinity, SqliteParam};
use unimux_db::sql::{
    self, DbSqlError, Dialect, EditOp, Fields, PageSqlInput, Sort, SqlResult, SqlSpan, StagedEdit, ValueKind, js_fields, values,
};

fn rows(name: &str) -> Vec<Value> {
    let path = format!("{}/../../../test/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| js_json::parse(l).unwrap()).collect()
}

// ── tags ────────────────────────────────────────────────────────────────────

fn tag<'a>(v: &'a Value, name: &str) -> Option<&'a Value> {
    v.as_object().filter(|o| o.len() == 1).and_then(|o| o.get(name))
}

fn is_undef(v: Option<&Value>) -> bool {
    v.is_none_or(|v| tag(v, "$undef").is_some())
}

/// A JS number (tags included).
fn num(v: &Value) -> f64 {
    if let Some(Value::String(s)) = tag(v, "$num") {
        return match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            "-0" => -0.0,
            other => panic!("$num {other}"),
        };
    }
    v.as_f64().unwrap_or_else(|| panic!("not a number: {v}"))
}

fn num_json(n: f64) -> Value {
    if n == 0.0 && n.is_sign_negative() {
        json!({"$num": "-0"})
    } else if n.is_nan() {
        json!({"$num": "NaN"})
    } else if n.is_infinite() {
        json!({"$num": if n > 0.0 { "Infinity" } else { "-Infinity" }})
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn bytes_of(v: &Value) -> Vec<u8> {
    let h = tag(v, "$bytes").and_then(Value::as_str).unwrap_or_else(|| panic!("not bytes: {v}"));
    (0..h.len() / 2).map(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap()).collect()
}

fn bytes_json(b: &[u8]) -> Value {
    json!({"$bytes": hex(b)})
}

fn throws(code: &str) -> Value {
    json!({"$throws": code})
}

fn err(e: DbSqlError) -> Value {
    throws(e.code())
}

fn res<T>(r: SqlResult<T>, f: impl FnOnce(T) -> Value) -> Value {
    r.map_or_else(err, f)
}

// ── argument helpers ────────────────────────────────────────────────────────

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("not a string: {v}"))
}

fn opt_s(v: Option<&Value>) -> Option<&str> {
    match v {
        Some(Value::String(x)) => Some(x),
        _ => None,
    }
}

fn strings(v: &Value) -> Vec<String> {
    v.as_array().unwrap_or_else(|| panic!("not an array: {v}")).iter().map(|x| s(x).to_owned()).collect()
}

fn opt_strings(v: Option<&Value>) -> Option<Vec<String>> {
    match v {
        Some(Value::Array(_)) => Some(strings(v.unwrap())),
        _ => None,
    }
}

fn dialect(v: Option<&Value>) -> Dialect {
    opt_s(v).map_or(Dialect::Postgres, |d| Dialect::parse(d).unwrap())
}

fn kind(v: &Value) -> ValueKind {
    ValueKind::parse(s(v)).unwrap_or_else(|| panic!("kind {v}"))
}

fn fields(v: &Value) -> Fields {
    js_fields(v.as_object().unwrap_or_else(|| panic!("not an object: {v}")))
}

fn set(v: Option<&Value>) -> HashSet<String> {
    match v.and_then(|v| tag(v, "$set")) {
        // `binary.has(k)` of a name that is no string never matches a column.
        Some(items) => items.as_array().unwrap().iter().filter_map(|x| x.as_str().map(str::to_owned)).collect(),
        None => HashSet::new(),
    }
}

/// A page input; an `after` holding a non-string is refused by every page builder (the Rust type cannot hold it).
fn page_input(v: &Value) -> Result<PageSqlInput, DbSqlError> {
    let after = match v.get("after") {
        Some(Value::Array(items)) => {
            if items.iter().any(|x| !x.is_string()) && !items.is_empty() {
                return Err(DbSqlError::Invalid);
            }
            Some(strings(&v["after"]))
        }
        _ => None,
    };
    let sort = v.get("sort").and_then(Value::as_array).map(|items| {
        items.iter().map(|x| Sort { column: s(&x["column"]).to_owned(), desc: x["desc"].as_bool().unwrap_or(false) }).collect()
    });
    Ok(PageSqlInput {
        schema: s(&v["schema"]).to_owned(),
        table: s(&v["table"]).to_owned(),
        limit: num(&v["limit"]),
        offset: v.get("offset").filter(|x| !is_undef(Some(x))).map(num),
        after,
        sort,
        filter: v.get("filter").and_then(Value::as_str).map(str::to_owned),
    })
}

/// Staged edits; a shape the Rust type cannot hold is refused where the TS loop reaches it (an earlier edit's error wins).
fn with_edits<T>(v: &Value, build: impl Fn(&[StagedEdit]) -> SqlResult<T>) -> SqlResult<T> {
    let mut edits = Vec::new();
    for e in v.as_array().unwrap() {
        match StagedEdit::from_json(e) {
            Ok(e) => edits.push(e),
            Err(bad) => {
                if edits.is_empty() {
                    return Err(bad);
                }
                build(&edits)?;
                return Err(bad);
            }
        }
    }
    build(&edits)
}

fn span_json(sp: &SqlSpan) -> Value {
    json!({"start": sp.start, "end": sp.end, "text": sp.text})
}

fn sqlite_param(v: &Value) -> SqliteParam {
    if v.is_null() {
        return SqliteParam::Null;
    }
    if let Some(b) = tag(v, "$bigint") {
        return SqliteParam::Integer(s(b).parse().unwrap());
    }
    if tag(v, "$bytes").is_some() {
        return SqliteParam::Blob(bytes_of(v));
    }
    if let Value::String(t) = v {
        return SqliteParam::Text(t.clone());
    }
    SqliteParam::Real(num(v))
}

fn sqlite_param_json(p: &SqliteParam) -> Value {
    match p {
        SqliteParam::Null => Value::Null,
        SqliteParam::Integer(n) => json!({"$bigint": n.to_string()}),
        SqliteParam::Real(f) => num_json(*f),
        SqliteParam::Blob(b) => bytes_json(b),
        SqliteParam::Text(t) => Value::String(t.clone()),
    }
}

fn op(v: &Value) -> EditOp {
    match s(v) {
        "update" => EditOp::Update,
        "insert" => EditOp::Insert,
        "delete" => EditOp::Delete,
        other => panic!("op {other}"),
    }
}

fn sqlite_columns(v: &Value) -> Vec<sq::ColumnMeta> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|c| sq::ColumnMeta {
            name: s(&c["name"]).to_owned(),
            affinity: Affinity::parse(s(&c["affinity"])).unwrap(),
            generated: c["generated"] == true,
        })
        .collect()
}

fn mysql_columns(v: &Value) -> Vec<my::ColumnMeta> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|c| my::ColumnMeta {
            name: s(&c["name"]).to_owned(),
            data_type: s(&c["dataType"]).to_owned(),
            generated: c["generated"] == true,
        })
        .collect()
}

fn redis_data(v: &Value) -> RedisData {
    RedisData::from_json(v).unwrap_or_else(|| panic!("not data: {v}"))
}

fn argv(v: &Value) -> Vec<RedisData> {
    v.as_array().unwrap().iter().map(redis_data).collect()
}

fn class_json(c: &rs::CommandClass) -> Value {
    let mut o = Map::new();
    o.insert("name".into(), json!(c.name));
    o.insert("dangerous".into(), json!(c.dangerous));
    if let Some(r) = c.refused {
        o.insert("refused".into(), json!(r.as_str()));
    }
    o.insert("status".into(), json!(c.status));
    Value::Object(o)
}

fn info_json(sections: &[InfoSection]) -> Value {
    Value::Array(
        sections
            .iter()
            .map(|x| json!({"name": x.name, "entries": x.entries.iter().map(|(k, v)| json!([k, v])).collect::<Vec<_>>()}))
            .collect(),
    )
}

fn opt_string(o: Option<String>) -> Value {
    o.map_or(Value::Null, Value::String)
}

/// `fn(...args)` in Rust, as the JSON the TS side wrote.
fn call(f: &str, a: &[Value]) -> Value {
    let arg = |i: usize| a.get(i).filter(|v| !is_undef(Some(v)));
    match f {
        // ── dbSql.ts
        "quoteIdent" => res(sql::quote_ident(s(&a[0]), dialect(arg(1))), Value::String),
        "qualifiedName" => res(sql::qualified_name(s(&a[0]), s(&a[1]), dialect(arg(2))), Value::String),
        "quoteLiteral" => json!(sql::quote_literal(opt_s(arg(0)))),
        "splitSql" => Value::Array(sql::split_sql(s(&a[0]), dialect(arg(1))).iter().map(span_json).collect()),
        "errorSpan" => {
            let (from, to) = sql::error_span(s(&a[0]), num(&a[1]) as i64);
            json!({"from": from, "to": to})
        }
        "statementAt" => sql::statement_at(s(&a[0]), num(&a[1]), dialect(arg(2))).as_ref().map_or(Value::Null, span_json),
        "firstKeyword" => json!(sql::first_keyword(s(&a[0]))),
        "codeOnly" => json!(sql::code_only(s(&a[0]))),
        "returnsRows" => json!(sql::returns_rows(s(&a[0]))),
        "isReadStatement" => json!(sql::is_read_statement(s(&a[0]))),
        "readOnlyAllows" => json!(sql::read_only_allows(s(&a[0]))),
        "endsTransaction" => json!(sql::ends_transaction(s(&a[0]))),
        "buildEditStatements" => {
            let keys = opt_strings(arg(2));
            let columns = opt_strings(arg(4));
            let read_only = opt_strings(arg(5)).unwrap_or_default();
            let types: Option<HashMap<String, String>> =
                arg(6).and_then(Value::as_object).map(|o| o.iter().map(|(k, v)| (k.clone(), s(v).to_owned())).collect());
            let built = with_edits(&a[3], |edits| {
                sql::build_edit_statements(
                    s(&a[0]),
                    s(&a[1]),
                    keys.as_deref(),
                    edits,
                    columns.as_deref(),
                    &read_only,
                    types.as_ref(),
                )
            });
            res(built, |list| {
                Value::Array(
                    list.iter()
                        .map(|b| json!({"op": b.op.as_str(), "index": b.index, "sql": b.sql, "params": b.params.iter().cloned().map(opt_string).collect::<Vec<_>>()}))
                        .collect(),
                )
            })
        }
        "inlineParams" => {
            let params: Vec<Option<String>> = a[1].as_array().unwrap().iter().map(|p| p.as_str().map(str::to_owned)).collect();
            json!(sql::inline_params(s(&a[0]), &params))
        }
        "editPreview" => {
            let list: Vec<sql::BuiltStatement> = a[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| sql::BuiltStatement {
                    op: op(&b["op"]),
                    index: b["index"].as_u64().unwrap() as usize,
                    sql: s(&b["sql"]).to_owned(),
                    params: b["params"].as_array().unwrap().iter().map(|p| p.as_str().map(str::to_owned)).collect(),
                })
                .collect();
            json!(sql::edit_preview(&list))
        }
        "pageSql" => res(
            page_input(&a[0]).and_then(|input| sql::page_sql(&input, opt_strings(arg(1)).as_deref())),
            |p| json!({"sql": p.sql, "params": p.params, "keyset": p.keyset}),
        ),
        "cellSql" => res(
            sql::cell_sql(s(&a[0]), s(&a[1]), s(&a[2]), &fields(&a[3]), &strings(&a[4])),
            |(q, params)| json!({"sql": q, "params": params}),
        ),
        "valueKind" => json!(sql::value_kind(num(&a[0]) as i64, opt_s(arg(1))).as_str()),
        "isNumericKind" => json!(sql::is_numeric_kind(kind(&a[0]))),
        "dbValueText" => opt_string(values::db_value_text(&a[0])),
        "formatDbValue" => {
            let pretty = arg(2).is_some_and(|o| o["pretty"] == true);
            opt_string(values::format_db_value(&a[0], kind(&a[1]), pretty))
        }
        "parseDbInput" => {
            let opts = arg(2);
            let as_null = opts.is_some_and(|o| o["asNull"] == true);
            let type_name = opts.and_then(|o| o.get("typeName")).and_then(Value::as_str);
            match values::parse_db_input(kind(&a[0]), s(&a[1]), as_null, type_name) {
                Ok(v) => json!({"ok": true, "value": v}),
                Err(e) => json!({"ok": false, "error": e}),
            }
        }
        "rowsToCsv" => {
            let names: Vec<String> = a[0].as_array().unwrap().iter().map(|c| s(&c["name"]).to_owned()).collect();
            let rows: Vec<Vec<Value>> = a[1].as_array().unwrap().iter().map(|r| r.as_array().unwrap().clone()).collect();
            json!(values::rows_to_csv(&names, &rows, opt_s(arg(2)).unwrap_or(",")))
        }
        "rowsToTsv" => {
            let rows: Vec<Vec<Value>> = a[0].as_array().unwrap().iter().map(|r| r.as_array().unwrap().clone()).collect();
            json!(values::rows_to_tsv(&rows))
        }
        "jsonValue" => values::json_value(&a[0], kind(&a[1])),
        "rowsToJson" => {
            let cols: Vec<(String, ValueKind)> =
                a[0].as_array().unwrap().iter().map(|c| (s(&c["name"]).to_owned(), kind(&c["kind"]))).collect();
            let rows: Vec<Vec<Value>> = a[1].as_array().unwrap().iter().map(|r| r.as_array().unwrap().clone()).collect();
            json!(values::rows_to_json(&cols, &rows))
        }
        // ── dbSqlite.ts
        "sqliteAffinity" => json!(sq::sqlite_affinity(opt_s(arg(0))).as_str()),
        "sqliteValueKind" => json!(sq::sqlite_value_kind(opt_s(arg(0))).as_str()),
        "sqliteParam" => sqlite_param_json(&sq::sqlite_param(opt_s(arg(0)), Affinity::parse(s(&a[1])).unwrap())),
        "sqIdent" => res(sq::sq_ident(s(&a[0])), Value::String),
        "sqQualified" => res(sq::sq_qualified(s(&a[0]), s(&a[1])), Value::String),
        "sqliteCodeOnly" => json!(sq::sqlite_code_only(s(&a[0]))),
        "sqliteReadOnlyAllows" => json!(sq::sqlite_read_only_allows(s(&a[0]))),
        "sqliteIsReadStatement" => json!(sq::sqlite_is_read_statement(s(&a[0]))),
        "sqliteEndsTransaction" => json!(sq::sqlite_ends_transaction(s(&a[0]))),
        "sqliteErrorPosition" => json!(sq::sqlite_error_position(s(&a[0]), s(&a[1]))),
        "sqlitePageSql" => res(
            page_input(&a[0]).and_then(|input| sq::sqlite_page_sql(&input, opt_strings(arg(1)).as_deref(), opt_s(arg(2)))),
            Value::String,
        ),
        "sqliteCellSql" => res(
            sq::sqlite_cell_sql(
                s(&a[0]),
                s(&a[1]),
                s(&a[2]),
                &fields(&a[3]),
                &strings(&a[4]),
                &sqlite_columns(&a[5]),
                opt_s(arg(6)),
            ),
            |b| json!({"sql": b.sql, "params": b.params.iter().map(sqlite_param_json).collect::<Vec<_>>()}),
        ),
        "sqliteInline" => {
            let params: Vec<SqliteParam> = a[1].as_array().unwrap().iter().map(sqlite_param).collect();
            json!(sq::sqlite_inline(s(&a[0]), &params))
        }
        "sqliteEditStatements" => {
            let keys = opt_strings(arg(2));
            let cols = sqlite_columns(&a[4]);
            let built = with_edits(&a[3], |edits| {
                sq::sqlite_edit_statements(s(&a[0]), s(&a[1]), keys.as_deref(), edits, &cols, opt_s(arg(5)))
            });
            res(built, |list| {
                Value::Array(
                    list.iter()
                        .map(|b| {
                            json!({"op": b.op.as_str(), "index": b.index, "sql": b.sql, "params": b.params.iter().map(sqlite_param_json).collect::<Vec<_>>(), "preview": b.preview})
                        })
                        .collect(),
                )
            })
        }
        "sqliteEditPreview" => {
            let list: Vec<sq::BuiltStatement> = a[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| sq::BuiltStatement {
                    op: op(&b["op"]),
                    index: b["index"].as_u64().unwrap() as usize,
                    sql: s(&b["sql"]).to_owned(),
                    params: b["params"].as_array().unwrap().iter().map(sqlite_param).collect(),
                    preview: s(&b["preview"]).to_owned(),
                })
                .collect();
            json!(sq::sqlite_edit_preview(&list))
        }
        // ── dbMysql.ts
        "mysqlLiteral" => json!(my::mysql_literal(opt_s(arg(0)), arg(1).is_some_and(|b| b == true))),
        "mysqlDisplayLiteral" => json!(my::mysql_display_literal(opt_s(arg(0)))),
        "myIdent" => res(my::my_ident(s(&a[0])), Value::String),
        "myQualified" => res(my::my_qualified(s(&a[0]), s(&a[1])), Value::String),
        "mysqlCodeOnly" => json!(my::mysql_code_only(s(&a[0]))),
        "mysqlReadOnlyAllows" => json!(my::mysql_read_only_allows(s(&a[0]))),
        "mysqlIsReadStatement" => json!(my::mysql_is_read_statement(s(&a[0]))),
        "mysqlEndsTransaction" => json!(my::mysql_ends_transaction(s(&a[0]))),
        "mysqlIsUse" => json!(my::mysql_is_use(s(&a[0]))),
        "mysqlTimeoutSql" => {
            let flavor = if s(&a[0]) == "mariadb" { Flavor::Mariadb } else { Flavor::Mysql };
            json!(my::mysql_timeout_sql(flavor, arg(1).filter(|v| !v.is_null()).map(num)))
        }
        "mysqlFieldBinary" | "mysqlFieldKind" => {
            let o = &a[0];
            let field = FieldLike {
                column_type: num(&o["columnType"]) as i64,
                character_set: num(&o["characterSet"]) as i64,
                flags: num(&o["flags"]) as i64,
                extended_type_name: o.get("extendedTypeName").and_then(Value::as_str).map(str::to_owned),
                extended_format: o.get("extendedFormat").and_then(Value::as_str).map(str::to_owned),
            };
            if f == "mysqlFieldBinary" {
                json!(my::mysql_field_binary(&field))
            } else {
                let (k, name) = my::mysql_field_kind(&field);
                json!({"kind": k.as_str(), "typeName": name})
            }
        }
        "mysqlBinaryType" => json!(my::mysql_binary_type(s(&a[0]))),
        "mysqlColumnKind" => json!(my::mysql_column_kind(s(&a[0]), s(&a[1])).as_str()),
        "mysqlPageSql" => res(
            page_input(&a[0]).and_then(|input| my::mysql_page_sql(&input, opt_strings(arg(1)).as_deref(), &set(arg(2)))),
            |(q, keyset)| json!({"sql": q, "keyset": keyset}),
        ),
        "mysqlCellSql" => {
            res(my::mysql_cell_sql(s(&a[0]), s(&a[1]), s(&a[2]), &fields(&a[3]), &strings(&a[4]), &set(arg(5))), Value::String)
        }
        "mysqlEditStatements" => {
            let keys = opt_strings(arg(2));
            let cols = mysql_columns(&a[4]);
            let built = with_edits(&a[3], |edits| my::mysql_edit_statements(s(&a[0]), s(&a[1]), keys.as_deref(), edits, &cols));
            res(built, |list| {
                Value::Array(
                    list.iter()
                        .map(|b| json!({"op": b.op.as_str(), "index": b.index, "sql": b.sql, "preview": b.preview}))
                        .collect(),
                )
            })
        }
        "mysqlEditPreview" => {
            let list: Vec<my::BuiltStatement> = a[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| my::BuiltStatement {
                    op: op(&b["op"]),
                    index: b["index"].as_u64().unwrap() as usize,
                    sql: s(&b["sql"]).to_owned(),
                    preview: s(&b["preview"]).to_owned(),
                })
                .collect();
            json!(my::mysql_edit_preview(&list))
        }
        "mysqlErrorText" => json!(my::mysql_error_text(arg(0).map(num), opt_s(arg(1)), s(&a[2]))),
        "mysqlErrorPosition" => json!(my::mysql_error_position(s(&a[0]), s(&a[1]))),
        "mysqlFlavorOf" => json!(my::mysql_flavor_of(s(&a[0]), opt_s(arg(1)).unwrap_or("")).as_str()),
        "mysqlServerLabel" => json!(my::mysql_server_label(s(&a[0]), opt_s(arg(1)).unwrap_or(""))),
        "redactSql" => json!(sql::redact_sql(s(&a[0]))),
        // ── dbRedis.ts
        "bytesToBase64" => json!(rs::bytes_to_base64(&bytes_of(&a[0]))),
        "base64ToBytes" => rs::base64_to_bytes(s(&a[0])).map_or_else(|| throws("error"), |b| bytes_json(&b)),
        "redisDataFromBytes" => rs::data_from_bytes(&bytes_of(&a[0])).to_json(),
        "redisDataBytes" => rs::data_bytes(&redis_data(&a[0])).map_or_else(|| throws("error"), |b| bytes_json(&b)),
        "redisDataLength" => rs::data_length(&redis_data(&a[0])).map_or_else(|| throws("error"), |n| json!(n)),
        "redisDataHex" => {
            rs::data_hex(&redis_data(&a[0]), opt_s(arg(1)).unwrap_or(" ")).map_or_else(|| throws("error"), Value::String)
        }
        "redisDataFromHex" => rs::data_from_hex(s(&a[0])).map_or(Value::Null, |d| d.to_json()),
        "redisDataDisplay" => display(&redis_data(&a[0])).map_or_else(|| throws("error"), Value::String),
        "redisDataKey" => json!(rs::data_key(&redis_data(&a[0]))),
        "redisDataEquals" => json!(rs::data_equals(&redis_data(&a[0]), &redis_data(&a[1]))),
        "parseRedisCommandLine" => match rs::parse_command_line(s(&a[0])) {
            Ok(list) => json!({"ok": true, "argv": list.iter().map(RedisData::to_json).collect::<Vec<_>>()}),
            Err(e) => json!({"ok": false, "error": e.as_str()}),
        },
        "quoteRedisArg" => {
            let d = redis_data(&a[0]);
            display(&d).map_or_else(|| throws("error"), |_| json!(rs::quote_arg(&d)))
        }
        "redisCommandName" => json!(rs::command_name(&argv(&a[0]))),
        "classifyRedisCommand" => class_json(&rs::classify_command(&argv(&a[0]))),
        "parseRedisInfo" => info_json(&rs::parse_info(s(&a[0]))),
        "parseRedisKeyspace" => {
            let sections: Vec<InfoSection> = a[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| InfoSection {
                    name: s(&x["name"]).to_owned(),
                    entries: x["entries"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|e| (s(&e[0]).to_owned(), s(&e[1]).to_owned()))
                        .collect(),
                })
                .collect();
            Value::Array(
                rs::parse_keyspace(&sections)
                    .iter()
                    .map(|d| json!({"index": num_json(d.index), "keys": num_json(d.keys), "expires": num_json(d.expires), "avgTtlMs": num_json(d.avg_ttl_ms)}))
                    .collect(),
            )
        }
        "parseRedisClientList" => Value::Array(rs::parse_client_list(s(&a[0])).into_iter().map(Value::Object).collect()),
        "isStreamId" => json!(rs::is_stream_id(s(&a[0]))),
        "streamIdStep" => opt_string(rs::stream_id_step(s(&a[0]), num(&a[1]) > 0.0)),
        other => panic!("no Rust port mapped for {other}"),
    }
}

/// `redisDataDisplay`, None where TS throws (atob of broken base64).
fn display(d: &RedisData) -> Option<String> {
    rs::data_bytes(d).map(|_| rs::data_display(d))
}

/// What JSON.stringify writes for a value: NaN and the infinities as null, -0 as 0.
fn stringify_view(v: &Value) -> Value {
    if let Some(n) = tag(v, "$num") {
        return if n == "-0" { json!(0) } else { Value::Null };
    }
    match v {
        Value::Array(x) => Value::Array(x.iter().map(stringify_view).collect()),
        Value::Object(o) => Value::Object(o.iter().map(|(k, x)| (k.clone(), stringify_view(x))).collect()),
        _ => v.clone(),
    }
}

/// Same JSON, numbers compared as JS numbers.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

fn check(file: &str, min_rows: usize) {
    let rows = rows(file);
    assert!(rows.len() >= min_rows, "{file}: only {} rows", rows.len());
    let mut failures = Vec::new();
    let mut per_fn: HashMap<String, usize> = HashMap::new();
    for (i, row) in rows.iter().enumerate() {
        let f = s(&row["fn"]);
        *per_fn.entry(f.to_owned()).or_default() += 1;
        let args = row["args"].as_array().unwrap();
        let got = match std::panic::catch_unwind(|| call(f, args)) {
            Ok(v) => v,
            Err(e) => {
                json!({"$panic": e.downcast_ref::<String>().cloned().or_else(|| e.downcast_ref::<&str>().map(|x| x.to_string()))})
            }
        };
        // jsonValue only feeds JSON.stringify (rowsToJson): the Rust port answers what that writes, a NaN or an infinity as null.
        let want = if f == "jsonValue" { stringify_view(&row["out"]) } else { row["out"].clone() };
        if !same(&got, &want) {
            failures.push(format!("row {i} {f}({}):\n  rust: {got}\n  ts:   {}", cut(&row["args"].to_string()), row["out"]));
        }
    }
    let shown: Vec<_> = failures.iter().take(120).cloned().collect();
    assert!(failures.is_empty(), "{file}: {} of {} rows differ:\n{}", failures.len(), rows.len(), shown.join("\n"));
    eprintln!("{file}: {} rows, {} functions", rows.len(), per_fn.len());
}

fn cut(s: &str) -> String {
    if s.len() <= 400 {
        s.to_owned()
    } else {
        format!("{}...", &s[..s.char_indices().take_while(|(i, _)| *i < 400).last().map_or(0, |(i, _)| i)])
    }
}

#[test]
fn sql_helpers_match_the_ts_reference() {
    check("db-sql.jsonl", 50_000);
}

#[test]
fn redis_helpers_match_the_ts_reference() {
    check("db-redis.jsonl", 5_000);
}

/// A script at the 8 MiB limit (DB_LIMITS.sql) is split and checked in linear time, in every dialect.
#[test]
fn a_script_at_the_size_limit_is_handled_in_linear_time() {
    let unit = "INSERT INTO t VALUES (1, 'a;b', \"c\", $$d;$$) -- x;\n/* y; */ SELECT 2 FROM `t` WHERE [a] = 'it''s';\n";
    let script = unit.repeat(sql::limits::SQL / unit.len());
    let one = format!("SELECT '{}'", "x;".repeat(sql::limits::SQL / 2 - 8));
    for d in [Dialect::Postgres, Dialect::Mysql, Dialect::Sqlite] {
        let started = std::time::Instant::now();
        let n = sql::split_sql(&script, d).len();
        assert!(n > 80_000, "{d:?}: {n}");
        assert_eq!(sql::split_sql(&one, d).len(), 1);
        assert!(started.elapsed().as_secs_f64() < 10.0, "{d:?}: {:?}", started.elapsed());
    }
    let started = std::time::Instant::now();
    for text in [&script, &one] {
        sql::read_only_allows(text);
        sq::sqlite_read_only_allows(text);
        my::mysql_read_only_allows(text);
        sql::is_read_statement(text);
        sql::redact_sql(text);
    }
    assert!(started.elapsed().as_secs_f64() < 10.0, "{:?}", started.elapsed());
}
