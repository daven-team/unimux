//! test/db-redis-safety.int.test.ts against the Rust Redis sessions: the DB Host's Redis part (`RedisHost`) talks to the very
//! RESP server the TS suite uses (test/helpers/respServer.ts, run by Node through tests/node/resp-control.mjs), so the
//! server-side behaviour (SCAN pages that repeat, renamed commands, Redis 6 COMMAND INFO, per-command delays, DEBUG SLEEP)
//! is the same. Skipped with a note when Node is missing.

mod resp;

use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures::future::BoxFuture;
use parking_lot::Mutex;
use resp::Resp;
use serde_json::{Value, json};
use unimux_db::host::{DbHostLink, HostReport, Spawn, ToHost, UnavailableHost, op_timeout_ms, redis_deadline};
use unimux_db::redis::host::{RedisHost, RedisHostDeps};
use unimux_db::redis::session::RedisLimits;

struct Harness {
    host: Arc<RedisHost>,
    main: Arc<Mutex<Vec<Value>>>,
    port: Arc<Mutex<Vec<Value>>>,
    /// Added to the clock of the host and its sessions (moves main's deadline).
    offset: Arc<AtomicI64>,
}

struct Opts {
    limits: RedisLimits,
    connect_ms: u64,
    /// Answer every password prompt with nothing (a cancelled prompt).
    cancel_prompts: bool,
}

fn limits() -> RedisLimits {
    RedisLimits { scan_budget_ms: 5000, ..RedisLimits::default() }
}

fn harness(limits: RedisLimits) -> Harness {
    harness_with(Opts { limits, connect_ms: 5000, cancel_prompts: false })
}

fn harness_with(opts: Opts) -> Harness {
    let spawn: Spawn = Arc::new(|f| {
        tokio::spawn(f);
    });
    let offset = Arc::new(AtomicI64::new(0));
    let o = offset.clone();
    let host = RedisHost::new(RedisHostDeps {
        next: UnavailableHost::new(spawn.clone()),
        spawn,
        tunnels: None,
        connect_ms: opts.connect_ms,
        limits: opts.limits,
        now: Arc::new(move || unimux_core::time::now_ms() + o.load(Ordering::SeqCst)),
    });
    let main: Arc<Mutex<Vec<Value>>> = Arc::default();
    let port: Arc<Mutex<Vec<Value>>> = Arc::default();
    let (m, w) = (main.clone(), Arc::downgrade(&host));
    let cancel = opts.cancel_prompts;
    let report: HostReport = Arc::new(move |msg: Value| {
        m.lock().push(msg.clone());
        if cancel
            && msg["t"] == "dbPasswordPrompt"
            && let Some(h) = w.upgrade()
        {
            h.send(ToHost::PasswordAnswer {
                id: msg["id"].as_str().unwrap().to_owned(),
                prompt_id: msg["promptId"].as_str().unwrap().to_owned(),
                value: None,
            });
        }
    });
    host.connect(report);
    let p = port.clone();
    host.connect_port(Arc::new(move |msg: Value| p.lock().push(msg)));
    Harness { host, main, port, offset }
}

static NEXT_ID: AtomicU64 = AtomicU64::new(1);

impl Harness {
    fn statuses(&self, id: &str) -> Vec<Value> {
        self.main.lock().iter().filter(|m| m["t"] == "dbStatus" && m["id"] == id).cloned().collect()
    }

    fn last(&self, id: &str) -> Value {
        self.statuses(id).last().cloned().unwrap_or(Value::Null)
    }

    async fn open(&self, port: u16, extra: Value) -> String {
        let id = format!("db:00000000-0000-4000-8000-{:012}", NEXT_ID.fetch_add(1, Ordering::SeqCst));
        let mut config = json!({ "kind": "redis", "host": "127.0.0.1", "port": port, "user": "", "database": "0", "tls": "disable", "readOnly": false, "ssh": null });
        for (k, v) in extra.as_object().unwrap() {
            config[k] = v.clone();
        }
        self.host.send(ToHost::Open { id: id.clone(), config });
        wait_for(|| ["connected", "error", "closed"].contains(&self.last(&id)["phase"].as_str().unwrap_or("")), 15_000).await;
        id
    }

