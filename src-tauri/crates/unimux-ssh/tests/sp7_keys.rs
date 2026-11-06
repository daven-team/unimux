//! SP7: russh 0.65.1 key loading against what 1.1.4 (ssh2 1.17 through src/main/ssh/keys.ts) answers.
//!
//! Inputs: the fixture corpus in test/golden/sp7/keys (scripts/sp7/gen-keys.sh + 1.1.4's own generateKey) and the 1.1.4 answers
//! in test/golden/sp7/keys.json (scripts/sp7/golden-keys.mjs, run under Electron 45 like the app), each file with no
//! passphrase, the right one and a wrong one.
//!
//! Two layers are checked:
//! - `port_parse` is the S2 prototype of 1.1.4's `parsePrivateKey`: the 1.1.4 text checks (`isEncrypted`, the PPK regexes),
//!   the refusals before russh, the own `legacy_pem` reader for traditional PEM, then `russh::keys::decode_secret_key`. For
//!   every file and every one of the three inputs its answer (ok, error code, `encrypted`, type, bits, blob, fingerprint,
//!   comment, publicKey line) must equal the 1.1.4 answer.
//! - russh alone: `GAPS` (1.1.4 loads, russh alone does not) and `EXTRA` (1.1.4 refuses with every input, russh alone loads)
//!   are asserted exactly, so the reasons for the own code stay documented and true.
//!
//! `cargo test -p unimux-ssh --test sp7_keys -- --nocapture` prints the whole matrix.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use russh::keys::{PrivateKey, decode_secret_key, ssh_key::public::KeyData};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Keys 1.1.4 loads (with the right passphrase or none) that russh 0.65.1 alone does not load identically.
/// russh's PEM reader knows `DEK-Info: AES-128-CBC` only (upper case, a clean 32-digit IV) and always decrypts to PKCS#1 RSA.
const GAPS: &[&str] = &[
    "pem-ec256-aes-128-ctr.key",
    "pem-ec256-aes-256-ctr.key",
    "pem-ec256-aes128.key",
    "pem-ec256-aes256.key",
    "pem-ec256-bf-cbc.key",
    "pem-ec256-des3.key",
    "pem-ec256-sshkeygen-enc.key",
    "pem-ec384-sshkeygen-enc.key",
    "pem-ec521-sshkeygen-enc.key",
    "pem-rsa2048-aes-128-ctr.key",
    "pem-rsa2048-aes-192-ctr.key",
    "pem-rsa2048-aes-256-ctr.key",
    "pem-rsa2048-aes128-iv-odd-length.key",
    "pem-rsa2048-aes128-iv-trailing-junk.key",
    "pem-rsa2048-aes128-lowercase.key",
    "pem-rsa2048-aes192.key",
    "pem-rsa2048-aes256.key",
    "pem-rsa2048-bf-cbc.key",
    "pem-rsa2048-des3.key",
];

/// Keys 1.1.4 refuses with every input that russh alone loads: `port_parse` refuses them before russh (1.1.4's error code in
/// the comment).
const EXTRA: &[&str] = &[
    "openssh-ed25519-enc-chacha20-poly1305.key", // badPassphrase (ssh2 cannot decrypt chacha20-poly1305 key files)
    "pem-ec256-explicit.key",                    // notAKey (explicit curve parameters)
    "pkcs8-ec256-aes256.key",                    // notAKey: 1.1.4 reads no PKCS#8 at all
    "pkcs8-ec256-sshkeygen.key",
    "pkcs8-ec256.key",
    "pkcs8-ed25519-aes256.key",
    "pkcs8-ed25519.key",
    "pkcs8-rsa2048-aes256.key",
    "pkcs8-rsa2048-scrypt.key",
    "pkcs8-rsa2048-sshkeygen-enc.key",
    "pkcs8-rsa2048-sshkeygen.key",
    "pkcs8-rsa2048.key",
    "ppk2-dsa-enc.ppk", // unsupportedType: PPK v2 other than ssh-rsa
    "ppk2-dsa.ppk",
    "ppk2-ecdsa-enc.ppk",
    "ppk2-ecdsa.ppk",
    "ppk2-ed25519-enc.ppk",
    "ppk2-ed25519.ppk",
    "ppk3-dsa-enc.ppk", // ppkV3
    "ppk3-dsa.ppk",
    "ppk3-ecdsa-enc.ppk",
    "ppk3-ecdsa.ppk",
    "ppk3-ed25519-enc.ppk",
    "ppk3-ed25519.ppk",
    "ppk3-rsa-enc.ppk",
    "ppk3-rsa.ppk",
];

