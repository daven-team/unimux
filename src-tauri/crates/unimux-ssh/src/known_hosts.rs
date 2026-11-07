//! Trusted host keys of the app (S1, 1.1.4 src/main/ssh/knownHosts.ts): `<data>/ssh/known_hosts.json`. Never reads or
//! writes `~/.ssh/known_hosts`.
//!
//! 1.1.4 parity: version 1; a newer version, an unreadable file, one of the wrong shape or a non-empty list without one
//! readable entry opens read-only (never written over); a malformed entry is dropped; hosts are lower-cased; a loaded key
//! is kept in its canonical base64 (`Buffer.from(key, 'base64').toString('base64')`) with its type and fingerprint taken
//! from the blob; the file is `JSON.stringify({version, entries}, null, 1)` through the atomic private writer and memory
//! changes only after a write succeeded.

use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use unimux_core::js_json;
use unimux_core::json_file::{JsonRead, ensure_private_dir, read_json_file, write_private_file};

use crate::js_value::{JsNum, integer, is_object, is_object_like, string};
use crate::keys::js::node_base64;
use crate::keys::{key_type_of_blob, sha256_fingerprint};
use crate::vault::{Clock, Ids, random_ids, system_clock};

pub const VERSION: u32 = 1;

/// One trusted key.
#[derive(Debug, Clone, PartialEq)]
pub struct KnownHostEntry {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub key_type: String,
    /// Canonical (padded) base64 of the key blob.
    pub key: String,
    pub fingerprint: String,
    pub added_at: JsNum,
}

impl KnownHostEntry {
    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id, "host": self.host, "port": self.port, "keyType": self.key_type, "key": self.key,
            "fingerprint": self.fingerprint, "addedAt": self.added_at.to_json(),
        })
    }
}

/// `HostKeyJudgement`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HostKeyJudgement {
    Match,
    Unknown,
    NewType { known_types: Vec<String> },
    Changed { known_fingerprints: Vec<String> },
}

impl HostKeyJudgement {
    pub fn to_json(&self) -> Value {
        match self {
            HostKeyJudgement::Match => json!({ "result": "match" }),
            HostKeyJudgement::Unknown => json!({ "result": "unknown" }),
            HostKeyJudgement::NewType { known_types } => json!({ "result": "newType", "knownTypes": known_types }),
            HostKeyJudgement::Changed { known_fingerprints } => {
                json!({ "result": "changed", "knownFingerprints": known_fingerprints })
            }
        }
    }
}

/// `judge()`: the judgement with the type and fingerprint of the offered key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Judged {
    pub judgement: HostKeyJudgement,
    pub key_type: String,
    pub fingerprint: String,
}

/// `trust()` modes: `replace` first removes the entries of that host:port and key type.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustMode {
    Save,
    Replace,
}

/// `knownHostId` of shared/ssh.ts: the store key and its display form (OpenSSH convention).
pub fn known_host_id(host: &str, port: u16) -> String {
    if port == 22 { host.to_string() } else { format!("[{host}]:{port}") }
}

/// `judgeHostKey(entries, host, port, keyType, keyBase64)` (host already lower-cased).
pub fn judge_host_key(entries: &[KnownHostEntry], host: &str, port: u16, key_type: &str, key_base64: &str) -> HostKeyJudgement {
    let mine: Vec<&KnownHostEntry> = entries.iter().filter(|e| e.host == host && e.port == port).collect();
    if mine.is_empty() {
        return HostKeyJudgement::Unknown;
    }
    let same_type: Vec<&&KnownHostEntry> = mine.iter().filter(|e| e.key_type == key_type).collect();
    if same_type.iter().any(|e| e.key == key_base64) {
        return HostKeyJudgement::Match;
    }
    if same_type.is_empty() {
        let mut known_types: Vec<String> = Vec::new();
        for e in &mine {
            if !known_types.contains(&e.key_type) {
                known_types.push(e.key_type.clone());
            }
        }
        return HostKeyJudgement::NewType { known_types };
    }
    HostKeyJudgement::Changed { known_fingerprints: same_type.iter().map(|e| e.fingerprint.clone()).collect() }
}

/// `/^[A-Za-z0-9+/]+={0,2}$/`.
fn is_base64(s: &str) -> bool {
    let body = s.trim_end_matches('=');
    s.len() - body.len() <= 2 && !body.is_empty() && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

/// JS `toLowerCase` (Unicode default case mapping, final sigma included, as Rust's).
fn lower(s: &str) -> String {
    s.to_lowercase()
}

fn parse_entry(raw: &Value) -> Option<KnownHostEntry> {
    if !is_object_like(raw) {
        return None;
    }
    let id = string(&raw["id"])?;
    let host = string(&raw["host"]).filter(|h| !h.is_empty())?;
    let port = integer(&raw["port"]).filter(|p| (1.0..=65535.0).contains(p))? as u16;
    let key = string(&raw["key"]).filter(|k| is_base64(k))?;
    let blob = node_base64(key);
    let key_type = key_type_of_blob(&blob)?;
    Some(KnownHostEntry {
        id: id.to_string(),
        host: lower(host),
        port,
        key_type,
        key: STANDARD.encode(&blob),
        fingerprint: sha256_fingerprint(&blob),
        added_at: JsNum::or_zero(&raw["addedAt"]),
    })
}

pub struct KnownHostsStore {
    file: PathBuf,
    now: Clock,
    ids: Ids,
    entries: Vec<KnownHostEntry>,
    newer: bool,
}

impl std::fmt::Debug for KnownHostsStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KnownHostsStore").field("file", &self.file).field("entries", &self.entries.len()).finish()
    }
}

