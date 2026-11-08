//! D9: Redis sessions of the DB Host against an in-process RESP server (the shape of test/db-redis.int.test.ts): the 1.1.4
//! connect sequence and the reconnect handshake (goldens), statuses, password prompts, TLS prefer, browsing pages, the
//! watchdog and the end after the reconnect attempts.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use unimux_db::host::{DbHostLink, HostReport, Spawn, ToHost, UnavailableHost};
use unimux_db::redis::host::{RedisHost, RedisHostDeps};
use unimux_db::redis::session::RedisLimits;
use unimux_db::wire::redis::{Raw, RespReader, encode_command};
use zeroize::Zeroizing;

#[derive(Clone)]
enum Val {
    Str(Vec<u8>),
    Hash(Vec<(Vec<u8>, Vec<u8>)>),
    List(Vec<Vec<u8>>),
}

#[derive(Default)]
struct Data {
    keys: BTreeMap<(u32, Vec<u8>), Val>,
}

struct Server {
    port: u16,
    log: Arc<Mutex<Vec<String>>>,
    conns: Arc<Mutex<Vec<JoinHandle<()>>>>,
    accept: JoinHandle<()>,
    data: Arc<Mutex<Data>>,
}

impl Server {
    async fn start(password: Option<&str>) -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = Arc::new(Mutex::new(Vec::new()));
        let conns: Arc<Mutex<Vec<JoinHandle<()>>>> = Arc::default();
        let data: Arc<Mutex<Data>> = Arc::default();
        let password = password.map(str::to_owned);
        let (l, c, d) = (log.clone(), conns.clone(), data.clone());
        let accept = tokio::spawn(async move {
            loop {
                let Ok((sock, _)) = listener.accept().await else { return };
                let (l, d, pw) = (l.clone(), d.clone(), password.clone());
                c.lock().push(tokio::spawn(serve(sock, l, d, pw)));
            }
        });
        Server { port, log, conns, accept, data }
    }

    fn set(&self, db: u32, key: &[u8], v: Val) {
        self.data.lock().keys.insert((db, key.to_vec()), v);
    }

    fn log(&self) -> Vec<String> {
        self.log.lock().clone()
    }

    fn clear_log(&self) {
        self.log.lock().clear();
    }

    /// Drops every client connection (the server stays up).
    fn drop_all(&self) {
        for c in self.conns.lock().drain(..) {
            c.abort();
        }
    }

    /// Drops everything and stops listening.
    fn stop(&self) {
        self.accept.abort();
        self.drop_all();
    }
}

fn bulk(b: &[u8]) -> Vec<u8> {
    let mut out = format!("${}\r\n", b.len()).into_bytes();
    out.extend_from_slice(b);
    out.extend_from_slice(b"\r\n");
    out
}

fn arr(items: Vec<Vec<u8>>) -> Vec<u8> {
    let mut out = format!("*{}\r\n", items.len()).into_bytes();
    for i in items {
        out.extend(i);
    }
    out
}

fn int(n: i64) -> Vec<u8> {
    format!(":{n}\r\n").into_bytes()
}

fn type_name(v: Option<&Val>) -> &'static str {
    match v {
        None => "none",
        Some(Val::Str(_)) => "string",
        Some(Val::Hash(_)) => "hash",
        Some(Val::List(_)) => "list",
    }
}

