//! Port of src/shared/cliInstall.ts: which methods can work here, the exact command typed into the terminal (per shell), the
//! end marker that reports the exit code, and the mapping of failures to a coarse reason. No I/O. The renderer never supplies a
//! command, only `{cli, method}`.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::cli::status::{CliId, Env, InstallMethod, Os, get_env, install_command, parse_version};

/// `INSTALL_METHODS`, in this order (the recommended one first).
pub const INSTALL_METHODS: [InstallMethod; 4] =
    [InstallMethod::Native, InstallMethod::Winget, InstallMethod::Brew, InstallMethod::Npm];

/// Ptys of the install window start with this prefix; they are not cells and are never status-tracked.
pub const INSTALL_PTY_PREFIX: &str = "install:";
/// Ptys of the login windows.
pub const AUTH_PTY_PREFIX: &str = "auth:";

/// `isAuxPtyId`: login (`auth:`) and install (`install:`) terminals are windows of the app, not cells.
pub fn is_aux_pty_id(id: &str) -> bool {
    id.starts_with(AUTH_PTY_PREFIX) || id.starts_with(INSTALL_PTY_PREFIX)
}

/// The wire name of a method.
pub fn method_name(method: InstallMethod) -> &'static str {
    match method {
        InstallMethod::Native => "native",
        InstallMethod::Winget => "winget",
        InstallMethod::Brew => "brew",
        InstallMethod::Npm => "npm",
    }
}

/// `isInstallMethod` over an IPC value: only the exact strings.
pub fn parse_method(value: &Value) -> Option<InstallMethod> {
    match value.as_str()? {
        "native" => Some(InstallMethod::Native),
        "winget" => Some(InstallMethod::Winget),
        "brew" => Some(InstallMethod::Brew),
        "npm" => Some(InstallMethod::Npm),
        _ => None,
    }
}

/// `InstallReason`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InstallReason {
    Network,
    Proxy,
    Permission,
    NpmMissing,
    Policy,
    NotOnPath,
    Timeout,
    Aborted,
    Generic,
}

impl InstallReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Network => "network",
            Self::Proxy => "proxy",
            Self::Permission => "permission",
            Self::NpmMissing => "npmMissing",
            Self::Policy => "policy",
            Self::NotOnPath => "notOnPath",
            Self::Timeout => "timeout",
            Self::Aborted => "aborted",
            Self::Generic => "generic",
        }
    }
}

/// Progress pushed to the renderer on `install:state`. `dir` is the folder the CLI is expected in / was found in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InstallState {
    Running { session_id: String },
    Succeeded { session_id: String, version: Option<String>, path: Option<String>, dir: Option<String> },
    Failed { session_id: String, reason: InstallReason, exit_code: Option<i64>, dir: Option<String> },
}

impl InstallState {
    pub fn session_id(&self) -> &str {
        match self {
            Self::Running { session_id } | Self::Succeeded { session_id, .. } | Self::Failed { session_id, .. } => session_id,
        }
    }

    pub fn status(&self) -> &'static str {
        match self {
            Self::Running { .. } => "running",
            Self::Succeeded { .. } => "succeeded",
            Self::Failed { .. } => "failed",
        }
    }

    /// The JSON of 1.1.4 (keys in its order, absent optional keys left out).
    pub fn to_json(&self) -> Value {
        let mut m = Map::new();
        m.insert("sessionId".into(), json!(self.session_id()));
        m.insert("status".into(), json!(self.status()));
        match self {
            Self::Running { .. } => {}
            Self::Succeeded { version, path, dir, .. } => {
                for (k, v) in [("version", version), ("path", path), ("dir", dir)] {
                    if let Some(v) = v {
                        m.insert(k.into(), json!(v));
                    }
                }
            }
            Self::Failed { reason, exit_code, dir, .. } => {
                m.insert("reason".into(), json!(reason.as_str()));
                if let Some(code) = exit_code {
                    m.insert("exitCode".into(), json!(code));
                }
                if let Some(dir) = dir {
                    m.insert("dir".into(), json!(dir));
                }
            }
        }
        Value::Object(m)
    }
}

