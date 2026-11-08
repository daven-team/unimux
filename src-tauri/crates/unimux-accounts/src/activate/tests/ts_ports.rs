//! The accounts-activate cases that need A3 (reconcileLive, reconcileWhenIdle, resyncActiveBackup, claudeRefs) and A5
//! (fetchClaude) in between the swaps: whole ports of the cases the parent module ports only in part.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use futures::FutureExt;
use futures::future::BoxFuture;

use super::*;
use crate::reconcile::{LiveGuard, ReconcileDeps, WroteSinceFn, reconcile_live, reconcile_when_idle};
use crate::refs::{AccountRef, RefsInput, claude_refs};
use crate::resync::{ResyncDeps, resync_active_backup};
use crate::swapfs::SwapPaths;

fn id_a() -> AccountIdentity {
    ident("a@x.com", "uuid-A", "org-A")
}
fn id_x() -> AccountIdentity {
    ident("x@x.com", "uuid-X", "org-X")
}

/// `reconcileLive({ store, readLiveIdentity, now, cswapWroteSince? }, { ownChange })`.
fn reconcile(s: &T, live: AccountIdentity, own_change: bool, wrote: Option<bool>) {
    let read = move || Ok(Some(live.clone()));
    let wrote_fn = move |_: &AccountIdentity, _: f64| Ok(wrote.unwrap_or(true));
    let now = || NOW;
    let deps = ReconcileDeps {
        store: &s.store,
        read_live_identity: &read,
        resync: None,
        cswap_wrote_since: wrote.map(|_| &wrote_fn as &WroteSinceFn),
        saved_copy_dead: None,
        now: &now,
    };
    reconcile_live(&deps, own_change).unwrap();
}

fn refs(s: &T, roster: &CswapRoster) -> Vec<AccountRef> {
    let records = s.store.list();
    let live = s.store.live();
    let dir_of = |id: &str| s.store.dir_of(id).ok();
    claude_refs(&RefsInput { records: &records, dir_of: &dir_of, live: live.as_ref(), cswap: roster, darwin: false })
}

fn rule_of(s: &T, roster: &CswapRoster, id: &str) -> Option<RenewRule> {
    refs(s, roster).into_iter().find(|r| r.id == format!("claude:{id}")).and_then(|r| r.renew)
}

/// accounts-activate "the target takes the live family: switched out again by an own change while cswap lists it, it is
/// never renewable (I1)"
#[test]
fn ts_the_target_takes_the_live_family_and_an_own_change_never_makes_it_renewable() {
    let s = setup();
    let roster = listed(&["x"]);
    s.set_roster(roster.clone());
    assert!(s.activate(&s.t).ok);
    assert_eq!(s.get(&s.t).family, Some(TokenFamily::Live));
    // The app signs in someone else (a main re-login): T leaves the live login as an own change and becomes `app`.
    reconcile(&s, ident("g@x.com", "uuid-G", "org-G"), true, None);
    assert_eq!(custody(&s.get(&s.t)), Custody::App);
    assert_eq!(rule_of(&s, &roster, &s.t), Some(RenewRule::HeldByCswap));
}

/// accounts-activate "keeps the journal while Claude Code holds its locks, never marks the swap unresolved, and blocks
/// reconcile until it recovers"
#[test]
fn ts_a_locked_recovery_keeps_the_journal_and_blocks_reconcile_until_it_recovers() {
    let s = setup();
    crashed_after_live_writes(&s);
    std::fs::create_dir(s.home.join(".claude.lock")).unwrap();
    assert_eq!(recover(&s), Recovery::Locked);
    assert!(!s.slot.is_unresolved() && s.slot.is_recovery_pending());
    assert!(s.backup_dir().join("swap-journal.json").exists());
    let backup_dir = s.backup_dir();
    let unresolved = || s.slot.is_unresolved();
    let pending = || Ok(activation_journal_pending(&RealSwapFs, &backup_dir));
    let guard = LiveGuard { swap_unresolved: &unresolved, login_active: &|| false, journal_pending: Some(&pending) };
    let runs = AtomicUsize::new(0);
    let run = || {
        runs.fetch_add(1, Ordering::SeqCst);
        Ok::<(), ()>(())
    };
    assert_eq!(reconcile_when_idle(&s.slot, &guard, run), Ok(false));
    assert_eq!(runs.load(Ordering::SeqCst), 0);
    std::fs::remove_dir(s.home.join(".claude.lock")).unwrap();
    assert_eq!(recover(&s), Recovery::Recovered);
    assert!(!s.slot.is_recovery_pending() && !s.slot.is_unresolved());
    assert_eq!(reconcile_when_idle(&s.slot, &guard, run), Ok(true));
    assert_eq!(runs.load(Ordering::SeqCst), 1);
}

