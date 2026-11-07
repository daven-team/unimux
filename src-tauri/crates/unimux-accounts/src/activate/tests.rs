//! Ports of test/accounts-activate.test.ts (the A2 cases; reconcile, resync, claudeRefs and fetchClaude come with A3 / A5).

use super::*;
use crate::identity::Custody;
use crate::swapfs::RealSwapFs;
use crate::test_support::*;
use parking_lot::Mutex;
use serde_json::json;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

const NOW: f64 = 1_792_152_000_000.0; // 2026-10-16T12:00:00Z
const FUTURE: f64 = NOW + 3_600_000.0;

fn creds(n: &str, expires_at: f64) -> Value {
    json!({ "claudeAiOauth": { "accessToken": format!("fake-acc-{n}"), "refreshToken": format!("fake-ref-{n}"), "expiresAt": js::num(expires_at), "scopes": ["s"] }, "mcpOAuth": { "server": n } })
}
fn account(n: &str, email: &str) -> Value {
    json!({ "emailAddress": email, "organizationName": format!("Org {n}"), "accountUuid": format!("uuid-{n}"), "organizationUuid": format!("org-{n}") })
}
fn ident(email: &str, uuid: &str, org: &str) -> AccountIdentity {
    AccountIdentity { email: Some(email.into()), account_uuid: Some(uuid.into()), organization_uuid: Some(org.into()), org: None }
}

struct T {
    fx: Fx,
    a: String,
    t: String,
}

impl std::ops::Deref for T {
    type Target = Fx;
    fn deref(&self) -> &Fx {
        &self.fx
    }
}

fn setup() -> T {
    let fx = Fx::new(NOW);
    put(&fx.live_creds(), &creds("A", FUTURE));
    put(&fx.live_json(), &json!({ "oauthAccount": account("A", "a@x.com"), "projects": { "p": 1 }, "numStartups": 4 }));
    let a = fx.store.prepare().unwrap().0;
    fx.store
        .commit(&ManagedAccount {
            id: a.clone(),
            added_at: 1.0,
            identity: ident("a@x.com", "uuid-A", "org-A"),
            custody: Some(Custody::Live),
            family: Some(TokenFamily::Live),
            ..Default::default()
        })
        .unwrap();
    let t = fx.store.prepare().unwrap().0;
    fx.store
        .commit(&ManagedAccount {
            id: t.clone(),
            added_at: 2.0,
            identity: ident("x@x.com", "uuid-X", "org-X"),
            custody: Some(Custody::App),
            family: Some(TokenFamily::Own),
            ..Default::default()
        })
        .unwrap();
    put(&fx.dir(&t).join(".credentials.json"), &creds("X", FUTURE));
    put(&fx.dir(&t).join(".claude.json"), &json!({ "oauthAccount": account("X", "x@x.com"), "theme": "dark" }));
    fx.store.set_live(Some(&LiveIdentity { identity: ident("a@x.com", "uuid-A", "org-A"), record_id: Some(a.clone()) })).unwrap();
    T { fx, a, t }
}

impl T {
    fn files(&self) -> Vec<PathBuf> {
        vec![
            self.live_creds(),
            self.live_json(),
            self.dir(&self.a).join(".credentials.json"),
            self.dir(&self.a).join(".claude.json"),
            self.dir(&self.t).join(".credentials.json"),
        ]
    }
    fn snapshot(&self) -> Vec<Option<String>> {
        self.files().iter().map(|p| text(p)).collect()
    }
    fn activate(&self, id: &str) -> SwapResult {
        activate_account(&self.deps(), id)
    }
    fn get(&self, id: &str) -> ManagedAccount {
        self.store.get(id).unwrap()
    }
}

fn ok(email: &str) -> SwapResult {
    SwapResult::ok(Some(email.into()))
}
fn refused(e: SwapError, email: Option<&str>) -> SwapResult {
    SwapResult::fail_named(e, email.map(Into::into))
}
fn custody(r: &ManagedAccount) -> Custody {
    custody_of(r.custody)
}
fn listed(names: &[&str]) -> CswapRoster {
    CswapRoster::Present(Some(
        names
            .iter()
            .map(|n| AccountIdentity {
                email: Some(format!("{n}@x.com")),
                account_uuid: Some(format!("uuid-{}", n.to_uppercase())),
                ..Default::default()
            })
            .collect(),
    ))
}

/// A rename hook that fails `to == path` the first `times` times.
fn fail_rename(path: PathBuf, times: usize) -> HookFs {
    let left = AtomicUsize::new(times);
    HookFs {
        rename: Some(Box::new(move |(from, to)| {
            if to == path && left.load(Ordering::SeqCst) > 0 {
                left.fetch_sub(1, Ordering::SeqCst);
                return Err(eio());
            }
            RealSwapFs.rename(&from, &to)
        })),
        ..Default::default()
    }
}

#[test]
fn saves_the_outgoing_live_login_to_its_record_writes_the_target_into_claude_code_and_moves_the_roles() {
    let s = setup();
    let result = s.activate(&s.t);
    assert_eq!(result, ok("x@x.com"));
    let mut expected = creds("X", FUTURE);
    expected["mcpOAuth"] = json!({ "server": "A" });
    assert_eq!(json(&s.live_creds()), expected);
    assert_eq!(
        json(&s.live_json()),
        json!({ "oauthAccount": account("X", "x@x.com"), "projects": { "p": 1 }, "numStartups": 4 })
    );
    assert_eq!(json(&s.dir(&s.a).join(".credentials.json"))["claudeAiOauth"], creds("A", FUTURE)["claudeAiOauth"]);
    assert_eq!(json(&s.dir(&s.a).join(".claude.json"))["oauthAccount"], account("A", "a@x.com"));
    assert_eq!(json(&s.dir(&s.t).join(".credentials.json")), creds("X", FUTURE)); // the target keeps its copy as a backup
    assert_eq!((custody(&s.get(&s.a)), s.get(&s.a).family), (Custody::App, Some(TokenFamily::Live)));
    assert_eq!(custody(&s.get(&s.t)), Custody::Live);
    assert_eq!(s.store.live().unwrap().record_id.as_deref(), Some(s.t.as_str()));
    assert_eq!(names(&s.backup_dir()), Vec::<String>::new());
    assert_eq!(s.locks_present(), [false, false, false]);
    assert!(!result.to_value().to_string().contains("fake-"));
    // Byte layout as 1.1.4 writes it: credentials compact, .claude.json with 2 spaces.
    assert_eq!(
        text(&s.live_creds()).unwrap(),
        r#"{"claudeAiOauth":{"accessToken":"fake-acc-X","refreshToken":"fake-ref-X","expiresAt":1792155600000,"scopes":["s"]},"mcpOAuth":{"server":"A"}}"#
    );
    assert!(text(&s.live_json()).unwrap().starts_with("{\n  \"oauthAccount\": {\n    \"emailAddress\": \"x@x.com\""));
}

