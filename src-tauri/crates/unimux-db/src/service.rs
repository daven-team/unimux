//! Main side of database connections and sessions (port of src/main/db/service.ts): the saved connections (state.json, no
//! secrets) and their passwords ([`DbVault`]), "Test connection", and the sessions: it opens a session in the host with the
//! decrypted password and the CA file in the open message only, logs a tunnel in through the SSH coordinator (S3; same
//! vault, known hosts and prompts as a cell), asks the renderer for a database password when the server wants one, keeps the
//! session state the renderer sees (`db:session`, `db:prompt`), and disconnects a session nobody pinned after it was idle for
//! 5 minutes.
//!
//! One mutex guards the sessions (the service is an actor without a channel: every step is short). Calls that can come back
//! into the service (the coordinator, state edits) are made with the lock released; the host link, the vault and the event
//! sink never call back synchronously.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Weak};

use futures::future::BoxFuture;
use parking_lot::{Mutex, MutexGuard};
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

use crate::host::{DbHostLink, Spawn, ToHost};
use crate::model::{
    self, connections, db_default_database, db_endpoint, db_session_id, db_status_of, find_connection, is_db_session_id,
    is_live_db_phase, is_sql_kind, kind_of, same, strict_connection, tunnel_key_of,
};
use crate::sql::limits;
use crate::sql::mysql::mysql_flavor_of;
use crate::timers::{TimerId, Timers};
use crate::vault::{DbVault, Password, SetPassword};

pub const PROMPT_TIMEOUT_MS: u64 = 5 * 60_000;
pub const TEST_TIMEOUT_MS: u64 = 7 * 60_000;

/// The state the service reads and edits (the StateController in the app).
pub trait DbStateAccess: Send + Sync {
    fn state(&self) -> Arc<Value>;
    /// A main-side state edit (StateController.change).
    fn change(&self, f: Box<dyn FnOnce(&Value) -> Value + Send>);
    fn ssh_host_exists(&self, host_id: &str) -> bool;
}

/// `db:session`, `db:prompt`, `db:hostCrashed`, `db:vault:changed` (the app sends the vault info with the last one).
pub trait DbEvents: Send + Sync {
    fn session(&self, state: &Value);
    fn prompt(&self, session_id: &str, prompt: Option<&Value>);
    fn host_crashed(&self);
    fn vault_changed(&self);
}

/// What the service needs of the SSH coordinator (S3) for a session's tunnel.
pub trait DbCoordinator: Send + Sync {
    /// Logs the tunnel of `session_id` in; Err(code) when it refused up front (other failures arrive as an `error` state
    /// through [`DbService::on_coordinator_session`]).
    fn connect_session(&self, session_id: &str, host_id: &str) -> BoxFuture<'static, Result<(), String>>;
    fn end_session(&self, session_id: &str);
    /// A prompt answer for a tunnel question: `{cellId, promptId, ...}`.
    fn answer(&self, answer: Value) -> bool;
    /// `sessionSnapshot('db').prompts`: `(cellId, prompt)`.
    fn prompts(&self) -> Vec<(String, Value)>;
    /// The SSH status, host key and auth prompt messages of a DB session's tunnel.
    fn on_host_message(&self, m: &Value);
    /// `sessionHostCrashed('db')`.
    fn session_host_crashed(&self);
}

/// The coordinator until S3 lands: a tunnel login is refused (`unsupported`), there are no tunnel prompts.
pub struct NoCoordinator;

impl DbCoordinator for NoCoordinator {
    fn connect_session(&self, _session_id: &str, _host_id: &str) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Err("unsupported".to_string()) })
    }
    fn end_session(&self, _session_id: &str) {}
    fn answer(&self, _answer: Value) -> bool {
        false
    }
    fn prompts(&self) -> Vec<(String, Value)> {
        Vec::new()
    }
    fn on_host_message(&self, _m: &Value) {}
    fn session_host_crashed(&self) {}
}

pub type ReadCa = Arc<dyn Fn(String) -> BoxFuture<'static, Option<String>> + Send + Sync>;

pub struct DbDeps {
    pub state: Arc<dyn DbStateAccess>,
    pub host: Arc<dyn DbHostLink>,
    pub coordinator: Arc<dyn DbCoordinator>,
    pub vault: Arc<DbVault>,
    /// The CA file of verify-full (None: unreadable, too big or not a file).
    pub read_ca: ReadCa,
    pub events: Arc<dyn DbEvents>,
    pub timers: Arc<dyn Timers>,
    pub spawn: Spawn,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub new_uuid: Arc<dyn Fn() -> String + Send + Sync>,
    pub idle_ms: u64,
    pub prompt_timeout_ms: u64,
    pub test_timeout_ms: u64,
}

/// The password part of a save (`DbPasswordChange`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PasswordChange {
    Keep,
    Set(Zeroizing<String>),
    Clear,
}

/// The password of a test (`{set} | {saved} | null`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TestPassword {
    Set(Zeroizing<String>),
    Saved(String),
    None,
}

enum OpenPassword {
    Saved,
    Given(Option<Zeroizing<String>>),
}

struct OwnPrompt {
    prompt: Value,
    host_prompt_id: String,
    timer: TimerId,
}

