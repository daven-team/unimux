//! The saved Codex accounts (port of src/main/accounts/codexStore.ts). Each lives in `<root>/profiles/<uuid>` (a CODEX_HOME of
//! its own, holding the auth.json `codex login` wrote there) and is listed in `<root>/accounts.json`, which never holds a token.
//!
//! accounts.json is written as 1.1.4 writes it: `JSON.stringify(normalizeCodexAccounts(file), null, 1)` (1-space indent, no
//! trailing newline), mode 0600 on POSIX. Missing: empty and writable. Unreadable or unparsable: read-only (never moved aside
//! or overwritten).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use parking_lot::Mutex;
use serde_json::Value;
use unimux_core::atomic_write::{AtomicWriteOptions, atomic_write};
use unimux_core::js_json;

use crate::codex::{CodexAccount, CodexAccountsFile, CodexIdentity, CodexLive, is_codex_account_id, normalize_codex_accounts};
use crate::js;

#[derive(Debug, thiserror::Error)]
pub enum CodexStoreError {
    /// `CodexAccountsReadOnlyError`.
    #[error("codex accounts.json is read-only")]
    ReadOnly,
    #[error("invalid account id")]
    InvalidId,
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// Field changes of [`CodexAccountsStore::patch`]: `None` leaves a field; `Some(None)` / `Some(false)` removes it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CodexPatch {
    pub email: Option<Option<String>>,
    pub user_id: Option<Option<String>>,
    pub account_id: Option<Option<String>>,
    pub live_family: Option<bool>,
    pub outdated: Option<bool>,
}

type Stamp = (Option<SystemTime>, u64);

pub type IdSource = Box<dyn Fn() -> String + Send + Sync>;

#[derive(Clone)]
struct Read {
    file: CodexAccountsFile,
    read_only: bool,
}

pub struct CodexAccountsStore {
    root: PathBuf,
    file: PathBuf,
    cached: Mutex<Option<(Stamp, Read)>>,
    writer: Mutex<()>,
    new_id: IdSource,
}

impl std::fmt::Debug for CodexAccountsStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CodexAccountsStore").field("root", &self.root).finish_non_exhaustive()
    }
}

/// The text `change` writes for a file.
pub fn codex_file_text(file: &CodexAccountsFile) -> String {
    js_json::stringify_pretty(&normalize_codex_accounts(&file.to_value()).to_value(), 1)
}

