//! Ports of the main cases of test/auth-login.test.ts (LoginManager) and the Codex login manager, on a paused tokio clock.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use futures::FutureExt;
use parking_lot::Mutex;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::claude::{BeforeMainError, LoginDeps, LoginManager};
use super::codex::{CodexLoginDeps, CodexLoginManager};
use super::snapshot::{ProfileSnapshot, identity_rewritten, restore_profile, snapshot_profile};
use super::*;
use crate::codex::{CodexAccount, CodexIdentity};
use crate::codex_store::CodexAccountsStore;
use crate::identity::{AccountIdentity, Custody, TokenFamily};
use crate::reconcile::LiveBackupFailed;
use crate::refresh::ProfileLocks;
use crate::store::{AccountsStore, ManagedAccount};

const SECRET: &str = "fp-secret-123";

fn ident(email: Option<&str>, uuid: Option<&str>) -> AccountIdentity {
    AccountIdentity { email: email.map(str::to_string), account_uuid: uuid.map(str::to_string), ..AccountIdentity::default() }
}

struct Fake {
    store: AccountsStore,
    fp: Mutex<Option<String>>,
    identity: Mutex<AccountIdentity>,
    known: Mutex<Vec<KnownIdentity>>,
    restore_fails: AtomicBool,
    rewritten: AtomicBool,
    profiles_supported: bool,
    backup: Mutex<Option<BeforeMainError>>,
    states: Mutex<Vec<LoginState>>,
    spawned: Mutex<Vec<PtySpec>>,
    killed: Mutex<Vec<String>>,
    changed: Mutex<Vec<LoginChange>>,
    restores: AtomicUsize,
    snapshots: AtomicUsize,
    identity_calls: AtomicUsize,
    /// Answers of the next identity reads (front first) before `identity`.
    identity_seq: Mutex<Vec<AccountIdentity>>,
    spawn_fails: AtomicBool,
    snapshot_fails: AtomicBool,
    /// When set, a fingerprint read waits for a permit.
    fp_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
    fp_dirs: Mutex<Vec<Option<PathBuf>>>,
    /// When set, a restore waits for a permit.
    restore_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
    /// When set, a restore takes this long and then fails (Claude Code holds the locks).
    restore_slow_fail: Mutex<Option<Duration>>,
    /// When non-zero, the identity counts as rewritten from this call on.
    rewritten_from: AtomicUsize,
    rewritten_calls: AtomicUsize,
    /// What ran, in order (`backup`, `spawn`, `snapshot`, `restore`).
    order: Mutex<Vec<&'static str>>,
    resets: AtomicUsize,
    cli_missing: AtomicBool,
    /// `hasMainLogin`: `None` = not asked.
    has_main: Mutex<Option<bool>>,
    /// When set, starting the terminal waits for a permit.
    spawn_gate: Mutex<Option<Arc<tokio::sync::Semaphore>>>,
    swap_running: AtomicBool,
}

impl Fake {
    fn new(root: &Path) -> Arc<Self> {
        Arc::new(Self {
            identity_seq: Mutex::new(Vec::new()),
            spawn_fails: AtomicBool::new(false),
            snapshot_fails: AtomicBool::new(false),
            fp_gate: Mutex::new(None),
            fp_dirs: Mutex::new(Vec::new()),
            restore_gate: Mutex::new(None),
            restore_slow_fail: Mutex::new(None),
            rewritten_from: AtomicUsize::new(0),
            rewritten_calls: AtomicUsize::new(0),
            order: Mutex::new(Vec::new()),
            resets: AtomicUsize::new(0),
            cli_missing: AtomicBool::new(false),
            has_main: Mutex::new(None),
            spawn_gate: Mutex::new(None),
            swap_running: AtomicBool::new(false),
            store: AccountsStore::new(root.join("accounts")),
            fp: Mutex::new(None),
            identity: Mutex::new(AccountIdentity {
                email: Some("New@Example.com".into()),
                org: Some("Org".into()),
                ..AccountIdentity::default()
            }),
            known: Mutex::new(Vec::new()),
            restore_fails: AtomicBool::new(false),
            rewritten: AtomicBool::new(true),
            profiles_supported: true,
            backup: Mutex::new(None),
            states: Mutex::new(Vec::new()),
            spawned: Mutex::new(Vec::new()),
            killed: Mutex::new(Vec::new()),
            changed: Mutex::new(Vec::new()),
            restores: AtomicUsize::new(0),
            snapshots: AtomicUsize::new(0),
            identity_calls: AtomicUsize::new(0),
        })
    }

