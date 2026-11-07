//! Port of test/db-main.test.ts (DbService with a fake DB Host link and a fake coordinator): saved connections and their
//! passwords, opening sessions (what the host gets), states, the database password prompt, the idle disconnect and pins, a
//! host restart, tests, tunnels shared between sessions, and the SQLite connections. The IPC validation cases are in
//! tests/db_ipc.rs.

mod common;

use common::*;
use serde_json::{Value, json};
use unimux_db::model::strict_connection;
use unimux_db::service::{PasswordChange, TestPassword};
use unimux_db::vault::Password;
use zeroize::Zeroizing;

fn pw(p: &str) -> Password {
    Password::Ok(Zeroizing::new(p.to_string()))
}

fn session_id(r: Result<String, String>) -> String {
    r.expect("connect")
}

// ── DbService: saved connections ──────────────────────────────────────────────

#[tokio::test]
async fn saves_updates_duplicates_with_the_password_and_deletes_connections_passwords_go_to_the_vault_only() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let c = t.save(json!({}), set("pw1"));
    let id = c["id"].as_str().unwrap().to_string();
    assert_eq!(t.connections(), vec![with(input(), json!({ "id": id, "createdAt": 1000, "updatedAt": 1000 }))]);
    assert!(!serde_json::to_string(&*t.current()).unwrap().contains("pw1"));
    assert_eq!(t.vault.password(&id), pw("pw1"));
    assert_eq!(*t.events.vault_changes.lock(), 1);
    let updated = t.service.save_connection(&with(input(), json!({ "id": id, "name": "renamed" })), &PasswordChange::Keep);
    assert_eq!((updated["ok"].clone(), updated["connection"]["id"].clone()), (json!(true), json!(id)));
    assert_eq!(updated["connection"]["name"], "renamed");
    assert!(matches!(t.vault.password(&id), Password::Ok(_)));
    let copy = t.service.duplicate_connection(&id);
    assert_eq!(copy["ok"], true);
    assert_eq!(copy["connection"]["name"], "renamed (2)");
    let copy_id = copy["connection"]["id"].as_str().unwrap().to_string();
    assert_eq!(t.vault.password(&copy_id), pw("pw1"));
    assert_eq!(t.service.save_connection(&with(input(), json!({ "id": id })), &PasswordChange::Clear)["ok"], true);
    assert!(!matches!(t.vault.password(&id), Password::Ok(_)));
    assert_eq!(t.service.delete_connection(&copy_id), json!({ "ok": true }));
    assert!(!matches!(t.vault.password(&copy_id), Password::Ok(_)));
    assert_eq!(t.connections().iter().map(|c| c["id"].clone()).collect::<Vec<_>>(), vec![json!(id)]);
    assert_eq!(t.service.delete_connection(&copy_id), json!({ "ok": false }));
}

#[tokio::test]
async fn refuses_unknown_ids_anything_the_normalizer_would_change_and_password_changes_on_a_read_only_vault() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let save = |extra: Value| t.service.save_connection(&with(input(), extra), &PasswordChange::Keep);
    assert_eq!(save(json!({ "id": HOST })), json!({ "ok": false, "error": "notFound" }));
    assert_eq!(save(json!({ "port": 0 })), json!({ "ok": false, "error": "invalid" }));
    assert_eq!(save(json!({ "tls": "verify-full" })), json!({ "ok": false, "error": "invalid" }));
    assert_eq!(save(json!({ "host": "DB.example.com" })), json!({ "ok": false, "error": "invalid" }));
    assert_eq!(strict_connection(&with(input(), json!({ "id": HOST, "createdAt": 0, "updatedAt": 0 }))).unwrap()["id"], HOST);
    // A read-only vault (a newer file) refuses password changes; keeping the password still saves.
    std::fs::create_dir_all(dir.path().join("ro").join("db")).unwrap();
    std::fs::write(dir.path().join("ro").join("db").join("vault.json"), r#"{"version":9}"#).unwrap();
    let ro = setup(&dir.path().join("ro"), Options::default());
    assert_eq!(ro.service.save_connection(&input(), &set("x")), json!({ "ok": false, "error": "readOnly" }));
    assert_eq!(ro.service.save_connection(&input(), &PasswordChange::Keep)["ok"], true);
}

