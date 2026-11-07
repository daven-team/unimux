//! The family rule and the account guards around "make main" (ports of `renewRule` of src/main/accounts/refs.ts, of
//! src/main/accounts/guards.ts, dead.ts, makeMain.ts and `heldTokenHash` of resync.ts).
//!
//! The IPC handlers here take their dependencies as closures (the renderer's arguments arrive as JSON values and are never
//! trusted) and answer with fixed codes only.

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::cswap::{CswapRoster, cswap_holds};
use crate::identity::{Custody, IdentityMatch, TokenFamily, compare_identity, custody_of, family_of, is_account_id_value};
use crate::js;
use crate::results::{AdoptCopyError, AdoptCopyResult, SwapError, SwapResult};
use crate::store::{LiveIdentity, ManagedAccount, StoreError};
use crate::swapfs::{SwapFs, read_snap};

/// `RenewRule` (`AccountRef['renew']`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RenewRule {
    Allowed,
    HeldByLive,
    HeldByCswap,
    SwitchedOut,
}

/// The one rule for which saved Claude profiles this app may send to the token endpoint (the card's `renew` and the refresh
/// gate both use it): never a record that is or was the live login, never one with the live identity, and never a copy of
/// the live family (`family: live`, also a 0.9.0 record) that cswap may hold as well.
pub fn renew_rule(record: &ManagedAccount, live: Option<&LiveIdentity>, cswap: &CswapRoster) -> RenewRule {
    let custody = custody_of(record.custody);
    // A set-aside duplicate is never renewed: another record holds the account.
    if custody == Custody::Quarantined || custody == Custody::Foreign {
        return RenewRule::SwitchedOut;
    }
    // Like cswapHolds: only a proven different identity lets a record be renewed while someone is signed in.
    if custody == Custody::Live
        || live.is_some_and(|l| compare_identity(&record.identity, &l.identity) != IdentityMatch::Different)
    {
        return RenewRule::HeldByLive;
    }
    if family_of(record.family) == TokenFamily::Live && cswap_holds(cswap, &record.identity) {
        return RenewRule::HeldByCswap;
    }
    RenewRule::Allowed
}

/// `gateFamilyRefresh`'s decision: the record whose profile dir is `dir` exists, is not set aside and its family lives
/// nowhere else. A dir no record names is never renewed.
pub fn family_refresh_allowed(
    records: &[ManagedAccount],
    dir_of: &dyn Fn(&str) -> Option<std::path::PathBuf>,
    live: Option<&LiveIdentity>,
    cswap: &CswapRoster,
    dir: &Path,
) -> bool {
    let Some(record) = records.iter().find(|a| dir_of(&a.id).as_deref() == Some(dir)) else { return false };
    custody_of(record.custody) != Custody::Quarantined && renew_rule(record, live, cswap) == RenewRule::Allowed
}

/// `gateFamilyRefresh`: renewals follow the family rule; anything else answers `blocked`.
pub fn gate_family_refresh<R>(
    store: &crate::store::AccountsStore,
    cswap: &CswapRoster,
    dir: &Path,
    refresh: impl FnOnce(&Path) -> R,
    blocked: R,
) -> R {
    let records = store.list();
    let allowed = family_refresh_allowed(&records, &|id| store.dir_of(id).ok(), store.live().as_ref(), cswap, dir);
    if allowed { refresh(dir) } else { blocked }
}

/// SHA-256 (hex) of a refresh token: the only form in which a held or dead token is remembered (`heldTokenHash`,
/// `deadTokenHash`).
pub fn token_hash(refresh_token: &str) -> String {
    js::sha256_hex(refresh_token)
}

/// `isClearedLogin`: credentials Claude Code cleared after a rejected renewal (a login object whose two tokens are empty).
pub fn is_cleared_login(credentials: &Map<String, Value>) -> bool {
    js::record(credentials.get("claudeAiOauth")).is_some_and(|o| {
        o.get("accessToken").and_then(Value::as_str) == Some("") && o.get("refreshToken").and_then(Value::as_str) == Some("")
    })
}

/// `savedRefreshToken`: refresh token of a profile's saved copy (no file, no login, unreadable: `None`).
pub fn saved_refresh_token(fs: &dyn SwapFs, dir: &Path) -> Option<String> {
    let snap = read_snap(fs, &dir.join(".credentials.json")).ok()??;
    let oauth = js::record(snap.data.get("claudeAiOauth"))?;
    js::string(oauth.get("refreshToken")).filter(|t| !t.is_empty()).map(str::to_string)
}

/// `savedCopyDead`: the record's saved copy still holds exactly the token marked dead; a new sign-in ends it.
pub fn saved_copy_dead(fs: &dyn SwapFs, dir: &Path, record: Option<&ManagedAccount>) -> bool {
    let Some(dead) = record.and_then(|r| r.dead_tokens.as_deref()) else { return false };
    saved_refresh_token(fs, dir).is_some_and(|t| token_hash(&t) == dead)
}