/// accounts-activate "marks the outgoing record switched out and never copies the live tokens into it afterwards" (with the
/// poll in between: the reconcile with the resync of the live backup)
#[test]
fn ts_the_outgoing_record_keeps_its_own_copy_through_the_next_poll_and_a_swap() {
    let s = setup();
    crashed_between_live_writes(&s, "live-json-written");
    assert!(clear(&s));
    assert_eq!(custody(&s.get(&s.a)), Custody::Foreign);
    assert!(s.get(&s.a).held_tokens.as_deref().is_some_and(js::is_hex64));
    // The next poll: A is signed in by identity, so it holds the card again, but its saved copy is never overwritten.
    let paths = SwapPaths { credentials: s.live_creds(), claude_json: s.live_json() };
    let locks = LockOptions { timeout: Duration::from_millis(300), ..LockOptions::default() };
    let rdeps = ResyncDeps {
        paths: &paths,
        store: &s.store,
        fs: &RealSwapFs,
        locks: &locks,
        profiles: &s.profiles,
        delay: &|_| {},
        seen: None,
    };
    let resync = |id: &str, expected: &AccountIdentity| resync_active_backup(&rdeps, id, expected);
    let read = || Ok(Some(id_a()));
    let deps = ReconcileDeps {
        store: &s.store,
        read_live_identity: &read,
        resync: Some(&resync),
        cswap_wrote_since: None,
        saved_copy_dead: None,
        now: &|| NOW,
    };
    reconcile_live(&deps, false).unwrap();
    assert_eq!(custody(&s.get(&s.a)), Custody::Live);
    assert_eq!(json(&s.dir(&s.a).join(".credentials.json"))["claudeAiOauth"]["refreshToken"], "fake-ref-A");
    assert!(s.activate(&s.t).ok);
    assert_eq!(json(&s.dir(&s.a).join(".credentials.json"))["claudeAiOauth"]["refreshToken"], "fake-ref-A");
    assert_eq!(json(&s.live_creds())["claudeAiOauth"]["refreshToken"], "fake-ref-X");
}

struct NoRequests(AtomicUsize);

impl crate::refresh::renew::TokenFetch for NoRequests {
    fn fetch(&self, _req: unimux_net::Request) -> BoxFuture<'static, Result<unimux_net::Response, unimux_net::FetchError>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        async { Err(unimux_net::FetchError::Connect("no requests here".into())) }.boxed()
    }
}

/// accounts-activate "cswap writes its own copy of A into Claude Code: one card per account, the target is never POSTed"
#[test]
fn ts_cswaps_own_copy_of_a_gives_one_card_per_account_and_the_target_is_never_renewed() {
    use crate::usage::credentials::CredentialSource;
    use crate::usage::fetchers::{FetcherDeps, fetch_claude};
    use crate::usage::types::Status;
    let s = setup();
    assert!(s.activate(&s.t).ok);
    // cswap's switch: a different token family of A plus A's identity.
    put(
        &s.live_creds(),
        &json!({ "claudeAiOauth": { "accessToken": "fake-acc-cswap", "refreshToken": "fake-ref-cswap", "expiresAt": js::num(FUTURE) } }),
    );
    put(&s.live_json(), &json!({ "oauthAccount": account("A", "a@x.com") }));
    reconcile(&s, id_a(), false, None);
    assert_eq!(custody(&s.get(&s.a)), Custody::Live);
    assert_eq!(custody(&s.get(&s.t)), Custody::Foreign);
    let cards = refs(&s, &CswapRoster::Absent);
    assert_eq!(cards.iter().map(|r| r.id.clone()).collect::<Vec<_>>(), [format!("claude:{}", s.a), format!("claude:{}", s.t)]);
    put(&s.dir(&s.t).join(".credentials.json"), &creds("X", NOW - 1000.0));
    let requests = Arc::new(NoRequests(AtomicUsize::new(0)));
    let renewals = Arc::new(AtomicUsize::new(0));
    let r = renewals.clone();
    let deps = FetcherDeps {
        credentials: CredentialSource::system(BTreeMap::new(), s.home.clone(), false, None),
        fetch: requests.clone(),
        now: Arc::new(|| NOW),
        codex_home: Arc::new(|| PathBuf::from("/nowhere/.codex")),
        claude_url: "https://claude.test/usage".into(),
        codex_url: "https://codex.test/usage".into(),
        refresh_claude: Some(Arc::new(move |_: &Path| {
            r.fetch_add(1, Ordering::SeqCst);
            async { RefreshOutcome::Ok }.boxed()
        })),
        sleep: Arc::new(|_| async {}.boxed()),
        user_agent: "unimux/test".into(),
    };
    let usage = futures::executor::block_on(fetch_claude(&deps, &cards[1])).usage;
    assert_eq!(usage.status, Status::Elsewhere);
    assert_eq!((renewals.load(Ordering::SeqCst), requests.0.load(Ordering::SeqCst)), (0, 0));
}

