//! The context meter and the session listing against the golden corpus of the 1.1.4 TS code (scripts/goldens-sessions.mjs):
//! claudeProjectDirName / normalizeProjectPath / worktreeMatcher, scanLines + contextUsage, scanBackwards over real files, and
//! listSessionsAsync / findRecentCodexSession over scratch homes built from the same scenario descriptions.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{Value, json};
use unimux_agents::context::tracker::scan_backwards;
use unimux_agents::context::usage::{ContextCli, ContextScan, context_usage, scan_lines};
use unimux_agents::sessions::{
    SessionIndex, WorktreeHint, claude_project_dir_name, normalize_project_path, to_json, worktree_matcher,
};
use unimux_core::js_json;

fn rows(name: &str) -> Vec<Value> {
    let path = format!("{}/../../../test/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    // JSON.stringify wrote a lone surrogate (a title cut in an emoji) as \udXXX; it reads as U+FFFD, as Rust writes it.
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| js_json::parse(l).unwrap()).collect()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn cli(v: &Value) -> ContextCli {
    ContextCli::parse(s(v)).unwrap()
}

#[test]
fn project_dir_names_normalized_paths_and_the_worktree_matcher_match() {
    let rows = rows("sessions-paths.jsonl");
    assert!(rows.len() > 600, "{}", rows.len());
    let mut non_bmp = 0;
    for (i, row) in rows.iter().enumerate() {
        match s(&row["fn"]) {
            "dirName" => {
                let path = s(&row["path"]);
                non_bmp += usize::from(path.chars().any(|c| c as u32 > 0xffff));
                assert_eq!(claude_project_dir_name(path), s(&row["out"]), "row {i}: {path:?}");
            }
            "normalize" => assert_eq!(normalize_project_path(s(&row["path"])), s(&row["out"]), "row {i}"),
            "matcher" => {
                let known: Vec<WorktreeHint> = row["known"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|k| WorktreeHint { path: s(&k["path"]).into(), branch: s(&k["branch"]).into() })
                    .collect();
                let m = worktree_matcher(s(&row["project"]), &known);
                assert_eq!(m(&normalize_project_path(s(&row["cwd"]))), row["out"].as_bool().unwrap(), "row {i}: {row}");
            }
            other => panic!("{other}"),
        }
    }
    assert!(non_bmp > 50, "the corpus must hold paths outside the BMP ({non_bmp})");
}

#[test]
fn scanned_lines_and_the_usage_match() {
    let rows = rows("context-scan.jsonl");
    assert_eq!(rows.len(), 800);
    for (i, row) in rows.iter().enumerate() {
        let lines: Vec<&str> = row["lines"].as_array().unwrap().iter().map(s).collect();
        // The generator ended 80% of the texts with a newline; the scan of either form is the same.
        let scan = scan_lines(cli(&row["cli"]), &ContextScan::default(), &lines.join("\n"));
        assert_eq!(scan.to_json(), row["scan"], "row {i} scan: {row}");
        let usage = context_usage(cli(&row["cli"]), &scan, row.get("hint").and_then(Value::as_str));
        assert_eq!(usage.map_or(Value::Null, |u| u.to_json()), row["usage"], "row {i} usage: {row}");
    }
}

/// `${REPEAT:<n>:<text>}` of the corpus.
fn expand_repeat(text: &str) -> String {
    let mut out = String::new();
    let mut rest = text;
    while let Some(at) = rest.find("${REPEAT:") {
        out.push_str(&rest[..at]);
        let spec = &rest[at + 9..];
        let colon = spec.find(':').unwrap();
        let end = spec.find('}').unwrap();
        let n: usize = spec[..colon].parse().unwrap();
        out.push_str(&spec[colon + 1..end].repeat(n));
        rest = &spec[end + 1..];
    }
    out.push_str(rest);
    out
}

#[test]
fn backward_reads_over_real_files_match() {
    let dir = tempfile::tempdir().unwrap();
    let rows = rows("context-backward.jsonl");
    assert!(rows.len() >= 17, "{}", rows.len());
    for (i, row) in rows.iter().enumerate() {
        let recipe = &row["recipe"];
        let mut text = String::new();
        for pair in recipe["lines"].as_array().unwrap() {
            let line = expand_repeat(s(&pair[0]));
            for _ in 0..pair[1].as_u64().unwrap() {
                text.push_str(&line);
                text.push('\n');
            }
        }
        text.push_str(&expand_repeat(recipe.get("tail").and_then(Value::as_str).unwrap_or("")));
        let file = dir.path().join(format!("{i}.jsonl"));
        fs::write(&file, &text).unwrap();
        assert_eq!(text.len() as u64, row["size"].as_u64().unwrap(), "row {i} size");
        let f = fs::File::open(&file).unwrap();
        let back = scan_backwards(&f, text.len() as u64, cli(&recipe["cli"])).unwrap();
        let got = json!({ "scan": back.scan.to_json(), "offset": back.offset });
        assert_eq!(got, row["out"], "row {i}");
    }
}

// ── session listings ──

fn sub_value(v: &Value, root: &str) -> Value {
    match v {
        Value::String(t) => json!(expand_repeat(t).replace("${ROOT}", root)),
        Value::Array(items) => Value::Array(items.iter().map(|x| sub_value(x, root)).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, x)| (k.clone(), sub_value(x, root))).collect()),
        other => other.clone(),
    }
}

