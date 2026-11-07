//! test/cli-status-shared.test.ts ported (one #[test] per `it`, same names in test/PORTING.md).

use super::*;
use serde_json::json;

fn st(cli: CliId, state: CliState) -> CliStatus {
    CliStatus::new(cli, state, None, 1)
}

fn env(pairs: &[(&str, &str)]) -> Env {
    pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn strings(xs: &[&str]) -> Vec<String> {
    xs.iter().map(|s| s.to_string()).collect()
}

const W: Os = Os::Windows;
const M: Os = Os::Mac;
const L: Os = Os::Linux;

#[test]
fn only_agent_profiles_need_a_cli() {
    assert_eq!(cli_for_profile("claude"), Some(CliId::Claude));
    assert_eq!(cli_for_profile("codex"), Some(CliId::Codex));
    assert_eq!(cli_for_profile("shell"), None);
    assert_eq!(CliId::from_value(&json!("claude")), Some(CliId::Claude));
    assert_eq!(CliId::from_value(&json!("shell")), None);
    assert_eq!(CliId::from_value(&Value::Null), None);
}

#[test]
fn blocks_a_spawn_only_for_a_definite_missing_and_fails_open_otherwise() {
    assert_eq!(spawn_decision("claude", Some(&st(CliId::Claude, CliState::Missing))), Err(CliId::Claude));
    assert_eq!(spawn_decision("codex", Some(&st(CliId::Codex, CliState::Missing))), Err(CliId::Codex));
    assert_eq!(spawn_decision("claude", Some(&st(CliId::Claude, CliState::Found))), Ok(()));
    assert_eq!(spawn_decision("claude", Some(&st(CliId::Claude, CliState::Unknown))), Ok(()));
    assert_eq!(spawn_decision("claude", None), Ok(()));
    assert_eq!(spawn_decision("shell", Some(&st(CliId::Claude, CliState::Missing))), Ok(()));
}

#[test]
fn answers_availability_from_the_status_map() {
    let map: CliStatusMap =
        [(CliId::Claude, st(CliId::Claude, CliState::Missing)), (CliId::Codex, st(CliId::Codex, CliState::Found))].into();
    assert!(!profile_available("claude", Some(&map)));
    assert!(profile_available("codex", Some(&map)));
    assert!(profile_available("shell", Some(&map)));
    assert!(profile_available("claude", Some(&CliStatusMap::new())));
    assert_eq!(missing_cli("claude", Some(&map)), Some(CliId::Claude));
    assert_eq!(missing_clis(["claude", "claude", "codex", "shell"], Some(&map)), vec![CliId::Claude]);
}

#[test]
fn keeps_the_exact_documented_commands() {
    use InstallMethod::*;
    assert_eq!(install_command(CliId::Claude, M, Native), Some("curl -fsSL https://claude.ai/install.sh | bash"));
    assert_eq!(install_command(CliId::Claude, L, Native), Some("curl -fsSL https://claude.ai/install.sh | bash"));
    assert_eq!(install_command(CliId::Claude, W, Native), Some("irm https://claude.ai/install.ps1 | iex"));
    assert_eq!(install_command(CliId::Claude, W, Npm), Some("npm install -g @anthropic-ai/claude-code"));
    assert_eq!(install_command(CliId::Claude, M, Brew), Some("brew install --cask claude-code"));
    assert_eq!(install_command(CliId::Claude, W, Winget), Some("winget install Anthropic.ClaudeCode"));
    assert_eq!(install_command(CliId::Codex, M, Native), Some("curl -fsSL https://chatgpt.com/codex/install.sh | sh"));
    assert_eq!(
        install_command(CliId::Codex, W, Native),
        Some("powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\"")
    );
    assert_eq!(install_command(CliId::Codex, L, Npm), Some("npm install -g @openai/codex"));
    assert_eq!(install_command(CliId::Codex, M, Brew), Some("brew install --cask codex"));
}

#[test]
fn offers_a_tool_only_where_it_exists() {
    use InstallMethod::*;
    assert_eq!(install_command(CliId::Claude, M, Winget), None);
    assert_eq!(install_command(CliId::Claude, W, Brew), None);
    assert_eq!(install_command(CliId::Codex, W, Winget), None);
    assert_eq!(install_methods(CliId::Claude, W), vec![Native, Npm, Winget]);
    assert_eq!(install_methods(CliId::Codex, M), vec![Native, Npm, Brew]);
}

#[test]
fn only_documents_https_addresses_and_uses_no_em_dashes_anywhere() {
    assert_eq!(docs_url(CliId::Claude), "https://code.claude.com/docs/en/setup");
    assert_eq!(docs_url(CliId::Codex), "https://github.com/openai/codex");
    for cli in CliId::ALL {
        assert!(docs_url(cli).starts_with("https://"));
        for os in [W, M, L] {
            for m in InstallMethod::ALL {
                assert!(!install_command(cli, os, m).unwrap_or("").contains('\u{2014}'));
            }
        }
    }
}

#[test]
fn splits_per_platform_ignoring_empty_entries_and_quotes() {
    assert_eq!(split_path(Some("C:\\a;\"C:\\b c\";;"), W), strings(&["C:\\a", "C:\\b c"]));
    assert_eq!(split_path(Some("/a:/b::"), M), strings(&["/a", "/b"]));
    assert_eq!(split_path(None, L), Vec::<String>::new());
}

#[test]
fn merges_without_reordering_and_compares_windows_entries_case_insensitively() {
    assert_eq!(
        merge_paths(&strings(&["C:\\Windows", "C:\\Tools"]), &strings(&["c:\\tools\\", "C:\\New"]), W),
        strings(&["C:\\Windows", "C:\\Tools", "C:\\New"])
    );
    assert_eq!(merge_paths(&strings(&["/a"]), &strings(&["/A", "/b"]), L), strings(&["/a", "/A", "/b"]));
}

#[test]
fn puts_the_cli_directory_first_only_when_it_is_missing_from_the_path() {
    assert_eq!(
        prepend_dir(&strings(&["/usr/bin", "/bin"]), "/home/u/.local/bin", M),
        strings(&["/home/u/.local/bin", "/usr/bin", "/bin"])
    );
    assert_eq!(
        prepend_dir(&strings(&["/usr/bin", "/home/u/.local/bin"]), "/home/u/.local/bin", M),
        strings(&["/usr/bin", "/home/u/.local/bin"])
    );
}

#[test]
fn writes_path_under_the_key_the_environment_already_uses() {
    assert_eq!(find_env_key(&env(&[("Path", "x"), ("Other", "y")]), "PATH", W), Some(0));
    assert_eq!(find_env_key(&env(&[("Path", "x")]), "PATH", L), None);
    assert_eq!(with_path(&env(&[("Path", "old"), ("A", "1")]), "new", W), env(&[("Path", "new"), ("A", "1")]));
    assert_eq!(with_path(&env(&[("A", "1")]), "new", M), env(&[("A", "1"), ("PATH", "new")]));
}

#[test]
fn expands_registry_values_and_orders_machine_before_user() {
    assert_eq!(
        expand_windows_vars("%USERPROFILE%\\.local\\bin;%Missing%", &env(&[("userprofile", "C:\\Users\\a")])),
        "C:\\Users\\a\\.local\\bin;%Missing%"
    );
    let entries = registry_path_entries(
        &RegistryPath {
            machine: Some("C:\\Windows;C:\\Windows\\System32".into()),
            user: Some("%USERPROFILE%\\.local\\bin;C:\\windows;%UNKNOWN%\\x".into()),
        },
        &env(&[("USERPROFILE", "C:\\Users\\a")]),
    );
    assert_eq!(entries, strings(&["C:\\Windows", "C:\\Windows\\System32", "C:\\Users\\a\\.local\\bin"]));
    assert_eq!(registry_path_entries(&RegistryPath::default(), &[]), Vec::<String>::new());
    // `%%` holds no name; the regex then starts at the second `%`.
    assert_eq!(expand_windows_vars("a%%B%c", &env(&[("B", "x")])), "a%xc");
}

#[test]
fn parses_reg_query_output() {
    let out = "\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\.local\\bin;C:\\x y\r\n\r\n";
    assert_eq!(parse_reg_query_path(out).as_deref(), Some("%USERPROFILE%\\.local\\bin;C:\\x y"));
    assert_eq!(parse_reg_query_path("ERROR: The system was unable to find the specified registry key or value."), None);
}

#[test]
fn lists_the_documented_macos_linux_directories() {
    let dirs = known_cli_dirs(M, &[], "/Users/a");
    for d in [
        "/Users/a/.local/bin",
        "/Users/a/.claude/local",
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/Users/a/.npm-global/bin",
        "/Users/a/.bun/bin",
        "/Users/a/.volta/bin",
    ] {
        assert!(dirs.contains(&d.to_string()), "{d}");
    }
    assert!(versioned_cli_dirs(M, "/Users/a").iter().any(|(root, _)| root == "/Users/a/.nvm/versions/node"));
}

#[test]
fn lists_the_windows_directories_from_the_environment() {
    let dirs = known_cli_dirs(
        W,
        &env(&[("APPDATA", "C:\\Users\\a\\AppData\\Roaming"), ("LOCALAPPDATA", "C:\\Users\\a\\AppData\\Local")]),
        "C:\\Users\\a",
    );
    for d in [
        "C:\\Users\\a\\.local\\bin",
        "C:\\Users\\a\\AppData\\Roaming\\npm",
        "C:\\Users\\a\\AppData\\Local\\Microsoft\\WinGet\\Links",
        "C:\\Users\\a\\scoop\\shims",
    ] {
        assert!(dirs.contains(&d.to_string()), "{d}");
    }
}

#[test]
fn uses_pathext_on_windows_exe_first_and_the_bare_name_elsewhere() {
    assert_eq!(
        executable_names(CliId::Claude, W, Some(".COM;.EXE;.BAT;.CMD;.VBS;.PS1")),
        strings(&["claude.exe", "claude.com", "claude.bat", "claude.cmd"])
    );
    assert_eq!(executable_names(CliId::Codex, W, None)[0], "codex.exe");
    assert_eq!(executable_names(CliId::Codex, M, None), strings(&["codex"]));
}

#[test]
fn sorts_node_versions_newest_first_and_reads_the_npm_prefix() {
    assert_eq!(
        sort_versions_desc(&strings(&["v18.2.0", "v20.10.1", "v9.0.0", "system"])),
        strings(&["v20.10.1", "v18.2.0", "v9.0.0", "system"])
    );
    assert_eq!(npm_prefix_bin_dir("registry=x\nprefix=~/.npm-g\n", M, "/Users/a").as_deref(), Some("/Users/a/.npm-g/bin"));
    assert_eq!(npm_prefix_bin_dir("prefix=C:\\npm", W, "C:\\Users\\a").as_deref(), Some("C:\\npm"));
    assert_eq!(npm_prefix_bin_dir("prefix=${UNKNOWN}/x", M, "/Users/a"), None);
    assert_eq!(npm_prefix_bin_dir("nothing", M, "/Users/a"), None);
    // extra shapes of the regex: quotes, $HOME, an empty value is skipped
    assert_eq!(npm_prefix_bin_dir("prefix=\nprefix = \"$HOME/x/\"", M, "/h").as_deref(), Some("/h/x/bin"));
}

#[test]
fn parses_version_output_and_nothing_else() {
    assert_eq!(parse_version("2.1.211 (Claude Code)").as_deref(), Some("2.1.211"));
    assert_eq!(parse_version("codex-cli 0.5.0\n").as_deref(), Some("0.5.0"));
    assert_eq!(parse_version("sk-ant-secret token"), None);
    // the boundaries of the JS regex
    assert_eq!(parse_version("token sk-ant-123 1.2.3 more").as_deref(), Some("1.2.3"));
    assert_eq!(parse_version("v1.2.3-beta.1)").as_deref(), None);
    assert_eq!(parse_version("x 1.2.3-beta.").as_deref(), Some("1.2.3-beta"));
    assert_eq!(parse_version("1.2.3-").as_deref(), Some("1.2.3"));
    assert_eq!(parse_version("1.2.34a 4.5.6").as_deref(), Some("4.5.6"));
}

#[test]
fn builds_a_script_for_posix_shells_and_fish_none_for_others() {
    assert!(shell_probe_script("/bin/zsh").unwrap().contains("__AJZ_PATH__"));
    assert!(shell_probe_script("/usr/local/bin/fish").unwrap().contains("string join"));
    assert!(shell_probe_script("/usr/bin/nu").is_none());
}

#[test]
fn keeps_only_the_marker_lines_and_absolute_paths_and_reports_aliases_separately() {
    let out = "Welcome to my shell!\n\u{1b}[1mnoise\u{1b}[0m\n__AJZ_PATH__=/opt/homebrew/bin:/usr/bin:relative:/bin\n__AJZ_CLAUDE__=/Users/a/.local/bin/claude\n__AJZ_CODEX__=alias codex=foo\n";
    let p = parse_shell_probe(out);
    assert_eq!(p.path, strings(&["/opt/homebrew/bin", "/usr/bin", "/bin"]));
    assert_eq!(p.found, [(CliId::Claude, "/Users/a/.local/bin/claude".to_string())].into());
    assert_eq!(p.aliased, [CliId::Codex].into());
    assert_eq!(parse_shell_probe("nothing useful"), ShellProbe::default());
}

#[test]
fn builds_a_script_that_asks_for_both_clis() {
    let script = windows_command_probe_script();
    assert!(script.contains("Get-Command claude"));
    assert!(script.contains("Get-Command codex"));
    assert!(script.contains("__AJZ_CMD_CLAUDE__="));
    // byte-identical to the TS reference
    assert_eq!(
        script,
        "$c = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Write-Output ('__AJZ_CMD_CLAUDE__=' + $c.CommandType + '|' + $c.Source) } else { Write-Output '__AJZ_CMD_CLAUDE__=' }; $c = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { Write-Output ('__AJZ_CMD_CODEX__=' + $c.CommandType + '|' + $c.Source) } else { Write-Output '__AJZ_CMD_CODEX__=' }"
    );
}

#[test]
fn parses_application_paths_and_treats_everything_else_as_an_alias() {
    let out = "Loading profile...\r\n\u{1b}[32m__AJZ_CMD_CLAUDE__=Application|C:\\Tools\\claude.exe\u{1b}[0m\r\n__AJZ_CMD_CODEX__=Alias|cx\r\n";
    assert_eq!(
        parse_windows_command_probe(out),
        WindowsCommandProbe {
            ran: true,
            found: [(CliId::Claude, "C:\\Tools\\claude.exe".to_string())].into(),
            aliased: [CliId::Codex].into()
        }
    );
    assert_eq!(
        parse_windows_command_probe("__AJZ_CMD_CLAUDE__=\r\n__AJZ_CMD_CODEX__=\r\n"),
        WindowsCommandProbe { ran: true, ..Default::default() }
    );
    assert_eq!(parse_windows_command_probe("nothing"), WindowsCommandProbe::default());
    let rel = parse_windows_command_probe("__AJZ_CMD_CLAUDE__=Application|claude.exe");
    assert!(rel.found.is_empty());
    assert_eq!(rel.aliased, [CliId::Claude].into());
}

#[test]
fn mirrors_how_cells_pick_their_posix_shell() {
    assert_eq!(posix_shell_file(Some("zsh"), M), "/bin/zsh");
    assert_eq!(posix_shell_file(Some("bash"), M), "/bin/bash");
    assert_eq!(posix_shell_file(None, M), "/bin/zsh");
    assert_eq!(posix_shell_file(Some("zsh"), L), "/bin/zsh");
    assert_eq!(posix_shell_file(Some("powershell"), L), "/bin/bash");
}

#[test]
fn always_quotes_the_detected_path_on_windows_so_a_folder_like_r_and_d_works() {
    let found = |p: &str| CliStatus { path: Some(p.to_string()), ..st(CliId::Claude, CliState::Found) };
    assert_eq!(
        resolve_exec_file("claude", Some(&found("C:\\Users\\R&D\\.local\\bin\\claude.exe")), W),
        "\"C:\\Users\\R&D\\.local\\bin\\claude.exe\""
    );
    assert_eq!(resolve_exec_file("claude", Some(&found("C:\\Users\\a\\claude.exe")), W), "\"C:\\Users\\a\\claude.exe\"");
    assert_eq!(resolve_exec_file("claude", Some(&found("/Users/a/.local/bin/claude")), M), "/Users/a/.local/bin/claude");
    assert_eq!(resolve_exec_file("claude", Some(&found("C:\\100%\\claude.exe")), W), "claude");
    assert_eq!(resolve_exec_file("claude", Some(&found("C:\\a\"b\\claude.exe")), W), "claude");
    assert_eq!(resolve_exec_file("claude", Some(&st(CliId::Claude, CliState::Missing)), W), "claude");
    assert_eq!(resolve_exec_file("claude", None, M), "claude");
    assert_eq!(quote_for_cmd("C:\\a b\\x.exe").as_deref(), Some("\"C:\\a b\\x.exe\""));
}

#[test]
fn shows_the_card_for_a_held_cell_with_a_missing_cli_and_never_for_a_running_one() {
    let missing: CliStatusMap = [(CliId::Claude, st(CliId::Claude, CliState::Missing))].into();
    assert_eq!(missing_card_cli("claude", Some(&missing), true), Some(CliId::Claude));
    assert_eq!(missing_card_cli("claude", Some(&missing), false), None);
    assert_eq!(missing_card_cli("shell", Some(&missing), true), None);
    let unknown: CliStatusMap = [(CliId::Claude, st(CliId::Claude, CliState::Unknown))].into();
    assert_eq!(missing_card_cli("claude", Some(&unknown), true), None);
    assert_eq!(missing_card_cli("codex", Some(&missing), true), None);
}

#[test]
fn status_json_matches_the_ts_shape() {
    let s = CliStatus {
        path: Some("C:\\x\\claude.exe".into()),
        version: Some("2.1.211".into()),
        source: Some(CliSource::Known),
        ..st(CliId::Claude, CliState::Found)
    };
    let map: CliStatusMap =
        [(CliId::Codex, CliStatus::new(CliId::Codex, CliState::Unknown, Some(CliReason::RegistryFailed), 5)), (CliId::Claude, s)]
            .into();
    assert_eq!(
        serde_json::to_string(&map).unwrap(),
        r#"{"claude":{"cli":"claude","state":"found","path":"C:\\x\\claude.exe","version":"2.1.211","source":"known","checkedAt":1},"codex":{"cli":"codex","state":"unknown","reason":"registryFailed","checkedAt":5}}"#
    );
}

#[test]
fn node_path_join_and_dirname() {
    assert_eq!(join(W, &["C:\\foo\\", "claude.exe"]), "C:\\foo\\claude.exe");
    assert_eq!(join(W, &["C:/a/./b/../c", "x.cmd"]), "C:\\a\\c\\x.cmd");
    assert_eq!(join(W, &["\\\\srv\\share\\bin", "x.exe"]), "\\\\srv\\share\\bin\\x.exe");
    assert_eq!(join(M, &["/usr//local/bin/", "claude"]), "/usr/local/bin/claude");
    assert_eq!(join(M, &["/root", "v1", "installation/bin"]), "/root/v1/installation/bin");
    assert_eq!(dirname(W, "C:\\Users\\a\\.local\\bin\\claude.exe"), "C:\\Users\\a\\.local\\bin");
    assert_eq!(dirname(W, "C:\\claude.exe"), "C:\\");
    assert_eq!(dirname(M, "/usr/bin/claude"), "/usr/bin");
    assert_eq!(dirname(M, "/claude"), "/");
}
