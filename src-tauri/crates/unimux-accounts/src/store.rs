//! The saved Claude accounts (port of src/main/accounts/store.ts): every account the app knows, including the one signed in to
//! Claude Code; each lives in `<root>/claude/<uuid>` and is listed in `<root>/accounts.json` with the last seen live identity
//! and pending notices. Never holds a token.
//!
//! accounts.json is written exactly as 1.1.4 writes it: `JSON.stringify(body, null, 2)`, no trailing newline, keys in the
//! order the TS spreads build them (`id, addedAt, email, org, accountUuid, organizationUuid, custody, family, duplicateOf,
//! heldTokens, deadTokens, appSwap`), numbers as JavaScript prints them.
//!
//! Read rules: missing - empty and writable; unparsable - moved to `accounts.json.bak-<ISO>` (never over an earlier backup),
//! then empty and writable; unreadable (locked, a directory), of the wrong shape or of a newer version - read-only, every write
//! refused with [`StoreError::ReadOnly`], so the records in it are never lost.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use unimux_core::atomic_write::{AtomicWriteOptions, atomic_write};
use unimux_core::js_json;
use unimux_core::json_file::backup_path;

use crate::identity::{
    AccountIdentity, Custody, TokenFamily, identity_fields, identity_fields_of, is_account_id, is_account_id_value,
};
use crate::js;

const MAX_TEXT: usize = 120;
const MAX_NOTICES: usize = 20;
/// accounts.json format: 1 = 0.9.0 (records only), 2 = identities, roles, the live login and notices (0.9.1).
pub const STORE_VERSION: f64 = 2.0;

/// The account record of accounts.json (`ManagedAccount`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedAccount {
    pub id: String,
    pub added_at: f64,
    #[serde(flatten)]
    pub identity: AccountIdentity,
    /// Absent in 0.9.0 records: `app`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custody: Option<Custody>,
    /// Absent in 0.9.0 records: `live`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub family: Option<TokenFamily>,
    /// For `quarantined`: the record that holds the account now.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<String>,
    /// SHA-256 (hex) of a live refresh token that must never be copied into this record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub held_tokens: Option<String>,
    /// SHA-256 (hex) of the refresh token in this record's saved copy that is known to be dead.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dead_tokens: Option<String>,
    /// Set while the record is the live login because the app itself made it main.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_swap: Option<AppSwap>,
}

/// `{ at, from?, own? }` of a swap the app made.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSwap {
    pub at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub own: bool,
}

/// The identity last seen in the live Claude Code login and the record it belongs to.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveIdentity {
    #[serde(flatten)]
    pub identity: AccountIdentity,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum NoticeKind {
    SwitchedOut,
    LoggedOut,
    Adopted,
    Migrated,
    Quarantined,
}

impl NoticeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            NoticeKind::SwitchedOut => "switchedOut",
            NoticeKind::LoggedOut => "loggedOut",
            NoticeKind::Adopted => "adopted",
            NoticeKind::Migrated => "migrated",
            NoticeKind::Quarantined => "quarantined",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "switchedOut" => NoticeKind::SwitchedOut,
            "loggedOut" => NoticeKind::LoggedOut,
            "adopted" => NoticeKind::Adopted,
            "migrated" => NoticeKind::Migrated,
            "quarantined" => NoticeKind::Quarantined,
            _ => return None,
        })
    }
}

/// Something the app did to the saved accounts on its own, shown in the limits panel until dismissed. Never holds a token.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountNotice {
    pub id: String,
    pub kind: NoticeKind,
    pub at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<f64>,
}

/// `Omit<AccountNotice, 'id'>`: what [`AccountsStore::add_notice`] takes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewNotice {
    pub kind: NoticeKind,
    pub at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub email: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub record_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub count: Option<f64>,
}

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// `AccountsReadOnlyError`: accounts.json could not be read safely; nothing is written over it.
    #[error("accounts.json cannot be read safely; not writing over it")]
    ReadOnly,
    #[error("invalid account id")]
    InvalidId,
    #[error("invalid account")]
    InvalidAccount,
    #[error(transparent)]
    Io(#[from] io::Error),
}

