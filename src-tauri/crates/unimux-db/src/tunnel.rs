//! The SSH tunnels of the DB sessions (D2; port of 1.1.4 src/dbhost/tunnel.ts and the tunnel half of src/dbhost/host.ts:
//! `joinTunnel`, `openTunnel`, `endTunnel`, `release`, `handOver`, the `sshConnect` / `sshHostKeyAnswer` /
//! `sshAuthAnswer` messages).
//!
//! One tunnel per connection (`tunnelKey`), shared by all its sessions and reference counted. The session the service
//! marked as `owner` opens it: it waits up to 6 minutes for main's `sshConnect` (the SSH coordinator may first ask for a
//! key passphrase), then logs in with the shared login core (unimux-ssh `login`: host key and auth questions go to the
//! coordinator as `sshHostKey` / `sshAuthPrompt`, the phases as `sshStatus` and the owner's `dbStatus`). The other
//! sessions (riders) wait for the same tunnel. When the owner is closed before the login finished while others still wait,
//! the first of them takes the login over (`handOver`): the old attempt is dropped (its questions and answers no longer
//! count), the new owner reads `connecting` and main hears `dbTunnelOwner` (the service starts the coordinator's login for
//! it). The last session to leave closes the tunnel; a tunnel that ends ends every session on it (before it was up with
//! its error, after with the SSH error or `reset`).
//!
//! There is no local listener: every database connection (the session's own, a reconnect, the cancel side connection, a
//! CancelRequest) is its own `direct-tcpip` channel ([`TunnelOpener::open`]) handed to the client as a byte stream, so no
//! other local program can ever reach the database through the tunnel.
//!
//! The session hosts (D9 Redis today; D5 / D8 / D12 for Postgres, MySQL) call [`DbTunnelHost::join`] synchronously when a
//! session opens (like 1.1.4, where the owner's wait for `sshConnect` was registered in the same tick as `dbOpen`, so main's
//! connect can never arrive before it) and [`DbTunnelHost::release`] when it ends.

use std::collections::HashMap;
use std::io;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::task::{Context, Poll};
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{Value, json};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::{oneshot, watch};
use unimux_ssh::coordinator::SshHostLink;
use unimux_ssh::login::{LOGIN_TIMERS, LoginControl, LoginEvents, LoginHandle, LoginTimers, login};
use unimux_ssh::protocol::{AuthPromptInfo, ConnectRequest, HostCommand, HostMessage};
use unimux_ssh::session::{SshErrorCode, SshPhase};

use crate::host::{HostReport, Spawn};

/// `DB_HOST_TIMERS.sshWaitMs`: how long the owner waits for main's `sshConnect`.
pub const SSH_WAIT: Duration = Duration::from_secs(6 * 60);
/// `TUNNEL_TIMERS.killGraceMs`: a closing tunnel's goodbye before the connection is cut.
pub const KILL_GRACE: Duration = Duration::from_secs(2);

/// The timers of a tunnel (tests shorten them).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TunnelTimers {
    pub login: LoginTimers,
    pub ssh_wait: Duration,
    pub kill_grace: Duration,
}

/// `TUNNEL_TIMERS` + `sshWaitMs` of 1.1.4.
pub const TUNNEL_TIMERS: TunnelTimers = TunnelTimers { login: LOGIN_TIMERS, ssh_wait: SSH_WAIT, kill_grace: KILL_GRACE };

/// Ends a session that rides on a tunnel which ended (the session host's `fail(s, code)`; a no-op for a session that
/// already ended).
pub type SessionFail = Arc<dyn Fn(String) + Send + Sync>;

/// The `ssh` part of a `dbOpen` config (`{dbHost, dbPort, tunnelKey, owner}`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelConfig {
    /// The database's address as the SSH server sees it.
    pub db_host: String,
    pub db_port: u16,
    pub tunnel_key: String,
    /// This session opens the tunnel (the first session of its connection in the service).
    pub owner: bool,
}

