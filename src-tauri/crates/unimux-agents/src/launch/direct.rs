//! Windows: the agent CLI started as the terminal's own process instead of typed into the cell's shell. No shell idles under
//! the agent any more (Windows PowerShell 5.1 with its prompt hook keeps about 60 MB private per cell); the shell starts in
//! the same terminal once the CLI ended (unimux-pty manager.rs `SpawnRequest::agent`).
//!
//! The CLI gets the arguments the launch line ([`build_cli_command`]) gives it through the shell, unquoted, in the same
//! order, and the cell's environment as it is. It is found the way the cell's shell finds it on the cell's PATH:
//! - a native `.exe` (the native installer's `%USERPROFILE%\.local\bin\claude.exe`) starts directly;
//! - a `.cmd` / `.bat` shim (npm) starts through `cmd.exe /s /c`, as PowerShell runs it too;
//!
//! and anything else falls back to the launch line typed into the shell: a PowerShell script (`.ps1`) that is not the
//! sibling of an npm `.cmd` shim, another kind of program, a CLI that is not on the PATH (a profile may add it, or an alias),
//! a CLI the shell would take from the working folder or a relative PATH entry (never trusted for a direct start),
//! profile arguments in shell syntax (quotes, variables, operators: only the shell knows what they mean), an argument cmd.exe
//! would expand (`%`, `!`) or cannot pass (a line break, a double quote) on the way through a shim, a command line that is too
//! long, and the POSIX shells.

use std::path::{Path, PathBuf};

use unimux_core::utf16::{is_js_space_char, js_trim};

use super::{
    LaunchOptions, MCP_TOOL_TIMEOUT_SEC, Profile, PromptFile, Shell, shell_safe_text, squeeze_js_space, strip_model_flags,
    truthy, valid_model,
};
use crate::hooks::codex::codex_hook_overrides;

/// The longest command line CreateProcess takes (32767 with the terminating NUL), with room to spare.
const MAX_LINE: usize = 32_000;
/// The longest line cmd.exe takes (8191).
const MAX_CMD_LINE: usize = 8_000;

/// Characters a profile argument may consist of to mean the same in every shell (no quoting, no variables, no operators, no
/// splatting, no globbing): the profile's own arguments are typed verbatim in the shell's syntax.
fn plain_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '/' | ':' | '=' | '+' | '\\')
}

/// The profile's own arguments as the shell splits them, or None when they use any shell syntax.
fn plain_words(args: &str) -> Option<Vec<String>> {
    args.split(is_js_space_char).filter(|w| !w.is_empty()).map(|w| w.chars().all(plain_char).then(|| w.to_string())).collect()
}

/// The prompt as the CLI receives it: PowerShell reads the file (`Get-Content -Raw`), cmd passes the text inline with its
/// whitespace squeezed and double quotes turned into single ones (`prompt_arg`).
fn prompt_value(p: &PromptFile, shell: Shell) -> String {
    if shell == Shell::Cmd { js_trim(&squeeze_js_space(&p.text).replace('"', "'")).to_string() } else { p.text.clone() }
}

/// The arguments after the CLI's name that the launch line gives it, unquoted (the values each shell's quoting stands for),
/// or None when the launch line must stay: a plain shell profile, a POSIX shell, profile arguments in shell syntax, an
/// invalid model or notify URL.
pub fn cli_args(profile: &Profile, opts: &LaunchOptions) -> Option<Vec<String>> {
    let shell = opts.shell;
    if !matches!(shell, Shell::Pwsh | Shell::Powershell | Shell::Cmd) {
        return None;
    }
    let model = truthy(&opts.model);
    let args = match model {
        Some(_) => js_trim(&strip_model_flags(&profile.args)).to_string(),
        None => js_trim(&profile.args).to_string(),
    };
    let profile_args = plain_words(&args)?;
    if model.is_some_and(|m| !valid_model(m)) {
        return None;
    }
    let session = truthy(&opts.session_id);
    let prompt = if !opts.resume {
        opts.initial_prompt.as_ref()
    } else if session.is_some() {
        opts.resume_prompt.as_ref()
    } else {
        None
    };
    let prompt = prompt.filter(|p| !js_trim(&p.text).is_empty());
    let system = truthy(&opts.system_prompt).map(shell_safe_text).unwrap_or_default();
    let mut out: Vec<String> = Vec::new();
    let mut push = |a: &str| out.push(a.to_string());
    match profile.cli.as_str() {
        "claude" => {
            // The prompt first (--mcp-config takes several files): see build_cli_command.
            if let Some(p) = prompt {
                push(&prompt_value(p, shell));
            }
            if let Some(id) = session {
                push(if opts.resume { "--resume" } else { "--session-id" });
                push(id);
            }
            if let Some(path) = truthy(&opts.claude_settings_path) {
                push("--settings");
                push(path);
            }
            if let Some(path) = opts.mcp.as_ref().and_then(|m| m.claude_config_path.as_deref()).filter(|p| !p.is_empty()) {
                push("--mcp-config");
                push(path);
            }
            if !system.is_empty() {
                push("--append-system-prompt");
                push(&system);
            }
        }
        "codex" => {
            if opts.resume
                && let Some(id) = session
            {
                push("resume");
                push(id);
            }
            if let Some(url) = truthy(&opts.codex_notify_url) {
                for o in codex_hook_overrides(url).ok()? {
                    push("-c");
                    push(&o);
                }
            } else {
                push("-c");
                push("tui.notifications=true");
            }
            if let Some(mcp) = &opts.mcp
                && let Some(token_env) = mcp.token_env.as_deref().filter(|t| !t.is_empty())
            {
                for (key, value) in [("url", mcp.url.as_str()), ("bearer_token_env_var", token_env)] {
                    push("-c");
                    // cmd typed the TOML literal string, the PowerShells a JSON (= TOML basic) string.
                    if shell == Shell::Cmd {
                        push(&format!("mcp_servers.unimux.{key}='{value}'"));
                    } else {
                        let mut setting = format!("mcp_servers.unimux.{key}=");
                        unimux_core::js_json::write_string(&mut setting, value);
                        push(&setting);
                    }
                }
                push("-c");
                push(&format!("mcp_servers.unimux.tool_timeout_sec={MCP_TOOL_TIMEOUT_SEC}"));
            }
            if !system.is_empty() {
                push("-c");
                push(&format!("developer_instructions='{system}'"));
            }
        }
        _ => return None,
    }
    out.extend(profile_args);
    if let Some(model) = model {
        out.push("--model".into());
        out.push(model.into());
    }
    if profile.cli != "claude"
        && let Some(p) = prompt
    {
        out.push(prompt_value(p, shell));
    }
    Some(out)
}

