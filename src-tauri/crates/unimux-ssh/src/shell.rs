//! SSH shell cells on russh (P5): the owner of every grid cell's SSH session, port of 1.1.4 src/ptyhost/ssh.ts
//! (`SshManager`) and the SSH half of src/ptyhost/index.ts.
//!
//! - One session per cell id: the login through S3's [`LoginRegistry`] (questions and phases go to the coordinator as
//!   [`HostMessage`]s), then a shell channel (`xterm-256color` pty at the cell's size, `window-change` on every resize)
//!   within 20 s, else `timeout`; a refused channel, pty or shell request is `shellDenied`.
//! - The session is a terminal of the P2 engine ([`ExternalTerm`]): its output goes through the same OutputChannel
//!   (coalescing, FlowGate back-pressure: a paused session stops reading its channel, TailBuffer and the replay at
//!   recorded sizes), the window's input, sizes and acks reach it through the engine, and its end is reported like a pty's
//!   exit (drained first, then the final `sshStatus`, then `exit`).
//! - stdout and stderr have a UTF-8 decoder each (StringDecoder), so a character split across packets of one stream is
//!   never broken by the other.
//! - The first keystroke's echo window is seeded with a third of the shell's open time (channel open, pty, shell: three
//!   round trips).
//! - The host's startup text is typed once the shell was quiet for 400 ms after its last output, or 5 s after the shell
//!   opened, whichever comes first.
//! - `sshList` (remote path completion) and `sshStats` (the status bar) run their script on an exec channel of the cell's
//!   own connection (`exec sh -s`, the script on stdin): one listing at a time per session (a newer request replaces the
//!   waiting one, which answers `cancelled`), 5 s and 256 KiB at most; one bar run at a time (`busy`), 5 s and 64 KiB at
//!   most, a cut run keeps what it printed. The answers go back to the page that asked.
//! - Final status: an error recorded before the remote shell exited wins; a connected shell that exited reads `closed`
//!   (with its exit code); anything else `error` with `reset`. A kill reports nothing (the coordinator was told by main).
//!
//! Secrets travel in the [`ConnectRequest`] only until the login took them (zeroized when dropped); nothing here logs a
//! message payload.

use std::collections::HashMap;
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use russh::client::Msg;
use russh::{Channel, ChannelMsg, ChannelWriteHalf, Disconnect};
use serde_json::{Value, json};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::Instant;
use unimux_pty::engine::{ExternalHandle, ExternalTerm, PtyEngine};
use unimux_pty::manager::{DoneFlag, KillWait};
use unimux_pty::service::Utf8Stream;

use crate::host::{LoginRegistry, MessageSink};
use crate::login::{LOGIN_TIMERS, LoginHandle, LoginTimers};
use crate::protocol::{ConnectRequest, HostCommand, HostMessage};
use crate::remote::{
    ListRequest, ListResult, REMOTE_LIST_MAX_BYTES, SSH_BAR_MAX_BYTES, SSH_BAR_TIMEOUT_MS, StatsRun, bar_script, list_script,
    parse_list_message, parse_listing, parse_stats_message,
};
use crate::session::{SshErrorCode, SshPhase};

/// The owner's own timers of 1.1.4's `SSH_TIMERS` (the login's are [`LoginTimers`]).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ShellTimers {
    /// From the login to the open shell.
    pub shell: Duration,
    /// The startup text waits for this much quiet after the shell's last output ...
    pub quiet: Duration,
    /// ... but no longer than this after the shell opened.
    pub startup_max: Duration,
    /// How long a closing connection is given before it is dropped.
    pub kill_grace: Duration,
}

/// `SSH_TIMERS` (shellMs, quietMs, startupMaxMs, killGraceMs).
pub const SHELL_TIMERS: ShellTimers = ShellTimers {
    shell: Duration::from_secs(20),
    quiet: Duration::from_millis(400),
    startup_max: Duration::from_millis(5000),
    kill_grace: Duration::from_millis(2000),
};

/// `SHELL_ROUND_TRIPS`: the session channel opens, then the pty and the shell are requested, each awaiting its reply.
pub const SHELL_ROUND_TRIPS: f64 = 3.0;
/// `LIST_TIMEOUT_MS`: a listing that takes longer is given up (a hung `ls` on a dead NFS mount).
pub const LIST_TIMEOUT: Duration = Duration::from_millis(5000);
/// The terminal type the shell channel asks for.
pub const TERM: &str = "xterm-256color";

