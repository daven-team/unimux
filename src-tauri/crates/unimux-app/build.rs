// The app's own commands get permissions (allow-<command>) so the capabilities can grant them per window: the mc_* bridge only
// to `main` and `detached-*`, the update splash commands only to the update windows (capabilities/*.json).
fn main() {
    // `dev_overrides`: the MC_* switches, the DevTools port and devtools. On for debug builds (`npm run tauri dev`) and the
    // check flavour (feature dev-overrides), off for the release flavour (unimux-core::PACKAGED follows the same rule).
    println!("cargo::rustc-check-cfg=cfg(dev_overrides)");
    if std::env::var_os("CARGO_FEATURE_DEV_OVERRIDES").is_some() || std::env::var("PROFILE").as_deref() == Ok("debug") {
        println!("cargo::rustc-cfg=dev_overrides");
    }
    // The build year (UTC) for the About panel's copyright line, like electron-builder's `new Date().getFullYear()`.
    println!("cargo::rustc-env=UNIMUX_BUILD_YEAR={}", build_year());
    let commands: &[&str] = &[
        "mc_invoke",
        "mc_send",
        "mc_invoke_raw",
        "mc_port_attach",
        "mc_port_post",
        "mc_port_pull",
        "update_splash_init",
        "update_splash_close",
        "update_splash_open",
        "mac_title_double_click",
        "mc_dropped_paths",
        "mc_webview_import_done",
        "test_bridge",
        "test_channel_bench",
        "test_channel_pull",
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

/// The current year (UTC), from the days since 1970-01-01 (Howard Hinnant's civil_from_days).
fn build_year() -> i64 {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0) as i64;
    let z = secs.div_euclid(86_400) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    yoe + era * 400 + i64::from(month <= 2)
}
