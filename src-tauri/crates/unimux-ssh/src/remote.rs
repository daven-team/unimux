//! What an SSH cell runs on exec channels of its own connection (P5): the remote path listing of the SSH autocomplete
//! (1.1.4 src/shared/remotePaths.ts `listScript` / `parseListing`, 1.0.6) and the status bar script (src/shared/sshBar.ts
//! `barScript`, 1.0.7), with their answers in the 1.1.4 JSON shapes (`RemoteListResult`, `SshStatsRun`). The bar's parsing
//! stays in the renderer (it gets the text).

use serde_json::{Value, json};

use crate::session::{sh_quote, valid_remote_path};

/// `REMOTE_LIST_LIMIT`: entries the server sends at most for one folder.
pub const REMOTE_LIST_LIMIT: usize = 500;
/// `REMOTE_LIST_MAX_BYTES`: bytes of exec output read at most.
pub const REMOTE_LIST_MAX_BYTES: usize = 256 * 1024;
/// `SSH_BAR_TIMEOUT_MS`.
pub const SSH_BAR_TIMEOUT_MS: u64 = 5000;
/// `SSH_BAR_MAX_BYTES`.
pub const SSH_BAR_MAX_BYTES: usize = 64 * 1024;

/// A listing request of the renderer (`sshList`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListRequest {
    pub dir: String,
    pub cwd: Option<String>,
    pub cwd_only: bool,
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn has_control(s: &str) -> bool {
    s.chars().any(|c| c <= '\u{1f}' || c == '\u{7f}')
}

/// The folder for the listing script: "~/" becomes "$HOME"/..., '' stays the shell's current folder.
fn dir_arg(dir: &str) -> String {
    if dir.is_empty() {
        return "''".into();
    }
    match dir.strip_prefix("~/") {
        Some(rest) => format!("\"$HOME\"/{}", sh_quote(rest)),
        None => sh_quote(dir),
    }
}

/// `listScript`: run by `exec sh -s` (the script on stdin, so the login shell's syntax never matters).
pub fn list_script(req: &ListRequest) -> String {
    let cwd = req.cwd.as_deref().filter(|c| !c.is_empty() && valid_remote_path(c)).unwrap_or("");
    let mut lines: Vec<String> = vec![
        format!("c={}", sh_quote(cwd)),
        format!("d={}", dir_arg(&req.dir)),
        "p=".into(),
        "for k in $(cat /proc/$PPID/task/*/children 2>/dev/null); do".into(),
        "  [ \"$k\" = \"$$\" ] && continue".into(),
        "  case \"$(readlink /proc/$k/fd/0 2>/dev/null)\" in /dev/pts/*|/dev/tty*) p=$k;; esac".into(),
        "done".into(),
        "if [ -n \"$p\" ]; then".into(),
        "  s=$(cat /proc/$p/stat 2>/dev/null)".into(),
        "  s=${s##*) }".into(),
        "  set -- $s".into(),
        "  [ -n \"$6\" ] && [ \"$3\" != \"$6\" ] && { echo @busy; exit 0; }".into(),
        "  [ -n \"$c\" ] || c=$(readlink /proc/$p/cwd 2>/dev/null)".into(),
        "fi".into(),
        "[ -n \"$c\" ] && cd \"$c\" 2>/dev/null".into(),
        "echo \"@cwd $(pwd)\"".into(),
    ];
    if req.cwd_only {
        lines.push("exit 0".into());
    } else {
        lines.push("if [ -n \"$d\" ]; then cd \"$d\" 2>/dev/null || { echo @nodir; exit 0; }; fi".into());
        lines.push("echo \"@dir $(pwd)\"".into());
        lines.push(format!("ls -1ApL 2>/dev/null | head -n {}", REMOTE_LIST_LIMIT + 1));
    }
    lines.push(String::new());
    lines.join("\n")
}

