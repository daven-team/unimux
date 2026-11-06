//! What the app sends to the renderer for a hook signal (the `hooks.on(...)` handlers of src/main/index.ts, 1.1.4):
//! `cell:hook` for a cell of the state, `cell:session` when a live Claude cell switched conversation, a Codex turn end as a
//! `stop` hook of a live Codex cell. Pure over the state JSON so it is tested without a window; the app emits the result
//! with `Scope::Cell` (W5 routes it to the window that shows the cell).
//!
//! The side effects of 1.1.4 that belong to later packages (hookWatch H2, the context tracker H4, automation statuses M3,
//! the CLI exit codes P3 / M3) are left to the observers the app keeps next to this routing.

use serde_json::{Map, Value, json};

use super::HookSignal;
use super::payload::is_session_id;

/// `findCell(state, cellId)?.cell`: a cell of an open tab (closed grids in `archive` are not searched, as in 1.1.4).
pub fn find_cell<'a>(state: &'a Value, cell_id: &str) -> Option<&'a Value> {
    state.get("projects")?.as_array()?.iter().find_map(|p| {
        p.get("tabs")?
            .as_array()?
            .iter()
            .find_map(|t| t.get("cells")?.as_array()?.iter().find(|c| c.get("id").and_then(Value::as_str) == Some(cell_id)))
    })
}

/// `getProfile(state, id).cli`: the profile with the id, else the shell profile, else the first one.
pub fn profile_cli<'a>(state: &'a Value, profile_id: Option<&str>) -> Option<&'a str> {
    let profiles = state.get("profiles")?.as_array()?;
    let by = |f: &dyn Fn(&Value) -> bool| profiles.iter().find(|p| f(p));
    let profile = profile_id
        .and_then(|id| by(&|p| p.get("id").and_then(Value::as_str) == Some(id)))
        .or_else(|| by(&|p| p.get("cli").and_then(Value::as_str) == Some("shell")))
        .or_else(|| profiles.first())?;
    profile.get("cli").and_then(Value::as_str)
}

/// The cell's CLI (`getProfile(state, cell.profileId).cli`).
pub fn cell_cli<'a>(state: &'a Value, cell: &'a Value) -> Option<&'a str> {
    profile_cli(state, cell.get("profileId").and_then(Value::as_str))
}

/// `shouldUpdateCellSession` of src/shared/sessionTrack.ts.
pub fn should_update_cell_session(
    known: bool,
    is_claude: bool,
    alive: bool,
    current_id: Option<&str>,
    reported_id: &str,
) -> bool {
    known && is_claude && alive && is_session_id(reported_id) && current_id != Some(reported_id)
}

/// `followedSession(id)`: the session stored for a conversation the live CLI reported (confirmed).
pub fn followed_session(id: &str) -> Value {
    json!({ "cli": "claude", "id": id, "confirmed": true })
}

/// One event for the renderer: the channel, the cell it belongs to (routing) and the positional arguments.
#[derive(Debug, Clone, PartialEq)]
pub struct Delivery {
    pub cell: String,
    pub channel: &'static str,
    pub args: Vec<Value>,
}

