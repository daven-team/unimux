//! Shell integration (port of src/shared/shellIntegration.ts `withShellIntegration` and src/ptyhost/manager.ts
//! `integratedLaunch`): the shell of a local cell writes OSC 133 marks around its prompt (A = the prompt starts, B = the
//! prompt ends, C = a command starts running, D;<code> = the last command ended), so the status of a shell cell comes from the
//! shell itself. The mark parser stays in the renderer.
//!
//! - PowerShell (5.1 and 7): the profile loads as usual, then [`POWERSHELL_SCRIPT`] (passed as UTF-16LE base64
//!   `-EncodedCommand`, so no quoting can go wrong on the way through ConPTY) wraps the prompt and PSReadLine's line reader;
//! - cmd.exe: its `PROMPT` codes carry the marks ([`cmd_prompt`]);
//! - bash (macOS / Linux): started with `--init-file <dir>/bash-init.sh -i` instead of `-il`; [`BASH_INIT`] reads the login
//!   files itself, then sets PROMPT_COMMAND / PS0. The file lives in a per-user folder that must be a real directory owned by
//!   us and not writable by others (0700, file 0600), else the shell starts untouched;
//! - zsh is left as it is.
//!
//! `UNIMUX_SHELL_INTEGRATION=0` in the cell environment starts every shell untouched.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::shell::{Launch, Platform, ShellKind, env_get, env_set};

/// Set to 0 in the environment to start every shell untouched.
pub const SHELL_INTEGRATION_ENV: &str = "UNIMUX_SHELL_INTEGRATION";

/// PowerShell (5.1 and 7): wraps the prompt function (D + A before, B after the user's own prompt) and PSReadLine's line
/// reader (C once a line was accepted). `$?` and `$LASTEXITCODE` are kept for the user's prompt; an agent's launch line
/// leaves its CLI's exit code in `$__unimuxExit` (the reset tail): D carries that code once. Byte-identical to 1.1.4.
pub const POWERSHELL_SCRIPT: &str = concat!(
    "if (-not $global:__unimuxShell) {\n",
    "  $global:__unimuxShell = $true\n",
    "  $global:__unimuxPrompt = $function:prompt\n",
    "  function global:prompt {\n",
    "    $ok = $global:?\n",
    "    $code = $global:LASTEXITCODE\n",
    "    $e = [char]27; $b = [char]7\n",
    "    $cli = $global:__unimuxExit; $global:__unimuxExit = $null\n",
    "    $status = if ($cli -is [int]) { $cli } elseif ($ok) { 0 } elseif ($code -is [int] -and $code -ne 0) { $code } else { 1 }\n",
    "    $text = if ($global:__unimuxPrompt) { & $global:__unimuxPrompt } else { \"PS $($executionContext.SessionState.Path.CurrentLocation)> \" }\n",
    "    $global:LASTEXITCODE = $code\n",
    "    \"$e]133;D;$status$b$e]133;A$b$text$e]133;B$b\"\n",
    "  }\n",
    "  try { Import-Module PSReadLine -ErrorAction Stop } catch { }\n",
    "  if (Test-Path Function:\\PSConsoleHostReadLine) {\n",
    "    $global:__unimuxReadLine = $function:PSConsoleHostReadLine\n",
    "    function global:PSConsoleHostReadLine {\n",
    "      $line = & $global:__unimuxReadLine\n",
    "      [Console]::Write(\"$([char]27)]133;C$([char]7)\")\n",
    "      $line\n",
    "    }\n",
    "  }\n",
    "}",
);

/// bash: the login files as a login shell reads them, then the prompt marks first in PROMPT_COMMAND (`$?` kept for the
/// user's own) and C into PS0 (bash 4.4+). Byte-identical to 1.1.4.
pub const BASH_INIT: &str = concat!(
    "# unimux shell integration: the login files as a login shell reads them, then prompt marks (OSC 133).\n",
    "if [ -r /etc/profile ]; then . /etc/profile; fi\n",
    "for __unimux_f in ~/.bash_profile ~/.bash_login ~/.profile; do if [ -r \"$__unimux_f\" ]; then . \"$__unimux_f\"; break; fi; done\n",
    "unset __unimux_f\n",
    "__unimux_prompt() { local c=$?; printf '\\033]133;D;%s\\007\\033]133;A\\007' \"$c\"; return $c; }\n",
    "case \"$PROMPT_COMMAND\" in *__unimux_prompt*) ;; *) PROMPT_COMMAND=\"__unimux_prompt${PROMPT_COMMAND:+;$PROMPT_COMMAND}\" ;; esac\n",
    "PS0=\"${PS0}\\[\\033]133;C\\007\\]\"\n",
);

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// Standard base64 with padding (`btoa`).
fn base64(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { B64[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[n as usize & 63] as char } else { '=' });
    }
    out
}

