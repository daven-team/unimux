//! The D1 vectors (scripts/goldens-db-ipc.mjs writes them from the TS reference, test/db-ipc-vectors.test.ts runs the same
//! rows through the TS code): the zod schemas in front of every db:* channel, the Redis byte budget, strictConnection and
//! the connection helpers, and the query history helpers answer each row exactly like 1.1.4 (objects compared as
//! JSON.stringify text, so the key order of what is stored matches too). Plus the IPC cases of test/db-main.test.ts.

mod common;

use common::*;
use serde_json::{Map, Value, json};
use unimux_core::js_json;
use unimux_db::history::{
    add_history, clear_history_entries, history_record, normalize_history_file, normalize_history_item, star_history,
};
use unimux_db::ipc;
use unimux_db::model::{db_default_database, db_endpoint, duplicate_db_connection, strict_connection};
use unimux_db::redis_shared::limits::WRITE_BYTES;
use unimux_db::service::PasswordChange;
use unimux_db::sqlite_files::valid_db_file_path;

fn rows() -> Vec<Value> {
    let path = format!("{}/../../../test/golden/db-ipc.jsonl", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| js_json::parse(l).unwrap()).collect()
}

fn opt(v: Option<Value>) -> Value {
    v.unwrap_or(Value::Null)
}

fn list(v: &Value) -> Vec<Value> {
    v.as_array().cloned().unwrap_or_default()
}

fn answer(fn_name: &str, a: &[Value]) -> Value {
    match fn_name {
        "schema" => {
            let schema = ipc::schema(a[0].as_str().unwrap()).unwrap_or_else(|| panic!("no schema {}", a[0]));
            json!(schema.check(&a[1]))
        }
        "redisOp" => {
            if ipc::redis_op().check(&a[0]) {
                json!(ipc::total_bytes(&a[0]))
            } else {
                Value::Null
            }
        }
        "strictConnection" => opt(strict_connection(&a[0])),
        "dbEndpoint" => json!(db_endpoint(&a[0])),
        "dbDefaultDatabase" => json!(db_default_database(&a[0])),
        "duplicateDbConnection" => {
            duplicate_db_connection(&a[0], a[1].as_str().unwrap(), a[2].as_str().unwrap(), a[3].as_i64().unwrap())
        }
        "validDbFilePath" => json!(a[0].as_str().is_some_and(valid_db_file_path)),
        "historyRecord" => opt(history_record(&a[0])),
        "normalizeHistoryItem" => opt(normalize_history_item(&a[0])),
        "normalizeHistoryFile" => {
            let f = normalize_history_file(&a[0]);
            let connections: Vec<Value> = f.connections.iter().map(|(k, v)| json!([k, v])).collect();
            json!({ "enabled": f.enabled, "connections": connections, "newer": f.newer, "invalid": f.invalid })
        }
        "addHistory" => {
            let mut n = 0;
            let mut next = || {
                n += 1;
                format!("id{n}")
            };
            json!(add_history(&list(&a[0]), &list(&a[1]), &mut next, a[2].as_u64().unwrap() as usize))
        }
        "starHistory" => opt(star_history(&list(&a[0]), a[1].as_str().unwrap(), a[2].as_bool().unwrap()).map(Value::Array)),
        "clearHistoryEntries" => json!(clear_history_entries(&list(&a[0]), a[1] == json!(true))),
        other => panic!("no function {other}"),
    }
}

