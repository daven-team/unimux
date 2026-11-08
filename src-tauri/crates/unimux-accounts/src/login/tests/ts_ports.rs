//! Case-by-case ports of test/auth-login.test.ts and the LoginManager half of test/auth-first-login.test.ts (the fixture of
//! the parent module, paused tokio clock).

use super::*;

fn new_request() -> Value {
    json!({"provider": "claude", "target": {"type": "new"}})
}

fn main_request() -> Value {
    json!({"provider": "claude", "target": {"type": "main"}})
}

fn account_request(id: &str) -> Value {
    json!({"provider": "claude", "target": {"type": "account", "id": id}})
}

fn config_dir_of(spec: &PtySpec) -> PathBuf {
    PathBuf::from(&spec.env[0].1)
}

fn email(identity: &AccountIdentity) -> Option<&str> {
    identity.email.as_deref()
}

fn session_statuses(fake: &Fake, session: &str) -> Vec<LoginStatus> {
    fake.states.lock().iter().filter(|s| s.session_id == session).map(|s| s.status).collect()
}

fn other_identity() -> AccountIdentity {
    ident(Some("app@x.com"), Some("u-app"))
}

/// The card of the fix-round tests: support@guybot.xyz, custody app, family own.
fn guybot(fake: &Fake) -> (String, PathBuf) {
    fake.card(ident(Some("support@guybot.xyz"), Some("u-guybot")), Custody::App, TokenFamily::Own)
}

fn manager_with(fake: &Arc<Fake>, timings: LoginTimings) -> Arc<LoginManager> {
    LoginManager::new(fake.clone(), timings, tokio::runtime::Handle::current())
}

/// Makes every write of accounts.json fail while it can still be read (a full or locked disk); undone by the guard.
struct WritesFail(PathBuf);

impl WritesFail {
    fn new(store: &AccountsStore) -> Self {
        if !store.file_path().exists() {
            store.set_live(None).unwrap();
        }
        #[cfg(windows)]
        let target = store.file_path().to_path_buf();
        #[cfg(not(windows))]
        let target = store.root().to_path_buf();
        let mut p = std::fs::metadata(&target).unwrap().permissions();
        p.set_readonly(true);
        std::fs::set_permissions(&target, p).unwrap();
        Self(target)
    }
}

impl Drop for WritesFail {
    fn drop(&mut self) {
        let mut p = std::fs::metadata(&self.0).unwrap().permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        p.set_readonly(false);
        let _ = std::fs::set_permissions(&self.0, p);
    }
}

/// "failActive ends the session as failed, kills the pty and drops the pending profile"
#[tokio::test(start_paused = true)]
async fn ts_fail_active_kills_the_terminal_and_drops_the_pending_profile() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let m = manager(&fake);
    let (_, pty) = started(&m.start(&new_request()).await);
    let profile = config_dir_of(&fake.spawned.lock()[0]);
    m.fail_active();
    assert!(fake.killed.lock().contains(&pty));
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Failed]);
    assert_eq!(fake.states.lock()[1].error, Some(LoginError::Spawn));
    assert!(fake.store.list().is_empty() && !profile.exists());
    m.fail_active();
    assert_eq!(fake.states.lock().len(), 2);
}

/// "retries identity until an e-mail appears", "fails with identity when no e-mail shows up after retries" (the profile is
/// gone)
#[tokio::test(start_paused = true)]
async fn ts_the_identity_is_read_again_until_an_e_mail_appears() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    *fake.identity_seq.lock() = vec![AccountIdentity::default(), AccountIdentity::default()];
    *fake.identity.lock() = ident(Some("late@example.com"), None);
    let m = manager(&fake);
    run_success(&fake, &m, new_request()).await;
    advance(3000).await;
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Success]);
    assert_eq!(email(&fake.store.list()[0].identity), Some("late@example.com"));

    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    *fake.identity.lock() = AccountIdentity::default();
    let m = manager(&fake);
    m.start(&new_request()).await;
    *fake.fp.lock() = Some(SECRET.into());
    advance(1500 + 1500 + 10 + 5000).await;
    assert_eq!(fake.states.lock()[1].error, Some(LoginError::Identity));
    assert!(!config_dir_of(&fake.spawned.lock()[0]).exists());
}

/// "handles a Codex login", "a Codex login never runs the Claude backup"
#[tokio::test(start_paused = true)]
async fn ts_a_codex_main_login_never_touches_the_store_or_the_claude_backup() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let m = manager(&fake);
    run_success(&fake, &m, json!({"provider": "codex", "target": {"type": "main"}})).await;
    let spec = fake.spawned.lock()[0].clone();
    assert!(spec.id.starts_with("auth:"));
    assert_eq!((spec.command.as_str(), spec.env.len()), ("codex login", 0));
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Success]);
    assert!(fake.store.list().is_empty());
    assert_eq!(*fake.changed.lock(), vec![LoginChange { provider: Provider::Codex, record_id: None, own_change: false }]);
    assert!(!fake.order.lock().contains(&"backup"));
}

