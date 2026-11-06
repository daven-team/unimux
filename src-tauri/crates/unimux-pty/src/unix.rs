//! The Unix pty (macOS, and Linux for the tests): what node-pty 1.1.0's UnixTerminal does, with the same surface as
//! [`crate::conpty::Pty`].
//!
//! - `openpty`, the child in its own session (`setsid`) with the slave as its controlling terminal (`TIOCSCTTY`) and as
//!   stdin / stdout / stderr; signal dispositions and the signal mask reset to the defaults; the environment gets
//!   `PWD = cwd` like node-pty's;
//! - a reader thread with a pause gate (flow control) that drains the master until it ends; output that arrives after the
//!   shell ended is delivered before the exit; the exit is reported when the master ends or 200 ms after the shell ended
//!   (node-pty's DESTROY_SOCKET_TIMEOUT_MS: a background child may keep the slave open for ever);
//! - input through a writer thread (a write to a pty whose child does not read would block the caller);
//! - a kill sends SIGHUP to the shell's process group and the terminal's foreground group, and 1 s later SIGKILL to every
//!   process left in the terminal's session (dev servers an agent started, background jobs that ignore SIGHUP);
//! - the exit code is the shell's exit status, 0 when it ended by a signal (node-pty reports the signal separately and
//!   PtyManager only passes the code on).

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};

const READ_SIZE: usize = 64 * 1024;
/// node-pty's DESTROY_SOCKET_TIMEOUT_MS: after the shell ended, how long the output may take to end by itself.
const EXIT_DRAIN: Duration = Duration::from_millis(200);
/// Between the SIGHUP of a kill and the SIGKILL of what is left of the session.
const KILL_GRACE: Duration = Duration::from_millis(1000);
/// How often a blocked read looks at the stop flag.
const POLL_MS: i32 = 50;

/// What to start in a new pty.
#[derive(Debug, Clone)]
pub struct SpawnOptions {
    pub file: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    /// The complete environment (`None`: inherit this process's). PWD is set to the cwd either way.
    pub env: Option<Vec<(String, String)>>,
    pub cols: u16,
    pub rows: u16,
}

impl SpawnOptions {
    pub fn new(file: impl Into<String>, args: &[&str]) -> Self {
        Self { file: file.into(), args: args.iter().map(|a| a.to_string()).collect(), cwd: None, env: None, cols: 80, rows: 24 }
    }
}

#[derive(Default)]
struct GateState {
    paused: bool,
    stop: bool,
}

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
    fn stop(&self) {
        self.state.lock().stop = true;
        self.cv.notify_all();
    }
    fn stopped(&self) -> bool {
        self.state.lock().stop
    }
    /// Waits while paused; false once the reader has to stop.
    fn wait_open(&self) -> bool {
        let mut s = self.state.lock();
        while s.paused && !s.stop {
            self.cv.wait(&mut s);
        }
        !s.stop
    }
}

struct Shared {
    master: OwnedFd,
    pid: u32,
    gate: Gate,
    exit: Mutex<Option<i32>>,
    exit_cv: Condvar,
    eof: AtomicBool,
    killed: AtomicBool,
}

impl Shared {
    fn exit_code(&self) -> Option<i32> {
        *self.exit.lock()
    }

    fn wait_exit_until(&self, deadline: Instant) -> Option<i32> {
        let mut exit = self.exit.lock();
        while exit.is_none() {
            if self.exit_cv.wait_until(&mut exit, deadline).timed_out() {
                break;
            }
        }
        *exit
    }

    /// SIGKILL to every process of the terminal's session (the shell is its leader, so sid = pid).
    fn kill_session(&self) {
        let sid = self.pid as libc::pid_t;
        for pid in session_members(sid) {
            // SAFETY: plain signal; the pids were members of our session a moment ago.
            unsafe {
                libc::kill(pid, libc::SIGKILL);
            }
        }
        // The leader itself while it is not reaped yet (it cannot be another process: the waiter has not reaped it).
        if self.exit_code().is_none() {
            // SAFETY: as above.
            unsafe {
                libc::kill(sid, libc::SIGKILL);
            }
        }
    }
}

/// Processes whose session is `sid` (the shell, its jobs and whatever they started without a setsid of their own).
fn session_members(sid: libc::pid_t) -> Vec<libc::pid_t> {
    all_pids()
        .into_iter()
        // SAFETY: getsid only reads.
        .filter(|&pid| pid > 0 && unsafe { libc::getsid(pid) } == sid)
        .collect()
}

#[cfg(target_os = "linux")]
fn all_pids() -> Vec<libc::pid_t> {
    std::fs::read_dir("/proc")
        .map(|dir| dir.filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok()).collect())
        .unwrap_or_default()
}

