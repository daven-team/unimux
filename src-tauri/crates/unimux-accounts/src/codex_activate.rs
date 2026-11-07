//! "Make main" for a saved Codex account and the look at the live Codex login before every poll (1.1.2; port of
//! src/main/accounts/codexActivate.ts). Only files move: no token is ever sent anywhere.
//!
//! The outgoing live auth.json is copied into its own record first (a new record when it has none, so no login is ever
//! dropped) and into one emergency copy (`codex-accounts/swap-backup/auth.json`, overwritten each time), then the target's
//! auth.json replaces the live one atomically. Running Codex processes keep running; Codex reads the file again before it
//! renews a token and skips a renewal when the account in it changed.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use unimux_core::atomic_write::{AtomicWriteOptions, atomic_write};

use crate::codex::{
    CodexAccount, CodexIdentity, CodexLive, CodexRefusal, codex_activation_refusal, codex_stores_in_keyring,
    compare_codex_identity, live_record_of, outside_switch, parse_codex_auth,
};
use crate::codex_store::{CodexAccountsStore, CodexPatch};
use crate::identity::IdentityMatch;
use crate::results::{SwapError, SwapResult};
use crate::slot::SwapSlot;

pub type ReadText = Arc<dyn Fn(&Path) -> Option<String> + Send + Sync>;
pub type WriteText = Arc<dyn Fn(&Path, &str) -> std::io::Result<()> + Send + Sync>;

/// `CodexActivateDeps`.
#[derive(Clone)]
pub struct CodexActivateDeps {
    pub store: Arc<CodexAccountsStore>,
    /// The live CODEX_HOME (CODEX_HOME, else ~/.codex).
    pub live_home: Arc<dyn Fn() -> PathBuf + Send + Sync>,
    pub now: Arc<dyn Fn() -> f64 + Send + Sync>,
    /// File contents or `None` (missing, unreadable); a test seam.
    pub read_text: Option<ReadText>,
    pub write_text: Option<WriteText>,
    pub slot: Arc<SwapSlot>,
}

impl CodexActivateDeps {
    fn read(&self, path: &Path) -> Option<String> {
        match &self.read_text {
            Some(f) => f(path),
            None => crate::js::read_text(path).ok(),
        }
    }

    fn write(&self, path: &Path, text: &str) -> std::io::Result<()> {
        match &self.write_text {
            Some(f) => f(path, text),
            None => {
                atomic_write(path, text.as_bytes(), &AtomicWriteOptions { mode: Some(0o600), ..AtomicWriteOptions::default() })
            }
        }
    }
}

/// `readLiveCodexIdentity`: the live login's identity (`None`: none, or an API key).
pub fn read_live_codex_identity(deps: &CodexActivateDeps) -> Option<CodexIdentity> {
    let login = parse_codex_auth(deps.read(&(deps.live_home)().join("auth.json")).as_deref())?;
    login.chatgpt.then_some(login.identity)
}

/// `reconcileCodexLive`: before every poll (never during a Codex swap) records who is in the live auth.json and marks the
/// copy of an account that left it without the app as possibly outdated. Returns the live identity.
pub fn reconcile_codex_live(deps: &CodexActivateDeps) -> Option<CodexIdentity> {
    let live = read_live_codex_identity(deps);
    if deps.slot.is_codex_running() || deps.store.read_only() {
        return live;
    }
    let result = outside_switch(&deps.store.snapshot(), live.as_ref());
    if !result.changed {
        return live;
    }
    // Read-only meanwhile: tried again on the next poll.
    let _ = (|| -> Result<(), crate::codex_store::CodexStoreError> {
        for id in &result.outdated {
            deps.store.patch(id, &CodexPatch { outdated: Some(true), live_family: Some(false), ..CodexPatch::default() })?;
        }
        deps.store.set_live(result.live.as_ref())
    })();
    live
}

fn named(record: Option<&CodexAccount>, error: SwapError) -> SwapResult {
    SwapResult::fail_named(error, record.and_then(|r| r.identity.email.clone()).filter(|e| !e.is_empty()))
}

