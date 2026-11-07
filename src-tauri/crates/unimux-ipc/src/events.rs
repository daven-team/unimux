//! Push events (`window.mc.on(channel, cb)`), with the routing rules of 1.1.4 (shared/detached.ts routeMessage, see
//! [`crate::route`]): broadcast channels go to every window, cell channels to the window that shows the cell, the
//! `automation:start-cells` list is split by owner, the rest goes to the main window. Domains emit with [`Events::send`]
//! (1.1.4's `send(channel, ...args)` in index.ts); explicit scopes ([`Events::emit`]) are for per-window events
//! (`window:shown`, `detach:closing`) and the main-only `detach:*` relays.
//! The payload is the positional argument list (`webContents.send(channel, ...args)`), spread into the callback by the bridge.
//!
//! Before any event leaves, the registered `before_emit` hooks run: the state broadcaster flushes a waiting batched
//! `state:changed` there, so a message that names new cells never overtakes the state that has them (stateBroadcast.ts).

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::RwLock;
use serde_json::Value;

use crate::route::{RouteTarget, detached_label, route_message};

/// Where an event goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Scope {
    /// Every app window (main and detached).
    Broadcast,
    /// The main window only.
    Main,
    /// One window by label.
    Window(String),
    /// The window showing this cell (the owner table of [`Events::set_owners`]; main when not detached).
    Cell(String),
}

/// The host side of emitting (implemented by unimux-app over Tauri's `emit_to`).
pub trait EventSink: Send + Sync {
    /// Labels of the open app windows (`main`, `detached-*`), main first.
    fn app_windows(&self) -> Vec<String>;
    fn emit_to(&self, label: &str, event: &str, payload: &Value);
}

type Hook = Arc<dyn Fn() + Send + Sync>;
type FocusHook = Arc<dyn Fn(&str) + Send + Sync>;

/// The event bus every domain emits through.
pub struct Events {
    sink: Arc<dyn EventSink>,
    before: RwLock<Vec<Hook>>,
    /// Cell id -> id of the detached window that shows it (cellOwners of the latest state; W5 keeps it current).
    owners: RwLock<Arc<HashMap<String, String>>>,
    /// Runs before a `focus-cell` goes to a detached window (1.1.4 brings that window up).
    on_focus_cell: RwLock<Option<FocusHook>>,
}

impl Events {
    pub fn new(sink: Arc<dyn EventSink>) -> Self {
        Self {
            sink,
            before: RwLock::new(Vec::new()),
            owners: RwLock::new(Arc::new(HashMap::new())),
            on_focus_cell: RwLock::new(None),
        }
    }

    /// Runs before every emit (the state flush).
    pub fn before_emit(&self, hook: impl Fn() + Send + Sync + 'static) {
        self.before.write().push(Arc::new(hook));
    }

    /// The owner table (cell id -> detached window id), replaced on every state change that moves a cell.
    pub fn set_owners(&self, owners: HashMap<String, String>) {
        *self.owners.write() = Arc::new(owners);
    }

    /// The current owner table.
    pub fn owners(&self) -> Arc<HashMap<String, String>> {
        self.owners.read().clone()
    }

    /// Called with the label of a detached window right before a `focus-cell` is sent to it.
    pub fn on_focus_cell(&self, hook: impl Fn(&str) + Send + Sync + 'static) {
        *self.on_focus_cell.write() = Some(Arc::new(hook));
    }

    /// The labels of the open app windows (main first).
    pub fn app_windows(&self) -> Vec<String> {
        self.sink.app_windows()
    }

    /// The label of a detached window if it is open, else the main window (a message for a closed window goes to main).
    fn open_or_main(id: &str, open: &[String]) -> String {
        let label = detached_label(id);
        if open.contains(&label) { label } else { "main".to_string() }
    }

    /// The labels an event of `scope` reaches now.
    pub fn targets(&self, scope: &Scope) -> Vec<String> {
        match scope {
            Scope::Broadcast => self.sink.app_windows(),
            Scope::Main => vec!["main".to_string()],
            Scope::Window(label) => vec![label.clone()],
            Scope::Cell(cell) => {
                let owner = self.owners.read().get(cell).cloned();
                match owner {
                    Some(id) => vec![Self::open_or_main(&id, &self.sink.app_windows())],
                    None => vec!["main".to_string()],
                }
            }
        }
    }

    fn run_before(&self) {
        let hooks: Vec<Hook> = self.before.read().clone();
        for hook in hooks {
            hook();
        }
    }

    /// Emits `event` with positional `args` after the before-emit hooks.
    pub fn emit(&self, scope: Scope, event: &str, args: Vec<Value>) {
        self.run_before();
        self.emit_raw(&scope, event, &Value::Array(args));
    }

    /// Emits without running the hooks (the state broadcaster itself).
    pub fn emit_raw(&self, scope: &Scope, event: &str, payload: &Value) {
        for label in self.targets(scope) {
            self.sink.emit_to(&label, event, payload);
        }
    }

