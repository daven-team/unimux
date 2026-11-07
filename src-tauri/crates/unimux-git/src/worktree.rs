//! git worktrees for cells that should work in isolation from the rest of the grid (G4, port of src/main/worktree.ts).
//!
//! - [`Git::create_worktree`]: `<parent>/<repo>-wt-<slug>` on a new branch `mc/<slug>` from HEAD (suffixed on collisions);
//! - [`Git::inspect_worktree`]: what removing a worktree would lose (uncommitted files, commits of its branch the project's
//!   HEAD lacks, commits on a detached HEAD) plus the HEAD and branch tip a confirmed removal checks again;
//! - [`Git::remove_worktree`]: inspects first and refuses (`unsafe`) when work would be lost that the user did not confirm,
//!   or when more appeared since the confirmation; forced (`--force`, `-D`) only for exactly the confirmed loss. Only
//!   branches unimux created (`mc/*`, not adopted) are ever deleted;
//! - [`Git::current_branch`], [`Git::is_git_repo`].
//!
//! These are also the internal API of the automation (M3: create_grid / add_agents with rollback through an unforced removal).
//!
//! Like worktree.ts these runs do not go through the Git panel's trust check, and they use their own timeouts (15 s reads,
//! 120 s writes) and error text (git's stderr, its first three lines). The runner's global safety arguments and scrubbed,
//! quiet environment apply (worktree.ts passed `-c core.fsmonitor=false` and the same scrubbing).

use std::path::Path;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use unimux_exec::{ExecError, ExecOptions, Program};

use crate::paths::{self, canonical_path};
use crate::text::js_trim;
use crate::{Git, js};

/// Reads (status, rev-list) must answer within this.
pub const READ_TIMEOUT: Duration = Duration::from_secs(15);
/// Adding or removing a big worktree may take longer.
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(120);
/// `maxBuffer` of worktree.ts.
pub const MAX_BUFFER: usize = 64 * 1024 * 1024;
/// `TIMEOUT_MESSAGE`.
pub const TIMEOUT_MESSAGE: &str = "Git nie odpowiedział w wyznaczonym czasie.";
/// No free `<repo>-wt-<name>` among 99 candidates.
pub const NO_FREE_NAME: &str = "Nie udało się znaleźć wolnej nazwy dla worktree";

/// `Worktree` of src/shared/types.ts (a cell's worktree in state.json).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Worktree {
    pub path: String,
    /// '' when unknown (an adopted worktree on a detached HEAD).
    #[serde(default)]
    pub branch: String,
    /// A worktree the cell joined (a resumed conversation), not one unimux created for it: its branch is never deleted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub adopted: Option<bool>,
}

impl Worktree {
    pub fn is_adopted(&self) -> bool {
        self.adopted == Some(true)
    }
}

/// `WorktreeInspection` of src/shared/types.ts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorktreeInspection {
    /// The folder is still on disk.
    pub exists: bool,
    /// Files with uncommitted changes, untracked ones included (ignored ones not).
    pub dirty: u64,
    /// Commits of the worktree branch that the project's current HEAD cannot reach.
    pub unmerged: u64,
    /// Commits reachable from the worktree's HEAD but from no branch, remote or tag (a detached HEAD).
    pub detached: u64,
    /// The project's current branch (the base of `unmerged`), "HEAD" when detached.
    pub base: String,
    /// The worktree's HEAD and the branch tip (commit ids, '' when none).
    pub head: String,
    pub tip: String,
}

/// `WorktreeRemoveResult`: `{ok: true}` or `{ok: false, code, error, inspection?}`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorktreeRemoveResult {
    Ok,
    /// Work would be lost and the removal was not confirmed for it (nothing removed).
    Unsafe(WorktreeInspection),
    /// Inspecting or removing the worktree failed.
    Failed(String),
    /// The worktree is gone, its branch stayed.
    Branch(String),
}

impl WorktreeRemoveResult {
    pub fn is_ok(&self) -> bool {
        matches!(self, Self::Ok)
    }

    /// The wire form of 1.1.4.
    pub fn to_json(&self) -> serde_json::Value {
        use serde_json::json;
        match self {
            Self::Ok => json!({ "ok": true }),
            Self::Unsafe(i) => json!({ "ok": false, "code": "unsafe", "error": "unsafe", "inspection": i }),
            Self::Failed(e) => json!({ "ok": false, "code": "failed", "error": e }),
            Self::Branch(e) => json!({ "ok": false, "code": "branch", "error": e }),
        }
    }
}

