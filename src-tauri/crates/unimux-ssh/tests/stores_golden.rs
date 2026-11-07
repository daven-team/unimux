//! The golden corpus of the SSH stores (scripts/goldens-ssh.mjs, written by 1.1.4's TS code on scratch dirs): every answer
//! of the Rust vault, known hosts and command history, and every file they write, must be byte-identical to the TS one.
//! Rows marked `written114` start from a file 1.1.4 wrote itself and run a no-op rewrite on it.

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::Duration;

use serde_json::{Map, Value, json};
use unimux_core::js_json::{parse, stringify};
use unimux_oscrypt::{Cipher, SafeCipher, Storage};
use unimux_ssh::command_history::{CommandHistoryOptions, CommandHistoryStore};
use unimux_ssh::history_rules::{self, HistoryEntry, frecency, history_command, normalize_command_history, record_command};
use unimux_ssh::js_value::JsNum;
use unimux_ssh::keys::js::node_base64;
use unimux_ssh::known_hosts::{KnownHostsStore, TrustMode};
use unimux_ssh::vault::{
    Clock, Ids, KeyPatch, KeySource, NewKey, PassphrasePatch, ReplacementKey, SetPassword, SshVault, UpdateKeyError,
};
use zeroize::Zeroizing;

fn rows(name: &str) -> Vec<Value> {
    let path = format!("{}/../../../test/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| parse(l).unwrap()).collect()
}

/// The ids `randomUUID` gave the TS side (counted from 1 per row).
fn ids() -> Ids {
    let n = Arc::new(AtomicU64::new(0));
    Arc::new(move || format!("00000000-0000-4000-8000-{:012}", n.fetch_add(1, Ordering::SeqCst) + 1))
}

/// 1762430400000 + 1000 * n, n counted from 1 per store.
fn clock() -> Clock {
    let n = Arc::new(AtomicI64::new(0));
    Arc::new(move || 1_762_430_400_000 + 1000 * (n.fetch_add(1, Ordering::SeqCst) + 1))
}

/// test/helpers/sshKeys.ts fakeCipher: `enc:<hex of the UTF-8 text>`, decrypting only that (never when broken).
struct FakeCipher {
    storage: Storage,
    broken: bool,
}

/// `Buffer.from(hex, 'hex')`: pairs until the first one that is not hex.
fn node_hex(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i + 1 < b.len() {
        let (Some(h), Some(l)) = ((b[i] as char).to_digit(16), (b[i + 1] as char).to_digit(16)) else { break };
        out.push((h * 16 + l) as u8);
        i += 2;
    }
    out
}

impl SafeCipher for FakeCipher {
    fn storage(&self) -> Storage {
        self.storage
    }
    fn encrypt(&self, text: &str) -> Result<Vec<u8>, unimux_oscrypt::Error> {
        let hex: String = text.as_bytes().iter().map(|b| format!("{b:02x}")).collect();
        Ok(format!("enc:{hex}").into_bytes())
    }
    fn decrypt(&self, blob: &[u8]) -> Result<Zeroizing<String>, unimux_oscrypt::Error> {
        let s = String::from_utf8_lossy(blob);
        if self.broken || !s.starts_with("enc:") {
            return Err(unimux_oscrypt::Error::Unavailable);
        }
        Ok(Zeroizing::new(String::from_utf8_lossy(&node_hex(&s[4..])).into_owned()))
    }
}

fn cipher(name: &str) -> Arc<dyn SafeCipher> {
    match name {
        "fake" => Arc::new(FakeCipher { storage: Storage::Dpapi, broken: false }),
        "broken" => Arc::new(FakeCipher { storage: Storage::Dpapi, broken: true }),
        "off" => Arc::new(FakeCipher { storage: Storage::Unavailable, broken: false }),
        "keychain" => Arc::new(FakeCipher { storage: Storage::Keychain, broken: false }),
        // The real Chromium v10 format with the corpus key (unimux-oscrypt's cipher, as the app uses it).
        "v10" => Arc::new(Cipher::with_gcm_key([7u8; 32])),
        other => panic!("cipher {other}"),
    }
}

fn write_input(dir: &Path, name: &str, file: &Value) {
    fs::create_dir_all(dir).unwrap();
    match file {
        Value::Null => {}
        Value::String(text) => fs::write(dir.join(name), text).unwrap(),
        _ => fs::create_dir_all(dir.join(name).join("child")).unwrap(),
    }
}

fn files_of(dir: &Path, name: &str, out: &mut Map<String, Value>) {
    let path = dir.join(name);
    let text =
        if path.is_file() { Value::String(String::from_utf8_lossy(&fs::read(&path).unwrap()).into_owned()) } else { Value::Null };
    out.insert("text".into(), text);
    let names: Vec<String> = fs::read_dir(dir)
        .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    let mut backups: Vec<String> = names
        .iter()
        .filter(|n| n.starts_with(&format!("{name}.bak-")))
        .map(|n| String::from_utf8_lossy(&fs::read(dir.join(n)).unwrap()).into_owned())
        .collect();
    backups.sort();
    out.insert("backups".into(), json!(backups));
    out.insert("temps".into(), json!(names.iter().filter(|n| n.ends_with(".tmp")).count()));
}

/// breakFile / fixFile of the corpus: a non-empty directory where the file belongs makes every write fail.
fn file_op(name: &str, file: &Path) -> bool {
    match name {
        "breakFile" => {
            if file.is_file() {
                fs::remove_file(file).unwrap();
            }
            fs::create_dir_all(file.join("child")).unwrap();
            true
        }
        "fixFile" => {
            if file.is_dir() {
                fs::remove_dir_all(file).unwrap();
            }
            true
        }
        _ => false,
    }
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or_else(|| panic!("string expected: {v}"))
}

fn opt_secret(v: &Value) -> Option<Zeroizing<String>> {
    v.as_str().map(|p| Zeroizing::new(p.to_string()))
}

fn new_key(k: &Value) -> NewKey {
    NewKey {
        label: s(&k["label"]).into(),
        key_type: s(&k["type"]).into(),
        bits: JsNum::of(&k["bits"]).unwrap(),
        fingerprint: s(&k["fingerprint"]).into(),
        public_key: s(&k["publicKey"]).into(),
        comment: s(&k["comment"]).into(),
        encrypted: k["encrypted"] == true,
        private_key: Zeroizing::new(s(&k["privateKey"]).into()),
        passphrase: opt_secret(&k["passphrase"]),
        save_passphrase: k["savePassphrase"] == true,
        certificate: k["certificate"].as_str().map(str::to_string),
        source: if k["source"] == "generated" { KeySource::Generated } else { KeySource::Imported },
    }
}

fn ok(v: Value) -> Value {
    json!({ "ok": v })
}

const THROW: fn() -> Value = || json!({ "throw": true });

fn update_result(r: Result<Result<unimux_ssh::vault::KeyInfo, UpdateKeyError>, unimux_ssh::vault::VaultError>) -> Value {
    match r {
        Ok(Ok(key)) => ok(json!({ "ok": true, "key": key.to_json() })),
        Ok(Err(e)) => ok(json!({ "ok": false, "error": e.as_str() })),
        Err(_) => THROW(),
    }
}

fn run_vault_op(vault: &mut SshVault, op: &[Value], file: &Path) -> Value {
    let name = s(&op[0]);
    let a = &op[1..];
    if file_op(name, file) {
        return ok(Value::Null);
    }
    let bool_or_throw = |r: Result<bool, _>| r.map_or_else(|_: unimux_ssh::vault::VaultError| THROW(), |b| ok(json!(b)));
    let set_result = |r: Result<SetPassword, unimux_ssh::vault::VaultError>| r.map_or_else(|_| THROW(), |x| ok(x.to_json()));
    let password_result = |r: Result<Zeroizing<String>, unimux_ssh::vault::PasswordError>| match r {
        Ok(p) => ok(json!({ "ok": true, "password": p.as_str() })),
        Err(e) => ok(json!({ "ok": false, "error": e.as_str() })),
    };
    let id_set = |v: &Value| -> Vec<String> { v.as_array().unwrap().iter().map(|x| s(x).to_string()).collect() };
    match name {
        "addKey" => vault.add_key(new_key(&a[0])).map_or_else(|_| THROW(), |r| ok(r.to_json())),
        "keySecret" => match vault.key_secret(s(&a[0])) {
            Ok(m) => {
                let mut o = Map::new();
                o.insert("ok".into(), json!(true));
                o.insert("privateKey".into(), json!(m.private_key.as_str()));
                if let Some(p) = &m.passphrase {
                    o.insert("passphrase".into(), json!(p.as_str()));
                }
                ok(Value::Object(o))
            }
            Err(e) => ok(json!({ "ok": false, "error": e.as_str() })),
        },
        "updateKey" | "noop" => {
            let mut patch = KeyPatch::default();
            if name == "updateKey" {
                let p = &a[1];
                patch.label = p.get("label").map(|l| s(l).to_string());
                patch.certificate = p.get("certificate").map(|c| c.as_str().map(str::to_string));
                patch.passphrase = p.get("passphrase").map(|pp| match pp.get("save") {
                    Some(save) => PassphrasePatch::Save(Zeroizing::new(s(save).into())),
                    None => PassphrasePatch::Forget,
                });
            }
            update_result(vault.update_key(s(&a[0]), patch))
        }
        "replaceKey" => {
            let k = &a[1];
            let replacement = ReplacementKey {
                key_type: s(&k["type"]).into(),
                bits: JsNum::of(&k["bits"]).unwrap(),
                fingerprint: s(&k["fingerprint"]).into(),
                public_key: s(&k["publicKey"]).into(),
                comment: s(&k["comment"]).into(),
                encrypted: k["encrypted"] == true,
                private_key: Zeroizing::new(s(&k["privateKey"]).into()),
                passphrase: opt_secret(&k["passphrase"]),
                save_passphrase: k["savePassphrase"] == true,
            };
            match vault.replace_key(s(&a[0]), replacement) {
                Ok(Ok(r)) => ok(json!({
                    "ok": true, "key": r.key.to_json(), "publicKeyChanged": r.public_key_changed, "certificateRemoved": r.certificate_removed,
                })),
                Ok(Err(e)) => ok(json!({ "ok": false, "error": e.as_str() })),
                Err(_) => THROW(),
            }
        }
        "removeKey" => bool_or_throw(vault.remove_key(s(&a[0]))),
        "setPassword" => set_result(vault.set_password(s(&a[0]), s(&a[1]))),
        "clearPassword" => bool_or_throw(vault.clear_password(s(&a[0]))),
        "password" => password_result(vault.password(s(&a[0]))),
        "prunePasswords" => {
            let keep = id_set(&a[0]);
            bool_or_throw(vault.prune_passwords(&|id| keep.iter().any(|k| k == id)))
        }
        "setIdentityPassword" => set_result(vault.set_identity_password(s(&a[0]), s(&a[1]))),
        "clearIdentityPassword" => bool_or_throw(vault.clear_identity_password(s(&a[0]))),
        "identityPassword" => password_result(vault.identity_password(s(&a[0]))),
        "pruneIdentityPasswords" => {
            let keep = id_set(&a[0]);
            bool_or_throw(vault.prune_identity_passwords(&|id| keep.iter().any(|k| k == id)))
        }
        "remember" => ok(json!(vault.remember(s(&a[0]), s(&a[1]), a[2].as_u64()))),
        "remembered" => ok(vault.remembered(s(&a[0])).map_or(Value::Null, |p| json!(p.as_str()))),
        "forgetRemembered" => {
            vault.forget_remembered();
            Value::Null
        }
        "markVerified" => {
            vault.mark_verified(s(&a[0]), s(&a[1]));
            Value::Null
        }
        "isVerified" => ok(json!(vault.is_verified(s(&a[0]), s(&a[1])))),
        "generation" => ok(json!(vault.generation(s(&a[0])))),
        "info" => ok(vault.info()),
        "readOnly" => ok(json!(vault.read_only())),
        other => panic!("vault op {other}"),
    }
}

/// A JSON text with every `\udXXX` escape that is not half of a pair replaced by U+FFFD: JSON.stringify writes an unpaired
/// surrogate (a label cut by `.slice(0, 80)` inside an emoji) as an escape; a Rust string cannot hold one, so the Rust
/// store holds and writes U+FFFD there (the only difference, and only reachable outside the IPC length limits).
fn lone_surrogates_as_fffd(text: &str) -> String {
    let b = text.as_bytes();
    let unit = |i: usize| -> Option<u16> {
        if b.get(i) == Some(&b'\\') && b.get(i + 1) == Some(&b'u') && i + 6 <= b.len() {
            u16::from_str_radix(&text[i + 2..i + 6], 16).ok()
        } else {
            None
        }
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && b.get(i + 1) == Some(&b'\\') {
            out.push_str("\\\\");
            i += 2;
            continue;
        }
        match unit(i) {
            Some(hi @ 0xd800..=0xdbff) if unit(i + 6).is_some_and(|lo| (0xdc00..=0xdfff).contains(&lo)) => {
                let _ = hi;
                out.push_str(&text[i..i + 12]);
                i += 12;
            }
            Some(0xd800..=0xdfff) => {
                out.push('\u{fffd}');
                i += 6;
            }
            _ => {
                let c = text[i..].chars().next().unwrap();
                out.push(c);
                i += c.len_utf8();
            }
        }
    }
    out
}

fn check(kind: &str, i: usize, row: &Value, ours: &Value) {
    let normalized = |v: &Value| {
        let mut v = v.clone();
        if let Some(text) = v["text"].as_str() {
            v["text"] = json!(lone_surrogates_as_fffd(text));
        }
        stringify(&v)
    };
    let want = normalized(&row["out"]);
    let got = normalized(ours);
    if want != got {
        let first = want.chars().zip(got.chars()).position(|(a, b)| a != b).unwrap_or(want.len().min(got.len()));
        let from = first.saturating_sub(200);
        panic!(
            "{kind} row {i} differs at char {first}\nrow input: {}\n want: ...{}\n got:  ...{}",
            stringify(&json!({ "file": row["file"], "cipher": row["cipher"], "ops": row["ops"] })),
            want.chars().skip(from).take(500).collect::<String>(),
            got.chars().skip(from).take(500).collect::<String>()
        );
    }
}

#[test]
fn vault_rows_match_1_1_4() {
    let all = rows("ssh-vault.jsonl");
    assert!(all.len() > 400, "{}", all.len());
    let mut rewrites = 0;
    for (i, row) in all.iter().enumerate() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("ssh");
        let file = dir.join("vault.json");
        write_input(&dir, "vault.json", &row["file"]);
        let ids = ids();
        let name = s(&row["cipher"]);
        let mut vault = SshVault::open_with(&file, cipher(name), clock(), ids.clone());
        let results: Vec<Value> =
            row["ops"].as_array().unwrap().iter().map(|op| run_vault_op(&mut vault, op.as_array().unwrap(), &file)).collect();
        let mut out = Map::new();
        out.insert("results".into(), Value::Array(results));
        out.insert("info".into(), vault.info());
        out.insert("readOnly".into(), json!(vault.read_only()));
        files_of(&dir, "vault.json", &mut out);
        file_op("fixFile", &file);
        out.insert("reopened".into(), SshVault::open_with(&file, cipher(name), clock(), ids).info());
        let out = Value::Object(out);
        check("vault", i, row, &out);
        // The Rust text equals 1.1.4's (checked above). 1.1.4 itself keeps the bytes unless the file had a certificate
        // added after the key was created: a reload puts `certificate` back after `passphraseSaved`, so that rewrite
        // moves it (in both apps alike).
        if row["written114"] == true && row["out"]["results"][0]["ok"]["ok"] == true && row["out"]["text"] == row["file"] {
            rewrites += 1;
        }
    }
    assert!(rewrites > 50, "1.1.4 vaults rewritten byte-identically: {rewrites}");
}

