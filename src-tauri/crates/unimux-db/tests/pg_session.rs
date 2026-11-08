//! D5: PgSession against a small in-process fake Postgres server that speaks the simple and the extended protocol
//! (Parse / Bind / Describe / Execute with a row count / Close / Sync like a real server: a portal that hands out exactly
//! the asked number of rows is suspended, the next Execute completes it). Covers the value goldens of 1.1.4 (numeric,
//! interval, arrays, bytea, timestamps from test/golden/db-wire), cursors with adaptive batches, fetchMore, the idle
//! close of an open result, read-only refusals and the readWrite override, statement timeouts, cancel, error mapping,
//! transactions, notices and a connection that ends on its own.

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::Notify;
use unimux_db::pg::connect::{PgTarget, TcpConnector, connect_tls};
use unimux_db::pg::messages::PgPortMessage;
use unimux_db::pg::session::{PgCancel, PgOut, PgSession, PgSessionOptions};
use unimux_db::pg::tls::TlsMode;
use unimux_db::wire::pg::BackendKey;

// ── the fake server ──────────────────────────────────────────────────────────

fn msg(tag: u8, body: &[u8]) -> Vec<u8> {
    let mut b = vec![tag];
    b.extend(((body.len() + 4) as i32).to_be_bytes());
    b.extend(body);
    b
}

fn cstr(s: &str) -> Vec<u8> {
    let mut b = s.as_bytes().to_vec();
    b.push(0);
    b
}

fn error_msg(tag: u8, fields: &[(u8, &str)]) -> Vec<u8> {
    let mut body = Vec::new();
    for (k, v) in fields {
        body.push(*k);
        body.extend(cstr(v));
    }
    body.push(0);
    msg(tag, &body)
}

#[derive(Clone)]
struct Field {
    name: String,
    oid: u32,
}

#[derive(Clone)]
enum Script {
    Rows {
        fields: Vec<Field>,
        rows: Vec<Vec<Option<String>>>,
        tag: String,
        notice: Option<String>,
    },
    Command(String),
    Error {
        code: String,
        message: String,
        position: Option<u32>,
    },
    /// Waits for a cancel, then fails with 57014.
    Slow,
}

fn row_desc(fields: &[Field]) -> Vec<u8> {
    let mut body = (fields.len() as i16).to_be_bytes().to_vec();
    for f in fields {
        body.extend(cstr(&f.name));
        body.extend(0u32.to_be_bytes());
        body.extend(0i16.to_be_bytes());
        body.extend(f.oid.to_be_bytes());
        body.extend((-1i16).to_be_bytes());
        body.extend((-1i32).to_be_bytes());
        body.extend(0i16.to_be_bytes());
    }
    msg(b'T', &body)
}

fn data_row(values: &[Option<String>]) -> Vec<u8> {
    let mut body = (values.len() as i16).to_be_bytes().to_vec();
    for v in values {
        match v {
            Some(v) => {
                body.extend((v.len() as i32).to_be_bytes());
                body.extend(v.as_bytes());
            }
            None => body.extend((-1i32).to_be_bytes()),
        }
    }
    msg(b'D', &body)
}

fn field(name: &str, oid: u32) -> Field {
    Field { name: name.into(), oid }
}

fn golden(file: &str, id: &str) -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/golden/db-wire").join(file);
    let text = std::fs::read_to_string(p).unwrap();
    text.lines().map(|l| serde_json::from_str::<Value>(l).unwrap()).find(|v| v["id"] == id).unwrap()
}

#[derive(Default)]
struct FakeState {
    log: Vec<String>,
    cancels: usize,
}

struct Fake {
    port: u16,
    state: Arc<Mutex<FakeState>>,
    cancel: Arc<Notify>,
}

struct Conn {
    tx: u8,
    read_only: bool,
}

