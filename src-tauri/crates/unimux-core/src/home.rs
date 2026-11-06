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

/// `app.getPath('appData')`: on Windows the shell's known folder FOLDERID_RoamingAppData (`dirs::data_dir`), like Electron,
/// which ignores the %APPDATA% variable: a launcher or script that sets a different APPDATA must not move 1.2.0 to another
/// data dir than 1.1.x uses. ~/Library/Application Support on macOS, XDG_CONFIG_HOME or ~/.config elsewhere. Tests keep off
/// the real profile with MC_DATA_DIR (dev-overrides builds only), never through this function.
pub fn app_data_dir() -> PathBuf {
    if cfg!(windows) {
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
