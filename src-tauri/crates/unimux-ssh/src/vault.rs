//! The SSH vault (S1, 1.1.4 src/main/ssh/vault.ts): `<data>/ssh/vault.json` with key metadata in clear and secrets as
//! safeStorage blobs. Saved passwords belong to a host (`passwords`, keyed by `hostId`) or an identity
//! (`identityPasswords`, keyed by `identityId`).
//!
//! 1.1.4 parity:
//!
//! - Versions: a file is written as version 2 only while it holds identity passwords (a version 1 app would drop that
//!   list); a file without them stays version 1. A newer version, an unreadable file, one of the wrong shape or one with
//!   an entry this version cannot read opens read-only: nothing is ever written over it.
//! - Field caps as `str(v, max)` (UTF-16 lengths): id 64, label 80, type 40, fingerprint 100, publicKey 20000, comment 200,
//!   certificate 20000, key secret 400000, password secret 20000.
//! - Ephemeral mode (D8): without encryption keys and passwords stay in memory only; a vault that holds nothing stored and
//!   has no file never touches the disk.
//! - DPAPI decrypts without a prompt, so [`SshVault::open`] decrypts every secret once to know the locked ones (the app
//!   runs it as an awaited init step off the main thread); the Keychain stays lazy (no prompt at startup).
//! - The file: `JSON.stringify(body, null, 1)` through the atomic private writer; memory is adopted only after a write
//!   succeeded, so a failed write leaves the vault as it was.
//! - Key order as the TS objects build it, including where `certificate` lands (see [`KeyMeta::cert_last`]).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use unimux_core::json_file::{JsonRead, ensure_private_dir, read_json_file, write_private_file};
use unimux_core::{js_json, utf16};
use unimux_oscrypt::{SafeCipher, Storage};
use zeroize::Zeroizing;

use crate::js_value::{JsNum, is_object, str_max};

/// The newest format this version reads.
pub const VERSION: u32 = 2;

/// `KEY_ALGOS` of shared/ssh.ts.
pub const KEY_ALGOS: [&str; 5] = ["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"];

/// `Date.now` of the store (tests inject their clock).
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;
/// `randomUUID` of the store (tests inject counted ids).
pub type Ids = Arc<dyn Fn() -> String + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(unimux_core::time::now_ms)
}

pub fn random_ids() -> Ids {
    Arc::new(|| uuid::Uuid::new_v4().to_string())
}

/// A write that threw in 1.1.4 (the IPC layer turns it into `failed`).
#[derive(Debug)]
pub enum VaultError {
    Io(std::io::Error),
    Encrypt(unimux_oscrypt::Error),
}

impl std::fmt::Display for VaultError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            VaultError::Io(e) => write!(f, "vault write: {e}"),
            VaultError::Encrypt(e) => write!(f, "vault encrypt: {e}"),
        }
    }
}

impl std::error::Error for VaultError {}

