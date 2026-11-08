//! A4: the login managers of this app run (index.ts `login` / `codexLogin` and their deps) and `auth:start` / `auth:cancel`.
//!
//! - [`LoginManager`]: `claude auth login --claudeai` for the main login, a new saved account or a saved card signed in
//!   again, and the main `codex login`; [`CodexLoginManager`]: `codex login` in a saved Codex card's own CODEX_HOME.
//! - Both start the command in an `auth:<uuid>` terminal of the pty service (cwd = home, 100 x 28, the settings' shell); the
//!   pty host keeps `auth:` terminals out of the cells, its crash fails the Claude login (`failActive('spawn')`).
//! - The probes go to [`ClaudeAccounts::set_login_probes`] (update:busy, the reconcile's guard, the renewal's `holdsProfile`).
//! - A5 calls [`Logins::retry_parked_restores`] before every poll, reads [`Logins::parked_ids`] for the panel and sets
//!   [`set_usage_refresh`] (the account a finished login changed is read at once).
//!
//! Nothing here logs or sends a token: the managers only ever see fingerprints and identities.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use futures::FutureExt;
use parking_lot::Mutex;
use serde_json::{Value, json};
use unimux_accounts::claude::{ClaudeAccounts, LoginProbes};
use unimux_accounts::codex::CodexIdentity;
use unimux_accounts::codex_activate::{CodexActivateDeps, read_live_codex_identity};
use unimux_accounts::codex_store::CodexAccountsStore;
use unimux_accounts::identity::{
    AccountIdentity, Custody, IdentityMatch, compare_identity, custody_of, identity_fields, read_claude_identity,
    read_managed_identity,
};
use unimux_accounts::live::{LoginPresence, claude_login_presence};
use unimux_accounts::login::claude::{BeforeMainError, LoginDeps, LoginManager};
use unimux_accounts::login::codex::{CodexLoginDeps, CodexLoginManager};
use unimux_accounts::login::creds::{ClaudeSource, Keychain, claude_fingerprint, read_codex_credentials};
use unimux_accounts::login::snapshot::{self, ProfileSnapshot};
use unimux_accounts::login::{Fut, KnownIdentity, LoginChange, LoginStartResult, LoginState, LoginTimings, Provider, PtySpec};
use unimux_accounts::rules::{GuardDeps, login_block};
use unimux_accounts::store::AccountsStore;
use unimux_accounts::swapfs::RealSwapFs;
use unimux_agents::cli::{CliDetector, CliId, CliState, ExecRequest, GetOptions, Os};
use unimux_ipc::{Events, RouterBuilder};
use unimux_pty::manager::SpawnRequest;
use unimux_pty::shell::ShellKind;
use unimux_state::StateController;
use zeroize::Zeroizing;

use crate::context::AppContext;
use crate::lifecycle::wind_down::phase;

/// The usage refresh of one subject (`usage.refresh(true, true, subject)`), set by A5.
type UsageRefresh = Arc<dyn Fn(String) + Send + Sync>;

static LOGINS: OnceLock<Arc<Logins>> = OnceLock::new();
static CODEX_STORE: OnceLock<Arc<CodexAccountsStore>> = OnceLock::new();
static USAGE_REFRESH: Mutex<Option<UsageRefresh>> = Mutex::new(None);

/// How long a spawn may wait for the CLI detection (`CLI_WAIT_MS`).
const CLI_WAIT: u64 = unimux_agents::cli::CLI_WAIT_MS;
/// `execText`'s timeout.
const EXEC_TIMEOUT_MS: u64 = 15_000;
/// The login terminal's size (1.1.4).
const COLS: u16 = 100;
const ROWS: u16 = 28;

/// A5: what a finished login changed is read at once (`usage.refresh(true, true, subject)`).
pub fn set_usage_refresh(refresh: impl Fn(String) + Send + Sync + 'static) {
    *USAGE_REFRESH.lock() = Some(Arc::new(refresh));
}

