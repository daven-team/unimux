//! The local pane of the SFTP view (1.1.4 src/main/localFiles.ts `list` / `roots` / `mkdir` / `rename` / `trash` /
//! `reveal`, 0.9.8): any folder the user browses (not only projects), the drives on Windows, the home folder, new
//! folder, rename, trash and "show in Explorer/Finder". Absolute paths only. Answers are 1.1.4's `LocalResult`
//! (`{ok: true, value}` or `{ok: false, error: <code>}`). The editor's read / stat / write of local files live in
//! [`crate::local`] (G5).

use std::sync::Arc;

use serde_json::{Value, json};

use crate::fileops::{TrashFn, windows_device_name};
use crate::fserr::FsError;
use crate::fsx;
use crate::jspath::{self, Flavor};
use crate::local::{LocalPlatform, valid_local_path};

const F: Flavor = Flavor::native();

/// SFTP_LIMITS of src/shared/sftp.ts.
pub const NAME_LIMIT: usize = 255;
pub const PATHS_LIMIT: usize = 1000;
pub const LIST_LIMIT: usize = 20_000;

/// `safeEntryName(name, { windows })` of src/shared/sftp.ts: a single entry name that is safe to join onto a folder path.
pub fn safe_entry_name(name: &str, windows: bool) -> bool {
    if name.is_empty() || name.encode_utf16().count() > NAME_LIMIT || name == "." || name == ".." {
        return false;
    }
    if name.contains(['/', '\\', '\0']) {
        return false;
    }
    if windows {
        if name.chars().any(|c| matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*' | '\0'..='\u{1f}')) {
            return false;
        }
        if name.ends_with(['.', ' ']) {
            return false;
        }
        if windows_device_name(name, true) {
            return false;
        }
    }
    true
}

/// `permissionString(mode)`: "drwxr-xr-x" (setuid / setgid / sticky as s / S and t / T, like ls).
pub fn permission_string(mode: u32) -> String {
    let m = mode;
    let kind = match m & 0o170000 {
        0o140000 => 's',
        0o120000 => 'l',
        0o100000 => '-',
        0o060000 => 'b',
        0o040000 => 'd',
        0o020000 => 'c',
        0o010000 => 'p',
        _ => '-',
    };
    let triplet = |r: u32, w: u32, x: u32, special: u32, on: char, off: char| {
        let exec = if m & special != 0 {
            if m & x != 0 { on } else { off }
        } else if m & x != 0 {
            'x'
        } else {
            '-'
        };
        format!("{}{}{}", if m & r != 0 { 'r' } else { '-' }, if m & w != 0 { 'w' } else { '-' }, exec)
    };
    format!(
        "{kind}{}{}{}",
        triplet(0o400, 0o200, 0o100, 0o4000, 's', 'S'),
        triplet(0o040, 0o020, 0o010, 0o2000, 's', 'S'),
        triplet(0o004, 0o002, 0o001, 0o1000, 't', 'T')
    )
}

/// `isBundleName`: a macOS directory name Finder may treat as a package rather than a plain folder (any extension).
pub fn is_bundle_name(name: &str) -> bool {
    let ext_len = name.len() - name.trim_end_matches(|c: char| c.is_ascii_alphanumeric()).len();
    let has_ext = ext_len > 0 && name[..name.len() - ext_len].ends_with('.');
    let lone_dotfile = name.starts_with('.') && !name[1..].contains('.');
    has_ext && !lone_dotfile
}

/// `codeOf(error)`: the LocalErrorCode of a failure.
pub fn code_of(error: &FsError) -> &'static str {
    match error.code {
        Some("ENOENT") => "notFound",
        Some("EEXIST") => "exists",
        Some("EACCES") | Some("EPERM") | Some("EBUSY") => "permission",
        Some("ENOTEMPTY") => "notEmpty",
        Some("ENOTDIR") => "notADirectory",
        _ => "failed",
    }
}

fn ok(value: Value) -> Value {
    json!({ "ok": true, "value": value })
}

