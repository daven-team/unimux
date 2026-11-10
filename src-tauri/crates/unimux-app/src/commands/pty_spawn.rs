//! `cell:spawn` (P4; port of index.ts `spawnRequest` / `spawnRequestUnsafe`): starts a cell's terminal and, for an agent
//! profile, types its launch line into the shell.
//!
//! In order, as 1.1.4 does it:
//! 1. a fatal pty service refuses at once; the cell's kill count is taken before the first await (a kill while the folder or
//!    the CLI is being checked must not be undone by this spawn);
//! 2. the startup gates (W7: the hook and MCP servers listen and the cell files were pruned; a Claude cell also waits for the
//!    account recovery), the folder check (4 s), the CLI decision (H3, at most 7 s; only a definite "missing" refuses, unless
//!    the user chose "start anyway");
//! 3. the environment: `cleanEnv(process.env)` + MC_CELL_ID with the registry PATH and the detected CLI's folder (H3), the
//!    claude version the cell's PATH really starts (2 s) and its hook form / settings file (H2);
//! 4. a resume of a Claude conversation whose transcript is missing starts a new conversation with the same id; role cells
//!    get the startup / resume task prompt (the handed-over tasks count as delivered at startup), written to
//!    `prompts/<cell>-<seq36>.txt`;
//! 5. Claude cells bypass the proxy for 127.0.0.1; role cells get their MCP access (a 0600 config file for Claude, the
//!    token variable for Codex; otherwise the cell's MCP access ends), Codex its notify hook, a coordinator its delegation
//!    rules (unless the user's Codex config sets its own developer_instructions), role cells the exit URL of the reset tail;
//! 6. the bookkeeping (verifiedCodex, automation status `starting`, alive, the prompt file queue) and the spawn through
//!    the pty service; mark `first-spawn`. 1.2.0, Windows: the agent CLI starts as the terminal's own process with the
//!    arguments of the launch line and the shell follows it in the same terminal (no shell idles under every agent); the
//!    typed line stays where that is not certain (unimux-agents launch::direct) and with MC_AGENT_VIA_SHELL=1.
//!
//! A failure anywhere answers `{ok: false, error}` with the translated "Nie udało się uruchomić terminala: {error}" (the
//! cell shows it), never a rejected call that leaves the cell blank with an MCP token issued.
//!
//! Safety: the cell id names files (hooks, prompts, MCP config), so only `[A-Za-z0-9_-]{1,64}` ids are accepted; a session
//! id that is not a plain id is dropped (it is typed into the shell); the model is checked by the launch builder; prompts
//! reach the shell through a file (cmd: inline in double quotes with the quotes replaced, as in 1.1.4).

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use unimux_agents::cli::status::{CliSource, CliState, CliStatus, cli_for_profile, spawn_decision};
use unimux_agents::cli::{CliId, GetOptions};
use unimux_agents::hooks::claude::bypass_proxy_for_hooks;
use unimux_agents::hooks::route::find_cell;
use unimux_agents::launch::mcp_config::prepare_cell_mcp;
use unimux_agents::launch::{self, LaunchOptions, Profile, PromptFile, Shell, team};
use unimux_core::i18n::translate;
use unimux_core::utf16::js_trim;
use unimux_ipc::RouterBuilder;
use unimux_pty::manager::{AgentLaunch, SpawnRequest};
use unimux_pty::shell::ShellKind;
use unimux_state::normalize::js::truthy;

use super::{end_cell_mcp, host, service};
use crate::context::AppContext;
use crate::hooks::PLATFORM;

/// How long a spawn waits for its CLI's detection (index.ts `CLI_WAIT_MS`).
pub const CLI_WAIT_MS: u64 = 7000;
/// How long `versionFor` waits for `claude --version` of the cell's PATH.
const VERSION_WAIT_MS: u64 = 2000;
/// `pathExists` (src/main/fsProbe.ts `EXISTS_TIMEOUT_MS`).
const EXISTS_TIMEOUT: Duration = Duration::from_millis(4000);

