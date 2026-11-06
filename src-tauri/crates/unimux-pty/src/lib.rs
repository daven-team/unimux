//! ConPTY / Unix pty, output engine, Channel data plane, shell integration, launch line, cell spawn (P1-P5)
//!
//! Spike SP5 (docs/tauri/spikes/SP5.md) put the Windows pty layer here: [`conpty`] (own wrapper over the sideloaded
//! conpty.dll 1.23, Job Object per terminal, close while draining, timeBeginPeriod guard), [`frame`] (binary frames for the
//! Channel data plane), [`cmdline`] (node-pty's command line quoting) and [`plane`] (the measured data plane). P1 / P2 build
//! the production engine on top; commands are registered in `unimux-app/src/commands/pty.rs`.

pub mod cmdline;
#[cfg(windows)]
pub mod conpty;
pub mod frame;
#[cfg(windows)]
pub mod plane;
