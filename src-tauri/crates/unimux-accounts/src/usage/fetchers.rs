//! One read of an account's limits (port of src/main/usage/fetchers.ts). Claude: the OAuth usage endpoint with the account's
//! own access token (saved profiles renewed here only when their token family lives nowhere else, R6); Codex: wham/usage,
//! the live login falling back to its newest session log. Requests come from `unimux_net::calls` (redirects refused, so a
//! bearer token never follows one).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::Value;

use super::codex_log::read_codex_log;
use super::credentials::{
    ClaudeCredentials, CodexCredentials, CodexMode, CredentialSource, read_claude_credentials, read_claude_identity,
    read_cleared_claude_login, read_codex_credentials,
};
use super::parse::{parse_claude_usage, parse_codex_plan, parse_codex_rate_limits};
use super::types::{Provider, ProviderUsage, Source, Status, held_by_of};
use crate::refresh::RefreshOutcome;
use crate::refresh::renew::TokenFetch;
use crate::refs::AccountRef;
use crate::retry_after::parse_retry_after;

/// A token that expires within this margin is treated as expired rather than risking a rejected request.
const EXPIRY_MARGIN_MS: f64 = 30_000.0;
/// How long to wait before the one re-read of a main login that looks missing, expired or rejected.
const REREAD_DELAY: Duration = Duration::from_millis(300);

pub type RenewFn = Arc<dyn Fn(&Path) -> BoxFuture<'static, RefreshOutcome> + Send + Sync>;
pub type SleepFn = Arc<dyn Fn(Duration) -> BoxFuture<'static, ()> + Send + Sync>;

/// `FetcherDeps`.
#[derive(Clone)]
pub struct FetcherDeps {
    pub credentials: CredentialSource,
    pub fetch: Arc<dyn TokenFetch>,
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    pub codex_home: Arc<dyn Fn() -> PathBuf + Send + Sync>,
    pub claude_url: String,
    pub codex_url: String,
    /// Renews the tokens of a managed Claude profile (`usageDeps.refreshClaude`, with the gates).
    pub refresh_claude: Option<RenewFn>,
    /// The pause before re-reading the main login's file (tests inject an instant one).
    pub sleep: SleepFn,
    /// `unimux/<version>`: the usage endpoint counts its limit per client, so never Claude Code's.
    pub user_agent: String,
}

/// `FetchResult`.
#[derive(Debug, Clone, PartialEq)]
pub struct FetchResult {
    pub usage: ProviderUsage,
    pub retry_after_ms: Option<f64>,
    /// The live request failed although another source answered; the service still backs off.
    pub failed: bool,
}

impl FetchResult {
    fn of(usage: ProviderUsage) -> Self {
        Self { usage, retry_after_ms: None, failed: false }
    }

    fn retry(usage: ProviderUsage, retry_after_ms: Option<f64>) -> Self {
        Self { usage, retry_after_ms, failed: false }
    }
}

fn with(base: &ProviderUsage, status: Status, error: Option<&str>) -> ProviderUsage {
    let mut u = base.clone();
    u.status = status;
    u.error = error.map(str::to_string);
    u
}

