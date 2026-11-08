//! Ports of test/accounts-dead-login.test.ts (1.0.10: a main Claude login that Claude Code itself cleared as dead) and of the
//! first-login cases of test/auth-first-login.test.ts that need the activation, the reconcile and the live-login readers.

use std::sync::atomic::{AtomicUsize, Ordering};

use futures::FutureExt;
use futures::future::BoxFuture;

use crate::identity::{Custody, IdentityMatch, compare_identity, custody_of};
use crate::live::{LoginPresence, claude_login_presence, read_signed_in_claude_identity};
use crate::reconcile::{BackupOptions, ReconcileDeps, backup_live_before_login, reconcile_live};
use crate::refresh::renew::TokenFetch;
use crate::refs::{AccountRef, RefsInput, claude_refs};
use crate::resync::{ResyncDeps, ResyncResult, resync_active_backup};
use crate::rules::{is_cleared_login, saved_copy_dead, token_hash};
use crate::swapfs::{RealSwapFs, SwapPaths};
use crate::test_support::*;
use crate::usage::credentials::CredentialSource;
use crate::usage::fetchers::{FetcherDeps, fetch_claude};
use crate::usage::types::{CardState, ProviderUsage, Source, Status, UsageWindow, WindowId, card_state};
use parking_lot::Mutex;

use super::super::*;

/// 2026-10-31T00:07:00Z.
const NOW: f64 = 1_793_405_220_000.0;
const FUTURE: f64 = NOW + 3_600_000.0;
const DAY: f64 = 24.0 * 3_600_000.0;

fn creds(n: &str, expires_at: f64) -> Value {
    serde_json::json!({ "claudeAiOauth": { "accessToken": format!("fake-acc-{n}"), "refreshToken": format!("fake-ref-{n}"), "expiresAt": js::num(expires_at), "scopes": ["s"], "subscriptionType": "team", "rateLimitTier": "default_claude_max_5x" } })
}

/// Exactly what Claude Code writes after the token endpoint answers invalid_grant ("OAuth dead-token disk clear").
fn cleared() -> Value {
    let mut c = creds("D", FUTURE);
    c["claudeAiOauth"]["accessToken"] = "".into();
    c["claudeAiOauth"]["refreshToken"] = "".into();
    c["claudeAiOauth"]["expiresAt"] = 0.into();
    c["mcpOAuth"] = serde_json::json!({ "server": "m" });
    c
}

fn account(n: &str, email: &str) -> Value {
    serde_json::json!({ "emailAddress": email, "organizationName": format!("Org {n}"), "accountUuid": format!("uuid-{n}"), "organizationUuid": format!("org-{n}") })
}

fn ident(n: &str) -> AccountIdentity {
    AccountIdentity {
        email: Some(format!("{}@x.com", n.to_lowercase())),
        account_uuid: Some(format!("uuid-{n}")),
        organization_uuid: Some(format!("org-{n}")),
        org: None,
    }
}

struct D {
    fx: Fx,
    d: String,
    s: String,
}

impl std::ops::Deref for D {
    type Target = Fx;
    fn deref(&self) -> &Fx {
        &self.fx
    }
}

fn record(fx: &Fx, n: &str, added: f64, custody: Custody, family: TokenFamily) -> String {
    let id = fx.store.prepare().unwrap().0;
    fx.store
        .commit(&ManagedAccount {
            id: id.clone(),
            added_at: added,
            identity: ident(n),
            custody: Some(custody),
            family: Some(family),
            ..Default::default()
        })
        .unwrap();
    id
}

