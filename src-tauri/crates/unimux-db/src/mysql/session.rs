//! One connected MySQL / MariaDB session (1.1.4 src/dbhost/mysqlSession.ts), the counterpart of the Postgres and SQLite
//! sessions. A task owns the connection and runs the session's operations one at a time; it streams rows over the DB port
//! in bounded batches, keeps at most one read-only result open for "load more" (a streaming result holds the connection,
//! so it is stopped with KILL QUERY when something else needs it or after DB_LIMITS.cursorIdleMs), refuses writes on
//! read-only connections on the client side too (the session's transactions are READ ONLY as well), learns the transaction
//! state from the server status of OK packets, cancels with KILL QUERY on a side connection, reads every result set of a
//! CALL (with caps), reports SHOW WARNINGS as notices and a USE as the new default database, and applies staged edits in one
//! transaction. Every value is the server's text, bytes as "\x..." hex.
//!
//! Between operations the task watches the idle connection, so a server that drops it ends the session (mysql2's 'error' /
//! 'end' handlers of host.ts).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;

use super::conn::{MyConn, MyEvent, MyExec, MyOk};
use super::error::{DbServerError, MyError, server_error};
use super::meta::{self, MetaError, MyQuery, MyRow, TableInfo};
use super::packet::RawRow;
use super::port::{MyPortColumn, MyPortMessage, server_value};
use super::stream::MyStream;
use crate::model::js_truthy;
use crate::redis::connect::BoxStream;
use crate::sql::mysql::{
    BuiltStatement, ColumnMeta, FieldLike, Flavor, mysql_binary_type, mysql_cell_sql, mysql_edit_preview, mysql_edit_statements,
    mysql_ends_transaction, mysql_error_position, mysql_field_binary, mysql_field_kind, mysql_is_read_statement, mysql_is_use,
    mysql_page_sql, mysql_read_only_allows, mysql_timeout_sql,
};
use crate::sql::pg::first_keyword;
use crate::sql::split::{SqlSpan, split_sql};
use crate::sql::{DbSqlError, Dialect, EditOp, PageSqlInput, Sort, StagedEdit, js_fields, limits};
use crate::wire::mysql::MyColumn;
use crate::wire::value::{DbValue, hex_text, node_utf8, server_text, to_value, utf16_head};

const ER_QUERY_INTERRUPTED: u16 = 1317;
const ER_QUERY_TIMEOUT: u16 = 3024;
const ER_STATEMENT_TIMEOUT: u16 = 1969;
const ER_READ_ONLY_TRANSACTION: u16 = 1792;
/// The result sets a CALL shows at most (more are counted in a notice).
pub const CALL_MAX_SETS: usize = 50;
/// What a CALL may keep in memory over all its result sets together (the rest is counted as dropped).
pub const CALL_MAX_BYTES: usize = 64 * 1024 * 1024;
/// How long a stopped statement may take to end before the connection is given up.
const DRAIN_WAIT: Duration = Duration::from_secs(30);
/// A cached table description is used this long (table pages and cells).
const INFO_TTL: Duration = Duration::from_secs(30);

/// The connection the session runs on.
pub type MyBoxConn = MyConn<BoxStream>;

/// A second connection to the same server (for KILL QUERY); the session closes it.
pub type SideConnection = Arc<dyn Fn() -> BoxFuture<'static, Result<MyBoxConn, MyError>> + Send + Sync>;

/// What the session reports (the host forwards it: port messages to the window's port, the rest to main).
pub trait MysqlOut: Send + Sync {
    fn port(&self, m: MyPortMessage);
    /// `dbTx`: "idle" or "transaction".
    fn tx(&self, tx: &'static str);
    /// `dbActivity`.
    fn activity(&self, busy: bool);
    /// `dbDatabase`: USE switched the default database.
    fn database(&self, name: String);
    /// The session cannot go on: `dbFailed` (a setting could not be restored, a stopped result never ended), `dbClosed` /
    /// `tunnel` (the connection dropped). The host ends it.
    fn fatal(&self, error: &'static str);
}

/// `MysqlSessionOptions`.
#[derive(Clone)]
pub struct MysqlOptions {
    pub read_only: bool,
    /// The connection's statement timeout (ms; 0: the server's).
    pub statement_timeout_ms: u64,
    pub flavor: Flavor,
    pub side_connection: SideConnection,
    pub cursor_idle_ms: u64,
    /// The connection runs through an SSH tunnel (a dropped connection reads `tunnel`).
    pub via_tunnel: bool,
}

fn ok(value: Value) -> Value {
    json!({ "ok": true, "value": value })
}

fn fail(error: &str, server: Option<&DbServerError>, index: Option<usize>) -> Value {
    let mut v = json!({ "ok": false, "error": error });
    if let Some(s) = server {
        v["server"] = server_value(s);
    }
    if let Some(i) = index {
        v["index"] = json!(i);
    }
    v
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn num_of(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

/// A table page request as `mysqlPageSql` reads it; an `after` holding a non-string is refused.
fn page_input(v: &Value) -> Result<PageSqlInput, DbSqlError> {
    let after = match v.get("after") {
        Some(Value::Array(items)) => {
            Some(items.iter().map(|x| x.as_str().map(str::to_owned).ok_or(DbSqlError::Invalid)).collect::<Result<Vec<_>, _>>()?)
        }
        _ => None,
    };
    let sort = v.get("sort").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .map(|x| Sort {
                column: str_of(x, "column").to_owned(),
                desc: x.get("desc").and_then(Value::as_bool).unwrap_or(false),
            })
            .collect()
    });
    Ok(PageSqlInput {
        schema: str_of(v, "schema").to_owned(),
        table: str_of(v, "table").to_owned(),
        limit: num_of(v, "limit").unwrap_or(f64::NAN),
        offset: num_of(v, "offset"),
        after,
        sort,
        filter: v.get("filter").and_then(Value::as_str).map(str::to_owned),
    })
}

fn field_like(f: &MyColumn) -> FieldLike {
    FieldLike {
        column_type: i64::from(f.column_type),
        character_set: i64::from(f.character_set),
        flags: i64::from(f.flags),
        extended_type_name: f.extended_type_name.clone(),
        extended_format: f.extended_format.clone(),
    }
}

/// `decoders`: which columns are kept as bytes (shown as hex).
fn binary_flags(fields: &[MyColumn]) -> Vec<bool> {
    fields.iter().map(|f| mysql_field_binary(&field_like(f))).collect()
}

fn port_columns(fields: &[MyColumn]) -> Vec<MyPortColumn> {
    fields
        .iter()
        .map(|f| {
            let (kind, type_name) = mysql_field_kind(&field_like(f));
            MyPortColumn { name: f.name.clone(), type_oid: f.column_type, type_name, kind: kind.as_str() }
        })
        .collect()
}

/// `toValue` of every cell of a row (a cell past the known fields is text).
fn row_values(row: &RawRow, binary: &[bool]) -> Vec<DbValue> {
    row.cells().enumerate().map(|(i, c)| to_value(c, binary.get(i).copied().unwrap_or(false))).collect()
}

fn tx_of(h: &MyOk) -> &'static str {
    if h.in_transaction() { "transaction" } else { "idle" }
}

/// Why an operation failed.
#[derive(Debug, Clone, PartialEq)]
enum Fail {
    My(MyError),
    Sql(DbSqlError),
    /// The session ended itself (`fatal`).
    Fatal,
    /// A CALL failed after some of its result sets were shown: the error goes to a result of its own (`index`).
    Call {
        error: MyError,
        index: usize,
    },
}

impl From<MyError> for Fail {
    fn from(e: MyError) -> Self {
        Fail::My(e)
    }
}

impl From<MetaError> for Fail {
    fn from(e: MetaError) -> Self {
        match e {
            MetaError::My(e) => Fail::My(e),
            MetaError::Sql(e) => Fail::Sql(e),
        }
    }
}

impl Fail {
    fn my(&self) -> Option<&MyError> {
        match self {
            Fail::My(e) | Fail::Call { error: e, .. } => Some(e),
            _ => None,
        }
    }

