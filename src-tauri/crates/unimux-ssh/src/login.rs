//! The SSH login of one connection on russh (port of 1.1.4 src/sshcore/login.ts plus the connect part of the owners in
//! src/ptyhost/ssh.ts, src/sftphost/host.ts and src/dbhost/tunnel.ts), shared by SSH cells (P5), SFTP sessions (T1) and DB
//! tunnels (D2).
//!
//! - TCP connect (Nagle off) and the SSH handshake with the 1.1.4 algorithm offer ([`crate::algorithms`]), keepalive 15 s
//!   with 3 unanswered probes allowed.
//! - Host key: the owner asks main ([`LoginEvents::host_key`]) and the answer comes back through [`LoginControl`]; a
//!   rejected key ends the login with the reason main gave (`hostKeyRejected` by default).
//! - Authentication in 1.1.4's exact order (`AuthOrder`, SshLogin.nextAuth): publickey, the saved password, `none` before
//!   the server named its methods, then the password prompt (3 tries) and keyboard-interactive (3 tries), then give up.
//!   An empty keyboard-interactive info request is answered without a prompt.
//! - One step timer: the connect timer (20 s) until the host key arrives, then 20 s per authentication step; it is
//!   disarmed while a question waits for the user and armed again when it is answered. When it fires the login ends with
//!   `timeout`.
//!
//! Secrets live in [`LoginRequest`] (zeroized when dropped) and are never logged; the login takes the request by value, so
//! they are gone once it returns (1.1.4's dropSecrets).
//!
//! P5: a logged-in connection comes with its [`ConnectionEnd`]: the transport reports there how the connection ended (the
//! error event of ssh2's client), so an owner can tell a reset or a keepalive timeout from a clean close.

use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use parking_lot::Mutex;
use russh::client::{self, KeyboardInteractiveAuthResponse};
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use tokio::sync::{oneshot, watch};
use tokio::time::Instant;
use zeroize::Zeroizing;

use crate::algorithms::client_config;
use crate::errors::{DebugFilter, io_code, map_error};
use crate::keys::parse_private_key;
use crate::protocol::{AuthPromptInfo, AuthPromptKind, ConnectRequest, PromptField};
use crate::session::{SERVER_TEXT_MAX, SshErrorCode, SshPhase, sanitize_server_text};

/// `SshTimers` / `LoginTimers` of 1.1.4.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LoginTimers {
    pub connect: Duration,
    pub auth_step: Duration,
    pub keepalive: Duration,
    pub keepalive_count_max: usize,
}

/// `SSH_TIMERS` (the same values in the Pty Host, the SFTP Host and the DB tunnels).
pub const LOGIN_TIMERS: LoginTimers = LoginTimers {
    connect: Duration::from_secs(20),
    auth_step: Duration::from_secs(20),
    keepalive: Duration::from_secs(15),
    keepalive_count_max: 3,
};

/// `MAX_PROMPT_TRIES`.
const MAX_PROMPT_TRIES: u32 = 3;
/// Keyboard-interactive info requests answered in one exchange at most. ssh2 has no limit; a server that keeps sending
/// requests without prompts (which never reach the user and never disarm the step timer) would otherwise loop for 20 s.
const MAX_KEYBOARD_ROUNDS: u32 = 64;

/// The fields of `SshConnectRequest` the login reads.
#[derive(Clone)]
pub struct LoginRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub private_key: Option<Zeroizing<String>>,
    pub passphrase: Option<Zeroizing<String>>,
    pub password: Option<Zeroizing<String>>,
    pub allow_password_prompt: bool,
    pub debug: bool,
}

impl std::fmt::Debug for LoginRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginRequest").field("host", &self.host).field("port", &self.port).finish_non_exhaustive()
    }
}

