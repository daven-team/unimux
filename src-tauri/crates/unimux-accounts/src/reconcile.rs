//! Detects changes of the live Claude Code login made outside the app (cswap switch, `claude /login`, sign-out) on every poll
//! and file change, and assigns the roles (port of src/main/accounts/reconcile.ts): the record holding the live identity
//! becomes `live` (one card per account), the one that left becomes `foreign` (kept, never renewed) unless the app made the
//! change itself, and a second record of the live account is set aside. Nothing is deleted. Callers hold the swap slot
//! ([`reconcile_when_idle`]) so this never interleaves with an activation or a recovery.
//!
//! Blocking (file reads and Claude Code's lock in the resync): run it on a blocking thread.

use std::time::Duration;

use crate::identity::{
    AccountIdentity, Custody, IdentityMatch, TokenFamily, compare_identity, custody_of, family_of, fill_missing_identity,
    identity_fields,
};
use crate::resync::{ResyncError, ResyncResult};
use crate::slot::SwapSlot;
use crate::store::{AccountsStore, LiveIdentity, ManagedAccount, NewNotice, NoticeKind, StoreError};
use crate::swapfs::stringify;

/// Refreshes the active record's backup from the live login (`resyncActiveBackup` bound to its deps).
pub type ResyncFn<'a> = dyn Fn(&str, &AccountIdentity) -> Result<ResyncResult, ResyncError> + 'a;
/// `cswapWroteSince(identity, since)`; `Err` counts as yes.
pub type WroteSinceFn<'a> = dyn Fn(&AccountIdentity, f64) -> Result<bool, ()> + 'a;
/// `savedCopyDead(record)`; `Err` counts as no.
pub type SavedCopyDeadFn<'a> = dyn Fn(&ManagedAccount) -> Result<bool, ()> + 'a;

/// `ReconcileDeps`. Every closure answers `Err` where the TS dependency threw.
pub struct ReconcileDeps<'a> {
    pub store: &'a AccountsStore,
    /// Identity in the live Claude Code config, `None` when nobody is signed in. `Err` when it cannot tell (unreadable or
    /// half-written file): then nothing changes.
    pub read_live_identity: &'a dyn Fn() -> Result<Option<AccountIdentity>, ()>,
    /// Refreshes the active record's backup from the live login; absent where the live login is not a file (macOS Keychain).
    pub resync: Option<&'a ResyncFn<'a>>,
    /// Whether cswap may have saved this account's tokens at `since` or later (`cswapWroteSince`); absent: always yes.
    pub cswap_wrote_since: Option<&'a WroteSinceFn<'a>>,
    /// The record's saved copy is the login Claude Code cleared as dead; absent: never.
    pub saved_copy_dead: Option<&'a SavedCopyDeadFn<'a>>,
    pub now: &'a dyn Fn() -> f64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReconcileResult {
    pub active_id: Option<String>,
    pub changed: bool,
}

fn email_notice(kind: NoticeKind, at: f64, record: &ManagedAccount) -> NewNotice {
    NewNotice { kind, at, email: record.identity.email.clone(), record_id: Some(record.id.clone()), count: None }
}

/// `reconcileLive(deps, { ownChange })`. `Err` only for a store write that failed for another reason than a read-only
/// accounts.json (that one stops the writes and answers what is known).
pub fn reconcile_live(deps: &ReconcileDeps<'_>, own_change: bool) -> Result<ReconcileResult, StoreError> {
    let store = deps.store;
    let unchanged = |changed: bool| ReconcileResult { active_id: store.live().and_then(|l| l.record_id), changed };
    // accounts.json cannot be read safely: nothing is written (and no backup is made for a record that may not be listed).
    if store.read_only() {
        return Ok(unchanged(false));
    }
    let at = (deps.now)();
    let Ok(mut live) = (deps.read_live_identity)() else { return Ok(unchanged(false)) };
    if live.as_ref().is_some_and(|l| l.email.is_none() && l.account_uuid.is_none()) {
        live = None;
    }
    let mut changed = false;
    match run(deps, live.as_ref(), at, own_change, &mut changed) {
        Ok(r) => Ok(r),
        // accounts.json became unreadable meanwhile: the writes stop here and the next poll starts over.
        Err(StoreError::ReadOnly) => Ok(unchanged(changed)),
        Err(e) => Err(e),
    }
}

