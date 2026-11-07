//! The golden corpus of the account stores and identity helpers (scripts/goldens-accounts.mjs, written by 1.1.4's TS code):
//! every Rust answer, and every file the Rust stores write, must be byte-identical to the TS one.

use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value};
use unimux_accounts::codex::{
    CodexAccount, CodexAccountsFile, CodexIdentity, CodexLive, codex_activation_refusal, codex_identity_key,
    codex_stores_in_keyring, compare_codex_identity, decode_jwt_claims, live_record_of, normalize_codex_accounts, outside_switch,
    parse_codex_auth,
};
use unimux_accounts::codex_store::{CodexAccountsStore, CodexPatch, CodexStoreError};
use unimux_accounts::identity::{
    AccountIdentity, Custody, TokenFamily, compare_identity, fill_missing_identity, identity_fields_of,
    identity_from_oauth_account, identity_key,
};
use unimux_accounts::store::{AccountsStore, AppSwap, LiveIdentity, NewNotice, StoreError};
use unimux_core::js_json::{parse, replace_lone_surrogates, stringify};

fn rows(name: &str) -> Vec<Value> {
    let path = format!("{}/../../../test/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    // Read like JSON.parse (array-index keys first), as the TS side saw its inputs.
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| parse(l).unwrap()).collect()
}

/// The ids `randomUUID` gave the TS side (counted from 1 per row).
fn counter() -> Box<dyn Fn() -> String + Send + Sync> {
    let n = Arc::new(AtomicU64::new(0));
    Box::new(move || format!("00000000-0000-4000-8000-{:012}", n.fetch_add(1, Ordering::SeqCst) + 1))
}

fn write_input(root: &Path, file: &Value) {
    fs::create_dir_all(root).unwrap();
    match file {
        Value::Null => {}
        Value::String(text) => fs::write(root.join("accounts.json"), text).unwrap(),
        _ => fs::create_dir(root.join("accounts.json")).unwrap(),
    }
}

fn names(dir: &Path) -> Vec<String> {
    let mut out: Vec<String> = fs::read_dir(dir)
        .map(|d| d.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect())
        .unwrap_or_default();
    out.sort();
    out
}

/// `text`, `backups`, `dirs`, `temps` of the TS row.
fn files_of(root: &Path, out: &mut Map<String, Value>) {
    let text = fs::read(root.join("accounts.json")).ok().map(|b| Value::String(String::from_utf8_lossy(&b).into_owned()));
    out.insert("text".into(), text.unwrap_or(Value::Null));
    let all = names(root);
    let backups = all
        .iter()
        .filter(|n| n.starts_with("accounts.json.bak-"))
        .map(|n| Value::String(String::from_utf8_lossy(&fs::read(root.join(n)).unwrap()).into_owned()))
        .collect();
    out.insert("backups".into(), Value::Array(backups));
    let mut dirs = Map::new();
    for d in ["claude", "profiles"] {
        dirs.insert(d.into(), Value::Array(names(&root.join(d)).into_iter().map(Value::String).collect()));
    }
    out.insert("dirs".into(), Value::Object(dirs));
    out.insert("temps".into(), Value::from(all.iter().filter(|n| n.ends_with(".tmp")).count()));
}