/// `RemoteListResult`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ListResult {
    Ok { cwd: Option<String>, entries: Vec<(String, bool)>, truncated: bool },
    Failed(&'static str),
}

impl ListResult {
    pub fn to_json(&self) -> Value {
        match self {
            ListResult::Ok { cwd, entries, truncated } => json!({
                "ok": true,
                "cwd": cwd,
                "entries": entries.iter().map(|(name, dir)| json!({ "name": name, "dir": dir })).collect::<Vec<_>>(),
                "truncated": truncated,
            }),
            ListResult::Failed(reason) => json!({ "ok": false, "reason": reason }),
        }
    }
}

/// `parseListing`: lines before the first marker (a chatty .bashrc) are skipped.
pub fn parse_listing(output: &str, cwd_only: bool) -> ListResult {
    let text = output.replace('\r', "");
    let lines: Vec<&str> = text.split('\n').collect();
    let cwd_at = lines.iter().position(|l| l.starts_with("@cwd "));
    if lines.contains(&"@busy") {
        return ListResult::Failed("busy");
    }
    let Some(cwd_at) = cwd_at else { return ListResult::Failed("failed") };
    let raw_cwd = &lines[cwd_at][5..];
    let cwd = valid_remote_path(raw_cwd).then(|| raw_cwd.to_string());
    if cwd_only {
        return ListResult::Ok { cwd, entries: Vec::new(), truncated: false };
    }
    if lines[cwd_at + 1..].contains(&"@nodir") {
        return ListResult::Failed("nodir");
    }
    let Some(dir_at) = lines.iter().enumerate().position(|(i, l)| i > cwd_at && l.starts_with("@dir ")) else {
        return ListResult::Failed("failed");
    };
    let mut entries: Vec<(String, bool)> = Vec::new();
    for line in &lines[dir_at + 1..] {
        if line.is_empty() || *line == "./" || *line == "../" {
            continue;
        }
        let dir = line.ends_with('/');
        let name = if dir { &line[..line.len() - 1] } else { line };
        if name.is_empty() || name.contains('/') || utf16_len(name) > 255 || has_control(name) {
            continue;
        }
        entries.push((name.to_string(), dir));
        if entries.len() > REMOTE_LIST_LIMIT {
            break;
        }
    }
    let truncated = entries.len() > REMOTE_LIST_LIMIT;
    entries.truncate(REMOTE_LIST_LIMIT);
    ListResult::Ok { cwd, entries, truncated }
}

