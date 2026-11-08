//! The launch line against the 1.1.4 reference (test/golden/launch.jsonl, scripts/goldens-launch.mjs) and the cases of
//! test/profiles.test.ts / termReset.test.ts that matter for the line.

use std::path::PathBuf;

use serde_json::{Value, json};

use super::*;

fn rows() -> Vec<Value> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../test/golden/launch.jsonl");
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
    text.lines().filter(|l| !l.is_empty()).map(|l| unimux_core::js_json::parse(l).expect("golden row")).collect()
}

fn opt_str(v: &Value) -> Option<&str> {
    v.as_str()
}

fn line_out(r: Result<Option<String>, &'static str>) -> Value {
    match r {
        Ok(Some(line)) => Value::String(line),
        Ok(None) => Value::Null,
        Err(e) => json!({ "error": e }),
    }
}

#[test]
fn every_golden_row_answers_like_the_ts_reference() {
    let mut checked = 0;
    for row in rows() {
        let fn_name = row["fn"].as_str().unwrap();
        let args = row["args"].as_array().unwrap();
        let out = &row["out"];
        let got = match fn_name {
            "buildCliCommand" => line_out(build_cli_command(&json::profile(&args[0]), &json::options(&args[1]))),
            "buildLaunchCommand" => line_out(build_launch_command(&json::profile(&args[0]), &json::options(&args[1]))),
            "withResetTail" => {
                let shell = opt_str(&args[1]).and_then(Shell::parse).unwrap_or_default();
                Value::String(with_reset_tail(args[0].as_str().unwrap(), shell, opt_str(&args[2])))
            }
            "shellSafeText" => Value::String(shell_safe_text(args[0].as_str().unwrap())),
            "coordinatorSystemRules" => {
                let raw = (!args[0].is_null()).then_some(&args[0]);
                coordinator_system_rules(raw).map_or(Value::Null, Value::String)
            }
            "startupTaskPrompt" => {
                let tasks = args[0].as_array().unwrap();
                team::startup_task_prompt(tasks, args[1].as_str().unwrap(), args[2].as_str().unwrap(), opt_str(&args[3]))
                    .map_or(Value::Null, Value::String)
            }
            "resumeTaskPrompt" => {
                let tasks = args[0].as_array().unwrap();
                team::resume_task_prompt(tasks, args[1].as_str().unwrap(), args[2].as_str().unwrap())
                    .map_or(Value::Null, Value::String)
            }
            "readyStartupTasks" => {
                let tasks = args[0].as_array().unwrap();
                Value::Array(
                    team::ready_startup_tasks(tasks, args[1].as_str().unwrap()).iter().map(|t| t["id"].clone()).collect(),
                )
            }
            "claudeMcpConfig" => {
                Value::String(mcp_config::claude_mcp_config(args[0].as_str().unwrap(), args[1].as_str().unwrap()))
            }
            "userCodexInstructions" => Value::Bool(codex_config_sets_instructions(args[0].as_str().unwrap())),
            // Checked by unimux-pty (tests/launch_goldens.rs).
            "withShellIntegration" | "encodePowerShell" => continue,
            other => panic!("unknown golden fn {other}"),
        };
        assert_eq!(&got, out, "{fn_name} {}", Value::Array(args.clone()));
        checked += 1;
    }
    assert!(checked > 1500, "only {checked} rows checked");
}

fn opts(shell: Shell) -> LaunchOptions {
    LaunchOptions { shell, ..Default::default() }
}

fn claude() -> Profile {
    Profile { cli: "claude".into(), args: String::new() }
}

fn codex() -> Profile {
    Profile { cli: "codex".into(), args: String::new() }
}

#[test]
fn claude_puts_the_prompt_first_because_mcp_config_is_variadic() {
    let o = LaunchOptions {
        initial_prompt: Some(PromptFile { file: "/p/c1-1.txt".into(), text: "task".into() }),
        mcp: Some(McpLaunch { url: "u".into(), token_env: None, claude_config_path: Some("/d/mcp/c1.json".into()) }),
        session_id: Some("s1".into()),
        ..opts(Shell::Bash)
    };
    let line = build_cli_command(&claude(), &o).unwrap().unwrap();
    assert_eq!(line, "claude \"$(cat '/p/c1-1.txt')\" --session-id s1 --mcp-config '/d/mcp/c1.json'");
}

