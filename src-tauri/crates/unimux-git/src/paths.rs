//! ONE way to compare folders in the Git module (port of src/main/gitPaths.ts). A folder has many spellings: Windows 8.3 short
//! names (`RUNNER~1`), another drive letter case, back or forward slashes, a junction or a subst drive; git reports its own
//! spelling (long names, forward slashes, resolved links). Every path that is compared (project folder, repository root,
//! worktrees, cell folders, lock and trust keys) goes through [`canonical_path`] first. This is only for comparing roots: the
//! confinement of file paths inside a repository (no links, no aliases) lives with the reads (G3).
//!
//! The real path is `fs.realpathSync.native` of Node: GetFinalPathNameByHandleW on Windows (what `std::fs::canonicalize`
//! calls too), with libuv's prefix rule (`\\?\UNC\` becomes `\\`, `\\?\` is dropped; dunce would keep the verbatim prefix of
//! a path it cannot simplify, libuv never does), realpath(3) elsewhere. `dirname` and `resolve` are ports of Node's path module
//! of the host system (win32 on Windows, posix elsewhere), exactly as gitPaths.ts uses them.

/// What the canonical spelling needs from the file system (a fake in the tests).
pub trait PathOps {
    /// Resolves links and short names; None when the path does not exist (or cannot be opened).
    fn realpath(&self, path: &str) -> Option<String>;
    /// `platform === 'win32'`: the case is folded.
    fn windows(&self) -> bool;
}

/// The real file system of this machine.
#[derive(Debug, Clone, Copy, Default)]
pub struct NativeOps;

impl PathOps for NativeOps {
    fn realpath(&self, path: &str) -> Option<String> {
        realpath_native(path)
    }
    fn windows(&self) -> bool {
        cfg!(windows)
    }
}

/// `fs.realpathSync.native(path)`: None when it throws.
pub fn realpath_native(path: &str) -> Option<String> {
    if path.is_empty() || path.contains('\0') {
        return None;
    }
    let real = std::fs::canonicalize(path).ok()?;
    let text = real.to_string_lossy().into_owned();
    #[cfg(windows)]
    {
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return Some(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            return Some(rest.to_string());
        }
    }
    Some(text)
}

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// `s.slice(n)` in UTF-16 units (a cut inside a surrogate pair keeps U+FFFD for the lone half, a Rust string cannot hold it).
fn slice_utf16_from(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().collect();
    if n >= units.len() {
        return String::new();
    }
    String::from_utf16_lossy(&units[n..])
}

/// `slashes()` of gitPaths.ts: forward slashes, no verbatim prefix, repeated slashes collapsed (not at the start), no trailing
/// slash except on a drive root.
fn slashes(path: &str) -> String {
    let mut value = path.replace('\\', "/");
    // VERBATIM_PREFIX = /^\/\/[?.]\//
    let b = value.as_bytes();
    if b.len() >= 4 && b[0] == b'/' && b[1] == b'/' && (b[2] == b'?' || b[2] == b'.') && b[3] == b'/' {
        value = value[4..].to_string();
    }
    // REPEATED_SLASH = /(?<!^)\/{2,}/g: every run of slashes after the first character becomes one slash.
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    if let Some(first) = chars.next() {
        out.push(first);
    }
    let mut prev_slash = false;
    for c in chars {
        if c == '/' {
            if !prev_slash {
                out.push('/');
            }
            prev_slash = true;
        } else {
            out.push(c);
            prev_slash = false;
        }
    }
    let mut value = out;
    if utf16_len(&value) > 1 && !is_drive_root(&value) {
        let trimmed = value.trim_end_matches('/').len();
        value.truncate(trimmed);
    }
    value
}

/// DRIVE_ROOT = /^[A-Za-z]:\/$/
fn is_drive_root(v: &str) -> bool {
    let b = v.as_bytes();
    b.len() == 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/'
}

fn fold(path: String, windows: bool) -> String {
    if windows { path.to_lowercase() } else { path }
}

/// The text form of a path that can be compared: forward slashes, no trailing slash, no verbatim prefix, folded case on
/// Windows (`normalizeSpelling`).
pub fn normalize_spelling(path: &str, windows: bool) -> String {
    fold(slashes(path), windows)
}

fn is_sep_win(c: u8) -> bool {
    c == b'/' || c == b'\\'
}