// ── prerequisites ────────────────────────────────────────────────────────────

/// `InstallTools`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct InstallTools {
    pub winget: bool,
    pub brew: bool,
    pub npm: bool,
    pub node: bool,
    pub curl: bool,
    pub node_version: Option<String>,
}

/// `availableMethods`: methods that can work on this machine, the recommended one first. Impossible combinations are never
/// listed.
pub fn available_methods(cli: CliId, os: Os, tools: &InstallTools) -> Vec<InstallMethod> {
    INSTALL_METHODS
        .into_iter()
        .filter(|method| {
            if install_command(cli, os, *method).is_none() {
                return false;
            }
            match method {
                InstallMethod::Native => os.is_windows() || tools.curl,
                InstallMethod::Winget => os.is_windows() && tools.winget,
                InstallMethod::Brew => os == Os::Mac && tools.brew,
                InstallMethod::Npm => tools.npm && tools.node,
            }
        })
        .collect()
}

/// `nodeMajor`: `22` for `v22.3.0`; None when unparsable.
pub fn node_major(version: Option<&str>) -> Option<u32> {
    let v = version?;
    let v = v.strip_prefix(['v', 'V']).unwrap_or(v);
    parse_version(v)?.split('.').next()?.parse().ok()
}

/// Claude Code installed through npm needs Node.js 22+.
pub const NPM_NODE_MIN: u32 = 22;

// ── commands per shell ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellFamily {
    Powershell,
    Cmd,
    Posix,
}

/// `shellFamily`: settings.shell (`cmd`, `powershell`, `pwsh`, `zsh`, `bash`) on a platform.
pub fn shell_family(shell: Option<&str>, os: Os) -> ShellFamily {
    if !os.is_windows() {
        ShellFamily::Posix
    } else if shell == Some("cmd") {
        ShellFamily::Cmd
    } else {
        ShellFamily::Powershell
    }
}

/// `childPowerShell`: runs a PowerShell command line in a child powershell.exe; its exit code is the result.
pub fn child_powershell(command: &str) -> String {
    format!("powershell -NoProfile -ExecutionPolicy Bypass -Command \"{command}\"")
}

/// `installCommandFor`: the command in the form the configured shell runs it. None = impossible combination (allow-list).
pub fn install_command_for(cli: CliId, method: InstallMethod, os: Os, shell: Option<&str>) -> Option<String> {
    let official = install_command(cli, os, method)?;
    if os.is_windows() {
        // `irm ... | iex` always runs in a one-off child PowerShell (this process only, no policy change): the vendor script sets
        // $ErrorActionPreference = 'Stop' and calls Write-Error / exit, which would abort the whole typed line (and with it the
        // end marker) in the interactive shell.
        if official.starts_with("irm ") {
            return Some(child_powershell(official));
        }
        // `npm` resolves to npm.ps1 first in PowerShell, which a default execution policy blocks; npm.cmd is the same program.
        if shell_family(shell, os) == ShellFamily::Powershell
            && method == InstallMethod::Npm
            && let Some(rest) = official.strip_prefix("npm ")
        {
            return Some(format!("npm.cmd {rest}"));
        }
    }
    Some(official.to_string())
}

/// Output prefix of the end marker; the typed command spells it in pieces so the echo of the command never matches.
pub const INSTALL_MARKER: &str = "__AJZ_DONE__";

/// `typedInstallCommand`: wraps the command so the shell prints `__AJZ_DONE__<exit code>` when it returns. PowerShell and
/// cmd only know success / failure (0 or 1); POSIX shells give the real code (a pipeline fails when any part fails).
pub fn typed_install_command(command: &str, family: ShellFamily) -> String {
    match family {
        ShellFamily::Powershell => format!("{command}; Write-Host ('__AJZ_DONE_' + '_' + [int](-not $?))"),
        ShellFamily::Cmd => format!("{command} && echo __AJZ_DON^E__0 || echo __AJZ_DON^E__1"),
        ShellFamily::Posix => format!("(set -o pipefail; {command}); echo \"__AJZ_DONE_\"\"_$?\""),
    }
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static pattern"))
}

