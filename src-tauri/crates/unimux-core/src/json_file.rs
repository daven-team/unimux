//! Small JSON files of the data dir (port of the helpers in src/main/ssh/files.ts).

use std::path::{Path, PathBuf};

use crate::time::{file_stamp, now_ms};

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
}