/// "re-logs the main Claude login without touching the store", "a main re-login backs up the outgoing live login first and
/// reports an own change (investigation test 2)", "never leaks a fingerprint into states or return values"
#[tokio::test(start_paused = true)]
async fn ts_a_main_relogin_backs_up_first_and_never_touches_the_store() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let m = manager(&fake);
    let res = run_success(&fake, &m, main_request()).await;
    let spec = fake.spawned.lock()[0].clone();
    assert_eq!((spec.command.as_str(), spec.env.len()), ("claude auth login --claudeai", 0));
    assert_eq!(fake.fp_dirs.lock()[0], None);
    assert_eq!(*fake.order.lock(), vec!["backup", "spawn"]);
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Success]);
    assert!(fake.store.list().is_empty());
    assert_eq!(*fake.changed.lock(), vec![LoginChange { provider: Provider::Claude, record_id: None, own_change: true }]);
    let text = format!("{} {}", serde_json::to_string(&*fake.states.lock()).unwrap(), res.to_value());
    assert!(!text.contains(SECRET));
}

/// "re-logs a managed account of the same identity and keeps it renewable (own family)", "passes the command and
/// CLAUDE_CONFIG_DIR for a new account"
#[tokio::test(start_paused = true)]
async fn ts_a_relogin_of_the_same_account_updates_the_card_and_passes_the_profile_env() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, profile) = fake.card(ident(Some("new@example.com"), None), Custody::Foreign, TokenFamily::Live);
    let m = manager(&fake);
    run_success(&fake, &m, account_request(&id)).await;
    let spec = fake.spawned.lock()[0].clone();
    let env: Vec<(&str, String)> = vec![
        ("CLAUDE_CONFIG_DIR", dir_text(&profile)),
        ("CLAUDE_CODE_OAUTH_TOKEN", String::new()),
        ("ANTHROPIC_API_KEY", String::new()),
    ];
    assert_eq!(spec.env, env.into_iter().map(|(k, v)| (k.to_string(), v)).collect::<Vec<_>>());
    assert_eq!(spec.command, "claude auth login --claudeai");
    assert_eq!(fake.snapshots.load(Ordering::SeqCst), 1);
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Success]);
    let r = fake.store.get(&id).unwrap();
    assert_eq!((email(&r.identity), r.identity.org.as_deref()), (Some("New@Example.com"), Some("Org")));
    assert_eq!((r.custody, r.family), (Some(Custody::App), Some(TokenFamily::Own)));
    assert_eq!(fake.restores.load(Ordering::SeqCst), 0);
    assert_eq!(*fake.changed.lock(), vec![LoginChange { provider: Provider::Claude, record_id: Some(id), own_change: false }]);

    // A new account: the profile exists while the login runs.
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let m = manager(&fake);
    m.start(&new_request()).await;
    let spec = fake.spawned.lock()[0].clone();
    let keys: Vec<&str> = spec.env.iter().map(|(k, _)| k.as_str()).collect();
    assert_eq!(keys, ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
    assert!(spec.env[1].1.is_empty() && spec.env[2].1.is_empty() && config_dir_of(&spec).exists());
    m.dispose();
}

/// "re-login with a different account restores the old login and reports mismatch (investigation test 1)", "re-login that
/// signs in the live account or another saved one reports duplicate and restores"
#[tokio::test(start_paused = true)]
async fn ts_a_relogin_as_another_or_an_already_held_account_restores_the_card() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, _) = fake.card(ident(Some("support@guybot.xyz"), Some("u-guybot")), Custody::App, TokenFamily::Own);
    *fake.identity.lock() = other_identity();
    let m = manager(&fake);
    run_success(&fake, &m, account_request(&id)).await;
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Mismatch]);
    let r = fake.store.get(&id).unwrap();
    assert_eq!((email(&r.identity), r.identity.account_uuid.as_deref()), (Some("support@guybot.xyz"), Some("u-guybot")));
    assert!(fake.changed.lock().is_empty());
    assert!(!serde_json::to_string(&*fake.states.lock()).unwrap().contains("fake-old"));

    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, _) = fake.card(ident(Some("new@example.com"), None), Custody::App, TokenFamily::Own);
    *fake.known.lock() = vec![
        KnownIdentity {
            identity: ident(Some("new@example.com"), None),
            record_id: Some("live-record".into()),
            live: true,
            empty: false,
        },
        KnownIdentity { identity: ident(Some("new@example.com"), None), record_id: Some(id.clone()), live: false, empty: false },
    ];
    let m = manager(&fake);
    run_success(&fake, &m, account_request(&id)).await;
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Duplicate]);
    assert_eq!(fake.restores.load(Ordering::SeqCst), 1);
}

