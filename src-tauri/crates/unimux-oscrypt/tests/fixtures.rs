//! SP2 fixtures (tests/fixtures/win-electron45, written by scripts/spike-sp2-safestorage.mjs on a throwaway profile):
//! blobs from Electron 45.2.2 (unimux 1.1.4 safeStorage) and from this crate, the `Local State` they belong to, the
//! DPAPI-unwrapped key (throwaway, so the AES layer is tested on every OS), and macOS v10 vectors from Node's crypto.

use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::Value;
use unimux_oscrypt::{Cipher, local_state, v10};

const FILES: [&str; 3] = ["ssh/vault.json", "db/vault.json", "github/token.json"];

fn dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/win-electron45")
}

fn json(path: &Path) -> Value {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

fn hex(text: &str) -> Vec<u8> {
    let text = text.trim();
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

fn secrets(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => map.iter().for_each(|(k, v)| match (k.as_str(), v) {
            ("secret", Value::String(s)) => out.push(s.clone()),
            _ => secrets(v, out),
        }),
        Value::Array(items) => items.iter().for_each(|v| secrets(v, out)),
        _ => {}
    }
}

fn blobs(side: &str, file: &str) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    secrets(&json(&dir().join(side).join(file)), &mut out);
    out.iter().map(|s| STANDARD.decode(s).unwrap()).collect()
}

fn fixture_cipher() -> Cipher {
    let key: [u8; 32] = hex(&std::fs::read_to_string(dir().join("key.hex")).unwrap()).try_into().unwrap();
    Cipher::with_gcm_key(key)
}

/// The decrypted text matches expected.json (the SSH key secret is JSON: its passphrase and the PEM header are compared).
fn matches(expected: &Value, text: &str) -> bool {
    match expected {
        Value::String(s) => s == text,
        Value::Object(o) => {
            let v: Value = serde_json::from_str(text).unwrap();
            v["passphrase"] == o["passphrase"]
                && v["privateKey"].as_str().unwrap().starts_with(o["privateKeyStartsWith"].as_str().unwrap())
        }
        _ => false,
    }
}

#[test]
fn electron_and_rust_blobs_decrypt_to_the_expected_texts() {
    let cipher = fixture_cipher();
    let expected = json(&dir().join("expected.json"));
    assert_eq!(expected["electron"], "45.2.2");
    for side in ["electron", "rust"] {
        for file in FILES {
            let want = expected[file].as_array().unwrap();
            let got = blobs(side, file);
            assert_eq!(got.len(), want.len(), "{side} {file}");
            for (blob, want) in got.iter().zip(want) {
                assert!(v10::has_prefix(blob), "{side} {file}: v10, not v20 (app-bound)");
                let text = cipher.decrypt(blob).unwrap_or_else(|e| panic!("{side} {file}: {e}"));
                assert!(matches(want, &text), "{side} {file}: {text:?} vs {want}");
            }
        }
    }
}

#[test]
fn rust_blobs_have_electrons_layout_and_their_own_nonces() {
    for file in FILES {
        for (e, r) in blobs("electron", file).iter().zip(blobs("rust", file)) {
            assert_eq!(e.len(), r.len(), "{file}: same length for the same text");
            assert_ne!(e[3..15], r[3..15], "{file}: a fresh nonce");
        }
    }
}

#[test]
fn local_state_files_have_chromiums_shape() {
    for name in ["Local State", "Local State.after-fresh"] {
        let text = std::fs::read(dir().join(name)).unwrap();
        assert!(matches!(local_state::parse(&text), local_state::KeyEntry::Dpapi(_)), "{name}");
        let v: Value = serde_json::from_slice(&text).unwrap();
        assert_eq!(v["os_crypt"]["audit_enabled"], true, "{name}");
        assert!(v["os_crypt"].get("app_bound_encrypted_key").is_none(), "{name}: no v20 key");
    }
}

/// Only for the Windows user who ran the spike: anyone else (CI) cannot unwrap the DPAPI blob, which is the point of DPAPI.
#[cfg(windows)]
#[test]
fn local_state_unwraps_to_the_fixture_key_for_the_spike_user() {
    let tmp = tempfile::tempdir().unwrap();
    std::fs::copy(dir().join("Local State"), local_state::path(tmp.path())).unwrap();
    let cipher = Cipher::open(tmp.path(), "unimux", false);
    match cipher.origin() {
        unimux_oscrypt::Origin::Existing => {
            assert_eq!(cipher.storage(), unimux_oscrypt::Storage::Dpapi);
            let blob = &blobs("electron", "db/vault.json")[0];
            assert_eq!(cipher.decrypt(blob).unwrap().as_str(), fixture_cipher().decrypt(blob).unwrap().as_str());
            assert_eq!(
                std::fs::read(local_state::path(tmp.path())).unwrap(),
                std::fs::read(dir().join("Local State")).unwrap(),
                "a usable key is never rewritten"
            );
        }
        // Another Windows user: Chromium (kDecryptionFailed) and unimux store a new key, the old blobs stay locked.
        unimux_oscrypt::Origin::Replaced(reason) => {
            eprintln!("the fixture Local State belongs to another Windows user: {reason}");
            assert_eq!(cipher.storage(), unimux_oscrypt::Storage::Dpapi);
            assert!(cipher.decrypt(&blobs("electron", "db/vault.json")[0]).is_err());
        }
        other => panic!("unexpected origin {other:?}"),
    }
}

#[test]
fn mac_vectors_round_trip_byte_for_byte() {
    let mac = json(&dir().join("mac-v10.json"));
    let password = mac["password"].as_str().unwrap();
    assert_eq!(v10::mac_key(password.as_bytes()).to_vec(), hex(mac["key"].as_str().unwrap()));
    let cipher = Cipher::with_mac_password(password.as_bytes());
    for vector in mac["vectors"].as_array().unwrap() {
        let (text, blob) = (vector["text"].as_str().unwrap(), STANDARD.decode(vector["blob"].as_str().unwrap()).unwrap());
        assert_eq!(cipher.decrypt(&blob).unwrap().as_str(), text);
        assert_eq!(cipher.encrypt(text).unwrap(), blob, "CBC with the fixed IV is deterministic: {text:?}");
    }
}
