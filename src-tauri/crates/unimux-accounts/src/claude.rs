//! The Claude account work of one app run, bound to its real dependencies (the account part of src/main/index.ts: the
//! store, the swap slot, the profile locks, the renewal with its persisted 429 windows, the reconcile of the live login, the
//! backup before a main re-login, the migration and the start-up recovery). The app builds one ([`ClaudeAccounts::new`]);
//! the usage polls (A5) call [`ClaudeAccounts::before_poll`] and [`ClaudeAccounts::refresh_claude`], the login manager (A4)
//! sets its probes with [`ClaudeAccounts::set_login_probes`] and calls [`ClaudeAccounts::before_main_login`].
//!
//! The blocking methods (file work, Claude Code's locks) must run on a blocking thread; [`ClaudeAccounts::blocking`] does that.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use parking_lot::Mutex;

use crate::activate::{
    ActivateDeps, RECOVERY_RETRY, activation_journal_pending, recover_activation_with_retry, recover_interrupted_activation,
};
use crate::cswap::{CswapRoster, Os, RealCswapFs, cswap_roster_path, cswap_wrote_since, read_cswap_roster};
use crate::identity::{AccountIdentity, LiveIdentityUnknown};
use crate::legacy_swap::recover_interrupted_swap;
use crate::live::{profile_expiry, profile_login_absent, read_signed_in_claude_identity};
use crate::locks::LockOptions;
use crate::migrate::{MigrationDeps, MigrationReport, migrate_accounts};
use crate::reconcile::{
    BackupOptions, LiveBackupFailed, LiveGuard, ReconcileDeps, reconcile_live, reconcile_when_idle, resync_outgoing_when_idle,
};
use crate::refresh::limits::RefreshLimits;
use crate::refresh::renew::{RefreshDeps, Renewer, TokenFetch};
use crate::refresh::{ProfileLocks, RefreshOutcome};
use crate::refs::{AccountRef, PanelInfo, RefsInput, accounts_panel_info, claude_refs};
use crate::results::Recovery;
use crate::resync::{ResyncDeps, ResyncError, ResyncResult, Seen, resync_active_backup};
use crate::rules::{family_refresh_allowed, saved_copy_dead};
use crate::slot::SwapSlot;
use crate::store::{AccountsStore, ManagedAccount};
use crate::swapfs::{RealSwapFs, SwapFs, env_get, swap_paths};

/// How the app run is set up.
pub struct ClaudeAccountsConfig {
    pub data_dir: PathBuf,
    pub home: PathBuf,
    /// The process environment (CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN, XDG_DATA_HOME).
    pub env: BTreeMap<String, String>,
    pub darwin: bool,
    /// `unimux/<version>`.
    pub user_agent: String,
    /// `MC_USAGE_CLAUDE_TOKEN_URL` (dev-overrides only).
    pub token_url: Option<String>,
    pub fetch: Arc<dyn TokenFetch>,
    /// The runtime the renewals run on (and the blocking bridge waits on).
    pub rt: tokio::runtime::Handle,
}

type Probe = Arc<dyn Fn() -> bool + Send + Sync>;
type DirProbe = Arc<dyn Fn(&Path) -> bool + Send + Sync>;

/// What the login managers (A4) tell: a login window flow runs, a main Claude login runs, a card is being signed in again or
/// its restore runs (its files must stay the snapshot's).
#[derive(Clone)]
pub struct LoginProbes {
    pub active: Probe,
    pub main_active: Probe,
    pub holds_profile: DirProbe,
}

impl Default for LoginProbes {
    fn default() -> Self {
        Self { active: Arc::new(|| false), main_active: Arc::new(|| false), holds_profile: Arc::new(|_| false) }
    }
}

pub struct ClaudeAccounts {
    cfg: ClaudeAccountsConfig,
    env: Arc<BTreeMap<String, String>>,
    pub store: Arc<AccountsStore>,
    pub slot: Arc<SwapSlot>,
    pub profiles: Arc<ProfileLocks>,
    renewer: Renewer,
    limits: Arc<RefreshLimits>,
    /// Live-file signatures of the previous reconcile per record (`resyncSeen`).
    seen: Seen,
    /// Set by a finished main Claude login until a reconcile has run (`ownLoginChange`).
    own_login_change: AtomicBool,
    /// cswap's roster, read before every poll (R6).
    roster: Mutex<CswapRoster>,
    login: Mutex<LoginProbes>,
    quitting: AtomicBool,
    retry_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

impl std::fmt::Debug for ClaudeAccounts {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ClaudeAccounts").field("data_dir", &self.cfg.data_dir).finish_non_exhaustive()
    }
}

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64)
}