/// Prototype of the S2 own code for traditional PEM (`BEGIN RSA|EC|DSA PRIVATE KEY`, optionally `Proc-Type: 4,ENCRYPTED` +
/// `DEK-Info: <cipher>,<iv>`), the format of `ssh-keygen -m PEM` and `openssl rsa|ec -traditional`, read the way ssh2 1.17's
/// OpenSSH_Old_Private.parse reads it under Electron 45:
/// - a DEK-Info header without a comma is skipped; the cipher name is lower-cased;
/// - ciphers: the ones in both ssh2's CIPHER_INFO and Electron's `crypto.getCiphers()` that decrypt without an auth tag:
///   AES-128/192/256-CBC, AES-128/192/256-CTR, DES-EDE3-CBC, BF-CBC (GCM, ECB and RC4 entries fail in ssh2 too; RC4 even
///   throws inside ssh2); any other name is refused before the passphrase is looked at;
/// - the IV is `Buffer.from(hex)` (stops at the first pair that is not two hex digits) and must have the cipher's IV length;
/// - only then is a missing passphrase reported; key = OpenSSL EVP_BytesToKey(MD5, 1 round, salt = first 8 IV bytes);
/// - ssh2 decrypts with auto padding off and lets the DER reader ignore the padding: here valid PKCS#7 padding is cut off and
///   anything else is left to fail in the DER reader.
///
/// The plain DER (PKCS#1 RSA, SEC1 EC or DSA) comes back with its label; the caller armors it again for russh.
mod legacy_pem {
    use aes::cipher::{BlockModeDecrypt, KeyInit, KeyIvInit, StreamCipher, block_padding::NoPadding};
    use base64::Engine;

    #[derive(Debug, PartialEq)]
    pub enum Error {
        /// Not a traditional PEM private key: the caller uses russh directly.
        NotLegacy,
        /// A DEK-Info cipher 1.1.4 does not read either (camellia, DES-CBC, CFB, OFB ...).
        UnsupportedCipher,
        /// The IV does not have the cipher's length (ssh2: "Malformed encrypted OpenSSH private key").
        Malformed,
        /// Encrypted, and no passphrase given.
        NoPassphrase,
        /// Wrong passphrase or broken data.
        BadPassphrase,
    }

    #[derive(Debug)]
    pub struct Pem {
        pub label: &'static str,
        pub der: Vec<u8>,
        pub decrypted: bool,
    }

    /// `Buffer.from(text, 'hex')`: pairs of hex digits until the first pair that is not one; an odd last digit is dropped.
    pub fn node_hex(text: &str) -> Vec<u8> {
        let b = text.as_bytes();
        let digit = |c: u8| (c as char).to_digit(16).map(|d| d as u8);
        let mut out = Vec::with_capacity(b.len() / 2);
        for pair in b.as_chunks::<2>().0 {
            match (digit(pair[0]), digit(pair[1])) {
                (Some(h), Some(l)) => out.push(h << 4 | l),
                _ => break,
            }
        }
        out
    }

    /// The lenient base64 of `Buffer.from(text, 'base64')`: characters outside the alphabet are skipped, padding optional.
    pub fn node_base64(text: &str) -> Vec<u8> {
        let mut clean: Vec<u8> = text.bytes().filter(|c| c.is_ascii_alphanumeric() || *c == b'+' || *c == b'/').collect();
        if clean.len() % 4 == 1 {
            clean.pop();
        }
        let engine = base64::engine::GeneralPurpose::new(
            &base64::alphabet::STANDARD,
            base64::engine::GeneralPurposeConfig::new()
                .with_decode_allow_trailing_bits(true)
                .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
        );
        engine.decode(&clean).unwrap_or_default()
    }

