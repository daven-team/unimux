//! "DbService behind the SSH coordinator (main chain)" of test/db-tunnel.int.test.ts: the DB service, the real SSH
//! coordinator (known hosts and SSH vault in a temporary folder), the DB vault, the tunnels and the Redis sessions, wired
//! like unimux-app's commands/db.rs (the coordinator's `db` owner is the tunnel host; the hosts report to the service in
//! order, off the caller's stack). The SSH server is unimux-ssh's in-process one, the database the RESP server of the TS
//! suites (Node, tests/resp). Skipped without Node.

mod common;
mod resp;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use common::{Events, FakeCipher, FakeState};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use resp::Resp;
use serde_json::{Value, json};
use unimux_db::host::{DbHostLink, HostReport, Spawn, UnavailableHost};
use unimux_db::redis::host::{DbTunnels, RedisHost, RedisHostDeps};
use unimux_db::redis::session::RedisLimits;
use unimux_db::service::{DbCoordinator, DbDeps, DbService, PasswordChange, TestPassword};
use unimux_db::timers::ManualTimers;
use unimux_db::tunnel::{DbTunnelHost, TUNNEL_TIMERS};
use unimux_db::vault::{DbVault, Password};
use unimux_oscrypt::Cipher;
use unimux_ssh::coordinator::{CoordinatorDeps, CoordinatorEvents, CoordinatorState, SshCoordinator, SshHostLink};
use unimux_ssh::keys::check_passphrase;
use unimux_ssh::protocol::{HostMessage, PromptAnswer};
use unimux_ssh::session::{SessionHostKind, SessionState};
use unimux_ssh::stores::SshStores;
use unimux_ssh::test_server::{TestServer, TestServerConfig, TestUser};
use zeroize::Zeroizing;

const HOST_ID: &str = "00000000-0000-4000-8000-0000000000bb";

/// The coordinator's view of the shared state.
struct CoordState(Arc<FakeState>);
impl CoordinatorState for CoordState {
    fn state(&self) -> Arc<Value> {
        unimux_db::service::DbStateAccess::state(&*self.0)
    }
}

/// unimux-app's `DbTunnels` adapter: the DB service's view of the SSH coordinator.
struct Coordinator(Arc<SshCoordinator>);
impl DbCoordinator for Coordinator {
    fn connect_session(&self, session_id: &str, host_id: &str) -> BoxFuture<'static, Result<(), String>> {
        let (c, id, host) = (self.0.clone(), session_id.to_string(), host_id.to_string());
        Box::pin(async move { c.connect_session(&id, &host, false).await.map_err(|e| e.as_str().to_string()) })
    }
    fn end_session(&self, session_id: &str) {
        self.0.end_session(session_id);
    }
    fn answer(&self, answer: Value) -> bool {
        PromptAnswer::from_json(&answer).is_some_and(|a| self.0.answer(a))
    }
    fn prompts(&self) -> Vec<(String, Value)> {
        self.0.session_prompts(SessionHostKind::Db)
    }
    fn on_host_message(&self, m: &Value) {
        if let Some(m) = HostMessage::from_json(m) {
            self.0.on_host_message(m);
        }
    }
    fn session_host_crashed(&self) {
        self.0.session_host_crashed(SessionHostKind::Db);
    }
}

/// unimux-app's `DbSink`: the coordinator's `db:` events to the service.
struct Sink(Arc<Mutex<std::sync::Weak<DbService>>>);
impl CoordinatorEvents for Sink {
    fn session(&self, state: &SessionState) {
        if let Some(s) = self.0.lock().upgrade() {
            s.on_coordinator_session(&state.to_json());
        }
    }
    fn prompt(&self, cell_id: &str, prompt: Option<&Value>) {
        if let Some(s) = self.0.lock().upgrade() {
            s.on_prompt(cell_id, prompt);
        }
    }
    fn vault_changed(&self) {}
}

struct Chain {
    service: Arc<DbService>,
    coordinator: Arc<SshCoordinator>,
    stores: Arc<SshStores>,
    vault: Arc<DbVault>,
    tunnels: Arc<DbTunnelHost>,
    events: Arc<Events>,
    _dir: tempfile::TempDir,
}