    /// `mysqlServerError`.
    fn server(&self) -> Option<DbServerError> {
        self.my().and_then(server_error)
    }
}

enum Job {
    Query(Value),
    Page(Value),
    FetchMore {
        query_id: String,
        count: f64,
    },
    CloseResult {
        query_id: String,
        reply: oneshot::Sender<Value>,
    },
    Meta {
        op: Value,
        reply: oneshot::Sender<Value>,
    },
    /// The open result's idle timer fired.
    Idle {
        seq: u64,
    },
}

impl Job {
    fn is_run(&self) -> bool {
        matches!(self, Job::Query(_) | Job::Page(_) | Job::FetchMore { .. })
    }
}

/// The open result as the operations see it (the stream itself is the task's).
struct OpenMark {
    seq: u64,
    query_id: String,
    timer: Option<JoinHandle<()>>,
}

struct St {
    tx: &'static str,
    pending: usize,
    runs: usize,
    meta_pending: usize,
    open: Option<OpenMark>,
    run: Option<Arc<AtomicBool>>,
    /// A statement is on the server (a cancel has something to stop).
    in_flight: bool,
    cancel_requested: bool,
    ended: bool,
    /// Something was on the connection when the session ended: it is cut instead of a COM_QUIT.
    busy_at_end: bool,
    open_seq: u64,
}

struct Shared {
    opts: MysqlOptions,
    out: Arc<dyn MysqlOut>,
    st: Mutex<St>,
    jobs: mpsc::UnboundedSender<Job>,
    end: watch::Sender<bool>,
    /// The server's thread id of the connection (KILL QUERY).
    thread_id: u32,
    born: Instant,
}

impl Shared {
    fn now(&self) -> u64 {
        self.born.elapsed().as_millis() as u64
    }

    fn since(&self, t0: u64) -> u64 {
        self.now().saturating_sub(t0)
    }

    fn ended(&self) -> bool {
        self.st.lock().ended
    }

    fn tx(&self) -> &'static str {
        self.st.lock().tx
    }

    fn port(&self, m: MyPortMessage) {
        self.out.port(m);
    }

    fn enqueue(&self, job: Job) {
        let first = {
            let mut st = self.st.lock();
            st.pending += 1;
            if job.is_run() {
                st.runs += 1;
            }
            st.pending == 1
        };
        if first {
            self.out.activity(true);
        }
        let _ = self.jobs.send(job);
    }

    fn job_done(&self, run: bool) {
        let idle = {
            let mut st = self.st.lock();
            st.pending = st.pending.saturating_sub(1);
            if run {
                st.runs = st.runs.saturating_sub(1);
            }
            st.pending == 0
        };
        if idle {
            self.out.activity(false);
        }
    }

    /// `codeOf`.
    fn code_of(&self, error: &Fail) -> &'static str {
        let st = self.st.lock();
        match error.my().and_then(MyError::errno) {
            None => {
                if st.ended {
                    "noSession"
                } else {
                    "dbClosed"
                }
            }
            Some(ER_QUERY_INTERRUPTED) => "cancelled",
            Some(ER_QUERY_TIMEOUT | ER_STATEMENT_TIMEOUT) => {
                if st.cancel_requested {
                    "cancelled"
                } else {
                    "statementTimeout"
                }
            }
            Some(ER_READ_ONLY_TRANSACTION) => "readOnly",
            Some(_) => "server",
        }
    }

    /// The code a run reports for an error that ended it (`this.ended ? 'dbFailed' : this.codeOf(error)`).
    fn end_code(&self, error: &Fail) -> &'static str {
        if self.ended() { "dbFailed" } else { self.code_of(error) }
    }

    fn set_cancel_requested(&self, v: bool) {
        self.st.lock().cancel_requested = v;
    }

    fn flight(&self, on: bool) {
        self.st.lock().in_flight = on;
    }

    /// KILL QUERY of this connection's thread on a side connection (stops the running statement, keeps the connection).
    async fn kill(&self) -> bool {
        let Ok(mut side) = (self.opts.side_connection)().await else { return false };
        let r = side.exec(&format!("KILL QUERY {}", self.thread_id)).await;
        tokio::spawn(side.quit(Duration::from_secs(2)));
        r.is_ok()
    }

    async fn cancel(&self) -> bool {
        {
            let mut st = self.st.lock();
            if let Some(r) = &st.run {
                r.store(true, Ordering::SeqCst);
            }
            if !st.in_flight {
                return false;
            }
            st.cancel_requested = true;
        }
        self.kill().await
    }

    /// Clears the open result's mark (and its timer) when it is still `seq`.
    fn clear_open(&self, seq: u64) {
        let mut st = self.st.lock();
        if st.open.as_ref().is_some_and(|o| o.seq == seq)
            && let Some(o) = st.open.take()
            && let Some(t) = o.timer
        {
            t.abort();
        }
    }

    /// The connection dropped between or during operations.
    fn lost(&self, e: &MyError) {
        if self.ended() {
            return;
        }
        let code = match e {
            MyError::Closed => "dbClosed",
            _ if self.opts.via_tunnel => "tunnel",
            _ => "dbClosed",
        };
        self.out.fatal(code);
    }
}

/// One MySQL / MariaDB session. Create it inside a tokio runtime ([`MysqlSession::start`]).
#[derive(Clone)]
pub struct MysqlSession {
    sh: Arc<Shared>,
}

