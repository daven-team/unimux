//! keys.ts `KeyDrafts`: imports in progress (spec 7.2). The private text stays here until it is committed or discarded (10
//! minutes at most, 20 drafts at most: a new one evicts the oldest, D3). A DraftResult never carries private material.

use serde::Serialize;
use zeroize::Zeroizing;

use super::parse::{CertCheck, ParseError, certificate_check, parse_private_key, public_key_matches};
use super::{KeyAlgo, KeyMeta, PRIVATE_KEY_LIMIT};
use crate::keys::js::js_trim;

/// MAX_KEY_DRAFTS.
pub const MAX_KEY_DRAFTS: usize = 20;
/// The draft lifetime of 1.1.4 (10 minutes).
pub const DRAFT_TTL_MS: u64 = 10 * 60_000;

/// shared/ssh.ts DraftError.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DraftError {
    TooLarge,
    NotAKey,
    PublicOnly,
    PpkV3,
    UnsupportedType,
    BadPassphrase,
    Mismatch,
    CertMismatch,
    ReadFailed,
    Invalid,
}

impl From<ParseError> for DraftError {
    fn from(e: ParseError) -> DraftError {
        match e {
            ParseError::TooLarge => DraftError::TooLarge,
            ParseError::NotAKey => DraftError::NotAKey,
            ParseError::PublicOnly => DraftError::PublicOnly,
            ParseError::PpkV3 => DraftError::PpkV3,
            ParseError::UnsupportedType => DraftError::UnsupportedType,
            // needsPassphrase never reaches a DraftResult as an error (evaluate turns it into a locked draft).
            ParseError::BadPassphrase | ParseError::NeedsPassphrase => DraftError::BadPassphrase,
        }
    }
}

/// shared/ssh.ts DraftResult, serialized with the key order of the object literals in keys.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(untagged)]
pub enum DraftResult {
    Ok(DraftOk),
    Err(DraftErr),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftOk {
    pub ok: True,
    pub draft_id: String,
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub key_type: Option<KeyAlgo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bits: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint: Option<String>,
    pub comment: String,
    pub encrypted: bool,
    pub needs_passphrase: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub public_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub certificate_warning: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duplicate_of: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct DraftErr {
    pub ok: False,
    pub error: DraftError,
}

/// The literal `true` of `ok`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct True;

impl Serialize for True {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bool(true)
    }
}

/// The literal `false` of `ok`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct False;

impl Serialize for False {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_bool(false)
    }
}

impl DraftResult {
    pub fn err(error: DraftError) -> DraftResult {
        DraftResult::Err(DraftErr { ok: False, error })
    }

    pub fn is_ok(&self) -> bool {
        matches!(self, DraftResult::Ok(_))
    }

    pub fn draft_id(&self) -> Option<&str> {
        match self {
            DraftResult::Ok(o) => Some(&o.draft_id),
            DraftResult::Err(_) => None,
        }
    }
}

struct Draft {
    text: Zeroizing<String>,
    public_key: Option<String>,
    certificate: Option<String>,
    meta: Option<KeyMeta>,
    encrypted: bool,
    passphrase: Option<Zeroizing<String>>,
    created: u64,
}

/// keys.ts ReadyDraft: a parsed, unlocked draft taken out to be stored.
pub struct ReadyDraft {
    pub text: Zeroizing<String>,
    pub meta: KeyMeta,
    pub encrypted: bool,
    pub passphrase: Option<Zeroizing<String>>,
    pub certificate: Option<String>,
}

/// `create`'s input (the draftFromText request).
#[derive(Debug, Default, Clone)]
pub struct DraftInput {
    pub private_key: Zeroizing<String>,
    pub public_key: Option<String>,
    pub certificate: Option<String>,
}

type Clock = Box<dyn Fn() -> u64 + Send + Sync>;

/// Imports in progress, oldest first (the Map insertion order of 1.1.4).
pub struct KeyDrafts {
    drafts: Vec<(String, Draft)>,
    now: Clock,
    ttl_ms: u64,
}

impl Default for KeyDrafts {
    fn default() -> Self {
        KeyDrafts::new()
    }
}

fn epoch_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64)
}

/// `value?.trim() || undefined`.
fn trimmed_or_none(value: Option<&str>) -> Option<String> {
    value.map(js_trim).filter(|s| !s.is_empty()).map(str::to_string)
}

impl KeyDrafts {
    pub fn new() -> KeyDrafts {
        KeyDrafts::with_clock(Box::new(epoch_ms), DRAFT_TTL_MS)
    }

    /// A clock in milliseconds and a lifetime, for tests (`new KeyDrafts(now, ttlMs)`).
    pub fn with_clock(now: Clock, ttl_ms: u64) -> KeyDrafts {
        KeyDrafts { drafts: Vec::new(), now, ttl_ms }
    }

