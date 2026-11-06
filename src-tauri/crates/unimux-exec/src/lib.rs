//! Every child process of unimux goes through this crate (PLAN F14, ARCHITECTURE "Process tree rules"):
//!
//! - no console window (CREATE_NO_WINDOW), stdio always piped or null, never inherited and never mixed;
//! - the whole tree in a Job Object (Windows, kill-on-close, started suspended so no grandchild escapes before assignment) or
//!   its own process group (macOS), so a timeout or a quit kills everything the program started;
//! - [`clean_env`]: the variables of a parent agent session never leak into children (src/shared/env.ts);
//! - output caps (256 KiB per stream by default, like execFile's maxBuffer) and timeouts;
//! - raw Windows command lines (`cmd /d /s /c "..."` verbatim) for the CLI probes;
//! - [`spawn_detached`] for editors and the update window: breakaway from the job, so they outlive the app.
//!
//! The calls are blocking; async callers use [`run_async`] (tokio `spawn_blocking`), so a slow CreateProcess (a 300 MB
//! codex.exe takes about 0.8 s to map) never blocks the event loop.

use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
mod job;

/// Output kept per stream by default (EXEC_MAX_BUFFER of offMainExec.ts).
pub const DEFAULT_MAX_OUTPUT: usize = 256 * 1024;

/// `SESSION_ENV` of src/shared/env.ts: variables describing the session that launched us (a parent Claude Code). Leaking them
/// makes child `claude` instances think they are sub-sessions.
pub fn is_session_var(name: &str) -> bool {
    let n = name.to_ascii_uppercase();
    const EXACT: [&str; 11] = [
        "CLAUDECODE",
        "CLAUDE_PID",
        "CLAUDE_EFFORT",
        "AI_AGENT",
        "UNIMUX_MCP_TOKEN",
        "AJZ_MCP_TOKEN",
        "MC_CELL_ID",
        "CLAUDE_CODE_CHILD_SESSION",
        "CLAUDE_CODE_ENTRYPOINT",
        "CLAUDE_CODE_EXECPATH",
        "ELECTRON_RUN_AS_NODE",
    ];
    EXACT.contains(&n.as_str())
        || n == "ELECTRON_RENDERER_URL"
        || n.starts_with("CLAUDE_CODE_MESSAGING_")
        || n.starts_with("CLAUDE_CODE_SESSION_")
}

/// `cleanEnv(env)`: the environment without the session variables.
pub fn clean_env<I, K, V>(env: I) -> HashMap<OsString, OsString>
where
    I: IntoIterator<Item = (K, V)>,
    K: Into<OsString>,
    V: Into<OsString>,
{
    env.into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .filter(|(k, _): &(OsString, OsString)| !is_session_var(&k.to_string_lossy()))
        .collect()
}

/// The current process environment, cleaned.
pub fn clean_process_env() -> HashMap<OsString, OsString> {
    clean_env(std::env::vars_os())
}

/// What to run.
#[derive(Debug, Clone)]
pub enum Program {
    /// A program with an argv array (never through a shell).
    Args { program: PathBuf, args: Vec<OsString> },
    /// Windows only: the command line after the program name exactly as given (`cmd /d /s /c "..."` probes).
    Raw { program: PathBuf, raw: String },
}

#[derive(Debug, Clone)]
pub struct ExecOptions {
    /// The full environment of the child; None = the cleaned environment of this process.
    pub env: Option<HashMap<OsString, OsString>>,
    pub cwd: Option<PathBuf>,
    pub timeout: Duration,
    pub max_output: usize,
    pub stdin: Option<Vec<u8>>,
}