impl TunnelConfig {
    /// None: no usable `ssh` object (the session ends with `tunnel`).
    pub fn parse(v: &Value) -> Option<TunnelConfig> {
        let o = v.as_object()?;
        let port = o.get("dbPort").and_then(Value::as_f64).filter(|p| p.fract() == 0.0 && *p >= 0.0 && *p <= 65535.0)?;
        Some(TunnelConfig {
            db_host: o.get("dbHost").and_then(Value::as_str)?.to_owned(),
            db_port: port as u16,
            tunnel_key: o.get("tunnelKey").and_then(Value::as_str)?.to_owned(),
            owner: o.get("owner").and_then(Value::as_bool).unwrap_or(false),
        })
    }
}

/// A forwarded channel that could not be opened (1.1.4 `TunnelForwardError`, code `ETUNNEL`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TunnelError(pub String);

impl TunnelError {
    fn closed() -> TunnelError {
        TunnelError("SSH forward failed: tunnel closed".into())
    }

    pub fn message(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Display for TunnelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TunnelError {}

impl From<TunnelError> for io::Error {
    fn from(e: TunnelError) -> io::Error {
        io::Error::other(e.0)
    }
}

impl From<TunnelError> for crate::pg::error::ConnectError {
    fn from(e: TunnelError) -> Self {
        crate::pg::error::ConnectError::Tunnel(e.0)
    }
}

impl From<TunnelError> for crate::mysql::error::MyError {
    fn from(e: TunnelError) -> Self {
        crate::mysql::error::MyError::Tunnel(e.0)
    }
}

type Channel = russh::ChannelStream<russh::client::Msg>;

/// One database connection through the tunnel: a `direct-tcpip` channel as a byte stream. Shutting the write side down
/// sends EOF; dropping it closes the channel.
pub struct TunnelStream {
    inner: Option<Channel>,
    /// The channel's close on drop is sent from a task: dropped outside the runtime (a session torn down from another
    /// thread) it still has one.
    rt: tokio::runtime::Handle,
}

impl std::fmt::Debug for TunnelStream {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TunnelStream").finish_non_exhaustive()
    }
}

impl Drop for TunnelStream {
    fn drop(&mut self) {
        if let Some(ch) = self.inner.take() {
            let _guard = self.rt.enter();
            drop(ch);
        }
    }
}

fn gone() -> io::Error {
    io::Error::new(io::ErrorKind::NotConnected, "tunnel stream closed")
}

impl AsyncRead for TunnelStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        match self.inner.as_mut() {
            Some(ch) => Pin::new(ch).poll_read(cx, buf),
            None => Poll::Ready(Err(gone())),
        }
    }
}

impl AsyncWrite for TunnelStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        match self.inner.as_mut() {
            Some(ch) => Pin::new(ch).poll_write(cx, buf),
            None => Poll::Ready(Err(gone())),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.inner.as_mut() {
            Some(ch) => Pin::new(ch).poll_flush(cx),
            None => Poll::Ready(Ok(())),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.inner.as_mut() {
            Some(ch) => Pin::new(ch).poll_shutdown(cx),
            None => Poll::Ready(Ok(())),
        }
    }
}

/// One SSH connection of a tunnel (1.1.4 `SshTunnel`): the login's control, the logged-in connection and the target.
struct Tunnel {
    control: Arc<LoginControl>,
    handle: Mutex<Option<Arc<LoginHandle>>>,
    db_host: String,
    db_port: u16,
    /// Closed on request (`close()`): its end is no error.
    requested: AtomicBool,
    closing: watch::Sender<bool>,
    kill_grace: Duration,
    spawn: Spawn,
}

impl Tunnel {
    fn requested(&self) -> bool {
        self.requested.load(Ordering::SeqCst)
    }

    fn live(&self) -> bool {
        !self.requested() && self.handle.lock().as_ref().is_some_and(|h| !h.is_closed())
    }

    /// `close()`: the login stops, a logged-in connection says goodbye and is cut after the kill grace.
    /// Called again after a login that finished while the tunnel was closing, it cuts that connection too.
    fn close(&self) {
        if !self.requested.swap(true, Ordering::SeqCst) {
            self.control.abort();
            self.closing.send_replace(true);
        }
        if let Some(h) = self.handle.lock().take() {
            let grace = self.kill_grace;
            (self.spawn)(Box::pin(async move {
                let _ = tokio::time::timeout(grace, h.disconnect(russh::Disconnect::ByApplication, "", "")).await;
                drop(h);
            }));
        }
    }