/// Node's `path.win32.dirname`.
pub fn dirname_win32(path: &str) -> String {
    let b = path.as_bytes();
    let len = b.len();
    if len == 0 {
        return ".".into();
    }
    let mut root_end: isize = -1;
    let mut offset = 0usize;
    let code = b[0];
    if len == 1 {
        return if is_sep_win(code) { path.into() } else { ".".into() };
    }
    if is_sep_win(code) {
        root_end = 1;
        offset = 1;
        if is_sep_win(b[1]) {
            let mut j = 2;
            let mut last = j;
            while j < len && !is_sep_win(b[j]) {
                j += 1;
            }
            if j < len && j != last {
                last = j;
                while j < len && is_sep_win(b[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !is_sep_win(b[j]) {
                        j += 1;
                    }
                    if j == len {
                        return path.into();
                    }
                    if j != last {
                        root_end = (j + 1) as isize;
                        offset = j + 1;
                    }
                }
            }
        }
    } else if code.is_ascii_alphabetic() && b[1] == b':' {
        root_end = if len > 2 && is_sep_win(b[2]) { 3 } else { 2 };
        offset = root_end as usize;
    }
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut i = len as isize - 1;
    while i >= offset as isize {
        if is_sep_win(b[i as usize]) {
            if !matched_slash {
                end = i;
                break;
            }
        } else {
            matched_slash = false;
        }
        i -= 1;
    }
    if end == -1 {
        if root_end == -1 {
            return ".".into();
        }
        end = root_end;
    }
    path[..end as usize].to_string()
}

/// Node's `path.posix.dirname`.
pub fn dirname_posix(path: &str) -> String {
    let b = path.as_bytes();
    if b.is_empty() {
        return ".".into();
    }
    let has_root = b[0] == b'/';
    let mut end: isize = -1;
    let mut matched_slash = true;
    let mut i = b.len() as isize - 1;
    while i >= 1 {
        if b[i as usize] == b'/' {
            if !matched_slash {
                end = i;
                break;
            }
        } else {
            matched_slash = false;
        }
        i -= 1;
    }
    if end == -1 {
        return if has_root { "/".into() } else { ".".into() };
    }
    if has_root && end == 1 {
        return "//".into();
    }
    path[..end as usize].to_string()
}

/// `path.dirname` of the host system (gitPaths.ts imports it from 'path').
pub fn dirname(path: &str) -> String {
    if cfg!(windows) { dirname_win32(path) } else { dirname_posix(path) }
}

/// Node's `normalizeString` (path.js): resolves `.` and `..` and repeated separators of a path without its root, purely
/// lexically (trailing dots and spaces stay, unlike GetFullPathNameW). The separators and dots are ASCII, so working on bytes
/// cuts only at character boundaries.
fn normalize_string(path: &str, allow_above_root: bool, separator: u8, is_sep: fn(u8) -> bool) -> String {
    let b = path.as_bytes();
    let sep = separator as char;
    let mut res = String::new();
    let mut last_segment_length: usize = 0;
    let mut last_slash: isize = -1;
    let mut dots: i32 = 0;
    let mut code: u8 = 0;
    let mut i: isize = 0;
    while i <= b.len() as isize {
        if (i as usize) < b.len() {
            code = b[i as usize];
        } else if is_sep(code) {
            break;
        } else {
            code = b'/';
        }
        if is_sep(code) {
            if last_slash == i - 1 || dots == 1 {
                // NOOP
            } else if dots == 2 {
                let rb = res.as_bytes();
                if res.len() < 2 || last_segment_length != 2 || rb[rb.len() - 1] != b'.' || rb[rb.len() - 2] != b'.' {
                    if res.len() > 2 {
                        match res.rfind(sep) {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(at) => {
                                res.truncate(at);
                                last_segment_length = match res.rfind(sep) {
                                    Some(prev) => res.len() - 1 - prev,
                                    None => res.len(),
                                };
                            }
                        }
                        last_slash = i;
                        dots = 0;
                        i += 1;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = i;
                        dots = 0;
                        i += 1;
                        continue;
                    }
                }
                if allow_above_root {
                    if res.is_empty() {
                        res.push_str("..");
                    } else {
                        res.push(sep);
                        res.push_str("..");
                    }
                    last_segment_length = 2;
                }
            } else {
                let segment = &path[(last_slash + 1) as usize..i as usize];
                if !res.is_empty() {
                    res.push(sep);
                }
                res.push_str(segment);
                last_segment_length = (i - last_slash - 1) as usize;
            }
            last_slash = i;
            dots = 0;
        } else if code == b'.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
        i += 1;
    }
    res
}

fn is_sep_posix(c: u8) -> bool {
    c == b'/'
}

/// The first `n` UTF-16 units of `s` (`s.slice(0, n)`).
fn slice_utf16_to(s: &str, n: usize) -> String {
    let units: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&units)
}