/// What the account-changing handlers wait for (`GuardDeps`).
pub struct GuardDeps<'a> {
    pub swap_running: &'a dyn Fn() -> bool,
    /// True while a journal or backups of an unresolved swap exist; an error counts as pending.
    pub swap_pending: &'a dyn Fn() -> std::io::Result<bool>,
    /// Synchronous view of the same fact.
    pub swap_pending_now: Option<&'a dyn Fn() -> bool>,
    /// accounts.json cannot be read safely.
    pub read_only: Option<&'a dyn Fn() -> bool>,
}

impl GuardDeps<'_> {
    fn read_only(&self) -> bool {
        self.read_only.is_some_and(|f| f())
    }
}

/// `'busy' | 'pending'`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MutationBlock {
    Busy,
    Pending,
}

/// `accountMutationBlock`: account-changing actions wait while a swap runs or an earlier one is unresolved.
pub fn account_mutation_block(deps: &GuardDeps<'_>) -> Option<MutationBlock> {
    if (deps.swap_running)() {
        return Some(MutationBlock::Busy);
    }
    match (deps.swap_pending)() {
        Ok(false) => None,
        _ => Some(MutationBlock::Pending),
    }
}

/// `accounts:remove` answer: `{ ok, error? }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RemoveResult {
    pub ok: bool,
    pub error: Option<&'static str>,
}

impl RemoveResult {
    const OK: RemoveResult = RemoveResult { ok: true, error: None };
    const INVALID: RemoveResult = RemoveResult { ok: false, error: None };
    fn fail(error: &'static str) -> Self {
        RemoveResult { ok: false, error: Some(error) }
    }
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("ok".into(), Value::Bool(self.ok));
        if let Some(e) = self.error {
            m.insert("error".into(), Value::String(e.into()));
        }
        Value::Object(m)
    }
}

pub struct RemoveDeps<'a> {
    pub guard: GuardDeps<'a>,
    /// The record signed in to Claude Code is never removed.
    pub is_live: &'a dyn Fn(&str) -> bool,
    pub cancel_login: &'a dyn Fn(&str),
    pub remove: &'a dyn Fn(&str) -> Result<(), StoreError>,
    pub on_removed: &'a dyn Fn(),
}

/// `handleRemoveAccount`: refused while a swap runs or is unresolved, `readOnly` while accounts.json cannot be read safely,
/// `live` for the record signed in to Claude Code. Another store failure is returned as an error (the IPC answer rejects).
pub fn handle_remove_account(deps: &RemoveDeps<'_>, id: &Value) -> Result<RemoveResult, StoreError> {
    if !is_account_id_value(Some(id)) {
        return Ok(RemoveResult::INVALID);
    }
    let id = id.as_str().unwrap_or_default();
    if deps.guard.read_only() {
        return Ok(RemoveResult::fail("readOnly"));
    }
    if (deps.is_live)(id) {
        return Ok(RemoveResult::fail("live"));
    }
    if let Some(block) = account_mutation_block(&deps.guard) {
        return Ok(RemoveResult::fail(if block == MutationBlock::Busy { "busy" } else { "pending" }));
    }
    // Checked again after the wait, right before a parked restore snapshot is dropped.
    if deps.guard.read_only() {
        return Ok(RemoveResult::fail("readOnly"));
    }
    if (deps.is_live)(id) {
        return Ok(RemoveResult::fail("live"));
    }
    (deps.cancel_login)(id);
    match (deps.remove)(id) {
        Ok(()) => {}
        Err(StoreError::ReadOnly) => return Ok(RemoveResult::fail("readOnly")),
        Err(e) => return Err(e),
    }
    (deps.on_removed)();
    Ok(RemoveResult::OK)
}

/// `dismissAccountNotice`: a read-only accounts.json keeps its notices; any other failure is one fixed error.
pub fn dismiss_account_notice(dismiss: &dyn Fn(&str) -> Result<(), StoreError>, id: &Value) -> Result<(), &'static str> {
    let Some(id) = id.as_str().filter(|s| !s.is_empty() && js::len16(s) <= 64) else { return Ok(()) };
    match dismiss(id) {
        Ok(()) | Err(StoreError::ReadOnly) => Ok(()),
        Err(_) => Err("notice not dismissed"),
    }
}

