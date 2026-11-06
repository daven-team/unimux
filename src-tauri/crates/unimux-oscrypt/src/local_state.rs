//! Chromium's `Local State` file (JSON in the user data dir, Electron's `userData` = unimux's data dir): only
//! `os_crypt.encrypted_key` is read. A file with a usable key is never rewritten. Otherwise unimux does what Chromium 156's
//! OSCryptImpl::Init does when 1.1.4 starts (components/os_crypt/sync/os_crypt_win.cc), so both versions end up with the
//! same key:
//!
//! - no file (a fresh 1.2.0 install): it is created in the shape Chromium reads, never replacing one that appeared meanwhile;
//! - no `os_crypt.encrypted_key` (kKeyDoesNotExist), or a DPAPI blob that does not unwrap (kDecryptionFailed: another
//!   Windows user's data dir, a password reset by an administrator): a new key is stored, every other pref is kept;
//! - not JSON: moved aside to `Local State.bad` like Chromium's JsonPrefStore does, then created anew; JSON that is not an
//!   object is replaced (Chromium starts with empty prefs there and writes them back);
//! - a key that is not base64 or has no `DPAPI` prefix (kInvalidKeyFormat): unavailable, the file is left alone.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde_json::{Map, Value};

pub const FILE_NAME: &str = "Local State";
/// Where Chromium moves a `Local State` that is not JSON (`path.ReplaceExtension(".bad")`).
pub const BAD_FILE_NAME: &str = "Local State.bad";
/// Chromium writes `"DPAPI"` + the DPAPI blob of the 32-byte key, base64 encoded.
pub const DPAPI_PREFIX: &[u8] = b"DPAPI";

pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(FILE_NAME)
}

/// What `Local State` says about the OSCrypt key.
#[derive(Debug, PartialEq, Eq)]
pub enum KeyEntry {
    /// The DPAPI blob (the `DPAPI` prefix already removed; an empty one fails to unwrap, as in Chromium).
    Dpapi(Vec<u8>),
    /// A JSON object without `os_crypt.encrypted_key`.
    Missing,
    /// The key is there but is not a base64 string with the `DPAPI` prefix (Chromium: kInvalidKeyFormat, unavailable).
    Invalid,
    /// Valid JSON that is not an object.
    NotObject,
    /// Not JSON at all.
    NotJson,
}

/// Reads `os_crypt.encrypted_key` out of the text of `Local State`. Other keys (`os_crypt.app_bound_encrypted_key`,
/// `os_crypt.audit_enabled`, anything Chromium adds) are ignored.
pub fn parse(text: &[u8]) -> KeyEntry {
    let Ok(value) = serde_json::from_slice::<Value>(text) else { return KeyEntry::NotJson };
    if !value.is_object() {
        return KeyEntry::NotObject;
    }
    let Some(encoded) = value.get("os_crypt").and_then(|o| o.get("encrypted_key")) else { return KeyEntry::Missing };
    let Some(encoded) = encoded.as_str() else { return KeyEntry::Invalid };
    match STANDARD.decode(encoded) {
        Ok(bytes) => match bytes.strip_prefix(DPAPI_PREFIX) {
            Some(blob) => KeyEntry::Dpapi(blob.to_vec()),
            None => KeyEntry::Invalid,
        },
        Err(_) => KeyEntry::Invalid,
    }
}

fn encoded_key(dpapi_blob: &[u8]) -> String {
    let mut bytes = DPAPI_PREFIX.to_vec();
    bytes.extend_from_slice(dpapi_blob);
    STANDARD.encode(bytes)
}

/// The text of a fresh `Local State` holding only the key, as Chromium serializes it (compact JSON, keys sorted). With
/// `audit_enabled: true` Chromium keeps the key blob as it is (without it, it re-wraps the key with CRYPTPROTECT_AUDIT).
pub fn fresh_text(dpapi_blob: &[u8]) -> String {
    serde_json::json!({ "os_crypt": { "audit_enabled": true, "encrypted_key": encoded_key(dpapi_blob) } }).to_string()
}

