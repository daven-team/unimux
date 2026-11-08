//! The SFTP host (port of the session half of 1.1.4 src/sftphost/host.ts and the supervision of src/main/sftpHostClient.ts),
//! now inside the app process: one russh connection and SFTP channel per `sftp:` session, logged in through S3's
//! [`LoginRegistry`] (host key and auth questions go to the coordinator like a cell's), the operations of the view brokered
//! to the [`SftpBackend`], and the transfer port (`mc:sftp-port`) with its [`ItemThrottle`].
//!
//! What runs on a connected session is the backend's: T2 (the SFTP client on the channel, local side), T3 (queues), T4
//! (manage ops, editor files) and T5 (SFTP through sudo on an exec channel) plug in there. [`UnportedBackend`] answers
//! until then.
//!
//! Supervision: every operation runs in its own task; a panic there counts as a crash of 1.1.4's SFTP Host process (every
//! session and queue ends, pending requests answer `sftpHostCrashed`, the renderer hears `sftp:hostCrashed`); more than 5
//! crashes within a minute and no SFTP session starts again until the app restarts.

use std::any::Any;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::{oneshot, watch};
use tokio_util::sync::CancellationToken;
use unimux_ipc::ports::{PortOwner, PortSink};
use unimux_ssh::coordinator::SshHostLink;
use unimux_ssh::host::{LoginRegistry, MessageSink};
use unimux_ssh::login::{LOGIN_TIMERS, LoginHandle, LoginTimers};
use unimux_ssh::protocol::{AuthPromptInfo, AuthPromptKind, ConnectRequest, HostCommand, HostMessage, SftpSudo};
use unimux_ssh::session::{SshErrorCode, SshPhase};
use zeroize::Zeroizing;

use crate::error::{SftpErrorCode, SftpResult};
use crate::limits::{LOCAL_QUEUE_ID, PROGRESS_INTERVAL_MS, SFTP_TIMERS, SftpTimers};
use crate::op::{SftpOp, op_timeout};
use crate::service::SftpHostLink;
use crate::throttle::{ItemThrottle, Now};
use crate::timers::Timers;

/// A byte stream an SFTP client runs on: the `sftp` subsystem channel, or (T5) the stdin / stdout of a sudo'ed server.
pub trait AsyncReadWrite: AsyncRead + AsyncWrite + Send + Unpin {}
impl<T: AsyncRead + AsyncWrite + Send + Unpin> AsyncReadWrite for T {}
pub type SftpStream = Box<dyn AsyncReadWrite>;

/// The SFTP client of one connected session (T2's RemoteSide).
pub trait RemoteSession: Send + Sync {
    /// Resolves when the SFTP channel closed or failed (the session then ends with `reset`).
    fn closed(&self) -> BoxFuture<'static, ()>;
    /// The session ends: everything of it stops at once.
    fn kill(&self);
    /// For the backend that made it.
    fn as_any(&self) -> &dyn Any;
}

/// The sudo password question of a session (1.1.4 `askSudo`): `retry` after a wrong one; None when cancelled, timed out
/// or the session ended. The prompt goes to the coordinator, which asks the view.
pub type SudoAsk = Arc<dyn Fn(bool) -> BoxFuture<'static, Option<Zeroizing<String>>> + Send + Sync>;

/// What T5 needs to start the SFTP server through sudo on an exec channel.
pub struct SudoStart {
    pub id: String,
    pub handle: Arc<LoginHandle>,
    /// The host's own server command (`sftpCommand`), else the defaults.
    pub command: Option<String>,
    pub timers: SftpTimers,
    pub ask: SudoAsk,
    /// False once the session ended (the start then stops).
    pub live: Arc<dyn Fn() -> bool + Send + Sync>,
}

/// Everything that runs on a connected session, and the queues (T2-T5).
pub trait SftpBackend: Send + Sync {
    /// The SFTP client on an opened subsystem channel (T2). Err: the code the session ends with.
    fn attach(&self, id: &str, stream: SftpStream) -> BoxFuture<'static, Result<Arc<dyn RemoteSession>, SshErrorCode>>;
    /// The SFTP server through sudo (T5).
    fn start_sudo(&self, start: SudoStart) -> BoxFuture<'static, Result<Arc<dyn RemoteSession>, SshErrorCode>>;
    /// One operation. `remote` is the connected session (None for the local queue, or for a queue operation of a session
    /// that is not connected yet, and for `cancelOp`); `sudo`: the session runs through sudo.
    fn op(&self, id: &str, remote: Option<Arc<dyn RemoteSession>>, sudo: bool, op: SftpOp) -> BoxFuture<'static, SftpResult>;
    /// The queue of `id` stops (`cancelled` when the user disconnected, `connectionLost` otherwise); the future resolves
    /// once its aborted files cleaned up, at most after `idle`.
    fn end_queue(&self, id: &str, reason: SftpErrorCode, idle: Duration) -> BoxFuture<'static, ()>;
    /// Every item the queues know (the snapshot a newly attached window gets).
    fn items(&self) -> Vec<Value>;
    /// The host crashed: every queue is gone.
    fn reset(&self);
}

