//! D12: which window's DB port gets a session message (1.1.4 src/shared/dbPortRoutes.ts and the port half of
//! src/dbhost/index.ts). Every window has its own port (`mc:db-port`, attached by the page on every load); a result goes to
//! the window that asked for it. Rows, statement ends and notices are keyed by query id: the window that sent the query,
//! the table page or the "load more" gets them. Redis Pub/Sub messages are keyed by session: the window that subscribed
//! (or the one its tab moved to) gets them. Anything unknown goes to the main window, and so does a message for a window
//! whose port is gone or reloading (`pickPort`).
//!
//! [`DbPorts`] is the `db` [`PortOwner`] of the app: the windows' sinks plus the routes. Messages are posted as JSON text
//! written by the sessions' own writers (`JSON.stringify` output, lone surrogates included), never re-encoded.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::Value;
use unimux_ipc::ports::{PortOwner, PortSink};

pub const MAIN_DB_WINDOW: &str = "main";
/// Query routes kept at most (oldest go first; a query that old has long ended).
pub const DB_ROUTE_QUERIES_MAX: usize = 4096;

/// `isWindow`: a non-empty string of at most 128 UTF-16 units.
fn is_window(w: Option<&str>) -> Option<&str> {
    w.filter(|w| !w.is_empty() && w.encode_utf16().count() <= 128)
}

/// `DbPortRoutes`.
pub struct DbPortRoutes {
    max_queries: usize,
    /// query id -> (window, insertion number); `order` keeps the Map order of 1.1.4 (a set again moves to the end).
    queries: HashMap<String, (String, u64)>,
    order: BTreeMap<u64, String>,
    next: u64,
    sessions: HashMap<String, String>,
}

impl Default for DbPortRoutes {
    fn default() -> Self {
        Self::new(DB_ROUTE_QUERIES_MAX)
    }
}

impl DbPortRoutes {
    pub fn new(max_queries: usize) -> Self {
        DbPortRoutes { max_queries, queries: HashMap::new(), order: BTreeMap::new(), next: 0, sessions: HashMap::new() }
    }

    /// `noteOp`: an operation from `window` (None: the main window); its results go back there.
    pub fn note_op(&mut self, session_id: &str, op: &Value, window: Option<&str>) {
        let w = is_window(window).unwrap_or(MAIN_DB_WINDOW).to_owned();
        let query_id = match op.get("op").and_then(Value::as_str) {
            Some("query" | "tablePage") => op.pointer("/req/queryId"),
            Some("fetchMore") => op.get("queryId"),
            _ => None,
        };
        if let Some(q) = query_id.and_then(Value::as_str).filter(|q| !q.is_empty()) {
            self.set_query(q, &w);
        }
        // Pub/Sub messages name the session only: the window that changes or reads the subscriptions owns them.
        if op.get("op").and_then(Value::as_str) == Some("redis")
            && matches!(op.pointer("/req/kind").and_then(Value::as_str), Some("subscribe" | "unsubscribe" | "pubsubState"))
        {
            self.set_session(session_id, &w);
        }
    }

    /// `moveSessions`: a tab moved to another window; messages of its sessions follow it (None: the main window).
    pub fn move_sessions(&mut self, ids: &[String], window: Option<&str>) {
        let w = is_window(window).unwrap_or(MAIN_DB_WINDOW).to_owned();
        for id in ids {
            self.set_session(id, &w);
        }
    }

    /// `forgetSession`: a session ended, its route goes.
    pub fn forget_session(&mut self, id: &str) {
        self.sessions.remove(id);
    }

    /// The receiving window of a message keyed by query id.
    pub fn query_target(&self, query_id: &str) -> &str {
        self.queries.get(query_id).map_or(MAIN_DB_WINDOW, |(w, _)| w.as_str())
    }

    /// The receiving window of a message keyed by session id.
    pub fn session_target(&self, session_id: &str) -> &str {
        self.sessions.get(session_id).map_or(MAIN_DB_WINDOW, String::as_str)
    }

    /// `target`: the receiving window of a port message as JSON (`queryId` first, then `sessionId`).
    pub fn target(&self, m: &Value) -> &str {
        if let Some(q) = m.get("queryId").and_then(Value::as_str) {
            return self.query_target(q);
        }
        if let Some(s) = m.get("sessionId").and_then(Value::as_str) {
            return self.session_target(s);
        }
        MAIN_DB_WINDOW
    }

    pub fn query_count(&self) -> usize {
        self.queries.len()
    }

    fn set_query(&mut self, query_id: &str, window: &str) {
        if let Some((_, n)) = self.queries.remove(query_id) {
            self.order.remove(&n);
        }
        if window != MAIN_DB_WINDOW {
            self.next += 1;
            self.queries.insert(query_id.to_owned(), (window.to_owned(), self.next));
            self.order.insert(self.next, query_id.to_owned());
        }
        while self.queries.len() > self.max_queries {
            let Some((_, oldest)) = self.order.pop_first() else { break };
            self.queries.remove(&oldest);
        }
    }

