//! The Redis half of the DB Host (src/dbhost/host.ts: `open`, `startRedis`, `openRedisTls`, `openRedisOnce`, `fail`,
//! `finish`, `close`, `op`) as a [`DbHostLink`] in front of the link for the other kinds: a `dbOpen` with `kind: 'redis'`
//! starts a Redis session here, every other message and operation of a session that is not a Redis one goes to `next`
//! (until D12 routes the kinds; today that is D1's `UnavailableHost`).
//!
//! A session: `connecting`; through SSH the shared tunnel first ([`DbTunnels`], D2); `database`; an ACL user without a saved
//! password is asked first (connecting as the default user instead would be someone else); TLS by mode (prefer: TLS first,
//! plain when the handshake fails, since Redis has no TLS negotiation of its own); a refused login asks for the password
//! (at most 3 prompts, `retry` once a password was refused); `connected` with the server version, the DB index and whether
//! TLS is on. A drop is `database` with the reconnect attempt, then `connected` again or the end of the session.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, Weak};

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use super::connect::{ClientOptions, ConnectError, Dialer, Opened, RedisClient, StreamSource, js_head, open_redis};
use super::session::{RedisLimits, RedisSession, RedisSessionOptions, RedisSessionOut, fail};
use super::tls::TlsSetup;
use crate::host::{DbHostLink, HostReport, PendingRequests, Spawn, ToHost, op_timeout_ms, with_deadline};

const MAX_PASSWORD_PROMPTS: u32 = 3;
/// One database connect attempt (TCP, TLS and the server's startup): `DB_HOST_TIMERS.dbConnectMs`.
pub const DB_CONNECT_MS: u64 = 20_000;

/// The SSH tunnels of the DB sessions (D2): one per connection, shared and reference counted; the owner logs it in.
pub trait DbTunnels: Send + Sync {
    /// Joins the tunnel of `ssh` (`{dbHost, dbPort, tunnelKey, owner}`) and waits until it is up: the opener of its
    /// forwarded channels, or the error code the session ends with.
    fn join(&self, session_id: &str, ssh: &Value) -> BoxFuture<'static, Result<StreamSource, String>>;
    /// The session ended: its reference goes (the last one closes the tunnel).
    fn release(&self, session_id: &str);
}

/// Where the DB port messages go (Pub/Sub, D10; routed per window by D12).
pub type PortSink = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Clone)]
struct OpenConfig {
    host: String,
    port: u16,
    user: String,
    database: String,
    tls: String,
    ca: Option<String>,
    password: Option<Zeroizing<String>>,
    read_only: bool,
    ssh: Option<Value>,
}

impl OpenConfig {
    fn parse(c: &Value) -> OpenConfig {
        let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        let port = |v: Option<&Value>| v.and_then(Value::as_f64).filter(|p| *p >= 0.0 && *p <= 65535.0).unwrap_or(0.0) as u16;
        OpenConfig {
            host: s("host"),
            port: port(c.get("port")),
            user: s("user"),
            database: s("database"),
            tls: s("tls"),
            ca: c.get("ca").and_then(Value::as_str).map(str::to_owned),
            password: c.get("password").and_then(Value::as_str).map(|p| Zeroizing::new(p.to_owned())),
            read_only: c.get("readOnly").and_then(Value::as_bool).unwrap_or(false),
            ssh: c.get("ssh").filter(|v| v.is_object()).cloned(),
        }
    }

    /// `endpoint`: through SSH the address the SSH server connects to.
    fn endpoint(&self) -> (String, u16) {
        match &self.ssh {
            Some(ssh) => (
                ssh.get("dbHost").and_then(Value::as_str).unwrap_or("").to_owned(),
                ssh.get("dbPort").and_then(Value::as_f64).unwrap_or(0.0) as u16,
            ),
            None => (self.host.clone(), self.port),
        }
    }

    /// `Number(config.database) || 0`.
    fn db_index(&self) -> u32 {
        let n = crate::sql::values::js_to_number(&self.database);
        if n.is_finite() && n > 0.0 && n.fract() == 0.0 && n <= f64::from(u32::MAX) { n as u32 } else { 0 }
    }
}

