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
        "spike_pty_attach",
        "spike_pty",
    ];
    // Capabilities: capabilities/*.json always; capabilities-check/*.json (the test_bridge grant) only in builds with the
    // test-bridge feature, so a release build ships no grant for a command it does not contain.
    let test_bridge = std::env::var_os("CARGO_FEATURE_TEST_BRIDGE").is_some();
    println!("cargo::rerun-if-changed=capabilities");
    println!("cargo::rerun-if-changed=capabilities-check");
    let pattern = if test_bridge { "./capabilities*/*.json" } else { "./capabilities/*.json" };
    let attributes = tauri_build::Attributes::new()
        .capabilities_path_pattern(pattern)
        .app_manifest(tauri_build::AppManifest::new().commands(commands));
    tauri_build::try_build(attributes).expect("tauri-build");
}
