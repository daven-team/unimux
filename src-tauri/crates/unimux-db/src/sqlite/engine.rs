//! The SQLite engine of one session (1.1.4: src/dbhost/sqliteWorker.ts, an eval'd worker thread per session holding its
//! node:sqlite connection). Here it is a plain thread per session holding a bundled SQLite connection (rusqlite opens and
//! configures it; statements and cursors use the C API directly, so a cursor can stay open between requests). It knows
//! statements, cursors and rows only ([`super::session`] builds the SQL and keeps the session's rules). Values leave it as
//! the text the grid shows: integers in full, reals in their shortest JS form (ryu-js), bytes as "\x..." hex, long ones cut
//! to `cell_chars` UTF-16 units with their full length.
//!
//! [`EngineLink`] is the session's side: requests in order with one answer each, the interrupt flag (checked between rows
//! and in the busy handler) plus `sqlite3_interrupt` for a step that runs long, and ending a thread whose statement does not
//! stop (abandon and open again: the old thread ends with its connection once the step returns).

use std::collections::HashMap;
use std::ffi::{CStr, c_char, c_int};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr::{NonNull, null_mut};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Weak, mpsc};
use std::time::Duration;

use parking_lot::Mutex;
use rusqlite::config::DbConfig;
use rusqlite::{Connection, InterruptHandle, OpenFlags, ffi};
use tokio::sync::oneshot;

use crate::sql::sqlite::SqliteParam;
use crate::wire::value::{DbValue, hex_text, text_value};

/// A result column as node:sqlite's `columns()` gives it (`SqliteColumnOut`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ColumnOut {
    pub name: String,
    /// The declared type (null for an expression).
    pub decl_type: Option<String>,
    pub table: Option<String>,
    pub column: Option<String>,
}

/// `SqliteWorkerError`: what SQLite (or the engine) said.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineError {
    pub message: String,
    /// The extended result code (`sqlite3_extended_errcode`); None: not an SQLite error.
    pub errcode: Option<i32>,
    pub code: Option<String>,
    pub interrupted: bool,
}

impl EngineError {
    pub fn other(message: &str) -> Self {
        EngineError { message: message.to_owned(), errcode: None, code: None, interrupted: false }
    }

    fn interrupted(message: &str) -> Self {
        EngineError { message: message.to_owned(), errcode: None, code: None, interrupted: true }
    }
}

/// `SqliteWorkerRequest`.
#[derive(Debug, Clone)]
pub enum Request {
    Open {
        path: String,
        read_only: bool,
        busy_ms: u64,
        cell_chars: usize,
    },
    /// One statement read whole (metadata, settings, edits): its rows untruncated, or what it changed.
    Exec {
        sql: String,
        params: Vec<SqliteParam>,
    },
    /// One statement of a run: its first rows, its cursor kept open while more follow.
    Start {
        cursor: u64,
        sql: String,
        params: Vec<SqliteParam>,
        max: usize,
        max_chars: usize,
    },
    Next {
        cursor: u64,
        max: usize,
        max_chars: usize,
    },
    Close {
        cursor: u64,
    },
    Shutdown,
}

/// The successful part of `SqliteWorkerReply`.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Answer {
    pub version: Option<String>,
    pub journal: Option<String>,
    /// None: the statement returns no rows (see `changes`).
    pub columns: Option<Vec<ColumnOut>>,
    pub rows: Vec<Vec<DbValue>>,
    pub more: bool,
    pub changes: Option<u64>,
    pub last_insert_rowid: Option<i64>,
}

/// `SqliteWorkerReply`: the answer or the error, and whether a transaction is open after it.
#[derive(Debug, Clone, PartialEq)]
pub struct Reply {
    pub in_tx: bool,
    pub result: Result<Answer, EngineError>,
}

impl Reply {
    fn failed(message: &str, interrupted: bool) -> Self {
        let e = if interrupted { EngineError::interrupted(message) } else { EngineError::other(message) };
        Reply { in_tx: false, result: Err(e) }
    }
}

/// Extra setup of every connection the engine opens (the tests add SQL functions with it).
pub type ConnSetup = Arc<dyn Fn(&Connection) + Send + Sync>;

/// A prepared statement, finalized when dropped (always before its connection: see [`Engine`]'s field order).
struct Stmt(NonNull<ffi::sqlite3_stmt>);

impl Stmt {
    fn ptr(&self) -> *mut ffi::sqlite3_stmt {
        self.0.as_ptr()
    }
}

impl Drop for Stmt {
    fn drop(&mut self) {
        // SAFETY: the statement was prepared on the engine's connection, which is still open (cursors are dropped before
        // it), and it is finalized exactly once.
        unsafe {
            ffi::sqlite3_finalize(self.ptr());
        }
    }
}

