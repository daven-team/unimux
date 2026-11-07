//! The fakes of test/db-main.test.ts: a DB Host link that records what it gets, a coordinator, the state, the events, hand
//! driven timers and the fake cipher of test/helpers/sshKeys.ts.
#![allow(dead_code)]

use std::path::Path;
use std::sync::Arc;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use unimux_db::host::{DbHostLink, ToHost};
use unimux_db::service::{DbCoordinator, DbDeps, DbEvents, DbService, DbStateAccess, PasswordChange};
use unimux_db::timers::ManualTimers;
use unimux_db::vault::DbVault;
use unimux_oscrypt::{BlobError, Error, SafeCipher, Storage};
use zeroize::Zeroizing;

pub const HOST: &str = "00000000-0000-4000-8000-0000000000aa";

pub struct FakeCipher {
    pub available: bool,
    pub broken: bool,
}

impl SafeCipher for FakeCipher {
    fn storage(&self) -> Storage {
        if self.available { Storage::Dpapi } else { Storage::Unavailable }
    }
    fn available(&self) -> bool {
        self.available
    }
    fn encrypt(&self, text: &str) -> Result<Vec<u8>, Error> {
        let hex: String = text.bytes().map(|b| format!("{b:02x}")).collect();
        Ok(format!("enc:{hex}").into_bytes())
    }
    fn decrypt(&self, blob: &[u8]) -> Result<Zeroizing<String>, Error> {
        let s = String::from_utf8_lossy(blob);
        let Some(hex) = s.strip_prefix("enc:").filter(|_| !self.broken) else { return Err(Error::Blob(BlobError::BadKey)) };
        let bytes: Vec<u8> = (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap()).collect();
        Ok(Zeroizing::new(String::from_utf8_lossy(&bytes).into_owned()))
    }
}

pub struct FakeState {
    pub state: Mutex<Arc<Value>>,
    pub ssh_hosts: Vec<String>,
}

impl DbStateAccess for FakeState {
    fn state(&self) -> Arc<Value> {
        self.state.lock().clone()
    }
    fn change(&self, f: Box<dyn FnOnce(&Value) -> Value + Send>) {
        let mut s = self.state.lock();
        let next = f(&s);
        *s = Arc::new(next);
    }
    fn ssh_host_exists(&self, host_id: &str) -> bool {
        self.ssh_hosts.iter().any(|h| h == host_id)
    }
}

#[derive(Default)]
pub struct FakeHost {
    pub down: bool,
    pub sent: Mutex<Vec<Value>>,
    pub requests: Mutex<Vec<(String, Value)>>,
}

impl DbHostLink for FakeHost {
    fn ensure(&self) -> bool {
        !self.down
    }
    fn send(&self, m: ToHost) -> bool {
        self.sent.lock().push(m.to_json());
        !self.down
    }
    fn request(&self, id: &str, op: Value, _window: Option<String>) -> BoxFuture<'static, Value> {
        self.requests.lock().push((id.to_string(), op));
        Box::pin(async { json!({ "ok": true, "value": "answer" }) })
    }
}

#[derive(Default)]
pub struct FakeCoordinator {
    pub calls: Mutex<Vec<String>>,
    pub answers: Mutex<Vec<Value>>,
    pub refuse: Mutex<Option<String>>,
}

impl DbCoordinator for FakeCoordinator {
    fn connect_session(&self, session_id: &str, host_id: &str) -> BoxFuture<'static, Result<(), String>> {
        self.calls.lock().push(format!("connect {session_id} {host_id}"));
        let r = self.refuse.lock().clone();
        Box::pin(async move { r.map_or(Ok(()), Err) })
    }
    fn end_session(&self, session_id: &str) {
        self.calls.lock().push(format!("end {session_id}"));
    }
    fn answer(&self, answer: Value) -> bool {
        self.answers.lock().push(answer);
        true
    }
    fn prompts(&self) -> Vec<(String, Value)> {
        Vec::new()
    }
    fn on_host_message(&self, _m: &Value) {}
    fn session_host_crashed(&self) {
        self.calls.lock().push("crashed db".to_string());
    }
}

#[derive(Default)]
pub struct Events {
    pub sessions: Mutex<Vec<Value>>,
    pub prompts: Mutex<Vec<(String, Option<Value>)>>,
    pub crashes: Mutex<usize>,
    pub vault_changes: Mutex<usize>,
}