/// Where the host's messages go (the SFTP service): login messages, queue activity, a crash.
pub trait HostOut: Send + Sync {
    fn ssh(&self, m: HostMessage);
    fn queue(&self, id: &str, active: bool);
    fn crashed(&self, detail: &str);
}

/// The handle a backend reports through: item updates (throttled), removed items, op progress, queue activity.
#[derive(Clone)]
pub struct HostChannels {
    host: Weak<SftpHost>,
}

impl HostChannels {
    /// Channels of no host: every report goes nowhere (tests of the manage ops).
    pub fn unattached() -> HostChannels {
        HostChannels { host: Weak::new() }
    }
    /// A changed transfer item (the full object); `force`: a state change (sent on the next turn).
    pub fn item_changed(&self, item: Value, force: bool) {
        if let Some(h) = self.host.upgrade() {
            h.throttle.push(item, force);
        }
    }
    pub fn items_removed(&self, ids: Vec<String>) {
        if let Some(h) = self.host.upgrade() {
            h.throttle.forget(&ids);
            h.to_renderer(&json!({ "t": "removed", "ids": ids }));
        }
    }
    /// Progress of a long operation the view started with an op id (a recursive permission change).
    pub fn op_progress(&self, op_id: &str, done: u64, total: u64) {
        if let Some(h) = self.host.upgrade() {
            h.to_renderer(&json!({ "t": "opProgress", "opId": op_id, "done": done, "total": total.max(done) }));
        }
    }
    /// The queue of `id` has (or no longer has) anything queued, running or waiting for a conflict answer.
    pub fn queue_active(&self, id: &str, active: bool) {
        if let Some(h) = self.host.upgrade()
            && let Some(out) = h.out()
        {
            out.queue(id, active);
        }
    }
}

pub type Runtime = tokio::runtime::Handle;

pub struct HostDeps {
    pub runtime: Runtime,
    pub timers: Arc<dyn Timers>,
    pub now: Now,
    pub sftp_timers: SftpTimers,
    pub login_timers: LoginTimers,
    /// Writes a line to crash.log (a crash of the host).
    pub log: Arc<dyn Fn(&str) + Send + Sync>,
}

impl HostDeps {
    pub fn new(runtime: Runtime, timers: Arc<dyn Timers>) -> HostDeps {
        HostDeps {
            runtime,
            timers,
            now: Arc::new(unimux_core::time::now_ms),
            sftp_timers: SFTP_TIMERS,
            login_timers: LOGIN_TIMERS,
            log: Arc::new(|_| {}),
        }
    }
}

#[derive(Default)]
struct SessionState {
    phase: Option<SshPhase>,
    error: Option<SshErrorCode>,
    /// The user (or the idle timer) disconnected: the end reads "closed", not an error.
    disconnected: bool,
    ended: bool,
    remote: Option<Arc<dyn RemoteSession>>,
    /// The open sudo password question.
    sudo_ask: Option<(String, oneshot::Sender<Option<Zeroizing<String>>>)>,
    task: Option<tokio::task::AbortHandle>,
}

struct Session {
    id: String,
    sudo: Option<SftpSudo>,
    stop: CancellationToken,
    ended: watch::Sender<bool>,
    st: Mutex<SessionState>,
}

/// More than this many crashes within [`CRASH_WINDOW_MS`]: the host stays down.
const MAX_CRASHES: usize = 5;
const CRASH_WINDOW_MS: i64 = 60_000;

pub struct SftpHost {
    me: Weak<SftpHost>,
    deps: HostDeps,
    logins: Arc<LoginRegistry>,
    backend: RwLock<Arc<dyn SftpBackend>>,
    out: RwLock<Option<Arc<dyn HostOut>>>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    renderers: Mutex<HashMap<String, Arc<dyn PortSink>>>,
    throttle: Arc<ItemThrottle>,
    pending: Mutex<HashMap<u64, oneshot::Sender<SftpResult>>>,
    next_req: AtomicU64,
    crashes: Mutex<Vec<i64>>,
    fatal: AtomicBool,
    shutting_down: AtomicBool,
}

impl std::fmt::Debug for SftpHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SftpHost").field("sessions", &self.sessions.lock().len()).finish()
    }
}

fn status(id: &str, phase: SshPhase, error: Option<SshErrorCode>) -> HostMessage {
    HostMessage::Status { id: id.to_string(), phase, error, exit_code: None, banner: None }
}

/// The `sftp` subsystem on the login's connection: a session channel the server refuses, or a refused subsystem, is
/// `sftpDenied` (1.1.4: a server without the subsystem ends the session with that code).
pub(crate) async fn open_sftp_subsystem(handle: &LoginHandle) -> Result<russh::Channel<russh::client::Msg>, SshErrorCode> {
    let mut channel = handle.channel_open_session().await.map_err(|_| SshErrorCode::SftpDenied)?;
    channel.request_subsystem(true, "sftp").await.map_err(|_| SshErrorCode::SftpDenied)?;
    loop {
        match channel.wait().await {
            Some(russh::ChannelMsg::Success) => break,
            Some(russh::ChannelMsg::Failure) | None => return Err(SshErrorCode::SftpDenied),
            Some(_) => {}
        }
    }
    Ok(channel)
}

