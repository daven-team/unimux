//! Chromium's `Local State` file (JSON in the user data dir, Electron's `userData` = unimux's data dir): only
//! `os_crypt.encrypted_key` is read. The file belongs to Electron: it is never rewritten. It is only created, in the shape
//! Chromium reads, when it does not exist at all (a fresh 1.2.0 install), so a later 1.1.x start keeps using the same key.

use std::io::Write;
use std::path::{Path, PathBuf};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;

pub const FILE_NAME: &str = "Local State";
/// Chromium writes `"DPAPI"` + the DPAPI blob of the 32-byte key, base64 encoded.
pub const DPAPI_PREFIX: &[u8] = b"DPAPI";

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// What `Local State` says about the OSCrypt key.
#[derive(Debug, PartialEq, Eq)]
pub enum KeyEntry {
    /// The DPAPI blob (the `DPAPI` prefix already removed).
    Dpapi(Vec<u8>),
    /// The file exists but has no usable `os_crypt.encrypted_key`.
    Missing,
    /// The file is not JSON (or not an object), or the key is not base64 with the `DPAPI` prefix.
    Invalid,
}

/// Reads `os_crypt.encrypted_key` out of the text of `Local State`. Other keys (`os_crypt.app_bound_encrypted_key`,
/// `os_crypt.audit_enabled`, anything Chromium adds) are ignored.
pub fn parse(text: &[u8]) -> KeyEntry {
    let Ok(value) = serde_json::from_slice::<serde_json::Value>(text) else { return KeyEntry::Invalid };
    if !value.is_object() {
        return KeyEntry::Invalid;
    }
    let Some(encoded) = value.get("os_crypt").and_then(|o| o.get("encrypted_key")) else { return KeyEntry::Missing };
    let Some(encoded) = encoded.as_str() else { return KeyEntry::Invalid };
    match STANDARD.decode(encoded) {
        Ok(bytes) => match bytes.strip_prefix(DPAPI_PREFIX) {
            Some(blob) if !blob.is_empty() => KeyEntry::Dpapi(blob.to_vec()),
            _ => KeyEntry::Invalid,
        },
        Err(_) => KeyEntry::Invalid,
    }
}

/// The text of a fresh `Local State` holding only the key, as Chromium serializes it (compact JSON, keys sorted). With
/// `audit_enabled: true` Chromium keeps the key blob as it is (without it, it re-wraps the key with CRYPTPROTECT_AUDIT).
pub fn fresh_text(dpapi_blob: &[u8]) -> String {
    let mut bytes = DPAPI_PREFIX.to_vec();
    bytes.extend_from_slice(dpapi_blob);
    serde_json::json!({ "os_crypt": { "audit_enabled": true, "encrypted_key": STANDARD.encode(bytes) } }).to_string()
}

/// Creates `Local State` only if no file of that name exists, never replacing one that appeared meanwhile (Electron may
/// start at the same moment): the text goes to a temp file first, then a hard link gives it the real name, which fails
/// when the name is taken. Returns false when another process created the file first.
pub fn create_new(data_dir: &Path, text: &str) -> std::io::Result<bool> {
    let target = path(data_dir);
    let temp = data_dir.join(format!("{FILE_NAME}.unimux-{}.tmp", std::process::id()));
    {
        let mut file = std::fs::File::create(&temp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
    }
    let linked = std::fs::hard_link(&temp, &target);
    let _ = std::fs::remove_file(&temp);
    match linked {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chromium_shapes() {
        let blob = b"\x01\x00\x00\x00blob";
        let text = fresh_text(blob);
        assert!(text.starts_with(r#"{"os_crypt":{"audit_enabled":true,"encrypted_key":"RFBBUEk"#));
        assert_eq!(parse(text.as_bytes()), KeyEntry::Dpapi(blob.to_vec()));
        let with_more = format!(
            r#"{{"browser":{{"x":1}},"os_crypt":{{"app_bound_encrypted_key":"QVBQQgAA","audit_enabled":true,"encrypted_key":"{}"}}}}"#,
            STANDARD.encode(b"DPAPIabc")
        );
        assert_eq!(parse(with_more.as_bytes()), KeyEntry::Dpapi(b"abc".to_vec()));
        assert_eq!(parse(br#"{"browser":{}}"#), KeyEntry::Missing);
        assert_eq!(parse(br#"{"os_crypt":{}}"#), KeyEntry::Missing);
        assert_eq!(parse(br#"{"os_crypt":{"encrypted_key":5}}"#), KeyEntry::Invalid);
        assert_eq!(parse(br#"{"os_crypt":{"encrypted_key":"not base64!"}}"#), KeyEntry::Invalid);
        assert_eq!(
            parse(format!(r#"{{"os_crypt":{{"encrypted_key":"{}"}}}}"#, STANDARD.encode(b"XXXXXabc")).as_bytes()),
            KeyEntry::Invalid
        );
        assert_eq!(parse(b"not json"), KeyEntry::Invalid);
        assert_eq!(parse(b"[1]"), KeyEntry::Invalid);
    }

    #[test]
    fn create_new_never_replaces() {
        let dir = tempfile::tempdir().unwrap();
        assert!(create_new(dir.path(), "first").unwrap());
        assert!(!create_new(dir.path(), "second").unwrap());
        assert_eq!(std::fs::read_to_string(path(dir.path())).unwrap(), "first");
        let names: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(names.len(), 1, "no temp file left: {names:?}");
    }
}