/// `stripAnsi`: CSI, OSC, charset and keypad sequences removed; a lone CR becomes a line break.
pub fn strip_ansi(text: &str) -> String {
    static ANSI: OnceLock<Regex> = OnceLock::new();
    let ansi = re(&ANSI, r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]");
    let cleaned = ansi.replace_all(text, "");
    // `/\r(?!\n)/g` (no look-ahead in the regex crate): a CR followed by something else or by the end.
    let mut out = String::with_capacity(cleaned.len());
    let mut chars = cleaned.chars().peekable();
    while let Some(c) = chars.next() {
        out.push(if c == '\r' && chars.peek() != Some(&'\n') { '\n' } else { c });
    }
    out
}

/// `parseInstallMarker`: the exit code of the last marker in the output (ANSI stripped here), or None. The digits must be
/// followed by the end of the line: a marker split inside a multi-digit code (chunk boundary) is not complete yet.
pub fn parse_install_marker(text: &str) -> Option<i64> {
    let clean = strip_ansi(text);
    let bytes = clean.as_bytes();
    let mut code = None;
    let mut from = 0;
    while let Some(at) = clean[from..].find(INSTALL_MARKER) {
        let start = from + at + INSTALL_MARKER.len();
        from = from + at + 1;
        let digits = bytes[start..].iter().take_while(|b| b.is_ascii_digit()).count();
        // `(\d{1,3})[ \t]*(?=[\r\n])`: more than 3 digits never match (the backtracking would leave a digit before the line end).
        if digits == 0 || digits > 3 {
            continue;
        }
        let mut p = start + digits;
        while p < bytes.len() && (bytes[p] == b' ' || bytes[p] == b'\t') {
            p += 1;
        }
        if p < bytes.len() && (bytes[p] == b'\r' || bytes[p] == b'\n') {
            code = clean[start..start + digits].parse().ok();
        }
    }
    code
}

// ── failures ─────────────────────────────────────────────────────────────────

/// What `classifyInstallFailure` looks at.
#[derive(Debug, Clone)]
pub struct FailureInput<'a> {
    pub exit_code: Option<i64>,
    pub output: &'a str,
    pub method: InstallMethod,
    /// The command exited cleanly but the detector still finds nothing.
    pub installed_but_missing: bool,
    pub timed_out: bool,
    pub aborted: bool,
}

/// `classifyInstallFailure`: the coarse reason from the finished command.
pub fn classify_install_failure(input: &FailureInput<'_>) -> InstallReason {
    static POLICY: OnceLock<Regex> = OnceLock::new();
    static NPM: OnceLock<Regex> = OnceLock::new();
    static PROXY: OnceLock<Regex> = OnceLock::new();
    static PERMISSION: OnceLock<Regex> = OnceLock::new();
    static NETWORK: OnceLock<Regex> = OnceLock::new();
    if input.timed_out {
        return InstallReason::Timeout;
    }
    if input.aborted {
        return InstallReason::Aborted;
    }
    let text = strip_ansi(input.output);
    if input.installed_but_missing && matches!(input.exit_code, Some(0) | None) {
        return InstallReason::NotOnPath;
    }
    let policy = re(
        &POLICY,
        r"(?i)running scripts is disabled|cannot be loaded because running scripts|PSSecurityException|is not digitally signed|UnauthorizedAccess|AuthorizationManager|execution policy",
    );
    if policy.is_match(&text) {
        return InstallReason::Policy;
    }
    let npm = re(
        &NPM,
        r"(?i)'npm(?:\.cmd)?' is not recognized|npm(?:\.cmd)?\s*:\s*(?:the term|command not found|not found)|command not found: npm",
    );
    if input.method == InstallMethod::Npm && npm.is_match(&text) {
        return InstallReason::NpmMissing;
    }
    let proxy = re(
        &PROXY,
        r"(?i)\b40[37]\b|forbidden|proxy authentication|<!doctype html|<html|blocked by (?:your )?(?:administrator|policy|proxy)",
    );
    if proxy.is_match(&text) {
        return InstallReason::Proxy;
    }
    let permission =
        re(&PERMISSION, r"(?i)\bEACCES\b|\bEPERM\b|permission denied|access is denied|operation not permitted|EACCES");
    if permission.is_match(&text) {
        return InstallReason::Permission;
    }
    let network = re(
        &NETWORK,
        r"(?i)could not resolve host|curl: \((?:6|7|18|22|28|35|52|56|60)\)|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network|unable to connect to the remote server|remote name could not be resolved|timed out|secure channel|SSL/TLS|certificate|unable to get local issuer|Could not establish trust|connection (?:was )?(?:closed|reset|refused)|Invoke-RestMethod|Invoke-WebRequest|\b404\b|\b5\d\d\b.*(?:error|server)",
    );
    if network.is_match(&text) {
        return InstallReason::Network;
    }
    InstallReason::Generic
}