impl SftpHost {
    /// `backend`: made with the host's [`HostChannels`] (T2-T5 report through them).
    pub fn new(deps: HostDeps, backend: impl FnOnce(HostChannels) -> Arc<dyn SftpBackend>) -> Arc<SftpHost> {
        let host = Arc::new_cyclic(|me: &Weak<SftpHost>| {
            let w = me.clone();
            let throttle = ItemThrottle::new(
                Box::new(move |items| {
                    if let Some(h) = w.upgrade() {
                        h.to_renderer(&json!({ "t": "items", "items": items }));
                    }
                }),
                PROGRESS_INTERVAL_MS,
                deps.now.clone(),
                deps.timers.clone(),
            );
            SftpHost {
                me: me.clone(),
                deps,
                logins: LoginRegistry::new(),
                backend: RwLock::new(Arc::new(UnportedBackend) as Arc<dyn SftpBackend>),
                out: RwLock::new(None),
                sessions: Mutex::new(HashMap::new()),
                renderers: Mutex::new(HashMap::new()),
                throttle,
                pending: Mutex::new(HashMap::new()),
                next_req: AtomicU64::new(1),
                crashes: Mutex::new(Vec::new()),
                fatal: AtomicBool::new(false),
                shutting_down: AtomicBool::new(false),
            }
        });
        *host.backend.write() = backend(host.channels());
        host
    }

    pub fn channels(&self) -> HostChannels {
        HostChannels { host: self.me.clone() }
    }

    /// Where login messages, queue activity and crashes go (the service, set once it exists).
    pub fn set_out(&self, out: Arc<dyn HostOut>) {
        *self.out.write() = Some(out);
    }

    fn out(&self) -> Option<Arc<dyn HostOut>> {
        self.out.read().clone()
    }

    fn backend(&self) -> Arc<dyn SftpBackend> {
        self.backend.read().clone()
    }

    fn send_ssh(&self, m: HostMessage) {
        if let Some(out) = self.out() {
            out.ssh(m);
        }
    }

    fn to_renderer(&self, m: &Value) {
        let sinks: Vec<Arc<dyn PortSink>> = self.renderers.lock().values().cloned().collect();
        for sink in sinks {
            // A window that is reloading misses it; its next attach gets a snapshot.
            let _ = sink.post_json(m);
        }
    }

    /// Every item the host knows (pending throttled updates go out first).
    pub fn items(&self) -> Vec<Value> {
        self.throttle.flush();
        self.backend().items()
    }

    // ── sessions ──────────────────────────────────────────────────────────────

    fn live(&self, s: &Arc<Session>) -> bool {
        !s.st.lock().ended && self.sessions.lock().get(&s.id).is_some_and(|c| Arc::ptr_eq(c, s))
    }

    fn status(&self, s: &Session, phase: SshPhase, error: Option<SshErrorCode>) {
        s.st.lock().phase = Some(phase);
        self.send_ssh(status(&s.id, phase, error));
    }

    /// Main's commands for SFTP logins (the coordinator's `sftp` owner slot). False when the host may not run.
    pub fn command(&self, cmd: HostCommand) -> bool {
        if !self.ensure() {
            return false;
        }
        match cmd {
            HostCommand::Connect(req) => self.connect(*req),
            HostCommand::HostKeyAnswer { .. } => {
                if self.session(cmd.id()).is_some() {
                    self.logins.answer(cmd);
                }
            }
            HostCommand::AuthAnswer { ref id, ref prompt_id, ref values } => {
                let Some(s) = self.session(id) else { return true };
                let ask = {
                    let mut st = s.st.lock();
                    if st.sudo_ask.as_ref().is_some_and(|(p, _)| p == prompt_id) { st.sudo_ask.take() } else { None }
                };
                match ask {
                    Some((_, tx)) => {
                        let _ = tx.send(values.as_ref().and_then(|v| v.first().cloned()));
                    }
                    None => {
                        self.logins.answer(cmd);
                    }
                }
            }
        }
        true
    }

    fn session(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().get(id).filter(|s| !s.st.lock().ended).cloned()
    }

    fn connect(&self, mut req: ConnectRequest) {
        let id = req.id.clone();
        if let Some(old) = self.sessions.lock().get(&id).cloned()
            && let Some(me) = self.me.upgrade()
        {
            self.deps.runtime.spawn(async move { me.disconnect_session(&old, default_waits(&me.deps.sftp_timers)).await });
        }
        let s = Arc::new(Session {
            id: id.clone(),
            sudo: req.sftp_sudo.take(),
            stop: CancellationToken::new(),
            ended: watch::channel(false).0,
            st: Mutex::new(SessionState::default()),
        });
        self.sessions.lock().insert(id, s.clone());
        self.status(&s, SshPhase::Connecting, None);
        let Some(me) = self.me.upgrade() else { return };
        let session = s.clone();
        let task = self.deps.runtime.spawn(async move { me.run_session(session, req).await });
        s.st.lock().task = Some(task.abort_handle());
        // A panic of a session task is a crash of the host (1.1.4: the process died).
        let me = self.me.clone();
        self.deps.runtime.spawn(async move {
            if let Err(e) = task.await
                && e.is_panic()
                && let Some(h) = me.upgrade()
            {
                h.crash("sftp session panicked");
            }
        });
    }

