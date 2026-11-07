//! What `sessions:list`, `codex:bind` and the context tracker read from the app state (the index.ts closures around them),
//! pure over the state JSON so they are tested without a window.

use std::collections::HashSet;

use serde_json::Value;

use super::{WorktreeHint, normalize_project_path};
use crate::context::{ContextCli, ContextTarget};
use crate::hooks::route::cell_cli;

fn arr<'a>(v: &'a Value, key: &str) -> impl Iterator<Item = &'a Value> {
    v.get(key).and_then(Value::as_array).into_iter().flatten()
}

fn str_of<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn present(v: Option<&Value>) -> Option<&Value> {
    v.filter(|v| !v.is_null())
}

/// `cellCwd(project, cell)`: `cell.worktree?.path ?? cell.dir ?? project.path`.
pub fn cell_cwd<'a>(project: &'a Value, cell: &'a Value) -> Option<&'a Value> {
    present(cell.get("worktree").and_then(|w| w.get("path")))
        .or_else(|| present(cell.get("dir")))
        .or_else(|| present(project.get("path")))
}

/// `findCell(state, cellId)` with its project (open tabs only).
pub fn find_cell_in<'a>(state: &'a Value, cell_id: &str) -> Option<(&'a Value, &'a Value)> {
    arr(state, "projects")
        .find_map(|p| arr(p, "tabs").find_map(|t| arr(t, "cells").find(|c| str_of(c, "id") == Some(cell_id)).map(|c| (p, c))))
}

/// JavaScript truthiness of an optional JSON value.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// The context tracker's `target(cellId)`: the cell's conversation when it has one in its own CLI (never for SSH cells).
pub fn context_target(state: &Value, cell_id: &str) -> Option<ContextTarget> {
    let (project, cell) = find_cell_in(state, cell_id)?;
    let session = cell.get("session").filter(|s| truthy(Some(s)))?;
    if truthy(cell.get("ssh")) {
        return None;
    }
    let cli = str_of(session, "cli")?;
    if cell_cli(state, cell) != Some(cli) {
        return None;
    }
    Some(ContextTarget {
        cli: ContextCli::parse(cli)?,
        session_id: str_of(session, "id")?.to_string(),
        cwd: cell_cwd(project, cell).and_then(Value::as_str)?.to_string(),
        model_hint: str_of(cell, "model").map(str::to_string),
    })
}

/// `projectWorktrees(projectPath)`: worktrees of the project's cells, open and in closed grids (History lists their
/// conversations too).
pub fn project_worktrees(state: &Value, project_path: &str) -> Vec<WorktreeHint> {
    let key = normalize_project_path(project_path);
    arr(state, "projects")
        .filter(|p| str_of(p, "path").is_some_and(|path| normalize_project_path(path) == key))
        .flat_map(|p| arr(p, "tabs").chain(arr(p, "archive")))
        .flat_map(|t| arr(t, "cells"))
        .filter_map(|c| c.get("worktree").filter(|w| truthy(Some(w))))
        .filter_map(|w| {
            Some(WorktreeHint { path: str_of(w, "path")?.to_string(), branch: str_of(w, "branch").unwrap_or("").to_string() })
        })
        .collect()
}

/// `boundCodexIds()`: the Codex session ids handed to cells this run and those of every cell in the state (closed grids too).
pub fn bound_codex_ids(state: &Value, claimed: &HashSet<String>) -> HashSet<String> {
    let mut ids = claimed.clone();
    for p in arr(state, "projects") {
        for t in arr(p, "tabs").chain(arr(p, "archive")) {
            for c in arr(t, "cells") {
                if let Some(s) = c.get("session")
                    && str_of(s, "cli") == Some("codex")
                    && let Some(id) = str_of(s, "id")
                {
                    ids.insert(id.to_string());
                }
            }
        }
    }
    ids
}

