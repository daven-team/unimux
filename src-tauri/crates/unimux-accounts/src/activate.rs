//! "Set as main" (0.9.1; port of src/main/accounts/activate.ts). The outgoing live login is saved into ITS record (a new
//! record when the app does not know the account), then the target's login is written into Claude Code's files - all under
//! Claude Code's credential and config locks, so neither Claude Code nor cswap can write in between, and with no network
//! while they are held. The target keeps its profile copy as a backup that is never renewed while it is live. A version-2
//! journal plus backups in `accounts/swap-backup` make an interrupted swap recoverable; the 0.9.0 exchange in
//! [`crate::legacy_swap`] only remains for its version-1 journals.
//!
//! Everything here blocks (file work and Claude Code's locks): run it on a blocking thread. The renewal of an expiring
//! target (`refresh`) is called before any lock is taken.

use std::collections::{BTreeMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Map, Value};
use unimux_core::js_json;

use crate::cswap::CswapRoster;
use crate::identity::{
    AccountIdentity, Custody, IdentityMatch, TokenFamily, compare_identity, custody_of, family_of, identity_fields,
    identity_from_oauth_account, is_account_id, is_account_id_value,
};
use crate::js;
use crate::locks::{LockError, LockOptions, with_claude_locks};
use crate::refresh::{ProfileLocks, RefreshOutcome};
use crate::results::{Recovery, SwapError, SwapResult};
use crate::rules::{
    RenewRule, family_refresh_allowed, is_cleared_login, renew_rule, saved_copy_dead, saved_refresh_token, token_hash,
};
use crate::slot::SwapSlot;
use crate::store::{AccountsStore, AppSwap, LiveIdentity, ManagedAccount, StoreError};
use crate::swapfs::{
    Snap, SwapFs, SwapPaths, WriteError, atomic_write, env_get, oauth_of, read_snap, str_of, stringify, stringify2, swap_paths,
    valid_oauth, with_key,
};

/// The target is renewed first only when its access token runs out within this margin: a valid token is never rotated
/// needlessly.
pub const TARGET_FRESH_MS: f64 = 5.0 * 60_000.0;
const MIN_VALID_MS: f64 = 60_000.0;
/// How often a version-2 recovery that found Claude Code's locks busy is tried again, independent of the limits panel.
pub const RECOVERY_RETRY: Duration = Duration::from_secs(30);

pub(crate) const JOURNAL: &str = "swap-journal.json";
const LIVE_CREDS: &str = "live-credentials.json";
const LIVE_JSON: &str = "live-claude.json";
const OUT_CREDS: &str = "outgoing-credentials.json";
const OUT_JSON: &str = "outgoing-claude.json";
const BACKUPS: [&str; 4] = [LIVE_CREDS, LIVE_JSON, OUT_CREDS, OUT_JSON];

/// The journal phases, advanced BEFORE each step, so a phase says how far the swap may have got.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Phase {
    BackedUp,
    OutgoingSaved,
    LiveCredsWritten,
    LiveJsonWritten,
    Verified,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::BackedUp => "backed-up",
            Phase::OutgoingSaved => "outgoing-saved",
            Phase::LiveCredsWritten => "live-creds-written",
            Phase::LiveJsonWritten => "live-json-written",
            Phase::Verified => "verified",
        }
    }
    fn parse(v: Option<&Value>) -> Option<Phase> {
        Some(match v?.as_str()? {
            "backed-up" => Phase::BackedUp,
            "outgoing-saved" => Phase::OutgoingSaved,
            "live-creds-written" => Phase::LiveCredsWritten,
            "live-json-written" => Phase::LiveJsonWritten,
            "verified" => Phase::Verified,
            _ => return None,
        })
    }
}

pub type Clock = Arc<dyn Fn() -> f64 + Send + Sync>;
pub type Delay = Arc<dyn Fn(Duration) + Send + Sync>;
/// Renews a saved profile (`refreshClaudeProfile` bound to its network deps; A3). Only called through the family rule.
pub type Refresh = Arc<dyn Fn(&Path) -> RefreshOutcome + Send + Sync>;
/// cswap's roster; `Err` reads as a roster that holds everything.
pub type Roster = Arc<dyn Fn() -> Result<CswapRoster, ()> + Send + Sync>;
/// Whether cswap may have saved this account's tokens at `since` or later (`cswapWroteSince`); `Err` counts as yes.
pub type WroteSince = Arc<dyn Fn(&AccountIdentity, &CswapRoster, f64) -> Result<bool, ()> + Send + Sync>;

/// `ActivateDeps`.
#[derive(Clone)]
pub struct ActivateDeps {
    pub home: PathBuf,
    pub env: Arc<BTreeMap<String, String>>,
    /// Claude logins live in the Keychain on macOS: "make main" is not supported there.
    pub darwin: bool,
    pub store: Arc<AccountsStore>,
    /// `<data>/accounts/swap-backup`, shared with the 0.9.0 swap: one pending journal blocks both.
    pub backup_dir: PathBuf,
    pub now: Clock,
    pub refresh: Refresh,
    pub delay: Delay,
    pub cswap: Roster,
    /// Absent: always yes, so a copy the app switches out stays the live family.
    pub cswap_wrote_since: Option<WroteSince>,
    pub fs: Arc<dyn SwapFs>,
    pub locks: LockOptions,
    pub slot: Arc<SwapSlot>,
    pub profiles: Arc<ProfileLocks>,
}

/// Why a step stopped (the TS `Fail`, `LockTimeout` and every other throw).
#[derive(Debug)]
pub(crate) enum Abort {
    Fail(SwapError, Option<String>),
    Lock(LockError),
    Other,
}

impl Abort {
    fn code(code: SwapError) -> Self {
        Abort::Fail(code, None)
    }
    fn named(code: SwapError, email: &Option<String>) -> Self {
        Abort::Fail(code, email.clone())
    }
}

impl From<io::Error> for Abort {
    fn from(_: io::Error) -> Self {
        Abort::Other
    }
}
impl From<WriteError> for Abort {
    fn from(_: WriteError) -> Self {
        Abort::Other
    }
}
impl From<StoreError> for Abort {
    fn from(_: StoreError) -> Self {
        Abort::Other
    }
}

