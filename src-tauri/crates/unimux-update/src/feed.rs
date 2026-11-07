//! The Tauri update feed `latest.json` (the tauri-plugin-updater format, so the plugin could be used later) and the minisign
//! verification of a downloaded artifact with the public key embedded at build time (ARCHITECTURE section 8).
//!
//! ```json
//! { "version": "1.2.1", "notes": "...", "pub_date": "2026-11-07T10:00:00Z",
//!   "platforms": { "windows-x86_64": { "url": "https://github.com/.../unimux-Setup-1.2.1.exe", "signature": "<base64 .sig>" } } }
//! ```
//!
//! `signature` is what `tauri signer sign` writes to the `.sig` file: base64 of the minisign signature file. The key is base64 of
//! the minisign public key file ([`crate::UPDATER_PUBLIC_KEY`]).

use base64::Engine as _;
use serde_json::Value;

use crate::version::is_newer;

/// One platform's download.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FeedAsset {
    pub url: String,
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Feed {
    pub version: String,
    /// The asset for this platform, None when the release has none.
    pub asset: Option<FeedAsset>,
}

/// The `platforms` keys tauri-plugin-updater looks for, most specific first.
pub fn platform_keys() -> &'static [&'static str] {
    if cfg!(all(windows, target_arch = "x86_64")) {
        &["windows-x86_64-nsis", "windows-x86_64"]
    } else if cfg!(all(windows, target_arch = "aarch64")) {
        &["windows-aarch64-nsis", "windows-aarch64"]
    } else if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        &["darwin-aarch64-app", "darwin-aarch64"]
    } else if cfg!(target_os = "macos") {
        &["darwin-x86_64-app", "darwin-x86_64"]
    } else {
        &["linux-x86_64"]
    }
}

/// `latest.json` of a development feed (MC_UPDATE_FEED, a folder served over HTTP like 1.1.4's generic feed) or the release.
pub fn feed_url(dev_feed: Option<&str>) -> String {
    match dev_feed {
        Some(base) => format!("{}/latest.json", base.trim_end_matches('/')),
        None => crate::FEED_URL.to_string(),
    }
}

/// Reads `latest.json`; a leading `v` of the version is dropped (tauri-plugin-updater accepts both).
pub fn parse_feed(text: &str, keys: &[&str]) -> Result<Feed, String> {
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| format!("latest.json: {e}"))?;
    let version = value
        .get("version")
        .and_then(Value::as_str)
        .map(|v| v.trim().trim_start_matches('v').to_string())
        .filter(|v| !v.is_empty())
        .ok_or_else(|| "latest.json: no version".to_string())?;
    let platforms = value.get("platforms").and_then(Value::as_object);
    let asset = keys.iter().find_map(|key| {
        let entry = platforms?.get(*key)?;
        let url = entry.get("url")?.as_str()?.trim().to_string();
        let signature = entry.get("signature")?.as_str()?.trim().to_string();
        (!url.is_empty() && !signature.is_empty()).then_some(FeedAsset { url, signature })
    });
    Ok(Feed { version, asset })
}

/// Whether the feed offers an update over `current` (electron-updater's isUpdateAvailable with compareVersions).
pub fn offers_update(feed: &Feed, current: &str) -> bool {
    is_newer(&feed.version, current)
}

fn decode_text(base64_text: &str, what: &str) -> Result<String, String> {
    let bytes =
        base64::engine::general_purpose::STANDARD.decode(base64_text.trim()).map_err(|e| format!("{what}: not base64 ({e})"))?;
    String::from_utf8(bytes).map_err(|_| format!("{what}: not text"))
}

fn decode_key(public_key: &str) -> Result<minisign_verify::PublicKey, String> {
    minisign_verify::PublicKey::decode(&decode_text(public_key, "public key")?).map_err(|e| format!("public key: {e}"))
}

fn decode_signature(signature: &str) -> Result<minisign_verify::Signature, String> {
    minisign_verify::Signature::decode(&decode_text(signature, "signature")?).map_err(|e| format!("signature: {e}"))
}