/// `ownsBranch`: only branches unimux created for a cell are deleted with its worktree; an adopted worktree never owns one.
pub fn owns_branch(wt: &Worktree) -> bool {
    !wt.is_adopted() && wt.branch.starts_with("mc/")
}

/// `losesWork`: work removing it would lose (the branch's own commits only count when the branch goes too).
pub fn loses_work(i: &WorktreeInspection, delete_branch: bool) -> bool {
    i.dirty > 0 || i.detached > 0 || (delete_branch && i.unmerged > 0)
}

/// `grewSince`: something was added since the user confirmed `c`: more files or commits, or a moved HEAD or branch tip.
pub fn grew_since(i: &WorktreeInspection, c: &WorktreeInspection) -> bool {
    i.dirty > c.dirty || i.unmerged > c.unmerged || i.detached > c.detached || i.head != c.head || i.tip != c.tip
}

/// `slug(s)`: lower case, every run of characters outside `[a-z0-9]` one dash, no dash at either end; "cell" when empty.
pub fn slug(s: &str) -> String {
    let lower = s.to_lowercase();
    let mut out = String::with_capacity(lower.len());
    let mut dash = false;
    for c in lower.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
            dash = false;
        } else if !dash {
            out.push('-');
            dash = true;
        }
    }
    let trimmed = out.strip_prefix('-').unwrap_or(&out);
    let trimmed = trimmed.strip_suffix('-').unwrap_or(trimmed);
    if trimmed.is_empty() { "cell".into() } else { trimmed.to_string() }
}

fn is_separator(c: char) -> bool {
    c == '/' || (cfg!(windows) && c == '\\')
}

/// `path.basename(p)` of the host system (trailing separators ignored; on Windows a leading drive `X:` is no part of it).
pub fn basename(p: &str) -> String {
    let mut s = p;
    if cfg!(windows) {
        let b = s.as_bytes();
        if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            s = &s[2..];
        }
    }
    let trimmed = s.trim_end_matches(is_separator);
    match trimmed.rfind(is_separator) {
        Some(i) => trimmed[i + 1..].to_string(),
        None => trimmed.to_string(),
    }
}

/// `join(dirname(projectPath), name)` for an absolute project path (Node's `join` normalizes like `resolve` does here).
pub fn sibling_path(project_path: &str, name: &str) -> String {
    paths::resolve(&paths::dirname(project_path), name)
}

/// The candidate folder and branch number `i` (1-based) of `createWorktree`.
pub fn candidate(project_path: &str, name: &str, i: u32) -> (String, String) {
    let root = slug(name);
    let n = if i == 1 { root } else { format!("{root}-{i}") };
    let path = sibling_path(project_path, &format!("{}-wt-{n}", basename(project_path)));
    (path, format!("mc/{n}"))
}

/// Counts the entries of `git status --porcelain=v1 -z` (a rename or copy carries its old path in the next field).
pub fn count_dirty(stdout: &str) -> u64 {
    let fields: Vec<&str> = stdout.split('\0').collect();
    let mut dirty = 0;
    let mut i = 0;
    while i < fields.len() {
        let f = fields[i];
        if js::len(f) >= 4 {
            dirty += 1;
            if f.starts_with('R') || f.starts_with('C') {
                i += 1;
            }
        }
        i += 1;
    }
    dirty
}

/// `Number(stdout.trim()) || 0` for a count.
fn count(stdout: &str) -> u64 {
    let n = js::js_number(js_trim(stdout));
    if n.is_finite() && n > 0.0 { n as u64 } else { 0 }
}

/// One entry of `git worktree list --porcelain`: its HEAD and the path as git spells it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListedWorktree {
    pub head: String,
    pub folder: String,
}