/// Daniel (D) is the main account whose login died; support (S) an app-held account the user wants to make main.
fn setup() -> D {
    let fx = Fx::new(NOW);
    put(&fx.live_json(), &serde_json::json!({ "oauthAccount": account("D", "d@x.com"), "projects": { "p": 1 } }));
    std::fs::create_dir_all(fx.home.join(".claude")).unwrap();
    let d = record(&fx, "D", 1.0, Custody::Live, TokenFamily::Live);
    // The app's backup of the live login, from before the login died (the same token family).
    put(&fx.dir(&d).join(".credentials.json"), &creds("D", NOW - DAY));
    put(&fx.dir(&d).join(".claude.json"), &serde_json::json!({ "oauthAccount": account("D", "d@x.com") }));
    let s = record(&fx, "S", 2.0, Custody::App, TokenFamily::Own);
    put(&fx.dir(&s).join(".credentials.json"), &creds("S", FUTURE));
    put(&fx.dir(&s).join(".claude.json"), &serde_json::json!({ "oauthAccount": account("S", "s@x.com") }));
    fx.store.set_live(Some(&LiveIdentity { identity: ident("D"), record_id: Some(d.clone()) })).unwrap();
    D { fx, d, s }
}

impl D {
    fn refs(&self) -> Vec<AccountRef> {
        let records = self.store.list();
        let live = self.store.live();
        let roster = self.knobs.roster.lock().clone();
        let dir_of = |id: &str| self.store.dir_of(id).ok();
        claude_refs(&RefsInput { records: &records, dir_of: &dir_of, live: live.as_ref(), cswap: &roster, darwin: false })
    }
    fn card(&self, id: &str) -> AccountRef {
        self.refs().into_iter().find(|r| r.id == format!("claude:{id}")).unwrap()
    }
    fn resync(&self, id: &str, identity: &AccountIdentity) -> ResyncResult {
        let paths = SwapPaths { credentials: self.live_creds(), claude_json: self.live_json() };
        let locks = LockOptions { timeout: Duration::from_millis(300), ..LockOptions::default() };
        let deps = ResyncDeps {
            paths: &paths,
            store: &self.store,
            fs: &RealSwapFs,
            locks: &locks,
            profiles: &self.profiles,
            delay: &|_| {},
            seen: None,
        };
        resync_active_backup(&deps, id, identity).unwrap()
    }
    fn get(&self, id: &str) -> ManagedAccount {
        self.store.get(id).unwrap()
    }
    fn activate(&self, id: &str) -> SwapResult {
        activate_account(&self.deps(), id)
    }
    fn switched_away(&self) {
        self.store.set_live(Some(&LiveIdentity { identity: ident("S"), record_id: Some(self.s.clone()) })).unwrap();
        self.store.set_custody(&self.s, Custody::Live, None).unwrap();
    }
}

/// The usage endpoint: counts the requests and answers `status` to each.
struct Endpoint {
    requests: AtomicUsize,
    status: u16,
}

impl TokenFetch for Endpoint {
    fn fetch(&self, _req: unimux_net::Request) -> BoxFuture<'static, Result<unimux_net::Response, unimux_net::FetchError>> {
        self.requests.fetch_add(1, Ordering::SeqCst);
        let response = unimux_net::Response {
            status: self.status,
            headers: unimux_net::Headers(Vec::new()),
            url: url::Url::parse("https://claude.test/usage").unwrap(),
            redirected: false,
            body: bytes::Bytes::from_static(b"{}"),
        };
        async move { Ok(response) }.boxed()
    }
}

struct Read {
    usage: ProviderUsage,
    requests: usize,
    renewals: usize,
}

fn read(s: &D, r: &AccountRef, status: u16, outcome: RefreshOutcome) -> Read {
    let endpoint = Arc::new(Endpoint { requests: AtomicUsize::new(0), status });
    let renewals = Arc::new(AtomicUsize::new(0));
    let n = renewals.clone();
    let deps = FetcherDeps {
        credentials: CredentialSource::system(BTreeMap::new(), s.home.clone(), false, None),
        fetch: endpoint.clone(),
        now: Arc::new(|| NOW),
        codex_home: Arc::new(|| PathBuf::from("/nowhere/.codex")),
        claude_url: "https://claude.test/usage".into(),
        codex_url: "https://codex.test/usage".into(),
        refresh_claude: Some(Arc::new(move |_: &Path| {
            n.fetch_add(1, Ordering::SeqCst);
            let o = outcome.clone();
            async move { o }.boxed()
        })),
        sleep: Arc::new(|_| async {}.boxed()),
        user_agent: "unimux/test".into(),
    };
    let usage = futures::executor::block_on(fetch_claude(&deps, r)).usage;
    Read { usage, requests: endpoint.requests.load(Ordering::SeqCst), renewals: renewals.load(Ordering::SeqCst) }
}

