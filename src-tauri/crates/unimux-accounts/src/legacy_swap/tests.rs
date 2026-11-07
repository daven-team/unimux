//! Ports of test/accounts-swap.test.ts and the swap cases of test/accounts-swap-recovery.test.ts.

use super::*;
use crate::store::ManagedAccount;
use crate::swapfs::RealSwapFs;
use crate::test_support::*;
use parking_lot::Mutex;
use serde_json::json;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

const NOW: f64 = 1_791_720_000_000.0; // 2026-10-11T12:00:00Z
const FUTURE: f64 = NOW + 3_600_000.0;
const ID: &str = "11111111-1111-4111-8111-111111111111";
const OTHER: &str = "22222222-2222-4222-8222-222222222222";

fn creds_at(n: &str, expires_at: f64) -> Value {
    json!({ "claudeAiOauth": { "accessToken": format!("tok-{n}"), "refreshToken": format!("ref-{n}"), "expiresAt": js::num(expires_at), "scopes": ["s"], "subscriptionType": "max" }, "mcpOAuth": { "server": n } })
}
fn creds(n: &str) -> Value {
    creds_at(n, FUTURE)
}
/// The recovery suite's blob (no subscriptionType).
fn rcreds(n: &str) -> Value {
    json!({ "claudeAiOauth": { "accessToken": format!("tok-{n}"), "refreshToken": format!("ref-{n}"), "expiresAt": js::num(FUTURE), "scopes": ["s"] }, "mcpOAuth": { "server": n } })
}
fn account(n: &str, email: &str) -> Value {
    json!({ "emailAddress": email, "organizationName": format!("Org {n}"), "accountUuid": format!("uuid-{n}"), "displayName": n })
}

struct S {
    fx: Fx,
}

impl std::ops::Deref for S {
    type Target = Fx;
    fn deref(&self) -> &Fx {
        &self.fx
    }
}

fn record(id: &str, email: &str, org: &str, added_at: f64) -> ManagedAccount {
    ManagedAccount {
        id: id.into(),
        added_at,
        identity: crate::identity::AccountIdentity { email: Some(email.into()), org: Some(org.into()), ..Default::default() },
        ..Default::default()
    }
}

/// accounts-swap.test.ts `beforeEach`.
fn setup() -> S {
    let fx = Fx::new(NOW);
    put(&fx.live_creds(), &creds("A"));
    put(&fx.live_json(), &json!({ "oauthAccount": account("A", "a@x.com"), "projects": { "p": 1 }, "numStartups": 4 }));
    fx.store.commit(&record(ID, "x@x.com", "Org X", 1.0)).unwrap();
    put(&fx.dir(ID).join(".credentials.json"), &creds("X"));
    put(&fx.dir(ID).join(".claude.json"), &json!({ "oauthAccount": account("X", "x@x.com"), "theme": "dark" }));
    S { fx }
}

/// accounts-swap-recovery.test.ts `beforeEach` (`original()`).
fn rsetup() -> S {
    let fx = Fx::new(NOW);
    fx.store.commit(&record(ID, "x@x.com", "Org X", 1.0)).unwrap();
    let s = S { fx };
    original(&s);
    s
}

fn original(s: &S) {
    put(&s.live_creds(), &rcreds("A"));
    put(&s.live_json(), &json!({ "oauthAccount": account("A", "a@x.com"), "projects": { "p": 1 } }));
    put(&s.t_creds(), &rcreds("X"));
    put(&s.t_json(), &json!({ "oauthAccount": account("X", "x@x.com"), "theme": "dark" }));
}

impl S {
    fn t_creds(&self) -> PathBuf {
        self.dir(ID).join(".credentials.json")
    }
    fn t_json(&self) -> PathBuf {
        self.dir(ID).join(".claude.json")
    }
    fn journal(&self) -> PathBuf {
        self.backup_dir().join("swap-journal.json")
    }
    fn swap(&self) -> SwapResult {
        swap_main_account(&self.deps(), ID)
    }
    fn recover(&self) -> Recovery {
        recover_interrupted_swap(&self.deps())
    }
    fn snapshot(&self) -> Vec<Option<String>> {
        [self.live_creds(), self.live_json(), self.t_creds(), self.t_json()].iter().map(|p| text(p)).collect()
    }
    fn parsed(&self) -> Vec<Option<Value>> {
        self.snapshot().into_iter().map(|t| t.map(|t| js_json::parse(&t).unwrap())).collect()
    }
    fn temps(&self) -> Vec<String> {
        [self.home.join(".claude"), self.home.clone(), self.dir(ID), self.backup_dir()]
            .iter()
            .flat_map(|d| names(d).into_iter().filter(|n| n.ends_with(".tmp")))
            .collect()
    }
    fn backup_files(&self) -> Vec<String> {
        names(&self.backup_dir())
    }
    fn first(&self) -> ManagedAccount {
        self.store.list().remove(0)
    }
    /// Lets a swap finish but keeps its backup and journal, then writes a version-1 journal with `phase`.
    fn crashed(&self, phase: &str) {
        self.set_fs(HookFs {
            rm: Some(Box::new(|p| if p.to_string_lossy().contains("swap-backup") { Ok(()) } else { RealSwapFs.rm(&p) })),
            ..Default::default()
        });
        self.swap();
        self.real_fs();
        let j = json!({ "version": 1, "accountId": ID, "startedAt": 1, "phase": phase, "targetJsonExisted": true });
        std::fs::write(self.journal(), js_json::stringify(&j)).unwrap();
    }
}

