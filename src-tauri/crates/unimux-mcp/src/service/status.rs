//! automation.ts `StatusMap`: the runtime statuses of the cells (starting, working, ready, needs_attention, unknown, exited)
//! with the moment each cell entered its status. Every real change bumps a revision (wait_for wakes on it) and calls the
//! change hook (the app pushes `automation:statuses` to the windows, at most every 250 ms).

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::{Mutex, RwLock};
use serde_json::{Map, Value};
use tokio::sync::watch;

use super::Clock;

#[derive(Default)]
struct Inner {
    /// In insertion order, like a JavaScript Map (`Object.fromEntries` keeps it).
    map: Map<String, Value>,
    since: HashMap<String, i64>,
}

pub struct StatusMap {
    inner: Mutex<Inner>,
    tx: watch::Sender<u64>,
    on_change: RwLock<Option<Arc<dyn Fn() + Send + Sync>>>,
    clock: Clock,
}

impl StatusMap {
    pub fn new(clock: Clock) -> Self {
        Self { inner: Mutex::default(), tx: watch::channel(0).0, on_change: RwLock::new(None), clock }
    }

    pub fn get(&self, cell: &str) -> Option<String> {
        self.inner.lock().map.get(cell).and_then(Value::as_str).map(str::to_string)
    }

    /// When the cell entered its current status (ms since the epoch).
    pub fn since(&self, cell: &str) -> Option<i64> {
        self.inner.lock().since.get(cell).copied()
    }

    /// `statuses.set(cell, status)`: a new status restarts `since`; setting the same one changes nothing.
    pub fn set(&self, cell: &str, status: &str) {
        let changed = {
            let mut inner = self.inner.lock();
            let changed = inner.map.get(cell).and_then(Value::as_str) != Some(status);
            if changed || !inner.since.contains_key(cell) {
                let now = (self.clock)();
                inner.since.insert(cell.to_string(), now);
            }
            inner.map.insert(cell.to_string(), Value::String(status.to_string()));
            changed
        };
        if changed {
            self.changed();
        }
    }

    pub fn delete(&self, cell: &str) -> bool {
        let deleted = {
            let mut inner = self.inner.lock();
            inner.since.remove(cell);
            inner.map.shift_remove(cell).is_some()
        };
        if deleted {
            self.changed();
        }
        deleted
    }

    /// `Object.fromEntries(statuses)`.
    pub fn to_json(&self) -> Value {
        Value::Object(self.inner.lock().map.clone())
    }

    /// A receiver that wakes on every real change.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.tx.subscribe()
    }

    /// `statuses.onChange`.
    pub fn set_on_change(&self, hook: impl Fn() + Send + Sync + 'static) {
        *self.on_change.write() = Some(Arc::new(hook));
    }

    fn changed(&self) {
        let hook = self.on_change.read().clone();
        if let Some(hook) = hook {
            hook();
        }
        self.tx.send_modify(|n| *n += 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicI64, AtomicUsize, Ordering};

    #[test]
    fn only_real_changes_notify_and_restart_since() {
        let now = Arc::new(AtomicI64::new(1000));
        let n = now.clone();
        let map = StatusMap::new(Arc::new(move || n.load(Ordering::SeqCst)));
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        map.set_on_change(move || {
            c.fetch_add(1, Ordering::SeqCst);
        });
        map.set("a", "working");
        now.store(2000, Ordering::SeqCst);
        map.set("a", "working");
        assert_eq!((calls.load(Ordering::SeqCst), map.since("a")), (1, Some(1000)));
        map.set("b", "ready");
        map.set("a", "exited");
        assert_eq!(map.since("a"), Some(2000));
        assert_eq!(serde_json::to_string(&map.to_json()).unwrap(), r#"{"a":"exited","b":"ready"}"#);
        assert!(map.delete("a") && !map.delete("a"));
        assert_eq!(calls.load(Ordering::SeqCst), 4);
        assert_eq!(map.since("a"), None);
    }
}
