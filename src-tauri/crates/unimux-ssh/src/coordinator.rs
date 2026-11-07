//! Main-side brain of SSH sessions (port of 1.1.4 src/main/ssh/coordinator.ts): resolves hosts and credentials, starts a
//! login at the owner of the session (SSH cells, SFTP sessions `sftp:<uuid>`, DB tunnels `db:<uuid>`), asks the renderer
//! (coalescing identical prompts: `pp:<keyId>` for a passphrase, `hk:<host>|<fingerprint>` for a host key) and keeps a
//! session state per id. The only place that decrypts secrets.
//!
//! - A key's passphrase: a saved one is checked (bcrypt) once per run, a remembered one never again; otherwise the user is
//!   asked up to 3 times, and one answer of a coalesced prompt is checked once for every cell of it (the result lives on
//!   the shared answer, so a typed passphrase is not kept once the cells are done with it).
//! - Prompts time out after 5 minutes (`cancelled`).
//! - A password typed with "remember" is saved only once that session connected (`pendingSave`; only the latest answer
//!   decides).
//!
//! One mutex guards the sessions and prompts; it is never held across an await, and the events, the owner link and the
//! waiting tasks are called after it is released, in the order 1.1.4 calls them.

use std::collections::HashSet;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Weak};
use std::time::Duration;

use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::{OnceCell, oneshot};
use zeroize::Zeroizing;

use crate::keys::js::node_base64;
use crate::known_hosts::{HostKeyJudgement, TrustMode, known_host_id};
use crate::protocol::{
    AuthPromptInfo, AuthPromptKind, ConnectRequest, HostCommand, HostKeyChoice, HostMessage, PromptAnswer, SftpSudo,
};
use crate::session::{
    SERVER_TEXT_MAX, SecretOwner, SessionHostKind, SessionState, SshErrorCode, SshPhase, find_cell, find_host, host_endpoint,
    host_login, restore_cwd_input, sanitize_server_text, session_host_of, startup_input,
};
use crate::stores::SshStores;
use crate::vault::{PasswordError, SetPassword};

/// `PROMPT_TIMEOUT_MS`.
pub const PROMPT_TIMEOUT: Duration = Duration::from_secs(5 * 60);
/// `MAX_PASSPHRASE_TRIES`.
pub const MAX_PASSPHRASE_TRIES: usize = 3;

/// The app state as the coordinator reads it.
pub trait CoordinatorState: Send + Sync {
    fn state(&self) -> Arc<Value>;
}

/// The owners of SSH connections: a command for a cell goes to the SSH cells, `sftp:` ids to the SFTP sessions, `db:` ids
/// to the DB tunnels. False when it was not delivered (no owner runs).
pub trait SshHostLink: Send + Sync {
    fn send(&self, cmd: HostCommand) -> bool;
}

/// `events` of CoordinatorDeps: the app routes them by id (cells to the renderer's SSH store, `sftp:` / `db:` ids to their
/// services).
pub trait CoordinatorEvents: Send + Sync {
    fn session(&self, state: &SessionState);
    fn prompt(&self, cell_id: &str, prompt: Option<&Value>);
    fn vault_changed(&self);
}

pub type Spawn = Arc<dyn Fn(Pin<Box<dyn Future<Output = ()> + Send>>) + Send + Sync>;
/// keys.ts `checkPassphrase(privateKey, passphrase)`.
pub type CheckPassphrase = Arc<dyn Fn(&str, &str) -> bool + Send + Sync>;

pub struct CoordinatorDeps {
    pub state: Arc<dyn CoordinatorState>,
    pub stores: Arc<SshStores>,
    pub host: Arc<dyn SshHostLink>,
    pub events: Arc<dyn CoordinatorEvents>,
    pub spawn: Spawn,
    pub now: Arc<dyn Fn() -> i64 + Send + Sync>,
    pub new_id: Arc<dyn Fn() -> String + Send + Sync>,
    /// MC_SSH_DEBUG=1 in a dev build: the owners report the handshake lines.
    pub debug: bool,
    pub prompt_timeout: Duration,
    /// keys.ts `checkPassphrase` (bcrypt: run on the blocking pool).
    pub check_passphrase: CheckPassphrase,
}

/// `SshConnectCellRequest` (validated by the IPC layer).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConnectCellRequest {
    pub cell_id: String,
    pub host_id: String,
    pub cols: u32,
    pub rows: u32,
    pub restore_cwd: bool,
}

enum AnswerKind {
    Cancel { timeout: bool },
    Values { values: Vec<Zeroizing<String>>, remember: bool, use_saved: bool },
    HostKey(HostKeyChoice),
}

/// One answer, shared by every cell of its prompt group. `once` is the WeakMap of 1.1.4 (`onceFor`): the result computed
/// for this answer (passphrase check, host key trust) the first time a cell needs it.
struct Answer {
    kind: AnswerKind,
    once: OnceCell<bool>,
}