    /// A new channel to the database (`forwardOut('127.0.0.1', 0, dbHost, dbPort)`).
    async fn forward(&self) -> Result<TunnelStream, TunnelError> {
        let handle = match self.handle.lock().clone() {
            Some(h) if !self.requested() && !h.is_closed() => h,
            _ => return Err(TunnelError::closed()),
        };
        let channel = handle
            .channel_open_direct_tcpip(self.db_host.clone(), u32::from(self.db_port), "127.0.0.1", 0)
            .await
            .map_err(|e| TunnelError(format!("SSH forward failed: {}", forward_reason(&e))))?;
        if self.requested() {
            // closed while the channel opened: it goes with the tunnel
            return Err(TunnelError::closed());
        }
        Ok(TunnelStream { inner: Some(channel.into_stream()), rt: tokio::runtime::Handle::current() })
    }

    /// Waits until the logged-in connection ends: None when it was closed on request, else the SSH error (`reset` for an
    /// end without one).
    async fn wait_end(&self) -> Option<SshErrorCode> {
        let mut closing = self.closing.subscribe();
        let code = loop {
            // the watch guard is not Send: it is dropped inside the branch's own future
            let closed_on_request = async {
                let _ = closing.wait_for(|c| *c).await.map(|_| ());
            };
            tokio::select! {
                code = self.control.connection_closed() => break code,
                _ = closed_on_request => return None,
                _ = tokio::time::sleep(Duration::from_secs(1)) => {
                    let closed = self.handle.lock().as_ref().is_none_or(|h| h.is_closed());
                    if closed {
                        // the connection's task closes its queue just before it reports why it ended
                        break tokio::time::timeout(Duration::from_millis(500), self.control.connection_closed())
                            .await
                            .ok()
                            .flatten();
                    }
                }
            }
        };
        if self.requested() {
            return None;
        }
        Some(code.or(self.control.override_code()).unwrap_or(SshErrorCode::Reset))
    }
}

/// ssh2's reason text of a refused channel (`(SSH) Channel open failure: ...`).
fn forward_reason(e: &russh::Error) -> String {
    match e {
        russh::Error::ChannelOpenFailure(r) => format!("(SSH) Channel open failure: {r:?}"),
        other => other.to_string(),
    }
}

/// Opens forwarded channels of one tunnel for a session (pg's `stream`, ioredis' `stream`, mysql2's `stream`).
#[derive(Clone)]
pub struct TunnelOpener {
    tunnel: Arc<Tunnel>,
}

impl std::fmt::Debug for TunnelOpener {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TunnelOpener").field("db_host", &self.tunnel.db_host).field("db_port", &self.tunnel.db_port).finish()
    }
}

impl TunnelOpener {
    /// A new channel to the database; fails at once when the tunnel is gone (1.1.4 `tunnelStream`: "tunnel closed").
    pub async fn open(&self) -> Result<TunnelStream, TunnelError> {
        self.tunnel.forward().await
    }

    /// The tunnel is logged in and not closed.
    pub fn live(&self) -> bool {
        self.tunnel.live()
    }

    /// The opener as the Redis client's stream source (every connect and reconnect asks for a new channel).
    pub fn stream_source(&self) -> crate::redis::connect::StreamSource {
        let me = self.clone();
        Arc::new(move || {
            let me = me.clone();
            Box::pin(async move {
                let s = me.open().await?;
                Ok(Box::new(s) as crate::redis::connect::BoxStream)
            })
        })
    }
}

