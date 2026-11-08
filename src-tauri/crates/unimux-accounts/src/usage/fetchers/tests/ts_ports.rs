//! Case-by-case ports of test/usage-fetchers.test.ts (the fixture of the parent module).

use super::*;

fn calls(f: &Fx) -> usize {
    f.fake.calls.load(Ordering::SeqCst)
}

fn auth_of(req: &Request) -> String {
    req.headers.iter().find(|(k, _)| k == "Authorization").map(|(_, v)| v.clone()).unwrap_or_default()
}

fn profile(token: &str, expires: f64, refresh: Option<&str>) -> Value {
    let mut oauth = json!({ "accessToken": token, "expiresAt": expires });
    if let Some(r) = refresh {
        oauth["refreshToken"] = json!(r);
    }
    json!({ "claudeAiOauth": oauth })
}

/// Counts the reads of the live credentials file and writes a fresh login right before the `nth` one.
fn fresh_login_on_read(f: &mut Fx, nth: usize, login: Value) -> Arc<AtomicUsize> {
    let reads = Arc::new(AtomicUsize::new(0));
    let (files, n) = (f.files.clone(), reads.clone());
    f.deps.credentials.read_file = Arc::new(move |p: &Path| {
        if p.ends_with(".credentials.json") && n.fetch_add(1, Ordering::SeqCst) + 1 == nth {
            files.lock().insert(PathBuf::from("/home/u/.claude/.credentials.json"), login.to_string());
        }
        files.lock().get(p).cloned()
    });
    reads
}

fn fresh() -> Value {
    json!({ "claudeAiOauth": { "accessToken": "fresh", "expiresAt": NOW + 3_600_000.0, "subscriptionType": "max", "rateLimitTier": "x_5x" } })
}

/// "is signed out without credentials", "reads the windows and plan, sending only the documented headers", "sends its own
/// User-Agent, never claude-code/ (investigation test 9)", "tags the main Claude account and reads its identity from
/// .claude.json", "marks the live card as active"
#[tokio::test]
async fn ts_the_live_claude_login_signed_out_or_read_with_the_documented_request() {
    let f = fx(|_, _| Ok(response(200, OK_BODY, &[])));
    let r = fetch_claude(&f.deps, &live()).await;
    assert_eq!((r.usage.provider, r.usage.status, r.usage.windows.len()), (Provider::Claude, Status::SignedOut, 0));
    assert_eq!(calls(&f), 0);
    f.live_login("tok", NOW + 3_600_000.0, None);
    let r = fetch_claude(&f.deps, &live()).await;
    assert_eq!(
        (r.usage.account_id.as_str(), r.usage.status, r.usage.plan.as_deref()),
        ("claude:main", Status::Ok, Some("Max 5x"))
    );
    assert_eq!((r.usage.source, r.usage.fetched_at, r.usage.managed, r.usage.active), (Source::Live, NOW, None, true));
    assert_eq!((r.usage.email.as_deref(), r.usage.org.as_deref()), (Some("a@x.io"), Some("Org")));
    let req = f.fake.requests.lock()[0].clone();
    assert_eq!(req.url.as_str(), "https://api.anthropic.com/api/oauth/usage");
    assert_eq!(req.method.as_str(), "GET");
    assert!(req.headers.iter().all(|(_, v)| !v.starts_with("claude-code/")));
}

/// "maps a 403 of the usage endpoint to forbidden, for the live login and saved accounts, without renewing (investigation
/// test 6)", "does not renew after a 403", "reports a rejected token after the renewal as expired with the status"
#[tokio::test]
async fn ts_a_403_is_forbidden_for_the_live_login_and_saved_accounts_without_renewing() {
    let mut f = fx(|_, _| Ok(response(403, "{}", &[])));
    f.renew_with(RefreshOutcome::Ok, None);
    f.live_login("tok", NOW + 3_600_000.0, None);
    let r = fetch_claude(&f.deps, &live()).await;
    assert_eq!((r.usage.status, r.usage.error.as_deref()), (Status::Forbidden, Some("http-403")));
    f.put("/p/r1/.credentials.json", profile("old", NOW + 3_600_000.0, Some("r")));
    let before = calls(&f);
    let r = fetch_claude(&f.deps, &saved(RenewRule::Allowed)).await;
    assert_eq!((r.usage.status, r.usage.error.as_deref()), (Status::Forbidden, Some("http-403")));
    assert_eq!((f.renewals.load(Ordering::SeqCst), calls(&f) - before), (0, 1));
}