/// "refuses a main re-login (busy) when the outgoing live login could not be backed up"
#[tokio::test(start_paused = true)]
async fn ts_a_main_relogin_without_a_backup_is_refused_busy() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    *fake.backup.lock() = Some(BeforeMainError::Other);
    let m = manager(&fake);
    assert_eq!(m.start(&main_request()).await, LoginStartResult::refused("busy"));
    assert!(fake.spawned.lock().is_empty() && fake.fp_dirs.lock().is_empty() && fake.states.lock().is_empty());
    assert!(!m.is_active());
}

/// "cancelling a re-login after it wrote new files puts the card back; cancelling before leaves it alone"
#[tokio::test(start_paused = true)]
async fn ts_a_cancelled_relogin_puts_the_card_back_only_after_it_wrote_files() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, _) = fake.card(ident(Some("new@example.com"), None), Custody::App, TokenFamily::Own);
    *fake.identity.lock() = AccountIdentity::default();
    let m = manager(&fake);
    let (early, _) = started(&m.start(&account_request(&id)).await);
    advance(1500).await;
    m.cancel(&early);
    settle().await;
    assert_eq!(fake.restores.load(Ordering::SeqCst), 0);
    let (late, _) = started(&m.start(&account_request(&id)).await);
    *fake.fp.lock() = Some(SECRET.into());
    advance(1500 + 1500 + 10 + 1500).await;
    m.cancel(&late);
    settle().await;
    assert_eq!(fake.restores.load(Ordering::SeqCst), 1);
    advance(10_000).await;
    assert_eq!(fake.restores.load(Ordering::SeqCst), 1);
    assert_eq!(session_statuses(&fake, &late), vec![LoginStatus::Waiting]);
}

/// "a re-login cancelled or timed out between two polls looks once more and puts the card back when its files changed (D2)"
/// (the timeout half; the cancel half is `cancelled_between_two_polls_looks_once_more_and_restores_changed_files`)
#[tokio::test(start_paused = true)]
async fn ts_a_relogin_that_times_out_between_two_polls_looks_once_more() {
    let timings =
        LoginTimings { poll: Duration::from_millis(10_000_000), timeout: Duration::from_millis(5_000), ..LoginTimings::CLAUDE };
    for (changed, restores) in [(true, 1), (false, 0)] {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(dir.path());
        let (id, _) = fake.card(ident(Some("new@example.com"), None), Custody::App, TokenFamily::Own);
        *fake.identity.lock() = AccountIdentity::default();
        *fake.fp.lock() = Some(SECRET.into());
        let m = manager_with(&fake, timings);
        m.start(&account_request(&id)).await;
        if changed {
            *fake.fp.lock() = Some("fp-other-login".into());
        }
        advance(5_000 + 10).await;
        assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Failed]);
        assert_eq!(fake.restores.load(Ordering::SeqCst), restores, "changed {changed}");
    }
}

/// "removing the account during its re-login never writes into its profile", "removing a parked card forgets its snapshot"
#[tokio::test(start_paused = true)]
async fn ts_removing_the_card_never_writes_into_its_profile() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, _) = fake.card(ident(Some("new@example.com"), None), Custody::App, TokenFamily::Own);
    *fake.identity.lock() = AccountIdentity::default();
    let m = manager(&fake);
    m.start(&account_request(&id)).await;
    *fake.fp.lock() = Some(SECRET.into());
    advance(1500 + 1500 + 10 + 1500).await;
    m.cancel_for(&id);
    advance(10_000).await;
    assert_eq!(fake.restores.load(Ordering::SeqCst), 0);

    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, profile) = guybot(&fake);
    *fake.identity.lock() = other_identity();
    fake.restore_fails.store(true, Ordering::SeqCst);
    let m = manager(&fake);
    run_success(&fake, &m, account_request(&id)).await;
    advance(2000 * 2 + 10).await;
    m.cancel_for(&id);
    assert!(!m.holds_profile(&profile));
    m.retry_parked_restores(None).await;
    assert_eq!(fake.restores.load(Ordering::SeqCst), 3);
}