    fn set_session(&mut self, id: &str, window: &str) {
        if window == MAIN_DB_WINDOW {
            self.sessions.remove(id);
        } else {
            self.sessions.insert(id.to_owned(), window.to_owned());
        }
    }
}

/// The window id of a webview label: `main`, or a detached window's id (other webviews have no DB port).
fn window_of_label(label: &str) -> Option<String> {
    if label == MAIN_DB_WINDOW {
        return Some(MAIN_DB_WINDOW.to_owned());
    }
    unimux_ipc::route::detached_id(label)
}

/// The DB ports of the windows and the routes between them (the `db` port owner).
#[derive(Default)]
pub struct DbPorts {
    routes: Mutex<DbPortRoutes>,
    sinks: Mutex<HashMap<String, Arc<dyn PortSink>>>,
}

impl DbPorts {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn note_op(&self, session_id: &str, op: &Value, window: Option<&str>) {
        self.routes.lock().note_op(session_id, op, window);
    }

    pub fn move_sessions(&self, ids: &[String], window: Option<&str>) {
        if !ids.is_empty() {
            self.routes.lock().move_sessions(ids, window);
        }
    }

    pub fn forget_session(&self, id: &str) {
        self.routes.lock().forget_session(id);
    }

    /// A message keyed by query id (Postgres, MySQL, SQLite results), already written as JSON.
    pub fn post_query(&self, query_id: &str, json: String) {
        let window = self.routes.lock().query_target(query_id).to_owned();
        self.post_to(&window, json);
    }

    /// A message as JSON value (Redis Pub/Sub, keyed by `sessionId`).
    pub fn post_value(&self, m: &Value) {
        let window = self.routes.lock().target(m).to_owned();
        if let Ok(text) = serde_json::to_string(m) {
            self.post_to(&window, text);
        }
    }

    /// `pickPort`: the window's port, else the main window's (no port at all: dropped, the renderer is reloading).
    fn post_to(&self, window: &str, json: String) {
        let sink = {
            let sinks = self.sinks.lock();
            sinks.get(window).or_else(|| sinks.get(MAIN_DB_WINDOW)).cloned()
        };
        if let Some(sink) = sink {
            let _ = sink.post_json_text(json);
        }
    }

    /// Windows with a port (tests).
    pub fn windows(&self) -> Vec<String> {
        let mut w: Vec<String> = self.sinks.lock().keys().cloned().collect();
        w.sort();
        w
    }
}

impl PortOwner for DbPorts {
    fn attach(&self, label: &str, sink: Arc<dyn PortSink>) {
        let Some(window) = window_of_label(label) else { return };
        if let Some(old) = self.sinks.lock().insert(window, sink) {
            old.close();
        }
    }

    fn post(&self, _label: &str, _message: Value) {
        // The DB port carries host -> renderer messages only.
    }

