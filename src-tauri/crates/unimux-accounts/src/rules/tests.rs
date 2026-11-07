//! Ports of the guard cases of test/accounts-swap-recovery.test.ts, of test/accounts-adopt-copy.test.ts and of the handler
//! cases of test/accounts-makemain.test.ts.

use super::*;
use crate::identity::AccountIdentity;
use crate::store::AccountsStore;
use parking_lot::Mutex;
use serde_json::json;
use std::cell::{Cell, RefCell};

const ID: &str = "11111111-1111-4111-8111-111111111111";

type RemoveFn<'a> = &'a dyn Fn(&str) -> Result<(), StoreError>;
type GetFn<'a> = &'a dyn Fn(&str) -> Option<ManagedAccount>;
type ValidateFn = Box<dyn Fn(&str) -> Result<Option<SwapResult>, ()>>;
type SwapFn = Box<dyn Fn(&str) -> Result<SwapResult, ()>>;

fn io_err() -> std::io::Error {
    std::io::Error::other("io")
}

// ── account mutation guards (accounts-swap-recovery.test.ts) ─────────────────

fn remove_with(
    running: bool,
    pending: bool,
    read_only: Option<&dyn Fn() -> bool>,
    is_live: &dyn Fn(&str) -> bool,
    swap_pending: Option<&dyn Fn() -> std::io::Result<bool>>,
    remove: Option<RemoveFn<'_>>,
) -> (Result<RemoveResult, StoreError>, Vec<&'static str>) {
    let calls = RefCell::new(Vec::new());
    let sr = move || running;
    let sp = move || Ok(pending);
    let default_remove = |_: &str| {
        calls.borrow_mut().push("remove");
        Ok(())
    };
    let cancel = |_: &str| calls.borrow_mut().push("cancel");
    let removed = || calls.borrow_mut().push("refresh");
    let deps = RemoveDeps {
        guard: GuardDeps { swap_running: &sr, swap_pending: swap_pending.unwrap_or(&sp), swap_pending_now: None, read_only },
        is_live,
        cancel_login: &cancel,
        remove: remove.unwrap_or(&default_remove),
        on_removed: &removed,
    };
    let r = handle_remove_account(&deps, &json!(ID));
    (r, calls.into_inner())
}

fn not_live(_: &str) -> bool {
    false
}

#[test]
fn refuses_to_remove_an_account_while_a_swap_runs_or_is_pending() {
    for (running, pending, error) in [(true, false, "busy"), (false, true, "pending")] {
        let (r, calls) = remove_with(running, pending, None, &not_live, None, None);
        assert_eq!(r.unwrap().to_value(), json!({ "ok": false, "error": error }));
        assert!(calls.is_empty());
    }
}

#[test]
fn removes_when_nothing_blocks_and_validates_the_id() {
    let calls = RefCell::new(Vec::new());
    let (sr, sp) = (|| false, || Ok(false));
    let remove = |_: &str| {
        calls.borrow_mut().push("remove");
        Ok(())
    };
    let cancel = |_: &str| calls.borrow_mut().push("cancel");
    let removed = || calls.borrow_mut().push("refresh");
    let deps = RemoveDeps {
        guard: GuardDeps { swap_running: &sr, swap_pending: &sp, swap_pending_now: None, read_only: None },
        is_live: &not_live,
        cancel_login: &cancel,
        remove: &remove,
        on_removed: &removed,
    };
    assert_eq!(handle_remove_account(&deps, &json!("../x")).unwrap().to_value(), json!({ "ok": false }));
    assert_eq!(handle_remove_account(&deps, &json!(ID)).unwrap().to_value(), json!({ "ok": true }));
    assert_eq!(calls.into_inner(), ["cancel", "remove", "refresh"]);
}

