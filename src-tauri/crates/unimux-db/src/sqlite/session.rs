//! One SQLite session (1.1.4 src/dbhost/sqliteSession.ts), the counterpart of the Postgres and MySQL sessions: its
//! connection lives in an engine thread of its own ([`super::engine`]), so a long statement never blocks anything else. It
//! runs its operations one at a time, streams rows over the DB port in bounded batches, keeps at most one read-only result
//! open for "load more" (an open statement holds a read lock on the file, so it is closed when anything else runs or after
//! DB_LIMITS.cursorIdleMs), refuses writes on read-only connections on the client side and with PRAGMA query_only, and
//! applies staged edits in one BEGIN IMMEDIATE transaction. Cancel sets the interrupt flag (checked between rows and in lock
//! waits) and calls `sqlite3_interrupt`; a statement that does not stop within a moment ends with its thread: the session
//! opens the file again, and an open transaction is rolled back.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use futures::FutureExt;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::Fail;
use super::engine::{Answer, ConnSetup, EngineError, EngineLink, Request};
use super::meta::{self, SqQuery, SqRow, TableInfo};
use super::port::{PortColumn, PortMessage, ServerError};
use crate::model::js_truthy;
use crate::sql::pg::first_keyword;
use crate::sql::split::split_sql;
use crate::sql::sqlite::{
    ColumnMeta, SqliteParam, sqlite_cell_sql, sqlite_edit_preview, sqlite_edit_statements, sqlite_ends_transaction,
    sqlite_error_position, sqlite_is_read_statement, sqlite_page_sql, sqlite_read_only_allows, sqlite_value_kind,
};
use crate::sql::{DbSqlError, Dialect, EditOp, PageSqlInput, SQLITE_MAIN, Sort, StagedEdit, js_fields, limits};
use crate::wire::value::DbValue;

/// Rows a single engine request returns at most (the batches the renderer gets are cut from these).
const BATCH_ROWS: usize = 500;

/// What the session reports (the host forwards it: rows to the window's port, the rest to main).
pub trait SqliteOut: Send + Sync {
    fn port(&self, m: PortMessage);
    /// `dbTx`: "idle" or "transaction".
    fn tx(&self, tx: &'static str);
    /// `dbActivity`.
    fn activity(&self, busy: bool);
    /// Something to tell the user outside of a run (the connection was opened again after a cancel; a warning in the log).
    fn notice(&self, _message: &str) {}
    /// The session cannot go on (its thread died, the file cannot be opened again): it must end with this error.
    fn fatal(&self, error: &'static str, message: Option<String>);
}

/// `SqliteSessionOptions`.
#[derive(Clone)]
pub struct SqliteOptions {
    pub path: String,
    pub read_only: bool,
    /// How long SQLite waits for another program's lock before it reports the file as locked.
    pub busy_ms: u64,
    /// How long a cancelled statement may take to stop before its thread is let go.
    pub kill_grace_ms: u64,
    pub cursor_idle_ms: u64,
    /// Extra setup of every connection (tests).
    pub setup: Option<ConnSetup>,
}

impl SqliteOptions {
    pub fn new(path: impl Into<String>, read_only: bool) -> Self {
        SqliteOptions {
            path: path.into(),
            read_only,
            busy_ms: 5000,
            kill_grace_ms: 1500,
            cursor_idle_ms: limits::CURSOR_IDLE_MS,
            setup: None,
        }
    }
}

/// Why a session did not open: the `dbStatus` error code and its message.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenError {
    pub error: &'static str,
    pub message: Option<String>,
}

const SQLITE_BUSY: i32 = 5;
const SQLITE_LOCKED: i32 = 6;
const SQLITE_READONLY: i32 = 8;
const SQLITE_INTERRUPT: i32 = 9;
const SQLITE_CANTOPEN: i32 = 14;
const SQLITE_NOTADB: i32 = 26;

/// `sqliteErrorCode`: the error code the UI shows for an engine error.
pub fn sqlite_error_code(e: &EngineError) -> &'static str {
    if e.interrupted || e.errcode == Some(SQLITE_INTERRUPT) {
        return "cancelled";
    }
    let primary = e.errcode.map(|c| c & 0xff);
    match primary {
        Some(SQLITE_BUSY | SQLITE_LOCKED) => "dbLocked",
        Some(SQLITE_READONLY) => "readOnly",
        _ if e.message.to_lowercase().contains("attempt to write a readonly database") => "readOnly",
        Some(SQLITE_NOTADB) => "dbNotSqlite",
        Some(SQLITE_CANTOPEN) => "dbFileMissing",
        _ if e.errcode.is_some() => "server",
        _ => "dbFailed",
    }
}

/// `sqliteServerError`: the server error of an engine error (its message, SQLITE_<code> and, for a syntax error, the
/// position in `sql`).
pub fn sqlite_server_error(e: &EngineError, sql: Option<&str>) -> Option<ServerError> {
    let code = e.errcode?;
    if e.interrupted {
        return None;
    }
    let position = sql.filter(|s| !s.is_empty()).and_then(|s| sqlite_error_position(&e.message, s));
    Some(ServerError::new(&e.message, code, position))
}

fn ok(value: Value) -> Value {
    json!({ "ok": true, "value": value })
}