/// `-EncodedCommand` takes UTF-16LE base64 (`encodePowerShell`).
pub fn encode_power_shell(script: &str) -> String {
    let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    base64(&bytes)
}

/// cmd.exe: its PROMPT codes (`$E` = ESC) carry the marks; the user's own PROMPT (when set and not blank) stays inside.
pub fn cmd_prompt(user_prompt: Option<&str>) -> String {
    let user = match user_prompt {
        Some(p) if !unimux_core::utf16::js_trim(p).is_empty() => p,
        _ => "$P$G",
    };
    format!("$E]133;D$E\\$E]133;A$E\\{user}$E]133;B$E\\")
}

/// A shell launch with its environment, and the helper files it needs (absolute path, content).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IntegratedLaunch {
    pub launch: Launch,
    pub env: Vec<(String, String)>,
    pub files: Vec<(String, String)>,
}

/// `withShellIntegration(kind, launch, {dir, platform})`: the launch with the prompt marks added; `dir` holds the helper
/// files (bash). Pure: the caller writes the files.
pub fn with_shell_integration(
    kind: ShellKind,
    launch: &Launch,
    env: &[(String, String)],
    dir: &str,
    platform: Platform,
) -> IntegratedLaunch {
    let plain = IntegratedLaunch { launch: launch.clone(), env: env.to_vec(), files: Vec::new() };
    if env_get(env, SHELL_INTEGRATION_ENV) == Some("0") {
        return plain;
    }
    if platform == Platform::Windows {
        if kind == ShellKind::Cmd {
            let mut env = plain.env;
            let prompt = cmd_prompt(env_get(&env, "PROMPT"));
            env_set(&mut env, "PROMPT", &prompt);
            return IntegratedLaunch { env, ..plain };
        }
        let mut args = launch.args.clone();
        args.extend(["-NoExit".to_string(), "-EncodedCommand".to_string(), encode_power_shell(POWERSHELL_SCRIPT)]);
        return IntegratedLaunch { launch: Launch { file: launch.file.clone(), args }, ..plain };
    }
    if kind == ShellKind::Bash && launch.file.ends_with("bash") {
        let sep = if dir.contains('\\') && !dir.contains('/') { "\\" } else { "/" };
        let file = format!("{}{sep}bash-init.sh", dir.trim_end_matches(['\\', '/']));
        // -i instead of -il: --init-file is ignored by a login shell, the init file reads the login files itself.
        return IntegratedLaunch {
            launch: Launch { file: launch.file.clone(), args: vec!["--init-file".into(), file.clone(), "-i".into()] },
            files: vec![(file, BASH_INIT.to_string())],
            ..plain
        };
    }
    plain
}

/// The per-user folder of the helper files: `<temp>/unimux-shell-<uid>` (`user` where there is no uid).
pub fn default_shell_dir() -> PathBuf {
    #[cfg(unix)]
    let who = unsafe { libc::getuid() }.to_string();
    #[cfg(not(unix))]
    let who = "user".to_string();
    std::env::temp_dir().join(format!("unimux-shell-{who}"))
}

/// A folder only this user can write: the shell runs the init file in it, so on a shared /tmp another user must not be able
/// to plant or swap it. Created 0700, then checked (a real directory, not a link, ours, not writable by group or others).
pub fn private_dir(dir: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt as _, MetadataExt as _};
        if std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).is_err() {
            return false;
        }
        let Ok(st) = std::fs::symlink_metadata(dir) else { return false };
        if !st.is_dir() || st.file_type().is_symlink() {
            return false;
        }
        st.uid() == unsafe { libc::getuid() } && st.mode() & 0o022 == 0
    }
    #[cfg(not(unix))]
    {
        if std::fs::create_dir_all(dir).is_err() {
            return false;
        }
        let Ok(st) = std::fs::symlink_metadata(dir) else { return false };
        st.is_dir() && !st.file_type().is_symlink()
    }
}

/// Files written in this run (path -> content), so an unchanged file is not rewritten for every spawn.
static WRITTEN: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);