fn usage_refresh(subject: String) {
    let refresh = USAGE_REFRESH.lock().clone();
    if let Some(refresh) = refresh {
        refresh(subject);
    }
}

/// The saved Codex accounts (`<data>/codex-accounts`), one store per app run (A5's make main / remove use it too).
pub fn codex_accounts(ctx: &Arc<AppContext>) -> Arc<CodexAccountsStore> {
    CODEX_STORE.get_or_init(|| Arc::new(CodexAccountsStore::new(ctx.data_dir.join("codex-accounts")))).clone()
}

/// The two login managers of this app run.
pub struct Logins {
    pub claude: Arc<LoginManager>,
    pub codex: Arc<CodexLoginManager>,
}

impl Logins {
    /// `login.isActive() || codexLogin.isActive()`.
    pub fn any_active(&self) -> bool {
        self.claude.is_active() || self.codex.is_active()
    }

    /// `login.retryParkedRestores(waitMs)` (A5's poll, before the reconcile).
    pub async fn retry_parked_restores(&self, wait: Option<Duration>) {
        self.claude.retry_parked_restores(wait).await;
    }

    /// `login.parkedIds()` (the accounts panel, A5).
    pub fn parked_ids(&self) -> Vec<String> {
        self.claude.parked_ids()
    }

    /// `startLogin(request)` of the accounts IPC.
    pub async fn start(&self, accounts: &ClaudeAccounts, request: &Value) -> LoginStartResult {
        let Some(req) = request.as_object() else { return LoginStartResult::refused("invalid request") };
        let busy = || accounts.slot.is_running() || accounts.slot.is_codex_running();
        // 1.1.2: a saved Codex account (new or signed in again) logs in into its own profile, never into ~/.codex.
        if req.get("provider").and_then(Value::as_str) == Some("codex")
            && let Some(target) = req.get("target").filter(|t| t.is_object())
            && target.get("type").and_then(Value::as_str) != Some("main")
        {
            if busy() {
                return LoginStartResult::refused("busy");
            }
            if self.claude.is_active() {
                self.claude.dispose();
            }
            return self.codex.start(target).await;
        }
        if self.codex.is_active() {
            self.codex.dispose();
        }
        let block = {
            let swap_running = || accounts.slot.is_running();
            let backup_dir = accounts.backup_dir();
            let swap_pending = || unimux_accounts::legacy_swap::has_pending_swap(&RealSwapFs, &backup_dir);
            let pending_now = || accounts.slot.is_unresolved() || accounts.slot.is_recovery_pending();
            let read_only = || accounts.store.read_only();
            let deps = GuardDeps {
                swap_running: &swap_running,
                swap_pending: &swap_pending,
                swap_pending_now: Some(&pending_now),
                read_only: Some(&read_only),
            };
            login_block(&deps, request)
        };
        match block {
            Some(error) => LoginStartResult::refused(error),
            None => self.claude.start(request).await,
        }
    }

    /// `cancelLogin(id)`.
    pub fn cancel(&self, id: &Value) {
        if let Some(id) = id.as_str() {
            self.claude.cancel(id);
            self.codex.cancel(id);
        }
    }
}

