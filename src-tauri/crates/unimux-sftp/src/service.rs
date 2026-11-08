//! Main side of SFTP sessions (port of 1.1.4 src/main/sftp/service.ts): starts the SFTP host on first use, logs in through
//! the SSH coordinator (same vault, known hosts and prompts as a cell), keeps the session state the renderer sees, brokers
//! operations and disconnects a session 2 minutes after the SFTP view closed once its queue is empty.
//!
//! One mutex guards the sessions and the view state; it is never held while the coordinator, the host or the events are
//! called (the coordinator's events come back into [`SftpService::on_coordinator_session`]).

use std::collections::HashSet;
use std::sync::{Arc, Weak};

use futures::future::BoxFuture;
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use unimux_ssh::protocol::{HostMessage, PromptAnswer};
use unimux_ssh::session::{SshErrorCode, SshPhase};

use crate::error::{SftpErrorCode, SftpResult};
use crate::limits::{IDLE_DISCONNECT_MS, LOCAL_QUEUE_ID, is_sftp_session_id, sftp_session_id, status_of};
use crate::op::SftpOp;
use crate::timers::{TimerId, Timers};

/// The coordinator as the SFTP service uses it (1.1.4 passes the SshCoordinator itself).
pub trait SftpCoordinator: Send + Sync {
    /// `connectSession`: the login of an `sftp:` session (`sudo` decided by the service, once).
    fn connect_session(&self, session_id: &str, host_id: &str, sudo: bool) -> BoxFuture<'static, Result<(), SshErrorCode>>;
    fn end_session(&self, id: &str);
    fn answer(&self, answer: PromptAnswer) -> bool;
    /// The open prompts of the SFTP sessions: `(sessionId, prompt)`.
    fn prompts(&self) -> Vec<(String, Value)>;
    fn on_host_message(&self, m: HostMessage);
    fn session_host_crashed(&self);
}

/// The SFTP host as the service uses it (1.1.4 `SftpHostLink`).
pub trait SftpHostLink: Send + Sync {
    /// The host may run (false: it crashed too often or the app quits).
    fn ensure(&self) -> bool;
    /// `sftpDisconnect`: the session closes (its queue is cancelled first).
    fn disconnect(&self, id: &str);
    /// One operation of a session or of the local queue (`LOCAL_QUEUE_ID`).
    fn request(&self, id: &str, op: SftpOp) -> BoxFuture<'static, SftpResult>;
}

/// `sftp:session`, `sftp:prompt`, `sftp:hostCrashed`.
pub trait SftpEvents: Send + Sync {
    fn session(&self, state: &Value);
    fn prompt(&self, session_id: &str, prompt: Option<&Value>);
    fn host_crashed(&self);
}

pub type Spawn = Arc<dyn Fn(BoxFuture<'static, ()>) + Send + Sync>;

pub struct SftpDeps {
    pub coordinator: Arc<dyn SftpCoordinator>,
    pub host: Arc<dyn SftpHostLink>,
    pub host_exists: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    /// 0.9.9: the host runs SFTP through sudo (the session then reads `sudo` once connected).
    pub host_sudo: Arc<dyn Fn(&str) -> bool + Send + Sync>,
    pub events: Arc<dyn SftpEvents>,
    pub timers: Arc<dyn Timers>,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub new_uuid: Arc<dyn Fn() -> String + Send + Sync>,
    /// Runs the login after the connect answer went out (1.1.4 `setImmediate`).
    pub defer: Spawn,
    /// Runs background work (the start folder lookup, a deferred `endSession`).
    pub spawn: Spawn,
    pub idle_ms: u64,
}

impl SftpDeps {
    pub const IDLE_MS: u64 = IDLE_DISCONNECT_MS;
}

struct Entry {
    serial: u64,
    host_id: String,
    /// `SftpSessionState` in the key order of 1.1.4's spreads.
    state: Map<String, Value>,
    initial_path: Option<String>,
    queue_active: bool,
    idle: Option<TimerId>,
    resolving: bool,
    sudo: bool,
    plain: bool,
}

#[derive(Default)]
struct Inner {
    sessions: IndexMap<String, Entry>,
    view_open: bool,
    /// The session the open SFTP view shows (0.9.9): the only one exempt from the idle disconnect while the view is open.
    shown: Option<String>,
    /// Hosts with unsaved editor tabs (0.9.9): their sessions are not disconnected for being idle.
    pinned: HashSet<String>,
    /// The pinned hosts of each window (1.0.8: `main` and detached windows); `pinned` is their union.
    pins_by: IndexMap<String, HashSet<String>>,
    serial: u64,
}

pub struct SftpService {
    me: Weak<SftpService>,
    deps: SftpDeps,
    inner: Mutex<Inner>,
}

impl std::fmt::Debug for SftpService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SftpService").field("sessions", &self.inner.lock().sessions.len()).finish()
    }
}

