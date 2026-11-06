//! The golden corpus of unimux-core (scripts/dump-goldens.mjs, written by the TS reference).

use serde_json::Value;

fn rows(name: &str) -> Vec<Value> {
    let path = format!("{}/../../../test/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect()
}

#[test]
fn translate_matches_the_ts_reference_in_six_languages() {
    let rows = rows("translate.jsonl");
    assert!(rows.len() > 1000);
    for (i, row) in rows.iter().enumerate() {
        let params: Vec<(String, String)> = row["params"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.as_str().map(str::to_string).unwrap_or_else(|| v.to_string())))
            .collect();
        let params: Vec<(&str, &str)> = params.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let out = unimux_core::i18n::translate(row["language"].as_str().unwrap(), row["key"].as_str().unwrap(), &params);
        assert_eq!(out, row["out"].as_str().unwrap(), "row {i}");
    }
}

#[test]
fn temp_names_match_the_ts_reference() {
    for row in rows("atomic-write.jsonl") {
        let name = format!(
            "{}.{}.{}{}.tmp",
            row["file"].as_str().unwrap(),
            row["pid"],
            unimux_core::time::base36(row["ms"].as_u64().unwrap()),
            unimux_core::time::base36(row["counter"].as_u64().unwrap())
        );
        assert_eq!(name, row["out"].as_str().unwrap());
    }
}