#[tokio::test]
async fn prunes_the_vault_when_connections_disappear_from_the_state() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let c = t.save(json!({}), set("x"));
    t.vault.set_password(HOST, "orphan").unwrap();
    t.service.state_changed(&t.current());
    assert_eq!(t.vault.info().saved, vec![c["id"].as_str().unwrap().to_string()]);
}

// ── DbService: sessions ───────────────────────────────────────────────────────

#[tokio::test]
async fn answers_at_once_with_the_id_then_opens_the_session_in_the_db_host_with_the_saved_password_and_the_ca() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let c =
        t.save(json!({ "tls": "verify-full", "caPath": "C:\\ca.pem", "statementTimeoutMs": 5000, "readOnly": true }), set("pw"));
    let sid = session_id(t.service.connect(c["id"].as_str().unwrap(), Some("other")));
    assert!(sid.starts_with("db:"));
    flush().await;
    assert_eq!(
        t.sent(),
        vec![json!({ "t": "dbOpen", "id": sid, "config": {
            "kind": "postgres", "host": "db.example.com", "port": 5432, "user": "app", "database": "other", "tls": "verify-full",
            "ca": "CA PEM", "password": "pw", "readOnly": true, "statementTimeoutMs": 5000, "ssh": null } })]
    );
    let first = t.events.sessions.lock()[0].clone();
    for (k, v) in [
        ("id", json!(sid)),
        ("connectionId", c["id"].clone()),
        ("state", json!("connecting")),
        ("phase", json!("connecting")),
        ("database", json!("other")),
        ("readOnly", json!(true)),
    ] {
        assert_eq!(first[k], v, "{k}");
    }
    assert!(t.calls().is_empty());
    t.service.on_host_message(json!({ "t": "dbStatus", "id": sid, "phase": "database" }));
    t.service.on_host_message(
        json!({ "t": "dbStatus", "id": sid, "phase": "connected", "serverVersion": "16.4", "database": "other" }),
    );
    let last = t.last(&sid);
    assert_eq!((last["state"].clone(), last["phase"].clone()), (json!("connected"), json!("connected")));
    assert_eq!((last["serverVersion"].clone(), last["tx"].clone()), (json!("16.4"), json!("idle")));
    t.service.on_host_message(json!({ "t": "dbTx", "id": sid, "tx": "transaction" }));
    assert_eq!(t.last(&sid)["tx"], "transaction");
    assert_eq!(t.service.op(&sid, json!({ "op": "schemas" }), None).await, json!({ "ok": true, "value": "answer" }));
    assert_eq!(*t.host.requests.lock(), vec![(sid.clone(), json!({ "op": "schemas" }))]);
    assert_eq!(t.service.disconnect(&sid), json!({ "ok": true }));
    assert_eq!(t.sent().last().unwrap(), &json!({ "t": "dbClose", "id": sid }));
    assert_eq!((t.last(&sid)["state"].clone(), t.last(&sid)["phase"].clone()), (json!("closed"), json!("closed")));
    assert_eq!(t.service.op(&sid, json!({ "op": "schemas" }), None).await, json!({ "ok": false, "error": "noSession" }));
}

#[tokio::test]
async fn fails_early_for_a_missing_connection_a_missing_ssh_host_an_unreadable_ca_and_a_db_host_that_cannot_start() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options { ca: None, ..Default::default() });
    assert_eq!(t.service.connect(HOST, None), Err("connectionMissing".to_string()));
    let tunnel = t.save(
        json!({ "ssh": { "hostId": "00000000-0000-4000-8000-0000000000ff", "dbHost": "127.0.0.1", "dbPort": 5432 } }),
        PasswordChange::Keep,
    );
    assert_eq!(t.service.connect(tunnel["id"].as_str().unwrap(), None), Err("hostMissing".to_string()));
    let ca = t.save(json!({ "tls": "verify-full", "caPath": "/etc/ca.pem" }), PasswordChange::Keep);
    let sid = session_id(t.service.connect(ca["id"].as_str().unwrap(), None));
    flush().await;
    assert_eq!((t.last(&sid)["state"].clone(), t.last(&sid)["error"].clone()), (json!("error"), json!("caFile")));
    assert!(t.sent().is_empty());
    let dir2 = tempfile::tempdir().unwrap();
    let down = setup(dir2.path(), Options { host_up: false, ..Default::default() });
    let c = down.save(json!({}), PasswordChange::Keep);
    assert_eq!(down.service.connect(c["id"].as_str().unwrap(), None), Err("dbHostCrashed".to_string()));
}

