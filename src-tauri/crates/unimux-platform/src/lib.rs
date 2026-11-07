//! OS integration of unimux (wave 0 part: PLAN F5, F6, F11). Later packages add notifications, badge, clipboard secret
//! and file drop here (W3, W4). W6: session end, the macOS quit request and the app's message box (lifecycle.rs).

pub mod instance;
pub mod lifecycle;
#[cfg(target_os = "macos")]
mod mac_lifecycle;
#[cfg(windows)]
mod win;
#[cfg(windows)]
mod win_lifecycle;

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
