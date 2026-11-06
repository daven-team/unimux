//! Electron safeStorage (Chromium OSCrypt v10) read and write (SP2, B2).
//!
//! unimux 1.1.x stored SSH passwords and key passphrases (`ssh/vault.json`), database passwords (`db/vault.json`) and the
//! GitHub token (`github/token.json`) as base64 `safeStorage.encryptString` blobs. 1.2.0 reads them in place and writes new
//! ones in the same format, so 1.1.4 started on the same data dir (downgrade) still decrypts everything (SP2 spike, see
//! docs/tauri/spikes/SP2.md):
//!
//! - Windows: AES-256-GCM, key = DPAPI(`Local State` `os_crypt.encrypted_key`). `Local State` is never rewritten; it is only
//!   created, in Chromium's shape, when it does not exist (fresh install).
//! - macOS: AES-128-CBC, key = PBKDF2-HMAC-SHA1(Keychain password of `<app> Safe Storage` / `<app> Key`). Mac half not
//!   verified on a real Mac yet.
//! - Anything else, or `force_unavailable` (MC_SSH_NO_SAFESTORAGE): unavailable, like 1.1.x.
//!
//! The SP2 spike version: B2 adds the IPC side, `MC_SSH_NO_SAFESTORAGE` through DevOverrides and the callers.

use std::path::Path;

use zeroize::Zeroizing;

#[cfg(windows)]
pub mod dpapi;
#[cfg(target_os = "macos")]
pub mod keychain;
pub mod local_state;
pub mod v10;

pub use v10::BlobError;

/// The label 1.1.x shows (`Cipher.storage` in src/main/ssh/vault.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Storage {
    Dpapi,
    Keychain,
    Unavailable,
}

impl Storage {
    pub fn as_str(self) -> &'static str {
        match self {
            Storage::Dpapi => "dpapi",
            Storage::Keychain => "keychain",
            Storage::Unavailable => "unavailable",
        }
    }
}

/// How the key was found when the cipher was opened (for startup.log; never contains key material).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    /// Read from an existing `Local State` (Electron's, or one we created earlier) or the Keychain.
    Existing,
    /// `Local State` did not exist: a new key was created and written in Chromium's format.
    Created,
    /// Forced off (MC_SSH_NO_SAFESTORAGE) or a platform without safeStorage support in unimux.
    Off,
    /// The key could not be read; nothing was written. The text is for the log.
    Failed(String),
    /// Built from a known key (tests and tools).
    Given,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("safeStorage is not available")]
    Unavailable,
    #[error("the blob does not decrypt: {0}")]
    Blob(#[from] BlobError),
    #[error("no random bytes: {0}")]
    Random(String),
}

enum Key {
    None,
    /// Windows: the 32-byte AES-256-GCM key.
    Gcm(Zeroizing<[u8; v10::GCM_KEY_LEN]>),
    /// macOS: the 16-byte AES-128-CBC key.
    Cbc(Zeroizing<[u8; v10::MAC_KEY_LEN]>),
}

/// The safeStorage replacement. The key never leaves this type.
pub struct Cipher {
    key: Key,
    origin: Origin,
}

impl std::fmt::Debug for Cipher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Cipher").field("storage", &self.storage()).field("origin", &self.origin).finish()
    }
}

impl Cipher {
    pub fn unavailable(origin: Origin) -> Self {
        Cipher { key: Key::None, origin }
    }

    /// Opens the OS key the way Electron's safeStorage does for an app whose `userData` is `data_dir` and whose name is
    /// `app_name` (macOS Keychain entry). On Windows a missing `Local State` is created (the data dir must exist).
    pub fn open(data_dir: &Path, app_name: &str, force_unavailable: bool) -> Self {
        if force_unavailable {
            return Self::unavailable(Origin::Off);
        }
        Self::open_platform(data_dir, app_name)
    }

    #[cfg(windows)]
    fn open_platform(data_dir: &Path, _app_name: &str) -> Self {
        match windows_key(data_dir) {
            Ok((key, origin)) => Cipher { key: Key::Gcm(key), origin },
            Err(reason) => Self::unavailable(Origin::Failed(reason)),
        }
    }