#[test]
fn answers_a_fixed_read_only_code_instead_of_throwing_when_accounts_json_cannot_be_read_safely() {
    let yes = || true;
    let (r, calls) = remove_with(false, false, Some(&yes), &not_live, None, None);
    assert_eq!(r.unwrap().to_value(), json!({ "ok": false, "error": "readOnly" }));
    assert!(calls.is_empty());
    // The file became unreadable between the check and the write: the store's refusal is the same code.
    let read_only = |_: &str| Err(StoreError::ReadOnly);
    let (r, _) = remove_with(false, false, None, &not_live, None, Some(&read_only));
    assert_eq!(r.unwrap().to_value(), json!({ "ok": false, "error": "readOnly" }));
    let io = |_: &str| Err(StoreError::Io(io_err()));
    let (r, _) = remove_with(false, false, None, &not_live, None, Some(&io));
    assert!(matches!(r, Err(StoreError::Io(_))));
}

#[test]
fn refuses_to_remove_the_live_record_with_the_fixed_code_live_also_when_it_became_live_while_waiting() {
    let live_id = |id: &str| id == ID;
    let (r, calls) = remove_with(false, false, None, &live_id, None, None);
    assert_eq!(r.unwrap().to_value(), json!({ "ok": false, "error": "live" }));
    assert!(calls.is_empty());
    let live = Cell::new(false);
    let is_live = |_: &str| live.get();
    let racing = || {
        live.set(true);
        Ok(false)
    };
    let (r, calls) = remove_with(false, false, None, &is_live, Some(&racing), None);
    assert_eq!(r.unwrap().to_value(), json!({ "ok": false, "error": "live" }));
    assert!(calls.is_empty());
}

#[test]
fn checks_read_only_again_after_waiting_for_the_swap_state_before_a_parked_restore_is_dropped() {
    let read_only = Cell::new(false);
    let ro = || read_only.get();
    let racing = || {
        read_only.set(true);
        Ok(false)
    };
    let (r, calls) = remove_with(false, false, Some(&ro), &not_live, Some(&racing), None);
    assert_eq!(r.unwrap().to_value(), json!({ "ok": false, "error": "readOnly" }));
    assert!(calls.is_empty());
}

#[test]
fn dismissing_a_notice_ignores_only_a_read_only_store_and_turns_other_failures_into_a_fixed_error() {
    let ids = RefCell::new(Vec::new());
    let ok = |id: &str| {
        ids.borrow_mut().push(id.to_string());
        Ok(())
    };
    dismiss_account_notice(&ok, &json!("n1")).unwrap();
    dismiss_account_notice(&ok, &json!(5)).unwrap();
    dismiss_account_notice(&ok, &json!("x".repeat(65))).unwrap();
    assert_eq!(ids.into_inner(), ["n1"]);
    assert_eq!(dismiss_account_notice(&|_| Err(StoreError::ReadOnly), &json!("n1")), Ok(()));
    assert_eq!(dismiss_account_notice(&|_| Err(StoreError::Io(io_err())), &json!("n1")), Err("notice not dismissed"));
}

fn base<'a>(running: &'a dyn Fn() -> bool, pending: &'a dyn Fn() -> std::io::Result<bool>) -> GuardDeps<'a> {
    GuardDeps { swap_running: running, swap_pending: pending, swap_pending_now: None, read_only: None }
}

#[test]
fn refuses_every_claude_login_while_accounts_json_is_read_only_never_a_codex_one() {
    let (no, none, yes) = (|| false, || Ok(false), || true);
    let ro = GuardDeps { read_only: Some(&yes), ..base(&no, &none) };
    for target in [json!({ "type": "new" }), json!({ "type": "main" }), json!({ "type": "account", "id": ID })] {
        assert_eq!(login_block(&ro, &json!({ "provider": "claude", "target": target })), Some("readOnly"));
    }
    assert_eq!(login_block(&ro, &json!({ "provider": "codex", "target": { "type": "main" } })), None);
}