#[test]
fn creates_a_record_for_an_outgoing_account_the_app_did_not_know_a_login_is_never_dropped() {
    let s = setup();
    s.store.remove(&s.a).unwrap();
    assert!(s.activate(&s.t).ok);
    let probe =
        AccountIdentity { account_uuid: Some("uuid-A".into()), organization_uuid: Some("org-A".into()), ..Default::default() };
    let outgoing: Vec<_> =
        s.store.list().into_iter().filter(|r| compare_identity(&r.identity, &probe) == IdentityMatch::Same).collect();
    assert_eq!(outgoing.len(), 1);
    assert_eq!(custody(&outgoing[0]), Custody::App);
    assert_eq!(json(&s.dir(&outgoing[0].id).join(".credentials.json"))["claudeAiOauth"]["refreshToken"], "fake-ref-A");
}

#[test]
fn is_not_blocked_by_an_unrelated_duplicate() {
    let s = setup();
    let dup = s.store.prepare().unwrap().0;
    s.store
        .commit(&ManagedAccount {
            id: dup,
            added_at: 3.0,
            identity: ident("a@x.com", "uuid-A", "org-A"),
            custody: Some(Custody::Quarantined),
            duplicate_of: Some(s.a.clone()),
            ..Default::default()
        })
        .unwrap();
    assert!(s.activate(&s.t).ok);
}

#[test]
fn does_not_renew_a_target_whose_token_is_valid_for_more_than_5_minutes() {
    let s = setup();
    assert!(s.activate(&s.t).ok);
    assert!(s.refresh_calls().is_empty());
}

#[test]
fn renews_a_target_that_expires_in_2_minutes_and_reports_dead_with_the_e_mail() {
    let s = setup();
    put(&s.dir(&s.t).join(".credentials.json"), &creds("X", NOW + 2.0 * 60_000.0));
    s.set_refresh(|_| RefreshOutcome::Dead);
    assert_eq!(s.activate(&s.t), refused(SwapError::Dead, Some("x@x.com")));
    assert_eq!(s.refresh_calls().len(), 1);
}

#[test]
fn refuses_a_switched_out_target_and_a_stale_copy_cswap_also_holds_but_swaps_an_own_family_cswap_lists() {
    let s = setup();
    s.store.set_custody(&s.t, Custody::Foreign, None).unwrap();
    assert_eq!(s.activate(&s.t), refused(SwapError::Foreign, Some("x@x.com")));
    s.store.set_custody(&s.t, Custody::App, None).unwrap();
    s.set_roster(listed(&["x"]));
    s.store.set_family(&s.t, TokenFamily::Live).unwrap();
    put(&s.dir(&s.t).join(".credentials.json"), &creds("X", NOW + 2.0 * 60_000.0));
    assert_eq!(s.activate(&s.t), refused(SwapError::Foreign, Some("x@x.com")));
    s.store.set_family(&s.t, TokenFamily::Own).unwrap();
    assert!(s.activate(&s.t).ok);
}

#[test]
fn swaps_in_a_fresh_copy_cswap_also_holds_without_any_token_request_and_refuses_a_stale_one_with_foreign() {
    let s = setup();
    s.set_roster(listed(&["x"]));
    s.store.set_family(&s.t, TokenFamily::Live).unwrap();
    put(&s.dir(&s.t).join(".credentials.json"), &creds("X", NOW + 4.0 * 60_000.0)); // would need renewing: refused, no request
    assert_eq!(s.activate(&s.t), refused(SwapError::Foreign, Some("x@x.com")));
    assert!(s.refresh_calls().is_empty());
    assert_eq!(json(&s.live_creds())["claudeAiOauth"]["refreshToken"], "fake-ref-A");
    put(&s.dir(&s.t).join(".credentials.json"), &creds("X", FUTURE)); // valid for an hour: only files move
    assert_eq!(s.activate(&s.t), ok("x@x.com"));
    assert!(s.refresh_calls().is_empty());
    assert_eq!(json(&s.live_creds())["claudeAiOauth"]["refreshToken"], "fake-ref-X");
    assert_eq!((custody(&s.get(&s.a)), s.get(&s.a).family), (Custody::App, Some(TokenFamily::Live)));
    assert_eq!((custody(&s.get(&s.t)), s.get(&s.t).family), (Custody::Live, Some(TokenFamily::Live)));
}

/// A2 half of "the target takes the live family ... (I1)": the reconcile of the own change is A3's; here the record that left
/// (app custody, live family, listed by cswap) is checked against the rule.
#[test]
fn the_target_takes_the_live_family_and_is_never_renewable_while_cswap_lists_it() {
    let s = setup();
    let roster = listed(&["x"]);
    s.set_roster(roster.clone());
    assert!(s.activate(&s.t).ok);
    assert_eq!(s.get(&s.t).family, Some(TokenFamily::Live));
    // What A3's reconcile does for an own change (main re-login as G): T becomes `app`, G is live.
    s.store.set_custody(&s.t, Custody::App, None).unwrap();
    let g = LiveIdentity { identity: ident("g@x.com", "uuid-G", "org-G"), record_id: None };
    assert_eq!(renew_rule(&s.get(&s.t), Some(&g), &roster), RenewRule::HeldByCswap);
}

