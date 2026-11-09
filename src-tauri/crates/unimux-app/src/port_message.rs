//! Typed keystrokes to the pty port over WebView2's WebMessage (R2, Windows).
//!
//! A Tauri invoke goes through WebView2's custom-scheme request path: about 1.2 ms per round trip on Windows 11
//! (measured in the check build, 2026-11-08), against 0.2 ms for a WebMessage round trip. The keystroke's way to the pty
//! is half of every echo, so an SSH echo took 2.9 ms (drawn, median) against 1.6 ms in 1.1.4, whose renderer wrote into
//! a MessagePort. The page therefore sends a batch of port messages that holds a typed `write` as the string
//! `{"mcPortPost":"<kind>","session":...,"seq":...,"messages":[...]}` with `chrome.webview.postMessage`, every other batch
//! with `mc_port_post` as before; both carry the same per-page numbers, so the port lane still delivers them in order
//! (`SendQueue`). The message is a string because wry's own handler (registered first) stops the event for anything
//! else (see file_drop.rs); Tauri's IPC parser then refuses it as not an invoke message and logs one `console.error`
//! into the page. Only pages of the app origin are heard (the same guard as `mc_port_post`).

#![cfg_attr(not(windows), allow(dead_code))]

use std::sync::Arc;

use serde_json::Value;

use crate::context::AppContext;

/// The prefix of a port post (a string message; JSON.stringify keeps the key order of the page's object).
const PREFIX: &str = "{\"mcPortPost\":";

/// One port post of the page: (kind, session, seq, messages).
#[derive(Debug, PartialEq)]
pub struct WebPortPost {
    pub kind: String,
    pub session: String,
    pub seq: u64,
    pub messages: Vec<Value>,
}

/// The port post in a WebMessage string, None for anything else (file-drop requests, Tauri's own messages).
pub fn parse(text: &str) -> Option<WebPortPost> {
    if !text.starts_with(PREFIX) {
        return None;
    }
    let v: Value = serde_json::from_str(text).ok()?;
    let o = v.as_object()?;
    let kind = o.get("mcPortPost")?.as_str()?;
    // Only the pty port's typing comes this way (the page asks for it on the pty port only).
    if kind != "pty" {
        return None;
    }
    Some(WebPortPost {
        kind: kind.to_string(),
        session: o.get("session")?.as_str()?.to_string(),
        seq: o.get("seq")?.as_u64()?,
        messages: o.get("messages")?.as_array()?.clone(),
    })
}

/// Windows where the handler is in place: their pty port is told to post typing this way (`mc_port_attach`).
static INSTALLED: parking_lot::Mutex<Vec<String>> = parking_lot::Mutex::new(Vec::new());

pub fn available(label: &str) -> bool {
    INSTALLED.lock().iter().any(|l| l == label)
}

/// Installs the handler on an app window (main and detached windows).
pub fn install(window: &tauri::WebviewWindow, ctx: Arc<AppContext>) {
    #[cfg(windows)]
    windows_post::install(window, ctx);
    #[cfg(not(windows))]
    let _ = (window, ctx);
}

#[cfg(windows)]
mod windows_post {
    use std::sync::Arc;

    use tauri::WebviewWindow;
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2WebMessageReceivedEventArgs;
    use webview2_com::{WebMessageReceivedEventHandler, take_pwstr};
    use windows::core::PWSTR;

    use crate::context::AppContext;

    pub fn install(window: &WebviewWindow, ctx: Arc<AppContext>) {
        let label = window.label().to_string();
        let installed = label.clone();
        let result = window.with_webview(move |webview| {
            // SAFETY: COM calls on the live controller, on the UI thread Tauri runs this closure on; the handler runs on the
            // same thread.
            unsafe {
                let Ok(core) = webview.controller().CoreWebView2() else { return };
                let (for_handler, ctx_handler) = (label.clone(), ctx.clone());
                let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                    if let Some(args) = args {
                        receive(&ctx_handler, &for_handler, &args);
                    }
                    Ok(())
                }));
                let mut token = 0i64;
                match core.add_WebMessageReceived(&handler, &mut token) {
                    Ok(()) => {
                        let mut list = super::INSTALLED.lock();
                        if !list.contains(&installed) {
                            list.push(installed.clone());
                        }
                    }
                    Err(e) => ctx.crash.warn(&format!("port posts for {label}: {e}")),
                }
            }
        });
        if let Err(e) = result {
            eprintln!("port posts: {e}");
        }
    }

    /// A port post of a page of this window: into the port lane like `mc_port_post` (guarded the same way).
    unsafe fn receive(ctx: &Arc<AppContext>, label: &str, args: &ICoreWebView2WebMessageReceivedEventArgs) {
        // SAFETY: the event's own arguments, read during the event.
        unsafe {
            let mut text = PWSTR::null();
            if args.TryGetWebMessageAsString(&mut text).is_err() {
                return;
            }
            let Some(post) = super::parse(&take_pwstr(text)) else { return };
            let mut source = PWSTR::null();
            if args.Source(&mut source).is_err() {
                return;
            }
            let source = take_pwstr(source);
            let origin = unimux_ipc::guard::origin_of(&source).to_string();
            let caller = unimux_ipc::Caller::new(label, source).with_request_origin(Some(origin));
            // The UI thread is not a runtime thread: the lane's worker is spawned on Tauri's runtime.
            let _rt = tauri::async_runtime::handle().inner().enter();
            let _ = crate::ipc::submit_port_post(ctx, caller, post.session, post.seq, post.kind, post.messages);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_pty_port_posts_only() {
        let text =
            json!({ "mcPortPost": "pty", "session": "s1", "seq": 7, "messages": [{ "t": "write", "id": "c", "data": "a" }] })
                .to_string();
        assert_eq!(
            parse(&text),
            Some(WebPortPost {
                kind: "pty".into(),
                session: "s1".into(),
                seq: 7,
                messages: vec![json!({ "t": "write", "id": "c", "data": "a" })]
            })
        );
        assert_eq!(parse(&json!({ "mcPortPost": "db", "session": "s", "seq": 1, "messages": [] }).to_string()), None);
        assert_eq!(parse(&json!({ "mcPaths": "x" }).to_string()), None);
        assert_eq!(parse(r#"{"cmd":"mc_port_post","callback":1}"#), None);
        assert_eq!(parse(r#"{"mcPortPost":"pty","session":"s","seq":-1,"messages":[]}"#), None);
        assert_eq!(parse(r#"{"mcPortPost":"pty","session":"s","seq":1,"messages":{}}"#), None);
        assert_eq!(parse(r#"{"mcPortPost":"pty""#), None);
    }
}
