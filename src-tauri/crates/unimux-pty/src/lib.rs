//! ConPTY / Unix pty, output engine, Channel data plane, shell integration, launch line, cell spawn (P1-P5)
//!
//! P1 (the pty core): [`conpty`] (Windows: own wrapper over the bundled conpty.dll 1.23 from spike SP5, Job Object per
//! terminal, close while draining, writer thread, timeBeginPeriod guard), [`unix`] (openpty, setsid, TIOCSCTTY, SIGHUP
//! then SIGKILL of the session), [`shell`] (resolveShell, the terminal environment), [`manager`] (PtyManager: spawn, the
//! launch command 150 ms after the first output, kill with a bounded wait, kill_all with a tree kill), [`supervisor`] and
//! [`actor`] (the supervised actor that stands in for the Pty Host process: crash counting and restarts).
//! From SP5: [`frame`] (binary frames for the data plane), [`cmdline`] (node-pty's command line quoting) and [`plane`]
//! (the measured data plane P2 grows into the output engine). Commands are registered in `unimux-app/src/commands/pty.rs`.

pub mod actor;
pub mod cmdline;
#[cfg(windows)]
pub mod conpty;
pub mod frame;
pub mod manager;
#[cfg(windows)]
pub mod plane;
pub mod shell;
pub mod supervisor;
#[cfg(unix)]
pub mod unix;