/// `peek`: the row read ahead to know whether more follow (it goes out first next time).
struct Cursor {
    stmt: Stmt,
    peek: Option<Vec<DbValue>>,
}

/// `cellChars` of the 1.1.4 worker: null 4, text its length, a cut value its head's length.
fn value_chars(v: &DbValue) -> usize {
    v.batch_chars()
}

fn lossy(p: *const c_char) -> Option<String> {
    if p.is_null() {
        return None;
    }
    // SAFETY: SQLite returns a NUL-terminated string that stays valid until the next call on the statement.
    Some(unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
}

/// JS `String(n)` of a real; the 1.1.4 worker wrote infinities as "Inf" / "-Inf".
fn real_text(n: f64) -> String {
    if n.is_finite() {
        crate::sql::pg::js_number(n)
    } else if n > 0.0 {
        "Inf".into()
    } else if n < 0.0 {
        "-Inf".into()
    } else {
        "NaN".into()
    }
}

/// The SQLite default busy handler's waits (sqliteDefaultBusyCallback), checking the interrupt flag between them.
fn busy_wait(count: i32, timeout_ms: u64, interrupt: &AtomicBool) -> bool {
    const DELAYS: [u64; 12] = [1, 2, 5, 10, 15, 20, 25, 25, 25, 50, 50, 100];
    const TOTALS: [u64; 12] = [0, 1, 3, 8, 18, 33, 53, 78, 103, 128, 178, 228];
    if interrupt.load(Ordering::SeqCst) {
        return false;
    }
    let count = count.max(0) as usize;
    let (mut delay, prior) =
        if count < DELAYS.len() { (DELAYS[count], TOTALS[count]) } else { (100, TOTALS[11] + 100 * (count as u64 - 11)) };
    if prior + delay > timeout_ms {
        if timeout_ms <= prior {
            return false;
        }
        delay = timeout_ms - prior;
    }
    std::thread::sleep(Duration::from_millis(delay));
    !interrupt.load(Ordering::SeqCst)
}

/// SQLite is built with SQLITE_USE_URI: a file name starting with "file:" would be read as a URI (with options such as
/// `vfs=` or `mode=`), so such a (relative) name is opened as "./file:...".
fn plain_file_name(path: &str) -> String {
    if path.starts_with("file:") { format!("./{path}") } else { path.to_owned() }
}

/// One connection, its open cursors, the interrupt flag. Exported for the tests; the thread below drives it.
pub struct Engine {
    // Field order matters: the cursors' statements are finalized before the connection closes.
    cursors: HashMap<u64, Cursor>,
    conn: Option<Connection>,
    cut: usize,
    interrupt: Arc<AtomicBool>,
    setup: Option<ConnSetup>,
}

impl Drop for Engine {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl Engine {
    pub fn new(interrupt: Arc<AtomicBool>, setup: Option<ConnSetup>) -> Self {
        Engine { cursors: HashMap::new(), conn: None, cut: 64 * 1024, interrupt, setup }
    }

    fn db(&self) -> Result<*mut ffi::sqlite3, EngineError> {
        match &self.conn {
            // SAFETY: the handle is only used on this thread while the connection is open.
            Some(c) => Ok(unsafe { c.handle() }),
            None => Err(EngineError::other("not open")),
        }
    }

    fn in_tx(&self) -> bool {
        match self.db() {
            // SAFETY: an open connection.
            Ok(db) => unsafe { ffi::sqlite3_get_autocommit(db) == 0 },
            Err(_) => false,
        }
    }

    /// The interrupt handle of the open connection (the session's cancel calls it).
    pub fn interrupt_handle(&self) -> Option<InterruptHandle> {
        self.conn.as_ref().map(Connection::get_interrupt_handle)
    }

    fn check_interrupt(&self) -> Result<(), EngineError> {
        if self.interrupt.load(Ordering::SeqCst) { Err(EngineError::interrupted("interrupted")) } else { Ok(()) }
    }

    /// The connection's last error (node:sqlite: `sqlite3_extended_errcode` and `sqlite3_errmsg`).
    fn last_error(&self) -> EngineError {
        let Ok(db) = self.db() else { return EngineError::other("not open") };
        // SAFETY: an open connection.
        let (errcode, message) = unsafe { (ffi::sqlite3_extended_errcode(db), lossy(ffi::sqlite3_errmsg(db))) };
        let mut e = EngineError {
            message: message.unwrap_or_default(),
            errcode: Some(errcode),
            code: Some("ERR_SQLITE_ERROR".into()),
            interrupted: false,
        };
        // A lock wait the cancel ended in the busy handler is a cancel, not a lock.
        if matches!(errcode & 0xff, ffi::SQLITE_BUSY | ffi::SQLITE_LOCKED) && self.interrupt.load(Ordering::SeqCst) {
            e.interrupted = true;
        }
        e
    }

    pub fn handle(&mut self, req: Request) -> Reply {
        let result = match req {
            Request::Open { path, read_only, busy_ms, cell_chars } => self.open(&path, read_only, busy_ms, cell_chars),
            Request::Exec { sql, params } => self.exec(&sql, &params),
            Request::Start { cursor, sql, params, max, max_chars } => self.start(cursor, &sql, &params, max, max_chars),
            Request::Next { cursor, max, max_chars } => self.next(cursor, max, max_chars),
            Request::Close { cursor } => {
                self.close_cursor(cursor);
                Ok(Answer::default())
            }
            Request::Shutdown => {
                self.shutdown();
                return Reply { in_tx: false, result: Ok(Answer::default()) };
            }
        };
        let result = result.map_err(|mut e| {
            e.message = unimux_core::utf16::slice(&e.message, 0, 4000);
            if e.errcode.map(|c| c & 0xff) == Some(ffi::SQLITE_INTERRUPT) {
                e.interrupted = true;
            }
            e
        });
        Reply { in_tx: self.in_tx(), result }
    }

    fn open(&mut self, path: &str, read_only: bool, busy_ms: u64, cell_chars: usize) -> Result<Answer, EngineError> {
        self.shutdown();
        self.cut = cell_chars;
        // Never SQLITE_OPEN_CREATE: a moved or deleted file is never replaced by a new empty one.
        let flags = OpenFlags::SQLITE_OPEN_NO_MUTEX
            | if read_only { OpenFlags::SQLITE_OPEN_READ_ONLY } else { OpenFlags::SQLITE_OPEN_READ_WRITE };
        let mut conn = Connection::open_with_flags(plain_file_name(path), flags).map_err(|e| match e {
            rusqlite::Error::SqliteFailure(err, msg) => EngineError {
                message: msg.unwrap_or_else(|| err.to_string()),
                errcode: Some(err.extended_code),
                code: Some("ERR_SQLITE_ERROR".into()),
                interrupted: false,
            },
            other => EngineError::other(&other.to_string()),
        })?;
        let config = |c: &Connection, what: DbConfig, on: bool| {
            c.set_db_config(what, on).map(|_| ()).map_err(|e| EngineError::other(&e.to_string()))
        };
        // Double-quoted strings are names, never text (SQLITE_DQS off): a typo in a name is an error, not a string.
        config(&conn, DbConfig::SQLITE_DBCONFIG_DQS_DML, false)?;
        config(&conn, DbConfig::SQLITE_DBCONFIG_DQS_DDL, false)?;
        config(&conn, DbConfig::SQLITE_DBCONFIG_ENABLE_FKEY, true)?;
        let flag = self.interrupt.clone();
        conn.busy_handler(Some(move |count: i32| busy_wait(count, busy_ms, &flag)))
            .map_err(|e| EngineError::other(&e.to_string()))?;
        if let Some(setup) = &self.setup {
            setup(&conn);
        }
        self.conn = Some(conn);
        // A file that is not a database fails on its first read, not on open.
        let journal = self.read_one("PRAGMA journal_mode")?;
        self.read_one("SELECT count(*) FROM sqlite_schema")?;
        let version = self.read_one("SELECT sqlite_version()")?;
        Ok(Answer { version: Some(version), journal: Some(journal), ..Answer::default() })
    }

    /// `String(row[0] ?? '')` of a statement's first row.
    fn read_one(&mut self, sql: &str) -> Result<String, EngineError> {
        let Some(st) = self.prepare(sql)? else { return Ok(String::new()) };
        if !self.step(&st)? {
            return Ok(String::new());
        }
        Ok(match self.value(&st, 0, 0) {
            DbValue::Text(s) => s,
            _ => String::new(),
        })
    }

    /// None: the text holds no statement (only blanks or comments).
    fn prepare(&self, sql: &str) -> Result<Option<Stmt>, EngineError> {
        let db = self.db()?;
        let Ok(len) = c_int::try_from(sql.len()) else {
            return Err(EngineError {
                message: "string or blob too big".into(),
                errcode: Some(ffi::SQLITE_TOOBIG),
                code: Some("ERR_SQLITE_ERROR".into()),
                interrupted: false,
            });
        };
        let mut stmt = null_mut();
        // SAFETY: `sql` outlives the call and its byte length is given; the tail (anything after the first statement) is
        // ignored like node:sqlite does.
        let rc = unsafe { ffi::sqlite3_prepare_v2(db, sql.as_ptr().cast(), len, &mut stmt, std::ptr::null_mut()) };
        if rc != ffi::SQLITE_OK {
            if !stmt.is_null() {
                // SAFETY: a statement handed out despite the error is finalized once.
                unsafe { ffi::sqlite3_finalize(stmt) };
            }
            return Err(self.last_error());
        }
        Ok(NonNull::new(stmt).map(Stmt))
    }

    fn bind(&self, st: &Stmt, params: &[SqliteParam]) -> Result<(), EngineError> {
        for (i, p) in params.iter().enumerate() {
            let at = c_int::try_from(i + 1).unwrap_or(c_int::MAX);
            // SAFETY: a live statement; text and blob bytes are copied by SQLite (SQLITE_TRANSIENT).
            let rc = unsafe {
                match p {
                    SqliteParam::Null => ffi::sqlite3_bind_null(st.ptr(), at),
                    SqliteParam::Integer(n) => ffi::sqlite3_bind_int64(st.ptr(), at, *n),
                    SqliteParam::Real(f) => ffi::sqlite3_bind_double(st.ptr(), at, *f),
                    SqliteParam::Text(s) => ffi::sqlite3_bind_text64(
                        st.ptr(),
                        at,
                        s.as_ptr().cast(),
                        s.len() as u64,
                        ffi::SQLITE_TRANSIENT(),
                        ffi::SQLITE_UTF8 as u8,
                    ),
                    // An empty byte string is an empty BLOB, never NULL.
                    SqliteParam::Blob(b) if b.is_empty() => ffi::sqlite3_bind_zeroblob(st.ptr(), at, 0),
                    SqliteParam::Blob(b) => {
                        ffi::sqlite3_bind_blob64(st.ptr(), at, b.as_ptr().cast(), b.len() as u64, ffi::SQLITE_TRANSIENT())
                    }
                }
            };
            if rc != ffi::SQLITE_OK {
                return Err(self.last_error());
            }
        }
        Ok(())
    }

    /// True: a row is ready; false: done.
    fn step(&self, st: &Stmt) -> Result<bool, EngineError> {
        // SAFETY: a live statement of the open connection.
        match unsafe { ffi::sqlite3_step(st.ptr()) } {
            ffi::SQLITE_ROW => Ok(true),
            ffi::SQLITE_DONE => Ok(false),
            _ => Err(self.last_error()),
        }
    }

    fn columns(&self, st: &Stmt) -> Vec<ColumnOut> {
        // SAFETY: a live statement; the column index is in range.
        unsafe {
            let n = ffi::sqlite3_column_count(st.ptr());
            (0..n)
                .map(|i| ColumnOut {
                    name: lossy(ffi::sqlite3_column_name(st.ptr(), i)).unwrap_or_default(),
                    decl_type: lossy(ffi::sqlite3_column_decltype(st.ptr(), i)),
                    table: lossy(ffi::sqlite3_column_table_name(st.ptr(), i)),
                    column: lossy(ffi::sqlite3_column_origin_name(st.ptr(), i)),
                })
                .collect()
        }
    }

    /// One value as its text form; `cut` > 0: a longer text arrives cut with its full length.
    fn value(&self, st: &Stmt, i: c_int, cut: usize) -> DbValue {
        // SAFETY: a statement on a row; the pointer / length pairs are read before the next call on the statement.
        let text = unsafe {
            match ffi::sqlite3_column_type(st.ptr(), i) {
                ffi::SQLITE_NULL => return DbValue::Null,
                ffi::SQLITE_INTEGER => ffi::sqlite3_column_int64(st.ptr(), i).to_string(),
                ffi::SQLITE_FLOAT => real_text(ffi::sqlite3_column_double(st.ptr(), i)),
                ffi::SQLITE_BLOB => {
                    let p = ffi::sqlite3_column_blob(st.ptr(), i);
                    let n = ffi::sqlite3_column_bytes(st.ptr(), i).max(0) as usize;
                    if p.is_null() || n == 0 { hex_text(&[]) } else { hex_text(std::slice::from_raw_parts(p.cast::<u8>(), n)) }
                }
                _ => {
                    let p = ffi::sqlite3_column_text(st.ptr(), i);
                    let n = ffi::sqlite3_column_bytes(st.ptr(), i).max(0) as usize;
                    if p.is_null() || n == 0 {
                        String::new()
                    } else {
                        String::from_utf8_lossy(std::slice::from_raw_parts(p, n)).into_owned()
                    }
                }
            }
        };
        if cut > 0 { text_value(text, cut) } else { DbValue::Text(text) }
    }

    fn row(&self, st: &Stmt, cut: usize) -> Vec<DbValue> {
        // SAFETY: a live statement.
        let n = unsafe { ffi::sqlite3_data_count(st.ptr()) };
        (0..n).map(|i| self.value(st, i, cut)).collect()
    }

    fn changes(&self) -> Result<Answer, EngineError> {
        let db = self.db()?;
        // SAFETY: an open connection.
        let (changes, rowid) = unsafe { (ffi::sqlite3_changes64(db), ffi::sqlite3_last_insert_rowid(db)) };
        Ok(Answer { changes: Some(changes.max(0) as u64), last_insert_rowid: Some(rowid), ..Answer::default() })
    }

    /// Runs a statement without result columns.
    fn run(&mut self, st: Option<&Stmt>) -> Result<Answer, EngineError> {
        if let Some(st) = st {
            self.step(st)?;
        }
        self.changes()
    }

    fn exec(&mut self, sql: &str, params: &[SqliteParam]) -> Result<Answer, EngineError> {
        let st = self.prepare(sql)?;
        let Some(st) = st else { return self.run(None) };
        self.bind(&st, params)?;
        let columns = self.columns(&st);
        if columns.is_empty() {
            return self.run(Some(&st));
        }
        let mut rows = Vec::new();
        while self.step(&st)? {
            self.check_interrupt()?;
            rows.push(self.row(&st, 0));
        }
        Ok(Answer { columns: Some(columns), rows, more: false, ..Answer::default() })
    }

    fn start(
        &mut self,
        cursor: u64,
        sql: &str,
        params: &[SqliteParam],
        max: usize,
        max_chars: usize,
    ) -> Result<Answer, EngineError> {
        self.close_cursor(cursor);
        let st = self.prepare(sql)?;
        let Some(st) = st else { return self.run(None) };
        self.bind(&st, params)?;
        let columns = self.columns(&st);
        if columns.is_empty() {
            return self.run(Some(&st));
        }
        self.cursors.insert(cursor, Cursor { stmt: st, peek: None });
        let page = self.next(cursor, max, max_chars)?;
        Ok(Answer { columns: Some(columns), ..page })
    }

    fn read_row(&mut self, cursor: u64) -> Result<Option<Vec<DbValue>>, EngineError> {
        let Some(c) = self.cursors.get_mut(&cursor) else { return Ok(None) };
        if let Some(p) = c.peek.take() {
            return Ok(Some(p));
        }
        self.check_interrupt()?;
        let c = &self.cursors[&cursor];
        if self.step(&c.stmt)? { Ok(Some(self.row(&c.stmt, self.cut))) } else { Ok(None) }
    }

    /// Up to `max` rows (fewer once about `max_chars` characters are read); `more` is exact: one row is read ahead.
    fn next(&mut self, cursor: u64, max: usize, max_chars: usize) -> Result<Answer, EngineError> {
        if !self.cursors.contains_key(&cursor) {
            return Ok(Answer { more: false, ..Answer::default() });
        }
        let mut rows = Vec::new();
        let mut chars = 0usize;
        let result = (|| {
            while rows.len() < max.max(1) && chars < max_chars {
                let Some(row) = self.read_row(cursor)? else { return Ok(false) };
                chars += row.iter().map(value_chars).sum::<usize>();
                rows.push(row);
            }
            match self.read_row(cursor)? {
                None => Ok(false),
                Some(ahead) => {
                    if let Some(c) = self.cursors.get_mut(&cursor) {
                        c.peek = Some(ahead);
                    }
                    Ok(true)
                }
            }
        })();
        match result {
            Ok(more) => {
                if !more {
                    self.close_cursor(cursor);
                }
                Ok(Answer { rows, more, ..Answer::default() })
            }
            Err(e) => {
                self.close_cursor(cursor);
                Err(e)
            }
        }
    }

    fn close_cursor(&mut self, cursor: u64) {
        // Finalizing ends the statement (its read lock on the file goes with it).
        self.cursors.remove(&cursor);
    }

    pub fn shutdown(&mut self) {
        self.cursors.clear();
        if let Some(conn) = self.conn.take() {
            // An open transaction is rolled back by closing; a failed close still frees the handle when dropped.
            let _ = conn.close();
        }
    }
}

// ── the link (the session's side of the thread) ─────────────────────────────

type Pending = Mutex<HashMap<u64, oneshot::Sender<Reply>>>;

struct WorkerShared {
    pending: Pending,
    handle: Mutex<Option<InterruptHandle>>,
    /// Set when the link let go of this thread (ended or shut down): it answers nothing more.
    gone: AtomicBool,
}

impl WorkerShared {
    /// Every request still waiting answers with `why`.
    fn flush(&self, why: &str, interrupted: bool) {
        let all: Vec<_> = self.pending.lock().drain().map(|(_, tx)| tx).collect();
        for tx in all {
            let _ = tx.send(Reply::failed(why, interrupted));
        }
    }
}

#[derive(Clone)]
struct Worker {
    tx: mpsc::Sender<(u64, Request)>,
    shared: Arc<WorkerShared>,
}

/// `EngineLink`: the thread of a session, its requests and the interrupt flag; ending it and starting it again.
pub struct EngineLink {
    worker: Mutex<Option<Worker>>,
    seq: AtomicU64,
    in_flight: AtomicUsize,
    /// The flag a row loop and the busy handler check (Atomics in 1.1.4).
    pub interrupt: Arc<AtomicBool>,
    killed: AtomicBool,
    died: Box<dyn Fn(String) + Send + Sync>,
    setup: Option<ConnSetup>,
}

struct InFlight<'a>(&'a AtomicUsize);

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

fn panic_text(p: &(dyn std::any::Any + Send)) -> String {
    p.downcast_ref::<&str>()
        .map(|s| (*s).to_owned())
        .or_else(|| p.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "the SQLite engine failed".into())
}

impl EngineLink {
    /// `died`: the thread ended on its own (a panic): the session cannot go on.
    pub fn new(died: Box<dyn Fn(String) + Send + Sync>, setup: Option<ConnSetup>) -> Arc<Self> {
        Arc::new(EngineLink {
            worker: Mutex::new(None),
            seq: AtomicU64::new(0),
            in_flight: AtomicUsize::new(0),
            interrupt: Arc::new(AtomicBool::new(false)),
            killed: AtomicBool::new(false),
            died,
            setup,
        })
    }

    pub fn alive(&self) -> bool {
        self.worker.lock().is_some()
    }

    /// Requests waiting for their answer right now.
    pub fn in_flight(&self) -> usize {
        self.in_flight.load(Ordering::SeqCst)
    }

    /// The newest request (a cancel ends the thread only for the request it saw).
    pub fn last_request(&self) -> u64 {
        self.seq.load(Ordering::SeqCst)
    }

    pub fn waiting(&self, id: u64) -> bool {
        self.worker.lock().as_ref().is_some_and(|w| w.shared.pending.lock().contains_key(&id))
    }

    /// A new engine thread.
    pub fn start(self: &Arc<Self>) {
        let (tx, rx) = mpsc::channel::<(u64, Request)>();
        let shared = Arc::new(WorkerShared {
            pending: Mutex::new(HashMap::new()),
            handle: Mutex::new(None),
            gone: AtomicBool::new(false),
        });
        let interrupt = self.interrupt.clone();
        let setup = self.setup.clone();
        let link = Arc::downgrade(self);
        let mine = shared.clone();
        let spawned =
            std::thread::Builder::new().name("unimux-sqlite".into()).spawn(move || serve(rx, mine, interrupt, setup, link));
        self.killed.store(false, Ordering::SeqCst);
        match spawned {
            Ok(_) => *self.worker.lock() = Some(Worker { tx, shared }),
            Err(e) => {
                *self.worker.lock() = None;
                (self.died)(e.to_string());
            }
        }
    }

    fn gone(&self, shared: &Arc<WorkerShared>, why: String) {
        {
            let mut w = self.worker.lock();
            if !w.as_ref().is_some_and(|w| Arc::ptr_eq(&w.shared, shared)) {
                return;
            }
            *w = None;
        }
        shared.flush(&why, self.killed.load(Ordering::SeqCst));
        if !self.killed.load(Ordering::SeqCst) {
            (self.died)(why);
        }
    }

    pub async fn request(&self, req: Request) -> Reply {
        let Some(w) = self.worker.lock().clone() else { return Reply::failed("no worker", false) };
        let id = self.seq.fetch_add(1, Ordering::SeqCst) + 1;
        self.in_flight.fetch_add(1, Ordering::SeqCst);
        let _guard = InFlight(&self.in_flight);
        let (tx, rx) = oneshot::channel();
        w.shared.pending.lock().insert(id, tx);
        if w.tx.send((id, req)).is_err() {
            w.shared.pending.lock().remove(&id);
            return Reply::failed("the SQLite worker ended", false);
        }
        drop(w);
        rx.await.unwrap_or_else(|_| Reply::failed("the SQLite worker ended", false))
    }

    /// Stops a step that runs long (`sqlite3_interrupt`; the flag stops row loops and lock waits).
    pub fn interrupt_now(&self) {
        if let Some(w) = self.worker.lock().as_ref()
            && let Some(h) = w.shared.handle.lock().as_ref()
        {
            h.interrupt();
        }
    }

    /// Ends the thread now: every request waiting for it answers "interrupted". The thread itself ends (closing its
    /// connection, which rolls back an open transaction) once its current step returns.
    pub fn kill(&self) {
        let Some(w) = self.worker.lock().take() else { return };
        self.killed.store(true, Ordering::SeqCst);
        w.shared.gone.store(true, Ordering::SeqCst);
        if let Some(h) = w.shared.handle.lock().as_ref() {
            h.interrupt();
        }
        w.shared.flush("interrupted", true);
    }

    /// Asks the thread to close the file and end (2 s, then it is let go like [`EngineLink::kill`]).
    pub async fn shutdown(&self) {
        let Some(w) = self.worker.lock().clone() else { return };
        self.killed.store(true, Ordering::SeqCst);
        let answered = tokio::time::timeout(Duration::from_secs(2), self.request(Request::Shutdown)).await.is_ok();
        if !answered && let Some(h) = w.shared.handle.lock().as_ref() {
            h.interrupt();
        }
        w.shared.gone.store(true, Ordering::SeqCst);
        let mut cur = self.worker.lock();
        if cur.as_ref().is_some_and(|c| Arc::ptr_eq(&c.shared, &w.shared)) {
            *cur = None;
        }
    }
}

fn serve(
    rx: mpsc::Receiver<(u64, Request)>,
    shared: Arc<WorkerShared>,
    interrupt: Arc<AtomicBool>,
    setup: Option<ConnSetup>,
    link: Weak<EngineLink>,
) {
    let mut engine = Engine::new(interrupt, setup);
    let why = loop {
        let Ok((id, req)) = rx.recv() else { break None };
        if shared.gone.load(Ordering::SeqCst) {
            break None;
        }
        let shutdown = matches!(req, Request::Shutdown);
        let reply = match catch_unwind(AssertUnwindSafe(|| engine.handle(req))) {
            Ok(r) => r,
            Err(p) => break Some(panic_text(p.as_ref())),
        };
        *shared.handle.lock() = engine.interrupt_handle();
        let tx = shared.pending.lock().remove(&id);
        if let Some(tx) = tx {
            let _ = tx.send(reply);
        }
        if shutdown {
            break None;
        }
    };
    let _ = catch_unwind(AssertUnwindSafe(move || drop(engine)));
    *shared.handle.lock() = None;
    let why = why.unwrap_or_else(|| "the SQLite worker ended".into());
    match link.upgrade() {
        Some(link) => link.gone(&shared, why),
        None => shared.flush(&why, true),
    }
    // Anything that slipped in after the link let go.
    shared.flush("interrupted", true);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn engine() -> Engine {
        Engine::new(Arc::new(AtomicBool::new(false)), None)
    }

    fn texts(rows: &[Vec<DbValue>]) -> Vec<Vec<Option<String>>> {
        rows.iter()
            .map(|r| {
                r.iter()
                    .map(|v| match v {
                        DbValue::Null => None,
                        DbValue::Text(s) => Some(s.clone()),
                        DbValue::Trunc { head, chars } => Some(format!("{}...{chars}", head.text)),
                    })
                    .collect()
            })
            .collect()
    }

    fn file(dir: &tempfile::TempDir, name: &str, sql: &str) -> String {
        let path = dir.path().join(name);
        let c = Connection::open(&path).unwrap();
        c.execute_batch(sql).unwrap();
        drop(c);
        path.to_string_lossy().into_owned()
    }

    fn open(e: &mut Engine, path: &str) -> Answer {
        e.handle(Request::Open { path: path.into(), read_only: false, busy_ms: 300, cell_chars: 8 }).result.unwrap()
    }

    #[test]
    fn values_are_the_grid_text() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(&dir, "v.db", "CREATE TABLE t (a, b, c, d, e);");
        let mut e = engine();
        let opened = open(&mut e, &path);
        assert!(opened.version.unwrap().starts_with("3."));
        assert_eq!(opened.journal.as_deref(), Some("delete"));
        let r = e
            .handle(Request::Exec {
                sql: "SELECT 9223372036854775807, 0.1, 1e21, x'00ff', NULL, x'', 1.0, -0.0, 'abcdefghij', 9e999".into(),
                params: vec![],
            })
            .result
            .unwrap();
        assert_eq!(
            texts(&r.rows),
            vec![vec![
                Some("9223372036854775807".into()),
                Some("0.1".into()),
                Some("1e+21".into()),
                Some("\\x00ff".into()),
                None,
                Some("\\x".into()),
                Some("1".into()),
                Some("0".into()),
                Some("abcdefghij".into()),
                Some("Inf".into()),
            ]]
        );
        // a cursor cuts long values to cell_chars and keeps the full length
        let r = e
            .handle(Request::Start { cursor: 1, sql: "SELECT 'abcdefghij'".into(), params: vec![], max: 10, max_chars: 100 })
            .result
            .unwrap();
        assert_eq!(texts(&r.rows), vec![vec![Some("abcdefgh...10".into())]]);
        assert!(!r.more);
    }

    #[test]
    fn cursors_read_ahead_one_row_and_bind_parameters() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(
            &dir,
            "c.db",
            "CREATE TABLE t (x INTEGER, b BLOB); WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 5) INSERT INTO t (x) SELECT x FROM c;",
        );
        let mut e = engine();
        open(&mut e, &path);
        let first = e
            .handle(Request::Start {
                cursor: 7,
                sql: "SELECT x FROM t WHERE x > ? ORDER BY x".into(),
                params: vec![SqliteParam::Integer(1)],
                max: 2,
                max_chars: 1000,
            })
            .result
            .unwrap();
        assert_eq!(first.columns.as_ref().unwrap()[0].table.as_deref(), Some("t"));
        assert_eq!(first.columns.as_ref().unwrap()[0].decl_type.as_deref(), Some("INTEGER"));
        assert_eq!(texts(&first.rows), vec![vec![Some("2".into())], vec![Some("3".into())]]);
        assert!(first.more);
        let rest = e.handle(Request::Next { cursor: 7, max: 2, max_chars: 1000 }).result.unwrap();
        assert_eq!(texts(&rest.rows), vec![vec![Some("4".into())], vec![Some("5".into())]]);
        assert!(!rest.more, "exact: the last page knows nothing follows");
        let gone = e.handle(Request::Next { cursor: 7, max: 2, max_chars: 1000 }).result.unwrap();
        assert!(gone.rows.is_empty() && !gone.more);
        let ch = e
            .handle(Request::Exec {
                sql: "UPDATE t SET b = ? WHERE x = ?".into(),
                params: vec![SqliteParam::Blob(vec![]), SqliteParam::Integer(1)],
            })
            .result
            .unwrap();
        assert_eq!(ch.changes, Some(1));
        let r = e.handle(Request::Exec { sql: "SELECT typeof(b), length(b) FROM t WHERE x = 1".into(), params: vec![] });
        assert_eq!(texts(&r.result.unwrap().rows), vec![vec![Some("blob".into()), Some("0".into())]]);
    }

    #[test]
    fn errors_carry_the_extended_code_and_the_flag_interrupts_row_loops() {
        let dir = tempfile::tempdir().unwrap();
        let path = file(&dir, "e.db", "CREATE TABLE t (id INTEGER PRIMARY KEY);");
        let mut e = engine();
        open(&mut e, &path);
        let err = e.handle(Request::Exec { sql: "SELECT *\nFRM t".into(), params: vec![] }).result.unwrap_err();
        assert_eq!(err.errcode, Some(1));
        assert!(err.message.contains("near \"FRM\": syntax error"), "{}", err.message);
        let err = e.handle(Request::Exec { sql: "INSERT INTO t VALUES (1), (1)".into(), params: vec![] }).result.unwrap_err();
        assert_eq!(err.errcode, Some(ffi::SQLITE_CONSTRAINT_PRIMARYKEY));
        e.interrupt.store(true, Ordering::SeqCst);
        let err = e.handle(Request::Exec { sql: "SELECT 1".into(), params: vec![] }).result.unwrap_err();
        assert!(err.interrupted);
        e.interrupt.store(false, Ordering::SeqCst);
        let begin = e.handle(Request::Exec { sql: "BEGIN".into(), params: vec![] });
        assert!(begin.in_tx);
    }

    #[test]
    fn a_missing_file_is_never_created_and_junk_is_not_a_database() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing.db");
        let mut e = engine();
        let err = e
            .handle(Request::Open { path: missing.to_string_lossy().into(), read_only: false, busy_ms: 100, cell_chars: 10 })
            .result
            .unwrap_err();
        assert_eq!(err.errcode.map(|c| c & 0xff), Some(ffi::SQLITE_CANTOPEN));
        assert!(!missing.exists());
        let junk = dir.path().join("junk.db");
        std::fs::write(&junk, "this is not a database, just some text ".repeat(40)).unwrap();
        let err = e
            .handle(Request::Open { path: junk.to_string_lossy().into(), read_only: false, busy_ms: 100, cell_chars: 10 })
            .result
            .unwrap_err();
        assert_eq!(err.errcode, Some(ffi::SQLITE_NOTADB));
        assert_eq!(plain_file_name("file:x.db?vfs=y"), "./file:x.db?vfs=y");
    }

    #[test]
    fn the_busy_wait_follows_sqlite_and_stops_on_the_flag() {
        let flag = AtomicBool::new(false);
        assert!(!busy_wait(0, 0, &flag));
        assert!(busy_wait(0, 5, &flag));
        assert!(!busy_wait(12, 300, &flag), "228 + 100 * 1 + 100 > 300");
        flag.store(true, Ordering::SeqCst);
        assert!(!busy_wait(0, 5000, &flag));
    }
}