fn token(path: &Path) -> String {
    json(path)["claudeAiOauth"]["accessToken"].as_str().unwrap().to_string()
}
fn acct(path: &Path) -> String {
    json(path)["oauthAccount"]["emailAddress"].as_str().unwrap().to_string()
}
fn ok(email: &str) -> SwapResult {
    SwapResult::ok(Some(email.into()))
}
fn fail(e: SwapError) -> SwapResult {
    SwapResult::fail(e)
}

fn fail_rename_to(dest: PathBuf, times: usize, error: fn() -> io::Error) -> HookFs {
    let left = AtomicUsize::new(times);
    HookFs {
        rename: Some(Box::new(move |(from, to)| {
            if to == dest && left.load(Ordering::SeqCst) > 0 {
                left.fetch_sub(1, Ordering::SeqCst);
                return Err(error());
            }
            RealSwapFs.rename(&from, &to)
        })),
        ..Default::default()
    }
}

/// `renameHook`: `hook(to, n)` with `n` the 1-based count of renames onto `to`, before the real rename.
fn rename_hook(hook: impl Fn(&Path, usize) -> io::Result<()> + Send + Sync + 'static) -> HookFs {
    let seen = Mutex::new(HashMap::<PathBuf, usize>::new());
    HookFs {
        rename: Some(Box::new(move |(from, to)| {
            let n = {
                let mut seen = seen.lock();
                let n = seen.entry(to.clone()).or_default();
                *n += 1;
                *n
            };
            hook(&to, n)?;
            RealSwapFs.rename(&from, &to)
        })),
        ..Default::default()
    }
}

// ── accounts-swap.test.ts ────────────────────────────────────────────────────

#[test]
fn exchanges_the_logins_and_keeps_unrelated_keys() {
    let s = setup();
    let result = s.swap();
    assert_eq!(result, ok("x@x.com"));
    let mut main = creds("X");
    main["mcpOAuth"] = json!({ "server": "A" });
    assert_eq!(json(&s.live_creds()), main);
    assert_eq!(
        json(&s.live_json()),
        json!({ "oauthAccount": account("X", "x@x.com"), "projects": { "p": 1 }, "numStartups": 4 })
    );
    assert_eq!(json(&s.t_creds()), json!({ "claudeAiOauth": creds("A")["claudeAiOauth"], "mcpOAuth": { "server": "X" } }));
    assert_eq!(json(&s.t_json()), json!({ "oauthAccount": account("A", "a@x.com"), "theme": "dark" }));
    let first = s.first();
    assert_eq!(
        (first.id.as_str(), first.identity.email.as_deref(), first.identity.org.as_deref()),
        (ID, Some("a@x.com"), Some("Org A"))
    );
    assert!(!s.journal().exists());
    // live tokens must not linger after a verified swap
    assert_eq!(s.backup_files(), Vec::<String>::new());
    assert_eq!(s.temps(), Vec::<String>::new());
    assert!(!result.to_value().to_string().contains("tok-"));
    assert!(!s.slot.is_running());
}

#[test]
fn swapping_twice_restores_the_original_state() {
    let s = setup();
    let before = s.parsed();
    s.swap();
    assert_eq!(s.swap(), ok("a@x.com"));
    assert_eq!(s.parsed(), before);
    let first = s.first();
    assert_eq!((first.identity.email.as_deref(), first.identity.org.as_deref()), (Some("x@x.com"), Some("Org X")));
}

#[test]
fn derives_the_identity_from_the_account_entry_when_the_profile_has_no_claude_json() {
    let s = setup();
    std::fs::remove_file(s.t_json()).unwrap();
    assert_eq!(s.swap(), ok("x@x.com"));
    assert_eq!(json(&s.live_json())["oauthAccount"], json!({ "emailAddress": "x@x.com", "organizationName": "Org X" }));
}

#[test]
fn honours_claude_config_dir() {
    let s = setup();
    let custom = s.root.join("custom");
    put(&custom.join(".credentials.json"), &creds("A"));
    put(&custom.join(".claude.json"), &json!({ "oauthAccount": account("A", "a@x.com") }));
    std::fs::remove_dir_all(s.home.join(".claude")).unwrap();
    std::fs::remove_file(s.live_json()).unwrap();
    s.set_env(&[("CLAUDE_CONFIG_DIR", custom.to_str().unwrap())]);
    assert!(s.swap().ok);
    assert_eq!(json(&custom.join(".credentials.json"))["claudeAiOauth"]["accessToken"], "tok-X");
    assert_eq!(json(&custom.join(".claude.json"))["oauthAccount"]["emailAddress"], "x@x.com");
}

fn untouched(s: &S, error: SwapError, id: &str) {
    let before = s.snapshot();
    assert_eq!(swap_main_account(&s.deps(), id), fail(error));
    assert_eq!(s.snapshot(), before);
    assert_eq!(s.temps(), Vec::<String>::new());
}

#[test]
fn unsupported_platform() {
    let s = setup();
    *s.knobs.darwin.lock() = true;
    untouched(&s, SwapError::Unsupported, ID);
}

#[test]
fn invalid_id() {
    untouched(&setup(), SwapError::Invalid, "../x");
}

