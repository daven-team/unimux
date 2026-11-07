//! Where the running app lives and whether it may be replaced in place (port of src/main/macUpdate/target.ts). Every file
//! system question goes through [`TargetFs`], so the refusal cases run on any platform.

use std::io;
use std::path::Path;

/// Why the app is not replaced in place; the updater then only offers the download page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MacRefusal {
    NotBundle,
    Translocated,
    ReadOnly,
    NotWritable,
    NotOwner,
    AppManagement,
}

impl MacRefusal {
    /// The `MacRefusal` string of the TS reference (`not-bundle`, `translocated`, ...).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotBundle => "not-bundle",
            Self::Translocated => "translocated",
            Self::ReadOnly => "read-only",
            Self::NotWritable => "not-writable",
            Self::NotOwner => "not-owner",
            Self::AppManagement => "app-management",
        }
    }

    pub const ALL: [MacRefusal; 6] =
        [Self::NotBundle, Self::Translocated, Self::ReadOnly, Self::NotWritable, Self::NotOwner, Self::AppManagement];

    /// `REFUSAL_MESSAGES` of engine.ts: the Polish catalog key (src/shared/macUpdateMessages.ts translates it).
    pub fn message(self) -> &'static str {
        match self {
            Self::NotBundle => {
                "Automatyczna instalacja jest niedostępna: aplikacja nie działa z pakietu .app. Pobierz nową wersję ręcznie."
            }
            Self::Translocated => {
                "Automatyczna instalacja jest niedostępna: macOS uruchomił aplikację z tymczasowej lokalizacji. Przenieś unimux do folderu Programy, uruchom go stamtąd lub pobierz nową wersję ręcznie."
            }
            Self::ReadOnly => {
                "Automatyczna instalacja jest niedostępna: aplikacja działa z dysku tylko do odczytu (np. z obrazu DMG). Przenieś ją do folderu Programy lub pobierz nową wersję ręcznie."
            }
            Self::NotWritable => {
                "Automatyczna instalacja jest niedostępna: brak zapisu w folderze z aplikacją. Pobierz nową wersję ręcznie."
            }
            Self::NotOwner => {
                "Automatyczna instalacja jest niedostępna: aplikacja należy do innego użytkownika. Pobierz nową wersję ręcznie."
            }
            Self::AppManagement => {
                "macOS nie pozwolił zmienić aplikacji. Zezwól unimuxowi w Ustawieniach systemowych (Prywatność i ochrona, Zarządzanie aplikacjami) albo pobierz nową wersję ręcznie."
            }
        }
    }
}

/// The file system questions of the target check.
pub trait TargetFs: Send + Sync {
    /// Fails (with the OS error) when the path cannot be written (`access(W_OK)`).
    fn access_writable(&self, path: &str) -> io::Result<()>;
    /// Owner (uid) of the path, None when it cannot be read.
    fn owner_of(&self, path: &str) -> Option<u32>;
    /// uid of the current user (None where the platform has no such thing).
    fn uid(&self) -> Option<u32>;
}

/// errno EROFS on macOS and Linux.
pub const EROFS: i32 = 30;

/// The real file system: access(2), lstat-free stat owner and getuid on Unix; elsewhere only the read-only flag.
pub struct RealTargetFs;

impl TargetFs for RealTargetFs {
    #[cfg(unix)]
    fn access_writable(&self, path: &str) -> io::Result<()> {
        let c = std::ffi::CString::new(path).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        // SAFETY: a valid NUL-terminated string; access(2) only reads it.
        if unsafe { libc::access(c.as_ptr(), libc::W_OK) } == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
    }

    #[cfg(not(unix))]
    fn access_writable(&self, path: &str) -> io::Result<()> {
        let meta = std::fs::metadata(path)?;
        if meta.permissions().readonly() && !meta.is_dir() {
            return Err(io::Error::from(io::ErrorKind::PermissionDenied));
        }
        Ok(())
    }

    #[cfg(unix)]
    fn owner_of(&self, path: &str) -> Option<u32> {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(path).ok().map(|m| m.uid())
    }

    #[cfg(not(unix))]
    fn owner_of(&self, _path: &str) -> Option<u32> {
        None
    }

    #[cfg(unix)]
    fn uid(&self) -> Option<u32> {
        // SAFETY: getuid never fails.
        Some(unsafe { libc::getuid() })
    }

    #[cfg(not(unix))]
    fn uid(&self) -> Option<u32> {
        None
    }
}

