//! H6: native delivery of a message to a running Codex session (port of src/main/agentDelivery.ts and the program run of
//! src/main/offMainExec.ts). `codex queue --thread <session> --message <text>` runs through unimux-exec on the blocking pool:
//! no shell, no console window, its own Job Object, so the 0.8 s CreateProcess of a big codex.exe never blocks the app (what
//! 1.1.4's Exec Host utility process was for).
//!
//! All user text travels in argv (no shell is involved) or in the environment (PowerShell), never in shell source.

use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::time::Duration;

use crate::cli::status::{Env, Os};

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

fn queue_script(target: &str) -> String {
    format!(
        "$ErrorActionPreference = 'Stop'; try {{ & {target} queue --thread $env:UNIMUX_TARGET_SESSION --message $env:UNIMUX_TASK_MESSAGE; exit $LASTEXITCODE }} catch {{ exit 1 }}"
    )
}

fn ends_with_ci(s: &str, suffix: &str) -> bool {
    s.len() >= suffix.len()
        && s.is_char_boundary(s.len() - suffix.len())
        && s[s.len() - suffix.len()..].eq_ignore_ascii_case(suffix)
}

/// `codexQueueCall`. Windows: the native installer's codex.exe is started directly (no PowerShell cold start); an npm install is
/// reached through its PowerShell shim (codex.ps1, also when the .cmd was detected: cmd.exe would parse the message), with this
/// process's execution policy bypassed so a Restricted machine policy does not refuse the shim.
pub fn codex_queue_call(session_id: &str, message: &str, launch: &CodexLaunch, exists: impl Fn(&str) -> bool) -> ExecCall {
    let argv = || ["queue", "--thread", session_id, "--message", message].iter().map(|s| s.to_string()).collect::<Vec<_>>();
    let base = launch.env.clone();
    let command = launch.command.as_deref();
    if !launch.os.is_windows() {
        return ExecCall { file: command.unwrap_or("codex").to_string(), args: argv(), env: base, timeout_ms: 15000 };
    }
    if let Some(exe) = command.filter(|c| ends_with_ci(c, ".exe")) {
        return ExecCall { file: exe.to_string(), args: argv(), env: base, timeout_ms: 10000 };
    }
    let script = command.map(|c| {
        if ends_with_ci(c, ".cmd") || ends_with_ci(c, ".bat") { format!("{}.ps1", &c[..c.len() - 4]) } else { c.to_string() }
    });
    let shim = script.filter(|s| ends_with_ci(s, ".ps1") && exists(s));
    let mut env = base;
    let mut set = |k: &str, v: &str| match env.iter_mut().find(|(n, _)| n == k) {
        Some(slot) => slot.1 = v.to_string(),
        None => env.push((k.to_string(), v.to_string())),
    };
    set("UNIMUX_TARGET_SESSION", session_id);
    set("UNIMUX_TASK_MESSAGE", message);
    if let Some(s) = &shim {
        set("UNIMUX_CODEX_PATH", s);
    }
    let target = if shim.is_some() { "$env:UNIMUX_CODEX_PATH" } else { "codex" };
    ExecCall {
        file: "powershell.exe".into(),
        args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]
            .iter()
            .map(|s| s.to_string())
            .chain([queue_script(target)])
            .collect(),
        env,
        timeout_ms: 15000,
    }
}

