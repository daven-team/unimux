//! Port of src/main/stateController.ts: the single writer of AppState. Renderer edits rebase on the latest state (merge),
//! main-side changes mutate it; every change gets the next revision and runs the change hooks in revision order (the saver,
//! the broadcaster, later the domains' hooks: revokeCell, forgetCell, cancelOrphans, ...). Subscribers that wait for a
//! change (MCP wait_for) use the revision watch and never hold the lock across an await.
//!
//! A mutex serializes the writers (an actor without the channel): every change is short CPU work. The hooks run after the
//! state lock is released, under a second (re-entrant) lock taken before the state lock is let go, so `state:changed`
//! messages still leave in revision order while a hook (or a thread a hook waits for) may read the state: the hooks reach
//! far (cells, SSH, DB, detached windows) and a read of the state from any of them used to deadlock the whole app. A hook
//! that changes the state again runs that change's hooks at once (nested, like 1.1.4's synchronous emit).

use std::collections::VecDeque;
use std::sync::Arc;

use parking_lot::{Mutex, ReentrantMutex, RwLock};
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::edits::merge_state_edit;
use crate::normalize::Normalizer;

/// `{state, revision, editId?}`.
#[derive(Debug, Clone)]
pub struct Snapshot {
    pub state: Arc<Value>,
    pub revision: u64,
    pub edit_id: Option<String>,
}

impl Snapshot {
    /// The `StateSnapshot` JSON the renderer reads (`state:snapshot`).
    pub fn to_json(&self) -> Value {
        let mut v = json!({ "state": &*self.state, "revision": self.revision });
        if let Some(id) = &self.edit_id {
            v["editId"] = json!(id);
        }
        v
    }
}

/// What a change hook hears: the state before, the new snapshot and whether the windows may hear it batched.
pub struct Change<'a> {
    pub previous: &'a Arc<Value>,
    pub snapshot: &'a Snapshot,
    pub batch: bool,
}

