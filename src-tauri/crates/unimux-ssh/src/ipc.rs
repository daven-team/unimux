//! S4: the key, password and known-host channels of the SSH feature (1.1.4 src/main/ssh/ipc.ts `createSshHandlers`),
//! without Tauri so they are unit tested. Every request goes through the zod schemas of 1.1.4 ([`schema`]); answers are
//! fixed codes; a failed vault or file write becomes `failed` (never the raw error text, which may name private paths).
//! Results never carry private key text, passphrases or passwords, with one exception: `revealPrivateKey`, the explicit,
//! confirmed "Pokaż klucz prywatny".
//!
//! The app (unimux-app `commands/ssh/keys.rs`) supplies an [`SshIpcHost`]: the state, the state edit, the
//! `ssh:vault:changed` event, the two file dialogs and the host name. The guard of the router already refused every window
//! but the app window (R9), so nothing here checks the sender.
//!
//! Vault work (DPAPI / Keychain, atomic writes) and key parsing (bcrypt of an encrypted OpenSSH key) run on the blocking
//! pool.

use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;

use parking_lot::Mutex;
use serde_json::{Value, json};
use zeroize::Zeroizing;

use crate::js_value::JsNum;
use crate::keys::js::js_trim;
use crate::keys::{
    CertCheck, DraftError, DraftInput, DraftResult, KeyDrafts, KeyGenRequest, KeyType, PRIVATE_KEY_LIMIT, ReadyDraft,
    certificate_check, check_passphrase, generate_key, key_meta_from_public, parse_private_key,
};
use crate::stores::SshStores;
use crate::vault::{
    AddKey, KeyPatch, KeySecretError, KeySource, NewKey, PassphrasePatch, ReplacementKey, SshVault, UpdateKeyError,
};

/// A future the host hands back (a dialog).
pub type HostFuture<T> = Pin<Box<dyn Future<Output = T> + Send + 'static>>;

/// What the app supplies to the handlers (`SshIpcDeps` of 1.1.4 minus the stores, which come from [`SshStores`]).
pub trait SshIpcHost: Send + Sync {
    /// The current app state.
    fn state(&self) -> Arc<Value>;
    /// A main-side state edit (StateController.change): `edit` answers the new state, or None for no change.
    fn change(&self, edit: &(dyn Fn(&Value) -> Option<Value> + Send + Sync));
    /// `ssh:vault:changed` to the windows.
    fn vault_changed(&self);
    /// The "Importuj z pliku" open dialog: the picked path, None when cancelled.
    fn pick_key_file(&self) -> HostFuture<Option<String>>;
    /// The "Zapisz klucz prywatny do pliku..." save dialog: the chosen path, None when cancelled, Err when the dialog failed.
    fn save_key_file(&self, default_name: String) -> HostFuture<Result<Option<String>, ()>>;
    /// `writeKeyFile`: the exported key, atomically, owner-only on POSIX.
    fn write_key_file(&self, path: String, text: Zeroizing<String>) -> HostFuture<std::io::Result<()>> {
        Box::pin(async move {
            tokio::task::spawn_blocking(move || unimux_core::json_file::write_private_file(Path::new(&path), &text))
                .await
                .unwrap_or_else(|e| Err(std::io::Error::other(e.to_string())))
        })
    }
    /// `readKeyFile`: [`read_key_file_from_disk`] by default.
    fn read_key_file(&self, path: String) -> HostFuture<Result<Zeroizing<String>, DraftError>> {
        Box::pin(async move {
            tokio::task::spawn_blocking(move || read_key_file_from_disk(&path)).await.unwrap_or(Err(DraftError::ReadFailed))
        })
    }
    /// `os.hostname()`: the default key comment is `unimux@<hostname>`.
    fn hostname(&self) -> String;
}

/// zod 4.6 checks of 1.1.4's schemas over a JSON value.
pub mod schema {
    use serde_json::{Map, Value};

    use crate::keys::js::js_trim;

    /// `SSH_LIMITS` of shared/ssh.ts.
    pub const LABEL: usize = 80;
    pub const PASSPHRASE: usize = 1024;
    pub const PASSWORD: usize = 1024;
    pub const PRIVATE_KEY: usize = 64 * 1024;

    /// `z.object({...}).strict()`: an object with only these keys.
    pub fn object<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a Map<String, Value>> {
        let o = v.as_object()?;
        o.keys().all(|k| keys.contains(&k.as_str())).then_some(o)
    }

    /// zod 4.6 measures `z.string().max(n)` in code points.
    fn len_ok(s: &str, min: usize, max: usize) -> bool {
        let n = s.chars().count();
        n >= min && n <= max
    }

    /// `z.string().min(min).max(max)`.
    pub fn string(v: &Value, min: usize, max: usize) -> Option<&str> {
        v.as_str().filter(|s| len_ok(s, min, max))
    }