#[test]
fn every_row_is_answered_like_the_ts_reference() {
    let rows = rows();
    assert!(rows.len() > 20_000, "{} rows", rows.len());
    let mut failures = Vec::new();
    let mut seen: Map<String, Value> = Map::new();
    for (i, row) in rows.iter().enumerate() {
        let fn_name = row["fn"].as_str().unwrap();
        let args = row["args"].as_array().unwrap();
        let got = answer(fn_name, args);
        *seen.entry(fn_name).or_insert(json!(0)) = json!(seen.get(fn_name).and_then(Value::as_u64).unwrap_or(0) + 1);
        if js_json::stringify(&got) != js_json::stringify(&row["out"]) {
            let input: String = js_json::stringify(&row["args"]).chars().take(300).collect();
            failures.push(format!(
                "row {i} {fn_name} {input}: {} != {}",
                js_json::stringify(&got),
                js_json::stringify(&row["out"])
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.iter().take(25).cloned().collect::<Vec<_>>().join("\n")
    );
    for f in ["schema", "redisOp", "strictConnection", "historyRecord", "normalizeHistoryFile", "addHistory", "starHistory"] {
        assert!(seen.contains_key(f), "no rows of {f}");
    }
    // The schemas say yes and no often enough to mean something.
    let accepted = rows.iter().filter(|r| r["fn"] == "schema" && r["out"] == true).count();
    assert!(accepted > 1000, "{accepted} accepted");
}

#[test]
fn a_redis_request_over_the_byte_budget_is_refused() {
    let half = "a".repeat(WRITE_BYTES / 2 + 1);
    let over = json!({ "kind": "write", "write": { "op": "lpush", "key": "k", "items": [half, half] } });
    assert!(ipc::redis_op().check(&over));
    assert!(!ipc::valid_redis_op(&over));
    let under =
        json!({ "kind": "write", "write": { "op": "lpush", "key": "k", "items": [half, "a".repeat(WRITE_BYTES / 2 - 64)] } });
    assert!(ipc::valid_redis_op(&under));
}

// ── DB IPC validation (test/db-main.test.ts) ──────────────────────────────────

#[tokio::test]
async fn refuses_malformed_requests_before_the_service_sees_them() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let s = &t.service;
    let invalid = json!({ "ok": false, "error": "invalid" });
    assert_eq!(ipc::save(s, &with(input(), json!({ "extra": 1 })), &json!({ "keep": true })), invalid);
    assert_eq!(ipc::save(s, &input(), &json!({ "set": "" })), invalid);
    let saved = ipc::save(s, &input(), &json!({ "set": "pw" }));
    assert_eq!(saved["ok"], true);
    let id = saved["connection"]["id"].clone();
    assert_eq!(ipc::connect(s, &json!("nope"), &Value::Null), invalid);
    let c = ipc::connect(s, &id, &json!({ "database": "x" }));
    assert_eq!(c["ok"], true);
    let sid = c["sessionId"].clone();
    assert_eq!(ipc::pg(s, &json!("sftp:00000000-0000-4000-8000-000000000001"), &json!({ "op": "schemas" }), None).await, invalid);
    assert_eq!(ipc::pg(s, &sid, &json!({ "op": "drop" }), None).await, invalid);
    assert_eq!(ipc::pg(s, &sid, &json!({ "op": "query", "req": { "queryId": "x", "sql": "SELECT 1" } }), None).await, invalid);
    let page = json!({ "op": "tablePage", "req": { "queryId": "00000000-0000-4000-8000-000000000001", "schema": "s", "table": "t", "limit": 0 } });
    assert_eq!(ipc::pg(s, &sid, &page, None).await, invalid);
    let edits = json!({ "op": "applyEdits", "req": { "schema": "s", "table": "t", "edits": [{ "op": "update", "key": {}, "set": { "a": "1" } }] } });
    assert_eq!(ipc::pg(s, &sid, &edits, None).await, invalid);
    // A valid one reaches the service (not connected yet).
    assert_eq!(ipc::pg(s, &sid, &json!({ "op": "schemas" }), None).await, json!({ "ok": false, "error": "notConnected" }));
    assert_eq!(ipc::answer_prompt(s, &json!({ "sessionId": sid, "promptId": "x", "cancel": true })), json!({ "ok": false }));
    assert_eq!(ipc::test(s, &with(input(), json!({ "id": id })), &Value::Null).await, invalid);
    ipc::pin(s, &json!(["bad"]), "main");
    ipc::pin(s, &json!([sid]), "main");
    // Redis requests go through the same gate.
    assert_eq!(ipc::redis(s, &sid, &json!({ "kind": "flushall" }), None).await, invalid);
    assert_eq!(ipc::redis(s, &sid, &json!({ "kind": "databases" }), None).await, json!({ "ok": false, "error": "notConnected" }));
    assert_eq!(ipc::disconnect(s, &json!("x")), json!({ "ok": false }));
    assert_eq!(ipc::remove(s, &json!(1)), json!({ "ok": false }));
    assert_eq!(ipc::duplicate(s, &json!("x")), json!({ "ok": false }));
}

#[tokio::test]
async fn saves_a_file_connection_through_the_ipc_validation_and_opens_it_with_its_path_no_password_no_tunnel() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let s = &t.service;
    let file = "C:\\data\\shop.sqlite";
    let sqlite = json!({ "kind": "sqlite", "name": "shop", "host": "", "port": 0, "user": "", "tls": "disable", "ssh": null, "readOnly": true, "path": file });
    let saved = ipc::save(s, &sqlite, &json!({ "keep": true }));
    assert_eq!(saved["ok"], true);
    for (k, v) in [("kind", json!("sqlite")), ("path", json!(file)), ("port", json!(0)), ("readOnly", json!(true))] {
        assert_eq!(saved["connection"][k], v, "{k}");
    }
    let id = saved["connection"]["id"].clone();
    assert_eq!(ipc::save(s, &with(sqlite.clone(), json!({ "path": "relative.db" })), &json!({ "keep": true })), ipc::invalid());
    assert_eq!(ipc::save(s, &with(sqlite.clone(), json!({ "port": 5 })), &json!({ "keep": true })), ipc::invalid());
    // Another database of the "server" does not exist for a file: the option is ignored.
    assert_eq!(ipc::connect(s, &id, &json!({ "database": "other" }))["ok"], true);
    flush().await;
    let open = t.opens()[0].clone();
    assert_eq!(open["config"]["kind"], "sqlite");
    assert_eq!(open["config"]["path"], file);
    assert_eq!(open["config"]["database"], "main");
    assert_eq!(open["config"]["readOnly"], true);
    assert_eq!(open["config"]["ssh"], Value::Null);
    assert!(open["config"].get("password").is_none());
    let _ = PasswordChange::Keep;
}

#[test]
fn export_names_and_sqlite_paths_are_checked() {
    assert!(ipc::export_request(&json!("result.csv"), &json!("a,b")).is_some());
    for bad in [json!(""), json!("a/b.csv"), json!("a\\b.csv"), json!("a\0.csv"), json!("x".repeat(201)), json!(1)] {
        assert!(ipc::export_request(&bad, &json!("t")).is_none(), "{bad}");
    }
    assert!(ipc::export_request(&json!("a.csv"), &json!(1)).is_none());
    assert_eq!(ipc::export_extension("result.json"), "json");
    assert_eq!(ipc::export_extension("noext"), "noext");
    assert_eq!(ipc::sqlite_create_at(&json!(1)), ipc::invalid());
    assert_eq!(ipc::sqlite_create_at(&json!("relative.db")), ipc::invalid());
}
