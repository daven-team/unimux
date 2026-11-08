//! OS pieces of the app lifecycle (PLAN W6): the end of the OS session, the macOS quit request, and the native message box
//! with the app's own (translated) buttons used by the renderer crash and hang questions.
//!
//! - Windows: a window subclass on the main window answers WM_QUERYENDSESSION (the flush starts at once) and WM_ENDSESSION
//!   (waits a bounded time for it). Electron's `query-session-end` / `session-end`.
//! - macOS: `NSWorkspaceWillPowerOffNotification` (Electron's powerMonitor `shutdown`) and `applicationShouldTerminate:`
//!   (Cmd+Q, Dock Quit, log-out), answered NSTerminateLater: the app winds down first and then replies YES (or NO when the
//!   user kept the app at the quit question). Never NSTerminateCancel, which would abort a log-out or shut-down.

use std::sync::Arc;

/// Called from the window procedure of the main window: they must not block, except `end`, which may wait (bounded).
pub struct SessionEndHooks {
    /// The OS asks whether the session may end (WM_QUERYENDSESSION). Start saving; the answer is always "yes".
    pub query: Box<dyn Fn() + Send + Sync>,
    /// The session ends (`true`) or the end was cancelled (`false`) (WM_ENDSESSION). On `true` the process may be ended as
    /// soon as this returns.
    pub end: Box<dyn Fn(bool) + Send + Sync>,
}

/// Subclasses `hwnd` (a top-level window of this process) for the session-end messages. Must run on the window's thread.
#[cfg(windows)]
pub fn watch_session_end(hwnd: isize, hooks: Arc<SessionEndHooks>) -> std::io::Result<()> {
    crate::win_lifecycle::watch_session_end(hwnd, hooks)
}

/// What an outside close of the event loop's helper window does (see [`guard_event_loop_window`]). Called on the window's
/// thread from inside its window procedure, so it must not block or touch the event loop directly.
#[cfg(windows)]
pub struct OutsideClose(pub Box<dyn Fn() + Send + Sync>);

/// Keeps tao's event loop window ("Tao Thread Event Target") alive when something outside asks the process' windows to close
/// (WM_CLOSE from Process.CloseMainWindow or taskkill without /F): default handling would destroy it and every later webview
/// call fails. The close runs `hook` instead, and the window gets a hidden owner, so it no longer counts as a main window of
/// the process (it has to stay WS_VISIBLE: tao's event delivery during a resize needs its WM_PAINT). Must run on the event
/// loop's thread; returns how many helper windows were guarded (0: tao has changed its window class).
#[cfg(windows)]
pub fn guard_event_loop_window(hook: Arc<OutsideClose>) -> std::io::Result<usize> {
    crate::win_lifecycle::guard_event_loop_window(hook)
}

/// Electron's powerMonitor `shutdown`: the Mac shuts down or the user logs out.
#[cfg(target_os = "macos")]
pub fn watch_power_off(on_power_off: Arc<dyn Fn() + Send + Sync>) {
    crate::mac_lifecycle::watch_power_off(on_power_off)
}

/// Answers `applicationShouldTerminate:` (Cmd+Q, Dock Quit, the menu, log-out). `decide` returns true when the app may end
/// now (its own exit); otherwise the request is answered NSTerminateLater, `decide` is expected to start the quit itself and
/// the app must later call [`reply_to_terminate`]. Call on the main thread once the application delegate exists.
#[cfg(target_os = "macos")]
pub fn intercept_terminate(decide: Arc<dyn Fn() -> bool + Send + Sync>) -> bool {
    crate::mac_lifecycle::intercept_terminate(decide)
}

/// Whether a terminate request answered NSTerminateLater still waits for [`reply_to_terminate`].
#[cfg(target_os = "macos")]
pub fn terminate_reply_owed() -> bool {
    crate::mac_lifecycle::terminate_reply_owed()
}

/// `replyToApplicationShouldTerminate:` for a request answered NSTerminateLater (`true`: terminate now, `false`: the app
/// stays). Returns false when no reply was owed. Main thread only.
#[cfg(target_os = "macos")]
pub fn reply_to_terminate(allow: bool) -> bool {
    crate::mac_lifecycle::reply_to_terminate(allow)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DialogKind {
    Error,
    Warning,
}

/// A question with the app's own buttons (Electron `dialog.showMessageBox` with `noLink`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MessageDialog {
    pub kind: DialogKind,
    pub title: String,
    pub message: String,
    pub detail: String,
    pub buttons: Vec<String>,
    pub default_id: usize,
    pub cancel_id: usize,
}

/// Shows the dialog (modal to `owner`, a window handle, when given) and returns the index of the chosen button (`cancel_id`
/// for Esc / the close box). Blocks the calling thread: call it off the event loop.
pub fn message_dialog(owner: Option<isize>, dialog: &MessageDialog) -> usize {
    #[cfg(windows)]
    {
        crate::win_lifecycle::message_dialog(owner, dialog)
    }
    #[cfg(target_os = "macos")]
    {
        let _ = owner;
        crate::mac_lifecycle::message_dialog(dialog)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = owner;
        eprintln!("{}: {}", dialog.title, dialog.message);
        dialog.cancel_id
    }
}
