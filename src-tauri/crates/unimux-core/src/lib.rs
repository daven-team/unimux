//! Pure building blocks shared by every unimux crate. No Tauri, no async runtime: everything here is tested with plain
//! `cargo test` against temporary directories.

pub mod atomic_write;
pub mod crash_log;
pub mod data_dir;
pub mod dev_overrides;
pub mod home;
pub mod i18n;
pub mod js_json;
pub mod json_file;
pub mod startup_timing;
pub mod time;

/// The product version (Cargo.toml, kept equal to package.json and tauri.conf.json by the release script). A build with the
/// `dev-overrides` feature (the check flavour) takes `UNIMUX_VERSION_OVERRIDE` from the build environment instead, so the
/// update window harness can build a second payload (1.2.0 -> 1.2.0-test.1, PLAN U2); a release build ignores it.
pub const VERSION: &str = match option_env!("UNIMUX_VERSION_OVERRIDE") {
    Some(v) if cfg!(feature = "dev-overrides") && !v.is_empty() => v,
    _ => env!("CARGO_PKG_VERSION"),
};

/// Electron's `app.getName()` of 1.1.x (the productName): it names the macOS Keychain item of safeStorage
/// (`unimux Safe Storage` / `unimux Key`), which 1.2.0 must keep reading.
pub const APP_NAME: &str = "unimux";

/// Electron's `app.isPackaged`: false for debug builds (`npm run tauri dev`) and for release builds with the `dev-overrides`
/// feature (the check flavour); true for the release flavour, which compiles the MC_* overrides out.
pub const PACKAGED: bool = !cfg!(any(feature = "dev-overrides", debug_assertions));