fn str_of<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn err(code: &str) -> Value {
    json!({ "ok": false, "error": code })
}

impl SftpService {
    pub fn new(deps: SftpDeps) -> Arc<SftpService> {
        Arc::new_cyclic(|me| SftpService { me: me.clone(), deps, inner: Mutex::new(Inner::default()) })
    }

    fn now(&self) -> i64 {
        (self.deps.now)()
    }

    /// `connect(hostId, initialPath, {plain})`. `plain`: a session with the SSH user's own rights even when the host runs
    /// SFTP through sudo (editor tabs). Answers `{ok, sessionId}` or `{ok: false, error}`.
    pub fn connect(&self, host_id: &str, initial_path: Option<String>, plain: bool) -> Value {
        if !(self.deps.host_exists)(host_id) {
            return err(SshErrorCode::HostMissing.as_str());
        }
        if !self.deps.host.ensure() {
            return err(SshErrorCode::SftpHostCrashed.as_str());
        }
        let id = sftp_session_id(&(self.deps.new_uuid)());
        // Sudo is decided here, once: the coordinator gets the flag and never reads the host setting again (a toggle in
        // between can never give a root session without `sudo` on it).
        let sudo = !plain && (self.deps.host_sudo)(host_id);
        let mut state = Map::new();
        state.insert("id".into(), json!(id));
        state.insert("hostId".into(), json!(host_id));
        state.insert("state".into(), json!("connecting"));
        state.insert("phase".into(), json!("connecting"));
        state.insert("since".into(), json!(self.now()));
        if plain {
            state.insert("plain".into(), json!(true));
        }
        let serial = {
            let mut inner = self.inner.lock();
            inner.serial += 1;
            let serial = inner.serial;
            inner.sessions.insert(
                id.clone(),
                Entry {
                    serial,
                    host_id: host_id.to_string(),
                    state,
                    initial_path,
                    queue_active: false,
                    idle: None,
                    resolving: false,
                    sudo,
                    plain,
                },
            );
            // Only the view opens sessions that are not plain: while it is open, the new one is the one it shows (the
            // renderer confirms it).
            if !plain && inner.view_open {
                inner.shown = Some(id.clone());
            }
            serial
        };
        // The id goes back first; the login (which may wait minutes for a passphrase) runs after this answer, so every
        // `sftp:session` and `sftp:prompt` event names an id the view already has.
        let (me, sid, host) = (self.me.clone(), id.clone(), host_id.to_string());
        (self.deps.defer)(Box::pin(async move {
            let Some(svc) = me.upgrade() else { return };
            let r = svc.deps.coordinator.connect_session(&sid, &host, sudo).await;
            let Err(code) = r else { return };
            let emit = {
                let mut inner = svc.inner.lock();
                let Some(entry) = inner.sessions.get_mut(&sid).filter(|e| e.serial == serial) else { return };
                // The coordinator reports most failures as an `error` state itself; one it refused up front is reported here.
                let emit = (entry.state.get("state") != Some(&json!("error"))).then(|| {
                    entry.state.insert("state".into(), json!("error"));
                    entry.state.insert("phase".into(), json!("error"));
                    entry.state.insert("since".into(), json!(svc.now()));
                    entry.state.insert("error".into(), json!(code.as_str()));
                    Value::Object(entry.state.clone())
                });
                svc.forget_locked(&mut inner, &sid);
                emit
            };
            if let Some(state) = emit {
                svc.deps.events.session(&state);
            }
        }));
        json!({ "ok": true, "sessionId": id })
    }

    /// `disconnect(id)`: `{ok}`.
    pub fn disconnect(&self, id: &str) -> bool {
        if !self.inner.lock().sessions.contains_key(id) {
            return false;
        }
        self.deps.host.disconnect(id);
        // Emits "closed" through on_coordinator_session while the entry still exists (a plain session's state keeps
        // `plain`, like 1.1.4), which forgets it; the forget below covers a coordinator that did not know the session.
        self.deps.coordinator.end_session(id);
        let mut inner = self.inner.lock();
        self.forget_locked(&mut inner, id);
        true
    }

    fn forget_locked(&self, inner: &mut Inner, id: &str) {
        if let Some(entry) = inner.sessions.shift_remove(id)
            && let Some(t) = entry.idle
        {
            self.deps.timers.cancel(t);
        }
    }

