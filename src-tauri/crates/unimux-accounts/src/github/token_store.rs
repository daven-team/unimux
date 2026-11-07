//! The GitHub token unimux got from the device flow (`<data>/github/token.json`; port of src/main/github/tokenStore.ts): a
//! safeStorage blob (B2), never in clear on the disk, never logged, never sent to the renderer. Without safeStorage the token
//! lives in memory until the app quits. A newer or unreadable file is left alone (read-only) instead of being written over.
//!
//! The file is what 1.1.4 writes: `JSON.stringify({ version: 1, login, savedAt, secret }, null, 1)` (1-space indent, no trailing
//! newline) through an atomic write, mode 0600 in a 0700 `github/` on POSIX. Reading follows ssh/files.ts readJsonFile: an
//! unparsable file is moved to `token.json.bak-<ISO>` (and the store stays writable), an unreadable one makes it read-only.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Map, Value};
use unimux_core::atomic_write::{AtomicWriteOptions, atomic_write};
use unimux_core::{js_json, json_file};
use unimux_oscrypt::{SafeCipher, Storage};
use zeroize::Zeroizing;

use super::is_token_text;
use crate::js;

const VERSION: f64 = 1.0;

/// `Date.now()` of the store (tests pin it).
pub type Clock = Box<dyn Fn() -> i64 + Send + Sync>;

#[derive(Default)]
struct Inner {
    /// The base64 blob of the file (or of the last save).
    secret: Option<String>,
    /// The decrypted token (once per run) or the token set without safeStorage.
    plain: Option<Zeroizing<String>>,
    user: Option<String>,
    read_only: bool,
}

pub struct GithubTokenStore {
    file: PathBuf,
    cipher: Arc<dyn SafeCipher>,
    now: Clock,
    inner: Mutex<Inner>,
}

impl std::fmt::Debug for GithubTokenStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let inner = self.inner.lock();
        f.debug_struct("GithubTokenStore")
            .field("file", &self.file)
            .field("has", &(inner.plain.is_some() || inner.secret.is_some()))
            .field("read_only", &inner.read_only)
            .finish_non_exhaustive()
    }
}

/// `readJsonFile`: Ok(value), or Err(missing).
fn read_json_file(file: &Path) -> Result<Value, bool> {
    if !file.exists() {
        return Err(true);
    }
    let Ok(bytes) = fs::read(file) else { return Err(false) };
    // readFileSync(file, 'utf8'): invalid sequences become U+FFFD; a BOM stays (and JSON.parse refuses it).
    let text = String::from_utf8_lossy(&bytes);
    match js_json::parse(&text) {
        Ok(value) => Ok(value),
        Err(_) => {
            let _ = fs::rename(file, json_file::backup_path(file));
            Err(false)
        }
    }
}

/// `ensurePrivateDir`.
fn ensure_private_dir(dir: &Path) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
        Ok(())
    }
    #[cfg(not(unix))]
    {
        fs::create_dir_all(dir)
    }
}

