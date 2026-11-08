//! test/cli-ipc.test.ts "create_grid with a missing CLI": a cell whose CLI is not installed is reported with a clear text
//! and counts as exited instead of pretending it started; nothing is added to the answer when every CLI is there.

use std::sync::Arc;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use unimux_state::{PassThrough, StateController};

use super::*;

struct Deps {
    missing: Option<&'static str>,
    started: Mutex<Vec<Vec<String>>>,
}

impl AutomationDeps for Deps {
    fn create_worktree(&self, _path: &str, _name: &str) -> BoxFuture<'static, Result<Value, String>> {
        Box::pin(async { Err("no worktrees here".to_string()) })
    }
    fn remove_worktree(&self, _path: &str, _worktree: &Value) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
    fn start_cells(&self, ids: &[String]) {
        self.started.lock().push(ids.to_vec());
    }
    fn missing_cli(&self, profile_id: &str) -> Option<String> {
        self.missing.filter(|m| *m == profile_id).map(str::to_string)
    }
    fn deliver(&self, _cell: &str, _notice: &str) -> BoxFuture<'static, Result<(), String>> {
        Box::pin(async { Ok(()) })
    }
}

fn make_service(missing: Option<&'static str>) -> (Arc<AutomationService>, Arc<Deps>) {
    let state = json!({
        "version": 1,
        "automation": { "paused": false, "tasks": [], "messages": [], "events": [] },
        "projects": [{ "id": "p", "name": "P", "path": "D:/p", "activeTabId": null, "archive": [], "tabs": [] }],
        "activeProjectId": "p",
        "profiles": [
            { "id": "claude", "name": "Claude", "cli": "claude", "args": "" },
            { "id": "shell", "name": "PowerShell", "cli": "shell", "args": "" }
        ],
        "presets": [], "snippets": [], "notes": [],
        "settings": { "language": null, "delegation": { "mode": "auto", "maxAgents": 4 } }
    });
    let deps = Arc::new(Deps { missing, started: Mutex::default() });
    let service = AutomationService::new(
        Arc::new(StateController::new(state, Arc::new(PassThrough))),
        deps.clone(),
        Arc::new(|| 1_800_000_000_000),
        Arc::new(|f| {
            tokio::spawn(f);
        }),
    );
    (service, deps)
}

#[tokio::test]
async fn reports_every_cell_whose_cli_is_missing_and_keeps_the_plain_answer_otherwise() {
    let (service, deps) = make_service(Some("claude"));
    let cells = json!([{ "profileId": "claude" }, { "profileId": "shell" }, { "profileId": "claude" }]);
    let created =
        service.execute_op("create_grid", json!({ "projectId": "p", "name": "G", "cells": cells }), None, None).await.unwrap();
    let ids: Vec<String> = created["cellIds"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
    assert_eq!(ids.len(), 3);
    let unavailable = created["unavailable"].as_array().unwrap();
    let reported: Vec<&str> = unavailable.iter().map(|u| u["cellId"].as_str().unwrap()).collect();
    assert_eq!(reported, [ids[0].as_str(), ids[2].as_str()]);
    assert_eq!(unavailable[0]["cli"], "claude");
    assert!(unavailable[0]["error"].as_str().unwrap().contains("Claude Code is not installed"), "{}", unavailable[0]);
    assert_eq!(service.statuses.get(&ids[0]).as_deref(), Some("exited"));
    assert_eq!(service.statuses.get(&ids[1]), None);
    // Every cell is still handed to the windows (they show the install prompt).
    assert_eq!(*deps.started.lock(), vec![ids.clone()]);

    let (service, _) = make_service(None);
    let created = service
        .execute_op("create_grid", json!({ "projectId": "p", "name": "G", "cells": [{ "profileId": "claude" }] }), None, None)
        .await
        .unwrap();
    let mut keys: Vec<&String> = created.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["cellIds", "gridId"]);
}
