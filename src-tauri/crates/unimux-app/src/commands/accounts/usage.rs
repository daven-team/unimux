//! A5: the limits panel, the automatic switch and the limit warnings of this app run (index.ts `usage`, `autoSwitch`,
//! `limitAlerts`, `makeMainClaude` / `makeMainCodex`, `pushSwapPending` and `registerAccountIpc`).
//!
//! Channels: `usage:get` (open, ungated), `usage:refresh`, `accounts:remove` / `makeMain` / `adoptCopy` / `swapPending` /
//! `clearSwapPending` / `dismissNotice` / `switchBest` / `acceptSwitch` / `dismissSwitch` / `makeMainCodex` / `removeCodex`,
//! and the send `alerts:testLimit`. Everything that changes something waits for the `accounts_ready` gate and answers 1.1.4's
//! refusal once the app quits (accountsIpc.ts `refusalFor`). `auth:start` / `auth:cancel` are A4's: the login managers plug
//! in through [`set_login_hooks`] (the parked restores before each poll, the parked ids of the panel, the cancel of a card
//! that is removed, and whether a login runs).
//!
//! Events: `usage:state` after every change, `usage:open` from a notice click, `accounts:swapPending` after a swap, a
//! recovery or a page load.

use std::path::Path;
use std::sync::{Arc, OnceLock, Weak};
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use parking_lot::{Mutex, RwLock};
use serde_json::{Value, json};
use unimux_accounts::auto_switch::{
    AutoSwitchSettings, AutoSwitcher, AutoSwitcherOptions, NoticeKind, SwitchNotice, auto_switch_on,
};
use unimux_accounts::claude::ClaudeAccounts;
use unimux_accounts::codex::{CodexIdentity, codex_identity_key, compare_codex_identity, is_codex_account_id};
use unimux_accounts::codex_activate::{
    CodexActivateDeps, activate_codex_account, check_codex_target, read_live_codex_identity, reconcile_codex_live,
};
use unimux_accounts::codex_store::CodexAccountsStore;
use unimux_accounts::identity::{Custody, IdentityMatch, TokenFamily, custody_of};
use unimux_accounts::legacy_swap::{clear_pending_swap, has_pending_swap};
use unimux_accounts::limit_alerts::{AlertSettings, LimitAlerter, LimitAlerterOptions, LimitNotice};
use unimux_accounts::notice_text::{auto_switch_text, limit_notice_text, switch_button_text};
use unimux_accounts::refs::{AccountRef, panel_notices};
use unimux_accounts::results::{SwapError, SwapResult};
use unimux_accounts::rules::{
    AdoptCopyDeps, GuardDeps, MakeMainDeps, RemoveDeps, RenewRule, dismiss_account_notice, handle_adopt_copy, handle_make_main,
    handle_remove_account,
};
use unimux_accounts::swapfs::RealSwapFs;
use unimux_accounts::usage::credentials::{CredentialSource, claude_credentials_stamp, system_keychain};
use unimux_accounts::usage::fetchers::{FetcherDeps, fetch_claude, fetch_codex};
use unimux_accounts::usage::types::{Provider, Status, WindowId};
use unimux_accounts::usage::{AccountsInfo, UsageOptions, UsageService, UsageState};
use unimux_ipc::{IpcError, RouterBuilder};

use crate::context::AppContext;

/// How long a poll waits for the retry of failed profile restores before it reads the accounts.
const PARKED_RESTORE_WAIT: Duration = Duration::from_secs(2);

type Probe = Arc<dyn Fn() -> bool + Send + Sync>;

/// What the login managers (A4) add. The Claude login's own probes go to [`ClaudeAccounts::set_login_probes`].
#[derive(Clone)]
pub struct LoginHooks {
    /// A Claude or Codex login window flow runs (`login.isActive() || codexLogin.isActive()`).
    pub any_active: Probe,
    /// `login.parkedIds()`: cards whose restore is retried.
    pub parked_ids: Arc<dyn Fn() -> Vec<String> + Send + Sync>,
    /// `login.retryParkedRestores(waitMs)`.
    pub retry_parked_restores: Arc<dyn Fn(Duration) -> BoxFuture<'static, ()> + Send + Sync>,
    /// `login.cancelFor(recordId)` (a Claude card that is removed).
    pub cancel_for: Arc<dyn Fn(&str) + Send + Sync>,
    /// `codexLogin.cancelFor(recordId)` (a Codex card that is removed).
    pub codex_cancel_for: Arc<dyn Fn(&str) + Send + Sync>,
}

impl Default for LoginHooks {
    fn default() -> Self {
        Self {
            any_active: Arc::new(|| false),
            parked_ids: Arc::new(Vec::new),
            retry_parked_restores: Arc::new(|_| async {}.boxed()),
            cancel_for: Arc::new(|_| {}),
            codex_cancel_for: Arc::new(|_| {}),
        }
    }
}