fn script(sql: &str, param: Option<&str>, c: &mut Conn) -> Script {
    let rows1 = |name: &str, oid: u32, v: &str| Script::Rows {
        fields: vec![field(name, oid)],
        rows: vec![vec![Some(v.to_owned())]],
        tag: "SELECT 1".into(),
        notice: None,
    };
    if sql.starts_with("SELECT oid, format_type(oid, NULL), typcategory FROM pg_type") {
        let types = [("16", "boolean", "B"), ("23", "integer", "N"), ("25", "text", "S"), ("1700", "numeric", "N")];
        return Script::Rows {
            fields: vec![field("oid", 26), field("format_type", 25), field("typcategory", 18)],
            rows: types.iter().map(|(a, b, c)| vec![Some((*a).into()), Some((*b).into()), Some((*c).into())]).collect(),
            tag: format!("SELECT {}", types.len()),
            notice: None,
        };
    }
    if sql.starts_with("SELECT t.oid, format_type(t.oid, NULL)") {
        let oids: Vec<String> =
            param.unwrap_or("{}").trim_matches(['{', '}']).split(',').map(|s| s.trim_matches('"').to_owned()).collect();
        return Script::Rows {
            fields: vec![field("oid", 26), field("format_type", 25), field("typcategory", 18)],
            rows: oids.iter().map(|o| vec![Some(o.clone()), Some(format!("type_{o}")), Some("U".into())]).collect(),
            tag: format!("SELECT {}", oids.len()),
            notice: None,
        };
    }
    if let Some(rest) = sql.strip_prefix("SELECT golden ") {
        let (file, id) = rest.split_once(' ').unwrap();
        let g = golden(file, id);
        let fields = g["host"]["columns"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| field(c["name"].as_str().unwrap(), c["typeOid"].as_u64().unwrap() as u32))
            .collect();
        let rows = g["host"]["rows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| r.as_array().unwrap().iter().map(|v| v.as_str().map(str::to_owned)).collect())
            .collect::<Vec<_>>();
        let tag = format!("SELECT {}", rows.len());
        return Script::Rows { fields, rows, tag, notice: None };
    }
    if sql.starts_with("SET default_transaction_read_only = on") {
        c.read_only = true;
        return Script::Command("SET".into());
    }
    if sql.starts_with("SET default_transaction_read_only = off") {
        c.read_only = false;
        return Script::Command("SET".into());
    }
    if sql.starts_with("SET ") {
        return Script::Command("SET".into());
    }
    if sql.starts_with("RESET ") {
        return Script::Command("RESET".into());
    }
    match sql {
        "BEGIN" => {
            c.tx = b'T';
            Script::Command("BEGIN".into())
        }
        "COMMIT" | "ROLLBACK" => {
            let tag = if c.tx == b'E' { "ROLLBACK" } else { sql };
            c.tx = b'I';
            Script::Command(tag.into())
        }
        "SELECT * FROM big" => Script::Rows {
            fields: vec![field("id", 23)],
            rows: (1..=2500).map(|i| vec![Some(i.to_string())]).collect(),
            tag: "SELECT 2500".into(),
            notice: None,
        },
        "SELECT 1" | "SELECT quit" => rows1("?column?", 23, "1"),
        "SELECT usertype" => rows1("u", 70_000, "x"),
        "SELECT notice" => Script::Rows {
            fields: vec![field("n", 25)],
            rows: vec![vec![None]],
            tag: "SELECT 1".into(),
            notice: Some("hello from the server".into()),
        },
        "SELECT slow" => Script::Slow,
        "SELECT bad" => {
            Script::Error { code: "42703".into(), message: "column \"bad\" does not exist".into(), position: Some(8) }
        }
        "SELECT timeout" => {
            Script::Error { code: "57014".into(), message: "canceling statement due to statement timeout".into(), position: None }
        }
        "INSERT INTO t VALUES (1)" | "INSERT INTO t VALUES (1) RETURNING id" | "DELETE FROM t" => {
            if c.read_only {
                let verb = sql.split(' ').next().unwrap();
                return Script::Error {
                    code: "25006".into(),
                    message: format!("cannot execute {verb} in a read-only transaction"),
                    position: None,
                };
            }
            if sql.ends_with("RETURNING id") {
                Script::Rows {
                    fields: vec![field("id", 23)],
                    rows: vec![vec![Some("1".into())]],
                    tag: "INSERT 0 1".into(),
                    notice: None,
                }
            } else if sql.starts_with("DELETE") {
                Script::Command("DELETE 3".into())
            } else {
                Script::Command("INSERT 0 1".into())
            }
        }
        _ => Script::Error { code: "42601".into(), message: format!("syntax error: {sql}"), position: Some(1) },
    }
}

struct Portal {
    fields: Vec<Field>,
    rows: VecDeque<Vec<Option<String>>>,
    tag: String,
    slow: bool,
    error: Option<Script>,
    notice: Option<String>,
}

async fn read_body(s: &mut TcpStream) -> Option<Vec<u8>> {
    let mut len = [0u8; 4];
    s.read_exact(&mut len).await.ok()?;
    let mut body = vec![0u8; i32::from_be_bytes(len) as usize - 4];
    s.read_exact(&mut body).await.ok()?;
    Some(body)
}

fn take_cstr(b: &[u8], at: &mut usize) -> String {
    let end = b[*at..].iter().position(|c| *c == 0).unwrap() + *at;
    let s = String::from_utf8_lossy(&b[*at..end]).into_owned();
    *at = end + 1;
    s
}

fn i16_at(b: &[u8], at: &mut usize) -> i16 {
    let v = i16::from_be_bytes([b[*at], b[*at + 1]]);
    *at += 2;
    v
}

fn i32_at(b: &[u8], at: &mut usize) -> i32 {
    let v = i32::from_be_bytes([b[*at], b[*at + 1], b[*at + 2], b[*at + 3]]);
    *at += 4;
    v
}

fn error_bytes(code: &str, message: &str, position: Option<u32>) -> Vec<u8> {
    let p = position.map(|p| p.to_string());
    let mut f: Vec<(u8, &str)> = vec![(b'S', "ERROR"), (b'V', "ERROR"), (b'C', code), (b'M', message)];
    if let Some(p) = &p {
        f.push((b'P', p));
    }
    error_msg(b'E', &f)
}

async fn serve(mut s: TcpStream, st: Arc<Mutex<FakeState>>, cancel: Arc<Notify>, close_after_quit: bool) -> Option<()> {
    let _startup = read_body(&mut s).await?;
    let mut out = msg(b'R', &0i32.to_be_bytes());
    out.extend(msg(b'S', &[cstr("server_version"), cstr("16.4")].concat()));
    out.extend(msg(b'K', &[7i32.to_be_bytes(), 42i32.to_be_bytes()].concat()));
    out.extend(msg(b'Z', b"I"));
    s.write_all(&out).await.ok()?;
    let mut c = Conn { tx: b'I', read_only: false };
    let mut parsed = String::new();
    let mut portals: HashMap<String, Portal> = HashMap::new();
    let mut skip = false;
    loop {
        let mut tag = [0u8; 1];
        s.read_exact(&mut tag).await.ok()?;
        let body = read_body(&mut s).await?;
        let mut out = Vec::new();
        let fail_tx = |c: &mut Conn| {
            if c.tx == b'T' {
                c.tx = b'E';
            }
        };
        match tag[0] {
            b'Q' => {
                let sql = String::from_utf8_lossy(&body[..body.len() - 1]).into_owned();
                st.lock().log.push(sql.clone());
                match script(&sql, None, &mut c) {
                    Script::Rows { fields, rows, tag, notice } => {
                        if let Some(n) = notice {
                            out.extend(error_msg(b'N', &[(b'S', "NOTICE"), (b'C', "00000"), (b'M', &n)]));
                        }
                        out.extend(row_desc(&fields));
                        for r in &rows {
                            out.extend(data_row(r));
                        }
                        out.extend(msg(b'C', &cstr(&tag)));
                    }
                    Script::Command(t) => out.extend(msg(b'C', &cstr(&t))),
                    Script::Error { code, message, position } => {
                        fail_tx(&mut c);
                        out.extend(error_bytes(&code, &message, position));
                    }
                    Script::Slow => {
                        let _ = tokio::time::timeout(Duration::from_secs(5), cancel.notified()).await;
                        fail_tx(&mut c);
                        out.extend(error_bytes("57014", "canceling statement due to user request", None));
                    }
                }
                out.extend(msg(b'Z', &[c.tx]));
                s.write_all(&std::mem::take(&mut out)).await.ok()?;
                if close_after_quit && sql == "SELECT quit" {
                    return None;
                }
            }
            b'P' => {
                if skip {
                    continue;
                }
                let mut at = 0;
                let _name = take_cstr(&body, &mut at);
                parsed = take_cstr(&body, &mut at);
                st.lock().log.push(parsed.clone());
                if parsed == "SELECT bad" {
                    let Script::Error { code, message, position } = script(&parsed, None, &mut c) else { unreachable!() };
                    fail_tx(&mut c);
                    out.extend(error_bytes(&code, &message, position));
                    skip = true;
                } else {
                    out.extend(msg(b'1', &[]));
                }
            }
            b'B' => {
                if skip {
                    continue;
                }
                let mut at = 0;
                let portal = take_cstr(&body, &mut at);
                let _stmt = take_cstr(&body, &mut at);
                let nf = i16_at(&body, &mut at);
                at += 2 * nf as usize;
                let np = i16_at(&body, &mut at);
                let mut first = None;
                for _ in 0..np {
                    let len = i32_at(&body, &mut at);
                    if len >= 0 {
                        let v = String::from_utf8_lossy(&body[at..at + len as usize]).into_owned();
                        first.get_or_insert(v);
                        at += len as usize;
                    }
                }
                let p = match script(&parsed, first.as_deref(), &mut c) {
                    Script::Rows { fields, rows, tag, notice } => {
                        Portal { fields, rows: rows.into(), tag, slow: false, error: None, notice }
                    }
                    Script::Command(t) => {
                        Portal { fields: vec![], rows: VecDeque::new(), tag: t, slow: false, error: None, notice: None }
                    }
                    Script::Slow => Portal {
                        fields: vec![field("x", 25)],
                        rows: VecDeque::new(),
                        tag: String::new(),
                        slow: true,
                        error: None,
                        notice: None,
                    },
                    e @ Script::Error { .. } => Portal {
                        fields: vec![],
                        rows: VecDeque::new(),
                        tag: String::new(),
                        slow: false,
                        error: Some(e),
                        notice: None,
                    },
                };
                portals.insert(portal, p);
                out.extend(msg(b'2', &[]));
            }
            b'D' => {
                if skip {
                    continue;
                }
                let mut at = 1;
                let name = take_cstr(&body, &mut at);
                let p = portals.get(&name).unwrap();
                if p.fields.is_empty() { out.extend(msg(b'n', &[])) } else { out.extend(row_desc(&p.fields)) }
            }
            b'E' => {
                if skip {
                    continue;
                }
                let mut at = 0;
                let name = take_cstr(&body, &mut at);
                let max = i32_at(&body, &mut at);
                let p = portals.get_mut(&name).unwrap();
                if let Some(n) = p.notice.take() {
                    out.extend(error_msg(b'N', &[(b'S', "NOTICE"), (b'C', "00000"), (b'M', &n)]));
                }
                if let Some(Script::Error { code, message, position }) = p.error.clone() {
                    fail_tx(&mut c);
                    out.extend(error_bytes(&code, &message, position));
                    skip = true;
                } else if p.slow {
                    let _ = tokio::time::timeout(Duration::from_secs(5), cancel.notified()).await;
                    fail_tx(&mut c);
                    out.extend(error_bytes("57014", "canceling statement due to user request", None));
                    skip = true;
                } else {
                    let mut n = 0;
                    while (max <= 0 || n < max) && !p.rows.is_empty() {
                        out.extend(data_row(&p.rows.pop_front().unwrap()));
                        n += 1;
                    }
                    if max > 0 && n == max {
                        out.extend(msg(b's', &[]));
                    } else {
                        out.extend(msg(b'C', &cstr(&p.tag)));
                    }
                }
            }
            b'C' => {
                if skip {
                    continue;
                }
                let mut at = 1;
                portals.remove(&take_cstr(&body, &mut at));
                out.extend(msg(b'3', &[]));
            }
            b'H' => {}
            b'S' => {
                skip = false;
                portals.clear();
                out.extend(msg(b'Z', &[c.tx]));
                // the cursor of "SELECT quit" ends with this Sync: the server goes away after it
                if close_after_quit && parsed == "SELECT quit" {
                    s.write_all(&out).await.ok()?;
                    return None;
                }
            }
            b'X' => return None,
            other => panic!("fake: unexpected message {}", other as char),
        }
        if !out.is_empty() {
            s.write_all(&out).await.ok()?;
        }
    }
}

async fn start_fake() -> Fake {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let state = Arc::new(Mutex::new(FakeState::default()));
    let cancel = Arc::new(Notify::new());
    let (st, cn) = (state.clone(), cancel.clone());
    tokio::spawn(async move {
        while let Ok((sock, _)) = listener.accept().await {
            let _ = sock.set_nodelay(true);
            tokio::spawn(serve(sock, st.clone(), cn.clone(), true));
        }
    });
    Fake { port, state, cancel }
}

// ── the session side ─────────────────────────────────────────────────────────

#[derive(Default)]
struct Out {
    port: Mutex<Vec<Value>>,
    tx: Mutex<Vec<String>>,
    activity: Mutex<Vec<bool>>,
    fatal: Mutex<usize>,
    closed: Mutex<usize>,
}

impl PgOut for Out {
    fn port(&self, m: PgPortMessage) {
        let json = m.to_json();
        assert_eq!(m.query_id(), serde_json::from_str::<Value>(&json).unwrap()["queryId"].as_str().unwrap());
        self.port.lock().push(serde_json::from_str(&json).unwrap());
    }
    fn tx(&self, tx: &'static str) {
        self.tx.lock().push(tx.into());
    }
    fn activity(&self, busy: bool) {
        self.activity.lock().push(busy);
    }
    fn fatal(&self) {
        *self.fatal.lock() += 1;
    }
    fn closed(&self) {
        *self.closed.lock() += 1;
    }
}

struct TestCancel {
    fake: Arc<Notify>,
    state: Arc<Mutex<FakeState>>,
}

impl PgCancel for TestCancel {
    fn cancel(&self, key: BackendKey) -> BoxFuture<'static, bool> {
        assert_eq!(key.process_id, 7);
        self.state.lock().cancels += 1;
        self.fake.notify_one();
        Box::pin(async { true })
    }
}