#[tokio::test]
async fn logs_a_tunnel_in_through_the_coordinator_a_coordinator_failure_or_refusal_ends_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let c = t.save(json!({ "ssh": { "hostId": HOST, "dbHost": "127.0.0.1", "dbPort": 5433 } }), PasswordChange::Keep);
    let cid = c["id"].as_str().unwrap().to_string();
    let sid = session_id(t.service.connect(&cid, None));
    flush().await;
    assert_eq!(t.sent()[0]["t"], "dbOpen");
    assert_eq!(t.sent()[0]["config"]["ssh"]["dbHost"], "127.0.0.1");
    assert_eq!(t.sent()[0]["config"]["ssh"]["dbPort"], 5433);
    assert_eq!(t.calls(), vec![format!("connect {sid} {HOST}")]);
    let err = json!({ "cellId": sid, "hostId": HOST, "phase": "error", "since": 1, "error": "hostKeyRejected" });
    t.service.on_coordinator_session(&with(err.clone(), json!({ "phase": "authenticating" })));
    assert_eq!(t.last(&sid)["state"], "connecting");
    t.service.on_coordinator_session(&err);
    assert_eq!((t.last(&sid)["state"].clone(), t.last(&sid)["error"].clone()), (json!("error"), json!("hostKeyRejected")));
    assert_eq!(t.sent().last().unwrap(), &json!({ "t": "dbClose", "id": sid }));
    flush().await;
    assert_eq!(t.calls().last().unwrap(), &format!("end {sid}"));
    *t.coordinator.refuse.lock() = Some("hostMissing".into());
    let sid2 = session_id(t.service.connect(&cid, None));
    flush().await;
    flush().await;
    assert_eq!((t.last(&sid2)["state"].clone(), t.last(&sid2)["error"].clone()), (json!("error"), json!("hostMissing")));
}

#[tokio::test]
async fn asks_for_the_database_password_passes_the_answer_on_and_saves_it_only_once_connected_with_remember() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let c = t.save(json!({}), PasswordChange::Keep);
    let cid = c["id"].as_str().unwrap().to_string();
    let sid = session_id(t.service.connect(&cid, None));
    flush().await;
    t.service.on_host_message(json!({ "t": "dbPasswordPrompt", "id": sid, "promptId": "host-prompt-1", "retry": false }));
    let (pid_session, prompt) = t.events.prompts.lock().last().cloned().unwrap();
    assert_eq!(pid_session, sid);
    let prompt = prompt.unwrap();
    for (k, v) in [
        ("kind", json!("dbPassword")),
        ("connectionName", json!("prod")),
        ("user", json!("app")),
        ("endpoint", json!("db.example.com:5432/shop")),
        ("canSave", json!(true)),
        ("retry", json!(false)),
    ] {
        assert_eq!(prompt[k], v, "{k}");
    }
    assert_eq!(t.service.snapshot()["prompts"], json!([{ "sessionId": sid, "prompt": prompt }]));
    let pid = prompt["id"].clone();
    assert!(!t.service.answer(&json!({ "sessionId": sid, "promptId": pid, "values": ["a", "b"] })));
    assert!(t.service.answer(&json!({ "sessionId": sid, "promptId": pid, "values": ["typed"], "remember": true })));
    assert_eq!(
        t.sent().last().unwrap(),
        &json!({ "t": "dbPasswordAnswer", "id": sid, "promptId": "host-prompt-1", "value": "typed" })
    );
    assert_eq!(t.events.prompts.lock().last().cloned().unwrap(), (sid.clone(), None));
    assert!(!matches!(t.vault.password(&cid), Password::Ok(_)));
    t.service.on_host_message(json!({ "t": "dbStatus", "id": sid, "phase": "connected" }));
    assert_eq!(t.vault.password(&cid), pw("typed"));
    // Another prompt id goes to the coordinator (an SSH question of the tunnel).
    assert!(t.service.answer(&json!({ "sessionId": sid, "promptId": "other", "cancel": true })));
    assert_eq!(*t.coordinator.answers.lock(), vec![json!({ "cellId": sid, "promptId": "other", "cancel": true })]);
}

