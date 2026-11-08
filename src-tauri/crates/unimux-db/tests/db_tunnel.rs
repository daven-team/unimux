//! D2: the tunnel records of the DB sessions (owner, riders, reference count, hand-over, the wait for main's sshConnect, a
//! login that fails, shutdown). No SSH server: a login against a closed port stands for a failing tunnel.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use unimux_db::host::Spawn;
use unimux_db::tunnel::{DbTunnelHost, SessionFail, TunnelTimers};
use unimux_ssh::coordinator::SshHostLink;
use unimux_ssh::login::LOGIN_TIMERS;
use unimux_ssh::protocol::{ConnectRequest, HostCommand};

const KEY: &str = "conn-1";

fn host(ssh_wait_ms: u64) -> (Arc<DbTunnelHost>, Arc<Mutex<Vec<Value>>>) {
    let spawn: Spawn = Arc::new(|f| {
        tokio::spawn(f);
    });
    let timers = TunnelTimers {
        login: LOGIN_TIMERS,
        ssh_wait: Duration::from_millis(ssh_wait_ms),
        kill_grace: Duration::from_millis(100),
    };
    let h = DbTunnelHost::new(spawn, timers);
    let msgs = Arc::new(Mutex::new(Vec::new()));
    let m = msgs.clone();
    h.connect(Arc::new(move |v| m.lock().push(v)));
    (h, msgs)
}

fn fails() -> (SessionFail, Arc<Mutex<Vec<String>>>) {
    let got = Arc::new(Mutex::new(Vec::new()));
    let g = got.clone();
    (Arc::new(move |code| g.lock().push(code)), got)
}

fn ssh(owner: bool) -> Value {
    json!({ "dbHost": "10.0.0.5", "dbPort": 5432, "tunnelKey": KEY, "owner": owner })
}

fn connect_req(id: &str, port: u16) -> HostCommand {
    HostCommand::Connect(Box::new(ConnectRequest {
        id: id.into(),
        host: "127.0.0.1".into(),
        port,
        username: "u".into(),
        cols: 80,
        rows: 24,
        private_key: None,
        passphrase: None,
        password: None,
        startup: None,
        allow_password_prompt: false,
        debug: false,
        sftp_sudo: None,
    }))
}

async fn settle() {
    tokio::time::sleep(Duration::from_millis(50)).await;
}

#[tokio::test]
async fn a_rider_without_an_open_tunnel_fails_with_tunnel() {
    let (h, _) = host(60_000);
    let (f, got) = fails();
    let r = h.join("db:b", &ssh(false), f).await;
    assert_eq!(r.err().as_deref(), Some("tunnel"));
    assert!(got.lock().is_empty(), "the future carries the error");
    assert_eq!(h.tunnel_count(), 0);
    let (f, _) = fails();
    assert_eq!(h.join("db:c", &json!({ "dbHost": "h" }), f).await.err().as_deref(), Some("tunnel"));
}

#[tokio::test]
async fn no_sshconnect_in_time_ends_every_session_with_timeout() {
    let (h, _) = host(150);
    let (fa, got_a) = fails();
    let (fb, got_b) = fails();
    let a = h.join("db:a", &ssh(true), fa);
    let b = h.join("db:b", &ssh(false), fb);
    assert_eq!(h.tunnel_count(), 1, "one tunnel per connection");
    assert_eq!(a.await.err().as_deref(), Some("timeout"));
    assert_eq!(b.await.err().as_deref(), Some("timeout"));
    assert_eq!(*got_a.lock(), vec!["timeout".to_owned()]);
    assert_eq!(*got_b.lock(), vec!["timeout".to_owned()]);
    assert_eq!(h.tunnel_count(), 0);
}

#[tokio::test]
async fn an_owner_closed_during_the_login_hands_it_over() {
    let (h, msgs) = host(60_000);
    let (fa, _) = fails();
    let (fb, got_b) = fails();
    let _a = h.join("db:a", &ssh(true), fa);
    let b = h.join("db:b", &ssh(false), fb);
    h.release("db:a");
    assert_eq!(h.owner_of(KEY).as_deref(), Some("db:b"));
    settle().await;
    let m = msgs.lock().clone();
    assert_eq!(
        m,
        vec![json!({ "t": "dbStatus", "id": "db:b", "phase": "connecting" }), json!({ "t": "dbTunnelOwner", "id": "db:b" })]
    );
    // the old owner's connect no longer counts
    assert!(h.send(connect_req("db:a", 1)));
    settle().await;
    assert_eq!(msgs.lock().len(), 2);
    // the last session leaves: the tunnel closes and its wait ends
    h.release("db:b");
    assert_eq!(b.await.err().as_deref(), Some("cancelled"));
    assert!(got_b.lock().is_empty(), "a released session is not failed again");
    assert_eq!(h.tunnel_count(), 0);
}

#[tokio::test]
async fn a_failing_login_ends_the_owner_and_the_riders_with_its_error() {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let (h, msgs) = host(60_000);
    let (fa, got_a) = fails();
    let (fb, got_b) = fails();
    let a = h.join("db:a", &ssh(true), fa);
    let b = h.join("db:b", &ssh(false), fb);
    settle().await;
    assert!(h.send(connect_req("db:a", port)));
    let code = tokio::time::timeout(Duration::from_secs(30), a).await.expect("the login ends").unwrap_err();
    assert_eq!(b.await.err(), Some(code.clone()));
    assert_eq!(*got_a.lock(), vec![code.clone()]);
    assert_eq!(*got_b.lock(), vec![code.clone()]);
    let m = msgs.lock().clone();
    assert_eq!(m.first(), Some(&json!({ "t": "sshStatus", "id": "db:a", "phase": "connecting" })));
    assert_eq!(m.last(), Some(&json!({ "t": "sshStatus", "id": "db:a", "phase": "error", "error": code })));
    assert_eq!(h.tunnel_count(), 0);
    // a new session of the connection opens a new tunnel
    let (fc, _) = fails();
    let _c = h.join("db:c", &ssh(true), fc);
    assert_eq!(h.owner_of(KEY).as_deref(), Some("db:c"));
}

#[tokio::test]
async fn shutdown_ends_every_tunnel() {
    let (h, _) = host(60_000);
    let (fa, got_a) = fails();
    let a = h.join("db:a", &ssh(true), fa);
    let (fx, _) = fails();
    let x = h.join("db:x", &json!({ "dbHost": "h", "dbPort": 3306, "tunnelKey": "other", "owner": true }), fx);
    assert_eq!(h.tunnel_count(), 2);
    h.shutdown();
    assert_eq!(a.await.err().as_deref(), Some("cancelled"));
    assert_eq!(x.await.err().as_deref(), Some("cancelled"));
    assert_eq!(*got_a.lock(), vec!["cancelled".to_owned()]);
    assert_eq!(h.tunnel_count(), 0);
}
