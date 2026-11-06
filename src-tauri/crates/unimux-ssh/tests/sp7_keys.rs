//! SP7: russh 0.65.1 key loading against what 1.1.4 (ssh2 1.17 through src/main/ssh/keys.ts) accepts.
//!
//! Inputs: the fixture corpus in test/golden/sp7/keys (scripts/sp7/gen-keys.sh + 1.1.4's own generateKey) and the 1.1.4 answers
//! in test/golden/sp7/keys.json (scripts/sp7/golden-keys.mjs). For every key 1.1.4 loads, `russh::keys::decode_secret_key`
//! (with ssh-key's `tdes` feature on) must give the same public blob, type, bits, fingerprint and comment, except the keys in
//! `GAPS`; those must load through the own-code prototype `legacy_pem` (the S2 plan). `EXTRA` lists what russh loads although
//! 1.1.4 refuses it: S2 refuses those before calling russh. Both lists are asserted exactly, so they stay true.
//! `cargo test -p unimux-ssh --test sp7_keys -- --nocapture` prints the whole matrix.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::path::PathBuf;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, STANDARD_NO_PAD};
use russh::keys::{PrivateKey, decode_secret_key, ssh_key::public::KeyData};
use serde_json::Value;
use sha2::{Digest, Sha256};

/// Keys 1.1.4 loads (with the right passphrase or none) that russh 0.65.1 does not.
/// russh's PEM reader knows `DEK-Info: AES-128-CBC` only and always decrypts to PKCS#1 RSA.
const GAPS: &[&str] = &[
    "pem-ec256-aes128.key",
    "pem-ec256-aes256.key",
    "pem-ec256-des3.key",
    "pem-ec256-sshkeygen-enc.key",
    "pem-ec384-sshkeygen-enc.key",
    "pem-ec521-sshkeygen-enc.key",
    "pem-rsa2048-aes192.key",
    "pem-rsa2048-aes256.key",
    "pem-rsa2048-des3.key",
];

/// Keys 1.1.4 refuses that russh loads: S2 keeps 1.1.4's answer (error code in parentheses) with checks before russh.
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

/// Prototype of the S2 own code for traditional encrypted PEM (`Proc-Type: 4,ENCRYPTED` + `DEK-Info: <cipher>,<iv>`), the
/// format of `ssh-keygen -m PEM` and `openssl rsa|ec -traditional`. Key = OpenSSL EVP_BytesToKey(MD5, 1 round, salt = first 8
/// bytes of the IV), CBC with PKCS#7 padding; the plain DER (PKCS#1 RSA or SEC1 EC) is armored again as an unencrypted PEM and
/// handed to russh, which reads those. The ciphers are the ones ssh2 1.17 decrypts that tools actually write.
mod legacy_pem {
    use aes::cipher::{BlockModeDecrypt, KeyIvInit, block_padding::Pkcs7};
    use base64::Engine;
    use base64::engine::general_purpose::STANDARD;

    #[derive(Debug, PartialEq)]
    pub enum Error {
        /// Not a traditional encrypted PEM: the caller uses russh directly.
        NotLegacy,
        /// A DEK-Info cipher 1.1.4 does not read either (camellia, DES-CBC ...).
        UnsupportedCipher,
        /// Wrong passphrase (bad padding) or broken data.
        BadPassphrase,
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

    fn cbc<C>(key: &[u8], iv: &[u8], data: &mut [u8]) -> Result<usize, Error>
    where
        cbc::Decryptor<C>: KeyIvInit + BlockModeDecrypt,
        C: aes::cipher::BlockCipherDecrypt,
    {
        let d = cbc::Decryptor::<C>::new_from_slices(key, iv).map_err(|_| Error::BadPassphrase)?;
        d.decrypt_padded::<Pkcs7>(data).map(|p| p.len()).map_err(|_| Error::BadPassphrase)
    }