type Rec = Map<String, Value>;

fn oauth(snap: Option<&Snap>) -> Option<&Rec> {
    snap.and_then(|s| oauth_of(&s.data))
}

fn expiry(o: Option<&Rec>) -> f64 {
    o.and_then(|o| o.get("expiresAt")).and_then(Value::as_f64).unwrap_or(0.0)
}

/// An unreadable roster holds everything (conservative, like `readCswapRoster`).
fn roster_of(deps: &ActivateDeps) -> CswapRoster {
    (deps.cswap)().unwrap_or(CswapRoster::UNREADABLE)
}

/// The target's access token is valid for longer than TARGET_FRESH_MS: it can be swapped in without any token request.
fn fresh_at(snap: Option<&Snap>, now: f64) -> bool {
    valid_oauth(oauth(snap)) && expiry(oauth(snap)) - now >= TARGET_FRESH_MS
}

fn live_identity(live: &Option<LiveIdentity>) -> Option<&AccountIdentity> {
    live.as_ref().map(|l| &l.identity)
}

/// `activationRefusal`: why `record` may not become the main login, or `None`. One rule with the renewals (`renewRule`): a
/// record that is or may be the live account is already main, and a family held elsewhere is refused. A copy cswap may hold
/// too is swapped in while its access token is `fresh` (no token request at all); one that would need renewing is refused.
pub fn activation_refusal(
    record: Option<&ManagedAccount>,
    live: Option<&AccountIdentity>,
    roster: &CswapRoster,
    fresh: bool,
) -> Option<(SwapError, Option<String>)> {
    let named = |e: SwapError| Some((e, record.and_then(|r| r.identity.email.clone()).filter(|e| !e.is_empty())));
    let Some(record) = record.filter(|r| custody_of(r.custody) != Custody::Quarantined) else {
        return named(SwapError::NoTarget);
    };
    let live_full = live.map(|i| LiveIdentity { identity: i.clone(), record_id: None });
    let rule = renew_rule(record, live_full.as_ref(), roster);
    if rule == RenewRule::Allowed || (rule == RenewRule::HeldByCswap && fresh) {
        return None;
    }
    if custody_of(record.custody) == Custody::Live
        || (rule == RenewRule::HeldByLive && live.is_some_and(|l| compare_identity(&record.identity, l) == IdentityMatch::Same))
    {
        return named(SwapError::SameAccount);
    }
    named(SwapError::Foreign)
}

/// `checkActivationTarget`: the checks of the `accounts:makeMain` IPC handler (the renderer's choice is never trusted).
pub fn check_activation_target(deps: &ActivateDeps, target_id: &str) -> Option<SwapResult> {
    let record = deps.store.get(target_id);
    let mut fresh = false;
    if record.is_some()
        && is_account_id(target_id)
        && let Ok(dir) = deps.store.dir_of(target_id)
    {
        fresh =
            read_snap(&*deps.fs, &dir.join(".credentials.json")).ok().flatten().is_some_and(|s| fresh_at(Some(&s), (deps.now)()));
    }
    let live = deps.store.live();
    activation_refusal(record.as_ref(), live_identity(&live), &roster_of(deps), fresh)
        .map(|(e, email)| SwapResult::fail_named(e, email))
}

/// `activateAccount`.
pub fn activate_account(deps: &ActivateDeps, target_id: &str) -> SwapResult {
    if deps.darwin {
        return SwapResult::fail(SwapError::Unsupported);
    }
    if !is_account_id(target_id) {
        return SwapResult::fail(SwapError::Invalid);
    }
    let Some(_slot) = deps.slot.try_claim() else { return SwapResult::fail(SwapError::Busy) };
    let run = || -> Result<SwapResult, Abort> {
        if crate::legacy_swap::has_pending_swap(&*deps.fs, &deps.backup_dir)? {
            return Ok(SwapResult::fail(SwapError::Pending));
        }
        perform(deps, target_id)
    };
    match run() {
        Ok(r) => r,
        Err(Abort::Fail(code, email)) => {
            if code == SwapError::Manual {
                deps.slot.set_unresolved(true);
            }
            SwapResult::fail_named(code, email)
        }
        Err(Abort::Lock(LockError::Timeout(_))) => SwapResult::fail(SwapError::Locked),
        Err(_) => SwapResult::fail(SwapError::Write),
    }
}

fn perform(deps: &ActivateDeps, target_id: &str) -> Result<SwapResult, Abort> {
    let store = &deps.store;
    if env_get(&deps.env, "CLAUDE_CODE_OAUTH_TOKEN").is_some_and(|t| !js::trim(t).is_empty()) {
        return Err(Abort::code(SwapError::EnvToken));
    }
    let paths = swap_paths(&deps.home, &deps.env).ok_or(Abort::code(SwapError::NoMain))?;
    let target = store.get(target_id);
    let roster = roster_of(deps);
    let dir = store.dir_of(target_id)?;
    let creds_path = dir.join(".credentials.json");
    let mut snap = if target.is_some() { read_snap(&*deps.fs, &creds_path)? } else { None };
    let live = store.live();
    if let Some((e, email)) =
        activation_refusal(target.as_ref(), live_identity(&live), &roster, fresh_at(snap.as_ref(), (deps.now)()))
    {
        return Err(Abort::Fail(e, email));
    }
    let Some(target) = target else { return Err(Abort::code(SwapError::NoTarget)) };
    let email = target.identity.email.clone().filter(|e| !e.is_empty());
    if !valid_oauth(oauth(snap.as_ref())) {
        return Err(Abort::named(SwapError::NoTarget, &email));
    }
    // A copy of a login Claude Code cleared as dead is never swapped in nor sent to the token endpoint.
    if saved_copy_dead(&*deps.fs, &dir, Some(&target)) {
        return Err(Abort::named(SwapError::Dead, &email));
    }
    // Network only outside the locks, and only through the one family rule (the same gate the background renewals use).
    if !fresh_at(snap.as_ref(), (deps.now)()) {
        let records = store.list();
        let allowed = family_refresh_allowed(&records, &|id| store.dir_of(id).ok(), store.live().as_ref(), &roster, &dir);
        if !allowed {
            return Err(Abort::named(SwapError::Foreign, &email));
        }
        let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| (deps.refresh)(&dir)))
            .unwrap_or(RefreshOutcome::Transient(None));
        if matches!(outcome, RefreshOutcome::Dead | RefreshOutcome::Unusable) {
            return Err(Abort::named(SwapError::Dead, &email));
        }
        snap = read_snap(&*deps.fs, &creds_path)?;
        if !valid_oauth(oauth(snap.as_ref())) {
            return Err(Abort::named(SwapError::NoTarget, &email));
        }
        if matches!(outcome, RefreshOutcome::Transient(_)) && expiry(oauth(snap.as_ref())) <= (deps.now)() + MIN_VALID_MS {
            return Err(Abort::named(SwapError::Transient, &email));
        }
    }
    // Profile locks first (the target and every record that may receive the outgoing login): a renewal still in flight ends
    // before Claude Code's locks are taken, and none can overwrite the copy saved under them.
    let live = store.live();
    let outgoing_ids: Vec<String> = store
        .list()
        .into_iter()
        .filter(|r| {
            r.id != target_id
                && custody_of(r.custody) != Custody::Quarantined
                && (live.as_ref().and_then(|l| l.record_id.as_deref()) == Some(r.id.as_str())
                    || live.as_ref().is_some_and(|l| compare_identity(&r.identity, &l.identity) == IdentityMatch::Same))
        })
        .map(|r| r.id)
        .collect();
    let mut dirs = vec![dir.clone()];
    for id in &outgoing_ids {
        dirs.push(store.dir_of(id)?);
    }
    let locked: HashSet<String> = outgoing_ids.into_iter().collect();
    deps.profiles.with_all(&dirs, || {
        with_claude_locks(&paths.credentials, &paths.claude_json, false, &deps.locks, || {
            exchange(deps, &paths, &roster, target_id, &dir, &locked)
        })
        .map_err(Abort::Lock)?
    })
}

