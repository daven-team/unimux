//! W1: the caption buttons of a window without a system title bar (Windows). The page draws the buttons like 1.1.4's
//! Electron overlay (src/renderer/src/captionPaint.ts); this module puts a small transparent child window over them (no
//! redirection bitmap, so it shows nothing) that answers WM_NCHITTEST with HTMINBUTTON / HTMAXBUTTON / HTCLOSE like
//! Electron's frame did. Windows then treats the area as real caption buttons: the Windows 11 snap layouts open from the
//! maximize button. The child reports the pointer (hover, held button) to the page, which paints the states, and runs the
//! click (minimize, maximize / restore, close) itself. The same technique as Windows Terminal's drag bar window.
//!
//! The drag region (HTCAPTION: move, Aero snap, double-click maximize, the system menu) comes from WebView2's non-client
//! region support (`-webkit-app-region: drag` in the page, `IsNonClientRegionSupportEnabled` in windows.rs). WebView2 forwards
//! only the WM_NCRBUTTONUP of a right click there, so the main window's subclass below turns it into the WM_CONTEXTMENU that
//! opens the system menu.

use serde::Deserialize;

/// The three buttons, in the order of the page's `CaptionArea`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Button {
    Min,
    Max,
    Close,
}

impl Button {
    pub const ALL: [Button; 3] = [Button::Min, Button::Max, Button::Close];
    pub fn id(self) -> &'static str {
        match self {
            Button::Min => "min",
            Button::Max => "max",
            Button::Close => "close",
        }
    }
    /// The WM_NCHITTEST answer of 1.1.4 (Electron's WinCaptionButtonContainer::NonClientHitTest).
    pub fn hit_code(self) -> i32 {
        match self {
            Button::Min => 8,    // HTMINBUTTON
            Button::Max => 9,    // HTMAXBUTTON
            Button::Close => 20, // HTCLOSE
        }
    }
}

/// A rect in client pixels of the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl Rect {
    pub fn contains(&self, x: i32, y: i32) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }
    /// The part of the rect inside (0, 0)..(width, height).
    pub fn clamped(&self, width: i32, height: i32) -> Rect {
        let x = self.x.clamp(0, width);
        let y = self.y.clamp(0, height);
        Rect { x, y, width: (self.right().min(width) - x).max(0), height: (self.bottom().min(height) - y).max(0) }
    }
    fn right(&self) -> i32 {
        self.x + self.width
    }
    fn bottom(&self) -> i32 {
        self.y + self.height
    }
}

/// `windowControls.setCaptionArea(area)`: the hit areas of the three buttons.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct Area {
    pub min: Rect,
    pub max: Rect,
    pub close: Rect,
}

/// The biggest area the page may claim (a page cannot cover the window with an invisible input sink).
const MAX_BUTTON: i32 = 1000;

impl Area {
    pub fn rect(&self, b: Button) -> Rect {
        match b {
            Button::Min => self.min,
            Button::Max => self.max,
            Button::Close => self.close,
        }
    }
    pub fn hit(&self, x: i32, y: i32) -> Option<Button> {
        Button::ALL.into_iter().find(|b| self.rect(*b).contains(x, y))
    }
    /// The child window's rect: the union of the buttons.
    pub fn bounds(&self) -> Rect {
        let rects = Button::ALL.map(|b| self.rect(b));
        let x = rects.iter().map(|r| r.x).min().unwrap_or(0);
        let y = rects.iter().map(|r| r.y).min().unwrap_or(0);
        let right = rects.iter().map(|r| r.right()).max().unwrap_or(0);
        let bottom = rects.iter().map(|r| r.bottom()).max().unwrap_or(0);
        Rect { x, y, width: right - x, height: bottom - y }
    }
    /// Sane sizes only (non-negative, at most 1000 px per button, inside +-32768).
    pub fn is_sane(&self) -> bool {
        Button::ALL.iter().all(|b| {
            let r = self.rect(*b);
            (0..=MAX_BUTTON).contains(&r.width)
                && (0..=MAX_BUTTON).contains(&r.height)
                && (-32768..32768).contains(&r.x)
                && (-32768..32768).contains(&r.y)
        })
    }
}

