//! Traditional PEM private keys (`BEGIN RSA|EC|DSA PRIVATE KEY`, optionally `Proc-Type: 4,ENCRYPTED` + `DEK-Info:
//! <cipher>,<iv>`), the format of `ssh-keygen -m PEM` and `openssl rsa|ec -traditional`, decrypted the way ssh2 1.17's
//! `OpenSSH_Old_Private.parse` does under Electron 45 (SP7). russh alone reads only `DEK-Info: AES-128-CBC` and always as RSA.
//!
//! - the headers are the regex group ssh2 captures, split at line ends; a `DEK-Info` header without a comma is skipped and
//!   every other one decrypts the data again (ssh2 loops over all of them);
//! - the cipher name is lower-cased; ciphers: the ones in both ssh2's CIPHER_INFO and Electron's `crypto.getCiphers()`.
//!   AES-128/192/256-CBC, AES-128/192/256-CTR, DES-EDE3-CBC and BF-CBC decrypt; AES-128/256-GCM, DES-EDE3, BF-ECB and RC4
//!   pass the name check and the IV check but never decrypt in ssh2 (no auth tag, an IV the ECB cipher refuses, RC4 throws);
//!   any other name is refused before the IV and the passphrase are looked at;
//! - the IV is `Buffer.from(hex)` (stops at the first pair that is not two hex digits) and must have the cipher's IV length;
//! - only then is a missing passphrase reported; key = OpenSSL EVP_BytesToKey(MD5, 1 round, salt = first 8 IV bytes);
//! - ssh2 decrypts with auto padding off and its DER reader ignores whatever follows the outer SEQUENCE (the padding, or
//!   junk after a plain key): the data is cut after that SEQUENCE before russh, whose DER reader wants no trailing bytes.

use aes::cipher::{BlockModeDecrypt, KeyInit, KeyIvInit, StreamCipher, block_padding::NoPadding};
use base64::Engine;
use zeroize::Zeroizing;

use super::js::{node_base64, node_hex};

#[derive(Debug, PartialEq, Eq)]
pub enum Error {
    /// A DEK-Info cipher 1.1.4 does not read (camellia, DES-CBC, CFB, OFB ...).
    UnsupportedCipher,
    /// The IV does not have the cipher's length (ssh2: "Malformed encrypted OpenSSH private key").
    Malformed,
    /// Encrypted, and no passphrase given.
    NoPassphrase,
    /// Wrong passphrase, a cipher ssh2 cannot run, or broken data.
    BadPassphrase,
}

/// The plain DER (PKCS#1 RSA, SEC1 EC or DSA) with its PEM label.
pub struct Pem {
    pub label: &'static str,
    pub der: Zeroizing<Vec<u8>>,
}

#[derive(Clone, Copy)]
enum Mode {
    Cbc,
    Ctr,
    /// Known to ssh2 under Electron, never decrypts there.
    Dead,
}

/// (mode, key length, IV length) per lower-case OpenSSL name.
fn cipher(name: &str) -> Option<(Mode, usize, usize)> {
    Some(match name {
        "aes-128-cbc" => (Mode::Cbc, 16, 16),
        "aes-192-cbc" => (Mode::Cbc, 24, 16),
        "aes-256-cbc" => (Mode::Cbc, 32, 16),
        "aes-128-ctr" => (Mode::Ctr, 16, 16),
        "aes-192-ctr" => (Mode::Ctr, 24, 16),
        "aes-256-ctr" => (Mode::Ctr, 32, 16),
        "des-ede3-cbc" => (Mode::Cbc, 24, 8),
        "bf-cbc" => (Mode::Cbc, 16, 8),
        "aes-128-gcm" | "aes-256-gcm" => (Mode::Dead, 0, 12),
        "des-ede3" | "bf-ecb" => (Mode::Dead, 0, 8),
        "rc4" => (Mode::Dead, 0, 0),
        _ => return None,
    })
}

fn evp_bytes_to_key(pass: &[u8], salt: &[u8], len: usize) -> Zeroizing<Vec<u8>> {
    let mut out = Zeroizing::new(Vec::with_capacity(len + 16));
    let mut prev: Option<[u8; 16]> = None;
    while out.len() < len {
        let mut ctx = md5::Context::new();
        if let Some(p) = prev {
            ctx.consume(p);
        }
        ctx.consume(pass);
        ctx.consume(salt);
        let d = ctx.finalize().0;
        out.extend_from_slice(&d);
        prev = Some(d);
    }
    out.truncate(len);
    out
}