#[test]
fn a_cell_model_replaces_the_profile_model_flag_and_a_bad_model_is_refused() {
    let p = Profile { cli: "claude".into(), args: "--model opus --verbose".into() };
    let line = build_cli_command(&p, &LaunchOptions { model: Some("sonnet".into()), ..opts(Shell::Pwsh) }).unwrap().unwrap();
    assert_eq!(line, "claude --verbose --model 'sonnet'");
    assert_eq!(build_cli_command(&p, &LaunchOptions { model: Some("a; rm".into()), ..opts(Shell::Pwsh) }), Err(INVALID_MODEL));
    assert_eq!(strip_model_flags("-m 'gpt 5' --x"), "  --x");
    assert_eq!(strip_model_flags("--model=\"a b\" -y"), "  -y");
    assert_eq!(strip_model_flags("--modelx y"), "--modelx y");
}

#[test]
fn codex_gets_notify_overrides_quoted_per_shell_and_the_mcp_server_with_its_token_variable() {
    let url = "http://127.0.0.1:51234/h/0123456789abcdef0123456789abcdef/cell-1/codex/89abcdef01234567";
    let o = LaunchOptions {
        codex_notify_url: Some(url.into()),
        mcp: Some(McpLaunch {
            url: "http://127.0.0.1:1/mcp".into(),
            token_env: Some("UNIMUX_MCP_TOKEN".into()),
            claude_config_path: None,
        }),
        ..opts(Shell::Cmd)
    };
    let line = build_cli_command(&codex(), &o).unwrap().unwrap();
    assert!(line.starts_with(&format!("codex -c \"notify=['curl','-s','--noproxy','*','-m','2','{url}','--data-raw']\"")));
    assert!(line.contains(
        "-c mcp_servers.unimux.url='http://127.0.0.1:1/mcp' -c mcp_servers.unimux.bearer_token_env_var='UNIMUX_MCP_TOKEN'"
    ));
    assert!(line.ends_with("-c mcp_servers.unimux.tool_timeout_sec=180"));
    // A URL that is not ours never reaches the line.
    let bad = LaunchOptions { codex_notify_url: Some("http://evil/'; x".into()), ..opts(Shell::Bash) };
    assert!(build_cli_command(&codex(), &bad).is_err());
}

// codex-hooks "quotes the overrides for PowerShell, bash/zsh and cmd", "resumes the saved conversation of the cell with its
// own hook and keeps profile args and model", "keeps the plain terminal notifications when no hook url is given", "resumes
// each cell with its own saved conversation, in every shell"
#[test]
fn codex_resumes_each_cell_with_its_own_conversation_and_hook_in_every_shell() {
    let url = |cell: &str| format!("http://127.0.0.1:51234/h/0123456789abcdef0123456789abcdef/{cell}/codex/89abcdef01234567");
    let notify = |cell: &str| format!("notify=['curl','-s','--noproxy','*','-m','2','{}','--data-raw']", url(cell));
    let hooked = |shell: Shell| LaunchOptions { codex_notify_url: Some(url("c1")), ..opts(shell) };
    let ps = build_cli_command(&codex(), &hooked(Shell::Pwsh)).unwrap().unwrap();
    assert!(ps.starts_with(&format!("codex -c '{}' -c '", notify("c1").replace('\'', "''"))), "{ps}");
    let posix = build_cli_command(&codex(), &hooked(Shell::Bash)).unwrap().unwrap();
    assert!(posix.starts_with(&format!("codex -c '{}' -c '", notify("c1").replace('\'', "'\"'\"'"))), "{posix}");
    assert_eq!(build_cli_command(&codex(), &hooked(Shell::Zsh)).unwrap().unwrap(), posix);
    let cmd = build_cli_command(&codex(), &hooked(Shell::Cmd)).unwrap().unwrap();
    assert!(cmd.starts_with(&format!("codex -c \"{}\" -c \"", notify("c1"))), "{cmd}");
    for line in [&ps, &posix, &cmd] {
        assert!(!line.contains("tui.notifications=true"), "{line}");
    }
    // No hook URL: the plain terminal notifications.
    assert_eq!(build_cli_command(&codex(), &opts(Shell::Pwsh)).unwrap().unwrap(), "codex -c tui.notifications=true");

    let p = Profile { cli: "codex".into(), args: "--no-alt-screen".into() };
    let b = "019a1b2c-3d4e-7f80-9a1b-2c3d4e5f6071";
    let resume = LaunchOptions {
        resume: true,
        session_id: Some(b.into()),
        codex_notify_url: Some(url("c1")),
        model: Some("gpt-5".into()),
        ..opts(Shell::Bash)
    };
    let line = build_cli_command(&p, &resume).unwrap().unwrap();
    assert!(line.starts_with(&format!("codex resume {b} -c ")), "{line}");
    assert!(line.contains(&url("c1")) && line.ends_with("--no-alt-screen --model 'gpt-5'"), "{line}");
    assert!(!line.contains("tui.notifications=true"), "{line}");

    for (cell, id) in [("c1", "019a1b2c-3d4e-7f80-9a1b-000000000001"), ("c2", b)] {
        for shell in [Shell::Pwsh, Shell::Bash, Shell::Cmd] {
            let o = LaunchOptions { resume: true, session_id: Some(id.into()), codex_notify_url: Some(url(cell)), ..opts(shell) };
            let line = build_cli_command(&codex(), &o).unwrap().unwrap();
            assert!(line.starts_with(&format!("codex resume {id} -c ")), "{cell} {shell:?}: {line}");
            assert!(line.contains(&format!("/{cell}/codex/")), "{cell} {shell:?}: {line}");
        }
    }
}