fn fail(error: &str, server: Option<&ServerError>, index: Option<usize>) -> Value {
    let mut v = json!({ "ok": false, "error": error });
    if let Some(s) = server {
        v["server"] = s.to_value();
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

/// A table page request as `sqlitePageSql` reads it; an `after` holding a non-string is refused.
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

struct Run {
    cancelled: AtomicBool,
}

struct OpenResult {
    id: u64,
    query_id: String,
    index: usize,
    cursor: u64,
    sent: u64,
    timer: Option<JoinHandle<()>>,
}

impl OpenResult {
    fn stop_timer(&mut self) {
        if let Some(t) = self.timer.take() {
            t.abort();
        }
    }
}

struct State {
    tx: &'static str,
    pending: usize,
    runs: usize,
    meta_pending: usize,
    open: Option<OpenResult>,
    run: Option<Arc<Run>>,
    cursor_seq: u64,
    open_seq: u64,
    ended: bool,
    keys: HashMap<String, (Instant, Option<Arc<TableInfo>>)>,
    /// query_only is off for a run with writes allowed (read-only connections); switched back once no transaction is open.
    override_active: bool,
    /// The thread was let go (a cancel that did not stop): the next operation opens the file again.
    reopen: bool,
}

type Job = BoxFuture<'static, ()>;

struct Inner {
    opts: SqliteOptions,
    out: Arc<dyn SqliteOut>,
    link: Arc<EngineLink>,
    st: Mutex<State>,
    queue: mpsc::UnboundedSender<Job>,
    rt: tokio::runtime::Handle,
    /// The file could be opened read-only only (a read-only medium or folder): writes fail in SQLite itself.
    file_read_only: AtomicBool,
    server_version: Mutex<String>,
    journal_mode: Mutex<String>,
    born: Instant,
}

/// One SQLite session. Create it inside a tokio runtime ([`SqliteSession::open`]).
#[derive(Clone)]
pub struct SqliteSession {
    inner: Arc<Inner>,
}

impl SqliteSession {
    /// `startSqlite` of the host: the file must exist (a moved file is never replaced by a new empty one); it is opened in
    /// an engine thread of its own, read-only on a medium that allows nothing else when the connection is read-only.
    pub async fn open(opts: SqliteOptions, out: Arc<dyn SqliteOut>) -> Result<SqliteSession, OpenError> {
        if opts.path.is_empty() {
            return Err(OpenError { error: "unsupported", message: None });
        }
        let missing = || OpenError { error: "dbFileMissing", message: Some(opts.path.clone()) };
        match tokio::fs::metadata(&opts.path).await {
            Ok(m) if m.is_file() => {}
            _ => return Err(missing()),
        }
        let (queue, mut jobs) = mpsc::unbounded_channel::<Job>();
        let rt = tokio::runtime::Handle::current();
        rt.spawn(async move {
            while let Some(job) = jobs.recv().await {
                job.await;
            }
        });
        let setup = opts.setup.clone();
        let inner = Arc::new_cyclic(|me: &Weak<Inner>| {
            let me = me.clone();
            let link = EngineLink::new(
                Box::new(move |why| {
                    if let Some(s) = me.upgrade() {
                        s.die(why);
                    }
                }),
                setup,
            );
            Inner {
                opts,
                out,
                link,
                st: Mutex::new(State {
                    tx: "idle",
                    pending: 0,
                    runs: 0,
                    meta_pending: 0,
                    open: None,
                    run: None,
                    cursor_seq: 0,
                    open_seq: 0,
                    ended: false,
                    keys: HashMap::new(),
                    override_active: false,
                    reopen: false,
                }),
                queue,
                rt,
                file_read_only: AtomicBool::new(false),
                server_version: Mutex::new(String::new()),
                journal_mode: Mutex::new(String::new()),
                born: Instant::now(),
            }
        });
        inner.connect().await.map_err(|e| OpenError { error: e.0, message: e.1 })?;
        Ok(SqliteSession { inner })
    }

    /// `sqlite_version()`.
    pub fn server_version(&self) -> String {
        self.inner.server_version.lock().clone()
    }

    pub fn journal_mode(&self) -> String {
        self.inner.journal_mode.lock().clone()
    }

    pub fn file_read_only(&self) -> bool {
        self.inner.file_read_only.load(Ordering::SeqCst)
    }

    /// What the `connected` status carries (no tls: a file on this computer is not a network connection).
    pub fn connected_status(&self) -> Value {
        json!({ "serverVersion": format!("SQLite {}", self.server_version()), "database": SQLITE_MAIN })
    }

    /// The transaction state ("idle" or "transaction").
    pub fn tx(&self) -> &'static str {
        self.inner.st.lock().tx
    }

    /// A statement or an open result is on the connection, or operations wait.
    pub fn busy(&self) -> bool {
        let st = self.inner.st.lock();
        self.inner.link.in_flight() > 0 || st.open.is_some() || st.pending > 0
    }

    /// Ends the session: the run stops, the thread closes the file (an open transaction is rolled back).
    pub fn end(&self) {
        let inner = &self.inner;
        {
            let mut st = inner.st.lock();
            st.ended = true;
            if let Some(r) = &st.run {
                r.cancelled.store(true, Ordering::SeqCst);
            }
            if let Some(o) = st.open.as_mut() {
                o.stop_timer();
            }
        }
        let link = inner.link.clone();
        inner.rt.spawn(async move { link.shutdown().await });
    }

    /// One operation (`DbHostOp` without redis); the answer is a `DbResult`. A run answers once accepted; its rows go to
    /// the port.
    pub fn handle(&self, op: &Value) -> BoxFuture<'static, Value> {
        self.inner.handle(op)
    }
}

impl SqQuery for Arc<Inner> {
    fn q<'a>(&'a self, sql: &'a str, params: Vec<SqliteParam>) -> BoxFuture<'a, Result<Vec<SqRow>, Fail>> {
        Box::pin(self.meta(sql, params))
    }
}

impl Inner {
    fn now(&self) -> u64 {
        self.born.elapsed().as_millis() as u64
    }

    fn since(&self, t0: u64) -> u64 {
        self.now().saturating_sub(t0)
    }

    fn ended(&self) -> bool {
        self.st.lock().ended
    }

    fn die(&self, why: String) {
        let first = {
            let mut st = self.st.lock();
            !std::mem::replace(&mut st.ended, true)
        };
        if first {
            self.out.fatal("dbFailed", Some(why));
        }
    }

    fn open_request(&self, read_only: bool) -> Request {
        Request::Open { path: self.opts.path.clone(), read_only, busy_ms: self.opts.busy_ms, cell_chars: limits::CELL_CHARS }
    }

