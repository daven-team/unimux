//! The Tauri side of the detached windows: `detached-<uuid>` webview windows loading `index.html?detached=<uuid>` with the
//! main window's WebView2 settings and browser arguments (the label and query encode ids outside the label alphabet, see
//! unimux_ipc::route), placed from the DIP bounds of state.json (unimux_platform::screen; the host's space is physical
//! pixels on Windows and points on macOS), a normal-bounds tracker (Tauri has no getNormalBounds), and the screen API (monitors, work
//! areas, cursor) in DIPs.
//!
//! Window events go to the [`DetachedService`]: Moved / Resized (place saved 400 ms later), CloseRequested (held: the tab
//! goes back), Destroyed (the tab goes back unless the app is closing), page load Started / Finished.
//!
//! Runs: normal (shown at the saved place, maximized again, focused like `win.show()`), MC_OFFSCREEN (at -6000 in a cascade,
//! no taskbar button, never focused, places not saved, as 1.1.4), and `MC_DETACHED_HIDDEN=1` (check builds only, for the
//! real-app harness): the window is created at its real place but never shown, so placement and restart can be tested on
//! the real monitors without anything appearing on the desktop.

use std::collections::HashMap;
use std::sync::{Arc, Weak};

use parking_lot::Mutex;
use serde_json::Value;
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

use unimux_ipc::Scope;
use unimux_ipc::route::detached_label;
use unimux_platform::screen::{self, Monitor, Screen};
use unimux_state::detached::{DisplayArea, MIN_SIZE, Rect};

use super::{DetachedService, Host};
use crate::context::AppContext;
use crate::windows;

const BACKGROUND: tauri::window::Color = tauri::window::Color(0x0d, 0x0d, 0x0d, 0xff);

/// Check builds only: detached windows are placed for real but never shown (see the module docs).
pub fn hidden_mode() -> bool {
    #[cfg(dev_overrides)]
    {
        std::env::var("MC_DETACHED_HIDDEN").is_ok_and(|v| !v.is_empty() && v != "0")
    }
    #[cfg(not(dev_overrides))]
    {
        false
    }
}

#[derive(Default)]
struct HostWin {
    /// The window should be maximized (shown maximized; in the hidden mode only remembered).
    maximized: bool,
    /// The last outer rect (host space) while neither maximized nor minimized.
    normal: Option<screen::Rect>,
    /// The rect and maximized state the window was created with: events that still show them are the creation's own,
    /// not a move by the user (1.1.4 saved nothing before the first move).
    initial: Option<(screen::Rect, bool)>,
    shown: bool,
}

pub struct TauriHost {
    me: Weak<TauriHost>,
    app: AppHandle,
    ctx: Weak<AppContext>,
    service: Weak<DetachedService>,
    offscreen: bool,
    hidden: bool,
    windows: Arc<Mutex<HashMap<String, HostWin>>>,
}

fn to_platform(r: &Rect) -> screen::Rect {
    screen::Rect::new(r.x, r.y, r.width, r.height)
}

/// When `window:shown` is sent again after a page load (ms after the load, then after the previous send).
const SHOWN_RESEND_MS: [u64; 2] = [300, 1200];

fn to_state(r: &screen::Rect) -> Rect {
    Rect::new(r.x, r.y, r.width, r.height)
}

/// A window's rect as 1.1.4 kept it in the host's space (physical pixels on Windows, points on macOS: tao scales a window's
/// values by its current scale there, see unimux_platform::screen). 1.1.4 saved Electron's getBounds of a frameless window,
/// which is the visible window. On Windows that is the client rect of the undecorated window (W1): tao keeps invisible
/// resize borders left, right and below it, outside the visible frame, so the outer rect would be about 7 px larger on three
/// sides. On macOS the outer rect (the hidden title bar is inside it).
fn outer_rect(w: &WebviewWindow) -> Option<screen::Rect> {
    #[cfg(windows)]
    let (p, s) = (w.inner_position().ok()?, w.inner_size().ok()?);
    #[cfg(not(windows))]
    let (p, s) = (w.outer_position().ok()?, w.outer_size().ok()?);
    let r = screen::Rect::new(f64::from(p.x), f64::from(p.y), f64::from(s.width), f64::from(s.height));
    #[cfg(target_os = "macos")]
    {
        Some(screen::unscale_rect(&r, w.scale_factor().ok()?))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Some(r)
    }
}

