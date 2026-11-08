//! The state IPC loop of test/state-patch.test.ts and test/state-sync-faults.test.ts on the Rust side: renderer edits arrive
//! pruned (the renderer's `pruneEdit` of src/shared/statePatch.ts, mirrored here as [`prune`]) and must merge exactly like the
//! full edit; main's changes reach the windows as patches through the real controller and broadcaster, and a window that
//! only applies those patches (asking for a snapshot when one does not follow, as `applyStateChange` does) ends with main's
//! state, also with lost and duplicated patches and replayed edits.

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use unimux_core::js_json::{js_equal, stringify};
use unimux_state::broadcast::StateBroadcaster;
use unimux_state::edits::merge_state_edit;
use unimux_state::patch::{apply_patch, diff_state, state_change};
use unimux_state::{PassThrough, StateController};

/// mulberry32, as in the TS tests.
struct Rng(u32);

impl Rng {
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b_79f5);
        let mut t = (self.0 ^ (self.0 >> 15)).wrapping_mul(1 | self.0);
        t = (t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t))) ^ t;
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    }
    fn below(&mut self, n: usize) -> usize {
        ((self.next() * n as f64) as usize).min(n.saturating_sub(1))
    }
    fn chance(&mut self, p: f64) -> bool {
        self.next() < p
    }
}

// ── the renderer's pruneEdit ────────────────────────────────────────────────

fn id_of(v: &Value) -> Option<&str> {
    v.as_object()?.get("id")?.as_str()
}

fn is_keyed(v: &Value) -> bool {
    let Some(items) = v.as_array() else { return false };
    let mut seen = std::collections::HashSet::new();
    items.iter().all(|x| id_of(x).is_some_and(|id| seen.insert(id)))
}

fn equal(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => js_equal(a, b),
        _ => false,
    }
}

/// `prune(base, next)` of src/shared/statePatch.ts.
fn prune(base: &Value, next: &Value) -> (Value, Value) {
    if is_keyed(base) && is_keyed(next) {
        let (b, n) = (base.as_array().unwrap(), next.as_array().unwrap());
        let find = |list: &[Value], id: &str| list.iter().find(|v| id_of(v) == Some(id)).cloned();
        let pruned_base = b
            .iter()
            .map(|x| {
                let id = id_of(x).unwrap();
                match find(n, id) {
                    Some(other) if !js_equal(x, &other) => prune(x, &other).0,
                    _ => json!({ "id": id }),
                }
            })
            .collect();
        let pruned_next = n
            .iter()
            .map(|x| {
                let id = id_of(x).unwrap();
                match find(b, id) {
                    None => x.clone(),
                    Some(other) if js_equal(&other, x) => json!({ "id": id }),
                    Some(other) => prune(&other, x).1,
                }
            })
            .collect();
        return (Value::Array(pruned_base), Value::Array(pruned_next));
    }
    if let (Value::Object(b), Value::Object(n)) = (base, next) {
        let (mut pb, mut pn) = (Map::new(), Map::new());
        let mut keys: Vec<&String> = b.keys().collect();
        keys.extend(n.keys().filter(|k| !b.contains_key(*k)));
        for key in keys {
            if equal(b.get(key), n.get(key)) {
                continue;
            }
            match (b.get(key), n.get(key)) {
                (Some(x), Some(y)) => {
                    let (px, py) = prune(x, y);
                    pb.insert(key.clone(), px);
                    pn.insert(key.clone(), py);
                }
                (x, y) => {
                    if let Some(x) = x {
                        pb.insert(key.clone(), x.clone());
                    }
                    if let Some(y) = y {
                        pn.insert(key.clone(), y.clone());
                    }
                }
            }
        }
        if let (Some(Value::String(x)), Some(Value::String(y))) = (b.get("id"), n.get("id"))
            && x == y
        {
            pb.insert("id".into(), Value::String(x.clone()));
            pn.insert("id".into(), Value::String(y.clone()));
        }
        return (Value::Object(pb), Value::Object(pn));
    }
    (base.clone(), next.clone())
}

// ── realistic states and user actions ───────────────────────────────────────