/// Node's `path.win32.resolve(...args)`, lexically. `cwd` is `process.cwd()`; `drive_cwd(device)` is
/// `process.env['=C:']`, the current folder Windows keeps per drive (only asked for a drive-relative path like `C:x`).
pub fn resolve_win32_with(args: &[&str], cwd: &str, drive_cwd: &dyn Fn(&str) -> Option<String>) -> String {
    let mut resolved_device = String::new();
    let mut resolved_tail = String::new();
    let mut resolved_absolute = false;
    let mut i = args.len() as isize - 1;
    while i >= -1 {
        let path: String = if i >= 0 {
            let p = args[i as usize];
            if p.is_empty() {
                i -= 1;
                continue;
            }
            p.to_string()
        } else if resolved_device.is_empty() {
            let path = cwd.to_string();
            // fast path for the current directory
            if args.is_empty()
                || (args.len() == 1 && (args[0].is_empty() || args[0] == ".") && path.bytes().next().is_some_and(is_sep_win))
            {
                return path;
            }
            path
        } else {
            let path = drive_cwd(&resolved_device).filter(|p| !p.is_empty()).unwrap_or_else(|| cwd.to_string());
            let other_drive = slice_utf16_to(&path, 2).to_lowercase() != resolved_device.to_lowercase()
                && path.encode_utf16().nth(2) == Some(u16::from(b'\\'));
            if other_drive { format!("{resolved_device}\\") } else { path }
        };

        let b = path.as_bytes();
        let len = b.len();
        let mut root_end = 0usize;
        let mut device = String::new();
        let mut is_absolute = false;
        let code = b.first().copied().unwrap_or(0);
        if path.encode_utf16().count() == 1 {
            if is_sep_win(code) {
                root_end = 1;
                is_absolute = true;
            }
        } else if is_sep_win(code) {
            is_absolute = true;
            if is_sep_win(b[1]) {
                let mut j = 2;
                let mut last = j;
                while j < len && !is_sep_win(b[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    let first_part = &path[last..j];
                    last = j;
                    while j < len && is_sep_win(b[j]) {
                        j += 1;
                    }
                    if j < len && j != last {
                        last = j;
                        while j < len && !is_sep_win(b[j]) {
                            j += 1;
                        }
                        if j == len || j != last {
                            if first_part != "." && first_part != "?" {
                                device = format!("\\\\{first_part}\\{}", &path[last..j]);
                                root_end = j;
                            } else {
                                device = format!("\\\\{first_part}");
                                root_end = 4;
                            }
                        }
                    }
                }
            } else {
                root_end = 1;
            }
        } else if code.is_ascii_alphabetic() && b.get(1) == Some(&b':') {
            device = path[..2].to_string();
            root_end = 2;
            if len > 2 && is_sep_win(b[2]) {
                is_absolute = true;
                root_end = 3;
            }
        }

        if !device.is_empty() {
            if !resolved_device.is_empty() {
                if device.to_lowercase() != resolved_device.to_lowercase() {
                    // another device: not applicable
                    i -= 1;
                    continue;
                }
            } else {
                resolved_device = device;
            }
        }

        if resolved_absolute {
            if !resolved_device.is_empty() {
                break;
            }
        } else {
            resolved_tail = format!("{}\\{resolved_tail}", &path[root_end..]);
            resolved_absolute = is_absolute;
            if is_absolute && !resolved_device.is_empty() {
                break;
            }
        }
        i -= 1;
    }
    let tail = normalize_string(&resolved_tail, !resolved_absolute, b'\\', is_sep_win);
    if resolved_absolute {
        format!("{resolved_device}\\{tail}")
    } else {
        let out = format!("{resolved_device}{tail}");
        if out.is_empty() { ".".into() } else { out }
    }
}

/// Node's `path.posix.resolve(...args)`; `cwd` is `process.cwd()`.
pub fn resolve_posix_with(args: &[&str], cwd: &str) -> String {
    if (args.is_empty() || (args.len() == 1 && (args[0].is_empty() || args[0] == "."))) && cwd.starts_with('/') {
        return cwd.to_string();
    }
    let mut resolved_path = String::new();
    let mut resolved_absolute = false;
    for p in args.iter().rev() {
        if resolved_absolute {
            break;
        }
        if p.is_empty() {
            continue;
        }
        resolved_path = format!("{p}/{resolved_path}");
        resolved_absolute = p.starts_with('/');
    }
    if !resolved_absolute {
        resolved_path = format!("{cwd}/{resolved_path}");
        resolved_absolute = cwd.starts_with('/');
    }
    let path = normalize_string(&resolved_path, !resolved_absolute, b'/', is_sep_posix);
    if resolved_absolute {
        format!("/{path}")
    } else if path.is_empty() {
        ".".into()
    } else {
        path
    }
}

fn process_cwd() -> String {
    std::env::current_dir().map(|c| c.to_string_lossy().into_owned()).unwrap_or_default()
}

/// `process.env['=C:']`: the current folder of a drive that cmd.exe keeps in the environment (the Rust env iterator hides
/// these names, so they are asked for directly).
#[cfg(windows)]
fn drive_cwd_env(device: &str) -> Option<String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::System::Environment::GetEnvironmentVariableW;
    use windows::core::PCWSTR;
    let name: Vec<u16> = std::ffi::OsStr::new(&format!("={device}")).encode_wide().chain(std::iter::once(0)).collect();
    let mut buf = vec![0u16; 512];
    loop {
        // SAFETY: `name` is NUL-terminated and both buffers live across the call.
        let n = unsafe { GetEnvironmentVariableW(PCWSTR(name.as_ptr()), Some(&mut buf)) } as usize;
        if n == 0 {
            return None;
        }
        if n < buf.len() {
            return Some(String::from_utf16_lossy(&buf[..n]));
        }
        buf.resize(n + 1, 0);
    }
}