impl ConnectRequest {
    /// Moves the login part (and every secret) out of the request; the rest (size, startup, sudo) stays with the owner.
    pub fn take_login(&mut self) -> LoginRequest {
        LoginRequest {
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            private_key: self.private_key.take(),
            passphrase: self.passphrase.take(),
            password: self.password.take(),
            allow_password_prompt: self.allow_password_prompt,
            debug: self.debug,
        }
    }
}

/// What the owner of the connection reports for the login (`LoginHooks` without the timer, which lives here).
pub trait LoginEvents: Send + Sync {
    /// The phase moved on: `verifying` at the host key, `authenticating` once it was accepted.
    fn phase(&self, phase: SshPhase);
    /// A server banner, already sanitized.
    fn banner(&self, text: &str);
    fn host_key(&self, prompt_id: &str, key_base64: &str);
    fn auth_prompt(&self, prompt_id: &str, prompt: &AuthPromptInfo);
    /// Dev builds with MC_SSH_DEBUG=1 only; never a line from user authentication on.
    fn debug(&self, _line: &str) {}
    /// The method about to be sent (`none`, `publickey`, `password`, `keyboard-interactive`) or `false` when the login
    /// gives up, as ssh2's auth handler chose them (`-> <method>` in scripts/sp7/matrix.mjs). Never a credential.
    fn auth_method(&self, _method: &str) {}
}

type HostKeyReply = (bool, Option<SshErrorCode>);
type AuthReply = Option<Vec<Zeroizing<String>>>;

#[derive(Default)]
struct Pending {
    host_key: Option<(String, oneshot::Sender<HostKeyReply>)>,
    auth: Option<(String, oneshot::Sender<AuthReply>)>,
    override_code: Option<SshErrorCode>,
}

/// The answers main gives to a running login, and its end. One per connection; cloneable through `Arc`.
pub struct LoginControl {
    pending: Mutex<Pending>,
    ended: watch::Sender<bool>,
    /// The connection's task ended (set by the handler's `disconnected`): Some(code) with the transport's error, or
    /// Some(None) for an end without one (EOF). Owners that keep the connection after the login (D2 tunnels) wait for it
    /// with [`LoginControl::connection_closed`].
    closed: watch::Sender<Option<Option<SshErrorCode>>>,
}

impl std::fmt::Debug for LoginControl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginControl").field("ended", &*self.ended.borrow()).finish_non_exhaustive()
    }
}

impl LoginControl {
    pub fn new() -> Arc<LoginControl> {
        Arc::new(LoginControl {
            pending: Mutex::new(Pending::default()),
            ended: watch::Sender::new(false),
            closed: watch::Sender::new(None),
        })
    }

    /// Resolves once the connection's task ended (also long after the login): the error the transport reported
    /// (`timeout` for unanswered keepalives, `reset`, `unknown` for a DISCONNECT message like ssh2's error event), None for
    /// an end without an error (EOF; ssh2's 'close' without 'error').
    pub async fn connection_closed(&self) -> Option<SshErrorCode> {
        let mut rx = self.closed.subscribe();
        match rx.wait_for(Option::is_some).await {
            Ok(v) => (*v).flatten(),
            Err(_) => None,
        }
    }

    fn note_closed(&self, code: Option<SshErrorCode>) {
        self.closed.send_if_modified(|c| {
            if c.is_some() {
                return false;
            }
            *c = Some(code);
            true
        });
    }

    fn live(&self) -> bool {
        !*self.ended.borrow()
    }

    /// `answerHostKey`: only the open question with this id; a refusal names the reason the login ends with.
    pub fn answer_host_key(&self, prompt_id: &str, accept: bool, error: Option<SshErrorCode>) {
        if !self.live() {
            return;
        }
        let mut p = self.pending.lock();
        if p.host_key.as_ref().is_none_or(|(id, _)| id != prompt_id) {
            return;
        }
        let (_, tx) = p.host_key.take().expect("checked");
        if !accept {
            p.override_code = Some(error.unwrap_or(SshErrorCode::HostKeyRejected));
        }
        drop(p);
        let _ = tx.send((accept, error));
    }

