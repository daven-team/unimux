//! The line typed into a cell's shell to start its agent (P4; port of src/shared/profiles.ts `buildCliCommand` /
//! `buildLaunchCommand`, src/shared/termReset.ts `withResetTail`, src/shared/startScreen.ts `startClear` and
//! src/shared/delegation.ts `shellSafeText` / `coordinatorSystemRules`). Byte-identical to 1.1.4 (test/golden/launch.jsonl).
//!
//! - [`team`]: the startup / resume prompts of an AI team agent (src/shared/teamPrompts.ts);
//! - [`mcp_config`]: how a cell's MCP token reaches its agent (src/main/mcpCellConfig.ts);
//! - [`direct`]: Windows: the same CLI started as the terminal's own process, without the shell (falls back to the line);
//! - [`json`]: `{profile, opts}` as the TS builder takes them (the check build's `--launch-line`, the goldens).

pub mod direct;
pub mod json;
pub mod mcp_config;
pub mod team;

use std::fmt::Write as _;

use unimux_core::utf16::{is_js_space_char, js_trim};

use crate::hooks::codex::codex_hook_overrides;

/// `ShellKind` of src/shared/types.ts as the launch line needs it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Shell {
    /// PowerShell 7 (also what an absent shell means to the TS helpers).
    #[default]
    Pwsh,
    Powershell,
    Cmd,
    Zsh,
    Bash,
}

impl Shell {
    pub fn parse(name: &str) -> Option<Self> {
        Some(match name {
            "pwsh" => Self::Pwsh,
            "powershell" => Self::Powershell,
            "cmd" => Self::Cmd,
            "zsh" => Self::Zsh,
            "bash" => Self::Bash,
            _ => return None,
        })
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pwsh => "pwsh",
            Self::Powershell => "powershell",
            Self::Cmd => "cmd",
            Self::Zsh => "zsh",
            Self::Bash => "bash",
        }
    }

    fn posix(self) -> bool {
        matches!(self, Self::Zsh | Self::Bash)
    }
}

/// How long Codex waits for one unimux MCP tool call (its default is 60 s).
pub const MCP_TOOL_TIMEOUT_SEC: u32 = 180;

/// PowerShell single-quoted literal.
pub fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// POSIX shell single-quoted literal (bash / zsh).
pub fn posix_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

/// Quotes a path for the cell's shell (cmd has no single-quote strings).
pub fn shell_quote(s: &str, shell: Shell) -> String {
    match shell {
        Shell::Cmd => format!("\"{s}\""),
        Shell::Zsh | Shell::Bash => posix_quote(s),
        _ => ps_quote(s),
    }
}

/// Characters no shell may see inside the quoted rules (cmd expands % and !, the others end or change a quoted argument).
fn unsafe_char(c: char) -> bool {
    matches!(c, '"' | '\'' | '`' | '%' | '^' | '!' | '&' | '|' | '<' | '>' | '\r' | '\n' | '\t' | '$' | '\\')
}

/// `shellSafeText`: every run of unsafe characters becomes a space, runs of spaces one space, then JS `trim`.
pub fn shell_safe_text(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_unsafe = false;
    for c in text.chars() {
        if unsafe_char(c) {
            if !in_unsafe {
                out.push(' ');
            }
            in_unsafe = true;
        } else {
            out.push(c);
            in_unsafe = false;
        }
    }
    let mut squeezed = String::with_capacity(out.len());
    let mut space = false;
    for c in out.chars() {
        if c == ' ' {
            if !space {
                squeezed.push(' ');
            }
            space = true;
        } else {
            squeezed.push(c);
            space = false;
        }
    }
    js_trim(&squeezed).to_string()
}

