//! Port of src/main/stateController.ts: the single writer of AppState. Renderer edits rebase on the latest state (merge),
//! main-side changes mutate it; every change gets the next revision and runs the change hooks in revision order (the saver,
//! the broadcaster, later the domains' hooks: revokeCell, forgetCell, cancelOrphans, ...). Subscribers that wait for a
//! change (MCP wait_for) use the revision watch and never hold the lock across an await.
//!
//! A mutex serializes the writers (an actor without the channel): every change is short CPU work, and the hooks run inside
//! it so `state:changed` messages leave in revision order. Hooks must not call back into the controller.

use std::collections::VecDeque;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
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
    hooks: RwLock<Vec<Hook>>,
    revision_tx: watch::Sender<u64>,
    normalizer: Arc<dyn Normalizer>,
}

impl StateController {
    pub fn new(state: Value, normalizer: Arc<dyn Normalizer>) -> Self {
        let (revision_tx, _) = watch::channel(0);
        Self {
            inner: Mutex::new(Inner { state: Arc::new(state), revision: 0, recent_edits: VecDeque::new() }),
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
        let hooks: Vec<Hook> = self.hooks.read().clone();
        let change = Change { previous: &previous, snapshot: &snapshot, batch };
        for hook in &hooks {
            hook(&change);
        }
        drop(inner);
        self.revision_tx.send_replace(snapshot.revision);
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