struct SessionState {
    phase: String,
    ended: bool,
    /// Closed on request: the end reads "closed".
    closing: bool,
    password_ask: Option<(String, oneshot::Sender<Option<Zeroizing<String>>>)>,
    redis: Option<Arc<RedisSession>>,
    /// The connection uses TLS (prefer resolved); side connections connect the same way.
    redis_tls: bool,
    /// The password the connection used (side connections need it); dropped when the session ends.
    password: Option<Zeroizing<String>>,
    tunnel: Option<StreamSource>,
    joined_tunnel: bool,
}

struct Session {
    id: String,
    config: OpenConfig,
    st: Mutex<SessionState>,
}

/// The Redis sessions (see the module text).
pub struct RedisHost {
    me: Weak<RedisHost>,
    next: Arc<dyn DbHostLink>,
    report: OnceLock<HostReport>,
    port: OnceLock<PortSink>,
    tunnels: Option<Arc<dyn DbTunnels>>,
    spawn: Spawn,
    connect_ms: u64,
    limits: RedisLimits,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    pending: Arc<PendingRequests>,
}

pub struct RedisHostDeps {
    /// The link for every other kind of session.
    pub next: Arc<dyn DbHostLink>,
    pub spawn: Spawn,
    /// None: a session through SSH ends with `unsupported` (D2 adds the tunnels).
    pub tunnels: Option<Arc<dyn DbTunnels>>,
    pub connect_ms: u64,
    pub limits: RedisLimits,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl RedisHost {
    pub fn new(deps: RedisHostDeps) -> Arc<RedisHost> {
        Arc::new_cyclic(|me| RedisHost {
            me: me.clone(),
            next: deps.next,
            report: OnceLock::new(),
            port: OnceLock::new(),
            tunnels: deps.tunnels,
            spawn: deps.spawn,
            connect_ms: deps.connect_ms,
            limits: deps.limits,
            now: deps.now,
            sessions: Mutex::new(HashMap::new()),
            pending: Arc::new(PendingRequests::default()),
        })
    }

    /// Where its status messages go (the service's `onHostMessage`).
    pub fn connect(&self, report: HostReport) {
        let _ = self.report.set(report);
    }

    /// For a service that holds the host: reports through a weak reference so neither keeps the other alive.
    pub fn connect_weak<T: Send + Sync + 'static>(&self, target: Weak<T>, f: fn(&T, Value)) {
        self.connect(Arc::new(move |m| {
            if let Some(t) = target.upgrade() {
                f(&t, m);
            }
        }));
    }

    /// Where the DB port messages go.
    pub fn connect_port(&self, sink: PortSink) {
        let _ = self.port.set(sink);
    }

    /// Redis sessions open or connecting.
    pub fn session_count(&self) -> usize {
        self.sessions.lock().len()
    }

    fn to_main(&self, m: Value) {
        if let Some(r) = self.report.get() {
            r(m);
        }
    }

    fn get(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().get(id).cloned()
    }

    fn live(&self, s: &Arc<Session>) -> bool {
        self.get(&s.id).is_some_and(|x| Arc::ptr_eq(&x, s)) && !s.st.lock().ended
    }

    fn status(&self, s: &Session, phase: &str, extra: Map<String, Value>) {
        s.st.lock().phase = phase.to_owned();
        let mut m = Map::new();
        m.insert("t".into(), json!("dbStatus"));
        m.insert("id".into(), json!(s.id));
        m.insert("phase".into(), json!(phase));
        m.extend(extra);
        self.to_main(Value::Object(m));
    }

    fn open(&self, id: String, config: &Value) {
        if self.get(&id).is_some() {
            self.close(&id);
        }
        let s = Arc::new(Session {
            id: id.clone(),
            config: OpenConfig::parse(config),
            st: Mutex::new(SessionState {
                phase: "connecting".into(),
                ended: false,
                closing: false,
                password_ask: None,
                redis: None,
                redis_tls: false,
                password: None,
                tunnel: None,
                joined_tunnel: false,
            }),
        });
        s.st.lock().password = s.config.password.clone();
        self.sessions.lock().insert(id, s.clone());
        self.status(&s, "connecting", Map::new());
        let Some(me) = self.me.upgrade() else { return };
        (self.spawn)(Box::pin(async move { me.start(s).await }));
    }

