//! test/golden/files-ops.jsonl (scripts/goldens-fileops.mjs): the answers of 1.1.4's file operations, the local pane and
//! their pure helpers, replayed against the Rust port. Operation rows run on a fresh copy of the same fixture and compare
//! the answer, the project tree afterwards and what went to the trash.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use unimux_files::fileops::{
    OpOptions, copy_name, create_project_entry, delete_project_entries, rename_project_entry, to_posix, top_level_paths,
    transfer_project_entries, valid_path_list, validate_entry_name,
};
use unimux_files::fserr::FsError;
use unimux_files::jspath::{self, Flavor};
use unimux_files::local::LocalPlatform;
use unimux_files::pane::{LocalPane, PaneDeps, is_bundle_name, permission_string, safe_entry_name};

fn rows() -> Vec<Value> {
    let path = format!("{}/../../../test/golden/files-ops.jsonl", env!("CARGO_MANIFEST_DIR"));
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn platform(name: &str) -> LocalPlatform {
    match name {
        "win32" => LocalPlatform::Windows,
        "darwin" => LocalPlatform::Mac,
        _ => LocalPlatform::Linux,
    }
}

fn str_list(v: &Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_string()).collect()
}

/// A case-folding row needs a case-insensitive disk (NTFS / APFS default).
fn skip(row: &Value) -> bool {
    row["caseFold"] == true && !cfg!(any(windows, target_os = "macos"))
}

#[test]
fn helpers_match_the_ts_reference() {
    let mut count = 0;
    for (i, row) in rows().iter().enumerate() {
        let Some(name) = row["fn"].as_str() else { continue };
        count += 1;
        let a = &row["args"];
        let out: Value = match name {
            "toPosix" => json!(to_posix(a[0].as_str().unwrap())),
            "topLevelPaths" => json!(top_level_paths(&str_list(&a[0]))),
            "validPathList" => {
                let list = match a[0].get("repeat") {
                    Some(item) => Value::Array(vec![item.clone(); a[0]["count"].as_u64().unwrap() as usize]),
                    None => a[0].clone(),
                };
                json!(valid_path_list(&list).is_some())
            }
            "validateEntryName" => json!(validate_entry_name(a[0].as_str().unwrap(), platform(a[1].as_str().unwrap()))),
            "safeEntryName" => json!(safe_entry_name(a[0].as_str().unwrap(), a[1]["windows"] == true)),
            "copyName" => json!(copy_name(a[0].as_str().unwrap(), a[1].as_u64().unwrap() as u32, a[2] == true)),
            "permissionString" => json!(permission_string(a[0].as_u64().unwrap() as u32)),
            "isBundleName" => json!(is_bundle_name(a[0].as_str().unwrap())),
            "win32.dirname" => json!(jspath::dirname(Flavor::Win32, a[0].as_str().unwrap())),
            "win32.basename" => json!(jspath::basename(Flavor::Win32, a[0].as_str().unwrap())),
            "posix.dirname" => json!(jspath::dirname(Flavor::Posix, a[0].as_str().unwrap())),
            "posix.basename" => json!(jspath::basename(Flavor::Posix, a[0].as_str().unwrap())),
            other => panic!("row {i}: unknown fn {other}"),
        };
        assert_eq!(out, row["out"], "row {i} {name} {a}");
    }
    assert!(count > 350, "{count} helper rows");
}

fn build(root: &Path, files: &[(&str, &str)]) {
    fs::create_dir_all(root).unwrap();
    for (rel, text) in files {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }
}