/// The entry of the porcelain listing whose folder is `want` (compared with `same`).
pub fn find_listed(stdout: &str, mut same: impl FnMut(&str) -> bool) -> Option<ListedWorktree> {
    let normalized = stdout.replace("\r\n", "\n");
    for block in normalized.split("\n\n") {
        let lines: Vec<&str> = block.split('\n').collect();
        let Some(folder) = lines.iter().find_map(|l| l.strip_prefix("worktree ")) else { continue };
        if same(folder) {
            let head = lines.iter().find_map(|l| l.strip_prefix("HEAD ")).unwrap_or("").to_string();
            return Some(ListedWorktree { head, folder: folder.to_string() });
        }
    }
    None
}

/// A failed run of git (the error object of execFile).
#[derive(Debug, Clone)]
pub struct WtError {
    stderr: String,
    message: String,
    timed_out: bool,
}

impl WtError {
    /// `gitError(error)`: the timeout text, or git's stderr (else the error message), its first three non-empty lines.
    pub fn text(&self) -> String {
        if self.timed_out {
            return TIMEOUT_MESSAGE.into();
        }
        let trimmed = js_trim(&self.stderr);
        let source = if trimmed.is_empty() { self.message.as_str() } else { trimmed };
        source
            .split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l))
            .filter(|l| !l.is_empty())
            .take(3)
            .collect::<Vec<_>>()
            .join("\n")
    }
}

impl std::fmt::Display for WtError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.text())
    }
}

impl Git {
    /// One git run of worktree.ts: `cwd`, the runner's global arguments and quiet scrubbed environment with
    /// `GIT_OPTIONAL_LOCKS=0`, `timeout`, 64 MiB of output at most.
    async fn wt_git(&self, cwd: &str, args: &[&str], timeout: Duration) -> Result<String, WtError> {
        let runner = self.runner();
        let mut env = runner.env(true, cwd);
        if cfg!(windows) {
            env.retain(|k, _| !k.to_string_lossy().eq_ignore_ascii_case("GIT_OPTIONAL_LOCKS"));
        }
        env.insert("GIT_OPTIONAL_LOCKS".into(), "0".into());
        let program = Program::Args { program: runner.options.bin.clone(), args: runner.args(args) };
        let options = ExecOptions {
            env: Some(env),
            cwd: Some(cwd.into()),
            timeout,
            max_output: MAX_BUFFER,
            stop_at_cap: true,
            stdin: Some(Vec::new()),
        };
        let command = format!("git {}", args.join(" "));
        let out = match unimux_exec::run_async(program, options).await {
            Ok(out) => out,
            Err(error) => {
                let source = match &error {
                    ExecError::Spawn { source, .. } | ExecError::Io(source) => source,
                };
                let message =
                    if source.kind() == std::io::ErrorKind::NotFound || (cfg!(windows) && source.raw_os_error() == Some(267)) {
                        "spawn git ENOENT".to_string()
                    } else {
                        format!("spawn git {source}")
                    };
                return Err(WtError { stderr: String::new(), message, timed_out: false });
            }
        };
        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        if out.timed_out {
            return Err(WtError { stderr, message: String::new(), timed_out: true });
        }
        if out.truncated {
            return Err(WtError { stderr: String::new(), message: "stdout maxBuffer length exceeded".into(), timed_out: false });
        }
        if out.code == Some(0) {
            return Ok(stdout);
        }
        Err(WtError { stderr, message: format!("Command failed: {command}"), timed_out: false })
    }

    async fn wt_read(&self, cwd: &str, args: &[&str]) -> Result<String, WtError> {
        self.wt_git(cwd, args, READ_TIMEOUT).await
    }

    async fn wt_write(&self, cwd: &str, args: &[&str]) -> Result<String, WtError> {
        self.wt_git(cwd, args, WRITE_TIMEOUT).await
    }

    /// `isGitRepo(path)`: `git rev-parse --is-inside-work-tree` says true.
    pub async fn is_git_repo(&self, path: &str) -> bool {
        if path.is_empty() || path.contains('\0') {
            return false;
        }
        matches!(self.wt_read(path, &["rev-parse", "--is-inside-work-tree"]).await, Ok(out) if js_trim(&out) == "true")
    }

    /// `branchTip(repo, branch)`: the commit of `refs/heads/<branch>`, '' when there is none.
    async fn branch_tip(&self, repo: &str, branch: &str) -> String {
        if branch.is_empty() {
            return String::new();
        }
        let r = format!("refs/heads/{branch}");
        match self.wt_read(repo, &["rev-parse", "--verify", "--quiet", &r]).await {
            Ok(out) => js_trim(&out).to_string(),
            Err(_) => String::new(),
        }
    }

