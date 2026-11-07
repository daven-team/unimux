//! The kinds and labels of the WebView2 processes (1.2.0: the app's windows run in msedgewebview2.exe processes instead of
//! Electron's). WebView2 names each process's kind (ICoreWebView2Environment8::GetProcessInfos); a utility process gets the
//! service name Electron showed for it ("Network Service") from its `--utility-sub-type`, and processes WebView2 does not
//! list (the crash handler) are told apart by their `--type`.

/// COREWEBVIEW2_PROCESS_KIND values (WebView2.h).
pub const KIND_BROWSER: i32 = 0;
pub const KIND_RENDERER: i32 = 1;
pub const KIND_UTILITY: i32 = 2;
pub const KIND_SANDBOX_HELPER: i32 = 3;
pub const KIND_GPU: i32 = 4;
pub const KIND_PPAPI_PLUGIN: i32 = 5;
pub const KIND_PPAPI_BROKER: i32 = 6;

/// The executable of every WebView2 process.
pub const WEBVIEW_EXE: &str = "msedgewebview2.exe";

/// `--name=value` of a Chromium command line (the value ends at the next space; Chromium never quotes these switches).
pub fn switch_value<'a>(command_line: &'a str, name: &str) -> Option<&'a str> {
    let key = format!("--{name}=");
    let at = command_line.find(&key)?;
    let rest = &command_line[at + key.len()..];
    let rest = rest.strip_prefix('"').unwrap_or(rest);
    Some(rest.split([' ', '"']).next().unwrap_or(""))
}

/// The display name of a Chromium service (`network.mojom.NetworkService` -> "Network Service", what Electron's
/// app.getAppMetrics gave as `name`): the interface name split before its capitals.
pub fn service_name(sub_type: &str) -> String {
    let last = sub_type.rsplit('.').next().unwrap_or(sub_type);
    let mut out = String::new();
    let chars: Vec<char> = last.chars().collect();
    for (i, c) in chars.iter().enumerate() {
        let next_lower = chars.get(i + 1).is_some_and(|n| n.is_lowercase());
        let prev_lower = i > 0 && chars[i - 1].is_lowercase();
        if i > 0 && c.is_uppercase() && (prev_lower || next_lower) && !out.ends_with(' ') {
            out.push(' ');
        }
        out.push(*c);
    }
    if out.is_empty() { sub_type.to_string() } else { out }
}

/// The panel's kind and label of a WebView2 process from the kind WebView2 reports and, for a utility process, its command
/// line (None when it cannot be read).
pub fn from_webview_kind(kind: i32, command_line: Option<&str>) -> (&'static str, Option<String>) {
    match kind {
        KIND_BROWSER => ("webview", None),
        KIND_RENDERER => ("renderer", None),
        KIND_GPU => ("gpu", None),
        KIND_UTILITY => ("utility", command_line.and_then(|l| switch_value(l, "utility-sub-type")).map(service_name)),
        KIND_SANDBOX_HELPER => ("utility", Some("Sandbox Helper".into())),
        KIND_PPAPI_PLUGIN | KIND_PPAPI_BROKER => ("utility", Some("Plugin".into())),
        _ => ("other", None),
    }
}

/// A WebView2 process WebView2 did not list, by its command line's `--type` (no `--type`: the browser process).
pub fn from_command_line(command_line: &str) -> (&'static str, Option<String>) {
    match switch_value(command_line, "type") {
        None => ("webview", None),
        Some("renderer") => ("renderer", None),
        Some("gpu-process") => ("gpu", None),
        Some("utility") => ("utility", switch_value(command_line, "utility-sub-type").map(service_name)),
        Some("crashpad-handler") => ("utility", Some("Crashpad Handler".into())),
        Some(other) => ("utility", Some(other.to_string())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utility_processes_get_electrons_service_names() {
        assert_eq!(service_name("network.mojom.NetworkService"), "Network Service");
        assert_eq!(service_name("storage.mojom.StorageService"), "Storage Service");
        assert_eq!(service_name("audio.mojom.AudioService"), "Audio Service");
        assert_eq!(service_name("data_decoder.mojom.DataDecoderService"), "Data Decoder Service");
        assert_eq!(service_name("on_device_model.mojom.OnDeviceModelService"), "On Device Model Service");
        assert_eq!(service_name("chrome.mojom.UtilWin"), "Util Win");
        assert_eq!(service_name("x.mojom.GPUInfo"), "GPU Info");
        assert_eq!(service_name(""), "");
    }

    #[test]
    fn kinds_follow_webview2_and_the_command_line() {
        let line = r#""C:\WebView2\msedgewebview2.exe" --type=utility --utility-sub-type=network.mojom.NetworkService --lang=pl"#;
        assert_eq!(from_webview_kind(KIND_UTILITY, Some(line)), ("utility", Some("Network Service".into())));
        assert_eq!(from_webview_kind(KIND_UTILITY, None), ("utility", None));
        assert_eq!(from_webview_kind(KIND_BROWSER, None), ("webview", None));
        assert_eq!(from_webview_kind(KIND_RENDERER, None), ("renderer", None));
        assert_eq!(from_webview_kind(KIND_GPU, None), ("gpu", None));
        assert_eq!(from_webview_kind(KIND_SANDBOX_HELPER, None).0, "utility");
        assert_eq!(from_webview_kind(99, None), ("other", None));
        assert_eq!(from_command_line(r#""msedgewebview2.exe" --embedded-browser-webview=1"#), ("webview", None));
        assert_eq!(from_command_line("x --type=crashpad-handler --database=y"), ("utility", Some("Crashpad Handler".into())));
        assert_eq!(from_command_line("x --type=renderer"), ("renderer", None));
        assert_eq!(from_command_line("x --type=gpu-process"), ("gpu", None));
        assert_eq!(from_command_line(line).1.as_deref(), Some("Network Service"));
    }
}
