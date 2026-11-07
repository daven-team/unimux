//! keys.ts `parsePrivateKey`, `keyMetaFromPublic`, `checkPassphrase`, `publicKeyMatches`, `certificateCheck` and their
//! helpers (`metaOf`, `isEncrypted`), over the ssh2 port in [`super::ssh2`].

use std::sync::LazyLock;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use regex::Regex;
use russh::keys::PrivateKey;
use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use super::js::{clean_comment, js_lines, js_regex, js_trim, node_base64, word_end};
use super::ssh2::{self, Fail, Loaded};
use super::wire::{bits_of, fields, sha256_fingerprint, ssh_string};
use super::{KeyAlgo, KeyMeta, PRIVATE_KEY_LIMIT};

/// The error codes of keys.ts ParseResult (DraftError's key part plus `needsPassphrase`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ParseError {
    TooLarge,
    NotAKey,
    PublicOnly,
    PpkV3,
    UnsupportedType,
    BadPassphrase,
    NeedsPassphrase,
}

impl ParseError {
    pub fn as_str(self) -> &'static str {
        match self {
            ParseError::TooLarge => "tooLarge",
            ParseError::NotAKey => "notAKey",
            ParseError::PublicOnly => "publicOnly",
            ParseError::PpkV3 => "ppkV3",
            ParseError::UnsupportedType => "unsupportedType",
            ParseError::BadPassphrase => "badPassphrase",
            ParseError::NeedsPassphrase => "needsPassphrase",
        }
    }
}

/// `{ ok: false, error, encrypted? }`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParseFailure {
    pub error: ParseError,
    pub encrypted: Option<bool>,
}

impl ParseFailure {
    fn plain(error: ParseError) -> ParseFailure {
        ParseFailure { error, encrypted: None }
    }

    fn locked(error: ParseError) -> ParseFailure {
        ParseFailure { error, encrypted: Some(true) }
    }
}

/// `{ ok: true, meta, encrypted }`, plus the key itself for the login core (S3).
pub struct Parsed {
    pub meta: KeyMeta,
    pub encrypted: bool,
    pub key: Box<PrivateKey>,
}

impl std::fmt::Debug for Parsed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Parsed").field("meta", &self.meta).field("encrypted", &self.encrypted).finish_non_exhaustive()
    }
}

fn openssh_cipher_is_not_none(text: &str) -> bool {
    const BEGIN: &str = "-----BEGIN OPENSSH PRIVATE KEY-----";
    const END: &str = "-----END OPENSSH PRIVATE KEY-----";
    // /-----BEGIN OPENSSH PRIVATE KEY-----([\s\S]+?)-----END OPENSSH PRIVATE KEY-----/: at least one character between.
    let Some(from) = text.find(BEGIN).map(|i| i + BEGIN.len()) else { return false };
    let Some(first) = text[from..].chars().next() else { return false };
    let Some(len) = text[from + first.len_utf8()..].find(END).map(|i| i + first.len_utf8()) else { return false };
    // The whole body: an unencrypted key's private part is in it.
    let raw = Zeroizing::new(node_base64(&text[from..from + len]));
    let magic = "openssh-key-v1\0".len();
    if raw.len() < magic + 4 {
        return false;
    }
    let n = u32::from_be_bytes([raw[magic], raw[magic + 1], raw[magic + 2], raw[magic + 3]]) as usize;
    let end = (magic + 4).saturating_add(n).min(raw.len());
    &raw[magic + 4..end] != b"none"
}

/// keys.ts `isEncrypted`: PEM Proc-Type, PPK Encryption, OpenSSH cipher name; decided without the passphrase.
pub fn is_encrypted(text: &str) -> bool {
    if js_lines(text).any(|l| l.starts_with("Proc-Type: 4,ENCRYPTED")) {
        return true;
    }
    let not_none = |rest: &str| !(rest.starts_with("none") && word_end(&rest[4..]));
    if js_lines(text).any(|l| l.strip_prefix("Encryption: ").is_some_and(not_none)) {
        return true;
    }
    openssh_cipher_is_not_none(text)
}

/// keys.ts `metaOf`: None for a type outside KEY_ALGOS.
fn meta_of(key: &PrivateKey) -> Option<KeyMeta> {
    let key_type = KeyAlgo::from_name(key.algorithm().as_str())?;
    let blob = key.public_key().to_bytes().ok()?;
    let comment = clean_comment(&String::from_utf8_lossy(key.comment().as_bytes()));
    let b64 = STANDARD.encode(&blob);
    let public_key = if comment.is_empty() {
        format!("{} {b64}", key_type.as_str())
    } else {
        format!("{} {b64} {comment}", key_type.as_str())
    };
    Some(KeyMeta { key_type, bits: bits_of(key_type, &blob), fingerprint: sha256_fingerprint(&blob), public_key, comment, blob })
}