impl From<std::io::Error> for VaultError {
    fn from(e: std::io::Error) -> Self {
        VaultError::Io(e)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySource {
    Generated,
    Imported,
}

impl KeySource {
    pub fn as_str(self) -> &'static str {
        match self {
            KeySource::Generated => "generated",
            KeySource::Imported => "imported",
        }
    }
}

/// The metadata of a stored key (`SshKeyInfo` without `ephemeral` / `locked`).
#[derive(Debug, Clone, PartialEq)]
pub struct KeyMeta {
    pub id: String,
    pub label: String,
    pub key_type: String,
    pub bits: JsNum,
    pub fingerprint: String,
    pub public_key: String,
    pub comment: String,
    pub encrypted: bool,
    pub passphrase_saved: bool,
    pub certificate: Option<String>,
    /// The TS object got `certificate` after `createdAt` (set by updateKey on a key without one, or kept by replaceKey);
    /// otherwise it sits after `passphraseSaved` (the order of a loaded or added key). Only the key order of the JSON
    /// written next depends on it.
    pub cert_last: bool,
    pub source: KeySource,
    pub created_at: JsNum,
}

impl KeyMeta {
    /// The fields of the TS meta object in their order, plus `extra` at the end. `write` is the file form: `certificate`
    /// is always there (`?? null`).
    fn fields(&self, write: bool) -> Map<String, Value> {
        let mut m = Map::new();
        m.insert("id".into(), json!(self.id));
        m.insert("label".into(), json!(self.label));
        m.insert("type".into(), json!(self.key_type));
        m.insert("bits".into(), self.bits.to_json());
        m.insert("fingerprint".into(), json!(self.fingerprint));
        m.insert("publicKey".into(), json!(self.public_key));
        m.insert("comment".into(), json!(self.comment));
        m.insert("encrypted".into(), json!(self.encrypted));
        m.insert("passphraseSaved".into(), json!(self.passphrase_saved));
        if let (Some(c), false) = (&self.certificate, self.cert_last) {
            m.insert("certificate".into(), json!(c));
        }
        m.insert("source".into(), json!(self.source.as_str()));
        m.insert("createdAt".into(), self.created_at.to_json());
        if self.cert_last || self.certificate.is_none() {
            match (&self.certificate, write) {
                (Some(c), _) => {
                    m.insert("certificate".into(), json!(c));
                }
                (None, true) => {
                    m.insert("certificate".into(), Value::Null);
                }
                (None, false) => {}
            }
        }
        m
    }
}

/// `SshKeyInfo`: the metadata with `ephemeral` (memory only) and `locked` (the blob does not decrypt here).
#[derive(Debug, Clone, PartialEq)]
pub struct KeyInfo {
    pub meta: KeyMeta,
    pub ephemeral: bool,
    pub locked: bool,
}

impl KeyInfo {
    pub fn to_json(&self) -> Value {
        let mut m = self.meta.fields(false);
        m.insert("ephemeral".into(), json!(self.ephemeral));
        m.insert("locked".into(), json!(self.locked));
        Value::Object(m)
    }
}

/// The decrypted material of a key: `{ privateKey, passphrase? }`.
#[derive(Clone, PartialEq)]
pub struct KeyMaterial {
    pub private_key: Zeroizing<String>,
    pub passphrase: Option<Zeroizing<String>>,
}

impl std::fmt::Debug for KeyMaterial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("KeyMaterial(..)")
    }
}

impl KeyMaterial {
    /// `JSON.stringify(plain)`: the text that is sealed.
    fn to_text(&self) -> Zeroizing<String> {
        let mut m = Map::new();
        m.insert("privateKey".into(), json!(self.private_key.as_str()));
        if let Some(p) = &self.passphrase {
            m.insert("passphrase".into(), json!(p.as_str()));
        }
        Zeroizing::new(js_json::stringify(&Value::Object(m)))
    }
}

/// `keySecret` errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeySecretError {
    KeyMissing,
    KeyLocked,
}

impl KeySecretError {
    pub fn as_str(self) -> &'static str {
        match self {
            KeySecretError::KeyMissing => "keyMissing",
            KeySecretError::KeyLocked => "keyLocked",
        }
    }
}

/// `password` / `identityPassword` errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PasswordError {
    None,
    Locked,
}

impl PasswordError {
    pub fn as_str(self) -> &'static str {
        match self {
            PasswordError::None => "none",
            PasswordError::Locked => "locked",
        }
    }
}

/// `NewKey` of vault.ts.
#[derive(Clone)]
pub struct NewKey {
    pub label: String,
    pub key_type: String,
    pub bits: JsNum,
    pub fingerprint: String,
    pub public_key: String,
    pub comment: String,
    pub encrypted: bool,
    pub private_key: Zeroizing<String>,
    pub passphrase: Option<Zeroizing<String>>,
    pub save_passphrase: bool,
    pub certificate: Option<String>,
    pub source: KeySource,
}

/// `addKey` answers.
#[derive(Debug, Clone, PartialEq)]
#[allow(clippy::large_enum_variant, reason = "one answer per user action, returned by value like the TS object")]
pub enum AddKey {
    Added { key: KeyInfo, duplicate: bool },
    ReadOnly,
}

impl AddKey {
    pub fn to_json(&self) -> Value {
        match self {
            AddKey::Added { key, duplicate } => json!({ "ok": true, "key": key.to_json(), "duplicate": duplicate }),
            AddKey::ReadOnly => json!({ "ok": false, "error": "readOnly" }),
        }
    }
}

/// `updateKey`'s passphrase patch.
#[derive(Clone)]
pub enum PassphrasePatch {
    Save(Zeroizing<String>),
    Forget,
}

/// `updateKey`'s patch: `label`, `certificate` (`Some(None)` = null: removed), `passphrase`.
#[derive(Clone, Default)]
pub struct KeyPatch {
    pub label: Option<String>,
    pub certificate: Option<Option<String>>,
    pub passphrase: Option<PassphrasePatch>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateKeyError {
    NotFound,
    ReadOnly,
    KeyLocked,
    Failed,
}

impl UpdateKeyError {
    pub fn as_str(self) -> &'static str {
        match self {
            UpdateKeyError::NotFound => "notFound",
            UpdateKeyError::ReadOnly => "readOnly",
            UpdateKeyError::KeyLocked => "keyLocked",
            UpdateKeyError::Failed => "failed",
        }
    }
}

