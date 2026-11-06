//! SP9: the Rust spike clients against the 1.1.4 goldens in test/golden/db-wire/ (written from node-postgres, mysql2 and
//! ioredis through the real 1.1.4 DB host by test/db-wire-sp9.int.test.ts). The offline golden always runs; the server
//! tests are `#[ignore]`d in a plain `cargo test` and run with `--include-ignored` by scripts/spike-db-wire.mjs, which
//! starts the servers in Docker, sets MC_SP9_SERVERS and passes name filters for the kinds it started. A server test that
//! runs without a server of its kind fails instead of passing empty. Measurements are printed (`--nocapture`).

use std::path::PathBuf;
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tokio::net::{TcpListener, TcpStream};
use unimux_core::js_json::write_string;
use unimux_db::wire::mysql::{MyColumn, MyConfig, MyConn, MyResult};
use unimux_db::wire::pg::{PgConfig, PgConn, PgStatement, PgWireError, Protocol, parse_tag, send_cancel};
use unimux_db::wire::redis::{
    CallError, REPLY_NODES, Raw, ReconnectEvent, RedisConn, connect_sequence, reconnect, reconnect_sequence, reply,
};
use unimux_db::wire::tap::tap;
use unimux_db::wire::value::{DbValue, head_json, node_utf8, row_json, server_text, text_value, to_value, utf16_len};

#[derive(Debug, Clone, Deserialize)]
struct Server {
    label: String,
    kind: String,
    host: String,
    port: u16,
    user: String,
    password: String,
}

/// The servers of these kinds; panics when there is none, so a server test never passes without having checked anything.
fn servers(kind: &[&str]) -> Vec<Server> {
    let text = std::env::var("MC_SP9_SERVERS")
        .expect("MC_SP9_SERVERS is not set: the server checks run through node scripts/spike-db-wire.mjs");
    let all: Vec<Server> = serde_json::from_str(&text).expect("MC_SP9_SERVERS is JSON");
    let found: Vec<Server> = all.into_iter().filter(|s| kind.contains(&s.kind.as_str())).collect();
    assert!(!found.is_empty(), "MC_SP9_SERVERS has no {kind:?} server");
    found
}

fn dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/golden/db-wire")
}

fn read(name: &str) -> String {
    std::fs::read_to_string(dir().join(name)).unwrap_or_else(|e| panic!("{name}: {e}"))
}

// ── a small JSON builder that writes what JSON.stringify writes (raw parts for DbValue rows) ──

enum J {
    Null,
    Bool(bool),
    Num(String),
    Str(String),
    Raw(String),
    Arr(Vec<J>),
    Obj(Vec<(&'static str, J)>),
}

impl J {
    fn n(v: impl ToString) -> J {
        J::Num(v.to_string())
    }
    fn s(v: impl Into<String>) -> J {
        J::Str(v.into())
    }
    fn opt_n(v: Option<u64>) -> J {
        v.map(J::n).unwrap_or(J::Null)
    }
    fn write(&self, out: &mut String) {
        match self {
            J::Null => out.push_str("null"),
            J::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            J::Num(n) => out.push_str(n),
            J::Str(s) => write_string(out, s),
            J::Raw(r) => out.push_str(r),
            J::Arr(items) => {
                out.push('[');
                for (i, x) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    x.write(out);
                }
                out.push(']');
            }
            J::Obj(fields) => {
                out.push('{');
                for (i, (k, v)) in fields.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write_string(out, k);
                    out.push(':');
                    v.write(out);
                }
                out.push('}');
            }
        }
    }
    fn text(&self) -> String {
        let mut s = String::new();
        self.write(&mut s);
        s
    }
}

fn rows_j(rows: &[Vec<DbValue>]) -> J {
    J::Arr(rows.iter().map(|r| J::Raw(row_json(r))).collect())
}

/// Compares produced lines with a golden file (a line stored as {sha256, chars} is compared by hash); returns the mismatches.
fn compare(file: &str, produced: &[String]) -> Vec<String> {
    let text = read(file);
    let golden: Vec<&str> = text.lines().collect();
    let mut bad = Vec::new();
    if golden.len() != produced.len() {
        bad.push(format!("{file}: {} golden lines, {} produced", golden.len(), produced.len()));
    }
    for (i, (g, p)) in golden.iter().zip(produced).enumerate() {
        // serde_json refuses the lone surrogate escapes JSON.stringify writes (`\ud83d`); such a line is compared as text
        let gv: Value = serde_json::from_str(g).unwrap_or(Value::Null);
        let ok = match gv.get("sha256").and_then(Value::as_str) {
            Some(h) => {
                let mine: String = Sha256::digest(p.as_bytes()).iter().map(|b| format!("{b:02x}")).collect();
                mine == h && gv.get("chars").and_then(Value::as_u64) == Some(utf16_len(p) as u64)
            }
            None => g == p,
        };
        if !ok {
            let at = g.bytes().zip(p.bytes()).position(|(a, b)| a != b).unwrap_or(g.len().min(p.len()));
            let lo = at.saturating_sub(120);
            let cut = |s: &str| s.get(lo..(at + 200).min(s.len())).unwrap_or("<non-char boundary>").to_owned();
            bad.push(format!("{file} line {}: golden ...{}...\n   rust   ...{}...", i + 1, cut(g), cut(p)));
        }
    }
    bad
}

fn assert_clean(bad: Vec<String>) {
    if !bad.is_empty() {
        panic!("{} mismatches:\n{}", bad.len(), bad.join("\n"));
    }
}

fn unhex(h: &str) -> Vec<u8> {
    (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).unwrap()).collect()
}

// ── offline ──