async fn serve(mut sock: tokio::net::TcpStream, log: Arc<Mutex<Vec<String>>>, data: Arc<Mutex<Data>>, password: Option<String>) {
    let mut reader = RespReader::default();
    let mut buf = vec![0u8; 64 * 1024];
    let mut authed = password.is_none();
    let mut db = 0u32;
    // a hanging command: nothing more is answered on this connection
    let mut hung = false;
    loop {
        let Ok(n) = sock.read(&mut buf).await else { return };
        // a TLS hello (0x16) on this plain port: the connection closes
        if n == 0 || buf[0] == 0x16 {
            return;
        }
        reader.push(&buf[..n]);
        loop {
            // not RESP (a TLS hello): the connection closes, as a Redis server does
            let items = match reader.next_reply() {
                Ok(Some(Raw::Array(items))) => items,
                Ok(None) => break,
                _ => return,
            };
            let argv: Vec<Vec<u8>> = items.into_iter().map(|i| if let Raw::Bytes(b) = i { b } else { Vec::new() }).collect();
            log.lock().push(argv.iter().map(|a| String::from_utf8_lossy(a).into_owned()).collect::<Vec<_>>().join(" "));
            let name = String::from_utf8_lossy(&argv[0]).to_ascii_lowercase();
            let a = |i: usize| argv.get(i).cloned().unwrap_or_default();
            let s = |i: usize| String::from_utf8_lossy(&a(i)).into_owned();
            let out: Vec<u8> = if name == "auth" {
                match &password {
                    None => b"-ERR AUTH <password> called without any password configured for the default user.\r\n".to_vec(),
                    Some(pw) if s(argv.len() - 1) == *pw => {
                        authed = true;
                        b"+OK\r\n".to_vec()
                    }
                    Some(_) => b"-WRONGPASS invalid username-password pair or user is disabled.\r\n".to_vec(),
                }
            } else if !authed {
                b"-NOAUTH Authentication required.\r\n".to_vec()
            } else {
                let d = data.lock();
                let key = (db, a(1));
                let v = d.keys.get(&key);
                match name.as_str() {
                    "client" if s(1) == "list" => bulk(b"id=3 addr=127.0.0.1:5000 name=unimux db=0\n"),
                    "client" | "select" if name == "client" => b"+OK\r\n".to_vec(),
                    "ping" => b"+PONG\r\n".to_vec(),
                    "select" => match s(1).parse::<u32>() {
                        Ok(n) if n < 16 => {
                            db = n;
                            b"+OK\r\n".to_vec()
                        }
                        _ => b"-ERR DB index is out of range\r\n".to_vec(),
                    },
                    "info" if s(1) == "keyspace" => bulk(b"# Keyspace\r\ndb0:keys=4,expires=0,avg_ttl=0\r\n"),
                    "info" => bulk(b"# Server\r\nredis_version:7.2.9\r\n"),
                    "config" => arr(vec![bulk(b"databases"), bulk(b"16")]),
                    "scan" => {
                        let keys: Vec<Vec<u8>> = d.keys.keys().filter(|(k, _)| *k == db).map(|(_, k)| bulk(k)).collect();
                        arr(vec![bulk(b"0"), arr(keys)])
                    }
                    "type" if a(1) == b"hang" => {
                        hung = true;
                        Vec::new()
                    }
                    "type" => format!("+{}\r\n", type_name(v)).into_bytes(),
                    "pttl" => int(if v.is_some() { -1 } else { -2 }),
                    "memory" => int(100),
                    "strlen" => match v {
                        Some(Val::Str(b)) => int(b.len() as i64),
                        _ => int(0),
                    },
                    "getrange" => match v {
                        Some(Val::Str(b)) => {
                            let from = s(2).parse::<usize>().unwrap();
                            let to = (s(3).parse::<usize>().unwrap() + 1).min(b.len());
                            bulk(&b[from.min(to)..to])
                        }
                        _ => bulk(b""),
                    },
                    "hlen" => match v {
                        Some(Val::Hash(h)) => int(h.len() as i64),
                        _ => int(0),
                    },
                    "hscan" => match v {
                        Some(Val::Hash(h)) => {
                            arr(vec![bulk(b"0"), arr(h.iter().flat_map(|(f, x)| [bulk(f), bulk(x)]).collect())])
                        }
                        _ => arr(vec![bulk(b"0"), arr(vec![])]),
                    },
                    "llen" => match v {
                        Some(Val::List(l)) => int(l.len() as i64),
                        _ => int(0),
                    },
                    "lrange" => match v {
                        Some(Val::List(l)) => {
                            let from = s(2).parse::<usize>().unwrap().min(l.len());
                            let to = (s(3).parse::<usize>().unwrap() + 1).min(l.len());
                            arr(l[from..to.max(from)].iter().map(|x| bulk(x)).collect())
                        }
                        _ => arr(vec![]),
                    },
                    "lindex" => match v {
                        Some(Val::List(l)) => l.get(s(2).parse::<usize>().unwrap()).map_or(b"$-1\r\n".to_vec(), |x| bulk(x)),
                        _ => b"$-1\r\n".to_vec(),
                    },
                    _ => b"-ERR unknown command\r\n".to_vec(),
                }
            };
            if hung {
                continue;
            }
            if sock.write_all(&out).await.is_err() {
                return;
            }
        }
    }
}