/// "returns spawn and never starts when the saved profile cannot be snapshotted", "reports spawn failures and discards the
/// pending profile", "returns spawn when the profile cannot be prepared"
#[tokio::test(start_paused = true)]
async fn ts_a_login_that_cannot_snapshot_prepare_or_spawn_answers_spawn() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, _) = fake.card(ident(Some("new@example.com"), None), Custody::App, TokenFamily::Own);
    fake.snapshot_fails.store(true, Ordering::SeqCst);
    let m = manager(&fake);
    assert_eq!(m.start(&account_request(&id)).await, LoginStartResult::refused("spawn"));
    assert!(fake.spawned.lock().is_empty() && !m.is_active());

    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.spawn_fails.store(true, Ordering::SeqCst);
    let m = manager(&fake);
    assert_eq!(m.start(&new_request()).await, LoginStartResult::refused("spawn"));
    assert!(!config_dir_of(&fake.spawned.lock()[0]).exists());
    assert!(fake.states.lock().is_empty() && !m.is_active());

    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    std::fs::create_dir_all(dir.path().join("accounts")).unwrap();
    std::fs::write(dir.path().join("accounts").join("claude"), "not a directory").unwrap();
    let m = manager(&fake);
    assert_eq!(m.start(&new_request()).await, LoginStartResult::refused("spawn"));
    assert!(fake.spawned.lock().is_empty() && !m.is_active());
}

/// "cancels mid-login without emitting anything more", "cancelling during the identity retries leaves no timers and no
/// state"
#[tokio::test(start_paused = true)]
async fn ts_a_cancelled_login_emits_nothing_more() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let m = manager(&fake);
    let (session, pty) = started(&m.start(&new_request()).await);
    let profile = config_dir_of(&fake.spawned.lock()[0]);
    advance(1500).await;
    m.cancel(&session);
    assert!(fake.killed.lock().contains(&pty) && !profile.exists());
    *fake.fp.lock() = Some(SECRET.into());
    advance(700_000).await;
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting]);
    assert!(fake.store.list().is_empty());

    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    *fake.identity.lock() = AccountIdentity::default();
    let m = manager(&fake);
    let (session, _) = started(&m.start(&new_request()).await);
    *fake.fp.lock() = Some(SECRET.into());
    advance(1500 + 1500 + 10 + 1500).await;
    let reads = fake.identity_calls.load(Ordering::SeqCst);
    m.cancel(&session);
    advance(10_000).await;
    assert_eq!(fake.identity_calls.load(Ordering::SeqCst), reads, "no identity read after the cancel");
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting]);
    assert!(fake.store.list().is_empty());
}

/// "ignores cancel for an unknown session id", "a second start cancels the first session", "a second start emits nothing
/// for the first session", "isMainActive is true only during a main Claude login"
#[tokio::test(start_paused = true)]
async fn ts_one_session_at_a_time() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let m = manager(&fake);
    assert!(!m.is_main_active());
    m.start(&main_request()).await;
    assert!(m.is_main_active());
    m.cancel("nope");
    assert!(fake.killed.lock().is_empty());
    m.dispose();
    assert_eq!(fake.killed.lock().len(), 1);
    m.start(&new_request()).await;
    assert!(!m.is_main_active());
    m.dispose();

    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let m = manager(&fake);
    let (first, first_pty) = started(&m.start(&new_request()).await);
    let (second, _) = started(&m.start(&main_request()).await);
    assert!(fake.killed.lock().contains(&first_pty));
    assert_ne!(first, second);
    assert!(!config_dir_of(&fake.spawned.lock()[0]).exists());
    m.dispose();

    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let m = manager(&fake);
    let (first, _) = started(&m.start(&main_request()).await);
    let (second, _) = started(&m.start(&main_request()).await);
    *fake.fp.lock() = Some(SECRET.into());
    advance(1500 * 2 + 1500).await;
    assert_eq!(session_statuses(&fake, &first), vec![LoginStatus::Waiting]);
    assert_eq!(session_statuses(&fake, &second), vec![LoginStatus::Waiting, LoginStatus::Success]);
}

/// "rejects invalid requests without spawning"
#[tokio::test(start_paused = true)]
async fn ts_rejects_invalid_requests_without_spawning() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let m = manager(&fake);
    let unknown = "123e4567-e89b-42d3-a456-426614174000";
    for request in [
        json!({"provider": "codex", "target": {"type": "new"}}),
        json!({"provider": "codex", "target": {"type": "account", "id": unknown}}),
        json!({"provider": "claude", "target": {"type": "account", "id": unknown}}),
        json!({"provider": "claude", "target": {"type": "account", "id": "../x"}}),
        json!({"provider": "claude", "target": {"type": "bogus"}}),
        json!({"provider": "claude", "target": "main"}),
        json!({"provider": "claude", "target": null}),
        json!({"provider": "gemini", "target": {"type": "main"}}),
        json!(null),
    ] {
        assert_eq!(m.start(&request).await, LoginStartResult::refused("invalid request"), "{request}");
    }
    assert!(fake.spawned.lock().is_empty());
}

