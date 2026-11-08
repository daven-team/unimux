//! The cases of 1.1.4's test/ssh-vault.test.ts, ssh-known-hosts.test.ts and ssh-command-history.test.ts that the golden
//! corpus (stores_golden.rs) does not show by itself: no secret in the file, the DPAPI check at load against the lazy
//! Keychain, the batch timer of the history, POSIX modes, and the shared stores' awaited init.

use std::fs;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use unimux_oscrypt::{Cipher, SafeCipher, Storage};
use unimux_ssh::command_history::{CommandHistoryOptions, CommandHistoryStore};
use unimux_ssh::js_value::JsNum;
use unimux_ssh::known_hosts::{HostKeyJudgement, KnownHostsStore, TrustMode};
use unimux_ssh::stores::SshStores;
use unimux_ssh::vault::{AddKey, KeyPatch, KeySource, NewKey, PassphrasePatch, SshVault, UpdateKeyError};
use zeroize::Zeroizing;

const HOST_A: &str = "00000000-0000-4000-8000-00000000000a";
const PRIVATE: &str = "-----BEGIN OPENSSH PRIVATE KEY-----\nsecret-private-material\n-----END OPENSSH PRIVATE KEY-----\n";

fn key() -> NewKey {
    NewKey {
        label: "laptop".into(),
        key_type: "ssh-ed25519".into(),
        bits: JsNum::from(256u32),
        fingerprint: "SHA256:abc".into(),
        public_key: "ssh-ed25519 AAAA me@laptop".into(),
        comment: "me@laptop".into(),
        encrypted: true,
        private_key: Zeroizing::new(PRIVATE.into()),
        passphrase: Some(Zeroizing::new("very-secret-passphrase".into())),
        save_passphrase: true,
        certificate: None,
        source: KeySource::Imported,
    }
}

/// A cipher that counts its decrypts and reports the given storage (the real v10 format underneath).
struct Counting {
    inner: Cipher,
    storage: Storage,
    decrypts: AtomicUsize,
    broken: bool,
}

impl SafeCipher for Counting {
    fn storage(&self) -> Storage {
        self.storage
    }
    fn encrypt(&self, text: &str) -> Result<Vec<u8>, unimux_oscrypt::Error> {
        self.inner.encrypt(text)
    }
    fn decrypt(&self, blob: &[u8]) -> Result<Zeroizing<String>, unimux_oscrypt::Error> {
        self.decrypts.fetch_add(1, Ordering::SeqCst);
        if self.broken { Err(unimux_oscrypt::Error::Unavailable) } else { self.inner.decrypt(blob) }
    }
}

fn counting(storage: Storage, broken: bool) -> Arc<Counting> {
    Arc::new(Counting { inner: Cipher::with_gcm_key([3u8; 32]), storage, decrypts: AtomicUsize::new(0), broken })
}

#[test]
fn writes_no_secret_in_plain_text_or_base64() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("ssh").join("vault.json");
    let mut vault = SshVault::open(&file, Arc::new(Cipher::with_gcm_key([1u8; 32])));
    assert!(matches!(vault.add_key(key()).unwrap(), AddKey::Added { duplicate: false, .. }));
    vault.set_password(HOST_A, "hunter2-password").unwrap();
    let raw = fs::read_to_string(&file).unwrap();
    for secret in [PRIVATE, "secret-private-material", "very-secret-passphrase", "hunter2-password"] {
        assert!(!raw.contains(secret));
        assert!(!raw.contains(&STANDARD.encode(secret)));
    }
    // A new vault on the file (the same key) reads both back.
    let mut again = SshVault::open(&file, Arc::new(Cipher::with_gcm_key([1u8; 32])));
    let id = again.keys()[0].meta.id.clone();
    let material = again.key_secret(&id).unwrap();
    assert_eq!(material.private_key.as_str(), PRIVATE);
    assert_eq!(material.passphrase.as_deref().map(String::as_str), Some("very-secret-passphrase"));
    assert_eq!(again.password(HOST_A).unwrap().as_str(), "hunter2-password");
    assert_eq!(again.info()["storage"], "dpapi");
}

