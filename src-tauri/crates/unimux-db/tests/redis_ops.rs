//! D10: Redis writes, the console, pattern counts / deletes and Pub/Sub against an in-process RESP server (the shape of
//! test/db-redis.int.test.ts and test/db-redis-safety.int.test.ts): WATCH / MULTI / EXEC writes and their conflicts, the
//! KEEPTTL fallback, read-only refusals, console classification and replies, the statement timeout, one-time pattern
//! tokens, subscriber messages in batches over the DB port.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use unimux_db::host::{DbHostLink, HostReport, Spawn, ToHost, UnavailableHost};
use unimux_db::redis::host::{RedisHost, RedisHostDeps};
use unimux_db::redis::session::RedisLimits;
use unimux_db::wire::redis::{Raw, RespReader};

#[derive(Clone, Debug)]
enum Val {
    Str(Vec<u8>),
    Hash(Vec<(Vec<u8>, Vec<u8>)>),
    List(Vec<Vec<u8>>),
    Set(Vec<Vec<u8>>),
}

type Key = (u32, Vec<u8>);

struct Sub {
    id: u64,
    tx: mpsc::UnboundedSender<Vec<u8>>,
    channels: HashSet<Vec<u8>>,
    patterns: HashSet<Vec<u8>>,
}

#[derive(Default)]
struct Shared {
    keys: HashMap<Key, (Val, Option<i64>)>,
    versions: HashMap<Key, u64>,
    subs: Vec<Sub>,
    /// A Redis before 6: SET ... KEEPTTL is a syntax error.
    no_keepttl: bool,
    log: Vec<String>,
}

