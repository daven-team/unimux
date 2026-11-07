//! The detached-window cases of test/detached-windows.test.ts that run through the whole state code (normalize on load, the
//! renderer edit merge and its normalization) rather than the registry functions alone (those are in src/detached.rs).

use std::sync::Arc;

use serde_json::{Value, json};
use unimux_state::StateController;
use unimux_state::edits::merge_state_edit;
use unimux_state::normalize::state::default_state;
use unimux_state::normalize::windows::{normalize_detached_windows, open_grids};
use unimux_state::normalize::{Normalizer, Platform, StateNormalizer};

const P: &str = "88293dca-baf6-4ae9-848b-232ed0e5a5fd";
const A: &str = "d25e1b50-4b02-4f1a-aeb1-2783d946d7e7";
const B: &str = "a15ad327-8432-4de1-90c9-a7dcbe1551dd";

/// `twoGrids()` of the TS test, as addProject + addTab x 2 of src/shared/state.ts write it (ids taken from one TS run).
fn two_grids() -> Value {
    let projects = json!([{"id":P,"name":"P","path":"C:\\p","color":"#3b82f6","tabs":[
        {"id":A,"color":"#60a5fa","name":"Grid 1","layout":{"cols":2,"rows":1,"areas":[{"col":0,"row":0,"colSpan":1,"rowSpan":1},{"col":1,"row":0,"colSpan":1,"rowSpan":1}]},
         "cells":[{"id":"de3a412a-ba64-47f2-bdcc-ae22fce6709c","profileId":"shell","color":"#60a5fa"},{"id":"0dd24b95-d6e1-41e8-8af9-922a346770d7","profileId":"shell","color":"#a78bfa"}]},
        {"id":B,"color":"#a78bfa","name":"Grid 5","layout":{"cols":1,"rows":1,"areas":[{"col":0,"row":0,"colSpan":1,"rowSpan":1}]},
         "cells":[{"id":"b8224431-9168-4298-a731-852d40cab7fd","profileId":"shell","color":"#60a5fa"}]}],
        "archive":[],"activeTabId":B}]);
    let mut s = default_state(Platform::Win32);
    s["projects"] = projects;
    s["activeProjectId"] = json!(P);
    s
}

fn grid_window(id: &str, tab: &str) -> Value {
    json!({ "id": id, "target": { "kind": "grid", "projectId": P, "tabId": tab } })
}

fn with_windows(s: &Value, list: Vec<Value>) -> Value {
    let mut out = s.clone();
    out["detachedWindows"] = Value::Array(list);
    out
}

fn without_tab(s: &Value, tab: &str) -> Value {
    let mut out = s.clone();
    for p in out["projects"].as_array_mut().unwrap() {
        p["tabs"].as_array_mut().unwrap().retain(|t| t["id"] != tab);
        if p["activeTabId"] == tab {
            p["activeTabId"] = p["tabs"][0]["id"].clone();
        }
    }
    out
}

fn ids(s: &Value) -> Option<Vec<String>> {
    s.get("detachedWindows").map(|l| l.as_array().unwrap().iter().map(|w| w["id"].as_str().unwrap().to_string()).collect())
}

/// detached-windows.test.ts "survives a save and load, and drops the window of a grid that is gone".
#[test]
fn survives_a_save_and_load_and_drops_the_window_of_a_grid_that_is_gone() {
    let mut w1 = grid_window("w1", A);
    w1["bounds"] = json!({ "x": 0, "y": 0, "width": 900, "height": 700 });
    let saved = with_windows(&two_grids(), vec![w1]);
    let loaded = StateNormalizer.normalize(saved.clone(), Platform::Win32).unwrap();
    assert_eq!(loaded["detachedWindows"], saved["detachedWindows"]);
    let closed = without_tab(&saved, A);
    let loaded = StateNormalizer.normalize(closed, Platform::Win32).unwrap();
    assert!(loaded.get("detachedWindows").is_none());
}

/// detached-windows.test.ts "shows the detached tab as active in its window, and the overlay never travels with an edit"
/// (main's half: the overlay itself is renderer code, viewOverlay in src/shared/detached.ts).
#[test]
fn the_overlay_of_a_detached_window_never_travels_with_an_edit() {
    let mut real = two_grids();
    real["activeProjectId"] = Value::Null;
    real["projects"][0]["activeTabId"] = json!(A);
    // What viewOverlay(real, grid B) gives the detached window.
    let mut view = real.clone();
    view["activeProjectId"] = json!(P);
    view["projects"][0]["activeTabId"] = json!(B);
    // An edit made in the detached window (a grid renamed) changes only that grid in main's state.
    let mut next = view.clone();
    next["projects"][0]["tabs"][1]["name"] = json!("Renamed");
    let merged = merge_state_edit(&real, &view, &next);
    assert_eq!(merged["activeProjectId"], Value::Null);
    assert_eq!(merged["projects"][0]["activeTabId"], json!(A));
    assert_eq!(merged["projects"][0]["tabs"][1]["name"], json!("Renamed"));
}