#[test]
fn holds_re_logins_of_the_main_login_or_a_saved_account_not_new_accounts() {
    let (no, yes, pending, free) = (|| false, || true, || Ok(true), || Ok(false));
    assert_eq!(
        login_block(&base(&no, &pending), &json!({ "provider": "claude", "target": { "type": "main" } })),
        Some("pending")
    );
    assert_eq!(
        login_block(&base(&yes, &free), &json!({ "provider": "claude", "target": { "type": "account", "id": ID } })),
        Some("busy")
    );
    assert_eq!(login_block(&base(&no, &pending), &json!({ "provider": "claude", "target": { "type": "new" } })), None);
    let failing = || Err(io_err());
    assert_eq!(account_mutation_block(&base(&no, &failing)), Some(MutationBlock::Pending));
}

#[test]
fn keeps_managed_profiles_untouched_by_background_refreshes_while_a_swap_runs_or_is_pending() {
    let calls = Cell::new(0);
    let refresh = |_: &Path| {
        calls.set(calls.get() + 1);
        "ok"
    };
    let (yes, no, free, pending) = (|| true, || false, || Ok(false), || Ok(true));
    assert_eq!(gate_profile_refresh(&base(&yes, &free), Path::new("d"), refresh, "blocked"), "blocked");
    let pending_now = GuardDeps { swap_pending_now: Some(&yes), ..base(&no, &pending) };
    assert_eq!(gate_profile_refresh(&pending_now, Path::new("d"), refresh, "blocked"), "blocked");
    assert_eq!(calls.get(), 0);
    assert_eq!(gate_profile_refresh(&base(&no, &free), Path::new("d"), refresh, "blocked"), "ok");
    assert_eq!(calls.get(), 1);
}

#[test]
fn does_not_block_codex_logins() {
    let (yes, pending) = (|| true, || Ok(true));
    assert_eq!(login_block(&base(&yes, &pending), &json!({ "provider": "codex", "target": { "type": "main" } })), None);
}

// ── accounts:adoptCopy (accounts-adopt-copy.test.ts) ─────────────────────────

fn live_id() -> AccountIdentity {
    AccountIdentity {
        email: Some("main@x.com".into()),
        account_uuid: Some("u-main".into()),
        organization_uuid: Some("o-main".into()),
        org: None,
    }
}
fn copy_id() -> AccountIdentity {
    AccountIdentity {
        email: Some("copy@x.com".into()),
        account_uuid: Some("u-copy".into()),
        organization_uuid: Some("o-copy".into()),
        org: None,
    }
}
fn roster() -> CswapRoster {
    CswapRoster::Present(Some(vec![AccountIdentity {
        email: Some("copy@x.com".into()),
        account_uuid: Some("u-copy".into()),
        ..Default::default()
    }]))
}

struct Adopt {
    _tmp: tempfile::TempDir,
    root: std::path::PathBuf,
    store: AccountsStore,
    copy: String,
}

fn adopt_setup() -> Adopt {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().to_path_buf();
    let store = AccountsStore::new(root.join("accounts"));
    // A 0.9.0 record (no custody, no family): app custody, live family.
    let copy = store.prepare().unwrap().0;
    store.commit(&ManagedAccount { id: copy.clone(), added_at: 1.0, identity: copy_id(), ..Default::default() }).unwrap();
    store.set_live(Some(&LiveIdentity { identity: live_id(), record_id: None })).unwrap();
    Adopt { _tmp: tmp, root, store, copy }
}

/// `deps(over)` of the TS suite, with each closure replaceable.
#[derive(Default)]
struct Over<'a> {
    swap_running: Option<&'a dyn Fn() -> bool>,
    swap_pending: Option<&'a dyn Fn() -> std::io::Result<bool>>,
    login_active: Option<&'a dyn Fn() -> bool>,
    read_only: Option<&'a dyn Fn() -> bool>,
    get: Option<GetFn<'a>>,
    set_family_own: Option<RemoveFn<'a>>,
}