type Reply = Arc<Answer>;

fn reply(kind: AnswerKind) -> Reply {
    Arc::new(Answer { kind, once: OnceCell::new() })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Cell,
    Session,
}

struct Live {
    generation: u64,
    kind: Kind,
    state: SessionState,
    host: String,
    port: u16,
    user: String,
    endpoint: String,
    secret: SecretOwner,
    pending_save: Option<Zeroizing<String>>,
}

struct Group {
    id: String,
    key: Option<String>,
    prompt: Value,
    cells: IndexMap<String, oneshot::Sender<Reply>>,
}

#[derive(Default)]
struct Inner {
    sessions: IndexMap<String, Live>,
    groups: IndexMap<String, Group>,
    prompt_of_cell: IndexMap<String, String>,
    generation: u64,
}

enum Out {
    Session(SessionState),
    Prompt(String, Option<Value>),
    Resolve(oneshot::Sender<Reply>, Reply),
}

struct Size {
    cols: u32,
    rows: u32,
    startup: Option<String>,
    sftp_sudo: Option<SftpSudo>,
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> T {
    match tokio::task::spawn_blocking(f).await {
        Ok(v) => v,
        Err(e) => std::panic::resume_unwind(e.into_panic()),
    }
}

fn str_field<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

pub struct SshCoordinator {
    deps: CoordinatorDeps,
    inner: Mutex<Inner>,
    me: Weak<SshCoordinator>,
}

impl std::fmt::Debug for SshCoordinator {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let inner = self.inner.lock();
        f.debug_struct("SshCoordinator")
            .field("sessions", &inner.sessions.len())
            .field("groups", &inner.groups.len())
            .finish_non_exhaustive()
    }
}

impl SshCoordinator {
    pub fn new(deps: CoordinatorDeps) -> Arc<SshCoordinator> {
        Arc::new_cyclic(|me| SshCoordinator { deps, inner: Mutex::new(Inner::default()), me: me.clone() })
    }

    fn now(&self) -> i64 {
        (self.deps.now)()
    }

    /// Runs `f` under the lock, then delivers what it queued (events, waiting tasks) with the lock released.
    fn run<R>(&self, f: impl FnOnce(&mut Inner, &mut Vec<Out>) -> R) -> R {
        let mut out = Vec::new();
        let r = f(&mut self.inner.lock(), &mut out);
        for o in out {
            match o {
                Out::Session(s) => self.deps.events.session(&s),
                Out::Prompt(cell, p) => self.deps.events.prompt(&cell, p.as_ref()),
                Out::Resolve(tx, answer) => {
                    let _ = tx.send(answer);
                }
            }
        }
        r
    }

    fn spawn(&self, f: impl Future<Output = ()> + Send + 'static) {
        (self.deps.spawn)(Box::pin(f));
    }

    fn set_phase(
        &self,
        inner: &mut Inner,
        out: &mut Vec<Out>,
        id: &str,
        phase: SshPhase,
        error: Option<SshErrorCode>,
        exit_code: Option<i64>,
    ) {
        let now = self.now();
        let Some(live) = inner.sessions.get_mut(id) else { return };
        let banner = live.state.server_banner.take().filter(|b| !b.is_empty() && phase.is_live());
        live.state = SessionState {
            cell_id: id.to_string(),
            host_id: live.state.host_id.clone(),
            phase,
            since: now,
            error,
            exit_code,
            server_banner: banner,
        };
        out.push(Out::Session(live.state.clone()));
    }

    fn current(inner: &Inner, id: &str, generation: u64) -> bool {
        inner.sessions.get(id).is_some_and(|l| l.generation == generation && l.state.phase.is_live())
    }

    fn fail(&self, id: &str, generation: u64, error: SshErrorCode) -> Result<(), SshErrorCode> {
        self.run(|inner, out| {
            if Self::current(inner, id, generation) {
                self.set_phase(inner, out, id, SshPhase::Error, Some(error), None);
            }
        });
        Err(error)
    }

    /// `connect(req)`: the login of a grid cell.
    pub async fn connect(&self, req: ConnectCellRequest) -> Result<(), SshErrorCode> {
        let state = self.deps.state.state();
        let cell = find_cell(&state, &req.cell_id);
        let host = find_host(&state, &req.host_id);
        let ssh = cell.and_then(|c| c.get("ssh")).filter(|s| s.is_object());
        let (Some(ssh), Some(host)) = (ssh, host) else { return Err(SshErrorCode::HostMissing) };
        if ssh.get("hostId").and_then(Value::as_str) != Some(req.host_id.as_str()) {
            return Err(SshErrorCode::HostMissing);
        }
        if self.inner.lock().sessions.get(&req.cell_id).is_some_and(|l| l.state.phase.is_live()) {
            return Ok(()); // R13
        }
        // A restored session (1.0.6) goes back into its last folder before the host's own startup command runs.
        let cd = if req.restore_cwd { restore_cwd_input(ssh.get("cwd")) } else { None };
        let startup = format!(
            "{}{}",
            cd.unwrap_or_default(),
            startup_input(host.get("startupCommand").and_then(Value::as_str)).unwrap_or_default()
        );
        let size = Size { cols: req.cols, rows: req.rows, startup: Some(startup).filter(|s| !s.is_empty()), sftp_sudo: None };
        let host = host.clone();
        self.start(&req.cell_id, Kind::Cell, &host, &state, size).await
    }