struct Setup {
    fake: Fake,
    out: Arc<Out>,
    session: PgSession,
}

async fn setup(read_only: bool, timeout_ms: f64, idle_ms: Option<u64>) -> Setup {
    let fake = start_fake().await;
    let target = PgTarget {
        user: "u".into(),
        database: "d".into(),
        tls: TlsMode::Disable,
        ca: None,
        logical_host: "127.0.0.1".into(),
        connect_timeout: Duration::from_secs(5),
    };
    let client = connect_tls(&TcpConnector::new("127.0.0.1", fake.port), &target, None).await.unwrap();
    let cancel = Arc::new(TestCancel { fake: fake.cancel.clone(), state: fake.state.clone() });
    let mut opts = PgSessionOptions::new(read_only, Some(timeout_ms), cancel);
    if let Some(ms) = idle_ms {
        opts.cursor_idle_ms = ms;
    }
    let out = Arc::new(Out::default());
    let session = PgSession::start(client, opts, out.clone()).await.unwrap();
    Setup { fake, out, session }
}

impl Setup {
    fn messages(&self, query_id: &str) -> Vec<Value> {
        self.out.port.lock().iter().filter(|m| m["queryId"] == query_id).cloned().collect()
    }

    fn of(&self, query_id: &str, t: &str) -> Vec<Value> {
        self.messages(query_id).into_iter().filter(|m| m["t"] == t).collect()
    }