/// 4 projects x 3 grids x 3 cells (`bigState`).
fn big_state() -> Value {
    let projects: Vec<Value> = (0..4)
        .map(|p| {
            let tabs: Vec<Value> = (0..3)
                .map(|t| {
                    let cells: Vec<Value> = (0..3)
                        .map(|c| json!({ "id": format!("c{p}{t}{c}"), "profileId": if c == 2 { "codex" } else { "claude" } }))
                        .collect();
                    json!({ "id": format!("t{p}{t}"), "name": format!("Grid {t}"), "cells": cells })
                })
                .collect();
            json!({ "id": format!("p{p}"), "name": format!("P{p}"), "path": format!("/tmp/p{p}"), "tabs": tabs, "archive": [] })
        })
        .collect();
    json!({ "version": 1, "activeProjectId": "p3", "projects": projects, "snippets": [], "settings": { "fontSize": 13 } })
}

fn arr<'a>(v: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    if !v[key].is_array() {
        v[key] = json!([]);
    }
    v[key].as_array_mut().unwrap()
}

/// One random user or agent action (`randomAction`); returns the state unchanged when it does not apply.
fn random_action(state: &Value, r: &mut Rng, counter: &mut u32) -> Value {
    let mut s = state.clone();
    *counter += 1;
    let fresh = format!("n{counter}");
    let projects = s["projects"].as_array().map_or(0, Vec::len);
    let p = if projects > 0 { r.below(projects) } else { 0 };
    let tabs = s["projects"][p]["tabs"].as_array().map_or(0, Vec::len);
    let t = if tabs > 0 { r.below(tabs) } else { 0 };
    let cells = s["projects"][p]["tabs"][t]["cells"].as_array().map_or(0, Vec::len);
    match r.below(12) {
        0 => arr(&mut s, "projects").push(json!({ "id": fresh, "name": "N", "path": "/tmp/x", "tabs": [], "archive": [] })),
        1 if projects > 1 => {
            arr(&mut s, "projects").remove(p);
        }
        2 if projects > 0 => arr(&mut s["projects"][p], "tabs")
            .push(json!({ "id": fresh.clone(), "name": "G", "cells": [{ "id": format!("{fresh}c"), "profileId": "shell" }] })),
        3 if tabs > 0 => {
            let tab = arr(&mut s["projects"][p], "tabs").remove(t);
            arr(&mut s["projects"][p], "archive").push(tab);
        }
        4 if cells > 0 && cells < 8 => {
            arr(&mut s["projects"][p]["tabs"][t], "cells").push(json!({ "id": fresh, "profileId": "claude" }));
        }
        5 if cells > 1 => {
            let i = r.below(cells);
            arr(&mut s["projects"][p]["tabs"][t], "cells").remove(i);
        }
        6 if cells > 1 => arr(&mut s["projects"][p]["tabs"][t], "cells").swap(0, cells - 1),
        7 if cells > 0 => {
            let i = r.below(cells);
            s["projects"][p]["tabs"][t]["cells"][i]["color"] = json!(format!("#{:06x}", r.below(0xff_ffff)));
        }
        8 if cells > 0 => {
            let i = r.below(cells);
            if let Some(cell) = s["projects"][p]["tabs"][t]["cells"][i].as_object_mut() {
                cell.shift_remove("color");
                cell.insert("session".into(), json!({ "cli": "claude", "id": format!("s{}", r.below(9)) }));
            }
        }
        9 if projects > 1 => {
            let first = arr(&mut s, "projects").remove(0);
            arr(&mut s, "projects").push(first);
        }
        10 => s["settings"]["fontSize"] = json!(8 + r.below(20)),
        11 => {
            let id = format!("sn{}", r.below(4));
            let snippet = json!({ "id": id, "name": "x", "text": format!("y{counter}"), "autoSend": false });
            let list = arr(&mut s, "snippets");
            match list.iter().position(|x| x["id"] == id) {
                Some(i) => list[i] = snippet,
                None => list.push(snippet),
            }
        }
        _ if projects > 0 => s["activeProjectId"] = s["projects"][p]["id"].clone(),
        _ => {}
    }
    s
}

// ── pruned edits ────────────────────────────────────────────────────────────