impl MysqlSession {
    /// Starts the session's task on the connection (logged in, its settings applied).
    pub fn start(conn: MyBoxConn, opts: MysqlOptions, out: Arc<dyn MysqlOut>) -> MysqlSession {
        let (jobs, rx) = mpsc::unbounded_channel();
        let (end, end_rx) = watch::channel(false);
        let sh = Arc::new(Shared {
            thread_id: conn.connection_id,
            opts,
            out,
            st: Mutex::new(St {
                tx: if conn.in_transaction() { "transaction" } else { "idle" },
                pending: 0,
                runs: 0,
                meta_pending: 0,
                open: None,
                run: None,
                in_flight: false,
                cancel_requested: false,
                ended: false,
                busy_at_end: false,
                open_seq: 0,
            }),
            jobs,
            end,
            born: Instant::now(),
        });
        let worker = Worker {
            sh: sh.clone(),
            conn: Some(conn),
            open: None,
            keys: HashMap::new(),
            restore: Vec::new(),
            override_active: false,
        };
        tokio::spawn(worker.run(rx, end_rx));
        MysqlSession { sh }
    }

    /// One operation (`DbHostOp` without redis); the answer is a `DbResult`. A run answers once accepted; its rows go to the
    /// port.
    pub fn handle(&self, op: &Value) -> BoxFuture<'static, Value> {
        let ready = |v: Value| -> BoxFuture<'static, Value> { Box::pin(async move { v }) };
        let sh = &self.sh;
        if sh.ended() {
            return ready(fail("noSession", None, None));
        }
        let req = op.get("req").cloned().unwrap_or(Value::Null);
        match str_of(op, "op") {
            "cancel" => {
                let sh = sh.clone();
                Box::pin(async move { ok(json!(sh.cancel().await)) })
            }
            "query" => {
                sh.enqueue(Job::Query(req));
                ready(ok(json!(true)))
            }
            "tablePage" => {
                sh.enqueue(Job::Page(req));
                ready(ok(json!(true)))
            }
            "fetchMore" => {
                let query_id = str_of(op, "queryId").to_owned();
                {
                    let mut st = sh.st.lock();
                    match st.open.as_mut() {
                        Some(o) if o.query_id == query_id => {
                            if let Some(t) = o.timer.take() {
                                t.abort();
                            }
                        }
                        _ => return ready(fail("notFound", None, None)),
                    }
                }
                sh.enqueue(Job::FetchMore { query_id, count: num_of(op, "count").unwrap_or(f64::NAN) });
                ready(ok(json!(true)))
            }
            "closeResult" => {
                let (reply, rx) = oneshot::channel();
                sh.enqueue(Job::CloseResult { query_id: str_of(op, "queryId").to_owned(), reply });
                Box::pin(async move { rx.await.unwrap_or_else(|_| fail("dbFailed", None, None)) })
            }
            "redis" => ready(fail("invalid", None, None)),
            _ => {
                {
                    let mut st = sh.st.lock();
                    if st.runs > 0 || st.meta_pending >= 4 {
                        return ready(fail("busy", None, None));
                    }
                    st.meta_pending += 1;
                }
                let (reply, rx) = oneshot::channel();
                sh.enqueue(Job::Meta { op: op.clone(), reply });
                Box::pin(async move { rx.await.unwrap_or_else(|_| fail("dbFailed", None, None)) })
            }
        }
    }

    /// Ends the session: the run stops; an idle connection says goodbye (COM_QUIT), one with a statement or an open result
    /// on it is cut.
    pub fn end(&self) {
        {
            let mut st = self.sh.st.lock();
            st.busy_at_end = st.in_flight || st.open.is_some() || st.pending > 0;
            st.ended = true;
            if let Some(r) = &st.run {
                r.store(true, Ordering::SeqCst);
            }
            if let Some(t) = st.open.as_mut().and_then(|o| o.timer.take()) {
                t.abort();
            }
        }
        let _ = self.sh.end.send(true);
    }

    /// Something is on the connection (a statement, an open result) or operations wait.
    pub fn busy(&self) -> bool {
        let st = self.sh.st.lock();
        st.in_flight || st.open.is_some() || st.pending > 0
    }

    /// The transaction state ("idle" or "transaction").
    pub fn tx(&self) -> &'static str {
        self.sh.tx()
    }
}

/// The open result: a read whose rows were not all sent.
struct OpenStream {
    seq: u64,
    query_id: String,
    index: usize,
    stream: MyStream,
    binary: Vec<bool>,
    sent: u64,
}

#[derive(Default)]
struct PumpState {
    columns_sent: bool,
    binary: Option<Vec<bool>>,
}

/// The session's task: the connection and what only the task touches.
struct Worker {
    sh: Arc<Shared>,
    /// Always Some while the task runs (taken for the final COM_QUIT).
    conn: Option<MyBoxConn>,
    open: Option<OpenStream>,
    keys: HashMap<String, (Instant, Option<Arc<TableInfo>>)>,
    /// Settings a run changed (read-only override, statement timeout); restored once no transaction or result is open.
    restore: Vec<String>,
    override_active: bool,
}

enum Ev {
    Job(Job),
    End,
    Closed(MyError),
}

impl MyQuery for Worker {
    fn q<'a>(&'a mut self, sql: &'a str) -> BoxFuture<'a, Result<Vec<MyRow>, MetaError>> {
        Box::pin(async move { self.meta(sql).await.map_err(MetaError::My) })
    }
}

impl Worker {
    fn conn(&mut self) -> &mut MyBoxConn {
        self.conn.as_mut().expect("the connection is the task's until it ends")
    }

    async fn run(mut self, mut rx: mpsc::UnboundedReceiver<Job>, mut end_rx: watch::Receiver<bool>) {
        loop {
            let ev = {
                let watch_idle = self.open.is_none() && self.conn.as_ref().is_some_and(|c| c.is_idle());
                let conn = self.conn.as_mut().expect("connection");
                tokio::select! {
                    biased;
                    _ = end_rx.wait_for(|e| *e) => Ev::End,
                    j = rx.recv() => match j { Some(j) => Ev::Job(j), None => Ev::End },
                    e = conn.closed(), if watch_idle => Ev::Closed(e),
                }
            };
            match ev {
                Ev::End => break,
                Ev::Closed(e) => {
                    self.sh.lost(&e);
                    break;
                }
                Ev::Job(job) => {
                    let run = job.is_run();
                    let ended = {
                        let fut = self.job(job);
                        tokio::select! {
                            biased;
                            _ = fut => false,
                            _ = end_rx.wait_for(|e| *e) => true,
                        }
                    };
                    self.sh.job_done(run);
                    if ended {
                        break;
                    }
                    if let Some(e) = self.conn.as_ref().and_then(|c| c.broken()).cloned() {
                        self.sh.lost(&e);
                        break;
                    }
                }
            }
        }
        if let Some(open) = self.open.take() {
            self.sh.clear_open(open.seq);
        }
        let busy = self.sh.st.lock().busy_at_end;
        if let Some(conn) = self.conn.take()
            && !busy
            && conn.is_idle()
            && conn.broken().is_none()
        {
            conn.quit(Duration::from_secs(2)).await;
        }
    }

