//! Commands of the `window` domain: W5 detached windows (detach:*), W1 caption buttons (window:*), W6 quit (window state events live in windows.rs).
//!
//! Registered by `register` only; nothing else in the app is edited when a package lands. Until then the router answers
//! the domain's channels with `MC_NOT_YET` (see `npm run ipc:report`).

use std::sync::Arc;

use serde_json::Value;
use tauri::{Manager, WebviewWindow};
use unimux_ipc::RouterBuilder;

use crate::caption::{self, Button};
use crate::context::AppContext;

/// The caller's own window (a page only ever drives the window it is in).
fn window_of(ctx: &AppContext, label: &str) -> Option<WebviewWindow> {
    ctx.app().and_then(|a| a.get_webview_window(label))
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    // W1: the caption buttons the page draws (src/renderer/src/components/CaptionButtons.tsx).
    for (channel, button) in
        [("window:minimize", Button::Min), ("window:toggleMaximize", Button::Max), ("window:close", Button::Close)]
    {
        let c = ctx.clone();
        r.send(channel, move |call| {
            let c = c.clone();
            async move {
                if let Some(w) = window_of(&c, &call.caller.label) {
                    caption::run_button(&w, button);
                }
            }
        });
    }

    let c = ctx.clone();
    r.invoke("window:isMaximized", move |call| {
        let c = c.clone();
        async move {
            let maximized = window_of(&c, &call.caller.label).and_then(|w| w.is_maximized().ok()).unwrap_or(false);
            Ok(Value::Bool(maximized))
        }
    });

    let c = ctx.clone();
    r.send("window:captionArea", move |call| {
        let c = c.clone();
        async move {
            if let Some(w) = window_of(&c, &call.caller.label) {
                caption::set_area_from_page(&w, call.arg(0));
            }
        }
    });
}