    async fn wait(&self, query_id: &str, t: &str, n: usize) -> Vec<Value> {
        for _ in 0..500 {
            let got = self.of(query_id, t);
            if got.len() >= n {
                return got;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no {n} x {t} for {query_id}: {:?}", self.messages(query_id));
    }

    async fn query(&self, query_id: &str, sql: &str, extra: Value) -> Value {
        let mut req = json!({ "queryId": query_id, "sql": sql });
        for (k, v) in extra.as_object().unwrap() {
            req[k] = v.clone();
        }
        assert_eq!(self.session.handle(&json!({ "op": "query", "req": req })).await, json!({ "ok": true, "value": true }));
        self.wait(query_id, "queryEnd", 1).await.remove(0)
    }

    fn log(&self) -> Vec<String> {
        self.fake.state.lock().log.clone()
    }

    fn rows(&self, query_id: &str) -> Vec<Value> {
        self.of(query_id, "rows").iter().flat_map(|m| m["rows"].as_array().unwrap().clone()).collect()
    }
}

// ── tests ────────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread")]
async fn values_match_the_1_1_4_goldens() {
    let s = setup(false, 0.0, None).await;
    let mut n = 0;
    for file in ["pg13.jsonl", "pg18.jsonl"] {
        for id in ["numeric", "interval", "arrays", "bytea", "timestamps", "timestamptz_zone", "ints", "floats8", "money"] {
            n += 1;
            let q = format!("g{n}");
            let end = s.query(&q, &format!("SELECT golden {file} {id}"), json!({})).await;
            assert_eq!(end["ok"], true, "{file} {id}: {:?}", s.messages(&q));
            let g = golden(file, id);
            assert_eq!(Value::Array(s.rows(&q)), g["host"]["rows"], "{file} {id}");
            let cols = s.of(&q, "columns").remove(0);
            let names: Vec<_> =
                cols["columns"].as_array().unwrap().iter().map(|c| (c["name"].clone(), c["typeOid"].clone())).collect();
            let want: Vec<_> =
                g["host"]["columns"].as_array().unwrap().iter().map(|c| (c["name"].clone(), c["typeOid"].clone())).collect();
            assert_eq!(names, want, "{file} {id}");
            let end = s.of(&q, "statementEnd").remove(0);
            assert_eq!(end["command"], "SELECT");
            assert_eq!(end["hasMore"], false);
        }
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn cursors_read_in_adaptive_batches_and_fetch_more() {
    let s = setup(false, 0.0, None).await;
    let end = s.query("q1", "SELECT * FROM big", json!({ "rowCap": 1000 })).await;
    assert_eq!(end["ok"], true);
    let first = s.of("q1", "statementEnd").remove(0);
    assert_eq!(first["rows"], 1000);
    assert_eq!(first["hasMore"], true);
    assert_eq!(first["rowCount"], Value::Null);
    let sizes: Vec<usize> = s.of("q1", "rows").iter().map(|m| m["rows"].as_array().unwrap().len()).collect();
    assert_eq!(sizes, [100, 500, 400], "the first batch is 100 rows, then they adapt to the row width");
    let cols = s.of("q1", "columns").remove(0);
    assert_eq!(cols["columns"], json!([{ "name": "id", "typeOid": 23, "typeName": "integer", "kind": "int" }]));
    // the open result answers metadata with busy? no: only runs make it busy; a second fetch reads on
    assert_eq!(s.session.handle(&json!({ "op": "fetchMore", "queryId": "q1", "count": 1000 })).await["ok"], true);
    let second = s.wait("q1", "statementEnd", 2).await.remove(1);
    assert_eq!((second["rows"].clone(), second["hasMore"].clone()), (json!(2000), json!(true)));
    assert_eq!(s.session.handle(&json!({ "op": "fetchMore", "queryId": "q1", "count": 1000 })).await["ok"], true);
    let third = s.wait("q1", "statementEnd", 3).await.remove(2);
    assert_eq!(
        third,
        json!({"t": "statementEnd", "queryId": "q1", "index": 0, "command": "SELECT", "rowCount": 2500, "rows": 2500, "hasMore": false, "timeMs": third["timeMs"]})
    );
    let rows = s.rows("q1");
    assert_eq!(rows.len(), 2500);
    assert_eq!(rows[2499], json!(["2500"]));
    assert_eq!(s.session.handle(&json!({ "op": "fetchMore", "queryId": "q1", "count": 10 })).await["error"], "notFound");
    assert!(s.of("q1", "resultClosed").is_empty());
    assert!(!s.session.busy());
}

#[tokio::test(flavor = "multi_thread")]
async fn an_open_result_closes_when_idle_or_when_something_else_runs() {
    let s = setup(false, 0.0, Some(150)).await;
    s.query("q1", "SELECT * FROM big", json!({ "rowCap": 10 })).await;
    assert!(s.session.busy(), "an open result keeps the session busy");
    s.wait("q1", "resultClosed", 1).await;
    assert_eq!(s.session.handle(&json!({ "op": "fetchMore", "queryId": "q1", "count": 10 })).await["error"], "notFound");
    // another run closes it at once
    let s = setup(false, 0.0, None).await;
    s.query("q1", "SELECT * FROM big", json!({ "rowCap": 10 })).await;
    s.query("q2", "SELECT 1", json!({})).await;
    assert_eq!(s.of("q1", "resultClosed").len(), 1);
    let log = s.log();
    assert_eq!(log.iter().filter(|l| *l == "SELECT * FROM big").count(), 1);
    // closeResult
    s.query("q3", "SELECT * FROM big", json!({ "rowCap": 10 })).await;
    assert_eq!(s.session.handle(&json!({ "op": "closeResult", "queryId": "q3" })).await, json!({ "ok": true, "value": true }));
    assert_eq!(s.of("q3", "resultClosed").len(), 1);
}

#[tokio::test(flavor = "multi_thread")]
async fn rows_of_earlier_statements_and_writes_are_cut_not_kept() {
    let s = setup(false, 0.0, None).await;
    let end = s.query("q1", "SELECT * FROM big;\nSELECT 1", json!({ "rowCap": 10 })).await;
    assert_eq!(end["ok"], true);
    let ends = s.of("q1", "statementEnd");
    assert_eq!(ends[0]["truncated"], true);
    assert_eq!(ends[0]["hasMore"], false);
    assert_eq!(ends[0]["rows"], 10);
    assert_eq!(ends[0]["rowCount"], Value::Null);
    assert_eq!((ends[1]["command"].clone(), ends[1]["rowCount"].clone()), (json!("SELECT"), json!(1)));
    let starts: Vec<_> = s.of("q1", "statement").iter().map(|m| (m["start"].clone(), m["end"].clone())).collect();
    assert_eq!(starts, [(json!(0), json!(17)), (json!(19), json!(27))]);
    s.query("q2", "INSERT INTO t VALUES (1) RETURNING id", json!({})).await;
    let e = s.of("q2", "statementEnd").remove(0);
    assert_eq!((e["command"].clone(), e["rowCount"].clone(), e["hasMore"].clone()), (json!("INSERT"), json!(1), json!(false)));
    s.query("q3", "DELETE FROM t", json!({})).await;
    let e = s.of("q3", "statementEnd").remove(0);
    assert_eq!((e["command"].clone(), e["rowCount"].clone(), e["rows"].clone()), (json!("DELETE"), json!(3), json!(0)));
}

#[tokio::test(flavor = "multi_thread")]
async fn read_only_connections_refuse_writes_before_anything_runs() {
    let s = setup(true, 0.0, None).await;
    let before = s.log().len();
    let end = s.query("q1", "INSERT INTO t VALUES (1)", json!({})).await;
    assert_eq!((end["ok"].clone(), end["cancelled"].clone()), (json!(false), json!(false)));
    let err = s.of("q1", "statementError").remove(0);
    assert_eq!((err["error"].clone(), err["index"].clone()), (json!("readOnly"), json!(0)));
    let end = s.query("q2", "SELECT 1;\nDELETE FROM t", json!({})).await;
    assert_eq!(end["ok"], false);
    assert_eq!(s.of("q2", "statementError")[0]["index"], 1);
    assert!(s.of("q2", "statement").is_empty(), "nothing of the script ran");
    assert!(!s.log()[before..].iter().any(|l| l.starts_with("INSERT") || l.starts_with("DELETE") || l == "SELECT 1"));
    // a read runs, with read-only set again before it
    s.query("q3", "SELECT 1", json!({})).await;
    let log = s.log();
    let at = log.iter().rposition(|l| l == "SELECT 1").unwrap();
    assert_eq!(log[at - 1], "SET default_transaction_read_only = on");
    // the readWrite override: off, the write, on again
    let end = s.query("q4", "INSERT INTO t VALUES (1)", json!({ "readWrite": true })).await;
    assert_eq!(end["ok"], true, "{:?}", s.messages("q4"));
    let log = s.log();
    let at = log.iter().rposition(|l| l == "INSERT INTO t VALUES (1)").unwrap();
    assert_eq!(log[at - 1], "SET default_transaction_read_only = off");
    assert_eq!(log[at + 1], "SET default_transaction_read_only = on");
    // an override that leaves a transaction open: only ending it runs without the override
    s.query("q5", "BEGIN;\nINSERT INTO t VALUES (1)", json!({ "readWrite": true })).await;
    assert_eq!(s.session.tx(), "transaction");
    s.query("q6", "SELECT 1", json!({})).await;
    assert_eq!(s.of("q6", "statementError")[0]["error"], "inTransaction");
    let end = s.query("q7", "COMMIT", json!({})).await;
    assert_eq!(end["ok"], true);
    assert_eq!(end["tx"], "idle");
    let log = s.log();
    let at = log.iter().rposition(|l| l == "COMMIT").unwrap();
    assert_eq!(log[at + 1], "SET default_transaction_read_only = on", "restored once the transaction ended");
    // an override inside a transaction is refused
    s.session.handle(&json!({ "op": "transaction", "action": "begin" })).await;
    s.query("q8", "INSERT INTO t VALUES (1)", json!({ "readWrite": true })).await;
    assert_eq!(s.of("q8", "statementError")[0]["error"], "inTransaction");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_servers_read_only_refusal_maps_to_read_only() {
    let s = setup(false, 0.0, None).await;
    let end = s
        .query(
            "q1",
            "SET default_transaction_read_only = on;\nINSERT INTO t VALUES (1);\nSELECT 1",
            json!({ "continueOnError": true }),
        )
        .await;
    assert_eq!(end["ok"], false);
    let err = s.of("q1", "statementError").remove(0);
    assert_eq!(err["error"], "readOnly");
    assert_eq!(err["server"]["code"], "25006");
    assert_eq!(s.of("q1", "statementEnd").len(), 2, "continueOnError ran the statement after it");
}

#[tokio::test(flavor = "multi_thread")]
async fn statement_timeouts_are_set_for_a_run_and_restored() {
    let s = setup(false, 0.0, None).await;
    s.query("q1", "SELECT 1", json!({ "statementTimeoutMs": 1500.9 })).await;
    let log = s.log();
    let at = log.iter().rposition(|l| l == "SELECT 1").unwrap();
    assert_eq!(log[at - 1], "SET statement_timeout = 1500");
    assert_eq!(log[at + 1], "RESET statement_timeout");
    let s = setup(false, 3000.0, None).await;
    s.query("q1", "SELECT 1", json!({ "statementTimeoutMs": 500 })).await;
    let log = s.log();
    let at = log.iter().rposition(|l| l == "SELECT 1").unwrap();
    assert_eq!((log[at - 1].as_str(), log[at + 1].as_str()), ("SET statement_timeout = 500", "SET statement_timeout = 3000"));
    let n = s.log().len();
    s.query("q2", "SELECT 1", json!({ "statementTimeoutMs": 3000 })).await;
    assert_eq!(s.log()[n..], ["SELECT 1".to_owned()], "the connection's own timeout is not set again");
    s.query("q3", "SELECT timeout", json!({ "statementTimeoutMs": 10 })).await;
    assert_eq!(s.of("q3", "statementError")[0]["error"], "statementTimeout");
}

#[tokio::test(flavor = "multi_thread")]
async fn server_errors_stop_the_script_unless_asked_to_go_on() {
    let s = setup(false, 0.0, None).await;
    let end = s.query("q1", "SELECT bad;\nSELECT 1", json!({})).await;
    assert_eq!(end["ok"], false);
    let err = s.of("q1", "statementError").remove(0);
    assert_eq!(
        err["server"],
        json!({ "message": "column \"bad\" does not exist", "code": "42703", "severity": "ERROR", "position": 8 })
    );
    assert_eq!(err["error"], "server");
    assert_eq!(s.of("q1", "statement").len(), 1);
    s.query("q2", "SELECT bad;\nSELECT 1", json!({ "continueOnError": true })).await;
    assert_eq!(s.of("q2", "statementEnd").len(), 1);
    assert_eq!(s.of("q2", "statementEnd")[0]["index"], 1);
    // unknown types are looked up once the result is read
    s.query("q3", "SELECT usertype", json!({})).await;
    let col = &s.of("q3", "columns")[0]["columns"][0];
    assert_eq!((col["typeName"].clone(), col["kind"].clone()), (json!("type_70000"), json!("other")));
}

#[tokio::test(flavor = "multi_thread")]
async fn cancel_stops_the_running_statement() {
    let s = setup(false, 0.0, None).await;
    assert_eq!(s.session.handle(&json!({ "op": "cancel" })).await, json!({ "ok": true, "value": false }));
    s.session.handle(&json!({ "op": "query", "req": { "queryId": "q1", "sql": "SELECT slow;\nSELECT 1" } })).await;
    s.wait("q1", "statement", 1).await;
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(s.session.handle(&json!({ "op": "cancel" })).await, json!({ "ok": true, "value": true }));
    let end = s.wait("q1", "queryEnd", 1).await.remove(0);
    assert_eq!((end["ok"].clone(), end["cancelled"].clone()), (json!(false), json!(true)));
    assert_eq!(s.of("q1", "statementError")[0]["error"], "cancelled");
    assert_eq!(s.of("q1", "statement").len(), 1, "the rest of the run is skipped");
    assert_eq!(s.fake.state.lock().cancels, 1);
    let end = s.query("q2", "SELECT 1", json!({})).await;
    assert_eq!(end["ok"], true, "the connection goes on");
}

#[tokio::test(flavor = "multi_thread")]
async fn transactions_notices_activity_and_the_end_of_the_connection() {
    let s = setup(false, 0.0, None).await;
    let r = s.session.handle(&json!({ "op": "transaction", "action": "begin" })).await;
    assert_eq!(r, json!({ "ok": true, "value": "transaction" }));
    let end = s.query("q1", "SELECT bad", json!({})).await;
    assert_eq!(end["tx"], "failed");
    let r = s.session.handle(&json!({ "op": "transaction", "action": "commit" })).await;
    assert_eq!(r, json!({ "ok": true, "value": "idle" }));
    assert_eq!(*s.out.tx.lock(), ["transaction", "failed", "idle"]);
    s.query("q2", "SELECT notice", json!({})).await;
    assert_eq!(
        s.of("q2", "notice"),
        [json!({ "t": "notice", "queryId": "q2", "message": "hello from the server", "severity": "NOTICE" })]
    );
    let activity = s.out.activity.lock().clone();
    assert!(activity.len() >= 2 && activity[0] && !activity[activity.len() - 1]);
    assert_eq!(s.session.handle(&json!({ "op": "tableInfo", "schema": "public", "name": "t" })).await["error"], "unsupported");
    // the server closes the connection after this one
    s.query("q3", "SELECT quit", json!({})).await;
    for _ in 0..300 {
        if *s.out.closed.lock() > 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(*s.out.closed.lock(), 1);
    assert_eq!(*s.out.fatal.lock(), 0);
    s.session.end();
    assert_eq!(s.session.handle(&json!({ "op": "cancel" })).await["error"], "noSession");
}
