//! S2: the key module against 1.1.4.
//!
//! - every answer of test/golden/sp7/keys.json (116 key files x no / the right / a wrong passphrase, 1.1.4's real
//!   parsePrivateKey under Electron 45);
//! - test/golden/ssh-keys.json (scripts/golden-ssh-keys.mjs): text variants, publicKeyMatches, keyMetaFromPublic,
//!   certificateCheck and scripted KeyDrafts sessions (the golden DraftResult corpus);
//! - the cases of test/ssh-keys.test.ts;
//! - generated keys read back by `ssh-keygen -y` (the Windows OpenSSH client, or ssh-keygen on PATH elsewhere).

use std::cell::Cell;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use unimux_ssh::keys::{
    CertCheck, DraftInput, DraftResult, GenerateError, KeyAlgo, KeyDrafts, KeyGenRequest, KeyMeta, KeyType, MAX_KEY_DRAFTS,
    ParseError, certificate_check, check_passphrase, generate_key, generate_key_blocking, key_meta_from_public,
    parse_private_key, public_key_matches, sha256_fingerprint,
};
use zeroize::Zeroizing;

fn golden_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/golden")
}

fn read_golden(name: &str) -> Value {
    unimux_core::js_json::parse(&std::fs::read_to_string(golden_dir().join(name)).unwrap()).unwrap()
}

fn key_file(name: &str) -> String {
    std::fs::read_to_string(golden_dir().join("sp7/keys").join(name)).unwrap()
}

fn meta_view(m: &KeyMeta) -> Value {
    json!({
        "type": m.key_type.as_str(), "bits": m.bits, "fingerprint": m.fingerprint, "comment": m.comment,
        "publicKey": m.public_key, "blob": STANDARD.encode(&m.blob),
    })
}

/// The `view` of the golden scripts: `{ok, encrypted, ...meta}` or `{ok: false, error, encrypted?}`.
fn view(text: &str, pass: Option<&str>) -> Value {
    match parse_private_key(text, pass) {
        Ok(p) => {
            let mut v = meta_view(&p.meta);
            v["ok"] = json!(true);
            v["encrypted"] = json!(p.encrypted);
            v
        }
        Err(f) => {
            let mut v = json!({ "ok": false, "error": f.error.as_str() });
            if let Some(e) = f.encrypted {
                v["encrypted"] = json!(e);
            }
            v
        }
    }
}

fn meta_of_file(name: &str) -> KeyMeta {
    parse_private_key(&key_file(name), None).unwrap().meta
}

#[test]
fn every_answer_of_the_sp7_key_corpus_matches_1_1_4() {
    let golden = read_golden("sp7/keys.json");
    let pass = golden["passphrase"].as_str().unwrap();
    let wrong = golden["wrongPassphrase"].as_str().unwrap();
    let entries = golden["entries"].as_array().unwrap();
    let mut problems = Vec::new();
    for e in entries {
        let file = e["file"].as_str().unwrap();
        let text = key_file(file);
        for (k, p) in [("noPassphrase", None), ("passphrase", Some(pass)), ("wrongPassphrase", Some(wrong))] {
            let got = view(&text, p);
            if got != e[k] {
                problems.push(format!("{file} ({k}):\n    port  {got}\n    1.1.4 {}", e[k]));
            }
        }
    }
    assert_eq!(entries.len(), 116);
    assert!(problems.is_empty(), "{} differences:\n{}", problems.len(), problems.join("\n"));
}

#[test]
fn text_variants_answer_like_1_1_4() {
    let golden = read_golden("ssh-keys.json");
    let pass = golden["passphrase"].as_str().unwrap();
    let wrong = golden["wrongPassphrase"].as_str().unwrap();
    let mut problems = Vec::new();
    let cases = golden["parse"].as_array().unwrap();
    for c in cases {
        let text = c["text"].as_str().unwrap();
        for (k, p) in
            [("noPassphrase", None), ("passphrase", Some(pass)), ("wrongPassphrase", Some(wrong)), ("emptyPassphrase", Some(""))]
        {
            let got = view(text, p);
            if got != c[k] {
                problems.push(format!("{} ({k}):\n    port  {got}\n    1.1.4 {}", c["name"], c[k]));
            }
        }
    }
    assert!(cases.len() > 100);
    assert!(problems.is_empty(), "{} differences:\n{}", problems.len(), problems.join("\n"));
}