#[derive(Debug, Clone, PartialEq)]
struct StoreFile {
    version: f64,
    claude: Vec<ManagedAccount>,
    live: Option<LiveIdentity>,
    notices: Vec<AccountNotice>,
    /// The file exists but could not be read, has the wrong shape or a newer version: nothing is ever written over it.
    read_only: bool,
}

impl StoreFile {
    fn empty(read_only: bool) -> Self {
        Self { version: 1.0, claude: Vec::new(), live: None, notices: Vec::new(), read_only }
    }
}

// ── parsing (each function is the TS one of the same name) ──────────────────

/// A string within the length limit (`short`).
fn short(v: Option<&Value>) -> Option<String> {
    js::string(v).filter(|s| js::len16(s) <= MAX_TEXT).map(str::to_string)
}

/// Identity fields within the length limit (a longer value is dropped, as 0.9.0 did for e-mail and organisation).
fn bounded_identity(value: &Map<String, Value>) -> AccountIdentity {
    let mut picked = Map::new();
    for key in crate::identity::IDENTITY_KEYS {
        if let Some(s) = short(value.get(key)) {
            picked.insert(key.into(), Value::String(s));
        }
    }
    identity_fields_of(&picked)
}

fn hex64(v: Option<&Value>) -> Option<String> {
    js::string(v).filter(|s| js::is_hex64(s)).map(str::to_string)
}

/// `parseAccount`: a record of accounts.json, or `None` when its id or addedAt is unusable; every bad field is dropped.
pub fn parse_account(value: &Value) -> Option<ManagedAccount> {
    let m = js::record(Some(value))?;
    if !is_account_id_value(m.get("id")) {
        return None;
    }
    let added_at = js::finite(m.get("addedAt"))?;
    Some(ManagedAccount {
        id: js::string(m.get("id"))?.to_string(),
        added_at,
        identity: bounded_identity(m),
        custody: js::string(m.get("custody")).and_then(Custody::parse),
        family: js::string(m.get("family")).and_then(TokenFamily::parse),
        duplicate_of: js::string(m.get("duplicateOf")).filter(|s| is_account_id(s)).map(str::to_string),
        held_tokens: hex64(m.get("heldTokens")),
        dead_tokens: hex64(m.get("deadTokens")),
        app_swap: parse_app_swap(m.get("appSwap")),
    })
}

fn parse_app_swap(value: Option<&Value>) -> Option<AppSwap> {
    let m = js::record(value)?;
    let at = js::finite(m.get("at"))?;
    Some(AppSwap { at, from: hex64(m.get("from")), own: m.get("own") == Some(&Value::Bool(true)) })
}

fn parse_live(value: Option<&Value>) -> Option<LiveIdentity> {
    let m = js::record(value)?;
    Some(LiveIdentity {
        identity: bounded_identity(m),
        record_id: js::string(m.get("recordId")).filter(|s| is_account_id(s)).map(str::to_string),
    })
}

fn parse_notice(value: &Value) -> Option<AccountNotice> {
    let m = js::record(Some(value))?;
    let id = js::string(m.get("id")).filter(|s| !s.is_empty() && js::len16(s) <= 64)?;
    let kind = js::string(m.get("kind")).and_then(NoticeKind::parse)?;
    let at = js::finite(m.get("at"))?;
    Some(AccountNotice {
        id: id.to_string(),
        kind,
        at,
        email: short(m.get("email")).filter(|s| !s.is_empty()),
        record_id: js::string(m.get("recordId")).filter(|s| is_account_id(s)).map(str::to_string),
        count: js::finite(m.get("count")).filter(|c| c.fract() == 0.0 && *c >= 0.0),
    })
}

// ── writing: the objects the TS code builds, in its key order ───────────────