fn cbc<C>(key: &[u8], iv: &[u8], data: &mut [u8]) -> Result<(), Error>
where
    cbc::Decryptor<C>: KeyIvInit + BlockModeDecrypt,
    C: aes::cipher::BlockCipherDecrypt + KeyInit,
{
    let d = cbc::Decryptor::<C>::new_from_slices(key, iv).map_err(|_| Error::BadPassphrase)?;
    // Like ssh2's final(): the data must be whole blocks.
    d.decrypt_padded::<NoPadding>(data).map(|_| ()).map_err(|_| Error::BadPassphrase)
}

fn stream(cipher: Result<impl StreamCipher, impl Sized>, data: &mut [u8]) -> Result<(), Error> {
    cipher.map_err(|_| Error::BadPassphrase)?.apply_keystream(data);
    Ok(())
}

/// The JS `header.slice(sep + 2)` (sep = -1 when there is no colon): the text after the colon and one more UTF-16 unit. A
/// cut surrogate pair leaves half a character in JS, which no cipher name starts with: it becomes U+FFFD here.
fn value_of(header: &str, sep: Option<usize>) -> String {
    let rest = match sep {
        Some(i) => &header[i + 1..],
        None => header,
    };
    let mut chars = rest.chars();
    match chars.next() {
        Some(c) if c.len_utf16() == 2 => format!("\u{fffd}{}", chars.as_str()),
        _ => chars.as_str().to_string(),
    }
}

/// The JS `header.slice(0, sep)`; with no colon (sep = -1) everything but the last UTF-16 unit.
fn name_of(header: &str, sep: Option<usize>) -> &str {
    match sep {
        Some(i) => &header[..i],
        None => {
            let mut chars = header.chars();
            match chars.next_back() {
                // Half a surrogate pair stays in JS: such a name is never "DEK-Info".
                Some(c) if c.len_utf16() == 2 => "\u{fffd}",
                _ => chars.as_str(),
            }
        }
    }
}

fn decrypt_one(value: &str, pass: Option<&str>, data: &mut [u8]) -> Result<(), Error> {
    let Some(comma) = value.find(',') else { return Ok(()) };
    let name = value[..comma].to_lowercase();
    let (mode, key_len, iv_len) = cipher(&name).ok_or(Error::UnsupportedCipher)?;
    let iv = node_hex(&value[comma + 1..]);
    if iv.len() != iv_len {
        return Err(Error::Malformed);
    }
    let pass = pass.ok_or(Error::NoPassphrase)?;
    let key = evp_bytes_to_key(pass.as_bytes(), &iv[..8.min(iv.len())], key_len);
    match (mode, name.as_str()) {
        (Mode::Dead, _) => return Err(Error::BadPassphrase),
        (_, "aes-128-cbc") => cbc::<aes::Aes128>(&key, &iv, data)?,
        (_, "aes-192-cbc") => cbc::<aes::Aes192>(&key, &iv, data)?,
        (_, "aes-256-cbc") => cbc::<aes::Aes256>(&key, &iv, data)?,
        (_, "des-ede3-cbc") => cbc::<des::TdesEde3>(&key, &iv, data)?,
        (_, "bf-cbc") => cbc::<blowfish::Blowfish>(&key, &iv, data)?,
        (_, "aes-128-ctr") => stream(ctr::Ctr128BE::<aes::Aes128>::new_from_slices(&key, &iv), data)?,
        (_, "aes-192-ctr") => stream(ctr::Ctr128BE::<aes::Aes192>::new_from_slices(&key, &iv), data)?,
        _ => stream(ctr::Ctr128BE::<aes::Aes256>::new_from_slices(&key, &iv), data)?,
    }
    Ok(())
}

/// Cuts whatever follows the outer DER SEQUENCE (ssh2's reader never looks past it); data that is no SEQUENCE stays.
fn cut_after_sequence(data: &mut Vec<u8>) {
    if let Some((0x30, _, end)) = element(data, 0) {
        data.truncate(end);
    }
}

/// Reads the parts ssh2's regex captured: the label of the BEGIN line, the header group and the base64 body.
pub fn read(label: &str, headers: &str, body: &str, pass: Option<&str>) -> Result<Pem, Error> {
    let label = match label {
        "RSA" => "RSA",
        "EC" => "EC",
        _ => "DSA",
    };
    let mut data = Zeroizing::new(node_base64(body));
    for header in headers.split('\n').map(|h| h.strip_suffix('\r').unwrap_or(h)) {
        let sep = header.find(':');
        if name_of(header, sep) != "DEK-Info" {
            continue;
        }
        let value = value_of(header, sep);
        decrypt_one(&value, pass, &mut data)?;
    }
    cut_after_sequence(&mut data);
    Ok(Pem { label, der: data })
}