/// The string fields of an object (the stores drop every other value of these fields on their own).
fn strings_only(v: &Value) -> Value {
    match v {
        Value::Object(m) => Value::Object(m.iter().filter(|(_, x)| x.is_string()).map(|(k, x)| (k.clone(), x.clone())).collect()),
        _ => Value::Object(Map::new()),
    }
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

fn result<E>(r: Result<Option<String>, E>, name: impl Fn(&E) -> String) -> Value {
    match r {
        Ok(None) => Value::Null,
        Ok(Some(id)) => serde_json::json!({ "ok": id }),
        Err(e) => serde_json::json!({ "error": name(&e) }),
    }
}

fn store_error(e: &StoreError) -> String {
    match e {
        StoreError::ReadOnly => "readOnly".into(),
        StoreError::InvalidAccount => "invalidAccount".into(),
        StoreError::InvalidId => "invalidId".into(),
        StoreError::Io(e) => format!("other: {e}"),
    }
}

fn run_store_op(store: &AccountsStore, op: &[Value]) -> Result<Option<String>, StoreError> {
    let a = &op[1..];
    let opt = |v: &Value| v.as_str().map(str::to_string);
    match s(&op[0]) {
        "markMigrated" => store.mark_migrated(),
        "setLive" => {
            let live: Option<LiveIdentity> = (!a[0].is_null()).then(|| serde_json::from_value(strings_only(&a[0])).unwrap());
            store.set_live(live.as_ref())
        }
        "addNotice" => store.add_notice(&serde_json::from_value::<NewNotice>(a[0].clone()).unwrap()),
        "dismissNotice" => store.dismiss_notice(s(&a[0])),
        "commit" => store.commit_value(&a[0]),
        "update" => {
            let field = |k: &str| a[1].get(k).map(|v| v.as_str());
            store.update(s(&a[0]), field("email"), field("org"))
        }
        "updateIdentity" => {
            let identity: AccountIdentity = serde_json::from_value(a[1].clone()).unwrap();
            store.update_identity(s(&a[0]), &identity, a[2] == Value::Bool(true))
        }
        "setCustody" => store.set_custody(s(&a[0]), Custody::parse(s(&a[1])).unwrap(), a[2].as_str()),
        "setFamily" => store.set_family(s(&a[0]), TokenFamily::parse(s(&a[1])).unwrap()),
        "setHeldTokens" => store.set_held_tokens(s(&a[0]), opt(&a[1]).as_deref()),
        "setDeadTokens" => store.set_dead_tokens(s(&a[0]), opt(&a[1]).as_deref()),
        "setAppSwap" => {
            let swap: Option<AppSwap> = (!a[1].is_null()).then(|| serde_json::from_value(a[1].clone()).unwrap());
            store.set_app_swap(s(&a[0]), swap.as_ref())
        }
        "remove" => store.remove(s(&a[0])),
        "prepare" => return store.prepare().map(|(id, _)| Some(id)),
        "noop" => store.set_live(store.live().as_ref()),
        other => panic!("unknown op {other}"),
    }
    .map(|()| None)
}

/// Compares each field of the TS output with ours; the first differing field of each row is reported.
fn compare(i: usize, row: &Value, ours: &Map<String, Value>, failures: &mut Vec<String>) {
    let want = row["out"].as_object().unwrap();
    for (key, w) in want {
        let o = ours.get(key).cloned().unwrap_or(Value::String("<missing>".into()));
        // The one accepted difference (as for state.json, F7): a Rust string cannot hold a lone UTF-16 surrogate, so one read
        // from the file becomes U+FFFD and is written as that character where 1.1.4 writes the `\udXXX` escape back.
        let w = match w.as_str().and_then(replace_lone_surrogates) {
            Some(text) if key == "text" => Value::String(text.replace("\\ufffd", "\u{fffd}")),
            _ => w.clone(),
        };
        let (a, b) = (stringify(&o), stringify(&w));
        if a != b {
            failures.push(format!(
                "row {i} field {key}:\n  file {}\n  ops  {}\n  rust {a}\n  ts   {b}",
                stringify(&row["file"]),
                stringify(&row["ops"])
            ));
            return;
        }
    }
}

fn report(name: &str, total: usize, failures: &[String]) {
    assert!(
        failures.is_empty(),
        "{name}: {} of {total} rows differ:\n{}",
        failures.len(),
        failures.iter().take(8).cloned().collect::<Vec<_>>().join("\n")
    );
}

#[test]
fn accounts_store_matches_1_1_4() {
    let rows = rows("accounts-store.jsonl");
    assert!(rows.len() >= 300, "{} rows", rows.len());
    let base = tempfile::tempdir().unwrap();
    let mut failures = Vec::new();
    let mut written = 0;
    for (i, row) in rows.iter().enumerate() {
        let root = base.path().join(i.to_string());
        write_input(&root, &row["file"]);
        let store = AccountsStore::with_ids(&root, counter());
        let results: Vec<Value> = row["ops"]
            .as_array()
            .unwrap()
            .iter()
            .map(|op| result(run_store_op(&store, op.as_array().unwrap()), store_error))
            .collect();
        let mut out = Map::new();
        out.insert("results".into(), Value::Array(results));
        out.insert("readOnly".into(), Value::Bool(store.read_only()));
        out.insert("version".into(), serde_json::json!(store.version()));
        out.insert("list".into(), Value::Array(store.list().iter().map(|a| a.to_value()).collect()));
        out.insert("live".into(), store.live().map_or(Value::Null, |l| l.to_value()));
        out.insert("notices".into(), Value::Array(store.notices().iter().map(|n| n.to_value()).collect()));
        files_of(&root, &mut out);
        if row["written114"] == Value::Bool(true) {
            written += 1;
            // A 1.1.4 accounts.json opened and rewritten by a no-op stays byte-identical.
            assert_eq!(out["text"], row["file"], "row {i}: a 1.1.4 file changed on a no-op rewrite");
        }
        compare(i, row, &out, &mut failures);
    }
    assert!(written >= 50, "{written} rows of 1.1.4-written files");
    report("accounts-store", rows.len(), &failures);
}

fn codex_error(e: &CodexStoreError) -> String {
    match e {
        CodexStoreError::ReadOnly => "readOnly".into(),
        CodexStoreError::InvalidId => "invalidId".into(),
        CodexStoreError::Io(e) => format!("other: {e}"),
    }
}

fn run_codex_op(store: &CodexAccountsStore, op: &[Value]) -> Result<Option<String>, CodexStoreError> {
    let a = &op[1..];
    match s(&op[0]) {
        "setLive" => {
            let live: Option<CodexLive> = (!a[0].is_null()).then(|| serde_json::from_value(a[0].clone()).unwrap());
            store.set_live(live.as_ref())
        }
        "commit" => store.commit(&serde_json::from_value::<CodexAccount>(a[0].clone()).unwrap()),
        "patch" => {
            let p = &a[1];
            let text = |k: &str| p.get(k).map(|v| v.as_str().map(str::to_string));
            // `undefined` (null here) removes a flag; JSON.stringify of the normalized file only ever keeps `true`.
            let flag = |k: &str| p.get(k).map(|v| v == &Value::Bool(true));
            let patch = CodexPatch {
                email: text("email"),
                user_id: text("userId"),
                account_id: text("accountId"),
                live_family: flag("liveFamily"),
                outdated: flag("outdated"),
            };
            store.patch(s(&a[0]), &patch)
        }
        "updateIdentity" => store.update_identity(s(&a[0]), &serde_json::from_value::<CodexIdentity>(a[1].clone()).unwrap()),
        "remove" => store.remove(s(&a[0])),
        "prepare" => return store.prepare().map(|(id, _)| Some(id)),
        "noop" => store.set_live(store.live().as_ref()),
        other => panic!("unknown op {other}"),
    }
    .map(|()| None)
}

#[test]
fn codex_store_matches_1_1_4() {
    let rows = rows("codex-accounts.jsonl");
    assert!(rows.len() >= 200, "{} rows", rows.len());
    let base = tempfile::tempdir().unwrap();
    let mut failures = Vec::new();
    let mut written = 0;
    for (i, row) in rows.iter().enumerate() {
        let root = base.path().join(i.to_string());
        write_input(&root, &row["file"]);
        let store = CodexAccountsStore::with_ids(&root, counter());
        let results: Vec<Value> = row["ops"]
            .as_array()
            .unwrap()
            .iter()
            .map(|op| result(run_codex_op(&store, op.as_array().unwrap()), codex_error))
            .collect();
        let mut out = Map::new();
        out.insert("results".into(), Value::Array(results));
        out.insert("readOnly".into(), Value::Bool(store.read_only()));
        out.insert("list".into(), Value::Array(store.list().iter().map(CodexAccount::to_value).collect()));
        out.insert("live".into(), store.live().map_or(Value::Null, |l| l.to_value()));
        files_of(&root, &mut out);
        if row["written114"] == Value::Bool(true) {
            written += 1;
            assert_eq!(out["text"], row["file"], "row {i}: a 1.1.4 file changed on a no-op rewrite");
        }
        compare(i, row, &out, &mut failures);
    }
    assert!(written >= 30, "{written} rows of 1.1.4-written files");
    report("codex-accounts", rows.len(), &failures);
}

fn identity(v: &Value) -> AccountIdentity {
    serde_json::from_value(v.clone()).unwrap()
}

fn codex_identity(v: &Value) -> Option<CodexIdentity> {
    (!v.is_null()).then(|| serde_json::from_value(v.clone()).unwrap())
}

fn json<T: serde::Serialize>(v: T) -> Value {
    serde_json::to_value(v).unwrap()
}

#[test]
fn identity_helpers_match_1_1_4() {
    let rows = rows("accounts-identity.jsonl");
    assert!(rows.len() >= 2000, "{} rows", rows.len());
    let mut failures = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    for (i, row) in rows.iter().enumerate() {
        let a = row["args"].as_array().unwrap();
        let name = s(&row["fn"]);
        seen.insert(name.to_string());
        let ours = match name {
            "identityFields" => json(identity_fields_of(a[0].as_object().unwrap())),
            "identityFromOauthAccount" => json(identity_from_oauth_account(Some(&a[0]))),
            "compareIdentity" => json(compare_identity(&identity(&a[0]), &identity(&a[1]))),
            "identityKey" => json(identity_key(&identity(&a[0]))),
            "fillMissingIdentity" => json(fill_missing_identity(&identity(&a[0]), &identity(&a[1]))),
            "compareCodexIdentity" => {
                json(compare_codex_identity(&codex_identity(&a[0]).unwrap(), &codex_identity(&a[1]).unwrap()))
            }
            "codexIdentityKey" => json(codex_identity_key(&codex_identity(&a[0]).unwrap())),
            "normalizeCodexAccounts" => normalize_codex_accounts(&a[0]).to_value(),
            "outsideSwitch" => {
                let file: CodexAccountsFile = normalize_codex_accounts(&a[0]);
                json(outside_switch(&file, codex_identity(&a[1]).as_ref()))
            }
            "liveRecordOf" => {
                let accounts: Vec<CodexAccount> = serde_json::from_value(a[0].clone()).unwrap();
                live_record_of(&accounts, codex_identity(&a[1]).as_ref()).map_or(Value::Null, CodexAccount::to_value)
            }
            "codexActivationRefusal" => {
                let record: Option<CodexAccount> = (!a[0].is_null()).then(|| serde_json::from_value(a[0].clone()).unwrap());
                json(codex_activation_refusal(record.as_ref(), codex_identity(&a[1]).as_ref()))
            }
            "codexStoresInKeyring" => json(codex_stores_in_keyring(a[0].as_str())),
            "decodeJwtClaims" => decode_jwt_claims(s(&a[0])).map_or(Value::Null, Value::Object),
            "parseCodexAuth" => json(parse_codex_auth(a[0].as_str())),
            other => panic!("unknown fn {other}"),
        };
        let want = &row["out"];
        // fillMissingIdentity builds its patch in another key order (accountUuid first); only the fields matter (it is a patch).
        let same = if name == "fillMissingIdentity" { &ours == want } else { stringify(&ours) == stringify(want) };
        if !same {
            failures.push(format!(
                "row {i} {name}({}):\n  rust {}\n  ts   {}",
                stringify(&row["args"]),
                stringify(&ours),
                stringify(want)
            ));
        }
    }
    assert_eq!(seen.len(), 14, "{seen:?}");
    report("accounts-identity", rows.len(), &failures);
}
