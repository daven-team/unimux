//! The golden corpus of "make main" and its recoveries (scripts/goldens-activate.mjs, written by 1.1.4's TS code on scratch
//! dirs): every answer, every flag and every file the Rust port leaves must be byte-identical to the TS run.

use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::time::Duration;

use serde_json::{Map, Value};
use unimux_accounts::activate::{ActivateDeps, activate_account, recover_interrupted_activation};
use unimux_accounts::cswap::CswapRoster;
use unimux_accounts::identity::identity_fields_of;
use unimux_accounts::legacy_swap::recover_interrupted_swap;
use unimux_accounts::locks::LockOptions;
use unimux_accounts::refresh::{ProfileLocks, RefreshOutcome};
use unimux_accounts::slot::SwapSlot;
use unimux_accounts::store::AccountsStore;
use unimux_accounts::swapfs::{FileStat, RealSwapFs, SwapFs};
use unimux_core::js_json::parse;

const NOW: f64 = 1_792_152_000_000.0; // 2026-10-16T12:00:00Z

fn rows() -> Vec<Value> {
    let path = format!("{}/../../../test/golden/accounts-activate.jsonl", env!("CARGO_MANIFEST_DIR"));
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| parse(l).unwrap()).collect()
}

fn counter() -> Box<dyn Fn() -> String + Send + Sync> {
    let n = Arc::new(AtomicU64::new(0));
    Box::new(move || format!("00000000-0000-4000-8000-{:012}", n.fetch_add(1, Ordering::SeqCst) + 1))
}

fn write_files(root: &Path, files: &Map<String, Value>) {
    for (rel, text) in files {
        let Value::String(text) = text else { continue };
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
}

/// `filesOf`: every file (relative, '/' separated) -> text; empty directories -> null; sorted by UTF-16 code units (the
/// names are ASCII here, so byte order is the same).
fn files_of(root: &Path) -> Value {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<String, Value>) {
        let mut names: Vec<String> =
            fs::read_dir(dir).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        if names.is_empty() && dir != root {
            out.insert(rel(root, dir), Value::Null);
        }
        for name in names {
            let path = dir.join(&name);
            if path.is_dir() {
                walk(root, &path, out);
            } else {
                out.insert(rel(root, &path), Value::String(String::from_utf8_lossy(&fs::read(&path).unwrap()).into_owned()));
            }
        }
    }
    fn rel(root: &Path, p: &Path) -> String {
        p.strip_prefix(root)
            .unwrap()
            .components()
            .map(|c| c.as_os_str().to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join("/")
    }
    let mut out = BTreeMap::new();
    walk(root, root, &mut out);
    Value::Object(out.into_iter().collect())
}

/// The failing rename of a row (`failingFs`).
struct Failing {
    targets: Vec<PathBuf>,
    left: AtomicUsize,
}

impl SwapFs for Failing {
    fn read_file(&self, p: &Path) -> io::Result<Option<String>> {
        RealSwapFs.read_file(p)
    }
    fn stat(&self, p: &Path) -> io::Result<Option<FileStat>> {
        RealSwapFs.stat(p)
    }
    fn write_file(&self, p: &Path, d: &str, m: u32) -> io::Result<()> {
        RealSwapFs.write_file(p, d, m)
    }
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        if self.targets.iter().any(|t| t == to) && self.left.load(Ordering::SeqCst) > 0 {
            self.left.fetch_sub(1, Ordering::SeqCst);
            return Err(io::Error::other("boom"));
        }
        RealSwapFs.rename(from, to)
    }
    fn rm(&self, p: &Path) -> io::Result<()> {
        RealSwapFs.rm(p)
    }
    fn mkdir(&self, p: &Path) -> io::Result<()> {
        RealSwapFs.mkdir(p)
    }
    fn readdir(&self, p: &Path) -> io::Result<Vec<String>> {
        RealSwapFs.readdir(p)
    }
    fn rmdir(&self, p: &Path) -> io::Result<()> {
        RealSwapFs.rmdir(p)
    }
}

fn roster_of(v: Option<&Value>) -> CswapRoster {
    match v {
        Some(r) if r["present"] == Value::Bool(true) => match r.get("accounts") {
            Some(Value::Array(a)) => {
                CswapRoster::Present(Some(a.iter().filter_map(Value::as_object).map(identity_fields_of).collect()))
            }
            _ => CswapRoster::UNREADABLE,
        },
        _ => CswapRoster::Absent,
    }
}

