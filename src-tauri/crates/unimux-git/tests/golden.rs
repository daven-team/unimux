//! The pure halves of G1 against the TS reference (scripts/dump-goldens.mjs): normalizeSpelling of src/main/gitPaths.ts and
//! trimGitText / redactSecrets of src/shared/git.ts.

use serde_json::Value;
use unimux_git::paths::normalize_spelling;
use unimux_git::text::{redact_secrets, trim_git_text};

fn rows(name: &str) -> Vec<Value> {
    let path = format!("{}/../../../test/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"));
    // js_json::parse reads a lone surrogate the way 1.2.0 does (U+FFFD); a Rust string cannot hold one.
    text.lines().filter(|l| !l.trim().is_empty()).map(|l| unimux_core::js_json::parse(l).unwrap()).collect()
}

#[test]
fn folder_spellings_match_the_ts_reference() {
    let rows = rows("git-spelling.jsonl");
    assert!(rows.len() > 300);
    for row in rows {
        let path = row["path"].as_str().unwrap();
        assert_eq!(normalize_spelling(path, true), row["win32"].as_str().unwrap(), "win32 {path:?}");
        assert_eq!(normalize_spelling(path, false), row["darwin"].as_str().unwrap(), "darwin {path:?}");
    }
}

#[test]
fn git_texts_match_the_ts_reference() {
    let rows = rows("git-text.jsonl");
    assert!(rows.len() > 300);
    for (i, row) in rows.iter().enumerate() {
        let value = row["value"].as_str().unwrap();
        let max = row["max"].as_u64().unwrap() as usize;
        assert_eq!(redact_secrets(value), row["redacted"].as_str().unwrap(), "row {i} redacted {value:?}");
        assert_eq!(trim_git_text(value, max), row["trimmed"].as_str().unwrap(), "row {i} trimmed {value:?}");
    }
}