/// `path.resolve(base, p)` of the host system (gitPaths.ts and git.ts use it for relative folders and the common dir).
pub fn resolve(base: &str, p: &str) -> String {
    #[cfg(windows)]
    {
        resolve_win32_with(&[base, p], &process_cwd(), &drive_cwd_env)
    }
    #[cfg(not(windows))]
    {
        resolve_posix_with(&[base, p], &process_cwd())
    }
}

/// `path.resolve(p)`: against the current directory.
fn resolve_cwd(p: &str) -> String {
    #[cfg(windows)]
    {
        resolve_win32_with(&[p], &process_cwd(), &drive_cwd_env)
    }
    #[cfg(not(windows))]
    {
        resolve_posix_with(&[p], &process_cwd())
    }
}

/// TRAILING_ANY = /[\\/]+$/
fn trim_trailing_any(s: &str) -> &str {
    s.trim_end_matches(['/', '\\'])
}

/// EDGE_SEPARATORS = /^[\\/]+|[\\/]+$/g
fn trim_edges(s: &str) -> &str {
    s.trim_matches(['/', '\\'])
}

/// The real spelling of a folder (links and 8.3 names resolved, forward slashes, case kept); a missing folder resolves through
/// its nearest existing parent.
pub fn real_spelling(path: &str, ops: &dyn PathOps) -> String {
    let absolute = if ops.windows() || path.starts_with('/') { path.to_string() } else { resolve_cwd(path) };
    let mut rest: Vec<String> = Vec::new();
    let mut current = absolute.clone();
    for _ in 0..64 {
        if let Some(real) = ops.realpath(&current) {
            return if rest.is_empty() {
                slashes(&real)
            } else {
                rest.reverse();
                slashes(&format!("{}/{}", trim_trailing_any(&real), rest.join("/")))
            };
        }
        let parent = dirname(&current);
        if parent == current || parent == "." {
            break;
        }
        rest.push(trim_edges(&current[parent.len()..]).to_string());
        current = parent;
    }
    slashes(&absolute)
}

/// The canonical spelling of a folder for comparing: its real path (links and 8.3 names resolved), forward slashes, case folded
/// on Windows. When nothing resolves, the lexical path is used.
pub fn canonical_path_with(path: &str, ops: &dyn PathOps) -> String {
    fold(real_spelling(path, ops), ops.windows())
}

/// [`canonical_path_with`] on the real file system.
pub fn canonical_path(path: &str) -> String {
    canonical_path_with(path, &NativeOps)
}

pub fn same_path_with(a: &str, b: &str, ops: &dyn PathOps) -> bool {
    canonical_path_with(a, ops) == canonical_path_with(b, ops)
}

pub fn same_path(a: &str, b: &str) -> bool {
    same_path_with(a, b, &NativeOps)
}

