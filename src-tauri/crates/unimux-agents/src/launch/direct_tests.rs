//! The agent CLI started without a shell: its arguments against the launch line (every golden row of 1.1.4, split the way
//! the shell splits the line), the lookup of the program, and the command lines.

use std::path::PathBuf;

use serde_json::Value;

use super::super::{McpLaunch, build_cli_command, json};
use super::*;

fn s(v: &[&str]) -> Vec<String> {
    v.iter().map(|x| x.to_string()).collect()
}

fn prompt(text: &str) -> PromptFile {
    PromptFile { file: "C:\\data\\prompts\\c1-1.txt".into(), text: text.into() }
}

fn claude() -> Profile {
    Profile { cli: "claude".into(), args: String::new() }
}

fn codex() -> Profile {
    Profile { cli: "codex".into(), args: String::new() }
}

// ── the arguments ────────────────────────────────────────────────────────────

/// The words PowerShell passes for a launch line of `build_cli_command`: single-quoted literals (`''` is a quote), the
/// prompt's `(Get-Content ... -LiteralPath '<file>')` read as `text`, plain words split on whitespace.
fn split_powershell(line: &str, text: Option<&str>) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = line.chars().peekable();
    loop {
        while chars.peek().is_some_and(|c| is_js_space_char(*c)) {
            chars.next();
        }
        if chars.peek().is_none() {
            return out;
        }
        if chars.peek() == Some(&'(') {
            let mut quoted = false;
            for c in chars.by_ref() {
                if c == '\'' {
                    quoted = !quoted;
                }
                if c == ')' && !quoted {
                    break;
                }
            }
            out.push(text.expect("a prompt in the line").to_string());
            continue;
        }
        let mut word = String::new();
        while let Some(&c) = chars.peek() {
            if is_js_space_char(c) {
                break;
            }
            chars.next();
            if c == '\'' {
                loop {
                    match chars.next() {
                        Some('\'') if chars.peek() == Some(&'\'') => {
                            chars.next();
                            word.push('\'');
                        }
                        Some('\'') | None => break,
                        Some(c) => word.push(c),
                    }
                }
            } else {
                word.push(c);
            }
        }
        out.push(word);
    }
}

/// The words cmd.exe passes on (double quotes group and go).
fn split_cmd(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let (mut quoted, mut any) = (false, false);
    for c in line.chars() {
        if c == '"' {
            quoted = !quoted;
            any = true;
        } else if (c == ' ' || c == '\t') && !quoted {
            if any {
                out.push(std::mem::take(&mut word));
            }
            any = false;
        } else {
            word.push(c);
            any = true;
        }
    }
    if any {
        out.push(word);
    }
    out
}

fn golden_rows() -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/golden/launch.jsonl");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    text.lines().filter(|l| !l.is_empty()).map(|l| unimux_core::js_json::parse(l).expect("golden row")).collect()
}

#[test]
fn the_arguments_are_the_ones_the_shell_gave_the_cli_for_every_golden_row() {
    let (mut compared, mut fallbacks) = (0, 0);
    for row in golden_rows() {
        if row["fn"] != "buildCliCommand" {
            continue;
        }
        let args = row["args"].as_array().unwrap();
        let (profile, opts) = (json::profile(&args[0]), json::options(&args[1]));
        let Ok(Some(line)) = build_cli_command(&profile, &opts) else {
            assert_eq!(cli_args(&profile, &opts), None, "no CLI line, no direct start: {row}");
            continue;
        };
        let Some(direct) = cli_args(&profile, &opts) else {
            fallbacks += 1;
            continue;
        };
        let session = opts.session_id.as_deref().filter(|s| !s.is_empty());
        let p = if !opts.resume {
            opts.initial_prompt.as_ref()
        } else if session.is_some() {
            opts.resume_prompt.as_ref()
        } else {
            None
        };
        let words = match opts.shell {
            Shell::Cmd => {
                // cmd cannot carry a double quote inside a quoted word: those lines were broken in the shell too.
                if direct.iter().any(|a| a.contains('"')) {
                    continue;
                }
                split_cmd(&line)
            }
            _ => split_powershell(&line, p.map(|p| p.text.as_str())),
        };
        assert_eq!(words[0], profile.cli, "{line}");
        assert_eq!(words[1..], direct[..], "{line}");
        compared += 1;
    }
    assert!(compared > 100 && fallbacks > 10, "compared {compared}, fell back {fallbacks}");
}

