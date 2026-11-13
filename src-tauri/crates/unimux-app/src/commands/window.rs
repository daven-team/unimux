//! Commands of the `window` domain: W5 detached windows (detach:*), W1 caption buttons (window:*), W6 quit (window state
//! events live in windows.rs).
//!
//! The detach channels are the ones of src/main/detachedWindows.ts registerIpc, with the same "who may ask" rules: the main
//! window opens and asks back, a detached window takes, attaches, dismisses and reports. The work is done by
//! [`crate::detached::DetachedService`].

use std::sync::Arc;

use serde_json::Value;
use tauri::{Manager, WebviewWindow};
use unimux_ipc::RouterBuilder;

use crate::caption::{self, Button};
use crate::context::AppContext;

/// The page zoom asked for by `window:setZoom`: a finite factor, kept within 50-300 percent.
fn page_zoom(value: &Value) -> Option<f64> {
    value.as_f64().filter(|f| f.is_finite() && *f > 0.0).map(|f| f.clamp(0.5, 3.0))
}

/// The caller's own window (a page only ever drives the window it is in).
fn window_of(ctx: &AppContext, label: &str) -> Option<WebviewWindow> {
    ctx.app().and_then(|a| a.get_webview_window(label))
}

pub fn register(r: &mut RouterBuilder, ctx: &Arc<AppContext>) {
    // From the main window only: its tab goes to a new window (on another display, or beside the main window).
    let c = ctx.clone();
    r.invoke("detach:open", move |call| {
        let c = c.clone();
        async move { Ok(c.detached.cmd_open(&call.caller.label, call.arg(0), call.args.get(1))) }
    });

    // A tab dragged out of the main window and dropped outside it: a new window under the cursor (inside: nothing happens).
    let c = ctx.clone();
    r.invoke("detach:dropOutside", move |call| {
        let c = c.clone();
        async move { Ok(c.detached.cmd_drop_outside(&call.caller.label, call.arg(0), call.args.get(1))) }
    });

    // The detached window takes the documents handed over for it (once).
    let c = ctx.clone();
    r.invoke("detach:take", move |call| {
        let c = c.clone();
        async move { Ok(c.detached.cmd_take(&call.caller.label)) }
    });

    // The detached window gives its tab back ("Przypnij z powrotem", its close button, its tab dragged onto the main window).
    let c = ctx.clone();
    r.invoke("detach:attach", move |call| {
        let c = c.clone();
        async move { Ok(Value::Bool(c.detached.cmd_attach(&call.caller.label, call.args.first(), call.arg(1)))) }
    });

    // The detached window's tab was closed there (its file tab's close button): the window goes, nothing comes back.
    let c = ctx.clone();
    r.invoke("detach:dismiss", move |call| {
        let c = c.clone();
        async move { Ok(Value::Bool(c.detached.cmd_dismiss(&call.caller.label))) }
    });

    // The main window asks for a tab back (its dimmed chip's menu, a detached tab dropped onto its strip).
    let c = ctx.clone();
    r.send("detach:requestAttach", move |call| {
        let c = c.clone();
        async move { c.detached.cmd_request_attach(&call.caller.label, call.arg(0)) }
    });

    // A closing detached window needs longer to give its tab back (it asks about a running query first): no timeout.
    let c = ctx.clone();
    r.send("detach:stay", move |call| {
        let c = c.clone();
        async move { c.detached.cmd_stay(&call.caller.label) }
    });

    // A detached window's unsaved database and editor work, for the main window's quit question.
    let c = ctx.clone();
    r.send("detach:work", move |call| {
        let c = c.clone();
        async move { c.detached.cmd_work(&call.caller.label, call.arg(0)) }
    });

    // The main window (after a reload) asks what the detached windows hold.
    let c = ctx.clone();
    r.invoke("detach:works", move |call| {
        let c = c.clone();
        async move { Ok(c.detached.cmd_works(&call.caller.label)) }
    });

    // A detached database or Redis tab opens another tab ("Open in the SQL editor", another Redis view): in the main window.
    let c = ctx.clone();
    r.send("detach:openInMain", move |call| {
        let c = c.clone();
        async move { c.detached.cmd_open_in_main(&call.caller.label, call.arg(0)) }
    });

    // A window reports what one of its cells waits for (null: nothing any more).
    let c = ctx.clone();
    r.send("detach:wait", move |call| {
        let c = c.clone();
        async move { c.detached.cmd_wait(&call.caller.label, call.arg(0), call.arg(1)) }
    });

    // The main window gets every wait (after a reload), a detached window those of its own cells (when it opens).
    let c = ctx.clone();
    r.invoke("detach:waits", move |call| {
        let c = c.clone();
        async move { Ok(c.detached.cmd_waits(&call.caller.label)) }
    });

    // "Next / previous waiting cell" pressed in a detached window: the main window (which has the whole list) picks the cell.
    let c = ctx.clone();
    r.send("detach:waitStep", move |call| {
        let c = c.clone();
        async move { c.detached.cmd_wait_step(&call.caller.label, call.arg(0)) }
    });

    // From the main window: show a cell wherever it is (its window comes to the front and focuses the cell).
    let c = ctx.clone();
    r.send("detach:revealCell", move |call| {
        let c = c.clone();
        async move { c.detached.cmd_reveal_cell(&call.caller.label, call.arg(0)) }
    });

    let c = ctx.clone();
    r.send("detach:focus", move |call| {
        let c = c.clone();
        async move { c.detached.cmd_focus(call.arg(0)) }
    });

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

    // The View menu of the title bar: full screen on and off, and the zoom of the whole page (the renderer keeps the level).
    let c = ctx.clone();
    r.send("window:toggleFullscreen", move |call| {
        let c = c.clone();
        async move {
            if let Some(w) = window_of(&c, &call.caller.label) {
                let on = w.is_fullscreen().unwrap_or(false);
                let _ = w.set_fullscreen(!on);
            }
        }
    });

    let c = ctx.clone();
    r.send("window:setZoom", move |call| {
        let c = c.clone();
        async move {
            let Some(factor) = page_zoom(call.arg(0)) else { return };
            if let Some(w) = window_of(&c, &call.caller.label) {
                let _ = w.set_zoom(factor);
            }
        }
    });

    // The page's button rects (a cross-check of the native layout in caption.rs) and the buttons' accessible names.
    let c = ctx.clone();
    r.send("window:captionArea", move |call| {
        let c = c.clone();
        async move {
            if let Some(w) = window_of(&c, &call.caller.label) {
                caption::set_area_from_page(&w, &c, call.arg(0), call.args.get(1));
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::page_zoom;
    use serde_json::json;

    #[test]
    fn page_zoom_is_a_bounded_factor() {
        assert_eq!(page_zoom(&json!(1.25)), Some(1.25));
        assert_eq!(page_zoom(&json!(10)), Some(3.0));
        assert_eq!(page_zoom(&json!(0.1)), Some(0.5));
        assert_eq!(page_zoom(&json!(0)), None);
        assert_eq!(page_zoom(&json!("2")), None);
        assert_eq!(page_zoom(&json!(null)), None);
    }
}