    async fn run_session(self: Arc<Self>, s: Arc<Session>, mut req: ConnectRequest) {
        let login = req.take_login();
        drop(req);
        let w = self.me.clone();
        let sink: MessageSink = Arc::new(move |m| {
            if let Some(h) = w.upgrade() {
                h.send_ssh(m);
            }
        });
        let logged_in = tokio::select! {
            biased;
            _ = s.stop.cancelled() => Err(SshErrorCode::Cancelled),
            r = self.logins.login(&s.id, login, self.deps.login_timers, sink) => r,
        };
        let handle = match logged_in {
            Ok(h) => Arc::new(h),
            Err(code) => {
                self.fail(&s, code);
                self.on_close(&s);
                return;
            }
        };
        if !self.live(&s) || s.stop.is_cancelled() {
            self.close_connection(&handle).await;
            self.on_close(&s);
            return;
        }
        let started = tokio::select! {
            biased;
            _ = s.stop.cancelled() => None,
            r = self.start_sftp(&s, &handle) => Some(r),
        };
        match started {
            Some(Ok(remote)) if self.live(&s) => {
                s.st.lock().remote = Some(remote.clone());
                self.status(&s, SshPhase::Connected, None);
                let closed = remote.closed();
                let gone = async {
                    while !handle.is_closed() {
                        tokio::time::sleep(Duration::from_secs(1)).await;
                    }
                };
                tokio::select! {
                    biased;
                    _ = s.stop.cancelled() => {}
                    _ = closed => self.fail(&s, SshErrorCode::Reset),
                    _ = gone => self.fail(&s, SshErrorCode::Reset),
                }
            }
            Some(Ok(remote)) => remote.kill(),
            Some(Err(code)) => self.fail(&s, code),
            None => {}
        }
        self.close_connection(&handle).await;
        self.on_close(&s);
    }

    /// The `sftp` subsystem (within the SFTP timer: `timeout`; refused: `sftpDenied`), or the server through sudo.
    async fn start_sftp(&self, s: &Arc<Session>, handle: &Arc<LoginHandle>) -> Result<Arc<dyn RemoteSession>, SshErrorCode> {
        if let Some(sudo) = &s.sudo {
            let (w, ws) = (self.me.clone(), Arc::downgrade(s));
            let ask: SudoAsk = Arc::new(move |retry| {
                let (w, ws) = (w.clone(), ws.clone());
                Box::pin(async move {
                    let (Some(h), Some(s)) = (w.upgrade(), ws.upgrade()) else { return None };
                    h.ask_sudo(&s, retry).await
                })
            });
            let (w, ws) = (self.me.clone(), Arc::downgrade(s));
            let live: Arc<dyn Fn() -> bool + Send + Sync> = Arc::new(move || match (w.upgrade(), ws.upgrade()) {
                (Some(h), Some(s)) => h.live(&s),
                _ => false,
            });
            let start = SudoStart {
                id: s.id.clone(),
                handle: handle.clone(),
                command: sudo.command.clone(),
                timers: self.deps.sftp_timers,
                ask,
                live,
            };
            return self.backend().start_sudo(start).await;
        }
        let channel = match tokio::time::timeout(self.deps.sftp_timers.sftp, open_sftp_subsystem(handle)).await {
            Ok(r) => r?,
            Err(_) => return Err(SshErrorCode::Timeout),
        };
        let stream: SftpStream = Box::new(channel.into_stream());
        self.backend().attach(&s.id, stream).await
    }

    /// `askSudo`: the sudo password question (the coordinator asks the view; a cancel or its timeout answers None).
    async fn ask_sudo(&self, s: &Arc<Session>, retry: bool) -> Option<Zeroizing<String>> {
        if !self.live(s) {
            return None;
        }
        let prompt_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        s.st.lock().sudo_ask = Some((prompt_id.clone(), tx));
        let prompt = AuthPromptInfo { kind: AuthPromptKind::Sudo, name: None, instructions: None, fields: vec![], retry };
        self.send_ssh(HostMessage::AuthPrompt { id: s.id.clone(), prompt_id, prompt });
        tokio::select! {
            biased;
            _ = s.stop.cancelled() => None,
            r = rx => r.ok().flatten(),
        }
    }

    async fn close_connection(&self, handle: &Arc<LoginHandle>) {
        let _ =
            tokio::time::timeout(self.deps.sftp_timers.kill_grace, handle.disconnect(russh::Disconnect::ByApplication, "", "en"))
                .await;
    }

    /// `fail(s, error)`: the first reason wins (none after a disconnect); the session's task then closes the connection.
    fn fail(&self, s: &Arc<Session>, error: SshErrorCode) {
        if !self.live(s) {
            return;
        }
        let (ask, remote) = {
            let mut st = s.st.lock();
            if st.error.is_none() && !st.disconnected {
                st.error = Some(error);
            }
            (st.sudo_ask.take(), st.remote.clone())
        };
        if let Some((_, tx)) = ask {
            let _ = tx.send(None);
        }
        if let Some(r) = remote {
            r.kill();
        }
        self.logins.abort(&s.id);
        s.stop.cancel();
    }