#[test]
fn checks_dpapi_secrets_once_at_load_and_stays_lazy_for_the_keychain() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("ssh").join("vault.json");
    let writer = counting(Storage::Dpapi, false);
    let mut vault = SshVault::open(&file, writer.clone());
    vault.add_key(key()).unwrap();
    vault.set_password(HOST_A, "pw").unwrap();

    // DPAPI on another account (blobs do not decrypt): every secret is tried once at load, locked entries show at once.
    let foreign = counting(Storage::Dpapi, true);
    let vault = SshVault::open(&file, foreign.clone());
    assert_eq!(foreign.decrypts.load(Ordering::SeqCst), 2);
    let info = vault.info();
    assert_eq!(info["keys"][0]["locked"], true);
    assert_eq!(info["lockedPasswords"], json!([HOST_A]));

    // The Keychain: nothing is decrypted at load (no prompt at startup); the first use finds the lock.
    let keychain = counting(Storage::Keychain, true);
    let mut vault = SshVault::open(&file, keychain.clone());
    assert_eq!(keychain.decrypts.load(Ordering::SeqCst), 0);
    assert_eq!(vault.info()["keys"][0]["locked"], false);
    let id = vault.keys()[0].meta.id.clone();
    assert!(vault.key_secret(&id).is_err());
    assert_eq!(vault.info()["keys"][0]["locked"], true);
}

#[test]
fn remembers_only_a_digest_of_a_verified_passphrase() {
    let dir = tempfile::tempdir().unwrap();
    let mut vault = SshVault::open(dir.path().join("vault.json"), Arc::new(Cipher::with_gcm_key([1u8; 32])));
    let AddKey::Added { key, .. } = vault.add_key(key()).unwrap() else { panic!("added") };
    let id = key.meta.id;
    vault.mark_verified(&id, "very-secret-passphrase");
    assert!(vault.is_verified(&id, "very-secret-passphrase"));
    assert!(!vault.is_verified(&id, "other"));
    assert!(!format!("{vault:?}").contains("very-secret"));
    vault.forget_remembered();
    assert!(!vault.is_verified(&id, "very-secret-passphrase"));
    vault.mark_verified(&id, "very-secret-passphrase");
    assert!(vault.remember(&id, "typed", Some(0)));
    assert!(!vault.remember(&id, "typed", Some(1)), "a passphrase checked against other material is not remembered");
    assert!(vault.remove_key(&id).unwrap());
    assert!(!vault.is_verified(&id, "very-secret-passphrase"));
    assert!(vault.remembered(&id).is_none());
}

#[cfg(unix)]
#[test]
fn creates_the_ssh_directory_0700_and_the_files_0600() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let ssh = dir.path().join("ssh");
    SshVault::open(ssh.join("vault.json"), Arc::new(Cipher::with_gcm_key([1u8; 32]))).set_password(HOST_A, "a").unwrap();
    assert_eq!(fs::metadata(&ssh).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(fs::metadata(ssh.join("vault.json")).unwrap().permissions().mode() & 0o777, 0o600);
}

#[test]
fn known_hosts_fingerprints_match_ssh_keygen() {
    // test/ssh-known-hosts.test.ts FIXTURE_LINE / FIXTURE_FP.
    let blob = STANDARD.decode("AAAAC3NzaC1lZDI1NTE5AAAAIOpKbGPinFIKvvVQexMuxfmVR3auvr57kkIe6mkURtIs").unwrap();
    let dir = tempfile::tempdir().unwrap();
    let mut store = KnownHostsStore::open(dir.path().join("ssh").join("known_hosts.json"));
    let judged = store.judge("Example.COM", 2222, &blob);
    assert_eq!(judged.judgement, HostKeyJudgement::Unknown);
    assert_eq!(judged.fingerprint, "SHA256:z/fSv0Z0RZS+Lccbc6ZoOWwt/fbj1VFJGSBKQbo4icE");
    assert!(store.trust("Example.COM", 2222, &blob, TrustMode::Save).unwrap());
    assert_eq!(store.info()[0]["display"], "[example.com]:2222");
    assert_eq!(store.judge("example.com", 2222, &blob).judgement, HostKeyJudgement::Match);
    assert!(!store.trust("x", 22, &[0, 0, 0, 99, 1], TrustMode::Save).unwrap(), "a malformed blob is refused");
}

