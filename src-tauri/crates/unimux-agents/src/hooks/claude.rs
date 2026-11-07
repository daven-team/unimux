//! The per-cell Claude Code settings file (port of src/main/hooks.ts `writeClaudeSettings`, `claudeHookSettings`,
//! `claudeHookForm`, `claudeExtendedHooks`, `claudeHookCommand` and `bypassProxyForHooks`, 1.1.4).
//!
//! A Claude cell starts with `--settings hooks/claude-<cell>.json` (the user's own settings.json is untouched) whose hooks
//! post to the hook server. The form follows the detected `claude --version`:
//! - `shell` (unknown versions and < 2.1.63): a curl command through Claude Code's hook shell (Git Bash on Windows);
//! - `http` (2.1.63+): Claude Code posts the payload itself (`type: "http"`, the token in a header); SessionStart accepts only
//!   command hooks, so it stays a curl command;
//! - `exec` (2.1.139+): as `http`, and SessionStart's curl starts without a shell (`args`).
//!
//! 2.1.78+ also gets the precise hooks (PermissionRequest, tool names, compaction, elicitation) in the http forms. The JSON is
//! byte-identical to 1.1.4's `JSON.stringify(settings, null, 2)` (test/golden/hook-settings.jsonl).

use std::io;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::HookServer;
use super::payload::js_space;

/// How a Claude cell's hooks reach the server (see the module doc).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ClaudeHookForm {
    Shell,
    Http,
    Exec,
}

impl ClaudeHookForm {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Shell => "shell",
            Self::Http => "http",
            Self::Exec => "exec",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "shell" => Some(Self::Shell),
            "http" => Some(Self::Http),
            "exec" => Some(Self::Exec),
            _ => None,
        }
    }
}

const HTTP_HOOKS_SINCE: [f64; 3] = [2.0, 1.0, 63.0];
const EXEC_HOOKS_SINCE: [f64; 3] = [2.0, 1.0, 139.0];
/// 2.1.78 is the first version with every event of the precise set (StopFailure 2.1.78).
const EXTENDED_HOOKS_SINCE: [f64; 3] = [2.0, 1.0, 78.0];

/// Seconds an http hook may take; the server answers at once, so this only bounds a hung app (curl has `-m 2`).
const HTTP_HOOK_TIMEOUT: u64 = 5;

/// `/^(\d+)\.(\d+)\.(\d+)/.exec(version?.trim() ?? '')` with `Number(...)` of each part (ASCII digits only, like `\d`
/// without the `u` flag; a part beyond 2^53 is the same float JS makes of it).
fn version_parts(version: Option<&str>) -> Option<[f64; 3]> {
    let v = version.unwrap_or("").trim_matches(js_space);
    let mut parts = [0.0; 3];
    let mut rest = v;
    for (i, part) in parts.iter_mut().enumerate() {
        let digits = rest.bytes().take_while(u8::is_ascii_digit).count();
        if digits == 0 {
            return None;
        }
        *part = rest[..digits].parse::<f64>().ok()?;
        rest = &rest[digits..];
        if i < 2 {
            rest = rest.strip_prefix('.')?;
        }
    }
    Some(parts)
}

/// `atLeast(version, min)`.
fn at_least(version: [f64; 3], min: [f64; 3]) -> bool {
    for i in 0..3 {
        if version[i] != min[i] {
            return version[i] > min[i];
        }
    }
    true
}

/// True when the Claude Code version gets the precise status hooks (PermissionRequest, tool names, compaction...).
pub fn claude_extended_hooks(version: Option<&str>) -> bool {
    version_parts(version).is_some_and(|v| at_least(v, EXTENDED_HOOKS_SINCE))
}

/// The hook form a Claude Code version supports; an unknown or unparsable version gets the curl commands.
pub fn claude_hook_form(version: Option<&str>) -> ClaudeHookForm {
    match version_parts(version) {
        None => ClaudeHookForm::Shell,
        Some(v) if at_least(v, EXEC_HOOKS_SINCE) => ClaudeHookForm::Exec,
        Some(v) if at_least(v, HTTP_HOOKS_SINCE) => ClaudeHookForm::Http,
        Some(_) => ClaudeHookForm::Shell,
    }
}

/// The curl command of one Claude hook. `--noproxy '*'`: the cell keeps the user's proxy variables, and a proxy must never
/// see (or swallow) the request to 127.0.0.1. POSIX quoting: Claude Code runs hook commands with a POSIX shell.
pub fn claude_hook_command(url: &str, with_body: bool) -> String {
    format!("curl -s --noproxy '*' -m 2 -X POST {}{url}", if with_body { "--data-binary @- " } else { "" })
}

