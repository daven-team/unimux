//! Ports of the "Codex profiles: make main" cases of test/codex-accounts.test.ts.

use super::*;
use serde_json::Value;

fn auth(name: &str) -> String {
    crate::codex::tests::auth(name)
}

fn auth_with_refresh(name: &str, refresh: &str) -> String {
    let mut v: Value = serde_json::from_str(&auth(name)).unwrap();
    v["tokens"]["refresh_token"] = Value::String(refresh.into());
    v.to_string()
}

struct C {
    _tmp: tempfile::TempDir,
    live: PathBuf,
    store: Arc<CodexAccountsStore>,
    slot: Arc<SwapSlot>,
}

fn setup() -> C {
    let tmp = tempfile::tempdir().unwrap();
    let live = tmp.path().join("home").join(".codex");
    fs::create_dir_all(&live).unwrap();
    let store = Arc::new(CodexAccountsStore::new(tmp.path().join("data").join("codex-accounts")));
    C { _tmp: tmp, live, store, slot: Arc::new(SwapSlot::new()) }
}

impl C {
    fn deps(&self) -> CodexActivateDeps {
        let live = self.live.clone();
        CodexActivateDeps {
            store: self.store.clone(),
            live_home: Arc::new(move || live.clone()),
            now: Arc::new(|| 1000.0),
            read_text: None,
            write_text: None,
            slot: self.slot.clone(),
        }
    }
    fn add_saved(&self, name: &str) -> String {
        let (id, dir) = self.store.prepare().unwrap();
        fs::write(dir.join("auth.json"), auth(name)).unwrap();
        self.store
            .commit(&CodexAccount {
                id: id.clone(),
                added_at: 1.0,
                identity: CodexIdentity {
                    email: Some(format!("{name}@example.com")),
                    user_id: Some(format!("user-{name}")),
                    account_id: Some(format!("ws-{name}")),
                },
                ..Default::default()
            })
            .unwrap();
        id
    }
    fn live_user(&self) -> Option<String> {
        parse_codex_auth(fs::read_to_string(self.live.join("auth.json")).ok().as_deref()).and_then(|l| l.identity.user_id)
    }
}

#[test]
fn copies_the_outgoing_live_login_into_a_new_record_of_its_own_then_puts_the_target_in_sessions_and_config_stay() {
    let c = setup();
    fs::write(c.live.join("auth.json"), auth_with_refresh("alice", "fake-refresh-alice-rotated")).unwrap();
    fs::write(c.live.join("config.toml"), "model = \"o3\"\n").unwrap();
    fs::create_dir(c.live.join("sessions")).unwrap();
    let bob = c.add_saved("bob");
    assert_eq!(activate_codex_account(&c.deps(), &bob), SwapResult::ok(Some("bob@example.com".into())));
    assert_eq!(c.live_user().as_deref(), Some("user-bob"));
    let alice = c.store.list().into_iter().find(|a| a.identity.user_id.as_deref() == Some("user-alice")).unwrap();
    // The newest tokens of the outgoing account (what Codex had renewed) are in its record, not an older copy.
    assert!(
        fs::read_to_string(c.store.dir_of(&alice.id).unwrap().join("auth.json")).unwrap().contains("fake-refresh-alice-rotated")
    );
    assert!(c.store.get(&bob).unwrap().live_family);
    let live = c.store.live().unwrap();
    assert_eq!((live.identity.user_id.as_deref(), live.record_id.as_deref()), (Some("user-bob"), Some(bob.as_str())));
    assert_eq!(fs::read_to_string(c.live.join("config.toml")).unwrap(), "model = \"o3\"\n");
    assert!(c.live.join("sessions").exists());
    assert!(c.store.root().join("swap-backup").join("auth.json").exists());
    assert!(!c.slot.is_codex_running());

    // And back: the twin of bob is overwritten with the live copy, alice goes in.
    assert!(activate_codex_account(&c.deps(), &alice.id).ok);
    assert!(!c.store.get(&bob).unwrap().live_family);
    assert_eq!(c.store.list().len(), 2);
}

#[test]
fn refuses_the_live_account_an_outdated_copy_and_a_keyring_config_and_changes_nothing() {
    let c = setup();
    fs::write(c.live.join("auth.json"), auth("alice")).unwrap();
    let bob = c.add_saved("bob");
    let alice = c.add_saved("alice");
    assert_eq!(check_codex_target(&c.deps(), &alice).map(|r| r.error), Some(Some(SwapError::SameAccount)));
    c.store.patch(&bob, &CodexPatch { outdated: Some(true), ..CodexPatch::default() }).unwrap();
    assert_eq!(activate_codex_account(&c.deps(), &bob).error, Some(SwapError::Foreign));
    c.store.patch(&bob, &CodexPatch { outdated: Some(false), ..CodexPatch::default() }).unwrap();
    fs::write(c.live.join("config.toml"), "cli_auth_credentials_store = \"keyring\"\n").unwrap();
    assert_eq!(activate_codex_account(&c.deps(), &bob).error, Some(SwapError::Unsupported));
    assert_eq!(c.live_user().as_deref(), Some("user-alice"));
}

