//! Node's `path` module (win32 and posix flavours), ported for the checks 1.1.4 makes on strings before it touches the disk:
//! `resolve`, `relative`, `isAbsolute`. Lengths and indexes are in chars (Node counts UTF-16 units; only ASCII separators and
//! dots are ever compared, so both give the same answers). Golden rows: test/golden/files-path.jsonl.

/// Which `path` flavour: `path.win32` on Windows, `path.posix` on macOS.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Flavor {
    Win32,
    Posix,
}

impl Flavor {
    pub const fn native() -> Self {
        if cfg!(windows) { Flavor::Win32 } else { Flavor::Posix }
    }
    fn is_sep(self, c: char) -> bool {
        match self {
            Flavor::Win32 => c == '\\' || c == '/',
            Flavor::Posix => c == '/',
        }
    }
    fn sep(self) -> char {
        match self {
            Flavor::Win32 => '\\',
            Flavor::Posix => '/',
        }
    }
}

fn cwd() -> String {
    std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|_| ".".into())
}

/// Node's `normalizeString` (shared by both flavours).
fn normalize_string(path: &[char], allow_above_root: bool, separator: char, is_sep: impl Fn(char) -> bool) -> Vec<char> {
    let mut res: Vec<char> = Vec::new();
    let mut last_segment_length: isize = 0;
    let mut last_slash: isize = -1;
    let mut dots: isize = 0;
    let mut code = '\0';
    let len = path.len() as isize;
    let mut i: isize = 0;
    while i <= len {
        if i < len {
            code = path[i as usize];
        } else if is_sep(code) {
            break;
        } else {
            code = '/';
        }
        if is_sep(code) {
            if last_slash == i - 1 || dots == 1 {
                // NOOP
            } else if dots == 2 {
                let ends_with_dots = res.len() >= 2 && res[res.len() - 1] == '.' && res[res.len() - 2] == '.';
                if res.len() < 2 || last_segment_length != 2 || !ends_with_dots {
                    if res.len() > 2 {
                        match res.iter().rposition(|&c| c == separator) {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(at) => {
                                res.truncate(at);
                                let last = res.iter().rposition(|&c| c == separator).map(|p| p as isize).unwrap_or(-1);
                                last_segment_length = res.len() as isize - 1 - last;
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
                    if !res.is_empty() {
                        res.push(separator);
                    }
                    res.extend(['.', '.']);
                    last_segment_length = 2;
                }
            } else {
                let segment = &path[(last_slash + 1) as usize..i as usize];
                if !res.is_empty() {
                    res.push(separator);
                }
                res.extend_from_slice(segment);
                last_segment_length = i - last_slash - 1;
            }
            last_slash = i;
            dots = 0;
        } else if code == '.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
        i += 1;
    }
    res
}

fn is_device_root(c: char) -> bool {
    c.is_ascii_alphabetic()
}

/// `path.isAbsolute(p)`.
pub fn is_absolute(flavor: Flavor, path: &str) -> bool {
    let p: Vec<char> = path.chars().collect();
    match flavor {
        Flavor::Posix => p.first() == Some(&'/'),
        Flavor::Win32 => {
            if p.is_empty() {
                return false;
            }
            if flavor.is_sep(p[0]) {
                return true;
            }
            p.len() > 2 && is_device_root(p[0]) && p[1] == ':' && flavor.is_sep(p[2])
        }
    }
}

/// `path.resolve(...paths)` (the working directory fills in a relative start, like Node's `process.cwd()`).
pub fn resolve(flavor: Flavor, paths: &[&str]) -> String {
    match flavor {
        Flavor::Posix => resolve_posix(paths),
        Flavor::Win32 => resolve_win32(paths),
    }
}

fn resolve_posix(paths: &[&str]) -> String {
    let mut resolved: Vec<char> = Vec::new();
    let mut absolute = false;
    let mut i = paths.len() as isize - 1;
    while i >= -1 && !absolute {
        let path: String = if i >= 0 { paths[i as usize].to_string() } else { cwd() };
        i -= 1;
        if path.is_empty() {
            continue;
        }
        let mut next: Vec<char> = path.chars().collect();
        next.push('/');
        next.extend(resolved);
        resolved = next;
        absolute = path.starts_with('/');
    }
    let normalized = normalize_string(&resolved, !absolute, '/', |c| c == '/');
    let s: String = normalized.into_iter().collect();
    if absolute {
        format!("/{s}")
    } else if s.is_empty() {
        ".".into()
    } else {
        s
    }
}

fn resolve_win32(paths: &[&str]) -> String {
    let f = Flavor::Win32;
    let mut resolved_device: Vec<char> = Vec::new();
    let mut resolved_tail: Vec<char> = Vec::new();
    let mut resolved_absolute = false;
    let mut i = paths.len() as isize - 1;
    while i >= -1 {
        let path: Vec<char> = if i >= 0 {
            let p = paths[i as usize];
            if p.is_empty() {
                i -= 1;
                continue;
            }
            p.chars().collect()
        } else if resolved_device.is_empty() {
            cwd().chars().collect()
        } else {
            // Node reads the per-drive working directory (`=C:`) of cmd.exe; a process started by the app has none, so it
            // falls back to the drive root unless the working directory is on that drive.
            let c: Vec<char> = cwd().chars().collect();
            let same_drive = c.len() >= 2
                && c[..2].iter().collect::<String>().to_lowercase() == resolved_device.iter().collect::<String>().to_lowercase();
            if same_drive && c.get(2) == Some(&'\\') {
                c
            } else {
                let mut p = resolved_device.clone();
                p.push('\\');
                p
            }
        };
        i -= 1;
        let len = path.len();
        let mut root_end = 0;
        let mut device: Vec<char> = Vec::new();
        let mut is_abs = false;
        let code = path[0];
        if len == 1 {
            if f.is_sep(code) {
                root_end = 1;
                is_abs = true;
            }
        } else if f.is_sep(code) {
            is_abs = true;
            if f.is_sep(path[1]) {
                // A UNC root (\\server\share) or a device path (\\.\, \\?\).
                let mut j = 2;
                let mut last = j;
                while j < len && !f.is_sep(path[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    let first_part: Vec<char> = path[last..j].to_vec();
                    last = j;
                    while j < len && f.is_sep(path[j]) {
                        j += 1;
                    }
                    if j < len && j != last {
                        last = j;
                        while j < len && !f.is_sep(path[j]) {
                            j += 1;
                        }
                        if j == len || j != last {
                            if first_part != ['.'] && first_part != ['?'] {
                                device = ['\\', '\\'].to_vec();
                                device.extend(&first_part);
                                device.push('\\');
                                device.extend(&path[last..j]);
                                root_end = j;
                            } else {
                                device = ['\\', '\\'].to_vec();
                                device.extend(&first_part);
                                root_end = 4;
                            }
                        }
                    }
                }
            } else {
                root_end = 1;
            }
        } else if is_device_root(code) && path[1] == ':' {
            device = path[..2].to_vec();
            root_end = 2;
            if len > 2 && f.is_sep(path[2]) {
                is_abs = true;
                root_end = 3;
            }
        }
        if !device.is_empty() {
            if !resolved_device.is_empty() {
                let a: String = device.iter().collect();
                let b: String = resolved_device.iter().collect();
                if a.to_lowercase() != b.to_lowercase() {
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
            let mut next: Vec<char> = path[root_end.min(len)..].to_vec();
            next.push('\\');
            next.extend(resolved_tail);
            resolved_tail = next;
            resolved_absolute = is_abs;
            if is_abs && !resolved_device.is_empty() {
                break;
            }
        }
    }
    let tail = normalize_string(&resolved_tail, !resolved_absolute, '\\', |c| f.is_sep(c));
    let device: String = resolved_device.into_iter().collect();
    let tail: String = tail.into_iter().collect();
    if resolved_absolute {
        format!("{device}\\{tail}")
    } else {
        let s = format!("{device}{tail}");
        if s.is_empty() { ".".into() } else { s }
    }
}

/// One char lowercased the way `String.prototype.toLowerCase` does when the result is one char (multi-char results keep
/// the char, so indexes stay aligned; Node's own indexes go wrong there too).
fn lower_char(c: char) -> char {
    let mut l = c.to_lowercase();
    match (l.next(), l.next()) {
        (Some(one), None) => one,
        _ => c,
    }
}

/// `path.relative(from, to)`.
pub fn relative(flavor: Flavor, from: &str, to: &str) -> String {
    match flavor {
        Flavor::Posix => relative_posix(from, to),
        Flavor::Win32 => relative_win32(from, to),
    }
}

fn relative_posix(from: &str, to: &str) -> String {
    if from == to {
        return String::new();
    }
    let from: Vec<char> = resolve_posix(&[from]).chars().collect();
    let to: Vec<char> = resolve_posix(&[to]).chars().collect();
    if from == to {
        return String::new();
    }
    let from_start = 1;
    let from_end = from.len();
    let from_len = from_end - from_start;
    let to_start = 1;
    let to_len = to.len() - to_start;
    let length = from_len.min(to_len);
    let mut last_common_sep: isize = -1;
    let mut i = 0;
    while i < length {
        let fc = from[from_start + i];
        if fc != to[to_start + i] {
            break;
        } else if fc == '/' {
            last_common_sep = i as isize;
        }
        i += 1;
    }
    if i == length {
        if to_len > length {
            if to[to_start + i] == '/' {
                return to[to_start + i + 1..].iter().collect();
            }
            if i == 0 {
                return to[to_start + i..].iter().collect();
            }
        } else if from_len > length {
            if from[from_start + i] == '/' {
                last_common_sep = i as isize;
            } else if i == 0 {
                last_common_sep = 0;
            }
        }
    }
    let mut out = String::new();
    let mut k = (from_start as isize + last_common_sep + 1) as usize;
    while k <= from_end {
        if k == from_end || from[k] == '/' {
            out.push_str(if out.is_empty() { ".." } else { "/.." });
        }
        k += 1;
    }
    let rest: String = to[(to_start as isize + last_common_sep) as usize..].iter().collect();
    format!("{out}{rest}")
}

fn relative_win32(from: &str, to: &str) -> String {
    if from == to {
        return String::new();
    }
    let from_orig: Vec<char> = resolve_win32(&[from]).chars().collect();
    let to_orig: Vec<char> = resolve_win32(&[to]).chars().collect();
    if from_orig == to_orig {
        return String::new();
    }
    let from: Vec<char> = from_orig.iter().map(|&c| lower_char(c)).collect();
    let to: Vec<char> = to_orig.iter().map(|&c| lower_char(c)).collect();
    if from == to {
        return String::new();
    }
    let mut from_start = 0;
    while from_start < from.len() && from[from_start] == '\\' {
        from_start += 1;
    }
    let mut from_end = from.len();
    while from_end > from_start + 1 && from[from_end - 1] == '\\' {
        from_end -= 1;
    }
    let from_len = from_end - from_start;
    let mut to_start = 0;
    while to_start < to.len() && to[to_start] == '\\' {
        to_start += 1;
    }
    let mut to_end = to.len();
    while to_end > to_start + 1 && to[to_end - 1] == '\\' {
        to_end -= 1;
    }
    let to_len = to_end - to_start;
    let length = from_len.min(to_len);
    let mut last_common_sep: isize = -1;
    let mut i = 0;
    while i < length {
        let fc = from[from_start + i];
        if fc != to[to_start + i] {
            break;
        } else if fc == '\\' {
            last_common_sep = i as isize;
        }
        i += 1;
    }
    if i != length {
        if last_common_sep == -1 {
            return to_orig.iter().collect();
        }
    } else {
        if to_len > length {
            if to[to_start + i] == '\\' {
                return to_orig[to_start + i + 1..].iter().collect();
            }
            if i == 2 {
                return to_orig[to_start + i..].iter().collect();
            }
        }
        if from_len > length {
            if from[from_start + i] == '\\' {
                last_common_sep = i as isize;
            } else if i == 2 {
                last_common_sep = 3;
            }
        }
        if last_common_sep == -1 {
            last_common_sep = 0;
        }
    }
    let mut out = String::new();
    let mut k = (from_start as isize + last_common_sep + 1) as usize;
    while k <= from_end {
        if k == from_end || from[k] == '\\' {
            out.push_str(if out.is_empty() { ".." } else { "\\.." });
        }
        k += 1;
    }
    let mut to_start = (to_start as isize + last_common_sep) as usize;
    if !out.is_empty() {
        let rest: String = to_orig[to_start.min(to_end)..to_end].iter().collect();
        return format!("{out}{rest}");
    }
    if to_orig.get(to_start) == Some(&'\\') {
        to_start += 1;
    }
    to_orig[to_start.min(to_end)..to_end].iter().collect()
}

/// 1.1.4's `isInside(root, target)`: `relative(root, target)` neither climbs out nor jumps to another root.
pub fn is_inside(flavor: Flavor, root: &str, target: &str) -> bool {
    let rel = relative(flavor, root, target);
    let up = match flavor {
        Flavor::Win32 => "..\\",
        Flavor::Posix => "../",
    };
    rel != ".." && !rel.starts_with(up) && !is_absolute(flavor, &rel)
}

/// `path.dirname(p)` of an already resolved absolute path (enough for the rename and trash checks of the local pane).
pub fn sep_of(flavor: Flavor) -> char {
    flavor.sep()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolve_like_node() {
        let w = Flavor::Win32;
        assert_eq!(resolve(w, &["C:\\proj", "a/b/../c"]), "C:\\proj\\a\\c");
        assert_eq!(resolve(w, &["C:\\proj", ""]), "C:\\proj");
        assert_eq!(resolve(w, &["C:\\proj\\", "..\\.."]), "C:\\");
        assert_eq!(resolve(w, &["C:\\proj", "D:\\x"]), "D:\\x");
        assert_eq!(resolve(w, &["\\\\server\\share\\a", ".."]), "\\\\server\\share\\");
        assert_eq!(resolve(w, &["C:/a//b/./c/"]), "C:\\a\\b\\c");
        let p = Flavor::Posix;
        assert_eq!(resolve(p, &["/home/a", "../b/./c/"]), "/home/b/c");
        assert_eq!(resolve(p, &["/", ".."]), "/");
    }

    #[test]
    fn relative_like_node() {
        let w = Flavor::Win32;
        assert_eq!(relative(w, "C:\\proj", "C:\\proj\\a\\b"), "a\\b");
        assert_eq!(relative(w, "C:\\proj", "c:\\PROJ"), "");
        assert_eq!(relative(w, "C:\\proj", "C:\\other"), "..\\other");
        assert_eq!(relative(w, "C:\\proj", "D:\\proj"), "D:\\proj");
        assert_eq!(relative(w, "C:\\", "C:\\a"), "a");
        let p = Flavor::Posix;
        assert_eq!(relative(p, "/a/b", "/a/b/c"), "c");
        assert_eq!(relative(p, "/a/b", "/a"), "..");
        assert_eq!(relative(p, "/", "/x"), "x");
    }

    #[test]
    fn inside_checks() {
        let w = Flavor::Win32;
        assert!(is_inside(w, "C:\\proj", "C:\\proj"));
        assert!(is_inside(w, "C:\\proj", "C:\\proj\\..foo"));
        assert!(!is_inside(w, "C:\\proj", "C:\\proj2"));
        assert!(!is_inside(w, "C:\\proj", "D:\\proj\\a"));
        assert!(is_absolute(w, "/x") && is_absolute(w, "C:\\") && !is_absolute(w, "C:") && !is_absolute(w, "C:x"));
    }
}
