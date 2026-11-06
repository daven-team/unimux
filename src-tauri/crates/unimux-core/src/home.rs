//! The home directory with Node's `os.homedir()` semantics: USERPROFILE (Windows) or HOME first, then the OS answer. Tauri's
//! path API and `dirs::home_dir` ignore those variables, so scratch-home tests would touch the real ~/.claude and ~/.codex.

use std::path::PathBuf;

/// `os.homedir()`.
pub fn home_dir() -> PathBuf {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    match std::env::var_os(var) {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => dirs::home_dir().unwrap_or_else(|| PathBuf::from(".")),
    }
}

/// Claude Code's config folder: CLAUDE_CONFIG_DIR, else ~/.claude.
pub fn claude_dir() -> PathBuf {
    match std::env::var_os("CLAUDE_CONFIG_DIR") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => home_dir().join(".claude"),
    }
}

/// Codex's home: CODEX_HOME, else ~/.codex.
pub fn codex_dir() -> PathBuf {
    match std::env::var_os("CODEX_HOME") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => home_dir().join(".codex"),
    }
}

/// `app.getPath('appData')`: %APPDATA% on Windows (honouring the variable like Electron), ~/Library/Application Support on
/// macOS, XDG_CONFIG_HOME or ~/.config elsewhere.
pub fn app_data_dir() -> PathBuf {
    if cfg!(windows) {
        if let Some(v) = std::env::var_os("APPDATA").filter(|v| !v.is_empty()) {
            return PathBuf::from(v);
        }
        return dirs::data_dir().unwrap_or_else(|| home_dir().join("AppData").join("Roaming"));
    }
    if cfg!(target_os = "macos") {
        return home_dir().join("Library").join("Application Support");
    }
    match std::env::var_os("XDG_CONFIG_HOME") {
        Some(v) if !v.is_empty() => PathBuf::from(v),
        _ => home_dir().join(".config"),
    }
}

/// %LOCALAPPDATA% (Windows) or the OS cache-like local data folder.
pub fn local_app_data_dir() -> PathBuf {
    if cfg!(windows)
        && let Some(v) = std::env::var_os("LOCALAPPDATA").filter(|v| !v.is_empty())
    {
        return PathBuf::from(v);
    }
    dirs::data_local_dir().unwrap_or_else(app_data_dir)
}