#[test]
fn holds_claude_codes_locks_for_every_write_into_claude_codes_files() {
    let s = setup();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (seen2, locks, creds_p, json_p) = (seen.clone(), s.lock_dirs(), s.live_creds(), s.live_json());
    s.set_fs(HookFs {
        rename: Some(Box::new(move |(from, to)| {
            if to == creds_p || to == json_p {
                seen2.lock().push(locks.iter().all(|l| l.exists()));
            }
            RealSwapFs.rename(&from, &to)
        })),
        ..Default::default()
    });
    assert!(s.activate(&s.t).ok);
    assert_eq!(*seen.lock(), vec![true, true]);
}

#[test]
fn waits_on_a_held_lock_and_aborts_cleanly_on_timeout_without_writing() {
    let s = setup();
    let before = s.snapshot();
    std::fs::create_dir(s.home.join(".claude.lock")).unwrap();
    assert_eq!(s.activate(&s.t), SwapResult::fail(SwapError::Locked));
    assert_eq!(s.snapshot(), before);
    assert_eq!(names(&s.backup_dir()), Vec::<String>::new());
    assert_eq!(s.store.list().len(), 2);
}

#[test]
fn rolls_back_exactly_when_writing_the_live_credentials_fails() {
    let s = setup();
    let before = s.snapshot();
    s.set_fs(fail_rename(s.live_creds(), 1)); // fails once: the rollback's own write must go through
    assert_eq!(s.activate(&s.t), SwapResult::fail(SwapError::Write));
    assert_eq!(s.snapshot(), before);
    assert_eq!(custody(&s.get(&s.a)), Custody::Live);
    assert_eq!(names(&s.backup_dir()), Vec::<String>::new());
}

#[test]
fn renews_the_target_only_through_the_one_family_rule_and_never_while_holding_claude_code_locks() {
    let s = setup();
    put(&s.dir(&s.t).join(".credentials.json"), &creds("X", NOW + 2.0 * 60_000.0));
    let during = Arc::new(Mutex::new(Vec::new()));
    let (d2, locks) = (during.clone(), s.lock_dirs());
    s.set_refresh(move |_| {
        d2.lock().push(locks.iter().any(|l| l.exists()));
        RefreshOutcome::Ok
    });
    assert!(s.activate(&s.t).ok);
    assert_eq!(s.refresh_calls(), vec![s.dir(&s.t)]);
    assert_eq!(*during.lock(), vec![false]);
}

#[test]
fn never_renews_or_swaps_in_an_expiring_target_the_rule_refuses() {
    let s = setup();
    put(&s.dir(&s.t).join(".credentials.json"), &creds("X", NOW + 2.0 * 60_000.0));
    s.store.set_family(&s.t, TokenFamily::Live).unwrap();
    s.set_roster(CswapRoster::UNREADABLE); // unreadable roster: holds everything
    let before = s.snapshot();
    assert_eq!(s.activate(&s.t), refused(SwapError::Foreign, Some("x@x.com")));
    s.store.set_family(&s.t, TokenFamily::Own).unwrap();
    s.set_roster(CswapRoster::Absent);
    let probe =
        AccountIdentity { account_uuid: Some("uuid-A".into()), organization_uuid: Some("org-A".into()), ..Default::default() };
    s.store.update_identity(&s.t, &probe, false).unwrap(); // the live account under another label
    assert_eq!(s.activate(&s.t), refused(SwapError::SameAccount, Some("x@x.com")));
    assert!(s.refresh_calls().is_empty());
    assert_eq!(s.snapshot(), before);
}

#[test]
fn refuses_the_live_record_itself_as_the_main_one_naming_it() {
    let s = setup();
    assert_eq!(s.activate(&s.a), refused(SwapError::SameAccount, Some("a@x.com")));
}

#[test]
fn records_the_outgoing_family_as_live_also_on_a_record_it_had_to_create() {
    let s = setup();
    s.store.remove(&s.a).unwrap();
    assert!(s.activate(&s.t).ok);
    let outgoing = s.store.list().into_iter().find(|r| r.id != s.t).unwrap();
    assert_eq!(custody(&outgoing), Custody::App);
    assert_eq!(outgoing.family, Some(TokenFamily::Live));
    assert_eq!(outgoing.identity.account_uuid.as_deref(), Some("uuid-A"));
}

fn fail_journal() -> HookFs {
    HookFs {
        rename: Some(Box::new(|(from, to)| {
            if to.to_string_lossy().ends_with("swap-journal.json") {
                return Err(eio());
            }
            RealSwapFs.rename(&from, &to)
        })),
        ..Default::default()
    }
}

#[test]
fn removes_its_backups_when_the_first_journal_write_fails_no_live_file_was_touched() {
    let s = setup();
    let before = s.snapshot();
    s.set_fs(fail_journal());
    assert_eq!(s.activate(&s.t), SwapResult::fail(SwapError::Write));
    assert_eq!(s.snapshot(), before);
    assert_eq!(names(&s.backup_dir()), Vec::<String>::new());
}

#[test]
fn is_busy_while_another_swap_runs_and_pending_while_a_journal_exists() {
    let s = setup();
    let held = s.slot.try_claim().unwrap();
    assert_eq!(s.activate(&s.t), SwapResult::fail(SwapError::Busy));
    drop(held);
    put(&s.backup_dir().join("swap-journal.json"), &json!({ "version": 1 }));
    assert_eq!(s.activate(&s.t), SwapResult::fail(SwapError::Pending));
}

fn login_creds() -> Value {
    json!({ "claudeAiOauth": { "accessToken": "fake-acc-login", "refreshToken": "fake-ref-login", "expiresAt": js::num(FUTURE) } })
}

/// A writer that ignores the locks (a /login, a holder that broke them as stale) right after the swap wrote the identity.
fn foreign_write_after_swap(live_json: PathBuf, write: impl Fn() + Send + Sync + 'static) -> HookFs {
    let done = AtomicBool::new(false);
    HookFs {
        rename: Some(Box::new(move |(from, to)| {
            RealSwapFs.rename(&from, &to)?;
            if to == live_json && !done.swap(true, Ordering::SeqCst) {
                write();
            }
            Ok(())
        })),
        ..Default::default()
    }
}

