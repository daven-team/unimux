//! Unix backend (stand-in until P1's): node-pty's unix spawn reduced to what the suites need. openpty with the start size,
//! the child in its own session with the pty as controlling terminal (setsid + TIOCSCTTY) and as stdin / stdout / stderr,
//! a reader thread (EIO / EOF = the last slave side closed), a writer thread, a waiter. The exit is reported once the
//! process ended and the output ended (node-pty: output after exit is delivered). kill = SIGHUP to the shell's process group
//! (node-pty sends SIGHUP to the shell), kill_tree = SIGKILL to the group.

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, Stdio};
use std::sync::{Arc, mpsc};

use parking_lot::{Condvar, Mutex};

use super::{DataFn, ExitFn, Launch, Term};

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
    if unsafe { libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), &mut ws) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openpty returned two fresh fds that we own from here.
    let (master, slave) = unsafe { (OwnedFd::from_raw_fd(master), OwnedFd::from_raw_fd(slave)) };
    cloexec(master.as_raw_fd());
    cloexec(slave.as_raw_fd());

    let mut cmd = Command::new(&launch.file);
    cmd.args(&launch.args).env_clear().envs(launch.env.iter().map(|(k, v)| (k, v)));
    if let Some(cwd) = &launch.cwd {
        cmd.current_dir(cwd);
    }
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

    let exit: Arc<(Mutex<Option<u32>>, Condvar)> = Arc::default();
    let waiter = exit.clone();
    std::thread::Builder::new().name("pty-wait".into()).spawn(move || {
        let code = match child.wait() {
            Ok(status) => status.code().map(|c| c as u32).unwrap_or_else(|| status.signal().map_or(1, |_| 0)),
            Err(_) => 1,
        };
        *waiter.0.lock() = Some(code);
        waiter.1.notify_all();
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
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => on_data(&buf[..n]),
                Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
                // EIO: every slave side is closed.
                Err(_) => break,
            }
        }
        let mut code = exit.0.lock();
        while code.is_none() {
            exit.1.wait(&mut code);
        }
        let code = code.unwrap_or(1);
        on_exit(code);
    })?;

    Ok(Arc::new(UnixTerm { pid, master, input: Mutex::new(Some(tx)) }))
}
