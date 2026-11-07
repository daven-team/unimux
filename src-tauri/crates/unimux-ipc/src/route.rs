//! Which window hears a main-to-renderer message: port of `routeMessage` (src/shared/detached.ts). The state, the CLI and MCP
//! status, the host crashes and the quit go to every window; a cell's messages to the window that shows the cell; the
//! `automation:start-cells` list is split by owner; everything else goes to the main window.
//!
//! The cases are shared with vitest through test/golden/route-message.jsonl (scripts/goldens-detached.mjs writes it from the TS
//! function, `test/route-message-fixtures.test.ts` reads it back on the TS side, `tests::golden_rows_match_the_ts_reference`
//! on this side).

use std::collections::HashMap;

use serde_json::Value;

/// Messages every window of the app needs (BROADCAST_CHANNELS).
pub const BROADCAST_CHANNELS: &[&str] = &[
    "state:changed",
    "cli:changed",
    "mcp:info",
    "ptyhost:crashed",
    "ptyhost:fatal",
    "app:before-quit",
    "ssh:vault:changed",
    "db:session",
    "db:prompt",
    "db:hostCrashed",
    "db:vault:changed",
    "sftp:session",
    "sftp:prompt",
    "sftp:hostCrashed",
];

/// Messages about one cell: its id is the first argument, or `cellId` of the first argument (CELL_CHANNELS).
pub const CELL_CHANNELS: &[&str] = &[
    "cell:hook",
    "cell:session",
    "cell:context",
    "cell:restarted",
    "cell:spawnError",
    "focus-cell",
    "ssh:session",
    "ssh:prompt",
    "notify:answer",
];

/// A receiver of a routed message.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum RouteTarget {
    /// Every app window (`'*'`).
    All,
    /// The main window (`null`).
    Main,
    /// A detached window by its id (the label is `detached-<id>`).
    Detached(String),
}

impl RouteTarget {
    fn of(owner: Option<&String>) -> Self {
        owner.map_or(RouteTarget::Main, |w| RouteTarget::Detached(w.clone()))
    }
}

/// `routeMessage(channel, args, owners)`: the receivers with the arguments each one gets. `owners` maps a cell id to the id of
/// the detached window that shows it (cells not listed belong to the main window).
pub fn route_message(channel: &str, args: &[Value], owners: &HashMap<String, String>) -> Vec<(RouteTarget, Vec<Value>)> {
    if BROADCAST_CHANNELS.contains(&channel) {
        return vec![(RouteTarget::All, args.to_vec())];
    }
    if CELL_CHANNELS.contains(&channel) {
        let cell = match args.first() {
            Some(Value::String(s)) => Some(s.as_str()),
            Some(Value::Object(o)) => o.get("cellId").and_then(Value::as_str),
            _ => None,
        };
        let target = match cell {
            None => RouteTarget::Main,
            Some(id) => RouteTarget::of(owners.get(id)),
        };
        return vec![(target, args.to_vec())];
    }
    if channel == "automation:start-cells"
        && let Some(Value::Array(ids)) = args.first()
    {
        // A Map keyed by owner: insertion order of the first cell of each owner, cells in their order.
        let mut groups: Vec<(RouteTarget, Vec<Value>)> = Vec::new();
        for id in ids {
            let Value::String(s) = id else { continue };
            let owner = RouteTarget::of(owners.get(s));
            match groups.iter_mut().find(|(o, _)| *o == owner) {
                Some((_, list)) => list.push(id.clone()),
                None => groups.push((owner, vec![id.clone()])),
            }
        }
        return groups.into_iter().map(|(w, list)| (w, vec![Value::Array(list)])).collect();
    }
    vec![(RouteTarget::Main, args.to_vec())]
}

/// An id that can stand in a window label as it is (a uuid, what 1.1.4 writes).
fn plain_id(id: &str) -> bool {
    !id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The label of a detached window's webview. Tauri takes only alphanumerics, '-', '/', ':' and '_' in a label, while a
/// registry id may be any 1..128-char string (1.1.4 opened a hand-edited `a.b` too): a plain id gives `detached-<id>`,
/// any other id `detached-:<hex of its UTF-8>` (':' is never in a plain id, so no two ids share a label; both match the
/// `detached-*` capability).
pub fn detached_label(id: &str) -> String {
    if plain_id(id) {
        return format!("detached-{id}");
    }
    let mut out = String::with_capacity(10 + id.len() * 2);
    out.push_str("detached-:");
    for b in id.bytes() {
        out.push_str(&format!("{b:02x}"));
    }
    out
}

/// The detached window id of a label (None for `main` and anything [`detached_label`] does not give).
pub fn detached_id(label: &str) -> Option<String> {
    let rest = label.strip_prefix("detached-")?;
    if let Some(hex) = rest.strip_prefix(':') {
        if hex.is_empty() || hex.len() % 2 != 0 || !hex.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) {
            return None;
        }
        let bytes: Option<Vec<u8>> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16).ok()).collect();
        let id = String::from_utf8(bytes?).ok()?;
        return (!plain_id(&id)).then_some(id);
    }
    plain_id(rest).then(|| rest.to_string())
}