/// `replaceKey`'s new material (`Omit<NewKey, 'label' | 'certificate' | 'source'>`).
#[derive(Clone)]
pub struct ReplacementKey {
    pub key_type: String,
    pub bits: JsNum,
    pub fingerprint: String,
    pub public_key: String,
    pub comment: String,
    pub encrypted: bool,
    pub private_key: Zeroizing<String>,
    pub passphrase: Option<Zeroizing<String>>,
    pub save_passphrase: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Replaced {
    pub key: KeyInfo,
    pub public_key_changed: bool,
    pub certificate_removed: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReplaceKeyError {
    NotFound,
    ReadOnly,
    Duplicate,
    Failed,
}

impl ReplaceKeyError {
    pub fn as_str(self) -> &'static str {
        match self {
            ReplaceKeyError::NotFound => "notFound",
            ReplaceKeyError::ReadOnly => "readOnly",
            ReplaceKeyError::Duplicate => "duplicate",
            ReplaceKeyError::Failed => "failed",
        }
    }
}

/// `setPassword` answers: `Ok(ephemeral)` or read-only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SetPassword {
    Saved { ephemeral: bool },
    ReadOnly,
}

impl SetPassword {
    pub fn to_json(self) -> Value {
        match self {
            SetPassword::Saved { ephemeral } => json!({ "ok": true, "ephemeral": ephemeral }),
            SetPassword::ReadOnly => json!({ "ok": false, "error": "readOnly" }),
        }
    }
}

#[derive(Clone)]
struct KeyRecord {
    meta: KeyMeta,
    secret: Option<String>,
    plain: Option<KeyMaterial>,
    locked: bool,
}

#[derive(Clone)]
struct PasswordRecord {
    /// The owner's id (a host id or an identity id).
    owner: String,
    updated_at: JsNum,
    secret: Option<String>,
    plain: Option<Zeroizing<String>>,
    locked: bool,
}

/// Whose password: a host's or an identity's.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Owner {
    Host,
    Identity,
}

impl Owner {
    fn field(self) -> &'static str {
        match self {
            Owner::Host => "hostId",
            Owner::Identity => "identityId",
        }
    }
    fn list(self) -> &'static str {
        match self {
            Owner::Host => "passwords",
            Owner::Identity => "identityPasswords",
        }
    }
}

#[derive(Clone, Default)]
struct Passwords {
    host: Vec<PasswordRecord>,
    identity: Vec<PasswordRecord>,
}

impl Passwords {
    fn of(&self, owner: Owner) -> &Vec<PasswordRecord> {
        match owner {
            Owner::Host => &self.host,
            Owner::Identity => &self.identity,
        }
    }
    fn of_mut(&mut self, owner: Owner) -> &mut Vec<PasswordRecord> {
        match owner {
            Owner::Host => &mut self.host,
            Owner::Identity => &mut self.identity,
        }
    }
    fn with(&self, owner: Owner, list: Vec<PasswordRecord>) -> Passwords {
        let mut next = self.clone();
        *next.of_mut(owner) = list;
        next
    }
}

fn digest(text: &str) -> String {
    Sha256::digest(text.as_bytes()).iter().map(|b| format!("{b:02x}")).collect()
}

pub struct SshVault {
    file: PathBuf,
    cipher: Arc<dyn SafeCipher>,
    now: Clock,
    ids: Ids,
    keys: Vec<KeyRecord>,
    passwords: Passwords,
    /// A newer version, an unreadable file or one of the wrong shape: nothing is ever written over it.
    newer: bool,
    /// D7: passphrases typed with "remember until the app quits". Never written.
    remembered: HashMap<String, Zeroizing<String>>,
    /// Bumped when a key's material is replaced.
    generations: HashMap<String, u64>,
    /// Saved passphrases already checked against their key this run: only a SHA-256 hex, never the plaintext.
    verified: HashMap<String, String>,
}

impl std::fmt::Debug for SshVault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SshVault").field("file", &self.file).field("keys", &self.keys.len()).field("newer", &self.newer).finish()
    }
}

impl SshVault {
    /// The vault.ts constructor: reads the file and, with DPAPI, decrypts every secret once to mark the locked ones (this
    /// asks the cipher for its storage, which opens the key: run it off the main thread).
    pub fn open(file: impl Into<PathBuf>, cipher: Arc<dyn SafeCipher>) -> Self {
        Self::open_with(file, cipher, system_clock(), random_ids())
    }