    /// `answerAuth`: None = the user cancelled.
    pub fn answer_auth(&self, prompt_id: &str, values: Option<Vec<Zeroizing<String>>>) {
        if !self.live() {
            return;
        }
        let tx = {
            let mut p = self.pending.lock();
            if p.auth.as_ref().is_none_or(|(id, _)| id != prompt_id) {
                return;
            }
            p.auth.take().expect("checked").1
        };
        let _ = tx.send(values);
    }

    /// `abort()`: the session ends; an open host key question is refused, an auth question dropped and the login stops.
    pub fn abort(&self) {
        let (hk, auth) = {
            let mut p = self.pending.lock();
            (p.host_key.take(), p.auth.take())
        };
        if let Some((_, tx)) = hk {
            let _ = tx.send((false, None));
        }
        drop(auth);
        self.ended.send_replace(true);
    }

    /// The reason the user or main decided (a refused key, a cancelled prompt), whatever the transport reports.
    pub fn override_code(&self) -> Option<SshErrorCode> {
        self.pending.lock().override_code
    }

    fn set_override(&self, code: SshErrorCode) {
        self.pending.lock().override_code = Some(code);
    }

    fn ask_host_key(&self, prompt_id: String) -> oneshot::Receiver<HostKeyReply> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().host_key = Some((prompt_id, tx));
        rx
    }

    fn ask_auth(&self, prompt_id: String) -> oneshot::Receiver<AuthReply> {
        let (tx, rx) = oneshot::channel();
        self.pending.lock().auth = Some((prompt_id, tx));
        rx
    }

    async fn ended(&self) {
        let mut rx = self.ended.subscribe();
        let _ = rx.wait_for(|e| *e).await;
    }
}

/// The owner's one timer (`arm` / `disarm` of LoginHooks).
#[derive(Clone)]
struct StepTimer(Arc<watch::Sender<Option<Instant>>>);

impl StepTimer {
    fn new() -> StepTimer {
        StepTimer(Arc::new(watch::Sender::new(None)))
    }

    fn arm(&self, after: Duration) {
        self.0.send_replace(Some(Instant::now() + after));
    }

    fn disarm(&self) {
        self.0.send_replace(None);
    }

    /// Resolves when an armed deadline passes (re-armed or disarmed deadlines are followed).
    async fn fired(&self) {
        let mut rx = self.0.subscribe();
        loop {
            let deadline = *rx.borrow_and_update();
            match deadline {
                None => {
                    if rx.changed().await.is_err() {
                        std::future::pending::<()>().await;
                    }
                }
                Some(at) => {
                    tokio::select! {
                        _ = tokio::time::sleep_until(at) => return,
                        r = rx.changed() => if r.is_err() { std::future::pending::<()>().await },
                    }
                }
            }
        }
    }
}

struct Shared {
    events: Arc<dyn LoginEvents>,
    control: Arc<LoginControl>,
    timer: StepTimer,
    auth_step: Duration,
    debug: Option<Mutex<DebugFilter>>,
    /// The host key accepted for this connection: a later key exchange must present the same one.
    accepted: Mutex<Option<Vec<u8>>>,
    end: ConnectionEnd,
}

impl Shared {
    fn debug(&self, line: &str) {
        if let Some(f) = &self.debug
            && f.lock().keep(line)
        {
            self.events.debug(line);
        }
    }
}

/// How the connection of a login ended, set once by the transport (russh's `disconnected`). Cheap to clone.
#[derive(Clone)]
pub struct ConnectionEnd(Arc<watch::Sender<Option<Option<SshErrorCode>>>>);

impl std::fmt::Debug for ConnectionEnd {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_tuple("ConnectionEnd").field(&*self.0.borrow()).finish()
    }
}

impl Default for ConnectionEnd {
    fn default() -> Self {
        ConnectionEnd(Arc::new(watch::Sender::new(None)))
    }
}

