//! D5: one connected Postgres session (1.1.4 src/dbhost/pgSession.ts). It runs its operations one at a time on its
//! [`PgClient`], streams rows to the renderer over the DB port in adaptive batches, keeps at most one read-only result
//! cursor open for "load more" (closed after DB_LIMITS.cursorIdleMs without a fetch), enforces read-only connections on
//! the client side too (plus `default_transaction_read_only`, with the per-run readWrite override), sets and restores a
//! run's statement timeout, tracks the transaction state from ReadyForQuery and cancels through `pg_cancel_backend` on a
//! side connection ([`PgCancel`]).
//!
//! D6 adds the catalog reads ([`super::meta`]: databases, schemas, objects, tableInfo, ddl), table pages inside a READ ONLY
//! transaction (keyset / offset, the edit key cached for 30 s), previewEdits / applyEdits (one transaction, every UPDATE and
//! DELETE must hit exactly one row) and cellValue.
//!
//! Differences in the plumbing (same messages): the client has no background reader, so the session reads what the
//! server sends between operations itself (notices of an open result, a FATAL error, the end of the connection:
//! [`PgOut::closed`]); a refused statement ends its exchange at once, so 1.1.4's `drain()` marker is not needed (the
//! client drops stray ReadyForQuery messages like the emit filter did).

use std::collections::HashMap;
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use futures::FutureExt;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};
use tokio::task::JoinHandle;
use zeroize::Zeroizing;

use super::cancel::cancel_backend;
use super::client::{CursorState, IdleEvent, PgClient, PgCursor, QueryEvents, TxStatus};
use super::connect::{Connector, PgTarget, js_floor_text};
use super::error::{ConnectError, OpenError};
use super::messages::{PgColumn, PgPortMessage, server_error_value};
use super::meta::{self, CatalogQuery, MetaError, PgRow};
use super::port::statement_error_code;
use crate::model::js_truthy;
use crate::sql::pg::{
    BuiltStatement, build_edit_statements, cell_sql, edit_preview, ends_transaction, first_keyword, is_read_statement, page_sql,
    read_only_allows, returns_rows, value_kind,
};
use crate::sql::split::split_sql;
use crate::sql::{Dialect, EditOp, PageSqlInput, StagedEdit, js_fields, limits};
use crate::wire::pg::{BackendKey, PgField, PgServerError, PgWireError, Row, parse_tag};
use crate::wire::value::{DbValue, node_utf8, to_value, utf16_head};

/// The names and categories of the built-in types (`init`); user types are looked up when a result names them.
pub const TYPES_SQL: &str = "SELECT oid, format_type(oid, NULL), typcategory FROM pg_type WHERE oid < 16384";
const USER_TYPES_SQL: &str = "SELECT t.oid, format_type(t.oid, NULL), COALESCE(b.typcategory, t.typcategory) FROM pg_type t LEFT JOIN pg_type b ON t.typtype = 'd' AND b.oid = t.typbasetype WHERE t.oid = ANY($1::oid[])";
const READ_ONLY_ON: &str = "SET default_transaction_read_only = on";
const READ_ONLY_OFF: &str = "SET default_transaction_read_only = off";
/// The first batch of a cursor (pgSession's `batch: 100`); later ones adapt to the row width.
const FIRST_BATCH: usize = 100;
/// Metadata operations that may wait behind each other (more answer `busy`).
const META_PENDING_MAX: usize = 4;
/// How long a table's edit key is reused for pages and cellValue (pgSession's `keys` cache).
const EDIT_KEY_TTL_MS: u64 = 30_000;

/// What the session reports (the host forwards it: port messages to the asking window, the rest to main).
pub trait PgOut: Send + Sync {
    fn port(&self, m: PgPortMessage);
    /// `dbTx`: "idle", "transaction" or "failed".
    fn tx(&self, tx: &'static str);
    /// `dbActivity`.
    fn activity(&self, busy: bool);
    /// A session setting could not be restored (it might be read-write or without its timeout), or the session task
    /// failed: the session must end (`dbFailed`).
    fn fatal(&self);
    /// The connection ended or broke on its own (pg's `error` / `end`): the host fails the session with `tunnel` when it
    /// runs through SSH, else `dbClosed`.
    fn closed(&self);
}

/// Cancels the statement of a backend (`sideConnection` + `cancelRequest` of host.ts); true when a cancel went out.
pub trait PgCancel: Send + Sync {
    fn cancel(&self, key: BackendKey) -> BoxFuture<'static, bool>;
}

/// The 1.1.4 cancel: `pg_cancel_backend` on a side connection (same endpoint, TLS mode and password, no questions),
/// else the protocol CancelRequest.
#[derive(Clone)]
pub struct SideCancel {
    pub connector: Arc<dyn Connector>,
    pub target: PgTarget,
    pub password: Option<Zeroizing<String>>,
}

impl PgCancel for SideCancel {
    fn cancel(&self, key: BackendKey) -> BoxFuture<'static, bool> {
        let me = self.clone();
        Box::pin(async move { cancel_backend(me.connector.as_ref(), &me.target, me.password.as_ref(), &key).await })
    }
}

/// `PgSessionOptions`.
#[derive(Clone)]
pub struct PgSessionOptions {
    pub read_only: bool,
    /// The connection's statement_timeout (ms; 0: none).
    pub statement_timeout_ms: f64,
    pub cursor_idle_ms: u64,
    pub cancel: Arc<dyn PgCancel>,
}

impl PgSessionOptions {
    pub fn new(read_only: bool, statement_timeout_ms: Option<f64>, cancel: Arc<dyn PgCancel>) -> Self {
        PgSessionOptions {
            read_only,
            statement_timeout_ms: statement_timeout_ms.unwrap_or(0.0),
            cursor_idle_ms: limits::CURSOR_IDLE_MS,
            cancel,
        }
    }
}

/// Why an operation failed.
#[derive(Debug)]
pub(crate) enum Fail {
    Wire(PgWireError),
    /// A setting that must hold could not be set: the session ended.
    Fatal,
}

impl From<PgWireError> for Fail {
    fn from(e: PgWireError) -> Self {
        Fail::Wire(e)
    }
}

impl Fail {
    fn server(&self) -> Option<&PgServerError> {
        match self {
            Fail::Wire(PgWireError::Server(e)) => Some(e),
            _ => None,
        }
    }
}

fn not_connected() -> Fail {
    Fail::Wire(PgWireError::Io(io::Error::new(io::ErrorKind::NotConnected, "Connection terminated")))
}

fn ok(value: Value) -> Value {
    json!({ "ok": true, "value": value })
}

fn fail(error: &str, server: Option<Value>) -> Value {
    let mut v = json!({ "ok": false, "error": error });
    if let Some(s) = server {
        v["server"] = s;
    }
    v
}

/// `fail(error, server, index)`: the index of the edit that failed comes after the server error.
fn fail_at(error: &str, server: Option<Value>, index: Option<usize>) -> Value {
    let mut v = fail(error, server);
    if let Some(i) = index {
        v["index"] = json!(i);
    }
    v
}

