//! D12: the Postgres half of the DB Host (src/dbhost/host.ts: `open`, `start` for `kind: 'postgres'`, `connectTls`,
//! `connectWithPassword`, `askPassword`, `sideConnection` / `cancelRequest`, `fail`, `finish`, `close`, `op`) as a
//! [`DbHostLink`] in front of the link for the other kinds: a `dbOpen` with `kind: 'postgres'` starts a Postgres session
//! here, every other message and operation of a session that is not a Postgres one goes to `next`.
//!
//! A session: `connecting`; through SSH the shared tunnel first ([`PgTunnels`], D2: joined in the same call as the open,
//! so main's sshConnect can never come first); `database`; [`open`] (TLS by mode with the prefer fallback, the login with
//! at most 3 password questions, statement_timeout, the read-only default, `SHOW server_version`); [`PgSession::start`]
//! (the type names); `connected` with the server version, the database and whether TLS is on. A closed session stops its
//! connect at once (the open future is dropped). The connection ending on its own ends the session (`dbClosed`, or
//! `tunnel` through SSH); a setting that cannot be restored ends it with `dbFailed`.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use super::connect::{Connector, DB_CONNECT_MS, PasswordPrompt, PgOpenConfig, TcpConnector, open};
use super::messages::PgPortMessage;
use super::session::{PgOut, PgSession, PgSessionOptions, SideCancel};
use crate::host::{DbHostLink, HostReport, PendingRequests, Spawn, ToHost, op_timeout_ms};
use crate::sql::limits;
use crate::tunnel::{DbTunnelHost, SessionFail};
use crate::wire::value::utf16_head;

/// The SSH tunnels as the Postgres sessions use them (D2's [`DbTunnelHost`]): the forwarded channels as a [`Connector`].
pub trait PgTunnels: Send + Sync {
    /// Joins the tunnel of `ssh` (`{dbHost, dbPort, tunnelKey, owner}`) at once; the future waits until it is up.
    fn join(&self, session_id: &str, ssh: &Value, fail: SessionFail) -> BoxFuture<'static, Result<Arc<dyn Connector>, String>>;
    fn release(&self, session_id: &str);
}

impl PgTunnels for DbTunnelHost {
    fn join(&self, session_id: &str, ssh: &Value, fail: SessionFail) -> BoxFuture<'static, Result<Arc<dyn Connector>, String>> {
        let wait = DbTunnelHost::join(self, session_id, ssh, fail);
        Box::pin(async move { wait.await.map(|o| Arc::new(o) as Arc<dyn Connector>) })
    }
    fn release(&self, session_id: &str) {
        DbTunnelHost::release(self, session_id);
    }
}

/// Where the DB port messages go (routed per window by [`crate::route::DbPorts`]).
pub type PgPortSink = Arc<dyn Fn(PgPortMessage) + Send + Sync>;

struct SessionState {
    phase: String,
    ended: bool,
    /// Closed on request: the end reads "closed".
    closing: bool,
    password_ask: Option<(String, oneshot::Sender<Option<Zeroizing<String>>>)>,
    pg: Option<PgSession>,
    joined_tunnel: bool,
    /// Dropped when the session ends: a connect still running stops.
    stop: Option<oneshot::Sender<()>>,
}

struct Session {
    id: String,
    config: PgOpenConfig,
    st: Mutex<SessionState>,
}

pub struct PgHostDeps {
    /// The link for every other kind of session.
    pub next: Arc<dyn DbHostLink>,
    pub spawn: Spawn,
    /// None: a session through SSH ends with `unsupported`.
    pub tunnels: Option<Arc<dyn PgTunnels>>,
    pub connect_ms: u64,
    pub cursor_idle_ms: u64,
}

impl PgHostDeps {
    /// The 1.1.4 timers (20 s connect, DB_LIMITS.cursorIdleMs).
    pub fn new(next: Arc<dyn DbHostLink>, spawn: Spawn, tunnels: Option<Arc<dyn PgTunnels>>) -> Self {
        PgHostDeps { next, spawn, tunnels, connect_ms: DB_CONNECT_MS, cursor_idle_ms: limits::CURSOR_IDLE_MS }
    }
}

/// The Postgres sessions (see the module text).
pub struct PgHost {
    me: Weak<PgHost>,
    next: Arc<dyn DbHostLink>,
    report: OnceLock<HostReport>,
    port: OnceLock<PgPortSink>,
    tunnels: Option<Arc<dyn PgTunnels>>,
    spawn: Spawn,
    connect_ms: u64,
    cursor_idle_ms: u64,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    pending: Arc<PendingRequests>,
}

fn failed(error: &str) -> Value {
    json!({ "ok": false, "error": error })
}

fn is_pg_open(config: &Value) -> bool {
    config.get("kind").and_then(Value::as_str) == Some("postgres")
}