impl DbEvents for Events {
    fn session(&self, state: &Value) {
        self.sessions.lock().push(state.clone());
    }
    fn prompt(&self, session_id: &str, prompt: Option<&Value>) {
        self.prompts.lock().push((session_id.to_string(), prompt.cloned()));
    }
    fn host_crashed(&self) {
        *self.crashes.lock() += 1;
    }
    fn vault_changed(&self) {
        *self.vault_changes.lock() += 1;
    }
}

pub struct Setup {
    pub service: Arc<DbService>,
    pub vault: Arc<DbVault>,
    pub host: Arc<FakeHost>,
    pub coordinator: Arc<FakeCoordinator>,
    pub events: Arc<Events>,
    pub timers: Arc<ManualTimers>,
    pub state: Arc<FakeState>,
}

pub struct Options {
    pub host_up: bool,
    pub ssh_hosts: Vec<String>,
    pub ca: Option<String>,
    pub cipher: FakeCipher,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            host_up: true,
            ssh_hosts: vec![HOST.to_string()],
            ca: Some("CA PEM".to_string()),
            cipher: FakeCipher { available: true, broken: false },
        }
    }
}

pub fn input() -> Value {
    json!({ "kind": "postgres", "name": "prod", "host": "db.example.com", "port": 5432, "user": "app", "database": "shop",
        "tls": "disable", "ssh": null, "readOnly": false })
}

pub fn with(base: Value, extra: Value) -> Value {
    let mut m = base.as_object().cloned().unwrap();
    for (k, v) in extra.as_object().cloned().unwrap() {
        m.insert(k, v);
    }
    Value::Object(m)
}

pub fn setup(dir: &Path, opts: Options) -> Setup {
    let vault = Arc::new(DbVault::new(dir.join("db").join("vault.json"), Arc::new(opts.cipher)));
    let host = Arc::new(FakeHost { down: !opts.host_up, ..Default::default() });
    let coordinator = Arc::new(FakeCoordinator::default());
    let events = Arc::new(Events::default());
    let timers = Arc::new(ManualTimers::default());
    let state = Arc::new(FakeState { state: Mutex::new(Arc::new(json!({ "dbConnections": [] }))), ssh_hosts: opts.ssh_hosts });
    let ca = opts.ca;
    let service = DbService::new(DbDeps {
        state: state.clone(),
        host: host.clone(),
        coordinator: coordinator.clone(),
        vault: vault.clone(),
        read_ca: Arc::new(move |_path| {
            let ca = ca.clone();
            Box::pin(async move { ca })
        }),
        events: events.clone(),
        timers: timers.clone(),
        spawn: Arc::new(|f| {
            tokio::spawn(f);
        }),
        now: Arc::new(|| 1000),
        new_uuid: Arc::new(|| uuid::Uuid::new_v4().to_string()),
        idle_ms: 5 * 60_000,
        prompt_timeout_ms: 5 * 60_000,
        test_timeout_ms: 7 * 60_000,
    });
    Setup { service, vault, host, coordinator, events, timers, state }
}

impl Setup {
    pub fn save(&self, extra: Value, password: PasswordChange) -> Value {
        let r = self.service.save_connection(&with(input(), extra), &password);
        assert_eq!(r["ok"], true, "{r}");
        r["connection"].clone()
    }
    pub fn last(&self, id: &str) -> Value {
        self.events.sessions.lock().iter().rev().find(|s| s["id"] == id).cloned().unwrap_or(Value::Null)
    }
    pub fn sent(&self) -> Vec<Value> {
        self.host.sent.lock().clone()
    }
    pub fn opens(&self) -> Vec<Value> {
        self.sent().into_iter().filter(|m| m["t"] == "dbOpen").collect()
    }
    pub fn calls(&self) -> Vec<String> {
        self.coordinator.calls.lock().clone()
    }
    pub fn current(&self) -> Arc<Value> {
        self.state.state()
    }
    pub fn connections(&self) -> Vec<Value> {
        self.state.state()["dbConnections"].as_array().cloned().unwrap_or_default()
    }
}

/// Lets the spawned starts, tunnel logins and coordinator calls run (the TS tests' `flush`).
pub async fn flush() {
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
}

pub fn set(p: &str) -> PasswordChange {
    PasswordChange::Set(Zeroizing::new(p.to_string()))
}
