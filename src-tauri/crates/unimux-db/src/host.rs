//! The link between the DB service and the sessions that talk to the servers (1.1.4: the DB Host utility process and
//! src/main/dbHostClient.ts). In 1.2.0 the sessions are tokio tasks / threads of this process (D4 Postgres, D7 MySQL, D9
//! Redis, D11 SQLite, routed by D12), reached through [`DbHostLink`]. This module keeps what dbHostClient.ts decided for
//! every operation: how long main waits for an answer ([`op_timeout_ms`]), the deadline a Redis operation carries
//! ([`redis_deadline`]), the pending requests that a crash fails with `dbHostCrashed` ([`PendingRequests`]) and the crash
//! limit (more than 5 in a minute: fatal, [`CrashCounter`]).
//!
//! Until the session packages land, [`UnavailableHost`] answers every open with the session error `unsupported`, so the
//! renderer shows a translated error instead of a session that never connects.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use zeroize::Zeroizing;

/// `MainToDbHost` without the SSH login messages (those are the coordinator's, S3).
#[derive(Debug, Clone, PartialEq)]
pub enum ToHost {
    /// `dbOpen`: everything one session needs. The config holds the password: never logged.
    Open { id: String, config: Value },
    /// `dbPasswordAnswer`: the password the user typed (None: cancelled).
    PasswordAnswer { id: String, prompt_id: String, value: Option<Zeroizing<String>> },
    /// `dbClose`.
    Close { id: String },
}

impl ToHost {
    /// The 1.1.4 message (tests compare it with the TS expectations; never log it: it may carry a password).
    pub fn to_json(&self) -> Value {
        match self {
            ToHost::Open { id, config } => json!({ "t": "dbOpen", "id": id, "config": config }),
            ToHost::PasswordAnswer { id, prompt_id, value } => {
                json!({ "t": "dbPasswordAnswer", "id": id, "promptId": prompt_id, "value": value.as_ref().map(|v| v.as_str()) })
            }
            ToHost::Close { id } => json!({ "t": "dbClose", "id": id }),
        }
    }
}

/// `DbHostLink`.
pub trait DbHostLink: Send + Sync {
    /// Ready to open sessions (false: crashed too often, or shutting down).
    fn ensure(&self) -> bool;
    /// False when nothing runs that could take the message.
    fn send(&self, m: ToHost) -> bool;
    /// An operation of a session; `window`: the window that asked (None: the main window), whose port gets the results.
    fn request(&self, id: &str, op: Value, window: Option<String>) -> BoxFuture<'static, Value>;
}

fn redis_kind(op: &Value) -> Option<&str> {
    (op.get("op").and_then(Value::as_str) == Some("redis")).then(|| op.pointer("/req/kind").and_then(Value::as_str).unwrap_or(""))
}

/// `dbOpTimeoutMs`: how long main waits for an operation's answer (a run itself answers once accepted; its rows go to the
/// port).
pub fn op_timeout_ms(op: &Value) -> u64 {
    if let Some(k) = redis_kind(op) {
        // Pattern counts and deletes walk the whole keyspace; a console command has its own (shorter) limit in the host.
        return match k {
            "countPattern" | "deletePattern" => 60 * 60_000,
            "command" => 6 * 60_000,
            "write" | "readItem" => 5 * 60_000,
            _ => 2 * 60_000,
        };
    }
    match op.get("op").and_then(Value::as_str) {
        Some("applyEdits" | "ddl" | "databases") => 10 * 60_000,
        Some("cellValue") => 5 * 60_000,
        _ => 2 * 60_000,
    }
}

/// `redisDeadline`: main's timeout less a margin (the answer must still reach main in time).
pub fn redis_deadline(now: i64, timeout_ms: u64) -> i64 {
    let t = timeout_ms as f64;
    now + (t - (t / 10.0).min(10_000.0)).max(1000.0).floor() as i64
}