impl ManagedAccount {
    /// The record as accounts.json holds it.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), Value::String(self.id.clone()));
        m.insert("addedAt".into(), js::num(self.added_at));
        self.identity.write_into(&mut m);
        if let Some(c) = self.custody {
            m.insert("custody".into(), c.as_str().into());
        }
        if let Some(f) = self.family {
            m.insert("family".into(), f.as_str().into());
        }
        for (key, v) in
            [("duplicateOf", &self.duplicate_of), ("heldTokens", &self.held_tokens), ("deadTokens", &self.dead_tokens)]
        {
            if let Some(v) = v {
                m.insert(key.into(), Value::String(v.clone()));
            }
        }
        if let Some(s) = &self.app_swap {
            m.insert("appSwap".into(), s.to_value());
        }
        Value::Object(m)
    }
}

impl AppSwap {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("at".into(), js::num(self.at));
        if let Some(f) = &self.from {
            m.insert("from".into(), Value::String(f.clone()));
        }
        if self.own {
            m.insert("own".into(), Value::Bool(true));
        }
        Value::Object(m)
    }
}

impl LiveIdentity {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        self.identity.write_into(&mut m);
        if let Some(r) = &self.record_id {
            m.insert("recordId".into(), Value::String(r.clone()));
        }
        Value::Object(m)
    }
}

impl AccountNotice {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("id".into(), Value::String(self.id.clone()));
        m.insert("kind".into(), self.kind.as_str().into());
        m.insert("at".into(), js::num(self.at));
        if let Some(e) = &self.email {
            m.insert("email".into(), Value::String(e.clone()));
        }
        if let Some(r) = &self.record_id {
            m.insert("recordId".into(), Value::String(r.clone()));
        }
        if let Some(c) = self.count {
            m.insert("count".into(), js::num(c));
        }
        Value::Object(m)
    }
}

impl NewNotice {
    fn to_value(&self, id: String) -> Value {
        let mut m = Map::new();
        m.insert("kind".into(), self.kind.as_str().into());
        m.insert("at".into(), js::num(self.at));
        if let Some(e) = &self.email {
            m.insert("email".into(), Value::String(e.clone()));
        }
        if let Some(r) = &self.record_id {
            m.insert("recordId".into(), Value::String(r.clone()));
        }
        if let Some(c) = self.count {
            m.insert("count".into(), js::num(c));
        }
        m.insert("id".into(), Value::String(id));
        Value::Object(m)
    }
}

/// The body JSON.stringify writes: `{ version, claude, live?, notices? (only when non-empty) }`.
fn body_text(file: &StoreFile) -> String {
    let mut body = Map::new();
    body.insert("version".into(), js::num(file.version));
    body.insert("claude".into(), Value::Array(file.claude.iter().map(ManagedAccount::to_value).collect()));
    if let Some(live) = &file.live {
        body.insert("live".into(), live.to_value());
    }
    if !file.notices.is_empty() {
        body.insert("notices".into(), Value::Array(file.notices.iter().map(AccountNotice::to_value).collect()));
    }
    js_json::stringify_pretty(&Value::Object(body), 2)
}

/// One field change of [`AccountsStore::patch`]: `None` removes the field.
pub type FieldPatch<'a> = (&'a str, Option<Value>);

type Stamp = (Option<SystemTime>, Option<SystemTime>, u64);

/// Where new ids come from (`randomUUID`); tests and the golden corpus replace it.
pub type IdSource = Box<dyn Fn() -> String + Send + Sync>;

pub struct AccountsStore {
    root: PathBuf,
    file: PathBuf,
    /// The last successfully parsed file and the stat stamp it was read at (the usage polls ask several times per second).
    cached: Mutex<Option<(Stamp, StoreFile)>>,
    /// Serializes read-modify-write cycles of this process.
    writer: Mutex<()>,
    new_id: IdSource,
}

impl std::fmt::Debug for AccountsStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountsStore").field("root", &self.root).finish_non_exhaustive()
    }
}

fn stamp_of(path: &Path) -> Option<Stamp> {
    let info = fs::metadata(path).ok()?;
    info.is_file().then(|| (info.modified().ok(), info.created().ok(), info.len()))
}

