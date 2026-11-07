//! The cell bookkeeping of index.ts (the StateController listener and forgetCell), tested on `Cells` alone with an inline
//! defer, and the cell id order of `cellIdsOf`.

use super::*;
use parking_lot::Mutex;
use serde_json::json;

type Queue = Arc<Mutex<Vec<Box<dyn FnOnce() + Send>>>>;

/// Cells whose settled hooks run when the test calls `run_deferred` (queueMicrotask: after the change, never inside it).
fn cells_with_queue() -> (Arc<Cells>, Queue) {
    let queue: Queue = Arc::default();
    let q = queue.clone();
    (Arc::new(Cells::with_defer(Arc::new(move |f| q.lock().push(f)))), queue)
}

fn run_deferred(queue: &Queue) -> usize {
    let list: Vec<_> = std::mem::take(&mut *queue.lock());
    let n = list.len();
    for f in list {
        f();
    }
    n
}

/// Every hook kind records `kind:cell` in one log.
fn record(cells: &Cells) -> Arc<Mutex<Vec<String>>> {
    let log: Arc<Mutex<Vec<String>>> = Arc::default();
    let l = log.clone();
    cells.on_revoke("test", move |c| l.lock().push(format!("revoke:{c}")));
    let l = log.clone();
    cells.on_forget("test", move |c| l.lock().push(format!("forget:{c}")));
    let l = log.clone();
    cells.on_forget_unless_alive("test", move |c| l.lock().push(format!("drop:{c}")));
    let l = log.clone();
    cells.on_projects_settled("test", move || l.lock().push("orphans".into()));
    let l = log.clone();
    cells.on_state_changed("test", move |_, _| l.lock().push("changed".into()));
    log
}

fn cell(id: &str, role: Option<&str>) -> Value {
    match role {
        Some(r) => json!({ "id": id, "profileId": "p", "role": r }),
        None => json!({ "id": id, "profileId": "p" }),
    }
}

fn state(tabs: Vec<Vec<Value>>, archive: Vec<Vec<Value>>) -> Value {
    let tab = |cells: Vec<Value>| json!({ "id": "t", "cells": cells });
    json!({
        "projects": [{
            "id": "p1",
            "tabs": tabs.into_iter().map(tab).collect::<Vec<_>>(),
            "archive": archive.into_iter().map(tab).collect::<Vec<_>>(),
        }],
        "settings": { "alerts": {} },
    })
}

#[test]
fn a_team_cell_that_leaves_the_grids_loses_its_token_and_a_removed_cell_is_forgotten() {
    let (cells, queue) = cells_with_queue();
    let log = record(&cells);
    let before = state(vec![vec![cell("lead", Some("lead")), cell("dev", Some("dev")), cell("plain", None)]], vec![]);
    // "dev" archived (still in the state), "lead" closed for good, "plain" closed for good.
    let after = state(vec![vec![]], vec![vec![cell("dev", Some("dev"))]]);
    cells.state_changed(&before, &after);
    assert_eq!(
        *log.lock(),
        vec!["revoke:lead", "revoke:dev", "forget:lead", "drop:lead", "forget:plain", "drop:plain", "changed"],
        "archived cells keep their bookkeeping, every cell that left the grids for good is forgotten"
    );
    // cancelOrphans runs after the change settled, once.
    assert_eq!(run_deferred(&queue), 1);
    assert_eq!(log.lock().last().map(String::as_str), Some("orphans"));
    // Emptying the archive forgets the archived cell; it had no role in the grids any more, so nothing is revoked.
    log.lock().clear();
    cells.state_changed(&after, &state(vec![vec![]], vec![]));
    assert_eq!(*log.lock(), vec!["forget:dev", "drop:dev", "changed"]);
}

#[test]
fn a_cell_whose_process_still_runs_keeps_its_files_and_hook_settings() {
    let (cells, _queue) = cells_with_queue();
    let log = record(&cells);
    cells.set_alive("a", true);
    cells.state_changed(&state(vec![vec![cell("a", None), cell("b", None)]], vec![]), &state(vec![vec![]], vec![]));
    assert_eq!(*log.lock(), vec!["forget:a", "forget:b", "drop:b", "changed"]);
    assert!(cells.is_alive("a"));
    cells.set_alive("a", false);
    assert!(!cells.is_alive("a"));
    assert!(cells.alive().is_empty());
}

