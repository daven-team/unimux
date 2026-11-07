//! `refreshClaudeProfile` (port of src/main/accounts/refresh.ts and tokenTransport.ts): renews the tokens of an isolated
//! profile owned by this app. Only such profiles are ever written: the machine's own login belongs to Claude Code. The
//! request is [`unimux_net::calls::token_renewal`] (exactly `content-type` and `user-agent` plus Host, Content-Length and
//! `Connection: close`, HTTP/1.1, every 3xx refused, 10 s, 1 MB cap, direct first and the system proxy only when no
//! connection could be made). Concurrent calls for one profile share one request, so the rotating refresh token is used
//! once, and the renewal runs as its own task: a caller that stops waiting never cuts it between the request and the write.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use serde_json::{Map, Value};
use unimux_core::js_json;
use unimux_net::{FetchError, HttpClient, Request, Response};

use super::limits::{RefreshLimit, RefreshLimits};
use super::{ProfileLocks, RefreshOutcome, TransientDetail, key_of};
use crate::js;
use crate::retry_after::parse_retry_after;

pub use unimux_net::calls::{OAUTH_CLIENT_ID, OAUTH_TOKEN_URL, REFRESH_USER_AGENT};

/// Backoff after a 429 of the token endpoint: 5 min, doubling up to an hour (a longer Retry-After wins), plus up to 20 %
/// jitter.
pub const LIMIT_BASE_MS: f64 = 5.0 * 60_000.0;
pub const LIMIT_MAX_MS: f64 = 60.0 * 60_000.0;
const LIMIT_JITTER: f64 = 0.2;
const WRITE_TRIES: u32 = 3;
/// How long a refresh the server calls dead waits before the file is looked at once more (another process may have just
/// renewed it).
pub const DEAD_RECHECK: Duration = Duration::from_millis(250);

/// The token endpoint transport (the real [`HttpClient`], or a fake in the tests).
pub trait TokenFetch: Send + Sync {
    fn fetch(&self, req: Request) -> BoxFuture<'static, Result<Response, FetchError>>;
}

impl TokenFetch for HttpClient {
    fn fetch(&self, req: Request) -> BoxFuture<'static, Result<Response, FetchError>> {
        let client = self.clone();
        async move { client.fetch(req).await }.boxed()
    }
}

pub type AsyncDelay = Arc<dyn Fn(Duration) -> BoxFuture<'static, ()> + Send + Sync>;

/// `RefreshDeps`.
#[derive(Clone)]
pub struct RefreshDeps {
    pub fetch: Arc<dyn TokenFetch>,
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    /// `MC_USAGE_CLAUDE_TOKEN_URL` (dev-overrides only); default [`OAUTH_TOKEN_URL`].
    pub token_url: Option<String>,
    /// Default: `tokio::time::sleep`.
    pub delay: Option<AsyncDelay>,
    /// Product name sent as User-Agent (`unimux/<version>`); default [`REFRESH_USER_AGENT`].
    pub user_agent: Option<String>,
    /// Without it nothing is remembered and every call goes to the server.
    pub limits: Option<Arc<RefreshLimits>>,
    /// `Math.random` for the jitter (tests fix it).
    pub random: Option<Arc<dyn Fn() -> f64 + Send + Sync>>,
}

impl RefreshDeps {
    async fn sleep(&self, d: Duration) {
        match &self.delay {
            Some(f) => f(d).await,
            None => tokio::time::sleep(d).await,
        }
    }
    fn random(&self) -> f64 {
        match &self.random {
            Some(f) => f(),
            None => {
                let mut b = [0u8; 4];
                if getrandom::fill(&mut b).is_ok() { f64::from(u32::from_le_bytes(b)) / (f64::from(u32::MAX) + 1.0) } else { 0.5 }
            }
        }
    }
}

/// Short stable fingerprint of a refresh token (safe to keep on disk: it cannot be turned back into the token).
pub fn refresh_limit_key(refresh_token: &str) -> String {
    js::sha256_hex(refresh_token)[..16].to_string()
}

