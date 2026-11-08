//! The "DbHost: SSH tunnel" cases of test/db-tunnel.int.test.ts against a real SSH login: the DB sessions log in to the
//! in-process SSH server of unimux-ssh (host key and password questions answered like main does), forward their
//! connections with direct-tcpip and talk to the database through them. The database end is the RESP server of the TS
//! suites (Node, tests/resp); the tunnel itself does not depend on the kind of database. Skipped without Node.

mod resp;

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use resp::Resp;
use serde_json::{Value, json};
use unimux_db::host::{DbHostLink, HostReport, Spawn, ToHost, UnavailableHost};
use unimux_db::redis::host::{DbTunnels, RedisHost, RedisHostDeps};
use unimux_db::redis::session::RedisLimits;
use unimux_db::tunnel::{DbTunnelHost, TUNNEL_TIMERS, TunnelTimers};
use unimux_ssh::coordinator::SshHostLink;
use unimux_ssh::protocol::{ConnectRequest, HostCommand};
use unimux_ssh::test_server::{Forward, TestServer, TestServerConfig, TestUser};
use zeroize::Zeroizing;

async fn ssh(forwarding: bool) -> TestServer {
    TestServer::start(TestServerConfig {
        users: vec![TestUser::new("alice").password("pw")],
        forwarding,
        ..TestServerConfig::default()
    })
    .await
    .unwrap()
}

/// What the stand-in for main answers.
#[derive(Default)]
struct Policy {
    /// The SSH password typed at the question; None cancels it.
    password: Option<String>,
    /// Close this session (instead of answering) at its next password question.
    close_at: Option<String>,
}

struct H {
    tunnels: Arc<DbTunnelHost>,
    redis: Arc<RedisHost>,
    main: Arc<Mutex<Vec<Value>>>,
    asked: Arc<Mutex<Vec<String>>>,
    owners: Arc<Mutex<Vec<String>>>,
    policy: Arc<Mutex<Policy>>,
}

fn harness(policy: Policy, ssh_wait: Duration) -> H {
    let spawn: Spawn = Arc::new(|f| {
        tokio::spawn(f);
    });
    let tunnels = DbTunnelHost::new(spawn.clone(), TunnelTimers { ssh_wait, ..TUNNEL_TIMERS });
    let redis = RedisHost::new(RedisHostDeps {
        next: UnavailableHost::new(spawn.clone()),
        spawn,
        tunnels: Some(tunnels.clone() as Arc<dyn DbTunnels>),
        connect_ms: 5000,
        limits: RedisLimits::default(),
        now: Arc::new(unimux_core::time::now_ms),
    });
    let main: Arc<Mutex<Vec<Value>>> = Arc::default();
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let owners: Arc<Mutex<Vec<String>>> = Arc::default();
    let policy = Arc::new(Mutex::new(policy));
    let (m, a, o, p) = (main.clone(), asked.clone(), owners.clone(), policy.clone());
    let (t, r) = (Arc::downgrade(&tunnels), Arc::downgrade(&redis));
    let report: HostReport = Arc::new(move |msg: Value| {
        m.lock().push(msg.clone());
        let id = msg["id"].as_str().unwrap_or_default().to_string();
        let prompt_id = msg["promptId"].as_str().unwrap_or_default().to_string();
        match msg["t"].as_str() {
            Some("dbTunnelOwner") => o.lock().push(id),
            Some("sshHostKey") => {
                a.lock().push("hostKey".into());
                let t = t.clone();
                tokio::spawn(async move {
                    if let Some(t) = t.upgrade() {
                        t.send(HostCommand::HostKeyAnswer { id, prompt_id, accept: true, error: None });
                    }
                });
            }
            Some("sshAuthPrompt") => {
                let mut policy = p.lock();
                if policy.close_at.as_deref() == Some(id.as_str()) {
                    policy.close_at = None;
                    let r = r.clone();
                    tokio::spawn(async move {
                        if let Some(r) = r.upgrade() {
                            r.send(ToHost::Close { id });
                        }
                    });
                    return;
                }
                a.lock().push(msg["kind"].as_str().unwrap_or_default().to_string());
                let values = policy.password.clone().map(|pw| vec![Zeroizing::new(pw)]);
                let t = t.clone();
                tokio::spawn(async move {
                    if let Some(t) = t.upgrade() {
                        t.send(HostCommand::AuthAnswer { id, prompt_id, values });
                    }
                });
            }
            _ => {}
        }
    });
    tunnels.connect(report.clone());
    redis.connect(report);
    H { tunnels, redis, main, asked, owners, policy }
}

static KEYS: AtomicU64 = AtomicU64::new(1);