impl crate::pg::connect::Connector for TunnelOpener {
    fn open(&self) -> BoxFuture<'_, Result<crate::pg::client::PgStream, crate::pg::error::ConnectError>> {
        Box::pin(async move {
            let s = self.tunnel.forward().await?;
            Ok(Box::new(s) as crate::pg::client::PgStream)
        })
    }

    fn via_tunnel(&self) -> bool {
        true
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RecPhase {
    Waiting,
    Ready,
    Ended,
}

type ReadyState = Option<Result<Arc<Tunnel>, String>>;

/// One tunnel of a connection (`TunnelRecord`).
struct Rec {
    /// Tells a record from a later one with the same key.
    serial: u64,
    /// The session whose login (sshConnect) opens it.
    owner: String,
    phase: RecPhase,
    /// Bumped when another session takes the login over: the older attempt's events no longer count.
    attempt: u64,
    /// The sessions on it, in the order they joined (the first live one takes a login over).
    refs: Vec<String>,
    tunnel: Option<Arc<Tunnel>>,
    ready: watch::Sender<ReadyState>,
    db_host: String,
    db_port: u16,
}

struct Joined {
    key: String,
    serial: u64,
    fail: SessionFail,
}

/// The owner's wait for main's `sshConnect`.
struct Wait {
    key: String,
    serial: u64,
    attempt: u64,
    tx: oneshot::Sender<Box<ConnectRequest>>,
}

#[derive(Default)]
struct State {
    next_serial: u64,
    tunnels: HashMap<String, Rec>,
    joined: HashMap<String, Joined>,
    waits: HashMap<String, Wait>,
}

impl State {
    fn rec(&self, key: &str, serial: u64) -> Option<&Rec> {
        self.tunnels.get(key).filter(|r| r.serial == serial)
    }

    fn rec_mut(&mut self, key: &str, serial: u64) -> Option<&mut Rec> {
        self.tunnels.get_mut(key).filter(|r| r.serial == serial)
    }

    /// The session is (still) on this tunnel: 1.1.4's `live(owner)` from the tunnel's side.
    fn on(&self, id: &str, key: &str, serial: u64) -> bool {
        self.joined.get(id).is_some_and(|j| j.key == key && j.serial == serial)
    }

    /// `mine()` of an attempt.
    fn current(&self, key: &str, serial: u64, attempt: u64) -> bool {
        self.rec(key, serial).is_some_and(|r| r.attempt == attempt && r.phase != RecPhase::Ended)
    }
}

/// What a state change does once the lock is released.
enum Out {
    Msg(Value),
    Fail(SessionFail, String),
    Close(Arc<Tunnel>),
    Open { key: String, serial: u64, attempt: u64, owner: String, rx: oneshot::Receiver<Box<ConnectRequest>> },
}

/// The tunnels of the DB sessions (the tunnel half of 1.1.4's DbHost), and the DB slot of the coordinator's
/// [`unimux_ssh::coordinator::HostRouter`] (main's `sshConnect` and the answers to the login's questions).
pub struct DbTunnelHost {
    me: Weak<DbTunnelHost>,
    st: Mutex<State>,
    report: OnceLock<HostReport>,
    spawn: Spawn,
    timers: TunnelTimers,
}

impl std::fmt::Debug for DbTunnelHost {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DbTunnelHost").field("tunnels", &self.tunnel_count()).finish_non_exhaustive()
    }
}

fn status_json(id: &str, phase: SshPhase, error: Option<SshErrorCode>) -> Value {
    HostMessage::Status { id: id.to_owned(), phase, error, exit_code: None, banner: None }.to_json()
}

fn db_status_json(id: &str, phase: &str) -> Value {
    json!({ "t": "dbStatus", "id": id, "phase": phase })
}

impl DbTunnelHost {
    pub fn new(spawn: Spawn, timers: TunnelTimers) -> Arc<DbTunnelHost> {
        Arc::new_cyclic(|me| DbTunnelHost {
            me: me.clone(),
            st: Mutex::new(State::default()),
            report: OnceLock::new(),
            spawn,
            timers,
        })
    }

    /// Where its messages to main go (the service's `onHostMessage`: `sshStatus`, `sshHostKey`, `sshAuthPrompt`,
    /// `dbStatus` of the owner's login phases, `dbTunnelOwner`).
    pub fn connect(&self, report: HostReport) {
        let _ = self.report.set(report);
    }

