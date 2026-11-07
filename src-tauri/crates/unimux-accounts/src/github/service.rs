//! "Publish to GitHub" put together (port of src/main/github/service.ts and the sign-in half of ipc.ts): the token store,
//! the sign-in and the environment that lets later fetch, pull and push to https://github.com use the stored sign-in. The
//! IPC handlers answer what 1.1.4's `createGithubHandlers` answers; `github:publish` is G3's ([`super::publish::Publisher`]).

use std::path::Path;
use std::sync::Arc;

use serde_json::Value;
use unimux_oscrypt::SafeCipher;

use super::api::{GithubFetch, err};
use super::auth::{AuthStatus, EnvSource, GithubAuth, GithubAuthDeps, flow_json};
use super::gh::{GhExec, SystemGhExec};
use super::git_env::{GITHUB_ORIGIN, github_git_env};
use super::token_store::GithubTokenStore;
use super::{GITHUB_OAUTH_CLIENT_ID, GhFail, is_flow_id, result_json};

/// The channels A6 registers (GITHUB_CHANNELS of ipc.ts without `github:publish`, which G3 adds).
pub const SIGN_IN_CHANNELS: [&str; 5] =
    ["github:status", "github:deviceStart", "github:deviceWait", "github:deviceCancel", "github:signOut"];

pub struct GithubService {
    pub store: Arc<GithubTokenStore>,
    pub auth: Arc<GithubAuth>,
}

impl GithubService {
    /// `createGithubService`: `<data>/github/token.json` (read now), the built-in client id and `gh` without a shell.
    pub fn new(data_dir: &Path, cipher: Arc<dyn SafeCipher>, fetch: Arc<dyn GithubFetch>, env: EnvSource) -> Self {
        let store = Arc::new(GithubTokenStore::new(data_dir.join("github").join("token.json"), cipher));
        let exec: Arc<dyn GhExec> = Arc::new(SystemGhExec);
        let auth = GithubAuth::new(GithubAuthDeps::new(fetch, store.clone(), GITHUB_OAUTH_CLIENT_ID, exec, env));
        Self { store, auth }
    }

    /// From parts (tests, other client ids).
    pub fn from_deps(deps: GithubAuthDeps) -> Self {
        let store = deps.store.clone();
        Self { store, auth: GithubAuth::new(deps) }
    }

    /// For git's fetch, pull and push: the stored sign-in as an https://github.com header, or None.
    pub fn remote_auth(&self) -> Option<Vec<(String, String)>> {
        self.store.get().map(|token| github_git_env(&token, GITHUB_ORIGIN))
    }

    /// GitHub refused that header as a whole: it is checked with GitHub, and forgotten when GitHub no longer accepts it.
    pub fn remote_auth_refused(&self) {
        drop(self.auth.check_stored());
    }

    // ---------- IPC (createGithubHandlers) ----------

    /// `github:status(options)`: `{ local: true }` exactly asks for the quick status.
    pub async fn status(&self, options: &Value) -> Value {
        let local = options.get("local").and_then(Value::as_bool) == Some(true);
        status_json(&self.auth.status(local).await)
    }

    /// `github:deviceStart()`.
    pub async fn device_start(&self) -> Value {
        result_json(&self.auth.start_device().await.map(|s| s.to_json()))
    }

    /// `github:deviceWait(flowId)`; Err is a rejected promise (the token could not be kept).
    pub async fn device_wait(&self, flow_id: &Value) -> Result<Value, String> {
        if !is_flow_id(flow_id) {
            return Ok(GhFail::new("cancelled", err::CANCELLED).to_json());
        }
        let outcome = self.auth.wait_device(flow_id.as_str().unwrap_or_default()).await?;
        Ok(flow_json(&outcome))
    }

    /// `github:deviceCancel(flowId)`: only a valid id cancels (answers undefined).
    pub fn device_cancel(&self, flow_id: &Value) {
        if is_flow_id(flow_id) {
            self.auth.cancel_device(flow_id.as_str());
        }
    }

    /// `github:signOut()`.
    pub async fn sign_out(&self) -> Value {
        status_json(&self.auth.sign_out().await)
    }
}

pub fn status_json(status: &AuthStatus) -> Value {
    serde_json::to_value(status).unwrap_or(Value::Null)
}
