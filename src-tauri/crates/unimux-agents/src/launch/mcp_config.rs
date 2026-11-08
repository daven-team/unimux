//! How a cell's MCP token reaches its agent (port of src/main/mcpCellConfig.ts). Claude Code reads it from the per-cell
//! `--mcp-config` file as a literal Authorization header, so the token is not in the agent's environment (every process the
//! agent starts would inherit it). Codex can take the bearer token only from its config (the command line) or from an
//! environment variable, so Codex keeps [`MCP_TOKEN_ENV`]; its name contains TOKEN, which Codex's default
//! `shell_environment_policy` keeps from the commands it runs.

use std::io;
use std::path::{Path, PathBuf};

use serde_json::json;
use unimux_core::atomic_write::{AtomicWriteOptions, atomic_write};

use super::McpLaunch;

/// The environment variable a Codex cell reads its MCP token from (Claude cells never get it).
pub const MCP_TOKEN_ENV: &str = "UNIMUX_MCP_TOKEN";

/// Claude Code's per-server tool timeout (ms) for unimux: above the longest wait_for of a Claude caller (600 s); it also
/// raises Claude Code's 60 s first-byte timer of HTTP servers.
pub const CLAUDE_MCP_TIMEOUT_MS: u64 = 660_000;

/// `claudeMcpConfigPath`: `<dir>/<cell>.json` (the cell file cleanup knows the same name).
pub fn claude_mcp_config_path(dir: &Path, cell: &str) -> PathBuf {
    dir.join(format!("{cell}.json"))
}

/// `claudeMcpConfig(url, token)`: the local http server with the cell's token as a literal header.
pub fn claude_mcp_config(url: &str, token: &str) -> String {
    let value = json!({ "mcpServers": { "unimux": {
        "type": "http", "url": url, "headers": { "Authorization": format!("Bearer {token}") }, "timeout": CLAUDE_MCP_TIMEOUT_MS,
    } } });
    unimux_core::js_json::stringify(&value)
}

/// `writeClaudeMcpConfig`: written atomically and private to the user (0600 in a 0700 folder on POSIX; on Windows the
/// folder is in the app's data dir under the user profile, whose ACL keeps other users out). Returns the path.
pub fn write_claude_mcp_config(dir: &Path, cell: &str, url: &str, token: &str) -> io::Result<PathBuf> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        // Best effort: the file itself is 0600.
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    let file = claude_mcp_config_path(dir, cell);
    atomic_write(
        &file,
        claude_mcp_config(url, token).as_bytes(),
        &AtomicWriteOptions { mode: Some(0o600), ..Default::default() },
    )?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600))?;
    }
    Ok(file)
}

/// `removeClaudeMcpConfig`: a locked file stays (the next start prunes it).
pub fn remove_claude_mcp_config(dir: &Path, cell: &str) {
    let _ = std::fs::remove_file(claude_mcp_config_path(dir, cell));
}

/// `prepareCellMcp`: the MCP part of one agent spawn. Writes or removes the per-cell file, sets or clears the token variable
/// in `env` (the cell's spawn environment, exact key like a JS object) and returns the launch options. `claude` is the
/// profile's CLI being Claude (any other agent goes the Codex way, as in 1.1.4).
pub fn prepare_cell_mcp(
    claude: bool,
    dir: &Path,
    cell: &str,
    url: &str,
    token: &str,
    env: &mut Vec<(String, String)>,
) -> io::Result<McpLaunch> {
    env.retain(|(k, _)| k != MCP_TOKEN_ENV);
    if claude {
        let path = write_claude_mcp_config(dir, cell, url, token)?;
        return Ok(McpLaunch {
            url: url.to_string(),
            token_env: None,
            claude_config_path: Some(path.to_string_lossy().into_owned()),
        });
    }
    remove_claude_mcp_config(dir, cell);
    env.push((MCP_TOKEN_ENV.to_string(), token.to_string()));
    Ok(McpLaunch { url: url.to_string(), token_env: Some(MCP_TOKEN_ENV.to_string()), claude_config_path: None })
}

#[cfg(test)]
mod tests {
    use super::super::{LaunchOptions, Profile, build_cli_command};
    use super::*;

    const URL: &str = "http://127.0.0.1:43210/mcp";

    fn token() -> String {
        format!("{}{}", "a".repeat(32), "b".repeat(32))
    }

