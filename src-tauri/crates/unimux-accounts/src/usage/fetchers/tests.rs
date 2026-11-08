//! Ports of the main cases of test/usage-fetchers.test.ts.

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicUsize, Ordering};

use futures::FutureExt;
use parking_lot::Mutex;
use serde_json::json;
use unimux_net::{FetchError, Headers, Request, Response};

use super::*;
use crate::refresh::TransientDetail;
use crate::rules::RenewRule;
use crate::usage::types::{HeldBy, WindowId};

const NOW: f64 = 1_791_720_000_000.0;

type Answer = Arc<dyn Fn(&Request, usize) -> Result<Response, FetchError> + Send + Sync>;

struct Fake {
    calls: AtomicUsize,
    requests: Mutex<Vec<Request>>,
    answer: Answer,
}

impl TokenFetch for Fake {
    fn fetch(&self, req: Request) -> BoxFuture<'static, Result<Response, FetchError>> {
        let n = self.calls.fetch_add(1, Ordering::SeqCst);
        let r = (self.answer)(&req, n);
        self.requests.lock().push(req);
        async move { r }.boxed()
    }
}

fn response(status: u16, body: &str, headers: &[(&str, &str)]) -> Response {
    Response {
        status,
        headers: Headers(headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()),
        url: url::Url::parse("https://api.anthropic.com/api/oauth/usage").unwrap(),
        redirected: false,
        body: bytes::Bytes::from(body.to_string()),
    }
}

struct Fx {
    files: Arc<Mutex<BTreeMap<PathBuf, String>>>,
    fake: Arc<Fake>,
    renewals: Arc<AtomicUsize>,
    deps: FetcherDeps,
}

fn fx(answer: impl Fn(&Request, usize) -> Result<Response, FetchError> + Send + Sync + 'static) -> Fx {
    let files: Arc<Mutex<BTreeMap<PathBuf, String>>> = Arc::default();
    let f = files.clone();
    let fake = Arc::new(Fake { calls: AtomicUsize::new(0), requests: Mutex::new(Vec::new()), answer: Arc::new(answer) });
    let credentials = CredentialSource {
        env: Arc::new(BTreeMap::new()),
        home: PathBuf::from("/home/u"),
        darwin: false,
        read_file: Arc::new(move |p| f.lock().get(p).cloned()),
        keychain: None,
    };
    let renewals = Arc::new(AtomicUsize::new(0));
    Fx {
        files,
        fake: fake.clone(),
        renewals,
        deps: FetcherDeps {
            credentials,
            fetch: fake,
            now: Arc::new(|| NOW),
            codex_home: Arc::new(|| PathBuf::from("/nowhere/.codex")),
            claude_url: "https://api.anthropic.com/api/oauth/usage".into(),
            codex_url: "https://chatgpt.com/backend-api/wham/usage".into(),
            refresh_claude: None,
            sleep: Arc::new(|_| async {}.boxed()),
            user_agent: "unimux/1.2.0".into(),
        },
    }
}

impl Fx {
    fn put(&self, path: &str, v: Value) {
        self.files.lock().insert(PathBuf::from(path), v.to_string());
    }
    fn live_login(&self, token: &str, expires: f64, refresh: Option<&str>) {
        let mut oauth = json!({ "accessToken": token, "expiresAt": expires, "subscriptionType": "max", "rateLimitTier": "x_5x" });
        if let Some(r) = refresh {
            oauth["refreshToken"] = json!(r);
        }
        self.put("/home/u/.claude/.credentials.json", json!({ "claudeAiOauth": oauth }));
        self.put("/home/u/.claude.json", json!({ "oauthAccount": { "emailAddress": "a@x.io", "organizationName": "Org" } }));
    }
    fn renew_with(&mut self, outcome: RefreshOutcome, new_token: Option<&'static str>) {
        let (files, n) = (self.files.clone(), self.renewals.clone());
        self.deps.refresh_claude = Some(Arc::new(move |dir: &Path| {
            n.fetch_add(1, Ordering::SeqCst);
            if let Some(t) = new_token {
                let c = json!({ "claudeAiOauth": { "accessToken": t, "refreshToken": "r2", "expiresAt": NOW + 3_600_000.0 } });
                files.lock().insert(dir.join(".credentials.json"), c.to_string());
            }
            let o = outcome.clone();
            async move { o }.boxed()
        }));
    }
}