impl ConnectionEnd {
    /// The first report wins.
    pub fn set(&self, code: Option<SshErrorCode>) {
        self.0.send_if_modified(|v| {
            if v.is_some() {
                return false;
            }
            *v = Some(code);
            true
        });
    }

    /// The transport reported the end.
    pub fn ended(&self) -> bool {
        self.0.borrow().is_some()
    }

    /// The error the connection ended with (None while it runs, or when it ended without one: a plain end of the stream).
    pub fn code(&self) -> Option<SshErrorCode> {
        self.0.borrow().flatten()
    }

    /// Resolves once the transport reported the end.
    pub async fn wait(&self) {
        let mut rx = self.0.subscribe();
        let _ = rx.wait_for(Option::is_some).await;
    }
}

/// The russh client handler of a login; it stays with the connection's [`client::Handle`].
pub struct LoginHandler {
    shared: Arc<Shared>,
}

impl client::Handler for LoginHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let sh = &self.shared;
        // 1.1.4 offers no host certificate algorithms; anything but a plain key is refused.
        let PublicKeyOrCertificate::PublicKey { key, .. } = key else { return Ok(false) };
        let blob = key.to_bytes().map_err(|_| russh::Error::UnknownKey)?;
        if let Some(prev) = sh.accepted.lock().as_ref() {
            return Ok(*prev == blob);
        }
        if !sh.control.live() {
            return Ok(false);
        }
        sh.timer.disarm();
        sh.events.phase(SshPhase::Verifying);
        let prompt_id = uuid::Uuid::new_v4().to_string();
        let rx = sh.control.ask_host_key(prompt_id.clone());
        sh.events.host_key(&prompt_id, &STANDARD.encode(&blob));
        let (accept, _) = rx.await.unwrap_or((false, None));
        if !accept || !sh.control.live() {
            return Ok(false);
        }
        sh.events.phase(SshPhase::Authenticating);
        sh.timer.arm(sh.auth_step);
        *sh.accepted.lock() = Some(blob);
        Ok(true)
    }

    async fn kex_done(
        &mut self,
        _secret: Option<&[u8]>,
        names: &russh::Names,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        if self.shared.debug.is_some() {
            self.shared.debug(&format!(
                "Handshake: kex {}, host key {}, cipher {}, mac {}",
                names.kex.as_ref(),
                names.key,
                names.cipher.as_ref(),
                names.client_mac.as_ref()
            ));
        }
        Ok(())
    }

    async fn auth_banner(&mut self, banner: &str, _session: &mut client::Session) -> Result<(), Self::Error> {
        if self.shared.control.live() {
            self.shared.events.banner(&sanitize_server_text(banner, SERVER_TEXT_MAX));
        }
        Ok(())
    }

    async fn disconnected(&mut self, reason: client::DisconnectReason<Self::Error>) -> Result<(), Self::Error> {
        // Two readers of the same end: D2's tunnels wait on `LoginControl::connection_closed`, P5's shells on the
        // handle's `ConnectionEnd`. Each keeps the mapping its package ported.
        match reason {
            // ssh2 reports the server's DISCONNECT as an error event (S3's table: unknown).
            client::DisconnectReason::ReceivedDisconnect(_) => {
                self.shared.control.note_closed(Some(map_error(&russh::Error::Disconnect, None)));
                self.shared.end.set(Some(SshErrorCode::Unknown));
                Ok(())
            }
            client::DisconnectReason::Error(e) => {
                // The socket simply ended: ssh2 emits 'close' without an error (the owner then reads `reset`).
                let io_eof = matches!(&e, russh::Error::IO(io) if io.kind() == std::io::ErrorKind::UnexpectedEof);
                let eof = io_eof || matches!(e, russh::Error::Disconnect | russh::Error::HUP);
                self.shared.control.note_closed((!eof).then(|| map_error(&e, None)));
                self.shared.end.set((!io_eof).then(|| map_error(&e, self.shared.control.override_code())));
                Err(e)
            }
        }
    }
}