fn visible(store: &AccountsStore) -> Vec<ManagedAccount> {
    store.list().into_iter().filter(|r| custody_of(r.custody) != Custody::Quarantined).collect()
}

fn run(
    deps: &ReconcileDeps<'_>,
    current: Option<&AccountIdentity>,
    at: f64,
    own_change: bool,
    changed: &mut bool,
) -> Result<ReconcileResult, StoreError> {
    let store = deps.store;
    // The record the app already knows as live wins over an older copy of the same account, then any `live` one.
    let named = store.live().and_then(|l| l.record_id);
    let same: Vec<ManagedAccount> = match current {
        Some(c) => visible(store).into_iter().filter(|r| compare_identity(&r.identity, c) == IdentityMatch::Same).collect(),
        None => Vec::new(),
    };
    let mut active: Option<ManagedAccount> = same
        .iter()
        .find(|r| Some(&r.id) == named.as_ref())
        .or_else(|| same.iter().find(|r| custody_of(r.custody) == Custody::Live))
        .or_else(|| same.first())
        .cloned();
    if let (Some(c), None) = (current, &active) {
        // Signed in outside the app: the account becomes a record, so the main card is one account like any other.
        let (id, _) = store.prepare()?;
        store.commit(&ManagedAccount {
            id: id.clone(),
            added_at: at,
            identity: identity_fields(c),
            custody: Some(Custody::Live),
            family: Some(TokenFamily::Live),
            ..Default::default()
        })?;
        store.add_notice(&NewNotice {
            kind: NoticeKind::Adopted,
            at,
            email: c.email.clone(),
            record_id: Some(id.clone()),
            count: None,
        })?;
        active = store.get(&id);
        *changed = true;
    }
    for record in visible(store) {
        if active.as_ref().is_some_and(|a| a.id == record.id) || custody_of(record.custody) != Custody::Live {
            continue;
        }
        // A second record of the live account did not leave the login: it is set aside below, without a false notice. The
        // test is the very one the set-aside loop uses (against the holder), so a record is always either set aside or marked.
        if let (Some(a), Some(_)) = (&active, current)
            && compare_identity(&record.identity, &a.identity) == IdentityMatch::Same
        {
            continue;
        }
        // It left the live login. Whoever switched it holds the newest tokens; ours may be consumed, so they are never
        // renewed. An own change keeps an adopted copy the app's own when cswap wrote no copy of it while it was main.
        let keep_own = own_change
            && record.app_swap.as_ref().is_some_and(|s| s.own)
            && record.held_tokens.is_none()
            && deps.cswap_wrote_since.is_some_and(|f| {
                let since = record.app_swap.as_ref().map_or(0.0, |s| s.at);
                !f(&record.identity, since).unwrap_or(true)
            });
        let dead = !own_change && deps.saved_copy_dead.is_some_and(|f| f(&record).unwrap_or(false));
        store.set_custody(&record.id, if own_change { Custody::App } else { Custody::Foreign }, None)?;
        store.set_family(&record.id, if keep_own { TokenFamily::Own } else { TokenFamily::Live })?;
        store.set_app_swap(&record.id, None)?;
        // 1.0.10: an outside switch gets no banner. A sign-out with nobody signed in afterwards is still told, unless that
        // login was dead anyway.
        if !own_change && current.is_none() && !dead {
            store.add_notice(&email_notice(NoticeKind::LoggedOut, at, &record))?;
        }
        *changed = true;
    }
    if let (Some(holder), Some(c)) = (&active, current) {
        for record in visible(store) {
            if record.id == holder.id || compare_identity(&record.identity, &holder.identity) != IdentityMatch::Same {
                continue;
            }
            store.set_custody(&record.id, Custody::Quarantined, Some(&holder.id))?;
            store.add_notice(&email_notice(NoticeKind::Quarantined, at, &record))?;
            *changed = true;
        }
        // Signed in outside the app's own swap: no proof of what cswap holds of it (the note of an earlier swap is over).
        if custody_of(holder.custody) != Custody::Live {
            store.set_custody(&holder.id, Custody::Live, None)?;
            store.set_app_swap(&holder.id, None)?;
            *changed = true;
        }
        // Its tokens are the live family now: once it leaves the live login it is never renewed by the app while cswap
        // lists it, also when the app itself switched it out.
        if family_of(holder.family) != TokenFamily::Live {
            store.set_family(&holder.id, TokenFamily::Live)?;
            *changed = true;
        }
        let missing = fill_missing_identity(&holder.identity, c);
        if !missing.is_empty() {
            store.update_identity(&holder.id, &missing, false)?;
            *changed = true;
        }
        if let Some(resync) = deps.resync {
            // A failure is not an error here: the next poll tries again.
            let _ = resync(&holder.id, c);
        }
    }
    let next: Option<LiveIdentity> =
        current.map(|c| LiveIdentity { identity: identity_fields(c), record_id: active.as_ref().map(|a| a.id.clone()) });
    if store.live().map(|l| stringify(&l.to_value())) != next.as_ref().map(|l| stringify(&l.to_value())) {
        store.set_live(next.as_ref())?;
        *changed = true;
    }
    Ok(ReconcileResult { active_id: active.map(|a| a.id), changed: *changed })
}