#[test]
fn never_rolls_back_over_a_login_someone_else_wrote_before_the_verification() {
    let s = setup();
    let lc = s.live_creds();
    s.set_fs(foreign_write_after_swap(s.live_json(), move || put(&lc, &login_creds())));
    assert_eq!(s.activate(&s.t), SwapResult::fail(SwapError::Manual));
    assert_eq!(json(&s.live_creds()), login_creds());
    assert_eq!(json(&s.dir(&s.a).join(".credentials.json"))["claudeAiOauth"]["refreshToken"], "fake-ref-A"); // the outgoing copy stays
    let files = names(&s.backup_dir());
    for n in ["swap-journal.json", "live-credentials.json", "live-claude.json"] {
        assert!(files.contains(&n.to_string()), "{files:?}");
    }
    assert!(s.slot.is_unresolved());
}

#[test]
fn never_rolls_back_over_an_identity_someone_else_wrote_either() {
    let s = setup();
    let lj = s.live_json();
    s.set_fs(foreign_write_after_swap(s.live_json(), move || put(&lj, &json!({ "oauthAccount": account("Z", "z@x.com") }))));
    assert_eq!(s.activate(&s.t), SwapResult::fail(SwapError::Manual));
    assert_eq!(json(&s.live_json())["oauthAccount"], account("Z", "z@x.com"));
    assert_eq!(json(&s.dir(&s.a).join(".credentials.json"))["claudeAiOauth"]["refreshToken"], "fake-ref-A");
    assert!(s.backup_dir().join("swap-journal.json").exists());
}

#[test]
fn waits_for_a_renewal_of_the_outgoing_record_still_in_flight_before_taking_the_claude_code_locks() {
    let s = setup();
    let (release_tx, release_rx) = std::sync::mpsc::channel::<()>();
    let (held_tx, held_rx) = std::sync::mpsc::channel::<()>();
    let profiles = s.profiles.clone();
    let a_dir = s.dir(&s.a);
    let renewal = std::thread::spawn(move || {
        let _g = profiles.lock(&a_dir);
        held_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        put(&a_dir.join(".credentials.json"), &creds("renewed", FUTURE));
    });
    held_rx.recv().unwrap();
    let deps = s.deps();
    let t = s.t.clone();
    let running = std::thread::spawn(move || activate_account(&deps, &t));
    std::thread::sleep(Duration::from_millis(400));
    assert!(!running.is_finished());
    assert_eq!(s.locks_present(), [false, false, false]);
    release_tx.send(()).unwrap();
    renewal.join().unwrap();
    assert!(running.join().unwrap().ok);
    assert_eq!(json(&s.dir(&s.a).join(".credentials.json"))["claudeAiOauth"]["refreshToken"], "fake-ref-A");
}

#[test]
fn commits_a_record_for_an_unknown_outgoing_account_only_once_the_journal_names_it() {
    let s = setup();
    s.store.remove(&s.a).unwrap();
    let counts = Arc::new(Mutex::new(Vec::new()));
    let (c2, store) = (counts.clone(), s.store.clone());
    s.set_fs(HookFs {
        rename: Some(Box::new(move |(from, to)| {
            if to.to_string_lossy().ends_with("swap-journal.json") {
                c2.lock().push(store.list().len());
            }
            RealSwapFs.rename(&from, &to)
        })),
        ..Default::default()
    });
    assert!(s.activate(&s.t).ok);
    let counts = counts.lock();
    assert_eq!(counts[0], 1);
    assert_eq!(*counts.last().unwrap(), 2);
}

#[test]
fn leaves_neither_a_record_nor_a_profile_dir_behind_when_an_unknown_outgoing_account_cannot_be_saved() {
    let s = setup();
    s.store.remove(&s.a).unwrap();
    s.set_fs(fail_journal());
    assert_eq!(s.activate(&s.t), SwapResult::fail(SwapError::Write));
    assert_eq!(s.store.list().into_iter().map(|r| r.id).collect::<Vec<_>>(), vec![s.t.clone()]);
    assert_eq!(names(&s.root.join("accounts").join("claude")), vec![s.t.clone()]);
}

#[test]
fn accepts_an_app_held_target_and_refuses_a_missing_set_aside_live_switched_out_or_cswap_held_one_naming_it() {
    let s = setup();
    let check = |id: &str| check_activation_target(&s.deps(), id);
    assert_eq!(check(&s.t), None);
    assert_eq!(check("123e4567-e89b-42d3-a456-426614174000"), Some(SwapResult::fail(SwapError::NoTarget)));
    assert_eq!(check(&s.a), Some(refused(SwapError::SameAccount, Some("a@x.com"))));
    s.store.set_custody(&s.t, Custody::Quarantined, Some(&s.a)).unwrap();
    assert_eq!(check(&s.t), Some(refused(SwapError::NoTarget, Some("x@x.com"))));
    s.store.set_custody(&s.t, Custody::Foreign, None).unwrap();
    assert_eq!(check(&s.t), Some(refused(SwapError::Foreign, Some("x@x.com"))));
    s.store.set_custody(&s.t, Custody::App, None).unwrap();
    s.store.set_family(&s.t, TokenFamily::Live).unwrap();
    s.set_roster(CswapRoster::Present(Some(vec![AccountIdentity { email: Some("x@x.com".into()), ..Default::default() }])));
    // A copy cswap may hold too: accepted while its access token is fresh, refused once it would need renewing (I3).
    assert_eq!(check(&s.t), None);
    put(&s.dir(&s.t).join(".credentials.json"), &creds("X", NOW + 60_000.0));
    assert_eq!(check(&s.t), Some(refused(SwapError::Foreign, Some("x@x.com"))));
    assert_eq!(s.activate(&s.t), refused(SwapError::Foreign, Some("x@x.com")));
    assert!(s.refresh_calls().is_empty());
}

// ── recoverInterruptedActivation ─────────────────────────────────────────────

/// The state a crash right after writing the live identity leaves behind.
fn crashed_after_live_writes(s: &T) {
    std::fs::create_dir_all(s.backup_dir()).unwrap();
    std::fs::write(s.backup_dir().join("live-credentials.json"), text(&s.live_creds()).unwrap()).unwrap();
    std::fs::write(s.backup_dir().join("live-claude.json"), text(&s.live_json()).unwrap()).unwrap();
    put(
        &s.backup_dir().join("swap-journal.json"),
        &json!({ "version": 2, "phase": "live-json-written", "outgoingId": s.a, "targetId": s.t, "created": false, "outCredsExisted": false, "outJsonExisted": false, "startedAt": js::num(NOW) }),
    );
    put(&s.dir(&s.a).join(".credentials.json"), &creds("A", FUTURE));
    let mut live = creds("X", FUTURE);
    live["mcpOAuth"] = json!({ "server": "A" });
    put(&s.live_creds(), &live);
    put(&s.live_json(), &json!({ "oauthAccount": account("X", "x@x.com"), "projects": { "p": 1 }, "numStartups": 4 }));
}