fn transient(reason: impl Into<String>, retry_after_ms: Option<f64>) -> RefreshOutcome {
    RefreshOutcome::Transient(Some(TransientDetail {
        reason: reason.into(),
        retry_after_ms: retry_after_ms.map(|ms| ms.max(0.0).round() as u64),
    }))
}

type Running = Shared<BoxFuture<'static, RefreshOutcome>>;

/// The renewals of this app run: one in-flight request per profile directory, on the shared per-profile lock.
pub struct Renewer {
    profiles: Arc<ProfileLocks>,
    inflight: Arc<Mutex<HashMap<PathBuf, Running>>>,
}

impl std::fmt::Debug for Renewer {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Renewer").field("inflight", &self.inflight.lock().len()).finish()
    }
}

impl Renewer {
    pub fn new(profiles: Arc<ProfileLocks>) -> Self {
        Self { profiles, inflight: Arc::default() }
    }

    pub fn profiles(&self) -> &Arc<ProfileLocks> {
        &self.profiles
    }

    /// `refreshClaudeProfile(dir, deps)`: needs a tokio runtime (the renewal is spawned on it).
    pub fn refresh(&self, dir: &Path, deps: &RefreshDeps) -> BoxFuture<'static, RefreshOutcome> {
        let key = key_of(dir);
        let mut inflight = self.inflight.lock();
        if let Some(running) = inflight.get(&key) {
            return running.clone().boxed();
        }
        let (profiles, deps, dir, map, k) =
            (self.profiles.clone(), deps.clone(), dir.to_path_buf(), self.inflight.clone(), key.clone());
        let task = tokio::spawn(async move {
            let out = {
                let _guard = profiles.lock_async(&dir).await;
                run(&dir, &deps).await
            };
            map.lock().remove(&k);
            out
        });
        let inflight_map = self.inflight.clone();
        let k = key.clone();
        let running: Running = async move {
            match task.await {
                Ok(out) => out,
                // A panic inside the renewal counts as a transient failure (a TS throw); the entry is gone with it.
                Err(_) => {
                    inflight_map.lock().remove(&k);
                    RefreshOutcome::Transient(None)
                }
            }
        }
        .boxed()
        .shared();
        inflight.insert(key, running.clone());
        running.boxed()
    }

    /// A blocking bridge for the activation's `refresh` seam (it runs on a blocking thread): waits for the renewal on `rt`.
    pub fn refresh_blocking(&self, rt: &tokio::runtime::Handle, dir: &Path, deps: &RefreshDeps) -> RefreshOutcome {
        let fut = self.refresh(dir, deps);
        rt.block_on(fut)
    }
}

/// The parsed credentials file: the whole object and its refresh token.
fn read_credentials(file: &Path) -> Option<Map<String, Value>> {
    let text = js::read_text(file).ok()?;
    match js_json::parse(&text).ok()? {
        Value::Object(m) => Some(m),
        _ => None,
    }
}

fn refresh_token_of(data: &Map<String, Value>) -> Option<&str> {
    js::record(data.get("claudeAiOauth")).and_then(|o| o.get("refreshToken")).and_then(Value::as_str)
}