    /// Starts the engine and opens the file.
    async fn connect(self: &Arc<Self>) -> Result<(), (&'static str, Option<String>)> {
        self.link.start();
        let mut r = self.link.request(self.open_request(false)).await;
        // A file this computer may only read (or a folder where no journal can be written) still opens, read-only.
        if let Err(e) = &r.result
            && self.opts.read_only
            && matches!(e.errcode.map(|c| c & 0xff), Some(SQLITE_READONLY | SQLITE_CANTOPEN))
        {
            self.link.shutdown().await;
            self.link.start();
            r = self.link.request(self.open_request(true)).await;
            self.file_read_only.store(r.result.is_ok(), Ordering::SeqCst);
        }
        let opened = match r.result {
            Ok(a) => a,
            Err(e) => {
                self.link.shutdown().await;
                return Err((sqlite_error_code(&e), Some(e.message)));
            }
        };
        *self.server_version.lock() = opened.version.unwrap_or_default();
        *self.journal_mode.lock() = opened.journal.unwrap_or_default();
        if self.opts.read_only && !self.file_read_only.load(Ordering::SeqCst) {
            let r = self.link.request(Request::Exec { sql: "PRAGMA query_only = 1".into(), params: Vec::new() }).await;
            if let Err(e) = r.result {
                self.link.shutdown().await;
                return Err(("dbFailed", Some(e.message)));
            }
        }
        Ok(())
    }

    // ── plumbing ───────────────────────────────────────────────────────────────

    fn set_tx(&self, in_tx: bool) {
        let tx = if in_tx { "transaction" } else { "idle" };
        let changed = {
            let mut st = self.st.lock();
            std::mem::replace(&mut st.tx, tx) != tx
        };
        if changed {
            self.out.tx(tx);
        }
    }

    /// One engine request; its transaction state is taken; an error is a [`Fail::Engine`].
    async fn req(self: &Arc<Self>, req: Request) -> Result<Answer, Fail> {
        if self.st.lock().reopen {
            self.reconnect().await?;
        }
        let r = self.link.request(req).await;
        self.set_tx(r.in_tx);
        r.result.map_err(Fail::Engine)
    }

    async fn exec(self: &Arc<Self>, sql: &str, params: Vec<SqliteParam>) -> Result<Answer, Fail> {
        self.req(Request::Exec { sql: sql.to_owned(), params }).await
    }

    /// A setting that must hold; when it fails the session cannot go on.
    async fn must_exec(self: &Arc<Self>, sql: &str) -> Result<(), Fail> {
        if self.st.lock().reopen {
            return self.reconnect().await;
        }
        self.must_exec_raw(sql).await
    }

    async fn must_exec_raw(&self, sql: &str) -> Result<(), Fail> {
        let r = self.link.request(Request::Exec { sql: sql.to_owned(), params: Vec::new() }).await;
        match r.result {
            Ok(_) => Ok(()),
            Err(e) => {
                self.st.lock().ended = true;
                self.out.fatal("dbFailed", Some(e.message.clone()));
                Err(Fail::Engine(e))
            }
        }
    }

    async fn meta(self: &Arc<Self>, sql: &str, params: Vec<SqliteParam>) -> Result<Vec<SqRow>, Fail> {
        let r = self.exec(sql, params).await?;
        Ok(r.rows
            .into_iter()
            .map(|row| {
                row.into_iter()
                    .map(|v| match v {
                        DbValue::Null => None,
                        DbValue::Text(s) => Some(s),
                        DbValue::Trunc { head, .. } => Some(head.text),
                    })
                    .collect()
            })
            .collect())
    }

    /// After a cancel let the thread go: the file is opened again (its transaction is gone, the read-only guard is set
    /// again).
    async fn reconnect(&self) -> Result<(), Fail> {
        {
            let mut st = self.st.lock();
            st.reopen = false;
            st.override_active = false;
        }
        self.link.start();
        let r = self.link.request(self.open_request(self.file_read_only.load(Ordering::SeqCst))).await;
        if let Err(e) = r.result {
            self.st.lock().ended = true;
            self.out.fatal(sqlite_error_code(&e), Some(e.message.clone()));
            return Err(Fail::Engine(e));
        }
        if self.opts.read_only && !self.file_read_only.load(Ordering::SeqCst) {
            self.must_exec_raw("PRAGMA query_only = 1").await?;
        }
        self.set_tx(false);
        Ok(())
    }