    fn statuses(&self) -> Vec<LoginStatus> {
        self.states.lock().iter().map(|s| s.status).collect()
    }

    fn card(&self, identity: AccountIdentity, custody: Custody, family: TokenFamily) -> (String, PathBuf) {
        let (id, dir) = self.store.prepare().unwrap();
        self.store
            .commit(&ManagedAccount {
                id: id.clone(),
                added_at: 1.0,
                identity,
                custody: Some(custody),
                family: Some(family),
                ..ManagedAccount::default()
            })
            .unwrap();
        (id, dir)
    }
}

impl LoginDeps for Fake {
    fn store(&self) -> &AccountsStore {
        &self.store
    }
    fn spawn_pty(&self, spec: PtySpec) -> Fut<Result<(), ()>> {
        self.order.lock().push("spawn");
        self.spawned.lock().push(spec);
        let fails = self.spawn_fails.load(Ordering::SeqCst);
        let gate = self.spawn_gate.lock().clone();
        async move {
            if let Some(g) = gate {
                g.acquire().await.unwrap().forget();
            }
            if fails { Err(()) } else { Ok(()) }
        }
        .boxed()
    }
    fn cli_missing(&self, _provider: Provider) -> Fut<bool> {
        let missing = self.cli_missing.load(Ordering::SeqCst);
        async move { missing }.boxed()
    }
    fn swap_running(&self) -> bool {
        self.swap_running.load(Ordering::SeqCst)
    }
    fn has_main_login(&self) -> Option<Fut<Result<bool, ()>>> {
        let has = (*self.has_main.lock())?;
        Some(async move { Ok(has) }.boxed())
    }
    fn kill_pty(&self, id: &str) {
        self.killed.lock().push(id.to_string());
    }
    fn fingerprint(&self, _provider: Provider, config_dir: Option<PathBuf>) -> Fut<Result<Option<String>, ()>> {
        self.fp_dirs.lock().push(config_dir);
        let gate = self.fp_gate.lock().clone();
        let fp = self.fp.lock().clone();
        async move {
            if let Some(g) = gate {
                g.acquire().await.unwrap().forget();
            }
            Ok(fp)
        }
        .boxed()
    }
    fn reset_credential_cache(&self) {
        self.resets.fetch_add(1, Ordering::SeqCst);
    }
    fn identity(&self, _provider: Provider, _config_dir: Option<PathBuf>) -> Fut<Result<AccountIdentity, ()>> {
        self.identity_calls.fetch_add(1, Ordering::SeqCst);
        let mut seq = self.identity_seq.lock();
        let id = if seq.is_empty() { self.identity.lock().clone() } else { seq.remove(0) };
        async move { Ok(id) }.boxed()
    }
    fn known_identities(&self) -> Fut<Result<Vec<KnownIdentity>, ()>> {
        let known = self.known.lock().clone();
        async move { Ok(known) }.boxed()
    }
    fn snapshot_profile(&self, _dir: PathBuf) -> Fut<Result<ProfileSnapshot, ()>> {
        self.order.lock().push("snapshot");
        self.snapshots.fetch_add(1, Ordering::SeqCst);
        let fails = self.snapshot_fails.load(Ordering::SeqCst);
        async move {
            if fails {
                return Err(());
            }
            Ok(ProfileSnapshot { credentials: Some("fake-old-creds".into()), claude_json: None })
        }
        .boxed()
    }
    fn restore_profile(&self, _dir: PathBuf, _snapshot: Arc<ProfileSnapshot>) -> Fut<Result<(), ()>> {
        self.order.lock().push("restore");
        self.restores.fetch_add(1, Ordering::SeqCst);
        let fails = self.restore_fails.load(Ordering::SeqCst);
        let gate = self.restore_gate.lock().clone();
        let slow = *self.restore_slow_fail.lock();
        async move {
            if let Some(g) = gate {
                g.acquire().await.unwrap().forget();
            }
            if let Some(d) = slow {
                tokio::time::sleep(d).await;
                return Err(());
            }
            if fails { Err(()) } else { Ok(()) }
        }
        .boxed()
    }
    fn identity_rewritten(&self, _dir: PathBuf, _snapshot: Arc<ProfileSnapshot>) -> Fut<Result<bool, ()>> {
        let n = self.rewritten_calls.fetch_add(1, Ordering::SeqCst) + 1;
        let from = self.rewritten_from.load(Ordering::SeqCst);
        let r = if from > 0 { n >= from } else { self.rewritten.load(Ordering::SeqCst) };
        async move { Ok(r) }.boxed()
    }
    fn before_main_login(&self) -> Fut<Result<(), BeforeMainError>> {
        self.order.lock().push("backup");
        let b = self.backup.lock().clone();
        async move { b.map_or(Ok(()), Err) }.boxed()
    }
    fn emit(&self, state: LoginState) {
        self.states.lock().push(state);
    }
    fn on_changed(&self, change: LoginChange) {
        self.changed.lock().push(change);
    }
    fn profiles_supported(&self) -> bool {
        self.profiles_supported
    }
}