#[test]
fn env_token() {
    let s = setup();
    s.set_env(&[("CLAUDE_CODE_OAUTH_TOKEN", " t ")]);
    untouched(&s, SwapError::EnvToken, ID);
}

#[test]
fn no_main_credentials() {
    let s = setup();
    std::fs::remove_file(s.live_creds()).unwrap();
    assert_eq!(s.swap(), fail(SwapError::NoMain));
}

#[test]
fn main_without_refresh_token() {
    let s = setup();
    put(&s.live_creds(), &json!({ "claudeAiOauth": { "accessToken": "tok-A" } }));
    untouched(&s, SwapError::NoMain, ID);
}

#[test]
fn main_without_identity() {
    let s = setup();
    put(&s.live_json(), &json!({}));
    untouched(&s, SwapError::NoMain, ID);
}

#[test]
fn unknown_or_broken_target() {
    let s = setup();
    untouched(&s, SwapError::NoTarget, OTHER);
    std::fs::write(s.t_creds(), "{").unwrap();
    untouched(&s, SwapError::NoTarget, ID);
}

#[test]
fn same_account() {
    let s = setup();
    put(&s.t_json(), &json!({ "oauthAccount": account("A", "a@x.com") }));
    untouched(&s, SwapError::SameAccount, ID);
}

#[test]
fn same_account_by_e_mail_without_uuid() {
    let s = setup();
    put(&s.live_json(), &json!({ "oauthAccount": { "emailAddress": "X@x.com", "organizationName": "org x" } }));
    untouched(&s, SwapError::SameAccount, ID);
}

#[test]
fn duplicate_of_the_main_login_among_other_accounts() {
    let s = setup();
    s.store.commit(&record(OTHER, "A@X.com", "Org A", 2.0)).unwrap();
    put(&s.dir(OTHER).join(".credentials.json"), &creds("B"));
    untouched(&s, SwapError::Duplicate, ID);
}

#[test]
fn dead_login() {
    let s = setup();
    s.set_refresh(|_| RefreshOutcome::Dead);
    untouched(&s, SwapError::Dead, ID);
}

#[test]
fn transient_with_an_expired_token() {
    let s = setup();
    put(&s.t_creds(), &creds_at("X", NOW + 30_000.0));
    s.set_refresh(|_| RefreshOutcome::Transient(None));
    untouched(&s, SwapError::Transient, ID);
}

#[test]
fn refresh_that_throws_counts_as_transient() {
    let s = setup();
    put(&s.t_creds(), &creds_at("X", 1.0));
    s.set_refresh(|_| panic!("net"));
    untouched(&s, SwapError::Transient, ID);
}

#[test]
fn continues_on_a_transient_refresh_while_the_token_is_still_valid() {
    let s = setup();
    s.set_refresh(|_| RefreshOutcome::Transient(None));
    assert!(s.swap().ok);
}

#[test]
fn is_busy_while_another_swap_runs() {
    let s = setup();
    let (entered_tx, entered_rx) = std::sync::mpsc::channel::<()>();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let release_rx = Mutex::new(release_rx);
    let entered_tx = Mutex::new(entered_tx);
    s.set_refresh(move |_| {
        entered_tx.lock().send(()).unwrap();
        release_rx.lock().recv().unwrap();
        RefreshOutcome::Ok
    });
    let deps = s.deps();
    let first = std::thread::spawn(move || swap_main_account(&deps, ID));
    entered_rx.recv().unwrap();
    assert!(s.slot.is_running());
    assert_eq!(s.swap(), fail(SwapError::Busy));
    release_tx.send(()).unwrap();
    assert!(first.join().unwrap().ok);
}

fn fails_at(path: fn(&S) -> PathBuf) {
    let s = setup();
    let before = s.snapshot();
    let store_before = s.store.list();
    s.set_fs(fail_rename_to(path(&s), usize::MAX, eio));
    assert_eq!(s.swap(), fail(SwapError::Write));
    assert_eq!(s.snapshot(), before);
    assert_eq!(s.store.list(), store_before);
    assert_eq!(s.temps(), Vec::<String>::new());
    assert!(!s.journal().exists());
}

#[test]
fn fails_at_target_credentials() {
    fails_at(|s| s.t_creds());
}

#[test]
fn fails_at_target_claude_json() {
    fails_at(|s| s.t_json());
}

#[test]
fn fails_at_main_credentials() {
    fails_at(|s| s.live_creds());
}

#[test]
fn fails_at_main_claude_json() {
    fails_at(|s| s.live_json());
}

#[test]
fn removes_a_target_claude_json_that_did_not_exist() {
    let s = setup();
    std::fs::remove_file(s.t_json()).unwrap();
    s.set_fs(fail_rename_to(s.live_json(), usize::MAX, eio));
    assert_eq!(s.swap(), fail(SwapError::Write));
    assert!(!s.t_json().exists());
}

#[test]
fn retries_eperm_renames_and_succeeds() {
    let s = setup();
    s.set_fs(fail_rename_to(s.live_creds(), 3, eperm));
    assert!(s.swap().ok);
}

#[test]
fn gives_up_after_too_many_ebusy_failures() {
    let s = setup();
    let before = s.snapshot();
    s.set_fs(fail_rename_to(s.live_creds(), 6, ebusy));
    assert_eq!(s.swap(), fail(SwapError::Write));
    assert_eq!(s.snapshot(), before);
}