/// Where the sessions report (main's side: the pty host's cell bookkeeping and the SSH coordinator).
pub trait ShellEvents: Send + Sync {
    /// `spawned` (pid 0): the cell's terminal exists.
    fn spawned(&self, id: &str);
    /// `sshStatus`, `sshHostKey`, `sshAuthPrompt` for the coordinator. (`exit` comes as the engine's exit of the terminal.)
    fn message(&self, m: HostMessage);
}

enum WriteOp {
    Data(Vec<u8>),
    Size(u16, u16),
}

struct ListJob {
    req: ListRequest,
    done: oneshot::Sender<ListResult>,
}

#[derive(Default)]
struct St {
    /// Killed or closed: nothing is written, nothing is reported any more.
    ended: bool,
    /// The shell channel is open (phase `connected`).
    connected: bool,
    error: Option<SshErrorCode>,
    exited: bool,
    exit_code: Option<i64>,
    size: (u16, u16),
    writer: Option<mpsc::UnboundedSender<WriteOp>>,
    conn: Option<Arc<LoginHandle>>,
    startup: Option<String>,
    listing: bool,
    list_waiting: Option<ListJob>,
    stats: bool,
}

struct Session {
    id: String,
    shells: Weak<SshShells>,
    term: OnceLock<ExternalHandle>,
    st: Mutex<St>,
    paused: watch::Sender<bool>,
    stop: watch::Sender<bool>,
    /// When the shell last printed (the startup text's quiet timer).
    output_at: watch::Sender<Option<Instant>>,
    /// The connection is gone (the kill's wait).
    closed: Arc<DoneFlag>,
}

async fn stopped(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|s| *s).await;
}

async fn resumed(rx: &mut watch::Receiver<bool>) {
    let _ = rx.wait_for(|p| !*p).await;
}

async fn sleep_until_opt(at: Option<Instant>) {
    match at {
        Some(at) => tokio::time::sleep_until(at).await,
        None => std::future::pending().await,
    }
}

/// Waits for the reply of a request sent with `want_reply`. Output that arrives meanwhile is kept for the reader.
async fn reply(ch: &mut Channel<Msg>, early: &mut Vec<(bool, Vec<u8>)>) -> Result<(), ()> {
    loop {
        match ch.wait().await {
            Some(ChannelMsg::Success) => return Ok(()),
            Some(ChannelMsg::Failure) | Some(ChannelMsg::Close) | None => return Err(()),
            Some(ChannelMsg::Data { data }) => early.push((false, data.to_vec())),
            Some(ChannelMsg::ExtendedData { data, ext: 1 }) => early.push((true, data.to_vec())),
            Some(_) => {}
        }
    }
}

/// ssh2's `shell()`: a session channel, a pty (no modes) at the cell's size, then the shell, each confirmed.
async fn open_shell(conn: &LoginHandle, (cols, rows): (u16, u16)) -> Result<(Channel<Msg>, Vec<(bool, Vec<u8>)>), ()> {
    let mut ch = conn.channel_open_session().await.map_err(|_| ())?;
    let mut early = Vec::new();
    ch.request_pty(true, TERM, u32::from(cols), u32::from(rows), 0, 0, &[]).await.map_err(|_| ())?;
    reply(&mut ch, &mut early).await?;
    ch.request_shell(true).await.map_err(|_| ())?;
    reply(&mut ch, &mut early).await?;
    Ok((ch, early))
}

/// An exec channel running `exec sh -s` (ssh2's `exec()` callback: after the request's reply).
async fn exec_sh(conn: &LoginHandle) -> Result<Channel<Msg>, ()> {
    let mut ch = conn.channel_open_session().await.map_err(|_| ())?;
    ch.exec(true, "exec sh -s").await.map_err(|_| ())?;
    let mut ignored = Vec::new();
    reply(&mut ch, &mut ignored).await?;
    Ok(ch)
}

/// Closes an exec channel without waiting long for a busy connection.
async fn close_channel(ch: &Channel<Msg>) {
    let _ = tokio::time::timeout(Duration::from_millis(500), ch.close()).await;
}

async fn writer(mut rx: mpsc::UnboundedReceiver<WriteOp>, write: ChannelWriteHalf<Msg>) {
    while let Some(op) = rx.recv().await {
        let r = match op {
            WriteOp::Data(data) => write.data_bytes(data).await,
            WriteOp::Size(cols, rows) => write.window_change(u32::from(cols), u32::from(rows), 0, 0).await,
        };
        if r.is_err() {
            return;
        }
    }
    // The cell ended or was killed: `stream.end()`.
    let _ = tokio::time::timeout(Duration::from_millis(500), write.eof()).await;
}

