//! One connected Redis session (src/dbhost/redisSession.ts `RedisSession`). Three connections at most: the main one for
//! browsing (SCAN, value pages, server views), opened at connect, whose drops are reported and retried 3 times (300 / 1000
//! / 2000 ms, nothing sent again); a lazily opened console connection (console commands and pattern counts / deletes, so a
//! slow command never blocks the key browser; D10 runs those operations on it); and the Pub/Sub subscriber (D10). Operations
//! of a connection run one at a time ([`Lane`]); each carries main's deadline and is skipped when it would start after it,
//! and a browsing operation that runs longer than `opTimeoutMs` (60 s) drops and reconnects the main connection (the
//! watchdog).
//!
//! D9 runs `databases`, `select`, `scan`, `keyInfo`, `read`, `readItem`, plus `info`, `slowlog`, `clients` and `cancel`.
//! `write`, `command`, `countPattern`, `deletePattern`, `subscribe`, `unsubscribe`, `pubsubState` and `publish` are D10's
//! and answer `unsupported` until it lands.

use std::collections::HashSet;
use std::future::Future;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use futures::future::{BoxFuture, join_all};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use super::connect::{ClientEvent, CmdError, ConnectError, RedisClient, js_head, map_server_error, server_code};
use super::data::{as_buffer, blob, blob_with_total, clamp, data_json, from_data, int, js_num, num, text, trim_partial_utf8};
use crate::redis_shared::{limits as L, parse_client_list, parse_info, parse_keyspace, stream_id_step};
use crate::wire::redis::{RETRY_DELAYS_MS, Raw};

/// `REDIS_LIMITS` as numbers the session can be given (tests use small ones).
#[derive(Debug, Clone)]
pub struct RedisLimits {
    pub scan_keys: f64,
    pub scan_count_max: f64,
    pub scan_count_default: f64,
    pub scan_budget_ms: i64,
    pub info_keys: usize,
    pub page_items: f64,
    pub item_bytes: usize,
    pub string_bytes: f64,
    pub string_bytes_max: f64,
    pub page_batch: f64,
    pub page_bytes: usize,
    pub op_timeout_ms: u64,
    pub slowlog_max: f64,
    pub reconnect_attempts: u32,
}

impl Default for RedisLimits {
    fn default() -> Self {
        Self {
            scan_keys: L::SCAN_KEYS as f64,
            scan_count_max: L::SCAN_COUNT_MAX as f64,
            scan_count_default: L::SCAN_COUNT_DEFAULT as f64,
            scan_budget_ms: L::SCAN_BUDGET_MS as i64,
            info_keys: L::INFO_KEYS,
            page_items: L::PAGE_ITEMS as f64,
            item_bytes: L::ITEM_BYTES,
            string_bytes: L::STRING_BYTES as f64,
            string_bytes_max: L::STRING_BYTES_MAX as f64,
            page_batch: L::PAGE_BATCH as f64,
            page_bytes: L::PAGE_BYTES,
            op_timeout_ms: L::OP_TIMEOUT_MS,
            slowlog_max: L::SLOWLOG_MAX as f64,
            reconnect_attempts: L::RECONNECT_ATTEMPTS,
        }
    }
}

/// Where a session reports to (`RedisSessionOut`).
pub trait RedisSessionOut: Send + Sync {
    /// A DB port message (Pub/Sub, D10).
    fn port(&self, m: Value);
    fn activity(&self, busy: bool);
    /// The connection dropped; attempt n of the reconnect is under way.
    fn reconnecting(&self, attempt: u32);
    fn reconnected(&self);
    /// The connection is gone for good (no more attempts).
    fn closed(&self, error: &str, message: Option<String>);
    fn database(&self, index: u32);
}

/// Opens another connection with the session's endpoint and login on DB n (the console and Pub/Sub ones).
pub type OpenConnection = Arc<dyn Fn(u32) -> BoxFuture<'static, Result<RedisClient, ConnectError>> + Send + Sync>;

pub struct RedisSessionOptions {
    /// The "db:<uuid>" id: Pub/Sub port messages carry it.
    pub session_id: String,
    pub read_only: bool,
    pub db_index: u32,
    pub open_connection: OpenConnection,
    pub via_tunnel: bool,
    pub limits: RedisLimits,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

/// The server's error reply as DbServerError.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerError {
    pub message: String,
    pub code: Option<String>,
}

impl ServerError {
    fn of(message: &str) -> Self {
        let m = js_head(message, 4000);
        let code = server_code(&m);
        Self { message: m, code }
    }

    fn json(&self) -> Value {
        let mut m = Map::new();
        m.insert("message".into(), Value::String(self.message.clone()));
        if let Some(c) = &self.code {
            m.insert("code".into(), Value::String(c.clone()));
        }
        Value::Object(m)
    }
}

