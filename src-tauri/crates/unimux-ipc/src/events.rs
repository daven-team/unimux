//! Push events (`window.mc.on(channel, cb)`), with the routing rules of 1.1.4 (shared/detached.ts routeMessage):
//! broadcast channels go to every window, cell channels to the window that shows the cell, the rest to the main window.
//! The payload is the positional argument list (`webContents.send(channel, ...args)`), spread into the callback by the bridge.
//!
//! Before any event leaves, the registered `before_emit` hooks run: the state broadcaster flushes a waiting batched
//! `state:changed` there, so a message that names new cells never overtakes the state that has them (stateBroadcast.ts).

use std::sync::Arc;

use parking_lot::RwLock;
use serde_json::Value;

/// Where an event goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    /// Every app window (main and detached).
    Broadcast,
    /// The main window only.
    Main,
    /// One window by label.
    Window(String),
    /// The window showing this cell (W5 fills the owner lookup; until then: main).
    Cell(String),
}

/// The host side of emitting (implemented by unimux-app over Tauri's `emit_to`).
pub trait EventSink: Send + Sync {
    /// Labels of the open app windows (`main`, `detached-*`), main first.
    fn app_windows(&self) -> Vec<String>;
    fn emit_to(&self, label: &str, event: &str, payload: &Value);
}

type Hook = Arc<dyn Fn() + Send + Sync>;
type CellOwner = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// The event bus every domain emits through.
pub struct Events {
    sink: Arc<dyn EventSink>,
    before: RwLock<Vec<Hook>>,
    cell_owner: RwLock<Option<CellOwner>>,
}

impl Events {
    pub fn new(sink: Arc<dyn EventSink>) -> Self {
        Self { sink, before: RwLock::new(Vec::new()), cell_owner: RwLock::new(None) }
    }

    /// Runs before every emit (the state flush).
    pub fn before_emit(&self, hook: impl Fn() + Send + Sync + 'static) {
        self.before.write().push(Arc::new(hook));
    }

    /// The owner window of a cell (W5: the routing table kept by the StateController). None = main.
    pub fn set_cell_owner(&self, owner: impl Fn(&str) -> Option<String> + Send + Sync + 'static) {
        *self.cell_owner.write() = Some(Arc::new(owner));
    }

    /// The labels an event of `scope` reaches now.
    pub fn targets(&self, scope: &Scope) -> Vec<String> {
        match scope {
            Scope::Broadcast => self.sink.app_windows(),
            Scope::Main => vec!["main".to_string()],
            Scope::Window(label) => vec![label.clone()],
            Scope::Cell(cell) => {
                let owner = self.cell_owner.read().as_ref().and_then(|f| f(cell));
                vec![owner.unwrap_or_else(|| "main".to_string())]
            }
        }
    }

    /// Emits `event` with positional `args` after the before-emit hooks.
    pub fn emit(&self, scope: Scope, event: &str, args: Vec<Value>) {
        let hooks: Vec<Hook> = self.before.read().clone();
        for hook in hooks {
            hook();
        }
        self.emit_raw(&scope, event, &Value::Array(args));
    }

    /// Emits without running the hooks (the state broadcaster itself).
    pub fn emit_raw(&self, scope: &Scope, event: &str, payload: &Value) {
        for label in self.targets(scope) {
            self.sink.emit_to(&label, event, payload);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;
    use serde_json::json;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<(String, String, Value)>>);
    impl EventSink for Recorder {
        fn app_windows(&self) -> Vec<String> {
            vec!["main".into(), "detached-a".into()]
        }
        fn emit_to(&self, label: &str, event: &str, payload: &Value) {
            self.0.lock().push((label.into(), event.into(), payload.clone()));
        }
    }

    #[test]
    fn scopes_and_before_hooks() {
        let rec = Arc::new(Recorder::default());
        let events = Events::new(rec.clone());
        let flushed = Arc::new(Mutex::new(0));
        let f = flushed.clone();
        events.before_emit(move || *f.lock() += 1);
        events.emit(Scope::Broadcast, "cli:changed", vec![json!({})]);
        events.emit(Scope::Cell("c1".into()), "cell:hook", vec![json!("c1"), json!("stop")]);
        events.set_cell_owner(|cell| (cell == "c2").then(|| "detached-a".to_string()));
        events.emit(Scope::Cell("c2".into()), "cell:hook", vec![json!("c2")]);
        let log = rec.0.lock();
        let labels: Vec<_> = log.iter().map(|(l, e, _)| format!("{l}:{e}")).collect();
        assert_eq!(labels, vec!["main:cli:changed", "detached-a:cli:changed", "main:cell:hook", "detached-a:cell:hook"]);
        assert_eq!(log[2].2, json!(["c1", "stop"]));
        assert_eq!(*flushed.lock(), 3);
    }
}
