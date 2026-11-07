//! Small text helpers of src/main/macUpdate/engine.ts: Info.plist values, the bundle identifier rule and the version a staging
//! file belongs to.

use std::sync::LazyLock;

use regex::Regex;

/// Value of a top-level string key of an XML property list; None when the key is missing. The TS regex
/// `<key>KEY</key>\s*<string>([^<]*)</string>` (first match), then `&lt; &gt; &quot; &apos;` and `&amp;` last.
pub fn plist_string(xml: &str, key: &str) -> Option<String> {
    let pattern = format!(r"<key>{}</key>\s*<string>([^<]*)</string>", regex::escape(key));
    let re = Regex::new(&pattern).ok()?;
    let raw = re.captures(xml)?.get(1)?.as_str();
    Some(raw.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", "\"").replace("&apos;", "'").replace("&amp;", "&"))
}

/// Bundle identifiers of this app: the one kept from before the rebranding (the macOS bundle still uses it, so 0.8.x and 1.1.x
/// engines accept the update) and the current one.
const OWN_BUNDLE_IDS: [&str; 2] = ["com.ajzakomator.app", "com.unimux.app"];

/// Whether an update bundle belongs to the running app (`sameApp`).
pub fn same_app(identifier: &str, running: &str) -> bool {
    identifier == running || (OWN_BUNDLE_IDS.contains(&identifier) && OWN_BUNDLE_IDS.contains(&running))
}

// JS `\d` is ASCII and `.` stops at line terminators; spelled out for the Rust engine.
static ARCHIVE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"-([0-9]+\.[0-9]+\.[0-9]+[^/]*?)-mac-(?:arm64|x64)\.zip(?:\.part)?$").unwrap());
/// 1.2.0: the Tauri updater archive (`unimux-1.2.1-mac-arm64.app.tar.gz`), not known to 1.1.4.
static TAR_ARCHIVE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"-([0-9]+\.[0-9]+\.[0-9]+[^/]*?)-mac-(?:arm64|x64)\.app\.tar\.gz(?:\.part)?$").unwrap());
static EXTRACTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^extracted-([^\n\r  ]+)$").unwrap());
static SCRIPT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^install-([^\n\r  ]+)\.sh$").unwrap());

/// Version a file of the staging directory belongs to (archive, partial archive, unpacked bundle, 1.1.x script); None for other
/// files (`stagedFileVersion`, plus the `.app.tar.gz` archive of 1.2.0).
pub fn staged_file_version(name: &str) -> Option<String> {
    [&*ARCHIVE, &*TAR_ARCHIVE, &*EXTRACTED, &*SCRIPT]
        .iter()
        .find_map(|re| re.captures(name).and_then(|c| c.get(1)).map(|m| m.as_str().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plist_values_and_entities() {
        let xml = "<plist><dict><key>CFBundleShortVersionString</key>\n\t<string>1.2.1</string>\
                   <key>CFBundleName</key><string>a &amp;lt; &lt;b&gt; &quot;c&quot; &apos;d&apos;</string></dict></plist>";
        assert_eq!(plist_string(xml, "CFBundleShortVersionString").as_deref(), Some("1.2.1"));
        assert_eq!(plist_string(xml, "CFBundleName").as_deref(), Some("a &lt; <b> \"c\" 'd'"));
        assert_eq!(plist_string(xml, "CFBundleIdentifier"), None);
        assert_eq!(plist_string(xml, "CFBundle.*"), None, "the key is literal");
    }

    #[test]
    fn identifiers_and_staging_names() {
        assert!(same_app("com.ajzakomator.app", "com.unimux.app"));
        assert!(same_app("com.other", "com.other"));
        assert!(!same_app("com.other", "com.unimux.app"));
        assert_eq!(staged_file_version("unimux-1.2.1-mac-arm64.zip").as_deref(), Some("1.2.1"));
        assert_eq!(staged_file_version("unimux-1.2.1-beta.1-mac-x64.zip.part").as_deref(), Some("1.2.1-beta.1"));
        assert_eq!(staged_file_version("unimux-1.2.1-mac-arm64.app.tar.gz").as_deref(), Some("1.2.1"));
        assert_eq!(staged_file_version("unimux-1.2.1-mac-x64.app.tar.gz.part").as_deref(), Some("1.2.1"));
        assert_eq!(staged_file_version("extracted-1.2.1").as_deref(), Some("1.2.1"));
        assert_eq!(staged_file_version("install-1.2.1.sh").as_deref(), Some("1.2.1"));
        assert_eq!(staged_file_version("update.log"), None);
        assert_eq!(staged_file_version("unimux-1.2.1-mac-ppc.zip"), None);
    }
}
