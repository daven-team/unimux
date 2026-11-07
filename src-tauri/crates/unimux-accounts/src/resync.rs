//! Keeps the active account's profile dir a current backup of the live login (port of src/main/accounts/resync.ts; cswap's
//! `_resync_rotated_backup`), so an account switched out by another tool is not lost. Read under Claude Code's credential
//! lock (never a half-written switch or refresh) and only when the live identity proves the bytes are this account's. The
//! lock is held for the two reads only; the copy is written after it is released, so Claude Code never waits for our disk
//! writes or for a profile job. A `live` record's copy is never sent to the token endpoint.
//!
//! Blocking (Claude Code's lock waits up to 9 s): run it on a blocking thread.

use std::collections::HashMap;
use std::time::Duration;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::identity::{AccountIdentity, IdentityMatch, TokenFamily, compare_identity, identity_from_oauth_account};
use crate::js;
use crate::locks::{LockError, LockOptions, with_claude_locks};
use crate::refresh::ProfileLocks;
use crate::rules::{is_cleared_login, token_hash};
use crate::store::{AccountsStore, StoreError};
use crate::swapfs::{SwapFs, SwapPaths, WriteError, atomic_write, read_snap, stringify, stringify2, with_key};

/// `ResyncResult`.
/// - `Settling`: the live files changed since the previous look; nothing is copied until they read the same twice in a row.
/// - `Held`: the live tokens are the ones held for this record (`heldTokens`): nothing is copied, its own saved copy stays.
/// - `Dead`: Claude Code cleared this account's live login after a rejected renewal: nothing is copied, and the record's
///   saved copy (the same token family, so dead too) is marked dead (`deadTokens`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ResyncResult {
    Copied,
    Unchanged,
    Mismatch,
    Missing,
    Locked,
    Settling,
    Held,
    Dead,
}

impl ResyncResult {
    pub fn as_str(self) -> &'static str {
        match self {
            ResyncResult::Copied => "copied",
            ResyncResult::Unchanged => "unchanged",
            ResyncResult::Mismatch => "mismatch",
            ResyncResult::Missing => "missing",
            ResyncResult::Locked => "locked",
            ResyncResult::Settling => "settling",
            ResyncResult::Held => "held",
            ResyncResult::Dead => "dead",
        }
    }
}

/// A resync that threw (a read or write error other than a busy lock, or accounts.json turned read-only).
#[derive(Debug, thiserror::Error)]
pub enum ResyncError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("write failed")]
    Write,
}

impl From<WriteError> for ResyncError {
    fn from(e: WriteError) -> Self {
        match e {
            WriteError::Io(e) => ResyncError::Io(e),
            WriteError::Changed => ResyncError::Write,
        }
    }
}

/// Signature of the live files at the previous look, per record (kept by the caller across polls). Only the record looked
/// at last is kept.
pub type Seen = Mutex<HashMap<String, String>>;

/// `ResyncDeps`.
pub struct ResyncDeps<'a> {
    pub paths: &'a SwapPaths,
    pub store: &'a AccountsStore,
    pub fs: &'a dyn SwapFs,
    pub locks: &'a LockOptions,
    pub profiles: &'a ProfileLocks,
    pub delay: &'a dyn Fn(Duration),
    /// Claude Code writes the credentials and `.claude.json` separately (a `/login` can be seen with the new tokens and the
    /// old identity), so new tokens are copied only once the tokens and the identity read the same as last time. A look is
    /// remembered even when the copy then fails, so the next poll with the same files retries the copy at once. `None`:
    /// copied at once (tests of the copy itself).
    pub seen: Option<&'a Seen>,
}

enum Look {
    Result(ResyncResult),
    Live { oauth: Map<String, Value>, account: Option<Value>, sig: String },
}

fn stringify_opt(v: Option<&Value>) -> Option<String> {
    v.map(stringify)
}