    /// For a service that holds the host: reports through a weak reference so neither keeps the other alive.
    pub fn connect_weak<T: Send + Sync + 'static>(&self, target: Weak<T>, f: fn(&T, Value)) {
        self.connect(Arc::new(move |m| {
            if let Some(t) = target.upgrade() {
                f(&t, m);
            }
        }));
    }

    /// Tunnels alive or logging in (tests).
    pub fn tunnel_count(&self) -> usize {
        self.st.lock().tunnels.len()
    }

    /// The session that logs the tunnel of `key` in (tests).
    pub fn owner_of(&self, key: &str) -> Option<String> {
        self.st.lock().tunnels.get(key).map(|r| r.owner.clone())
    }

    fn flush(&self, out: Vec<Out>) {
        for o in out {
            match o {
                Out::Msg(m) => {
                    if let Some(r) = self.report.get() {
                        r(m);
                    }
                }
                Out::Fail(f, code) => f(code),
                Out::Close(t) => t.close(),
                Out::Open { key, serial, attempt, owner, rx } => {
                    if let Some(me) = self.me.upgrade() {
                        (self.spawn)(Box::pin(async move { me.open_tunnel(key, serial, attempt, owner, rx).await }));
                    }
                }
            }
        }
    }

    /// `joinTunnel`, registered at once: the owner of a new tunnel starts waiting for main's `sshConnect`, every session
    /// takes a reference. The future gives the opener once the tunnel is up, or the code the session ends with. `fail`
    /// ends the session when the tunnel ends later (or before it was up, like the future's error).
    pub fn join(&self, session_id: &str, ssh: &Value, fail: SessionFail) -> BoxFuture<'static, Result<TunnelOpener, String>> {
        let Some(cfg) = TunnelConfig::parse(ssh) else { return Box::pin(async { Err("tunnel".to_owned()) }) };
        let mut out = Vec::new();
        let rx = {
            let mut st = self.st.lock();
            let st = &mut *st;
            // A session that joins again (an id reopened) leaves its old tunnel first.
            if st.joined.contains_key(session_id) {
                self.release_in(st, session_id, &mut out);
            }
            let key = cfg.tunnel_key.clone();
            if !st.tunnels.contains_key(&key) && !cfg.owner {
                // A session that expects a shared tunnel nobody opened fails at once.
                None
            } else {
                Some(Self::join_in(st, session_id, &cfg, fail, &mut out))
            }
        };
        self.flush(out);
        let Some(rx) = rx else { return Box::pin(async { Err("tunnel".to_owned()) }) };
        Box::pin(async move {
            let mut rx = rx;
            let r = match rx.wait_for(Option::is_some).await {
                Ok(v) => v.clone().expect("checked"),
                Err(_) => Err("tunnel".to_owned()),
            };
            r.map(|tunnel| TunnelOpener { tunnel })
        })
    }

    fn join_in(
        st: &mut State,
        session_id: &str,
        cfg: &TunnelConfig,
        fail: SessionFail,
        out: &mut Vec<Out>,
    ) -> watch::Receiver<ReadyState> {
        let key = cfg.tunnel_key.clone();
        if !st.tunnels.contains_key(&key) {
            st.next_serial += 1;
            let rec = Rec {
                serial: st.next_serial,
                owner: session_id.to_owned(),
                phase: RecPhase::Waiting,
                attempt: 0,
                refs: Vec::new(),
                tunnel: None,
                ready: watch::Sender::new(None),
                db_host: cfg.db_host.clone(),
                db_port: cfg.db_port,
            };
            st.tunnels.insert(key.clone(), rec);
            Self::start_attempt(st, &key, out);
        }
        let rec = st.tunnels.get_mut(&key).expect("present");
        if !rec.refs.iter().any(|r| r == session_id) {
            rec.refs.push(session_id.to_owned());
        }
        let serial = rec.serial;
        let rx = rec.ready.subscribe();
        st.joined.insert(session_id.to_owned(), Joined { key, serial, fail });
        rx
    }

    /// The session ended: its reference goes. The last one closes the tunnel; an owner closed during the login hands it to
    /// the next waiting session.
    pub fn release(&self, session_id: &str) {
        let mut out = Vec::new();
        self.release_in(&mut self.st.lock(), session_id, &mut out);
        self.flush(out);
    }

    fn release_in(&self, st: &mut State, session_id: &str, out: &mut Vec<Out>) {
        let Some(j) = st.joined.remove(session_id) else { return };
        let Some(rec) = st.rec_mut(&j.key, j.serial) else { return };
        if rec.phase == RecPhase::Ended {
            return;
        }
        rec.refs.retain(|r| r != session_id);
        // Nobody uses the tunnel any more: it closes.
        if rec.refs.is_empty() {
            Self::end_tunnel(st, &j.key, j.serial, Some("cancelled"), out);
            return;
        }
        // The owner was closed before the login finished while other sessions wait on the tunnel: one of them takes the
        // login over.
        if rec.phase == RecPhase::Waiting && rec.owner == session_id {
            Self::hand_over(st, &j.key, j.serial, out);
        }
    }

    /// Registers the owner's wait for `sshConnect` of the record's current attempt and starts it.
    fn start_attempt(st: &mut State, key: &str, out: &mut Vec<Out>) {
        let rec = st.tunnels.get(key).expect("present");
        let (serial, attempt, owner) = (rec.serial, rec.attempt, rec.owner.clone());
        let (tx, rx) = oneshot::channel();
        st.waits.insert(owner.clone(), Wait { key: key.to_owned(), serial, attempt, tx });
        out.push(Out::Open { key: key.to_owned(), serial, attempt, owner, rx });
    }

    /// `handOver`: the first session still on the tunnel becomes its owner; the old attempt is dropped.
    fn hand_over(st: &mut State, key: &str, serial: u64, out: &mut Vec<Out>) {
        let next = st.rec(key, serial).and_then(|r| r.refs.iter().find(|id| st.on(id, key, serial)).cloned());
        let Some(next) = next else {
            Self::end_tunnel(st, key, serial, Some("cancelled"), out);
            return;
        };
        let rec = st.rec_mut(key, serial).expect("checked");
        rec.attempt += 1;
        if let Some(old) = rec.tunnel.take() {
            out.push(Out::Close(old));
        }
        rec.owner = next.clone();
        st.waits.retain(|_, w| !(w.key == key && w.serial == serial));
        out.push(Out::Msg(db_status_json(&next, "connecting")));
        Self::start_attempt(st, key, out);
        out.push(Out::Msg(json!({ "t": "dbTunnelOwner", "id": next })));
    }

    /// `endTunnel`: the tunnel ended or could not start; every session on it ends (before it was up: with the tunnel's
    /// error; after: with the error or `reset`).
    fn end_tunnel(st: &mut State, key: &str, serial: u64, error: Option<&str>, out: &mut Vec<Out>) {
        let Some(rec) = st.rec(key, serial) else { return };
        if rec.phase == RecPhase::Ended {
            return;
        }
        let mut rec = st.tunnels.remove(key).expect("checked");
        let before = rec.phase == RecPhase::Waiting;
        rec.phase = RecPhase::Ended;
        if let Some(t) = rec.tunnel.take() {
            out.push(Out::Close(t));
        }
        if before {
            rec.ready.send_replace(Some(Err(error.unwrap_or("cancelled").to_owned())));
        }
        st.waits.retain(|_, w| !(w.key == key && w.serial == serial));
        for id in rec.refs.drain(..) {
            if st.on(&id, key, serial)
                && let Some(j) = st.joined.remove(&id)
            {
                out.push(Out::Fail(j.fail, error.unwrap_or("reset").to_owned()));
            }
        }
    }

    /// `openTunnel`: one attempt of the owner's login.
    async fn open_tunnel(
        self: Arc<Self>,
        key: String,
        serial: u64,
        attempt: u64,
        owner: String,
        rx: oneshot::Receiver<Box<ConnectRequest>>,
    ) {
        let req = match tokio::time::timeout(self.timers.ssh_wait, rx).await {
            Ok(Ok(req)) => Some(req),
            _ => None,
        };
        let mut out = Vec::new();
        let started = {
            let mut st = self.st.lock();
            let st = &mut *st;
            if st.waits.get(&owner).is_some_and(|w| w.key == key && w.serial == serial && w.attempt == attempt) {
                st.waits.remove(&owner);
            }
            if !st.rec(&key, serial).is_some_and(|r| r.phase == RecPhase::Waiting && r.attempt == attempt) {
                return;
            }
            match req {
                None => {
                    let code = if st.on(&owner, &key, serial) { "timeout" } else { "cancelled" };
                    Self::end_tunnel(st, &key, serial, Some(code), &mut out);
                    None
                }
                Some(req) => {
                    let rec = st.rec_mut(&key, serial).expect("checked");
                    let tunnel = Arc::new(Tunnel {
                        control: LoginControl::new(),
                        handle: Mutex::new(None),
                        db_host: rec.db_host.clone(),
                        db_port: rec.db_port,
                        requested: AtomicBool::new(false),
                        closing: watch::Sender::new(false),
                        kill_grace: self.timers.kill_grace,
                        spawn: self.spawn.clone(),
                    });
                    rec.tunnel = Some(tunnel.clone());
                    if st.on(&owner, &key, serial) {
                        out.push(Out::Msg(status_json(&owner, SshPhase::Connecting, None)));
                    }
                    Some((tunnel, req))
                }
            }
        };
        self.flush(out);
        let Some((tunnel, mut req)) = started else { return };
        let login_req = req.take_login();
        drop(req);
        let events = Arc::new(AttemptEvents { host: self.me.clone(), key: key.clone(), serial, attempt, owner: owner.clone() });
        match login(login_req, self.timers.login, events, tunnel.control.clone()).await {
            Err(code) => {
                let error = (!tunnel.requested()).then_some(code);
                self.attempt_ended(&key, serial, attempt, &owner, error);
            }
            Ok(handle) => {
                *tunnel.handle.lock() = Some(Arc::new(handle));
                let mut out = Vec::new();
                let up = {
                    let mut st = self.st.lock();
                    let ok = !tunnel.requested()
                        && st.rec(&key, serial).is_some_and(|r| r.phase == RecPhase::Waiting && r.attempt == attempt);
                    if ok {
                        let rec = st.rec_mut(&key, serial).expect("checked");
                        rec.phase = RecPhase::Ready;
                        rec.ready.send_replace(Some(Ok(tunnel.clone())));
                        if st.on(&owner, &key, serial) {
                            out.push(Out::Msg(status_json(&owner, SshPhase::Connected, None)));
                        }
                    }
                    ok
                };
                if !up {
                    tunnel.close();
                    return;
                }
                // `connected` goes out before the riders start their database connections.
                self.flush(out);
                let end = tunnel.wait_end().await;
                self.attempt_ended(&key, serial, attempt, &owner, end);
            }
        }
    }

    /// The tunnel's `ended(error)`: only the current attempt counts.
    fn attempt_ended(&self, key: &str, serial: u64, attempt: u64, owner: &str, error: Option<SshErrorCode>) {
        let mut out = Vec::new();
        {
            let mut st = self.st.lock();
            if !st.current(key, serial, attempt) {
                return;
            }
            if let Some(e) = error
                && st.on(owner, key, serial)
            {
                out.push(Out::Msg(status_json(owner, SshPhase::Error, Some(e))));
            }
            Self::end_tunnel(&mut st, key, serial, error.map(SshErrorCode::as_str), &mut out);
        }
        self.flush(out);
    }

    /// `shutdown`: every tunnel ends (the sessions were closed first).
    pub fn shutdown(&self) {
        let mut out = Vec::new();
        {
            let mut st = self.st.lock();
            let recs: Vec<(String, u64)> = st.tunnels.iter().map(|(k, r)| (k.clone(), r.serial)).collect();
            for (key, serial) in recs {
                Self::end_tunnel(&mut st, &key, serial, Some("cancelled"), &mut out);
            }
        }
        self.flush(out);
    }

    /// `tunnelOf(ownerId)`: the running login of the tunnel this session owns.
    fn tunnel_of(&self, owner: &str) -> Option<Arc<Tunnel>> {
        self.st.lock().tunnels.values().find(|r| r.owner == owner).and_then(|r| r.tunnel.clone())
    }
}

