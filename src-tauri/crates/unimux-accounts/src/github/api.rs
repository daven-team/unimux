//! GitHub's REST API and OAuth device flow as far as "Publish to GitHub" needs them (port of src/main/github/api.ts). Every
//! request goes through a [`GithubFetch`] (the app's http_fetch client, B3; a fake or a mock server in the tests) built with
//! `unimux_net::calls::github_api` / `github_form` (1.1.4's header sets, 20 s); the token only ever travels in a header.

use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::{Map, Value};
use unimux_net::{CancellationToken, FetchError, Headers, HttpClient, Method, Request, Response, calls};

use super::{GhFail, GhResult};
use crate::js;

/// The error message keys of api.ts `ERR` (Polish source texts; the renderer translates them).
pub mod err {
    pub const NETWORK: &str = "Brak połączenia z GitHubem. Sprawdź internet i spróbuj ponownie.";
    pub const AUTH: &str = "Logowanie do GitHuba wygasło lub zostało cofnięte. Zaloguj się ponownie.";
    pub const EXISTS: &str = "Repozytorium o tej nazwie już istnieje na Twoim koncie GitHub.";
    pub const FORBIDDEN: &str = "GitHub odmówił utworzenia repozytorium.";
    pub const RATE_LIMIT: &str = "Przekroczono limit zapytań do GitHuba. Spróbuj za kilka minut.";
    pub const FAILED: &str = "GitHub nie odpowiedział poprawnie. Spróbuj za chwilę.";
    pub const INVALID_NAME: &str = "GitHub nie przyjął tej nazwy repozytorium.";
    pub const EXPIRED: &str = "Kod logowania wygasł. Zacznij logowanie od nowa.";
    pub const DENIED: &str = "Logowanie do GitHuba zostało odrzucone.";
    pub const CANCELLED: &str = "Logowanie zostało anulowane.";
    pub const NO_CLIENT: &str = "Logowanie przez przeglądarkę nie jest dostępne w tej wersji.";
    pub const DEVICE_FAILED: &str = "Nie udało się rozpocząć logowania do GitHuba.";

    /// Every key (the i18n check of the tests).
    pub const ALL: [&str; 12] = [
        NETWORK,
        AUTH,
        EXISTS,
        FORBIDDEN,
        RATE_LIMIT,
        FAILED,
        INVALID_NAME,
        EXPIRED,
        DENIED,
        CANCELLED,
        NO_CLIENT,
        DEVICE_FAILED,
    ];
}

/// One HTTP request (`FetchLike` of api.ts): the app's http_fetch client, or a fake in the tests.
pub trait GithubFetch: Send + Sync {
    fn fetch(&self, req: Request) -> BoxFuture<'static, Result<Response, FetchError>>;
}

impl GithubFetch for HttpClient {
    fn fetch(&self, req: Request) -> BoxFuture<'static, Result<Response, FetchError>> {
        let client = self.clone();
        Box::pin(async move { client.fetch(req).await })
    }
}

/// Where the requests go: GitHub (default) or a local mock server in the tests.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoints {
    pub api: String,
    pub device_code: String,
    pub token: String,
}

impl Default for Endpoints {
    fn default() -> Self {
        Self {
            api: calls::GITHUB_API.to_string(),
            device_code: calls::GITHUB_DEVICE_CODE_URL.to_string(),
            token: calls::GITHUB_TOKEN_URL.to_string(),
        }
    }
}

impl Endpoints {
    /// Every URL on one base (`http://127.0.0.1:<port>`), with GitHub's paths.
    pub fn local(base: &str) -> Self {
        Self {
            api: base.to_string(),
            device_code: format!("{base}/login/device/code"),
            token: format!("{base}/login/oauth/access_token"),
        }
    }
}

/// What `call` gives back: the status, the headers and the JSON body (null when it is not JSON).
pub struct Answer {
    pub status: u16,
    pub headers: Headers,
    pub body: Value,
}