/// The events 1.1.4 sends for `signal`, given the state and which cells run a process now.
pub fn deliveries(state: &Value, alive: &dyn Fn(&str) -> bool, signal: &HookSignal) -> Vec<Delivery> {
    let hook = |cell: &str, event: &str, info: Value| Delivery {
        cell: cell.to_string(),
        channel: "cell:hook",
        args: vec![json!(cell), json!(event), info],
    };
    match signal {
        HookSignal::Hook { cell, event, info } => {
            if find_cell(state, cell).is_none() {
                return vec![]; // stale or foreign id
            }
            vec![hook(cell, event, info.clone().unwrap_or(Value::Null))]
        }
        // SessionStart ends the "background tasks still running" mode of the cell.
        HookSignal::SessionStart { cell, source } => {
            if find_cell(state, cell).is_none() {
                return vec![];
            }
            let mut info = Map::new();
            if let Some(s) = source {
                info.insert("source".into(), json!(s));
            }
            vec![hook(cell, "session", Value::Object(info))]
        }
        // The user switched conversation inside a running Claude (/resume, /clear): followed so a restart resumes it.
        HookSignal::Session { cell, session_id, .. } => {
            let found = find_cell(state, cell);
            let is_claude = found.is_some_and(|c| cell_cli(state, c) == Some("claude"));
            let current = found.and_then(|c| c.get("session")).and_then(|s| s.get("id")).and_then(Value::as_str);
            if !should_update_cell_session(found.is_some(), is_claude, alive(cell), current, session_id) {
                return vec![];
            }
            vec![Delivery { cell: cell.clone(), channel: "cell:session", args: vec![json!(cell), followed_session(session_id)] }]
        }
        // A Codex turn completed: the renderer's StatusTracker decides whether it was the cell's own turn end.
        HookSignal::Codex { cell, notice } => {
            let Some(found) = find_cell(state, cell) else { return vec![] };
            if !alive(cell) || cell_cli(state, found) != Some("codex") {
                return vec![]; // stale or foreign
            }
            let mut info = Map::new();
            info.insert("codex".into(), json!(true));
            if let Some(t) = &notice.turn_id {
                info.insert("turnId".into(), json!(t));
            }
            if let Some(t) = &notice.thread_id {
                info.insert("threadId".into(), json!(t));
            }
            vec![hook(cell, "stop", Value::Object(info))]
        }
        HookSignal::Transcript { .. } | HookSignal::CliExit { .. } => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hooks::payload::CodexNotice;

    const ID: &str = "3f2b8c1e-0d4a-4b7e-9c11-2a5d6e7f8091";
    const OTHER: &str = "11111111-2222-3333-4444-555555555555";

    fn state() -> Value {
        json!({
            "profiles": [
                { "id": "sh", "cli": "shell" }, { "id": "cl", "cli": "claude" }, { "id": "cx", "cli": "codex" },
            ],
            "projects": [{
                "tabs": [{ "cells": [
                    { "id": "claude1", "profileId": "cl", "session": { "cli": "claude", "id": OTHER } },
                    { "id": "codex1", "profileId": "cx" },
                    { "id": "shell1", "profileId": "gone" },
                ] }],
                "archive": [{ "cells": [{ "id": "archived", "profileId": "cl" }] }],
            }],
        })
    }

    #[test]
    fn should_update_cell_session_ports_the_ts_cases() {
        // updates a live Claude cell whose conversation changed
        assert!(should_update_cell_session(true, true, true, Some(OTHER), ID));
        assert!(should_update_cell_session(true, true, true, None, ID));
        // ignores unknown, non-claude, not alive, unchanged and invalid ids
        assert!(!should_update_cell_session(false, true, true, Some(OTHER), ID));
        assert!(!should_update_cell_session(true, false, true, Some(OTHER), ID));
        assert!(!should_update_cell_session(true, true, false, Some(OTHER), ID));
        assert!(!should_update_cell_session(true, true, true, Some(ID), ID));
        assert!(!should_update_cell_session(true, true, true, Some(OTHER), "bad id"));
    }

    #[test]
    fn followed_session_is_confirmed() {
        assert_eq!(followed_session(ID), json!({ "cli": "claude", "id": ID, "confirmed": true }));
    }

    #[test]
    fn hooks_reach_cells_of_open_tabs_only() {
        let s = state();
        let none = |_: &str| false;
        let sig = |cell: &str| HookSignal::Hook { cell: cell.into(), event: "notify".into(), info: None };
        assert_eq!(
            deliveries(&s, &none, &sig("claude1")),
            vec![Delivery {
                cell: "claude1".into(),
                channel: "cell:hook",
                args: vec![json!("claude1"), json!("notify"), Value::Null]
            }]
        );
        assert!(deliveries(&s, &none, &sig("archived")).is_empty());
        assert!(deliveries(&s, &none, &sig("nope")).is_empty());
        let start = HookSignal::SessionStart { cell: "claude1".into(), source: None };
        assert_eq!(deliveries(&s, &none, &start)[0].args, vec![json!("claude1"), json!("session"), json!({})]);
        let start = HookSignal::SessionStart { cell: "codex1".into(), source: Some("clear".into()) };
        assert_eq!(deliveries(&s, &none, &start)[0].args[2], json!({ "source": "clear" }));
    }

    #[test]
    fn a_session_switch_is_followed_only_for_a_live_claude_cell() {
        let s = state();
        let alive = |c: &str| c != "dead";
        let sig = |cell: &str, id: &str| HookSignal::Session { cell: cell.into(), session_id: id.into(), source: None };
        let got = deliveries(&s, &alive, &sig("claude1", ID));
        assert_eq!(
            got,
            vec![Delivery {
                cell: "claude1".into(),
                channel: "cell:session",
                args: vec![json!("claude1"), followed_session(ID)]
            }]
        );
        assert!(deliveries(&s, &alive, &sig("claude1", OTHER)).is_empty()); // unchanged
        assert!(deliveries(&s, &alive, &sig("codex1", ID)).is_empty()); // not Claude
        assert!(deliveries(&s, &alive, &sig("shell1", ID)).is_empty()); // unknown profile falls back to the shell
        assert!(deliveries(&s, &|_| false, &sig("claude1", ID)).is_empty()); // not alive
        assert!(deliveries(&s, &alive, &sig("nope", ID)).is_empty());
    }

    #[test]
    fn a_codex_turn_end_is_a_stop_of_a_live_codex_cell() {
        let s = state();
        let notice = CodexNotice { thread_id: Some(ID.into()), turn_id: Some("t1".into()) };
        let sig = |cell: &str| HookSignal::Codex { cell: cell.into(), notice: notice.clone() };
        let got = deliveries(&s, &|_| true, &sig("codex1"));
        assert_eq!(got[0].args, vec![json!("codex1"), json!("stop"), json!({ "codex": true, "turnId": "t1", "threadId": ID })]);
        let bare = HookSignal::Codex { cell: "codex1".into(), notice: CodexNotice::default() };
        assert_eq!(deliveries(&s, &|_| true, &bare)[0].args[2], json!({ "codex": true }));
        assert!(deliveries(&s, &|_| false, &sig("codex1")).is_empty());
        assert!(deliveries(&s, &|_| true, &sig("claude1")).is_empty());
    }

    #[test]
    fn transcripts_and_cli_exits_send_nothing() {
        let s = state();
        let t = HookSignal::Transcript { cell: "claude1".into(), session_id: ID.into(), path: "/x".into() };
        assert!(deliveries(&s, &|_| true, &t).is_empty());
        assert!(deliveries(&s, &|_| true, &HookSignal::CliExit { cell: "claude1".into(), code: Some(0) }).is_empty());
    }
}