    /// `createWorktree(projectPath, name)`: `<parent>/<repo>-wt-<slug>` on the new branch `mc/<slug>` from HEAD; a taken
    /// folder or branch moves on to `<slug>-2` ... `<slug>-99`.
    pub async fn create_worktree(&self, project_path: &str, name: &str) -> Result<Worktree, String> {
        for i in 1..100 {
            let (path, branch) = candidate(project_path, name, i);
            if Path::new(&path).exists() || !self.branch_tip(project_path, &branch).await.is_empty() {
                continue;
            }
            self.wt_write(project_path, &["worktree", "add", "-b", &branch, &path, "HEAD"]).await.map_err(|e| e.text())?;
            return Ok(Worktree { path, branch, adopted: None });
        }
        Err(NO_FREE_NAME.into())
    }

    /// `listedWorktree(projectPath, path)`: git's entry of this folder (both sides in their canonical spelling: an 8.3 short
    /// project path lists its worktrees under the long name), or None when git does not know it.
    async fn listed_worktree(&self, project_path: &str, path: &str) -> Result<Option<ListedWorktree>, WtError> {
        let want = canonical_path(path);
        let out = self.wt_read(project_path, &["worktree", "list", "--porcelain"]).await?;
        Ok(find_listed(&out, |folder| canonical_path(folder) == want))
    }

    /// `inspectWorktree(projectPath, wt)`: what removing it would lose (see [`WorktreeInspection`]). HEAD of the project is
    /// the base of `unmerged` on purpose: it is what `git branch -d` checks for a branch without an upstream.
    pub async fn inspect_worktree(&self, project_path: &str, wt: &Worktree) -> Result<WorktreeInspection, String> {
        self.inspect(project_path, wt).await.map_err(|e| e.text())
    }

    async fn inspect(&self, project_path: &str, wt: &Worktree) -> Result<WorktreeInspection, WtError> {
        let exists = Path::new(&wt.path).exists();
        let mut dirty = 0;
        let mut head = String::new();
        if exists {
            let status = self.wt_read(&wt.path, &["status", "--porcelain=v1", "-z", "--untracked-files=all"]).await?;
            dirty = count_dirty(&status);
            if let Ok(out) = self.wt_read(&wt.path, &["rev-parse", "--verify", "--quiet", "HEAD"]).await {
                head = js_trim(&out).to_string();
            }
        } else if let Some(listed) = self.listed_worktree(project_path, &wt.path).await? {
            head = listed.head;
        }
        let base = match self.wt_read(project_path, &["rev-parse", "--abbrev-ref", "HEAD"]).await {
            Ok(out) if !js_trim(&out).is_empty() => js_trim(&out).to_string(),
            _ => "HEAD".to_string(),
        };
        let tip = self.branch_tip(project_path, &wt.branch).await;
        let mut unmerged = 0;
        if !tip.is_empty() {
            let r = format!("refs/heads/{}", wt.branch);
            let out = match self.wt_read(project_path, &["rev-list", "--count", &r, "--not", "HEAD"]).await {
                Ok(out) => out,
                // HEAD without commits: every commit counts
                Err(_) => self.wt_read(project_path, &["rev-list", "--count", &r]).await?,
            };
            unmerged = count(&out);
        }
        let mut detached = 0;
        if !head.is_empty() {
            let out =
                self.wt_read(project_path, &["rev-list", "--count", &head, "--not", "--branches", "--remotes", "--tags"]).await?;
            detached = count(&out);
        }
        Ok(WorktreeInspection { exists, dirty, unmerged, detached, base, head, tip })
    }