/// `call` of api.ts: the request, or None when it failed (network, timeout, cancel). A body that is not JSON reads as null.
pub async fn call(
    fetch: &dyn GithubFetch,
    req: Result<Request, FetchError>,
    cancel: Option<&CancellationToken>,
) -> Option<Answer> {
    let mut req = req.ok()?;
    if let Some(token) = cancel {
        req = req.cancel(token.clone());
    }
    let response = fetch.fetch(req).await.ok()?;
    let body = js_json_body(&response);
    Some(Answer { status: response.status, headers: response.headers, body })
}

fn js_json_body(response: &Response) -> Value {
    let text = response.text();
    // `response.json()` is JSON.parse of the UTF-8 text (BOM dropped).
    unimux_core::js_json::parse(&text).unwrap_or(Value::Null)
}

/// `isObject`.
fn object(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// `str(value, max)`: a string of at most `max` UTF-16 units.
fn string_max(value: Option<&Value>, max: usize) -> Option<&str> {
    value.and_then(Value::as_str).filter(|s| js::len16(s) <= max)
}

fn string(value: Option<&Value>) -> Option<&str> {
    string_max(value, 500)
}

/// `text.slice(0, n)` in UTF-16 units (a surrogate pair cut in half loses its first half: a Rust string cannot hold it).
pub fn slice16(text: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in text.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

/// `githubMessage`: GitHub's own explanation, on one line, at most 300 characters (shown untranslated after our message).
fn github_message(body: &Value) -> Option<String> {
    let text = object(body).and_then(|o| string_max(o.get("message"), 2000))?;
    let mut collapsed = String::with_capacity(text.len());
    let mut in_space = false;
    for c in text.chars() {
        if js::is_space(c) {
            if !in_space {
                collapsed.push(' ');
            }
            in_space = true;
        } else {
            collapsed.push(c);
            in_space = false;
        }
    }
    let out = slice16(js::trim(&collapsed), 300);
    (!out.is_empty()).then_some(out)
}

/// ASCII case-insensitive substring test (`/literal/i.test(text)` for an ASCII literal).
fn contains_ci(text: &str, needle: &str) -> bool {
    text.to_ascii_lowercase().contains(&needle.to_ascii_lowercase())
}

/// A created repository (POST /user/repos).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CreatedRepo {
    pub full_name: String,
    pub html_url: String,
    pub clone_url: String,
}

/// `mapCreateRepoError`: 401 the sign-in is no longer valid, 422 with "already exists" the name is taken, 403 / 429 a missing
/// permission or the rate limit, anything else GitHub's own message.
pub fn map_create_repo_error(status: u16, body: &Value, headers: Option<&Headers>) -> GhFail {
    let detail = github_message(body);
    let errors: Vec<&Map<String, Value>> = object(body)
        .and_then(|o| o.get("errors"))
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(object).collect())
        .unwrap_or_default();
    let error_texts = errors
        .iter()
        .map(|e| {
            format!(
                "{} {} {}",
                string(e.get("message")).unwrap_or(""),
                string(e.get("code")).unwrap_or(""),
                string(e.get("field")).unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join(" ");
    if status == 401 {
        return GhFail::new("auth", err::AUTH);
    }
    if status == 422 {
        if contains_ci(&error_texts, "already exists") || contains_ci(detail.as_deref().unwrap_or(""), "already exists") {
            return GhFail::new("exists", err::EXISTS);
        }
        let joined =
            errors.iter().filter_map(|e| string(e.get("message"))).filter(|m| !m.is_empty()).collect::<Vec<_>>().join("; ");
        let reason = if joined.is_empty() { detail } else { Some(joined) };
        return GhFail::new("invalid", err::INVALID_NAME).with_detail(reason.map(|r| slice16(&r, 300)));
    }
    if status == 403 || status == 429 {
        let remaining = headers.and_then(|h| h.get("x-ratelimit-remaining"));
        if status == 429 || remaining.as_deref() == Some("0") || contains_ci(detail.as_deref().unwrap_or(""), "rate limit") {
            return GhFail::new("rate-limit", err::RATE_LIMIT);
        }
        return GhFail::new("forbidden", err::FORBIDDEN).with_detail(detail);
    }
    let detail = match detail {
        Some(d) => format!("HTTP {status}: {d}"),
        None => format!("HTTP {status}"),
    };
    GhFail::new("failed", err::FAILED).with_detail(Some(detail))
}

/// `GITHUB_REPO_URL`: only a plain https://github.com/<owner>/<name>(.git) address is ever added as a remote or opened.
pub fn is_github_repo_url(url: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(r"^https://github\.com/[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}(?:\.git)?$")
            .expect("valid regex")
    })
    .is_match(url)
}

/// `createRepo`: POST /user/repos, a new repository of the signed-in user without any file (the push brings the history).
pub async fn create_repo(
    fetch: &dyn GithubFetch,
    endpoints: &Endpoints,
    token: &str,
    name: &str,
    private: bool,
) -> GhResult<CreatedRepo> {
    let mut body = Map::new();
    body.insert("name".into(), Value::String(name.into()));
    body.insert("private".into(), Value::Bool(private));
    body.insert("auto_init".into(), Value::Bool(false));
    let body = unimux_core::js_json::stringify(&Value::Object(body));
    let url = format!("{}/user/repos", endpoints.api);
    let Some(res) = call(fetch, calls::github_api(Method::POST, &url, token, Some(body)), None).await else {
        return Err(GhFail::new("network", err::NETWORK));
    };
    if res.status != 201 {
        return Err(map_create_repo_error(res.status, &res.body, Some(&res.headers)));
    }
    let empty = Map::new();
    let o = object(&res.body).unwrap_or(&empty);
    let full_name = string_max(o.get("full_name"), 200);
    let html_url = string_max(o.get("html_url"), 300);
    let clone_url = string_max(o.get("clone_url"), 300);
    match (full_name, html_url, clone_url) {
        (Some(f), Some(h), Some(c)) if !f.is_empty() && is_github_repo_url(c) && is_github_repo_url(h) => {
            Ok(CreatedRepo { full_name: f.into(), html_url: h.into(), clone_url: c.into() })
        }
        _ => Err(GhFail::new("failed", err::FAILED)),
    }
}

/// `fetchLogin`: GET /user, the login of the token's owner; `auth` when GitHub no longer accepts the token.
pub async fn fetch_login(fetch: &dyn GithubFetch, endpoints: &Endpoints, token: &str) -> GhResult<String> {
    let url = format!("{}/user", endpoints.api);
    let Some(res) = call(fetch, calls::github_api(Method::GET, &url, token, None), None).await else {
        return Err(GhFail::new("network", err::NETWORK));
    };
    if res.status == 401 {
        return Err(GhFail::new("auth", err::AUTH));
    }
    let login = object(&res.body).and_then(|o| string_max(o.get("login"), 100));
    match login {
        Some(l) if res.status == 200 && !l.is_empty() && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') => {
            Ok(l.to_string())
        }
        _ => Err(GhFail::new("failed", err::FAILED).with_detail(Some(format!("HTTP {}", res.status)))),
    }
}