/// "fails and cleans up when the store cannot commit, and a later start works", "fails the session when the store cannot
/// update an account"
#[tokio::test(start_paused = true)]
async fn ts_a_store_that_cannot_write_fails_the_session() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let m = manager(&fake);
    m.start(&new_request()).await;
    let profile = config_dir_of(&fake.spawned.lock()[0]);
    {
        let _fail = WritesFail::new(&fake.store);
        advance(1500 * 2).await;
        *fake.fp.lock() = Some(SECRET.into());
        advance(1500 + 1500 + 10).await;
    }
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Failed]);
    assert_eq!(fake.states.lock()[1].error, Some(LoginError::Identity));
    assert!(!profile.exists());
    assert!(fake.changed.lock().is_empty() && !m.is_active());
    started(&m.start(&main_request()).await);
    m.dispose();

    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, profile) = fake.card(ident(Some("new@example.com"), None), Custody::App, TokenFamily::Own);
    let m = manager(&fake);
    {
        let _fail = WritesFail::new(&fake.store);
        run_success(&fake, &m, account_request(&id)).await;
    }
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Failed]);
    assert!(profile.exists() && !m.is_active());
}

/// "cancelling during the initial fingerprint read never spawns"
#[tokio::test(start_paused = true)]
async fn ts_a_login_cancelled_during_the_first_fingerprint_read_never_spawns() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    *fake.fp_gate.lock() = Some(gate.clone());
    let m = manager(&fake);
    let pending = tokio::spawn({
        let m = m.clone();
        async move { m.start(&new_request()).await }
    });
    settle().await;
    m.dispose();
    gate.add_permits(1);
    assert_eq!(pending.await.unwrap(), LoginStartResult::refused("cancelled"));
    assert!(fake.spawned.lock().is_empty() && fake.states.lock().is_empty());
}

/// "starts a main Claude login without a config dir, resets the credential cache on start and every poll, and succeeds"
#[tokio::test(start_paused = true)]
async fn ts_a_macos_main_login_resets_the_credential_cache_on_start_and_every_poll() {
    let dir = tempfile::tempdir().unwrap();
    let mut fake = Fake::new(dir.path());
    Arc::get_mut(&mut fake).unwrap().profiles_supported = false;
    *fake.identity.lock() = ident(Some("mac@example.com"), None);
    let m = manager(&fake);
    started(&m.start(&main_request()).await);
    let spec = fake.spawned.lock()[0].clone();
    assert_eq!((spec.command.as_str(), spec.env.len()), ("claude auth login --claudeai", 0));
    assert_eq!(fake.resets.load(Ordering::SeqCst), 1);
    advance(1500 * 2).await;
    *fake.fp.lock() = Some(SECRET.into());
    advance(1500 + 1500 + 10).await;
    assert!(fake.resets.load(Ordering::SeqCst) > 2);
    let last = fake.states.lock().last().unwrap().to_value();
    assert_eq!(last, json!({"sessionId": last["sessionId"], "status": "success", "email": "mac@example.com"}));
    assert_eq!(fake.changed.lock().len(), 1);
}

/// "a new start of the card waits for the queued restore of a cancelled login before it takes its snapshot" (and the
/// profile is held from the moment of the cancel)
#[tokio::test(start_paused = true)]
async fn ts_a_new_start_waits_for_the_restore_of_the_cancelled_login() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, profile) = guybot(&fake);
    *fake.identity.lock() = AccountIdentity::default();
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    *fake.restore_gate.lock() = Some(gate.clone());
    let m = manager(&fake);
    let (first, _) = started(&m.start(&account_request(&id)).await);
    *fake.fp.lock() = Some(SECRET.into());
    advance(1500 + 1500 + 10).await;
    m.cancel(&first);
    assert!(!m.is_active());
    assert!(m.holds_profile(&profile), "held from the cancel on: the restore is registered at once");
    settle().await;
    assert_eq!(fake.restores.load(Ordering::SeqCst), 1);
    let second = tokio::spawn({
        let m = m.clone();
        let request = account_request(&id);
        async move { m.start(&request).await }
    });
    advance(100).await;
    assert_eq!(fake.snapshots.load(Ordering::SeqCst), 1);
    gate.add_permits(1);
    started(&second.await.unwrap());
    assert_eq!(fake.snapshots.load(Ordering::SeqCst), 2);
    let order = fake.order.lock().clone();
    let restore_at = order.iter().position(|o| *o == "restore").unwrap();
    assert!(order.iter().rposition(|o| *o == "snapshot").unwrap() > restore_at);
    m.dispose();
}