#[test]
fn claude_gets_its_prompt_first_and_the_paths_unquoted() {
    let opts = LaunchOptions {
        session_id: Some("6f1c2b8e-1d2a".into()),
        claude_settings_path: Some("C:\\Users\\Jan Kowalski\\hooks\\claude-c1.json".into()),
        mcp: Some(McpLaunch { url: "u".into(), token_env: None, claude_config_path: Some("C:\\d\\mcp\\c1.json".into()) }),
        initial_prompt: Some(prompt("Fix the \"bug\"\nin main.ts  now")),
        system_prompt: Some("rules: don't wait".into()),
        model: Some("opus".into()),
        ..Default::default()
    };
    let profile = Profile { cli: "claude".into(), args: "--verbose -m sonnet".into() };
    assert_eq!(
        cli_args(&profile, &opts).unwrap(),
        s(&[
            "Fix the \"bug\"\nin main.ts  now",
            "--session-id",
            "6f1c2b8e-1d2a",
            "--settings",
            "C:\\Users\\Jan Kowalski\\hooks\\claude-c1.json",
            "--mcp-config",
            "C:\\d\\mcp\\c1.json",
            "--append-system-prompt",
            "rules: don t wait",
            "--verbose",
            "--model",
            "opus",
        ])
    );
    // cmd typed the prompt inline: whitespace squeezed, double quotes made single.
    let cmd = LaunchOptions { shell: Shell::Cmd, ..opts.clone() };
    assert_eq!(cli_args(&claude(), &cmd).unwrap()[0], "Fix the 'bug' in main.ts now");
    // A resume without a session id carries no prompt; a resume uses --resume.
    let resume = LaunchOptions { resume: true, resume_prompt: Some(prompt("again")), ..opts };
    let args = cli_args(&claude(), &resume).unwrap();
    assert_eq!(args[..3], s(&["again", "--resume", "6f1c2b8e-1d2a"]));
}

#[test]
fn codex_gets_its_overrides_and_the_prompt_last() {
    let opts = LaunchOptions {
        resume: true,
        session_id: Some("019a".into()),
        mcp: Some(McpLaunch {
            url: "http://127.0.0.1:43210/mcp".into(),
            token_env: Some("UNIMUX_MCP_TOKEN".into()),
            claude_config_path: None,
        }),
        resume_prompt: Some(prompt("next task")),
        ..Default::default()
    };
    assert_eq!(
        cli_args(&codex(), &opts).unwrap(),
        s(&[
            "resume",
            "019a",
            "-c",
            "tui.notifications=true",
            "-c",
            "mcp_servers.unimux.url=\"http://127.0.0.1:43210/mcp\"",
            "-c",
            "mcp_servers.unimux.bearer_token_env_var=\"UNIMUX_MCP_TOKEN\"",
            "-c",
            "mcp_servers.unimux.tool_timeout_sec=180",
            "next task",
        ])
    );
    let cmd = cli_args(&codex(), &LaunchOptions { shell: Shell::Cmd, ..opts.clone() }).unwrap();
    assert_eq!(cmd[5], "mcp_servers.unimux.url='http://127.0.0.1:43210/mcp'");
    let notify = LaunchOptions {
        codex_notify_url: Some("http://127.0.0.1:51234/h/0123456789abcdef0123456789abcdef/cell-1/codex/89abcdef01234567".into()),
        ..opts.clone()
    };
    let args = cli_args(&codex(), &notify).unwrap();
    assert!(args[3].starts_with("notify=['curl',"), "{args:?}");
    assert_eq!(cli_args(&codex(), &LaunchOptions { codex_notify_url: Some("https://evil".into()), ..opts }), None);
}

