//! macOS half of [`crate::lifecycle`] (compile-checked on Windows with `--target aarch64-apple-darwin`; the run is R3).

use std::ptr::NonNull;
use std::sync::{Arc, OnceLock};

use block2::RcBlock;
use objc2::runtime::{AnyClass, AnyObject, Imp, Sel};
use objc2::{ffi, sel};
use objc2_app_kit::{NSApplication, NSWorkspace, NSWorkspaceWillPowerOffNotification};
use objc2_foundation::{MainThreadMarker, NSNotification};

use crate::lifecycle::{DialogKind, MessageDialog};

pub fn watch_power_off(on_power_off: Arc<dyn Fn() + Send + Sync>) {
    let block = RcBlock::new(move |_note: NonNull<NSNotification>| on_power_off());
    // SAFETY: AppKit calls on the shared workspace; the observer lives for the whole process.
    unsafe {
        let center = NSWorkspace::sharedWorkspace().notificationCenter();
        let observer =
            center.addObserverForName_object_queue_usingBlock(Some(NSWorkspaceWillPowerOffNotification), None, None, &block);
        std::mem::forget(observer);
    }
}

static DECIDE: OnceLock<Arc<dyn Fn() -> bool + Send + Sync>> = OnceLock::new();

/// NSTerminateCancel = 0, NSTerminateNow = 1.
extern "C-unwind" fn should_terminate(_this: *mut AnyObject, _sel: Sel, _sender: *mut AnyObject) -> usize {
    let now = std::panic::catch_unwind(|| DECIDE.get().is_none_or(|decide| decide())).unwrap_or(true);
    usize::from(now)
}

pub fn intercept_terminate(decide: Arc<dyn Fn() -> bool + Send + Sync>) -> bool {
    let Some(mtm) = MainThreadMarker::new() else { return false };
    let _ = DECIDE.set(decide);
    let app = NSApplication::sharedApplication(mtm);
    let Some(delegate) = app.delegate() else { return false };
    let object: &AnyObject = delegate.as_ref();
    let class: &AnyClass = object.class();
    let name = sel!(applicationShouldTerminate:);
    // SAFETY: the method matches `- (NSApplicationTerminateReply)applicationShouldTerminate:(NSApplication *)sender`
    // (NSUInteger return, type encoding "Q@:@"); it is added to (or replaces it on) the delegate's own class.
    unsafe {
        let imp: Imp =
            std::mem::transmute::<extern "C-unwind" fn(*mut AnyObject, Sel, *mut AnyObject) -> usize, Imp>(should_terminate);
        let types = c"Q@:@".as_ptr();
        let class = class as *const AnyClass as *mut AnyClass;
        if !ffi::class_addMethod(class, name, imp, types).as_bool() {
            ffi::class_replaceMethod(class, name, imp, types);
        }
    }
    true
}

fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// `display alert` through osascript (no parent window; the app's buttons, at most three like the app's questions).
pub fn message_dialog(d: &MessageDialog) -> usize {
    let buttons: Vec<String> = d.buttons.iter().take(3).map(|b| applescript_string(b)).collect();
    let mut script = format!(
        "display alert {} message {} as {} buttons {{{}}}",
        applescript_string(&d.message),
        applescript_string(&d.detail),
        if d.kind == DialogKind::Error { "critical" } else { "warning" },
        buttons.join(", ")
    );
    if let Some(default) = d.buttons.get(d.default_id) {
        script.push_str(&format!(" default button {}", applescript_string(default)));
    }
    let output = std::process::Command::new("osascript").arg("-e").arg(script).output();
    let Ok(output) = output else { return d.cancel_id };
    let text = String::from_utf8_lossy(&output.stdout);
    let chosen = text.trim().strip_prefix("button returned:").unwrap_or("");
    d.buttons.iter().position(|b| b == chosen).unwrap_or(d.cancel_id)
}
