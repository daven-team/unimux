//! The production safeStorage of the app (B2): one per process, shared by the SSH vault, the DB vault and the GitHub token
//! store (`Arc<SafeStorage>` in AppContext), opened on first use.
//!
//! 1.1.4 parity:
//!
//! - 1.1.x wraps Electron's safeStorage in `electronCipher` (src/main/ssh/vault.ts): `storage` and `available()` ask
//!   `safeStorage.isEncryptionAvailable()` every time, which on macOS reads the Keychain (Chromium's
//!   `OSCryptImpl::IsEncryptionAvailable` = `GetEncryptionKey() != nullptr`). So the Keychain is first touched when a store
//!   first asks for the storage label, not at process start. [`SafeStorage`] does the same: nothing is read until the first
//!   call of any method (lazy Keychain access, PLAN B2). The first call may wait for the macOS "Allow" prompt, so callers
//!   run it off the main thread.
//! - On Windows Chromium's OSCrypt::Init runs at browser start and an idle 1.1.4 run already writes `Local State` (SP2 check
//!   E); the app calls [`SafeStorage::warm`] on a background thread at start for the same effect.
//! - `MC_SSH_NO_SAFESTORAGE === '1'` in an unpackaged 1.1.x (DevOverrides, compiled out of release builds): `electronCipher`
//!   reports `storage` `unavailable` and `available()` false without asking safeStorage (so on macOS the flag alone never
//!   reads the Keychain), but `encrypt` / `decrypt` still call the real `encryptString` / `decryptString`, and Chromium's
//!   OSCrypt::Init still runs at start on Windows. [`SafeStorage`] does the same: the flag gates only `storage()` /
//!   `available()`; the key is opened as usual (Windows: `Local State` read or created at start), so a secret saved
//!   without the flag still decrypts and nothing new is saved (the stores check `available()` first).
//! - Only Windows and macOS count as available (D8); elsewhere the storage is `unavailable`.
//! - `Buffer.from(secret, 'base64')` and `.toString('base64')` around the blobs: [`SafeCipher::decrypt_base64`] and
//!   [`SafeCipher::encrypt_base64`].

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use zeroize::Zeroizing;

use crate::{Cipher, Error, Origin, Storage, node_base64};

/// The `Cipher` interface of 1.1.x (src/main/ssh/vault.ts) that the vaults and the token store are written against. Tests of
/// those stores use [`Cipher::with_gcm_key`] / [`Cipher::unavailable`] like the TS tests use fake ciphers.
pub trait SafeCipher: Send + Sync {
    /// `cipher.storage`: `dpapi`, `keychain` or `unavailable`.
    fn storage(&self) -> Storage;

    /// `cipher.available()`.
    fn available(&self) -> bool {
        self.storage() != Storage::Unavailable
    }

    /// `safeStorage.encryptString(text)`.
    fn encrypt(&self, text: &str) -> Result<Vec<u8>, Error>;

    /// `safeStorage.decryptString(blob)`.
    fn decrypt(&self, blob: &[u8]) -> Result<Zeroizing<String>, Error>;

    /// `cipher.encrypt(text).toString('base64')`: the `"secret"` string the stores write.
    fn encrypt_base64(&self, text: &str) -> Result<String, Error> {
        self.encrypt(text).map(|blob| STANDARD.encode(blob))
    }

    /// `cipher.decrypt(Buffer.from(secret, 'base64'))`, with Node's forgiving base64 decoder.
    fn decrypt_base64(&self, secret: &str) -> Result<Zeroizing<String>, Error> {
        self.decrypt(&node_base64::decode(secret))
    }
}

impl SafeCipher for Cipher {
    fn storage(&self) -> Storage {
        Cipher::storage(self)
    }
    fn encrypt(&self, text: &str) -> Result<Vec<u8>, Error> {
        Cipher::encrypt(self, text)
    }
    fn decrypt(&self, blob: &[u8]) -> Result<Zeroizing<String>, Error> {
        Cipher::decrypt(self, blob)
    }
}

/// Called once when the key has been opened: how it was found and how long it took (for startup.log / crash.log).
pub type OpenedHook = Box<dyn Fn(&Origin, Duration) + Send + Sync>;

/// Opens the key (the real one: [`Cipher::open`]; tests inject their own).
type Opener = Box<dyn Fn() -> Cipher + Send + Sync>;

/// The lazily opened safeStorage of one data dir.
pub struct SafeStorage {
    /// For Debug only: the data dir and the Keychain app name, or what the injected opener is.
    source: String,
    force_unavailable: bool,
    opener: Opener,
    cipher: OnceLock<Cipher>,
    on_open: Option<OpenedHook>,
}

impl std::fmt::Debug for SafeStorage {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SafeStorage")
            .field("source", &self.source)
            .field("force_unavailable", &self.force_unavailable)
            .field("cipher", &self.cipher.get())
            .finish()
    }
}