#[test]
fn node_utf8_decoding_and_to_value_golden() {
    let inputs = [
        "ff",
        "c0af",
        "eda080",
        "f4908080",
        "e282",
        "6f6be2826f6b",
        "f09f9880",
        "f09f98",
        "e2",
        "fe",
        "c3",
        "e0a0",
        "f0908080",
        "f8888080",
        "80bf",
        "c328",
        "edbfbf",
        "efbfbd",
        "00",
        "",
    ];
    let mut lines: Vec<String> = inputs
        .iter()
        .map(|h| {
            let b = unhex(h);
            J::Obj(vec![("hex", J::s(*h)), ("text", J::s(node_utf8(&b))), ("isUtf8", J::Bool(std::str::from_utf8(&b).is_ok()))])
                .text()
        })
        .collect();
    let values = [
        "x".repeat(65536),
        "x".repeat(65537),
        format!("a{}", "😀".repeat(40000)),
        "😀".repeat(32768),
        "😀".repeat(32769),
        "ą".repeat(70000),
        String::new(),
    ];
    for v in values {
        let len = utf16_len(&v);
        let json = text_value(v, unimux_db::wire::value::CELL_CHARS).to_json();
        lines.push(J::Obj(vec![("value", J::Obj(vec![("len", J::n(len)), ("json", J::s(json))]))]).text());
    }
    assert_clean(compare("utf8-decode.jsonl", &lines));
}

// ── Postgres ──

async fn pg(
    s: &Server,
    database: &str,
    user: &str,
    password: &str,
    protocol: Protocol,
) -> Result<PgConn<TcpStream>, PgWireError> {
    let stream = TcpStream::connect((s.host.as_str(), s.port)).await?;
    stream.set_nodelay(true)?;
    PgConn::connect(stream, &PgConfig { user: user.into(), database: database.into(), password: Some(password.into()), protocol })
        .await
}

struct Relnames {
    conns: std::collections::HashMap<String, PgConn<TcpStream>>,
    names: std::collections::HashMap<(String, u32), String>,
}

impl Relnames {
    async fn get(&mut self, s: &Server, database: &str, oid: u32) -> String {
        if let Some(n) = self.names.get(&(database.to_owned(), oid)) {
            return n.clone();
        }
        if !self.conns.contains_key(database) {
            let c = pg(s, database, &s.user, &s.password, Protocol::V3_0).await.unwrap();
            self.conns.insert(database.to_owned(), c);
        }
        let c = self.conns.get_mut(database).unwrap();
        let r = c.simple_query(&format!("SELECT relname FROM pg_class WHERE oid = {oid}")).await.unwrap();
        let name = r[0].rows.first().and_then(|row| row[0].as_deref()).map(node_utf8).unwrap_or_else(|| oid.to_string());
        self.names.insert((database.to_owned(), oid), name.clone());
        name
    }
}

fn values(rows: &[Vec<Option<Vec<u8>>>], cap: usize) -> Vec<Vec<DbValue>> {
    rows.iter().take(cap).map(|r| r.iter().map(|v| to_value(v.as_deref(), false)).collect()).collect()
}

async fn host_j(st: &PgStatement, s: &Server, db: &str, rel: &mut Relnames) -> J {
    let mut columns = Vec::new();
    if st.error.is_none() {
        for f in st.fields.iter().flatten() {
            let mut o = vec![("name", J::s(&f.name)), ("typeOid", J::n(f.type_oid))];
            if f.table_oid != 0 {
                o.push(("table", J::s(rel.get(s, db, f.table_oid).await)));
                if f.column_id != 0 {
                    o.push(("columnNumber", J::n(f.column_id)));
                }
            }
            columns.push(J::Obj(o));
        }
    }
    let mut o = vec![("columns", J::Arr(columns)), ("rows", rows_j(&values(&st.rows, 1000)))];
    if let Some(e) = &st.error {
        let mut server = vec![("code", J::s(e.code())), ("message", J::Raw(head_json(&server_text(e.message()))))];
        if let Some(p) = e.field(b'P').and_then(|p| p.parse::<u64>().ok()).filter(|p| *p > 0) {
            server.push(("position", J::n(p)));
        }
        if let Some(d) = e.field(b'D').filter(|d| !d.is_empty()) {
            server.push(("detail", J::Raw(head_json(&server_text(d)))));
        }
        // pgSession's code of a server error (no cancel was requested here)
        let code = match e.code() {
            "57014" if e.message().to_lowercase().contains("statement timeout") => "statementTimeout",
            "57014" => "cancelled",
            "25006" => "readOnly",
            _ => "server",
        };
        o.push(("error", J::Obj(vec![("code", J::s(code)), ("server", J::Obj(server))])));
    }
    J::Obj(o)
}

async fn simple_j(st: &PgStatement, s: &Server, db: &str, rel: &mut Relnames) -> J {
    if let Some(e) = &st.error {
        return J::Obj(vec![("error", J::Obj(vec![("code", J::s(e.code())), ("message", J::s(e.message()))]))]);
    }
    let mut fields = Vec::new();
    for f in st.fields.iter().flatten() {
        let table = if f.table_oid != 0 { J::s(rel.get(s, db, f.table_oid).await) } else { J::n(0) };
        fields.push(J::Obj(vec![
            ("name", J::s(&f.name)),
            ("table", table),
            ("columnID", J::n(f.column_id)),
            ("dataTypeID", J::n(f.type_oid)),
            ("dataTypeSize", J::n(f.type_size)),
            ("dataTypeModifier", J::n(f.type_modifier)),
            ("format", J::s(if f.format == 0 { "text" } else { "binary" })),
        ]));
    }
    let (command, count) = st.tag.as_deref().map(parse_tag).unwrap_or((None, None));
    J::Obj(vec![
        ("fields", J::Arr(fields)),
        ("rows", rows_j(&values(&st.rows, usize::MAX))),
        ("command", command.map(J::Str).unwrap_or(J::Null)),
        ("rowCount", J::opt_n(count)),
    ])
}

