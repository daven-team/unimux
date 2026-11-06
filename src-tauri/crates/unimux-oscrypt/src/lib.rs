//! Electron safeStorage (Chromium OSCrypt v10) read and write (SP2, B2).
//!
//! unimux 1.1.x stored SSH passwords and key passphrases (`ssh/vault.json`), database passwords (`db/vault.json`) and the
//! GitHub token (`github/token.json`) as base64 `safeStorage.encryptString` blobs. 1.2.0 reads them in place and writes new
//! ones in the same format, so 1.1.4 started on the same data dir (downgrade) still decrypts everything (SP2 spike, see
//! docs/tauri/spikes/SP2.md):
//!
//! - Windows: AES-256-GCM, key = DPAPI(`Local State` `os_crypt.encrypted_key`). A `Local State` with a usable key is never
//!   rewritten; without one (fresh install, no key, a DPAPI key of another user) a new key is stored the way Chromium's
//!   OSCryptImpl::Init does it on 1.1.4's start (see local_state.rs). Opening is single-flight per process.
//! - macOS: AES-128-CBC, key = PBKDF2-HMAC-SHA1(Keychain password of `<app> Safe Storage` / `<app> Key`). Mac half not
//!   verified on a real Mac yet.
//! - Anything else, or `force_unavailable` (MC_SSH_NO_SAFESTORAGE): unavailable, like 1.1.x.
//!
//! [`SafeStorage`] (B2) is what the app uses: one per process, opened on first use (lazy Keychain access on macOS), behind
//! the [`SafeCipher`] interface of 1.1.x's `Cipher`, with `MC_SSH_NO_SAFESTORAGE` and the `Origin` reported to startup.log.

use std::path::Path;

use zeroize::Zeroizing;

#[cfg(windows)]
pub mod dpapi;
#[cfg(target_os = "macos")]
pub mod keychain;
pub mod local_state;
pub mod node_base64;
pub mod safe_storage;
pub mod v10;

pub use safe_storage::{SafeCipher, SafeStorage};
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

impl serde::Serialize for Storage {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(self.as_str())
    }
}

/// How the key was found when the cipher was opened (for startup.log; never contains key material).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Origin {
    /// Read from an existing `Local State` (Electron's, or one we created earlier) or the Keychain.
    Existing,
    /// No key existed (no `Local State`, or a Keychain without the item): a new key was created and stored.
    Created,
    /// `Local State` had no usable key (no `encrypted_key`, a DPAPI blob that does not unwrap, not JSON): a new key was
    /// stored in it as Chromium does, so secrets encrypted with the old key stay locked. The text is for the log.
    Replaced(String),
    /// macOS: the password was found under the legacy account `<app>` and moved to `<app> Key`.
    Migrated,
    /// Forced off (MC_SSH_NO_SAFESTORAGE) or a platform without safeStorage support in unimux.
    Off,
    /// The key could not be read; nothing was written. The text is for the log.
    Failed(String),
    /// Built from a known key (tests and tools).
    Given,
}