struct Originals<'a> {
    live_creds: Option<&'a Snap>,
    live_account: Option<&'a Rec>,
    out_creds: Option<&'a Snap>,
    out_json: Option<&'a Snap>,
    out_dir: Option<&'a Path>,
    written_creds: &'a str,
    target_identity: AccountIdentity,
}

struct Journal {
    phase: Phase,
    outgoing_id: Option<String>,
    target_id: String,
    created: bool,
    out_creds_existed: bool,
    out_json_existed: bool,
    live_creds_existed: bool,
    started_at: f64,
}

impl Journal {
    fn text(&self) -> String {
        let mut m = Map::new();
        m.insert("version".into(), Value::from(2));
        m.insert("phase".into(), Value::String(self.phase.as_str().into()));
        m.insert("outgoingId".into(), self.outgoing_id.clone().map_or(Value::Null, Value::String));
        m.insert("targetId".into(), Value::String(self.target_id.clone()));
        m.insert("created".into(), Value::Bool(self.created));
        m.insert("outCredsExisted".into(), Value::Bool(self.out_creds_existed));
        m.insert("outJsonExisted".into(), Value::Bool(self.out_json_existed));
        m.insert("liveCredsExisted".into(), Value::Bool(self.live_creds_existed));
        m.insert("startedAt".into(), js::num(self.started_at));
        stringify(&Value::Object(m))
    }
}

fn write(deps: &ActivateDeps, path: &Path, data: &str) -> Result<(), WriteError> {
    atomic_write(&*deps.delay, &*deps.fs, path, data, None)
}

/// The fallback `oauthAccount` built from the record: `{ emailAddress, organizationName?, accountUuid?, organizationUuid? }`.
fn account_of_record(r: &ManagedAccount) -> Rec {
    let mut m = Map::new();
    // `{ emailAddress: undefined }` is dropped by JSON.stringify.
    for (key, v) in [
        ("emailAddress", &r.identity.email),
        ("organizationName", &r.identity.org),
        ("accountUuid", &r.identity.account_uuid),
        ("organizationUuid", &r.identity.organization_uuid),
    ] {
        if let Some(v) = v.as_ref().filter(|v| key == "emailAddress" || !v.is_empty()) {
            m.insert(key.into(), Value::String(v.clone()));
        }
    }
    m
}