#[test]
fn shell_syntax_posix_shells_and_shell_profiles_keep_the_launch_line() {
    let opts = LaunchOptions::default();
    for args in
        ["$env:X", "'a b'", "\"a\"", "a;b", "a|b", "@x", "a,b", "`n", "a&b", "%X%", "a!b", "(x)", "~/x", "*.ts", "-c 'x=1'", "ą"]
    {
        let profile = Profile { cli: "claude".into(), args: args.into() };
        assert_eq!(cli_args(&profile, &opts), None, "{args}");
    }
    let profile = Profile { cli: "codex".into(), args: " --full-auto\t-c model_reasoning_effort=high  --cd C:\\p\\q+1 ".into() };
    let args = cli_args(&profile, &opts).unwrap();
    assert_eq!(args[2..], s(&["--full-auto", "-c", "model_reasoning_effort=high", "--cd", "C:\\p\\q+1"]));
    for shell in [Shell::Zsh, Shell::Bash] {
        assert_eq!(cli_args(&claude(), &LaunchOptions { shell, ..Default::default() }), None);
    }
    assert_eq!(cli_args(&Profile { cli: "shell".into(), args: String::new() }, &opts), None);
    assert_eq!(cli_args(&claude(), &LaunchOptions { model: Some("x; calc".into()), ..Default::default() }), None);
}

// ── the program ──────────────────────────────────────────────────────────────

fn dir() -> tempfile::TempDir {
    tempfile::Builder::new().prefix("mc-direct-").tempdir().unwrap()
}

fn path_env(dirs: &[&std::path::Path]) -> Vec<(String, String)> {
    let path = dirs.iter().map(|d| d.to_string_lossy().into_owned()).collect::<Vec<_>>().join(";");
    vec![("Path".into(), path), ("PATHEXT".into(), ".COM;.EXE;.BAT;.CMD;.VBS".into())]
}

const NPM_CMD: &str = "@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\"%dp0%\\node.exe\" \"%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js\" %*\r\n";

#[test]
fn finds_the_program_the_shell_would_run() {
    let (a, b, cwd) = (dir(), dir(), dir());
    let (pa, pb) = (a.path(), b.path());
    std::fs::write(pb.join("claude.exe"), "").unwrap();
    let env = path_env(&[pa, pb]);
    // The native installer's exe; the first folder that has the name wins.
    assert_eq!(find_cli("claude", Shell::Pwsh, &env, cwd.path()), Some(CliProgram::Exe(pb.join("claude.exe"))));
    std::fs::write(pa.join("claude.cmd"), "@echo off\r\nnode x.js %*\r\n").unwrap();
    assert_eq!(find_cli("claude", Shell::Powershell, &env, cwd.path()), Some(CliProgram::Batch(pa.join("claude.cmd"))));
    // A .ps1 next to it: PowerShell would run the script; only an npm shim pair is the same program.
    std::fs::write(pa.join("claude.ps1"), "& node x.js $args").unwrap();
    assert_eq!(find_cli("claude", Shell::Pwsh, &env, cwd.path()), None);
    std::fs::write(pa.join("claude.cmd"), NPM_CMD).unwrap();
    assert_eq!(find_cli("claude", Shell::Pwsh, &env, cwd.path()), Some(CliProgram::Batch(pa.join("claude.cmd"))));
    // cmd.exe never runs a .ps1, and looks into its current folder first.
    std::fs::remove_file(pa.join("claude.cmd")).unwrap();
    assert_eq!(find_cli("claude", Shell::Pwsh, &env, cwd.path()), None, "a lone .ps1");
    assert_eq!(find_cli("claude", Shell::Cmd, &env, cwd.path()), Some(CliProgram::Exe(pb.join("claude.exe"))));
    // A program in the working folder (a project folder: untrusted) is never started directly; cmd.exe would run it first,
    // so the typed launch line stays.
    std::fs::write(cwd.path().join("claude.bat"), "").unwrap();
    assert_eq!(find_cli("claude", Shell::Cmd, &env, cwd.path()), None);
    std::fs::remove_file(cwd.path().join("claude.bat")).unwrap();
    std::fs::write(cwd.path().join("claude.exe"), "").unwrap();
    assert_eq!(find_cli("claude", Shell::Cmd, &env, cwd.path()), None);
    std::fs::remove_file(cwd.path().join("claude.exe")).unwrap();
    assert_eq!(find_cli("claude", Shell::Cmd, &env, cwd.path()), Some(CliProgram::Exe(pb.join("claude.exe"))));
    std::fs::write(cwd.path().join("claude.bat"), "").unwrap();
    assert_eq!(find_cli("claude", Shell::Pwsh, &env, cwd.path()), None, "PowerShell does not look into the folder");
    // An .exe next to a .ps1 is ambiguous; a .com (first in PATHEXT) is not a program this starts.
    std::fs::write(pa.join("claude.exe"), "").unwrap();
    assert_eq!(find_cli("claude", Shell::Pwsh, &env, cwd.path()), None);
    std::fs::remove_file(pa.join("claude.ps1")).unwrap();
    assert_eq!(find_cli("claude", Shell::Pwsh, &env, cwd.path()), Some(CliProgram::Exe(pa.join("claude.exe"))));
    std::fs::write(pa.join("claude.com"), "").unwrap();
    assert_eq!(find_cli("claude", Shell::Pwsh, &env, cwd.path()), None);
    // Not on the PATH (a profile may add it), or a POSIX shell.
    assert_eq!(find_cli("codex", Shell::Pwsh, &env, cwd.path()), None);
    assert_eq!(find_cli("claude", Shell::Bash, &env, cwd.path()), None);
}