impl Session {
    fn term(&self) -> Option<&ExternalHandle> {
        self.term.get()
    }

    /// `live(s)`: still the session of its id and not ended.
    fn live(&self) -> bool {
        !self.st.lock().ended && self.current()
    }

    fn current(&self) -> bool {
        self.shells.upgrade().is_some_and(|sh| sh.sessions.lock().get(&self.id).is_some_and(|s| std::ptr::eq(&**s, self)))
    }

    /// `fail(s, error)`: the first error counts, and none after the remote shell exited (a hard-closing server may answer
    /// the disconnect with a reset: still a clean close).
    fn fail(&self, code: SshErrorCode) {
        let mut st = self.st.lock();
        if st.ended {
            return;
        }
        if st.error.is_none() && !st.exited {
            st.error = Some(code);
        }
    }

    fn output(&self, text: &str) {
        if text.is_empty() {
            return;
        }
        let Some(term) = self.term() else { return };
        {
            let st = self.st.lock();
            if st.ended {
                return;
            }
            if st.startup.is_some() {
                self.output_at.send_replace(Some(Instant::now()));
            }
        }
        term.push(text.as_bytes());
    }

    fn type_startup(&self) {
        let (text, writer) = {
            let mut st = self.st.lock();
            let text = st.startup.take();
            if st.ended {
                return;
            }
            (text, st.writer.clone())
        };
        let (Some(text), Some(writer), Some(term)) = (text, writer, self.term()) else { return };
        term.wrote();
        let _ = writer.send(WriteOp::Data(text.into_bytes()));
    }

    async fn startup(self: Arc<Self>, quiet: Duration, max: Duration) {
        let max_at = Instant::now() + max;
        let mut last = self.output_at.subscribe();
        let mut stop = self.stop.subscribe();
        loop {
            let quiet_at = last.borrow_and_update().map(|t| t + quiet);
            tokio::select! {
                _ = tokio::time::sleep_until(max_at) => break,
                _ = sleep_until_opt(quiet_at) => break,
                r = last.changed() => if r.is_err() { return },
                _ = stopped(&mut stop) => return,
            }
        }
        self.type_startup();
    }

    /// `client.end()` then, after the grace time, the hard close: the connection is dropped either way.
    async fn hang_up(&self, conn: &LoginHandle, grace: Duration) {
        let deadline = Instant::now() + grace;
        if !conn.is_closed() {
            let _ = tokio::time::timeout_at(deadline, conn.disconnect(Disconnect::ByApplication, "", "en")).await;
        }
        while !conn.is_closed() && !conn.end.ended() && Instant::now() < deadline {
            tokio::select! {
                _ = conn.end.wait() => break,
                _ = tokio::time::sleep(Duration::from_millis(50)) => {}
            }
        }
        let mut st = self.st.lock();
        st.writer = None;
        st.conn = None;
    }

    async fn run(self: Arc<Self>, login: crate::login::LoginRequest, timers: LoginTimers) {
        if let Some(shells) = self.shells.upgrade() {
            self.clone().drive(&shells, login, timers).await;
        }
        self.closed.set();
    }