/// The login managers, made on first use on the async runtime.
pub fn logins(ctx: &Arc<AppContext>) -> Arc<Logins> {
    LOGINS
        .get_or_init(|| {
            let accounts = super::claude_accounts(ctx);
            let detector = crate::commands::agents::cli_detector(ctx);
            let env: BTreeMap<String, String> = std::env::vars().collect();
            let shared = Arc::new(Shared {
                accounts: accounts.clone(),
                events: ctx.events.clone(),
                state: ctx.state.clone(),
                detector,
                keychain: Arc::new(Keychain::system()),
                home: unimux_core::home::home_dir(),
                darwin: cfg!(target_os = "macos"),
                env,
            });
            let rt = tauri::async_runtime::handle().inner().clone();
            let claude = LoginManager::new(Arc::new(ClaudeDeps(shared.clone())), LoginTimings::CLAUDE, rt.clone());
            let codex_deps = CodexDeps { shared, store: codex_accounts(ctx) };
            let codex = CodexLoginManager::new(Arc::new(codex_deps), LoginTimings::CODEX, rt);
            let logins = Arc::new(Logins { claude, codex });
            let (c, x) = (logins.claude.clone(), logins.codex.clone());
            let (m, h) = (logins.claude.clone(), logins.claude.clone());
            accounts.set_login_probes(LoginProbes {
                active: Arc::new(move || c.is_active()),
                codex_active: Arc::new(move || x.is_active()),
                main_active: Arc::new(move || m.is_main_active()),
                holds_profile: Arc::new(move |dir: &Path| h.holds_profile(dir)),
            });
            // A5: the polls, the panel, make main / the automatic switch and the card removal ask the managers.
            let (a, p, r, cc, xc) = (logins.clone(), logins.clone(), logins.clone(), logins.clone(), logins.clone());
            super::usage::set_login_hooks(super::usage::LoginHooks {
                any_active: Arc::new(move || a.any_active()),
                parked_ids: Arc::new(move || p.parked_ids()),
                retry_parked_restores: Arc::new(move |wait| {
                    let r = r.clone();
                    async move { r.retry_parked_restores(Some(wait)).await }.boxed()
                }),
                cancel_for: Arc::new(move |id: &str| cc.claude.cancel_for(id)),
                codex_cancel_for: Arc::new(move |id: &str| xc.codex.cancel_for(id)),
            });
            logins
        })
        .clone()
}

/// What both managers' deps share.
struct Shared {
    accounts: Arc<ClaudeAccounts>,
    events: Arc<Events>,
    state: Arc<StateController>,
    detector: Arc<CliDetector>,
    keychain: Arc<Keychain>,
    home: PathBuf,
    darwin: bool,
    /// `process.env` (the credential sources read CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CONFIG_DIR and CODEX_HOME from it).
    env: BTreeMap<String, String>,
}

impl Shared {
    fn env_var(&self, key: &str) -> Option<&str> {
        self.env.get(key).map(String::as_str)
    }

    /// `usageDeps.credentials` for Claude: the live login.
    fn live_claude_source(&self) -> ClaudeSource {
        ClaudeSource {
            env_token: self.env_var("CLAUDE_CODE_OAUTH_TOKEN").map(str::to_string),
            config_dir: self.env_var("CLAUDE_CONFIG_DIR").map(str::to_string),
            home: self.home.clone(),
            keychain: self.darwin,
        }
    }

    /// `usageDeps.codexHome()`: CODEX_HOME (trimmed) or ~/.codex.
    fn live_codex_home(&self) -> PathBuf {
        match self.env_var("CODEX_HOME").map(str::trim).filter(|d| !d.is_empty()) {
            Some(dir) => PathBuf::from(dir),
            None => self.home.join(".codex"),
        }
    }

    fn shell(&self) -> ShellKind {
        let state = self.state.get();
        let named = state.get("settings").and_then(|s| s.get("shell")).and_then(Value::as_str).and_then(ShellKind::parse);
        named.unwrap_or(if cfg!(windows) { ShellKind::Pwsh } else { ShellKind::Zsh })
    }

    /// `ptyHost.spawn({ id, cwd: homedir(), cols: 100, rows: 28, env, shell: settings.shell, command })`. False when the
    /// pty service dropped it (stopped after too many crashes).
    fn spawn(&self, spec: PtySpec, base: Vec<(String, String)>) -> bool {
        let mut req = SpawnRequest::new(spec.id, self.home.clone(), self.shell());
        req.cols = COLS;
        req.rows = ROWS;
        req.env = with_vars(base, spec.env);
        req.command = Some(spec.command);
        crate::commands::pty::service().spawn(req, false)
    }

    fn emit(&self, state: &LoginState) {
        self.events.send("auth:state", vec![state.to_value()]);
    }
}