    fn evp_bytes_to_key(pass: &[u8], salt: &[u8], len: usize) -> Vec<u8> {
        let mut out = Vec::new();
        let mut prev: Vec<u8> = Vec::new();
        while out.len() < len {
            let mut ctx = md5::Context::new();
            ctx.consume(&prev);
            ctx.consume(pass);
            ctx.consume(salt);
            prev = ctx.finalize().0.to_vec();
            out.extend_from_slice(&prev);
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

    fn ctr(mut c: impl StreamCipher, data: &mut [u8]) -> Result<(), Error> {
        c.apply_keystream(data);
        Ok(())
    }

    /// The JS `header.slice(sep + 2)`: the text after the colon and one more character.
    fn after_colon(line: &str, sep: usize) -> String {
        line[sep + 1..].chars().skip(1).collect()
    }

    fn decrypt_one(dek: &str, pass: Option<&str>, data: &mut Vec<u8>) -> Result<bool, Error> {
        let Some((name, iv_text)) = dek.split_once(',') else { return Ok(false) };
        let lower = name.to_ascii_lowercase();
        // (key length, IV length, block length of the CBC padding; 1 for CTR)
        let (key_len, iv_len, block) = match lower.as_str() {
            "aes-128-cbc" => (16, 16, 16),
            "aes-192-cbc" => (24, 16, 16),
            "aes-256-cbc" => (32, 16, 16),
            "aes-128-ctr" => (16, 16, 1),
            "aes-192-ctr" => (24, 16, 1),
            "aes-256-ctr" => (32, 16, 1),
            "des-ede3-cbc" => (24, 8, 8),
            "bf-cbc" => (16, 8, 8),
            _ => return Err(Error::UnsupportedCipher),
        };
        let iv = node_hex(iv_text);
        if iv.len() != iv_len {
            return Err(Error::Malformed);
        }
        let pass = pass.ok_or(Error::NoPassphrase)?;
        let key = evp_bytes_to_key(pass.as_bytes(), &iv[..8], key_len);
        let bad = |_| Error::BadPassphrase;
        match lower.as_str() {
            "aes-128-cbc" => cbc::<aes::Aes128>(&key, &iv, data)?,
            "aes-192-cbc" => cbc::<aes::Aes192>(&key, &iv, data)?,
            "aes-256-cbc" => cbc::<aes::Aes256>(&key, &iv, data)?,
            "des-ede3-cbc" => cbc::<des::TdesEde3>(&key, &iv, data)?,
            "bf-cbc" => cbc::<blowfish::Blowfish>(&key, &iv, data)?,
            "aes-128-ctr" => ctr(ctr::Ctr128BE::<aes::Aes128>::new_from_slices(&key, &iv).map_err(bad)?, data)?,
            "aes-192-ctr" => ctr(ctr::Ctr128BE::<aes::Aes192>::new_from_slices(&key, &iv).map_err(bad)?, data)?,
            _ => ctr(ctr::Ctr128BE::<aes::Aes256>::new_from_slices(&key, &iv).map_err(bad)?, data)?,
        }
        // Valid PKCS#7 padding is cut off (russh's DER reader wants no trailing bytes); anything else stays and fails later.
        if block > 1
            && let Some(&n) = data.last()
            && (1..=block).contains(&(n as usize))
            && data.len() >= n as usize
            && data[data.len() - n as usize..].iter().all(|&b| b == n)
        {
            data.truncate(data.len() - n as usize);
        }
        Ok(true)
    }

    /// A traditional PEM private key, decrypted when it carries DEK-Info headers.
    pub fn read(text: &str, pass: Option<&str>) -> Result<Pem, Error> {
        let lines: Vec<&str> = text.lines().map(|l| l.trim_end_matches('\r')).collect();
        let (begin, label) = lines
            .iter()
            .enumerate()
            .find_map(|(i, l)| match *l {
                "-----BEGIN RSA PRIVATE KEY-----" => Some((i, "RSA")),
                "-----BEGIN EC PRIVATE KEY-----" => Some((i, "EC")),
                "-----BEGIN DSA PRIVATE KEY-----" => Some((i, "DSA")),
                _ => None,
            })
            .ok_or(Error::NotLegacy)?;
        let mut headers = Vec::new();
        let mut body = String::new();
        let mut in_headers = true;
        for l in &lines[begin + 1..] {
            if l.starts_with("-----END ") {
                break;
            }
            if in_headers && l.contains(':') {
                headers.push(*l);
                continue;
            }
            in_headers = false;
            body.push_str(l);
        }
        let mut data = node_base64(&body);
        let mut decrypted = false;
        for h in headers {
            let sep = h.find(':').unwrap_or(0);
            if &h[..sep] == "DEK-Info" && decrypt_one(&after_colon(h, sep), pass, &mut data)? {
                decrypted = true;
            }
        }
        Ok(Pem { label, der: data, decrypted })
    }

    /// The PEM text russh reads for the plain DER.
    pub fn armor(pem: &Pem) -> String {
        let b64 = base64::engine::general_purpose::STANDARD.encode(&pem.der);
        let mut out = format!("-----BEGIN {} PRIVATE KEY-----\n", pem.label);
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
}

/// The JS `String.prototype.trim` set: WhiteSpace (including U+FEFF and every Zs) and LineTerminator. Not U+0085, which
/// Rust's `trim` would strip.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

fn js_trim(s: &str) -> &str {
    s.trim_matches(js_space)
}

/// The 1.1.4 comment rule (metaOf): `.replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 200)`, with 200 UTF-16 code units.
/// When the cut splits a surrogate pair, JS keeps the lone high surrogate; a Rust string cannot hold one, so it becomes
/// U+FFFD (the rule of `unimux_core::js_json::parse`, which reads 1.1.4's JSON the same way).
fn clean_comment(c: &str) -> String {
    let s: String = c.chars().map(|ch| if (ch as u32) < 0x20 { ' ' } else { ch }).collect();
    let mut out = String::new();
    let mut units = 0;
    for ch in js_trim(&s).chars() {
        let n = ch.len_utf16();
        if units + n > 200 {
            if units < 200 {
                out.push('\u{fffd}');
            }
            break;
        }
        units += n;
        out.push(ch);
    }
    out
}

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/golden/sp7")
}

#[derive(Debug, PartialEq)]
struct Meta {
    key_type: String,
    bits: u32,
    fingerprint: String,
    comment: String,
    public_key: String,
    blob: String,
}

fn bits_of(key: &PrivateKey) -> u32 {
    match key.public_key().key_data() {
        KeyData::Ed25519(_) => 256,
        KeyData::Ecdsa(e) => match e.curve() {
            russh::keys::EcdsaCurve::NistP256 => 256,
            russh::keys::EcdsaCurve::NistP384 => 384,
            russh::keys::EcdsaCurve::NistP521 => 521,
        },
        KeyData::Rsa(r) => {
            let n = r.n().as_positive_bytes().unwrap_or_default();
            let lead = n.first().copied().unwrap_or(0);
            if n.is_empty() { 0 } else { (n.len() as u32 - 1) * 8 + (8 - lead.leading_zeros()) }
        }
        _ => 0,
    }
}

fn meta_of(key: &PrivateKey) -> Meta {
    let blob = key.public_key().to_bytes().expect("public blob");
    let key_type = key.algorithm().as_str().to_string();
    let comment = clean_comment(key.comment().as_str_lossy());
    let b64 = STANDARD.encode(&blob);
    Meta {
        public_key: if comment.is_empty() { format!("{key_type} {b64}") } else { format!("{key_type} {b64} {comment}") },
        key_type,
        bits: bits_of(key),
        fingerprint: format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(&blob))),
        comment,
        blob: b64,
    }
}