#[test]
fn a_change_that_keeps_the_projects_only_reaches_the_state_hooks() {
    let (cells, queue) = cells_with_queue();
    let log = record(&cells);
    let a = state(vec![vec![cell("a", Some("lead"))]], vec![]);
    let mut b = a.clone();
    b["settings"]["alerts"] = json!({ "taskbarBadge": true });
    cells.state_changed(&a, &b);
    assert_eq!(*log.lock(), vec!["changed"]);
    assert_eq!(run_deferred(&queue), 0, "no cancelOrphans without a change of the projects");
    // A change of the projects that removes nothing still queues cancelOrphans (an agent's task list or a role changed).
    let mut c = b.clone();
    c["projects"][0]["name"] = json!("renamed");
    cells.state_changed(&b, &c);
    assert_eq!(*log.lock(), vec!["changed", "changed"]);
    assert_eq!(run_deferred(&queue), 1);
}

#[test]
fn a_role_taken_away_in_the_grid_revokes_the_token_too() {
    let (cells, _queue) = cells_with_queue();
    let log = record(&cells);
    // `!!cell.role`: an empty role is no role, so "b" never had a token to revoke.
    let before = state(vec![vec![cell("a", Some("dev")), cell("b", Some(""))]], vec![]);
    let after = state(vec![vec![cell("a", None), cell("b", None)]], vec![]);
    cells.state_changed(&before, &after);
    assert_eq!(*log.lock(), vec!["revoke:a", "changed"]);
}

#[test]
fn cell_ids_keep_the_order_of_first_sight_without_repeats() {
    let s = json!({ "projects": [
        { "tabs": [{ "cells": [{ "id": "a" }, { "id": "b", "role": "x" }] }, { "cells": [{ "id": "a" }, { "nope": 1 }] }],
          "archive": [{ "cells": [{ "id": "z" }] }] },
        { "tabs": [{ "cells": [{ "id": "c" }] }] },
        { "tabs": "broken" },
    ] });
    assert_eq!(cell_ids_of(&s, false, |_| true), vec!["a", "b", "z", "c"]);
    assert_eq!(cell_ids_of(&s, true, |_| true), vec!["a", "b", "c"]);
    assert_eq!(cell_ids_of(&s, true, has_role), vec!["b"]);
    assert!(cell_ids_of(&json!({}), false, |_| true).is_empty());
}

#[test]
fn runtime_reports_are_read_like_the_1_1_4_handler() {
    let r = parse_runtime(&[json!("c"), json!("waiting"), json!("attention"), json!(true), json!(false), json!(3)]).unwrap();
    assert_eq!(
        r,
        CellReport {
            cell: "c".into(),
            status: "waiting".into(),
            reason: Some("attention".into()),
            hooked: true,
            cli_ended: false,
            exit_code: Some(3),
        }
    );
    // `hooked === true` and `cliEnded === true` only; an exit code only when it is an integer.
    let r = parse_runtime(&[json!("c"), json!("exited"), Value::Null, json!("yes"), json!(true), json!(1.5)]).unwrap();
    assert!(!r.hooked && r.cli_ended && r.exit_code.is_none() && r.reason.is_none());
    assert_eq!(
        parse_runtime(&[json!("c"), json!("exited"), Value::Null, Value::Null, json!(true), json!(-2.0)]).unwrap().exit_code,
        Some(-2)
    );
    assert_eq!(parse_runtime(&[json!("c")]), None);
    assert_eq!(parse_runtime(&[json!(1), json!("idle")]), None);
    assert_eq!(parse_runtime(&[]), None);
}

#[test]
fn the_report_names_what_is_wired() {
    let (cells, _queue) = cells_with_queue();
    record(&cells);
    cells.on_runtime("watch", |_| {});
    cells.set_alive("x", true);
    cells.gates.cell_services.open();
    let report = cells.report();
    assert_eq!(report["alive"], json!(["x"]));
    assert_eq!(report["gates"], json!({ "cellServices": true, "accountsRecovered": false, "accountsReady": false }));
    assert_eq!(report["hooks"]["runtime"], json!(["watch"]));
    assert_eq!(report["hooks"]["forgetUnlessAlive"], json!(["test"]));
}
