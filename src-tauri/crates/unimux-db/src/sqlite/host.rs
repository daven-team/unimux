//! D12: the SQLite half of the DB Host (src/dbhost/host.ts: `open`, `start` and `startSqlite` for `kind: 'sqlite'`,
//! `fail`, `finish`, `close`, `op`) as a [`DbHostLink`] in front of the link for the other kinds.
//!
//! A session: `connecting`, `database`, then [`SqliteSession::open`] (the file must exist; it is opened in an engine thread
//! of its own), `connected` with `SQLite <version>` and the database `main` (no `tls`: a file on this computer is not a
//! network connection). The session's notices go to the log as `[db <id>] ...`; a dead engine thread ends the session.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, Weak};

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};

use super::port::PortMessage;
use super::session::{SqliteOptions, SqliteOut, SqliteSession};
use crate::host::{DbHostLink, HostReport, PendingRequests, Spawn, ToHost, op_timeout_ms};
use crate::wire::value::utf16_head;

/// Where the DB port messages go (routed per window by [`crate::route::DbPorts`]).
pub type SqlitePortSink = Arc<dyn Fn(PortMessage) + Send + Sync>;
/// `log` messages of the host: (level "warn" / "error", text).
pub type HostLog = Arc<dyn Fn(&str, &str) + Send + Sync>;

struct SessionState {
    phase: String,
    ended: bool,
    closing: bool,
    sqlite: Option<SqliteSession>,
}

struct Session {
    id: String,
    path: String,
    read_only: bool,
    st: Mutex<SessionState>,
}

/// The SQLite sessions (see the module text).
pub struct SqliteHost {
    me: Weak<SqliteHost>,
    next: Arc<dyn DbHostLink>,
    report: OnceLock<HostReport>,
    port: OnceLock<SqlitePortSink>,
    log: OnceLock<HostLog>,
    spawn: Spawn,
    /// Tests shorten the engine's waits.
    options: Arc<dyn Fn(SqliteOptions) -> SqliteOptions + Send + Sync>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    pending: Arc<PendingRequests>,
}

fn failed(error: &str) -> Value {
    json!({ "ok": false, "error": error })
}

fn is_sqlite_open(config: &Value) -> bool {
    config.get("kind").and_then(Value::as_str) == Some("sqlite")
}

/// `s.id.slice(3, 11)` (ids are `db:<uuid>`, ASCII).
fn short_id(id: &str) -> String {
    id.chars().skip(3).take(8).collect()
}

impl SqliteHost {
    pub fn new(next: Arc<dyn DbHostLink>, spawn: Spawn) -> Arc<SqliteHost> {
        Self::with_options(next, spawn, Arc::new(|o| o))
    }

    pub fn with_options(
        next: Arc<dyn DbHostLink>,
        spawn: Spawn,
        options: Arc<dyn Fn(SqliteOptions) -> SqliteOptions + Send + Sync>,
    ) -> Arc<SqliteHost> {
        Arc::new_cyclic(|me| SqliteHost {
            me: me.clone(),
            next,
            report: OnceLock::new(),
            port: OnceLock::new(),
            log: OnceLock::new(),
            spawn,
            options,
            sessions: Mutex::new(HashMap::new()),
            pending: Arc::new(PendingRequests::default()),
        })
    }

    pub fn connect(&self, report: HostReport) {
        let _ = self.report.set(report);
    }

    pub fn connect_port(&self, sink: SqlitePortSink) {
        let _ = self.port.set(sink);
    }