/// Hooks that only say "still busy": fire-and-forget, so no tool call waits for a process start.
const ASYNC_EVENTS: [&str; 2] = ["busy", "subagent"];
/// Only Notification, Stop, StopFailure and SessionStart need their payload (JSON on stdin).
const WITH_BODY: [&str; 4] = ["notify", "stop", "fail", "session"];

/// Where a cell's hooks post: the curl URL (token in the path) and the http hook URL (token in a header).
pub struct HookTarget<'a> {
    pub url: &'a dyn Fn(&str) -> String,
    pub header_url: &'a dyn Fn(&str) -> String,
    pub token: &'a str,
}

impl<'a> HookTarget<'a> {
    /// A bare URL function (`claudeHookSettings(url)`): the curl form, header URL = URL, no token.
    pub fn bare(url: &'a dyn Fn(&str) -> String) -> Self {
        Self { url, header_url: url, token: "" }
    }
}

/// The `hooks` settings of a Claude cell (`claudeHookSettings`), keys in 1.1.4's order.
pub fn claude_hook_settings(target: &HookTarget<'_>, form: ClaudeHookForm, extended: bool) -> Value {
    let command = |event: &str| -> Value {
        let body = WITH_BODY.contains(&event);
        if form == ClaudeHookForm::Exec {
            let mut args: Vec<Value> = ["-s", "--noproxy", "*", "-m", "2", "-X", "POST"].iter().map(|s| json!(s)).collect();
            if body {
                args.push(json!("--data-binary"));
                args.push(json!("@-"));
            }
            args.push(json!((target.url)(event)));
            return json!({ "type": "command", "command": "curl", "args": args });
        }
        let mut hook = Map::new();
        hook.insert("type".into(), json!("command"));
        hook.insert("command".into(), json!(claude_hook_command(&(target.url)(event), body)));
        if ASYNC_EVENTS.contains(&event) {
            hook.insert("async".into(), json!(true));
        }
        Value::Object(hook)
    };
    let http = |event: &str| -> Value {
        json!({
            "type": "http",
            "url": (target.header_url)(event),
            "headers": { "Authorization": format!("Bearer {}", target.token) },
            "timeout": HTTP_HOOK_TIMEOUT,
        })
    };
    let hook = |event: &str| -> Value {
        let one = if form == ClaudeHookForm::Shell || event == "session" { command(event) } else { http(event) };
        json!([{ "hooks": [one] }])
    };
    // PreToolUse / PostToolUse / SubagentStop mark "still busy" (async as curl commands); Prompt, Stop, Notification,
    // StopFailure and SessionStart stay synchronous: they carry the status and their order counts.
    let mut hooks = Map::new();
    for (name, event) in [
        ("UserPromptSubmit", "prompt"),
        ("Stop", "stop"),
        ("Notification", "notify"),
        ("PreToolUse", "busy"),
        ("PostToolUse", "busy"),
        ("SubagentStop", "subagent"),
        ("SessionStart", "session"),
        ("StopFailure", "fail"),
    ] {
        hooks.insert(name.into(), hook(event));
    }
    if extended && form != ClaudeHookForm::Shell {
        // `{...basic, PreToolUse: ..., ...}`: replaced keys keep their place, new ones follow in this order.
        for (name, event) in [
            ("PreToolUse", "pre"),
            ("PostToolUse", "post"),
            ("PostToolUseFailure", "post"),
            ("PermissionDenied", "post"),
            ("PermissionRequest", "permission"),
            ("SubagentStart", "subagentstart"),
            ("PreCompact", "compact"),
            ("PostCompact", "compacted"),
            ("Elicitation", "elicit"),
            ("ElicitationResult", "elicited"),
        ] {
            hooks.insert(name.into(), hook(event));
        }
    }
    json!({ "hooks": hooks })
}

/// `JSON.stringify(value, null, 2)` (serde_json's pretty printer writes the same text: two spaces, `": "`, `[]` / `{}`).
pub fn stringify_pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).expect("a JSON value always serializes")
}

/// Writes `data` the way `writeFileSync(path, data, { mode: 0o600 })` does: created with 0600 on POSIX (an existing file
/// keeps its mode), truncated otherwise.
fn write_private(path: &Path, data: &[u8]) -> io::Result<()> {
    use std::io::Write as _;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    options.open(path)?.write_all(data)
}