fn exchange(
    deps: &ActivateDeps,
    paths: &SwapPaths,
    roster: &CswapRoster,
    target_id: &str,
    dir: &Path,
    locked: &HashSet<String>,
) -> Result<SwapResult, Abort> {
    let store = &deps.store;
    let fs = &*deps.fs;
    let live_creds = read_snap(fs, &paths.credentials)?;
    let live_json = read_snap(fs, &paths.claude_json)?;
    let live_oauth = oauth(live_creds.as_ref()).cloned();
    let live_account = live_json.as_ref().and_then(|j| js::record(j.data.get("oauthAccount"))).cloned();
    let live_id = identity_from_oauth_account(live_account.as_ref().map(|a| Value::Object(a.clone())).as_ref());
    let identified = live_account.is_some() && (live_id.email.is_some() || live_id.account_uuid.is_some());
    // 1.1.2: an identity in the config without any Claude login in the credentials file is nobody signed in.
    let signed_in = identified && live_creds.as_ref().is_some_and(|c| js::record(c.data.get("claudeAiOauth")).is_some());
    // Claude Code's config holds far more than the login: it is never created here.
    let Some(live_json) = live_json else { return Err(Abort::code(SwapError::NoMain)) };
    // A usable live login is saved into its record first, so it must be known whose it is.
    let usable = live_creds.is_some() && valid_oauth(live_oauth.as_ref());
    if usable && !identified {
        return Err(Abort::code(SwapError::NoMain));
    }
    // A credentials file that exists but cannot be parsed is never overwritten: it may hold a login.
    if live_creds.is_none() && fs.read_file(&paths.credentials)?.is_some() {
        return Err(Abort::code(SwapError::NoMain));
    }
    let dead = live_creds.as_ref().is_some_and(|c| is_cleared_login(&c.data));
    // Checked again under the locks against whoever is signed in right now (the stored live identity may lag behind).
    let target = store.get(target_id);
    let target_snap = read_snap(fs, &dir.join(".credentials.json"))?;
    let signed = signed_in.then_some(&live_id);
    if let Some((e, email)) = activation_refusal(target.as_ref(), signed, roster, fresh_at(target_snap.as_ref(), (deps.now)())) {
        return Err(Abort::Fail(e, email));
    }
    let Some(target) = target else { return Err(Abort::code(SwapError::NoTarget)) };
    let email = target.identity.email.clone().filter(|e| !e.is_empty());
    let Some(target_oauth) = oauth(target_snap.as_ref()).filter(|o| valid_oauth(Some(o))).cloned() else {
        return Err(Abort::named(SwapError::NoTarget, &email));
    };
    let target_json = read_snap(fs, &dir.join(".claude.json"))?;
    let target_account: Rec = match target_json.as_ref().and_then(|j| js::record(j.data.get("oauthAccount"))) {
        Some(a) if str_of(a.get("emailAddress")).is_some() => a.clone(),
        _ => account_of_record(&target),
    };
    // The outgoing login goes into its own record (the one the app knows as live first); an account the app did not know
    // gets one, so a login is never dropped. Never the target itself.
    let same: Vec<ManagedAccount> = if identified {
        store
            .list()
            .into_iter()
            .filter(|r| {
                r.id != target_id
                    && custody_of(r.custody) != Custody::Quarantined
                    && compare_identity(&r.identity, &live_id) == IdentityMatch::Same
            })
            .collect()
    } else {
        Vec::new()
    };
    let named = store.live().and_then(|l| l.record_id);
    let existing = same
        .iter()
        .find(|r| Some(&r.id) == named.as_ref())
        .or_else(|| same.iter().find(|r| custody_of(r.custody) == Custody::Live))
        .or_else(|| same.first())
        .cloned();
    // The live login changed after the profile locks were chosen: its record is not locked, so try again later.
    if let Some(e) = &existing
        && !locked.contains(&e.id)
    {
        return Err(Abort::code(SwapError::Busy));
    }
    let created = usable && existing.is_none();
    // Live tokens an interrupted swap may have left under this identity (`heldTokens`) are not this account's.
    let live_refresh = live_oauth.as_ref().and_then(|o| o.get("refreshToken")).and_then(Value::as_str);
    let keep_outgoing = existing
        .as_ref()
        .and_then(|e| e.held_tokens.as_deref())
        .filter(|h| !h.is_empty())
        .is_some_and(|held| live_refresh.is_some_and(|t| token_hash(t) == held));
    let save_outgoing = usable && !keep_outgoing;
    let outgoing_id = match &existing {
        Some(e) => Some(e.id.clone()),
        None if created => Some(store.prepare()?.0),
        None => None,
    };
    let out_dir = match &outgoing_id {
        Some(id) => Some(store.dir_of(id)?),
        None => None,
    };
    let out_creds = match &out_dir {
        Some(d) => read_snap(fs, &d.join(".credentials.json"))?,
        None => None,
    };
    let out_json = match &out_dir {
        Some(d) => read_snap(fs, &d.join(".claude.json"))?,
        None => None,
    };
    let mut journal = Journal {
        phase: Phase::BackedUp,
        outgoing_id: outgoing_id.clone(),
        target_id: target.id.clone(),
        created,
        out_creds_existed: out_creds.is_some(),
        out_json_existed: out_json.is_some(),
        live_creds_existed: live_creds.is_some(),
        started_at: (deps.now)(),
    };
    let empty = Map::new();
    let written_creds = stringify(&with_key(
        live_creds.as_ref().map_or(&empty, |c| &c.data),
        "claudeAiOauth",
        Value::Object(target_oauth.clone()),
    ));
    let steps = (|| -> Result<(), Abort> {
        let advance = |journal: &mut Journal, phase: Phase| -> Result<(), Abort> {
            journal.phase = phase;
            Ok(write(deps, &deps.backup_dir.join(JOURNAL), &journal.text())?)
        };
        // Backups inside the try: a failure before the first journal write still removes them (no live file was touched yet).
        fs.mkdir(&deps.backup_dir)?;
        if let Some(c) = &live_creds {
            write(deps, &deps.backup_dir.join(LIVE_CREDS), &c.text)?;
        }
        write(deps, &deps.backup_dir.join(LIVE_JSON), &live_json.text)?;
        if let Some(c) = &out_creds {
            write(deps, &deps.backup_dir.join(OUT_CREDS), &c.text)?;
        }
        if let Some(j) = &out_json {
            write(deps, &deps.backup_dir.join(OUT_JSON), &j.text)?;
        }
        advance(&mut journal, Phase::BackedUp)?;
        // A record for an account the app did not know is committed only once the journal names it.
        if created && let Some(id) = &outgoing_id {
            store.commit(&ManagedAccount {
                id: id.clone(),
                added_at: (deps.now)(),
                identity: identity_fields(&live_id),
                custody: Some(Custody::Live),
                family: Some(TokenFamily::Live),
                ..ManagedAccount::default()
            })?;
        }
        advance(&mut journal, Phase::OutgoingSaved)?;
        if save_outgoing && let Some(out_dir) = &out_dir {
            fs.mkdir(out_dir)?;
            let oauth_v = live_oauth.clone().map_or(Value::Null, Value::Object);
            write(
                deps,
                &out_dir.join(".credentials.json"),
                &stringify(&with_key(out_creds.as_ref().map_or(&empty, |c| &c.data), "claudeAiOauth", oauth_v)),
            )?;
            let account_v = live_account.clone().map_or(Value::Null, Value::Object);
            write(
                deps,
                &out_dir.join(".claude.json"),
                &stringify2(&with_key(out_json.as_ref().map_or(&empty, |j| &j.data), "oauthAccount", account_v)),
            )?;
        }
        advance(&mut journal, Phase::LiveCredsWritten)?;
        if live_creds.is_none()
            && let Some(parent) = paths.credentials.parent()
        {
            fs.mkdir(parent)?;
        }
        write(deps, &paths.credentials, &written_creds)?;
        advance(&mut journal, Phase::LiveJsonWritten)?;
        let now_json = read_snap(fs, &paths.claude_json)?;
        let base = now_json.as_ref().map_or(&live_json.data, |j| &j.data);
        write(deps, &paths.claude_json, &stringify2(&with_key(base, "oauthAccount", Value::Object(target_account.clone()))))?;
        // The locks keep Claude Code and cswap out, so the files must be exactly what was written.
        let v_creds = read_snap(fs, &paths.credentials)?;
        let v_json = read_snap(fs, &paths.claude_json)?;
        let target_id_of = identity_from_oauth_account(Some(&Value::Object(target_account.clone())));
        let v_ok = v_json.as_ref().is_some_and(|j| {
            compare_identity(&identity_from_oauth_account(j.data.get("oauthAccount")), &target_id_of) == IdentityMatch::Same
        });
        if v_creds.as_ref().map(|c| c.text.as_str()) != Some(written_creds.as_str()) || !v_ok {
            return Err(Abort::code(SwapError::Write));
        }
        advance(&mut journal, Phase::Verified)?;
        Ok(())
    })();
    if let Err(error) = steps {
        let target_identity = identity_from_oauth_account(Some(&Value::Object(target_account.clone())));
        let o = Originals {
            live_creds: live_creds.as_ref(),
            live_account: live_account.as_ref(),
            out_creds: out_creds.as_ref(),
            out_json: out_json.as_ref(),
            out_dir: out_dir.as_deref(),
            written_creds: &written_creds,
            target_identity,
        };
        if !rollback(deps, paths, journal.phase, &o) {
            return Err(Abort::code(SwapError::Manual));
        }
        // The record goes before the journal: a crash in between is repaired by the recovery, which removes it again.
        if created && let Some(id) = &outgoing_id {
            store.remove(id)?;
        }
        remove_backups(deps)?;
        return Err(match error {
            Abort::Fail(code, email) => Abort::Fail(code, email),
            _ => Abort::code(SwapError::Write),
        });
    }
    // Still under the locks, after the last write: whatever cswap saved up to now is seen by the check.
    let before = existing.as_ref().and_then(|e| store.get(&e.id));
    let outgoing_family = if !usable {
        family_of(before.as_ref().and_then(|b| b.family))
    } else if !keep_outgoing && existing.is_some() && kept_own_family(deps, roster, before.as_ref(), live_refresh) {
        TokenFamily::Own
    } else {
        TokenFamily::Live
    };
    let target_swap = AppSwap {
        at: journal.started_at,
        from: target_oauth.get("refreshToken").and_then(Value::as_str).map(token_hash),
        own: family_of(target.family) == TokenFamily::Own,
    };
    let target_identity = identity_from_oauth_account(Some(&Value::Object(target_account.clone())));
    finish_roles(store, outgoing_id.as_deref(), &target.id, &target_identity, outgoing_family, &target_swap)?;
    // The login that left was cleared by Claude Code as dead: the record's saved copy (the same family; its profile lock is
    // held here) is marked dead too, so its card says "Sign-in expired" and nothing ever sends it anywhere.
    if dead
        && let (Some(existing), Some(out_dir)) = (&existing, &out_dir)
        && before.as_ref().and_then(|b| b.held_tokens.as_ref()).is_none()
        && let Some(token) = saved_refresh_token(fs, out_dir)
    {
        let _ = store.set_dead_tokens(&existing.id, Some(&token_hash(&token)));
    }
    let _ = remove_backups(deps);
    Ok(SwapResult::ok(str_of(target_account.get("emailAddress")).map(str::to_string)))
}