// ---------- OAuth device flow (RFC 8628, GitHub's flavour) ----------

/// The answer of POST /login/device/code. Times are JS numbers (seconds).
#[derive(Debug, Clone, PartialEq)]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: f64,
    pub interval: f64,
}

/// `typeof v === 'number' && v > 0 ? Math.min(v, max) : fallback`.
fn positive_or(value: Option<&Value>, max: f64, fallback: f64) -> f64 {
    match value.and_then(Value::as_f64) {
        Some(v) if v > 0.0 => v.min(max),
        _ => fallback,
    }
}

/// `requestDeviceCode`.
pub async fn request_device_code(
    fetch: &dyn GithubFetch,
    endpoints: &Endpoints,
    client_id: &str,
    scope: &str,
) -> GhResult<DeviceCode> {
    if client_id.is_empty() {
        return Err(GhFail::new("no-client", err::NO_CLIENT));
    }
    let req = calls::github_form(&endpoints.device_code, &[("client_id", client_id), ("scope", scope)]);
    let Some(res) = call(fetch, req, None).await else {
        return Err(GhFail::new("network", err::NETWORK));
    };
    let empty = Map::new();
    let o = object(&res.body).unwrap_or(&empty);
    let device_code = string_max(o.get("device_code"), 200).filter(|s| !s.is_empty());
    let user_code = string_max(o.get("user_code"), 40).filter(|s| !s.is_empty());
    let verification_uri = string_max(o.get("verification_uri"), 300).filter(|s| !s.is_empty());
    let expires_in = positive_or(o.get("expires_in"), 3600.0, 900.0);
    let interval = positive_or(o.get("interval"), 60.0, 5.0);
    match (device_code, user_code, verification_uri) {
        (Some(d), Some(u), Some(v)) if res.status == 200 => {
            Ok(DeviceCode { device_code: d.into(), user_code: u.into(), verification_uri: v.into(), expires_in, interval })
        }
        _ => {
            let reason = string(o.get("error_description"))
                .or_else(|| string(o.get("error")))
                .map(str::to_string)
                .unwrap_or_else(|| format!("HTTP {}", res.status));
            Err(GhFail::new("failed", err::DEVICE_FAILED).with_detail(Some(slice16(&reason, 300))))
        }
    }
}