/// `writePrivateFile`.
fn write_private_file(file: &Path, text: &str) -> std::io::Result<()> {
    atomic_write(file, text.as_bytes(), &AtomicWriteOptions { mode: Some(0o600), ..AtomicWriteOptions::default() })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(file, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

impl GithubTokenStore {
    /// Reads `file` now (1.1.4 builds the store at start: an unparsable file is moved aside then).
    pub fn new(file: impl Into<PathBuf>, cipher: Arc<dyn SafeCipher>) -> Self {
        Self::with_clock(file, cipher, Box::new(unimux_core::time::now_ms))
    }

    pub fn with_clock(file: impl Into<PathBuf>, cipher: Arc<dyn SafeCipher>, now: Clock) -> Self {
        let file = file.into();
        let mut inner = Inner::default();
        match read_json_file(&file) {
            Err(_) => inner.read_only = file.exists(),
            // `!value || typeof value !== 'object'`: null and every primitive; an array is an object (and has no fields).
            Ok(Value::Object(map)) => {
                if map.get("version").and_then(Value::as_f64).is_some_and(|v| v > VERSION) {
                    inner.read_only = true;
                } else {
                    if let Some(s) = map.get("secret").and_then(Value::as_str).filter(|s| js::len16(s) <= 20_000) {
                        inner.secret = Some(s.to_string());
                    }
                    if let Some(l) = map.get("login").and_then(Value::as_str).filter(|l| js::len16(l) <= 100) {
                        inner.user = Some(l.to_string());
                    }
                }
            }
            Ok(Value::Array(_)) => {}
            Ok(_) => inner.read_only = true,
        }
        Self { file, cipher, now, inner: Mutex::new(inner) }
    }

    /// `storage`: where a token from the device flow is kept (`dpapi`, `keychain`, `unavailable`).
    pub fn storage(&self) -> Storage {
        self.cipher.storage()
    }

    pub fn has(&self) -> bool {
        let inner = self.inner.lock();
        inner.plain.is_some() || inner.secret.is_some()
    }

    /// The saved GitHub user name (while a token is kept).
    pub fn login(&self) -> Option<String> {
        let inner = self.inner.lock();
        if inner.plain.is_some() || inner.secret.is_some() { inner.user.clone() } else { None }
    }

    /// Read-only: a newer or unreadable file (it is never written over or removed).
    pub fn read_only(&self) -> bool {
        self.inner.lock().read_only
    }

    /// The token, or None (none, or the system cannot decrypt it any more). Decrypted once per run.
    pub fn get(&self) -> Option<String> {
        let mut inner = self.inner.lock();
        if let Some(plain) = &inner.plain {
            return Some(plain.to_string());
        }
        let secret = inner.secret.as_ref()?;
        let text = self.cipher.decrypt_base64(secret).ok()?;
        if !is_token_text(&text) {
            return None;
        }
        let token = text.to_string();
        inner.plain = Some(text);
        Some(token)
    }

    /// Keeps the token (encrypted on disk when the system can, else in memory only). Ok(false) when the token is not token
    /// text or the file is read-only; Err when safeStorage refused to encrypt (1.1.4: `encryptString` threw; the token is
    /// kept in memory for this run).
    pub fn set(&self, token: &str, login: Option<&str>) -> Result<bool, String> {
        if !is_token_text(token) {
            return Ok(false);
        }
        let mut inner = self.inner.lock();
        inner.plain = Some(Zeroizing::new(token.to_string()));
        inner.user = login.map(str::to_string);
        if inner.read_only {
            return Ok(false);
        }
        if !self.cipher.available() {
            inner.secret = None;
            self.remove_file();
            return Ok(true);
        }
        let secret = self.cipher.encrypt_base64(token).map_err(|e| e.to_string())?;
        inner.secret = Some(secret.clone());
        let mut body = Map::new();
        body.insert("version".into(), Value::from(1));
        body.insert("login".into(), login.map_or(Value::Null, |l| Value::String(l.into())));
        body.insert("savedAt".into(), Value::from((self.now)()));
        body.insert("secret".into(), Value::String(secret));
        let text = js_json::stringify_pretty(&Value::Object(body), 1);
        // Not written: the token is kept for this run.
        let _ = self.file.parent().map_or(Ok(()), ensure_private_dir).and_then(|()| write_private_file(&self.file, &text));
        Ok(true)
    }

    /// Forgets the token (memory and disk).
    pub fn clear(&self) {
        let mut inner = self.inner.lock();
        inner.plain = None;
        inner.secret = None;
        inner.user = None;
        if !inner.read_only {
            self.remove_file();
        }
    }

    /// Best effort: the blob is useless without this user's key.
    fn remove_file(&self) {
        if self.file.exists() {
            let _ = fs::remove_file(&self.file);
        }
    }
}