    /// A state of a non-cell session from the coordinator (the app routes `sftp:` ids here; `SshSessionState` JSON).
    pub fn on_coordinator_session(&self, s: &Value) {
        let id = str_of(s, "cellId").to_string();
        let Some(phase) = SshPhase::parse(str_of(s, "phase")) else { return };
        let mut next = Map::new();
        next.insert("id".into(), json!(id));
        next.insert("hostId".into(), s.get("hostId").cloned().unwrap_or(Value::Null));
        next.insert("state".into(), json!(status_of(phase)));
        next.insert("phase".into(), json!(phase.as_str()));
        next.insert("since".into(), s.get("since").cloned().unwrap_or(Value::Null));
        if let Some(e) = s.get("error").filter(|e| e.as_str().is_some_and(|e| !e.is_empty())) {
            next.insert("error".into(), e.clone());
        }
        let mut inner = self.inner.lock();
        let Some(entry) = inner.sessions.get_mut(&id) else {
            drop(inner);
            // A closed or failed session main already forgot still tells the renderer.
            if !phase.is_live() {
                self.deps.events.session(&Value::Object(next));
            }
            return;
        };
        if entry.plain {
            next.insert("plain".into(), json!(true));
        }
        if phase == SshPhase::Connected {
            // "connected" goes out with the start folder: the asked one when it exists, else the login folder.
            if entry.resolving || entry.state.contains_key("path") {
                return;
            }
            entry.resolving = true;
            let (serial, initial, sudo) = (entry.serial, entry.initial_path.clone(), entry.sudo);
            drop(inner);
            let me = self.me.clone();
            (self.deps.spawn)(Box::pin(async move {
                let Some(svc) = me.upgrade() else { return };
                let path = svc.resolve_start(&id, initial).await;
                let state = {
                    let mut inner = svc.inner.lock();
                    let Some(entry) = inner.sessions.get_mut(&id).filter(|e| e.serial == serial) else { return };
                    entry.resolving = false;
                    // Sudo never falls back to the plain subsystem: a connected session of a sudo host runs through sudo.
                    let mut state = next;
                    state.insert("path".into(), json!(path));
                    if sudo {
                        state.insert("sudo".into(), json!(true));
                    }
                    entry.state = state.clone();
                    svc.schedule_idle_locked(&mut inner, &id);
                    Value::Object(state)
                };
                svc.deps.events.session(&state);
            }));
            return;
        }
        entry.state = next.clone();
        if !phase.is_live() {
            self.forget_locked(&mut inner, &id);
        }
        drop(inner);
        self.deps.events.session(&Value::Object(next));
        if !phase.is_live() {
            // Out of the coordinator's own loop (it may be reporting its sessions right now).
            let me = self.me.clone();
            (self.deps.spawn)(Box::pin(async move {
                if let Some(svc) = me.upgrade() {
                    svc.deps.coordinator.end_session(&id);
                }
            }));
        }
    }

    /// The asked folder when it is a folder (or a link to one), else the login folder, else `/`.
    async fn resolve_start(&self, id: &str, initial: Option<String>) -> String {
        if let Some(p) = initial
            && let Some(found) = self.try_start(id, &p).await
        {
            return found;
        }
        self.try_start(id, ".").await.unwrap_or_else(|| "/".to_string())
    }

    async fn try_start(&self, id: &str, path: &str) -> Option<String> {
        let real = self.deps.host.request(id, SftpOp::Realpath { path: path.to_string() }).await.ok()?;
        let real = real.as_str()?.to_string();
        let st = self.deps.host.request(id, SftpOp::Stat { path: real.clone() }).await.ok()?;
        let dir =
            st.get("kind").and_then(Value::as_str) == Some("dir") || st.get("target").and_then(Value::as_str) == Some("dir");
        dir.then_some(real)
    }

    pub fn on_prompt(&self, session_id: &str, prompt: Option<&Value>) {
        self.deps.events.prompt(session_id, prompt);
    }

    /// Queue activity of the host: drives the idle disconnect (the local queue has none).
    pub fn on_queue(&self, id: &str, active: bool) {
        if id == LOCAL_QUEUE_ID {
            return;
        }
        let mut inner = self.inner.lock();
        let Some(entry) = inner.sessions.get_mut(id) else { return };
        entry.queue_active = active;
        self.schedule_idle_locked(&mut inner, id);
    }

    /// Login messages of the host go to the coordinator, only for sessions this service started: the SFTP host can never
    /// move a cell's state.
    pub fn on_host_ssh(&self, m: HostMessage) {
        if matches!(m, HostMessage::Exit { .. }) {
            return;
        }
        let id = m.id();
        if !is_sftp_session_id(id) || !self.inner.lock().sessions.contains_key(id) {
            return;
        }
        self.deps.coordinator.on_host_message(m);
    }

    /// The host crashed: every session ended, the renderer fails its unfinished transfers.
    pub fn host_crashed(&self) {
        self.deps.coordinator.session_host_crashed();
        {
            let mut inner = self.inner.lock();
            let ids: Vec<String> = inner.sessions.keys().cloned().collect();
            for id in ids {
                self.forget_locked(&mut inner, &id);
            }
        }
        self.deps.events.host_crashed();
    }