/// What lies between the window's own rect and [`outer_rect`] where the window is now, in the host's space: on Windows the
/// invisible borders (left, top: where the visible rect starts inside the outer one; width and height: the borders
/// together), on macOS the frame (outer minus inner size) at the origin.
fn frame_insets(w: &WebviewWindow) -> (f64, f64, f64, f64) {
    let (Ok(o), Ok(i)) = (w.outer_size(), w.inner_size()) else { return (0.0, 0.0, 0.0, 0.0) };
    let (dx, dy) = (f64::from(o.width) - f64::from(i.width), f64::from(o.height) - f64::from(i.height));
    #[cfg(windows)]
    {
        let (Ok(op), Ok(ip)) = (w.outer_position(), w.inner_position()) else { return (0.0, 0.0, dx, dy) };
        (f64::from(ip.x - op.x), f64::from(ip.y - op.y), dx, dy)
    }
    #[cfg(target_os = "macos")]
    {
        let s = w.scale_factor().unwrap_or(1.0);
        if s > 0.0 { (0.0, 0.0, dx / s, dy / s) } else { (0.0, 0.0, dx, dy) }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        (0.0, 0.0, dx, dy)
    }
}

fn set_native_position(w: &WebviewWindow, x: f64, y: f64) {
    #[cfg(target_os = "macos")]
    let _ = w.set_position(tauri::LogicalPosition::new(x, y));
    #[cfg(not(target_os = "macos"))]
    let _ = w.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
}

fn set_native_inner_size(w: &WebviewWindow, width: f64, height: f64) {
    let (width, height) = (width.max(1.0), height.max(1.0));
    #[cfg(target_os = "macos")]
    let _ = w.set_size(tauri::LogicalSize::new(width, height));
    #[cfg(not(target_os = "macos"))]
    let _ = w.set_size(tauri::PhysicalSize::new(width as u32, height as u32));
}

impl TauriHost {
    pub fn new(app: AppHandle, ctx: &Arc<AppContext>) -> Arc<Self> {
        let hidden = hidden_mode();
        Arc::new_cyclic(|me| Self {
            me: me.clone(),
            app,
            ctx: Arc::downgrade(ctx),
            service: Arc::downgrade(&ctx.detached),
            offscreen: ctx.overrides.offscreen && !hidden,
            hidden,
            windows: Arc::new(Mutex::new(HashMap::new())),
        })
    }

    /// The display list now (monitors can change between two placements). Windows: physical pixels laid out as Chromium's
    /// ScreenWin; macOS: every monitor value back in points (tao scales each by the monitor's own factor).
    pub fn screen(&self) -> Screen {
        let primary = self.app.primary_monitor().ok().flatten();
        let monitors: Vec<Monitor> = self
            .app
            .available_monitors()
            .unwrap_or_default()
            .iter()
            .map(|m| {
                let (p, s, wa) = (m.position(), m.size(), m.work_area());
                let is_primary = primary.as_ref().is_some_and(|q| q.name() == m.name() && q.position() == p);
                let bounds = screen::Rect::new(f64::from(p.x), f64::from(p.y), f64::from(s.width), f64::from(s.height));
                let work_area = screen::Rect::new(
                    f64::from(wa.position.x),
                    f64::from(wa.position.y),
                    f64::from(wa.size.width),
                    f64::from(wa.size.height),
                );
                let name = m.name().cloned().unwrap_or_default();
                if cfg!(target_os = "macos") {
                    Monitor::from_scaled(name, bounds, work_area, m.scale_factor(), is_primary)
                } else {
                    Monitor { name, bounds, work_area, scale: m.scale_factor(), primary: is_primary }
                }
            })
            .collect();
        if cfg!(target_os = "macos") { Screen::from_points(&monitors) } else { Screen::new(&monitors) }
    }

    fn window(&self, label: &str) -> Option<WebviewWindow> {
        self.app.get_webview_window(label)
    }

