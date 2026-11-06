//! Editor tabs of local files outside the projects (1.1.4 src/main/localFiles.ts `readFile` / `statFile` / `writeFile`, the
//! SFTP view's local pane, 0.9.9): read and saved like a project file, never inside the app's own folders (data dir, install
//! dir, the WebView2 folders), never over UNC or device paths on Windows, and a write only for a file this app's windows read
//! before (the last 500; a reload of the main window forgets them).

use std::collections::VecDeque;

use parking_lot::Mutex;
use serde_json::{Value, json};

use crate::fserr::FsError;
use crate::fsx;
use crate::jspath::{self, Flavor};
use crate::preview::{self, LARGE_VIEW_BYTES, Preview};
use crate::project::file_error;
use crate::save::{self, SaveResult};

/// Files the windows read through local:readFile: the only ones local:writeFile accepts.
pub const OPENED_LIMIT: usize = 500;
pub const EDIT_REFUSED: &str = "Tego miejsca nie można edytować w aplikacji.";
pub const NOT_OPENED: &str = "Ten plik nie został otwarty w edytorze.";
/// src/shared/editorSource.ts FILE_GONE.
pub const FILE_GONE: &str = "Plik został przeniesiony lub usunięty.";
const BAD_PATH: &str = "Nieprawidłowa ścieżka lub nazwa";
/// SFTP_LIMITS.path (in UTF-16 units, like `path.length`).
pub const PATH_LIMIT: usize = 4096;

/// The OS the rules follow (`deps.platform`): case folding and UNC refusal on Windows, case folding on macOS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LocalPlatform {
    Windows,
    Mac,
    Linux,
}

impl LocalPlatform {
    pub const fn native() -> Self {
        if cfg!(windows) {
            LocalPlatform::Windows
        } else if cfg!(target_os = "macos") {
            LocalPlatform::Mac
        } else {
            LocalPlatform::Linux
        }
    }
}

/// A UNC or device path (`\\server\share`, `\\?\`, `\\.\`): never read for the editor (a read could leak the Windows login
/// to a server).
pub fn is_unc_or_device_path(path: &str) -> bool {
    let mut chars = path.chars();
    matches!((chars.next(), chars.next()), (Some('\\' | '/'), Some('\\' | '/')))
}

/// `validLocalPath`: a non-empty absolute path of at most 4096 UTF-16 units without NUL.
pub fn valid_local_path(path: &str) -> bool {
    let units = path.encode_utf16().count();
    units > 0 && units <= PATH_LIMIT && !path.contains('\0') && jspath::is_absolute(Flavor::native(), path)
}

enum Editable {
    Real(String),
    Gone,
    Refused,
}

pub struct LocalFiles {
    platform: LocalPlatform,
    forbidden: Vec<String>,
    forbidden_real: Mutex<Option<Vec<String>>>,
    opened: Mutex<VecDeque<String>>,
}

impl LocalFiles {
    /// `forbidden`: the folders the editor never reads or writes (data dir, install dir, WebView2 folders).
    pub fn new(platform: LocalPlatform, forbidden: Vec<String>) -> Self {
        let forbidden = forbidden.into_iter().filter(|f| !f.is_empty()).collect();
        Self { platform, forbidden, forbidden_real: Mutex::new(None), opened: Mutex::new(VecDeque::new()) }
    }

    /// Node's `path` of the running OS (1.1.4 uses it whatever `deps.platform` says).
    fn flavor(&self) -> Flavor {
        Flavor::native()
    }

    fn fold(&self, p: &str) -> String {
        if self.platform == LocalPlatform::Linux { p.to_string() } else { p.to_lowercase() }
    }

    fn inside(&self, root: &str, child: &str) -> bool {
        let f = self.flavor();
        let rel = jspath::relative(f, &self.fold(root), &self.fold(child));
        let up = if f == Flavor::Win32 { "..\\" } else { "../" };
        rel.is_empty() || (rel != ".." && !rel.starts_with(up) && !jspath::is_absolute(f, &rel))
    }

    fn remember(&self, real: &str) {
        let key = self.fold(real);
        let mut opened = self.opened.lock();
        opened.retain(|k| *k != key);
        opened.push_back(key);
        while opened.len() > OPENED_LIMIT {
            opened.pop_front();
        }
    }

    fn was_opened(&self, real: &str) -> bool {
        let key = self.fold(real);
        self.opened.lock().contains(&key)
    }