/// A request that could not be made: a thrown fetch error is `timeout` or `network`; a body that is no JSON `bad-response`.
enum Failure {
    Kind(&'static str),
}

async fn get(deps: &FetcherDeps, req: Result<unimux_net::Request, unimux_net::FetchError>) -> Result<unimux_net::Response, Failure> {
    let req = req.map_err(|_| Failure::Kind("network"))?;
    deps.fetch.fetch(req).await.map_err(|e| Failure::Kind(e.kind()))
}

fn json_body(response: &unimux_net::Response) -> Result<Value, Failure> {
    let text = String::from_utf8_lossy(&response.body);
    unimux_core::js_json::parse(&text).map_err(|_| Failure::Kind("bad-response"))
}

fn retry_after(response: &unimux_net::Response, now: f64) -> Option<f64> {
    parse_retry_after(response.header("retry-after").as_deref(), now)
}

/// `fetchClaude(deps, ref)`.
pub async fn fetch_claude(deps: &FetcherDeps, r: &AccountRef) -> FetchResult {
    let now = (deps.now)();
    let is_main = r.config_dir.is_none();
    let source = match &r.config_dir {
        Some(dir) => deps.credentials.profile(dir),
        None => deps.credentials.clone(),
    };
    let mut base = ProviderUsage::new(&r.id, Provider::Claude, Status::SignedOut, now, Source::Live);
    if r.config_dir.is_some() {
        base.managed = Some(true);
    }
    base.active = r.active == Some(true);
    // The live login belongs to Claude Code, which rewrites the file while renewing; one re-read avoids reporting that moment.
    let reread = || async {
        (deps.sleep)(REREAD_DELAY).await;
        read_claude_credentials(&source).await
    };
    let mut credentials = read_claude_credentials(&source).await;
    if credentials.is_none() && is_main {
        credentials = reread().await;
    }
    let held_by = if is_main { None } else { held_by_of(r.renew) };
    let Some(mut credentials) = credentials else {
        // Claude Code cleared this login after its renewal was rejected ("Login expired"): a dead sign-in, not a signed-out one.
        let Some(plan) = read_cleared_claude_login(&source).await else { return FetchResult::of(base) };
        let identity = read_claude_identity(&source);
        let mut u = base;
        u.plan = plan;
        u.email = identity.email;
        u.org = identity.org;
        u.held_by = held_by;
        return FetchResult::of(with(&u, Status::Expired, Some("login-dead")));
    };
    let identity = read_claude_identity(&source);
    let mut known = base;
    known.plan = credentials.plan.clone();
    known.email = identity.email;
    known.org = identity.org;
    known.held_by = held_by;
    // A saved copy of a login Claude Code cleared as dead (`deadTokens`): sign-in expired, nothing is sent anywhere.
    if !is_main
        && let Some(dead) = r.dead_tokens.as_deref()
        && credentials.refresh_hash.as_deref() == Some(dead)
    {
        return FetchResult::of(with(&known, Status::Expired, Some("login-dead")));
    }
    // Only saved accounts whose token family lives nowhere else are renewed here (R6).
    let refresh = if is_main || held_by.is_some() { None } else { deps.refresh_claude.clone() };
    let held = FetchResult::of(with(&known, Status::Elsewhere, None));
    let config_dir = r.config_dir.clone().unwrap_or_default();
    let expired = |c: &ClaudeCredentials| c.expires_at.is_some_and(|at| at <= now + EXPIRY_MARGIN_MS);
    // Renews the profile and re-reads its credentials; the failure result when that did not work.
    let renew = |refresh: RenewFn| {
        let (known, source, config_dir) = (known.clone(), source.clone(), config_dir.clone());
        async move {
            match refresh(&config_dir).await {
                RefreshOutcome::Dead => Err(FetchResult::of(with(&known, Status::Expired, Some("refresh-dead")))),
                RefreshOutcome::Unusable => Err(FetchResult::of(with(&known, Status::Expired, Some("refresh-unusable")))),
                RefreshOutcome::Transient(detail) => {
                    let reason = detail.as_ref().map_or("failed", |d| d.reason.as_str());
                    let retry = detail.as_ref().and_then(|d| d.retry_after_ms).map(|ms| ms as f64);
                    Err(FetchResult::retry(with(&known, Status::Error, Some(&format!("refresh-{reason}"))), retry))
                }
                RefreshOutcome::Ok => match read_claude_credentials(&source).await {
                    Some(renewed) => Ok(renewed),
                    None => Err(FetchResult::of(with(&known, Status::Expired, Some("refresh-reread")))),
                },
            }
        }
    };
    let dormant = FetchResult::of(with(&known, Status::Dormant, None));
    if expired(&credentials) {
        if held_by.is_some() {
            return held;
        }
        match &refresh {
            None => {
                // Live login: with a refresh token Claude Code renews the access token on its next use (not an error).
                if credentials.has_refresh {
                    return dormant;
                }
                let again = reread().await;
                let again_refresh = again.as_ref().is_some_and(|c| c.has_refresh);
                if let Some(a) = again {
                    credentials = a;
                }
                if expired(&credentials) {
                    let status = if again_refresh { Status::Dormant } else { Status::Expired };
                    return FetchResult::of(with(&known, status, None));
                }
            }
            Some(refresh) => {
                match renew(refresh.clone()).await {
                    Ok(c) => credentials = c,
                    Err(failure) => return failure,
                }
                if expired(&credentials) {
                    return FetchResult::of(with(&known, Status::Expired, Some("token-expired")));
                }
            }
        }
    }
    let request = |c: &ClaudeCredentials| {
        get(deps, unimux_net::calls::claude_usage(&deps.claude_url, &c.access_token, &deps.user_agent))
    };
    let result: Result<FetchResult, Failure> = async {
        let mut response = request(&credentials).await?;
        if let Some(refresh) = &refresh
            && response.status == 401
        {
            match renew(refresh.clone()).await {
                Ok(c) => credentials = c,
                Err(failure) => return Ok(failure),
            }
            response = request(&credentials).await?;
        }
        if held_by.is_some() && response.status == 401 {
            return Ok(held.clone());
        }
        if is_main && (response.status == 401 || response.status == 403) {
            // Claude Code may have just renewed the token: look at the file once more before calling the login dead.
            if let Some(again) = reread().await {
                let has_refresh = again.has_refresh;
                credentials = again;
                if expired(&credentials) {
                    let status = if has_refresh { Status::Dormant } else { Status::Expired };
                    return Ok(FetchResult::of(with(&known, status, None)));
                }
                response = request(&credentials).await?;
            }
        }
        // 403 = access denied (a paused subscription, an organisation policy), not a dead sign-in.
        if response.status == 403 {
            return Ok(FetchResult::of(with(&known, Status::Forbidden, Some("http-403"))));
        }
        if response.status == 401 {
            return Ok(FetchResult::of(with(&known, Status::Expired, Some("http-401"))));
        }
        if !response.ok() {
            let error = format!("http-{}", response.status);
            return Ok(FetchResult::retry(with(&known, Status::Error, Some(&error)), retry_after(&response, now)));
        }
        let body = json_body(&response)?;
        Ok(match parse_claude_usage(&body) {
            None => FetchResult::of(with(&known, Status::Error, Some("bad-response"))),
            Some(windows) if windows.is_empty() => FetchResult::of(with(&known, Status::Error, Some("no-windows"))),
            Some(windows) => {
                let mut u = with(&known, Status::Ok, None);
                u.windows = windows;
                FetchResult::of(u)
            }
        })
    }
    .await;
    result.unwrap_or_else(|Failure::Kind(kind)| FetchResult::of(with(&known, Status::Error, Some(kind))))
}

/// `fetchCodex(deps, ref)`.
pub async fn fetch_codex(deps: &FetcherDeps, r: &AccountRef) -> FetchResult {
    let now = (deps.now)();
    // 1.1.2: a saved Codex profile is read from its own CODEX_HOME; its tokens are never renewed here.
    let profile = r.config_dir.clone();
    let held_by = if profile.is_some() { held_by_of(r.renew) } else { None };
    let mut base = ProviderUsage::new(&r.id, Provider::Codex, Status::SignedOut, now, Source::Live);
    if profile.is_some() {
        base.managed = Some(true);
    }
    base.active = r.active == Some(true);
    base.held_by = held_by;
    let source = match &profile {
        Some(dir) => deps.credentials.codex_profile(dir),
        None => deps.credentials.clone(),
    };
    let Some(credentials) = read_codex_credentials(&source) else { return FetchResult::of(base) };
    if credentials.mode == CodexMode::ApiKey {
        return FetchResult::of(with(&base, Status::ApiKey, None));
    }
    let mut known = base;
    known.plan = credentials.plan.clone();
    known.email = credentials.email.clone();
    let expired = credentials.expires_at.is_some_and(|at| at <= now + EXPIRY_MARGIN_MS);
    if profile.is_some() {
        if expired {
            return FetchResult::of(match held_by {
                Some(_) => with(&known, Status::Elsewhere, None),
                None if credentials.has_refresh => with(&known, Status::Dormant, Some("token-expired")),
                None => with(&known, Status::Expired, Some("token-expired")),
            });
        }
        return match read_codex_limits(deps, &credentials, &known, now).await {
            Ok(r) => r,
            Err((status, error, retry)) => {
                let status = if status == Status::Expired && held_by.is_some() { Status::Elsewhere } else { status };
                FetchResult::retry(with(&known, status, error.as_deref()), retry)
            }
        };
    }
    // Network-free answer from the last Codex session; the real failure is reported when there is none.
    let from_log = |status: Status, error: Option<String>, retry: Option<f64>| {
        let known = known.clone();
        let home = (deps.codex_home)();
        async move {
            let log = tokio::task::spawn_blocking(move || read_codex_log(&home, now)).await.ok().flatten();
            match log {
                Some(log) => {
                    // A dead login is reported even though the log has numbers; a failed request is not.
                    let mut u = known.clone();
                    u.plan = log.plan.or(known.plan.clone());
                    u.status = if error.is_some() { Status::Ok } else { Status::Expired };
                    u.windows = log.windows;
                    u.fetched_at = log.at;
                    u.source = Source::Log;
                    if error.is_some() {
                        FetchResult { usage: u, failed: true, retry_after_ms: retry }
                    } else {
                        FetchResult::of(u)
                    }
                }
                None => FetchResult::retry(with(&known, status, error.as_deref()), retry),
            }
        }
    };
    if expired {
        return from_log(Status::Expired, None, None).await;
    }
    match read_codex_limits(deps, &credentials, &known, now).await {
        Ok(r) => r,
        Err((status, error, retry)) => from_log(status, error, retry).await,
    }
}

type CodexFailure = (Status, Option<String>, Option<f64>);

/// `readCodexLimits`: one request to the Codex usage endpoint; every failure goes back to the caller.
async fn read_codex_limits(
    deps: &FetcherDeps,
    credentials: &CodexCredentials,
    known: &ProviderUsage,
    now: f64,
) -> Result<FetchResult, CodexFailure> {
    let token = credentials.access_token.as_deref().unwrap_or("undefined");
    let req = unimux_net::calls::codex_usage(&deps.codex_url, token, credentials.account_id.as_deref());
    let response = match get(deps, req).await {
        Ok(r) => r,
        Err(Failure::Kind(kind)) => return Err((Status::Error, Some(kind.into()), None)),
    };
    if response.status == 401 || response.status == 403 {
        return Err((Status::Expired, None, None));
    }
    if !response.ok() {
        return Err((Status::Error, Some(format!("http-{}", response.status)), retry_after(&response, now)));
    }
    let body = match json_body(&response) {
        Ok(b) => b,
        Err(Failure::Kind(kind)) => return Err((Status::Error, Some(kind.into()), None)),
    };
    let Some(windows) = parse_codex_rate_limits(&body, now) else {
        return Err((Status::Error, Some("bad-response".into()), None));
    };
    let mut u = with(known, Status::Ok, None);
    u.plan = parse_codex_plan(&body).or(known.plan.clone());
    u.windows = windows;
    Ok(FetchResult::of(u))
}

#[cfg(test)]
mod tests;