struct Entry {
    id: String,
    state: Map<String, Value>,
    connection: Value,
    idle: Option<TimerId>,
    busy: bool,
    own: Option<OwnPrompt>,
    /// A typed password to save once the session connected ("Zapamiętaj").
    pending_save: Option<Zeroizing<String>>,
    test: Option<oneshot::Sender<Value>>,
    test_timer: Option<TimerId>,
    /// A test was refused with the form's password: it ends as a wrong password instead of asking again.
    test_auth_failed: bool,
    started: i64,
    /// The shared SSH tunnel this session uses (key of `tunnels`).
    tunnel_key: Option<String>,
}

struct TunnelRef {
    owner: String,
    refs: Vec<String>,
}

#[derive(Default)]
struct Inner {
    sessions: Vec<Entry>,
    tunnels: HashMap<String, TunnelRef>,
    pinned: HashSet<String>,
    /// The pins of each window ('main' and detached windows); `pinned` is their union.
    pins_by: HashMap<String, HashSet<String>>,
}

impl Inner {
    fn entry(&mut self, id: &str) -> Option<&mut Entry> {
        self.sessions.iter_mut().find(|e| e.id == id)
    }
    fn has(&self, id: &str) -> bool {
        self.sessions.iter().any(|e| e.id == id)
    }
}

type Effect = Box<dyn FnOnce() + Send>;

/// The session lock (derefs to the sessions).
struct Guard<'a>(Option<MutexGuard<'a, Inner>>);

impl std::ops::Deref for Guard<'_> {
    type Target = Inner;
    fn deref(&self) -> &Inner {
        self.0.as_ref().expect("held until the drop")
    }
}

impl std::ops::DerefMut for Guard<'_> {
    fn deref_mut(&mut self) -> &mut Inner {
        self.0.as_mut().expect("held until the drop")
    }
}

/// The lock plus what runs once it is released (state edits, whose change hooks may come back into the service).
struct Locked<'a> {
    inner: Guard<'a>,
    after: Vec<Effect>,
}

impl Drop for Locked<'_> {
    fn drop(&mut self) {
        drop(self.inner.0.take());
        for f in std::mem::take(&mut self.after) {
            f();
        }
    }
}

fn text(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

fn str_field<'a>(v: &'a Value, key: &str) -> &'a str {
    v.get(key).and_then(Value::as_str).unwrap_or_default()
}

pub struct DbService {
    deps: DbDeps,
    inner: Mutex<Inner>,
    me: Weak<DbService>,
    turns: Turns,
}

/// The starts of the sessions take their turns in the order the sessions opened, like 1.1.4's starts deferred with
/// `setImmediate` (first in, first run): the first session of a connection owns the SSH tunnel login and its `dbOpen`
/// reaches the host before the riders' ones, whichever task the runtime happens to run first.
#[derive(Default)]
struct Turns {
    st: Mutex<TurnState>,
    changed: tokio::sync::Notify,
}

#[derive(Default)]
struct TurnState {
    issued: u64,
    serving: u64,
    /// Tickets that finished before their turn came (a session closed before its start ran).
    done: std::collections::BTreeSet<u64>,
}

impl Turns {
    fn ticket(&self) -> u64 {
        let mut st = self.st.lock();
        st.issued += 1;
        st.issued - 1
    }

    async fn wait(&self, ticket: u64) {
        loop {
            let mut changed = std::pin::pin!(self.changed.notified());
            changed.as_mut().enable();
            if self.st.lock().serving >= ticket {
                return;
            }
            changed.await;
        }
    }

    fn finish(&self, ticket: u64) {
        {
            let mut st = self.st.lock();
            st.done.insert(ticket);
            loop {
                let serving = st.serving;
                if !st.done.remove(&serving) {
                    break;
                }
                st.serving += 1;
            }
        }
        self.changed.notify_waiters();
    }
}

/// Ends a start's turn however the start ends.
struct Turn<'a>(&'a Turns, u64);

impl Drop for Turn<'_> {
    fn drop(&mut self) {
        self.0.finish(self.1);
    }
}

impl DbService {
    pub fn new(deps: DbDeps) -> Arc<Self> {
        Arc::new_cyclic(|me| Self { deps, inner: Mutex::new(Inner::default()), me: me.clone(), turns: Turns::default() })
    }

    fn now(&self) -> i64 {
        (self.deps.now)()
    }

    fn conns(&self) -> Vec<Value> {
        connections(&self.deps.state.state())
    }

    // ── saved connections ───────────────────────────────────────────────────────

    pub fn vault_info(&self) -> Value {
        self.deps.vault.info().to_json()
    }

    /// `saveConnection(input, password)`.
    pub fn save_connection(&self, input: &Value, password: &PasswordChange) -> Value {
        let list = self.conns();
        let input_id = text(input.get("id"));
        let existing = input_id.and_then(|id| find_connection(&list, id)).cloned();
        if input_id.is_some() && existing.is_none() {
            return json!({ "ok": false, "error": "notFound" });
        }
        let now = self.now();
        let mut raw = input.as_object().cloned().unwrap_or_default();
        raw.insert("id".into(), json!(input_id.map(str::to_string).unwrap_or_else(|| (self.deps.new_uuid)())));
        raw.insert("createdAt".into(), existing.as_ref().and_then(|e| e.get("createdAt").cloned()).unwrap_or(json!(now)));
        raw.insert("updatedAt".into(), json!(now));
        let Some(mut connection) = strict_connection(&Value::Object(raw)) else {
            return json!({ "ok": false, "error": "invalid" });
        };
        // The flavour a MySQL server showed stays until it connects again.
        if let Some(e) = &existing
            && let Some(flavor) = e.get("flavor").filter(|f| model::js_truthy(f))
            && kind_of(e) == kind_of(&connection)
        {
            connection["flavor"] = flavor.clone();
        }
        let vault = &self.deps.vault;
        if *password != PasswordChange::Keep && vault.read_only() {
            return json!({ "ok": false, "error": "readOnly" });
        }
        let id = str_field(&connection, "id").to_string();
        let written = match password {
            PasswordChange::Set(p) => vault.set_password(&id, p).map(|_| ()),
            PasswordChange::Clear => vault.clear_password(&id).map(|_| ()),
            PasswordChange::Keep => Ok(()),
        };
        if written.is_err() {
            return json!({ "ok": false, "error": "failed" });
        }
        let c = connection.clone();
        self.deps.state.change(Box::new(move |s| model::upsert_db_connection(s, &c)));
        if *password != PasswordChange::Keep {
            self.deps.events.vault_changed();
        }
        json!({ "ok": true, "connection": connection })
    }