static LOGIN: RwLock<Option<LoginHooks>> = RwLock::new(None);

/// A4: the login managers' hooks.
pub fn set_login_hooks(hooks: LoginHooks) {
    *LOGIN.write() = Some(hooks);
}

fn login() -> LoginHooks {
    LOGIN.read().clone().unwrap_or_default()
}

/// The account limits of this app run.
pub struct Hub {
    ctx: Weak<AppContext>,
    pub claude: Arc<ClaudeAccounts>,
    pub codex: Arc<CodexAccountsStore>,
    codex_live: Mutex<Option<CodexIdentity>>,
    pub usage: Arc<UsageService>,
    pub auto: Arc<AutoSwitcher>,
    pub alerts: Arc<LimitAlerter>,
    credentials: CredentialSource,
}

static HUB: OnceLock<Arc<Hub>> = OnceLock::new();

/// The hub once it was made (the window and quit hooks never make it).
pub fn existing() -> Option<Arc<Hub>> {
    HUB.get().cloned()
}

fn now_ms() -> f64 {
    unimux_core::time::now_ms() as f64
}

fn settings(ctx: &Weak<AppContext>) -> Value {
    ctx.upgrade().and_then(|c| c.state.get().get("settings").cloned()).unwrap_or(Value::Null)
}

fn alert_settings(settings: &Value) -> AlertSettings {
    AlertSettings::from_value(settings.get("alerts"))
}

fn switch_settings(settings: &Value) -> AutoSwitchSettings {
    AutoSwitchSettings::from_value(settings.get("accountSwitch"))
}

/// `${showAiUsage}:${usageIntervalMinutes}:${limitPollingWanted(alerts)}`: a change reschedules the polls.
fn usage_key(settings: &Value) -> String {
    format!(
        "{}:{}:{}",
        settings.get("showAiUsage").and_then(Value::as_bool).unwrap_or(false),
        settings.get("usageIntervalMinutes").map(Value::to_string).unwrap_or_default(),
        alert_settings(settings).limit_polling_wanted()
    )
}

/// A card id (`claude:<record>` / `codex:<record>`) to its record id.
fn record_of_card(card: &str) -> &str {
    card.strip_prefix("claude:").or_else(|| card.strip_prefix("codex:")).unwrap_or(card)
}

/// The language of main's texts.
fn language(ctx: &AppContext) -> String {
    crate::commands::os::language(&ctx.state.get())
}

/// The hub of this run (made on first use).
pub fn hub(ctx: &Arc<AppContext>) -> Arc<Hub> {
    HUB.get_or_init(|| {
        let hub = Hub::new(ctx);
        // A4: what a finished login changed is read at once (`usage.refresh(true, true, subject)`).
        let usage = hub.usage.clone();
        super::login::set_usage_refresh(move |subject| {
            let usage = usage.clone();
            tauri::async_runtime::spawn(async move {
                usage.refresh(true, true, Some(&subject)).await;
            });
        });
        hub
    })
    .clone()
}