    async fn job(&mut self, job: Job) {
        match job {
            Job::Query(req) => self.run_query(&req).await,
            Job::Page(req) => self.run_page(&req).await,
            Job::FetchMore { query_id, count } => self.fetch_more(&query_id, count).await,
            Job::CloseResult { query_id, reply } => {
                let r: Result<(), Fail> = async {
                    if self.open.as_ref().is_some_and(|o| o.query_id == query_id) {
                        self.close_open().await?;
                        self.settle().await?;
                    }
                    Ok(())
                }
                .await;
                let _ = reply.send(match r {
                    Ok(()) => ok(json!(true)),
                    Err(_) => fail("dbFailed", None, None),
                });
            }
            Job::Meta { op, reply } => {
                let r: Result<Value, Fail> = async {
                    self.close_open().await?;
                    self.settle().await?;
                    self.meta_op(&op).await
                }
                .await;
                {
                    let mut st = self.sh.st.lock();
                    st.meta_pending = st.meta_pending.saturating_sub(1);
                }
                let v = match r {
                    Ok(v) => v,
                    Err(Fail::Sql(e)) => fail(e.code(), None, None),
                    Err(e) => fail(self.sh.end_code(&e), e.server().as_ref(), None),
                };
                let _ = reply.send(v);
            }
            Job::Idle { seq } => {
                if self.open.as_ref().is_some_and(|o| o.seq == seq) && self.close_open().await.is_ok() {
                    let _ = self.settle().await;
                }
            }
        }
    }

    // ── plumbing ───────────────────────────────────────────────────────────────

    fn set_tx(&self, header: &MyOk) {
        let tx = tx_of(header);
        let changed = {
            let mut st = self.sh.st.lock();
            std::mem::replace(&mut st.tx, tx) != tx
        };
        if changed {
            self.sh.out.tx(tx);
        }
    }

    /// One statement read whole (metadata, settings, edits); its OK packet updates the transaction state.
    async fn exec(&mut self, sql: &str) -> Result<MyExec, MyError> {
        let r = self.conn().exec(sql).await?;
        if let Some(h) = &r.header {
            self.set_tx(h);
        }
        Ok(r)
    }

    /// Rows of a catalog read, every value as text.
    async fn meta(&mut self, sql: &str) -> Result<Vec<MyRow>, MyError> {
        let r = self.exec(sql).await?;
        Ok(r.rows.iter().map(|row| row.cells().map(|c| c.map(node_utf8)).collect()).collect())
    }

    /// The transaction state after a statement that answered with rows (only OK packets carry it).
    async fn sync_tx(&mut self) -> Result<(), MyError> {
        self.exec("DO 0").await.map(|_| ())
    }

    fn fatal<T>(&self) -> Result<T, Fail> {
        self.sh.st.lock().ended = true;
        self.sh.out.fatal("dbFailed");
        Err(Fail::Fatal)
    }

    async fn must(&mut self, sql: &str) -> Result<(), Fail> {
        match self.exec(sql).await {
            Ok(_) => Ok(()),
            Err(_) => self.fatal(),
        }
    }

    async fn settle(&mut self) -> Result<(), Fail> {
        if self.sh.tx() != "idle" || self.open.is_some() || self.restore.is_empty() {
            return Ok(());
        }
        let restore = std::mem::take(&mut self.restore);
        for sql in restore {
            self.must(&sql).await?;
        }
        self.override_active = false;
        Ok(())
    }

    /// Ends a stream before the connection is used again: a read is stopped on the server (KILL QUERY), anything else
    /// runs to its end.
    async fn stop(&mut self, stream: &mut MyStream, kill: bool) -> Result<(), Fail> {
        if stream.done {
            return Ok(());
        }
        // The KILL is answered before anything else goes out on this connection: a kill that lands after the statement
        // ended is reset by the server when the next command starts, so it can never hit a later statement.
        if kill {
            self.sh.set_cancel_requested(true);
            self.sh.kill().await;
        }
        if !stream.drain(self.conn(), DRAIN_WAIT).await {
            return self.fatal();
        }
        Ok(())
    }

    fn send_rows(&self, query_id: &str, index: usize, rows: Vec<Vec<DbValue>>) -> usize {
        let mut chunk: Vec<Vec<DbValue>> = Vec::new();
        let mut chars = 0usize;
        let mut total = 0usize;
        for row in rows {
            chars += row.iter().map(DbValue::batch_chars).sum::<usize>();
            chunk.push(row);
            if chunk.len() >= limits::CHUNK_ROWS || chars >= limits::CHUNK_CHARS {
                self.sh.port(MyPortMessage::Rows { query_id: query_id.to_owned(), index, rows: std::mem::take(&mut chunk) });
                total += chars;
                chars = 0;
            }
        }
        if !chunk.is_empty() {
            self.sh.port(MyPortMessage::Rows { query_id: query_id.to_owned(), index, rows: chunk });
        }
        total + chars
    }

    fn send_columns(&self, query_id: &str, index: usize, stream: &MyStream, state: &mut PumpState) {
        if state.columns_sent {
            return;
        }
        let Some(fields) = &stream.fields else { return };
        state.columns_sent = true;
        state.binary = Some(binary_flags(fields));
        if !fields.is_empty() {
            self.sh.port(MyPortMessage::Columns { query_id: query_id.to_owned(), index, columns: port_columns(fields) });
        }
    }

    /// Sends up to `max` rows in batches, stopping early at about DB_LIMITS.pageChars characters; the columns go first.
    async fn pump(
        &mut self,
        query_id: &str,
        index: usize,
        stream: &mut MyStream,
        max: usize,
        state: &mut PumpState,
    ) -> Result<u64, Fail> {
        let mut sent = 0usize;
        let mut chars = 0usize;
        let mut batch = 100usize;
        while sent < max && chars < limits::PAGE_CHARS {
            let want = batch.min(max - sent);
            self.sh.flight(true);
            let raw = stream.take(self.conn(), want).await;
            self.sh.flight(false);
            let raw = raw?;
            self.send_columns(query_id, index, stream, state);
            if raw.is_empty() {
                break;
            }
            let binary = state.binary.clone().unwrap_or_default();
            let rows: Vec<Vec<DbValue>> = raw.iter().map(|r| row_values(r, &binary)).collect();
            chars += self.send_rows(query_id, index, rows);
            sent += raw.len();
            let per_row = (chars as f64 / sent as f64).max(1.0);
            batch = ((limits::CHUNK_CHARS as f64 / per_row).floor() as usize).clamp(1, limits::CHUNK_ROWS);
            // Fewer than asked for: the statement ended.
            if raw.len() < want {
                break;
            }
        }
        self.send_columns(query_id, index, stream, state);
        Ok(sent as u64)
    }