/// `finishRoles`: the roles follow the files. The outgoing record now holds the only copy of its login (`app`), the target is
/// live (family `live`: Claude Code renews it from now on and cswap may back it up) and notes how the app made it main
/// (`appSwap`); a hold on its tokens (`heldTokens`) is over.
fn finish_roles(
    store: &AccountsStore,
    outgoing_id: Option<&str>,
    target_id: &str,
    identity: &AccountIdentity,
    outgoing_family: TokenFamily,
    target_swap: &AppSwap,
) -> Result<(), StoreError> {
    if let Some(id) = outgoing_id
        && store.get(id).is_some()
    {
        store.set_custody(id, Custody::App, None)?;
        store.set_family(id, outgoing_family)?;
        store.set_app_swap(id, None)?;
    }
    store.set_custody(target_id, Custody::Live, None)?;
    store.set_family(target_id, TokenFamily::Live)?;
    store.set_app_swap(target_id, Some(target_swap))?;
    store.set_held_tokens(target_id, None)?;
    store.set_live(Some(&LiveIdentity { identity: identity_fields(identity), record_id: Some(target_id.to_string()) }))
}

/// `keptOwnFamily`: the record the app switches out may be renewed by the app from now on (family `own`) only when cswap
/// provably holds none of the tokens it leaves with: the app itself made it main (`appSwap`), cswap wrote no copy of that
/// account since, and either it was the app's own family before or Claude Code has renewed it since (the refresh token
/// differs from the one swapped in). Anything unknown keeps it the live family.
pub fn kept_own_family(
    deps: &ActivateDeps,
    roster: &CswapRoster,
    record: Option<&ManagedAccount>,
    refresh_token: Option<&str>,
) -> bool {
    let Some(record) = record else { return false };
    let Some(swap) = &record.app_swap else { return false };
    let Some(wrote_since) = &deps.cswap_wrote_since else { return false };
    if custody_of(record.custody) != Custody::Live || record.held_tokens.as_ref().is_some_and(|h| !h.is_empty()) {
        return false;
    }
    let rotated = swap.from.as_ref().is_some_and(|f| !f.is_empty())
        && refresh_token.is_some_and(|t| !t.is_empty() && Some(token_hash(t)) != swap.from);
    if !swap.own && !rotated {
        return false;
    }
    matches!(wrote_since(&record.identity, roster, swap.at), Ok(false))
}