/// The answer of a catalog read: None is `notFound`, a refused name its `DbSqlError` code.
fn meta_answer(r: Result<Option<Value>, MetaError<Fail>>) -> Result<Value, Fail> {
    match r {
        Ok(Some(v)) => Ok(ok(v)),
        Ok(None) => Ok(fail("notFound", None)),
        Err(MetaError::Sql(e)) => Ok(fail(e.code(), None)),
        Err(MetaError::Query(e)) => Err(e),
    }
}

/// [`meta::CatalogQuery`] on a session's connection (`raw`).
struct Catalog<'a> {
    inner: &'a Inner,
    conn: &'a mut Conn,
}

impl CatalogQuery for Catalog<'_> {
    type Error = Fail;
    fn q<'a>(&'a mut self, sql: &'a str, params: &'a [String]) -> BoxFuture<'a, Result<Vec<PgRow>, Fail>> {
        Box::pin(async move {
            let p: Vec<Option<&str>> = params.iter().map(|v| Some(v.as_str())).collect();
            self.inner.raw(self.conn, sql, &p).await
        })
    }
}

fn str_of<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or("")
}

fn num_of(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

/// `Math.max(1, Math.min(DB_LIMITS.rowCapMax, Math.floor(n)))`.
fn clamp_rows(n: f64) -> usize {
    let f = n.floor();
    if f.is_nan() {
        return 1;
    }
    f.min(limits::ROW_CAP_MAX as f64).max(1.0) as usize
}

/// An open cursor's reading state (pgSession's `Reader`).
pub(crate) struct Reader {
    pub(crate) cursor: PgCursor,
    fields: Vec<PgField>,
    /// The first read happened (pg-cursor reports the fields with it).
    fields_known: bool,
    columns_sent: bool,
    buffered: Vec<Row>,
    pub(crate) done: bool,
    batch: usize,
}

impl Reader {
    /// Rows are left (unread or read ahead).
    pub(crate) fn more(&self) -> bool {
        !self.done || !self.buffered.is_empty()
    }
}

/// What a session operation holds while it runs: the client, the open result's reader and the type names.
pub(crate) struct Conn {
    pub(crate) client: Option<PgClient>,
    open_reader: Option<Reader>,
    types: HashMap<u32, (String, String)>,
    /// `schema\0table` -> (when, edit key): pages and cellValue reuse the key for [`EDIT_KEY_TTL_MS`].
    keys: HashMap<String, (u64, Option<Vec<String>>)>,
}

struct Run {
    cancelled: AtomicBool,
}

struct OpenResult {
    id: u64,
    query_id: String,
    index: usize,
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
    tx: TxStatus,
    pending: usize,
    /// Queries and fetchMore queued or running: metadata answers `busy` meanwhile.
    runs: usize,
    meta_pending: usize,
    open: Option<OpenResult>,
    run: Option<Arc<Run>>,
    cancel_requested: bool,
    ended: bool,
    /// The connection ended or broke and the host was told.
    closed: bool,
    /// Settings a run changed (read-only override, statement timeout); restored once no transaction or cursor is open.
    restore: Vec<String>,
    /// A read-only connection runs with writes allowed (its override run left a transaction open).
    override_active: bool,
    notice_target: Option<String>,
    open_seq: u64,
}

type Job = BoxFuture<'static, ()>;

pub(crate) struct Inner {
    opts: PgSessionOptions,
    out: Arc<dyn PgOut>,
    st: Mutex<State>,
    conn: Arc<AsyncMutex<Conn>>,
    queue: mpsc::UnboundedSender<Job>,
    task: Mutex<Option<JoinHandle<()>>>,
    rt: tokio::runtime::Handle,
    key: Option<BackendKey>,
    /// A statement is on the server right now (what cancel stops).
    in_flight: AtomicBool,
    born: Instant,
}

/// One Postgres session. Create it inside a tokio runtime ([`PgSession::start`]).
#[derive(Clone)]
pub struct PgSession {
    inner: Arc<Inner>,
}

/// Collects the last statement's fields and rows of a run (when asked) and sends notices to the run's target.
struct Sink<'a> {
    inner: &'a Inner,
    collect: bool,
    cur_fields: Option<Vec<PgField>>,
    cur_rows: Vec<Row>,
    fields: Option<Vec<PgField>>,
    rows: Vec<Row>,
}

impl<'a> Sink<'a> {
    fn new(inner: &'a Inner, collect: bool) -> Self {
        Sink { inner, collect, cur_fields: None, cur_rows: Vec::new(), fields: None, rows: Vec::new() }
    }
}

impl QueryEvents for Sink<'_> {
    fn fields(&mut self, fields: &[PgField]) {
        if self.collect {
            self.cur_fields = Some(fields.to_vec());
        }
    }
    fn row(&mut self, row: Row) {
        if self.collect {
            self.cur_rows.push(row);
        }
    }
    fn notice(&mut self, notice: PgServerError) {
        self.inner.notice(notice);
    }
    fn statement_end(&mut self) {
        if self.collect {
            self.fields = self.cur_fields.take();
            self.rows = std::mem::take(&mut self.cur_rows);
        }
    }
}

/// Built-in type names and categories by oid.
async fn load_types(client: &mut PgClient) -> Result<HashMap<u32, (String, String)>, PgWireError> {
    let statements = client.simple_query(TYPES_SQL, None).await?;
    let mut types = HashMap::new();
    for s in statements {
        if let Some(e) = s.error {
            return Err(PgWireError::Server(e));
        }
        for row in s.rows {
            add_type(&mut types, row.into_iter().map(|v| v.map(|b| node_utf8(&b))).collect());
        }
    }
    Ok(types)
}

fn add_type(types: &mut HashMap<u32, (String, String)>, row: Vec<Option<String>>) {
    let mut it = row.into_iter();
    let oid = it.next().flatten().and_then(|o| o.trim().parse::<u32>().ok());
    let name = it.next().flatten().unwrap_or_default();
    let category = it.next().flatten().unwrap_or_default();
    if let Some(oid) = oid {
        types.insert(oid, (name, category));
    }
}

enum Next {
    Job(Option<Job>),
    Idle(Result<IdleEvent, PgWireError>),
}

/// Waits for what the server sends while nothing runs; never returns once the connection is gone.
async fn watch(conn: &AsyncMutex<Conn>) -> Result<IdleEvent, PgWireError> {
    let mut g = conn.lock().await;
    match g.client.as_mut() {
        Some(c) if !c.is_broken() => c.idle_message().await,
        _ => std::future::pending().await,
    }
}

/// Runs the queued operations one at a time; between them it reads the connection (notices, its end).
async fn queue_loop(mut jobs: mpsc::UnboundedReceiver<Job>, conn: Arc<AsyncMutex<Conn>>, me: Weak<Inner>) {
    loop {
        let next = tokio::select! {
            biased;
            job = jobs.recv() => Next::Job(job),
            ev = watch(&conn) => Next::Idle(ev),
        };
        match next {
            Next::Job(None) => break,
            Next::Job(Some(job)) => {
                job.await;
                let broken = conn.lock().await.client.as_ref().is_none_or(PgClient::is_broken);
                if broken && let Some(s) = me.upgrade() {
                    s.report_closed();
                }
            }
            Next::Idle(ev) => {
                let Some(s) = me.upgrade() else { break };
                match ev {
                    Ok(IdleEvent::Notice(n)) => s.notice(n),
                    Ok(IdleEvent::Ready(tx)) => s.set_tx(tx),
                    Ok(IdleEvent::Error(_)) | Err(_) => s.report_closed(),
                }
            }
        }
    }
}

