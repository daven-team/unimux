//! The WebView2 user data folder pre-check (PLAN.md U2 / SP6, user requirement 2026-11-06).
//!
//! When WebView2 is handed a user data folder it cannot create or write (a file in its place, a read-only or foreign-owned
//! folder, an `EBWebView` file inside it), Edge shows its own modal "cannot create data directory" message box on the desktop
//! before the environment fails. A user must never see that box: the app and the update window check the folder first and,
//! when it is not usable, take a fresh folder under %TEMP% (or, the update window, show no window at all).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Why a folder cannot be a WebView2 user data folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unusable {
    pub path: PathBuf,
    pub reason: String,
}

impl std::fmt::Display for Unusable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.path.display(), self.reason)
    }
}

/// Creates and removes a probe file in `dir`.
fn probe_write(dir: &Path) -> io::Result<()> {
    let probe = dir.join(format!(".unimux-webview-probe-{}", std::process::id()));
    let written = (|| -> io::Result<()> {
        use std::io::Write as _;
        let mut file = fs::File::options().write(true).create_new(true).open(&probe)?;
        file.write_all(b"x")?;
        Ok(())
    })();
    let _ = fs::remove_file(&probe);
    written
}

/// Checks that `dir` can serve as a WebView2 user data folder: it is a directory (created when missing), this user can create
/// a file in it, and its `EBWebView` child (where WebView2 keeps the profile, and the folder Edge's "can't read and write to
/// its data directory" box is about) is a directory this user can create (when absent) and write. Leaves nothing behind but
/// the folder itself (an `EBWebView` created for the check is removed again).
pub fn check_folder(dir: &Path) -> Result<(), Unusable> {
    let fail = |reason: String| Unusable { path: dir.to_path_buf(), reason };
    // A link to a folder counts as the folder.
    if dir.exists() && !dir.is_dir() {
        return Err(fail("not a directory".into()));
    }
    fs::create_dir_all(dir).map_err(|e| fail(format!("cannot be created ({e})")))?;
    if !dir.is_dir() {
        return Err(fail("not a directory".into()));
    }
    let profile = dir.join("EBWebView");
    if fs::symlink_metadata(&profile).is_ok() && !profile.is_dir() {
        return Err(fail("EBWebView is not a directory".into()));
    }
    probe_write(dir).map_err(|e| fail(format!("not writable ({e})")))?;
    let created = match fs::create_dir(&profile) {
        Ok(()) => true,
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists && profile.is_dir() => false,
        Err(e) => return Err(fail(format!("EBWebView cannot be created ({e})"))),
    };
    let written = probe_write(&profile);
    if created {
        let _ = fs::remove_dir(&profile);
    }
    written.map_err(|e| fail(format!("EBWebView not writable ({e})")))
}

/// The folder to hand to WebView2: `preferred` when [`check_folder`] accepts it, else the first usable of `fallbacks`; None
/// when none is usable (the caller then creates no webview, so WebView2 never shows its dialog). The second value lists the
/// folders refused on the way (for the log).
pub fn choose_folder(preferred: &Path, fallbacks: &[PathBuf]) -> (Option<PathBuf>, Vec<Unusable>) {
    let mut refused = Vec::new();
    for dir in std::iter::once(preferred).chain(fallbacks.iter().map(PathBuf::as_path)) {
        match check_folder(dir) {
            Ok(()) => return (Some(dir.to_path_buf()), refused),
            Err(e) => refused.push(e),
        }
    }
    (None, refused)
}