    async fn start(self: Arc<Self>, s: Arc<Session>) {
        if let Some(ssh) = s.config.ssh.clone() {
            let Some(tunnels) = self.tunnels.clone() else {
                self.fail(&s, "unsupported", None);
                return;
            };
            s.st.lock().joined_tunnel = true;
            match tunnels.join(&s.id, &ssh).await {
                Ok(source) => s.st.lock().tunnel = Some(source),
                Err(code) => {
                    if self.live(&s) {
                        self.fail_owned(&s, code, None);
                    }
                    return;
                }
            }
            if !self.live(&s) {
                return;
            }
        }
        self.status(&s, "database", Map::new());
        self.start_redis(&s).await;
    }

    fn dialer(&self, s: &Session, tls_on: bool) -> Dialer {
        let (host, port) = s.config.endpoint();
        let tls = tls_on.then(|| {
            if s.config.tls == "verify-full" {
                TlsSetup::VerifyFull { ca: s.config.ca.clone().unwrap_or_default() }
            } else {
                TlsSetup::NoVerify
            }
        });
        Dialer {
            logical_host: host.clone(),
            host,
            port,
            tls,
            tunnel: s.st.lock().tunnel.clone(),
            connect_timeout_ms: self.connect_ms,
        }
    }

    /// One connection with the session's endpoint, TLS and login (the main one or a side one).
    fn open_once(
        &self,
        s: &Session,
        password: Option<Zeroizing<String>>,
        tls_on: bool,
        db: u32,
    ) -> BoxFuture<'static, Result<Opened, ConnectError>> {
        let o = ClientOptions { dialer: self.dialer(s, tls_on), user: s.config.user.clone(), password };
        Box::pin(open_redis(o, db))
    }

    /// prefer: TLS first, plain when the TLS handshake fails.
    async fn open_tls(&self, s: &Session, password: Option<Zeroizing<String>>, db: u32) -> Result<(Opened, bool), ConnectError> {
        let mode = s.config.tls.as_str();
        if mode == "disable" {
            return self.open_once(s, password, false, db).await.map(|o| (o, false));
        }
        match self.open_once(s, password.clone(), true, db).await {
            Ok(o) => Ok((o, true)),
            Err(e) if mode == "prefer" && (e.code == "dbTls" || e.code == "dbClosed") => {
                self.open_once(s, password, false, db).await.map(|o| (o, false))
            }
            Err(e) => Err(e),
        }
    }

    async fn ask_password(&self, s: &Session, retry: bool) -> Option<Zeroizing<String>> {
        let prompt_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        s.st.lock().password_ask = Some((prompt_id.clone(), tx));
        self.to_main(json!({ "t": "dbPasswordPrompt", "id": s.id, "promptId": prompt_id, "retry": retry }));
        rx.await.ok().flatten()
    }

    async fn start_redis(&self, s: &Arc<Session>) {
        let db_index = s.config.db_index();
        let mut password = s.config.password.clone();
        let mut prompts = 0;
        if !s.config.user.is_empty() && password.is_none() {
            let typed = self.ask_password(s, false).await;
            prompts += 1;
            if !self.live(s) {
                return;
            }
            let Some(typed) = typed else {
                self.fail(s, "cancelled", None);
                return;
            };
            password = Some(typed);
        }
        let (opened, tls) = loop {
            if !self.live(s) {
                return;
            }
            match self.open_tls(s, password.clone(), db_index).await {
                Ok(o) => break o,
                Err(e) => {
                    if !self.live(s) {
                        return;
                    }
                    if e.code != "dbAuth" {
                        self.fail(s, e.code, e.server_message);
                        return;
                    }
                    if prompts >= MAX_PASSWORD_PROMPTS {
                        self.fail(s, "dbAuth", e.server_message);
                        return;
                    }
                    let typed = self.ask_password(s, password.is_some()).await;
                    prompts += 1;
                    if !self.live(s) {
                        return;
                    }
                    let Some(typed) = typed else {
                        self.fail(s, "cancelled", None);
                        return;
                    };
                    password = Some(typed);
                }
            }
        };
        if !self.live(s) {
            opened.client.disconnect(false);
            return;
        }
        {
            let mut st = s.st.lock();
            st.password = password;
            st.redis_tls = tls;
        }
        let weak_host = self.me.clone();
        let weak_s = Arc::downgrade(s);
        let open_connection = Arc::new(move |db: u32| -> BoxFuture<'static, Result<RedisClient, ConnectError>> {
            let (Some(h), Some(s)) = (weak_host.upgrade(), weak_s.upgrade()) else {
                return Box::pin(async { Err(ConnectError::new("noSession")) });
            };
            let (password, tls) = {
                let st = s.st.lock();
                (st.password.clone(), st.redis_tls)
            };
            let f = h.open_once(&s, password, tls, db);
            Box::pin(async move { f.await.map(|o| o.client) })
        });
        let out = Arc::new(Out { host: self.me.clone(), session: Arc::downgrade(s) });
        let redis = RedisSession::new(
            opened.client,
            RedisSessionOptions {
                session_id: s.id.clone(),
                read_only: s.config.read_only,
                db_index,
                open_connection,
                via_tunnel: s.config.ssh.is_some(),
                limits: self.limits.clone(),
                now: self.now.clone(),
            },
            out,
        );
        s.st.lock().redis = Some(redis);
        let mut extra = Map::new();
        if let Some(v) = opened.server_version {
            extra.insert("serverVersion".into(), json!(v));
        }
        extra.insert("database".into(), json!(db_index.to_string()));
        extra.insert("tls".into(), json!(tls));
        self.status(s, "connected", extra);
    }

    fn fail(&self, s: &Arc<Session>, error: &'static str, message: Option<String>) {
        self.fail_owned(s, error.to_owned(), message);
    }

    fn fail_owned(&self, s: &Arc<Session>, error: String, message: Option<String>) {
        if !self.live(s) {
            return;
        }
        let closing = s.st.lock().closing;
        self.finish(s, (!closing).then_some(error), message);
    }

    fn finish(&self, s: &Arc<Session>, error: Option<String>, message: Option<String>) {
        let (ask, redis, joined) = {
            let mut st = s.st.lock();
            st.ended = true;
            st.password = None;
            st.tunnel = None;
            (st.password_ask.take(), st.redis.take(), std::mem::take(&mut st.joined_tunnel))
        };
        {
            let mut map = self.sessions.lock();
            if map.get(&s.id).is_some_and(|x| Arc::ptr_eq(x, s)) {
                map.remove(&s.id);
            }
        }
        if let Some((_, tx)) = ask {
            let _ = tx.send(None);
        }
        if let Some(r) = redis {
            r.end();
        }
        if joined && let Some(t) = &self.tunnels {
            t.release(&s.id);
        }
        match error {
            Some(error) => {
                let mut extra = Map::new();
                extra.insert("error".into(), json!(error));
                if let Some(m) = message {
                    extra.insert("message".into(), json!(js_head(&m, 2000)));
                }
                self.status(s, "error", extra);
            }
            None => self.status(s, "closed", Map::new()),
        }
    }

    fn close(&self, id: &str) {
        let Some(s) = self.get(id) else { return };
        {
            let mut st = s.st.lock();
            if st.ended {
                return;
            }
            st.closing = true;
        }
        self.finish(&s, None, None);
    }

    /// Ends every Redis session (the wind-down's HOSTS step, D12).
    pub fn shutdown(&self) {
        let ids: Vec<String> = self.sessions.lock().keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }

    async fn op(&self, id: &str, op: Value) -> Value {
        let Some(s) = self.get(id) else { return fail("noSession", None) };
        if op.get("op").and_then(Value::as_str) != Some("redis") {
            return fail("invalid", None);
        }
        let redis = {
            let st = s.st.lock();
            if st.ended {
                return fail("noSession", None);
            }
            match &st.redis {
                Some(r) if st.phase == "connected" => r.clone(),
                _ => return fail("notConnected", None),
            }
        };
        let deadline = op.get("deadline").and_then(Value::as_f64);
        redis.handle(op.get("req").unwrap_or(&Value::Null), deadline).await
    }
}