/// What stops any look at the live login (`liveGuard()` plus `loginActive`).
pub struct LiveGuard<'a> {
    pub swap_unresolved: &'a dyn Fn() -> bool,
    pub login_active: &'a dyn Fn() -> bool,
    /// An interrupted activation's journal; `Err` (unknown) counts as pending.
    pub journal_pending: Option<&'a dyn Fn() -> std::io::Result<bool>>,
}

/// `reconcileWhenIdle`: runs `reconcile` holding the swap slot, so it never interleaves with an activation, a recovery or a
/// re-login; skipped (`Ok(false)`) while a swap runs or is unresolved or a login is in progress.
pub fn reconcile_when_idle<E>(
    slot: &SwapSlot,
    guard: &LiveGuard<'_>,
    reconcile: impl FnOnce() -> Result<(), E>,
) -> Result<bool, E> {
    if (guard.swap_unresolved)() || (guard.login_active)() {
        return Ok(false);
    }
    let Some(_held) = slot.try_claim() else { return Ok(false) };
    // An interrupted activation's journal: the live files may be half written, so they are not read until it is recovered.
    if let Some(pending) = guard.journal_pending
        && pending().unwrap_or(true)
    {
        return Ok(false);
    }
    reconcile()?;
    Ok(true)
}

/// The live login could not be backed up (or not proven current); `reason` is the last resync result, `busy`, `failed` or
/// `unread`.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("live login not backed up: {reason}")]
pub struct LiveBackupFailed {
    pub reason: String,
}

/// Options of [`backup_live_before_login`].
pub struct BackupOptions<'a> {
    pub delay: &'a dyn Fn(Duration),
    /// Default 3.
    pub tries: Option<u32>,
    /// Default 1 s.
    pub gap: Option<Duration>,
    pub own_change: bool,
    pub own_change_applied: Option<&'a dyn Fn()>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum LiveSeen {
    Unknown,
    None,
    Present,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Backup {
    None,
    Failed,
    Result(ResyncResult),
}