impl ClaudeAccounts {
    pub fn new(cfg: ClaudeAccountsConfig) -> Arc<Self> {
        let profiles = Arc::new(ProfileLocks::new());
        let limits = Arc::new(RefreshLimits::new(Some(cfg.data_dir.join("refresh-limits.json")), Arc::new(now_ms)));
        let env = Arc::new(cfg.env.clone());
        Arc::new(Self {
            store: Arc::new(AccountsStore::new(cfg.data_dir.join("accounts"))),
            slot: Arc::new(SwapSlot::new()),
            renewer: Renewer::new(profiles.clone()),
            profiles,
            limits,
            env,
            seen: Seen::default(),
            own_login_change: AtomicBool::new(false),
            roster: Mutex::new(CswapRoster::Absent),
            login: Mutex::new(LoginProbes::default()),
            quitting: AtomicBool::new(false),
            retry_task: Mutex::new(None),
            cfg,
        })
    }

    /// A4: the login managers' probes.
    pub fn set_login_probes(&self, probes: LoginProbes) {
        *self.login.lock() = probes;
    }

    fn probes(&self) -> LoginProbes {
        self.login.lock().clone()
    }

    /// The app quits: no new account work starts (the retry timer stops, polls and recoveries end early).
    pub fn quit(&self) {
        self.quitting.store(true, Ordering::SeqCst);
        if let Some(task) = self.retry_task.lock().take() {
            task.abort();
        }
    }

    pub fn quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    /// `update:busy` probe: `(swap, login)`.
    pub fn busy(&self) -> (bool, bool) {
        (self.slot.is_running() || self.slot.is_codex_running(), (self.probes().active)())
    }

    /// Set by a finished main Claude login (the record that left was backed up by the app first).
    pub fn mark_own_login_change(&self) {
        self.own_login_change.store(true, Ordering::SeqCst);
    }

    pub fn backup_dir(&self) -> PathBuf {
        self.cfg.data_dir.join("accounts").join("swap-backup")
    }

    fn roster_path(&self) -> PathBuf {
        let os = if self.cfg.darwin { Os::Mac } else { Os::current() };
        cswap_roster_path(&self.cfg.home, env_get(&self.env, "XDG_DATA_HOME"), os)
    }

    /// cswap's roster as last read before a poll.
    pub fn roster(&self) -> CswapRoster {
        self.roster.lock().clone()
    }

    pub fn refresh_deps(&self) -> RefreshDeps {
        RefreshDeps {
            fetch: self.cfg.fetch.clone(),
            now: Arc::new(now_ms),
            token_url: self.cfg.token_url.clone(),
            delay: None,
            user_agent: Some(self.cfg.user_agent.clone()),
            limits: Some(self.limits.clone()),
            random: None,
        }
    }

