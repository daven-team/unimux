//! B3 acceptance: what goes on the wire, redirect rules, caps, timeouts, cancellation, the direct-then-proxy route and proxies.
//! The token-transport cases are ported from test/token-transport.test.ts, the request cases of test/usage-fetchers.test.ts
//! and the redirect cases of test/mac-update-net.test.ts.

mod common;

use std::sync::Arc;
use std::time::{Duration, Instant};

use common::*;
use unimux_net::calls;
use unimux_net::proxy::{FixedProxy, NoProxy, ProxyChoice, ProxyScheme, ProxyServer};
use unimux_net::{CancellationToken, FetchError, HttpClient, Method, Redirect, Request, Route};

fn client() -> HttpClient {
    HttpClient::builder().proxy_resolver(Arc::new(NoProxy)).build().unwrap()
}

fn via(proxies: Vec<ProxyChoice>) -> HttpClient {
    HttpClient::builder().proxy_resolver(Arc::new(FixedProxy(proxies))).build().unwrap()
}

fn http_proxy_at(addr: std::net::SocketAddr) -> ProxyChoice {
    ProxyChoice::Proxy(ProxyServer { scheme: ProxyScheme::Http, host: addr.ip().to_string(), port: addr.port() })
}

fn ok_json() -> Answer {
    answer(|_| json(200, "{}"))
}

// ---- token-transport.test.ts: directFetch -------------------------------------------------------------------------------

#[tokio::test]
async fn token_renewal_puts_exactly_the_given_headers_on_the_wire() {
    let server = http_server(ok_json()).await;
    let req = calls::token_renewal(&server.url("/v1/oauth/token"), "old-refresh", "unimux/0.6.8").unwrap();
    let response = client().fetch(req).await.unwrap();
    assert_eq!(response.status, 200);
    let seen = server.seen();
    assert_eq!(seen.len(), 1);
    let request = &seen[0];
    assert_eq!(request.method, "POST");
    assert_eq!(request.target, "/v1/oauth/token");
    assert_eq!(request.version, "HTTP/1.1");
    assert_eq!(request.names_sorted(), ["connection", "content-length", "content-type", "host", "user-agent"]);
    // The caller's headers in order, then Content-Length, Connection and Host: the order Node's http.request put on the wire
    // in 1.1.4 (rawHeaders there: content-type, user-agent, content-length, connection, Host; only Host's case differs).
    let names: Vec<&str> = request.headers.iter().map(|(n, _)| n.as_str()).collect();
    assert_eq!(names, ["content-type", "user-agent", "content-length", "connection", "host"]);
    assert_eq!(request.header("user-agent"), Some("unimux/0.6.8"));
    assert_eq!(request.header("content-type"), Some("application/json"));
    assert_eq!(request.header("connection"), Some("close"));
    assert_eq!(request.header("host"), Some(server.addr.to_string().as_str()));
    let body: serde_json::Value = serde_json::from_slice(&request.body).unwrap();
    assert_eq!(
        body,
        serde_json::json!({ "grant_type": "refresh_token", "refresh_token": "old-refresh", "client_id": calls::OAUTH_CLIENT_ID })
    );
    assert_eq!(request.header("content-length"), Some(request.body.len().to_string().as_str()));
}

#[tokio::test]
async fn the_default_product_user_agent_is_plain_unimux() {
    let server = http_server(ok_json()).await;
    client().fetch(calls::token_renewal(&server.url("/t"), "r", calls::REFRESH_USER_AGENT).unwrap()).await.unwrap();
    assert_eq!(server.seen()[0].header("user-agent"), Some("unimux"));
    assert_eq!(calls::product_user_agent("1.2.0"), "unimux/1.2.0");
}