/// A session's reports, while it is the live one.
struct Out {
    host: Weak<RedisHost>,
    session: Weak<Session>,
}

impl Out {
    fn live(&self) -> Option<(Arc<RedisHost>, Arc<Session>)> {
        let h = self.host.upgrade()?;
        let s = self.session.upgrade()?;
        h.live(&s).then_some((h, s))
    }
}

impl RedisSessionOut for Out {
    fn port(&self, m: Value) {
        if let Some(h) = self.host.upgrade()
            && let Some(p) = h.port.get()
        {
            p(m);
        }
    }

    fn activity(&self, busy: bool) {
        if let Some((h, s)) = self.live() {
            h.to_main(json!({ "t": "dbActivity", "id": s.id, "busy": busy }));
        }
    }

    fn reconnecting(&self, attempt: u32) {
        if let Some((h, s)) = self.live() {
            let mut extra = Map::new();
            extra.insert("reconnect".into(), json!(attempt));
            h.status(&s, "database", extra);
        }
    }

    fn reconnected(&self) {
        if let Some((h, s)) = self.live() {
            let db = s.st.lock().redis.as_ref().map_or(0, |r| r.current_db());
            let mut extra = Map::new();
            extra.insert("database".into(), json!(db.to_string()));
            h.status(&s, "connected", extra);
        }
    }