fn live() -> AccountRef {
    AccountRef { id: "claude:main".into(), provider: "claude".into(), active: Some(true), ..Default::default() }
}

fn saved(renew: RenewRule) -> AccountRef {
    AccountRef {
        id: "claude:r1".into(),
        provider: "claude".into(),
        config_dir: Some(PathBuf::from("/p/r1")),
        key: Some("k".into()),
        renew: Some(renew),
        ..Default::default()
    }
}

const OK_BODY: &str =
    r#"{"five_hour":{"utilization":42,"resets_at":"2026-10-11T15:00:00Z"},"seven_day":{"utilization":10,"resets_at":null}}"#;

#[tokio::test]
async fn reads_the_live_login_with_the_product_headers() {
    let f = fx(|_, _| Ok(response(200, OK_BODY, &[])));
    f.live_login("tok", NOW + 3_600_000.0, Some("r"));
    let r = fetch_claude(&f.deps, &live()).await;
    assert_eq!(r.usage.status, Status::Ok);
    assert_eq!(r.usage.windows.len(), 2);
    assert_eq!(r.usage.windows[0].id, WindowId::FiveHour);
    assert_eq!((r.usage.email.as_deref(), r.usage.plan.as_deref()), (Some("a@x.io"), Some("Max 5x")));
    assert!(r.usage.active);
    let req = f.fake.requests.lock()[0].clone();
    let h: Vec<(String, String)> = req.headers.clone();
    assert!(h.contains(&("Authorization".into(), "Bearer tok".into())));
    assert!(h.contains(&("User-Agent".into(), "unimux/1.2.0".into())));
    assert!(h.contains(&("anthropic-beta".into(), "oauth-2025-04-20".into())));
}