/// Writes `content` to `file` through a temp file created new (never through a planted file or link), 0600.
fn write_private(file: &str, content: &str) -> std::io::Result<()> {
    use std::io::Write as _;
    let temp = format!("{file}.{}.tmp", std::process::id());
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.mode(0o600);
    }
    let result = options.open(&temp).and_then(|mut f| f.write_all(content.as_bytes())).and_then(|_| std::fs::rename(&temp, file));
    if result.is_err() {
        let _ = std::fs::remove_file(&temp);
    }
    result
}

/// `integratedLaunch`: the shell launch with its prompt marks; the helper files are written into `dir` (checked to be
/// private) when missing or changed. A check or write that fails starts the shell untouched (the status then falls back to
/// the output heuristics).
pub fn integrated_launch(
    kind: ShellKind,
    launch: &Launch,
    env: &[(String, String)],
    platform: Platform,
    dir: &Path,
) -> (Launch, Vec<(String, String)>) {
    let dir_text = dir.to_string_lossy();
    let spec = with_shell_integration(kind, launch, env, &dir_text, platform);
    let untouched = || (launch.clone(), env.to_vec());
    if !spec.files.is_empty() && !private_dir(dir) {
        return untouched();
    }
    for (file, content) in &spec.files {
        let mut written = WRITTEN.lock().unwrap_or_else(|e| e.into_inner());
        let map = written.get_or_insert_with(HashMap::new);
        // Checked on disk every time (not only the cache): a file changed behind our back is written again.
        if map.get(file) == Some(content) && std::fs::read_to_string(file).is_ok_and(|t| &t == content) {
            continue;
        }
        if write_private(file, content).is_err() {
            return untouched();
        }
        map.insert(file.clone(), content.clone());
    }
    (spec.launch, spec.env)
}

// ── an agent CLI started without a shell (Windows) ───────────────────────────
//
// The CLI runs as the terminal's own process and the shell starts in the same terminal once it ended (manager.rs,
// `SpawnRequest::agent`). What the shell and the launch line used to write around the CLI is written here instead.

/// Tells the renderer the agent's start began (src/shared/startScreen.ts `AGENT_START_OSC`): what the launch line's clear
/// told it before (the screen is empty, the CLI comes next).
pub const AGENT_START_OSC: &[u8] = b"\x1b]6973;agent-start\x07";

/// The PowerShell expression of the launch line's reset tail (unimux-agents launch `with_reset_tail`): mouse tracking, the
/// mouse encodings, bracketed paste and the kitty keyboard flags off (1004 is ConPTY's and never cleared).
pub const INPUT_RESET_PS: &str = "[char]27+'[?1000;1002;1003;1005;1006;1015;2004l'+[char]27+'[<u'";

fn integration_on(env: &[(String, String)]) -> bool {
    env_get(env, SHELL_INTEGRATION_ENV) != Some("0")
}

/// What the terminal of an agent started without a shell gets before the CLI's first output: the prompt marks the shell
/// wrote before the launch line was typed (PowerShell: D;0 A B, and C once the line was accepted; cmd: D A B in its PROMPT),
/// then [`AGENT_START_OSC`]. The status of the cell reads the CLI's launch and end from these marks as before.
pub fn agent_start_marks(kind: ShellKind, env: &[(String, String)]) -> Vec<u8> {
    let mut out = Vec::new();
    if integration_on(env) {
        match kind {
            ShellKind::Pwsh | ShellKind::Powershell => {
                out.extend_from_slice(b"\x1b]133;D;0\x07\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07");
            }
            ShellKind::Cmd => out.extend_from_slice(b"\x1b]133;D\x1b\\\x1b]133;A\x1b\\\x1b]133;B\x1b\\"),
            ShellKind::Zsh | ShellKind::Bash => {}
        }
    }
    out.extend_from_slice(AGENT_START_OSC);
    out
}