// ── expected location ────────────────────────────────────────────────────────

/// `expectedBinDir`: where the method puts the binary (for the "not on PATH" hint); None when not documented.
pub fn expected_bin_dir(cli: CliId, method: InstallMethod, os: Os, home: &str, env: &Env) -> Option<String> {
    let sep = if os.is_windows() { "\\" } else { "/" };
    let join = |parts: &[&str]| {
        parts
            .iter()
            .enumerate()
            .map(|(i, p)| if i == 0 { p.trim_end_matches(['\\', '/']) } else { p.trim_matches(['\\', '/']) })
            .collect::<Vec<_>>()
            .join(sep)
    };
    // `env.X || fallback`: an empty value counts as unset.
    let var = |name: &str| get_env(env, name, os).filter(|v| !v.is_empty()).map(str::to_string);
    if method == InstallMethod::Native {
        return (cli == CliId::Claude).then(|| join(&[home, ".local", "bin"]));
    }
    if os.is_windows() {
        if method == InstallMethod::Npm {
            let appdata = var("APPDATA").unwrap_or_else(|| join(&[home, "AppData", "Roaming"]));
            return Some(join(&[&appdata, "npm"]));
        }
        if method == InstallMethod::Winget {
            let local = var("LOCALAPPDATA").unwrap_or_else(|| join(&[home, "AppData", "Local"]));
            return Some(join(&[&local, "Microsoft", "WinGet", "Links"]));
        }
    }
    if method == InstallMethod::Brew {
        return (os == Os::Mac).then(|| "/opt/homebrew/bin".to_string());
    }
    None
}

// ── POSIX tool probe (login shell, so brew / nvm paths of the user's rc files count) ─────────────

/// `toolProbeScript`: the script for `$SHELL -ilc`; None = unsupported shell. Prints marker lines [`parse_tool_probe`] reads.
pub fn tool_probe_script(shell_path: &str) -> Option<&'static str> {
    let name = shell_path.rsplit('/').next().unwrap_or("");
    if name == "fish" {
        return Some(
            "for t in brew npm node curl; printf '__AJZ_TOOL_%s__=%s\\n' $t (command -v $t); end; printf '__AJZ_NODEV__=%s\\n' (node --version 2>/dev/null)",
        );
    }
    if !["zsh", "bash", "sh", "dash", "ksh"].contains(&name) {
        return None;
    }
    Some(
        "for t in brew npm node curl; do printf '__AJZ_TOOL_%s__=%s\\n' \"$t\" \"$(command -v \"$t\" 2>/dev/null)\"; done; printf '__AJZ_NODEV__=%s\\n' \"$(node --version 2>/dev/null)\"",
    )
}