fn deps(root: &Path, input: &Value, slot: Arc<SwapSlot>) -> ActivateDeps {
    let env: BTreeMap<String, String> = input
        .get("env")
        .and_then(Value::as_object)
        .map(|m| m.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect())
        .unwrap_or_default();
    let refresh = input.get("refresh").and_then(Value::as_str).unwrap_or("ok").to_string();
    let renewed = input.get("renewed").and_then(Value::as_str).map(str::to_string);
    let roster = roster_of(input.get("roster"));
    let wrote = input.get("wroteSince").and_then(Value::as_bool);
    let ids: Vec<String> = input
        .get("files")
        .and_then(Value::as_object)
        .map(|m| {
            m.keys()
                .filter_map(|k| k.strip_prefix("accounts/claude/").and_then(|r| r.split('/').next()).map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    let fs: Arc<dyn SwapFs> = match input.get("fail").filter(|f| !f.is_null()) {
        None => Arc::new(RealSwapFs),
        Some(fail) => {
            let profile =
                |name: &str| ids.iter().map(|id| root.join("accounts").join("claude").join(id).join(name)).collect::<Vec<_>>();
            let targets = match fail["to"].as_str().unwrap() {
                "liveCreds" => vec![root.join("home").join(".claude").join(".credentials.json")],
                "liveJson" => vec![root.join("home").join(".claude.json")],
                "journal" => vec![root.join("accounts").join("swap-backup").join("swap-journal.json")],
                "liveBackup" => vec![root.join("accounts").join("swap-backup").join("live-credentials.json")],
                "outCreds" => profile(".credentials.json"),
                "outJson" => profile(".claude.json"),
                other => panic!("{other}"),
            };
            Arc::new(Failing { targets, left: AtomicUsize::new(fail["times"].as_u64().unwrap() as usize) })
        }
    };
    ActivateDeps {
        home: root.join("home"),
        env: Arc::new(env),
        darwin: input.get("darwin") == Some(&Value::Bool(true)),
        store: Arc::new(AccountsStore::with_ids(root.join("accounts"), counter())),
        backup_dir: root.join("accounts").join("swap-backup"),
        now: Arc::new(|| NOW),
        refresh: Arc::new(move |dir: &Path| match refresh.as_str() {
            "renew" => {
                if let Some(text) = &renewed {
                    fs::write(dir.join(".credentials.json"), text).unwrap();
                }
                RefreshOutcome::Ok
            }
            "throw" => panic!("network"),
            "dead" => RefreshOutcome::Dead,
            "transient" => RefreshOutcome::Transient(None),
            "unusable" => RefreshOutcome::Unusable,
            _ => RefreshOutcome::Ok,
        }),
        delay: Arc::new(|_| {}),
        cswap: Arc::new(move || Ok(roster.clone())),
        cswap_wrote_since: wrote.map(|w| {
            let f: unimux_accounts::activate::WroteSince = Arc::new(move |_, _, _| Ok(w));
            f
        }),
        fs,
        locks: LockOptions { timeout: Duration::from_millis(50), ..LockOptions::default() },
        slot,
        profiles: Arc::new(ProfileLocks::new()),
    }
}

#[test]
fn make_main_and_its_recoveries_match_1_1_4() {
    // The panics of the "throw" renewal rows are expected; keep them out of the output.
    let hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if info.payload().downcast_ref::<&str>() != Some(&"network") {
            hook(info);
        }
    }));
    let base = tempfile::tempdir().unwrap();
    let mut failures = Vec::new();
    let rows = rows();
    assert!(rows.len() >= 400, "{} rows", rows.len());
    for (n, row) in rows.iter().enumerate() {
        let root = base.path().join(n.to_string());
        fs::create_dir_all(&root).unwrap();
        let input = &row["input"];
        write_files(&root, input["files"].as_object().unwrap());
        let slot = Arc::new(SwapSlot::new());
        let d = deps(&root, input, slot.clone());
        let kind = row["kind"].as_str().unwrap();
        let (result, flags) = match kind {
            "activate" => {
                let r = activate_account(&d, input["target"].as_str().unwrap_or("not a string"));
                (r.to_value(), serde_json::json!({ "unresolved": slot.is_unresolved() }))
            }
            "recover" => {
                let lock = root.join("home").join(".claude.lock");
                if input["locked"] == Value::Bool(true) {
                    fs::create_dir_all(&lock).unwrap();
                }
                let r = recover_interrupted_activation(&d);
                let _ = fs::remove_dir(&lock);
                (
                    Value::String(r.as_str().into()),
                    serde_json::json!({ "unresolved": slot.is_unresolved(), "recoveryPending": slot.is_recovery_pending() }),
                )
            }
            "legacy" => {
                let r = recover_interrupted_swap(&d);
                (Value::String(r.as_str().into()), serde_json::json!({ "unresolved": slot.is_unresolved() }))
            }
            other => panic!("{other}"),
        };
        let got = serde_json::json!({ "result": result, "flags": flags, "files": files_of(&root) });
        if got != row["out"] {
            failures.push(format!("row {n} ({kind}):\n  input {}\n  want {}\n  got  {}", input, row["out"], got));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} rows differ:\n{}",
        failures.len(),
        rows.len(),
        failures.iter().take(4).cloned().collect::<Vec<_>>().join("\n")
    );
}