impl Default for ExecOptions {
    fn default() -> Self {
        Self { env: None, cwd: None, timeout: Duration::from_secs(10), max_output: DEFAULT_MAX_OUTPUT, stdin: None }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ExecOutput {
    /// The exit code; None when the program was killed (timeout) or ended by a signal.
    pub code: Option<i32>,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub timed_out: bool,
    /// A stream went over `max_output` (execFile fails then; callers decide).
    pub truncated: bool,
}

impl ExecOutput {
    /// Exited with 0 in time and within the caps (execFile's success).
    pub fn ok(&self) -> bool {
        self.code == Some(0) && !self.timed_out && !self.truncated
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ExecError {
    #[error("could not start {program}: {source}")]
    Spawn { program: String, source: io::Error },
    #[error("{0}")]
    Io(#[from] io::Error),
}

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
#[cfg(windows)]
const CREATE_SUSPENDED: u32 = 0x0000_0004;
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;
#[cfg(windows)]
const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;

fn command(program: &Program) -> Command {
    match program {
        Program::Args { program, args } => {
            let mut c = Command::new(program);
            c.args(args);
            c
        }
        Program::Raw { program, raw } => {
            let mut c = Command::new(program);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                c.raw_arg(raw);
            }
            #[cfg(not(windows))]
            {
                c.args(raw.split_whitespace());
            }
            c
        }
    }
}

fn program_name(program: &Program) -> String {
    match program {
        Program::Args { program, .. } | Program::Raw { program, .. } => program.display().to_string(),
    }
}

/// A started tree: the child and what kills its whole tree.
struct Tree {
    child: Child,
    #[cfg(windows)]
    job: job::Job,
}

impl Tree {
    fn kill(&mut self) {
        #[cfg(windows)]
        {
            self.job.terminate();
        }
        #[cfg(unix)]
        {
            let pid = self.child.id() as i32;
            // SAFETY: plain syscalls on our own process group.
            unsafe {
                libc::killpg(pid, libc::SIGTERM);
            }
            thread::sleep(Duration::from_millis(50));
            unsafe {
                libc::killpg(pid, libc::SIGKILL);
            }
        }
        let _ = self.child.kill();
    }
}

fn spawn_tree(program: &Program, options: &ExecOptions) -> Result<Tree, ExecError> {
    let mut cmd = command(program);
    cmd.env_clear();
    match &options.env {
        Some(env) => {
            cmd.envs(env);
        }
        None => {
            cmd.envs(clean_process_env());
        }
    }
    if let Some(cwd) = &options.cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdin(if options.stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        let job = job::Job::new_kill_on_close().map_err(ExecError::Io)?;
        let child = cmd.spawn().map_err(|source| ExecError::Spawn { program: program_name(program), source })?;
        let mut tree = Tree { child, job };
        if let Err(e) = tree.job.assign(&tree.child) {
            let _ = tree.child.kill();
            return Err(ExecError::Io(e));
        }
        job::resume_process(tree.child.id());
        Ok(tree)
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
        let child = cmd.spawn().map_err(|source| ExecError::Spawn { program: program_name(program), source })?;
        Ok(Tree { child })
    }
}

fn read_capped(mut r: impl Read + Send + 'static, cap: usize, over: Arc<AtomicBool>) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut out = Vec::new();
        let mut buf = [0u8; 16 * 1024];
        loop {
            match r.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let room = cap.saturating_sub(out.len());
                    out.extend_from_slice(&buf[..n.min(room)]);
                    if n > room {
                        over.store(true, Ordering::Relaxed);
                        // Keep draining so the child never blocks on a full pipe; the tree is killed by the waiter.
                    }
                }
            }
        }
        out
    })
}

/// Runs a program to its end (or its timeout / output cap, which kill the whole tree). Blocking.
pub fn run(program: &Program, options: &ExecOptions) -> Result<ExecOutput, ExecError> {
    let mut tree = spawn_tree(program, options)?;
    if let Some(input) = &options.stdin
        && let Some(mut stdin) = tree.child.stdin.take()
    {
        let input = input.clone();
        thread::spawn(move || {
            let _ = stdin.write_all(&input);
        });
    }
    let over = Arc::new(AtomicBool::new(false));
    let out = read_capped(tree.child.stdout.take().expect("piped stdout"), options.max_output, over.clone());
    let err = read_capped(tree.child.stderr.take().expect("piped stderr"), options.max_output, over.clone());
    let start = Instant::now();
    let mut timed_out = false;
    let status = loop {
        if let Some(status) = tree.child.try_wait()? {
            break Some(status);
        }
        if over.load(Ordering::Relaxed) {
            tree.kill();
            break tree.child.wait().ok();
        }
        if start.elapsed() >= options.timeout {
            timed_out = true;
            tree.kill();
            let _ = tree.child.wait();
            break None;
        }
        thread::sleep(Duration::from_millis(5));
    };
    // The tree may still hold the pipes (a grandchild): end it so the readers finish.
    tree.kill();
    let stdout = out.join().unwrap_or_default();
    let stderr = err.join().unwrap_or_default();
    Ok(ExecOutput {
        code: if timed_out { None } else { status.and_then(|s| s.code()) },
        stdout,
        stderr,
        timed_out,
        truncated: over.load(Ordering::Relaxed),
    })
}

/// [`run`] on tokio's blocking pool.
pub async fn run_async(program: Program, options: ExecOptions) -> Result<ExecOutput, ExecError> {
    tokio::task::spawn_blocking(move || run(&program, &options)).await.map_err(|e| ExecError::Io(io::Error::other(e)))?
}