struct Harness {
    host: Arc<RedisHost>,
    main: Arc<Mutex<Vec<Value>>>,
    /// The answer to every password prompt in turn (none left: no answer).
    answers: Arc<Mutex<Vec<Option<String>>>>,
}

fn harness(limits: RedisLimits) -> Harness {
    let spawn: Spawn = Arc::new(|f| {
        tokio::spawn(f);
    });
    let next = UnavailableHost::new(spawn.clone());
    let host = RedisHost::new(RedisHostDeps {
        next,
        spawn,
        tunnels: None,
        connect_ms: 3000,
        limits,
        now: Arc::new(unimux_core::time::now_ms),
    });
    let main: Arc<Mutex<Vec<Value>>> = Arc::default();
    let answers: Arc<Mutex<Vec<Option<String>>>> = Arc::default();
    let (m, a, w) = (main.clone(), answers.clone(), Arc::downgrade(&host));
    let report: HostReport = Arc::new(move |msg: Value| {
        m.lock().push(msg.clone());
        if msg["t"] == "dbPasswordPrompt" {
            let next = {
                let mut a = a.lock();
                if a.is_empty() { None } else { Some(a.remove(0)) }
            };
            if let (Some(answer), Some(h)) = (next, w.upgrade()) {
                h.send(ToHost::PasswordAnswer {
                    id: msg["id"].as_str().unwrap().to_owned(),
                    prompt_id: msg["promptId"].as_str().unwrap().to_owned(),
                    value: answer.map(Zeroizing::new),
                });
            }
        }
    });
    host.connect(report);
    Harness { host, main, answers }
}

fn config(port: u16, extra: Value) -> Value {
    let mut c = json!({ "kind": "redis", "host": "127.0.0.1", "port": port, "user": "", "database": "0", "tls": "disable", "readOnly": false, "ssh": null });
    for (k, v) in extra.as_object().unwrap() {
        c[k] = v.clone();
    }
    c
}

impl Harness {
    fn statuses(&self, id: &str) -> Vec<Value> {
        self.main.lock().iter().filter(|m| m["t"] == "dbStatus" && m["id"] == id).cloned().collect()
    }

    fn last(&self, id: &str) -> Value {
        self.statuses(id).last().cloned().unwrap_or(Value::Null)
    }

    async fn wait(&self, what: impl Fn(&[Value]) -> bool) {
        for _ in 0..1000 {
            if what(&self.main.lock()) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("timed out: {:#?}", self.main.lock());
    }

    /// Opens a session and waits until it is connected or ended.
    async fn open(&self, id: &str, config: Value) {
        let from = self.main.lock().len();
        self.host.send(ToHost::Open { id: id.into(), config });
        let id = id.to_owned();
        self.wait(|m| {
            m[from..].iter().any(|x| {
                x["t"] == "dbStatus"
                    && x["id"] == id.as_str()
                    && ["connected", "error", "closed"].contains(&x["phase"].as_str().unwrap())
            })
        })
        .await;
    }

    fn op(&self, id: &str, req: Value) -> BoxFuture<'static, Value> {
        self.host.request(id, json!({ "op": "redis", "req": req }), None)
    }