/// The folder as `{rel: text | null}` (names in code-unit order, like the generator's sort).
fn tree(root: &Path) -> Value {
    fn walk(root: &Path, prefix: &str, out: &mut BTreeMap<Vec<u16>, (String, Value)>) {
        let dir = if prefix.is_empty() { root.to_path_buf() } else { root.join(prefix) };
        for entry in fs::read_dir(dir).unwrap() {
            let name = entry.unwrap().file_name().to_string_lossy().into_owned();
            let rel = if prefix.is_empty() { name } else { format!("{prefix}/{name}") };
            let path = root.join(&rel);
            if path.is_dir() {
                out.insert(rel.encode_utf16().collect(), (rel.clone(), Value::Null));
                walk(root, &rel, out);
            } else {
                out.insert(rel.encode_utf16().collect(), (rel.clone(), json!(fs::read_to_string(&path).unwrap())));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(root, "", &mut out);
    // JS sorts each folder's names on their own; a full-path sort gives the same order unless a name sorts below '/'.
    let mut map = serde_json::Map::new();
    for (_, (rel, v)) in out {
        map.insert(rel, v);
    }
    Value::Object(map)
}

/// The JSON object as the generator wrote it: keys in its order. serde_json keeps insertion order, so a tree compares
/// by its entries (order-independent) and the answers compare exactly.
fn same_tree(a: &Value, b: &Value) -> bool {
    let (Some(a), Some(b)) = (a.as_object(), b.as_object()) else { return false };
    a.len() == b.len() && a.iter().all(|(k, v)| b.get(k) == Some(v))
}

const BASE: &[(&str, &str)] = &[("a.txt", "A"), ("src/b.txt", "B"), ("src/deep/c.txt", "C"), ("docs/a.txt", "other A")];

#[test]
fn operations_match_the_ts_reference() {
    let scratch = tempfile::Builder::new().prefix("unimux-g6-golden-").tempdir().unwrap();
    let mut count = 0;
    for (i, row) in rows().iter().enumerate() {
        let Some(op) = row["op"].as_str() else { continue };
        if skip(row) {
            continue;
        }
        count += 1;
        let fixture = scratch.path().join(format!("op{i}"));
        let root = fixture.join("project");
        let trash_dir = fixture.join("trash");
        build(&root, BASE);
        fs::create_dir(&trash_dir).unwrap();
        fs::write(fixture.join("outside.txt"), "outside").unwrap();
        let trashed: Arc<Mutex<Vec<String>>> = Arc::default();
        let t = trashed.clone();
        let trash = Arc::new(move |p: &str| {
            let mut list = t.lock().unwrap();
            let name = Path::new(p).file_name().unwrap().to_string_lossy().into_owned();
            list.push(name.clone());
            fs::rename(p, trash_dir.join(format!("{}-{name}", list.len()))).map_err(|e| FsError::io(&e, "rename", p))
        });
        let r = root.to_string_lossy().into_owned();
        let a = &row["args"];
        let out = match op {
            "rename" => rename_project_entry(&r, &a[0], &a[1], LocalPlatform::Windows),
            "create" => create_project_entry(&r, &a[0], &a[1], a[2] == "directory", LocalPlatform::Windows),
            "delete" => delete_project_entries(&r, &a[0], &*trash),
            "transfer" => {
                let mut options = OpOptions::new(trash.clone());
                options.platform = LocalPlatform::Windows;
                transfer_project_entries(&r, &a[0], &options)
            }
            other => panic!("row {i}: unknown op {other}"),
        };
        assert_eq!(out, row["out"], "row {i} {op} {a}");
        assert_eq!(serde_json::to_string(&out).unwrap(), serde_json::to_string(&row["out"]).unwrap(), "row {i}: key order");
        let after = tree(&root);
        assert!(same_tree(&after, &row["tree"]), "row {i} {op} {a}\n tree {after}\n want {}", row["tree"]);
        assert_eq!(json!(*trashed.lock().unwrap()), row["trash"], "row {i} {op} {a}: trash");
    }
    assert!(count > 90, "{count} operation rows");
}

#[test]
fn local_pane_matches_the_ts_reference() {
    let scratch = tempfile::Builder::new().prefix("unimux-g6-pane-").tempdir().unwrap();
    let mut count = 0;
    for (i, row) in rows().iter().enumerate() {
        let Some(name) = row["pane"].as_str() else { continue };
        if skip(row) {
            continue;
        }
        // The rows were made on Windows: their absolute paths and the drive root only mean the same there.
        if !cfg!(windows) {
            continue;
        }
        count += 1;
        let dir = scratch.path().join(format!("pane{i}"));
        build(&dir, &[("a.txt", "abc"), ("sub/x.txt", "x"), (".hidden", "")]);
        let d = dir.to_string_lossy().into_owned();
        let calls: Arc<Mutex<Vec<String>>> = Arc::default();
        let (c1, c2, c3) = (calls.clone(), calls.clone(), calls.clone());
        let home = d.clone();
        let pane = LocalPane::new(PaneDeps {
            platform: LocalPlatform::Windows,
            trash: Arc::new(move |p: &str| {
                c1.lock().unwrap().push(format!("trash {p}"));
                let meta = fs::symlink_metadata(p).map_err(|e| FsError::io(&e, "lstat", p))?;
                let removed = if meta.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
                removed.map_err(|e| FsError::io(&e, "rm", p))
            }),
            open_folder: Box::new(move |p: &str| {
                c2.lock().unwrap().push(format!("open {p}"));
                Ok(())
            }),
            show_file: Box::new(move |p: &str| c3.lock().unwrap().push(format!("show {p}"))),
            home: Box::new(move || home.clone()),
        });
        let fill = |v: &Value| -> Value {
            fn f(v: &Value, d: &str) -> Value {
                match v {
                    Value::String(s) => Value::String(s.replace("<dir>", d).replace('/', std::path::MAIN_SEPARATOR_STR)),
                    Value::Array(a) => Value::Array(a.iter().map(|x| f(x, d)).collect()),
                    other => other.clone(),
                }
            }
            f(v, &d)
        };
        let a = &row["args"];
        let mut out = match name {
            "list" => pane.list(&fill(&a[0])),
            "mkdir" => pane.mkdir(&fill(&a[0])),
            "rename" => pane.rename(&fill(&a[0]), &fill(&a[1])),
            "trash" => pane.trash(&fill(&a[0])),
            "reveal" => pane.reveal(&fill(&a[0])),
            other => panic!("row {i}: unknown pane call {other}"),
        };
        fn mask(v: &mut Value, d: &str) {
            match v {
                Value::String(s) => *s = s.replace(d, "<dir>"),
                Value::Array(a) => a.iter_mut().for_each(|x| mask(x, d)),
                Value::Object(o) => {
                    for (k, x) in o.iter_mut() {
                        if k == "mtime" {
                            *x = json!("<mtime>");
                        } else {
                            mask(x, d);
                        }
                    }
                }
                _ => {}
            }
        }
        mask(&mut out, &d);
        if let Some(entries) = out.pointer_mut("/value/entries").and_then(Value::as_array_mut) {
            entries.sort_by(|x, y| x["name"].as_str().cmp(&y["name"].as_str()));
        }
        assert_eq!(out, row["out"], "row {i} {name} {a}");
        assert_eq!(serde_json::to_string(&out).unwrap(), serde_json::to_string(&row["out"]).unwrap(), "row {i}: key order");
        let mut seen = json!(*calls.lock().unwrap());
        mask(&mut seen, &d);
        assert_eq!(seen, row["calls"], "row {i} {name} {a}: calls");
        assert!(same_tree(&tree(&dir), &row["tree"]), "row {i} {name} {a}: tree {}", tree(&dir));
    }
    if cfg!(windows) {
        assert!(count > 25, "{count} pane rows");
    }
}