/// "holds the card from renewal while its re-login runs and while its restore runs or failed"
#[tokio::test(start_paused = true)]
async fn ts_the_card_is_held_during_its_relogin_and_its_restore() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, profile) = guybot(&fake);
    *fake.identity.lock() = other_identity();
    fake.restore_fails.store(true, Ordering::SeqCst);
    let m = manager(&fake);
    assert!(!m.holds_profile(&profile));
    m.start(&account_request(&id)).await;
    assert!(m.holds_profile(&profile));
    assert!(!m.holds_profile(&fake.store.dir_of("123e4567-e89b-42d3-a456-426614174000").unwrap()));
    *fake.fp.lock() = Some(SECRET.into());
    advance(1500 + 1500 + 10).await;
    assert!(m.is_active() && m.holds_profile(&profile));
    advance(2000 * 2 + 10).await;
    assert!(!m.is_active());
    assert!(m.holds_profile(&profile), "parked: the files are another account's");
}

/// "a failed restore is tried 3 times, reported as restore naming the card, and the card is set aside, never renewed" (the
/// parts `a_failed_restore_parks_the_card_and_a_retry_gives_its_roles_back` does not check), "a new start of a parked card
/// retries its restore first and is refused with restore while it still fails" (the start that works once it is back)
#[tokio::test(start_paused = true)]
async fn ts_a_parked_card_reports_nothing_as_changed_and_starts_again_once_restored() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, profile) = guybot(&fake);
    *fake.identity.lock() = other_identity();
    fake.restore_fails.store(true, Ordering::SeqCst);
    let m = manager(&fake);
    run_success(&fake, &m, account_request(&id)).await;
    advance(2000 * 2 + 10).await;
    assert!(fake.changed.lock().is_empty());
    assert!(!serde_json::to_string(&*fake.states.lock()).unwrap().contains("fake-old"));
    fake.restore_fails.store(false, Ordering::SeqCst);
    started(&m.start(&account_request(&id)).await);
    assert_eq!(fake.store.get(&id).unwrap().custody, Some(Custody::App));
    assert!(m.holds_profile(&profile));
    m.dispose();
}

/// "signing in again a card set aside before a restart (quarantined, no holder) makes it the app's own again"
#[tokio::test(start_paused = true)]
async fn ts_a_card_set_aside_before_a_restart_becomes_the_apps_own_again() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, _) = fake.card(ident(Some("new@example.com"), None), Custody::Quarantined, TokenFamily::Live);
    let m = manager(&fake);
    run_success(&fake, &m, account_request(&id)).await;
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Success]);
    let r = fake.store.get(&id).unwrap();
    assert_eq!((r.custody, r.family, r.duplicate_of), (Some(Custody::App), Some(TokenFamily::Own), None));
}

/// "bounds the wait for the parked restores before a poll and never starts a second retry while one runs"
#[tokio::test(start_paused = true)]
async fn ts_the_parked_restore_retry_is_bounded_and_shared() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, profile) = guybot(&fake);
    *fake.identity.lock() = other_identity();
    fake.restore_fails.store(true, Ordering::SeqCst);
    let m = manager(&fake);
    run_success(&fake, &m, account_request(&id)).await;
    advance(2000 * 2 + 10).await;
    assert_eq!(fake.restores.load(Ordering::SeqCst), 3);
    *fake.restore_slow_fail.lock() = Some(Duration::from_millis(10_000));
    let done = Arc::new(AtomicBool::new(false));
    let first = tokio::spawn({
        let (m, done) = (m.clone(), done.clone());
        async move {
            m.retry_parked_restores(Some(Duration::from_millis(1_000))).await;
            done.store(true, Ordering::SeqCst);
        }
    });
    advance(1_000).await;
    assert!(done.load(Ordering::SeqCst));
    first.await.unwrap();
    let second = tokio::spawn({
        let m = m.clone();
        async move { m.retry_parked_restores(Some(Duration::from_millis(1_000))).await }
    });
    advance(1_000).await;
    second.await.unwrap();
    assert_eq!(fake.restores.load(Ordering::SeqCst), 4, "the second call shares the retry still running");
    advance(40_000).await;
    assert_eq!(fake.restores.load(Ordering::SeqCst), 6);
    assert!(m.holds_profile(&profile));
    *fake.restore_slow_fail.lock() = None;
    fake.restore_fails.store(false, Ordering::SeqCst);
    m.retry_parked_restores(Some(Duration::from_millis(1_000))).await;
    assert!(!m.holds_profile(&profile));
}