    /// `onClose(s)`: the queue ends, the session is forgotten and main hears `closed` or the error.
    fn on_close(&self, s: &Arc<Session>) {
        let (remote, disconnected, error) = {
            let mut st = s.st.lock();
            if st.ended {
                return;
            }
            st.ended = true;
            (st.remote.take(), st.disconnected, st.error)
        };
        s.stop.cancel();
        if let Some(r) = remote {
            r.kill();
        }
        self.logins.abort(&s.id);
        let reason = if disconnected { SftpErrorCode::Cancelled } else { SftpErrorCode::ConnectionLost };
        self.deps.runtime.spawn(self.backend().end_queue(&s.id, reason, Duration::ZERO));
        let _ = s.ended.send(true);
        let mine = {
            let mut sessions = self.sessions.lock();
            let mine = sessions.get(&s.id).is_some_and(|c| Arc::ptr_eq(c, s));
            if mine {
                sessions.remove(&s.id);
            }
            mine
        };
        if !mine {
            return;
        }
        if disconnected {
            self.status(s, SshPhase::Closed, None);
        } else {
            self.status(s, SshPhase::Error, Some(error.unwrap_or(SshErrorCode::Reset)));
        }
    }

    /// `disconnect(id, waits)`: the queue is cancelled and its aborted files clean up over the open connection first
    /// (at most `idle`), then the connection closes (a hard close after `grace`).
    async fn disconnect_session(&self, s: &Arc<Session>, waits: (Duration, Duration)) {
        let (idle, grace) = waits;
        {
            let mut st = s.st.lock();
            if st.ended {
                return;
            }
            st.disconnected = true;
        }
        let _ = tokio::time::timeout(
            idle + Duration::from_millis(100),
            self.backend().end_queue(&s.id, SftpErrorCode::Cancelled, idle),
        )
        .await;
        if s.st.lock().ended {
            return;
        }
        let ask = s.st.lock().sudo_ask.take();
        if let Some((_, tx)) = ask {
            let _ = tx.send(None);
        }
        self.logins.abort(&s.id);
        s.stop.cancel();
        let mut ended = s.ended.subscribe();
        let wait = async {
            while !*ended.borrow_and_update() {
                if ended.changed().await.is_err() {
                    break;
                }
            }
        };
        if tokio::time::timeout(grace + Duration::from_millis(200), wait).await.is_err() {
            let task = s.st.lock().task.take();
            if let Some(t) = task {
                t.abort();
            }
            self.on_close(s);
        }
    }

    /// `sftpDisconnect` of the service: runs in the background.
    pub fn disconnect(&self, id: &str) {
        let Some(s) = self.sessions.lock().get(id).cloned() else { return };
        let Some(me) = self.me.upgrade() else { return };
        let waits = default_waits(&self.deps.sftp_timers);
        self.deps.runtime.spawn(async move { me.disconnect_session(&s, waits).await });
    }

