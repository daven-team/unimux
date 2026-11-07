//! Ports of the resyncActiveBackup cases of test/accounts-reconcile.test.ts and the dead / held cases of
//! accounts-dead-login.test.ts and accounts-reconcile.test.ts (M1).

use super::*;
use crate::identity::Custody;
use crate::store::ManagedAccount;
use crate::swapfs::RealSwapFs;
use crate::test_support::HookFs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};

struct Fx {
    _tmp: tempfile::TempDir,
    home: PathBuf,
    store: AccountsStore,
    profiles: ProfileLocks,
    locks: LockOptions,
    paths: SwapPaths,
}

fn a() -> AccountIdentity {
    AccountIdentity { email: Some("a@x.com".into()), account_uuid: Some("ua".into()), ..Default::default() }
}

impl Fx {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let home = root.join("home");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        let paths =
            SwapPaths { credentials: home.join(".claude").join(".credentials.json"), claude_json: home.join(".claude.json") };
        Self {
            _tmp: tmp,
            home,
            store: AccountsStore::new(root.join("accounts")),
            profiles: ProfileLocks::new(),
            locks: LockOptions { timeout: Duration::from_millis(300), ..LockOptions::default() },
            paths,
        }
    }
    fn add(&self) -> String {
        let (id, _) = self.store.prepare().unwrap();
        self.store
            .commit(&ManagedAccount {
                id: id.clone(),
                added_at: 1.0,
                identity: a(),
                custody: Some(Custody::Live),
                ..Default::default()
            })
            .unwrap();
        id
    }
    fn put_live(&self, email: &str, uuid: &str, n: &str) {
        std::fs::write(
            &self.paths.credentials,
            format!(r#"{{"claudeAiOauth":{{"accessToken":"fake-acc-{n}","refreshToken":"fake-ref-{n}","expiresAt":5}},"mcpOAuth":{{"s":1}}}}"#),
        )
        .unwrap();
        std::fs::write(
            &self.paths.claude_json,
            format!(r#"{{"oauthAccount":{{"emailAddress":"{email}","accountUuid":"{uuid}"}},"projects":{{}}}}"#),
        )
        .unwrap();
    }
    fn resync(&self, id: &str, seen: Option<&Seen>, fs: &dyn SwapFs) -> Result<ResyncResult, ResyncError> {
        let d = ResyncDeps {
            paths: &self.paths,
            store: &self.store,
            fs,
            locks: &self.locks,
            profiles: &self.profiles,
            delay: &|_| {},
            seen,
        };
        resync_active_backup(&d, id, &a())
    }
    fn own(&self, id: &str, name: &str) -> Option<String> {
        std::fs::read_to_string(self.store.dir_of(id).unwrap().join(name)).ok()
    }
}

#[test]
fn copies_the_live_tokens_into_the_record_keeps_other_keys_marks_the_family_live_unchanged_the_second_time() {
    let fx = Fx::new();
    let p = fx.add();
    let dir = fx.store.dir_of(&p).unwrap();
    std::fs::write(dir.join(".credentials.json"), r#"{"other":1,"claudeAiOauth":{"accessToken":"old","refreshToken":"old"}}"#)
        .unwrap();
    fx.put_live("a@x.com", "ua", "1");
    assert_eq!(fx.resync(&p, None, &RealSwapFs).unwrap(), ResyncResult::Copied);
    assert_eq!(
        fx.own(&p, ".credentials.json").unwrap(),
        r#"{"other":1,"claudeAiOauth":{"accessToken":"fake-acc-1","refreshToken":"fake-ref-1","expiresAt":5}}"#
    );
    assert_eq!(
        fx.own(&p, ".claude.json").unwrap(),
        "{\n  \"oauthAccount\": {\n    \"emailAddress\": \"a@x.com\",\n    \"accountUuid\": \"ua\"\n  }\n}"
    );
    assert_eq!(fx.store.get(&p).unwrap().family, Some(TokenFamily::Live));
    assert_eq!(fx.resync(&p, None, &RealSwapFs).unwrap(), ResyncResult::Unchanged);
}

#[test]
fn never_copies_a_login_whose_identity_is_not_the_records() {
    let fx = Fx::new();
    let p = fx.add();
    fx.put_live("g@x.com", "ug", "2");
    assert_eq!(fx.resync(&p, None, &RealSwapFs).unwrap(), ResyncResult::Mismatch);
    assert_eq!(fx.own(&p, ".credentials.json"), None);
}

#[test]
fn waits_for_claude_codes_credential_lock_and_gives_up_without_writing() {
    let fx = Fx::new();
    let p = fx.add();
    fx.put_live("a@x.com", "ua", "3");
    std::fs::create_dir(fx.home.join(".claude").join(".oauth_refresh.lock")).unwrap();
    assert_eq!(fx.resync(&p, None, &RealSwapFs).unwrap(), ResyncResult::Locked);
    assert_eq!(fx.own(&p, ".credentials.json"), None);
}

#[test]
fn with_a_memory_of_the_last_look_copies_new_tokens_only_once_the_live_files_read_the_same_twice() {
    let fx = Fx::new();
    let p = fx.add();
    let seen = Seen::default();
    fx.put_live("a@x.com", "ua", "4");
    assert_eq!(fx.resync(&p, Some(&seen), &RealSwapFs).unwrap(), ResyncResult::Settling);
    assert_eq!(fx.own(&p, ".credentials.json"), None);
    assert_eq!(fx.resync(&p, Some(&seen), &RealSwapFs).unwrap(), ResyncResult::Copied);
    assert!(fx.own(&p, ".credentials.json").unwrap().contains("fake-ref-4"));
    // A /login caught between its two writes: new tokens, the old identity. Never copied on that look.
    std::fs::write(
        &fx.paths.credentials,
        r#"{"claudeAiOauth":{"accessToken":"fake-acc-5","refreshToken":"fake-ref-5","expiresAt":6}}"#,
    )
    .unwrap();
    assert_eq!(fx.resync(&p, Some(&seen), &RealSwapFs).unwrap(), ResyncResult::Settling);
    assert!(fx.own(&p, ".credentials.json").unwrap().contains("fake-ref-4"));
}

#[test]
fn copies_an_identity_only_change_at_once_and_leaves_the_tokens_alone() {
    let fx = Fx::new();
    let p = fx.add();
    fx.put_live("a@x.com", "ua", "6");
    assert_eq!(fx.resync(&p, None, &RealSwapFs).unwrap(), ResyncResult::Copied);
    let before = fx.own(&p, ".credentials.json").unwrap();
    std::fs::write(
        &fx.paths.claude_json,
        r#"{"oauthAccount":{"emailAddress":"a@x.com","accountUuid":"ua","organizationName":"New Org"}}"#,
    )
    .unwrap();
    assert_eq!(fx.resync(&p, Some(&Seen::default()), &RealSwapFs).unwrap(), ResyncResult::Copied);
    assert!(fx.own(&p, ".claude.json").unwrap().contains("New Org"));
    assert_eq!(fx.own(&p, ".credentials.json").unwrap(), before);
    assert_eq!(fx.resync(&p, None, &RealSwapFs).unwrap(), ResyncResult::Unchanged);
}

#[test]
fn ignores_claude_json_churn_outside_oauth_account() {
    let fx = Fx::new();
    let p = fx.add();
    let seen = Seen::default();
    fx.put_live("a@x.com", "ua", "7");
    assert_eq!(fx.resync(&p, Some(&seen), &RealSwapFs).unwrap(), ResyncResult::Settling);
    std::fs::write(
        &fx.paths.claude_json,
        r#"{"numStartups":42,"projects":{"x":{}},"oauthAccount":{"emailAddress":"a@x.com","accountUuid":"ua"}}"#,
    )
    .unwrap();
    assert_eq!(fx.resync(&p, Some(&seen), &RealSwapFs).unwrap(), ResyncResult::Copied);
}

#[test]
fn retries_a_failed_copy_on_the_next_look_and_remembers_only_the_record_looked_at_last() {
    let fx = Fx::new();
    let p = fx.add();
    let seen = Seen::default();
    seen.lock().insert("q".into(), "old".into());
    let fail_once = std::sync::Arc::new(AtomicBool::new(true));
    let f = fail_once.clone();
    let fs = HookFs {
        rename: Some(Box::new(move |(from, to)| {
            if f.swap(false, Ordering::SeqCst) {
                return Err(std::io::Error::other("disk"));
            }
            RealSwapFs.rename(&from, &to)
        })),
        ..HookFs::default()
    };
    fx.put_live("a@x.com", "ua", "8");
    assert_eq!(fx.resync(&p, Some(&seen), &fs).unwrap(), ResyncResult::Settling);
    assert_eq!(seen.lock().keys().cloned().collect::<Vec<_>>(), std::slice::from_ref(&p));
    assert!(fx.resync(&p, Some(&seen), &fs).is_err());
    assert_eq!(fx.resync(&p, Some(&seen), &fs).unwrap(), ResyncResult::Copied);
    assert!(fx.own(&p, ".credentials.json").unwrap().contains("fake-ref-8"));
}

#[test]
fn reports_a_missing_live_login() {
    let fx = Fx::new();
    let p = fx.add();
    assert_eq!(fx.resync(&p, None, &RealSwapFs).unwrap(), ResyncResult::Missing);
}

/// accounts-dead-login "the backup of the live login is marked dead (by hash) once Claude Code cleared it, and a new sign-in
/// ends the mark" and "marks nothing for a cleared login of another identity, nor while tokens are held".
#[test]
fn a_cleared_live_login_marks_the_saved_copy_dead_and_a_new_sign_in_ends_the_mark() {
    let fx = Fx::new();
    let p = fx.add();
    fx.put_live("a@x.com", "ua", "1");
    assert_eq!(fx.resync(&p, None, &RealSwapFs).unwrap(), ResyncResult::Copied);
    std::fs::write(
        &fx.paths.credentials,
        r#"{"claudeAiOauth":{"accessToken":"","refreshToken":"","expiresAt":0,"subscriptionType":"max"}}"#,
    )
    .unwrap();
    assert_eq!(fx.resync(&p, None, &RealSwapFs).unwrap(), ResyncResult::Dead);
    assert_eq!(fx.store.get(&p).unwrap().dead_tokens, Some(token_hash("fake-ref-1")));
    // Another identity's cleared login: mismatch, nothing marked.
    std::fs::write(&fx.paths.claude_json, r#"{"oauthAccount":{"emailAddress":"g@x.com","accountUuid":"ug"}}"#).unwrap();
    assert_eq!(fx.resync(&p, None, &RealSwapFs).unwrap(), ResyncResult::Mismatch);
    // A new sign-in is copied and ends the mark.
    fx.put_live("a@x.com", "ua", "2");
    assert_eq!(fx.resync(&p, None, &RealSwapFs).unwrap(), ResyncResult::Copied);
    assert_eq!(fx.store.get(&p).unwrap().dead_tokens, None);
}

/// accounts-reconcile M1: held tokens are never copied into the record; the hold ends when the live login is rewritten, or
/// when it is exactly the record's own saved copy.
#[test]
fn held_tokens_are_never_copied_and_the_hold_ends_when_the_live_login_changes() {
    let fx = Fx::new();
    let p = fx.add();
    fx.put_live("a@x.com", "ua", "9");
    fx.store.set_held_tokens(&p, Some(&token_hash("fake-ref-9"))).unwrap();
    assert_eq!(fx.resync(&p, None, &RealSwapFs).unwrap(), ResyncResult::Held);
    assert_eq!(fx.own(&p, ".credentials.json"), None);
    fx.put_live("a@x.com", "ua", "10");
    assert_eq!(fx.resync(&p, None, &RealSwapFs).unwrap(), ResyncResult::Copied);
    assert_eq!(fx.store.get(&p).unwrap().held_tokens, None);
    // The live login is exactly the record's own copy: the hold ends too.
    fx.store.set_held_tokens(&p, Some(&token_hash("fake-ref-10"))).unwrap();
    assert_eq!(fx.resync(&p, None, &RealSwapFs).unwrap(), ResyncResult::Unchanged);
    assert_eq!(fx.store.get(&p).unwrap().held_tokens, None);
}
