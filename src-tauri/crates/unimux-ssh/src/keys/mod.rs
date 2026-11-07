//! SSH key material (S2, 1.1.4 src/main/ssh/keys.ts + fingerprint.ts): parsing, generation, import drafts. Private text
//! never leaves this crate's callers in main; nothing here logs key material.
//!
//! Parity rules come from SP7 (docs/tauri/spikes/SP7.md): ssh2 1.17 decides which texts are keys and how
//! ([`ssh2`]), russh / ssh-key read the key data, own code reads traditional encrypted PEM ([`legacy_pem`]), and the 1.1.4
//! answer rules sit around it ([`parse`]).

pub mod drafts;
pub mod generate;
pub mod js;
mod legacy_pem;
pub mod parse;
pub mod ssh2;
pub mod wire;

use serde::{Deserialize, Serialize};

pub use drafts::{DRAFT_TTL_MS, DraftError, DraftInput, DraftOk, DraftResult, KeyDrafts, MAX_KEY_DRAFTS, ReadyDraft};
pub use generate::{GenerateError, GeneratedKey, KeyGenRequest, generate_key, generate_key_blocking};
pub use parse::{
    CertCheck, ParseError, ParseFailure, Parsed, certificate_check, check_passphrase, is_encrypted, key_meta_from_public,
    parse_private_key, public_key_matches,
};
pub use wire::{key_type_of_blob, sha256_fingerprint};

/// SSH_LIMITS.privateKey: the largest private key text (UTF-8 bytes) 1.1.4 reads.
pub const PRIVATE_KEY_LIMIT: usize = 64 * 1024;

/// SshKeyAlgo: the key types 1.1.4 stores (KEY_ALGOS, in that order).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum KeyAlgo {
    #[serde(rename = "ssh-ed25519")]
    Ed25519,
    #[serde(rename = "ecdsa-sha2-nistp256")]
    EcdsaP256,
    #[serde(rename = "ecdsa-sha2-nistp384")]
    EcdsaP384,
    #[serde(rename = "ecdsa-sha2-nistp521")]
    EcdsaP521,
    #[serde(rename = "ssh-rsa")]
    Rsa,
}

impl KeyAlgo {
    pub const ALL: [KeyAlgo; 5] = [KeyAlgo::Ed25519, KeyAlgo::EcdsaP256, KeyAlgo::EcdsaP384, KeyAlgo::EcdsaP521, KeyAlgo::Rsa];

    pub fn as_str(self) -> &'static str {
        match self {
            KeyAlgo::Ed25519 => "ssh-ed25519",
            KeyAlgo::EcdsaP256 => "ecdsa-sha2-nistp256",
            KeyAlgo::EcdsaP384 => "ecdsa-sha2-nistp384",
            KeyAlgo::EcdsaP521 => "ecdsa-sha2-nistp521",
            KeyAlgo::Rsa => "ssh-rsa",
        }
    }

    /// `KEY_ALGOS.includes(type)`.
    pub fn from_name(name: &str) -> Option<KeyAlgo> {
        KeyAlgo::ALL.into_iter().find(|a| a.as_str() == name)
    }
}

/// SshKeyType: what the generator offers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum KeyType {
    Ed25519,
    Ecdsa,
    Rsa,
}

impl KeyType {
    /// KEY_SIZES (the order the UI lists them in).
    pub fn sizes(self) -> &'static [u32] {
        match self {
            KeyType::Ed25519 => &[256],
            KeyType::Ecdsa => &[256, 384, 521],
            KeyType::Rsa => &[3072, 4096, 2048],
        }
    }

    /// DEFAULT_KEY_BITS.
    pub fn default_bits(self) -> u32 {
        match self {
            KeyType::Ed25519 => 256,
            KeyType::Ecdsa => 256,
            KeyType::Rsa => 3072,
        }
    }
}

/// keys.ts KeyMeta.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyMeta {
    pub key_type: KeyAlgo,
    pub bits: u32,
    pub fingerprint: String,
    /// `<type> <base64 blob>[ <comment>]` (for a public line read back: the trimmed line itself).
    pub public_key: String,
    pub comment: String,
    pub blob: Vec<u8>,
}