/// What the page shows and what a release does: hover follows the pointer; a left press holds a button, which shows pressed
/// only while the pointer is over it, and a release over it clicks (views::Button of 1.1.4).
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Pointer {
    pub hover: Option<Button>,
    pub down: Option<Button>,
    pub over_down: bool,
}

impl Pointer {
    /// (hovered, shown pressed) for the page.
    pub fn view(&self) -> (Option<Button>, Option<Button>) {
        match self.down {
            Some(d) => (None, if self.over_down { Some(d) } else { None }),
            None => (self.hover, None),
        }
    }
    pub fn moved(&mut self, under: Option<Button>) {
        if let Some(d) = self.down {
            self.over_down = under == Some(d);
        } else {
            self.hover = under;
        }
    }
    pub fn left(&mut self) {
        if self.down.is_none() {
            self.hover = None;
        }
    }
    pub fn pressed(&mut self, under: Option<Button>) {
        self.down = under;
        self.over_down = under.is_some();
        self.hover = None;
    }
    /// The release: the button to click (released over the held one), and the hover afterwards.
    pub fn released(&mut self, under: Option<Button>) -> Option<Button> {
        let click = self.down.filter(|d| under == Some(*d));
        self.down = None;
        self.over_down = false;
        self.hover = under;
        click
    }
    /// The capture went elsewhere (another window took it, Alt+Tab): nothing is held any more.
    pub fn cancelled(&mut self) {
        self.down = None;
        self.over_down = false;
        self.hover = None;
    }
}

/// What the child window reports to the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptionEvent {
    Pointer { hover: Option<Button>, pressed: Option<Button> },
    Click(Button),
}

#[cfg(windows)]
mod win {
    use std::collections::HashMap;
    use std::sync::{Mutex, Once};