fn adopt(a: &Adopt, over: Over<'_>, trusted: bool, id: &Value) -> (AdoptCopyResult, Vec<String>) {
    let adopted = Mutex::new(Vec::new());
    let (no, free) = (|| false, || Ok(false));
    let ro = || a.store.read_only();
    let get = |id: &str| a.store.get(id);
    let live = || a.store.live();
    let set = |id: &str| a.store.set_family(id, TokenFamily::Own);
    let on_adopted = |id: &str| adopted.lock().push(id.to_string());
    let deps = AdoptCopyDeps {
        guard: GuardDeps {
            swap_running: over.swap_running.unwrap_or(&no),
            swap_pending: over.swap_pending.unwrap_or(&free),
            swap_pending_now: None,
            read_only: Some(over.read_only.unwrap_or(&ro)),
        },
        login_active: over.login_active.unwrap_or(&no),
        get: over.get.unwrap_or(&get),
        live: &live,
        set_family_own: over.set_family_own.unwrap_or(&set),
        on_adopted: &on_adopted,
    };
    let r = handle_adopt_copy(&deps, trusted, id);
    (r, adopted.into_inner())
}

fn adopt_err(e: AdoptCopyError) -> AdoptCopyResult {
    AdoptCopyResult::fail(e)
}

#[test]
fn makes_a_held_by_cswap_copy_app_owned_and_reads_its_limits_now() {
    let a = adopt_setup();
    assert_eq!(renew_rule(&a.store.get(&a.copy).unwrap(), a.store.live().as_ref(), &roster()), RenewRule::HeldByCswap);
    let (r, adopted) = adopt(&a, Over::default(), true, &json!(a.copy));
    assert_eq!(r, AdoptCopyResult::OK);
    assert_eq!(a.store.get(&a.copy).unwrap().family, Some(TokenFamily::Own));
    assert_eq!(a.store.get(&a.copy).unwrap().custody, None);
    assert_eq!(adopted, vec![a.copy.clone()]);
}

#[test]
fn refuses_the_live_identity_also_when_only_the_e_mail_tells_it_apart_or_the_identity_is_unknown() {
    let a = adopt_setup();
    a.store.set_live(Some(&LiveIdentity { identity: copy_id(), record_id: None })).unwrap();
    assert_eq!(adopt(&a, Over::default(), true, &json!(a.copy)).0, adopt_err(AdoptCopyError::Live));
    a.store.set_live(Some(&LiveIdentity { identity: live_id(), record_id: Some(a.copy.clone()) })).unwrap();
    assert_eq!(adopt(&a, Over::default(), true, &json!(a.copy)).0, adopt_err(AdoptCopyError::Live));
    let bare = ManagedAccount { id: a.copy.clone(), added_at: 1.0, ..Default::default() };
    assert_eq!(
        adopt_copy_refusal(Some(&bare), Some(&LiveIdentity { identity: live_id(), record_id: None })),
        Some(AdoptCopyError::Live)
    );
    let full = ManagedAccount { id: a.copy.clone(), added_at: 1.0, identity: copy_id(), ..Default::default() };
    assert_eq!(adopt_copy_refusal(Some(&full), None), None);
    assert_eq!(a.store.get(&a.copy).unwrap().family, None);
}

#[test]
fn refuses_a_quarantined_foreign_or_live_custody_record_and_an_unknown_or_malformed_id() {
    let a = adopt_setup();
    for custody in [Custody::Quarantined, Custody::Foreign, Custody::Live] {
        let dup = if custody == Custody::Quarantined { Some(a.store.prepare().unwrap().0) } else { None };
        a.store.set_custody(&a.copy, custody, dup.as_deref()).unwrap();
        let (r, adopted) = adopt(&a, Over::default(), true, &json!(a.copy));
        assert_eq!(r, adopt_err(AdoptCopyError::Invalid));
        assert_eq!(a.store.get(&a.copy).unwrap().family, None);
        assert!(adopted.is_empty());
    }
    assert_eq!(
        adopt(&a, Over::default(), true, &json!("99999999-9999-4999-8999-999999999999")).0,
        adopt_err(AdoptCopyError::Invalid)
    );
    assert_eq!(adopt(&a, Over::default(), true, &json!("../x")).0, adopt_err(AdoptCopyError::Invalid));
}