async fn settle() {
    for _ in 0..50 {
        tokio::task::yield_now().await;
    }
}

async fn advance(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
    settle().await;
}

fn manager(fake: &Arc<Fake>) -> Arc<LoginManager> {
    LoginManager::new(fake.clone(), LoginTimings::CLAUDE, tokio::runtime::Handle::current())
}

fn started(r: &LoginStartResult) -> (String, String) {
    match r {
        LoginStartResult::Started { session_id, pty_id } => (session_id.clone(), pty_id.clone()),
        other => panic!("not started: {other:?}"),
    }
}

/// Starts a login, flips the fingerprint after the second poll and lets everything settle.
async fn run_success(fake: &Arc<Fake>, m: &Arc<LoginManager>, request: Value) -> LoginStartResult {
    let res = m.start(&request).await;
    advance(1500 * 2).await;
    *fake.fp.lock() = Some(SECRET.into());
    advance(1500 + 1500 + 10).await;
    res
}

#[tokio::test(start_paused = true)]
async fn registers_a_new_claude_account_after_the_fingerprint_changes() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let m = manager(&fake);
    let res = m.start(&json!({"provider": "claude", "target": {"type": "new"}})).await;
    let (session, pty) = started(&res);
    assert_eq!(pty, format!("auth:{session}"));
    let spec = fake.spawned.lock()[0].clone();
    assert_eq!(spec.command, "claude auth login --claudeai");
    assert_eq!(spec.env[0].0, "CLAUDE_CONFIG_DIR");
    assert_eq!(spec.env[1], ("CLAUDE_CODE_OAUTH_TOKEN".to_string(), String::new()));
    advance(1500 * 2).await;
    assert!(fake.killed.lock().is_empty());
    *fake.fp.lock() = Some(SECRET.into());
    advance(1500).await;
    assert!(fake.killed.lock().is_empty());
    advance(1510).await;
    assert_eq!(*fake.killed.lock(), vec![pty.clone()]);
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Success]);
    let accounts = fake.store.list();
    assert_eq!(accounts.len(), 1);
    assert_eq!(accounts[0].identity.email.as_deref(), Some("New@Example.com"));
    assert_eq!(accounts[0].custody, Some(Custody::App));
    assert_eq!(accounts[0].family, Some(TokenFamily::Own));
    let success = fake.states.lock()[1].clone();
    assert_eq!(success.record_id.as_deref(), Some(accounts[0].id.as_str()));
    assert!(!m.is_active());
    assert_eq!(fake.changed.lock().len(), 1);
    let text = format!("{} {}", serde_json::to_string(&*fake.states.lock()).unwrap(), res.to_value());
    assert!(!text.contains(SECRET));
}

#[tokio::test(start_paused = true)]
async fn reports_a_duplicate_and_removes_the_profile() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.known.lock().push(KnownIdentity {
        identity: ident(Some("new@example.com"), None),
        record_id: Some("x".into()),
        ..KnownIdentity::default()
    });
    let m = manager(&fake);
    run_success(&fake, &m, json!({"provider": "claude", "target": {"type": "new"}})).await;
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Duplicate]);
    let state = fake.states.lock()[1].to_value();
    assert_eq!(state["email"], "new@example.com");
    assert_eq!(state["duplicateOf"], "saved");
    assert!(fake.store.list().is_empty());
    let config_dir = fake.spawned.lock()[0].env[0].1.clone();
    assert!(!Path::new(&config_dir).exists());
    assert!(fake.changed.lock().is_empty());
}

#[tokio::test(start_paused = true)]
async fn fails_with_identity_when_no_e_mail_shows_up_after_five_reads() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    *fake.identity.lock() = AccountIdentity::default();
    let m = manager(&fake);
    m.start(&json!({"provider": "claude", "target": {"type": "new"}})).await;
    *fake.fp.lock() = Some(SECRET.into());
    advance(1500 + 1500 + 10 + 5000).await;
    assert_eq!(fake.identity_calls.load(Ordering::SeqCst), 5);
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Failed]);
    assert_eq!(fake.states.lock()[1].error, Some(LoginError::Identity));
    assert!(fake.store.list().is_empty());
}