/// What 1.1.4's parsePrivateKey returns (ParseResult), in the shape keys.json stores it.
#[derive(Debug, PartialEq)]
enum Answer {
    Ok { meta: Box<Meta>, encrypted: bool },
    Err { error: String, encrypted: Option<bool> },
}

impl Answer {
    fn err(error: &str, encrypted: Option<bool>) -> Answer {
        Answer::Err { error: error.into(), encrypted }
    }

    fn short(&self) -> String {
        match self {
            Answer::Ok { meta, .. } => format!("ok {}", meta.key_type),
            Answer::Err { error, .. } => error.clone(),
        }
    }

    fn from_golden(v: &Value) -> Answer {
        if v["ok"] == true {
            Answer::Ok {
                meta: Box::new(Meta {
                    key_type: v["type"].as_str().unwrap().into(),
                    bits: v["bits"].as_u64().unwrap() as u32,
                    fingerprint: v["fingerprint"].as_str().unwrap().into(),
                    comment: v["comment"].as_str().unwrap().into(),
                    public_key: v["publicKey"].as_str().unwrap().into(),
                    blob: v["blob"].as_str().unwrap().into(),
                }),
                encrypted: v["encrypted"] == true,
            }
        } else {
            Answer::Err { error: v["error"].as_str().unwrap().into(), encrypted: v["encrypted"].as_bool() }
        }
    }
}