    /// `connectSession`: a login that is not a grid cell (`sftp:<uuid>`, `db:<uuid>`). `sudo` (0.9.9) runs the SFTP server
    /// through sudo; the SFTP service decides it once when the session is created.
    pub async fn connect_session(&self, session_id: &str, host_id: &str, sudo: bool) -> Result<(), SshErrorCode> {
        if session_host_of(session_id).is_none() {
            return Err(SshErrorCode::Unknown);
        }
        let state = self.deps.state.state();
        let Some(host) = find_host(&state, host_id) else { return Err(SshErrorCode::HostMissing) };
        if self.inner.lock().sessions.get(session_id).is_some_and(|l| l.state.phase.is_live()) {
            return Ok(());
        }
        let sftp_sudo = sudo.then(|| SftpSudo {
            command: host.get("sftpCommand").and_then(Value::as_str).filter(|c| !c.is_empty()).map(str::to_string),
        });
        let host = host.clone();
        self.start(session_id, Kind::Session, &host, &state, Size { cols: 80, rows: 24, startup: None, sftp_sudo }).await
    }

    async fn start(&self, id: &str, kind: Kind, host: &Value, state: &Value, size: Size) -> Result<(), SshErrorCode> {
        let login = host_login(host, state.get("sshIdentities"));
        let address = str_field(host, "address").to_string();
        let port = host.get("port").and_then(Value::as_u64).and_then(|p| u16::try_from(p).ok()).unwrap_or(22);
        let generation = self.run(|inner, out| {
            inner.generation += 1;
            let generation = inner.generation;
            let live = Live {
                generation,
                kind,
                state: SessionState {
                    cell_id: id.to_string(),
                    host_id: str_field(host, "id").to_string(),
                    phase: SshPhase::Connecting,
                    since: self.now(),
                    error: None,
                    exit_code: None,
                    server_banner: None,
                },
                host: address.clone(),
                port,
                user: login.username.clone(),
                endpoint: host_endpoint(&address, port),
                secret: login.secret.clone(),
                pending_save: None,
            };
            out.push(Out::Session(live.state.clone()));
            inner.sessions.insert(id.to_string(), live);
            generation
        });
        let current = || Self::current(&self.inner.lock(), id, generation);

        let vault = self.deps.stores.vault().await;
        let mut private_key: Option<Zeroizing<String>> = None;
        let mut passphrase: Option<Zeroizing<String>> = None;
        if let Some(key_id) = login.key_id.clone() {
            let v = vault.clone();
            let k = key_id.clone();
            let secret = match blocking(move || v.lock().key_secret(&k)).await {
                Ok(s) => s,
                Err(e) => {
                    self.deps.events.vault_changed();
                    return self.fail(id, generation, SshErrorCode::parse(e.as_str()).unwrap_or(SshErrorCode::KeyMissing));
                }
            };
            let pk = secret.private_key.clone();
            let info = vault.lock().key(&key_id);
            let encrypted = info.as_ref().is_some_and(|i| i.meta.encrypted);
            if encrypted {
                // M2: a saved passphrase is checked once per run and a remembered one (checked when it was typed) never
                // again. A wrong one still ends in an auth failure; no prompt is lost.
                let saved_ok = match secret.passphrase.clone() {
                    Some(saved) => {
                        let verified = vault.lock().is_verified(&key_id, &saved);
                        let ok = verified || {
                            let (check, pk, s) = (self.deps.check_passphrase.clone(), pk.clone(), saved.clone());
                            blocking(move || check(&pk, &s)).await
                        };
                        if ok {
                            vault.lock().mark_verified(&key_id, &saved);
                            passphrase = Some(saved);
                        }
                        ok
                    }
                    None => false,
                };
                if !saved_ok {
                    passphrase = vault.lock().remembered(&key_id);
                }
            }
            if encrypted && passphrase.is_none() {
                // The key may be replaced while the prompt is open: a passphrase checked against this material is
                // remembered only for it.
                let generation_of_key = vault.lock().generation(&key_id);
                let label = info.as_ref().map(|i| i.meta.label.clone()).unwrap_or_default();
                for attempt in 0..MAX_PASSPHRASE_TRIES {
                    if passphrase.is_some() {
                        break;
                    }
                    let mut body = Map::new();
                    body.insert("kind".into(), json!("passphrase"));
                    body.insert("keyId".into(), json!(key_id));
                    body.insert("keyLabel".into(), json!(label));
                    body.insert("retry".into(), json!(attempt > 0));
                    let answer = self.wait(self.ask(id, Some(format!("pp:{key_id}")), body)).await;
                    if !current() {
                        return Err(SshErrorCode::Cancelled);
                    }
                    let AnswerKind::Values { values, remember, .. } = &answer.kind else {
                        return self.fail(id, generation, SshErrorCode::Cancelled);
                    };
                    let typed = values.first().cloned().unwrap_or_default();
                    // Cells of one coalesced prompt get the same answer: only the first one pays for the check. A typed
                    // passphrase is never cached by itself; it is kept only when the user asked to remember it (D7).
                    let ok = *answer
                        .once
                        .get_or_init(|| {
                            let (check, pk, t) = (self.deps.check_passphrase.clone(), pk.clone(), typed.clone());
                            blocking(move || check(&pk, &t))
                        })
                        .await;
                    if ok {
                        if *remember {
                            vault.lock().remember(&key_id, &typed, Some(generation_of_key));
                        }
                        passphrase = Some(typed);
                    }
                }
                if passphrase.is_none() {
                    return self.fail(id, generation, SshErrorCode::Passphrase);
                }
            }
            private_key = Some(pk);
        }
        let saved_password = self.saved_password(&login.secret).await.ok();
        if !current() {
            return Err(SshErrorCode::Cancelled);
        }
        let req = ConnectRequest {
            id: id.to_string(),
            host: address,
            port,
            username: login.username,
            cols: size.cols,
            rows: size.rows,
            private_key: private_key.filter(|k| !k.is_empty()),
            passphrase: passphrase.filter(|p| !p.is_empty()),
            password: saved_password,
            startup: size.startup,
            allow_password_prompt: true,
            debug: self.deps.debug,
            sftp_sudo: size.sftp_sudo,
        };
        // M1: a connect sent while no owner runs would be lost and leave the session `connecting` for good.
        if !self.deps.host.send(HostCommand::Connect(Box::new(req))) {
            let code = match (kind, session_host_of(id)) {
                (Kind::Cell, _) => SshErrorCode::PtyHostCrashed,
                (_, Some(SessionHostKind::Db)) => SshErrorCode::DbHostCrashed,
                _ => SshErrorCode::SftpHostCrashed,
            };
            return self.fail(id, generation, code);
        }
        Ok(())
    }