    /// Puts a window at a rect of the host's space (physical pixels on Windows, points on macOS) as [`outer_rect`] reads it.
    /// The window moves onto the target display first: a display with another scale factor changes the frame there
    /// (WM_DPICHANGED), so the frame is measured after the move, then the inner size is set and the position again;
    /// repeated (at most 3 times) until the rect is the target.
    fn place_native(w: &WebviewWindow, r: &screen::Rect) {
        let target = r.rounded();
        set_native_position(w, target.x, target.y);
        for _ in 0..3 {
            let (left, top, dx, dy) = frame_insets(w);
            if cfg!(windows) {
                // The visible rect is the client rect: its size is the inner size, the outer rect starts at the borders.
                set_native_inner_size(w, target.width, target.height);
                set_native_position(w, target.x - left, target.y - top);
            } else {
                set_native_inner_size(w, target.width - dx, target.height - dy);
                set_native_position(w, target.x, target.y);
            }
            if outer_rect(w).is_none_or(|o| o.rounded() == target) {
                break;
            }
        }
    }

    /// Every page load: the first one shows the window (maximized again when it was; an offscreen run never takes the
    /// focus, the hidden mode never shows it), and every one tells the page whether its window is shown (1.1.4 sendShown
    /// on every did-finish-load: a page reloaded while its window is minimized must know).
    fn page_finished(&self, id: &str) {
        let label = detached_label(id);
        let Some(w) = self.window(&label) else { return };
        let first = {
            let mut windows = self.windows.lock();
            let Some(entry) = windows.get_mut(id) else { return };
            (!std::mem::replace(&mut entry.shown, true)).then_some(entry.maximized)
        };
        if let Some(maximized) = first {
            self.first_show(&w, maximized);
        }
        Self::send_shown(&self.ctx, &w);
        // Electron's ipcRenderer.on is synchronous, but a Tauri listener is registered by an IPC call that may still be on
        // its way when the load finishes (seen on a window's first, cold load), and an event before it is lost. The state
        // is sent again a little later; the renderer ignores a repeated value (windowShown.ts).
        let (ctx, w) = (self.ctx.clone(), w.clone());
        tauri::async_runtime::spawn(async move {
            for delay in SHOWN_RESEND_MS {
                tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                Self::send_shown(&ctx, &w);
            }
        });
    }

    /// `window:shown` to a detached window: visible and not minimized.
    fn send_shown(ctx: &Weak<AppContext>, w: &WebviewWindow) {
        let Some(ctx) = ctx.upgrade() else { return };
        let Ok(visible) = w.is_visible() else { return };
        let shown = visible && !w.is_minimized().unwrap_or(false);
        ctx.events.emit(Scope::Window(w.label().to_string()), "window:shown", vec![Value::Bool(shown)]);
    }