    /// [`SshVault::open`] with an injected clock and id source.
    pub fn open_with(file: impl Into<PathBuf>, cipher: Arc<dyn SafeCipher>, now: Clock, ids: Ids) -> Self {
        let file = file.into();
        let mut vault = Self {
            file,
            cipher,
            now,
            ids,
            keys: Vec::new(),
            passwords: Passwords::default(),
            newer: false,
            remembered: HashMap::new(),
            generations: HashMap::new(),
            verified: HashMap::new(),
        };
        vault.load();
        vault
    }

    fn load(&mut self) {
        let v = match read_json_file(&self.file) {
            JsonRead::Value(v) => v,
            // Missing, or unparsable and moved to vault.json.bak-<time>: start empty. Still there: keep it untouched.
            JsonRead::Missing | JsonRead::Failed => {
                if self.file.exists() {
                    self.newer = true;
                }
                return;
            }
        };
        let lists = ["keys", "passwords", "identityPasswords"];
        if !is_object(&v) || lists.iter().any(|l| v.get(*l).is_some_and(|x| !x.is_array())) {
            self.newer = true;
            return;
        }
        if JsNum::of(&v["version"]).is_some_and(|n| n.as_f64() > f64::from(VERSION)) {
            self.newer = true;
        }
        let empty = Vec::new();
        let list = |name: &str| v.get(name).and_then(Value::as_array).unwrap_or(&empty);
        let raw_keys = list("keys");
        for raw in raw_keys {
            if !is_object(raw) {
                continue;
            }
            let (id, label, ty) = (str_max(&raw["id"], 64), str_max(&raw["label"], 80), str_max(&raw["type"], 40));
            let (fingerprint, public_key) = (str_max(&raw["fingerprint"], 100), str_max(&raw["publicKey"], 20000));
            let secret = str_max(&raw["secret"], 400_000);
            let (Some(id), Some(label), Some(ty), Some(fingerprint), Some(public_key), Some(secret)) =
                (id, label, ty, fingerprint, public_key, secret)
            else {
                continue;
            };
            if id.is_empty() || ty.is_empty() || !KEY_ALGOS.contains(&ty) || fingerprint.is_empty() || public_key.is_empty() {
                continue;
            }
            if secret.is_empty() {
                continue;
            }
            let certificate = str_max(&raw["certificate"], 20000).filter(|c| !c.is_empty()).map(str::to_string);
            self.keys.push(KeyRecord {
                meta: KeyMeta {
                    id: id.into(),
                    label: label.into(),
                    key_type: ty.into(),
                    bits: JsNum::or_zero(&raw["bits"]),
                    fingerprint: fingerprint.into(),
                    public_key: public_key.into(),
                    comment: str_max(&raw["comment"], 200).unwrap_or("").into(),
                    encrypted: raw["encrypted"] == Value::Bool(true),
                    passphrase_saved: raw["passphraseSaved"] == Value::Bool(true),
                    certificate,
                    cert_last: false,
                    source: if raw["source"] == "generated" { KeySource::Generated } else { KeySource::Imported },
                    created_at: JsNum::or_zero(&raw["createdAt"]),
                },
                secret: Some(secret.into()),
                plain: None,
                locked: false,
            });
        }
        let mut loaded = Passwords::default();
        let mut raw_counts = [0usize; 2];
        for (i, owner) in [Owner::Host, Owner::Identity].into_iter().enumerate() {
            let raws = list(owner.list());
            raw_counts[i] = raws.len();
            for raw in raws {
                if !is_object(raw) {
                    continue;
                }
                let (Some(id), Some(secret)) = (str_max(&raw[owner.field()], 64), str_max(&raw["secret"], 20000)) else {
                    continue;
                };
                if id.is_empty() || secret.is_empty() {
                    continue;
                }
                loaded.of_mut(owner).push(PasswordRecord {
                    owner: id.into(),
                    updated_at: JsNum::or_zero(&raw["updatedAt"]),
                    secret: Some(secret.into()),
                    plain: None,
                    locked: false,
                });
            }
        }
        // An entry this version cannot read would be dropped by the next write: open read-only instead.
        if self.keys.len() != raw_keys.len() || loaded.host.len() != raw_counts[0] || loaded.identity.len() != raw_counts[1] {
            self.newer = true;
        }
        self.passwords = loaded;
        // DPAPI decrypts without a prompt, so locked entries are known at once; the Keychain stays lazy. The decrypted
        // values are dropped right away.
        if self.cipher.storage() == Storage::Dpapi {
            let ids: Vec<String> = self.keys.iter().map(|k| k.meta.id.clone()).collect();
            for id in ids {
                let _ = self.key_secret(&id);
            }
            for owner in [Owner::Host, Owner::Identity] {
                let ids: Vec<String> = self.passwords.of(owner).iter().map(|p| p.owner.clone()).collect();
                for id in ids {
                    let _ = self.owned_password(owner, &id);
                }
            }
        }
    }

