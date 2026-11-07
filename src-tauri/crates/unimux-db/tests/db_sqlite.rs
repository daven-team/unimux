//! D11: SQLite sessions against real temporary database files (port of test/db-sqlite.int.test.ts): opening (missing file,
//! not a database, an empty file), the tree (tables, views, indexes, triggers), table info (primary key, rowid, unique keys,
//! foreign keys), pages with sort, filter and paging, staged edits (rowid and primary key, conflicts), whole cells, SQL runs
//! (several statements, "load more", errors with their position), read-only refusals and the one-run override,
//! transactions, cancel (a row loop and a statement stuck in one step), and another connection holding the file's lock.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use rusqlite::Connection;
use rusqlite::functions::FunctionFlags;
use serde_json::{Value, json};
use unimux_db::sqlite::{PortColumn, PortMessage, SqliteOptions, SqliteOut, SqliteSession};
use unimux_db::wire::value::DbValue;

#[derive(Default)]
struct Rec {
    port: Mutex<Vec<PortMessage>>,
    tx: Mutex<Vec<&'static str>>,
    fatal: Mutex<Vec<(&'static str, Option<String>)>>,
    notices: Mutex<Vec<String>>,
}

impl SqliteOut for Rec {
    fn port(&self, m: PortMessage) {
        // every message must be valid JSON
        serde_json::from_str::<Value>(&m.to_json()).expect("port JSON");
        self.port.lock().push(m);
    }
    fn tx(&self, tx: &'static str) {
        self.tx.lock().push(tx);
    }
    fn activity(&self, _busy: bool) {}
    fn notice(&self, message: &str) {
        self.notices.lock().push(message.to_owned());
    }
    fn fatal(&self, error: &'static str, message: Option<String>) {
        self.fatal.lock().push((error, message));
    }
}

type Row = Vec<Option<String>>;

#[derive(Default, Debug)]
struct Stmt {
    columns: Vec<PortColumn>,
    rows: Vec<Row>,
    /// (command, rowCount, rows, hasMore, truncated)
    end: Option<(String, Option<u64>, u64, bool, bool)>,
    /// (code, server message, position)
    error: Option<(&'static str, Option<String>, Option<usize>)>,
}

#[derive(Debug)]
struct Collected {
    statements: Vec<Stmt>,
    /// (ok, cancelled, tx)
    end: Option<(bool, bool, &'static str)>,
}

fn text(v: &DbValue) -> Option<String> {
    match v {
        DbValue::Null => None,
        DbValue::Text(s) => Some(s.clone()),
        DbValue::Trunc { head, .. } => Some(head.text.clone()),
    }
}

fn rows(r: &[[&str; 1]]) -> Vec<Row> {
    r.iter().map(|x| vec![Some(x[0].to_owned())]).collect()
}

struct H {
    rec: Arc<Rec>,
    s: SqliteSession,
    seq: AtomicUsize,
}

impl H {
    async fn open(path: &str, f: impl FnOnce(&mut SqliteOptions)) -> Result<H, unimux_db::sqlite::OpenError> {
        let rec = Arc::new(Rec::default());
        let mut opts = SqliteOptions::new(path, false);
        f(&mut opts);
        let s = SqliteSession::open(opts, rec.clone()).await?;
        Ok(H { rec, s, seq: AtomicUsize::new(0) })
    }

    async fn op(&self, op: Value) -> Value {
        self.s.handle(&op).await
    }

    async fn value(&self, op: Value) -> Value {
        let r = self.op(op).await;
        assert_eq!(r["ok"], json!(true), "{r}");
        r["value"].clone()
    }

    fn collect(&self, query_id: &str) -> Collected {
        let mut c = Collected { statements: Vec::new(), end: None };
        let at = |c: &mut Collected, i: usize| {
            while c.statements.len() <= i {
                c.statements.push(Stmt::default());
            }
        };
        for m in self.rec.port.lock().iter().filter(|m| m.query_id() == query_id) {
            match m {
                PortMessage::Statement { index, .. } => at(&mut c, *index),
                PortMessage::Columns { index, columns, .. } => {
                    at(&mut c, *index);
                    c.statements[*index].columns = columns.clone();
                }
                PortMessage::Rows { index, rows, .. } => {
                    at(&mut c, *index);
                    c.statements[*index].rows.extend(rows.iter().map(|r| r.iter().map(text).collect::<Row>()));
                }
                PortMessage::StatementEnd { index, command, row_count, rows, has_more, truncated, .. } => {
                    at(&mut c, *index);
                    c.statements[*index].end = Some((command.clone(), *row_count, *rows, *has_more, *truncated));
                }
                PortMessage::StatementError { index, error, server, .. } => {
                    at(&mut c, *index);
                    c.statements[*index].error =
                        Some((error, server.as_ref().map(|s| s.message.text.clone()), server.as_ref().and_then(|s| s.position)));
                }
                PortMessage::QueryEnd { ok, cancelled, tx, .. } => c.end = Some((*ok, *cancelled, tx)),
                PortMessage::ResultClosed { .. } => {}
            }
        }
        c
    }