/// The russh connection of a login.
pub type SshHandle = client::Handle<LoginHandler>;

/// A logged-in connection: channels are opened on `handle` (also through `Deref`); `end` tells how it ended.
pub struct LoginHandle {
    pub handle: SshHandle,
    pub end: ConnectionEnd,
}

impl std::fmt::Debug for LoginHandle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginHandle").field("closed", &self.handle.is_closed()).field("end", &self.end).finish()
    }
}

impl std::ops::Deref for LoginHandle {
    type Target = SshHandle;
    fn deref(&self) -> &SshHandle {
        &self.handle
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Choice {
    None,
    PublicKey,
    SavedPassword,
    PromptPassword,
    Keyboard,
}

impl Choice {
    /// The SSH method name the choice sends.
    fn method(self) -> &'static str {
        match self {
            Choice::None => "none",
            Choice::PublicKey => "publickey",
            Choice::SavedPassword | Choice::PromptPassword => "password",
            Choice::Keyboard => "keyboard-interactive",
        }
    }
}

/// The method sequence of 1.1.4's SshLogin.nextAuth: the queued steps (publickey, then the saved password) while the server
/// allows them, then `none` before the server has named its methods, then the password prompt and keyboard-interactive, 3
/// tries each, then give up. `methods` is None until the server answered a request.
#[derive(Debug)]
struct AuthOrder {
    queue: Vec<Choice>,
    password_tries: u32,
    keyboard_tries: u32,
}

impl AuthOrder {
    fn new(has_key: bool, has_password: bool) -> AuthOrder {
        let mut queue = Vec::new();
        if has_key {
            queue.push(Choice::PublicKey);
        }
        if has_password {
            queue.push(Choice::SavedPassword);
        }
        AuthOrder { queue, password_tries: 0, keyboard_tries: 0 }
    }

