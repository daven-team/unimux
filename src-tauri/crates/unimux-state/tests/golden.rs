//! The golden corpus of the state code (scripts/dump-goldens.mjs, written by the TS reference): every Rust answer must be
//! byte-identical to the TS one (compared as JSON.stringify text).

use serde_json::Value;
use unimux_core::js_json::stringify;
use unimux_state::edits::merge_state_edit;
use unimux_state::patch::{apply_patch, diff_state};

fn rows(name: &str) -> Vec<Value> {
    let path = format!("{}/../../../test/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()
}

#[test]
fn merge_state_edit_matches_the_ts_reference() {
    let rows = rows("state-merge.jsonl");
    assert!(rows.len() >= 400);
    for (i, row) in rows.iter().enumerate() {
        let out = merge_state_edit(&row["current"], &row["base"], &row["next"]);
        assert_eq!(stringify(&out), stringify(&row["out"]), "row {i}");
    }
}

#[test]
fn diff_state_matches_the_ts_reference_and_applies() {
    let rows = rows("state-diff.jsonl");
    assert!(rows.len() >= 400);
    for (i, row) in rows.iter().enumerate() {
        let patch = diff_state(&row["prev"], &row["next"]).unwrap_or(Value::Null);
        assert_eq!(stringify(&patch), stringify(&row["patch"]), "row {i}");
        let applied = if patch.is_null() { row["prev"].clone() } else { apply_patch(&row["prev"], &patch).unwrap() };
        assert_eq!(stringify(&applied), stringify(&row["next"]), "row {i}: apply(diff(a, b), a) == b");
    }
}