    fn ended(&self, query_id: &str) -> bool {
        self.rec.port.lock().iter().any(|m| matches!(m, PortMessage::QueryEnd { query_id: q, .. } if q == query_id))
    }

    async fn wait(&self, f: impl Fn() -> bool, ms: u64) {
        let t = Instant::now();
        while !f() {
            assert!(t.elapsed() < Duration::from_millis(ms), "timed out");
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    fn next_id(&self) -> String {
        format!("q{}", self.seq.fetch_add(1, Ordering::SeqCst))
    }

    /// Starts a run; `wait`: until its queryEnd.
    async fn run_with(&self, mut req: Value, wait: bool) -> (String, Collected) {
        let id = self.next_id();
        req["queryId"] = json!(id);
        let r = self.op(json!({ "op": "query", "req": req })).await;
        assert_eq!(r, json!({ "ok": true, "value": true }));
        if wait {
            self.wait(|| self.ended(&id), 20_000).await;
        }
        let c = self.collect(&id);
        (id, c)
    }

    async fn run(&self, sql: &str) -> Collected {
        self.run_with(json!({ "sql": sql }), true).await.1
    }

    async fn page(&self, mut req: Value) -> Collected {
        let id = self.next_id();
        req["queryId"] = json!(id);
        let r = self.op(json!({ "op": "tablePage", "req": req })).await;
        assert_eq!(r["ok"], json!(true));
        self.wait(|| self.ended(&id), 20_000).await;
        self.collect(&id)
    }

    async fn more(&self, query_id: &str, count: u64) {
        let ends = || {
            self.rec
                .port
                .lock()
                .iter()
                .filter(|m| {
                    matches!(m, PortMessage::StatementEnd { query_id: q, .. } | PortMessage::StatementError { query_id: q, .. } if q == query_id)
                })
                .count()
        };
        let before = ends();
        let r = self.op(json!({ "op": "fetchMore", "queryId": query_id, "count": count })).await;
        assert_eq!(r["ok"], json!(true), "{r}");
        self.wait(|| ends() > before, 20_000).await;
    }
}

/// A new database file with the shop schema.
fn shop(dir: &tempfile::TempDir, n: &str) -> String {
    let path = dir.path().join(format!("shop-{n}.sqlite"));
    let db = Connection::open(&path).unwrap();
    db.execute_batch(
        "
    CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT UNIQUE, score REAL, photo BLOB);
    CREATE TABLE orders (id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES customers(id), total NUMERIC, note TEXT);
    CREATE TABLE notes (body TEXT, n);
    CREATE TABLE tags (a TEXT NOT NULL, b INTEGER NOT NULL, label TEXT, PRIMARY KEY (a, b)) WITHOUT ROWID;
    CREATE INDEX orders_by_customer ON orders(customer_id);
    CREATE VIEW big_orders AS SELECT * FROM orders WHERE total > 100;
    INSERT INTO customers (id, name, email, score, photo) VALUES (1, 'Ala', 'ala@example.com', 1.5, x'00ff'), (2, 'Ola', NULL, NULL, NULL), (3, 'Ela', 'ela@example.com', 0.1, NULL);
    INSERT INTO notes (body, n) VALUES ('first', 1), ('second', '2'), (NULL, 3.5);
    INSERT INTO tags VALUES ('x', 1, 'one'), ('x', 2, 'two');
  ",
    )
    .unwrap();
    db.execute_batch("BEGIN").unwrap();
    {
        let mut ins = db.prepare("INSERT INTO orders (customer_id, total, note) VALUES (?, ?, ?)").unwrap();
        for i in 1..=250i64 {
            ins.execute(rusqlite::params![if i % 2 == 1 { 1 } else { 3 }, i as f64, format!("order {i}")]).unwrap();
        }
    }
    db.execute_batch("COMMIT").unwrap();
    db.execute_batch("CREATE TRIGGER orders_touch AFTER INSERT ON orders BEGIN UPDATE customers SET score = coalesce(score, 0) + 1 WHERE id = NEW.customer_id; END;").unwrap();
    drop(db);
    path.to_string_lossy().into_owned()
}

fn ro(path: &str) -> Connection {
    Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap()
}

fn one(c: &Connection, sql: &str) -> String {
    c.query_row(sql, [], |r| r.get::<_, rusqlite::types::Value>(0))
        .map(|v| match v {
            rusqlite::types::Value::Text(s) => s,
            rusqlite::types::Value::Integer(n) => n.to_string(),
            other => format!("{other:?}"),
        })
        .unwrap()
}

fn s(x: &str) -> Option<String> {
    Some(x.to_owned())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn opens_a_file_and_refuses_missing_folders_and_non_databases() {
    let dir = tempfile::tempdir().unwrap();
    let h = H::open(&shop(&dir, "a"), |_| {}).await.unwrap();
    let status = h.s.connected_status();
    assert_eq!(status["database"], json!("main"));
    assert!(status.get("tls").is_none());
    assert!(status["serverVersion"].as_str().unwrap().starts_with("SQLite 3."));
    let missing = dir.path().join("missing.sqlite").to_string_lossy().into_owned();
    assert_eq!(H::open(&missing, |_| {}).await.err().unwrap().error, "dbFileMissing");
    assert_eq!(H::open(&dir.path().to_string_lossy(), |_| {}).await.err().unwrap().error, "dbFileMissing");
    let junk = dir.path().join("junk.db");
    std::fs::write(&junk, "this is not a database, just some text that is long enough to be read as a header ".repeat(20))
        .unwrap();
    assert_eq!(H::open(&junk.to_string_lossy(), |_| {}).await.err().unwrap().error, "dbNotSqlite");
    // A missing file is never created by opening it.
    assert!(!std::path::Path::new(&missing).exists());
    assert_eq!(H::open("", |_| {}).await.err().unwrap().error, "unsupported");
    h.s.end();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_empty_file_is_a_new_empty_database() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty.sqlite");
    std::fs::write(&path, "").unwrap();
    let h = H::open(&path.to_string_lossy(), |_| {}).await.unwrap();
    assert_eq!(h.value(json!({ "op": "objects", "schema": "main" })).await, json!([]));
    let r = h.run("CREATE TABLE t (x); INSERT INTO t VALUES (1); SELECT * FROM t").await;
    assert!(r.end.unwrap().0);
    assert_eq!(r.statements[2].rows, vec![vec![s("1")]]);
    h.s.end();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn lists_tables_views_indexes_and_triggers() {
    let dir = tempfile::tempdir().unwrap();
    let h = H::open(&shop(&dir, "a"), |_| {}).await.unwrap();
    assert_eq!(h.value(json!({ "op": "databases" })).await[0]["name"], json!("main"));
    assert_eq!(h.value(json!({ "op": "schemas" })).await, json!([{ "name": "main", "owner": "", "system": false }]));
    let objects = h.value(json!({ "op": "objects", "schema": "main" })).await;
    let objects = objects.as_array().unwrap();
    let mut names: Vec<String> =
        objects.iter().map(|o| format!("{}:{}", o["kind"].as_str().unwrap(), o["name"].as_str().unwrap())).collect();
    names.sort();
    assert_eq!(
        names,
        [
            "index:orders_by_customer",
            "table:customers",
            "table:notes",
            "table:orders",
            "table:tags",
            "trigger:orders_touch",
            "view:big_orders"
        ]
    );
    let by = |n: &str| objects.iter().find(|o| o["name"] == json!(n)).unwrap().clone();
    assert_eq!(by("orders_by_customer")["detail"], json!("ON orders"));
    assert_eq!(by("orders_touch")["detail"], json!("ON orders \u{b7} AFTER INSERT"));
    assert_eq!(by("orders"), json!({ "schema": "main", "name": "orders", "kind": "table", "oid": 0, "rowEstimate": null }));
    assert!(!objects.iter().any(|o| o["name"].as_str().unwrap().starts_with("sqlite_")));
    h.s.end();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn reads_columns_keys_indexes_and_foreign_keys() {
    let dir = tempfile::tempdir().unwrap();
    let h = H::open(&shop(&dir, "a"), |_| {}).await.unwrap();
    let info = |name: &str| json!({ "op": "tableInfo", "schema": "main", "name": name });
    let customers = h.value(info("customers")).await;
    assert_eq!(customers["primaryKey"], json!(["id"]));
    assert_eq!(customers["editKey"], json!(["id"]));
    let cols: Vec<Value> = customers["columns"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| json!([c["name"], c["typeName"], c["kind"], c["nullable"]]))
        .collect();
    assert_eq!(
        cols,
        vec![
            json!(["id", "INTEGER", "bigint", false]),
            json!(["name", "TEXT", "text", false]),
            json!(["email", "TEXT", "text", true]),
            json!(["score", "REAL", "float", true]),
            json!(["photo", "BLOB", "bytea", true]),
        ]
    );
    assert_eq!(customers["columns"][0]["identity"], json!(true));
    assert!(
        customers["indexes"].as_array().unwrap().iter().any(|i| i["unique"] == json!(true) && i["columns"] == json!(["email"]))
    );
    assert!(customers.get("rowid").is_none() && customers.get("affinities").is_none());
    let orders = h.value(info("orders")).await;
    let fk = orders["constraints"].as_array().unwrap().iter().find(|c| c["type"] == json!("f")).unwrap().clone();
    assert_eq!(fk["definition"], json!("FOREIGN KEY (\"customer_id\") REFERENCES \"customers\" (\"id\")"));
    let idx = orders["indexes"].as_array().unwrap().iter().find(|i| i["name"] == json!("orders_by_customer")).unwrap().clone();
    assert_eq!(idx["definition"], json!("CREATE INDEX orders_by_customer ON orders(customer_id)"));
    let notes = h.value(info("notes")).await;
    assert_eq!(notes["primaryKey"], Value::Null);
    assert_eq!(notes["editKey"], json!(["rowid"]));
    assert_eq!(notes["columns"][0]["name"], json!("rowid"));
    assert_eq!(notes["columns"][0]["generated"], json!(true));
    assert_eq!(notes["columns"][0]["identity"], json!(true));
    let tags = h.value(info("tags")).await;
    assert_eq!(tags["editKey"], json!(["a", "b"]));
    let tag_cols: Vec<&Value> = tags["columns"].as_array().unwrap().iter().map(|c| &c["name"]).collect();
    assert_eq!(tag_cols, [&json!("a"), &json!("b"), &json!("label")]);
    let view = h.value(info("big_orders")).await;
    assert_eq!(view["kind"], json!("view"));
    assert_eq!(view["editKey"], Value::Null);
    assert_eq!(h.op(info("nope")).await, json!({ "ok": false, "error": "notFound" }));
    h.s.end();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn shows_the_ddl_of_tables_views_indexes_and_triggers() {
    let dir = tempfile::tempdir().unwrap();
    let h = H::open(&shop(&dir, "a"), |_| {}).await.unwrap();
    let ddl = |name: &str, kind: &str| json!({ "op": "ddl", "schema": "main", "name": name, "kind": kind });
    let table = h.value(ddl("orders", "table")).await;
    let table = table.as_str().unwrap();
    assert!(table.contains("CREATE TABLE orders"));
    assert!(table.contains("CREATE INDEX orders_by_customer"));
    assert!(table.contains("CREATE TRIGGER orders_touch"));
    assert!(h.value(ddl("big_orders", "view")).await.as_str().unwrap().starts_with("CREATE VIEW big_orders"));
    assert_eq!(
        h.value(ddl("orders_by_customer", "index")).await,
        json!("CREATE INDEX orders_by_customer ON orders(customer_id);\n")
    );
    assert!(
        h.value(ddl("orders_touch", "trigger"))
            .await
            .as_str()
            .unwrap()
            .starts_with("CREATE TRIGGER orders_touch AFTER INSERT ON orders BEGIN")
    );
    assert_eq!(h.op(ddl("nope", "table")).await["ok"], json!(false));
    h.s.end();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pages_sort_filter_and_say_whether_more_rows_follow() {
    let dir = tempfile::tempdir().unwrap();
    let h = H::open(&shop(&dir, "a"), |_| {}).await.unwrap();
    let first = h.page(json!({ "schema": "main", "table": "orders", "limit": 100 })).await;
    assert_eq!(first.statements[0].rows.len(), 100);
    let end = first.statements[0].end.clone().unwrap();
    assert_eq!((end.2, end.3), (100, true));
    assert_eq!(first.statements[0].rows[0], vec![s("1"), s("1"), s("1"), s("order 1")]);
    let last = h.page(json!({ "schema": "main", "table": "orders", "limit": 100, "offset": 200 })).await;
    assert_eq!(last.statements[0].rows.len(), 50);
    assert!(!last.statements[0].end.clone().unwrap().3);
    let sorted =
        h.page(json!({ "schema": "main", "table": "orders", "limit": 3, "sort": [{ "column": "total", "desc": true }] })).await;
    let totals: Vec<Option<String>> = sorted.statements[0].rows.iter().map(|r| r[2].clone()).collect();
    assert_eq!(totals, [s("250"), s("249"), s("248")]);
    let filtered = h.page(json!({ "schema": "main", "table": "orders", "limit": 100, "filter": "note LIKE '%5'" })).await;
    assert_eq!(filtered.statements[0].rows.len(), 25);
    let customers = h.page(json!({ "schema": "main", "table": "customers", "limit": 10 })).await;
    assert_eq!(customers.statements[0].rows[0], vec![s("1"), s("Ala"), s("ala@example.com"), s("1.5"), s("\\x00ff")]);
    assert_eq!(customers.statements[0].rows[1], vec![s("2"), s("Ola"), None, None, None]);
    // A table keyed by its rowid reads it first.
    let notes = h.page(json!({ "schema": "main", "table": "notes", "limit": 10 })).await;
    let names: Vec<&str> = notes.statements[0].columns.iter().map(|c| c.name.as_str()).collect();
    assert_eq!(names, ["rowid", "body", "n"]);
    assert_eq!(
        notes.statements[0].rows,
        vec![vec![s("1"), s("first"), s("1")], vec![s("2"), s("second"), s("2")], vec![s("3"), None, s("3.5")]]
    );
    let bad = h.page(json!({ "schema": "main", "table": "orders", "limit": 5, "filter": "nope = 1" })).await;
    assert_eq!(bad.statements[0].error.as_ref().unwrap().0, "server");
    // A filter cannot write (PRAGMA query_only holds during the page) and the guard is off again afterwards.
    let r = h.run("UPDATE orders SET note = 'still writable' WHERE id = 1").await;
    assert!(r.end.unwrap().0);
    h.s.end();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn applies_edits_in_one_transaction_and_a_changed_row_is_a_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let path = shop(&dir, "a");
    let h = H::open(&path, |_| {}).await.unwrap();
    let preview = h
        .value(json!({ "op": "previewEdits", "req": { "schema": "main", "table": "customers", "edits": [
            { "op": "update", "key": { "id": "1" }, "set": { "name": "Alicja" }, "original": { "name": "Ala", "score": "1.5" } },
        ] } }))
        .await;
    assert_eq!(
        preview["sql"],
        json!(
            "BEGIN;\nUPDATE \"main\".\"customers\" SET \"name\" = 'Alicja' WHERE \"id\" = 1 AND (\"name\" IS 'Ala') AND (\"score\" IS 1.5);\nCOMMIT;"
        )
    );
    let saved = h
        .value(json!({ "op": "applyEdits", "req": { "schema": "main", "table": "customers", "edits": [
            { "op": "update", "key": { "id": "1" }, "set": { "name": "Alicja", "photo": "\\x0102" }, "original": { "name": "Ala", "score": "1.5", "photo": "\\x00ff" } },
            { "op": "insert", "values": { "name": "Iza", "score": "2.25" } },
            { "op": "delete", "key": { "id": "2" }, "original": { "email": null } },
        ] } }))
        .await;
    assert_eq!(saved, json!({ "affected": 3 }));
    let check = ro(&path);
    let all: Vec<(i64, String, String, f64)> = check
        .prepare("SELECT id, name, hex(photo) AS photo, score FROM customers ORDER BY id")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(
        all,
        vec![
            (1, "Alicja".into(), "0102".into(), 1.5),
            (3, "Ela".into(), String::new(), 0.1),
            (4, "Iza".into(), String::new(), 2.25)
        ]
    );
    // Someone else changed Ela: the stale original is a conflict, the other edit of the same save is rolled back.
    let other = Connection::open(&path).unwrap();
    other.execute_batch("UPDATE customers SET name = 'Elżbieta' WHERE id = 3").unwrap();
    let conflict = h
        .op(json!({ "op": "applyEdits", "req": { "schema": "main", "table": "customers", "edits": [
            { "op": "update", "key": { "id": "1" }, "set": { "name": "Ala" } },
            { "op": "update", "key": { "id": "3" }, "set": { "score": "9" }, "original": { "name": "Ela" } },
        ] } }))
        .await;
    assert_eq!(conflict, json!({ "ok": false, "error": "conflict", "index": 1 }));
    assert_eq!(one(&other, "SELECT name FROM customers WHERE id = 1"), "Alicja");
    h.s.end();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn edits_rowid_and_without_rowid_tables_and_reads_whole_cells() {
    let dir = tempfile::tempdir().unwrap();
    let path = shop(&dir, "a");
    let h = H::open(&path, |_| {}).await.unwrap();
    let edit =
        |table: &str, edits: Value| json!({ "op": "applyEdits", "req": { "schema": "main", "table": table, "edits": edits } });
    // "2" was stored as text, 3.5 as a real, 1 as an integer: each loaded text form still matches.
    let r = h
        .value(edit(
            "notes",
            json!([
                { "op": "update", "key": { "rowid": "1" }, "set": { "body": "one" }, "original": { "n": "1" } },
                { "op": "update", "key": { "rowid": "2" }, "set": { "body": "two" }, "original": { "n": "2" } },
                { "op": "delete", "key": { "rowid": "3" }, "original": { "n": "3.5", "body": null } },
            ]),
        ))
        .await;
    assert_eq!(r, json!({ "affected": 3 }));
    let bad = h.op(edit("notes", json!([{ "op": "update", "key": { "rowid": "1" }, "set": { "rowid": "9" } }]))).await;
    assert_eq!(bad["ok"], json!(false));
    let t = h.value(edit("tags", json!([{ "op": "update", "key": { "a": "x", "b": "2" }, "set": { "label": "dwa" } }]))).await;
    assert_eq!(t, json!({ "affected": 1 }));
    let check = ro(&path);
    let notes: Vec<(i64, String)> = check
        .prepare("SELECT rowid, body FROM notes ORDER BY rowid")
        .unwrap()
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(notes, vec![(1, "one".into()), (2, "two".into())]);
    assert_eq!(one(&check, "SELECT label FROM tags WHERE b = 2"), "dwa");
    let cell = |table: &str, key: Value, column: &str| json!({ "op": "cellValue", "req": { "schema": "main", "table": table, "key": key, "column": column } });
    assert_eq!(h.value(cell("customers", json!({ "id": "1" }), "photo")).await, json!("\\x00ff"));
    assert_eq!(h.value(cell("notes", json!({ "rowid": "2" }), "body")).await, json!("two"));
    // A view has no key: it is never edited.
    assert_eq!(
        h.op(edit("big_orders", json!([{ "op": "delete", "key": { "id": "1" } }]))).await,
        json!({ "ok": false, "error": "noKey" })
    );
    h.s.end();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn runs_a_script_statement_by_statement_and_loads_more_of_the_last_read() {
    let dir = tempfile::tempdir().unwrap();
    let h = H::open(&shop(&dir, "a"), |_| {}).await.unwrap();
    let (qid, r) = h
        .run_with(
            json!({ "sql": "UPDATE orders SET note = 'x' WHERE id <= 10;\nCREATE TRIGGER t2 BEFORE DELETE ON customers BEGIN SELECT CASE WHEN OLD.id = 1 THEN RAISE(ABORT, 'keep Ala') END; END;\nSELECT id, total FROM orders ORDER BY id", "rowCap": 100 }),
            true,
        )
        .await;
    assert!(r.end.unwrap().0);
    let e0 = r.statements[0].end.clone().unwrap();
    assert_eq!((e0.0.as_str(), e0.1), ("UPDATE", Some(10)));
    assert_eq!(r.statements[1].end.clone().unwrap().0, "CREATE");
    assert_eq!(r.statements[2].rows.len(), 100);
    let e2 = r.statements[2].end.clone().unwrap();
    assert_eq!((e2.1, e2.3), (None, true));
    let kinds: Vec<(&str, &str)> = r.statements[2].columns.iter().map(|c| (c.name.as_str(), c.kind)).collect();
    assert_eq!(kinds, [("id", "bigint"), ("total", "numeric")]);
    assert!(h.s.busy(), "an open result holds the connection");
    h.more(&qid, 200).await;
    let all = &h.collect(&qid).statements[2];
    assert_eq!(all.rows.len(), 250);
    let end = all.end.clone().unwrap();
    assert_eq!((end.1, end.2, end.3), (Some(250), 250, false));
    // The trigger works: deleting Ala is refused by it.
    let refused = h.run("DELETE FROM customers WHERE id = 1").await;
    let err = refused.statements[0].error.clone().unwrap();
    assert_eq!((err.0, err.1.as_deref()), ("server", Some("keep Ala")));
    h.s.end();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_syntax_error_names_its_position_and_an_earlier_long_read_is_cut() {
    let dir = tempfile::tempdir().unwrap();
    let h = H::open(&shop(&dir, "a"), |_| {}).await.unwrap();
    let r = h.run("SELECT *\nFRM orders").await;
    let err = r.statements[0].error.clone().unwrap();
    assert_eq!(err.0, "server");
    assert!(err.1.unwrap().contains("near \"FRM\": syntax error"));
    assert_eq!(err.2, Some(10));
    let (_, two) = h.run_with(json!({ "sql": "SELECT * FROM orders; SELECT 1", "rowCap": 10 }), true).await;
    let e = two.statements[0].end.clone().unwrap();
    assert_eq!((e.2, e.3, e.4), (10, false, true));
    assert_eq!(two.statements[1].rows, rows(&[["1"]]));
    h.s.end();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn keeps_an_explicit_transaction_across_runs() {
    let dir = tempfile::tempdir().unwrap();
    let path = shop(&dir, "a");
    let h = H::open(&path, |_| {}).await.unwrap();
    assert_eq!(h.value(json!({ "op": "transaction", "action": "begin" })).await, json!("transaction"));
    let r = h.run("UPDATE customers SET name = 'tx' WHERE id = 1").await;
    assert_eq!(r.end.unwrap().2, "transaction");
    assert!(h.rec.tx.lock().contains(&"transaction"));
    assert_eq!(h.value(json!({ "op": "transaction", "action": "rollback" })).await, json!("idle"));
    let check = ro(&path);
    assert_eq!(one(&check, "SELECT name FROM customers WHERE id = 1"), "Ala");
    let commit = h.run("BEGIN; UPDATE customers SET name = 'c' WHERE id = 1; COMMIT").await;
    assert_eq!(commit.end.unwrap(), (true, false, "idle"));
    assert_eq!(one(&check, "SELECT name FROM customers WHERE id = 1"), "c");
    h.s.end();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_only_connections_refuse_writes_and_allow_one_run_with_writes() {
    let dir = tempfile::tempdir().unwrap();
    let path = shop(&dir, "a");
    let h = H::open(&path, |o| o.read_only = true).await.unwrap();
    let refused = h.run("SELECT 1; DELETE FROM orders").await;
    assert_eq!(refused.statements[1].error.as_ref().unwrap().0, "readOnly");
    assert!(refused.statements[0].rows.is_empty());
    assert_eq!(h.run("PRAGMA query_only = 0").await.statements[0].error.as_ref().unwrap().0, "readOnly");
    assert_eq!(h.run("PRAGMA journal_mode = WAL").await.statements[0].error.as_ref().unwrap().0, "readOnly");
    let reads = h.run("PRAGMA table_info('orders'); SELECT count(*) FROM orders; PRAGMA journal_mode").await;
    assert!(reads.end.unwrap().0);
    assert_eq!(reads.statements[1].rows, rows(&[["250"]]));
    // A write that slips past the client side is refused by SQLite itself (PRAGMA query_only).
    let sneaky = h.run("WITH x AS (SELECT 1) INSERT INTO notes (body) SELECT 'x' FROM x").await;
    let e = sneaky.statements[0].error.clone().unwrap().0;
    assert!(e == "readOnly" || e == "server", "{e}");
    assert_eq!(
        h.op(json!({ "op": "applyEdits", "req": { "schema": "main", "table": "customers", "edits": [{ "op": "delete", "key": { "id": "1" } }] } }))
            .await,
        json!({ "ok": false, "error": "readOnly" })
    );
    let (_, once) = h.run_with(json!({ "sql": "DELETE FROM orders WHERE id = 1", "readWrite": true }), true).await;
    assert!(once.end.unwrap().0);
    assert_eq!(h.run("DELETE FROM orders WHERE id = 2").await.statements[0].error.as_ref().unwrap().0, "readOnly");
    let check = ro(&path);
    assert_eq!(one(&check, "SELECT count(*) AS n FROM orders"), "249");
    h.s.end();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancels_a_long_row_loop_at_once_and_the_session_goes_on() {
    let dir = tempfile::tempdir().unwrap();
    let h = H::open(&shop(&dir, "a"), |_| {}).await.unwrap();
    let (qid, _) = h
        .run_with(
            json!({ "sql": "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT x FROM c WHERE x % 50000000 = 0", "rowCap": 5 }),
            false,
        )
        .await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(h.value(json!({ "op": "cancel" })).await, json!(true));
    h.wait(|| h.ended(&qid), 10_000).await;
    let end = h.collect(&qid).end.unwrap();
    assert_eq!((end.0, end.1), (false, true));
    assert_eq!(h.run("SELECT 42").await.statements[0].rows, rows(&[["42"]]));
    assert!(h.rec.notices.lock().is_empty(), "sqlite3_interrupt stopped it: no reopen");
    h.s.end();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_statement_stuck_in_one_step_ends_with_its_thread_and_the_file_opens_again() {
    let dir = tempfile::tempdir().unwrap();
    let path = shop(&dir, "a");
    let h = H::open(&path, |o| {
        o.kill_grace_ms = 200;
        // a step that never looks at sqlite3_interrupt
        o.setup = Some(Arc::new(|c: &Connection| {
            c.create_scalar_function("unimux_sleep", 1, FunctionFlags::SQLITE_UTF8, |ctx| {
                let ms: i64 = ctx.get(0)?;
                std::thread::sleep(Duration::from_millis(ms as u64));
                Ok(1i64)
            })
            .unwrap();
        }));
    })
    .await
    .unwrap();
    h.run("BEGIN; UPDATE customers SET name = 'tx' WHERE id = 1").await;
    assert_eq!(h.s.tx(), "transaction");
    let (qid, _) = h.run_with(json!({ "sql": "SELECT unimux_sleep(3000)" }), false).await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(h.value(json!({ "op": "cancel" })).await, json!(true));
    h.wait(|| h.ended(&qid), 10_000).await;
    let end = h.collect(&qid).end.unwrap();
    assert_eq!((end.1, end.2), (true, "idle"));
    assert_eq!(h.rec.notices.lock().len(), 1);
    let after = h.run("SELECT name FROM customers WHERE id = 1").await;
    assert_eq!(after.statements[0].rows, rows(&[["Ala"]]));
    assert!(h.rec.fatal.lock().is_empty());
    h.s.end();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn another_program_holding_the_write_lock_makes_writes_report_a_locked_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = shop(&dir, "a");
    let h = H::open(&path, |o| o.busy_ms = 300).await.unwrap();
    let other = Connection::open(&path).unwrap();
    other.execute_batch("BEGIN IMMEDIATE; UPDATE customers SET name = 'locked' WHERE id = 1").unwrap();
    let write = h.run("UPDATE customers SET name = 'me' WHERE id = 2").await;
    assert_eq!(write.statements[0].error.as_ref().unwrap().0, "dbLocked");
    let save = h
        .op(json!({ "op": "applyEdits", "req": { "schema": "main", "table": "customers", "edits": [{ "op": "update", "key": { "id": "2" }, "set": { "name": "me" } }] } }))
        .await;
    assert_eq!(save["error"], json!("dbLocked"));
    // Rollback journal: reading still works while the other program only holds RESERVED.
    assert_eq!(h.run("SELECT name FROM customers WHERE id = 1").await.statements[0].rows, rows(&[["Ala"]]));
    other.execute_batch("ROLLBACK").unwrap();
    other.execute_batch("PRAGMA journal_mode = WAL").unwrap();
    other.execute_batch("BEGIN IMMEDIATE; UPDATE customers SET name = 'wal' WHERE id = 1").unwrap();
    assert_eq!(h.run("SELECT name FROM customers WHERE id = 1").await.statements[0].rows, rows(&[["Ala"]]));
    other.execute_batch("COMMIT").unwrap();
    assert_eq!(h.run("SELECT name FROM customers WHERE id = 1").await.statements[0].rows, rows(&[["wal"]]));
    h.s.end();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_open_result_is_closed_and_meta_operations_close_it_first() {
    let dir = tempfile::tempdir().unwrap();
    let h = H::open(&shop(&dir, "a"), |o| o.cursor_idle_ms = 200).await.unwrap();
    let (qid, r) = h.run_with(json!({ "sql": "SELECT * FROM orders", "rowCap": 10 }), true).await;
    assert!(r.statements[0].end.clone().unwrap().3);
    h.wait(
        || h.rec.port.lock().iter().any(|m| matches!(m, PortMessage::ResultClosed { query_id, .. } if *query_id == qid)),
        5000,
    )
    .await;
    assert_eq!(
        h.op(json!({ "op": "fetchMore", "queryId": qid, "count": 10 })).await,
        json!({ "ok": false, "error": "notFound" })
    );
    let (qid, _) = h.run_with(json!({ "sql": "SELECT * FROM orders", "rowCap": 10 }), true).await;
    h.value(json!({ "op": "schemas" })).await;
    assert!(h.rec.port.lock().iter().any(|m| matches!(m, PortMessage::ResultClosed { query_id, .. } if *query_id == qid)));
    assert!(!h.s.busy());
    assert_eq!(h.op(json!({ "op": "redis", "req": {} })).await, json!({ "ok": false, "error": "invalid" }));
    h.s.end();
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(h.op(json!({ "op": "schemas" })).await, json!({ "ok": false, "error": "noSession" }));
}