/// Checks a downloaded file against `signature` (base64 of the .sig file) with `public_key` (base64 of the key file), read in
/// pieces (the macOS archive is about 140 MB).
pub fn verify_file(public_key: &str, signature: &str, path: &std::path::Path) -> Result<(), String> {
    use std::io::Read as _;
    let key = decode_key(public_key)?;
    let signature = decode_signature(signature)?;
    let mut stream = key.verify_stream(&signature).map_err(|e| format!("signature: {e}"))?;
    let mut file = std::fs::File::open(path).map_err(|e| format!("read: {e}"))?;
    let mut buffer = vec![0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buffer).map_err(|e| format!("read: {e}"))?;
        if n == 0 {
            break;
        }
        stream.update(&buffer[..n]);
    }
    stream.finalize().map_err(|e| format!("signature: {e}"))
}

/// Checks a whole artifact in memory.
pub fn verify(public_key: &str, signature: &str, data: &[u8]) -> Result<(), String> {
    let key = decode_key(public_key)?;
    let signature = decode_signature(signature)?;
    key.verify(data, &signature, true).map_err(|e| format!("signature: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_KEY: &str = include_str!("../tests/fixtures/test.key.pub");
    const PAYLOAD: &[u8] = include_bytes!("../tests/fixtures/payload.bin");
    const SIG: &str = include_str!("../tests/fixtures/payload.bin.sig");

    #[test]
    fn reads_the_tauri_feed_format() {
        let text = r#"{"version":"v1.2.1","notes":"n","pub_date":"2026-11-07T10:00:00Z","platforms":{
            "darwin-aarch64":{"url":"https://github.com/a/b.tar.gz","signature":"S1"},
            "windows-x86_64":{"url":" https://github.com/a/unimux-Setup-1.2.1.exe ","signature":"S2"}}}"#;
        let feed = parse_feed(text, &["windows-x86_64-nsis", "windows-x86_64"]).unwrap();
        assert_eq!(feed.version, "1.2.1");
        assert_eq!(
            feed.asset,
            Some(FeedAsset { url: "https://github.com/a/unimux-Setup-1.2.1.exe".into(), signature: "S2".into() })
        );
        assert_eq!(parse_feed(text, &["darwin-aarch64-app", "darwin-aarch64"]).unwrap().asset.unwrap().signature, "S1");
        assert_eq!(parse_feed(text, &["linux-x86_64"]).unwrap().asset, None);
        assert!(parse_feed("{}", platform_keys()).is_err());
        assert!(parse_feed("<html>", platform_keys()).is_err());
        assert!(offers_update(&feed, "1.2.0"));
        assert!(!offers_update(&feed, "1.2.1"));
        assert!(!offers_update(&Feed { version: "1.2.0-test.1".into(), asset: None }, "1.2.0"));
    }

    #[test]
    fn the_dev_feed_is_a_folder() {
        assert_eq!(feed_url(Some("http://127.0.0.1:4100/")), "http://127.0.0.1:4100/latest.json");
        assert_eq!(feed_url(None), crate::FEED_URL);
    }

    #[test]
    fn a_signed_artifact_verifies_and_anything_else_is_refused() {
        verify(TEST_KEY, SIG, PAYLOAD).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("payload.bin");
        std::fs::write(&file, PAYLOAD).unwrap();
        verify_file(TEST_KEY, SIG, &file).unwrap();
        // One changed byte.
        let mut changed = PAYLOAD.to_vec();
        changed[0] ^= 1;
        assert!(verify(TEST_KEY, SIG, &changed).is_err());
        std::fs::write(&file, &changed).unwrap();
        assert!(verify_file(TEST_KEY, SIG, &file).is_err());
        assert!(verify_file(TEST_KEY, SIG, &dir.path().join("missing")).is_err());
        // The release key does not accept a signature of the test key.
        assert!(verify(crate::UPDATER_PUBLIC_KEY, SIG, PAYLOAD).is_err());
        // A corrupt .sig.
        assert!(verify(TEST_KEY, "bm90IGEgc2lnbmF0dXJl", PAYLOAD).is_err());
        assert!(verify(TEST_KEY, "%%%", PAYLOAD).is_err());
        let text = decode_text(SIG, "s").unwrap().replacen("RUS", "RUT", 1);
        let sig = base64::engine::general_purpose::STANDARD.encode(text);
        assert!(verify(TEST_KEY, &sig, PAYLOAD).is_err());
    }
}