    async fn more(&mut self, stream: &mut MyStream) -> bool {
        self.sh.flight(true);
        let more = stream.more(self.conn()).await;
        self.sh.flight(false);
        more
    }

    fn arm_idle(&self, seq: u64) {
        let sh = Arc::downgrade(&self.sh);
        let wait = Duration::from_millis(self.sh.opts.cursor_idle_ms);
        let handle = tokio::spawn(async move {
            tokio::time::sleep(wait).await;
            if let Some(sh) = sh.upgrade() {
                sh.enqueue(Job::Idle { seq });
            }
        });
        let mut st = self.sh.st.lock();
        match st.open.as_mut() {
            Some(o) if o.seq == seq => {
                if let Some(old) = o.timer.replace(handle) {
                    old.abort();
                }
            }
            _ => handle.abort(),
        }
    }

    async fn close_open(&mut self) -> Result<(), Fail> {
        let Some(mut open) = self.open.take() else { return Ok(()) };
        self.sh.clear_open(open.seq);
        self.stop(&mut open.stream, true).await?;
        self.sh.set_cancel_requested(false);
        self.sh.port(MyPortMessage::ResultClosed { query_id: open.query_id, index: open.index });
        Ok(())
    }

    // ── operations ─────────────────────────────────────────────────────────────

    async fn meta_op(&mut self, op: &Value) -> Result<Value, Fail> {
        let schema = str_of(op, "schema");
        match str_of(op, "op") {
            "databases" => Ok(ok(meta::list_databases(self).await?)),
            "schemas" => Ok(ok(meta::list_schemas(self).await?)),
            "objects" => Ok(ok(meta::list_objects(self, schema).await?)),
            "tableInfo" => Ok(match meta::table_info(self, schema, str_of(op, "name")).await? {
                Some(info) => ok(info.to_json()),
                None => fail("notFound", None, None),
            }),
            "ddl" => Ok(match meta::object_ddl(self, schema, str_of(op, "name"), str_of(op, "kind")).await? {
                Some(ddl) => ok(json!(ddl)),
                None => fail("notFound", None, None),
            }),
            "transaction" => {
                let sql = match str_of(op, "action") {
                    "begin" => "START TRANSACTION",
                    "commit" => "COMMIT",
                    _ => "ROLLBACK",
                };
                self.exec(sql).await?;
                self.settle().await?;
                Ok(ok(json!(self.sh.tx())))
            }
            "previewEdits" => Ok(match self.build_edits(op.get("req").unwrap_or(&Value::Null)).await? {
                Err(v) => v,
                Ok(statements) => ok(json!({ "sql": mysql_edit_preview(&statements), "statements": statements.len() })),
            }),
            "applyEdits" => self.apply_edits(op.get("req").unwrap_or(&Value::Null)).await,
            "cellValue" => self.cell_value(op.get("req").unwrap_or(&Value::Null)).await,
            _ => Ok(fail("invalid", None, None)),
        }
    }

    // ── queries ────────────────────────────────────────────────────────────────

    fn begin_run(&self) -> Arc<AtomicBool> {
        let run = Arc::new(AtomicBool::new(false));
        let mut st = self.sh.st.lock();
        st.run = Some(run.clone());
        st.cancel_requested = false;
        run
    }

    fn end_run(&self, run: &Arc<AtomicBool>) {
        let mut st = self.sh.st.lock();
        if st.run.as_ref().is_some_and(|r| Arc::ptr_eq(r, run)) {
            st.run = None;
        }
        st.cancel_requested = false;
    }

    fn statement_error(&self, query_id: &str, index: usize, error: &'static str, server: Option<DbServerError>, t0: u64) {
        self.sh.port(MyPortMessage::StatementError {
            query_id: query_id.to_owned(),
            index,
            error,
            server,
            time_ms: self.sh.since(t0),
        });
    }

    async fn run_query(&mut self, req: &Value) {
        let started = self.sh.now();
        let query_id = str_of(req, "queryId").to_owned();
        let run = self.begin_run();
        let mut all_ok = true;
        if let Err(error) = self.query_body(req, &query_id, &run, started, &mut all_ok).await {
            all_ok = false;
            self.statement_error(&query_id, 0, self.sh.end_code(&error), error.server(), started);
        }
        if !self.sh.ended() && self.settle().await.is_err() {
            all_ok = false;
        }
        self.end_run(&run);
        let cancelled = run.load(Ordering::SeqCst);
        self.sh.port(MyPortMessage::QueryEnd {
            query_id,
            ok: all_ok && !cancelled,
            cancelled,
            time_ms: self.sh.since(started),
            tx: self.sh.tx(),
        });
    }

    async fn query_body(
        &mut self,
        req: &Value,
        query_id: &str,
        run: &AtomicBool,
        started: u64,
        all_ok: &mut bool,
    ) -> Result<(), Fail> {
        let read_only = self.sh.opts.read_only;
        let override_ = req.get("readWrite") == Some(&Value::Bool(true)) && read_only;
        self.close_open().await?;
        self.settle().await?;
        let spans = split_sql(str_of(req, "sql"), Dialect::Mysql);
        let cap = num_of(req, "rowCap").filter(|n| !n.is_nan()).unwrap_or(limits::ROW_CAP as f64).floor();
        let row_cap = cap.min(limits::ROW_CAP_MAX as f64).max(1.0) as usize;
        if read_only && !override_ {
            if self.override_active && !spans.iter().all(|s| mysql_ends_transaction(&s.text)) {
                *all_ok = false;
                self.statement_error(query_id, 0, "inTransaction", None, started);
                return Ok(());
            }
            if let Some(bad) = spans.iter().position(|s| !mysql_read_only_allows(&s.text)) {
                *all_ok = false;
                self.statement_error(query_id, bad, "readOnly", None, started);
                return Ok(());
            }
        }
        if override_ {
            if self.sh.tx() != "idle" {
                *all_ok = false;
                self.statement_error(query_id, 0, "inTransaction", None, started);
                return Ok(());
            }
            self.exec("SET SESSION TRANSACTION READ WRITE").await?;
            self.override_active = true;
            self.restore.push("SET SESSION TRANSACTION READ ONLY".into());
        }
        let own = self.sh.opts.statement_timeout_ms;
        if let Some(t) = num_of(req, "statementTimeoutMs")
            && t != own as f64
        {
            let ms = t.floor().min(limits::STATEMENT_TIMEOUT_MAX_MS as f64).max(0.0);
            let flavor = self.sh.opts.flavor;
            self.exec(&mysql_timeout_sql(flavor, Some(ms))).await?;
            self.restore.push(mysql_timeout_sql(flavor, (own > 0).then_some(own as f64)));
        }
        let continue_on_error = req.get("continueOnError").is_some_and(js_truthy);
        // Results are numbered in order; a CALL with several result sets takes one number per set (the next statement
        // follows).
        let mut next = 0usize;
        let n = spans.len();
        for (i, span) in spans.iter().enumerate() {
            if run.load(Ordering::SeqCst) || self.sh.ended() {
                break;
            }
            let index = next;
            next += 1;
            self.sh.port(MyPortMessage::Statement {
                query_id: query_id.to_owned(),
                index,
                start: span.start,
                end: span.end,
                set: None,
            });
            let t0 = self.sh.now();
            let r = if first_keyword(&span.text) == "CALL" {
                self.call(query_id, index, span, row_cap, next).await.map(|nx| next = nx)
            } else {
                self.statement(query_id, index, &span.text, row_cap, i + 1 == n).await
            };
            if let Err(thrown) = r {
                if self.sh.ended() {
                    return Err(thrown);
                }
                *all_ok = false;
                let (error, at) = match thrown {
                    Fail::Call { error, index: at } => (Fail::My(error), at),
                    other => (other, index),
                };
                let mut server = error.server();
                // A syntax error names its place as "near '...' at line N": it is underlined in the editor.
                if let Some(s) = server.as_mut() {
                    s.position = mysql_error_position(&s.message.text, &span.text);
                }
                let has_server = server.is_some();
                self.statement_error(query_id, at, self.sh.code_of(&error), server, t0);
                // An error inside a transaction leaves it open in MySQL: the state is asked for.
                let _ = self.sync_tx().await;
                if !continue_on_error || !has_server {
                    break;
                }
            }
        }
        Ok(())
    }