fn run_kh_op(store: &mut KnownHostsStore, op: &[Value], file: &Path) -> Value {
    let name = s(&op[0]);
    let a = &op[1..];
    if file_op(name, file) {
        return ok(Value::Null);
    }
    let port = |v: &Value| v.as_u64().unwrap() as u16;
    match name {
        "trust" => {
            let mode = if a[3] == "replace" { TrustMode::Replace } else { TrustMode::Save };
            store.trust(s(&a[0]), port(&a[1]), &node_base64(s(&a[2])), mode).map_or_else(|_| THROW(), |b| ok(json!(b)))
        }
        "judge" => {
            let j = store.judge(s(&a[0]), port(&a[1]), &node_base64(s(&a[2])));
            ok(json!({ "judgement": j.judgement.to_json(), "keyType": j.key_type, "fingerprint": j.fingerprint }))
        }
        "remove" => store.remove(s(&a[0])).map_or_else(|_| THROW(), |b| ok(json!(b))),
        "info" => ok(store.info()),
        "readOnly" => ok(json!(store.read_only())),
        "noop" => match store.list().first().cloned() {
            Some(e) => {
                store.trust(&e.host, e.port, &node_base64(&e.key), TrustMode::Save).map_or_else(|_| THROW(), |b| ok(json!(b)))
            }
            None => ok(Value::Null),
        },
        other => panic!("known hosts op {other}"),
    }
}

