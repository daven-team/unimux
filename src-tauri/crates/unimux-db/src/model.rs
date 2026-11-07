//! The connection and session helpers of src/shared/db.ts that the main side uses: session ids, the database a connection
//! opens, its endpoint text, the session phases, `strictConnection` and the state edits of saved connections. Connections
//! are JSON objects in the key order the TS code builds (state.json is written from them).

use serde_json::{Map, Value, json};
use unimux_core::js_json;
use unimux_state::normalize::{js, remote::normalize_db_connection};

use crate::sql::{SQLITE_MAIN, limits};

/// DB sessions live in their own namespace next to cells and SFTP sessions: `db:<uuid>`.
pub const DB_SESSION_PREFIX: &str = "db:";

pub fn db_session_id(uuid: &str) -> String {
    format!("{DB_SESSION_PREFIX}{uuid}")
}

fn is_uuid_text(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 36
        && b.iter().enumerate().all(|(i, c)| if matches!(i, 8 | 13 | 18 | 23) { *c == b'-' } else { c.is_ascii_hexdigit() })
}

/// `isDbSessionId`: `/^db:<uuid>$/i` (the flag makes the prefix case-insensitive too).
pub fn is_db_session_id(id: &str) -> bool {
    id.len() == 39 && id[..3].eq_ignore_ascii_case(DB_SESSION_PREFIX) && is_uuid_text(&id[3..])
}

/// `z.guid()` of zod 4: 8-4-4-4-12 hex digits, any case.
pub fn is_guid(s: &str) -> bool {
    is_uuid_text(s)
}

pub fn kind_of(c: &Value) -> &str {
    c.get("kind").and_then(Value::as_str).unwrap_or_default()
}

/// `isSqlKind`.
pub fn is_sql_kind(kind: &str) -> bool {
    matches!(kind, "postgres" | "mysql" | "sqlite")
}

fn str_of<'a>(c: &'a Value, key: &str) -> Option<&'a str> {
    c.get(key).and_then(Value::as_str)
}

/// `String(n)` of a JSON number.
pub fn number_text(v: &Value) -> String {
    match v {
        Value::Number(n) => js_json::number_text(n),
        other => js::to_string(Some(other)),
    }
}

/// `dbDefaultDatabase`: Postgres its database ("postgres" by default), MySQL its default database (empty: none), SQLite
/// "main", Redis its DB index as text.
pub fn db_default_database(c: &Value) -> String {
    match kind_of(c) {
        "postgres" => str_of(c, "database").unwrap_or("postgres").to_string(),
        "mysql" => str_of(c, "database").unwrap_or_default().to_string(),
        "sqlite" => SQLITE_MAIN.to_string(),
        _ => c.get("dbIndex").filter(|v| !v.is_null()).map_or_else(|| "0".to_string(), number_text),
    }
}

/// `dbEndpoint`: "host:port/db" (through SSH the database address as the server sees it); a SQLite file's path.
pub fn db_endpoint(c: &Value) -> String {
    let kind = kind_of(c);
    if kind == "sqlite" {
        return str_of(c, "path").unwrap_or_default().to_string();
    }
    let ssh = c.get("ssh").filter(|s| s.is_object());
    let host = match ssh {
        Some(s) => str_of(s, "dbHost").unwrap_or_default(),
        None => str_of(c, "host").unwrap_or_default(),
    };
    let port = number_text(ssh.map_or_else(|| c.get("port"), |s| s.get("dbPort")).unwrap_or(&Value::Null));
    let h = if host.contains(':') { format!("[{host}]") } else { host.to_string() };
    if kind == "mysql" {
        return match str_of(c, "database").filter(|d| !d.is_empty()) {
            Some(d) => format!("{h}:{port}/{d}"),
            None => format!("{h}:{port}"),
        };
    }
    let db = if kind == "postgres" {
        str_of(c, "database").unwrap_or("postgres").to_string()
    } else {
        c.get("dbIndex").filter(|v| !v.is_null()).map_or_else(|| "0".to_string(), number_text)
    };
    format!("{h}:{port}/{db}")
}