/// test/state-patch.test.ts "merge exactly like the full edit, also against a state that moved on meanwhile".
#[test]
fn pruned_edits_merge_exactly_like_the_full_edit_also_against_a_state_that_moved_on() {
    // Realistic edits against a state main changed meanwhile (MCP, another edit). (Not the synthetic rows of
    // test/golden/state-merge.jsonl: a few of them, a keyed list under a parent the current state lacks or a current list
    // with a repeated id, merge differently once pruned, in 1.1.4's TS exactly as here; no real state has that shape.)
    let mut r = Rng(11);
    let mut counter = 0;
    for run in 0..200 {
        let mut start = big_state();
        for _ in 0..5 {
            start = random_action(&start, &mut r, &mut counter);
        }
        let mut next = start.clone();
        for _ in 0..1 + r.below(3) {
            next = random_action(&next, &mut r, &mut counter);
        }
        let mut current = start.clone();
        for _ in 0..r.below(4) {
            current = random_action(&current, &mut r, &mut counter);
        }
        let full = merge_state_edit(&current, &start, &next);
        let (base, pruned) = prune(&start, &next);
        assert_eq!(stringify(&merge_state_edit(&current, &base, &pruned)), stringify(&full), "run {run}");
    }
}

/// test/state-patch.test.ts "keeps entries that were added or removed".
#[test]
fn a_pruned_edit_keeps_entries_that_were_added_or_removed() {
    let base = big_state();
    let mut with_tab = base.clone();
    arr(&mut with_tab["projects"][0], "tabs")
        .push(json!({ "id": "new", "name": "new", "cells": [{ "id": "newc", "profileId": "shell" }] }));
    let mut removed = with_tab.clone();
    arr(&mut removed, "projects").remove(1);
    let (b, n) = prune(&base, &removed);
    let merged = merge_state_edit(&with_tab, &b, &n);
    assert_eq!(stringify(&merged), stringify(&merge_state_edit(&with_tab, &base, &removed)));
    assert_eq!(merged["projects"].as_array().unwrap().len(), 3);
    assert_eq!(merged["projects"][0]["tabs"].as_array().unwrap().len(), 4);
}

// ── the whole loop ──────────────────────────────────────────────────────────

/// A window that knows only what it was sent: `applyStateChange` (a change at or below its revision changes nothing, one
/// whose base is not its revision or whose patch does not fit makes it load a snapshot).
struct Window {
    state: Value,
    revision: u64,
    resyncs: usize,
}

impl Window {
    fn receive(&mut self, change: &Value, controller: &StateController) {
        if let Some(full) = change.get("full") {
            let revision = full["revision"].as_u64().unwrap();
            if revision >= self.revision {
                self.state = full["state"].clone();
                self.revision = revision;
            }
            return;
        }
        let revision = change["revision"].as_u64().unwrap();
        if revision <= self.revision {
            return;
        }
        let applied = if change["base"].as_u64() == Some(self.revision) {
            match &change["patch"] {
                Value::Null => Some(self.state.clone()),
                patch => apply_patch(&self.state, patch).ok(),
            }
        } else {
            None
        };
        match applied {
            Some(state) => {
                self.state = state;
                self.revision = revision;
            }
            None => {
                let snapshot = controller.snapshot();
                self.state = (*snapshot.state).clone();
                self.revision = snapshot.revision;
                self.resyncs += 1;
            }
        }
    }
}

struct Faults {
    drop_patch: f64,
    dup_patch: f64,
    replay_edit: f64,
}

