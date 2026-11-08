//! The db:redis IPC validation of test/db-redis-main.test.ts: valid operations reach the service as `{ op: "redis", req }`,
//! malformed ones are refused before the service sees them, and the limits count bytes, not characters.

mod common;

use common::*;
use serde_json::{Value, json};
use unimux_db::ipc;
use unimux_db::service::PasswordChange;

/// A connected Redis session of the fake chain.
async fn connected(t: &Setup) -> String {
    let redis =
        t.save(json!({ "kind": "redis", "port": 6379, "user": "", "database": null, "dbIndex": 0 }), PasswordChange::Keep);
    let sid = t.service.connect(redis["id"].as_str().unwrap(), None).unwrap();
    flush().await;
    t.service.on_host_message(json!({ "t": "dbStatus", "id": sid, "phase": "connected" }));
    sid
}

fn requests(t: &Setup) -> Vec<(String, Value)> {
    t.host.requests.lock().clone()
}

#[tokio::test]
async fn passes_valid_operations_on_and_refuses_malformed_ones_without_calling_the_service() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let sid = connected(&t).await;
    let id = json!(sid);
    let answer = json!({ "ok": true, "value": "answer" });
    let invalid = json!({ "ok": false, "error": "invalid" });

    // 'refuses malformed operations without calling the service'
    let malformed = [
        json!({ "kind": "scan", "req": { "cursor": "abc" } }),
        json!({ "kind": "scan", "req": { "cursor": "0", "limit": 100000 } }),
        json!({ "kind": "scan", "req": { "cursor": "0", "extra": 1 } }),
        json!({ "kind": "read", "req": { "type": "string", "key": { "b64": "not base64!" } } }),
        json!({ "kind": "read", "req": { "type": "stream", "key": "s", "start": "abc", "end": "+", "count": 10 } }),
        json!({ "kind": "read", "req": { "type": "list", "key": "l", "start": -1, "count": 10 } }),
        json!({ "kind": "write", "write": { "op": "flushall" } }),
        json!({ "kind": "write", "write": { "op": "zadd", "key": "z", "entries": [["m", "NaN"]] } }),
        json!({ "kind": "write", "write": { "op": "expire", "key": "k", "ttlMs": 0 } }),
        json!({ "kind": "write", "write": { "op": "delete", "keys": [] } }),
        json!({ "kind": "command", "req": { "argv": [{ "b64": "AA==" }] } }),
        json!({ "kind": "command", "req": { "argv": [] } }),
        json!({ "kind": "info", "section": "a b" }),
        json!({ "kind": "nope" }),
        json!({ "op": "schemas" }),
    ];
    for req in &malformed {
        assert_eq!(ipc::redis(&t.service, &id, req, None).await, invalid, "{req}");
    }
    let sftp = json!("sftp:00000000-0000-4000-8000-000000000001");
    assert_eq!(ipc::redis(&t.service, &sftp, &json!({ "kind": "databases" }), None).await, invalid);
    // The Postgres channel does not take Redis operations.
    assert_eq!(ipc::pg(&t.service, &id, &json!({ "op": "redis", "req": { "kind": "databases" } }), None).await, invalid);
    assert!(requests(&t).is_empty());

    // 'passes valid operations on as { op: "redis", req }'
    let valid = [
        json!({ "kind": "scan", "req": { "cursor": "0", "match": "user:*", "count": 100, "type": "hash", "limit": 500, "details": true } }),
        json!({ "kind": "read", "req": { "type": "string", "key": { "b64": "AP8=" }, "offset": 10, "maxBytes": 1000 } }),
        json!({ "kind": "read", "req": { "type": "zset", "key": "z", "start": 0, "count": 50, "rev": true } }),
        json!({ "kind": "read", "req": { "type": "zset", "key": "z", "cursor": "0", "count": 50 } }),
        json!({ "kind": "read", "req": { "type": "stream", "key": "s", "start": "(1-0", "end": "+", "count": 10 } }),
        json!({ "kind": "readItem", "req": { "type": "stream", "key": "s", "id": "1-0", "field": "f" } }),
        json!({ "kind": "write", "write": { "op": "zadd", "key": "z", "entries": [["m", "-inf"], ["n", "1.5e3"]], "mode": "xx" } }),
        json!({ "kind": "write", "write": { "op": "create", "key": "k", "value": { "type": "hash", "entries": [["f", "v"]] }, "ttlMs": 1000 } }),
        json!({ "kind": "write", "write": { "op": "xadd", "key": "s", "id": "5-*", "fields": [["a", "b"]] } }),
        json!({ "kind": "command", "req": { "argv": ["SET", "k", { "b64": "AP8=" }], "readWrite": true, "timeoutMs": 1000 } }),
        json!({ "kind": "subscribe", "channels": ["a", { "b64": "AA==" }], "patterns": ["x*"] }),
        json!({ "kind": "publish", "channel": "c", "message": "m" }),
        json!({ "kind": "deletePattern", "token": "00000000-0000-4000-8000-000000000009" }),
        json!({ "kind": "info", "section": "keyspace" }),
    ];
    for req in &valid {
        assert_eq!(ipc::redis(&t.service, &id, req, None).await, answer, "{req}");
    }
    let sent: Vec<Value> = requests(&t)
        .into_iter()
        .map(|(s, op)| {
            assert_eq!(s, sid);
            op
        })
        .collect();
    let expected: Vec<Value> = valid.iter().map(|req| json!({ "op": "redis", "req": req })).collect();
    assert_eq!(sent, expected);
}

#[tokio::test]
async fn limits_bytes_not_characters_per_value_and_for_the_whole_request() {
    let dir = tempfile::tempdir().unwrap();
    let t = setup(dir.path(), Options::default());
    let sid = connected(&t).await;
    let id = json!(sid);
    let invalid = json!({ "ok": false, "error": "invalid" });
    // 600k two-byte characters: under the 1 MB name limit in characters, over it in bytes.
    let wide = "ż".repeat(600_000);
    assert_eq!(ipc::redis(&t.service, &id, &json!({ "kind": "keyInfo", "keys": [wide] }), None).await, invalid);
    let big = "x".repeat(40 * 1024 * 1024);
    let rpush = json!({ "kind": "write", "write": { "op": "rpush", "key": "l", "items": [big, big] } });
    assert_eq!(ipc::redis(&t.service, &id, &rpush, None).await, invalid);
    let mset = json!({ "kind": "command", "req": { "argv": ["MSET", "a", big, "b", big] } });
    assert_eq!(ipc::redis(&t.service, &id, &mset, None).await, invalid);
    assert!(requests(&t).is_empty());
    let one = json!({ "kind": "write", "write": { "op": "rpush", "key": "l", "items": [big], "existing": true } });
    assert_eq!(ipc::redis(&t.service, &id, &one, None).await, json!({ "ok": true, "value": "answer" }));
}