impl crate::redis::host::DbTunnels for DbTunnelHost {
    fn join(
        &self,
        session_id: &str,
        ssh: &Value,
        fail: SessionFail,
    ) -> BoxFuture<'static, Result<crate::redis::connect::StreamSource, String>> {
        let wait = DbTunnelHost::join(self, session_id, ssh, fail);
        Box::pin(async move { wait.await.map(|o| o.stream_source()) })
    }

    fn release(&self, session_id: &str) {
        DbTunnelHost::release(self, session_id);
    }
}

impl SshHostLink for DbTunnelHost {
    /// Main's SSH messages for `db:` sessions (always taken: the sessions run in this process).
    fn send(&self, cmd: HostCommand) -> bool {
        match cmd {
            HostCommand::Connect(req) => {
                let wait = self.st.lock().waits.remove(&req.id);
                if let Some(w) = wait {
                    let _ = w.tx.send(req);
                }
            }
            HostCommand::HostKeyAnswer { id, prompt_id, accept, error } => {
                if let Some(t) = self.tunnel_of(&id) {
                    t.control.answer_host_key(&prompt_id, accept, error);
                }
            }
            HostCommand::AuthAnswer { id, prompt_id, values } => {
                if let Some(t) = self.tunnel_of(&id) {
                    t.control.answer_auth(&prompt_id, values);
                }
            }
        }
        true
    }
}