    /// `answer(a)`: only for a session of this service.
    pub fn answer(&self, a: PromptAnswer) -> bool {
        if !self.inner.lock().sessions.contains_key(a.cell_id()) {
            return false;
        }
        self.deps.coordinator.answer(a)
    }

    /// `SftpSnapshot`.
    pub fn snapshot(&self) -> Value {
        let prompts: Vec<Value> = self
            .deps
            .coordinator
            .prompts()
            .into_iter()
            .map(|(id, prompt)| json!({ "sessionId": id, "prompt": prompt }))
            .collect();
        let sessions: Vec<Value> = self.inner.lock().sessions.values().map(|e| Value::Object(e.state.clone())).collect();
        json!({ "sessions": sessions, "prompts": prompts })
    }

    /// An operation of a session or of the local queue (`None`).
    pub async fn op(&self, session_id: Option<&str>, op: SftpOp) -> SftpResult {
        match session_id {
            Some(id) => {
                if !self.inner.lock().sessions.contains_key(id) {
                    return Err(SftpErrorCode::NoSession);
                }
                self.deps.host.request(id, op).await
            }
            None => {
                if !self.deps.host.ensure() {
                    return Err(SftpErrorCode::SftpHostCrashed);
                }
                self.deps.host.request(LOCAL_QUEUE_ID, op).await
            }
        }
    }

    /// The view is on screen and shows `shown` (None: no session): every other session may still go idle.
    pub fn view_opened(&self, shown: Option<String>) {
        let mut inner = self.inner.lock();
        inner.view_open = true;
        inner.shown = shown;
        self.schedule_all_locked(&mut inner);
    }

    pub fn view_closed(&self) {
        let mut inner = self.inner.lock();
        inner.view_open = false;
        inner.shown = None;
        self.schedule_all_locked(&mut inner);
    }

    /// A window reloads, crashed or closed. The main window's new page starts with the view hidden and only reports a
    /// change, so main counts it closed; any window's page reports its unsaved editor tabs again.
    pub fn renderer_gone(&self, window: &str) {
        let (view_open, pinned) = {
            let inner = self.inner.lock();
            (inner.view_open, inner.pins_by.contains_key(window))
        };
        if window == "main" && view_open {
            self.view_closed();
        }
        if pinned {
            self.pin_hosts(Vec::new(), window);
        }
    }

    /// The hosts of a window's editor tabs with unsaved changes: their sessions stay connected while the view is closed.
    pub fn pin_hosts(&self, host_ids: Vec<String>, window: &str) {
        let mut inner = self.inner.lock();
        if host_ids.is_empty() {
            inner.pins_by.shift_remove(window);
        } else {
            inner.pins_by.insert(window.to_string(), host_ids.into_iter().collect());
        }
        inner.pinned = inner.pins_by.values().flatten().cloned().collect();
        self.schedule_all_locked(&mut inner);
    }

    /// The session ids (tests, the app's diagnostics).
    pub fn ids(&self) -> Vec<String> {
        self.inner.lock().sessions.keys().cloned().collect()
    }

    fn schedule_all_locked(&self, inner: &mut Inner) {
        let ids: Vec<String> = inner.sessions.keys().cloned().collect();
        for id in ids {
            self.schedule_idle_locked(inner, &id);
        }
    }

    /// Whether a session stays connected without a timer: the one the open view shows, one with queue activity, and a
    /// non-sudo session of a host with unsaved editor tabs (the tabs never use a sudo session, so a pin never keeps one
    /// alive unseen).
    fn kept(inner: &Inner, id: &str) -> bool {
        let Some(e) = inner.sessions.get(id) else { return false };
        (inner.view_open && inner.shown.as_deref() == Some(id))
            || e.queue_active
            || (!e.sudo && inner.pinned.contains(&e.host_id))
    }

