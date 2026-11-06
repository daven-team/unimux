//! The detached-window service against a recording host (the main-side behaviour of src/main/detachedWindows.ts): detach,
//! hand-over, close = attach back with the 3 s timeout and `detach:stay`, forced close, quit, dismiss, work and wait relays,
//! reveal, registry repair, place saving, restart placement and the routed events of a detached grid.

use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::Mutex;
use serde_json::{Value, json};

use unimux_ipc::{EventSink, Events};
use unimux_state::detached::{DisplayArea, Rect};
use unimux_state::{PassThrough, StateController};

use super::*;

#[derive(Default)]
struct FakeHost {
    calls: Mutex<Vec<String>>,
    open: Mutex<Vec<String>>,
    cursor: Mutex<Option<(f64, f64)>>,
    main: Mutex<Option<Rect>>,
    displays: Mutex<Vec<DisplayArea>>,
    places: Mutex<Vec<(String, Rect, bool)>>,
}

impl FakeHost {
    fn calls(&self) -> Vec<String> {
        self.calls.lock().clone()
    }
}

impl Host for FakeHost {
    fn open(&self, id: &str, title: &str, bounds: Rect, maximized: bool, index: usize) -> Result<(), String> {
        self.calls.lock().push(format!(
            "open {id} {title} {},{},{},{} max={maximized} #{index}",
            bounds.x, bounds.y, bounds.width, bounds.height
        ));
        self.open.lock().push(id.to_string());
        Ok(())
    }
    fn destroy(&self, id: &str) {
        self.calls.lock().push(format!("destroy {id}"));
        self.open.lock().retain(|x| x != id);
    }
    fn close(&self, id: &str) {
        self.calls.lock().push(format!("close {id}"));
    }
    fn set_title(&self, id: &str, title: &str) {
        self.calls.lock().push(format!("title {id} {title}"));
    }
    fn show(&self, label: &str) {
        self.calls.lock().push(format!("show {label}"));
    }
    fn displays(&self) -> (Vec<DisplayArea>, f64) {
        (self.displays.lock().clone(), 1.0)
    }
    fn cursor(&self) -> Option<(f64, f64)> {
        *self.cursor.lock()
    }
    fn main_bounds(&self) -> Option<Rect> {
        *self.main.lock()
    }
    fn main_shown(&self) -> bool {
        self.main.lock().is_some()
    }
    fn place(&self, id: &str) -> Option<(Rect, Option<f64>, bool)> {
        self.places.lock().iter().rev().find(|(x, _, _)| x == id).map(|(_, r, m)| (*r, Some(2.0), *m))
    }
}

struct Sink {
    host: Arc<FakeHost>,
    log: Mutex<Vec<String>>,
}

impl EventSink for Sink {
    fn app_windows(&self) -> Vec<String> {
        let mut out = vec!["main".to_string()];
        out.extend(self.host.open.lock().iter().map(|id| format!("detached-{id}")));
        out
    }
    fn emit_to(&self, label: &str, event: &str, payload: &Value) {
        if event != "state:changed" {
            self.log.lock().push(format!("{label} {event} {payload}"));
        }
    }
}

struct Rig {
    svc: Arc<DetachedService>,
    state: Arc<StateController>,
    host: Arc<FakeHost>,
    sink: Arc<Sink>,
    events: Arc<Events>,
    routes: Arc<Mutex<Vec<String>>>,
}

const PRIMARY: DisplayArea = DisplayArea { id: 1.0, work_area: Rect::new(0.0, 0.0, 1920.0, 1040.0) };
const SECOND: DisplayArea = DisplayArea { id: 2.0, work_area: Rect::new(1920.0, 0.0, 2560.0, 1400.0) };

fn base_state() -> Value {
    json!({
        "version": 1,
        "projects": [{
            "id": "p1", "name": "P", "activeTabId": "ta",
            "tabs": [
                { "id": "ta", "name": "Grid 1", "cells": [{ "id": "c1" }, { "id": "c2" }] },
                { "id": "tb", "name": "Grid 5", "cells": [{ "id": "c3" }] }
            ]
        }]
    })
}