#[tokio::test(start_paused = true)]
async fn rejects_invalid_and_unsupported_requests_without_spawning() {
    let dir = tempfile::tempdir().unwrap();
    let mut fake = Fake::new(dir.path());
    Arc::get_mut(&mut fake).unwrap().profiles_supported = false;
    let m = manager(&fake);
    for (request, error) in [
        (json!({"provider": "claude", "target": {"type": "new"}}), "unsupported"),
        (
            json!({"provider": "claude", "target": {"type": "account", "id": "123e4567-e89b-42d3-a456-426614174000"}}),
            "unsupported",
        ),
        (json!({"provider": "codex", "target": {"type": "new"}}), "invalid request"),
        (json!({"provider": "x", "target": {"type": "main"}}), "invalid request"),
        (json!({"provider": "claude"}), "invalid request"),
        (json!({"provider": "claude", "target": {"type": "bogus"}}), "invalid request"),
    ] {
        assert_eq!(m.start(&request).await, LoginStartResult::refused(error), "{request}");
    }
    assert!(fake.spawned.lock().is_empty());
    let res = m.start(&json!({"provider": "codex", "target": {"type": "main"}})).await;
    started(&res);
    assert_eq!(fake.spawned.lock()[0].command, "codex login");
    assert!(fake.spawned.lock()[0].env.is_empty());
    m.dispose();
}

#[tokio::test(start_paused = true)]
async fn a_relogin_with_another_account_restores_the_card_and_reports_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, dir_of) = fake.card(ident(Some("old@example.com"), Some("u-old")), Custody::Foreign, TokenFamily::Live);
    *fake.identity.lock() = ident(Some("other@example.com"), Some("u-other"));
    let m = manager(&fake);
    run_success(&fake, &m, json!({"provider": "claude", "target": {"type": "account", "id": id}})).await;
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Mismatch]);
    let state = fake.states.lock()[1].to_value();
    assert_eq!(
        state,
        json!({"sessionId": state["sessionId"], "status": "mismatch", "email": "other@example.com", "expected": "old@example.com"})
    );
    assert_eq!(fake.restores.load(Ordering::SeqCst), 1);
    let record = fake.store.get(&id).unwrap();
    assert_eq!((record.custody, record.family), (Some(Custody::Foreign), Some(TokenFamily::Live)));
    assert!(!m.holds_profile(&dir_of));
}

#[tokio::test(start_paused = true)]
async fn a_relogin_of_the_same_account_makes_the_card_the_apps_own() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, _) = fake.card(ident(Some("a@x.com"), Some("u1")), Custody::Foreign, TokenFamily::Live);
    *fake.identity.lock() = ident(Some("a@x.com"), Some("u1"));
    let m = manager(&fake);
    run_success(&fake, &m, json!({"provider": "claude", "target": {"type": "account", "id": id}})).await;
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Success]);
    let record = fake.store.get(&id).unwrap();
    assert_eq!((record.custody, record.family), (Some(Custody::App), Some(TokenFamily::Own)));
    assert_eq!(fake.restores.load(Ordering::SeqCst), 0);
    assert_eq!(fake.changed.lock()[0].subject(), format!("claude:{id}"));
}

#[tokio::test(start_paused = true)]
async fn a_failed_restore_parks_the_card_and_a_retry_gives_its_roles_back() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, dir_of) = fake.card(ident(Some("support@guybot.xyz"), Some("u-guybot")), Custody::Foreign, TokenFamily::Live);
    *fake.identity.lock() = ident(Some("app@x.com"), Some("u-app"));
    fake.restore_fails.store(true, Ordering::SeqCst);
    let m = manager(&fake);
    run_success(&fake, &m, json!({"provider": "claude", "target": {"type": "account", "id": id}})).await;
    assert!(m.holds_profile(&dir_of));
    advance(2000 * 2 + 10).await;
    assert_eq!(fake.restores.load(Ordering::SeqCst), 3);
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Failed]);
    let state = fake.states.lock()[1].to_value();
    assert_eq!(state["error"], "restore");
    assert_eq!(state["email"], "app@x.com");
    assert_eq!(state["expected"], "support@guybot.xyz");
    assert_eq!(fake.store.get(&id).unwrap().custody, Some(Custody::Quarantined));
    assert_eq!(m.parked_ids(), vec![id.clone()]);
    assert!(m.holds_profile(&dir_of));
    // A new start of the parked card retries first and is refused while it still fails.
    let request = json!({"provider": "claude", "target": {"type": "account", "id": id}});
    let again = m.start(&request);
    let (again, ()) = tokio::join!(again, advance(2000 * 2 + 10));
    assert_eq!(again, LoginStartResult::refused("restore"));
    assert_eq!(fake.restores.load(Ordering::SeqCst), 6);
    assert_eq!(fake.snapshots.load(Ordering::SeqCst), 1);
    // A later retry (before a poll) puts the card back with its previous roles.
    fake.restore_fails.store(false, Ordering::SeqCst);
    m.retry_parked_restores(None).await;
    let record = fake.store.get(&id).unwrap();
    assert_eq!((record.custody, record.family), (Some(Custody::Foreign), Some(TokenFamily::Live)));
    assert!(m.parked_ids().is_empty());
    assert!(!m.holds_profile(&dir_of));
}