/// keys.ts `parsePrivateKey(text, passphrase)`. `passphrase` as the caller has it: an empty one is no passphrase to keys.ts
/// (JS truthiness) but still reaches ssh2 like in 1.1.4.
pub fn parse_private_key(text: &str, passphrase: Option<&str>) -> Result<Parsed, ParseFailure> {
    if text.len() > PRIVATE_KEY_LIMIT {
        return Err(ParseFailure::plain(ParseError::TooLarge));
    }
    let trimmed = js_trim(text);
    if js_lines(trimmed).any(|l| l.starts_with("PuTTY-User-Key-File-3:")) {
        return Err(ParseFailure::plain(ParseError::PpkV3));
    }
    let ppk2_other = |l: &str| {
        l.strip_prefix("PuTTY-User-Key-File-2: ")
            .is_some_and(|rest| !(rest.starts_with("ssh-rsa") && word_end(&rest["ssh-rsa".len()..])))
    };
    if js_lines(trimmed).any(ppk2_other) {
        return Err(ParseFailure::plain(ParseError::UnsupportedType));
    }
    let encrypted = is_encrypted(trimmed);
    let truthy = passphrase.is_some_and(|p| !p.is_empty());
    match ssh2::parse_key(trimmed, passphrase) {
        Err(Fail::NoPassphrase) => Err(ParseFailure::locked(ParseError::NeedsPassphrase)),
        Err(Fail::Other(_)) if encrypted => {
            Err(ParseFailure::locked(if truthy { ParseError::BadPassphrase } else { ParseError::NeedsPassphrase }))
        }
        Err(Fail::Other(_)) => Err(ParseFailure::plain(ParseError::NotAKey)),
        Ok(Loaded::Nothing) => Err(ParseFailure::plain(ParseError::NotAKey)),
        Ok(Loaded::Public { .. }) => Err(ParseFailure::plain(ParseError::PublicOnly)),
        Ok(Loaded::OtherPrivate { .. }) => Err(ParseFailure::plain(ParseError::UnsupportedType)),
        Ok(Loaded::Private(key)) => match meta_of(&key) {
            Some(meta) => Ok(Parsed { meta, encrypted, key }),
            None => Err(ParseFailure::plain(ParseError::UnsupportedType)),
        },
    }
}

/// keys.ts `checkPassphrase`.
pub fn check_passphrase(private_key: &str, passphrase: &str) -> bool {
    parse_private_key(private_key, Some(passphrase)).is_ok()
}

/// keys.ts `keyMetaFromPublic`: the metadata of a stored key rebuilt from its public line (the comment as written, the
/// trimmed line as `public_key`).
pub fn key_meta_from_public(line: &str) -> Option<KeyMeta> {
    let line = js_trim(line);
    let loaded = ssh2::parse_key(line, None).ok()?;
    let key_type = KeyAlgo::from_name(&loaded.key_type())?;
    let blob = loaded.blob();
    Some(KeyMeta {
        key_type,
        bits: bits_of(key_type, &blob),
        fingerprint: sha256_fingerprint(&blob),
        public_key: line.to_string(),
        comment: loaded.comment(),
        blob,
    })
}

/// keys.ts `publicKeyMatches`: whatever ssh2 reads from the text (a public line, RFC 4716, even an unencrypted private
/// key) has the blob of `meta`.
pub fn public_key_matches(meta: &KeyMeta, public_text: &str) -> bool {
    ssh2::parse_key(js_trim(public_text), None).is_ok_and(|k| k.blob() == meta.blob)
}

/// The answer of keys.ts `certificateCheck`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum CertCheck {
    Match,
    Mismatch,
    Doubt,
}

static CERT: LazyLock<Regex> =
    LazyLock::new(|| js_regex(r"^([a-z0-9-]+)-cert-v01@openssh\.com\s+([A-Za-z0-9+/]+={0,2})(?:\s.*)?$"));

/// keys.ts `certificateCheck`: compares the key embedded in an OpenSSH user certificate with the private key (D9: stored,
/// not used to sign in).
pub fn certificate_check(cert: &str, meta: &KeyMeta) -> CertCheck {
    let Some(m) = CERT.captures(js_trim(cert)) else { return CertCheck::Mismatch };
    if &m[1] != meta.key_type.as_str() {
        return CertCheck::Mismatch;
    }
    let raw = node_base64(&m[2]);
    let Some((_, head_end)) = fields(&raw, 2, 0) else { return CertCheck::Doubt };
    let count = if meta.key_type == KeyAlgo::Ed25519 { 1 } else { 2 };
    let Some((key, _)) = fields(&raw, count, head_end) else { return CertCheck::Doubt };
    let mut blob = ssh_string(meta.key_type.as_str().as_bytes());
    for part in key {
        blob.extend_from_slice(part);
    }
    if blob == meta.blob { CertCheck::Match } else { CertCheck::Mismatch }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_encrypted_reads_the_text_like_keys_ts() {
        assert!(is_encrypted("x\rProc-Type: 4,ENCRYPTED"));
        assert!(is_encrypted("Encryption: aes256-cbc"));
        assert!(is_encrypted("Encryption: nonex"));
        assert!(!is_encrypted("Encryption: none"));
        assert!(!is_encrypted("Encryption: none-x"));
        assert!(!is_encrypted("-----BEGIN OPENSSH PRIVATE KEY----------END OPENSSH PRIVATE KEY-----"));
    }

    #[test]
    fn refusals_before_the_key_readers() {
        let err = |t: &str, p: Option<&str>| parse_private_key(t, p).err().map(|f| (f.error, f.encrypted));
        assert_eq!(err(&"x".repeat(64 * 1024 + 1), None), Some((ParseError::TooLarge, None)));
        assert_eq!(err("hello", None), Some((ParseError::NotAKey, None)));
        assert_eq!(
            err("PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: x\n", None),
            Some((ParseError::PpkV3, None))
        );
        assert_eq!(
            err("PuTTY-User-Key-File-2: ssh-ed25519\nEncryption: none\nComment: x\n", None),
            Some((ParseError::UnsupportedType, None))
        );
        assert_eq!(
            err("x\nProc-Type: 4,ENCRYPTED\n", Some("")),
            Some((ParseError::NeedsPassphrase, Some(true))),
            "an empty passphrase is none to keys.ts"
        );
        assert_eq!(err("x\nProc-Type: 4,ENCRYPTED\n", Some("p")), Some((ParseError::BadPassphrase, Some(true))));
    }
}
