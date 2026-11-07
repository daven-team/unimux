//! OS integration of unimux (wave 0 part: PLAN F5, F6, F11). Later packages add notifications, badge, clipboard secret,
//! session end and file drop here (W3, W4, W6). `mac`: App Nap, WebKit text defaults and edit actions (W2).

pub mod instance;
#[cfg(target_os = "macos")]
pub mod mac;
#[cfg(windows)]
mod win;

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