/// The shell that starts in the terminal once the agent CLI ended with `code`: the launch `shell` (from [`resolve_shell`],
/// `env` the cell's) with what the launch line's reset tail did after the CLI: the input modes off, and in PowerShell the
/// CLI's exit code in `$LASTEXITCODE` and `$__unimuxExit` (the prompt's D mark carries it once). PowerShell then wraps its
/// prompt as usual; cmd gets `/k` with the tail's command and its prompt marks from `env` ([`integrated_launch`]).
/// Returns the launch and, for cmd, the complete command line.
///
/// [`resolve_shell`]: crate::shell::resolve_shell
pub fn after_agent_launch(kind: ShellKind, shell: &Launch, env: &[(String, String)], code: i32) -> (Launch, Option<String>) {
    if kind == ShellKind::Cmd {
        let file = if shell.file.contains(' ') { format!("\"{}\"", shell.file) } else { shell.file.clone() };
        let line =
            format!("{file} /k powershell -NoProfile -NonInteractive -Command \"[Console]::Write({INPUT_RESET_PS})\" 2>nul");
        return (shell.clone(), Some(line));
    }
    let prelude = format!("$global:LASTEXITCODE = {code}; $global:__unimuxExit = {code}; [Console]::Write({INPUT_RESET_PS})");
    let script = if integration_on(env) { format!("{prelude}\n{POWERSHELL_SCRIPT}") } else { prelude };
    let mut args = shell.args.clone();
    args.extend(["-NoExit".to_string(), "-EncodedCommand".to_string(), encode_power_shell(&script)]);
    (Launch { file: shell.file.clone(), args }, None)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_power_shell(b64: &str) -> String {
        let mut bytes = Vec::new();
        let (mut acc, mut bits) = (0u32, 0u32);
        for c in b64.bytes().filter(|c| *c != b'=') {
            acc = (acc << 6) | B64.iter().position(|b| *b == c).unwrap() as u32;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                bytes.push((acc >> bits) as u8);
            }
        }
        let units: Vec<u16> = bytes.chunks(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16(&units).unwrap()
    }

    #[test]
    fn the_reset_after_an_agent_is_the_launch_lines_reset_tail() {
        // The same expression the typed line's tail writes (unimux-agents launch with_reset_tail), for PowerShell and cmd.
        use unimux_agents::launch::{Shell, with_reset_tail};
        assert!(with_reset_tail("x", Shell::Pwsh, None).contains(&format!("[Console]::Write({INPUT_RESET_PS})")));
        let cmd_tail = with_reset_tail("x", Shell::Cmd, None);
        let cmd_after = format!("powershell -NoProfile -NonInteractive -Command \"[Console]::Write({INPUT_RESET_PS})\" 2>nul");
        assert!(cmd_tail.ends_with(&cmd_after), "{cmd_tail}");
        let shell = Launch::new("cmd.exe", &[]);
        let (launch, line) = after_agent_launch(ShellKind::Cmd, &shell, &[], 3);
        assert_eq!(launch, shell);
        assert_eq!(line.unwrap(), format!("cmd.exe /k {cmd_after}"));
    }

    #[test]
    fn powershell_after_an_agent_keeps_its_exit_code_and_wraps_the_prompt() {
        let shell = Launch::new("C:\\pwsh.exe", &["-NoLogo"]);
        let (launch, line) = after_agent_launch(ShellKind::Pwsh, &shell, &[], -1073741510);
        assert_eq!(line, None);
        assert_eq!(launch.file, "C:\\pwsh.exe");
        assert_eq!(launch.args[..3], ["-NoLogo", "-NoExit", "-EncodedCommand"]);
        let script = decode_power_shell(&launch.args[3]);
        assert!(script.starts_with(
            "$global:LASTEXITCODE = -1073741510; $global:__unimuxExit = -1073741510; [Console]::Write([char]27+'[?1000;"
        ));
        assert!(script.ends_with(POWERSHELL_SCRIPT));
        // Shell integration off: only the tail's part.
        let off = env(&[(SHELL_INTEGRATION_ENV, "0")]);
        let (launch, _) = after_agent_launch(ShellKind::Powershell, &shell, &off, 0);
        let script = decode_power_shell(&launch.args[3]);
        assert!(!script.contains("__unimuxShell") && script.contains("$global:__unimuxExit = 0;"));
    }

    #[test]
    fn the_start_marks_are_the_ones_the_shell_wrote_before_the_cli() {
        assert_eq!(
            agent_start_marks(ShellKind::Pwsh, &[]),
            b"\x1b]133;D;0\x07\x1b]133;A\x07\x1b]133;B\x07\x1b]133;C\x07\x1b]6973;agent-start\x07"
        );
        assert_eq!(
            agent_start_marks(ShellKind::Cmd, &[]),
            b"\x1b]133;D\x1b\\\x1b]133;A\x1b\\\x1b]133;B\x1b\\\x1b]6973;agent-start\x07"
        );
        // cmd's marks are the ones its PROMPT writes.
        let prompt = cmd_prompt(None).replace("$E", "\x1b");
        assert!(prompt.starts_with("\x1b]133;D\x1b\\\x1b]133;A\x1b\\"));
        let off = env(&[(SHELL_INTEGRATION_ENV, "0")]);
        assert_eq!(agent_start_marks(ShellKind::Powershell, &off), AGENT_START_OSC);
    }

    fn env(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
        pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
    }

    #[test]
    fn encodes_utf16le_base64_like_btoa() {
        assert_eq!(encode_power_shell(""), "");
        assert_eq!(encode_power_shell("a"), "YQA=");
        assert_eq!(encode_power_shell("ab"), "YQBiAA==");
        assert_eq!(encode_power_shell("abc"), "YQBiAGMA");
        // A character above U+00FF keeps its high byte.
        assert_eq!(encode_power_shell("\u{0105}"), "BQE=");
    }

    #[test]
    fn cmd_gets_the_marks_in_its_prompt_and_keeps_a_user_prompt() {
        let launch = Launch::new("cmd.exe", &[]);
        let out = with_shell_integration(ShellKind::Cmd, &launch, &env(&[("A", "1")]), "C:\\t", Platform::Windows);
        assert_eq!(out.launch, launch);
        assert_eq!(out.env, env(&[("A", "1"), ("PROMPT", "$E]133;D$E\\$E]133;A$E\\$P$G$E]133;B$E\\")]));
        let out =
            with_shell_integration(ShellKind::Cmd, &launch, &env(&[("PROMPT", "$T$G"), ("B", "2")]), "x", Platform::Windows);
        assert_eq!(out.env[0], ("PROMPT".into(), "$E]133;D$E\\$E]133;A$E\\$T$G$E]133;B$E\\".into()));
        assert_eq!(out.env[1].0, "B");
        let blank = with_shell_integration(ShellKind::Cmd, &launch, &env(&[("PROMPT", "  ")]), "x", Platform::Windows);
        assert!(blank.env[0].1.contains("$P$G"));
    }

    #[test]
    fn powershell_gets_the_encoded_script_after_its_own_args() {
        let launch = Launch::new("C:\\pwsh.exe", &["-NoLogo"]);
        let out = with_shell_integration(ShellKind::Pwsh, &launch, &[], "x", Platform::Windows);
        assert_eq!(out.launch.args[..3], ["-NoLogo", "-NoExit", "-EncodedCommand"]);
        assert_eq!(out.launch.args[3], encode_power_shell(POWERSHELL_SCRIPT));
        assert!(out.files.is_empty());
    }

    #[test]
    fn bash_reads_the_init_file_zsh_and_the_switch_stay_untouched() {
        let launch = Launch::new("/bin/bash", &["-il"]);
        let out = with_shell_integration(ShellKind::Bash, &launch, &[], "/tmp/unimux-shell-501/", Platform::MacOs);
        assert_eq!(out.launch.args, ["--init-file", "/tmp/unimux-shell-501/bash-init.sh", "-i"]);
        assert_eq!(out.files, vec![("/tmp/unimux-shell-501/bash-init.sh".to_string(), BASH_INIT.to_string())]);
        let win_dir = with_shell_integration(ShellKind::Bash, &launch, &[], "C:\\t\\", Platform::Linux);
        assert_eq!(win_dir.launch.args[1], "C:\\t\\bash-init.sh");
        let zsh = Launch::new("/bin/zsh", &["-il"]);
        assert_eq!(with_shell_integration(ShellKind::Zsh, &zsh, &[], "/t", Platform::MacOs).launch, zsh);
        let off = env(&[(SHELL_INTEGRATION_ENV, "0")]);
        assert_eq!(with_shell_integration(ShellKind::Bash, &launch, &off, "/t", Platform::MacOs).launch, launch);
        let cmd = Launch::new("cmd.exe", &[]);
        assert_eq!(with_shell_integration(ShellKind::Cmd, &cmd, &off, "/t", Platform::Windows).env, off);
    }

    #[test]
    fn writes_the_helper_file_privately_and_rewrites_a_changed_one() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("unimux-shell-test");
        let launch = Launch::new("/bin/bash", &["-il"]);
        let (out, _) = integrated_launch(ShellKind::Bash, &launch, &[], Platform::Linux, &dir);
        let file = dir.join("bash-init.sh");
        assert_eq!(out.args[1], file.to_string_lossy());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), BASH_INIT);
        std::fs::write(&file, "echo planted").unwrap();
        integrated_launch(ShellKind::Bash, &launch, &[], Platform::Linux, &dir);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), BASH_INIT);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
            assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
            // A folder others can write is refused: the shell starts untouched.
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
            let (out, _) = integrated_launch(ShellKind::Bash, &launch, &[], Platform::Linux, &dir);
            assert_eq!(out, launch);
        }
    }
}
