//! The database files of SQLite connections (port of src/main/db/sqliteFiles.ts): a new, empty one at a path (an empty file
//! is a valid SQLite database); an existing file is never written over. Only paths go back to the renderer. The dialogs
//! (`db:sqlite:pick`, the save dialog of `db:sqlite:create`) are the app's.

use std::fs::OpenOptions;
use std::path::Path;

use serde_json::{Value, json};
use unimux_state::normalize::js;

use crate::sql::limits;

/// `validDbFilePath`: an absolute file path of this computer (Windows `C:\...` or `\\server\share\...`, POSIX `/...`), as a
/// SQLite connection stores it.
pub fn valid_db_file_path(v: &str) -> bool {
    let n = js::len16(v);
    if !(2..=limits::CA_PATH).contains(&n) || js::has_control(v) || js::trim(v) != v {
        return false;
    }
    let b = v.as_bytes();
    let absolute = (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/'))
        || (b.len() >= 3 && b[0] == b'\\' && b[1] == b'\\' && b[2] != b'\\' && b[2] != b'/')
        || b[0] == b'/';
    absolute && !v.ends_with('\\') && !v.ends_with('/')
}

/// `DbSqliteCreateResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CreateResult {
    Ok { path: String, existed: bool },
    Err(&'static str),
}

impl CreateResult {
    pub fn to_json(&self) -> Value {
        match self {
            CreateResult::Ok { path, existed } => json!({ "ok": true, "path": path, "existed": existed }),
            CreateResult::Err(error) => json!({ "ok": false, "error": error }),
        }
    }
}

/// `createSqliteFile(path, allowExisting)`: a new empty database file (exclusive create). `allow_existing`: a file the save
/// dialog confirmed is opened as it is (`existed`), if it is a file.
pub fn create_sqlite_file(path: &str, allow_existing: bool) -> CreateResult {
    if !valid_db_file_path(path) {
        return CreateResult::Err("invalid");
    }
    let p = Path::new(path);
    match p.metadata() {
        Ok(info) => {
            return if allow_existing && info.is_file() {
                CreateResult::Ok { path: path.to_string(), existed: true }
            } else {
                CreateResult::Err("exists")
            };
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        // statSync throws for anything but a missing entry.
        Err(_) => return CreateResult::Err("failed"),
    }
    let dir_ok = p.parent().filter(|d| !d.as_os_str().is_empty()).is_some_and(|d| d.metadata().is_ok_and(|m| m.is_dir()));
    if !dir_ok {
        return CreateResult::Err("noFolder");
    }
    match OpenOptions::new().write(true).create_new(true).open(p) {
        Ok(_) => CreateResult::Ok { path: path.to_string(), existed: false },
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => CreateResult::Err("exists"),
        Err(_) => CreateResult::Err("failed"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_an_empty_file_once_and_never_over_an_existing_one() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.sqlite").to_string_lossy().into_owned();
        assert_eq!(create_sqlite_file(&path, false), CreateResult::Ok { path: path.clone(), existed: false });
        assert_eq!(std::fs::metadata(&path).unwrap().len(), 0);
        assert_eq!(create_sqlite_file(&path, false), CreateResult::Err("exists"));
        assert_eq!(create_sqlite_file(&path, true), CreateResult::Ok { path: path.clone(), existed: true });
        let folder = dir.path().to_string_lossy().into_owned();
        assert_eq!(create_sqlite_file(&folder, true), CreateResult::Err("exists"));
        let missing = dir.path().join("nope").join("x.db").to_string_lossy().into_owned();
        assert_eq!(create_sqlite_file(&missing, false), CreateResult::Err("noFolder"));
        assert_eq!(create_sqlite_file("relative.db", false), CreateResult::Err("invalid"));
    }

    #[test]
    fn file_paths_must_be_absolute_and_name_a_file() {
        for ok in ["C:\\data\\shop.sqlite", "c:/x.db", "\\\\server\\share\\a.db", "/home/u/a.db"] {
            assert!(valid_db_file_path(ok), "{ok}");
        }
        for bad in ["relative.db", "C:", "C:x.db", "\\\\\\x", "/", "/tmp/", "C:\\dir\\", " /a.db", "/a\u{7}.db", "\\x"] {
            assert!(!valid_db_file_path(bad), "{bad}");
        }
    }
}
