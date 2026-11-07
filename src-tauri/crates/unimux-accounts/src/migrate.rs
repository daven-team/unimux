//! One-time upgrade of the 0.9.0 accounts.json (port of src/main/accounts/migrate.ts): identities from each profile's
//! `.claude.json`, duplicates set aside (never deleted) and a notice for the panel. Which record is live is decided by
//! [`crate::reconcile::reconcile_live`] on the first poll. Blocking (file reads).

use std::path::Path;

use crate::identity::{
    AccountIdentity, Custody, IdentityMatch, compare_identity, custody_of, fill_missing_identity, identity_fields,
};
use crate::store::{AccountsStore, ManagedAccount, NewNotice, NoticeKind, STORE_VERSION, StoreError};

/// `MigrationDeps`.
pub struct MigrationDeps<'a> {
    pub store: &'a AccountsStore,
    /// Identity in a profile's `.claude.json` (its `oauthAccount`); `Err` = no identity file.
    pub read_profile_identity: &'a dyn Fn(&Path) -> Result<AccountIdentity, ()>,
    /// Identity of the live Claude Code login, `None` when there is none.
    pub read_live_identity: &'a dyn Fn() -> Result<Option<AccountIdentity>, ()>,
    /// Access token expiry of a profile's login (the freshest of duplicates is kept).
    pub read_expiry: &'a dyn Fn(&Path) -> Result<Option<f64>, ()>,
    pub now: &'a dyn Fn() -> f64,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct MigrationReport {
    pub migrated: bool,
    pub filled: usize,
    /// `(id, keptId)`.
    pub quarantined: Vec<(String, String)>,
}

/// `migrateAccounts`. A file that cannot be read safely is never written over: the migration waits for a start that can.
pub fn migrate_accounts(deps: &MigrationDeps<'_>) -> Result<MigrationReport, StoreError> {
    let mut report = MigrationReport::default();
    let store = deps.store;
    if store.read_only() || store.version() >= STORE_VERSION {
        return Ok(report);
    }
    for record in store.list() {
        let found = store
            .dir_of(&record.id)
            .ok()
            .and_then(|dir| (deps.read_profile_identity)(&dir).ok())
            .map(|i| identity_fields(&i))
            .unwrap_or_default();
        // The tokens belong to whoever the profile file names: a label that 0.9.0 rewrote ("Sign in again") follows the
        // file, and the old label's organisation goes with it.
        if compare_identity(&record.identity, &found) == IdentityMatch::Different {
            store.update_identity(&record.id, &found, true)?;
            report.filled += 1;
            continue;
        }
        let patch = fill_missing_identity(&record.identity, &found);
        if !patch.is_empty() {
            store.update_identity(&record.id, &patch, false)?;
            report.filled += 1;
        }
    }
    let live = (deps.read_live_identity)().ok().flatten();
    let mut groups: Vec<Vec<ManagedAccount>> = Vec::new();
    for record in store.list() {
        if custody_of(record.custody) == Custody::Quarantined {
            continue;
        }
        match groups.iter_mut().find(|g| compare_identity(&g[0].identity, &record.identity) == IdentityMatch::Same) {
            Some(g) => g.push(record),
            None => groups.push(vec![record]),
        }
    }
    for group in &groups {
        if group.len() < 2 {
            continue;
        }
        let keep = match &live {
            Some(l) if compare_identity(l, &group[0].identity) == IdentityMatch::Same => oldest(group),
            _ => freshest(group, deps),
        }
        .id
        .clone();
        for record in group {
            if record.id == keep {
                continue;
            }
            store.set_custody(&record.id, Custody::Quarantined, Some(&keep))?;
            store.add_notice(&NewNotice {
                kind: NoticeKind::Quarantined,
                at: (deps.now)(),
                email: record.identity.email.clone(),
                record_id: Some(record.id.clone()),
                count: None,
            })?;
            report.quarantined.push((record.id.clone(), keep.clone()));
        }
    }
    store.mark_migrated()?;
    if report.filled > 0 || !report.quarantined.is_empty() {
        store.add_notice(&NewNotice {
            kind: NoticeKind::Migrated,
            at: (deps.now)(),
            email: None,
            record_id: None,
            count: Some((report.filled + report.quarantined.len()) as f64),
        })?;
    }
    report.migrated = true;
    Ok(report)
}

/// The first by `addedAt` (a stable sort keeps the list order between equal times).
fn oldest(group: &[ManagedAccount]) -> &ManagedAccount {
    let mut best = &group[0];
    for r in group {
        if r.added_at < best.added_at {
            best = r;
        }
    }
    best
}

fn freshest<'g>(group: &'g [ManagedAccount], deps: &MigrationDeps<'_>) -> &'g ManagedAccount {
    let mut best = &group[0];
    let mut best_at = f64::NEG_INFINITY;
    for record in group {
        let at = deps
            .store
            .dir_of(&record.id)
            .ok()
            .and_then(|dir| (deps.read_expiry)(&dir).ok().flatten())
            .unwrap_or(f64::NEG_INFINITY);
        if at > best_at {
            best = record;
            best_at = at;
        }
    }
    best
}

#[cfg(test)]
mod tests;