#[tokio::test]
async fn statuses_of_failed_reads() {
    for (status, expect, error) in [
        (403, Status::Forbidden, Some("http-403")),
        (500, Status::Error, Some("http-500")),
        (429, Status::Error, Some("http-429")),
    ] {
        let f = fx(move |_, _| Ok(response(status, "{}", &[("retry-after", "120")])));
        f.live_login("tok", NOW + 3_600_000.0, Some("r"));
        let r = fetch_claude(&f.deps, &live()).await;
        assert_eq!((r.usage.status, r.usage.error.as_deref()), (expect, error), "{status}");
        if status != 403 {
            assert_eq!(r.retry_after_ms, Some(120_000.0));
        }
    }
    let f = fx(|_, _| Ok(response(200, "not json", &[])));
    f.live_login("tok", NOW + 3_600_000.0, None);
    assert_eq!(fetch_claude(&f.deps, &live()).await.usage.error.as_deref(), Some("bad-response"));
    let f = fx(|_, _| Ok(response(200, r#"{"five_hour":{}}"#, &[])));
    f.live_login("tok", NOW + 3_600_000.0, None);
    assert_eq!(fetch_claude(&f.deps, &live()).await.usage.error.as_deref(), Some("no-windows"));
    let f = fx(|_, _| Err(FetchError::Timeout));
    f.live_login("tok", NOW + 3_600_000.0, None);
    assert_eq!(fetch_claude(&f.deps, &live()).await.usage.error.as_deref(), Some("timeout"));
    let f = fx(|_, _| Err(FetchError::RedirectRefused { status: 302, location: Some("x".into()) }));
    f.live_login("tok", NOW + 3_600_000.0, None);
    assert_eq!(fetch_claude(&f.deps, &live()).await.usage.error.as_deref(), Some("network"));
}

#[tokio::test]
async fn the_live_login_is_never_renewed_and_an_expired_one_with_a_refresh_token_is_dormant() {
    let mut f = fx(|_, _| Ok(response(200, OK_BODY, &[])));
    f.renew_with(RefreshOutcome::Ok, Some("new"));
    f.live_login("tok", NOW - 1.0, Some("r"));
    let r = fetch_claude(&f.deps, &live()).await;
    assert_eq!(r.usage.status, Status::Dormant);
    assert_eq!(f.fake.calls.load(Ordering::SeqCst), 0);
    assert_eq!(f.renewals.load(Ordering::SeqCst), 0);
    f.live_login("tok", NOW - 1.0, None);
    assert_eq!(fetch_claude(&f.deps, &live()).await.usage.status, Status::Expired);
    // A 401 of the live login: one re-read, then expired.
    let f = fx(|_, _| Ok(response(401, "{}", &[])));
    f.live_login("tok", NOW + 3_600_000.0, Some("r"));
    let r = fetch_claude(&f.deps, &live()).await;
    assert_eq!((r.usage.status, r.usage.error.as_deref()), (Status::Expired, Some("http-401")));
    assert_eq!(f.fake.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn a_saved_profile_is_renewed_on_401_and_on_expiry_only_when_allowed() {
    let mut f = fx(|req, n| {
        let auth = req.headers.iter().find(|(k, _)| k == "Authorization").map(|(_, v)| v.clone()).unwrap_or_default();
        Ok(if n == 0 && auth == "Bearer old" { response(401, "{}", &[]) } else { response(200, OK_BODY, &[]) })
    });
    f.renew_with(RefreshOutcome::Ok, Some("new"));
    f.put(
        "/p/r1/.credentials.json",
        json!({ "claudeAiOauth": { "accessToken": "old", "refreshToken": "r", "expiresAt": NOW + 3_600_000.0 } }),
    );
    let r = fetch_claude(&f.deps, &saved(RenewRule::Allowed)).await;
    assert_eq!(r.usage.status, Status::Ok);
    assert_eq!(r.usage.managed, Some(true));
    assert_eq!(f.renewals.load(Ordering::SeqCst), 1);
    // Held by the live login: never renewed; an expired one is "elsewhere".
    f.put(
        "/p/r1/.credentials.json",
        json!({ "claudeAiOauth": { "accessToken": "old", "refreshToken": "r", "expiresAt": NOW - 1.0 } }),
    );
    let r = fetch_claude(&f.deps, &saved(RenewRule::HeldByLive)).await;
    assert_eq!((r.usage.status, r.usage.held_by), (Status::Elsewhere, Some(HeldBy::Live)));
    assert_eq!(f.renewals.load(Ordering::SeqCst), 1);
    // A transient renewal failure keeps its Retry-After.
    f.renew_with(
        RefreshOutcome::Transient(Some(TransientDetail { reason: "http-429".into(), retry_after_ms: Some(5000) })),
        None,
    );
    let r = fetch_claude(&f.deps, &saved(RenewRule::Allowed)).await;
    assert_eq!(
        (r.usage.status, r.usage.error.as_deref(), r.retry_after_ms),
        (Status::Error, Some("refresh-http-429"), Some(5000.0))
    );
    f.renew_with(RefreshOutcome::Dead, None);
    assert_eq!(fetch_claude(&f.deps, &saved(RenewRule::Allowed)).await.usage.error.as_deref(), Some("refresh-dead"));
}

#[tokio::test]
async fn dead_copies_and_cleared_logins_are_expired_without_a_request() {
    let f = fx(|_, _| Ok(response(200, OK_BODY, &[])));
    f.put(
        "/p/r1/.credentials.json",
        json!({ "claudeAiOauth": { "accessToken": "a", "refreshToken": "dead", "expiresAt": NOW + 3_600_000.0 } }),
    );
    let mut r = saved(RenewRule::Allowed);
    r.dead_tokens = Some(crate::js::sha256_hex("dead"));
    let got = fetch_claude(&f.deps, &r).await;
    assert_eq!((got.usage.status, got.usage.error.as_deref()), (Status::Expired, Some("login-dead")));
    f.put(
        "/home/u/.claude/.credentials.json",
        json!({ "claudeAiOauth": { "accessToken": "", "refreshToken": "", "subscriptionType": "pro" } }),
    );
    let got = fetch_claude(&f.deps, &live()).await;
    assert_eq!(
        (got.usage.status, got.usage.error.as_deref(), got.usage.plan.as_deref()),
        (Status::Expired, Some("login-dead"), Some("Pro"))
    );
    assert_eq!(f.fake.calls.load(Ordering::SeqCst), 0);
    let empty = fx(|_, _| Ok(response(200, OK_BODY, &[])));
    assert_eq!(fetch_claude(&empty.deps, &live()).await.usage.status, Status::SignedOut);
}

fn jwt(claims: Value) -> String {
    use base64::Engine;
    format!("h.{}.s", base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(claims.to_string()))
}

#[tokio::test]
async fn codex_reads_with_the_account_header_and_falls_back_to_the_session_log() {
    let f = fx(|_, _| {
        Ok(response(
            200,
            r#"{"plan_type":"pro","rate_limit":{"primary_window":{"used_percent":3,"limit_window_seconds":18000}}}"#,
            &[],
        ))
    });
    let access = jwt(json!({ "exp": (NOW / 1000.0) + 3600.0 }));
    f.put(
        "/home/u/.codex/auth.json",
        json!({ "tokens": { "access_token": access, "account_id": "acc", "id_token": jwt(json!({ "email": "c@x.io" })) } }),
    );
    let codex = AccountRef { id: "codex:main".into(), provider: "codex".into(), ..Default::default() };
    let r = fetch_codex(&f.deps, &codex).await;
    assert_eq!((r.usage.status, r.usage.plan.as_deref(), r.usage.email.as_deref()), (Status::Ok, Some("pro"), Some("c@x.io")));
    let req = f.fake.requests.lock()[0].clone();
    assert!(req.headers.contains(&("ChatGPT-Account-Id".into(), "acc".into())));

    let tmp = tempfile::tempdir().unwrap();
    let day = tmp.path().join("sessions").join("2026");
    std::fs::create_dir_all(&day).unwrap();
    std::fs::write(
        day.join("a.jsonl"),
        r#"{"timestamp":"2026-10-11T11:00:00Z","payload":{"rate_limits":{"primary":{"used_percent":9}}}}"#,
    )
    .unwrap();
    let mut f = fx(|_, _| Ok(response(500, "{}", &[("retry-after", "60")])));
    let home = tmp.path().to_path_buf();
    f.deps.codex_home = Arc::new(move || home.clone());
    f.put("/home/u/.codex/auth.json", json!({ "tokens": { "access_token": access } }));
    let r = fetch_codex(&f.deps, &codex).await;
    assert_eq!((r.usage.status, r.usage.source, r.failed, r.retry_after_ms), (Status::Ok, Source::Log, true, Some(60_000.0)));
    // A saved Codex profile has no log fallback; 401 of a held one is "elsewhere".
    let f = fx(|_, _| Ok(response(401, "{}", &[])));
    f.put("/c/1/auth.json", json!({ "tokens": { "access_token": access } }));
    let profile = AccountRef {
        id: "codex:1".into(),
        provider: "codex".into(),
        config_dir: Some(PathBuf::from("/c/1")),
        renew: Some(RenewRule::SwitchedOut),
        ..Default::default()
    };
    let r = fetch_codex(&f.deps, &profile).await;
    assert_eq!((r.usage.status, r.usage.held_by), (Status::Elsewhere, Some(HeldBy::SwitchedOut)));
    f.put("/home/u/.codex/auth.json", json!({ "OPENAI_API_KEY": "sk" }));
    assert_eq!(fetch_codex(&f.deps, &codex).await.usage.status, Status::ApiKey);
}
