//! The DB vault (port of src/main/db/vault.ts): database passwords by connection id as safeStorage blobs in
//! `<data>/db/vault.json`, next to (never inside) the SSH vault. Same rules as the SSH vault: a newer or unreadable file opens
//! read-only and is never written over; without safeStorage a password lives in memory only for this run (D8). The file is
//! the 1.1.4 format byte for byte (`JSON.stringify(..., null, 1)`), so 1.1.4 reads what 1.2.0 writes and the other way round.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use unimux_core::js_json;
use unimux_oscrypt::{SafeCipher, Storage};
use zeroize::Zeroizing;

use crate::files::{ReadJson, ensure_private_dir, exists, read_json_file, write_private_file};

const VERSION: f64 = 1.0;

#[derive(Clone)]
struct PasswordRecord {
    connection_id: String,
    /// The number as read (or `Date.now()`), kept as JSON so a rewrite gives the same text.
    updated_at: Value,
    secret: Option<String>,
    plain: Option<Zeroizing<String>>,
    locked: bool,
}

/// `DbVaultInfo`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VaultInfo {
    pub storage: Storage,
    pub saved: Vec<String>,
    pub locked: Vec<String>,
    pub read_only: bool,
}

impl VaultInfo {
    pub fn to_json(&self) -> Value {
        json!({ "storage": self.storage.as_str(), "saved": self.saved, "locked": self.locked, "readOnly": self.read_only })
    }
}

/// `password(id)`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Password {
    Ok(Zeroizing<String>),
    None,
    Locked,
}

/// `setPassword`: `{ok: true, ephemeral}` or `{ok: false, error: 'readOnly'}`; a failed write is an error (the TS code throws).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetPassword {
    Saved { ephemeral: bool },
    ReadOnly,
}

struct Inner {
    passwords: Vec<PasswordRecord>,
    newer: bool,
    /// The eager decrypt of a DPAPI vault ran (the TS constructor does it; here it runs once on first use or `warm`).
    decrypted: bool,
}

pub struct DbVault {
    file: PathBuf,
    cipher: Arc<dyn SafeCipher>,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
    inner: Mutex<Inner>,
}

fn utf16_le(s: &str, max: usize) -> bool {
    unimux_core::utf16::len(s) <= max
}

impl DbVault {
    /// Reads the file (no cipher call yet: the key is opened on first use, off the main thread).
    pub fn new(file: impl Into<PathBuf>, cipher: Arc<dyn SafeCipher>) -> Self {
        Self::with_clock(file, cipher, Box::new(unimux_core::time::now_ms))
    }

    pub fn with_clock(file: impl Into<PathBuf>, cipher: Arc<dyn SafeCipher>, now: Box<dyn Fn() -> i64 + Send + Sync>) -> Self {
        let file = file.into();
        let (passwords, newer) = Self::read(&file);
        Self { file, cipher, now, inner: Mutex::new(Inner { passwords, newer, decrypted: false }) }
    }

    fn read(file: &Path) -> (Vec<PasswordRecord>, bool) {
        let v = match read_json_file(file) {
            ReadJson::Ok(v) => v,
            // Missing: empty. Unreadable (still there): read-only. Unparsable: moved aside, so empty and writable.
            _ => return (Vec::new(), exists(file)),
        };
        let Some(obj) = v.as_object() else { return (Vec::new(), true) };
        let raw = match obj.get("passwords") {
            None => Vec::new(),
            Some(Value::Array(items)) => items.clone(),
            Some(_) => return (Vec::new(), true),
        };
        let mut newer = matches!(obj.get("version").and_then(Value::as_f64), Some(n) if n > VERSION);
        let mut passwords = Vec::new();
        for r in &raw {
            let Some(r) = r.as_object() else { continue };
            let id = r.get("connectionId").and_then(Value::as_str).filter(|s| utf16_le(s, 64) && !s.is_empty());
            let secret = r.get("secret").and_then(Value::as_str).filter(|s| utf16_le(s, 40_000) && !s.is_empty());
            if let (Some(id), Some(secret)) = (id, secret) {
                let updated_at = match r.get("updatedAt") {
                    Some(n @ Value::Number(_)) => n.clone(),
                    _ => json!(0),
                };
                passwords.push(PasswordRecord {
                    connection_id: id.to_string(),
                    updated_at,
                    secret: Some(secret.to_string()),
                    plain: None,
                    locked: false,
                });
            }
        }
        // An entry this version cannot read would be dropped by the next write: open read-only instead.
        if passwords.len() != raw.len() {
            newer = true;
        }
        (passwords, newer)
    }