impl CodexAccountsStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self::with_ids(root, Box::new(|| uuid::Uuid::new_v4().to_string()))
    }

    pub fn with_ids(root: impl Into<PathBuf>, new_id: IdSource) -> Self {
        let root = root.into();
        let file = root.join("accounts.json");
        Self { root, file, cached: Mutex::new(None), writer: Mutex::new(()), new_id }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    fn read(&self) -> Read {
        let Ok(info) = fs::metadata(&self.file) else {
            return Read { file: CodexAccountsFile::default(), read_only: false };
        };
        let stamp = (info.modified().ok(), info.len());
        if let Some((cached_stamp, read)) = &*self.cached.lock()
            && *cached_stamp == stamp
        {
            return read.clone();
        }
        let parsed = js::read_text(&self.file).ok().and_then(|text| js_json::parse(&text).ok());
        let read = match parsed {
            // `raw && typeof raw === 'object' && (raw.version === undefined || raw.version === 1)`: arrays pass too.
            Some(raw @ (Value::Object(_) | Value::Array(_))) => {
                let version = raw.as_object().and_then(|m| m.get("version"));
                if version.is_none() || version.and_then(Value::as_f64) == Some(1.0) {
                    Read { file: normalize_codex_accounts(&raw), read_only: false }
                } else {
                    Read { file: CodexAccountsFile::default(), read_only: true }
                }
            }
            Some(_) => Read { file: CodexAccountsFile::default(), read_only: true },
            None => Read { file: CodexAccountsFile::default(), read_only: self.file.exists() },
        };
        *self.cached.lock() = Some((stamp, read.clone()));
        read
    }

    fn change(&self, edit: impl FnOnce(&mut CodexAccountsFile)) -> Result<(), CodexStoreError> {
        let _writer = self.writer.lock();
        let Read { mut file, read_only } = self.read();
        if read_only {
            return Err(CodexStoreError::ReadOnly);
        }
        edit(&mut file);
        fs::create_dir_all(&self.root)?;
        let options = AtomicWriteOptions { mode: Some(0o600), ..AtomicWriteOptions::default() };
        let result = atomic_write(&self.file, codex_file_text(&file).as_bytes(), &options);
        *self.cached.lock() = None;
        result.map_err(Into::into)
    }

    pub fn read_only(&self) -> bool {
        self.read().read_only
    }

    pub fn list(&self) -> Vec<CodexAccount> {
        self.read().file.accounts
    }

    pub fn get(&self, id: &str) -> Option<CodexAccount> {
        self.list().into_iter().find(|a| a.id == id)
    }

    pub fn live(&self) -> Option<CodexLive> {
        self.read().file.live
    }

    pub fn snapshot(&self) -> CodexAccountsFile {
        self.read().file
    }

    pub fn set_live(&self, live: Option<&CodexLive>) -> Result<(), CodexStoreError> {
        self.change(|f| f.live = live.cloned())
    }

    /// `<root>/profiles/<id>`; only account ids (lowercase UUIDs) are accepted.
    pub fn dir_of(&self, id: &str) -> Result<PathBuf, CodexStoreError> {
        if !is_codex_account_id(id) {
            return Err(CodexStoreError::InvalidId);
        }
        Ok(self.root.join("profiles").join(id))
    }

    /// Creates the profile directory of a login in progress (Codex refuses a CODEX_HOME that does not exist); listed only after
    /// [`commit`](Self::commit).
    pub fn prepare(&self) -> Result<(String, PathBuf), CodexStoreError> {
        let id = (self.new_id)();
        let dir = self.dir_of(&id)?;
        fs::create_dir_all(&dir)?;
        Ok((id, dir))
    }

    /// Lists (or replaces) a record; the write drops what does not validate (as `normalizeCodexAccounts` does).
    pub fn commit(&self, account: &CodexAccount) -> Result<(), CodexStoreError> {
        self.change(|f| match f.accounts.iter_mut().find(|e| e.id == account.id) {
            Some(entry) => *entry = account.clone(),
            None => f.accounts.push(account.clone()),
        })
    }

    /// Sets the given fields; an unknown id changes nothing (the file is still written, as in 1.1.4).
    pub fn patch(&self, id: &str, patch: &CodexPatch) -> Result<(), CodexStoreError> {
        self.change(|f| {
            let Some(a) = f.accounts.iter_mut().find(|e| e.id == id) else { return };
            if let Some(v) = &patch.email {
                a.identity.email = v.clone();
            }
            if let Some(v) = &patch.user_id {
                a.identity.user_id = v.clone();
            }
            if let Some(v) = &patch.account_id {
                a.identity.account_id = v.clone();
            }
            if let Some(v) = patch.live_family {
                a.live_family = v;
            }
            if let Some(v) = patch.outdated {
                a.outdated = v;
            }
        })
    }

    /// Takes exactly this identity (an absent field is removed).
    pub fn update_identity(&self, id: &str, identity: &CodexIdentity) -> Result<(), CodexStoreError> {
        self.patch(
            id,
            &CodexPatch {
                email: Some(identity.email.clone()),
                user_id: Some(identity.user_id.clone()),
                account_id: Some(identity.account_id.clone()),
                ..CodexPatch::default()
            },
        )
    }

    /// Forgets the record and deletes its profile directory (the app created it; it is never a link to elsewhere).
    pub fn remove(&self, id: &str) -> Result<(), CodexStoreError> {
        let dir = self.dir_of(id)?;
        if self.get(id).is_some() {
            self.change(|f| {
                f.accounts.retain(|a| a.id != id);
                if let Some(live) = &mut f.live
                    && live.record_id.as_deref() == Some(id)
                {
                    live.record_id = None;
                }
            })?;
        }
        // An orphaned dir is harmless and never listed.
        let _ = fs::remove_dir_all(dir);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::codex::{parse_codex_auth, tests::auth};
    const ID: &str = "11111111-1111-4111-8111-111111111111";
    const ID2: &str = "22222222-2222-4222-8222-222222222222";

    fn account(id: &str, name: &str) -> CodexAccount {
        CodexAccount {
            id: id.into(),
            added_at: 1.0,
            identity: CodexIdentity {
                email: Some(format!("{name}@example.com")),
                user_id: Some(format!("user-{name}")),
                account_id: Some(format!("ws-{name}")),
            },
            ..Default::default()
        }
    }

    #[test]
    fn prepare_commit_list_and_remove() {
        let dir = tempfile::tempdir().unwrap();
        let store = CodexAccountsStore::new(dir.path().join("codex-accounts"));
        let (id, profile) = store.prepare().unwrap();
        assert!(is_codex_account_id(&id));
        assert_eq!(profile, store.root().join("profiles").join(&id));
        assert!(profile.is_dir());
        assert!(store.list().is_empty());
        fs::write(profile.join("auth.json"), auth("bob")).unwrap();
        store.commit(&account(&id, "bob")).unwrap();
        assert_eq!(store.list(), [account(&id, "bob")]);
        let login = parse_codex_auth(Some(&fs::read_to_string(profile.join("auth.json")).unwrap())).unwrap();
        assert_eq!(login.identity, account(&id, "bob").identity);
        store.set_live(Some(&CodexLive { identity: login.identity.clone(), record_id: Some(id.clone()) })).unwrap();
        store.patch(&id, &CodexPatch { outdated: Some(true), ..Default::default() }).unwrap();
        assert!(store.get(&id).unwrap().outdated);
        store.patch(&id, &CodexPatch { outdated: Some(false), ..Default::default() }).unwrap();
        assert!(!store.get(&id).unwrap().outdated);
        store.remove(&id).unwrap();
        assert!(store.list().is_empty());
        assert!(!profile.exists());
        assert_eq!(store.live().unwrap().record_id, None);
        assert!(matches!(store.remove("../x"), Err(CodexStoreError::InvalidId)));
    }

    #[test]
    fn writes_one_space_json_like_1_1_4() {
        let dir = tempfile::tempdir().unwrap();
        let store = CodexAccountsStore::new(dir.path());
        store.commit(&CodexAccount { live_family: true, ..account(ID, "a") }).unwrap();
        // A record that does not validate is dropped by the write; a live record id naming no record too.
        store.commit(&CodexAccount { id: "../x".into(), ..account(ID2, "b") }).unwrap();
        store
            .set_live(Some(&CodexLive {
                identity: CodexIdentity { email: Some("a@example.com".into()), ..Default::default() },
                record_id: Some(ID2.into()),
            }))
            .unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("accounts.json")).unwrap(),
            format!(
                "{{\n \"version\": 1,\n \"accounts\": [\n  {{\n   \"id\": \"{ID}\",\n   \"addedAt\": 1,\n   \"email\": \"a@example.com\",\n   \"userId\": \"user-a\",\n   \"accountId\": \"ws-a\",\n   \"liveFamily\": true\n  }}\n ],\n \"live\": {{\n  \"email\": \"a@example.com\"\n }}\n}}"
            )
        );
    }

    #[test]
    fn an_unparsable_or_newer_file_is_read_only_and_kept() {
        for text in ["{", "null", "5", r#"{"version":2,"accounts":[]}"#, r#"{"version":null}"#] {
            let dir = tempfile::tempdir().unwrap();
            fs::write(dir.path().join("accounts.json"), text).unwrap();
            let store = CodexAccountsStore::new(dir.path());
            assert!(store.read_only(), "{text}");
            assert!(matches!(store.commit(&account(ID, "a")), Err(CodexStoreError::ReadOnly)), "{text}");
            assert_eq!(fs::read_to_string(dir.path().join("accounts.json")).unwrap(), text);
            assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "{text}");
        }
        // An array is an object to `typeof`: read as an empty, writable file (as 1.1.4 does).
        let dir = tempfile::tempdir().unwrap();
        fs::write(dir.path().join("accounts.json"), "[1]").unwrap();
        let store = CodexAccountsStore::new(dir.path());
        assert!(!store.read_only());
        assert!(store.list().is_empty());
    }

    #[test]
    fn a_missing_file_is_empty_and_writable() {
        let dir = tempfile::tempdir().unwrap();
        let store = CodexAccountsStore::new(dir.path().join("nested"));
        assert!(!store.read_only());
        assert_eq!(store.snapshot(), CodexAccountsFile::default());
        store.update_identity(ID, &CodexIdentity::default()).unwrap();
        assert_eq!(
            fs::read_to_string(dir.path().join("nested").join("accounts.json")).unwrap(),
            "{\n \"version\": 1,\n \"accounts\": []\n}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn the_file_is_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let store = CodexAccountsStore::new(dir.path());
        store.commit(&account(ID, "a")).unwrap();
        assert_eq!(fs::metadata(dir.path().join("accounts.json")).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