/// `checkCodexTarget`: why a saved Codex account cannot be made main now, or `None`; the same checks
/// [`activate_codex_account`] makes first.
pub fn check_codex_target(deps: &CodexActivateDeps, id: &str) -> Option<SwapResult> {
    let record = deps.store.get(id);
    let record = record.as_ref();
    if deps.slot.is_codex_running() || deps.store.read_only() {
        return Some(named(record, SwapError::Busy));
    }
    // A config that keeps the login in the system keyring would ignore the auth.json the swap writes.
    if codex_stores_in_keyring(deps.read(&(deps.live_home)().join("config.toml")).as_deref()) {
        return Some(named(record, SwapError::Unsupported));
    }
    if let Some(refusal) = codex_activation_refusal(record, read_live_codex_identity(deps).as_ref()) {
        let e = match refusal {
            CodexRefusal::NoTarget => SwapError::NoTarget,
            CodexRefusal::Foreign => SwapError::Foreign,
            CodexRefusal::SameAccount => SwapError::SameAccount,
        };
        return Some(named(record, e));
    }
    let dir = deps.store.dir_of(id).ok()?;
    if parse_codex_auth(deps.read(&dir.join("auth.json")).as_deref()).is_none() {
        return Some(named(record, SwapError::Invalid));
    }
    None
}

fn patch_identity(identity: &CodexIdentity) -> CodexPatch {
    CodexPatch {
        email: identity.email.clone().map(Some),
        user_id: identity.user_id.clone().map(Some),
        account_id: identity.account_id.clone().map(Some),
        ..CodexPatch::default()
    }
}

/// `activateCodexAccount`.
pub fn activate_codex_account(deps: &CodexActivateDeps, id: &str) -> SwapResult {
    if let Some(refusal) = check_codex_target(deps, id) {
        return refusal;
    }
    let Some(_running) = deps.slot.claim_codex() else { return named(deps.store.get(id).as_ref(), SwapError::Busy) };
    let run = || -> Result<SwapResult, ()> {
        let record = deps.store.get(id).ok_or(())?;
        let dir = deps.store.dir_of(id).map_err(drop)?;
        let target_raw = deps.read(&dir.join("auth.json"));
        let target = parse_codex_auth(target_raw.as_deref());
        let (Some(target_raw), Some(target)) = (target_raw, target) else { return Ok(named(Some(&record), SwapError::Invalid)) };
        let live_home = (deps.live_home)();
        let live_path = live_home.join("auth.json");
        let outgoing_raw = deps.read(&live_path);
        let outgoing = parse_codex_auth(outgoing_raw.as_deref());
        if let (Some(outgoing), Some(outgoing_raw)) = (&outgoing, outgoing_raw.as_deref().filter(|r| !r.is_empty())) {
            // The emergency copy first (one, overwritten each time), then the outgoing account's own record.
            let backup_dir = deps.store.root().join("swap-backup");
            fs::create_dir_all(&backup_dir).map_err(drop)?;
            deps.write(&backup_dir.join("auth.json"), outgoing_raw).map_err(drop)?;
            if outgoing.chatgpt {
                match live_record_of(&deps.store.list(), Some(&outgoing.identity)).cloned() {
                    None => {
                        let (new_id, new_dir) = deps.store.prepare().map_err(drop)?;
                        deps.write(&new_dir.join("auth.json"), outgoing_raw).map_err(drop)?;
                        deps.store
                            .commit(&CodexAccount {
                                id: new_id,
                                added_at: (deps.now)(),
                                identity: outgoing.identity.clone(),
                                ..CodexAccount::default()
                            })
                            .map_err(drop)?;
                    }
                    Some(holder) => {
                        deps.write(&deps.store.dir_of(&holder.id).map_err(drop)?.join("auth.json"), outgoing_raw)
                            .map_err(drop)?;
                        // Its copy is the newest login now and the only one in use: no longer a twin, no longer outdated.
                        let patch =
                            CodexPatch { live_family: Some(false), outdated: Some(false), ..patch_identity(&outgoing.identity) };
                        deps.store.patch(&holder.id, &patch).map_err(drop)?;
                    }
                }
            }
        }
        fs::create_dir_all(&live_home).map_err(drop)?;
        deps.write(&live_path, &target_raw).map_err(drop)?;
        let check = parse_codex_auth(deps.read(&live_path).as_deref());
        let written = check
            .is_some_and(|c| !target.chatgpt || compare_codex_identity(&c.identity, &target.identity) == IdentityMatch::Same);
        if !written {
            return Ok(named(Some(&record), SwapError::Write));
        }
        deps.store
            .patch(id, &CodexPatch { live_family: Some(true), outdated: Some(false), ..CodexPatch::default() })
            .map_err(drop)?;
        let live = target.chatgpt.then(|| CodexLive { identity: target.identity.clone(), record_id: Some(id.to_string()) });
        deps.store.set_live(live.as_ref()).map_err(drop)?;
        let email = target.identity.email.clone().or(record.identity.email.clone()).filter(|e| !e.is_empty());
        Ok(SwapResult::ok(email))
    };
    run().unwrap_or_else(|()| SwapResult::fail(SwapError::Write))
}

#[cfg(test)]
mod tests;