async fn chain(s: &TestServer, connection: Value) -> (Chain, String) {
    let dir = tempfile::tempdir().unwrap();
    let spawn: Spawn = Arc::new(|f| {
        tokio::spawn(f);
    });
    let state = Arc::new(FakeState {
        state: Mutex::new(Arc::new(json!({
            "dbConnections": [],
            "sshHosts": [{ "id": HOST_ID, "label": "vps", "address": "127.0.0.1", "port": s.port(), "username": "alice", "createdAt": 0, "updatedAt": 0 }],
        }))),
        ssh_hosts: vec![HOST_ID.to_string()],
    });
    let stores = SshStores::new(dir.path(), Arc::new(Cipher::with_gcm_key([7u8; 32])), Arc::new(|_: &str| true));
    stores.init().await;
    let tunnels = DbTunnelHost::new(spawn.clone(), TUNNEL_TIMERS);
    let slot: Arc<Mutex<std::sync::Weak<DbService>>> = Arc::default();
    let ids = Arc::new(AtomicUsize::new(0));
    let coordinator = SshCoordinator::new(CoordinatorDeps {
        state: Arc::new(CoordState(state.clone())),
        stores: stores.clone(),
        host: tunnels.clone() as Arc<dyn SshHostLink>,
        events: Arc::new(Sink(slot.clone())),
        spawn: spawn.clone(),
        now: Arc::new(unimux_core::time::now_ms),
        new_id: Arc::new(move || format!("00000000-0000-4000-8000-{:012x}", ids.fetch_add(1, Ordering::SeqCst) + 0x100)),
        debug: false,
        prompt_timeout: Duration::from_secs(300),
        check_passphrase: Arc::new(check_passphrase),
    });
    let redis = RedisHost::new(RedisHostDeps {
        next: UnavailableHost::new(spawn.clone()),
        spawn: spawn.clone(),
        tunnels: Some(tunnels.clone() as Arc<dyn DbTunnels>),
        connect_ms: 5000,
        limits: RedisLimits::default(),
        now: Arc::new(unimux_core::time::now_ms),
    });
    let vault =
        Arc::new(DbVault::new(dir.path().join("db").join("vault.json"), Arc::new(FakeCipher { available: true, broken: false })));
    let events = Arc::new(Events::default());
    let service = DbService::new(DbDeps {
        state,
        host: redis.clone() as Arc<dyn DbHostLink>,
        coordinator: Arc::new(Coordinator(coordinator.clone())),
        vault: vault.clone(),
        read_ca: Arc::new(|_| Box::pin(async { None })),
        events: events.clone(),
        timers: Arc::new(ManualTimers::default()),
        spawn: spawn.clone(),
        now: Arc::new(unimux_core::time::now_ms),
        new_uuid: Arc::new(|| uuid::Uuid::new_v4().to_string()),
        idle_ms: 5 * 60_000,
        prompt_timeout_ms: 5 * 60_000,
        test_timeout_ms: 7 * 60_000,
    });
    *slot.lock() = Arc::downgrade(&service);
    // The hosts report in order and off the caller's stack (unimux-app's `queued_report`).
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    let weak = Arc::downgrade(&service);
    tokio::spawn(async move {
        while let Some(m) = rx.recv().await {
            if let Some(s) = weak.upgrade() {
                s.on_host_message(m);
            }
        }
    });
    let report: HostReport = Arc::new(move |m: Value| {
        let _ = tx.send(m);
    });
    redis.connect(report.clone());
    tunnels.connect(report);
    let saved = service.save_connection(&connection, &PasswordChange::Keep);
    assert_eq!(saved["ok"], true, "{saved}");
    let id = saved["connection"]["id"].as_str().unwrap().to_string();
    (Chain { service, coordinator, stores, vault, tunnels, events, _dir: dir }, id)
}

fn redis_via_ssh(db_port: u16) -> Value {
    json!({ "kind": "redis", "name": "prod", "host": "localhost", "port": 6379, "user": "", "dbIndex": 0, "tls": "disable",
        "ssh": { "hostId": HOST_ID, "dbHost": "127.0.0.1", "dbPort": db_port }, "readOnly": false })
}

async fn ssh() -> TestServer {
    TestServer::start(TestServerConfig {
        users: vec![TestUser::new("alice").password("pw")],
        forwarding: true,
        ..TestServerConfig::default()
    })
    .await
    .unwrap()
}