fn via(port: u16, owner: bool, key: Option<&str>) -> Value {
    let key = key.map(str::to_string).unwrap_or_else(|| format!("k{}", KEYS.fetch_add(1, Ordering::SeqCst)));
    json!({ "dbHost": "127.0.0.1", "dbPort": port, "tunnelKey": key, "owner": owner })
}

fn connect(id: &str, s: &TestServer, password: Option<&str>) -> HostCommand {
    HostCommand::Connect(Box::new(ConnectRequest {
        id: id.into(),
        host: "127.0.0.1".into(),
        port: s.port(),
        username: "alice".into(),
        cols: 80,
        rows: 24,
        private_key: None,
        passphrase: None,
        password: password.map(|p| Zeroizing::new(p.to_string())),
        startup: None,
        allow_password_prompt: true,
        debug: false,
        sftp_sudo: None,
    }))
}

async fn wait_for(what: impl Fn() -> bool, ms: u64) {
    let start = Instant::now();
    while !what() {
        assert!(start.elapsed() < Duration::from_millis(ms), "timed out");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

impl H {
    fn open(&self, id: &str, ssh: Value) {
        let config = json!({ "kind": "redis", "host": "ignored.example", "port": 1, "user": "", "database": "0", "tls": "disable", "readOnly": false, "ssh": ssh });
        self.redis.send(ToHost::Open { id: id.into(), config });
    }

    fn statuses(&self, id: &str, t: &str) -> Vec<Value> {
        self.main.lock().iter().filter(|m| m["t"] == t && m["id"] == id).cloned().collect()
    }

    fn last(&self, id: &str) -> Value {
        self.statuses(id, "dbStatus").last().cloned().unwrap_or(Value::Null)
    }

    fn phase(&self, id: &str) -> String {
        self.last(id)["phase"].as_str().unwrap_or_default().to_string()
    }

    async fn settled(&self, id: &str) {
        wait_for(|| ["connected", "error", "closed"].contains(&self.phase(id).as_str()), 15_000).await;
    }

    async fn databases(&self, id: &str) -> Value {
        self.redis.request(id, json!({ "op": "redis", "req": { "kind": "databases" } }), None).await
    }

    fn close(&self, id: &str) {
        self.redis.send(ToHost::Close { id: id.into() });
    }
}

fn sid(n: u32) -> String {
    format!("db:aaaaaaaa-0000-4000-8000-{n:012}")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn logs_in_with_host_key_and_password_questions_forwards_to_the_database_and_runs_through_it() {
    let Some(db) = Resp::start(json!({})) else { return };
    let s = ssh(true).await;
    let h = harness(Policy { password: Some("pw".into()), close_at: None }, TUNNEL_TIMERS.ssh_wait);
    let id = sid(1);
    h.open(&id, via(db.port, true, None));
    assert!(h.tunnels.send(connect(&id, &s, None)));
    h.settled(&id).await;
    assert_eq!(h.phase(&id), "connected", "{:?}", h.main.lock());
    assert_eq!(*h.asked.lock(), ["hostKey", "password"]);
    let phases = |t: &str| h.statuses(&id, t).iter().map(|m| m["phase"].as_str().unwrap().to_string()).collect::<Vec<_>>();
    assert_eq!(phases("dbStatus"), ["connecting", "verifying", "authenticating", "database", "connected"]);
    assert_eq!(phases("sshStatus"), ["connecting", "verifying", "authenticating", "connected"]);
    assert_eq!(s.forwards(), [Forward { host: "127.0.0.1".into(), port: db.port as u32, accepted: true }]);
    // The database answers through the forwarded channel (there is no local listener: the session reads the channel itself).
    assert_eq!(h.databases(&id).await["ok"], true);
    h.close(&id);
    assert_eq!(h.phase(&id), "closed");
    wait_for(|| s.connections() == 0, 10_000).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_refused_forward_ends_the_session_as_tunnel_and_a_dropped_ssh_connection_ends_a_live_one() {
    let Some(db) = Resp::start(json!({})) else { return };
    let s = ssh(false).await;
    let h = harness(Policy::default(), TUNNEL_TIMERS.ssh_wait);
    let id = sid(2);
    h.open(&id, via(db.port, true, None));
    h.tunnels.send(connect(&id, &s, Some("pw")));
    h.settled(&id).await;
    assert_eq!((h.phase(&id), h.last(&id)["error"].clone()), ("error".to_string(), json!("tunnel")));
    assert_eq!(s.forwards(), [Forward { host: "127.0.0.1".into(), port: db.port as u32, accepted: false }]);

    let s2 = ssh(true).await;
    let id2 = sid(3);
    h.open(&id2, via(db.port, true, None));
    h.tunnels.send(connect(&id2, &s2, Some("pw")));
    h.settled(&id2).await;
    assert_eq!(h.phase(&id2), "connected");
    s2.drop_connections();
    wait_for(|| h.phase(&id2) == "error", 15_000).await;
    let error = h.last(&id2)["error"].as_str().unwrap().to_string();
    assert!(["reset", "tunnel", "dbClosed"].contains(&error.as_str()), "{error}");
    assert_eq!(h.redis.session_count(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_cancelled_ssh_password_ends_with_the_ssh_error_and_no_sshconnect_in_time_ends_with_a_timeout() {
    let Some(db) = Resp::start(json!({})) else { return };
    let s = ssh(true).await;
    let h = harness(Policy { password: None, close_at: None }, TUNNEL_TIMERS.ssh_wait);
    let id = sid(4);
    h.open(&id, via(db.port, true, None));
    h.tunnels.send(connect(&id, &s, None));
    wait_for(|| h.phase(&id) == "error", 15_000).await;
    assert_eq!(h.last(&id)["error"], "cancelled");
    assert!(h.statuses(&id, "sshStatus").iter().any(|m| m["phase"] == "error"));

    let quick = harness(Policy::default(), Duration::from_millis(100));
    let id2 = sid(5);
    quick.open(&id2, via(db.port, true, None));
    quick.settled(&id2).await;
    assert_eq!((quick.phase(&id2), quick.last(&id2)["error"].clone()), ("error".to_string(), json!("timeout")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_tunnel_one_ssh_login_for_the_sessions_of_a_connection_closed_with_the_last_one() {
    let Some(db) = Resp::start(json!({})) else { return };
    let s = ssh(true).await;
    let h = harness(Policy::default(), TUNNEL_TIMERS.ssh_wait);
    let (a, b) = (sid(11), sid(12));
    h.open(&a, via(db.port, true, Some("shared")));
    h.open(&b, via(db.port, false, Some("shared")));
    h.tunnels.send(connect(&a, &s, Some("pw")));
    wait_for(|| h.phase(&a) == "connected" && h.phase(&b) == "connected", 15_000).await;
    assert_eq!(s.connections(), 1);
    assert_eq!(s.forwards().len(), 2);
    assert_eq!(h.tunnels.tunnel_count(), 1);
    // The owner closing does not end the tunnel of the other session.
    h.close(&a);
    assert_eq!(h.databases(&b).await["ok"], true);
    h.close(&b);
    assert_eq!(h.tunnels.tunnel_count(), 0);
    wait_for(|| s.connections() == 0, 10_000).await;
    // A session that expects a shared tunnel nobody opened fails at once.
    let c = sid(13);
    h.open(&c, via(db.port, false, Some("none")));
    h.settled(&c).await;
    assert_eq!((h.phase(&c), h.last(&c)["error"].clone()), ("error".to_string(), json!("tunnel")));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_owner_closed_during_the_login_hands_it_to_a_waiting_session_before_and_during_the_ssh_login() {
    let Some(db) = Resp::start(json!({})) else { return };
    let s = ssh(true).await;
    let h = harness(Policy { password: Some("pw".into()), close_at: None }, TUNNEL_TIMERS.ssh_wait);
    let (a, b, c) = (sid(21), sid(22), sid(23));
    h.open(&a, via(db.port, true, Some("handover")));
    h.open(&b, via(db.port, false, Some("handover")));
    h.open(&c, via(db.port, false, Some("handover")));
    // Before main's sshConnect arrived: b takes over, nobody reads "cancelled".
    h.close(&a);
    assert_eq!(h.phase(&a), "closed");
    wait_for(|| h.owners.lock().len() == 1, 5000).await;
    assert_eq!(*h.owners.lock(), std::slice::from_ref(&b));
    assert_eq!(h.phase(&b), "connecting");
    assert_eq!(h.tunnels.tunnel_count(), 1);
    // During the SSH login (at the password question): c takes over and logs the tunnel in.
    h.policy.lock().close_at = Some(b.clone());
    h.tunnels.send(connect(&b, &s, None));
    wait_for(|| h.owners.lock().len() == 2, 15_000).await;
    assert_eq!(*h.owners.lock(), [b.clone(), c.clone()]);
    assert_eq!(h.phase(&b), "closed");
    // The dropped attempt's prompt answers go nowhere; the new owner's login runs.
    h.tunnels.send(connect(&c, &s, None));
    h.settled(&c).await;
    assert_eq!(h.phase(&c), "connected");
    assert!(!h.main.lock().iter().any(|m| m["t"] == "dbStatus" && m["error"] == "cancelled"));
    assert_eq!(h.databases(&c).await["ok"], true);
    h.close(&c);
    assert_eq!(h.tunnels.tunnel_count(), 0);
    wait_for(|| s.connections() == 0, 10_000).await;
}