/// `barScript(first)`: `first` also asks for the system (os-release, the CPU count).
pub fn bar_script(first: bool) -> String {
    let mut lines: Vec<&str> = vec![
        "# unimux status bar",
        "LC_ALL=C; export LC_ALL",
        "echo \"@v 1\"",
        "k=$(uname -s 2>/dev/null)",
        "echo \"@host $(uname -n 2>/dev/null)\"",
        "echo \"@kernel $k $(uname -r 2>/dev/null)\"",
    ];
    if first {
        lines.extend([
            "if [ -r /etc/os-release ]; then grep -E '^(ID|ID_LIKE|PRETTY_NAME)=' /etc/os-release 2>/dev/null | sed 's/^/@osr /'",
            "elif [ -r /etc/redhat-release ]; then echo \"@osr PRETTY_NAME=$(head -n 1 /etc/redhat-release)\"; fi",
            "[ \"$k\" = Darwin ] && echo \"@osr PRETTY_NAME=macOS $(sw_vers -productVersion 2>/dev/null)\"",
            "echo \"@ncpu $(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null)\"",
        ]);
    }
    lines.extend([
        "echo \"@user $(id -un 2>/dev/null || whoami 2>/dev/null)\"",
        "echo \"@client ${SSH_CLIENT%% *}\"",
        "if [ -r /proc/stat ]; then",
        "  head -n 1 /proc/stat | sed 's/^/@stat /'",
        "  grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SReclaimable):' /proc/meminfo 2>/dev/null | sed 's/^/@mem /'",
        "  sed '1,2d; s/^/@net /' /proc/net/dev 2>/dev/null",
        "  echo \"@load $(cat /proc/loadavg 2>/dev/null)\"",
        "  echo \"@uptime $(cat /proc/uptime 2>/dev/null)\"",
        "  for c in $(cat /proc/$PPID/task/*/children 2>/dev/null); do",
        "    [ \"$c\" = \"$$\" ] && continue",
        "    t=$(readlink /proc/$c/fd/0 2>/dev/null)",
        "    case \"$t\" in /dev/pts/*|/dev/tty*) echo \"@tty ${t#/dev/}\"; break;; esac",
        "  done",
        "else",
        "  for s in kern.cp_time hw.memsize hw.physmem hw.pagesize vm.stats.vm.v_free_count vm.stats.vm.v_inactive_count vm.stats.vm.v_cache_count vm.loadavg kern.boottime; do",
        "    v=$(sysctl -n $s 2>/dev/null) && [ -n \"$v\" ] && echo \"@sysctl $s $v\"",
        "  done",
        "  echo \"@now $(date +%s)\"",
        "  if [ \"$k\" = Darwin ]; then",
        "    vm_stat 2>/dev/null | sed 's/^/@vm /'",
        "    ps -A -o %cpu= 2>/dev/null | awk '{s+=$1} END {print \"@pscpu \" s}'",
        "  fi",
        "  netstat -ibn 2>/dev/null | awk '$3 ~ /^<Link/ {print \"@ns \" $0}'",
        "fi",
        "who 2>/dev/null | head -n 50 | sed 's/^/@who /'",
        "l=; df -Pkl / >/dev/null 2>&1 && l=l",
        "df -Pk$l 2>/dev/null | sed '1d; s/^/@df /' | head -n 100",
        "echo @end",
        "",
    ]);
    lines.join("\n")
}

/// `SshStatsRun`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StatsRun {
    Ok { text: String, ms: u64, bytes: usize, partial: bool },
    Failed(&'static str),
}

impl StatsRun {
    pub fn to_json(&self) -> Value {
        match self {
            StatsRun::Ok { text, ms, bytes, partial } => {
                json!({ "ok": true, "text": text, "ms": ms, "bytes": bytes, "partial": partial })
            }
            StatsRun::Failed(reason) => json!({ "ok": false, "reason": reason }),
        }
    }
}

/// `sshList` of the renderer, checked like 1.1.4's `listFor` (id string, reqId number, dir up to 1024 and cwd null or up
/// to 4096 UTF-16 units). Returns `(id, reqId, request)`.
pub fn parse_list_message(m: &Value) -> Option<(String, Value, ListRequest)> {
    let id = m.get("id")?.as_str()?;
    let req_id = m.get("reqId").filter(|v| v.is_number())?;
    let dir = m.get("dir")?.as_str().filter(|d| utf16_len(d) <= 1024)?;
    let cwd = match m.get("cwd")? {
        Value::Null => None,
        Value::String(c) if utf16_len(c) <= 4096 => Some(c.clone()),
        _ => return None,
    };
    let cwd_only = m.get("cwdOnly") == Some(&Value::Bool(true));
    Some((id.to_string(), req_id.clone(), ListRequest { dir: dir.to_string(), cwd, cwd_only }))
}