/// Still under the locks: every step that may have started is undone from the backups taken in this run - but only what
/// this swap wrote. A login someone else wrote meanwhile may be the only copy of that login: then nothing is touched, the
/// outgoing copy stays, and the swap is 'manual' with its journal and backups kept.
fn rollback(deps: &ActivateDeps, paths: &SwapPaths, phase: Phase, o: &Originals<'_>) -> bool {
    let fs = &*deps.fs;
    let reached = |p: Phase| phase >= p;
    let live_id = identity_from_oauth_account(o.live_account.map(|a| Value::Object(a.clone())).as_ref());
    // The config still names whoever it named before (no account at all when it named none).
    let as_before = |snap: &Snap| match o.live_account {
        Some(_) => compare_identity(&identity_from_oauth_account(snap.data.get("oauthAccount")), &live_id) == IdentityMatch::Same,
        None => js::record(snap.data.get("oauthAccount")).is_none(),
    };
    let inspected = (|| -> io::Result<Option<(Option<Snap>, Option<Snap>)>> {
        let mut creds = None;
        let mut json = None;
        if reached(Phase::LiveCredsWritten) {
            creds = read_snap(fs, &paths.credentials)?;
            // Without credentials before, nothing (or exactly what was written) may be there now.
            let ok = match o.live_creds {
                Some(before) => creds.as_ref().is_some_and(|c| c.text == o.written_creds || c.text == before.text),
                None => creds.as_ref().is_none_or(|c| c.text == o.written_creds),
            };
            if !ok {
                return Ok(None);
            }
        }
        if reached(Phase::LiveJsonWritten) {
            json = read_snap(fs, &paths.claude_json)?;
            let ok = json.as_ref().is_some_and(|j| {
                compare_identity(&identity_from_oauth_account(j.data.get("oauthAccount")), &o.target_identity)
                    == IdentityMatch::Same
                    || as_before(j)
            });
            if !ok {
                return Ok(None);
            }
        }
        Ok(Some((creds, json)))
    })();
    let Ok(Some((creds, json))) = inspected else { return false };
    let clean = std::cell::Cell::new(true);
    let step = |r: Result<(), Abort>| {
        if r.is_err() {
            clean.set(false);
        }
    };
    // Each restore is guarded: the file must still be exactly what was inspected above.
    let still = |path: &Path, text: &str| -> io::Result<bool> { Ok(fs.read_file(path)?.as_deref() == Some(text)) };
    if let Some(now) = &creds
        && Some(now.text.as_str()) != o.live_creds.map(|c| c.text.as_str())
    {
        step((|| -> Result<(), Abort> {
            if let Some(before) = o.live_creds {
                let guard = || still(&paths.credentials, &now.text);
                atomic_write(&*deps.delay, fs, &paths.credentials, &before.text, Some(&guard))?;
                return Ok(());
            }
            // There were no credentials before: the file this swap created goes again (only while it is exactly what was written).
            if !still(&paths.credentials, &now.text)? {
                return Err(Abort::Other);
            }
            fs.rm(&paths.credentials)?;
            Ok(())
        })());
    }
    if let Some(now) = &json
        && !as_before(now)
    {
        let mut restored = now.data.clone();
        match o.live_account {
            Some(a) => {
                restored.insert("oauthAccount".into(), Value::Object(a.clone()));
            }
            None => {
                restored.shift_remove("oauthAccount");
            }
        }
        let guard = || still(&paths.claude_json, &now.text);
        step(
            atomic_write(&*deps.delay, fs, &paths.claude_json, &stringify2(&Value::Object(restored)), Some(&guard))
                .map_err(Abort::from),
        );
    }
    // The outgoing record's new copy is the only one of its login until the live files are restored.
    if !clean.get() {
        return false;
    }
    if reached(Phase::OutgoingSaved)
        && let Some(out_dir) = o.out_dir
    {
        let creds_path = out_dir.join(".credentials.json");
        step(match o.out_creds {
            Some(c) => write(deps, &creds_path, &c.text).map_err(Abort::from),
            None => fs.rm(&creds_path).map_err(Abort::from),
        });
        let json_path = out_dir.join(".claude.json");
        step(match o.out_json {
            Some(j) => write(deps, &json_path, &j.text).map_err(Abort::from),
            None => fs.rm(&json_path).map_err(Abort::from),
        });
    }
    clean.get()
}

/// Temp files of the version-2 backups and journal (`<name>.<uuid>.tmp`); 0.9.0's files are left alone.
fn is_v2_temp(name: &str) -> bool {
    std::iter::once(JOURNAL)
        .chain(BACKUPS)
        .any(|base| name.starts_with(&format!("{base}.")) && crate::legacy_swap::is_uuid_tmp(name))
}

fn remove_backups(deps: &ActivateDeps) -> io::Result<()> {
    let fs = &*deps.fs;
    // The journal goes first: backups without a journal mean that no live file was modified.
    for name in std::iter::once(JOURNAL).chain(BACKUPS) {
        let _ = fs.rm(&deps.backup_dir.join(name));
    }
    for name in fs.readdir(&deps.backup_dir)? {
        if is_v2_temp(&name) {
            let _ = fs.rm(&deps.backup_dir.join(&name));
        }
    }
    let _ = fs.rmdir(&deps.backup_dir);
    Ok(())
}

/// `activationJournalPending`: true while a version-2 journal exists (or the journal cannot be read): the live files may be
/// half written, so the live login must not be reconciled.
pub fn activation_journal_pending(fs: &dyn SwapFs, backup_dir: &Path) -> bool {
    let text = match fs.read_file(&backup_dir.join(JOURNAL)) {
        Ok(Some(t)) => t,
        Ok(None) => return false,
        Err(_) => return true,
    };
    match js_json::parse(&text) {
        Ok(Value::Object(m)) => m.get("version").and_then(Value::as_f64) == Some(2.0),
        Ok(_) => true,
        Err(_) => true,
    }
}

/// `recoverActivationWithRetry`: the start-up recovery, a few tries while Claude Code holds its locks; after that the polls
/// and [`start_activation_recovery_retry`] retry. Once `stopped` (the app quits) no further attempt starts.
pub fn recover_activation_with_retry(deps: &ActivateDeps, attempts: u32, wait: Duration, stopped: &dyn Fn() -> bool) -> Recovery {
    let mut i = 1;
    loop {
        if stopped() {
            return Recovery::Locked;
        }
        let result = recover_interrupted_activation(deps);
        if result != Recovery::Locked || i >= attempts {
            return result;
        }
        (deps.delay)(wait);
        i += 1;
    }
}

