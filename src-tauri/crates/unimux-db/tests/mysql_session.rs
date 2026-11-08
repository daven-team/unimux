//! D8: the MySQL / MariaDB session (unimux_db::mysql::MysqlSession, the port of 1.1.4 mysqlSession.ts) against an
//! in-process fake server: a run with a read and a write, the client-side read-only refusal, every result set of a CALL,
//! the open "load more" result with fetchMore, and a transaction operation. Real servers and the whole DbHost
//! (db-mysql-fake.int, Docker MySQL / MariaDB) are wave 7.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, duplex};
use tokio::sync::mpsc;
use unimux_db::mysql::session::{MyBoxConn, SideConnection};
use unimux_db::mysql::{MyConn, MyError, MyLogin, MyPortMessage, MysqlOptions, MysqlOut, MysqlSession};
use unimux_db::redis::connect::BoxStream;
use unimux_db::sql::mysql::Flavor;
use zeroize::Zeroizing;

const SCRAMBLE: [u8; 20] = *b"abcdefghijklmnopqrst";
const CLIENT_SSL: u32 = 0x800;
const CAPS: u32 = 0x0fff_ffff & !CLIENT_SSL;
const MORE_RESULTS: u16 = 0x0008;
const AUTOCOMMIT: u16 = 0x0002;
const IN_TRANS: u16 = 0x0001;

// ── a fake server ──

async fn read_frame<S: AsyncRead + Unpin>(s: &mut S) -> Option<(u8, Vec<u8>)> {
    let mut h = [0u8; 4];
    s.read_exact(&mut h).await.ok()?;
    let len = usize::from(h[0]) | usize::from(h[1]) << 8 | usize::from(h[2]) << 16;
    let mut p = vec![0u8; len];
    s.read_exact(&mut p).await.ok()?;
    Some((h[3], p))
}

async fn write_frame<S: AsyncWrite + Unpin>(s: &mut S, seq: u8, p: &[u8]) {
    let mut out = vec![(p.len() & 0xff) as u8, (p.len() >> 8 & 0xff) as u8, (p.len() >> 16) as u8, seq];
    out.extend_from_slice(p);
    let _ = s.write_all(&out).await;
    let _ = s.flush().await;
}

fn lenenc_str(out: &mut Vec<u8>, s: &[u8]) {
    assert!(s.len() < 251);
    out.push(s.len() as u8);
    out.extend_from_slice(s);
}

fn hello() -> Vec<u8> {
    let mut p = vec![10];
    p.extend_from_slice(b"8.0.36\0");
    p.extend_from_slice(&77u32.to_le_bytes());
    p.extend_from_slice(&SCRAMBLE[..8]);
    p.push(0);
    p.extend_from_slice(&(CAPS as u16).to_le_bytes());
    p.push(45);
    p.extend_from_slice(&2u16.to_le_bytes());
    p.extend_from_slice(&((CAPS >> 16) as u16).to_le_bytes());
    p.push(21);
    p.extend_from_slice(&[0u8; 10]);
    p.extend_from_slice(&SCRAMBLE[8..]);
    p.push(0);
    p.extend_from_slice(b"mysql_native_password\0");
    p
}

fn ok(affected: u8, status: u16) -> Vec<u8> {
    let mut p = vec![0, affected, 0];
    p.extend_from_slice(&status.to_le_bytes());
    p.extend_from_slice(&0u16.to_le_bytes());
    p
}

fn column(name: &str, charset: u16, kind: u8) -> Vec<u8> {
    let mut p = Vec::new();
    for s in ["def", "shop", "t", "t", name, name] {
        lenenc_str(&mut p, s.as_bytes());
    }
    p.push(0x0c);
    p.extend_from_slice(&charset.to_le_bytes());
    p.extend_from_slice(&255u32.to_le_bytes());
    p.push(kind);
    p.extend_from_slice(&[0, 0, 0, 0, 0]);
    p
}

fn eof(status: u16) -> Vec<u8> {
    let mut p = vec![0xfe, 0, 0];
    p.extend_from_slice(&status.to_le_bytes());
    p
}

/// A result set of `n` rows of (n, label), ending with `status`.
fn numbers(n: usize, status: u16) -> Vec<Vec<u8>> {
    let mut out = vec![vec![2], column("n", 63, 0x08), column("label", 45, 0xfd), eof(AUTOCOMMIT)];
    for i in 1..=n {
        let mut p = Vec::new();
        lenenc_str(&mut p, i.to_string().as_bytes());
        lenenc_str(&mut p, format!("row {i}").as_bytes());
        out.push(p);
    }
    out.push(eof(status));
    out
}

type Answer = Arc<dyn Fn(&str) -> Vec<Vec<u8>> + Send + Sync>;