    fn next(&mut self, methods: Option<&[String]>, allow_password_prompt: bool) -> Option<Choice> {
        let has = |m: &str| methods.is_some_and(|ms| ms.iter().any(|x| x == m));
        let allows = |m: &str| methods.is_none() || has(m);
        while !self.queue.is_empty() {
            let step = self.queue.remove(0);
            match step {
                Choice::PublicKey if allows("publickey") => return Some(step),
                Choice::SavedPassword if allows("password") => return Some(step),
                _ => {}
            }
        }
        if methods.is_none() {
            return Some(Choice::None);
        }
        if has("password") && allow_password_prompt && self.password_tries < MAX_PROMPT_TRIES {
            self.password_tries += 1;
            return Some(Choice::PromptPassword);
        }
        if has("keyboard-interactive") && self.keyboard_tries < MAX_PROMPT_TRIES {
            self.keyboard_tries += 1;
            return Some(Choice::Keyboard);
        }
        None
    }
}

/// Logs in. `Ok` = authenticated (the owner opens its channels on the handle); `Err` = the code the session ends with.
/// [`LoginControl::abort`] stops it at once (`cancelled`, or the reason main gave).
pub async fn login(
    req: LoginRequest,
    timers: LoginTimers,
    events: Arc<dyn LoginEvents>,
    control: Arc<LoginControl>,
) -> Result<LoginHandle, SshErrorCode> {
    let timer = StepTimer::new();
    timer.arm(timers.connect);
    let shared = Arc::new(Shared {
        events,
        control: control.clone(),
        timer: timer.clone(),
        auth_step: timers.auth_step,
        debug: req.debug.then(|| Mutex::new(DebugFilter::default())),
        accepted: Mutex::new(None),
        end: ConnectionEnd::default(),
    });
    let r = tokio::select! {
        biased;
        _ = control.ended() => Err(control.override_code().unwrap_or(SshErrorCode::Cancelled)),
        _ = timer.fired() => Err(SshErrorCode::Timeout),
        r = drive(req, timers, shared.clone()) => r,
    };
    // Nothing may be answered any more: open questions are dropped with the login.
    {
        let mut p = control.pending.lock();
        p.host_key = None;
        p.auth = None;
    }
    timer.disarm();
    r.map(|handle| LoginHandle { handle, end: shared.end.clone() })
}

async fn connect_tcp(host: &str, port: u16) -> Result<tokio::net::TcpStream, SshErrorCode> {
    let addrs: Vec<_> = tokio::net::lookup_host((host, port)).await.map_err(|_| SshErrorCode::Dns)?.collect();
    let mut last = None;
    for addr in addrs {
        match tokio::net::TcpStream::connect(addr).await {
            Ok(s) => {
                let _ = s.set_nodelay(true);
                return Ok(s);
            }
            Err(e) => last = Some(e),
        }
    }
    Err(last.map(|e| io_code(&e)).unwrap_or(SshErrorCode::Dns))
}

async fn drive(req: LoginRequest, timers: LoginTimers, sh: Arc<Shared>) -> Result<SshHandle, SshErrorCode> {
    let control = sh.control.clone();
    let code = |e: &russh::Error| map_error(e, control.override_code());
    let stream = connect_tcp(&req.host, req.port).await?;
    let config = client_config(timers.keepalive, timers.keepalive_count_max);
    let mut handle = client::connect_stream(config, stream, LoginHandler { shared: sh.clone() }).await.map_err(|e| code(&e))?;
    // Like ssh2's debug filter: nothing from user authentication on.
    sh.debug("USERAUTH");

    let user = req.username.clone();
    let truthy = |s: &Option<Zeroizing<String>>| s.as_deref().is_some_and(|v| !v.is_empty());
    let mut order = AuthOrder::new(truthy(&req.private_key), truthy(&req.password));
    let mut methods: Option<Vec<String>> = None;
    loop {
        if control.override_code().is_some() || !control.live() {
            return Err(control.override_code().unwrap_or(SshErrorCode::Cancelled));
        }
        let Some(choice) = order.next(methods.as_deref(), req.allow_password_prompt) else {
            // next(false): ssh2 then fails with "All configured authentication methods failed".
            sh.events.auth_method("false");
            return Err(control.override_code().unwrap_or(SshErrorCode::Auth));
        };
        if choice != Choice::PublicKey {
            sh.events.auth_method(choice.method());
        }
        let result = match choice {
            Choice::None => {
                sh.timer.arm(timers.auth_step);
                handle.authenticate_none(user.clone()).await
            }
            Choice::PublicKey => {
                let text = req.private_key.as_deref().map(String::as_str).unwrap_or("");
                // 1.1.4 never gets here with a key it cannot read (main checked it when it was stored); such a key is
                // skipped like ssh2 skips a key that cannot sign.
                let Ok(parsed) = parse_private_key(text, req.passphrase.as_deref().map(String::as_str)) else { continue };
                sh.events.auth_method(choice.method());
                let hash = if parsed.key.algorithm().is_rsa() {
                    handle.best_supported_rsa_hash().await.ok().flatten().flatten()
                } else {
                    None
                };
                sh.timer.arm(timers.auth_step);
                handle.authenticate_publickey(user.clone(), PrivateKeyWithHashAlg::new(Arc::new(*parsed.key), hash)).await
            }
            Choice::SavedPassword => {
                sh.timer.arm(timers.auth_step);
                let pw = req.password.as_deref().cloned().unwrap_or_default();
                handle.authenticate_password(user.clone(), pw).await
            }
            Choice::PromptPassword => {
                sh.timer.disarm();
                let info = AuthPromptInfo {
                    kind: AuthPromptKind::Password,
                    name: None,
                    instructions: None,
                    fields: Vec::new(),
                    retry: order.password_tries > 1,
                };
                let Some(values) = ask(&sh, &info).await else {
                    control.set_override(SshErrorCode::Cancelled);
                    return Err(SshErrorCode::Cancelled);
                };
                sh.timer.arm(timers.auth_step);
                let pw = values.first().map(|v| v.as_str().to_string()).unwrap_or_default();
                handle.authenticate_password(user.clone(), pw).await
            }
            Choice::Keyboard => {
                sh.timer.arm(timers.auth_step);
                keyboard(&mut handle, &user, &sh, order.keyboard_tries > 1, timers.auth_step).await
            }
        };
        match result {
            Ok(client::AuthResult::Success) => {
                sh.timer.disarm();
                return Ok(handle);
            }
            Ok(client::AuthResult::Failure { remaining_methods, .. }) => {
                methods = Some(remaining_methods.iter().map(String::from).collect());
            }
            Err(e) => return Err(code(&e)),
        }
    }
}

async fn ask(sh: &Shared, info: &AuthPromptInfo) -> AuthReply {
    if !sh.control.live() {
        return None;
    }
    let prompt_id = uuid::Uuid::new_v4().to_string();
    let rx = sh.control.ask_auth(prompt_id.clone());
    sh.events.auth_prompt(&prompt_id, info);
    rx.await.unwrap_or(None)
}

/// One keyboard-interactive exchange (the `prompt` callback of SshLogin): every info request with prompts goes to the
/// user (name 200, instructions 2048, at most 10 fields of 200 UTF-16 units), an empty one is answered with an empty list.
async fn keyboard(
    handle: &mut SshHandle,
    user: &str,
    sh: &Shared,
    retry: bool,
    auth_step: Duration,
) -> Result<client::AuthResult, russh::Error> {
    let mut r = handle.authenticate_keyboard_interactive_start(user.to_string(), None).await?;
    let mut rounds = 0;
    loop {
        match r {
            KeyboardInteractiveAuthResponse::Success => return Ok(client::AuthResult::Success),
            KeyboardInteractiveAuthResponse::Failure { remaining_methods, partial_success } => {
                return Ok(client::AuthResult::Failure { remaining_methods, partial_success });
            }
            KeyboardInteractiveAuthResponse::InfoRequest { .. } if rounds >= MAX_KEYBOARD_ROUNDS => {
                return Err(russh::Error::Inconsistent);
            }
            KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts } => {
                rounds += 1;
                let answers: Vec<String> = if prompts.is_empty() {
                    Vec::new()
                } else {
                    sh.timer.disarm();
                    let info = AuthPromptInfo {
                        kind: AuthPromptKind::Keyboard,
                        name: Some(sanitize_server_text(&name, 200)),
                        instructions: Some(sanitize_server_text(&instructions, SERVER_TEXT_MAX)),
                        fields: prompts
                            .iter()
                            .take(10)
                            .map(|p| PromptField { text: sanitize_server_text(&p.prompt, 200), echo: p.echo })
                            .collect(),
                        retry,
                    };
                    let Some(values) = ask(sh, &info).await else {
                        sh.control.set_override(SshErrorCode::Cancelled);
                        return Err(russh::Error::NotAuthenticated);
                    };
                    sh.timer.arm(auth_step);
                    values.iter().map(|v| v.as_str().to_string()).collect()
                };
                r = handle.authenticate_keyboard_interactive_respond(answers).await?;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn auth_order_follows_ssh_login() {
        let mut o = AuthOrder::new(true, true);
        assert_eq!(o.next(None, true), Some(Choice::PublicKey));
        let pw = m(&["publickey", "password", "keyboard-interactive"]);
        assert_eq!(o.next(Some(&pw), true), Some(Choice::SavedPassword));
        for _ in 0..3 {
            assert_eq!(o.next(Some(&pw), true), Some(Choice::PromptPassword));
        }
        for _ in 0..3 {
            assert_eq!(o.next(Some(&pw), true), Some(Choice::Keyboard));
        }
        assert_eq!(o.next(Some(&pw), true), None);
    }

    #[test]
    fn auth_order_sends_none_first_without_credentials_and_skips_what_the_server_refuses() {
        let mut o = AuthOrder::new(false, false);
        assert_eq!(o.next(None, true), Some(Choice::None));
        let kbd = m(&["keyboard-interactive"]);
        assert_eq!(o.next(Some(&kbd), true), Some(Choice::Keyboard));
        let mut o = AuthOrder::new(true, true);
        let only_kbd = m(&["keyboard-interactive"]);
        assert_eq!(o.next(Some(&only_kbd), true), Some(Choice::Keyboard));
        let mut o = AuthOrder::new(false, false);
        let pw = m(&["password"]);
        assert_eq!(o.next(Some(&pw), false), None);
    }

    #[tokio::test(start_paused = true)]
    async fn the_step_timer_follows_arm_and_disarm() {
        let t = StepTimer::new();
        t.arm(Duration::from_secs(20));
        let fired = t.fired();
        tokio::pin!(fired);
        tokio::select! {
            _ = &mut fired => panic!("fired early"),
            _ = tokio::time::sleep(Duration::from_secs(10)) => {}
        }
        t.disarm();
        tokio::select! {
            _ = &mut fired => panic!("fired while disarmed"),
            _ = tokio::time::sleep(Duration::from_secs(60)) => {}
        }
        t.arm(Duration::from_secs(5));
        tokio::time::timeout(Duration::from_secs(6), &mut fired).await.expect("fires once armed again");
    }

    #[test]
    fn control_routes_answers_by_prompt_id_and_keeps_the_refusal_reason() {
        let c = LoginControl::new();
        let mut rx = c.ask_host_key("p1".into());
        c.answer_host_key("other", true, None);
        assert!(rx.try_recv().is_err());
        c.answer_host_key("p1", false, Some(SshErrorCode::HostKeyChanged));
        assert_eq!(rx.try_recv().unwrap(), (false, Some(SshErrorCode::HostKeyChanged)));
        assert_eq!(c.override_code(), Some(SshErrorCode::HostKeyChanged));
        let mut rx = c.ask_auth("a1".into());
        c.abort();
        assert!(rx.try_recv().is_err());
        c.answer_auth("a1", None);
    }

    struct Quiet;
    impl LoginEvents for Quiet {
        fn phase(&self, _: SshPhase) {}
        fn banner(&self, _: &str) {}
        fn host_key(&self, _: &str, _: &str) {}
        fn auth_prompt(&self, _: &str, _: &AuthPromptInfo) {}
    }

    fn request(port: u16) -> LoginRequest {
        LoginRequest {
            host: "127.0.0.1".into(),
            port,
            username: "u".into(),
            private_key: None,
            passphrase: None,
            password: None,
            allow_password_prompt: true,
            debug: false,
        }
    }

    #[tokio::test]
    async fn a_closed_port_is_refused() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let r = login(request(port), LOGIN_TIMERS, Arc::new(Quiet), LoginControl::new()).await;
        assert!(matches!(r, Err(SshErrorCode::Refused) | Err(SshErrorCode::Timeout)), "{:?}", r.err());
    }

    #[tokio::test(start_paused = true)]
    async fn a_silent_server_times_out_after_the_connect_timer() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _keep = tokio::spawn(async move {
            let (_s, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let r = login(request(port), LOGIN_TIMERS, Arc::new(Quiet), LoginControl::new()).await;
        assert_eq!(r.err(), Some(SshErrorCode::Timeout));
    }

    #[tokio::test]
    async fn abort_ends_the_login_as_cancelled() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let _keep = tokio::spawn(async move {
            let (_s, _) = listener.accept().await.unwrap();
            std::future::pending::<()>().await;
        });
        let control = LoginControl::new();
        let c = control.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            c.abort();
        });
        let r = login(request(port), LOGIN_TIMERS, Arc::new(Quiet), control).await;
        assert_eq!(r.err(), Some(SshErrorCode::Cancelled));
    }
}
