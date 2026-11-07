//! File system probes of the renderer (src/main/fsProbe.ts and index.ts `fs:pathKinds`): whether a project folder exists, and
//! whether dropped paths are folders, files or gone. Blocking calls; the commands run them off the IPC threads and put the
//! 4 s limit of 1.1.4 around `fs:exists` (a folder on an offline network share can hang a check for the OS timeout).

use std::time::Duration;

use serde_json::Value;

use crate::jspath::{self, Flavor};

/// fsProbe.ts EXISTS_TIMEOUT_MS: after this the folder counts as unreachable.
pub const EXISTS_TIMEOUT: Duration = Duration::from_millis(4000);
/// index.ts `fs:pathKinds`: more paths than this answer `[]`.
pub const PATH_KINDS_MAX: usize = 200;

/// The path `fs:exists` checks, or None for what 1.1.4 answered false at once (not a string, empty, a NUL inside).
pub fn exists_arg(path: &Value) -> Option<String> {
    path.as_str().filter(|p| !p.is_empty() && !p.contains('\0')).map(str::to_string)
}

/// `fs.promises.access(path)` (F_OK). Windows: libuv asks GetFileAttributesW, which does not follow a final link (a dangling
/// link exists); Unix: access(2), which follows it. Node hands libuv the `toNamespacedPath` form (`\\?\C:\...`), so a
/// folder past MAX_PATH exists and a trailing dot or space is kept (`C:\Windows.` is missing), with no longPathAware
/// manifest needed.
pub fn path_exists_now(path: &str) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Storage::FileSystem::{GetFileAttributesW, INVALID_FILE_ATTRIBUTES};
        use windows::core::PCWSTR;
        let namespaced = jspath::to_namespaced_path(Flavor::Win32, path);
        let wide: Vec<u16> = std::ffi::OsStr::new(&namespaced).encode_wide().chain(std::iter::once(0)).collect();
        // SAFETY: a NUL-terminated UTF-16 path that lives across the call.
        unsafe { GetFileAttributesW(PCWSTR(wide.as_ptr())) != INVALID_FILE_ATTRIBUTES }
    }
    #[cfg(unix)]
    {
        let Ok(c) = std::ffi::CString::new(path) else { return false };
        // SAFETY: a NUL-terminated path that lives across the call.
        unsafe { libc::access(c.as_ptr(), libc::F_OK) == 0 }
    }
    #[cfg(not(any(windows, unix)))]
    {
        std::path::Path::new(path).exists()
    }
}

/// The checked list of `fs:pathKinds`: None answers `[]` (not an array, more than 200 entries).
pub fn path_kinds_arg(paths: &Value) -> Option<&Vec<Value>> {
    paths.as_array().filter(|list| list.len() <= PATH_KINDS_MAX)
}