/// The program the cell's shell would run for the CLI's name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CliProgram {
    /// A native executable: started directly.
    Exe(PathBuf),
    /// A batch shim (npm's `.cmd`): started through cmd.exe.
    Batch(PathBuf),
}

/// `env[key]` with Windows' case-insensitive names (the first match).
fn env_var<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    env.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
}

/// The extensions PATHEXT names, lower case, in order.
fn path_exts(env: &[(String, String)]) -> Vec<String> {
    env_var(env, "PATHEXT")
        .filter(|v| !v.trim().is_empty())
        .unwrap_or(".COM;.EXE;.BAT;.CMD")
        .split(';')
        .map(|e| e.trim().to_ascii_lowercase())
        .filter(|e| e.len() >= 2 && e.starts_with('.'))
        .collect()
}

/// The folders a lookup searches, in order, each with whether a program found there may be started directly: cmd.exe looks
/// into its current folder first, then come the PATH entries (quotes around one removed, empty ones skipped). The working
/// folder (a project, possibly someone else's) and relative PATH entries (they resolve against it) are never trusted: a hit
/// there keeps the typed launch line, so the program is never picked from an untrusted search path here.
fn search_dirs(env: &[(String, String)], shell: Shell, cwd: &Path) -> Vec<(PathBuf, bool)> {
    let mut dirs = Vec::new();
    if shell == Shell::Cmd {
        dirs.push((cwd.to_path_buf(), false));
    }
    for entry in env_var(env, "PATH").unwrap_or("").split(';') {
        let entry = entry.trim().trim_matches('"').trim();
        if entry.is_empty() {
            continue;
        }
        let dir = PathBuf::from(entry);
        // `C:\x` and `\\server\share\x` only: not `x`, `.\x` or a drive-relative `C:x` (looked up where the shell would,
        // in the cell's folder, only to see that the shell would run something from there).
        if dir.is_absolute() {
            dirs.push((dir, true));
        } else {
            dirs.push((cwd.join(dir), false));
        }
    }
    dirs
}

/// An npm (cmd-shim) `.cmd`: its `.ps1` sibling, which PowerShell would pick, starts the same script.
fn is_npm_shim(file: &Path) -> bool {
    std::fs::read(file).is_ok_and(|b| String::from_utf8_lossy(&b).contains("%dp0%"))
}

/// What the cell's shell runs for `name` (the CLI's command), or None when that is not certain or not a program this module
/// can start the same way: PowerShell picks a `.ps1` before the PATHEXT programs of the same folder, cmd.exe takes the first
/// PATHEXT match and searches its current folder first. Only `.exe` and `.cmd` / `.bat` qualify; a `.ps1` qualifies only as
/// the sibling of an npm `.cmd` shim (both start the same script), and a folder that holds an `.exe` next to a `.ps1` is
/// ambiguous. A first match in the working folder or a relative PATH entry is never started directly (see [`search_dirs`]).
pub fn find_cli(name: &str, shell: Shell, env: &[(String, String)], cwd: &Path) -> Option<CliProgram> {
    if !matches!(shell, Shell::Pwsh | Shell::Powershell | Shell::Cmd) {
        return None;
    }
    let exts = path_exts(env);
    let classify = |file: PathBuf, ext: &str| match ext {
        ".exe" => Some(CliProgram::Exe(file)),
        ".cmd" | ".bat" => Some(CliProgram::Batch(file)),
        _ => None,
    };
    for (dir, trusted) in search_dirs(env, shell, cwd) {
        let hits: Vec<(PathBuf, &str)> =
            exts.iter().map(|e| (dir.join(format!("{name}{e}")), e.as_str())).filter(|(f, _)| f.is_file()).collect();
        let ps1 = shell != Shell::Cmd && dir.join(format!("{name}.ps1")).is_file();
        if hits.is_empty() && !ps1 {
            continue;
        }
        if !trusted {
            return None;
        }
        if !ps1 {
            let (file, ext) = hits.into_iter().next()?;
            return classify(file, ext);
        }
        // A .ps1 is what PowerShell runs: only an npm shim's .cmd starts the same thing.
        return hits
            .into_iter()
            .find(|(f, e)| matches!(*e, ".cmd" | ".bat") && is_npm_shim(f))
            .filter(|_| !dir.join(format!("{name}.exe")).is_file())
            .map(|(f, _)| CliProgram::Batch(f));
    }
    None
}