/// `{ ...env, ...extra }`: a key already there keeps its place, a new one goes to the end.
fn with_vars(mut env: Vec<(String, String)>, extra: Vec<(String, String)>) -> Vec<(String, String)> {
    for (key, value) in extra {
        match env.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => env.push((key, value)),
        }
    }
    env
}

/// `cleanEnv(process.env)`.
fn clean_process_env() -> Vec<(String, String)> {
    unimux_agents::cli::status::clean_env(&unimux_agents::cli::system::process_env())
}

fn cli_of(provider: Provider) -> CliId {
    match provider {
        Provider::Claude => CliId::Claude,
        Provider::Codex => CliId::Codex,
    }
}

/// `execText(command, args, env)`: `claude` runs from where it was detected, with a PATH that has its directory; stdout, or
/// `None` when it failed or ran past 15 s. Windows: through cmd.exe like `execFile(..., { shell: true })` (the arguments
/// are fixed words, the file is the detected path quoted for cmd.exe or the bare command).
async fn exec_text(detector: Arc<CliDetector>, command: String, args: Vec<String>, env: Vec<(String, String)>) -> Option<String> {
    let cli = match command.as_str() {
        "claude" => Some(CliId::Claude),
        "codex" => Some(CliId::Codex),
        _ => None,
    };
    let status = match cli {
        Some(cli) => Some(detector.get(cli, GetOptions { wait_ms: CLI_WAIT, force: false }).await),
        None => None,
    };
    let os = Os::current();
    let file = unimux_agents::cli::status::resolve_exec_file(&command, status.as_ref(), os);
    let run_env = detector.apply_env(unimux_agents::cli::status::clean_env(&env), cli).await;
    let request = if os.is_windows() {
        let comspec = std::env::var("ComSpec").ok().filter(|c| !c.is_empty()).unwrap_or_else(|| "cmd.exe".into());
        let line = std::iter::once(file).chain(args).collect::<Vec<_>>().join(" ");
        ExecRequest {
            file: comspec,
            args: vec!["/d".into(), "/s".into(), "/c".into(), format!("\"{line}\"")],
            timeout_ms: EXEC_TIMEOUT_MS,
            env: run_env,
            verbatim: true,
        }
    } else {
        ExecRequest { file, args, timeout_ms: EXEC_TIMEOUT_MS, env: run_env, verbatim: false }
    };
    let result = unimux_agents::cli::system::run_program(request).await;
    result.ok.then_some(result.stdout)
}

/// Runs a blocking step (the profile lock, Claude Code's locks) off the async threads.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    tokio::task::spawn_blocking(f).await.ok()
}

struct ClaudeDeps(Arc<Shared>);

impl LoginDeps for ClaudeDeps {
    fn store(&self) -> &AccountsStore {
        &self.0.accounts.store
    }

    // The CLI runs from where it was detected (an install made after the app started is not on the app's own PATH yet).
    fn spawn_pty(&self, spec: PtySpec) -> Fut<Result<(), ()>> {
        let s = self.0.clone();
        async move {
            let cli = if spec.command.starts_with("codex") { CliId::Codex } else { CliId::Claude };
            let env = s.detector.apply_env(clean_process_env(), Some(cli)).await;
            if s.spawn(spec, env) { Ok(()) } else { Err(()) }
        }
        .boxed()
    }

    fn cli_missing(&self, provider: Provider) -> Fut<bool> {
        let detector = self.0.detector.clone();
        async move {
            let status = detector.get(cli_of(provider), GetOptions { wait_ms: CLI_WAIT, force: false }).await;
            status.state == CliState::Missing
        }
        .boxed()
    }

    fn has_main_login(&self) -> Option<Fut<Result<bool, ()>>> {
        let s = self.0.clone();
        Some(
            async move {
                if s.darwin {
                    return Ok(true);
                }
                let source = s.live_claude_source();
                let presence = blocking(move || {
                    claude_login_presence(source.env_token.as_deref(), source.config_dir.as_deref(), &source.home, &mut |p| {
                        std::fs::read_to_string(p)
                    })
                })
                .await
                .ok_or(())?;
                Ok(presence != LoginPresence::Absent)
            }
            .boxed(),
        )
    }