#[test]
fn relative_and_empty_path_entries_never_pick_the_program() {
    let (abs, cwd) = (dir(), dir());
    std::fs::write(abs.path().join("claude.exe"), "").unwrap();
    // A relative entry (it resolves against the working folder) that holds the name: the typed line stays.
    let rel = cwd.path().join("tools");
    std::fs::create_dir_all(&rel).unwrap();
    std::fs::write(rel.join("claude.exe"), "").unwrap();
    for entry in ["tools", ".\\tools"] {
        let env = vec![("PATH".to_string(), format!(";;{entry};{}", abs.path().display()))];
        assert_eq!(find_cli("claude", Shell::Pwsh, &env, cwd.path()), None, "{entry}");
        assert_eq!(find_cli("claude", Shell::Cmd, &env, cwd.path()), None, "{entry}");
        // A relative entry that holds nothing is passed over.
        let other = dir();
        assert_eq!(find_cli("claude", Shell::Pwsh, &env, other.path()), Some(CliProgram::Exe(abs.path().join("claude.exe"))));
    }
    // Empty entries are skipped; a drive-relative entry is not absolute.
    let env = vec![("PATH".to_string(), format!(" ; \"\" ;{}", abs.path().display()))];
    assert_eq!(find_cli("claude", Shell::Pwsh, &env, cwd.path()), Some(CliProgram::Exe(abs.path().join("claude.exe"))));
    assert!(!std::path::Path::new("C:tools").is_absolute());
}

#[test]
fn path_entries_in_quotes_and_names_in_any_case() {
    let (a, cwd) = (dir(), dir());
    std::fs::write(a.path().join("codex.CMD"), NPM_CMD).unwrap();
    let env = vec![("PATH".to_string(), format!(";\"{}\";", a.path().display()))];
    let Some(CliProgram::Batch(found)) = find_cli("codex", Shell::Pwsh, &env, cwd.path()) else { panic!("not found") };
    assert!(found.to_string_lossy().to_lowercase().ends_with("codex.cmd"));
}

// ── the command line ─────────────────────────────────────────────────────────

/// CommandLineToArgvW's rules (the C runtime of the CLI and of node.exe).
fn split_argv(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let chars: Vec<char> = line.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        while i < chars.len() && (chars[i] == ' ' || chars[i] == '\t') {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        let (mut word, mut quoted) = (String::new(), false);
        while i < chars.len() && (quoted || (chars[i] != ' ' && chars[i] != '\t')) {
            if chars[i] == '\\' {
                let start = i;
                while i < chars.len() && chars[i] == '\\' {
                    i += 1;
                }
                let n = i - start;
                if i < chars.len() && chars[i] == '"' {
                    word.extend(std::iter::repeat_n('\\', n / 2));
                    if n % 2 == 1 {
                        word.push('"');
                        i += 1;
                    }
                } else {
                    word.extend(std::iter::repeat_n('\\', n));
                }
                continue;
            }
            if chars[i] == '"' {
                quoted = !quoted;
            } else {
                word.push(chars[i]);
            }
            i += 1;
        }
        out.push(word);
    }
    out
}