fn rig_with(state: Value, offscreen: bool) -> Rig {
    let host = Arc::new(FakeHost::default());
    *host.displays.lock() = vec![PRIMARY, SECOND];
    *host.main.lock() = Some(Rect::new(100.0, 50.0, 1600.0, 950.0));
    let sink = Arc::new(Sink { host: host.clone(), log: Mutex::new(Vec::new()) });
    let events = Arc::new(Events::new(sink.clone()));
    let state = Arc::new(StateController::new(state, Arc::new(PassThrough)));
    let svc = DetachedService::with_timing(
        state.clone(),
        events.clone(),
        offscreen,
        Arc::new(|_m: &str| {}),
        Duration::from_millis(150),
        Duration::from_millis(40),
    );
    let routes = Arc::new(Mutex::new(Vec::new()));
    let r = routes.clone();
    svc.hooks()
        .on_route
        .push(Arc::new(move |cell: &str, w: Option<&str>| r.lock().push(format!("{cell}->{}", w.unwrap_or("main")))));
    svc.hooks().is_alive = Some(Arc::new(|cell: &str| cell != "c2"));
    svc.set_host(host.clone());
    let s = svc.clone();
    events.on_focus_cell(move |label| s.focus_label(label));
    svc.start();
    Rig { svc, state, host, sink, events, routes }
}

fn rig() -> Rig {
    rig_with(base_state(), false)
}

/// Waits until `f` holds (the service creates windows and saves places on other threads).
fn wait_for(what: &str, f: impl Fn() -> bool) {
    let until = Instant::now() + Duration::from_secs(5);
    while !f() {
        assert!(Instant::now() < until, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(5));
    }
}

fn registry(r: &Rig) -> Vec<Value> {
    detached_list(&r.state.get()).to_vec()
}

fn events_of(r: &Rig) -> Vec<String> {
    r.sink.log.lock().clone()
}

fn grid(tab: &str) -> Value {
    json!({ "kind": "grid", "projectId": "p1", "tabId": tab })
}

fn file_target(file: &str) -> Value {
    json!({ "kind": "file", "fileId": file, "projectId": "p1", "name": "a.ts", "reopen": { "kind": "project", "projectId": "p1", "relativePath": "src/a.ts" } })
}

fn detach_grid(r: &Rig, tab: &str) -> String {
    let out = r.svc.cmd_open("main", &grid(tab), None);
    assert_eq!(out["ok"], true, "{out}");
    let id = out["id"].as_str().unwrap().to_string();
    wait_for("the window", || r.host.open.lock().contains(&id));
    id
}