/// Why an operation failed.
#[derive(Debug, Clone, PartialEq, Eq)]
enum OpError {
    /// A fixed code (`OpError` of the TS).
    Code(&'static str, Option<ServerError>),
    /// A server error reply.
    Reply(String),
    /// No reply (the connection dropped or was not there) or one the session cannot use.
    Conn,
}

impl From<CmdError> for OpError {
    fn from(e: CmdError) -> Self {
        match e {
            CmdError::Reply(m) => OpError::Reply(m),
            CmdError::Conn(_) => OpError::Conn,
        }
    }
}

type OpResult<T> = Result<T, OpError>;

fn reply_message(e: &OpError) -> &str {
    match e {
        OpError::Reply(m) => m,
        _ => "",
    }
}

fn contains_ci(hay: &str, needle: &str) -> bool {
    hay.to_ascii_lowercase().contains(needle)
}

/// `{ok: true, value}`.
pub fn ok(value: Value) -> Value {
    json!({ "ok": true, "value": value })
}

/// `{ok: false, error, server?}`.
pub fn fail(error: &str, server: Option<&ServerError>) -> Value {
    let mut m = Map::new();
    m.insert("ok".into(), Value::Bool(false));
    m.insert("error".into(), Value::String(error.into()));
    if let Some(s) = server {
        m.insert("server".into(), s.json());
    }
    Value::Object(m)
}

/// One connection's queue: one operation at a time (tokio's Mutex is fair, so operations run in arrival order).
#[derive(Default)]
struct Lane {
    lock: tokio::sync::Mutex<()>,
    pending: AtomicUsize,
}

const LENGTH_COMMANDS: [(&str, &[u8]); 6] =
    [("string", b"strlen"), ("hash", b"hlen"), ("list", b"llen"), ("set", b"scard"), ("zset", b"zcard"), ("stream", b"xlen")];

fn length_command(t: &str) -> Option<&'static [u8]> {
    LENGTH_COMMANDS.iter().find(|(n, _)| *n == t).map(|(_, c)| *c)
}

/// Console and pattern operations run on the console connection; everything else on the main one.
const CONSOLE_KINDS: [&str; 3] = ["command", "countPattern", "deletePattern"];
/// The operations D10 adds.
const LATER_KINDS: [&str; 8] =
    ["write", "command", "countPattern", "deletePattern", "subscribe", "unsubscribe", "pubsubState", "publish"];

struct State {
    ended: bool,
    db: u32,
    reconnect_attempt: u32,
    memory_usage: bool,
    scan_type: bool,
    /// A cancel stops every console operation enqueued before it (each op remembers the generation it was enqueued in).
    cancel_gen: u64,
    was_busy: bool,
    console: Option<(RedisClient, u32)>,
}

pub struct RedisSession {
    me: Weak<RedisSession>,
    client: RedisClient,
    opts: RedisSessionOptions,
    out: Arc<dyn RedisSessionOut>,
    state: Mutex<State>,
    main: Lane,
    console: Lane,
    console_opening: tokio::sync::Mutex<()>,
}

/// Decrements a lane's pending count when the operation ends, also when its future is dropped.
struct Pending<'a> {
    s: &'a RedisSession,
    lane: &'a Lane,
}

impl Drop for Pending<'_> {
    fn drop(&mut self) {
        self.lane.pending.fetch_sub(1, Ordering::SeqCst);
        self.s.changed();
    }
}

fn args(parts: &[&[u8]]) -> Vec<Vec<u8>> {
    parts.iter().map(|p| p.to_vec()).collect()
}

fn array(v: Raw) -> OpResult<Vec<Raw>> {
    match v {
        Raw::Array(a) => Ok(a),
        _ => Err(OpError::Conn),
    }
}

fn str_of<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

fn f64_of(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64)
}

impl RedisSession {
    /// The session over a connected main client: its retries are on from now (`control.enabled = true`).
    pub fn new(client: RedisClient, opts: RedisSessionOptions, out: Arc<dyn RedisSessionOut>) -> Arc<RedisSession> {
        let s = Arc::new_cyclic(|me| RedisSession {
            me: me.clone(),
            state: Mutex::new(State {
                ended: false,
                db: opts.db_index,
                reconnect_attempt: 0,
                memory_usage: true,
                scan_type: true,
                cancel_gen: 0,
                was_busy: false,
                console: None,
            }),
            client,
            opts,
            out,
            main: Lane::default(),
            console: Lane::default(),
            console_opening: tokio::sync::Mutex::new(()),
        });
        let weak = s.me.clone();
        s.client.set_retry(Some(Arc::new(move |attempt| {
            let s = weak.upgrade()?;
            {
                let mut st = s.state.lock();
                if st.ended || attempt > s.opts.limits.reconnect_attempts {
                    return None;
                }
                st.reconnect_attempt = attempt;
            }
            s.out.reconnecting(attempt);
            Some(RETRY_DELAYS_MS[(attempt as usize - 1).min(RETRY_DELAYS_MS.len() - 1)])
        })));
        let weak = s.me.clone();
        s.client.on_event(Arc::new(move |ev| {
            let Some(s) = weak.upgrade() else { return };
            match ev {
                ClientEvent::Ready => {
                    {
                        let mut st = s.state.lock();
                        if st.ended || st.reconnect_attempt == 0 {
                            return;
                        }
                        st.reconnect_attempt = 0;
                    }
                    s.out.reconnected();
                }
                ClientEvent::End => {
                    if s.state.lock().ended {
                        return;
                    }
                    let mapped = s
                        .client
                        .last_error()
                        .unwrap_or_else(|| ConnectError::new(if s.opts.via_tunnel { "tunnel" } else { "dbClosed" }));
                    let code = if mapped.code == "dbAuth" {
                        "dbAuth"
                    } else if s.opts.via_tunnel {
                        mapped.code
                    } else {
                        "dbClosed"
                    };
                    s.out.closed(code, mapped.server_message);
                }
            }
        }));
        s
    }

