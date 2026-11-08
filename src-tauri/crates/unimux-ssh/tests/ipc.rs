//! The key, password and known-host channels (`SshIpc`) against 1.1.4's test/ssh-ipc.test.ts: fixed codes, no secret in
//! any answer, writes that fail answer `failed`, and the private key reveal / replace of 0.9.2. The sender check (R9) is
//! the router's (unimux-ipc), the connect / answer schemas are unimux-app's (commands/ssh/link.rs).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use parking_lot::Mutex;
use serde_json::{Value, json};
use unimux_oscrypt::Cipher;
use unimux_ssh::ipc::{HostFuture, KEY_CHANNELS, SshIpc, SshIpcHost};
use unimux_ssh::keys::{DraftError, KeyGenRequest, KeyType, generate_key_blocking};
use unimux_ssh::stores::SshStores;
use zeroize::Zeroizing;

const HOST: &str = "00000000-0000-4000-8000-000000000001";
const IDENTITY: &str = "00000000-0000-4000-8000-0000000000a1";
const KEY_GONE: &str = "00000000-0000-4000-8000-000000000099";
const PASSPHRASE: &str = "ipc-pass-phrase";

struct FakeHost {
    state: Mutex<Value>,
    changes: AtomicUsize,
    written: Mutex<Vec<(String, String)>>,
    export_dir: PathBuf,
    dialog_fails: AtomicBool,
    write_fails: AtomicBool,
    pick: Mutex<Option<String>>,
}

impl SshIpcHost for FakeHost {
    fn state(&self) -> Arc<Value> {
        Arc::new(self.state.lock().clone())
    }
    fn change(&self, edit: &(dyn Fn(&Value) -> Option<Value> + Send + Sync)) {
        let mut s = self.state.lock();
        if let Some(next) = edit(&s) {
            *s = next;
        }
    }
    fn vault_changed(&self) {
        self.changes.fetch_add(1, Ordering::SeqCst);
    }
    fn pick_key_file(&self) -> HostFuture<Option<String>> {
        let picked = self.pick.lock().clone();
        Box::pin(async move { picked })
    }
    fn save_key_file(&self, default_name: String) -> HostFuture<Result<Option<String>, ()>> {
        let r = if self.dialog_fails.load(Ordering::SeqCst) {
            Err(())
        } else {
            Ok(Some(self.export_dir.join(default_name).to_string_lossy().into_owned()))
        };
        Box::pin(async move { r })
    }
    fn write_key_file(&self, path: String, text: Zeroizing<String>) -> HostFuture<std::io::Result<()>> {
        let r = if self.write_fails.load(Ordering::SeqCst) {
            Err(std::io::Error::other("EPERM: operation not permitted, open D:\\private\\exported"))
        } else {
            self.written.lock().push((path, text.to_string()));
            Ok(())
        };
        Box::pin(async move { r })
    }
    fn hostname(&self) -> String {
        "testbox".into()
    }
}

struct Fx {
    ipc: Arc<SshIpc>,
    host: Arc<FakeHost>,
    stores: Arc<SshStores>,
    dir: tempfile::TempDir,
}

fn state() -> Value {
    json!({
        "version": 1,
        "projects": [{ "id": "p", "tabs": [{ "id": "t", "cells": [{ "id": "c", "profileId": "shell", "ssh": { "hostId": HOST } }] }] }],
        "sshHosts": [{ "id": HOST, "label": "web", "address": "web.example", "port": 22, "username": "u" }],
        "sshIdentities": [],
    })
}

async fn stores_on(dir: &Path, key: u8) -> Arc<SshStores> {
    let stores = SshStores::new(dir, Arc::new(Cipher::with_gcm_key([key; 32])), Arc::new(|_: &str| true));
    stores.init().await;
    stores
}

async fn setup() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let stores = stores_on(dir.path(), 7).await;
    let host = Arc::new(FakeHost {
        state: Mutex::new(state()),
        changes: AtomicUsize::new(0),
        written: Mutex::new(Vec::new()),
        export_dir: dir.path().join("export"),
        dialog_fails: AtomicBool::new(false),
        write_fails: AtomicBool::new(false),
        pick: Mutex::new(None),
    });
    let ipc = SshIpc::new(stores.clone(), host.clone());
    Fx { ipc, host, stores, dir }
}

