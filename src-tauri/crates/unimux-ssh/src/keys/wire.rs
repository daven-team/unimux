//! SSH wire helpers of 1.1.4: ssh2's `readString`, keys.ts `fields` / `sshString` / `bitsOf`, fingerprint.ts.

use base64::Engine;
use base64::engine::general_purpose::STANDARD_NO_PAD;
use sha2::{Digest, Sha256};

use super::KeyAlgo;

/// ssh2's `readString(buffer, start)`: the field at `start` and the offset after it; None when `start` is at or past the
/// end, fewer than 4 bytes are left or the length runs past the end.
pub fn read_string(buf: &[u8], start: usize) -> Option<(&[u8], usize)> {
    if start >= buf.len() || buf.len() - start < 4 {
        return None;
    }
    let len = u32::from_be_bytes(buf[start..start + 4].try_into().ok()?) as usize;
    if buf.len() - start - 4 < len {
        return None;
    }
    let end = start + 4 + len;
    Some((&buf[start + 4..end], end))
}

/// ssh2's `skipFields(buf, n)` from `start`: the offset after `n` fields, None when one is cut.
pub fn skip_fields(buf: &[u8], start: usize, n: usize) -> Option<usize> {
    let mut pos = start;
    for _ in 0..n {
        let (_, end) = read_string(buf, pos)?;
        pos = end;
    }
    Some(pos)
}

/// keys.ts `sshString`: a 4-byte big-endian length and the bytes.
pub fn ssh_string(value: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + value.len());
    out.extend_from_slice(&(value.len() as u32).to_be_bytes());
    out.extend_from_slice(value);
    out
}

/// keys.ts `fields(blob, count, from)`: each field with its length prefix, and the offset after the last. Fails where the
/// TS code throws (`readUInt32BE` past the end, or a field longer than the rest).
pub fn fields(blob: &[u8], count: usize, from: usize) -> Option<(Vec<&[u8]>, usize)> {
    let mut parts = Vec::with_capacity(count);
    let mut off = from;
    for _ in 0..count {
        let n = u32::from_be_bytes(blob.get(off..off.checked_add(4)?)?.try_into().ok()?) as usize;
        let end = off.checked_add(4)?.checked_add(n)?;
        if end > blob.len() {
            return None;
        }
        parts.push(&blob[off..end]);
        off = end;
    }
    Some((parts, off))
}

/// keys.ts `bitsOf`: 256 for ed25519, the curve size for ECDSA, the modulus length (leading zero bytes skipped) for RSA.
pub fn bits_of(algo: KeyAlgo, blob: &[u8]) -> u32 {
    match algo {
        KeyAlgo::Ed25519 => 256,
        KeyAlgo::EcdsaP256 => 256,
        KeyAlgo::EcdsaP384 => 384,
        KeyAlgo::EcdsaP521 => 521,
        KeyAlgo::Rsa => {
            // An RSA blob ssh2 or russh built always has three fields; a cut one counts as 0 bits.
            let Some((parts, _)) = fields(blob, 3, 0) else { return 0 };
            let n = &parts[2][4..];
            let first = n.iter().position(|&b| b != 0).unwrap_or(n.len());
            let n = &n[first..];
            match n.first() {
                Some(&lead) => (n.len() as u32 - 1) * 8 + (8 - lead.leading_zeros()),
                None => 0,
            }
        }
    }
}

/// fingerprint.ts `sha256Fingerprint`: `SHA256:` and the unpadded base64 of the SHA-256 of the blob (the OpenSSH format).
pub fn sha256_fingerprint(blob: &[u8]) -> String {
    format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(blob)))
}

/// fingerprint.ts `keyTypeOfBlob`: the first SSH string of a public key blob ("ssh-ed25519", "ecdsa-sha2-nistp256",
/// "ssh-rsa" ...); None when malformed.
pub fn key_type_of_blob(blob: &[u8]) -> Option<String> {
    if blob.len() < 4 {
        return None;
    }
    let length = u32::from_be_bytes(blob[0..4].try_into().ok()?) as usize;
    if !(1..=64).contains(&length) || 4 + length > blob.len() {
        return None;
    }
    let ty = &blob[4..4 + length];
    // latin1 decoding then /^[a-z0-9@.-]+$/: only ASCII bytes can pass.
    ty.iter()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'@' | b'.' | b'-'))
        .then(|| String::from_utf8_lossy(ty).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn read_string_follows_ssh2_bounds() {
        let buf = [0, 0, 0, 2, 7, 8, 0, 0, 0, 0];
        assert_eq!(read_string(&buf, 0), Some((&[7u8, 8][..], 6)));
        assert_eq!(read_string(&buf, 6), Some((&[][..], 10)));
        assert_eq!(read_string(&buf, 10), None);
        assert_eq!(read_string(&buf, 7), None);
        assert_eq!(read_string(&[0, 0, 0, 9, 1], 0), None);
    }

    #[test]
    fn fields_fail_where_the_ts_code_throws() {
        let blob = [ssh_string(b"ssh-rsa"), ssh_string(&[1, 0, 1]), ssh_string(&[0, 0x80, 0])].concat();
        let (parts, end) = fields(&blob, 3, 0).unwrap();
        assert_eq!(parts.len(), 3);
        assert_eq!(end, blob.len());
        assert!(fields(&blob, 4, 0).is_none());
        assert!(fields(&blob[..blob.len() - 1], 3, 0).is_none());
    }

    #[test]
    fn rsa_bits_skip_leading_zero_bytes() {
        let blob = |n: &[u8]| [ssh_string(b"ssh-rsa"), ssh_string(&[1, 0, 1]), ssh_string(n)].concat();
        assert_eq!(bits_of(KeyAlgo::Rsa, &blob(&[0, 0x80, 0])), 16);
        assert_eq!(bits_of(KeyAlgo::Rsa, &blob(&[0, 0, 1, 0])), 9);
        assert_eq!(bits_of(KeyAlgo::Rsa, &blob(&[0, 0])), 0);
        assert_eq!(bits_of(KeyAlgo::EcdsaP521, &[]), 521);
    }

    #[test]
    fn fingerprints_and_blob_types_match_fingerprint_ts() {
        // `printf '' | sha256sum`, base64 without padding (Node: createHash('sha256').update(Buffer.alloc(0))).
        assert_eq!(sha256_fingerprint(b""), "SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU");
        assert_eq!(key_type_of_blob(&ssh_string(b"ssh-ed25519")).as_deref(), Some("ssh-ed25519"));
        assert_eq!(key_type_of_blob(&ssh_string(b"Ssh-rsa")), None);
        assert_eq!(key_type_of_blob(&ssh_string(b"")), None);
        assert_eq!(key_type_of_blob(&[0, 0, 0, 5, b'a']), None);
        assert_eq!(key_type_of_blob(&ssh_string(&[b'a'; 65])), None);
    }
}
