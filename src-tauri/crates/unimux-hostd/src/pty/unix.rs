//! Unix backend (stand-in until P1's): node-pty's unix spawn reduced to what the suites need. openpty with the start size,
//! the child in its own session with the pty as controlling terminal (setsid + TIOCSCTTY) and as stdin / stdout / stderr,
//! a reader thread (EIO / EOF = the last slave side closed), a writer thread, a waiter. The exit is reported once the
//! process ended and the output ended (node-pty: output after exit is delivered), but at most EXIT_DRAIN after the process
//! ended: a background child that keeps the slave side open (`sleep 600 & exit`, a dev server) does not hold the exit back
//! (node-pty's DESTROY_SOCKET_TIMEOUT_MS). kill = SIGHUP to the shell's process group (node-pty sends SIGHUP to the shell),
//! kill_tree = SIGKILL to the group. PWD is set to the cwd like node-pty's UnixTerminal does.

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::sync::{Arc, mpsc};
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};

use super::{DataFn, ExitFn, Launch, Term};

/// node-pty unixTerminal.js DESTROY_SOCKET_TIMEOUT_MS: how long the output may still come after the shell ended.
const EXIT_DRAIN: Duration = Duration::from_millis(200);

/// Shared by the waiter (the exit code) and the reader (the output ended or was let go).
#[derive(Default)]
struct ExitState {
    code: Option<u32>,
    reader_done: bool,
}

struct UnixTerm {
    pid: u32,
    master: OwnedFd,
    input: Mutex<Option<mpsc::Sender<Vec<u8>>>>,
}

fn winsize(cols: u16, rows: u16) -> libc::winsize {
    libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 }
}

impl Term for UnixTerm {
    fn pid(&self) -> u32 {
        self.pid
    }

    fn write(&self, data: &[u8]) {
        if let Some(tx) = self.input.lock().as_ref() {
            let _ = tx.send(data.to_vec());
        }
    }

    fn resize(&self, cols: u16, rows: u16) {
        let ws = winsize(cols, rows);
        // SAFETY: a valid fd and a winsize that lives for the call.
        unsafe {
            libc::ioctl(self.master.as_raw_fd(), libc::TIOCSWINSZ as _, &ws);
        }
    }

    fn kill(&self) {
        // SAFETY: plain signal calls; the shell leads its own process group (setsid).
        unsafe {
            if libc::killpg(self.pid as libc::pid_t, libc::SIGHUP) != 0 {
                libc::kill(self.pid as libc::pid_t, libc::SIGHUP);
            }
        }
    }

    fn kill_tree(&self) {
        // SAFETY: as above.
        unsafe {
            libc::killpg(self.pid as libc::pid_t, libc::SIGKILL);
        }
    }

    fn source(&self) -> String {
        "openpty".into()
    }
}

fn cloexec(fd: libc::c_int) {
    // SAFETY: fcntl on an fd we own.
    unsafe {
        let flags = libc::fcntl(fd, libc::F_GETFD);
        libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC);
    }
}