    /// The decrypted key as an unencrypted PEM text that `russh::keys::decode_secret_key` reads.
    pub fn decrypt(text: &str, pass: &str) -> Result<String, Error> {
        let lines: Vec<&str> = text.lines().map(|l| l.trim_end_matches('\r')).collect();
        let begin = lines
            .iter()
            .position(|l| *l == "-----BEGIN RSA PRIVATE KEY-----" || *l == "-----BEGIN EC PRIVATE KEY-----")
            .ok_or(Error::NotLegacy)?;
        let label = if lines[begin].contains(" RSA ") { "RSA" } else { "EC" };
        let mut dek = None;
        let mut encrypted = false;
        let mut body = String::new();
        for l in &lines[begin + 1..] {
            if l.starts_with("-----END ") {
                break;
            }
            if let Some(v) = l.strip_prefix("Proc-Type:") {
                encrypted = v.trim() == "4,ENCRYPTED";
            } else if let Some(v) = l.strip_prefix("DEK-Info:") {
                dek = Some(v.trim().to_string());
            } else {
                body.push_str(l.trim());
            }
        }
        let dek = match (encrypted, dek) {
            (true, Some(d)) => d,
            _ => return Err(Error::NotLegacy),
        };
        let (cipher, iv_hex) = dek.split_once(',').ok_or(Error::BadPassphrase)?;
        let iv = (0..iv_hex.len() / 2)
            .map(|i| u8::from_str_radix(&iv_hex[2 * i..2 * i + 2], 16))
            .collect::<Result<Vec<u8>, _>>()
            .map_err(|_| Error::BadPassphrase)?;
        let mut data = STANDARD.decode(body.as_bytes()).map_err(|_| Error::BadPassphrase)?;
        let salt = iv.get(..8).ok_or(Error::BadPassphrase)?;
        let n = match cipher.to_ascii_uppercase().as_str() {
            "AES-128-CBC" => cbc::<aes::Aes128>(&evp_bytes_to_key(pass.as_bytes(), salt, 16), &iv, &mut data)?,
            "AES-192-CBC" => cbc::<aes::Aes192>(&evp_bytes_to_key(pass.as_bytes(), salt, 24), &iv, &mut data)?,
            "AES-256-CBC" => cbc::<aes::Aes256>(&evp_bytes_to_key(pass.as_bytes(), salt, 32), &iv, &mut data)?,
            "DES-EDE3-CBC" => cbc::<des::TdesEde3>(&evp_bytes_to_key(pass.as_bytes(), salt, 24), &iv, &mut data)?,
            _ => return Err(Error::UnsupportedCipher),
        };
        let b64 = STANDARD.encode(&data[..n]);
        let mut pem = format!("-----BEGIN {label} PRIVATE KEY-----\n");
        for chunk in b64.as_bytes().chunks(64) {
            pem.push_str(std::str::from_utf8(chunk).unwrap_or_default());
            pem.push('\n');
        }
        pem.push_str(&format!("-----END {label} PRIVATE KEY-----\n"));
        Ok(pem)
    }
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

/// The 1.1.4 comment rule: control characters become spaces, trimmed, at most 200 characters.
fn clean_comment(c: &str) -> String {
    let s: String = c.chars().map(|ch| if (ch as u32) < 0x20 { ' ' } else { ch }).collect();
    s.trim().chars().take(200).collect()
}

fn meta_of(key: &PrivateKey) -> Meta {
    let blob = key.public_key().to_bytes().expect("public blob");
    Meta {
        key_type: key.algorithm().as_str().to_string(),
        bits: bits_of(key),
        fingerprint: format!("SHA256:{}", STANDARD_NO_PAD.encode(Sha256::digest(&blob))),
        comment: clean_comment(key.comment().as_str_lossy()),
        blob: STANDARD.encode(&blob),
    }
}

#[derive(Debug)]
enum Outcome {
    Loaded(Box<Meta>),
    Failed(String),
    Panicked,
}

impl Outcome {
    fn short(&self) -> String {
        match self {
            Outcome::Loaded(m) => format!("ok {}", m.key_type),
            Outcome::Failed(s) => s.clone(),
            Outcome::Panicked => "PANIC".into(),
        }
    }
}

fn load(text: &str, pass: Option<&str>) -> Outcome {
    match catch_unwind(AssertUnwindSafe(|| decode_secret_key(text, pass))) {
        Ok(Ok(k)) => Outcome::Loaded(Box::new(meta_of(&k))),
        Ok(Err(e)) => Outcome::Failed(format!("{e:?}").chars().take(48).collect()),
        Err(_) => Outcome::Panicked,
    }
}

/// russh, with the legacy PEM prototype in front for traditional encrypted PEM (what S2 does).
fn load_with_own_code(text: &str, pass: Option<&str>) -> Outcome {
    if let Some(p) = pass {
        match legacy_pem::decrypt(text, p) {
            Ok(plain) => return load(&plain, None),
            Err(legacy_pem::Error::NotLegacy) => {}
            Err(e) => return Outcome::Failed(format!("legacy_pem {e:?}")),
        }
    }
    load(text, pass)
}

fn golden_meta(v: &Value) -> Meta {
    Meta {
        key_type: v["type"].as_str().unwrap().into(),
        bits: v["bits"].as_u64().unwrap() as u32,
        fingerprint: v["fingerprint"].as_str().unwrap().into(),
        comment: v["comment"].as_str().unwrap().into(),
        blob: v["blob"].as_str().unwrap().into(),
    }
}

fn sorted(v: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut v: Vec<String> = v.into_iter().collect();
    v.sort();
    v
}

#[test]
fn russh_loads_every_key_1_1_4_accepts() {
    let dir = golden_dir();
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("keys.json")).unwrap()).unwrap();
    let pass = golden["passphrase"].as_str().unwrap();
    let mut problems = Vec::new();
    let (mut gaps, mut extra, mut panics) = (Vec::new(), Vec::new(), Vec::new());
    let mut accepted = 0;
    println!("{:<42} {:<20} {:<20} russh: no passphrase | right | wrong", "file", "1.1.4 no passphrase", "1.1.4 right one");
    for e in golden["entries"].as_array().unwrap() {
        let file = e["file"].as_str().unwrap();
        let text = std::fs::read_to_string(dir.join("keys").join(file)).unwrap();
        let (np, wp) = (&e["noPassphrase"], &e["passphrase"]);
        let label = |v: &Value| {
            if v["ok"] == true { format!("ok {}", v["type"].as_str().unwrap()) } else { v["error"].as_str().unwrap().to_string() }
        };
        let (r_np, r_wp, r_wrong) = (load(&text, None), load(&text, Some(pass)), load(&text, Some("wrong-pass")));
        println!("{file:<42} {:<20} {:<20} {} | {} | {}", label(np), label(wp), r_np.short(), r_wp.short(), r_wrong.short());
        if [&r_np, &r_wp, &r_wrong].iter().any(|o| matches!(o, Outcome::Panicked)) {
            panics.push(file.to_string());
        }
        // What 1.1.4 accepts: the key with no passphrase, or (encrypted) with the right one.
        let expected = if np["ok"] == true {
            Some((None, golden_meta(np)))
        } else if wp["ok"] == true {
            Some((Some(pass), golden_meta(wp)))
        } else {
            None
        };
        match expected {
            Some((p, want)) => {
                accepted += 1;
                match if p.is_none() { &r_np } else { &r_wp } {
                    Outcome::Loaded(m) if **m == want => {}
                    Outcome::Loaded(m) => problems.push(format!("{file}: russh loads it with other data: {m:?} vs {want:?}")),
                    _ => gaps.push(file.to_string()),
                }
                match load_with_own_code(&text, p) {
                    Outcome::Loaded(m) if *m == want => {}
                    other => problems.push(format!("{file}: not loaded the 1.1.4 way with the own code: {other:?}")),
                }
                // A wrong passphrase must never give a key (1.1.4: badPassphrase).
                if p.is_some() && matches!(load_with_own_code(&text, Some("wrong-pass")), Outcome::Loaded(_)) {
                    problems.push(format!("{file}: loads with a wrong passphrase"));
                }
            }
            None => {
                if matches!(r_np, Outcome::Loaded(_)) || matches!(r_wp, Outcome::Loaded(_)) {
                    extra.push(file.to_string());
                }
            }
        }
    }
    println!(
        "1.1.4 accepts {accepted} of {} keys; russh alone misses {}: {gaps:?}",
        golden["entries"].as_array().unwrap().len(),
        gaps.len()
    );
    println!("refused by 1.1.4, loaded by russh ({}): {extra:?}", extra.len());
    let want_gaps = sorted(GAPS.iter().map(|s| s.to_string()));
    if sorted(gaps.clone()) != want_gaps {
        problems.push(format!("russh misses {:?}, GAPS lists {want_gaps:?}", sorted(gaps)));
    }
    let want_extra = sorted(EXTRA.iter().map(|s| s.to_string()));
    if sorted(extra.clone()) != want_extra {
        problems.push(format!("russh loads {:?} that 1.1.4 refuses, EXTRA lists {want_extra:?}", sorted(extra)));
    }
    if !panics.is_empty() {
        problems.push(format!("decode_secret_key panicked on {panics:?}"));
    }
    assert!(problems.is_empty(), "{}", problems.join("\n"));
}

#[test]
fn legacy_pem_refuses_ciphers_1_1_4_refuses() {
    let text = std::fs::read_to_string(golden_dir().join("keys/pem-rsa2048-camellia256.key")).unwrap();
    assert_eq!(legacy_pem::decrypt(&text, "sp7-pass"), Err(legacy_pem::Error::UnsupportedCipher));
    let plain = std::fs::read_to_string(golden_dir().join("keys/pem-rsa2048.key")).unwrap();
    assert_eq!(legacy_pem::decrypt(&plain, "sp7-pass"), Err(legacy_pem::Error::NotLegacy));
}