    /// The spawn environment the app builds for a cell, from a parent that itself runs inside an older unimux cell.
    fn spawn_env() -> Vec<(String, String)> {
        let parent = vec![
            ("PATH".to_string(), "/usr/bin".to_string()),
            ("HOME".to_string(), "/tmp/fake-home".to_string()),
            (MCP_TOKEN_ENV.to_string(), "parent-token".to_string()),
        ];
        let mut env = crate::cli::status::clean_env(&parent);
        env.push(("MC_CELL_ID".into(), "c1".into()));
        env
    }

    fn profile(cli: &str) -> Profile {
        Profile { cli: cli.into(), args: String::new() }
    }

    fn names(dir: &Path) -> Vec<String> {
        let mut v: Vec<String> =
            std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        v.sort();
        v
    }

    #[test]
    fn keeps_the_token_out_of_a_claude_cell_environment_and_command_line_and_puts_it_in_the_config_as_a_literal_header() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("mcp");
        let mut env = spawn_env();
        let mcp = prepare_cell_mcp(true, &dir, "c1", URL, &token(), &mut env).unwrap();
        assert!(env.iter().all(|(_, v)| !v.contains(&token())));
        assert!(env.iter().all(|(k, _)| k != MCP_TOKEN_ENV));
        assert_eq!(mcp.claude_config_path.as_deref(), Some(dir.join("c1.json").to_string_lossy().as_ref()));
        let command = build_cli_command(&profile("claude"), &LaunchOptions { mcp: Some(mcp.clone()), ..Default::default() })
            .unwrap()
            .unwrap();
        assert!(command.contains("--mcp-config"));
        assert!(!command.contains(&token()));
        let text = std::fs::read_to_string(dir.join("c1.json")).unwrap();
        let config: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(
            config,
            json!({"mcpServers": {"unimux": {"type": "http", "url": URL, "headers": {"Authorization": format!("Bearer {}", token())}, "timeout": 660000}}})
        );
        assert!(!text.contains("${"));
        assert_eq!(names(&dir), vec!["c1.json"]);
    }

    #[test]
    fn gives_a_codex_cell_the_token_only_in_the_one_variable_codex_reads_it_from() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("mcp");
        let mut env = spawn_env();
        let mcp = prepare_cell_mcp(false, &dir, "c1", URL, &token(), &mut env).unwrap();
        assert_eq!(mcp, McpLaunch { url: URL.into(), token_env: Some(MCP_TOKEN_ENV.into()), claude_config_path: None });
        let holding: Vec<_> = env.iter().filter(|(_, v)| v.contains(&token())).collect();
        assert_eq!(holding, vec![&(MCP_TOKEN_ENV.to_string(), token())]);
        let command =
            build_cli_command(&profile("codex"), &LaunchOptions { mcp: Some(mcp), ..Default::default() }).unwrap().unwrap();
        assert!(command.contains(&format!("bearer_token_env_var=\"{MCP_TOKEN_ENV}\"")));
        assert!(!command.contains(&token()));
        assert!(!dir.join("c1.json").exists());
    }

    #[test]
    fn a_respawn_as_codex_removes_the_token_file_an_earlier_claude_spawn_of_the_cell_wrote() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("mcp");
        prepare_cell_mcp(true, &dir, "c1", URL, &token(), &mut spawn_env()).unwrap();
        assert!(dir.join("c1.json").exists());
        prepare_cell_mcp(false, &dir, "c1", URL, "next", &mut spawn_env()).unwrap();
        assert!(!dir.join("c1.json").exists());
    }

    #[test]
    fn replaces_the_config_of_a_respawn_with_the_new_token() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("mcp");
        write_claude_mcp_config(&dir, "c1", URL, "old-token").unwrap();
        write_claude_mcp_config(&dir, "c1", URL, &token()).unwrap();
        let text = std::fs::read_to_string(dir.join("c1.json")).unwrap();
        assert!(text.contains(&token()));
        assert!(!text.contains("old-token"));
    }

    #[cfg(unix)]
    #[test]
    fn writes_the_config_0600_in_a_0700_folder_on_posix() {
        use std::os::unix::fs::PermissionsExt as _;
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("mcp");
        let file = write_claude_mcp_config(&dir, "c1", URL, &token()).unwrap();
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(std::fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o644)).unwrap();
        write_claude_mcp_config(&dir, "c1", URL, &token()).unwrap();
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