/// The login events of one attempt: they count only while the attempt is the record's current one.
struct AttemptEvents {
    host: Weak<DbTunnelHost>,
    key: String,
    serial: u64,
    attempt: u64,
    owner: String,
}

impl AttemptEvents {
    /// (attempt current, owner still on the tunnel)
    fn check(&self, h: &DbTunnelHost) -> (bool, bool) {
        let st = h.st.lock();
        let mine = st.current(&self.key, self.serial, self.attempt);
        (mine, mine && st.on(&self.owner, &self.key, self.serial))
    }
}

impl LoginEvents for AttemptEvents {
    fn phase(&self, phase: SshPhase) {
        let Some(h) = self.host.upgrade() else { return };
        if self.check(&h).1 {
            h.flush(vec![Out::Msg(db_status_json(&self.owner, phase.as_str())), Out::Msg(status_json(&self.owner, phase, None))]);
        }
    }

    /// 1.1.4's tunnel reports no banner.
    fn banner(&self, _text: &str) {}

    fn host_key(&self, prompt_id: &str, key_base64: &str) {
        let Some(h) = self.host.upgrade() else { return };
        if self.check(&h).0 {
            let m = HostMessage::HostKey { id: self.owner.clone(), prompt_id: prompt_id.to_owned(), key: key_base64.to_owned() };
            h.flush(vec![Out::Msg(m.to_json())]);
        }
    }

