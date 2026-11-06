//! Detached windows (W5): port of src/main/detachedWindows.ts. A grid or a file tab pulled out of the main window into a
//! window of its own, e.g. on a second monitor. The registry is `AppState.detachedWindows`, written here only; a window
//! exists for every entry. Terminals keep running: the pty layer sends a detached grid's output to that window
//! ([`Hooks::on_route`]), and the window adopts the running ptys. A file tab's document (unsaved text included) travels through
//! here: the giving renderer hands it over (`detach:open` / `detach:dropOutside`), the window takes it once loaded
//! (`detach:take`) and gives it back when it is attached again (`detach:attach`). Closing a detached window attaches its tab
//! back (`detach:closing`, 3 s, `detach:stay`); quitting closes the windows and keeps the registry for the next start.
//!
//! The service is independent of Tauri: window operations go through [`Host`] (the Tauri implementation is [`host`]), so the
//! behaviour is tested with a fake host. The pure rules (registry edits, owners, placement) are
//! `unimux_state::detached`; message routing is `unimux_ipc::route` (the owner table is pushed into [`Events`] on every state
//! change).
//!
//! Locking: `inner` is never held while the state controller changes the state (its hooks call back into
//! [`DetachedService::state_changed`]), while an event is emitted or while the host is called.

pub mod host;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};

use unimux_core::js_json::stringify;
use unimux_ipc::route::detached_label;
use unimux_ipc::{Events, Scope};
use unimux_state::StateController;
use unimux_state::detached::{
    self as rules, Added, DEFAULT_SIZE, DisplayArea, Placement, Rect, clean_docs, clean_open_in_main, clean_target, clean_work,
    detached_list, find_detached, handoff_sessions, normalize_wait_mark, split_handoffs, target_key,
};
use unimux_state::normalize::windows::{normalize_detached_windows, open_grids};

/// How long a closing window may take to give its document back before it closes anyway.
pub const ATTACH_TIMEOUT: Duration = Duration::from_millis(3000);
/// A moved or resized window saves its place this long after the last change.
pub const PLACE_SAVE_DELAY: Duration = Duration::from_millis(400);

/// The window side of the service (Tauri in the app, a recorder in the tests). Bounds are Electron DIPs.
pub trait Host: Send + Sync {
    /// Creates the window of `id` hidden, loading `index.html?detached=<id>`; it shows itself once the page loaded
    /// (maximized when `maximized`). `index`: how many detached windows are open (the offscreen cascade).
    fn open(&self, id: &str, title: &str, bounds: Rect, maximized: bool, index: usize) -> Result<(), String>;
    /// Destroys the window without asking (its entry left the registry).
    fn destroy(&self, id: &str);
    /// Closes the window the normal way (it hears CloseRequested; the app quits or the main window closed).
    fn close(&self, id: &str);
    fn set_title(&self, id: &str, title: &str);
    /// `showWindow`: restore when minimized, show and focus (an offscreen run never takes the focus). `main` or a
    /// detached label.
    fn show(&self, label: &str);
    /// The work areas of the displays (DIPs) and the primary display's id.
    fn displays(&self) -> (Vec<DisplayArea>, f64);
    /// The cursor in DIPs.
    fn cursor(&self) -> Option<(f64, f64)>;
    /// The main window's bounds in DIPs (None when it is gone).
    fn main_bounds(&self) -> Option<Rect>;
    /// The main window is visible and not minimized.
    fn main_shown(&self) -> bool;
    /// A detached window's normal (not maximized) bounds in DIPs, the display they are on and whether it is maximized.
    fn place(&self, id: &str) -> Option<(Rect, Option<f64>, bool)>;
}

type RouteFn = Arc<dyn Fn(&str, Option<&str>) + Send + Sync>;
type WindowFn = Arc<dyn Fn(&str) + Send + Sync>;
type GoneFn = Arc<dyn Fn(&str, bool) + Send + Sync>;
type SessionsFn = Arc<dyn Fn(&[String], Option<&str>) + Send + Sync>;
type AliveFn = Arc<dyn Fn(&str) -> bool + Send + Sync>;

