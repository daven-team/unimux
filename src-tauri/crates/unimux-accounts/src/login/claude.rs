//! `LoginManager` (port of src/main/auth/login.ts): the Claude logins (main, new saved account, a saved card signed in
//! again) and the main Codex login.
//!
//! One session at a time. 1.1.4 ran on one JS thread; here the timers are tokio tasks and IPC calls come from any thread, so
//! every step that JS ran without an `await` in between runs under the session's lock, and every `if (session.ended) return`
//! after an await is kept. A timer task that ends the session removes its own handle first, so ending never aborts the task
//! that is still finishing it.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Weak};
use std::time::Duration;

use futures::FutureExt;
use futures::future::Shared;
use parking_lot::Mutex;
use serde_json::Value;
use tokio::task::AbortHandle;
use tokio_util::sync::CancellationToken;

use super::snapshot::ProfileSnapshot;
use super::{
    DuplicateOf, Fut, KnownIdentity, LoginChange, LoginError, LoginStartResult, LoginState, LoginStatus, LoginTarget,
    LoginTimings, Provider, PtySpec, dir_text, login_command, new_session_ids, same_dir,
};
use crate::identity::{
    AccountIdentity, Custody, IdentityMatch, TokenFamily, compare_identity, custody_of, family_of, identity_fields,
    is_account_id,
};
use crate::reconcile::LiveBackupFailed;
use crate::store::{AccountsStore, ManagedAccount, StoreError};

const IDENTITY_TRIES: usize = 5;
const RESTORE_TRIES: usize = 3;

/// Why `beforeMainLogin` refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BeforeMainError {
    /// `LiveBackupFailed` with its reason (`busy` answers `busy`, anything else `backup`).
    Backup(LiveBackupFailed),
    /// Any other failure (answers `busy`).
    Other,
}

/// The seams of the login manager (`LoginDeps`).
pub trait LoginDeps: Send + Sync + 'static {
    fn store(&self) -> &AccountsStore;
    /// Starts the login command in a terminal; `env` holds only the extra variables.
    fn spawn_pty(&self, spec: PtySpec) -> Fut<Result<(), ()>>;
    /// True when the provider's CLI is known not to be installed: the login does not start (`cliMissing`).
    fn cli_missing(&self, _provider: Provider) -> Fut<bool> {
        async { false }.boxed()
    }
    /// False when Claude Code has no main login: a new account is offered as main. `None`: not asked (no offer).
    fn has_main_login(&self) -> Option<Fut<Result<bool, ()>>> {
        None
    }
    fn kill_pty(&self, id: &str);
    /// Fingerprint (never the token) of the credentials the login writes, `None` when there are none yet.
    fn fingerprint(&self, provider: Provider, config_dir: Option<PathBuf>) -> Fut<Result<Option<String>, ()>>;
    /// Drops cached failed credential reads (macOS Keychain) so the login sees fresh credentials.
    fn reset_credential_cache(&self) {}
    fn identity(&self, provider: Provider, config_dir: Option<PathBuf>) -> Fut<Result<AccountIdentity, ()>>;
    /// The live Claude login and every saved account that is not set aside.
    fn known_identities(&self) -> Fut<Result<Vec<KnownIdentity>, ()>>;
    /// Login files of a saved profile, taken before it is signed in again (memory only).
    fn snapshot_profile(&self, dir: PathBuf) -> Fut<Result<ProfileSnapshot, ()>>;
    /// Puts a snapshot back.
    fn restore_profile(&self, dir: PathBuf, snapshot: Arc<ProfileSnapshot>) -> Fut<Result<(), ()>>;
    /// True once the profile's `oauthAccount` is no longer the snapshot's.
    fn identity_rewritten(&self, dir: PathBuf, snapshot: Arc<ProfileSnapshot>) -> Fut<Result<bool, ()>>;
    /// Before a main Claude login: the outgoing live login is backed up into its record.
    fn before_main_login(&self) -> Fut<Result<(), BeforeMainError>> {
        async { Ok(()) }.boxed()
    }
    fn emit(&self, state: LoginState);
    /// Called after a login succeeded.
    fn on_changed(&self, change: LoginChange);
    /// False where isolated Claude profiles cannot work (macOS keeps Claude tokens in the Keychain).
    fn profiles_supported(&self) -> bool {
        true
    }
    /// True while the main account is being swapped.
    fn swap_running(&self) -> bool {
        false
    }
}