pub fn spawn(launch: &Launch, mut on_data: DataFn, on_exit: ExitFn) -> io::Result<Arc<dyn Term>> {
    let (mut master, mut slave) = (-1, -1);
    let mut ws = winsize(launch.cols, launch.rows);
    // SAFETY: out-pointers to locals; the name buffer and termios are not used (null).
    if unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), &raw mut ws) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openpty returned two fresh fds that we own from here.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    cloexec(master.as_raw_fd());
    cloexec(slave.as_raw_fd());

    let mut cmd = Command::new(&launch.file);
    cmd.args(&launch.args).env_clear().envs(launch.env.iter().map(|(k, v)| (k, v)));
    // node-pty's UnixTerminal: `cwd = opt.cwd || process.cwd(); env.PWD = cwd` (after the caller's env), so a shell
    // started in a symlinked folder keeps the logical path in `pwd` and the prompt.
    let cwd = match &launch.cwd {
        Some(cwd) => cwd.clone(),
        None => std::env::current_dir()?,
    };
    cmd.current_dir(&cwd).env("PWD", &cwd);
    cmd.stdin(Stdio::from(slave.try_clone()?)).stdout(Stdio::from(slave.try_clone()?)).stderr(Stdio::from(slave.try_clone()?));
    // SAFETY: only async-signal-safe calls between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            // node-pty resets the signal dispositions the parent may have changed.
            for sig in [libc::SIGINT, libc::SIGQUIT, libc::SIGTERM, libc::SIGHUP, libc::SIGPIPE, libc::SIGCHLD] {
                libc::signal(sig, libc::SIG_DFL);
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn()?;
    // Ours must go, or the master never sees the end of the output.
    drop(slave);
    let pid = child.id();

    // Wakes the reader out of select() once the drain after the exit is over.
    let (wake_r, wake_w) = {
        let mut fds = [-1; 2];
        // SAFETY: an out-array of two fds.
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: pipe returned two fresh fds that we own from here.
        unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
    };
    cloexec(wake_r.as_raw_fd());
    cloexec(wake_w.as_raw_fd());

    let state: Arc<(Mutex<ExitState>, Condvar)> = Arc::default();
    let waiter = state.clone();
    std::thread::Builder::new().name("pty-wait".into()).spawn(move || {
        let code = match child.wait() {
            Ok(status) => status.code().map(|c| c as u32).unwrap_or_else(|| status.signal().map_or(1, |_| 0)),
            Err(_) => 1,
        };
        let mut st = waiter.0.lock();
        st.code = Some(code);
        waiter.1.notify_all();
        // node-pty (unixTerminal.js, DESTROY_SOCKET_TIMEOUT_MS): the output gets 200 ms after the shell ended, then the
        // master is let go and the exit is reported, even while a background child still holds the slave side open.
        let deadline = Instant::now() + EXIT_DRAIN;
        while !st.reader_done {
            if waiter.1.wait_until(&mut st, deadline).timed_out() {
                break;
            }
        }
        if !st.reader_done {
            drop(st);
            // SAFETY: one byte from a local into our own pipe.
            unsafe {
                libc::write(wake_w.as_raw_fd(), [1u8].as_ptr().cast(), 1);
            }
        }
    })?;

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let mut writer = File::from(master.try_clone()?);
    std::thread::Builder::new().name("pty-write".into()).spawn(move || {
        while let Ok(data) = rx.recv() {
            if writer.write_all(&data).is_err() {
                break;
            }
        }
    })?;

    let mut reader = File::from(master.try_clone()?);
    std::thread::Builder::new().name("pty-read".into()).spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        let (fd, wake) = (reader.as_raw_fd(), wake_r.as_raw_fd());
        loop {
            // select, not poll: macOS's poll does not work on tty devices (libuv uses select for them too).
            // SAFETY: an fd_set on the stack with two open fds below FD_SETSIZE.
            let ready = unsafe {
                let mut set: libc::fd_set = std::mem::zeroed();
                libc::FD_ZERO(&mut set);
                libc::FD_SET(fd, &mut set);
                libc::FD_SET(wake, &mut set);
                let n =
                    libc::select(fd.max(wake) + 1, &mut set, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut());
                if n < 0 { Err(io::Error::last_os_error()) } else { Ok((libc::FD_ISSET(fd, &set), libc::FD_ISSET(wake, &set))) }
            };
            match ready {
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                Err(_) => break,
                // The drain after the exit is over: a background child still holds the slave side.
                Ok((_, true)) => break,
                Ok((false, false)) => continue,
                Ok((true, false)) => {}
            }
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => on_data(&buf[..n]),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                // EIO: every slave side is closed.
                Err(_) => break,
            }
        }
        // Our master fd goes now (node-pty destroys its socket): with the UnixTerm's copy gone too, a background child
        // left on the slave side gets the hangup.
        drop(reader);
        let mut st = state.0.lock();
        st.reader_done = true;
        state.1.notify_all();
        while st.code.is_none() {
            state.1.wait(&mut st);
        }
        let code = st.code.unwrap_or(1);
        drop(st);
        on_exit(code);
    })?;

    Ok(Arc::new(UnixTerm { pid, master, input: Mutex::new(Some(tx)) }))
}