/// `encodeURIComponent` / Node's `querystring.escape` of a query value (1.1.4 loaded the page with
/// `loadFile(..., { query: { detached: id } })`, which escapes the id the same way).
pub fn query_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for b in value.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn owners() -> HashMap<String, String> {
        HashMap::from([("c1".to_string(), "w1".to_string())])
    }

    fn short(out: Vec<(RouteTarget, Vec<Value>)>) -> Vec<(Option<String>, Value)> {
        out.into_iter()
            .map(|(t, a)| {
                let w = match t {
                    RouteTarget::All => Some("*".to_string()),
                    RouteTarget::Main => None,
                    RouteTarget::Detached(id) => Some(id),
                };
                (w, Value::Array(a))
            })
            .collect()
    }

    /// detached-windows.test.ts "broadcasts the state, sends a cell's messages to its window and the rest to the main window".
    #[test]
    fn broadcasts_the_state_sends_cell_messages_to_their_window_and_the_rest_to_main() {
        let o = owners();
        assert_eq!(short(route_message("state:changed", &[json!({"x": 1})], &o)), vec![(Some("*".into()), json!([{"x": 1}]))]);
        assert_eq!(
            short(route_message("cell:hook", &[json!("c1"), json!("stop")], &o)),
            vec![(Some("w1".into()), json!(["c1", "stop"]))]
        );
        assert_eq!(short(route_message("cell:hook", &[json!("c2"), json!("stop")], &o)), vec![(None, json!(["c2", "stop"]))]);
        assert_eq!(
            route_message("ssh:session", &[json!({"cellId": "c1", "phase": "ready"})], &o)[0].0,
            RouteTarget::Detached("w1".into())
        );
        assert_eq!(route_message("focus-cell", &[json!("c1")], &o)[0].0, RouteTarget::Detached("w1".into()));
        assert_eq!(short(route_message("app:confirm-quit", &[], &o)), vec![(None, json!([]))]);
        assert_eq!(
            short(route_message("automation:start-cells", &[json!(["c1", "c2", "c3"])], &o)),
            vec![(Some("w1".into()), json!([["c1"]])), (None, json!([["c2", "c3"]]))]
        );
    }

    /// detached-tabs.test.ts "sends session and prompt events of databases and SFTP to every window".
    #[test]
    fn sends_session_and_prompt_events_of_databases_and_sftp_to_every_window() {
        let none = HashMap::new();
        for channel in
            ["db:session", "db:prompt", "db:hostCrashed", "db:vault:changed", "sftp:session", "sftp:prompt", "sftp:hostCrashed"]
        {
            assert_eq!(short(route_message(channel, &[json!({})], &none)), vec![(Some("*".into()), json!([{}]))]);
        }
        assert_eq!(short(route_message("db:other", &[json!(1)], &none)), vec![(None, json!([1]))]);
    }

    #[test]
    fn labels() {
        assert_eq!(detached_label("abc"), "detached-abc");
        assert_eq!(detached_id("detached-abc").as_deref(), Some("abc"));
        assert_eq!(detached_id("main"), None);
        let uuid = "0f8b2c1e-6a4d-4c3b-9e2f-1a2b3c4d5e6f";
        assert_eq!(detached_label(uuid), format!("detached-{uuid}"));
        assert_eq!(detached_id(&detached_label(uuid)).as_deref(), Some(uuid));
    }

    /// Tauri's label rule (tauri-runtime `is_label_valid`): every registry id gets a valid label that maps back to it, and
    /// no two ids share a label.
    #[test]
    fn ids_outside_the_label_alphabet_are_hex_encoded() {
        let valid = |l: &str| l.chars().all(|c| c.is_alphanumeric() || c == '-' || c == '/' || c == ':' || c == '_');
        let ids = ["a.b", "a b", "x", "61", "a:b", "a/b", "\u{17c}\u{f3}\u{142}w", "1.1.4 tab", "%", "detached-:61"];
        let mut labels = std::collections::HashSet::new();
        for id in ids {
            let label = detached_label(id);
            assert!(valid(&label), "{id} -> {label}");
            assert!(label.starts_with("detached-"), "{label}");
            assert_eq!(detached_id(&label).as_deref(), Some(id), "{label}");
            assert!(labels.insert(label), "{id}");
        }
        assert_eq!(detached_label("a.b"), "detached-:612e62");
        // Not canonical: a plain id in hex, odd or upper-case hex, an empty id, a raw non-label id.
        for label in ["detached-:61", "detached-:612", "detached-:612E62", "detached-:", "detached-", "detached-a.b"] {
            assert_eq!(detached_id(label), None, "{label}");
        }
        assert_eq!(query_escape("a.b c/\u{17c}"), "a.b%20c%2F%C5%BC");
        assert_eq!(query_escape("0f8b-AZ_az~*'()!"), "0f8b-AZ_az~*'()!");
    }

    /// Every row of the shared fixture file (written by the TS routeMessage) gives the same receivers and arguments here.
    #[test]
    fn golden_rows_match_the_ts_reference() {
        let path = format!("{}/../../../test/golden/route-message.jsonl", env!("CARGO_MANIFEST_DIR"));
        let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
        let mut n = 0;
        for (i, line) in text.lines().filter(|l| !l.trim().is_empty()).enumerate() {
            let row: Value = serde_json::from_str(line).unwrap();
            let owners: HashMap<String, String> = row["owners"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| (p[0].as_str().unwrap().to_string(), p[1].as_str().unwrap().to_string()))
                .collect();
            let args = row["args"].as_array().unwrap();
            let ours: Vec<Value> = route_message(row["channel"].as_str().unwrap(), args, &owners)
                .into_iter()
                .map(|(t, a)| {
                    let window = match t {
                        RouteTarget::All => json!("*"),
                        RouteTarget::Main => Value::Null,
                        RouteTarget::Detached(id) => json!(id),
                    };
                    json!({"window": window, "args": a})
                })
                .collect();
            assert_eq!(Value::Array(ours), row["out"], "row {i}: {line}");
            n += 1;
        }
        assert!(n >= 200, "{n} rows");
    }
}