    fn kill_pty(&self, id: &str) {
        crate::commands::pty::service().kill(id);
    }

    fn fingerprint(&self, provider: Provider, config_dir: Option<PathBuf>) -> Fut<Result<Option<String>, ()>> {
        let s = self.0.clone();
        async move {
            match provider {
                Provider::Claude => {
                    let source = match &config_dir {
                        Some(dir) => ClaudeSource::profile(dir),
                        None => s.live_claude_source(),
                    };
                    Ok(claude_fingerprint(&source, &s.keychain).await)
                }
                Provider::Codex => {
                    let home = s.live_codex_home();
                    Ok(blocking(move || read_codex_credentials(&home)).await.flatten().and_then(|c| c.fingerprint))
                }
            }
        }
        .boxed()
    }

    fn reset_credential_cache(&self) {
        self.0.keychain.reset();
    }

    fn identity(&self, provider: Provider, config_dir: Option<PathBuf>) -> Fut<Result<AccountIdentity, ()>> {
        let s = self.0.clone();
        async move {
            match (provider, config_dir) {
                (Provider::Codex, _) => {
                    let home = s.live_codex_home();
                    let email = blocking(move || read_codex_credentials(&home))
                        .await
                        .flatten()
                        .and_then(|c| c.email)
                        .filter(|e| !e.is_empty());
                    Ok(AccountIdentity { email, ..AccountIdentity::default() })
                }
                (Provider::Claude, Some(dir)) => {
                    let detector = s.detector.clone();
                    let managed = read_managed_identity(&dir, &s.env, move |command, args, env| {
                        exec_text(detector, command, args, env.into_iter().collect())
                    })
                    .await;
                    Ok(managed.identity)
                }
                (Provider::Claude, None) => {
                    let config_dir = s.env_var("CLAUDE_CONFIG_DIR").map(str::to_string);
                    let home = s.home.clone();
                    blocking(move || read_claude_identity(config_dir.as_deref(), &home)).await.ok_or(())
                }
            }
        }
        .boxed()
    }

    // An unreadable live login must not hide the saved accounts from the duplicate check. An identity in ~/.claude.json
    // without a Claude login next to it (Claude Desktop, an earlier sign-in) is nobody signed in (readSignedInClaudeIdentity).
    fn known_identities(&self) -> Fut<Result<Vec<KnownIdentity>, ()>> {
        let s = self.0.clone();
        async move {
            blocking(move || {
                let accounts = &s.accounts;
                let live = accounts.read_live_identity().ok().flatten();
                let live_record_id = live.as_ref().and_then(|_| accounts.store.live()).and_then(|l| l.record_id);
                let mut known: Vec<KnownIdentity> = Vec::new();
                if let Some(live) = &live {
                    known.push(KnownIdentity { identity: live.clone(), record_id: None, live: true, empty: false });
                }
                for record in accounts.store.list() {
                    if custody_of(record.custody) == Custody::Quarantined {
                        continue;
                    }
                    let holds_live = live.as_ref().is_some_and(|live| {
                        live_record_id.as_deref() == Some(record.id.as_str())
                            || compare_identity(&record.identity, live) == IdentityMatch::Same
                    });
                    // A profile that holds no login at all (only a cleanly missing file counts) and is not the live login is
                    // no account.
                    let empty = !holds_live
                        && accounts.store.dir_of(&record.id).ok().is_some_and(|dir| {
                            let dir = dir.to_string_lossy().into_owned();
                            claude_login_presence(None, Some(&dir), Path::new(""), &mut |p| std::fs::read_to_string(p))
                                == LoginPresence::Absent
                        });
                    known.push(KnownIdentity {
                        identity: identity_fields(&record.identity),
                        record_id: Some(record.id.clone()),
                        live: holds_live,
                        empty,
                    });
                }
                known
            })
            .await
            .ok_or(())
        }
        .boxed()
    }