impl Hub {
    fn new(ctx: &Arc<AppContext>) -> Arc<Self> {
        let claude = super::claude_accounts(ctx);
        let rt = tauri::async_runtime::handle().inner().clone();
        let darwin = cfg!(target_os = "macos");
        let home = unimux_core::home::home_dir();
        let env: std::collections::BTreeMap<String, String> = std::env::vars().collect();
        let keychain = darwin.then(|| system_keychain(Arc::new(now_ms)));
        let credentials = CredentialSource::system(env, home, darwin, keychain);
        // One store per app run, shared with A4's Codex logins.
        let codex = super::login::codex_accounts(ctx);
        let weak_ctx = Arc::downgrade(ctx);
        let data_dir = ctx.data_dir.clone();
        let overrides = ctx.overrides.clone();

        let hub = Arc::new_cyclic(|me: &Weak<Hub>| {
            let fetch_claude_fn = {
                let c = claude.clone();
                Arc::new(move |dir: &Path| c.refresh_claude(dir))
            };
            let creds = credentials.clone();
            let fetcher = FetcherDeps {
                credentials: credentials.clone(),
                fetch: Arc::new(super::LazyClient(OnceLock::new())),
                now: Arc::new(now_ms),
                codex_home: Arc::new(move || creds.codex_home()),
                // MC_USAGE_*_URL: dev-overrides builds only (release builds see None).
                claude_url: overrides.usage_claude_url.clone().unwrap_or_else(|| unimux_net::calls::CLAUDE_USAGE_URL.to_string()),
                codex_url: overrides.usage_codex_url.clone().unwrap_or_else(|| unimux_net::calls::CODEX_USAGE_URL.to_string()),
                refresh_claude: Some(fetch_claude_fn),
                sleep: Arc::new(|d| tokio::time::sleep(d).boxed()),
                // The usage endpoint counts its limit per client: the app reads as itself, never as Claude Code.
                user_agent: unimux_net::calls::product_user_agent(unimux_core::VERSION),
            };

            let (m1, m2, m3, m4, m5, m6) = (me.clone(), me.clone(), me.clone(), me.clone(), me.clone(), me.clone());
            let (s1, s2, s3) = (weak_ctx.clone(), weak_ctx.clone(), weak_ctx.clone());
            let mut o = UsageOptions::new(
                Arc::new(move || m1.upgrade().map(|h| h.refs()).unwrap_or_default()),
                Arc::new(move |r: AccountRef| {
                    let deps = fetcher.clone();
                    async move {
                        if r.provider == "claude" { fetch_claude(&deps, &r).await } else { fetch_codex(&deps, &r).await }
                    }
                    .boxed()
                }),
                data_dir.join("usage-cache.json"),
                Arc::new(move || settings(&s1).get("showAiUsage").and_then(Value::as_bool) == Some(true)),
                Arc::new(move || settings(&s2).get("usageIntervalMinutes").and_then(Value::as_f64).unwrap_or(0.0) * 60_000.0),
                rt.clone(),
            );
            let stamp_source = credentials.clone();
            o.credentials_stamp = Some(Arc::new(move |r: &AccountRef| {
                (r.provider == "claude" && r.config_dir.is_none()).then(|| claude_credentials_stamp(&stamp_source)).flatten()
            }));
            // Every poll first looks at who is signed in (an outside Codex switch, cswap, /login); never while a swap or a
            // login runs (the swap slot is held meanwhile).
            o.before_run = Some(Arc::new(move || {
                let me = m2.clone();
                async move {
                    let Some(h) = me.upgrade() else { return };
                    h.before_run().await;
                }
                .boxed()
            }));
            o.watch_live = true;
            o.notices = Some(Arc::new(move || {
                m3.upgrade()
                    .map(|h| panel_notices(&h.claude.store.notices()).iter().map(|n| n.to_value()).collect())
                    .unwrap_or_default()
            }));
            o.accounts_info = Some(Arc::new(move || m4.upgrade().map(|h| h.accounts_info()).unwrap_or_default()));
            o.live_email =
                Some(Arc::new(move || m5.upgrade().and_then(|h| h.claude.store.live()).and_then(|l| l.identity.email)));
            // Limit warnings and the automatic switch must also work while the window is minimized or in the tray.
            o.poll_hidden = Some(Arc::new(move || {
                let s = settings(&s3);
                let sw = switch_settings(&s);
                alert_settings(&s).limit_polling_wanted()
                    || auto_switch_on(&sw, Provider::Claude)
                    || auto_switch_on(&sw, Provider::Codex)
            }));
            let usage = UsageService::new(o);

            let (s4, s5) = (weak_ctx.clone(), weak_ctx.clone());
            let (u1, u2) = (Arc::downgrade(&usage), Arc::downgrade(&usage));
            let notice_ctx = weak_ctx.clone();
            let alerts = LimitAlerter::new(LimitAlerterOptions {
                file: data_dir.join("limit-alerts.json"),
                alerts: Arc::new(move || alert_settings(&settings(&s4))),
                show: Arc::new(move |n: &LimitNotice| {
                    if let Some(c) = notice_ctx.upgrade() {
                        show_limit_notice(&c, n);
                    }
                }),
                providers: Arc::new(move || u1.upgrade().map(|u| u.state().providers).unwrap_or_default()),
                now: Arc::new(now_ms),
                rt: rt.clone(),
            });

            let (m7, m8) = (me.clone(), me.clone());
            let changed_ctx = weak_ctx.clone();
            let switch_notice_ctx = weak_ctx.clone();
            let auto = AutoSwitcher::new(AutoSwitcherOptions {
                file: data_dir.join("auto-switch.json"),
                settings: Arc::new(move || switch_settings(&settings(&s5))),
                providers: Arc::new(move || u2.upgrade().map(|u| u.state().providers).unwrap_or_default()),
                // Claude profiles need files for the live login (macOS keeps it in the Keychain).
                supported: Arc::new(move |p| p == Provider::Codex || !darwin),
                busy: Arc::new(move || m6.upgrade().is_none_or(|h| h.account_work_busy())),
                validate: Arc::new(move |provider, card| {
                    let me = m7.clone();
                    async move {
                        let Some(h) = me.upgrade() else { return Some(SwapResult::fail(SwapError::Busy)) };
                        h.validate(provider, card).await
                    }
                    .boxed()
                }),
                swap: Arc::new(move |provider, card| {
                    let me = m8.clone();
                    async move {
                        let Some(h) = me.upgrade() else { return SwapResult::fail(SwapError::Busy) };
                        let id = Value::String(record_of_card(&card).to_string());
                        if provider == Provider::Codex { h.make_main_codex(&id).await } else { h.make_main_claude(&id).await }
                    }
                    .boxed()
                }),
                notify: Arc::new(move |n: &SwitchNotice| {
                    if let Some(c) = switch_notice_ctx.upgrade() {
                        show_switch_notice(&c, n);
                    }
                }),
                changed: Arc::new(move || {
                    if let Some(c) = changed_ctx.upgrade() {
                        send_usage_state(&c);
                    }
                }),
                now: Arc::new(now_ms),
                rt: rt.clone(),
            });

            Hub {
                ctx: weak_ctx.clone(),
                claude: claude.clone(),
                codex: codex.clone(),
                codex_live: Mutex::new(None),
                usage,
                auto,
                alerts,
                credentials,
            }
        });
        *hub.codex_live.lock() = read_live_codex_identity(&hub.codex_deps());

        // After every poll: the limit warnings, the automatic switch, the panel (index.ts order).
        let (w1, w2, w3) = (Arc::downgrade(&hub), Arc::downgrade(&hub), weak_ctx);
        hub.usage.on_change(Arc::new(move |s: &UsageState| {
            if let Some(h) = w1.upgrade() {
                h.alerts.on_state(&s.providers);
            }
        }));
        hub.usage.on_change(Arc::new(move |s: &UsageState| {
            if let Some(h) = w2.upgrade() {
                let providers = s.providers.clone();
                let auto = h.auto.clone();
                tauri::async_runtime::spawn(async move { auto.on_state(providers).await });
            }
        }));
        hub.usage.on_change(Arc::new(move |s: &UsageState| {
            if let Some(c) = w3.upgrade() {
                c.events.send("usage:state", vec![s.to_value()]);
            }
        }));
        hub
    }

