//! ConPTY / Unix pty, output engine, Channel data plane, shell integration, launch line, cell spawn (P1-P5)
//!
//! P1 (the pty core): [`conpty`] (Windows: own wrapper over the bundled conpty.dll 1.23 from spike SP5, Job Object per
//! terminal, close while draining, writer thread, timeBeginPeriod guard), [`unix`] (openpty, setsid, TIOCSCTTY, SIGHUP
//! then SIGKILL of the session), [`shell`] (resolveShell, the terminal environment), [`manager`] (PtyManager: spawn, the
//! launch command 150 ms after the first output, kill with a bounded wait, kill_all with a tree kill), [`supervisor`] and
//! [`actor`] (the supervised actor that stands in for the Pty Host process: crash counting and restarts).
//!
//! P2 (the output engine and data plane): [`flow`] (TailBuffer in bytes with sizes, FlowGate, EchoClock, the coalescing
//! delays), [`output`] (OutputChannel), [`timers`] (the engine's timer thread and the tests' fake clock), [`batch`] (the
//! per-window batcher with the in-flight cap of gated transports), [`routes`] (WindowRoutes, early sizes) and [`engine`]
//! (PtyEngine: the Pty Host between PtyManager and the windows, host-side DA1, timeBeginPeriod while terminals exist).
//! [`frame`] is the binary frame format; [`plane`] stays as the SP5 measurement plane of the check build's spike commands.
//! Commands are registered in `unimux-app/src/commands/pty.rs`.

pub mod actor;
pub mod batch;
pub mod cmdline;
#[cfg(windows)]
pub mod conpty;
pub mod engine;
pub mod flow;
pub mod frame;
pub mod manager;
pub mod output;
#[cfg(windows)]
pub mod plane;
pub mod routes;
pub mod shell;
pub mod supervisor;
pub mod timers;
#[cfg(unix)]
pub mod unix;