/// The codex:bind precondition: the cell is the only live Codex cell of open tabs in `cwd` (shared-directory simultaneous
/// starts are ambiguous; a message recipient is never guessed).
pub fn sole_codex_cell_in(state: &Value, alive: &dyn Fn(&str) -> bool, cell_id: &str, cwd: &str) -> bool {
    let mut peers = arr(state, "projects").flat_map(|p| {
        arr(p, "tabs").flat_map(|t| arr(t, "cells")).filter(move |c| {
            str_of(c, "id").is_some_and(alive)
                && cell_cli(state, c) == Some("codex")
                && cell_cwd(p, c).and_then(Value::as_str) == Some(cwd)
        })
    });
    match (peers.next(), peers.next()) {
        (Some(only), None) => str_of(only, "id") == Some(cell_id),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn state() -> Value {
        json!({
            "version": 1,
            "profiles": [{ "id": "cl", "cli": "claude" }, { "id": "cx", "cli": "codex" }, { "id": "sh", "cli": "shell" }],
            "projects": [
                { "id": "p1", "path": "D:\\Proj\\app", "tabs": [{ "cells": [
                    { "id": "a", "profileId": "cl", "model": "sonnet[1m]", "session": { "cli": "claude", "id": "S1" } },
                    { "id": "b", "profileId": "cx", "dir": "D:\\Proj\\app\\sub", "session": { "cli": "codex", "id": "X1" } },
                    { "id": "c", "profileId": "cx", "worktree": { "path": "D:\\Proj\\app-wt-1", "branch": "mc/1" } },
                    { "id": "d", "profileId": "cl", "ssh": { "host": "h" }, "session": { "cli": "claude", "id": "S2" } },
                    { "id": "e", "profileId": "sh", "session": { "cli": "claude", "id": "S3" } },
                    { "id": "f", "profileId": "cx" },
                    { "id": "g", "profileId": "cx" },
                ] }], "archive": [{ "cells": [
                    { "id": "z", "profileId": "cx", "worktree": { "path": "D:\\Proj\\app-wt-old", "branch": "mc/old" }, "session": { "cli": "codex", "id": "X9" } },
                ] }] },
                { "id": "p2", "path": "d:/proj/APP/", "tabs": [{ "cells": [{ "id": "q", "profileId": "cx", "worktree": { "path": "D:\\Proj\\app-wt-2", "branch": "" } }] }] },
            ],
        })
    }

    #[test]
    fn context_targets_follow_the_cell_its_profile_and_its_folder() {
        let s = state();
        assert_eq!(
            context_target(&s, "a"),
            Some(ContextTarget {
                cli: ContextCli::Claude,
                session_id: "S1".into(),
                cwd: "D:\\Proj\\app".into(),
                model_hint: Some("sonnet[1m]".into())
            })
        );
        assert_eq!(context_target(&s, "b").unwrap().cwd, "D:\\Proj\\app\\sub");
        assert_eq!(context_target(&s, "c"), None, "no session yet");
        assert_eq!(context_target(&s, "d"), None, "SSH cell");
        assert_eq!(context_target(&s, "e"), None, "the profile runs another CLI");
        assert_eq!(context_target(&s, "z"), None, "closed grids are not searched");
        assert_eq!(context_target(&s, "nope"), None);
    }

    #[test]
    fn worktrees_of_every_spelling_of_the_project_open_and_closed() {
        let hints = project_worktrees(&state(), "D:\\Proj\\app\\");
        let paths: Vec<&str> = hints.iter().map(|w| w.path.as_str()).collect();
        assert_eq!(paths, ["D:\\Proj\\app-wt-1", "D:\\Proj\\app-wt-old", "D:\\Proj\\app-wt-2"]);
        assert_eq!(hints[2].branch, "");
        assert!(project_worktrees(&state(), "D:\\Other").is_empty());
    }

    #[test]
    fn bound_ids_and_the_sole_codex_cell_rule() {
        let s = state();
        let claimed: HashSet<String> = ["C1".to_string()].into();
        assert_eq!(bound_codex_ids(&s, &claimed), ["C1", "X1", "X9"].map(String::from).into());
        let alive = |c: &str| ["b", "c", "f", "g"].contains(&c);
        assert!(sole_codex_cell_in(&s, &alive, "b", "D:\\Proj\\app\\sub"));
        assert!(!sole_codex_cell_in(&s, &alive, "a", "D:\\Proj\\app\\sub"), "another cell is the one there");
        assert!(sole_codex_cell_in(&s, &alive, "c", "D:\\Proj\\app-wt-1"));
        // Two live Codex cells in the project folder: ambiguous.
        assert!(!sole_codex_cell_in(&s, &alive, "f", "D:\\Proj\\app"));
        let only_f = |c: &str| c == "f";
        assert!(sole_codex_cell_in(&s, &only_f, "f", "D:\\Proj\\app"));
        assert!(!sole_codex_cell_in(&s, &|_| false, "f", "D:\\Proj\\app"), "not alive");
    }
}