    fn auth_prompt(&self, prompt_id: &str, prompt: &AuthPromptInfo) {
        let Some(h) = self.host.upgrade() else { return };
        if self.check(&h).0 {
            let m = HostMessage::AuthPrompt { id: self.owner.clone(), prompt_id: prompt_id.to_owned(), prompt: prompt.clone() };
            h.flush(vec![Out::Msg(m.to_json())]);
        }
    }

    fn debug(&self, line: &str) {
        eprintln!("[db {}] {line}", self.owner.get(3..11).unwrap_or(&self.owner));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_ssh_part_of_an_open_config_is_read() {
        let c = TunnelConfig::parse(&json!({ "dbHost": "10.0.0.5", "dbPort": 5432, "tunnelKey": "k", "owner": true })).unwrap();
        assert_eq!(c, TunnelConfig { db_host: "10.0.0.5".into(), db_port: 5432, tunnel_key: "k".into(), owner: true });
        assert!(!TunnelConfig::parse(&json!({ "dbHost": "h", "dbPort": 1, "tunnelKey": "k" })).unwrap().owner);
        for bad in [
            json!(null),
            json!({ "dbHost": "h", "dbPort": 70000, "tunnelKey": "k" }),
            json!({ "dbHost": "h", "dbPort": 1.5, "tunnelKey": "k" }),
            json!({ "dbPort": 1, "tunnelKey": "k" }),
            json!({ "dbHost": "h", "dbPort": 1 }),
        ] {
            assert!(TunnelConfig::parse(&bad).is_none(), "{bad}");
        }
    }
}
