//! `{profile, opts}` as src/shared/profiles.ts takes them, read from JSON (the check build's `unimux --launch-line`, the
//! golden corpus). Fields of the wrong type count as absent.

use serde_json::Value;

use super::{LaunchOptions, McpLaunch, Profile, PromptFile, Shell};

fn s(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_string)
}

fn prompt(v: &Value, key: &str) -> Option<PromptFile> {
    let p = v.get(key).filter(|p| p.is_object())?;
    Some(PromptFile { file: s(p, "file").unwrap_or_default(), text: s(p, "text").unwrap_or_default() })
}

/// The profile (`cli`, `args`).
pub fn profile(v: &Value) -> Profile {
    Profile { cli: s(v, "cli").unwrap_or_default(), args: s(v, "args").unwrap_or_default() }
}

/// The launch options (`mode: 'resume'` resumes, anything else is a new conversation).
pub fn options(v: &Value) -> LaunchOptions {
    LaunchOptions {
        model: s(v, "model"),
        resume: v.get("mode").and_then(Value::as_str) == Some("resume"),
        session_id: s(v, "sessionId"),
        claude_settings_path: s(v, "claudeSettingsPath"),
        shell: v.get("shell").and_then(Value::as_str).and_then(Shell::parse).unwrap_or_default(),
        codex_notify_url: s(v, "codexNotifyUrl"),
        mcp: v.get("mcp").filter(|m| m.is_object()).map(|m| McpLaunch {
            url: s(m, "url").unwrap_or_default(),
            token_env: s(m, "tokenEnv"),
            claude_config_path: s(m, "claudeConfigPath"),
        }),
        initial_prompt: prompt(v, "initialPrompt"),
        resume_prompt: prompt(v, "resumePrompt"),
        system_prompt: s(v, "systemPrompt"),
        exit_url: s(v, "exitUrl"),
    }
}

/// The answer of `--launch-line` for `{profile, opts}`: `{"line": buildCliCommand, "launch": buildLaunchCommand}` (both
/// null for a shell profile), or `{"error": "MC_FAILED", "message"}` where the TS builder throws.
pub fn launch_line_answer(input: &Value) -> (Value, i32) {
    let profile = profile(input.get("profile").unwrap_or(&Value::Null));
    let opts = options(input.get("opts").unwrap_or(&Value::Null));
    let answer =
        super::build_cli_command(&profile, &opts).and_then(|line| Ok((line, super::build_launch_command(&profile, &opts)?)));
    match answer {
        Ok((line, launch)) => (serde_json::json!({ "line": line, "launch": launch }), 0),
        Err(message) => (serde_json::json!({ "error": "MC_FAILED", "message": message }), 1),
    }
}