/// "does not use an expired token and says so", "treats an expired main token with a refresh token as dormant: no request,
/// no refresh", "never renews the main account"
#[tokio::test]
async fn ts_an_expired_live_token_is_expired_or_dormant_and_never_renewed() {
    let mut f = fx(|_, _| Ok(response(401, "{}", &[])));
    f.renew_with(RefreshOutcome::Ok, Some("new"));
    f.live_login("tok", NOW - 1000.0, None);
    let r = fetch_claude(&f.deps, &live()).await;
    assert_eq!((r.usage.status, r.usage.plan.as_deref()), (Status::Expired, Some("Max 5x")));
    f.live_login("tok", NOW - 1000.0, Some("rt-secret"));
    let r = fetch_claude(&f.deps, &live()).await;
    assert_eq!((r.usage.status, r.usage.plan.as_deref(), r.usage.windows.len()), (Status::Dormant, Some("Max 5x"), 0));
    assert!(!r.usage.to_value().to_string().contains("rt-secret"));
    assert_eq!(calls(&f), 0);
    f.live_login("tok", NOW + 3_600_000.0, None);
    assert_eq!(fetch_claude(&f.deps, &live()).await.usage.status, Status::Expired);
    assert_eq!(f.renewals.load(Ordering::SeqCst), 0);
}

/// "re-reads once before calling an expired main token without refresh token expired", "re-reads a missing main credentials
/// file once before reporting signed out"
#[tokio::test]
async fn ts_the_live_login_is_read_once_more_before_it_is_called_expired_or_signed_out() {
    let mut f = fx(|_, _| Ok(response(200, OK_BODY, &[])));
    f.live_login("tok", NOW - 1000.0, None);
    fresh_login_on_read(&mut f, 2, fresh());
    assert_eq!(fetch_claude(&f.deps, &live()).await.usage.status, Status::Ok);
    assert_eq!(auth_of(&f.fake.requests.lock()[0]), "Bearer fresh");

    let mut f = fx(|_, _| Ok(response(200, OK_BODY, &[])));
    let reads = fresh_login_on_read(&mut f, 2, fresh());
    assert_eq!(fetch_claude(&f.deps, &live()).await.usage.status, Status::Ok);
    assert!(reads.load(Ordering::SeqCst) >= 2);
}

/// "re-reads after a 401 on the main login and only then reports expired"
#[tokio::test]
async fn ts_a_401_of_the_live_login_is_read_again_before_it_is_expired() {
    let f = fx(|_, n| Ok(if n == 0 { response(401, "{}", &[]) } else { response(200, OK_BODY, &[]) }));
    f.live_login("tok", NOW + 3_600_000.0, Some("rt"));
    assert_eq!(fetch_claude(&f.deps, &live()).await.usage.status, Status::Ok, "Claude Code renewed meanwhile");
    // The re-read shows an expired token with a refresh token: dormant, not expired.
    let mut f = fx(|_, _| Ok(response(401, "{}", &[])));
    f.live_login("tok", NOW + 3_600_000.0, Some("rt"));
    let renewable = json!({ "claudeAiOauth": { "accessToken": "tok", "refreshToken": "rt", "expiresAt": NOW - 5000.0 } });
    fresh_login_on_read(&mut f, 2, renewable);
    assert_eq!(fetch_claude(&f.deps, &live()).await.usage.status, Status::Dormant);
}

/// "maps rejected tokens, rate limiting and bad bodies", "classifies network failures and never leaks the token"
#[tokio::test]
async fn ts_rejected_tokens_rate_limits_bad_bodies_and_network_failures() {
    for body in [r#"{"nothing":true}"#, "<html>"] {
        let f = fx(move |_, _| Ok(response(200, body, &[])));
        f.live_login("tok", NOW + 3_600_000.0, None);
        assert_eq!(fetch_claude(&f.deps, &live()).await.usage.error.as_deref(), Some("bad-response"));
    }
    let f = fx(|_, _| Err(FetchError::Connect("connect failed for Bearer sk-ant-oat01-SECRET".into())));
    f.live_login("sk-ant-oat01-SECRET", NOW + 3_600_000.0, None);
    let r = fetch_claude(&f.deps, &live()).await;
    assert_eq!((r.usage.status, r.usage.error.as_deref()), (Status::Error, Some("network")));
    assert!(!r.usage.to_value().to_string().contains("SECRET"));
}