    /// The eager decrypt of the TS constructor (DPAPI only): every password is tried once, so `info().locked` is right from
    /// the start. Runs on first use; the app also calls it on a background thread at start.
    pub fn warm(&self) {
        // Asking which storage is in use opens the macOS Keychain, whose prompt would hold this lock (and every state change
        // that prunes the vault) until it is answered. Only a DPAPI vault has anything to decrypt early.
        if !cfg!(windows) {
            return;
        }
        let mut inner = self.inner.lock();
        self.ensure_decrypted(&mut inner);
    }

    fn ensure_decrypted(&self, inner: &mut Inner) {
        if inner.decrypted {
            return;
        }
        inner.decrypted = true;
        if self.cipher.storage() == Storage::Dpapi {
            let ids: Vec<String> = inner.passwords.iter().map(|p| p.connection_id.clone()).collect();
            for id in ids {
                let _ = Self::password_in(&*self.cipher, inner, &id);
            }
        }
    }

    pub fn read_only(&self) -> bool {
        self.inner.lock().newer
    }

    pub fn info(&self) -> VaultInfo {
        let mut inner = self.inner.lock();
        self.ensure_decrypted(&mut inner);
        VaultInfo {
            storage: self.cipher.storage(),
            saved: inner.passwords.iter().map(|p| p.connection_id.clone()).collect(),
            locked: inner.passwords.iter().filter(|p| p.locked).map(|p| p.connection_id.clone()).collect(),
            read_only: inner.newer,
        }
    }

    pub fn has(&self, connection_id: &str) -> bool {
        self.inner.lock().passwords.iter().any(|p| p.connection_id == connection_id)
    }

    pub fn set_password(&self, connection_id: &str, password: &str) -> std::io::Result<SetPassword> {
        let mut inner = self.inner.lock();
        self.ensure_decrypted(&mut inner);
        if inner.newer {
            return Ok(SetPassword::ReadOnly);
        }
        let secret = if self.cipher.available() {
            Some(self.cipher.encrypt_base64(password).map_err(|e| std::io::Error::other(e.to_string()))?)
        } else {
            None
        };
        let ephemeral = secret.is_none();
        let record = PasswordRecord {
            connection_id: connection_id.to_string(),
            updated_at: json!((self.now)()),
            plain: if ephemeral { Some(Zeroizing::new(password.to_string())) } else { None },
            secret,
            locked: false,
        };
        let mut next: Vec<PasswordRecord> =
            inner.passwords.iter().filter(|p| p.connection_id != connection_id).cloned().collect();
        next.push(record);
        self.write(&inner, &next)?;
        inner.passwords = next;
        Ok(SetPassword::Saved { ephemeral })
    }

    pub fn clear_password(&self, connection_id: &str) -> std::io::Result<bool> {
        let mut inner = self.inner.lock();
        if inner.newer {
            return Ok(false);
        }
        let next: Vec<PasswordRecord> = inner.passwords.iter().filter(|p| p.connection_id != connection_id).cloned().collect();
        if next.len() == inner.passwords.len() {
            return Ok(false);
        }
        self.write(&inner, &next)?;
        inner.passwords = next;
        Ok(true)
    }

    pub fn password(&self, connection_id: &str) -> Password {
        let mut inner = self.inner.lock();
        Self::password_in(&*self.cipher, &mut inner, connection_id)
    }

    fn password_in(cipher: &dyn SafeCipher, inner: &mut Inner, connection_id: &str) -> Password {
        let Some(p) = inner.passwords.iter_mut().find(|x| x.connection_id == connection_id) else { return Password::None };
        if let Some(plain) = &p.plain {
            return Password::Ok(plain.clone());
        }
        let text = p.secret.as_deref().and_then(|s| cipher.decrypt_base64(s).ok());
        match text {
            Some(text) => {
                p.locked = false;
                Password::Ok(text)
            }
            None => {
                p.locked = true;
                Password::Locked
            }
        }
    }