    /// `z.guid()`: 8-4-4-4-12 hex digits, any version.
    pub fn guid(v: &Value) -> Option<&str> {
        v.as_str().filter(|s| {
            let b = s.as_bytes();
            b.len() == 36
                && b.iter().enumerate().all(|(i, c)| match i {
                    8 | 13 | 18 | 23 => *c == b'-',
                    _ => c.is_ascii_hexdigit(),
                })
        })
    }

    /// `label`: `z.string().trim().min(1).max(80)` (the trimmed text is what the handler gets).
    pub fn label(v: &Value) -> Option<String> {
        let s = js_trim(v.as_str()?);
        len_ok(s, 1, LABEL).then(|| s.to_string())
    }

    /// `z.boolean()`.
    pub fn boolean(v: &Value) -> Option<bool> {
        v.as_bool()
    }

    /// `z.number().int()`: a safe integer.
    pub fn int(v: &Value) -> Option<f64> {
        let n = v.as_f64()?;
        (n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0).then_some(n)
    }

    /// A required field: present and valid.
    pub fn req<'a, T>(o: &'a Map<String, Value>, key: &str, f: impl FnOnce(&'a Value) -> Option<T>) -> Option<T> {
        f(o.get(key)?)
    }

    /// `.optional()`: `Some(None)` when absent, `Some(Some(v))` when valid, None (invalid) otherwise.
    pub fn opt<'a, T>(o: &'a Map<String, Value>, key: &str, f: impl FnOnce(&'a Value) -> Option<T>) -> Option<Option<T>> {
        match o.get(key) {
            None => Some(None),
            Some(v) => f(v).map(Some),
        }
    }
}

use schema::{boolean, guid, int, label, object, opt, req, string};

/// `S.generate`.
struct GenerateReq {
    label: String,
    key_type: KeyType,
    bits: Option<f64>,
    comment: Option<String>,
    passphrase: Option<Zeroizing<String>>,
    save_passphrase: bool,
}

fn parse_generate(raw: &Value) -> Option<GenerateReq> {
    let o = object(raw, &["label", "type", "bits", "comment", "passphrase", "savePassphrase"])?;
    let key_type = req(o, "type", |v| match v.as_str()? {
        "ed25519" => Some(KeyType::Ed25519),
        "ecdsa" => Some(KeyType::Ecdsa),
        "rsa" => Some(KeyType::Rsa),
        _ => None,
    })?;
    Some(GenerateReq {
        label: req(o, "label", label)?,
        key_type,
        bits: opt(o, "bits", int)?,
        comment: opt(o, "comment", |v| string(v, 0, 200).map(str::to_string))?,
        passphrase: opt(o, "passphrase", |v| string(v, 1, schema::PASSPHRASE).map(|s| Zeroizing::new(s.to_string())))?,
        save_passphrase: req(o, "savePassphrase", boolean)?,
    })
}

/// `S.update`'s passphrase: `{ save }` or `{ forget: true }`, each strict.
fn parse_passphrase_patch(v: &Value) -> Option<PassphrasePatch> {
    if let Some(o) = object(v, &["save"])
        && let Some(save) = req(o, "save", |v| string(v, 1, schema::PASSPHRASE))
    {
        return Some(PassphrasePatch::Save(Zeroizing::new(save.to_string())));
    }
    let o = object(v, &["forget"])?;
    (o.get("forget") == Some(&Value::Bool(true))).then_some(PassphrasePatch::Forget)
}

struct UpdateReq {
    id: String,
    label: Option<String>,
    /// None: absent; Some(None): null; Some(Some(text)).
    certificate: Option<Option<String>>,
    passphrase: Option<PassphrasePatch>,
}

fn parse_update(raw: &Value) -> Option<UpdateReq> {
    let o = object(raw, &["id", "label", "certificate", "passphrase"])?;
    Some(UpdateReq {
        id: req(o, "id", guid)?.to_string(),
        label: opt(o, "label", label)?,
        certificate: opt(o, "certificate", |v| match v {
            Value::Null => Some(None),
            v => string(v, 0, 20000).map(|s| Some(s.to_string())),
        })?,
        passphrase: opt(o, "passphrase", parse_passphrase_patch)?,
    })
}

struct ReplaceReq {
    id: String,
    private_key: Zeroizing<String>,
    passphrase: Option<Zeroizing<String>>,
    save_passphrase: bool,
}

fn parse_replace(raw: &Value) -> Option<ReplaceReq> {
    let o = object(raw, &["id", "privateKey", "passphrase", "savePassphrase"])?;
    Some(ReplaceReq {
        id: req(o, "id", guid)?.to_string(),
        private_key: Zeroizing::new(req(o, "privateKey", |v| string(v, 1, schema::PRIVATE_KEY))?.to_string()),
        passphrase: opt(o, "passphrase", |v| string(v, 1, schema::PASSPHRASE).map(|s| Zeroizing::new(s.to_string())))?,
        save_passphrase: req(o, "savePassphrase", boolean)?,
    })
}