/// "is signed out without credentials and has no limits for API key logins", "tags the Codex account", "reports the real
/// failure when there is no session log to fall back on"
#[tokio::test]
async fn ts_codex_signed_out_api_key_and_failures_without_a_session_log() {
    let codex = AccountRef { id: "codex:main".into(), provider: "codex".into(), ..Default::default() };
    let f = fx(|_, _| Ok(response(401, "{}", &[])));
    let r = fetch_codex(&f.deps, &codex).await;
    assert_eq!((r.usage.account_id.as_str(), r.usage.status), ("codex:main", Status::SignedOut));
    f.put("/home/u/.codex/auth.json", json!({ "auth_mode": "apikey", "OPENAI_API_KEY": "sk-x", "tokens": null }));
    let r = fetch_codex(&f.deps, &codex).await;
    assert_eq!((r.usage.status, r.usage.windows.len()), (Status::ApiKey, 0));
    let access = jwt(json!({ "exp": (NOW / 1000.0) + 3600.0 }));
    f.put("/home/u/.codex/auth.json", json!({ "tokens": { "access_token": access, "account_id": "acc" } }));
    let r = fetch_codex(&f.deps, &codex).await;
    assert_eq!((r.usage.status, r.usage.windows.len()), (Status::Expired, 0));
    let f = fx(|_, _| Ok(response(429, "{}", &[("retry-after", "30")])));
    f.put("/home/u/.codex/auth.json", json!({ "tokens": { "access_token": access, "account_id": "acc" } }));
    let r = fetch_codex(&f.deps, &codex).await;
    assert_eq!((r.usage.status, r.usage.error.as_deref(), r.retry_after_ms), (Status::Error, Some("http-429"), Some(30_000.0)));
    let f = fx(|_, _| Err(FetchError::Connect("boom Bearer abc.def.ghi".into())));
    f.put("/home/u/.codex/auth.json", json!({ "tokens": { "access_token": access, "account_id": "acc" } }));
    assert!(!fetch_codex(&f.deps, &codex).await.usage.to_value().to_string().contains("abc.def.ghi"));
}

type Make = fn() -> Result<Response, FetchError>;