#[test]
fn fails_before_changing_anything_when_the_backup_cannot_be_written() {
    let s = setup();
    let before = s.snapshot();
    s.set_fs(HookFs { mkdir: Some(Box::new(|_| Err(io::Error::other("no")))), ..Default::default() });
    assert_eq!(s.swap(), fail(SwapError::Write));
    assert_eq!(s.snapshot(), before);
}

fn on_first_rename_to(dest: PathBuf, act: impl Fn() + Send + Sync + 'static) -> HookFs {
    let done = AtomicBool::new(false);
    HookFs {
        rename: Some(Box::new(move |(from, to)| {
            if to == dest && !done.swap(true, Ordering::SeqCst) {
                act();
            }
            RealSwapFs.rename(&from, &to)
        })),
        ..Default::default()
    }
}

#[test]
fn redoes_the_whole_pass_when_the_credentials_were_refreshed() {
    let s = setup();
    let main = s.live_creds();
    s.set_fs(on_first_rename_to(s.t_creds(), move || put(&main, &creds("A2"))));
    assert!(s.swap().ok);
    assert_eq!(token(&s.t_creds()), "tok-A2");
    assert_eq!(token(&s.live_creds()), "tok-X");
    assert_eq!(s.temps(), Vec::<String>::new());
}

#[test]
fn recomputes_claude_json_from_the_fresh_content() {
    let s = setup();
    let main_json = s.live_json();
    s.set_fs(on_first_rename_to(s.live_creds(), move || {
        put(&main_json, &json!({ "oauthAccount": account("A", "a@x.com"), "projects": { "p": 1 }, "added": "new-field" }))
    }));
    assert!(s.swap().ok);
    let j = json(&s.live_json());
    assert_eq!(j["added"], "new-field");
    assert_eq!(j["oauthAccount"]["emailAddress"], "x@x.com");
}

#[test]
fn gives_up_with_write_and_rolls_back_when_the_file_keeps_changing() {
    let s = setup();
    let before = s.snapshot();
    let n = AtomicUsize::new(0);
    let main_json = s.live_json();
    s.set_fs(HookFs {
        stat: Some(Box::new(move |p| {
            let st = RealSwapFs.stat(&p)?;
            Ok(if p == main_json {
                st.map(|st| FileStat { size: st.size + n.fetch_add(1, Ordering::SeqCst) as u64, ..st })
            } else {
                st
            })
        })),
        ..Default::default()
    });
    assert_eq!(s.swap(), fail(SwapError::Write));
    assert_eq!(s.snapshot(), before);
    assert_eq!(s.temps(), Vec::<String>::new());
}

use crate::swapfs::FileStat;

// ── accounts-swap-recovery.test.ts ───────────────────────────────────────────

#[test]
fn does_nothing_without_a_journal() {
    assert_eq!(rsetup().recover(), Recovery::None);
}

#[test]
fn keeps_both_logins_when_claude_code_rotated_main_after_a_swap_that_died_late() {
    let s = rsetup();
    s.crashed("main-json-written");
    // After the swap main holds X and the target profile holds A; Claude Code then rotated main's token.
    put(&s.live_creds(), &rcreds("X2"));
    let before = s.snapshot();
    let files = s.backup_files();
    assert_eq!(s.recover(), Recovery::Manual);
    assert_eq!(s.snapshot(), before);
    assert_eq!(token(&s.t_creds()), "tok-A");
    assert_eq!(token(&s.live_creds()), "tok-X2");
    assert_eq!(s.backup_files(), files);
    assert!(s.journal().exists());
}

#[test]
fn modifies_nothing_when_neither_file_can_be_attributed() {
    let s = rsetup();
    s.crashed("main-creds-written");
    put(&s.live_creds(), &rcreds("M9"));
    put(&s.t_creds(), &rcreds("T9"));
    let before = s.snapshot();
    assert_eq!(s.recover(), Recovery::Manual);
    assert_eq!(s.snapshot(), before);
    assert!(s.journal().exists());
}

#[test]
fn never_counts_an_empty_credentials_file_as_ours() {
    let s = rsetup();
    s.crashed("main-creds-written");
    put(&s.live_creds(), &json!({}));
    let before = s.snapshot();
    assert_eq!(s.recover(), Recovery::Manual);
    assert_eq!(s.snapshot(), before);
}

#[test]
fn rolls_back_when_the_credentials_are_in_their_original_positions() {
    let s = rsetup();
    s.crashed("target-written");
    original(&s);
    put(&s.t_json(), &json!({ "oauthAccount": account("A", "a@x.com"), "theme": "dark" })); // target identity was already written
    assert_eq!(s.recover(), Recovery::Recovered);
    assert_eq!(token(&s.live_creds()), "tok-A");
    assert_eq!(token(&s.t_creds()), "tok-X");
    assert_eq!(acct(&s.t_json()), "x@x.com");
    assert_eq!(json(&s.t_json())["theme"], "dark");
    assert_eq!(s.backup_files(), Vec::<String>::new());
}