    /// The saved password of a login: the identity's when the host uses one, otherwise the host's own.
    async fn saved_password(&self, secret: &SecretOwner) -> Result<Zeroizing<String>, PasswordError> {
        let vault = self.deps.stores.vault().await;
        let secret = secret.clone();
        blocking(move || match &secret {
            SecretOwner::Identity(id) => vault.lock().identity_password(id),
            SecretOwner::Host(id) => vault.lock().password(id),
        })
        .await
    }

    fn ask(&self, cell_id: &str, key: Option<String>, body: Map<String, Value>) -> oneshot::Receiver<Reply> {
        self.run(|inner, out| {
            let found =
                key.as_ref().and_then(|k| inner.groups.values().find(|g| g.key.as_ref() == Some(k)).map(|g| g.id.clone()));
            let group_id = match found {
                Some(g) => g,
                None => {
                    let id = (self.deps.new_id)();
                    let mut prompt = body;
                    prompt.insert("id".into(), json!(id));
                    inner
                        .groups
                        .insert(id.clone(), Group { id: id.clone(), key, prompt: Value::Object(prompt), cells: IndexMap::new() });
                    let (me, gid, after) = (self.me.clone(), id.clone(), self.deps.prompt_timeout);
                    self.spawn(async move {
                        tokio::time::sleep(after).await;
                        if let Some(me) = me.upgrade() {
                            me.run(|inner, out| me.finish(inner, out, &gid, reply(AnswerKind::Cancel { timeout: true })));
                        }
                    });
                    id
                }
            };
            let (tx, rx) = oneshot::channel();
            let group = inner.groups.get_mut(&group_id).expect("group exists");
            group.cells.insert(cell_id.to_string(), tx);
            out.push(Out::Prompt(cell_id.to_string(), Some(group.prompt.clone())));
            inner.prompt_of_cell.insert(cell_id.to_string(), group_id);
            rx
        })
    }

    async fn wait(&self, rx: oneshot::Receiver<Reply>) -> Reply {
        rx.await.unwrap_or_else(|_| reply(AnswerKind::Cancel { timeout: false }))
    }

    fn finish(&self, inner: &mut Inner, out: &mut Vec<Out>, group_id: &str, answer: Reply) {
        let Some(group) = inner.groups.shift_remove(group_id) else { return };
        for (cell, tx) in group.cells {
            if inner.prompt_of_cell.get(&cell).map(String::as_str) == Some(group_id) {
                inner.prompt_of_cell.shift_remove(&cell);
                out.push(Out::Prompt(cell.clone(), None));
            }
            out.push(Out::Resolve(tx, answer.clone()));
        }
    }

