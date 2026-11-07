//! Windows half of [`crate::lifecycle`]: the session-end subclass and the task dialog.

use std::io;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::UI::Controls::{
    TASKDIALOG_BUTTON, TASKDIALOGCONFIG, TD_ERROR_ICON, TD_WARNING_ICON, TDF_ALLOW_DIALOG_CANCELLATION,
    TDF_POSITION_RELATIVE_TO_WINDOW,
};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    IDCANCEL, IDYES, MB_DEFBUTTON1, MB_DEFBUTTON2, MB_ICONERROR, MB_ICONWARNING, MB_YESNO, MessageBoxW, WM_ENDSESSION,
    WM_NCDESTROY, WM_QUERYENDSESSION,
};
use windows::core::{BOOL, HRESULT, HSTRING, PCWSTR, s, w};

use crate::lifecycle::{DialogKind, MessageDialog, SessionEndHooks};

/// Our subclass id on the main window ("W6SE"); other packages (W1: hit testing) use their own ids.
const SESSION_END_SUBCLASS: usize = 0x5736_5345;

pub fn watch_session_end(hwnd: isize, hooks: Arc<SessionEndHooks>) -> io::Result<()> {
    let data = Arc::into_raw(hooks) as usize;
    // SAFETY: called on the window's own thread (the caller's contract); `data` stays valid until WM_NCDESTROY releases it.
    let ok = unsafe { SetWindowSubclass(HWND(hwnd as *mut _), Some(session_end_proc), SESSION_END_SUBCLASS, data) };
    if ok.as_bool() {
        Ok(())
    } else {
        // SAFETY: the Arc was not handed over; take it back.
        drop(unsafe { Arc::from_raw(data as *const SessionEndHooks) });
        Err(io::Error::last_os_error())
    }
}

unsafe extern "system" fn session_end_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    data: usize,
) -> LRESULT {
    // SAFETY: `data` is the Arc set by watch_session_end, alive until WM_NCDESTROY below.
    let hooks = unsafe { &*(data as *const SessionEndHooks) };
    match msg {
        // A panic must never cross the window procedure (it would abort the process during a logoff).
        WM_QUERYENDSESSION => {
            let _ = catch_unwind(AssertUnwindSafe(|| (hooks.query)()));
        }
        WM_ENDSESSION => {
            let _ = catch_unwind(AssertUnwindSafe(|| (hooks.end)(wparam.0 != 0)));
        }
        WM_NCDESTROY => {
            // SAFETY: our own subclass on this window; the Arc is released once.
            unsafe {
                let _ = RemoveWindowSubclass(hwnd, Some(session_end_proc), SESSION_END_SUBCLASS);
                drop(Arc::from_raw(data as *const SessionEndHooks));
            }
            // SAFETY: default handling of the message.
            return unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) };
        }
        _ => {}
    }
    // SAFETY: the next window procedure answers (TRUE for WM_QUERYENDSESSION: the session may end).
    unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
}

type TaskDialogIndirectFn = unsafe extern "system" fn(*const TASKDIALOGCONFIG, *mut i32, *mut i32, *mut BOOL) -> HRESULT;

/// TaskDialogIndirect exists only in comctl32 v6, which the app gets through its manifest (tauri `common-controls-v6`). It is
/// looked up at run time so binaries without that manifest (cargo test) still load; they fall back to a Yes/No box.
fn task_dialog_indirect() -> Option<TaskDialogIndirectFn> {
    // SAFETY: plain library lookups; the transmute matches the documented signature.
    unsafe {
        let module = LoadLibraryW(w!("comctl32.dll")).ok()?;
        let f = GetProcAddress(module, s!("TaskDialogIndirect"))?;
        Some(std::mem::transmute::<unsafe extern "system" fn() -> isize, TaskDialogIndirectFn>(f))
    }
}

/// Button ids are 100 + index (below 100 the ids mean IDOK, IDCANCEL...).
const BUTTON_BASE: i32 = 100;

pub fn message_dialog(owner: Option<isize>, d: &MessageDialog) -> usize {
    let title = HSTRING::from(d.title.as_str());
    let message = HSTRING::from(d.message.as_str());
    let detail = HSTRING::from(d.detail.as_str());
    let labels: Vec<HSTRING> = d.buttons.iter().map(|b| HSTRING::from(b.as_str())).collect();
    let owner = HWND(owner.unwrap_or(0) as *mut _);
    if let Some(task_dialog) = task_dialog_indirect() {
        let buttons: Vec<TASKDIALOG_BUTTON> = labels
            .iter()
            .enumerate()
            .map(|(i, l)| TASKDIALOG_BUTTON { nButtonID: BUTTON_BASE + i as i32, pszButtonText: PCWSTR(l.as_ptr()) })
            .collect();
        let mut config = TASKDIALOGCONFIG {
            cbSize: std::mem::size_of::<TASKDIALOGCONFIG>() as u32,
            hwndParent: owner,
            dwFlags: TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW,
            pszWindowTitle: PCWSTR(title.as_ptr()),
            pszMainInstruction: PCWSTR(message.as_ptr()),
            pszContent: if d.detail.is_empty() { PCWSTR::null() } else { PCWSTR(detail.as_ptr()) },
            cButtons: buttons.len() as u32,
            pButtons: buttons.as_ptr(),
            nDefaultButton: BUTTON_BASE + d.default_id as i32,
            ..Default::default()
        };
        config.Anonymous1.pszMainIcon = match d.kind {
            DialogKind::Error => TD_ERROR_ICON,
            DialogKind::Warning => TD_WARNING_ICON,
        };
        let mut pressed = 0i32;
        // SAFETY: the config and every string it points to live until the call returns.
        let result = unsafe { task_dialog(&config, &mut pressed, std::ptr::null_mut(), std::ptr::null_mut()) };
        if result.is_ok() {
            let index = pressed - BUTTON_BASE;
            return if (0..d.buttons.len() as i32).contains(&index) { index as usize } else { d.cancel_id };
        }
    }
    // Two buttons at most in the app's questions: Yes = the first, No = the second.
    let text = if d.detail.is_empty() { d.message.clone() } else { format!("{}\n\n{}", d.message, d.detail) };
    let text = HSTRING::from(text.as_str());
    let icon = if d.kind == DialogKind::Error { MB_ICONERROR } else { MB_ICONWARNING };
    let default = if d.default_id == 1 { MB_DEFBUTTON2 } else { MB_DEFBUTTON1 };
    // SAFETY: valid strings; the owner may be null.
    let answer = unsafe { MessageBoxW(Some(owner), PCWSTR(text.as_ptr()), PCWSTR(title.as_ptr()), MB_YESNO | icon | default) };
    if answer == IDYES {
        0
    } else if answer == IDCANCEL {
        d.cancel_id
    } else {
        1
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn task_dialog_lookup_never_breaks_a_binary_without_the_manifest() {
        // cargo test binaries have no comctl32 v6 manifest: the lookup may fail, but it must not abort the process.
        let _ = super::task_dialog_indirect();
    }
}