fn fail(code: &str) -> Value {
    json!({ "ok": false, "error": code })
}

fn local_path(v: &Value) -> Option<&str> {
    v.as_str().filter(|p| valid_local_path(p))
}

/// `shell.openPath` of a folder (1.1.4 threw on its error text).
pub type OpenFolderFn = dyn Fn(&str) -> Result<(), FsError> + Send + Sync;

/// What the pane needs from the app: the trash, Explorer / Finder and the home folder.
pub struct PaneDeps {
    pub platform: LocalPlatform,
    pub trash: Arc<TrashFn>,
    pub open_folder: Box<OpenFolderFn>,
    /// `shell.showItemInFolder`.
    pub show_file: Box<dyn Fn(&str) + Send + Sync>,
    /// `os.homedir()`.
    pub home: Box<dyn Fn() -> String + Send + Sync>,
}

pub struct LocalPane {
    deps: PaneDeps,
}

impl LocalPane {
    pub fn new(deps: PaneDeps) -> Self {
        Self { deps }
    }

    fn windows(&self) -> bool {
        self.deps.platform == LocalPlatform::Windows
    }

    fn valid_name(&self, path: &str) -> bool {
        safe_entryname_of(path, self.windows())
    }

    /// One entry of a listing (`entryOf`), None when it vanished or cannot be read (pagefile.sys).
    fn entry_of(&self, dir: &str, name: &str) -> Option<Value> {
        let path = jspath::join_name(F, dir, name);
        let st = fsx::lstat(&path).ok()?;
        let kind = if st.is_link {
            "symlink"
        } else if st.is_dir {
            "dir"
        } else if st.is_file {
            "file"
        } else {
            "other"
        };
        let mut size = if kind == "file" { st.size } else { 0 };
        let mtime = (st.mtime_ms + 0.5).floor() as i64;
        let permissions = if self.windows() { String::new() } else { permission_string(st.mode) };
        let mut entry = json!({
            "name": name, "path": path, "kind": kind, "size": size, "mtime": mtime, "permissions": permissions,
            "hidden": name.starts_with('.'),
        });
        if st.is_link {
            let real = fsx::stat(&path).ok();
            let target = match real {
                Some(r) if r.is_dir => "dir",
                Some(r) if r.is_file => "file",
                _ => "other",
            };
            if let Some(r) = real.filter(|r| r.is_file) {
                size = r.size;
                entry["size"] = json!(size);
            }
            entry["target"] = json!(target);
        }
        Some(entry)
    }

    /// `local:list`: the folder's entries (at most 20000; `truncated` says there were more).
    pub fn list(&self, path: &Value) -> Value {
        let Some(path) = local_path(path) else { return fail("invalid") };
        let dir = jspath::resolve(F, &[path]);
        match fsx::stat(&dir) {
            Ok(st) if !st.is_dir => return fail("notADirectory"),
            Ok(_) => {}
            Err(e) => return fail(code_of(&e)),
        }
        let names = match fsx::readdir_names(&dir) {
            Ok(n) => n,
            Err(e) => return fail(code_of(&e)),
        };
        let truncated = names.len() > LIST_LIMIT;
        let entries: Vec<Value> = names.iter().take(LIST_LIMIT).filter_map(|n| self.entry_of(&dir, n)).collect();
        ok(json!({ "path": dir, "entries": entries, "truncated": truncated }))
    }

    /// `local:roots`: the home folder and, on Windows, the drive roots that answer a stat (asked in parallel).
    pub fn roots(&self) -> Value {
        let home = (self.deps.home)();
        if !self.windows() {
            return json!({ "home": home, "drives": [] });
        }
        let letters: Vec<char> = ('A'..='Z').collect();
        let found: Vec<Option<String>> = std::thread::scope(|scope| {
            let handles: Vec<_> = letters
                .iter()
                .map(|l| {
                    let root = format!("{l}:\\");
                    scope.spawn(move || fsx::stat(&root).ok().map(|_| root))
                })
                .collect();
            handles.into_iter().map(|h| h.join().ok().flatten()).collect()
        });
        json!({ "home": home, "drives": found.into_iter().flatten().collect::<Vec<_>>() })
    }