impl PgSession {
    /// Takes over a connected client (after `connect::open`): loads the built-in type names (`init`), then runs
    /// operations. A failed init ends the client and maps like a connect error (`mapConnectError`).
    pub async fn start(mut client: PgClient, opts: PgSessionOptions, out: Arc<dyn PgOut>) -> Result<PgSession, OpenError> {
        let types = match load_types(&mut client).await {
            Ok(t) => t,
            Err(e) => {
                client.end().await;
                return Err(OpenError::from_connect(&ConnectError::from_wire(e), false));
            }
        };
        let key = client.key().cloned();
        let tx = client.tx();
        let conn = Arc::new(AsyncMutex::new(Conn { client: Some(client), open_reader: None, types, keys: HashMap::new() }));
        let (queue, jobs) = mpsc::unbounded_channel::<Job>();
        let rt = tokio::runtime::Handle::current();
        let inner = Arc::new(Inner {
            opts,
            out,
            st: Mutex::new(State {
                tx,
                pending: 0,
                runs: 0,
                meta_pending: 0,
                open: None,
                run: None,
                cancel_requested: false,
                ended: false,
                closed: false,
                restore: Vec::new(),
                override_active: false,
                notice_target: None,
                open_seq: 0,
            }),
            conn: conn.clone(),
            queue,
            task: Mutex::new(None),
            rt: rt.clone(),
            key,
            in_flight: AtomicBool::new(false),
            born: Instant::now(),
        });
        let task = rt.spawn(queue_loop(jobs, conn, Arc::downgrade(&inner)));
        *inner.task.lock() = Some(task);
        Ok(PgSession { inner })
    }