    /// `removeWorktree(projectPath, wt, deleteBranch, confirmed)`: removes a worktree (and its branch, only when unimux
    /// created it). Inspects first, after the cell's terminal is gone:
    /// - nothing to lose: removed without --force, the branch deleted with -d (git itself refuses to lose a commit);
    /// - work would be lost and `confirmed` is missing, or more appeared since: [`WorktreeRemoveResult::Unsafe`] with the new
    ///   inspection, nothing removed;
    /// - otherwise (the user accepted exactly this loss): --force and -D.
    ///
    /// The worktree goes first: git cannot delete a branch that is checked out in a worktree.
    pub async fn remove_worktree(
        &self,
        project_path: &str,
        wt: &Worktree,
        delete_branch: bool,
        confirmed: Option<&WorktreeInspection>,
    ) -> WorktreeRemoveResult {
        let drop_branch = delete_branch && owns_branch(wt);
        let inspection = match self.inspect(project_path, wt).await {
            Ok(i) => i,
            Err(e) => return WorktreeRemoveResult::Failed(e.text()),
        };
        let force = loses_work(&inspection, drop_branch);
        if force && confirmed.is_none_or(|c| grew_since(&inspection, c)) {
            return WorktreeRemoveResult::Unsafe(inspection);
        }
        let removed = if inspection.exists {
            let mut args = vec!["worktree", "remove"];
            if force {
                args.push("--force");
            }
            args.push(&wt.path);
            self.wt_write(project_path, &args).await.map(|_| ())
        } else {
            // A folder already gone: only its own registration is dropped (`worktree prune` would also drop others on an
            // unplugged drive).
            match self.listed_worktree(project_path, &wt.path).await {
                Ok(Some(listed)) => self.wt_write(project_path, &["worktree", "remove", &listed.folder]).await.map(|_| ()),
                Ok(None) => Ok(()),
                Err(e) => Err(e),
            }
        };
        if let Err(e) = removed {
            return WorktreeRemoveResult::Failed(e.text());
        }
        if drop_branch && !inspection.tip.is_empty() {
            let flag = if force { "-D" } else { "-d" };
            if let Err(e) = self.wt_write(project_path, &["branch", flag, &wt.branch]).await {
                return WorktreeRemoveResult::Branch(e.text());
            }
        }
        WorktreeRemoveResult::Ok
    }

