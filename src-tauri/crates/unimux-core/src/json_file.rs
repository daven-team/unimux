//! Small JSON files of the data dir (port of the helpers in src/main/ssh/files.ts): the private files of the SSH stores
//! (vault, known hosts, command history) and the DB stores that share them.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::atomic_write::{AtomicWriteOptions, atomic_write};
use crate::time::{file_stamp, now_ms};

/// What [`read_json_file`] found (`readJsonFile` of files.ts).
#[derive(Debug, Clone, PartialEq)]
pub enum JsonRead {
    /// Parsed like `JSON.parse` (infinities kept as marks, see [`crate::js_json::parse_keeping_infinity`]).
    Value(Value),
    /// No file (`existsSync` false).
    Missing,
    /// The file exists but could not be read, or it was unparsable and has been moved to `<file>.bak-<ISO>` (if that
    /// move failed it is still there; the caller tells the two apart by whether the file exists now).
    Failed,
}

/// `readJsonFile(file)`: a missing file, one that cannot be read, or the parsed JSON. An unparsable file is kept as a
/// timestamped backup ([`backup_path`]), never silently overwritten. The text is read like `readFileSync(file, 'utf8')`
/// (invalid UTF-8 becomes U+FFFD, a BOM stays and makes the parse fail as in JSON.parse).
pub fn read_json_file(file: &Path) -> JsonRead {
    if !file.exists() {
        return JsonRead::Missing;
    }
    let Ok(bytes) = fs::read(file) else { return JsonRead::Failed };
    let text = String::from_utf8_lossy(&bytes);
    match crate::js_json::parse_keeping_infinity(&text) {
        Ok(value) => JsonRead::Value(value),
        Err(_) => {
            let _ = fs::rename(file, backup_path(file));
            JsonRead::Failed
        }
    }
}

/// `ensurePrivateDir(dir)`: created with its parents; 0700 on POSIX (best effort; on Windows the per-user ACL applies).
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    fs::create_dir_all(dir)?;
    Ok(())
}

/// `writePrivateFile(file, text)`: the atomic write (a unique temp file, flushed, renamed with retries) with mode 0600,
/// and the mode set again on POSIX for a file that existed before.
pub fn write_private_file(file: &Path, text: &str) -> io::Result<()> {
    atomic_write(file, text.as_bytes(), &AtomicWriteOptions { mode: Some(0o600), ..AtomicWriteOptions::default() })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(file, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

/// `<file>.bak-<ISO with : and . as ->` and `-2`, `-3`... when that name is taken (an unreadable file is kept, never overwritten).
pub fn backup_path(file: &Path) -> PathBuf {
    backup_path_at(file, now_ms())
}

/// [`backup_path`] for a given time (tests).
pub fn backup_path_at(file: &Path, ms: i64) -> PathBuf {
    let mut base = file.as_os_str().to_owned();
    base.push(format!(".bak-{}", file_stamp(ms)));
    let base = PathBuf::from(base);
    let mut candidate = base.clone();
    let mut n = 2;
    while candidate.symlink_metadata().is_ok() {
        let mut next = base.as_os_str().to_owned();
        next.push(format!("-{n}"));
        candidate = PathBuf::from(next);
        n += 1;
    }
    candidate
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbered_when_taken() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("state.json");
        let first = backup_path_at(&file, 1_762_430_400_123);
        assert!(first.to_string_lossy().ends_with("state.json.bak-2025-11-06T12-00-00-123Z"));
        std::fs::write(&first, "x").unwrap();
        let second = backup_path_at(&file, 1_762_430_400_123);
        assert!(second.to_string_lossy().ends_with("state.json.bak-2025-11-06T12-00-00-123Z-2"));
    }

    #[test]
    fn reads_missing_unreadable_and_corrupt_files_like_files_ts() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("ssh").join("vault.json");
        assert_eq!(read_json_file(&file), JsonRead::Missing);
        ensure_private_dir(file.parent().unwrap()).unwrap();
        write_private_file(&file, "{\"a\":1}").unwrap();
        assert_eq!(read_json_file(&file), JsonRead::Value(serde_json::json!({"a": 1})));
        // A directory where the file belongs: it exists but cannot be read; nothing is moved.
        let blocked = dir.path().join("blocked.json");
        fs::create_dir_all(blocked.join("child")).unwrap();
        assert_eq!(read_json_file(&blocked), JsonRead::Failed);
        assert!(blocked.join("child").exists());
        // Unparsable (a BOM counts, as in JSON.parse): moved to a .bak-<ISO> with its bytes.
        fs::write(&file, "\u{feff}{\"a\":1}").unwrap();
        assert_eq!(read_json_file(&file), JsonRead::Failed);
        assert!(!file.exists());
        let backups: Vec<_> = fs::read_dir(file.parent().unwrap())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("vault.json.bak-"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read_to_string(backups[0].path()).unwrap(), "\u{feff}{\"a\":1}");
    }

    #[cfg(unix)]
    #[test]
    fn private_modes_on_posix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let sub = dir.path().join("ssh");
        ensure_private_dir(&sub).unwrap();
        write_private_file(&sub.join("a.json"), "x").unwrap();
        assert_eq!(fs::metadata(&sub).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(sub.join("a.json")).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