    fn op(&self, id: &str, req: Value) -> BoxFuture<'static, Value> {
        self.host.request(id, json!({ "op": "redis", "req": req }), None)
    }

    async fn ok(&self, id: &str, req: Value) -> Value {
        let r = self.op(id, req.clone()).await;
        assert_eq!(r["ok"], true, "{req} -> {r}");
        r["value"].clone()
    }

    async fn error(&self, id: &str, req: Value) -> Value {
        self.op(id, req).await["error"].clone()
    }

    fn cmd(&self, id: &str, line: &str, extra: Value) -> BoxFuture<'static, Value> {
        let mut req = json!({ "argv": line.split(' ').collect::<Vec<_>>() });
        for (k, v) in extra.as_object().unwrap() {
            req[k] = v.clone();
        }
        self.op(id, json!({ "kind": "command", "req": req }))
    }

    async fn write(&self, id: &str, w: Value) -> Value {
        self.op(id, json!({ "kind": "write", "write": w })).await
    }

    fn port_of(&self, t: &str) -> Vec<Value> {
        self.port.lock().iter().filter(|m| m["t"] == t).cloned().collect()
    }
}

async fn wait_for(what: impl Fn() -> bool, ms: u64) {
    let start = Instant::now();
    while !what() {
        assert!(start.elapsed() < Duration::from_millis(ms), "timed out");
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pattern_deletes_stop_near_the_confirmed_count_and_tokens_expire() {
    let Some(s) = Resp::start(json!({})) else { return };
    let h = harness(RedisLimits { delete_batch: 50, ..limits() });
    let id = h.open(s.port, json!({})).await;
    s.set_strings("sess:", 0, 200);
    let counted = h.ok(&id, json!({ "kind": "countPattern", "match": "sess:*" })).await;
    assert_eq!(counted["count"], 200);
    // A busy namespace: 500 more keys arrive before the user confirms.
    s.set_strings("sess:", 200, 700);
    let del = h.ok(&id, json!({ "kind": "deletePattern", "token": counted["token"] })).await;
    assert_eq!(del, json!({ "deleted": 300, "cancelled": false, "more": true }));
    assert_eq!(s.count("sess:"), 400);

    let h2 = harness(RedisLimits { token_ttl_ms: 50, ..limits() });
    let id2 = h2.open(s.port, json!({})).await;
    let c2 = h2.ok(&id2, json!({ "kind": "countPattern", "match": "sess:*" })).await;
    tokio::time::sleep(Duration::from_millis(120)).await;
    assert_eq!(h2.error(&id2, json!({ "kind": "deletePattern", "token": c2["token"] })).await, "staleToken");
    assert_eq!(s.count("sess:"), 400);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pattern_deletes_span_scan_pages_count_once_and_cancel_mid_way_or_while_queued() {
    let Some(s) = Resp::start(json!({ "scanRepeat": true })) else { return };
    let h = harness(RedisLimits { delete_batch: 100, ..limits() });
    let id = h.open(s.port, json!({})).await;
    s.set_strings("k:", 0, 2500);
    let counted = h.ok(&id, json!({ "kind": "countPattern", "match": "k:*" })).await;
    assert_eq!((counted["count"].clone(), counted["complete"].clone()), (json!(2500), json!(true)));
    assert!(s.ops("scan") > 2);
    let all = h.ok(&id, json!({ "kind": "deletePattern", "token": counted["token"] })).await;
    assert_eq!(all, json!({ "deleted": 2500, "cancelled": false, "more": false }));

    s.set_strings("m:", 0, 1000);
    let c2 = h.ok(&id, json!({ "kind": "countPattern", "match": "m:*" })).await;
    s.call("delay", json!(["UNLINK", 150]));
    let before = s.ops("unlink");
    let pending = tokio::spawn(h.op(&id, json!({ "kind": "deletePattern", "token": c2["token"] })));
    wait_for(|| s.ops("unlink") > before, 10_000).await;
    assert_eq!(h.ok(&id, json!({ "kind": "cancel" })).await, true);
    let mid = pending.await.unwrap();
    assert_eq!(mid["value"]["cancelled"], true, "{mid}");
    let deleted = mid["value"]["deleted"].as_u64().unwrap();
    assert!((100..1000).contains(&deleted), "{deleted}");
    s.call("delay", json!(["UNLINK", null]));

    // Cancelled while it still waits behind a slow console command: it never deletes anything.
    let c3 = h.ok(&id, json!({ "kind": "countPattern", "match": "m:*" })).await;
    let left = c3["count"].as_u64().unwrap();
    let sleep = tokio::spawn(h.cmd(&id, "DEBUG SLEEP 0.4", json!({ "confirmed": true })));
    let queued = tokio::spawn(h.op(&id, json!({ "kind": "deletePattern", "token": c3["token"] })));
    tokio::time::sleep(Duration::from_millis(50)).await;
    h.ok(&id, json!({ "kind": "cancel" })).await;
    sleep.await.unwrap();
    assert_eq!(queued.await.unwrap(), json!({ "ok": true, "value": { "deleted": 0, "cancelled": true, "more": true } }));
    assert_eq!(s.count("m:"), left);
    // A cancel only stops what was queued before it.
    let c4 = h.ok(&id, json!({ "kind": "countPattern", "match": "m:*" })).await;
    let done = h.ok(&id, json!({ "kind": "deletePattern", "token": c4["token"] })).await;
    assert_eq!((done["deleted"].as_u64(), done["cancelled"].as_bool()), (Some(left), Some(false)));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn set_never_replaces_another_type_and_existing_edits_create_nothing() {
    // 'SET never replaces another type; KEEPTTL fallback reads the TTL under WATCH'
    let Some(s) = Resp::start(json!({ "noKeepTtl": true })) else { return };
    let h = harness(limits());
    let id = h.open(s.port, json!({})).await;
    h.ok(&id, json!({ "kind": "write", "write": { "op": "hset", "key": "h", "field": "f", "value": "v" } })).await;
    assert_eq!(h.write(&id, json!({ "op": "set", "key": "h", "value": "oops" })).await["error"], "wrongType");
    assert_eq!(s.call("type", json!(["h"])), "hash");
    for value in ["a", "b", "c"] {
        let ttl = if value == "a" { json!(100_000) } else { Value::Null };
        let mut w = json!({ "op": "set", "key": "s", "value": value });
        if !ttl.is_null() {
            w["ttlMs"] = ttl;
        }
        assert_eq!(h.write(&id, w).await["ok"], true);
    }
    let read = h.ok(&id, json!({ "kind": "read", "req": { "type": "string", "key": "s" } })).await;
    assert_eq!(read["value"]["data"], "c");
    assert!(read["ttlMs"].as_f64().unwrap() > 90_000.0, "{read}");
    let names = s.call("names", json!([]));
    assert!(names.as_str().unwrap().contains("watch type pttl multi set pexpire exec"), "{names}");

    // '`existing` edits answer notFound for a vanished key and wrongType for another type, creating nothing'
    let Some(s) = Resp::start(json!({})) else { return };
    let id = h.open(s.port, json!({})).await;
    for w in [
        json!({ "op": "hset", "key": "gone", "field": "f", "value": "v", "existing": true }),
        json!({ "op": "rpush", "key": "gone", "items": ["x"], "existing": true }),
        json!({ "op": "sadd", "key": "gone", "members": ["x"], "existing": true }),
        json!({ "op": "zadd", "key": "gone", "entries": [["m", "1"]], "existing": true }),
        json!({ "op": "zincrby", "key": "gone", "member": "m", "by": "1", "existing": true }),
        json!({ "op": "xadd", "key": "gone", "fields": [["f", "v"]], "existing": true }),
        json!({ "op": "set", "key": "gone", "value": "v", "existing": true }),
        json!({ "op": "set", "key": "gone", "value": "v", "existing": true, "keepTtl": false }),
    ] {
        assert_eq!(h.write(&id, w.clone()).await["error"], "notFound", "{w}");
    }
    assert_eq!(s.call("has", json!(["gone"])), false);
    s.set_string("str", "x");
    let lpush = json!({ "op": "lpush", "key": "str", "items": ["y"], "existing": true });
    assert_eq!(h.write(&id, lpush).await["error"], "wrongType");
    let set = json!({ "op": "set", "key": "str", "value": "y", "existing": true });
    assert_eq!(h.write(&id, set).await["value"], json!({ "changed": 1 }));
    h.ok(&id, json!({ "kind": "write", "write": { "op": "rpush", "key": "l", "items": ["a"] } })).await;
    let set_on_list = json!({ "op": "set", "key": "l", "value": "y", "existing": true });
    assert_eq!(h.write(&id, set_on_list).await["error"], "wrongType");
    let push = json!({ "op": "rpush", "key": "l", "items": ["b"], "existing": true });
    assert_eq!(h.write(&id, push).await["value"], json!({ "changed": 2 }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn an_operation_that_would_start_after_main_gave_up_is_skipped_and_the_retry_runs_once() {
    let Some(s) = Resp::start(json!({ "commandDelays": { "HLEN": 400 } })) else { return };
    let h = harness(limits());
    let id = h.open(s.port, json!({})).await;
    h.ok(&id, json!({ "kind": "write", "write": { "op": "hset", "key": "h", "field": "f", "value": "v" } })).await;
    let slow =
        tokio::spawn(h.op(&id, json!({ "kind": "read", "req": { "type": "hash", "key": "h", "cursor": "0", "count": 10 } })));
    tokio::time::sleep(Duration::from_millis(30)).await;
    // Main gives up on this one in 100 ms: the host's clock is moved back while it computes the deadline it sends.
    let late_op = json!({ "op": "redis", "req": { "kind": "write", "write": { "op": "rpush", "key": "l", "items": ["once"] } } });
    let ahead = redis_deadline(0, op_timeout_ms(&late_op));
    h.offset.store(100 - ahead, Ordering::SeqCst);
    let late = h.host.request(&id, late_op, None);
    h.offset.store(0, Ordering::SeqCst);
    assert_eq!(late.await["error"], "dbTimeout");
    assert_eq!(slow.await.unwrap()["ok"], true);
    assert_eq!(s.ops("rpush"), 0);
    let again = h.write(&id, json!({ "op": "rpush", "key": "l", "items": ["once"] })).await;
    assert_eq!(again["value"], json!({ "changed": 1 }));
    assert_eq!(s.ops("rpush"), 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_console_has_its_own_connection_and_follows_the_sessions_database() {
    let Some(s) = Resp::start(json!({})) else { return };
    let h = harness(limits());
    let id = h.open(s.port, json!({})).await;
    s.set_string("k", "v");
    let sleeping = tokio::spawn(h.cmd(&id, "DEBUG SLEEP 1", json!({ "confirmed": true })));
    tokio::time::sleep(Duration::from_millis(30)).await;
    let t0 = Instant::now();
    assert_eq!(h.op(&id, json!({ "kind": "scan", "req": { "cursor": "0" } })).await["ok"], true);
    assert!(t0.elapsed() < Duration::from_millis(700), "{:?}", t0.elapsed());
    assert_eq!(sleeping.await.unwrap()["ok"], true);
    let timed_out = h.cmd(&id, "DEBUG SLEEP 2", json!({ "confirmed": true, "timeoutMs": 100 })).await;
    assert_eq!(timed_out["error"], "statementTimeout");
    let t1 = Instant::now();
    let ping = h.cmd(&id, "PING", json!({})).await;
    assert_eq!(ping["value"]["reply"], json!({ "t": "simple", "v": "PONG" }));
    assert!(t1.elapsed() < Duration::from_millis(1000), "{:?}", t1.elapsed());
    h.ok(&id, json!({ "kind": "select", "index": 3 })).await;
    s.call("setString", json!(["in3", "yes", 3]));
    let got = h.cmd(&id, "GET in3", json!({})).await;
    assert_eq!((got["value"]["reply"]["t"].clone(), got["value"]["reply"]["v"].clone()), (json!("bulk"), json!("yes")));
    assert_eq!(got["value"]["db"], 3);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn console_reads_of_big_collections_or_values_ask_first() {
    let Some(s) = Resp::start(json!({})) else { return };
    let h = harness(RedisLimits { console_items_confirm: 10.0, console_bytes_confirm: 90.0, ..limits() });
    let id = h.open(s.port, json!({})).await;
    let items: Vec<String> = (0..30).map(|i| i.to_string()).collect();
    h.ok(&id, json!({ "kind": "write", "write": { "op": "rpush", "key": "l", "items": items } })).await;
    h.ok(&id, json!({ "kind": "write", "write": { "op": "hset", "key": "h", "field": "f", "value": "v" } })).await;
    for i in 0..20 {
        h.ok(&id, json!({ "kind": "write", "write": { "op": "hset", "key": "bigh", "field": format!("f{i}"), "value": "v" } }))
            .await;
    }
    s.set_string("big", &"x".repeat(100));
    assert_eq!(h.cmd(&id, "LRANGE l 0 -1", json!({})).await["error"], "needsConfirm");
    assert_eq!(h.cmd(&id, "LRANGE l 0 4", json!({})).await["ok"], true);
    assert_eq!(h.cmd(&id, "HGETALL bigh", json!({})).await["error"], "needsConfirm");
    assert_eq!(h.cmd(&id, "HGETALL h", json!({})).await["ok"], true);
    assert_eq!(h.cmd(&id, "GET big", json!({})).await["error"], "needsConfirm");
    assert_eq!(h.cmd(&id, "MGET big big", json!({})).await["error"], "needsConfirm");
    assert_eq!(h.cmd(&id, "HGETALL bigh", json!({ "confirmed": true })).await["ok"], true);
    assert_eq!(s.ops("hgetall"), 2);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pages_stop_at_the_byte_budget_and_a_small_hash_comes_back_whole() {
    // 'list, stream and hash pages stop at the byte budget and go on from where they stopped; scan pages drop duplicates'
    let Some(s) = Resp::start(json!({ "scanRepeat": true })) else { return };
    let h = harness(RedisLimits { page_bytes: 1000, page_batch: 4.0, ..limits() });
    let id = h.open(s.port, json!({})).await;
    let v = "x".repeat(100);
    let fifty: Vec<&str> = vec![v.as_str(); 50];
    h.ok(&id, json!({ "kind": "write", "write": { "op": "rpush", "key": "l", "items": fifty } })).await;
    let p1 = h.ok(&id, json!({ "kind": "read", "req": { "type": "list", "key": "l", "start": 0, "count": 50 } })).await;
    let n1 = p1["items"].as_array().unwrap().len();
    assert!((10..50).contains(&n1), "{n1}");
    let p2 = h.ok(&id, json!({ "kind": "read", "req": { "type": "list", "key": "l", "start": n1, "count": 50 } })).await;
    assert_eq!(p2["start"], n1);
    for i in 1..=30 {
        h.ok(
            &id,
            json!({ "kind": "write", "write": { "op": "xadd", "key": "st", "id": format!("{i}-0"), "fields": [["f", v]] } }),
        )
        .await;
    }
    let (mut ids, mut start, mut pages) = (Vec::new(), "-".to_string(), 0);
    loop {
        let p = h
            .ok(&id, json!({ "kind": "read", "req": { "type": "stream", "key": "st", "start": start, "end": "+", "count": 30 } }))
            .await;
        ids.extend(p["entries"].as_array().unwrap().iter().map(|e| e["id"].as_str().unwrap().to_string()));
        pages += 1;
        match p["next"].as_str() {
            Some(next) if !next.is_empty() => start = next.to_string(),
            _ => break,
        }
    }
    assert_eq!(ids, (1..=30).map(|i| format!("{i}-0")).collect::<Vec<_>>());
    assert!(pages > 1);
    for i in 0..40 {
        h.ok(&id, json!({ "kind": "write", "write": { "op": "hset", "key": "h", "field": format!("f{i}"), "value": v } })).await;
    }
    let mut fields = std::collections::HashSet::new();
    let mut cursor = "0".to_string();
    loop {
        let p = h.ok(&id, json!({ "kind": "read", "req": { "type": "hash", "key": "h", "cursor": cursor, "count": 40 } })).await;
        let names: Vec<String> =
            p["entries"].as_array().unwrap().iter().map(|e| e["field"].as_str().unwrap().to_string()).collect();
        let unique: std::collections::HashSet<&String> = names.iter().collect();
        assert_eq!(unique.len(), names.len(), "a page has no duplicates");
        fields.extend(names);
        cursor = p["cursor"].as_str().unwrap().to_string();
        if cursor == "0" {
            break;
        }
    }
    assert_eq!(fields.len(), 40);

    // 'a small hash comes back whole whatever the COUNT (listpack behaviour)'
    let Some(small) = Resp::start(json!({ "wholeSmall": 128 })) else { return };
    let h = harness(limits());
    let id = h.open(small.port, json!({})).await;
    for i in 0..10 {
        h.ok(&id, json!({ "kind": "write", "write": { "op": "hset", "key": "h", "field": format!("f{i}"), "value": "v" } }))
            .await;
    }
    let p = h.ok(&id, json!({ "kind": "read", "req": { "type": "hash", "key": "h", "cursor": "0", "count": 3 } })).await;
    assert_eq!(p["cursor"], "0");
    assert_eq!(p["entries"].as_array().unwrap().len(), 10);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn pubsub_takes_every_name_over_on_a_new_connection_and_its_buffer_accounting_returns_to_zero() {
    // 'a subscriber connection that ended for good: the next subscribe takes over every listed name again'
    let Some(s) = Resp::start(json!({})) else { return };
    let h = harness(RedisLimits { reconnect_attempts: 0, ..limits() });
    let id = h.open(s.port, json!({})).await;
    h.ok(&id, json!({ "kind": "subscribe", "channels": ["old"], "patterns": ["p:*"] })).await;
    s.call("dropSubscribers", json!([]));
    wait_for(|| h.port_of("redisPubSubState").iter().any(|m| m["state"]["state"] == "closed"), 10_000).await;
    assert_eq!(h.last(&id)["phase"], "connected");
    let st = h.ok(&id, json!({ "kind": "subscribe", "channels": ["new"] })).await;
    assert_eq!(
        (st["state"].clone(), st["channels"].clone(), st["patterns"].clone()),
        (json!("ready"), json!(["old", "new"]), json!(["p:*"]))
    );
    for ch in ["old", "new", "p:1"] {
        assert_eq!(h.ok(&id, json!({ "kind": "publish", "channel": ch, "message": ch })).await, 1, "{ch}");
    }
    let messages = |h: &Harness| h.port_of("redisPubSub").iter().map(|m| m["messages"].as_array().unwrap().len()).sum::<usize>();
    wait_for(|| messages(&h) == 3, 10_000).await;

    // 'the buffer accounting returns to zero after drops and flushes'
    let h =
        harness(RedisLimits { pubsub_buffer: 10, pubsub_buffer_bytes: 300, pubsub_batch: 3, pubsub_flush_ms: 30, ..limits() });
    let id = h.open(s.port, json!({})).await;
    h.ok(&id, json!({ "kind": "subscribe", "channels": ["c"] })).await;
    let sends: Vec<_> = (0..40)
        .map(|i| tokio::spawn(h.op(&id, json!({ "kind": "publish", "channel": "c", "message": format!("payload number {i}") }))))
        .collect();
    for send in sends {
        send.await.unwrap();
    }
    let total = |h: &Harness| {
        h.port_of("redisPubSub")
            .iter()
            .map(|m| m["messages"].as_array().unwrap().len() as u64 + m["dropped"].as_u64().unwrap())
            .sum::<u64>()
    };
    wait_for(|| total(&h) == 40, 5000).await;
    assert!(h.ok(&id, json!({ "kind": "pubsubState" })).await["dropped"].as_u64().unwrap() > 0);
    // Nothing is left counted: a full buffer's worth of new messages fits again (a drifting byte count would drop them).
    let before = messages(&h);
    for i in 0..10 {
        h.ok(&id, json!({ "kind": "publish", "channel": "c", "message": format!("again {i:02}") })).await;
        tokio::time::sleep(Duration::from_millis(40)).await;
    }
    wait_for(|| messages(&h) == before + 10, 5000).await;
    assert_eq!(total(&h), 50, "no new drops");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn console_safety_on_old_servers_renamed_commands_tls_prefer_and_refused_logins() {
    // 'read-only on a Redis 6 style server: subcommands without their own entry and admin commands are refused; XREAD runs'
    let Some(s) = Resp::start(json!({ "noSubcommandInfo": true })) else { return };
    let h = harness(limits());
    let id = h.open(s.port, json!({ "readOnly": true })).await;
    assert_eq!(h.cmd(&id, "PING", json!({})).await["ok"], true);
    s.set_string("k", "v");
    assert_eq!(h.cmd(&id, "CLIENT UNBLOCK 5", json!({})).await["error"], "readOnly");
    assert_eq!(h.cmd(&id, "REPLCONF listening-port 1", json!({})).await["error"], "readOnly");
    assert_eq!(h.cmd(&id, "CLIENT LIST", json!({})).await["ok"], true);
    assert_eq!(h.cmd(&id, "XREAD STREAMS st 0", json!({})).await["ok"], true);
    assert_eq!(s.ops("replconf"), 0);

    // 'a renamed dangerous command still asks (its @dangerous category)'
    let Some(s) = Resp::start(json!({ "renames": { "NUKE": "FLUSHALL" } })) else { return };
    let id = h.open(s.port, json!({})).await;
    s.set_string("k", "v");
    assert_eq!(h.cmd(&id, "NUKE", json!({})).await["error"], "needsConfirm");
    assert_eq!(s.call("size", json!([])), 1);
    assert_eq!(h.cmd(&id, "NUKE", json!({ "confirmed": true })).await["ok"], true);
    assert_eq!(s.call("size", json!([])), 0);

    // 'TLS prefer does not fall back to plain text when the TLS server is only slow'
    let silent = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let silent_port = silent.local_addr().unwrap().port();
    let held = tokio::spawn(async move {
        let mut socks = Vec::new();
        while let Ok((sock, _)) = silent.accept().await {
            socks.push(sock);
        }
    });
    let slow = harness_with(Opts { limits: limits(), connect_ms: 400, cancel_prompts: false });
    let id = slow.open(silent_port, json!({ "tls": "prefer", "password": "never-in-clear" })).await;
    assert_eq!((slow.last(&id)["phase"].clone(), slow.last(&id)["error"].clone()), (json!("error"), json!("dbTimeout")));
    held.abort();

    // 'a refused login never puts the password into any message'
    let Some(s) = Resp::start(json!({ "password": "right-one" })) else { return };
    let h = harness_with(Opts { limits: limits(), connect_ms: 5000, cancel_prompts: true });
    let id = h.open(s.port, json!({ "password": "secret-wrong-pw" })).await;
    assert_eq!(h.last(&id)["phase"], "error");
    assert!(!serde_json::to_string(&*h.main.lock()).unwrap().contains("secret-wrong-pw"));
    let h2 = harness_with(Opts { limits: limits(), connect_ms: 5000, cancel_prompts: true });
    let id2 = h2.open(s.port, json!({ "user": "alice", "password": "secret-acl-pw" })).await;
    assert_eq!(h2.last(&id2)["phase"], "error");
    assert!(!serde_json::to_string(&*h2.main.lock()).unwrap().contains("secret-acl-pw"));
}