    pub fn read_only(&self) -> bool {
        self.newer
    }

    pub fn file_path(&self) -> &Path {
        &self.file
    }

    pub fn storage(&self) -> Storage {
        self.cipher.storage()
    }

    fn info_of(r: &KeyRecord) -> KeyInfo {
        KeyInfo { meta: r.meta.clone(), ephemeral: r.secret.is_none(), locked: r.locked }
    }

    /// `info()`: the `SshVaultInfo` the renderer gets (no secret in it).
    pub fn info(&self) -> Value {
        let ids = |owner: Owner, locked_only: bool| -> Value {
            self.passwords.of(owner).iter().filter(|p| !locked_only || p.locked).map(|p| json!(p.owner)).collect()
        };
        json!({
            "storage": self.cipher.storage().as_str(),
            "keys": self.keys.iter().map(|r| Self::info_of(r).to_json()).collect::<Vec<_>>(),
            "savedPasswords": ids(Owner::Host, false),
            "lockedPasswords": ids(Owner::Host, true),
            "savedIdentityPasswords": ids(Owner::Identity, false),
            "lockedIdentityPasswords": ids(Owner::Identity, true),
            "readOnly": self.newer,
        })
    }

    pub fn keys(&self) -> Vec<KeyInfo> {
        self.keys.iter().map(Self::info_of).collect()
    }

    pub fn key(&self, id: &str) -> Option<KeyInfo> {
        self.keys.iter().find(|k| k.meta.id == id).map(Self::info_of)
    }

    pub fn find_by_fingerprint(&self, fp: &str) -> Option<KeyInfo> {
        self.keys.iter().find(|k| k.meta.fingerprint == fp).map(Self::info_of)
    }

    /// `cipher.available() ? cipher.encrypt(value).toString('base64') : null`.
    fn seal(&self, value: &str) -> Result<Option<String>, VaultError> {
        if !self.cipher.available() {
            return Ok(None);
        }
        self.cipher.encrypt_base64(value).map(Some).map_err(VaultError::Encrypt)
    }

    fn open_secret(&self, secret: &str) -> Option<Zeroizing<String>> {
        self.cipher.decrypt_base64(secret).ok()
    }

    pub fn add_key(&mut self, k: NewKey) -> Result<AddKey, VaultError> {
        if self.newer {
            return Ok(AddKey::ReadOnly);
        }
        if let Some(existing) = self.keys.iter().find(|r| r.meta.fingerprint == k.fingerprint) {
            return Ok(AddKey::Added { key: Self::info_of(existing), duplicate: true });
        }
        let passphrase = k.passphrase.filter(|p| k.save_passphrase && !p.is_empty());
        let plain = KeyMaterial { private_key: k.private_key, passphrase };
        let secret = self.seal(&plain.to_text())?;
        let record = KeyRecord {
            meta: KeyMeta {
                id: (self.ids)(),
                label: utf16::slice(&k.label, 0, 80),
                key_type: k.key_type,
                bits: k.bits,
                fingerprint: k.fingerprint,
                public_key: k.public_key,
                comment: k.comment,
                encrypted: k.encrypted,
                passphrase_saved: plain.passphrase.is_some(),
                certificate: k.certificate.filter(|c| !c.is_empty()),
                cert_last: false,
                source: k.source,
                created_at: JsNum::from((self.now)()),
            },
            plain: if secret.is_none() { Some(plain) } else { None },
            secret,
            locked: false,
        };
        let info = Self::info_of(&record);
        let mut next = self.keys.clone();
        next.push(record);
        self.write(&next, &self.passwords)?;
        self.keys = next;
        Ok(AddKey::Added { key: info, duplicate: false })
    }