    fn ctx(&self) -> Option<Arc<AppContext>> {
        self.ctx.upgrade()
    }

    fn codex_deps(&self) -> CodexActivateDeps {
        let creds = self.credentials.clone();
        CodexActivateDeps {
            store: self.codex.clone(),
            live_home: Arc::new(move || creds.codex_home()),
            now: Arc::new(now_ms),
            read_text: None,
            write_text: None,
            slot: self.claude.slot.clone(),
        }
    }

    /// The live Codex card and every saved Codex account that is not the live one (its numbers are on the live card).
    fn codex_refs(&self) -> Vec<AccountRef> {
        let records = self.codex.list();
        let live = self.codex_live.lock().clone();
        let live_key = live.as_ref().and_then(codex_identity_key);
        let main = AccountRef {
            id: "codex:main".into(),
            provider: "codex".into(),
            key: live_key,
            active: (!records.is_empty()).then_some(true),
            ..AccountRef::default()
        };
        let mut out = vec![main];
        for record in records {
            if live.as_ref().is_some_and(|l| compare_codex_identity(&record.identity, l) == IdentityMatch::Same) {
                continue;
            }
            out.push(AccountRef {
                id: format!("codex:{}", record.id),
                provider: "codex".into(),
                config_dir: self.codex.dir_of(&record.id).ok(),
                key: codex_identity_key(&record.identity),
                renew: record.outdated.then_some(RenewRule::SwitchedOut),
                ..AccountRef::default()
            });
        }
        out
    }

    fn refs(&self) -> Vec<AccountRef> {
        let mut refs = self.claude.refs();
        refs.extend(self.codex_refs());
        refs
    }

    fn accounts_info(&self) -> AccountsInfo {
        let mut info = AccountsInfo::default();
        if self.claude.store.read_only() {
            info.accounts_read_only = Some(self.claude.store.file_path().to_string_lossy().into_owned());
        } else {
            let panel = self.claude.panel_info(&(login().parked_ids)());
            info.set_aside = panel.set_aside.iter().filter_map(|s| serde_json::to_value(s).ok()).collect();
            info.duplicate_copies = panel.duplicate_copies;
        }
        info.switch_offer = self.auto.current_offer().map(|o| o.to_value());
        info.switch_away = self.auto.away();
        info
    }

    /// `beforeRun` of the polls.
    async fn before_run(self: &Arc<Self>) {
        // Who is in the live Codex login (an outside switch marks the copy that left as possibly outdated); never during a
        // Codex swap.
        if !self.claude.slot.is_codex_running() {
            let me = self.clone();
            if let Ok(live) = tokio::task::spawn_blocking(move || reconcile_codex_live(&me.codex_deps())).await {
                *self.codex_live.lock() = live;
            }
        }
        // A re-login whose restore failed earlier is tried again; the poll waits for it briefly only.
        if self.claude.quitting() {
            return;
        }
        let _ = tokio::time::timeout(PARKED_RESTORE_WAIT, (login().retry_parked_restores)(PARKED_RESTORE_WAIT)).await;
        if self.claude.quitting() {
            return;
        }
        // The roster, a pending activation recovery, then the reconcile (or only the backup of the outgoing live login
        // during a main login).
        self.claude.blocking(|c| c.before_poll()).await;
    }