impl HookServer {
    /// `writeClaudeSettings`: writes `<dir>/claude-<cell>.json` and returns its path. A fresh nonce first (hooks of the
    /// previous process are dropped). `claude_version` (the detected `claude --version`) picks the hook form unless `form`
    /// overrides it (http hooks found blocked); an unknown version keeps the curl commands every version runs.
    pub fn write_claude_settings(
        &self,
        dir: &Path,
        cell_id: &str,
        claude_version: Option<&str>,
        form: Option<ClaudeHookForm>,
    ) -> io::Result<PathBuf> {
        let form = form.unwrap_or_else(|| claude_hook_form(claude_version));
        std::fs::create_dir_all(dir)?;
        self.renew_nonce(cell_id);
        let path = dir.join(format!("claude-{cell_id}.json"));
        let url = |event: &str| self.url(cell_id, event);
        let header_url = |event: &str| self.header_url(cell_id, event);
        let target = HookTarget { url: &url, header_url: &header_url, token: self.token() };
        let text = stringify_pretty(&claude_hook_settings(&target, form, claude_extended_hooks(claude_version)));
        write_private(&path, text.as_bytes())?;
        Ok(path)
    }
}

/// `/^(https?|all)_proxy$/i` (case-insensitive for ASCII only, as a non-unicode JS regex).
fn is_proxy_var(key: &str) -> bool {
    ["http_proxy", "https_proxy", "all_proxy"].iter().any(|v| key.eq_ignore_ascii_case(v))
}