fn history(dir: &std::path::Path, delay: Duration) -> Arc<CommandHistoryStore> {
    let opts =
        CommandHistoryOptions { host_exists: Arc::new(|id: &str| id == HOST_A), now: Arc::new(|| 1000), write_delay: delay };
    CommandHistoryStore::new(dir.join("ssh").join("command_history.json"), opts)
}

#[test]
fn history_changes_are_written_in_one_batch_after_the_delay() {
    let dir = tempfile::tempdir().unwrap();
    let store = history(dir.path(), Duration::from_millis(300));
    let file = store.file_path().to_path_buf();
    assert!(store.record(&json!(HOST_A), &json!("ls -la")));
    assert!(store.record(&json!(HOST_A), &json!("uptime")));
    assert!(!file.exists(), "batched");
    std::thread::sleep(Duration::from_millis(1200));
    let saved: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!(saved["hosts"][HOST_A].as_array().unwrap().len(), 2);
    assert_eq!(
        fs::read_to_string(&file).unwrap(),
        r#"{"version":1,"hosts":{"00000000-0000-4000-8000-00000000000a":[{"command":"uptime","count":1,"lastUsed":1000},{"command":"ls -la","count":1,"lastUsed":1000}]}}"#
    );
}

#[test]
fn history_flush_at_quit_writes_at_once_and_cancels_the_timer() {
    let dir = tempfile::tempdir().unwrap();
    let store = history(dir.path(), Duration::from_secs(3600));
    assert!(store.record(&json!(HOST_A), &json!("df -h")));
    store.flush();
    assert!(store.file_path().exists());
    // A dropped store's pending timer thread ends without writing anything.
    let other = history(&dir.path().join("b"), Duration::from_millis(50));
    other.record(&json!(HOST_A), &json!("pwd"));
    let path = other.file_path().to_path_buf();
    drop(other);
    std::thread::sleep(Duration::from_millis(300));
    assert!(!path.exists());
}

/// A vault the real 1.1.4 (Electron 45, DPAPI-wrapped `Local State` key) wrote during the SP2 spike
/// (unimux-oscrypt/tests/fixtures/win-electron45, key.hex = the unwrapped key): read, decrypted, and rewritten by a no-op
/// edit byte for byte.
#[test]
fn a_real_1_1_4_vault_reads_decrypts_and_rewrites_byte_identically() {
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../unimux-oscrypt/tests/fixtures/win-electron45");
    let hex = fs::read_to_string(fixtures.join("key.hex")).unwrap();
    let key: Vec<u8> = (0..32).map(|i| u8::from_str_radix(&hex.trim()[i * 2..i * 2 + 2], 16).unwrap()).collect();
    let expected: Value = serde_json::from_str(&fs::read_to_string(fixtures.join("expected.json")).unwrap()).unwrap();
    let original = fs::read(fixtures.join("electron/ssh/vault.json")).unwrap();
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("ssh").join("vault.json");
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, &original).unwrap();
    let cipher: Arc<dyn SafeCipher> = Arc::new(Cipher::with_gcm_key(key.try_into().unwrap()));
    let mut vault = SshVault::open(&file, cipher);
    assert!(!vault.read_only());
    let info = vault.info();
    assert_eq!(info["keys"][0]["locked"], false);
    assert_eq!(info["lockedPasswords"], json!([]));
    let id = vault.keys()[0].meta.id.clone();
    let material = vault.key_secret(&id).unwrap();
    assert_eq!(material.passphrase.as_deref().map(String::as_str), expected["ssh/vault.json"][0]["passphrase"].as_str());
    assert!(material.private_key.starts_with(expected["ssh/vault.json"][0]["privateKeyStartsWith"].as_str().unwrap()));
    let host = info["savedPasswords"][0].as_str().unwrap().to_string();
    assert_eq!(vault.password(&host).unwrap().as_str(), expected["ssh/vault.json"][1].as_str().unwrap());
    assert!(vault.update_key(&id, Default::default()).unwrap().is_ok());
    assert_eq!(fs::read(&file).unwrap(), original, "the no-op rewrite keeps 1.1.4's bytes");
}

