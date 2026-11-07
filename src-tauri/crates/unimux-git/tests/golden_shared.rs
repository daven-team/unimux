//! G2 against the TS reference: every row of test/golden/git-shared.jsonl (src/shared/git.ts) and git-trust.jsonl
//! (src/shared/gitTrust.ts, the scan fingerprint hash, GitTrustStore's file format), written by scripts/goldens-git.mjs.

use indexmap::IndexMap;
use serde::Serialize;
use serde_json::{Value, json};
use unimux_git::shared::{self, GitChannel, GitProjectRelation, RelationKind};
use unimux_git::trust::{self, AttributeDriver, ConfigEntry, DriverKind};

fn rows(name: &str) -> Vec<Value> {
    let path = format!("{}/../../../test/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| unimux_core::js_json::parse(l).unwrap()).collect()
}

/// JSON equality with numbers compared as JS numbers (1 == 1.0) and object keys in any order.
fn same(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same(a, b)),
        (Value::Object(x), Value::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| same(v, w))),
        _ => a == b,
    }
}

fn v<T: Serialize>(value: T) -> Value {
    serde_json::to_value(value).unwrap()
}

fn s(value: &Value) -> &str {
    value.as_str().unwrap()
}

fn checked<T: Serialize>(result: Result<T, String>) -> Value {
    match result {
        Ok(value) => json!({ "ok": true, "value": v(value) }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn shared_row(f: &str, a: &[Value]) -> Value {
    match f {
        "isSafeRef" => v(shared::is_safe_ref(&a[0])),
        "isSafeRemote" => v(shared::is_safe_remote(&a[0])),
        "isCommitHash" => v(shared::is_commit_hash(&a[0])),
        "isRequestId" => v(shared::is_request_id(&a[0])),
        "normalizeRepoPath" => v(shared::normalize_repo_path(&a[0], a[1].as_bool().unwrap())),
        "validateGitRequest" => {
            let channel = GitChannel::parse(s(&a[0])).unwrap();
            checked(shared::validate_git_request(channel, &a[1], a[2].as_bool().unwrap()))
        }
        "isCloneUrl" => v(shared::is_clone_url(&a[0])),
        "cloneFolderName" => v(shared::clone_folder_name(s(&a[0]))),
        "isSafeFolderName" => v(shared::is_safe_folder_name(&a[0])),
        "validateCloneRequest" => checked(shared::validate_clone_request(&a[0])),
        "parseStatusV2" => v(shared::parse_status_v2(s(&a[0]), a[1].as_u64().unwrap() as usize)),
        "parseRefs" => v(shared::parse_refs(s(&a[0]))),
        "parseLog" => v(shared::parse_log(s(&a[0]))),
        "parseDetails" => v(shared::parse_details(s(&a[0]))),
        "parseDiffTree" => {
            let (files, truncated) = shared::parse_diff_tree(s(&a[0]), a[1].as_u64().unwrap() as usize);
            json!({ "files": v(files), "truncated": truncated })
        }
        "parseBranches" => v(shared::parse_branches(s(&a[0]))),
        "parseWorktrees" => v(shared::parse_worktrees(s(&a[0]))),
        "parseUnifiedDiff" => v(shared::parse_unified_diff(s(&a[0]), a[1].as_u64().unwrap() as usize)),
        "layoutGraph" => {
            let commits: Vec<(String, Vec<String>)> = a[0]
                .as_array()
                .unwrap()
                .iter()
                .map(|c| (s(&c["hash"]).to_string(), c["parents"].as_array().unwrap().iter().map(|p| s(p).to_string()).collect()))
                .collect();
            v(shared::layout_graph(commits.iter().map(|(h, p)| (h.as_str(), p.as_slice()))))
        }
        "projectRelativePath" => {
            let relation = a[0].as_object().map(|o| GitProjectRelation {
                kind: if s(&o["kind"]) == "inside-root" { RelationKind::InsideRoot } else { RelationKind::ContainsRoot },
                prefix: s(&o["prefix"]).to_string(),
            });
            v(shared::project_relative_path(relation.as_ref(), s(&a[1]), a[2].as_bool().unwrap()))
        }
        "worktreeAllowed" => {
            let extra: Vec<String> = a[2].as_array().unwrap().iter().map(|p| s(p).to_string()).collect();
            v(shared::worktree_allowed(s(&a[0]), s(&a[1]), &extra))
        }
        other => panic!("unknown fn {other}"),
    }
}

#[test]
fn shared_git_matches_the_ts_reference() {
    let rows = rows("git-shared.jsonl");
    assert!(rows.len() > 5000, "{} rows", rows.len());
    let mut failures = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let f = s(&row["fn"]);
        let args = row["args"].as_array().unwrap();
        let out = shared_row(f, args);
        if !same(&out, &row["out"]) && failures.len() < 20 {
            failures.push(format!("row {i} {f}({}):\n  rust {out}\n  ts   {}", Value::Array(args.clone()), row["out"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

fn entries(value: &Value) -> Vec<ConfigEntry> {
    value.as_array().unwrap().iter().map(|e| ConfigEntry { key: s(&e["key"]).into(), value: s(&e["value"]).into() }).collect()
}

fn drivers(value: &Value) -> Vec<AttributeDriver> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|d| AttributeDriver {
            kind: match s(&d["kind"]) {
                "filter" => DriverKind::Filter,
                "diff" => DriverKind::Diff,
                _ => DriverKind::Merge,
            },
            name: s(&d["name"]).into(),
        })
        .collect()
}

fn trust_row(f: &str, a: &[Value]) -> Value {
    match f {
        "parseConfigList" => v(trust::parse_config_list(s(&a[0]))),
        "dangerousConfigKeys" => v(trust::dangerous_config_keys(&entries(&a[0]))),
        "attributeDrivers" => v(trust::attribute_drivers(s(&a[0]))),
        "configuredAttributeDrivers" => v(trust::configured_attribute_drivers(&drivers(&a[0]), &entries(&a[1]))),
        "fingerprintHash" => {
            let mut list: Vec<String> = a[0].as_array().unwrap().iter().map(|x| s(x).to_string()).collect();
            let hash = trust::fingerprint_hash(&mut list);
            json!({ "sorted": list, "hash": hash })
        }
        "trustStore" => {
            let mut map: IndexMap<String, String> = trust::entries_of(s(&a[0]));
            let loaded: Vec<Value> = map.iter().map(|(k, v)| json!([k, v])).collect();
            let mut saved = Value::Null;
            for op in a[1].as_array().unwrap() {
                let op = op.as_array().unwrap();
                if s(&op[0]) == "set" {
                    map.insert(s(&op[1]).into(), s(&op[2]).into());
                    saved = Value::String(trust::store_text(&map));
                } else if map.shift_remove(s(&op[1])).is_some() {
                    saved = Value::String(trust::store_text(&map));
                }
            }
            json!({ "loaded": loaded, "saved": saved })
        }
        other => panic!("unknown fn {other}"),
    }
}

#[test]
fn trust_model_matches_the_ts_reference() {
    let rows = rows("git-trust.jsonl");
    assert!(rows.len() > 1500, "{} rows", rows.len());
    let mut failures = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        let f = s(&row["fn"]);
        let args = row["args"].as_array().unwrap();
        let out = trust_row(f, args);
        if !same(&out, &row["out"]) && failures.len() < 20 {
            failures.push(format!("row {i} {f}({}):\n  rust {out}\n  ts   {}", Value::Array(args.clone()), row["out"]));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}
