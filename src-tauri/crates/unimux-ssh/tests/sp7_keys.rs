//! SP7: russh 0.65.1 key loading against what 1.1.4 (ssh2 1.17 through src/main/ssh/keys.ts) answers.
//!
//! Inputs: the fixture corpus in test/golden/sp7/keys (scripts/sp7/gen-keys.sh + 1.1.4's own generateKey) and the 1.1.4 answers
//! in test/golden/sp7/keys.json (scripts/sp7/golden-keys.mjs, run under Electron 45 like the app), each file with no
//! passphrase, the right one and a wrong one.
//!
//! Two layers are checked:
//! - `port_parse` is the S2 port of 1.1.4's `parsePrivateKey` (`unimux_ssh::keys::parse_private_key`; the spike's prototype
//!   moved into the crate). For every file and every one of the three inputs its answer (ok, error code, `encrypted`, type,
//!   bits, blob, fingerprint, comment, publicKey line) must equal the 1.1.4 answer (tests/keys.rs checks the same).
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
use unimux_ssh::keys::{js::clean_comment, parse_private_key};

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

fn russh_decode(text: &str, pass: Option<&str>) -> Result<PrivateKey, String> {
    match catch_unwind(AssertUnwindSafe(|| decode_secret_key(text, pass))) {
        Ok(Ok(k)) => Ok(k),
        Ok(Err(e)) => Err(format!("{e:?}").chars().take(48).collect()),
        Err(_) => Err("russh panicked".into()),
    }
}

/// The S2 port (`unimux_ssh::keys::parse_private_key`) in the shape keys.json stores.
fn port_parse(text: &str, passphrase: Option<&str>) -> Answer {
    match parse_private_key(text, passphrase) {
        Ok(p) => {
            let m = p.meta;
            Answer::Ok {
                meta: Box::new(Meta {
                    key_type: m.key_type.as_str().to_string(),
                    bits: m.bits,
                    fingerprint: m.fingerprint,
                    comment: m.comment,
                    public_key: m.public_key,
                    blob: STANDARD.encode(&m.blob),
                }),
                encrypted: p.encrypted,
            }
        }
        Err(f) => Answer::err(f.error.as_str(), f.encrypted),
    }
}

/// russh alone (no own code), for the GAPS / EXTRA lists.
fn russh_alone(text: &str, pass: Option<&str>) -> Result<Meta, String> {
    russh_decode(text, pass).map(|k| meta_of(&k))
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
        assert_eq!(port_parse(&read(f), Some("sp7-pass")), Answer::err("badPassphrase", Some(true)), "{f}");
    }
    assert!(matches!(port_parse(&read("pem-rsa2048.key"), Some("sp7-pass")), Answer::Ok { encrypted: false, .. }));
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
