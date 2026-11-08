//! Commands of the `accounts` domain: A1-A5: accounts, logins, usage, auto-switch (accounts:*, auth:*, usage:*).
//!
//! Registered by `register` only; nothing else in the app is edited when a package lands. Until then the router answers
//! the domain's channels with `MC_NOT_YET` (see `npm run ipc:report`).
//!
//! A3 wires the Claude account work of the app run ([`claude_accounts`]: store, swap slot, profile locks, renewals with the
//! persisted 429 windows in `<data>/refresh-limits.json`, reconcile, migration) into the startup (W7 slots): the recovery of
//! an interrupted swap (A2's `recoverActivation`: version-2 journal with 3 tries and 3 s lock waits, else the 0.9.0
//! recovery), the 0.9.0 -> 0.9.1 migration, the 30 s retry of a recovery that found Claude Code's locks busy; the
//! `update:busy` probe; the quit's swap waits.
//!
//! A4 ([`login`]): the Claude and Codex login managers, `auth:start` / `auth:cancel`, the login probes, the pty host's crash
//! hook and the quit's dispose.
//!
//! A5 ([`usage`]): `usage:*`, every `accounts:*` channel, `alerts:testLimit`, the polls (which call
//! [`ClaudeAccounts::before_poll`], [`ClaudeAccounts::refresh_claude`] and [`ClaudeAccounts::refs`]), the automatic switch
//! and the limit warnings. `auth:*` and [`ClaudeAccounts::before_main_login`] are A4's; A4 plugs its login managers in
//! through [`usage::set_login_hooks`] and [`ClaudeAccounts::set_login_probes`].

use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures::FutureExt;
use unimux_accounts::claude::{ClaudeAccounts, ClaudeAccountsConfig};
use unimux_accounts::refresh::renew::TokenFetch;
use unimux_ipc::RouterBuilder;

use crate::context::AppContext;
use crate::lifecycle::wind_down::{QUIT_SWAP_AFTER_CELLS, QUIT_SWAP_WAIT, phase};

pub mod login;
pub mod usage;

static SERVICE: OnceLock<Arc<ClaudeAccounts>> = OnceLock::new();

/// The token endpoint client (http_fetch, B3: direct first, then the system proxy). A client that cannot be built (TLS
/// setup) fails each request as "no connection", which the renewal reports as `network`.
struct LazyClient(OnceLock<Option<unimux_net::HttpClient>>);

impl TokenFetch for LazyClient {
    fn fetch(
        &self,
        req: unimux_net::Request,
    ) -> futures::future::BoxFuture<'static, Result<unimux_net::Response, unimux_net::FetchError>> {
        match self.0.get_or_init(|| unimux_net::HttpClient::new().ok()) {
            Some(client) => TokenFetch::fetch(client, req),
            None => async { Err(unimux_net::FetchError::Connect("no HTTP client".into())) }.boxed(),
        }
    }
}

/// The Claude account work of this app run (made on first use, on the async runtime).
pub fn claude_accounts(ctx: &Arc<AppContext>) -> Arc<ClaudeAccounts> {
    SERVICE
        .get_or_init(|| {
            ClaudeAccounts::new(ClaudeAccountsConfig {
                data_dir: ctx.data_dir.clone(),
                home: unimux_core::home::home_dir(),
                env: std::env::vars().collect(),
                darwin: cfg!(target_os = "macos"),
                user_agent: unimux_net::calls::product_user_agent(unimux_core::VERSION),
                // MC_USAGE_CLAUDE_TOKEN_URL: dev-overrides builds only (release builds see None).
                token_url: ctx.overrides.usage_claude_token_url.clone(),
                fetch: Arc::new(LazyClient(OnceLock::new())),
                rt: tauri::async_runtime::handle().inner().clone(),
            })
        })
        .clone()
}

/// The service once it was made (the probes never make it).
fn existing() -> Option<Arc<ClaudeAccounts>> {
    SERVICE.get().cloned()
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    login::register(r, ctx);
    // A5: usage:*, accounts:* (all but the logins), alerts:testLimit, the polls and the notices.
    usage::register(r, ctx);

    // recoverActivation (A2): an interrupted main-account swap is repaired (or reported pending) before any account call.
    let c = ctx.clone();
    ctx.startup_steps.set_account_recovery(Arc::new(move || {
        let c = c.clone();
        async move {
            let svc = claude_accounts(&c);
            let recovered = svc.blocking(|s| s.recover_at_start()).await;
            if let Some(r) = recovered
                && r != unimux_accounts::results::Recovery::None
            {
                c.crash.info(&format!("account recovery at start: {}", r.as_str()));
            }
            // A recovery still 'locked' is retried by its own timer too: the polls do not run while the limits panel is off.
            // pushSwapPending after each try that did not stay locked.
            let after = c.clone();
            svc.start_recovery_retry(Arc::new(move || usage::hub(&after).push_swap_pending()));
        }
        .boxed()
    }));

    // migrateAccounts (A3): 0.9.0 -> 0.9.1 identities and duplicates, once; nothing is deleted.
    let c = ctx.clone();
    ctx.startup_steps.set_account_migration(Arc::new(move || {
        let c = c.clone();
        async move {
            let svc = claude_accounts(&c);
            if let Some(report) = svc.blocking(|s| s.migrate()).await
                && report.migrated
            {
                c.crash.info(&format!("accounts migrated: {} filled, {} set aside", report.filled, report.quarantined.len()));
            }
        }
        .boxed()
    }));

    // update:busy: a running swap or Codex "make main", a login in progress (the login probes of A4).
    let updates = ctx.update.get_or_init(|| crate::update::UpdateService::new(ctx)).clone();
    updates.add_busy_probe(Arc::new(|| existing().map_or((false, false), |s| s.busy())));

    // The quit: no new account work, the recovery timer stops; a running swap finishes first (5 s, and 3 s after the
    // terminals were shut down, quitWait.ts).
    ctx.lifecycle.wind_down.register(phase::STOP_SERVICES, "accounts stop", Duration::from_secs(1), || async {
        if let Some(s) = existing() {
            s.quit();
        }
        usage::stop();
    });
    for (p, name, wait) in [
        (phase::SWAP_WAIT, "swap wait", QUIT_SWAP_WAIT),
        (phase::SWAP_AFTER_CELLS, "swap wait after cells", QUIT_SWAP_AFTER_CELLS),
    ] {
        ctx.lifecycle.wind_down.register(p, name, wait + Duration::from_millis(500), move || async move {
            if let Some(s) = existing() {
                let _ = tokio::time::timeout(wait, s.slot.idle()).await;
            }
        });
    }
}