/// A restore that failed: the card holds another login, so it is set aside until its snapshot is put back.
struct Parked {
    dir: PathBuf,
    snapshot: Arc<ProfileSnapshot>,
    custody: Custody,
    family: TokenFamily,
}

#[derive(Default)]
struct SessionState {
    pending_id: Option<String>,
    snapshot: Option<Arc<ProfileSnapshot>>,
    initial: Option<String>,
    settled: bool,
    ended: bool,
    polling: bool,
    poll: Option<AbortHandle>,
    settle: Option<AbortHandle>,
    timeout: Option<AbortHandle>,
}

struct Session {
    id: String,
    pty_id: String,
    provider: Provider,
    target: LoginTarget,
    config_dir: Option<PathBuf>,
    /// Cancelled when the session ends (wakes the identity sleeps).
    ended_token: CancellationToken,
    st: Mutex<SessionState>,
}

impl Session {
    fn ended(&self) -> bool {
        self.st.lock().ended
    }
    fn account_id(&self) -> Option<&str> {
        match &self.target {
            LoginTarget::Account(id) => Some(id),
            _ => None,
        }
    }
}

type SharedBool = Shared<Fut<bool>>;
type SharedUnit = Shared<Fut<()>>;

#[derive(Default)]
struct Inner {
    current: Option<Arc<Session>>,
    /// Restores in progress per profile dir (with their retries); a new login of that card waits for them.
    restoring: Vec<(PathBuf, u64, SharedBool)>,
    /// Failed restores per record id, in memory only, in the order they failed.
    parked: Vec<(String, Arc<Parked>)>,
    /// The retry of the parked restores in progress.
    retrying: Option<(u64, SharedUnit)>,
    seq: u64,
}

impl Inner {
    fn next(&mut self) -> u64 {
        self.seq += 1;
        self.seq
    }
    fn restoring_of(&self, dir: &Path) -> Option<SharedBool> {
        self.restoring.iter().find(|(d, ..)| d == dir).map(|(.., f)| f.clone())
    }
    fn parked_of(&self, id: &str) -> Option<Arc<Parked>> {
        self.parked.iter().find(|(i, _)| i == id).map(|(_, p)| p.clone())
    }
    fn set_restoring(&mut self, dir: &Path, seq: u64, f: SharedBool) {
        self.restoring.retain(|(d, ..)| d != dir);
        self.restoring.push((dir.to_path_buf(), seq, f));
    }
}

/// `LoginManager`.
pub struct LoginManager {
    deps: Arc<dyn LoginDeps>,
    t: LoginTimings,
    /// The runtime the timers and restores run on (calls also come from threads outside it: the pty service's crash hook).
    rt: tokio::runtime::Handle,
    inner: Mutex<Inner>,
    me: Weak<LoginManager>,
}

impl std::fmt::Debug for LoginManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LoginManager").finish_non_exhaustive()
    }
}

