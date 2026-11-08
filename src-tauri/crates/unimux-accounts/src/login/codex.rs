//! `CodexLoginManager` (port of src/main/auth/codexLogin.ts, 1.1.2): "Add Codex account" and "Sign in again" of a saved
//! Codex card. Runs `codex login -c cli_auth_credentials_store=file` with `CODEX_HOME` = the account's own profile directory
//! in the auth terminal and watches that auth.json. The live ~/.codex is never touched here (its login is the
//! [`LoginManager`](super::claude::LoginManager)'s `codex` / `main` flow).

use std::path::PathBuf;
use std::sync::{Arc, Weak};

use futures::FutureExt;
use parking_lot::Mutex;
use serde_json::Value;
use tokio::task::AbortHandle;
use zeroize::Zeroizing;

use super::{Fut, LoginError, LoginStartResult, LoginState, LoginStatus, LoginTimings, PtySpec, dir_text, new_session_ids};
use crate::codex::{CODEX_PROFILE_LOGIN, CodexAccount, CodexIdentity, compare_codex_identity, is_codex_account_id};
use crate::codex_store::{CodexAccountsStore, CodexPatch, CodexStoreError};
use crate::identity::IdentityMatch;

/// The seams of the Codex login manager (`CodexLoginDeps`).
pub trait CodexLoginDeps: Send + Sync + 'static {
    fn store(&self) -> &CodexAccountsStore;
    fn spawn_pty(&self, spec: PtySpec) -> Result<(), ()>;
    fn kill_pty(&self, id: &str);
    /// Fingerprint (never the token) of the profile's auth.json login, `None` when there is none.
    fn fingerprint(&self, dir: PathBuf) -> Fut<Result<Option<String>, ()>>;
    fn identity(&self, dir: PathBuf) -> Fut<Result<Option<CodexIdentity>, ()>>;
    /// The account in the live auth.json: already the main card, so adding it again is a duplicate.
    fn live_identity(&self) -> Option<CodexIdentity>;
    /// The raw auth.json of a profile (memory only, for putting a card's login back), `None` when there is none.
    fn read_auth(&self, dir: PathBuf) -> Fut<Result<Option<Zeroizing<String>>, ()>>;
    /// Writes (or, with `None`, deletes) a profile's auth.json.
    fn restore_auth(&self, dir: PathBuf, raw: Option<Zeroizing<String>>) -> Fut<Result<(), ()>>;
    /// True while something else may change the account files (a swap).
    fn busy(&self) -> bool;
    fn emit(&self, state: LoginState);
    fn on_changed(&self, record_id: &str);
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Target {
    New,
    Account(String),
}

#[derive(Default)]
struct State {
    /// `new`: the record id prepared for it (discarded unless the login succeeds).
    pending_id: Option<String>,
    /// `account`: the card's previous auth.json (memory only); the outer `Some` once it was read.
    previous: Option<Option<Zeroizing<String>>>,
    initial: Option<String>,
    ended: bool,
    polling: bool,
    timers: Vec<(u64, AbortHandle)>,
    poll: Option<AbortHandle>,
}

struct Session {
    id: String,
    pty_id: String,
    target: Target,
    dir: PathBuf,
    st: Mutex<State>,
}

impl Session {
    fn ended(&self) -> bool {
        self.st.lock().ended
    }
}

/// `CodexLoginManager`.
pub struct CodexLoginManager {
    deps: Arc<dyn CodexLoginDeps>,
    t: LoginTimings,
    rt: tokio::runtime::Handle,
    current: Mutex<Option<Arc<Session>>>,
    seq: std::sync::atomic::AtomicU64,
    me: Weak<CodexLoginManager>,
}

impl std::fmt::Debug for CodexLoginManager {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexLoginManager").finish_non_exhaustive()
    }
}

impl CodexLoginManager {
    pub fn new(deps: Arc<dyn CodexLoginDeps>, timings: LoginTimings, rt: tokio::runtime::Handle) -> Arc<Self> {
        Arc::new_cyclic(|me| Self {
            deps,
            t: timings,
            rt,
            current: Mutex::new(None),
            seq: std::sync::atomic::AtomicU64::new(0),
            me: me.clone(),
        })
    }

    fn me(&self) -> Arc<Self> {
        self.me.upgrade().expect("the login manager is alive while it runs")
    }

    pub fn is_active(&self) -> bool {
        self.current.lock().is_some()
    }

    pub fn owns_session(&self, session_id: &str) -> bool {
        self.current.lock().as_ref().is_some_and(|s| s.id == session_id)
    }