    pub fn len(&self) -> usize {
        self.drafts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.drafts.is_empty()
    }

    fn sweep(&mut self) {
        let now = (self.now)();
        let ttl = self.ttl_ms;
        self.drafts.retain(|(_, d)| now.saturating_sub(d.created) <= ttl);
    }

    fn position(&self, id: &str) -> Option<usize> {
        self.drafts.iter().position(|(k, _)| k == id)
    }

    /// `create(input, duplicateOf)`.
    pub fn create(&mut self, input: DraftInput, duplicate_of: &dyn Fn(&str) -> Option<String>) -> DraftResult {
        self.sweep();
        if input.private_key.len() > PRIVATE_KEY_LIMIT {
            return DraftResult::err(DraftError::TooLarge);
        }
        let mut draft = Draft {
            public_key: trimmed_or_none(input.public_key.as_deref()),
            certificate: trimmed_or_none(input.certificate.as_deref()),
            text: input.private_key,
            meta: None,
            encrypted: false,
            passphrase: None,
            created: (self.now)(),
        };
        let id = uuid::Uuid::new_v4().to_string();
        let result = evaluate(&id, &mut draft, None, duplicate_of);
        if result.is_ok() {
            while self.drafts.len() >= MAX_KEY_DRAFTS {
                self.drafts.remove(0);
            }
            self.drafts.push((id, draft));
        }
        result
    }

    /// `unlock(draftId, passphrase, duplicateOf)`.
    pub fn unlock(&mut self, draft_id: &str, passphrase: &str, duplicate_of: &dyn Fn(&str) -> Option<String>) -> DraftResult {
        self.sweep();
        let Some(i) = self.position(draft_id) else { return DraftResult::err(DraftError::ReadFailed) };
        let (id, draft) = &mut self.drafts[i];
        evaluate(id, draft, Some(passphrase), duplicate_of)
    }

    /// `take(draftId)`: removes and returns a draft that is ready to be stored (parsed, unlocked); None otherwise.
    pub fn take(&mut self, draft_id: &str) -> Option<ReadyDraft> {
        self.sweep();
        let i = self.position(draft_id)?;
        self.drafts[i].1.meta.as_ref()?;
        let (_, d) = self.drafts.remove(i);
        Some(ReadyDraft {
            text: d.text,
            meta: d.meta?,
            encrypted: d.encrypted,
            passphrase: d.passphrase,
            certificate: d.certificate,
        })
    }

    /// `discard(draftId)`.
    pub fn discard(&mut self, draft_id: &str) {
        if let Some(i) = self.position(draft_id) {
            self.drafts.remove(i);
        }
    }
}

/// keys.ts `KeyDrafts.evaluate`.
fn evaluate(id: &str, draft: &mut Draft, passphrase: Option<&str>, duplicate_of: &dyn Fn(&str) -> Option<String>) -> DraftResult {
    let parsed = match parse_private_key(&draft.text, passphrase) {
        Ok(p) => p,
        Err(f) if f.error == ParseError::NeedsPassphrase => {
            draft.encrypted = true;
            return DraftResult::Ok(DraftOk {
                ok: True,
                draft_id: id.to_string(),
                key_type: None,
                bits: None,
                fingerprint: None,
                comment: String::new(),
                encrypted: true,
                needs_passphrase: true,
                public_key: None,
                certificate_warning: None,
                duplicate_of: None,
            });
        }
        Err(f) => return DraftResult::err(f.error.into()),
    };
    if let Some(public) = &draft.public_key
        && !public_key_matches(&parsed.meta, public)
    {
        return DraftResult::err(DraftError::Mismatch);
    }
    let cert = draft.certificate.as_deref().map_or(CertCheck::Match, |c| certificate_check(c, &parsed.meta));
    if cert == CertCheck::Mismatch {
        return DraftResult::err(DraftError::CertMismatch);
    }
    let meta = parsed.meta;
    draft.encrypted = parsed.encrypted;
    draft.passphrase = if parsed.encrypted { passphrase.map(|p| Zeroizing::new(p.to_string())) } else { None };
    let duplicate = duplicate_of(&meta.fingerprint);
    let result = DraftOk {
        ok: True,
        draft_id: id.to_string(),
        key_type: Some(meta.key_type),
        bits: Some(meta.bits),
        fingerprint: Some(meta.fingerprint.clone()),
        comment: meta.comment.clone(),
        encrypted: parsed.encrypted,
        needs_passphrase: false,
        public_key: Some(meta.public_key.clone()),
        certificate_warning: (cert == CertCheck::Doubt).then_some(true),
        duplicate_of: duplicate,
    };
    draft.meta = Some(meta);
    DraftResult::Ok(result)
}
