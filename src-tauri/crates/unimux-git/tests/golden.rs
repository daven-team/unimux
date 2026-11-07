//! The pure halves of G1 against the TS reference (scripts/dump-goldens.mjs): normalizeSpelling of src/main/gitPaths.ts and
//! trimGitText / redactSecrets of src/shared/git.ts, and Node's path.win32.resolve / path.posix.resolve (git-resolve.jsonl).

use serde_json::Value;
use unimux_git::paths::{normalize_spelling, resolve_posix_with, resolve_win32_with};
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

/// The fixed cwd and drive cwds dump-goldens.mjs gives Node while it writes git-resolve.jsonl.
fn drive_cwd(device: &str) -> Option<String> {
    match device.to_ascii_uppercase().as_str() {
        "C:" => Some(r"C:\work\cwd".into()),
        "D:" => Some(r"D:\dcwd\x".into()),
        "E:" => Some(r"C:\not-e".into()),
        "F:" => Some(String::new()),
        _ => None,
    }
}

#[test]
fn resolve_matches_node_path_resolve() {
    let rows = rows("git-resolve.jsonl");
    assert!(rows.len() > 500);
    for row in rows {
        let args: Vec<&str> = row["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap()).collect();
        assert_eq!(resolve_win32_with(&args, r"C:\work\cwd", &drive_cwd), row["win32"].as_str().unwrap(), "win32 {args:?}");
        assert_eq!(resolve_posix_with(&args, "/work/cwd"), row["posix"].as_str().unwrap(), "posix {args:?}");
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