/// `parseToolProbe`: marker lines -> tools; rc-file noise is ignored and only absolute paths count (aliases and functions do
/// not). None = no marker at all (the probe failed).
pub fn parse_tool_probe(output: &str) -> Option<InstallTools> {
    let mut tools = InstallTools::default();
    let mut seen = false;
    let clean = strip_ansi(output);
    for raw in clean.split('\n') {
        let raw = raw.strip_suffix('\r').unwrap_or(raw);
        let line = unimux_core::utf16::js_trim(raw);
        if let Some(rest) = line.strip_prefix("__AJZ_TOOL_") {
            let found = ["brew", "npm", "node", "curl"]
                .into_iter()
                .find_map(|t| rest.strip_prefix(t).and_then(|r| r.strip_prefix("__=")).map(|value| (t, value)));
            if let Some((tool, value)) = found {
                seen = true;
                if unimux_core::utf16::js_trim(value).starts_with('/') {
                    match tool {
                        "brew" => tools.brew = true,
                        "npm" => tools.npm = true,
                        "node" => tools.node = true,
                        _ => tools.curl = true,
                    }
                }
                continue;
            }
        }
        if let Some(value) = line.strip_prefix("__AJZ_NODEV__=") {
            let value = value.strip_prefix(['v', 'V']).unwrap_or(value);
            if let Some(v) = parse_version(value) {
                tools.node_version = Some(v);
            }
        }
    }
    seen.then_some(tools)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tools(f: impl FnOnce(&mut InstallTools)) -> InstallTools {
        let mut t = InstallTools::default();
        f(&mut t);
        t
    }

    use InstallMethod::*;

    #[test]
    fn methods_per_machine() {
        let w = Os::Windows;
        assert_eq!(available_methods(CliId::Claude, w, &tools(|_| {})), vec![Native]);
        assert_eq!(
            available_methods(CliId::Claude, w, &tools(|t| (t.winget, t.npm, t.node) = (true, true, true))),
            vec![Native, Winget, Npm]
        );
        assert_eq!(available_methods(CliId::Claude, w, &tools(|t| t.npm = true)), vec![Native]);
        assert_eq!(available_methods(CliId::Codex, w, &tools(|t| t.winget = true)), vec![Native]);
        assert_eq!(available_methods(CliId::Codex, Os::Linux, &tools(|_| {})), vec![]);
        assert_eq!(available_methods(CliId::Codex, Os::Linux, &tools(|t| (t.curl, t.brew) = (true, true))), vec![Native]);
        assert_eq!(
            available_methods(CliId::Claude, Os::Mac, &tools(|t| (t.curl, t.brew, t.npm, t.node) = (true, true, true, true))),
            vec![Native, Brew, Npm]
        );
        assert_eq!(available_methods(CliId::Claude, Os::Mac, &tools(|t| t.brew = true)), vec![Brew]);
        assert_eq!(node_major(Some("22.3.0")), Some(22));
        assert_eq!(node_major(Some("v20.11.1")), Some(20));
        assert_eq!(node_major(None), None);
        assert_eq!(node_major(Some("x")), None);
    }

    #[test]
    fn commands_per_shell() {
        let wrapped = "powershell -NoProfile -ExecutionPolicy Bypass -Command \"irm https://claude.ai/install.ps1 | iex\"";
        for shell in ["powershell", "pwsh", "cmd"] {
            assert_eq!(install_command_for(CliId::Claude, Native, Os::Windows, Some(shell)).as_deref(), Some(wrapped));
        }
        assert_eq!(
            install_command_for(CliId::Codex, Native, Os::Windows, Some("cmd")).as_deref(),
            Some("powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\"")
        );
        assert_eq!(
            install_command_for(CliId::Claude, Npm, Os::Windows, Some("powershell")).as_deref(),
            Some("npm.cmd install -g @anthropic-ai/claude-code")
        );
        assert_eq!(
            install_command_for(CliId::Codex, Npm, Os::Windows, Some("cmd")).as_deref(),
            Some("npm install -g @openai/codex")
        );
        assert_eq!(install_command_for(CliId::Claude, Brew, Os::Windows, Some("powershell")), None);
        assert_eq!(install_command_for(CliId::Codex, Winget, Os::Windows, Some("powershell")), None);
        assert_eq!(install_command_for(CliId::Claude, Winget, Os::Mac, Some("zsh")), None);
        for bad in ["", "native; calc", "__proto__", "constructor", "toString"] {
            assert_eq!(parse_method(&json!(bad)), None);
        }
        assert_eq!(parse_method(&json!(["native"])), None);
        assert_eq!(shell_family(Some("cmd"), Os::Windows), ShellFamily::Cmd);
        assert_eq!(shell_family(Some("pwsh"), Os::Windows), ShellFamily::Powershell);
        assert_eq!(shell_family(Some("cmd"), Os::Mac), ShellFamily::Posix);
    }

    #[test]
    fn end_marker() {
        for family in [ShellFamily::Powershell, ShellFamily::Cmd, ShellFamily::Posix] {
            let typed = typed_install_command("some-installer --flag", family);
            assert!(!typed.contains(INSTALL_MARKER));
            assert_eq!(parse_install_marker(&format!("PS C:\\Users\\x> {typed}\r\n")), None);
        }
        assert_eq!(parse_install_marker("done\r\n__AJZ_DONE__0\r\n"), Some(0));
        assert_eq!(parse_install_marker("\x1b[32m__AJZ_DONE__7\x1b[0m\r\n"), Some(7));
        assert_eq!(parse_install_marker("__AJZ_DONE__1 \r\n"), Some(1));
        assert_eq!(parse_install_marker("__AJZ_DONE__"), None);
        assert_eq!(parse_install_marker("__AJZ_DONE__x"), None);
        assert_eq!(parse_install_marker(""), None);
        assert_eq!(parse_install_marker("__AJZ_DONE__1"), None, "half of a multi-digit code");
        assert_eq!(parse_install_marker("__AJZ_DONE__130\r\n"), Some(130));
        assert_eq!(parse_install_marker("__AJZ_DONE__1234\r\n"), None);
        assert_eq!(parse_install_marker("__AJZ_DONE__1\r\n__AJZ_DONE__2\r"), Some(2), "a lone CR ends the line too");
        assert_eq!(strip_ansi("\x1b[31mred\x1b[0m \x1b]0;title\x07ok"), "red ok");
        assert_eq!(strip_ansi("a\rb\r\nc\r"), "a\nb\r\nc\n");
    }

    fn classify(output: &str, f: impl FnOnce(&mut FailureInput<'_>)) -> InstallReason {
        let mut input = FailureInput {
            exit_code: Some(1),
            output,
            method: Native,
            installed_but_missing: false,
            timed_out: false,
            aborted: false,
        };
        f(&mut input);
        classify_install_failure(&input)
    }

    #[test]
    fn failure_classification() {
        use InstallReason::*;
        let none = |_: &mut FailureInput<'_>| {};
        let npm = |i: &mut FailureInput<'_>| i.method = InstallMethod::Npm;
        assert_eq!(classify("curl: (6) Could not resolve host: claude.ai", none), Network);
        assert_eq!(classify("Invoke-RestMethod : Unable to connect to the remote server", none), Network);
        assert_eq!(
            classify(
                "The underlying connection was closed: Could not establish trust relationship for the SSL/TLS secure channel.",
                none
            ),
            Network
        );
        assert_eq!(classify("curl: (22) The requested URL returned error: 403", none), Proxy);
        assert_eq!(classify("<!DOCTYPE html><html><body>Blocked by policy</body></html>", none), Proxy);
        assert_eq!(classify("HTTP/1.1 407 Proxy Authentication Required", none), Proxy);
        assert_eq!(classify("EACCES: permission denied, mkdir '/usr/local/lib/node_modules'", npm), Permission);
        assert_eq!(classify("mkdir: cannot create directory: Permission denied", none), Permission);
        assert_eq!(classify("'npm' is not recognized as an internal or external command", npm), NpmMissing);
        assert_eq!(classify("zsh: command not found: npm", npm), NpmMissing);
        assert_eq!(classify("npm.cmd : The term 'npm.cmd' is not recognized as the name of a cmdlet", npm), NpmMissing);
        assert_eq!(
            classify("File C:\\x\\npm.ps1 cannot be loaded because running scripts is disabled on this system.", npm),
            Policy
        );
        assert_eq!(classify("PSSecurityException UnauthorizedAccess", none), Policy);
        assert_eq!(classify("something odd happened", none), Generic);
        assert_eq!(classify("", none), Generic);
        assert_eq!(classify("'npm' is not recognized", none), Generic, "npm text for another method");
        let missing = |code: Option<i64>| {
            move |i: &mut FailureInput<'_>| {
                i.exit_code = code;
                i.installed_but_missing = true;
            }
        };
        assert_eq!(classify("all good", missing(Some(0))), NotOnPath);
        assert_eq!(classify("boom", missing(Some(1))), Generic);
        assert_eq!(
            classify("curl: (6)", |i| {
                i.exit_code = None;
                i.timed_out = true;
            }),
            Timeout
        );
    }

    #[test]
    fn expected_directories() {
        let env = |pairs: &[(&str, &str)]| pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Env>();
        let w = Os::Windows;
        assert_eq!(
            expected_bin_dir(CliId::Claude, Native, w, "C:\\Users\\a", &env(&[])).as_deref(),
            Some("C:\\Users\\a\\.local\\bin")
        );
        assert_eq!(
            expected_bin_dir(CliId::Claude, Native, Os::Mac, "/Users/a", &env(&[])).as_deref(),
            Some("/Users/a/.local/bin")
        );
        assert_eq!(expected_bin_dir(CliId::Codex, Native, Os::Mac, "/Users/a", &env(&[])), None);
        assert_eq!(
            expected_bin_dir(CliId::Claude, Npm, w, "C:\\Users\\a", &env(&[("APPDATA", "C:\\Users\\a\\AppData\\Roaming")]))
                .as_deref(),
            Some("C:\\Users\\a\\AppData\\Roaming\\npm")
        );
        assert_eq!(
            expected_bin_dir(CliId::Claude, Winget, w, "C:\\Users\\a", &env(&[("LOCALAPPDATA", "C:\\L")])).as_deref(),
            Some("C:\\L\\Microsoft\\WinGet\\Links")
        );
        assert_eq!(expected_bin_dir(CliId::Claude, Brew, Os::Mac, "/Users/a", &env(&[])).as_deref(), Some("/opt/homebrew/bin"));
    }

    #[test]
    fn posix_tool_probe() {
        assert!(tool_probe_script("/bin/zsh").unwrap().contains("command -v"));
        assert!(tool_probe_script("/usr/bin/fish").unwrap().contains("command -v"));
        assert_eq!(tool_probe_script("/bin/csh"), None);
        let out = "Welcome!\n__AJZ_TOOL_brew__=/opt/homebrew/bin/brew\n__AJZ_TOOL_npm__=\n__AJZ_TOOL_node__=/usr/bin/node\n__AJZ_TOOL_curl__=curl: aliased\n__AJZ_NODEV__=v22.4.1\n";
        assert_eq!(
            parse_tool_probe(out),
            Some(InstallTools { brew: true, node: true, node_version: Some("22.4.1".into()), ..InstallTools::default() })
        );
        assert_eq!(parse_tool_probe("nothing useful"), None);
        assert!(is_aux_pty_id("auth:1"));
        assert!(is_aux_pty_id("install:abc"));
        assert!(!is_aux_pty_id("3f2a"));
        assert!(!is_aux_pty_id("my-install:x"));
    }

    #[test]
    fn states_serialize_like_main() {
        let s =
            InstallState::Succeeded { session_id: "s".into(), version: Some("2.1.0".into()), path: None, dir: Some("d".into()) };
        assert_eq!(s.to_json().to_string(), r#"{"sessionId":"s","status":"succeeded","version":"2.1.0","dir":"d"}"#);
        let f = InstallState::Failed { session_id: "s".into(), reason: InstallReason::NotOnPath, exit_code: Some(0), dir: None };
        assert_eq!(f.to_json().to_string(), r#"{"sessionId":"s","status":"failed","reason":"notOnPath","exitCode":0}"#);
    }
}