    /// A duplicated connection gets the original's password (a copy of the sealed blob).
    pub fn copy_password(&self, from: &str, to: &str) -> std::io::Result<bool> {
        let mut inner = self.inner.lock();
        if inner.newer {
            return Ok(false);
        }
        let Some(p) = inner.passwords.iter().find(|x| x.connection_id == from).cloned() else { return Ok(false) };
        let mut next: Vec<PasswordRecord> = inner.passwords.iter().filter(|x| x.connection_id != to).cloned().collect();
        next.push(PasswordRecord { connection_id: to.to_string(), updated_at: json!((self.now)()), ..p });
        self.write(&inner, &next)?;
        inner.passwords = next;
        Ok(true)
    }

    /// After every state change: passwords of connections that no longer exist are deleted.
    pub fn prune(&self, connection_ids: &dyn Fn(&str) -> bool) -> std::io::Result<bool> {
        let mut inner = self.inner.lock();
        if inner.newer {
            return Ok(false);
        }
        let next: Vec<PasswordRecord> = inner.passwords.iter().filter(|p| connection_ids(&p.connection_id)).cloned().collect();
        if next.len() == inner.passwords.len() {
            return Ok(false);
        }
        self.write(&inner, &next)?;
        inner.passwords = next;
        Ok(true)
    }

