//! ConPTY on Windows (spike SP5, the base of P1): an own wrapper over the Win32 API instead of portable-pty, because 1.1.4
//! (node-pty 1.1.0 with `useConpty` + `useConptyDll`) needs things portable-pty 0.9 does not do the same way:
//!
//! - the sideloaded `conpty.dll` + `OpenConsole.exe` 1.23 (`ConptyCreatePseudoConsole` & co., falling back to the in-box
//!   kernel32 API when the files are missing), created with flags 0 (node-pty's default, `conptyInheritCursor` false;
//!   portable-pty always sets INHERIT_CURSOR | RESIZE_QUIRK | WIN32_INPUT_MODE, which changes what the shell sees);
//! - `ConptyReleasePseudoConsole` right after the child started (node-pty does it with the dll): OpenConsole then exits by
//!   itself when the last client is gone, so the output pipe ends after the shell's final output (output after exit). The
//!   exit is reported when the pipe ends, not when the shell ends: a background child still attached to the console (a
//!   `start /b` job) keeps running and printing until it ends, like node-pty's dll path. Only the in-box API (no Release)
//!   closes the pseudoconsole 1 s after the shell ended (node-pty's FLUSH_DATA_INTERVAL);
//! - the child is created suspended and put into a Job Object before it runs, so a kill ends the whole tree (dev servers
//!   an agent started), not only the shell. The job has no kill-on-close: programs started from a terminal whose shell
//!   ended by itself survive, as in 1.1.4. Difference to 1.1.4 (recorded in PROGRESS.md, P1 open issues): the kill ends
//!   everything in the job, also GUI programs and new console windows started from the cell (`code .`, `start "" cmd`, a
//!   browser that was not running yet); 1.1.4's kill ended only what was attached to the console;
//! - a kill goes like node-pty's: input closed (after the DA1 answer when no DA1 answer was ever written, see
//!   [`DA1_REPLY`]), ClosePseudoConsole (attached programs get CTRL_CLOSE), then the shell is terminated (exit code 1),
//!   then the job (the rest of the tree);
//! - `ClosePseudoConsole` runs on its own thread while the reader keeps draining the output pipe, even when the flow gate has
//!   paused it: OpenConsole flushes its last frame on close and blocks while nobody reads, which deadlocks a close done on
//!   the reader thread or with a paused reader;
//! - input is written by a writer thread: a write to a console that is blocked on a full output pipe would block the caller;
//! - a terminal may start a second program in the same pseudoconsole once its first one ended ([`Pty::spawn_then`]: an agent
//!   CLI started without a shell, then the user's shell). The pseudoconsole is released only after that hand-over, so
//!   OpenConsole stays for the second program; a kill before it skips the second program. The exit reported is the last
//!   program's, and the whole chain is one job.

use std::ffi::c_void;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicUsize, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use windows::Win32::Foundation::{CloseHandle, HANDLE, HMODULE, WAIT_OBJECT_0};
use windows::Win32::Media::{timeBeginPeriod, timeEndPeriod};
use windows::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW, TerminateJobObject};
use windows::Win32::System::LibraryLoader::{GetModuleHandleW, GetProcAddress, LOAD_WITH_ALTERED_SEARCH_PATH, LoadLibraryExW};
use windows::Win32::System::Pipes::CreatePipe;
use windows::Win32::System::Threading::{
    CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT, CreateProcessW, DeleteProcThreadAttributeList, EXTENDED_STARTUPINFO_PRESENT,
    GetExitCodeProcess, INFINITE, InitializeProcThreadAttributeList, LPPROC_THREAD_ATTRIBUTE_LIST,
    PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, PROCESS_INFORMATION, ResumeThread, STARTF_USESTDHANDLES, STARTUPINFOEXW,
    TerminateProcess, UpdateProcThreadAttribute, WaitForSingleObject,
};
use windows::core::{HRESULT, PCSTR, PCWSTR, PWSTR, s, w};

use crate::cmdline::args_to_command_line;

/// A process started in a new process group (CREATE_NEW_PROCESS_GROUP somewhere above us: some launchers, terminals and
/// harnesses) ignores CTRL+C, and every process it starts inherits that: the shells of the cells would never see the
/// CTRL_C_EVENT the pseudoconsole raises for `\x03`, so Ctrl+C would not stop a command. Restores normal CTRL+C processing
/// for this process (and so for the shells it starts) once, before the first terminal.
fn allow_ctrl_c_in_children() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        // SAFETY: no handler routine is passed; it only clears the inherited "ignore CTRL+C" flag of this process.
        let _ = unsafe { windows::Win32::System::Console::SetConsoleCtrlHandler(None, false) };
    });
}

