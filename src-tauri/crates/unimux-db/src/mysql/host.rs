//! The MySQL / MariaDB half of the DB Host (src/dbhost/host.ts: `open`, `startMysql`, `openMysqlTls`, `openMysqlOnce`,
//! `mysqlSide`, `fail`, `finish`, `close`, `op`) as a [`DbHostLink`] in front of the link for the other kinds: a `dbOpen`
//! with `kind: 'mysql'` starts a MySQL session here, every other message and operation of a session that is not a MySQL
//! one goes to `next` (until D12 routes the kinds).
//!
//! A session: `connecting`; through SSH the shared tunnel first ([`DbTunnels`], D2); `database`; the login with the
//! connection's TLS mode (prefer: TLS first, plain again when the server has none), an empty password first when none is
//! saved; a refused password (ER_ACCESS_DENIED) asks the user (at most 3 prompts, `retry` once a password was refused);
//! VERSION(), the version comment and DATABASE(); a read-only connection is made READ ONLY on the server and the
//! statement timeout set (a failure there does not open the session); `connected` with the server label, the database and
//! whether TLS is on. A dropped connection ends the session (`dbClosed`, or `tunnel` through SSH).

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use super::conn::MyLogin;
use super::error::{ER_ACCESS_DENIED, MyError, connect_message, map_connect_error};
use super::open::{MyOpenParams, MyTlsMode, connect_tcp, open};
use super::port::MyPortMessage;
use super::session::{MyBoxConn, MysqlOptions, MysqlOut, MysqlSession, SideConnection};
use crate::host::{DbHostLink, HostReport, PendingRequests, Spawn, ToHost, op_timeout_ms};
use crate::redis::connect::{BoxStream, StreamSource};
use crate::redis::host::{DbTunnels, SessionFail};
use crate::sql::limits;
use crate::sql::mysql::{mysql_flavor_of, mysql_server_label, mysql_timeout_sql};
use crate::wire::value::{Head, node_utf8, utf16_head};

const MAX_PASSWORD_PROMPTS: u32 = 3;
/// One database connect attempt (TCP, TLS and the login): `DB_HOST_TIMERS.dbConnectMs`.
pub const DB_CONNECT_MS: u64 = 20_000;

/// Where the DB port messages go (routed per window by D12).
pub type MyPortSink = Arc<dyn Fn(MyPortMessage) + Send + Sync>;

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
    statement_timeout_ms: u64,
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
            statement_timeout_ms: c
                .get("statementTimeoutMs")
                .and_then(Value::as_f64)
                .filter(|v| v.is_finite() && *v > 0.0)
                .map_or(0, |v| v.floor() as u64),
            ssh: c.get("ssh").filter(|v| v.is_object()).cloned(),
        }
    }

    /// `endpoint`: through SSH the address the SSH server connects to (also the name checked against the certificate).
    fn endpoint(&self) -> (String, u16) {
        match &self.ssh {
            Some(ssh) => (
                ssh.get("dbHost").and_then(Value::as_str).unwrap_or("").to_owned(),
                ssh.get("dbPort").and_then(Value::as_f64).unwrap_or(0.0) as u16,
            ),
            None => (self.host.clone(), self.port),
        }
    }
}

struct SessionState {
    phase: String,
    ended: bool,
    /// Closed on request: the end reads "closed".
    closing: bool,
    password_ask: Option<(String, oneshot::Sender<Option<Zeroizing<String>>>)>,
    mysql: Option<MysqlSession>,
    /// The password the connection used (the side connection for KILL QUERY needs it); dropped when the session ends.
    password: Option<Zeroizing<String>>,
    tunnel: Option<StreamSource>,
    joined_tunnel: bool,
}

struct Session {
    id: String,
    config: OpenConfig,
    st: Mutex<SessionState>,
}

/// The MySQL / MariaDB sessions (see the module text).
pub struct MysqlHost {
    me: Weak<MysqlHost>,
    next: Arc<dyn DbHostLink>,
    report: OnceLock<HostReport>,
    port: OnceLock<MyPortSink>,
    tunnels: Option<Arc<dyn DbTunnels>>,
    spawn: Spawn,
    connect_ms: u64,
    cursor_idle_ms: u64,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    pending: Arc<PendingRequests>,
}

pub struct MysqlHostDeps {
    /// The link for every other kind of session.
    pub next: Arc<dyn DbHostLink>,
    pub spawn: Spawn,
    /// None: a session through SSH ends with `unsupported` (D2 adds the tunnels).
    pub tunnels: Option<Arc<dyn DbTunnels>>,
    pub connect_ms: u64,
    pub cursor_idle_ms: u64,
}

impl MysqlHostDeps {
    /// The 1.1.4 timers (20 s connect, DB_LIMITS.cursorIdleMs).
    pub fn new(next: Arc<dyn DbHostLink>, spawn: Spawn, tunnels: Option<Arc<dyn DbTunnels>>) -> Self {
        MysqlHostDeps { next, spawn, tunnels, connect_ms: DB_CONNECT_MS, cursor_idle_ms: limits::CURSOR_IDLE_MS }
    }
}