#[tokio::test(start_paused = true)]
async fn cancelled_between_two_polls_looks_once_more_and_restores_changed_files() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, dir_of) = fake.card(ident(Some("new@example.com"), None), Custody::App, TokenFamily::Own);
    *fake.identity.lock() = AccountIdentity::default();
    let m = manager(&fake);
    let res = m.start(&json!({"provider": "claude", "target": {"type": "account", "id": id}})).await;
    let (session, _) = started(&res);
    advance(1500).await;
    *fake.fp.lock() = Some(SECRET.into());
    m.cancel(&session);
    assert!(m.holds_profile(&dir_of));
    settle().await;
    assert_eq!(fake.restores.load(Ordering::SeqCst), 1);
    assert!(!m.holds_profile(&dir_of));
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting]);
    // Unchanged credentials: nothing is written.
    let res = m.start(&json!({"provider": "claude", "target": {"type": "account", "id": id}})).await;
    let (session, _) = started(&res);
    m.cancel(&session);
    settle().await;
    assert_eq!(fake.restores.load(Ordering::SeqCst), 1);
}

#[tokio::test(start_paused = true)]
async fn times_out_kills_the_terminal_and_discards_the_pending_profile() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let m = manager(&fake);
    let res = m.start(&json!({"provider": "claude", "target": {"type": "new"}})).await;
    let (_, pty) = started(&res);
    let config_dir = fake.spawned.lock()[0].env[0].1.clone();
    assert!(Path::new(&config_dir).exists());
    advance(600_000 + 10).await;
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Failed]);
    assert_eq!(fake.states.lock()[1].error, Some(LoginError::Timeout));
    assert!(fake.killed.lock().contains(&pty));
    assert!(!Path::new(&config_dir).exists());
    assert!(!m.is_active());
}

#[tokio::test(start_paused = true)]
async fn fail_active_ends_the_session_once() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let m = manager(&fake);
    m.start(&json!({"provider": "claude", "target": {"type": "new"}})).await;
    m.fail_active();
    m.fail_active();
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Failed]);
    assert_eq!(fake.states.lock()[1].error, Some(LoginError::Spawn));
    assert!(fake.store.list().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_main_relogin_reports_an_own_change_and_a_failed_backup_names_the_outgoing_account() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let m = manager(&fake);
    run_success(&fake, &m, json!({"provider": "claude", "target": {"type": "main"}})).await;
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Success]);
    assert!(fake.changed.lock()[0].own_change);
    assert!(fake.store.list().is_empty());

    fake.store
        .set_live(Some(&crate::store::LiveIdentity { identity: ident(Some("live@x.com"), None), record_id: None }))
        .unwrap();
    *fake.backup.lock() = Some(BeforeMainError::Backup(LiveBackupFailed { reason: "failed".into() }));
    let r = m.start(&json!({"provider": "claude", "target": {"type": "main"}})).await;
    assert_eq!(r.to_value(), json!({"ok": false, "error": "backup", "email": "live@x.com"}));
    *fake.backup.lock() = Some(BeforeMainError::Backup(LiveBackupFailed { reason: "busy".into() }));
    assert_eq!(m.start(&json!({"provider": "claude", "target": {"type": "main"}})).await, LoginStartResult::refused("busy"));
    assert!(!m.is_active());
}