/// `coordinatorSystemRules(delegationOf(state))`: the coordinator's delegation rules for its system instructions at launch;
/// None in "ask" mode. `delegation` is the raw `settings.delegation` (normalized here).
pub fn coordinator_system_rules(delegation: Option<&serde_json::Value>) -> Option<String> {
    let d = unimux_state::normalize::settings::normalize_delegation(delegation);
    if d["mode"].as_str() != Some("auto") {
        return None;
    }
    let max = match &d["maxAgents"] {
        serde_json::Value::Number(n) => unimux_core::js_json::number_text(n),
        _ => "4".into(),
    };
    Some(shell_safe_text(&format!(
        "unimux delegation rules for you as the coordinator of this unimux team: when a task is large and splits into independent parts, \
         delegate on your own without waiting to be asked: start a team with the unimux MCP tool create_grid, or give parts to workers that already exist with create_task. \
         Use at most {max} agents at once. Do small tasks yourself. Never create agents only to wait on them. \
         Always tell the user what you delegated, to which agents and why, then follow the tasks with wait_for."
    )))
}

/// The profile fields the launch line reads (`Profile` of src/shared/types.ts).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Profile {
    /// 'claude', 'codex', 'shell' (anything else builds no line).
    pub cli: String,
    /// Extra CLI arguments, typed verbatim in the selected shell's syntax.
    pub args: String,
}

/// A prompt file and its text (`{file, text}`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct PromptFile {
    pub file: String,
    pub text: String,
}

/// The MCP part of a launch (`LaunchOptions['mcp']`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct McpLaunch {
    pub url: String,
    /// Codex: the variable the token is read from.
    pub token_env: Option<String>,
    /// Claude: the per-cell `--mcp-config` file.
    pub claude_config_path: Option<String>,
}

/// `LaunchOptions` of src/shared/profiles.ts. Empty strings count as absent where the TS code tests truthiness.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchOptions {
    pub model: Option<String>,
    /// True for 'resume', false for 'new'.
    pub resume: bool,
    pub session_id: Option<String>,
    pub claude_settings_path: Option<String>,
    pub shell: Shell,
    pub codex_notify_url: Option<String>,
    pub mcp: Option<McpLaunch>,
    pub initial_prompt: Option<PromptFile>,
    pub resume_prompt: Option<PromptFile>,
    pub system_prompt: Option<String>,
    pub exit_url: Option<String>,
}

fn truthy(s: &Option<String>) -> Option<&str> {
    s.as_deref().filter(|s| !s.is_empty())
}

/// Quotes the system instructions as one argument of the cell's shell (plain words only).
fn system_arg(text: &str, shell: Shell) -> String {
    if shell == Shell::Cmd { format!("\"{}\"", shell_safe_text(text)) } else { shell_quote(&shell_safe_text(text), shell) }
}

/// JS `s.replace(/\s+/g, ' ')`.
fn squeeze_js_space(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut space = false;
    for c in s.chars() {
        if is_js_space_char(c) {
            if !space {
                out.push(' ');
            }
            space = true;
        } else {
            out.push(c);
            space = false;
        }
    }
    out
}

fn prompt_arg(p: &PromptFile, shell: Shell) -> String {
    if shell.posix() {
        return format!("\"$(cat {})\"", posix_quote(&p.file));
    }
    if shell == Shell::Cmd {
        let text = squeeze_js_space(&p.text).replace('"', "'");
        return format!("\"{}\"", js_trim(&text));
    }
    format!("(Get-Content -Raw -Encoding utf8 -LiteralPath {})", ps_quote(&p.file))
}

/// Matches `(?:--model(?:=|\s+)|-m\s+)(?:"[^"]*"|'[^']*'|[^\s]+)` at the start of `s`; the length of the match.
fn model_flag_at(s: &str) -> Option<usize> {
    let after_flag = if let Some(rest) = s.strip_prefix("--model") {
        if let Some(r) = rest.strip_prefix('=') {
            r
        } else {
            let t = rest.trim_start_matches(is_js_space_char);
            if t.len() == rest.len() {
                return None;
            }
            t
        }
    } else {
        let rest = s.strip_prefix("-m")?;
        let t = rest.trim_start_matches(is_js_space_char);
        if t.len() == rest.len() {
            return None;
        }
        t
    };
    let value = |q: char| -> Option<usize> {
        let body = after_flag.strip_prefix(q)?;
        body.find(q).map(|end| q.len_utf8() * 2 + end)
    };
    let len = value('"').or_else(|| value('\'')).or_else(|| {
        let n = after_flag.find(is_js_space_char).unwrap_or(after_flag.len());
        (n > 0).then_some(n)
    })?;
    Some(s.len() - after_flag.len() + len)
}

