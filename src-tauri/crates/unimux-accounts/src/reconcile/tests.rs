//! Ports of test/accounts-reconcile.test.ts (reconcileLive, reconcileWhenIdle, backupLiveBeforeLogin,
//! resyncOutgoingWhenIdle).

use super::*;
use crate::locks::LockOptions;
use crate::refresh::ProfileLocks;
use crate::resync::{ResyncDeps, Seen, resync_active_backup};
use crate::swapfs::{RealSwapFs, SwapPaths};
use parking_lot::Mutex;
use std::cell::{Cell, RefCell};
use std::path::PathBuf;

fn ident(email: &str, uuid: Option<&str>) -> AccountIdentity {
    AccountIdentity { email: Some(email.into()), account_uuid: uuid.map(Into::into), ..Default::default() }
}
fn a() -> AccountIdentity {
    ident("a@x.com", Some("ua"))
}
fn g() -> AccountIdentity {
    ident("g@x.com", Some("ug"))
}

struct Fx {
    _tmp: tempfile::TempDir,
    root: PathBuf,
    home: PathBuf,
    store: AccountsStore,
    slot: SwapSlot,
    live: RefCell<Result<Option<AccountIdentity>, ()>>,
}

impl Fx {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let root = dunce::canonicalize(tmp.path()).unwrap();
        let home = root.join("home");
        std::fs::create_dir_all(home.join(".claude")).unwrap();
        let store = AccountsStore::new(root.join("accounts"));
        Self { _tmp: tmp, root, home, store, slot: SwapSlot::new(), live: RefCell::new(Ok(None)) }
    }
    fn set_live(&self, l: Option<AccountIdentity>) {
        *self.live.borrow_mut() = Ok(l);
    }
    fn add(&self, identity: AccountIdentity, custody: Option<Custody>) -> String {
        let (id, _) = self.store.prepare().unwrap();
        self.store.commit(&ManagedAccount { id: id.clone(), added_at: 1.0, identity, custody, ..Default::default() }).unwrap();
        id
    }
    fn holders(&self, identity: &AccountIdentity) -> usize {
        visible(&self.store).iter().filter(|r| compare_identity(&r.identity, identity) == IdentityMatch::Same).count()
    }
    fn custody(&self, id: &str) -> Option<Custody> {
        self.store.get(id).and_then(|r| r.custody)
    }
    fn kinds(&self) -> Vec<NoticeKind> {
        self.store.notices().iter().map(|n| n.kind).collect()
    }
    fn read(&self) -> Result<Option<AccountIdentity>, ()> {
        self.live.borrow().clone()
    }
    fn make_read_only(&self) {
        let file = self.root.join("accounts").join("accounts.json");
        let mut v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&file).unwrap()).unwrap();
        v["version"] = 99.into();
        std::fs::write(&file, v.to_string()).unwrap();
        assert!(self.store.read_only());
    }
    fn paths(&self) -> SwapPaths {
        SwapPaths {
            credentials: self.home.join(".claude").join(".credentials.json"),
            claude_json: self.home.join(".claude.json"),
        }
    }
}

macro_rules! deps {
    ($fx:expr, $resync:expr) => {
        ReconcileDeps {
            store: &$fx.store,
            read_live_identity: &|| $fx.read(),
            resync: $resync,
            cswap_wrote_since: None,
            saved_copy_dead: None,
            now: &|| 10.0,
        }
    };
}

#[test]
fn adopts_an_unknown_live_account_as_a_record_once() {
    let fx = Fx::new();
    fx.set_live(Some(a()));
    let first = reconcile_live(&deps!(fx, None), false).unwrap();
    assert!(first.changed);
    assert_eq!(fx.holders(&a()), 1);
    let rec = fx.store.get(first.active_id.as_deref().unwrap()).unwrap();
    assert_eq!((rec.custody, rec.family), (Some(Custody::Live), Some(TokenFamily::Live)));
    assert_eq!(rec.identity, a());
    assert_eq!(fx.kinds(), [NoticeKind::Adopted]);
    assert_eq!(reconcile_live(&deps!(fx, None), false).unwrap(), ReconcileResult { active_id: first.active_id, changed: false });
}

