//! WebView glue of the lifecycle: the renderer-process events of WebView2 (ProcessFailed), the pid of a page's renderer (to end
//! a hung one like Electron's `forcefullyCrashRenderer`), the window handle for the session-end subclass, and the heartbeat
//! script round trip.

use std::sync::Arc;

use tauri::WebviewWindow;

use crate::context::AppContext;

/// What WebView2 reported about a renderer process.
#[cfg_attr(not(windows), allow(dead_code, reason = "WebView2 ProcessFailed only; macOS reports through main.rs"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessEvent {
    /// The page's renderer ended (Electron's `render-process-gone`): WebView2 reason and exit code.
    RendererExited { reason: i32, exit_code: i32 },
    /// The renderer does not respond to input (Electron's `unresponsive`).
    RendererUnresponsive,
    /// The whole WebView2 browser process ended: the webview cannot come back by a reload.
    BrowserExited { exit_code: i32 },
}

/// Calls `on_event` for the process failures of this window's webview (on the UI thread; must not block).
#[cfg(windows)]
pub fn watch_process_failed(window: &WebviewWindow, on_event: Arc<dyn Fn(ProcessEvent) + Send + Sync>) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_FAILED_KIND, COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
        COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED, COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE,
        COREWEBVIEW2_PROCESS_FAILED_REASON, ICoreWebView2ProcessFailedEventArgs2,
    };
    use webview2_com::ProcessFailedEventHandler;
    use windows::core::Interface;
    let _ = window.with_webview(move |webview| {
        // SAFETY: COM calls on the live controller, on the thread Tauri runs this closure on (the UI thread).
        unsafe {
            let Ok(core) = webview.controller().CoreWebView2() else { return };
            let on_event = on_event.clone();
            let handler = ProcessFailedEventHandler::create(Box::new(move |_sender, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PROCESS_FAILED_KIND::default();
                args.ProcessFailedKind(&mut kind)?;
                let mut reason = COREWEBVIEW2_PROCESS_FAILED_REASON::default();
                let mut exit_code = 0i32;
                if let Ok(args2) = args.cast::<ICoreWebView2ProcessFailedEventArgs2>() {
                    let _ = args2.Reason(&mut reason);
                    let _ = args2.ExitCode(&mut exit_code);
                }
                let event = if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED {
                    ProcessEvent::RendererExited { reason: reason.0, exit_code }
                } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_UNRESPONSIVE {
                    ProcessEvent::RendererUnresponsive
                } else if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED {
                    ProcessEvent::BrowserExited { exit_code }
                } else {
                    // A GPU, utility or frame process: WebView2 recovers by itself (Electron's child-process-gone).
                    return Ok(());
                };
                let on_event = on_event.clone();
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || on_event(event)));
                Ok(())
            }));
            let mut token = 0i64;
            let _ = core.add_ProcessFailed(&handler, &mut token);
        }
    });
}

#[cfg(not(windows))]
pub fn watch_process_failed(_window: &WebviewWindow, _on_event: Arc<dyn Fn(ProcessEvent) + Send + Sync>) {
    // macOS: tauri::Builder::on_web_content_process_terminate (main.rs) reports the renderer's end.
}