/// `args.replace(/(?:^|\s)(?:--model(?:=|\s+)|-m\s+)(?:"[^"]*"|'[^']*'|[^\s]+)/g, ' ')`: a cell model override removes the
/// profile's own model flag.
fn strip_model_flags(args: &str) -> String {
    let mut out = String::with_capacity(args.len());
    let mut i = 0;
    while i < args.len() {
        let rest = &args[i..];
        // `^` (only at 0) is tried first, then one whitespace character.
        let hit = if i == 0 { model_flag_at(rest) } else { None }.or_else(|| {
            let c = rest.chars().next()?;
            if !is_js_space_char(c) {
                return None;
            }
            model_flag_at(&rest[c.len_utf8()..]).map(|n| n + c.len_utf8())
        });
        match hit {
            Some(n) => {
                out.push(' ');
                i += n;
            }
            None => {
                let c = rest.chars().next().expect("non-empty");
                out.push(c);
                i += c.len_utf8();
            }
        }
    }
    out
}

/// `/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/`.
fn valid_model(model: &str) -> bool {
    let b = model.as_bytes();
    !b.is_empty()
        && b.len() <= 128
        && b[0].is_ascii_alphanumeric()
        && b[1..].iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b':' | b'/' | b'-'))
}

/// The error `buildCliCommand` throws for a model name that is not one.
pub const INVALID_MODEL: &str = "Invalid model name.";

/// `buildCliCommand`: the agent's own command line; Ok(None) for plain shell profiles. Err for an invalid model name or a
/// Codex notify URL that is not one of ours.
pub fn build_cli_command(profile: &Profile, opts: &LaunchOptions) -> Result<Option<String>, &'static str> {
    let shell = opts.shell;
    let model = truthy(&opts.model);
    let args = match model {
        Some(_) => js_trim(&strip_model_flags(&profile.args)).to_string(),
        None => js_trim(&profile.args).to_string(),
    };
    let session = truthy(&opts.session_id);
    let mut parts: Vec<String> = Vec::new();
    // 1.1.3: Claude Code takes several files after --mcp-config, so a prompt after the options would be read as one more
    // config file: the prompt goes first.
    let prompt = if !opts.resume {
        opts.initial_prompt.as_ref()
    } else if session.is_some() {
        opts.resume_prompt.as_ref()
    } else {
        None
    };
    let prompt = prompt.filter(|p| !js_trim(&p.text).is_empty());
    let claude_prompt = (profile.cli == "claude").then(|| prompt.map(|p| prompt_arg(p, shell))).flatten();
    let system = truthy(&opts.system_prompt).map(shell_safe_text).unwrap_or_default();
    match profile.cli.as_str() {
        "claude" => {
            parts.push("claude".into());
            if let Some(p) = &claude_prompt {
                parts.push(p.clone());
            }
            if let Some(id) = session {
                parts.push(if opts.resume { "--resume" } else { "--session-id" }.into());
                parts.push(id.into());
            }
            if let Some(path) = truthy(&opts.claude_settings_path) {
                parts.push("--settings".into());
                parts.push(shell_quote(path, shell));
            }
            if let Some(path) = opts.mcp.as_ref().and_then(|m| m.claude_config_path.as_deref()).filter(|p| !p.is_empty()) {
                parts.push("--mcp-config".into());
                parts.push(shell_quote(path, shell));
            }
            // One argument, never variadic: it may stand before --mcp-config.
            if !system.is_empty() {
                parts.push("--append-system-prompt".into());
                parts.push(system_arg(&system, shell));
            }
        }
        "codex" => {
            parts.push("codex".into());
            if opts.resume
                && let Some(id) = session
            {
                parts.push("resume".into());
                parts.push(id.into());
            }
            if let Some(url) = truthy(&opts.codex_notify_url) {
                // Single-quoted TOML inside; cmd gets double quotes around the whole override.
                for o in codex_hook_overrides(url)? {
                    parts.push("-c".into());
                    parts.push(if shell == Shell::Cmd { format!("\"{o}\"") } else { shell_quote(&o, shell) });
                }
            } else {
                parts.push("-c".into());
                parts.push("tui.notifications=true".into());
            }
            if let Some(mcp) = &opts.mcp
                && let Some(token_env) = mcp.token_env.as_deref().filter(|t| !t.is_empty())
            {
                for (key, value) in [("url", mcp.url.as_str()), ("bearer_token_env_var", token_env)] {
                    let mut setting = format!("mcp_servers.unimux.{key}=");
                    unimux_core::js_json::write_string(&mut setting, value);
                    parts.push("-c".into());
                    // cmd does not interpret TOML single quotes; these generated values contain no spaces / apostrophes.
                    parts.push(if shell == Shell::Cmd {
                        format!("mcp_servers.unimux.{key}='{value}'")
                    } else {
                        shell_quote(&setting, shell)
                    });
                }
                parts.push("-c".into());
                parts.push(format!("mcp_servers.unimux.tool_timeout_sec={MCP_TOOL_TIMEOUT_SEC}"));
            }
            if !system.is_empty() {
                parts.push("-c".into());
                parts.push(if shell == Shell::Cmd {
                    format!("\"developer_instructions='{system}'\"")
                } else {
                    shell_quote(&format!("developer_instructions='{system}'"), shell)
                });
            }
        }
        _ => return Ok(None),
    }
    if !args.is_empty() {
        parts.push(args);
    }
    if let Some(model) = model {
        if !valid_model(model) {
            return Err(INVALID_MODEL);
        }
        parts.push("--model".into());
        parts.push(shell_quote(model, shell));
    }
    if claude_prompt.is_none()
        && profile.cli != "claude"
        && let Some(p) = prompt
    {
        parts.push(prompt_arg(p, shell));
    }
    Ok(Some(parts.join(" ")))
}