#[test]
fn known_hosts_rows_match_1_1_4() {
    let all = rows("ssh-known-hosts.jsonl");
    assert!(all.len() > 200, "{}", all.len());
    let mut rewrites = 0;
    for (i, row) in all.iter().enumerate() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("ssh");
        let file = dir.join("known_hosts.json");
        write_input(&dir, "known_hosts.json", &row["file"]);
        let mut store = KnownHostsStore::open_with(&file, clock(), ids());
        let results: Vec<Value> =
            row["ops"].as_array().unwrap().iter().map(|op| run_kh_op(&mut store, op.as_array().unwrap(), &file)).collect();
        let mut out = Map::new();
        out.insert("results".into(), Value::Array(results));
        out.insert("list".into(), Value::Array(store.list().iter().map(|e| e.to_json()).collect()));
        out.insert("info".into(), store.info());
        out.insert("readOnly".into(), json!(store.read_only()));
        files_of(&dir, "known_hosts.json", &mut out);
        check("known hosts", i, row, &Value::Object(out));
        if row["written114"] == true && row["out"]["results"][0]["ok"] == true {
            assert_eq!(row["out"]["text"], row["file"], "row {i}");
            rewrites += 1;
        }
    }
    assert!(rewrites > 50, "1.1.4 known_hosts files rewritten byte-identically: {rewrites}");
}