/// Size of both pipes (node-pty's named pipes use 128 KiB) and of one read.
const PIPE_SIZE: u32 = 128 * 1024;
const READ_SIZE: usize = 64 * 1024;
/// In-box API only (no Release): after the shell ended, how long the output may take to end by itself before the
/// pseudoconsole is closed (node-pty's FLUSH_DATA_INTERVAL). With the dll and Release the pipe ends when OpenConsole has
/// no clients left, and nothing is closed on a timer.
const EXIT_DRAIN: Duration = Duration::from_millis(1000);
/// xterm.js's answer to DA1 (`CSI c`). OpenConsole 1.23 asks right after the start and holds the new terminal (its output
/// and a ClosePseudoConsole) up to about 3 s until the answer comes. A kill of a terminal whose input never carried a DA1
/// answer sends it first (see [`Pty::kill`]).
pub const DA1_REPLY: &[u8] = b"\x1b[?1;2c";

#[repr(C)]
#[derive(Clone, Copy)]
struct Coord {
    x: i16,
    y: i16,
}

type CreateFn = unsafe extern "system" fn(Coord, HANDLE, HANDLE, u32, *mut isize) -> HRESULT;
type ResizeFn = unsafe extern "system" fn(isize, Coord) -> HRESULT;
type CloseFn = unsafe extern "system" fn(isize);
type ReleaseFn = unsafe extern "system" fn(isize) -> HRESULT;

/// Where the ConPTY implementation came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConptySource {
    /// `conpty.dll` (and its `OpenConsole.exe`) from this folder.
    Bundled(PathBuf),
    /// The console host of Windows itself (kernel32 `CreatePseudoConsole`).
    Inbox,
}

pub struct ConptyApi {
    create: CreateFn,
    resize: ResizeFn,
    close: CloseFn,
    release: Option<ReleaseFn>,
    pub source: ConptySource,
}

fn wide(s: &std::ffi::OsStr) -> Vec<u16> {
    s.encode_wide().chain(std::iter::once(0)).collect()
}

unsafe fn proc_address<T>(module: HMODULE, name: PCSTR) -> Option<T> {
    // SAFETY: the caller names a function of the documented signature T.
    unsafe { GetProcAddress(module, name).map(|f| std::mem::transmute_copy::<_, T>(&f)) }
}

impl ConptyApi {
    /// `conpty.dll` from `dir` (OpenConsole.exe must sit next to it), or the in-box API for `None`.
    pub fn load(dir: Option<&Path>) -> io::Result<Self> {
        // SAFETY: modules are loaded once and never freed; the function names and signatures are the documented ones.
        unsafe {
            match dir {
                Some(dir) => {
                    let dll = std::path::absolute(dir.join("conpty.dll"))?;
                    if !dll.is_file() || !dir.join("OpenConsole.exe").is_file() {
                        return Err(io::Error::new(
                            io::ErrorKind::NotFound,
                            format!("no conpty.dll + OpenConsole.exe in {}", dir.display()),
                        ));
                    }
                    let module = LoadLibraryExW(PCWSTR(wide(dll.as_os_str()).as_ptr()), None, LOAD_WITH_ALTERED_SEARCH_PATH)
                        .map_err(io::Error::other)?;
                    let missing = |n: &str| io::Error::new(io::ErrorKind::NotFound, format!("{n} missing in {}", dll.display()));
                    Ok(Self {
                        create: proc_address(module, s!("ConptyCreatePseudoConsole"))
                            .ok_or_else(|| missing("ConptyCreatePseudoConsole"))?,
                        resize: proc_address(module, s!("ConptyResizePseudoConsole"))
                            .ok_or_else(|| missing("ConptyResizePseudoConsole"))?,
                        close: proc_address(module, s!("ConptyClosePseudoConsole"))
                            .ok_or_else(|| missing("ConptyClosePseudoConsole"))?,
                        release: proc_address(module, s!("ConptyReleasePseudoConsole")),
                        source: ConptySource::Bundled(dir.to_path_buf()),
                    })
                }
                None => {
                    let module = GetModuleHandleW(w!("kernel32.dll")).map_err(io::Error::other)?;
                    let missing = |n: &str| io::Error::new(io::ErrorKind::Unsupported, format!("kernel32 has no {n}"));
                    Ok(Self {
                        create: proc_address(module, s!("CreatePseudoConsole")).ok_or_else(|| missing("CreatePseudoConsole"))?,
                        resize: proc_address(module, s!("ResizePseudoConsole")).ok_or_else(|| missing("ResizePseudoConsole"))?,
                        close: proc_address(module, s!("ClosePseudoConsole")).ok_or_else(|| missing("ClosePseudoConsole"))?,
                        release: None,
                        source: ConptySource::Inbox,
                    })
                }
            }
        }
    }

    /// The app's folder with the bundled files (`<resource dir>/resources/conpty/x64`, see `bundle.resources` in
    /// tauri.conf.json). Set once at startup, before the first terminal; false when it was set already.
    pub fn set_resource_dir(dir: PathBuf) -> bool {
        RESOURCE_DIR.set(dir).is_ok()
    }