/// `startClear`: the clear that runs right before the CLI (the start card covers the launch line meanwhile).
pub fn start_clear(shell: Shell) -> &'static str {
    match shell {
        Shell::Cmd => "cls & ",
        Shell::Zsh | Shell::Bash => "printf '\\033[H\\033[2J\\033[3J'; ",
        _ => "Clear-Host; ",
    }
}

/// 1000/1002/1003 mouse tracking, 1005/1006/1015 mouse encodings, 1004 focus reports, 2004 bracketed paste.
pub const INPUT_MODE_PARAMS: [u32; 8] = [1000, 1002, 1003, 1005, 1006, 1015, 1004, 2004];

fn params(win32: bool) -> String {
    INPUT_MODE_PARAMS.iter().filter(|m| !win32 || **m != 1004).map(u32::to_string).collect::<Vec<_>>().join(";")
}

/// The PowerShell expression that writes the Windows input mode reset (1004 is ConPTY's and never cleared).
fn ps_esc() -> String {
    format!("[char]27+'[?{}l'+[char]27+'[<u'", params(true))
}

/// `EXIT_URL`: `/^http:\/\/127\.0\.0\.1:\d{1,5}\/x\/[\w-]{1,64}\/[a-f0-9]{8,64}$/`, the only URLs the tail posts to.
pub fn is_exit_url(url: &str) -> bool {
    fn run(s: &str, min: usize, max: usize, ok: impl Fn(u8) -> bool) -> Option<&str> {
        let n = s.bytes().take_while(|b| ok(*b)).count();
        (min..=max).contains(&n).then(|| &s[n..])
    }
    (|| {
        let s = url.strip_prefix("http://127.0.0.1:")?;
        let s = run(s, 1, 5, |b| b.is_ascii_digit())?.strip_prefix("/x/")?;
        let s = run(s, 1, 64, |b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')?.strip_prefix('/')?;
        run(s, 8, 64, |b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)).map(str::is_empty)
    })()
    .unwrap_or(false)
}