#[test]
fn public_key_checks_answer_like_1_1_4() {
    let golden = read_golden("ssh-keys.json");
    let mut problems = Vec::new();
    for c in golden["publicMatches"].as_array().unwrap() {
        let meta = meta_of_file(c["key"].as_str().unwrap());
        let got = public_key_matches(&meta, c["text"].as_str().unwrap());
        if json!(got) != c["match"] {
            problems.push(format!("publicKeyMatches {} {}: port {got}", c["key"], c["name"]));
        }
    }
    for c in golden["certificate"].as_array().unwrap() {
        let meta = meta_of_file(c["key"].as_str().unwrap());
        let got = serde_json::to_value(certificate_check(c["cert"].as_str().unwrap(), &meta)).unwrap();
        if got != c["result"] {
            problems.push(format!("certificateCheck {} {}: port {got}, 1.1.4 {}", c["key"], c["name"], c["result"]));
        }
    }
    for c in golden["metaFromPublic"].as_array().unwrap() {
        let got = key_meta_from_public(c["line"].as_str().unwrap()).map_or(Value::Null, |m| meta_view(&m));
        if got != c["meta"] {
            problems.push(format!("keyMetaFromPublic {}: port {got}, 1.1.4 {}", c["name"], c["meta"]));
        }
    }
    assert!(problems.is_empty(), "{} differences:\n{}", problems.len(), problems.join("\n"));
}

#[test]
fn draft_sessions_give_the_1_1_4_draft_results() {
    let golden = read_golden("ssh-keys.json");
    let mut problems = Vec::new();
    for session in golden["drafts"].as_array().unwrap() {
        let name = session["name"].as_str().unwrap();
        let now = Arc::new(AtomicU64::new(1_000_000));
        let clock = now.clone();
        let mut store = KeyDrafts::with_clock(Box::new(move || clock.load(Ordering::SeqCst)), 10 * 60_000);
        let mut tokens: Vec<String> = Vec::new();
        let token = |tokens: &mut Vec<String>, id: &str| -> String {
            let i = tokens.iter().position(|t| t == id).unwrap_or_else(|| {
                tokens.push(id.to_string());
                tokens.len() - 1
            });
            format!("#{i}")
        };
        let steps = session["steps"].as_array().unwrap();
        let mut created: Vec<Option<String>> = Vec::new();
        let text_of = |input: &Value| match input["file"].as_str() {
            Some(f) => key_file(f),
            None => input["text"].as_str().unwrap().to_string(),
        };
        for (i, step) in steps.iter().enumerate() {
            let dup_value = step["duplicate"].as_str().map(str::to_string);
            let dup = move |_: &str| dup_value.clone();
            let id_of = |r: &Value| -> String {
                r.as_u64().and_then(|r| created.get(r as usize).cloned().flatten()).unwrap_or_else(|| "missing".into())
            };
            let got = match step["op"].as_str().unwrap() {
                "create" => {
                    let input = &step["input"];
                    let r = store.create(
                        DraftInput {
                            private_key: Zeroizing::new(text_of(input)),
                            public_key: input["publicKey"].as_str().map(str::to_string),
                            certificate: input["certificate"].as_str().map(str::to_string),
                        },
                        &dup,
                    );
                    created.push(r.draft_id().map(str::to_string));
                    draft_json(&r, &mut tokens, &token)
                }
                "advance" => {
                    now.fetch_add(step["ms"].as_u64().unwrap(), Ordering::SeqCst);
                    created.push(None);
                    Value::Null
                }
                "unlock" => {
                    let id = id_of(&step["ref"]);
                    created.push(None);
                    let r = store.unlock(&id, step["passphrase"].as_str().unwrap(), &dup);
                    draft_json(&r, &mut tokens, &token)
                }
                "discard" => {
                    let id = id_of(&step["ref"]);
                    created.push(None);
                    store.discard(&id);
                    Value::Null
                }
                _ => {
                    let id = id_of(&step["ref"]);
                    created.push(None);
                    let original = text_of(&steps[step["ref"].as_u64().unwrap() as usize]["input"]);
                    match store.take(&id) {
                        None => Value::Null,
                        Some(t) => {
                            let mut v = json!({ "text": *t.text == original });
                            for (k, x) in meta_view(&t.meta).as_object().unwrap() {
                                v[k] = x.clone();
                            }
                            v["encrypted"] = json!(t.encrypted);
                            v["passphrase"] = t.passphrase.as_ref().map_or(Value::Null, |p| json!(p.as_str()));
                            v["certificate"] = t.certificate.as_ref().map_or(Value::Null, |c| json!(c));
                            v
                        }
                    }
                }
            };
            let want = &session["results"][i];
            // DraftResults also keep 1.1.4's key order.
            let same = if want.get("ok").is_some() {
                serde_json::to_string(&got).unwrap() == serde_json::to_string(want).unwrap()
            } else {
                &got == want
            };
            if !same {
                problems.push(format!("{name} step {i} ({}):\n    port  {got}\n    1.1.4 {want}", step["op"]));
            }
        }
    }
    assert!(problems.is_empty(), "{} differences:\n{}", problems.len(), problems.join("\n"));
}

