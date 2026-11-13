//! Single instance per data dir (PLAN F6), compatible with Electron 1.1.x in both directions.
//!
//! Electron's `requestSingleInstanceLock` (Chromium ProcessSingleton) finds a running instance on Windows through a message-only
//! window of class `Chrome_MessageWindow` whose title is the user data dir, and hands it the new process's command line with
//! WM_COPYDATA (`START\0<cwd>\0<command line>\0`). unimux 1.2.0 speaks the same protocol:
//! - before anything touches the data dir, a window of that class and title means another instance (1.1.x or 1.2.0) owns the
//!   dir: we hand it our command line (it focuses itself) and exit without touching state.json;
//! - while running we own such a window ourselves and answer WM_COPYDATA, so a 1.1.x started later forwards to us and quits
//!   instead of writing state.json, and a second 1.2.0 does the same.
//!
//! Starts at the same moment are serialized like Chromium's ProcessSingleton::Create does it: under Electron's named startup
//! mutex (`Local\unimuxProcessSingletonStartup`) we look for the window again, take `<data dir>/lockfile` the way Chromium
//! takes it (an Electron that cannot open it gives up) and create our window before the mutex is released. An exclusive lock
//! on `<data dir>/instance.lock` also closes the race between two 1.2.0 processes. Keyed by data dir, so parallel
//! `MC_DATA_DIR` runs coexist.
//!
//! macOS/Unix (wave 0): the lock plus a Unix socket `<data dir>/instance.sock` with the same START message. The Electron
//! compatibility on macOS (SingletonLock / SingletonSocket / SingletonCookie) is the macOS half of F6, done in R3.

use std::fs::{self, File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// What another process asked for (its working directory and command line).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SecondInstance {
    pub cwd: String,
    pub command_line: String,
}

pub type OnSecond = Arc<dyn Fn(SecondInstance) + Send + Sync>;

/// The result of [`acquire`].
pub enum Acquire {
    /// This process owns the data dir; keep the guard alive for the whole run.
    Primary(InstanceGuard),
    /// Another instance owns it and got our command line (it focuses itself); exit without touching anything.
    Forwarded,
    /// Another instance owns it but could not be told (busy starting or hung); exit without touching anything.
    Busy,
}

/// Holds the lock (and on Windows the message window) while the app runs.
pub struct InstanceGuard {
    _lock: File,
    lock_path: PathBuf,
    /// `<data dir>/lockfile`, held like Chromium holds it (write access, read sharing, deleted on close): an Electron 1.1.x
    /// that gets past the window check is refused it and quits.
    #[cfg(windows)]
    _chromium_lock: Option<File>,
    #[cfg(windows)]
    _window: win::MessageWindow,
}

impl InstanceGuard {
    pub fn lock_path(&self) -> &Path {
        &self.lock_path
    }
}

/// The message both platforms send: `START\0<cwd>\0<command line>\0`.
pub fn start_message(cwd: &str, command_line: &str) -> String {
    format!("START\0{cwd}\0{command_line}\0")
}

/// Parses [`start_message`] (None for anything else).
pub fn parse_start_message(text: &str) -> Option<SecondInstance> {
    let rest = text.strip_prefix("START\0")?;
    let mut parts = rest.split('\0');
    let cwd = parts.next()?.to_string();
    let command_line = parts.next().unwrap_or("").to_string();
    Some(SecondInstance { cwd, command_line })
}

fn current_cwd() -> String {
    std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default()
}

/// Our command line, every argument quoted the way `CommandLineToArgvW` reads it back (a path with spaces stays one argument;
/// Chromium hands the raw `GetCommandLineW`, which follows the same rules).
fn current_command_line() -> String {
    let args: Vec<String> = std::env::args_os().map(|a| a.to_string_lossy().into_owned()).collect();
    join_command_line(&args)
}