/// The operation as sent: a Redis one carries the moment main gives up (`{...op, deadline}`), so the session skips it when
/// it would only start later and a change the user saw fail never runs.
pub fn with_deadline(op: Value, now: i64) -> Value {
    if redis_kind(&op).is_none() {
        return op;
    }
    let timeout = op_timeout_ms(&op);
    let mut m: Map<String, Value> = op.as_object().cloned().unwrap_or_default();
    m.insert("deadline".into(), json!(redis_deadline(now, timeout)));
    Value::Object(m)
}

fn failed(error: &str) -> Value {
    json!({ "ok": false, "error": error })
}

/// The requests waiting for an answer (`pending` of DbHostClient): each one ends with its answer, `dbTimeout` after
/// [`op_timeout_ms`], or `dbHostCrashed` when the sessions crashed.
#[derive(Default)]
pub struct PendingRequests {
    next: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<Value>>>,
}

impl PendingRequests {
    /// A new request id and the answer to wait for.
    pub fn start(self: &Arc<Self>, timeout_ms: u64) -> (u64, BoxFuture<'static, Value>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(id, tx);
        let me = self.clone();
        let wait = Box::pin(async move {
            match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
                Ok(Ok(v)) => v,
                Ok(Err(_)) => failed("dbHostCrashed"),
                Err(_) => {
                    me.pending.lock().remove(&id);
                    failed("dbTimeout")
                }
            }
        });
        (id, wait)
    }

    /// The answer of request `id` (late answers are dropped).
    pub fn resolve(&self, id: u64, result: Value) {
        if let Some(tx) = self.pending.lock().remove(&id) {
            let _ = tx.send(result);
        }
    }

    /// The sessions crashed: every waiting request answers `dbHostCrashed`.
    pub fn fail_all(&self) {
        for (_, tx) in self.pending.lock().drain() {
            let _ = tx.send(failed("dbHostCrashed"));
        }
    }

    pub fn len(&self) -> usize {
        self.pending.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// The crash limit of the DB Host: more than 5 crashes within 60 s and it is not started again until the app restarts.
#[derive(Default)]
pub struct CrashCounter {
    crashes: Vec<i64>,
    fatal: bool,
}

impl CrashCounter {
    /// Records a crash at `now`; true when the limit is reached (fatal).
    pub fn record(&mut self, now: i64) -> bool {
        self.crashes.retain(|t| now - t < 60_000);
        self.crashes.push(now);
        if self.crashes.len() > 5 {
            self.fatal = true;
        }
        self.fatal
    }

    pub fn fatal(&self) -> bool {
        self.fatal
    }
}

/// Where the host side reports to (the service's `onHostMessage`).
pub type HostReport = Arc<dyn Fn(Value) + Send + Sync>;
pub type Spawn = Arc<dyn Fn(BoxFuture<'static, ()>) + Send + Sync>;

/// The session hosts' messages to the service, in order, from a task of their own. 1.1.4's DB Host was another process,
/// so its messages always arrived later; here the hosts report while the service may hold its lock (it sends `dbOpen`
/// and `dbClose` under it), so a direct call would come back into the service and deadlock.
pub fn queued_report(spawn: &Spawn, sink: HostReport) -> HostReport {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Value>();
    spawn(Box::pin(async move {
        while let Some(m) = rx.recv().await {
            sink(m);
        }
    }));
    Arc::new(move |m| {
        let _ = tx.send(m);
    })
}

/// The host until the session packages (D4 / D7 / D9 / D11) land: every session ends at once with `unsupported`; nothing is
/// connected, so no operation is ever asked.
pub struct UnavailableHost {
    report: OnceLock<HostReport>,
    spawn: Spawn,
}

impl UnavailableHost {
    pub fn new(spawn: Spawn) -> Arc<Self> {
        Arc::new(Self { report: OnceLock::new(), spawn })
    }

    /// Where its status messages go (set once the service exists).
    pub fn connect(&self, report: HostReport) {
        let _ = self.report.set(report);
    }

    /// For a service that holds the host: reports through a weak reference so neither keeps the other alive.
    pub fn connect_weak<T: Send + Sync + 'static>(&self, target: Weak<T>, f: fn(&T, Value)) {
        self.connect(Arc::new(move |m| {
            if let Some(t) = target.upgrade() {
                f(&t, m);
            }
        }));
    }
}

impl DbHostLink for UnavailableHost {
    fn ensure(&self) -> bool {
        true
    }

    fn send(&self, m: ToHost) -> bool {
        if let ToHost::Open { id, .. } = m
            && let Some(report) = self.report.get().cloned()
        {
            // After the answer that carries the id, like the host's own status messages.
            (self.spawn)(Box::pin(async move {
                report(json!({ "t": "dbStatus", "id": id, "phase": "error", "error": "unsupported" }));
            }));
        }
        true
    }

    fn request(&self, _id: &str, _op: Value, _window: Option<String>) -> BoxFuture<'static, Value> {
        Box::pin(async { failed("noSession") })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn op_timeouts_follow_the_operation() {
        assert_eq!(op_timeout_ms(&json!({ "op": "schemas" })), 120_000);
        assert_eq!(op_timeout_ms(&json!({ "op": "applyEdits" })), 600_000);
        assert_eq!(op_timeout_ms(&json!({ "op": "ddl" })), 600_000);
        assert_eq!(op_timeout_ms(&json!({ "op": "databases" })), 600_000);
        assert_eq!(op_timeout_ms(&json!({ "op": "cellValue" })), 300_000);
        assert_eq!(op_timeout_ms(&json!({ "op": "redis", "req": { "kind": "countPattern" } })), 3_600_000);
        assert_eq!(op_timeout_ms(&json!({ "op": "redis", "req": { "kind": "deletePattern" } })), 3_600_000);
        assert_eq!(op_timeout_ms(&json!({ "op": "redis", "req": { "kind": "command" } })), 360_000);
        assert_eq!(op_timeout_ms(&json!({ "op": "redis", "req": { "kind": "write" } })), 300_000);
        assert_eq!(op_timeout_ms(&json!({ "op": "redis", "req": { "kind": "readItem" } })), 300_000);
        assert_eq!(op_timeout_ms(&json!({ "op": "redis", "req": { "kind": "scan" } })), 120_000);
    }

    #[test]
    fn redis_operations_carry_a_deadline_with_a_margin() {
        assert_eq!(redis_deadline(1000, 120_000), 1000 + 110_000);
        assert_eq!(redis_deadline(0, 3_600_000), 3_590_000);
        assert_eq!(redis_deadline(0, 5000), 4500);
        assert_eq!(redis_deadline(0, 500), 1000);
        let op = with_deadline(json!({ "op": "redis", "req": { "kind": "scan" } }), 10);
        assert_eq!(op, json!({ "op": "redis", "req": { "kind": "scan" }, "deadline": 110_010 }));
        assert_eq!(with_deadline(json!({ "op": "schemas" }), 10), json!({ "op": "schemas" }));
    }

    #[tokio::test(start_paused = true)]
    async fn pending_requests_answer_time_out_or_fail_on_a_crash() {
        let p = Arc::new(PendingRequests::default());
        let (a, wait_a) = p.start(1000);
        let (_b, wait_b) = p.start(1000);
        let (_c, wait_c) = p.start(50);
        p.resolve(a, json!({ "ok": true, "value": 1 }));
        assert_eq!(wait_a.await, json!({ "ok": true, "value": 1 }));
        assert_eq!(wait_c.await, json!({ "ok": false, "error": "dbTimeout" }));
        p.fail_all();
        assert_eq!(wait_b.await, json!({ "ok": false, "error": "dbHostCrashed" }));
        assert!(p.is_empty());
    }

    #[test]
    fn more_than_five_crashes_in_a_minute_are_fatal() {
        let mut c = CrashCounter::default();
        for t in 0..5 {
            assert!(!c.record(t * 1000));
        }
        assert!(!c.record(61_000), "the first ones are older than a minute");
        let mut c = CrashCounter::default();
        for t in 0..5 {
            c.record(t);
        }
        assert!(c.record(10) && c.fatal());
    }
}