#[test]
fn the_menu_detaches_a_grid_to_the_other_display_and_its_cells_follow() {
    let r = rig();
    let id = detach_grid(&r, "tb");
    let list = registry(&r);
    assert_eq!(list.len(), 1);
    assert_eq!(list[0]["target"], grid("tb"));
    // boundsBeside: centered on the other display.
    assert_eq!(list[0]["bounds"], json!({ "x": 2700, "y": 350, "width": 1000, "height": 700 }));
    assert_eq!(list[0]["displayId"], 2);
    assert_eq!(r.host.calls(), vec![format!("open {id} Grid 5 - P - unimux 2700,350,1000,700 max=false #0")]);
    assert_eq!(*r.routes.lock(), vec![format!("c3->{id}")]);
    assert_eq!(r.svc.cell_window("c3"), format!("detached-{id}"));
    assert_eq!(r.svc.cell_window("c1"), "main");
    // A cell's messages go to the window showing it; the state to every window; the rest to main.
    r.events.send("cell:hook", vec![json!("c3"), json!("stop")]);
    r.events.send("cell:hook", vec![json!("c1"), json!("stop")]);
    r.events.send("cli:changed", vec![json!({})]);
    r.events.send("auth:state", vec![json!({})]);
    let label = format!("detached-{id}");
    assert_eq!(
        events_of(&r),
        vec![
            format!(r#"{label} cell:hook ["c3","stop"]"#),
            r#"main cell:hook ["c1","stop"]"#.to_string(),
            r#"main cli:changed [{}]"#.to_string(),
            format!(r#"{label} cli:changed [{{}}]"#),
            r#"main auth:state [{}]"#.to_string(),
        ]
    );
    // focus-cell of a detached cell brings its window up first.
    r.events.send("focus-cell", vec![json!("c3")]);
    assert!(r.host.calls().contains(&format!("show {label}")));
    // The same grid again: the existing window comes up.
    let again = r.svc.cmd_open("main", &grid("tb"), None);
    assert_eq!(again, json!({ "ok": true, "id": id }));
    // Only the main window may detach; a detached window is refused.
    assert_eq!(r.svc.cmd_open(&label, &grid("ta"), None), json!({ "ok": false, "error": "refused" }));
}

#[test]
fn bad_targets_documents_and_the_limit_are_refused() {
    let r = rig();
    assert_eq!(r.svc.cmd_open("main", &json!({ "kind": "grid" }), None)["error"], "invalid");
    assert_eq!(r.svc.cmd_open("main", &json!({ "kind": "grid", "projectId": "other", "tabId": "ta" }), None)["error"], "invalid");
    assert_eq!(r.svc.cmd_open("main", &grid("ta"), Some(&json!("x")))["error"], "invalid");
    assert_eq!(r.svc.cmd_open("main", &grid("ta"), Some(&json!([1, 2, 3, 4, 5])))["error"], "invalid");
    // A file tab travels with exactly one document.
    assert_eq!(r.svc.cmd_open("main", &file_target("f1"), Some(&json!([])))["error"], "invalid");
    let full: Vec<Value> = (0..8).map(|i| json!({ "id": format!("w{i}"), "target": file_target(&format!("x{i}")) })).collect();
    let _ = r.state.change(
        |s| {
            let mut s = s.clone();
            s["detachedWindows"] = Value::Array(full.clone());
            Ok(s)
        },
        None,
        false,
    );
    assert_eq!(r.svc.cmd_open("main", &grid("ta"), None), json!({ "ok": false, "error": "limit" }));
}

#[test]
fn a_file_tab_hands_its_document_over_once() {
    let r = rig();
    let doc = json!({ "id": "f1", "text": "unsaved" });
    let s1 = "db:00000000-0000-4000-8000-0000000000e1";
    let handoff = json!({ "handoff": "tab", "fileId": "f1", "dbSessions": [s1] });
    let sessions = Arc::new(Mutex::new(Vec::new()));
    let s = sessions.clone();
    r.svc
        .hooks()
        .on_route_db_sessions
        .push(Arc::new(move |list: &[String], w: Option<&str>| s.lock().push(format!("{list:?}->{}", w.unwrap_or("main")))));
    let out = r.svc.cmd_open("main", &file_target("f1"), Some(&json!([doc, handoff])));
    let id = out["id"].as_str().unwrap().to_string();
    wait_for("the window", || r.host.open.lock().contains(&id));
    let label = format!("detached-{id}");
    assert_eq!(*sessions.lock(), vec![format!("[\"{s1}\"]->{id}")]);
    // Only the new window takes it, and only once.
    assert_eq!(r.svc.cmd_take("main"), json!([]));
    assert_eq!(r.svc.cmd_take(&label), json!([doc, handoff]));
    assert_eq!(r.svc.cmd_take(&label), json!([]));
    // It gives the edited text back: the main window hears it, the registry entry goes, the window is destroyed.
    let back = json!({ "id": "f1", "text": "edited" });
    assert!(r.svc.cmd_attach(&label, Some(&json!([back, handoff])), &Value::Null));
    assert!(registry(&r).is_empty());
    let returned = events_of(&r).into_iter().find(|e| e.contains("detach:returned")).unwrap();
    assert!(returned.starts_with("main detach:returned"));
    assert!(returned.contains(r#""docs":[{"id":"f1","text":"edited"}"#), "{returned}");
    assert_eq!(sessions.lock().last().unwrap(), &format!("[\"{s1}\"]->main"));
    wait_for("the window to go", || r.host.calls().contains(&format!("destroy {id}")));
    assert!(r.host.calls().contains(&"show main".to_string()));
}

#[test]
fn the_close_button_attaches_back_after_the_window_answers_or_the_timeout() {
    let r = rig();
    let id = detach_grid(&r, "ta");
    let label = format!("detached-{id}");
    // Close: held, the window is asked for its tab.
    assert!(r.svc.close_requested(&id));
    assert!(events_of(&r).contains(&format!("{label} detach:closing []")));
    // A second close while it is asked does not ask again.
    assert!(r.svc.close_requested(&id));
    assert_eq!(events_of(&r).iter().filter(|e| e.contains("detach:closing")).count(), 1);
    // No answer: after the timeout the tab comes back without documents; running cells are adopted (c2 is not alive).
    wait_for("the attach", || registry(&r).is_empty());
    let returned = events_of(&r).into_iter().find(|e| e.contains("detach:returned")).unwrap();
    assert_eq!(
        returned,
        format!(
            r#"main detach:returned [{{"id":"{id}","target":{{"kind":"grid","projectId":"p1","tabId":"ta"}},"docs":[],"alive":["c1"]}}]"#
        )
    );
    wait_for("the window to go", || r.host.calls().contains(&format!("destroy {id}")));
    // The cells route back to main.
    assert!(r.routes.lock().contains(&"c1->main".to_string()));
}

#[test]
fn stay_keeps_a_closing_window_until_it_attaches_itself() {
    let r = rig();
    let id = detach_grid(&r, "ta");
    let label = format!("detached-{id}");
    assert!(r.svc.close_requested(&id));
    r.svc.cmd_stay(&label);
    std::thread::sleep(Duration::from_millis(400));
    assert_eq!(registry(&r).len(), 1, "no timeout after detach:stay");
    // The window answers later: attach with its documents.
    assert!(r.svc.cmd_attach(&label, None, &Value::Null));
    assert!(registry(&r).is_empty());
}

#[test]
fn a_window_gone_without_answering_still_returns_its_tab_but_not_when_the_app_closes() {
    let r = rig();
    let a = detach_grid(&r, "ta");
    r.svc.closed(&a);
    assert!(registry(&r).is_empty(), "a forced close attaches");
    let b = detach_grid(&r, "tb");
    r.svc.close_all();
    assert!(r.host.calls().contains(&format!("close {b}")));
    assert!(!r.svc.close_requested(&b), "closing for the quit is not held");
    r.svc.closed(&b);
    assert_eq!(registry(&r).len(), 1, "the registry stays for the next start");
    // While quitting (W6) neither.
    let r2 = rig();
    let c = detach_grid(&r2, "ta");
    r2.svc.set_quitting(true);
    assert!(!r2.svc.close_requested(&c));
    r2.svc.closed(&c);
    assert_eq!(registry(&r2).len(), 1);
}

#[test]
fn the_main_window_asks_back_dismiss_removes_and_only_its_own_window_may_attach() {
    let r = rig();
    let id = detach_grid(&r, "ta");
    let label = format!("detached-{id}");
    // From a detached window requestAttach does nothing; from main it asks the window.
    r.svc.cmd_request_attach(&label, &json!(id));
    assert!(!events_of(&r).iter().any(|e| e.contains("detach:closing")));
    r.svc.cmd_request_attach("main", &json!(id));
    assert!(events_of(&r).contains(&format!("{label} detach:closing []")));
    r.svc.cmd_stay(&label);
    // The main window cannot attach or dismiss for a detached window.
    assert!(!r.svc.cmd_attach("main", None, &Value::Null));
    assert!(!r.svc.cmd_dismiss("main"));
    // overMain: only with the cursor over the main window.
    *r.host.cursor.lock() = Some((5000.0, 5000.0));
    assert!(!r.svc.cmd_attach(&label, None, &json!(true)));
    *r.host.cursor.lock() = Some((200.0, 200.0));
    assert!(r.svc.cmd_dismiss(&label));
    assert!(registry(&r).is_empty());
    assert!(!events_of(&r).iter().any(|e| e.contains("detach:returned")), "dismiss gives nothing back");
}

#[test]
fn a_drop_outside_opens_under_the_cursor_and_a_drop_inside_does_nothing() {
    let r = rig();
    *r.host.cursor.lock() = Some((500.0, 500.0));
    assert_eq!(r.svc.cmd_drop_outside("main", &grid("ta"), None), json!({ "ok": false, "error": "inside" }));
    *r.host.cursor.lock() = Some((2500.0, 300.0));
    let out = r.svc.cmd_drop_outside("main", &grid("ta"), None);
    assert_eq!(out["ok"], true);
    assert_eq!(registry(&r)[0]["bounds"], json!({ "x": 2340, "y": 282, "width": 1000, "height": 700 }));
    // A minimized or hidden main window never counts as "inside".
    *r.host.main.lock() = None;
    *r.host.cursor.lock() = Some((500.0, 500.0));
    assert_eq!(r.svc.cmd_drop_outside("main", &grid("tb"), None)["ok"], true);
}

#[test]
fn work_and_wait_reports_reach_the_main_window() {
    let r = rig();
    let id = detach_grid(&r, "tb");
    let label = format!("detached-{id}");
    r.svc.cmd_work(&label, &json!({ "tx": 1, "staged": 0, "redis": 0 }));
    r.svc.cmd_work(&label, &json!({ "tx": 1, "staged": 0, "redis": 0 }));
    r.svc.cmd_work("main", &json!({ "tx": 5 }));
    assert_eq!(r.svc.cmd_works("main"), json!([{ "id": id, "work": { "tx": 1, "staged": 0, "redis": 0 } }]));
    assert_eq!(r.svc.cmd_works(&label), json!([]));
    assert_eq!(events_of(&r).iter().filter(|e| e.contains("detach:work")).count(), 1);
    // Waits: a window reports only its own cells; a detached report is relayed.
    let mark = json!({ "kind": "permission", "since": 5, "tool": "Bash" });
    r.svc.cmd_wait(&label, &json!("c1"), &mark);
    r.svc.cmd_wait(&label, &json!("c3"), &mark);
    r.svc.cmd_wait("main", &json!("c1"), &json!({ "kind": "done", "since": 6 }));
    assert_eq!(events_of(&r).iter().filter(|e| e.starts_with("main detach:wait")).count(), 1);
    assert_eq!(r.svc.cmd_waits(&label), json!([{ "cellId": "c3", "mark": mark }]));
    assert_eq!(r.svc.cmd_waits("main").as_array().unwrap().len(), 2);
    assert_eq!(r.svc.cell_waits().iter().map(|(c, _)| c.as_str()).collect::<Vec<_>>(), vec!["c3", "c1"]);
    r.svc.cmd_wait_step(&label, &json!(-1));
    r.svc.cmd_wait_step("main", &json!(-1));
    assert_eq!(events_of(&r).iter().filter(|e| *e == "main waiting:step [-1]").count(), 1);
    // A closed grid loses its waits; the page going away drops its work.
    let _ = r.state.change(
        |s| {
            let mut s = s.clone();
            s["projects"][0]["tabs"].as_array_mut().unwrap().remove(1);
            Ok(s)
        },
        None,
        false,
    );
    assert_eq!(r.svc.cmd_waits("main"), json!([{ "cellId": "c1", "mark": { "kind": "done", "since": 6 } }]));
    // ...and its window goes with the registry repair.
    wait_for("the repair", || registry(&r).is_empty());
    wait_for("the window to go", || r.host.calls().contains(&format!("destroy {id}")));
    assert_eq!(r.svc.cmd_works("main"), json!([]));
    assert!(events_of(&r).contains(&format!(r#"main detach:work ["{id}",null]"#)));
}

#[test]
fn reveal_status_relay_and_open_in_main() {
    let r = rig();
    let id = detach_grid(&r, "tb");
    let label = format!("detached-{id}");
    r.svc.cmd_reveal_cell("main", &json!("c3"));
    assert!(r.host.calls().contains(&format!("show {label}")));
    assert!(events_of(&r).contains(&format!(r#"{label} focus-cell ["c3"]"#)));
    r.svc.cmd_reveal_cell("main", &json!("c1"));
    assert!(events_of(&r).contains(&r#"main focus-cell ["c1"]"#.to_string()));
    r.svc.cmd_reveal_cell("main", &json!("nope"));
    r.svc.relay_cell_status(&label, &json!("c3"), &json!("waiting"));
    r.svc.relay_cell_status("main", &json!("c1"), &json!("waiting"));
    assert_eq!(events_of(&r).iter().filter(|e| e.contains("detach:status")).count(), 1);
    let conn = "00000000-0000-4000-8000-0000000000c1";
    r.svc.cmd_open_in_main(&label, &json!({ "kind": "redis", "connectionId": conn, "view": "keys", "db": 0 }));
    r.svc.cmd_open_in_main("main", &json!({ "kind": "redis", "connectionId": conn, "view": "keys", "db": 0 }));
    r.svc.cmd_open_in_main(&label, &json!({ "kind": "redis", "connectionId": "x", "view": "keys", "db": 0 }));
    assert_eq!(events_of(&r).iter().filter(|e| e.contains("detach:openInMain")).count(), 1);
    assert_eq!(r.svc.sender_window(&label), id);
    assert_eq!(r.svc.sender_window("main"), "main");
}

#[test]
fn a_moved_window_saves_its_place_once_after_the_moves_and_not_offscreen() {
    let r = rig();
    let id = detach_grid(&r, "ta");
    for x in [10.0, 20.0, 30.0] {
        r.host.places.lock().push((id.clone(), Rect::new(x, 40.0, 900.0, 650.0), false));
        r.svc.place_changed(&id);
    }
    let revision = r.state.revision();
    wait_for("the save", || registry(&r)[0]["bounds"]["x"] == 30);
    assert_eq!(registry(&r)[0]["bounds"], json!({ "x": 30, "y": 40, "width": 900, "height": 650 }));
    assert_eq!(registry(&r)[0]["displayId"], 2);
    std::thread::sleep(Duration::from_millis(100));
    assert_eq!(r.state.revision(), revision + 1, "one save for three moves");
    r.host.places.lock().push((id.clone(), Rect::new(30.0, 40.0, 900.0, 650.0), true));
    r.svc.place_changed(&id);
    wait_for("the maximized save", || registry(&r)[0]["maximized"] == true);

    let off = rig_with(base_state(), true);
    let id = detach_grid(&off, "ta");
    off.host.places.lock().push((id.clone(), Rect::new(10.0, 40.0, 900.0, 650.0), false));
    off.svc.place_changed(&id);
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(registry(&off)[0]["bounds"]["x"], 2700, "offscreen runs keep the saved place");
}

#[test]
fn a_restart_reopens_every_window_at_its_saved_place() {
    let mut s = base_state();
    s["detachedWindows"] = json!([
        { "id": "w1", "target": grid("ta"), "bounds": { "x": 2100, "y": 100, "width": 1200, "height": 800 }, "displayId": 2, "maximized": true },
        { "id": "w2", "target": file_target("f1"), "bounds": { "x": 9000, "y": 100, "width": 600, "height": 400 } }
    ]);
    let r = rig_with(s, false);
    wait_for("both windows", || r.host.open.lock().len() == 2);
    let calls = r.host.calls();
    assert!(calls.contains(&"open w1 Grid 1 - P - unimux 2100,100,1200,800 max=true #0".to_string()), "{calls:?}");
    // The monitor of w2 is gone: centered on the primary display.
    assert!(calls.contains(&"open w2 a.ts - unimux 660,320,600,400 max=false #1".to_string()), "{calls:?}");
    assert_eq!(r.svc.cell_window("c1"), "detached-w1");
    // A renamed grid renames its window.
    let _ = r.state.change(
        |s| {
            let mut s = s.clone();
            s["projects"][0]["tabs"][0]["name"] = json!("Renamed");
            Ok(s)
        },
        None,
        false,
    );
    wait_for("the title", || r.host.calls().contains(&"title w1 Renamed - P - unimux".to_string()));
}