    /// Folders searched for the bundled files, in order: `UNIMUX_CONPTY_DIR`, the folder the app set
    /// ([`ConptyApi::set_resource_dir`]), `<exe>/resources/conpty/x64` (where the installer and `cargo build` put the
    /// resources), `<exe>/conpty`.
    pub fn bundled_candidates() -> Vec<PathBuf> {
        let mut dirs = Vec::new();
        if let Some(dir) = std::env::var_os("UNIMUX_CONPTY_DIR") {
            dirs.push(PathBuf::from(dir));
        }
        if let Some(dir) = RESOURCE_DIR.get() {
            dirs.push(dir.clone());
        }
        if let Some(exe_dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)) {
            dirs.push(exe_dir.join("resources").join("conpty").join("x64"));
            dirs.push(exe_dir.join("conpty"));
        }
        dirs
    }

    /// The process-wide API: the first bundled folder that loads, else the in-box API.
    pub fn shared() -> io::Result<&'static ConptyApi> {
        static API: OnceLock<Result<ConptyApi, String>> = OnceLock::new();
        API.get_or_init(|| {
            for dir in Self::bundled_candidates() {
                if let Ok(api) = Self::load(Some(&dir)) {
                    return Ok(api);
                }
            }
            Self::load(None).map_err(|e| e.to_string())
        })
        .as_ref()
        .map_err(|e| io::Error::other(e.clone()))
    }
}

static RESOURCE_DIR: OnceLock<PathBuf> = OnceLock::new();

/// What to start in a new pseudoconsole.
#[derive(Debug, Clone)]
pub struct SpawnOptions {
    /// Program as node-pty got it (absolute path or a name CreateProcess finds).
    pub file: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// The complete environment (`None`: inherit this process's).
    pub env: Option<Vec<(String, String)>>,
    pub cols: u16,
    pub rows: u16,
    /// CreatePseudoConsole flags; 0 like node-pty (1 = PSEUDOCONSOLE_INHERIT_CURSOR).
    pub flags: u32,
    /// Put the child into its own Job Object (tree kill on [`Pty::kill`]; no kill-on-close).
    pub job: bool,
    /// The complete command line instead of `file` + `args` with node-pty's quoting (a `cmd.exe /s /c "..."` line).
    pub cmdline: Option<String>,
}

/// What starts in the same pseudoconsole once the first program ended: gets its exit code, answers the next program (only
/// `file`, `args`, `cmdline`, `cwd` and `env` are used) or None to end the terminal.
pub type ThenFn = Box<dyn FnOnce(u32) -> Option<SpawnOptions> + Send>;

impl SpawnOptions {
    pub fn new(file: impl Into<String>, args: &[&str]) -> Self {
        Self {
            file: file.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            cwd: None,
            env: None,
            cols: 80,
            rows: 24,
            flags: 0,
            job: true,
            cmdline: None,
        }
    }
}

struct Job(HANDLE);
// SAFETY: a job handle may be used from any thread.
unsafe impl Send for Job {}
unsafe impl Sync for Job {}

