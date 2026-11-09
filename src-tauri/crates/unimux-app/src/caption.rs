//! W1: the caption buttons and the top resize edge of a window without a system title bar (Windows). The page draws the
//! buttons like 1.1.4's Electron overlay (src/renderer/src/captionPaint.ts); this module puts two small transparent child
//! windows over the top of the window (no redirection bitmap, so they show nothing):
//!
//! - the buttons child answers WM_NCHITTEST with HTMINBUTTON / HTMAXBUTTON / HTCLOSE like Electron's frame did. Windows then
//!   treats the area as real caption buttons: the Windows 11 snap layouts open from the maximize button. It tracks hover and
//!   press (views::Button of 1.1.4), reports them to the page, which paints the states, and runs the click (minimize,
//!   maximize / restore, close) as the system command. The same technique as Windows Terminal's drag bar window.
//! - the top edge child answers HTTOPLEFT / HTTOP / HTTOPRIGHT along the top of a restored window, as tall as 1.1.4's
//!   (Electron's FrameTopBorderThickness: the frame plus the padded border), and hands a press to the window (resize loop).
//!
//! Both are laid out here, natively, from the client rect, the window's DPI and its maximized state on every WM_SIZE and
//! WM_DPICHANGED ([`layout`] and [`top_edge`] are ports of captionLayout / captionHitRects and Electron's top border): the
//! buttons work before the page has booted, after a renderer crash and while the renderer is busy. The page only paints; the
//! rects it reports (`window:captionArea`) are a cross-check that is logged when it differs.
//!
//! The drag region (HTCAPTION: move, Aero snap, double-click maximize) comes from WebView2's non-client region support
//! (`-webkit-app-region: drag` in the page, `IsNonClientRegionSupportEnabled` in windows.rs). WebView2 forwards only the
//! WM_NCRBUTTONUP of a right click there, and DefWindowProc would not open the system menu for it (its own hit test sees
//! client area), so the window's subclass opens the system menu itself, as Windows Terminal does.

#![cfg_attr(not(windows), allow(dead_code))]

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
            Button::Min => HT_MINBUTTON,
            Button::Max => HT_MAXBUTTON,
            Button::Close => HT_CLOSE,
        }
    }
}

#[cfg(test)]
pub const HT_CAPTION: i32 = 2;
pub const HT_MINBUTTON: i32 = 8;
pub const HT_MAXBUTTON: i32 = 9;
pub const HT_TOP: i32 = 12;
pub const HT_TOPLEFT: i32 = 13;
pub const HT_TOPRIGHT: i32 = 14;
pub const HT_CLOSE: i32 = 20;

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

/// The hit areas of the three buttons (`CaptionArea` in src/shared/caption.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub struct Area {
    pub min: Rect,
    pub max: Rect,
    pub close: Rect,
}

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
    /// Every rect inside (0, 0)..(width, height).
    pub fn clamped(&self, width: i32, height: i32) -> Area {
        Area {
            min: self.min.clamped(width, height),
            max: self.max.clamped(width, height),
            close: self.close.clamped(width, height),
        }
    }
    /// The buttons child's rect: the union of the buttons (they touch, so the union has no gaps).
    pub fn bounds(&self) -> Rect {
        let rects = Button::ALL.map(|b| self.rect(b));
        let x = rects.iter().map(|r| r.x).min().unwrap_or(0);
        let y = rects.iter().map(|r| r.y).min().unwrap_or(0);
        let right = rects.iter().map(|r| r.right()).max().unwrap_or(0);
        let bottom = rects.iter().map(|r| r.bottom()).max().unwrap_or(0);
        Rect { x, y, width: right - x, height: bottom - y }
    }
}

/// Electron's caption button container (win_frame_view.cc, win_caption_button_container.cc): 36 DIP high, 137 DIP wide.
const CAPTION_HEIGHT_DIP: f64 = 36.0;
const CONTAINER_WIDTH_DIP: f64 = 137.0;
/// (button, x in the container, width with the 1 DIP gap left of it) in DIP.
const BUTTONS_DIP: [(Button, f64, f64); 3] = [(Button::Min, 0.0, 45.0), (Button::Max, 45.0, 46.0), (Button::Close, 91.0, 46.0)];
/// The top corners that resize diagonally: views::kResizeAreaCornerSize (16) minus the 4 DIP frame border; the 1.1.4 map has
/// it at 12 DIP at all four scales.
const RESIZE_CORNER_DIP: f64 = 12.0;
const EPS: f64 = 1e-9;

/// The first pixel at or past a DIP position (Chromium floors a pixel's DIP position for its hit tests).
fn px(dip: f64, scale: f64) -> i32 {
    (dip * scale - EPS).ceil() as i32
}

/// The window's width in DIP (the pixel width divided by the scale, rounded up), as Electron lays out the container.
fn width_dip(scale: f64, client_width: i32) -> f64 {
    (f64::from(client_width) / scale - EPS).ceil()
}

/// The hit areas of the buttons in client pixels (captionLayout + captionHitRects of captionPaint.ts): the container at the
/// right edge of the DIP width, from 1 DIP below the top (at the top when maximized) down to 36 DIP; a pixel is in a button
/// when its floored DIP position is. Clipped to the client width.
pub fn layout(scale: f64, client_width: i32, maximized: bool) -> Area {
    let container = width_dip(scale, client_width) - CONTAINER_WIDTH_DIP;
    let right = client_width.min((width_dip(scale, client_width) * scale + 0.5).floor() as i32);
    let y = px(if maximized { 0.0 } else { 1.0 }, scale);
    let bottom = px(CAPTION_HEIGHT_DIP, scale);
    let rect = |b: Button| {
        let (_, x, w) = BUTTONS_DIP.iter().copied().find(|(k, ..)| *k == b).unwrap_or((b, 0.0, 0.0));
        let x0 = px(container + x, scale);
        let x1 = px(container + x + w, scale).min(right);
        Rect { x: x0, y, width: (x1 - x0).max(0), height: (bottom - y).max(0) }
    };
    Area { min: rect(Button::Min), max: rect(Button::Max), close: rect(Button::Close) }
}