fn run_history_op(store: &CommandHistoryStore, op: &[Value], file: &Path) -> Value {
    let name = s(&op[0]);
    let a = &op[1..];
    if file_op(name, file) {
        return ok(Value::Null);
    }
    match name {
        "record" => ok(json!(store.record(&a[0], &a[1]))),
        "list" => ok(store.list_json(&a[0])),
        "clear" => ok(json!(store.clear(&a[0]))),
        "flush" => {
            store.flush();
            Value::Null
        }
        "status" => {
            let mut status = store.status();
            status["file"] = json!("<file>");
            ok(status)
        }
        "counts" => ok(Value::Object(store.counts())),
        "readOnly" => ok(json!(store.read_only())),
        other => panic!("history op {other}"),
    }
}

#[test]
fn command_history_rows_match_1_1_4() {
    let all = rows("ssh-command-history.jsonl");
    assert!(all.len() > 300, "{}", all.len());
    let mut rewrites = 0;
    for (i, row) in all.iter().enumerate() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("ssh");
        let file = dir.join("command_history.json");
        write_input(&dir, "command_history.json", &row["file"]);
        let saved: Vec<String> = row["hosts"].as_array().unwrap().iter().map(|h| s(h).to_string()).collect();
        let opts = CommandHistoryOptions {
            host_exists: Arc::new(move |id: &str| saved.iter().any(|h| h == id)),
            now: clock(),
            write_delay: Duration::from_secs(3600),
        };
        let store = CommandHistoryStore::new(&file, opts);
        let results: Vec<Value> =
            row["ops"].as_array().unwrap().iter().map(|op| run_history_op(&store, op.as_array().unwrap(), &file)).collect();
        file_op("fixFile", &file);
        store.flush();
        let mut status = store.status();
        status["file"] = json!("<file>");
        let mut out = Map::new();
        out.insert("results".into(), Value::Array(results));
        out.insert("status".into(), status);
        files_of(&dir, "command_history.json", &mut out);
        check("command history", i, row, &Value::Object(out));
        if row["written114"] == true && row["out"]["results"][0]["ok"] == true {
            assert_eq!(row["out"]["text"], row["file"], "row {i}");
            rewrites += 1;
        }
    }
    assert!(rewrites > 50, "1.1.4 history files rewritten byte-identically: {rewrites}");
}