/// The request of `window.mc.spawnCell` (`SpawnCellRequest` of src/preload/api.d.ts).
#[derive(Debug, Clone)]
struct SpawnCell {
    force: bool,
    cell: String,
    cwd: String,
    cols: u16,
    rows: u16,
    /// The profile as the renderer sent it (`cli`, `args`).
    profile: Profile,
    resume: bool,
    session_id: Option<String>,
    session_confirmed: bool,
    startup_prompt: Option<String>,
    resume_with_tasks: bool,
}

/// A cell id that can name a file: `[A-Za-z0-9_-]{1,64}` (the cell file cleanup knows only these).
pub fn is_cell_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// A session id that may be typed into the shell (Claude and Codex use UUIDs): `[A-Za-z0-9][A-Za-z0-9._-]{0,127}`.
pub fn is_plain_session_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 128
        && b[0].is_ascii_alphanumeric()
        && b[1..].iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}

/// A terminal size (`Math.max(2, cols)` / `Math.max(1, rows)`; anything that is no number gives 80 x 24).
fn size(v: &Value, min: u16, fallback: u16) -> u16 {
    match v.as_f64() {
        Some(n) if n.is_finite() => n.clamp(f64::from(min), f64::from(u16::MAX)) as u16,
        _ => fallback,
    }
}

fn parse_request(v: &Value) -> Option<SpawnCell> {
    let s = |k: &str| v.get(k).and_then(Value::as_str);
    let cell = s("cellId").filter(|c| is_cell_id(c))?.to_string();
    let profile = v.get("profile").filter(|p| p.is_object())?;
    Some(SpawnCell {
        force: v.get("force") == Some(&Value::Bool(true)),
        cell,
        cwd: s("cwd").unwrap_or("").to_string(),
        cols: size(v.get("cols").unwrap_or(&Value::Null), 2, 80),
        rows: size(v.get("rows").unwrap_or(&Value::Null), 1, 24),
        profile: launch::json::profile(profile),
        resume: s("mode") == Some("resume"),
        session_id: s("sessionId").filter(|id| is_plain_session_id(id)).map(str::to_string),
        session_confirmed: v.get("sessionConfirmed") == Some(&Value::Bool(true)),
        startup_prompt: s("startupPrompt").map(str::to_string),
        resume_with_tasks: v.get("resumeWithTasks") == Some(&Value::Bool(true)),
    })
}

/// The shell of Settings > Terminal (the platform's default when the state has none).
fn settings_shell(state: &Value) -> &str {
    match state.pointer("/settings/shell").and_then(Value::as_str) {
        Some(s) if ShellKind::parse(s).is_some() => s,
        _ if cfg!(windows) => "pwsh",
        _ if cfg!(target_os = "macos") => "zsh",
        _ => "bash",
    }
}

/// `cleanEnv(process.env)` with MC_CELL_ID appended (index.ts `{ ...cleanEnv(process.env), MC_CELL_ID }`).
fn base_env(cell: &str) -> Vec<(String, String)> {
    let own: Vec<(String, String)> =
        std::env::vars_os().map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned())).collect();
    let mut env = unimux_agents::cli::status::clean_env(&own);
    env.push(("MC_CELL_ID".into(), cell.to_string()));
    env
}

/// `env.CODEX_HOME || <home>/.codex`: whether the user's Codex config sets its own top-level developer_instructions.
fn user_codex_instructions(env: &[(String, String)]) -> bool {
    let codex_home = env
        .iter()
        .find(|(k, _)| k == "CODEX_HOME")
        .map(|(_, v)| v.as_str())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| unimux_core::home::home_dir().join(".codex"));
    std::fs::read_to_string(codex_home.join("config.toml")).is_ok_and(|t| launch::codex_config_sets_instructions(&t))
}

/// The agent CLI started without a shell (launch::direct), or None for the launch line: also when the detector found the CLI
/// only through the user's PowerShell profile (an alias or a PATH the profile builds: only the shell can run it).
fn direct_agent(
    profile: &Profile,
    opts: &LaunchOptions,
    env: &[(String, String)],
    cwd: &str,
    detected: Option<&CliStatus>,
) -> Option<AgentLaunch> {
    if detected.is_some_and(|s| s.state == CliState::Found && s.source == Some(CliSource::Shell)) {
        return None;
    }
    let direct = launch::direct::direct_launch(profile, opts, env, std::path::Path::new(cwd))?;
    Some(AgentLaunch {
        file: direct.file,
        cmdline: direct.cmdline,
        exit_url: opts.exit_url.clone().filter(|u| launch::is_exit_url(u)),
    })
}