/// The top resize edge of a restored window in client pixels: rows `0..height`, diagonal left of `left` and from `right`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TopEdge {
    pub height: i32,
    pub left: i32,
    pub right: i32,
}

impl TopEdge {
    /// HTTOPLEFT / HTTOP / HTTOPRIGHT at a column of the edge.
    pub fn hit(&self, x: i32) -> i32 {
        if x < self.left {
            HT_TOPLEFT
        } else if x >= self.right {
            HT_TOPRIGHT
        } else {
            HT_TOP
        }
    }
}

/// Electron's top border (WinFrameView::FrameTopBorderThickness): `frame_px` (SM_CXSIZEFRAME + SM_CXPADDEDBORDER at the
/// window's DPI) floored to DIP; a row is in it when its floored DIP position is. The corners are 12 DIP wide.
pub fn top_edge(scale: f64, client_width: i32, frame_px: i32) -> TopEdge {
    let thickness = (f64::from(frame_px) / scale + EPS).floor();
    TopEdge {
        height: px(thickness, scale),
        left: px(RESIZE_CORNER_DIP, scale),
        right: px(width_dip(scale, client_width) - RESIZE_CORNER_DIP, scale),
    }
}

/// What Windows answers at a client point of the caption strip with both children in place (the buttons over the edge):
/// None where the page answers (its drag region, HTCAPTION, or client area). The tests check it against 1.1.4's map.
#[cfg(test)]
pub fn native_hit(area: &Area, edge: Option<&TopEdge>, x: i32, y: i32) -> Option<i32> {
    if let Some(b) = area.hit(x, y) {
        return Some(b.hit_code());
    }
    edge.filter(|e| y >= 0 && y < e.height).map(|e| e.hit(x))
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
    /// The capture went elsewhere (another window took it, Alt+Tab), or the window was minimized or hidden: nothing is
    /// held or hovered any more.
    pub fn cancelled(&mut self) {
        self.down = None;
        self.over_down = false;
        self.hover = None;
    }
}

/// What the buttons child reports to the app.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptionEvent {
    Pointer { hover: Option<Button>, pressed: Option<Button> },
    Click(Button),
}

pub const SC_SIZE: u32 = 0xF000;
pub const SC_MOVE: u32 = 0xF010;
pub const SC_MINIMIZE: u32 = 0xF020;
pub const SC_MAXIMIZE: u32 = 0xF030;
pub const SC_CLOSE: u32 = 0xF060;
pub const SC_RESTORE: u32 = 0xF120;

/// The system menu's items and whether each is enabled, as Windows sets them for a captioned window (and Windows
/// Terminal's NonClientIslandWindow::_OpenSystemMenu for its own title bar): Restore when maximized or minimized, Move and
/// Size only for a restored window, Minimize unless minimized, Maximize unless maximized, Close always.
pub fn menu_states(maximized: bool, minimized: bool) -> [(u32, bool); 6] {
    let restored = !maximized && !minimized;
    [
        (SC_RESTORE, !restored),
        (SC_MOVE, restored),
        (SC_SIZE, restored),
        (SC_MINIMIZE, !minimized),
        (SC_MAXIMIZE, !maximized),
        (SC_CLOSE, true),
    ]
}

/// The system command a click runs (Chromium's HWNDMessageHandler sends the same for 1.1.4's buttons: SC_MINIMIZE,
/// SC_MAXIMIZE or SC_RESTORE, and SC_CLOSE, which ends as WM_CLOSE).
pub fn click_command(button: Button, maximized: bool) -> u32 {
    match button {
        Button::Min => SC_MINIMIZE,
        Button::Max if maximized => SC_RESTORE,
        Button::Max => SC_MAXIMIZE,
        Button::Close => SC_CLOSE,
    }
}

/// The pointer report of `window:caption` (`CaptionPointer` in src/shared/caption.ts).
pub fn pointer_json(hover: Option<Button>, pressed: Option<Button>) -> serde_json::Value {
    serde_json::json!({ "hover": hover.map(Button::id), "pressed": pressed.map(Button::id) })
}

/// The accessible names the page sends with its area (`{min, max, close}`, through tr()): the buttons child's window text.
pub fn labels_text(value: Option<&serde_json::Value>) -> Option<String> {
    let v = value?;
    let names: Vec<&str> = ["min", "max", "close"]
        .iter()
        .filter_map(|k| v.get(*k).and_then(serde_json::Value::as_str))
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();
    (names.len() == 3).then(|| names.join(", ").chars().take(200).collect())
}

#[cfg(windows)]
mod win {
    use std::cell::Cell;
    use std::panic::{AssertUnwindSafe, catch_unwind};
    use std::sync::Once;

