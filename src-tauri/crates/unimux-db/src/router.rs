//! D12: the DB Host as one unit in front of the session hosts (1.1.4 src/main/dbHostClient.ts with the routing of
//! src/dbhost/index.ts). In 1.1.4 every session lived in one utility process; here they are tasks and threads of this
//! process, so [`DbRouter`] keeps what the process boundary gave:
//!
//! - **Routing**: every operation is noted with the window that asked ([`DbPorts::note_op`]), a closed session's route goes,
//!   a moved tab's sessions follow it ([`DbRouter::route`]); the hosts post their port messages through [`DbPorts`].
//! - **Crashes**: the hosts' tasks run on a [`supervised`] spawn; a task that panics counts as a crash of the DB Host, as
//!   the process exit did: every session ends (the service marks them `dbHostCrashed` and sends `db:hostCrashed`, so the
//!   renderer drops its loads), every waiting request answers `dbHostCrashed`, and the next use works again. More than 5
//!   crashes within 60 s are fatal: no new session until the app restarts (`ensure()` false).
//! - **Shutdown**: the wind-down closes every session and every tunnel, waits 200 ms for the goodbyes, and fails what
//!   still waits; no session opens after it started.

use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::Value;

use crate::host::{CrashCounter, DbHostLink, PendingRequests, Spawn, ToHost, op_timeout_ms};
use crate::route::DbPorts;

/// How long the wind-down waits for the sessions' goodbyes (Terminate, COM_QUIT, QUIT, SSH disconnect).
pub const SHUTDOWN_GOODBYE_MS: u64 = 200;
/// `DB_SHUTDOWN_WAIT_MS`: the wind-down step's limit.
pub const DB_SHUTDOWN_WAIT_MS: u64 = 3000;

/// Where a panic of a supervised task is reported (set once the router exists).
#[derive(Default)]
pub struct CrashSignal {
    target: OnceLock<Weak<DbRouter>>,
}

impl CrashSignal {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn fire(&self, detail: String) {
        if let Some(r) = self.target.get().and_then(Weak::upgrade) {
            r.crashed(&detail);
        }
    }
}

/// The text of a panic payload.
fn panic_text(p: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        (*s).to_owned()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "panic".to_owned()
    }
}

/// A spawn whose tasks report a panic to `signal` (the DB Host's crash), on top of `inner`.
pub fn supervised(inner: Spawn, signal: Arc<CrashSignal>) -> Spawn {
    Arc::new(move |f: BoxFuture<'static, ()>| {
        let signal = signal.clone();
        inner(Box::pin(async move {
            if let Err(p) = AssertUnwindSafe(f).catch_unwind().await {
                signal.fire(panic_text(p.as_ref()));
            }
        }));
    })
}

pub struct DbRouterDeps {
    /// The first session host of the chain (Redis -> MySQL -> Postgres -> SQLite -> unavailable).
    pub next: Arc<dyn DbHostLink>,
    pub ports: Arc<DbPorts>,
    /// The (unsupervised) spawn for the router's own waits.
    pub spawn: Spawn,
    pub signal: Arc<CrashSignal>,
    /// Ends every session of one host (in chain order) and then the tunnels.
    pub close_all: Vec<Arc<dyn Fn() + Send + Sync>>,
    /// `db.hostCrashed()` of main: the service ends its sessions and sends `db:hostCrashed`.
    pub crashed: Arc<dyn Fn() + Send + Sync>,
    /// The crash log (`db host crashed: ...`).
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
}

/// The DB Host (see the module text).
pub struct DbRouter {
    me: Weak<DbRouter>,
    deps: DbRouterDeps,
    pending: Arc<PendingRequests>,
    crashes: Mutex<CrashCounter>,
    shutting_down: AtomicBool,
}

impl DbRouter {
    pub fn new(deps: DbRouterDeps) -> Arc<DbRouter> {
        let r = Arc::new_cyclic(|me| DbRouter {
            me: me.clone(),
            deps,
            pending: Arc::new(PendingRequests::default()),
            crashes: Mutex::new(CrashCounter::default()),
            shutting_down: AtomicBool::new(false),
        });
        let _ = r.deps.signal.target.set(Arc::downgrade(&r));
        r
    }

    pub fn ports(&self) -> &Arc<DbPorts> {
        &self.deps.ports
    }