/// `sshStats` of the renderer (`statsFor`): `(id, reqId, first)`.
pub fn parse_stats_message(m: &Value) -> Option<(String, Value, bool)> {
    let id = m.get("id")?.as_str()?;
    let req_id = m.get("reqId").filter(|v| v.is_number())?;
    Some((id.to_string(), req_id.clone(), m.get("first") == Some(&Value::Bool(true))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_list_script_quotes_its_folders() {
        let s = list_script(&ListRequest { dir: "~/my dir/".into(), cwd: Some("/srv/it's".into()), cwd_only: false });
        assert!(s.starts_with("c='/srv/it'\\''s'\nd=\"$HOME\"/'my dir/'\np=\n"));
        assert!(s.ends_with("echo \"@dir $(pwd)\"\nls -1ApL 2>/dev/null | head -n 501\n"));
        let s = list_script(&ListRequest { dir: String::new(), cwd: Some("relative".into()), cwd_only: true });
        assert!(s.starts_with("c=''\nd=''\n"));
        assert!(s.ends_with("echo \"@cwd $(pwd)\"\nexit 0\n"));
    }

    #[test]
    fn listings_parse_like_1_1_4() {
        let out = "motd\r\n@cwd /home/u\n@dir /home/u/src\n./\n../\nlib/\nmain.rs\nbad\u{1}name\na/b\n\n";
        assert_eq!(
            parse_listing(out, false),
            ListResult::Ok {
                cwd: Some("/home/u".into()),
                entries: vec![("lib".into(), true), ("main.rs".into(), false)],
                truncated: false
            }
        );
        assert_eq!(parse_listing("@busy\n@cwd /x\n", false), ListResult::Failed("busy"));
        assert_eq!(parse_listing("nothing\n", false), ListResult::Failed("failed"));
        assert_eq!(parse_listing("@cwd /x\n@nodir\n", false), ListResult::Failed("nodir"));
        assert_eq!(parse_listing("@cwd /x\n", false), ListResult::Failed("failed"));
        assert_eq!(parse_listing("@cwd relative\n", true), ListResult::Ok { cwd: None, entries: vec![], truncated: false });
        let many: String = (0..600).map(|i| format!("f{i}\n")).collect();
        let ListResult::Ok { entries, truncated, .. } = parse_listing(&format!("@cwd /\n@dir /\n{many}"), false) else {
            panic!()
        };
        assert_eq!((entries.len(), truncated), (500, true));
    }

    #[test]
    fn results_have_the_1_1_4_shape() {
        assert_eq!(ListResult::Failed("gone").to_json(), json!({ "ok": false, "reason": "gone" }));
        assert_eq!(
            ListResult::Ok { cwd: None, entries: vec![("a".into(), true)], truncated: false }.to_json(),
            json!({ "ok": true, "cwd": null, "entries": [{ "name": "a", "dir": true }], "truncated": false })
        );
        assert_eq!(
            StatsRun::Ok { text: "x".into(), ms: 3, bytes: 1, partial: false }.to_json(),
            json!({ "ok": true, "text": "x", "ms": 3, "bytes": 1, "partial": false })
        );
    }

    #[test]
    fn renderer_messages_are_checked() {
        let ok = json!({ "t": "sshList", "id": "c", "reqId": 4, "dir": "src/", "cwd": null });
        let (id, req, r) = parse_list_message(&ok).unwrap();
        assert_eq!((id.as_str(), req, r.cwd_only), ("c", json!(4), false));
        assert!(parse_list_message(&json!({ "id": "c", "reqId": "4", "dir": "", "cwd": null })).is_none());
        assert!(parse_list_message(&json!({ "id": "c", "reqId": 1, "dir": "", "cwd": 5 })).is_none());
        assert!(parse_list_message(&json!({ "id": "c", "reqId": 1, "dir": "a".repeat(1025), "cwd": null })).is_none());
        assert!(parse_list_message(&json!({ "id": "c", "reqId": 1, "dir": "" })).is_none());
        assert!(parse_stats_message(&json!({ "id": "c", "reqId": 1, "first": true })).unwrap().2);
        assert!(parse_stats_message(&json!({ "id": 1, "reqId": 1 })).is_none());
    }

    #[test]
    fn the_bar_script_asks_for_the_system_only_the_first_time() {
        assert!(bar_script(true).contains("@ncpu"));
        assert!(!bar_script(false).contains("@ncpu"));
        assert!(bar_script(false).ends_with("echo @end\n"));
    }
}