impl AccountsStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self::with_ids(root, Box::new(|| uuid::Uuid::new_v4().to_string()))
    }

    /// A store whose new ids (prepare, notices) come from `new_id`.
    pub fn with_ids(root: impl Into<PathBuf>, new_id: IdSource) -> Self {
        let root = root.into();
        let file = root.join("accounts.json");
        Self { root, file, cached: Mutex::new(None), writer: Mutex::new(()), new_id }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn file_path(&self) -> &Path {
        &self.file
    }

    fn read(&self) -> StoreFile {
        let stamp = stamp_of(&self.file);
        if let Some(stamp) = &stamp
            && let Some((cached_stamp, file)) = &*self.cached.lock()
            && cached_stamp == stamp
        {
            return file.clone();
        }
        let mut parsed_ok = false;
        let file = self.read_file(&mut parsed_ok);
        *self.cached.lock() = match stamp {
            Some(stamp) if parsed_ok => Some((stamp, file.clone())),
            _ => None,
        };
        file
    }

    fn read_file(&self, parsed_ok: &mut bool) -> StoreFile {
        // readJsonFile: missing, unreadable, or unparsable (moved aside to a timestamped backup).
        if !self.file.exists() {
            return StoreFile::empty(false);
        }
        let text = match js::read_text(&self.file) {
            Ok(text) => text,
            Err(_) => return StoreFile::empty(self.file.exists()),
        };
        let parsed = match js_json::parse(&text) {
            Ok(v) => v,
            Err(_) => {
                let _ = fs::rename(&self.file, backup_path(&self.file));
                return StoreFile::empty(self.file.exists());
            }
        };
        // From here the answer depends on the file's content only, so it may be reused while the file is unchanged.
        *parsed_ok = true;
        let Some(m) = js::record(Some(&parsed)) else { return StoreFile::empty(true) };
        let Some(Value::Array(claude)) = m.get("claude") else { return StoreFile::empty(true) };
        let version = match m.get("version") {
            None => 1.0,
            Some(v) => match v.as_f64() {
                Some(n) if n.fract() == 0.0 && n >= 1.0 => n,
                _ => return StoreFile::empty(true),
            },
        };
        let notices = match m.get("notices") {
            None => Vec::new(),
            Some(Value::Array(items)) => items.iter().filter_map(parse_notice).collect(),
            Some(_) => return StoreFile::empty(true),
        };
        if m.get("live").is_some_and(|l| !l.is_object()) {
            return StoreFile::empty(true);
        }
        StoreFile {
            version,
            claude: claude.iter().filter_map(parse_account).collect(),
            live: parse_live(m.get("live")),
            notices,
            read_only: version > STORE_VERSION,
        }
    }

    fn change(&self, edit: impl FnOnce(&mut StoreFile)) -> Result<(), StoreError> {
        let _writer = self.writer.lock();
        let mut file = self.read();
        if file.read_only {
            return Err(StoreError::ReadOnly);
        }
        edit(&mut file);
        self.write(&file)
    }

    fn write(&self, file: &StoreFile) -> Result<(), StoreError> {
        *self.cached.lock() = None;
        fs::create_dir_all(&self.root)?;
        atomic_write(&self.file, body_text(file).as_bytes(), &AtomicWriteOptions::default())?;
        Ok(())
    }

    /// accounts.json exists but cannot be read safely (unreadable, wrong shape, newer version): every write is refused.
    pub fn read_only(&self) -> bool {
        self.read().read_only
    }

    /// Every record, quarantined ones included.
    pub fn list(&self) -> Vec<ManagedAccount> {
        self.read().claude
    }

    pub fn get(&self, id: &str) -> Option<ManagedAccount> {
        self.list().into_iter().find(|a| a.id == id)
    }

    pub fn version(&self) -> f64 {
        self.read().version
    }

    pub fn mark_migrated(&self) -> Result<(), StoreError> {
        self.change(|f| f.version = STORE_VERSION)
    }

    pub fn live(&self) -> Option<LiveIdentity> {
        self.read().live
    }

    /// Sets the live identity (validated like a read; an empty identity is kept as `{}`) or, with `None`, drops it.
    pub fn set_live(&self, live: Option<&LiveIdentity>) -> Result<(), StoreError> {
        let parsed = live.and_then(|l| parse_live(Some(&l.to_value())));
        self.change(|f| f.live = parsed)
    }

    pub fn notices(&self) -> Vec<AccountNotice> {
        self.read().notices
    }

    /// Adds a notice with a new id; only the last 20 are kept. A notice that does not validate is not added (the file is still
    /// written, as in 1.1.4).
    pub fn add_notice(&self, notice: &NewNotice) -> Result<(), StoreError> {
        let id = (self.new_id)();
        let parsed = parse_notice(&notice.to_value(id));
        self.change(|f| {
            if let Some(n) = parsed {
                f.notices.push(n);
                let extra = f.notices.len().saturating_sub(MAX_NOTICES);
                f.notices.drain(..extra);
            }
        })
    }

    pub fn dismiss_notice(&self, id: &str) -> Result<(), StoreError> {
        self.change(|f| f.notices.retain(|n| n.id != id))
    }

    /// `<root>/claude/<id>`; only account ids (lowercase UUIDs) are accepted.
    pub fn dir_of(&self, id: &str) -> Result<PathBuf, StoreError> {
        if !is_account_id(id) {
            return Err(StoreError::InvalidId);
        }
        Ok(self.root.join("claude").join(id))
    }

    /// Creates the profile directory for a login in progress; the account is not listed until [`commit`](Self::commit).
    pub fn prepare(&self) -> Result<(String, PathBuf), StoreError> {
        let id = (self.new_id)();
        let dir = self.dir_of(&id)?;
        fs::create_dir_all(&dir)?;
        Ok((id, dir))
    }

    /// Lists (or replaces) a record; it is validated first and a bad field is dropped.
    pub fn commit(&self, account: &ManagedAccount) -> Result<(), StoreError> {
        self.commit_value(&account.to_value())
    }

    /// [`commit`](Self::commit) of a record as JSON (from IPC or an older file).
    pub fn commit_value(&self, account: &Value) -> Result<(), StoreError> {
        let clean = parse_account(account).ok_or(StoreError::InvalidAccount)?;
        self.change(|f| match f.claude.iter_mut().find(|e| e.id == clean.id) {
            Some(entry) => *entry = clean,
            None => f.claude.push(clean),
        })
    }

    /// `update(id, { email?, org? })`: `None` leaves a field, `Some(None)` removes it.
    pub fn update(&self, id: &str, email: Option<Option<&str>>, org: Option<Option<&str>>) -> Result<(), StoreError> {
        let mut fields = Vec::new();
        if let Some(e) = email {
            fields.push(("email", e.map(Value::from)));
        }
        if let Some(o) = org {
            fields.push(("org", o.map(Value::from)));
        }
        self.patch(id, &fields)
    }

    /// Sets the identity fields that are given; an absent one stays, so a partial identity never erases a known uuid. With
    /// `replace` the record takes exactly this identity: absent fields are removed (the login belongs to someone else).
    pub fn update_identity(&self, id: &str, identity: &AccountIdentity, replace: bool) -> Result<(), StoreError> {
        let given = identity_fields(identity);
        let fields: Vec<FieldPatch<'_>> = crate::identity::IDENTITY_KEYS
            .iter()
            .filter_map(|key| {
                let v = given.field(key).map(Value::from);
                (replace || v.is_some()).then_some((*key, v))
            })
            .collect();
        self.patch(id, &fields)
    }

    pub fn set_custody(&self, id: &str, custody: Custody, duplicate_of: Option<&str>) -> Result<(), StoreError> {
        let dup = if custody == Custody::Quarantined { duplicate_of.map(Value::from) } else { None };
        self.patch(id, &[("custody", Some(custody.as_str().into())), ("duplicateOf", dup)])
    }

    pub fn set_family(&self, id: &str, family: TokenFamily) -> Result<(), StoreError> {
        self.patch(id, &[("family", Some(family.as_str().into()))])
    }

    /// Sets or (`None`) drops `heldTokens`; a record without it is not written again.
    pub fn set_held_tokens(&self, id: &str, hash: Option<&str>) -> Result<(), StoreError> {
        if hash.is_none() && self.get(id).and_then(|a| a.held_tokens).is_none() {
            return Ok(());
        }
        self.patch(id, &[("heldTokens", hash.map(Value::from))])
    }

    /// Sets or (`None`) drops `deadTokens`; the same value is not written again.
    pub fn set_dead_tokens(&self, id: &str, hash: Option<&str>) -> Result<(), StoreError> {
        if self.get(id).and_then(|a| a.dead_tokens).as_deref() == hash {
            return Ok(());
        }
        self.patch(id, &[("deadTokens", hash.map(Value::from))])
    }

    /// Sets or (`None`) drops `appSwap`; a record without it is not written again.
    pub fn set_app_swap(&self, id: &str, swap: Option<&AppSwap>) -> Result<(), StoreError> {
        if swap.is_none() && self.get(id).and_then(|a| a.app_swap).is_none() {
            return Ok(());
        }
        self.patch(id, &[("appSwap", swap.map(AppSwap::to_value))])
    }

    /// Forgets the record and deletes its profile directory. Copies set aside for it are released (no longer a copy of
    /// anything, still set aside); its notices and the live record id that point to it are dropped. An invalid id does nothing.
    pub fn remove(&self, id: &str) -> Result<(), StoreError> {
        if !is_account_id(id) {
            return Ok(());
        }
        let _writer = self.writer.lock();
        let file = self.read();
        if file.read_only {
            return Err(StoreError::ReadOnly);
        }
        match fs::remove_dir_all(self.dir_of(id)?) {
            Err(e) if e.kind() != io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        let released: Vec<String> =
            file.claude.iter().filter(|e| e.duplicate_of.as_deref() == Some(id)).map(|e| e.id.clone()).collect();
        let claude: Vec<ManagedAccount> = file
            .claude
            .iter()
            .filter(|e| e.id != id)
            .map(|e| {
                let mut e = e.clone();
                if released.contains(&e.id) {
                    e.duplicate_of = None;
                }
                e
            })
            .collect();
        let notices: Vec<AccountNotice> = file
            .notices
            .iter()
            .filter(|n| {
                n.record_id.as_deref() != Some(id)
                    && !(n.kind == NoticeKind::Quarantined && n.record_id.as_ref().is_some_and(|r| released.contains(r)))
            })
            .cloned()
            .collect();
        let mut live = file.live.clone();
        let mut live_changed = false;
        if let Some(l) = &mut live
            && l.record_id.as_deref() == Some(id)
        {
            l.record_id = None;
            live_changed = true;
        }
        if claude.len() == file.claude.len() && released.is_empty() && notices.len() == file.notices.len() && !live_changed {
            return Ok(());
        }
        self.write(&StoreFile { version: file.version, claude, live, notices, read_only: false })
    }

    /// Changes fields of a record (`None` removes one); the record is validated again, so a bad value never reaches the file.
    /// An unknown id changes nothing, but the file is still written (as in 1.1.4).
    pub fn patch(&self, id: &str, fields: &[FieldPatch<'_>]) -> Result<(), StoreError> {
        self.change(|f| {
            let Some(index) = f.claude.iter().position(|e| e.id == id) else { return };
            let Value::Object(mut next) = f.claude[index].to_value() else { return };
            for (key, value) in fields {
                match value {
                    None => {
                        next.shift_remove(*key);
                    }
                    Some(v) => {
                        next.insert((*key).to_string(), v.clone());
                    }
                }
            }
            if let Some(clean) = parse_account(&Value::Object(next)) {
                f.claude[index] = clean;
            }
        })
    }
}

#[cfg(test)]
mod tests;