impl Origin {
    /// One word for the startup.log mark (`safe-storage-<label>`).
    pub fn label(&self) -> &'static str {
        match self {
            Origin::Existing => "existing",
            Origin::Created => "created",
            Origin::Replaced(_) => "replaced",
            Origin::Migrated => "migrated",
            Origin::Off => "off",
            Origin::Failed(_) => "failed",
            Origin::Given => "given",
        }
    }

    /// The reason of `Replaced` / `Failed` (no key material), for crash.log.
    pub fn reason(&self) -> Option<&str> {
        match self {
            Origin::Replaced(reason) | Origin::Failed(reason) => Some(reason),
            _ => None,
        }
    }
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
    ///
    /// Calls are serialized within the process: two first opens at the same moment (B2 opens the cipher from several
    /// stores) must not both mint a key, or the secrets of the one whose key is not stored are lost on the next start.
    /// The second caller reads the key the first one stored.
    pub fn open(data_dir: &Path, app_name: &str, force_unavailable: bool) -> Self {
        static OPEN: std::sync::Mutex<()> = std::sync::Mutex::new(());
        if force_unavailable {
            return Self::unavailable(Origin::Off);
        }
        let _single_flight = OPEN.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
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
            Some((password, found)) => {
                let origin = match found {
                    keychain::Found::Existing => Origin::Existing,
                    keychain::Found::Migrated => Origin::Migrated,
                    keychain::Found::Created => Origin::Created,
                };
                Cipher { key: Key::Cbc(v10::mac_key(&password)), origin }
            }
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

#[cfg(windows)]
type GcmKey = Zeroizing<[u8; v10::GCM_KEY_LEN]>;

/// A new random key and its DPAPI blob, wrapped like Chromium wraps it.
#[cfg(windows)]
fn new_windows_key() -> Result<(GcmKey, Vec<u8>), String> {
    let mut key = Zeroizing::new([0u8; v10::GCM_KEY_LEN]);
    getrandom::fill(key.as_mut()).map_err(|e| format!("no random bytes: {e}"))?;
    let sealed = dpapi::protect(key.as_ref()).map_err(|e| format!("CryptProtectData failed: {e}"))?;
    Ok((key, sealed))
}

/// The key of `data_dir/Local State`, following Chromium's OSCryptImpl::Init (see local_state.rs): an existing usable key
/// is read and the file left alone; a missing file is created; a file without a usable key gets a new one.
#[cfg(windows)]
fn windows_key(data_dir: &Path) -> Result<(GcmKey, Origin), String> {
    use local_state::KeyEntry;
    let path = local_state::path(data_dir);
    // Stores a new key in the existing text, keeping every other pref (EncryptAndStoreKey).
    let replace = |text: &[u8], reason: String| -> Result<(GcmKey, Origin), String> {
        let (key, sealed) = new_windows_key()?;
        local_state::replace(data_dir, &local_state::with_key(text, &sealed))
            .map_err(|e| format!("{reason}; a new key was not stored: {e}"))?;
        Ok((key, Origin::Replaced(reason)))
    };
    for _ in 0..3 {
        match std::fs::read(&path) {
            Ok(text) => {
                return match local_state::parse(&text) {
                    // kDecryptionFailed: Chromium stores a new key. A blob that unwraps to the wrong length is left
                    // alone (it is not one of Chromium's documented paths, and the file is not ours to guess about).
                    KeyEntry::Dpapi(blob) => match dpapi::unprotect(&blob) {
                        Ok(plain) => key_of(&plain).map(|key| (key, Origin::Existing)),
                        Err(e) => replace(&text, format!("the DPAPI key in Local State does not unwrap: {e}")),
                    },
                    KeyEntry::Missing => replace(&text, "Local State had no os_crypt.encrypted_key".into()),
                    KeyEntry::NotObject => replace(&text, "Local State was not a JSON object".into()),
                    KeyEntry::Invalid => Err("os_crypt.encrypted_key in Local State is not a DPAPI key".into()),
                    KeyEntry::NotJson => {
                        local_state::set_aside_bad(data_dir)
                            .map_err(|e| format!("Local State is not JSON and was not moved aside: {e}"))?;
                        continue;
                    }
                };
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let (key, sealed) = new_windows_key()?;
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
fn key_of(plain: &[u8]) -> Result<GcmKey, String> {
    let key: [u8; v10::GCM_KEY_LEN] = plain.try_into().map_err(|_| format!("the DPAPI key has {} bytes, not 32", plain.len()))?;
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

    /// Opens `dir` again and checks that the new cipher decrypts `blob` (the key is the one stored in Local State).
    #[cfg(windows)]
    fn stored_key_decrypts(dir: &Path, blob: &[u8]) {
        let later = Cipher::open(dir, "unimux", false);
        assert_eq!(later.origin(), &Origin::Existing);
        assert_eq!(later.decrypt(blob).unwrap().as_str(), "pw");
    }

    #[cfg(windows)]
    fn file_names(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> =
            std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

    /// Chromium kKeyDoesNotExist / kDecryptionFailed: a new key is stored, every other pref kept, storage stays dpapi.
    #[cfg(windows)]
    #[test]
    fn windows_stores_a_new_key_like_chromium_when_the_old_one_is_unusable() {
        use base64::Engine;
        let garbage = base64::engine::general_purpose::STANDARD.encode(b"DPAPI\x01\x00\x00\x00not a dpapi blob");
        let cases = [
            br#"{"browser":{"enabled_labs_experiments":[]}}"#.to_vec(),
            format!(r#"{{"browser":{{"enabled_labs_experiments":[]}},"os_crypt":{{"encrypted_key":"{garbage}"}}}}"#).into_bytes(),
            br#"{"browser":{"enabled_labs_experiments":[]},"os_crypt":{"encrypted_key":"RFBBUEk="}}"#.to_vec(),
        ];
        for original in cases {
            let dir = tempfile::tempdir().unwrap();
            let path = local_state::path(dir.path());
            std::fs::write(&path, &original).unwrap();
            let c = Cipher::open(dir.path(), "unimux", false);
            assert!(matches!(c.origin(), Origin::Replaced(_)), "{:?}", c.origin());
            assert_eq!(c.storage(), Storage::Dpapi);
            let text = std::fs::read(&path).unwrap();
            let value: serde_json::Value = serde_json::from_slice(&text).unwrap();
            assert_eq!(value["browser"], serde_json::json!({ "enabled_labs_experiments": [] }), "other prefs kept");
            assert_eq!(value["os_crypt"]["audit_enabled"], true);
            stored_key_decrypts(dir.path(), &c.encrypt("pw").unwrap());
            assert_eq!(file_names(dir.path()), [local_state::FILE_NAME]);
        }
    }

    /// Not JSON: moved aside to `Local State.bad` (Chromium's JsonPrefStore), then created anew. Not an object: replaced.
    #[cfg(windows)]
    #[test]
    fn windows_sets_a_broken_local_state_aside() {
        let dir = tempfile::tempdir().unwrap();
        let path = local_state::path(dir.path());
        std::fs::write(&path, b"{broken").unwrap();
        let c = Cipher::open(dir.path(), "unimux", false);
        assert_eq!(c.origin(), &Origin::Created);
        assert_eq!(std::fs::read(dir.path().join(local_state::BAD_FILE_NAME)).unwrap(), b"{broken");
        stored_key_decrypts(dir.path(), &c.encrypt("pw").unwrap());

        std::fs::write(&path, b"[1]").unwrap();
        let c = Cipher::open(dir.path(), "unimux", false);
        assert!(matches!(c.origin(), Origin::Replaced(_)), "{:?}", c.origin());
        stored_key_decrypts(dir.path(), &c.encrypt("pw").unwrap());
        assert_eq!(file_names(dir.path()), [local_state::FILE_NAME, local_state::BAD_FILE_NAME]);
    }

    /// Chromium kInvalidKeyFormat (not base64, no DPAPI prefix): unavailable and the file is left alone.
    #[cfg(windows)]
    #[test]
    fn windows_never_touches_a_key_in_an_unknown_format() {
        for original in [
            &br#"{"os_crypt":{"encrypted_key":"not base64!"}}"#[..],
            br#"{"os_crypt":{"encrypted_key":"WFhYWFhhYmM="}}"#,
            br#"{"os_crypt":{"encrypted_key":5}}"#,
        ] {
            let dir = tempfile::tempdir().unwrap();
            let path = local_state::path(dir.path());
            std::fs::write(&path, original).unwrap();
            let c = Cipher::open(dir.path(), "unimux", false);
            assert!(!c.available());
            assert!(matches!(c.origin(), Origin::Failed(_)));
            assert_eq!(std::fs::read(&path).unwrap(), original);
            assert_eq!(file_names(dir.path()), [local_state::FILE_NAME]);
        }
    }

    /// Several first opens of one fresh data dir at the same moment (B2 opens the cipher from more than one store): one
    /// key is created, every cipher uses it, and a later start decrypts what each of them wrote.
    #[cfg(windows)]
    #[test]
    fn windows_concurrent_first_opens_share_one_key() {
        use std::sync::{Arc, Barrier};
        const THREADS: usize = 6;
        for _ in 0..40 {
            let dir = tempfile::tempdir().unwrap();
            let barrier = Arc::new(Barrier::new(THREADS));
            let handles: Vec<_> = (0..THREADS)
                .map(|_| {
                    let (barrier, path) = (barrier.clone(), dir.path().to_path_buf());
                    std::thread::spawn(move || {
                        barrier.wait();
                        Cipher::open(&path, "unimux", false)
                    })
                })
                .collect();
            let ciphers: Vec<Cipher> = handles.into_iter().map(|h| h.join().unwrap()).collect();
            let created = ciphers.iter().filter(|c| c.origin() == &Origin::Created).count();
            assert_eq!(created, 1, "{ciphers:?}");
            assert!(ciphers.iter().all(|c| c.available()), "{ciphers:?}");
            for c in &ciphers {
                let blob = c.encrypt("pw").unwrap();
                for other in &ciphers {
                    assert_eq!(other.decrypt(&blob).unwrap().as_str(), "pw");
                }
                stored_key_decrypts(dir.path(), &blob);
            }
            assert_eq!(file_names(dir.path()), [local_state::FILE_NAME], "no temp file left");
        }
    }
}