impl PgHost {
    pub fn new(deps: PgHostDeps) -> Arc<PgHost> {
        Arc::new_cyclic(|me| PgHost {
            me: me.clone(),
            next: deps.next,
            report: OnceLock::new(),
            port: OnceLock::new(),
            tunnels: deps.tunnels,
            spawn: deps.spawn,
            connect_ms: deps.connect_ms,
            cursor_idle_ms: deps.cursor_idle_ms,
            sessions: Mutex::new(HashMap::new()),
            pending: Arc::new(PendingRequests::default()),
        })
    }

    /// Where its status messages go (the service's `onHostMessage`).
    pub fn connect(&self, report: HostReport) {
        let _ = self.report.set(report);
    }

    /// Where the DB port messages go.
    pub fn connect_port(&self, sink: PgPortSink) {
        let _ = self.port.set(sink);
    }

    /// Postgres sessions open or connecting.
    pub fn session_count(&self) -> usize {
        self.sessions.lock().len()
    }

    /// A session runs something (tests and the idle probe).
    pub fn busy(&self, id: &str) -> bool {
        self.get(id).and_then(|s| s.st.lock().pg.as_ref().map(PgSession::busy)).unwrap_or(false)
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

    fn open_session(&self, id: String, config: &Value) {
        if self.get(&id).is_some() {
            self.close(&id);
        }
        let ssh = config.get("ssh").filter(|v| v.is_object()).cloned();
        let (stop_tx, stop_rx) = oneshot::channel();
        let s = Arc::new(Session {
            id: id.clone(),
            config: PgOpenConfig::from_json(config),
            st: Mutex::new(SessionState {
                phase: "connecting".into(),
                ended: false,
                closing: false,
                password_ask: None,
                pg: None,
                joined_tunnel: false,
                stop: Some(stop_tx),
            }),
        });
        self.sessions.lock().insert(id, s.clone());
        self.status(&s, "connecting", Map::new());
        let joined = match (ssh, self.tunnels.clone()) {
            (Some(ssh), Some(tunnels)) => {
                s.st.lock().joined_tunnel = true;
                let (host, session) = (self.me.clone(), Arc::downgrade(&s));
                let fail: SessionFail = Arc::new(move |code| {
                    if let (Some(h), Some(s)) = (host.upgrade(), session.upgrade()) {
                        h.fail_owned(&s, code, None);
                    }
                });
                Some(tunnels.join(&s.id, &ssh, fail))
            }
            _ => None,
        };
        let Some(me) = self.me.upgrade() else { return };
        (self.spawn)(Box::pin(async move {
            // A closed session drops its connect (the TCP / TLS / login attempt and any password question).
            let start: BoxFuture<'static, ()> = Box::pin(me.start(s, joined));
            let _ = futures::future::select(start, stop_rx).await;
        }));
    }

    async fn start(self: Arc<Self>, s: Arc<Session>, joined: Option<BoxFuture<'static, Result<Arc<dyn Connector>, String>>>) {
        let connector: Arc<dyn Connector> = if s.config.ssh.is_some() {
            let Some(joined) = joined else {
                self.fail(&s, "unsupported", None);
                return;
            };
            match joined.await {
                Ok(c) => c,
                Err(code) => {
                    self.fail_owned(&s, code, None);
                    return;
                }
            }
        } else {
            let (host, port) = s.config.endpoint();
            Arc::new(TcpConnector::new(host, port))
        };
        if !self.live(&s) {
            return;
        }
        self.status(&s, "database", Map::new());
        let connect_timeout = Duration::from_millis(self.connect_ms);
        let mut prompt = Prompt { host: self.me.clone(), session: Arc::downgrade(&s) };
        let opened = match open(connector.as_ref(), &s.config, connect_timeout, &mut prompt).await {
            Ok(o) => o,
            Err(e) => {
                self.fail(&s, e.code, e.message);
                return;
            }
        };
        if !self.live(&s) {
            opened.client.end().await;
            return;
        }
        let cancel = SideCancel {
            connector: connector.clone(),
            target: s.config.target(connect_timeout),
            password: opened.password.clone(),
        };
        let mut options = PgSessionOptions::new(s.config.read_only, s.config.statement_timeout_ms, Arc::new(cancel));
        options.cursor_idle_ms = self.cursor_idle_ms;
        let out = Arc::new(Out { host: self.me.clone(), session: Arc::downgrade(&s) });
        let (server_version, tls) = (opened.server_version.clone(), opened.tls);
        let session = match PgSession::start(opened.client, options, out).await {
            Ok(p) => p,
            Err(e) => {
                self.fail(&s, e.code, e.message);
                return;
            }
        };
        if !self.live(&s) {
            session.end();
            return;
        }
        s.st.lock().pg = Some(session);
        let mut extra = Map::new();
        if let Some(v) = server_version {
            extra.insert("serverVersion".into(), json!(v));
        }
        extra.insert("database".into(), json!(s.config.database));
        extra.insert("tls".into(), json!(tls));
        self.status(&s, "connected", extra);
    }

    async fn ask_password(&self, s: &Session, retry: bool) -> Option<Zeroizing<String>> {
        let prompt_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        s.st.lock().password_ask = Some((prompt_id.clone(), tx));
        self.to_main(json!({ "t": "dbPasswordPrompt", "id": s.id, "promptId": prompt_id, "retry": retry }));
        rx.await.ok().flatten()
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
        let (ask, pg, joined, stop) = {
            let mut st = s.st.lock();
            st.ended = true;
            (st.password_ask.take(), st.pg.take(), std::mem::take(&mut st.joined_tunnel), st.stop.take())
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
        if let Some(p) = pg {
            p.end();
        }
        if joined && let Some(t) = &self.tunnels {
            t.release(&s.id);
        }
        drop(stop);
        match error {
            Some(error) => {
                let mut extra = Map::new();
                extra.insert("error".into(), json!(error));
                if let Some(m) = message.filter(|m| !m.is_empty()) {
                    extra.insert("message".into(), json!(utf16_head(&m, 2000).text));
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

    /// Ends every Postgres session (the wind-down's HOSTS step and a crash of the DB host).
    pub fn shutdown(&self) {
        let ids: Vec<String> = self.sessions.lock().keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }

    fn op(&self, id: &str, op: &Value) -> BoxFuture<'static, Value> {
        let Some(s) = self.get(id) else { return Box::pin(async { failed("noSession") }) };
        if op.get("op").and_then(Value::as_str) == Some("redis") {
            return Box::pin(async { failed("invalid") });
        }
        // The session reports (activity, tx) while it takes the operation: never call it under the state lock.
        let session = {
            let st = s.st.lock();
            if st.ended {
                return Box::pin(async { failed("noSession") });
            }
            match &st.pg {
                Some(p) if st.phase == "connected" => p.clone(),
                _ => return Box::pin(async { failed("notConnected") }),
            }
        };
        session.handle(op)
    }
}

/// The password question of one session's login.
struct Prompt {
    host: Weak<PgHost>,
    session: Weak<Session>,
}

impl PasswordPrompt for Prompt {
    fn ask(&mut self, retry: bool) -> BoxFuture<'_, Option<Zeroizing<String>>> {
        let (host, session) = (self.host.upgrade(), self.session.upgrade());
        Box::pin(async move {
            let (h, s) = (host?, session?);
            if !h.live(&s) {
                return None;
            }
            h.ask_password(&s, retry).await
        })
    }
}

/// A session's reports, while it is the live one.
struct Out {
    host: Weak<PgHost>,
    session: Weak<Session>,
}

impl Out {
    fn live(&self) -> Option<(Arc<PgHost>, Arc<Session>)> {
        let h = self.host.upgrade()?;
        let s = self.session.upgrade()?;
        h.live(&s).then_some((h, s))
    }
}

impl PgOut for Out {
    fn port(&self, m: PgPortMessage) {
        if let Some(h) = self.host.upgrade()
            && let Some(p) = h.port.get()
        {
            p(m);
        }
    }

    fn tx(&self, tx: &'static str) {
        if let Some((h, s)) = self.live() {
            h.to_main(json!({ "t": "dbTx", "id": s.id, "tx": tx }));
        }
    }

    fn activity(&self, busy: bool) {
        if let Some((h, s)) = self.live() {
            h.to_main(json!({ "t": "dbActivity", "id": s.id, "busy": busy }));
        }
    }

    fn fatal(&self) {
        if let Some((h, s)) = self.live() {
            h.fail(&s, "dbFailed", None);
        }
    }

    fn closed(&self) {
        if let Some((h, s)) = self.live() {
            let code = if s.config.ssh.is_some() { "tunnel" } else { "dbClosed" };
            h.fail(&s, code, None);
        }
    }
}

impl DbHostLink for PgHost {
    fn ensure(&self) -> bool {
        self.next.ensure()
    }

    fn send(&self, m: ToHost) -> bool {
        match m {
            ToHost::Open { id, config } if is_pg_open(&config) => {
                self.open_session(id, &config);
                true
            }
            ToHost::Open { id, config } => {
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
        let (rid, wait) = self.pending.start(op_timeout_ms(&op));
        let (Some(me), id) = (self.me.upgrade(), id.to_owned()) else { return wait };
        // The operation runs to its end on its own task (an answer main no longer waits for is dropped), as in 1.1.4.
        (self.spawn)(Box::pin(async move {
            let result = me.op(&id, &op).await;
            me.pending.resolve(rid, result);
        }));
        wait
    }
}
