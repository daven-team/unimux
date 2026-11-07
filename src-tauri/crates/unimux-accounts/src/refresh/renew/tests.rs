//! Ports of test/accounts-refresh.test.ts and the request half of token-transport.test.ts.

use super::*;
use parking_lot::Mutex;
use serde_json::json;
use std::sync::atomic::{AtomicUsize, Ordering};
use unimux_net::{Headers, Method, Redirect};

const NOW: f64 = 1_791_720_000_000.0; // 2026-10-11T12:00:00Z

type Answer = Arc<dyn Fn(&Request) -> BoxFuture<'static, Result<Response, FetchError>> + Send + Sync>;

struct Fake {
    calls: AtomicUsize,
    requests: Mutex<Vec<Request>>,
    answer: Answer,
}

impl TokenFetch for Fake {
    fn fetch(&self, req: Request) -> BoxFuture<'static, Result<Response, FetchError>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        let fut = (self.answer)(&req);
        self.requests.lock().push(req);
        fut
    }
}

fn fake(answer: impl Fn(&Request) -> BoxFuture<'static, Result<Response, FetchError>> + Send + Sync + 'static) -> Arc<Fake> {
    Arc::new(Fake { calls: AtomicUsize::new(0), requests: Mutex::new(Vec::new()), answer: Arc::new(answer) })
}

fn response(status: u16, body: &str, headers: &[(&str, &str)]) -> Response {
    Response {
        status,
        headers: Headers(headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()),
        url: url::Url::parse(OAUTH_TOKEN_URL).unwrap(),
        redirected: false,
        body: bytes::Bytes::from(body.to_string()),
    }
}

fn reply(status: u16, body: Value) -> Result<Response, FetchError> {
    Ok(response(status, &body.to_string(), &[]))
}

struct Fx {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    renewer: Renewer,
}

impl Fx {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("p");
        std::fs::create_dir_all(&dir).unwrap();
        Self { _tmp: tmp, dir, renewer: Renewer::new(Arc::new(ProfileLocks::new())) }
    }
    fn write(&self, v: &Value) {
        std::fs::write(self.dir.join(".credentials.json"), js_json::stringify(v)).unwrap();
    }
    fn read(&self) -> Value {
        js_json::parse(&std::fs::read_to_string(self.dir.join(".credentials.json")).unwrap()).unwrap()
    }
    fn temps(&self) -> Vec<String> {
        std::fs::read_dir(&self.dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|n| n.ends_with(".tmp"))
            .collect()
    }
    async fn refresh(&self, deps: &RefreshDeps) -> RefreshOutcome {
        self.renewer.refresh(&self.dir, deps).await
    }
}

fn profile() -> Value {
    json!({ "claudeAiOauth": { "accessToken": "old-access", "refreshToken": "old-refresh", "expiresAt": 1, "scopes": ["a"], "subscriptionType": "max" }, "mcpOAuth": { "keep": "me" } })
}

fn deps(fetch: Arc<Fake>) -> RefreshDeps {
    RefreshDeps {
        fetch,
        now: Arc::new(|| NOW),
        token_url: None,
        delay: Some(Arc::new(|_| async {}.boxed())),
        user_agent: None,
        limits: None,
        random: Some(Arc::new(|| 0.0)),
    }
}

fn t(reason: &str, ms: Option<u64>) -> RefreshOutcome {
    RefreshOutcome::Transient(Some(TransientDetail { reason: reason.into(), retry_after_ms: ms }))
}

fn now_at(at: Arc<Mutex<f64>>) -> Arc<dyn Fn() -> f64 + Send + Sync> {
    Arc::new(move || *at.lock())
}

#[tokio::test]
async fn leaves_no_temp_file_and_reports_transient_when_the_final_rename_fails() {
    let fx = Fx::new();
    fx.write(&profile());
    let file = fx.dir.join(".credentials.json");
    let f = fake(move |_| {
        // Replace the file with a directory after it was read, so the rename onto it fails.
        std::fs::remove_file(&file).ok();
        std::fs::create_dir_all(&file).unwrap();
        async { reply(200, json!({ "access_token": "n", "expires_in": 60 })) }.boxed()
    });
    assert_eq!(fx.refresh(&deps(f)).await, t("write", None));
    assert!(fx.temps().is_empty());
}