    /// `local:mkdir`.
    pub fn mkdir(&self, path: &Value) -> Value {
        let Some(path) = local_path(path).filter(|p| self.valid_name(p)) else { return fail("invalid") };
        match fsx::mkdir(path, None) {
            Ok(()) => ok(Value::Null),
            Err(e) => fail(code_of(&e)),
        }
    }

    /// `local:rename`: a rename within one folder, never over another file (a case-only rename only where both names are
    /// the same file).
    pub fn rename(&self, from: &Value, to: &Value) -> Value {
        let (Some(from), Some(to)) = (local_path(from), local_path(to).filter(|p| self.valid_name(p))) else {
            return fail("invalid");
        };
        let dir = |p: &str| jspath::resolve(F, &[&jspath::dirname(F, p)]);
        if dir(from) != dir(to) {
            return fail("invalid");
        }
        if fsx::lstat_or_none(to).is_some() && !fsx::same_file(from, to) {
            return fail("exists");
        }
        match fsx::rename(from, to) {
            Ok(()) => ok(Value::Null),
            Err(e) => fail(code_of(&e)),
        }
    }

    /// `local:trash`: never a drive root or the home folder; the first failure ends it.
    pub fn trash(&self, paths: &Value) -> Value {
        let list = paths.as_array();
        let valid = list.is_some_and(|l| !l.is_empty() && l.len() <= PATHS_LIMIT && l.iter().all(|p| local_path(p).is_some()));
        if !valid {
            return fail(if list.is_some_and(|l| l.len() > PATHS_LIMIT) { "tooMany" } else { "invalid" });
        }
        let paths: Vec<&str> = list.map(|l| l.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
        let home = jspath::resolve(F, &[&(self.deps.home)()]);
        if paths.iter().any(|p| {
            let r = jspath::resolve(F, &[p]);
            jspath::dirname(F, &r) == r || r == home
        }) {
            return fail("invalid");
        }
        for p in paths {
            if let Err(e) = (self.deps.trash)(p) {
                return fail(code_of(&e));
            }
        }
        ok(Value::Null)
    }

    /// `local:reveal`: a folder opens in Explorer / Finder, a file (and a macOS bundle) is shown selected.
    pub fn reveal(&self, path: &Value) -> Value {
        let Some(path) = local_path(path) else { return fail("invalid") };
        let st = match fsx::stat(path) {
            Ok(st) => st,
            Err(e) => return fail(code_of(&e)),
        };
        let bundle =
            self.deps.platform == LocalPlatform::Mac && is_bundle_name(&jspath::basename(F, &jspath::resolve(F, &[path])));
        if st.is_dir && !bundle {
            if let Err(e) = (self.deps.open_folder)(path) {
                return fail(code_of(&e));
            }
        } else {
            (self.deps.show_file)(path);
        }
        ok(Value::Null)
    }
}

fn safe_entryname_of(path: &str, windows: bool) -> bool {
    safe_entry_name(&jspath::basename(F, path), windows)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_modes() {
        assert!(safe_entry_name("a.txt", true));
        assert!(!safe_entry_name("clock$", true));
        assert!(safe_entry_name("clock$", false));
        assert!(!safe_entry_name("a\\b", false));
        assert_eq!(permission_string(0o40755), "drwxr-xr-x");
        assert_eq!(permission_string(0o104755), "-rwsr-xr-x");
        assert_eq!(permission_string(0o41777), "drwxrwxrwt");
        assert_eq!(permission_string(0o100644 | 0o2000), "-rw-r-Sr--");
        assert!(is_bundle_name("Foo.app") && is_bundle_name(".config.d") && !is_bundle_name(".app") && !is_bundle_name("Plain"));
        assert!(!is_bundle_name("a.") && !is_bundle_name("a.b-c"));
    }
}