    fn schedule_idle_locked(&self, inner: &mut Inner, id: &str) {
        let Some(entry) = inner.sessions.get_mut(id) else { return };
        if let Some(t) = entry.idle.take() {
            self.deps.timers.cancel(t);
        }
        if Self::kept(inner, id) {
            return;
        }
        let serial = inner.sessions.get(id).map(|e| e.serial).unwrap_or_default();
        let (me, sid) = (self.me.clone(), id.to_string());
        let timer = self.deps.timers.after(
            self.deps.idle_ms,
            Box::new(move || {
                let Some(svc) = me.upgrade() else { return };
                let due = {
                    let inner = svc.inner.lock();
                    inner.sessions.get(&sid).is_some_and(|e| e.serial == serial) && !Self::kept(&inner, &sid)
                };
                if due {
                    svc.disconnect(&sid);
                }
            }),
        );
        if let Some(entry) = inner.sessions.get_mut(id) {
            entry.idle = Some(timer);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::timers::ManualTimers;
    use std::collections::HashMap;

    const HOST: &str = "00000000-0000-4000-8000-000000000001";
    const OTHER: &str = "00000000-0000-4000-8000-000000000002";

    #[derive(Default)]
    struct Log {
        connects: Vec<String>,
        /// Every login the coordinator was asked for: session id, host id and the explicit sudo flag.
        logins: Vec<(String, String, bool)>,
        ended: Vec<String>,
        forwarded: Vec<String>,
        disconnects: Vec<String>,
        requests: Vec<(String, String)>,
        states: Vec<Value>,
        crashed: usize,
        host_crashed_calls: usize,
    }

    struct Fake {
        log: Arc<Mutex<Log>>,
        service: Mutex<Weak<SftpService>>,
        refuse: Option<SshErrorCode>,
    }

    impl SftpCoordinator for Fake {
        fn connect_session(&self, id: &str, host: &str, sudo: bool) -> BoxFuture<'static, Result<(), SshErrorCode>> {
            self.log.lock().connects.push(id.to_string());
            self.log.lock().logins.push((id.to_string(), host.to_string(), sudo));
            if let Some(code) = self.refuse {
                return Box::pin(async move { Err(code) });
            }
            if let Some(s) = self.service.lock().upgrade() {
                s.on_coordinator_session(&json!({ "cellId": id, "hostId": host, "phase": "connecting", "since": 1 }));
            }
            Box::pin(async { Ok(()) })
        }
        fn end_session(&self, id: &str) {
            self.log.lock().ended.push(id.to_string());
        }
        fn answer(&self, _a: PromptAnswer) -> bool {
            true
        }
        fn prompts(&self) -> Vec<(String, Value)> {
            vec![]
        }
        fn on_host_message(&self, m: HostMessage) {
            self.log.lock().forwarded.push(m.id().to_string());
        }
        fn session_host_crashed(&self) {
            self.log.lock().host_crashed_calls += 1;
        }
    }

    struct Host {
        log: Arc<Mutex<Log>>,
        realpaths: HashMap<&'static str, &'static str>,
    }

    impl SftpHostLink for Host {
        fn ensure(&self) -> bool {
            true
        }
        fn disconnect(&self, id: &str) {
            self.log.lock().disconnects.push(id.to_string());
        }
        fn request(&self, id: &str, op: SftpOp) -> BoxFuture<'static, SftpResult> {
            self.log.lock().requests.push((id.to_string(), op.name().to_string()));
            let r = match op {
                SftpOp::Realpath { path } => self.realpaths.get(path.as_str()).map(|p| json!(p)).ok_or(SftpErrorCode::NotFound),
                SftpOp::Stat { .. } => Ok(json!({ "kind": "dir" })),
                _ => Ok(json!(true)),
            };
            Box::pin(async move { r })
        }
    }

    struct Events(Arc<Mutex<Log>>);

    impl SftpEvents for Events {
        fn session(&self, state: &Value) {
            self.0.lock().states.push(state.clone());
        }
        fn prompt(&self, _id: &str, _prompt: Option<&Value>) {}
        fn host_crashed(&self) {
            self.0.lock().crashed += 1;
        }
    }

    type Deferred = Arc<Mutex<Vec<BoxFuture<'static, ()>>>>;

    struct Setup {
        service: Arc<SftpService>,
        log: Arc<Mutex<Log>>,
        timers: Arc<ManualTimers>,
        deferred: Deferred,
    }

    impl Setup {
        async fn run_deferred(&self) {
            loop {
                let next = { self.deferred.lock().pop() };
                match next {
                    Some(f) => f.await,
                    None => break,
                }
            }
            flush().await;
        }
        fn last_state(&self) -> Value {
            self.log.lock().states.last().cloned().unwrap_or(Value::Null)
        }
    }

    async fn flush() {
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }

    fn setup_with(refuse: Option<SshErrorCode>) -> Setup {
        setup_full(refuse, &[])
    }

