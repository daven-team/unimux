//! The SQL query history (port of src/shared/dbHistory.ts and src/main/db/history.ts): every statement a SQL editor ran, per
//! saved connection, in `<data>/db/query_history.json` (0600 on POSIX), local only. Passwords are masked (`redactSql`),
//! 1000 entries per connection plus up to 500 favourites, 500 connections. Loaded on first use; writes are batched (1.5 s)
//! and atomic, and flushed at quit. A file from a newer version, or one that is not a history file, is never written over.
//!
//! Entries are kept as JSON objects in the key order the TS code builds them (a new entry is `{...record, id}`, a starred
//! one gets `star` last), so the file 1.2.0 writes is the file 1.1.4 would write.

use std::path::PathBuf;
use std::sync::{Arc, Weak};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use unimux_core::js_json;
use unimux_state::normalize::js;

use crate::files::{ReadJson, ensure_private_dir, exists, read_json_file, write_private_file};
use crate::sql::redact_sql;
use crate::timers::{TimerId, Timers};

/// `DB_HISTORY_LIMITS`.
pub mod limits {
    pub const PER_CONNECTION: usize = 1000;
    pub const STARS: usize = 500;
    pub const SQL_CHARS: usize = 16 * 1024;
    pub const ERROR_CHARS: usize = 300;
    pub const PER_RUN: usize = 100;
    pub const CONNECTIONS: usize = 500;
}
pub const VERSION: f64 = 1.0;
/// The batched write of the store.
pub const WRITE_DELAY_MS: u64 = 1500;

fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite())
}

