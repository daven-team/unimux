//! Test tool of the W1 caption checks (never shipped): finds the top-level windows of a process, captures a window with
//! PrintWindow (PW_RENDERFULLCONTENT, so an off-screen window and DirectComposition content are included: CDP screenshots
//! do not contain Electron's caption overlay), posts window messages (hover, press, activation) and asks the window under a
//! point for its WM_NCHITTEST answer. Nothing here moves the real cursor, activates a window or shows anything.
//!
//! Usage (one command per line on stdin, one JSON answer per line on stdout, so a script keeps one process):
//!   windows <pid>                       top-level windows of the process (and of its children: Electron's are in main)
//!   capture <hwnd> <file>               client area as raw BGRA (header: "W1RAW", u32 width, u32 height)
//!   send <hwnd> <msg> <wparam> <lparam> SendMessageW, answers the result
//!   post <hwnd> <msg> <wparam> <lparam> PostMessageW
//!   hittest <x> <y>                     screen point: the deepest window there and the WM_NCHITTEST chain up to the top
//!   rect <hwnd>                         window and client rectangles in screen pixels, DPI, maximized, style bits
//!   show <hwnd> <cmd>                   ShowWindow (e.g. 4 show without activation)
//!   setstyle <hwnd> <style>             SetWindowLongW(GWL_STYLE) (WS_MAXIMIZE for the restore glyph, no real maximize)
//!   setpos <hwnd> <x> <y> <w> <h>       SetWindowPos without activation
//!   quit

#[cfg(windows)]
fn main() {
    win::run();
}

#[cfg(not(windows))]
fn main() {
    eprintln!("wincap is a Windows tool");
}

#[cfg(windows)]
mod win {
    use std::io::{BufRead, Write};

