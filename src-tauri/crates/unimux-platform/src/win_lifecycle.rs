//! Windows half of [`crate::lifecycle`]: the session-end subclass and the task dialog.

use std::io;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;

use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::Controls::{
    TASKDIALOG_BUTTON, TASKDIALOGCONFIG, TD_ERROR_ICON, TD_WARNING_ICON, TDF_ALLOW_DIALOG_CANCELLATION,
    TDF_POSITION_RELATIVE_TO_WINDOW,
};
use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, EnumThreadWindows, GWLP_HWNDPARENT, GetClassNameW, IDCANCEL, IDYES, MB_DEFBUTTON1,
    MB_DEFBUTTON2, MB_ICONERROR, MB_ICONWARNING, MB_YESNO, MessageBoxW, RegisterClassExW, SetWindowLongPtrW, WM_CLOSE,
    WM_ENDSESSION, WM_NCDESTROY, WM_QUERYENDSESSION, WNDCLASSEXW, WS_EX_TOOLWINDOW, WS_POPUP,
};
use windows::core::{BOOL, HRESULT, HSTRING, PCWSTR, s, w};

use crate::lifecycle::{DialogKind, MessageDialog, OutsideClose, SessionEndHooks};

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

/// The class of tao's window for the event loop's own messages.
const EVENT_LOOP_CLASS: PCWSTR = w!("Tao Thread Event Target");
/// Our subclass id on the windows of the guard ("CLOS").
const OUTSIDE_CLOSE_SUBCLASS: usize = 0x434C_4F53;

pub fn guard_event_loop_window(hook: Arc<OutsideClose>) -> io::Result<usize> {
    guard_windows_of_class(EVENT_LOOP_CLASS, hook)
}

/// The windows of class `class` on this thread get the close guard and share one hidden owner: an unowned visible top-level
/// window is what Process.MainWindowHandle and similar look for, and the owner is never destroyed (its own close is guarded
/// too), so an owned helper lives as long as the thread.
fn guard_windows_of_class(class: PCWSTR, hook: Arc<OutsideClose>) -> io::Result<usize> {
    let targets = thread_windows_of_class(class);
    if targets.is_empty() {
        return Ok(0);
    }
    let owner = create_owner()?;
    guard_close(owner, hook.clone())?;
    for &target in &targets {
        guard_close(target, hook.clone())?;
        // SAFETY: both windows belong to this thread; for a top-level window GWLP_HWNDPARENT sets the owner.
        unsafe { SetWindowLongPtrW(target, GWLP_HWNDPARENT, owner.0 as isize) };
    }
    Ok(targets.len())
}

fn thread_windows_of_class(class: PCWSTR) -> Vec<HWND> {
    struct Search {
        class: Vec<u16>,
        found: Vec<HWND>,
    }
    unsafe extern "system" fn visit(hwnd: HWND, lparam: LPARAM) -> BOOL {
        // SAFETY: `lparam` is the Search of the call below, alive while EnumThreadWindows runs.
        let search = unsafe { &mut *(lparam.0 as *mut Search) };
        let mut name = [0u16; 64];
        // SAFETY: the buffer outlives the call.
        let len = unsafe { GetClassNameW(hwnd, &mut name) } as usize;
        if name[..len] == search.class[..] {
            search.found.push(hwnd);
        }
        true.into()
    }
    // SAFETY: `class` is a NUL-terminated constant.
    let mut search = Search { class: unsafe { class.as_wide() }.to_vec(), found: Vec::new() };
    // SAFETY: the callback only uses `search`, which outlives the enumeration.
    let _ = unsafe { EnumThreadWindows(GetCurrentThreadId(), Some(visit), LPARAM(&mut search as *mut Search as isize)) };
    search.found
}

unsafe extern "system" fn default_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    // SAFETY: the arguments are the ones the window procedure was called with.
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn create_owner() -> io::Result<HWND> {
    let class = w!("unimux helper owner");
    let wc = WNDCLASSEXW {
        cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
        lpfnWndProc: Some(default_proc),
        lpszClassName: class,
        ..Default::default()
    };
    // SAFETY: a valid class description; a class that exists already fails harmlessly and CreateWindowExW below reports errors.
    unsafe { RegisterClassExW(&wc) };
    // SAFETY: a hidden tool window of this thread (no WS_VISIBLE); the class name is a constant.
    unsafe { CreateWindowExW(WS_EX_TOOLWINDOW, class, PCWSTR::null(), WS_POPUP, 0, 0, 0, 0, None, None, None, None) }
        .map_err(|e| io::Error::other(e.to_string()))
}

fn guard_close(hwnd: HWND, hook: Arc<OutsideClose>) -> io::Result<()> {
    let data = Arc::into_raw(hook) as usize;
    // SAFETY: on the window's own thread; `data` stays valid until WM_NCDESTROY releases it.
    let ok = unsafe { SetWindowSubclass(hwnd, Some(outside_close_proc), OUTSIDE_CLOSE_SUBCLASS, data) };
    if ok.as_bool() {
        Ok(())
    } else {
        // SAFETY: the Arc was not handed over; take it back.
        drop(unsafe { Arc::from_raw(data as *const OutsideClose) });
        Err(io::Error::last_os_error())
    }
}