/// A stable fallback folder under %TEMP% for the main app's WebView2 profile of `data_dir`: `%TEMP%\unimux-webview2\<hash>`
/// (one per data dir, so parallel `MC_DATA_DIR` runs never share a profile and a restart finds the same one).
pub fn temp_fallback_for(data_dir: &Path) -> PathBuf {
    // FNV-1a 64 of the lower-case path: stable across runs and builds (std's hasher is not).
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in data_dir.to_string_lossy().to_lowercase().bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    std::env::temp_dir().join("unimux-webview2").join(format!("{hash:016x}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_folder_is_created_and_accepted_without_leftovers() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("a").join("webview2");
        check_folder(&dir).unwrap();
        assert!(dir.is_dir());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 0, "the probe file is removed");
        // An existing profile is fine.
        fs::create_dir_all(dir.join("EBWebView")).unwrap();
        check_folder(&dir).unwrap();
    }

    #[test]
    fn a_file_in_place_of_the_folder_is_refused_and_left_alone() {
        // The SP6 broken-WebView2 case that made Edge show its dialog: a file where the folder should be.
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("unimux-updater").join("webview2-broken");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, b"not a folder").unwrap();
        let err = check_folder(&file).unwrap_err();
        assert!(err.reason.contains("not a directory"), "{err}");
        assert_eq!(fs::read(&file).unwrap(), b"not a folder");
        // Below a file: cannot be created.
        assert!(check_folder(&file.join("child")).is_err());
    }

    #[test]
    fn an_ebwebview_file_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        fs::write(tmp.path().join("EBWebView"), b"x").unwrap();
        let err = check_folder(tmp.path()).unwrap_err();
        assert!(err.reason.contains("EBWebView"), "{err}");
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_this_user_cannot_write_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("locked");
        fs::create_dir_all(&dir).unwrap();
        let icacls = |args: &[&str]| std::process::Command::new("icacls").arg(&dir).args(args).output().unwrap().status;
        assert!(icacls(&["/deny", "*S-1-1-0:(W)"]).success());
        let result = check_folder(&dir);
        assert!(icacls(&["/remove:d", "*S-1-1-0"]).success());
        let err = result.unwrap_err();
        assert!(err.reason.contains("not writable"), "{err}");
        check_folder(&dir).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn an_ebwebview_folder_this_user_cannot_write_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("webview2");
        let profile = dir.join("EBWebView");
        fs::create_dir_all(&profile).unwrap();
        let icacls = |args: &[&str]| std::process::Command::new("icacls").arg(&profile).args(args).output().unwrap().status;
        assert!(icacls(&["/deny", "*S-1-1-0:(W)"]).success());
        let result = check_folder(&dir);
        assert!(icacls(&["/remove:d", "*S-1-1-0"]).success());
        let err = result.unwrap_err();
        assert!(err.reason.contains("EBWebView not writable"), "{err}");
        check_folder(&dir).unwrap();
        assert_eq!(fs::read_dir(&profile).unwrap().count(), 0, "the probe file is removed");
    }

    #[cfg(windows)]
    #[test]
    fn a_folder_that_allows_files_but_no_subfolders_is_refused() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("webview2");
        fs::create_dir_all(&dir).unwrap();
        let icacls = |args: &[&str]| std::process::Command::new("icacls").arg(&dir).args(args).output().unwrap().status;
        // AD: append data, on a folder the right to create subfolders.
        assert!(icacls(&["/deny", "*S-1-1-0:(AD)"]).success());
        let result = check_folder(&dir);
        assert!(icacls(&["/remove:d", "*S-1-1-0"]).success());
        let err = result.unwrap_err();
        assert!(err.reason.contains("EBWebView cannot be created"), "{err}");
        check_folder(&dir).unwrap();
        assert!(!dir.join("EBWebView").exists(), "an EBWebView made for the check is removed");
    }

    #[test]
    fn the_first_usable_folder_wins() {
        let tmp = tempfile::tempdir().unwrap();
        let broken = tmp.path().join("broken");
        fs::write(&broken, b"x").unwrap();
        let good = tmp.path().join("good");
        let (chosen, refused) = choose_folder(&broken, &[broken.join("x"), good.clone()]);
        assert_eq!(chosen, Some(good));
        assert_eq!(refused.len(), 2);
        let (none, refused) = choose_folder(&broken, &[]);
        assert_eq!((none, refused.len()), (None, 1));
        let ok = tmp.path().join("ok");
        assert_eq!(choose_folder(&ok, &[tmp.path().join("other")]).0, Some(ok));
    }

    #[test]
    fn the_temp_fallback_is_stable_per_data_dir() {
        let a = temp_fallback_for(Path::new("C:\\Users\\x\\AppData\\Roaming\\unimux"));
        assert_eq!(a, temp_fallback_for(Path::new("c:\\users\\X\\appdata\\roaming\\UNIMUX")));
        assert_ne!(a, temp_fallback_for(Path::new("D:\\scratch\\data")));
        assert_eq!(a.parent().unwrap().file_name().unwrap(), "unimux-webview2");
    }
}