fn draft_json(r: &DraftResult, tokens: &mut Vec<String>, token: &dyn Fn(&mut Vec<String>, &str) -> String) -> Value {
    let mut v = serde_json::to_value(r).unwrap();
    if let Some(id) = r.draft_id() {
        v["draftId"] = json!(token(tokens, id));
    }
    v
}

// ---- test/ssh-keys.test.ts ----------------------------------------------------------------------------------------

fn ssh_string(b: &[u8]) -> Vec<u8> {
    [&(b.len() as u32).to_be_bytes()[..], b].concat()
}

/// test/helpers/sshKeys.ts `fakeCertificate`.
fn fake_certificate(public_line: &str) -> String {
    let mut parts = public_line.split(' ');
    let ty = parts.next().unwrap();
    let blob = STANDARD.decode(parts.next().unwrap()).unwrap();
    let off = 4 + u32::from_be_bytes(blob[..4].try_into().unwrap()) as usize;
    let cert_type = format!("{ty}-cert-v01@openssh.com");
    let body = [ssh_string(cert_type.as_bytes()), ssh_string(&[1; 32]), blob[off..].to_vec(), vec![2; 40]].concat();
    format!("{cert_type} {} cert", STANDARD.encode(body))
}

fn generate(key_type: KeyType, bits: Option<u32>, passphrase: Option<&str>) -> (String, KeyMeta) {
    let r = generate_key_blocking(&KeyGenRequest {
        key_type,
        bits,
        comment: "unimux@test".into(),
        passphrase: passphrase.map(|p| Zeroizing::new(p.to_string())),
    })
    .unwrap();
    (r.private_key.to_string(), r.meta)
}

const GENERATE_CASES: [(KeyType, Option<u32>, KeyAlgo, u32); 7] = [
    (KeyType::Ed25519, None, KeyAlgo::Ed25519, 256),
    (KeyType::Ecdsa, Some(256), KeyAlgo::EcdsaP256, 256),
    (KeyType::Ecdsa, Some(384), KeyAlgo::EcdsaP384, 384),
    (KeyType::Ecdsa, Some(521), KeyAlgo::EcdsaP521, 521),
    (KeyType::Rsa, Some(2048), KeyAlgo::Rsa, 2048),
    (KeyType::Rsa, Some(3072), KeyAlgo::Rsa, 3072),
    (KeyType::Rsa, Some(4096), KeyAlgo::Rsa, 4096),
];

/// generateKey: every type and size, with and without a passphrase.
#[test]
fn generate_key_every_type_and_size() {
    for (key_type, bits, algo, expected_bits) in GENERATE_CASES {
        for passphrase in [None, Some("pass phrase")] {
            let (private_key, meta) = generate(key_type, bits, passphrase);
            assert_eq!((meta.key_type, meta.bits, meta.comment.as_str()), (algo, expected_bits, "unimux@test"));
            assert_eq!(meta.public_key, format!("{} {} unimux@test", algo.as_str(), STANDARD.encode(&meta.blob)));
            assert_eq!(meta.fingerprint, sha256_fingerprint(&meta.blob));
            let again = parse_private_key(&private_key, passphrase).unwrap();
            assert_eq!(again.meta.fingerprint, meta.fingerprint);
            assert_eq!(again.encrypted, passphrase.is_some());
            // ssh2's layout: 64-character base64 lines, a trailing newline, aes256-ctr + bcrypt when encrypted.
            let lines: Vec<&str> = private_key.lines().collect();
            assert_eq!(lines[0], "-----BEGIN OPENSSH PRIVATE KEY-----");
            assert_eq!(*lines.last().unwrap(), "-----END OPENSSH PRIVATE KEY-----");
            assert!(private_key.ends_with("-----\n"));
            assert!(lines[1..lines.len() - 2].iter().all(|l| l.len() == 64));
            assert!((1..=64).contains(&lines[lines.len() - 2].len()));
            let raw = STANDARD.decode(lines[1..lines.len() - 1].concat()).unwrap();
            let cipher = if passphrase.is_some() { &b"aes256-ctr"[..] } else { b"none" };
            assert_eq!(&raw[15..19], &(cipher.len() as u32).to_be_bytes());
            assert_eq!(&raw[19..19 + cipher.len()], cipher);
            if passphrase.is_some() {
                let kdf = &raw[19 + cipher.len()..];
                assert_eq!(&kdf[..10], &[&6u32.to_be_bytes()[..], b"bcrypt"].concat()[..]);
                // kdf options: string(salt 16) + uint32 rounds 16
                assert_eq!(&kdf[10..14], &24u32.to_be_bytes());
                assert_eq!(&kdf[14..18], &16u32.to_be_bytes());
                assert_eq!(&kdf[34..38], &16u32.to_be_bytes());
            }
        }
    }
}