/// Whether [`codex_queue_call`] reaches Codex without cmd.exe ever parsing the message (hardening beyond 1.1.4, M4): always
/// outside Windows (argv, no shell); on Windows only a detected codex.exe (started directly) or an npm install whose
/// PowerShell shim exists. Otherwise PowerShell would look up a bare `codex`, which can resolve to codex.cmd / .bat and
/// hand the message to cmd.exe (`&`, `|`, `"` in a task text written by another agent could run commands); the app then
/// skips the native delivery and uses the prompt queue.
pub fn reaches_codex_without_cmd(launch: &CodexLaunch, exists: impl Fn(&str) -> bool) -> bool {
    if !launch.os.is_windows() {
        return true;
    }
    let Some(command) = launch.command.as_deref() else { return false };
    if ends_with_ci(command, ".exe") {
        return true;
    }
    let script = if ends_with_ci(command, ".cmd") || ends_with_ci(command, ".bat") {
        format!("{}.ps1", &command[..command.len() - 4])
    } else {
        command.to_string()
    };
    ends_with_ci(&script, ".ps1") && exists(&script)
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
    let call = codex_queue_call(session_id, message, launch, |p| Path::new(p).is_file());
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

    /// agent-delivery: passes untrusted message text as data, without interpolating it into shell source.
    #[test]
    fn passes_untrusted_message_text_as_data_without_interpolating_it_into_shell_source() {
        let text = "Review\n\"quotes\"; $(whoami) `whoami` & echo injected %PATH%";
        let win = codex_queue_call("known-session", text, &launch(Os::Windows, None, &[]), |_| false);
        assert_eq!(win.file, "powershell.exe");
        assert!(!win.args.join(" ").contains(text));
        assert_eq!(get(&win.env, "UNIMUX_TASK_MESSAGE"), Some(text));
        assert_eq!(get(&win.env, "UNIMUX_TARGET_SESSION"), Some("known-session"));
        assert!(win.args.last().unwrap().contains("catch { exit 1 }"));
        let mac = codex_queue_call("known-session", text, &launch(Os::Mac, None, &[]), |_| false);
        assert_eq!(mac.file, "codex");
        assert_eq!(mac.args, ["queue", "--thread", "known-session", "--message", text]);
    }

    /// agent-delivery: starts a native codex.exe directly and reaches an npm shim through its PowerShell script.
    #[test]
    fn starts_a_native_codex_exe_directly_and_reaches_an_npm_shim_through_its_powershell_script() {
        let text = "a \"quoted\" & message %PATH%";
        let exe = codex_queue_call(
            "s1",
            text,
            &launch(Os::Windows, Some("C:\\Users\\a\\.codex\\bin\\codex.exe"), &[("Path", "x")]),
            |_| false,
        );
        assert_eq!(
            exe,
            ExecCall {
                file: "C:\\Users\\a\\.codex\\bin\\codex.exe".into(),
                args: ["queue", "--thread", "s1", "--message", text].iter().map(|s| s.to_string()).collect(),
                env: vec![("Path".into(), "x".into())],
                timeout_ms: 10000,
            }
        );
        let cmd =
            codex_queue_call("s1", text, &launch(Os::Windows, Some("C:\\npm\\codex.cmd"), &[]), |p| p == "C:\\npm\\codex.ps1");
        assert_eq!(cmd.file, "powershell.exe");
        assert!(cmd.args.windows(2).any(|w| w == ["-ExecutionPolicy", "Bypass"]));
        assert!(cmd.args.last().unwrap().contains("& $env:UNIMUX_CODEX_PATH queue"));
        assert!(!cmd.args.join(" ").contains(text));
        assert_eq!(get(&cmd.env, "UNIMUX_CODEX_PATH"), Some("C:\\npm\\codex.ps1"));
        assert_eq!(get(&cmd.env, "UNIMUX_TASK_MESSAGE"), Some(text));
        assert_eq!(get(&cmd.env, "UNIMUX_TARGET_SESSION"), Some("s1"));
        // No script next to the shim: the PATH lookup, never cmd.exe with the message.
        let unknown = codex_queue_call("s1", text, &launch(Os::Windows, Some("C:\\npm\\codex.cmd"), &[]), |_| false);
        assert!(unknown.args.last().unwrap().contains("& codex queue"));
        assert_eq!(get(&unknown.env, "UNIMUX_CODEX_PATH"), None);
        let mac = codex_queue_call("s1", text, &launch(Os::Mac, Some("/opt/codex"), &[]), |_| false);
        assert_eq!(mac.file, "/opt/codex");
        assert_eq!(mac.args, ["queue", "--thread", "s1", "--message", text]);
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

    /// M4: on Windows the native delivery only runs where no cmd.exe can parse the message.
    #[test]
    fn native_delivery_on_windows_needs_codex_exe_or_its_powershell_shim() {
        let ps1 = |p: &str| p == "C:\\npm\\codex.ps1";
        let ok = |os, command: Option<&str>| reaches_codex_without_cmd(&launch(os, command, &[]), ps1);
        assert!(ok(Os::Mac, None));
        assert!(ok(Os::Windows, Some("C:\\Users\\a\\.codex\\bin\\CODEX.EXE")));
        assert!(ok(Os::Windows, Some("C:\\npm\\codex.cmd")));
        assert!(ok(Os::Windows, Some("C:\\npm\\codex.ps1")));
        assert!(!ok(Os::Windows, None));
        assert!(!ok(Os::Windows, Some("C:\\other\\codex.cmd")));
        assert!(!ok(Os::Windows, Some("C:\\other\\codex.bat")));
        assert!(!ok(Os::Windows, Some("C:\\npm\\codex")));
    }
}