fn recover(s: &T) -> Recovery {
    recover_interrupted_activation(&s.deps())
}

#[test]
fn rolls_an_interrupted_swap_back_when_the_live_login_is_still_exactly_what_it_wrote() {
    let s = setup();
    let before = text(&s.live_creds()).unwrap();
    crashed_after_live_writes(&s);
    assert_eq!(recover(&s), Recovery::Recovered);
    assert_eq!(text(&s.live_creds()).unwrap(), before);
    assert_eq!(json(&s.live_json())["oauthAccount"], account("A", "a@x.com"));
    assert!(!s.dir(&s.a).join(".credentials.json").exists());
    assert_eq!(names(&s.backup_dir()), Vec::<String>::new());
}

#[test]
fn changes_nothing_when_claude_code_renewed_the_live_login_since() {
    let s = setup();
    crashed_after_live_writes(&s);
    put(
        &s.live_creds(),
        &json!({ "claudeAiOauth": { "accessToken": "fake-acc-new", "refreshToken": "fake-ref-new", "expiresAt": js::num(FUTURE) } }),
    );
    let after = s.snapshot();
    assert_eq!(recover(&s), Recovery::Manual);
    assert_eq!(s.snapshot(), after);
    assert!(s.backup_dir().join("swap-journal.json").exists());
}

#[test]
fn leaves_a_version_1_journal_to_the_legacy_recovery() {
    let s = setup();
    put(&s.backup_dir().join("swap-journal.json"), &json!({ "version": 1, "accountId": s.t, "phase": "backed-up" }));
    assert_eq!(recover(&s), Recovery::Legacy);
}

#[test]
fn deletes_backups_a_crash_left_before_the_first_journal_then_defers_to_the_legacy_recovery() {
    let s = setup();
    let b = s.backup_dir();
    std::fs::create_dir_all(&b).unwrap();
    std::fs::write(b.join("live-credentials.json"), text(&s.live_creds()).unwrap()).unwrap();
    std::fs::write(b.join("outgoing-claude.json"), "{}").unwrap();
    std::fs::write(b.join("live-claude.json.123e4567-e89b-42d3-a456-426614174000.tmp"), "{}").unwrap();
    std::fs::write(b.join("main-credentials.json"), "{}").unwrap(); // a 0.9.0 backup is the legacy recovery's business
    assert_eq!(recover(&s), Recovery::Legacy);
    assert_eq!(names(&b), vec!["main-credentials.json"]);
}

fn verified_journal(s: &T) {
    put(
        &s.backup_dir().join("swap-journal.json"),
        &json!({ "version": 2, "phase": "verified", "outgoingId": s.a, "targetId": s.t, "created": false, "outCredsExisted": false, "outJsonExisted": false, "startedAt": js::num(NOW) }),
    );
}

#[test]
fn finishes_the_roles_of_a_verified_swap() {
    let s = setup();
    verified_journal(&s);
    put(&s.live_json(), &json!({ "oauthAccount": account("X", "x@x.com") }));
    assert_eq!(recover(&s), Recovery::None);
    assert_eq!(custody(&s.get(&s.t)), Custody::Live);
    assert_eq!(custody(&s.get(&s.a)), Custody::App);
    assert_eq!(s.store.live().unwrap().record_id.as_deref(), Some(s.t.as_str()));
}

#[test]
fn leaves_the_roles_of_a_verified_swap_to_reconcile_when_the_target_is_no_longer_signed_in() {
    let s = setup();
    verified_journal(&s);
    assert_eq!(recover(&s), Recovery::None); // the live identity is still A
    assert_eq!(custody(&s.get(&s.t)), Custody::App);
    assert_eq!(custody(&s.get(&s.a)), Custody::Live);
    assert_eq!(s.store.live().unwrap().record_id.as_deref(), Some(s.a.as_str()));
    assert_eq!(names(&s.backup_dir()), Vec::<String>::new());
}

#[test]
fn removes_a_record_created_for_the_outgoing_account_when_the_swap_stopped_right_after_the_journal() {
    let s = setup();
    let created = s.store.prepare().unwrap().0;
    s.store
        .commit(&ManagedAccount {
            id: created.clone(),
            added_at: 5.0,
            identity: AccountIdentity {
                email: Some("b@x.com".into()),
                account_uuid: Some("uuid-B".into()),
                ..Default::default()
            },
            custody: Some(Custody::Live),
            family: Some(TokenFamily::Live),
            ..Default::default()
        })
        .unwrap();
    std::fs::create_dir_all(s.backup_dir()).unwrap();
    std::fs::write(s.backup_dir().join("live-credentials.json"), text(&s.live_creds()).unwrap()).unwrap();
    put(
        &s.backup_dir().join("swap-journal.json"),
        &json!({ "version": 2, "phase": "backed-up", "outgoingId": created, "targetId": s.t, "created": true, "outCredsExisted": false, "outJsonExisted": false, "startedAt": js::num(NOW) }),
    );
    assert_eq!(recover(&s), Recovery::None);
    assert!(s.store.get(&created).is_none());
    assert!(!s.dir(&created).exists());
    assert_eq!(names(&s.backup_dir()), Vec::<String>::new());
}

#[test]
fn keeps_an_identity_someone_else_wrote_since() {
    let s = setup();
    crashed_after_live_writes(&s);
    put(&s.live_json(), &json!({ "oauthAccount": account("Z", "z@x.com") }));
    let after = s.snapshot();
    assert_eq!(recover(&s), Recovery::Manual);
    assert_eq!(s.snapshot(), after);
    assert!(s.slot.is_unresolved());
}