#[tokio::test(flavor = "multi_thread")]
async fn shared_stores_open_once_and_every_caller_waits_for_it() {
    let dir = tempfile::tempdir().unwrap();
    let ssh = dir.path().join("ssh");
    {
        let mut v = SshVault::open(ssh.join("vault.json"), Arc::new(Cipher::with_gcm_key([3u8; 32])));
        v.add_key(key()).unwrap();
    }
    let cipher = counting(Storage::Dpapi, false);
    let stores = SshStores::new(dir.path(), cipher.clone(), Arc::new(|_: &str| true));
    assert_eq!(cipher.decrypts.load(Ordering::SeqCst), 0, "nothing is read before init");
    let (a, b) = tokio::join!(stores.vault(), stores.vault());
    assert!(Arc::ptr_eq(&a, &b));
    assert_eq!(cipher.decrypts.load(Ordering::SeqCst), 1, "the DPAPI check ran once");
    assert_eq!(a.lock().info()["keys"][0]["locked"], false);
    assert_eq!(stores.known_hosts().await.lock().list().len(), 0);
    assert_eq!(stores.history().file_path(), ssh.join("command_history.json"));
}

/// A cipher whose availability can be switched off mid-run (the real v10 format underneath).
struct Switchable {
    inner: Cipher,
    available: std::sync::atomic::AtomicBool,
}

impl SafeCipher for Switchable {
    fn storage(&self) -> Storage {
        if self.available.load(Ordering::SeqCst) { Storage::Dpapi } else { Storage::Unavailable }
    }
    fn encrypt(&self, text: &str) -> Result<Vec<u8>, unimux_oscrypt::Error> {
        self.inner.encrypt(text)
    }
    fn decrypt(&self, blob: &[u8]) -> Result<Zeroizing<String>, unimux_oscrypt::Error> {
        self.inner.decrypt(blob)
    }
}