/// A logged-in session connection to a server that answers every COM_QUERY with `answer` and records the statements.
async fn connect(answer: Answer, log: Arc<Mutex<Vec<String>>>) -> MyBoxConn {
    let (a, mut b) = duplex(1 << 20);
    tokio::spawn(async move {
        write_frame(&mut b, 0, &hello()).await;
        let Some((seq, _)) = read_frame(&mut b).await else { return };
        write_frame(&mut b, seq + 1, &ok(0, AUTOCOMMIT)).await;
        while let Some((_, q)) = read_frame(&mut b).await {
            if q.first() != Some(&0x03) {
                return; // COM_QUIT
            }
            // COM_QUERY with the empty query-attribute prefix
            let sql = String::from_utf8_lossy(&q[3..]).into_owned();
            log.lock().push(sql.clone());
            let mut seq = 1u8;
            for p in answer(&sql) {
                write_frame(&mut b, seq, &p).await;
                seq = seq.wrapping_add(1);
            }
        }
    });
    let login = MyLogin { user: "root".into(), password: Zeroizing::new(String::new()), database: "shop".into() };
    MyConn::connect(Box::new(a) as BoxStream, &login, None).await.unwrap()
}

// ── the session's reports ──

struct Out {
    port: mpsc::UnboundedSender<String>,
    main: Mutex<Vec<String>>,
}

impl MysqlOut for Out {
    fn port(&self, m: MyPortMessage) {
        let _ = self.port.send(m.to_json());
    }
    fn tx(&self, tx: &'static str) {
        self.main.lock().push(format!("tx {tx}"));
    }
    fn activity(&self, busy: bool) {
        self.main.lock().push(format!("activity {busy}"));
    }
    fn database(&self, name: String) {
        self.main.lock().push(format!("database {name}"));
    }
    fn fatal(&self, error: &'static str) {
        self.main.lock().push(format!("fatal {error}"));
    }
}

struct Harness {
    session: MysqlSession,
    port: mpsc::UnboundedReceiver<String>,
    out: Arc<Out>,
    log: Arc<Mutex<Vec<String>>>,
}

async fn harness(read_only: bool, answer: Answer) -> Harness {
    let log = Arc::new(Mutex::new(Vec::new()));
    let conn = connect(answer, log.clone()).await;
    let (tx, port) = mpsc::unbounded_channel();
    let out = Arc::new(Out { port: tx, main: Mutex::new(Vec::new()) });
    let side: SideConnection = Arc::new(|| Box::pin(async { Err(MyError::Closed) }));
    let session = MysqlSession::start(
        conn,
        MysqlOptions {
            read_only,
            statement_timeout_ms: 0,
            flavor: Flavor::Mysql,
            side_connection: side,
            cursor_idle_ms: 120_000,
            via_tunnel: false,
        },
        out.clone(),
    );
    Harness { session, port, out, log }
}

/// The message with its timeMs taken out (they depend on the clock).
fn untimed(m: &str) -> Value {
    let mut v: Value = serde_json::from_str(m).unwrap();
    if let Some(o) = v.as_object_mut() {
        o.remove("timeMs");
    }
    v
}

/// Port messages up to and including the first whose `t` is `last`.
async fn until(h: &mut Harness, last: &str) -> Vec<Value> {
    let mut out = Vec::new();
    loop {
        let m = tokio::time::timeout(Duration::from_secs(5), h.port.recv()).await.expect("port message").unwrap();
        let v = untimed(&m);
        let done = v["t"] == last;
        out.push(v);
        if done {
            return out;
        }
    }
}

fn default_answer(sql: &str) -> Vec<Vec<u8>> {
    if sql.starts_with("SELECT * FROM numbers") {
        return numbers(2, AUTOCOMMIT);
    }
    if sql.starts_with("UPDATE") {
        return vec![ok(1, AUTOCOMMIT)];
    }
    if sql.starts_with("START TRANSACTION") {
        return vec![ok(0, AUTOCOMMIT | IN_TRANS)];
    }
    vec![ok(0, AUTOCOMMIT)]
}

