//! SP2 spike tool, driven by scripts/spike-sp2-safestorage.mjs. Works on a scratch data dir only.
//!
//! - `inspect <data dir>`: JSON report of `Local State` (os_crypt keys) and every `"secret"` blob in ssh/vault.json,
//!   db/vault.json and github/token.json: prefix, length, decrypted text, decrypt time.
//! - `rewrite <data dir>`: decrypts every secret and replaces it in place (only that base64 string changes in the file)
//!   with a fresh Rust encryption of the same text. `Local State` is not touched.
//! - `export-key <data dir>`: hex of the DPAPI-unwrapped key (throwaway profiles only: for the committed fixture).
//! - `fresh <empty data dir> <text>...`: opens the cipher on a dir without `Local State` (so Rust creates it) and prints
//!   `{"text": "<base64 blob>"}` for Electron to decrypt.

use std::path::{Path, PathBuf};
use std::time::Instant;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use unimux_oscrypt::{Cipher, local_state};

const FILES: [&str; 3] = ["ssh/vault.json", "db/vault.json", "github/token.json"];

fn secrets(value: &Value, out: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (k, v) in map {
                match (k.as_str(), v) {
                    ("secret", Value::String(s)) => out.push(s.clone()),
                    _ => secrets(v, out),
                }
            }
        }
        Value::Array(items) => items.iter().for_each(|v| secrets(v, out)),
        _ => {}
    }
}

fn file_secrets(path: &Path) -> Vec<String> {
    let Ok(text) = std::fs::read(path) else { return Vec::new() };
    let value: Value = serde_json::from_slice(&text).expect("vault file is JSON");
    let mut out = Vec::new();
    secrets(&value, &mut out);
    out
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = PathBuf::from(args.get(1).expect("usage: sp2_tool <inspect|rewrite|export-key|fresh> <data dir>"));
    match args[0].as_str() {
        "inspect" => inspect(&dir),
        "rewrite" => rewrite(&dir),
        "export-key" => export_key(&dir),
        "fresh" => fresh(&dir, &args[2..]),
        other => panic!("unknown command {other}"),
    }
}

fn open(dir: &Path) -> (Cipher, f64) {
    let t = Instant::now();
    let cipher = Cipher::open(dir, "unimux", false);
    (cipher, t.elapsed().as_secs_f64() * 1000.0)
}

fn inspect(dir: &Path) {
    let local = std::fs::read(local_state::path(dir)).ok();
    let os_crypt = local
        .as_ref()
        .and_then(|t| serde_json::from_slice::<Value>(t).ok())
        .and_then(|v| v.get("os_crypt").cloned())
        .map(|o| o.as_object().map(|m| m.keys().cloned().collect::<Vec<_>>()).unwrap_or_default());
    let top_keys = local
        .as_ref()
        .and_then(|t| serde_json::from_slice::<Value>(t).ok())
        .and_then(|v| v.as_object().map(|m| m.keys().cloned().collect::<Vec<_>>()));
    let (cipher, open_ms) = open(dir);
    let mut files = serde_json::Map::new();
    for name in FILES {
        let mut entries = Vec::new();
        for secret in file_secrets(&dir.join(name)) {
            let blob = STANDARD.decode(&secret).expect("base64");
            let t = Instant::now();
            let result = cipher.decrypt(&blob);
            let us = t.elapsed().as_secs_f64() * 1e6;
            entries.push(json!({
                "prefix": String::from_utf8_lossy(&blob[..3.min(blob.len())]),
                "bytes": blob.len(),
                "text": result.as_ref().ok().map(|s| s.as_str().to_owned()),
                "error": result.as_ref().err().map(|e| e.to_string()),
                "decryptMicros": us,
            }));
        }
        files.insert(name.into(), Value::Array(entries));
    }
    let report = json!({
        "storage": cipher.storage().as_str(),
        "origin": format!("{:?}", cipher.origin()),
        "openMillis": open_ms,
        "localStateKeys": top_keys,
        "osCryptKeys": os_crypt,
        "files": files,
    });
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
}

fn rewrite(dir: &Path) {
    let (cipher, _) = open(dir);
    assert!(cipher.available(), "cipher unavailable: {:?}", cipher.origin());
    let mut changed = Vec::new();
    for name in FILES {
        let path = dir.join(name);
        let Ok(mut text) = std::fs::read_to_string(&path) else { continue };
        for secret in file_secrets(&path) {
            let plain = cipher.decrypt(&STANDARD.decode(&secret).unwrap()).expect("Electron's blob decrypts");
            let fresh = STANDARD.encode(cipher.encrypt(&plain).unwrap());
            assert_eq!(text.matches(&secret).count(), 1, "each blob is unique in its file");
            text = text.replace(&secret, &fresh);
            changed.push(json!({ "file": name, "old": secret, "new": fresh }));
        }
        std::fs::write(&path, text).unwrap();
    }
    println!("{}", serde_json::to_string_pretty(&changed).unwrap());
}

#[cfg(windows)]
fn export_key(dir: &Path) {
    let text = std::fs::read(local_state::path(dir)).expect("Local State");
    let local_state::KeyEntry::Dpapi(blob) = local_state::parse(&text) else { panic!("no DPAPI key") };
    let key = unimux_oscrypt::dpapi::unprotect(&blob).expect("CryptUnprotectData");
    println!("{}", key.iter().map(|b| format!("{b:02x}")).collect::<String>());
}

#[cfg(not(windows))]
fn export_key(_dir: &Path) {
    panic!("export-key is Windows only");
}

fn fresh(dir: &Path, texts: &[String]) {
    assert!(!local_state::path(dir).exists(), "fresh needs a dir without Local State");
    let (cipher, open_ms) = open(dir);
    let blobs: serde_json::Map<String, Value> =
        texts.iter().map(|t| (t.clone(), Value::String(STANDARD.encode(cipher.encrypt(t).unwrap())))).collect();
    println!(
        "{}",
        json!({ "origin": format!("{:?}", cipher.origin()), "openMillis": open_ms, "localState": std::fs::read_to_string(local_state::path(dir)).ok(), "blobs": blobs })
    );
}