    fn snapshot_profile(&self, dir: PathBuf) -> Fut<Result<ProfileSnapshot, ()>> {
        let profiles = self.0.accounts.profiles.clone();
        async move { blocking(move || snapshot::snapshot_profile(&profiles, &dir).map_err(|_| ())).await.unwrap_or(Err(())) }
            .boxed()
    }

    fn restore_profile(&self, dir: PathBuf, snapshot: Arc<ProfileSnapshot>) -> Fut<Result<(), ()>> {
        let profiles = self.0.accounts.profiles.clone();
        async move {
            blocking(move || snapshot::restore_profile(&profiles, &dir, &snapshot).map_err(|_| ())).await.unwrap_or(Err(()))
        }
        .boxed()
    }

    fn identity_rewritten(&self, dir: PathBuf, snapshot: Arc<ProfileSnapshot>) -> Fut<Result<bool, ()>> {
        async move { blocking(move || snapshot::identity_rewritten(&dir, &snapshot).map_err(|_| ())).await.unwrap_or(Err(())) }
            .boxed()
    }

    // The live login is backed up into its record before `claude auth login` replaces it (nothing is dropped); refused (the
    // login does not start) unless that backup is current.
    fn before_main_login(&self) -> Fut<Result<(), BeforeMainError>> {
        let accounts = self.0.accounts.clone();
        async move {
            match blocking(move || accounts.before_main_login()).await {
                Some(Ok(())) => Ok(()),
                Some(Err(e)) => Err(BeforeMainError::Backup(e)),
                None => Err(BeforeMainError::Other),
            }
        }
        .boxed()
    }

    fn emit(&self, state: LoginState) {
        self.0.emit(&state);
    }

    fn on_changed(&self, change: LoginChange) {
        let accounts = self.0.accounts.clone();
        if change.own_change {
            accounts.mark_own_login_change();
        }
        // The account the login was about is read at once, whatever its read spacing (`claude:main` = the live Claude card).
        let subject = change.subject();
        tauri::async_runtime::spawn(async move {
            if change.own_change {
                let _ = blocking(move || accounts.reconcile_idle()).await;
            }
            usage_refresh(subject);
        });
    }

    fn profiles_supported(&self) -> bool {
        // Claude profiles need files for the login (macOS keeps it in the Keychain).
        !self.0.darwin
    }

    fn swap_running(&self) -> bool {
        self.0.accounts.slot.is_running()
    }
}

struct CodexDeps {
    shared: Arc<Shared>,
    store: Arc<CodexAccountsStore>,
}

impl CodexLoginDeps for CodexDeps {
    fn store(&self) -> &CodexAccountsStore {
        &self.store
    }

    fn spawn_pty(&self, spec: PtySpec) -> bool {
        self.shared.spawn(spec, clean_process_env())
    }

    fn kill_pty(&self, id: &str) {
        crate::commands::pty::service().kill(id);
    }

    fn fingerprint(&self, dir: PathBuf) -> Fut<Result<Option<String>, ()>> {
        async move { Ok(blocking(move || read_codex_credentials(&dir)).await.flatten().and_then(|c| c.fingerprint)) }.boxed()
    }

    fn identity(&self, dir: PathBuf) -> Fut<Result<Option<CodexIdentity>, ()>> {
        async move { Ok(blocking(move || read_codex_credentials(&dir)).await.flatten().and_then(|c| c.identity())) }.boxed()
    }

    fn live_identity(&self) -> Option<CodexIdentity> {
        let shared = self.shared.clone();
        let deps = CodexActivateDeps {
            store: self.store.clone(),
            live_home: Arc::new(move || shared.live_codex_home()),
            now: Arc::new(|| unimux_core::time::now_ms() as f64),
            read_text: None,
            write_text: None,
            slot: self.shared.accounts.slot.clone(),
        };
        read_live_codex_identity(&deps)
    }