#[test]
fn an_exe_gets_its_arguments_back_exactly() {
    let args = s(&["Fix the \"bug\"\nin main.ts", "", "C:\\a b\\", "x\\\"y", "tab\there", "plain", "\"a b\""]);
    let exe = CliProgram::Exe(PathBuf::from("C:\\Users\\Jan Kowalski\\.local\\bin\\claude.exe"));
    let cmd = direct_command(&exe, &args, Shell::Pwsh, &[]).unwrap();
    assert_eq!(cmd.file, "C:\\Users\\Jan Kowalski\\.local\\bin\\claude.exe");
    let argv = split_argv(&cmd.cmdline);
    assert_eq!(argv[0], cmd.file);
    assert_eq!(argv[1..], args[..]);
    // cmd expanded % and ! in the typed line: with cmd as the shell those keep the launch line.
    assert_eq!(direct_command(&exe, &s(&["50% done"]), Shell::Cmd, &[]), None);
    assert!(direct_command(&exe, &s(&["50% done"]), Shell::Powershell, &[]).is_some());
    assert_eq!(direct_command(&exe, &[format!("x{}", "a".repeat(33_000))], Shell::Pwsh, &[]), None);
}

#[test]
fn a_batch_shim_goes_through_cmd_with_its_arguments_quoted() {
    let shim = CliProgram::Batch(PathBuf::from("C:\\Users\\Jan Kowalski\\AppData\\Roaming\\npm\\codex.cmd"));
    let env = vec![("ComSpec".to_string(), "C:\\Windows\\system32\\cmd.exe".to_string())];
    let args = s(&[
        "-c",
        "notify=['curl','-s','--noproxy','*']",
        "a & b | c",
        "C:\\dir\\",
        "x=1,2",
        "developer_instructions='plain words'",
    ]);
    assert_eq!(cmd_arg("C:\\a b\\"), Some("\"C:\\a b\\\\\"".to_string()), "a quoted trailing backslash is doubled");
    let cmd = direct_command(&shim, &args, Shell::Pwsh, &env).unwrap();
    assert_eq!(cmd.file, "C:\\Windows\\system32\\cmd.exe");
    assert_eq!(
        cmd.cmdline,
        "C:\\Windows\\system32\\cmd.exe /s /c \"\"C:\\Users\\Jan Kowalski\\AppData\\Roaming\\npm\\codex.cmd\" -c \"notify=['curl','-s','--noproxy','*']\" \"a & b | c\" C:\\dir\\ x=1,2 \"developer_instructions='plain words'\"\""
    );
    // What the shim's %* hands node.exe splits back into the arguments.
    let inner = cmd.cmdline.split_once(" /s /c \"").unwrap().1.strip_suffix('"').unwrap();
    assert_eq!(split_argv(inner)[1..], args[..]);
    // What cmd.exe would expand or cannot carry keeps the launch line.
    for bad in ["100%", "wow!", "say \"hi\"", "two\nlines"] {
        assert_eq!(direct_command(&shim, &s(&[bad]), Shell::Pwsh, &env), None, "{bad}");
    }
    // Without ComSpec: SystemRoot's cmd.exe.
    let cmd = direct_command(&shim, &[], Shell::Pwsh, &[("SystemRoot".into(), "D:\\Win".into())]).unwrap();
    assert_eq!(cmd.file, "D:\\Win\\System32\\cmd.exe");
    assert_eq!(direct_command(&shim, &["a".repeat(8_100)], Shell::Pwsh, &env), None);
}

#[test]
fn the_whole_decision() {
    let (bin, cwd) = (dir(), dir());
    std::fs::write(bin.path().join("claude.exe"), "").unwrap();
    let env = path_env(&[bin.path()]);
    let opts = LaunchOptions { session_id: Some("s1".into()), ..Default::default() };
    let got = direct_launch(&claude(), &opts, &env, cwd.path()).unwrap();
    assert_eq!(split_argv(&got.cmdline)[1..], s(&["--session-id", "s1"]));
    // A multi-line prompt reaches an exe, never a shim.
    let with_prompt = LaunchOptions { initial_prompt: Some(prompt("line 1\nline 2")), ..opts.clone() };
    assert!(direct_launch(&claude(), &with_prompt, &env, cwd.path()).is_some());
    std::fs::remove_file(bin.path().join("claude.exe")).unwrap();
    std::fs::write(bin.path().join("claude.cmd"), "").unwrap();
    assert!(direct_launch(&claude(), &opts, &env, cwd.path()).is_some());
    assert_eq!(direct_launch(&claude(), &with_prompt, &env, cwd.path()), None);
    assert_eq!(direct_launch(&codex(), &opts, &env, cwd.path()), None, "not installed");
}