    fn first_show(&self, w: &WebviewWindow, maximized: bool) {
        if self.hidden {
            return;
        }
        if maximized && !self.offscreen {
            let _ = w.maximize();
        }
        if self.offscreen {
            windows::show_offscreen(w);
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }

    /// Moved / Resized: the normal-bounds tracker, then the service saves the place (not for the creation's own events).
    fn moved(windows: &Mutex<HashMap<String, HostWin>>, service: &Weak<DetachedService>, id: &str, w: &WebviewWindow) {
        let maximized = w.is_maximized().unwrap_or(false);
        let minimized = w.is_minimized().unwrap_or(false);
        let Some(rect) = outer_rect(w) else { return };
        {
            let mut map = windows.lock();
            let Some(entry) = map.get_mut(id) else { return };
            if !maximized && !minimized {
                entry.normal = Some(rect);
            }
            if let Some(initial) = entry.initial {
                if initial == (rect, maximized) || minimized {
                    return;
                }
                entry.initial = None;
            }
        }
        if let Some(svc) = service.upgrade() {
            svc.place_changed(id);
        }
    }
}

/// Check build (test-bridge `detachedWindow`): reads or moves a detached window like a user would, and the screen in DIPs.
#[cfg(feature = "test-bridge")]
pub async fn test_window_op(ctx: &Arc<AppContext>, args: &Value) -> Result<Value, unimux_ipc::IpcError> {
    use serde_json::json;
    let fail = |m: &str| unimux_ipc::IpcError::failed("test_bridge", m);
    let app = ctx.app().ok_or_else(|| fail("no app yet"))?;
    let action = args.get("action").and_then(Value::as_str).unwrap_or("state");
    if action == "screen" {
        let host = TauriHost::new(app.clone(), ctx);
        let s = host.screen();
        let displays: Vec<Value> = s
            .displays
            .iter()
            .map(|d| {
                json!({
                    "id": d.id, "scale": d.scale,
                    "physical": [d.physical.x, d.physical.y, d.physical.width, d.physical.height],
                    "workArea": [d.work_area.x, d.work_area.y, d.work_area.width, d.work_area.height],
                })
            })
            .collect();
        return Ok(json!({ "displays": displays, "primaryId": s.primary_id() }));
    }
    let id = args.get("id").and_then(Value::as_str).ok_or_else(|| fail("detachedWindow needs {id}"))?;
    let w = app.get_webview_window(&detached_label(id)).ok_or_else(|| fail(&format!("no window for {id}")))?;
    let n = |k: &str| args.get(k).and_then(Value::as_f64);
    match action {
        "move" => {
            let (Some(x), Some(y), Some(width), Some(height)) = (n("x"), n("y"), n("width"), n("height")) else {
                return Err(fail("move needs x, y, width, height (physical; points on macOS)"));
            };
            TauriHost::place_native(&w, &screen::Rect::new(x, y, width, height));
        }
        // What the close button does: CloseRequested first (the tab goes back), unlike destroy().
        "close" => {
            w.close().map_err(|e| fail(&e.to_string()))?;
            return Ok(json!({ "closing": true }));
        }
        "state" => {}
        other => return Err(fail(&format!("unknown action {other}"))),
    }
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let rect = outer_rect(&w).ok_or_else(|| fail("no rect"))?;
    Ok(json!({
        "label": w.label(),
        "physical": [rect.x, rect.y, rect.width, rect.height],
        "visible": w.is_visible().unwrap_or(false),
        "maximized": w.is_maximized().unwrap_or(false),
        "minimized": w.is_minimized().unwrap_or(false),
        "title": w.title().unwrap_or_default(),
        "url": w.url().map(|u| u.to_string()).unwrap_or_default(),
    }))
}

impl Host for TauriHost {
    fn open(&self, id: &str, title: &str, bounds: Rect, maximized: bool, index: usize) -> Result<(), String> {
        let ctx = self.ctx.upgrade().ok_or("the app is gone")?;
        let label = detached_label(id);
        // A taken label belongs to a live window: never touch its guard registration.
        if self.app.get_webview_window(&label).is_some() {
            return Err("a window with this label exists".into());
        }
        let registered = ctx.guard.register_detached(&label);
        // Known before the page can load (the first load shows the window).
        self.windows.lock().insert(id.to_string(), HostWin { maximized, ..HostWin::default() });
        let url = WebviewUrl::App(format!("index.html?detached={}", unimux_ipc::route::query_escape(id)).into());
        let page_id = id.to_string();
        let page_service = self.service.clone();
        let page_host = self.me.clone();
        let mut builder = WebviewWindowBuilder::new(&self.app, &label, url)
            .title(title)
            .inner_size(bounds.width, bounds.height)
            .min_inner_size(MIN_SIZE.width, MIN_SIZE.height)
            .background_color(BACKGROUND)
            .visible(false)
            .focused(false)
            .initialization_script(windows::boot_script(&ctx, &label))
            .on_navigation(windows::allow_navigation)
            .on_page_load(move |_window, payload| {
                let Some(svc) = page_service.upgrade() else { return };
                match payload.event() {
                    PageLoadEvent::Started => svc.page_started(&page_id),
                    PageLoadEvent::Finished => {
                        svc.page_loaded(&page_id);
                        if let Some(host) = page_host.upgrade() {
                            host.page_finished(&page_id);
                        }
                    }
                }
            })
            .devtools(cfg!(dev_overrides))
            .zoom_hotkeys_enabled(false)
            .browser_extensions_enabled(false)
            // No WebView2 "Suggestions" popups over the app's own inputs (and no form data it would store for them).
            .general_autofill_enabled(false)
            .disable_drag_drop_handler();
        #[cfg(windows)]
        {
            builder = builder
                .additional_browser_args(&windows::browser_args(ctx.overrides.debug_port))
                .data_directory(windows::webview_dir(&ctx));
        }
        // No system title bar on Windows (W1), 1.1.4's traffic lights for detached windows on macOS (W2).
        builder = windows::apply_chrome(builder, crate::mac_chrome::WindowKind::Detached);
        if self.offscreen {
            let i = index as f64;
            builder = builder.position(-6000.0 + i * 40.0, 40.0 + i * 40.0).skip_taskbar(true).focusable(false);
        } else if self.hidden {
            builder = builder.skip_taskbar(true).focusable(false);
        }
        let window = match builder.build() {
            Ok(w) => w,
            Err(e) => {
                self.windows.lock().remove(id);
                if registered {
                    ctx.guard.forget_detached(&label);
                }
                return Err(e.to_string());
            }
        };
        windows::apply_webview_settings(&window);
        windows::watch_window_state(&window, ctx.clone());
        windows::forget_on_destroy(&window, ctx.clone());
        // OS file drops (W3) and the renderer crash / hang handling (W6; detached windows always reload).
        crate::file_drop::install(&window, ctx.clone());
        crate::port_message::install(&window, ctx.clone());
        crate::lifecycle::watch_renderer(&window, &ctx);
        // The caption buttons and the top resize edge (W1).
        crate::caption::install(&window, &ctx);
        if !self.offscreen {
            let physical = self.screen().rect_to_physical(&to_platform(&bounds));
            Self::place_native(&window, &physical);
            let placed = outer_rect(&window).unwrap_or(physical);
            if let Some(entry) = self.windows.lock().get_mut(id) {
                entry.normal = Some(placed);
                entry.initial = Some((placed, false));
            }
        }
        let (event_id, event_windows, service, w) = (id.to_string(), self.windows.clone(), self.service.clone(), window.clone());
        window.on_window_event(move |event| match event {
            WindowEvent::Moved(_) | WindowEvent::Resized(_) => Self::moved(&event_windows, &service, &event_id, &w),
            WindowEvent::CloseRequested { api, .. } => {
                if service.upgrade().is_some_and(|svc| svc.close_requested(&event_id)) {
                    api.prevent_close();
                }
            }
            WindowEvent::Destroyed => {
                event_windows.lock().remove(&event_id);
                if let Some(svc) = service.upgrade() {
                    svc.closed(&event_id);
                }
            }
            _ => {}
        });
        Ok(())
    }