impl SafeStorage {
    /// `app_name` names the macOS Keychain item (`<app> Safe Storage` / `<app> Key`); `force_unavailable` is
    /// `MC_SSH_NO_SAFESTORAGE` (only `storage()` / `available()` report unavailable, see the module docs). Nothing is read
    /// or written here.
    pub fn new(data_dir: impl Into<PathBuf>, app_name: impl Into<String>, force_unavailable: bool) -> Self {
        let (data_dir, app_name): (PathBuf, String) = (data_dir.into(), app_name.into());
        let source = format!("{} ({app_name})", data_dir.display());
        Self::with_opener(source, force_unavailable, move || Cipher::open(&data_dir, &app_name, false))
    }

    /// A safeStorage whose key comes from `opener` (called at most once, on first use): tests prove the laziness with it
    /// without reading a real Keychain or `Local State`.
    pub fn with_opener(
        source: impl Into<String>,
        force_unavailable: bool,
        opener: impl Fn() -> Cipher + Send + Sync + 'static,
    ) -> Self {
        Self { source: source.into(), force_unavailable, opener: Box::new(opener), cipher: OnceLock::new(), on_open: None }
    }

    /// Calls `hook` once, right after the key has been opened (on the thread that opened it).
    pub fn on_open(mut self, hook: impl Fn(&Origin, Duration) + Send + Sync + 'static) -> Self {
        self.on_open = Some(Box::new(hook));
        self
    }

    /// The cipher, opening the key on the first call (only one caller opens it; the others wait for it).
    pub fn cipher(&self) -> &Cipher {
        self.cipher.get_or_init(|| {
            let started = Instant::now();
            let cipher = (self.opener)();
            if let Some(hook) = &self.on_open {
                hook(cipher.origin(), started.elapsed());
            }
            cipher
        })
    }

    /// Opens the key now (Windows start, like Chromium's OSCrypt::Init). Returns how it was found.
    pub fn warm(&self) -> &Origin {
        self.cipher().origin()
    }

    /// How the key was found, or None while nothing has asked for it yet (the Keychain was not touched).
    pub fn opened(&self) -> Option<&Origin> {
        self.cipher.get().map(Cipher::origin)
    }
}