    use tauri::WebviewWindow;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, WPARAM};
    use windows::Win32::Graphics::Gdi::ScreenToClient;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        ReleaseCapture, SetCapture, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT, TrackMouseEvent,
    };
    use windows::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        CREATESTRUCTW, CreateWindowExW, DefWindowProcW, GWLP_USERDATA, GetClientRect, GetWindowLongPtrW, HTTRANSPARENT, HWND_TOP,
        IDC_ARROW, LoadCursorW, RegisterClassExW, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW,
        SetWindowLongPtrW, SetWindowPos, WM_CAPTURECHANGED, WM_CREATE, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCDESTROY, WM_NCHITTEST,
        WM_NCLBUTTONDBLCLK, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_NCRBUTTONDOWN, WM_NCRBUTTONUP,
        WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_NOREDIRECTIONBITMAP,
    };
    use windows::Win32::UI::WindowsAndMessaging::{HTCAPTION, PostMessageW, SendMessageW, WM_APP, WM_CONTEXTMENU, WM_SIZE};
    use windows::core::w;

    use super::{Area, Button, CaptionEvent, Pointer};

    /// Posted to the child after the parent was sized: back on top of its siblings. Tauri's undecorated-resize window (the
    /// top border, tauri-runtime-wry undecorated_resizing.rs) raises itself on every WM_SIZE and would cover the buttons'
    /// top rows; it does so with an asynchronous SetWindowPos, so ours is posted after it.
    const WM_RAISE: u32 = WM_APP + 0x31;
    const SUBCLASS_ID: usize = 0x5731_0001;

    thread_local! {
        /// A WM_CONTEXTMENU went through the main window while its WM_NCRBUTTONUP was handled (UI thread only).
        static CONTEXT_MENU_SEEN: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    }

    unsafe extern "system" fn parent_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        child: usize,
    ) -> LRESULT {
        // SAFETY: the next procedure first (Tauri's subclass posts its raise there), then a post to our own child.
        unsafe {
            if msg == WM_CONTEXTMENU {
                CONTEXT_MENU_SEEN.with(|s| s.set(true));
            }
            // A right click on the title bar: WebView2's non-client region forwards only the WM_NCRBUTTONUP (HTCAPTION) to
            // this window, and DefWindowProc makes no WM_CONTEXTMENU of it, so the system menu never opened. It is asked for
            // here (DefWindowProc opens the system menu for a WM_CONTEXTMENU over the caption), unless the chain already did.
            if msg == WM_NCRBUTTONUP && wparam.0 as u32 == HTCAPTION {
                CONTEXT_MENU_SEEN.with(|s| s.set(false));
                let result = DefSubclassProc(hwnd, msg, wparam, lparam);
                if !CONTEXT_MENU_SEEN.with(|s| s.get()) {
                    SendMessageW(hwnd, WM_CONTEXTMENU, Some(WPARAM(hwnd.0 as usize)), Some(lparam));
                }
                return result;
            }
            let result = DefSubclassProc(hwnd, msg, wparam, lparam);
            if msg == WM_SIZE {
                let _ = PostMessageW(Some(HWND(child as *mut _)), WM_RAISE, WPARAM(0), LPARAM(0));
            }
            if msg == WM_NCDESTROY {
                let _ = RemoveWindowSubclass(hwnd, Some(parent_proc), SUBCLASS_ID);
            }
            result
        }
    }

    type Handler = Box<dyn Fn(CaptionEvent) + Send + 'static>;

    struct ChildState {
        parent: HWND,
        area: Option<Area>,
        pointer: Pointer,
        tracking: bool,
        handler: Handler,
    }

    /// Window label -> child HWND (as isize: HWND is not Send).
    static CHILDREN: Mutex<Option<HashMap<String, isize>>> = Mutex::new(None);
    static REGISTER: Once = Once::new();
    const CLASS: windows::core::PCWSTR = w!("UNIMUX_CAPTION_BUTTONS");

    /// Puts the hit-test child on `window` (once per window); `handler` gets the pointer reports and the clicks on the UI thread.
    pub fn attach(window: &WebviewWindow, handler: impl Fn(CaptionEvent) + Send + 'static) {
        let label = window.label().to_string();
        let Ok(parent) = window.hwnd() else { return };
        let parent = parent.0 as isize;
        let handler: Handler = Box::new(handler);
        let _ = window.run_on_main_thread(move || {
            let mut map = CHILDREN.lock().unwrap_or_else(|e| e.into_inner());
            let map = map.get_or_insert_with(HashMap::new);
            if map.contains_key(&label) {
                return;
            }
            // SAFETY: on the UI thread that owns `parent`; the state box is freed in WM_NCDESTROY.
            if let Some(child) = unsafe { create_child(HWND(parent as *mut _), handler) } {
                map.insert(label, child.0 as isize);
            }
        });
    }

    /// Moves the child over the buttons (`None`: hides it, the page shows no buttons).
    pub fn set_area(window: &WebviewWindow, area: Option<Area>) {
        let label = window.label().to_string();
        let _ = window.run_on_main_thread(move || {
            let child = {
                let map = CHILDREN.lock().unwrap_or_else(|e| e.into_inner());
                map.as_ref().and_then(|m| m.get(&label).copied())
            };
            let Some(child) = child else { return };
            let child = HWND(child as *mut _);
            // SAFETY: UI thread; the state pointer lives as long as the child.
            unsafe {
                let Some(state) = state_of(child) else { return };
                state.area = area;
                match area {
                    Some(a) => {
                        // Kept inside the client area (at 125 / 150 percent the page's layout may reach one pixel past it).
                        let mut client = windows::Win32::Foundation::RECT::default();
                        let mut b = a.bounds();
                        if GetClientRect(state.parent, &mut client).is_ok() {
                            b = b.clamped(client.right, client.bottom);
                        }
                        let _ = SetWindowPos(child, Some(HWND_TOP), b.x, b.y, b.width, b.height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                    }
                    None => {
                        let _ = SetWindowPos(child, None, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_HIDEWINDOW);
                    }
                }
            }
        });
    }

    /// Forgets a destroyed window's child (the child itself goes with its parent).
    pub fn forget(label: &str) {
        let mut map = CHILDREN.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(m) = map.as_mut() {
            m.remove(label);
        }
    }

    /// The child of a window: its rect in the parent's client pixels, whether it shows, and the area it answers for.
    #[cfg(feature = "test-bridge")]
    pub fn probe(label: &str) -> serde_json::Value {
        use windows::Win32::Foundation::RECT;
        use windows::Win32::UI::WindowsAndMessaging::{GetWindowRect, IsWindowVisible};
        let child = {
            let map = CHILDREN.lock().unwrap_or_else(|e| e.into_inner());
            map.as_ref().and_then(|m| m.get(label).copied())
        };
        let Some(child) = child else { return serde_json::json!({ "child": null }) };
        let child = HWND(child as *mut _);
        // SAFETY: read-only queries on our own child (a probe may read the state while the UI thread is idle).
        unsafe {
            let Some(state) = state_of(child) else { return serde_json::json!({ "child": null }) };
            let mut r = RECT::default();
            let _ = GetWindowRect(child, &mut r);
            let mut tl = POINT { x: r.left, y: r.top };
            let _ = ScreenToClient(state.parent, &mut tl);
            let rect = |x: super::Rect| serde_json::json!([x.x, x.y, x.width, x.height]);
            serde_json::json!({
                "child": child.0 as isize,
                "parent": state.parent.0 as isize,
                "visible": IsWindowVisible(child).as_bool(),
                "rect": [tl.x, tl.y, r.right - r.left, r.bottom - r.top],
                "area": state.area.map(|a| serde_json::json!({ "min": rect(a.min), "max": rect(a.max), "close": rect(a.close) })),
            })
        }
    }

    unsafe fn create_child(parent: HWND, handler: Handler) -> Option<HWND> {
        // SAFETY: plain Win32 calls; the boxed state is handed to WM_CREATE and owned by the window from then on.
        unsafe {
            let instance = GetModuleHandleW(None).ok()?;
            REGISTER.call_once(|| {
                let class = WNDCLASSEXW {
                    cbSize: size_of::<WNDCLASSEXW>() as u32,
                    lpfnWndProc: Some(proc_),
                    hInstance: instance.into(),
                    hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                    lpszClassName: CLASS,
                    ..Default::default()
                };
                RegisterClassExW(&class);
            });
            let state =
                Box::into_raw(Box::new(ChildState { parent, area: None, pointer: Pointer::default(), tracking: false, handler }));
            // No redirection bitmap: the window has no pixels of its own, the page's buttons show through. Layered as in
            // Windows Terminal's drag bar; without it (older systems refuse layered children) it still works.
            for ex in [WS_EX_LAYERED | WS_EX_NOREDIRECTIONBITMAP | WS_EX_NOACTIVATE, WS_EX_NOREDIRECTIONBITMAP | WS_EX_NOACTIVATE]
            {
                if let Ok(child) = CreateWindowExW(
                    ex,
                    CLASS,
                    w!(""),
                    WS_CHILD | WS_CLIPSIBLINGS,
                    0,
                    0,
                    0,
                    0,
                    Some(parent),
                    None,
                    Some(instance.into()),
                    Some(state as *const _),
                ) {
                    let _ = SetWindowSubclass(parent, Some(parent_proc), SUBCLASS_ID, child.0 as usize);
                    return Some(child);
                }
            }
            drop(Box::from_raw(state));
            None
        }
    }

    unsafe fn state_of<'a>(hwnd: HWND) -> Option<&'a mut ChildState> {
        // SAFETY: GWLP_USERDATA holds the Box<ChildState> pointer set in WM_CREATE (or 0).
        unsafe { (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *mut ChildState).as_mut() }
    }

    fn point(lparam: LPARAM) -> POINT {
        POINT { x: (lparam.0 & 0xffff) as u16 as i16 as i32, y: ((lparam.0 >> 16) & 0xffff) as u16 as i16 as i32 }
    }

    /// The button under a point given in screen (`screen`) or child client coordinates.
    unsafe fn under(hwnd: HWND, state: &ChildState, mut p: POINT, screen: bool) -> Option<Button> {
        let area = state.area?;
        // SAFETY: plain coordinate conversions between our own windows.
        unsafe {
            if screen {
                let _ = ScreenToClient(state.parent, &mut p);
            } else {
                let b = area.bounds();
                p.x += b.x;
                p.y += b.y;
                let _ = hwnd;
            }
        }
        area.hit(p.x, p.y)
    }

    fn report(state: &ChildState) {
        let (hover, pressed) = state.pointer.view();
        (state.handler)(CaptionEvent::Pointer { hover, pressed });
    }

    unsafe extern "system" fn proc_(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        // SAFETY: the window procedure of our own class; the state pointer is valid between WM_CREATE and WM_NCDESTROY.
        unsafe {
            if msg == WM_CREATE {
                let cs = &*(lparam.0 as *const CREATESTRUCTW);
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, cs.lpCreateParams as isize);
                return LRESULT(0);
            }
            if msg == WM_NCDESTROY {
                let ptr = SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) as *mut ChildState;
                if !ptr.is_null() {
                    drop(Box::from_raw(ptr));
                }
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            let Some(state) = state_of(hwnd) else { return DefWindowProcW(hwnd, msg, wparam, lparam) };
            match msg {
                WM_NCHITTEST => {
                    return match under(hwnd, state, point(lparam), true) {
                        Some(b) => LRESULT(b.hit_code() as isize),
                        None => LRESULT(HTTRANSPARENT as isize),
                    };
                }
                WM_NCMOUSEMOVE => {
                    if !state.tracking {
                        let mut tme = TRACKMOUSEEVENT {
                            cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
                            dwFlags: TME_LEAVE | TME_NONCLIENT,
                            hwndTrack: hwnd,
                            dwHoverTime: 0,
                        };
                        state.tracking = TrackMouseEvent(&mut tme).is_ok();
                    }
                    let before = state.pointer.view();
                    state.pointer.moved(under(hwnd, state, point(lparam), true));
                    if state.pointer.view() != before {
                        report(state);
                    }
                    // DefWindowProc keeps the system's own handling (the snap layouts flyout over HTMAXBUTTON).
                    return DefWindowProcW(hwnd, msg, wparam, lparam);
                }
                WM_NCMOUSELEAVE => {
                    state.tracking = false;
                    let before = state.pointer.view();
                    state.pointer.left();
                    if state.pointer.view() != before {
                        report(state);
                    }
                    return DefWindowProcW(hwnd, msg, wparam, lparam);
                }
                WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => {
                    let b = under(hwnd, state, point(lparam), true);
                    if b.is_some() {
                        state.pointer.pressed(b);
                        SetCapture(hwnd);
                        report(state);
                    }
                    return LRESULT(0);
                }
                WM_MOUSEMOVE if state.pointer.down.is_some() => {
                    let before = state.pointer.view();
                    state.pointer.moved(under(hwnd, state, point(lparam), false));
                    if state.pointer.view() != before {
                        report(state);
                    }
                    return LRESULT(0);
                }
                WM_LBUTTONUP | WM_NCLBUTTONUP if state.pointer.down.is_some() => {
                    let b = under(hwnd, state, point(lparam), msg == WM_NCLBUTTONUP);
                    let click = state.pointer.released(b);
                    let _ = ReleaseCapture();
                    report(state);
                    if let Some(c) = click {
                        (state.handler)(CaptionEvent::Click(c));
                    }
                    return LRESULT(0);
                }
                WM_CAPTURECHANGED if state.pointer.down.is_some() => {
                    state.pointer.cancelled();
                    report(state);
                    return LRESULT(0);
                }
                WM_RAISE => {
                    if state.area.is_some() {
                        let _ = SetWindowPos(hwnd, Some(HWND_TOP), 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
                    }
                    return LRESULT(0);
                }
                // Right clicks on the buttons do nothing (1.1.4's buttons took the left button only).
                WM_NCRBUTTONDOWN | WM_NCRBUTTONUP => return LRESULT(0),
                _ => {}
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
    }
}

#[cfg(windows)]
pub use win::forget;

#[cfg(not(windows))]
pub fn forget(_label: &str) {}

/// The pointer report of `window:caption` (`CaptionPointer` in src/shared/caption.ts).
pub fn pointer_json(hover: Option<Button>, pressed: Option<Button>) -> serde_json::Value {
    serde_json::json!({ "hover": hover.map(Button::id), "pressed": pressed.map(Button::id) })
}

/// The system command a click runs (Chromium's HWNDMessageHandler sends the same for 1.1.4's buttons: SC_MINIMIZE,
/// SC_MAXIMIZE or SC_RESTORE, and SC_CLOSE, which ends as WM_CLOSE).
pub fn click_command(button: Button, maximized: bool) -> u32 {
    const SC_MINIMIZE: u32 = 0xF020;
    const SC_MAXIMIZE: u32 = 0xF030;
    const SC_RESTORE: u32 = 0xF120;
    const SC_CLOSE: u32 = 0xF060;
    match button {
        Button::Min => SC_MINIMIZE,
        Button::Max if maximized => SC_RESTORE,
        Button::Max => SC_MAXIMIZE,
        Button::Close => SC_CLOSE,
    }
}

/// Gives an app window (main, detached) its caption buttons: the hit-test child on Windows, whose pointer reports go to that
/// window's page as `window:caption` and whose clicks run as system commands. Nothing on macOS (traffic lights, W2).
pub fn install(window: &tauri::WebviewWindow, ctx: &std::sync::Arc<crate::context::AppContext>) {
    #[cfg(windows)]
    {
        let label = window.label().to_string();
        let ctx = ctx.clone();
        let Ok(hwnd) = window.hwnd() else { return };
        let parent = hwnd.0 as isize;
        win::attach(window, move |event| match event {
            CaptionEvent::Pointer { hover, pressed } => {
                ctx.events.emit(unimux_ipc::Scope::Window(label.clone()), "window:caption", vec![pointer_json(hover, pressed)]);
            }
            CaptionEvent::Click(button) => system_command(parent, button),
        });
    }
    #[cfg(not(windows))]
    let _ = (window, ctx);
}

/// Runs a button's click on the window (posted: the window procedure handles it like a click on a system caption button).
#[cfg(windows)]
pub fn system_command(parent: isize, button: Button) {
    use windows::Win32::Foundation::{HWND, LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{IsZoomed, PostMessageW, WM_SYSCOMMAND};
    let hwnd = HWND(parent as *mut _);
    // SAFETY: a query and a posted message on the app's own top-level window.
    unsafe {
        let command = click_command(button, IsZoomed(hwnd).as_bool());
        let _ = PostMessageW(Some(hwnd), WM_SYSCOMMAND, WPARAM(command as usize), LPARAM(0));
    }
}

/// `window:minimize` / `window:toggleMaximize` / `window:close` from a page: the same system commands as the buttons.
pub fn run_button(window: &tauri::WebviewWindow, button: Button) {
    #[cfg(windows)]
    if let Ok(hwnd) = window.hwnd() {
        system_command(hwnd.0 as isize, button);
    }
    #[cfg(not(windows))]
    {
        let _ = match button {
            Button::Min => window.minimize(),
            Button::Max if window.is_maximized().unwrap_or(false) => window.unmaximize(),
            Button::Max => window.maximize(),
            Button::Close => window.close(),
        };
    }
}

/// `window:captionArea`: the page's button rects (`null`: none). Ignored when not sane (a page cannot cover the window).
pub fn set_area_from_page(window: &tauri::WebviewWindow, value: &serde_json::Value) {
    let area = if value.is_null() { None } else { serde_json::from_value::<Area>(value.clone()).ok().filter(Area::is_sane) };
    if !value.is_null() && area.is_none() {
        return;
    }
    #[cfg(windows)]
    win::set_area(window, area);
    #[cfg(not(windows))]
    let _ = (window, area);
}

#[cfg(all(windows, feature = "test-bridge"))]
pub use win::probe;

#[cfg(test)]
mod tests {
    use super::*;

    fn area() -> Area {
        // 100 % at a 1100 px client: Electron's map (minimize 963..1008, maximize 1008..1054, close 1054..1100, rows 1..36).
        Area {
            min: Rect { x: 963, y: 1, width: 45, height: 35 },
            max: Rect { x: 1008, y: 1, width: 46, height: 35 },
            close: Rect { x: 1054, y: 1, width: 46, height: 35 },
        }
    }

    #[test]
    fn hit_test_matches_the_1_1_4_map() {
        let a = area();
        assert_eq!(a.hit(1099, 1), Some(Button::Close));
        assert_eq!(a.hit(1054, 20), Some(Button::Close));
        assert_eq!(a.hit(1053, 20), Some(Button::Max));
        assert_eq!(a.hit(1008, 35), Some(Button::Max));
        assert_eq!(a.hit(1007, 35), Some(Button::Min));
        assert_eq!(a.hit(963, 10), Some(Button::Min));
        assert_eq!(a.hit(962, 10), None);
        assert_eq!(a.hit(1050, 0), None, "row 0 stays the top resize edge");
        assert_eq!(a.hit(1050, 36), None, "below the 36 DIP caption is the page");
        assert_eq!(a.bounds(), Rect { x: 963, y: 1, width: 137, height: 35 });
        // 125 %: the page's close button reaches one pixel past a 1399 px client; the child stays inside.
        let wide = Rect { x: 1229, y: 2, width: 171, height: 43 };
        assert_eq!(wide.clamped(1399, 889), Rect { x: 1229, y: 2, width: 170, height: 43 });
        assert_eq!(wide.clamped(1000, 889), Rect { x: 1000, y: 2, width: 0, height: 43 });
        assert_eq!(Button::Max.hit_code(), 9);
        assert!(a.is_sane());
        let mut huge = a;
        huge.min.width = 5000;
        assert!(!huge.is_sane());
    }

    #[test]
    fn clicks_run_the_system_commands_of_1_1_4() {
        assert_eq!(click_command(Button::Min, false), 0xF020);
        assert_eq!(click_command(Button::Max, false), 0xF030);
        assert_eq!(click_command(Button::Max, true), 0xF120);
        assert_eq!(click_command(Button::Close, true), 0xF060);
        assert_eq!(pointer_json(Some(Button::Max), None), serde_json::json!({ "hover": "max", "pressed": null }));
        assert_eq!(pointer_json(None, Some(Button::Close)), serde_json::json!({ "hover": null, "pressed": "close" }));
    }

    #[test]
    fn page_areas_are_checked() {
        let ok: Area = serde_json::from_value(serde_json::json!({
            "min": { "x": 963, "y": 1, "width": 45, "height": 35 },
            "max": { "x": 1008, "y": 1, "width": 46, "height": 35 },
            "close": { "x": 1054, "y": 1, "width": 46, "height": 35 },
        }))
        .unwrap();
        assert!(ok.is_sane());
        assert!(serde_json::from_value::<Area>(serde_json::json!({ "min": 1 })).is_err());
        let mut negative = ok;
        negative.close.width = -1;
        assert!(!negative.is_sane());
    }

    #[test]
    fn pointer_follows_views_button() {
        let mut p = Pointer::default();
        p.moved(Some(Button::Max));
        assert_eq!(p.view(), (Some(Button::Max), None));
        p.pressed(Some(Button::Max));
        assert_eq!(p.view(), (None, Some(Button::Max)));
        // Dragged off: not shown pressed, and no hover on the other button while held.
        p.moved(Some(Button::Close));
        assert_eq!(p.view(), (None, None));
        p.moved(Some(Button::Max));
        assert_eq!(p.view(), (None, Some(Button::Max)));
        // Leaving while held keeps the hold (the capture brings the release).
        p.left();
        assert_eq!(p.view(), (None, Some(Button::Max)));
        assert_eq!(p.released(Some(Button::Max)), Some(Button::Max));
        assert_eq!(p.view(), (Some(Button::Max), None));
        // Released elsewhere: no click.
        p.pressed(Some(Button::Close));
        assert_eq!(p.released(None), None);
        assert_eq!(p.view(), (None, None));
        p.pressed(Some(Button::Min));
        p.cancelled();
        assert_eq!(p.view(), (None, None));
        p.moved(Some(Button::Min));
        p.left();
        assert_eq!(p.view(), (None, None));
    }
}