/// `resyncActiveBackup(deps, recordId, expected)`.
pub fn resync_active_backup(
    deps: &ResyncDeps<'_>,
    record_id: &str,
    expected: &AccountIdentity,
) -> Result<ResyncResult, ResyncError> {
    let fs = deps.fs;
    // Only the credential lock: cswap's switch and Claude Code's refresh hold it; the config lock is taken by Claude Code on
    // almost every config write and is not needed for a consistent read.
    let looked =
        with_claude_locks(&deps.paths.credentials, &deps.paths.claude_json, true, deps.locks, || -> std::io::Result<Look> {
            let creds = read_snap(fs, &deps.paths.credentials)?;
            let json = read_snap(fs, &deps.paths.claude_json)?;
            let same = |json: &crate::swapfs::Snap| {
                compare_identity(&identity_from_oauth_account(json.data.get("oauthAccount")), expected) == IdentityMatch::Same
            };
            if let (Some(c), Some(j)) = (&creds, &json)
                && is_cleared_login(&c.data)
            {
                return Ok(Look::Result(if same(j) { ResyncResult::Dead } else { ResyncResult::Mismatch }));
            }
            let (Some(creds), Some(json)) = (creds, json) else { return Ok(Look::Result(ResyncResult::Missing)) };
            let Some(oauth) = js::record(creds.data.get("claudeAiOauth")) else { return Ok(Look::Result(ResyncResult::Missing)) };
            if !matches!(oauth.get("refreshToken"), Some(Value::String(t)) if !t.is_empty()) {
                return Ok(Look::Result(ResyncResult::Missing));
            }
            if !same(&json) {
                return Ok(Look::Result(ResyncResult::Mismatch));
            }
            let account = json.data.get("oauthAccount").cloned();
            let mut h = Sha256::new();
            h.update(creds.text.as_bytes());
            h.update(b"|");
            h.update(stringify_opt(account.as_ref()).unwrap_or_default().as_bytes());
            let sig = h.finalize().iter().map(|b| format!("{b:02x}")).collect::<String>();
            Ok(Look::Live { oauth: oauth.clone(), account, sig })
        });
    let look = match looked {
        Ok(Ok(look)) => look,
        Ok(Err(e)) => return Err(e.into()),
        Err(LockError::Timeout(_)) => return Ok(ResyncResult::Locked),
        Err(LockError::Io(e)) => return Err(e.into()),
    };
    let dir = deps.store.dir_of(record_id)?;
    let (oauth, account, sig) = match look {
        Look::Result(ResyncResult::Dead) => {
            // The saved copy is the live family the record kept backing up, so it went with the live login. Tokens held as
            // not the record's own (`heldTokens`) prove nothing about its copy: then nothing is marked.
            let _g = deps.profiles.lock(&dir);
            let own = read_snap(fs, &dir.join(".credentials.json"))?;
            let token = own
                .as_ref()
                .and_then(|s| js::record(s.data.get("claudeAiOauth")))
                .and_then(|o| o.get("refreshToken"))
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let record = deps.store.get(record_id);
            if !token.is_empty() && record.is_some_and(|r| r.held_tokens.is_none()) {
                deps.store.set_dead_tokens(record_id, Some(&token_hash(&token)))?;
            }
            return Ok(ResyncResult::Dead);
        }
        Look::Result(r) => return Ok(r),
        Look::Live { oauth, account, sig } => (oauth, account, sig),
    };
    let previous = deps.seen.map(|seen| {
        let mut seen = seen.lock();
        let previous = seen.get(record_id).cloned();
        seen.retain(|k, _| k == record_id);
        seen.insert(record_id.to_string(), sig.clone());
        previous
    });
    let _g = deps.profiles.lock(&dir);
    let own = read_snap(fs, &dir.join(".credentials.json"))?;
    let own_oauth = own.as_ref().and_then(|s| js::record(s.data.get("claudeAiOauth")));
    let own_json = read_snap(fs, &dir.join(".claude.json"))?;
    let live_refresh = oauth.get("refreshToken");
    let same_tokens = own_oauth.is_some_and(|o| {
        js_strict_eq(o.get("refreshToken"), live_refresh) && js_strict_eq(o.get("accessToken"), oauth.get("accessToken"))
    });
    let same_account =
        own_json.as_ref().is_some_and(|j| stringify_opt(j.data.get("oauthAccount")) == stringify_opt(account.as_ref()));
    if let Some(held) = deps.store.get(record_id).and_then(|r| r.held_tokens) {
        // The hold ends once the live login is a different one (rewritten since) or exactly the record's own saved copy.
        let live_text = live_refresh.and_then(Value::as_str).unwrap_or("");
        let own_is_live = own_oauth.is_some_and(|o| js_strict_eq(o.get("refreshToken"), live_refresh));
        if token_hash(live_text) == held && !own_is_live {
            return Ok(ResyncResult::Held);
        }
        deps.store.set_held_tokens(record_id, None)?;
    }
    if same_tokens && same_account {
        return Ok(ResyncResult::Unchanged);
    }
    // New tokens wait until both live files are stable; an identity-only change (organisation renamed) is copied at once.
    if !same_tokens && previous.is_some_and(|p| p.as_deref() != Some(sig.as_str())) {
        return Ok(ResyncResult::Settling);
    }
    fs.mkdir(&dir)?;
    let empty = Map::new();
    if !same_tokens {
        let base = own.as_ref().map_or(&empty, |s| &s.data);
        let text = stringify(&with_key(base, "claudeAiOauth", Value::Object(oauth.clone())));
        atomic_write(deps.delay, fs, &dir.join(".credentials.json"), &text, None)?;
    }
    if !same_account {
        let base = own_json.as_ref().map_or(&empty, |s| &s.data);
        let value = match &account {
            Some(a) => with_key(base, "oauthAccount", a.clone()),
            None => {
                let mut m = base.clone();
                m.shift_remove("oauthAccount");
                Value::Object(m)
            }
        };
        atomic_write(deps.delay, fs, &dir.join(".claude.json"), &stringify2(&value), None)?;
    }
    if !same_tokens {
        deps.store.set_family(record_id, TokenFamily::Live)?;
        deps.store.set_dead_tokens(record_id, None)?;
    }
    Ok(ResyncResult::Copied)
}

/// `a === b` for JSON values read from a file (strings and numbers compare by value; objects never equal).
fn js_strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(Value::Object(_) | Value::Array(_)), _) | (_, Some(Value::Object(_) | Value::Array(_))) => false,
        (Some(Value::Number(x)), Some(Value::Number(y))) => x.as_f64() == y.as_f64(),
        (Some(x), Some(y)) => x == y,
        _ => false,
    }
}

#[cfg(test)]
mod tests;