    pub fn delete_connection(&self, id: &str) -> Value {
        if find_connection(&self.conns(), id).is_none() {
            return json!({ "ok": false });
        }
        let ids: Vec<String> = {
            let inner = self.inner.lock();
            inner.sessions.iter().filter(|e| str_field(&e.connection, "id") == id).map(|e| e.id.clone()).collect()
        };
        for sid in ids {
            self.disconnect(&sid);
        }
        let gone = id.to_string();
        self.deps.state.change(Box::new(move |s| model::remove_db_connection(s, &gone)));
        // A failed write: pruned on the next state change.
        if let Ok(true) = self.deps.vault.clear_password(id) {
            self.deps.events.vault_changed();
        }
        json!({ "ok": true })
    }

    pub fn duplicate_connection(&self, id: &str) -> Value {
        if find_connection(&self.conns(), id).is_none() {
            return json!({ "ok": false });
        }
        let new_id = (self.deps.new_uuid)();
        let (from, to, now) = (id.to_string(), new_id.clone(), self.now());
        self.deps.state.change(Box::new(move |s| model::duplicate_db_connection(s, &from, &to, now)));
        let Some(copy) = find_connection(&self.conns(), &new_id).cloned() else { return json!({ "ok": false }) };
        // A failed copy: the copy asks for its password.
        if let Ok(true) = self.deps.vault.copy_password(id, &new_id) {
            self.deps.events.vault_changed();
        }
        json!({ "ok": true, "connection": copy })
    }

    /// After every state change (with the new state): passwords of deleted connections go.
    pub fn state_changed(&self, state: &Value) {
        let ids: HashSet<String> = connections(state).iter().map(|c| str_field(c, "id").to_string()).collect();
        if let Ok(true) = self.deps.vault.prune(&|id| ids.contains(id)) {
            self.deps.events.vault_changed();
        }
    }

