//! The two login files of a saved profile, kept in memory while it is signed in again, so a login that signed in a different
//! account (the browser's current one) can be undone (port of src/main/auth/profileSnapshot.ts). Never logged, never written
//! anywhere else, wiped when dropped.
//!
//! Everything here blocks (the profile lock, Claude Code's locks): run it on a blocking thread.

use std::io;
use std::path::Path;

use zeroize::Zeroize;

use crate::locks::{LockOptions, with_claude_locks};
use crate::refresh::ProfileLocks;
use crate::swapfs::{RealSwapFs, SwapFs, atomic_write};

const CREDENTIALS: &str = ".credentials.json";
const CLAUDE_JSON: &str = ".claude.json";

/// `ProfileSnapshot`: `None` = the file did not exist.
#[derive(Clone, PartialEq, Eq, Default)]
pub struct ProfileSnapshot {
    pub credentials: Option<String>,
    pub claude_json: Option<String>,
}

impl std::fmt::Debug for ProfileSnapshot {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never the contents: they hold the tokens.
        f.debug_struct("ProfileSnapshot")
            .field("credentials", &self.credentials.as_ref().map(|_| "<set>"))
            .field("claude_json", &self.claude_json.as_ref().map(|_| "<set>"))
            .finish()
    }
}

impl Drop for ProfileSnapshot {
    fn drop(&mut self) {
        if let Some(s) = self.credentials.as_mut() {
            s.zeroize();
        }
        if let Some(s) = self.claude_json.as_mut() {
            s.zeroize();
        }
    }
}

/// `readText`: the file's text, `None` when it does not exist; any other error is an error.
fn read_text(path: &Path) -> io::Result<Option<String>> {
    match crate::js::read_text(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// `snapshotProfile`: taken under the profile lock, so it waits for a renewal of this profile in flight and for a restore
/// still queued; the snapshot is never a half-renewed login or the other account's files.
pub fn snapshot_profile(profiles: &ProfileLocks, dir: &Path) -> io::Result<ProfileSnapshot> {
    let _held = profiles.lock(dir);
    Ok(ProfileSnapshot { credentials: read_text(&dir.join(CREDENTIALS))?, claude_json: read_text(&dir.join(CLAUDE_JSON))? })
}

/// `oauthAccountOf`: `JSON.stringify(parsed.oauthAccount)` (absent or null: `None`; unparsable: `None`).
fn oauth_account_of(text: Option<&str>) -> Option<String> {
    let parsed = unimux_core::js_json::parse(text?).ok()?;
    let account = parsed.as_object()?.get("oauthAccount")?;
    if account.is_null() {
        return None;
    }
    serde_json::to_string(account).ok()
}

/// `identityRewritten`: true when the profile's `oauthAccount` exists and differs from the snapshot's. Claude Code writes the
/// login's `oauthAccount` with a fresh `profileFetchedAt`, so even a re-login of the same account changes it.
pub fn identity_rewritten(dir: &Path, snapshot: &ProfileSnapshot) -> io::Result<bool> {
    let now = read_text(&dir.join(CLAUDE_JSON))?;
    let now = oauth_account_of(now.as_deref());
    Ok(now.is_some() && now != oauth_account_of(snapshot.claude_json.as_deref()))
}

/// Why a restore did not happen (the caller tries again).
#[derive(Debug, thiserror::Error)]
pub enum RestoreError {
    #[error("Claude Code's locks: {0}")]
    Lock(#[from] crate::locks::LockError),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// `restoreProfile`: writes the snapshot back under the profile lock and the profile's own Claude Code locks (a Claude Code
/// using this profile never sees half of it). A file the snapshot did not have is deleted.
pub fn restore_profile(profiles: &ProfileLocks, dir: &Path, snapshot: &ProfileSnapshot) -> Result<(), RestoreError> {
    restore_profile_with(profiles, dir, snapshot, &LockOptions::default(), &RealSwapFs)
}

/// [`restore_profile`] with the lock options and file seam (tests).
pub fn restore_profile_with(
    profiles: &ProfileLocks,
    dir: &Path,
    snapshot: &ProfileSnapshot,
    locks: &LockOptions,
    fs: &dyn SwapFs,
) -> Result<(), RestoreError> {
    let credentials = dir.join(CREDENTIALS);
    let claude_json = dir.join(CLAUDE_JSON);
    let _held = profiles.lock(dir);
    with_claude_locks(&credentials, &claude_json, false, locks, || -> Result<(), RestoreError> {
        for (path, text) in [(&credentials, &snapshot.credentials), (&claude_json, &snapshot.claude_json)] {
            match text {
                None => match fs.rm(path) {
                    Ok(()) => {}
                    Err(e) if crate::swapfs::is_missing(&e) => {}
                    Err(e) => return Err(e.into()),
                },
                Some(text) => atomic_write(&std::thread::sleep, fs, path, text, None).map_err(|e| match e {
                    crate::swapfs::WriteError::Io(e) => RestoreError::Io(e),
                    crate::swapfs::WriteError::Changed => RestoreError::Io(io::Error::other("changed")),
                })?,
            }
        }
        Ok(())
    })?
}