fn run_loop(seed: u32, steps: usize, faults: &Faults) -> (Value, Value, u64, u64, usize) {
    let mut r = Rng(seed);
    let mut counter = 0;
    let controller = Arc::new(StateController::new(big_state(), Arc::new(PassThrough)));
    let wire: Arc<Mutex<VecDeque<Value>>> = Arc::default();
    let w = wire.clone();
    // Batched changes wait for an explicit flush (no timer runs in this test).
    let broadcaster =
        StateBroadcaster::with_delay(controller.snapshot(), Arc::new(move |c| w.lock().push_back(c)), Duration::from_secs(3600));
    let b = broadcaster.clone();
    controller.on_change(move |ch| b.changed(ch.snapshot, ch.batch));
    let mut window = Window { state: (*controller.get()).clone(), revision: controller.revision(), resyncs: 0 };
    let mut sent_edits: Vec<(String, Value, Value)> = Vec::new();
    for step in 0..steps {
        let roll = r.next();
        if roll < 0.3 {
            // An agent (MCP) changes the state, batched or not.
            let batch = r.chance(0.5);
            controller.change(|s| Ok(random_action(s, &mut Rng(seed ^ step as u32), &mut counter)), None, batch).unwrap();
        } else if roll < 0.6 {
            // The user edits what the window shows; the edit travels pruned.
            let next = random_action(&window.state, &mut r, &mut counter);
            if next != window.state {
                let (base, pruned) = prune(&window.state, &next);
                let id = format!("e{step}");
                controller.apply_edit(&id, &base, &pruned).unwrap();
                sent_edits.push((id, base, pruned));
            }
        } else if roll < 0.7 {
            // A lost answer: the window sends an edit again; main acknowledges it without applying it twice.
            if r.chance(faults.replay_edit)
                && let Some((id, base, next)) = sent_edits.last().cloned()
            {
                let revision = controller.revision();
                controller.apply_edit(&id, &base, &next).unwrap();
                assert_eq!(controller.revision(), revision, "a replayed edit is not applied again");
            }
        } else if roll < 0.8 {
            broadcaster.flush();
        } else {
            // Patches reach the window, some lost, some twice.
            let changes: Vec<Value> = wire.lock().drain(..).collect();
            for change in changes {
                if r.chance(faults.drop_patch) {
                    continue;
                }
                window.receive(&change, &controller);
                if r.chance(faults.dup_patch) {
                    window.receive(&change, &controller);
                }
            }
        }
    }
    // Faults off: what waits is delivered, then one more reliable change by main makes a window that missed a patch notice.
    broadcaster.flush();
    let deliver = |window: &mut Window| {
        let changes: Vec<Value> = wire.lock().drain(..).collect();
        for change in changes {
            window.receive(&change, &controller);
        }
    };
    deliver(&mut window);
    controller.change(|s| Ok(random_action(s, &mut Rng(seed), &mut counter)), None, false).unwrap();
    controller
        .change(
            |s| {
                Ok({
                    let mut s = s.clone();
                    s["settings"]["poke"] = json!(seed);
                    s
                })
            },
            None,
            false,
        )
        .unwrap();
    deliver(&mut window);
    let main = (*controller.get()).clone();
    (window.state, main, window.revision, controller.revision(), window.resyncs)
}

/// test/state-patch.test.ts "a renderer that only sees patches ends up with main's state, with concurrent MCP changes and lost
/// edits" and test/state-sync-faults.test.ts (lost and duplicated patches, replayed edits; also without any fault).
#[test]
fn a_window_that_only_sees_patches_ends_with_mains_state_also_with_lost_and_duplicated_patches() {
    let clean = Faults { drop_patch: 0.0, dup_patch: 0.0, replay_edit: 0.0 };
    for seed in 1..=60 {
        let (view, main, revision, main_revision, resyncs) = run_loop(seed, 120, &clean);
        assert_eq!(stringify(&view), stringify(&main), "seed {seed} without faults");
        assert_eq!(revision, main_revision);
        assert_eq!(resyncs, 0, "seed {seed}: without faults every patch follows the last one");
    }
    let faulty = Faults { drop_patch: 0.2, dup_patch: 0.1, replay_edit: 0.5 };
    let mut resyncs = 0;
    for seed in 1..=200 {
        let (view, main, revision, main_revision, n) = run_loop(seed, 120, &faulty);
        assert_eq!(stringify(&view), stringify(&main), "seed {seed} with faults");
        assert_eq!(revision, main_revision, "seed {seed}");
        resyncs += n;
    }
    assert!(resyncs > 50, "the faults made windows load snapshots ({resyncs})");
}

/// test/state-patch.test.ts "a state with a large icon: the edit and the patch stay small" (main's half: the patch).
#[test]
fn a_state_with_a_large_icon_keeps_the_patch_small() {
    let mut base = big_state();
    base["projects"][0]["icon"] = json!({ "kind": "image", "dataUrl": format!("data:image/png;base64,{}", "A".repeat(80_000)) });
    let mut next = base.clone();
    next["projects"][2]["tabs"][0]["cells"][0]["color"] = json!("#ffffff");
    assert!(stringify(&base).len() > 80_000);
    let change = state_change(&base, &next, 2, 1, None);
    assert!(stringify(&change).len() < 1500, "{}", stringify(&change));
    assert_eq!(apply_patch(&base, &change["patch"]).unwrap(), next);
    assert!(diff_state(&base, &base).is_none());
}
