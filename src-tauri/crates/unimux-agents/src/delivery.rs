//! H6: native delivery of a message to a running Codex session (port of src/main/agentDelivery.ts and the program run of
//! src/main/offMainExec.ts). `codex queue --thread <session> --message <text>` runs through unimux-exec on the blocking pool:
//! no shell, no console window, its own Job Object, so the 0.8 s CreateProcess of a big codex.exe never blocks the app (what
//! 1.1.4's Exec Host utility process was for).
//!
//! All user text travels in argv of a program started without a shell (H6: never through cmd.exe or PowerShell).

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::cli::status::{Env, Os, find_env_key};

/// A program with its argv, environment and time limit (`ExecCall`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecCall {
    pub file: String,
    pub args: Vec<String>,
    pub env: Env,
    pub timeout_ms: u64,
}

/// Output kept per stream; a program that prints more fails, as execFile's maxBuffer does (EXEC_MAX_BUFFER).
pub const EXEC_MAX_BUFFER: usize = 256 * 1024;

/// The error of a failed delivery: never the prompt, never the program's output.
pub const DELIVERY_FAILED: &str = "Native Codex delivery failed. Check that this Codex version supports queue and the session is running. The item remains in the inbox.";

/// How `codex queue` is started (`CodexLaunch`).
#[derive(Debug, Clone)]
pub struct CodexLaunch {
    /// The detected Codex binary or shim.
    pub command: Option<String>,
    /// A PATH that contains the detected binary (an app started from the GUI may not have codex on its own PATH), cleaned of the
    /// session variables.
    pub env: Env,
    pub os: Os,
}

/// Where npm puts the Codex entry script next to its shims (`<prefix>\codex.cmd`, `.ps1`, `codex`).
const NPM_CODEX_JS: &str = "node_modules\\@openai\\codex\\bin\\codex.js";