    /// Anything that changes the account files runs or is unresolved: no automatic switch now.
    fn account_work_busy(&self) -> bool {
        let slot = &self.claude.slot;
        slot.is_running()
            || slot.is_codex_running()
            || (login().any_active)()
            || slot.is_unresolved()
            || slot.is_recovery_pending()
            || self.claude.quitting()
    }

    fn swap_pending(&self) -> bool {
        has_pending_swap(&RealSwapFs, &self.claude.backup_dir()).unwrap_or(true)
    }

    async fn validate(self: &Arc<Self>, provider: Provider, card: String) -> Option<SwapResult> {
        let id = record_of_card(&card).to_string();
        let me = self.clone();
        tokio::task::spawn_blocking(move || {
            if provider == Provider::Codex {
                return if is_codex_account_id(&id) {
                    check_codex_target(&me.codex_deps(), &id)
                } else {
                    Some(SwapResult::fail(SwapError::Invalid))
                };
            }
            if me.swap_pending() {
                return Some(SwapResult::fail(SwapError::Pending));
            }
            unimux_accounts::activate::check_activation_target(&me.claude.activate_deps(), &id)
        })
        .await
        .unwrap_or_else(|_| Some(SwapResult::fail(SwapError::Write)))
    }

    fn refresh_later(self: &Arc<Self>, subject: Option<String>) {
        let usage = self.usage.clone();
        tauri::async_runtime::spawn(async move {
            usage.refresh(true, true, subject.as_deref()).await;
        });
    }

    /// "Make main" of a saved Claude account (the card's menu, an offer and the automatic switch share it).
    pub async fn make_main_claude(self: &Arc<Self>, id: &Value) -> SwapResult {
        let me = self.clone();
        let id = id.clone();
        let result = tokio::task::spawn_blocking(move || {
            let deps = me.claude.activate_deps();
            let login_active = || (login().any_active)();
            let validate = |a: &str| Ok(unimux_accounts::activate::check_activation_target(&deps, a));
            let swap = |a: &str| Ok(unimux_accounts::activate::activate_account(&deps, a));
            let subject = id.as_str().map(|s| format!("claude:{s}"));
            let on_swapped = || {
                me.refresh_later(subject.clone());
                Ok(())
            };
            handle_make_main(
                &MakeMainDeps { login_active: &login_active, validate: &validate, swap: &swap, on_swapped: &on_swapped },
                &id,
            )
        })
        .await
        .unwrap_or_else(|_| SwapResult::fail(SwapError::Write));
        self.push_swap_pending();
        result
    }

    /// 1.1.2: "make main" of a saved Codex account.
    pub async fn make_main_codex(self: &Arc<Self>, id: &Value) -> SwapResult {
        let Some(id) = id.as_str().filter(|s| is_codex_account_id(s)).map(str::to_string) else {
            return SwapResult::fail(SwapError::Invalid);
        };
        if (login().any_active)() {
            return SwapResult::fail(SwapError::Busy);
        }
        let me = self.clone();
        let result = tokio::task::spawn_blocking(move || {
            let deps = me.codex_deps();
            let result = activate_codex_account(&deps, &id);
            *me.codex_live.lock() = read_live_codex_identity(&deps);
            result
        })
        .await
        .unwrap_or_else(|_| SwapResult::fail(SwapError::Write));
        if result.ok {
            self.refresh_later(None);
        }
        result
    }