#[test]
fn main_changes_from_g_to_a_while_a_saved_p_holds_a() {
    let fx = Fx::new();
    let gid = fx.add(g(), Some(Custody::Live));
    let p = fx.add(a(), None);
    fx.store.set_live(Some(&LiveIdentity { identity: g(), record_id: Some(gid.clone()) })).unwrap();
    fx.set_live(Some(a()));
    let result = reconcile_live(&deps!(fx, None), false).unwrap();
    assert_eq!(result.active_id.as_deref(), Some(p.as_str()));
    assert_eq!(fx.custody(&p), Some(Custody::Live));
    assert_eq!(fx.custody(&gid), Some(Custody::Foreign));
    assert_eq!(fx.holders(&a()), 1);
    assert!(fx.kinds().is_empty());
    assert_eq!(fx.store.live(), Some(LiveIdentity { identity: a(), record_id: Some(p) }));
}

#[test]
fn main_changes_from_a_to_g_externally_and_nothing_is_deleted() {
    let fx = Fx::new();
    let aid = fx.add(a(), Some(Custody::Live));
    fx.store.set_live(Some(&LiveIdentity { identity: a(), record_id: Some(aid.clone()) })).unwrap();
    fx.set_live(Some(g()));
    reconcile_live(&deps!(fx, None), false).unwrap();
    assert_eq!(fx.custody(&aid), Some(Custody::Foreign));
    assert!(fx.store.dir_of(&aid).unwrap().exists());
    assert_eq!(fx.holders(&g()), 1);
}

#[test]
fn a_sign_out_outside_the_app_keeps_the_record_and_says_so() {
    let fx = Fx::new();
    let aid = fx.add(a(), Some(Custody::Live));
    fx.store.set_live(Some(&LiveIdentity { identity: a(), record_id: Some(aid.clone()) })).unwrap();
    reconcile_live(&deps!(fx, None), false).unwrap();
    assert_eq!(fx.custody(&aid), Some(Custody::Foreign));
    assert_eq!(fx.kinds(), [NoticeKind::LoggedOut]);
    assert_eq!(fx.store.live(), None);
}

#[test]
fn an_own_change_leaves_the_outgoing_record_renewable_and_silent() {
    let fx = Fx::new();
    let aid = fx.add(a(), Some(Custody::Live));
    fx.set_live(Some(g()));
    reconcile_live(&deps!(fx, None), true).unwrap();
    assert_eq!(fx.custody(&aid), Some(Custody::App));
    assert_eq!(fx.kinds(), [NoticeKind::Adopted]);
}

#[test]
fn sets_a_second_record_of_the_live_account_aside() {
    let fx = Fx::new();
    let p = fx.add(a(), Some(Custody::Live));
    let copy = fx.add(a(), None);
    fx.set_live(Some(a()));
    reconcile_live(&deps!(fx, None), false).unwrap();
    let c = fx.store.get(&copy).unwrap();
    assert_eq!((c.custody, c.duplicate_of.as_deref()), (Some(Custody::Quarantined), Some(p.as_str())));
}

#[test]
fn fills_the_uuids_from_the_live_login_and_a_failing_resync_changes_nothing_else() {
    let fx = Fx::new();
    let p = fx.add(ident("a@x.com", None), Some(Custody::Live));
    fx.set_live(Some(a()));
    let calls = RefCell::new(Vec::new());
    let resync = |id: &str, i: &AccountIdentity| -> Result<ResyncResult, ResyncError> {
        calls.borrow_mut().push((id.to_string(), i.clone()));
        Err(ResyncError::Write)
    };
    reconcile_live(&deps!(fx, Some(&resync)), false).unwrap();
    assert_eq!(fx.store.get(&p).unwrap().identity.account_uuid.as_deref(), Some("ua"));
    assert_eq!(*calls.borrow(), [(p, a())]);
}