    /// `route(sessions, window)`: a tab moved to another window, the Pub/Sub messages of its sessions follow it (None: the
    /// main window).
    pub fn route(&self, sessions: &[String], window: Option<&str>) {
        self.deps.ports.move_sessions(sessions, window);
    }

    /// Requests waiting for an answer (tests).
    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }

    pub fn fatal(&self) -> bool {
        self.crashes.lock().fatal()
    }

    fn close_all(&self) {
        for f in &self.deps.close_all {
            f();
        }
    }

    /// A supervised task panicked: the DB Host crashed (see the module text).
    pub fn crashed(&self, detail: &str) {
        if self.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let fatal = self.crashes.lock().record((self.deps.now)());
        (self.deps.log)(&format!("db host crashed: {}", detail.chars().take(4000).collect::<String>()));
        // The service first: once it forgot the sessions, the hosts' "closed" reports below are dropped.
        (self.deps.crashed)();
        self.close_all();
        self.pending.fail_all();
        if fatal {
            (self.deps.log)("db host crashed more than 5 times within a minute: no new sessions until the app restarts");
        }
    }

    /// The wind-down's HOSTS step (1.1.4 `dbHost.shutdown()`).
    pub async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.close_all();
        tokio::time::sleep(Duration::from_millis(SHUTDOWN_GOODBYE_MS)).await;
        self.pending.fail_all();
    }

    /// The hard limit of the quit: the sessions are cut without waiting.
    pub fn force_kill(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        self.close_all();
        self.pending.fail_all();
    }
}

impl DbHostLink for DbRouter {
    fn ensure(&self) -> bool {
        !self.shutting_down.load(Ordering::SeqCst) && !self.fatal() && self.deps.next.ensure()
    }

    fn send(&self, m: ToHost) -> bool {
        if self.shutting_down.load(Ordering::SeqCst) && matches!(m, ToHost::Open { .. }) {
            return false;
        }
        if let ToHost::Close { id } = &m {
            self.deps.ports.forget_session(id);
        }
        self.deps.next.send(m)
    }

    fn request(&self, id: &str, op: Value, window: Option<String>) -> BoxFuture<'static, Value> {
        if self.shutting_down.load(Ordering::SeqCst) {
            return Box::pin(async { serde_json::json!({ "ok": false, "error": "noSession" }) });
        }
        self.deps.ports.note_op(id, &op, window.as_deref());
        let (rid, wait) = self.pending.start(op_timeout_ms(&op));
        let answer = self.deps.next.request(id, op, window);
        let me = self.me.clone();
        (self.deps.spawn)(Box::pin(async move {
            let result = answer.await;
            if let Some(r) = me.upgrade() {
                r.pending.resolve(rid, result);
            }
        }));
        wait
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::host::UnavailableHost;
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;

    fn spawn() -> Spawn {
        Arc::new(|f| {
            tokio::spawn(f);
        })
    }

    /// A host whose operations never answer (a session stuck in its op) and whose `panic` op panics on a supervised task.
    struct Stuck {
        spawn: Spawn,
    }