#[test]
fn refuses_a_request_that_does_not_come_from_the_app_window() {
    let a = adopt_setup();
    assert_eq!(adopt(&a, Over::default(), false, &json!(a.copy)).0, adopt_err(AdoptCopyError::Invalid));
    assert_eq!(a.store.get(&a.copy).unwrap().family, None);
}

#[test]
fn refuses_with_read_only_while_accounts_json_cannot_be_read_safely_and_never_writes_it() {
    let a = adopt_setup();
    let file = a.root.join("accounts").join("accounts.json");
    let body = json!({ "version": 99, "claude": [{ "id": a.copy, "addedAt": 1, "email": "copy@x.com", "accountUuid": "u-copy", "organizationUuid": "o-copy" }] });
    std::fs::write(&file, body.to_string()).unwrap();
    let (r, adopted) = adopt(&a, Over::default(), true, &json!(a.copy));
    assert_eq!(r, adopt_err(AdoptCopyError::ReadOnly));
    // A file that becomes read-only between the checks and the write: the store's refusal is the same fixed code.
    let (no, copy) = (|| false, a.copy.clone());
    let get = move |_: &str| Some(ManagedAccount { id: copy.clone(), added_at: 1.0, identity: copy_id(), ..Default::default() });
    let (r2, adopted2) = adopt(&a, Over { read_only: Some(&no), get: Some(&get), ..Default::default() }, true, &json!(a.copy));
    assert_eq!(r2, adopt_err(AdoptCopyError::ReadOnly));
    assert!(adopted.is_empty() && adopted2.is_empty());
    assert_eq!(std::fs::read_to_string(&file).unwrap(), body.to_string());
}

#[test]
fn refuses_while_a_swap_runs_or_is_unresolved() {
    let a = adopt_setup();
    let (yes, pending) = (|| true, || Ok(true));
    assert_eq!(
        adopt(&a, Over { swap_running: Some(&yes), ..Default::default() }, true, &json!(a.copy)).0,
        adopt_err(AdoptCopyError::Busy)
    );
    assert_eq!(
        adopt(&a, Over { swap_pending: Some(&pending), ..Default::default() }, true, &json!(a.copy)).0,
        adopt_err(AdoptCopyError::Pending)
    );
    assert_eq!(a.store.get(&a.copy).unwrap().family, None);
}

#[test]
fn refuses_with_busy_while_a_login_window_flow_runs_before_and_after_the_wait() {
    let a = adopt_setup();
    let yes = || true;
    assert_eq!(
        adopt(&a, Over { login_active: Some(&yes), ..Default::default() }, true, &json!(a.copy)).0,
        adopt_err(AdoptCopyError::Busy)
    );
    // A login that starts while the swap state is being read.
    let login = Cell::new(false);
    let active = || login.get();
    let pending = || {
        login.set(true);
        Ok(false)
    };
    let (r, adopted) =
        adopt(&a, Over { login_active: Some(&active), swap_pending: Some(&pending), ..Default::default() }, true, &json!(a.copy));
    assert_eq!(r, adopt_err(AdoptCopyError::Busy));
    assert_eq!(a.store.get(&a.copy).unwrap().family, None);
    assert!(adopted.is_empty());
}

#[test]
fn refuses_with_busy_when_a_swap_starts_during_the_wait_right_before_the_write() {
    let a = adopt_setup();
    let swap = Cell::new(false);
    let running = || swap.get();
    let pending = || {
        swap.set(true);
        Ok(false)
    };
    let (r, adopted) = adopt(
        &a,
        Over { swap_running: Some(&running), swap_pending: Some(&pending), ..Default::default() },
        true,
        &json!(a.copy),
    );
    assert_eq!(r, adopt_err(AdoptCopyError::Busy));
    assert_eq!(a.store.get(&a.copy).unwrap().family, None);
    assert!(adopted.is_empty());
}