fn ok_read(s: &D, r: &AccountRef) -> Read {
    read(s, r, 200, RefreshOutcome::Ok)
}

// ---- bug 1: the card of a main login Claude Code cleared as dead ---------------------------------------------------------

/// accounts-dead-login "recognises Claude Code's dead-token clear and nothing else"
#[test]
fn ts_recognises_the_dead_token_clear_and_nothing_else() {
    assert!(is_cleared_login(cleared().as_object().unwrap()));
    assert!(!is_cleared_login(creds("D", FUTURE).as_object().unwrap()));
    assert!(!is_cleared_login(
        serde_json::json!({ "claudeAiOauth": { "accessToken": "a", "refreshToken": "" } }).as_object().unwrap()
    ));
    assert!(!is_cleared_login(&serde_json::Map::new()));
}

/// accounts-dead-login "shows the live card as an expired sign-in (not signed out, not dormant) without any request", "keeps
/// calling an expired access token with a refresh token dormant (Claude Code has not given up on it)"
#[test]
fn ts_a_cleared_main_login_is_an_expired_sign_in_and_an_expired_token_with_a_refresh_token_dormant() {
    let s = setup();
    put(&s.live_creds(), &cleared());
    let r = ok_read(&s, &s.refs()[0]);
    let u = &r.usage;
    assert_eq!(
        (u.status, u.error.as_deref(), u.email.as_deref(), u.plan.as_deref(), u.active),
        (Status::Expired, Some("login-dead"), Some("d@x.com"), Some("Team 5x"), true)
    );
    assert_eq!(r.requests, 0);
    put(&s.live_creds(), &creds("D", NOW - DAY));
    assert_eq!(ok_read(&s, &s.refs()[0]).usage.status, Status::Dormant);
}

/// accounts-dead-login "marks nothing for a cleared login of another identity, nor while tokens are held as not the record's
/// own"
#[test]
fn ts_marks_nothing_for_another_identity_nor_while_tokens_are_held() {
    let s = setup();
    put(&s.live_creds(), &cleared());
    assert_eq!(s.resync(&s.d, &ident("G")), ResyncResult::Mismatch);
    assert_eq!(s.get(&s.d).dead_tokens, None);
    s.store.set_held_tokens(&s.d, Some(&token_hash("other"))).unwrap();
    assert_eq!(s.resync(&s.d, &ident("D")), ResyncResult::Dead);
    assert_eq!(s.get(&s.d).dead_tokens, None);
}

/// accounts-dead-login "a main re-login is not blocked by the dead login (nothing left to back up)"
#[test]
fn ts_a_main_relogin_is_not_blocked_by_the_dead_login() {
    let s = setup();
    put(&s.live_creds(), &cleared());
    let read_live = || Ok(Some(ident("D")));
    let resync = |id: &str, i: &AccountIdentity| Ok(s.resync(id, i));
    let deps = ReconcileDeps {
        store: &s.store,
        read_live_identity: &read_live,
        resync: Some(&resync),
        cswap_wrote_since: None,
        saved_copy_dead: None,
        now: &|| NOW,
    };
    let opts = BackupOptions { delay: &|_| {}, tries: Some(1), gap: None, own_change: false, own_change_applied: None };
    assert_eq!(backup_live_before_login(&s.slot, &|| false, None, &deps, &opts), Ok(()));
}

