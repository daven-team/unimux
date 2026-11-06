//! The update window goldens (scripts/goldens-update.mjs, written by the TS reference of 1.1.4): the progress model, the
//! close action, the translated window texts and a work/config.json as 1.1.4 writes it.

use serde_json::Value;
use unimux_update::progress::{CloseAction, UpdateProgressModel, UpdateSnapshot, UpdateStage, close_action};
use unimux_update::window::{UpdateSplashConfig, UpdateStrings};

fn golden(name: &str) -> String {
    let path = format!("{}/../../../test/golden/{name}", env!("CARGO_MANIFEST_DIR"));
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))
}

fn stage(name: &str) -> Option<UpdateStage> {
    Some(match name {
        "preparing" => UpdateStage::Preparing,
        "closing" => UpdateStage::Closing,
        "installing" => UpdateStage::Installing,
        "launching" => UpdateStage::Launching,
        "done" => UpdateStage::Done,
        "error" => UpdateStage::Error,
        _ => return None,
    })
}

#[test]
fn the_progress_model_matches_the_ts_reference_step_by_step() {
    let text = golden("update-progress.jsonl");
    let rows: Vec<Value> = text.lines().filter(|l| !l.trim().is_empty()).map(|l| serde_json::from_str(l).unwrap()).collect();
    let mut steps = 0;
    let mut failures = Vec::new();
    for (i, row) in rows.iter().enumerate() {
        if let Some(actions) = row.get("closeAction") {
            for (name, action) in actions.as_object().unwrap() {
                // The gate stages (checking, ask, downloading, failed) never reach the Rust window; the TS rule still holds.
                let expected = if action == "exit" { CloseAction::Exit } else { CloseAction::Hide };
                match stage(name) {
                    Some(s) => assert_eq!(close_action(s), expected, "closeAction({name})"),
                    None => assert_eq!(expected, CloseAction::Hide, "closeAction({name})"),
                }
            }
            continue;
        }
        let mut model = UpdateProgressModel::new(row["baseline"].as_f64().unwrap());
        for (k, (step, out)) in row["steps"].as_array().unwrap().iter().zip(row["out"].as_array().unwrap()).enumerate() {
            let s = step.as_array().unwrap();
            let p = model.update(UpdateSnapshot {
                elapsed_ms: s[0].as_f64().unwrap(),
                closed: s[1].as_bool().unwrap(),
                installed: s[2].as_bool().unwrap(),
                ready: s[3].as_bool().unwrap(),
                dir_bytes: s[4].as_f64(),
            });
            steps += 1;
            let got = (p.stage.as_str(), p.percent, p.note.map(|n| serde_json::to_value(n).unwrap()).unwrap_or(Value::Null));
            let want = (out[0].as_str().unwrap(), out[1].as_f64().unwrap(), out[2].clone());
            if got.0 != want.0 || got.1 != want.1 || got.2 != want.2 {
                failures.push(format!("row {i} step {k} {step}: rust {got:?}, ts {want:?}"));
            }
        }
    }
    assert!(steps >= 10_000, "{steps} steps");
    assert!(
        failures.is_empty(),
        "{} of {steps} steps differ:\n{}",
        failures.len(),
        failures[..failures.len().min(20)].join("\n")
    );
}

#[test]
fn the_window_texts_match_update_strings_of_1_1_4_in_every_language() {
    let golden: Value = serde_json::from_str(&golden("update-strings.json")).unwrap();
    let version = golden["version"].as_str().unwrap();
    let languages = golden["strings"].as_object().unwrap();
    assert_eq!(languages.len(), 6);
    for (language, expected) in languages {
        let rust = serde_json::to_value(UpdateStrings::translated(language, version)).unwrap();
        assert_eq!(&rust, expected, "{language}");
    }
}

#[test]
fn a_config_written_by_1_1_4_reads_unchanged() {
    let text = golden("update-config.json");
    let config: UpdateSplashConfig = serde_json::from_str(&text).unwrap();
    assert_eq!((config.from_version.as_str(), config.version.as_str(), config.old_pid), ("1.1.4", "1.2.1", 4242));
    assert_eq!(config.timeout_ms, 300_000);
    assert_eq!(config.installer, None);
    assert_eq!(config.installer_args, None);
    assert_eq!(config.strings.failed, None);
    // Without the Tauri fields the error card falls back to `slow`, the WebView2 folder sits next to the runtime dir.
    assert_eq!(config.strings.failed_text(), "Aktualizacja trwa dłużej niż zwykle");
    assert!(config.webview_dir().ends_with("update\\webview2") || config.webview_dir().ends_with("update/webview2"));
    // Written back, every 1.1.x key keeps its name, order and value (the Tauri-only keys are left out when absent).
    let back = serde_json::to_value(&config).unwrap();
    let original: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(back, original);
    let keys = |v: &Value| v.as_object().unwrap().keys().cloned().collect::<Vec<_>>();
    let mut sorted_back = keys(&back);
    let mut sorted_original = keys(&original);
    sorted_back.sort();
    sorted_original.sort();
    assert_eq!(sorted_back, sorted_original);
}