/// A strict `{ <key>: guid }`.
fn parse_by(raw: &Value, key: &str) -> Option<String> {
    let o = object(raw, &[key])?;
    req(o, key, guid).map(str::to_string)
}

/// A strict `{ <key>: guid, password: 1..1024 }`.
fn parse_password(raw: &Value, key: &str) -> Option<(String, Zeroizing<String>)> {
    let o = object(raw, &[key, "password"])?;
    let id = req(o, key, guid)?.to_string();
    let password = req(o, "password", |v| string(v, 1, schema::PASSWORD))?;
    Some((id, Zeroizing::new(password.to_string())))
}

/// Node's `path.isAbsolute` on this platform (on Windows `\x` and `/x` count, unlike `Path::is_absolute`).
pub fn node_is_absolute(path: &str) -> bool {
    if cfg!(windows) {
        let b = path.as_bytes();
        matches!(b.first(), Some(b'/' | b'\\'))
            || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && matches!(b[2], b'/' | b'\\'))
    } else {
        path.starts_with('/')
    }
}

/// `readKeyFileFromDisk`: only an absolute path to a regular file of at most 64 KiB (symbolic links followed, like `stat`),
/// read as UTF-8 with invalid bytes replaced (Node's `readFile(path, 'utf8')`).
pub fn read_key_file_from_disk(path: &str) -> Result<Zeroizing<String>, DraftError> {
    if !node_is_absolute(path) || path.contains('\0') {
        return Err(DraftError::ReadFailed);
    }
    let info = std::fs::metadata(path).map_err(|_| DraftError::ReadFailed)?;
    if !info.is_file() {
        return Err(DraftError::ReadFailed);
    }
    if info.len() > PRIVATE_KEY_LIMIT as u64 {
        return Err(DraftError::TooLarge);
    }
    let bytes = Zeroizing::new(std::fs::read(path).map_err(|_| DraftError::ReadFailed)?);
    Ok(Zeroizing::new(String::from_utf8_lossy(&bytes).into_owned()))
}

/// `safeFileName`: the label as a file name suggestion (`[^\w.-]+` -> `_`, no leading dots, 60 characters, `id_key`).
pub fn safe_file_name(name: &str) -> String {
    let mut out = String::new();
    let mut in_run = false;
    for c in name.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-') {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    let trimmed: String = out.trim_start_matches('.').chars().take(60).collect();
    if trimmed.is_empty() { "id_key".to_string() } else { trimmed }
}

/// `clearSshKeyRefs(s, keyId)` of shared/state.ts: hosts and identities that use the key lose their `keyId`. None when no
/// host or identity uses it (the state stays as it is).
pub fn clear_ssh_key_refs(state: &Value, key_id: &str) -> Option<Value> {
    let uses = |list: Option<&Value>| {
        list.and_then(Value::as_array).is_some_and(|a| a.iter().any(|x| x.get("keyId").and_then(Value::as_str) == Some(key_id)))
    };
    let hosts = state.get("sshHosts");
    let identities = state.get("sshIdentities").filter(|v| !v.is_null());
    if !uses(hosts) && !uses(identities) {
        return None;
    }
    let drop = |list: Option<&Value>| -> Value {
        let items = list.and_then(Value::as_array).cloned().unwrap_or_default();
        Value::Array(
            items
                .into_iter()
                .map(|mut x| {
                    if x.get("keyId").and_then(Value::as_str) == Some(key_id)
                        && let Some(o) = x.as_object_mut()
                    {
                        o.shift_remove("keyId");
                    }
                    x
                })
                .collect(),
        )
    };
    let mut next = state.as_object()?.clone();
    next.insert("sshHosts".into(), drop(hosts));
    next.insert("sshIdentities".into(), drop(identities));
    Some(Value::Object(next))
}

fn fail(error: &str) -> Value {
    json!({ "ok": false, "error": error })
}

fn draft_json(r: &DraftResult) -> Value {
    serde_json::to_value(r).unwrap_or_else(|_| fail("readFailed"))
}

/// `comment.replace(/[\u0000-\u001f]/g, ' ').trim()`.
fn clean_generate_comment(comment: &str) -> String {
    let replaced: String = comment.chars().map(|c| if (c as u32) < 0x20 { ' ' } else { c }).collect();
    js_trim(&replaced).to_string()
}

/// The handlers of src/main/ssh/ipc.ts (the ones S1 and S3 did not take: keys, passwords, known hosts).
pub struct SshIpc {
    stores: Arc<SshStores>,
    drafts: Arc<Mutex<KeyDrafts>>,
    host: Arc<dyn SshIpcHost>,
}