#[cfg(target_os = "macos")]
fn all_pids() -> Vec<libc::pid_t> {
    // SAFETY: the documented two-call pattern; the buffer is sized from the first call (with room for new processes).
    unsafe {
        let n = libc::proc_listallpids(std::ptr::null_mut(), 0);
        if n <= 0 {
            return Vec::new();
        }
        let mut buf: Vec<libc::pid_t> = vec![0; n as usize + 64];
        let bytes = (buf.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
        let got = libc::proc_listallpids(buf.as_mut_ptr() as *mut libc::c_void, bytes);
        buf.truncate(got.max(0) as usize);
        buf
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn all_pids() -> Vec<libc::pid_t> {
    Vec::new()
}

fn set_cloexec(fd: RawFd) -> io::Result<()> {
    // SAFETY: fcntl on a valid descriptor.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        if flags < 0 || libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) < 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

fn winsize(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize { ws_row: rows.max(1), ws_col: cols.max(2), ws_xpixel: 0, ws_ypixel: 0 }
}

/// One terminal: a pty and the session running in it.
pub struct Pty {
    shared: Arc<Shared>,
    input: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
}

#[derive(Clone)]
pub struct PtyWriter(mpsc::Sender<Vec<u8>>);

impl PtyWriter {
    pub fn write(&self, data: &[u8]) {
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
pub type ExitFn = Box<dyn FnOnce(i32) + Send>;

impl Pty {
    /// Starts `opts` in a new pty. `on_data` gets every chunk of output on the reader thread; `on_exit` gets the exit code
    /// once the process ended and its output was read (or 200 ms passed after the exit).
    pub fn spawn(opts: &SpawnOptions, mut on_data: DataFn, on_exit: ExitFn) -> io::Result<Pty> {
        let (mut master, mut slave): (RawFd, RawFd) = (-1, -1);
        let mut size = winsize(opts.cols, opts.rows);
        // SAFETY: openpty fills both descriptors, which are owned right after. The winsize pointer is `*const` in the Linux
        // binding and `*mut` in the macOS one.
        let (master, slave) = unsafe {
            if libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), (&raw mut size) as _) != 0 {
                return Err(io::Error::last_os_error());
            }
            (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave))
        };
        set_cloexec(master.as_raw_fd())?;
        set_cloexec(slave.as_raw_fd())?;

        let cwd = match &opts.cwd {
            Some(c) => c.clone(),
            None => std::env::current_dir()?,
        };
        let mut cmd = Command::new(&opts.file);
        cmd.args(&opts.args).current_dir(&cwd);
        if let Some(env) = &opts.env {
            cmd.env_clear();
            for (k, v) in env {
                if k != "PWD" {
                    cmd.env(k, v);
                }
            }
        }
        cmd.env("PWD", &cwd);
        cmd.stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave.try_clone()?));
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            cmd.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                    return Err(io::Error::last_os_error());
                }
                let mut set: libc::sigset_t = std::mem::zeroed();
                libc::sigemptyset(&mut set);
                libc::pthread_sigmask(libc::SIG_SETMASK, &set, std::ptr::null_mut());
                for sig in 1..32 {
                    if sig != libc::SIGKILL && sig != libc::SIGSTOP {
                        libc::signal(sig, libc::SIG_DFL);
                    }
                }
                Ok(())
            });
        }
        let mut child = cmd.spawn()?;
        drop(cmd);
        // Our slave copies must go, or the master never ends.
        drop(slave);
        let pid = child.id();

        let reader_fd = master.try_clone()?;
        let writer_fd = master.try_clone()?;
        let shared = Arc::new(Shared {
            master,
            pid,
            gate: Gate::default(),
            exit: Mutex::new(None),
            exit_cv: Condvar::new(),
            eof: AtomicBool::new(false),
            killed: AtomicBool::new(false),
        });
        let fail = |shared: &Shared, e: io::Error| {
            shared.kill_session();
            e
        };

        let (tx, rx) = mpsc::channel::<Vec<u8>>();
        let mut writer = File::from(writer_fd);
        std::thread::Builder::new()
            .name("pty-write".into())
            .spawn(move || {
                while let Ok(data) = rx.recv() {
                    if writer.write_all(&data).is_err() {
                        break;
                    }
                }
            })
            .map_err(|e| fail(&shared, e))?;

        let waiter = shared.clone();
        std::thread::Builder::new()
            .name("pty-wait".into())
            .spawn(move || {
                let code = match child.wait() {
                    Ok(status) => status.code().unwrap_or(0),
                    Err(_) => 0,
                };
                *waiter.exit.lock() = Some(code);
                waiter.exit_cv.notify_all();
                let deadline = Instant::now() + EXIT_DRAIN;
                while !waiter.eof.load(Ordering::SeqCst) && Instant::now() < deadline {
                    std::thread::sleep(Duration::from_millis(5));
                }
                waiter.gate.stop();
            })
            .map_err(|e| fail(&shared, e))?;

        let reader = shared.clone();
        let mut file = File::from(reader_fd);
        std::thread::Builder::new()
            .name("pty-read".into())
            .spawn(move || {
                let mut buf = vec![0u8; READ_SIZE];
                'read: loop {
                    if !reader.gate.wait_open() {
                        break;
                    }
                    // Wait for data with a timeout, so a stop (exit drain over) ends a read nobody will answer.
                    loop {
                        let mut pfd = libc::pollfd { fd: file.as_raw_fd(), events: libc::POLLIN, revents: 0 };
                        // SAFETY: one valid pollfd.
                        let r = unsafe { libc::poll(&mut pfd, 1, POLL_MS) };
                        if r > 0 {
                            break;
                        }
                        if r < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted {
                            break 'read;
                        }
                        if reader.gate.stopped() {
                            break 'read;
                        }
                    }
                    match file.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => on_data(&buf[..n]),
                        Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                        // EIO: every slave copy is closed.
                        Err(_) => break,
                    }
                }
                reader.eof.store(true, Ordering::SeqCst);
                let mut exit = reader.exit.lock();
                while exit.is_none() {
                    reader.exit_cv.wait(&mut exit);
                }
                let code = exit.unwrap_or(0);
                drop(exit);
                on_exit(code);
            })
            .map_err(|e| fail(&shared, e))?;

        Ok(Pty { shared, input: Mutex::new(Some(tx)) })
    }

    pub fn pid(&self) -> u32 {
        self.shared.pid
    }

    pub fn pause_handle(&self) -> PauseHandle {
        PauseHandle(self.shared.clone())
    }

    pub fn writer(&self) -> Option<PtyWriter> {
        self.input.lock().clone().map(PtyWriter)
    }

    /// Queues input for the terminal (never blocks).
    pub fn write(&self, data: &[u8]) {
        if let Some(tx) = self.input.lock().as_ref() {
            let _ = tx.send(data.to_vec());
        }
    }

    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let size = winsize(cols, rows);
        // SAFETY: TIOCSWINSZ on our master with a valid winsize.
        if unsafe { libc::ioctl(self.shared.master.as_raw_fd(), libc::TIOCSWINSZ as _, &size) } < 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    /// Flow control: stops reading the master (the shell then blocks on a full pty) or reads again.
    pub fn set_paused(&self, paused: bool) {
        self.shared.gate.set_paused(paused);
    }

    /// SIGHUP to the shell's process group and the foreground group, SIGKILL to what is left of the session 1 s later (at
    /// once when the shell is gone before that). Returns at once; the reader drains the rest and reports the exit.
    pub fn kill(&self) {
        if self.shared.killed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.input.lock().take();
        let sid = self.shared.pid as libc::pid_t;
        if self.shared.exit_code().is_none() {
            // SAFETY: plain signals to our own session's groups (the leader is not reaped yet).
            unsafe {
                libc::killpg(sid, libc::SIGHUP);
                let fg = libc::tcgetpgrp(self.shared.master.as_raw_fd());
                if fg > 0 && fg != sid {
                    libc::killpg(fg, libc::SIGHUP);
                }
            }
        }
        let shared = self.shared.clone();
        let escalate = move || {
            shared.wait_exit_until(Instant::now() + KILL_GRACE);
            shared.kill_session();
        };
        if std::thread::Builder::new().name("pty-kill".into()).spawn(escalate).is_err() {
            self.shared.kill_session();
        }
    }

    /// SIGKILL to the whole session now (kill_all after its time limit).
    pub fn kill_tree(&self) {
        self.shared.killed.store(true, Ordering::SeqCst);
        self.input.lock().take();
        self.shared.kill_session();
    }

    pub fn exit_code(&self) -> Option<i32> {
        self.shared.exit_code()
    }

    /// Waits for the process (not the output) to end.
    pub fn wait_exit(&self, timeout: Duration) -> Option<i32> {
        self.shared.wait_exit_until(Instant::now() + timeout)
    }

    pub fn process_alive(pid: u32) -> bool {
        // SAFETY: signal 0 only checks.
        let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
        r == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        if self.shared.exit_code().is_none() {
            self.kill();
        } else {
            self.input.lock().take();
        }
    }
}