/// A2 half of "keeps the journal while Claude Code holds its locks, never marks the swap unresolved, and blocks reconcile
/// until it recovers": the reconcile gate (`reconcileWhenIdle`) is A3's; it reads `activation_journal_pending`, checked here.
#[test]
fn keeps_the_journal_while_claude_code_holds_its_locks_and_never_marks_the_swap_unresolved() {
    let s = setup();
    crashed_after_live_writes(&s);
    std::fs::create_dir(s.home.join(".claude.lock")).unwrap();
    assert_eq!(recover(&s), Recovery::Locked);
    assert!(!s.slot.is_unresolved());
    assert!(s.slot.is_recovery_pending());
    assert!(s.backup_dir().join("swap-journal.json").exists());
    assert!(activation_journal_pending(&RealSwapFs, &s.backup_dir()));
    std::fs::remove_dir(s.home.join(".claude.lock")).unwrap();
    assert_eq!(recover(&s), Recovery::Recovered);
    assert!(!s.slot.is_recovery_pending());
    assert!(!s.slot.is_unresolved());
    assert!(!activation_journal_pending(&RealSwapFs, &s.backup_dir()));
}

#[test]
fn retries_at_start_up_while_the_locks_are_busy() {
    let s = setup();
    crashed_after_live_writes(&s);
    let lock = s.home.join(".claude.lock");
    std::fs::create_dir(&lock).unwrap();
    let waits = Arc::new(Mutex::new(Vec::new()));
    let (w2, l2) = (waits.clone(), lock.clone());
    s.set_delay(move |d| {
        w2.lock().push(d.as_millis());
        let _ = std::fs::remove_dir(&l2);
    });
    assert_eq!(recover_activation_with_retry(&s.deps(), 3, Duration::from_millis(1000), &|| false), Recovery::Recovered);
    assert_eq!(*waits.lock(), vec![1000]);
    assert!(!s.slot.is_recovery_pending());
}

#[test]
fn starts_no_further_start_up_attempt_once_the_app_quits() {
    let s = setup();
    crashed_after_live_writes(&s);
    let lock = s.home.join(".claude.lock");
    std::fs::create_dir(&lock).unwrap();
    let quitting = Arc::new(AtomicBool::new(false));
    let waits = Arc::new(Mutex::new(Vec::new()));
    let (w2, l2, q2) = (waits.clone(), lock.clone(), quitting.clone());
    // The quit begins during the wait between two attempts; the lock is free by then, but no attempt may claim the slot.
    s.set_delay(move |d| {
        w2.lock().push(d.as_millis());
        q2.store(true, Ordering::SeqCst);
        let _ = std::fs::remove_dir(&l2);
    });
    let stopped = || quitting.load(Ordering::SeqCst);
    assert_eq!(recover_activation_with_retry(&s.deps(), 3, Duration::from_millis(1000), &stopped), Recovery::Locked);
    assert_eq!(*waits.lock(), vec![1000]);
    assert!(activation_journal_pending(&RealSwapFs, &s.backup_dir())); // the journal stays for the next start
}

#[test]
fn stops_a_pending_retry_when_the_version_2_journal_is_gone_unparsable_or_not_version_2() {
    let s = setup();
    for journal in [
        None,
        Some("{not json".to_string()),
        Some(js_json::stringify(&json!({ "version": 1, "accountId": s.t, "phase": "backed-up" }))),
    ] {
        crashed_after_live_writes(&s);
        std::fs::create_dir(s.home.join(".claude.lock")).unwrap();
        assert_eq!(recover(&s), Recovery::Locked);
        assert!(s.slot.is_recovery_pending());
        std::fs::remove_dir(s.home.join(".claude.lock")).unwrap();
        let _ = std::fs::remove_dir_all(s.backup_dir());
        if let Some(j) = &journal {
            std::fs::create_dir_all(s.backup_dir()).unwrap();
            std::fs::write(s.backup_dir().join("swap-journal.json"), j).unwrap();
        }
        assert_eq!(recover(&s), Recovery::Legacy);
        assert!(!s.slot.is_recovery_pending());
        let _ = std::fs::remove_dir_all(s.backup_dir());
    }
}

