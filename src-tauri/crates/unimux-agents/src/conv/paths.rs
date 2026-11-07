//! Node's `path.join` (win32 on Windows, posix elsewhere) for the folder walks, so the `file` of a hit is the same string
//! 1.1.4 gave (`C:/x/.claude` from CLAUDE_CONFIG_DIR becomes `C:\x\.claude\projects\...`).

/// `path.join(base, ...parts)`.
pub fn join(base: &str, parts: &[&str]) -> String {
    let sep = if cfg!(windows) { "\\" } else { "/" };
    let mut joined = String::new();
    for p in std::iter::once(base).chain(parts.iter().copied()).filter(|p| !p.is_empty()) {
        if !joined.is_empty() {
            joined.push_str(sep);
        }
        joined.push_str(p);
    }
    if joined.is_empty() {
        return ".".into();
    }
    normalize(&joined)
}

/// `path.normalize(p)`.
pub fn normalize(p: &str) -> String {
    if cfg!(windows) { normalize_win(p) } else { normalize_posix(p) }
}

fn segments(tail: &str, is_sep: impl Fn(char) -> bool, absolute: bool) -> Vec<&str> {
    let mut out: Vec<&str> = Vec::new();
    for seg in tail.split(is_sep) {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|s| *s != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    out
}

pub fn normalize_posix(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let absolute = p.starts_with('/');
    let trailing = p.ends_with('/');
    let mut tail = segments(p, |c| c == '/', absolute).join("/");
    if tail.is_empty() && !absolute {
        tail = ".".into();
    }
    if !tail.is_empty() && trailing {
        tail.push('/');
    }
    if absolute { format!("/{tail}") } else { tail }
}

pub fn normalize_win(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let is_sep = |c: char| c == '\\' || c == '/';
    let chars: Vec<char> = p.chars().collect();
    let mut root = String::new();
    let mut rest_at = 0;
    let mut absolute = false;
    if chars.len() >= 2 && is_sep(chars[0]) && is_sep(chars[1]) {
        // UNC: \\server\share\
        let body: String = chars[2..].iter().collect();
        let mut parts = body.splitn(3, is_sep);
        let server = parts.next().unwrap_or("");
        let share = parts.next().unwrap_or("");
        if !server.is_empty() && !share.is_empty() {
            root = format!("\\\\{server}\\{share}\\");
            rest_at = 2 + server.chars().count() + 1 + share.chars().count();
            absolute = true;
        } else {
            root = "\\".into();
            rest_at = 1;
            absolute = true;
        }
    } else if chars.len() >= 2 && chars[1] == ':' && chars[0].is_ascii_alphabetic() {
        root = format!("{}:", chars[0]);
        rest_at = 2;
        if chars.len() > 2 && is_sep(chars[2]) {
            root.push('\\');
            absolute = true;
            rest_at = 3;
        }
    } else if is_sep(chars[0]) {
        root = "\\".into();
        rest_at = 1;
        absolute = true;
    }
    let tail_src: String = chars[rest_at.min(chars.len())..].iter().collect();
    let trailing = chars.last().is_some_and(|c| is_sep(*c));
    let mut tail = segments(&tail_src, is_sep, absolute).join("\\");
    if tail.is_empty() && !absolute {
        tail = ".".into();
    }
    if !tail.is_empty() && trailing {
        tail.push('\\');
    }
    if root.ends_with('\\') && tail.is_empty() {
        return root;
    }
    format!("{root}{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_like_node_on_windows() {
        assert_eq!(normalize_win("C:/x/.claude/"), "C:\\x\\.claude\\");
        assert_eq!(normalize_win("C:\\x\\\\y\\..\\z"), "C:\\x\\z");
        assert_eq!(normalize_win("\\\\srv\\share\\a/b"), "\\\\srv\\share\\a\\b");
        assert_eq!(normalize_win("C:\\"), "C:\\");
        assert_eq!(normalize_win("a/./b"), "a\\b");
        assert_eq!(normalize_posix("/a//b/../c/"), "/a/c/");
        assert_eq!(normalize_posix("a/.."), ".");
        if cfg!(windows) {
            assert_eq!(join("C:/x/.claude/", &["projects"]), "C:\\x\\.claude\\projects");
        } else {
            assert_eq!(join("/x/.claude/", &["projects"]), "/x/.claude/projects");
        }
    }
}
