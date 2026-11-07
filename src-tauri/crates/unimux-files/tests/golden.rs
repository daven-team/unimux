//! The golden corpus of unimux-files (scripts/goldens-files.mjs, answers of the 1.1.4 TS code and of V8 / Node).

use std::fs;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Value, json};
use unimux_files::collate::compare_names;
use unimux_files::jspath::{self, Flavor};
use unimux_files::preview::{LARGE_VIEW_BYTES, PREVIEW_BYTES, Preview};
use unimux_files::project::{project_file_path, read_project_file};
use unimux_files::save::write_file_with;

fn rows(name: &str) -> Vec<Value> {
    let path = format!("{}/../../../test/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn bytes(v: &Value) -> Vec<u8> {
    STANDARD.decode(v.as_str().unwrap_or("")).unwrap()
}

#[test]
fn name_order_matches_v8_intl_collator() {
    let rows = rows("files-collate.jsonl");
    assert!(rows.len() > 400);
    let mut failures = Vec::new();
    let mut mixed = 0;
    for (i, row) in rows.iter().enumerate() {
        let mut names: Vec<String> = serde_json::from_value(row["names"].clone()).unwrap();
        names.sort_by(|a, b| compare_names(a, b));
        let expected: Vec<String> = serde_json::from_value(row["order"].clone()).unwrap();
        if names == expected {
            continue;
        }
        // Known difference (PROGRESS.md G5 open issues): a run of digits from two scripts ("100٣") is one number in ICU4X
        // and two in V8's ICU. Only such rows may differ.
        if names.iter().any(|n| mixed_script_digits(n)) {
            mixed += 1;
            continue;
        }
        failures.push(format!("row {i}:\n  rust {names:?}\n  v8   {expected:?}"));
    }
    assert!(failures.is_empty(), "{} of {} rows differ:\n{}", failures.len(), rows.len(), failures.join("\n"));
    assert!(mixed <= 3, "{mixed} rows differ on mixed-script digit runs");
}

/// An ASCII digit next to a decimal digit of another script (U+0660..U+0669 is the one in the corpus).
fn mixed_script_digits(name: &str) -> bool {
    let chars: Vec<char> = name.chars().collect();
    chars.windows(2).any(|w| {
        let other = |c: char| ('\u{660}'..='\u{669}').contains(&c);
        (w[0].is_ascii_digit() && other(w[1])) || (other(w[0]) && w[1].is_ascii_digit())
    })
}

#[test]
fn path_checks_match_node() {
    for (i, row) in rows("files-path.jsonl").iter().enumerate() {
        let flavor = if row["flavor"] == "win32" { Flavor::Win32 } else { Flavor::Posix };
        let root = row["root"].as_str().unwrap();
        let rel = row["rel"].as_str().unwrap();
        let resolved_root = jspath::resolve(flavor, &[root]);
        assert_eq!(resolved_root, row["resolvedRoot"].as_str().unwrap(), "row {i} {row}");
        let resolved = jspath::resolve(flavor, &[&resolved_root, rel]);
        assert_eq!(resolved, row["resolved"].as_str().unwrap(), "row {i} {row}");
        assert_eq!(jspath::is_absolute(flavor, rel), row["relAbsolute"].as_bool().unwrap(), "row {i} {row}");
        assert_eq!(jspath::relative(flavor, &resolved_root, &resolved), row["relative"].as_str().unwrap(), "row {i} {row}");
        assert_eq!(jspath::is_inside(flavor, &resolved_root, &resolved), row["inside"].as_bool().unwrap(), "row {i} {row}");
    }
}

fn preview_json(p: Preview) -> Value {
    match p {
        // TS answers a data URL; the bridge builds it from these bytes (src/preload/mcApi.ts).
        Preview::Image { mime, bytes, size } => {
            json!({ "kind": "image", "mime": mime, "dataUrl": format!("data:{mime};base64,{}", STANDARD.encode(bytes)), "size": size })
        }
        other => other.into_reply().0,
    }
}

#[test]
fn previews_match_the_ts_reference() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    let rows = rows("files-preview.jsonl");
    assert!(rows.len() > 100);
    for (i, row) in rows.iter().enumerate() {
        let name = row["name"].as_str().unwrap();
        let pad = row["padA"].as_u64().unwrap() as usize;
        let mut data = bytes(&row["prefix"]);
        data.extend(std::iter::repeat_n(b'a', pad));
        data.extend(bytes(&row["bytes"]));
        fs::write(dir.path().join(name), &data).unwrap();
        let large = row["large"].as_bool().unwrap();
        let mut out = preview_json(read_project_file(&root, Some(name), if large { LARGE_VIEW_BYTES } else { PREVIEW_BYTES }));
        let expected = &row["out"];
        if let Some(text) = out.get("text").and_then(Value::as_str).map(str::to_string) {
            let o = out.as_object_mut().unwrap();
            if expected.get("textLength").is_some() {
                let units: Vec<u16> = text.encode_utf16().collect();
                o.insert("textLength".into(), json!(units.len()));
                o.insert("textTail".into(), json!(String::from_utf16(&units[units.len().saturating_sub(4)..]).unwrap()));
                o.remove("text");
            } else if pad > 0 {
                let units: Vec<u16> = text.encode_utf16().collect();
                o.insert("textAfterPad".into(), json!(String::from_utf16(&units[pad.min(units.len())..]).unwrap()));
                o.remove("text");
            }
        }
        // Key order is not part of the answer.
        assert_eq!(sorted(&out), sorted(expected), "row {i} {name}");
        fs::remove_file(dir.path().join(name)).unwrap();
    }
}