    /// One statement. Its rows stream in bounded batches; only a read that is the last statement of the run keeps its
    /// result open for "load more". An earlier read with more rows is stopped (KILL QUERY); anything else that returns rows
    /// runs to its end with the rest of its rows dropped, reported with truncated.
    async fn statement(&mut self, query_id: &str, index: usize, text: &str, row_cap: usize, last: bool) -> Result<(), Fail> {
        let t0 = self.sh.now();
        let mut stream = MyStream::start(self.conn(), text).await?;
        let mut state = PumpState::default();
        let sent = match self.pump(query_id, index, &mut stream, row_cap, &mut state).await {
            Ok(n) => n,
            Err(e) => {
                if !stream.done {
                    self.stop(&mut stream, false).await?;
                }
                return Err(e);
            }
        };
        let read = mysql_is_read_statement(text);
        let more = if stream.fields.is_some() { self.more(&mut stream).await } else { false };
        let keep = more && last && read;
        let keyword = first_keyword(text);
        let command = |fallback: &str| if keyword.is_empty() { fallback.to_owned() } else { keyword.clone() };
        if stream.fields.is_none() {
            let h = stream.header.clone();
            if let Some(h) = &h {
                self.set_tx(h);
            }
            self.sh.port(MyPortMessage::StatementEnd {
                query_id: query_id.to_owned(),
                index,
                command: command("OK"),
                row_count: h.as_ref().map(|h| h.affected_rows),
                rows: 0,
                has_more: false,
                truncated: false,
                time_ms: self.sh.since(t0),
            });
            if h.as_ref().is_some_and(|h| h.warnings > 0) {
                self.warnings(query_id).await;
            }
            if mysql_is_use(text) {
                self.report_database().await;
            }
            return Ok(());
        }
        if more && !keep {
            self.stop(&mut stream, read).await?;
            self.sh.set_cancel_requested(false);
            self.sh.port(MyPortMessage::StatementEnd {
                query_id: query_id.to_owned(),
                index,
                command: command("SELECT"),
                row_count: None,
                rows: sent,
                has_more: false,
                truncated: true,
                time_ms: self.sh.since(t0),
            });
            self.sync_tx().await?;
            return Ok(());
        }
        self.sh.port(MyPortMessage::StatementEnd {
            query_id: query_id.to_owned(),
            index,
            command: command("SELECT"),
            row_count: if keep { None } else { Some(sent) },
            rows: sent,
            has_more: keep,
            truncated: false,
            time_ms: self.sh.since(t0),
        });
        if !keep {
            match stream.header.clone() {
                Some(h) => self.set_tx(&h),
                None => self.sync_tx().await?,
            }
            return Ok(());
        }
        let seq = {
            let mut st = self.sh.st.lock();
            st.open_seq += 1;
            let seq = st.open_seq;
            st.open = Some(OpenMark { seq, query_id: query_id.to_owned(), timer: None });
            seq
        };
        self.open = Some(OpenStream {
            seq,
            query_id: query_id.to_owned(),
            index,
            stream,
            binary: state.binary.unwrap_or_default(),
            sent,
        });
        self.arm_idle(seq);
        Ok(())
    }