#[test]
fn generate_key_refuses_sizes_the_generator_does_not_offer() {
    let req = |key_type, bits| KeyGenRequest { key_type, bits: Some(bits), comment: "x".into(), passphrase: None };
    assert_eq!(generate_key_blocking(&req(KeyType::Rsa, 1024)).err(), Some(GenerateError::UnsupportedKeySize));
    assert_eq!(generate_key_blocking(&req(KeyType::Ecdsa, 128)).err(), Some(GenerateError::UnsupportedKeySize));
    // ed25519 ignores bits like 1.1.4; an empty passphrase gives an unencrypted key (JS truthiness).
    let ed = generate_key_blocking(&KeyGenRequest {
        key_type: KeyType::Ed25519,
        bits: Some(1),
        comment: String::new(),
        passphrase: Some(Zeroizing::new(String::new())),
    })
    .unwrap();
    assert_eq!(ed.meta.comment, "");
    assert!(!ed.meta.public_key.ends_with(' '));
    assert!(!parse_private_key(&ed.private_key, None).unwrap().encrypted);
    let rsa = generate_key_blocking(&KeyGenRequest { key_type: KeyType::Rsa, bits: None, comment: "d".into(), passphrase: None });
    assert_eq!(rsa.unwrap().meta.bits, 3072, "DEFAULT_KEY_BITS");
}

#[tokio::test]
async fn generate_key_runs_off_the_async_runtime() {
    let r = generate_key(KeyGenRequest { key_type: KeyType::Ed25519, bits: None, comment: "async".into(), passphrase: None })
        .await
        .unwrap();
    assert_eq!(r.meta.comment, "async");
}

/// parsePrivateKey: accepts OpenSSH, PEM PKCS#1 RSA, PEM SEC1 EC and PPK v2 RSA.
#[test]
fn parse_private_key_accepts_openssh_pem_and_ppk_v2() {
    let ed = parse_private_key(&key_file("openssh-ed25519.key"), None).unwrap();
    assert_eq!((ed.encrypted, ed.meta.key_type, ed.meta.comment.as_str()), (false, KeyAlgo::Ed25519, "sp7 ed25519"));
    let pem = parse_private_key(&key_file("pem-rsa2048.key"), None).unwrap();
    assert_eq!((pem.meta.key_type, pem.meta.bits), (KeyAlgo::Rsa, 2048));
    let ec = parse_private_key(&key_file("pem-ec256.key"), None).unwrap();
    assert_eq!((ec.meta.key_type, ec.meta.bits), (KeyAlgo::EcdsaP256, 256));
    let ppk = parse_private_key(&key_file("ppk2-rsa.ppk"), None).unwrap();
    assert_eq!(ppk.meta.key_type, KeyAlgo::Rsa);
}

/// parsePrivateKey: asks for the passphrase of an encrypted key and checks it.
#[test]
fn parse_private_key_asks_for_and_checks_the_passphrase() {
    let (text, _) = generate(KeyType::Ed25519, None, Some("pw"));
    let err = |p| parse_private_key(&text, p).err().map(|f| (f.error, f.encrypted));
    assert_eq!(err(None), Some((ParseError::NeedsPassphrase, Some(true))));
    assert_eq!(err(Some("nope")), Some((ParseError::BadPassphrase, Some(true))));
    assert!(parse_private_key(&text, Some("pw")).is_ok_and(|p| p.encrypted));
    assert!(check_passphrase(&text, "pw"));
    assert!(!check_passphrase(&text, "nope"));
}