#[test]
fn prefers_the_record_the_live_login_already_names() {
    let fx = Fx::new();
    let older = fx.add(a(), None);
    let named = fx.add(a(), Some(Custody::Live));
    fx.store.set_live(Some(&LiveIdentity { identity: a(), record_id: Some(named.clone()) })).unwrap();
    fx.set_live(Some(a()));
    let result = reconcile_live(&deps!(fx, None), false).unwrap();
    assert_eq!(result.active_id.as_deref(), Some(named.as_str()));
    assert_eq!(fx.store.get(&older).unwrap().duplicate_of.as_deref(), Some(named.as_str()));
    assert_eq!(fx.kinds(), [NoticeKind::Quarantined]);
}

#[test]
fn writes_nothing_and_throws_nothing_while_accounts_json_is_read_only() {
    let fx = Fx::new();
    let aid = fx.add(a(), Some(Custody::Live));
    fx.store.set_live(Some(&LiveIdentity { identity: a(), record_id: Some(aid.clone()) })).unwrap();
    fx.make_read_only();
    let file = fx.root.join("accounts").join("accounts.json");
    let before = std::fs::read_to_string(&file).unwrap();
    fx.set_live(Some(g()));
    let called = Cell::new(false);
    let resync = |_: &str, _: &AccountIdentity| -> Result<ResyncResult, ResyncError> {
        called.set(true);
        Ok(ResyncResult::Copied)
    };
    assert_eq!(
        reconcile_live(&deps!(fx, Some(&resync)), false).unwrap(),
        ReconcileResult { active_id: Some(aid), changed: false }
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), before);
    assert!(!called.get());
}

#[test]
fn stops_without_a_throw_when_accounts_json_turns_read_only_during_the_run() {
    let fx = Fx::new();
    let aid = fx.add(a(), Some(Custody::Live));
    fx.store.set_live(Some(&LiveIdentity { identity: a(), record_id: Some(aid.clone()) })).unwrap();
    let file = fx.root.join("accounts").join("accounts.json");
    let before = RefCell::new(String::new());
    let read = || {
        fx.make_read_only();
        *before.borrow_mut() = std::fs::read_to_string(&file).unwrap();
        Ok(Some(g()))
    };
    assert_eq!(
        reconcile_live(&ReconcileDeps { read_live_identity: &read, ..deps!(fx, None) }, false).unwrap(),
        ReconcileResult { active_id: Some(aid), changed: false }
    );
    assert_eq!(std::fs::read_to_string(&file).unwrap(), *before.borrow());
}

#[test]
fn a_partial_identity_live_record_ends_either_aside_or_marked_never_live_twice() {
    let fx = Fx::new();
    let holder = fx.add(AccountIdentity { organization_uuid: Some("o1".into()), ..a() }, Some(Custody::Live));
    let other = fx.add(
        AccountIdentity { email: Some("a@x.com".into()), organization_uuid: Some("o2".into()), ..Default::default() },
        Some(Custody::Live),
    );
    fx.store.set_live(Some(&LiveIdentity { identity: a(), record_id: Some(holder.clone()) })).unwrap();
    fx.set_live(Some(a()));
    reconcile_live(&deps!(fx, None), false).unwrap();
    let live: Vec<String> =
        fx.store.list().into_iter().filter(|r| custody_of(r.custody) == Custody::Live).map(|r| r.id).collect();
    assert_eq!(live, [holder]);
    assert_eq!(fx.custody(&other), Some(Custody::Foreign));
    assert!(fx.kinds().is_empty());
}

#[test]
fn changes_nothing_when_the_live_identity_cannot_be_read() {
    let fx = Fx::new();
    fx.add(a(), Some(Custody::Live));
    *fx.live.borrow_mut() = Err(());
    assert!(!reconcile_live(&deps!(fx, None), false).unwrap().changed);
}

fn idle() -> LiveGuard<'static> {
    LiveGuard { swap_unresolved: &|| false, login_active: &|| false, journal_pending: None }
}

