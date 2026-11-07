//! keys.ts `generateKey`: a new key pair written like ssh2 1.17's `generateKeyPair` writes it (OpenSSH format, one key,
//! aes256-ctr + bcrypt 16 rounds with a 16-byte salt when a passphrase is given, base64 cut into 64-character lines, a
//! trailing newline), read back with the same parser before it is returned. Key material comes from ssh-key (ed25519-dalek,
//! the RustCrypto NIST curves and RSA) with the OS random generator.

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use rand_core::UnwrapErr;
use russh::keys::ssh_key::{Algorithm, EcdsaCurve, HashAlg, PrivateKey};
use zeroize::Zeroizing;

use super::parse::parse_private_key;
use super::{KeyMeta, KeyType};

/// What `generateKey` gets (GenerateKeyRequest minus the vault fields).
#[derive(Debug, Clone)]
pub struct KeyGenRequest {
    pub key_type: KeyType,
    /// Ignored for ed25519; None = DEFAULT_KEY_BITS.
    pub bits: Option<u32>,
    pub comment: String,
    /// None or empty: an unencrypted key (JS truthiness).
    pub passphrase: Option<Zeroizing<String>>,
}

pub struct GeneratedKey {
    pub private_key: Zeroizing<String>,
    pub meta: KeyMeta,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GenerateError {
    /// "unsupported key size": the size is not one of KEY_SIZES.
    UnsupportedKeySize,
    /// "generated key does not parse", or the generator failed.
    Failed(String),
}

impl std::fmt::Display for GenerateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            GenerateError::UnsupportedKeySize => f.write_str("unsupported key size"),
            GenerateError::Failed(why) => f.write_str(why),
        }
    }
}

impl std::error::Error for GenerateError {}

/// The OpenSSH armor of ssh2's keygen: 64-character lines, each ended by a newline.
fn armor(binary: &[u8]) -> Zeroizing<String> {
    let b64 = Zeroizing::new(STANDARD.encode(binary));
    let mut out = Zeroizing::new(String::with_capacity(b64.len() + b64.len() / 64 + 80));
    out.push_str("-----BEGIN OPENSSH PRIVATE KEY-----\n");
    for chunk in b64.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push('\n');
    }
    out.push_str("-----END OPENSSH PRIVATE KEY-----\n");
    out
}

fn one_key(algorithm: &Algorithm, bits: u32, comment: &str, passphrase: Option<&str>) -> Result<Zeroizing<String>, String> {
    let mut rng = UnwrapErr(getrandom::SysRng);
    let mut key = match algorithm {
        Algorithm::Rsa { .. } => {
            let pair = russh::keys::ssh_key::private::RsaKeypair::random(&mut rng, bits as usize).map_err(|e| e.to_string())?;
            PrivateKey::new(pair.into(), comment).map_err(|e| e.to_string())?
        }
        _ => PrivateKey::random(&mut rng, algorithm.clone()).map_err(|e| e.to_string())?,
    };
    key.set_comment(comment);
    if let Some(pass) = passphrase {
        key = key.encrypt(&mut rng, pass).map_err(|e| e.to_string())?;
    }
    Ok(armor(&key.to_bytes().map_err(|e| e.to_string())?))
}

/// `generateKey` on the calling thread (RSA 4096 takes seconds: use [`generate_key`] from async code).
pub fn generate_key_blocking(req: &KeyGenRequest) -> Result<GeneratedKey, GenerateError> {
    let bits = match req.key_type {
        KeyType::Ed25519 => 256,
        t => req.bits.unwrap_or(t.default_bits()),
    };
    if !req.key_type.sizes().contains(&bits) {
        return Err(GenerateError::UnsupportedKeySize);
    }
    let algorithm = match (req.key_type, bits) {
        (KeyType::Ed25519, _) => Algorithm::Ed25519,
        (KeyType::Ecdsa, 384) => Algorithm::Ecdsa { curve: EcdsaCurve::NistP384 },
        (KeyType::Ecdsa, 521) => Algorithm::Ecdsa { curve: EcdsaCurve::NistP521 },
        (KeyType::Ecdsa, _) => Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 },
        (KeyType::Rsa, _) => Algorithm::Rsa { hash: Some(HashAlg::Sha512) },
    };
    let passphrase = req.passphrase.as_deref().map(String::as_str).filter(|p| !p.is_empty());
    // 1.1.4 generates again when ssh2 cannot read its own key back (about 1 in 200); the port keeps the read-back check.
    let mut last = String::from("generated key does not parse");
    for _ in 0..5 {
        match one_key(&algorithm, bits, &req.comment, passphrase) {
            Ok(text) => {
                if let Ok(parsed) = parse_private_key(&text, passphrase) {
                    return Ok(GeneratedKey { private_key: text, meta: parsed.meta });
                }
            }
            Err(why) => last = why,
        }
    }
    Err(GenerateError::Failed(last))
}

/// `generateKey`: runs on the blocking pool so the async runtime stays responsive while RSA 4096 is generated.
pub async fn generate_key(req: KeyGenRequest) -> Result<GeneratedKey, GenerateError> {
    tokio::task::spawn_blocking(move || generate_key_blocking(&req)).await.map_err(|e| GenerateError::Failed(e.to_string()))?
}
