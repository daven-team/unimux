//! Where the GitHub token for publishing comes from (port of src/main/github/auth.ts), in this order: the one unimux stored
//! (device flow), the token of an installed and signed-in GitHub CLI (`gh auth token`, run without a shell; a missing gh is
//! no error), else nothing. The token stays in Rust; the renderer only ever sees the source and the user name.
//!
//! JS runs these methods on one thread; here they can run on several, so the two places where 1.1.4 relies on that are made
//! atomic: the device-flow start checks its ticket and installs its flow under the lock a cancel takes, and the shared check
//! of the stored token is installed under the lock its task clears. Background work (the device-flow poll, the stored check)
//! runs as its own task, as the JS promises run whether or not anyone awaits them.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::Value;
use unimux_net::CancellationToken;
use unimux_oscrypt::Storage;

use super::api::{self, DeviceCode, Endpoints, GithubFetch, NowFn, PollOptions, SleepFn, err};
use super::gh::{Env, ExecFailure, GhExec, GhPlatform};
use super::token_store::GithubTokenStore;
use super::{GITHUB_DEVICE_PAGE, GITHUB_DEVICE_SCOPE, GhFail, GhResult, is_github_page, is_token_text};
use crate::js;

const GH_TIMEOUT: Duration = Duration::from_millis(8000);
/// What GitHub said about a token is kept this long (ms).
const LOGIN_TTL_MS: f64 = 10.0 * 60_000.0;
/// A refused fetch, pull or push has GitHub check the stored token at most this often (ms).
const STORED_CHECK_MS: f64 = 60_000.0;

/// `GithubAuthSource`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AuthSource {
    Stored,
    Gh,
}

/// `GithubAuthStatus`, keys in 1.1.4's order (`{ ...base, signedIn, source, login }`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthStatus {
    pub device_flow: bool,
    pub storage: Storage,
    pub signed_in: bool,
    pub source: Option<AuthSource>,
    pub login: Option<String>,
}

/// `GithubDeviceStart`.
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceStart {
    pub flow_id: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: f64,
}

impl DeviceStart {
    pub fn to_json(&self) -> Value {
        let mut m = serde_json::Map::new();
        m.insert("flowId".into(), Value::String(self.flow_id.clone()));
        m.insert("userCode".into(), Value::String(self.user_code.clone()));
        m.insert("verificationUri".into(), Value::String(self.verification_uri.clone()));
        m.insert("expiresIn".into(), js::num(self.expires_in));
        Value::Object(m)
    }
}

/// The end of a device flow: signed in (with the login, if GitHub told it), why not, or Err when the token could not be kept
/// (1.1.4: `encryptString` threw and the promise rejected).
pub type FlowOutcome = Result<GhResult<Option<String>>, String>;

/// `{ login }` of a finished flow as the renderer gets it.
pub fn flow_json(outcome: &GhResult<Option<String>>) -> Value {
    super::result_json(&outcome.clone().map(|login| serde_json::json!({ "login": login })))
}

/// The environment `gh` runs in (PATH refreshed, session variables removed).
pub type EnvSource = Arc<dyn Fn() -> BoxFuture<'static, Env> + Send + Sync>;

pub struct GithubAuthDeps {
    pub fetch: Arc<dyn GithubFetch>,
    pub endpoints: Endpoints,
    pub store: Arc<GithubTokenStore>,
    /// The OAuth App client id; empty hides the device flow.
    pub client_id: String,
    pub exec: Arc<dyn GhExec>,
    pub env: EnvSource,
    pub platform: GhPlatform,
    /// `Date.now()`.
    pub now: NowFn,
    /// The device-flow poll's wait.
    pub sleep: SleepFn,
    pub max_network_failures: u32,
}