/// `loginBlock`: re-logins of the main login or a saved Claude account wait for a swap; no Claude login starts while
/// accounts.json is read-only. Codex logins never touch the files a swap moves.
pub fn login_block(deps: &GuardDeps<'_>, request: &Value) -> Option<&'static str> {
    if request.get("provider").and_then(Value::as_str) != Some("claude") {
        return None;
    }
    if deps.read_only() {
        return Some("readOnly");
    }
    let kind = request.get("target").and_then(|t| t.get("type")).and_then(Value::as_str);
    if kind != Some("main") && kind != Some("account") {
        return None;
    }
    account_mutation_block(deps).map(|b| if b == MutationBlock::Busy { "busy" } else { "pending" })
}

/// `gateProfileRefresh`: background refreshes never write into a managed profile while a swap runs or is unresolved
/// (checked synchronously right before the refresh starts).
pub fn gate_profile_refresh<R>(deps: &GuardDeps<'_>, dir: &Path, refresh: impl FnOnce(&Path) -> R, blocked: R) -> R {
    if (deps.swap_running)() || deps.swap_pending_now.is_some_and(|f| f()) { blocked } else { refresh(dir) }
}

/// `adoptCopyRefusal`: the record exists, is held by the app (`app` custody) and is provably not the live account.
pub fn adopt_copy_refusal(record: Option<&ManagedAccount>, live: Option<&LiveIdentity>) -> Option<AdoptCopyError> {
    let Some(record) = record.filter(|r| custody_of(r.custody) == Custody::App) else { return Some(AdoptCopyError::Invalid) };
    if let Some(live) = live
        && (live.record_id.as_deref() == Some(record.id.as_str())
            || compare_identity(&record.identity, &live.identity) != IdentityMatch::Different)
    {
        return Some(AdoptCopyError::Live);
    }
    None
}

pub struct AdoptCopyDeps<'a> {
    pub guard: GuardDeps<'a>,
    pub login_active: &'a dyn Fn() -> bool,
    pub get: &'a dyn Fn(&str) -> Option<ManagedAccount>,
    pub live: &'a dyn Fn() -> Option<LiveIdentity>,
    /// Sets the family to `own`.
    pub set_family_own: &'a dyn Fn(&str) -> Result<(), StoreError>,
    /// After the record became app-owned (reads that account's limits now).
    pub on_adopted: &'a dyn Fn(&str),
}

/// `handleAdoptCopy` ("Renew this copy in unimux", 0.9.2): only from the app window (`trusted`).
pub fn handle_adopt_copy(deps: &AdoptCopyDeps<'_>, trusted: bool, id: &Value) -> AdoptCopyResult {
    if !trusted || !is_account_id_value(Some(id)) {
        return AdoptCopyResult::fail(AdoptCopyError::Invalid);
    }
    let id = id.as_str().unwrap_or_default();
    if deps.guard.read_only() {
        return AdoptCopyResult::fail(AdoptCopyError::ReadOnly);
    }
    if (deps.login_active)() {
        return AdoptCopyResult::fail(AdoptCopyError::Busy);
    }
    if let Some(block) = account_mutation_block(&deps.guard) {
        return AdoptCopyResult::fail(if block == MutationBlock::Busy { AdoptCopyError::Busy } else { AdoptCopyError::Pending });
    }
    // Checked after the wait, right before the write: a swap or reconcile may have changed the roles meanwhile.
    if deps.guard.read_only() {
        return AdoptCopyResult::fail(AdoptCopyError::ReadOnly);
    }
    if let Some(refusal) = adopt_copy_refusal((deps.get)(id).as_ref(), (deps.live)().as_ref()) {
        return AdoptCopyResult::fail(refusal);
    }
    // Synchronously right before the write: a swap or a login that started during the wait must not see the change.
    if (deps.guard.swap_running)() || (deps.login_active)() {
        return AdoptCopyResult::fail(AdoptCopyError::Busy);
    }
    match (deps.set_family_own)(id) {
        Ok(()) => {}
        Err(StoreError::ReadOnly) => return AdoptCopyResult::fail(AdoptCopyError::ReadOnly),
        Err(_) => return AdoptCopyResult::fail(AdoptCopyError::Write),
    }
    (deps.on_adopted)(id);
    AdoptCopyResult::OK
}

pub struct MakeMainDeps<'a> {
    /// True while a login window flow is in progress.
    pub login_active: &'a dyn Fn() -> bool,
    /// Server-side check of the target (`checkActivationTarget`); a refusal is returned as is and nothing is swapped. An
    /// `Err` (the TS throw) answers `write`.
    pub validate: &'a dyn Fn(&str) -> Result<Option<SwapResult>, ()>,
    /// `activateAccount` bound to its real dependencies.
    pub swap: &'a dyn Fn(&str) -> Result<SwapResult, ()>,
    /// After a successful swap (refreshes the usage panel); its failure does not change the answer.
    pub on_swapped: &'a dyn Fn() -> Result<(), ()>,
}

/// `handleMakeMain`: the IPC handler body of `accounts:makeMain`.
pub fn handle_make_main(deps: &MakeMainDeps<'_>, id: &Value) -> SwapResult {
    if !is_account_id_value(Some(id)) {
        return SwapResult::fail(SwapError::Invalid);
    }
    let id = id.as_str().unwrap_or_default();
    if (deps.login_active)() {
        return SwapResult::fail(SwapError::Busy);
    }
    match (deps.validate)(id) {
        Ok(Some(refusal)) => return refusal,
        Ok(None) => {}
        Err(()) => return SwapResult::fail(SwapError::Write),
    }
    let Ok(result) = (deps.swap)(id) else { return SwapResult::fail(SwapError::Write) };
    if result.ok {
        let _ = (deps.on_swapped)();
    }
    result
}

#[cfg(test)]
mod tests;