    /// `keySecret(id)`: the decrypted material; a blob that does not decrypt (or is not `{privateKey}` JSON) marks the key
    /// locked, one that decrypts again unlocks it.
    pub fn key_secret(&mut self, id: &str) -> Result<KeyMaterial, KeySecretError> {
        let Some(index) = self.keys.iter().position(|k| k.meta.id == id) else { return Err(KeySecretError::KeyMissing) };
        if let Some(plain) = &self.keys[index].plain {
            return Ok(plain.clone());
        }
        let text = self.keys[index].secret.as_deref().and_then(|s| self.open_secret(s));
        let r = &mut self.keys[index];
        let Some(text) = text else {
            r.locked = true;
            return Err(KeySecretError::KeyLocked);
        };
        r.locked = false;
        let parsed = js_json::parse(&text).ok();
        let private_key = parsed.as_ref().and_then(|p| p.get("privateKey")).and_then(Value::as_str);
        match private_key {
            Some(private_key) => {
                let passphrase = parsed
                    .as_ref()
                    .and_then(|p| p.get("passphrase"))
                    .and_then(Value::as_str)
                    .map(|p| Zeroizing::new(p.to_string()));
                Ok(KeyMaterial { private_key: Zeroizing::new(private_key.to_string()), passphrase })
            }
            None => {
                r.locked = true;
                Err(KeySecretError::KeyLocked)
            }
        }
    }

    pub fn update_key(&mut self, id: &str, patch: KeyPatch) -> Result<Result<KeyInfo, UpdateKeyError>, VaultError> {
        if self.newer {
            return Ok(Err(UpdateKeyError::ReadOnly));
        }
        let Some(index) = self.keys.iter().position(|k| k.meta.id == id) else { return Ok(Err(UpdateKeyError::NotFound)) };
        let mut updated = self.keys[index].clone();
        if let Some(pp) = &patch.passphrase {
            let stored = self.keys[index].secret.is_some();
            // A stored key must be sealed again; without encryption it would turn memory-only and vanish from the file.
            if stored && !self.cipher.available() {
                return Ok(Err(UpdateKeyError::Failed));
            }
            let Ok(current) = self.key_secret(id) else { return Ok(Err(UpdateKeyError::KeyLocked)) };
            let passphrase = match pp {
                PassphrasePatch::Save(p) => Some(p.clone()),
                PassphrasePatch::Forget => None,
            };
            let plain = KeyMaterial { private_key: current.private_key, passphrase };
            let secret = if stored { self.seal(&plain.to_text())? } else { None };
            if stored && secret.is_none() {
                return Ok(Err(UpdateKeyError::Failed));
            }
            updated.locked = false;
            updated.meta.passphrase_saved = plain.passphrase.as_ref().is_some_and(|p| !p.is_empty());
            updated.plain = if secret.is_none() { Some(plain) } else { None };
            updated.secret = secret;
        }
        if let Some(label) = &patch.label {
            updated.meta.label = utf16::slice(label, 0, 80);
        }
        match &patch.certificate {
            Some(None) => {
                updated.meta.certificate = None;
                updated.meta.cert_last = false;
            }
            Some(Some(c)) => {
                // A new property lands after createdAt; an existing one keeps its place.
                if updated.meta.certificate.is_none() {
                    updated.meta.cert_last = true;
                }
                updated.meta.certificate = Some(c.clone());
            }
            None => {}
        }
        let info = Self::info_of(&updated);
        let mut next = self.keys.clone();
        next[index] = updated;
        self.write(&next, &self.passwords)?;
        self.keys = next;
        if patch.passphrase.is_some() {
            self.remembered.remove(id);
        }
        self.verified.remove(id);
        Ok(Ok(info))
    }