/// parsePrivateKey: rejects what it cannot use with a clear code.
#[test]
fn parse_private_key_rejects_with_clear_codes() {
    let err = |t: &str| parse_private_key(t, None).err().map(|f| f.error);
    let (_, meta) = generate(KeyType::Ed25519, None, None);
    assert_eq!(err(&meta.public_key), Some(ParseError::PublicOnly));
    assert_eq!(err("hello"), Some(ParseError::NotAKey));
    assert_eq!(err(&"x".repeat(64 * 1024 + 1)), Some(ParseError::TooLarge));
    assert_eq!(err("PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: x\n"), Some(ParseError::PpkV3));
    assert_eq!(err("PuTTY-User-Key-File-2: ssh-ed25519\nEncryption: none\nComment: x\n"), Some(ParseError::UnsupportedType));
    assert_eq!(err(&key_file("pkcs8-ed25519.key")), Some(ParseError::NotAKey));
}

/// parsePrivateKey: compares pasted public keys and certificates with the private key.
#[test]
fn pasted_public_keys_and_certificates_are_compared() {
    let (private_key, public) = generate(KeyType::Ed25519, None, None);
    let meta = parse_private_key(&private_key, None).unwrap().meta;
    let other = generate(KeyType::Ed25519, None, None).1.public_key;
    assert!(public_key_matches(&meta, &public.public_key));
    assert!(!public_key_matches(&meta, &other));
    assert!(!public_key_matches(&meta, "garbage"));
    assert_eq!(certificate_check(&fake_certificate(&public.public_key), &meta), CertCheck::Match);
    assert_eq!(certificate_check(&fake_certificate(&other), &meta), CertCheck::Mismatch);
    assert_eq!(certificate_check("ssh-ed25519-cert-v01@openssh.com AAAA", &meta), CertCheck::Doubt);
    assert_eq!(certificate_check("not a certificate", &meta), CertCheck::Mismatch);
}

fn none(_: &str) -> Option<String> {
    None
}

fn input(private_key: &str) -> DraftInput {
    DraftInput { private_key: Zeroizing::new(private_key.to_string()), ..DraftInput::default() }
}

/// KeyDrafts: keeps at most 20 drafts and evicts the oldest (D3).
#[test]
fn key_drafts_keep_at_most_20_and_evict_the_oldest() {
    let mut drafts = KeyDrafts::new();
    let key = key_file("openssh-ed25519.key");
    let ids: Vec<String> =
        (0..MAX_KEY_DRAFTS + 2).map(|_| drafts.create(input(&key), &none).draft_id().unwrap().to_string()).collect();
    assert_eq!(MAX_KEY_DRAFTS, 20);
    assert!(drafts.take(&ids[0]).is_none());
    assert!(drafts.take(&ids[1]).is_none());
    assert!(drafts.take(&ids[2]).is_some());
    assert!(drafts.take(ids.last().unwrap()).is_some());
}