#[test]
fn restores_the_target_login_when_only_its_copy_of_main_was_written() {
    let s = rsetup();
    s.crashed("main-creds-written");
    original(&s);
    put(&s.t_creds(), &rcreds("A")); // target holds a copy of main's blob, main untouched
    assert_eq!(s.recover(), Recovery::Recovered);
    assert_eq!(token(&s.live_creds()), "tok-A");
    assert_eq!(token(&s.t_creds()), "tok-X");
    assert_eq!(json(&s.t_creds())["mcpOAuth"], json!({ "server": "A" })); // only the oauth key was written
    assert_eq!(s.backup_files(), Vec::<String>::new());
}

#[test]
fn completes_an_exchange_whose_identity_half_is_missing() {
    let s = rsetup();
    s.crashed("main-json-written");
    put(&s.live_json(), &json!({ "oauthAccount": account("A", "a@x.com"), "projects": { "p": 2 } }));
    put(&s.t_json(), &json!({ "oauthAccount": account("X", "x@x.com"), "theme": "dark" }));
    assert_eq!(s.recover(), Recovery::Recovered);
    assert_eq!(token(&s.live_creds()), "tok-X");
    assert_eq!(token(&s.t_creds()), "tok-A");
    assert_eq!(acct(&s.live_json()), "x@x.com");
    assert_eq!(json(&s.live_json())["projects"], json!({ "p": 2 }));
    assert_eq!(acct(&s.t_json()), "a@x.com");
    assert_eq!(s.first().identity.email.as_deref(), Some("a@x.com"));
    assert_eq!(s.backup_files(), Vec::<String>::new());
}

#[test]
fn only_removes_the_backup_after_a_verified_swap() {
    let s = rsetup();
    s.crashed("verified");
    let before = s.snapshot();
    assert_eq!(s.recover(), Recovery::None);
    assert_eq!(s.snapshot(), before);
    assert_eq!(s.backup_files(), Vec::<String>::new());
}

#[test]
fn reports_a_corrupt_journal_and_keeps_everything() {
    let s = rsetup();
    std::fs::create_dir_all(s.backup_dir()).unwrap();
    std::fs::write(s.journal(), "nope").unwrap();
    assert_eq!(s.recover(), Recovery::Manual);
    assert!(s.journal().exists());
}

#[test]
fn does_not_guess_when_claude_code_rotated_main_after_our_write_and_a_later_step_fails() {
    let s = rsetup();
    let (main_json, main) = (s.live_json(), s.live_creds());
    s.set_fs(rename_hook(move |to, _| {
        if to == main_json {
            put(&main, &rcreds("X2"));
            return Err(eio());
        }
        Ok(())
    }));
    assert_eq!(s.swap(), fail(SwapError::Manual));
    // main keeps what Claude Code wrote, the target keeps the old main login; X1 stays recoverable from the backup
    assert_eq!(token(&s.live_creds()), "tok-X2");
    assert_eq!(token(&s.t_creds()), "tok-A");
    assert_eq!(json(&s.backup_dir().join("target-credentials.json"))["claudeAiOauth"]["accessToken"], "tok-X");
    assert!(s.journal().exists());
}

#[test]
fn s2_a_refresh_result_written_into_main_right_after_our_write_makes_the_outcome_manual() {
    let s = rsetup();
    let first = AtomicBool::new(true);
    let main = s.live_creds();
    s.set_delay(move |_| {
        if first.swap(false, Ordering::SeqCst) {
            put(&main, &rcreds("A2"));
        }
    });
    assert_eq!(s.swap(), fail(SwapError::Manual));
    assert_eq!(token(&s.live_creds()), "tok-A2");
    assert_eq!(token(&s.t_creds()), "tok-A");
    assert_eq!(json(&s.backup_dir().join("target-credentials.json"))["claudeAiOauth"]["accessToken"], "tok-X");
    assert_eq!(json(&s.backup_dir().join("main-credentials.json"))["claudeAiOauth"]["accessToken"], "tok-A");
    assert!(s.journal().exists());
}

#[test]
fn s2b_the_same_after_the_main_identity_was_written() {
    let s = rsetup();
    let calls = AtomicUsize::new(0);
    let main = s.live_creds();
    s.set_delay(move |_| {
        if calls.fetch_add(1, Ordering::SeqCst) + 1 == 2 {
            put(&main, &rcreds("X2"));
        }
    });
    assert_eq!(s.swap(), fail(SwapError::Manual));
    assert_eq!(token(&s.live_creds()), "tok-X2");
    assert!(s.journal().exists());
    assert!(s.backup_files().contains(&"target-credentials.json".to_string()));
}

fn backup_texts(s: &S) -> Vec<(String, String)> {
    s.backup_files().into_iter().map(|n| (n.clone(), text(&s.backup_dir().join(&n)).unwrap())).collect()
}

#[test]
fn blocks_a_second_swap_while_an_unresolved_one_left_its_journal_and_backups() {
    let s = rsetup();
    let (main_json, main) = (s.live_json(), s.live_creds());
    s.set_fs(rename_hook(move |to, n| {
        if to == main_json {
            return Err(eio());
        }
        if to == main && n >= 2 {
            return Err(ebusy());
        }
        Ok(())
    }));
    assert_eq!(s.swap(), fail(SwapError::Manual));
    s.real_fs();
    let before = s.snapshot();
    let files = backup_texts(&s);
    // T1: the old main login is still live in the target profile, the target login only in main (never duplicated)
    assert_eq!(token(&s.live_creds()), "tok-X");
    assert_eq!(token(&s.t_creds()), "tok-A");
    assert_eq!(json(&s.backup_dir().join("main-credentials.json"))["claudeAiOauth"]["accessToken"], "tok-A");
    assert_eq!(json(&s.backup_dir().join("target-credentials.json"))["claudeAiOauth"]["accessToken"], "tok-X");
    assert_eq!(s.swap(), fail(SwapError::Pending));
    assert_eq!(s.snapshot(), before);
    assert_eq!(backup_texts(&s), files);
    assert!(has_pending_swap(&RealSwapFs, &s.backup_dir()).unwrap());
    // the user clears it deliberately
    assert!(clear_pending_swap(&s.deps()));
    assert!(!s.backup_dir().exists());
    assert!(!has_pending_swap(&RealSwapFs, &s.backup_dir()).unwrap());
}