/// `original` (the current text of `Local State`) with a new key, as Chromium's EncryptAndStoreKey leaves it: every other
/// pref kept, `os_crypt.encrypted_key` and `os_crypt.audit_enabled` set, compact JSON with sorted keys. Text that is not a
/// JSON object gives `fresh_text`.
pub fn with_key(original: &[u8], dpapi_blob: &[u8]) -> String {
    let Ok(Value::Object(mut root)) = serde_json::from_slice::<Value>(original) else { return fresh_text(dpapi_blob) };
    let os_crypt = root.entry("os_crypt").or_insert_with(|| Value::Object(Map::new()));
    if !os_crypt.is_object() {
        *os_crypt = Value::Object(Map::new());
    }
    if let Value::Object(os_crypt) = os_crypt {
        os_crypt.insert("audit_enabled".into(), Value::Bool(true));
        os_crypt.insert("encrypted_key".into(), Value::String(encoded_key(dpapi_blob)));
    }
    sorted(Value::Object(root)).to_string()
}

/// base::Value::Dict keeps its keys sorted, so Chromium writes them sorted (serde_json here keeps insertion order).
fn sorted(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<_> = map.into_iter().collect();
            entries.sort_by(|a, b| a.0.cmp(&b.0));
            Value::Object(entries.into_iter().map(|(k, v)| (k, sorted(v))).collect())
        }
        Value::Array(items) => Value::Array(items.into_iter().map(sorted).collect()),
        other => other,
    }
}

/// A temp file next to `Local State`, unique per call (pid, a process-wide counter and random bytes) and opened with
/// create_new, so two writers never share or truncate one. Removed on drop whatever happened: after a failed write, after
/// the hard link (the real name keeps the content) and after a rename (the name is gone already).
struct Temp(PathBuf);

impl Temp {
    fn write(data_dir: &Path, text: &str) -> std::io::Result<Temp> {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let mut random = [0u8; 6];
        getrandom::fill(&mut random).map_err(std::io::Error::other)?;
        let suffix: String = random.iter().map(|b| format!("{b:02x}")).collect();
        let count = COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = data_dir.join(format!("{FILE_NAME}.unimux-{}-{count}-{suffix}.tmp", std::process::id()));
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).open(&path)?;
        // From here on the guard removes the file on every path, also when writing fails (a full disk).
        let temp = Temp(path);
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        Ok(temp)
    }
}

