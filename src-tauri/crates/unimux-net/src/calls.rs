//! The requests 1.1.4 makes, with their exact header sets, timeouts and redirect rules, so the porting packages (A3 token
//! renewal, A5 usage, A6 GitHub, G8 changelog, U1 update feed) build them from one place. Sources are named per function.

use std::sync::Arc;
use std::time::Duration;

use http::Method;
use url::Url;

use crate::FetchError;
use crate::request::{Redirect, Request, Route};

/// src/main/accounts/refresh.ts
pub const OAUTH_TOKEN_URL: &str = "https://platform.claude.com/v1/oauth/token";
pub const OAUTH_CLIENT_ID: &str = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
/// User-Agent of a token renewal when no version is configured (refresh.ts REFRESH_USER_AGENT).
pub const REFRESH_USER_AGENT: &str = "unimux";
pub const TOKEN_TIMEOUT: Duration = Duration::from_secs(10);
/// tokenTransport.ts MAX_BODY_BYTES.
pub const TOKEN_MAX_BODY: u64 = 1_000_000;

/// src/main/index.ts usageDeps; fetchers.ts REQUEST_TIMEOUT_MS.
pub const CLAUDE_USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
pub const CODEX_USAGE_URL: &str = "https://chatgpt.com/backend-api/wham/usage";
pub const USAGE_TIMEOUT: Duration = Duration::from_secs(5);

/// src/main/github/api.ts
pub const GITHUB_API: &str = "https://api.github.com";
pub const GITHUB_DEVICE_CODE_URL: &str = "https://github.com/login/device/code";
pub const GITHUB_TOKEN_URL: &str = "https://github.com/login/oauth/access_token";
pub const GITHUB_TIMEOUT: Duration = Duration::from_secs(20);

/// src/main/index.ts changelog fetchJson.
pub const CHANGELOG_TIMEOUT: Duration = Duration::from_secs(10);

/// ARCHITECTURE section 8: the Tauri update feed; 90 s lookup.
pub const UPDATE_FEED_URL: &str = "https://github.com/daven-team/unimux/releases/latest/download/latest.json";
pub const UPDATE_FEED_TIMEOUT: Duration = Duration::from_secs(90);
/// macUpdate/netFetch.ts MAX_NET_REDIRECTS.
pub const UPDATE_MAX_REDIRECTS: u32 = 5;
pub const UPDATE_USER_AGENT: &str = "unimux-updater";

/// `unimux/<version>`: the product User-Agent of token renewals and usage reads (never Claude Code's).
pub fn product_user_agent(version: &str) -> String {
    format!("unimux/{version}")
}

/// Claude token renewal (refresh.ts + tokenTransport.ts directFetch / createTokenFetch): one JSON POST with exactly
/// `Content-Type` and `User-Agent` (plus Host, Content-Length, `Connection: close`), HTTP/1.1, every 3xx refused, 10 s, 1 MB cap,
/// direct first and the system proxy only when no connection could be made.
pub fn token_renewal(url: &str, refresh_token: &str, user_agent: &str) -> Result<Request, FetchError> {
    let mut body = serde_json::Map::new();
    body.insert("grant_type".into(), "refresh_token".into());
    body.insert("refresh_token".into(), refresh_token.into());
    body.insert("client_id".into(), OAUTH_CLIENT_ID.into());
    let body = serde_json::Value::Object(body).to_string();
    Ok(Request::post(url)?
        .header("content-type", "application/json")
        .header("user-agent", user_agent)
        .body(body)
        .timeout(TOKEN_TIMEOUT)
        .redirect(Redirect::ErrorAny3xx)
        .max_body(TOKEN_MAX_BODY)
        .connection_close()
        .http1_only()
        .route(Route::DirectThenSystem))
}

/// Claude usage read (fetchers.ts readClaude): Accept, the bearer token, the OAuth beta header and the product User-Agent;
/// 5 s; redirects refused (index.ts `redirect: 'error'`, a bearer token never follows one); system proxy.
pub fn claude_usage(url: &str, access_token: &str, user_agent: &str) -> Result<Request, FetchError> {
    Ok(Request::get(url)?
        .header("Accept", "application/json")
        .header("Authorization", &format!("Bearer {access_token}"))
        .header("anthropic-beta", "oauth-2025-04-20")
        .header("User-Agent", user_agent)
        .timeout(USAGE_TIMEOUT)
        .redirect(Redirect::Error)
        .route(Route::System))
}

/// Codex usage read (fetchers.ts readCodexLimits): Accept, the bearer token and the account header when known; 5 s;
/// redirects refused; system proxy.
pub fn codex_usage(url: &str, access_token: &str, account_id: Option<&str>) -> Result<Request, FetchError> {
    let mut req =
        Request::get(url)?.header("Accept", "application/json").header("Authorization", &format!("Bearer {access_token}"));
    if let Some(account) = account_id.filter(|a| !a.is_empty()) {
        req = req.header("ChatGPT-Account-Id", account);
    }
    Ok(req.timeout(USAGE_TIMEOUT).redirect(Redirect::Error).route(Route::System))
}

/// Release notes from the GitHub API (index.ts changelog fetchJson): GitHub's media type and `User-Agent: unimux`, 10 s.
pub fn changelog(url: &str) -> Result<Request, FetchError> {
    Ok(Request::get(url)?
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "unimux")
        .timeout(CHANGELOG_TIMEOUT)
        .route(Route::System))
}