/// Joins arguments into one command line (the MSVC / `CommandLineToArgvW` quoting rules), the inverse of
/// [`split_command_line`].
pub fn join_command_line(args: &[String]) -> String {
    let mut out = String::new();
    for (i, arg) in args.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '"']) {
            out.push_str(arg);
            continue;
        }
        out.push('"');
        let mut backslashes = 0usize;
        for c in arg.chars() {
            if c == '\\' {
                backslashes += 1;
                continue;
            }
            // Backslashes before a quote are doubled, plus one for the quote itself.
            let n = if c == '"' { backslashes * 2 + 1 } else { backslashes };
            out.extend(std::iter::repeat_n('\\', n));
            backslashes = 0;
            out.push(c);
        }
        // Trailing backslashes are doubled: the closing quote must not be escaped.
        out.extend(std::iter::repeat_n('\\', backslashes * 2));
        out.push('"');
    }
    out
}

/// Splits a command line the way `CommandLineToArgvW` does: the program name up to the next quote or blank (no escapes),
/// then the MSVC rules (2n backslashes + quote = n backslashes and a quote toggle, 2n+1 = n backslashes and a literal quote,
/// `""` inside quotes = a literal quote). Reads the command line of another unimux process (1.2.x, or 1.1.x's raw one).
pub fn split_command_line(line: &str) -> Vec<String> {
    let chars: Vec<char> = line.chars().collect();
    let blank = |c: char| matches!(c, ' ' | '\t' | '\n' | '\r');
    let mut args = Vec::new();
    let mut i = 0;
    while i < chars.len() && blank(chars[i]) {
        i += 1;
    }
    if i < chars.len() {
        let mut program = String::new();
        if chars[i] == '"' {
            i += 1;
            while i < chars.len() && chars[i] != '"' {
                program.push(chars[i]);
                i += 1;
            }
            i += 1;
        } else {
            while i < chars.len() && !blank(chars[i]) {
                program.push(chars[i]);
                i += 1;
            }
        }
        args.push(program);
    }
    loop {
        while i < chars.len() && blank(chars[i]) {
            i += 1;
        }
        if i >= chars.len() {
            break;
        }
        let mut arg = String::new();
        let mut quoted = false;
        while i < chars.len() {
            let c = chars[i];
            if c == '\\' {
                let start = i;
                while i < chars.len() && chars[i] == '\\' {
                    i += 1;
                }
                let n = i - start;
                if chars.get(i) == Some(&'"') {
                    arg.extend(std::iter::repeat_n('\\', n / 2));
                    if n % 2 == 1 {
                        arg.push('"');
                        i += 1;
                    }
                } else {
                    arg.extend(std::iter::repeat_n('\\', n));
                }
                continue;
            }
            if c == '"' {
                if quoted && chars.get(i + 1) == Some(&'"') {
                    arg.push('"');
                    i += 2;
                    continue;
                }
                quoted = !quoted;
                i += 1;
                continue;
            }
            if blank(c) && !quoted {
                break;
            }
            arg.push(c);
            i += 1;
        }
        args.push(arg);
    }
    args
}

fn try_lock(data_dir: &Path) -> io::Result<Option<(File, PathBuf)>> {
    fs::create_dir_all(data_dir)?;
    let path = data_dir.join("instance.lock");
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&path)?;
    match file.try_lock() {
        Ok(()) => Ok(Some((file, path))),
        Err(fs::TryLockError::WouldBlock) => Ok(None),
        Err(fs::TryLockError::Error(e)) => Err(e),
    }
}