#[tokio::test]
async fn a_prompt_nobody_answers_is_cancelled_after_the_timeout_an_error_ends_the_session_with_the_server_text() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let c = t.save(json!({}), PasswordChange::Keep);
    let sid = session_id(t.service.connect(c["id"].as_str().unwrap(), None));
    flush().await;
    t.service.on_host_message(json!({ "t": "dbPasswordPrompt", "id": sid, "promptId": "hp", "retry": false }));
    t.timers.fire(5 * 60_000);
    assert_eq!(t.sent().last().unwrap(), &json!({ "t": "dbPasswordAnswer", "id": sid, "promptId": "hp", "value": null }));
    t.service.on_host_message(
        json!({ "t": "dbStatus", "id": sid, "phase": "error", "error": "dbAuth", "message": "password authentication failed" }),
    );
    let last = t.last(&sid);
    assert_eq!((last["state"].clone(), last["error"].clone()), (json!("error"), json!("dbAuth")));
    assert_eq!(last["message"], "password authentication failed");
    assert_eq!(t.service.snapshot()["sessions"], json!([]));
}

#[tokio::test]
async fn disconnects_an_idle_session_unless_a_tab_pins_it_or_it_is_busy() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let c = t.save(json!({}), PasswordChange::Keep);
    let sid = session_id(t.service.connect(c["id"].as_str().unwrap(), None));
    flush().await;
    t.service.on_host_message(json!({ "t": "dbStatus", "id": sid, "phase": "connected" }));
    t.service.pin(std::slice::from_ref(&sid), "main");
    t.timers.fire(5 * 60_000);
    assert_eq!(t.last(&sid)["state"], "connected");
    t.service.pin(&[], "main");
    t.service.on_host_message(json!({ "t": "dbActivity", "id": sid, "busy": true }));
    t.timers.fire(5 * 60_000);
    assert_eq!(t.last(&sid)["state"], "connected");
    t.service.on_host_message(json!({ "t": "dbActivity", "id": sid, "busy": false }));
    t.timers.fire(5 * 60_000);
    assert_eq!(t.last(&sid)["state"], "closed");
    assert_eq!(t.sent().last().unwrap(), &json!({ "t": "dbClose", "id": sid }));
}

#[tokio::test]
async fn an_idle_timer_replaced_while_it_was_already_firing_does_not_disconnect() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let c = t.save(json!({}), PasswordChange::Keep);
    let sid = session_id(t.service.connect(c["id"].as_str().unwrap(), None));
    flush().await;
    t.service.on_host_message(json!({ "t": "dbStatus", "id": sid, "phase": "connected" }));
    // The old timer has started (cancel cannot stop it) when an operation reschedules the idle timer.
    let ran = t.timers.fire_late(5 * 60_000, || {
        t.service.pin(std::slice::from_ref(&sid), "main");
        t.service.pin(&[], "main");
    });
    assert_eq!(ran, 1);
    assert_eq!(t.last(&sid)["state"], "connected");
    // The new timer still disconnects once it fires.
    assert_eq!(t.timers.fire(5 * 60_000), 1);
    assert_eq!(t.last(&sid)["state"], "closed");
}

#[tokio::test]
async fn a_db_host_restart_ends_every_session_and_tells_the_coordinator() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let c = t.save(json!({}), PasswordChange::Keep);
    let sid = session_id(t.service.connect(c["id"].as_str().unwrap(), None));
    flush().await;
    t.service.host_crashed();
    assert_eq!((t.last(&sid)["state"].clone(), t.last(&sid)["error"].clone()), (json!("error"), json!("dbHostCrashed")));
    assert!(t.calls().contains(&"crashed db".to_string()));
    assert_eq!(*t.events.crashes.lock(), 1);
}