async fn run(dir: &Path, deps: &RefreshDeps) -> RefreshOutcome {
    let file = dir.join(".credentials.json");
    let Some(mut data) = read_credentials(&file) else { return transient("read", None) };
    if js::record(data.get("claudeAiOauth")).is_none() {
        return transient("read", None);
    }
    let token = match refresh_token_of(&data) {
        Some(t) if !t.is_empty() => t.to_string(),
        _ => return RefreshOutcome::Dead,
    };
    let key = refresh_limit_key(&token);
    let held = deps.limits.as_ref().and_then(|l| l.get(&key));
    // A refresh token that was just answered with 429 is left alone until the window passes: hammering the limiter keeps it
    // engaged.
    if let Some(h) = held
        && h.until > (deps.now)()
    {
        return transient("http-429", Some(h.until - (deps.now)()));
    }
    let url = deps.token_url.as_deref().unwrap_or(OAUTH_TOKEN_URL);
    let ua = deps.user_agent.as_deref().unwrap_or(REFRESH_USER_AGENT);
    let response = match unimux_net::calls::token_renewal(url, &token, ua) {
        Ok(req) => match deps.fetch.fetch(req).await {
            Ok(r) => r,
            Err(_) => return transient("network", None),
        },
        Err(_) => return transient("network", None),
    };
    if !response.ok() {
        let error = response.json().ok().and_then(|v| v.as_object().and_then(|o| o.get("error").cloned()));
        let code = match &error {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Object(o)) => o.get("type").and_then(Value::as_str).unwrap_or("").to_string(),
            _ => String::new(),
        };
        let rejected = matches!(response.status, 400 | 401 | 403);
        // A client-level rejection is systemic (cswap treats it the same way): the login itself is not proven dead.
        if rejected && (code == "invalid_client" || code == "unauthorized_client") {
            return transient("invalid-client", None);
        }
        // Only an explicit grant rejection proves a dead login.
        if rejected && code == "invalid_grant" {
            // Another process using this very profile (a Claude session) may have renewed it a moment ago.
            deps.sleep(DEAD_RECHECK).await;
            if let Some(again) = read_credentials(&file)
                && let Some(current) = refresh_token_of(&again)
                && !current.is_empty()
                && current != token
            {
                return RefreshOutcome::Ok;
            }
            return RefreshOutcome::Dead;
        }
        let now = (deps.now)();
        let asked = parse_retry_after(response.header("retry-after").as_deref(), now);
        if response.status == 429 {
            let failures = held.map_or(0, |h| h.failures).saturating_add(1);
            let exponential = LIMIT_MAX_MS.min(LIMIT_BASE_MS * 2f64.powi((failures - 1).min(10) as i32));
            let wait = (asked.unwrap_or(0.0).max(exponential) * (1.0 + LIMIT_JITTER * deps.random()) + 0.5).floor();
            if let Some(l) = &deps.limits {
                l.set(&key, RefreshLimit { until: now + wait, failures });
            }
            return transient("http-429", Some(wait));
        }
        return transient(format!("http-{}", response.status), asked);
    }
    let Ok(Value::Object(body)) = response.json() else { return transient("bad-response", None) };
    let access = match body.get("access_token") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => return transient("bad-response", None),
    };
    let Some(expires_in) = body.get("expires_in").and_then(Value::as_f64) else { return transient("bad-response", None) };
    if let Some(l) = &deps.limits {
        l.delete(&key);
    }
    let rotated = body.get("refresh_token").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string);
    if let Some(Value::Object(oauth)) = data.get_mut("claudeAiOauth") {
        oauth.insert("accessToken".into(), Value::String(access));
        oauth.insert("expiresAt".into(), js::num((deps.now)() + expires_in * 1000.0));
        if let Some(r) = &rotated {
            oauth.insert("refreshToken".into(), Value::String(r.clone()));
        }
        if let Some(scope) = body.get("scope").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            oauth.insert("scopes".into(), Value::Array(scope.split(' ').map(|s| Value::String(s.into())).collect()));
        }
    }
    let mut data = Value::Object(data);
    js_json::order_like_js(&mut data);
    let text = js_json::stringify(&data);
    for attempt in 0..WRITE_TRIES {
        let mut temp = file.as_os_str().to_owned();
        temp.push(format!(".{}.tmp", uuid::Uuid::new_v4()));
        let temp = PathBuf::from(temp);
        if write_private(&temp, &text).and_then(|()| std::fs::rename(&temp, &file)).is_ok() {
            return RefreshOutcome::Ok;
        }
        let _ = std::fs::remove_file(&temp);
        if attempt < WRITE_TRIES - 1 {
            deps.sleep(Duration::from_millis(100)).await;
        }
    }
    // A rotated refresh token was already used up on the server: a plain transient would let callers go on with a dead token.
    if rotated.is_some() { RefreshOutcome::Unusable } else { transient("write", None) }
}

/// `writeFile(path, text, { mode: 0o600 })`, flushed to disk before the rename.
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut open = std::fs::OpenOptions::new();
    open.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.mode(0o600);
    }
    let mut f = open.open(path)?;
    f.write_all(text.as_bytes())?;
    f.sync_all()
}

#[cfg(test)]
mod tests;