#[tokio::test]
async fn a_run_streams_a_read_and_a_write() {
    let mut h = harness(false, Arc::new(default_answer)).await;
    let r = h
        .session
        .handle(&json!({ "op": "query", "req": { "queryId": "q1", "sql": "SELECT * FROM numbers; UPDATE t SET a = 1" } }))
        .await;
    assert_eq!(r, json!({ "ok": true, "value": true }));
    let got = until(&mut h, "queryEnd").await;
    let kinds: Vec<&str> = got.iter().map(|m| m["t"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["statement", "columns", "rows", "statementEnd", "statement", "statementEnd", "queryEnd"]);
    assert_eq!(got[2]["rows"], json!([["1", "row 1"], ["2", "row 2"]]));
    assert_eq!(got[1]["columns"][0]["name"], "n");
    assert_eq!(
        got[3],
        json!({ "t": "statementEnd", "queryId": "q1", "index": 0, "command": "SELECT", "rowCount": 2, "rows": 2, "hasMore": false })
    );
    assert_eq!(got[5]["command"], "UPDATE");
    assert_eq!(got[5]["rowCount"], 1);
    assert_eq!(got[6], json!({ "t": "queryEnd", "queryId": "q1", "ok": true, "cancelled": false, "tx": "idle" }));
    // a result without an OK packet asks for the transaction state
    assert_eq!(*h.log.lock(), ["SELECT * FROM numbers", "DO 0", "UPDATE t SET a = 1"]);
    assert!(h.out.main.lock().iter().any(|m| m == "activity true"));
}

#[tokio::test]
async fn a_read_only_session_refuses_a_write_before_sending_it() {
    let mut h = harness(true, Arc::new(default_answer)).await;
    h.session.handle(&json!({ "op": "query", "req": { "queryId": "q", "sql": "SELECT 1; DELETE FROM t" } })).await;
    let got = until(&mut h, "queryEnd").await;
    assert_eq!(got[0], json!({ "t": "statementError", "queryId": "q", "index": 1, "error": "readOnly" }));
    assert_eq!(got[1]["ok"], false);
    assert!(h.log.lock().is_empty());
}

#[tokio::test]
async fn every_result_set_of_a_call_is_a_result() {
    let answer: Answer = Arc::new(|sql: &str| {
        if sql.starts_with("CALL") {
            let mut v = numbers(1, AUTOCOMMIT | MORE_RESULTS);
            v.extend(numbers(2, AUTOCOMMIT | MORE_RESULTS));
            v.push(ok(0, AUTOCOMMIT));
            return v;
        }
        default_answer(sql)
    });
    let mut h = harness(false, answer).await;
    h.session.handle(&json!({ "op": "query", "req": { "queryId": "c", "sql": "CALL p()" } })).await;
    let got = until(&mut h, "queryEnd").await;
    let kinds: Vec<String> = got.iter().map(|m| format!("{} {}", m["t"].as_str().unwrap(), m["index"])).collect();
    assert_eq!(
        kinds,
        [
            "statement 0",
            "columns 0",
            "rows 0",
            "statementEnd 0",
            "statement 1",
            "columns 1",
            "rows 1",
            "statementEnd 1",
            "queryEnd null"
        ]
    );
    assert_eq!(got[4]["set"], 2);
    assert_eq!(got[7]["command"], "CALL");
    assert_eq!(got[7]["rowCount"], 2);
    assert_eq!(got[8]["ok"], true);
    // the CALL's OK carried the state: no DO 0
    assert_eq!(*h.log.lock(), ["CALL p()"]);
}

#[tokio::test]
async fn the_last_read_stays_open_for_load_more() {
    let answer: Answer =
        Arc::new(|sql: &str| if sql.starts_with("SELECT") { numbers(5, AUTOCOMMIT) } else { default_answer(sql) });
    let mut h = harness(false, answer).await;
    h.session.handle(&json!({ "op": "query", "req": { "queryId": "o", "sql": "SELECT * FROM big", "rowCap": 2 } })).await;
    let got = until(&mut h, "queryEnd").await;
    assert_eq!(got[2]["rows"], json!([["1", "row 1"], ["2", "row 2"]]));
    assert_eq!(got[3]["hasMore"], true);
    assert_eq!(got[3]["rowCount"], Value::Null);
    assert!(h.session.busy(), "the open result holds the connection");
    // another query id has nothing open
    let r = h.session.handle(&json!({ "op": "fetchMore", "queryId": "x", "count": 10 })).await;
    assert_eq!(r, json!({ "ok": false, "error": "notFound" }));
    let r = h.session.handle(&json!({ "op": "fetchMore", "queryId": "o", "count": 10 })).await;
    assert_eq!(r, json!({ "ok": true, "value": true }));
    let got = until(&mut h, "statementEnd").await;
    assert_eq!(got[0]["rows"], json!([["3", "row 3"], ["4", "row 4"], ["5", "row 5"]]));
    assert_eq!(got[1]["rows"], 5);
    assert_eq!(got[1]["rowCount"], 5);
    assert_eq!(got[1]["hasMore"], false);
    let r = h.session.handle(&json!({ "op": "fetchMore", "queryId": "o", "count": 10 })).await;
    assert_eq!(r, json!({ "ok": false, "error": "notFound" }));
}

#[tokio::test]
async fn a_transaction_operation_reports_the_state() {
    let h = harness(false, Arc::new(default_answer)).await;
    let r = h.session.handle(&json!({ "op": "transaction", "action": "begin" })).await;
    assert_eq!(r, json!({ "ok": true, "value": "transaction" }));
    assert_eq!(h.session.tx(), "transaction");
    assert!(h.out.main.lock().iter().any(|m| m == "tx transaction"));
    h.session.end();
    let r = h.session.handle(&json!({ "op": "databases" })).await;
    assert_eq!(r, json!({ "ok": false, "error": "noSession" }));
}