fn valid_id(id: &str) -> bool {
    (1..=40).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `rows`: a finite count >= 0, rounded, else null.
fn rows_of(v: Option<&Value>) -> Value {
    match finite(v) {
        Some(n) if n >= 0.0 => js::num(js::round(n)),
        _ => Value::Null,
    }
}

/// `normalizeHistoryItem`: an entry as stored or sent, or None when it cannot be used.
pub fn normalize_history_item(raw: &Value) -> Option<Value> {
    let r = raw.as_object()?;
    let id = r.get("id").and_then(Value::as_str).filter(|id| valid_id(id))?;
    let sql = r.get("sql").and_then(Value::as_str)?;
    if js::trim(sql).is_empty() || js::len16(sql) > limits::SQL_CHARS {
        return None;
    }
    let at = finite(r.get("at")).filter(|n| *n >= 0.0)?;
    let time_ms = finite(r.get("timeMs")).filter(|n| *n >= 0.0)?;
    let ok = r.get("ok").and_then(Value::as_bool)?;
    let mut item = Map::new();
    item.insert("id".into(), json!(id));
    item.insert("sql".into(), json!(sql));
    item.insert("at".into(), js::num(at));
    item.insert("timeMs".into(), js::num(js::round(time_ms)));
    item.insert("rows".into(), rows_of(r.get("rows")));
    item.insert("ok".into(), json!(ok));
    if let Some(e) = r.get("error").and_then(Value::as_str).filter(|e| !e.is_empty()) {
        item.insert("error".into(), json!(js::slice16(e, limits::ERROR_CHARS)));
    }
    if r.get("star") == Some(&Value::Bool(true)) {
        item.insert("star".into(), json!(true));
    }
    Some(Value::Object(item))
}

/// `historyRecord`: a record from the renderer as it is stored (text trimmed and masked, the error cut to one line), or
/// None when it is not kept.
pub fn history_record(raw: &Value) -> Option<Value> {
    let r = raw.as_object()?;
    let sql = r.get("sql").and_then(Value::as_str)?;
    let ok = r.get("ok").and_then(Value::as_bool)?;
    let at = finite(r.get("at"))?;
    let time_ms = finite(r.get("timeMs"))?;
    let sql = redact_sql(js::trim(sql));
    if sql.is_empty() || js::len16(&sql) > limits::SQL_CHARS {
        return None;
    }
    let mut rec = Map::new();
    rec.insert("sql".into(), json!(sql));
    rec.insert("at".into(), js::num(at.max(0.0)));
    rec.insert("timeMs".into(), js::num(js::round(time_ms).max(0.0)));
    rec.insert("rows".into(), rows_of(r.get("rows")));
    rec.insert("ok".into(), json!(ok));
    if let Some(e) = r.get("error").and_then(Value::as_str) {
        let trimmed = js::trim(e);
        if !trimmed.is_empty() {
            // A server error may quote the statement (and its password).
            let first = trimmed.split('\n').next().unwrap_or_default();
            rec.insert("error".into(), json!(js::slice16(&redact_sql(first), limits::ERROR_CHARS)));
        }
    }
    Some(Value::Object(rec))
}

fn is_star(e: &Value) -> bool {
    js::truthy(e.get("star"))
}

/// `addHistory`: records (newest last) go in front of the entries (newest first); the oldest entries that are not favourites
/// beyond `limit` are dropped.
pub fn add_history(entries: &[Value], records: &[Value], next_id: &mut dyn FnMut() -> String, limit: usize) -> Vec<Value> {
    let mut added: Vec<Value> = records
        .iter()
        .map(|r| {
            let mut m = r.as_object().cloned().unwrap_or_default();
            m.insert("id".into(), json!(next_id()));
            Value::Object(m)
        })
        .collect();
    added.reverse();
    let mut plain = 0;
    added
        .into_iter()
        .chain(entries.iter().cloned())
        .filter(|e| {
            if is_star(e) {
                return true;
            }
            plain += 1;
            plain <= limit
        })
        .collect()
}

/// `starHistory`: stars or unstars one entry; None when it is not there or the favourites are full.
pub fn star_history(entries: &[Value], id: &str, star: bool) -> Option<Vec<Value>> {
    let at = entries.iter().position(|e| e.get("id").and_then(Value::as_str) == Some(id))?;
    if star && !is_star(&entries[at]) && entries.iter().filter(|e| is_star(e)).count() >= limits::STARS {
        return None;
    }
    Some(
        entries
            .iter()
            .enumerate()
            .map(|(i, e)| {
                if i != at {
                    return e.clone();
                }
                let mut rest = e.as_object().cloned().unwrap_or_default();
                rest.shift_remove("star");
                if star {
                    rest.insert("star".into(), json!(true));
                }
                Value::Object(rest)
            })
            .collect(),
    )
}

/// `clearHistoryEntries`: the favourites stay unless `stars` too.
pub fn clear_history_entries(entries: &[Value], stars: bool) -> Vec<Value> {
    if stars { Vec::new() } else { entries.iter().filter(|e| is_star(e)).cloned().collect() }
}

/// What `normalizeHistoryFile` read.
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryFile {
    pub enabled: bool,
    /// Connection id -> entries, in file order.
    pub connections: Map<String, Value>,
    /// Written by a later version (kept as it is).
    pub newer: bool,
    /// Not a history file.
    pub invalid: bool,
}

/// `normalizeHistoryFile`: `{version, enabled, connections: {id: entries}}`.
pub fn normalize_history_file(raw: &Value) -> HistoryFile {
    let empty = |newer, invalid| HistoryFile { enabled: true, connections: Map::new(), newer, invalid };
    let Some(r) = raw.as_object() else { return empty(false, true) };
    let Some(version) = r.get("version").and_then(Value::as_f64) else { return empty(false, true) };
    if version > VERSION {
        return empty(true, false);
    }
    let mut connections = Map::new();
    if let Some(list) = r.get("connections").and_then(Value::as_object) {
        for (id, entries) in list {
            let Some(entries) = entries.as_array().filter(|_| js::is_uuid(Some(&json!(id)))) else { continue };
            let mut seen = std::collections::HashSet::new();
            let items: Vec<Value> = entries
                .iter()
                .filter_map(normalize_history_item)
                .filter(|e| seen.insert(e["id"].as_str().unwrap_or_default().to_string()))
                .take(limits::PER_CONNECTION + limits::STARS)
                .collect();
            if !items.is_empty() {
                connections.insert(id.clone(), Value::Array(items));
            }
            if connections.len() >= limits::CONNECTIONS {
                break;
            }
        }
    }
    HistoryFile { enabled: r.get("enabled") != Some(&Value::Bool(false)), connections, newer: false, invalid: false }
}

/// `searchHistory`: every word of the query in the statement (any case); only favourites with `starred`.
pub fn search_history(entries: &[Value], query: &str, starred: bool) -> Vec<Value> {
    let lower = query.to_lowercase();
    let words: Vec<&str> = lower.split(js::is_space).filter(|w| !w.is_empty()).collect();
    entries
        .iter()
        .filter(|e| {
            let sql = e.get("sql").and_then(Value::as_str).unwrap_or_default().to_lowercase();
            (!starred || is_star(e)) && words.iter().all(|w| sql.contains(w))
        })
        .cloned()
        .collect()
}

/// `randomBytes(9).toString('base64url')`.
fn new_id() -> String {
    let mut bytes = [0u8; 9];
    let _ = getrandom::fill(&mut bytes);
    URL_SAFE_NO_PAD.encode(bytes)
}

struct Inner {
    connections: Option<Map<String, Value>>,
    enabled: bool,
    locked: bool,
    timer: Option<TimerId>,
    dirty: bool,
}

/// `DbHistoryStore`.
pub struct DbHistoryStore {
    file: PathBuf,
    connection_exists: Box<dyn Fn(&str) -> bool + Send + Sync>,
    timers: Arc<dyn Timers>,
    write_delay_ms: u64,
    next_id: Mutex<Box<dyn FnMut() -> String + Send>>,
    inner: Mutex<Inner>,
    me: Weak<DbHistoryStore>,
}

impl DbHistoryStore {
    pub fn new(
        file: impl Into<PathBuf>,
        connection_exists: impl Fn(&str) -> bool + Send + Sync + 'static,
        timers: Arc<dyn Timers>,
        write_delay_ms: u64,
    ) -> Arc<Self> {
        let file = file.into();
        Arc::new_cyclic(|me| Self {
            file,
            connection_exists: Box::new(connection_exists),
            timers,
            write_delay_ms,
            next_id: Mutex::new(Box::new(new_id)),
            inner: Mutex::new(Inner { connections: None, enabled: true, locked: false, timer: None, dirty: false }),
            me: me.clone(),
        })
    }

    /// Tests: the ids of new entries.
    pub fn set_id_source(&self, f: impl FnMut() -> String + Send + 'static) {
        *self.next_id.lock() = Box::new(f);
    }

    fn load<'a>(&self, inner: &'a mut Inner) -> &'a mut Map<String, Value> {
        if inner.connections.is_none() {
            match read_json_file(&self.file) {
                ReadJson::Ok(v) => {
                    let parsed = normalize_history_file(&v);
                    inner.locked = parsed.newer || parsed.invalid;
                    inner.enabled = parsed.enabled;
                    inner.connections = Some(parsed.connections);
                }
                // Missing, or unparsable and moved aside: start empty. Still there means unreadable: keep it.
                _ => {
                    inner.locked = exists(&self.file);
                    inner.connections = Some(Map::new());
                }
            }
        }
        inner.connections.as_mut().expect("loaded")
    }

    fn known(&self, id: &Value) -> Option<String> {
        let s = id.as_str()?;
        (js::is_uuid(Some(id)) && (self.connection_exists)(s)).then(|| s.to_string())
    }

    /// `list(connectionId)`: `{enabled, entries}`.
    pub fn list(&self, connection_id: &Value) -> Value {
        let mut inner = self.inner.lock();
        let known = self.known(connection_id);
        let all = self.load(&mut inner);
        let entries = known.and_then(|id| all.get(&id).cloned()).unwrap_or_else(|| json!([]));
        json!({ "enabled": inner.enabled, "entries": entries })
    }

    /// Records the statements of a run; false when refused (unknown connection, history off, a read-only file).
    pub fn record(&self, connection_id: &Value, raw: &Value) -> bool {
        let Some(id) = self.known(connection_id) else { return false };
        let Some(raw) = raw.as_array() else { return false };
        let mut inner = self.inner.lock();
        self.load(&mut inner);
        if inner.locked || !inner.enabled {
            return false;
        }
        let records: Vec<Value> = raw.iter().take(limits::PER_RUN).filter_map(history_record).collect();
        if records.is_empty() {
            return true;
        }
        let all = inner.connections.as_mut().expect("loaded");
        let current: Vec<Value> = all.get(&id).and_then(Value::as_array).cloned().unwrap_or_default();
        let next = {
            let mut ids = self.next_id.lock();
            add_history(&current, &records, &mut *ids, limits::PER_CONNECTION)
        };
        // The connection used last goes last in the map: the oldest one is the first dropped over the limit.
        all.shift_remove(&id);
        all.insert(id, Value::Array(next));
        while all.len() > limits::CONNECTIONS {
            let first = all.keys().next().cloned().expect("not empty");
            all.shift_remove(&first);
        }
        self.changed(&mut inner);
        true
    }

    pub fn star(&self, connection_id: &Value, id: &Value, star: &Value) -> bool {
        let Some(cid) = self.known(connection_id) else { return false };
        let (Some(id), Some(star)) = (id.as_str(), star.as_bool()) else { return false };
        let mut inner = self.inner.lock();
        self.load(&mut inner);
        if inner.locked {
            return false;
        }
        let all = inner.connections.as_mut().expect("loaded");
        let current: Vec<Value> = all.get(&cid).and_then(Value::as_array).cloned().unwrap_or_default();
        let Some(next) = star_history(&current, id, star) else { return false };
        all.insert(cid, Value::Array(next));
        self.changed(&mut inner);
        true
    }

    pub fn clear(&self, connection_id: &Value, stars: &Value) -> bool {
        if !js::is_uuid(Some(connection_id)) {
            return false;
        }
        let cid = connection_id.as_str().unwrap_or_default().to_string();
        let mut inner = self.inner.lock();
        self.load(&mut inner);
        if inner.locked {
            return false;
        }
        let all = inner.connections.as_mut().expect("loaded");
        let current: Vec<Value> = all.get(&cid).and_then(Value::as_array).cloned().unwrap_or_default();
        let left = clear_history_entries(&current, stars == &Value::Bool(true));
        if left.is_empty() {
            all.shift_remove(&cid);
        } else {
            all.insert(cid, Value::Array(left));
        }
        self.changed(&mut inner);
        self.flush_in(&mut inner);
        true
    }

    pub fn set_enabled(&self, enabled: &Value) -> bool {
        let Some(enabled) = enabled.as_bool() else { return false };
        let mut inner = self.inner.lock();
        self.load(&mut inner);
        if inner.locked {
            return false;
        }
        inner.enabled = enabled;
        self.changed(&mut inner);
        self.flush_in(&mut inner);
        true
    }

    fn changed(&self, inner: &mut Inner) {
        inner.dirty = true;
        if inner.timer.is_none() {
            let me = self.me.clone();
            inner.timer = Some(self.timers.after_with_id(
                self.write_delay_ms,
                Box::new(move |own_id| {
                    if let Some(store) = me.upgrade() {
                        let mut inner = store.inner.lock();
                        // Replaced: a flush cancelled this timer while it waited for the lock and a change set a new one.
                        if inner.timer != Some(own_id) {
                            return;
                        }
                        inner.timer = None;
                        store.flush_in(&mut inner);
                    }
                }),
            ));
        }
    }

    /// Writes pending changes now (app quit). A failed write is tried again with the next change.
    pub fn flush(&self) {
        let mut inner = self.inner.lock();
        self.flush_in(&mut inner);
    }

    fn flush_in(&self, inner: &mut Inner) {
        if let Some(t) = inner.timer.take() {
            self.timers.cancel(t);
        }
        if !inner.dirty || inner.locked {
            return;
        }
        let Some(all) = inner.connections.as_mut() else { return };
        let gone: Vec<String> = all.keys().filter(|id| !(self.connection_exists)(id)).cloned().collect();
        for id in gone {
            all.shift_remove(&id);
        }
        let mut file = Map::new();
        file.insert("version".into(), json!(1));
        file.insert("enabled".into(), json!(inner.enabled));
        file.insert("connections".into(), Value::Object(all.clone()));
        let text = js_json::stringify(&Value::Object(file));
        let written = self.file.parent().map_or(Ok(()), ensure_private_dir).and_then(|_| write_private_file(&self.file, &text));
        if written.is_ok() {
            inner.dirty = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timers::ManualTimers;
    use std::collections::HashSet;
    use std::fs;
    use std::sync::atomic::{AtomicUsize, Ordering};

    const C1: &str = "00000000-0000-4000-8000-000000000001";
    const C2: &str = "00000000-0000-4000-8000-000000000002";

    fn rec(sql: &str, at: f64, ok: bool) -> Value {
        json!({ "sql": sql, "at": at, "timeMs": 3, "rows": 1, "ok": ok })
    }

    fn sqls(list: &[Value]) -> Vec<String> {
        list.iter().map(|e| e["sql"].as_str().unwrap().to_string()).collect()
    }

    fn ids() -> impl FnMut() -> String {
        let n = AtomicUsize::new(0);
        move || format!("id{}", n.fetch_add(1, Ordering::SeqCst) + 1)
    }

    #[test]
    fn a_record_keeps_the_statement_with_passwords_masked_one_line_of_its_error_and_no_overlong_text() {
        assert_eq!(
            history_record(
                &json!({ "sql": "  CREATE USER u IDENTIFIED BY 'secret'  ", "at": 5, "timeMs": 2.6, "rows": 0, "ok": true })
            ),
            Some(json!({ "sql": "CREATE USER u IDENTIFIED BY '***'", "at": 5, "timeMs": 3, "rows": 0, "ok": true }))
        );
        let failed = history_record(
            &json!({ "sql": "SELECT x", "at": 5, "timeMs": 1, "rows": null, "ok": false, "error": "line one\nline two" }),
        )
        .unwrap();
        assert_eq!(
            (failed["ok"].clone(), failed["error"].clone(), failed["rows"].clone()),
            (json!(false), json!("line one"), Value::Null)
        );
        assert_eq!(history_record(&json!({ "sql": "x".repeat(20_000), "at": 1, "timeMs": 1, "rows": 1, "ok": true })), None);
        assert_eq!(history_record(&json!({ "sql": "   ", "at": 1, "timeMs": 1, "ok": true })), None);
        assert_eq!(history_record(&json!({ "sql": "SELECT 1", "at": "now", "timeMs": 1, "ok": true })), None);
    }

    #[test]
    fn newest_first_capped_per_connection_favourites_stay_over_the_cap_and_when_cleared() {
        let mut next = ids();
        let mut list = add_history(&[], &[rec("a", 1.0, true), rec("b", 2.0, true)], &mut next, 3);
        assert_eq!(sqls(&list), ["b", "a"]);
        let id = list[1]["id"].as_str().unwrap().to_string();
        list = star_history(&list, &id, true).unwrap();
        list = add_history(&list, &[rec("c", 3.0, true), rec("d", 4.0, true), rec("e", 5.0, true)], &mut next, 3);
        let marked: Vec<String> =
            list.iter().map(|e| format!("{}{}", e["sql"].as_str().unwrap(), if is_star(e) { "*" } else { "" })).collect();
        assert_eq!(marked, ["e", "d", "c", "a*"]);
        assert_eq!(search_history(&list, "A", false).len(), 1);
        assert_eq!(sqls(&search_history(&list, "", true)), ["a"]);
        assert_eq!(sqls(&clear_history_entries(&list, false)), ["a"]);
        assert!(clear_history_entries(&list, true).is_empty());
        assert_eq!(star_history(&list, "nope", true), None);
        let id3 = list[3]["id"].as_str().unwrap().to_string();
        let unstarred = star_history(&list, &id3, false).unwrap();
        assert!(unstarred[3].get("star").is_none());
    }

    #[test]
    fn a_stored_file_is_read_with_its_switch_a_newer_or_broken_one_is_left_alone() {
        let entry = json!({ "id": "x1", "sql": "SELECT 1", "at": 1, "timeMs": 1, "rows": 1, "ok": true });
        let parsed = normalize_history_file(&json!({ "version": 1, "enabled": false, "connections": {
            C1: [entry, entry.clone(), { "id": "bad id!", "sql": "x" }], "nope": [entry] } }));
        let mut want = Map::new();
        want.insert(C1.into(), json!([entry]));
        assert_eq!(parsed, HistoryFile { enabled: false, connections: want, newer: false, invalid: false });
        assert!(normalize_history_file(&json!({ "version": 2 })).newer);
        assert!(normalize_history_file(&json!([])).invalid);
    }

    fn store(file: &std::path::Path, live: Arc<Mutex<HashSet<String>>>, timers: Arc<ManualTimers>) -> Arc<DbHistoryStore> {
        let s = DbHistoryStore::new(file, move |id| live.lock().contains(id), timers, 1_000_000);
        s.set_id_source(ids());
        s
    }

    #[test]
    fn records_stars_clears_and_writes_atomically_deleted_connections_are_dropped_the_switch_stops_recording() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("h1.json");
        let live = Arc::new(Mutex::new(HashSet::from([C1.to_string(), C2.to_string()])));
        let timers = Arc::new(ManualTimers::default());
        let s = store(&file, live.clone(), timers.clone());
        assert_eq!(s.list(&json!(C1)), json!({ "enabled": true, "entries": [] }));
        assert!(s.record(&json!(C1), &json!([rec("SELECT 1", 1.0, true), rec("ALTER USER x PASSWORD 'p'", 1.0, true)])));
        assert!(!s.record(&json!("00000000-0000-4000-8000-000000000009"), &json!([rec("x", 1.0, true)])));
        assert!(!s.record(&json!(C1), &json!("nope")));
        s.record(&json!(C2), &json!([rec("SELECT 2", 1.0, true)]));
        let entries = s.list(&json!(C1))["entries"].as_array().unwrap().clone();
        assert_eq!(sqls(&entries), ["ALTER USER x PASSWORD '***'", "SELECT 1"]);
        assert!(s.star(&json!(C1), &entries[1]["id"], &json!(true)));
        s.flush();
        let saved: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(saved["version"], 1);
        assert_eq!(saved["connections"][C1][1]["sql"], "SELECT 1");
        assert_eq!(saved["connections"][C1][1]["star"], true);
        // A deleted connection's history goes with the next write.
        live.lock().remove(C2);
        s.clear(&json!(C1), &json!(false));
        assert_eq!(sqls(s.list(&json!(C1))["entries"].as_array().unwrap()), ["SELECT 1"]);
        let saved: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
        assert_eq!(saved["connections"].as_object().unwrap().keys().collect::<Vec<_>>(), [C1]);
        assert!(s.set_enabled(&json!(false)));
        assert!(!s.record(&json!(C1), &json!([rec("SELECT 3", 1.0, true)])));
        let again = store(&file, live, timers);
        let list = again.list(&json!(C1));
        assert_eq!(list["enabled"], false);
        assert_eq!(list["entries"][0]["sql"], "SELECT 1");
        assert_eq!(list["entries"][0]["star"], true);
    }

    #[test]
    fn never_writes_over_a_file_of_a_newer_version_or_one_that_is_not_a_history_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("h2.json");
        fs::write(&file, r#"{"version":9,"future":true}"#).unwrap();
        let s = DbHistoryStore::new(&file, |_| true, Arc::new(ManualTimers::default()), WRITE_DELAY_MS);
        assert!(!s.record(&json!(C1), &json!([rec("SELECT 1", 1.0, true)])));
        assert!(!s.set_enabled(&json!(false)));
        s.flush();
        assert_eq!(fs::read_to_string(&file).unwrap(), r#"{"version":9,"future":true}"#);
    }

    #[test]
    fn writes_are_batched_into_one_write_after_the_delay() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("db").join("query_history.json");
        let timers = Arc::new(ManualTimers::default());
        let s = DbHistoryStore::new(&file, |_| true, timers.clone(), WRITE_DELAY_MS);
        s.set_id_source(ids());
        s.record(&json!(C1), &json!([rec("SELECT 1", 7.0, true)]));
        s.record(&json!(C1), &json!([rec("SELECT 2", 8.0, false)]));
        assert_eq!(timers.live(), [WRITE_DELAY_MS]);
        assert!(!file.exists());
        assert_eq!(timers.fire(WRITE_DELAY_MS), 1);
        // `{...record, id}`: the id comes last, as JSON.stringify writes the TS object.
        assert_eq!(
            fs::read_to_string(&file).unwrap(),
            format!(
                r#"{{"version":1,"enabled":true,"connections":{{"{C1}":[{{"sql":"SELECT 2","at":8,"timeMs":3,"rows":1,"ok":false,"id":"id2"}},{{"sql":"SELECT 1","at":7,"timeMs":3,"rows":1,"ok":true,"id":"id1"}}]}}}}"#
            )
        );
        assert!(new_id().len() == 12 && valid_id(&new_id()));
    }
}