    fn read_auth(&self, dir: PathBuf) -> Fut<Result<Option<Zeroizing<String>>, ()>> {
        async move { Ok(blocking(move || std::fs::read_to_string(dir.join("auth.json")).ok().map(Zeroizing::new)).await.flatten()) }
            .boxed()
    }

    fn restore_auth(&self, dir: PathBuf, raw: Option<Zeroizing<String>>) -> Fut<Result<(), ()>> {
        async move {
            blocking(move || {
                let path = dir.join("auth.json");
                match raw {
                    None => match std::fs::remove_file(&path) {
                        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(()),
                        _ => Ok(()),
                    },
                    Some(raw) => {
                        let options = unimux_core::atomic_write::AtomicWriteOptions {
                            mode: Some(0o600),
                            ..unimux_core::atomic_write::AtomicWriteOptions::default()
                        };
                        unimux_core::atomic_write::atomic_write(&path, raw.as_bytes(), &options).map_err(|_| ())
                    }
                }
            })
            .await
            .unwrap_or(Err(()))
        }
        .boxed()
    }

    fn busy(&self) -> bool {
        self.shared.accounts.slot.is_running() || self.shared.accounts.slot.is_codex_running()
    }

    fn emit(&self, state: LoginState) {
        self.shared.emit(&state);
    }

    fn on_changed(&self, record_id: &str) {
        usage_refresh(format!("codex:{record_id}"));
    }
}

/// `auth:start` / `auth:cancel`, the pty host's crash hook and the quit's dispose.
pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    // auth:start (guarded by the router: app windows only). It waits for the startup recovery and the migration; once the
    // app quits it answers the refusal of a foreign sender (accountsIpc.ts `registerAccountIpc`).
    let c = ctx.clone();
    r.invoke("auth:start", move |call| {
        let c = c.clone();
        async move {
            let refused = || json!({"ok": false, "error": "invalid request"});
            let ready = c.cells.gates.accounts_ready.wait();
            super::usage::after_recovery(
                || c.lifecycle.is_quitting(),
                ready,
                refused,
                || async {
                    let accounts = super::claude_accounts(&c);
                    let request = call.arg(0).clone();
                    Ok(logins(&c).start(&accounts, &request).await.to_value())
                },
            )
            .await
        }
    });

    // auth:cancel: still runs while quitting (it only stops work).
    let c = ctx.clone();
    r.send("auth:cancel", move |call| {
        let c = c.clone();
        async move {
            c.cells.gates.accounts_ready.wait().await;
            let id = call.arg(0).clone();
            logins(&c).cancel(&id);
        }
    });

    // The pty service crashed: the login terminal is gone (`login.failActive('spawn')`; the Codex login runs until its timeout,
    // as in 1.1.4).
    crate::commands::pty::host().on_crashed("login", || {
        if let Some(l) = LOGINS.get() {
            l.claude.fail_active();
        }
    });

    // The quit: a running Claude login ends (its card's login is put back).
    ctx.lifecycle.wind_down.register(phase::STOP_SERVICES, "login dispose", Duration::from_secs(1), || async {
        if let Some(l) = LOGINS.get() {
            l.claude.dispose();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extra_variables_override_in_place_and_new_ones_go_last() {
        let base = vec![("PATH".to_string(), "p".to_string()), ("CLAUDE_CONFIG_DIR".to_string(), "old".to_string())];
        let extra = vec![("CLAUDE_CONFIG_DIR".to_string(), "new".to_string()), ("ANTHROPIC_API_KEY".to_string(), String::new())];
        assert_eq!(
            with_vars(base, extra),
            vec![
                ("PATH".to_string(), "p".to_string()),
                ("CLAUDE_CONFIG_DIR".to_string(), "new".to_string()),
                ("ANTHROPIC_API_KEY".to_string(), String::new()),
            ]
        );
    }
}