#[test]
fn reports_a_failed_write_with_a_fixed_code_and_no_message() {
    let a = adopt_setup();
    let fail = |_: &str| Err(StoreError::Io(std::io::Error::other("EACCES C:\\secret\\path")));
    let (r, _) = adopt(&a, Over { set_family_own: Some(&fail), ..Default::default() }, true, &json!(a.copy));
    assert_eq!(r, adopt_err(AdoptCopyError::Write));
    assert_eq!(r.to_value().to_string(), r#"{"ok":false,"error":"write"}"#);
}

#[test]
fn renew_rule_allows_it_and_gate_family_refresh_lets_the_renewal_run() {
    let a = adopt_setup();
    let dir = a.store.dir_of(&a.copy).unwrap();
    std::fs::create_dir_all(&dir).unwrap();
    let calls = RefCell::new(Vec::new());
    let refresh = |d: &Path| {
        calls.borrow_mut().push(d.to_path_buf());
        "renewed"
    };
    assert_eq!(gate_family_refresh(&a.store, &roster(), &dir, refresh, "blocked"), "blocked");
    assert!(calls.borrow().is_empty());
    adopt(&a, Over::default(), true, &json!(a.copy));
    assert_eq!(renew_rule(&a.store.get(&a.copy).unwrap(), a.store.live().as_ref(), &roster()), RenewRule::Allowed);
    assert_eq!(gate_family_refresh(&a.store, &roster(), &dir, refresh, "blocked"), "renewed");
    assert_eq!(calls.into_inner(), vec![dir]);
}

// ── accounts:makeMain handler (accounts-makemain.test.ts) ────────────────────

const MM_ID: &str = "123e4567-e89b-42d3-a456-426614174000";

struct Mm {
    login: bool,
    validate: ValidateFn,
    swap: SwapFn,
    swapped_fails: bool,
}

impl Default for Mm {
    fn default() -> Self {
        Self {
            login: false,
            validate: Box::new(|_| Ok(None)),
            swap: Box::new(|_| Ok(SwapResult::ok(Some("a@b.c".into())))),
            swapped_fails: false,
        }
    }
}

/// Runs the handler and reports (result, validate calls, swap calls, onSwapped calls).
fn make_main(mm: &Mm, id: &Value) -> (SwapResult, Vec<String>, Vec<String>, usize) {
    let (validated, swapped, on) = (RefCell::new(Vec::new()), RefCell::new(Vec::new()), Cell::new(0));
    let login = || mm.login;
    let validate = |id: &str| {
        validated.borrow_mut().push(id.to_string());
        (mm.validate)(id)
    };
    let swap = |id: &str| {
        swapped.borrow_mut().push(id.to_string());
        (mm.swap)(id)
    };
    let on_swapped = || {
        on.set(on.get() + 1);
        if mm.swapped_fails { Err(()) } else { Ok(()) }
    };
    let deps = MakeMainDeps { login_active: &login, validate: &validate, swap: &swap, on_swapped: &on_swapped };
    let r = handle_make_main(&deps, id);
    (r, validated.into_inner(), swapped.into_inner(), on.get())
}

#[test]
fn rejects_anything_that_is_not_an_account_id_without_touching_the_swap() {
    let mm = Mm::default();
    for bad in
        [Value::Null, json!(5), json!(""), json!("../x"), json!("main"), json!({ "id": MM_ID }), json!(format!("{MM_ID}/.."))]
    {
        let (r, _, swapped, on) = make_main(&mm, &bad);
        assert_eq!(r, SwapResult::fail(SwapError::Invalid));
        assert!(swapped.is_empty());
        assert_eq!(on, 0);
    }
}

#[test]
fn refuses_with_busy_while_a_login_is_in_progress() {
    let mm = Mm { login: true, ..Mm::default() };
    let (r, _, swapped, _) = make_main(&mm, &json!(MM_ID));
    assert_eq!(r, SwapResult::fail(SwapError::Busy));
    assert!(swapped.is_empty());
}

#[test]
fn validates_the_target_in_the_main_process_and_refuses_without_swapping() {
    let refused = Mm {
        validate: Box::new(|_| Ok(Some(SwapResult::fail_named(SwapError::Foreign, Some("x@x.com".into()))))),
        ..Mm::default()
    };
    let (r, validated, swapped, on) = make_main(&refused, &json!(MM_ID));
    assert_eq!(r, SwapResult::fail_named(SwapError::Foreign, Some("x@x.com".into())));
    assert_eq!(validated, vec![MM_ID]);
    assert!(swapped.is_empty());
    assert_eq!(on, 0);
    let throwing = Mm { validate: Box::new(|_| Err(())), ..Mm::default() };
    let (r, _, swapped, _) = make_main(&throwing, &json!(MM_ID));
    assert_eq!(r, SwapResult::fail(SwapError::Write));
    assert!(swapped.is_empty());
}

#[test]
fn refreshes_usage_only_after_a_successful_swap_and_passes_the_result_through() {
    let (r, _, swapped, on) = make_main(&Mm::default(), &json!(MM_ID));
    assert_eq!(r, SwapResult::ok(Some("a@b.c".into())));
    assert_eq!(swapped, vec![MM_ID]);
    assert_eq!(on, 1);
    let failed = Mm { swap: Box::new(|_| Ok(SwapResult::fail(SwapError::Dead))), ..Mm::default() };
    let (r, _, _, on) = make_main(&failed, &json!(MM_ID));
    assert_eq!(r, SwapResult::fail(SwapError::Dead));
    assert_eq!(on, 0);
}

#[test]
fn turns_a_throwing_swap_into_a_write_error_and_survives_a_throwing_refresh() {
    let boom = Mm { swap: Box::new(|_| Err(())), ..Mm::default() };
    let (r, _, _, _) = make_main(&boom, &json!(MM_ID));
    assert_eq!(r, SwapResult::fail(SwapError::Write));
    assert!(!r.to_value().to_string().contains("secret-token"));
    let bad_refresh = Mm { swapped_fails: true, ..Mm::default() };
    assert_eq!(make_main(&bad_refresh, &json!(MM_ID)).0, SwapResult::ok(Some("a@b.c".into())));
}

#[test]
fn dead_and_held_token_helpers() {
    let dir = tempfile::tempdir().unwrap();
    let fs = crate::swapfs::RealSwapFs;
    assert_eq!(saved_refresh_token(&fs, dir.path()), None);
    std::fs::write(dir.path().join(".credentials.json"), r#"{"claudeAiOauth":{"accessToken":"a","refreshToken":"r1"}}"#).unwrap();
    assert_eq!(saved_refresh_token(&fs, dir.path()).as_deref(), Some("r1"));
    let mut record = ManagedAccount { id: ID.into(), added_at: 1.0, ..Default::default() };
    assert!(!saved_copy_dead(&fs, dir.path(), Some(&record)));
    record.dead_tokens = Some(token_hash("r1"));
    assert!(saved_copy_dead(&fs, dir.path(), Some(&record)));
    record.dead_tokens = Some(token_hash("r0"));
    assert!(!saved_copy_dead(&fs, dir.path(), Some(&record)));
    let cleared =
        json!({ "claudeAiOauth": { "accessToken": "", "refreshToken": "", "expiresAt": 0, "subscriptionType": "max" } });
    assert!(is_cleared_login(cleared.as_object().unwrap()));
    assert!(!is_cleared_login(json!({ "claudeAiOauth": { "accessToken": "", "refreshToken": "x" } }).as_object().unwrap()));
    assert!(!is_cleared_login(json!({}).as_object().unwrap()));
    assert_eq!(token_hash("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
}