    /// App quit: at most about 2 s in all (the app waits [`crate::limits::SHUTDOWN_WAIT`] for it). Aborted local copies
    /// remove their part files next to the sessions.
    pub async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        let sessions: Vec<Arc<Session>> = self.sessions.lock().values().cloned().collect();
        let waits = (Duration::from_millis(1000), Duration::from_millis(800));
        let local = self.backend().end_queue(LOCAL_QUEUE_ID, SftpErrorCode::Cancelled, Duration::from_millis(1000));
        let all = sessions.iter().map(|s| self.disconnect_session(s, waits));
        futures::future::join(futures::future::join_all(all), local).await;
        self.throttle.flush();
        self.fail_pending();
    }

    /// The quit's hard limit: every session task stops now.
    pub fn force_kill(&self) {
        self.shutting_down.store(true, Ordering::SeqCst);
        for s in self.sessions.lock().values() {
            s.stop.cancel();
            if let Some(t) = s.st.lock().task.take() {
                t.abort();
            }
        }
    }

    fn fail_pending(&self) {
        let pending: Vec<oneshot::Sender<SftpResult>> = self.pending.lock().drain().map(|(_, tx)| tx).collect();
        for tx in pending {
            let _ = tx.send(Err(SftpErrorCode::SftpHostCrashed));
        }
    }

    /// A crash (1.1.4: the SFTP Host process exited): pending requests fail, every session and queue is gone, the service
    /// hears it. More than 5 within a minute: the host stays down.
    pub fn crash(&self, detail: &str) {
        (self.deps.log)(&format!("sftp host crashed: {detail}"));
        // While the app quits a crash is neither counted nor reported (1.1.4's exit handler returned early).
        if self.shutting_down.load(Ordering::SeqCst) {
            self.fail_pending();
            return;
        }
        let now = (self.deps.now)();
        {
            let mut crashes = self.crashes.lock();
            crashes.retain(|t| now - t < CRASH_WINDOW_MS);
            crashes.push(now);
            if crashes.len() > MAX_CRASHES {
                self.fatal.store(true, Ordering::SeqCst);
            }
        }
        self.fail_pending();
        let sessions: Vec<Arc<Session>> = self.sessions.lock().drain().map(|(_, s)| s).collect();
        for s in sessions {
            let (remote, task) = {
                let mut st = s.st.lock();
                st.ended = true;
                (st.remote.take(), st.task.take())
            };
            s.stop.cancel();
            if let Some(r) = remote {
                r.kill();
            }
            if let Some(t) = task {
                t.abort();
            }
            self.logins.abort(&s.id);
            let _ = s.ended.send(true);
        }
        self.backend().reset();
        self.throttle.dispose();
        if let Some(out) = self.out() {
            out.crashed(detail);
        }
    }

    // ── operations ────────────────────────────────────────────────────────────

    async fn run_op(self: Arc<Self>, id: String, op: SftpOp) -> SftpResult {
        let backend = self.backend();
        if op.is_queue_op() {
            // The queue operations also work for the local copy queue and before the session connected.
            let session = if id == LOCAL_QUEUE_ID { None } else { Some(self.session(&id).ok_or(SftpErrorCode::NoSession)?) };
            if let SftpOp::Enqueue { req } = &op
                && (id == LOCAL_QUEUE_ID) != req.direction.is_local()
            {
                return Err(SftpErrorCode::Invalid);
            }
            let (remote, sudo) = match &session {
                Some(s) => {
                    let st = s.st.lock();
                    (st.remote.clone().filter(|_| st.phase == Some(SshPhase::Connected)), s.sudo.is_some())
                }
                None => (None, false),
            };
            return backend.op(&id, remote, sudo, op).await;
        }
        if matches!(op, SftpOp::CancelOp { .. }) {
            return backend.op(&id, None, false, op).await;
        }
        let s = self.session(&id).ok_or(SftpErrorCode::NoSession)?;
        let remote = {
            let st = s.st.lock();
            st.remote.clone().filter(|_| st.phase == Some(SshPhase::Connected))
        };
        let remote = remote.ok_or(SftpErrorCode::NotConnected)?;
        backend.op(&id, Some(remote), s.sudo.is_some(), op).await
    }

    /// One operation (1.1.4 `request`): its own task (a panic is a crash), answered `failed` after `opTimeoutMs`.
    pub fn request_op(&self, id: &str, op: SftpOp) -> BoxFuture<'static, SftpResult> {
        let Some(me) = self.me.upgrade() else { return Box::pin(async { Err(SftpErrorCode::NoSession) }) };
        if !self.ensure() {
            return Box::pin(async { Err(SftpErrorCode::NoSession) });
        }
        let limit = op_timeout(&op);
        let req = self.next_req.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().insert(req, tx);
        let task = self.deps.runtime.spawn(me.clone().run_op(id.to_string(), op));
        let w = self.me.clone();
        self.deps.runtime.spawn(async move {
            let result = match task.await {
                Ok(r) => r,
                Err(e) => {
                    if e.is_panic()
                        && let Some(h) = w.upgrade()
                    {
                        h.crash("sftp operation panicked");
                    }
                    Err(SftpErrorCode::SftpHostCrashed)
                }
            };
            let tx = w.upgrade().and_then(|h| h.pending.lock().remove(&req));
            if let Some(tx) = tx {
                let _ = tx.send(result);
            }
        });
        Box::pin(async move {
            let answer = async { rx.await.unwrap_or(Err(SftpErrorCode::SftpHostCrashed)) };
            match limit {
                Some(limit) => match tokio::time::timeout(limit, answer).await {
                    Ok(r) => r,
                    Err(_) => {
                        me.pending.lock().remove(&req);
                        Err(SftpErrorCode::Failed)
                    }
                },
                None => answer.await,
            }
        })
    }

    /// The host may run: not crashed too often, not quitting.
    pub fn ensure(&self) -> bool {
        !self.fatal.load(Ordering::SeqCst) && !self.shutting_down.load(Ordering::SeqCst)
    }

    /// The session ids the host runs (tests, diagnostics).
    pub fn session_ids(&self) -> Vec<String> {
        self.sessions.lock().keys().cloned().collect()
    }
}

/// 1.1.4's default disconnect waits: 1.5 s for the queue's cleanup, then the kill grace.
fn default_waits(t: &SftpTimers) -> (Duration, Duration) {
    (Duration::from_millis(1500), t.kill_grace)
}

impl SftpHostLink for SftpHost {
    fn ensure(&self) -> bool {
        SftpHost::ensure(self)
    }
    fn disconnect(&self, id: &str) {
        SftpHost::disconnect(self, id);
    }
    fn request(&self, id: &str, op: SftpOp) -> BoxFuture<'static, SftpResult> {
        self.request_op(id, op)
    }
}

impl SshHostLink for SftpHost {
    fn send(&self, cmd: HostCommand) -> bool {
        self.command(cmd)
    }
}

