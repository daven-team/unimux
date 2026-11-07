//! Real I/O for the [`CliDetector`](super::CliDetector) (port of src/main/cliSystem.ts): files through tokio, programs through
//! unimux-exec on the blocking pool (no console, Job Object per tree, capped output, timeout kills the tree), the registry PATH
//! through RegGetValueW with RRF_NOEXPAND (the raw REG_EXPAND_SZ text `reg query` printed in 1.1.4, without a cmd.exe run).

use std::ffi::OsString;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use unimux_exec::{ExecOptions, Program};

use super::detector::{CliDeps, ExecRequest, ExecResult};
use super::status::{Env, Os, RegistryPath};

/// Output kept from a probe (`OUTPUT_LIMIT` of cliSystem.ts).
const OUTPUT_LIMIT: usize = 256 * 1024;
/// ~/.npmrc larger than this is not read.
const MAX_TEXT: usize = 64 * 1024;

/// Options of [`SystemCliDeps`] (`systemCliDeps(options)`).
#[derive(Clone, Default)]
pub struct SystemOptions {
    /// `MC_CLI_NO_REGISTRY` (dev-overrides builds): UI checks run against a sanitized PATH.
    pub disable_registry: bool,
    /// settings.shell of the current state.
    pub shell: Option<Arc<dyn Fn() -> Option<String> + Send + Sync>>,
    /// `MC_CLI_PROBE_PROFILE` (dev-overrides builds).
    pub probe_profile: Option<String>,
}

pub struct SystemCliDeps {
    options: SystemOptions,
}

impl SystemCliDeps {
    pub fn new(options: SystemOptions) -> Arc<Self> {
        Arc::new(Self { options })
    }
}

/// The process environment as an ordered list (a variable that is not valid UTF-16/UTF-8 is converted lossily).
pub fn process_env() -> Env {
    std::env::vars_os().map(|(k, v)| (k.to_string_lossy().into_owned(), v.to_string_lossy().into_owned())).collect()
}

/// Runs a program with stdin closed, a hard timeout and capped output; never fails (`runProgram`).
pub async fn run_program(request: ExecRequest) -> ExecResult {
    let program = if request.verbatim && cfg!(windows) {
        Program::Raw { program: PathBuf::from(&request.file), raw: request.args.join(" ") }
    } else {
        Program::Args { program: PathBuf::from(&request.file), args: request.args.iter().map(OsString::from).collect() }
    };
    let options = ExecOptions {
        env: Some(request.env.iter().map(|(k, v)| (OsString::from(k), OsString::from(v))).collect()),
        cwd: None,
        timeout: Duration::from_millis(request.timeout_ms),
        max_output: OUTPUT_LIMIT,
        stdin: None,
    };
    match unimux_exec::run_async(program, options).await {
        Ok(out) => ExecResult {
            ok: out.code == Some(0) && !out.timed_out,
            stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
            timed_out: out.timed_out,
        },
        Err(_) => ExecResult::default(),
    }
}

impl CliDeps for SystemCliDeps {
    fn os(&self) -> Os {
        Os::current()
    }
    fn home(&self) -> String {
        unimux_core::home::home_dir().to_string_lossy().into_owned()
    }
    fn env(&self) -> Env {
        process_env()
    }
    fn now(&self) -> i64 {
        unimux_core::time::now_ms()
    }
    fn is_file(&self, path: String) -> BoxFuture<'static, bool> {
        async move { tokio::fs::metadata(&path).await.map(|m| m.is_file()).unwrap_or(false) }.boxed()
    }
    fn read_dir(&self, path: String) -> BoxFuture<'static, Vec<String>> {
        async move {
            let mut out = Vec::new();
            if let Ok(mut rd) = tokio::fs::read_dir(&path).await {
                while let Ok(Some(entry)) = rd.next_entry().await {
                    out.push(entry.file_name().to_string_lossy().into_owned());
                }
            }
            out
        }
        .boxed()
    }
    fn read_file(&self, path: String) -> BoxFuture<'static, Option<String>> {
        async move {
            let bytes = tokio::fs::read(&path).await.ok()?;
            let text = String::from_utf8_lossy(&bytes).into_owned();
            // JS counts UTF-16 units; the limit only keeps a huge file out.
            (text.encode_utf16().count() <= MAX_TEXT).then_some(text)
        }
        .boxed()
    }
    fn exec(&self, request: ExecRequest) -> BoxFuture<'static, ExecResult> {
        run_program(request).boxed()
    }
    fn has_registry(&self) -> bool {
        cfg!(windows) && !self.options.disable_registry
    }
    fn read_windows_path(&self) -> BoxFuture<'static, Option<RegistryPath>> {
        async move { tokio::task::spawn_blocking(read_registry_path).await.ok().flatten() }.boxed()
    }
    fn shell(&self) -> Option<String> {
        self.options.shell.as_ref().and_then(|f| f())
    }
    fn probe_profile(&self) -> Option<String> {
        self.options.probe_profile.clone()
    }
}

/// Raw Machine / User PATH; None when neither can be read.
#[cfg(windows)]
pub fn read_registry_path() -> Option<RegistryPath> {
    use windows::Win32::System::Registry::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE};
    let machine =
        win::read_string(HKEY_LOCAL_MACHINE, "SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment", "Path");
    let user = win::read_string(HKEY_CURRENT_USER, "Environment", "Path");
    if machine.is_none() && user.is_none() { None } else { Some(RegistryPath { machine, user }) }
}

#[cfg(not(windows))]
pub fn read_registry_path() -> Option<RegistryPath> {
    None
}

#[cfg(windows)]
mod win {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{HKEY, RRF_NOEXPAND, RRF_RT_REG_EXPAND_SZ, RRF_RT_REG_SZ, RegGetValueW};
    use windows::core::{HSTRING, PCWSTR};

    /// A REG_SZ / REG_EXPAND_SZ value as stored (no expansion); None when absent, of another type or unreadable.
    pub fn read_string(root: HKEY, key: &str, value: &str) -> Option<String> {
        let key = HSTRING::from(key);
        let value = HSTRING::from(value);
        let flags = RRF_RT_REG_SZ | RRF_RT_REG_EXPAND_SZ | RRF_NOEXPAND;
        for _ in 0..3 {
            let mut size: u32 = 0;
            // SAFETY: size query with a null buffer; all pointers are valid for the call.
            let rc =
                unsafe { RegGetValueW(root, PCWSTR(key.as_ptr()), PCWSTR(value.as_ptr()), flags, None, None, Some(&mut size)) };
            if rc != ERROR_SUCCESS {
                return None;
            }
            let mut buf = vec![0u16; (size as usize).div_ceil(2) + 1];
            let mut len = (buf.len() * 2) as u32;
            // SAFETY: `buf` holds `len` bytes.
            let rc = unsafe {
                RegGetValueW(
                    root,
                    PCWSTR(key.as_ptr()),
                    PCWSTR(value.as_ptr()),
                    flags,
                    None,
                    Some(buf.as_mut_ptr().cast()),
                    Some(&mut len),
                )
            };
            if rc == ERROR_SUCCESS {
                let chars = (len as usize / 2).min(buf.len());
                let end = buf[..chars].iter().position(|c| *c == 0).unwrap_or(chars);
                return Some(String::from_utf16_lossy(&buf[..end]));
            }
            // ERROR_MORE_DATA: the value grew in between; ask again.
        }
        None
    }
}