fn sorted(v: &Value) -> Value {
    match v {
        Value::Object(m) => {
            let mut keys: Vec<_> = m.keys().cloned().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|k| (k.clone(), sorted(&m[&k]))).collect())
        }
        other => other.clone(),
    }
}

#[test]
fn saves_match_the_ts_reference() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().to_string_lossy().into_owned();
    for (i, row) in rows("files-save.jsonl").iter().enumerate() {
        let name = format!("f{i}.txt");
        let original = match row["bytesA"].as_u64().unwrap() {
            0 => bytes(&row["bytes"]),
            n => vec![b'a'; n as usize],
        };
        fs::write(dir.path().join(&name), &original).unwrap();
        let expected = match row["expectedA"].as_u64().unwrap() {
            0 => row["expected"].as_str().unwrap().to_string(),
            n => "a".repeat(n as usize),
        };
        let text = format!("{}{}", "p".repeat(row["padText"].as_u64().unwrap() as usize), row["text"].as_str().unwrap());
        let result = write_file_with(&|| project_file_path(&root, Some(&name), None), Some(&text), Some(&expected));
        assert_eq!(result.to_json(), row["result"], "row {i} {row}");
        let after = fs::read(dir.path().join(&name)).unwrap();
        assert_eq!(after.len() as u64, row["afterLength"].as_u64().unwrap(), "row {i}");
        if !row["after"].is_null() {
            assert_eq!(after, bytes(&row["after"]), "row {i}");
        }
        let left: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().contains(".mc-save-"))
            .collect();
        assert!(left.is_empty(), "row {i}: staged file left");
        fs::remove_file(dir.path().join(&name)).unwrap();
    }
}

/// The Parquet table preview against hyparquet (test/golden/parquet, written by `--example parquet_fixtures`).
#[cfg(feature = "parquet")]
#[test]
fn parquet_tables_match_the_ts_reference() {
    let dir = format!("{}/../../../test/golden/parquet", env!("CARGO_MANIFEST_DIR"));
    let rows = rows("files-parquet.jsonl");
    assert!(rows.len() >= 21);
    let mut failures = Vec::new();
    for row in &rows {
        let name = row["name"].as_str().unwrap();
        let out = preview_json(read_project_file(&dir, Some(name), LARGE_VIEW_BYTES));
        if sorted(&out) != sorted(&row["out"]) {
            failures.push(format!("{name}:\n  rust {out}\n  ts   {}", row["out"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

/// Without the feature a Parquet file answers the read failure (the large view only).
#[cfg(not(feature = "parquet"))]
#[test]
fn parquet_without_the_feature_is_a_failed_read() {
    let dir = format!("{}/../../../test/golden/parquet", env!("CARGO_MANIFEST_DIR"));
    let out = preview_json(read_project_file(&dir, Some("plain.parquet"), LARGE_VIEW_BYTES));
    assert_eq!(out, json!({ "kind": "error", "message": "Nie udało się odczytać pliku Parquet." }));
}