    use tauri::WebviewWindow;
    use windows::Win32::Foundation::{HWND, LPARAM, LRESULT, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{MapWindowPoints, ScreenToClient};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::UI::HiDpi::{GetDpiForWindow, GetSystemMetricsForDpi};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        ReleaseCapture, SetCapture, TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT, TrackMouseEvent,
    };
    use windows::Win32::UI::Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass};
    use windows::Win32::UI::WindowsAndMessaging::{
        CS_DBLCLKS, CreateWindowExW, DefWindowProcW, DestroyWindow, EnableMenuItem, GWL_STYLE, GWLP_USERDATA, GetClientRect,
        GetSystemMenu, GetWindowLongPtrW, HTCAPTION, HTTRANSPARENT, HWND_TOP, IDC_ARROW, IsIconic, IsWindow, IsZoomed, LWA_ALPHA,
        LoadCursorW, MF_BYCOMMAND, MF_ENABLED, MF_GRAYED, PostMessageW, RegisterClassExW, SIZE_MINIMIZED, SM_CXPADDEDBORDER,
        SM_CXSIZEFRAME, SWP_HIDEWINDOW, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SetLayeredWindowAttributes,
        SetMenuDefaultItem, SetWindowLongPtrW, SetWindowPos, SetWindowTextW, TPM_RETURNCMD, TPM_RIGHTBUTTON, TrackPopupMenu,
        WM_APP, WM_CAPTURECHANGED, WM_DPICHANGED, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDBLCLK,
        WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_NCRBUTTONDOWN, WM_NCRBUTTONUP, WM_SHOWWINDOW,
        WM_SIZE, WM_SYSCOMMAND, WNDCLASS_STYLES, WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS, WS_EX_LAYERED,
        WS_EX_NOREDIRECTIONBITMAP, WS_THICKFRAME,
    };
    use windows::core::{HSTRING, PCWSTR, w};

    use super::{Area, Button, CaptionEvent, Pointer, TopEdge, layout, menu_states, top_edge};

    /// Posted to the buttons child after the parent was sized: both children back on top of their siblings. Tauri's
    /// undecorated-resize window (tauri-runtime-wry undecorated_resizing.rs) raises itself on every WM_SIZE with an
    /// asynchronous SetWindowPos, so ours is posted after it.
    const WM_RAISE: u32 = WM_APP + 0x31;
    /// Posted to the buttons child when the window was minimized or hidden: no hover or press stays painted.
    const WM_POINTER_GONE: u32 = WM_APP + 0x32;
    const SUBCLASS_ID: usize = 0x5731_0001;

    type Handler = Box<dyn Fn(CaptionEvent) + Send + 'static>;

    /// The caption of one top-level window. Owned by the parent's subclass (reference data), freed in the parent's
    /// WM_NCDESTROY after both children are gone; the children keep a non-owning pointer in GWLP_USERDATA. UI thread only.
    /// Only shared references are ever made (every field is a Cell), so a window procedure re-entered by a Win32 call
    /// (SetWindowPos, ReleaseCapture) never aliases a `&mut`.
    struct Caption {
        parent: HWND,
        buttons: Cell<HWND>,
        edge: Cell<HWND>,
        area: Cell<Option<Area>>,
        top: Cell<Option<TopEdge>>,
        pointer: Cell<Pointer>,
        tracking: Cell<bool>,
        /// Check builds: the scale the page was fixed to (SetRasterizationScale), instead of the window's DPI.
        scale_override: Cell<Option<f64>>,
        /// The page's last reported area (cross-check only) and whether a difference was logged already.
        page_area: Cell<Option<Area>>,
        mismatch_logged: Cell<bool>,
        /// Queues the event (never runs app code inside the window procedure).
        handler: Handler,
    }

    impl Caption {
        fn report(&self) {
            let (hover, pressed) = self.pointer.get().view();
            self.send(CaptionEvent::Pointer { hover, pressed });
        }
        fn send(&self, event: CaptionEvent) {
            // A panic must not unwind out of an extern "system" fn (it would abort the app).
            let _ = catch_unwind(AssertUnwindSafe(|| (self.handler)(event)));
        }
        fn update_pointer(&self, f: impl FnOnce(&mut Pointer)) -> bool {
            let mut p = self.pointer.get();
            let before = p.view();
            f(&mut p);
            self.pointer.set(p);
            p.view() != before
        }
        fn scale(&self) -> (f64, u32) {
            // SAFETY: a query on our own window.
            let dpi = unsafe { GetDpiForWindow(self.parent) }.max(96);
            match self.scale_override.get() {
                Some(s) => (s, (96.0 * s).round() as u32),
                None => (f64::from(dpi) / 96.0, dpi),
            }
        }
    }

    static REGISTER: Once = Once::new();
    const BUTTONS_CLASS: PCWSTR = w!("UNIMUX_CAPTION_BUTTONS");
    const EDGE_CLASS: PCWSTR = w!("UNIMUX_CAPTION_TOP_EDGE");

    unsafe fn caption_of<'a>(hwnd: HWND) -> Option<&'a Caption> {
        // SAFETY: GWLP_USERDATA of our children holds the parent's Caption pointer (or 0), valid until the parent's
        // WM_NCDESTROY, which comes after the children's.
        unsafe { (GetWindowLongPtrW(hwnd, GWLP_USERDATA) as *const Caption).as_ref() }
    }

    /// The Caption of a top-level window, from its subclass (UI thread only; None before attach or after destroy).
    unsafe fn caption_of_parent<'a>(parent: HWND) -> Option<&'a Caption> {
        let mut data = 0usize;
        // SAFETY: our own subclass's reference data is the Caption pointer.
        unsafe {
            if !GetWindowSubclass(parent, Some(parent_proc), SUBCLASS_ID, Some(&mut data)).as_bool() {
                return None;
            }
            (data as *const Caption).as_ref()
        }
    }

    /// Runs `f` with the window's Caption on its UI thread.
    fn with_caption(window: &WebviewWindow, f: impl FnOnce(&Caption) + Send + 'static) {
        let Ok(parent) = window.hwnd() else { return };
        let parent = parent.0 as isize;
        let _ = window.run_on_main_thread(move || {
            // SAFETY: on the UI thread that owns the window.
            if let Some(c) = unsafe { caption_of_parent(HWND(parent as *mut _)) } {
                f(c);
            }
        });
    }

    unsafe extern "system" fn parent_proc(
        hwnd: HWND,
        msg: u32,
        wparam: WPARAM,
        lparam: LPARAM,
        _id: usize,
        data: usize,
    ) -> LRESULT {
        // SAFETY: the subclass of our own window; `data` is the Caption pointer until WM_NCDESTROY frees it below.
        unsafe {
            // A right click on the title bar: WebView2's non-client region forwards only the WM_NCRBUTTONUP (HTCAPTION), and
            // DefWindowProc's own hit test sees client area there, so no system menu would open: it is opened here.
            if msg == WM_NCRBUTTONUP && wparam.0 as u32 == HTCAPTION {
                let p = point(lparam);
                open_system_menu(hwnd, p.x, p.y);
                return LRESULT(0);
            }
            if msg == WM_NCDESTROY {
                let result = DefSubclassProc(hwnd, msg, wparam, lparam);
                let _ = RemoveWindowSubclass(hwnd, Some(parent_proc), SUBCLASS_ID);
                let ptr = data as *mut Caption;
                if !ptr.is_null() {
                    for child in [(*ptr).buttons.get(), (*ptr).edge.get()] {
                        if IsWindow(Some(child)).as_bool() {
                            SetWindowLongPtrW(child, GWLP_USERDATA, 0);
                        }
                    }
                    drop(Box::from_raw(ptr));
                }
                return result;
            }
            let result = DefSubclassProc(hwnd, msg, wparam, lparam);
            let Some(caption) = (data as *const Caption).as_ref() else { return result };
            match msg {
                WM_SIZE if wparam.0 as u32 == SIZE_MINIMIZED => {
                    let _ = PostMessageW(Some(caption.buttons.get()), WM_POINTER_GONE, WPARAM(0), LPARAM(0));
                }
                WM_SIZE | WM_DPICHANGED => {
                    relayout(caption);
                    let _ = PostMessageW(Some(caption.buttons.get()), WM_RAISE, WPARAM(0), LPARAM(0));
                }
                WM_SHOWWINDOW if wparam.0 == 0 => {
                    let _ = PostMessageW(Some(caption.buttons.get()), WM_POINTER_GONE, WPARAM(0), LPARAM(0));
                }
                _ => {}
            }
            result
        }
    }

    /// The system menu at a screen point, with the items a captioned window has in its state; the chosen command is posted
    /// to the window (Windows Terminal's NonClientIslandWindow::_OpenSystemMenu).
    unsafe fn open_system_menu(hwnd: HWND, x: i32, y: i32) {
        // SAFETY: the window's own system menu; TrackPopupMenu runs a modal loop, nothing of the Caption is held over it.
        unsafe {
            let menu = GetSystemMenu(hwnd, false);
            if menu.is_invalid() {
                return;
            }
            let (maximized, minimized) = (IsZoomed(hwnd).as_bool(), IsIconic(hwnd).as_bool());
            for (command, enabled) in menu_states(maximized, minimized) {
                let _ = EnableMenuItem(menu, command, MF_BYCOMMAND | if enabled { MF_ENABLED } else { MF_GRAYED });
            }
            let _ = SetMenuDefaultItem(menu, super::SC_CLOSE, 0);
            #[cfg(feature = "test-bridge")]
            if seam::record_menu(menu, x, y) {
                return;
            }
            let command = TrackPopupMenu(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON, x, y, None, hwnd, None).0;
            if command != 0 {
                let _ = PostMessageW(Some(hwnd), WM_SYSCOMMAND, WPARAM(command as usize), LPARAM(0));
            }
        }
    }

    /// Lays both children out from the client rect, the DPI and the maximized state (the page is not needed).
    unsafe fn relayout(c: &Caption) {
        // SAFETY: queries and moves of our own windows on their UI thread.
        unsafe {
            let mut client = RECT::default();
            if GetClientRect(c.parent, &mut client).is_err() || client.right <= 0 || IsIconic(c.parent).as_bool() {
                return;
            }
            let (scale, metrics_dpi) = c.scale();
            let maximized = IsZoomed(c.parent).as_bool();
            let area = layout(scale, client.right, maximized);
            c.area.set(Some(area));
            let resizable = (GetWindowLongPtrW(c.parent, GWL_STYLE) as u32 & WS_THICKFRAME.0) != 0;
            let top = (!maximized && resizable).then(|| {
                let frame =
                    GetSystemMetricsForDpi(SM_CXSIZEFRAME, metrics_dpi) + GetSystemMetricsForDpi(SM_CXPADDEDBORDER, metrics_dpi);
                top_edge(scale, client.right, frame)
            });
            c.top.set(top);
            match top {
                Some(t) => {
                    let _ =
                        SetWindowPos(c.edge.get(), Some(HWND_TOP), 0, 0, client.right, t.height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
                }
                None => {
                    let _ =
                        SetWindowPos(c.edge.get(), None, 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_HIDEWINDOW);
                }
            }
            // Kept inside the client area (at 125 / 150 percent the layout may reach one pixel past it).
            let b = area.bounds().clamped(client.right, client.bottom);
            let _ = SetWindowPos(c.buttons.get(), Some(HWND_TOP), b.x, b.y, b.width, b.height, SWP_NOACTIVATE | SWP_SHOWWINDOW);
        }
    }

    unsafe fn raise(c: &Caption) {
        // SAFETY: z-order changes of our own children.
        unsafe {
            if c.top.get().is_some() {
                let _ = SetWindowPos(c.edge.get(), Some(HWND_TOP), 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
            }
            let _ = SetWindowPos(c.buttons.get(), Some(HWND_TOP), 0, 0, 0, 0, SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE);
        }
    }

    /// Puts the caption children on `window` (once per window handle: a window re-created under the same label gets its
    /// own); `handler` gets the pointer reports and the clicks on the UI thread and must only hand them on.
    pub fn attach(window: &WebviewWindow, handler: impl Fn(CaptionEvent) + Send + 'static) {
        let Ok(parent) = window.hwnd() else { return };
        let parent = parent.0 as isize;
        let handler: Handler = Box::new(handler);
        let _ = window.run_on_main_thread(move || {
            let parent = HWND(parent as *mut _);
            // SAFETY: on the UI thread that owns `parent`; ownership of the Caption is described at the type.
            unsafe {
                if !IsWindow(Some(parent)).as_bool() || caption_of_parent(parent).is_some() {
                    return;
                }
                let caption = Box::into_raw(Box::new(Caption {
                    parent,
                    buttons: Cell::new(HWND::default()),
                    edge: Cell::new(HWND::default()),
                    area: Cell::new(None),
                    top: Cell::new(None),
                    pointer: Cell::new(Pointer::default()),
                    tracking: Cell::new(false),
                    scale_override: Cell::new(None),
                    page_area: Cell::new(None),
                    mismatch_logged: Cell::new(false),
                    handler,
                }));
                let buttons = create_child(parent, BUTTONS_CLASS, caption);
                let edge = create_child(parent, EDGE_CLASS, caption);
                let (Some(buttons), Some(edge)) = (buttons, edge) else {
                    for child in [buttons, edge].into_iter().flatten() {
                        SetWindowLongPtrW(child, GWLP_USERDATA, 0);
                        let _ = DestroyWindow(child);
                    }
                    drop(Box::from_raw(caption));
                    return;
                };
                (*caption).buttons.set(buttons);
                (*caption).edge.set(edge);
                if !SetWindowSubclass(parent, Some(parent_proc), SUBCLASS_ID, caption as usize).as_bool() {
                    for child in [buttons, edge] {
                        SetWindowLongPtrW(child, GWLP_USERDATA, 0);
                        let _ = DestroyWindow(child);
                    }
                    drop(Box::from_raw(caption));
                    return;
                }
                relayout(&*caption);
            }
        });
    }

    /// The page's area (a cross-check of the native layout: a difference is logged once per window) and its accessible
    /// names for the buttons child.
    pub fn page_area(window: &WebviewWindow, area: Option<Area>, labels: Option<String>, log: impl Fn(&str) + Send + 'static) {
        let label = window.label().to_string();
        with_caption(window, move |c| {
            // The page knows the client width only to a pixel at fractional scales (its viewport width is fractional), so
            // its rects can reach one pixel past the client: compared inside the client, as the native child is placed.
            let mut client = RECT::default();
            // SAFETY: a query of our own window.
            let area = if unsafe { GetClientRect(c.parent, &mut client) }.is_ok() {
                area.map(|a| a.clamped(client.right, client.bottom))
            } else {
                area
            };
            c.page_area.set(area);
            if let Some(text) = labels {
                // SAFETY: our own child.
                let _ = unsafe { SetWindowTextW(c.buttons.get(), &HSTRING::from(text)) };
            }
            if let (Some(page), Some(native)) = (area, c.area.get())
                && page != native
                && !c.mismatch_logged.replace(true)
            {
                log(&format!(
                    "caption: the page's button rects of {label} differ from the native layout: {page:?} vs {native:?}"
                ));
            }
        });
    }

    /// Check builds: the native layout follows the page's fixed rasterization scale (None: the window's DPI again).
    #[cfg(feature = "test-bridge")]
    pub fn set_scale_override(window: &WebviewWindow, scale: Option<f64>) {
        with_caption(window, move |c| {
            c.scale_override.set(scale);
            // SAFETY: UI thread.
            unsafe { relayout(c) };
        });
    }

    /// Check builds: both children of a window, their rects in the parent's client pixels, the layout and the page's area.
    #[cfg(feature = "test-bridge")]
    pub fn probe(window: &WebviewWindow, reply: impl FnOnce(serde_json::Value) + Send + 'static) {
        use windows::Win32::UI::WindowsAndMessaging::{GWL_EXSTYLE, GetWindowRect, GetWindowTextW, IsWindowVisible};
        let Ok(parent) = window.hwnd() else {
            reply(serde_json::json!({ "child": null }));
            return;
        };
        let parent = parent.0 as isize;
        let _ = window.run_on_main_thread(move || {
            let parent = HWND(parent as *mut _);
            // SAFETY: read-only queries of our own windows on their UI thread.
            let out = unsafe {
                match caption_of_parent(parent) {
                    None => serde_json::json!({ "child": null }),
                    Some(c) => {
                        let place = |hwnd: HWND| {
                            let mut r = RECT::default();
                            let _ = GetWindowRect(hwnd, &mut r);
                            let mut tl = POINT { x: r.left, y: r.top };
                            let _ = ScreenToClient(parent, &mut tl);
                            serde_json::json!([tl.x, tl.y, r.right - r.left, r.bottom - r.top])
                        };
                        let rect = |x: super::Rect| serde_json::json!([x.x, x.y, x.width, x.height]);
                        let area = |a: Option<Area>| {
                            a.map(|a| serde_json::json!({ "min": rect(a.min), "max": rect(a.max), "close": rect(a.close) }))
                        };
                        let mut text = [0u16; 256];
                        let n = GetWindowTextW(c.buttons.get(), &mut text);
                        let ex = GetWindowLongPtrW(c.buttons.get(), GWL_EXSTYLE) as u32;
                        serde_json::json!({
                            "child": c.buttons.get().0 as isize,
                            "edge": c.edge.get().0 as isize,
                            "parent": parent.0 as isize,
                            "visible": IsWindowVisible(c.buttons.get()).as_bool(),
                            "rect": place(c.buttons.get()),
                            "edgeVisible": IsWindowVisible(c.edge.get()).as_bool(),
                            "edgeRect": place(c.edge.get()),
                            "top": c.top.get().map(|t| serde_json::json!({ "height": t.height, "left": t.left, "right": t.right })),
                            "area": area(c.area.get()),
                            "pageArea": area(c.page_area.get()),
                            "pageMatches": c.page_area.get().map(|p| Some(p) == c.area.get()),
                            "scale": c.scale().0,
                            "layered": ex & WS_EX_LAYERED.0 != 0,
                            "exStyle": ex,
                            "text": String::from_utf16_lossy(&text[..n.max(0) as usize]),
                        })
                    }
                }
            };
            reply(out);
        });
    }

    unsafe fn create_child(parent: HWND, class: PCWSTR, caption: *const Caption) -> Option<HWND> {
        // SAFETY: plain Win32 calls. The window is created without the state and gets the (non-owning) pointer only after
        // a successful creation, so no failure path can leave the state half-owned.
        unsafe {
            let instance = GetModuleHandleW(None).ok()?;
            REGISTER.call_once(|| {
                for (name, proc_, style) in [
                    (
                        BUTTONS_CLASS,
                        buttons_proc as unsafe extern "system" fn(HWND, u32, WPARAM, LPARAM) -> LRESULT,
                        WNDCLASS_STYLES(0),
                    ),
                    (EDGE_CLASS, edge_proc, CS_DBLCLKS),
                ] {
                    let class = WNDCLASSEXW {
                        cbSize: size_of::<WNDCLASSEXW>() as u32,
                        style,
                        lpfnWndProc: Some(proc_),
                        hInstance: instance.into(),
                        hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
                        lpszClassName: name,
                        ..Default::default()
                    };
                    RegisterClassExW(&class);
                }
            });
            // No redirection bitmap: the window has no pixels of its own, the page shows through. Exactly Windows
            // Terminal's drag bar styles (layered + no redirection bitmap); a system that refuses a layered child (no
            // Windows 8+ manifest entry) gets the plain one.
            for ex in [WS_EX_LAYERED | WS_EX_NOREDIRECTIONBITMAP, WS_EX_NOREDIRECTIONBITMAP] {
                if let Ok(child) = CreateWindowExW(
                    ex,
                    class,
                    w!(""),
                    WS_CHILD | WS_CLIPSIBLINGS,
                    0,
                    0,
                    0,
                    0,
                    Some(parent),
                    None,
                    Some(instance.into()),
                    None,
                ) {
                    // A layered window that never got its attributes is neither drawn nor hit-tested (clicks fall through
                    // to the page). Terminal gives its drag bar full opacity; without a redirection bitmap nothing is
                    // drawn anyway. If Windows refuses, the plain child is used instead.
                    if ex.contains(WS_EX_LAYERED)
                        && SetLayeredWindowAttributes(child, windows::Win32::Foundation::COLORREF(0), 255, LWA_ALPHA).is_err()
                    {
                        let _ = DestroyWindow(child);
                        continue;
                    }
                    SetWindowLongPtrW(child, GWLP_USERDATA, caption as isize);
                    return Some(child);
                }
            }
            None
        }
    }

    pub(super) fn point(lparam: LPARAM) -> POINT {
        POINT { x: (lparam.0 & 0xffff) as u16 as i16 as i32, y: ((lparam.0 >> 16) & 0xffff) as u16 as i16 as i32 }
    }

    /// The button under a point given in screen (`screen`) or `hwnd` client coordinates.
    unsafe fn under(hwnd: HWND, c: &Caption, p: POINT, screen: bool) -> Option<Button> {
        let area = c.area.get()?;
        let mut pts = [p];
        // SAFETY: plain coordinate conversions between our own windows.
        unsafe {
            if screen {
                let _ = ScreenToClient(c.parent, &mut pts[0]);
            } else {
                MapWindowPoints(Some(hwnd), Some(c.parent), &mut pts);
            }
        }
        area.hit(pts[0].x, pts[0].y)
    }

    /// Asks for the WM_NCMOUSELEAVE of the pointer over the buttons (Windows posts it at once when the pointer is not there).
    unsafe fn track(hwnd: HWND, c: &Caption) {
        let mut tme = TRACKMOUSEEVENT {
            cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
            dwFlags: TME_LEAVE | TME_NONCLIENT,
            hwndTrack: hwnd,
            dwHoverTime: 0,
        };
        // SAFETY: our own window.
        c.tracking.set(unsafe { TrackMouseEvent(&mut tme) }.is_ok());
    }

    unsafe extern "system" fn buttons_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        // SAFETY: the window procedure of our own class; the Caption pointer is valid while GWLP_USERDATA holds it.
        unsafe {
            if msg == WM_NCDESTROY {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            let Some(c) = caption_of(hwnd) else { return DefWindowProcW(hwnd, msg, wparam, lparam) };
            match msg {
                WM_NCHITTEST => {
                    return match under(hwnd, c, point(lparam), true) {
                        Some(b) => LRESULT(b.hit_code() as isize),
                        None => LRESULT(HTTRANSPARENT as isize),
                    };
                }
                WM_NCMOUSEMOVE => {
                    if !c.tracking.get() {
                        track(hwnd, c);
                    }
                    let under = under(hwnd, c, point(lparam), true);
                    if c.update_pointer(|p| p.moved(under)) {
                        c.report();
                    }
                    // DefWindowProc keeps the system's own handling (the snap layouts flyout over HTMAXBUTTON).
                    return DefWindowProcW(hwnd, msg, wparam, lparam);
                }
                WM_NCMOUSELEAVE => {
                    c.tracking.set(false);
                    if c.update_pointer(Pointer::left) {
                        c.report();
                    }
                    return DefWindowProcW(hwnd, msg, wparam, lparam);
                }
                WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => {
                    let b = under(hwnd, c, point(lparam), true);
                    if b.is_some() {
                        c.update_pointer(|p| p.pressed(b));
                        // The capture ends the system's leave tracking.
                        c.tracking.set(false);
                        SetCapture(hwnd);
                        c.report();
                    }
                    return LRESULT(0);
                }
                WM_MOUSEMOVE if c.pointer.get().down.is_some() => {
                    let under = under(hwnd, c, point(lparam), false);
                    if c.update_pointer(|p| p.moved(under)) {
                        c.report();
                    }
                    return LRESULT(0);
                }
                WM_LBUTTONUP | WM_NCLBUTTONUP if c.pointer.get().down.is_some() => {
                    let under = under(hwnd, c, point(lparam), msg == WM_NCLBUTTONUP);
                    let mut click = None;
                    c.update_pointer(|p| click = p.released(under));
                    // `down` is clear, so the WM_CAPTURECHANGED this sends changes nothing.
                    let _ = ReleaseCapture();
                    // Still over a button: its leave is tracked again (posted at once when the pointer is not there).
                    if c.pointer.get().hover.is_some() {
                        track(hwnd, c);
                    }
                    c.report();
                    if let Some(b) = click {
                        c.send(CaptionEvent::Click(b));
                    }
                    return LRESULT(0);
                }
                WM_CAPTURECHANGED if c.pointer.get().down.is_some() => {
                    c.update_pointer(Pointer::cancelled);
                    c.tracking.set(false);
                    c.report();
                    return LRESULT(0);
                }
                WM_POINTER_GONE => {
                    if c.update_pointer(Pointer::cancelled) {
                        c.report();
                    }
                    return LRESULT(0);
                }
                WM_RAISE => {
                    raise(c);
                    return LRESULT(0);
                }
                // Right clicks on the buttons do nothing (1.1.4's buttons took the left button only).
                WM_NCRBUTTONDOWN | WM_NCRBUTTONUP => return LRESULT(0),
                _ => {}
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
    }

    unsafe extern "system" fn edge_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        // SAFETY: as in buttons_proc.
        unsafe {
            if msg == WM_NCDESTROY {
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            let Some(c) = caption_of(hwnd) else { return DefWindowProcW(hwnd, msg, wparam, lparam) };
            match msg {
                WM_NCHITTEST => {
                    let Some(top) = c.top.get() else { return LRESULT(HTTRANSPARENT as isize) };
                    let mut p = point(lparam);
                    let _ = ScreenToClient(c.parent, &mut p);
                    return LRESULT(top.hit(p.x) as isize);
                }
                // The resize loop (and a double-click: the vertical maximize) belongs to the window, as for Tauri's own
                // resize border window: posted, so it does not run inside this procedure.
                WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK => {
                    let _ = PostMessageW(Some(c.parent), msg, wparam, lparam);
                    return LRESULT(0);
                }
                _ => {}
            }
            // WM_SETCURSOR goes to the parent with our hit code (the resize cursors).
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }
    }

    /// The check build's seam around TrackPopupMenu: while the caption guard is on, the menu is recorded (the items' states
    /// as the menu has them) instead of shown.
    #[cfg(feature = "test-bridge")]
    pub mod seam {
        use std::sync::atomic::{AtomicBool, Ordering};

        use parking_lot::Mutex;
        use serde_json::{Value, json};
        use windows::Win32::UI::WindowsAndMessaging::{
            GET_MENU_DEFAULT_ITEM_FLAGS, GetMenuDefaultItem, GetMenuState, HMENU, MF_BYCOMMAND,
        };

        pub static RECORD: AtomicBool = AtomicBool::new(false);
        pub static LOG: Mutex<Vec<Value>> = Mutex::new(Vec::new());

        pub(super) unsafe fn record_menu(menu: HMENU, x: i32, y: i32) -> bool {
            if !RECORD.load(Ordering::SeqCst) {
                return false;
            }
            const MF_GRAYED: u32 = 0x1;
            const MF_DISABLED: u32 = 0x2;
            // SAFETY: read-only queries of the window's system menu.
            let items: Vec<Value> = unsafe {
                super::menu_states(false, false)
                    .iter()
                    .map(|(command, _)| {
                        let state = GetMenuState(menu, *command, MF_BYCOMMAND);
                        json!({ "command": command, "present": state != u32::MAX, "enabled": state != u32::MAX && state & (MF_GRAYED | MF_DISABLED) == 0 })
                    })
                    .collect()
            };
            // SAFETY: as above.
            let default = unsafe { GetMenuDefaultItem(menu, 0, GET_MENU_DEFAULT_ITEM_FLAGS(0)) };
            LOG.lock().push(json!({ "msg": "systemmenu", "x": x, "y": y, "items": items, "default": default }));
            true
        }
    }
}

#[cfg(all(windows, feature = "test-bridge"))]
pub use win::{probe, seam, set_scale_override};

/// Gives an app window (main, detached) its caption buttons and top edge: the native children on Windows, whose pointer
/// reports go to that window's page as `window:caption` (queued: the window procedure never runs the emit and its
/// before-emit hooks) and whose clicks run as system commands. Nothing on macOS (traffic lights, W2).
pub fn install(window: &tauri::WebviewWindow, ctx: &std::sync::Arc<crate::context::AppContext>) {
    #[cfg(windows)]
    {
        let Ok(hwnd) = window.hwnd() else { return };
        let parent = hwnd.0 as isize;
        let label = window.label().to_string();
        let weak = std::sync::Arc::downgrade(ctx);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<CaptionEvent>();
        // One consumer per window keeps the reports in order; it ends when the window (and with it the sender) is gone.
        tauri::async_runtime::spawn(async move {
            while let Some(event) = rx.recv().await {
                let Some(ctx) = weak.upgrade() else { break };
                if let CaptionEvent::Pointer { hover, pressed } = event {
                    ctx.events.emit(
                        unimux_ipc::Scope::Window(label.clone()),
                        "window:caption",
                        vec![pointer_json(hover, pressed)],
                    );
                }
            }
        });
        win::attach(window, move |event| match event {
            CaptionEvent::Pointer { .. } => {
                let _ = tx.send(event);
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

/// `window:captionArea(area, labels?)`: the page's button rects (a cross-check of the native layout, logged when they
/// differ; they never move the hit areas) and the buttons' accessible names.
pub fn set_area_from_page(
    window: &tauri::WebviewWindow,
    ctx: &crate::context::AppContext,
    value: &serde_json::Value,
    labels: Option<&serde_json::Value>,
) {
    let area = serde_json::from_value::<Area>(value.clone()).ok();
    let text = labels_text(labels);
    #[cfg(windows)]
    {
        let crash = ctx.crash.clone();
        win::page_area(window, area, text, move |m| crash.warn(m));
    }
    #[cfg(not(windows))]
    let _ = (window, ctx, area, text);
}

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
        assert_eq!(layout(1.0, 1100, false), a);
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
        // 125 %: the layout reaches one pixel past a 1399 px client; the child stays inside.
        let wide = Rect { x: 1229, y: 2, width: 171, height: 43 };
        assert_eq!(wide.clamped(1399, 889), Rect { x: 1229, y: 2, width: 170, height: 43 });
        assert_eq!(wide.clamped(1000, 889), Rect { x: 1000, y: 2, width: 0, height: 43 });
        assert_eq!(Button::Max.hit_code(), 9);
    }

    #[test]
    fn layout_is_the_page_layout() {
        // The vectors of test/caption.test.ts ('lays the container out like Electron').
        let m = layout(1.0, 1100, true);
        assert_eq!(m.close, Rect { x: 1054, y: 0, width: 46, height: 36 });
        assert_eq!(m.min.y, 0);
        let s = layout(1.5, 1649, false);
        assert_eq!(s.min.y, 2);
        assert_eq!(s.close.y + s.close.height, 54);
        assert_eq!(s.close.x + s.close.width, 1649);
    }

    /// Every sampled pixel of 1.1.4's WM_NCHITTEST map (test/fixtures/caption/manifest.json, all four scales): the buttons,
    /// the top edge with its corner, and the page (HTCAPTION / HTCLIENT) everywhere else.
    #[test]
    fn native_layout_matches_every_code_of_the_1_1_4_map() {
        let text = std::fs::read_to_string(
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test/fixtures/caption/manifest.json"),
        )
        .expect("manifest");
        let manifest: serde_json::Value = serde_json::from_str(&text).unwrap();
        // SM_CXSIZEFRAME + SM_CXPADDEDBORDER (GetSystemMetricsForDpi at 96 / 120 / 144 / 192 DPI on Windows 11).
        let frame = |percent: &str| match percent {
            "100" => 4 + 4,
            "125" => 4 + 5,
            "150" => 5 + 6,
            "200" => 5 + 8,
            other => panic!("no frame metrics for {other}"),
        };
        let mut checked = 0;
        for (percent, s) in manifest["scales"].as_object().unwrap() {
            let scale = percent.parse::<f64>().unwrap() / 100.0;
            let width = s["client"][0].as_i64().unwrap() as i32;
            let a = layout(scale, width, false);
            let edge = top_edge(scale, width, frame(percent));
            for (row, codes) in s["hitMap"].as_object().unwrap() {
                let y: i32 = row.parse().unwrap();
                for (i, code) in codes.as_array().unwrap().iter().enumerate() {
                    let x = width - 1 - i as i32;
                    let want = code.as_i64().unwrap() as i32;
                    match native_hit(&a, Some(&edge), x, y) {
                        Some(got) => assert_eq!(got, want, "{percent}% x={x} y={y}"),
                        None => assert!(want == HT_CAPTION || want == 1, "{percent}% x={x} y={y}: 1.1.4 answered {want}"),
                    }
                    checked += 1;
                }
            }
        }
        assert!(checked > 3000, "{checked}");
        // The left corner mirrors the right one; a maximized window has no edge (native_hit with None).
        let edge = top_edge(1.0, 1100, 8);
        assert_eq!((edge.hit(0), edge.hit(11), edge.hit(12), edge.hit(1087), edge.hit(1088)), (13, 13, 12, 12, 14));
        assert_eq!(native_hit(&layout(1.0, 1100, true), None, 500, 0), None);
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
    fn system_menu_items_follow_the_window_state() {
        let on = |states: [(u32, bool); 6], c: u32| states.iter().find(|(k, _)| *k == c).unwrap().1;
        let restored = menu_states(false, false);
        assert!(!on(restored, SC_RESTORE) && on(restored, SC_MOVE) && on(restored, SC_SIZE) && on(restored, SC_MAXIMIZE));
        let maximized = menu_states(true, false);
        assert!(on(maximized, SC_RESTORE) && !on(maximized, SC_MOVE) && !on(maximized, SC_SIZE) && !on(maximized, SC_MAXIMIZE));
        assert!(on(maximized, SC_MINIMIZE) && on(maximized, SC_CLOSE));
        let minimized = menu_states(false, true);
        assert!(on(minimized, SC_RESTORE) && !on(minimized, SC_MINIMIZE) && !on(minimized, SC_MOVE));
    }

    #[test]
    fn page_areas_and_labels_are_read_defensively() {
        let ok: Area = serde_json::from_value(serde_json::json!({
            "min": { "x": 963, "y": 1, "width": 45, "height": 35 },
            "max": { "x": 1008, "y": 1, "width": 46, "height": 35 },
            "close": { "x": 1054, "y": 1, "width": 46, "height": 35 },
        }))
        .unwrap();
        assert_eq!(ok, area());
        // 125 %: the page's close button one pixel past a 1399 px client compares equal to the native layout inside it.
        let mut page = layout(1.25, 1399, false);
        page.close.width += 1;
        assert_eq!(page.clamped(1399, 889), layout(1.25, 1399, false));
        assert!(serde_json::from_value::<Area>(serde_json::json!({ "min": 1 })).is_err());
        let labels = serde_json::json!({ "min": "Minimize", "max": "Maximize", "close": "Close" });
        assert_eq!(labels_text(Some(&labels)).as_deref(), Some("Minimize, Maximize, Close"));
        assert_eq!(labels_text(Some(&serde_json::json!({ "min": "a" }))), None);
        assert_eq!(labels_text(None), None);
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