/// JavaScript truthiness of a present value.
pub fn js_truthy(v: &Value) -> bool {
    js::truthy(Some(v))
}

/// `a === b` of two primitives (absent is `undefined`).
pub fn js_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    js::strict_eq(a, b)
}

/// `isLiveDbPhase`.
pub fn is_live_db_phase(phase: &str) -> bool {
    phase != "error" && phase != "closed"
}

/// `dbStatusOf`.
pub fn db_status_of(phase: &str) -> &'static str {
    match phase {
        "connected" => "connected",
        "error" => "error",
        "closed" => "closed",
        _ => "connecting",
    }
}

/// The key of a connection's shared SSH tunnel (`tunnelKeyOf`).
pub fn tunnel_key_of(c: &Value) -> Option<String> {
    let ssh = c.get("ssh").filter(|s| s.is_object())?;
    Some(format!(
        "{}|{}|{}|{}",
        str_of(c, "id").unwrap_or_default(),
        str_of(ssh, "hostId").unwrap_or_default(),
        str_of(ssh, "dbHost").unwrap_or_default(),
        number_text(ssh.get("dbPort").unwrap_or(&Value::Null))
    ))
}

/// `JSON.stringify(a ?? null) === JSON.stringify(b ?? null)`.
pub fn same(a: Option<&Value>, b: Option<&Value>) -> bool {
    js_json::stringify(a.unwrap_or(&Value::Null)) == js_json::stringify(b.unwrap_or(&Value::Null))
}

/// `strictConnection`: the connection exactly as sent: the normalizer must not have changed anything that matters (a bad port
/// or an unknown TLS mode would otherwise be saved as the default silently).
pub fn strict_connection(raw: &Value) -> Option<Value> {
    let c = normalize_db_connection(raw)?;
    const FIELDS: [&str; 12] =
        ["kind", "host", "port", "user", "tls", "caPath", "ssh", "readOnly", "statementTimeoutMs", "color", "group", "path"];
    if !FIELDS.iter().all(|f| same(c.get(*f), raw.get(*f))) {
        return None;
    }
    let kind = kind_of(&c);
    if kind == "postgres"
        && !same(c.get("database"), Some(raw.get("database").filter(|v| !v.is_null()).unwrap_or(&json!("postgres"))))
    {
        return None;
    }
    if kind == "redis" && !same(c.get("dbIndex"), Some(raw.get("dbIndex").filter(|v| !v.is_null()).unwrap_or(&json!(0)))) {
        return None;
    }
    if kind == "mysql" && !same(c.get("database"), raw.get("database").filter(|v| js::truthy(Some(v)))) {
        return None;
    }
    match raw.get("name").and_then(Value::as_str) {
        Some(name) if js::len16(js::trim(name)) <= limits::NAME => Some(c),
        _ => None,
    }
}

/// `s.dbConnections ?? []`.
pub fn connections(state: &Value) -> Vec<Value> {
    state.get("dbConnections").and_then(Value::as_array).cloned().unwrap_or_default()
}

pub fn find_connection<'a>(list: &'a [Value], id: &str) -> Option<&'a Value> {
    list.iter().find(|c| str_of(c, "id") == Some(id))
}

/// `{...s, dbConnections: list}`.
fn with_connections(state: &Value, list: Vec<Value>) -> Value {
    let mut s = state.as_object().cloned().unwrap_or_default();
    s.insert("dbConnections".into(), Value::Array(list));
    Value::Object(s)
}

/// `upsertDbConnection`: replaced in place, or added at the end.
pub fn upsert_db_connection(state: &Value, c: &Value) -> Value {
    let mut list = connections(state);
    let id = str_of(c, "id");
    match list.iter().position(|x| str_of(x, "id") == id) {
        Some(at) => list[at] = c.clone(),
        None => list.push(c.clone()),
    }
    with_connections(state, list)
}

/// `removeDbConnection`.
pub fn remove_db_connection(state: &Value, id: &str) -> Value {
    let list = connections(state).into_iter().filter(|c| str_of(c, "id") != Some(id)).collect();
    with_connections(state, list)
}