    /// `currentBranch(path)` of worktree.ts: the branch checked out in a folder (None when detached or not a repository).
    pub async fn current_branch(&self, path: &str) -> Option<String> {
        let out = self.wt_read(path, &["rev-parse", "--abbrev-ref", "HEAD"]).await.ok()?;
        let branch = js_trim(&out);
        (!branch.is_empty() && branch != "HEAD").then(|| branch.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn insp(dirty: u64, unmerged: u64, detached: u64, head: &str, tip: &str) -> WorktreeInspection {
        WorktreeInspection { exists: true, dirty, unmerged, detached, base: "main".into(), head: head.into(), tip: tip.into() }
    }

    #[test]
    fn slug_like_the_reference() {
        assert_eq!(slug("Grid 1-2"), "grid-1-2");
        assert_eq!(slug("  --Hello, World!--  "), "hello-world");
        assert_eq!(slug("Zażółć gęślą"), "za-g-l");
        assert_eq!(slug("!!!"), "cell");
        assert_eq!(slug(""), "cell");
        assert_eq!(slug("ABC_def.9"), "abc-def-9");
        assert_eq!(slug("\u{212A}elvin"), "kelvin");
    }

    #[test]
    fn basename_and_candidates() {
        assert_eq!(basename("/home/me/proj/"), "proj");
        assert_eq!(basename("proj"), "proj");
        let (path, branch) = candidate(if cfg!(windows) { r"D:\Projekty\bot" } else { "/srv/bot" }, "Grid 1", 1);
        assert_eq!(branch, "mc/grid-1");
        assert_eq!(path, if cfg!(windows) { r"D:\Projekty\bot-wt-grid-1" } else { "/srv/bot-wt-grid-1" });
        let (path, branch) = candidate(if cfg!(windows) { r"D:\Projekty\bot\" } else { "/srv/bot/" }, "x", 3);
        assert_eq!(branch, "mc/x-3");
        assert_eq!(path, if cfg!(windows) { r"D:\Projekty\bot-wt-x-3" } else { "/srv/bot-wt-x-3" });
        if cfg!(windows) {
            assert_eq!(basename(r"C:\a\b"), "b");
            assert_eq!(candidate("D:/x/y", "n", 1).0, r"D:\x\y-wt-n");
        }
    }

    #[test]
    fn dirty_counts_skip_the_old_path_of_a_rename() {
        assert_eq!(count_dirty(""), 0);
        assert_eq!(count_dirty(" M a.txt\0?? b.txt\0"), 2);
        assert_eq!(count_dirty("R  new.txt\0old.txt\0A  c.txt\0"), 2);
        assert_eq!(count_dirty("C  copy.txt\0src.txt\0"), 1);
        // the old path of a rename is skipped even when it looks like an entry
        assert_eq!(count_dirty("R  n\0R  o.txt\0?? x\0"), 2);
    }

    #[test]
    fn counts_read_like_number_or_zero() {
        assert_eq!(count("3\n"), 3);
        assert_eq!(count(""), 0);
        assert_eq!(count("x"), 0);
    }

    #[test]
    fn listed_worktrees_are_found_with_their_head() {
        let out = "worktree D:/p\nHEAD aaa\nbranch refs/heads/main\n\nworktree D:/p-wt-x\nHEAD bbb\nbranch refs/heads/mc/x\n\n";
        assert_eq!(
            find_listed(out, |f| f == "D:/p-wt-x"),
            Some(ListedWorktree { head: "bbb".into(), folder: "D:/p-wt-x".into() })
        );
        let crlf = out.replace('\n', "\r\n");
        assert_eq!(find_listed(&crlf, |f| f == "D:/p").map(|l| l.head), Some("aaa".into()));
        assert_eq!(find_listed(out, |f| f == "D:/q"), None);
    }

    #[test]
    fn safety_rules() {
        let wt = |branch: &str, adopted: Option<bool>| Worktree { path: "x".into(), branch: branch.into(), adopted };
        assert!(owns_branch(&wt("mc/a", None)));
        assert!(owns_branch(&wt("mc/a", Some(false))));
        assert!(!owns_branch(&wt("mc/a", Some(true))));
        assert!(!owns_branch(&wt("feature", None)));
        assert!(!owns_branch(&wt("", None)));

        assert!(!loses_work(&insp(0, 3, 0, "h", "t"), false));
        assert!(loses_work(&insp(0, 3, 0, "h", "t"), true));
        assert!(loses_work(&insp(1, 0, 0, "h", "t"), false));
        assert!(loses_work(&insp(0, 0, 1, "h", "t"), false));

        let c = insp(2, 1, 0, "h", "t");
        assert!(!grew_since(&insp(2, 1, 0, "h", "t"), &c));
        assert!(!grew_since(&insp(1, 0, 0, "h", "t"), &c));
        assert!(grew_since(&insp(3, 1, 0, "h", "t"), &c));
        assert!(grew_since(&insp(2, 2, 0, "h", "t"), &c));
        assert!(grew_since(&insp(2, 1, 1, "h", "t"), &c));
        assert!(grew_since(&insp(2, 1, 0, "h2", "t"), &c));
        assert!(grew_since(&insp(2, 1, 0, "h", "t2"), &c));
    }

    #[test]
    fn wire_forms() {
        let wt: Worktree = serde_json::from_value(serde_json::json!({"path": "p", "branch": "mc/x"})).unwrap();
        assert_eq!(serde_json::to_value(&wt).unwrap(), serde_json::json!({"path": "p", "branch": "mc/x"}));
        let i = insp(1, 2, 3, "h", "t");
        assert_eq!(
            WorktreeRemoveResult::Unsafe(i.clone()).to_json(),
            serde_json::json!({"ok": false, "code": "unsafe", "error": "unsafe", "inspection": {
                "exists": true, "dirty": 1, "unmerged": 2, "detached": 3, "base": "main", "head": "h", "tip": "t"
            }})
        );
        assert_eq!(WorktreeRemoveResult::Ok.to_json(), serde_json::json!({"ok": true}));
        assert_eq!(WorktreeRemoveResult::Branch("e".into()).to_json()["code"], "branch");
    }

    #[test]
    fn error_text_like_git_error() {
        let e = WtError { stderr: "\nfatal: a\n\nb\r\nc\nd\n".into(), message: "Command failed".into(), timed_out: false };
        assert_eq!(e.text(), "fatal: a\nb\nc");
        let e = WtError { stderr: "  ".into(), message: "Command failed: git x".into(), timed_out: false };
        assert_eq!(e.text(), "Command failed: git x");
        let e = WtError { stderr: "x".into(), message: String::new(), timed_out: true };
        assert_eq!(e.text(), TIMEOUT_MESSAGE);
    }
}