    async fn drive(self: Arc<Self>, shells: &Arc<SshShells>, login: crate::login::LoginRequest, timers: LoginTimers) {
        let grace = shells.timers.kill_grace;
        let conn = match shells.logins.login(&self.id, login, timers, shells.sink()).await {
            Ok(conn) => Arc::new(conn),
            Err(code) => {
                if self.live() {
                    self.fail(code);
                    self.on_close(shells);
                }
                return;
            }
        };
        if !self.live() {
            self.hang_up(&conn, grace).await;
            return;
        }
        self.st.lock().conn = Some(conn.clone());
        let mut stop = self.stop.subscribe();
        let asked = Instant::now();
        let size = self.st.lock().size;
        let opened = tokio::select! {
            r = tokio::time::timeout(shells.timers.shell, open_shell(&conn, size)) => Some(r),
            _ = stopped(&mut stop) => None,
        };
        let (channel, early) = match opened {
            None => {
                self.hang_up(&conn, grace).await;
                return;
            }
            Some(Err(_)) => {
                self.fail(SshErrorCode::Timeout);
                self.hang_up(&conn, grace).await;
                self.on_close(shells);
                return;
            }
            Some(Ok(Err(()))) => {
                // A connection that died meanwhile reports its own error (ssh2's error event came first).
                self.fail(conn.end.code().unwrap_or(SshErrorCode::ShellDenied));
                self.hang_up(&conn, grace).await;
                self.on_close(shells);
                return;
            }
            Some(Ok(Ok(opened))) => opened,
        };
        if !self.live() {
            close_channel(&channel).await;
            self.hang_up(&conn, grace).await;
            return;
        }
        if let Some(term) = self.term() {
            // The first key typed already gets the echo window of a slow server instead of waiting for a timer.
            term.seed_echo(asked.elapsed().as_secs_f64() * 1000.0 / SHELL_ROUND_TRIPS);
        }
        let (mut read, write) = channel.split();
        let (tx, rx) = mpsc::unbounded_channel();
        let startup = {
            let mut st = self.st.lock();
            // A resize while the shell was being opened: the pty gets the size the cell has now.
            if st.size != size {
                let _ = tx.send(WriteOp::Size(st.size.0, st.size.1));
            }
            st.writer = Some(tx);
            st.connected = true;
            st.startup.is_some()
        };
        shells.events.message(status(&self.id, SshPhase::Connected, None, None));
        shells.rt.spawn(writer(rx, write));
        if startup {
            shells.rt.spawn(self.clone().startup(shells.timers.quiet, shells.timers.startup_max));
        }
        let (mut stdout, mut stderr) = (Utf8Stream::default(), Utf8Stream::default());
        for (err, data) in early {
            let text = if err { stderr.push(&data) } else { stdout.push(&data) };
            self.output(&text);
        }
        let mut paused = self.paused.subscribe();
        let killed = loop {
            if *paused.borrow_and_update() {
                tokio::select! {
                    _ = resumed(&mut paused) => {}
                    _ = stopped(&mut stop) => break true,
                }
                continue;
            }
            let msg = tokio::select! {
                m = read.wait() => m,
                _ = stopped(&mut stop) => break true,
                _ = paused.changed() => continue,
            };
            match msg {
                Some(ChannelMsg::Data { data }) => self.output(&stdout.push(&data)),
                Some(ChannelMsg::ExtendedData { data, ext: 1 }) => self.output(&stderr.push(&data)),
                Some(ChannelMsg::ExitStatus { exit_status }) => {
                    let mut st = self.st.lock();
                    st.exited = true;
                    st.exit_code = Some(i64::from(exit_status));
                }
                // ssh2's 'exit' with a signal: the shell exited, without a code.
                Some(ChannelMsg::ExitSignal { .. }) => self.st.lock().exited = true,
                Some(ChannelMsg::Close) | None => break false,
                Some(_) => {}
            }
        };
        if killed {
            self.hang_up(&conn, grace).await;
            return;
        }
        // The stream closed: what the decoders still hold, then `client.end()`.
        let tail = format!("{}{}", stdout.end(), stderr.end());
        self.output(&tail);
        if let Some(code) = conn.end.code() {
            self.fail(code);
        }
        self.st.lock().writer = None;
        self.hang_up(&conn, grace).await;
        self.on_close(shells);
    }

    /// `onClose`: the end of a session that was not killed: its last output is drained, then the final status and the
    /// exit (exit code or -1) are reported.
    fn on_close(&self, shells: &Arc<SshShells>) {
        if !self.current() {
            return;
        }
        let (message, code) = {
            let mut st = self.st.lock();
            if st.ended {
                return;
            }
            st.ended = true;
            st.startup = None;
            st.writer = None;
            st.conn = None;
            let message = match st.error {
                Some(e) => status(&self.id, SshPhase::Error, Some(e), None),
                None if st.connected && st.exited => status(&self.id, SshPhase::Closed, None, st.exit_code),
                None => status(&self.id, SshPhase::Error, Some(SshErrorCode::Reset), None),
            };
            (message, st.exit_code.unwrap_or(-1))
        };
        let Some(term) = self.term() else { return };
        let (weak, events, id) = (Arc::downgrade(shells), shells.events.clone(), self.id.clone());
        let me = self as *const Session as usize;
        term.exit(code, move || {
            if let Some(shells) = weak.upgrade() {
                let mut sessions = shells.sessions.lock();
                if sessions.get(&id).is_some_and(|s| Arc::as_ptr(s) as usize == me) {
                    sessions.remove(&id);
                }
            }
            events.message(message);
        });
    }