/// The pid of the renderer process that runs this window's page (Windows; None when WebView2 cannot tell). Waits up to 3 s.
#[cfg(windows)]
pub fn renderer_pid(window: &WebviewWindow) -> Option<u32> {
    use webview2_com::GetProcessExtendedInfosCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PROCESS_KIND, COREWEBVIEW2_PROCESS_KIND_RENDERER, ICoreWebView2_20, ICoreWebView2Environment13,
        ICoreWebView2FrameInfo2,
    };
    use windows::core::{BOOL, Interface};
    let (tx, rx) = std::sync::mpsc::channel::<Option<u32>>();
    let ok = window.with_webview(move |webview| {
        // SAFETY: COM calls on the UI thread (with_webview); the completion handler also runs there.
        unsafe {
            let main_frame = webview.controller().CoreWebView2().ok().and_then(|core| {
                let core20 = core.cast::<ICoreWebView2_20>().ok()?;
                let mut id = 0u32;
                core20.FrameId(&mut id).ok()?;
                Some(id)
            });
            let Ok(env) = webview.environment().cast::<ICoreWebView2Environment13>() else {
                let _ = tx.send(None);
                return;
            };
            let tx2 = tx.clone();
            let handler = GetProcessExtendedInfosCompletedHandler::create(Box::new(move |result, list| {
                let mut renderers: Vec<(u32, bool)> = Vec::new();
                if let (Ok(()), Some(list)) = (result, list) {
                    let mut count = 0u32;
                    let _ = list.Count(&mut count);
                    for i in 0..count {
                        let Ok(info) = list.GetValueAtIndex(i) else { continue };
                        let Ok(process) = info.ProcessInfo() else { continue };
                        let mut kind = COREWEBVIEW2_PROCESS_KIND::default();
                        let mut pid = 0i32;
                        if process.Kind(&mut kind).is_err() || kind != COREWEBVIEW2_PROCESS_KIND_RENDERER {
                            continue;
                        }
                        let _ = process.ProcessId(&mut pid);
                        let mut ours = false;
                        if let (Some(main_frame), Ok(frames)) = (main_frame, info.AssociatedFrameInfos())
                            && let Ok(iter) = frames.GetIterator()
                        {
                            let mut has = BOOL(0);
                            while iter.HasCurrent(&mut has).is_ok() && has.as_bool() {
                                if let Ok(frame) = iter.GetCurrent().and_then(|f| f.cast::<ICoreWebView2FrameInfo2>()) {
                                    let mut id = 0u32;
                                    if frame.FrameId(&mut id).is_ok() && id == main_frame {
                                        ours = true;
                                    }
                                }
                                let mut more = BOOL(0);
                                if iter.MoveNext(&mut more).is_err() || !more.as_bool() {
                                    break;
                                }
                            }
                        }
                        renderers.push((pid as u32, ours));
                    }
                }
                // The renderer that shows our main frame; a single renderer is ours too (one app window).
                let pid =
                    renderers.iter().find(|(_, ours)| *ours).or(if renderers.len() == 1 { renderers.first() } else { None });
                let _ = tx2.send(pid.map(|(pid, _)| *pid));
                Ok(())
            }));
            if env.GetProcessExtendedInfos(&handler).is_err() {
                let _ = tx.send(None);
            }
        }
    });
    if ok.is_err() {
        return None;
    }
    rx.recv_timeout(std::time::Duration::from_secs(3)).ok().flatten()
}

#[cfg(not(windows))]
pub fn renderer_pid(_window: &WebviewWindow) -> Option<u32> {
    None
}

/// Ends a process of our own WebView2 (the hung renderer, at the user's request).
#[cfg(windows)]
pub fn end_process(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{OpenProcess, PROCESS_TERMINATE, TerminateProcess};
    // SAFETY: a handle opened for termination only, closed again.
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_TERMINATE, false, pid) else { return false };
        let ok = TerminateProcess(handle, 1).is_ok();
        let _ = CloseHandle(handle);
        ok
    }
}

#[cfg(not(windows))]
pub fn end_process(_pid: u32) -> bool {
    false
}

/// The window handle of a window (for the session-end subclass and as the owner of dialogs).
pub fn window_handle(window: &WebviewWindow) -> Option<isize> {
    #[cfg(windows)]
    {
        window.hwnd().ok().map(|h| h.0 as isize)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        None
    }
}

/// One heartbeat: runs a no-op script and calls `answered` when the page ran it (never, while the page hangs).
pub fn ping(window: &WebviewWindow, answered: impl Fn() + Send + 'static) -> bool {
    window.eval_with_callback("0", move |_| answered()).is_ok()
}

/// Shows the dialog's owner window first, the way 1.1.4's modal message box did.
pub fn owner_of(ctx: &Arc<AppContext>, label: &str) -> Option<isize> {
    use tauri::Manager;
    ctx.app().and_then(|app| app.get_webview_window(label)).as_ref().and_then(window_handle)
}
