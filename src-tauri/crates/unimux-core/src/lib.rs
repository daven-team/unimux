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
pub mod panic_guard;
pub mod startup_timing;
pub mod time;

/// The product version (Cargo.toml, kept equal to package.json and tauri.conf.json by the release script).
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Electron's `app.isPackaged`: false for debug builds (`npm run tauri dev`) and for release builds with the `dev-overrides`
/// feature (the check flavour); true for the release flavour, which compiles the MC_* overrides out.
pub const PACKAGED: bool = !cfg!(any(feature = "dev-overrides", debug_assertions));
