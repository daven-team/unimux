// The app's own commands get permissions (allow-<command>) so the capabilities can grant them per window: the mc_* bridge only
// to `main` and `detached-*`, the update splash commands only to the update windows (capabilities/*.json).
fn main() {
    // `dev_overrides`: the MC_* switches, the DevTools port and devtools. On for debug builds (`npm run tauri dev`) and the
    // check flavour (feature dev-overrides), off for the release flavour (unimux-core::PACKAGED follows the same rule).
    println!("cargo::rustc-check-cfg=cfg(dev_overrides)");
    if std::env::var_os("CARGO_FEATURE_DEV_OVERRIDES").is_some() || std::env::var("PROFILE").as_deref() == Ok("debug") {
        println!("cargo::rustc-cfg=dev_overrides");
    }
    let commands: &[&str] = &[
        "mc_invoke",
        "mc_send",
        "mc_invoke_raw",
        "mc_port_attach",
        "mc_port_post",
        "update_splash_init",
        "update_splash_close",
        "update_splash_open",
        "test_bridge",
    ];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)))
        .expect("tauri-build");
}
