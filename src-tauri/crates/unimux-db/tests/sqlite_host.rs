//! D12: the SQLite host behind the DB service: open (the file must exist), `connected` with the SQLite version, a run
//! whose rows go to the port, notices to the log, close.

use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Value, json};
use unimux_db::host::{DbHostLink, Spawn, ToHost, UnavailableHost};
use unimux_db::sqlite::PortMessage;
use unimux_db::sqlite::host::SqliteHost;

struct Host {
    host: Arc<SqliteHost>,
    reports: Arc<Mutex<Vec<Value>>>,
    port: Arc<Mutex<Vec<Value>>>,
}

fn host() -> Host {
    let spawn: Spawn = Arc::new(|f| {
        tokio::spawn(f);
    });
    let host = SqliteHost::new(UnavailableHost::new(spawn.clone()), spawn);
    let reports = Arc::new(Mutex::new(Vec::new()));
    let r = reports.clone();
    host.connect(Arc::new(move |m| r.lock().push(m)));
    let port = Arc::new(Mutex::new(Vec::new()));
    let p = port.clone();
    host.connect_port(Arc::new(move |m: PortMessage| p.lock().push(serde_json::from_str(&m.to_json()).unwrap())));
    Host { host, reports, port }
}

impl Host {
    async fn wait_phase(&self, id: &str, phase: &str) -> Value {
        for _ in 0..500 {
            let found =
                self.reports.lock().iter().find(|m| m["t"] == "dbStatus" && m["id"] == id && m["phase"] == phase).cloned();
            if let Some(m) = found {
                return m;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no {phase} for {id}: {:?}", self.reports.lock());
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn sqlite_sessions_open_run_and_close() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.sqlite");
    {
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t VALUES (1, 'a'), (2, 'b');").unwrap();
    }
    let h = host();
    let config = json!({ "kind": "sqlite", "path": path.to_string_lossy(), "readOnly": false, "host": "", "port": 0 });
    assert!(h.host.send(ToHost::Open { id: "db:s".into(), config }));
    let connected = h.wait_phase("db:s", "connected").await;
    assert!(connected["serverVersion"].as_str().unwrap().starts_with("SQLite 3."));
    assert_eq!(connected["database"], "main");
    assert!(connected.get("tls").is_none(), "a file has no encryption badge");
    let q = json!({ "op": "query", "req": { "queryId": "q1", "sql": "SELECT * FROM t" } });
    assert_eq!(h.host.request("db:s", q, Some("w".into())).await, json!({ "ok": true, "value": true }));
    for _ in 0..500 {
        if h.port.lock().iter().any(|m| m["t"] == "queryEnd") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let rows: Vec<Value> =
        h.port.lock().iter().filter(|m| m["t"] == "rows").flat_map(|m| m["rows"].as_array().unwrap().clone()).collect();
    assert_eq!(rows, [json!(["1", "a"]), json!(["2", "b"])]);
    assert!(h.host.send(ToHost::Close { id: "db:s".into() }));
    h.wait_phase("db:s", "closed").await;
    assert_eq!(h.host.session_count(), 0);
    assert_eq!(h.host.request("db:s", json!({ "op": "schemas" }), None).await["error"], "noSession");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_missing_file_is_never_created() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("gone.sqlite");
    let h = host();
    let config = json!({ "kind": "sqlite", "path": path.to_string_lossy(), "readOnly": false });
    h.host.send(ToHost::Open { id: "db:m".into(), config });
    let e = h.wait_phase("db:m", "error").await;
    assert_eq!(e["error"], "dbFileMissing");
    assert_eq!(e["message"], path.to_string_lossy().as_ref());
    assert!(!path.exists());
    // no path: unsupported
    h.host.send(ToHost::Open { id: "db:n".into(), config: json!({ "kind": "sqlite" }) });
    assert_eq!(h.wait_phase("db:n", "error").await["error"], "unsupported");
}