    /// Tells the renderer whether an unresolved swap blocks further swaps.
    pub fn push_swap_pending(self: &Arc<Self>) {
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            let pending = tokio::task::spawn_blocking({
                let me = me.clone();
                move || me.swap_pending()
            })
            .await
            .unwrap_or(true);
            if let Some(c) = me.ctx() {
                c.events.send("accounts:swapPending", vec![Value::Bool(pending)]);
            }
        });
    }

    fn guard_deps_run<T>(&self, f: impl FnOnce(&GuardDeps<'_>) -> T) -> T {
        let slot = &self.claude.slot;
        let running = || slot.is_running();
        let pending = || -> std::io::Result<bool> { has_pending_swap(&RealSwapFs, &self.claude.backup_dir()) };
        let now = || slot.is_unresolved() || slot.is_recovery_pending();
        let read_only = || self.claude.store.read_only();
        f(&GuardDeps {
            swap_running: &running,
            swap_pending: &pending,
            swap_pending_now: Some(&now),
            read_only: Some(&read_only),
        })
    }

    fn remove_account(self: &Arc<Self>, id: &Value) -> Result<Value, String> {
        let hooks = login();
        let store = &self.claude.store;
        let is_live = |a: &str| {
            store.live().and_then(|l| l.record_id).as_deref() == Some(a)
                || store.get(a).is_some_and(|r| custody_of(r.custody) == Custody::Live)
        };
        let cancel = |a: &str| (hooks.cancel_for)(a);
        let remove = |a: &str| store.remove(a);
        let on_removed = || self.refresh_later(None);
        self.guard_deps_run(|guard| {
            let deps = RemoveDeps {
                guard: GuardDeps {
                    swap_running: guard.swap_running,
                    swap_pending: guard.swap_pending,
                    swap_pending_now: guard.swap_pending_now,
                    read_only: guard.read_only,
                },
                is_live: &is_live,
                cancel_login: &cancel,
                remove: &remove,
                on_removed: &on_removed,
            };
            handle_remove_account(&deps, id).map(|r| r.to_value()).map_err(|e| e.to_string())
        })
    }

    fn adopt_copy(self: &Arc<Self>, id: &Value) -> Value {
        let store = &self.claude.store;
        let login_active = || (login().any_active)();
        let get = |a: &str| store.get(a);
        let live = || store.live();
        let set_family = |a: &str| store.set_family(a, TokenFamily::Own);
        let on_adopted = |a: &str| self.refresh_later(Some(format!("claude:{a}")));
        self.guard_deps_run(|guard| {
            let deps = AdoptCopyDeps {
                guard: GuardDeps {
                    swap_running: guard.swap_running,
                    swap_pending: guard.swap_pending,
                    swap_pending_now: guard.swap_pending_now,
                    read_only: guard.read_only,
                },
                login_active: &login_active,
                get: &get,
                live: &live,
                set_family_own: &set_family,
                on_adopted: &on_adopted,
            };
            // The sender was checked by the router's guard.
            handle_adopt_copy(&deps, true, id).to_value()
        })
    }

    fn remove_codex(self: &Arc<Self>, id: &Value) -> Value {
        let Some(id) = id.as_str().filter(|s| is_codex_account_id(s) && self.codex.get(s).is_some()) else {
            return json!({ "ok": false });
        };
        if self.claude.slot.is_codex_running() {
            return json!({ "ok": false, "error": "busy" });
        }
        (login().codex_cancel_for)(id);
        if self.codex.remove(id).is_err() {
            return json!({ "ok": false, "error": "readOnly" });
        }
        self.refresh_later(None);
        json!({ "ok": true })
    }

    fn clear_swap_pending(self: &Arc<Self>) -> Value {
        // A recovery still waiting for Claude Code's locks can repair the state itself: its backups are not deleted.
        if self.claude.slot.is_recovery_pending() {
            return json!({ "ok": false, "error": "locked" });
        }
        let deps = self.claude.activate_deps();
        let cleared = unimux_accounts::activate::clear_pending_activation(&deps, &|| clear_pending_swap(&deps));
        self.push_swap_pending();
        json!({ "ok": cleared })
    }
}

fn send_usage_state(ctx: &AppContext) {
    if let Some(h) = existing() {
        ctx.events.send("usage:state", vec![h.usage.state().to_value()]);
    }
}

/// Shows the main window with the AI account limits panel open.
fn open_panel(ctx: &Arc<AppContext>) {
    if let Some(os) = ctx.os.get() {
        os.show_cell(None);
    }
    ctx.events.send("usage:open", vec![]);
}

/// A limit warning (1.1.1): a click brings the app to the front with the limits panel open.
fn show_limit_notice(ctx: &Arc<AppContext>, notice: &LimitNotice) {
    let Some(os) = ctx.os.get().cloned() else { return };
    let (title, body) = limit_notice_text(notice, &language(ctx), now_ms());
    let weak = Arc::downgrade(ctx);
    let on_click: crate::commands::os::NoticeAction = Arc::new(move |_| {
        if let Some(c) = weak.upgrade() {
            open_panel(&c);
        }
    });
    os.notice_with(&title, &body, Vec::new(), None, Some(on_click.clone()), Some(on_click));
}