/// One answer of the token endpoint (`DevicePoll`).
#[derive(Debug, Clone, PartialEq)]
pub enum DevicePoll {
    Wait { interval: f64 },
    Token(String),
    Fail(GhFail),
}

/// `devicePollStep`: authorization_pending keeps the interval, slow_down raises it (GitHub sends the new one; else +5 s per
/// the RFC, at most 120), expired_token and access_denied end the flow, so does any other error.
pub fn device_poll_step(interval: f64, status: u16, body: &Value) -> DevicePoll {
    let empty = Map::new();
    let o = object(body).unwrap_or(&empty);
    if let Some(token) = string_max(o.get("access_token"), 1024)
        && super::is_token_text(token)
    {
        return DevicePoll::Token(token.to_string());
    }
    let error = string_max(o.get("error"), 100);
    match error {
        Some("authorization_pending") => return DevicePoll::Wait { interval },
        Some("slow_down") => {
            let next = match o.get("interval").and_then(Value::as_f64) {
                Some(v) if v > interval => v,
                _ => interval + 5.0,
            };
            return DevicePoll::Wait { interval: next.min(120.0) };
        }
        Some("expired_token") => return DevicePoll::Fail(GhFail::new("expired", err::EXPIRED)),
        Some("access_denied") => return DevicePoll::Fail(GhFail::new("denied", err::DENIED)),
        _ => {}
    }
    // `str(error_description) ?? error ?? ...`: an empty `error` string still counts (`??` only skips undefined).
    let reason = string(o.get("error_description")).or(error).map(str::to_string).unwrap_or_else(|| format!("HTTP {status}"));
    DevicePoll::Fail(GhFail::new("failed", err::DEVICE_FAILED).with_detail(Some(slice16(&reason, 300))))
}

/// Waits `duration`; ends early when the token is cancelled.
pub type SleepFn = Arc<dyn Fn(Duration, CancellationToken) -> BoxFuture<'static, ()> + Send + Sync>;
/// `Date.now()` (ms).
pub type NowFn = Arc<dyn Fn() -> f64 + Send + Sync>;

pub fn real_sleep() -> SleepFn {
    Arc::new(|duration, cancel| {
        Box::pin(async move {
            tokio::select! {
                _ = tokio::time::sleep(duration) => {}
                _ = cancel.cancelled() => {}
            }
        })
    })
}