/// accounts-dead-login "a saved card whose copy is marked dead shows an expired sign-in, never renewed nor sent anywhere"
/// (`makeMainOffered` stays in the renderer)
#[test]
fn ts_a_dead_marked_copy_is_an_expired_sign_in_without_any_request() {
    let s = setup();
    s.store.set_custody(&s.d, Custody::Foreign, None).unwrap();
    s.switched_away();
    s.store.set_dead_tokens(&s.d, Some(&token_hash("fake-ref-D"))).unwrap();
    let card = s.card(&s.d);
    assert_eq!(card.dead_tokens, Some(token_hash("fake-ref-D")));
    let r = ok_read(&s, &card);
    assert_eq!((r.usage.status, r.usage.error.as_deref(), r.usage.managed), (Status::Expired, Some("login-dead"), Some(true)));
    assert_eq!((r.requests, r.renewals), (0, 0));
}

// ---- bug 2: making another account main while the main login is dead or missing ---------------------------------------

/// accounts-dead-login "works when Claude Code cleared the main login: the target becomes main, the dead account keeps its
/// copy marked dead"
#[test]
fn ts_make_main_works_over_a_cleared_main_login() {
    let s = setup();
    put(&s.live_creds(), &cleared());
    let before = text(&s.dir(&s.d).join(".credentials.json"));
    assert_eq!(s.activate(&s.s), SwapResult::ok(Some("s@x.com".into())));
    let mut want = creds("S", FUTURE);
    want["mcpOAuth"] = serde_json::json!({ "server": "m" });
    assert_eq!(json(&s.live_creds()), want);
    assert_eq!(json(&s.live_json()), serde_json::json!({ "oauthAccount": account("S", "s@x.com"), "projects": { "p": 1 } }));
    assert_eq!(text(&s.dir(&s.d).join(".credentials.json")), before);
    let d = s.get(&s.d);
    assert_eq!(
        (custody_of(d.custody), d.family, d.dead_tokens),
        (Custody::App, Some(TokenFamily::Live), Some(token_hash("fake-ref-D")))
    );
    let t = s.get(&s.s);
    assert_eq!((custody_of(t.custody), t.family), (Custody::Live, Some(TokenFamily::Live)));
    assert_eq!(s.store.live().and_then(|l| l.record_id), Some(s.s.clone()));
    assert_eq!(s.store.list().len(), 2);
    assert!(names(&s.backup_dir()).is_empty());
    assert!(s.refresh_calls().is_empty());
}

/// accounts-dead-login "works when the credentials file is gone entirely; the account keeps its copy unmarked (no proof it
/// is dead)", "works with no account in the config either (signed out), creating no record", "still saves an expired but
/// renewable main login into its record (a valid token family is never lost)"
#[test]
fn ts_make_main_works_without_a_credentials_file_or_an_account_and_saves_a_renewable_login() {
    let s = setup();
    assert!(!s.live_creds().exists());
    assert_eq!(s.activate(&s.s), SwapResult::ok(Some("s@x.com".into())));
    assert_eq!(json(&s.live_creds()), creds("S", FUTURE));
    assert_eq!(json(&s.live_json())["oauthAccount"], account("S", "s@x.com"));
    assert_eq!(json(&s.dir(&s.d).join(".credentials.json")), creds("D", NOW - DAY));
    let d = s.get(&s.d);
    assert_eq!((custody_of(d.custody), d.dead_tokens), (Custody::App, None));

    let s = setup();
    put(&s.live_json(), &serde_json::json!({ "projects": { "p": 1 } }));
    put(&s.live_creds(), &cleared());
    assert!(s.activate(&s.s).ok);
    assert_eq!(json(&s.live_json()), serde_json::json!({ "projects": { "p": 1 }, "oauthAccount": account("S", "s@x.com") }));
    assert_eq!(s.store.list().len(), 2);

    let s = setup();
    put(&s.live_creds(), &creds("D3", NOW - DAY));
    assert!(s.activate(&s.s).ok);
    assert_eq!(json(&s.dir(&s.d).join(".credentials.json"))["claudeAiOauth"]["refreshToken"], "fake-ref-D3");
    assert_eq!(s.get(&s.d).dead_tokens, None);
}

