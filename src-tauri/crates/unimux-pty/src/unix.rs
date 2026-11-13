//! The Unix pty (macOS, and Linux for the tests): what node-pty 1.1.0's UnixTerminal does, with the same surface as
//! [`crate::conpty::Pty`].
//!
//! - `openpty` with node-pty's termios ([`node_pty_termios`], IUTF8 included), the child in its own session (`setsid`)
//!   with the slave as its controlling terminal (`TIOCSCTTY`) and as stdin / stdout / stderr; signal dispositions and the
//!   signal mask reset to the defaults; the environment gets `PWD = cwd` like node-pty's;
//! - chdir and execvp in the child like node-pty's: a missing cwd or a program that does not start is not a spawn error
//!   but a terminal that exits with code 1 (on Linux after perror's "chdir(2) failed." / "execvp(3) failed.");
//! - a reader thread with a pause gate (flow control) that drains the master until it ends; output that arrives after the
//!   shell ended is delivered before the exit; the exit is reported when the master ends or 200 ms after the shell ended
//!   (node-pty's DESTROY_SOCKET_TIMEOUT_MS: a background child may keep the slave open for ever);
//! - input through a writer thread (a write to a pty whose child does not read would block the caller);
//! - a kill sends SIGHUP to the shell's process group and the terminal's foreground group, and 1 s later SIGKILL to every
//!   process left in the terminal's session (dev servers an agent started, background jobs that ignore SIGHUP);
//! - the exit code is the shell's exit status, 0 when it ended by a signal (node-pty reports the signal separately and
//!   PtyManager only passes the code on).

use std::ffi::CString;
use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::os::unix::ffi::OsStrExt;
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
    /// The child ended: the reader drains the master to its end (or the exit drain's deadline) and is never paused again,
    /// so the last output of a terminal paused by flow control is not lost.
    draining: bool,
}

#[derive(Default)]
struct Gate {
    state: Mutex<GateState>,
    cv: Condvar,
}