impl GithubAuthDeps {
    /// The real clock and wait, GitHub's addresses and 4 network failures in a row.
    pub fn new(
        fetch: Arc<dyn GithubFetch>,
        store: Arc<GithubTokenStore>,
        client_id: &str,
        exec: Arc<dyn GhExec>,
        env: EnvSource,
    ) -> Self {
        Self {
            fetch,
            endpoints: Endpoints::default(),
            store,
            client_id: client_id.to_string(),
            exec,
            env,
            platform: GhPlatform::current(),
            now: api::real_now(),
            sleep: api::real_sleep(),
            max_network_failures: 4,
        }
    }
}

struct Flow {
    id: String,
    cancel: CancellationToken,
    result: Shared<BoxFuture<'static, FlowOutcome>>,
}

/// The running check of the stored token (its id and the shared end), and when the last one started (ms).
struct StoredCheck {
    running: Option<(u64, Shared<BoxFuture<'static, ()>>)>,
    at: f64,
}

struct Known {
    token: String,
    login: Option<String>,
    at: f64,
}

/// What `check` found out about a token.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Check {
    /// GitHub accepts it (the login, None when it could not be read, e.g. offline).
    Login(Option<String>),
    /// GitHub refuses it (401).
    Refused,
}

pub struct GithubAuth {
    deps: GithubAuthDeps,
    flow: Mutex<Option<Flow>>,
    /// Bumped by every start and by a cancel of all flows: a start whose code arrives after a newer start is dropped.
    starts: AtomicU64,
    known: Mutex<Option<Known>>,
    stored_check: Mutex<StoredCheck>,
    stored_check_ids: AtomicU64,
}

fn cancelled() -> GhFail {
    GhFail::new("cancelled", err::CANCELLED)
}

/// A spawned task as a shareable future (a task that panicked answers `fallback`).
fn shared_task<T: Clone + Send + 'static>(
    task: impl std::future::Future<Output = T> + Send + 'static,
    fallback: T,
) -> Shared<BoxFuture<'static, T>> {
    let handle = tokio::spawn(task);
    async move { handle.await.unwrap_or(fallback) }.boxed().shared()
}

impl GithubAuth {
    pub fn new(deps: GithubAuthDeps) -> Arc<Self> {
        Arc::new(Self {
            deps,
            flow: Mutex::new(None),
            starts: AtomicU64::new(0),
            known: Mutex::new(None),
            stored_check: Mutex::new(StoredCheck { running: None, at: f64::NEG_INFINITY }),
            stored_check_ids: AtomicU64::new(0),
        })
    }

    pub fn store(&self) -> &Arc<GithubTokenStore> {
        &self.deps.store
    }

    fn now(&self) -> f64 {
        (self.deps.now)()
    }

    /// The GitHub CLI's token, or None (gh missing, signed out, too old for `auth token`, or slow).
    pub async fn gh_token(&self) -> Option<String> {
        let mut env = (self.deps.env)().await;
        for (k, v) in [("GH_PROMPT_DISABLED", "1"), ("GH_NO_UPDATE_NOTIFIER", "1"), ("NO_COLOR", "1")] {
            // `{ ...env, K: v }`: an existing key keeps its place and gets the new value.
            match env.iter_mut().find(|(key, _)| key == k) {
                Some(entry) => entry.1 = v.to_string(),
                None => env.push((k.to_string(), v.to_string())),
            }
        }
        let bins = std::iter::once("gh").chain(self.deps.platform.fallbacks().iter().copied());
        for bin in bins {
            match self.deps.exec.run(bin, &["auth", "token", "--hostname", "github.com"], GH_TIMEOUT, &env).await {
                Ok(stdout) => {
                    let token = js::trim(&stdout);
                    return is_token_text(token).then(|| token.to_string());
                }
                // Not installed here: the next place is tried. Installed but signed out (or failing): there is no token.
                Err(ExecFailure::NotFound) => continue,
                Err(ExecFailure::Failed) => return None,
            }
        }
        None
    }