impl Drop for Temp {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Creates `Local State` only if no file of that name exists, never replacing one that appeared meanwhile (Electron may
/// start at the same moment): the text goes to a temp file first, then a hard link gives it the real name, which fails
/// when the name is taken. Returns false when someone else created the file first.
pub fn create_new(data_dir: &Path, text: &str) -> std::io::Result<bool> {
    let temp = Temp::write(data_dir, text)?;
    match std::fs::hard_link(&temp.0, path(data_dir)) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(e) => Err(e),
    }
}

/// Replaces `Local State` with `text` in one step (temp file + rename, like Chromium's ImportantFileWriter).
pub fn replace(data_dir: &Path, text: &str) -> std::io::Result<()> {
    let temp = Temp::write(data_dir, text)?;
    std::fs::rename(&temp.0, path(data_dir))
}

/// Moves a `Local State` that is not JSON to `Local State.bad` (replacing an older one), as Chromium's JsonPrefStore keeps
/// it "for debugging purposes" before it starts with empty prefs.
pub fn set_aside_bad(data_dir: &Path) -> std::io::Result<()> {
    std::fs::rename(path(data_dir), data_dir.join(BAD_FILE_NAME))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(dir: &Path) -> Vec<String> {
        let mut names: Vec<_> =
            std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }

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
        assert_eq!(parse(br#"{"os_crypt":"x"}"#), KeyEntry::Missing);
        assert_eq!(parse(br#"{"os_crypt":{"encrypted_key":5}}"#), KeyEntry::Invalid);
        assert_eq!(parse(br#"{"os_crypt":{"encrypted_key":"not base64!"}}"#), KeyEntry::Invalid);
        assert_eq!(
            parse(format!(r#"{{"os_crypt":{{"encrypted_key":"{}"}}}}"#, STANDARD.encode(b"XXXXXabc")).as_bytes()),
            KeyEntry::Invalid
        );
        assert_eq!(
            parse(format!(r#"{{"os_crypt":{{"encrypted_key":"{}"}}}}"#, STANDARD.encode(b"DPAPI")).as_bytes()),
            KeyEntry::Dpapi(Vec::new())
        );
        assert_eq!(parse(b"not json"), KeyEntry::NotJson);
        assert_eq!(parse(b"{broken"), KeyEntry::NotJson);
        assert_eq!(parse(b"[1]"), KeyEntry::NotObject);
    }

    #[test]
    fn with_key_keeps_other_prefs_and_sorts_like_chromium() {
        let original = br#"{"zeta":{"b":1,"a":[{"y":2,"x":1}]},"os_crypt":{"encrypted_key":"old","app_bound_encrypted_key":"QVBQQgAA"},"browser":{"enabled_labs_experiments":[]}}"#;
        assert_eq!(
            with_key(original, b"new"),
            format!(
                r#"{{"browser":{{"enabled_labs_experiments":[]}},"os_crypt":{{"app_bound_encrypted_key":"QVBQQgAA","audit_enabled":true,"encrypted_key":"{}"}},"zeta":{{"a":[{{"x":1,"y":2}}],"b":1}}}}"#,
                STANDARD.encode(b"DPAPInew")
            )
        );
        assert_eq!(parse(with_key(original, b"new").as_bytes()), KeyEntry::Dpapi(b"new".to_vec()));
        assert_eq!(with_key(br#"{"os_crypt":"x"}"#, b"k"), fresh_text(b"k"));
        assert_eq!(with_key(b"[1]", b"k"), fresh_text(b"k"));
        assert_eq!(with_key(b"{broken", b"k"), fresh_text(b"k"));
    }

    #[test]
    fn create_new_never_replaces() {
        let dir = tempfile::tempdir().unwrap();
        assert!(create_new(dir.path(), "first").unwrap());
        assert!(!create_new(dir.path(), "second").unwrap());
        assert_eq!(std::fs::read_to_string(path(dir.path())).unwrap(), "first");
        assert_eq!(names(dir.path()), [FILE_NAME], "no temp file left");
    }

    #[test]
    fn replace_and_set_aside_leave_no_temp_files() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(path(dir.path()), "{broken").unwrap();
        std::fs::write(dir.path().join(BAD_FILE_NAME), "older").unwrap();
        set_aside_bad(dir.path()).unwrap();
        assert_eq!(std::fs::read_to_string(dir.path().join(BAD_FILE_NAME)).unwrap(), "{broken");
        assert!(create_new(dir.path(), "new").unwrap());
        replace(dir.path(), "newer").unwrap();
        assert_eq!(std::fs::read_to_string(path(dir.path())).unwrap(), "newer");
        assert_eq!(names(dir.path()), [FILE_NAME, BAD_FILE_NAME]);
    }

    #[test]
    fn a_failed_write_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        // A data dir that is gone: nothing can be created, nothing is left behind.
        let gone = dir.path().join("gone");
        assert!(create_new(&gone, "x").is_err());
        assert!(replace(&gone, "x").is_err());
        // The rename fails (the target name is a directory): the temp file is removed anyway.
        std::fs::create_dir(path(dir.path())).unwrap();
        assert!(replace(dir.path(), "x").is_err());
        assert_eq!(names(dir.path()), [FILE_NAME]);
    }

    #[test]
    fn temp_names_are_unique_per_call() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (Temp::write(dir.path(), "a").unwrap(), Temp::write(dir.path(), "b").unwrap());
        assert_ne!(a.0, b.0);
        assert_eq!(std::fs::read_to_string(&a.0).unwrap(), "a");
        drop((a, b));
        assert!(names(dir.path()).is_empty());
    }
}