/// "waits until the profile identity is rewritten before it compares, and never takes the old one for the card"
#[tokio::test(start_paused = true)]
async fn ts_the_identity_counts_only_once_the_profile_rewrote_it() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (id, _) = fake.card(ident(Some("new@example.com"), None), Custody::App, TokenFamily::Own);
    fake.rewritten_from.store(3, Ordering::SeqCst);
    let m = manager(&fake);
    run_success(&fake, &m, account_request(&id)).await;
    advance(3000).await;
    assert_eq!(fake.rewritten_calls.load(Ordering::SeqCst), 3);
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Success]);
    assert_eq!(fake.restores.load(Ordering::SeqCst), 0);
}

// ---- auth-first-login.test.ts: the first "Add a Claude account" ------------------------------------------------------

const EMAIL: &str = "maksy@example.com";

fn maksy() -> AccountIdentity {
    AccountIdentity {
        email: Some(EMAIL.into()),
        org: Some("Org".into()),
        account_uuid: Some("u-maksy".into()),
        organization_uuid: Some("o-1".into()),
    }
}

/// auth-first-login "a record of the account without any login (adopted leftover) is no duplicate: the account is added and
/// the empty record replaced"
#[tokio::test(start_paused = true)]
async fn ts_first_login_replaces_an_empty_record_of_the_same_account() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let (empty, _) = fake.card(maksy(), Custody::Live, TokenFamily::Live);
    fake.store
        .set_live(Some(&crate::store::LiveIdentity {
            identity: ident(Some(EMAIL), Some("u-maksy")),
            record_id: Some(empty.clone()),
        }))
        .unwrap();
    *fake.identity.lock() = maksy();
    *fake.known.lock() = vec![KnownIdentity { identity: maksy(), record_id: Some(empty.clone()), live: false, empty: true }];
    let m = manager(&fake);
    started(&run_success(&fake, &m, new_request()).await);
    assert_eq!(fake.statuses(), vec![LoginStatus::Waiting, LoginStatus::Success]);
    let records = fake.store.list();
    assert_eq!(records.len(), 1);
    assert_eq!(
        (email(&records[0].identity), records[0].custody, records[0].family),
        (Some(EMAIL), Some(Custody::App), Some(TokenFamily::Own))
    );
    assert_ne!(records[0].id, empty);
    assert_eq!(fake.states.lock()[1].record_id.as_deref(), Some(records[0].id.as_str()));
    assert_eq!(fake.store.live().and_then(|l| l.record_id), None);
}

/// auth-first-login "with no main login it is offered as main; with a main login it is not"
#[tokio::test(start_paused = true)]
async fn ts_first_login_is_offered_as_main_only_without_a_main_login() {
    for (has_main, offered) in [(false, true), (true, false)] {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(dir.path());
        *fake.identity.lock() = maksy();
        *fake.has_main.lock() = Some(has_main);
        let m = manager(&fake);
        run_success(&fake, &m, new_request()).await;
        let last = fake.states.lock().last().unwrap().clone();
        assert_eq!((last.status, last.email.as_deref(), last.offer_main), (LoginStatus::Success, Some(EMAIL), offered));
    }
}

/// auth-first-login "a duplicate names the record that really holds the account: the main login or a saved card"
#[tokio::test(start_paused = true)]
async fn ts_first_login_duplicate_names_the_main_login_or_the_saved_card() {
    for (holder, live, named, of) in
        [("Maksy@Example.com", true, "Maksy@Example.com", "main"), ("maksy@example.com", false, "maksy@example.com", "saved")]
    {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(dir.path());
        *fake.identity.lock() = maksy();
        *fake.known.lock() = vec![KnownIdentity {
            identity: ident(Some(holder), Some("u-maksy")),
            record_id: (!live).then(|| "r1".to_string()),
            live,
            empty: false,
        }];
        let m = manager(&fake);
        run_success(&fake, &m, new_request()).await;
        let last = fake.states.lock().last().unwrap().to_value();
        assert_eq!((&last["status"], &last["duplicateOf"], &last["email"]), (&json!("duplicate"), &json!(of), &json!(named)));
        assert!(fake.store.list().is_empty());
    }
}

/// auth-first-login "a missing CLI never opens a login terminal: the start answers cliMissing (Claude and Codex)" (a failing
/// detection fails open: the deps answer false, see `unimux-app` accounts/login.rs)
#[tokio::test(start_paused = true)]
async fn ts_a_missing_cli_never_opens_a_login_terminal() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.cli_missing.store(true, Ordering::SeqCst);
    let m = manager(&fake);
    assert_eq!(m.start(&new_request()).await, LoginStartResult::refused("cliMissing"));
    assert_eq!(m.start(&json!({"provider": "codex", "target": {"type": "main"}})).await, LoginStartResult::refused("cliMissing"));
    assert!(fake.spawned.lock().is_empty() && fake.states.lock().is_empty() && fake.store.list().is_empty() && !m.is_active());
    fake.cli_missing.store(false, Ordering::SeqCst);
    started(&m.start(&new_request()).await);
    m.dispose();
}