#[tokio::test(start_paused = true)]
async fn an_identity_never_confirmed_as_rewritten_restores_and_fails_with_identity() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, _) = fake.card(ident(Some("a@x.com"), Some("u1")), Custody::App, TokenFamily::Own);
    *fake.identity.lock() = ident(Some("a@x.com"), Some("u1"));
    fake.rewritten.store(false, Ordering::SeqCst);
    let m = manager(&fake);
    run_success(&fake, &m, json!({"provider": "claude", "target": {"type": "account", "id": id}})).await;
    advance(5000).await;
    assert_eq!(fake.identity_calls.load(Ordering::SeqCst), 5);
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Failed]);
    let state = fake.states.lock()[1].to_value();
    assert_eq!(state["error"], "identity");
    assert_eq!(state["expected"], "a@x.com");
    assert_eq!(fake.restores.load(Ordering::SeqCst), 1);
}

mod ts_ports;

#[test]
fn state_and_result_shapes() {
    let mut s = LoginState::new("s", LoginStatus::Success);
    s.record_id = Some("r".into());
    s.offer_main = true;
    assert_eq!(s.to_value(), json!({"sessionId": "s", "status": "success", "recordId": "r", "offerMain": true}));
    let r = LoginStartResult::Started { session_id: "a".into(), pty_id: "auth:a".into() };
    assert_eq!(r.to_value(), json!({"ok": true, "sessionId": "a", "ptyId": "auth:a"}));
    assert_eq!(LoginStartResult::refused("busy").to_value(), json!({"ok": false, "error": "busy"}));
    let c = LoginChange { provider: Provider::Codex, record_id: None, own_change: false };
    assert_eq!(c.subject(), "codex:main");
}

// ── Codex ────────────────────────────────────────────────────────────────────

struct CodexFake {
    store: CodexAccountsStore,
    fp: Mutex<Option<String>>,
    identity: Mutex<Option<CodexIdentity>>,
    live: Mutex<Option<CodexIdentity>>,
    states: Mutex<Vec<LoginState>>,
    spawned: Mutex<Vec<PtySpec>>,
    restored: Mutex<Vec<Option<String>>>,
    changed: Mutex<Vec<String>>,
}

impl CodexLoginDeps for CodexFake {
    fn store(&self) -> &CodexAccountsStore {
        &self.store
    }
    fn spawn_pty(&self, spec: PtySpec) -> bool {
        self.spawned.lock().push(spec);
        true
    }
    fn kill_pty(&self, _id: &str) {}
    fn fingerprint(&self, _dir: PathBuf) -> Fut<Result<Option<String>, ()>> {
        let fp = self.fp.lock().clone();
        async move { Ok(fp) }.boxed()
    }
    fn identity(&self, _dir: PathBuf) -> Fut<Result<Option<CodexIdentity>, ()>> {
        let i = self.identity.lock().clone();
        async move { Ok(i) }.boxed()
    }
    fn live_identity(&self) -> Option<CodexIdentity> {
        self.live.lock().clone()
    }
    fn read_auth(&self, _dir: PathBuf) -> Fut<Result<Option<Zeroizing<String>>, ()>> {
        async { Ok(Some(Zeroizing::new("old-auth".to_string()))) }.boxed()
    }
    fn restore_auth(&self, _dir: PathBuf, raw: Option<Zeroizing<String>>) -> Fut<Result<(), ()>> {
        self.restored.lock().push(raw.map(|r| r.to_string()));
        async { Ok(()) }.boxed()
    }
    fn busy(&self) -> bool {
        false
    }
    fn emit(&self, state: LoginState) {
        self.states.lock().push(state);
    }
    fn on_changed(&self, record_id: &str) {
        self.changed.lock().push(record_id.to_string());
    }
}

fn codex_fake(root: &Path) -> Arc<CodexFake> {
    Arc::new(CodexFake {
        store: CodexAccountsStore::new(root.join("codex-accounts")),
        fp: Mutex::new(None),
        identity: Mutex::new(Some(CodexIdentity { email: Some("c@x.com".into()), user_id: Some("u1".into()), account_id: None })),
        live: Mutex::new(None),
        states: Mutex::new(Vec::new()),
        spawned: Mutex::new(Vec::new()),
        restored: Mutex::new(Vec::new()),
        changed: Mutex::new(Vec::new()),
    })
}