    /// A CALL (1.0.6): runs to its end, then every result set it answered with is a result of its own (the first takes
    /// `index`, the others the next free numbers, marked with `set`). Returns the next free number. A failure after some
    /// sets keeps them and reports the error as one more result ([`Fail::Call`]).
    async fn call(&mut self, query_id: &str, index: usize, span: &SqlSpan, row_cap: usize, next: usize) -> Result<usize, Fail> {
        struct CallSet {
            fields: Vec<MyColumn>,
            rows: Vec<RawRow>,
            dropped: u64,
        }
        let t0 = self.sh.now();
        self.conn().start_query(&span.text).await?;
        let mut sets: Vec<CallSet> = Vec::new();
        let mut extra_sets = 0usize;
        let mut header: Option<MyOk> = None;
        let mut error: Option<MyError> = None;
        let mut current: Option<usize> = None;
        // Caps over all sets together, not only per set: a procedure returning many sets must not hold more than a few
        // results' worth.
        let (mut kept_rows, mut kept_bytes) = (0usize, 0usize);
        let total_rows = row_cap.saturating_mul(4);
        self.sh.flight(true);
        loop {
            match self.conn().next_event().await {
                Ok(None) => break,
                Ok(Some(ev)) => match ev {
                    MyEvent::Fields(fields) => {
                        if sets.len() >= CALL_MAX_SETS {
                            extra_sets += 1;
                            current = None;
                        } else {
                            sets.push(CallSet { fields, rows: Vec::new(), dropped: 0 });
                            current = Some(sets.len() - 1);
                        }
                    }
                    MyEvent::Row(row) => {
                        if let Some(c) = current {
                            let size = row.call_bytes();
                            let set = &mut sets[c];
                            if set.rows.len() < row_cap && kept_rows < total_rows && kept_bytes + size <= CALL_MAX_BYTES {
                                set.rows.push(row);
                                kept_rows += 1;
                                kept_bytes += size;
                            } else {
                                set.dropped += 1;
                            }
                        }
                    }
                    MyEvent::SetEnd { .. } => {}
                    MyEvent::Ok(ok) => header = Some(ok),
                    MyEvent::Error(e) => error = Some(MyError::Server(e)),
                    MyEvent::ClientError(m) => error = Some(MyError::Client(m)),
                },
                Err(e) => {
                    error = Some(e);
                    break;
                }
            }
        }
        self.sh.flight(false);
        let time_ms = self.sh.since(t0);
        let mut next = next;
        let shown = sets.len();
        for (k, set) in sets.into_iter().enumerate() {
            let at = if k == 0 {
                index
            } else {
                let a = next;
                next += 1;
                a
            };
            if k > 0 {
                self.sh.port(MyPortMessage::Statement {
                    query_id: query_id.to_owned(),
                    index: at,
                    start: span.start,
                    end: span.end,
                    set: Some(k + 1),
                });
            }
            if !set.fields.is_empty() {
                self.sh.port(MyPortMessage::Columns {
                    query_id: query_id.to_owned(),
                    index: at,
                    columns: port_columns(&set.fields),
                });
            }
            let binary = binary_flags(&set.fields);
            let kept = set.rows.len() as u64;
            self.send_rows(query_id, at, set.rows.iter().map(|r| row_values(r, &binary)).collect());
            self.sh.port(MyPortMessage::StatementEnd {
                query_id: query_id.to_owned(),
                index: at,
                command: "CALL".into(),
                row_count: Some(kept + set.dropped),
                rows: kept,
                has_more: false,
                truncated: set.dropped > 0,
                time_ms,
            });
        }
        if extra_sets > 0 {
            self.sh.port(MyPortMessage::Notice {
                query_id: query_id.to_owned(),
                message: server_text(&format!("CALL: +{extra_sets} result sets not shown (max {CALL_MAX_SETS})")),
                severity: "NOTICE".into(),
            });
        }
        if let Some(error) = error {
            if shown == 0 {
                return Err(Fail::My(error));
            }
            let at = next;
            self.sh.port(MyPortMessage::Statement {
                query_id: query_id.to_owned(),
                index: at,
                start: span.start,
                end: span.end,
                set: Some(shown + 1),
            });
            return Err(Fail::Call { error, index: at });
        }
        if shown == 0 {
            self.sh.port(MyPortMessage::StatementEnd {
                query_id: query_id.to_owned(),
                index,
                command: "CALL".into(),
                row_count: header.as_ref().map(|h| h.affected_rows),
                rows: 0,
                has_more: false,
                truncated: false,
                time_ms,
            });
        }
        match &header {
            Some(h) => self.set_tx(h),
            None => self.sync_tx().await?,
        }
        if header.as_ref().is_some_and(|h| h.warnings > 0) {
            self.warnings(query_id).await;
        }
        Ok(next)
    }

    /// SHOW WARNINGS after a statement that had some: they arrive as notices.
    async fn warnings(&mut self, query_id: &str) {
        // warnings are a bonus
        let Ok(rows) = self.meta("SHOW WARNINGS").await else { return };
        for row in rows.iter().take(50) {
            let at = |i: usize| row.get(i).and_then(|v| v.as_deref());
            let message = format!("{} {}: {}", at(0).unwrap_or("Warning"), at(1).unwrap_or(""), at(2).unwrap_or(""));
            self.sh.port(MyPortMessage::Notice {
                query_id: query_id.to_owned(),
                message: server_text(&message),
                severity: at(0).unwrap_or("WARNING").to_uppercase(),
            });
        }
    }

    async fn report_database(&mut self) {
        // stays as it was when the server does not answer
        if let Ok(rows) = self.meta("SELECT DATABASE()").await {
            let name = rows.first().and_then(|r| r.first()).cloned().flatten().unwrap_or_default();
            self.sh.out.database(name);
        }
    }

    async fn fetch_more(&mut self, query_id: &str, count: f64) {
        let Some(mut open) = self.open.take_if(|o| o.query_id == query_id) else { return };
        let n = count.floor().min(limits::ROW_CAP_MAX as f64).max(1.0) as usize;
        let t0 = self.sh.now();
        self.sh.set_cancel_requested(false);
        let res: Result<bool, Fail> = async {
            let mut state = PumpState { columns_sent: true, binary: Some(open.binary.clone()) };
            let sent = self.pump(query_id, open.index, &mut open.stream, n, &mut state).await?;
            open.sent += sent;
            let has_more = self.more(&mut open.stream).await;
            self.sh.port(MyPortMessage::StatementEnd {
                query_id: query_id.to_owned(),
                index: open.index,
                command: "SELECT".into(),
                row_count: if has_more { None } else { Some(open.sent) },
                rows: open.sent,
                has_more,
                truncated: false,
                time_ms: self.sh.since(t0),
            });
            if has_more {
                return Ok(true);
            }
            self.sh.clear_open(open.seq);
            self.sync_tx().await?;
            self.settle().await?;
            Ok(false)
        }
        .await;
        match res {
            Ok(true) => {
                let seq = open.seq;
                self.open = Some(open);
                self.arm_idle(seq);
            }
            Ok(false) => {}
            Err(error) => {
                self.sh.clear_open(open.seq);
                self.statement_error(query_id, open.index, self.sh.end_code(&error), error.server(), t0);
                if !open.stream.done {
                    let _ = self.stop(&mut open.stream, true).await;
                }
                if !self.sh.ended() {
                    let _ = self.settle().await;
                }
            }
        }
    }

    // ── table pages ────────────────────────────────────────────────────────────

    async fn info(&mut self, db: &str, table: &str, fresh: bool) -> Result<Option<Arc<TableInfo>>, Fail> {
        let id = format!("{db}\0{table}");
        if !fresh
            && let Some((at, info)) = self.keys.get(&id)
            && at.elapsed() < INFO_TTL
        {
            return Ok(info.clone());
        }
        let info = meta::table_info(self, db, table).await?.map(Arc::new);
        self.keys.insert(id, (Instant::now(), info.clone()));
        Ok(info)
    }

    fn binary_columns(info: Option<&TableInfo>) -> HashSet<String> {
        info.map(|i| i.data_types.iter().filter(|(_, t)| mysql_binary_type(t)).map(|(c, _)| c.clone()).collect())
            .unwrap_or_default()
    }

    /// One page inside a READ ONLY transaction (the filter is the user's own SQL).
    async fn run_page(&mut self, req: &Value) {
        let started = self.sh.now();
        let query_id = str_of(req, "queryId").to_owned();
        let run = self.begin_run();
        let success = match self.page_body(req, &query_id, started).await {
            Ok(done) => done,
            Err(e) => {
                self.statement_error(&query_id, 0, self.sh.end_code(&e), e.server(), started);
                false
            }
        };
        self.end_run(&run);
        self.sh.port(MyPortMessage::QueryEnd {
            query_id,
            ok: success,
            cancelled: run.load(Ordering::SeqCst),
            time_ms: self.sh.since(started),
            tx: self.sh.tx(),
        });
    }