/// accounts-dead-login "never overwrites a credentials file it cannot parse, and never creates Claude Code's config", "refuses
/// to make the dead account itself main (it is the main one) and a dead-marked copy, without a request"
#[test]
fn ts_make_main_refuses_an_unparsable_login_the_dead_account_itself_and_a_dead_copy() {
    let s = setup();
    let half = r#"{"claudeAiOauth": {"accessToken": "fake-half"#;
    std::fs::write(s.live_creds(), half).unwrap();
    assert_eq!(s.activate(&s.s), SwapResult::fail(SwapError::NoMain));
    assert_eq!(text(&s.live_creds()).as_deref(), Some(half));
    std::fs::remove_file(s.live_creds()).unwrap();
    std::fs::remove_file(s.live_json()).unwrap();
    assert_eq!(s.activate(&s.s), SwapResult::fail(SwapError::NoMain));
    assert!(!s.live_creds().exists());

    let s = setup();
    put(&s.live_creds(), &cleared());
    let r = s.activate(&s.d);
    assert_eq!((r.ok, r.error), (false, Some(SwapError::SameAccount)));
    s.store.set_dead_tokens(&s.s, Some(&token_hash("fake-ref-S"))).unwrap();
    assert_eq!(s.activate(&s.s), SwapResult::fail_named(SwapError::Dead, Some("s@x.com".into())));
    assert!(s.refresh_calls().is_empty());
    assert_eq!(json(&s.live_creds()), cleared());
}

/// accounts-dead-login "rolls back cleanly when writing the config fails: the credentials file it created goes again"
#[test]
fn ts_a_failed_config_write_rolls_back_the_credentials_file_it_created() {
    let s = setup();
    let renames: Arc<Mutex<Vec<PathBuf>>> = Arc::default();
    let (r, live_json) = (renames.clone(), s.live_json());
    s.set_fs(HookFs {
        rename: Some(Box::new(move |(from, to)| {
            r.lock().push(to.clone());
            if to == live_json {
                return Err(eio());
            }
            RealSwapFs.rename(&from, &to)
        })),
        ..HookFs::default()
    });
    let before = text(&s.live_json());
    assert_eq!(s.activate(&s.s), SwapResult::fail(SwapError::Write));
    assert!(renames.lock().contains(&s.live_creds()), "it got as far as writing the credentials");
    assert!(!s.live_creds().exists());
    assert_eq!(text(&s.live_json()), before);
    assert_eq!(s.store.live().and_then(|l| l.record_id), Some(s.d.clone()));
    assert!(names(&s.backup_dir()).is_empty());
}

/// accounts-dead-login "recovers a swap interrupted after it wrote the target into a machine that had no credentials file"
#[test]
fn ts_recovers_a_swap_into_a_machine_that_had_no_credentials_file() {
    let s = setup();
    let before = text(&s.live_json()).unwrap();
    std::fs::create_dir_all(s.backup_dir()).unwrap();
    std::fs::write(s.backup_dir().join("live-claude.json"), &before).unwrap();
    put(
        &s.backup_dir().join("swap-journal.json"),
        &serde_json::json!({ "version": 2, "phase": "live-json-written", "outgoingId": null, "targetId": s.s, "created": false, "outCredsExisted": false, "outJsonExisted": false, "liveCredsExisted": false, "startedAt": js::num(NOW) }),
    );
    put(&s.live_creds(), &creds("S", FUTURE));
    put(&s.live_json(), &serde_json::json!({ "oauthAccount": account("S", "s@x.com"), "projects": { "p": 1 } }));
    assert_eq!(recover_interrupted_activation(&s.deps()), Recovery::Recovered);
    assert!(!s.live_creds().exists());
    assert_eq!(json(&s.live_json()), js_json::parse(&before).unwrap());
    assert!(names(&s.backup_dir()).is_empty());
}

// ---- bug 3: an outside switch away from the account --------------------------------------------------------------------