/// Starts a program that must outlive unimux (an editor, `open -a`, the update window): out of the app's job, no console,
/// stdio null, never waited for. Returns its pid.
pub fn spawn_detached(
    program: &Program,
    env: Option<HashMap<OsString, OsString>>,
    cwd: Option<PathBuf>,
) -> Result<u32, ExecError> {
    let make = || {
        let mut cmd = command(program);
        cmd.env_clear();
        cmd.envs(env.clone().unwrap_or_else(clean_process_env));
        if let Some(cwd) = &cwd {
            cmd.current_dir(cwd);
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        cmd
    };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let base = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW;
        let mut cmd = make();
        cmd.creation_flags(base | CREATE_BREAKAWAY_FROM_JOB);
        match cmd.spawn() {
            Ok(child) => Ok(child.id()),
            // A job that forbids breakaway (some CI runners, terminals): start it inside, the best that is possible.
            Err(_) => {
                let mut cmd = make();
                cmd.creation_flags(base);
                cmd.spawn().map(|c| c.id()).map_err(|source| ExecError::Spawn { program: program_name(program), source })
            }
        }
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        let mut cmd = make();
        // A session of its own: no signal of the app's group reaches it.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        cmd.spawn().map(|c| c.id()).map_err(|source| ExecError::Spawn { program: program_name(program), source })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(script: &str) -> Program {
        if cfg!(windows) {
            Program::Raw { program: "cmd.exe".into(), raw: format!("/d /s /c \"{script}\"") }
        } else {
            Program::Args { program: "/bin/sh".into(), args: vec!["-c".into(), script.into()] }
        }
    }

    #[test]
    fn session_variables_are_dropped() {
        let env = clean_env([
            ("PATH", "/bin"),
            ("CLAUDECODE", "1"),
            ("claude_code_session_id", "x"),
            ("CLAUDE_CODE_MESSAGING_SOCKET", "y"),
            ("CLAUDE_CODE_ENTRYPOINT", "cli"),
            ("CLAUDE_CODE_USE_BEDROCK", "1"),
            ("UNIMUX_MCP_TOKEN", "t"),
            ("MC_CELL_ID", "c"),
            ("ELECTRON_RUN_AS_NODE", "1"),
            ("HOME", "/h"),
        ]);
        let mut keys: Vec<String> = env.keys().map(|k| k.to_string_lossy().into_owned()).collect();
        keys.sort();
        assert_eq!(keys, vec!["CLAUDE_CODE_USE_BEDROCK", "HOME", "PATH"]);
    }

    #[test]
    fn runs_and_captures() {
        let out = run(&shell("echo hello"), &ExecOptions::default()).unwrap();
        assert!(out.ok(), "{out:?}");
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "hello");
    }

    #[test]
    fn passes_stdin_and_env() {
        let mut env = clean_process_env();
        env.insert("UNIMUX_TEST_VAR".into(), "abc".into());
        let script = if cfg!(windows) { "echo %UNIMUX_TEST_VAR%" } else { "echo $UNIMUX_TEST_VAR" };
        let out = run(&shell(script), &ExecOptions { env: Some(env), ..Default::default() }).unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "abc");
        let cat = if cfg!(windows) { shell("findstr x") } else { shell("cat") };
        let out = run(&cat, &ExecOptions { stdin: Some(b"x1\n".to_vec()), ..Default::default() }).unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "x1");
    }

    #[test]
    fn a_timed_out_tree_is_killed() {
        // The shell starts a grandchild that would run for 30 s; the timeout ends both.
        let script = if cfg!(windows) { "ping -n 30 127.0.0.1 >nul" } else { "sleep 30" };
        let start = Instant::now();
        let out = run(&shell(script), &ExecOptions { timeout: Duration::from_millis(500), ..Default::default() }).unwrap();
        assert!(out.timed_out);
        assert_eq!(out.code, None);
        assert!(start.elapsed() < Duration::from_secs(10), "{:?}", start.elapsed());
    }

    #[test]
    fn output_over_the_cap_is_truncated_and_the_tree_ends() {
        let script = if cfg!(windows) {
            "for /L %i in (1,1,100000) do @echo 0123456789012345678901234567890123456789"
        } else {
            "yes 0123456789012345678901234567890123456789"
        };
        let out =
            run(&shell(script), &ExecOptions { timeout: Duration::from_secs(20), max_output: 256 * 1024, ..Default::default() })
                .unwrap();
        assert!(out.truncated);
        assert_eq!(out.stdout.len(), 256 * 1024);
        assert!(!out.ok());
    }

    #[test]
    fn a_missing_program_is_a_spawn_error() {
        let p = Program::Args { program: "definitely-not-a-program-unimux".into(), args: vec![] };
        assert!(matches!(run(&p, &ExecOptions::default()), Err(ExecError::Spawn { .. })));
    }

    #[test]
    fn detached_programs_start() {
        let dir = tempfile::tempdir().unwrap();
        let marker = dir.path().join("ran.txt");
        let script = if cfg!(windows) {
            format!("echo ran> \"{}\"", marker.display())
        } else {
            format!("echo ran > '{}'", marker.display())
        };
        spawn_detached(&shell(&script), None, None).unwrap();
        for _ in 0..200 {
            if marker.exists() {
                break;
            }
            thread::sleep(Duration::from_millis(25));
        }
        assert!(marker.exists());
    }
}