type Hook = Arc<dyn Fn(&Change<'_>) + Send + Sync>;

struct Inner {
    state: Arc<Value>,
    revision: u64,
    /// Edit ids applied recently: a replayed edit (the bridge re-sends an unacknowledged `state:edit` after a reload) is
    /// acknowledged without applying it twice.
    recent_edits: VecDeque<(String, u64)>,
}

const RECENT_EDITS: usize = 256;

pub struct StateController {
    inner: Mutex<Inner>,
    /// Held while a change's hooks run (taken before `inner` is released): hooks see the changes in revision order.
    emit: ReentrantMutex<()>,
    hooks: RwLock<Vec<Hook>>,
    revision_tx: watch::Sender<u64>,
    normalizer: Arc<dyn Normalizer>,
}

impl StateController {
    pub fn new(state: Value, normalizer: Arc<dyn Normalizer>) -> Self {
        let (revision_tx, _) = watch::channel(0);
        Self {
            inner: Mutex::new(Inner { state: Arc::new(state), revision: 0, recent_edits: VecDeque::new() }),
            emit: ReentrantMutex::new(()),
            hooks: RwLock::new(Vec::new()),
            revision_tx,
            normalizer,
        }
    }

    pub fn get(&self) -> Arc<Value> {
        self.inner.lock().state.clone()
    }

    pub fn snapshot(&self) -> Snapshot {
        let inner = self.inner.lock();
        Snapshot { state: inner.state.clone(), revision: inner.revision, edit_id: None }
    }

    pub fn revision(&self) -> u64 {
        self.inner.lock().revision
    }

    /// Hears every change after it was applied, in revision order.
    pub fn on_change(&self, hook: impl Fn(&Change<'_>) + Send + Sync + 'static) {
        self.hooks.write().push(Arc::new(hook));
    }

    /// A receiver of the revision (wakes on every change).
    pub fn watch(&self) -> watch::Receiver<u64> {
        self.revision_tx.subscribe()
    }

    /// `change(fn, editId, batch)`: `f` returns the next state or an error (nothing changes then).
    pub fn change(
        &self,
        f: impl FnOnce(&Value) -> Result<Value, String>,
        edit_id: Option<&str>,
        batch: bool,
    ) -> Result<Snapshot, String> {
        let mut inner = self.inner.lock();
        let next = f(&inner.state)?;
        let previous = std::mem::replace(&mut inner.state, Arc::new(next));
        inner.revision += 1;
        let snapshot = Snapshot { state: inner.state.clone(), revision: inner.revision, edit_id: edit_id.map(str::to_string) };
        if let Some(id) = edit_id {
            let revision = inner.revision;
            inner.recent_edits.push_back((id.to_string(), revision));
            while inner.recent_edits.len() > RECENT_EDITS {
                inner.recent_edits.pop_front();
            }
        }
        // The next change cannot run its hooks before these: the emit lock is ours before the state lock goes.
        let emit = self.emit.lock();
        drop(inner);
        let hooks: Vec<Hook> = self.hooks.read().clone();
        let change = Change { previous: &previous, snapshot: &snapshot, batch };
        for hook in &hooks {
            hook(&change);
        }
        // A nested change (from a hook) already announced a later revision: the watch never goes back.
        let revision = snapshot.revision;
        self.revision_tx.send_if_modified(|r| {
            let newer = *r < revision;
            if newer {
                *r = revision;
            }
            newer
        });
        drop(emit);
        Ok(snapshot)
    }

    /// `apply(edit)`: a renderer edit `{id, base, next}` merged into the latest state and normalized. Answers the
    /// acknowledgement `{revision, editId}` (the new state reaches the windows as `state:changed`).
    pub fn apply_edit(&self, id: &str, base: &Value, next: &Value) -> Result<Value, String> {
        {
            let inner = self.inner.lock();
            if let Some((_, revision)) = inner.recent_edits.iter().find(|(e, _)| e == id) {
                return Ok(json!({ "revision": revision, "editId": id }));
            }
        }
        let normalizer = self.normalizer.clone();
        let snapshot = self.change(
            |state| {
                let merged = merge_state_edit(state, base, next);
                normalizer.after_edit(merged, state)
            },
            Some(id),
            false,
        )?;
        Ok(json!({ "revision": snapshot.revision, "editId": id }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::normalize::PassThrough;

    #[test]
    fn revisions_increase_and_hooks_run_in_order() {
        let c = Arc::new(StateController::new(json!({"n": 0}), Arc::new(PassThrough)));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let s = seen.clone();
        c.on_change(move |ch| s.lock().push(ch.snapshot.revision));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let c = c.clone();
                std::thread::spawn(move || {
                    for _ in 0..125 {
                        c.change(|s| Ok(json!({"n": s["n"].as_u64().unwrap() + 1})), None, false).unwrap();
                    }
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(c.revision(), 1000);
        assert_eq!(c.get()["n"], 1000);
        assert_eq!(*seen.lock(), (1..=1000).collect::<Vec<u64>>());
    }

    #[test]
    fn hooks_may_read_and_change_the_state() {
        let c = Arc::new(StateController::new(json!({"n": 0}), Arc::new(PassThrough)));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let (weak, s) = (Arc::downgrade(&c), seen.clone());
        c.on_change(move |ch| {
            let c = weak.upgrade().unwrap();
            // A read from a hook (it used to deadlock) sees at least this change.
            s.lock().push((ch.snapshot.revision, c.get()["n"].as_u64().unwrap()));
            // A follow-up change from a hook runs its own hooks at once.
            if ch.snapshot.revision == 1 {
                c.change(|s| Ok(json!({"n": s["n"].as_u64().unwrap() + 10})), None, false).unwrap();
            }
        });
        let mut rx = c.watch();
        c.change(|s| Ok(json!({"n": s["n"].as_u64().unwrap() + 1})), None, false).unwrap();
        assert_eq!(*seen.lock(), vec![(1, 1), (2, 11)]);
        assert_eq!(c.revision(), 2);
        assert_eq!(*rx.borrow_and_update(), 2);
    }

    #[test]
    fn a_hook_waiting_for_a_reader_on_another_thread_does_not_deadlock() {
        let c = Arc::new(StateController::new(json!({"n": 0}), Arc::new(PassThrough)));
        let weak = Arc::downgrade(&c);
        c.on_change(move |_| {
            let c = weak.upgrade().unwrap();
            // Another thread reads the state while this hook waits for it.
            std::thread::spawn(move || c.get()["n"].as_u64()).join().unwrap();
        });
        c.change(|_| Ok(json!({"n": 1})), None, false).unwrap();
        assert_eq!(c.get()["n"], 1);
    }

    #[test]
    fn edits_are_acknowledged_once() {
        let c = StateController::new(json!({"version": 1, "projects": [], "a": 1}), Arc::new(PassThrough));
        let ack = c.apply_edit("e1", &json!({"a": 1}), &json!({"a": 2})).unwrap();
        assert_eq!(ack, json!({"revision": 1, "editId": "e1"}));
        // The same edit replayed after a reload: acknowledged, not applied again.
        let again = c.apply_edit("e1", &json!({"a": 1}), &json!({"a": 2})).unwrap();
        assert_eq!(again, json!({"revision": 1, "editId": "e1"}));
        assert_eq!(c.revision(), 1);
        assert_eq!(c.get()["a"], 2);
    }

    #[test]
    fn a_failing_change_changes_nothing() {
        let c = StateController::new(json!({"a": 1}), Arc::new(PassThrough));
        assert!(c.change(|_| Err("no".into()), None, false).is_err());
        assert_eq!(c.revision(), 0);
    }

    /// A grid of `n` cells in a default state (test/state-edits.test.ts `grid(n)`).
    fn grid(n: usize) -> Value {
        let mut s = crate::normalize::state::default_state(crate::Platform::Win32);
        let cells: Vec<Value> = (0..n).map(|i| json!({"id": format!("c{i}"), "profileId": "claude"})).collect();
        s["projects"] = json!([{"id": "p", "name": "P", "path": "/p", "tabs": [{"id": "t", "name": "T", "layout": crate::normalize::grid::layout_for_count(n as f64), "cells": cells}], "archive": [], "activeTabId": "t"}]);
        s["activeProjectId"] = json!("p");
        s
    }

    fn add_cell(s: &Value, id: &str) -> Value {
        let mut next = s.clone();
        let cells = next["projects"][0]["tabs"][0]["cells"].as_array_mut().unwrap();
        cells.push(json!({"id": id, "profileId": "codex"}));
        let n = cells.len();
        next["projects"][0]["tabs"][0]["layout"] = crate::normalize::grid::layout_for_count(n as f64);
        next
    }

    #[test]
    fn repairs_the_layout_when_two_independent_additions_are_merged() {
        let base = grid(1);
        let c = StateController::new(base.clone(), Arc::new(crate::StateNormalizer));
        c.change(|s| Ok(add_cell(s, "main")), None, false).unwrap();
        c.apply_edit("ui", &base, &add_cell(&base, "ui")).unwrap();
        let tab = &c.get()["projects"][0]["tabs"][0];
        assert_eq!(tab["cells"].as_array().unwrap().len(), 3);
        assert_eq!(tab["layout"]["areas"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn rejects_concurrent_additions_beyond_20_without_altering_the_canonical_state() {
        let base = grid(19);
        let c = StateController::new(base.clone(), Arc::new(crate::StateNormalizer));
        c.change(|s| Ok(add_cell(s, "main")), None, false).unwrap();
        let before = c.get();
        let err = c.apply_edit("ui", &base, &add_cell(&base, "ui")).unwrap_err();
        assert!(err.contains("cell limit"), "{err}");
        assert_eq!(c.get(), before);
        assert_eq!(c.revision(), 1);
    }

    #[test]
    fn normalizes_the_sftp_places_and_the_scrollback_setting_of_a_renderer_edit() {
        let base = grid(1);
        let c = StateController::new(base.clone(), Arc::new(crate::StateNormalizer));
        let mut next = base.clone();
        next["sftp"] = unimux_core::js_json::parse(
            r#"{"localPath":"relative/path","remotePaths":{"__proto__":"/x","h1":"/srv//www/","bad id":"/y","h2":"relative"}}"#,
        )
        .unwrap();
        next["settings"]["scrollbackLines"] = json!(123);
        c.apply_edit("ui", &base, &next).unwrap();
        let state = c.get();
        assert_eq!(state["sftp"], json!({"remotePaths": {"h1": "/srv/www"}}));
        assert_eq!(state["settings"]["scrollbackLines"], 5000);
        let mut kept = base.clone();
        kept["sftp"] = json!({"remotePaths": {"h1": "/srv"}});
        kept["settings"]["scrollbackLines"] = json!(10_000);
        c.apply_edit("ui2", &state, &kept).unwrap();
        assert_eq!(c.get()["sftp"], json!({"remotePaths": {"h1": "/srv"}}));
        assert_eq!(c.get()["settings"]["scrollbackLines"], 10_000);
    }

    #[test]
    fn the_edit_path_repairs_the_strip_order_like_at_load_and_keeps_a_clean_order_as_it_is() {
        let base = grid(1);
        let c = StateController::new(base.clone(), Arc::new(crate::StateNormalizer));
        let mut dirty = base.clone();
        dirty["workspaceOrder"] =
            json!(["settings", "settings", "grid:missing", "bogus", 42, "x".repeat(5000), "file:{\"a\":1}", "grid:t"]);
        c.apply_edit("e1", &base, &dirty).unwrap();
        assert_eq!(c.get()["workspaceOrder"], json!(["settings", "file:{\"a\":1}", "grid:t"]));
        let before = (*c.get()).clone();
        let mut clean = before.clone();
        clean["workspaceOrder"] = json!(["file:b", "settings"]);
        c.apply_edit("e2", &before, &clean).unwrap();
        assert_eq!(c.get()["workspaceOrder"], json!(["file:b", "settings"]));
        let now = (*c.get()).clone();
        let mut many = now.clone();
        many["workspaceOrder"] = Value::Array((0..1500).map(|i| json!(format!("file:{i}"))).collect());
        c.apply_edit("e3", &now, &many).unwrap();
        assert_eq!(c.get()["workspaceOrder"].as_array().unwrap().len(), 1000);
    }

    #[tokio::test]
    async fn the_watch_wakes_on_changes() {
        let c = Arc::new(StateController::new(json!({}), Arc::new(PassThrough)));
        let mut rx = c.watch();
        let c2 = c.clone();
        tokio::spawn(async move { c2.change(|_| Ok(json!({"x": 1})), None, true).unwrap() });
        rx.changed().await.unwrap();
        assert_eq!(*rx.borrow(), 1);
    }
}