/// What later packages plug in (detachedWindows.ts `DetachedDeps`): the pty routes (P3), the per-window ports of the pty,
/// DB and SFTP layers (P2 / D12 / T1), the DB session routes (D12), the renderer-gone pins (D1 / T1 / W7 taskbar) and the
/// alive check of cells (P3). Every list may stay empty.
#[derive(Default)]
pub struct Hooks {
    /// `pty.route(cellId, window)`: a cell's terminal is shown by another window (None: the main window).
    pub on_route: Vec<RouteFn>,
    /// `connectRenderer(wc, window)` of the pty and the ports: a detached window's page finished loading.
    pub on_page_loaded: Vec<WindowFn>,
    /// `rendererGone(window)` (+ `forgetRenderer` of the ports when `closed`): the page reloads or the window went.
    pub on_page_gone: Vec<GoneFn>,
    /// `pty.forgetRenderer(window)`: the window is gone.
    pub on_forget_renderer: Vec<WindowFn>,
    /// `routeDbSessions(sessions, window)`: a moving tab's DB sessions (Pub/Sub) follow it (None: the main window).
    pub on_route_db_sessions: Vec<SessionsFn>,
    /// `isAlive(cellId)`: the cell's terminal runs (cells handed back to the main window are adopted, not respawned).
    pub is_alive: Option<AliveFn>,
}

#[derive(Debug, Clone)]
struct Win {
    title: String,
}

#[derive(Default)]
struct Inner {
    /// The detached windows that exist (created by this service), by registry id.
    windows: HashMap<String, Win>,
    /// cellOwners of the latest state, in Map order.
    owners: Vec<(String, String)>,
    /// Documents handed over with a detach, taken once by the new window.
    handoffs: HashMap<String, Vec<Value>>,
    /// Windows asked to give their tab back: the timeout's token.
    attaching: HashMap<String, u64>,
    /// The unsaved work each detached window reported (Map order).
    works: Vec<(String, Value)>,
    /// What every cell waits for, as the window that shows it reports it (Map order).
    waits: Vec<(String, Value)>,
    /// The debounce token of each window's place save.
    place_tokens: HashMap<String, u64>,
    started: bool,
    /// Windows closing because the app quits (or the main window closed): no attach, the registry stays.
    closing_all: bool,
    repair_queued: bool,
    reconcile_queued: bool,
}

fn set_entry(list: &mut Vec<(String, Value)>, key: &str, value: Option<Value>) {
    match (list.iter().position(|(k, _)| k == key), value) {
        (Some(i), Some(v)) => list[i].1 = v,
        (None, Some(v)) => list.push((key.to_string(), v)),
        (Some(i), None) => {
            list.remove(i);
        }
        (None, None) => {}
    }
}

/// The detached-window service of one app run.
pub struct DetachedService {
    me: Weak<DetachedService>,
    state: Arc<StateController>,
    events: Arc<Events>,
    host: OnceLock<Arc<dyn Host>>,
    hooks: RwLock<Hooks>,
    inner: Mutex<Inner>,
    /// Window creation and removal in state order (one reconcile at a time).
    reconcile_lock: Mutex<()>,
    quitting: AtomicBool,
    /// MC_OFFSCREEN: places are not saved (the windows sit at -6000).
    offscreen: bool,
    tokens: AtomicU64,
    attach_timeout: Duration,
    place_delay: Duration,
    log: Arc<dyn Fn(&str) + Send + Sync>,
}

impl DetachedService {
    /// Builds the service and hooks it to every state change (owners, repairs, windows).
    pub fn new(
        state: Arc<StateController>,
        events: Arc<Events>,
        offscreen: bool,
        log: Arc<dyn Fn(&str) + Send + Sync>,
    ) -> Arc<Self> {
        Self::with_timing(state, events, offscreen, log, ATTACH_TIMEOUT, PLACE_SAVE_DELAY)
    }

    pub fn with_timing(
        state: Arc<StateController>,
        events: Arc<Events>,
        offscreen: bool,
        log: Arc<dyn Fn(&str) + Send + Sync>,
        attach_timeout: Duration,
        place_delay: Duration,
    ) -> Arc<Self> {
        let svc = Arc::new_cyclic(|me| Self {
            me: me.clone(),
            state: state.clone(),
            events,
            host: OnceLock::new(),
            hooks: RwLock::new(Hooks::default()),
            inner: Mutex::new(Inner::default()),
            reconcile_lock: Mutex::new(()),
            quitting: AtomicBool::new(false),
            offscreen,
            tokens: AtomicU64::new(1),
            attach_timeout,
            place_delay,
            log,
        });
        let weak = Arc::downgrade(&svc);
        state.on_change(move |change| {
            if let Some(svc) = weak.upgrade() {
                svc.state_changed(&change.snapshot.state);
            }
        });
        // The owners of the state the app starts with (cell messages are routed before any window opens).
        svc.state_changed(&state.get());
        svc
    }

    fn arc(&self) -> Arc<Self> {
        self.me.upgrade().expect("the service is alive while it runs")
    }

    pub fn set_host(&self, host: Arc<dyn Host>) {
        let _ = self.host.set(host);
    }

    fn host(&self) -> Option<&Arc<dyn Host>> {
        self.host.get()
    }