    /// `list(id, req)` of one session.
    async fn list(self: Arc<Self>, req: ListRequest) -> ListResult {
        let rx = {
            if !self.current() {
                return ListResult::Failed("gone");
            }
            let mut st = self.st.lock();
            if st.ended || !st.connected || st.writer.is_none() {
                return ListResult::Failed("gone");
            }
            let (tx, rx) = oneshot::channel();
            let job = ListJob { req, done: tx };
            if st.listing {
                if let Some(old) = st.list_waiting.replace(job) {
                    let _ = old.done.send(ListResult::Failed("cancelled"));
                }
            } else {
                st.listing = true;
                drop(st);
                if let Some(shells) = self.shells.upgrade() {
                    shells.rt.spawn(self.clone().run_lists(job));
                }
            }
            rx
        };
        rx.await.unwrap_or(ListResult::Failed("gone"))
    }

    async fn run_lists(self: Arc<Self>, mut job: ListJob) {
        loop {
            let result = self.list_once(&job.req).await;
            let _ = job.done.send(result);
            // Taking the waiting one and clearing `listing` happen under one lock: a request made meanwhile is either
            // taken here or starts its own run.
            let next = {
                let mut st = self.st.lock();
                let next = st.list_waiting.take();
                if next.is_none() {
                    st.listing = false;
                }
                next
            };
            let Some(next) = next else { return };
            if !self.live() {
                self.st.lock().listing = false;
                let _ = next.done.send(ListResult::Failed("gone"));
                return;
            }
            job = next;
        }
    }

    fn conn(&self) -> Option<Arc<LoginHandle>> {
        self.st.lock().conn.clone()
    }

    async fn list_once(&self, req: &ListRequest) -> ListResult {
        let Some(conn) = self.conn() else { return ListResult::Failed("gone") };
        let deadline = Instant::now() + LIST_TIMEOUT;
        let mut ch = match tokio::time::timeout_at(deadline, exec_sh(&conn)).await {
            Err(_) => return ListResult::Failed("timeout"),
            Ok(Err(())) => return ListResult::Failed(if self.live() { "unsupported" } else { "gone" }),
            Ok(Ok(ch)) => ch,
        };
        let script = list_script(req).into_bytes();
        let sent = tokio::time::timeout_at(deadline, async {
            ch.data_bytes(script).await?;
            ch.eof().await
        })
        .await;
        match sent {
            Err(_) => {
                close_channel(&ch).await;
                return ListResult::Failed("timeout");
            }
            Ok(Err(_)) => {
                close_channel(&ch).await;
                return ListResult::Failed("failed");
            }
            Ok(Ok(())) => {}
        }
        let mut out: Vec<u8> = Vec::new();
        loop {
            match tokio::time::timeout_at(deadline, ch.wait()).await {
                Err(_) => {
                    close_channel(&ch).await;
                    return ListResult::Failed("timeout");
                }
                Ok(Some(ChannelMsg::Data { data })) => {
                    if out.len() < REMOTE_LIST_MAX_BYTES {
                        out.extend_from_slice(&data);
                    }
                }
                Ok(Some(ChannelMsg::Close)) | Ok(None) => break,
                Ok(Some(_)) => {}
            }
        }
        close_channel(&ch).await;
        out.truncate(REMOTE_LIST_MAX_BYTES);
        parse_listing(&String::from_utf8_lossy(&out), req.cwd_only)
    }

    /// `stats(id, first)` of one session.
    async fn stats(self: Arc<Self>, first: bool) -> StatsRun {
        if !self.current() {
            return StatsRun::Failed("gone");
        }
        let conn = {
            let mut st = self.st.lock();
            if st.ended || !st.connected || st.writer.is_none() {
                return StatsRun::Failed("gone");
            }
            if st.stats {
                return StatsRun::Failed("busy");
            }
            st.stats = true;
            st.conn.clone()
        };
        let result = match conn {
            Some(conn) => self.stats_once(&conn, first).await,
            None => StatsRun::Failed("gone"),
        };
        self.st.lock().stats = false;
        result
    }