    /// `start(target)`: the target comes from the renderer and is checked here.
    pub async fn start(&self, target: &Value) -> LoginStartResult {
        let invalid = LoginStartResult::refused("invalid request");
        let Some(t) = target.as_object() else { return invalid };
        let target = match t.get("type").and_then(Value::as_str) {
            Some("new") => Target::New,
            Some("account") => {
                let id = t.get("id").and_then(Value::as_str).filter(|id| is_codex_account_id(id));
                let Some(id) = id.filter(|id| self.deps.store().get(id).is_some()) else { return invalid };
                Target::Account(id.to_string())
            }
            _ => return invalid,
        };
        if self.deps.busy() {
            return LoginStartResult::refused("busy");
        }
        if self.deps.store().read_only() {
            return LoginStartResult::refused("readOnly");
        }
        let previous = self.current.lock().clone();
        if let Some(previous) = previous {
            self.cancel(&previous.id);
        }
        let (id, pty_id) = new_session_ids();
        let (dir, pending_id) = match &target {
            Target::New => match self.deps.store().prepare() {
                Ok((pending, dir)) => (dir, Some(pending)),
                Err(_) => return LoginStartResult::refused("spawn"),
            },
            Target::Account(account) => match self.deps.store().dir_of(account) {
                Ok(dir) => (dir, None),
                Err(_) => return LoginStartResult::refused("spawn"),
            },
        };
        let session = Arc::new(Session {
            id: id.clone(),
            pty_id: pty_id.clone(),
            target,
            dir,
            st: Mutex::new(State { pending_id, ..State::default() }),
        });
        *self.current.lock() = Some(session.clone());
        // A failed read of the card's auth.json leaves nothing to put back; a failed fingerprint counts as no login.
        let mut initial = None;
        let mut read_ok = true;
        if session.target != Target::New {
            match self.deps.read_auth(session.dir.clone()).await {
                Ok(raw) => session.st.lock().previous = Some(raw),
                Err(()) => read_ok = false,
            }
        }
        if read_ok {
            initial = self.deps.fingerprint(session.dir.clone()).await.unwrap_or(None);
        }
        {
            let mut st = session.st.lock();
            if st.ended {
                return LoginStartResult::refused("cancelled");
            }
            st.initial = initial;
        }
        // The profile's own CODEX_HOME; an API key in the environment must not stand in for the login.
        let env = vec![
            ("CODEX_HOME".to_string(), dir_text(&session.dir)),
            ("OPENAI_API_KEY".to_string(), String::new()),
            ("CODEX_API_KEY".to_string(), String::new()),
        ];
        if self.deps.spawn_pty(PtySpec { id: pty_id.clone(), env, command: CODEX_PROFILE_LOGIN.to_string() }).is_err() {
            self.end(&session);
            self.discard(&session);
            return LoginStartResult::refused("spawn");
        }
        let me = self.me();
        let s = session.clone();
        let every = self.t.poll;
        let poll = self.rt.spawn(async move {
            let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + every, every);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                interval.tick().await;
                if me.tick(&s).await {
                    break;
                }
            }
        });
        session.st.lock().poll = Some(poll.abort_handle());
        let s = session.clone();
        self.later(&session, self.t.timeout, move |me| async move { me.fail(&s, LoginError::Timeout).await }.boxed());
        if session.ended() {
            self.kill(&session);
            return LoginStartResult::refused("cancelled");
        }
        self.deps.emit(LoginState::new(&id, LoginStatus::Waiting));
        LoginStartResult::Started { session_id: id, pty_id }
    }

    pub fn cancel(&self, session_id: &str) {
        let session = self.current.lock().clone().filter(|s| s.id == session_id);
        let Some(session) = session else { return };
        self.end(&session);
        self.kill(&session);
        let me = self.me();
        self.rt.spawn(async move { me.undo(&session).await });
    }

    /// The record is being removed: its login session ends without putting anything back.
    pub fn cancel_for(&self, id: &str) {
        let session = self.current.lock().clone().filter(|s| s.target == Target::Account(id.to_string()));
        let Some(session) = session else { return };
        self.end(&session);
        self.kill(&session);
    }

    pub fn dispose(&self) {
        let current = self.current.lock().clone();
        if let Some(session) = current {
            self.cancel(&session.id);
        }
    }

    /// One poll; true once the login wrote its file (the polls stop).
    async fn tick(&self, session: &Arc<Session>) -> bool {
        {
            let mut st = session.st.lock();
            if st.ended || st.polling {
                return false;
            }
            st.polling = true;
        }
        let fingerprint = self.deps.fingerprint(session.dir.clone()).await.unwrap_or(None);
        {
            let mut st = session.st.lock();
            st.polling = false;
            if st.ended || fingerprint.is_none() || fingerprint == st.initial {
                return false;
            }
            // This task stops by itself.
            st.poll = None;
        }
        // Codex writes the file once; a short pause lets the write settle before it is read.
        let s = session.clone();
        self.later(
            session,
            self.t.settle,
            move |me| {
                async move {
                    if me.finalize(&s).await.is_err() {
                        me.fail(&s, LoginError::Identity).await;
                    }
                }
                .boxed()
            },
        );
        true
    }

    async fn finalize(&self, session: &Arc<Session>) -> Result<(), CodexStoreError> {
        if session.ended() {
            return Ok(());
        }
        let Ok(identity) = self.deps.identity(session.dir.clone()).await else {
            return Err(CodexStoreError::Io(std::io::Error::other("identity")));
        };
        if session.ended() {
            return Ok(());
        }
        self.kill(session);
        let truthy = |v: &Option<String>| v.as_deref().is_some_and(|s| !s.is_empty());
        let Some(identity) = identity.filter(|i| truthy(&i.email) || truthy(&i.user_id)) else {
            self.fail(session, LoginError::Identity).await;
            return Ok(());
        };
        let email = identity.email.clone().filter(|e| !e.is_empty());
        let store = self.deps.store();
        let own = match &session.target {
            Target::Account(id) => Some(id.as_str()),
            Target::New => None,
        };
        let others: Vec<CodexAccount> = store.list().into_iter().filter(|a| own.is_none_or(|id| a.id != id)).collect();
        let live = if own.is_none() { self.deps.live_identity() } else { None };
        let duplicate = others.iter().any(|a| compare_codex_identity(&a.identity, &identity) == IdentityMatch::Same)
            || live.as_ref().is_some_and(|l| compare_codex_identity(l, &identity) == IdentityMatch::Same);
        if duplicate {
            let mut state = LoginState::new(&session.id, LoginStatus::Duplicate);
            state.email = email;
            self.finish(session, state, true).await;
            return Ok(());
        }
        match &session.target {
            Target::New => {
                let record_id = session.st.lock().pending_id.clone().unwrap_or_default();
                store.commit(&CodexAccount {
                    id: record_id.clone(),
                    added_at: unimux_core::time::now_ms() as f64,
                    identity: identity.clone(),
                    ..CodexAccount::default()
                })?;
                session.st.lock().pending_id = None;
                let mut state = LoginState::new(&session.id, LoginStatus::Success);
                state.email = email;
                self.finish(session, state, false).await;
                self.deps.on_changed(&record_id);
            }
            Target::Account(id) => {
                let record = store.get(id);
                let Some(record) =
                    record.filter(|r| compare_codex_identity(&identity, &r.identity) != IdentityMatch::Different)
                else {
                    let mut state = LoginState::new(&session.id, LoginStatus::Mismatch);
                    state.email = email;
                    state.expected = store.get(id).and_then(|r| r.identity.email).filter(|e| !e.is_empty());
                    self.finish(session, state, true).await;
                    return Ok(());
                };
                // A fresh login of the card's own account: the only copy of a new token family, no longer a twin nor outdated.
                let merged = CodexIdentity {
                    email: identity.email.clone().or(record.identity.email.clone()),
                    user_id: identity.user_id.clone().or(record.identity.user_id.clone()),
                    account_id: identity.account_id.clone().or(record.identity.account_id.clone()),
                };
                store.update_identity(id, &merged)?;
                store.patch(id, &CodexPatch { live_family: Some(false), outdated: Some(false), ..CodexPatch::default() })?;
                let mut state = LoginState::new(&session.id, LoginStatus::Success);
                state.email = email;
                self.finish(session, state, false).await;
                self.deps.on_changed(id);
            }
        }
        Ok(())
    }

    async fn fail(&self, session: &Arc<Session>, error: LoginError) {
        if session.ended() {
            return;
        }
        self.finish(session, LoginState::failed(&session.id, error), true).await;
    }

    /// Ends the session; `undo` puts a card's previous login back (or drops a new profile) before the state is told.
    async fn finish(&self, session: &Arc<Session>, state: LoginState, undo: bool) {
        self.end(session);
        self.kill(session);
        if undo {
            self.undo(session).await;
        }
        self.deps.emit(state);
    }

    async fn undo(&self, session: &Arc<Session>) {
        if matches!(session.target, Target::Account(_)) {
            let previous = session.st.lock().previous.take();
            if let Some(previous) = previous {
                // The card shows whatever login is there when this fails.
                let _ = self.deps.restore_auth(session.dir.clone(), previous).await;
            }
        }
        self.discard(session);
    }

    fn discard(&self, session: &Session) {
        let Some(id) = session.st.lock().pending_id.take() else { return };
        // An orphaned dir is never listed.
        let _ = self.deps.store().remove(&id);
    }

    /// A timer of the session; it forgets its own handle when it fires, so ending the session never aborts it half way.
    fn later(
        &self,
        session: &Arc<Session>,
        after: std::time::Duration,
        run: impl FnOnce(Arc<Self>) -> Fut<()> + Send + 'static,
    ) {
        let key = self.seq.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let me = self.me();
        let s = session.clone();
        let mut st = session.st.lock();
        if st.ended {
            return;
        }
        let task = self.rt.spawn(async move {
            tokio::time::sleep(after).await;
            {
                let mut st = s.st.lock();
                if st.ended {
                    return;
                }
                st.timers.retain(|(k, _)| *k != key);
            }
            run(me).await;
        });
        st.timers.push((key, task.abort_handle()));
    }

    fn end(&self, session: &Arc<Session>) {
        {
            let mut st = session.st.lock();
            st.ended = true;
            if let Some(poll) = st.poll.take() {
                poll.abort();
            }
            for (_, timer) in st.timers.drain(..) {
                timer.abort();
            }
        }
        let mut current = self.current.lock();
        if current.as_ref().is_some_and(|c| Arc::ptr_eq(c, session)) {
            *current = None;
        }
    }

    fn kill(&self, session: &Session) {
        self.deps.kill_pty(&session.pty_id);
    }
}