    /// The forbidden roots as written and through their links (resolved once).
    fn forbidden_roots(&self) -> Vec<String> {
        let f = self.flavor();
        let mut roots: Vec<String> = self.forbidden.iter().map(|r| jspath::resolve(f, &[r])).collect();
        let mut cached = self.forbidden_real.lock();
        let real = cached.get_or_insert_with(|| {
            self.forbidden
                .iter()
                .map(|r| fsx::realpath(&jspath::resolve(f, &[r])).unwrap_or_else(|_| jspath::resolve(f, &[r])))
                .collect()
        });
        roots.extend(real.iter().cloned());
        roots
    }

    /// The real path of a file the editor may read or write.
    fn editable_path(&self, path: Option<&str>) -> Editable {
        let windows = self.platform == LocalPlatform::Windows;
        let Some(path) = path.filter(|p| valid_local_path(p)) else { return Editable::Refused };
        if windows && is_unc_or_device_path(path) {
            return Editable::Refused;
        }
        let resolved = jspath::resolve(self.flavor(), &[path]);
        let real = match fsx::realpath(&resolved) {
            Ok(r) => r,
            // Moved, renamed or deleted: its own text, not "cannot be edited here".
            Err(e) if e.is("ENOENT") || e.is("ENOTDIR") => return Editable::Gone,
            Err(_) => return Editable::Refused,
        };
        if windows && is_unc_or_device_path(&real) {
            return Editable::Refused;
        }
        if self.forbidden_roots().iter().any(|root| self.inside(root, &real) || self.inside(root, &resolved)) {
            return Editable::Refused;
        }
        Editable::Real(real)
    }

    /// `local:readFile`.
    pub fn read_file(&self, path: Option<&str>) -> Preview {
        match self.editable_path(path) {
            Editable::Gone => Preview::error(FILE_GONE),
            Editable::Refused => Preview::error(EDIT_REFUSED),
            Editable::Real(real) => {
                let result = read_local_file(&real);
                if !result.is_error() {
                    self.remember(&real);
                }
                result
            }
        }
    }

    /// `local:statFile`: `{size, mtimeMs}`, `"gone"` or `null`.
    pub fn stat_file(&self, path: Option<&str>) -> Value {
        match self.editable_path(path) {
            Editable::Gone => json!("gone"),
            Editable::Refused => Value::Null,
            Editable::Real(real) => match local_file_path(Some(&real)).and_then(|t| fsx::stat(&t)) {
                Ok(st) if st.is_file => json!({ "size": st.size, "mtimeMs": st.mtime_ms }),
                _ => Value::Null,
            },
        }
    }

    /// `local:writeFile`.
    pub fn write_file(&self, path: Option<&str>, text: Option<&str>, expected: Option<&str>) -> SaveResult {
        match self.editable_path(path) {
            Editable::Gone => SaveResult::Failed(FILE_GONE.into()),
            Editable::Refused => SaveResult::Failed(EDIT_REFUSED.into()),
            Editable::Real(real) if !self.was_opened(&real) => SaveResult::Failed(NOT_OPENED.into()),
            Editable::Real(real) => save::write_file_with(&|| local_file_path(Some(&real)), text, expected),
        }
    }

    /// The main page reloaded or crashed: what it opened counts no more (restored drafts read again before they save).
    pub fn renderer_gone(&self) {
        self.opened.lock().clear();
    }
}

/// `localFilePath`: an absolute local path resolved through links.
fn local_file_path(path: Option<&str>) -> Result<String, FsError> {
    let Some(path) = path.filter(|p| !p.is_empty() && p.encode_utf16().count() <= PATH_LIMIT && !p.contains('\0')) else {
        return Err(FsError::plain(BAD_PATH));
    };
    if !jspath::is_absolute(Flavor::native(), path) {
        return Err(FsError::plain(BAD_PATH));
    }
    fsx::realpath(&jspath::resolve(Flavor::native(), &[path]))
}

/// `readLocalFile`: like a project file in the editor (8 MiB view, images, tables).
fn read_local_file(path: &str) -> Preview {
    local_file_path(Some(path))
        .and_then(|target| preview::read_file_at(&target, path, LARGE_VIEW_BYTES))
        .unwrap_or_else(|e| Preview::error(file_error(&e)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unc_and_device_paths() {
        assert!(is_unc_or_device_path("\\\\server\\share\\a.txt"));
        assert!(is_unc_or_device_path("\\\\?\\C:\\a.txt"));
        assert!(is_unc_or_device_path("\\\\.\\PhysicalDrive0"));
        assert!(is_unc_or_device_path("//server/share"));
        assert!(!is_unc_or_device_path("C:\\a.txt"));
    }
}