/// One argument of a command line that a program's C runtime splits back (CommandLineToArgvW rules).
pub fn quote_arg(arg: &str) -> String {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\u{b}', '"']) {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let mut backslashes = 0usize;
    for c in arg.chars() {
        match c {
            '\\' => backslashes += 1,
            '"' => {
                out.extend(std::iter::repeat_n('\\', backslashes * 2 + 1));
                out.push('"');
                backslashes = 0;
            }
            _ => {
                out.extend(std::iter::repeat_n('\\', backslashes));
                backslashes = 0;
                out.push(c);
            }
        }
    }
    out.extend(std::iter::repeat_n('\\', backslashes * 2));
    out.push('"');
    out
}

/// One argument inside a `cmd.exe /s /c "..."` line that reaches a batch file's `%*` unchanged: plain words as they are,
/// anything else in double quotes (cmd.exe takes `& | < > ^ ( )` inside them literally). None for what cmd.exe would expand or
/// cannot carry: `%`, `!` (delayed expansion), a double quote, a line break, NUL.
fn cmd_arg(arg: &str) -> Option<String> {
    if arg.contains(['%', '!', '"', '\r', '\n', '\0']) {
        return None;
    }
    if !arg.is_empty() && arg.chars().all(|c| plain_char(c) || c == ',') {
        return Some(arg.to_string());
    }
    // The C runtime behind the shim reads backslashes before the closing quote as escapes: doubled.
    let trailing = arg.len() - arg.trim_end_matches('\\').len();
    Some(format!("\"{arg}{}\"", "\\".repeat(trailing)))
}

/// What CreateProcess starts for an agent CLI started without a shell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DirectCommand {
    pub file: String,
    pub cmdline: String,
}

/// The command line of `program` with `args`; None when it cannot carry them as the shell did (see [`cmd_arg`]) or is too
/// long. With cmd as the cell's shell an argument with `%` or `!` keeps the launch line too (cmd.exe expanded them in it).
pub fn direct_command(program: &CliProgram, args: &[String], shell: Shell, env: &[(String, String)]) -> Option<DirectCommand> {
    if shell == Shell::Cmd && args.iter().any(|a| a.contains(['%', '!'])) {
        return None;
    }
    match program {
        CliProgram::Exe(exe) => {
            let file = exe.to_string_lossy().into_owned();
            let cmdline =
                std::iter::once(quote_arg(&file)).chain(args.iter().map(|a| quote_arg(a))).collect::<Vec<_>>().join(" ");
            (cmdline.len() <= MAX_LINE).then_some(DirectCommand { file, cmdline })
        }
        CliProgram::Batch(script) => {
            let script = script.to_string_lossy().into_owned();
            if script.contains(['%', '!', '"']) {
                return None;
            }
            let comspec = env_var(env, "ComSpec").filter(|c| !c.is_empty()).map(str::to_string).unwrap_or_else(|| {
                let root = env_var(env, "SystemRoot").unwrap_or("C:\\Windows");
                Path::new(root).join("System32").join("cmd.exe").to_string_lossy().into_owned()
            });
            let mut inner = format!("\"{script}\"");
            for a in args {
                inner.push(' ');
                inner.push_str(&cmd_arg(a)?);
            }
            // /s: cmd.exe drops the outer quotes and runs the rest as it is.
            let cmdline = format!("{} /s /c \"{inner}\"", quote_arg(&comspec));
            (cmdline.len() <= MAX_CMD_LINE).then_some(DirectCommand { file: comspec, cmdline })
        }
    }
}

/// The agent CLI of `profile` started without a shell, or None when the launch line typed into the shell must stay (see the
/// module docs). `env` is the cell's environment (its PATH decides), `cwd` its folder.
pub fn direct_launch(profile: &Profile, opts: &LaunchOptions, env: &[(String, String)], cwd: &Path) -> Option<DirectCommand> {
    let args = cli_args(profile, opts)?;
    let program = find_cli(&profile.cli, opts.shell, env, cwd)?;
    direct_command(&program, &args, opts.shell, env)
}

#[cfg(test)]
#[path = "direct_tests.rs"]
mod tests;
