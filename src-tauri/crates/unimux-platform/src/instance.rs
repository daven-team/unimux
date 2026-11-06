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
//! An exclusive lock on `<data dir>/instance.lock` closes the start-up race between two 1.2.0 processes. Keyed by data dir,
//! so parallel `MC_DATA_DIR` runs coexist.
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

fn current_command_line() -> String {
    std::env::args().collect::<Vec<_>>().join(" ")
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
        if let Some(found) = win::find(&title) {
            return Ok(if win::notify(found, &current_cwd(), &current_command_line()) {
                Acquire::Forwarded
            } else {
                Acquire::Busy
            });
        }
        let Some((lock, lock_path)) = try_lock(data_dir)? else {
            // Another 1.2.0 is starting: wait for its window and hand over.
            let start = Instant::now();
            while start.elapsed() < Duration::from_secs(5) {
                if let Some(found) = win::find(&title) {
                    return Ok(if win::notify(found, &current_cwd(), &current_command_line()) {
                        Acquire::Forwarded
                    } else {
                        Acquire::Busy
                    });
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            return Ok(Acquire::Busy);
        };
        let window = win::MessageWindow::create(&title, on_second)?;
        // A 1.1.x that created its window between our check and our window: it owns the dir.
        if let Some(other) = win::find_other(&title, window.hwnd()) {
            drop(window);
            drop(lock);
            return Ok(if win::notify(other, &current_cwd(), &current_command_line()) {
                Acquire::Forwarded
            } else {
                Acquire::Busy
            });
        }
        Ok(Acquire::Primary(InstanceGuard { _lock: lock, lock_path, _window: window }))
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
        CreateWindowExW, DefWindowProcW, DispatchMessageW, FindWindowExW, GetMessageW, HWND_MESSAGE, MSG, PostMessageW,
        RegisterClassExW, SMTO_ABORTIFHUNG, SendMessageTimeoutW, TranslateMessage, WINDOW_EX_STYLE, WM_CLOSE, WM_COPYDATA,
        WNDCLASSEXW, WS_OVERLAPPED,
    };
    use windows::core::{HSTRING, PCWSTR, w};

    const CLASS: PCWSTR = w!("Chrome_MessageWindow");

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
        drop(first);
        drop(other_dir);
    }
}