    /// Takes one cell out of its prompt (closed, or its session ended); the others keep waiting.
    fn withdraw(&self, inner: &mut Inner, out: &mut Vec<Out>, cell_id: &str) {
        let Some(group_id) = inner.prompt_of_cell.shift_remove(cell_id) else { return };
        let Some(group) = inner.groups.get_mut(&group_id) else { return };
        let tx = group.cells.shift_remove(cell_id);
        out.push(Out::Prompt(cell_id.to_string(), None));
        if let Some(tx) = tx {
            out.push(Out::Resolve(tx, reply(AnswerKind::Cancel { timeout: false })));
        }
        if group.cells.is_empty() {
            inner.groups.shift_remove(&group_id);
        }
    }

    /// `answer(a)`: the renderer's (or a service's) answer to an open prompt.
    pub fn answer(&self, a: PromptAnswer) -> bool {
        self.run(|inner, out| {
            let Some(group_id) = inner.prompt_of_cell.get(a.cell_id()).cloned() else { return false };
            let Some(group) = inner.groups.get(&group_id) else { return false };
            if group.id != a.prompt_id() {
                return false;
            }
            let p = &group.prompt;
            let kind = str_field(p, "kind");
            let answer = match a {
                PromptAnswer::Cancel { .. } => reply(AnswerKind::Cancel { timeout: false }),
                PromptAnswer::HostKey { choice, .. } => {
                    if kind != "hostKey" {
                        return false;
                    }
                    let allowed = if str_field(p, "reason") == "changed" {
                        choice == HostKeyChoice::Replace
                    } else {
                        choice != HostKeyChoice::Replace
                    };
                    if !allowed {
                        return false;
                    }
                    reply(AnswerKind::HostKey(choice))
                }
                PromptAnswer::Values { values, remember, use_saved, .. } => {
                    let count = match kind {
                        "keyboard" => p.get("fields").and_then(Value::as_array).map_or(0, |f| f.len() as i64),
                        "hostKey" => -1,
                        _ => 1,
                    };
                    if values.len() as i64 != count {
                        return false;
                    }
                    // "Użyj zapisanego hasła" (a sudo prompt only): consent to use the host's saved login password once.
                    if use_saved && (kind != "sudo" || p.get("canUseSaved") != Some(&Value::Bool(true))) {
                        return false;
                    }
                    reply(AnswerKind::Values { values, remember: kind != "sudo" && remember, use_saved })
                }
            };
            self.finish(inner, out, &group_id, answer);
            true
        })
    }

    /// `onHostMessage`: true when the message was an SSH one and is fully handled here (`exit` is also the caller's).
    pub fn on_host_message(&self, m: HostMessage) -> bool {
        match m {
            HostMessage::Status { id, phase, error, exit_code, banner } => {
                let save = self.run(|inner, out| {
                    let live = inner.sessions.get_mut(&id)?;
                    if let Some(b) = banner {
                        live.state.server_banner = Some(sanitize_server_text(&b, SERVER_TEXT_MAX));
                        out.push(Out::Session(live.state.clone()));
                        return None;
                    }
                    // A failed write only loses the "remember" wish; the session itself is fine. A host that signs in
                    // with an identity saves it as the identity's password.
                    let save = if phase == SshPhase::Connected {
                        live.pending_save.take().map(|pw| (live.secret.clone(), pw))
                    } else {
                        None
                    };
                    if !phase.is_live() {
                        live.pending_save = None;
                        self.withdraw(inner, out, &id);
                    }
                    self.set_phase(inner, out, &id, phase, error, exit_code);
                    save
                });
                if let Some((secret, password)) = save {
                    self.save_password(secret, password);
                }
                true
            }
            HostMessage::HostKey { id, prompt_id, key } => {
                if let Some(me) = self.me.upgrade() {
                    self.spawn(async move { me.on_host_key(id, prompt_id, key).await });
                }
                true
            }
            HostMessage::AuthPrompt { id, prompt_id, prompt } => {
                if let Some(me) = self.me.upgrade() {
                    self.spawn(async move { me.on_auth_prompt(id, prompt_id, prompt).await });
                }
                true
            }
            HostMessage::Exit { id, code } => {
                self.run(|inner, out| {
                    if inner.sessions.get(&id).is_some_and(|l| l.state.phase.is_live()) {
                        if code >= 0 {
                            self.set_phase(inner, out, &id, SshPhase::Closed, None, Some(code));
                        } else {
                            self.set_phase(inner, out, &id, SshPhase::Error, Some(SshErrorCode::Reset), None);
                        }
                    }
                });
                false // the caller still updates `alive` and the automation
            }
        }
    }

    fn save_password(&self, secret: SecretOwner, password: Zeroizing<String>) {
        let (stores, events) = (self.deps.stores.clone(), self.deps.events.clone());
        self.spawn(async move {
            let vault = stores.vault().await;
            let saved = blocking(move || match &secret {
                SecretOwner::Identity(id) => vault.lock().set_identity_password(id, &password),
                SecretOwner::Host(id) => vault.lock().set_password(id, &password),
            })
            .await;
            if matches!(saved, Ok(SetPassword::Saved { .. })) {
                events.vault_changed();
            }
        });
    }

