//! OS integration of unimux (wave 0 part: PLAN F5, F6, F11; W4: notifications, Dock badge, clipboard incl. the copied
//! secret, shell, beep, alert sound files; W6: session end, the macOS quit request and the app's message box (lifecycle.rs)).
//! `mac`: App Nap, WebKit text defaults and edit actions (W2). `screen`: displays for detached windows (W5).

pub mod clipboard;
pub mod instance;
pub mod lifecycle;
#[cfg(target_os = "macos")]
pub mod mac;
#[cfg(target_os = "macos")]
mod mac_lifecycle;
#[cfg(target_os = "macos")]
mod mac_notify;
pub mod notify;
pub mod screen;
pub mod shell;
pub mod sound;
pub mod taskbar;
pub mod timers;
pub mod webview;
#[cfg(windows)]
mod win;
#[cfg(windows)]
mod win_lifecycle;

/// Node's `os.hostname()`: the DNS host name of this machine (S4: the default comment of a generated SSH key is
/// `unimux@<hostname>`). Empty when the OS does not answer.
pub fn hostname() -> String {
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::{ComputerNameDnsHostname, GetComputerNameExW};
        let mut size = 0u32;
        // The first call only reports the size (it fails with ERROR_MORE_DATA).
        let _ = unsafe { GetComputerNameExW(ComputerNameDnsHostname, None, &mut size) };
        if size == 0 {
            return String::new();
        }
        let mut buf = vec![0u16; size as usize];
        let ok = unsafe { GetComputerNameExW(ComputerNameDnsHostname, Some(windows::core::PWSTR(buf.as_mut_ptr())), &mut size) };
        if ok.is_err() {
            return String::new();
        }
        String::from_utf16_lossy(&buf[..(size as usize).min(buf.len())])
    }
    #[cfg(unix)]
    {
        let mut buf = [0u8; 256];
        let r = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
        if r != 0 {
            return String::new();
        }
        let end = buf.iter().position(|b| *b == 0).unwrap_or(buf.len());
        String::from_utf8_lossy(&buf[..end]).into_owned()
    }
}

/// `AllowSetForegroundWindow(pid)`: passes this process's right to set the foreground window (it has it right after the user
/// clicked in it) on to `pid`. The update window gets it from the app the user just clicked "install" in, so the UAC prompt
/// of a per-machine install can come to the front; the window itself never takes the focus. False when this process had no
/// such right (or elsewhere than on Windows).
pub fn allow_set_foreground(pid: u32) -> bool {
    #[cfg(windows)]
    {
        win::allow_set_foreground(pid)
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        false
    }
}

/// What a double click on the title bar does on macOS (System Settings > Desktop & Dock > "Double-click a window's title bar
/// to"), as AppKit does it for a native title bar and Electron for a `-webkit-app-region: drag` area (1.1.4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TitleDoubleClick {
    /// "Zoom" (the default; also "Fill" on macOS 15+): toggles between the zoomed and the user size.
    Zoom,
    Minimize,
    /// "Do Nothing".
    Nothing,
}

impl TitleDoubleClick {
    /// From the global defaults `AppleActionOnDoubleClick` ("Maximize" | "Minimize" | "None" | "Fill") and, when that is
    /// absent, the older `AppleMiniaturizeOnDoubleClick` (true: minimize). Unknown values zoom, like AppKit.
    pub fn from_defaults(action: Option<&str>, miniaturize: Option<bool>) -> Self {
        match action {
            Some("Minimize") => TitleDoubleClick::Minimize,
            Some("None") => TitleDoubleClick::Nothing,
            Some(_) => TitleDoubleClick::Zoom,
            None if miniaturize == Some(true) => TitleDoubleClick::Minimize,
            None => TitleDoubleClick::Zoom,
        }
    }
}

/// `SetCurrentProcessExplicitAppUserModelID`: `com.unimux.app` for the installed app, `com.unimux.app.dev` otherwise, so a
/// run from the repository never shares the taskbar entry (and its icon) with the installed app.
pub fn set_app_user_model_id(id: &str) {
    #[cfg(windows)]
    win::set_app_user_model_id(id);
    #[cfg(not(windows))]
    let _ = id;
}

/// The Windows build number (`10.0.26200` -> 26200) from RtlGetVersion (not affected by compatibility shims); 0 elsewhere.
pub fn windows_build() -> u32 {
    #[cfg(windows)]
    {
        win::windows_build()
    }
    #[cfg(not(windows))]
    {
        0
    }
}

/// Opens an http(s) URL in the default browser (only those schemes; anything else is ignored).
pub fn open_url(url: &str) {
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return;
    }
    #[cfg(windows)]
    win::open_url(url);
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open")
            .arg(url)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn();
    }
}

/// The OS UI language as a BCP 47 tag (`pl-PL`), for the language of dialogs shown before the state is read.
pub fn os_locale() -> Option<String> {
    #[cfg(windows)]
    {
        win::user_locale()
    }
    #[cfg(not(windows))]
    {
        std::env::var("LC_ALL").ok().or_else(|| std::env::var("LANG").ok()).filter(|v| !v.is_empty())
    }
}

/// A blocking native error box (startup failures before any window exists).
pub fn error_box(title: &str, text: &str) {
    #[cfg(windows)]
    win::error_box(title, text);
    #[cfg(target_os = "macos")]
    {
        let script = format!("display alert {} message {} as critical", applescript_string(title), applescript_string(text));
        let _ = std::process::Command::new("osascript").arg("-e").arg(script).status();
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    eprintln!("{title}: {text}");
}

#[cfg(target_os = "macos")]
fn applescript_string(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

#[cfg(test)]
mod title_tests {
    use super::TitleDoubleClick;

    #[test]
    fn title_double_click_follows_the_system_setting() {
        assert_eq!(TitleDoubleClick::from_defaults(None, None), TitleDoubleClick::Zoom);
        assert_eq!(TitleDoubleClick::from_defaults(Some("Maximize"), None), TitleDoubleClick::Zoom);
        assert_eq!(TitleDoubleClick::from_defaults(Some("Fill"), None), TitleDoubleClick::Zoom);
        assert_eq!(TitleDoubleClick::from_defaults(Some("Minimize"), None), TitleDoubleClick::Minimize);
        assert_eq!(TitleDoubleClick::from_defaults(Some("None"), Some(true)), TitleDoubleClick::Nothing);
        assert_eq!(TitleDoubleClick::from_defaults(None, Some(true)), TitleDoubleClick::Minimize);
        assert_eq!(TitleDoubleClick::from_defaults(None, Some(false)), TitleDoubleClick::Zoom);
    }
}