    fn now(&self) -> i64 {
        (self.opts.now)()
    }

    /// The DB index the session is on.
    pub fn current_db(&self) -> u32 {
        self.state.lock().db
    }

    pub fn is_ended(&self) -> bool {
        self.state.lock().ended
    }

    /// Ends the session: every connection closes, queued operations answer `noSession`.
    pub fn end(&self) {
        let console = {
            let mut st = self.state.lock();
            if st.ended {
                return;
            }
            st.ended = true;
            st.cancel_gen += 1;
            st.console.take()
        };
        self.client.set_retry(None);
        self.client.disconnect(false);
        if let Some((c, _)) = console {
            c.disconnect(false);
        }
    }

    fn changed(&self) {
        let busy = self.main.pending.load(Ordering::SeqCst) + self.console.pending.load(Ordering::SeqCst) > 0;
        let mut st = self.state.lock();
        if busy != st.was_busy {
            st.was_busy = busy;
            // reported under the lock so two changes never reach main in the wrong order
            self.out.activity(busy);
        }
    }

    async fn on_lane<T>(&self, lane: &Lane, f: impl Future<Output = T>) -> T {
        lane.pending.fetch_add(1, Ordering::SeqCst);
        self.changed();
        let _pending = Pending { s: self, lane };
        let _turn = lane.lock.lock().await;
        f.await
    }

    // ── plumbing ───────────────────────────────────────────────────────────────

    /// The main connection hangs: drop it; it reconnects (reported like any drop) and the pending commands fail.
    fn reset_main(&self) {
        if !self.is_ended() {
            self.client.disconnect(true);
        }
    }

    /// Drops the console connection (a timed-out console command takes it along; the next one opens a new one).
    pub fn drop_console(&self) {
        let c = self.state.lock().console.take();
        if let Some((c, _)) = c {
            c.disconnect(false);
        }
    }

    /// The console connection (D10), opened on first use and kept on the session's DB.
    pub async fn console_client(&self) -> Result<RedisClient, Value> {
        let existing = self.state.lock().console.as_ref().map(|(c, _)| c.clone());
        let client = match existing {
            Some(c) => c,
            None => {
                let _opening = self.console_opening.lock().await;
                let again = self.state.lock().console.as_ref().map(|(c, _)| c.clone());
                match again {
                    Some(c) => c,
                    None => {
                        let db = self.current_db();
                        let c = (self.opts.open_connection)(db).await.map_err(|e| connect_failure(&e))?;
                        if self.is_ended() {
                            c.disconnect(false);
                            return Err(fail("noSession", None));
                        }
                        let weak = self.me.clone();
                        let mine = c.id();
                        c.on_event(Arc::new(move |ev| {
                            if ev == ClientEvent::End
                                && let Some(s) = weak.upgrade()
                            {
                                let mut st = s.state.lock();
                                if st.console.as_ref().is_some_and(|(x, _)| x.id() == mine) {
                                    st.console = None;
                                }
                            }
                        }));
                        self.state.lock().console = Some((c.clone(), db));
                        c
                    }
                }
            }
        };
        let (want, on) = {
            let st = self.state.lock();
            (st.db, st.console.as_ref().map(|(_, d)| *d))
        };
        if on != Some(want) {
            if let Err(e) = client.call(&[b"select", want.to_string().as_bytes()]).await {
                return Err(self.to_failure(e.into()));
            }
            if let Some((_, d)) = self.state.lock().console.as_mut() {
                *d = want;
            }
        }
        Ok(client)
    }

    fn to_failure(&self, e: OpError) -> Value {
        match e {
            OpError::Code(code, server) => fail(code, server.as_ref()),
            OpError::Reply(m) => {
                let s = ServerError::of(&m);
                fail(if s.message.starts_with("WRONGTYPE") { "wrongType" } else { "server" }, Some(&s))
            }
            OpError::Conn if self.is_ended() => fail("noSession", None),
            OpError::Conn => fail("dbClosed", None),
        }
    }

    fn cmd(&self, a: &[&[u8]]) -> impl Future<Output = OpResult<Raw>> + Send + use<> {
        let f = self.client.call(a);
        async move { f.await.map_err(OpError::from) }
    }

    fn cmd_vec(&self, a: &[Vec<u8>]) -> impl Future<Output = OpResult<Raw>> + Send + use<> {
        let f = self.client.call_vec(a);
        async move { f.await.map_err(OpError::from) }
    }