    /// Connects with the form's values, waits until connected or failed (prompts included) and disconnects again.
    pub fn test_connection(&self, input: &Value, password: &TestPassword) -> BoxFuture<'static, Value> {
        let ready = |v: Value| -> BoxFuture<'static, Value> { Box::pin(async move { v }) };
        let now = self.now();
        let mut raw = input.as_object().cloned().unwrap_or_default();
        raw.insert("id".into(), json!((self.deps.new_uuid)()));
        raw.insert("createdAt".into(), json!(now));
        raw.insert("updatedAt".into(), json!(now));
        let Some(connection) = strict_connection(&Value::Object(raw)) else {
            return ready(json!({ "ok": false, "error": "invalid" }));
        };
        let secret = match password {
            TestPassword::Set(p) => Some(p.clone()),
            TestPassword::Saved(saved_id) => {
                // A saved password goes only to the server it was saved for: same kind, host, port, user and tunnel.
                let list = self.conns();
                let Some(saved) = find_connection(&list, saved_id) else {
                    return ready(json!({ "ok": false, "error": "invalid" }));
                };
                let direct = connection.get("ssh").is_none_or(Value::is_null);
                if kind_of(saved) != kind_of(&connection)
                    || saved.get("user") != connection.get("user")
                    || !same(saved.get("ssh"), connection.get("ssh"))
                    || (direct
                        && (saved.get("host") != connection.get("host")
                            || !model::js_eq(saved.get("port"), connection.get("port"))))
                {
                    return ready(json!({ "ok": false, "error": "invalid" }));
                }
                match self.deps.vault.password(saved_id) {
                    Password::Ok(p) => Some(p),
                    _ => None,
                }
            }
            TestPassword::None => None,
        };
        let (tx, rx) = oneshot::channel();
        match self.open(connection, OpenPassword::Given(secret), Some(tx)) {
            Err(error) => ready(json!({ "ok": false, "error": error })),
            Ok(_) => Box::pin(async move { rx.await.unwrap_or_else(|_| json!({ "ok": false, "error": "dbClosed" })) }),
        }
    }

    // ── sessions ────────────────────────────────────────────────────────────────

    /// Answers at once with the session id; the login (which may wait for prompts) runs after this answer went out.
    pub fn connect(&self, connection_id: &str, database: Option<&str>) -> Result<String, String> {
        let list = self.conns();
        let Some(connection) = find_connection(&list, connection_id).cloned() else { return Err("connectionMissing".into()) };
        let kind = kind_of(&connection).to_string();
        let target = match database {
            None => connection,
            Some(_) if !is_sql_kind(&kind) || kind == "sqlite" => connection,
            Some("") if kind != "mysql" => connection,
            Some(db) => {
                let mut c = connection;
                let m = c.as_object_mut().expect("a connection is an object");
                if db.is_empty() {
                    // `{...connection, database: undefined}`: the key stays where it was, without a value.
                    m.shift_remove("database");
                } else {
                    m.insert("database".into(), json!(db));
                }
                c
            }
        };
        self.open(target, OpenPassword::Saved, None)
    }

    fn lock(&self) -> Locked<'_> {
        Locked { inner: Guard(Some(self.inner.lock())), after: Vec::new() }
    }

    fn open(&self, connection: Value, password: OpenPassword, test: Option<oneshot::Sender<Value>>) -> Result<String, String> {
        if let Some(ssh) = connection.get("ssh").filter(|s| s.is_object())
            && !self.deps.state.ssh_host_exists(str_field(ssh, "hostId"))
        {
            return Err("hostMissing".into());
        }
        let mut l = self.lock();
        let cid = str_field(&connection, "id").to_string();
        let total = l.inner.sessions.len();
        let mine = l.inner.sessions.iter().filter(|e| str_field(&e.connection, "id") == cid).count();
        if total >= limits::SESSIONS_TOTAL || mine >= limits::SESSIONS_PER_CONNECTION {
            return Err("tooMany".into());
        }
        if !self.deps.host.ensure() {
            return Err("dbHostCrashed".into());
        }
        let id = db_session_id(&(self.deps.new_uuid)());
        let now = self.now();
        let mut state = Map::new();
        state.insert("id".into(), json!(id));
        state.insert("connectionId".into(), json!(cid));
        state.insert("kind".into(), json!(kind_of(&connection)));
        state.insert("state".into(), json!("connecting"));
        state.insert("phase".into(), json!("connecting"));
        state.insert("since".into(), json!(now));
        state.insert("readOnly".into(), connection.get("readOnly").cloned().unwrap_or(json!(false)));
        state.insert("database".into(), json!(db_default_database(&connection)));
        let is_test = test.is_some();
        if is_test {
            state.insert("test".into(), json!(true));
        }
        let test_timer = is_test.then(|| {
            let me = self.me.clone();
            let sid = id.clone();
            self.deps.timers.after(
                self.deps.test_timeout_ms,
                Box::new(move || {
                    if let Some(svc) = me.upgrade() {
                        svc.test_timed_out(&sid);
                    }
                }),
            )
        });
        l.inner.sessions.push(Entry {
            id: id.clone(),
            state,
            connection,
            idle: None,
            busy: false,
            own: None,
            pending_save: None,
            test,
            test_timer,
            test_auth_failed: false,
            started: now,
            tunnel_key: None,
        });
        let snapshot = Value::Object(l.inner.entry(&id).expect("just added").state.clone());
        self.deps.events.session(&snapshot);
        // The id goes back first, so every 'db:session' and 'db:prompt' event names an id the renderer already has. The
        // ticket is taken under the session lock: the starts take their turns in the order the sessions opened.
        let ticket = self.turns.ticket();
        let me = self.me.clone();
        let sid = id.clone();
        (self.deps.spawn)(Box::pin(async move {
            if let Some(svc) = me.upgrade() {
                svc.start(sid, password, ticket).await;
            }
        }));
        drop(l);
        Ok(id)
    }

    fn test_timed_out(&self, id: &str) {
        let mut l = self.lock();
        let Some(e) = l.inner.entry(id) else { return };
        let Some(done) = e.test.take() else { return };
        e.test_timer = None;
        let _ = done.send(json!({ "ok": false, "error": "dbTimeout" }));
        self.disconnect_in(&mut l, id);
    }

    async fn start(&self, id: String, password: OpenPassword, ticket: u64) {
        let turn = Turn(&self.turns, ticket);
        let Some(c) = self.inner.lock().entry(&id).map(|e| e.connection.clone()) else { return };
        let mut ca = None;
        if str_field(&c, "tls") == "verify-full" {
            let path = text(c.get("caPath")).filter(|p| !p.is_empty()).map(str::to_string);
            let read = match path {
                Some(p) => (self.deps.read_ca)(p).await,
                None => None,
            };
            let mut l = self.lock();
            if !l.inner.has(&id) {
                return;
            }
            match read {
                None => {
                    self.end(&mut l, &id, "error", Some("caFile"), None);
                    return;
                }
                Some(text) => ca = Some(text),
            }
        }
        let secret = match password {
            OpenPassword::Saved => match self.deps.vault.password(str_field(&c, "id")) {
                Password::Ok(p) => Some(p),
                _ => None,
            },
            OpenPassword::Given(p) => p,
        };
        self.turns.wait(ticket).await;
        let login = {
            let mut l = self.lock();
            // A session closed before its start ran opens nothing (and takes no tunnel reference).
            if !l.inner.has(&id) {
                return;
            }
            // One SSH login per connection: the first session opens the tunnel, the others ride on it.
            let key = tunnel_key_of(&c);
            let mut owner = false;
            if let Some(key) = &key {
                let t = l.inner.tunnels.entry(key.clone()).or_insert_with(|| {
                    owner = true;
                    TunnelRef { owner: id.clone(), refs: Vec::new() }
                });
                if !t.refs.contains(&id) {
                    t.refs.push(id.clone());
                }
                l.inner.entry(&id).expect("checked").tunnel_key = Some(key.clone());
            }
            let mut config = Map::new();
            config.insert("kind".into(), json!(kind_of(&c)));
            config.insert("host".into(), c.get("host").cloned().unwrap_or(json!("")));
            config.insert("port".into(), c.get("port").cloned().unwrap_or(json!(0)));
            config.insert("user".into(), c.get("user").cloned().unwrap_or(json!("")));
            config.insert("database".into(), json!(db_default_database(&c)));
            config.insert("tls".into(), c.get("tls").cloned().unwrap_or(json!("disable")));
            if let Some(ca) = ca.filter(|s| !s.is_empty()) {
                config.insert("ca".into(), json!(ca));
            }
            if let Some(p) = &secret {
                config.insert("password".into(), json!(p.as_str()));
            }
            config.insert("readOnly".into(), c.get("readOnly").cloned().unwrap_or(json!(false)));
            if let Some(ms) = c.get("statementTimeoutMs").filter(|v| model::js_truthy(v)) {
                config.insert("statementTimeoutMs".into(), ms.clone());
            }
            let ssh = c.get("ssh").filter(|s| s.is_object());
            config.insert(
                "ssh".into(),
                match (ssh, &key) {
                    (Some(s), Some(key)) => {
                        json!({ "dbHost": s["dbHost"], "dbPort": s["dbPort"], "tunnelKey": key, "owner": owner })
                    }
                    _ => Value::Null,
                },
            );
            if kind_of(&c) == "sqlite"
                && let Some(path) = c.get("path").filter(|p| model::js_truthy(p))
            {
                config.insert("path".into(), path.clone());
            }
            if !self.deps.host.send(ToHost::Open { id: id.clone(), config: Value::Object(config) }) {
                self.end(&mut l, &id, "error", Some("dbHostCrashed"), None);
                return;
            }
            ssh.is_some() && owner
        };
        // The next session's start may go on: this one's dbOpen is with the host.
        drop(turn);
        if login {
            self.login_tunnel(&id).await;
        }
    }

    /// The coordinator's SSH login of a tunnel owner (the first session of a connection, or one that took a closed owner's
    /// login over).
    async fn login_tunnel(&self, id: &str) {
        let Some(host_id) = self
            .inner
            .lock()
            .entry(id)
            .and_then(|e| e.connection.get("ssh").filter(|s| s.is_object()).map(|s| str_field(s, "hostId").to_string()))
        else {
            return;
        };
        let r = self.deps.coordinator.connect_session(id, &host_id).await;
        // The coordinator reports most failures as an 'error' state itself; one it refused up front is reported here.
        if let Err(error) = r {
            let mut l = self.lock();
            if l.inner.has(id) {
                self.fail_tunnel_login(&mut l, id, &error);
            }
        }
    }

    /// The SSH login of a tunnel failed: the sessions waiting on that tunnel end with the same error first (they would
    /// otherwise take the refused login over and ask again), then its owner.
    fn fail_tunnel_login(&self, l: &mut Locked<'_>, id: &str, error: &str) {
        let key = l.inner.entry(id).and_then(|e| e.tunnel_key.clone());
        let riders: Vec<String> = key.and_then(|k| l.inner.tunnels.get(&k).map(|t| t.refs.clone())).unwrap_or_default();
        for rider in riders {
            if rider == id {
                continue;
            }
            let connecting = l.inner.entry(&rider).is_some_and(|e| text(e.state.get("state")) == Some("connecting"));
            if !connecting {
                continue;
            }
            self.end(l, &rider, "error", Some(error), None);
            self.deps.host.send(ToHost::Close { id: rider.clone() });
        }
        self.end(l, id, "error", Some(error), None);
        self.deps.host.send(ToHost::Close { id: id.to_string() });
    }

    /// Ends a session: the last state goes out, prompts close, the coordinator forgets the tunnel.
    fn end(&self, l: &mut Locked<'_>, id: &str, phase: &str, error: Option<&str>, message: Option<&str>) {
        let Some(at) = l.inner.sessions.iter().position(|e| e.id == id) else { return };
        let mut entry = l.inner.sessions.remove(at);
        if let Some(t) = entry.idle.take() {
            self.deps.timers.cancel(t);
        }
        if let Some(key) = &entry.tunnel_key
            && let Some(t) = l.inner.tunnels.get_mut(key)
        {
            t.refs.retain(|r| r != id);
            if t.refs.is_empty() {
                l.inner.tunnels.remove(key);
            }
        }
        if let Some(own) = entry.own.take() {
            self.deps.timers.cancel(own.timer);
            self.deps.events.prompt(id, None);
        }
        entry.pending_save = None;
        let now = self.now();
        let s = &mut entry.state;
        s.insert("state".into(), json!(db_status_of(phase)));
        s.insert("phase".into(), json!(phase));
        s.insert("since".into(), json!(now));
        if let Some(e) = error.filter(|e| !e.is_empty()) {
            s.insert("error".into(), json!(e));
        }
        if let Some(m) = message.filter(|m| !m.is_empty()) {
            s.insert("message".into(), json!(m));
        }
        if phase == "closed" {
            s.shift_remove("error");
            s.shift_remove("message");
        }
        self.deps.events.session(&Value::Object(entry.state.clone()));
        if let Some(done) = entry.test.take() {
            if let Some(t) = entry.test_timer.take() {
                self.deps.timers.cancel(t);
            }
            let code = if entry.test_auth_failed && error == Some("cancelled") { "dbAuth" } else { error.unwrap_or("dbClosed") };
            let mut r = json!({ "ok": false, "error": code });
            if let Some(m) = message.filter(|m| !m.is_empty()) {
                r["message"] = json!(m);
            }
            let _ = done.send(r);
        }
        // Out of the coordinator's own loop (it may be iterating its sessions right now).
        let coordinator = self.deps.coordinator.clone();
        let sid = id.to_string();
        (self.deps.spawn)(Box::pin(async move { coordinator.end_session(&sid) }));
    }

    pub fn disconnect(&self, id: &str) -> Value {
        let mut l = self.lock();
        json!({ "ok": self.disconnect_in(&mut l, id) })
    }

    fn disconnect_in(&self, l: &mut Locked<'_>, id: &str) -> bool {
        if !l.inner.has(id) {
            return false;
        }
        self.end(l, id, "closed", None, None);
        self.deps.host.send(ToHost::Close { id: id.to_string() });
        true
    }

    /// A tunnel state from the coordinator (the app routes `db:` ids here): only its failures matter, the host reports the
    /// rest.
    pub fn on_coordinator_session(&self, s: &Value) {
        let id = str_field(s, "cellId");
        let mut l = self.lock();
        if !l.inner.has(id) || str_field(s, "phase") != "error" {
            return;
        }
        let error = text(s.get("error")).unwrap_or("tunnel").to_string();
        self.fail_tunnel_login(&mut l, id, &error);
    }

    /// A tunnel prompt from the coordinator.
    pub fn on_prompt(&self, session_id: &str, prompt: Option<&Value>) {
        if self.inner.lock().has(session_id) {
            self.deps.events.prompt(session_id, prompt);
        }
    }

    /// `onHostMessage`: what the sessions report (1.1.4 `DbHostToMain` without `dbResult`, which the host link answers).
    pub fn on_host_message(&self, m: Value) {
        let id = str_field(&m, "id").to_string();
        match str_field(&m, "t") {
            "sshStatus" | "sshHostKey" | "sshAuthPrompt" => {
                // Only for sessions this service started: the host can never move a cell's or an SFTP session's state.
                if is_db_session_id(&id) && self.inner.lock().has(&id) {
                    self.deps.coordinator.on_host_message(&m);
                }
            }
            "dbStatus" => self.on_status(&id, &m),
            "dbDatabase" => {
                let mut l = self.lock();
                let Some(e) = l.inner.entry(&id) else { return };
                if e.state.get("database") == m.get("database") {
                    return;
                }
                e.state.insert("database".into(), m.get("database").cloned().unwrap_or(Value::Null));
                let s = Value::Object(e.state.clone());
                self.deps.events.session(&s);
            }
            "dbPasswordPrompt" => {
                let retry = m.get("retry").and_then(Value::as_bool).unwrap_or(false);
                self.ask_password(&id, str_field(&m, "promptId"), retry);
            }
            "dbTunnelOwner" => {
                // The owner of this session's tunnel was closed during the login: this session logs the tunnel in now.
                {
                    let mut inner = self.inner.lock();
                    let Some(key) = inner
                        .entry(&id)
                        .filter(|e| e.connection.get("ssh").is_some_and(Value::is_object))
                        .and_then(|e| e.tunnel_key.clone())
                    else {
                        return;
                    };
                    if let Some(t) = inner.tunnels.get_mut(&key) {
                        t.owner = id.clone();
                    }
                }
                let me = self.me.clone();
                (self.deps.spawn)(Box::pin(async move {
                    if let Some(svc) = me.upgrade() {
                        svc.login_tunnel(&id).await;
                    }
                }));
            }
            "dbTx" => {
                let mut l = self.lock();
                let Some(e) = l.inner.entry(&id) else { return };
                if e.state.get("tx") == m.get("tx") {
                    return;
                }
                e.state.insert("tx".into(), m.get("tx").cloned().unwrap_or(Value::Null));
                let s = Value::Object(e.state.clone());
                self.deps.events.session(&s);
            }
            "dbActivity" => {
                let mut l = self.lock();
                let Some(e) = l.inner.entry(&id) else { return };
                e.busy = m.get("busy").and_then(Value::as_bool).unwrap_or(false);
                self.schedule_idle(&mut l, &id);
            }
            _ => {}
        }
    }

    fn on_status(&self, id: &str, m: &Value) {
        let mut l = self.lock();
        let phase = str_field(m, "phase").to_string();
        let Some(e) = l.inner.entry(id) else { return };
        if !is_live_db_phase(&phase) {
            let error = text(m.get("error")).or(if phase == "error" { Some("dbFailed") } else { None }).map(str::to_string);
            let message = text(m.get("message")).map(str::to_string);
            let end_phase = if phase == "closed" { "closed" } else { "error" };
            self.end(&mut l, id, end_phase, error.as_deref(), message.as_deref());
            return;
        }
        let was_connected = text(e.state.get("phase")) == Some("connected") || e.state.contains_key("reconnecting");
        let now = self.now();
        let sql = is_sql_kind(kind_of(&e.connection));
        let s = &mut e.state;
        s.insert("state".into(), json!(db_status_of(&phase)));
        s.insert("phase".into(), json!(phase));
        s.insert("since".into(), json!(now));
        for key in ["serverVersion", "database"] {
            if let Some(v) = m.get(key).filter(|v| model::js_truthy(v)) {
                s.insert(key.into(), v.clone());
            }
        }
        if let Some(tls) = m.get("tls") {
            s.insert("tls".into(), tls.clone());
        }
        if phase == "connected" && sql {
            s.insert("tx".into(), json!("idle"));
        }
        let reconnect = m.get("reconnect").filter(|v| model::js_truthy(v)).cloned();
        match reconnect {
            Some(r) => {
                s.insert("reconnecting".into(), r);
            }
            None => {
                s.shift_remove("reconnecting");
            }
        }
        let snapshot = Value::Object(s.clone());
        self.deps.events.session(&snapshot);
        // A Redis reconnect that worked is not a new login (no password to save, no test to answer).
        if phase == "connected" && !was_connected {
            self.connected(&mut l, id);
        } else if phase == "connected" {
            self.schedule_idle(&mut l, id);
        }
    }

    fn connected(&self, l: &mut Locked<'_>, id: &str) {
        let Some(e) = l.inner.entry(id) else { return };
        if let Some(value) = e.pending_save.take() {
            let cid = str_field(&e.connection, "id").to_string();
            // A failed write only loses the "remember" wish; the session itself is fine.
            if let Ok(SetPassword::Saved { .. }) = self.deps.vault.set_password(&cid, &value) {
                self.deps.events.vault_changed();
            }
        }
        let e = l.inner.entry(id).expect("still there");
        if let Some(done) = e.test.take() {
            if let Some(t) = e.test_timer.take() {
                self.deps.timers.cancel(t);
            }
            let mut r = json!({ "ok": true, "timeMs": self.now() - e.started });
            if let Some(v) = e.state.get("serverVersion").filter(|v| model::js_truthy(v)) {
                r["serverVersion"] = v.clone();
            }
            let _ = done.send(r);
            self.disconnect_in(l, id);
            return;
        }
        self.remember_flavor(l, id);
        self.schedule_idle(l, id);
    }

    /// MySQL: the flavour the server showed (MySQL or MariaDB) is kept on the connection for its icon and labels.
    fn remember_flavor(&self, l: &mut Locked<'_>, id: &str) {
        let Some(e) = l.inner.entry(id) else { return };
        if kind_of(&e.connection) != "mysql" {
            return;
        }
        let Some(version) = text(e.state.get("serverVersion")).filter(|v| !v.is_empty()) else { return };
        let flavor = mysql_flavor_of(version, "").as_str();
        let cid = str_field(&e.connection, "id").to_string();
        let state = self.deps.state.clone();
        // A state edit runs the change hooks: after the lock is released.
        l.after.push(Box::new(move || {
            if find_connection(&connections(&state.state()), &cid).and_then(|c| text(c.get("flavor"))) == Some(flavor) {
                return;
            }
            state.change(Box::new(move |s| {
                let list: Vec<Value> = connections(s)
                    .into_iter()
                    .map(|mut c| {
                        if str_field(&c, "id") == cid {
                            c["flavor"] = json!(flavor);
                        }
                        c
                    })
                    .collect();
                let mut next = s.as_object().cloned().unwrap_or_default();
                next.insert("dbConnections".into(), Value::Array(list));
                Value::Object(next)
            }));
        }));
    }

    fn ask_password(&self, id: &str, host_prompt_id: &str, retry: bool) {
        let mut l = self.lock();
        let vault_read_only = self.deps.vault.read_only();
        let Some(e) = l.inner.entry(id) else {
            self.deps.host.send(ToHost::PasswordAnswer { id: id.into(), prompt_id: host_prompt_id.into(), value: None });
            return;
        };
        let is_test = e.state.contains_key("test");
        // "Testuj połączenie" checks the form's password: a refused one is the answer, the user fixes it in the form.
        if is_test && retry {
            e.test_auth_failed = true;
            self.deps.host.send(ToHost::PasswordAnswer { id: id.into(), prompt_id: host_prompt_id.into(), value: None });
            return;
        }
        if let Some(own) = e.own.take() {
            self.deps.timers.cancel(own.timer);
        }
        let c = &e.connection;
        let prompt_id = (self.deps.new_uuid)();
        // A test of an unsaved form never saves; the form saves its own password field.
        let prompt = json!({
            "id": prompt_id, "kind": "dbPassword", "connectionName": c.get("name").cloned().unwrap_or(json!("")),
            "user": c.get("user").cloned().unwrap_or(json!("")), "endpoint": db_endpoint(c),
            "canSave": !is_test && !vault_read_only, "retry": retry,
        });
        let me = self.me.clone();
        let (sid, pid) = (id.to_string(), prompt_id.clone());
        let timer = self.deps.timers.after(
            self.deps.prompt_timeout_ms,
            Box::new(move || {
                if let Some(svc) = me.upgrade() {
                    svc.answer(&json!({ "sessionId": sid, "promptId": pid, "cancel": true }));
                }
            }),
        );
        e.own = Some(OwnPrompt { prompt: prompt.clone(), host_prompt_id: host_prompt_id.to_string(), timer });
        self.deps.events.prompt(id, Some(&prompt));
    }

    /// `answer(a)`: the database password prompt here, every other prompt id to the coordinator (a tunnel question).
    pub fn answer(&self, a: &Value) -> bool {
        let sid = str_field(a, "sessionId").to_string();
        {
            let mut l = self.lock();
            let Some(e) = l.inner.entry(&sid) else { return false };
            let mine = e.own.as_ref().is_some_and(|own| own.prompt.get("id") == a.get("promptId"));
            if mine {
                if a.get("hostKey").is_some() {
                    return false;
                }
                let values = a.get("values").and_then(Value::as_array);
                if values.is_some_and(|v| v.len() != 1) {
                    return false;
                }
                let own = e.own.take().expect("checked");
                self.deps.timers.cancel(own.timer);
                let value = values.and_then(|v| v[0].as_str()).map(|s| Zeroizing::new(s.to_string()));
                let can_save = own.prompt.get("canSave") == Some(&Value::Bool(true));
                // Only the latest answer decides: a retry answered without "remember" drops an earlier (wrong) password.
                e.pending_save =
                    value.clone().filter(|_| model::js_truthy(a.get("remember").unwrap_or(&Value::Null)) && can_save);
                self.deps.events.prompt(&sid, None);
                self.deps.host.send(ToHost::PasswordAnswer { id: sid.clone(), prompt_id: own.host_prompt_id, value });
                return true;
            }
        }
        let mut rest = Map::new();
        rest.insert("cellId".into(), json!(sid));
        for (k, v) in a.as_object().into_iter().flatten() {
            if k != "sessionId" {
                rest.insert(k.clone(), v.clone());
            }
        }
        self.deps.coordinator.answer(Value::Object(rest))
    }

    /// `snapshot()`: `{sessions, prompts}`.
    pub fn snapshot(&self) -> Value {
        let tunnel = self.deps.coordinator.prompts();
        let inner = self.inner.lock();
        let mut prompts: Vec<Value> = tunnel
            .into_iter()
            .filter(|(cell, _)| inner.has(cell))
            .map(|(cell, prompt)| json!({ "sessionId": cell, "prompt": prompt }))
            .collect();
        for e in &inner.sessions {
            if let Some(own) = &e.own {
                prompts.push(json!({ "sessionId": e.id, "prompt": own.prompt }));
            }
        }
        let sessions: Vec<Value> = inner.sessions.iter().map(|e| Value::Object(e.state.clone())).collect();
        json!({ "sessions": sessions, "prompts": prompts })
    }

    /// An operation of a session. `window`: the window that asked; its results arrive on that window's port.
    pub fn op(&self, session_id: &str, op: Value, window: Option<String>) -> BoxFuture<'static, Value> {
        {
            let mut l = self.lock();
            let Some(e) = l.inner.entry(session_id) else {
                return Box::pin(async { json!({ "ok": false, "error": "noSession" }) });
            };
            if text(e.state.get("phase")) != Some("connected") {
                return Box::pin(async { json!({ "ok": false, "error": "notConnected" }) });
            }
            // Every operation counts as use: the idle timer starts again.
            self.schedule_idle(&mut l, session_id);
        }
        self.deps.host.request(session_id, op, window)
    }

    /// The sessions crashed (a panicking session task, D12): every session ends and the coordinator hears it.
    pub fn host_crashed(&self) {
        self.deps.coordinator.session_host_crashed();
        let mut l = self.lock();
        let ids: Vec<String> = l.inner.sessions.iter().map(|e| e.id.clone()).collect();
        for id in ids {
            self.end(&mut l, &id, "error", Some("dbHostCrashed"), None);
        }
        self.deps.events.host_crashed();
    }

    /// The sessions open tabs of a window use (each window sends its whole list): never disconnected for being idle.
    pub fn pin(&self, session_ids: &[String], window: &str) {
        let mut l = self.lock();
        let ids: HashSet<String> = session_ids.iter().filter(|id| is_db_session_id(id)).take(1000).cloned().collect();
        if ids.is_empty() {
            l.inner.pins_by.remove(window);
        } else {
            l.inner.pins_by.insert(window.to_string(), ids);
        }
        let pinned: HashSet<String> = l.inner.pins_by.values().flatten().cloned().collect();
        l.inner.pinned = pinned;
        let all: Vec<String> = l.inner.sessions.iter().map(|e| e.id.clone()).collect();
        for id in all {
            self.schedule_idle(&mut l, &id);
        }
    }

    /// A window reloads, crashed or closed: its page (if any) pins its tabs again.
    pub fn renderer_gone(&self, window: &str) {
        self.pin(&[], window);
    }

    fn kept(inner: &Inner, e: &Entry) -> bool {
        text(e.state.get("phase")) != Some("connected") || e.busy || inner.pinned.contains(&e.id)
    }

    fn schedule_idle(&self, l: &mut Locked<'_>, id: &str) {
        let Some(at) = l.inner.sessions.iter().position(|e| e.id == id) else { return };
        if let Some(t) = l.inner.sessions[at].idle.take() {
            self.deps.timers.cancel(t);
        }
        if Self::kept(&l.inner, &l.inner.sessions[at]) {
            return;
        }
        let me = self.me.clone();
        let sid = id.to_string();
        let timer = self.deps.timers.after_with_id(
            self.deps.idle_ms,
            Box::new(move |own_id| {
                let Some(svc) = me.upgrade() else { return };
                let mut l = svc.lock();
                // A newer schedule_idle may have replaced this timer while it waited for the lock (cancel cannot stop a
                // callback that already started): only the session's current idle timer disconnects it.
                let idle = l
                    .inner
                    .sessions
                    .iter()
                    .find(|e| e.id == sid)
                    .is_some_and(|e| e.idle == Some(own_id) && !Self::kept(&l.inner, e));
                if idle {
                    svc.disconnect_in(&mut l, &sid);
                }
            }),
        );
        l.inner.sessions[at].idle = Some(timer);
    }

    pub fn ids(&self) -> Vec<String> {
        self.inner.lock().sessions.iter().map(|e| e.id.clone()).collect()
    }

    /// The owner of a connection's tunnel (tests).
    pub fn tunnel_owner(&self, key: &str) -> Option<String> {
        self.inner.lock().tunnels.get(key).map(|t| t.owner.clone())
    }
}
