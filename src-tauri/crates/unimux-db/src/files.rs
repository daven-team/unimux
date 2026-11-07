//! The small private files of the DB layer (port of src/main/ssh/files.ts, which db/vault.ts and db/history.ts use): the
//! `db/` directory is 0700 and its files 0600 on POSIX (on Windows the per-user %APPDATA% ACL applies), every write is
//! atomic, and an unparsable file is kept as a timestamped backup instead of being overwritten.
//!
//! S1 ports the same helpers for the SSH stores; when it lands both can share one copy in unimux-core.

use std::fs;
use std::io;
use std::path::Path;

use serde_json::Value;
use unimux_core::atomic_write::{AtomicWriteOptions, atomic_write};
use unimux_core::js_json;
use unimux_core::json_file::backup_path;

/// `readJsonFile`: what reading a JSON file gave.
#[derive(Debug, Clone, PartialEq)]
pub enum ReadJson {
    Ok(Value),
    /// There is no file.
    Missing,
    /// The file could not be read, or did not parse (then it was moved to `<file>.bak-<ISO>` first).
    Failed,
}

/// `readFileSync(file, 'utf8')`: invalid UTF-8 becomes U+FFFD like Node's decoder (a BOM stays, and JSON.parse refuses it).
pub fn read_text(file: &Path) -> io::Result<String> {
    let bytes = fs::read(file)?;
    Ok(match String::from_utf8(bytes) {
        Ok(s) => s,
        Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned(),
    })
}

/// `readJsonFile(file)`: missing, unreadable, or unparsable (moved aside to a timestamped backup, never overwritten).
pub fn read_json_file(file: &Path) -> ReadJson {
    if !exists(file) {
        return ReadJson::Missing;
    }
    let Ok(text) = read_text(file) else { return ReadJson::Failed };
    match js_json::parse(&text) {
        Ok(v) => ReadJson::Ok(v),
        Err(_) => {
            let _ = fs::rename(file, backup_path(file));
            ReadJson::Failed
        }
    }
}

/// `existsSync(file)` (follows links; a dangling link does not exist).
pub fn exists(file: &Path) -> bool {
    file.metadata().is_ok()
}

/// `ensurePrivateDir(dir)`: created with its parents, 0700 on POSIX.
pub fn ensure_private_dir(dir: &Path) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(dir, fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// `writePrivateFile(file, text)`: atomic (unique temp file, flushed, renamed with retries), 0600 on POSIX.
pub fn write_private_file(file: &Path, text: &str) -> io::Result<()> {
    atomic_write(file, text.as_bytes(), &AtomicWriteOptions { mode: Some(0o600), ..Default::default() })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(file, fs::Permissions::from_mode(0o600))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_unparsable_file_is_moved_aside_and_a_missing_one_is_missing() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("x.json");
        assert_eq!(read_json_file(&file), ReadJson::Missing);
        fs::write(&file, "{ not json").unwrap();
        assert_eq!(read_json_file(&file), ReadJson::Failed);
        assert!(!file.exists());
        let backups: Vec<_> = fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        assert_eq!(backups.len(), 1);
        assert!(backups[0].starts_with("x.json.bak-"), "{backups:?}");
        write_private_file(&file, "{\"a\":1}").unwrap();
        assert_eq!(read_json_file(&file), ReadJson::Ok(serde_json::json!({ "a": 1 })));
    }
}