/// Lines in the sense of a JS `/^.../m` regex (LineTerminator: LF, CR, U+2028, U+2029).
fn js_lines(text: &str) -> impl Iterator<Item = &str> {
    text.split(['\n', '\r', '\u{2028}', '\u{2029}'])
}

/// 1.1.4's isEncrypted (keys.ts): PEM Proc-Type, PPK Encryption, OpenSSH cipher name; decided without the passphrase.
fn is_encrypted(text: &str) -> bool {
    if js_lines(text).any(|l| l.starts_with("Proc-Type: 4,ENCRYPTED")) {
        return true;
    }
    let none_word =
        |rest: &str| rest.starts_with("none") && !rest[4..].starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_');
    if js_lines(text).any(|l| l.strip_prefix("Encryption: ").is_some_and(|rest| !none_word(rest))) {
        return true;
    }
    let (begin, end) = ("-----BEGIN OPENSSH PRIVATE KEY-----", "-----END OPENSSH PRIVATE KEY-----");
    let Some(from) = text.find(begin).map(|i| i + begin.len()) else { return false };
    let Some(len) = text[from..].find(end) else { return false };
    let raw = legacy_pem::node_base64(&text[from..from + len]);
    let magic = "openssh-key-v1\0".len();
    if raw.len() < magic + 4 {
        return false;
    }
    let n = u32::from_be_bytes([raw[magic], raw[magic + 1], raw[magic + 2], raw[magic + 3]]) as usize;
    let name = raw.get(magic + 4..(magic + 4 + n).min(raw.len())).unwrap_or_default();
    name != b"none"
}

/// The cipher name of an OpenSSH key file.
fn openssh_cipher(text: &str) -> Option<String> {
    let (begin, end) = ("-----BEGIN OPENSSH PRIVATE KEY-----", "-----END OPENSSH PRIVATE KEY-----");
    let from = text.find(begin)? + begin.len();
    let raw = legacy_pem::node_base64(&text[from..from + text[from..].find(end)?]);
    let magic = "openssh-key-v1\0".len();
    let n = u32::from_be_bytes(raw.get(magic..magic + 4)?.try_into().ok()?) as usize;
    Some(String::from_utf8_lossy(raw.get(magic + 4..magic + 4 + n)?).into_owned())
}

enum Fail {
    /// ssh2's "... but no passphrase given" (keys.ts: needsPassphrase whatever isEncrypted says).
    NoPassphrase,
    Other(String),
}

fn russh_decode(text: &str, pass: Option<&str>) -> Result<PrivateKey, Fail> {
    match catch_unwind(AssertUnwindSafe(|| decode_secret_key(text, pass))) {
        Ok(Ok(k)) => Ok(k),
        Ok(Err(e)) => Err(Fail::Other(format!("{e:?}").chars().take(48).collect())),
        Err(_) => Err(Fail::Other("russh panicked".into())),
    }
}