fn reconcile_to(s: &D, live: Option<AccountIdentity>) {
    let read_live = move || Ok(live.clone());
    let dead = |r: &ManagedAccount| Ok(saved_copy_dead(&RealSwapFs, &s.dir(&r.id), Some(r)));
    let deps = ReconcileDeps {
        store: &s.store,
        read_live_identity: &read_live,
        resync: None,
        cswap_wrote_since: None,
        saved_copy_dead: Some(&dead),
        now: &|| NOW,
    };
    reconcile_live(&deps, false).unwrap();
}

/// accounts-dead-login "a dead login that was switched out: no banner, its card says "Sign-in expired"", "a dead login signed
/// out: no banner either", "a valid login switched out: no banner, the card keeps a short note (switched-out), its copy is
/// kept"
#[test]
fn ts_an_outside_switch_away_from_a_dead_or_valid_login_shows_no_banner() {
    let s = setup();
    s.store.set_dead_tokens(&s.d, Some(&token_hash("fake-ref-D"))).unwrap();
    reconcile_to(&s, Some(ident("G")));
    assert!(s.store.notices().iter().all(|n| n.record_id.as_deref() != Some(s.d.as_str())));
    let r = ok_read(&s, &s.card(&s.d));
    assert_eq!((r.usage.status, r.usage.error.as_deref()), (Status::Expired, Some("login-dead")));

    let s = setup();
    s.store.set_dead_tokens(&s.d, Some(&token_hash("fake-ref-D"))).unwrap();
    reconcile_to(&s, None);
    assert!(s.store.notices().is_empty());

    let s = setup();
    put(&s.dir(&s.d).join(".credentials.json"), &creds("D", FUTURE));
    reconcile_to(&s, Some(ident("G")));
    assert!(s.store.notices().iter().all(|n| n.record_id.as_deref() != Some(s.d.as_str())));
    assert_eq!(custody_of(s.get(&s.d).custody), Custody::Foreign);
    assert_eq!(s.card(&s.d).renew, Some(crate::rules::RenewRule::SwitchedOut));
}

// ---- one card state per situation ---------------------------------------------------------------------------------------

/// accounts-dead-login "maps every "only a new sign-in helps" reason onto the same expired state, with the same action" (the
/// card state of a real read in each situation; `makeMainOffered` and `summaryAccounts` stay in the renderer)
#[test]
fn ts_every_only_a_new_sign_in_helps_reason_is_the_same_expired_card() {
    let s = setup();
    let windows = vec![UsageWindow { id: WindowId::SevenDay, used_percent: 96.0, resets_at: (NOW / 1000.0).floor() + 3600.0 }];
    let card_of = |s: &D, outcome: RefreshOutcome| {
        let refs = s.refs();
        let r = refs.iter().find(|r| r.id == format!("claude:{}", s.d)).unwrap_or(&refs[0]).clone();
        let mut usage = read(s, &r, 401, outcome).usage;
        // The service keeps the last numbers of an account whose read failed: they must not make an expired card look current.
        usage.windows = windows.clone();
        usage.source = Source::Cache;
        card_state(&usage)
    };
    let mut cases = Vec::new();
    // The app's own copy, the token endpoint rejected its renewal.
    s.switched_away();
    s.store.set_custody(&s.d, Custody::App, None).unwrap();
    s.store.set_family(&s.d, TokenFamily::Own).unwrap();
    cases.push(("renewalRejected", card_of(&s, RefreshOutcome::Dead)));
    // Daniel while main: Claude Code cleared the live login ("Login expired").
    put(&s.live_creds(), &cleared());
    cases.push(("deadMainLogin", card_of(&s, RefreshOutcome::Ok)));
    // Daniel after the switch: the copy is marked dead.
    s.switched_away();
    s.store.set_custody(&s.d, Custody::Foreign, None).unwrap();
    s.store.set_dead_tokens(&s.d, Some(&token_hash("fake-ref-D"))).unwrap();
    cases.push(("deadCopy", card_of(&s, RefreshOutcome::Ok)));
    // Daniel after a cswap switch the app did not see die: the copy may be outdated and its access token ran out.
    s.switched_away();
    s.store.set_custody(&s.d, Custody::Foreign, None).unwrap();
    cases.push(("switchedOutOutdated", card_of(&s, RefreshOutcome::Ok)));
    // A copy cswap also holds whose access token ran out.
    s.switched_away();
    s.store.set_custody(&s.d, Custody::App, None).unwrap();
    s.set_roster(CswapRoster::Present(Some(vec![AccountIdentity {
        email: Some("d@x.com".into()),
        account_uuid: Some("uuid-D".into()),
        ..Default::default()
    }])));
    cases.push(("cswapCopyOutdated", card_of(&s, RefreshOutcome::Ok)));
    for (why, state) in cases {
        assert_eq!((why, state), (why, CardState::Expired));
    }
}