impl Fx {
    async fn ask(&self, channel: &str, arg: Value) -> Value {
        self.ipc.invoke(channel, &arg).await.unwrap()
    }
    async fn generate(&self, label: &str) -> Value {
        let r = self.ask("ssh:key:generate", json!({ "label": label, "type": "ed25519", "savePassphrase": false })).await;
        assert_eq!(r["ok"], true, "{r}");
        r["key"].clone()
    }
    async fn reveal(&self, id: &Value) -> String {
        let r = self.ask("ssh:key:revealPrivate", json!({ "id": id })).await;
        r["privateKey"].as_str().unwrap_or_else(|| panic!("{r}")).to_string()
    }
    /// A ready (unlocked) draft of the encrypted fixture key.
    async fn ready_draft(&self, text: &str) -> Value {
        let draft = self.ask("ssh:key:draftFromText", json!({ "privateKey": text })).await;
        assert_eq!((draft["ok"].as_bool(), draft["needsPassphrase"].as_bool()), (Some(true), Some(true)), "{draft}");
        let unlocked = self.ask("ssh:key:unlockDraft", json!({ "draftId": draft["draftId"], "passphrase": PASSPHRASE })).await;
        assert_eq!(unlocked["ok"], true, "{unlocked}");
        draft["draftId"].clone()
    }
    fn vault_file(&self) -> PathBuf {
        self.stores.dir().join("vault.json")
    }
}

/// A non-empty folder where the store file belongs: every later write of that store fails.
fn break_file(path: &Path) {
    let _ = std::fs::remove_file(path);
    std::fs::create_dir_all(path.join("child")).unwrap();
}

fn fix_file(path: &Path) {
    std::fs::remove_dir_all(path).unwrap();
}

fn generated(key_type: KeyType, bits: Option<u32>, comment: &str, passphrase: Option<&str>) -> String {
    let g = generate_key_blocking(&KeyGenRequest {
        key_type,
        bits,
        comment: comment.into(),
        passphrase: passphrase.map(|p| Zeroizing::new(p.to_string())),
    })
    .unwrap();
    g.private_key.to_string()
}

/// The encrypted fixture key of the file (one per run: bcrypt is slow).
fn encrypted_pair() -> &'static str {
    static PAIR: std::sync::OnceLock<String> = std::sync::OnceLock::new();
    PAIR.get_or_init(|| generated(KeyType::Ed25519, None, "fixture", Some(PASSPHRASE)))
}

fn secrets() -> Vec<String> {
    let line = encrypted_pair().lines().nth(1).unwrap().to_string();
    vec![line, PASSPHRASE.into(), "ipc-host-password".into(), "ipc-identity-password".into()]
}

fn leaks(v: &Value) -> Vec<String> {
    let text = v.to_string();
    secrets().into_iter().filter(|s| text.contains(s.as_str())).collect()
}

/// test/helpers/sshKeys.ts fakeCertificate: a certificate line whose embedded public key is the given key's.
fn fake_certificate(public_line: &str) -> String {
    let mut parts = public_line.split(' ');
    let (key_type, b64) = (parts.next().unwrap(), parts.next().unwrap());
    let blob = STANDARD.decode(b64).unwrap();
    let off = 4 + u32::from_be_bytes(blob[..4].try_into().unwrap()) as usize;
    let cert_type = format!("{key_type}-cert-v01@openssh.com");
    let ssh_string = |b: &[u8]| [&(b.len() as u32).to_be_bytes()[..], b].concat();
    let body = [ssh_string(cert_type.as_bytes()), ssh_string(&[1u8; 32]), blob[off..].to_vec(), vec![2u8; 40]].concat();
    format!("{cert_type} {} cert", STANDARD.encode(body))
}