    async fn stats_once(&self, conn: &LoginHandle, first: bool) -> StatsRun {
        let started = Instant::now();
        let deadline = started + Duration::from_millis(SSH_BAR_TIMEOUT_MS);
        let mut out: Vec<u8> = Vec::new();
        let mut size = 0usize;
        let done = |out: &[u8], size: usize, partial: bool| StatsRun::Ok {
            text: String::from_utf8_lossy(&out[..out.len().min(SSH_BAR_MAX_BYTES)]).into_owned(),
            ms: started.elapsed().as_millis() as u64,
            bytes: size,
            partial,
        };
        let mut ch = match tokio::time::timeout_at(deadline, exec_sh(conn)).await {
            Err(_) => return done(&out, size, true),
            Ok(Err(())) => return StatsRun::Failed(if self.live() { "unsupported" } else { "gone" }),
            Ok(Ok(ch)) => ch,
        };
        let script = bar_script(first).into_bytes();
        let sent = tokio::time::timeout_at(deadline, async {
            ch.data_bytes(script).await?;
            ch.eof().await
        })
        .await;
        match sent {
            Err(_) => {
                close_channel(&ch).await;
                return done(&out, size, true);
            }
            Ok(Err(_)) => {
                close_channel(&ch).await;
                return StatsRun::Failed("failed");
            }
            Ok(Ok(())) => {}
        }
        let result = loop {
            match tokio::time::timeout_at(deadline, ch.wait()).await {
                Err(_) => break done(&out, size, true),
                Ok(Some(ChannelMsg::Data { data })) => {
                    size += data.len();
                    out.extend_from_slice(&data);
                    if size > SSH_BAR_MAX_BYTES {
                        break done(&out, size, true);
                    }
                }
                Ok(Some(ChannelMsg::Close)) | Ok(None) => break done(&out, size, false),
                Ok(Some(_)) => {}
            }
        };
        close_channel(&ch).await;
        result
    }
}

impl ExternalTerm for Session {
    fn write(&self, data: &[u8]) {
        let st = self.st.lock();
        if st.ended {
            return;
        }
        if let Some(w) = &st.writer {
            let _ = w.send(WriteOp::Data(data.to_vec()));
        }
    }

    fn resize(&self, cols: u16, rows: u16) {
        let mut st = self.st.lock();
        st.size = (cols, rows);
        if let Some(w) = &st.writer {
            let _ = w.send(WriteOp::Size(cols, rows));
        }
    }

    fn pause(&self) {
        self.paused.send_replace(true);
    }

    fn resume(&self) {
        self.paused.send_replace(false);
    }

    /// `kill(id)`: forgotten at once, the login stops, the connection is ended (dropped after the grace time).
    fn kill(&self) -> KillWait {
        if let Some(shells) = self.shells.upgrade() {
            let mut sessions = shells.sessions.lock();
            let mine = sessions.get(&self.id).is_some_and(|s| std::ptr::eq(&**s, self));
            if mine {
                sessions.remove(&self.id);
                drop(sessions);
                shells.logins.abort(&self.id);
            }
        }
        {
            let mut st = self.st.lock();
            st.ended = true;
            st.startup = None;
            st.writer = None;
        }
        self.paused.send_replace(false);
        self.stop.send_replace(true);
        KillWait::flag(self.closed.clone())
    }
}

fn status(id: &str, phase: SshPhase, error: Option<SshErrorCode>, exit_code: Option<i64>) -> HostMessage {
    HostMessage::Status { id: id.to_string(), phase, error, exit_code, banner: None }
}

/// Every SSH cell session of the app (1.1.4's `SshManager` in the Pty Host).
pub struct SshShells {
    engine: PtyEngine,
    rt: tokio::runtime::Handle,
    logins: Arc<LoginRegistry>,
    events: Arc<dyn ShellEvents>,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    login_timers: LoginTimers,
    timers: ShellTimers,
}

impl std::fmt::Debug for SshShells {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshShells").field("sessions", &self.sessions.lock().len()).finish_non_exhaustive()
    }
}

impl SshShells {
    pub fn new(engine: PtyEngine, rt: tokio::runtime::Handle, events: Arc<dyn ShellEvents>) -> Arc<SshShells> {
        Self::with_timers(engine, rt, events, LOGIN_TIMERS, SHELL_TIMERS)
    }

    pub fn with_timers(
        engine: PtyEngine,
        rt: tokio::runtime::Handle,
        events: Arc<dyn ShellEvents>,
        login_timers: LoginTimers,
        timers: ShellTimers,
    ) -> Arc<SshShells> {
        Arc::new(SshShells {
            engine,
            rt,
            logins: LoginRegistry::new(),
            events,
            sessions: Mutex::new(HashMap::new()),
            login_timers,
            timers,
        })
    }

    fn sink(&self) -> MessageSink {
        let events = self.events.clone();
        Arc::new(move |m| events.message(m))
    }

    fn session(&self, id: &str) -> Option<Arc<Session>> {
        self.sessions.lock().get(id).cloned()
    }

    /// A session of this id exists (connecting, connected, or draining its end).
    pub fn has(&self, id: &str) -> bool {
        self.sessions.lock().contains_key(id)
    }

    /// The session of `id` has its shell open.
    pub fn is_connected(&self, id: &str) -> bool {
        self.session(id).is_some_and(|s| {
            let st = s.st.lock();
            st.connected && !st.ended
        })
    }