/// KeyDrafts: creates, unlocks, flags duplicates and mismatches, and expires drafts.
#[test]
fn key_drafts_create_unlock_flag_and_expire() {
    let now = Arc::new(AtomicU64::new(0));
    let clock = now.clone();
    let mut drafts = KeyDrafts::with_clock(Box::new(move || clock.load(Ordering::SeqCst)), 10 * 60_000);
    let (enc, _) = generate(KeyType::Ed25519, None, Some("pw"));
    let locked = drafts.create(input(&enc), &none);
    let json = serde_json::to_value(&locked).unwrap();
    assert_eq!(
        (json["ok"].clone(), json["needsPassphrase"].clone(), json["encrypted"].clone()),
        (json!(true), json!(true), json!(true))
    );
    let id = locked.draft_id().unwrap().to_string();
    assert_eq!(
        serde_json::to_value(drafts.unlock(&id, "nope", &none)).unwrap(),
        json!({ "ok": false, "error": "badPassphrase" })
    );
    let existing = |_: &str| Some("existing-id".to_string());
    let open = serde_json::to_value(drafts.unlock(&id, "pw", &existing)).unwrap();
    assert_eq!((open["needsPassphrase"].clone(), open["type"].clone()), (json!(false), json!("ssh-ed25519")));
    assert_eq!(open["duplicateOf"], json!("existing-id"));
    let taken = drafts.take(&id).unwrap();
    assert_eq!(*taken.text, enc);
    assert_eq!(taken.passphrase.as_deref().map(String::as_str), Some("pw"));
    assert!(drafts.take(&id).is_none());

    let (plain, _) = generate(KeyType::Ed25519, None, None);
    let other = generate(KeyType::Ed25519, None, None).1.public_key;
    let with = |public_key: Option<String>, certificate: Option<String>| DraftInput {
        private_key: Zeroizing::new(plain.clone()),
        public_key,
        certificate,
    };
    let err = |r: DraftResult| serde_json::to_value(r).unwrap();
    assert_eq!(err(drafts.create(with(Some(other.clone()), None), &none)), json!({ "ok": false, "error": "mismatch" }));
    assert_eq!(
        err(drafts.create(with(None, Some(fake_certificate(&other))), &none)),
        json!({ "ok": false, "error": "certMismatch" })
    );
    let warn = err(drafts.create(with(None, Some("ssh-ed25519-cert-v01@openssh.com AAAA".into())), &none));
    assert_eq!(warn["certificateWarning"], json!(true));
    let late = drafts.create(input(&plain), &none).draft_id().unwrap().to_string();
    now.store(10 * 60_000 + 1, Ordering::SeqCst);
    assert!(drafts.take(&late).is_none());
}

/// KeyDrafts: never returns private material in a draft result.
#[test]
fn key_drafts_never_return_private_material() {
    let (plain, _) = generate(KeyType::Ed25519, None, None);
    let result = KeyDrafts::new().create(input(&plain), &none);
    assert!(!serde_json::to_string(&result).unwrap().contains("PRIVATE KEY"));
}

// ---- ssh-keygen -y ------------------------------------------------------------------------------------------------

fn ssh_keygen() -> Option<PathBuf> {
    let windows = Path::new(r"C:\Windows\System32\OpenSSH\ssh-keygen.exe");
    if cfg!(windows) && windows.exists() {
        return Some(windows.to_path_buf());
    }
    let ok = std::process::Command::new("ssh-keygen").arg("-?").output().is_ok();
    ok.then(|| PathBuf::from("ssh-keygen"))
}

/// Generated keys are read by OpenSSH: `ssh-keygen -y` prints the same public key (type and blob) for every type, size
/// and both encryption states. Set UNIMUX_REQUIRE_SSH_KEYGEN=1 to fail when no ssh-keygen is installed.
#[test]
fn generated_keys_pass_ssh_keygen() {
    let Some(keygen) = ssh_keygen() else {
        assert!(std::env::var_os("UNIMUX_REQUIRE_SSH_KEYGEN").is_none(), "ssh-keygen not found");
        eprintln!("ssh-keygen not found: skipped");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let checked = Cell::new(0);
    for (key_type, bits, _, _) in GENERATE_CASES {
        for passphrase in [None, Some("pass phrase")] {
            let (private_key, meta) = generate(key_type, bits, passphrase);
            let path = dir.path().join(format!("k{}", checked.get()));
            std::fs::write(&path, &private_key).unwrap();
            restrict_to_owner(&path);
            let out = std::process::Command::new(&keygen)
                .args(["-y", "-P", passphrase.unwrap_or(""), "-f"])
                .arg(&path)
                .output()
                .unwrap();
            let stdout = String::from_utf8_lossy(&out.stdout);
            assert!(out.status.success(), "{key_type:?} {bits:?}: {}", String::from_utf8_lossy(&out.stderr));
            let mut got = stdout.split_whitespace();
            let mut want = meta.public_key.split(' ');
            assert_eq!((got.next(), got.next()), (want.next(), want.next()), "{key_type:?} {bits:?}");
            checked.set(checked.get() + 1);
        }
    }
    assert_eq!(checked.get(), 14);
}

/// OpenSSH refuses private key files others can read.
fn restrict_to_owner(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    #[cfg(windows)]
    {
        let user = std::env::var("USERNAME").unwrap();
        let out = std::process::Command::new("icacls")
            .arg(path)
            .args(["/inheritance:r", "/grant:r"])
            .arg(format!("{user}:F"))
            .output()
            .unwrap();
        assert!(out.status.success(), "icacls: {}", String::from_utf8_lossy(&out.stdout));
    }
}