fn entry(v: &Value) -> HistoryEntry {
    HistoryEntry {
        command: s(&v["command"]).into(),
        count: v["count"].as_f64().unwrap(),
        last_used: v["lastUsed"].as_f64().unwrap(),
    }
}

#[test]
fn history_rules_match_1_1_4() {
    let all = rows("ssh-history-rules.jsonl");
    assert!(all.len() > 500, "{}", all.len());
    for (i, row) in all.iter().enumerate() {
        let args = row["args"].as_array().unwrap();
        let got = match s(&row["fn"]) {
            "historyCommand" => history_command(s(&args[0])).map_or(Value::Null, |c| json!(c)),
            "recordCommand" => {
                let entries: Vec<HistoryEntry> = args[0].as_array().unwrap().iter().map(entry).collect();
                let limit = args[3].as_u64().unwrap() as usize;
                let next = record_command(&entries, s(&args[1]), args[2].as_f64().unwrap(), limit).unwrap_or(entries);
                Value::Array(next.iter().map(HistoryEntry::to_json).collect())
            }
            "frecency" => history_rules::js_number(frecency(&entry(&args[0]), args[1].as_f64().unwrap())),
            "normalizeCommandHistory" => {
                let n = normalize_command_history(&unimux_core::js_json::parse_keeping_infinity(s(&args[0])).unwrap());
                let hosts: Vec<Value> =
                    n.hosts.iter().map(|(id, e)| json!([id, e.iter().map(HistoryEntry::to_json).collect::<Vec<_>>()])).collect();
                json!({ "hosts": hosts, "newer": n.newer, "invalid": n.invalid })
            }
            other => panic!("{other}"),
        };
        assert_eq!(stringify(&got), stringify(&row["out"]), "row {i}: {}", stringify(row));
    }
}