/// `withResetTail`: the typed line that runs the CLI and then switches the terminal input modes off however the CLI ended
/// (PowerShell try/finally, cmd `&`, POSIX `trap : INT`); with an exit URL it also posts the CLI's exit code to the hook
/// server. A URL that is not an exit URL of ours is ignored.
pub fn with_reset_tail(cli: &str, shell: Shell, exit_url: Option<&str>) -> String {
    let url = exit_url.filter(|u| is_exit_url(u));
    let mut out = String::new();
    match shell {
        Shell::Cmd => {
            let post = url
                .map(|u| format!("call curl.exe -s --noproxy * -m 2 -X POST {u}/%^errorlevel% >nul 2>&1 & "))
                .unwrap_or_default();
            let _ = write!(
                out,
                "{cli} & {post}powershell -NoProfile -NonInteractive -Command \"[Console]::Write({})\" 2>nul",
                ps_esc()
            );
        }
        Shell::Zsh | Shell::Bash => {
            let reset = format!("printf '\\033[?{}l\\033[<u'", params(false));
            match url {
                None => {
                    let _ = write!(out, "trap : INT; {cli}; {reset}; trap - INT");
                }
                Some(u) => {
                    let _ = write!(
                        out,
                        "trap : INT; {cli}; __mc_exit=$?; curl -s --noproxy '*' -m 2 -X POST '{u}/'$__mc_exit >/dev/null 2>&1; {reset}; trap - INT"
                    );
                }
            }
        }
        _ => match url {
            None => {
                let _ = write!(
                    out,
                    "try {{ {cli} }} finally {{ $global:__unimuxExit = $LASTEXITCODE; [Console]::Write({}) }}",
                    ps_esc()
                );
            }
            Some(u) => {
                let _ = write!(
                    out,
                    "try {{ {cli} }} finally {{ $__mcExit = $LASTEXITCODE; curl.exe -s --noproxy '*' -m 2 -X POST \"{u}/$__mcExit\" *> $null; [Console]::Write({}); $global:LASTEXITCODE = $__mcExit; $global:__unimuxExit = $__mcExit }}",
                    ps_esc()
                );
            }
        },
    }
    out
}

/// `buildLaunchCommand`: the clear, the CLI command, the reset tail. Ok(None) for shell profiles.
pub fn build_launch_command(profile: &Profile, opts: &LaunchOptions) -> Result<Option<String>, &'static str> {
    let Some(command) = build_cli_command(profile, opts)? else { return Ok(None) };
    let exit = truthy(&opts.exit_url);
    Ok(Some(format!("{}{}", start_clear(opts.shell), with_reset_tail(&command, opts.shell, exit))))
}

/// 1.1.4 `userCodexInstructions`: the user's Codex config (`$CODEX_HOME/config.toml`, else `<home>/.codex/config.toml`)
/// sets its own top-level `developer_instructions`, which a coordinator's rules must not replace.
pub fn codex_config_sets_instructions(text: &str) -> bool {
    // `text.split(/^\s*\[/m)[0]`: everything before the first line that (after whitespace) opens a table.
    let line_starts = || {
        std::iter::once(0).chain(
            text.char_indices()
                .filter(|(_, c)| matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}'))
                .map(|(i, c)| i + c.len_utf8()),
        )
    };
    let after_space = |p: usize| text[p..].trim_start_matches(is_js_space_char);
    let cut = line_starts().find(|p| after_space(*p).starts_with('[')).unwrap_or(text.len());
    let top = &text[..cut];
    // `/^\s*developer_instructions\s*=/m` on that part.
    line_starts().filter(|p| *p <= top.len()).any(|p| {
        let rest = top[p..].trim_start_matches(is_js_space_char);
        rest.strip_prefix("developer_instructions").is_some_and(|r| r.trim_start_matches(is_js_space_char).starts_with('='))
    })
}

#[cfg(test)]
mod tests;