impl Gate {
    fn set_paused(&self, paused: bool) {
        let mut s = self.state.lock();
        s.paused = paused && !s.draining;
        drop(s);
        self.cv.notify_all();
    }
    fn drain(&self) {
        let mut s = self.state.lock();
        s.draining = true;
        s.paused = false;
        drop(s);
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

/// The termios node-pty 1.1.0 gives every pty (pty.cc, `PtyFork`, with its default utf8 encoding, so IUTF8 is on: a
/// backspace in canonical mode erases a whole multibyte character). The kernel's defaults lack IUTF8 and differ in details.
pub fn node_pty_termios() -> libc::termios {
    // SAFETY: termios is plain data; every field node-pty sets is set below, the rest stays zero like its `termios()`.
    let mut t: libc::termios = unsafe { std::mem::zeroed() };
    t.c_iflag = libc::ICRNL | libc::IXON | libc::IXANY | libc::IMAXBEL | libc::BRKINT | libc::IUTF8;
    t.c_oflag = libc::OPOST | libc::ONLCR;
    t.c_cflag = libc::CREAD | libc::CS8 | libc::HUPCL;
    t.c_lflag = libc::ICANON | libc::ISIG | libc::IEXTEN | libc::ECHO | libc::ECHOE | libc::ECHOK | libc::ECHOKE | libc::ECHOCTL;
    let cc = &mut t.c_cc;
    cc[libc::VEOF] = 4;
    // node-pty assigns -1 (a cc_t of 0xff).
    cc[libc::VEOL] = 0xff;
    cc[libc::VEOL2] = 0xff;
    cc[libc::VERASE] = 0x7f;
    cc[libc::VWERASE] = 23;
    cc[libc::VKILL] = 21;
    cc[libc::VREPRINT] = 18;
    cc[libc::VINTR] = 3;
    cc[libc::VQUIT] = 0x1c;
    cc[libc::VSUSP] = 26;
    cc[libc::VSTART] = 17;
    cc[libc::VSTOP] = 19;
    cc[libc::VLNEXT] = 22;
    cc[libc::VDISCARD] = 15;
    cc[libc::VMIN] = 1;
    cc[libc::VTIME] = 0;
    #[cfg(target_os = "macos")]
    {
        cc[libc::VDSUSP] = 25;
        cc[libc::VSTATUS] = 20;
    }
    // SAFETY: valid termios pointer.
    unsafe {
        libc::cfsetispeed(&mut t, libc::B38400);
        libc::cfsetospeed(&mut t, libc::B38400);
    }
    t
}

fn cstring(s: impl AsRef<std::ffi::OsStr>) -> io::Result<CString> {
    CString::new(s.as_ref().as_bytes()).map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
}

/// The text perror would print for each errno, built in the parent (strerror is not safe between fork and exec).
#[cfg(target_os = "linux")]
fn errno_texts() -> &'static [Vec<u8>] {
    static TEXTS: std::sync::OnceLock<Vec<Vec<u8>>> = std::sync::OnceLock::new();
    TEXTS.get_or_init(|| {
        (0..200)
            .map(|e| {
                let text = io::Error::from_raw_os_error(e).to_string();
                let suffix = format!(" (os error {e})");
                text.strip_suffix(&suffix).unwrap_or(&text).as_bytes().to_vec()
            })
            .collect()
    })
}

/// node-pty's `perror(what)` in the child (Linux only; the macOS spawn-helper exits silently). Async-signal-safe.
#[cfg(target_os = "linux")]
fn child_perror(what: &[u8], texts: &[Vec<u8>]) {
    let errno = io::Error::last_os_error().raw_os_error().unwrap_or(0);
    let text: &[u8] = texts.get(errno as usize).map_or(b"Unknown error", |t| t.as_slice());
    for part in [what, b": ", text, b"\n"] {
        // SAFETY: write(2) of a valid buffer to stderr (the pty slave).
        unsafe {
            libc::write(2, part.as_ptr().cast(), part.len());
        }
    }
}

#[cfg(target_os = "macos")]
fn set_environ(env: *const *const libc::c_char) {
    // SAFETY: the child's own environment pointer; only the child is running after the fork.
    unsafe {
        *libc::_NSGetEnviron() = env as *mut *mut libc::c_char;
    }
}

#[cfg(not(target_os = "macos"))]
fn set_environ(env: *const *const libc::c_char) {
    unsafe extern "C" {
        static mut environ: *const *const libc::c_char;
    }
    // SAFETY: as above.
    unsafe {
        environ = env;
    }
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
        let mut term = node_pty_termios();
        // SAFETY: openpty fills both descriptors, which are owned right after. The termios / winsize pointers are `*const`
        // in the Linux binding and `*mut` in the macOS one.
        let (master, slave) = unsafe {
            if libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), (&raw mut term) as _, (&raw mut size) as _) != 0 {
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
        // Everything the child needs is built here: between fork and exec only async-signal-safe calls run.
        let mut env: Vec<(std::ffi::OsString, std::ffi::OsString)> = match &opts.env {
            Some(env) => env.iter().filter(|(k, _)| k != "PWD").map(|(k, v)| (k.into(), v.into())).collect(),
            None => std::env::vars_os().filter(|(k, _)| k != "PWD").collect(),
        };
        env.push(("PWD".into(), cwd.clone().into_os_string()));
        let env_c: Vec<CString> = env
            .iter()
            .map(|(k, v)| {
                let mut kv = k.clone();
                kv.push("=");
                kv.push(v);
                cstring(kv)
            })
            .collect::<io::Result<_>>()?;
        let mut envp: Vec<*const libc::c_char> = env_c.iter().map(|c| c.as_ptr()).collect();
        envp.push(std::ptr::null());
        let file_c = cstring(&opts.file)?;
        let args_c: Vec<CString> =
            std::iter::once(Ok(file_c.clone())).chain(opts.args.iter().map(cstring)).collect::<io::Result<_>>()?;
        let mut argv: Vec<*const libc::c_char> = args_c.iter().map(|c| c.as_ptr()).collect();
        argv.push(std::ptr::null());
        let cwd_c = cstring(cwd.as_os_str())?;
        #[cfg(target_os = "linux")]
        let texts = errno_texts();
        // Raw pointers are not Send; the closure only runs in the forked child, where they stay valid (the parent's
        // memory is copied).
        let ptrs = (envp.as_ptr() as usize, argv.as_ptr() as usize);

        // std::process::Command forks, sets up stdio and reports a failure of the pre-exec steps. The exec itself is done
        // here like node-pty's (chdir, `environ = env`, execvp, so PATH comes from the cell environment): a cwd that is
        // gone or a program that does not start gives a terminal that exits with code 1 (Linux: with perror's text), not
        // a spawn error, as in 1.1.4. `Command`'s own exec is never reached.
        let low = crate::low_priority();
        let mut cmd = Command::new(&opts.file);
        cmd.stdin(Stdio::from(slave.try_clone()?))
            .stdout(Stdio::from(slave.try_clone()?))
            .stderr(Stdio::from(slave.try_clone()?));
        // SAFETY: only async-signal-safe calls between fork and exec.
        unsafe {
            cmd.pre_exec(move || {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                // Below the app (see unimux_pty::set_low_priority); a failure only keeps the normal priority.
                if low {
                    libc::setpriority(libc::PRIO_PROCESS, 0, 5);
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
                if libc::chdir(cwd_c.as_ptr()) == -1 {
                    #[cfg(target_os = "linux")]
                    child_perror(b"chdir(2) failed.", texts);
                    libc::_exit(1);
                }
                set_environ(ptrs.0 as *const *const libc::c_char);
                let argv = ptrs.1 as *const *const libc::c_char;
                libc::execvp(*argv, argv);
                #[cfg(target_os = "linux")]
                child_perror(b"execvp(3) failed.", texts);
                libc::_exit(1);
            });
        }
        let spawned = cmd.spawn();
        drop(cmd);
        // The child has its own copies now.
        drop((envp, argv, env_c, args_c, file_c));
        let mut child = spawned?;
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
                // A reader paused by flow control reads again: the output left in the pty arrives before the exit.
                waiter.gate.drain();
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The termios the shell sees is node-pty's (read back from the terminal, as the child's tcgetattr would see it).
    #[test]
    fn the_terminal_gets_node_ptys_termios() {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let pty = Pty::spawn(
            &SpawnOptions::new("/bin/sh", &["-c", "sleep 5"]),
            Box::new(|_| {}),
            Box::new(move |code| {
                let _ = tx.lock().send(code);
            }),
        )
        .unwrap();
        // SAFETY: tcgetattr into a zeroed termios on our own master (Linux and macOS return the terminal's settings).
        let t = unsafe {
            let mut t: libc::termios = std::mem::zeroed();
            assert_eq!(libc::tcgetattr(pty.shared.master.as_raw_fd(), &mut t), 0, "{}", io::Error::last_os_error());
            t
        };
        let want = node_pty_termios();
        assert_ne!(t.c_iflag & libc::IUTF8, 0, "IUTF8 missing");
        assert_eq!(t.c_iflag, want.c_iflag);
        assert_eq!(t.c_oflag, want.c_oflag);
        assert_eq!(t.c_lflag, want.c_lflag);
        let cflag = libc::CREAD | libc::CS8 | libc::HUPCL;
        assert_eq!(t.c_cflag & cflag, cflag);
        for i in [libc::VEOF, libc::VERASE, libc::VWERASE, libc::VKILL, libc::VINTR, libc::VQUIT, libc::VSUSP, libc::VMIN] {
            assert_eq!(t.c_cc[i], want.c_cc[i], "c_cc[{i}]");
        }
        assert_eq!(t.c_cc[libc::VERASE], 0x7f);
        #[cfg(target_os = "macos")]
        assert_eq!((t.c_cc[libc::VDSUSP], t.c_cc[libc::VSTATUS]), (25, 20));
        // SAFETY: reading the speed of a valid termios.
        assert_eq!(unsafe { libc::cfgetospeed(&t) }, libc::B38400);
        pty.kill();
        assert!(rx.recv_timeout(Duration::from_secs(5)).is_ok());
    }
}