fn ends_with_ci(s: &str, suffix: &str) -> bool {
    s.len() >= suffix.len()
        && s.is_char_boundary(s.len() - suffix.len())
        && s[s.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
}

/// The folder of a Windows path (either separator); None for a bare name.
fn windows_dir(path: &str) -> Option<&str> {
    path.rfind(['\\', '/']).map(|i| &path[..i]).filter(|d| !d.is_empty())
}

/// A fully qualified Windows path (`C:\...` or `\\server\...`): never a name a PATH or current-folder lookup resolves.
fn is_absolute_windows(path: &str) -> bool {
    let b = path.as_bytes();
    (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')) || path.starts_with("\\\\")
}

/// The `node.exe` the npm shim itself would run: the one next to the shim, else the first `node.exe` in a fully qualified
/// folder of the PATH of `env`. Only a file literally named node.exe is taken (never node.cmd / .bat, which cmd.exe runs).
fn windows_node(shim_dir: &str, env: &Env, exists: &impl Fn(&str) -> bool) -> Option<String> {
    let local = format!("{shim_dir}\\node.exe");
    if exists(&local) {
        return Some(local);
    }
    let path = find_env_key(env, "PATH", Os::Windows).map(|i| env[i].1.as_str())?;
    path.split(';')
        .map(|d| d.trim().trim_matches('"').trim_end_matches(['\\', '/']))
        .filter(|d| is_absolute_windows(d))
        .map(|d| format!("{d}\\node.exe"))
        .find(|p| exists(p))
}

/// How Windows reaches Codex with no shell at all: the program, the arguments before `queue` and the time limit. A native
/// codex.exe is started directly; an npm install (codex.cmd / .bat / .ps1 or the extensionless shim) is resolved to
/// `node.exe <prefix>\node_modules\@openai\codex\bin\codex.js`, what the shim itself runs. Anything else (nothing detected,
/// a bare name, another kind of shim, a missing file) is None: a bare `codex` lookup could resolve to codex.cmd / .bat and
/// hand the message to cmd.exe, so the caller falls back to the prompt queue (H6).
fn windows_target(launch: &CodexLaunch, exists: &impl Fn(&str) -> bool) -> Option<(String, Vec<String>, u64)> {
    let command = launch.command.as_deref()?;
    if !is_absolute_windows(command) {
        return None;
    }
    let dir = windows_dir(command)?;
    let name = &command[dir.len() + 1..];
    if ends_with_ci(name, ".exe") {
        return Some((command.to_string(), Vec::new(), 10000));
    }
    if !["codex", "codex.cmd", "codex.bat", "codex.ps1"].iter().any(|n| name.eq_ignore_ascii_case(n)) {
        return None;
    }
    let script = format!("{dir}\\{NPM_CODEX_JS}");
    if !exists(&script) {
        return None;
    }
    let node = windows_node(dir, &launch.env, exists)?;
    Some((node, vec![script], 15000))
}

/// `codexQueueCall`, hardened (H6, beyond 1.1.4): the message only ever travels in argv of a program started without a
/// shell. Outside Windows the detected binary (or `codex`, looked up by execvp, never a shell) gets the arguments; on Windows
/// see [`windows_target`]. None when Windows cannot reach Codex that way (1.1.4 ran PowerShell `& codex ...`, whose `codex`
/// could be codex.cmd, so `&`, `|` or `"` in a task text written by another agent could run commands, and PowerShell 5.1
/// mangles `"` in native arguments).
pub fn codex_queue_call(
    session_id: &str,
    message: &str,
    launch: &CodexLaunch,
    exists: impl Fn(&str) -> bool,
) -> Option<ExecCall> {
    let queue = ["queue", "--thread", session_id, "--message", message].map(str::to_string);
    let env = launch.env.clone();
    if !launch.os.is_windows() {
        let file = launch.command.as_deref().unwrap_or("codex").to_string();
        return Some(ExecCall { file, args: queue.to_vec(), env, timeout_ms: 15000 });
    }
    let (file, mut args, timeout_ms) = windows_target(launch, &exists)?;
    args.extend(queue);
    Some(ExecCall { file, args, env, timeout_ms })
}

/// Whether [`codex_queue_call`] reaches Codex without any shell: always outside Windows; on Windows a detected codex.exe, or
/// an npm install with its codex.js and a node.exe. Otherwise the app skips the native delivery and uses the prompt queue.
pub fn reaches_codex_without_cmd(launch: &CodexLaunch, exists: impl Fn(&str) -> bool) -> bool {
    !launch.os.is_windows() || windows_target(launch, &exists).is_some()
}

/// Runs the call without a shell; true when the program exited with 0 in time and within the output caps. Never fails.
pub async fn run_call(call: ExecCall) -> bool {
    let program =
        unimux_exec::Program::Args { program: PathBuf::from(&call.file), args: call.args.iter().map(OsString::from).collect() };
    let options = unimux_exec::ExecOptions {
        env: Some(call.env.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()),
        cwd: None,
        timeout: Duration::from_millis(call.timeout_ms),
        max_output: EXEC_MAX_BUFFER,
        stop_at_cap: true,
        stdin: None,
    };
    unimux_exec::run_async(program, options).await.is_ok_and(|out| out.ok())
}

/// `queueCodexMessage`: `run` starts the call ([`run_call`] in the app); a failure is [`DELIVERY_FAILED`].
pub async fn queue_codex_message<F, Fut>(
    session_id: &str,
    message: &str,
    launch: &CodexLaunch,
    run: F,
) -> Result<(), &'static str>
where
    F: FnOnce(ExecCall) -> Fut,
    Fut: std::future::Future<Output = bool>,
{
    let Some(call) = codex_queue_call(session_id, message, launch, |p| Path::new(p).is_file()) else {
        return Err(DELIVERY_FAILED);
    };
    if run(call).await { Ok(()) } else { Err(DELIVERY_FAILED) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn launch(os: Os, command: Option<&str>, env: &[(&str, &str)]) -> CodexLaunch {
        CodexLaunch {
            command: command.map(str::to_string),
            env: env.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
            os,
        }
    }

    fn get<'a>(env: &'a Env, k: &str) -> Option<&'a str> {
        env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str())
    }

    const CODEX_JS: &str = "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";

    /// agent-delivery (H6): the message is one argv entry of a program started without a shell, on every OS; no shell, no
    /// environment variable and no script carries it.
    #[test]
    fn passes_untrusted_message_text_as_one_argument_without_any_shell() {
        let text = "Review\n\"quotes\"; $(whoami) `whoami` & echo injected %PATH% | calc ^& \\\"";
        let files = |p: &str| p == CODEX_JS || p == "C:\\Program Files\\nodejs\\node.exe";
        let env = [("Path", "C:\\npm;C:\\Program Files\\nodejs\\")];
        for shim in ["C:\\npm\\codex.cmd", "C:\\npm\\codex.bat", "C:\\npm\\CODEX.PS1", "C:\\npm\\codex"] {
            let win = codex_queue_call("known-session", text, &launch(Os::Windows, Some(shim), &env), files).unwrap();
            assert_eq!(win.file, "C:\\Program Files\\nodejs\\node.exe", "{shim}");
            assert_eq!(win.args, [CODEX_JS, "queue", "--thread", "known-session", "--message", text]);
            assert!(!win.file.to_lowercase().contains("powershell") && !win.file.to_lowercase().contains("cmd"));
            assert_eq!(get(&win.env, "UNIMUX_TASK_MESSAGE"), None);
            assert_eq!(win.timeout_ms, 15000);
        }
        let mac = codex_queue_call("known-session", text, &launch(Os::Mac, None, &[]), |_| false).unwrap();
        assert_eq!(mac.file, "codex");
        assert_eq!(mac.args, ["queue", "--thread", "known-session", "--message", text]);
    }

    /// agent-delivery: starts a native codex.exe directly and an npm install as node.exe + codex.js (the node.exe next to
    /// the shim first, as npm's shim does).
    #[test]
    fn starts_a_native_codex_exe_directly_and_an_npm_install_through_node_and_codex_js() {
        let text = "a \"quoted\" & message %PATH%";
        let exe = codex_queue_call(
            "s1",
            text,
            &launch(Os::Windows, Some("C:\\Users\\a\\.codex\\bin\\codex.exe"), &[("Path", "x")]),
            |_| false,
        );
        assert_eq!(
            exe,
            Some(ExecCall {
                file: "C:\\Users\\a\\.codex\\bin\\codex.exe".into(),
                args: ["queue", "--thread", "s1", "--message", text].iter().map(|s| s.to_string()).collect(),
                env: vec![("Path".into(), "x".into())],
                timeout_ms: 10000,
            })
        );
        let local = |p: &str| p == CODEX_JS || p == "C:\\npm\\node.exe" || p == "C:\\nodejs\\node.exe";
        let cmd =
            codex_queue_call("s1", text, &launch(Os::Windows, Some("C:\\npm\\codex.cmd"), &[("PATH", "C:\\nodejs")]), local)
                .unwrap();
        assert_eq!(cmd.file, "C:\\npm\\node.exe");
        assert_eq!(cmd.args[0], CODEX_JS);
        let mac = codex_queue_call("s1", text, &launch(Os::Mac, Some("/opt/codex"), &[]), |_| false).unwrap();
        assert_eq!(mac.file, "/opt/codex");
        assert_eq!(mac.args, ["queue", "--thread", "s1", "--message", text]);
    }

    /// H6: no codex.js, no node.exe, a bare or relative name, another shim, or a node.cmd / relative PATH entry: no call at
    /// all (the prompt queue takes the message), never a PATH lookup of `codex` that could hit codex.cmd.
    #[test]
    fn windows_without_a_shell_free_route_gives_no_call() {
        let path = [("Path", "node;.\\bin;C:\\tools")];
        let only = |files: &'static [&'static str]| move |p: &str| files.contains(&p);
        let none = |command: Option<&str>, files: &'static [&'static str]| {
            codex_queue_call("s1", "x", &launch(Os::Windows, command, &path), only(files)).is_none()
        };
        assert!(none(None, &[]));
        assert!(none(Some("codex"), &[]));
        assert!(none(Some("codex.cmd"), &[]));
        assert!(none(Some(".\\codex.exe"), &[]));
        assert!(none(Some("C:\\npm\\codex.cmd"), &["C:\\npm\\node.exe"]));
        assert!(none(Some("C:\\npm\\codex.cmd"), &[CODEX_JS]));
        assert!(none(Some("C:\\npm\\codex.cmd"), &[CODEX_JS, "C:\\tools\\node.cmd", "node\\node.exe", ".\\bin\\node.exe"]));
        assert!(none(Some("C:\\npm\\other.cmd"), &[CODEX_JS, "C:\\npm\\node.exe"]));
        assert!(none(Some("C:\\npm\\codex.vbs"), &[CODEX_JS, "C:\\npm\\node.exe"]));
        assert!(!none(Some("C:\\npm\\codex.cmd"), &[CODEX_JS, "C:\\tools\\node.exe"]));
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let mut ran = false;
        let r = rt.block_on(queue_codex_message("s1", "x", &launch(Os::Windows, Some("codex"), &[]), |_| {
            ran = true;
            async { true }
        }));
        assert_eq!(r, Err(DELIVERY_FAILED));
        assert!(!ran);
    }

    /// agent-delivery: reports a queue failure without leaking prompts or credentials; cli-ipc: the detected binary and PATH.
    #[test]
    fn reports_a_failure_without_the_prompt_and_passes_the_detected_binary_and_path() {
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();
        let l = launch(
            Os::current(),
            Some(if cfg!(windows) { "C:\\x\\codex.exe" } else { "/opt/x/codex" }),
            &[("PATH", "/opt/x:/usr/bin")],
        );
        let failed = rt.block_on(queue_codex_message("known-session", "private prompt", &l, |_| async { false }));
        assert_eq!(failed, Err(DELIVERY_FAILED));
        assert!(DELIVERY_FAILED.contains("item remains in the inbox") && !DELIVERY_FAILED.contains("private"));
        let mut seen = None;
        let ok = rt.block_on(queue_codex_message("s1", "hello", &l, |call| {
            seen = Some(call);
            async { true }
        }));
        assert_eq!(ok, Ok(()));
        let call = seen.unwrap();
        assert_eq!(get(&call.env, "PATH"), Some("/opt/x:/usr/bin"));
        assert_eq!(call.args, ["queue", "--thread", "s1", "--message", "hello"]);
    }

    /// off-main-exec: the program runs without a shell and a non-zero exit is a failure.
    #[test]
    fn runs_the_program_without_a_shell() {
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        let env: Env = std::env::vars().collect();
        let (ok, bad) = if cfg!(windows) {
            (
                ExecCall {
                    file: "cmd.exe".into(),
                    args: vec!["/d".into(), "/c".into(), "exit 0".into()],
                    env: env.clone(),
                    timeout_ms: 10000,
                },
                ExecCall {
                    file: "cmd.exe".into(),
                    args: vec!["/d".into(), "/c".into(), "exit 3".into()],
                    env,
                    timeout_ms: 10000,
                },
            )
        } else {
            (
                ExecCall {
                    file: "/bin/sh".into(),
                    args: vec!["-c".into(), "exit 0".into()],
                    env: env.clone(),
                    timeout_ms: 10000,
                },
                ExecCall { file: "/bin/sh".into(), args: vec!["-c".into(), "exit 3".into()], env, timeout_ms: 10000 },
            )
        };
        assert!(rt.block_on(run_call(ok)));
        assert!(!rt.block_on(run_call(bad)));
        let missing = ExecCall { file: "unimux-no-such-program-h6".into(), args: vec![], env: vec![], timeout_ms: 1000 };
        assert!(!rt.block_on(run_call(missing)));
    }

    /// H6 end to end on Windows: an npm-style install (codex.cmd next to node_modules\@openai\codex\bin\codex.js) is started
    /// as node.exe + codex.js and the script gets the message byte for byte, cmd.exe and PowerShell metacharacters included.
    /// Skipped when no node.exe is on the PATH.
    #[cfg(windows)]
    #[test]
    fn an_npm_install_gets_the_message_unchanged_through_node() {
        let env: Env = std::env::vars().collect();
        let has_node = std::env::var("PATH")
            .unwrap_or_default()
            .split(';')
            .any(|d| !d.is_empty() && Path::new(d).join("node.exe").is_file());
        if !has_node {
            return;
        }
        let root = std::env::temp_dir().join(format!("unimux-h6-{}", std::process::id()));
        let bin = root.join("node_modules").join("@openai").join("codex").join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(root.join("codex.cmd"), "@echo injected\r\n").unwrap();
        let out = root.join("argv.json");
        std::fs::write(
            bin.join("codex.js"),
            "require('fs').writeFileSync(process.env.UNIMUX_H6_OUT, JSON.stringify(process.argv.slice(2)));\n",
        )
        .unwrap();
        let mut env = env;
        env.push(("UNIMUX_H6_OUT".into(), out.to_string_lossy().into_owned()));
        let shim = root.join("codex.cmd").to_string_lossy().into_owned();
        let text = "Review \"this\" & echo pwned > x | calc %PATH% ^& `whoami` $(whoami) \\\" \\\\\"\nline 2 ' ;";
        let l = CodexLaunch { command: Some(shim), env, os: Os::Windows };
        let call = codex_queue_call("s-1", text, &l, |p| Path::new(p).is_file()).unwrap();
        assert!(call.file.to_lowercase().ends_with("\\node.exe"), "{}", call.file);
        let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(1).enable_all().build().unwrap();
        let ok = rt.block_on(run_call(call));
        let argv: Vec<String> = serde_json::from_str(&std::fs::read_to_string(&out).unwrap()).unwrap();
        let _ = std::fs::remove_dir_all(&root);
        assert!(ok);
        assert_eq!(argv, ["queue", "--thread", "s-1", "--message", text]);
    }

    /// M4 / H6: on Windows the native delivery only runs where no shell can parse the message.
    #[test]
    fn native_delivery_on_windows_needs_codex_exe_or_node_and_codex_js() {
        let files = |p: &str| p == CODEX_JS || p == "C:\\npm\\node.exe";
        let ok = |os, command: Option<&str>| reaches_codex_without_cmd(&launch(os, command, &[]), files);
        assert!(ok(Os::Mac, None));
        assert!(ok(Os::Windows, Some("C:\\Users\\a\\.codex\\bin\\CODEX.EXE")));
        assert!(ok(Os::Windows, Some("C:\\npm\\codex.cmd")));
        assert!(ok(Os::Windows, Some("C:\\npm\\codex.ps1")));
        assert!(ok(Os::Windows, Some("C:\\npm\\codex")));
        assert!(!ok(Os::Windows, None));
        assert!(!ok(Os::Windows, Some("codex")));
        assert!(!ok(Os::Windows, Some("C:\\other\\codex.cmd")));
        assert!(!ok(Os::Windows, Some("C:\\other\\codex.bat")));
    }
}