    async fn ok(&self, id: &str, req: Value) -> Value {
        let r = self.op(id, req.clone()).await;
        assert_eq!(r["ok"], true, "{req} -> {r}");
        r["value"].clone()
    }
}

const ID: &str = "db:00000000-0000-4000-8000-000000000001";

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connects_with_the_1_1_4_sequence_and_reconnects_with_the_ioredis_handshake() {
    let s = Server::start(Some("pw")).await;
    let h = harness(RedisLimits::default());
    h.open(ID, config(s.port, json!({ "password": "pw", "database": "3" }))).await;
    let phases: Vec<Value> = h.statuses(ID).iter().map(|m| m["phase"].clone()).collect();
    assert_eq!(phases, ["connecting", "database", "connected"]);
    assert_eq!(
        h.last(ID),
        json!({ "t": "dbStatus", "id": ID, "phase": "connected", "serverVersion": "7.2.9", "database": "3", "tls": false })
    );
    // golden: the connect sequence of 1.1.4 (ioredis handshake, then openRedis's ping / select / info server)
    assert_eq!(s.log(), ["auth pw", "client setname unimux", "ping", "select 3", "info server"]);

    let list = h.ok(ID, json!({ "kind": "databases" })).await;
    assert_eq!(list, json!({ "count": 16, "current": 3, "dbs": [{ "index": 0, "keys": 4, "expires": 0, "avgTtlMs": 0 }] }));
    assert_eq!(h.ok(ID, json!({ "kind": "select", "index": 2 })).await, json!(2));
    assert!(h.main.lock().iter().any(|m| *m == json!({ "t": "dbDatabase", "id": ID, "database": "2" })));
    let r = h.op(ID, json!({ "kind": "select", "index": 99 })).await;
    assert_eq!(r["error"], "dbNoDatabase");
    assert_eq!(r["server"], json!({ "message": "ERR DB index is out of range", "code": "ERR" }));
    // A Postgres operation on a Redis session is refused.
    assert_eq!(h.host.request(ID, json!({ "op": "schemas" }), None).await, json!({ "ok": false, "error": "invalid" }));

    // a drop: reported as reconnecting, then connected again on the DB the session had selected
    s.clear_log();
    s.drop_all();
    h.wait(|m| m.iter().filter(|x| x["phase"] == "connected").count() == 2).await;
    let st = h.statuses(ID);
    assert_eq!(st[st.len() - 2], json!({ "t": "dbStatus", "id": ID, "phase": "database", "reconnect": 1 }));
    assert_eq!(st[st.len() - 1], json!({ "t": "dbStatus", "id": ID, "phase": "connected", "database": "2" }));
    // golden: the reconnect handshake (auth, client setname) and the select of the dropped connection's DB
    for _ in 0..100 {
        if s.log().len() >= 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(s.log(), ["auth pw", "client setname unimux", "select 2"]);
    assert_eq!(h.ok(ID, json!({ "kind": "databases" })).await["current"], 2);

    // the server stays away: three attempts, then the session ends (dbClosed)
    s.stop();
    h.wait(|m| m.iter().any(|x| x["phase"] == "error")).await;
    let reconnects: Vec<Value> = h.statuses(ID).iter().filter_map(|m| m.get("reconnect").cloned()).collect();
    assert_eq!(reconnects, [json!(1), json!(1), json!(2), json!(3)]);
    assert_eq!(h.last(ID), json!({ "t": "dbStatus", "id": ID, "phase": "error", "error": "dbClosed" }));
    assert_eq!(h.op(ID, json!({ "kind": "databases" })).await, json!({ "ok": false, "error": "noSession" }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn passwords_are_asked_for_and_failures_mapped() {
    let s = Server::start(Some("sekret")).await;
    let h = harness(RedisLimits::default());
    h.answers.lock().extend([Some("wrong".to_owned()), Some("sekret".to_owned())]);
    h.open(ID, config(s.port, json!({}))).await;
    assert_eq!(h.last(ID)["phase"], "connected");
    let retries: Vec<Value> = h.main.lock().iter().filter(|m| m["t"] == "dbPasswordPrompt").map(|m| m["retry"].clone()).collect();
    assert_eq!(retries, [json!(false), json!(true)]);

    // an ACL user without a saved password is asked first; a cancelled prompt ends the session
    let h = harness(RedisLimits::default());
    h.answers.lock().push(None);
    let id2 = "db:00000000-0000-4000-8000-000000000002";
    h.open(id2, config(s.port, json!({ "user": "alice" }))).await;
    assert_eq!(h.last(id2), json!({ "t": "dbStatus", "id": id2, "phase": "error", "error": "cancelled" }));
    assert!(!s.log().iter().any(|l| l.starts_with("auth alice")));

    // a missing DB index, TLS to a plain port, prefer falling back to plain, refused
    let plain = Server::start(None).await;
    let h = harness(RedisLimits::default());
    h.open(ID, config(plain.port, json!({ "database": "20" }))).await;
    assert_eq!(h.last(ID)["error"], "dbNoDatabase");
    assert_eq!(h.last(ID)["message"], "ERR DB index is out of range");
    h.open(ID, config(plain.port, json!({ "tls": "require" }))).await;
    let e = h.last(ID)["error"].as_str().unwrap().to_owned();
    assert!(e == "dbTls" || e == "dbClosed", "{e}");
    h.open(ID, config(plain.port, json!({ "tls": "prefer", "password": "unneeded" }))).await;
    assert_eq!(h.last(ID)["phase"], "connected");
    assert_eq!(h.last(ID)["tls"], false);
    h.host.send(ToHost::Close { id: ID.into() });
    assert_eq!(h.last(ID)["phase"], "closed");
    plain.stop();
    h.open(ID, config(plain.port, json!({}))).await;
    assert_eq!(h.last(ID)["error"], "dbRefused");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn browses_keys_and_values_in_pages() {
    let s = Server::start(None).await;
    s.set(0, b"s", Val::Str("hello w\u{f6}rld".as_bytes().to_vec()));
    s.set(0, b"h", Val::Hash(vec![(b"f1".to_vec(), b"v1".to_vec()), (b"f2".to_vec(), vec![0xff, 0x00])]));
    s.set(0, b"l", Val::List((0..5).map(|i| format!("item{i}").into_bytes()).collect()));
    s.set(0, &[0xfe], Val::Str(b"x".to_vec()));
    let h = harness(RedisLimits::default());
    h.open(ID, config(s.port, json!({}))).await;

    let page = h.ok(ID, json!({ "kind": "scan", "req": { "cursor": "0", "details": true } })).await;
    assert_eq!(page["cursor"], "0");
    assert_eq!(
        page["keys"],
        json!([
            { "key": "h", "type": "hash", "ttlMs": null, "length": 2, "memory": 100 },
            { "key": "l", "type": "list", "ttlMs": null, "length": 5, "memory": 100 },
            { "key": "s", "type": "string", "ttlMs": null, "length": 12, "memory": 100 },
            { "key": { "b64": "/g==" }, "type": "string", "ttlMs": null, "length": 1, "memory": 100 },
        ])
    );
    let plain = h.ok(ID, json!({ "kind": "scan", "req": { "cursor": "0" } })).await;
    assert_eq!(plain["keys"][0], json!({ "key": "h" }));

    // a string page cut inside a UTF-8 character moves back to its start
    let r = h.ok(ID, json!({ "kind": "read", "req": { "type": "string", "key": "s", "maxBytes": 8 } })).await;
    assert_eq!(
        r,
        json!({ "type": "string", "ttlMs": null, "length": 12, "offset": 0, "pageBytes": 7,
                "value": { "data": "hello w", "bytes": 12, "truncated": true } })
    );
    let r = h.ok(ID, json!({ "kind": "read", "req": { "type": "string", "key": "s", "offset": 7 } })).await;
    assert_eq!(r["value"], json!({ "data": "\u{f6}rld", "bytes": 12 }));
    let r = h.ok(ID, json!({ "kind": "read", "req": { "type": "hash", "key": "h", "cursor": "0", "count": 10 } })).await;
    assert_eq!(
        r,
        json!({ "type": "hash", "ttlMs": null, "length": 2, "cursor": "0", "entries": [
            { "field": "f1", "value": { "data": "v1", "bytes": 2 } },
            { "field": "f2", "value": { "data": { "b64": "/wA=" }, "bytes": 2 } },
        ] })
    );
    let r = h.ok(ID, json!({ "kind": "read", "req": { "type": "list", "key": "l", "start": 1, "count": 2 } })).await;
    assert_eq!(r["items"], json!([{ "data": "item1", "bytes": 5 }, { "data": "item2", "bytes": 5 }]));
    assert_eq!(r["start"], 1);
    let item = h.ok(ID, json!({ "kind": "readItem", "req": { "type": "list", "key": "l", "index": 4 } })).await;
    assert_eq!(item, json!({ "data": "item4", "bytes": 5 }));
    let missing = h.op(ID, json!({ "kind": "readItem", "req": { "type": "list", "key": "l", "index": 9 } })).await;
    assert_eq!(missing, json!({ "ok": false, "error": "notFound" }));
    let wrong = h.op(ID, json!({ "kind": "read", "req": { "type": "hash", "key": "s", "cursor": "0", "count": 1 } })).await;
    assert_eq!(wrong["error"], "wrongType");
    let none = h.op(ID, json!({ "kind": "read", "req": { "type": "string", "key": "nope" } })).await;
    assert_eq!(none["error"], "notFound");
    let clients = h.ok(ID, json!({ "kind": "clients" })).await;
    assert_eq!(clients[0]["name"], "unimux");
    let info = h.ok(ID, json!({ "kind": "info", "section": "server" })).await;
    assert_eq!(info, json!([{ "name": "Server", "entries": [["redis_version", "7.2.9"]] }]));
    // an unknown write is refused
    assert_eq!(h.op(ID, json!({ "kind": "write", "write": {} })).await["error"], "invalid");
    assert_eq!(h.ok(ID, json!({ "kind": "cancel" })).await, json!(false));
    // activity went busy and idle again
    let act: Vec<Value> = h.main.lock().iter().filter(|m| m["t"] == "dbActivity").map(|m| m["busy"].clone()).collect();
    assert!(act.len() >= 2 && act[0] == true && *act.last().unwrap() == false, "{act:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_hanging_browse_operation_drops_and_reconnects_the_connection() {
    let s = Server::start(None).await;
    s.set(0, b"hang", Val::Str(b"x".to_vec()));
    let h = harness(RedisLimits { op_timeout_ms: 300, ..RedisLimits::default() });
    h.open(ID, config(s.port, json!({}))).await;
    let r = h.op(ID, json!({ "kind": "read", "req": { "type": "string", "key": "hang" } })).await;
    assert_eq!(r, json!({ "ok": false, "error": "dbTimeout" }));
    h.wait(|m| m.iter().filter(|x| x["phase"] == "connected").count() == 2).await;
    assert!(h.statuses(ID).iter().any(|m| m["reconnect"] == 1));
    // a deadline already past skips the operation
    let r = h.host.request(ID, json!({ "op": "redis", "req": { "kind": "databases" }, "deadline": 1 }), None).await;
    assert_eq!(r["ok"], true, "with_deadline sets main's own deadline: {r}");
    assert_eq!(h.ok(ID, json!({ "kind": "databases" })).await["count"], 16);
    h.host.shutdown();
    assert_eq!(h.last(ID)["phase"], "closed");
    assert_eq!(h.host.session_count(), 0);
}

#[test]
fn commands_are_lower_case_like_ioredis() {
    assert_eq!(encode_command(&[b"client", b"setname", b"unimux"]), b"*3\r\n$6\r\nclient\r\n$7\r\nsetname\r\n$6\r\nunimux\r\n");
}