/// auth-first-login "a login cancelled while its terminal is still starting kills that terminal"
#[tokio::test(start_paused = true)]
async fn ts_a_login_cancelled_while_its_terminal_starts_kills_it() {
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    let gate = Arc::new(tokio::sync::Semaphore::new(0));
    *fake.spawn_gate.lock() = Some(gate.clone());
    let m = manager(&fake);
    let pending = tokio::spawn({
        let m = m.clone();
        async move { m.start(&new_request()).await }
    });
    settle().await;
    m.dispose();
    gate.add_permits(1);
    assert_eq!(pending.await.unwrap(), LoginStartResult::refused("cancelled"));
    assert!(!fake.killed.lock().is_empty());
}

// ---- codex-accounts.test.ts: "Add Codex account" ----------------------------------------------------------------------

/// codex-accounts "runs `codex login` with CODEX_HOME at a new profile and saves the account", "refuses the live account and
/// a second copy of a saved one, and drops the new profile"
#[tokio::test(start_paused = true)]
async fn ts_codex_new_profile_under_the_store_and_no_second_copy_of_a_saved_account() {
    let dir = tempfile::tempdir().unwrap();
    let fake = codex_fake(dir.path());
    let m = CodexLoginManager::new(fake.clone(), LoginTimings::CODEX, tokio::runtime::Handle::current());
    started(&m.start(&json!({"type": "new"})).await);
    let home = PathBuf::from(&fake.spawned.lock()[0].env[0].1);
    assert!(home.starts_with(dir.path().join("codex-accounts")));
    *fake.fp.lock() = Some(SECRET.into());
    advance(1500 + 1000 + 10).await;
    let last = fake.states.lock().last().unwrap().clone();
    assert_eq!((last.status, last.email.as_deref()), (LoginStatus::Success, Some("c@x.com")));
    let saved = fake.store.list();
    assert_eq!((saved[0].identity.email.as_deref(), saved[0].identity.user_id.as_deref()), (Some("c@x.com"), Some("u1")));
    assert!(!m.is_active());

    // The same account again: a duplicate of the saved card, the new profile is dropped.
    *fake.fp.lock() = None;
    started(&m.start(&json!({"type": "new"})).await);
    let second = PathBuf::from(&fake.spawned.lock()[1].env[0].1);
    *fake.fp.lock() = Some("again".into());
    advance(1500 + 1000 + 10).await;
    assert_eq!(fake.states.lock().last().unwrap().status, LoginStatus::Duplicate);
    assert_eq!(fake.store.list().len(), 1);
    assert!(!second.exists());
}

// ---- accounts-makemain.test.ts: logins and "make main" exclude each other ---------------------------------------------

/// accounts-makemain "refuses to start a login while a swap runs", "reports an active login so the swap can refuse, and
/// clears it on cancel"
#[tokio::test(start_paused = true)]
async fn ts_a_login_and_make_main_exclude_each_other() {
    use crate::results::{SwapError, SwapResult};
    use crate::rules::{MakeMainDeps, handle_make_main};
    let dir = tempfile::tempdir().unwrap();
    let fake = Fake::new(dir.path());
    fake.swap_running.store(true, Ordering::SeqCst);
    let m = manager(&fake);
    assert_eq!(m.start(&json!({"provider": "codex", "target": {"type": "main"}})).await, LoginStartResult::refused("busy"));
    assert!(fake.spawned.lock().is_empty() && !m.is_active());

    fake.swap_running.store(false, Ordering::SeqCst);
    let (session, _) = started(&m.start(&json!({"provider": "codex", "target": {"type": "main"}})).await);
    assert!(m.is_active());
    let swapped = AtomicBool::new(false);
    let login_active = || m.is_active();
    let validate = |_: &str| Ok(None);
    let swap = |_: &str| {
        swapped.store(true, Ordering::SeqCst);
        Ok(SwapResult::ok(Some("a@b.c".into())))
    };
    let on_swapped = || Ok(());
    let deps = MakeMainDeps { login_active: &login_active, validate: &validate, swap: &swap, on_swapped: &on_swapped };
    assert_eq!(handle_make_main(&deps, &json!("123e4567-e89b-42d3-a456-426614174000")), SwapResult::fail(SwapError::Busy));
    assert!(!swapped.load(Ordering::SeqCst));
    m.cancel(&session);
    assert!(!m.is_active());
}