fn expand_lines(lines: &[Value], root: &str, root_json: &str) -> String {
    let mut out = String::new();
    for line in lines {
        match line {
            Value::String(t) => {
                out.push_str(&expand_repeat(t).replace("${ROOT}", root_json));
                out.push('\n');
            }
            Value::Object(m) if m.contains_key("fill") => {
                for i in 0..m["fill"].as_u64().unwrap() {
                    let mut e = serde_json::Map::new();
                    e.insert("type".into(), json!("assistant"));
                    if let Some(id) = m.get("id") {
                        e.insert("sessionId".into(), id.clone());
                    }
                    e.insert(
                        "message".into(),
                        json!({ "content": format!("{}{i}", "x".repeat(m["width"].as_u64().unwrap() as usize)) }),
                    );
                    out.push_str(&js_json::stringify(&Value::Object(e)));
                    out.push('\n');
                }
            }
            Value::Object(m) if m.contains_key("partial") => out.push_str(s(&m["partial"])),
            other => {
                out.push_str(&js_json::stringify(&sub_value(other, root)));
                out.push('\n');
            }
        }
    }
    out
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as f64
}

/// Builds the scratch home of a scenario under `root` (buildScenario of the script); returns the home.
fn build_scenario(scenario: &Value, root: &Path) -> std::path::PathBuf {
    let root_s = root.to_string_lossy().into_owned();
    let root_json = js_json::stringify(&json!(root_s));
    let root_json = &root_json[1..root_json.len() - 1];
    let home = root.join("home");
    for d in scenario.get("dirs").and_then(Value::as_array).into_iter().flatten() {
        fs::create_dir_all(root.join(s(d))).unwrap();
    }
    let now = now_ms();
    for f in scenario["files"].as_array().unwrap() {
        let dir = if let Some(cwd) = f.get("claude") {
            home.join(".claude").join("projects").join(claude_project_dir_name(&s(cwd).replace("${ROOT}", &root_s)))
        } else if let Some(name) = f.get("claudeDir") {
            home.join(".claude").join("projects").join(s(name))
        } else {
            s(&f["codex"]).split('/').fold(home.join(".codex").join("sessions"), |p, part| p.join(part))
        };
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(s(&f["name"]));
        fs::write(&file, expand_lines(f["lines"].as_array().unwrap(), &root_s, root_json)).unwrap();
        let ms = match f.get("mtime") {
            Some(m) => m.as_f64().unwrap(),
            None => ((now - f["ago"].as_f64().unwrap() * 1000.0) / 1000.0).floor() * 1000.0,
        };
        let handle = fs::OpenOptions::new().write(true).open(&file).unwrap();
        handle.set_modified(UNIX_EPOCH + Duration::from_millis(ms as u64)).unwrap();
    }
    home
}

/// normalizeOut of the script.
fn normalize_out(out: Value, root: &Path) -> Value {
    let now = now_ms();
    fn births(v: &mut Value, now: f64) {
        match v {
            Value::Array(items) => items.iter_mut().for_each(|x| births(x, now)),
            Value::Object(m) => {
                for (k, x) in m.iter_mut() {
                    if k == "startedAt" && x.as_f64().is_some_and(|t| (t - now).abs() < 2.0 * 86_400_000.0) {
                        *x = json!("birth");
                    } else {
                        births(x, now);
                    }
                }
            }
            _ => {}
        }
    }
    let mut out = out;
    births(&mut out, now);
    let root_json = js_json::stringify(&json!(root.to_string_lossy()));
    let text = js_json::stringify(&out).replace(&root_json[1..root_json.len() - 1], "${ROOT}");
    js_json::parse(&text).unwrap()
}

#[test]
fn session_listings_over_scratch_homes_match() {
    let rows = rows("sessions-list.jsonl");
    assert!(rows.len() >= 14, "{}", rows.len());
    for row in &rows {
        let scenario = &row["scenario"];
        let name = s(&scenario["name"]);
        let root = tempfile::Builder::new().prefix("unimux-goldens-sessions-").tempdir().unwrap();
        let root_s = root.path().to_string_lossy().into_owned();
        let sub = |v: &Value| s(v).replace("${ROOT}", &root_s);
        let home = build_scenario(scenario, root.path());
        let index = SessionIndex::new();
        let out = if let Some(recent) = scenario.get("recent") {
            let exclude: HashSet<String> = recent["exclude"].as_array().unwrap().iter().map(|x| s(x).to_string()).collect();
            index
                .find_recent_codex_session(
                    &home,
                    &sub(&recent["cwd"]),
                    Duration::from_millis(recent["windowMs"].as_u64().unwrap()),
                    &exclude,
                )
                .map(|id| id.unwrap_or(Value::Null))
        } else {
            let branches: HashMap<String, String> = scenario
                .get("branches")
                .and_then(Value::as_object)
                .into_iter()
                .flatten()
                .map(|(k, v)| (k.replace("${ROOT}", &root_s), s(v).to_string()))
                .collect();
            let worktrees: Vec<WorktreeHint> = scenario
                .get("worktrees")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .map(|w| WorktreeHint { path: sub(&w["path"]), branch: s(&w["branch"]).into() })
                .collect();
            let branch_of = move |path: &str| branches.get(path).cloned();
            index.list_sessions(&home, &sub(&scenario["project"]), &worktrees, Some(&branch_of)).map(|l| to_json(&l))
        };
        let got = match out {
            Ok(v) => normalize_out(v, root.path()),
            Err(_) => json!({ "error": true }),
        };
        assert!(
            got == row["out"],
            "scenario {name}\n rust: {}\n   ts: {}",
            js_json::stringify(&got),
            js_json::stringify(&row["out"])
        );
    }
}