fn with_slash(p: &str) -> String {
    if p.ends_with('/') { p.to_string() } else { format!("{p}/") }
}

/// Is `child` the folder `parent` or inside it?
pub fn is_inside_path_with(parent: &str, child: &str, ops: &dyn PathOps) -> bool {
    let p = canonical_path_with(parent, ops);
    let c = canonical_path_with(child, ops);
    c == p || c.starts_with(&with_slash(&p))
}

pub fn is_inside_path(parent: &str, child: &str) -> bool {
    is_inside_path_with(parent, child, &NativeOps)
}

/// The path of `child` below `parent` (forward slashes, real case, "" when equal), or None when it is not inside.
pub fn relative_inside_with(parent: &str, child: &str, ops: &dyn PathOps) -> Option<String> {
    let p = canonical_path_with(parent, ops);
    let c = canonical_path_with(child, ops);
    if c == p {
        return Some(String::new());
    }
    let prefix = with_slash(&p);
    if c.starts_with(&prefix) { Some(slice_utf16_from(&real_spelling(child, ops), utf16_len(&prefix))) } else { None }
}

pub fn relative_inside(parent: &str, child: &str) -> Option<String> {
    relative_inside_with(parent, child, &NativeOps)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake file system where the 8.3 spelling of the runner's folders resolves to the long one (test/git-paths.test.ts).
    struct FakeWindows;
    impl PathOps for FakeWindows {
        fn realpath(&self, path: &str) -> Option<String> {
            let slashed = path.replace('/', "\\");
            let known = r"C:\Users\runneradmin\AppData\Local\Temp";
            let long = replace_ci_once(&slashed, "RUNNER~1", "runneradmin");
            let lower = long.to_lowercase();
            if !lower.starts_with(&known.to_lowercase()) || lower.contains("missing") {
                return None;
            }
            let a = replace_ci_once(&long, r"\temp", r"\Temp");
            let b = replace_ci_once(&a, r"\appdata", r"\AppData");
            Some(replace_ci_once(&b, r"\local", r"\Local"))
        }
        fn windows(&self) -> bool {
            true
        }
    }

    /// `s.replace(/needle/i, with)` for an ASCII needle.
    fn replace_ci_once(s: &str, needle: &str, with: &str) -> String {
        match s.to_ascii_lowercase().find(&needle.to_ascii_lowercase()) {
            Some(i) => format!("{}{}{}", &s[..i], with, &s[i + needle.len()..]),
            None => s.to_string(),
        }
    }

    struct FakePosix;
    impl PathOps for FakePosix {
        fn realpath(&self, path: &str) -> Option<String> {
            if path.contains("missing") { None } else { Some(path.replacen("/link/", "/real/", 1)) }
        }
        fn windows(&self) -> bool {
            false
        }
    }

    #[test]
    fn treats_the_short_and_the_long_spelling_other_letter_case_and_slashes_as_one_folder() {
        let long = "c:/users/runneradmin/appdata/local/temp/mc-git-abc/project";
        for spelling in [
            r"C:\Users\RUNNER~1\AppData\Local\Temp\mc-git-abc\project",
            r"c:\users\runner~1\appdata\local\temp\mc-git-abc\project",
            "C:/Users/runneradmin/AppData/Local/Temp/MC-GIT-ABC/Project/",
            r"C:\Users\runneradmin\AppData\Local\Temp\mc-git-abc\\project",
        ] {
            assert_eq!(canonical_path_with(spelling, &FakeWindows), long, "{spelling}");
            assert!(same_path_with(spelling, long, &FakeWindows), "{spelling}");
        }
        assert!(!same_path_with(
            r"C:\Users\RUNNER~1\AppData\Local\Temp\a",
            r"C:\Users\runneradmin\AppData\Local\Temp\b",
            &FakeWindows
        ));
    }

    #[test]
    fn decides_inside_the_project_on_canonical_paths() {
        let project = r"C:\Users\RUNNER~1\AppData\Local\Temp\proj";
        assert!(is_inside_path_with(project, "C:/Users/runneradmin/AppData/Local/Temp/proj", &FakeWindows));
        assert!(is_inside_path_with(project, "c:/users/runneradmin/appdata/local/temp/PROJ/sub/dir", &FakeWindows));
        assert!(!is_inside_path_with(project, "C:/Users/runneradmin/AppData/Local/Temp/proj2", &FakeWindows));
        assert!(!is_inside_path_with(project, "C:/Users/runneradmin/AppData/Local/Temp", &FakeWindows));
        assert!(is_inside_path_with(r"C:\", r"C:\Users", &FakeWindows));
    }

    #[test]
    fn keeps_the_real_case_of_the_part_below_the_parent() {
        assert_eq!(
            relative_inside_with(
                r"C:\Users\RUNNER~1\AppData\Local\Temp\p",
                "C:/Users/runneradmin/AppData/Local/Temp/P/Packages/App",
                &FakeWindows
            )
            .as_deref(),
            Some("Packages/App")
        );
        assert_eq!(
            relative_inside_with(
                "C:/Users/runneradmin/AppData/Local/Temp/p",
                "C:/Users/runneradmin/AppData/Local/Temp/p",
                &FakeWindows
            )
            .as_deref(),
            Some("")
        );
        assert_eq!(
            relative_inside_with(
                "C:/Users/runneradmin/AppData/Local/Temp/p",
                "C:/Users/runneradmin/AppData/Local/Temp/q",
                &FakeWindows
            ),
            None
        );
    }

    #[test]
    fn is_case_sensitive_and_link_aware_off_windows_and_falls_back_to_the_lexical_path() {
        assert_eq!(canonical_path_with("/home/me/link/app", &FakePosix), "/home/me/real/app");
        assert!(!same_path_with("/home/me/Repo", "/home/me/repo", &FakePosix));
        assert_eq!(canonical_path_with("/home/me/missing/dir", &FakePosix), "/home/me/missing/dir");
        assert!(is_inside_path_with("/", "/home", &FakePosix));
        assert_eq!(normalize_spelling(r"\\?\C:\A\B\", true), "c:/a/b");
        assert_eq!(canonical_path_with(r"Z:\nowhere\x", &FakeWindows), "z:/nowhere/x");
    }

    #[test]
    fn node_dirname_ports() {
        for (input, want) in [
            ("", "."),
            ("C:", "C:"),
            ("C:\\", "C:\\"),
            ("C:\\a", "C:\\"),
            ("C:\\a\\b\\", "C:\\a"),
            ("C:a", "C:"),
            ("\\\\server\\share", "\\\\server\\share"),
            ("\\\\server\\share\\x", "\\\\server\\share\\"),
            ("//server/share/x/y", "//server/share/x"),
            ("/", "/"),
            ("/a", "/"),
            ("a", "."),
            ("a/b", "a"),
            ("Z:/nowhere/x", "Z:/nowhere"),
        ] {
            assert_eq!(dirname_win32(input), want, "win32 {input:?}");
        }
        for (input, want) in
            [("", "."), ("/", "/"), ("/a", "/"), ("//a", "//"), ("/a/b/", "/a"), ("a", "."), ("a/b", "a"), ("///a", "//")]
        {
            assert_eq!(dirname_posix(input), want, "posix {input:?}");
        }
    }

    /// The host `resolve` is the lexical Node port (no GetFullPathNameW): trailing dots, spaces and separators as Node has them.
    #[test]
    fn host_resolve_is_node_path_resolve() {
        if cfg!(windows) {
            assert_eq!(resolve("C:/x/repo", "../a/b."), r"C:\x\a\b.");
            assert_eq!(resolve("C:/x/repo", "sub/ "), r"C:\x\repo\sub\ ");
            assert_eq!(resolve("C:/a", "x/./y/../z/"), r"C:\a\x\z");
            assert_eq!(resolve(r"C:\proj\", ""), resolve(r"C:\proj", ""));
            assert_eq!(resolve("C:/a", "con"), r"C:\a\con");
            assert_eq!(resolve(r"\\server\share\dir", "../../.."), r"\\server\share\");
        } else {
            assert_eq!(resolve("/x/repo", "../a/b."), "/x/a/b.");
            assert_eq!(resolve("/a/", "x/./y/../z/"), "/a/x/z");
            assert_eq!(resolve("/a", "../../.."), "/");
        }
    }

    #[test]
    fn slashes_like_the_regexes() {
        assert_eq!(slashes("///a//b///"), "//a/b");
        assert_eq!(slashes("//"), "");
        assert_eq!(slashes("/"), "/");
        assert_eq!(slashes("C:\\"), "C:/");
        assert_eq!(slashes("C:\\\\"), "C:/");
        assert_eq!(slashes("\\\\.\\C:\\x"), "C:/x");
        assert_eq!(slashes("\\\\server\\share\\"), "//server/share");
    }
}