    fn live_of(&self, id: &str) -> Option<(u64, Kind, String, u16, String, String, SecretOwner)> {
        let inner = self.inner.lock();
        let l = inner.sessions.get(id).filter(|l| l.state.phase.is_live())?;
        Some((l.generation, l.kind, l.host.clone(), l.port, l.user.clone(), l.endpoint.clone(), l.secret.clone()))
    }

    fn same_live(&self, id: &str, generation: u64) -> bool {
        self.inner.lock().sessions.get(id).is_some_and(|l| l.generation == generation)
    }

    async fn on_host_key(&self, id: String, prompt_id: String, key: String) {
        let send = |accept: bool, error: Option<SshErrorCode>| {
            self.deps.host.send(HostCommand::HostKeyAnswer { id: id.clone(), prompt_id: prompt_id.clone(), accept, error });
        };
        let Some((generation, _, host, port, _, endpoint, _)) = self.live_of(&id) else {
            send(false, Some(SshErrorCode::Cancelled));
            return;
        };
        let blob = node_base64(&key);
        let known = self.deps.stores.known_hosts().await;
        let judged = known.lock().judge(&host, port, &blob);
        let (reason, fingerprints, types) = match &judged.judgement {
            HostKeyJudgement::Match => {
                send(true, None);
                return;
            }
            HostKeyJudgement::Unknown => ("unknown", vec![], vec![]),
            HostKeyJudgement::NewType { known_types } => ("newType", vec![], known_types.clone()),
            HostKeyJudgement::Changed { known_fingerprints } => ("changed", known_fingerprints.clone(), vec![]),
        };
        let mut body = Map::new();
        body.insert("kind".into(), json!("hostKey"));
        body.insert("endpoint".into(), json!(endpoint));
        body.insert("keyType".into(), json!(judged.key_type));
        body.insert("fingerprint".into(), json!(judged.fingerprint));
        body.insert("reason".into(), json!(reason));
        body.insert("knownFingerprints".into(), json!(fingerprints));
        body.insert("knownTypes".into(), json!(types));
        let group_key = format!("hk:{}|{}", known_host_id(&host, port), judged.fingerprint);
        let answer = self.wait(self.ask(&id, Some(group_key), body)).await;
        if !self.same_live(&id, generation) {
            return; // the cell was closed: its owner's session is gone
        }
        match &answer.kind {
            AnswerKind::HostKey(choice) => {
                if *choice != HostKeyChoice::Once {
                    // A read-only store cannot save; the key is accepted for this connection. A failed write must not look
                    // like success. Once per group: every cell of the prompt gets the same outcome.
                    let mode = if *choice == HostKeyChoice::Replace { TrustMode::Replace } else { TrustMode::Save };
                    let saved = *answer
                        .once
                        .get_or_init(|| {
                            let (known, host, blob) = (known.clone(), host.clone(), blob.clone());
                            blocking(move || known.lock().trust(&host, port, &blob, mode).is_ok())
                        })
                        .await;
                    if !saved {
                        send(false, Some(SshErrorCode::Unknown));
                        return;
                    }
                }
                send(true, None);
            }
            AnswerKind::Cancel { timeout: true } => send(false, Some(SshErrorCode::Cancelled)),
            _ => {
                send(false, Some(if reason == "changed" { SshErrorCode::HostKeyChanged } else { SshErrorCode::HostKeyRejected }))
            }
        }
    }