/// `returnsRows` (src/shared/dbSql.ts) for the corpus statements (no comments or quoted RETURNING there).
fn returns_rows(sql: &str) -> bool {
    const ROW_KEYWORDS: [&str; 9] = ["SELECT", "WITH", "VALUES", "TABLE", "SHOW", "EXPLAIN", "FETCH", "EXECUTE", "CALL"];
    ROW_KEYWORDS.contains(&first_keyword(sql).as_str())
        || sql.split(|c: char| !c.is_ascii_alphanumeric() && c != '_').any(|w| w.eq_ignore_ascii_case("RETURNING"))
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs MC_SP9_SERVERS (node scripts/spike-db-wire.mjs)"]
async fn pg_values_match_node_postgres() {
    let corpus: Value = serde_json::from_str(&read("pg-corpus.json")).unwrap();
    for s in servers(&["postgres"]) {
        let mut rel = Relnames { conns: Default::default(), names: Default::default() };
        let mut hosts: std::collections::HashMap<String, PgConn<TcpStream>> = Default::default();
        let mut lines = Vec::new();
        let t0 = Instant::now();
        for q in corpus["queries"].as_array().unwrap() {
            let id = q["id"].as_str().unwrap();
            let sql = q["sql"].as_str().unwrap();
            let db = if q.get("db").and_then(Value::as_str) == Some("ascii") { "sp9_ascii" } else { "postgres" };
            if !hosts.contains_key(db) {
                hosts.insert(db.to_owned(), pg(&s, db, &s.user, &s.password, Protocol::V3_0).await.unwrap());
            }
            // pgSession.statement: a row-returning statement through a cursor, any other as a simple query
            let conn = hosts.get_mut(db).unwrap();
            let host = if returns_rows(sql) {
                conn.cursor_query(sql, 100).await.unwrap()
            } else {
                conn.simple_query(sql).await.unwrap().pop().unwrap()
            };
            let host = host_j(&host, &s, db, &mut rel).await;
            let mut fresh = pg(&s, db, &s.user, &s.password, Protocol::V3_0).await.unwrap();
            fresh.notices.clear();
            let st = fresh.simple_query(sql).await.unwrap().remove(0);
            let simple = simple_j(&st, &s, db, &mut rel).await;
            let notices: Vec<J> =
                fresh.notices.iter().map(|n| J::s(format!("{}: {}", n.field(b'S').unwrap_or(""), n.message()))).collect();
            lines.push(J::Obj(vec![("id", J::s(id)), ("host", host), ("simple", simple), ("notices", J::Arr(notices))]).text());
        }
        println!("{}: {} statements twice (cursor + simple) in {} ms", s.label, lines.len(), t0.elapsed().as_millis());
        assert_clean(compare(&format!("{}.jsonl", s.label), &lines));
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs MC_SP9_SERVERS (node scripts/spike-db-wire.mjs)"]
async fn pg_startup_and_logins_match_node_postgres() {
    for s in servers(&["postgres"]) {
        let cfg = PgConfig { user: "sp9_none".into(), database: "postgres".into(), password: None, protocol: Protocol::V3_0 };
        let b = unimux_db::wire::pg::startup_bytes(&cfg).unwrap();
        let line = J::Obj(vec![("startup", J::s(base64::engine::general_purpose::STANDARD.encode(&b)))]).text();
        assert_clean(compare(&format!("{}-startup.jsonl", s.label), &[line]));

        let mut lines = Vec::new();
        for (label, user, pw) in [
            ("sp9_md5", "sp9_md5", "md5-pw"),
            ("sp9_nfkc", "sp9_nfkc", "Ⅸ ﬁ x"),
            ("sp9_nfkc_composed", "sp9_nfkc", "IX fi x"),
            ("wrong", s.user.as_str(), "wrong"),
        ] {
            let r = pg(&s, "postgres", user, pw, Protocol::V3_0).await;
            lines.push(match r {
                Ok(_) => J::Obj(vec![("user", J::s(label)), ("ok", J::Bool(true))]).text(),
                Err(PgWireError::Server(e)) => J::Obj(vec![
                    ("user", J::s(label)),
                    ("ok", J::Bool(false)),
                    ("code", J::s(e.code())),
                    ("message", J::s(e.message())),
                ])
                .text(),
                Err(e) => panic!("{label}: {e}"),
            });
        }
        assert_clean(compare(&format!("{}-logins.jsonl", s.label), &lines));
    }
}

/// Cancels a pg_sleep with a CancelRequest for each protocol; PostgreSQL 18 under 3.2 sends a 32-byte key.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs MC_SP9_SERVERS (node scripts/spike-db-wire.mjs)"]
async fn pg_cancel_with_3_0_and_3_2_keys() {
    for s in servers(&["postgres"]) {
        for protocol in [Protocol::V3_0, Protocol::V3_2] {
            let mut c = pg(&s, "postgres", &s.user, &s.password, protocol).await.unwrap();
            let key = c.key.clone().expect("BackendKeyData");
            let negotiated = c.negotiated.clone();
            let version = c.param("server_version").unwrap_or("").to_owned();
            // values do not depend on the protocol version
            let rows = c
                .simple_query("SELECT '2024-02-29 12:34:56.789+02'::timestamptz, interval '1 day', 1.50::numeric, ARRAY[1,NULL]")
                .await
                .unwrap();
            let task = tokio::spawn(async move {
                let t = Instant::now();
                let r = c.simple_query("SELECT pg_sleep(20)").await.unwrap();
                (r, t.elapsed())
            });
            tokio::time::sleep(Duration::from_millis(300)).await;
            let sent = Instant::now();
            send_cancel(TcpStream::connect((s.host.as_str(), s.port)).await.unwrap(), &key).await.unwrap();
            let (r, _) = tokio::time::timeout(Duration::from_secs(10), task).await.expect("cancelled in time").unwrap();
            let cancel_ms = sent.elapsed().as_millis();
            let code = r[0].error.as_ref().map(|e| e.code().to_owned()).unwrap_or_default();
            println!(
                "{} ({version}) {protocol:?}: key {} bytes, negotiate {negotiated:?}, cancel -> {code} in {cancel_ms} ms, values {:?}",
                s.label,
                key.secret.len(),
                values(&rows[0].rows, 1)
            );
            assert_eq!(code, "57014");
            let v18 = version.starts_with("18");
            match protocol {
                Protocol::V3_0 => assert_eq!(key.secret.len(), 4),
                Protocol::V3_2 if v18 => assert_eq!(key.secret.len(), 32),
                Protocol::V3_2 => {
                    assert_eq!(key.secret.len(), 4);
                    assert_eq!(negotiated.map(|n| n.0), Some(0x0003_0000));
                }
            }
        }
        // the 1.1.4 first step: pg_cancel_backend on a side connection
        let mut c = pg(&s, "postgres", &s.user, &s.password, Protocol::V3_0).await.unwrap();
        let pid = c.key.as_ref().unwrap().process_id;
        let task = tokio::spawn(async move { c.simple_query("SELECT pg_sleep(20)").await.unwrap() });
        tokio::time::sleep(Duration::from_millis(300)).await;
        let mut side = pg(&s, "postgres", &s.user, &s.password, Protocol::V3_0).await.unwrap();
        let ok = side.simple_query(&format!("SELECT pg_cancel_backend({pid})")).await.unwrap();
        let r = tokio::time::timeout(Duration::from_secs(10), task).await.unwrap().unwrap();
        assert_eq!(values(&ok[0].rows, 1), vec![vec![DbValue::Text("t".into())]]);
        assert_eq!(r[0].error.as_ref().map(|e| e.code()), Some("57014"));
    }
}

// ── MySQL / MariaDB ──

async fn my(
    s: &Server,
    user: &str,
    password: &str,
    database: Option<&str>,
) -> Result<MyConn<TcpStream>, unimux_db::wire::mysql::MyWireError> {
    let stream = TcpStream::connect((s.host.as_str(), s.port)).await?;
    stream.set_nodelay(true)?;
    MyConn::connect(stream, &MyConfig { user: user.into(), password: password.into(), database: database.map(Into::into) }).await
}

/// `firstKeyword` (src/shared/dbSql.ts) for the corpus statements (no leading comments there).
fn first_keyword(sql: &str) -> String {
    sql.trim_start_matches(|c: char| c.is_whitespace() || c == '(')
        .chars()
        .take_while(char::is_ascii_alphabetic)
        .collect::<String>()
        .to_uppercase()
}

/// `mysqlFieldKind` (src/shared/dbMysql.ts), test-only port: the type name and kind of a result field.
fn field_kind(f: &MyColumn) -> (String, &'static str) {
    let unsigned = f.flags & 32 != 0;
    let u = |n: &str| if unsigned { format!("{n} unsigned") } else { n.to_owned() };
    let binary = f.binary();
    if f.extended_format.as_deref() == Some("json") {
        return ("json".into(), "json");
    }
    if f.extended_type_name.as_deref() == Some("uuid") {
        return ("uuid".into(), "uuid");
    }
    if let Some(n) = &f.extended_type_name {
        return (n.clone(), if binary { "bytea" } else { "text" });
    }
    match f.column_type {
        0x01 => (u("tinyint"), "int"),
        0x02 => (u("smallint"), "int"),
        0x09 => (u("mediumint"), "int"),
        0x03 => (u("int"), if unsigned { "bigint" } else { "int" }),
        0x08 => (u("bigint"), if unsigned { "numeric" } else { "bigint" }),
        0x0d => ("year".into(), "int"),
        0x04 => ("float".into(), "float"),
        0x05 => ("double".into(), "float"),
        0x00 | 0xf6 => ("decimal".into(), "numeric"),
        0x0a | 0x0e => ("date".into(), "date"),
        0x0b => ("time".into(), "time"),
        0x0c => ("datetime".into(), "timestamp"),
        0x07 => ("timestamp".into(), "timestamp"),
        0xf5 => ("json".into(), "json"),
        0x10 => ("bit".into(), "bytea"),
        0xff => ("geometry".into(), "other"),
        0xf2 => ("vector".into(), "other"),
        0x06 => ("null".into(), "text"),
        0xf7 => ("enum".into(), "enum"),
        0xf8 => ("set".into(), "enum"),
        0xf9..=0xfc => (if binary { "blob" } else { "text" }.into(), if binary { "bytea" } else { "text" }),
        0xfd | 0x0f | 0xfe => {
            if f.flags & 256 != 0 {
                ("enum".into(), "enum")
            } else if f.flags & 2048 != 0 {
                ("set".into(), "enum")
            } else if binary {
                (if f.column_type == 0xfe { "binary" } else { "varbinary" }.into(), "bytea")
            } else {
                (if f.column_type == 0xfe { "char" } else { "varchar" }.into(), "text")
            }
        }
        t => (t.to_string(), "other"),
    }
}

fn my_statements(sql: &str, results: &[MyResult]) -> Vec<J> {
    let kw = first_keyword(sql);
    let call = kw == "CALL";
    let has_sets = results.iter().any(|r| matches!(r, MyResult::Set { .. }));
    let mut out = Vec::new();
    for r in results {
        match r {
            MyResult::Error(e) => {
                let state = (e.state.len() == 5 && e.state.bytes().all(|b| b.is_ascii_digit() || b.is_ascii_uppercase()))
                    .then_some(e.state.as_str());
                let message = match state {
                    Some(st) => format!("ERROR {} ({st}): {}", e.code, e.message),
                    None => format!("ERROR {}: {}", e.code, e.message),
                };
                let mut server = Vec::new();
                if let Some(st) = state {
                    server.push(("code", J::s(st)));
                }
                server.push(("message", J::Raw(head_json(&server_text(&message)))));
                out.push(J::Obj(vec![
                    ("columns", J::Arr(vec![])),
                    ("rows", J::Arr(vec![])),
                    ("error", J::Obj(vec![("code", J::s("server")), ("server", J::Obj(server))])),
                ]));
            }
            // an Error without errno: mysqlSession.codeOf gives dbClosed and mysqlServerError nothing
            MyResult::ClientError(_) => out.push(J::Obj(vec![
                ("columns", J::Arr(vec![])),
                ("rows", J::Arr(vec![])),
                ("error", J::Obj(vec![("code", J::s("dbClosed"))])),
            ])),
            MyResult::Ok { affected_rows, .. } => {
                if call && has_sets {
                    continue;
                }
                out.push(J::Obj(vec![
                    ("columns", J::Arr(vec![])),
                    ("rows", J::Arr(vec![])),
                    (
                        "command",
                        J::s(if call {
                            "CALL".to_owned()
                        } else if kw.is_empty() {
                            "OK".into()
                        } else {
                            kw.clone()
                        }),
                    ),
                    ("rowCount", J::n(affected_rows)),
                ]));
            }
            MyResult::Set { columns, rows, .. } => {
                let cols = columns
                    .iter()
                    .map(|c| {
                        let (type_name, kind) = field_kind(c);
                        J::Obj(vec![("name", J::s(&c.name)), ("typeName", J::s(type_name)), ("kind", J::s(kind))])
                    })
                    .collect();
                let vals = r.values();
                let sent = vals.len().min(1000);
                let keep = !call && vals.len() > 1000;
                out.push(J::Obj(vec![
                    ("columns", J::Arr(cols)),
                    ("rows", rows_j(&vals[..sent])),
                    (
                        "command",
                        J::s(if call {
                            "CALL".to_owned()
                        } else if kw.is_empty() {
                            "SELECT".into()
                        } else {
                            kw.clone()
                        }),
                    ),
                    ("rowCount", if keep { J::Null } else { J::n(if call { rows.len() } else { sent }) }),
                ]));
            }
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs MC_SP9_SERVERS (node scripts/spike-db-wire.mjs)"]
async fn mysql_values_match_mysql2() {
    let corpus: Value = serde_json::from_str(&read("mysql-corpus.json")).unwrap();
    for s in servers(&["mysql", "mariadb"]) {
        let mut c = my(&s, &s.user, &s.password, Some("sp9")).await.unwrap();
        println!(
            "{}: {} caps {:#010x} (server {:#010x}), mariadb ext {:?}, login {:?}",
            s.label,
            c.server_version,
            c.caps.bits(),
            c.server_caps.bits(),
            c.mariadb_ext,
            c.login
        );
        let mut lines = Vec::new();
        let t0 = Instant::now();
        for q in corpus["queries"].as_array().unwrap() {
            if q.get("only").and_then(Value::as_str).is_some_and(|o| o != s.kind) {
                continue;
            }
            let sql = q["sql"].as_str().unwrap();
            let results = c.query(sql).await.unwrap();
            lines.push(
                J::Obj(vec![("id", J::s(q["id"].as_str().unwrap())), ("statements", J::Arr(my_statements(sql, &results)))])
                    .text(),
            );
        }
        println!("{}: {} statements in {} ms", s.label, lines.len(), t0.elapsed().as_millis());
        assert_clean(compare(&format!("{}.jsonl", s.label), &lines));
    }
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs MC_SP9_SERVERS (node scripts/spike-db-wire.mjs)"]
async fn mysql_logins_caching_sha2_full_and_fast() {
    for s in servers(&["mysql", "mariadb"]) {
        let mut admin = my(&s, &s.user, &s.password, None).await.unwrap();
        println!("{} admin login: {:?}", s.label, admin.login);
        if s.kind == "mysql" {
            admin
                .query("CREATE USER IF NOT EXISTS 'sp9_rust'@'%' IDENTIFIED WITH caching_sha2_password BY 'sha2-pw'")
                .await
                .unwrap();
            admin.query("FLUSH PRIVILEGES").await.unwrap();
            let t = Instant::now();
            let mut first = my(&s, "sp9_rust", "sha2-pw", None).await.unwrap();
            let full_ms = t.elapsed().as_millis();
            let who = first.query("SELECT CURRENT_USER()").await.unwrap();
            let t = Instant::now();
            let second = my(&s, "sp9_rust", "sha2-pw", None).await.unwrap();
            let fast_ms = t.elapsed().as_millis();
            println!("{}: caching_sha2 full {:?} {full_ms} ms, then {:?} {fast_ms} ms", s.label, first.login, second.login);
            assert_eq!(first.login.cache_state, Some(4));
            assert!(first.login.requested_public_key);
            assert_eq!(second.login.cache_state, Some(3));
            assert_eq!(who[0].values(), vec![vec![DbValue::Text("sp9_rust@%".into())]]);
        } else {
            admin.query("CREATE USER IF NOT EXISTS 'sp9_native'@'%' IDENTIFIED BY 'native-pw'").await.unwrap();
            let c = my(&s, "sp9_native", "native-pw", None).await.unwrap();
            println!("{}: native {:?}", s.label, c.login);
        }
        match my(&s, &s.user, "wrong", None).await {
            Err(unimux_db::wire::mysql::MyWireError::Server(e)) => {
                println!("{}: wrong password -> {} ({}) {}", s.label, e.code, e.state, e.message);
                assert_eq!(e.code, 1045);
            }
            other => panic!("wrong password: {:?}", other.map(|_| ())),
        }
    }
}

// ── Redis ──

/// The own client (`wire::redis::RedisConn`) on a plain TCP stream.
async fn own(s: &Server) -> RedisConn {
    let stream = TcpStream::connect((s.host.as_str(), s.port)).await.unwrap();
    stream.set_nodelay(true).unwrap();
    RedisConn::start(stream)
}

async fn call(c: &RedisConn, argv: &[Vec<u8>]) -> Raw {
    let refs: Vec<&[u8]> = argv.iter().map(Vec::as_slice).collect();
    c.call(&refs).await.unwrap()
}

fn argv_of(v: &Value) -> Vec<Vec<u8>> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|a| match a {
            Value::String(s) => s.as_bytes().to_vec(),
            o => base64::engine::general_purpose::STANDARD.decode(o["b64"].as_str().unwrap()).unwrap(),
        })
        .collect()
}

fn status_map() -> std::collections::HashMap<String, bool> {
    read("redis8.jsonl")
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .filter_map(|v| Some((v["id"].as_str()?.to_owned(), v.get("status")?.as_bool()?)))
        .collect()
}

async fn redis_setup(s: &Server, corpus: &Value) {
    let admin = own(s).await;
    for argv in corpus["setup"].as_array().unwrap() {
        call(&admin, &argv_of(argv)).await;
    }
}

/// The corpus commands as the console sends them: the command name in lower case (`argv[0].toString('utf8').toLowerCase()`).
fn console_commands(corpus: &Value) -> Vec<(String, Vec<Vec<u8>>)> {
    corpus["commands"]
        .as_array()
        .unwrap()
        .iter()
        .map(|q| {
            let mut argv = argv_of(&q["argv"]);
            argv[0] = node_utf8(&argv[0]).to_lowercase().into_bytes();
            (q["id"].as_str().unwrap().to_owned(), argv)
        })
        .collect()
}

/// From the redis crate's RESP2 value. Status lines come as `Okay` / `SimpleString`, errors as `ServerError` (code and
/// detail split at the first space, joined again here).
fn from_redis(v: redis::Value) -> Raw {
    match v {
        redis::Value::Nil => Raw::Null,
        redis::Value::Int(i) => Raw::Integer(i.to_string()),
        redis::Value::BulkString(b) => Raw::Bytes(b),
        redis::Value::SimpleString(s) => Raw::Bytes(s.into_bytes()),
        redis::Value::Okay => Raw::Bytes(b"OK".to_vec()),
        redis::Value::Array(items) | redis::Value::Set(items) => Raw::Array(items.into_iter().map(from_redis).collect()),
        redis::Value::ServerError(e) => Raw::Error(match e.details() {
            Some(d) => format!("{} {}", e.code(), d),
            None => e.code().to_owned(),
        }),
        other => Raw::Bytes(format!("{other:?}").into_bytes()),
    }
}

fn reply_line(id: &str, status: bool, raw: &Raw) -> String {
    let mut budget = REPLY_NODES;
    J::Obj(vec![
        ("id", J::s(id)),
        ("status", J::Bool(status)),
        ("reply", J::Raw(reply(raw, status, &mut budget, true).to_json())),
    ])
    .text()
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs MC_SP9_SERVERS (node scripts/spike-db-wire.mjs)"]
async fn redis_replies_match_ioredis() {
    let corpus: Value = serde_json::from_str(&read("redis-corpus.json")).unwrap();
    // statuses of the big replies are not in their hashed lines: the classification says false for EVAL
    let statuses = status_map();
    for s in servers(&["redis"]) {
        // 1. the own RESP2 client, opened with the 1.1.4 connect sequence
        redis_setup(&s, &corpus).await;
        let stream = TcpStream::connect((s.host.as_str(), s.port)).await.unwrap();
        let (console, info) = RedisConn::open(stream, "", None, 0).await.unwrap();
        assert!(info.starts_with(b"# Server"));
        let mut own_lines = Vec::new();
        for (id, argv) in console_commands(&corpus) {
            let raw = call(&console, &argv).await;
            own_lines.push(reply_line(&id, statuses.get(&id).copied().unwrap_or(false), &raw));
        }
        assert_clean(compare(&format!("{}.jsonl", s.label), &own_lines));

        // 2. the redis crate (MultiplexedConnection over the same kind of stream), on a fresh setup: shows its gap
        redis_setup(&s, &corpus).await;
        let mut via_crate = Vec::new();
        let mut crate_failures = Vec::new();
        let (mut mux, driver) = open_mux(&s).await;
        let mut driver = Some(driver);
        for (id, argv) in console_commands(&corpus) {
            let status = statuses.get(&id).copied().unwrap_or(false);
            let mut cmd = redis::cmd(std::str::from_utf8(&argv[0]).unwrap());
            for a in &argv[1..] {
                cmd.arg(a.as_slice());
            }
            let got = match mux.send_packed_command(&cmd).await {
                Ok(v) => Some(from_redis(v)),
                Err(e) => match redis::ServerError::try_from(e) {
                    Ok(se) => Some(from_redis(redis::Value::ServerError(se))),
                    Err(e) => {
                        crate_failures.push(format!("{id}: {}", e.to_string().replace('\n', " ")));
                        // the connection is gone: a new one for the rest
                        if let Some(d) = driver.take() {
                            d.abort();
                        }
                        let (m, d) = open_mux(&s).await;
                        mux = m;
                        driver = Some(d);
                        None
                    }
                },
            };
            via_crate.push(match got {
                Some(raw) => reply_line(&id, status, &raw),
                None => format!("{{\"id\":\"{id}\",\"failed\":true}}"),
            });
        }
        let crate_bad = compare(&format!("{}.jsonl", s.label), &via_crate);
        println!("{}: redis crate failures: {crate_failures:?}", s.label);
        println!("{}: redis crate mismatches: {}", s.label, crate_bad.len());
        for b in &crate_bad {
            println!("  {}", b.lines().next().unwrap_or(""));
        }
        // the gap that makes the own reader necessary: non-UTF-8 status / error lines end the crate's connection
        let ids: Vec<&str> = crate_failures.iter().map(|f| f.split(':').next().unwrap()).collect();
        assert_eq!(ids, vec!["eval_status_bytes", "eval_error_bytes"]);
        assert_eq!(crate_bad.len(), 2, "{crate_bad:?}");
    }
}

async fn open_mux(s: &Server) -> (redis::aio::MultiplexedConnection, tokio::task::JoinHandle<()>) {
    let stream = TcpStream::connect((s.host.as_str(), s.port)).await.unwrap();
    let info = redis::RedisConnectionInfo::default().set_skip_set_lib_name();
    let cfg = redis::AsyncConnectionConfig::new().set_response_timeout(None).set_connection_timeout(None);
    let (mut c, driver) = redis::aio::MultiplexedConnection::new_with_config(&info, stream, cfg).await.unwrap();
    let d = tokio::spawn(driver);
    for argv in connect_sequence("", None, 0) {
        let mut cmd = redis::cmd(std::str::from_utf8(&argv[0]).unwrap());
        for a in &argv[1..] {
            cmd.arg(a.as_slice());
        }
        c.send_packed_command(&cmd).await.unwrap();
    }
    (c, d)
}

/// The bytes the own client writes on connect (`RedisConn::open`), against what ioredis + openRedis wrote.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs MC_SP9_SERVERS (node scripts/spike-db-wire.mjs)"]
async fn redis_connect_sequence_matches_ioredis() {
    for s in servers(&["redis"]) {
        let mut lines = Vec::new();
        for (case, user, pw, db) in [("default", "", None, 0), ("acl", "sp9", Some("pw"), 2)] {
            let stream = TcpStream::connect((s.host.as_str(), s.port)).await.unwrap();
            let (stream, view) = tap(stream);
            let (c, _info) = RedisConn::open(stream, user, pw, db).await.unwrap();
            c.close();
            lines.push(
                J::Obj(vec![
                    ("case", J::s(case)),
                    ("sent", J::s(base64::engine::general_purpose::STANDARD.encode(view.written()))),
                ])
                .text(),
            );
        }
        assert_clean(compare(&format!("{}-connect.jsonl", s.label), &lines));
        // a wrong password: the connect sequence stops at AUTH with the server's error
        let stream = TcpStream::connect((s.host.as_str(), s.port)).await.unwrap();
        let r = RedisConn::open(stream, "sp9", Some("wrong"), 0).await.map(|_| ());
        println!("{}: wrong password -> {r:?}", s.label);
        assert!(matches!(r, Err(CallError::Server(m)) if m.starts_with("WRONGPASS")));
    }
}

/// A TCP proxy in front of the server that can drop every connection and refuse new ones.
async fn switchable_proxy(
    s: &Server,
) -> (u16, std::sync::Arc<std::sync::atomic::AtomicBool>, tokio::sync::broadcast::Sender<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let up = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(true));
    let (kill, _) = tokio::sync::broadcast::channel::<()>(4);
    let target = (s.host.clone(), s.port);
    let (up2, kill2) = (up.clone(), kill.clone());
    tokio::spawn(async move {
        loop {
            let Ok((mut client, _)) = listener.accept().await else { return };
            if !up2.load(std::sync::atomic::Ordering::SeqCst) {
                drop(client);
                continue;
            }
            let target = target.clone();
            let mut killed = kill2.subscribe();
            tokio::spawn(async move {
                let Ok(mut server) = TcpStream::connect((target.0.as_str(), target.1)).await else { return };
                tokio::select! {
                    _ = tokio::io::copy_bidirectional(&mut client, &mut server) => {}
                    _ = killed.recv() => {}
                }
            });
        }
    });
    (port, up, kill)
}

/// 1.1.4's drop and retryStrategy behaviour, run over the own client (`RedisConn`) and the own loop (`wire::redis::reconnect`):
/// a pending command fails at once and is never written again, the drop is seen without a command in flight, a later
/// command on the dropped connection is refused at once, attempts after 300 / 1000 / 2000 ms, closed after 3 failures.
#[tokio::test(flavor = "multi_thread")]
#[ignore = "needs MC_SP9_SERVERS (node scripts/spike-db-wire.mjs)"]
async fn redis_drop_and_reconnect_like_ioredis() {
    for s in servers(&["redis"]) {
        let (port, up, kill) = switchable_proxy(&s).await;
        // a reconnect attempt: a new stream plus ioredis' reconnect handshake; a refused proxy connection closes before
        // the first reply, so the handshake fails with Dropped
        let attempt = move || async move {
            let stream = TcpStream::connect(("127.0.0.1", port)).await.map_err(|_| CallError::NotWritable)?;
            let c = RedisConn::start(stream);
            for argv in reconnect_sequence("", None, None) {
                let refs: Vec<&[u8]> = argv.iter().map(Vec::as_slice).collect();
                c.call(&refs).await?;
            }
            Ok::<_, CallError>(c)
        };

        // 0. the gap of the redis crate that rules it out here: its default response timeout (500 ms) cuts a slow command
        let stream = TcpStream::connect((s.host.as_str(), s.port)).await.unwrap();
        let info = redis::RedisConnectionInfo::default().set_skip_set_lib_name();
        let (mut d, drv) =
            redis::aio::MultiplexedConnection::new_with_config(&info, stream, redis::AsyncConnectionConfig::new()).await.unwrap();
        tokio::spawn(drv);
        let t = Instant::now();
        let r = d.send_packed_command(redis::cmd("BLPOP").arg("sp9_nokey").arg("1")).await;
        println!(
            "{}: redis crate, default config, BLPOP 1 s -> {:?} after {} ms",
            s.label,
            r.as_ref().map(|_| ()).map_err(|e| e.to_string()),
            t.elapsed().as_millis()
        );
        assert!(r.is_err_and(|e| e.is_timeout()));
        // the own client has no response timeout (the console's own timeouts are D10's)
        let c = own(&s).await;
        let t = Instant::now();
        let r = c.call(&[b"blpop".as_slice(), b"sp9_nokey", b"1"]).await;
        assert_eq!(r, Ok(Raw::Null));
        assert!(t.elapsed() >= Duration::from_millis(950));

        // 1. a drop while a command is pending: it fails, the drop is seen, nothing is written again
        let stream = TcpStream::connect(("127.0.0.1", port)).await.unwrap();
        let (stream, view) = tap(stream);
        let (c, _) = RedisConn::open(stream, "", None, 0).await.unwrap();
        let c = std::sync::Arc::new(c);
        let c2 = c.clone();
        let pending = tokio::spawn(async move { c2.call(&[b"blpop".as_slice(), b"sp9_nokey", b"5"]).await });
        tokio::time::sleep(Duration::from_millis(200)).await;
        let dropped = Instant::now();
        let _ = kill.send(());
        let r = tokio::time::timeout(Duration::from_secs(3), pending).await.expect("pending command ends").unwrap();
        let fail_ms = dropped.elapsed().as_millis();
        let mut ended = c.ended();
        tokio::time::timeout(Duration::from_secs(3), ended.wait_for(|e| *e)).await.expect("drop seen").unwrap();
        let seen_ms = dropped.elapsed().as_millis();
        let after = c.call(&[b"ping".as_slice()]).await;
        println!(
            "{}: drop -> pending BLPOP {r:?} after {fail_ms} ms ({}), end seen after {seen_ms} ms, next command {after:?} ({})",
            s.label,
            r.as_ref().map_err(|e| e.message(true)).err().unwrap_or_default(),
            after.as_ref().map_err(|e| e.message(true)).err().unwrap_or_default(),
        );
        assert_eq!(r, Err(CallError::Dropped));
        assert_eq!(after, Err(CallError::NotWritable));
        assert!(fail_ms < 1000, "{fail_ms} ms");
        let written = String::from_utf8_lossy(&view.written()).matches("blpop").count();
        assert_eq!(written, 1, "the pending command is not sent again");

        // 2. a drop with nothing in flight is seen by the driver's read
        let (idle, _) = RedisConn::open(TcpStream::connect(("127.0.0.1", port)).await.unwrap(), "", None, 0).await.unwrap();
        let dropped = Instant::now();
        let _ = kill.send(());
        let mut ended = idle.ended();
        tokio::time::timeout(Duration::from_secs(3), ended.wait_for(|e| *e)).await.expect("idle drop seen").unwrap();
        println!("{}: idle drop seen after {} ms", s.label, dropped.elapsed().as_millis());

        // 3. reconnect: the server back after 800 ms -> attempt 1 (300 ms) refused, attempt 2 (+1000 ms) reconnects
        let start = Instant::now();
        up.store(false, std::sync::atomic::Ordering::SeqCst);
        let up3 = up.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(800)).await;
            up3.store(true, std::sync::atomic::Ordering::SeqCst);
        });
        let mut events = Vec::new();
        let back = reconnect(|_| attempt(), |e| events.push((e, start.elapsed().as_millis()))).await;
        println!("{}: {events:?}", s.label);
        let back = back.expect("reconnected");
        assert_eq!(call(&back, &[b"ping".to_vec()]).await, Raw::Bytes(b"PONG".to_vec()));
        let kinds: Vec<ReconnectEvent> = events.iter().map(|e| e.0).collect();
        assert_eq!(kinds, [ReconnectEvent::Reconnecting(1), ReconnectEvent::Reconnecting(2), ReconnectEvent::Reconnected]);
        assert!((1300..2300).contains(&events[2].1), "{events:?}");

        // 4. the server never comes back: three attempts, then closed (300 + 1000 + 2000 ms)
        up.store(false, std::sync::atomic::Ordering::SeqCst);
        let _ = kill.send(());
        let start = Instant::now();
        let mut events = Vec::new();
        let gone = reconnect(|_| attempt(), |e| events.push((e, start.elapsed().as_millis()))).await;
        println!("{}: {events:?}", s.label);
        assert!(gone.is_none());
        let kinds: Vec<ReconnectEvent> = events.iter().map(|e| e.0).collect();
        assert_eq!(
            kinds,
            [
                ReconnectEvent::Reconnecting(1),
                ReconnectEvent::Reconnecting(2),
                ReconnectEvent::Reconnecting(3),
                ReconnectEvent::Closed
            ]
        );
        assert!((3300..4500).contains(&events[3].1), "{events:?}");
    }
}