/// The S2 key reader: refusals where ssh2 fails, `legacy_pem` for traditional PEM, russh for the rest. A passphrase only
/// reaches russh for a text 1.1.4 calls encrypted (ssh2 ignores it on an unencrypted OpenSSH or PEM key; russh would try to
/// decrypt an unencrypted SEC1 key with it).
fn s2_load(trimmed: &str, pass: Option<&str>, encrypted: bool) -> Result<PrivateKey, Fail> {
    // PKCS#8: ssh2 reads none of it.
    if js_lines(trimmed).any(|l| l == "-----BEGIN PRIVATE KEY-----" || l == "-----BEGIN ENCRYPTED PRIVATE KEY-----") {
        return Err(Fail::Other("PKCS#8".into()));
    }
    // PPK v2 (only ssh-rsa gets here): ssh2's MAC key includes the passphrase, so a passphrase on an unencrypted file fails.
    if trimmed.starts_with("PuTTY-User-Key-File-2:") && !encrypted && pass.is_some() {
        return Err(Fail::Other("PPK v2 MAC with a passphrase".into()));
    }
    // ssh2 cannot decrypt chacha20-poly1305 OpenSSH key files.
    if openssh_cipher(trimmed).as_deref() == Some("chacha20-poly1305@openssh.com") {
        return Err(if pass.is_none() { Fail::NoPassphrase } else { Fail::Other("chacha20-poly1305 key file".into()) });
    }
    match legacy_pem::read(trimmed, pass) {
        Ok(pem) => {
            if pem.label == "EC" && legacy_pem::ec_explicit_curve(&pem.der) {
                return Err(Fail::Other("explicit curve parameters".into()));
            }
            return russh_decode(&legacy_pem::armor(&pem), None);
        }
        Err(legacy_pem::Error::NotLegacy) => {}
        Err(legacy_pem::Error::NoPassphrase) => return Err(Fail::NoPassphrase),
        Err(e) => return Err(Fail::Other(format!("legacy_pem {e:?}"))),
    }
    russh_decode(trimmed, if encrypted { pass } else { None })
}

const KEY_ALGOS: &[&str] = &["ssh-ed25519", "ecdsa-sha2-nistp256", "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521", "ssh-rsa"];

/// Prototype of the S2 `parsePrivateKey`: 1.1.4's keys.ts rules around `s2_load`.
fn port_parse(text: &str, passphrase: Option<&str>) -> Answer {
    if text.len() > 64 * 1024 {
        return Answer::err("tooLarge", None);
    }
    let trimmed = js_trim(text);
    if js_lines(trimmed).any(|l| l.starts_with("PuTTY-User-Key-File-3:")) {
        return Answer::err("ppkV3", None);
    }
    let ppk2_other = |l: &str| {
        l.strip_prefix("PuTTY-User-Key-File-2: ").is_some_and(|rest| {
            !(rest.starts_with("ssh-rsa") && !rest[7..].starts_with(|c: char| c.is_ascii_alphanumeric() || c == '_'))
        })
    };
    if js_lines(trimmed).any(ppk2_other) {
        return Answer::err("unsupportedType", None);
    }
    let encrypted = is_encrypted(trimmed);
    // JS truthiness: an empty passphrase is no passphrase.
    let pass = passphrase.filter(|p| !p.is_empty());
    match s2_load(trimmed, pass, encrypted) {
        Err(Fail::NoPassphrase) => Answer::err("needsPassphrase", Some(true)),
        Err(Fail::Other(_)) if encrypted => {
            Answer::err(if pass.is_some() { "badPassphrase" } else { "needsPassphrase" }, Some(true))
        }
        Err(Fail::Other(_)) => Answer::err("notAKey", None),
        Ok(key) => {
            let meta = meta_of(&key);
            if KEY_ALGOS.contains(&meta.key_type.as_str()) {
                Answer::Ok { meta: Box::new(meta), encrypted }
            } else {
                Answer::err("unsupportedType", None)
            }
        }
    }
}