#[test]
fn stops_after_an_unclean_rollback_no_retry_backup_and_journal_kept_nothing_lost() {
    let s = rsetup();
    let calls = Arc::new(Mutex::new(Vec::new()));
    let (c2, t_creds, main_json, main) = (calls.clone(), s.t_creds(), s.live_json(), s.live_creds());
    s.set_fs(rename_hook(move |to, n| {
        if to == t_creds {
            c2.lock().push(n);
            if n == 1 {
                put(&main, &rcreds("A2"));
            }
            if n == 3 {
                return Err(eio());
            }
        }
        if to == main_json {
            return Err(eio());
        }
        Ok(())
    }));
    // n=1: forward write (main refreshed meanwhile, guard trips), n=2: forward again, n=3: the rollback write fails.
    assert_eq!(s.swap(), fail(SwapError::Manual));
    // the displaced blob (A, rotated to A2) is written back into the target at once (n=4); X is never duplicated
    assert_eq!(*calls.lock(), vec![1, 2, 3, 4]);
    assert_eq!(token(&s.live_creds()), "tok-X");
    assert_eq!(token(&s.t_creds()), "tok-A2");
    assert_eq!(json(&s.backup_dir().join("main-credentials.json"))["claudeAiOauth"]["accessToken"], "tok-A2");
    assert_eq!(json(&s.backup_dir().join("target-credentials.json"))["claudeAiOauth"]["accessToken"], "tok-X");
    assert!(s.journal().exists());
    assert_eq!(json(&s.journal())["phase"], "rolling-back");
    assert!(s.backup_files().contains(&"main-credentials.json".to_string()));
    assert!(!text(&s.journal()).unwrap().contains("tok-"));
}

#[test]
fn re_checks_the_shared_file_before_every_rename_retry() {
    let s = rsetup();
    let main = s.live_creds();
    let m2 = main.clone();
    s.set_fs(rename_hook(move |to, n| {
        if to == m2 && n == 1 {
            put(&m2, &rcreds("A2"));
            return Err(eperm());
        }
        Ok(())
    }));
    assert!(s.swap().ok);
    assert_eq!(token(&s.t_creds()), "tok-A2");
    assert_eq!(token(&main), "tok-X");
}

#[test]
fn removes_the_backup_after_a_clean_failure() {
    let s = rsetup();
    let main_json = s.live_json();
    s.set_fs(rename_hook(move |to, _| if to == main_json { Err(eio()) } else { Ok(()) }));
    assert_eq!(s.swap(), fail(SwapError::Write));
    assert_eq!(s.backup_files(), Vec::<String>::new());
    assert_eq!(token(&s.live_creds()), "tok-A");
    assert_eq!(token(&s.t_creds()), "tok-X");
}

#[test]
fn refuses_a_relative_claude_config_dir() {
    let s = rsetup();
    s.set_env(&[("CLAUDE_CONFIG_DIR", "relative/dir")]);
    assert_eq!(s.swap(), fail(SwapError::NoMain));
}

#[test]
fn treats_an_unknown_organisation_as_the_same_account() {
    let s = rsetup();
    put(&s.live_json(), &json!({ "oauthAccount": { "emailAddress": "x@x.com" } }));
    assert_eq!(s.swap(), fail(SwapError::SameAccount));
}

#[test]
fn completes_a_target_account_object_that_has_no_e_mail_from_the_stored_entry() {
    let s = rsetup();
    put(&s.t_json(), &json!({ "oauthAccount": { "accountUuid": "uuid-X" } }));
    assert_eq!(s.swap(), ok("x@x.com"));
    assert_eq!(acct(&s.live_json()), "x@x.com");
}

#[test]
fn deletes_stray_backups_when_there_is_no_journal_and_only_our_own_stale_temp_files() {
    let s = rsetup();
    std::fs::create_dir_all(s.backup_dir()).unwrap();
    std::fs::write(s.backup_dir().join("main-credentials.json"), js_json::stringify(&rcreds("A"))).unwrap();
    let uuid = "123e4567-e89b-42d3-a456-426614174000";
    let stale = [
        s.home.join(".claude").join(format!(".credentials.json.{uuid}.tmp")),
        s.home.join(format!(".claude.json.{uuid}.tmp")),
        s.dir(ID).join(format!(".credentials.json.{uuid}.tmp")),
    ];
    let keep = [s.home.join(".claude").join("notes.tmp"), s.home.join(".claude").join(".credentials.json.backup.tmp")];
    for f in stale.iter().chain(keep.iter()) {
        std::fs::write(f, "x").unwrap();
    }
    let before = s.snapshot();
    assert_eq!(s.recover(), Recovery::None);
    assert!(!s.backup_dir().exists());
    for f in &stale {
        assert!(!f.exists(), "{f:?}");
    }
    for f in &keep {
        assert!(f.exists(), "{f:?}");
    }
    assert_eq!(s.snapshot(), before);
}