#[test]
fn holds_the_swap_slot_while_it_runs_and_releases_it_also_after_an_error() {
    let slot = SwapSlot::new();
    let during = Cell::new(false);
    assert_eq!(
        reconcile_when_idle(&slot, &idle(), || -> Result<(), ()> {
            during.set(slot.is_running());
            Ok(())
        }),
        Ok(true)
    );
    assert!(during.get());
    assert!(!slot.is_running());
    assert_eq!(reconcile_when_idle(&slot, &idle(), || Err::<(), _>("x")), Err("x"));
    assert!(!slot.is_running());
}

#[test]
fn skips_while_a_swap_holds_the_slot_a_swap_is_unresolved_or_a_login_runs() {
    let slot = SwapSlot::new();
    let ran = Cell::new(0);
    let run = || -> Result<(), ()> {
        ran.set(ran.get() + 1);
        Ok(())
    };
    {
        let _held = slot.try_claim().unwrap();
        assert_eq!(reconcile_when_idle(&slot, &idle(), run), Ok(false));
    }
    assert_eq!(reconcile_when_idle(&slot, &LiveGuard { swap_unresolved: &|| true, ..idle() }, run), Ok(false));
    assert_eq!(reconcile_when_idle(&slot, &LiveGuard { login_active: &|| true, ..idle() }, run), Ok(false));
    assert_eq!(
        reconcile_when_idle(&slot, &LiveGuard { journal_pending: Some(&|| Err(std::io::Error::other("x"))), ..idle() }, run),
        Ok(false)
    );
    assert_eq!(ran.get(), 0);
    assert!(!slot.is_running());
}

fn opts<'a>() -> BackupOptions<'a> {
    BackupOptions { delay: &|_| {}, tries: None, gap: None, own_change: false, own_change_applied: None }
}

fn put_live(fx: &Fx, n: &str) {
    std::fs::write(
        fx.home.join(".claude").join(".credentials.json"),
        format!(r#"{{"claudeAiOauth":{{"accessToken":"fake-acc-{n}","refreshToken":"fake-ref-{n}","expiresAt":5}}}}"#),
    )
    .unwrap();
    std::fs::write(fx.home.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"a@x.com","accountUuid":"ua"}}"#).unwrap();
}

#[test]
fn backs_the_live_login_up_into_its_record_retrying_while_the_live_files_settle() {
    let fx = Fx::new();
    let p = fx.add(a(), Some(Custody::Live));
    fx.store.set_live(Some(&LiveIdentity { identity: a(), record_id: Some(p.clone()) })).unwrap();
    fx.set_live(Some(a()));
    put_live(&fx, "1");
    let seen: Seen = Mutex::default();
    let (paths, profiles, locks) =
        (fx.paths(), ProfileLocks::new(), LockOptions { timeout: Duration::from_millis(300), ..LockOptions::default() });
    let results = RefCell::new(Vec::new());
    let resync = |id: &str, i: &AccountIdentity| {
        let d = ResyncDeps {
            paths: &paths,
            store: &fx.store,
            fs: &RealSwapFs,
            locks: &locks,
            profiles: &profiles,
            delay: &|_| {},
            seen: Some(&seen),
        };
        let r = resync_active_backup(&d, id, i);
        if let Ok(r) = &r {
            results.borrow_mut().push(*r);
        }
        r
    };
    backup_live_before_login(&fx.slot, &|| false, None, &deps!(fx, Some(&resync)), &opts()).unwrap();
    assert_eq!(*results.borrow(), [ResyncResult::Settling, ResyncResult::Copied]);
    let copied = std::fs::read_to_string(fx.store.dir_of(&p).unwrap().join(".credentials.json")).unwrap();
    assert!(copied.contains("fake-ref-1"));
    assert!(!fx.slot.is_running());
}

#[test]
fn applies_a_pending_own_change_of_an_earlier_app_login() {
    let fx = Fx::new();
    let gid = fx.add(g(), Some(Custody::Live));
    fx.store.set_live(Some(&LiveIdentity { identity: g(), record_id: Some(gid.clone()) })).unwrap();
    fx.add(a(), None);
    fx.set_live(Some(a()));
    let resync = |_: &str, _: &AccountIdentity| Ok(ResyncResult::Copied);
    backup_live_before_login(&fx.slot, &|| false, None, &deps!(fx, Some(&resync)), &BackupOptions { own_change: true, ..opts() })
        .unwrap();
    assert_eq!(fx.custody(&gid), Some(Custody::App));
    assert!(fx.kinds().iter().all(|k| *k != NoticeKind::SwitchedOut));
}