    fn detach(&self, label: &str) {
        let Some(window) = window_of_label(label) else { return };
        if let Some(old) = self.sinks.lock().remove(&window) {
            old.close();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn query(q: &str) -> Value {
        json!({ "op": "query", "req": { "queryId": q, "sql": "select 1" } })
    }

    #[test]
    fn results_go_to_the_window_that_asked() {
        let mut r = DbPortRoutes::default();
        r.note_op("db:a", &query("q1"), Some("w1"));
        r.note_op("db:a", &json!({ "op": "tablePage", "req": { "queryId": "q2" } }), Some("w2"));
        r.note_op("db:a", &query("q3"), None);
        assert_eq!(r.target(&json!({ "t": "rows", "queryId": "q1" })), "w1");
        assert_eq!(r.target(&json!({ "t": "rows", "queryId": "q2" })), "w2");
        assert_eq!(r.target(&json!({ "t": "rows", "queryId": "q3" })), "main");
        assert_eq!(r.target(&json!({ "t": "rows", "queryId": "unknown" })), "main");
        // a "load more" from the main window takes the query back
        r.note_op("db:a", &json!({ "op": "fetchMore", "queryId": "q1", "count": 100 }), Some("main"));
        assert_eq!(r.query_target("q1"), "main");
        assert_eq!(r.query_count(), 1);
        // not a window: the main window
        r.note_op("db:a", &query("q4"), Some(""));
        r.note_op("db:a", &query("q5"), Some(&"x".repeat(129)));
        assert_eq!(r.query_target("q4"), "main");
        assert_eq!(r.query_target("q5"), "main");
        r.note_op("db:a", &query("q6"), Some(&"x".repeat(128)));
        assert_eq!(r.query_target("q6"), "x".repeat(128));
    }

    #[test]
    fn query_routes_are_capped_oldest_first() {
        let mut r = DbPortRoutes::new(3);
        for q in ["a", "b", "c"] {
            r.note_op("db:s", &query(q), Some("w"));
        }
        // set again: moves to the end of the order
        r.note_op("db:s", &query("a"), Some("w2"));
        r.note_op("db:s", &query("d"), Some("w"));
        assert_eq!(r.query_count(), 3);
        assert_eq!(r.query_target("b"), "main", "the oldest went");
        assert_eq!(r.query_target("a"), "w2");
        assert_eq!(r.query_target("c"), "w");
        assert_eq!(r.query_target("d"), "w");
        let mut big = DbPortRoutes::default();
        for i in 0..(DB_ROUTE_QUERIES_MAX + 10) {
            big.note_op("db:s", &query(&format!("q{i}")), Some("w"));
        }
        assert_eq!(big.query_count(), DB_ROUTE_QUERIES_MAX);
        assert_eq!(big.query_target("q9"), "main");
        assert_eq!(big.query_target("q10"), "w");
    }

    #[test]
    fn pubsub_follows_the_subscribing_window_and_moved_tabs() {
        let mut r = DbPortRoutes::default();
        let sub = json!({ "op": "redis", "req": { "kind": "subscribe", "channels": ["x"] } });
        r.note_op("db:r", &sub, Some("w1"));
        assert_eq!(r.target(&json!({ "t": "redisPubSub", "sessionId": "db:r" })), "w1");
        // other Redis operations do not move it
        r.note_op("db:r", &json!({ "op": "redis", "req": { "kind": "scan" } }), Some("w2"));
        assert_eq!(r.session_target("db:r"), "w1");
        r.move_sessions(&["db:r".to_owned()], Some("w3"));
        assert_eq!(r.session_target("db:r"), "w3");
        r.move_sessions(&["db:r".to_owned()], None);
        assert_eq!(r.session_target("db:r"), "main");
        r.note_op("db:r", &json!({ "op": "redis", "req": { "kind": "pubsubState" } }), Some("w4"));
        assert_eq!(r.session_target("db:r"), "w4");
        r.forget_session("db:r");
        assert_eq!(r.session_target("db:r"), "main");
        // queryId wins over sessionId; neither: main
        assert_eq!(r.target(&json!({ "t": "x" })), "main");
    }

    struct Sink {
        name: &'static str,
        got: Arc<Mutex<Vec<(String, String)>>>,
        closed: Arc<Mutex<Vec<&'static str>>>,
    }

    impl PortSink for Sink {
        fn post_json(&self, _: &Value) -> bool {
            unreachable!("the DB port posts text")
        }
        fn post_bytes(&self, _: &[u8]) -> bool {
            true
        }
        fn post_json_text(&self, text: String) -> bool {
            self.got.lock().push((self.name.to_owned(), text));
            true
        }
        fn close(&self) {
            self.closed.lock().push(self.name);
        }
    }

    #[test]
    fn ports_pick_the_window_else_main_and_keep_the_text() {
        let got = Arc::new(Mutex::new(Vec::new()));
        let closed = Arc::new(Mutex::new(Vec::new()));
        let sink = |name| Arc::new(Sink { name, got: got.clone(), closed: closed.clone() }) as Arc<dyn PortSink>;
        let p = DbPorts::new();
        // nothing attached: dropped
        p.post_query("q", "{}".into());
        assert!(got.lock().is_empty());
        let w = "1b4e28ba-2fa1-11d2-883f-0016d3cca427";
        p.attach("main", sink("main1"));
        p.attach(&format!("detached-{w}"), sink("w"));
        p.attach("update-gate", sink("gate"));
        assert_eq!(p.windows(), vec![w.to_owned(), "main".to_owned()]);
        p.note_op("db:a", &query("q1"), Some(w));
        p.note_op("db:a", &query("q2"), Some("gone"));
        let lone = r#"{"t":"rows","queryId":"q1","index":0,"rows":[["\ud800"]]}"#.to_owned();
        p.post_query("q1", lone.clone());
        p.post_query("q2", "{\"q\":2}".into());
        p.post_value(&json!({ "t": "redisPubSub", "sessionId": "db:z" }));
        // a reload replaces the sink (the old one is closed)
        p.attach("main", sink("main2"));
        p.post_query("q3", "{\"q\":3}".into());
        p.detach(&format!("detached-{w}"));
        p.post_query("q1", "{\"q\":1}".into());
        let got = got.lock().clone();
        assert_eq!(got[0], ("w".to_owned(), lone));
        assert_eq!(got[1], ("main1".to_owned(), "{\"q\":2}".to_owned()));
        assert_eq!(got[2].0, "main1");
        assert_eq!(got[3], ("main2".to_owned(), "{\"q\":3}".to_owned()));
        assert_eq!(got[4], ("main2".to_owned(), "{\"q\":1}".to_owned()), "a closed window's results go to main");
        assert_eq!(*closed.lock(), vec!["main1", "w"]);
    }
}