/// `duplicateDbConnection`: a copy right after the original, named "<name> (2)" (the first free number).
pub fn duplicate_db_connection(state: &Value, id: &str, new_id: &str, now: i64) -> Value {
    let list = connections(state);
    let Some(at) = list.iter().position(|c| str_of(c, "id") == Some(id)) else { return state.clone() };
    let source = list[at].as_object().cloned().unwrap_or_default();
    let names: std::collections::HashSet<&str> = list.iter().filter_map(|c| str_of(c, "name")).collect();
    let name = source.get("name").map(|n| js::to_string(Some(n))).unwrap_or_else(|| "undefined".to_string());
    let mut n = 2;
    while names.contains(format!("{name} ({n})").as_str()) {
        n += 1;
    }
    let mut copy: Map<String, Value> = source;
    copy.insert("id".into(), json!(new_id));
    copy.insert("name".into(), json!(js::slice16(&format!("{name} ({n})"), limits::NAME)));
    copy.insert("createdAt".into(), json!(now));
    copy.insert("updatedAt".into(), json!(now));
    let mut out = list;
    out.insert(at + 1, Value::Object(copy));
    with_connections(state, out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "00000000-0000-4000-8000-0000000000aa";

    fn pg() -> Value {
        json!({ "kind": "postgres", "name": "prod", "host": "db.example.com", "port": 5432, "user": "app", "database": "shop",
            "tls": "disable", "ssh": null, "readOnly": false, "id": ID, "createdAt": 0, "updatedAt": 0 })
    }

    #[test]
    fn session_ids_and_guids() {
        assert!(is_db_session_id(&db_session_id(ID)));
        assert!(is_db_session_id(&format!("DB:{}", ID.to_uppercase())));
        assert!(!is_db_session_id(&format!("sftp:{ID}")));
        assert!(!is_db_session_id("db:x"));
        assert!(is_guid(ID) && !is_guid("x"));
    }

    #[test]
    fn endpoints_and_default_databases() {
        assert_eq!(db_endpoint(&pg()), "db.example.com:5432/shop");
        let mut tunnel = pg();
        tunnel["ssh"] = json!({ "hostId": ID, "dbHost": "::1", "dbPort": 6000 });
        assert_eq!(db_endpoint(&tunnel), "[::1]:6000/shop");
        assert_eq!(tunnel_key_of(&tunnel).unwrap(), format!("{ID}|{ID}|::1|6000"));
        let my = json!({ "kind": "mysql", "host": "h", "port": 3306 });
        assert_eq!((db_endpoint(&my), db_default_database(&my)), ("h:3306".to_string(), String::new()));
        let redis = json!({ "kind": "redis", "host": "r", "port": 6379, "dbIndex": 3 });
        assert_eq!((db_endpoint(&redis), db_default_database(&redis)), ("r:6379/3".to_string(), "3".to_string()));
        assert_eq!(db_default_database(&json!({ "kind": "sqlite", "path": "/a.db" })), "main");
    }

    #[test]
    fn strict_connection_refuses_what_the_normalizer_would_change() {
        assert_eq!(strict_connection(&pg()).unwrap()["id"], ID);
        for (k, v) in [("port", json!(0)), ("tls", json!("verify-full")), ("host", json!("DB.example.com"))] {
            let mut c = pg();
            c[k] = v;
            assert_eq!(strict_connection(&c), None, "{k}");
        }
    }

    #[test]
    fn duplicates_after_the_original_with_the_first_free_number() {
        let mut second = pg();
        second["id"] = json!("00000000-0000-4000-8000-0000000000bb");
        second["name"] = json!("prod (2)");
        let state = json!({ "dbConnections": [pg(), second] });
        let next = duplicate_db_connection(&state, ID, "00000000-0000-4000-8000-0000000000cc", 7);
        let list = next["dbConnections"].as_array().unwrap();
        assert_eq!(list.len(), 3);
        assert_eq!(list[1]["name"], "prod (3)");
        assert_eq!(list[1]["createdAt"], 7);
        assert_eq!(remove_db_connection(&next, ID)["dbConnections"].as_array().unwrap().len(), 2);
    }
}