#[test]
fn retries_a_locked_recovery_on_its_own_timer_also_without_the_usage_polls() {
    let s = setup();
    crashed_after_live_writes(&s);
    std::fs::create_dir(s.home.join(".claude.lock")).unwrap();
    assert_eq!(recover(&s), Recovery::Locked);
    std::fs::remove_dir(s.home.join(".claude.lock")).unwrap();
    let calls = Arc::new(AtomicUsize::new(0));
    let results = Arc::new(Mutex::new(Vec::new()));
    let rt = tokio::runtime::Builder::new_current_thread().enable_time().start_paused(true).build().unwrap();
    rt.block_on(async {
        let (deps, c2, r2) = (s.deps(), calls.clone(), results.clone());
        let task = start_activation_recovery_retry(s.slot.clone(), RECOVERY_RETRY, move || {
            let (deps, c2, r2) = (deps.clone(), c2.clone(), r2.clone());
            async move {
                c2.fetch_add(1, Ordering::SeqCst);
                r2.lock().push(recover_interrupted_activation(&deps));
            }
        });
        tokio::time::sleep(Duration::from_secs(29)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        tokio::time::sleep(Duration::from_millis(1_001)).await;
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(*results.lock(), vec![Recovery::Recovered]);
        assert!(!s.slot.is_recovery_pending());
        tokio::time::sleep(Duration::from_secs(60)).await; // nothing pending any more: no further tries
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        task.abort();
    });
}

// ── clearing the warning of an interrupted version-2 swap (M1) ───────────────

fn crashed_between_live_writes(s: &T, phase: &str) {
    std::fs::create_dir_all(s.backup_dir()).unwrap();
    std::fs::write(s.backup_dir().join("live-credentials.json"), text(&s.live_creds()).unwrap()).unwrap();
    std::fs::write(s.backup_dir().join("live-claude.json"), text(&s.live_json()).unwrap()).unwrap();
    put(
        &s.backup_dir().join("swap-journal.json"),
        &json!({ "version": 2, "phase": phase, "outgoingId": s.a, "targetId": s.t, "created": false, "outCredsExisted": false, "outJsonExisted": false, "startedAt": js::num(NOW) }),
    );
    put(&s.dir(&s.a).join(".credentials.json"), &creds("A", FUTURE));
    put(&s.dir(&s.a).join(".claude.json"), &json!({ "oauthAccount": account("A", "a@x.com") }));
    let mut live = creds("X", FUTURE); // the target's tokens, A's identity still in .claude.json
    live["mcpOAuth"] = json!({ "server": "A" });
    put(&s.live_creds(), &live);
}

fn clear(s: &T) -> bool {
    let deps = s.deps();
    clear_pending_activation(&deps, &|| crate::legacy_swap::clear_pending_swap(&deps))
}

/// "marks the outgoing record switched out and never copies the live tokens into it afterwards": the poll in between
/// (A3's reconcile, which gives A the card again by identity) is replaced by setting the custody it sets.
#[test]
fn marks_the_outgoing_record_switched_out_and_never_copies_the_live_tokens_into_it_afterwards() {
    let s = setup();
    crashed_between_live_writes(&s, "live-json-written");
    assert!(clear(&s));
    assert_eq!(names(&s.backup_dir()), Vec::<String>::new());
    assert_eq!(custody(&s.get(&s.a)), Custody::Foreign);
    assert!(s.get(&s.a).held_tokens.as_deref().is_some_and(js::is_hex64));
    assert!(!serde_json::to_string(&s.store.list()).unwrap().contains("fake-"));
    s.store.set_custody(&s.a, Custody::Live, None).unwrap();
    assert_eq!(json(&s.dir(&s.a).join(".credentials.json"))["claudeAiOauth"]["refreshToken"], "fake-ref-A");
    // Neither does a swap away from A: its own copy stays, the live tokens are not saved under its name.
    assert!(s.activate(&s.t).ok);
    assert_eq!(json(&s.dir(&s.a).join(".credentials.json"))["claudeAiOauth"]["refreshToken"], "fake-ref-A");
    assert_eq!(json(&s.live_creds())["claudeAiOauth"]["refreshToken"], "fake-ref-X");
}

#[test]
fn holds_nothing_when_the_live_tokens_are_the_outgoing_records_own_and_leaves_an_earlier_phase_alone() {
    let s = setup();
    crashed_between_live_writes(&s, "live-json-written");
    put(&s.live_creds(), &creds("A", FUTURE));
    assert!(clear(&s));
    assert_eq!(custody(&s.get(&s.a)), Custody::Foreign);
    assert_eq!(s.get(&s.a).held_tokens, None);
    s.store.set_custody(&s.a, Custody::Live, None).unwrap();
    crashed_between_live_writes(&s, "outgoing-saved");
    assert!(clear(&s));
    assert_eq!(custody(&s.get(&s.a)), Custody::Live);
    assert_eq!(s.get(&s.a).held_tokens, None);
}

#[test]
fn marks_nothing_when_the_clear_itself_fails() {
    let s = setup();
    crashed_between_live_writes(&s, "live-json-written");
    assert!(!clear_pending_activation(&s.deps(), &|| false));
    assert_eq!(custody(&s.get(&s.a)), Custody::Live);
    assert_eq!(s.get(&s.a).held_tokens, None);
}

// ── switching back and forth while cswap lists every account (1.0.9) ─────────
// The polls between the swaps (A3's reconcile after the app's own swap) change nothing there and are left out.

fn rule_of(s: &T, id: &str) -> RenewRule {
    let roster = s.knobs.roster.lock().clone();
    renew_rule(&s.get(id), s.store.live().as_ref(), &roster)
}

#[test]
fn an_adopted_copy_stays_the_apps_own_after_the_app_makes_it_main_and_switches_away_again() {
    let s = setup();
    s.set_roster(listed(&["a", "x"]));
    let written = Arc::new(AtomicBool::new(false));
    let w2 = written.clone();
    s.set_wrote_since(Some(Arc::new(move || w2.load(Ordering::SeqCst))));
    // T was adopted (family own): the app may renew it.
    assert_eq!(rule_of(&s, &s.t), RenewRule::Allowed);
    assert!(s.activate(&s.t).ok);
    assert!(s.activate(&s.a).ok);
    assert_eq!((custody(&s.get(&s.t)), s.get(&s.t).family), (Custody::App, Some(TokenFamily::Own)));
    assert_eq!(rule_of(&s, &s.t), RenewRule::Allowed);
    assert!(s.activate(&s.t).ok);
    assert!(s.activate(&s.a).ok);
    assert_eq!(rule_of(&s, &s.t), RenewRule::Allowed);
    // cswap backed up T's live login meanwhile: cswap holds the newest tokens, so it is not renewed any more.
    assert!(s.activate(&s.t).ok);
    written.store(true, Ordering::SeqCst);
    assert!(s.activate(&s.a).ok);
    assert_eq!((custody(&s.get(&s.t)), s.get(&s.t).family), (Custody::App, Some(TokenFamily::Live)));
    assert_eq!(rule_of(&s, &s.t), RenewRule::HeldByCswap);
}

#[test]
fn a_copy_of_the_live_family_becomes_the_apps_own_once_claude_code_rotated_it_after_the_apps_swap() {
    let s = setup();
    s.set_roster(listed(&["a", "x"]));
    s.set_wrote_since(Some(Arc::new(|| false)));
    s.store.set_family(&s.t, TokenFamily::Live).unwrap();
    assert!(s.activate(&s.t).ok);
    // Not rotated: the live tokens are the very copy the app swapped in, cswap may hold it from earlier.
    assert!(s.activate(&s.a).ok);
    assert_eq!(rule_of(&s, &s.t), RenewRule::HeldByCswap);
    assert!(s.activate(&s.t).ok);
    // Claude Code renewed the login while it was main: new tokens nobody else saw.
    let mut live = json(&s.live_creds());
    live["claudeAiOauth"] = creds("X2", FUTURE)["claudeAiOauth"].clone();
    put(&s.live_creds(), &live);
    assert!(s.activate(&s.a).ok);
    assert_eq!((custody(&s.get(&s.t)), s.get(&s.t).family), (Custody::App, Some(TokenFamily::Own)));
    assert_eq!(rule_of(&s, &s.t), RenewRule::Allowed);
}

/// First half of "without a cswap check (unknown) and after a switch by another tool nothing becomes the app's own"; the
/// outside switch is detected by A3's reconcile.
#[test]
fn without_a_cswap_check_nothing_becomes_the_apps_own() {
    let s = setup();
    s.set_roster(listed(&["a", "x"]));
    assert!(s.activate(&s.t).ok);
    assert!(s.activate(&s.a).ok);
    assert_eq!(s.get(&s.t).family, Some(TokenFamily::Live));
    s.store.set_family(&s.t, TokenFamily::Own).unwrap();
    s.set_wrote_since(Some(Arc::new(|| false)));
    assert!(s.activate(&s.t).ok);
    assert_eq!(s.get(&s.t).app_swap.as_ref().map(|a| (a.at, a.own)), Some((NOW, true)));
}

#[test]
fn an_unreadable_roster_answer_counts_as_holding_everything() {
    let s = setup();
    put(&s.dir(&s.t).join(".credentials.json"), &creds("X", NOW + 2.0 * 60_000.0));
    s.store.set_family(&s.t, TokenFamily::Live).unwrap();
    let mut deps = s.deps();
    deps.cswap = Arc::new(|| Err(()));
    assert_eq!(activate_account(&deps, &s.t), refused(SwapError::Foreign, Some("x@x.com")));
    assert!(s.refresh_calls().is_empty());
}

#[test]
fn refuses_on_macos_an_invalid_id_and_an_env_token_before_anything_is_read() {
    let s = setup();
    let before = s.snapshot();
    let mut deps = s.deps();
    deps.darwin = true;
    assert_eq!(activate_account(&deps, &s.t), SwapResult::fail(SwapError::Unsupported));
    assert_eq!(s.activate("../x"), SwapResult::fail(SwapError::Invalid));
    s.set_env(&[("CLAUDE_CODE_OAUTH_TOKEN", " t ")]);
    assert_eq!(s.activate(&s.t), SwapResult::fail(SwapError::EnvToken));
    s.set_env(&[("CLAUDE_CONFIG_DIR", "relative")]);
    assert_eq!(s.activate(&s.t), SwapResult::fail(SwapError::NoMain));
    assert_eq!(s.snapshot(), before);
    assert!(!s.slot.is_running());
}

#[test]
fn signs_the_target_in_when_nobody_was_signed_in_and_removes_the_new_file_on_a_rollback() {
    let s = setup();
    std::fs::remove_file(s.live_creds()).unwrap();
    // A failure at the identity write: the credentials file this swap created goes again.
    s.set_fs(fail_rename(s.live_json(), 1));
    assert_eq!(s.activate(&s.t), SwapResult::fail(SwapError::Write));
    assert!(!s.live_creds().exists());
    assert_eq!(json(&s.live_json())["oauthAccount"], account("A", "a@x.com"));
    s.real_fs();
    assert_eq!(s.activate(&s.t), ok("x@x.com"));
    assert_eq!(json(&s.live_creds())["claudeAiOauth"]["refreshToken"], "fake-ref-X");
    // No usable login left: the record keeps its own family and gets nothing.
    assert_eq!(s.get(&s.a).family, Some(TokenFamily::Live));
    assert!(!s.dir(&s.a).join(".credentials.json").exists());
}

#[test]
fn an_unparsable_live_credentials_file_is_never_overwritten() {
    let s = setup();
    std::fs::write(s.live_creds(), "{").unwrap();
    assert_eq!(s.activate(&s.t), SwapResult::fail(SwapError::NoMain));
    assert_eq!(text(&s.live_creds()).unwrap(), "{");
}

#[test]
fn marks_the_saved_copy_dead_when_the_login_that_left_was_cleared_by_claude_code() {
    let s = setup();
    put(&s.dir(&s.a).join(".credentials.json"), &creds("A", FUTURE));
    put(&s.live_creds(), &json!({ "claudeAiOauth": { "accessToken": "", "refreshToken": "", "expiresAt": 0 } }));
    assert!(s.activate(&s.t).ok);
    assert_eq!(s.get(&s.a).dead_tokens.as_deref(), Some(token_hash("fake-ref-A").as_str()));
    // A dead saved copy is never swapped in nor renewed.
    s.store.set_custody(&s.a, Custody::App, None).unwrap();
    s.store.set_family(&s.a, TokenFamily::Own).unwrap();
    assert_eq!(s.activate(&s.a), refused(SwapError::Dead, Some("a@x.com")));
}

#[test]
fn a_transient_renewal_of_a_token_that_runs_out_within_a_minute_is_refused() {
    let s = setup();
    put(&s.dir(&s.t).join(".credentials.json"), &creds("X", NOW + 30_000.0));
    s.set_refresh(|_| RefreshOutcome::Transient(None));
    assert_eq!(s.activate(&s.t), refused(SwapError::Transient, Some("x@x.com")));
    put(&s.dir(&s.t).join(".credentials.json"), &creds("X", NOW + 3.0 * 60_000.0));
    assert!(s.activate(&s.t).ok); // still valid for longer than a minute: swapped in as it is
}

#[test]
fn the_journal_names_no_secret_and_has_the_1_1_4_shape() {
    let s = setup();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let (s2, journal) = (seen.clone(), s.backup_dir().join("swap-journal.json"));
    s.set_fs(HookFs {
        rename: Some(Box::new(move |(from, to)| {
            RealSwapFs.rename(&from, &to)?;
            if to == journal {
                s2.lock().push(text(&to).unwrap());
            }
            Ok(())
        })),
        ..Default::default()
    });
    assert!(s.activate(&s.t).ok);
    let seen = seen.lock();
    assert_eq!(seen.len(), 5);
    assert_eq!(
        seen[0],
        format!(
            r#"{{"version":2,"phase":"backed-up","outgoingId":"{}","targetId":"{}","created":false,"outCredsExisted":false,"outJsonExisted":false,"liveCredsExisted":true,"startedAt":1792152000000}}"#,
            s.a, s.t
        )
    );
    assert!(seen.iter().all(|j| !j.contains("fake-")));
    let phases: Vec<String> = seen.iter().map(|j| js_json::parse(j).unwrap()["phase"].as_str().unwrap().to_string()).collect();
    assert_eq!(phases, ["backed-up", "outgoing-saved", "live-creds-written", "live-json-written", "verified"]);
}