#[tokio::test]
async fn a_test_session_resolves_once_connected_and_disconnects_by_itself_a_failure_resolves_with_the_error() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let pending = tokio::spawn(t.service.test_connection(&input(), &TestPassword::Set(Zeroizing::new("pw".into()))));
    flush().await;
    let open = t.opens()[0].clone();
    assert_eq!(open["config"]["password"], "pw");
    assert_eq!(t.events.sessions.lock()[0]["test"], true);
    let oid = open["id"].as_str().unwrap().to_string();
    t.service.on_host_message(json!({ "t": "dbStatus", "id": oid, "phase": "connected", "serverVersion": "17.0" }));
    assert_eq!(pending.await.unwrap(), json!({ "ok": true, "serverVersion": "17.0", "timeMs": 0 }));
    assert_eq!(t.sent().last().unwrap(), &json!({ "t": "dbClose", "id": oid }));
    let failing = tokio::spawn(t.service.test_connection(&input(), &TestPassword::None));
    flush().await;
    let open2 = t.opens().last().cloned().unwrap();
    assert!(open2["config"].get("password").is_none());
    t.service.on_host_message(json!({ "t": "dbStatus", "id": open2["id"], "phase": "error", "error": "dbRefused" }));
    assert_eq!(failing.await.unwrap(), json!({ "ok": false, "error": "dbRefused" }));
    assert_eq!(
        t.service.test_connection(&with(input(), json!({ "port": -1 })), &TestPassword::None).await,
        json!({ "ok": false, "error": "invalid" })
    );
}

#[tokio::test]
async fn a_test_that_never_connects_ends_with_db_timeout_after_seven_minutes() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let pending = tokio::spawn(t.service.test_connection(&input(), &TestPassword::None));
    flush().await;
    let oid = t.opens()[0]["id"].clone();
    assert_eq!(t.timers.fire(7 * 60_000), 1);
    assert_eq!(pending.await.unwrap(), json!({ "ok": false, "error": "dbTimeout" }));
    assert_eq!(t.sent().last().unwrap(), &json!({ "t": "dbClose", "id": oid }));
    // A test refused with the form's password ends as a wrong password instead of asking again.
    let refused = tokio::spawn(t.service.test_connection(&input(), &TestPassword::Set(Zeroizing::new("bad".into()))));
    flush().await;
    let oid = t.opens().last().unwrap()["id"].as_str().unwrap().to_string();
    t.service.on_host_message(json!({ "t": "dbPasswordPrompt", "id": oid, "promptId": "hp", "retry": true }));
    assert_eq!(t.sent().last().unwrap(), &json!({ "t": "dbPasswordAnswer", "id": oid, "promptId": "hp", "value": null }));
    t.service.on_host_message(json!({ "t": "dbStatus", "id": oid, "phase": "error", "error": "cancelled" }));
    assert_eq!(refused.await.unwrap(), json!({ "ok": false, "error": "dbAuth" }));
    assert!(t.timers.live().is_empty(), "no test timer is left: {:?}", t.timers.live());
}

// ── DbService: fix round 1 ────────────────────────────────────────────────────

#[tokio::test]
async fn caps_the_sessions_of_one_connection() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let c = t.save(json!({}), PasswordChange::Keep);
    for _ in 0..32 {
        assert!(t.service.connect(c["id"].as_str().unwrap(), None).is_ok());
    }
    assert_eq!(t.service.connect(c["id"].as_str().unwrap(), None), Err("tooMany".to_string()));
    let other = t.save(json!({ "name": "other" }), PasswordChange::Keep);
    assert!(t.service.connect(other["id"].as_str().unwrap(), None).is_ok());
}

#[tokio::test]
async fn caps_the_sessions_in_all() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    for i in 0..4 {
        let c = t.save(json!({ "name": format!("c{i}") }), PasswordChange::Keep);
        for _ in 0..32 {
            assert!(t.service.connect(c["id"].as_str().unwrap(), None).is_ok());
        }
    }
    let c = t.save(json!({ "name": "fifth" }), PasswordChange::Keep);
    assert_eq!(t.service.connect(c["id"].as_str().unwrap(), None), Err("tooMany".to_string()));
}