#[test]
fn the_reset_tail_runs_however_the_cli_ended_and_posts_only_to_our_exit_url() {
    let url = "http://127.0.0.1:5/x/c1/0123456789abcdef";
    assert_eq!(
        with_reset_tail("claude", Shell::Bash, Some(url)),
        format!(
            "trap : INT; claude; __mc_exit=$?; curl -s --noproxy '*' -m 2 -X POST '{url}/'$__mc_exit >/dev/null 2>&1; printf '\\033[?1000;1002;1003;1005;1006;1015;1004;2004l\\033[<u'; trap - INT"
        )
    );
    // Windows shells never clear 1004 (ConPTY owns it).
    assert!(!with_reset_tail("claude", Shell::Pwsh, None).contains("1004"));
    assert!(!with_reset_tail("claude", Shell::Cmd, Some("http://127.0.0.1:5/x/c1/0123456789abcdef & calc")).contains("calc"));
    assert_eq!(start_clear(Shell::Cmd), "cls & ");
}

#[test]
fn shell_safe_text_leaves_plain_words_only() {
    assert_eq!(shell_safe_text("a \"b\" & c$d\\e\n"), "a b c d e");
    assert!(coordinator_system_rules(Some(&json!({"mode": "ask"}))).is_none());
    let rules = coordinator_system_rules(Some(&json!({"maxAgents": 7}))).unwrap();
    assert!(rules.contains("Use at most 7 agents at once."));
}

#[test]
fn codex_config_instructions_count_only_at_the_top_level() {
    assert!(codex_config_sets_instructions("model = 1\ndeveloper_instructions = \"x\"\n[t]\n"));
    assert!(!codex_config_sets_instructions("[t]\ndeveloper_instructions = \"x\"\n"));
    assert!(!codex_config_sets_instructions("# developer_instructions = 1"));
}

#[test]
fn launch_line_answer_has_the_cli_line_and_the_full_typed_line() {
    let (answer, code) = json::launch_line_answer(&json!({
        "profile": {"id": "codex", "name": "Codex", "cli": "codex", "args": ""},
        "opts": {"mode": "new", "shell": "bash", "mcp": {"url": "http://127.0.0.1:65000/mcp", "tokenEnv": "UNIMUX_MCP_TOKEN"}},
    }));
    assert_eq!(code, 0);
    let line = answer["line"].as_str().unwrap();
    assert!(line.starts_with("codex -c tui.notifications=true -c 'mcp_servers.unimux.url=\"http://127.0.0.1:65000/mcp\"'"));
    assert!(answer["launch"].as_str().unwrap().contains(line));
    let (shell, _) = json::launch_line_answer(&json!({"profile": {"cli": "shell"}, "opts": {"mode": "new"}}));
    assert_eq!(shell, json!({"line": null, "launch": null}));
    let (bad, code) = json::launch_line_answer(&json!({"profile": {"cli": "claude"}, "opts": {"mode": "new", "model": "x y"}}));
    assert_eq!((bad["error"].as_str(), code), (Some("MC_FAILED"), 1));
}