    /// `sshConnect`: starts the session of `req.id` (one of the same id ends first, unreported). A size the renderer
    /// reported before wins over the request's.
    pub fn connect(self: &Arc<Self>, mut req: ConnectRequest) {
        let id = req.id.clone();
        if let Some(old) = self.session(&id) {
            let _ = self.engine.kill(&id);
            // Already forgotten by the engine (it was draining its end): ended here.
            if self.session(&id).is_some_and(|s| Arc::ptr_eq(&s, &old)) {
                let _ = old.kill();
            }
        }
        let login = req.take_login();
        let cols = req.cols.clamp(2, u32::from(u16::MAX)) as u16;
        let rows = req.rows.clamp(1, u32::from(u16::MAX)) as u16;
        let session = Arc::new(Session {
            id: id.clone(),
            shells: Arc::downgrade(self),
            term: OnceLock::new(),
            st: Mutex::new(St { size: (cols, rows), startup: req.startup.take(), ..St::default() }),
            paused: watch::Sender::new(false),
            stop: watch::Sender::new(false),
            output_at: watch::Sender::new(None),
            closed: DoneFlag::new(),
        });
        let handle = self.engine.open_external(&id, cols, rows, session.clone());
        session.st.lock().size = handle.size();
        let _ = session.term.set(handle);
        self.sessions.lock().insert(id.clone(), session.clone());
        self.events.spawned(&id);
        self.events.message(status(&id, SshPhase::Connecting, None, None));
        self.rt.spawn(session.run(login, self.login_timers));
    }

    /// `sshHostKeyAnswer` / `sshAuthAnswer` for a running login; false when no login of that id waits.
    pub fn answer(&self, cmd: HostCommand) -> bool {
        self.logins.answer(cmd)
    }

    /// Remote path completion of the cell's shell (never fails: `gone`, `busy`, `nodir`, ... are answers).
    pub async fn list(&self, id: &str, req: ListRequest) -> ListResult {
        match self.session(id) {
            Some(s) => s.list(req).await,
            None => ListResult::Failed("gone"),
        }
    }

    /// One status bar run on the cell's connection.
    pub async fn stats(&self, id: &str, first: bool) -> StatsRun {
        match self.session(id) {
            Some(s) => s.stats(first).await,
            None => StatsRun::Failed("gone"),
        }
    }

    /// The engine's hook for the pty port's `sshList` / `sshStats` (`listFor` / `statsFor`): the answer goes back to the
    /// page that asked, if it is still there.
    pub fn port_message(self: &Arc<Self>, label: &str, page: u64, m: &Value) {
        let me = self.clone();
        let label = label.to_string();
        match m.get("t").and_then(Value::as_str) {
            Some("sshList") => {
                let Some((id, req_id, req)) = parse_list_message(m) else { return };
                self.rt.spawn(async move {
                    let result = me.list(&id, req).await;
                    let answer = json!({ "t": "sshListResult", "id": id, "reqId": req_id, "result": result.to_json() });
                    me.engine.post_json_to(&label, page, &answer);
                });
            }
            Some("sshStats") => {
                let Some((id, req_id, first)) = parse_stats_message(m) else { return };
                self.rt.spawn(async move {
                    let result = me.stats(&id, first).await;
                    let answer = json!({ "t": "sshStatsResult", "id": id, "reqId": req_id, "result": result.to_json() });
                    me.engine.post_json_to(&label, page, &answer);
                });
            }
            _ => {}
        }
    }
}