/// 1.1.2: what the automatic switch did or offers. An offer has a "Przełącz na X" button (Windows and macOS); a click on
/// any of them opens the limits panel, which shows the offer too.
fn show_switch_notice(ctx: &Arc<AppContext>, event: &SwitchNotice) {
    let Some(os) = ctx.os.get().cloned() else { return };
    let lang = language(ctx);
    let (title, body) = auto_switch_text(event, &lang, now_ms());
    let offer = matches!(event.kind, NoticeKind::Offer | NoticeKind::ReturnOffer);
    let buttons =
        if offer && (cfg!(windows) || cfg!(target_os = "macos")) { vec![switch_button_text(event, &lang)] } else { Vec::new() };
    let weak = Arc::downgrade(ctx);
    let on_click: crate::commands::os::NoticeAction = Arc::new(move |_| {
        if let Some(c) = weak.upgrade() {
            open_panel(&c);
        }
    });
    let weak = Arc::downgrade(ctx);
    let event = event.clone();
    let on_button: crate::commands::os::NoticeAction = Arc::new(move |_| {
        let (Some(c), Some(h)) = (weak.upgrade(), existing()) else { return };
        let event = event.clone();
        tauri::async_runtime::spawn(async move {
            let result = h.auto.accept_offer().await;
            if result.ok {
                let mut n = SwitchNotice::new(
                    if event.kind == NoticeKind::ReturnOffer { NoticeKind::Returned } else { NoticeKind::Switched },
                    event.provider,
                );
                n.from_email = event.from_email.clone();
                n.to_email = result.email.clone().or(event.to_email.clone());
                n.window = event.window;
                n.percent = event.percent;
                show_switch_notice(&c, &n);
            } else {
                open_panel(&c);
                let mut n = SwitchNotice::new(NoticeKind::Failed, event.provider);
                n.to_email = event.to_email.clone();
                show_switch_notice(&c, &n);
            }
        });
    });
    os.notice_with(&title, &body, buttons, None, Some(on_click), Some(on_button));
}

/// The "Test" button of the limit warnings: a sample warning for the first account with an e-mail.
fn test_limit(ctx: &Arc<AppContext>) {
    let h = hub(ctx);
    let state = h.usage.state();
    let account =
        state.providers.iter().find(|p| p.email.as_deref().is_some_and(|e| !e.is_empty()) && p.status != Status::SignedOut);
    let limits = alert_settings(&ctx.state.get().get("settings").cloned().unwrap_or(Value::Null)).limits;
    let notice = LimitNotice {
        reset: false,
        provider: account.map_or(Provider::Claude, |a| a.provider),
        email: account.and_then(|a| a.email.clone()),
        window: WindowId::FiveHour,
        percent: Some(f64::from(limits.five_hour.percent)),
        resets_at: (now_ms() / 1000.0).floor() + 2.0 * 3600.0,
    };
    show_limit_notice(ctx, &notice);
}

/// The main window was minimized or hidden (false) or came back (true).
pub fn main_shown(shown: bool) {
    if let Some(h) = existing() {
        h.usage.set_active(shown);
    }
}

/// `refusalFor(channel)`: the answer once the app quits.
fn refusal(channel: &str, hub: &Hub) -> Value {
    match channel {
        "usage:refresh" => hub.usage.state().to_value(),
        "accounts:remove" | "accounts:clearSwapPending" | "accounts:removeCodex" => json!({ "ok": false }),
        "accounts:dismissNotice" | "accounts:dismissSwitch" => Value::Null,
        _ => json!({ "ok": false, "error": "invalid" }),
    }
}