fn sp7_key(name: &str) -> String {
    std::fs::read_to_string(format!("{}/../../../test/golden/sp7/keys/{name}", env!("CARGO_MANIFEST_DIR"))).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn rejects_malformed_payloads_and_unknown_owners_before_anything_runs() {
    let f = setup().await;
    let invalid = json!({ "ok": false, "error": "invalid" });
    assert_eq!(f.ask("ssh:key:draftFromText", json!({ "privateKey": "x".repeat(64 * 1024 + 1) })).await, invalid);
    assert_eq!(f.ask("ssh:password:set", json!({ "hostId": HOST, "password": "x".repeat(1025) })).await, invalid);
    assert_eq!(
        f.ask("ssh:password:set", json!({ "hostId": "00000000-0000-4000-8000-000000000009", "password": "p" })).await,
        json!({ "ok": false, "error": "notFound" })
    );
    assert!(f.ipc.invoke("ssh:connect", &json!({})).await.is_none(), "connect is the coordinator's channel");
    assert_eq!(f.host.changes.load(Ordering::SeqCst), 0);
    assert!(!f.vault_file().exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn reads_key_files_only_from_absolute_paths_to_small_regular_files() {
    let f = setup().await;
    let read_failed = json!({ "ok": false, "error": "readFailed" });
    assert_eq!(f.ask("ssh:key:draftFromFile", json!({ "path": "relative/key" })).await, read_failed);
    let folder = f.dir.path().join("folder");
    std::fs::create_dir(&folder).unwrap();
    assert_eq!(f.ask("ssh:key:draftFromFile", json!({ "path": folder })).await, read_failed);
    let big = f.dir.path().join("big");
    std::fs::write(&big, "x".repeat(64 * 1024 + 1)).unwrap();
    assert_eq!(f.ask("ssh:key:draftFromFile", json!({ "path": big })).await, json!({ "ok": false, "error": "tooLarge" }));
    let key = f.dir.path().join("id_test");
    std::fs::write(&key, encrypted_pair()).unwrap();
    let r = f.ask("ssh:key:draftFromFile", json!({ "path": key })).await;
    assert_eq!((r["ok"].as_bool(), r["needsPassphrase"].as_bool()), (Some(true), Some(true)), "{r}");
    assert!(matches!(unimux_ssh::ipc::read_key_file_from_disk("relative"), Err(DraftError::ReadFailed)));
}

#[tokio::test(flavor = "multi_thread")]
async fn imports_generates_exports_and_removes_keys_without_returning_private_material() {
    let f = setup().await;
    let draft = f.ready_draft(encrypted_pair()).await;
    let committed = f.ask("ssh:key:commitDraft", json!({ "draftId": draft, "label": "imported", "savePassphrase": false })).await;
    assert_eq!(
        (committed["ok"].as_bool(), committed["key"]["label"].as_str(), committed["key"]["encrypted"].as_bool()),
        (Some(true), Some("imported"), Some(true))
    );
    assert_eq!(committed["key"]["passphraseSaved"], false);
    let info = f.stores.vault().await.lock().info();
    for v in [&committed, &info] {
        assert!(leaks(v).is_empty(), "{v}");
    }
    assert!(f.host.changes.load(Ordering::SeqCst) > 0);

    let key = f.generate("gen").await;
    let public = key["publicKey"].as_str().unwrap();
    assert!(public.starts_with("ssh-ed25519 ") && public.ends_with(" unimux@testbox"), "{public}");
    assert!(!key.to_string().contains("PRIVATE KEY"));
    assert_eq!(f.ask("ssh:key:exportPrivate", json!({ "id": key["id"] })).await, json!({ "ok": true }));
    assert!(f.host.written.lock()[0].1.contains("BEGIN OPENSSH PRIVATE KEY"));
    assert_eq!(f.ask("ssh:key:exportPrivate", json!({ "id": KEY_GONE })).await, json!({ "ok": false, "error": "notFound" }));
    // Export failures answer a fixed code, never the raw error text.
    f.host.write_fails.store(true, Ordering::SeqCst);
    let failed_write = f.ask("ssh:key:exportPrivate", json!({ "id": key["id"] })).await;
    f.host.dialog_fails.store(true, Ordering::SeqCst);
    let failed_dialog = f.ask("ssh:key:exportPrivate", json!({ "id": key["id"] })).await;
    for r in [failed_write, failed_dialog] {
        assert_eq!(r, json!({ "ok": false, "error": "failed" }));
    }

    // Removing a key clears it from hosts and identities.
    {
        let mut s = f.host.state.lock();
        s["sshHosts"][0]["keyId"] = key["id"].clone();
        s["sshIdentities"] = json!([{ "id": IDENTITY, "label": "me", "username": "me", "keyId": key["id"] }]);
    }
    assert_eq!(f.ask("ssh:key:remove", json!({ "id": key["id"] })).await, json!({ "ok": true }));
    let s = f.host.state.lock().clone();
    assert!(s["sshHosts"][0].get("keyId").is_none());
    assert!(s["sshIdentities"][0].get("keyId").is_none());
}

#[tokio::test(flavor = "multi_thread")]
async fn stores_host_and_identity_passwords_only_for_known_owners_without_echoing_them() {
    let f = setup().await;
    let r = f.ask("ssh:password:set", json!({ "hostId": HOST, "password": "ipc-host-password" })).await;
    assert_eq!(r, json!({ "ok": true, "ephemeral": false }));
    let info = f.stores.vault().await.lock().info();
    assert!(leaks(&info).is_empty());
    assert_eq!(info["savedPasswords"], json!([HOST]));
    assert_eq!(f.ask("ssh:password:clear", json!({ "hostId": HOST })).await, json!({ "ok": true }));

    let set = |id: &str, pw: &str| json!({ "identityId": id, "password": pw });
    let not_found = json!({ "ok": false, "error": "notFound" });
    let invalid = json!({ "ok": false, "error": "invalid" });
    assert_eq!(f.ask("ssh:identityPassword:set", set(IDENTITY, "ipc-identity-password")).await, not_found);
    f.host.state.lock()["sshIdentities"] = json!([{ "id": IDENTITY, "label": "me", "username": "me" }]);
    assert_eq!(f.ask("ssh:identityPassword:set", set(IDENTITY, &"x".repeat(1025))).await, invalid);
    assert_eq!(f.ask("ssh:identityPassword:set", set("not-a-uuid", "p")).await, invalid);
    assert_eq!(f.ask("ssh:identityPassword:set", set(IDENTITY, "")).await, invalid);
    let mut with_host = set(IDENTITY, "p");
    with_host["hostId"] = json!(HOST);
    assert_eq!(f.ask("ssh:identityPassword:set", with_host).await, invalid);
    let before = f.host.changes.load(Ordering::SeqCst);
    let r = f.ask("ssh:identityPassword:set", set(IDENTITY, "ipc-identity-password")).await;
    assert_eq!(r, json!({ "ok": true, "ephemeral": false }));
    assert!(f.host.changes.load(Ordering::SeqCst) > before);
    let vault = f.stores.vault().await;
    let info = vault.lock().info();
    assert!(leaks(&info).is_empty());
    assert_eq!(
        (&info["savedPasswords"], &info["savedIdentityPasswords"], &info["lockedIdentityPasswords"]),
        (&json!([]), &json!([IDENTITY]), &json!([]))
    );
    assert_eq!(vault.lock().identity_password(IDENTITY).unwrap().as_str(), "ipc-identity-password");
    assert_eq!(f.ask("ssh:identityPassword:clear", json!({ "identityId": "nope" })).await, json!({ "ok": false }));
    assert_eq!(f.ask("ssh:identityPassword:clear", json!({ "identityId": IDENTITY })).await, json!({ "ok": true }));
    assert_eq!(vault.lock().info()["savedIdentityPasswords"], json!([]));
}

#[tokio::test(flavor = "multi_thread")]
async fn generate_failures_and_passphrase_saves_answer_fixed_codes() {
    let f = setup().await;
    // A size the generator does not offer: a fixed code, nothing stored.
    let r = f.ask("ssh:key:generate", json!({ "label": "bad", "type": "rsa", "bits": 1234, "savePassphrase": false })).await;
    assert_eq!(r, json!({ "ok": false, "error": "failed" }));
    assert_eq!(f.stores.vault().await.lock().info()["keys"], json!([]));

    // A generated encrypted key and an imported one: a passphrase is saved only when it opens the key.
    let r = f
        .ask("ssh:key:generate", json!({ "label": "gen", "type": "ed25519", "passphrase": PASSPHRASE, "savePassphrase": false }))
        .await;
    assert_eq!(r["ok"], true, "{r}");
    let draft = f.ready_draft(encrypted_pair()).await;
    let imported = f.ask("ssh:key:commitDraft", json!({ "draftId": draft, "label": "k", "savePassphrase": false })).await;
    for id in [&r["key"]["id"], &imported["key"]["id"]] {
        let save = |pp: &str| json!({ "id": id, "passphrase": { "save": pp } });
        assert_eq!(f.ask("ssh:key:update", save("not-the-passphrase")).await, json!({ "ok": false, "error": "badPassphrase" }));
        assert!(!f.stores.vault().await.lock().key(id.as_str().unwrap()).unwrap().meta.passphrase_saved);
        let saved = f.ask("ssh:key:update", save(PASSPHRASE)).await;
        assert_eq!((saved["ok"].as_bool(), saved["key"]["passphraseSaved"].as_bool()), (Some(true), Some(true)));
        assert!(leaks(&saved).is_empty());
        let forgot = f.ask("ssh:key:update", json!({ "id": id, "passphrase": { "forget": true } })).await;
        assert_eq!(forgot["key"]["passphraseSaved"], false);
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn answers_fixed_codes_when_the_vault_or_known_hosts_file_cannot_be_written() {
    let f = setup().await;
    let draft = f.ready_draft(encrypted_pair()).await;
    let vault_file = f.vault_file();
    f.ask("ssh:password:set", json!({ "hostId": HOST, "password": "ipc-host-password" })).await;
    let before = f.host.changes.load(Ordering::SeqCst);
    break_file(&vault_file);
    let failed = json!({ "ok": false, "error": "failed" });
    assert_eq!(f.ask("ssh:password:set", json!({ "hostId": HOST, "password": "ipc-host-password" })).await, failed);
    assert_eq!(f.ask("ssh:password:clear", json!({ "hostId": HOST })).await, json!({ "ok": false }));
    assert_eq!(f.ask("ssh:key:generate", json!({ "label": "gen", "type": "ed25519", "savePassphrase": false })).await, failed);
    assert_eq!(f.ask("ssh:key:commitDraft", json!({ "draftId": draft, "label": "x", "savePassphrase": true })).await, failed);
    assert_eq!(f.ask("ssh:key:remove", json!({ "id": "00000000-0000-4000-8000-000000000042" })).await, json!({ "ok": false }));
    // A known host that exists, with its file blocked: the removal fails with the plain refusal.
    let known = f.stores.known_hosts().await;
    let blob = [&11u32.to_be_bytes()[..], b"ssh-ed25519", &32u32.to_be_bytes()[..], &[1u8; 32][..]].concat();
    assert!(known.lock().trust("a", 22, &blob, unimux_ssh::known_hosts::TrustMode::Save).unwrap());
    let id = known.lock().list()[0].id.clone();
    break_file(&f.stores.dir().join("known_hosts.json"));
    assert_eq!(f.ask("ssh:knownHosts:remove", json!({ "id": id })).await, json!({ "ok": false }));
    assert_eq!(known.lock().list().len(), 1);
    assert_eq!(f.host.changes.load(Ordering::SeqCst), before);
}

#[tokio::test(flavor = "multi_thread")]
async fn reports_read_only_stores_and_never_writes_over_them() {
    let dir = tempfile::tempdir().unwrap();
    let ssh = dir.path().join("ssh");
    std::fs::create_dir_all(&ssh).unwrap();
    std::fs::write(ssh.join("vault.json"), "[]").unwrap();
    std::fs::write(ssh.join("known_hosts.json"), r#"{"version":1,"entries":"nope"}"#).unwrap();
    let stores = stores_on(dir.path(), 7).await;
    assert!(stores.vault().await.lock().read_only());
    assert!(stores.known_hosts().await.lock().read_only());
    let host = Arc::new(FakeHost {
        state: Mutex::new(state()),
        changes: AtomicUsize::new(0),
        written: Mutex::new(Vec::new()),
        export_dir: dir.path().to_path_buf(),
        dialog_fails: AtomicBool::new(false),
        write_fails: AtomicBool::new(false),
        pick: Mutex::new(None),
    });
    let ipc = SshIpc::new(stores.clone(), host);
    let r = ipc.invoke("ssh:knownHosts:remove", &json!({ "id": "00000000-0000-4000-8000-000000000042" })).await;
    assert_eq!(r, Some(json!({ "ok": false })));
    assert_eq!(std::fs::read_to_string(ssh.join("vault.json")).unwrap(), "[]");
    assert_eq!(std::fs::read_to_string(ssh.join("known_hosts.json")).unwrap(), r#"{"version":1,"entries":"nope"}"#);
}

#[tokio::test(flavor = "multi_thread")]
async fn never_returns_a_secret_from_any_handler_but_the_explicit_reveal() {
    let f = setup().await;
    let key_file = f.dir.path().join("id_fixture");
    std::fs::write(&key_file, encrypted_pair()).unwrap();
    *f.host.pick.lock() = Some(key_file.to_string_lossy().into_owned());
    let draft = f.ready_draft(encrypted_pair()).await;
    let stored = f.ask("ssh:key:commitDraft", json!({ "draftId": draft, "label": "stored", "savePassphrase": true })).await;
    let stored_id = stored["key"]["id"].clone();
    f.ask("ssh:password:set", json!({ "hostId": HOST, "password": "ipc-host-password" })).await;
    f.host.state.lock()["sshIdentities"] = json!([{ "id": IDENTITY, "label": "me", "username": "me" }]);
    f.ask("ssh:identityPassword:set", json!({ "identityId": IDENTITY, "password": "ipc-identity-password" })).await;
    let ready = f.ready_draft(encrypted_pair()).await;
    let payload = |channel: &str| match channel {
        "ssh:key:generate" => json!({ "label": "gen", "type": "ed25519", "passphrase": PASSPHRASE, "savePassphrase": true }),
        "ssh:key:pickFile" | "ssh:passphrases:forget" => Value::Null,
        "ssh:key:draftFromFile" => json!({ "path": key_file }),
        "ssh:key:draftFromText" => json!({ "privateKey": encrypted_pair() }),
        "ssh:key:unlockDraft" => json!({ "draftId": ready, "passphrase": PASSPHRASE }),
        "ssh:key:commitDraft" => json!({ "draftId": ready, "label": "again", "savePassphrase": true }),
        "ssh:key:update" => json!({ "id": stored_id, "label": "renamed", "passphrase": { "save": PASSPHRASE } }),
        "ssh:key:remove" => json!({ "id": "00000000-0000-4000-8000-000000000077" }),
        "ssh:key:exportPrivate" | "ssh:key:revealPrivate" => json!({ "id": stored_id }),
        "ssh:key:replacePrivate" => {
            json!({ "id": stored_id, "privateKey": encrypted_pair(), "passphrase": PASSPHRASE, "savePassphrase": true })
        }
        "ssh:password:set" => json!({ "hostId": HOST, "password": "ipc-host-password" }),
        "ssh:password:clear" => json!({ "hostId": HOST }),
        "ssh:identityPassword:set" => json!({ "identityId": IDENTITY, "password": "ipc-identity-password" }),
        "ssh:identityPassword:clear" => json!({ "identityId": IDENTITY }),
        "ssh:knownHosts:remove" => json!({ "id": "00000000-0000-4000-8000-000000000078" }),
        other => panic!("no payload for {other}"),
    };
    for channel in KEY_CHANNELS {
        if channel == "ssh:key:revealPrivate" {
            continue;
        }
        let r = f.ask(channel, payload(channel)).await;
        assert_ne!(r, json!({ "ok": false, "error": "invalid" }), "{channel}");
        assert!(leaks(&r).is_empty(), "{channel}: {r}");
        assert!(!r.to_string().contains("PRIVATE KEY"), "{channel}");
    }
    let info = f.stores.vault().await.lock().info();
    assert!(leaks(&info).is_empty());
    assert_eq!(f.host.written.lock().len(), 1);
    assert!(f.ask("ssh:key:revealPrivate", payload("ssh:key:revealPrivate")).await.to_string().contains("PRIVATE KEY"));
}

#[tokio::test(flavor = "multi_thread")]
async fn reveals_the_stored_text_only_for_a_valid_id_and_never_decrypts_it() {
    let f = setup().await;
    let key = f.generate("gen").await;
    let r = f.ask("ssh:key:revealPrivate", json!({ "id": key["id"] })).await;
    let shown = r["privateKey"].as_str().unwrap();
    assert!(shown.contains("BEGIN OPENSSH PRIVATE KEY"));
    let id = key["id"].as_str().unwrap();
    assert_eq!(shown, f.stores.vault().await.lock().key_secret(id).unwrap().private_key.as_str());
    let not_found = json!({ "ok": false, "error": "notFound" });
    for bad in [json!({ "id": KEY_GONE }), json!({ "id": "not-a-uuid" }), json!({ "id": key["id"], "extra": true }), Value::Null]
    {
        assert_eq!(f.ask("ssh:key:revealPrivate", bad).await, not_found);
    }
    // A passphrase-protected key is shown as stored: the encrypted text, never decrypted with the saved passphrase.
    let draft = f.ready_draft(encrypted_pair()).await;
    let enc = f.ask("ssh:key:commitDraft", json!({ "draftId": draft, "label": "enc", "savePassphrase": true })).await;
    let shown = f.ask("ssh:key:revealPrivate", json!({ "id": enc["key"]["id"] })).await;
    assert_eq!(shown, json!({ "ok": true, "privateKey": encrypted_pair() }));
    assert!(!shown.to_string().contains(PASSPHRASE));

    // Another computer's vault (a key that does not decrypt): locked. A read-only vault still reveals.
    let foreign = SshIpc::new(stores_on(f.dir.path(), 9).await, f.host.clone());
    assert_eq!(
        foreign.invoke("ssh:key:revealPrivate", &json!({ "id": id })).await.unwrap(),
        json!({ "ok": false, "error": "locked" })
    );
    let mut raw: Value = serde_json::from_str(&std::fs::read_to_string(f.vault_file()).unwrap()).unwrap();
    raw["version"] = json!(99);
    std::fs::write(f.vault_file(), raw.to_string()).unwrap();
    let read_only = stores_on(f.dir.path(), 7).await;
    assert!(read_only.vault().await.lock().read_only());
    let ro = SshIpc::new(read_only, f.host.clone());
    assert_eq!(ro.invoke("ssh:key:revealPrivate", &json!({ "id": id })).await.unwrap()["ok"], true);
}

#[tokio::test(flavor = "multi_thread")]
async fn replaces_key_material_under_the_same_id_with_the_1_1_4_codes() {
    let f = setup().await;
    let key = f.generate("deploy").await;
    f.host.state.lock()["sshHosts"][0]["keyId"] = key["id"].clone();
    let before = f.reveal(&key["id"]).await;
    let replace = |text: &str| json!({ "id": key["id"], "privateKey": text, "savePassphrase": false });
    // The same key again: nothing to update on the servers.
    let same = f.ask("ssh:key:replacePrivate", replace(&before)).await;
    assert_eq!((same["ok"].as_bool(), same["publicKeyChanged"].as_bool()), (Some(true), Some(false)), "{same}");
    assert_eq!((&same["key"]["id"], &same["key"]["fingerprint"]), (&key["id"], &key["fingerprint"]));
    let next = generated(KeyType::Ecdsa, Some(256), "next@check", None);
    let r = f.ask("ssh:key:replacePrivate", replace(&next)).await;
    assert_eq!(r["publicKeyChanged"], true, "{r}");
    assert_eq!(
        (r["key"]["id"].clone(), r["key"]["label"].clone(), r["key"]["type"].clone(), r["key"]["bits"].clone()),
        (key["id"].clone(), json!("deploy"), json!("ecdsa-sha2-nistp256"), json!(256))
    );
    assert_eq!(
        (&r["key"]["comment"], &r["key"]["encrypted"], &r["key"]["createdAt"]),
        (&json!("next@check"), &json!(false), &key["createdAt"])
    );
    assert_ne!(r["key"]["fingerprint"], key["fingerprint"]);
    assert!(r["key"]["publicKey"].as_str().unwrap().ends_with(" next@check"));
    assert!(!r.to_string().contains("PRIVATE KEY"));
    assert_eq!(f.reveal(&key["id"]).await, next);
    assert_eq!(f.host.state.lock()["sshHosts"][0]["keyId"], key["id"]);
    assert_eq!(f.stores.vault().await.lock().keys().len(), 1);
    assert!(f.host.changes.load(Ordering::SeqCst) > 0);
    assert!(!std::fs::read_to_string(f.vault_file()).unwrap().contains("PRIVATE KEY"));

    // An encrypted replacement: only with the right passphrase; the passphrase is saved only when asked.
    let enc = |pp: Option<&str>, save: bool| {
        let mut v = json!({ "id": key["id"], "privateKey": encrypted_pair(), "savePassphrase": save });
        if let Some(pp) = pp {
            v["passphrase"] = json!(pp);
        }
        v
    };
    let fp = f.stores.vault().await.lock().key(key["id"].as_str().unwrap()).unwrap().meta.fingerprint;
    assert_eq!(f.ask("ssh:key:replacePrivate", enc(None, false)).await, json!({ "ok": false, "error": "needsPassphrase" }));
    assert_eq!(f.ask("ssh:key:replacePrivate", enc(Some("wrong"), true)).await, json!({ "ok": false, "error": "badPassphrase" }));
    let vault = f.stores.vault().await;
    let id = key["id"].as_str().unwrap();
    assert_eq!(vault.lock().key(id).unwrap().meta.fingerprint, fp);
    let r = f.ask("ssh:key:replacePrivate", enc(Some(PASSPHRASE), false)).await;
    assert_eq!((r["publicKeyChanged"].as_bool(), r["key"]["encrypted"].as_bool()), (Some(true), Some(true)), "{r}");
    assert_eq!(r["key"]["passphraseSaved"], false);
    assert!(leaks(&r).is_empty());
    assert!(vault.lock().key_secret(id).unwrap().passphrase.is_none());
    let r = f.ask("ssh:key:replacePrivate", enc(Some(PASSPHRASE), true)).await;
    assert_eq!((r["publicKeyChanged"].as_bool(), r["key"]["passphraseSaved"].as_bool()), (Some(false), Some(true)));
    assert_eq!(vault.lock().key_secret(id).unwrap().passphrase.as_deref().map(String::as_str), Some(PASSPHRASE));
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_bad_replacements_duplicates_and_read_only_vaults_and_drops_a_stale_certificate() {
    let f = setup().await;
    let key = f.generate("gen").await;
    let replace = |text: &str| json!({ "id": key["id"], "privateKey": text, "savePassphrase": false });
    let code = |c: &str| json!({ "ok": false, "error": c });
    let ppk3 = "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: x\nPublic-Lines: 1\nAAAA\nPrivate-Lines: 1\nAAAA\nPrivate-MAC: 00\n";
    assert_eq!(f.ask("ssh:key:replacePrivate", replace("hello")).await, code("notAKey"));
    assert_eq!(f.ask("ssh:key:replacePrivate", replace(ppk3)).await, code("ppkV3"));
    assert_eq!(f.ask("ssh:key:replacePrivate", replace(key["publicKey"].as_str().unwrap())).await, code("publicOnly"));
    let gone = json!({ "id": KEY_GONE, "privateKey": encrypted_pair(), "passphrase": PASSPHRASE, "savePassphrase": false });
    assert_eq!(f.ask("ssh:key:replacePrivate", gone).await, code("notFound"));
    assert_eq!(f.ask("ssh:key:replacePrivate", replace("")).await, code("invalid"));
    assert_eq!(f.ask("ssh:key:replacePrivate", replace(&"x".repeat(64 * 1024 + 1))).await, code("invalid"));
    let mut extra = replace(encrypted_pair());
    extra["label"] = json!("x");
    assert_eq!(f.ask("ssh:key:replacePrivate", extra).await, code("invalid"));
    assert_eq!(
        f.ask("ssh:key:replacePrivate", json!({ "id": key["id"], "privateKey": encrypted_pair() })).await,
        code("invalid")
    );
    assert_eq!(
        f.stores.vault().await.lock().key(key["id"].as_str().unwrap()).unwrap().meta.fingerprint,
        key["fingerprint"].as_str().unwrap()
    );
    // A PuTTY PPK v2 RSA key is accepted, like an import.
    let r = f.ask("ssh:key:replacePrivate", replace(&sp7_key("ppk2-rsa.ppk"))).await;
    assert_eq!((r["ok"].as_bool(), r["key"]["type"].as_str()), (Some(true), Some("ssh-rsa")), "{r}");

    // A key stored under another id is a duplicate.
    let (a, b) = (f.generate("a").await, f.generate("b").await);
    let b_text = f.reveal(&b["id"]).await;
    let dup = json!({ "id": a["id"], "privateKey": b_text, "savePassphrase": false });
    assert_eq!(f.ask("ssh:key:replacePrivate", dup).await, code("duplicate"));

    // A stored certificate stays for the same public key and goes with a new one; a failed write answers failed.
    let c = f.generate("cert").await;
    let cert = fake_certificate(c["publicKey"].as_str().unwrap());
    assert_eq!(f.ask("ssh:key:update", json!({ "id": c["id"], "certificate": cert })).await["ok"], true);
    let current = f.reveal(&c["id"]).await;
    let by = |text: &str| json!({ "id": c["id"], "privateKey": text, "savePassphrase": false });
    let same = f.ask("ssh:key:replacePrivate", by(&current)).await;
    assert_eq!(same["certificateRemoved"], false);
    assert!(same["key"]["certificate"].is_string(), "{same}");
    let next = generated(KeyType::Ed25519, None, "n", None);
    break_file(&f.vault_file());
    assert_eq!(f.ask("ssh:key:replacePrivate", by(&next)).await, code("failed"));
    fix_file(&f.vault_file());
    let r = f.ask("ssh:key:replacePrivate", by(&next)).await;
    assert_eq!((r["publicKeyChanged"].as_bool(), r["certificateRemoved"].as_bool()), (Some(true), Some(true)), "{r}");
    assert!(r["key"].get("certificate").is_none());
    let again = f.ask("ssh:key:replacePrivate", by(&generated(KeyType::Ed25519, None, "m", None))).await;
    assert_eq!((again["publicKeyChanged"].as_bool(), again["certificateRemoved"].as_bool()), (Some(true), Some(false)));

    // A read-only vault (a newer version) is never written.
    let mut raw: Value = serde_json::from_str(&std::fs::read_to_string(f.vault_file()).unwrap()).unwrap();
    raw["version"] = json!(99);
    std::fs::write(f.vault_file(), raw.to_string()).unwrap();
    let before = std::fs::read_to_string(f.vault_file()).unwrap();
    let ro = SshIpc::new(stores_on(f.dir.path(), 7).await, f.host.clone());
    let r = ro.invoke("ssh:key:replacePrivate", &json!({ "id": a["id"], "privateKey": next, "savePassphrase": false })).await;
    assert_eq!(r.unwrap(), code("readOnly"));
    assert_eq!(std::fs::read_to_string(f.vault_file()).unwrap(), before);
}