#[cfg(test)]
#[path = "shell_int_tests.rs"]
mod int_tests;

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use unimux_pty::batch::Transport;

    #[derive(Default)]
    struct Recorder {
        spawned: Mutex<Vec<String>>,
        messages: Mutex<Vec<HostMessage>>,
    }

    impl ShellEvents for Recorder {
        fn spawned(&self, id: &str) {
            self.spawned.lock().push(id.to_string());
        }
        fn message(&self, m: HostMessage) {
            self.messages.lock().push(m);
        }
    }

    #[derive(Default)]
    struct Frames {
        posts: AtomicUsize,
        bytes: Mutex<Vec<u8>>,
    }

    impl Transport for Frames {
        fn post(&self, _seq: u64, bytes: Vec<u8>) -> bool {
            self.posts.fetch_add(1, Ordering::SeqCst);
            self.bytes.lock().extend_from_slice(&bytes);
            true
        }
        fn gated(&self) -> bool {
            false
        }
        fn name(&self) -> &'static str {
            "test"
        }
        fn close(&self) {}
    }

    fn request(id: &str, port: u16) -> ConnectRequest {
        ConnectRequest {
            id: id.into(),
            host: "127.0.0.1".into(),
            port,
            username: "u".into(),
            cols: 1,
            rows: 0,
            private_key: None,
            passphrase: None,
            password: None,
            startup: Some("ls\r".into()),
            allow_password_prompt: true,
            debug: false,
            sftp_sudo: None,
        }
    }

    fn closed_port() -> u16 {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    }

    async fn until(mut f: impl FnMut() -> bool) {
        for _ in 0..400 {
            if f() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("condition not reached");
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_refused_login_ends_with_its_error_status_and_an_exit() {
        let engine = PtyEngine::new();
        let exits = Arc::new(Mutex::new(Vec::new()));
        let e = exits.clone();
        engine.on_exit(move |id, code| e.lock().push((id.to_string(), code)));
        let rec = Arc::new(Recorder::default());
        let shells = SshShells::new(engine.clone(), tokio::runtime::Handle::current(), rec.clone());
        shells.connect(request("c1", closed_port()));
        assert!(shells.has("c1"));
        assert!(engine.has("c1"));
        until(|| !exits.lock().is_empty()).await;
        assert_eq!(*rec.spawned.lock(), vec!["c1".to_string()]);
        let msgs = rec.messages.lock().clone();
        assert_eq!(msgs.first(), Some(&status("c1", SshPhase::Connecting, None, None)));
        assert!(
            matches!(
                msgs.last(),
                Some(HostMessage::Status {
                    phase: SshPhase::Error,
                    error: Some(SshErrorCode::Refused | SshErrorCode::Timeout),
                    ..
                })
            ),
            "{msgs:?}"
        );
        assert_eq!(*exits.lock(), vec![("c1".to_string(), -1)]);
        assert!(!shells.has("c1"));
        assert!(!engine.has("c1"));
        // A gone session answers `gone`.
        assert_eq!(
            shells.list("c1", ListRequest { dir: String::new(), cwd: None, cwd_only: true }).await.to_json()["reason"],
            "gone"
        );
        assert_eq!(shells.stats("c1", true).await, StatsRun::Failed("gone"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_killed_session_reports_nothing_and_its_wait_ends() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _keep = tokio::spawn(async move {
            let (_s, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let engine = PtyEngine::new();
        let exits = Arc::new(Mutex::new(Vec::new()));
        let e = exits.clone();
        engine.on_exit(move |id, code| e.lock().push((id.to_string(), code)));
        let rec = Arc::new(Recorder::default());
        let shells = SshShells::new(engine.clone(), tokio::runtime::Handle::current(), rec.clone());
        // A size the renderer reported before the session existed wins.
        engine.resize("c2", 100, 30);
        shells.connect(request("c2", port));
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(shells.session("c2").unwrap().st.lock().size, (100, 30));
        let wait = engine.kill("c2");
        assert!(!shells.has("c2"));
        let ended = tokio::task::spawn_blocking(move || wait.wait(Duration::from_secs(5))).await.unwrap();
        assert!(ended);
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(exits.lock().is_empty());
        assert_eq!(rec.messages.lock().len(), 1, "only `connecting`: {:?}", rec.messages.lock());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn replies_go_back_only_to_the_page_that_asked() {
        let engine = PtyEngine::new();
        let rec = Arc::new(Recorder::default());
        let shells = SshShells::new(engine.clone(), tokio::runtime::Handle::current(), rec);
        let frames = Arc::new(Frames::default());
        engine.attach("main", frames.clone());
        let s = shells.clone();
        engine.on_message(move |label, page, m| s.port_message(label, page, m));
        engine.post("main", &json!({ "t": "sshStats", "id": "none", "reqId": 7, "first": true }));
        until(|| String::from_utf8_lossy(&frames.bytes.lock()).contains("sshStatsResult")).await;
        let text = String::from_utf8_lossy(&frames.bytes.lock()).into_owned();
        assert!(text.contains("\"reqId\":7") && text.contains("\"gone\""), "{text}");
        // A message for a terminal of another window is not this window's to ask.
        engine.route("other", Some("detached-x"));
        let before = frames.posts.load(Ordering::SeqCst);
        engine.post("main", &json!({ "t": "sshStats", "id": "other", "reqId": 8, "first": true }));
        tokio::time::sleep(Duration::from_millis(100)).await;
        assert_eq!(frames.posts.load(Ordering::SeqCst), before);
    }
}