fn tr(ctx: &AppContext, key: &str, params: &[(&str, &str)]) -> String {
    translate(&crate::lifecycle::language(ctx), key, params)
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    let c = Arc::downgrade(ctx);
    r.invoke("cell:spawn", move |call| {
        let c = c.clone();
        async move {
            let Some(ctx) = c.upgrade() else { return Ok(json!({ "ok": false, "error": "invalid request" })) };
            Ok(spawn_cell(&ctx, call.arg(0)).await)
        }
    });
}

/// `spawnRequest`: the answer of `cell:spawn` for one request.
pub async fn spawn_cell(ctx: &Arc<AppContext>, request: &Value) -> Value {
    let Some(req) = parse_request(request) else { return json!({ "ok": false, "error": "invalid request" }) };
    match spawn_unsafe(ctx, &req).await {
        Ok(answer) => answer,
        Err(message) => {
            ctx.crash.warn(&format!("spawn of a cell failed: {message}"));
            host().spawn_refused(ctx, &req.cell);
            json!({ "ok": false, "error": tr(ctx, "Nie udało się uruchomić terminala: {error}", &[("error", &message)]) })
        }
    }
}

async fn spawn_unsafe(ctx: &Arc<AppContext>, req: &SpawnCell) -> Result<Value, String> {
    let fatal = || json!({ "ok": false, "error": tr(ctx, "Proces terminali nie działa. Uruchom aplikację ponownie.", &[]) });
    if service().is_fatal() {
        return Ok(fatal());
    }
    let cell = req.cell.as_str();
    let profile_cli = req.profile.cli.as_str();
    let is_claude = profile_cli == "claude";
    let is_codex = profile_cli == "codex";
    // Taken before the first await: a kill while the folder or the CLI is being checked must not be undone by this spawn.
    let kills_before = host().kill_count(cell);
    // No agent starts before the hook and MCP servers have their ports, nor a Claude cell before the account recovery.
    let startup_prompt = if req.resume { None } else { req.startup_prompt.as_deref() };
    ctx.cells.gates.before_spawn(profile_cli, startup_prompt).await;
    if !unimux_git::path_exists(&req.cwd, EXISTS_TIMEOUT).await {
        return Ok(json!({ "ok": false, "error": tr(ctx, "Folder nie istnieje: {path}", &[("path", &req.cwd)]) }));
    }
    let detector = crate::commands::agents::cli_detector(ctx);
    let cli: Option<CliId> = cli_for_profile(profile_cli);
    // `force`: the user chose "start anyway" on the install card (the detection may be wrong, e.g. an alias).
    if let Some(id) = cli
        && !req.force
    {
        // A definite "not installed" never spawns a shell that would only print "command not found"; unknown fails open.
        let status = detector.get(id, GetOptions { wait_ms: CLI_WAIT_MS, force: false }).await;
        if spawn_decision(profile_cli, Some(&status)).is_err() {
            host().spawn_refused(ctx, cell);
            return Ok(json!({
                "ok": false,
                "error": tr(ctx, "{name} nie jest zainstalowany", &[("name", id.name())]),
                "cliMissing": id,
                "cliStatus": serde_json::to_value(&status).unwrap_or(Value::Null),
            }));
        }
    }
    let base = detector.apply_env(base_env(cell), cli).await;
    // The version of the claude this cell's PATH really starts (an older install earlier on the PATH must not get http hooks).
    let claude_version = if is_claude { detector.version_for(CliId::Claude, &base, VERSION_WAIT_MS).await } else { None };
    if host().kill_count(cell) != kills_before {
        return Ok(json!({ "ok": true })); // the cell was closed while the CLI was being looked up
    }
    let settings_path = if is_claude {
        let path = ctx.hooks.claude_spawn(cell, claude_version.as_deref(), &base, &req.cwd).map_err(|e| e.to_string())?;
        Some(path.to_string_lossy().into_owned())
    } else {
        ctx.hooks.other_spawn(cell);
        None
    };

    let mut resume = req.resume;
    // Claude only writes a transcript after the first prompt: resuming an unused id would fail, so start a new
    // conversation that keeps the same id instead.
    if resume
        && is_claude
        && let Some(id) = &req.session_id
    {
        let file = unimux_core::home::home_dir()
            .join(".claude")
            .join("projects")
            .join(unimux_agents::sessions::claude_project_dir_name(&req.cwd))
            .join(format!("{id}.jsonl"));
        if !file.exists() {
            resume = false;
        }
    }
    if resume && req.session_id.is_none() {
        resume = false;
    }

    let state = ctx.state.get();
    let role_cell = if profile_cli != "shell" { find_cell(&state, cell) } else { None };
    let role: Option<String> = role_cell
        .filter(|c| !truthy(c.get("ssh")))
        .and_then(|c| c.get("role"))
        .and_then(Value::as_str)
        .filter(|r| !r.is_empty())
        .map(str::to_string);
    let empty = Vec::new();
    let tasks = state.pointer("/automation/tasks").and_then(Value::as_array).unwrap_or(&empty);
    // 1.1.4: a role cell starts a new conversation with the tasks of its inbox it has not claimed; a resume the user asked
    // for gets a short note.
    let prompt_text: Option<String> = if !resume {
        match &role {
            Some(r) => team::startup_task_prompt(tasks, cell, r, req.startup_prompt.as_deref()),
            None => req.startup_prompt.clone(),
        }
    } else if let (Some(r), true, true) = (&role, req.resume_with_tasks, req.session_confirmed) {
        team::resume_task_prompt(tasks, cell, r)
    } else {
        None
    };
    let has_prompt = prompt_text.as_deref().is_some_and(|t| !js_trim(t).is_empty());
    // The tasks handed over in the startup prompt count as delivered there (no second notice through the prompt queue).
    if !resume && role.is_some() && has_prompt {
        let handed = team::handed_over_ids(tasks, cell);
        if !handed.is_empty() {
            let _ = ctx.state.change(
                |st| team::mark_startup_delivery(st, &handed).ok_or_else(|| "unchanged".to_string()),
                None,
                false,
            );
        }
    }
    let mut prompt_file: Option<PathBuf> = None;
    let mut initial_prompt: Option<PromptFile> = None;
    if let (true, Some(text)) = (has_prompt, &prompt_text) {
        let file = ctx.hooks.write_prompt(cell, text).map_err(|e| e.to_string())?;
        initial_prompt = Some(PromptFile { file: file.to_string_lossy().into_owned(), text: text.clone() });
        prompt_file = Some(file);
    }

    let mut env = base;
    // Claude Code's own requests to 127.0.0.1 (http hooks, the MCP server) would otherwise go through the user's proxy.
    if is_claude {
        bypass_proxy_for_hooks(&mut env, PLATFORM);
    }
    // The token reaches Claude through its per-cell --mcp-config file only; Codex can only read it from a variable.
    let has_role = profile_cli != "shell" && find_cell(&state, cell).and_then(|c| c.get("role")).is_some_and(|r| truthy(Some(r)));
    let server = crate::commands::mcp::server();
    let mcp = match (has_role, server.as_ref().and_then(|s| s.url().map(|u| (s, u)))) {
        (true, Some((server, url))) => {
            let token = server.issue_token(cell);
            Some(
                prepare_cell_mcp(is_claude, &ctx.hooks.cell_files.mcp, cell, &url, &token, &mut env)
                    .map_err(|e| e.to_string())?,
            )
        }
        _ => {
            end_cell_mcp(ctx, cell);
            None
        }
    };
    // Codex reports every finished turn (and its conversation id) to the hook server through a per-process `notify`.
    let codex_notify_url = if is_codex { Some(ctx.hooks.prepare_codex(cell)) } else { None };
    // A coordinator gets its delegation rules as system instructions (none in "ask" mode); the user's own Codex
    // developer_instructions are never replaced.
    let system_prompt = if mcp.is_some() && role.as_deref() == Some("coordinator") && !(is_codex && user_codex_instructions(&env))
    {
        launch::coordinator_system_rules(state.pointer("/settings/delegation"))
    } else {
        None
    };
    let shell_name = settings_shell(&state);
    let model = find_cell(&state, cell).and_then(|c| c.get("model")).and_then(Value::as_str).map(str::to_string);
    let exit_url = mcp.as_ref().map(|_| ctx.hooks.server.exit_url(cell));
    let opts = LaunchOptions {
        model,
        resume,
        session_id: req.session_id.clone(),
        claude_settings_path: settings_path,
        shell: Shell::parse(shell_name).unwrap_or_default(),
        codex_notify_url,
        mcp,
        initial_prompt: if resume { None } else { initial_prompt.clone() },
        resume_prompt: if resume { initial_prompt.clone() } else { None },
        system_prompt,
        exit_url,
    };
    let command = launch::build_launch_command(&req.profile, &opts).map_err(str::to_string)?;
    // Windows: the CLI as the terminal's own process (no shell idles under it), the shell after it; the line stays the
    // fallback (launch::direct says when) and the way back for A/B (MC_AGENT_VIA_SHELL=1, check builds).
    let agent = if command.is_some() && cfg!(windows) && !ctx.overrides.agent_via_shell {
        direct_agent(&req.profile, &opts, &env, &req.cwd, cli.and_then(|id| detector.peek(id)).as_ref())
    } else {
        None
    };

    host().set_verified_codex(cell, None);
    if is_codex
        && resume
        && req.session_confirmed
        && let Some(id) = &req.session_id
    {
        host().set_verified_codex(cell, Some(id));
    }
    host().spawning(cell);
    ctx.cells.set_alive(cell, true);
    ctx.hooks.queue_prompt(cell, prompt_file);
    let kind = ShellKind::parse(shell_name).unwrap_or(ShellKind::Pwsh);
    let mut spawn = SpawnRequest::new(cell, &req.cwd, kind);
    spawn.cols = req.cols;
    spawn.rows = req.rows;
    spawn.env = env;
    spawn.command = command;
    spawn.agent = agent;
    spawn.cell_id = Some(cell.to_string());
    if !service().spawn(spawn, false) {
        // Dropped by a service that went fatal or stopped meanwhile: nothing will report this terminal.
        ctx.hooks.release_prompt(cell);
        host().spawn_refused(ctx, cell);
        return Ok(fatal());
    }
    if !ctx.timer.has("first-spawn") {
        ctx.mark("first-spawn");
    }
    Ok(json!({ "ok": true, "startedWithPrompt": initial_prompt.is_some() }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_file_safe_cell_ids_and_plain_session_ids_are_taken() {
        assert!(is_cell_id("c-1_A"));
        assert!(!is_cell_id(""));
        assert!(!is_cell_id("..\\x"));
        assert!(!is_cell_id(&"a".repeat(65)));
        assert!(is_plain_session_id("6f1c2b8e-1d2a-4c3b-9e8f-0a1b2c3d4e5f"));
        assert!(!is_plain_session_id("x; calc"));
        assert!(!is_plain_session_id("-flag"));
    }

    #[test]
    fn parses_the_request_like_the_renderer_sends_it() {
        let req = parse_request(&json!({
            "cellId": "c1", "cwd": "C:\\p", "cols": 1.5, "rows": "x", "mode": "resume", "sessionId": "s 1",
            "profile": {"id": "claude", "name": "Claude", "cli": "claude", "args": "--verbose", "color": "#fff"},
            "force": "true", "sessionConfirmed": true, "startupPrompt": "hi",
        }))
        .unwrap();
        assert_eq!((req.cols, req.rows), (2, 24));
        assert!(req.resume && req.session_confirmed && !req.force && !req.resume_with_tasks);
        assert_eq!(req.session_id, None);
        assert_eq!(req.profile, Profile { cli: "claude".into(), args: "--verbose".into() });
        assert!(parse_request(&json!({"cellId": "../x", "profile": {}})).is_none());
        assert!(parse_request(&json!({"cellId": "c1"})).is_none());
    }
}