// ---- auth-first-login.test.ts: Claude Desktop's leftover identity --------------------------------------------------------

const EMAIL: &str = "maksy@example.com";
const DESKTOP_JSON: &str = r#"{"numStartups":3,"oauthAccount":{"emailAddress":"maksy@example.com","accountUuid":"u-maksy","organizationUuid":"o-1","organizationName":"Org"}}"#;
const LOGIN: &str = r#"{"claudeAiOauth":{"accessToken":"fake-access","refreshToken":"fake-refresh","expiresAt":9e12}}"#;

fn fs_read(p: &Path) -> std::io::Result<String> {
    std::fs::read_to_string(p)
}

/// auth-first-login "an identity in ~/.claude.json without a Claude login next to it is nobody (Claude Desktop leftover)", "a
/// real login, a login Claude Code cleared as dead and macOS (Keychain) keep the identity", "a credentials file that cannot
/// be read right now is unknown, never a sign-out"
#[test]
fn ts_a_desktop_leftover_identity_is_nobody_signed_in() {
    let fx = Fx::new(NOW);
    let home = fx.home.clone();
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::write(home.join(".claude.json"), DESKTOP_JSON).unwrap();
    let signed_in = |darwin: bool| read_signed_in_claude_identity(None, None, &home, darwin, &mut fs_read);
    assert_eq!(crate::identity::read_live_claude_identity(None, &home).unwrap().unwrap().email.as_deref(), Some(EMAIL));
    assert_eq!(signed_in(false), Ok(None));
    std::fs::write(home.join(".claude").join(".credentials.json"), r#"{"mcpOAuth":{"x":{}}}"#).unwrap();
    assert_eq!(signed_in(false), Ok(None), "MCP sign-ins only: still no Claude login");
    std::fs::write(home.join(".claude").join(".credentials.json"), LOGIN).unwrap();
    let id = signed_in(false).unwrap().unwrap();
    assert_eq!((id.email.as_deref(), id.account_uuid.as_deref()), (Some(EMAIL), Some("u-maksy")));
    std::fs::write(home.join(".claude").join(".credentials.json"), r#"{"claudeAiOauth":{"accessToken":"","refreshToken":""}}"#)
        .unwrap();
    assert_eq!(signed_in(false).unwrap().unwrap().email.as_deref(), Some(EMAIL));
    std::fs::remove_file(home.join(".claude").join(".credentials.json")).unwrap();
    assert_eq!(signed_in(true).unwrap().unwrap().email.as_deref(), Some(EMAIL));

    let mut busy = |p: &Path| {
        if p.ends_with(".credentials.json") {
            Err(std::io::Error::from(std::io::ErrorKind::ResourceBusy))
        } else {
            Ok(DESKTOP_JSON.to_string())
        }
    };
    assert_eq!(claude_login_presence(None, None, &home, &mut busy), LoginPresence::Unknown);
    assert!(read_signed_in_claude_identity(None, None, &home, false, &mut busy).is_err());
    assert_eq!(claude_login_presence(None, None, &home, &mut |_| Ok("{half".into())), LoginPresence::Unknown);
    assert_eq!(claude_login_presence(None, None, &home, &mut fs_read), LoginPresence::Absent);
    assert_eq!(claude_login_presence(Some("x"), None, &home, &mut fs_read), LoginPresence::Present);
}

/// auth-first-login "the leftover is not adopted as a hidden main card any more"
#[test]
fn ts_the_leftover_is_not_adopted_as_a_hidden_main_card() {
    let fx = Fx::new(NOW);
    let home = fx.home.clone();
    std::fs::create_dir_all(home.join(".claude")).unwrap();
    std::fs::write(home.join(".claude.json"), DESKTOP_JSON).unwrap();
    let signed_in = || read_signed_in_claude_identity(None, None, &home, false, &mut fs_read).map_err(|_| ());
    let deps = ReconcileDeps {
        store: &fx.store,
        read_live_identity: &signed_in,
        resync: None,
        cswap_wrote_since: None,
        saved_copy_dead: None,
        now: &|| 1.0,
    };
    assert_eq!(reconcile_live(&deps, false).unwrap().active_id, None);
    assert!(fx.store.list().is_empty());
    // 1.1.1 read the leftover as the live login and adopted it: a record with custody live.
    let leftover = || crate::identity::read_live_claude_identity(None, &home).map_err(|_| ());
    let old = ReconcileDeps { read_live_identity: &leftover, ..deps };
    assert!(reconcile_live(&old, false).unwrap().active_id.is_some());
    assert_eq!(fx.store.list().iter().map(|r| custody_of(r.custody)).collect::<Vec<_>>(), [Custody::Live]);
}

/// auth-first-login "is not refused as "already main": the account becomes the live login, the leftover identity is replaced"
#[test]
fn ts_making_the_new_account_main_over_the_leftover_works() {
    let fx = Fx::new(NOW);
    std::fs::create_dir_all(fx.home.join(".claude")).unwrap();
    std::fs::write(
        fx.live_json(),
        r#"{"numStartups":3,"theme":"dark","oauthAccount":{"emailAddress":"maksy@example.com","accountUuid":"u-maksy","organizationUuid":"o-1"}}"#,
    )
    .unwrap();
    let (id, dir) = fx.store.prepare().unwrap();
    let identity = AccountIdentity {
        email: Some(EMAIL.into()),
        account_uuid: Some("u-maksy".into()),
        organization_uuid: Some("o-1".into()),
        org: None,
    };
    fx.store
        .commit(&ManagedAccount {
            id: id.clone(),
            added_at: 1.0,
            identity: identity.clone(),
            custody: Some(Custody::App),
            family: Some(TokenFamily::Own),
            ..Default::default()
        })
        .unwrap();
    std::fs::write(dir.join(".credentials.json"), LOGIN).unwrap();
    std::fs::write(dir.join(".claude.json"), r#"{"oauthAccount":{"emailAddress":"maksy@example.com","accountUuid":"u-maksy","organizationUuid":"o-1","organizationName":"Org"}}"#).unwrap();
    // 1.1.1: { ok: false, error: 'sameAccount' } - the leftover identity counted as the main login.
    assert_eq!(activate_account(&fx.deps(), &id), SwapResult::ok(Some(EMAIL.into())));
    assert_eq!(json(&fx.live_creds())["claudeAiOauth"]["refreshToken"], "fake-refresh");
    let live = json(&fx.live_json());
    assert_eq!(
        (&live["theme"], &live["oauthAccount"]["emailAddress"], &live["oauthAccount"]["organizationName"]),
        (&"dark".into(), &EMAIL.into(), &"Org".into())
    );
    let records = fx.store.list();
    assert_eq!(records.len(), 1);
    assert_eq!(compare_identity(&records[0].identity, &identity), IdentityMatch::Same);
    assert_eq!(custody_of(fx.store.get(&id).unwrap().custody), Custody::Live);
    assert_eq!(fx.store.live().and_then(|l| l.record_id), Some(id));
}
