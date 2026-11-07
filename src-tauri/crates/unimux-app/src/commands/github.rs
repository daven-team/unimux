//! Commands of the `github` domain: A6 + G3: GitHub sign-in and publish (github:*).
//!
//! Registered by `register` only; nothing else in the app is edited when a package lands. Until then the router answers
//! the domain's channels with `MC_NOT_YET` (see `npm run ipc:report`).
//!
//! A6 (sign-in): `github:status`, `github:deviceStart`, `github:deviceWait`, `github:deviceCancel`, `github:signOut`. Every
//! one is guarded (app windows only, 1.1.4 `guardedHandle`): the status runs `gh` and asks GitHub. The renderer gets the
//! source and the user name, never a token. G3 adds `github:publish` and reaches the token, `rejected`, the git header
//! ([`unimux_accounts::github::service::GithubService::remote_auth`]) and `remote_auth_refused` through [`github_service`].

use std::sync::{Arc, OnceLock};

use futures::FutureExt;
use serde_json::Value;
use unimux_accounts::github::api::GithubFetch;
use unimux_accounts::github::auth::EnvSource;
use unimux_accounts::github::service::GithubService;
use unimux_ipc::RouterBuilder;

use crate::context::AppContext;

static SERVICE: OnceLock<Arc<GithubService>> = OnceLock::new();

/// The client every GitHub request goes through (http_fetch, B3: system proxy, OS certificate verifier). A client that cannot
/// be built (TLS setup) fails each request, which 1.1.4's code reads as offline.
struct LazyClient(OnceLock<Option<unimux_net::HttpClient>>);

impl GithubFetch for LazyClient {
    fn fetch(
        &self,
        req: unimux_net::Request,
    ) -> futures::future::BoxFuture<'static, Result<unimux_net::Response, unimux_net::FetchError>> {
        match self.0.get_or_init(|| unimux_net::HttpClient::new().ok()) {
            Some(client) => GithubFetch::fetch(client, req),
            None => async { Err(unimux_net::FetchError::Connect("no HTTP client".into())) }.boxed(),
        }
    }
}

/// The GitHub sign-in of this app run (index.ts `createGithubService`): `<data>/github/token.json` read at start, the shared
/// safeStorage (B2), `gh` in `cliDetector.applyEnv(cleanEnv(process.env))`.
pub fn github_service(ctx: &Arc<AppContext>) -> Arc<GithubService> {
    SERVICE
        .get_or_init(|| {
            let detector = crate::commands::agents::cli_detector(ctx);
            let env: EnvSource = Arc::new(move || {
                let detector = detector.clone();
                async move {
                    let env: Vec<(String, String)> = unimux_agents::cli::system::process_env()
                        .into_iter()
                        .filter(|(k, _)| !unimux_exec::is_session_var(k))
                        .collect();
                    detector.apply_env(env, None).await
                }
                .boxed()
            });
            Arc::new(GithubService::new(&ctx.data_dir, ctx.safe_storage.clone(), Arc::new(LazyClient(OnceLock::new())), env))
        })
        .clone()
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let service = github_service(ctx);

    let s = service.clone();
    r.invoke("github:status", move |call| {
        let s = s.clone();
        async move { Ok(s.status(call.arg(0)).await) }
    });

    let s = service.clone();
    r.invoke("github:deviceStart", move |_| {
        let s = s.clone();
        async move { Ok(s.device_start().await) }
    });

    let s = service.clone();
    r.invoke("github:deviceWait", move |call| {
        let s = s.clone();
        async move { s.device_wait(call.arg(0)).await.map_err(|m| call.fail(m)) }
    });

    let s = service.clone();
    r.invoke("github:deviceCancel", move |call| {
        let s = s.clone();
        async move {
            s.device_cancel(call.arg(0));
            Ok(Value::Null)
        }
    });

    let s = service;
    r.invoke("github:signOut", move |_| {
        let s = s.clone();
        async move { Ok(s.sign_out().await) }
    });
}