    /// Runs `f` after every operation queued before it (one at a time); None: it panicked (the session ended).
    fn serial<T: Send + 'static>(
        self: &Arc<Self>,
        f: impl FnOnce(Arc<Inner>) -> BoxFuture<'static, T> + Send + 'static,
    ) -> BoxFuture<'static, Option<T>> {
        let first = {
            let mut st = self.st.lock();
            st.pending += 1;
            st.pending == 1
        };
        if first {
            self.out.activity(true);
        }
        let (tx, rx) = oneshot::channel();
        let me = self.clone();
        let job = async move {
            match std::panic::AssertUnwindSafe(f(me.clone())).catch_unwind().await {
                Ok(v) => {
                    let _ = tx.send(v);
                }
                Err(_) => {
                    me.die("the SQLite session failed".into());
                    let link = me.link.clone();
                    me.rt.spawn(async move { link.shutdown().await });
                }
            }
            let idle = {
                let mut st = me.st.lock();
                st.pending -= 1;
                st.pending == 0
            };
            if idle {
                me.out.activity(false);
            }
        };
        let _ = self.queue.send(Box::pin(job));
        Box::pin(async move { rx.await.ok() })
    }

    fn serial_run(self: &Arc<Self>, f: impl FnOnce(Arc<Inner>) -> BoxFuture<'static, ()> + Send + 'static) {
        self.st.lock().runs += 1;
        let done = self.serial(move |me| {
            Box::pin(async move {
                f(me.clone()).await;
                me.st.lock().runs -= 1;
            })
        });
        self.rt.spawn(done);
    }

    fn code_of(&self, error: &Fail) -> &'static str {
        match error {
            Fail::Sql(e) => e.code(),
            Fail::Engine(e) => {
                if self.ended() {
                    "noSession"
                } else {
                    sqlite_error_code(e)
                }
            }
            Fail::Other(_) => {
                if self.ended() {
                    "noSession"
                } else {
                    "dbFailed"
                }
            }
        }
    }

    fn server_of(error: &Fail, sql: Option<&str>) -> Option<ServerError> {
        match error {
            Fail::Engine(e) => sqlite_server_error(e, sql),
            _ => None,
        }
    }

    fn fail_of(&self, error: &Fail, index: Option<usize>) -> Value {
        fail(self.code_of(error), Self::server_of(error, None).as_ref(), index)
    }

    /// Writes are back off (read-only connections) once the run that allowed them left no transaction open.
    async fn settle(self: &Arc<Self>) -> Result<(), Fail> {
        {
            let mut st = self.st.lock();
            if !st.override_active || st.tx != "idle" || st.open.is_some() {
                return Ok(());
            }
            st.override_active = false;
        }
        self.must_exec("PRAGMA query_only = 1").await
    }

    fn columns(cols: &[super::engine::ColumnOut]) -> Vec<PortColumn> {
        cols.iter()
            .map(|c| PortColumn {
                name: c.name.clone(),
                type_name: c.decl_type.clone().unwrap_or_default(),
                kind: sqlite_value_kind(c.decl_type.as_deref()).as_str(),
            })
            .collect()
    }

    fn send_rows(&self, query_id: &str, index: usize, rows: Vec<Vec<DbValue>>) {
        let mut chunk: Vec<Vec<DbValue>> = Vec::new();
        let mut chars = 0usize;
        for row in rows {
            chars += row.iter().map(DbValue::batch_chars).sum::<usize>();
            chunk.push(row);
            if chunk.len() >= limits::CHUNK_ROWS || chars >= limits::CHUNK_CHARS {
                self.out.port(PortMessage::Rows { query_id: query_id.to_owned(), index, rows: std::mem::take(&mut chunk) });
                chars = 0;
            }
        }
        if !chunk.is_empty() {
            self.out.port(PortMessage::Rows { query_id: query_id.to_owned(), index, rows: chunk });
        }
    }

    fn arm_idle(self: &Arc<Self>) {
        let me = Arc::downgrade(self);
        let mut st = self.st.lock();
        let Some(open) = st.open.as_mut() else { return };
        open.stop_timer();
        let id = open.id;
        let wait = Duration::from_millis(self.opts.cursor_idle_ms);
        open.timer = Some(self.rt.spawn(async move {
            tokio::time::sleep(wait).await;
            let Some(s) = me.upgrade() else { return };
            let done = s.serial(move |s| {
                Box::pin(async move {
                    if s.st.lock().open.as_ref().is_some_and(|o| o.id == id) {
                        s.close_open().await;
                        let _ = s.settle().await;
                    }
                })
            });
            drop(s);
            done.await;
        }));
    }

    async fn close_open(&self) {
        let open = {
            let mut st = self.st.lock();
            let Some(mut open) = st.open.take() else { return };
            open.stop_timer();
            open
        };
        self.link.request(Request::Close { cursor: open.cursor }).await;
        self.out.port(PortMessage::ResultClosed { query_id: open.query_id, index: open.index });
    }

    // ── operations ─────────────────────────────────────────────────────────────

    fn handle(self: &Arc<Self>, op: &Value) -> BoxFuture<'static, Value> {
        let ready = |v: Value| -> BoxFuture<'static, Value> { Box::pin(async move { v }) };
        if self.ended() {
            return ready(fail("noSession", None, None));
        }
        let req = op.get("req").cloned().unwrap_or(Value::Null);
        match op.get("op").and_then(Value::as_str).unwrap_or("") {
            "cancel" => ready(ok(json!(self.cancel()))),
            "query" => {
                self.serial_run(move |me| Box::pin(async move { me.run_query(&req).await }));
                ready(ok(json!(true)))
            }
            "tablePage" => {
                self.serial_run(move |me| Box::pin(async move { me.run_page(&req).await }));
                ready(ok(json!(true)))
            }
            "fetchMore" => {
                let query_id = str_of(op, "queryId").to_owned();
                let count = num_of(op, "count").unwrap_or(f64::NAN);
                {
                    let mut st = self.st.lock();
                    match st.open.as_mut() {
                        Some(o) if o.query_id == query_id => o.stop_timer(),
                        _ => return ready(fail("notFound", None, None)),
                    }
                }
                self.serial_run(move |me| Box::pin(async move { me.fetch_more(&query_id, count).await }));
                ready(ok(json!(true)))
            }
            "closeResult" => {
                let query_id = str_of(op, "queryId").to_owned();
                let done = self.serial(move |me| {
                    Box::pin(async move {
                        if me.st.lock().open.as_ref().is_some_and(|o| o.query_id == query_id) {
                            me.close_open().await;
                            me.settle().await?;
                        }
                        Ok::<_, Fail>(ok(json!(true)))
                    })
                });
                Box::pin(async move {
                    match done.await {
                        Some(Ok(v)) => v,
                        _ => fail("dbFailed", None, None),
                    }
                })
            }
            "redis" => ready(fail("invalid", None, None)),
            _ => {
                {
                    let mut st = self.st.lock();
                    if st.runs > 0 || st.meta_pending >= 4 {
                        return ready(fail("busy", None, None));
                    }
                    st.meta_pending += 1;
                }
                let op = op.clone();
                let done = self.serial(move |me| {
                    Box::pin(async move {
                        let r = async {
                            me.close_open().await;
                            me.settle().await?;
                            me.meta_op(&op).await
                        }
                        .await;
                        me.st.lock().meta_pending -= 1;
                        match r {
                            Ok(v) => v,
                            Err(e) => me.fail_of(&e, None),
                        }
                    })
                });
                Box::pin(async move { done.await.unwrap_or_else(|| fail("dbFailed", None, None)) })
            }
        }
    }

    async fn meta_op(self: &Arc<Self>, op: &Value) -> Result<Value, Fail> {
        let q: &dyn SqQuery = self;
        match op.get("op").and_then(Value::as_str).unwrap_or("") {
            "databases" => Ok(ok(json!([{
                "name": SQLITE_MAIN, "owner": "", "encoding": "", "isTemplate": false, "allowConnections": true, "sizeBytes": null,
            }]))),
            "schemas" => Ok(ok(json!([{ "name": SQLITE_MAIN, "owner": "", "system": false }]))),
            "objects" => Ok(ok(Value::Array(meta::list_objects(q, str_of(op, "schema")).await?))),
            "tableInfo" => match self.info(str_of(op, "schema"), str_of(op, "name"), true).await? {
                Some(info) => Ok(ok(info.to_json())),
                None => Ok(fail("notFound", None, None)),
            },
            "ddl" => match meta::object_ddl(q, str_of(op, "schema"), str_of(op, "name"), str_of(op, "kind")).await? {
                Some(ddl) => Ok(ok(json!(ddl))),
                None => Ok(fail("notFound", None, None)),
            },
            "transaction" => {
                let action = str_of(op, "action");
                let tx = self.st.lock().tx;
                if (action == "begin" && tx != "idle") || (action != "begin" && tx == "idle") {
                    return Ok(ok(json!(tx)));
                }
                let sql = match action {
                    "begin" => "BEGIN",
                    "commit" => "COMMIT",
                    _ => "ROLLBACK",
                };
                self.exec(sql, Vec::new()).await?;
                self.settle().await?;
                Ok(ok(json!(self.st.lock().tx)))
            }
            "previewEdits" => Ok(match self.build_edits(op.get("req").unwrap_or(&Value::Null)).await? {
                Err(v) => v,
                Ok((statements, _)) => ok(json!({ "sql": sqlite_edit_preview(&statements), "statements": statements.len() })),
            }),
            "applyEdits" => self.apply_edits(op.get("req").unwrap_or(&Value::Null)).await,
            "cellValue" => self.cell_value(op.get("req").unwrap_or(&Value::Null)).await,
            _ => Ok(fail("invalid", None, None)),
        }
    }

    // ── cancel ─────────────────────────────────────────────────────────────────

    /// Stops the running statement: the interrupt flag and `sqlite3_interrupt` first (a row loop or a lock wait stops at
    /// once); a statement still running after kill_grace_ms ends with its thread.
    fn cancel(self: &Arc<Self>) -> bool {
        if let Some(r) = &self.st.lock().run {
            r.cancelled.store(true, Ordering::SeqCst);
        }
        if self.link.in_flight() == 0 {
            return false;
        }
        self.link.interrupt.store(true, Ordering::SeqCst);
        self.link.interrupt_now();
        let target = self.link.last_request();
        let me = Arc::downgrade(self);
        let grace = Duration::from_millis(self.opts.kill_grace_ms);
        self.rt.spawn(async move {
            tokio::time::sleep(grace).await;
            let Some(s) = me.upgrade() else { return };
            if !s.link.waiting(target) || s.ended() {
                return;
            }
            s.link.kill();
            {
                let mut st = s.st.lock();
                st.reopen = true;
                if let Some(mut o) = st.open.take() {
                    o.stop_timer();
                }
            }
            s.set_tx(false);
            s.out.notice(
                "SQLite: the statement did not stop, so its connection was closed and the file opened again (an open transaction was rolled back).",
            );
        });
        true
    }

    fn clear_interrupt(&self) {
        self.link.interrupt.store(false, Ordering::SeqCst);
    }

    fn begin_run(&self) -> Arc<Run> {
        let run = Arc::new(Run { cancelled: AtomicBool::new(false) });
        self.st.lock().run = Some(run.clone());
        self.clear_interrupt();
        run
    }

    fn end_run(&self, run: &Arc<Run>) {
        let mut st = self.st.lock();
        if st.run.as_ref().is_some_and(|r| Arc::ptr_eq(r, run)) {
            st.run = None;
        }
        drop(st);
        self.clear_interrupt();
    }

    // ── queries ────────────────────────────────────────────────────────────────

    async fn run_query(self: &Arc<Self>, req: &Value) {
        let started = self.now();
        let query_id = str_of(req, "queryId").to_owned();
        let run = self.begin_run();
        let override_ = req.get("readWrite") == Some(&Value::Bool(true)) && self.opts.read_only;
        let mut all_ok = true;
        let refuse = |code: &'static str, index: usize, all_ok: &mut bool| {
            *all_ok = false;
            self.out.port(PortMessage::StatementError {
                query_id: query_id.clone(),
                index,
                error: code,
                server: None,
                time_ms: self.since(started),
            });
        };
        let body: Result<(), Fail> = async {
            self.close_open().await;
            self.settle().await?;
            let spans = split_sql(str_of(req, "sql"), Dialect::Sqlite);
            let cap = num_of(req, "rowCap").filter(|n| !n.is_nan()).unwrap_or(limits::ROW_CAP as f64).floor();
            let row_cap = cap.min(limits::ROW_CAP_MAX as f64).max(1.0) as usize;
            if self.opts.read_only && !override_ {
                let active = self.st.lock().override_active;
                if active && !spans.iter().all(|s| sqlite_ends_transaction(&s.text)) {
                    refuse("inTransaction", 0, &mut all_ok);
                    return Ok(());
                }
                if let Some(bad) = spans.iter().position(|s| !sqlite_read_only_allows(&s.text)) {
                    refuse("readOnly", bad, &mut all_ok);
                    return Ok(());
                }
            }
            if override_ {
                if self.st.lock().tx != "idle" {
                    refuse("inTransaction", 0, &mut all_ok);
                    return Ok(());
                }
                self.exec("PRAGMA query_only = 0", Vec::new()).await?;
                self.st.lock().override_active = true;
            }
            let n = spans.len();
            for (i, span) in spans.iter().enumerate() {
                if run.cancelled.load(Ordering::SeqCst) || self.ended() {
                    break;
                }
                self.out.port(PortMessage::Statement { query_id: query_id.clone(), index: i, start: span.start, end: span.end });
                let t0 = self.now();
                if let Err(error) = self.statement(&query_id, i, &span.text, row_cap, i + 1 == n).await {
                    if self.ended() {
                        return Err(error);
                    }
                    all_ok = false;
                    let server = Self::server_of(&error, Some(&span.text));
                    let has_server = server.is_some();
                    self.out.port(PortMessage::StatementError {
                        query_id: query_id.clone(),
                        index: i,
                        error: self.code_of(&error),
                        server,
                        time_ms: self.since(t0),
                    });
                    if !req.get("continueOnError").is_some_and(js_truthy) || !has_server {
                        break;
                    }
                }
            }
            Ok(())
        }
        .await;
        if let Err(error) = body {
            all_ok = false;
            let code = if self.ended() { "dbFailed" } else { self.code_of(&error) };
            self.out.port(PortMessage::StatementError {
                query_id: query_id.clone(),
                index: 0,
                error: code,
                server: Self::server_of(&error, None),
                time_ms: self.since(started),
            });
        }
        if !self.ended() && self.settle().await.is_err() {
            all_ok = false;
        }
        self.end_run(&run);
        let cancelled = run.cancelled.load(Ordering::SeqCst);
        self.out.port(PortMessage::QueryEnd {
            query_id,
            ok: all_ok && !cancelled,
            cancelled,
            time_ms: self.since(started),
            tx: self.st.lock().tx,
        });
    }

    /// Reads up to `max` rows of an open cursor in engine batches, sending them on; whether more follow.
    async fn pump(
        self: &Arc<Self>,
        query_id: &str,
        index: usize,
        cursor: u64,
        first: Option<Answer>,
        max: usize,
    ) -> Result<(u64, bool), Fail> {
        let mut sent = 0usize;
        let mut chars = 0usize;
        let mut reply = first;
        loop {
            if let Some(r) = reply.take() {
                let n = r.rows.len();
                chars += r.rows.iter().flatten().map(DbValue::batch_chars).sum::<usize>();
                self.send_rows(query_id, index, r.rows);
                sent += n;
                if !r.more {
                    return Ok((sent as u64, false));
                }
                if sent >= max || chars >= limits::PAGE_CHARS {
                    return Ok((sent as u64, true));
                }
            }
            reply = Some(
                self.req(Request::Next { cursor, max: BATCH_ROWS.min(max.saturating_sub(sent)), max_chars: limits::CHUNK_CHARS })
                    .await?,
            );
        }
    }

    fn next_cursor(&self) -> u64 {
        let mut st = self.st.lock();
        st.cursor_seq += 1;
        st.cursor_seq
    }

    /// One statement. Its rows stream in batches; only a read that is the last statement of the run keeps its cursor open
    /// for "load more". Anything else with more rows than the cap is closed early (reported as truncated).
    async fn statement(
        self: &Arc<Self>,
        query_id: &str,
        index: usize,
        text: &str,
        row_cap: usize,
        last: bool,
    ) -> Result<(), Fail> {
        let t0 = self.now();
        let cursor = self.next_cursor();
        let first = self
            .req(Request::Start {
                cursor,
                sql: text.to_owned(),
                params: Vec::new(),
                max: BATCH_ROWS.min(row_cap),
                max_chars: limits::CHUNK_CHARS,
            })
            .await?;
        let keyword = first_keyword(text);
        let command = if !keyword.is_empty() {
            keyword
        } else if first.columns.is_some() {
            "SELECT".into()
        } else {
            "OK".into()
        };
        let Some(columns) = first.columns.clone() else {
            let changes =
                if matches!(command.as_str(), "INSERT" | "UPDATE" | "DELETE" | "REPLACE") { first.changes } else { None };
            self.out.port(PortMessage::StatementEnd {
                query_id: query_id.to_owned(),
                index,
                command,
                row_count: changes,
                rows: 0,
                has_more: false,
                truncated: false,
                time_ms: self.since(t0),
            });
            return Ok(());
        };
        if !columns.is_empty() {
            self.out.port(PortMessage::Columns { query_id: query_id.to_owned(), index, columns: Self::columns(&columns) });
        }
        let (sent, more) = match self.pump(query_id, index, cursor, Some(first), row_cap).await {
            Ok(r) => r,
            Err(e) => {
                self.link.request(Request::Close { cursor }).await;
                return Err(e);
            }
        };
        let keep = more && last && sqlite_is_read_statement(text);
        if more && !keep {
            self.link.request(Request::Close { cursor }).await;
            self.out.port(PortMessage::StatementEnd {
                query_id: query_id.to_owned(),
                index,
                command,
                row_count: None,
                rows: sent,
                has_more: false,
                truncated: true,
                time_ms: self.since(t0),
            });
            return Ok(());
        }
        self.out.port(PortMessage::StatementEnd {
            query_id: query_id.to_owned(),
            index,
            command,
            row_count: if keep { None } else { Some(sent) },
            rows: sent,
            has_more: keep,
            truncated: false,
            time_ms: self.since(t0),
        });
        if !keep {
            return Ok(());
        }
        {
            let mut st = self.st.lock();
            st.open_seq += 1;
            let id = st.open_seq;
            st.open = Some(OpenResult { id, query_id: query_id.to_owned(), index, cursor, sent, timer: None });
        }
        self.arm_idle();
        Ok(())
    }

    async fn fetch_more(self: &Arc<Self>, query_id: &str, count: f64) {
        let (open_id, index, cursor) = {
            let st = self.st.lock();
            match st.open.as_ref() {
                Some(o) if o.query_id == query_id => (o.id, o.index, o.cursor),
                _ => return,
            }
        };
        let n = if count.is_finite() { count.floor().min(limits::ROW_CAP_MAX as f64).max(1.0) as usize } else { 1 };
        let t0 = self.now();
        self.clear_interrupt();
        let is_mine = |st: &State| st.open.as_ref().is_some_and(|o| o.id == open_id);
        match self.pump(query_id, index, cursor, None, n).await {
            Ok((got, more)) => {
                let total = {
                    let mut st = self.st.lock();
                    match st.open.as_mut().filter(|o| o.id == open_id) {
                        Some(o) => {
                            o.sent += got;
                            o.sent
                        }
                        None => got,
                    }
                };
                self.out.port(PortMessage::StatementEnd {
                    query_id: query_id.to_owned(),
                    index,
                    command: "SELECT".into(),
                    row_count: if more { None } else { Some(total) },
                    rows: total,
                    has_more: more,
                    truncated: false,
                    time_ms: self.since(t0),
                });
                if more {
                    let mine = is_mine(&self.st.lock());
                    if mine {
                        self.arm_idle();
                    }
                } else {
                    {
                        let mut st = self.st.lock();
                        if is_mine(&st)
                            && let Some(mut o) = st.open.take()
                        {
                            o.stop_timer();
                        }
                    }
                    self.link.request(Request::Close { cursor }).await;
                    let _ = self.settle().await;
                }
            }
            Err(error) => {
                {
                    let mut st = self.st.lock();
                    if is_mine(&st)
                        && let Some(mut o) = st.open.take()
                    {
                        o.stop_timer();
                    }
                }
                let code = if self.ended() { "dbFailed" } else { self.code_of(&error) };
                self.out.port(PortMessage::StatementError {
                    query_id: query_id.to_owned(),
                    index,
                    error: code,
                    server: Self::server_of(&error, None),
                    time_ms: self.since(t0),
                });
                self.link.request(Request::Close { cursor }).await;
                if !self.ended() {
                    let _ = self.settle().await;
                }
            }
        }
        self.clear_interrupt();
    }

    // ── table pages ────────────────────────────────────────────────────────────

    async fn info(self: &Arc<Self>, schema: &str, table: &str, fresh: bool) -> Result<Option<Arc<TableInfo>>, Fail> {
        let id = format!("{schema}\0{table}");
        let cached =
            self.st.lock().keys.get(&id).filter(|(at, _)| at.elapsed() < Duration::from_secs(30)).map(|(_, info)| info.clone());
        if !fresh && let Some(info) = cached {
            return Ok(info);
        }
        let q: &dyn SqQuery = self;
        let info = meta::table_info(q, schema, table).await?.map(Arc::new);
        self.st.lock().keys.insert(id, (Instant::now(), info.clone()));
        Ok(info)
    }

    /// One page with PRAGMA query_only on (the filter is the user's own SQL).
    async fn run_page(self: &Arc<Self>, req: &Value) {
        let started = self.now();
        let query_id = str_of(req, "queryId").to_owned();
        let run = self.begin_run();
        let mut success = false;
        let error = |code: &'static str, server: Option<ServerError>| {
            self.out.port(PortMessage::StatementError {
                query_id: query_id.clone(),
                index: 0,
                error: code,
                server,
                time_ms: self.since(started),
            });
        };
        let body: Result<(), Fail> = async {
            self.close_open().await;
            self.settle().await?;
            if self.st.lock().tx != "idle" {
                error("inTransaction", None);
                return Ok(());
            }
            let info = self.info(str_of(req, "schema"), str_of(req, "table"), false).await?;
            let sql = match page_input(req).and_then(|input| {
                sqlite_page_sql(
                    &input,
                    info.as_ref().and_then(|i| i.edit_key.as_deref()),
                    info.as_ref().and_then(|i| i.rowid.as_deref()),
                )
            }) {
                Ok(sql) => sql,
                Err(_) => {
                    error("invalid", None);
                    return Ok(());
                }
            };
            self.out.port(PortMessage::Statement { query_id: query_id.clone(), index: 0, start: 0, end: 0 });
            let guard = !self.opts.read_only && !self.file_read_only.load(Ordering::SeqCst);
            if guard {
                self.exec("PRAGMA query_only = 1", Vec::new()).await?;
            }
            let cursor = self.next_cursor();
            let limit = num_of(req, "limit").unwrap_or(0.0).floor().max(0.0) as usize;
            let paged: Result<(u64, bool), Fail> = async {
                let first = self
                    .req(Request::Start {
                        cursor,
                        sql,
                        params: Vec::new(),
                        max: BATCH_ROWS.min(limit),
                        max_chars: limits::CHUNK_CHARS,
                    })
                    .await?;
                if let Some(cols) = first.columns.as_ref().filter(|c| !c.is_empty()) {
                    self.out.port(PortMessage::Columns { query_id: query_id.clone(), index: 0, columns: Self::columns(cols) });
                }
                self.pump(&query_id, 0, cursor, Some(first), limit).await
            }
            .await;
            self.link.request(Request::Close { cursor }).await;
            if guard {
                self.must_exec("PRAGMA query_only = 0").await?;
            }
            let (sent, more) = paged?;
            self.out.port(PortMessage::StatementEnd {
                query_id: query_id.clone(),
                index: 0,
                command: "SELECT".into(),
                row_count: Some(sent),
                rows: sent,
                has_more: more,
                truncated: false,
                time_ms: self.since(started),
            });
            success = true;
            Ok(())
        }
        .await;
        if let Err(e) = body {
            let code = if self.ended() { "dbFailed" } else { self.code_of(&e) };
            error(code, Self::server_of(&e, None));
        }
        self.end_run(&run);
        let cancelled = run.cancelled.load(Ordering::SeqCst);
        self.out.port(PortMessage::QueryEnd {
            query_id: query_id.clone(),
            ok: success,
            cancelled,
            time_ms: self.since(started),
            tx: self.st.lock().tx,
        });
    }

    // ── edits ──────────────────────────────────────────────────────────────────

    /// The statements of staged edits, or the answer that refuses them.
    async fn build_edits(
        self: &Arc<Self>,
        req: &Value,
    ) -> Result<Result<(Vec<crate::sql::sqlite::BuiltStatement>, Arc<TableInfo>), Value>, Fail> {
        let (schema, table) = (str_of(req, "schema"), str_of(req, "table"));
        let Some(info) = self.info(schema, table, true).await? else { return Ok(Err(fail("notFound", None, None))) };
        if info.kind != "table" {
            return Ok(Err(fail("noKey", None, None)));
        }
        let raw = req.get("edits").and_then(Value::as_array).cloned().unwrap_or_default();
        if raw.iter().any(|e| e.get("op").and_then(Value::as_str) != Some("insert")) && info.edit_key.is_none() {
            return Ok(Err(fail("noKey", None, None)));
        }
        let rowid = info.rowid.as_deref();
        let columns: Vec<ColumnMeta> = info
            .columns
            .iter()
            .filter(|c| Some(c.name.as_str()) != rowid)
            .map(|c| ColumnMeta { name: c.name.clone(), affinity: info.affinity(&c.name), generated: c.generated })
            .collect();
        let built = raw.iter().map(StagedEdit::from_json).collect::<Result<Vec<_>, _>>().and_then(|edits| {
            sqlite_edit_statements(schema, table, info.edit_key.as_deref(), &edits, &columns, info.rowid.as_deref())
        });
        match built {
            Ok(statements) => Ok(Ok((statements, info))),
            Err(e) => Ok(Err(fail(e.code(), None, None))),
        }
    }

    /// All edits in one transaction (BEGIN IMMEDIATE: the write lock first); an UPDATE or DELETE that does not hit exactly
    /// one row rolls everything back.
    async fn apply_edits(self: &Arc<Self>, req: &Value) -> Result<Value, Fail> {
        if self.opts.read_only {
            return Ok(fail("readOnly", None, None));
        }
        if self.st.lock().tx != "idle" {
            return Ok(fail("inTransaction", None, None));
        }
        let statements = match self.build_edits(req).await? {
            Ok((s, _)) => s,
            Err(v) => return Ok(v),
        };
        if let Err(e) = self.exec("BEGIN IMMEDIATE", Vec::new()).await {
            return Ok(self.fail_of(&e, None));
        }
        let rollback = || async {
            let _ = self.exec("ROLLBACK", Vec::new()).await;
        };
        let mut affected = 0u64;
        for s in &statements {
            let r = match self.exec(&s.sql, s.params.clone()).await {
                Ok(r) => r,
                Err(e) => {
                    rollback().await;
                    return Ok(self.fail_of(&e, Some(s.index)));
                }
            };
            let n = r.changes.unwrap_or(0);
            if s.op != EditOp::Insert && n != 1 {
                rollback().await;
                return Ok(fail("conflict", None, Some(s.index)));
            }
            affected += n;
        }
        if let Err(e) = self.exec("COMMIT", Vec::new()).await {
            rollback().await;
            return Ok(self.fail_of(&e, None));
        }
        if self.st.lock().tx != "idle" {
            return Ok(fail("dbFailed", None, None));
        }
        self.st.lock().keys.clear();
        Ok(ok(json!({ "affected": affected })))
    }

    async fn cell_value(self: &Arc<Self>, req: &Value) -> Result<Value, Fail> {
        let (schema, table) = (str_of(req, "schema"), str_of(req, "table"));
        let info = self.info(schema, table, false).await?;
        let Some((info, key)) = info.as_ref().and_then(|i| i.edit_key.as_ref().map(|k| (i, k))) else {
            return Ok(fail("noKey", None, None));
        };
        let key_fields = match req.get("key") {
            Some(Value::Object(m)) => js_fields(m),
            _ => return Ok(fail("invalid", None, None)),
        };
        let columns: Vec<ColumnMeta> = info
            .columns
            .iter()
            .map(|c| ColumnMeta { name: c.name.clone(), affinity: info.affinity(&c.name), generated: c.generated })
            .collect();
        let built = match sqlite_cell_sql(schema, table, str_of(req, "column"), &key_fields, key, &columns, info.rowid.as_deref())
        {
            Ok(b) => b,
            Err(_) => return Ok(fail("invalid", None, None)),
        };
        let rows = self.meta(&built.sql, built.params).await?;
        if rows.len() != 1 {
            return Ok(fail(if rows.is_empty() { "notFound" } else { "conflict" }, None, None));
        }
        Ok(match rows[0].first().cloned().flatten() {
            None => ok(Value::Null),
            Some(v) => ok(json!(unimux_core::utf16::slice(&v, 0, limits::FULL_VALUE_CHARS))),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(errcode: Option<i32>, message: &str) -> EngineError {
        EngineError { message: message.into(), errcode, code: None, interrupted: false }
    }

    #[test]
    fn engine_errors_map_to_the_ui_codes() {
        assert_eq!(sqlite_error_code(&e(Some(9), "interrupted")), "cancelled");
        assert_eq!(sqlite_error_code(&EngineError { interrupted: true, ..e(None, "interrupted") }), "cancelled");
        assert_eq!(sqlite_error_code(&e(Some(5), "database is locked")), "dbLocked");
        assert_eq!(sqlite_error_code(&e(Some(261), "database is locked")), "dbLocked");
        assert_eq!(sqlite_error_code(&e(Some(6), "table is locked")), "dbLocked");
        assert_eq!(sqlite_error_code(&e(Some(8), "x")), "readOnly");
        assert_eq!(sqlite_error_code(&e(Some(1), "Attempt to write a readonly database")), "readOnly");
        assert_eq!(sqlite_error_code(&e(Some(26), "file is not a database")), "dbNotSqlite");
        assert_eq!(sqlite_error_code(&e(Some(14), "unable to open database file")), "dbFileMissing");
        assert_eq!(sqlite_error_code(&e(Some(1811), "keep Ala")), "server");
        assert_eq!(sqlite_error_code(&e(None, "no worker")), "dbFailed");
        let s = sqlite_server_error(&e(Some(1), "near \"FRM\": syntax error"), Some("SELECT *\nFRM orders")).unwrap();
        assert_eq!(s.position, Some(10));
        assert_eq!(s.code, "SQLITE_1");
        assert!(sqlite_server_error(&e(None, "x"), None).is_none());
        assert!(sqlite_server_error(&EngineError { interrupted: true, ..e(Some(9), "x") }, None).is_none());
    }

    #[test]
    fn page_inputs_refuse_a_non_string_after() {
        assert!(page_input(&json!({ "schema": "main", "table": "t", "limit": 10, "after": [1] })).is_err());
        let p = page_input(&json!({ "schema": "main", "table": "t", "limit": 10.7, "sort": [{ "column": "a", "desc": true }] }))
            .unwrap();
        assert_eq!(p.limit, 10.7);
        assert_eq!(p.sort.unwrap()[0], Sort { column: "a".into(), desc: true });
    }
}