    async fn on_auth_prompt(&self, id: String, prompt_id: String, prompt: AuthPromptInfo) {
        let send = |values: Option<Vec<Zeroizing<String>>>| {
            self.deps.host.send(HostCommand::AuthAnswer { id: id.clone(), prompt_id: prompt_id.clone(), values });
        };
        let Some((generation, kind, _, _, user, endpoint, secret)) = self.live_of(&id) else {
            send(None);
            return;
        };
        // A sudo password (0.9.9) is asked only for SFTP sessions and never saved.
        if prompt.kind == AuthPromptKind::Sudo && kind != Kind::Session {
            send(None);
            return;
        }
        let mut body = Map::new();
        match prompt.kind {
            AuthPromptKind::Password => {
                let read_only = self.deps.stores.vault().await.lock().read_only();
                body.insert("kind".into(), json!("password"));
                body.insert("user".into(), json!(user));
                body.insert("endpoint".into(), json!(endpoint));
                body.insert("canSave".into(), json!(!read_only));
                body.insert("retry".into(), json!(prompt.retry));
            }
            AuthPromptKind::Sudo => {
                let saved = self.saved_password(&secret).await.is_ok();
                body.insert("kind".into(), json!("sudo"));
                body.insert("user".into(), json!(user));
                body.insert("endpoint".into(), json!(endpoint));
                body.insert("canUseSaved".into(), json!(saved));
                body.insert("retry".into(), json!(prompt.retry));
            }
            AuthPromptKind::Keyboard => {
                let fields: Vec<Value> = prompt
                    .fields
                    .iter()
                    .take(10)
                    .map(|f| json!({ "text": sanitize_server_text(&f.text, 200), "echo": f.echo }))
                    .collect();
                body.insert("kind".into(), json!("keyboard"));
                body.insert("endpoint".into(), json!(endpoint));
                body.insert("name".into(), json!(sanitize_server_text(prompt.name.as_deref().unwrap_or(""), 200)));
                body.insert(
                    "instructions".into(),
                    json!(sanitize_server_text(prompt.instructions.as_deref().unwrap_or(""), SERVER_TEXT_MAX)),
                );
                body.insert("fields".into(), Value::Array(fields));
            }
        }
        let answer = self.wait(self.ask(&id, None, body)).await;
        if !self.same_live(&id, generation) {
            return;
        }
        let AnswerKind::Values { values, remember, use_saved } = &answer.kind else {
            send(None);
            return;
        };
        if prompt.kind == AuthPromptKind::Sudo {
            if !*use_saved {
                send(Some(values.clone()));
                return;
            }
            let now = self.saved_password(&secret).await.ok();
            send(now.map(|p| vec![p]));
            return;
        }
        // I1: only the latest answer decides; a retry answered without "remember" must not save an earlier (wrong) one.
        let pending = (prompt.kind == AuthPromptKind::Password && *remember).then(|| values.first().cloned()).flatten();
        if let Some(l) = self.inner.lock().sessions.get_mut(&id).filter(|l| l.generation == generation) {
            l.pending_save = pending;
        }
        send(Some(values.clone()));
    }

    /// `killed(cellId)`: the user closed or disconnected the cell.
    pub fn killed(&self, cell_id: &str) {
        let state = self.deps.state.state();
        self.run(|inner, out| {
            self.withdraw(inner, out, cell_id);
            let Some(live) = inner.sessions.get_mut(cell_id) else { return };
            live.pending_save = None;
            if find_cell(&state, cell_id).is_none() {
                inner.sessions.shift_remove(cell_id);
                return;
            }
            if live.state.phase.is_live() {
                self.set_phase(inner, out, cell_id, SshPhase::Closed, None, None);
            }
        });
    }

    /// `hostCrashed()`: every cell session ended (the SSH cells' owner restarted).
    pub fn host_crashed(&self) {
        self.run(|inner, out| {
            let ids: Vec<String> =
                inner.sessions.iter().filter(|(_, l)| l.kind == Kind::Cell).map(|(id, _)| id.clone()).collect();
            for id in ids {
                self.withdraw(inner, out, &id);
                if inner.sessions.get(&id).is_some_and(|l| l.state.phase.is_live()) {
                    self.set_phase(inner, out, &id, SshPhase::Error, Some(SshErrorCode::PtyHostCrashed), None);
                }
            }
        });
    }

    /// `sessionHostCrashed(host)`: every non-cell session of that owner ended.
    pub fn session_host_crashed(&self, host: SessionHostKind) {
        let code = if host == SessionHostKind::Db { SshErrorCode::DbHostCrashed } else { SshErrorCode::SftpHostCrashed };
        self.run(|inner, out| {
            let ids: Vec<String> = inner
                .sessions
                .iter()
                .filter(|(id, l)| l.kind == Kind::Session && session_host_of(id) == Some(host))
                .map(|(id, _)| id.clone())
                .collect();
            for id in ids {
                self.withdraw(inner, out, &id);
                if inner.sessions.get(&id).is_some_and(|l| l.state.phase.is_live()) {
                    self.set_phase(inner, out, &id, SshPhase::Error, Some(code), None);
                }
            }
        });
    }

    /// `endSession(id)`: a non-cell session was disconnected (or idled out): its prompt goes, it reads closed and is
    /// forgotten.
    pub fn end_session(&self, id: &str) {
        self.run(|inner, out| {
            self.withdraw(inner, out, id);
            let Some(live) = inner.sessions.get_mut(id) else { return };
            if live.kind != Kind::Session {
                return;
            }
            live.pending_save = None;
            if live.state.phase.is_live() {
                self.set_phase(inner, out, id, SshPhase::Closed, None, None);
            }
            inner.sessions.shift_remove(id);
        });
    }