/// "falls back to the last session when the live request fails, is rejected or the token expired", "marks a log answer as
/// failed after a rejected request but not when no request was made"
#[tokio::test]
async fn ts_codex_falls_back_to_the_session_log_and_marks_a_failed_request() {
    let codex = AccountRef { id: "codex:main".into(), provider: "codex".into(), ..Default::default() };
    let tmp = tempfile::tempdir().unwrap();
    let day = tmp.path().join("sessions").join("2026").join("10").join("09");
    std::fs::create_dir_all(&day).unwrap();
    let event = r#"{"timestamp":"2026-10-09T10:00:00Z","type":"event_msg","payload":{"type":"token_count","rate_limits":{"primary":{"used_percent":31,"window_minutes":300,"resets_at":1781010642},"secondary":{"used_percent":3,"window_minutes":10080,"resets_at":1781558816},"plan_type":"plus"}}}"#;
    std::fs::write(day.join("rollout-a.jsonl"), format!("{event}\n")).unwrap();
    let at = crate::usage::parse::parse_iso_date("2026-10-09T10:00:00Z");
    let valid = jwt(json!({ "exp": (NOW / 1000.0) + 3600.0 }));
    let id = jwt(json!({ "email": "me@example.com", "https://api.openai.com/auth": { "chatgpt_plan_type": "plus" } }));
    let answers: [(Make, Status, bool); 6] = [
        (|| Err(FetchError::Connect("offline".into())), Status::Ok, true),
        (|| Ok(response(401, "{}", &[])), Status::Expired, false),
        (|| Ok(response(403, "{}", &[])), Status::Expired, false),
        (|| Ok(response(500, "{}", &[])), Status::Ok, true),
        (|| Ok(response(200, r#"{"nothing":1}"#, &[])), Status::Ok, true),
        (|| Ok(response(429, "{}", &[("retry-after", "90")])), Status::Ok, true),
    ];
    for (answer, status, failed) in answers {
        let mut f = fx(move |_, _| answer());
        let home = tmp.path().to_path_buf();
        f.deps.codex_home = Arc::new(move || home.clone());
        f.put("/home/u/.codex/auth.json", json!({ "tokens": { "access_token": valid, "id_token": id, "account_id": "acc-1" } }));
        let r = fetch_codex(&f.deps, &codex).await;
        assert_eq!((r.usage.status, r.usage.source, r.usage.email.as_deref()), (status, Source::Log, Some("me@example.com")));
        assert_eq!((r.usage.windows[0].used_percent, r.usage.fetched_at, r.failed), (31.0, at, failed));
        assert!(r.retry_after_ms.is_none_or(|ms| ms == 90_000.0));
    }
    // An expired token: the log, no request, not failed.
    let mut f = fx(|_, _| Ok(response(200, "{}", &[])));
    let home = tmp.path().to_path_buf();
    f.deps.codex_home = Arc::new(move || home.clone());
    let expired = jwt(json!({ "exp": (NOW / 1000.0) - 10.0 }));
    f.put("/home/u/.codex/auth.json", json!({ "tokens": { "access_token": expired, "id_token": id, "account_id": "acc-1" } }));
    let r = fetch_codex(&f.deps, &codex).await;
    assert_eq!(
        (r.usage.status, r.usage.source, r.usage.windows[0].used_percent, r.failed),
        (Status::Expired, Source::Log, 31.0, false)
    );
    assert_eq!(calls(&f), 0);
}

/// "reads credentials and identity of a managed profile only", "does not fall back to the main login for a signed-out
/// profile"
#[tokio::test]
async fn ts_a_managed_profile_uses_only_its_own_credentials_and_identity() {
    let f = fx(|_, _| Ok(response(200, OK_BODY, &[])));
    f.live_login("main-secret", NOW + 3_600_000.0, None);
    let r = fetch_claude(&f.deps, &saved(RenewRule::Allowed)).await;
    assert_eq!((r.usage.account_id.as_str(), r.usage.status, r.usage.managed), ("claude:r1", Status::SignedOut, Some(true)));
    assert_eq!(calls(&f), 0);
    f.put("/p/r1/.credentials.json", profile("tok-profile", NOW + 3_600_000.0, None));
    f.put("/p/r1/.claude.json", json!({ "oauthAccount": { "emailAddress": "work@example.com", "organizationName": "Work" } }));
    let r = fetch_claude(&f.deps, &saved(RenewRule::Allowed)).await;
    assert_eq!(auth_of(&f.fake.requests.lock()[0]), "Bearer tok-profile");
    assert!(f.fake.requests.lock().iter().all(|q| !auth_of(q).contains("main-secret")));
    let u = r.usage;
    assert_eq!(
        (u.status, u.email.as_deref(), u.org.as_deref(), u.managed),
        (Status::Ok, Some("work@example.com"), Some("Work"), Some(true))
    );
}

/// "renews an expired token first and requests the usage with the new one", "reports expired for a dead login and error for
/// a transient failure without requesting usage", "gives expired after a second 401", "names the refresh failure and passes
/// on the token endpoint Retry-After"
#[tokio::test]
async fn ts_a_managed_profile_is_renewed_once_and_names_the_renewal_failure() {
    let mut f = fx(|_, _| Ok(response(200, OK_BODY, &[])));
    f.renew_with(RefreshOutcome::Ok, Some("new-tok"));
    f.put("/p/r1/.credentials.json", profile("old-tok", NOW - 1000.0, Some("r")));
    let r = fetch_claude(&f.deps, &saved(RenewRule::Allowed)).await;
    assert_eq!((r.usage.status, f.renewals.load(Ordering::SeqCst), calls(&f)), (Status::Ok, 1, 1));
    assert_eq!(auth_of(&f.fake.requests.lock()[0]), "Bearer new-tok");

    let mut f = fx(|_, _| Ok(response(200, OK_BODY, &[])));
    f.put("/p/r1/.credentials.json", profile("old-tok", NOW - 1000.0, Some("r")));
    let transient = |reason: &str, retry: Option<u64>| {
        RefreshOutcome::Transient(Some(TransientDetail { reason: reason.into(), retry_after_ms: retry }))
    };
    for (outcome, status, error) in [
        (RefreshOutcome::Dead, Status::Expired, "refresh-dead"),
        (RefreshOutcome::Unusable, Status::Expired, "refresh-unusable"),
        (transient("network", None), Status::Error, "refresh-network"),
        (transient("blocked", None), Status::Error, "refresh-blocked"),
    ] {
        f.renew_with(outcome, None);
        let r = fetch_claude(&f.deps, &saved(RenewRule::Allowed)).await;
        assert_eq!((r.usage.status, r.usage.error.as_deref()), (status, Some(error)));
    }
    f.renew_with(transient("http-429", Some(600_000)), None);
    assert_eq!(fetch_claude(&f.deps, &saved(RenewRule::Allowed)).await.retry_after_ms, Some(600_000.0));
    assert_eq!(calls(&f), 0);

    // Always 401: one renewal, two requests, expired.
    let mut f = fx(|_, _| Ok(response(401, "{}", &[])));
    f.renew_with(RefreshOutcome::Ok, None);
    f.put("/p/r1/.credentials.json", profile("old-tok", NOW + 3_600_000.0, Some("r")));
    let r = fetch_claude(&f.deps, &saved(RenewRule::Allowed)).await;
    assert_eq!((r.usage.status, f.renewals.load(Ordering::SeqCst), calls(&f)), (Status::Expired, 1, 2));
}

/// "reads an account whose weekly limit is exhausted (100 percent, null resets, extra fields) as ok", "keeps the HTTP status,
/// honours Retry-After (also as a date) and tells an empty answer apart from a broken one"
#[tokio::test]
async fn ts_a_saved_account_exhausted_limits_http_statuses_and_retry_after_dates() {
    let body = r#"{"five_hour":{"utilization":0,"resets_at":null},"seven_day":{"utilization":100,"resets_at":"2026-10-15T21:59:59+00:00"},"seven_day_opus":null,"extra_usage":{"is_enabled":false,"utilization":null}}"#;
    let f = fx(move |_, _| Ok(response(200, body, &[])));
    f.put("/p/r1/.credentials.json", profile("prof-tok", NOW + 3_600_000.0, Some("prof-refresh")));
    let r = fetch_claude(&f.deps, &saved(RenewRule::Allowed)).await;
    assert_eq!((r.usage.status, r.usage.managed, r.usage.error.as_deref()), (Status::Ok, Some(true), None));
    let w: Vec<_> = r.usage.windows.iter().map(|w| (w.id, w.used_percent)).collect();
    assert_eq!(w, [(WindowId::FiveHour, 0.0), (WindowId::SevenDay, 100.0)]);
    type Case = (u16, &'static str, Option<&'static str>, &'static str, Option<f64>);
    let cases: [Case; 5] = [
        (429, "{}", Some("300"), "http-429", Some(300_000.0)),
        (429, "{}", Some("Sun, 11 Oct 2026 12:00:45 GMT"), "http-429", Some(45_000.0)),
        (503, "{}", None, "http-503", None),
        (200, r#"{"five_hour":null,"seven_day":null}"#, None, "no-windows", None),
        (200, r#"{"nothing":1}"#, None, "bad-response", None),
    ];
    for (status, body, retry, error, retry_ms) in cases {
        let f = fx(move |_, _| {
            let headers: Vec<(&str, &str)> = retry.map(|r| ("retry-after", r)).into_iter().collect();
            Ok(response(status, body, &headers))
        });
        f.put("/p/r1/.credentials.json", profile("prof-tok", NOW + 3_600_000.0, Some("prof-refresh")));
        let r = fetch_claude(&f.deps, &saved(RenewRule::Allowed)).await;
        assert_eq!((r.usage.status, r.usage.error.as_deref(), r.retry_after_ms), (Status::Error, Some(error), retry_ms));
    }
}

/// "is never renewed: no token request, status elsewhere when its token ran out (investigation test 5)", "still reads its
/// limits with a valid access token and turns a 401 into elsewhere without renewing"
#[tokio::test]
async fn ts_a_saved_account_held_elsewhere_is_never_renewed() {
    let mut f = fx(|_, _| Ok(response(200, OK_BODY, &[])));
    f.renew_with(RefreshOutcome::Ok, Some("new"));
    f.put("/p/r1/.credentials.json", profile("prof-tok", NOW - 1000.0, Some("prof-refresh")));
    for (renew, held) in [
        (RenewRule::HeldByLive, HeldBy::Live),
        (RenewRule::HeldByCswap, HeldBy::Cswap),
        (RenewRule::SwitchedOut, HeldBy::SwitchedOut),
    ] {
        let r = fetch_claude(&f.deps, &saved(renew)).await;
        assert_eq!((r.usage.status, r.usage.managed, r.usage.held_by), (Status::Elsewhere, Some(true), Some(held)));
    }
    assert_eq!((f.renewals.load(Ordering::SeqCst), calls(&f)), (0, 0));
    f.put("/p/r1/.credentials.json", profile("prof-tok", NOW + 3_600_000.0, Some("prof-refresh")));
    assert_eq!(fetch_claude(&f.deps, &saved(RenewRule::HeldByCswap)).await.usage.status, Status::Ok);
    let mut f = fx(|_, _| Ok(response(401, "{}", &[])));
    f.renew_with(RefreshOutcome::Ok, Some("new"));
    f.put("/p/r1/.credentials.json", profile("prof-tok", NOW + 3_600_000.0, Some("prof-refresh")));
    assert_eq!(fetch_claude(&f.deps, &saved(RenewRule::HeldByCswap)).await.usage.status, Status::Elsewhere);
    assert_eq!(f.renewals.load(Ordering::SeqCst), 0);
}