    #[cfg(target_os = "macos")]
    fn open_platform(_data_dir: &Path, app_name: &str) -> Self {
        match keychain::password(app_name) {
            Some(password) => Cipher { key: Key::Cbc(v10::mac_key(&password)), origin: Origin::Existing },
            None => Self::unavailable(Origin::Failed("the Keychain refused the safe storage password".into())),
        }
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    fn open_platform(_data_dir: &Path, _app_name: &str) -> Self {
        Self::unavailable(Origin::Off)
    }

    /// A Windows-format cipher with a known key (fixture tests on every platform, the SP2 tool).
    pub fn with_gcm_key(key: [u8; v10::GCM_KEY_LEN]) -> Self {
        Cipher { key: Key::Gcm(Zeroizing::new(key)), origin: Origin::Given }
    }

    /// A macOS-format cipher with a known Keychain password.
    pub fn with_mac_password(password: &[u8]) -> Self {
        Cipher { key: Key::Cbc(v10::mac_key(password)), origin: Origin::Given }
    }

    pub fn origin(&self) -> &Origin {
        &self.origin
    }

    pub fn storage(&self) -> Storage {
        match self.key {
            Key::None => Storage::Unavailable,
            Key::Gcm(_) => Storage::Dpapi,
            Key::Cbc(_) => Storage::Keychain,
        }
    }

    pub fn available(&self) -> bool {
        !matches!(self.key, Key::None)
    }

    /// `safeStorage.encryptString(text)`.
    pub fn encrypt(&self, text: &str) -> Result<Vec<u8>, Error> {
        match &self.key {
            Key::None => Err(Error::Unavailable),
            Key::Gcm(key) => {
                let mut nonce = [0u8; v10::GCM_NONCE_LEN];
                getrandom::fill(&mut nonce).map_err(|e| Error::Random(e.to_string()))?;
                Ok(v10::gcm_encrypt(key, &nonce, text.as_bytes()))
            }
            Key::Cbc(key) => Ok(v10::cbc_encrypt(key, text.as_bytes())),
        }
    }

    /// `safeStorage.decryptString(blob)` of Electron 45.2.2 (shell/browser/api/electron_api_safe_storage.cc): an empty
    /// buffer gives "", a blob without `v10` is refused before OSCrypt sees it (so Chromium's legacy paths, plain DPAPI
    /// blobs on Windows and unencrypted text on macOS, are not reachable from safeStorage and not supported here either).
    /// Invalid UTF-8 becomes U+FFFD (V8's conversion of the std::string).
    pub fn decrypt(&self, blob: &[u8]) -> Result<Zeroizing<String>, Error> {
        let plain = match &self.key {
            Key::None => return Err(Error::Unavailable),
            _ if blob.is_empty() => return Ok(Zeroizing::new(String::new())),
            Key::Gcm(key) => v10::gcm_decrypt(key, blob)?,
            Key::Cbc(key) => v10::cbc_decrypt(key, blob)?,
        };
        Ok(Zeroizing::new(String::from_utf8_lossy(&plain).into_owned()))
    }
}

/// The key of `data_dir/Local State`, creating the file only when it does not exist.
#[cfg(windows)]
fn windows_key(data_dir: &Path) -> Result<(Zeroizing<[u8; v10::GCM_KEY_LEN]>, Origin), String> {
    use local_state::KeyEntry;
    let path = local_state::path(data_dir);
    for _ in 0..2 {
        match std::fs::read(&path) {
            Ok(text) => {
                return match local_state::parse(&text) {
                    KeyEntry::Dpapi(blob) => unwrap_key(&blob).map(|k| (k, Origin::Existing)),
                    KeyEntry::Missing => Err("Local State has no os_crypt.encrypted_key".into()),
                    KeyEntry::Invalid => Err("Local State is not readable JSON with a DPAPI key".into()),
                };
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let mut key = Zeroizing::new([0u8; v10::GCM_KEY_LEN]);
                getrandom::fill(key.as_mut()).map_err(|e| format!("no random bytes: {e}"))?;
                let sealed = dpapi::protect(key.as_ref()).map_err(|e| format!("CryptProtectData failed: {e}"))?;
                match local_state::create_new(data_dir, &local_state::fresh_text(&sealed)) {
                    Ok(true) => return Ok((key, Origin::Created)),
                    // Someone (Electron) created it meanwhile: read theirs.
                    Ok(false) => continue,
                    Err(e) => return Err(format!("Local State not created: {e}")),
                }
            }
            Err(e) => return Err(format!("Local State not readable: {e}")),
        }
    }
    Err("Local State changed while it was read".into())
}

#[cfg(windows)]
fn unwrap_key(blob: &[u8]) -> Result<Zeroizing<[u8; v10::GCM_KEY_LEN]>, String> {
    let plain = dpapi::unprotect(blob).map_err(|e| format!("CryptUnprotectData failed: {e}"))?;
    let key: [u8; v10::GCM_KEY_LEN] =
        plain.as_slice().try_into().map_err(|_| format!("the DPAPI key has {} bytes, not 32", plain.len()))?;
    Ok(Zeroizing::new(key))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unavailable_refuses_both_ways() {
        let c = Cipher::open(Path::new("."), "unimux", true);
        assert_eq!(c.storage(), Storage::Unavailable);
        assert_eq!(c.origin(), &Origin::Off);
        assert!(!c.available());
        assert_eq!(c.encrypt("x"), Err(Error::Unavailable));
        assert_eq!(c.decrypt(b"v10"), Err(Error::Unavailable));
    }

    #[test]
    fn gcm_cipher_uses_a_fresh_nonce_each_time() {
        let c = Cipher::with_gcm_key([3u8; 32]);
        assert_eq!(c.storage().as_str(), "dpapi");
        let (a, b) = (c.encrypt("secret").unwrap(), c.encrypt("secret").unwrap());
        assert_ne!(a, b);
        assert_eq!(c.decrypt(&a).unwrap().as_str(), "secret");
        assert_eq!(c.decrypt(&b).unwrap().as_str(), "secret");
    }

    #[test]
    fn decrypt_follows_electron_safe_storage() {
        for c in [Cipher::with_mac_password(b"pw"), Cipher::with_gcm_key([5u8; 32])] {
            let blob = c.encrypt("ąę").unwrap();
            assert_eq!(c.decrypt(&blob).unwrap().as_str(), "ąę");
            // Electron: an empty buffer is "", anything without v10 is "Ciphertext does not appear to be encrypted".
            assert_eq!(c.decrypt(b"").unwrap().as_str(), "");
            assert_eq!(c.decrypt(b"plain old text"), Err(Error::Blob(BlobError::NoPrefix)));
            assert_eq!(c.decrypt(b"v11abcdefghijklmnopqrstuvwxyz0123"), Err(Error::Blob(BlobError::NoPrefix)));
            let empty = c.encrypt("").unwrap();
            assert!(v10::has_prefix(&empty));
            assert_eq!(c.decrypt(&empty).unwrap().as_str(), "");
        }
        assert_eq!(Cipher::with_mac_password(b"pw").storage().as_str(), "keychain");
    }

    #[test]
    fn debug_never_shows_the_key() {
        let text = format!("{:?}", Cipher::with_gcm_key([0x41; 32]));
        assert!(!text.contains("65") && !text.contains("AAAA"), "{text}");
    }

    #[cfg(windows)]
    #[test]
    fn windows_creates_local_state_once_and_reads_it_back() {
        let dir = tempfile::tempdir().unwrap();
        let first = Cipher::open(dir.path(), "unimux", false);
        assert_eq!(first.origin(), &Origin::Created);
        let written = std::fs::read(local_state::path(dir.path())).unwrap();
        let blob = first.encrypt("pw").unwrap();
        let second = Cipher::open(dir.path(), "unimux", false);
        assert_eq!(second.origin(), &Origin::Existing);
        assert_eq!(second.decrypt(&blob).unwrap().as_str(), "pw");
        assert_eq!(std::fs::read(local_state::path(dir.path())).unwrap(), written, "never rewritten");
    }

    #[cfg(windows)]
    #[test]
    fn windows_never_touches_a_local_state_without_a_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = local_state::path(dir.path());
        std::fs::write(&path, br#"{"browser":{"enabled_labs_experiments":[]}}"#).unwrap();
        let c = Cipher::open(dir.path(), "unimux", false);
        assert!(!c.available());
        assert!(matches!(c.origin(), Origin::Failed(_)));
        assert_eq!(std::fs::read(&path).unwrap(), br#"{"browser":{"enabled_labs_experiments":[]}}"#);
        std::fs::write(&path, b"{broken").unwrap();
        assert!(!Cipher::open(dir.path(), "unimux", false).available());
        assert_eq!(std::fs::read(&path).unwrap(), b"{broken");
    }
}