    /// Later packages register their hooks here.
    #[allow(dead_code, reason = "P2 / P3 / D1 / D12 / T1 register their hooks when they land")]
    pub fn hooks(&self) -> parking_lot::RwLockWriteGuard<'_, Hooks> {
        self.hooks.write()
    }

    /// The app is winding down (W6): windows close without attaching their tab.
    #[allow(dead_code, reason = "the quit sequence (W6) sets it")]
    pub fn set_quitting(&self, quitting: bool) {
        self.quitting.store(quitting, Ordering::SeqCst);
    }

    fn quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    fn token(&self) -> u64 {
        self.tokens.fetch_add(1, Ordering::SeqCst)
    }

    fn spawn_after(&self, delay: Duration, f: impl FnOnce(Arc<Self>) + Send + 'static) {
        let svc = self.arc();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(delay).await;
            f(svc);
        });
    }

    // ── state ─────────────────────────────────────────────────────────────────

    /// Opens the windows of the saved registry; called once the main window exists (startDetachedWindows).
    pub fn start(&self) {
        self.inner.lock().started = true;
        self.state_changed(&self.state.get());
    }

    /// Every state change: the registry repaired (closed grids), routes of moved cells, windows opened, closed and renamed.
    /// Runs inside the controller's change: it never changes the state itself (the repair is queued).
    pub fn state_changed(&self, state: &Value) {
        self.prune_waits(state);
        let raw = state.get("detachedWindows");
        let projects = state.get("projects").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
        let repaired = normalize_detached_windows(raw, &open_grids(projects));
        if repaired.as_ref().map(stringify) != raw.map(stringify) {
            // A grid closed by MCP or a resync: its window goes (the change is made outside this listener).
            let queue = {
                let mut inner = self.inner.lock();
                !std::mem::replace(&mut inner.repair_queued, true)
            };
            if queue {
                self.spawn_after(Duration::ZERO, |svc| svc.repair());
            }
        }
        let next = rules::cell_owners(state);
        let changes = {
            let mut inner = self.inner.lock();
            let changes = rules::route_changes(&inner.owners, &next);
            inner.owners = next.clone();
            changes
        };
        if !changes.is_empty() {
            let hooks: Vec<RouteFn> = self.hooks.read().on_route.clone();
            for (cell, window) in &changes {
                for hook in &hooks {
                    hook(cell, window.as_deref());
                }
            }
        }
        self.events.set_owners(next.into_iter().collect());
        self.schedule_reconcile();
    }

    fn repair(&self) {
        self.inner.lock().repair_queued = false;
        let _ = self.state.change(
            |s| {
                let projects = s.get("projects").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
                let list = normalize_detached_windows(s.get("detachedWindows"), &open_grids(projects));
                if list.as_ref().map(stringify) == s.get("detachedWindows").map(stringify) {
                    return Err("unchanged".into());
                }
                let mut next = s.as_object().cloned().unwrap_or_default();
                match list {
                    Some(l) => {
                        next.insert("detachedWindows".into(), l);
                    }
                    None => {
                        next.shift_remove("detachedWindows");
                    }
                }
                Ok(Value::Object(next))
            },
            None,
            false,
        );
    }

    fn schedule_reconcile(&self) {
        {
            let mut inner = self.inner.lock();
            if !inner.started || self.host.get().is_none() || inner.reconcile_queued {
                return;
            }
            inner.reconcile_queued = true;
        }
        let svc = self.arc();
        tauri::async_runtime::spawn_blocking(move || {
            svc.inner.lock().reconcile_queued = false;
            svc.reconcile();
        });
    }

    /// Windows follow the registry: one window per entry (created hidden at its saved place), titles kept current, windows
    /// of removed entries destroyed.
    pub fn reconcile(&self) {
        let Some(host) = self.host().cloned() else { return };
        let _order = self.reconcile_lock.lock();
        let state = self.state.get();
        let list = detached_list(&state).to_vec();
        for entry in &list {
            let Some(id) = entry.get("id").and_then(Value::as_str) else { continue };
            let Some(target) = entry.get("target") else { continue };
            let title = rules::detached_title(&state, target);
            let action = {
                let mut inner = self.inner.lock();
                let closing_all = inner.closing_all;
                match inner.windows.get_mut(id) {
                    Some(w) if w.title != title => {
                        w.title = title.clone();
                        Some(false)
                    }
                    Some(_) => None,
                    // The app is closing every window: none opens any more.
                    None if closing_all => None,
                    None => {
                        inner.windows.insert(id.to_string(), Win { title: title.clone() });
                        Some(true)
                    }
                }
            };
            match action {
                Some(true) => {
                    let index = self.inner.lock().windows.len() - 1;
                    let (displays, primary) = host.displays();
                    let saved = entry.get("bounds").and_then(Rect::from_json);
                    let Placement { bounds, .. } = rules::restore_bounds(saved.as_ref(), &displays, primary);
                    let maximized = entry.get("maximized") == Some(&Value::Bool(true));
                    if let Err(e) = host.open(id, &title, bounds, maximized, index) {
                        (self.log)(&format!("detached window {id} could not open: {e}"));
                        self.inner.lock().windows.remove(id);
                    }
                }
                Some(false) => host.set_title(id, &title),
                None => {}
            }
        }
        let gone: Vec<String> = {
            let mut inner = self.inner.lock();
            let gone: Vec<String> = inner
                .windows
                .keys()
                .filter(|id| !list.iter().any(|e| e.get("id").and_then(Value::as_str) == Some(id.as_str())))
                .cloned()
                .collect();
            for id in &gone {
                inner.windows.remove(id);
                inner.place_tokens.remove(id);
            }
            gone
        };
        for id in gone {
            self.forget_renderer(&id);
            self.page_gone(&id, true);
            host.destroy(&id);
        }
    }

    // ── what the windows report ───────────────────────────────────────────────

    /// The detached window id of a caller's label (None: the main window or anything that is not an open detached window).
    pub fn window_of(&self, label: &str) -> Option<String> {
        let id = unimux_ipc::route::detached_id(label)?;
        self.inner.lock().windows.contains_key(id).then(|| id.to_string())
    }

    /// `senderWindow(event)`: a detached window's id, else `main` (the DB and SFTP layers key per-window state by it).
    #[allow(dead_code, reason = "the DB and SFTP commands (D1 / T1) key per-window state by it")]
    pub fn sender_window(&self, label: &str) -> String {
        self.window_of(label).unwrap_or_else(|| "main".to_string())
    }

    /// `cellWindow(cellId)`: the label of the window that holds a cell's terminal (a detached grid's window, else main).
    #[allow(dead_code, reason = "agent prompts (M4) send to the window that holds the cell")]
    pub fn cell_window(&self, cell: &str) -> String {
        let inner = self.inner.lock();
        match inner.owners.iter().find(|(c, _)| c == cell) {
            Some((_, owner)) if inner.windows.contains_key(owner) => detached_label(owner),
            _ => "main".to_string(),
        }
    }

    /// `cellWaits()`: every window's waits by cell id (for the taskbar count, W7).
    #[allow(dead_code, reason = "the taskbar count (W7) reads it")]
    pub fn cell_waits(&self) -> Vec<(String, Value)> {
        self.inner.lock().waits.clone()
    }

    /// `relayCellStatus`: a detached window reported a cell status (`cell:runtime`, P3); the main window learns it too.
    #[allow(dead_code, reason = "cell:runtime (P3 / W7) relays through it")]
    pub fn relay_cell_status(&self, label: &str, cell: &Value, status: &Value) {
        if !cell.is_string() || !status.is_string() || self.window_of(label).is_none() {
            return;
        }
        self.events.emit(Scope::Main, "detach:status", vec![cell.clone(), status.clone()]);
    }

    fn set_work(&self, id: &str, work: Option<Value>) {
        {
            let mut inner = self.inner.lock();
            let before = inner.works.iter().find(|(k, _)| k == id).map(|(_, w)| w.clone());
            match (&work, &before) {
                (None, None) => return,
                (Some(a), Some(b)) if stringify(a) == stringify(b) => return,
                _ => {}
            }
            set_entry(&mut inner.works, id, work.clone());
        }
        self.events.emit(Scope::Main, "detach:work", vec![json!(id), work.unwrap_or(Value::Null)]);
    }

    fn set_wait(&self, from_detached: bool, cell: &str, mark: Option<Value>) {
        {
            let mut inner = self.inner.lock();
            if mark.is_none() && !inner.waits.iter().any(|(c, _)| c == cell) {
                return;
            }
            set_entry(&mut inner.waits, cell, mark.clone());
        }
        if from_detached {
            self.events.emit(Scope::Main, "detach:wait", vec![json!(cell), mark.unwrap_or(Value::Null)]);
        }
    }

    /// Cells that are gone (closed, their grid closed) lose their wait.
    fn prune_waits(&self, state: &Value) {
        let mut inner = self.inner.lock();
        if inner.waits.is_empty() {
            return;
        }
        let alive: Vec<&str> = state
            .get("projects")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .flat_map(|p| p.get("tabs").and_then(Value::as_array).into_iter().flatten())
            .flat_map(|t| t.get("cells").and_then(Value::as_array).into_iter().flatten())
            .filter_map(|c| c.get("id").and_then(Value::as_str))
            .collect();
        inner.waits.retain(|(c, _)| alive.contains(&c.as_str()));
    }

    fn forget_renderer(&self, id: &str) {
        let hooks: Vec<WindowFn> = self.hooks.read().on_forget_renderer.clone();
        for hook in hooks {
            hook(id);
        }
    }

    /// A detached window's page went away: its pins go (and its ports when it closed), its reported work too.
    fn page_gone(&self, id: &str, closed: bool) {
        let hooks: Vec<GoneFn> = self.hooks.read().on_page_gone.clone();
        for hook in hooks {
            hook(id, closed);
        }
        self.set_work(id, None);
    }

    // ── window events (from the host) ─────────────────────────────────────────

    /// The page starts loading (a reload or the reload after a crash): the new page pins its sessions and reports its work again.
    pub fn page_started(&self, id: &str) {
        if self.inner.lock().windows.contains_key(id) {
            self.page_gone(id, false);
        }
    }

    /// The page finished loading: the pty and the ports serve this window.
    pub fn page_loaded(&self, id: &str) {
        if !self.inner.lock().windows.contains_key(id) {
            return;
        }
        let hooks: Vec<WindowFn> = self.hooks.read().on_page_loaded.clone();
        for hook in hooks {
            hook(id);
        }
    }

    /// The close button (or Alt+F4, Cmd+W) puts the tab back into the main window; it never closes the grid or its
    /// terminals. True: the close is held (the window gives its tab back first).
    pub fn close_requested(&self, id: &str) -> bool {
        if self.inner.lock().closing_all || self.quitting() || find_detached(&self.state.get(), id).is_none() {
            return false;
        }
        self.request_attach(id);
        true
    }

    /// The window is gone. Without giving its tab back (the page closed itself, a forced close) the tab still returns; the
    /// main window finds a file's unsaved text in this window's draft storage.
    pub fn closed(&self, id: &str) {
        let (current, closing_all) = {
            let mut inner = self.inner.lock();
            inner.place_tokens.remove(id);
            (inner.windows.remove(id).is_some(), inner.closing_all)
        };
        self.forget_renderer(id);
        if current {
            self.page_gone(id, true);
        }
        if current && !closing_all && !self.quitting() && find_detached(&self.state.get(), id).is_some() {
            self.attach(id, None);
        }
    }

    /// The window moved or was resized: its place is saved 400 ms after the last change (not in an offscreen run).
    pub fn place_changed(&self, id: &str) {
        let token = self.token();
        {
            let mut inner = self.inner.lock();
            if !inner.windows.contains_key(id) {
                return;
            }
            inner.place_tokens.insert(id.to_string(), token);
        }
        let id = id.to_string();
        self.spawn_after(self.place_delay, move |svc| svc.save_place(&id, token));
    }

    fn save_place(&self, id: &str, token: u64) {
        {
            let mut inner = self.inner.lock();
            if inner.place_tokens.get(id) != Some(&token) || !inner.windows.contains_key(id) {
                return;
            }
            inner.place_tokens.remove(id);
        }
        if self.offscreen {
            return;
        }
        let Some((bounds, display_id, maximized)) = self.host().and_then(|h| h.place(id)) else { return };
        // Unchanged values change nothing (1.1.4 counted a revision for them; nothing else differs).
        let _ = self.state.change(
            |s| rules::set_detached_place(s, id, Some(bounds.rounded()), display_id, maximized).ok_or_else(|| "unchanged".into()),
            None,
            false,
        );
    }

    /// The app quits or the main window closed: every detached window closes as it is (the next start reopens it).
    pub fn close_all(&self) {
        let ids: Vec<String> = {
            let mut inner = self.inner.lock();
            inner.closing_all = true;
            inner.windows.keys().cloned().collect()
        };
        if let Some(host) = self.host() {
            for id in ids {
                host.close(&id);
            }
        }
    }

    // ── attach and detach ─────────────────────────────────────────────────────

    /// Asks the window to give its tab back (its document, pending edits); attaches without it after a timeout.
    pub fn request_attach(&self, id: &str) {
        let token = self.token();
        let asked = {
            let mut inner = self.inner.lock();
            if inner.attaching.contains_key(id) {
                return;
            }
            inner.windows.contains_key(id) && inner.attaching.insert(id.to_string(), token).is_none()
        };
        if !asked {
            self.attach(id, None);
            return;
        }
        let key = id.to_string();
        self.spawn_after(self.attach_timeout, move |svc| {
            let due = {
                let mut inner = svc.inner.lock();
                if inner.attaching.get(&key) == Some(&token) {
                    inner.attaching.remove(&key);
                    true
                } else {
                    false
                }
            };
            if due {
                svc.attach(&key, None);
            }
        });
        self.events.emit(Scope::Window(detached_label(id)), "detach:closing", vec![]);
    }

    /// Puts the tab back into the main window: the main renderer adopts the cells (or the documents), then the window goes.
    pub fn attach(&self, id: &str, docs: Option<Vec<Value>>) -> bool {
        self.inner.lock().attaching.remove(id);
        let state = self.state.get();
        let Some(entry) = find_detached(&state, id).cloned() else { return false };
        let target = entry.get("target").cloned().unwrap_or(Value::Null);
        let alive: Vec<Value> = if target.get("kind").and_then(Value::as_str) == Some("grid") {
            let is_alive = self.hooks.read().is_alive.clone();
            cell_ids_of(&state, target.get("tabId").and_then(Value::as_str).unwrap_or_default())
                .into_iter()
                .filter(|c| is_alive.as_ref().is_some_and(|f| f(c)))
                .map(Value::from)
                .collect()
        } else {
            Vec::new()
        };
        // The tab's Redis sessions come back with it: their Pub/Sub messages go to the main window again.
        if let Some(docs) = docs.as_ref().filter(|d| !d.is_empty()) {
            let sessions = handoff_sessions(&split_handoffs(docs).1);
            let hooks: Vec<SessionsFn> = self.hooks.read().on_route_db_sessions.clone();
            for hook in hooks {
                hook(&sessions, None);
            }
        }
        // Before the state change: the main renderer marks the running cells as adopted, so the grid it shows again never
        // respawns them.
        self.events.emit(
            Scope::Main,
            "detach:returned",
            vec![json!({ "id": id, "target": target, "docs": docs.unwrap_or_default(), "alive": alive })],
        );
        let _ = self.state.change(|s| rules::remove_detached(s, id).ok_or_else(|| "unchanged".into()), None, false);
        if let Some(host) = self.host()
            && host.main_bounds().is_some()
        {
            host.show("main");
        }
        true
    }

    /// The main window's bounds hold the cursor (a tab dragged back over it, or one dropped onto it).
    fn cursor_over_main(&self) -> bool {
        let Some(host) = self.host() else { return false };
        if !host.main_shown() {
            return false;
        }
        let (Some((x, y)), Some(b)) = (host.cursor(), host.main_bounds()) else { return false };
        x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height
    }

    /// Opens a window for a tab of the main window: at the cursor (dropped outside) or on another display (the menu).
    fn detach(&self, raw_target: &Value, raw_docs: Option<&Value>, at_cursor: bool) -> Value {
        let invalid = json!({ "ok": false, "error": "invalid" });
        let (Some(target), Some(docs)) = (clean_target(Some(raw_target)), clean_docs(raw_docs)) else { return invalid };
        let state = self.state.get();
        if target["kind"] == "grid" {
            let projects = state.get("projects").and_then(Value::as_array).map(Vec::as_slice).unwrap_or_default();
            let grids = open_grids(projects);
            let tab = target["tabId"].as_str().unwrap_or_default();
            let project = grids.iter().find(|(k, _)| k == tab).map(|(_, p)| p);
            if !project.is_some_and(|p| unimux_state::normalize::js::strict_eq(Some(p), target.get("projectId"))) {
                return invalid;
            }
        }
        // A file tab: its one document (and the handoff of a database or Redis tab next to it).
        let (parts_docs, parts_handoffs) = split_handoffs(&docs);
        if target["kind"] == "file" && (parts_docs.len() != 1 || parts_handoffs.len() > 1) {
            return invalid;
        }
        let key = target_key(&target);
        if let Some(existing) = detached_list(&state).iter().find(|w| w.get("target").is_some_and(|t| target_key(t) == key)) {
            let id = existing["id"].as_str().unwrap_or_default().to_string();
            if self.inner.lock().windows.contains_key(&id)
                && let Some(host) = self.host()
            {
                host.show(&detached_label(&id));
            }
            return json!({ "ok": true, "id": id });
        }
        let Some(host) = self.host() else { return json!({ "ok": false, "error": "not ready" }) };
        let (displays, primary) = host.displays();
        let place = if at_cursor {
            let (x, y) = host.cursor().unwrap_or((0.0, 0.0));
            rules::bounds_at_point(x, y, DEFAULT_SIZE, &displays, primary)
        } else {
            rules::bounds_beside(host.main_bounds().as_ref(), DEFAULT_SIZE, &displays, primary)
        };
        let id = uuid::Uuid::new_v4().to_string();
        let mut entry = json!({ "id": id, "target": target, "bounds": place.bounds.to_json() });
        if let Some(d) = place.display_id {
            entry["displayId"] = unimux_state::normalize::js::num(d);
        }
        let mut added: Option<String> = None;
        let _ = self.state.change(
            |s| match rules::add_detached(s, entry.clone()) {
                Added::Added(next) => {
                    added = Some(id.clone());
                    Ok(next)
                }
                Added::Existing(w) => {
                    added = w.get("id").and_then(Value::as_str).map(str::to_string);
                    Err("existing".into())
                }
                Added::Limit => Err("limit".into()),
            },
            None,
            false,
        );
        let Some(added) = added else { return json!({ "ok": false, "error": "limit" }) };
        if added == id && target["kind"] == "file" {
            self.inner.lock().handoffs.insert(id.clone(), docs);
            // A Redis tab's Pub/Sub messages go to its new window from now on (the window takes the rest when it loads).
            let sessions = handoff_sessions(&parts_handoffs);
            let hooks: Vec<SessionsFn> = self.hooks.read().on_route_db_sessions.clone();
            for hook in hooks {
                hook(&sessions, Some(&id));
            }
        }
        json!({ "ok": true, "id": added })
    }

    // ── the detach:* channels ─────────────────────────────────────────────────

    /// `detach:open` (main window only): its tab goes to a new window.
    pub fn cmd_open(&self, label: &str, target: &Value, docs: Option<&Value>) -> Value {
        if self.window_of(label).is_some() {
            return json!({ "ok": false, "error": "refused" });
        }
        self.detach(target, docs, false)
    }

    /// `detach:dropOutside`: a tab dragged out of the main window and dropped outside it: a new window under the cursor.
    pub fn cmd_drop_outside(&self, label: &str, target: &Value, docs: Option<&Value>) -> Value {
        if self.window_of(label).is_some() {
            return json!({ "ok": false, "error": "refused" });
        }
        if self.cursor_over_main() {
            return json!({ "ok": false, "error": "inside" });
        }
        self.detach(target, docs, true)
    }

    /// `detach:take`: the detached window takes the documents handed over for it (once).
    pub fn cmd_take(&self, label: &str) -> Value {
        let Some(id) = self.window_of(label) else { return json!([]) };
        Value::Array(self.inner.lock().handoffs.remove(&id).unwrap_or_default())
    }

    /// `detach:attach(docs, overMain)`: the detached window gives its tab back; `overMain` only when the cursor is over the
    /// main window (the end of a drag).
    pub fn cmd_attach(&self, label: &str, docs: Option<&Value>, over_main: &Value) -> bool {
        let Some(id) = self.window_of(label) else { return false };
        let Some(clean) = clean_docs(docs) else { return false };
        if over_main == &Value::Bool(true) && !self.cursor_over_main() {
            return false;
        }
        self.attach(&id, Some(clean))
    }

    /// `detach:dismiss`: the detached window's tab was closed there; the window goes, nothing comes back.
    pub fn cmd_dismiss(&self, label: &str) -> bool {
        let Some(id) = self.window_of(label) else { return false };
        if find_detached(&self.state.get(), &id).is_none() {
            return false;
        }
        let _ = self.state.change(|s| rules::remove_detached(s, &id).ok_or_else(|| "unchanged".into()), None, false);
        true
    }

    /// `detach:requestAttach(id)` from the main window: the window gives its tab back.
    pub fn cmd_request_attach(&self, label: &str, id: &Value) {
        let Some(id) = id.as_str() else { return };
        if self.window_of(label).is_none() && self.inner.lock().windows.contains_key(id) {
            self.request_attach(id);
        }
    }

    /// `detach:stay`: a closing detached window needs longer to give its tab back (it asks about a running query first).
    pub fn cmd_stay(&self, label: &str) {
        if let Some(id) = self.window_of(label) {
            self.inner.lock().attaching.remove(&id);
        }
    }

    /// `detach:work(work)`: a detached window's unsaved work for the main window's quit question.
    pub fn cmd_work(&self, label: &str, raw: &Value) {
        if let Some(id) = self.window_of(label)
            && find_detached(&self.state.get(), &id).is_some()
        {
            self.set_work(&id, clean_work(Some(raw)));
        }
    }

    /// `detach:works`: the main window (after a reload) asks what the detached windows hold.
    pub fn cmd_works(&self, label: &str) -> Value {
        if self.window_of(label).is_some() {
            return json!([]);
        }
        Value::Array(self.inner.lock().works.iter().map(|(id, work)| json!({ "id": id, "work": work })).collect())
    }

    /// `detach:openInMain(request)`: a detached database or Redis tab opens another tab in the main window.
    pub fn cmd_open_in_main(&self, label: &str, raw: &Value) {
        let Some(request) = clean_open_in_main(Some(raw)) else { return };
        if self.window_of(label).is_none() {
            return;
        }
        let Some(host) = self.host() else { return };
        if host.main_bounds().is_none() {
            return;
        }
        self.events.emit(Scope::Main, "detach:openInMain", vec![request]);
        host.show("main");
    }

    /// `detach:wait(cellId, mark)`: a window reports what one of its cells waits for (null: nothing any more).
    pub fn cmd_wait(&self, label: &str, cell: &Value, raw: &Value) {
        let Some(cell) = cell.as_str() else { return };
        let id = self.window_of(label);
        let owner = self.inner.lock().owners.iter().find(|(c, _)| c == cell).map(|(_, w)| w.clone());
        if owner != id {
            return;
        }
        let mark = if raw.is_null() { None } else { normalize_wait_mark(Some(raw)) };
        self.set_wait(id.is_some(), cell, mark);
    }

    /// `detach:waits`: the main window gets every wait, a detached window those of its own cells.
    pub fn cmd_waits(&self, label: &str) -> Value {
        let id = self.window_of(label);
        let inner = self.inner.lock();
        let owner = |cell: &str| inner.owners.iter().find(|(c, _)| c == cell).map(|(_, w)| w.clone());
        Value::Array(
            inner
                .waits
                .iter()
                .filter(|(cell, _)| id.is_none() || owner(cell) == id)
                .map(|(cell, mark)| json!({ "cellId": cell, "mark": mark }))
                .collect(),
        )
    }

    /// `detach:waitStep(dir)` from a detached window: the main window (which has the whole list) picks the cell.
    pub fn cmd_wait_step(&self, label: &str, dir: &Value) {
        if self.window_of(label).is_none() {
            return;
        }
        let dir = if dir.as_f64() == Some(-1.0) { -1 } else { 1 };
        self.events.emit(Scope::Main, "waiting:step", vec![json!(dir)]);
    }

    /// `detach:revealCell(cellId)` from the main window: show a cell wherever it is (its window comes to the front and
    /// focuses the cell).
    pub fn cmd_reveal_cell(&self, label: &str, cell: &Value) {
        let Some(cell) = cell.as_str() else { return };
        if self.window_of(label).is_some() || !find_cell(&self.state.get(), cell) {
            return;
        }
        let Some(host) = self.host() else { return };
        let target = {
            let inner = self.inner.lock();
            match inner.owners.iter().find(|(c, _)| c == cell) {
                Some((_, owner)) => inner.windows.contains_key(owner).then(|| detached_label(owner)),
                None => Some("main".to_string()),
            }
        };
        let Some(target) = target else { return };
        if target == "main" && host.main_bounds().is_none() {
            return;
        }
        host.show(&target);
        self.events.emit(Scope::Window(target), "focus-cell", vec![json!(cell)]);
    }

    /// `detach:focus(id)`: brings a detached window up.
    pub fn cmd_focus(&self, id: &Value) {
        let Some(id) = id.as_str() else { return };
        if self.inner.lock().windows.contains_key(id)
            && let Some(host) = self.host()
        {
            host.show(&detached_label(id));
        }
    }

    /// A `focus-cell` routed to a detached window brings it up first (sendRouted).
    pub fn focus_label(&self, label: &str) {
        if let Some(host) = self.host() {
            host.show(label);
        }
    }

    /// Check build: what the service holds (test-bridge `detached`).
    #[cfg(feature = "test-bridge")]
    pub fn debug_view(&self) -> Value {
        let inner = self.inner.lock();
        let mut windows: Vec<&String> = inner.windows.keys().collect();
        windows.sort();
        json!({
            "windows": windows,
            "owners": inner.owners.iter().map(|(c, w)| json!([c, w])).collect::<Vec<_>>(),
            "handoffs": inner.handoffs.keys().collect::<Vec<_>>(),
            "attaching": inner.attaching.keys().collect::<Vec<_>>(),
            "works": inner.works.iter().map(|(id, w)| json!({ "id": id, "work": w })).collect::<Vec<_>>(),
            "waits": inner.waits.iter().map(|(c, m)| json!({ "cellId": c, "mark": m })).collect::<Vec<_>>(),
            "started": inner.started,
            "closingAll": inner.closing_all,
        })
    }
}

/// The cell ids of a grid (the first project that has the tab).
fn cell_ids_of(state: &Value, tab: &str) -> Vec<String> {
    for p in state.get("projects").and_then(Value::as_array).into_iter().flatten() {
        if let Some(t) = p
            .get("tabs")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|t| t.get("id").and_then(Value::as_str) == Some(tab))
        {
            return t
                .get("cells")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|c| c.get("id").and_then(Value::as_str).map(str::to_string))
                .collect();
        }
    }
    Vec::new()
}

fn find_cell(state: &Value, cell: &str) -> bool {
    state
        .get("projects")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|p| p.get("tabs").and_then(Value::as_array).into_iter().flatten())
        .flat_map(|t| t.get("cells").and_then(Value::as_array).into_iter().flatten())
        .any(|c| c.get("id").and_then(Value::as_str) == Some(cell))
}

#[cfg(test)]
mod tests;