#[tokio::test(start_paused = true)]
async fn codex_new_account_success_and_live_duplicate() {
    let dir = tempfile::tempdir().unwrap();
    let fake = codex_fake(dir.path());
    let m = CodexLoginManager::new(fake.clone(), LoginTimings::CODEX, tokio::runtime::Handle::current());
    started(&m.start(&json!({"type": "new"})).await);
    let spec = fake.spawned.lock()[0].clone();
    assert_eq!(spec.command, "codex login -c cli_auth_credentials_store=file");
    assert_eq!(spec.env[0].0, "CODEX_HOME");
    assert_eq!(spec.env[1], ("OPENAI_API_KEY".to_string(), String::new()));
    *fake.fp.lock() = Some(SECRET.into());
    advance(1500 + 1000 + 10).await;
    let statuses: Vec<_> = fake.states.lock().iter().map(|s| s.status).collect();
    assert_eq!(statuses, vec![LoginStatus::Waiting, LoginStatus::Success]);
    assert_eq!(fake.store.list().len(), 1);
    assert_eq!(*fake.changed.lock(), vec![fake.store.list()[0].id.clone()]);

    // The live login is that account already: a duplicate, the new profile is dropped.
    *fake.live.lock() = Some(CodexIdentity { email: Some("other@x.com".into()), user_id: Some("u2".into()), account_id: None });
    *fake.identity.lock() = fake.live.lock().clone();
    *fake.fp.lock() = None;
    started(&m.start(&json!({"type": "new"})).await);
    let new_home = fake.spawned.lock()[1].env[0].1.clone();
    *fake.fp.lock() = Some("other".into());
    advance(1500 + 1000 + 10).await;
    assert_eq!(fake.states.lock().last().unwrap().status, LoginStatus::Duplicate);
    assert_eq!(fake.store.list().len(), 1);
    assert!(!Path::new(&new_home).exists());
}

#[tokio::test(start_paused = true)]
async fn codex_relogin_of_another_account_puts_the_old_auth_back() {
    let dir = tempfile::tempdir().unwrap();
    let fake = codex_fake(dir.path());
    let (id, _) = fake.store.prepare().unwrap();
    fake.store
        .commit(&CodexAccount {
            id: id.clone(),
            added_at: 1.0,
            identity: CodexIdentity { email: Some("old@x.com".into()), user_id: Some("u-old".into()), account_id: None },
            live_family: true,
            ..CodexAccount::default()
        })
        .unwrap();
    let m = CodexLoginManager::new(fake.clone(), LoginTimings::CODEX, tokio::runtime::Handle::current());
    started(&m.start(&json!({"type": "account", "id": id})).await);
    *fake.fp.lock() = Some(SECRET.into());
    advance(1500 + 1000 + 10).await;
    let last = fake.states.lock().last().unwrap().to_value();
    assert_eq!(last["status"], "mismatch");
    assert_eq!(last["expected"], "old@x.com");
    assert_eq!(*fake.restored.lock(), vec![Some("old-auth".to_string())]);

    // The card's own account: identity kept, no longer a twin.
    *fake.identity.lock() = Some(CodexIdentity { email: None, user_id: Some("u-old".into()), account_id: Some("w1".into()) });
    *fake.fp.lock() = None;
    started(&m.start(&json!({"type": "account", "id": id})).await);
    *fake.fp.lock() = Some("new".into());
    advance(1500 + 1000 + 10).await;
    assert_eq!(fake.states.lock().last().unwrap().status, LoginStatus::Success);
    let record = fake.store.get(&id).unwrap();
    assert_eq!(record.identity.email.as_deref(), Some("old@x.com"));
    assert_eq!(record.identity.account_id.as_deref(), Some("w1"));
    assert!(!record.live_family);
}

// ── snapshots on real files ──────────────────────────────────────────────────