    fn closed(&self, error: &str, message: Option<String>) {
        if let (Some(h), Some(s)) = (self.host.upgrade(), self.session.upgrade()) {
            h.fail_owned(&s, error.to_owned(), message);
        }
    }

    fn database(&self, index: u32) {
        if let Some((h, s)) = self.live() {
            h.to_main(json!({ "t": "dbDatabase", "id": s.id, "database": index.to_string() }));
        }
    }
}

fn is_redis_open(config: &Value) -> bool {
    config.get("kind").and_then(Value::as_str) == Some("redis")
}

impl DbHostLink for RedisHost {
    fn ensure(&self) -> bool {
        self.next.ensure()
    }

    fn send(&self, m: ToHost) -> bool {
        match m {
            ToHost::Open { id, config } if is_redis_open(&config) => {
                self.open(id, &config);
                true
            }
            ToHost::Open { id, config } => {
                // the id may have been a Redis session before
                self.close(&id);
                self.next.send(ToHost::Open { id, config })
            }
            ToHost::PasswordAnswer { id, prompt_id, value } => {
                let Some(s) = self.get(&id) else { return self.next.send(ToHost::PasswordAnswer { id, prompt_id, value }) };
                let ask = {
                    let mut st = s.st.lock();
                    match &st.password_ask {
                        Some((p, _)) if *p == prompt_id => st.password_ask.take(),
                        _ => None,
                    }
                };
                if let Some((_, tx)) = ask {
                    let _ = tx.send(value);
                }
                true
            }
            ToHost::Close { id } => {
                if self.get(&id).is_some() {
                    self.close(&id);
                    true
                } else {
                    self.next.send(ToHost::Close { id })
                }
            }
        }
    }

    fn request(&self, id: &str, op: Value, window: Option<String>) -> BoxFuture<'static, Value> {
        if self.get(id).is_none() {
            return self.next.request(id, op, window);
        }
        let op = with_deadline(op, (self.now)());
        let (rid, wait) = self.pending.start(op_timeout_ms(&op));
        let (Some(me), id) = (self.me.upgrade(), id.to_owned()) else { return wait };
        // The operation runs to its end on its own task (an answer main no longer waits for is dropped), as in 1.1.4.
        (self.spawn)(Box::pin(async move {
            let result = me.op(&id, op).await;
            me.pending.resolve(rid, result);
        }));
        wait
    }
}