/// `/Applications/unimux.app/Contents/MacOS/unimux` -> `/Applications/unimux.app`; None outside a .app. The regex of the TS
/// reference, `^(\/.+?\.app)\/Contents\/MacOS\/[^/]+$` (no `s` flag: `.` stops at line terminators).
pub fn bundle_path_from_exec_path(exec_path: &str) -> Option<String> {
    let (dir, file) = exec_path.rsplit_once('/')?;
    if file.is_empty() {
        return None;
    }
    let bundle = dir.strip_suffix("/Contents/MacOS")?;
    let name = bundle.strip_prefix('/')?;
    let stem = name.strip_suffix(".app")?;
    if stem.is_empty() || name.contains(['\n', '\r', '\u{2028}', '\u{2029}']) {
        return None;
    }
    Some(bundle.to_string())
}

/// Where the previous version is kept next to the app while an update is applied (not an `.app`, so macOS ignores it).
pub fn backup_path_for(bundle: &str, from_version: &str) -> String {
    format!("{bundle}.old-{from_version}")
}

/// Where the verified new bundle waits, next to the installed one (same directory and volume, so the swap is a rename).
pub fn staged_path_for(bundle: &str, version: &str) -> String {
    format!("{bundle}.new-{version}")
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TargetResult {
    Ok { bundle: String },
    Refused { reason: MacRefusal, bundle: Option<String> },
}

/// `posix.dirname`.
pub fn posix_dirname(path: &str) -> &str {
    let trimmed = path.trim_end_matches('/');
    if trimmed.is_empty() {
        return if path.starts_with('/') { "/" } else { "." };
    }
    match trimmed.rfind('/') {
        Some(i) => {
            let dir = trimmed[..i].trim_end_matches('/');
            if dir.is_empty() { "/" } else { dir }
        }
        None => ".",
    }
}

/// Whether the bundle can be swapped once the app has quit (evaluateInstallTarget).
pub fn evaluate_install_target(exec_path: &str, packaged: bool, fs: &dyn TargetFs) -> TargetResult {
    let bundle = bundle_path_from_exec_path(exec_path);
    // A development run executes the binary of target/, which must never be replaced.
    let Some(bundle) = bundle.filter(|_| packaged) else {
        return TargetResult::Refused { reason: MacRefusal::NotBundle, bundle: bundle_path_from_exec_path(exec_path) };
    };
    if exec_path.contains("/AppTranslocation/") || bundle.contains("/AppTranslocation/") {
        return TargetResult::Refused { reason: MacRefusal::Translocated, bundle: Some(bundle) };
    }
    for path in [posix_dirname(&bundle), bundle.as_str()] {
        if let Err(e) = fs.access_writable(path) {
            let reason = if e.raw_os_error() == Some(EROFS) { MacRefusal::ReadOnly } else { MacRefusal::NotWritable };
            return TargetResult::Refused { reason, bundle: Some(bundle.clone()) };
        }
    }
    // Replacing a bundle that belongs to somebody else (an administrator install) needs rights the app does not have.
    if let Some(uid) = fs.uid()
        && fs.owner_of(&bundle) != Some(uid)
    {
        return TargetResult::Refused { reason: MacRefusal::NotOwner, bundle: Some(bundle) };
    }
    TargetResult::Ok { bundle }
}

/// macOS 13+ may deny writing inside an app bundle without the "App Management" permission. Probed only when the user asked to
/// install (it can show the system prompt), by creating and removing `Contents/.unimux-write-probe`.
pub fn probe_bundle_write(bundle: &Path) -> bool {
    let probe = bundle.join("Contents").join(".unimux-write-probe");
    match std::fs::write(&probe, b"").and_then(|()| std::fs::remove_file(&probe)) {
        Ok(()) => true,
        Err(_) => {
            let _ = std::fs::remove_file(&probe);
            false
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;

    /// test/mac-update-target.test.ts's fake: writable paths, errno per path, owners.
    pub struct FakeTargetFs {
        pub denied: HashMap<String, i32>,
        pub owners: HashMap<String, u32>,
        pub uid: Option<u32>,
    }

    impl FakeTargetFs {
        pub fn owned(uid: u32) -> Self {
            Self { denied: HashMap::new(), owners: HashMap::new(), uid: Some(uid) }
        }
    }

    impl TargetFs for FakeTargetFs {
        fn access_writable(&self, path: &str) -> io::Result<()> {
            match self.denied.get(path) {
                Some(errno) => Err(io::Error::from_raw_os_error(*errno)),
                None => Ok(()),
            }
        }
        fn owner_of(&self, path: &str) -> Option<u32> {
            self.owners.get(path).copied().or(self.uid)
        }
        fn uid(&self) -> Option<u32> {
            self.uid
        }
    }

    const EXE: &str = "/Applications/unimux.app/Contents/MacOS/unimux";

    #[test]
    fn derives_the_bundle_from_the_executable() {
        assert_eq!(bundle_path_from_exec_path(EXE).as_deref(), Some("/Applications/unimux.app"));
        assert_eq!(
            bundle_path_from_exec_path("/Users/a/My Apps/unimux.app/Contents/MacOS/unimux").as_deref(),
            Some("/Users/a/My Apps/unimux.app")
        );
        assert_eq!(bundle_path_from_exec_path("/usr/local/bin/unimux"), None);
        assert_eq!(bundle_path_from_exec_path("/Applications/unimux.app/Contents/MacOS/"), None);
        assert_eq!(bundle_path_from_exec_path("/.app/Contents/MacOS/unimux"), None);
        assert_eq!(bundle_path_from_exec_path("relative/unimux.app/Contents/MacOS/unimux"), None);
        assert_eq!(backup_path_for("/Applications/unimux.app", "1.2.0"), "/Applications/unimux.app.old-1.2.0");
        assert_eq!(staged_path_for("/Applications/unimux.app", "1.2.1"), "/Applications/unimux.app.new-1.2.1");
        assert_eq!(posix_dirname("/Applications/unimux.app"), "/Applications");
        assert_eq!(posix_dirname("/unimux.app"), "/");
    }

    #[test]
    fn refusal_cases() {
        let ok = FakeTargetFs::owned(501);
        assert_eq!(evaluate_install_target(EXE, true, &ok), TargetResult::Ok { bundle: "/Applications/unimux.app".into() });
        // Not packaged (a development build), even inside an .app; and a binary outside a bundle.
        assert!(matches!(evaluate_install_target(EXE, false, &ok), TargetResult::Refused { reason: MacRefusal::NotBundle, .. }));
        assert!(matches!(
            evaluate_install_target("/usr/local/bin/unimux", true, &ok),
            TargetResult::Refused { reason: MacRefusal::NotBundle, bundle: None }
        ));
        let translocated = "/private/var/folders/x/AppTranslocation/ABC/d/unimux.app/Contents/MacOS/unimux";
        assert!(matches!(
            evaluate_install_target(translocated, true, &ok),
            TargetResult::Refused { reason: MacRefusal::Translocated, .. }
        ));
        let mut dmg = FakeTargetFs::owned(501);
        dmg.denied.insert("/Volumes/unimux".into(), EROFS);
        assert!(matches!(
            evaluate_install_target("/Volumes/unimux/unimux.app/Contents/MacOS/unimux", true, &dmg),
            TargetResult::Refused { reason: MacRefusal::ReadOnly, .. }
        ));
        let mut locked = FakeTargetFs::owned(501);
        locked.denied.insert("/Applications/unimux.app".into(), 13);
        assert!(matches!(
            evaluate_install_target(EXE, true, &locked),
            TargetResult::Refused { reason: MacRefusal::NotWritable, .. }
        ));
        let mut admin = FakeTargetFs::owned(501);
        admin.owners.insert("/Applications/unimux.app".into(), 0);
        assert!(matches!(evaluate_install_target(EXE, true, &admin), TargetResult::Refused { reason: MacRefusal::NotOwner, .. }));
        // No uid on this platform: the owner is not checked.
        let mut no_uid = FakeTargetFs::owned(501);
        no_uid.uid = None;
        assert!(matches!(evaluate_install_target(EXE, true, &no_uid), TargetResult::Ok { .. }));
    }

    #[test]
    fn the_write_probe_creates_and_removes_its_file() {
        let tmp = tempfile::tempdir().unwrap();
        let bundle = tmp.path().join("unimux.app");
        std::fs::create_dir_all(bundle.join("Contents")).unwrap();
        assert!(probe_bundle_write(&bundle));
        assert_eq!(std::fs::read_dir(bundle.join("Contents")).unwrap().count(), 0);
        // No Contents folder to write into: refused (App Management denies the same way).
        assert!(!probe_bundle_write(&tmp.path().join("missing.app")));
    }
}