fn string_of(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// `identity.email || identity.accountUuid` (JS truthiness).
fn has_identity(identity: &AccountIdentity) -> bool {
    non_empty(identity.email.as_deref()).is_some() || non_empty(identity.account_uuid.as_deref()).is_some()
}

fn non_empty(s: Option<&str>) -> Option<&str> {
    s.filter(|s| !s.is_empty())
}

impl LoginManager {
    pub fn new(deps: Arc<dyn LoginDeps>, timings: LoginTimings, rt: tokio::runtime::Handle) -> Arc<Self> {
        Arc::new_cyclic(|me| Self { deps, t: timings, rt, inner: Mutex::new(Inner::default()), me: me.clone() })
    }

    fn me(&self) -> Arc<Self> {
        self.me.upgrade().expect("the login manager is alive while it runs")
    }

    /// `start(request)`: the request comes from the renderer and is checked here.
    pub async fn start(&self, request: &Value) -> LoginStartResult {
        let invalid = LoginStartResult::refused("invalid request");
        let provider = Provider::parse(request.get("provider"));
        let target = request.get("target").filter(|t| t.is_object());
        let (Some(provider), Some(target)) = (provider, target) else { return invalid };
        let kind = string_of(target.get("type"));
        if provider == Provider::Codex && kind != Some("main") {
            return invalid;
        }
        if !self.deps.profiles_supported() && matches!(kind, Some("new" | "account")) {
            return LoginStartResult::refused("unsupported");
        }
        if self.deps.swap_running() {
            return LoginStartResult::refused("busy");
        }
        let target = match kind {
            Some("account") => {
                let id = string_of(target.get("id")).filter(|id| is_account_id(id));
                let Some(id) = id.filter(|id| self.deps.store().list().iter().any(|a| a.id == *id)) else { return invalid };
                LoginTarget::Account(id.to_string())
            }
            Some("new") => LoginTarget::New,
            Some("main") => LoginTarget::Main,
            _ => return invalid,
        };
        // A missing CLI would only print "command not found" in the login terminal: the renderer offers the install instead.
        if self.deps.cli_missing(provider).await {
            return LoginStartResult::refused("cliMissing");
        }

        let previous = self.inner.lock().current.clone();
        if let Some(previous) = previous {
            self.cancel(&previous.id);
        }

        let (id, pty_id) = new_session_ids();
        let mut pending_id = None;
        let config_dir = match &target {
            LoginTarget::New => match self.deps.store().prepare() {
                Ok((pending, dir)) => {
                    pending_id = Some(pending);
                    Some(dir)
                }
                Err(_) => return LoginStartResult::refused("spawn"),
            },
            LoginTarget::Account(account) => self.deps.store().dir_of(account).ok(),
            LoginTarget::Main => None,
        };
        let session = Arc::new(Session {
            id: id.clone(),
            pty_id: pty_id.clone(),
            provider,
            target: target.clone(),
            config_dir,
            ended_token: CancellationToken::new(),
            st: Mutex::new(SessionState { pending_id, ..SessionState::default() }),
        });
        self.inner.lock().current = Some(session.clone());

        if provider == Provider::Claude
            && let LoginTarget::Account(account) = &target
        {
            let dir = session.config_dir.clone().unwrap_or_default();
            // A restore of this card still running (a cancelled login) lands first, and a failed one is tried again: the
            // snapshot must be the card's own login, never the other account's files that are about to be replaced.
            let running = self.inner.lock().restoring_of(&dir);
            if let Some(running) = running {
                running.await;
            }
            if self.inner.lock().parked_of(account).is_some() {
                self.retry_parked(account).await;
            }
            if session.ended() {
                return LoginStartResult::refused("cancelled");
            }
            if self.inner.lock().parked_of(account).is_some() {
                self.end(&session);
                return LoginStartResult::refused("restore");
            }
            match self.deps.snapshot_profile(dir).await {
                Ok(snapshot) => session.st.lock().snapshot = Some(Arc::new(snapshot)),
                Err(()) => {
                    // No snapshot: a wrong account could not be undone, so nothing starts.
                    self.end(&session);
                    return LoginStartResult::refused("spawn");
                }
            }
        } else if provider == Provider::Claude && target == LoginTarget::Main {
            if let Err(error) = self.deps.before_main_login().await {
                // No backup: the live login would be lost, so nothing starts. The card of the outgoing account is named.
                self.end(&session);
                return match error {
                    BeforeMainError::Backup(e) if e.reason != "busy" => LoginStartResult::Refused {
                        error: "backup",
                        email: self.deps.store().live().and_then(|l| l.identity.email).filter(|e| !e.is_empty()),
                    },
                    _ => LoginStartResult::refused("busy"),
                };
            }
        }
        if session.ended() {
            return LoginStartResult::refused("cancelled");
        }

        self.deps.reset_credential_cache();
        let initial = self.deps.fingerprint(provider, session.config_dir.clone()).await.unwrap_or(None);
        {
            let mut st = session.st.lock();
            if st.ended {
                return LoginStartResult::refused("cancelled");
            }
            st.initial = initial;
        }

        // A user-level token or API key must not override the profile's own login.
        let env = match &session.config_dir {
            Some(dir) => vec![
                ("CLAUDE_CONFIG_DIR".to_string(), dir_text(dir)),
                ("CLAUDE_CODE_OAUTH_TOKEN".to_string(), String::new()),
                ("ANTHROPIC_API_KEY".to_string(), String::new()),
            ],
            None => Vec::new(),
        };
        let spec = PtySpec { id: pty_id.clone(), env, command: login_command(provider).to_string() };
        if self.deps.spawn_pty(spec).await.is_err() {
            self.end(&session);
            self.discard(&session);
            return LoginStartResult::refused("spawn");
        }

        let me = self.me();
        let s = session.clone();
        let poll_every = self.t.poll;
        let poll = self.rt.spawn(async move {
            let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + poll_every, poll_every);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                me.tick(&s).await;
            }
        });
        let me = self.me();
        let s = session.clone();
        let timeout_after = self.t.timeout;
        let timeout = self.rt.spawn(async move {
            tokio::time::sleep(timeout_after).await;
            me.on_timeout(&s);
        });
        {
            let mut st = session.st.lock();
            if st.ended {
                // Cancelled while the terminal was being started: it must not keep running behind a closed dialog.
                drop(st);
                poll.abort();
                timeout.abort();
                self.kill(&session);
                return LoginStartResult::refused("cancelled");
            }
            st.poll = Some(poll.abort_handle());
            st.timeout = Some(timeout.abort_handle());
        }
        self.deps.emit(LoginState::new(&id, LoginStatus::Waiting));
        LoginStartResult::Started { session_id: id, pty_id }
    }

    /// True while a login session is in progress.
    pub fn is_active(&self) -> bool {
        self.inner.lock().current.is_some()
    }

    /// True while a main Claude login is in progress.
    pub fn is_main_active(&self) -> bool {
        self.inner.lock().current.as_ref().is_some_and(|s| s.provider == Provider::Claude && s.target == LoginTarget::Main)
    }

    /// True while the profile `dir` must not be renewed: a login of that card runs, or its restore is running or failed.
    pub fn holds_profile(&self, dir: &Path) -> bool {
        let inner = self.inner.lock();
        if inner.current.as_ref().and_then(|s| s.config_dir.as_deref()).is_some_and(|d| same_dir(d, dir)) {
            return true;
        }
        if inner.restoring.iter().any(|(d, ..)| same_dir(d, dir)) {
            return true;
        }
        inner.parked.iter().any(|(_, p)| same_dir(&p.dir, dir))
    }

    /// Records whose failed restore is kept for a retry (set aside meanwhile); empty again after an app restart.
    pub fn parked_ids(&self) -> Vec<String> {
        self.inner.lock().parked.iter().map(|(id, _)| id.clone()).collect()
    }

    /// `retryParkedRestores(waitMs?)`: tries the failed restores again (before every usage poll). One retry runs at a time
    /// (a call meanwhile joins it); with `wait` the caller waits at most that long and the retry goes on by itself.
    pub async fn retry_parked_restores(&self, wait: Option<Duration>) {
        let run = {
            let mut inner = self.inner.lock();
            match &inner.retrying {
                Some((_, run)) => run.clone(),
                None => {
                    let seq = inner.next();
                    let me = self.me();
                    let task = self.rt.spawn(async move {
                        me.retry_all_parked().await;
                        let mut inner = me.inner.lock();
                        if inner.retrying.as_ref().is_some_and(|(s, _)| *s == seq) {
                            inner.retrying = None;
                        }
                    });
                    let run: SharedUnit = async move {
                        let _ = task.await;
                    }
                    .boxed()
                    .shared();
                    inner.retrying = Some((seq, run.clone()));
                    run
                }
            }
        };
        match wait {
            None => run.await,
            Some(wait) => {
                let _ = tokio::time::timeout(wait, run).await;
            }
        }
    }

    async fn retry_all_parked(&self) {
        let ids: Vec<String> = self.inner.lock().parked.iter().map(|(id, _)| id.clone()).collect();
        for id in ids {
            let busy = self.inner.lock().current.as_ref().is_some_and(|s| s.account_id() == Some(id.as_str()));
            if busy {
                continue;
            }
            self.retry_parked(&id).await;
        }
    }

    /// `cancel(sessionId)`.
    pub fn cancel(&self, session_id: &str) {
        let Some(session) = self.current_if(session_id) else { return };
        let written = Self::login_written(&session);
        self.end(&session);
        self.kill(&session);
        self.undo(&session, written);
        self.discard(&session);
    }

    /// The pty service died: ends the current session as failed.
    pub fn fail_active(&self) {
        let Some(session) = self.inner.lock().current.clone() else { return };
        let written = Self::login_written(&session);
        self.end(&session);
        self.kill(&session);
        self.undo(&session, written);
        self.discard(&session);
        self.deps.emit(LoginState::failed(&session.id, LoginError::Spawn));
    }

    /// Cancels the active session when it targets this managed account (the account is being removed: nothing is put back).
    pub fn cancel_for(&self, account_id: &str) {
        let session = {
            let mut inner = self.inner.lock();
            inner.parked.retain(|(id, _)| id != account_id);
            inner.current.clone()
        };
        let Some(session) = session.filter(|s| s.account_id() == Some(account_id)) else { return };
        session.st.lock().snapshot = None;
        self.cancel(&session.id);
    }

    pub fn dispose(&self) {
        let current = self.inner.lock().current.clone();
        if let Some(session) = current {
            self.cancel(&session.id);
        }
    }

    fn current_if(&self, session_id: &str) -> Option<Arc<Session>> {
        self.inner.lock().current.clone().filter(|s| s.id == session_id)
    }

    async fn tick(&self, session: &Arc<Session>) {
        {
            let mut st = session.st.lock();
            if st.ended || st.settled || st.polling || st.settle.is_some() {
                return;
            }
            st.polling = true;
        }
        self.deps.reset_credential_cache();
        let fingerprint = self.deps.fingerprint(session.provider, session.config_dir.clone()).await.unwrap_or(None);
        let mut st = session.st.lock();
        st.polling = false;
        if st.ended || st.settled || st.settle.is_some() {
            return;
        }
        if fingerprint.is_some() && fingerprint != st.initial {
            let me = self.me();
            let s = session.clone();
            let after = self.t.settle;
            let task = self.rt.spawn(async move {
                tokio::time::sleep(after).await;
                me.finalize(&s).await;
            });
            st.settle = Some(task.abort_handle());
        }
    }

    fn on_timeout(&self, session: &Arc<Session>) {
        let written = {
            let mut st = session.st.lock();
            if st.ended || st.settled {
                return;
            }
            // This task itself: never aborted by the end below.
            st.timeout = None;
            let written = st.settled || st.settle.is_some();
            st.settled = true;
            written
        };
        self.end(session);
        self.kill(session);
        self.undo(session, written);
        self.discard(session);
        self.deps.emit(LoginState::failed(&session.id, LoginError::Timeout));
    }

    async fn finalize(&self, session: &Arc<Session>) {
        if self.run_finalize(session).await.is_err() && !session.ended() {
            // A store failure must not leave the session half-finished.
            self.finish(session, LoginState::failed(&session.id, LoginError::Identity), true);
        }
    }

    async fn run_finalize(&self, session: &Arc<Session>) -> Result<(), StoreError> {
        {
            let mut st = session.st.lock();
            if st.ended || st.settled {
                return Ok(());
            }
            st.settled = true;
            // The settle timer is this task: forgotten, not aborted.
            st.settle = None;
            Self::clear_timers(&mut st);
        }
        self.kill(session);

        // A re-login of a card: Claude Code may write the new credentials before the new `oauthAccount`, so the identity
        // counts only once the profile's `oauthAccount` is no longer the snapshot's (checked before each read).
        let snapshot = match session.target {
            LoginTarget::Account(_) => session.st.lock().snapshot.clone(),
            _ => None,
        };
        let mut identity = AccountIdentity::default();
        let mut confirmed = snapshot.is_none();
        for attempt in 0..IDENTITY_TRIES {
            if let (Some(snapshot), Some(dir)) = (&snapshot, &session.config_dir) {
                confirmed = self.deps.identity_rewritten(dir.clone(), snapshot.clone()).await.unwrap_or(false);
                if session.ended() {
                    return Ok(());
                }
            }
            identity = self.deps.identity(session.provider, session.config_dir.clone()).await.unwrap_or_default();
            if session.ended() {
                return Ok(());
            }
            if (has_identity(&identity) && confirmed) || attempt == IDENTITY_TRIES - 1 {
                break;
            }
            tokio::select! {
                () = tokio::time::sleep(self.t.identity_gap) => {}
                () = session.ended_token.cancelled() => {}
            }
            if session.ended() {
                return Ok(());
            }
        }
        let email = non_empty(identity.email.as_deref()).map(str::to_string);
        if session.provider == Provider::Codex || session.target == LoginTarget::Main {
            let mut state = LoginState::new(&session.id, LoginStatus::Success);
            state.email = email;
            self.finish(session, state, false);
            self.deps.on_changed(LoginChange {
                provider: session.provider,
                record_id: None,
                own_change: session.provider == Provider::Claude,
            });
            return Ok(());
        }
        let expected = match &session.target {
            LoginTarget::Account(id) => self.deps.store().get(id).and_then(|r| r.identity.email).filter(|e| !e.is_empty()),
            _ => None,
        };
        if !has_identity(&identity) || !confirmed {
            if !self.restore_or_report(session, email.as_deref(), expected.as_deref()).await {
                return Ok(());
            }
            // The card's previous login is back; the dialog names the card.
            self.finish(session, LoginState::failed(&session.id, LoginError::Identity).expected(expected.as_deref()), true);
            return Ok(());
        }
        let known = self.deps.known_identities().await.unwrap_or_default();
        if session.ended() {
            return Ok(());
        }
        let own = session.account_id();
        // The live login has no record id: it is compared too (a re-login of a card skips only that card itself).
        let same_account: Vec<&KnownIdentity> = known
            .iter()
            .filter(|k| (own.is_none() || k.record_id.as_deref() != own) && compare_identity(&k.identity, &identity) == IdentityMatch::Same)
            .collect();
        // Only a login the app really holds is a duplicate: the signed-in live login or a saved card with a login in it.
        let holder = same_account.iter().find(|k| k.live && !k.empty).or_else(|| same_account.iter().find(|k| !k.empty));
        if let Some(holder) = holder {
            if !self.restore_or_report(session, email.as_deref(), expected.as_deref()).await {
                return Ok(());
            }
            let named = non_empty(holder.identity.email.as_deref()).or(email.as_deref());
            let mut state = LoginState::new(&session.id, LoginStatus::Duplicate).email(named);
            state.duplicate_of = Some(if holder.live { DuplicateOf::Main } else { DuplicateOf::Saved });
            self.finish(session, state, true);
            return Ok(());
        }
        match &session.target {
            LoginTarget::New => {
                let offer_main = match self.deps.has_main_login() {
                    Some(f) => f.await.map(|has| !has).unwrap_or(false),
                    None => false,
                };
                if session.ended() {
                    return Ok(());
                }
                let record_id = session.st.lock().pending_id.clone().unwrap_or_default();
                let fields = identity_fields(&identity);
                self.deps.store().commit(&ManagedAccount {
                    id: record_id.clone(),
                    added_at: unimux_core::time::now_ms() as f64,
                    identity: fields,
                    custody: Some(Custody::App),
                    family: Some(TokenFamily::Own),
                    ..ManagedAccount::default()
                })?;
                session.st.lock().pending_id = None;
                // Records of this account without any login are replaced by the new one, so one card is left.
                for stale in &same_account {
                    let Some(stale_id) = stale.record_id.as_deref() else { continue };
                    if !stale.empty || stale_id == record_id {
                        continue;
                    }
                    // Read-only: the empty record stays hidden.
                    let _ = self.deps.store().remove(stale_id);
                }
                let mut state = LoginState::new(&session.id, LoginStatus::Success).email(email.as_deref());
                state.record_id = Some(record_id.clone());
                state.offer_main = offer_main;
                self.finish(session, state, false);
                self.deps.on_changed(LoginChange { provider: Provider::Claude, record_id: Some(record_id), own_change: false });
                Ok(())
            }
            LoginTarget::Account(id) => {
                // A card is signed in again only as the account it belongs to; another account never relabels it (R10).
                let record = self.deps.store().get(id);
                if record.as_ref().is_none_or(|r| compare_identity(&identity, &r.identity) != IdentityMatch::Same) {
                    if !self.restore_or_report(session, email.as_deref(), expected.as_deref()).await {
                        return Ok(());
                    }
                    let record_email = record.and_then(|r| r.identity.email);
                    let state = LoginState::new(&session.id, LoginStatus::Mismatch)
                        .email(email.as_deref())
                        .expected(record_email.as_deref());
                    self.finish(session, state, true);
                    return Ok(());
                }
                // A fresh token family of the card's own account: the app holds it alone (custody app, family own).
                let store = self.deps.store();
                store.update_identity(id, &identity, false)?;
                store.set_custody(id, Custody::App, None)?;
                store.set_family(id, TokenFamily::Own)?;
                store.set_held_tokens(id, None)?;
                self.finish(session, LoginState::new(&session.id, LoginStatus::Success).email(email.as_deref()), false);
                self.deps.on_changed(LoginChange { provider: Provider::Claude, record_id: Some(id.clone()), own_change: false });
                Ok(())
            }
            LoginTarget::Main => Ok(()),
        }
    }

    /// Restores the card; when that fails the session ends with `failed` / `restore` naming the card and this answers false.
    async fn restore_or_report(&self, session: &Arc<Session>, email: Option<&str>, expected: Option<&str>) -> bool {
        if self.restore(session).await {
            return true;
        }
        if !session.ended() {
            let state = LoginState::failed(&session.id, LoginError::Restore).email(email).expected(expected);
            self.finish(session, state, true);
        }
        false
    }

    /// Puts the card's previous login back (3 tries); when it still fails the card is set aside and the snapshot stays in
    /// memory for a later retry.
    async fn restore(&self, session: &Arc<Session>) -> bool {
        let snapshot = session.st.lock().snapshot.take();
        let (Some(snapshot), Some(dir)) = (snapshot, session.config_dir.clone()) else { return true };
        let restored = self.put_back(&dir, snapshot.clone()).await;
        if !restored && let Some(id) = session.account_id() {
            self.park(id, &dir, snapshot);
        }
        restored
    }

    /// Runs the restore tries for one dir, registered in `restoring` at once.
    fn put_back(&self, dir: &Path, snapshot: Arc<ProfileSnapshot>) -> SharedBool {
        let deps = self.deps.clone();
        let gap = self.t.restore_gap;
        let me = self.me.clone();
        let mut inner = self.inner.lock();
        let seq = inner.next();
        let owned = dir.to_path_buf();
        let task = self.rt.spawn(async move {
            let mut restored = false;
            for attempt in 0..RESTORE_TRIES {
                if attempt > 0 {
                    tokio::time::sleep(gap).await;
                }
                if deps.restore_profile(owned.clone(), snapshot.clone()).await.is_ok() {
                    restored = true;
                    break;
                }
            }
            if let Some(me) = me.upgrade() {
                me.inner.lock().restoring.retain(|(d, s, _)| !(d == &owned && *s == seq));
            }
            restored
        });
        let tracked: SharedBool = async move { task.await.unwrap_or(false) }.boxed().shared();
        inner.set_restoring(dir, seq, tracked.clone());
        tracked
    }

    fn park(&self, id: &str, dir: &Path, snapshot: Arc<ProfileSnapshot>) {
        let Some(record) = self.deps.store().get(id) else { return };
        {
            let mut inner = self.inner.lock();
            let previous = inner.parked_of(id);
            let entry = Arc::new(Parked {
                dir: dir.to_path_buf(),
                snapshot,
                custody: previous.as_ref().map_or_else(|| custody_of(record.custody), |p| p.custody),
                family: previous.as_ref().map_or_else(|| family_of(record.family), |p| p.family),
            });
            match inner.parked.iter_mut().find(|(i, _)| i == id) {
                Some(slot) => slot.1 = entry,
                None => inner.parked.push((id.to_string(), entry)),
            }
        }
        // Read-only: renewal stays blocked by holds_profile.
        let _ = self.deps.store().set_custody(id, Custody::Quarantined, None);
    }

    /// One more restore of a parked card; on success the card gets its previous custody and family back.
    async fn retry_parked(&self, id: &str) {
        let Some(entry) = self.inner.lock().parked_of(id) else { return };
        let running = self.inner.lock().restoring_of(&entry.dir);
        if let Some(running) = running {
            running.await;
        }
        let same = |me: &Self| me.inner.lock().parked_of(id).is_some_and(|p| Arc::ptr_eq(&p, &entry));
        if !same(self) {
            return;
        }
        if !self.put_back(&entry.dir, entry.snapshot.clone()).await {
            return;
        }
        if !same(self) {
            return;
        }
        self.inner.lock().parked.retain(|(i, _)| i != id);
        if self.deps.store().get(id).is_none() {
            return;
        }
        // The record stays set aside when this fails; its login is the card's own again.
        if self.deps.store().set_custody(id, entry.custody, None).is_ok() {
            let _ = self.deps.store().set_family(id, entry.family);
        }
    }

    /// The login has already written new files into the card's profile.
    fn login_written(session: &Session) -> bool {
        let st = session.st.lock();
        st.settled || st.settle.is_some()
    }

    /// A session that ends without a verdict puts the card's previous login back once the login wrote new files; a card whose
    /// login was not seen yet gets one more look (credentials that changed since the start, or that cannot be read, are
    /// another login). The dir counts as restoring meanwhile.
    fn undo(&self, session: &Arc<Session>, written: bool) {
        if written {
            let me = self.me();
            let s = session.clone();
            self.rt.spawn(async move {
                me.restore(&s).await;
            });
            return;
        }
        let (snapshot, initial) = {
            let mut st = session.st.lock();
            (st.snapshot.take(), st.initial.clone())
        };
        let (Some(snapshot), Some(dir), Some(id)) = (snapshot, session.config_dir.clone(), session.account_id()) else {
            return;
        };
        let id = id.to_string();
        let me = self.me();
        let provider = session.provider;
        let mut inner = self.inner.lock();
        let seq = inner.next();
        let owned = dir.clone();
        let task = self.rt.spawn(async move {
            me.deps.reset_credential_cache();
            let now = me.deps.fingerprint(provider, Some(owned.clone())).await.ok();
            let restored = if now.as_ref() == Some(&initial) {
                true
            } else {
                let restored = me.put_back(&owned, snapshot.clone()).await;
                if !restored {
                    me.park(&id, &owned, snapshot);
                }
                restored
            };
            me.inner.lock().restoring.retain(|(d, s, _)| !(d == &owned && *s == seq));
            restored
        });
        let look: SharedBool = async move { task.await.unwrap_or(false) }.boxed().shared();
        inner.set_restoring(&dir, seq, look);
    }

    fn finish(&self, session: &Arc<Session>, state: LoginState, discard: bool) {
        session.st.lock().snapshot = None;
        self.end(session);
        if discard {
            self.discard(session);
        }
        self.deps.emit(state);
    }

    fn clear_timers(st: &mut SessionState) {
        for handle in [st.poll.take(), st.settle.take(), st.timeout.take()].into_iter().flatten() {
            handle.abort();
        }
    }

    /// Clears every timer and forgets the session; the single place a session ends.
    fn end(&self, session: &Arc<Session>) {
        {
            let mut st = session.st.lock();
            st.ended = true;
            Self::clear_timers(&mut st);
        }
        session.ended_token.cancel();
        let mut inner = self.inner.lock();
        if inner.current.as_ref().is_some_and(|c| Arc::ptr_eq(c, session)) {
            inner.current = None;
        }
    }

    fn kill(&self, session: &Session) {
        // The terminal may already be gone.
        self.deps.kill_pty(&session.pty_id);
    }

    fn discard(&self, session: &Session) {
        let Some(id) = session.st.lock().pending_id.take() else { return };
        // Best effort; the directory is not listed anywhere.
        let _ = self.deps.store().remove(&id);
    }
}
