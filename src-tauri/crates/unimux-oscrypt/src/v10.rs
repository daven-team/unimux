//! The two Chromium OSCrypt 'v10' blob formats, as pure functions (no OS calls), so every platform tests both.
//!
//! - Windows: `v10` + 12-byte nonce + AES-256-GCM ciphertext + 16-byte tag, the key from `Local State` (see `local_state`).
//! - macOS: `v10` + AES-128-CBC (PKCS#7) with an IV of 16 spaces, the key PBKDF2-HMAC-SHA1(Keychain password, `saltysalt`,
//!   1003 rounds, 16 bytes). The IV is fixed, so the same text and password always give the same blob.

use aes::cipher::{BlockModeDecrypt, BlockModeEncrypt, KeyIvInit, block_padding::Pkcs7};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use zeroize::Zeroizing;

/// Every blob Electron 45 writes on Windows and macOS starts with these three bytes.
pub const PREFIX: &[u8] = b"v10";
pub const GCM_KEY_LEN: usize = 32;
pub const GCM_NONCE_LEN: usize = 12;
pub const GCM_TAG_LEN: usize = 16;
pub const MAC_KEY_LEN: usize = 16;
const MAC_SALT: &[u8] = b"saltysalt";
const MAC_ROUNDS: u32 = 1003;
const MAC_IV: [u8; 16] = [b' '; 16];

/// Why a blob did not decrypt. The text of Electron's error is not kept: the caller only learns "locked".
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum BlobError {
    #[error("the blob does not start with v10")]
    NoPrefix,
    #[error("the blob is too short")]
    TooShort,
    #[error("the blob does not decrypt with this key")]
    BadKey,
}

pub fn has_prefix(blob: &[u8]) -> bool {
    blob.starts_with(PREFIX)
}

/// Windows encrypt with a caller-chosen nonce (random in production, fixed in golden tests).
pub fn gcm_encrypt(key: &[u8; GCM_KEY_LEN], nonce: &[u8; GCM_NONCE_LEN], plaintext: &[u8]) -> Vec<u8> {
    let cipher = Aes256Gcm::new(key.into());
    let sealed = cipher.encrypt(&Nonce::from(*nonce), plaintext).expect("AES-GCM encrypt of an in-memory buffer cannot fail");
    let mut blob = Vec::with_capacity(PREFIX.len() + GCM_NONCE_LEN + sealed.len());
    blob.extend_from_slice(PREFIX);
    blob.extend_from_slice(nonce);
    blob.extend_from_slice(&sealed);
    blob
}

pub fn gcm_decrypt(key: &[u8; GCM_KEY_LEN], blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, BlobError> {
    let rest = blob.strip_prefix(PREFIX).ok_or(BlobError::NoPrefix)?;
    if rest.len() < GCM_NONCE_LEN + GCM_TAG_LEN {
        return Err(BlobError::TooShort);
    }
    let (nonce, sealed) = rest.split_at(GCM_NONCE_LEN);
    let nonce: [u8; GCM_NONCE_LEN] = nonce.try_into().expect("split_at gave 12 bytes");
    let cipher = Aes256Gcm::new(key.into());
    cipher.decrypt(&Nonce::from(nonce), sealed).map(Zeroizing::new).map_err(|_| BlobError::BadKey)
}

/// macOS: the AES-128 key from the Keychain password (the password bytes as stored, base64 text in practice).
pub fn mac_key(password: &[u8]) -> Zeroizing<[u8; MAC_KEY_LEN]> {
    let mut key = Zeroizing::new([0u8; MAC_KEY_LEN]);
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, MAC_SALT, MAC_ROUNDS, key.as_mut());
    key
}

pub fn cbc_encrypt(key: &[u8; MAC_KEY_LEN], plaintext: &[u8]) -> Vec<u8> {
    let sealed = cbc::Encryptor::<aes::Aes128>::new(key.into(), &MAC_IV.into()).encrypt_padded_vec::<Pkcs7>(plaintext);
    let mut blob = Vec::with_capacity(PREFIX.len() + sealed.len());
    blob.extend_from_slice(PREFIX);
    blob.extend_from_slice(&sealed);
    blob
}

pub fn cbc_decrypt(key: &[u8; MAC_KEY_LEN], blob: &[u8]) -> Result<Zeroizing<Vec<u8>>, BlobError> {
    let sealed = blob.strip_prefix(PREFIX).ok_or(BlobError::NoPrefix)?;
    if sealed.is_empty() || !sealed.len().is_multiple_of(16) {
        return Err(BlobError::TooShort);
    }
    cbc::Decryptor::<aes::Aes128>::new(key.into(), &MAC_IV.into())
        .decrypt_padded_vec::<Pkcs7>(sealed)
        .map(Zeroizing::new)
        .map_err(|_| BlobError::BadKey)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gcm_round_trip_and_layout() {
        let key = [7u8; 32];
        let nonce = [9u8; 12];
        let blob = gcm_encrypt(&key, &nonce, "zażółć".as_bytes());
        assert_eq!(&blob[..3], b"v10");
        assert_eq!(&blob[3..15], &nonce);
        assert_eq!(blob.len(), 3 + 12 + "zażółć".len() + 16);
        assert_eq!(gcm_decrypt(&key, &blob).unwrap().as_slice(), "zażółć".as_bytes());
        assert_eq!(gcm_decrypt(&[8u8; 32], &blob), Err(BlobError::BadKey));
        assert_eq!(gcm_decrypt(&key, b"v10short"), Err(BlobError::TooShort));
        assert_eq!(gcm_decrypt(&key, b"v20aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), Err(BlobError::NoPrefix));
        let mut tampered = blob.clone();
        *tampered.last_mut().unwrap() ^= 1;
        assert_eq!(gcm_decrypt(&key, &tampered), Err(BlobError::BadKey));
    }

    #[test]
    fn cbc_round_trip_is_deterministic() {
        let key = mac_key(b"password");
        let a = cbc_encrypt(&key, b"hello");
        assert_eq!(a, cbc_encrypt(&key, b"hello"));
        assert_eq!(a.len(), 3 + 16);
        assert_eq!(cbc_decrypt(&key, &a).unwrap().as_slice(), b"hello");
        assert_eq!(cbc_decrypt(&key, &a[..10]), Err(BlobError::TooShort));
        assert!(cbc_decrypt(&mac_key(b"other"), &a).is_err());
        // An empty text still gives one padding block, like Chromium.
        assert_eq!(cbc_encrypt(&key, b"").len(), 3 + 16);
    }
}