/// The cases of test/ssh-vault.test.ts that need more than one cipher or file state in a row: locked entries unlock again
/// with the right key, a corrupt file is backed up again without overwriting the first backup (M5), a failed write leaves
/// memory unchanged and a retry writes, memory-only storage without encryption (D8), and no passphrase change of a stored
/// key while encryption is unavailable.
#[test]
fn vault_edge_cases_across_ciphers_and_file_states() {
    let dir = tempfile::tempdir().unwrap();
    let ssh = dir.path().join("ssh");
    let file = ssh.join("vault.json");
    let good = || -> Arc<dyn SafeCipher> { Arc::new(Cipher::with_gcm_key([1u8; 32])) };
    let mut vault = SshVault::open(&file, good());
    let AddKey::Added { key: first, .. } = vault.add_key(key()).unwrap() else { panic!("added") };
    vault.set_password(HOST_A, "a").unwrap();

    // Locked with another key, unlocked again with the right one.
    let mut foreign = SshVault::open(&file, Arc::new(Cipher::with_gcm_key([2u8; 32])));
    assert!(foreign.key_secret(&first.meta.id).is_err());
    assert!(foreign.password(HOST_A).is_err());
    assert_eq!(foreign.info()["lockedPasswords"], json!([HOST_A]));
    assert!(SshVault::open(&file, good()).key_secret(&first.meta.id).is_ok());

    // A failed write (a non-empty folder where the file belongs) changes nothing in memory; a retry writes for real.
    let before = vault.info();
    fs::remove_file(&file).unwrap();
    fs::create_dir_all(file.join("child")).unwrap();
    let mut other = key();
    other.fingerprint = "SHA256:other".into();
    other.label = "other".into();
    let other_again = || {
        let mut k = key();
        k.fingerprint = "SHA256:other".into();
        k.label = "other".into();
        k
    };
    assert!(vault.add_key(other).is_err());
    assert!(vault.set_password("00000000-0000-4000-8000-00000000000b", "b").is_err());
    assert!(vault.clear_password(HOST_A).is_err());
    assert!(vault.remove_key(&first.meta.id).is_err());
    assert_eq!(vault.info(), before);
    assert_eq!(vault.key_secret(&first.meta.id).unwrap().private_key.as_str(), PRIVATE);
    fs::remove_dir_all(&file).unwrap();
    assert!(matches!(vault.add_key(other_again()).unwrap(), AddKey::Added { duplicate: false, .. }));
    let labels: Vec<String> = SshVault::open(&file, good()).keys().into_iter().map(|k| k.meta.label).collect();
    assert_eq!(labels, ["laptop", "other"]);

    // Corrupt twice: two backups, the first one never overwritten (M5).
    fs::write(&file, "{ first").unwrap();
    SshVault::open(&file, good());
    fs::write(&file, "{ second").unwrap();
    SshVault::open(&file, good());
    let mut backups: Vec<String> = fs::read_dir(&ssh)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().starts_with("vault.json.bak-"))
        .map(|e| fs::read_to_string(e.path()).unwrap())
        .collect();
    backups.sort();
    assert_eq!(backups, ["{ first", "{ second"]);

    // Without encryption everything stays in memory and nothing is written (D8).
    let memory_dir = tempfile::tempdir().unwrap();
    let memory_file = memory_dir.path().join("ssh").join("vault.json");
    let off = Arc::new(Switchable { inner: Cipher::with_gcm_key([1u8; 32]), available: false.into() });
    let mut memory = SshVault::open(&memory_file, off.clone());
    let AddKey::Added { key: k, .. } = memory.add_key(key()).unwrap() else { panic!("added") };
    assert!(k.ephemeral);
    assert_eq!(memory.set_password(HOST_A, "pw").unwrap().to_json(), json!({ "ok": true, "ephemeral": true }));
    assert!(!memory_file.exists());
    assert_eq!(memory.key_secret(&k.meta.id).unwrap().private_key.as_str(), PRIVATE);
    assert_eq!(memory.info()["storage"], "unavailable");
    assert_eq!(SshVault::open(&memory_file, off).info()["keys"], json!([]));

    // A stored key's saved passphrase cannot change while encryption is unavailable.
    let switch_dir = tempfile::tempdir().unwrap();
    let switch_file = switch_dir.path().join("ssh").join("vault.json");
    let cipher = Arc::new(Switchable { inner: Cipher::with_gcm_key([1u8; 32]), available: true.into() });
    let mut vault = SshVault::open(&switch_file, cipher.clone());
    let mut plain = key();
    plain.save_passphrase = false;
    let AddKey::Added { key: k, .. } = vault.add_key(plain).unwrap() else { panic!("added") };
    cipher.available.store(false, Ordering::SeqCst);
    let save = KeyPatch { passphrase: Some(PassphrasePatch::Save(Zeroizing::new("new".into()))), ..KeyPatch::default() };
    let forget = KeyPatch { passphrase: Some(PassphrasePatch::Forget), ..KeyPatch::default() };
    assert_eq!(vault.update_key(&k.meta.id, save).unwrap().err(), Some(UpdateKeyError::Failed));
    assert_eq!(vault.update_key(&k.meta.id, forget).unwrap().err(), Some(UpdateKeyError::Failed));
    let kept = vault.key(&k.meta.id).unwrap();
    assert!(!kept.ephemeral && !kept.meta.passphrase_saved);
    let reread = SshVault::open(&switch_file, Arc::new(Cipher::with_gcm_key([1u8; 32]))).key_secret(&k.meta.id).unwrap();
    assert!(reread.passphrase.is_none());
}