/// accounts-activate "an adopted copy stays the app's own after the app makes it main and switches away again" (with the
/// polls between the swaps)
#[test]
fn ts_an_adopted_copy_stays_the_apps_own_through_the_polls_between_the_swaps() {
    let s = setup();
    let roster = listed(&["a", "x"]);
    s.set_roster(roster.clone());
    let written = Arc::new(AtomicBool::new(false));
    let w = written.clone();
    s.set_wrote_since(Some(Arc::new(move || w.load(Ordering::SeqCst))));
    assert_eq!(rule_of(&s, &roster, &s.t), Some(RenewRule::Allowed));
    assert!(s.activate(&s.t).ok);
    reconcile(&s, id_x(), false, None);
    assert!(s.activate(&s.a).ok);
    reconcile(&s, id_a(), false, None);
    let t = s.get(&s.t);
    assert_eq!((custody(&t), t.family), (Custody::App, Some(TokenFamily::Own)));
    assert_eq!(rule_of(&s, &roster, &s.t), Some(RenewRule::Allowed));
    // Once more, with two polls while it is main.
    assert!(s.activate(&s.t).ok);
    reconcile(&s, id_x(), false, None);
    reconcile(&s, id_x(), false, None);
    assert!(s.activate(&s.a).ok);
    reconcile(&s, id_a(), false, None);
    assert_eq!(rule_of(&s, &roster, &s.t), Some(RenewRule::Allowed));
    // cswap backed up T's live login meanwhile: cswap holds the newest tokens, so it is not renewed any more.
    assert!(s.activate(&s.t).ok);
    written.store(true, Ordering::SeqCst);
    assert!(s.activate(&s.a).ok);
    let t = s.get(&s.t);
    assert_eq!((custody(&t), t.family), (Custody::App, Some(TokenFamily::Live)));
    assert_eq!(rule_of(&s, &roster, &s.t), Some(RenewRule::HeldByCswap));
}

/// accounts-activate "without a cswap check (unknown) and after a switch by another tool nothing becomes the app's own"
#[test]
fn ts_after_a_switch_by_another_tool_nothing_becomes_the_apps_own() {
    let s = setup();
    s.set_roster(listed(&["a", "x"]));
    assert!(s.activate(&s.t).ok);
    assert!(s.activate(&s.a).ok);
    assert_eq!(s.get(&s.t).family, Some(TokenFamily::Live));
    s.store.set_family(&s.t, TokenFamily::Own).unwrap();
    s.set_wrote_since(Some(Arc::new(|| false)));
    assert!(s.activate(&s.t).ok);
    // cswap switches back to A: T left the live login through another tool.
    put(&s.live_creds(), &creds("A3", FUTURE));
    put(&s.live_json(), &json!({ "oauthAccount": account("A", "a@x.com") }));
    reconcile(&s, id_a(), false, None);
    let t = s.get(&s.t);
    assert_eq!((custody(&t), t.family, t.app_swap), (Custody::Foreign, Some(TokenFamily::Live), None));
}

/// accounts-activate "the app's main re-login keeps an adopted copy its own only while cswap wrote nothing (reconcile, own
/// change)"
#[test]
fn ts_a_main_relogin_keeps_an_adopted_copy_its_own_only_while_cswap_wrote_nothing() {
    let s = setup();
    s.set_roster(listed(&["a", "x"]));
    s.set_wrote_since(Some(Arc::new(|| false)));
    assert!(s.activate(&s.t).ok);
    let swap = s.get(&s.t);
    assert_eq!(swap.app_swap.as_ref().map(|a| (a.at, a.own)), Some((NOW, true)));
    reconcile(&s, id_a(), true, Some(false));
    let t = s.get(&s.t);
    assert_eq!((custody(&t), t.family), (Custody::App, Some(TokenFamily::Own)));
    // The same with a cswap copy written meanwhile: the live family.
    s.store.commit(&ManagedAccount { custody: Some(Custody::Live), ..swap }).unwrap();
    s.store.set_live(Some(&LiveIdentity { identity: id_x(), record_id: Some(s.t.clone()) })).unwrap();
    reconcile(&s, id_a(), true, Some(true));
    let t = s.get(&s.t);
    assert_eq!((custody(&t), t.family), (Custody::App, Some(TokenFamily::Live)));
}
