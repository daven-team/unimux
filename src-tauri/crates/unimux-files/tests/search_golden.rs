//! The project search part of the golden corpus (scripts/goldens-search.mjs: answers of 1.1.4's src/shared/search.ts and
//! src/main/search.ts under V8). Polish diacritics, emoji (surrogate pairs cut by the preview), combining marks, Greek and
//! the special case-folding letters run through every row.

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value, json};
use unimux_files::search::{
    Only, SearchOptions, build_pattern, compile_globs, replace_in_project, replace_in_text, search_project, search_text,
};

fn rows(name: &str) -> Vec<Value> {
    let path = format!("{}/../../../test/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn units(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

/// `text.split(/(\r\n|\r|\n)/)` (lines and their breaks), as strings.
fn parts(text: &[u16]) -> Vec<String> {
    let mut out = Vec::new();
    let mut start = 0;
    let mut i = 0;
    while i < text.len() {
        let len = match text[i] {
            0x0d if text.get(i + 1) == Some(&0x0a) => 2,
            0x0d | 0x0a => 1,
            _ => 0,
        };
        if len == 0 {
            i += 1;
            continue;
        }
        out.push(String::from_utf16_lossy(&text[start..i]));
        out.push(String::from_utf16_lossy(&text[i..i + len]));
        i += len;
        start = i;
    }
    out.push(String::from_utf16_lossy(&text[start..]));
    out
}

fn changed_lines(sample: &[String], text: &[u16]) -> Value {
    let now = parts(text);
    assert_eq!(now.len(), sample.len());
    let mut out = Map::new();
    for (i, (a, b)) in now.iter().zip(sample).enumerate() {
        if a != b {
            out.insert(i.to_string(), json!(a));
        }
    }
    Value::Object(out)
}

#[test]
fn patterns_match_v8() {
    let rows = rows("search-pattern.jsonl");
    let sample = units(rows[0]["text"].as_str().unwrap());
    let sample_parts = parts(&sample);
    let replacement = units(rows[0]["replacement"].as_str().unwrap());
    assert!(rows.len() > 1000);
    let mut failures = Vec::new();
    for (i, row) in rows.iter().enumerate().skip(1) {
        let options = SearchOptions::from_json(&row["options"]).unwrap();
        let built = build_pattern(&options);
        let got = match &built {
            Err(error) => json!({ "error": error.clone().unwrap_or_default() }),
            Ok(re) => {
                let (found, truncated) = search_text(&sample, re, 40);
                let all = replace_in_text(&sample, re, &replacement, options.regex, None);
                let one = found.get(1).map(|m| {
                    let only = Only { line: Some(m.line as f64), column: Some(m.column as f64), text: Some(m.text.clone()) };
                    replace_in_text(&sample, re, &replacement, options.regex, Some(&only))
                });
                json!({
                    "flags": re.flags(),
                    "matches": found.iter().map(|m| m.to_json()).collect::<Vec<_>>(),
                    "truncated": truncated,
                    "replaceAll": { "count": all.1, "lines": changed_lines(&sample_parts, &all.0) },
                    "replaceOne": one.map(|(t, c)| json!({ "count": c, "lines": changed_lines(&sample_parts, &t) })),
                })
            }
        };
        let mut expected = row.clone();
        let e = expected.as_object_mut().unwrap();
        for k in ["options", "source", "hangs"] {
            e.remove(k);
        }
        if got != expected {
            failures.push(format!("row {i} {}:\n  rust {got}\n  v8   {expected}", row["options"]));
        }
    }
    assert!(failures.is_empty(), "{} of {} rows differ:\n{}", failures.len(), rows.len() - 1, failures.join("\n"));
}

#[test]
fn random_patterns_compile_and_match_like_v8() {
    let rows = rows("search-compile.jsonl");
    let text = units(rows[0]["text"].as_str().unwrap());
    assert!(rows.len() > 4000);
    let mut failures = Vec::new();
    for (i, row) in rows.iter().enumerate().skip(1) {
        let options = SearchOptions::from_json(&row["options"]).unwrap();
        let got = match build_pattern(&options) {
            Err(error) => json!({ "options": row["options"], "error": error.unwrap_or_default() }),
            Ok(re) => {
                let (found, _) = search_text(&text, &re, 20);
                json!({
                    "options": row["options"], "flags": re.flags(),
                    "matches": found.iter().map(|m| json!([m.line, m.column, m.text])).collect::<Vec<_>>(),
                })
            }
        };
        if &got != row {
            failures.push(format!("row {i}:\n  rust {got}\n  v8   {row}"));
        }
    }
    assert!(failures.is_empty(), "{} of {} rows differ:\n{}", failures.len(), rows.len() - 1, failures.join("\n"));
}

#[test]
fn globs_match_the_ts_reference() {
    for (i, row) in rows("search-glob.jsonl").iter().enumerate() {
        let globs = compile_globs(row["spec"].as_str());
        let got = globs
            .map(|g| row["paths"].as_array().unwrap().iter().map(|p| json!(g.matches(p.as_str().unwrap()))).collect::<Vec<_>>());
        assert_eq!(got.map(Value::Array).unwrap_or(Value::Null), row["out"], "row {i} {}", row["spec"]);
    }
}

fn build(dir: &Path, layout: &Value) {
    for file in layout.as_array().unwrap() {
        if let Some(d) = file["dir"].as_str() {
            fs::create_dir_all(dir.join(d)).unwrap();
            continue;
        }
        let path = dir.join(file["path"].as_str().unwrap());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let data = match file["pad"].as_u64() {
            Some(pad) => {
                let mut d = vec![b'a'; pad as usize];
                d.extend(STANDARD.decode(file["tail"].as_str().unwrap()).unwrap());
                d
            }
            None => STANDARD.decode(file["bytes"].as_str().unwrap()).unwrap(),
        };
        fs::write(path, data).unwrap();
    }
}

/// Every file under `dir`: relative path -> base64 bytes, or `{size}` past 4 KiB (sorted like JS strings).
fn snapshot(dir: &Path) -> BTreeMap<Vec<u16>, (String, Value)> {
    fn walk(dir: &Path, rel: &str, out: &mut BTreeMap<Vec<u16>, (String, Value)>) {
        for entry in fs::read_dir(dir.join(rel)).unwrap() {
            let entry = entry.unwrap();
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = if rel.is_empty() { name } else { format!("{rel}/{name}") };
            if entry.file_type().unwrap().is_dir() {
                walk(dir, &path, out);
            } else {
                let data = fs::read(dir.join(&path)).unwrap();
                let value = if data.len() > 4096 { json!({ "size": data.len() }) } else { json!(STANDARD.encode(&data)) };
                out.insert(path.encode_utf16().collect(), (path, value));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, "", &mut out);
    out
}

fn ms() -> impl Fn() -> f64 {
    unimux_files::search::clock()
}

#[test]
fn project_searches_match_the_ts_reference() {
    let rows = rows("search-project.jsonl");
    let dir = tempfile::tempdir().unwrap();
    build(dir.path(), &rows[0]["layout"]);
    let root = dir.path().to_string_lossy().into_owned();
    for (i, row) in rows.iter().enumerate().skip(1) {
        let out = search_project(&root, &row["options"], &ms(), None).unwrap();
        assert_eq!(out, row["out"], "row {i} {}", row["options"]);
    }
}

#[test]
fn project_replaces_match_the_ts_reference() {
    let rows = rows("search-replace.jsonl");
    let layout = &rows[0]["layout"];
    let before = {
        let dir = tempfile::tempdir().unwrap();
        build(dir.path(), layout);
        snapshot(dir.path())
    };
    for (i, row) in rows.iter().enumerate().skip(1) {
        let parent = tempfile::tempdir().unwrap();
        let dir = parent.path().join("p");
        fs::create_dir(&dir).unwrap();
        build(&dir, layout);
        let out = replace_in_project(&dir.to_string_lossy(), &row["request"]).unwrap();
        assert_eq!(out, row["out"], "row {i} {}", row["request"]);
        let after = snapshot(&dir);
        let changed: Map<String, Value> = after
            .iter()
            .filter(|(k, (_, v))| before.get(*k).map(|b| &b.1) != Some(v))
            .map(|(_, (p, v))| (p.clone(), v.clone()))
            .collect();
        assert_eq!(Value::Object(changed), row["changed"], "row {i} {}", row["request"]);
        let names: Vec<Value> = after.values().map(|(p, _)| json!(p)).collect();
        assert_eq!(Value::Array(names), row["names"], "row {i}");
    }
}