    /// The transaction state ("idle", "transaction", "failed").
    pub fn tx(&self) -> &'static str {
        self.inner.st.lock().tx.as_str()
    }

    /// A statement runs, a result is open or operations wait (the idle disconnect leaves such a session alone).
    pub fn busy(&self) -> bool {
        let st = self.inner.st.lock();
        self.inner.in_flight.load(Ordering::SeqCst) || st.open.is_some() || st.pending > 0
    }

    /// BackendKeyData of the session's connection.
    pub fn key(&self) -> Option<&BackendKey> {
        self.inner.key.as_ref()
    }

    /// Ends the session: the run stops, queued operations are dropped and the connection says goodbye (Terminate).
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
        if let Some(t) = inner.task.lock().take() {
            t.abort();
        }
        let conn = inner.conn.clone();
        inner.rt.spawn(async move {
            let client = conn.lock().await.client.take();
            if let Some(c) = client {
                c.end().await;
            }
        });
    }

    /// One operation (`DbHostOp` without redis); the answer is a `DbResult`. query and fetchMore answer once accepted
    /// (their rows and their end go to the port); cancel runs at once; the rest waits its turn.
    pub fn handle(&self, op: &Value) -> BoxFuture<'static, Value> {
        self.inner.handle(op)
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

    fn set_tx(&self, tx: TxStatus) {
        let changed = {
            let mut st = self.st.lock();
            std::mem::replace(&mut st.tx, tx) != tx
        };
        if changed {
            self.out.tx(tx.as_str());
        }
    }

    fn sync_tx(&self, conn: &Conn) {
        if let Some(c) = conn.client.as_ref() {
            self.set_tx(c.tx());
        }
    }

    fn tx(&self) -> TxStatus {
        self.st.lock().tx
    }

    /// A notice goes to the run (or open result) it belongs to; outside of one it is dropped.
    fn notice(&self, n: PgServerError) {
        let target = self.st.lock().notice_target.clone();
        if let Some(query_id) = target
            && n.field(b'M').is_some()
        {
            self.out.port(PgPortMessage::Notice { query_id, notice: n });
        }
    }

    fn report_closed(&self) {
        {
            let mut st = self.st.lock();
            if st.ended || st.closed {
                return;
            }
            st.closed = true;
        }
        self.out.closed();
    }

    fn die(&self) {
        let first = {
            let mut st = self.st.lock();
            !std::mem::replace(&mut st.ended, true)
        };
        if first {
            self.out.fatal();
        }
    }

    fn code_of(&self, e: &Fail) -> &'static str {
        let (ended, cancel) = {
            let st = self.st.lock();
            (st.ended, st.cancel_requested)
        };
        statement_error_code(e.server(), ended, cancel)
    }

    /// `this.ended ? 'dbFailed' : this.codeOf(error)`.
    fn code_or_failed(&self, e: &Fail) -> &'static str {
        if self.ended() { "dbFailed" } else { self.code_of(e) }
    }

    fn fail_answer(&self, e: &Fail) -> Value {
        fail(self.code_or_failed(e), e.server().and_then(server_error_value))
    }

    // ── plumbing ───────────────────────────────────────────────────────────────

    /// A statement through the simple protocol: the last statement's fields, rows and tag; the first server error is
    /// returned as the error (node-postgres rejects the query with it).
    pub(crate) async fn simple(
        &self,
        conn: &mut Conn,
        sql: &str,
    ) -> Result<(Option<Vec<PgField>>, Vec<Row>, Option<String>), Fail> {
        let mut sink = Sink::new(self, true);
        let r = match conn.client.as_mut() {
            Some(c) => c.simple_query_with(sql, &mut sink).await,
            None => return Err(not_connected()),
        };
        self.sync_tx(conn);
        let ends = r?;
        if let Some(e) = ends.iter().find_map(|e| e.error.clone()) {
            return Err(Fail::Wire(PgWireError::Server(e)));
        }
        let tag = ends.last().and_then(|e| e.tag.clone());
        Ok((sink.fields, sink.rows, tag))
    }

    pub(crate) async fn exec(&self, conn: &mut Conn, sql: &str) -> Result<(), Fail> {
        self.simple(conn, sql).await.map(|_| ())
    }

    /// `raw(text, values)`: rows as text (simple protocol without parameters, else one extended statement).
    pub(crate) async fn raw(
        &self,
        conn: &mut Conn,
        sql: &str,
        params: &[Option<&str>],
    ) -> Result<Vec<Vec<Option<String>>>, Fail> {
        let rows = if params.is_empty() {
            self.simple(conn, sql).await?.1
        } else {
            let mut sink = Sink::new(self, true);
            let r = match conn.client.as_mut() {
                Some(c) => c.query_params(sql, params, &mut sink).await,
                None => return Err(not_connected()),
            };
            self.sync_tx(conn);
            let end = r?;
            if let Some(e) = end.error {
                return Err(Fail::Wire(PgWireError::Server(e)));
            }
            std::mem::take(&mut sink.cur_rows)
        };
        Ok(rows.into_iter().map(|r| r.into_iter().map(|v| v.map(|b| node_utf8(&b))).collect()).collect())
    }

    /// A setting that must hold; when it cannot be set the session ends.
    pub(crate) async fn must(&self, conn: &mut Conn, sql: &str) -> Result<(), Fail> {
        match self.exec(conn, sql).await {
            Ok(()) => Ok(()),
            Err(_) => {
                self.st.lock().ended = true;
                self.out.fatal();
                Err(Fail::Fatal)
            }
        }
    }

    /// Runs the queued restores once nothing holds the connection (no transaction, no cursor).
    pub(crate) async fn settle(&self, conn: &mut Conn) -> Result<(), Fail> {
        let restore = {
            let mut st = self.st.lock();
            if st.tx != TxStatus::Idle || st.open.is_some() || st.restore.is_empty() {
                return Ok(());
            }
            std::mem::take(&mut st.restore)
        };
        for sql in restore {
            self.must(conn, &sql).await?;
        }
        self.st.lock().override_active = false;
        Ok(())
    }

    /// Sets read-only again for read-only connections (a function a statement called may have switched it off).
    pub(crate) async fn reassert(&self, conn: &mut Conn) -> Result<(), Fail> {
        {
            let st = self.st.lock();
            if st.tx != TxStatus::Idle || st.open.is_some() || st.override_active {
                return Ok(());
            }
        }
        if self.opts.read_only {
            self.must(conn, READ_ONLY_ON).await?;
        }
        Ok(())
    }

    async fn columns(&self, conn: &mut Conn, fields: &[PgField], can_query: bool) -> Vec<PgColumn> {
        let mut unknown: Vec<u32> = Vec::new();
        for f in fields {
            if !conn.types.contains_key(&f.type_oid) && !unknown.contains(&f.type_oid) {
                unknown.push(f.type_oid);
            }
        }
        if !unknown.is_empty() && can_query {
            // node-postgres writes a JS array as `{"1","2"}`
            let list: Vec<String> = unknown.iter().map(|o| format!("\"{o}\"")).collect();
            let arr = format!("{{{}}}", list.join(","));
            if let Ok(rows) = self.raw(conn, USER_TYPES_SQL, &[Some(arr.as_str())]).await {
                for row in rows {
                    add_type(&mut conn.types, row);
                }
            }
        }
        fields
            .iter()
            .map(|f| {
                let t = conn.types.get(&f.type_oid);
                let table_oid = (f.table_oid != 0).then_some(f.table_oid);
                PgColumn {
                    name: f.name.clone(),
                    type_oid: f.type_oid,
                    type_name: t.map(|t| t.0.clone()).unwrap_or_else(|| f.type_oid.to_string()),
                    kind: value_kind(i64::from(f.type_oid), t.map(|t| t.1.as_str())).as_str(),
                    table_oid,
                    column_number: (table_oid.is_some() && f.column_id != 0).then_some(f.column_id),
                }
            })
            .collect()
    }

    /// Rows to the port in chunks of at most chunkRows rows or about chunkChars characters; the characters sent.
    pub(crate) fn send_rows(&self, query_id: &str, index: usize, rows: Vec<Row>) -> usize {
        let mut chunk: Vec<Vec<DbValue>> = Vec::new();
        let mut chars = 0usize;
        let mut total = 0usize;
        for row in rows {
            let values: Vec<DbValue> = row.iter().map(|v| to_value(v.as_deref(), false)).collect();
            chars += values.iter().map(DbValue::batch_chars).sum::<usize>();
            chunk.push(values);
            if chunk.len() >= limits::CHUNK_ROWS || chars >= limits::CHUNK_CHARS {
                self.out.port(PgPortMessage::Rows { query_id: query_id.to_owned(), index, rows: std::mem::take(&mut chunk) });
                total += chars;
                chars = 0;
            }
        }
        if !chunk.is_empty() {
            self.out.port(PgPortMessage::Rows { query_id: query_id.to_owned(), index, rows: chunk });
        }
        total + chars
    }

    /// Opens a cursor (rows are read by [`Inner::pump`]).
    pub(crate) async fn reader(&self, conn: &mut Conn, sql: &str, params: &[Option<&str>]) -> Result<Reader, Fail> {
        let Some(c) = conn.client.as_mut() else { return Err(not_connected()) };
        let mut sink = Sink::new(self, false);
        self.in_flight.store(true, Ordering::SeqCst);
        let r = c.cursor_open(sql, params, &mut sink).await;
        self.in_flight.store(false, Ordering::SeqCst);
        self.sync_tx(conn);
        let cursor = r?;
        let fields = cursor.fields.clone();
        Ok(Reader {
            cursor,
            fields,
            fields_known: false,
            columns_sent: false,
            buffered: Vec::new(),
            done: false,
            batch: FIRST_BATCH,
        })
    }

    async fn read(&self, conn: &mut Conn, r: &mut Reader, count: usize) -> Result<Vec<Row>, Fail> {
        let Some(c) = conn.client.as_mut() else { return Err(not_connected()) };
        let mut sink = Sink::new(self, false);
        self.in_flight.store(true, Ordering::SeqCst);
        let got = c.cursor_read(&mut r.cursor, count.min(i32::MAX as usize) as i32, &mut sink).await;
        self.in_flight.store(false, Ordering::SeqCst);
        self.sync_tx(conn);
        r.fields_known = true;
        Ok(got?.rows)
    }

    /// Ends a cursor before the connection is used again; errors are ignored (the connection is gone then).
    pub(crate) async fn close_cursor(&self, conn: &mut Conn, cursor: &mut PgCursor) {
        if cursor.state() != CursorState::Open {
            return;
        }
        if let Some(c) = conn.client.as_mut() {
            let mut sink = Sink::new(self, false);
            let _ = c.cursor_close(cursor, &mut sink).await;
        }
        self.sync_tx(conn);
    }

    async fn send_columns(&self, conn: &mut Conn, query_id: &str, index: usize, r: &mut Reader) {
        if r.columns_sent || !r.fields_known {
            return;
        }
        r.columns_sent = true;
        if !r.fields.is_empty() {
            let fields = r.fields.clone();
            let columns = self.columns(conn, &fields, r.done).await;
            self.out.port(PgPortMessage::Columns { query_id: query_id.to_owned(), index, columns });
        }
    }

    /// Reads and sends up to `max` rows in batches (smaller ones for wide rows), stopping early at DB_LIMITS.pageChars
    /// characters so a result of huge rows never sits in memory whole. Reads one row ahead to know whether more follow.
    pub(crate) async fn pump(
        &self,
        conn: &mut Conn,
        query_id: &str,
        index: usize,
        r: &mut Reader,
        max: usize,
    ) -> Result<usize, Fail> {
        let mut sent = 0usize;
        let mut chars = 0usize;
        while sent < max && r.more() && chars < limits::PAGE_CHARS {
            let rows = if !r.buffered.is_empty() {
                std::mem::take(&mut r.buffered)
            } else {
                let want = r.batch.min(max - sent);
                let rows = self.read(conn, r, want).await?;
                if rows.len() < want {
                    r.done = true;
                }
                rows
            };
            self.send_columns(conn, query_id, index, r).await;
            if !rows.is_empty() {
                sent += rows.len();
                chars += self.send_rows(query_id, index, rows);
                let per_row = (chars as f64 / sent as f64).max(1.0);
                r.batch = ((limits::CHUNK_CHARS as f64 / per_row).floor() as usize).clamp(1, limits::CHUNK_ROWS);
            }
        }
        if !r.done && r.buffered.is_empty() && sent >= max {
            let rows = self.read(conn, r, 1).await?;
            if rows.is_empty() {
                r.done = true;
            } else {
                r.buffered = rows;
            }
        }
        self.send_columns(conn, query_id, index, r).await;
        Ok(sent)
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
                        let conn = s.conn.clone();
                        let mut conn = conn.lock().await;
                        s.close_open(&mut conn).await;
                        let _ = s.settle(&mut conn).await;
                    }
                })
            });
            drop(s);
            done.await;
        }));
    }

    /// Closes the open result cursor (the connection is needed for something else, or nobody fetched for a while).
    pub(crate) async fn close_open(&self, conn: &mut Conn) {
        let open = {
            let mut st = self.st.lock();
            let Some(mut open) = st.open.take() else { return };
            open.stop_timer();
            open
        };
        if let Some(mut r) = conn.open_reader.take() {
            self.close_cursor(conn, &mut r.cursor).await;
        }
        self.out.port(PgPortMessage::ResultClosed { query_id: open.query_id, index: open.index });
    }

    /// Runs `f` after everything queued before it; the session reports busy while anything is queued or running. None:
    /// it panicked or the session ended before it ran.
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
                Err(_) => me.die(),
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

    /// A query or fetchMore: counted so metadata refuses with `busy` instead of piling up behind it.
    fn serial_run(self: &Arc<Self>, f: impl FnOnce(Arc<Inner>, &mut Conn) -> BoxFuture<'_, ()> + Send + 'static) {
        self.st.lock().runs += 1;
        let done = self.serial(move |me| {
            Box::pin(async move {
                let conn = me.conn.clone();
                let mut conn = conn.lock().await;
                f(me.clone(), &mut conn).await;
                me.st.lock().runs -= 1;
            })
        });
        self.rt.spawn(done);
    }

    // ── operations ─────────────────────────────────────────────────────────────

    fn handle(self: &Arc<Self>, op: &Value) -> BoxFuture<'static, Value> {
        let ready = |v: Value| -> BoxFuture<'static, Value> { Box::pin(async move { v }) };
        if self.ended() {
            return ready(fail("noSession", None));
        }
        let name = op.get("op").and_then(Value::as_str).unwrap_or("");
        match name {
            "cancel" => {
                let me = self.clone();
                Box::pin(async move { ok(json!(me.cancel().await)) })
            }
            "query" => {
                let req = op.get("req").cloned().unwrap_or(Value::Null);
                self.serial_run(move |me, conn| Box::pin(async move { me.run_query(conn, &req).await }));
                ready(ok(json!(true)))
            }
            "fetchMore" => {
                let query_id = str_of(op, "queryId").to_owned();
                let count = num_of(op, "count").unwrap_or(f64::NAN);
                {
                    let mut st = self.st.lock();
                    match st.open.as_mut() {
                        Some(o) if o.query_id == query_id => o.stop_timer(),
                        _ => return ready(fail("notFound", None)),
                    }
                }
                self.serial_run(move |me, conn| Box::pin(async move { me.fetch_more(conn, &query_id, count).await }));
                ready(ok(json!(true)))
            }
            "closeResult" => {
                let query_id = str_of(op, "queryId").to_owned();
                let done = self.serial(move |me| {
                    Box::pin(async move {
                        let conn = me.conn.clone();
                        let mut conn = conn.lock().await;
                        if me.st.lock().open.as_ref().is_some_and(|o| o.query_id == query_id) {
                            me.close_open(&mut conn).await;
                            me.settle(&mut conn).await?;
                        }
                        Ok::<_, Fail>(ok(json!(true)))
                    })
                });
                Box::pin(async move {
                    match done.await {
                        Some(Ok(v)) => v,
                        _ => fail("dbFailed", None),
                    }
                })
            }
            "tablePage" => {
                let req = op.get("req").cloned().unwrap_or(Value::Null);
                self.serial_run(move |me, conn| Box::pin(async move { me.run_page(conn, &req).await }));
                ready(ok(json!(true)))
            }
            _ => {
                {
                    let mut st = self.st.lock();
                    if st.runs > 0 || st.meta_pending >= META_PENDING_MAX {
                        return ready(fail("busy", None));
                    }
                    st.meta_pending += 1;
                }
                let op = op.clone();
                let done = self.serial(move |me| {
                    Box::pin(async move {
                        let conn = me.conn.clone();
                        let mut conn = conn.lock().await;
                        let r = async {
                            me.close_open(&mut conn).await;
                            me.settle(&mut conn).await?;
                            me.meta_op(&mut conn, &op).await
                        }
                        .await;
                        me.st.lock().meta_pending -= 1;
                        match r {
                            Ok(v) => v,
                            Err(e) => me.fail_answer(&e),
                        }
                    })
                });
                Box::pin(async move { done.await.unwrap_or_else(|| fail("dbFailed", None)) })
            }
        }
    }

    async fn meta_op(&self, conn: &mut Conn, op: &Value) -> Result<Value, Fail> {
        match str_of(op, "op") {
            "transaction" => {
                let action = str_of(op, "action");
                if action == "begin" {
                    self.reassert(conn).await?;
                }
                let sql = match action {
                    "begin" => "BEGIN",
                    "commit" => "COMMIT",
                    _ => "ROLLBACK",
                };
                self.exec(conn, sql).await?;
                self.settle(conn).await?;
                Ok(ok(json!(self.tx().as_str())))
            }
            "databases" => meta_answer(meta::list_databases(&mut self.catalog(conn)).await.map(Some)),
            "schemas" => meta_answer(meta::list_schemas(&mut self.catalog(conn)).await.map(Some)),
            "objects" => meta_answer(meta::list_objects(&mut self.catalog(conn), str_of(op, "schema")).await.map(Some)),
            "tableInfo" => {
                let info = meta::table_info(&mut self.catalog(conn), str_of(op, "schema"), str_of(op, "name")).await;
                meta_answer(info.map(|i| i.map(|i| i.to_json())))
            }
            "ddl" => {
                let ddl = meta::object_ddl(
                    &mut self.catalog(conn),
                    str_of(op, "schema"),
                    str_of(op, "name"),
                    str_of(op, "kind"),
                    op.get("args").and_then(Value::as_str),
                )
                .await;
                meta_answer(ddl.map(|d| d.map(Value::String)))
            }
            "previewEdits" => {
                let req = op.get("req").cloned().unwrap_or(Value::Null);
                Ok(match self.build_edits(conn, &req).await? {
                    Ok(statements) => ok(json!({ "sql": edit_preview(&statements), "statements": statements.len() })),
                    Err(answer) => answer,
                })
            }
            "applyEdits" => self.apply_edits(conn, op.get("req").unwrap_or(&Value::Null)).await,
            "cellValue" => self.cell_value(conn, op.get("req").unwrap_or(&Value::Null)).await,
            _ => Ok(fail("invalid", None)),
        }
    }

    // ── catalog, pages and edits (D6) ──────────────────────────────────────────

    /// The catalog reads of [`meta`] on this session's connection.
    fn catalog<'a>(&'a self, conn: &'a mut Conn) -> Catalog<'a> {
        Catalog { inner: self, conn }
    }

    /// `tableInfo` on the session's connection (None: no such table).
    async fn table_info(&self, conn: &mut Conn, schema: &str, table: &str) -> Result<Option<meta::PgTableInfo>, Fail> {
        match meta::table_info(&mut self.catalog(conn), schema, table).await {
            Ok(info) => Ok(info),
            Err(MetaError::Query(e)) => Err(e),
            // tableInfo builds no names; kept for completeness
            Err(MetaError::Sql(_)) => Ok(None),
        }
    }

    /// `editKey`: the table's edit key, reused for 30 s.
    async fn edit_key(&self, conn: &mut Conn, schema: &str, table: &str) -> Result<Option<Vec<String>>, Fail> {
        let id = format!("{schema}\0{table}");
        if let Some((at, key)) = conn.keys.get(&id)
            && self.now().saturating_sub(*at) < EDIT_KEY_TTL_MS
        {
            return Ok(key.clone());
        }
        let key = self.table_info(conn, schema, table).await?.and_then(|i| i.edit_key);
        conn.keys.insert(id, (self.now(), key.clone()));
        Ok(key)
    }

    /// One statement with text parameters (simple protocol without them, like node-postgres); its command tag.
    async fn run_params(&self, conn: &mut Conn, sql: &str, params: &[Option<String>]) -> Result<Option<String>, Fail> {
        if params.is_empty() {
            return Ok(self.simple(conn, sql).await?.2);
        }
        let p: Vec<Option<&str>> = params.iter().map(Option::as_deref).collect();
        let mut sink = Sink::new(self, false);
        let r = match conn.client.as_mut() {
            Some(c) => c.query_params(sql, &p, &mut sink).await,
            None => return Err(not_connected()),
        };
        self.sync_tx(conn);
        let end = r?;
        if let Some(e) = end.error {
            return Err(Fail::Wire(PgWireError::Server(e)));
        }
        Ok(end.tag)
    }

    /// One page of a table inside a READ ONLY transaction, read in bounded batches. The filter is the user's own SQL:
    /// the READ ONLY transaction stops data changes, not every side effect of the functions it calls, so the session
    /// settings are set again after the page.
    async fn run_page(self: &Arc<Self>, conn: &mut Conn, req: &Value) {
        let started = self.now();
        let query_id = str_of(req, "queryId").to_owned();
        let run = self.begin_run(&query_id);
        let error = |code: &'static str, server: Option<PgServerError>| {
            self.out.port(PgPortMessage::StatementError {
                query_id: query_id.clone(),
                index: 0,
                error: code,
                server,
                time_ms: self.since(started),
            });
        };
        let body: Result<bool, Fail> = async {
            self.close_open(conn).await;
            self.settle(conn).await?;
            if self.tx() != TxStatus::Idle {
                error("inTransaction", None);
                return Ok(false);
            }
            self.reassert(conn).await?;
            let key = self.edit_key(conn, str_of(req, "schema"), str_of(req, "table")).await?;
            let built = match PageSqlInput::from_json(req).and_then(|input| page_sql(&input, key.as_deref())) {
                Ok(b) => b,
                Err(_) => {
                    error("invalid", None);
                    return Ok(false);
                }
            };
            self.out.port(PgPortMessage::Statement { query_id: query_id.clone(), index: 0, start: 0, end: 0 });
            self.exec(conn, "BEGIN READ ONLY").await?;
            let limit = num_of(req, "limit").unwrap_or(0.0).floor().max(0.0) as usize;
            let paged: Result<(u64, bool), Fail> = async {
                let params: Vec<Option<&str>> = built.params.iter().map(|p| Some(p.as_str())).collect();
                let mut reader = self.reader(conn, &built.sql, &params).await?;
                let sent = match self.pump(conn, &query_id, 0, &mut reader, limit).await {
                    Ok(n) => n as u64,
                    Err(e) => {
                        self.close_cursor(conn, &mut reader.cursor).await;
                        return Err(e);
                    }
                };
                let more = reader.more();
                self.close_cursor(conn, &mut reader.cursor).await;
                self.exec(conn, "COMMIT").await?;
                Ok((sent, more))
            }
            .await;
            let (sent, more) = match paged {
                Ok(v) => v,
                Err(e) => {
                    let _ = self.exec(conn, "ROLLBACK").await;
                    return Err(e);
                }
            };
            self.out.port(PgPortMessage::StatementEnd {
                query_id: query_id.clone(),
                index: 0,
                command: "SELECT".into(),
                row_count: Some(sent),
                rows: sent,
                has_more: more,
                truncated: false,
                time_ms: self.since(started),
            });
            Ok(true)
        }
        .await;
        let mut success = match body {
            Ok(done) => done,
            Err(e) => {
                error(self.code_or_failed(&e), e.server().cloned());
                false
            }
        };
        if !self.ended() {
            let restored: Result<(), Fail> = async {
                self.reassert(conn).await?;
                let own = self.opts.statement_timeout_ms;
                if own != 0.0 && !own.is_nan() && self.tx() == TxStatus::Idle {
                    self.must(conn, &format!("SET statement_timeout = {}", js_floor_text(own))).await?;
                }
                Ok(())
            }
            .await;
            if restored.is_err() {
                success = false;
            }
        }
        {
            let mut st = self.st.lock();
            if st.run.as_ref().is_some_and(|r| Arc::ptr_eq(r, &run)) {
                st.run = None;
            }
            st.notice_target = None;
        }
        let cancelled = run.cancelled.load(Ordering::SeqCst);
        self.out.port(PgPortMessage::QueryEnd {
            query_id,
            ok: success,
            cancelled,
            time_ms: self.since(started),
            tx: self.tx().as_str(),
        });
    }

    /// The statements of staged edits, or the answer that refuses them (notFound, noKey, invalid).
    async fn build_edits(&self, conn: &mut Conn, req: &Value) -> Result<Result<Vec<BuiltStatement>, Value>, Fail> {
        let (schema, table) = (str_of(req, "schema"), str_of(req, "table"));
        let Some(info) = self.table_info(conn, schema, table).await? else { return Ok(Err(fail("notFound", None))) };
        let raw = req.get("edits").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
        if raw.iter().any(|e| e.get("op").and_then(Value::as_str) != Some("insert")) && info.edit_key.is_none() {
            return Ok(Err(fail("noKey", None)));
        }
        let columns: Vec<String> = info.columns.iter().map(|c| c.name.clone()).collect();
        let generated: Vec<String> = info.columns.iter().filter(|c| c.generated).map(|c| c.name.clone()).collect();
        let types: HashMap<String, String> = info.columns.iter().map(|c| (c.name.clone(), c.type_name.clone())).collect();
        let built = raw.iter().map(StagedEdit::from_json).collect::<Result<Vec<_>, _>>().and_then(|edits| {
            build_edit_statements(schema, table, info.edit_key.as_deref(), &edits, Some(&columns), &generated, Some(&types))
        });
        Ok(built.map_err(|e| fail(e.code(), None)))
    }

    /// All edits in one transaction; an UPDATE or DELETE that does not hit exactly one row rolls everything back.
    async fn apply_edits(&self, conn: &mut Conn, req: &Value) -> Result<Value, Fail> {
        if self.opts.read_only {
            return Ok(fail("readOnly", None));
        }
        if self.tx() != TxStatus::Idle {
            return Ok(fail("inTransaction", None));
        }
        let built = match self.build_edits(conn, req).await? {
            Ok(b) => b,
            Err(answer) => return Ok(answer),
        };
        self.exec(conn, "BEGIN").await?;
        let mut affected = 0u64;
        for s in &built {
            self.in_flight.store(true, Ordering::SeqCst);
            let r = self.run_params(conn, &s.sql, &s.params).await;
            self.in_flight.store(false, Ordering::SeqCst);
            let tag = match r {
                Ok(tag) => tag,
                Err(e) => {
                    let _ = self.exec(conn, "ROLLBACK").await;
                    return Ok(fail_at(self.code_of(&e), e.server().and_then(server_error_value), Some(s.index)));
                }
            };
            let count = tag.as_deref().map(parse_tag).and_then(|(_, n)| n);
            if s.op != EditOp::Insert && count != Some(1) {
                let _ = self.exec(conn, "ROLLBACK").await;
                return Ok(fail_at("conflict", None, Some(s.index)));
            }
            affected += count.unwrap_or(0);
        }
        if let Err(e) = self.exec(conn, "COMMIT").await {
            let _ = self.exec(conn, "ROLLBACK").await;
            return Ok(fail(self.code_of(&e), e.server().and_then(server_error_value)));
        }
        // COMMIT of a failed transaction answers ROLLBACK without an error.
        if self.tx() != TxStatus::Idle {
            return Ok(fail("dbFailed", None));
        }
        conn.keys.clear();
        Ok(ok(json!({ "affected": affected })))
    }

    /// The whole value of one cell (up to DB_LIMITS.fullValueChars), found by the row's edit key.
    async fn cell_value(&self, conn: &mut Conn, req: &Value) -> Result<Value, Fail> {
        let (schema, table) = (str_of(req, "schema"), str_of(req, "table"));
        let Some(key) = self.edit_key(conn, schema, table).await? else { return Ok(fail("noKey", None)) };
        let Some(fields) = req.get("key").and_then(Value::as_object).map(js_fields) else {
            return Ok(fail("invalid", None));
        };
        let (sql, params) = match cell_sql(schema, table, str_of(req, "column"), &fields, &key) {
            Ok(b) => b,
            Err(_) => return Ok(fail("invalid", None)),
        };
        let p: Vec<Option<&str>> = params.iter().map(|v| Some(v.as_str())).collect();
        let rows = self.raw(conn, &sql, &p).await?;
        if rows.len() != 1 {
            return Ok(fail(if rows.is_empty() { "notFound" } else { "conflict" }, None));
        }
        Ok(ok(match rows[0].first().cloned().flatten() {
            None => Value::Null,
            Some(v) => json!(utf16_head(&v, limits::FULL_VALUE_CHARS).text),
        }))
    }

    // ── cancel ─────────────────────────────────────────────────────────────────

    /// Stops the running statement and the rest of its run; true when a cancel was sent.
    async fn cancel(&self) -> bool {
        if let Some(r) = &self.st.lock().run {
            r.cancelled.store(true, Ordering::SeqCst);
        }
        if !self.in_flight.load(Ordering::SeqCst) {
            return false;
        }
        self.st.lock().cancel_requested = true;
        let Some(key) = self.key.clone() else { return false };
        self.opts.cancel.cancel(key).await
    }

    // ── queries ────────────────────────────────────────────────────────────────

    fn begin_run(&self, query_id: &str) -> Arc<Run> {
        let run = Arc::new(Run { cancelled: AtomicBool::new(false) });
        let mut st = self.st.lock();
        st.run = Some(run.clone());
        st.cancel_requested = false;
        st.notice_target = Some(query_id.to_owned());
        run
    }

    fn end_run(&self, run: &Arc<Run>, query_id: &str) {
        let mut st = self.st.lock();
        st.notice_target = st.open.as_ref().map(|_| query_id.to_owned());
        if st.run.as_ref().is_some_and(|r| Arc::ptr_eq(r, run)) {
            st.run = None;
        }
    }

    async fn run_query(self: &Arc<Self>, conn: &mut Conn, req: &Value) {
        let started = self.now();
        let query_id = str_of(req, "queryId").to_owned();
        let run = self.begin_run(&query_id);
        let mut all_ok = true;
        let override_ = req.get("readWrite") == Some(&Value::Bool(true)) && self.opts.read_only;
        let refuse = |code: &'static str, index: usize, all_ok: &mut bool| {
            *all_ok = false;
            self.out.port(PgPortMessage::StatementError {
                query_id: query_id.clone(),
                index,
                error: code,
                server: None,
                time_ms: self.since(started),
            });
        };
        let body: Result<(), Fail> = async {
            self.close_open(conn).await;
            self.settle(conn).await?;
            let spans = split_sql(str_of(req, "sql"), Dialect::Postgres);
            let row_cap = clamp_rows(num_of(req, "rowCap").unwrap_or(limits::ROW_CAP as f64));
            if self.opts.read_only && !override_ {
                // An override's transaction is still open: only ending it may run without the override.
                let active = self.st.lock().override_active;
                if active && !spans.iter().all(|s| ends_transaction(&s.text)) {
                    refuse("inTransaction", 0, &mut all_ok);
                    return Ok(());
                }
                // Checked before anything runs: a refused statement anywhere stops the whole script.
                if let Some(bad) = spans.iter().position(|s| !read_only_allows(&s.text)) {
                    refuse("readOnly", bad, &mut all_ok);
                    return Ok(());
                }
            }
            if override_ {
                if self.tx() != TxStatus::Idle {
                    refuse("inTransaction", 0, &mut all_ok);
                    return Ok(());
                }
                self.exec(conn, READ_ONLY_OFF).await?;
                let mut st = self.st.lock();
                st.override_active = true;
                st.restore.push(READ_ONLY_ON.to_owned());
            }
            if let Some(t) = req.get("statementTimeoutMs").and_then(Value::as_f64)
                && t != self.opts.statement_timeout_ms
            {
                let ms = t.floor().min(limits::STATEMENT_TIMEOUT_MAX_MS as f64).max(0.0);
                self.exec(conn, &format!("SET statement_timeout = {}", js_floor_text(ms))).await?;
                // Without a connection setting the server's (or the role's) default comes back, not 0.
                let own = self.opts.statement_timeout_ms;
                let back = if own != 0.0 && !own.is_nan() {
                    format!("SET statement_timeout = {}", js_floor_text(own))
                } else {
                    "RESET statement_timeout".to_owned()
                };
                self.st.lock().restore.push(back);
            }
            let n = spans.len();
            for (i, span) in spans.iter().enumerate() {
                if run.cancelled.load(Ordering::SeqCst) || self.ended() {
                    break;
                }
                // A function a statement called may have switched read-only off for the session: set again first.
                if !override_ {
                    self.reassert(conn).await?;
                }
                self.out.port(PgPortMessage::Statement {
                    query_id: query_id.clone(),
                    index: i,
                    start: span.start,
                    end: span.end,
                });
                let t0 = self.now();
                if let Err(error) = self.statement(conn, &query_id, i, &span.text, row_cap, i + 1 == n).await {
                    if self.ended() {
                        return Err(error);
                    }
                    all_ok = false;
                    let server = error.server().cloned();
                    let has_server = server.as_ref().is_some_and(|e| super::error::is_server_code(e.code()));
                    self.out.port(PgPortMessage::StatementError {
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
            self.out.port(PgPortMessage::StatementError {
                query_id: query_id.clone(),
                index: 0,
                error: self.code_or_failed(&error),
                server: error.server().cloned(),
                time_ms: self.since(started),
            });
        }
        if !self.ended() {
            let settled = match self.settle(conn).await {
                Ok(()) if !override_ => self.reassert(conn).await,
                r => r,
            };
            if settled.is_err() {
                all_ok = false;
            }
        }
        self.end_run(&run, &query_id);
        let cancelled = run.cancelled.load(Ordering::SeqCst);
        self.out.port(PgPortMessage::QueryEnd {
            query_id,
            ok: all_ok && !cancelled,
            cancelled,
            time_ms: self.since(started),
            tx: self.tx().as_str(),
        });
    }

    /// One statement. Row-returning ones go through a cursor read in bounded batches; only a read-only statement that is
    /// the last of the run keeps its cursor open for "load more". Any other (... RETURNING, CALL, EXECUTE, or an earlier
    /// statement) is read up to the cap and closed at once (its changes commit now), reported as truncated when rows
    /// were left.
    async fn statement(
        self: &Arc<Self>,
        conn: &mut Conn,
        query_id: &str,
        index: usize,
        text: &str,
        row_cap: usize,
        last: bool,
    ) -> Result<(), Fail> {
        let t0 = self.now();
        if !returns_rows(text) {
            self.in_flight.store(true, Ordering::SeqCst);
            let r = self.simple(conn, text).await;
            self.in_flight.store(false, Ordering::SeqCst);
            let (fields, mut rows, tag) = r?;
            let total = rows.len();
            if let Some(fields) = fields.filter(|f| !f.is_empty()) {
                let columns = self.columns(conn, &fields, true).await;
                self.out.port(PgPortMessage::Columns { query_id: query_id.to_owned(), index, columns });
                rows.truncate(row_cap);
                self.send_rows(query_id, index, rows);
            }
            let (command, row_count) = tag.as_deref().map(parse_tag).unwrap_or((None, None));
            self.out.port(PgPortMessage::StatementEnd {
                query_id: query_id.to_owned(),
                index,
                command: command.unwrap_or_default(),
                row_count,
                rows: total.min(row_cap) as u64,
                has_more: false,
                truncated: total > row_cap,
                time_ms: self.since(t0),
            });
            return Ok(());
        }
        let mut reader = self.reader(conn, text, &[]).await?;
        let sent = match self.pump(conn, query_id, index, &mut reader, row_cap).await {
            Ok(n) => n as u64,
            Err(e) => {
                self.close_cursor(conn, &mut reader.cursor).await;
                return Err(e);
            }
        };
        let more = reader.more();
        let keep = more && last && is_read_statement(text);
        if more && !keep {
            self.close_cursor(conn, &mut reader.cursor).await;
            let keyword = first_keyword(text);
            self.out.port(PgPortMessage::StatementEnd {
                query_id: query_id.to_owned(),
                index,
                command: if keyword.is_empty() { "SELECT".into() } else { keyword },
                row_count: None,
                rows: sent,
                has_more: false,
                truncated: true,
                time_ms: self.since(t0),
            });
            return Ok(());
        }
        let (command, count) = reader.cursor.tag.as_deref().map(parse_tag).unwrap_or((None, None));
        let command = command.unwrap_or_default();
        let row_count = if keep {
            None
        } else if command == "SELECT" {
            Some(sent)
        } else {
            Some(count.unwrap_or(sent))
        };
        self.out.port(PgPortMessage::StatementEnd {
            query_id: query_id.to_owned(),
            index,
            command: if keep { "SELECT".into() } else { command },
            row_count,
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
            st.open = Some(OpenResult { id, query_id: query_id.to_owned(), index, sent, timer: None });
        }
        conn.open_reader = Some(reader);
        self.arm_idle();
        Ok(())
    }

    async fn fetch_more(self: &Arc<Self>, conn: &mut Conn, query_id: &str, count: f64) {
        let index = match self.st.lock().open.as_ref() {
            Some(o) if o.query_id == query_id => o.index,
            _ => return,
        };
        let Some(mut reader) = conn.open_reader.take() else { return };
        let n = clamp_rows(count);
        let t0 = self.now();
        {
            let mut st = self.st.lock();
            st.cancel_requested = false;
            st.notice_target = Some(query_id.to_owned());
        }
        let r: Result<(), Fail> = async {
            let sent = self.pump(conn, query_id, index, &mut reader, n).await? as u64;
            let has_more = reader.more();
            let total = {
                let mut st = self.st.lock();
                match st.open.as_mut() {
                    Some(o) => {
                        o.sent += sent;
                        o.sent
                    }
                    None => sent,
                }
            };
            // The last Execute's CommandComplete counts only its own rows: a SELECT's total is what was sent.
            self.out.port(PgPortMessage::StatementEnd {
                query_id: query_id.to_owned(),
                index,
                command: "SELECT".into(),
                row_count: if has_more { None } else { Some(total) },
                rows: total,
                has_more,
                truncated: false,
                time_ms: self.since(t0),
            });
            if has_more {
                return Ok(());
            }
            if let Some(mut o) = self.st.lock().open.take() {
                o.stop_timer();
            }
            self.settle(conn).await?;
            self.reassert(conn).await
        }
        .await;
        match r {
            Ok(()) => {
                if reader.more() && self.st.lock().open.is_some() {
                    conn.open_reader = Some(reader);
                    self.arm_idle();
                }
            }
            Err(error) => {
                if let Some(mut o) = self.st.lock().open.take() {
                    o.stop_timer();
                }
                self.out.port(PgPortMessage::StatementError {
                    query_id: query_id.to_owned(),
                    index,
                    error: self.code_or_failed(&error),
                    server: error.server().cloned(),
                    time_ms: self.since(t0),
                });
                self.close_cursor(conn, &mut reader.cursor).await;
                if !self.ended() {
                    let _ = self.settle(conn).await;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn row_caps_follow_js() {
        assert_eq!(clamp_rows(0.0), 1);
        assert_eq!(clamp_rows(10.9), 10);
        assert_eq!(clamp_rows(1e9), limits::ROW_CAP_MAX);
        assert_eq!(clamp_rows(-5.0), 1);
    }

    #[test]
    fn type_rows() {
        let mut t = HashMap::new();
        add_type(&mut t, vec![Some("23".into()), Some("integer".into()), Some("N".into())]);
        add_type(&mut t, vec![Some("x".into()), Some("bad".into()), None]);
        add_type(&mut t, vec![Some("16390".into()), None, None]);
        assert_eq!(t.get(&23), Some(&("integer".into(), "N".into())));
        assert_eq!(t.get(&16_390), Some(&(String::new(), String::new())));
        assert_eq!(t.len(), 2);
    }
}