    /// `stateChanged(state)`: passwords of deleted hosts and identities go; ended sessions of removed cells are forgotten.
    pub fn state_changed(&self, state: &Value) {
        let ids = |key: &str| -> HashSet<String> {
            state
                .get(key)
                .and_then(Value::as_array)
                .map(|l| l.iter().filter_map(|h| h.get("id").and_then(Value::as_str).map(str::to_string)).collect())
                .unwrap_or_default()
        };
        let (hosts, identities) = (ids("sshHosts"), ids("sshIdentities"));
        let (stores, events) = (self.deps.stores.clone(), self.deps.events.clone());
        self.spawn(async move {
            let vault = stores.vault().await;
            let (a, b) = blocking(move || {
                let mut v = vault.lock();
                let a = v.prune_passwords(&|id| hosts.contains(id)).unwrap_or(false);
                let b = v.prune_identity_passwords(&|id| identities.contains(id)).unwrap_or(false);
                (a, b)
            })
            .await;
            if a {
                events.vault_changed();
            }
            if b {
                events.vault_changed();
            }
        });
        self.inner.lock().sessions.retain(|id, l| l.state.phase.is_live() || find_cell(state, id).is_some());
    }

    fn of_kind(id: &str, kind: Kind, host: Option<SessionHostKind>) -> bool {
        let of = session_host_of(id);
        let k = if of.is_some() { Kind::Session } else { Kind::Cell };
        k == kind && host.is_none_or(|h| of == Some(h))
    }

    fn snapshot(&self, kind: Kind, host: Option<SessionHostKind>) -> (Vec<SessionState>, Vec<(String, Value)>) {
        let inner = self.inner.lock();
        let sessions = inner
            .sessions
            .iter()
            .filter(|(id, l)| l.kind == kind && Self::of_kind(id, kind, host))
            .map(|(_, l)| l.state.clone())
            .collect();
        let prompts = inner
            .prompt_of_cell
            .iter()
            .filter_map(|(cell, gid)| {
                let g = inner.groups.get(gid)?;
                Self::of_kind(cell, kind, host).then(|| (cell.clone(), g.prompt.clone()))
            })
            .collect();
        (sessions, prompts)
    }

    fn snapshot_json(&self, kind: Kind, host: Option<SessionHostKind>) -> Value {
        let (sessions, prompts) = self.snapshot(kind, host);
        json!({
            "sessions": sessions.iter().map(SessionState::to_json).collect::<Vec<_>>(),
            "prompts": prompts.into_iter().map(|(c, p)| json!({ "cellId": c, "prompt": p })).collect::<Vec<_>>(),
        })
    }

    /// `sessions()`: cell sessions and their prompts (what the renderer's SSH store holds), `SshSessionsSnapshot`.
    pub fn sessions(&self) -> Value {
        self.snapshot_json(Kind::Cell, None)
    }

    /// `sessionSnapshot(host)`: the non-cell sessions of one owner and their prompts (`cellId` is the session id).
    pub fn session_snapshot(&self, host: SessionHostKind) -> Value {
        self.snapshot_json(Kind::Session, Some(host))
    }

    /// The open prompts of one owner's sessions: `(sessionId, prompt)`.
    pub fn session_prompts(&self, host: SessionHostKind) -> Vec<(String, Value)> {
        self.snapshot(Kind::Session, Some(host)).1
    }

    /// The state of one session (tests, the SFTP / DB services).
    pub fn session_state(&self, id: &str) -> Option<SessionState> {
        self.inner.lock().sessions.get(id).map(|l| l.state.clone())
    }
}

type Slot = parking_lot::RwLock<Option<Arc<dyn SshHostLink>>>;

/// The owners of SSH connections in one process, by id (1.1.4 main's `host` of the coordinator: cells to the Pty Host,
/// `sftp:` ids to the SFTP Host, `db:` ids to the DB Host). Each slot is filled by the package that owns it (P5 SSH cells,
/// T1 SFTP sessions, D2 DB tunnels); a command for an empty slot is not delivered (the connect then fails with
/// `ptyHostCrashed` / `sftpHostCrashed` / `dbHostCrashed`, like 1.1.4 with no host running).
#[derive(Default)]
pub struct HostRouter {
    cells: Slot,
    sftp: Slot,
    db: Slot,
}

impl std::fmt::Debug for HostRouter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("HostRouter")
            .field("cells", &self.cells.read().is_some())
            .field("sftp", &self.sftp.read().is_some())
            .field("db", &self.db.read().is_some())
            .finish()
    }
}

impl HostRouter {
    pub fn new() -> Arc<HostRouter> {
        Arc::new(HostRouter::default())
    }

    /// Sets the owner of `kind` (None: the SSH cells).
    pub fn set(&self, kind: Option<SessionHostKind>, link: Arc<dyn SshHostLink>) {
        *self.slot(kind).write() = Some(link);
    }

    fn slot(&self, kind: Option<SessionHostKind>) -> &Slot {
        match kind {
            None => &self.cells,
            Some(SessionHostKind::Sftp) => &self.sftp,
            Some(SessionHostKind::Db) => &self.db,
        }
    }
}

impl SshHostLink for HostRouter {
    fn send(&self, cmd: HostCommand) -> bool {
        let link = self.slot(session_host_of(cmd.id())).read().clone();
        link.is_some_and(|l| l.send(cmd))
    }
}