/// `bypassProxyForHooks`: Claude Code sends http hooks through the proxy of HTTP(S)_PROXY even to 127.0.0.1, so a cell with a
/// proxy gets 127.0.0.1 in NO_PROXY (in every spelling it already has, else NO_PROXY; on other platforms than win32 also
/// no_proxy). `platform` is Node's `process.platform`. New keys are appended (a JS object's key order).
pub fn bypass_proxy_for_hooks(env: &mut Vec<(String, String)>, platform: &str) {
    if !env.iter().any(|(k, v)| is_proxy_var(k) && !v.trim_matches(js_space).is_empty()) {
        return;
    }
    // `key.toLowerCase() === 'no_proxy'`: no non-ASCII letter lowercases to one of these ASCII letters.
    let mut keys: Vec<String> = env.iter().filter(|(k, _)| k.eq_ignore_ascii_case("no_proxy")).map(|(k, _)| k.clone()).collect();
    if keys.is_empty() {
        keys.push("NO_PROXY".into());
        if platform != "win32" {
            keys.push("no_proxy".into());
        }
    }
    for key in keys {
        let at = env.iter().position(|(k, _)| *k == key);
        let current = at.map_or("", |i| env[i].1.as_str());
        let list: Vec<&str> = current.split(',').map(|p| p.trim_matches(js_space)).filter(|p| !p.is_empty()).collect();
        if list.contains(&"127.0.0.1") || list.contains(&"*") {
            continue;
        }
        let mut next = list.join(",");
        if !next.is_empty() {
            next.push(',');
        }
        next.push_str("127.0.0.1");
        match at {
            Some(i) => env[i].1 = next,
            None => env.push((key, next)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target_url(event: &str) -> String {
        format!("http://127.0.0.1:5000/h/abc/cell/{event}/n0nce")
    }

    fn first_hook<'a>(settings: &'a Value, name: &str) -> &'a Value {
        &settings["hooks"][name][0]["hooks"][0]
    }

    // main-perf "Claude hook commands"
    #[test]
    fn never_go_through_a_proxy_like_the_codex_notify_hook() {
        assert_eq!(
            claude_hook_command(&target_url("stop"), true),
            "curl -s --noproxy '*' -m 2 -X POST --data-binary @- http://127.0.0.1:5000/h/abc/cell/stop/n0nce"
        );
        let argv = super::super::codex::codex_notify_argv("http://127.0.0.1:5000/h/abcdef01/cell/codex/abcdef01").unwrap();
        assert_eq!(&argv[..4], ["curl", "-s", "--noproxy", "*"]);
        let settings = claude_hook_settings(&HookTarget::bare(&target_url), ClaudeHookForm::Shell, false);
        for (name, _) in settings["hooks"].as_object().unwrap() {
            assert!(first_hook(&settings, name)["command"].as_str().unwrap().contains("--noproxy '*'"), "{name}");
        }
    }

    #[test]
    fn run_the_busy_hooks_in_the_background_and_keep_the_status_hooks_synchronous_with_their_payloads() {
        let settings = claude_hook_settings(&HookTarget::bare(&target_url), ClaudeHookForm::Shell, false);
        for name in ["PreToolUse", "PostToolUse", "SubagentStop"] {
            assert_eq!(first_hook(&settings, name)["async"], json!(true), "{name}");
            assert!(!first_hook(&settings, name)["command"].as_str().unwrap().contains("--data-binary"), "{name}");
        }
        for name in ["UserPromptSubmit", "Stop", "Notification", "SessionStart", "StopFailure"] {
            assert!(first_hook(&settings, name).get("async").is_none(), "{name}");
        }
        for name in ["Stop", "Notification", "SessionStart", "StopFailure"] {
            assert!(first_hook(&settings, name)["command"].as_str().unwrap().contains("--data-binary @-"), "{name}");
        }
        assert!(first_hook(&settings, "PreToolUse")["command"].as_str().unwrap().contains("/busy/"));
        assert!(first_hook(&settings, "SubagentStop")["command"].as_str().unwrap().contains("/subagent/"));
    }

    #[test]
    fn pick_the_hook_form_from_the_claude_code_version() {
        use ClaudeHookForm::*;
        for (v, want) in [
            (None, Shell),
            (Some("garbage"), Shell),
            (Some("2.1.62"), Shell),
            (Some("2.1.63"), Http),
            (Some("2.1.138"), Http),
            (Some("2.1.139"), Exec),
            (Some("2.1.309-beta.1"), Exec),
            (Some("3.0.0"), Exec),
            (Some("1.9.999"), Shell),
        ] {
            assert_eq!(claude_hook_form(v), want, "{v:?}");
        }
    }

    #[test]
    fn use_http_hooks_with_the_token_in_a_header_and_a_shell_free_curl_for_session_start() {
        let header = |event: &str| format!("http://127.0.0.1:5000/k/cell/{event}/n0nce");
        let target = HookTarget { url: &target_url, header_url: &header, token: "abc" };
        let exec = claude_hook_settings(&target, ClaudeHookForm::Exec, false);
        for name in ["UserPromptSubmit", "Stop", "Notification", "PreToolUse", "PostToolUse", "SubagentStop", "StopFailure"] {
            let h = first_hook(&exec, name);
            assert_eq!(h["type"], "http", "{name}");
            assert!(!h["url"].as_str().unwrap().contains("abc"), "{name}");
            assert_eq!(h["headers"], json!({ "Authorization": "Bearer abc" }), "{name}");
            assert_eq!(h["timeout"], json!(5), "{name}");
            assert!(h.get("async").is_none(), "{name}");
        }
        assert_eq!(
            first_hook(&exec, "SessionStart"),
            &json!({ "type": "command", "command": "curl", "args": ["-s", "--noproxy", "*", "-m", "2", "-X", "POST", "--data-binary", "@-", target_url("session")] })
        );
        let http = claude_hook_settings(&target, ClaudeHookForm::Http, false);
        assert_eq!(first_hook(&http, "SessionStart")["command"], json!(claude_hook_command(&target_url("session"), true)));
        assert_eq!(first_hook(&http, "Stop")["type"], "http");
    }

    #[test]
    fn keep_127_0_0_1_off_the_proxy_for_a_cell_that_has_one() {
        let run = |env: &[(&str, &str)], platform: &str| {
            let mut e: Vec<(String, String)> = env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
            bypass_proxy_for_hooks(&mut e, platform);
            e
        };
        let pairs = |env: &[(&str, &str)]| env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        assert_eq!(run(&[("PATH", "x")], "win32"), pairs(&[("PATH", "x")]));
        assert_eq!(
            run(&[("HTTPS_PROXY", "http://p:8080")], "win32"),
            pairs(&[("HTTPS_PROXY", "http://p:8080"), ("NO_PROXY", "127.0.0.1")])
        );
        assert_eq!(
            run(&[("http_proxy", "http://p")], "darwin"),
            pairs(&[("http_proxy", "http://p"), ("NO_PROXY", "127.0.0.1"), ("no_proxy", "127.0.0.1")])
        );
        assert_eq!(
            run(&[("HTTP_PROXY", "http://p"), ("no_proxy", "corp.local, .internal")], "win32"),
            pairs(&[("HTTP_PROXY", "http://p"), ("no_proxy", "corp.local,.internal,127.0.0.1")])
        );
        assert_eq!(run(&[("HTTP_PROXY", "http://p"), ("NO_PROXY", "localhost,127.0.0.1")], "win32")[1].1, "localhost,127.0.0.1");
        assert_eq!(run(&[("ALL_PROXY", "socks5://p"), ("NO_PROXY", "*")], "linux")[1].1, "*");
        assert_eq!(run(&[("HTTP_PROXY", "  ")], "win32"), pairs(&[("HTTP_PROXY", "  ")]));
    }

    #[test]
    fn version_parsing_follows_number_of_the_regex_groups() {
        assert_eq!(version_parts(Some(" 2.1.63 (Claude Code)")), Some([2.0, 1.0, 63.0]));
        assert_eq!(version_parts(Some("02.01.063")), Some([2.0, 1.0, 63.0]));
        assert_eq!(version_parts(Some("2.1")), None);
        assert_eq!(version_parts(Some("\u{662}.1.1")), None);
        assert_eq!(version_parts(None), None);
    }
}