/// GitHub REST call (github/api.ts apiHeaders): JSON media type, the bearer token, the API version and `User-Agent: unimux`;
/// a JSON body adds `Content-Type: application/json` (createRepo); 20 s.
pub fn github_api(method: Method, url: &str, token: &str, json_body: Option<String>) -> Result<Request, FetchError> {
    let mut req = Request::new(method, url)?
        .header("Accept", "application/vnd.github+json")
        .header("Authorization", &format!("Bearer {token}"))
        .header("X-GitHub-Api-Version", "2022-11-28")
        .header("User-Agent", "unimux");
    if let Some(body) = json_body {
        req = req.header("Content-Type", "application/json").body(body);
    }
    Ok(req.timeout(GITHUB_TIMEOUT).route(Route::System))
}

/// GitHub device flow POST (github/api.ts formHeaders): a form body; 20 s.
pub fn github_form(url: &str, fields: &[(&str, &str)]) -> Result<Request, FetchError> {
    let body = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(fields).finish();
    Ok(Request::post(url)?
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("User-Agent", "unimux")
        .body(body)
        .timeout(GITHUB_TIMEOUT)
        .route(Route::System))
}

/// macUpdate/feed.ts isTrustedUpdateUrl: https on the default port, no credentials, github.com or a *.githubusercontent.com
/// host; or exactly one of `extra_origins` (a development feed).
pub fn is_trusted_update_url(url: &Url, extra_origins: &[String]) -> bool {
    if extra_origins.iter().any(|o| *o == url.origin().ascii_serialization()) {
        return true;
    }
    let Some(host) = url.host_str() else { return false };
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && (host == "github.com" || host.ends_with(".githubusercontent.com"))
}

/// Update feed / download request (macUpdate engine + netFetch): `User-Agent: unimux-updater`, no caching, at most 5
/// redirects, every address (the first and each hop) checked with `is_trusted_update_url`. The feed sets a 90 s timeout;
/// a download (`timeout` None) reads its body through `fetch_stream` with its own stall check.
pub fn update_request(url: &str, extra_origins: Vec<String>, timeout: Option<Duration>) -> Result<Request, FetchError> {
    let mut req = Request::get(url)?
        .header("User-Agent", UPDATE_USER_AGENT)
        .header("Cache-Control", "no-cache")
        .header("Pragma", "no-cache")
        .redirect(Redirect::Follow { max: UPDATE_MAX_REDIRECTS })
        .route(Route::System)
        .url_check(Arc::new(move |u: &Url| is_trusted_update_url(u, &extra_origins)));
    if let Some(timeout) = timeout {
        req = req.timeout(timeout);
    }
    Ok(req)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trusted(s: &str, extra: &[&str]) -> bool {
        let extra: Vec<String> = extra.iter().map(|e| e.to_string()).collect();
        Url::parse(s).map(|u| is_trusted_update_url(&u, &extra)).unwrap_or(false)
    }

    /// test/mac-update-feed.test.ts "isTrustedUpdateUrl".
    #[test]
    fn trusted_update_urls_like_1_1_4() {
        assert!(trusted("https://github.com/daven-team/unimux/releases/latest/download/latest-mac.yml", &[]));
        assert!(trusted(UPDATE_FEED_URL, &[]));
        assert!(trusted("https://objects.githubusercontent.com/a", &[]));
        assert!(trusted("https://release-assets.githubusercontent.com/a", &[]));
        for bad in [
            "http://github.com/a",
            "https://githubusercontent.com/a",
            "https://evilgithubusercontent.com/a",
            "https://github.com.evil.example/a",
            "https://github.com:444/a",
            "https://u:p@github.com/a",
            "ftp://github.com/a",
            "not a url",
            "",
        ] {
            assert!(!trusted(bad, &[]), "{bad}");
        }
        assert!(trusted("http://localhost:8080/latest-mac.yml", &["http://localhost:8080"]));
        assert!(!trusted("http://localhost:9999/latest-mac.yml", &["http://localhost:8080"]));
        // WHATWG URL: the default port is dropped, so :443 counts as no port.
        assert!(trusted("https://github.com:443/a", &[]));
    }

    #[test]
    fn token_renewal_body_is_json_stringify_order() {
        let req = token_renewal("https://platform.claude.com/v1/oauth/token", "r\"t\u{2028}", "unimux/1.2.0").unwrap();
        assert_eq!(
            std::str::from_utf8(req.body.as_ref().unwrap()).unwrap(),
            "{\"grant_type\":\"refresh_token\",\"refresh_token\":\"r\\\"t\u{2028}\",\"client_id\":\"9d1c250a-e61b-44d9-88ed-5944d1962f5e\"}"
        );
        assert_eq!(req.redirect, Redirect::ErrorAny3xx);
        assert_eq!(req.route, Route::DirectThenSystem);
        assert_eq!(req.max_body, Some(1_000_000));
        assert_eq!(req.timeout, Some(Duration::from_secs(10)));
    }

    #[test]
    fn github_form_is_url_search_params() {
        let req = github_form(GITHUB_DEVICE_CODE_URL, &[("client_id", "Iv1.x"), ("scope", "repo read:org")]).unwrap();
        // URLSearchParams.toString(): spaces as '+', ':' percent-encoded.
        assert_eq!(req.body.as_deref(), Some(&b"client_id=Iv1.x&scope=repo+read%3Aorg"[..]));
    }
}