/// `startActivationRecoveryRetry`: tries a pending version-2 recovery again every `interval`, also while the limits panel
/// and its polls are off. One try at a time; ticks that come while one runs are skipped. Stops when the task is aborted.
pub fn start_activation_recovery_retry<F, Fut>(slot: Arc<SwapSlot>, interval: Duration, retry: F) -> tokio::task::JoinHandle<()>
where
    F: Fn() -> Fut + Send + 'static,
    Fut: std::future::Future<Output = ()> + Send,
{
    tokio::spawn(async move {
        let mut ticks = tokio::time::interval_at(tokio::time::Instant::now() + interval, interval);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            ticks.tick().await;
            if slot.is_recovery_pending() {
                retry().await;
            }
        }
    })
}

/// `clearPendingActivation`: clears the warning of an unresolved swap (`clear` deletes the journal and backups; the user
/// confirmed). A version-2 swap that may have written the live credentials can have left the target's tokens under the
/// outgoing account's identity: that record is marked switched out (`foreign`) and, when the live tokens are not its own
/// saved ones, they are held (`heldTokens`).
pub fn clear_pending_activation(deps: &ActivateDeps, clear: &dyn Fn() -> bool) -> bool {
    let fs = &*deps.fs;
    let mut suspect: Option<String> = None;
    let mut held: Option<String> = None;
    let _ = (|| -> Result<(), Abort> {
        let Some(text) = fs.read_file(&deps.backup_dir.join(JOURNAL))? else { return Ok(()) };
        let Ok(Value::Object(info)) = js_json::parse(&text) else { return Ok(()) };
        let phase = Phase::parse(info.get("phase"));
        if info.get("version").and_then(Value::as_f64) == Some(2.0)
            && is_account_id_value(info.get("outgoingId"))
            && matches!(phase, Some(Phase::LiveCredsWritten | Phase::LiveJsonWritten))
        {
            let id = info.get("outgoingId").and_then(Value::as_str).unwrap_or_default().to_string();
            suspect = Some(id.clone());
            let live_refresh = match swap_paths(&deps.home, &deps.env) {
                Some(p) => read_snap(fs, &p.credentials)?.and_then(|s| refresh_of(&s)),
                None => None,
            };
            let own_refresh = read_snap(fs, &deps.store.dir_of(&id)?.join(".credentials.json"))?.and_then(|s| refresh_of(&s));
            if let Some(live) = live_refresh
                && Some(&live) != own_refresh.as_ref()
            {
                held = Some(token_hash(&live));
            }
        }
        Ok(())
    })();
    let cleared = clear();
    if cleared
        && let Some(id) = suspect
        && deps.store.get(&id).is_some()
    {
        // accounts.json read-only: nothing reconciles or backs up meanwhile either.
        if deps.store.set_custody(&id, Custody::Foreign, None).is_ok()
            && let Some(h) = &held
        {
            let _ = deps.store.set_held_tokens(&id, Some(h));
        }
    }
    cleared
}

fn refresh_of(snap: &Snap) -> Option<String> {
    oauth_of(&snap.data).and_then(|o| str_of(o.get("refreshToken"))).map(str::to_string)
}

/// `recoverInterruptedActivation`: call at app start, before the 0.9.0 recovery; `Legacy` means there is no version-2 journal
/// and [`crate::legacy_swap::recover_interrupted_swap`] decides. Version-2 backups without any journal (a crash before the
/// first journal write) are deleted first. Busy Claude Code locks give `Locked`: the journal stays and the swap is NOT marked
/// unresolved, so nobody is invited to clear a state the next try can still repair.
pub fn recover_interrupted_activation(deps: &ActivateDeps) -> Recovery {
    let fs = &*deps.fs;
    let slot = &deps.slot;
    // An unreadable journal is not a missing one: nothing is deleted then.
    let text = match fs.read_file(&deps.backup_dir.join(JOURNAL)) {
        Ok(t) => t,
        Err(_) => {
            slot.set_recovery_pending(false);
            return Recovery::Legacy;
        }
    };
    let Some(text) = text else {
        slot.set_recovery_pending(false);
        if let Some(_guard) = slot.try_claim() {
            // Re-checked under the slot: only without a journal are the backups orphans.
            let _ = (|| -> io::Result<()> {
                if fs.read_file(&deps.backup_dir.join(JOURNAL))?.is_none() {
                    for name in BACKUPS {
                        fs.rm(&deps.backup_dir.join(name))?;
                    }
                    for name in fs.readdir(&deps.backup_dir)? {
                        if is_v2_temp(&name) {
                            fs.rm(&deps.backup_dir.join(&name))?;
                        }
                    }
                    let _ = fs.rmdir(&deps.backup_dir);
                }
                Ok(())
            })();
        }
        return Recovery::Legacy;
    };
    let info = match js_json::parse(&text) {
        Ok(Value::Object(m)) if m.get("version").and_then(Value::as_f64) == Some(2.0) => m,
        _ => {
            slot.set_recovery_pending(false);
            return Recovery::Legacy;
        }
    };
    let Some(_guard) = slot.try_claim() else { return Recovery::None };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| recover_v2(deps, &info)));
    match result {
        Ok(Ok(r)) => {
            slot.set_recovery_pending(r == Recovery::Locked);
            if r != Recovery::Locked {
                slot.set_unresolved(r == Recovery::Manual);
            }
            r
        }
        _ => {
            slot.set_recovery_pending(false);
            slot.set_unresolved(true);
            Recovery::Manual
        }
    }
}