#[test]
fn an_outside_switch_marks_the_twin_that_left_as_outdated() {
    let c = setup();
    fs::write(c.live.join("auth.json"), auth("alice")).unwrap();
    let bob = c.add_saved("bob");
    activate_codex_account(&c.deps(), &bob);
    assert_eq!(reconcile_codex_live(&c.deps()).and_then(|i| i.user_id).as_deref(), Some("user-bob"));
    // Another tool (or `codex login`) puts carol in.
    fs::write(c.live.join("auth.json"), auth("carol")).unwrap();
    assert_eq!(reconcile_codex_live(&c.deps()).and_then(|i| i.user_id).as_deref(), Some("user-carol"));
    assert!(c.store.get(&bob).unwrap().outdated);
    assert_eq!(read_live_codex_identity(&c.deps()).and_then(|i| i.email).as_deref(), Some("carol@example.com"));
}

#[test]
fn a_failed_write_answers_write_and_an_unusable_target_invalid() {
    let c = setup();
    fs::write(c.live.join("auth.json"), auth("alice")).unwrap();
    let bob = c.add_saved("bob");
    let mut deps = c.deps();
    deps.write_text = Some(Arc::new(|_, _| Err(std::io::Error::other("disk full"))));
    assert_eq!(activate_codex_account(&deps, &bob), SwapResult::fail(SwapError::Write));
    assert_eq!(c.live_user().as_deref(), Some("user-alice"));
    assert!(!c.slot.is_codex_running());
    fs::write(c.store.dir_of(&bob).unwrap().join("auth.json"), "{").unwrap();
    assert_eq!(
        check_codex_target(&c.deps(), &bob),
        Some(SwapResult::fail_named(SwapError::Invalid, Some("bob@example.com".into())))
    );
    // An API-key login has no identity: it is not saved as a record, only the emergency copy is written.
    fs::write(c.store.dir_of(&bob).unwrap().join("auth.json"), auth("bob")).unwrap();
    fs::write(c.live.join("auth.json"), r#"{"OPENAI_API_KEY":"sk-fake"}"#).unwrap();
    assert!(activate_codex_account(&c.deps(), &bob).ok);
    assert_eq!(c.store.list().len(), 1);
    assert_eq!(
        fs::read_to_string(c.store.root().join("swap-backup").join("auth.json")).unwrap(),
        r#"{"OPENAI_API_KEY":"sk-fake"}"#
    );
}

#[test]
fn a_reconcile_never_interleaves_with_a_make_main_on_another_thread() {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::mpsc;
    use std::time::Duration;

    let c = setup();
    fs::write(c.live.join("auth.json"), auth("alice")).unwrap();
    let bob = c.add_saved("bob");
    reconcile_codex_live(&c.deps());
    // The reconcile reads the live auth.json (alice); right then a whole "make main" of bob runs on another thread. Without
    // the Codex files lock it finished in that gap, and the reconcile then took bob (now live, live_family) for the account
    // that left outside the app: bob outdated, live back to alice.
    let swap_deps = c.deps();
    let swap_bob = bob.clone();
    let started = Arc::new(AtomicBool::new(false));
    let handle: Arc<Mutex<Option<std::thread::JoinHandle<SwapResult>>>> = Arc::new(Mutex::new(None));
    let mut deps = c.deps();
    let (started_seam, handle_seam) = (started.clone(), handle.clone());
    deps.read_text = Some(Arc::new(move |path: &Path| {
        let text = crate::js::read_text(path).ok();
        if path.file_name().is_some_and(|n| n == "auth.json") && !started_seam.swap(true, Ordering::SeqCst) {
            let (done_tx, done_rx) = mpsc::channel();
            let (d, id) = (swap_deps.clone(), swap_bob.clone());
            *handle_seam.lock().unwrap() = Some(std::thread::spawn(move || {
                let result = activate_codex_account(&d, &id);
                let _ = done_tx.send(());
                result
            }));
            // Give the swap every chance to run in the gap (it waits for the reconcile now).
            let _ = done_rx.recv_timeout(Duration::from_millis(500));
        }
        text
    }));
    reconcile_codex_live(&deps);
    let swap = handle.lock().unwrap().take().expect("the seam started the swap").join().unwrap();
    assert_eq!(swap, SwapResult::ok(Some("bob@example.com".into())));
    assert_eq!(c.live_user().as_deref(), Some("user-bob"));
    let record = c.store.get(&bob).unwrap();
    assert!(!record.outdated && record.live_family, "the new main account was marked outdated");
    assert_eq!(c.store.live().and_then(|l| l.record_id).as_deref(), Some(bob.as_str()));
    // The next poll finds nothing changed.
    reconcile_codex_live(&c.deps());
    assert!(!c.store.get(&bob).unwrap().outdated);
    assert_eq!(c.store.live().and_then(|l| l.record_id).as_deref(), Some(bob.as_str()));
}