#[test]
fn refuses_when_every_try_ends_settling_locked_or_mismatch_and_when_the_copy_throws() {
    for result in [ResyncResult::Settling, ResyncResult::Locked, ResyncResult::Mismatch] {
        let fx = Fx::new();
        fx.add(a(), Some(Custody::Live));
        fx.set_live(Some(a()));
        let calls = Cell::new(0);
        let resync = |_: &str, _: &AccountIdentity| {
            calls.set(calls.get() + 1);
            Ok(result)
        };
        let err = backup_live_before_login(
            &fx.slot,
            &|| false,
            None,
            &deps!(fx, Some(&resync)),
            &BackupOptions { tries: Some(3), ..opts() },
        )
        .unwrap_err();
        assert_eq!(err.reason, result.as_str());
        assert_eq!(calls.get(), 3);
        assert!(!fx.slot.is_running());
    }
    let fx = Fx::new();
    fx.add(a(), Some(Custody::Live));
    fx.set_live(Some(a()));
    let resync = |_: &str, _: &AccountIdentity| Err(ResyncError::Write);
    assert_eq!(
        backup_live_before_login(&fx.slot, &|| false, None, &deps!(fx, Some(&resync)), &opts()).unwrap_err().reason,
        "failed"
    );
}

#[test]
fn refuses_while_a_swap_holds_the_slot_a_swap_is_unresolved_or_a_journal_is_pending() {
    let fx = Fx::new();
    fx.add(a(), Some(Custody::Live));
    fx.set_live(Some(a()));
    let called = Cell::new(false);
    let resync = |_: &str, _: &AccountIdentity| {
        called.set(true);
        Ok(ResyncResult::Copied)
    };
    {
        let _held = fx.slot.try_claim().unwrap();
        assert!(backup_live_before_login(&fx.slot, &|| false, None, &deps!(fx, Some(&resync)), &opts()).is_err());
    }
    assert!(backup_live_before_login(&fx.slot, &|| true, None, &deps!(fx, Some(&resync)), &opts()).is_err());
    assert!(backup_live_before_login(&fx.slot, &|| false, Some(&|| Ok(true)), &deps!(fx, Some(&resync)), &opts()).is_err());
    assert!(!called.get());
}

#[test]
fn refuses_when_the_live_identity_cannot_be_read_or_accounts_json_is_read_only() {
    let fx = Fx::new();
    fx.add(a(), Some(Custody::Live));
    let resync = |_: &str, _: &AccountIdentity| Ok(ResyncResult::Copied);
    *fx.live.borrow_mut() = Err(());
    assert_eq!(
        backup_live_before_login(&fx.slot, &|| false, None, &deps!(fx, Some(&resync)), &opts()).unwrap_err().reason,
        "unread"
    );
    fx.set_live(Some(a()));
    fx.make_read_only();
    assert!(backup_live_before_login(&fx.slot, &|| false, None, &deps!(fx, Some(&resync)), &opts()).is_err());
}

#[test]
fn proceeds_when_nobody_is_signed_in_without_a_refresh_token_or_without_a_file_login() {
    let fx = Fx::new();
    let called = Cell::new(false);
    let resync = |_: &str, _: &AccountIdentity| {
        called.set(true);
        Ok(ResyncResult::Copied)
    };
    backup_live_before_login(&fx.slot, &|| false, None, &deps!(fx, Some(&resync)), &opts()).unwrap();
    assert!(!called.get());
    fx.set_live(Some(a()));
    let missing = |_: &str, _: &AccountIdentity| Ok(ResyncResult::Missing);
    backup_live_before_login(&fx.slot, &|| false, None, &deps!(fx, Some(&missing)), &opts()).unwrap();
    backup_live_before_login(&fx.slot, &|| false, None, &deps!(fx, None), &opts()).unwrap();
}