impl SshIpc {
    pub fn new(stores: Arc<SshStores>, host: Arc<dyn SshIpcHost>) -> Arc<SshIpc> {
        Arc::new(SshIpc { stores, drafts: Arc::new(Mutex::new(KeyDrafts::new())), host })
    }

    /// With an own draft store (tests: a clock).
    pub fn with_drafts(stores: Arc<SshStores>, host: Arc<dyn SshIpcHost>, drafts: KeyDrafts) -> Arc<SshIpc> {
        Arc::new(SshIpc { stores, drafts: Arc::new(Mutex::new(drafts)), host })
    }

    async fn vault(&self) -> Arc<Mutex<SshVault>> {
        self.stores.vault().await
    }

    /// Runs `f` with the vault on the blocking pool; None when the task failed (a panic: answered like a failed write).
    async fn with_vault<T: Send + 'static>(&self, f: impl FnOnce(&mut SshVault) -> T + Send + 'static) -> Option<T> {
        let vault = self.vault().await;
        tokio::task::spawn_blocking(move || f(&mut vault.lock())).await.ok()
    }

    fn changed(&self, value: Value) -> Value {
        self.host.vault_changed();
        value
    }

    /// `ssh:key:generate`.
    pub async fn generate_key(&self, raw: &Value) -> Value {
        let Some(p) = parse_generate(raw) else { return fail("invalid") };
        if self.with_vault(|v| v.read_only()).await.unwrap_or(true) {
            return fail("readOnly");
        }
        let comment = Some(clean_generate_comment(p.comment.as_deref().unwrap_or("")))
            .filter(|c| !c.is_empty())
            .unwrap_or_else(|| format!("unimux@{}", self.host.hostname()));
        // ed25519 ignores the size; any other size outside KEY_SIZES fails like "unsupported key size".
        let bits = match (p.key_type, p.bits) {
            (KeyType::Ed25519, _) | (_, None) => None,
            (_, Some(b)) if (0.0..=u32::MAX as f64).contains(&b) => Some(b as u32),
            _ => return fail("failed"),
        };
        let request = KeyGenRequest { key_type: p.key_type, bits, comment, passphrase: p.passphrase.clone() };
        let Ok(generated) = generate_key(request).await else { return fail("failed") };
        let meta = generated.meta;
        let key = NewKey {
            label: p.label,
            key_type: meta.key_type.as_str().to_string(),
            bits: JsNum::from(meta.bits),
            fingerprint: meta.fingerprint,
            public_key: meta.public_key,
            comment: meta.comment,
            encrypted: p.passphrase.is_some(),
            private_key: generated.private_key,
            passphrase: p.passphrase,
            save_passphrase: p.save_passphrase,
            certificate: None,
            source: KeySource::Generated,
        };
        match self.with_vault(move |v| v.add_key(key)).await {
            Some(Ok(AddKey::Added { key, .. })) => self.changed(json!({ "ok": true, "key": key.to_json() })),
            Some(Ok(AddKey::ReadOnly)) => fail("readOnly"),
            _ => fail("failed"),
        }
    }

    /// `ssh:key:pickFile`.
    pub async fn pick_key_file(&self) -> Value {
        match self.host.pick_key_file().await {
            Some(path) => self.draft_from_path(path).await,
            None => fail("cancelled"),
        }
    }

    /// `ssh:key:draftFromFile`.
    pub async fn draft_from_file(&self, raw: &Value) -> Value {
        let path = object(raw, &["path"]).and_then(|o| req(o, "path", |v| string(v, 1, 4096)));
        match path {
            Some(path) => self.draft_from_path(path.to_string()).await,
            None => fail("invalid"),
        }
    }

    async fn draft_from_path(&self, path: String) -> Value {
        match self.host.read_key_file(path).await {
            Ok(text) => self.create_draft(DraftInput { private_key: text, public_key: None, certificate: None }).await,
            Err(e) => draft_json(&DraftResult::err(e)),
        }
    }

    async fn create_draft(&self, input: DraftInput) -> Value {
        let (vault, drafts) = (self.vault().await, self.drafts.clone());
        let r = tokio::task::spawn_blocking(move || {
            let duplicate_of = |fp: &str| vault.lock().find_by_fingerprint(fp).map(|k| k.meta.id);
            drafts.lock().create(input, &duplicate_of)
        })
        .await;
        r.map(|r| draft_json(&r)).unwrap_or_else(|_| fail("readFailed"))
    }

    /// `ssh:key:draftFromText`.
    pub async fn draft_from_text(&self, raw: &Value) -> Value {
        let parsed = object(raw, &["privateKey", "publicKey", "certificate"]).and_then(|o| {
            Some(DraftInput {
                private_key: Zeroizing::new(req(o, "privateKey", |v| string(v, 1, schema::PRIVATE_KEY))?.to_string()),
                public_key: opt(o, "publicKey", |v| string(v, 0, 20000).map(str::to_string))?,
                certificate: opt(o, "certificate", |v| string(v, 0, 20000).map(str::to_string))?,
            })
        });
        match parsed {
            Some(input) => self.create_draft(input).await,
            None => fail("invalid"),
        }
    }

    /// `ssh:key:unlockDraft`.
    pub async fn unlock_draft(&self, raw: &Value) -> Value {
        let parsed = object(raw, &["draftId", "passphrase"]).and_then(|o| {
            let id = req(o, "draftId", guid)?.to_string();
            let passphrase = Zeroizing::new(req(o, "passphrase", |v| string(v, 1, schema::PASSPHRASE))?.to_string());
            Some((id, passphrase))
        });
        let Some((id, passphrase)) = parsed else { return fail("invalid") };
        let (vault, drafts) = (self.vault().await, self.drafts.clone());
        let r = tokio::task::spawn_blocking(move || {
            let duplicate_of = |fp: &str| vault.lock().find_by_fingerprint(fp).map(|k| k.meta.id);
            drafts.lock().unlock(&id, &passphrase, &duplicate_of)
        })
        .await;
        r.map(|r| draft_json(&r)).unwrap_or_else(|_| fail("readFailed"))
    }

    /// `ssh:key:commitDraft`.
    pub async fn commit_draft(&self, raw: &Value) -> Value {
        let parsed = object(raw, &["draftId", "label", "savePassphrase"]).and_then(|o| {
            Some((req(o, "draftId", guid)?.to_string(), req(o, "label", label)?, req(o, "savePassphrase", boolean)?))
        });
        let Some((draft_id, label, save_passphrase)) = parsed else { return fail("invalid") };
        if self.with_vault(|v| v.read_only()).await.unwrap_or(true) {
            return fail("readOnly");
        }
        let Some(d) = self.drafts.lock().take(&draft_id) else { return fail("notFound") };
        let ReadyDraft { text, meta, encrypted, passphrase, certificate } = d;
        let key = NewKey {
            label,
            key_type: meta.key_type.as_str().to_string(),
            bits: JsNum::from(meta.bits),
            fingerprint: meta.fingerprint,
            public_key: meta.public_key,
            comment: meta.comment,
            encrypted,
            private_key: text,
            passphrase,
            save_passphrase,
            certificate,
            source: KeySource::Imported,
        };
        match self.with_vault(move |v| v.add_key(key)).await {
            Some(Ok(AddKey::Added { key, duplicate })) => {
                let mut out = json!({ "ok": true, "key": key.to_json() });
                if duplicate {
                    out["duplicate"] = json!(true);
                }
                self.changed(out)
            }
            Some(Ok(AddKey::ReadOnly)) => fail("readOnly"),
            _ => fail("failed"),
        }
    }

    /// `ssh:key:discardDraft` (a send): a string id of at most 64 UTF-16 units.
    pub fn discard_draft(&self, raw: &Value) {
        if let Some(id) = raw.as_str().filter(|s| s.chars().map(char::len_utf16).sum::<usize>() <= 64) {
            self.drafts.lock().discard(id);
        }
    }

    /// `ssh:key:update`.
    pub async fn update_key(&self, raw: &Value) -> Value {
        let Some(p) = parse_update(raw) else { return fail("invalid") };
        let id = p.id.clone();
        let Some(Some(key)) = self.with_vault(move |v| v.key(&id)).await else { return fail("notFound") };
        if let Some(Some(cert)) = &p.certificate
            && !js_trim(cert).is_empty()
        {
            let ok =
                key_meta_from_public(&key.meta.public_key).is_some_and(|m| certificate_check(cert, &m) != CertCheck::Mismatch);
            if !ok {
                return fail("certMismatch");
            }
        }
        if let Some(PassphrasePatch::Save(pp)) = &p.passphrase {
            // Only a passphrase that opens the key is stored (a wrong saved one would fail every later sign-in silently).
            let (id, pp) = (p.id.clone(), pp.clone());
            let check =
                self.with_vault(move |v| v.key_secret(&id).map(|m| m.private_key)).await.map(|m| m.map(|text| (text, pp)));
            let Some(Ok((text, pp))) = check else { return fail("failed") };
            let opens = tokio::task::spawn_blocking(move || check_passphrase(&text, &pp)).await.unwrap_or(false);
            if !opens {
                return fail("badPassphrase");
            }
        }
        let patch = KeyPatch {
            label: p.label,
            certificate: p.certificate.map(|c| c.map(|c| js_trim(&c).to_string()).filter(|c| !c.is_empty())),
            passphrase: p.passphrase,
        };
        let id = p.id;
        match self.with_vault(move |v| v.update_key(&id, patch)).await {
            Some(Ok(Ok(key))) => self.changed(json!({ "ok": true, "key": key.to_json() })),
            Some(Ok(Err(UpdateKeyError::KeyLocked))) => fail("failed"),
            Some(Ok(Err(e))) => fail(e.as_str()),
            _ => fail("failed"),
        }
    }

    /// `ssh:key:remove`: the key goes, hosts and identities that used it lose the reference.
    pub async fn remove_key(&self, raw: &Value) -> Value {
        let Some(id) = parse_by(raw, "id") else { return json!({ "ok": false }) };
        let key = id.clone();
        if !matches!(self.with_vault(move |v| v.remove_key(&key)).await, Some(Ok(true))) {
            return json!({ "ok": false });
        }
        self.host.change(&move |s| clear_ssh_key_refs(s, &id));
        self.changed(json!({ "ok": true }))
    }

    /// The stored key text (`keySecret`) of a request `{ id }`, with the 1.1.4 codes: notFound / locked.
    async fn stored_text(&self, raw: &Value) -> Result<(Zeroizing<String>, String), &'static str> {
        let id = parse_by(raw, "id").ok_or("notFound")?;
        let r = self
            .with_vault(move |v| {
                let label = v.key(&id)?.meta.label;
                Some(v.key_secret(&id).map(|m| (m.private_key, label)))
            })
            .await
            .flatten();
        match r {
            None => Err("notFound"),
            Some(Ok(found)) => Ok(found),
            Some(Err(KeySecretError::KeyLocked)) => Err("locked"),
            Some(Err(KeySecretError::KeyMissing)) => Err("notFound"),
        }
    }

    /// `ssh:key:exportPrivate`: the stored text into a file the user picks; a failing dialog or write answers `failed`.
    pub async fn export_private_key(&self, raw: &Value) -> Value {
        let (text, label) = match self.stored_text(raw).await {
            Ok(found) => found,
            Err(code) => return fail(code),
        };
        let target = match self.host.save_key_file(safe_file_name(&label)).await {
            Ok(Some(path)) => path,
            Ok(None) => return fail("cancelled"),
            Err(()) => return fail("failed"),
        };
        match self.host.write_key_file(target, text).await {
            Ok(()) => json!({ "ok": true }),
            Err(_) => fail("failed"),
        }
    }

    /// `ssh:key:revealPrivate` ("Pokaż klucz prywatny", an explicit, confirmed user action): the stored text as it is, never
    /// decrypted for display.
    pub async fn reveal_private_key(&self, raw: &Value) -> Value {
        match self.stored_text(raw).await {
            Ok((text, _)) => json!({ "ok": true, "privateKey": text.as_str() }),
            Err(code) => fail(code),
        }
    }

    /// `ssh:key:replacePrivate` ("Zastąp klucz prywatny"): the new text is parsed like an import.
    pub async fn replace_private_key(&self, raw: &Value) -> Value {
        let Some(p) = parse_replace(raw) else { return fail("invalid") };
        let id = p.id.clone();
        let Some((exists, read_only)) = self.with_vault(move |v| (v.key(&id).is_some(), v.read_only())).await else {
            return fail("failed");
        };
        if !exists {
            return fail("notFound");
        }
        if read_only {
            return fail("readOnly");
        }
        let (text, pp) = (p.private_key.clone(), p.passphrase.clone());
        let parsed = tokio::task::spawn_blocking(move || {
            parse_private_key(&text, pp.as_deref().map(String::as_str)).map(|r| (r.meta, r.encrypted)).map_err(|f| f.error)
        })
        .await;
        let (meta, encrypted) = match parsed {
            Ok(Ok(found)) => found,
            Ok(Err(e)) => return fail(e.as_str()),
            Err(_) => return fail("failed"),
        };
        let key = ReplacementKey {
            key_type: meta.key_type.as_str().to_string(),
            bits: JsNum::from(meta.bits),
            fingerprint: meta.fingerprint,
            public_key: meta.public_key,
            comment: meta.comment,
            encrypted,
            private_key: p.private_key,
            passphrase: if encrypted { p.passphrase } else { None },
            save_passphrase: p.save_passphrase,
        };
        let id = p.id;
        match self.with_vault(move |v| v.replace_key(&id, key)).await {
            Some(Ok(Ok(r))) => self.changed(json!({
                "ok": true, "key": r.key.to_json(), "publicKeyChanged": r.public_key_changed, "certificateRemoved": r.certificate_removed,
            })),
            Some(Ok(Err(e))) => fail(e.as_str()),
            _ => fail("failed"),
        }
    }

    fn state_has(&self, list: &str, id: &str) -> bool {
        self.host
            .state()
            .get(list)
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().any(|x| x.get("id").and_then(Value::as_str) == Some(id)))
    }

    /// `ssh:password:set` / `ssh:identityPassword:set`: only for a host / identity that exists in the state; never echoed.
    async fn set_owned(&self, raw: &Value, key: &str, list: &str, identity: bool) -> Value {
        let Some((id, password)) = parse_password(raw, key) else { return fail("invalid") };
        if !self.state_has(list, &id) {
            return fail("notFound");
        }
        let r = self
            .with_vault(move |v| if identity { v.set_identity_password(&id, &password) } else { v.set_password(&id, &password) })
            .await;
        match r {
            Some(Ok(r)) => {
                let out = r.to_json();
                if out["ok"] == json!(true) { self.changed(out) } else { out }
            }
            _ => fail("failed"),
        }
    }

    async fn clear_owned(&self, raw: &Value, key: &str, identity: bool) -> Value {
        let Some(id) = parse_by(raw, key) else { return json!({ "ok": false }) };
        let r = self.with_vault(move |v| if identity { v.clear_identity_password(&id) } else { v.clear_password(&id) }).await;
        match r {
            Some(Ok(_)) => self.changed(json!({ "ok": true })),
            _ => json!({ "ok": false }),
        }
    }

    pub async fn set_password(&self, raw: &Value) -> Value {
        self.set_owned(raw, "hostId", "sshHosts", false).await
    }

    pub async fn clear_password(&self, raw: &Value) -> Value {
        self.clear_owned(raw, "hostId", false).await
    }

    pub async fn set_identity_password(&self, raw: &Value) -> Value {
        self.set_owned(raw, "identityId", "sshIdentities", true).await
    }

    pub async fn clear_identity_password(&self, raw: &Value) -> Value {
        self.clear_owned(raw, "identityId", true).await
    }

    /// `ssh:passphrases:forget`: the passphrases remembered until the app quits.
    pub async fn forget_passphrases(&self) -> Value {
        self.vault().await.lock().forget_remembered();
        json!({ "ok": true })
    }

    /// `ssh:knownHosts:remove`.
    pub async fn remove_known_host(&self, raw: &Value) -> Value {
        let Some(id) = parse_by(raw, "id") else { return json!({ "ok": false }) };
        let known = self.stores.known_hosts().await;
        let ok = tokio::task::spawn_blocking(move || known.lock().remove(&id)).await.is_ok_and(|r| r.unwrap_or(false));
        json!({ "ok": ok })
    }
}