    fn destroy(&self, id: &str) {
        if let Some(w) = self.window(&detached_label(id)) {
            let _ = w.destroy();
        }
    }

    fn close(&self, id: &str) {
        if let Some(w) = self.window(&detached_label(id)) {
            let _ = w.close();
        }
    }

    fn set_title(&self, id: &str, title: &str) {
        if let Some(w) = self.window(&detached_label(id)) {
            let _ = w.set_title(title);
        }
    }

    fn show(&self, label: &str) {
        let Some(w) = self.window(label) else { return };
        let offscreen = self.ctx.upgrade().is_some_and(|c| c.overrides.offscreen);
        if label != windows::MAIN && self.hidden {
            return;
        }
        if w.is_minimized().unwrap_or(false) {
            let _ = w.unminimize();
        }
        if offscreen {
            windows::show_offscreen(&w);
        } else {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }

    fn displays(&self) -> (Vec<DisplayArea>, f64) {
        let s = self.screen();
        let list = s.displays.iter().map(|d| DisplayArea { id: d.id, work_area: to_state(&d.work_area) }).collect();
        (list, s.primary_id())
    }

    fn cursor(&self) -> Option<(f64, f64)> {
        let p = self.app.cursor_position().ok()?;
        // macOS: tao scales the cursor by the primary monitor's factor.
        #[cfg(target_os = "macos")]
        let p = {
            let scale = self.app.primary_monitor().ok().flatten().map_or(1.0, |m| m.scale_factor());
            let (x, y) = screen::unscale_point(p.x, p.y, scale);
            tauri::PhysicalPosition::new(x, y)
        };
        Some(self.screen().point_to_dip(p.x, p.y))
    }

    fn main_bounds(&self) -> Option<Rect> {
        let w = self.window(windows::MAIN)?;
        Some(to_state(&self.screen().rect_to_dip(&outer_rect(&w)?)))
    }

    fn main_shown(&self) -> bool {
        self.window(windows::MAIN).is_some_and(|w| w.is_visible().unwrap_or(false) && !w.is_minimized().unwrap_or(false))
    }

    fn place(&self, id: &str) -> Option<(Rect, Option<f64>, bool)> {
        let w = self.window(&detached_label(id))?;
        let (normal, remembered) = {
            let map = self.windows.lock();
            let entry = map.get(id)?;
            (entry.normal, entry.maximized)
        };
        let normal = normal.or_else(|| outer_rect(&w))?;
        let s = self.screen();
        let dip = s.rect_to_dip(&normal).rounded();
        let display = s.display_matching(&dip).map(|d| d.id);
        let maximized = if self.hidden { remembered } else { w.is_maximized().unwrap_or(false) };
        Some((to_state(&dip), display, maximized))
    }
}