pub fn real_now() -> NowFn {
    Arc::new(|| unimux_core::time::now_ms() as f64)
}

/// The options of one poll (`PollOptions`).
pub struct PollOptions<'a> {
    pub fetch: &'a dyn GithubFetch,
    pub endpoints: &'a Endpoints,
    pub client_id: &'a str,
    pub code: &'a DeviceCode,
    pub cancel: CancellationToken,
    pub now: NowFn,
    pub sleep: SleepFn,
    /// Network failures in a row after which the flow gives up (a short outage is waited out). Default 4.
    pub max_network_failures: u32,
}

/// `pollDeviceToken`: polls the token endpoint every `interval` seconds until the user confirmed the code, refused it, or the
/// code expired.
pub async fn poll_device_token(o: PollOptions<'_>) -> GhResult<String> {
    let expires_at = (o.now)() + o.code.expires_in * 1000.0;
    let mut interval = o.code.interval.max(1.0);
    let mut failures = 0;
    let cancelled = || GhFail::new("cancelled", err::CANCELLED);
    loop {
        (o.sleep)(Duration::from_secs_f64(interval), o.cancel.clone()).await;
        if o.cancel.is_cancelled() {
            return Err(cancelled());
        }
        if (o.now)() >= expires_at {
            return Err(GhFail::new("expired", err::EXPIRED));
        }
        let req = calls::github_form(
            &o.endpoints.token,
            &[
                ("client_id", o.client_id),
                ("device_code", &o.code.device_code),
                ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
            ],
        );
        let res = call(o.fetch, req, Some(&o.cancel)).await;
        if o.cancel.is_cancelled() {
            return Err(cancelled());
        }
        let Some(res) = res else {
            failures += 1;
            if failures >= o.max_network_failures {
                return Err(GhFail::new("network", err::NETWORK));
            }
            continue;
        };
        failures = 0;
        match device_poll_step(interval, res.status, &res.body) {
            DevicePoll::Wait { interval: next } => interval = next,
            DevicePoll::Token(token) => return Ok(token),
            DevicePoll::Fail(fail) => return Err(fail),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const TOKEN: &str = "gho_16C7e42F292c6912E7710c838347Ae178B4a";

    /// test/github-publish.test.ts "maps the status codes to what the dialog says".
    #[test]
    fn create_repo_errors() {
        assert_eq!(map_create_repo_error(401, &json!({"message": "Bad credentials"}), None), GhFail::new("auth", err::AUTH));
        let taken = json!({"message": "Repository creation failed.", "errors": [{"resource": "Repository", "code": "custom", "field": "name", "message": "name already exists on this account"}]});
        assert_eq!(map_create_repo_error(422, &taken, None), GhFail::new("exists", err::EXISTS));
        let long = json!({"message": "Validation Failed", "errors": [{"field": "name", "code": "invalid", "message": "name is too long"}]});
        assert_eq!(
            map_create_repo_error(422, &long, None),
            GhFail::new("invalid", err::INVALID_NAME).with_detail(Some("name is too long".into()))
        );
        assert_eq!(map_create_repo_error(403, &json!({"message": "API rate limit exceeded for user."}), None).code, "rate-limit");
        let headers = Headers(vec![("x-ratelimit-remaining".into(), "0".into())]);
        assert_eq!(map_create_repo_error(403, &json!({}), Some(&headers)).code, "rate-limit");
        assert_eq!(map_create_repo_error(429, &Value::Null, None).code, "rate-limit");
        assert_eq!(
            map_create_repo_error(403, &json!({"message": "Resource not accessible by integration"}), None),
            GhFail::new("forbidden", err::FORBIDDEN).with_detail(Some("Resource not accessible by integration".into()))
        );
        assert_eq!(
            map_create_repo_error(502, &Value::Null, None),
            GhFail::new("failed", err::FAILED).with_detail(Some("HTTP 502".into()))
        );
        // GitHub's message on one line, trimmed, at most 300 characters.
        let spaced = json!({"message": "  a \n\t b\u{3000}c  "});
        assert_eq!(map_create_repo_error(500, &spaced, None).detail.as_deref(), Some("HTTP 500: a b c"));
        let long = json!({"message": "x".repeat(400)});
        assert_eq!(map_create_repo_error(403, &long, None).detail.unwrap().len(), 300);
        // A message over 2000 characters is ignored.
        assert_eq!(map_create_repo_error(500, &json!({"message": "x".repeat(2001)}), None).detail.as_deref(), Some("HTTP 500"));
        // A 422 without error messages falls back to GitHub's message.
        assert_eq!(map_create_repo_error(422, &json!({"message": "nope"}), None).detail.as_deref(), Some("nope"));
        assert_eq!(map_create_repo_error(422, &json!({}), None).detail, None);
    }

    #[test]
    fn repo_urls() {
        assert!(is_github_repo_url("https://github.com/ajzak/unimux.git"));
        assert!(is_github_repo_url("https://github.com/ajzak/unimux"));
        for bad in [
            "https://evil.example/x.git",
            "http://github.com/a/b",
            "https://github.com/-a/b",
            "https://github.com/a/b/c",
            "https://github.com/a/b.git\n",
        ] {
            assert!(!is_github_repo_url(bad), "{bad}");
        }
        assert!(!is_github_repo_url(&format!("https://github.com/{}/b", "a".repeat(40))));
    }

    /// "steps: pending keeps the interval, slow_down raises it, the end states end it".
    #[test]
    fn poll_steps() {
        assert_eq!(device_poll_step(5.0, 200, &json!({"error": "authorization_pending"})), DevicePoll::Wait { interval: 5.0 });
        assert_eq!(
            device_poll_step(5.0, 200, &json!({"error": "slow_down", "interval": 10})),
            DevicePoll::Wait { interval: 10.0 }
        );
        assert_eq!(device_poll_step(5.0, 200, &json!({"error": "slow_down"})), DevicePoll::Wait { interval: 10.0 });
        assert_eq!(device_poll_step(118.0, 200, &json!({"error": "slow_down"})), DevicePoll::Wait { interval: 120.0 });
        assert_eq!(
            device_poll_step(5.0, 200, &json!({"error": "expired_token"})),
            DevicePoll::Fail(GhFail::new("expired", err::EXPIRED))
        );
        assert_eq!(
            device_poll_step(5.0, 200, &json!({"error": "access_denied"})),
            DevicePoll::Fail(GhFail::new("denied", err::DENIED))
        );
        assert_eq!(
            device_poll_step(5.0, 200, &json!({"access_token": TOKEN, "token_type": "bearer", "scope": "repo"})),
            DevicePoll::Token(TOKEN.into())
        );
        assert_eq!(
            device_poll_step(
                5.0,
                400,
                &json!({"error": "device_flow_disabled", "error_description": "Device flow is disabled."})
            ),
            DevicePoll::Fail(GhFail::new("failed", err::DEVICE_FAILED).with_detail(Some("Device flow is disabled.".into())))
        );
        assert_eq!(
            device_poll_step(5.0, 500, &Value::Null),
            DevicePoll::Fail(GhFail::new("failed", err::DEVICE_FAILED).with_detail(Some("HTTP 500".into())))
        );
        // A token that cannot be one (a space) is not taken.
        assert!(matches!(device_poll_step(5.0, 200, &json!({"access_token": "has a space"})), DevicePoll::Fail(_)));
    }

    #[test]
    fn slices_in_utf16_units() {
        assert_eq!(slice16("abc", 2), "ab");
        assert_eq!(slice16("a😀b", 2), "a");
        assert_eq!(slice16("a😀b", 3), "a😀");
    }
}