#[test]
fn keeps_temp_files_while_an_unresolved_journal_exists() {
    let s = rsetup();
    s.crashed("main-creds-written");
    put(&s.live_creds(), &rcreds("M9"));
    put(&s.t_creds(), &rcreds("T9"));
    let stale = s.home.join(".claude").join(".credentials.json.123e4567-e89b-42d3-a456-426614174000.tmp");
    std::fs::write(&stale, "x").unwrap();
    assert_eq!(s.recover(), Recovery::Manual);
    assert!(stale.exists());
}

#[test]
fn forward_a2_in_main_and_target_the_target_gets_its_own_login_back_from_the_backup() {
    let s = rsetup();
    s.crashed("main-creds-written");
    put(&s.live_creds(), &rcreds("A2"));
    put(&s.t_creds(), &rcreds("A2"));
    assert_eq!(s.recover(), Recovery::Recovered);
    assert_eq!(token(&s.live_creds()), "tok-A2");
    assert_eq!(token(&s.t_creds()), "tok-X");
    assert_eq!(acct(&s.live_json()), "a@x.com");
    assert_eq!(acct(&s.t_json()), "x@x.com");
    assert_eq!(s.backup_files(), Vec::<String>::new());
}

#[test]
fn reverse_x_in_both_the_old_main_login_returns_to_the_target_from_the_backup() {
    let s = rsetup();
    s.crashed("rolling-back");
    put(&s.t_creds(), &rcreds("X"));
    assert_eq!(s.recover(), Recovery::Recovered);
    assert_eq!(token(&s.live_creds()), "tok-X");
    assert_eq!(token(&s.t_creds()), "tok-A");
    assert_eq!(acct(&s.live_json()), "x@x.com");
    assert_eq!(acct(&s.t_json()), "a@x.com");
}

#[test]
fn deletes_the_journal_before_the_backup_files() {
    let s = rsetup();
    let order = Arc::new(Mutex::new(Vec::new()));
    let o2 = order.clone();
    s.set_fs(HookFs {
        rm: Some(Box::new(move |p| {
            if p.to_string_lossy().contains("swap-backup") {
                o2.lock().push(p.file_name().unwrap().to_string_lossy().into_owned());
            }
            RealSwapFs.rm(&p)
        })),
        ..Default::default()
    });
    assert!(s.swap().ok);
    assert_eq!(order.lock()[0], "swap-journal.json");
}

/// Shared helper of the stale-write cases: renames pass, and after the main identity was renamed into place `on_read` may
/// change what a read of `watched` sees.
fn stale_fs(
    main_json: PathBuf,
    on_read: impl Fn(&Path, &str, usize) -> Option<String> + Send + Sync + 'static,
    watched: PathBuf,
) -> HookFs {
    let armed = Arc::new(AtomicBool::new(false));
    let reads = AtomicUsize::new(0);
    let a2 = armed.clone();
    HookFs {
        rename: Some(Box::new(move |(from, to)| {
            RealSwapFs.rename(&from, &to)?;
            if to == main_json {
                a2.store(true, Ordering::SeqCst);
            }
            Ok(())
        })),
        read_file: Some(Box::new(move |p| {
            let t = RealSwapFs.read_file(&p)?;
            if armed.load(Ordering::SeqCst) && p == watched {
                let n = reads.fetch_add(1, Ordering::SeqCst) + 1;
                if let Some(replaced) = on_read(&p, t.as_deref().unwrap_or(""), n) {
                    return Ok(Some(replaced));
                }
            }
            Ok(t)
        })),
        ..Default::default()
    }
}

#[test]
fn a_stale_a_blob_written_into_main_after_the_settle_read_leaves_a_manual_state_that_recovery_does_not_touch() {
    let s = rsetup();
    let main = s.live_creds();
    s.set_fs(stale_fs(
        s.live_json(),
        move |p, _, n| {
            if n == 1 {
                put(p, &rcreds("A")); // Claude Code writes its unrotated A blob
            }
            None
        },
        main,
    ));
    assert_eq!(s.swap(), fail(SwapError::Manual));
    s.real_fs();
    assert_eq!(acct(&s.t_json()), "a@x.com"); // the profile holding A is not relabelled X
    let before = s.snapshot();
    assert_eq!(s.recover(), Recovery::Manual);
    assert_eq!(s.snapshot(), before);
    assert_eq!(json(&s.backup_dir().join("target-credentials.json"))["claudeAiOauth"]["accessToken"], "tok-X");
    assert_eq!(json(&s.journal())["phase"], "rolling-back");
    for n in ["main-credentials.json", "target-credentials.json", "swap-journal.json"] {
        assert!(s.backup_files().contains(&n.to_string()));
    }
    assert!(s.slot.is_unresolved());
}

#[test]
fn keeps_the_backups_when_main_changed_between_verification_and_cleanup() {
    let s = rsetup();
    let main = s.live_creds();
    s.set_fs(stale_fs(s.live_json(), |_, _, n| (n == 3).then(|| js_json::stringify(&rcreds("X2"))), main));
    assert_eq!(s.swap(), fail(SwapError::Manual));
    assert_ne!(json(&s.journal())["phase"], "verified");
    assert!(s.backup_files().contains(&"main-credentials.json".to_string()));
}