impl Job {
    /// A job without limits: it only groups the tree for TerminateJobObject. No KILL_ON_JOB_CLOSE, so closing the handle
    /// (the terminal is forgotten after its shell ended by itself) leaves detached programs running, as in 1.1.4.
    fn new() -> io::Result<Self> {
        // SAFETY: plain Win32 call; the handle is owned by the returned value.
        unsafe { CreateJobObjectW(None, PCWSTR::null()).map(Job).map_err(io::Error::other) }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // SAFETY: our own handle; without kill-on-close the processes in the job keep running.
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[derive(Default)]
struct GateState {
    paused: bool,
    closing: bool,
}

/// The reader's pause switch (flow control); closing always opens it so the pipe is drained.
#[derive(Default)]
struct Gate {
    state: Mutex<GateState>,
    cv: Condvar,
}

impl Gate {
    fn set_paused(&self, paused: bool) {
        self.state.lock().paused = paused;
        self.cv.notify_all();
    }
    fn set_closing(&self) {
        self.state.lock().closing = true;
        self.cv.notify_all();
    }
    fn wait_open(&self) {
        let mut s = self.state.lock();
        while s.paused && !s.closing {
            self.cv.wait(&mut s);
        }
    }
}

struct Shared {
    api: &'static ConptyApi,
    hpc: Mutex<Option<isize>>,
    /// The program running now (the second one after a hand-over, see [`Pty::spawn_then`]).
    process: Mutex<Arc<OwnedHandle>>,
    pid: AtomicU32,
    job: Option<Job>,
    /// The program to start once the first one ended; the pseudoconsole is released after it started.
    then: Mutex<Option<ThenFn>>,
    gate: Gate,
    exit: Mutex<Option<u32>>,
    exit_cv: Condvar,
    eof: AtomicBool,
    close_started: AtomicBool,
    /// How long the last ClosePseudoConsole call took (measurements).
    close_took: Mutex<Option<Duration>>,
    close_done: Condvar,
    /// A kill was asked (`kill`) and the close returned (`closed`); the terminate runs once both hold.
    kill_state: Mutex<KillState>,
}

#[derive(Default)]
struct KillState {
    kill: bool,
    closed: bool,
    terminated: bool,
}

impl Shared {
    /// Closes the pseudoconsole on its own thread while the reader keeps draining (never on the reader thread). Idempotent.
    fn close_pseudoconsole(self: &Arc<Self>) {
        if self.close_started.swap(true, Ordering::SeqCst) {
            return;
        }
        self.gate.set_closing();
        let Some(hpc) = self.hpc.lock().take() else {
            self.closed(Duration::ZERO);
            return;
        };
        let me = self.clone();
        let close = self.api.close;
        let run = move || {
            let started = Instant::now();
            // SAFETY: hpc came from create and is closed exactly once (taken out of the mutex).
            unsafe { close(hpc) };
            me.closed(started.elapsed());
        };
        let slot = Arc::new(Mutex::new(Some(run)));
        let spawned = {
            let slot = slot.clone();
            std::thread::Builder::new().name("conpty-close".into()).spawn(move || {
                if let Some(run) = slot.lock().take() {
                    run();
                }
            })
        };
        if spawned.is_err() {
            // No thread to spare: close here (the reader drains meanwhile, the gate is open).
            if let Some(run) = slot.lock().take() {
                run();
            }
        }
    }

    /// The close returned: record it and run a kill that waited for it.
    fn closed(&self, took: Duration) {
        *self.close_took.lock() = Some(took);
        self.close_done.notify_all();
        let mut st = self.kill_state.lock();
        st.closed = true;
        if st.kill {
            self.terminate(&mut st);
        }
    }

    /// node-pty's TerminateProcess(hShell, 1) after the close. Once. Only the shell: what it started in a window of its own
    /// (`code .`, `start "" cmd`) outlives the terminal, as in any terminal and in 1.1.4.
    fn terminate(&self, st: &mut KillState) {
        if st.terminated {
            return;
        }
        st.terminated = true;
        let process = self.process.lock().clone();
        // SAFETY: a valid handle owned by `self`.
        unsafe {
            let _ = TerminateProcess(HANDLE(process.as_raw_handle()), 1);
        }
    }

    /// The first program ended with `code`: starts the next one in the same pseudoconsole (unless a kill came first or there
    /// is none), then releases the pseudoconsole. True when a next program runs.
    fn hand_over(&self, code: u32) -> bool {
        let Some(then) = self.then.lock().take() else { return false };
        let next = if self.kill_state.lock().kill { None } else { then(code) };
        let started = next.is_some_and(|opts| {
            // Under the kill lock: a kill either came before (no start) or sees the new process (and terminates it).
            let st = self.kill_state.lock();
            if st.kill {
                return false;
            }
            let hpc = self.hpc.lock();
            let Some(hpc) = *hpc else { return false };
            // SAFETY: a live pseudoconsole (the lock keeps close from taking it meanwhile).
            match unsafe { start_process(&opts, hpc, self.job.as_ref()) } {
                Ok((process, pid)) => {
                    *self.process.lock() = Arc::new(process);
                    self.pid.store(pid, Ordering::SeqCst);
                    true
                }
                Err(_) => false,
            }
        });
        if let Some(release) = self.api.release
            && let Some(hpc) = *self.hpc.lock()
        {
            // SAFETY: a live pseudoconsole; Release only drops this side's reference (the close still comes later).
            let _ = unsafe { release(hpc) };
        }
        started
    }

    /// Ends everything in the terminal's job (1.1.4's `taskkill /T`): only for a terminal that did not end in time.
    fn terminate_job(&self) {
        if let Some(job) = &self.job {
            // SAFETY: a valid handle owned by `self`.
            unsafe {
                let _ = TerminateJobObject(job.0, 1);
            }
        }
    }

    fn exit_code(&self) -> Option<u32> {
        *self.exit.lock()
    }
}

impl Drop for Shared {
    fn drop(&mut self) {
        // A pseudoconsole nobody closed (a spawn that failed after create): close it so OpenConsole does not leak. No
        // reader is left, so its output pipe is broken and the close cannot block on it.
        if let Some(hpc) = self.hpc.get_mut().take() {
            // SAFETY: hpc came from create and was never closed (it is still in the slot).
            unsafe { (self.api.close)(hpc) };
        }
    }
}

/// Whether `data` carries an answer to DA1 (`CSI ? Ps ; ... c`, what xterm.js and other terminals send).
pub fn is_da1_answer(data: &[u8]) -> bool {
    let mut rest = data;
    while let Some(at) = rest.windows(3).position(|w| w == b"\x1b[?") {
        let tail = &rest[at + 3..];
        let params = tail.iter().take_while(|b| b.is_ascii_digit() || **b == b';').count();
        if params > 0 && tail.get(params) == Some(&b'c') {
            return true;
        }
        rest = tail;
    }
    false
}

/// One terminal: a pseudoconsole and the process tree running in it.
pub struct Pty {
    shared: Arc<Shared>,
    input: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
    /// A DA1 answer was queued (by [`Pty::write`] or a [`PtyWriter`] clone). Other input (the agent launch command, keys)
    /// does not count: OpenConsole keeps holding the terminal until the answer itself comes.
    da1_answered: Arc<AtomicBool>,
}

#[derive(Clone)]
pub struct PtyWriter(mpsc::Sender<Vec<u8>>, Arc<AtomicBool>);

impl PtyWriter {
    pub fn write(&self, data: &[u8]) {
        if is_da1_answer(data) {
            self.1.store(true, Ordering::SeqCst);
        }
        let _ = self.0.send(data.to_vec());
    }
}

#[derive(Clone)]
pub struct PauseHandle(Arc<Shared>);

impl PauseHandle {
    pub fn set_paused(&self, paused: bool) {
        self.0.gate.set_paused(paused);
    }
}

pub type DataFn = Box<dyn FnMut(&[u8]) + Send>;
pub type ExitFn = Box<dyn FnOnce(u32) + Send>;

impl Pty {
    /// Starts `opts` in a new pseudoconsole. `on_data` gets every chunk of output on the reader thread; `on_exit` gets the
    /// exit code once the process ended AND its output was fully read (output after exit is never lost).
    pub fn spawn(api: &'static ConptyApi, opts: &SpawnOptions, on_data: DataFn, on_exit: ExitFn) -> io::Result<Pty> {
        Self::spawn_then(api, opts, None, on_data, on_exit)
    }

    /// [`Pty::spawn`], and once the program ended `then` may start the next one in the same pseudoconsole (same screen,
    /// same input, same job). `on_exit` then gets the last program's exit code.
    pub fn spawn_then(
        api: &'static ConptyApi,
        opts: &SpawnOptions,
        then: Option<ThenFn>,
        mut on_data: DataFn,
        on_exit: ExitFn,
    ) -> io::Result<Pty> {
        let size = Coord { x: opts.cols.max(2) as i16, y: opts.rows.max(1) as i16 };
        allow_ctrl_c_in_children();
        let (mut in_read, mut in_write, mut out_read, mut out_write) =
            (HANDLE::default(), HANDLE::default(), HANDLE::default(), HANDLE::default());
        // Before the pseudoconsole: a failure here must not leave an OpenConsole behind.
        let job = if opts.job { Some(Job::new()?) } else { None };
        // SAFETY: each handle is owned below (File / OwnedHandle) or closed on every path.
        unsafe {
            CreatePipe(&mut in_read, &mut in_write, None, PIPE_SIZE).map_err(io::Error::other)?;
            let in_write = File::from_raw_handle(in_write.0 as RawHandle);
            let in_read = OwnedHandle::from_raw_handle(in_read.0 as RawHandle);
            CreatePipe(&mut out_read, &mut out_write, None, PIPE_SIZE).map_err(io::Error::other)?;
            let out_read = File::from_raw_handle(out_read.0 as RawHandle);
            let out_write = OwnedHandle::from_raw_handle(out_write.0 as RawHandle);

            let mut hpc: isize = 0;
            let hr = (api.create)(size, HANDLE(in_read.as_raw_handle()), HANDLE(out_write.as_raw_handle()), opts.flags, &mut hpc);
            if hr.is_err() {
                return Err(io::Error::other(format!("CreatePseudoConsole failed: {hr:?}")));
            }
            // The pseudoconsole holds its own duplicates; ours must go, or the output pipe never ends.
            drop(in_read);
            drop(out_write);
            let close_hpc = |hpc: isize| (api.close)(hpc);

            let (process, pid) = match start_process(opts, hpc, job.as_ref()) {
                Ok(started) => started,
                Err(e) => {
                    close_hpc(hpc);
                    return Err(e);
                }
            };
            // A next program needs the pseudoconsole after this one ended: released once it started (Shared::hand_over).
            if then.is_none()
                && let Some(release) = api.release
            {
                let _ = release(hpc);
            }

            let shared = Arc::new(Shared {
                api,
                hpc: Mutex::new(Some(hpc)),
                process: Mutex::new(Arc::new(process)),
                pid: AtomicU32::new(pid),
                job,
                then: Mutex::new(then),
                gate: Gate::default(),
                exit: Mutex::new(None),
                exit_cv: Condvar::new(),
                eof: AtomicBool::new(false),
                close_started: AtomicBool::new(false),
                close_took: Mutex::new(None),
                close_done: Condvar::new(),
                kill_state: Mutex::new(KillState::default()),
            });
            // A thread that cannot start: end the process (the threads already running then end too) and fail; the last
            // Arc<Shared> closes the pseudoconsole.
            let fail = |shared: &Shared, e: io::Error| {
                shared.terminate(&mut shared.kill_state.lock());
                e
            };

            // Writer: input never blocks the caller (the console may be stuck on a full output pipe).
            let (tx, rx) = mpsc::channel::<Vec<u8>>();
            let mut in_write = in_write;
            std::thread::Builder::new()
                .name("conpty-write".into())
                .spawn(move || {
                    while let Ok(data) = rx.recv() {
                        if in_write.write_all(&data).is_err() {
                            break;
                        }
                    }
                })
                .map_err(|e| fail(&shared, e))?;

            // Waiter: the exit code. With the dll + Release nothing else: the output pipe ends when OpenConsole has no
            // clients left (a `start /b` child may keep it open and print after the shell ended, as in 1.1.4). The in-box
            // API has no Release: the output gets EXIT_DRAIN to end by itself before the pseudoconsole is closed.
            let waiter = shared.clone();
            let drain_then_close = api.release.is_none();
            std::thread::Builder::new()
                .name("conpty-wait".into())
                .spawn(move || {
                    // The exit of the last program: a hand-over (Pty::spawn_then) waits for the next one.
                    let code = loop {
                        let process = waiter.process.lock().clone();
                        WaitForSingleObject(HANDLE(process.as_raw_handle()), INFINITE);
                        let mut code = 0u32;
                        let _ = GetExitCodeProcess(HANDLE(process.as_raw_handle()), &mut code);
                        if !waiter.hand_over(code) {
                            break code;
                        }
                    };
                    *waiter.exit.lock() = Some(code);
                    waiter.exit_cv.notify_all();
                    // A reader paused by flow control reads again (and is never paused again): the output the console
                    // still holds arrives before the exit, which is reported at the end of the pipe.
                    waiter.gate.set_closing();
                    if !drain_then_close {
                        return;
                    }
                    let deadline = Instant::now() + EXIT_DRAIN;
                    while !waiter.eof.load(Ordering::SeqCst) && Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    if !waiter.eof.load(Ordering::SeqCst) {
                        waiter.close_pseudoconsole();
                    }
                })
                .map_err(|e| fail(&shared, e))?;

            // Reader (started last, so on_exit never runs for a spawn that failed): drains until the pipe ends, then
            // reports the exit.
            let reader = shared.clone();
            let mut out_read = out_read;
            std::thread::Builder::new()
                .name("conpty-read".into())
                .spawn(move || {
                    let mut buf = vec![0u8; READ_SIZE];
                    loop {
                        reader.gate.wait_open();
                        match out_read.read(&mut buf) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => on_data(&buf[..n]),
                        }
                    }
                    reader.eof.store(true, Ordering::SeqCst);
                    let mut exit = reader.exit.lock();
                    while exit.is_none() {
                        reader.exit_cv.wait(&mut exit);
                    }
                    let code = exit.unwrap_or(1);
                    drop(exit);
                    // The pseudoconsole is closed in every case (a no-op when it already was).
                    reader.close_pseudoconsole();
                    on_exit(code);
                })
                .map_err(|e| fail(&shared, e))?;

            Ok(Pty { shared, input: Mutex::new(Some(tx)), da1_answered: Arc::new(AtomicBool::new(false)) })
        }
    }

    /// The pid of the program running now (the next one once a [`Pty::spawn_then`] hand-over happened).
    pub fn pid(&self) -> u32 {
        self.shared.pid.load(Ordering::SeqCst)
    }

    /// A handle that pauses / resumes the reader (for flow control set up before the Pty existed).
    pub fn pause_handle(&self) -> PauseHandle {
        PauseHandle(self.shared.clone())
    }

    pub fn source(&self) -> &ConptySource {
        &self.shared.api.source
    }

    /// A cloneable input handle (for answers sent from the output callback, e.g. the DA1 reply in tests).
    pub fn writer(&self) -> Option<PtyWriter> {
        self.input.lock().clone().map(|tx| PtyWriter(tx, self.da1_answered.clone()))
    }

    /// Queues input for the console (never blocks).
    pub fn write(&self, data: &[u8]) {
        if let Some(tx) = self.input.lock().as_ref() {
            if is_da1_answer(data) {
                self.da1_answered.store(true, Ordering::SeqCst);
            }
            let _ = tx.send(data.to_vec());
        }
    }

    /// Closes the input. A terminal whose DA1 was never answered (killed right after its start, before a renderer
    /// answered; also an agent cell whose launch command was already typed, since that is not the answer) gets the DA1
    /// answer first: OpenConsole would otherwise sit out its 3 s DA1 wait before it handles the close, and the kill would
    /// miss its 3 s limit. A late answer to a console that already gave up waiting only reaches a shell that is being ended.
    fn close_input(&self) {
        if let Some(tx) = self.input.lock().take()
            && !self.da1_answered.load(Ordering::SeqCst)
        {
            let _ = tx.send(DA1_REPLY.to_vec());
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let hpc = self.shared.hpc.lock();
        let Some(hpc) = *hpc else { return Ok(()) };
        // SAFETY: a live pseudoconsole (the lock keeps close from taking it meanwhile).
        let hr = unsafe { (self.shared.api.resize)(hpc, Coord { x: cols.max(2) as i16, y: rows.max(1) as i16 }) };
        if hr.is_err() { Err(io::Error::other(format!("ResizePseudoConsole: {hr:?}"))) } else { Ok(()) }
    }

    /// Flow control: stops reading the output pipe (ConPTY then stops the shell) or reads again.
    pub fn set_paused(&self, paused: bool) {
        self.shared.gate.set_paused(paused);
    }

    /// node-pty's dll kill order: the input is closed, the pseudoconsole is closed off-thread (attached programs get
    /// CTRL_CLOSE), and once that returned the shell is terminated (exit code 1).
    /// Returns at once; the reader drains the rest and reports the exit.
    pub fn kill(&self) {
        self.close_input();
        {
            let mut st = self.shared.kill_state.lock();
            st.kill = true;
            if st.closed {
                self.shared.terminate(&mut st);
            }
        }
        self.shared.close_pseudoconsole();
    }

    /// Ends the whole tree now, without waiting for ClosePseudoConsole to return (kill_all after its time limit: a close
    /// that hangs must not keep a dev server alive). The shell and the job are terminated; the close still runs off-thread.
    pub fn kill_tree(&self) {
        self.close_input();
        {
            let mut st = self.shared.kill_state.lock();
            st.kill = true;
            self.shared.terminate(&mut st);
        }
        self.shared.terminate_job();
        self.shared.close_pseudoconsole();
    }

    /// Closes the pseudoconsole only (OpenConsole ends, the attached programs get CTRL_CLOSE), like node-pty's kill
    /// without the TerminateProcess. Returns at once; see [`Pty::wait_closed`].
    pub fn close(&self) {
        self.shared.close_pseudoconsole();
    }

    /// Waits until a started close returned; the duration of the ClosePseudoConsole call, or None on timeout.
    pub fn wait_closed(&self, timeout: Duration) -> Option<Duration> {
        let deadline = Instant::now() + timeout;
        let mut took = self.shared.close_took.lock();
        while took.is_none() {
            if self.shared.close_done.wait_until(&mut took, deadline).timed_out() {
                return *took;
            }
        }
        *took
    }

    /// The exit code once the process ended.
    pub fn exit_code(&self) -> Option<u32> {
        self.shared.exit_code()
    }

    /// Waits for the process (not the output) to end.
    pub fn wait_exit(&self, timeout: Duration) -> Option<u32> {
        let deadline = Instant::now() + timeout;
        let mut exit = self.shared.exit.lock();
        while exit.is_none() {
            if self.shared.exit_cv.wait_until(&mut exit, deadline).timed_out() {
                break;
            }
        }
        *exit
    }

    /// Whether a process id is still running (tests: tree kill).
    pub fn process_alive(pid: u32) -> bool {
        use windows::Win32::System::Threading::{OpenProcess, PROCESS_SYNCHRONIZE};
        // SAFETY: an opened handle is closed again.
        unsafe {
            match OpenProcess(PROCESS_SYNCHRONIZE, false, pid) {
                Ok(h) => {
                    let alive = WaitForSingleObject(h, 0) != WAIT_OBJECT_0;
                    let _ = CloseHandle(h);
                    alive
                }
                Err(_) => false,
            }
        }
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        if self.shared.exit_code().is_none() {
            self.kill();
        } else {
            self.input.lock().take();
            self.shared.close_pseudoconsole();
        }
    }
}

/// Starts one program attached to the pseudoconsole `hpc` (created suspended and put into `job` first when there is one).
///
/// # Safety
/// `hpc` must be a live pseudoconsole.
unsafe fn start_process(opts: &SpawnOptions, hpc: isize, job: Option<&Job>) -> io::Result<(OwnedHandle, u32)> {
    // SAFETY: the attribute list lives in `attr_buf` until it is deleted; every handle is owned or closed on each path.
    unsafe {
        let mut attr_size = 0usize;
        let _ = InitializeProcThreadAttributeList(None, 1, None, &mut attr_size);
        let mut attr_buf = vec![0u8; attr_size];
        let attrs = LPPROC_THREAD_ATTRIBUTE_LIST(attr_buf.as_mut_ptr() as *mut c_void);
        InitializeProcThreadAttributeList(Some(attrs), 1, None, &mut attr_size).map_err(io::Error::other)?;
        if let Err(e) = UpdateProcThreadAttribute(
            attrs,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize,
            Some(hpc as *const c_void),
            std::mem::size_of::<isize>(),
            None,
            None,
        ) {
            DeleteProcThreadAttributeList(attrs);
            return Err(io::Error::other(e));
        }

        let mut si = STARTUPINFOEXW::default();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        // Like node-pty: no std handles of ours reach the child, the console is its only stdio.
        si.StartupInfo.dwFlags |= STARTF_USESTDHANDLES;
        si.lpAttributeList = attrs;

        let line = opts.cmdline.clone().unwrap_or_else(|| args_to_command_line(&opts.file, &opts.args));
        let mut cmdline: Vec<u16> = line.encode_utf16().chain(std::iter::once(0)).collect();
        let env_block: Option<Vec<u16>> = opts.env.as_ref().map(|env| {
            let mut block: Vec<u16> = Vec::new();
            for (k, v) in env {
                block.extend(format!("{k}={v}").encode_utf16());
                block.push(0);
            }
            if env.is_empty() {
                block.push(0);
            }
            block.push(0);
            block
        });
        let cwd = opts.cwd.as_ref().map(|c| wide(c.as_os_str()));
        let mut flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT;
        if job.is_some() {
            flags |= CREATE_SUSPENDED;
        }
        let mut pi = PROCESS_INFORMATION::default();
        let created = CreateProcessW(
            PCWSTR::null(),
            Some(PWSTR(cmdline.as_mut_ptr())),
            None,
            None,
            false,
            flags,
            env_block.as_ref().map(|b| b.as_ptr() as *const c_void),
            cwd.as_ref().map(|c| PCWSTR(c.as_ptr())).unwrap_or(PCWSTR::null()),
            &si.StartupInfo,
            &mut pi,
        );
        DeleteProcThreadAttributeList(attrs);
        drop(attr_buf);
        if let Err(e) = created {
            return Err(io::Error::other(format!("CreateProcess {}: {e}", opts.file)));
        }
        let process = OwnedHandle::from_raw_handle(pi.hProcess.0 as RawHandle);
        if let Some(job) = job {
            if let Err(e) = AssignProcessToJobObject(job.0, pi.hProcess) {
                let _ = TerminateProcess(pi.hProcess, 1);
                let _ = CloseHandle(pi.hThread);
                return Err(io::Error::other(format!("AssignProcessToJobObject: {e}")));
            }
            if ResumeThread(pi.hThread) == u32::MAX {
                let e = io::Error::last_os_error();
                let _ = TerminateProcess(pi.hProcess, 1);
                let _ = CloseHandle(pi.hThread);
                return Err(io::Error::other(format!("ResumeThread: {e}")));
            }
        }
        let _ = CloseHandle(pi.hThread);
        Ok((process, pi.dwProcessId))
    }
}

/// timeBeginPeriod(1) while at least one guard lives (1.1.4 had Chromium's 1 ms timers in the pty host; Windows timers
/// otherwise tick at 15.6 ms, which shows in coalescing windows and echo latency).
pub struct TimerResolution(());

static TIMER_USERS: AtomicUsize = AtomicUsize::new(0);

impl TimerResolution {
    pub fn acquire() -> Self {
        if TIMER_USERS.fetch_add(1, Ordering::SeqCst) == 0 {
            // SAFETY: plain call, balanced by timeEndPeriod in Drop.
            unsafe {
                timeBeginPeriod(1);
            }
        }
        TimerResolution(())
    }
}

impl Drop for TimerResolution {
    fn drop(&mut self) {
        if TIMER_USERS.fetch_sub(1, Ordering::SeqCst) == 1 {
            // SAFETY: balances the timeBeginPeriod of the first guard.
            unsafe {
                timeEndPeriod(1);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn da1_answers_are_recognised() {
        assert!(is_da1_answer(DA1_REPLY));
        assert!(is_da1_answer(b"\x1b[?62;4;22c"));
        assert!(is_da1_answer(b"typed\x1b[?1;2cmore"));
        assert!(is_da1_answer(b"\x1b[?1\x1b[?6c"));
        assert!(!is_da1_answer(b"claude --model x\r"));
        assert!(!is_da1_answer(b"\x1b[?c"));
        assert!(!is_da1_answer(b"\x1b[?1;2"));
        assert!(!is_da1_answer(b"\x1b[c"));
        assert!(!is_da1_answer(b"\x1b[?2004h"));
    }
}