/// russh alone (no own code), for the GAPS / EXTRA lists.
fn russh_alone(text: &str, pass: Option<&str>) -> Result<Meta, String> {
    match russh_decode(text, pass) {
        Ok(k) => Ok(meta_of(&k)),
        Err(Fail::Other(s)) => Err(s),
        Err(Fail::NoPassphrase) => Err("no passphrase".into()),
    }
}

fn sorted(v: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut v: Vec<String> = v.into_iter().collect();
    v.sort();
    v
}

fn golden() -> Value {
    unimux_core::js_json::parse(&std::fs::read_to_string(golden_dir().join("keys.json")).unwrap()).unwrap()
}

#[test]
fn the_port_answers_like_1_1_4_for_every_key_and_every_input() {
    let dir = golden_dir();
    let golden = golden();
    let pass = golden["passphrase"].as_str().unwrap();
    let wrong = golden["wrongPassphrase"].as_str().unwrap();
    let entries = golden["entries"].as_array().unwrap();
    let mut problems = Vec::new();
    let (mut gaps, mut extra, mut accepted) = (Vec::new(), Vec::new(), 0);
    println!(
        "{:<44} {:<48} {:<48} russh alone: none | right",
        "file", "1.1.4: none | right | wrong", "port: none | right | wrong"
    );
    for e in entries {
        let file = e["file"].as_str().unwrap();
        let text = std::fs::read_to_string(dir.join("keys").join(file)).unwrap();
        let inputs = [("noPassphrase", None), ("passphrase", Some(pass)), ("wrongPassphrase", Some(wrong))];
        let want: Vec<Answer> = inputs.iter().map(|(k, _)| Answer::from_golden(&e[*k])).collect();
        let got: Vec<Answer> = inputs
            .iter()
            .map(|(_, p)| catch_unwind(AssertUnwindSafe(|| port_parse(&text, *p))).unwrap_or_else(|_| Answer::err("PANIC", None)))
            .collect();
        let (r_np, r_wp) = (russh_alone(&text, None), russh_alone(&text, Some(pass)));
        let join = |a: &[Answer]| a.iter().map(Answer::short).collect::<Vec<_>>().join(" | ");
        let short = |r: &Result<Meta, String>| match r {
            Ok(m) => format!("ok {}", m.key_type),
            Err(s) => s.clone(),
        };
        println!("{file:<44} {:<48} {:<48} {} | {}", join(&want), join(&got), short(&r_np), short(&r_wp));
        for (i, (k, _)) in inputs.iter().enumerate() {
            if got[i] != want[i] {
                problems.push(format!("{file} ({k}): port {:?}\n    1.1.4 {:?}", got[i], want[i]));
            }
        }
        // russh alone against what 1.1.4 accepts (the key with no passphrase, or encrypted with the right one).
        let accepted_meta = match (&want[0], &want[1]) {
            (Answer::Ok { meta, .. }, _) => Some((meta, &r_np)),
            (_, Answer::Ok { meta, .. }) => Some((meta, &r_wp)),
            _ => None,
        };
        match accepted_meta {
            Some((m, r)) => {
                accepted += 1;
                if r.as_ref().ok() != Some(&**m) {
                    gaps.push(file.to_string());
                }
            }
            None if r_np.is_ok() || r_wp.is_ok() => extra.push(file.to_string()),
            None => {}
        }
    }
    println!("1.1.4 accepts {accepted} of {} keys; russh alone misses {}: {gaps:?}", entries.len(), gaps.len());
    println!("refused by 1.1.4, loaded by russh alone ({}): {extra:?}", extra.len());
    let want_gaps = sorted(GAPS.iter().map(|s| s.to_string()));
    if sorted(gaps.clone()) != want_gaps {
        problems.push(format!("russh alone misses {:?}, GAPS lists {want_gaps:?}", sorted(gaps)));
    }
    let want_extra = sorted(EXTRA.iter().map(|s| s.to_string()));
    if sorted(extra.clone()) != want_extra {
        problems.push(format!("russh alone loads {:?} that 1.1.4 refuses, EXTRA lists {want_extra:?}", sorted(extra)));
    }
    assert!(problems.is_empty(), "{} differences:\n{}", problems.len(), problems.join("\n"));
}