    /// The token to publish with and where it came from, or None when the user has to sign in.
    pub async fn token(&self) -> Option<(String, AuthSource)> {
        if let Some(stored) = self.deps.store.get() {
            return Some((stored, AuthSource::Stored));
        }
        self.gh_token().await.map(|t| (t, AuthSource::Gh))
    }

    /// GitHub refused the token (401): a stored one is forgotten (it cannot work again); a gh token belongs to the CLI.
    pub fn rejected(&self, source: AuthSource) {
        if source == AuthSource::Stored {
            self.deps.store.clear();
        }
        *self.known.lock() = None;
    }

    /// What GitHub says about `token`, remembered a few minutes per token unless `fresh`.
    async fn check(&self, token: &str, fresh: bool) -> Check {
        if !fresh
            && let Some(k) = &*self.known.lock()
            && k.token == token
            && self.now() - k.at < LOGIN_TTL_MS
        {
            return Check::Login(k.login.clone());
        }
        let login = api::fetch_login(self.deps.fetch.as_ref(), &self.deps.endpoints, token).await;
        let mut known = self.known.lock();
        if let Err(fail) = &login
            && fail.code == "auth"
        {
            if known.as_ref().is_some_and(|k| k.token == token) {
                *known = None;
            }
            return Check::Refused;
        }
        let login = login.ok();
        *known = Some(Known { token: token.to_string(), login: login.clone(), at: self.now() });
        Check::Login(login)
    }

    /// Forgets the stored token if it is still `token` (a sign-in that finished in the meantime stays).
    fn forget_stored(&self, token: &str) {
        if self.deps.store.get().as_deref() == Some(token) {
            self.deps.store.clear();
        }
        let mut known = self.known.lock();
        if known.as_ref().is_some_and(|k| k.token == token) {
            *known = None;
        }
    }

    /// Who is signed in. `local`: the stored sign-in only (no `gh`, no network), for the Git panel's menu.
    pub async fn status(&self, local: bool) -> AuthStatus {
        let base = |signed_in: bool, source: Option<AuthSource>, login: Option<String>| AuthStatus {
            device_flow: !self.deps.client_id.is_empty(),
            storage: self.deps.store.storage(),
            signed_in,
            source,
            login,
        };
        let stored = self.deps.store.get();
        if let Some(stored) = &stored {
            if local {
                return base(true, Some(AuthSource::Stored), self.deps.store.login());
            }
            match self.check(stored, false).await {
                Check::Login(login) => {
                    return base(true, Some(AuthSource::Stored), login.or_else(|| self.deps.store.login()));
                }
                // GitHub no longer accepts it (revoked, unused for a year, rotated out): forgotten; gh may still work.
                Check::Refused => self.forget_stored(stored),
            }
        }
        if local {
            return base(false, None, None);
        }
        let Some(gh) = self.gh_token().await else { return base(false, None, None) };
        match self.check(&gh, false).await {
            // GitHub says the CLI's token is no longer valid: `gh auth login` again (or sign in here).
            Check::Refused => base(false, None, None),
            Check::Login(login) => base(true, Some(AuthSource::Gh), login),
        }
    }