    /// 1.1.4's `send(channel, ...args)` (sendRouted in detachedWindows.ts): the waiting state change first, then every
    /// receiver of [`route_message`] with its arguments. With no detached window open everything goes to the main window; a
    /// message for a detached window that is not open goes to the main window.
    pub fn send(&self, channel: &str, args: Vec<Value>) {
        if channel != "state:changed" {
            self.run_before();
        }
        let open = self.sink.app_windows();
        if !open.iter().any(|l| l.starts_with("detached-")) {
            self.sink.emit_to("main", channel, &Value::Array(args));
            return;
        }
        let owners = self.owners();
        for (target, a) in route_message(channel, &args, &owners) {
            let payload = Value::Array(a);
            match target {
                RouteTarget::All => {
                    for label in &open {
                        self.sink.emit_to(label, channel, &payload);
                    }
                }
                RouteTarget::Main => self.sink.emit_to("main", channel, &payload),
                RouteTarget::Detached(id) => {
                    let label = Self::open_or_main(&id, &open);
                    // A notification click on a cell of a detached grid brings that window up.
                    if label != "main" && channel == "focus-cell" {
                        let hook = self.on_focus_cell.read().clone();
                        if let Some(hook) = hook {
                            hook(&label);
                        }
                    }
                    self.sink.emit_to(&label, channel, &payload);
                }
            }
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
        events.set_owners(HashMap::from([("c2".to_string(), "a".to_string()), ("c3".to_string(), "gone".to_string())]));
        events.emit(Scope::Cell("c2".into()), "cell:hook", vec![json!("c2")]);
        // A cell of a window that is not open (closing, not created yet) goes to main.
        events.emit(Scope::Cell("c3".into()), "cell:hook", vec![json!("c3")]);
        let log = rec.0.lock();
        let labels: Vec<_> = log.iter().map(|(l, e, _)| format!("{l}:{e}")).collect();
        assert_eq!(
            labels,
            vec!["main:cli:changed", "detached-a:cli:changed", "main:cell:hook", "detached-a:cell:hook", "main:cell:hook"]
        );
        assert_eq!(log[2].2, json!(["c1", "stop"]));
        assert_eq!(*flushed.lock(), 4);
    }

    #[derive(Default)]
    struct Windows(Mutex<Vec<String>>, Mutex<Vec<(String, String, Value)>>);
    impl EventSink for Windows {
        fn app_windows(&self) -> Vec<String> {
            self.0.lock().clone()
        }
        fn emit_to(&self, label: &str, event: &str, payload: &Value) {
            self.1.lock().push((label.into(), event.into(), payload.clone()));
        }
    }

    /// sendRouted: state to all, a cell's messages to its window, the start list split, the rest to main; focus-cell brings
    /// the window up first; with no detached window (or a closed one) the main window gets it.
    #[test]
    fn send_routes_like_send_routed() {
        let sink = Arc::new(Windows::default());
        *sink.0.lock() = vec!["main".into()];
        let events = Events::new(sink.clone());
        let focused = Arc::new(Mutex::new(Vec::<String>::new()));
        let f = focused.clone();
        events.on_focus_cell(move |l| f.lock().push(l.to_string()));
        events.set_owners(HashMap::from([("c1".to_string(), "w1".to_string()), ("c9".to_string(), "w9".to_string())]));
        let flushes = Arc::new(Mutex::new(0));
        let fl = flushes.clone();
        events.before_emit(move || *fl.lock() += 1);
        // No detached window open: everything to main, even a cell of w1.
        events.send("cell:hook", vec![json!("c1")]);
        *sink.0.lock() = vec!["main".into(), "detached-w1".into()];
        events.send("state:changed", vec![json!({"revision": 1})]);
        events.send("cell:hook", vec![json!("c1"), json!("stop")]);
        events.send("cell:hook", vec![json!("c2")]);
        events.send("focus-cell", vec![json!("c1")]);
        events.send("focus-cell", vec![json!("c9")]);
        events.send("automation:start-cells", vec![json!(["c2", "c1", "c3"])]);
        events.send("auth:state", vec![json!({})]);
        let log: Vec<String> = sink.1.lock().iter().map(|(l, e, p)| format!("{l} {e} {p}")).collect();
        assert_eq!(
            log,
            vec![
                r#"main cell:hook ["c1"]"#,
                r#"main state:changed [{"revision":1}]"#,
                r#"detached-w1 state:changed [{"revision":1}]"#,
                r#"detached-w1 cell:hook ["c1","stop"]"#,
                r#"main cell:hook ["c2"]"#,
                r#"detached-w1 focus-cell ["c1"]"#,
                r#"main focus-cell ["c9"]"#,
                r#"main automation:start-cells [["c2","c3"]]"#,
                r#"detached-w1 automation:start-cells [["c1"]]"#,
                r#"main auth:state [{}]"#,
            ]
        );
        assert_eq!(*focused.lock(), vec!["detached-w1".to_string()]);
        // Every send but the state change itself flushed first.
        assert_eq!(*flushes.lock(), 7);
    }
}