/// The transfer port (`mc:sftp-port`): every window hears the whole queue (an editor tab in any window follows a move the
/// queue finished); a window that attaches (again) gets a snapshot first.
impl PortOwner for SftpHost {
    fn attach(&self, label: &str, sink: Arc<dyn PortSink>) {
        let snapshot = json!({ "t": "snapshot", "items": self.items() });
        if let Some(old) = self.renderers.lock().insert(label.to_string(), sink.clone()) {
            old.close();
        }
        let _ = sink.post_json(&snapshot);
    }
    fn post(&self, _label: &str, _message: Value) {
        // The SFTP port carries host -> renderer messages only.
    }
    fn detach(&self, label: &str) {
        self.renderers.lock().remove(label);
    }
}

/// The backend until T2-T5 land: a connected session holds its SFTP channel open, every operation answers `unsupported`
/// (the queue operations answer what an empty queue answers), sudo sessions end with `sudoFailed`.
pub struct UnportedBackend;

struct HeldStream {
    stream: Mutex<Option<SftpStream>>,
}

impl RemoteSession for HeldStream {
    fn closed(&self) -> BoxFuture<'static, ()> {
        Box::pin(futures::future::pending())
    }
    fn kill(&self) {
        self.stream.lock().take();
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

impl SftpBackend for UnportedBackend {
    fn attach(&self, _id: &str, stream: SftpStream) -> BoxFuture<'static, Result<Arc<dyn RemoteSession>, SshErrorCode>> {
        let session: Arc<dyn RemoteSession> = Arc::new(HeldStream { stream: Mutex::new(Some(stream)) });
        Box::pin(async move { Ok(session) })
    }
    fn start_sudo(&self, _start: SudoStart) -> BoxFuture<'static, Result<Arc<dyn RemoteSession>, SshErrorCode>> {
        Box::pin(async { Err(SshErrorCode::SudoFailed) })
    }
    fn op(&self, _id: &str, _remote: Option<Arc<dyn RemoteSession>>, _sudo: bool, op: SftpOp) -> BoxFuture<'static, SftpResult> {
        let r = match op {
            SftpOp::Cancel { .. } | SftpOp::AnswerConflict { .. } | SftpOp::Retry { .. } | SftpOp::CancelOp { .. } => {
                Ok(json!(false))
            }
            SftpOp::ClearFinished => Ok(json!(0)),
            _ => Err(SftpErrorCode::Unsupported),
        };
        Box::pin(async move { r })
    }
    fn end_queue(&self, _id: &str, _reason: SftpErrorCode, _idle: Duration) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }
    fn items(&self) -> Vec<Value> {
        Vec::new()
    }
    fn reset(&self) {}
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::TransferDirection;
    use crate::op::TransferRequest;
    use crate::timers::ManualTimers;

    struct Out(Mutex<Vec<String>>);

    impl HostOut for Out {
        fn ssh(&self, m: HostMessage) {
            self.0.lock().push(format!("ssh {}", m.id()));
        }
        fn queue(&self, id: &str, active: bool) {
            self.0.lock().push(format!("queue {id} {active}"));
        }
        fn crashed(&self, _detail: &str) {
            self.0.lock().push("crashed".into());
        }
    }

    struct Sink(Mutex<Vec<Value>>);

    impl PortSink for Sink {
        fn post_json(&self, m: &Value) -> bool {
            self.0.lock().push(m.clone());
            true
        }
        fn post_bytes(&self, _: &[u8]) -> bool {
            true
        }
    }

    struct Panicking;

    impl SftpBackend for Panicking {
        fn attach(&self, _: &str, _: SftpStream) -> BoxFuture<'static, Result<Arc<dyn RemoteSession>, SshErrorCode>> {
            Box::pin(async { Err(SshErrorCode::SftpDenied) })
        }
        fn start_sudo(&self, _: SudoStart) -> BoxFuture<'static, Result<Arc<dyn RemoteSession>, SshErrorCode>> {
            Box::pin(async { Err(SshErrorCode::SudoFailed) })
        }
        fn op(&self, _: &str, _: Option<Arc<dyn RemoteSession>>, _: bool, op: SftpOp) -> BoxFuture<'static, SftpResult> {
            Box::pin(async move {
                if matches!(op, SftpOp::ClearFinished) {
                    panic!("boom");
                }
                Ok(json!(true))
            })
        }
        fn end_queue(&self, _: &str, _: SftpErrorCode, _: Duration) -> BoxFuture<'static, ()> {
            Box::pin(async {})
        }
        fn items(&self) -> Vec<Value> {
            vec![json!({ "id": "x" })]
        }
        fn reset(&self) {}
    }

    fn host(backend: Arc<dyn SftpBackend>) -> (Arc<SftpHost>, Arc<Out>) {
        let deps = HostDeps::new(tokio::runtime::Handle::current(), Arc::new(ManualTimers::default()));
        let host = SftpHost::new(deps, move |_| backend);
        let out = Arc::new(Out(Mutex::new(Vec::new())));
        host.set_out(out.clone());
        (host, out)
    }

    #[tokio::test]
    async fn queue_and_remote_operations_check_the_session_like_the_host() {
        let (h, _) = host(Arc::new(UnportedBackend));
        let local = std::env::temp_dir().to_string_lossy().into_owned();
        let req = TransferRequest {
            direction: TransferDirection::Upload,
            sources: vec![local],
            target_dir: "/x".into(),
            policy: None,
            batch_id: None,
        };
        assert_eq!(h.request_op(LOCAL_QUEUE_ID, SftpOp::Enqueue { req }).await, Err(SftpErrorCode::Invalid));
        assert_eq!(h.request_op(LOCAL_QUEUE_ID, SftpOp::ClearFinished).await, Ok(json!(0)));
        let id = "sftp:00000000-0000-4000-8000-000000000001";
        assert_eq!(h.request_op(id, SftpOp::ClearFinished).await, Err(SftpErrorCode::NoSession));
        assert_eq!(h.request_op(id, SftpOp::List { path: "/".into() }).await, Err(SftpErrorCode::NoSession));
        assert_eq!(h.request_op(id, SftpOp::CancelOp { op_id: "x".into() }).await, Ok(json!(false)));
    }

    #[tokio::test]
    async fn a_panicking_operation_is_a_crash_and_six_in_a_minute_keep_the_host_down() {
        let (h, out) = host(Arc::new(Panicking));
        for n in 1..=6 {
            assert_eq!(h.request_op(LOCAL_QUEUE_ID, SftpOp::ClearFinished).await, Err(SftpErrorCode::SftpHostCrashed));
            assert_eq!(out.0.lock().iter().filter(|l| *l == "crashed").count(), n);
            assert_eq!(h.ensure(), n <= 5);
        }
        assert_eq!(h.request_op(LOCAL_QUEUE_ID, SftpOp::Retry { item_ids: vec![] }).await, Err(SftpErrorCode::NoSession));
    }

    #[tokio::test]
    async fn an_attached_window_gets_a_snapshot_then_every_message() {
        let (h, _) = host(Arc::new(Panicking));
        let sink = Arc::new(Sink(Mutex::new(Vec::new())));
        h.attach("main", sink.clone());
        h.channels().op_progress("op", 3, 1);
        h.detach("main");
        h.channels().items_removed(vec!["x".into()]);
        assert_eq!(
            *sink.0.lock(),
            vec![
                json!({ "t": "snapshot", "items": [{ "id": "x" }] }),
                json!({ "t": "opProgress", "opId": "op", "done": 3, "total": 3 }),
            ]
        );
    }

    /// Accepts the host key; nothing else is asked (the saved password signs in).
    struct Trust(Arc<unimux_ssh::login::LoginControl>);

    impl unimux_ssh::login::LoginEvents for Trust {
        fn phase(&self, _: SshPhase) {}
        fn banner(&self, _: &str) {}
        fn host_key(&self, prompt_id: &str, _: &str) {
            self.0.answer_host_key(prompt_id, true, None);
        }
        fn auth_prompt(&self, _: &str, _: &AuthPromptInfo) {}
    }

    async fn login(port: u16) -> LoginHandle {
        let control = unimux_ssh::login::LoginControl::new();
        let req = unimux_ssh::login::LoginRequest {
            host: "127.0.0.1".into(),
            port,
            username: "alice".into(),
            private_key: None,
            passphrase: None,
            password: Some(Zeroizing::new("pw".into())),
            allow_password_prompt: false,
            debug: false,
        };
        unimux_ssh::login::login(req, LOGIN_TIMERS, Arc::new(Trust(control.clone())), control).await.unwrap()
    }

    /// Over a real login: the subsystem starts in the login folder and lists it; a server without the subsystem is
    /// `sftpDenied`.
    #[tokio::test(flavor = "multi_thread")]
    async fn the_sftp_subsystem_starts_in_the_login_folder_and_a_server_without_it_is_sftp_denied() {
        use unimux_ssh::test_server::{TestServer, TestServerConfig, TestUser};
        let root = std::env::temp_dir().join(format!("unimux-t1-subsystem-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("a.txt"), b"hello").unwrap();
        let users = || vec![TestUser::new("alice").password("pw")];
        let server =
            TestServer::start(TestServerConfig { users: users(), sftp_root: Some(root.clone()), ..TestServerConfig::default() })
                .await
                .unwrap();
        let handle = login(server.port()).await;
        let channel = open_sftp_subsystem(&handle).await.unwrap();
        let client = crate::client::SftpClient::start(Box::new(channel.into_stream())).await.unwrap();
        let side = crate::remote::RemoteSide::new(client);
        let home = side.resolve_path(".").await.unwrap();
        assert_eq!(home, "/");
        let names: Vec<String> =
            crate::sides::FileSide::readdir(&side, &home).await.unwrap().into_iter().map(|e| e.name).collect();
        assert_eq!(names, ["a.txt"]);

        let bare = TestServer::start(TestServerConfig { users: users(), ..TestServerConfig::default() }).await.unwrap();
        let handle = login(bare.port()).await;
        assert_eq!(open_sftp_subsystem(&handle).await.err(), Some(SshErrorCode::SftpDenied));
        let _ = std::fs::remove_dir_all(&root);
    }
}