    fn setup_full(refuse: Option<SshErrorCode>, sudo_hosts: &[&'static str]) -> Setup {
        let sudo_hosts: Vec<String> = sudo_hosts.iter().map(|h| h.to_string()).collect();
        let log = Arc::new(Mutex::new(Log::default()));
        let timers = Arc::new(ManualTimers::default());
        let deferred: Deferred = Arc::new(Mutex::new(Vec::new()));
        let coordinator = Arc::new(Fake { log: log.clone(), service: Mutex::new(Weak::new()), refuse });
        let realpaths = HashMap::from([(".", "/home/alice"), ("/srv/www", "/srv/www")]);
        let d = deferred.clone();
        let counter = Arc::new(Mutex::new(0u32));
        let service = SftpService::new(SftpDeps {
            coordinator: coordinator.clone(),
            host: Arc::new(Host { log: log.clone(), realpaths }),
            host_exists: Arc::new(|id| id == HOST || id == OTHER),
            host_sudo: Arc::new(move |id| sudo_hosts.iter().any(|h| h == id)),
            events: Arc::new(Events(log.clone())),
            timers: timers.clone(),
            now: Arc::new(|| 5),
            new_uuid: Arc::new(move || {
                let mut c = counter.lock();
                *c += 1;
                format!("00000000-0000-4000-8000-{:012}", 0xa00 + *c)
            }),
            defer: Arc::new(move |f| d.lock().insert(0, f)),
            spawn: Arc::new(|f| {
                tokio::spawn(f);
            }),
            idle_ms: SftpDeps::IDLE_MS,
        });
        *coordinator.service.lock() = Arc::downgrade(&service);
        Setup { service, log, timers, deferred }
    }

    fn connected(id: &str) -> Value {
        json!({ "cellId": id, "hostId": HOST, "phase": "connected", "since": 2 })
    }

    fn session_id(r: &Value) -> String {
        r["sessionId"].as_str().unwrap_or_default().to_string()
    }

    #[tokio::test]
    async fn announces_connected_with_the_asked_folder_or_the_login_folder() {
        let f = setup_with(None);
        let r = f.service.connect(HOST, Some("/srv/www".into()), false);
        assert_eq!(r["ok"], json!(true));
        let id = session_id(&r);
        // The id is answered before the login starts: no event names an id the view does not have yet.
        assert!(f.log.lock().connects.is_empty());
        assert!(f.log.lock().states.is_empty());
        f.run_deferred().await;
        assert_eq!(f.log.lock().connects, vec![id.clone()]);
        assert!(is_sftp_session_id(&id));
        f.service.on_coordinator_session(&connected(&id));
        flush().await;
        let last = f.last_state();
        assert_eq!(
            (last["id"].as_str(), last["state"].as_str(), last["path"].as_str()),
            (Some(id.as_str()), Some("connected"), Some("/srv/www"))
        );
        let id2 = session_id(&f.service.connect(HOST, Some("/gone".into()), false));
        f.run_deferred().await;
        f.service.on_coordinator_session(&connected(&id2));
        flush().await;
        assert_eq!(f.last_state()["path"], json!("/home/alice"));
        assert_eq!(
            f.service.connect("00000000-0000-4000-8000-00000000ffff", None, false),
            json!({ "ok": false, "error": "hostMissing" })
        );
    }

    #[tokio::test]
    async fn disconnects_two_minutes_after_the_view_closed_only_once_the_queue_is_empty() {
        let f = setup_with(None);
        f.service.view_opened(None);
        let id = session_id(&f.service.connect(HOST, None, false));
        f.service.on_coordinator_session(&connected(&id));
        flush().await;
        assert!(f.timers.live().is_empty());
        f.service.on_queue(&id, true);
        f.service.view_closed();
        assert!(f.timers.live().is_empty()); // transfers run: it stays
        f.service.on_queue(&id, false);
        assert_eq!(f.timers.live(), vec![120_000]);
        f.service.view_opened(Some(id.clone()));
        assert!(f.timers.live().is_empty());
        f.service.view_closed();
        f.timers.fire(120_000);
        assert_eq!(f.log.lock().disconnects, vec![id.clone()]);
        assert!(f.log.lock().ended.contains(&id));
        assert!(f.service.ids().is_empty());
    }

    #[tokio::test]
    async fn counts_the_view_closed_when_the_renderer_reloads() {
        let f = setup_with(None);
        f.service.view_opened(None);
        let id = session_id(&f.service.connect(HOST, None, false));
        f.service.on_coordinator_session(&connected(&id));
        flush().await;
        assert!(f.timers.live().is_empty());
        f.service.renderer_gone("main");
        assert_eq!(f.timers.live(), vec![120_000]);
        // A second reload while hidden does not restart the timer.
        f.service.renderer_gone("main");
        assert_eq!(f.timers.live(), vec![120_000]);
        f.timers.fire(120_000);
        assert_eq!(f.log.lock().disconnects, vec![id]);
    }

    #[tokio::test]
    async fn forgets_a_failed_session_and_tells_the_renderer_when_the_host_restarted() {
        let f = setup_with(None);
        let id = session_id(&f.service.connect(HOST, None, false));
        f.service.on_coordinator_session(
            &json!({ "cellId": id, "hostId": HOST, "phase": "error", "since": 3, "error": "hostKeyChanged" }),
        );
        let last = f.last_state();
        assert_eq!((last["state"].as_str(), last["error"].as_str()), (Some("error"), Some("hostKeyChanged")));
        assert!(f.service.ids().is_empty());
        assert_eq!(f.service.op(Some(&id), SftpOp::List { path: "/".into() }).await, Err(SftpErrorCode::NoSession));
        f.service.connect(HOST, None, false);
        f.service.host_crashed();
        assert_eq!(f.log.lock().crashed, 1);
        assert!(f.service.ids().is_empty());
    }

    #[tokio::test]
    async fn pins_keep_plain_sessions_per_window_but_never_a_sudo_one() {
        let f = setup_with(None);
        let id = session_id(&f.service.connect(HOST, None, false));
        f.service.on_coordinator_session(&connected(&id));
        flush().await;
        assert_eq!(f.timers.live(), vec![120_000]);
        f.service.pin_hosts(vec![HOST.into()], "detached-1");
        assert!(f.timers.live().is_empty());
        f.service.renderer_gone("detached-1");
        assert_eq!(f.timers.live(), vec![120_000]);
    }

    #[tokio::test]
    async fn passes_login_messages_on_only_for_its_own_sessions() {
        let f = setup_with(None);
        let id = session_id(&f.service.connect(HOST, None, false));
        let status = |id: &str| HostMessage::Status {
            id: id.into(),
            phase: SshPhase::Error,
            error: Some(SshErrorCode::Reset),
            exit_code: None,
            banner: None,
        };
        f.service.on_host_ssh(status("00000000-0000-4000-8000-0000000000c1"));
        f.service.on_host_ssh(status("sftp:00000000-0000-4000-8000-0000000000c2"));
        f.service.on_host_ssh(HostMessage::Status {
            id: id.clone(),
            phase: SshPhase::Authenticating,
            error: None,
            exit_code: None,
            banner: None,
        });
        assert_eq!(f.log.lock().forwarded, vec![id]);
    }

    #[tokio::test]
    async fn a_login_refused_up_front_still_ends_with_an_error_event() {
        let f = setup_with(Some(SshErrorCode::HostMissing));
        let id = session_id(&f.service.connect(HOST, None, false));
        f.run_deferred().await;
        let last = f.last_state();
        assert_eq!(
            (last["id"].as_str(), last["state"].as_str(), last["error"].as_str()),
            (Some(id.as_str()), Some("error"), Some("hostMissing"))
        );
        assert!(f.service.ids().is_empty());
    }

    #[tokio::test]
    async fn the_state_keeps_the_ts_key_order() {
        let f = setup_with(None);
        let id = session_id(&f.service.connect(HOST, None, true));
        let snap = f.service.snapshot();
        let keys: Vec<&String> = snap["sessions"][0].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["id", "hostId", "state", "phase", "since", "plain"]);
        f.service.on_coordinator_session(&connected(&id));
        flush().await;
        let keys: Vec<String> = f.last_state().as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["id", "hostId", "state", "phase", "since", "plain", "path"]);
    }

    // ---------- the remote editor tabs (test/editor-source.test.ts, "SFTP sessions of remote editor tabs") ----------

    impl Setup {
        /// Connects a session of `host` and reports it connected (the `connect` helper of the TS test).
        async fn connect_to(&self, host: &str, plain: bool) -> String {
            let id = session_id(&self.service.connect(host, None, plain));
            self.run_deferred().await;
            self.service.on_coordinator_session(&json!({ "cellId": id, "hostId": host, "phase": "connected", "since": 2 }));
            flush().await;
            id
        }
    }

    #[tokio::test]
    async fn a_host_with_unsaved_remote_tabs_keeps_its_session_while_the_view_is_closed() {
        let f = setup_with(None);
        f.service.view_opened(None);
        let a = f.connect_to(HOST, false).await;
        let b = f.connect_to(OTHER, false).await;
        f.service.pin_hosts(vec![HOST.into()], "main");
        f.service.view_closed();
        assert_eq!(f.timers.live(), vec![120_000]);
        f.timers.fire(120_000);
        assert_eq!(f.log.lock().disconnects, vec![b]);
        assert_eq!(f.service.ids(), vec![a.clone()]);
        // Saved (no unsaved tab left): the idle disconnect comes back.
        f.service.pin_hosts(vec![], "main");
        assert_eq!(f.timers.live(), vec![120_000]);
        f.timers.fire(120_000);
        assert!(f.service.ids().is_empty());
    }

    #[tokio::test]
    async fn a_reloaded_renderer_reports_its_unsaved_tabs_again() {
        let f = setup_with(None);
        let a = f.connect_to(HOST, false).await;
        f.service.pin_hosts(vec![HOST.into()], "main");
        assert!(f.timers.live().is_empty());
        f.service.renderer_gone("main");
        assert_eq!(f.timers.live().len(), 1, "the pins are dropped until the new page reports them");
        f.service.pin_hosts(vec![HOST.into()], "main");
        assert!(f.timers.live().is_empty());
        assert_eq!(f.service.ids(), vec![a]);
    }

    #[tokio::test]
    async fn a_sudo_session_is_never_kept_by_a_pin() {
        let f = setup_full(None, &[HOST]);
        let root = f.connect_to(HOST, false).await;
        let plain = f.connect_to(HOST, true).await;
        f.service.pin_hosts(vec![HOST.into()], "main");
        assert_eq!(f.timers.live(), vec![120_000]);
        f.timers.fire(120_000);
        assert_eq!(f.log.lock().disconnects, vec![root]);
        assert_eq!(f.service.ids(), vec![plain]);
    }

    #[tokio::test]
    async fn while_the_view_is_open_only_the_session_it_shows_is_exempt_from_the_idle_disconnect() {
        let f = setup_with(None);
        let a = f.connect_to(HOST, false).await;
        let b = f.connect_to(OTHER, false).await;
        f.service.view_opened(Some(b.clone()));
        assert_eq!(f.timers.live(), vec![120_000]);
        f.timers.fire(120_000);
        assert_eq!(f.service.ids(), vec![b.clone()]);
        // The view switches to another session: the old one starts counting down.
        let c = f.connect_to(HOST, false).await;
        f.service.view_opened(Some(c.clone()));
        assert_eq!(f.timers.live(), vec![120_000]);
        f.timers.fire(120_000);
        assert_eq!(f.service.ids(), vec![c.clone()]);
        assert_ne!(a, c);
    }

    #[tokio::test]
    async fn sudo_is_decided_once_and_editor_sessions_are_marked_plain() {
        let f = setup_full(None, &[HOST]);
        let root = f.connect_to(HOST, false).await;
        let plain = f.connect_to(HOST, true).await;
        let other = f.connect_to(OTHER, false).await;
        assert_eq!(
            f.log.lock().logins,
            vec![
                (root.clone(), HOST.to_string(), true),
                (plain.clone(), HOST.to_string(), false),
                (other, OTHER.to_string(), false)
            ]
        );
        let last = |id: &str| f.log.lock().states.iter().rev().find(|s| s["id"] == json!(id)).cloned().unwrap();
        let r = last(&root);
        assert_eq!((r["state"].as_str(), r["sudo"].as_bool(), r.get("plain")), (Some("connected"), Some(true), None));
        let p = last(&plain);
        assert_eq!((p["state"].as_str(), p["plain"].as_bool(), p.get("sudo")), (Some("connected"), Some(true), None));
        let snapshot = f.service.snapshot();
        let in_snapshot = snapshot["sessions"].as_array().unwrap().iter().find(|s| s["id"] == json!(plain)).cloned().unwrap();
        assert_eq!(in_snapshot["plain"], json!(true));
    }

    #[tokio::test]
    async fn the_editor_channels_take_absolute_remote_paths_well_formed_saves_and_host_ids_only() {
        let f = setup_with(None);
        let id = f.connect_to(HOST, false).await;
        let sid = json!(id);
        let invalid = json!({ "ok": false, "error": "invalid" });
        let save = json!({ "text": "a", "baseline": "b", "encoding": "utf-8", "expected": { "size": 1, "mtimeMs": 2 } });
        assert_eq!(crate::ipc::read_file(&f.service, &sid, &json!("etc/x")).await, invalid);
        assert_eq!(crate::ipc::read_file(&f.service, &json!("nope"), &json!("/etc/x")).await, invalid);
        assert_eq!(crate::ipc::read_file(&f.service, &sid, &json!("/etc/x")).await["ok"], json!(true));
        let mut cp1250 = save.clone();
        cp1250["encoding"] = json!("cp1250");
        assert_eq!(crate::ipc::write_file(&f.service, &sid, &json!("/etc/x"), &cp1250).await, invalid);
        assert_eq!(crate::ipc::write_file(&f.service, &sid, &json!("C:\\x"), &save).await, invalid);
        let mut extra = save.clone();
        extra["extra"] = json!("dropped");
        assert_eq!(crate::ipc::write_file(&f.service, &sid, &json!("/etc/x"), &extra).await["ok"], json!(true));
        assert_eq!(f.log.lock().requests.last().cloned(), Some((id, "writeFile".to_string())));
        assert_eq!(crate::ipc::editor_save(&extra), crate::ipc::editor_save(&save), "unknown keys are dropped");
        // A pin list that is not host ids is ignored.
        crate::ipc::pin_hosts(&f.service, &json!(["not-a-uuid"]), "main");
        f.service.view_closed();
        assert_eq!(f.timers.live().len(), 1);
    }
}