#[test]
fn does_not_declare_the_swap_done_when_main_claude_json_was_overwritten_with_the_old_identity_after_verification() {
    let s = rsetup();
    let main_json = s.live_json();
    s.set_fs(stale_fs(
        s.live_json(),
        |_, _, n| (n == 2).then(|| js_json::stringify(&json!({ "oauthAccount": account("A", "a@x.com") }))),
        main_json,
    ));
    assert_eq!(s.swap(), fail(SwapError::Manual));
    assert_ne!(json(&s.journal())["phase"], "verified");
    assert!(s.backup_files().contains(&"target-credentials.json".to_string()));
}

#[test]
fn a_completed_swap_stays_ok_when_cleanup_fails_the_label_is_already_fixed_and_the_next_start_cleans_up() {
    let s = rsetup();
    s.set_fs(HookFs {
        rm: Some(Box::new(|p| if p.to_string_lossy().contains("swap-backup") { Err(eio()) } else { RealSwapFs.rm(&p) })),
        ..Default::default()
    });
    assert_eq!(s.swap(), ok("x@x.com"));
    assert_eq!(s.first().identity.email.as_deref(), Some("a@x.com"));
    assert_eq!(json(&s.journal())["phase"], "verified");
    s.real_fs();
    assert_eq!(s.recover(), Recovery::None);
    assert_eq!(s.backup_files(), Vec::<String>::new());
}

#[test]
fn cleans_a_verified_journal_whose_backups_are_already_gone() {
    let s = rsetup();
    s.crashed("verified");
    for n in s.backup_files() {
        if n != "swap-journal.json" {
            std::fs::remove_file(s.backup_dir().join(n)).unwrap();
        }
    }
    assert_eq!(s.recover(), Recovery::None);
    assert_eq!(s.backup_files(), Vec::<String>::new());
}

#[test]
fn does_not_delete_the_backups_of_a_verified_swap_when_main_holds_the_old_main_login_again() {
    let s = rsetup();
    s.crashed("verified");
    put(&s.live_creds(), &rcreds("A"));
    let before = s.snapshot();
    assert_eq!(s.recover(), Recovery::Manual);
    assert_eq!(s.snapshot(), before);
    assert!(s.backup_files().contains(&"target-credentials.json".to_string()));
}

#[test]
fn fixes_the_account_label_when_the_process_died_after_the_verified_marker() {
    let s = rsetup();
    s.crashed("verified");
    s.store.update(ID, Some(Some("x@x.com")), Some(Some("Org X"))).unwrap();
    assert_eq!(s.recover(), Recovery::None);
    let first = s.first();
    assert_eq!((first.identity.email.as_deref(), first.identity.org.as_deref()), (Some("a@x.com"), Some("Org A")));
    assert_eq!(s.backup_files(), Vec::<String>::new());
}

#[test]
fn aborts_with_write_before_any_write_when_a_file_cannot_be_read_not_absent() {
    let s = rsetup();
    let before = s.snapshot();
    let main = s.live_creds();
    s.set_fs(HookFs {
        read_file: Some(Box::new(move |p| if p == main { Err(eio()) } else { RealSwapFs.read_file(&p) })),
        ..Default::default()
    });
    assert_eq!(s.swap(), fail(SwapError::Write));
    s.real_fs();
    assert_eq!(s.snapshot(), before);
    assert!(!s.backup_dir().exists());
}

#[test]
fn flags_an_unresolved_swap_synchronously_for_background_refreshes() {
    let s = rsetup();
    let armed = Arc::new(AtomicBool::new(false));
    let (a2, main_json, main) = (armed.clone(), s.live_json(), s.live_creds());
    s.set_fs(HookFs {
        rename: Some(Box::new(move |(from, to)| {
            RealSwapFs.rename(&from, &to)?;
            if to == main_json {
                a2.store(true, Ordering::SeqCst);
            }
            Ok(())
        })),
        read_file: Some(Box::new(move |p| {
            let t = RealSwapFs.read_file(&p)?;
            if p == main && armed.swap(false, Ordering::SeqCst) {
                put(&main, &rcreds("Z"));
            }
            Ok(t)
        })),
        ..Default::default()
    });
    assert_eq!(s.swap(), fail(SwapError::Manual));
    assert!(s.slot.is_unresolved());
    s.real_fs();
    assert!(clear_pending_swap(&s.deps()));
    assert!(!s.slot.is_unresolved());
}

#[test]
fn recognises_only_uuid_temp_names() {
    assert!(is_uuid_tmp("x.123e4567-e89b-42d3-a456-426614174000.tmp"));
    assert!(!is_uuid_tmp("123e4567-e89b-42d3-a456-426614174000.tmp"));
    assert!(!is_uuid_tmp("x.123E4567-e89b-42d3-a456-426614174000.tmp"));
    assert!(is_own_temp(".claude.json.123e4567-e89b-42d3-a456-426614174000.tmp"));
    assert!(!is_own_temp(".credentials.json.backup.tmp"));
    assert!(!is_own_temp("a.claude.json.123e4567-e89b-42d3-a456-426614174000.tmp"));
}