#[tokio::test]
async fn shares_one_tunnel_login_between_the_sessions_of_a_connection() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let c = t.save(json!({ "ssh": { "hostId": HOST, "dbHost": "127.0.0.1", "dbPort": 5433 } }), PasswordChange::Keep);
    let cid = c["id"].as_str().unwrap().to_string();
    let a = session_id(t.service.connect(&cid, None));
    let b = session_id(t.service.connect(&cid, None));
    flush().await;
    let opens = t.opens();
    assert_eq!(opens.iter().map(|o| o["config"]["ssh"]["owner"].clone()).collect::<Vec<_>>(), [json!(true), json!(false)]);
    assert_eq!(opens[0]["config"]["ssh"]["tunnelKey"], opens[1]["config"]["ssh"]["tunnelKey"]);
    assert_eq!(t.calls(), vec![format!("connect {a} {HOST}")]);
    t.service.disconnect(&a);
    let _ = t.service.connect(&cid, None);
    flush().await;
    assert_eq!(t.opens().last().unwrap()["config"]["ssh"]["owner"], false);
    for id in t.service.ids() {
        t.service.disconnect(&id);
    }
    let d = session_id(t.service.connect(&cid, None));
    flush().await;
    assert_eq!(t.opens().last().unwrap()["config"]["ssh"]["owner"], true);
    let connects: Vec<String> = t.calls().into_iter().filter(|x| x.starts_with("connect")).collect();
    assert_eq!(connects, vec![format!("connect {a} {HOST}"), format!("connect {d} {HOST}")]);
    assert!(!b.is_empty());
}

#[tokio::test]
async fn a_rider_takes_the_tunnel_login_over_when_its_owner_closed_and_a_failed_login_ends_the_riders_first() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let c = t.save(json!({ "ssh": { "hostId": HOST, "dbHost": "127.0.0.1", "dbPort": 5433 } }), PasswordChange::Keep);
    let cid = c["id"].as_str().unwrap().to_string();
    let a = session_id(t.service.connect(&cid, None));
    let b = session_id(t.service.connect(&cid, None));
    let r = session_id(t.service.connect(&cid, None));
    flush().await;
    let key = t.opens()[0]["config"]["ssh"]["tunnelKey"].as_str().unwrap().to_string();
    t.service.disconnect(&a);
    t.service.on_host_message(json!({ "t": "dbTunnelOwner", "id": b }));
    flush().await;
    assert_eq!(t.service.tunnel_owner(&key), Some(b.clone()));
    assert_eq!(t.calls().iter().rfind(|x| x.starts_with("connect")).unwrap(), &format!("connect {b} {HOST}"));
    t.service.on_coordinator_session(&json!({ "cellId": b, "phase": "error", "error": "auth" }));
    let closes: Vec<Value> = t.sent().into_iter().filter(|m| m["t"] == "dbClose").map(|m| m["id"].clone()).collect();
    assert_eq!(closes, [json!(a), json!(r), json!(b)], "the rider ends first, then the owner");
    assert_eq!(t.last(&r)["error"], "auth");
    assert_eq!(t.service.tunnel_owner(&key), None);
}

#[tokio::test]
async fn a_test_uses_a_saved_password_only_for_the_server_it_was_saved_for() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let c = t.save(json!({}), set("pw"));
    let saved = TestPassword::Saved(c["id"].as_str().unwrap().to_string());
    let invalid = json!({ "ok": false, "error": "invalid" });
    assert_eq!(t.service.test_connection(&with(input(), json!({ "host": "evil.example.com" })), &saved).await, invalid);
    assert_eq!(t.service.test_connection(&with(input(), json!({ "user": "root" })), &saved).await, invalid);
    assert_eq!(
        t.service
            .test_connection(&with(input(), json!({ "ssh": { "hostId": HOST, "dbHost": "127.0.0.1", "dbPort": 5432 } })), &saved)
            .await,
        invalid
    );
    let same = tokio::spawn(t.service.test_connection(&with(input(), json!({ "name": "renamed", "tls": "require" })), &saved));
    flush().await;
    let open = t.opens().last().cloned().unwrap();
    assert_eq!(open["config"]["password"], "pw");
    t.service.on_host_message(json!({ "t": "dbStatus", "id": open["id"], "phase": "connected", "tls": true }));
    assert_eq!(same.await.unwrap()["ok"], true);
}