    /// "Zastąp klucz prywatny": new key material under the same id (label, hosts using it and createdAt stay).
    pub fn replace_key(&mut self, id: &str, k: ReplacementKey) -> Result<Result<Replaced, ReplaceKeyError>, VaultError> {
        if self.newer {
            return Ok(Err(ReplaceKeyError::ReadOnly));
        }
        let Some(index) = self.keys.iter().position(|x| x.meta.id == id) else { return Ok(Err(ReplaceKeyError::NotFound)) };
        if self.keys.iter().enumerate().any(|(i, x)| i != index && x.meta.fingerprint == k.fingerprint) {
            return Ok(Err(ReplaceKeyError::Duplicate));
        }
        let r = &self.keys[index];
        let stored = r.secret.is_some();
        if stored && !self.cipher.available() {
            return Ok(Err(ReplaceKeyError::Failed));
        }
        let passphrase = k.passphrase.filter(|p| k.encrypted && k.save_passphrase && !p.is_empty());
        let plain = KeyMaterial { private_key: k.private_key, passphrase };
        let secret = if stored { self.seal(&plain.to_text())? } else { None };
        let r = &self.keys[index];
        let public_key_changed = r.meta.fingerprint != k.fingerprint;
        let certificate = r.meta.certificate.clone().filter(|c| !c.is_empty());
        let had_certificate = certificate.is_some();
        let keep = certificate.filter(|_| !public_key_changed);
        let meta = KeyMeta {
            key_type: k.key_type,
            bits: k.bits,
            fingerprint: k.fingerprint,
            public_key: k.public_key,
            comment: k.comment,
            encrypted: k.encrypted,
            passphrase_saved: plain.passphrase.is_some(),
            cert_last: keep.is_some(),
            certificate: keep,
            ..r.meta.clone()
        };
        let updated = KeyRecord { meta, plain: if secret.is_none() { Some(plain) } else { None }, secret, locked: false };
        let info = Self::info_of(&updated);
        let mut next = self.keys.clone();
        next[index] = updated;
        self.write(&next, &self.passwords)?;
        self.keys = next;
        *self.generations.entry(id.to_string()).or_insert(0) += 1;
        self.remembered.remove(id);
        self.verified.remove(id);
        Ok(Ok(Replaced { key: info, public_key_changed, certificate_removed: had_certificate && public_key_changed }))
    }

    pub fn remove_key(&mut self, id: &str) -> Result<bool, VaultError> {
        if self.newer {
            return Ok(false);
        }
        let next: Vec<KeyRecord> = self.keys.iter().filter(|k| k.meta.id != id).cloned().collect();
        if next.len() == self.keys.len() {
            return Ok(false);
        }
        self.write(&next, &self.passwords)?;
        self.keys = next;
        self.remembered.remove(id);
        self.verified.remove(id);
        Ok(true)
    }

    /// The material generation of a key (0 until it is replaced).
    pub fn generation(&self, key_id: &str) -> u64 {
        self.generations.get(key_id).copied().unwrap_or(0)
    }

    /// Remembers a typed passphrase; with `generation`, only if the key was not replaced since it was checked.
    pub fn remember(&mut self, key_id: &str, passphrase: &str, generation: Option<u64>) -> bool {
        if generation.is_some_and(|g| g != self.generation(key_id)) {
            return false;
        }
        self.remembered.insert(key_id.to_string(), Zeroizing::new(passphrase.to_string()));
        true
    }

    pub fn remembered(&self, key_id: &str) -> Option<Zeroizing<String>> {
        self.remembered.get(key_id).cloned()
    }

    pub fn forget_remembered(&mut self) {
        self.remembered.clear();
        self.verified.clear();
    }

    pub fn mark_verified(&mut self, key_id: &str, passphrase: &str) {
        self.verified.insert(key_id.to_string(), digest(passphrase));
    }

    pub fn is_verified(&self, key_id: &str, passphrase: &str) -> bool {
        self.verified.get(key_id).is_some_and(|d| *d == digest(passphrase))
    }

    pub fn set_password(&mut self, host_id: &str, password: &str) -> Result<SetPassword, VaultError> {
        self.set_owned(Owner::Host, host_id, password)
    }

    pub fn clear_password(&mut self, host_id: &str) -> Result<bool, VaultError> {
        self.clear_owned(Owner::Host, host_id)
    }

    pub fn password(&mut self, host_id: &str) -> Result<Zeroizing<String>, PasswordError> {
        self.owned_password(Owner::Host, host_id)
    }

    /// Called after every state change: passwords of hosts that no longer exist are deleted.
    pub fn prune_passwords(&mut self, host_ids: &dyn Fn(&str) -> bool) -> Result<bool, VaultError> {
        self.prune_owned(Owner::Host, host_ids)
    }

    pub fn set_identity_password(&mut self, identity_id: &str, password: &str) -> Result<SetPassword, VaultError> {
        self.set_owned(Owner::Identity, identity_id, password)
    }

    pub fn clear_identity_password(&mut self, identity_id: &str) -> Result<bool, VaultError> {
        self.clear_owned(Owner::Identity, identity_id)
    }

    pub fn identity_password(&mut self, identity_id: &str) -> Result<Zeroizing<String>, PasswordError> {
        self.owned_password(Owner::Identity, identity_id)
    }

    pub fn prune_identity_passwords(&mut self, identity_ids: &dyn Fn(&str) -> bool) -> Result<bool, VaultError> {
        self.prune_owned(Owner::Identity, identity_ids)
    }

