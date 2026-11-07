//! The Claude settings, the Codex notify overrides, the http hook fallback and the cell files against the 1.1.4 reference
//! (test/golden/hook-settings.jsonl, written by scripts/goldens-hooksettings.mjs from the real src/main/hooks.ts,
//! src/shared/codexHooks.ts, src/main/hookFallback.ts and src/main/cellFiles.ts). The settings file is compared byte for
//! byte (the random token and nonce of each side replaced by placeholders).

use std::path::PathBuf;

use serde_json::{Value, json};

use unimux_agents::cell_files::{Kind, cell_of_file};
use unimux_agents::hooks::HookServer;
use unimux_agents::hooks::claude::{
    ClaudeHookForm, HookTarget, bypass_proxy_for_hooks, claude_extended_hooks, claude_hook_command, claude_hook_form,
    claude_hook_settings, stringify_pretty,
};
use unimux_agents::hooks::codex::{codex_hook_overrides, codex_notify_argv};
use unimux_agents::hooks::encode_uri_component;
use unimux_agents::hooks::fallback::{claude_settings_files, glob_match, http_hook_url_allowed, load_fallback, save_fallback};
use unimux_core::js_json;

fn rows() -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/golden/hook-settings.jsonl");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    text.lines().filter(|l| !l.is_empty()).map(|l| js_json::parse(l).expect("golden row")).collect()
}

fn s(v: &Value) -> &str {
    v.as_str().expect("a string")
}

fn opt(v: &Value) -> Option<&str> {
    v.as_str()
}

fn pairs(v: &Value) -> Vec<(String, String)> {
    v.as_array().unwrap().iter().map(|p| (s(&p[0]).to_string(), s(&p[1]).to_string())).collect()
}

fn pairs_json(env: &[(String, String)]) -> Value {
    Value::Array(env.iter().map(|(k, v)| json!([k, v])).collect())
}

fn result(r: Result<Vec<String>, &'static str>) -> Value {
    match r {
        Ok(v) => json!(v),
        Err(e) => json!({ "error": e }),
    }
}

/// What the Rust port answers for one row (`writeClaudeSettings` and the file rows are checked on their own).
fn answer(row: &Value, scratch: &std::path::Path) -> Value {
    let args = &row["args"];
    match s(&row["fn"]) {
        "claudeHookForm" => json!(claude_hook_form(opt(&args[0])).as_str()),
        "claudeExtendedHooks" => json!(claude_extended_hooks(opt(&args[0]))),
        "claudeHookCommand" => json!(claude_hook_command(s(&args[0]), args[1].as_bool().unwrap())),
        "claudeHookSettings" => {
            let t = &args[0];
            let (cell, token, nonce) = (s(&t["cell"]), s(&t["token"]), s(&t["nonce"]));
            let port = t["port"].as_u64().unwrap();
            let url = |event: &str| format!("http://127.0.0.1:{port}/h/{token}/{}/{event}/{nonce}", encode_uri_component(cell));
            let header_url = |event: &str| url(event).replacen(&format!("/h/{token}/"), "/k/", 1);
            let form = ClaudeHookForm::parse(s(&args[1])).unwrap();
            let settings = if t["bare"] == json!(true) {
                claude_hook_settings(&HookTarget::bare(&url), ClaudeHookForm::Shell, false)
            } else {
                claude_hook_settings(&HookTarget { url: &url, header_url: &header_url, token }, form, args[2].as_bool().unwrap())
            };
            json!(stringify_pretty(&settings))
        }
        "bypassProxyForHooks" => {
            let mut env = pairs(&args[0]);
            bypass_proxy_for_hooks(&mut env, s(&args[1]));
            pairs_json(&env)
        }
        "codexNotifyArgv" => result(codex_notify_argv(s(&args[0]))),
        "codexHookOverrides" => result(codex_hook_overrides(s(&args[0]))),
        "globMatch" => json!(glob_match(s(&args[0]), s(&args[1]))),
        "httpHookUrlAllowed" => {
            let texts: Vec<Option<String>> = args[0].as_array().unwrap().iter().map(|t| t.as_str().map(str::to_string)).collect();
            json!(http_hook_url_allowed(&texts, s(&args[1])))
        }
        "claudeSettingsFiles" => json!(claude_settings_files(s(&args[0]), s(&args[1]), &pairs(&args[2]), s(&args[3]))),
        "hookFallbackFile.load" => {
            let file = scratch.join("claude-hook-fallback.json");
            let _ = std::fs::remove_file(&file);
            if let Some(text) = args[0].as_str() {
                std::fs::write(&file, text).unwrap();
            }
            json!(load_fallback(&file))
        }
        "hookFallbackFile.save" => {
            let file = scratch.join("claude-hook-fallback.json");
            save_fallback(&file, s(&args[0])).unwrap();
            json!(std::fs::read_to_string(&file).unwrap())
        }
        "cellOfFile" => json!(cell_of_file(Kind::parse(s(&args[0])).unwrap(), s(&args[1]))),
        other => panic!("unknown golden fn {other}"),
    }
}

#[test]
fn the_helpers_answer_like_the_ts_reference() {
    let scratch = tempfile::tempdir().unwrap();
    let mut checked = std::collections::BTreeMap::<String, usize>::new();
    let mut failures = Vec::new();
    for row in rows() {
        let name = s(&row["fn"]).to_string();
        if name == "writeClaudeSettings" {
            continue;
        }
        let got = answer(&row, scratch.path());
        if got != row["out"] {
            failures.push(format!("{name} {}: want {} got {got}", row["args"], row["out"]));
        }
        *checked.entry(name).or_default() += 1;
    }
    assert!(failures.is_empty(), "{} differences:\n{}", failures.len(), failures.join("\n"));
    for name in [
        "claudeHookForm",
        "claudeExtendedHooks",
        "claudeHookCommand",
        "claudeHookSettings",
        "bypassProxyForHooks",
        "codexNotifyArgv",
        "codexHookOverrides",
        "globMatch",
        "httpHookUrlAllowed",
        "claudeSettingsFiles",
        "hookFallbackFile.load",
        "hookFallbackFile.save",
        "cellOfFile",
    ] {
        assert!(checked.get(name).copied().unwrap_or(0) > 0, "no rows for {name}: {checked:?}");
    }
}

#[test]
fn the_settings_file_is_byte_identical_to_the_one_1_1_4_writes() {
    let dir = tempfile::tempdir().unwrap();
    let server = HookServer::new();
    let mut count = 0;
    for row in rows().iter().filter(|r| r["fn"] == "writeClaudeSettings") {
        let args = &row["args"];
        let cell = s(&args[0]);
        let form = args[2].as_str().map(|f| ClaudeHookForm::parse(f).unwrap());
        let before = server.nonce(cell);
        let path = server.write_claude_settings(dir.path(), cell, opt(&args[1]), form).unwrap();
        let nonce = server.nonce(cell).unwrap();
        assert_ne!(before.as_deref(), Some(nonce.as_str()), "every write renews the nonce");
        let text = std::fs::read_to_string(&path).unwrap().replace(server.token(), "<token>").replace(&nonce, "<nonce>");
        assert_eq!(path.file_name().unwrap().to_str().unwrap(), s(&row["out"]["name"]));
        assert_eq!(text, s(&row["out"]["text"]), "{args}");
        count += 1;
    }
    assert_eq!(count, 3 * 7 * 4);
}