    /// A fetch, pull or push to github.com was refused with the stored token: GitHub is asked whether the token still works,
    /// and a 401 forgets it. At most once a minute; a running check is shared. The check runs whether or not this is awaited.
    pub fn check_stored(self: &Arc<Self>) -> BoxFuture<'static, ()> {
        let mut slot = self.stored_check.lock();
        if let Some((_, running)) = &slot.running {
            return running.clone().boxed();
        }
        let Some(token) = self.deps.store.get() else { return async {}.boxed() };
        if self.now() - slot.at < STORED_CHECK_MS {
            return async {}.boxed();
        }
        slot.at = self.now();
        let id = self.stored_check_ids.fetch_add(1, Ordering::Relaxed);
        let me = self.clone();
        let running = shared_task(
            async move {
                if me.check(&token, true).await == Check::Refused {
                    me.forget_stored(&token);
                }
                let mut slot = me.stored_check.lock();
                if slot.running.as_ref().is_some_and(|(running, _)| *running == id) {
                    slot.running = None;
                }
            },
            (),
        );
        slot.running = Some((id, running.clone()));
        running.boxed()
    }

    /// Starts the device flow (one at a time: a new start ends the previous one) and polls GitHub in the background.
    pub async fn start_device(self: &Arc<Self>) -> GhResult<DeviceStart> {
        let ticket = self.cancel_all();
        let code =
            api::request_device_code(self.deps.fetch.as_ref(), &self.deps.endpoints, &self.deps.client_id, GITHUB_DEVICE_SCOPE)
                .await?;
        let mut flow = self.flow.lock();
        // A newer start (a double click) or a sign-out came while GitHub answered: this code is never polled.
        if self.starts.load(Ordering::SeqCst) != ticket {
            return Err(cancelled());
        }
        let cancel = CancellationToken::new();
        let id = uuid::Uuid::new_v4().to_string();
        let result = shared_task(self.clone().run_flow(code.clone(), cancel.clone()), Ok(Err(cancelled())));
        // A finished flow stays here (its answer is still asked for) until the next start, a cancel or a sign-out.
        *flow = Some(Flow { id: id.clone(), cancel, result });
        let verification_uri =
            if is_github_page(&code.verification_uri) { code.verification_uri } else { GITHUB_DEVICE_PAGE.to_string() };
        Ok(DeviceStart { flow_id: id, user_code: code.user_code, verification_uri, expires_in: code.expires_in })
    }

    async fn run_flow(self: Arc<Self>, code: DeviceCode, cancel: CancellationToken) -> FlowOutcome {
        let polled = api::poll_device_token(PollOptions {
            fetch: self.deps.fetch.as_ref(),
            endpoints: &self.deps.endpoints,
            client_id: &self.deps.client_id,
            code: &code,
            cancel,
            now: self.deps.now.clone(),
            sleep: self.deps.sleep.clone(),
            max_network_failures: self.deps.max_network_failures,
        })
        .await;
        let token = match polled {
            Ok(token) => token,
            Err(fail) => return Ok(Err(fail)),
        };
        let login = api::fetch_login(self.deps.fetch.as_ref(), &self.deps.endpoints, &token).await.ok();
        self.deps.store.set(&token, login.as_deref())?;
        Ok(Ok(login))
    }

    /// The end of the device flow `flow_id` (an unknown or replaced id answers "cancelled").
    pub async fn wait_device(&self, flow_id: &str) -> FlowOutcome {
        let result = {
            let flow = self.flow.lock();
            match &*flow {
                Some(f) if f.id == flow_id => f.result.clone(),
                _ => return Ok(Err(cancelled())),
            }
        };
        result.await
    }

    /// Stops every flow, including a start still waiting for its code; returns the new ticket.
    fn cancel_all(&self) -> u64 {
        let mut flow = self.flow.lock();
        let ticket = self.starts.fetch_add(1, Ordering::SeqCst) + 1;
        if let Some(f) = flow.take() {
            f.cancel.cancel();
        }
        ticket
    }

    /// Stops the running device flow (None: whatever runs, including a start still waiting for its code).
    pub fn cancel_device(&self, flow_id: Option<&str>) {
        match flow_id {
            None => {
                self.cancel_all();
            }
            Some(id) => {
                let mut flow = self.flow.lock();
                if flow.as_ref().is_some_and(|f| f.id == id)
                    && let Some(f) = flow.take()
                {
                    f.cancel.cancel();
                }
            }
        }
    }

    /// "Sign out of GitHub": the stored token is forgotten (the local status follows); a GitHub CLI login is the CLI's own.
    pub async fn sign_out(&self) -> AuthStatus {
        self.cancel_device(None);
        self.deps.store.clear();
        *self.known.lock() = None;
        self.status(true).await
    }
}