#[test]
fn snapshot_restore_and_identity_rewritten_on_files() {
    let dir = tempfile::tempdir().unwrap();
    let profile = dir.path().join("p");
    std::fs::create_dir_all(&profile).unwrap();
    let locks = ProfileLocks::new();
    std::fs::write(profile.join(".credentials.json"), r#"{"claudeAiOauth":{"accessToken":"a"}}"#).unwrap();
    let snap = snapshot_profile(&locks, &profile).unwrap();
    assert!(snap.claude_json.is_none());
    assert!(!format!("{snap:?}").contains("accessToken"));
    std::fs::write(profile.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"b@x"}}"#).unwrap();
    assert!(identity_rewritten(&profile, &snap).unwrap());
    let snap2 = snapshot_profile(&locks, &profile).unwrap();
    assert!(!identity_rewritten(&profile, &snap2).unwrap());
    std::fs::write(profile.join(".credentials.json"), "other").unwrap();
    restore_profile(&locks, &profile, &snap).unwrap();
    assert_eq!(std::fs::read_to_string(profile.join(".credentials.json")).unwrap(), r#"{"claudeAiOauth":{"accessToken":"a"}}"#);
    assert!(!profile.join(".claude.json").exists());
    // Claude Code's lock directories are gone again.
    assert!(!profile.join(".oauth_refresh.lock").exists());
    assert!(!profile.join(".claude.json.lock").exists());
}

#[test]
fn snapshots_a_missing_profile_as_empty() {
    let dir = tempfile::tempdir().unwrap();
    let missing = dir.path().join("none");
    let locks = ProfileLocks::new();
    let snap = snapshot_profile(&locks, &missing).unwrap();
    assert_eq!(snap, ProfileSnapshot::default());
    std::fs::create_dir_all(&missing).unwrap();
    restore_profile(&locks, &missing, &snap).unwrap();
    assert!(!missing.join(".credentials.json").exists());
    assert!(!missing.join(".claude.json").exists());
}

#[test]
fn the_restore_waits_for_a_held_claude_code_lock_and_releases_its_own() {
    let dir = tempfile::tempdir().unwrap();
    let profile = dir.path().join("profile");
    std::fs::create_dir_all(&profile).unwrap();
    let old = r#"{"oauthAccount":{"emailAddress":"old@x.com"}}"#;
    std::fs::write(profile.join(".claude.json"), old).unwrap();
    let locks = ProfileLocks::new();
    let snap = snapshot_profile(&locks, &profile).unwrap();
    std::fs::write(profile.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"other@x.com"}}"#).unwrap();
    // A Claude Code process of this profile holds its credential lock: the restore waits for it.
    std::fs::create_dir(profile.join(".oauth_refresh.lock")).unwrap();
    std::thread::scope(|scope| {
        let restoring = scope.spawn(|| restore_profile(&locks, &profile, &snap));
        std::thread::sleep(Duration::from_millis(300));
        assert!(std::fs::read_to_string(profile.join(".claude.json")).unwrap().contains("other@x.com"));
        std::fs::remove_dir(profile.join(".oauth_refresh.lock")).unwrap();
        restoring.join().unwrap().unwrap();
    });
    assert_eq!(std::fs::read_to_string(profile.join(".claude.json")).unwrap(), old);
    assert!(!profile.join(".oauth_refresh.lock").exists());
    let mut legacy = profile.clone().into_os_string();
    legacy.push(".lock");
    assert!(!Path::new(&legacy).exists());
}

#[test]
fn takes_the_snapshot_after_a_renewal_of_the_profile_that_is_still_in_flight() {
    let dir = tempfile::tempdir().unwrap();
    let profile = dir.path().to_path_buf();
    let renewed = r#"{"claudeAiOauth":{"accessToken":"fake-renewed"}}"#;
    std::fs::write(profile.join(".credentials.json"), r#"{"claudeAiOauth":{"accessToken":"fake-before"}}"#).unwrap();
    let locks = ProfileLocks::new();
    let renewal = locks.lock(&profile);
    std::thread::scope(|scope| {
        let snapping = scope.spawn(|| snapshot_profile(&locks, &profile).unwrap());
        std::thread::sleep(Duration::from_millis(50));
        std::fs::write(profile.join(".credentials.json"), renewed).unwrap();
        drop(renewal);
        assert_eq!(snapping.join().unwrap().credentials.as_deref(), Some(renewed));
    });
}

#[test]
fn tells_when_the_profile_identity_was_rewritten_after_the_snapshot() {
    let dir = tempfile::tempdir().unwrap();
    let profile = dir.path().to_path_buf();
    let file = profile.join(".claude.json");
    let account =
        |email: &str, at: u32| json!({ "numStartups": at, "oauthAccount": { "emailAddress": email, "profileFetchedAt": at } });
    std::fs::write(&file, account("old@x.com", 1).to_string()).unwrap();
    let locks = ProfileLocks::new();
    let snap = snapshot_profile(&locks, &profile).unwrap();
    assert!(!identity_rewritten(&profile, &snap).unwrap());
    // Other keys of .claude.json change all the time; only oauthAccount counts.
    let mut other_keys = account("old@x.com", 1);
    other_keys["numStartups"] = json!(9);
    std::fs::write(&file, other_keys.to_string()).unwrap();
    assert!(!identity_rewritten(&profile, &snap).unwrap());
    std::fs::write(&file, json!({ "numStartups": 9 }).to_string()).unwrap();
    assert!(!identity_rewritten(&profile, &snap).unwrap());
    // A re-login of the same account still writes a fresh profileFetchedAt.
    std::fs::write(&file, account("old@x.com", 2).to_string()).unwrap();
    assert!(identity_rewritten(&profile, &snap).unwrap());
    assert!(identity_rewritten(&profile, &ProfileSnapshot::default()).unwrap());
}