/// Registers one gated channel: waits for `accounts_ready`, then answers the refusal once the app quits.
fn gated<F, Fut>(r: &mut RouterBuilder, ctx: &Arc<AppContext>, channel: &'static str, f: F)
where
    F: Fn(Arc<Hub>, Value) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = Result<Value, IpcError>> + Send + 'static,
{
    let c = ctx.clone();
    let f = Arc::new(f);
    r.invoke(channel, move |call| {
        let c = c.clone();
        let f = f.clone();
        let arg = call.arg(0).clone();
        async move {
            let h = hub(&c);
            if h.claude.quitting() {
                return Ok(refusal(channel, &h));
            }
            c.cells.gates.accounts_ready.wait().await;
            if h.claude.quitting() {
                return Ok(refusal(channel, &h));
            }
            f(h, arg).await
        }
    });
}

async fn blocking<T: Send + 'static>(h: &Arc<Hub>, f: impl FnOnce(&Arc<Hub>) -> T + Send + 'static) -> Result<T, IpcError> {
    let me = h.clone();
    tokio::task::spawn_blocking(move || f(&me))
        .await
        .map_err(|_| IpcError::Failed { command: "accounts".into(), message: "account work failed".into() })
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    // Open and ungated: the panel's first read must not wait for a recovery.
    let c = ctx.clone();
    r.invoke("usage:get", move |_call| {
        let h = hub(&c);
        async move { Ok(h.usage.state().to_value()) }
    });
    // The refresh button reads every account now (1.1.1), not only those past their spacing.
    gated(r, ctx, "usage:refresh", |h, _| async move { Ok(h.usage.refresh_now().await.to_value()) });
    gated(r, ctx, "accounts:remove", |h, id| async move {
        blocking(&h, move |h| h.remove_account(&id))
            .await?
            .map_err(|message| IpcError::Failed { command: "accounts:remove".into(), message })
    });
    gated(r, ctx, "accounts:makeMain", |h, id| async move { Ok(h.make_main_claude(&id).await.to_value()) });
    gated(r, ctx, "accounts:adoptCopy", |h, id| async move { blocking(&h, move |h| h.adopt_copy(&id)).await });
    gated(r, ctx, "accounts:swapPending", |h, _| async move { blocking(&h, |h| Value::Bool(h.swap_pending())).await });
    gated(r, ctx, "accounts:clearSwapPending", |h, _| async move { blocking(&h, |h| h.clear_swap_pending()).await });
    let c = ctx.clone();
    gated(r, ctx, "accounts:dismissNotice", move |h, id| {
        let c = c.clone();
        async move {
            let result = blocking(&h, move |h| dismiss_account_notice(&|n| h.claude.store.dismiss_notice(n), &id)).await;
            send_usage_state(&c);
            match result? {
                Ok(()) => Ok(Value::Null),
                Err(e) => Err(IpcError::Failed { command: "accounts:dismissNotice".into(), message: e.into() }),
            }
        }
    });
    // `{ provider, to? }`: `to` is an account key (e-mail) the user picked; without it the account with the most room.
    gated(r, ctx, "accounts:switchBest", |h, payload| async move {
        let provider = payload.get("provider").and_then(Value::as_str).and_then(Provider::parse);
        let Some(provider) = provider else { return Ok(SwapResult::fail(SwapError::Invalid).to_value()) };
        let to = payload.get("to").and_then(Value::as_str).filter(|t| t.encode_utf16().count() <= 160).map(str::to_lowercase);
        Ok(h.auto.switch_now(provider, to.as_deref()).await.to_value())
    });
    gated(r, ctx, "accounts:acceptSwitch", |h, _| async move { Ok(h.auto.accept_offer().await.to_value()) });
    gated(r, ctx, "accounts:dismissSwitch", |h, _| async move {
        h.auto.dismiss_offer();
        Ok(Value::Null)
    });
    gated(r, ctx, "accounts:makeMainCodex", |h, id| async move { Ok(h.make_main_codex(&id).await.to_value()) });
    gated(r, ctx, "accounts:removeCodex", |h, id| async move { blocking(&h, move |h| h.remove_codex(&id)).await });

    let c = ctx.clone();
    r.send("alerts:testLimit", move |_call| {
        let c = c.clone();
        async move { test_limit(&c) }
    });

    // usage.start() and the swap-pending push once the account work at start is done.
    let c = ctx.clone();
    ctx.startup_steps.on_accounts_ready("usage start", move || {
        let h = hub(&c);
        h.usage.start();
        h.push_swap_pending();
    });
    // Every main page load gets the swap-pending flag once the accounts are ready.
    let c = ctx.clone();
    ctx.on_main_page_started(move || {
        let c = c.clone();
        tauri::async_runtime::spawn(async move {
            c.cells.gates.accounts_ready.wait().await;
            hub(&c).push_swap_pending();
        });
    });
    // Settings: the limit warnings' reset timer follows the alerts; the polls follow the usage switch, the interval and
    // whether limit warnings are wanted.
    let last_key = Arc::new(Mutex::new(None::<String>));
    ctx.cells.on_state_changed("usage settings", move |previous, next| {
        let Some(h) = existing() else { return };
        let (prev, now) = (previous.get("settings"), next.get("settings"));
        if prev.and_then(|s| s.get("alerts")) != now.and_then(|s| s.get("alerts")) {
            h.alerts.settings_changed();
        }
        let now_key = usage_key(now.unwrap_or(&Value::Null));
        let mut last = last_key.lock();
        let before = last.clone().unwrap_or_else(|| usage_key(prev.unwrap_or(&Value::Null)));
        if before != now_key {
            h.usage.reschedule();
        }
        *last = Some(now_key);
    });
}

/// The quit: no further polls, timers or offers.
pub fn stop() {
    if let Some(h) = existing() {
        h.usage.stop();
        h.auto.dispose();
        h.alerts.dispose();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn card_ids_map_to_records() {
        assert_eq!(record_of_card("claude:abc"), "abc");
        assert_eq!(record_of_card("codex:x1"), "x1");
        assert_eq!(record_of_card("other"), "other");
    }

    #[test]
    fn usage_key_follows_the_three_settings() {
        let a = json!({ "showAiUsage": true, "usageIntervalMinutes": 5, "alerts": { "enabled": true, "limits": { "enabled": false } } });
        let b = json!({ "showAiUsage": true, "usageIntervalMinutes": 5, "alerts": { "enabled": true, "limits": { "enabled": true } } });
        assert_eq!(usage_key(&a), "true:5:false");
        assert_ne!(usage_key(&a), usage_key(&b));
    }
}