fn failed(error: &str) -> Value {
    json!({ "ok": false, "error": error })
}

fn head_text(h: Head) -> String {
    h.text
}

impl MysqlHost {
    pub fn new(deps: MysqlHostDeps) -> Arc<MysqlHost> {
        Arc::new_cyclic(|me| MysqlHost {
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

    /// For a service that holds the host: reports through a weak reference so neither keeps the other alive.
    pub fn connect_weak<T: Send + Sync + 'static>(&self, target: Weak<T>, f: fn(&T, Value)) {
        self.connect(Arc::new(move |m| {
            if let Some(t) = target.upgrade() {
                f(&t, m);
            }
        }));
    }

    /// Where the DB port messages go.
    pub fn connect_port(&self, sink: MyPortSink) {
        let _ = self.port.set(sink);
    }

    /// MySQL sessions open or connecting.
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

    fn open_session(&self, id: String, config: &Value) {
        if self.get(&id).is_some() {
            self.close(&id);
        }
        let config = OpenConfig::parse(config);
        let s = Arc::new(Session {
            id: id.clone(),
            st: Mutex::new(SessionState {
                phase: "connecting".into(),
                ended: false,
                closing: false,
                password_ask: None,
                mysql: None,
                password: config.password.clone(),
                tunnel: None,
                joined_tunnel: false,
            }),
            config,
        });
        self.sessions.lock().insert(id, s.clone());
        self.status(&s, "connecting", Map::new());
        // The tunnel is joined at once (1.1.4 registered the owner's wait for main's sshConnect in the same tick as dbOpen,
        // so the coordinator's connect cannot arrive before it); a tunnel that ends later ends the session.
        let joined = match (s.config.ssh.clone(), self.tunnels.clone()) {
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
        (self.spawn)(Box::pin(async move { me.start(s, joined).await }));
    }

    async fn start(self: Arc<Self>, s: Arc<Session>, joined: Option<BoxFuture<'static, Result<StreamSource, String>>>) {
        if s.config.ssh.is_some() {
            let Some(joined) = joined else {
                self.fail(&s, "unsupported", None);
                return;
            };
            match joined.await {
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
        self.start_mysql(&s).await;
    }

    /// `openMysqlTls`: one login with the session's endpoint, TLS mode and `database` ('' for the side connection), as an
    /// owned future (the main connection and the KILL QUERY side connection).
    fn open_tls(
        &self,
        s: &Session,
        password: Zeroizing<String>,
        database: String,
    ) -> BoxFuture<'static, Result<(MyBoxConn, bool), MyError>> {
        let (host, port) = s.config.endpoint();
        let params = MyOpenParams {
            host: host.clone(),
            tls: MyTlsMode::parse(&s.config.tls),
            ca: s.config.ca.clone(),
            login: MyLogin { user: s.config.user.clone(), password, database },
            connect_timeout: Duration::from_millis(self.connect_ms),
        };
        let tunnel = s.st.lock().tunnel.clone();
        let via_ssh = s.config.ssh.is_some();
        Box::pin(async move {
            let stream = move || {
                let (tunnel, host) = (tunnel.clone(), host.clone());
                async move {
                    match tunnel {
                        Some(src) => src().await.map_err(|e| MyError::Tunnel(e.to_string())),
                        // a session through SSH whose tunnel is gone
                        None if via_ssh => Err(MyError::Tunnel("tunnel closed".into())),
                        None => connect_tcp(&host, port).await.map(|t| Box::new(t) as BoxStream),
                    }
                }
            };
            open(&params, stream).await
        })
    }

    async fn ask_password(&self, s: &Session, retry: bool) -> Option<Zeroizing<String>> {
        let prompt_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        s.st.lock().password_ask = Some((prompt_id.clone(), tx));
        self.to_main(json!({ "t": "dbPasswordPrompt", "id": s.id, "promptId": prompt_id, "retry": retry }));
        rx.await.ok().flatten()
    }

    async fn start_mysql(&self, s: &Arc<Session>) {
        // No saved password: an empty one first (a server without one for this user logs in); refused, the user is asked.
        let mut password = s.config.password.clone();
        let mut prompts = 0;
        let via_ssh = s.config.ssh.is_some();
        let (mut conn, tls) = loop {
            if !self.live(s) {
                return;
            }
            let attempt = self.open_tls(s, password.clone().unwrap_or_default(), s.config.database.clone()).await;
            match attempt {
                Ok(o) => break o,
                Err(e) => {
                    if !self.live(s) {
                        return;
                    }
                    let message = connect_message(&e).map(head_text);
                    if e.errno() != Some(ER_ACCESS_DENIED) {
                        self.fail(s, map_connect_error(&e, via_ssh), message);
                        return;
                    }
                    if prompts >= MAX_PASSWORD_PROMPTS {
                        self.fail(s, "dbAuth", message);
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
            return;
        }
        s.st.lock().password = Some(password.unwrap_or_default());
        let (version, comment, database) = match conn.exec("SELECT VERSION(), @@version_comment, DATABASE()").await {
            Ok(r) => {
                let cell = |i: usize| r.rows.first().and_then(|row| row.get(i)).map(node_utf8);
                (cell(0).unwrap_or_default(), cell(1).unwrap_or_default(), cell(2).unwrap_or_default())
            }
            Err(e) => {
                if self.live(s) {
                    self.fail(s, map_connect_error(&e, false), connect_message(&e).map(head_text));
                }
                return;
            }
        };
        let flavor = mysql_flavor_of(&version, &comment);
        let mut settings = Vec::new();
        if s.config.read_only {
            settings.push("SET SESSION TRANSACTION READ ONLY".to_owned());
        }
        if s.config.statement_timeout_ms > 0 {
            settings.push(mysql_timeout_sql(flavor, Some(s.config.statement_timeout_ms as f64)));
        }
        for sql in settings {
            // A read-only connection that cannot be made read-only on the server is not opened.
            if let Err(e) = conn.exec(&sql).await {
                if self.live(s) {
                    self.fail(s, "dbFailed", connect_message(&e).map(head_text));
                }
                return;
            }
        }
        if !self.live(s) {
            return;
        }
        let side: SideConnection = {
            let (host, session) = (self.me.clone(), Arc::downgrade(s));
            Arc::new(move || {
                let (Some(h), Some(s)) = (host.upgrade(), session.upgrade()) else {
                    return Box::pin(async { Err(MyError::Closed) });
                };
                if !h.live(&s) {
                    return Box::pin(async { Err(MyError::Closed) });
                }
                let password = s.st.lock().password.clone().unwrap_or_default();
                let f = h.open_tls(&s, password, String::new());
                Box::pin(async move { f.await.map(|(c, _)| c) })
            })
        };
        let out = Arc::new(Out { host: self.me.clone(), session: Arc::downgrade(s) });
        let session = MysqlSession::start(
            conn,
            MysqlOptions {
                read_only: s.config.read_only,
                statement_timeout_ms: s.config.statement_timeout_ms,
                flavor,
                side_connection: side,
                cursor_idle_ms: self.cursor_idle_ms,
                via_tunnel: via_ssh,
            },
            out,
        );
        s.st.lock().mysql = Some(session);
        let mut extra = Map::new();
        if !version.is_empty() {
            extra.insert("serverVersion".into(), json!(mysql_server_label(&version, &comment)));
        }
        extra.insert("database".into(), json!(database));
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
        let (ask, mysql, joined) = {
            let mut st = s.st.lock();
            st.ended = true;
            st.password = None;
            st.tunnel = None;
            (st.password_ask.take(), st.mysql.take(), std::mem::take(&mut st.joined_tunnel))
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
        // An idle connection says goodbye (COM_QUIT); one with a statement or an open result on it is cut.
        if let Some(m) = mysql {
            m.end();
        }
        if joined && let Some(t) = &self.tunnels {
            t.release(&s.id);
        }
        match error {
            Some(error) => {
                let mut extra = Map::new();
                extra.insert("error".into(), json!(error));
                if let Some(m) = message {
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

    /// Ends every MySQL session (the wind-down's HOSTS step, D12).
    pub fn shutdown(&self) {
        let ids: Vec<String> = self.sessions.lock().keys().cloned().collect();
        for id in ids {
            self.close(&id);
        }
    }

    async fn op(&self, id: &str, op: Value) -> Value {
        let Some(s) = self.get(id) else { return failed("noSession") };
        if op.get("op").and_then(Value::as_str) == Some("redis") {
            return failed("invalid");
        }
        let session = {
            let st = s.st.lock();
            if st.ended {
                return failed("noSession");
            }
            match &st.mysql {
                Some(m) if st.phase == "connected" => m.clone(),
                _ => return failed("notConnected"),
            }
        };
        session.handle(&op).await
    }
}

/// A session's reports, while it is the live one.
struct Out {
    host: Weak<MysqlHost>,
    session: Weak<Session>,
}

impl Out {
    fn live(&self) -> Option<(Arc<MysqlHost>, Arc<Session>)> {
        let h = self.host.upgrade()?;
        let s = self.session.upgrade()?;
        h.live(&s).then_some((h, s))
    }
}

impl MysqlOut for Out {
    fn port(&self, m: MyPortMessage) {
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

    fn database(&self, name: String) {
        if let Some((h, s)) = self.live() {
            h.to_main(json!({ "t": "dbDatabase", "id": s.id, "database": name }));
        }
    }

    fn fatal(&self, error: &'static str) {
        if let (Some(h), Some(s)) = (self.host.upgrade(), self.session.upgrade()) {
            h.fail(&s, error, None);
        }
    }
}

fn is_mysql_open(config: &Value) -> bool {
    config.get("kind").and_then(Value::as_str) == Some("mysql")
}

impl DbHostLink for MysqlHost {
    fn ensure(&self) -> bool {
        self.next.ensure()
    }

    fn send(&self, m: ToHost) -> bool {
        match m {
            ToHost::Open { id, config } if is_mysql_open(&config) => {
                self.open_session(id, &config);
                true
            }
            ToHost::Open { id, config } => {
                // the id may have been a MySQL session before
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
            let result = me.op(&id, op).await;
            me.pending.resolve(rid, result);
        }));
        wait
    }
}