    async fn page_body(&mut self, req: &Value, query_id: &str, started: u64) -> Result<bool, Fail> {
        self.close_open().await?;
        self.settle().await?;
        if self.sh.tx() != "idle" {
            self.statement_error(query_id, 0, "inTransaction", None, started);
            return Ok(false);
        }
        let info = self.info(str_of(req, "schema"), str_of(req, "table"), false).await?;
        let binary = Self::binary_columns(info.as_deref());
        let built =
            page_input(req).and_then(|input| mysql_page_sql(&input, info.as_ref().and_then(|i| i.edit_key.as_deref()), &binary));
        let sql = match built {
            Ok((sql, _)) => sql,
            Err(_) => {
                self.statement_error(query_id, 0, "invalid", None, started);
                return Ok(false);
            }
        };
        self.sh.port(MyPortMessage::Statement { query_id: query_id.to_owned(), index: 0, start: 0, end: 0, set: None });
        self.exec("START TRANSACTION READ ONLY").await?;
        let limit = num_of(req, "limit").unwrap_or(0.0).floor().max(0.0) as usize;
        let paged: Result<(u64, bool), Fail> = async {
            let mut stream = MyStream::start(self.conn(), &sql).await?;
            let sent = match self.pump(query_id, 0, &mut stream, limit, &mut PumpState::default()).await {
                Ok(n) => n,
                Err(e) => {
                    if !stream.done {
                        self.stop(&mut stream, false).await?;
                    }
                    return Err(e);
                }
            };
            let more = self.more(&mut stream).await;
            // The page asked for one row more than it shows: the rest is that row at most.
            if !stream.done {
                self.stop(&mut stream, false).await?;
            }
            self.exec("COMMIT").await?;
            Ok((sent, more))
        }
        .await;
        let (sent, more) = match paged {
            Ok(v) => v,
            Err(e) => {
                let _ = self.exec("ROLLBACK").await;
                return Err(e);
            }
        };
        self.sh.port(MyPortMessage::StatementEnd {
            query_id: query_id.to_owned(),
            index: 0,
            command: "SELECT".into(),
            row_count: Some(sent),
            rows: sent,
            has_more: more,
            truncated: false,
            time_ms: self.sh.since(started),
        });
        Ok(true)
    }

    // ── edits ──────────────────────────────────────────────────────────────────

    /// The statements of staged edits, or the answer that refuses them.
    async fn build_edits(&mut self, req: &Value) -> Result<Result<Vec<BuiltStatement>, Value>, Fail> {
        let (schema, table) = (str_of(req, "schema"), str_of(req, "table"));
        let Some(info) = self.info(schema, table, true).await? else { return Ok(Err(fail("notFound", None, None))) };
        let raw = req.get("edits").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        if raw.iter().any(|e| str_of(e, "op") != "insert") && info.edit_key.is_none() {
            return Ok(Err(fail("noKey", None, None)));
        }
        let columns: Vec<ColumnMeta> = info
            .columns
            .iter()
            .map(|c| ColumnMeta {
                name: c.name.clone(),
                data_type: info.data_types.get(&c.name).cloned().unwrap_or_default(),
                generated: c.generated,
            })
            .collect();
        let built = raw
            .iter()
            .map(StagedEdit::from_json)
            .collect::<Result<Vec<_>, _>>()
            .and_then(|edits| mysql_edit_statements(schema, table, info.edit_key.as_deref(), &edits, &columns));
        Ok(built.map_err(|e| fail(e.code(), None, None)))
    }

    /// All edits in one transaction; an UPDATE or DELETE that does not match exactly one row rolls everything back.
    async fn apply_edits(&mut self, req: &Value) -> Result<Value, Fail> {
        if self.sh.opts.read_only {
            return Ok(fail("readOnly", None, None));
        }
        if self.sh.tx() != "idle" {
            return Ok(fail("inTransaction", None, None));
        }
        let built = match self.build_edits(req).await? {
            Ok(b) => b,
            Err(v) => return Ok(v),
        };
        self.exec("START TRANSACTION").await?;
        let mut affected = 0u64;
        for s in &built {
            self.sh.flight(true);
            let r = self.exec(&s.sql).await;
            self.sh.flight(false);
            let r = match r {
                Ok(r) => r,
                Err(e) => {
                    let _ = self.exec("ROLLBACK").await;
                    let f = Fail::My(e);
                    return Ok(fail(self.sh.code_of(&f), f.server().as_ref(), Some(s.index)));
                }
            };
            // The connection reports matched rows (CLIENT_FOUND_ROWS): an UPDATE to the same value still counts its row.
            let n = r.header.as_ref().map_or(0, |h| h.affected_rows);
            if s.op != EditOp::Insert && n != 1 {
                let _ = self.exec("ROLLBACK").await;
                return Ok(fail("conflict", None, Some(s.index)));
            }
            affected += n;
        }
        if let Err(e) = self.exec("COMMIT").await {
            let _ = self.exec("ROLLBACK").await;
            let f = Fail::My(e);
            return Ok(fail(self.sh.code_of(&f), f.server().as_ref(), None));
        }
        if self.sh.tx() != "idle" {
            return Ok(fail("dbFailed", None, None));
        }
        self.keys.clear();
        Ok(ok(json!({ "affected": affected })))
    }

    async fn cell_value(&mut self, req: &Value) -> Result<Value, Fail> {
        let (schema, table) = (str_of(req, "schema"), str_of(req, "table"));
        let info = self.info(schema, table, false).await?;
        let Some(key) = info.as_ref().and_then(|i| i.edit_key.clone()) else { return Ok(fail("noKey", None, None)) };
        let fields = req.get("key").and_then(Value::as_object).map(js_fields).unwrap_or_default();
        let binary = Self::binary_columns(info.as_deref());
        let sql = match mysql_cell_sql(schema, table, str_of(req, "column"), &fields, &key, &binary) {
            Ok(s) => s,
            Err(_) => return Ok(fail("invalid", None, None)),
        };
        let r = self.exec(&sql).await?;
        if r.rows.len() != 1 {
            return Ok(fail(if r.rows.is_empty() { "notFound" } else { "conflict" }, None, None));
        }
        let bin = r.fields.as_deref().and_then(|f| f.first()).is_some_and(|f| mysql_field_binary(&field_like(f)));
        let Some(v) = r.rows[0].get(0) else { return Ok(ok(Value::Null)) };
        let s = if bin { hex_text(v) } else { node_utf8(v) };
        Ok(ok(json!(utf16_head(&s, limits::FULL_VALUE_CHARS).text)))
    }
}