    fn write(&self, inner: &Inner, all: &[PasswordRecord]) -> std::io::Result<()> {
        if inner.newer {
            return Ok(());
        }
        let passwords: Vec<&PasswordRecord> = all.iter().filter(|p| p.secret.is_some()).collect();
        // Memory-only: nothing touches the disk (D8).
        if passwords.is_empty() && !exists(&self.file) {
            return Ok(());
        }
        if let Some(dir) = self.file.parent() {
            ensure_private_dir(dir)?;
        }
        let list: Vec<Value> = passwords
            .iter()
            .map(|p| {
                let mut m = Map::new();
                m.insert("connectionId".into(), json!(p.connection_id));
                m.insert("updatedAt".into(), p.updated_at.clone());
                m.insert("secret".into(), json!(p.secret));
                Value::Object(m)
            })
            .collect();
        let mut file = Map::new();
        file.insert("version".into(), json!(1));
        file.insert("passwords".into(), Value::Array(list));
        write_private_file(&self.file, &js_json::stringify_pretty(&Value::Object(file), 1))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::fs;
    use unimux_oscrypt::Error;

    pub const A: &str = "00000000-0000-4000-8000-00000000000a";
    const B: &str = "00000000-0000-4000-8000-00000000000b";

    /// `fakeCipher` of test/helpers/sshKeys.ts: `enc:<hex>` blobs, optionally unavailable or unable to decrypt.
    pub struct FakeCipher {
        pub available: bool,
        pub broken: bool,
    }

    impl Default for FakeCipher {
        fn default() -> Self {
            Self { available: true, broken: false }
        }
    }

    impl SafeCipher for FakeCipher {
        fn storage(&self) -> Storage {
            if self.available { Storage::Dpapi } else { Storage::Unavailable }
        }
        fn available(&self) -> bool {
            self.available
        }
        fn encrypt(&self, text: &str) -> Result<Vec<u8>, Error> {
            let hex: String = text.bytes().map(|b| format!("{b:02x}")).collect();
            Ok(format!("enc:{hex}").into_bytes())
        }
        fn decrypt(&self, blob: &[u8]) -> Result<Zeroizing<String>, Error> {
            let s = String::from_utf8_lossy(blob);
            let Some(hex) = s.strip_prefix("enc:").filter(|_| !self.broken) else {
                return Err(Error::Blob(unimux_oscrypt::BlobError::BadKey));
            };
            let bytes: Vec<u8> = (0..hex.len() / 2).map(|i| u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap()).collect();
            Ok(Zeroizing::new(String::from_utf8_lossy(&bytes).into_owned()))
        }
    }

    pub fn fake() -> Arc<dyn SafeCipher> {
        Arc::new(FakeCipher::default())
    }

    fn file(dir: &tempfile::TempDir) -> PathBuf {
        dir.path().join("db").join("vault.json")
    }

    fn ok(text: &str) -> Password {
        Password::Ok(Zeroizing::new(text.to_string()))
    }

    #[test]
    fn stores_passwords_sealed_never_in_plain_text_or_base64_and_reads_them_back() {
        let dir = tempfile::tempdir().unwrap();
        let vault = DbVault::with_clock(file(&dir), fake(), Box::new(|| 5));
        assert_eq!(vault.set_password(A, "p@ss-word-1").unwrap(), SetPassword::Saved { ephemeral: false });
        let raw = fs::read_to_string(file(&dir)).unwrap();
        assert!(!raw.contains("p@ss-word-1"));
        use base64::Engine;
        assert!(!raw.contains(&base64::engine::general_purpose::STANDARD.encode("p@ss-word-1")));
        let again = DbVault::new(file(&dir), fake());
        assert_eq!(again.password(A), ok("p@ss-word-1"));
        assert_eq!(again.info(), VaultInfo { storage: Storage::Dpapi, saved: vec![A.into()], locked: vec![], read_only: false });
        assert_eq!(again.password(B), Password::None);
    }

    #[test]
    fn copies_clears_and_prunes_passwords() {
        let dir = tempfile::tempdir().unwrap();
        let vault = DbVault::new(file(&dir), fake());
        vault.set_password(A, "one").unwrap();
        assert!(vault.copy_password(A, B).unwrap());
        assert_eq!(vault.password(B), ok("one"));
        assert!(vault.clear_password(A).unwrap());
        assert!(!vault.clear_password(A).unwrap());
        assert!(vault.prune(&|id| id == A).unwrap());
        assert!(DbVault::new(file(&dir), fake()).info().saved.is_empty());
    }

    #[test]
    fn keeps_passwords_in_memory_only_without_encryption_d8_and_marks_undecryptable_ones_locked() {
        let dir = tempfile::tempdir().unwrap();
        let memory = DbVault::new(file(&dir), Arc::new(FakeCipher { available: false, broken: false }));
        assert_eq!(memory.set_password(A, "x").unwrap(), SetPassword::Saved { ephemeral: true });
        assert_eq!(memory.password(A), ok("x"));
        assert!(!file(&dir).exists());
        DbVault::new(file(&dir), fake()).set_password(A, "y").unwrap();
        let broken = DbVault::new(file(&dir), Arc::new(FakeCipher { available: true, broken: true }));
        assert_eq!(broken.password(A), Password::Locked);
        assert_eq!(broken.info().locked, vec![A.to_string()]);
    }

    #[test]
    fn opens_a_newer_or_damaged_file_read_only_and_never_writes_over_it() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("db")).unwrap();
        fs::write(file(&dir), r#"{"version":9,"passwords":[]}"#).unwrap();
        let newer = DbVault::new(file(&dir), fake());
        assert!(newer.read_only());
        assert_eq!(newer.set_password(A, "x").unwrap(), SetPassword::ReadOnly);
        let v: Value = serde_json::from_str(&fs::read_to_string(file(&dir)).unwrap()).unwrap();
        assert_eq!(v["version"], 9);
        fs::write(file(&dir), format!(r#"{{"version":1,"passwords":[{{"connectionId":"{A}"}}]}}"#)).unwrap();
        assert!(DbVault::new(file(&dir), fake()).read_only());
        fs::write(file(&dir), "{ not json").unwrap();
        let fresh = DbVault::new(file(&dir), fake());
        // The unparsable file was kept as a backup.
        assert!(!fresh.read_only());
    }

    #[test]
    fn the_file_is_written_like_json_stringify_with_one_space() {
        let dir = tempfile::tempdir().unwrap();
        let vault = DbVault::with_clock(file(&dir), fake(), Box::new(|| 1_793_974_277_195));
        vault.set_password(A, "ab").unwrap();
        assert_eq!(
            fs::read_to_string(file(&dir)).unwrap(),
            format!(
                "{{\n \"version\": 1,\n \"passwords\": [\n  {{\n   \"connectionId\": \"{A}\",\n   \"updatedAt\": 1793974277195,\n   \"secret\": \"ZW5jOjYxNjI=\"\n  }}\n ]\n}}"
            )
        );
    }
}