/// The PEM text russh reads for the plain DER.
pub fn armor(pem: &Pem) -> Zeroizing<String> {
    let b64 = Zeroizing::new(base64::engine::general_purpose::STANDARD.encode(&*pem.der));
    let mut out = Zeroizing::new(format!("-----BEGIN {} PRIVATE KEY-----\n", pem.label));
    for chunk in b64.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push('\n');
    }
    out.push_str(&format!("-----END {} PRIVATE KEY-----\n", pem.label));
    out
}

/// One DER element at `at`: (tag, content range, end).
fn element(der: &[u8], at: usize) -> Option<(u8, std::ops::Range<usize>, usize)> {
    let tag = *der.get(at)?;
    let first = *der.get(at + 1)? as usize;
    let (len, start) = if first < 0x80 {
        (first, at + 2)
    } else {
        let n = first & 0x7f;
        if n == 0 || n > 4 {
            return None;
        }
        let mut len = 0usize;
        for i in 0..n {
            len = len << 8 | *der.get(at + 2 + i)? as usize;
        }
        (len, at + 2 + n)
    };
    let end = start.checked_add(len)?;
    (end <= der.len()).then_some((tag, start..end, end))
}

/// A SEC1 ECPrivateKey whose `[0] parameters` are not a named-curve OID (explicit curve parameters: ssh2 refuses them).
pub fn ec_explicit_curve(der: &[u8]) -> bool {
    let Some((0x30, seq, _)) = element(der, 0) else { return false };
    let mut at = seq.start;
    while at < seq.end {
        let Some((tag, content, end)) = element(der, at) else { return false };
        if tag == 0xa0 {
            return !matches!(element(der, content.start), Some((0x06, _, _)));
        }
        at = end;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_names_and_values_follow_the_js_slices() {
        assert_eq!(name_of("DEK-Info: x", Some(8)), "DEK-Info");
        assert_eq!(name_of("DEK-Info,", None), "DEK-Info");
        assert_eq!(value_of("DEK-Info,", None), "EK-Info,");
        assert_eq!(value_of("DEK-Info: AES-128-CBC,00", Some(8)), "AES-128-CBC,00");
        assert_eq!(value_of("DEK-Info:\u{1F600}AES-128-CBC,00", Some(8)), "\u{fffd}AES-128-CBC,00");
        assert_eq!(value_of("DEK-Info:", Some(8)), "");
    }

    #[test]
    fn a_colonless_dek_info_line_is_read_like_ssh2() {
        // "DEK-Info," has no colon: JS reads the name "DEK-Info" and the value "EK-Info,", an unknown cipher.
        assert_eq!(read("RSA", "DEK-Info,\nX: y\n", "AAAA", Some("p")).err(), Some(Error::UnsupportedCipher));
        assert!(read("RSA", "DEK-Info\nX: y\n", "AAAA", None).is_ok());
    }

    #[test]
    fn ciphers_ssh2_knows_but_cannot_run_check_the_iv_and_the_passphrase_first() {
        let iv12 = "00".repeat(12);
        assert_eq!(read("RSA", &format!("DEK-Info: AES-128-GCM,{iv12}\n"), "AAAA", None).err(), Some(Error::NoPassphrase));
        assert_eq!(read("RSA", &format!("DEK-Info: AES-128-GCM,{iv12}\n"), "AAAA", Some("p")).err(), Some(Error::BadPassphrase));
        assert_eq!(read("RSA", "DEK-Info: AES-128-GCM,00\n", "AAAA", None).err(), Some(Error::Malformed));
        assert_eq!(read("RSA", "DEK-Info: RC4,\n", "AAAA", None).err(), Some(Error::NoPassphrase));
        assert_eq!(read("RSA", "DEK-Info: RC4,\n", "AAAA", Some("p")).err(), Some(Error::BadPassphrase));
        assert_eq!(read("RSA", "DEK-Info: AES-128-ECB,00\n", "AAAA", None).err(), Some(Error::UnsupportedCipher));
    }

    #[test]
    fn evp_bytes_to_key_matches_openssl() {
        // `openssl enc -aes-256-cbc -k pass -S 0102030405060708 -md md5 -P -nosalt` style vector, computed with Node:
        // EVP_BytesToKey(md5, 'pass', salt 01..08) = md5(pass|salt) | md5(d1|pass|salt).
        let k = evp_bytes_to_key(b"pass", &[1, 2, 3, 4, 5, 6, 7, 8], 32);
        let d1 = md5::compute([&b"pass"[..], &[1, 2, 3, 4, 5, 6, 7, 8]].concat()).0;
        let d2 = md5::compute([&d1[..], b"pass", &[1, 2, 3, 4, 5, 6, 7, 8]].concat()).0;
        assert_eq!(&k[..16], &d1);
        assert_eq!(&k[16..], &d2);
    }
}