impl Shared {
    fn touch(&mut self, k: &Key) {
        *self.versions.entry(k.clone()).or_default() += 1;
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

const OK: &[u8] = b"+OK\r\n";
const NIL: &[u8] = b"$-1\r\n";

fn glob(p: &[u8], s: &[u8]) -> bool {
    match (p.first(), s.first()) {
        (None, None) => true,
        (Some(b'*'), _) => glob(&p[1..], s) || (!s.is_empty() && glob(p, &s[1..])),
        (Some(b'?'), Some(_)) => glob(&p[1..], &s[1..]),
        (Some(a), Some(b)) if a == b => glob(&p[1..], &s[1..]),
        _ => false,
    }
}

fn type_name(v: Option<&(Val, Option<i64>)>) -> &'static str {
    match v.map(|x| &x.0) {
        None => "none",
        Some(Val::Str(_)) => "string",
        Some(Val::Hash(_)) => "hash",
        Some(Val::List(_)) => "list",
        Some(Val::Set(_)) => "set",
    }
}

const WRONGTYPE: &[u8] = b"-WRONGTYPE Operation against a key holding the wrong kind of value\r\n";

/// One command on the data (also inside EXEC).
fn run(sh: &mut Shared, db: u32, argv: &[Vec<u8>]) -> Vec<u8> {
    let name = String::from_utf8_lossy(&argv[0]).to_ascii_lowercase();
    let a = |i: usize| argv.get(i).cloned().unwrap_or_default();
    let s = |i: usize| String::from_utf8_lossy(&a(i)).into_owned();
    let key: Key = (db, a(1));
    let now = unimux_core::time::now_ms();
    match name.as_str() {
        "type" => format!("+{}\r\n", type_name(sh.keys.get(&key))).into_bytes(),
        "pttl" => int(match sh.keys.get(&key) {
            None => -2,
            Some((_, None)) => -1,
            Some((_, Some(at))) => (at - now).max(0),
        }),
        "exists" => int(argv[1..].iter().filter(|k| sh.keys.contains_key(&(db, k.to_vec()))).count() as i64),
        "pexpire" => match sh.keys.get_mut(&key) {
            Some(v) => {
                v.1 = Some(now + s(2).parse::<i64>().unwrap());
                sh.touch(&key);
                int(1)
            }
            None => int(0),
        },
        "persist" => match sh.keys.get_mut(&key) {
            Some(v) if v.1.is_some() => {
                v.1 = None;
                int(1)
            }
            _ => int(0),
        },
        "strlen" => match sh.keys.get(&key) {
            Some((Val::Str(b), _)) => int(b.len() as i64),
            _ => int(0),
        },
        "get" => match sh.keys.get(&key) {
            Some((Val::Str(b), _)) => bulk(b),
            Some(_) => WRONGTYPE.to_vec(),
            None => NIL.to_vec(),
        },
        "set" => {
            let mut ttl = None;
            let mut keep = false;
            let mut i = 3;
            while i < argv.len() {
                match s(i).to_ascii_uppercase().as_str() {
                    "PX" => {
                        ttl = Some(now + s(i + 1).parse::<i64>().unwrap());
                        i += 1;
                    }
                    "KEEPTTL" => keep = true,
                    _ => return b"-ERR syntax error\r\n".to_vec(),
                }
                i += 1;
            }
            let old = sh.keys.get(&key).and_then(|v| v.1);
            sh.keys.insert(key.clone(), (Val::Str(a(2)), if keep { old } else { ttl }));
            sh.touch(&key);
            OK.to_vec()
        }
        "hset" | "hsetnx" => {
            let e = sh.keys.entry(key.clone()).or_insert((Val::Hash(Vec::new()), None));
            let Val::Hash(h) = &mut e.0 else { return WRONGTYPE.to_vec() };
            let mut added = 0;
            for p in argv[2..].chunks(2) {
                match h.iter_mut().find(|(f, _)| *f == p[0]) {
                    Some(_) if name == "hsetnx" => {}
                    Some(x) => x.1 = p[1].clone(),
                    None => {
                        h.push((p[0].clone(), p[1].clone()));
                        added += 1;
                    }
                }
            }
            sh.touch(&key);
            int(added)
        }
        "hdel" => match sh.keys.get_mut(&key) {
            Some((Val::Hash(h), _)) => {
                let before = h.len();
                h.retain(|(f, _)| !argv[2..].contains(f));
                let n = (before - h.len()) as i64;
                sh.touch(&key);
                int(n)
            }
            _ => int(0),
        },
        "hlen" => match sh.keys.get(&key) {
            Some((Val::Hash(h), _)) => int(h.len() as i64),
            _ => int(0),
        },
        "rpush" | "lpush" => {
            let e = sh.keys.entry(key.clone()).or_insert((Val::List(Vec::new()), None));
            let Val::List(l) = &mut e.0 else { return WRONGTYPE.to_vec() };
            for x in &argv[2..] {
                if name == "rpush" { l.push(x.clone()) } else { l.insert(0, x.clone()) }
            }
            let n = l.len() as i64;
            sh.touch(&key);
            int(n)
        }
        "lindex" => match sh.keys.get(&key) {
            Some((Val::List(l), _)) => l.get(s(2).parse::<usize>().unwrap()).map_or(NIL.to_vec(), |x| bulk(x)),
            _ => NIL.to_vec(),
        },
        "lset" => match sh.keys.get_mut(&key) {
            Some((Val::List(l), _)) => match l.get_mut(s(2).parse::<usize>().unwrap()) {
                Some(x) => {
                    *x = a(3);
                    sh.touch(&key);
                    OK.to_vec()
                }
                None => b"-ERR index out of range\r\n".to_vec(),
            },
            _ => b"-ERR no such key\r\n".to_vec(),
        },
        "lrem" => match sh.keys.get_mut(&key) {
            Some((Val::List(l), _)) => {
                let want = a(3);
                let mut left = s(2).parse::<i64>().unwrap();
                let before = l.len();
                l.retain(|x| {
                    if *x == want && left != 0 {
                        left -= 1;
                        false
                    } else {
                        true
                    }
                });
                let n = (before - l.len()) as i64;
                sh.touch(&key);
                int(n)
            }
            _ => int(0),
        },
        "llen" => match sh.keys.get(&key) {
            Some((Val::List(l), _)) => int(l.len() as i64),
            _ => int(0),
        },
        "sadd" => {
            let e = sh.keys.entry(key.clone()).or_insert((Val::Set(Vec::new()), None));
            let Val::Set(set) = &mut e.0 else { return WRONGTYPE.to_vec() };
            let mut n = 0;
            for m in &argv[2..] {
                if !set.contains(m) {
                    set.push(m.clone());
                    n += 1;
                }
            }
            sh.touch(&key);
            int(n)
        }
        "scard" => match sh.keys.get(&key) {
            Some((Val::Set(x), _)) => int(x.len() as i64),
            _ => int(0),
        },
        "del" | "unlink" => {
            let mut n = 0;
            for k in &argv[1..] {
                let k = (db, k.clone());
                if sh.keys.remove(&k).is_some() {
                    sh.touch(&k);
                    n += 1;
                }
            }
            int(n)
        }
        "rename" | "renamenx" => {
            let to: Key = (db, a(2));
            if !sh.keys.contains_key(&key) {
                return b"-ERR no such key\r\n".to_vec();
            }
            if name == "renamenx" && sh.keys.contains_key(&to) {
                return int(0);
            }
            let v = sh.keys.remove(&key).unwrap();
            sh.keys.insert(to.clone(), v);
            sh.touch(&key);
            sh.touch(&to);
            if name == "rename" { OK.to_vec() } else { int(1) }
        }
        "scan" => {
            let mut pattern = None;
            let mut ty = None;
            let mut i = 2;
            while i + 1 < argv.len() {
                match s(i).to_ascii_uppercase().as_str() {
                    "MATCH" => pattern = Some(a(i + 1)),
                    "TYPE" => ty = Some(s(i + 1)),
                    _ => {}
                }
                i += 2;
            }
            let mut keys: Vec<&Key> = sh
                .keys
                .iter()
                .filter(|(k, v)| {
                    k.0 == db
                        && pattern.as_ref().is_none_or(|p| glob(p, &k.1))
                        && ty.as_ref().is_none_or(|t| type_name(Some(v)) == t)
                })
                .map(|(k, _)| k)
                .collect();
            keys.sort();
            arr(vec![bulk(b"0"), arr(keys.into_iter().map(|k| bulk(&k.1)).collect())])
        }
        "memory" => int(10),
        "publish" => {
            let ch = a(1);
            let msg = a(2);
            let mut n = 0;
            for sub in &sh.subs {
                if sub.channels.contains(&ch) {
                    let _ = sub.tx.send(arr(vec![bulk(b"message"), bulk(&ch), bulk(&msg)]));
                    n += 1;
                }
                for p in &sub.patterns {
                    if glob(p, &ch) {
                        let _ = sub.tx.send(arr(vec![bulk(b"pmessage"), bulk(p), bulk(&ch), bulk(&msg)]));
                        n += 1;
                    }
                }
            }
            int(n)
        }
        "command" => {
            let entry = |n: &str, flags: &[&str], cats: &[&str]| {
                arr(vec![
                    bulk(n.as_bytes()),
                    int(-1),
                    arr(flags.iter().map(|f| format!("+{f}\r\n").into_bytes()).collect()),
                    int(1),
                    int(1),
                    int(1),
                    arr(cats.iter().map(|c| format!("+{c}\r\n").into_bytes()).collect()),
                ])
            };
            match s(2).as_str() {
                "get" => arr(vec![entry("get", &["readonly", "fast"], &["@read", "@string", "@fast"])]),
                "set" => arr(vec![entry("set", &["write", "denyoom"], &["@write", "@string", "@slow"])]),
                "renamed-flush" => arr(vec![entry("renamed-flush", &["write"], &["@keyspace", "@write", "@dangerous"])]),
                _ => arr(vec![b"*-1\r\n".to_vec()]),
            }
        }
        _ => format!("-ERR unknown command '{name}'\r\n").into_bytes(),
    }
}

static NEXT_SUB: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

async fn serve(mut sock: tokio::net::TcpStream, sh: Arc<Mutex<Shared>>) {
    let mut reader = RespReader::default();
    let mut buf = vec![0u8; 64 * 1024];
    let mut db = 0u32;
    let mut watched: HashMap<Key, u64> = HashMap::new();
    let mut queue: Option<Vec<Vec<Vec<u8>>>> = None;
    let mut dirty = false;
    let me = NEXT_SUB.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let mut hung = false;
    loop {
        let n = tokio::select! {
            n = sock.read(&mut buf) => match n { Ok(n) if n > 0 => n, _ => break },
            Some(push) = rx.recv() => {
                if sock.write_all(&push).await.is_err() { break }
                continue;
            }
        };
        reader.push(&buf[..n]);
        while let Ok(Some(Raw::Array(items))) = reader.next_reply() {
            let argv: Vec<Vec<u8>> = items.into_iter().map(|i| if let Raw::Bytes(b) = i { b } else { Vec::new() }).collect();
            let name = String::from_utf8_lossy(&argv[0]).to_ascii_lowercase();
            let out: Vec<u8> = {
                let mut sh = sh.lock();
                sh.log.push(argv.iter().map(|a| String::from_utf8_lossy(a).into_owned()).collect::<Vec<_>>().join(" "));
                match name.as_str() {
                    "hangme" => {
                        hung = true;
                        Vec::new()
                    }
                    "auth" => b"-ERR AUTH <password> called without any password configured for the default user.\r\n".to_vec(),
                    "client" => OK.to_vec(),
                    "ping" => b"+PONG\r\n".to_vec(),
                    "info" => bulk(b"# Server\r\nredis_version:7.2.9\r\n"),
                    "select" => match String::from_utf8_lossy(&argv[1]).parse::<u32>() {
                        Ok(n) if n < 16 => {
                            db = n;
                            OK.to_vec()
                        }
                        _ => b"-ERR DB index is out of range\r\n".to_vec(),
                    },
                    "watch" => {
                        for k in &argv[1..] {
                            let key = (db, k.clone());
                            if k == b"racy" {
                                // another client changes the key right after the WATCH
                                sh.touch(&key);
                                let v = sh.versions[&key];
                                watched.insert(key, v - 1);
                            } else {
                                let v = sh.versions.get(&key).copied().unwrap_or(0);
                                watched.insert(key, v);
                            }
                        }
                        OK.to_vec()
                    }
                    "unwatch" => {
                        watched.clear();
                        OK.to_vec()
                    }
                    "multi" => {
                        queue = Some(Vec::new());
                        dirty = false;
                        OK.to_vec()
                    }
                    "discard" => {
                        queue = None;
                        watched.clear();
                        OK.to_vec()
                    }
                    "exec" => {
                        let q = queue.take().unwrap_or_default();
                        let changed = watched.iter().any(|(k, v)| sh.versions.get(k).copied().unwrap_or(0) != *v);
                        watched.clear();
                        if dirty {
                            b"-EXECABORT Transaction discarded because of previous errors.\r\n".to_vec()
                        } else if changed {
                            b"*-1\r\n".to_vec()
                        } else {
                            arr(q.iter().map(|c| run(&mut sh, db, c)).collect())
                        }
                    }
                    "subscribe" | "psubscribe" | "unsubscribe" | "punsubscribe" => {
                        if !sh.subs.iter().any(|s| s.id == me) {
                            sh.subs.push(Sub { id: me, tx: tx.clone(), channels: HashSet::new(), patterns: HashSet::new() });
                        }
                        let sub = sh.subs.iter_mut().find(|s| s.id == me).unwrap();
                        let mut out = Vec::new();
                        for x in &argv[1..] {
                            match name.as_str() {
                                "subscribe" => sub.channels.insert(x.clone()),
                                "psubscribe" => sub.patterns.insert(x.clone()),
                                "unsubscribe" => sub.channels.remove(x),
                                _ => sub.patterns.remove(x),
                            };
                            let n = (sub.channels.len() + sub.patterns.len()) as i64;
                            out.extend(arr(vec![bulk(name.as_bytes()), bulk(x), int(n)]));
                        }
                        out
                    }
                    _ if queue.is_some() => {
                        if sh.no_keepttl && name == "set" && argv.iter().any(|x| x.eq_ignore_ascii_case(b"KEEPTTL")) {
                            dirty = true;
                            b"-ERR syntax error\r\n".to_vec()
                        } else {
                            queue.as_mut().unwrap().push(argv.clone());
                            b"+QUEUED\r\n".to_vec()
                        }
                    }
                    _ => run(&mut sh, db, &argv),
                }
            };
            if hung {
                continue;
            }
            if sock.write_all(&out).await.is_err() {
                break;
            }
        }
    }
    sh.lock().subs.retain(|s| s.id != me);
}

struct Server {
    port: u16,
    sh: Arc<Mutex<Shared>>,
}

impl Server {
    async fn start() -> Server {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let sh: Arc<Mutex<Shared>> = Arc::default();
        let s = sh.clone();
        tokio::spawn(async move {
            loop {
                let Ok((sock, _)) = listener.accept().await else { return };
                tokio::spawn(serve(sock, s.clone()));
            }
        });
        Server { port, sh }
    }