/// `backupLiveBeforeLogin`: before `claude auth login` replaces the live login (main re-login), reconciles holding the swap
/// slot and resolves only when the live login is backed up into its record (resync `copied` / `unchanged`) or there is
/// nothing to back up (nobody signed in, no refresh token (`missing`), held tokens (`held`), a dead login (`dead`), or no
/// file login at all: no `resync`, macOS Keychain). A live config that cannot be read refuses with `unread`. `settling`,
/// `locked`, `mismatch` and a failed copy are tried again `tries` times. A swap holding the slot, an unresolved swap or a
/// pending activation journal refuse it too; a login in progress does not count here (the login being started is the
/// caller itself). `own_change` goes to the first reconcile that runs only, and `own_change_applied` is called then.
pub fn backup_live_before_login(
    slot: &SwapSlot,
    swap_unresolved: &dyn Fn() -> bool,
    journal_pending: Option<&dyn Fn() -> std::io::Result<bool>>,
    deps: &ReconcileDeps<'_>,
    opts: &BackupOptions<'_>,
) -> Result<(), LiveBackupFailed> {
    let tries = opts.tries.unwrap_or(3).max(1);
    let mut reason = "busy".to_string();
    let own_applied = std::cell::Cell::new(false);
    for attempt in 0..tries {
        if attempt > 0 {
            (opts.delay)(opts.gap.unwrap_or(Duration::from_secs(1)));
        }
        let live_seen = std::cell::Cell::new(LiveSeen::Unknown);
        let backup = std::cell::Cell::new(Backup::None);
        let read = || {
            let identity = (deps.read_live_identity)();
            if let Ok(i) = &identity {
                live_seen.set(if i.as_ref().is_some_and(|i| i.email.is_some() || i.account_uuid.is_some()) {
                    LiveSeen::Present
                } else {
                    LiveSeen::None
                });
            }
            identity
        };
        let seen_backup = &backup;
        let resync_watched = deps.resync.map(|resync| {
            move |id: &str, identity: &AccountIdentity| {
                seen_backup.set(Backup::Failed);
                let r = resync(id, identity);
                if let Ok(r) = &r {
                    seen_backup.set(Backup::Result(*r));
                }
                r
            }
        });
        let watched = ReconcileDeps {
            store: deps.store,
            read_live_identity: &read,
            resync: resync_watched.as_ref().map(|f| f as &ResyncFn<'_>),
            cswap_wrote_since: deps.cswap_wrote_since,
            saved_copy_dead: deps.saved_copy_dead,
            now: deps.now,
        };
        let guard = LiveGuard { swap_unresolved, login_active: &|| false, journal_pending };
        let ran = reconcile_when_idle(slot, &guard, || {
            // The own change applies to the first reconcile that runs only; later tries look at the result of that one.
            let own = opts.own_change && !own_applied.get();
            if own {
                own_applied.set(true);
                if let Some(f) = opts.own_change_applied {
                    f();
                }
            }
            reconcile_live(&watched, own).map(|_| ())
        });
        let ran = match ran {
            Ok(ran) => ran,
            Err(_) => {
                backup.set(Backup::Failed);
                false
            }
        };
        let (live, backup) = (live_seen.get(), backup.get());
        if !ran {
            reason = if backup == Backup::Failed { "failed" } else { "busy" }.to_string();
            continue;
        }
        // `held`: the live tokens are not the record's own; its saved copy stays and nothing is dropped. `dead`: Claude Code
        // cleared the live login (nothing left to back up; the record's copy is marked dead).
        if let Backup::Result(
            ResyncResult::Copied | ResyncResult::Unchanged | ResyncResult::Missing | ResyncResult::Held | ResyncResult::Dead,
        ) = backup
        {
            return Ok(());
        }
        if live == LiveSeen::None && backup == Backup::None {
            return Ok(());
        }
        if deps.resync.is_none() && live == LiveSeen::Present {
            return Ok(());
        }
        reason = match backup {
            Backup::None => "unread".to_string(),
            Backup::Failed => "failed".to_string(),
            Backup::Result(r) => r.as_str().to_string(),
        };
    }
    Err(LiveBackupFailed { reason })
}

/// `resyncOutgoingWhenIdle`: while a main Claude login runs, the polls do not reconcile, but the outgoing live login is still
/// backed up into its record. Holds the swap slot; `None` while a swap runs or is unresolved, a journal is pending,
/// accounts.json is read-only or there is nothing to resync.
pub fn resync_outgoing_when_idle(
    slot: &SwapSlot,
    swap_unresolved: &dyn Fn() -> bool,
    journal_pending: Option<&dyn Fn() -> std::io::Result<bool>>,
    deps: &ReconcileDeps<'_>,
) -> Result<Option<ResyncResult>, ResyncError> {
    let store = deps.store;
    let Some(resync) = deps.resync else { return Ok(None) };
    if store.read_only() {
        return Ok(None);
    }
    let mut result = None;
    let guard = LiveGuard { swap_unresolved, login_active: &|| false, journal_pending };
    reconcile_when_idle(slot, &guard, || -> Result<(), ResyncError> {
        let Some(live) = store.live() else { return Ok(()) };
        let Some(record) = live.record_id.as_deref().and_then(|id| store.get(id)) else { return Ok(()) };
        if custody_of(record.custody) == Custody::Quarantined {
            return Ok(());
        }
        result = Some(resync(&record.id, &identity_fields(&live.identity))?);
        Ok(())
    })?;
    Ok(result)
}

#[cfg(test)]
mod tests;