impl KnownHostsStore {
    pub fn open(file: impl Into<PathBuf>) -> Self {
        Self::open_with(file, system_clock(), random_ids())
    }

    pub fn open_with(file: impl Into<PathBuf>, now: Clock, ids: Ids) -> Self {
        let mut store = Self { file: file.into(), now, ids, entries: Vec::new(), newer: false };
        store.load();
        store
    }

    fn load(&mut self) {
        let value = match read_json_file(&self.file) {
            JsonRead::Value(v) => v,
            JsonRead::Missing | JsonRead::Failed => {
                if self.file.exists() {
                    self.newer = true;
                }
                return;
            }
        };
        if !is_object(&value) || value.get("entries").is_some_and(|e| !e.is_array()) {
            self.newer = true;
            return;
        }
        if JsNum::of(&value["version"]).is_some_and(|n| n.as_f64() > f64::from(VERSION)) {
            self.newer = true;
        }
        if let Some(raw) = value.get("entries").and_then(Value::as_array) {
            self.entries = raw.iter().filter_map(parse_entry).collect();
            // Nothing readable in a non-empty list: probably not ours to overwrite.
            if !raw.is_empty() && self.entries.is_empty() {
                self.newer = true;
            }
        }
    }

    pub fn read_only(&self) -> bool {
        self.newer
    }

    pub fn file_path(&self) -> &Path {
        &self.file
    }

    pub fn list(&self) -> Vec<KnownHostEntry> {
        self.entries.clone()
    }

    /// `info()`: `KnownHostInfo[]` for Settings > SSH.
    pub fn info(&self) -> Value {
        Value::Array(
            self.entries
                .iter()
                .map(|e| {
                    json!({
                        "id": e.id, "display": known_host_id(&e.host, e.port), "keyType": e.key_type,
                        "fingerprint": e.fingerprint, "addedAt": e.added_at.to_json(),
                    })
                })
                .collect(),
        )
    }

    pub fn judge(&self, host: &str, port: u16, blob: &[u8]) -> Judged {
        let key_type = key_type_of_blob(blob).unwrap_or_else(|| "unknown".into());
        let judgement = judge_host_key(&self.entries, &lower(host), port, &key_type, &STANDARD.encode(blob));
        Judged { judgement, key_type, fingerprint: sha256_fingerprint(blob) }
    }

    /// False when the file is read-only or the blob is malformed; a failing write is an error and leaves the entries in
    /// memory unchanged.
    pub fn trust(&mut self, host: &str, port: u16, blob: &[u8], mode: TrustMode) -> std::io::Result<bool> {
        let Some(key_type) = key_type_of_blob(blob) else { return Ok(false) };
        if self.newer {
            return Ok(false);
        }
        let h = lower(host);
        let kept: Vec<KnownHostEntry> = match mode {
            TrustMode::Replace => {
                self.entries.iter().filter(|e| !(e.host == h && e.port == port && e.key_type == key_type)).cloned().collect()
            }
            TrustMode::Save => self.entries.clone(),
        };
        let key = STANDARD.encode(blob);
        let mut next = kept;
        if !next.iter().any(|e| e.host == h && e.port == port && e.key == key) {
            next.push(KnownHostEntry {
                id: (self.ids)(),
                host: h,
                port,
                key_type,
                key,
                fingerprint: sha256_fingerprint(blob),
                added_at: JsNum::from((self.now)()),
            });
        }
        self.write(&next)?;
        self.entries = next;
        Ok(true)
    }

    pub fn remove(&mut self, id: &str) -> std::io::Result<bool> {
        if self.newer {
            return Ok(false);
        }
        let next: Vec<KnownHostEntry> = self.entries.iter().filter(|e| e.id != id).cloned().collect();
        if next.len() == self.entries.len() {
            return Ok(false);
        }
        self.write(&next)?;
        self.entries = next;
        Ok(true)
    }

    fn write(&self, entries: &[KnownHostEntry]) -> std::io::Result<()> {
        if let Some(dir) = self.file.parent() {
            ensure_private_dir(dir)?;
        }
        let body = json!({ "version": VERSION, "entries": entries.iter().map(KnownHostEntry::to_json).collect::<Vec<_>>() });
        write_private_file(&self.file, &js_json::stringify_pretty(&body, 1))
    }
}