#[tokio::test]
async fn any_answer_comes_back_with_status_headers_and_body_including_429() {
    let server = http_server(answer(|_| {
        reply(429, &[("content-type", "application/json"), ("retry-after", "90")], br#"{"error":"rate_limit_error"}"#)
    }))
    .await;
    let response = client().fetch(Request::post(&server.url("/x")).unwrap().body("{}")).await.unwrap();
    assert_eq!(response.status, 429);
    assert!(!response.ok());
    assert_eq!(response.header("retry-after").as_deref(), Some("90"));
    assert_eq!(response.json().unwrap(), serde_json::json!({ "error": "rate_limit_error" }));
}

#[tokio::test]
async fn redirects_are_refused_when_asked_to() {
    let server = http_server(answer(|_| reply(302, &[("location", "http://127.0.0.1:1/steal")], b""))).await;
    let req = calls::token_renewal(&server.url("/x"), "r", "unimux").unwrap();
    let error = client().fetch(req).await.unwrap_err();
    assert!(matches!(error, FetchError::RedirectRefused { status: 302, .. }), "{error:?}");
    assert!(error.to_string().contains("redirect"));
    assert_eq!(server.seen().len(), 1);
}

#[tokio::test]
async fn an_abort_is_not_a_connection_failure() {
    let server = http_server(answer(|_| Reply::Hang)).await;
    let token = CancellationToken::new();
    let req = Request::post(&server.url("/x")).unwrap().body("{}").cancel(token.clone());
    let c = client();
    let pending = tokio::spawn(async move { c.fetch(req).await });
    let started = Instant::now();
    while server.seen().is_empty() {
        assert!(started.elapsed() < Duration::from_secs(5));
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    token.cancel();
    let error = pending.await.unwrap().unwrap_err();
    assert!(matches!(error, FetchError::Aborted), "{error:?}");
    assert!(!error.is_connect_failure());
    assert_eq!(error.kind(), "timeout");
}

#[tokio::test]
async fn a_refused_connection_is_a_connect_failure_and_a_drop_after_connecting_is_not() {
    let port = closed_port().await;
    let error = client().fetch(Request::post(&format!("http://127.0.0.1:{port}/x")).unwrap().body("{}")).await.unwrap_err();
    assert!(error.is_connect_failure(), "{error:?}");
    let server = http_server(answer(|_| Reply::Drop)).await;
    let error = client().fetch(Request::post(&server.url("/x")).unwrap().body("{}")).await.unwrap_err();
    assert!(!error.is_connect_failure(), "{error:?}");
    assert_eq!(error.kind(), "network");
}

// ---- token-transport.test.ts: createTokenFetch (direct, then the system proxy only when nothing could be sent) -----------

#[tokio::test]
async fn direct_then_proxy_falls_back_only_when_nothing_could_be_sent() {
    let proxy = http_proxy(None, ok_json()).await;
    let c = via(vec![http_proxy_at(proxy.addr)]);
    // A name that does not resolve: the direct path never connects, the proxy path carries the request.
    let req = calls::token_renewal("http://token.unimux-b3.invalid/v1/oauth/token", "r", "unimux/1").unwrap();
    assert_eq!(c.fetch(req).await.unwrap().status, 200);
    let seen = proxy.seen();
    assert_eq!(seen.len(), 1);
    assert_eq!(seen[0].target, "http://token.unimux-b3.invalid/v1/oauth/token");
    assert_eq!(seen[0].names_sorted(), ["connection", "content-length", "content-type", "host", "user-agent"]);

    // The server was reached and dropped the connection: no second attempt through the proxy.
    let dropping = http_server(answer(|_| Reply::Drop)).await;
    let req = calls::token_renewal(&dropping.url("/t"), "r", "unimux/1").unwrap();
    assert!(!c.fetch(req).await.unwrap_err().is_connect_failure());
    assert_eq!(proxy.seen().len(), 1);

    // Aborted before the start: no fallback either.
    let token = CancellationToken::new();
    token.cancel();
    let req = calls::token_renewal("http://token.unimux-b3.invalid/t", "r", "unimux/1").unwrap().cancel(token);
    assert!(matches!(c.fetch(req).await.unwrap_err(), FetchError::Aborted));
    assert_eq!(proxy.seen().len(), 1);
}

#[tokio::test]
async fn a_plain_direct_route_never_uses_the_proxy() {
    let proxy = http_proxy(None, ok_json()).await;
    let c = via(vec![http_proxy_at(proxy.addr)]);
    let error = c.fetch(Request::get("http://token.unimux-b3.invalid/").unwrap().route(Route::Direct)).await.unwrap_err();
    assert!(error.is_connect_failure());
    assert!(proxy.seen().is_empty());
}

// ---- body cap and timeout ------------------------------------------------------------------------------------------------

#[tokio::test]
async fn the_token_answer_is_capped_at_1_mb() {
    let exact = http_server(answer(|_| reply(200, &[], &vec![b'a'; 1_000_000]))).await;
    let response = client().fetch(calls::token_renewal(&exact.url("/t"), "r", "u").unwrap()).await.unwrap();
    assert_eq!(response.body.len(), 1_000_000);
    let over = http_server(answer(|_| reply(200, &[], &vec![b'a'; 1_000_001]))).await;
    let error = client().fetch(calls::token_renewal(&over.url("/t"), "r", "u").unwrap()).await.unwrap_err();
    assert!(matches!(error, FetchError::TooLarge), "{error:?}");
    assert_eq!(error.to_string(), "response too large");
    // Without a Content-Length (chunked) the cap still holds while reading.
    let chunked = http_server(answer(|_| {
        Reply::Chunked(
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n".to_vec(),
            vec![vec![b'b'; 600_000], vec![b'c'; 600_000]],
        )
    }))
    .await;
    let error = client().fetch(calls::token_renewal(&chunked.url("/t"), "r", "u").unwrap()).await.unwrap_err();
    assert!(matches!(error, FetchError::TooLarge), "{error:?}");
}

#[tokio::test]
async fn a_slow_answer_times_out() {
    let server =
        http_server(answer(|_| Reply::Later(Duration::from_secs(3), b"HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n".to_vec())))
            .await;
    let started = Instant::now();
    let error = client().fetch(Request::get(&server.url("/")).unwrap().timeout(Duration::from_millis(300))).await.unwrap_err();
    assert!(matches!(error, FetchError::Timeout), "{error:?}");
    assert_eq!(error.kind(), "timeout");
    assert!(started.elapsed() < Duration::from_secs(2));
}

// ---- usage-fetchers.test.ts: the requests ------------------------------------------------------------------------------

#[tokio::test]
async fn claude_usage_sends_only_the_documented_headers() {
    let server = http_server(ok_json()).await;
    let req = calls::claude_usage(&server.url("/api/oauth/usage"), "sk-ant-oat01-secret", "unimux").unwrap();
    client().fetch(req).await.unwrap();
    let seen = &server.seen()[0];
    assert_eq!(seen.method, "GET");
    assert_eq!(seen.target, "/api/oauth/usage");
    assert_eq!(seen.names_sorted(), ["accept", "anthropic-beta", "authorization", "host", "user-agent"]);
    assert_eq!(seen.header("authorization"), Some("Bearer sk-ant-oat01-secret"));
    assert_eq!(seen.header("anthropic-beta"), Some("oauth-2025-04-20"));
    assert_eq!(seen.header("user-agent"), Some("unimux"));
    assert_eq!(seen.header("accept"), Some("application/json"));
}

#[tokio::test]
async fn claude_usage_sends_its_own_user_agent_never_claude_code() {
    let server = http_server(ok_json()).await;
    client().fetch(calls::claude_usage(&server.url("/u"), "t", "unimux/0.9.1").unwrap()).await.unwrap();
    assert_eq!(server.seen()[0].header("user-agent"), Some("unimux/0.9.1"));
}

#[tokio::test]
async fn codex_usage_sends_the_account_header() {
    let server = http_server(ok_json()).await;
    client().fetch(calls::codex_usage(&server.url("/backend-api/wham/usage"), "tok", Some("acc-1")).unwrap()).await.unwrap();
    client().fetch(calls::codex_usage(&server.url("/backend-api/wham/usage"), "tok", None).unwrap()).await.unwrap();
    let seen = server.seen();
    assert_eq!(seen[0].names_sorted(), ["accept", "authorization", "chatgpt-account-id", "host"]);
    assert_eq!(seen[0].header("chatgpt-account-id"), Some("acc-1"));
    assert!(seen[0].header("authorization").unwrap().starts_with("Bearer "));
    assert_eq!(seen[1].names_sorted(), ["accept", "authorization", "host"]);
}

#[tokio::test]
async fn usage_answers_map_like_1_1_4_and_the_token_never_follows_a_redirect() {
    // 401 / 403 / 429 + Retry-After / 500 come back as answers; the fetchers map them.
    for (status, retry) in [(401, None), (403, None), (429, Some("120")), (500, None)] {
        let server = http_server(answer(move |_| match retry {
            Some(r) => reply(status, &[("retry-after", r)], b"{}"),
            None => reply(status, &[], b"{}"),
        }))
        .await;
        let response = client().fetch(calls::claude_usage(&server.url("/u"), "t", "unimux").unwrap()).await.unwrap();
        assert_eq!(response.status, status);
        assert_eq!(response.header("retry-after").as_deref(), retry);
    }
    // A body that is not JSON is the caller's `bad-response`.
    let html = http_server(answer(|_| reply(200, &[], b"<html>"))).await;
    assert!(client().fetch(calls::claude_usage(&html.url("/u"), "t", "unimux").unwrap()).await.unwrap().json().is_err());
    // A redirect is refused (index.ts `redirect: 'error'`), so the bearer token is sent to one address only.
    let target = http_server(ok_json()).await;
    let location = target.url("/elsewhere");
    let moved = http_server(answer(move |_| reply(301, &[("location", &location)], b""))).await;
    let error = client().fetch(calls::codex_usage(&moved.url("/u"), "t", Some("a")).unwrap()).await.unwrap_err();
    assert!(matches!(error, FetchError::RedirectRefused { status: 301, .. }));
    assert_eq!(error.kind(), "network");
    assert!(target.seen().is_empty());
}

#[tokio::test]
async fn errors_never_carry_the_token() {
    let port = closed_port().await;
    let error = client()
        .fetch(calls::claude_usage(&format!("http://127.0.0.1:{port}/u"), "SECRET-TOKEN", "unimux").unwrap())
        .await
        .unwrap_err();
    assert!(!format!("{error} {error:?}").contains("SECRET-TOKEN"));
    let req = calls::claude_usage("http://127.0.0.1:1/u", "SECRET-TOKEN", "unimux").unwrap();
    assert!(!format!("{req:?}").contains("SECRET-TOKEN"));
}

// ---- other call sites ------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn changelog_github_and_update_feed_header_sets() {
    let server = http_server(ok_json()).await;
    client().fetch(calls::changelog(&server.url("/repos/daven-team/unimux/releases")).unwrap()).await.unwrap();
    client()
        .fetch(calls::github_api(Method::POST, &server.url("/user/repos"), "gho_x", Some(r#"{"name":"a"}"#.into())).unwrap())
        .await
        .unwrap();
    client()
        .fetch(calls::github_form(&server.url("/login/device/code"), &[("client_id", "c"), ("scope", "repo")]).unwrap())
        .await
        .unwrap();
    let origin = format!("http://{}", server.addr);
    client()
        .fetch(calls::update_request(&server.url("/latest.json"), vec![origin], Some(calls::UPDATE_FEED_TIMEOUT)).unwrap())
        .await
        .unwrap();
    let seen = server.seen();
    assert_eq!(seen[0].names_sorted(), ["accept", "host", "user-agent"]);
    assert_eq!(seen[0].header("accept"), Some("application/vnd.github+json"));
    assert_eq!(
        seen[1].names_sorted(),
        ["accept", "authorization", "content-length", "content-type", "host", "user-agent", "x-github-api-version"]
    );
    assert_eq!(seen[1].header("x-github-api-version"), Some("2022-11-28"));
    assert_eq!(seen[1].body, br#"{"name":"a"}"#);
    assert_eq!(seen[2].names_sorted(), ["accept", "content-length", "content-type", "host", "user-agent"]);
    assert_eq!(seen[2].body, b"client_id=c&scope=repo");
    assert_eq!(seen[3].names_sorted(), ["cache-control", "host", "pragma", "user-agent"]);
    assert_eq!(seen[3].header("user-agent"), Some("unimux-updater"));
    // No library additions anywhere: no Accept-Encoding, no default Accept.
    for s in &seen {
        assert!(s.header("accept-encoding").is_none());
    }
    assert!(seen[3].header("accept").is_none());
}

// ---- mac-update-net.test.ts: redirects with an address check per hop ---------------------------------------------------

#[tokio::test]
async fn redirects_follow_up_to_the_limit_with_a_check_per_hop() {
    let server = http_server(answer(|seen| {
        let n: u32 = seen.target.trim_start_matches("/hop").parse().unwrap_or(0);
        if seen.target == "/final" { reply(200, &[], b"ok") } else { reply(302, &[("location", &format!("/hop{}", n + 1))], b"") }
    }))
    .await;
    let origin = format!("http://{}", server.addr);
    // /hop0 -> /hop1 ... each hop is one redirect; 6 redirects are refused, 5 are fine.
    let five = http_server(answer(|seen| {
        let n: u32 = seen.target.trim_start_matches("/hop").parse().unwrap_or(0);
        if n >= 5 { reply(200, &[], b"ok") } else { reply(302, &[("location", &format!("/hop{}", n + 1))], b"") }
    }))
    .await;
    let five_origin = format!("http://{}", five.addr);
    let response = client().fetch(calls::update_request(&five.url("/hop0"), vec![five_origin], None).unwrap()).await.unwrap();
    assert_eq!(response.status, 200);
    assert!(response.redirected);
    assert_eq!(response.url.path(), "/hop5");
    let error =
        client().fetch(calls::update_request(&server.url("/hop0"), vec![origin.clone()], None).unwrap()).await.unwrap_err();
    assert!(matches!(error, FetchError::TooManyRedirects), "{error:?}");
    assert_eq!(server.seen().len(), 6);

    // A hop to an address the check refuses is not followed.
    let other = http_server(ok_json()).await;
    let elsewhere = other.url("/x");
    let to_other = http_server(answer(move |_| reply(302, &[("location", &elsewhere)], b""))).await;
    let error = client()
        .fetch(calls::update_request(&to_other.url("/start"), vec![format!("http://{}", to_other.addr)], None).unwrap())
        .await
        .unwrap_err();
    assert!(matches!(error, FetchError::RedirectNotAllowed(_)), "{error:?}");
    assert!(error.to_string().contains("not allowed"));
    assert!(other.seen().is_empty());

    // The first address is checked too, before anything is sent.
    let error = client().fetch(calls::update_request("https://example.com/a", vec![], None).unwrap()).await.unwrap_err();
    assert!(matches!(error, FetchError::AddressNotAllowed(_)));
    let error = client().fetch(calls::update_request("http://github.com/a", vec![], None).unwrap()).await.unwrap_err();
    assert!(matches!(error, FetchError::AddressNotAllowed(_)));
}

#[tokio::test]
async fn a_302_without_location_and_null_body_statuses_come_back_as_answers() {
    let server = http_server(answer(|seen| match seen.target.as_str() {
        "/302" => reply(302, &[], b""),
        _ => Reply::Bytes(b"HTTP/1.1 304 Not Modified\r\n\r\n".to_vec()),
    }))
    .await;
    let origin = format!("http://{}", server.addr);
    let response = client().fetch(calls::update_request(&server.url("/302"), vec![origin.clone()], None).unwrap()).await.unwrap();
    assert_eq!(response.status, 302);
    assert!(response.header("location").is_none());
    assert_eq!(
        client().fetch(calls::update_request(&server.url("/304"), vec![origin], None).unwrap()).await.unwrap().status,
        304
    );
}

#[tokio::test]
async fn redirect_method_and_credential_rules_follow_fetch() {
    let target = http_server(ok_json()).await;
    let cross = target.url("/landed");
    let source = http_server(answer(move |seen| match seen.target.as_str() {
        "/303" => reply(303, &[("location", "/same")], b""),
        "/307" => reply(307, &[("location", "/same")], b""),
        "/cross" => reply(302, &[("location", &cross)], b""),
        _ => json(200, "{}"),
    }))
    .await;
    let post = |path: &str| {
        Request::post(&source.url(path))
            .unwrap()
            .header("Content-Type", "application/json")
            .header("Authorization", "Bearer x")
            .body("{\"a\":1}")
    };
    client().fetch(post("/303")).await.unwrap();
    client().fetch(post("/307")).await.unwrap();
    let seen = source.seen();
    // 303: GET without the body and its headers; same origin keeps Authorization.
    assert_eq!((seen[1].method.as_str(), seen[1].target.as_str()), ("GET", "/same"));
    assert!(seen[1].body.is_empty());
    assert!(seen[1].header("content-type").is_none() && seen[1].header("content-length").is_none());
    assert_eq!(seen[1].header("authorization"), Some("Bearer x"));
    // 307: the method and the body stay.
    assert_eq!((seen[3].method.as_str(), seen[3].body.as_slice()), ("POST", &b"{\"a\":1}"[..]));
    // Another origin never gets the credentials.
    client()
        .fetch(Request::get(&source.url("/cross")).unwrap().header("Authorization", "Bearer x").header("X-Keep", "1"))
        .await
        .unwrap();
    let landed = &target.seen()[0];
    assert!(landed.header("authorization").is_none());
    assert_eq!(landed.header("x-keep"), Some("1"));
    // Manual hands any 3xx back.
    let manual = client().fetch(Request::get(&source.url("/cross")).unwrap().redirect(Redirect::Manual)).await.unwrap();
    assert_eq!(manual.status, 302);
    assert_eq!(target.seen().len(), 1);
}

// ---- streaming (downloads) -----------------------------------------------------------------------------------------------

#[tokio::test]
async fn a_stream_reads_in_pieces_and_can_be_cancelled() {
    let server = http_server(answer(|_| {
        Reply::Chunked(
            b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n".to_vec(),
            (0..20).map(|i| vec![i as u8; 1000]).collect(),
        )
    }))
    .await;
    let mut response = client().fetch_stream(Request::get(&server.url("/zip")).unwrap()).await.unwrap();
    let mut total = 0;
    while let Some(chunk) = response.body.chunk().await.unwrap() {
        total += chunk.len();
    }
    assert_eq!(total, 20_000);
    let hang = http_server(answer(|_| Reply::Bytes(b"HTTP/1.1 200 OK\r\ncontent-length: 100000\r\n\r\npartial".to_vec()))).await;
    let token = CancellationToken::new();
    let mut response = client().fetch_stream(Request::get(&hang.url("/zip")).unwrap().cancel(token.clone())).await.unwrap();
    assert_eq!(response.content_length(), Some(100_000));
    let _ = response.body.chunk().await;
    token.cancel();
    let mut last = Ok(None);
    for _ in 0..3 {
        last = response.body.chunk().await;
        if last.is_err() {
            break;
        }
    }
    assert!(last.is_err(), "a cancelled or cut-short body is an error");
}

// ---- proxies -------------------------------------------------------------------------------------------------------------

#[tokio::test]
async fn an_http_url_goes_to_an_http_proxy_in_absolute_form() {
    let proxy = http_proxy(None, ok_json()).await;
    let c = via(vec![http_proxy_at(proxy.addr)]);
    c.fetch(calls::changelog("http://api.unimux-b3.test/repos/x/releases?per_page=5").unwrap()).await.unwrap();
    let seen = &proxy.seen()[0];
    assert_eq!(seen.target, "http://api.unimux-b3.test/repos/x/releases?per_page=5");
    assert_eq!(seen.header("host"), Some("api.unimux-b3.test"));
    assert_eq!(seen.names_sorted(), ["accept", "host", "user-agent"]);
}

#[tokio::test]
async fn local_addresses_never_use_the_proxy() {
    let proxy = http_proxy(None, ok_json()).await;
    let server = http_server(ok_json()).await;
    via(vec![http_proxy_at(proxy.addr)]).fetch(Request::get(&server.url("/")).unwrap()).await.unwrap();
    assert_eq!(server.seen().len(), 1);
    assert!(proxy.seen().is_empty());
}

#[tokio::test]
async fn an_unreachable_proxy_falls_through_to_the_next_entry() {
    let dead = closed_port().await;
    let proxy = http_proxy(None, ok_json()).await;
    let list = vec![
        ProxyChoice::Proxy(ProxyServer { scheme: ProxyScheme::Http, host: "127.0.0.1".into(), port: dead }),
        http_proxy_at(proxy.addr),
    ];
    assert_eq!(via(list).fetch(Request::get("http://x.unimux-b3.test/").unwrap()).await.unwrap().status, 200);
    assert_eq!(proxy.seen().len(), 1);
    // Only dead proxies: a connect failure (nothing was sent).
    let only_dead =
        via(vec![ProxyChoice::Proxy(ProxyServer { scheme: ProxyScheme::Http, host: "127.0.0.1".into(), port: dead })]);
    assert!(only_dead.fetch(Request::get("http://x.unimux-b3.test/").unwrap()).await.unwrap_err().is_connect_failure());
}

#[tokio::test]
async fn https_through_a_connect_tunnel_with_the_system_verifier_and_an_extra_root() {
    let ca = test_ca(&["tls.unimux-b3.test", "localhost"]);
    let server = https_server(&ca, ok_json()).await;
    let proxy = http_proxy(Some(server.addr), ok_json()).await;
    let c = HttpClient::builder()
        .proxy_resolver(Arc::new(FixedProxy(vec![http_proxy_at(proxy.addr)])))
        .extra_root(ca.ca_der.clone())
        .build()
        .unwrap();
    let req =
        calls::token_renewal("https://tls.unimux-b3.test/v1/oauth/token", "r", "unimux/1.2.0").unwrap().route(Route::System);
    let response = c.fetch(req).await.unwrap();
    assert_eq!(response.status, 200);
    let connect = &proxy.seen()[0];
    assert_eq!((connect.method.as_str(), connect.target.as_str()), ("CONNECT", "tls.unimux-b3.test:443"));
    assert_eq!(connect.header("user-agent"), Some("unimux/1.2.0"));
    let inner = &server.seen()[0];
    assert_eq!(inner.target, "/v1/oauth/token");
    assert_eq!(inner.names_sorted(), ["connection", "content-length", "content-type", "host", "user-agent"]);
    assert_eq!(inner.header("host"), Some("tls.unimux-b3.test"));

    // Without the extra root the certificate is refused, before anything is sent (a connect failure).
    let strict = HttpClient::builder().proxy_resolver(Arc::new(FixedProxy(vec![http_proxy_at(proxy.addr)]))).build().unwrap();
    let error = strict.fetch(Request::get("https://tls.unimux-b3.test/").unwrap()).await.unwrap_err();
    assert!(error.is_connect_failure(), "{error:?}");
    assert_eq!(server.seen().len(), 1);

    // A proxy that refuses the tunnel.
    let refusing = http_proxy(None, ok_json()).await;
    let error =
        via(vec![http_proxy_at(refusing.addr)]).fetch(Request::get("https://tls.unimux-b3.test/").unwrap()).await.unwrap_err();
    assert!(error.is_connect_failure(), "{error:?}");
}

#[tokio::test]
async fn socks5_carries_the_host_name_to_the_proxy() {
    let server = http_server(ok_json()).await;
    let (socks, asked) = socks5_proxy(server.addr).await;
    let c =
        via(vec![ProxyChoice::Proxy(ProxyServer { scheme: ProxyScheme::Socks5, host: "127.0.0.1".into(), port: socks.port() })]);
    assert_eq!(c.fetch(Request::get("http://socks.unimux-b3.test:8080/p").unwrap()).await.unwrap().status, 200);
    assert_eq!(asked.lock().clone(), ["socks.unimux-b3.test:8080"]);
    assert_eq!(server.seen()[0].target, "/p");
}

#[tokio::test]
async fn h2_is_negotiated_unless_http1_or_connection_close_is_asked() {
    let ca = test_ca(&["localhost"]);
    let server = h2_server(&ca).await;
    let c = HttpClient::builder().proxy_resolver(Arc::new(NoProxy)).extra_root(ca.ca_der.clone()).build().unwrap();
    let url = format!("https://localhost:{}/h", server.addr.port());
    let response = c.fetch(calls::claude_usage(&url, "t", "unimux").unwrap()).await.unwrap();
    assert_eq!(response.text(), "h2 ok");
    c.fetch(Request::get(&url).unwrap().http1_only()).await.unwrap();
    c.fetch(Request::get(&url).unwrap().connection_close()).await.unwrap();
    let seen = server.seen();
    assert_eq!(seen[0].version, "HTTP/2.0");
    let mut names: Vec<&str> = seen[0].headers.iter().map(|(n, _)| n.as_str()).collect();
    names.sort();
    assert_eq!(names, ["accept", "anthropic-beta", "authorization", "user-agent"]);
    assert_eq!(seen[1].version, "HTTP/1.1");
    assert_eq!(seen[2].version, "HTTP/1.1");
}

// ---- PAC through WinHTTP (Windows) ------------------------------------------------------------------------------------------

/// A PAC script served from a local server sends one host through a local proxy: WinHTTP downloads and runs the script
/// (the same code path as "Use setup script" in Internet Options), the client follows its answer. The user's own settings
/// are neither read nor changed by this test.
#[cfg(windows)]
#[tokio::test]
async fn a_pac_script_sends_the_request_through_the_proxy() {
    use unimux_net::proxy::ProxyResolver;
    use unimux_net::proxy::windows::WinResolver;

    struct PacResolver {
        win: WinResolver,
        pac: String,
    }
    impl ProxyResolver for PacResolver {
        fn resolve(&self, url: &unimux_net::Url) -> Vec<ProxyChoice> {
            self.win.auto(url, false, Some(&self.pac)).unwrap_or_else(|code| panic!("WinHTTP PAC error {code}"))
        }
    }

    let proxy = http_proxy(None, answer(|_| json(200, r#"{"via":"pac-proxy"}"#))).await;
    let script = format!(
        "function FindProxyForURL(url, host) {{\n\
           if (shExpMatch(host, '*.pac.unimux-b3.test')) return 'PROXY 127.0.0.1:{}; DIRECT';\n\
           if (host == 'kinds.unimux-b3.test') return 'PROXY a.test:1; HTTPS b.test:2; SOCKS c.test:3; SOCKS5 d.test:4; DIRECT';\n\
           return 'DIRECT';\n\
         }}",
        proxy.addr.port()
    );
    let pac = file_server("application/x-ns-proxy-autoconfig", script).await;
    let resolver = PacResolver { win: WinResolver::default(), pac: pac.url("/proxy.pac") };
    let list = tokio::task::spawn_blocking({
        let r = PacResolver { win: WinResolver::default(), pac: pac.url("/proxy.pac") };
        let u = |s: &str| unimux_net::Url::parse(s).unwrap();
        move || {
            (
                r.resolve(&u("http://api.pac.unimux-b3.test/v1/x")),
                r.resolve(&u("https://direct.unimux-b3.test/")),
                r.resolve(&u("https://kinds.unimux-b3.test/")),
            )
        }
    })
    .await
    .unwrap();
    println!("WinHTTP PAC answers: {list:?}");
    // The DIRECT entry is kept (Chromium falls back to it when the proxy cannot be reached).
    assert_eq!(list.0, vec![http_proxy_at(proxy.addr), ProxyChoice::Direct]);
    assert_eq!(list.1, vec![ProxyChoice::Direct]);
    let server = |scheme, host: &str, port| ProxyChoice::Proxy(ProxyServer { scheme, host: host.into(), port });
    assert_eq!(
        list.2,
        vec![
            server(ProxyScheme::Http, "a.test", 1),
            server(ProxyScheme::Https, "b.test", 2),
            server(ProxyScheme::Socks4, "c.test", 3),
            // WinHTTP drops SOCKS5 entries of a PAC answer (Chromium would use them): recorded as a known gap.
            ProxyChoice::Direct,
        ]
    );

    let c = HttpClient::builder().proxy_resolver(Arc::new(resolver)).build().unwrap();
    let response = c.fetch(calls::changelog("http://api.pac.unimux-b3.test/v1/x").unwrap()).await.unwrap();
    assert_eq!(response.json().unwrap()["via"], "pac-proxy");
    assert_eq!(proxy.seen()[0].target, "http://api.pac.unimux-b3.test/v1/x");

    // A script that cannot be downloaded is an error (the resolver then falls back to the manual proxy or direct).
    let dead = closed_port().await;
    let win = WinResolver::default();
    let url = unimux_net::Url::parse("http://api.pac.unimux-b3.test/").unwrap();
    let missing = tokio::task::spawn_blocking(move || win.auto(&url, false, Some(&format!("http://127.0.0.1:{dead}/none.pac"))))
        .await
        .unwrap();
    assert!(missing.is_err(), "{missing:?}");
}

/// Reads the current user's Internet Options (read only) and resolves one URL with them: must not fail or hang.
#[cfg(windows)]
#[tokio::test]
async fn the_system_settings_can_be_read() {
    let config = unimux_net::proxy::windows::current_user_config();
    println!("Internet Options proxy settings: {config:?}");
    let c = HttpClient::new().unwrap();
    let started = Instant::now();
    let list = c.proxies_for(&unimux_net::Url::parse("https://api.github.com/").unwrap()).await;
    println!("system proxy for https://api.github.com/: {list:?} in {:?}", started.elapsed());
    assert!(!list.is_empty());
}

// ---- optional: the real internet ------------------------------------------------------------------------------------------

/// `UNIMUX_NET_ONLINE=1 cargo test -p unimux-net online -- --nocapture`: one GET to api.github.com with the system proxy and
/// the system certificate store, over h2 and over HTTP/1.1.
#[tokio::test]
async fn online_github_api() {
    if std::env::var("UNIMUX_NET_ONLINE").as_deref() != Ok("1") {
        return;
    }
    let c = HttpClient::new().unwrap();
    for req in [
        calls::changelog("https://api.github.com/repos/daven-team/unimux/releases?per_page=1").unwrap(),
        calls::changelog("https://api.github.com/rate_limit").unwrap().http1_only(),
    ] {
        let started = Instant::now();
        let response = c.fetch(req).await.unwrap();
        println!("{} {} in {:?}, {} bytes", response.url, response.status, started.elapsed(), response.body.len());
        assert!(response.status < 500);
    }
}