#[tokio::test]
async fn retries_storing_a_rotated_token_and_then_reports_the_login_as_unusable() {
    let fx = Fx::new();
    fx.write(&profile());
    let file = fx.dir.join(".credentials.json");
    let f = fake(move |_| {
        std::fs::remove_file(&file).ok();
        std::fs::create_dir_all(&file).unwrap();
        async { reply(200, json!({ "access_token": "n", "refresh_token": "rotated", "expires_in": 60 })) }.boxed()
    });
    assert_eq!(fx.refresh(&deps(f.clone())).await, RefreshOutcome::Unusable);
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    assert!(fx.temps().is_empty());
}

#[tokio::test]
async fn renews_the_tokens_rotates_the_refresh_token_and_keeps_every_other_key() {
    let fx = Fx::new();
    fx.write(&profile());
    let f = fake(|_| {
        async {
            reply(200, json!({ "access_token": "new-access", "refresh_token": "new-refresh", "expires_in": 3600, "scope": "user:inference user:profile" }))
        }
        .boxed()
    });
    assert_eq!(fx.refresh(&deps(f.clone())).await, RefreshOutcome::Ok);
    assert_eq!(
        js_json::stringify(&fx.read()),
        js_json::stringify(&json!({
            "claudeAiOauth": { "accessToken": "new-access", "refreshToken": "new-refresh", "expiresAt": js::num(NOW + 3_600_000.0), "scopes": ["user:inference", "user:profile"], "subscriptionType": "max" },
            "mcpOAuth": { "keep": "me" }
        }))
    );
    let req = f.requests.lock()[0].clone();
    assert_eq!(req.url.as_str(), OAUTH_TOKEN_URL);
    assert_eq!(req.method, Method::POST);
    assert_eq!(
        std::str::from_utf8(req.body.as_ref().unwrap()).unwrap(),
        format!(r#"{{"grant_type":"refresh_token","refresh_token":"old-refresh","client_id":"{OAUTH_CLIENT_ID}"}}"#)
    );
    assert_eq!(req.redirect, Redirect::ErrorAny3xx);
}

#[tokio::test]
async fn keeps_the_old_refresh_token_when_the_server_does_not_rotate_it() {
    let fx = Fx::new();
    fx.write(&profile());
    let f = fake(|_| async { reply(200, json!({ "access_token": "n", "expires_in": 60 })) }.boxed());
    fx.refresh(&deps(f)).await;
    let oauth = fx.read()["claudeAiOauth"].clone();
    assert_eq!((oauth["accessToken"].as_str(), oauth["refreshToken"].as_str()), (Some("n"), Some("old-refresh")));
    assert_eq!(oauth["scopes"], json!(["a"]));
}

#[tokio::test]
async fn reports_a_dead_login_only_for_an_explicit_grant_rejection() {
    let fx = Fx::new();
    fx.write(&profile());
    for (status, error, want) in [
        (400, "invalid_grant", RefreshOutcome::Dead),
        (401, "invalid_client", t("invalid-client", None)),
        (403, "unauthorized_client", t("invalid-client", None)),
        (400, "something_else", t("http-400", None)),
        (500, "invalid_grant", t("http-500", None)),
    ] {
        let f = fake(move |_| async move { reply(status, json!({ "error": error })) }.boxed());
        assert_eq!(fx.refresh(&deps(f)).await, want, "{status} {error}");
    }
    // `{ error: { type } }` too.
    let f = fake(|_| async { reply(401, json!({ "error": { "type": "invalid_grant" } })) }.boxed());
    assert_eq!(fx.refresh(&deps(f)).await, RefreshOutcome::Dead);
    assert_eq!(fx.read()["claudeAiOauth"]["accessToken"], "old-access");
}

#[tokio::test]
async fn treats_network_errors_garbage_bodies_and_missing_files_as_transient_and_a_missing_refresh_token_as_dead() {
    let fx = Fx::new();
    fx.write(&profile());
    let net = fake(|_| async { Err(FetchError::Connect("offline".into())) }.boxed());
    assert_eq!(fx.refresh(&deps(net)).await, t("network", None));
    let html = fake(|_| async { Ok(response(200, "<html>", &[])) }.boxed());
    assert_eq!(fx.refresh(&deps(html)).await, t("bad-response", None));
    let empty = fake(|_| async { reply(200, json!({ "access_token": "", "expires_in": 5 })) }.boxed());
    assert_eq!(fx.refresh(&deps(empty)).await, t("bad-response", None));
    let never = fake(|_| panic!("no request"));
    assert_eq!(fx.renewer.refresh(&fx.dir.join("missing"), &deps(never.clone())).await, t("read", None));
    fx.write(&json!({ "claudeAiOauth": { "accessToken": "x" } }));
    assert_eq!(fx.refresh(&deps(never.clone())).await, RefreshOutcome::Dead);
    std::fs::write(fx.dir.join(".credentials.json"), "{broken").unwrap();
    assert_eq!(fx.refresh(&deps(never)).await, t("read", None));
}

#[tokio::test]
async fn reports_a_rate_limited_token_endpoint_with_a_hard_wait_without_touching_the_login() {
    let fx = Fx::new();
    fx.write(&profile());
    let date = httpdate::fmt_http_date(std::time::UNIX_EPOCH + Duration::from_millis((NOW + 2_400_000.0) as u64));
    for (header, want) in [
        (Some("60".to_string()), LIMIT_BASE_MS as u64),
        (Some("1800".to_string()), 1_800_000),
        (Some(date), 2_400_000),
        (Some("999999".to_string()), 3_600_000),
        (None, LIMIT_BASE_MS as u64),
    ] {
        let f = fake(move |_| {
            let h = header.clone();
            async move {
                let headers: Vec<(&str, &str)> = h.as_deref().map(|v| vec![("retry-after", v)]).unwrap_or_default();
                Ok(response(429, r#"{"error":"rate_limit_error"}"#, &headers))
            }
            .boxed()
        });
        assert_eq!(fx.refresh(&deps(f)).await, t("http-429", Some(want)));
    }
    assert_eq!(fx.read()["claudeAiOauth"]["refreshToken"], "old-refresh");
}

#[tokio::test]
async fn sends_an_own_user_agent_that_is_never_claude_code_or_a_browser() {
    let fx = Fx::new();
    fx.write(&profile());
    let f = fake(|_| async { reply(200, json!({ "access_token": "n", "expires_in": 60 })) }.boxed());
    fx.refresh(&deps(f.clone())).await;
    let mut d = deps(f.clone());
    d.user_agent = Some("unimux/9.9.9".into());
    fx.refresh(&d).await;
    let reqs = f.requests.lock().clone();
    let names = |r: &Request| r.headers.iter().map(|(k, v)| (k.clone(), v.clone())).collect::<Vec<_>>();
    assert_eq!(
        names(&reqs[0]),
        vec![
            ("content-type".to_string(), "application/json".to_string()),
            ("user-agent".to_string(), REFRESH_USER_AGENT.to_string())
        ]
    );
    assert!(!REFRESH_USER_AGENT.to_ascii_lowercase().starts_with("claude") && !REFRESH_USER_AGENT.starts_with("Mozilla"));
    assert_eq!(names(&reqs[1])[1].1, "unimux/9.9.9");
}

fn limited() -> Arc<Fake> {
    fake(|_| async { Ok(response(429, r#"{"error":"rate_limit_error"}"#, &[])) }.boxed())
}

#[tokio::test]
async fn does_not_ask_again_for_the_same_refresh_token_until_the_window_passed() {
    let fx = Fx::new();
    fx.write(&profile());
    let at = Arc::new(Mutex::new(NOW));
    let limits = Arc::new(RefreshLimits::new(None, now_at(at.clone())));
    let f = limited();
    let d = RefreshDeps { now: now_at(at.clone()), limits: Some(limits.clone()), ..deps(f.clone()) };
    assert_eq!(fx.refresh(&d).await, t("http-429", Some(LIMIT_BASE_MS as u64)));
    assert_eq!(limits.get(&refresh_limit_key("old-refresh")), Some(RefreshLimit { until: NOW + LIMIT_BASE_MS, failures: 1 }));
    *at.lock() = NOW + 60_000.0;
    for _ in 0..5 {
        assert_eq!(fx.refresh(&d).await, t("http-429", Some(LIMIT_BASE_MS as u64 - 60_000)));
    }
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    *at.lock() = NOW + LIMIT_BASE_MS + 1.0;
    fx.refresh(&d).await;
    assert_eq!(f.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn doubles_the_wait_with_every_further_429_up_to_an_hour_and_adds_at_most_20_percent_jitter() {
    let fx = Fx::new();
    fx.write(&profile());
    let at = Arc::new(Mutex::new(NOW));
    let limits = Arc::new(RefreshLimits::new(None, now_at(at.clone())));
    let mut waits = Vec::new();
    for _ in 0..6 {
        let d = RefreshDeps { now: now_at(at.clone()), limits: Some(limits.clone()), ..deps(limited()) };
        match fx.refresh(&d).await {
            RefreshOutcome::Transient(Some(TransientDetail { retry_after_ms: Some(ms), .. })) => waits.push(ms),
            other => panic!("{other:?}"),
        }
        *at.lock() = limits.get(&refresh_limit_key("old-refresh")).unwrap().until + 1.0;
    }
    assert_eq!(waits, [5u64, 10, 20, 40, 60, 60].map(|m| m * 60_000));
    let d =
        RefreshDeps { now: now_at(at.clone()), limits: Some(limits.clone()), random: Some(Arc::new(|| 1.0)), ..deps(limited()) };
    assert_eq!(fx.refresh(&d).await, t("http-429", Some((LIMIT_MAX_MS * 1.2).round() as u64)));
}

#[tokio::test]
async fn lets_a_new_refresh_token_through_at_once_and_forgets_the_limit_after_a_success() {
    let fx = Fx::new();
    fx.write(&profile());
    let limits = Arc::new(RefreshLimits::new(None, Arc::new(|| NOW)));
    fx.refresh(&RefreshDeps { limits: Some(limits.clone()), ..deps(limited()) }).await;
    fx.write(&json!({ "claudeAiOauth": { "accessToken": "a2", "refreshToken": "brand-new", "expiresAt": 1 } }));
    let ok = fake(|_| async { reply(200, json!({ "access_token": "n", "refresh_token": "rotated", "expires_in": 60 })) }.boxed());
    let d = RefreshDeps { now: Arc::new(|| NOW + 1000.0), limits: Some(limits.clone()), ..deps(ok.clone()) };
    assert_eq!(fx.refresh(&d).await, RefreshOutcome::Ok);
    assert_eq!(ok.calls.load(Ordering::SeqCst), 1);
    assert_eq!(limits.get(&refresh_limit_key("brand-new")), None);
    // A success of the very token that was limited clears its own entry.
    let same = Arc::new(RefreshLimits::new(None, Arc::new(|| NOW)));
    fx.write(&profile());
    fx.refresh(&RefreshDeps { limits: Some(same.clone()), ..deps(limited()) }).await;
    same.set(&refresh_limit_key("old-refresh"), RefreshLimit { until: NOW, failures: 3 });
    let ok = fake(|_| async { reply(200, json!({ "access_token": "n", "expires_in": 60 })) }.boxed());
    fx.refresh(&RefreshDeps { now: Arc::new(|| NOW + 1.0), limits: Some(same.clone()), ..deps(ok) }).await;
    assert_eq!(same.get(&refresh_limit_key("old-refresh")), None);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn never_fires_two_requests_at_once_and_shares_one_request_between_concurrent_calls() {
    let fx = Fx::new();
    fx.write(&profile());
    let (tx, rx) = tokio::sync::oneshot::channel::<Response>();
    let rx = Arc::new(Mutex::new(Some(rx)));
    let f = fake(move |_| {
        let rx = rx.lock().take().expect("one request only");
        async move { Ok(rx.await.unwrap()) }.boxed()
    });
    let d = deps(f.clone());
    let calls: Vec<_> = (0..3).map(|_| fx.renewer.refresh(&fx.dir, &d)).collect();
    while f.calls.load(Ordering::SeqCst) == 0 {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    tx.send(response(200, r#"{"access_token":"n","refresh_token":"r2","expires_in":60}"#, &[])).unwrap();
    for out in futures::future::join_all(calls).await {
        assert_eq!(out, RefreshOutcome::Ok);
    }
    assert_eq!(f.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fx.read()["claudeAiOauth"]["refreshToken"], "r2");
    assert_eq!(fx.renewer.inflight.lock().len(), 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_caller_that_stops_waiting_does_not_cut_the_renewal_before_the_write() {
    let fx = Fx::new();
    fx.write(&profile());
    let f = fake(|_| {
        async {
            tokio::time::sleep(Duration::from_millis(100)).await;
            reply(200, json!({ "access_token": "n", "refresh_token": "r3", "expires_in": 60 }))
        }
        .boxed()
    });
    let d = deps(f);
    let call = fx.renewer.refresh(&fx.dir, &d);
    assert!(tokio::time::timeout(Duration::from_millis(10), call).await.is_err());
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(fx.read()["claudeAiOauth"]["refreshToken"], "r3");
}

#[tokio::test]
async fn keeps_the_window_across_a_restart_through_the_limits_file() {
    let fx = Fx::new();
    fx.write(&profile());
    let file = fx.dir.join("refresh-limits.json");
    let first = Arc::new(RefreshLimits::new(Some(file.clone()), Arc::new(|| NOW)));
    fx.refresh(&RefreshDeps { limits: Some(first), ..deps(limited()) }).await;
    let raw = std::fs::read_to_string(&file).unwrap();
    assert!(!raw.contains("old-refresh"));
    assert_eq!(raw, format!(r#"{{"{}":{{"until":{},"failures":1}}}}"#, refresh_limit_key("old-refresh"), NOW + LIMIT_BASE_MS));
    let again = limited();
    let restarted = Arc::new(RefreshLimits::new(Some(file), Arc::new(|| NOW + 1000.0)));
    let d = RefreshDeps { now: Arc::new(|| NOW + 1000.0), limits: Some(restarted), ..deps(again.clone()) };
    assert_eq!(fx.refresh(&d).await, t("http-429", Some(LIMIT_BASE_MS as u64 - 1000)));
    assert_eq!(again.calls.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn does_not_call_a_login_dead_when_another_process_renewed_this_very_profile_meanwhile() {
    let fx = Fx::new();
    fx.write(&profile());
    let file = fx.dir.join(".credentials.json");
    let f = fake(move |_| {
        std::fs::write(
            &file,
            r#"{"claudeAiOauth":{"accessToken":"session-access","refreshToken":"session-refresh","expiresAt":1}}"#,
        )
        .unwrap();
        async { reply(400, json!({ "error": "invalid_grant" })) }.boxed()
    });
    assert_eq!(fx.refresh(&deps(f)).await, RefreshOutcome::Ok);
    assert_eq!(fx.read()["claudeAiOauth"]["refreshToken"], "session-refresh");
}

#[tokio::test]
async fn never_returns_or_leaves_tokens_in_temporary_files() {
    let fx = Fx::new();
    fx.write(&profile());
    let f = fake(|_| async { reply(200, json!({ "access_token": "secret-new", "expires_in": 60 })) }.boxed());
    let out = fx.refresh(&deps(f)).await;
    assert!(!format!("{out:?}").contains("secret-new"));
    assert!(fx.temps().is_empty());
}