    use windows::Win32::Foundation::{HWND, LPARAM, POINT, RECT, WPARAM};
    use windows::Win32::Graphics::Gdi::{
        BI_RGB, BITMAPINFO, BITMAPINFOHEADER, ClientToScreen, CreateCompatibleDC, CreateDIBSection, DIB_RGB_COLORS, DeleteDC,
        DeleteObject, GetDC, ReleaseDC, ScreenToClient, SelectObject,
    };
    use windows::Win32::Storage::Xps::{PRINT_WINDOW_FLAGS, PrintWindow};
    use windows::Win32::UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, GetDpiForWindow, SetProcessDpiAwarenessContext};
    use windows::Win32::UI::WindowsAndMessaging::{
        CWP_SKIPINVISIBLE, ChildWindowFromPointEx, EnumWindows, GA_PARENT, GWL_EXSTYLE, GWL_STYLE, GetAncestor, GetClassNameW,
        GetClientRect, GetWindowLongW, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        IsZoomed, PostMessageW, SHOW_WINDOW_CMD, SMTO_ABORTIFHUNG, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOZORDER,
        SendMessageTimeoutW, SetWindowLongW, SetWindowPos, ShowWindow, WM_NCHITTEST, WindowFromPoint,
    };

    pub fn run() {
        // SAFETY: called once before any window call.
        unsafe {
            let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        }
        let stdin = std::io::stdin();
        let mut out = std::io::stdout();
        for line in stdin.lock().lines() {
            let Ok(line) = line else { break };
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.is_empty() {
                continue;
            }
            if parts[0] == "quit" {
                break;
            }
            let answer = match command(&parts) {
                Ok(v) => v,
                Err(e) => format!("{{\"error\":{}}}", json_str(&e)),
            };
            let _ = writeln!(out, "{answer}");
            let _ = out.flush();
        }
    }

    fn num(s: &str) -> Result<i64, String> {
        let s = s.trim();
        let r = if let Some(h) = s.strip_prefix("0x") { i64::from_str_radix(h, 16) } else { s.parse::<i64>() };
        r.map_err(|e| format!("bad number {s}: {e}"))
    }

    fn hwnd(s: &str) -> Result<HWND, String> {
        Ok(HWND(num(s)? as isize as *mut _))
    }

    fn json_str(s: &str) -> String {
        let mut o = String::from("\"");
        for c in s.chars() {
            match c {
                '"' => o.push_str("\\\""),
                '\\' => o.push_str("\\\\"),
                c if (c as u32) < 0x20 => o.push_str(&format!("\\u{:04x}", c as u32)),
                c => o.push(c),
            }
        }
        o.push('"');
        o
    }

    fn class_of(h: HWND) -> String {
        let mut buf = [0u16; 256];
        // SAFETY: a valid buffer; a stale handle gives 0.
        let n = unsafe { GetClassNameW(h, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn title_of(h: HWND) -> String {
        let mut buf = [0u16; 512];
        // SAFETY: as above.
        let n = unsafe { GetWindowTextW(h, &mut buf) };
        String::from_utf16_lossy(&buf[..n.max(0) as usize])
    }

    fn command(p: &[&str]) -> Result<String, String> {
        match p[0] {
            "windows" => {
                let pids: Vec<u32> = p[1..].iter().map(|s| num(s).map(|n| n as u32)).collect::<Result<_, _>>()?;
                Ok(windows_of(&pids))
            }
            "capture" if p.len() == 3 => capture(hwnd(p[1])?, p[2]),
            "send" if p.len() == 5 => {
                let mut result = 0usize;
                // SAFETY: plain message to a window of a process we started; a hung window times out after 5 s.
                let ok = unsafe {
                    SendMessageTimeoutW(
                        hwnd(p[1])?,
                        num(p[2])? as u32,
                        WPARAM(num(p[3])? as usize),
                        LPARAM(num(p[4])? as isize),
                        SMTO_ABORTIFHUNG,
                        5000,
                        Some(&mut result),
                    )
                };
                Ok(format!("{{\"ok\":{},\"result\":{}}}", ok.0 != 0, result as isize))
            }
            "post" if p.len() == 5 => {
                // SAFETY: as above.
                let r = unsafe {
                    PostMessageW(Some(hwnd(p[1])?), num(p[2])? as u32, WPARAM(num(p[3])? as usize), LPARAM(num(p[4])? as isize))
                };
                Ok(format!("{{\"ok\":{}}}", r.is_ok()))
            }
            "hittest" if p.len() == 3 => hittest(num(p[1])? as i32, num(p[2])? as i32),
            "rect" if p.len() == 2 => rect(hwnd(p[1])?),
            "show" if p.len() == 3 => {
                // SAFETY: ShowWindow on a window of a process we started.
                let r = unsafe { ShowWindow(hwnd(p[1])?, SHOW_WINDOW_CMD(num(p[2])? as i32)) };
                Ok(format!("{{\"wasVisible\":{}}}", r.0 != 0))
            }
            "setstyle" if p.len() == 3 => {
                // SAFETY: changes the style bits of a window of a process we started (the reference capture's maximized
                // glyph without maximizing onto a real monitor).
                let old = unsafe { SetWindowLongW(hwnd(p[1])?, GWL_STYLE, num(p[2])? as u32 as i32) };
                Ok(format!("{{\"old\":{}}}", old as u32))
            }
            "setpos" if p.len() == 6 => {
                // SAFETY: moves / sizes a window of a process we started, without activating it or changing the z-order.
                let r = unsafe {
                    SetWindowPos(
                        hwnd(p[1])?,
                        None,
                        num(p[2])? as i32,
                        num(p[3])? as i32,
                        num(p[4])? as i32,
                        num(p[5])? as i32,
                        SWP_NOACTIVATE | SWP_NOZORDER | SWP_FRAMECHANGED,
                    )
                };
                Ok(format!("{{\"ok\":{}}}", r.is_ok()))
            }
            _ => Err(format!("unknown command {p:?}")),
        }
    }

    fn windows_of(pids: &[u32]) -> String {
        struct Acc<'a> {
            pids: &'a [u32],
            found: Vec<String>,
        }
        unsafe extern "system" fn each(h: HWND, l: LPARAM) -> windows::core::BOOL {
            // SAFETY: l is the &mut Acc passed below, alive for the whole EnumWindows call.
            let acc = unsafe { &mut *(l.0 as *mut Acc) };
            let mut pid = 0u32;
            // SAFETY: valid out pointer.
            unsafe { GetWindowThreadProcessId(h, Some(&mut pid)) };
            if acc.pids.contains(&pid) {
                // SAFETY: plain queries.
                let visible = unsafe { IsWindowVisible(h).as_bool() };
                acc.found.push(format!(
                    "{{\"hwnd\":{},\"pid\":{pid},\"class\":{},\"title\":{},\"visible\":{visible}}}",
                    h.0 as isize,
                    json_str(&class_of(h)),
                    json_str(&title_of(h))
                ));
            }
            true.into()
        }
        let mut acc = Acc { pids, found: Vec::new() };
        // SAFETY: the callback only touches acc during the call.
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut acc as *mut Acc as isize));
        }
        format!("{{\"windows\":[{}]}}", acc.found.join(","))
    }

    fn rect(h: HWND) -> Result<String, String> {
        let mut wr = RECT::default();
        let mut cr = RECT::default();
        let mut origin = POINT::default();
        // SAFETY: plain queries on a window handle.
        unsafe {
            GetWindowRect(h, &mut wr).map_err(|e| e.to_string())?;
            GetClientRect(h, &mut cr).map_err(|e| e.to_string())?;
            let _ = ClientToScreen(h, &mut origin);
            Ok(format!(
                "{{\"window\":[{},{},{},{}],\"client\":[{},{},{},{}],\"dpi\":{},\"maximized\":{},\"minimized\":{},\"style\":{},\"exStyle\":{}}}",
                wr.left,
                wr.top,
                wr.right,
                wr.bottom,
                origin.x,
                origin.y,
                cr.right,
                cr.bottom,
                GetDpiForWindow(h),
                IsZoomed(h).as_bool(),
                IsIconic(h).as_bool(),
                GetWindowLongW(h, GWL_STYLE) as u32,
                GetWindowLongW(h, GWL_EXSTYLE) as u32
            ))
        }
    }

    fn capture(h: HWND, file: &str) -> Result<String, String> {
        let mut wr = RECT::default();
        let mut cr = RECT::default();
        let mut origin = POINT::default();
        // SAFETY: GDI calls on our own memory DC and DIB, released on every path below.
        unsafe {
            GetWindowRect(h, &mut wr).map_err(|e| e.to_string())?;
            GetClientRect(h, &mut cr).map_err(|e| e.to_string())?;
            let _ = ClientToScreen(h, &mut origin);
            let (ww, wh) = (wr.right - wr.left, wr.bottom - wr.top);
            let screen = GetDC(None);
            let dc = CreateCompatibleDC(Some(screen));
            let info = BITMAPINFO {
                bmiHeader: BITMAPINFOHEADER {
                    biSize: size_of::<BITMAPINFOHEADER>() as u32,
                    biWidth: ww,
                    biHeight: -wh,
                    biPlanes: 1,
                    biBitCount: 32,
                    biCompression: BI_RGB.0,
                    ..Default::default()
                },
                ..Default::default()
            };
            let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
            let bmp = CreateDIBSection(Some(dc), &info, DIB_RGB_COLORS, &mut bits, None, 0).map_err(|e| e.to_string())?;
            let old = SelectObject(dc, bmp.into());
            // PW_RENDERFULLCONTENT (2): DirectComposition content too.
            let ok = PrintWindow(h, dc, PRINT_WINDOW_FLAGS(2)).as_bool();
            let all = std::slice::from_raw_parts(bits as *const u8, (ww * wh * 4) as usize).to_vec();
            SelectObject(dc, old);
            let _ = DeleteObject(bmp.into());
            let _ = DeleteDC(dc);
            ReleaseDC(None, screen);
            if !ok {
                return Err("PrintWindow failed".into());
            }
            let (ox, oy) = (origin.x - wr.left, origin.y - wr.top);
            let (cw, ch) = (cr.right.min(ww - ox), cr.bottom.min(wh - oy));
            let mut out = Vec::with_capacity(13 + (cw * ch * 4) as usize);
            out.extend_from_slice(b"W1RAW");
            out.extend_from_slice(&(cw as u32).to_le_bytes());
            out.extend_from_slice(&(ch as u32).to_le_bytes());
            for y in 0..ch {
                let start = (((y + oy) * ww + ox) * 4) as usize;
                out.extend_from_slice(&all[start..start + (cw * 4) as usize]);
            }
            std::fs::write(file, out).map_err(|e| e.to_string())?;
            Ok(format!("{{\"width\":{cw},\"height\":{ch},\"dpi\":{}}}", GetDpiForWindow(h)))
        }
    }

    fn hittest(x: i32, y: i32) -> Result<String, String> {
        let pt = POINT { x, y };
        // SAFETY: plain queries; WM_NCHITTEST is answered by each window's own procedure (5 s timeout).
        unsafe {
            let mut h = WindowFromPoint(pt);
            if h.0.is_null() {
                return Ok("{\"chain\":[]}".into());
            }
            // Descend to the deepest visible child at the point.
            loop {
                let mut local = pt;
                let _ = ScreenToClient(h, &mut local);
                let child = ChildWindowFromPointEx(h, local, CWP_SKIPINVISIBLE);
                if child.0.is_null() || child == h {
                    break;
                }
                h = child;
            }
            let mut chain = Vec::new();
            let lparam = LPARAM(((y as u32 as isize & 0xffff) << 16) | (x as u32 as isize & 0xffff));
            let mut cur = h;
            while !cur.0.is_null() {
                let mut result = 0usize;
                let _ = SendMessageTimeoutW(cur, WM_NCHITTEST, WPARAM(0), lparam, SMTO_ABORTIFHUNG, 5000, Some(&mut result));
                chain.push(format!(
                    "{{\"hwnd\":{},\"class\":{},\"hit\":{}}}",
                    cur.0 as isize,
                    json_str(&class_of(cur)),
                    result as u32 as i32 as i16
                ));
                cur = GetAncestor(cur, GA_PARENT);
                if class_of(cur) == "#32769" {
                    break;
                }
            }
            Ok(format!("{{\"chain\":[{}]}}", chain.join(",")))
        }
    }
}