    /// `renewProfile(dir)`: the renewal itself (callers apply the gates).
    pub fn renew_profile(&self, dir: &Path) -> BoxFuture<'static, RefreshOutcome> {
        self.renewer.refresh(dir, &self.refresh_deps())
    }

    /// `usageDeps.refreshClaude`: background renewals never write into a managed profile while a swap runs or is unresolved
    /// (`gateProfileRefresh`), only profiles whose token family lives nowhere else are renewed (`gateFamilyRefresh`, R6), nor
    /// a card being signed in again or whose restore runs.
    pub fn refresh_claude(&self, dir: &Path) -> BoxFuture<'static, RefreshOutcome> {
        if self.slot.is_running() || self.slot.is_unresolved() || self.slot.is_recovery_pending() {
            return async { RefreshOutcome::blocked() }.boxed();
        }
        let records = self.store.list();
        let allowed =
            family_refresh_allowed(&records, &|id| self.store.dir_of(id).ok(), self.store.live().as_ref(), &self.roster(), dir);
        if !allowed || (self.probes().holds_profile)(dir) {
            return async { RefreshOutcome::blocked() }.boxed();
        }
        self.renew_profile(dir)
    }

    /// `activateDeps()`: renewals inside go through the activation's own family rule with the roster read for it.
    pub fn activate_deps(self: &Arc<Self>) -> ActivateDeps {
        let me = self.clone();
        let roster_path = self.roster_path();
        let wrote_path = roster_path.clone();
        ActivateDeps {
            home: self.cfg.home.clone(),
            env: self.env.clone(),
            darwin: self.cfg.darwin,
            store: self.store.clone(),
            backup_dir: self.backup_dir(),
            now: Arc::new(now_ms),
            refresh: Arc::new(move |dir: &Path| me.cfg.rt.block_on(me.renew_profile(dir))),
            delay: Arc::new(std::thread::sleep),
            cswap: Arc::new(move || Ok(read_cswap_roster(&roster_path))),
            cswap_wrote_since: Some(Arc::new(move |identity: &AccountIdentity, roster: &CswapRoster, since: f64| {
                Ok(cswap_wrote_since(&wrote_path, roster, identity, since, &RealCswapFs))
            })),
            fs: Arc::new(RealSwapFs),
            locks: LockOptions::default(),
            slot: self.slot.clone(),
            profiles: self.profiles.clone(),
        }
    }

    /// `readLiveIdentity`: the live Claude login's identity; `Err` when a file cannot be read or parsed right now.
    pub fn read_live_identity(&self) -> Result<Option<AccountIdentity>, LiveIdentityUnknown> {
        read_signed_in_claude_identity(
            env_get(&self.env, "CLAUDE_CODE_OAUTH_TOKEN"),
            env_get(&self.env, "CLAUDE_CONFIG_DIR"),
            &self.cfg.home,
            self.cfg.darwin,
            &mut |p| crate::js::read_text(p),
        )
    }

    fn journal_pending(&self) -> std::io::Result<bool> {
        Ok(activation_journal_pending(&RealSwapFs, &self.backup_dir()))
    }

    /// Runs `f` with the real `reconcileDeps()`.
    fn with_reconcile_deps<T>(&self, f: impl FnOnce(&ReconcileDeps<'_>) -> T) -> T {
        let paths = swap_paths(&self.cfg.home, &self.env);
        let locks = LockOptions::default();
        let fs: &dyn SwapFs = &RealSwapFs;
        let resync_paths = paths.filter(|_| !self.cfg.darwin);
        // macOS keeps the live login in the Keychain: there is no file to back up.
        let resync = resync_paths.as_ref().map(|paths| {
            move |id: &str, identity: &AccountIdentity| -> Result<ResyncResult, ResyncError> {
                let d = ResyncDeps {
                    paths,
                    store: &self.store,
                    fs,
                    locks: &locks,
                    profiles: &self.profiles,
                    delay: &std::thread::sleep,
                    seen: Some(&self.seen),
                };
                resync_active_backup(&d, id, identity)
            }
        });
        let roster_path = self.roster_path();
        // The roster is read fresh: this runs on account changes only, never on every poll.
        let wrote = |identity: &AccountIdentity, since: f64| -> Result<bool, ()> {
            Ok(cswap_wrote_since(&roster_path, &read_cswap_roster(&roster_path), identity, since, &RealCswapFs))
        };
        // A record without any saved login has no copy to keep, so it gets no "signed out" notice either, like a dead copy.
        let dead = |record: &ManagedAccount| -> Result<bool, ()> {
            let Ok(dir) = self.store.dir_of(&record.id) else { return Ok(false) };
            Ok(saved_copy_dead(fs, &dir, Some(record)) || profile_login_absent(&dir))
        };
        let read = || self.read_live_identity().map_err(|_| ());
        let deps = ReconcileDeps {
            store: &self.store,
            read_live_identity: &read,
            resync: resync.as_ref().map(|r| r as &crate::reconcile::ResyncFn<'_>),
            cswap_wrote_since: Some(&wrote),
            saved_copy_dead: Some(&dead),
            now: &now_ms,
        };
        f(&deps)
    }

    /// `reconcileIdle()`: reconciles the live login holding the swap slot; skipped while a swap, a login or an activation
    /// journal is pending. Blocking.
    pub fn reconcile_idle(&self) -> bool {
        if self.quitting() {
            return false;
        }
        let login = self.probes();
        let unresolved = || self.slot.is_unresolved();
        let pending = || self.journal_pending();
        let guard = LiveGuard { swap_unresolved: &unresolved, login_active: &*login.active, journal_pending: Some(&pending) };
        reconcile_when_idle(&self.slot, &guard, || {
            // The own change is used by this one reconcile, also when it fails halfway.
            let own = self.own_login_change.swap(false, Ordering::SeqCst);
            self.with_reconcile_deps(|deps| reconcile_live(deps, own)).map(|_| ())
        })
        .unwrap_or(false)
    }

    /// `beforeMainLogin`: backs the live login up into its record before `claude auth login` replaces it. Blocking.
    pub fn before_main_login(&self) -> Result<(), LiveBackupFailed> {
        let unresolved = || self.slot.is_unresolved();
        let pending = || self.journal_pending();
        let own = self.own_login_change.load(Ordering::SeqCst);
        let applied = || self.own_login_change.store(false, Ordering::SeqCst);
        self.with_reconcile_deps(|deps| {
            crate::reconcile::backup_live_before_login(
                &self.slot,
                &unresolved,
                Some(&pending),
                deps,
                &BackupOptions {
                    delay: &std::thread::sleep,
                    tries: None,
                    gap: None,
                    own_change: own,
                    own_change_applied: Some(&applied),
                },
            )
        })
    }

    /// The account work before every usage poll (`beforeRun`, the Claude part): the roster, a pending activation recovery,
    /// then the reconcile, or during a main login only the backup of the outgoing live login. Blocking. The parked restores
    /// of the login manager (A4) run before this.
    pub fn before_poll(self: &Arc<Self>) {
        *self.roster.lock() = read_cswap_roster(&self.roster_path());
        // An activation whose recovery found Claude Code's locks busy is retried first; the live login is not reconciled
        // while its journal exists.
        if self.slot.is_recovery_pending() {
            self.retry_activation_recovery();
        }
        if self.quitting() {
            return;
        }
        if (self.probes().main_active)() {
            let unresolved = || self.slot.is_unresolved();
            let pending = || self.journal_pending();
            let _ = self.with_reconcile_deps(|deps| resync_outgoing_when_idle(&self.slot, &unresolved, Some(&pending), deps));
        } else {
            self.reconcile_idle();
        }
    }

    /// One more try of a version-2 recovery that found Claude Code's locks busy. Blocking.
    pub fn retry_activation_recovery(self: &Arc<Self>) -> Recovery {
        if self.quitting() {
            return Recovery::Locked;
        }
        recover_interrupted_activation(&self.activate_deps())
    }

    /// `recoverActivation()` at start: a version-2 journal first (3 tries, 1 s apart, 3 s lock waits), otherwise the 0.9.0
    /// recovery decides. Blocking.
    pub fn recover_at_start(self: &Arc<Self>) -> Recovery {
        let mut deps = self.activate_deps();
        deps.locks = LockOptions { timeout: Duration::from_secs(3), ..LockOptions::default() };
        let recovered = recover_activation_with_retry(&deps, 3, Duration::from_secs(1), &|| self.quitting());
        if recovered == Recovery::Legacy && !self.quitting() {
            return recover_interrupted_swap(&self.activate_deps());
        }
        recovered
    }

    /// The 30 s retry of a 'locked' recovery, also while the limits panel is off (needs the runtime). `after` runs after each
    /// try that did not stay locked (pushSwapPending).
    pub fn start_recovery_retry(self: &Arc<Self>, after: Arc<dyn Fn() + Send + Sync>) {
        if self.quitting() {
            return;
        }
        let me = self.clone();
        let _enter = self.cfg.rt.enter();
        let task = crate::activate::start_activation_recovery_retry(self.slot.clone(), RECOVERY_RETRY, move || {
            let me = me.clone();
            let after = after.clone();
            async move {
                let r = tokio::task::spawn_blocking(move || me.retry_activation_recovery()).await.unwrap_or(Recovery::Manual);
                if r != Recovery::Locked {
                    after();
                }
            }
        });
        *self.retry_task.lock() = Some(task);
    }

    /// `migrateAccounts(migrationDeps())` (0.9.0 -> 0.9.1, once). Blocking.
    pub fn migrate(&self) -> MigrationReport {
        let read_profile = |dir: &Path| -> Result<AccountIdentity, ()> {
            let dir = dir.to_string_lossy();
            Ok(crate::identity::read_claude_identity(Some(&dir), Path::new("")))
        };
        let read_live = || self.read_live_identity().map_err(|_| ());
        let read_expiry = |dir: &Path| -> Result<Option<f64>, ()> { Ok(profile_expiry(dir)) };
        migrate_accounts(&MigrationDeps {
            store: &self.store,
            read_profile_identity: &read_profile,
            read_live_identity: &read_live,
            read_expiry: &read_expiry,
            now: &now_ms,
        })
        .unwrap_or_default()
    }

    /// The Claude cards of the limits panel (`claudeRefs`).
    pub fn refs(&self) -> Vec<AccountRef> {
        let records = self.store.list();
        let roster = self.roster();
        let live = self.store.live();
        claude_refs(&RefsInput {
            records: &records,
            dir_of: &|id| self.store.dir_of(id).ok(),
            live: live.as_ref(),
            cswap: &roster,
            darwin: self.cfg.darwin,
        })
    }

    /// `accountsPanelInfo(accounts.list(), login.parkedIds())`.
    pub fn panel_info(&self, parked: &[String]) -> PanelInfo {
        accounts_panel_info(&self.store.list(), parked)
    }

    /// Runs a blocking method on the runtime's blocking pool.
    pub async fn blocking<T: Send + 'static>(self: &Arc<Self>, f: impl FnOnce(&Arc<Self>) -> T + Send + 'static) -> Option<T> {
        let me = self.clone();
        self.cfg.rt.spawn_blocking(move || f(&me)).await.ok()
    }
}