    /// One operation (`handle`). `deadline`: main's own limit (ms since the epoch); an operation that would only start after
    /// it is skipped (`dbTimeout`), and one on the main connection is cut at it (or at `opTimeoutMs`).
    pub async fn handle(&self, op: &Value, deadline: Option<f64>) -> Value {
        if self.is_ended() {
            return fail("noSession", None);
        }
        let kind = str_of(op, "kind").unwrap_or("");
        if kind == "cancel" {
            let was = self.console.pending.load(Ordering::SeqCst) > 0;
            self.state.lock().cancel_gen += 1;
            return ok(Value::Bool(was));
        }
        let expired = || deadline.is_some_and(|d| (self.now() as f64) >= d);
        if LATER_KINDS.contains(&kind) {
            if CONSOLE_KINDS.contains(&kind) {
                return self
                    .on_lane(&self.console, async {
                        if expired() {
                            return fail("dbTimeout", None);
                        }
                        fail("unsupported", None)
                    })
                    .await;
            }
            return fail("unsupported", None);
        }
        self.on_lane(&self.main, async {
            if expired() {
                return fail("dbTimeout", None);
            }
            let left = deadline.map_or(f64::INFINITY, |d| d - self.now() as f64);
            let ms = (self.opts.limits.op_timeout_ms as f64).min(left).max(1.0);
            match tokio::time::timeout(Duration::from_millis(ms as u64), self.run(kind, op)).await {
                Ok(Ok(v)) => ok(v),
                Ok(Err(e)) => self.to_failure(e),
                Err(_) => {
                    self.reset_main();
                    fail("dbTimeout", None)
                }
            }
        })
        .await
    }