/// Takes the data dir for this process or hands our command line to the instance that has it.
pub fn acquire(data_dir: &Path, on_second: OnSecond) -> io::Result<Acquire> {
    let title = data_dir.display().to_string();
    #[cfg(windows)]
    {
        let forward = |hwnd| {
            if win::notify(hwnd, &current_cwd(), &current_command_line()) { Acquire::Forwarded } else { Acquire::Busy }
        };
        // Another instance is starting (it holds the dir but has no window yet): wait for its window and hand over.
        let wait_for_window = || {
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(5) {
                if let Some(found) = win::find(&title) {
                    return forward(found);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Acquire::Busy
        };
        if let Some(found) = win::find(&title) {
            return Ok(forward(found));
        }
        // Chromium's ProcessSingleton::Create, step by step: the startup mutex Electron 1.1.x takes too, a second look for
        // the window under it, `<data dir>/lockfile`, then our window, all before the mutex is released. A 1.1.x starting at
        // the same moment either sees our window or is refused the lockfile; we either see its window or its lockfile.
        let startup = win::StartupMutex::acquire();
        if let Some(found) = win::find(&title) {
            drop(startup);
            return Ok(forward(found));
        }
        let Some((lock, lock_path)) = try_lock(data_dir)? else {
            drop(startup);
            return Ok(wait_for_window());
        };
        let chromium_lock = match win::open_chromium_lockfile(data_dir) {
            win::ChromiumLock::Held(file) => Some(file),
            win::ChromiumLock::Unavailable => None,
            win::ChromiumLock::Owned => {
                // Electron holds `lockfile`: it owns the dir (its window follows within milliseconds).
                drop(startup);
                drop(lock);
                return Ok(wait_for_window());
            }
        };
        let window = win::MessageWindow::create(&title, on_second)?;
        drop(startup);
        // Defensive: a window of another process that appeared anyway (a 1.1.x that skipped the mutex): it owns the dir.
        if let Some(other) = win::find_other(&title, window.hwnd()) {
            drop(window);
            drop(chromium_lock);
            drop(lock);
            return Ok(forward(other));
        }
        Ok(Acquire::Primary(InstanceGuard { _lock: lock, lock_path, _chromium_lock: chromium_lock, _window: window }))
    }
    #[cfg(unix)]
    {
        let socket = data_dir.join("instance.sock");
        let Some((lock, lock_path)) = try_lock(data_dir)? else {
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(5) {
                if unix::notify(&socket, &current_cwd(), &current_command_line()) {
                    return Ok(Acquire::Forwarded);
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            return Ok(Acquire::Busy);
        };
        let _ = title;
        unix::listen(&socket, on_second)?;
        Ok(Acquire::Primary(InstanceGuard { _lock: lock, lock_path }))
    }
}

/// Waits (at most `timeout`) until no instance holds the data dir any more: the lock is free and, on Windows, the message
/// window is gone (it is closed by its own thread after the guard was dropped). A relaunch (W6) starts the new process only
/// then, so it does not hand over to the exiting one. True when released in time.
pub fn wait_released(data_dir: &Path, timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        #[cfg(windows)]
        let window_gone = win::find(&data_dir.display().to_string()).is_none();
        #[cfg(not(windows))]
        let window_gone = true;
        if window_gone && matches!(try_lock(data_dir), Ok(Some(_))) {
            return true;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[cfg(unix)]
mod unix {
    use super::*;
    use std::io::{Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};

    pub fn notify(socket: &Path, cwd: &str, command_line: &str) -> bool {
        let Ok(mut s) = UnixStream::connect(socket) else { return false };
        let _ = s.set_read_timeout(Some(Duration::from_secs(5)));
        if s.write_all(start_message(cwd, command_line).as_bytes()).is_err() {
            return false;
        }
        let _ = s.shutdown(std::net::Shutdown::Write);
        let mut answer = String::new();
        let _ = s.read_to_string(&mut answer);
        answer.starts_with("ACK")
    }

    pub fn listen(socket: &Path, on_second: OnSecond) -> io::Result<()> {
        let _ = fs::remove_file(socket);
        let listener = UnixListener::bind(socket)?;
        std::thread::Builder::new().name("instance-socket".into()).spawn(move || {
            for stream in listener.incoming().flatten() {
                let mut stream = stream;
                let mut text = String::new();
                let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
                let _ = stream.read_to_string(&mut text);
                if let Some(second) = parse_start_message(&text) {
                    let _ = stream.write_all(b"ACK");
                    on_second(second);
                }
            }
        })?;
        Ok(())
    }
}

#[cfg(windows)]
pub mod win {
    use super::*;
    use std::sync::OnceLock;

    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
    use windows::Win32::System::DataExchange::COPYDATASTRUCT;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::WindowsAndMessaging::{
        CreateWindowExW, DefWindowProcW, DispatchMessageW, FindWindowExW, GetMessageW, GetWindowThreadProcessId, HWND_MESSAGE,
        MSG, PostMessageW, RegisterClassExW, SMTO_ABORTIFHUNG, SendMessageTimeoutW, TranslateMessage, WINDOW_EX_STYLE, WM_CLOSE,
        WM_COPYDATA, WNDCLASSEXW, WS_OVERLAPPED,
    };
    use windows::core::{HSTRING, PCWSTR, w};

    const CLASS: PCWSTR = w!("Chrome_MessageWindow");
    /// Electron's ProcessSingleton names its startup mutex `Local\<app name>ProcessSingletonStartup` (Chromium's own is
    /// `Local\ChromeProcessSingletonStartup!`); the app name of 1.1.x is `unimux`. Checked against Electron 45: a held
    /// `Local\unimuxProcessSingletonStartup` makes `requestSingleInstanceLock()` wait.
    const STARTUP_MUTEX: PCWSTR = w!("Local\\unimuxProcessSingletonStartup");
    /// How long we wait for that mutex (Chromium waits forever; an instance holds it for a few milliseconds).
    const STARTUP_MUTEX_WAIT_MS: u32 = 10_000;

    /// The startup mutex, owned until dropped (released on the thread that took it: `acquire` never moves it).
    pub struct StartupMutex(Option<windows::Win32::Foundation::HANDLE>);

    impl StartupMutex {
        /// Takes the mutex; a failure or a timeout gives a guard that holds nothing (the lockfile and window checks remain).
        pub fn acquire() -> Self {
            use windows::Win32::Foundation::{CloseHandle, WAIT_ABANDONED, WAIT_OBJECT_0};
            use windows::Win32::System::Threading::{CreateMutexW, WaitForSingleObject};
            // SAFETY: a named mutex created without initial ownership, then waited on (Chromium's sequence).
            unsafe {
                let Ok(handle) = CreateMutexW(None, false, STARTUP_MUTEX) else { return Self(None) };
                let r = WaitForSingleObject(handle, STARTUP_MUTEX_WAIT_MS);
                if r == WAIT_OBJECT_0 || r == WAIT_ABANDONED {
                    Self(Some(handle))
                } else {
                    let _ = CloseHandle(handle);
                    Self(None)
                }
            }
        }
    }

    impl Drop for StartupMutex {
        fn drop(&mut self) {
            use windows::Win32::Foundation::CloseHandle;
            use windows::Win32::System::Threading::ReleaseMutex;
            if let Some(handle) = self.0.take() {
                // SAFETY: owned by this thread since acquire().
                unsafe {
                    let _ = ReleaseMutex(handle);
                    let _ = CloseHandle(handle);
                }
            }
        }
    }

    /// Opens `<data dir>/lockfile` the way Chromium does (GENERIC_WRITE, FILE_SHARE_READ, CREATE_ALWAYS,
    /// FILE_FLAG_DELETE_ON_CLOSE). None when another process holds it (Electron owns the dir). Any other failure (a read-only
    /// dir...) does not stop the start: the window and the instance.lock still decide.
    pub fn open_chromium_lockfile(data_dir: &Path) -> ChromiumLock {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        const FILE_FLAG_DELETE_ON_CLOSE: u32 = 0x0400_0000;
        const ERROR_ACCESS_DENIED: i32 = 5;
        const ERROR_SHARING_VIOLATION: i32 = 32;
        let opened = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .share_mode(FILE_SHARE_READ)
            .custom_flags(FILE_FLAG_DELETE_ON_CLOSE)
            .open(data_dir.join("lockfile"));
        match opened {
            Ok(file) => ChromiumLock::Held(file),
            // A held lockfile answers a sharing violation; one that is being deleted on close answers access denied.
            Err(e) if matches!(e.raw_os_error(), Some(ERROR_SHARING_VIOLATION | ERROR_ACCESS_DENIED)) => ChromiumLock::Owned,
            Err(_) => ChromiumLock::Unavailable,
        }
    }

    pub enum ChromiumLock {
        Held(File),
        /// Another process (Electron) holds it.
        Owned,
        /// Could not be opened for another reason.
        Unavailable,
    }

    /// The window of the instance that owns `title` (the data dir), if any.
    pub fn find(title: &str) -> Option<HWND> {
        let title = HSTRING::from(title);
        // SAFETY: plain lookup.
        unsafe { FindWindowExW(Some(HWND_MESSAGE), None, CLASS, PCWSTR(title.as_ptr())).ok() }
    }

    /// Another window with that title than `ours`.
    pub fn find_other(title: &str, ours: HWND) -> Option<HWND> {
        let t = HSTRING::from(title);
        let mut after: Option<HWND> = None;
        loop {
            // SAFETY: plain lookup, continuing after the previous match.
            let next = unsafe { FindWindowExW(Some(HWND_MESSAGE), after, CLASS, PCWSTR(t.as_ptr())).ok()? };
            if next != ours {
                return Some(next);
            }
            after = Some(next);
        }
    }

    /// Hands our command line to the owner (Chromium's AttemptToNotifyRunningChrome). True when it answered.
    pub fn notify(hwnd: HWND, cwd: &str, command_line: &str) -> bool {
        let text: Vec<u16> = start_message(cwd, command_line).encode_utf16().chain(std::iter::once(0)).collect();
        let cds = COPYDATASTRUCT { dwData: 0, cbData: (text.len() * 2) as u32, lpData: text.as_ptr() as *mut _ };
        // The owner brings its window to the front: it may do so only with the foreground right this process got from the
        // user's click (Explorer's "Open with", a shortcut), passed on first like Chromium does.
        let mut owner_pid = 0u32;
        // SAFETY: plain lookup of the window's process.
        unsafe { GetWindowThreadProcessId(hwnd, Some(&mut owner_pid)) };
        if owner_pid != 0 {
            crate::win::allow_set_foreground(owner_pid);
        }
        let mut result: usize = 0;
        // SAFETY: the data outlives the synchronous call.
        let sent = unsafe {
            SendMessageTimeoutW(
                hwnd,
                WM_COPYDATA,
                WPARAM(0),
                LPARAM(&cds as *const _ as isize),
                SMTO_ABORTIFHUNG,
                20_000,
                Some(&mut result),
            )
        };
        sent.0 != 0 && result != 0
    }

    static CALLBACK: OnceLock<OnSecond> = OnceLock::new();

    unsafe extern "system" fn wndproc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if msg == WM_COPYDATA {
            // SAFETY: WM_COPYDATA's lparam is a COPYDATASTRUCT valid for the duration of the message.
            let cds = unsafe { &*(lparam.0 as *const COPYDATASTRUCT) };
            let units = cds.cbData as usize / 2;
            let data = if cds.lpData.is_null() {
                &[][..]
            } else {
                unsafe { std::slice::from_raw_parts(cds.lpData as *const u16, units) }
            };
            let text = String::from_utf16_lossy(data);
            if let Some(second) = parse_start_message(&text) {
                if let Some(cb) = CALLBACK.get() {
                    cb(second);
                }
                return LRESULT(1);
            }
            return LRESULT(0);
        }
        // SAFETY: default handling.
        unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
    }

    /// Our own `Chrome_MessageWindow`, with a message loop on its own thread.
    pub struct MessageWindow {
        hwnd: isize,
        thread: Option<std::thread::JoinHandle<()>>,
    }

    impl MessageWindow {
        pub fn create(title: &str, on_second: OnSecond) -> io::Result<Self> {
            let _ = CALLBACK.set(on_second);
            let title = title.to_string();
            let (tx, rx) = std::sync::mpsc::channel::<io::Result<isize>>();
            let thread = std::thread::Builder::new().name("instance-window".into()).spawn(move || {
                // SAFETY: class registration and window creation on this thread, then its message loop.
                unsafe {
                    let instance = match GetModuleHandleW(None) {
                        Ok(h) => h,
                        Err(e) => {
                            let _ = tx.send(Err(io::Error::other(e)));
                            return;
                        }
                    };
                    let class = WNDCLASSEXW {
                        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
                        lpfnWndProc: Some(wndproc),
                        hInstance: instance.into(),
                        lpszClassName: CLASS,
                        ..Default::default()
                    };
                    RegisterClassExW(&class);
                    let t = HSTRING::from(title.as_str());
                    let hwnd = CreateWindowExW(
                        WINDOW_EX_STYLE(0),
                        CLASS,
                        PCWSTR(t.as_ptr()),
                        WS_OVERLAPPED,
                        0,
                        0,
                        0,
                        0,
                        Some(HWND_MESSAGE),
                        None,
                        Some(instance.into()),
                        None,
                    );
                    match hwnd {
                        Ok(h) => {
                            let _ = tx.send(Ok(h.0 as isize));
                        }
                        Err(e) => {
                            let _ = tx.send(Err(io::Error::other(e)));
                            return;
                        }
                    }
                    let mut msg = MSG::default();
                    while GetMessageW(&mut msg, None, 0, 0).0 > 0 {
                        let _ = TranslateMessage(&msg);
                        DispatchMessageW(&msg);
                    }
                }
            })?;
            let hwnd = rx.recv().map_err(io::Error::other)??;
            Ok(Self { hwnd, thread: Some(thread) })
        }

        pub fn hwnd(&self) -> HWND {
            HWND(self.hwnd as *mut _)
        }
    }

    impl Drop for MessageWindow {
        fn drop(&mut self) {
            // SAFETY: ask the window's own thread to close it (DestroyWindow must run on that thread).
            unsafe {
                let _ = PostMessageW(Some(self.hwnd()), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
            // The thread keeps its (now empty) message loop until the process ends.
            self.thread.take();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use parking_lot::Mutex;

    #[test]
    fn start_message_round_trip() {
        let m = start_message("C:\\x", "unimux.exe --a");
        assert_eq!(parse_start_message(&m), Some(SecondInstance { cwd: "C:\\x".into(), command_line: "unimux.exe --a".into() }));
        assert_eq!(parse_start_message("STOP\0x"), None);
    }

    #[test]
    fn command_lines_round_trip_and_raw_ones_split_like_command_line_to_argv() {
        let args: Vec<String> = [
            r"C:\Program Files\unimux\unimux.exe",
            r"D:\My Files\notes.md",
            "plain.txt",
            "",
            r#"with "quote""#,
            r"C:\dir with space\",
            r#"a\\"b"#,
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(split_command_line(&join_command_line(&args)), args);
        // Explorer's `"<exe>" "%1"`, and an unquoted line with an empty argument.
        assert_eq!(split_command_line(r#""C:\Apps\unimux.exe" "C:\a b\c.txt""#), vec![r"C:\Apps\unimux.exe", r"C:\a b\c.txt"]);
        assert_eq!(split_command_line(r#"unimux.exe --flag  x\y """#), vec!["unimux.exe", "--flag", r"x\y", ""]);
        assert!(split_command_line("  ").is_empty());
    }

    #[test]
    fn two_data_dirs_coexist_and_a_second_start_on_one_dir_is_forwarded() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let heard = Arc::new(Mutex::new(Vec::new()));
        let h = heard.clone();
        let first = acquire(a.path(), Arc::new(move |s| h.lock().push(s))).unwrap();
        assert!(matches!(first, Acquire::Primary(_)));
        let other_dir = acquire(b.path(), Arc::new(|_| {})).unwrap();
        assert!(matches!(other_dir, Acquire::Primary(_)));
        // The second acquire runs in this same process, like a second unimux.exe would.
        let second = acquire(a.path(), Arc::new(|_| {})).unwrap();
        assert!(matches!(second, Acquire::Forwarded));
        let deadline = Instant::now() + Duration::from_secs(5);
        while heard.lock().is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(heard.lock().len(), 1);
        // W6 relaunch: the new process waits until the exiting one released the dir, then takes it instead of handing over.
        // (Part of this test: the WM_COPYDATA callback is set once per process, so no other test may acquire first.)
        assert!(!wait_released(a.path(), Duration::from_millis(100)));
        drop(first);
        assert!(wait_released(a.path(), Duration::from_secs(5)));
        let next = acquire(a.path(), Arc::new(|_| {})).unwrap();
        assert!(matches!(next, Acquire::Primary(_)));
        drop(next);
        drop(other_dir);
    }
}