#[test]
fn passes_own_change_to_the_first_reconcile_only_and_reports_it_applied_also_when_the_backup_fails() {
    let fx = Fx::new();
    let gid = fx.add(g(), Some(Custody::Live));
    fx.store.set_live(Some(&LiveIdentity { identity: g(), record_id: Some(gid.clone()) })).unwrap();
    fx.add(a(), None);
    fx.set_live(Some(a()));
    let applied = Cell::new(0);
    let calls = Cell::new(0);
    let resync = |_: &str, _: &AccountIdentity| {
        calls.set(calls.get() + 1);
        Ok(ResyncResult::Locked)
    };
    let o = BackupOptions {
        own_change: true,
        own_change_applied: Some(&|| applied.set(applied.get() + 1)),
        tries: Some(3),
        ..opts()
    };
    assert!(backup_live_before_login(&fx.slot, &|| false, None, &deps!(fx, Some(&resync)), &o).is_err());
    assert_eq!((applied.get(), calls.get()), (1, 3));
    assert_eq!(fx.custody(&gid), Some(Custody::App));

    // No reconcile could run: not reported.
    let fx = Fx::new();
    let applied = Cell::new(0);
    let o = BackupOptions { own_change: true, own_change_applied: Some(&|| applied.set(applied.get() + 1)), ..opts() };
    let _held = fx.slot.try_claim().unwrap();
    let copied = |_: &str, _: &AccountIdentity| Ok(ResyncResult::Copied);
    assert!(backup_live_before_login(&fx.slot, &|| false, None, &deps!(fx, Some(&copied)), &o).is_err());
    assert_eq!(applied.get(), 0);
}

#[test]
fn resyncs_only_the_outgoing_live_record_under_the_swap_slot_and_skips_otherwise() {
    let fx = Fx::new();
    let gid = fx.add(g(), Some(Custody::Live));
    fx.store.set_live(Some(&LiveIdentity { identity: g(), record_id: Some(gid.clone()) })).unwrap();
    fx.set_live(Some(a()));
    let during = Cell::new(false);
    let seen = RefCell::new(Vec::new());
    let resync = |id: &str, i: &AccountIdentity| {
        during.set(fx.slot.is_running());
        seen.borrow_mut().push((id.to_string(), i.clone()));
        Ok(ResyncResult::Mismatch)
    };
    assert_eq!(
        resync_outgoing_when_idle(&fx.slot, &|| false, None, &deps!(fx, Some(&resync))).unwrap(),
        Some(ResyncResult::Mismatch)
    );
    assert_eq!(*seen.borrow(), [(gid.clone(), g())]);
    assert!(during.get());
    assert_eq!(fx.custody(&gid), Some(Custody::Live));
    assert_eq!(fx.store.list().len(), 1);
    assert!(!fx.slot.is_running());
    assert_eq!(resync_outgoing_when_idle(&fx.slot, &|| false, Some(&|| Ok(true)), &deps!(fx, Some(&resync))).unwrap(), None);
    fx.store.set_live(None).unwrap();
    assert_eq!(resync_outgoing_when_idle(&fx.slot, &|| false, None, &deps!(fx, Some(&resync))).unwrap(), None);
}

/// I1: a holder promoted to live takes the live family, so an own change later never makes it renewable while cswap lists it.
#[test]
fn a_holder_promoted_to_live_takes_the_live_family() {
    let fx = Fx::new();
    let p = fx.add(a(), Some(Custody::App));
    fx.store.set_family(&p, TokenFamily::Own).unwrap();
    fx.set_live(Some(a()));
    reconcile_live(&deps!(fx, None), false).unwrap();
    let r = fx.store.get(&p).unwrap();
    assert_eq!((r.custody, r.family), (Some(Custody::Live), Some(TokenFamily::Live)));
    fx.set_live(Some(g()));
    reconcile_live(&deps!(fx, None), true).unwrap();
    let r = fx.store.get(&p).unwrap();
    assert_eq!((r.custody, r.family), (Some(Custody::App), Some(TokenFamily::Live)));
}