    fn set_owned(&mut self, owner: Owner, id: &str, password: &str) -> Result<SetPassword, VaultError> {
        if self.newer {
            return Ok(SetPassword::ReadOnly);
        }
        let secret = self.seal(password)?;
        let ephemeral = secret.is_none();
        let record = PasswordRecord {
            owner: id.to_string(),
            updated_at: JsNum::from((self.now)()),
            plain: if ephemeral { Some(Zeroizing::new(password.to_string())) } else { None },
            secret,
            locked: false,
        };
        let mut list: Vec<PasswordRecord> = self.passwords.of(owner).iter().filter(|p| p.owner != id).cloned().collect();
        list.push(record);
        let next = self.passwords.with(owner, list);
        self.write(&self.keys, &next)?;
        self.passwords = next;
        Ok(SetPassword::Saved { ephemeral })
    }

    fn clear_owned(&mut self, owner: Owner, id: &str) -> Result<bool, VaultError> {
        if self.newer {
            return Ok(false);
        }
        let list: Vec<PasswordRecord> = self.passwords.of(owner).iter().filter(|p| p.owner != id).cloned().collect();
        if list.len() == self.passwords.of(owner).len() {
            return Ok(false);
        }
        let next = self.passwords.with(owner, list);
        self.write(&self.keys, &next)?;
        self.passwords = next;
        Ok(true)
    }

    fn owned_password(&mut self, owner: Owner, id: &str) -> Result<Zeroizing<String>, PasswordError> {
        let Some(index) = self.passwords.of(owner).iter().position(|p| p.owner == id) else { return Err(PasswordError::None) };
        let p = &self.passwords.of(owner)[index];
        if let Some(plain) = &p.plain {
            return Ok(plain.clone());
        }
        let text = p.secret.as_deref().and_then(|s| self.open_secret(s));
        let p = &mut self.passwords.of_mut(owner)[index];
        match text {
            Some(text) => {
                p.locked = false;
                Ok(text)
            }
            None => {
                p.locked = true;
                Err(PasswordError::Locked)
            }
        }
    }

    fn prune_owned(&mut self, owner: Owner, keep: &dyn Fn(&str) -> bool) -> Result<bool, VaultError> {
        if self.newer {
            return Ok(false);
        }
        let list: Vec<PasswordRecord> = self.passwords.of(owner).iter().filter(|p| keep(&p.owner)).cloned().collect();
        if list.len() == self.passwords.of(owner).len() {
            return Ok(false);
        }
        let next = self.passwords.with(owner, list);
        self.write(&self.keys, &next)?;
        self.passwords = next;
        Ok(true)
    }

    /// The file text for the given lists (None: nothing to write, the vault is memory-only and has no file).
    fn body(&self, keys: &[KeyRecord], passwords: &Passwords) -> Option<String> {
        let keys: Vec<Value> = keys
            .iter()
            .filter_map(|k| {
                let secret = k.secret.as_ref()?;
                let mut m = k.meta.fields(true);
                m.insert("secret".into(), json!(secret));
                Some(Value::Object(m))
            })
            .collect();
        let stored = |owner: Owner| -> Vec<Value> {
            passwords
                .of(owner)
                .iter()
                .filter_map(|p| {
                    let secret = p.secret.as_ref()?;
                    let mut m = Map::new();
                    m.insert(owner.field().into(), json!(p.owner));
                    m.insert("updatedAt".into(), p.updated_at.to_json());
                    m.insert("secret".into(), json!(secret));
                    Some(Value::Object(m))
                })
                .collect()
        };
        let (host, identity) = (stored(Owner::Host), stored(Owner::Identity));
        if keys.is_empty() && host.is_empty() && identity.is_empty() && !self.file.exists() {
            return None;
        }
        let mut body = Map::new();
        body.insert("version".into(), json!(if identity.is_empty() { 1 } else { VERSION }));
        body.insert("keys".into(), Value::Array(keys));
        body.insert("passwords".into(), Value::Array(host));
        if !identity.is_empty() {
            body.insert("identityPasswords".into(), Value::Array(identity));
        }
        Some(js_json::stringify_pretty(&Value::Object(body), 1))
    }

    /// Writes the given lists; callers adopt them only after this returns, so a failed write leaves memory as it was.
    fn write(&self, keys: &[KeyRecord], passwords: &Passwords) -> Result<(), VaultError> {
        if self.newer {
            return Ok(());
        }
        let Some(text) = self.body(keys, passwords) else { return Ok(()) };
        if let Some(dir) = self.file.parent() {
            ensure_private_dir(dir)?;
        }
        write_private_file(&self.file, &text)?;
        Ok(())
    }
}