async fn wait_for(what: impl Fn() -> bool, ms: u64) {
    let start = Instant::now();
    while !what() {
        assert!(start.elapsed() < Duration::from_millis(ms), "timed out");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

impl Chain {
    /// Waits, and names the last states and prompts when it times out.
    async fn wait(&self, what: impl Fn() -> bool, ms: u64) {
        let start = Instant::now();
        while !what() {
            if start.elapsed() > Duration::from_millis(ms) {
                panic!("timed out: {:?}\n{:?}", self.events.sessions.lock(), self.events.prompts.lock());
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }
}

impl Chain {
    fn open(&self, id: &str) -> Value {
        self.events.prompts.lock().iter().rev().find(|(s, _)| s == id).and_then(|(_, p)| p.clone()).unwrap_or(Value::Null)
    }
    fn kind(&self, id: &str) -> String {
        self.open(id)["kind"].as_str().unwrap_or_default().to_string()
    }
    fn last(&self, id: &str) -> Value {
        self.events.sessions.lock().iter().rev().find(|s| s["id"] == id).cloned().unwrap_or(Value::Null)
    }
    fn state(&self, id: &str) -> String {
        self.last(id)["state"].as_str().unwrap_or_default().to_string()
    }
    fn answer(&self, id: &str, extra: Value) -> bool {
        let mut a = json!({ "sessionId": id, "promptId": self.open(id)["id"] });
        for (k, v) in extra.as_object().unwrap() {
            a[k] = v.clone();
        }
        self.service.answer(&a)
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn asks_for_the_host_key_the_ssh_password_and_the_database_password_connects_and_saves_it() {
    let Some(db) = Resp::start(json!({ "password": "dbpw" })) else { return };
    let s = ssh().await;
    let (c, conn) = chain(&s, redis_via_ssh(db.port)).await;
    let id = c.service.connect(&conn, None).unwrap();
    wait_for(|| c.kind(&id) == "hostKey", 15_000).await;
    let kinds: Vec<Value> =
        c.service.snapshot()["prompts"].as_array().unwrap().iter().map(|p| p["prompt"]["kind"].clone()).collect();
    assert_eq!(kinds, [json!("hostKey")]);
    assert!(c.answer(&id, json!({ "hostKey": "save" })));
    wait_for(|| c.kind(&id) == "password", 15_000).await;
    assert!(c.answer(&id, json!({ "values": ["pw"] })));
    wait_for(|| c.kind(&id) == "dbPassword", 15_000).await;
    let p = c.open(&id);
    assert_eq!(
        (p["connectionName"].clone(), p["canSave"].clone(), p["retry"].clone()),
        (json!("prod"), json!(true), json!(false))
    );
    assert_eq!(p["endpoint"], format!("127.0.0.1:{}/0", db.port));
    assert!(c.answer(&id, json!({ "values": ["dbpw"], "remember": true })));
    wait_for(|| c.state(&id) == "connected", 15_000).await;
    let last = c.last(&id);
    assert_eq!((last["connectionId"].as_str(), last["kind"].as_str()), (Some(conn.as_str()), Some("redis")));
    assert_eq!(last["serverVersion"], "7.2.4");
    wait_for(|| matches!(c.vault.password(&conn), Password::Ok(_)), 5000).await;
    assert!(matches!(c.vault.password(&conn), Password::Ok(p) if p.as_str() == "dbpw"));
    assert_eq!(c.stores.known_hosts().await.lock().list().len(), 1);
    assert_eq!(c.service.snapshot()["prompts"], json!([]));
    let cancel = c.service.op(&id, json!({ "op": "redis", "req": { "kind": "cancel" } }), None).await;
    assert_eq!(cancel, json!({ "ok": true, "value": false }));
    // The DB Host restarting ends the session (and the coordinator's tunnel login with it).
    c.service.host_crashed();
    assert_eq!((c.state(&id), c.last(&id)["error"].clone()), ("error".to_string(), json!("dbHostCrashed")));
    let snapshot = c.coordinator.session_snapshot(SessionHostKind::Db);
    assert!(snapshot["sessions"].as_array().unwrap().iter().all(|x| x["phase"] != "connected"));
    c.tunnels.shutdown();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_owner_disconnected_at_its_host_key_question_hands_the_login_to_the_other_session() {
    let Some(db) = Resp::start(json!({})) else { return };
    let s = ssh().await;
    let (c, conn) = chain(&s, redis_via_ssh(db.port)).await;
    let a = c.service.connect(&conn, None).unwrap();
    let b = c.service.connect(&conn, None).unwrap();
    wait_for(|| c.kind(&a) == "hostKey", 15_000).await;
    c.service.disconnect(&a);
    assert_eq!(c.state(&a), "closed");
    // The question moves to the other session (its own login through the coordinator).
    wait_for(|| c.kind(&b) == "hostKey", 15_000).await;
    c.answer(&b, json!({ "hostKey": "save" }));
    wait_for(|| c.kind(&b) == "password", 15_000).await;
    c.answer(&b, json!({ "values": ["pw"] }));
    wait_for(|| ["connected", "error"].contains(&c.state(&b).as_str()), 15_000).await;
    assert_eq!(c.state(&b), "connected", "{}", c.last(&b));
    assert!(!c.events.sessions.lock().iter().any(|x| x["error"] == "cancelled"));
    c.service.disconnect(&b);
    wait_for(|| s.connections() == 0, 15_000).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_host_key_ends_every_session_waiting_on_that_tunnel_with_the_same_error() {
    let Some(db) = Resp::start(json!({})) else { return };
    let s = ssh().await;
    let (c, conn) = chain(&s, redis_via_ssh(db.port)).await;
    let a = c.service.connect(&conn, None).unwrap();
    let b = c.service.connect(&conn, None).unwrap();
    c.wait(|| c.kind(&a) == "hostKey", 15_000).await;
    c.answer(&a, json!({ "cancel": true }));
    c.wait(|| c.state(&a) == "error" && c.state(&b) == "error", 15_000).await;
    assert_eq!(c.last(&a)["error"], "hostKeyRejected");
    assert_eq!(c.last(&b)["error"], "hostKeyRejected");
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(!c.events.prompts.lock().iter().any(|(id, p)| *id == b && p.is_some()), "no second question");
    assert_eq!(c.service.snapshot()["sessions"], json!([]));
    assert_eq!(c.tunnels.tunnel_count(), 0);

    // 'an unknown SSH host key that the user refuses ends the session with the coordinator error'
    let one = c.service.connect(&conn, None).unwrap();
    c.wait(|| c.kind(&one) == "hostKey", 15_000).await;
    c.answer(&one, json!({ "cancel": true }));
    c.wait(|| c.state(&one) == "error", 15_000).await;
    assert_eq!(c.last(&one)["error"], "hostKeyRejected");
    assert_eq!(c.service.snapshot()["sessions"], json!([]));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn tests_a_connection_and_a_wrong_password_reads_db_auth() {
    let Some(db) = Resp::start(json!({ "password": "dbpw" })) else { return };
    let s = ssh().await;
    let direct = json!({ "kind": "redis", "name": "x", "host": "127.0.0.1", "port": db.port, "user": "", "dbIndex": 0, "tls": "disable", "ssh": null, "readOnly": false });
    let (c, _) = chain(&s, direct).await;
    let input = json!({ "kind": "redis", "name": "form", "host": "127.0.0.1", "port": db.port, "user": "", "dbIndex": 0, "tls": "disable", "ssh": null, "readOnly": false });
    let ok = c.service.test_connection(&input, &TestPassword::Set(Zeroizing::new("dbpw".into()))).await;
    assert_eq!((ok["ok"].clone(), ok["serverVersion"].clone()), (json!(true), json!("7.2.4")), "{ok}");
    wait_for(|| c.service.ids().is_empty(), 10_000).await;
    // The form's password was refused: the test says so instead of asking for another one.
    let bad = c.service.test_connection(&input, &TestPassword::Set(Zeroizing::new("nope".into()))).await;
    assert_eq!((bad["ok"].clone(), bad["error"].clone()), (json!(false), json!("dbAuth")), "{bad}");
    assert!(!c.events.prompts.lock().iter().any(|(_, p)| p.as_ref().is_some_and(|p| p["kind"] == "dbPassword")));
    assert!(c.vault.info().saved.is_empty());
}