    pub fn connect_log(&self, log: HostLog) {
        let _ = self.log.set(log);
    }

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
        let s = Arc::new(Session {
            id: id.clone(),
            path: config.get("path").and_then(Value::as_str).unwrap_or("").to_owned(),
            read_only: config.get("readOnly").and_then(Value::as_bool).unwrap_or(false),
            st: Mutex::new(SessionState { phase: "connecting".into(), ended: false, closing: false, sqlite: None }),
        });
        self.sessions.lock().insert(id, s.clone());
        self.status(&s, "connecting", Map::new());
        let Some(me) = self.me.upgrade() else { return };
        (self.spawn)(Box::pin(async move { me.start(s).await }));
    }

    async fn start(self: Arc<Self>, s: Arc<Session>) {
        self.status(&s, "database", Map::new());
        let out = Arc::new(Out { host: self.me.clone(), session: Arc::downgrade(&s) });
        let options = (self.options)(SqliteOptions::new(s.path.clone(), s.read_only));
        let session = match SqliteSession::open(options, out).await {
            Ok(x) => x,
            Err(e) => {
                self.fail(&s, e.error, e.message);
                return;
            }
        };
        if !self.live(&s) {
            session.end();
            return;
        }
        let status = session.connected_status();
        s.st.lock().sqlite = Some(session);
        let extra = status.as_object().cloned().unwrap_or_default();
        self.status(&s, "connected", extra);
    }

    fn fail(&self, s: &Arc<Session>, error: &'static str, message: Option<String>) {
        if !self.live(s) {
            return;
        }
        let closing = s.st.lock().closing;
        self.finish(s, (!closing).then_some(error), message);
    }

    fn finish(&self, s: &Arc<Session>, error: Option<&'static str>, message: Option<String>) {
        let sqlite = {
            let mut st = s.st.lock();
            st.ended = true;
            st.sqlite.take()
        };
        {
            let mut map = self.sessions.lock();
            if map.get(&s.id).is_some_and(|x| Arc::ptr_eq(x, s)) {
                map.remove(&s.id);
            }
        }
        if let Some(x) = sqlite {
            x.end();
        }
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

    /// Ends every SQLite session (the wind-down's HOSTS step and a crash of the DB host).
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
            match &st.sqlite {
                Some(x) if st.phase == "connected" => x.clone(),
                _ => return Box::pin(async { failed("notConnected") }),
            }
        };
        session.handle(op)
    }
}

struct Out {
    host: Weak<SqliteHost>,
    session: Weak<Session>,
}

impl Out {
    fn live(&self) -> Option<(Arc<SqliteHost>, Arc<Session>)> {
        let h = self.host.upgrade()?;
        let s = self.session.upgrade()?;
        h.live(&s).then_some((h, s))
    }
}

impl SqliteOut for Out {
    fn port(&self, m: PortMessage) {
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

    fn notice(&self, message: &str) {
        if let (Some(h), Some(s)) = (self.host.upgrade(), self.session.upgrade())
            && let Some(log) = h.log.get()
        {
            log("warn", &format!("[db {}] {message}", short_id(&s.id)));
        }
    }

    fn fatal(&self, error: &'static str, message: Option<String>) {
        if let (Some(h), Some(s)) = (self.host.upgrade(), self.session.upgrade()) {
            h.fail(&s, error, message);
        }
    }
}

impl DbHostLink for SqliteHost {
    fn ensure(&self) -> bool {
        self.next.ensure()
    }

    fn send(&self, m: ToHost) -> bool {
        match m {
            ToHost::Open { id, config } if is_sqlite_open(&config) => {
                self.open_session(id, &config);
                true
            }
            ToHost::Open { id, config } => {
                self.close(&id);
                self.next.send(ToHost::Open { id, config })
            }
            // SQLite never asks for a password.
            ToHost::PasswordAnswer { id, prompt_id, value } => {
                if self.get(&id).is_some() {
                    true
                } else {
                    self.next.send(ToHost::PasswordAnswer { id, prompt_id, value })
                }
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
        (self.spawn)(Box::pin(async move {
            let result = me.op(&id, &op).await;
            me.pending.resolve(rid, result);
        }));
        wait
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn short_ids_are_the_first_uuid_part() {
        assert_eq!(short_id("db:1b4e28ba-2fa1-11d2-883f-0016d3cca427"), "1b4e28ba");
        assert_eq!(short_id("db:"), "");
    }
}