fn recover_v2(deps: &ActivateDeps, info: &Rec) -> Result<Recovery, Abort> {
    let store = &deps.store;
    let fs = &*deps.fs;
    let phase = Phase::parse(info.get("phase"));
    let target_id = info.get("targetId").and_then(Value::as_str).filter(|t| is_account_id(t)).map(str::to_string);
    // null: there was no usable live login to save (1.0.10); a missing or bad id is refused.
    let outgoing_id = match info.get("outgoingId") {
        Some(Value::Null) => Some(None),
        Some(Value::String(s)) if is_account_id(s) => Some(Some(s.clone())),
        _ => None,
    };
    let (Some(phase), Some(outgoing_id), Some(target_id)) = (phase, outgoing_id, target_id) else { return Ok(Recovery::Manual) };
    let live_creds_existed = info.get("liveCredsExisted") != Some(&Value::Bool(false));
    let created = info.get("created") == Some(&Value::Bool(true));
    let paths = swap_paths(&deps.home, &deps.env);
    if phase == Phase::Verified {
        // The outgoing record holds the live family it received either way. The other roles only when the target is still
        // the one signed in; otherwise the login changed since and reconcile assigns them from what is signed in now.
        let target = store.get(&target_id);
        let live_json = match &paths {
            Some(p) => read_snap(fs, &p.claude_json)?,
            None => None,
        };
        let live_id = identity_from_oauth_account(live_json.as_ref().and_then(|j| j.data.get("oauthAccount")));
        match &target {
            Some(t)
                if custody_of(t.custody) != Custody::Quarantined
                    && compare_identity(&live_id, &t.identity) == IdentityMatch::Same =>
            {
                // Nothing proves here what cswap may hold of the outgoing login: it stays the live family.
                let at = info.get("startedAt").and_then(Value::as_f64).filter(|a| a.is_finite()).unwrap_or_else(|| (deps.now)());
                let swap = AppSwap { at, from: None, own: family_of(t.family) == TokenFamily::Own };
                finish_roles(store, outgoing_id.as_deref(), &target_id, &live_id, TokenFamily::Live, &swap)?;
            }
            _ => {
                if let Some(id) = &outgoing_id
                    && store.get(id).is_some()
                {
                    store.set_family(id, TokenFamily::Live)?;
                    store.set_app_swap(id, None)?;
                }
            }
        }
        remove_backups(deps)?;
        return Ok(Recovery::None);
    }
    if phase == Phase::BackedUp {
        // The record before the journal: a crash in between leaves the journal, and the next start removes it again.
        if created && let Some(id) = &outgoing_id {
            store.remove(id)?;
        }
        remove_backups(deps)?;
        return Ok(Recovery::None);
    }
    let Some(paths) = paths else { return Ok(Recovery::Manual) };
    let read = |name: &str| fs.read_file(&deps.backup_dir.join(name));
    let live_b = read(LIVE_CREDS)?;
    let live_json_b = read(LIVE_JSON)?;
    let out_creds_b = read(OUT_CREDS)?;
    let out_json_b = read(OUT_JSON)?;
    let Some(live_json_b) = live_json_b else { return Ok(Recovery::Manual) };
    if live_creds_existed && live_b.is_none() {
        return Ok(Recovery::Manual);
    }
    if (info.get("outCredsExisted") == Some(&Value::Bool(true)) && out_creds_b.is_none())
        || (info.get("outJsonExisted") == Some(&Value::Bool(true)) && out_json_b.is_none())
    {
        return Ok(Recovery::Manual);
    }
    // `(JSON.parse(liveJsonB) as Rec).oauthAccount`: a non-object parses but has no account.
    // `null.oauthAccount` throws in TS: manual too.
    let Ok(parsed_b) = js_json::parse(&live_json_b).map_err(drop).and_then(|v| if v.is_null() { Err(()) } else { Ok(v) }) else {
        return Ok(Recovery::Manual);
    };
    let old_account = js::record(parsed_b.get("oauthAccount")).cloned();
    // A config without an account is possible only when there was no usable login (nothing was saved from it).
    if old_account.is_none() && outgoing_id.is_some() {
        return Ok(Recovery::Manual);
    }
    let target_record = store.get(&target_id);
    let locked = with_claude_locks(&paths.credentials, &paths.claude_json, false, &deps.locks, || -> Result<Recovery, Abort> {
        let live = read_snap(fs, &paths.credentials)?;
        let target_creds = read_snap(fs, &store.dir_of(&target_id)?.join(".credentials.json"))?;
        let untouched = match &live_b {
            Some(b) => live.as_ref().is_some_and(|l| &l.text == b),
            None => fs.read_file(&paths.credentials)?.is_none(),
        };
        // Still exactly the target's login that was written (nobody renewed it since): the old one may go back.
        let live_refresh = live.as_ref().and_then(refresh_of);
        let ours = live_refresh.is_some() && live_refresh == target_creds.as_ref().and_then(refresh_of);
        if !untouched && !ours {
            return Ok(Recovery::Manual);
        }
        // The identity too must be the old one or the target's; anything else was written by someone else and is kept.
        let now_json = read_snap(fs, &paths.claude_json)?;
        let now_id = identity_from_oauth_account(now_json.as_ref().and_then(|j| j.data.get("oauthAccount")));
        let old_json = now_json.as_ref().is_some_and(|j| match &old_account {
            Some(a) => {
                compare_identity(&now_id, &identity_from_oauth_account(Some(&Value::Object(a.clone())))) == IdentityMatch::Same
            }
            None => js::record(j.data.get("oauthAccount")).is_none(),
        });
        if now_json.is_some()
            && !old_json
            && !target_record.as_ref().is_some_and(|t| compare_identity(&now_id, &t.identity) == IdentityMatch::Same)
        {
            return Ok(Recovery::Manual);
        }
        if !untouched {
            match &live_b {
                Some(b) => write(deps, &paths.credentials, b)?,
                None => fs.rm(&paths.credentials)?,
            }
        }
        if let Some(now) = &now_json
            && !old_json
        {
            let mut restored = now.data.clone();
            match &old_account {
                Some(a) => {
                    restored.insert("oauthAccount".into(), Value::Object(a.clone()));
                }
                None => {
                    restored.shift_remove("oauthAccount");
                }
            }
            write(deps, &paths.claude_json, &stringify2(&Value::Object(restored)))?;
        }
        if let Some(id) = &outgoing_id {
            let out_dir = store.dir_of(id)?;
            match &out_creds_b {
                Some(b) => write(deps, &out_dir.join(".credentials.json"), b)?,
                None => fs.rm(&out_dir.join(".credentials.json"))?,
            }
            match &out_json_b {
                Some(b) => write(deps, &out_dir.join(".claude.json"), b)?,
                None => fs.rm(&out_dir.join(".claude.json"))?,
            }
            if created {
                store.remove(id)?;
            }
        }
        remove_backups(deps)?;
        Ok(Recovery::Recovered)
    });
    Ok(match locked {
        Ok(Ok(r)) => r,
        Ok(Err(_)) => Recovery::Manual,
        Err(LockError::Timeout(_)) => Recovery::Locked,
        Err(_) => Recovery::Manual,
    })
}

#[cfg(test)]
mod tests;