    impl DbHostLink for Stuck {
        fn ensure(&self) -> bool {
            true
        }
        fn send(&self, _m: ToHost) -> bool {
            true
        }
        fn request(&self, _id: &str, op: Value, _window: Option<String>) -> BoxFuture<'static, Value> {
            if op.get("op").and_then(Value::as_str) == Some("panic") {
                (self.spawn)(Box::pin(async { panic!("session task panicked") }));
            }
            Box::pin(futures::future::pending())
        }
    }

    struct Fixture {
        router: Arc<DbRouter>,
        crashed: Arc<AtomicUsize>,
        closed: Arc<AtomicUsize>,
        logs: Arc<Mutex<Vec<String>>>,
    }

    fn fixture() -> Fixture {
        let signal = CrashSignal::new();
        let host_spawn = supervised(spawn(), signal.clone());
        let crashed = Arc::new(AtomicUsize::new(0));
        let closed = Arc::new(AtomicUsize::new(0));
        let logs = Arc::new(Mutex::new(Vec::new()));
        let (c, k, l) = (crashed.clone(), closed.clone(), logs.clone());
        let router = DbRouter::new(DbRouterDeps {
            next: Arc::new(Stuck { spawn: host_spawn }),
            ports: DbPorts::new(),
            spawn: spawn(),
            signal,
            close_all: vec![Arc::new(move || {
                k.fetch_add(1, Ordering::SeqCst);
            })],
            crashed: Arc::new(move || {
                c.fetch_add(1, Ordering::SeqCst);
            }),
            log: Arc::new(move |m| l.lock().push(m.to_owned())),
            now: Arc::new(|| 1000),
        });
        Fixture { router, crashed, closed, logs }
    }

    #[tokio::test]
    async fn a_panicking_session_task_is_a_host_crash_and_the_host_recovers() {
        let f = fixture();
        let waiting = f.router.request("db:a", json!({ "op": "schemas" }), None);
        let panics = f.router.request("db:b", json!({ "op": "panic" }), Some("w1".into()));
        assert_eq!(waiting.await, json!({ "ok": false, "error": "dbHostCrashed" }));
        assert_eq!(panics.await, json!({ "ok": false, "error": "dbHostCrashed" }));
        assert_eq!(f.crashed.load(Ordering::SeqCst), 1);
        assert_eq!(f.closed.load(Ordering::SeqCst), 1);
        assert!(f.logs.lock()[0].starts_with("db host crashed: session task panicked"));
        assert!(f.router.ensure(), "one crash: the next use starts again");
        assert_eq!(f.router.pending_count(), 0);
    }

    #[tokio::test]
    async fn more_than_five_crashes_in_a_minute_are_fatal() {
        let f = fixture();
        for _ in 0..5 {
            f.router.crashed("x");
            assert!(f.router.ensure());
        }
        f.router.crashed("x");
        assert!(!f.router.ensure());
        assert_eq!(f.crashed.load(Ordering::SeqCst), 6);
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_closes_everything_and_refuses_new_sessions() {
        let f = fixture();
        let waiting = f.router.request("db:a", json!({ "op": "schemas" }), None);
        f.router.shutdown().await;
        assert_eq!(waiting.await, json!({ "ok": false, "error": "dbHostCrashed" }));
        assert_eq!(f.closed.load(Ordering::SeqCst), 1);
        assert!(!f.router.ensure());
        assert!(!f.router.send(ToHost::Open { id: "db:x".into(), config: json!({}) }));
        // a crash while shutting down is not counted
        f.router.crashed("late");
        assert_eq!(f.crashed.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn operations_are_routed_and_closed_sessions_forget_their_route() {
        let signal = CrashSignal::new();
        let next = UnavailableHost::new(spawn());
        let ports = DbPorts::new();
        let router = DbRouter::new(DbRouterDeps {
            next,
            ports: ports.clone(),
            spawn: spawn(),
            signal,
            close_all: vec![],
            crashed: Arc::new(|| {}),
            log: Arc::new(|_| {}),
            now: Arc::new(|| 0),
        });
        let sub = json!({ "op": "redis", "req": { "kind": "subscribe", "channels": ["c"] } });
        assert_eq!(router.request("db:r", sub, Some("w".into())).await, json!({ "ok": false, "error": "noSession" }));
        let q = json!({ "op": "query", "req": { "queryId": "q1" } });
        let _ = router.request("db:r", q, Some("w".into())).await;
        // (the routes are internal to DbPorts: checked through a posted message)
        struct Sink(Arc<Mutex<Vec<String>>>);
        impl unimux_ipc::ports::PortSink for Sink {
            fn post_json(&self, _: &Value) -> bool {
                true
            }
            fn post_bytes(&self, _: &[u8]) -> bool {
                true
            }
            fn post_json_text(&self, t: String) -> bool {
                self.0.lock().push(t);
                true
            }
        }
        use unimux_ipc::ports::PortOwner;
        let (main, w) = (Arc::new(Mutex::new(Vec::new())), Arc::new(Mutex::new(Vec::new())));
        ports.attach("main", Arc::new(Sink(main.clone())));
        ports.attach("detached-w", Arc::new(Sink(w.clone())));
        router.route(&["db:r".to_owned()], Some("w"));
        ports.post_query("q1", "1".into());
        ports.post_value(&json!({ "sessionId": "db:r" }));
        router.send(ToHost::Close { id: "db:r".into() });
        ports.post_value(&json!({ "sessionId": "db:r" }));
        assert_eq!(w.lock().len(), 2);
        assert_eq!(main.lock().len(), 1);
    }
}