/// The channels of [`SshIpc`] (invokes; `ssh:key:discardDraft` is a send).
pub const KEY_CHANNELS: [&str; 17] = [
    "ssh:key:generate",
    "ssh:key:pickFile",
    "ssh:key:draftFromFile",
    "ssh:key:draftFromText",
    "ssh:key:unlockDraft",
    "ssh:key:commitDraft",
    "ssh:key:update",
    "ssh:key:remove",
    "ssh:key:exportPrivate",
    "ssh:key:revealPrivate",
    "ssh:key:replacePrivate",
    "ssh:password:set",
    "ssh:password:clear",
    "ssh:identityPassword:set",
    "ssh:identityPassword:clear",
    "ssh:passphrases:forget",
    "ssh:knownHosts:remove",
];

impl SshIpc {
    /// Dispatches one invoke channel of [`KEY_CHANNELS`]; None for any other channel.
    pub async fn invoke(&self, channel: &str, arg: &Value) -> Option<Value> {
        Some(match channel {
            "ssh:key:generate" => self.generate_key(arg).await,
            "ssh:key:pickFile" => self.pick_key_file().await,
            "ssh:key:draftFromFile" => self.draft_from_file(arg).await,
            "ssh:key:draftFromText" => self.draft_from_text(arg).await,
            "ssh:key:unlockDraft" => self.unlock_draft(arg).await,
            "ssh:key:commitDraft" => self.commit_draft(arg).await,
            "ssh:key:update" => self.update_key(arg).await,
            "ssh:key:remove" => self.remove_key(arg).await,
            "ssh:key:exportPrivate" => self.export_private_key(arg).await,
            "ssh:key:revealPrivate" => self.reveal_private_key(arg).await,
            "ssh:key:replacePrivate" => self.replace_private_key(arg).await,
            "ssh:password:set" => self.set_password(arg).await,
            "ssh:password:clear" => self.clear_password(arg).await,
            "ssh:identityPassword:set" => self.set_identity_password(arg).await,
            "ssh:identityPassword:clear" => self.clear_identity_password(arg).await,
            "ssh:passphrases:forget" => self.forget_passphrases().await,
            "ssh:knownHosts:remove" => self.remove_known_host(arg).await,
            _ => return None,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_file_names_follow_ipc_ts() {
        assert_eq!(safe_file_name("my key (prod)"), "my_key_prod_");
        assert_eq!(safe_file_name("...hidden"), "hidden");
        assert_eq!(safe_file_name("..."), "id_key");
        assert_eq!(safe_file_name("zażółć"), "za_");
        assert_eq!(safe_file_name(&"a".repeat(80)).len(), 60);
        assert_eq!(safe_file_name(""), "id_key");
    }

    #[test]
    fn node_absolute_paths() {
        assert!(!node_is_absolute("relative/key"));
        assert!(node_is_absolute("/etc/key"));
        if cfg!(windows) {
            assert!(node_is_absolute("\\x"));
            assert!(node_is_absolute("C:\\x"));
            assert!(node_is_absolute("c:/x"));
            assert!(!node_is_absolute("C:x"));
            assert!(node_is_absolute("\\\\server\\share\\k"));
        }
    }

    #[test]
    fn schemas_follow_zod() {
        let id = "00000000-0000-4000-8000-000000000001";
        assert!(
            parse_generate(&json!({ "label": " a ", "type": "ed25519", "savePassphrase": false }))
                .is_some_and(|g| g.label == "a")
        );
        for bad in [
            json!({ "label": "  ", "type": "ed25519", "savePassphrase": false }),
            json!({ "label": "a", "type": "dsa", "savePassphrase": false }),
            json!({ "label": "a", "type": "rsa", "bits": 2048.5, "savePassphrase": false }),
            json!({ "label": "a", "type": "rsa", "savePassphrase": false, "x": 1 }),
            json!({ "label": "a", "type": "rsa", "passphrase": "", "savePassphrase": false }),
            json!({ "label": "a", "type": "rsa", "comment": null, "savePassphrase": false }),
            json!({ "label": "a".repeat(81), "type": "rsa", "savePassphrase": false }),
            json!({ "label": "a", "type": "rsa" }),
        ] {
            assert!(parse_generate(&bad).is_none(), "{bad}");
        }
        // 80 code points pass even when they are 160 UTF-16 units.
        assert!(parse_generate(&json!({ "label": "\u{1F600}".repeat(80), "type": "ed25519", "savePassphrase": true })).is_some());
        let u = parse_update(&json!({ "id": id, "certificate": null, "passphrase": { "forget": true } })).unwrap();
        assert_eq!(u.certificate, Some(None));
        assert!(matches!(u.passphrase, Some(PassphrasePatch::Forget)));
        for bad in [
            json!({ "id": id, "passphrase": { "forget": false } }),
            json!({ "id": id, "passphrase": { "save": "" } }),
            json!({ "id": id, "passphrase": { "save": "x", "forget": true } }),
            json!({ "id": "x" }),
            json!({ "id": id, "label": "" }),
        ] {
            assert!(parse_update(&bad).is_none(), "{bad}");
        }
        assert!(parse_replace(&json!({ "id": id, "privateKey": "k", "savePassphrase": false })).is_some());
        assert!(parse_replace(&json!({ "id": id, "privateKey": "", "savePassphrase": false })).is_none());
        assert!(parse_replace(&json!({ "id": id, "privateKey": "k" })).is_none());
        assert!(parse_password(&json!({ "hostId": id, "password": "p" }), "hostId").is_some());
        assert!(parse_password(&json!({ "hostId": id, "password": "p".repeat(1025) }), "hostId").is_none());
        assert!(parse_password(&json!({ "identityId": id, "password": "p", "hostId": id }), "identityId").is_none());
    }

    #[test]
    fn clearing_key_refs_keeps_everything_else() {
        let s = json!({ "version": 1, "sshHosts": [{ "id": "h", "keyId": "k", "label": "x" }, { "id": "h2", "keyId": "other" }], "z": 1 });
        let next = clear_ssh_key_refs(&s, "k").unwrap();
        assert_eq!(next["sshHosts"], json!([{ "id": "h", "label": "x" }, { "id": "h2", "keyId": "other" }]));
        // `{ ...s, sshHosts, sshIdentities }`: identities added at the end as [] when the state had none.
        let keys: Vec<&String> = next.as_object().unwrap().keys().collect();
        assert_eq!(keys, ["version", "sshHosts", "z", "sshIdentities"]);
        assert_eq!(next["sshIdentities"], json!([]));
        assert!(clear_ssh_key_refs(&s, "nope").is_none());
        let with_identity = json!({ "sshHosts": [], "sshIdentities": [{ "id": "i", "keyId": "k" }] });
        assert_eq!(clear_ssh_key_refs(&with_identity, "k").unwrap()["sshIdentities"], json!([{ "id": "i" }]));
    }

    #[test]
    fn generate_comments_are_cleaned() {
        assert_eq!(clean_generate_comment(" a\tb\n "), "a b");
        assert_eq!(clean_generate_comment("\u{1}"), "");
    }
}