impl SafeCipher for SafeStorage {
    /// `electronCipher.storage`: with `MC_SSH_NO_SAFESTORAGE` `unavailable` without opening the key (1.1.x tests the flag
    /// before `isEncryptionAvailable()`).
    fn storage(&self) -> Storage {
        if self.force_unavailable {
            return Storage::Unavailable;
        }
        self.cipher().storage()
    }
    /// `safeStorage.encryptString`, which 1.1.x calls whatever the flag says (the stores check `available()` first).
    fn encrypt(&self, text: &str) -> Result<Vec<u8>, Error> {
        self.cipher().encrypt(text)
    }
    /// `safeStorage.decryptString`, also with the flag: secrets saved without it stay usable, as in 1.1.x.
    fn decrypt(&self, blob: &[u8]) -> Result<Zeroizing<String>, Error> {
        self.cipher().decrypt(blob)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    /// A store whose opener counts its calls and hands out a known key: no real Keychain or `Local State` on any platform
    /// (a test must never open the user's `unimux Safe Storage` Keychain item).
    fn counting(force_unavailable: bool) -> (SafeStorage, Arc<AtomicUsize>, Arc<AtomicUsize>) {
        let (opens, hooks) = (Arc::new(AtomicUsize::new(0)), Arc::new(AtomicUsize::new(0)));
        let (o, h) = (opens.clone(), hooks.clone());
        let store = SafeStorage::with_opener("test", force_unavailable, move || {
            o.fetch_add(1, Ordering::SeqCst);
            Cipher::with_gcm_key([7u8; 32])
        })
        .on_open(move |_, _| {
            h.fetch_add(1, Ordering::SeqCst);
        });
        (store, opens, hooks)
    }

    #[test]
    fn nothing_is_read_before_the_first_use() {
        let (store, opens, hooks) = counting(false);
        assert_eq!(store.opened(), None);
        assert_eq!(opens.load(Ordering::SeqCst), 0, "creating the store opens nothing (lazy Keychain access)");
        assert_eq!(store.storage(), Storage::Dpapi);
        assert_eq!(opens.load(Ordering::SeqCst), 1, "the first use opens the key");
        assert!(store.available());
        let secret = store.encrypt_base64("x").unwrap();
        assert_eq!(store.decrypt_base64(&secret).unwrap().as_str(), "x");
        assert_eq!(store.opened(), Some(&Origin::Given));
        assert_eq!((opens.load(Ordering::SeqCst), hooks.load(Ordering::SeqCst)), (1, 1), "opened once");
    }

    #[test]
    fn concurrent_first_uses_open_once() {
        let (store, opens, hooks) = counting(false);
        let store = Arc::new(store);
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let s = store.clone();
                std::thread::spawn(move || s.encrypt_base64("pw").unwrap())
            })
            .collect();
        for t in threads {
            assert_eq!(store.decrypt_base64(&t.join().unwrap()).unwrap().as_str(), "pw");
        }
        assert_eq!((opens.load(Ordering::SeqCst), hooks.load(Ordering::SeqCst)), (1, 1));
    }

    /// 1.1.x `electronCipher` with MC_SSH_NO_SAFESTORAGE=1: `storage` / `available()` say unavailable without asking
    /// safeStorage (no Keychain read on macOS), `encryptString` / `decryptString` still use the real key.
    #[test]
    fn forced_off_reports_unavailable_but_keeps_the_real_key() {
        let (store, opens, _) = counting(true);
        assert_eq!(store.storage(), Storage::Unavailable);
        assert!(!store.available());
        assert_eq!(opens.load(Ordering::SeqCst), 0, "the flag alone never opens the key");
        let saved_before = Cipher::with_gcm_key([7u8; 32]).encrypt_base64("saved without the flag").unwrap();
        assert_eq!(store.decrypt_base64(&saved_before).unwrap().as_str(), "saved without the flag");
        assert_eq!(opens.load(Ordering::SeqCst), 1);
        let blob = store.encrypt_base64("pw").unwrap();
        assert_eq!(store.decrypt_base64(&blob).unwrap().as_str(), "pw");
        assert_eq!(store.storage(), Storage::Unavailable, "still reported off once the key is open");
        assert_eq!(store.opened(), Some(&Origin::Given));
    }

    #[test]
    fn base64_helpers_follow_node_buffers() {
        let cipher = Cipher::with_gcm_key([9u8; 32]);
        let secret = cipher.encrypt_base64("hasło 🔑").unwrap();
        assert!(secret.len().is_multiple_of(4) && secret.starts_with("djEw"), "padded standard base64 of v10...");
        assert_eq!(cipher.decrypt_base64(&secret).unwrap().as_str(), "hasło 🔑");
        // Buffer.from tolerates a missing padding and line breaks; the blob still decrypts.
        let wrapped: String = secret
            .trim_end_matches('=')
            .chars()
            .collect::<Vec<_>>()
            .chunks(10)
            .map(|c| c.iter().collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        assert_eq!(cipher.decrypt_base64(&wrapped).unwrap().as_str(), "hasło 🔑");
        // Garbage gives bytes without the v10 prefix: locked, like decryptString throwing.
        assert!(cipher.decrypt_base64("not a blob").is_err());
        assert_eq!(cipher.decrypt_base64("").unwrap().as_str(), "");
    }

    #[cfg(windows)]
    #[test]
    fn windows_stores_share_one_key_and_report_how_it_was_found() {
        let dir = tempfile::tempdir().unwrap();
        let origins = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = origins.clone();
        let first =
            Arc::new(SafeStorage::new(dir.path(), "unimux", false).on_open(move |o, _| log.lock().unwrap().push(o.clone())));
        let threads: Vec<_> = (0..4)
            .map(|_| {
                let s = first.clone();
                std::thread::spawn(move || s.encrypt_base64("pw").unwrap())
            })
            .collect();
        let secrets: Vec<String> = threads.into_iter().map(|t| t.join().unwrap()).collect();
        assert_eq!(*origins.lock().unwrap(), vec![Origin::Created]);
        assert_eq!(first.storage(), Storage::Dpapi);
        let later = SafeStorage::new(dir.path(), "unimux", false);
        assert_eq!(later.warm(), &Origin::Existing);
        for s in &secrets {
            assert_eq!(later.decrypt_base64(s).unwrap().as_str(), "pw");
        }
        // MC_SSH_NO_SAFESTORAGE=1 on the same data dir: reported unavailable, the saved secrets still decrypt.
        let flagged = SafeStorage::new(dir.path(), "unimux", true);
        assert_eq!(flagged.storage(), Storage::Unavailable);
        assert_eq!(flagged.decrypt_base64(&secrets[0]).unwrap().as_str(), "pw");
        assert_eq!(flagged.opened(), Some(&Origin::Existing));
    }

    /// Windows, MC_SSH_NO_SAFESTORAGE=1 on a fresh data dir: `Local State` is created at start as 1.1.4's OSCrypt::Init does.
    #[cfg(windows)]
    #[test]
    fn windows_forced_off_still_creates_local_state_at_start() {
        let dir = tempfile::tempdir().unwrap();
        let store = SafeStorage::new(dir.path(), "unimux", true);
        assert_eq!(store.warm(), &Origin::Created);
        assert!(crate::local_state::path(dir.path()).exists());
        assert!(!store.available());
    }
}