/// detached-windows.test.ts "a renderer edit can neither add nor remove a detached window (main owns the registry)".
#[test]
fn a_renderer_edit_can_neither_add_nor_remove_a_detached_window() {
    let with_window = with_windows(&two_grids(), vec![grid_window("w1", A)]);
    let c = StateController::new(with_window.clone(), Arc::new(StateNormalizer));
    let added = with_windows(&with_window, vec![grid_window("w1", A), grid_window("w2", B)]);
    c.apply_edit("e1", &with_window, &added).unwrap();
    assert_eq!(ids(&c.get()), Some(vec!["w1".to_string()]));
    let base = (*c.get()).clone();
    let mut removed = base.clone();
    removed.as_object_mut().unwrap().shift_remove("detachedWindows");
    c.apply_edit("e2", &base, &removed).unwrap();
    assert_eq!(ids(&c.get()), Some(vec!["w1".to_string()]));
    // Closing the grid in the renderer drops its window.
    let base = (*c.get()).clone();
    let closed = without_tab(&base, A);
    c.apply_edit("e3", &base, &closed).unwrap();
    assert_eq!(ids(&c.get()), None);
}

/// detached-tabs.test.ts "keeps the new reopen kinds and refuses broken ones" (cleanTarget and a registry with them that
/// survives a restart).
#[test]
fn keeps_the_new_reopen_kinds_and_refuses_broken_ones() {
    use unimux_state::normalize::windows::clean_target;
    const CONN: &str = "00000000-0000-4000-8000-0000000000c1";
    const HOST: &str = "00000000-0000-4000-8000-0000000000a1";
    const UID: &str = "00000000-0000-4000-8000-0000000000d1";
    let table_ref = json!({ "kind": "table", "connectionId": CONN, "database": "shop", "schema": "public", "table": "users", "objectKind": "table" });
    let sql_ref = json!({ "kind": "sql", "connectionId": CONN, "database": "shop", "uid": UID });
    let redis_ref = json!({ "kind": "redis", "view": "keys", "connectionId": CONN, "db": 2, "uid": UID });
    // dbTabId / redisTabId of those refs.
    let table_id = format!(r#"["db","table","{CONN}","shop","public","users"]"#);
    let sql_id = format!(r#"["db","sql","{CONN}","{UID}"]"#);
    let redis_id = format!(r#"["redis","keys","{CONN}","{UID}"]"#);
    let db = json!({ "kind": "file", "fileId": table_id, "projectId": "", "name": "users", "reopen": { "kind": "db", "ref": table_ref, "path": "prod · shop · public.users" } });
    assert_eq!(clean_target(Some(&db)), Some(db.clone()));
    let sql = json!({ "kind": "file", "fileId": sql_id, "projectId": "", "name": "SQL 1", "reopen": { "kind": "db", "ref": sql_ref, "path": "prod · shop · SQL 1" } });
    assert_eq!(clean_target(Some(&sql)), Some(sql.clone()));
    let redis = json!({ "kind": "file", "fileId": redis_id, "projectId": "", "name": "cache", "reopen": { "kind": "redis", "ref": redis_ref, "path": "cache · Keys · DB 2" } });
    assert_eq!(clean_target(Some(&redis)), Some(redis.clone()));
    let remote = json!({ "kind": "file", "fileId": "remote-id", "projectId": "", "name": "nginx.conf", "reopen": { "kind": "remote", "hostId": HOST, "path": "/etc/nginx/nginx.conf" } });
    assert_eq!(clean_target(Some(&remote)), Some(remote.clone()));
    let mut bad = remote.clone();
    bad["reopen"]["path"] = json!("relative/path");
    assert_eq!(clean_target(Some(&bad)), None);
    let mut bad = remote.clone();
    bad["reopen"]["hostId"] = json!("not-a-uuid");
    assert_eq!(clean_target(Some(&bad)), None);
    let mut bad = db.clone();
    bad["reopen"] = json!({ "kind": "db", "ref": { "kind": "table", "connectionId": "x", "database": "shop", "schema": "public", "table": "users", "objectKind": "table" }, "path": "p" });
    assert_eq!(clean_target(Some(&bad)), None);
    let mut bad = redis.clone();
    bad["reopen"] = json!({ "kind": "redis", "ref": { "kind": "redis", "view": "nope", "connectionId": CONN, "db": 2, "uid": UID }, "path": "p" });
    assert_eq!(clean_target(Some(&bad)), None);
    // A registry with them survives a restart.
    let list = json!([{ "id": "w1", "target": db }, { "id": "w2", "target": redis }, { "id": "w3", "target": remote }]);
    let out = normalize_detached_windows(Some(&list), &open_grids(&[])).unwrap();
    assert_eq!(ids(&json!({ "detachedWindows": out })), Some(vec!["w1".into(), "w2".into(), "w3".into()]));
}