unsafe extern "system" fn outside_close_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    data: usize,
) -> LRESULT {
    match msg {
        // Never handed on: default handling is DestroyWindow. SC_CLOSE comes here too (DefWindowProc turns it into WM_CLOSE).
        WM_CLOSE => {
            // SAFETY: `data` is the Arc set by guard_close, alive until WM_NCDESTROY below.
            let hook = unsafe { &*(data as *const OutsideClose) };
            let _ = catch_unwind(AssertUnwindSafe(|| (hook.0)()));
            LRESULT(0)
        }
        WM_NCDESTROY => {
            // SAFETY: our own subclass on this window; the Arc is released once.
            unsafe {
                let _ = RemoveWindowSubclass(hwnd, Some(outside_close_proc), OUTSIDE_CLOSE_SUBCLASS);
                drop(Arc::from_raw(data as *const OutsideClose));
            }
            // SAFETY: default handling of the message.
            unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) }
        }
        // SAFETY: the next window procedure answers.
        _ => unsafe { DefSubclassProc(hwnd, msg, wparam, lparam) },
    }
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
    use std::sync::atomic::{AtomicUsize, Ordering};

    use windows::Win32::UI::WindowsAndMessaging::{
        DestroyWindow, GW_OWNER, GetWindow, IsWindow, IsWindowVisible, SC_CLOSE, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_SHOWWINDOW, SendMessageW, SetWindowPos, WM_SYSCOMMAND, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TRANSPARENT,
    };

    use super::*;

    #[test]
    fn task_dialog_lookup_never_breaks_a_binary_without_the_manifest() {
        // cargo test binaries have no comctl32 v6 manifest: the lookup may fail, but it must not abort the process.
        let _ = super::task_dialog_indirect();
    }

    /// A window like tao's: layered, transparent, visible, WS_POPUP, 0 x 0. Its procedure is the default one, as tao's is for
    /// WM_CLOSE (DestroyWindow).
    fn tao_like(class: PCWSTR) -> HWND {
        let wc = WNDCLASSEXW {
            cbSize: std::mem::size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(default_proc),
            lpszClassName: class,
            ..Default::default()
        };
        // SAFETY: a test-only window of this thread, a valid class description.
        unsafe {
            RegisterClassExW(&wc);
            let hwnd = CreateWindowExW(
                WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_LAYERED | WS_EX_TOOLWINDOW,
                class,
                PCWSTR::null(),
                WS_POPUP,
                0,
                0,
                0,
                0,
                None,
                None,
                None,
                None,
            )
            .unwrap();
            let _ = SetWindowPos(hwnd, None, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
            hwnd
        }
    }

    #[test]
    fn an_outside_close_of_the_helper_runs_the_hook_and_leaves_it_alive_with_an_owner() {
        let class = w!("unimux test event target");
        let hwnd = tao_like(class);
        let calls = Arc::new(AtomicUsize::new(0));
        let c = calls.clone();
        let hook = Arc::new(OutsideClose(Box::new(move || {
            c.fetch_add(1, Ordering::SeqCst);
        })));
        assert_eq!(guard_windows_of_class(class, hook).unwrap(), 1);
        // SAFETY: test windows of this thread.
        unsafe {
            let owner = GetWindow(hwnd, GW_OWNER).unwrap();
            assert!(IsWindowVisible(hwnd).as_bool(), "the helper stays visible: tao needs its WM_PAINT");
            assert!(!IsWindowVisible(owner).as_bool());
            let result = SendMessageW(hwnd, WM_CLOSE, None, None);
            assert_eq!(result, LRESULT(0));
            assert!(IsWindow(Some(hwnd)).as_bool(), "the helper must survive WM_CLOSE");
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            // DefWindowProc makes SC_CLOSE a WM_CLOSE, through the subclass chain.
            let _ = SendMessageW(hwnd, WM_SYSCOMMAND, Some(WPARAM(SC_CLOSE as usize)), None);
            assert!(IsWindow(Some(hwnd)).as_bool());
            assert_eq!(calls.load(Ordering::SeqCst), 2);
            // The owner: the same guard, so it can never take the helper down with it.
            let _ = SendMessageW(owner, WM_CLOSE, None, None);
            assert!(IsWindow(Some(owner)).as_bool());
            assert!(IsWindow(Some(hwnd)).as_bool());
            assert_eq!(calls.load(Ordering::SeqCst), 3);
            // A real DestroyWindow (tao's own teardown) still works and releases the hook.
            DestroyWindow(hwnd).unwrap();
            assert!(!IsWindow(Some(hwnd)).as_bool());
        }
    }

    #[test]
    fn no_helper_window_on_this_thread_guards_nothing() {
        let hook = Arc::new(OutsideClose(Box::new(|| {})));
        assert_eq!(guard_windows_of_class(w!("no such window class here"), hook).unwrap(), 0);
    }
}