    async fn run(&self, kind: &str, op: &Value) -> OpResult<Value> {
        match kind {
            "databases" => Ok(self.databases().await),
            "select" => self.select(f64_of(op, "index").unwrap_or(f64::NAN)).await.map(num),
            "scan" => self.scan(op.get("req").unwrap_or(&Value::Null)).await,
            "keyInfo" => {
                let keys: Vec<Vec<u8>> = op
                    .get("keys")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().take(self.opts.limits.info_keys).map(from_data).collect())
                    .unwrap_or_default();
                Ok(Value::Array(self.key_info(keys).await))
            }
            "read" => self.read(op.get("req").unwrap_or(&Value::Null)).await,
            "readItem" => self.read_item(op.get("req").unwrap_or(&Value::Null)).await,
            "info" => {
                let r = match str_of(op, "section") {
                    Some(s) if !s.is_empty() => self.cmd(&[b"info", s.as_bytes()]).await?,
                    _ => self.cmd(&[b"info"]).await?,
                };
                Ok(info_json(&parse_info(&text(&r))))
            }
            "slowlog" => self.slowlog(f64_of(op, "count").unwrap_or(50.0)).await,
            "clients" => {
                let r = self.cmd(&[b"client", b"list"]).await?;
                Ok(Value::Array(parse_client_list(&text(&r)).into_iter().map(Value::Object).collect()))
            }
            _ => Err(OpError::Code("invalid", None)),
        }
    }

    // ── databases ──────────────────────────────────────────────────────────────

    async fn databases(&self) -> Value {
        let mut count = Value::Null;
        // CONFIG not allowed (ACL, managed services): the count stays unknown
        if let Ok(Raw::Array(r)) = self.cmd(&[b"config", b"get", b"databases"]).await
            && r.len() >= 2
        {
            let n = int(&r[1]);
            if n.fract() == 0.0 && n > 0.0 {
                count = num(n);
            }
        }
        let mut dbs = Vec::new();
        if let Ok(r) = self.cmd(&[b"info", b"keyspace"]).await {
            dbs = parse_keyspace(&parse_info(&text(&r)))
                .into_iter()
                .map(|d| json!({ "index": num(d.index), "keys": num(d.keys), "expires": num(d.expires), "avgTtlMs": num(d.avg_ttl_ms) }))
                .collect();
        }
        json!({ "count": count, "current": self.current_db(), "dbs": dbs })
    }

    async fn select(&self, index: f64) -> OpResult<f64> {
        if let Err(e) = self.cmd(&[b"select", js_num(index).as_bytes()]).await {
            if let OpError::Reply(m) = &e
                && contains_ci(m, "out of range")
            {
                return Err(OpError::Code("dbNoDatabase", Some(ServerError::of(m))));
            }
            return Err(e);
        }
        let changed = {
            let mut st = self.state.lock();
            if index >= 0.0 && index.fract() == 0.0 && index <= f64::from(u32::MAX) && index as u32 != st.db {
                st.db = index as u32;
                true
            } else {
                false
            }
        };
        if changed {
            self.out.database(index as u32);
        }
        Ok(index)
    }

    // ── keys ───────────────────────────────────────────────────────────────────

    /// One SCAN call (SCAN TYPE, or TYPE per key on servers without it).
    fn scan_once<'a>(
        &'a self,
        client: &'a RedisClient,
        cursor: &'a str,
        pattern: Option<&'a str>,
        count: f64,
        ty: Option<&'a str>,
    ) -> BoxFuture<'a, OpResult<(String, Vec<Vec<u8>>)>> {
        Box::pin(async move {
            let mut a: Vec<Vec<u8>> = vec![b"scan".to_vec(), cursor.as_bytes().to_vec()];
            if let Some(m) = pattern {
                a.push(b"MATCH".to_vec());
                a.push(m.as_bytes().to_vec());
            }
            a.push(b"COUNT".to_vec());
            a.push(js_num(count).into_bytes());
            let server_type = ty.filter(|t| !t.is_empty() && self.state.lock().scan_type);
            if let Some(t) = server_type {
                a.push(b"TYPE".to_vec());
                a.push(t.as_bytes().to_vec());
            }
            let r = match client.call_vec(&a).await.map_err(OpError::from) {
                Ok(r) => r,
                Err(e) => {
                    if server_type.is_some() && contains_ci(reply_message(&e), "syntax") {
                        self.state.lock().scan_type = false;
                        return self.scan_once(client, cursor, pattern, count, ty).await;
                    }
                    return Err(e);
                }
            };
            let mut r = array(r)?;
            if r.len() < 2 {
                return Err(OpError::Conn);
            }
            let keys_raw = r.pop().unwrap_or(Raw::Null);
            let cursor = text(&r[0]);
            let mut keys: Vec<Vec<u8>> = array(keys_raw)?.iter().map(as_buffer).collect();
            if let Some(t) = ty.filter(|t| !t.is_empty())
                && server_type.is_none()
            {
                let types = join_all(keys.iter().map(|k| {
                    let f = client.call(&[b"type", k]);
                    async move { f.await.map(|v| text(&v)).unwrap_or_default() }
                }))
                .await;
                let mut it = types.into_iter();
                keys.retain(|_| it.next().as_deref() == Some(t));
            }
            Ok((cursor, keys))
        })
    }

    async fn scan(&self, req: &Value) -> OpResult<Value> {
        let l = &self.opts.limits;
        let limit = clamp(f64_of(req, "limit").unwrap_or(500.0), 1.0, l.scan_keys);
        let count = clamp(f64_of(req, "count").unwrap_or(l.scan_count_default), 1.0, l.scan_count_max);
        let pattern = str_of(req, "match");
        let ty = str_of(req, "type");
        let started = self.now();
        let mut seen = HashSet::new();
        let mut keys: Vec<Vec<u8>> = Vec::new();
        let mut cursor = str_of(req, "cursor").unwrap_or("0").to_owned();
        loop {
            let (next, page) = self.scan_once(&self.client, &cursor, pattern, count, ty).await?;
            cursor = next;
            for k in page {
                if seen.insert(k.clone()) {
                    keys.push(k);
                }
            }
            if !(cursor != "0" && (keys.len() as f64) < limit && self.now() - started < l.scan_budget_ms && !self.is_ended()) {
                break;
            }
        }
        let details = req.get("details").and_then(Value::as_bool).unwrap_or(false);
        let keys =
            if details { self.key_info(keys).await } else { keys.iter().map(|k| json!({ "key": data_json(k) })).collect() };
        Ok(json!({ "cursor": cursor, "keys": keys }))
    }

    /// Type, TTL, length and memory of each key: all commands go out at once (pipelined on the connection).
    async fn key_info(&self, keys: Vec<Vec<u8>>) -> Vec<Value> {
        let memory = self.state.lock().memory_usage;
        join_all(keys.into_iter().map(|k| {
            let ty = self.client.call(&[b"type", &k]);
            let pttl = self.client.call(&[b"pttl", &k]);
            async move {
                let ty = ty.await.map(|v| text(&v)).unwrap_or_default();
                let pttl = pttl.await.map(|v| int(&v)).unwrap_or(f64::NAN);
                let mut info = Map::new();
                info.insert("key".into(), data_json(&k));
                if ty.is_empty() || ty == "none" {
                    return Value::Object(info);
                }
                info.insert("type".into(), Value::String(ty.clone()));
                info.insert("ttlMs".into(), if pttl >= 0.0 { num(pttl) } else { Value::Null });
                let length = length_command(&ty).map(|c| self.client.call(&[c, &k]));
                let mem = memory.then(|| self.memory_of(&self.client, &k));
                let length = match length {
                    Some(f) => f.await.ok().map(|v| int(&v)),
                    None => None,
                };
                let mem = match mem {
                    Some(f) => f.await,
                    None => None,
                };
                if let Some(n) = length.filter(|n| n.is_finite()) {
                    info.insert("length".into(), num(n));
                }
                if let Some(n) = mem.filter(|n| n.is_finite()) {
                    info.insert("memory".into(), num(n));
                }
                Value::Object(info)
            }
        }))
        .await
    }

    /// MEMORY USAGE (None when the server has none or does not allow it; then never asked again).
    fn memory_of(&self, client: &RedisClient, k: &[u8]) -> impl Future<Output = Option<f64>> + Send + use<> {
        let asked = self.state.lock().memory_usage.then(|| client.call(&[b"memory", b"usage", k]));
        let weak = self.me.clone();
        async move {
            match asked?.await {
                Ok(Raw::Null) => None,
                Ok(v) => Some(int(&v)),
                Err(CmdError::Reply(m)) => {
                    let l = m.to_ascii_lowercase();
                    if (l.contains("unknown command") || l.contains("unknown subcommand") || m.contains("NOPERM"))
                        && let Some(s) = weak.upgrade()
                    {
                        s.state.lock().memory_usage = false;
                    }
                    None
                }
                Err(_) => None,
            }
        }
    }

    // ── values ─────────────────────────────────────────────────────────────────

    /// The key's TTL when it holds `expected` (else notFound / wrongType).
    async fn type_of(&self, key: &[u8], expected: &str) -> OpResult<Value> {
        let ty = self.cmd(&[b"type", key]);
        let pttl = self.cmd(&[b"pttl", key]);
        let ty = text(&ty.await?);
        let pttl = int(&pttl.await?);
        if ty == "none" {
            return Err(OpError::Code("notFound", None));
        }
        if ty != expected {
            return Err(OpError::Code("wrongType", None));
        }
        Ok(if pttl >= 0.0 { num(pttl) } else { Value::Null })
    }

    fn items(&self, count: f64) -> f64 {
        clamp(count.floor(), 1.0, self.opts.limits.page_items)
    }

    /// HSCAN / SSCAN / ZSCAN in sub-batches until `count` items, the page byte budget or the end; duplicates within the
    /// page are dropped (the cursor may still return an item again on a later page).
    async fn scan_page(
        &self,
        command: &[u8],
        key: &[u8],
        mut cursor: String,
        count: f64,
        pattern: Option<&str>,
        per_item: usize,
    ) -> OpResult<(String, Vec<Vec<u8>>)> {
        let l = &self.opts.limits;
        let mut seen = HashSet::new();
        let mut flat = Vec::new();
        let mut bytes = 0usize;
        let mut items = 0f64;
        loop {
            let want = l.page_batch.min(count - items);
            let mut a = vec![command.to_vec(), key.to_vec(), cursor.as_bytes().to_vec()];
            if let Some(m) = pattern {
                a.push(b"MATCH".to_vec());
                a.push(m.as_bytes().to_vec());
            }
            a.push(b"COUNT".to_vec());
            a.push(js_num(want).into_bytes());
            let mut r = array(self.cmd_vec(&a).await?)?;
            if r.len() < 2 {
                return Err(OpError::Conn);
            }
            let got: Vec<Vec<u8>> = array(r.pop().unwrap_or(Raw::Null))?.iter().map(as_buffer).collect();
            cursor = text(&r[0]);
            let mut i = 0;
            while i + per_item - 1 < got.len() {
                if seen.insert(got[i].clone()) {
                    for x in &got[i..i + per_item] {
                        bytes += x.len().min(l.item_bytes);
                        flat.push(x.clone());
                    }
                    items += 1.0;
                }
                i += per_item;
            }
            if !(cursor != "0" && items < count && bytes < l.page_bytes && !self.is_ended()) {
                break;
            }
        }
        Ok((cursor, flat))
    }

    async fn read(&self, req: &Value) -> OpResult<Value> {
        let l = &self.opts.limits;
        let ty = str_of(req, "type").unwrap_or("");
        let key = from_data(req.get("key").unwrap_or(&Value::Null));
        let ttl = self.type_of(&key, ty).await?;
        let ib = l.item_bytes;
        let cursor_of = |r: &Value| str_of(r, "cursor").unwrap_or("0").to_owned();
        match ty {
            "string" => {
                let length = int(&self.cmd(&[b"strlen", &key]).await?);
                let offset = clamp(f64_of(req, "offset").unwrap_or(0.0), 0.0, length);
                let max = clamp(f64_of(req, "maxBytes").unwrap_or(l.string_bytes), 1.0, l.string_bytes_max);
                let raw = if length == 0.0 || offset >= length {
                    Vec::new()
                } else {
                    let end = offset + max - 1.0;
                    as_buffer(&self.cmd(&[b"getrange", &key, js_num(offset).as_bytes(), js_num(end).as_bytes()]).await?)
                };
                let part: &[u8] = if offset + (raw.len() as f64) < length { trim_partial_utf8(&raw) } else { &raw };
                let value = blob_with_total(part, usize::MAX, length);
                let mut value = value;
                if offset + (part.len() as f64) < length {
                    value["truncated"] = Value::Bool(true);
                } else if let Some(o) = value.as_object_mut() {
                    o.remove("truncated");
                }
                Ok(
                    json!({ "type": "string", "ttlMs": ttl, "length": num(length), "offset": num(offset), "pageBytes": part.len(), "value": value }),
                )
            }
            "hash" => {
                let length = int(&self.cmd(&[b"hlen", &key]).await?);
                let (cursor, flat) = self
                    .scan_page(
                        b"hscan",
                        &key,
                        cursor_of(req),
                        self.items(f64_of(req, "count").unwrap_or(f64::NAN)),
                        str_of(req, "match"),
                        2,
                    )
                    .await?;
                let entries: Vec<Value> = flat
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|p| json!({ "field": data_json(&p[0]), "value": blob(&p[1], ib) }))
                    .collect();
                Ok(json!({ "type": "hash", "ttlMs": ttl, "length": num(length), "cursor": cursor, "entries": entries }))
            }
            "list" => {
                let length = int(&self.cmd(&[b"llen", &key]).await?);
                let start = f64_of(req, "start").unwrap_or(f64::NAN).floor().max(0.0);
                let count = self.items(f64_of(req, "count").unwrap_or(f64::NAN));
                let mut items: Vec<Value> = Vec::new();
                let mut bytes = 0usize;
                // Sub-batches with a byte budget: the page may come back shorter (the next one starts at start + items).
                while (items.len() as f64) < count && bytes < l.page_bytes {
                    let from = start + items.len() as f64;
                    let n = l.page_batch.min(count - items.len() as f64);
                    let r =
                        array(self.cmd(&[b"lrange", &key, js_num(from).as_bytes(), js_num(from + n - 1.0).as_bytes()]).await?)?;
                    for x in &r {
                        let b = as_buffer(x);
                        bytes += b.len();
                        items.push(blob(&b, ib));
                    }
                    if (r.len() as f64) < n {
                        break;
                    }
                }
                Ok(json!({ "type": "list", "ttlMs": ttl, "length": num(length), "start": num(start), "items": items }))
            }
            "set" => {
                let length = int(&self.cmd(&[b"scard", &key]).await?);
                let (cursor, flat) = self
                    .scan_page(
                        b"sscan",
                        &key,
                        cursor_of(req),
                        self.items(f64_of(req, "count").unwrap_or(f64::NAN)),
                        str_of(req, "match"),
                        1,
                    )
                    .await?;
                let members: Vec<Value> = flat.iter().map(|m| data_json(m)).collect();
                Ok(json!({ "type": "set", "ttlMs": ttl, "length": num(length), "cursor": cursor, "members": members }))
            }
            "zset" => {
                let length = int(&self.cmd(&[b"zcard", &key]).await?);
                let pairs = |flat: &[Raw]| -> Vec<Value> {
                    flat.as_chunks::<2>()
                        .0
                        .iter()
                        .map(|p| json!({ "member": data_json(&as_buffer(&p[0])), "score": text(&p[1]) }))
                        .collect()
                };
                if req.get("cursor").is_some() {
                    let (cursor, flat) = self
                        .scan_page(
                            b"zscan",
                            &key,
                            cursor_of(req),
                            self.items(f64_of(req, "count").unwrap_or(f64::NAN)),
                            str_of(req, "match"),
                            2,
                        )
                        .await?;
                    let flat: Vec<Raw> = flat.into_iter().map(Raw::Bytes).collect();
                    return Ok(
                        json!({ "type": "zset", "ttlMs": ttl, "length": num(length), "cursor": cursor, "entries": pairs(&flat) }),
                    );
                }
                let start = f64_of(req, "start").unwrap_or(f64::NAN).floor().max(0.0);
                let count = self.items(f64_of(req, "count").unwrap_or(f64::NAN));
                let rev = req.get("rev").and_then(Value::as_bool).unwrap_or(false);
                let mut entries: Vec<Value> = Vec::new();
                let mut bytes = 0usize;
                while (entries.len() as f64) < count && bytes < l.page_bytes {
                    let from = start + entries.len() as f64;
                    let stop = from + l.page_batch.min(count - entries.len() as f64) - 1.0;
                    let (f, s) = (js_num(from), js_num(stop));
                    let r = if rev {
                        match self.cmd(&[b"zrange", &key, f.as_bytes(), s.as_bytes(), b"REV", b"WITHSCORES"]).await {
                            Ok(r) => r,
                            Err(e) if contains_ci(reply_message(&e), "syntax") => {
                                self.cmd(&[b"zrevrange", &key, f.as_bytes(), s.as_bytes(), b"WITHSCORES"]).await?
                            }
                            Err(e) => return Err(e),
                        }
                    } else {
                        self.cmd(&[b"zrange", &key, f.as_bytes(), s.as_bytes(), b"WITHSCORES"]).await?
                    };
                    let r = array(r)?;
                    for x in &r {
                        bytes += as_buffer(x).len();
                    }
                    entries.extend(pairs(&r));
                    if (r.len() as f64) / 2.0 < stop - from + 1.0 {
                        break;
                    }
                }
                Ok(json!({ "type": "zset", "ttlMs": ttl, "length": num(length), "start": num(start), "entries": entries }))
            }
            "stream" => {
                let length = int(&self.cmd(&[b"xlen", &key]).await?);
                let count = self.items(f64_of(req, "count").unwrap_or(f64::NAN));
                let rev = req.get("rev").and_then(Value::as_bool).unwrap_or(false);
                let end = str_of(req, "end").unwrap_or("+").to_owned();
                let mut entries: Vec<Value> = Vec::new();
                let mut last: Option<String> = None;
                let mut bytes = 0usize;
                let mut from: Option<String> = Some(str_of(req, "start").unwrap_or("-").to_owned());
                let mut exhausted = false;
                while let Some(f) = from.clone() {
                    if !((entries.len() as f64) < count && bytes < l.page_bytes) {
                        break;
                    }
                    let n = l.page_batch.min(count - entries.len() as f64);
                    let cmd: &[u8] = if rev { b"xrevrange" } else { b"xrange" };
                    let r = array(self.cmd(&[cmd, &key, f.as_bytes(), end.as_bytes(), b"COUNT", js_num(n).as_bytes()]).await?)?;
                    for e in &r {
                        let Raw::Array(parts) = e else { return Err(OpError::Conn) };
                        let id = parts.first().map(text).unwrap_or_default();
                        let flat: Vec<Vec<u8>> = match parts.get(1) {
                            Some(Raw::Array(f)) => f.iter().map(as_buffer).collect(),
                            _ => Vec::new(),
                        };
                        let mut fields = Vec::new();
                        for p in flat.as_chunks::<2>().0 {
                            fields.push(json!({ "field": data_json(&p[0]), "value": blob(&p[1], ib) }));
                            bytes += p[0].len() + p[1].len();
                        }
                        entries.push(json!({ "id": id, "fields": fields }));
                        last = Some(id);
                    }
                    if (r.len() as f64) < n {
                        exhausted = true;
                        break;
                    }
                    from = last.as_deref().and_then(|id| stream_id_step(id, !rev));
                }
                let next = match (&last, exhausted) {
                    (Some(id), false) if !id.is_empty() => stream_id_step(id, !rev).map_or(Value::Null, Value::String),
                    _ => Value::Null,
                };
                Ok(json!({ "type": "stream", "ttlMs": ttl, "length": num(length), "entries": entries, "next": next }))
            }
            _ => Err(OpError::Code("invalid", None)),
        }
    }

    async fn read_item(&self, req: &Value) -> OpResult<Value> {
        let max = self.opts.limits.string_bytes_max as usize;
        let ty = str_of(req, "type").unwrap_or("");
        let key = from_data(req.get("key").unwrap_or(&Value::Null));
        self.type_of(&key, ty).await?;
        let v = match ty {
            "hash" => self.cmd(&[b"hget", &key, &from_data(req.get("field").unwrap_or(&Value::Null))]).await?,
            "list" => {
                let index = js_num(f64_of(req, "index").unwrap_or(f64::NAN));
                self.cmd(&[b"lindex", &key, index.as_bytes()]).await?
            }
            "stream" => {
                let id = str_of(req, "id").unwrap_or("");
                let r = array(self.cmd(&[b"xrange", &key, id.as_bytes(), id.as_bytes()]).await?)?;
                let want = from_data(req.get("field").unwrap_or(&Value::Null));
                let flat: Vec<Vec<u8>> = match r.first() {
                    Some(Raw::Array(e)) => match e.get(1) {
                        Some(Raw::Array(f)) => f.iter().map(as_buffer).collect(),
                        _ => Vec::new(),
                    },
                    _ => Vec::new(),
                };
                flat.as_chunks::<2>().0.iter().find(|p| p[0] == want).map_or(Raw::Null, |p| Raw::Bytes(p[1].clone()))
            }
            _ => return Err(OpError::Code("invalid", None)),
        };
        if v == Raw::Null {
            return Err(OpError::Code("notFound", None));
        }
        Ok(blob(&as_buffer(&v), max))
    }

    async fn slowlog(&self, count: f64) -> OpResult<Value> {
        let n = clamp(count.floor(), 1.0, self.opts.limits.slowlog_max);
        let r = array(self.cmd(&[b"slowlog", b"get", js_num(n).as_bytes()]).await?)?;
        let entries = r
            .iter()
            .map(|e| {
                let x: &[Raw] = match e {
                    Raw::Array(x) => x,
                    _ => &[],
                };
                let at = |i: usize| x.get(i).unwrap_or(&Raw::Null);
                let mut m = Map::new();
                m.insert("id".into(), num(int(at(0))));
                m.insert("time".into(), num(int(at(1))));
                m.insert("durationUs".into(), num(int(at(2))));
                let args: Vec<Value> = match at(3) {
                    Raw::Array(a) => a.iter().map(|v| data_json(&as_buffer(v))).collect(),
                    _ => Vec::new(),
                };
                m.insert("args".into(), Value::Array(args));
                if x.len() > 4 && *at(4) != Raw::Null {
                    m.insert("client".into(), Value::String(text(at(4))));
                }
                if x.len() > 5 && *at(5) != Raw::Null && !text(at(5)).is_empty() {
                    m.insert("clientName".into(), Value::String(text(at(5))));
                }
                Value::Object(m)
            })
            .collect();
        Ok(Value::Array(entries))
    }
}

fn info_json(sections: &[crate::redis_shared::InfoSection]) -> Value {
    Value::Array(
        sections
            .iter()
            .map(|s| {
                let entries: Vec<Value> = s.entries.iter().map(|(k, v)| json!([k, v])).collect();
                json!({ "name": s.name, "entries": entries })
            })
            .collect(),
    )
}

/// A connect error of a side connection as a session answer.
pub fn connect_failure(e: &ConnectError) -> Value {
    fail(e.code, e.server_message.as_deref().map(|m| ServerError { message: m.to_owned(), code: None }).as_ref())
}

/// `redisServerError` of a reply text (D10's console uses it).
pub fn server_error(message: &str) -> ServerError {
    ServerError::of(message)
}

/// `mapRedisConnectError` of a reply text.
pub fn connect_error_of(message: &str) -> ConnectError {
    map_server_error(message)
}

/// One command argument from a JS number.
pub fn arg_num(f: f64) -> Vec<u8> {
    js_num(f).into_bytes()
}

/// Owned argument lists for D10's builders.
pub fn argv_of(parts: &[&[u8]]) -> Vec<Vec<u8>> {
    args(parts)
}
