//! SP5 keystroke-to-echo latency at the pty layer (see windows.rs). Windows only: the macOS build of the crate compiles it
//! to a stub.

#[cfg(windows)]
mod windows;

#[cfg(windows)]
fn main() {
    windows::main();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("sp5_echo measures ConPTY and runs on Windows only");
}