    fn set(&self, key: &[u8], v: Val) {
        let k = (0, key.to_vec());
        let mut sh = self.sh.lock();
        sh.keys.insert(k.clone(), (v, None));
        sh.touch(&k);
    }

    fn get(&self, key: &[u8]) -> Option<(Val, Option<i64>)> {
        self.sh.lock().keys.get(&(0, key.to_vec())).cloned()
    }
}

struct Harness {
    host: Arc<RedisHost>,
    main: Arc<Mutex<Vec<Value>>>,
    port: Arc<Mutex<Vec<Value>>>,
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
    let port: Arc<Mutex<Vec<Value>>> = Arc::default();
    let m = main.clone();
    let report: HostReport = Arc::new(move |msg: Value| m.lock().push(msg));
    host.connect(report);
    let p = port.clone();
    host.connect_port(Arc::new(move |msg: Value| p.lock().push(msg)));
    Harness { host, main, port }
}

const ID: &str = "db:00000000-0000-4000-8000-0000000000aa";

impl Harness {
    async fn open(&self, port: u16, read_only: bool) {
        let config = json!({ "kind": "redis", "host": "127.0.0.1", "port": port, "user": "", "database": "0", "tls": "disable", "readOnly": read_only, "ssh": null });
        self.host.send(ToHost::Open { id: ID.into(), config });
        for _ in 0..500 {
            if self.main.lock().iter().any(|m| m["t"] == "dbStatus" && m["phase"] == "connected") {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("not connected: {:?}", self.main.lock());
    }

    fn op(&self, req: Value) -> BoxFuture<'static, Value> {
        self.host.request(ID, json!({ "op": "redis", "req": req }), None)
    }

    async fn ok(&self, req: Value) -> Value {
        let r = self.op(req.clone()).await;
        assert_eq!(r["ok"], true, "{req} -> {r}");
        r["value"].clone()
    }

    async fn write(&self, w: Value) -> Value {
        self.op(json!({ "kind": "write", "write": w })).await
    }

    async fn cmd(&self, argv: Value, extra: Value) -> Value {
        let mut req = json!({ "argv": argv });
        for (k, v) in extra.as_object().unwrap() {
            req[k] = v.clone();
        }
        self.op(json!({ "kind": "command", "req": req })).await
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn writes_run_under_watch_and_report_conflicts() {
    let s = Server::start().await;
    let h = harness(RedisLimits::default());
    h.open(s.port, false).await;

    // set: KEEPTTL keeps the TTL; an edit of a key that is gone meanwhile does not create it again
    s.set(b"s", Val::Str(b"a".to_vec()));
    s.sh.lock().keys.get_mut(&(0, b"s".to_vec())).unwrap().1 = Some(unimux_core::time::now_ms() + 60_000);
    assert_eq!(
        h.write(json!({ "op": "set", "key": "s", "value": "b", "existing": true })).await,
        json!({ "ok": true, "value": { "changed": 1 } })
    );
    let (v, ttl) = s.get(b"s").unwrap();
    assert!(matches!(v, Val::Str(ref b) if b == b"b") && ttl.is_some());
    assert_eq!(h.write(json!({ "op": "set", "key": "gone", "value": "x", "existing": true })).await["error"], "notFound");
    assert!(s.get(b"gone").is_none());
    assert_eq!(h.write(json!({ "op": "set", "key": "s", "value": "c", "keepTtl": false })).await["ok"], true);
    assert!(s.get(b"s").unwrap().1.is_none());
    // the key changed between WATCH and EXEC
    s.set(b"racy", Val::Str(b"1".to_vec()));
    assert_eq!(h.write(json!({ "op": "set", "key": "racy", "value": "2" })).await, json!({ "ok": false, "error": "conflict" }));
    // a hash write on a string key
    assert_eq!(
        h.write(json!({ "op": "hset", "key": "s", "field": "f", "value": "v", "existing": true })).await["error"],
        "wrongType"
    );

    // create: once; a second create of the same key is keyExists
    let create = json!({ "op": "create", "key": "h", "value": { "type": "hash", "entries": [["f1", "v1"], [{ "b64": "/w==" }, "v2"]] }, "ttlMs": 5000 });
    assert_eq!(h.write(create.clone()).await, json!({ "ok": true, "value": { "changed": 1 } }));
    assert_eq!(h.write(create).await["error"], "keyExists");
    match s.get(b"h").unwrap() {
        (Val::Hash(e), Some(_)) => assert_eq!(e, vec![(b"f1".to_vec(), b"v1".to_vec()), (vec![0xff], b"v2".to_vec())]),
        other => panic!("{other:?}"),
    }
    assert_eq!(h.write(json!({ "op": "hdel", "key": "h", "fields": ["f1", "nope"] })).await["value"], json!({ "changed": 1 }));

    // lists: lset with the expected old value, ldel through the marker
    s.set(b"l", Val::List(vec![b"a".to_vec(), b"b".to_vec(), b"c".to_vec()]));
    assert_eq!(
        h.write(json!({ "op": "lset", "key": "l", "index": 1, "value": "B", "expected": "x" })).await["error"],
        "conflict"
    );
    assert_eq!(h.write(json!({ "op": "lset", "key": "l", "index": 1, "value": "B", "expected": "b" })).await["ok"], true);
    assert_eq!(h.write(json!({ "op": "ldel", "key": "l", "index": 0, "expected": "a" })).await["ok"], true);
    assert!(matches!(s.get(b"l").unwrap().0, Val::List(ref l) if *l == vec![b"B".to_vec(), b"c".to_vec()]));
    assert_eq!(
        h.write(json!({ "op": "rpush", "key": "l", "items": ["d"], "existing": true })).await["value"],
        json!({ "changed": 3 })
    );
    assert_eq!(h.write(json!({ "op": "sadd", "key": "set", "members": ["x", "y"] })).await["value"], json!({ "changed": 2 }));

    // rename, expire, persist, delete
    assert_eq!(h.write(json!({ "op": "rename", "key": "set", "newKey": "l" })).await["error"], "keyExists");
    assert_eq!(h.write(json!({ "op": "rename", "key": "missing", "newKey": "z" })).await["error"], "notFound");
    assert_eq!(h.write(json!({ "op": "rename", "key": "set", "newKey": "set2" })).await["ok"], true);
    assert_eq!(h.write(json!({ "op": "expire", "key": "missing", "ttlMs": 1000 })).await["error"], "notFound");
    assert_eq!(h.write(json!({ "op": "expire", "key": "set2", "ttlMs": 1000 })).await["value"], json!({ "changed": 1 }));
    assert_eq!(h.write(json!({ "op": "persist", "key": "set2" })).await["value"], json!({ "changed": 1 }));
    assert_eq!(h.write(json!({ "op": "delete", "keys": ["set2", "l", "nope"] })).await["value"], json!({ "changed": 2 }));

    // a server without KEEPTTL: the TTL is read under WATCH and set again
    s.sh.lock().no_keepttl = true;
    s.sh.lock().log.clear();
    assert_eq!(h.write(json!({ "op": "set", "key": "s", "value": "d" })).await["ok"], true);
    assert_eq!(h.write(json!({ "op": "set", "key": "s", "value": "e" })).await["ok"], true);
    let log = s.sh.lock().log.clone();
    assert_eq!(log.iter().filter(|l| l.contains("KEEPTTL")).count(), 1, "{log:?}");
    assert!(log.iter().any(|l| l == "pttl s"), "{log:?}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn read_only_sessions_refuse_writes_and_write_commands() {
    let s = Server::start().await;
    s.set(b"k", Val::Str(b"v".to_vec()));
    let h = harness(RedisLimits::default());
    h.open(s.port, true).await;
    assert_eq!(h.write(json!({ "op": "set", "key": "k", "value": "x" })).await, json!({ "ok": false, "error": "readOnly" }));
    assert_eq!(h.op(json!({ "kind": "publish", "channel": "c", "message": "m" })).await["error"], "readOnly");
    assert_eq!(h.ok(json!({ "kind": "publish", "channel": "c", "message": "m", "readWrite": true })).await, json!(0));
    assert_eq!(h.cmd(json!(["SET", "k", "x"]), json!({})).await["error"], "readOnly");
    assert_eq!(h.cmd(json!(["mymodule.thing"]), json!({})).await["error"], "readOnly");
    let r = h.cmd(json!(["GET", "k"]), json!({})).await;
    assert_eq!(r["value"]["reply"], json!({ "t": "bulk", "v": "v", "bytes": 1 }));
    // a read-write command from a read-only session's console with the switch on
    assert_eq!(
        h.cmd(json!(["SET", "k", "x"]), json!({ "readWrite": true })).await["value"]["reply"],
        json!({ "t": "simple", "v": "OK" })
    );
    assert_eq!(h.op(json!({ "kind": "countPattern", "match": "*" })).await["ok"], true);
    assert_eq!(
        h.op(json!({ "kind": "deletePattern", "token": "00000000-0000-4000-8000-000000000000" })).await["error"],
        "readOnly"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn console_commands_are_classified_and_answered() {
    let s = Server::start().await;
    s.set(b"k", Val::Str("v\u{e9}".as_bytes().to_vec()));
    let h = harness(RedisLimits { console_timeout_ms: 300.0, ..RedisLimits::default() });
    h.open(s.port, false).await;
    assert_eq!(h.cmd(json!(["SUBSCRIBE", "x"]), json!({})).await["error"], "subscribeCommand");
    assert_eq!(h.cmd(json!(["BLPOP", "x", "0"]), json!({})).await["error"], "blockingCommand");
    assert_eq!(h.cmd(json!(["MULTI"]), json!({})).await["error"], "consoleUnsupported");
    assert_eq!(h.cmd(json!(["FLUSHALL"]), json!({})).await["error"], "needsConfirm");
    // a renamed dangerous command still carries its category
    assert_eq!(h.cmd(json!(["renamed-flush"]), json!({})).await["error"], "needsConfirm");
    let r = h.cmd(json!(["get", "k"]), json!({})).await;
    assert_eq!(r["value"]["reply"], json!({ "t": "bulk", "v": "v\u{e9}", "bytes": 3 }));
    assert_eq!(r["value"]["db"], 0);
    let r = h.cmd(json!(["SET", "k2", { "b64": "AAE=" }]), json!({})).await;
    assert_eq!(r["value"]["reply"], json!({ "t": "simple", "v": "OK" }));
    assert!(matches!(s.get(b"k2").unwrap().0, Val::Str(ref b) if *b == vec![0, 1]));
    let r = h.cmd(json!(["nosuch"]), json!({})).await;
    assert_eq!(r["value"]["reply"], json!({ "t": "error", "v": "ERR unknown command 'nosuch'" }));
    let r = h.cmd(json!(["EXISTS", "k", "k2", "zz"]), json!({})).await;
    assert_eq!(r["value"]["reply"], json!({ "t": "integer", "v": "2" }));
    // select moves the session (and the browser) to another DB
    let r = h.cmd(json!(["select", "2"]), json!({})).await;
    assert_eq!(r["value"]["reply"], json!({ "t": "simple", "v": "OK" }));
    assert_eq!(r["value"]["db"], 2);
    assert_eq!(h.ok(json!({ "kind": "databases" })).await["current"], 2);
    let r = h.cmd(json!(["select", "x"]), json!({})).await;
    assert_eq!(r["value"]["reply"]["v"], "ERR value is not an integer or out of range");
    assert_eq!(h.cmd(json!(["select", "99"]), json!({})).await["value"]["reply"]["v"], "ERR DB index is out of range");
    // the console connection follows the session's DB
    assert_eq!(h.cmd(json!(["GET", "k"]), json!({})).await["value"]["reply"], json!({ "t": "null" }));
    let r = h.cmd(json!(["select", "0"]), json!({})).await;
    assert_eq!(r["value"]["db"], 0);
    // a command that hangs: statementTimeout, the console connection is dropped and a new one opens
    let r = h.cmd(json!(["hangme"]), json!({ "confirmed": true })).await;
    assert_eq!(r, json!({ "ok": false, "error": "statementTimeout" }));
    let r = h.cmd(json!(["get", "k"]), json!({})).await;
    assert_eq!(r["value"]["reply"]["v"], "v\u{e9}");
    // the browser was never blocked
    assert_eq!(h.ok(json!({ "kind": "cancel" })).await, json!(false));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pattern_deletes_need_a_fresh_count() {
    let s = Server::start().await;
    for i in 0..12 {
        s.set(format!("user:{i}").as_bytes(), Val::Str(b"x".to_vec()));
    }
    s.set(b"other", Val::Str(b"x".to_vec()));
    let h = harness(RedisLimits { delete_batch: 5, delete_slack_min: 0.0, delete_slack: 0.0, ..RedisLimits::default() });
    h.open(s.port, false).await;
    let c = h.ok(json!({ "kind": "countPattern", "match": "user:*" })).await;
    assert_eq!((c["count"].clone(), c["complete"].clone()), (json!(12), json!(true)));
    let token = c["token"].as_str().unwrap().to_owned();
    // keys added after the count are beyond the cap (no slack here)
    s.set(b"user:new", Val::Str(b"x".to_vec()));
    let d = h.ok(json!({ "kind": "deletePattern", "token": token })).await;
    assert_eq!(d, json!({ "deleted": 12, "cancelled": false, "more": true }));
    // the token is used once
    assert_eq!(h.op(json!({ "kind": "deletePattern", "token": token })).await["error"], "staleToken");
    let c = h.ok(json!({ "kind": "countPattern", "match": "user:*", "type": "string" })).await;
    assert_eq!(c["count"], 1);
    // a count on another DB is not valid after a select
    let token = c["token"].as_str().unwrap().to_owned();
    h.ok(json!({ "kind": "select", "index": 1 })).await;
    assert_eq!(h.op(json!({ "kind": "deletePattern", "token": token })).await["error"], "staleToken");
    h.ok(json!({ "kind": "select", "index": 0 })).await;
    let token = h.ok(json!({ "kind": "countPattern", "match": "user:*" })).await["token"].as_str().unwrap().to_owned();
    assert_eq!(
        h.ok(json!({ "kind": "deletePattern", "token": token })).await,
        json!({ "deleted": 1, "cancelled": false, "more": false })
    );
    assert!(s.get(b"other").is_some());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn pubsub_messages_reach_the_port_in_batches() {
    let s = Server::start().await;
    let h = harness(RedisLimits { pubsub_flush_ms: 20, ..RedisLimits::default() });
    h.open(s.port, false).await;
    assert_eq!(
        h.ok(json!({ "kind": "pubsubState" })).await,
        json!({ "state": "idle", "channels": [], "patterns": [], "dropped": 0 })
    );
    let st = h.ok(json!({ "kind": "subscribe", "channels": ["news", { "b64": "/w==" }], "patterns": ["n*"] })).await;
    assert_eq!(st, json!({ "state": "ready", "channels": ["news", { "b64": "/w==" }], "patterns": ["n*"], "dropped": 0 }));
    assert_eq!(h.ok(json!({ "kind": "publish", "channel": "news", "message": "hello" })).await, json!(2));
    assert_eq!(h.ok(json!({ "kind": "publish", "channel": { "b64": "/w==" }, "message": { "b64": "/w==" } })).await, json!(1));
    let mut got: Vec<Value> = Vec::new();
    for _ in 0..300 {
        got = h
            .port
            .lock()
            .iter()
            .filter(|m| m["t"] == "redisPubSub")
            .flat_map(|m| m["messages"].as_array().unwrap().clone())
            .collect();
        if got.len() >= 3 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(got.len(), 3, "{:?}", h.port.lock());
    let strip = |m: &Value| {
        let mut m = m.clone();
        assert!(m["time"].as_i64().unwrap() > 0);
        m.as_object_mut().unwrap().remove("time");
        m
    };
    let got: Vec<Value> = got.iter().map(strip).collect();
    assert!(got.contains(&json!({ "channel": "news", "payload": { "data": "hello", "bytes": 5 } })));
    assert!(got.contains(&json!({ "channel": "news", "pattern": "n*", "payload": { "data": "hello", "bytes": 5 } })));
    assert!(got.contains(&json!({ "channel": { "b64": "/w==" }, "payload": { "data": { "b64": "/w==" }, "bytes": 1 } })));
    assert!(h.port.lock().iter().all(|m| m["sessionId"] == ID));
    let states: Vec<Value> =
        h.port.lock().iter().filter(|m| m["t"] == "redisPubSubState").map(|m| m["state"]["state"].clone()).collect();
    assert_eq!(states[..2], [json!("connecting"), json!("ready")]);

    let st = h.ok(json!({ "kind": "unsubscribe", "channels": ["news"] })).await;
    assert_eq!(st["channels"], json!([{ "b64": "/w==" }]));
    assert_eq!(h.ok(json!({ "kind": "publish", "channel": "news", "message": "x" })).await, json!(1));
    let st = h.ok(json!({ "kind": "unsubscribe", "all": true })).await;
    assert_eq!(st, json!({ "state": "idle", "channels": [], "patterns": [], "dropped": 0 }));
    for _ in 0..100 {
        if s.sh.lock().subs.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(s.sh.lock().subs.is_empty(), "the subscriber connection closes");
    // too many names at once
    let many: Vec<String> = (0..1001).map(|i| format!("c{i}")).collect();
    assert_eq!(h.op(json!({ "kind": "subscribe", "channels": many })).await["error"], "invalid");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_full_pubsub_buffer_counts_drops() {
    let s = Server::start().await;
    let h = harness(RedisLimits { pubsub_flush_ms: 1000, pubsub_buffer: 2, ..RedisLimits::default() });
    h.open(s.port, false).await;
    h.ok(json!({ "kind": "subscribe", "channels": ["c"] })).await;
    for i in 0..5 {
        h.ok(json!({ "kind": "publish", "channel": "c", "message": format!("m{i}") })).await;
    }
    for _ in 0..200 {
        if h.port.lock().iter().any(|m| m["t"] == "redisPubSub") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let batch = h.port.lock().iter().find(|m| m["t"] == "redisPubSub").cloned().unwrap();
    assert_eq!(batch["messages"].as_array().unwrap().len(), 2);
    assert_eq!(batch["dropped"], 3);
    assert_eq!(h.ok(json!({ "kind": "pubsubState" })).await["dropped"], 3);
    h.host.send(ToHost::Close { id: ID.into() });
    for _ in 0..100 {
        if s.sh.lock().subs.is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(s.sh.lock().subs.is_empty(), "closing the session closes the subscriber");
}
