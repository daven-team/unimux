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

#[cfg(test)]
mod tests {
    use super::*;

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