/// One entry of `fs:pathKinds`: `'dir'`, `'file'` or None (not a string, not absolute in Node's sense, a NUL inside, gone,
/// or neither a folder nor a regular file). `stat` follows links like Node's, and gets the `toNamespacedPath` form like
/// Node's, so `dir.` and `dir ` are gone instead of Win32 trimming them to `dir`.
pub fn path_kind(path: &Value) -> Option<&'static str> {
    let p = path.as_str()?;
    if !jspath::is_absolute(Flavor::native(), p) || p.contains('\0') {
        return None;
    }
    let meta = std::fs::metadata(jspath::to_namespaced_path(Flavor::native(), p)).ok()?;
    if meta.is_dir() {
        Some("dir")
    } else if meta.is_file() {
        Some("file")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exists_answers_like_1_1_4() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path().to_string_lossy().into_owned();
        assert!(path_exists_now(&d));
        assert!(!path_exists_now(&dir.path().join("nope").to_string_lossy()));
        std::fs::write(dir.path().join("f.txt"), "x").unwrap();
        assert!(path_exists_now(&dir.path().join("f.txt").to_string_lossy()));
        assert_eq!(exists_arg(&json!("")), None);
        assert_eq!(exists_arg(&json!("a\0b")), None);
        assert_eq!(exists_arg(&json!(5)), None);
        assert_eq!(exists_arg(&json!(d)), Some(d));
    }

    #[test]
    fn path_kinds_tell_folders_files_and_gone_apart() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("f.txt"), "x").unwrap();
        let d = dir.path().to_string_lossy().into_owned();
        let f = dir.path().join("f.txt").to_string_lossy().into_owned();
        let gone = dir.path().join("gone").to_string_lossy().into_owned();
        assert_eq!(path_kind(&json!(d)), Some("dir"));
        assert_eq!(path_kind(&json!(f)), Some("file"));
        assert_eq!(path_kind(&json!(gone)), None);
        assert_eq!(path_kind(&json!("relative.txt")), None);
        assert_eq!(path_kind(&json!(42)), None);
        assert_eq!(path_kind(&json!(format!("{f}\0"))), None);
        assert!(path_kinds_arg(&json!("x")).is_none());
        assert!(path_kinds_arg(&json!(vec![""; 201])).is_none());
        assert_eq!(path_kinds_arg(&json!(vec![""; 200])).map(Vec::len), Some(200));
    }

    #[cfg(windows)]
    #[test]
    fn a_dangling_link_exists_on_windows_like_libuv_access() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        std::fs::create_dir(&target).unwrap();
        let link = dir.path().join("link");
        junction::create(&target, &link).unwrap();
        std::fs::remove_dir(&target).unwrap();
        // GetFileAttributesW sees the junction itself; stat (pathKinds) follows it and finds nothing.
        assert!(path_exists_now(&link.to_string_lossy()));
        assert_eq!(path_kind(&json!(link.to_string_lossy())), None);
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_past_max_path_exists_like_node_access() {
        // Node turns the path into \\?\C:\... before libuv calls GetFileAttributesW; the app has no longPathAware manifest.
        let dir = tempfile::tempdir().unwrap();
        let mut long = dir.path().to_path_buf();
        while long.as_os_str().len() <= 300 {
            long.push("a-folder-name-of-forty-characters-xxxxx");
        }
        std::fs::create_dir_all(&long).unwrap();
        std::fs::write(long.join("f.txt"), "x").unwrap();
        let l = long.to_string_lossy().into_owned();
        assert!(l.len() > 300, "{}", l.len());
        assert!(path_exists_now(&l));
        assert!(path_exists_now(&format!("{l}\\f.txt")));
        assert!(!path_exists_now(&format!("{l}\\gone")));
        assert_eq!(path_kind(&json!(l)), Some("dir"));
        assert_eq!(path_kind(&json!(format!("{l}\\f.txt"))), Some("file"));
    }

    #[cfg(windows)]
    #[test]
    fn a_trailing_dot_or_space_is_kept_like_node() {
        // Win32 drops a trailing dot or space (`dir.` is `dir`); Node's \\?\ form keeps it, so 1.1.4 found nothing there.
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("dir")).unwrap();
        std::fs::write(dir.path().join("f.txt"), "x").unwrap();
        let d = dir.path().join("dir").to_string_lossy().into_owned();
        let f = dir.path().join("f.txt").to_string_lossy().into_owned();
        assert!(path_exists_now(&d));
        for p in [format!("{d}."), format!("{d} "), format!("{f}."), format!("{f} ")] {
            assert!(!path_exists_now(&p), "{p:?}");
            assert_eq!(path_kind(&json!(p)), None, "{p:?}");
        }
        // A relative path and forward slashes still resolve the way Node's do.
        assert!(path_exists_now(&d.replace('\\', "/")));
        assert_eq!(path_kind(&json!(d.replace('\\', "/"))), Some("dir"));
    }

    #[cfg(windows)]
    #[test]
    fn a_rooted_path_without_a_drive_counts_as_absolute_like_node() {
        // path.win32.isAbsolute('\\x') is true (the current drive's root); Rust's Path::is_absolute says no.
        let cwd = std::env::current_dir().unwrap().to_string_lossy().into_owned();
        let rooted = &cwd[2..];
        assert!(rooted.starts_with('\\'), "{cwd}");
        assert_eq!(path_kind(&json!(rooted)), Some("dir"));
    }
}