#[tokio::test]
async fn reports_whether_the_connection_is_encrypted() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let c = t.save(json!({ "tls": "prefer" }), PasswordChange::Keep);
    let sid = session_id(t.service.connect(c["id"].as_str().unwrap(), None));
    flush().await;
    t.service.on_host_message(json!({ "t": "dbStatus", "id": sid, "phase": "connected", "tls": false }));
    assert_eq!((t.last(&sid)["state"].clone(), t.last(&sid)["tls"].clone()), (json!("connected"), json!(false)));
}

#[tokio::test]
async fn a_mysql_server_keeps_its_flavour_on_the_connection_and_redis_reconnects_are_not_new_logins() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let my = t.save(json!({ "kind": "mysql", "port": 3306, "database": null }), PasswordChange::Keep);
    let sid = session_id(t.service.connect(my["id"].as_str().unwrap(), None));
    flush().await;
    t.service.on_host_message(json!({ "t": "dbStatus", "id": sid, "phase": "connected", "serverVersion": "11.4.2-MariaDB" }));
    assert_eq!(t.connections()[0]["flavor"], "mariadb");
    // A save keeps the flavour while the kind stays.
    let again = t.service.save_connection(
        &with(input(), json!({ "id": my["id"], "kind": "mysql", "port": 3306, "database": null })),
        &PasswordChange::Keep,
    );
    assert_eq!(again["connection"]["flavor"], "mariadb");
    let redis =
        t.save(json!({ "kind": "redis", "port": 6379, "user": "", "database": null, "dbIndex": 2 }), PasswordChange::Keep);
    let rid = session_id(t.service.connect(redis["id"].as_str().unwrap(), None));
    flush().await;
    assert_eq!(t.last(&rid)["database"], "2");
    t.service.on_host_message(json!({ "t": "dbStatus", "id": rid, "phase": "connected" }));
    t.service.on_host_message(json!({ "t": "dbStatus", "id": rid, "phase": "database", "reconnect": 1 }));
    assert_eq!(t.last(&rid)["reconnecting"], 1);
    t.service.on_host_message(json!({ "t": "dbStatus", "id": rid, "phase": "connected" }));
    assert!(t.last(&rid).get("reconnecting").is_none());
    assert!(t.last(&rid).get("tx").is_none(), "Redis has no transaction state");
    t.service.on_host_message(json!({ "t": "dbDatabase", "id": rid, "database": "5" }));
    assert_eq!(t.last(&rid)["database"], "5");
}

// ── DbService: SQLite connections (1.0.6) ─────────────────────────────────────

#[tokio::test]
async fn a_sqlite_connection_opens_with_its_path_no_password_no_tunnel_and_ignores_another_database() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let file = "C:\\data\\shop.sqlite";
    let sqlite = json!({ "kind": "sqlite", "name": "shop", "host": "", "port": 0, "user": "", "tls": "disable", "ssh": null, "readOnly": true, "path": file });
    let saved = t.service.save_connection(&sqlite, &PasswordChange::Keep);
    assert_eq!(saved["connection"]["kind"], "sqlite");
    assert_eq!(saved["connection"]["path"], file);
    assert_eq!(saved["connection"]["port"], 0);
    let sid = session_id(t.service.connect(saved["connection"]["id"].as_str().unwrap(), Some("other")));
    flush().await;
    let open = t.opens()[0].clone();
    assert_eq!(open["config"]["kind"], "sqlite");
    assert_eq!(open["config"]["path"], file);
    assert_eq!(open["config"]["database"], "main");
    assert_eq!(open["config"]["readOnly"], true);
    assert_eq!(open["config"]["ssh"], Value::Null);
    assert!(open["config"].get("password").is_none());
    assert_eq!(open["id"], sid);
}