#[test]
fn legacy_pem_refuses_ciphers_1_1_4_refuses() {
    let read = |f: &str| std::fs::read_to_string(golden_dir().join("keys").join(f)).unwrap();
    for f in
        ["pem-rsa2048-camellia256.key", "pem-rsa2048-aes-256-cfb.key", "pem-rsa2048-des-cbc.key", "pem-rsa2048-aes-128-ofb.key"]
    {
        assert_eq!(legacy_pem::read(&read(f), Some("sp7-pass")).err(), Some(legacy_pem::Error::UnsupportedCipher), "{f}");
    }
    assert!(legacy_pem::read(&read("pem-rsa2048.key"), Some("sp7-pass")).is_ok_and(|p| !p.decrypted));
    assert_eq!(legacy_pem::read(&read("openssh-ed25519.key"), None).err(), Some(legacy_pem::Error::NotLegacy));
}

/// Hand-made DEK-Info headers (bad IVs, other ciphers, non-ASCII text at every position): never a panic, never a key
/// without the right passphrase, and the 1.1.4 classification (needsPassphrase without one, badPassphrase with a wrong one).
#[test]
fn malformed_dek_info_headers_never_panic() {
    let base = std::fs::read_to_string(golden_dir().join("keys/pem-rsa2048-aes128.key")).unwrap();
    let iv = "7E10D1D0386F4A0E6489DD2EBDEBA5A5";
    let mut values = vec![
        String::new(),
        ",".into(),
        "AES-128-CBC,".into(),
        "AES-128-CBC,é".into(),
        "AES-128-CBC,ééééééééééééééééé".into(),
        format!("AES-128-CBC,{}", "0".repeat(10_000)),
        format!("AES-128-CBC,{iv},{iv}"),
        format!("AES-128-CTR,{}", &iv[..16]),
        format!("DES-EDE3-CBC,{iv}"),
        format!("BF-CBC,{iv}"),
        format!("AES-128-GCM,{}", &iv[..24]),
        "RC4,".into(),
        format!("é,{iv}"),
        format!("\u{1F600}AES-128-CBC,{iv}"),
    ];
    for i in 0..=iv.len() {
        for ins in ["é", "\u{1F600}", "\u{0}", " ", "g"] {
            values.push(format!("AES-128-CBC,{}{ins}{}", &iv[..i], &iv[i..]));
        }
    }
    for v in &values {
        let text = base.replace(&format!("DEK-Info: AES-128-CBC,{iv}"), &format!("DEK-Info: {v}"));
        for (p, want) in [(None, "needsPassphrase"), (Some("wrong-pass"), "badPassphrase")] {
            let got = catch_unwind(AssertUnwindSafe(|| port_parse(&text, p)));
            assert!(got.is_ok(), "panic on DEK-Info {v:?}");
            assert_eq!(got.unwrap(), Answer::err(want, Some(true)), "DEK-Info {v:?} with {p:?}");
        }
    }
}

#[test]
fn comments_follow_the_js_utf16_rules() {
    let emoji = "\u{1F600}";
    assert_eq!(clean_comment(&emoji.repeat(150)), emoji.repeat(100));
    assert_eq!(clean_comment(&format!("x{}", emoji.repeat(150))), format!("x{}\u{fffd}", emoji.repeat(99)));
    assert_eq!(clean_comment("\u{feff}\u{85} a \u{85}\u{3000}\u{feff}"), "\u{85} a \u{85}");
    assert_eq!(clean_comment("\tsp7\u{2028}ctrl\u{1}x\u{2029}"), "sp7\u{2028}ctrl x");
    assert_eq!(clean_comment(&"a".repeat(300)).len(), 200);
}
