//! G3: the reads and mutations of the Git panel (port of the rest of `class Git` in src/main/git.ts).
//!
//! - Reads that start nothing work without trust: `log`, `show`, `branches`, commit and staged diffs.
//! - Reads that can start a repository program need trust: `status` (with the push target and the remote list, cached while
//!   the local configuration file is unchanged), working and untracked diffs (an untracked file is shown only when git lists
//!   it as untracked and no part of its path is a link or an alias).
//! - Writes go through [`Git::mutate`]: one per repository (all its worktrees share the lock) at a time, one use per request
//!   id, never in a repository larger than the project, only when trusted (the configuration is scanned again for every
//!   write). fetch, pull and push carry the GitHub sign-in of unimux ([`crate::RemoteAuth`]) and run once more without it when
//!   GitHub refuses it ([`Git::network`]).
//! - The git half of "Publish to GitHub": [`Git::publish_info`] and [`Git::publish_push`].
//!
//! Every argument that comes from the renderer was validated by [`crate::shared::validate_git_request`]; paths and commit
//! messages go behind "--" or on stdin.

use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

use serde::Serialize;

use crate::js::JsNum;
use crate::runner::DIFF_CAP;
use crate::shared::{
    self, GIT_COMMIT_FILE_LIMIT, GIT_MAX_FILES, GitBranch, GitCheckoutRequest, GitCommitDetails, GitCommitRequest,
    GitDiffRequest, GitDiffResult, GitDiffSource, GitLogPage, GitLogRequest, GitOpResult, GitPathsRequest, GitProjectRelation,
    GitPushRequest, GitPushTarget, GitStatus, RelationKind,
};
use crate::text::{is_js_space, js_trim, redact_secrets, trim_git_text};
use crate::{Git, GitErrorCode, GitFailure, GitResult, PUSH_TARGET_TTL, RunOptions, RunOutput, paths, trust};

pub const PARENT: &str = "To repozytorium nadrzędne wobec projektu: zapisy są wyłączone.";
pub use crate::clone::BUSY;
pub const NO_SUCH_COMMIT: &str = "Nie ma takiego commita.";
pub const COMMIT_UNREADABLE: &str = "Nie udało się odczytać commita.";
pub const NOT_UNTRACKED: &str = "To nie jest nieśledzony plik tego repozytorium.";
pub const PUSH_NEEDS_BRANCH: &str = "Push wymaga gałęzi z co najmniej jednym commitem.";
pub const NO_PUSH_REMOTE: &str = "Brak zdalnego repozytorium, do którego można wypchnąć tę gałąź.";
pub const PUSH_TARGET_CHANGED: &str = "Cel push zmienił się od ostatniego odświeżenia. Odśwież panel i spróbuj ponownie.";
pub const NOTHING_STAGED: &str = "Nic nie jest dodane do commita. Dodaj najpierw pliki.";
pub const DIRTY: &str = "Masz niezatwierdzone zmiany. Zatwierdź je lub odłóż, zanim zmienisz gałąź.";
pub const NO_SUCH_BRANCH: &str = "Nie ma takiej gałęzi.";
pub const REMOTE_EXISTS: &str = "To repozytorium ma już zdalne repozytorium.";

/// What publishing needs to know before anything is created on GitHub (`publishInfo`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublishInfo {
    /// The checked out branch (None: detached HEAD).
    pub branch: Option<String>,
    /// No commit yet.
    pub initial: bool,
    pub remotes: Vec<String>,
}

/// The git half of publishing (`publishPush`): `pushed` false keeps git's message (the remote stays).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PublishPushed {
    pub pushed: bool,
    pub message: String,
}

fn fail<T>(code: GitErrorCode, message: &str) -> GitResult<T> {
    Err(GitFailure::new(code, message))
}

/// A scope of JS: an empty string is "no scope".
fn given(scope: Option<&str>) -> Option<&str> {
    scope.filter(|s| !s.is_empty())
}

/// `out.stdout.split('\n').map((r) => r.trim()).filter(Boolean)`.
fn lines(stdout: &str) -> Vec<String> {
    stdout.split('\n').map(js_trim).filter(|l| !l.is_empty()).map(str::to_string).collect()
}

/// `/^Binary files .* differ$|^GIT binary patch$/m.test(text)`: a JS multiline match, lines end at \n, \r, U+2028, U+2029.
pub fn is_binary_diff(text: &str) -> bool {
    const HEAD: &str = "Binary files ";
    const TAIL: &str = " differ";
    text.split(['\n', '\r', '\u{2028}', '\u{2029}']).any(|line| {
        line == "GIT binary patch" || (line.len() >= HEAD.len() + TAIL.len() && line.starts_with(HEAD) && line.ends_with(TAIL))
    })
}

/// `/^https:\/\/\S+$/.test(url)` (JS `\S`).
pub fn is_plain_https(url: &str) -> bool {
    url.strip_prefix("https://").is_some_and(|rest| !rest.is_empty() && !rest.chars().any(is_js_space))
}

/// `/^(hint|warning):/i`.
fn is_hint(line: &str) -> bool {
    let lower = line.get(..8).map(str::to_ascii_lowercase).unwrap_or_else(|| line.to_ascii_lowercase());
    lower.starts_with("hint:") || lower.starts_with("warning:")
}

/// `opMessage(out, fallback)`: the last two lines git printed that are not hints or warnings.
pub fn op_message(out: &RunOutput, fallback: &str) -> GitOpResult {
    let text = trim_git_text(&format!("{}\n{}", out.stdout, out.stderr), 400);
    let kept: Vec<&str> = text.split('\n').map(js_trim).filter(|l| !l.is_empty() && !is_hint(l)).collect();
    let tail = kept[kept.len().saturating_sub(2)..].join(" ");
    GitOpResult { message: if tail.is_empty() { fallback.to_string() } else { tail } }
}

/// Ends a write however it ends (an answer, an error, a dropped request): the repository is free again, its cached root, scan,
/// remotes and push targets are forgotten and the generation moves on.
struct WriteGuard<'a> {
    git: &'a Git,
    key: String,
    dir: String,
    root: String,
}

impl Drop for WriteGuard<'_> {
    fn drop(&mut self) {
        self.git.busy.release(&self.key);
        self.git.forget_root(&self.dir);
        self.git.forget_scan(&self.root);
        self.git.remote_lists.lock().remove(&self.root);
        self.git.bump_generation();
        let prefix = format!("{}\0", self.root);
        self.git.push_targets.lock().retain(|k, _| !k.starts_with(&prefix));
    }
}

impl Git {
    /// Takes `key` in the set of running writes; None (busy) when another write holds it.
    pub fn try_busy(&self, key: &str) -> Option<crate::clone::BusyGuard<'_>> {
        self.busy.take(key)
    }

    fn read_truncatable(&self) -> RunOptions {
        RunOptions { allow_truncate: true, ..self.read_options() }
    }

    fn write_options(&self, timeout: Duration) -> RunOptions {
        RunOptions::write(timeout)
    }

    // ---------- reads that start nothing ----------

    /// `log(dir, req)`: a page of the history (one more than asked tells whether there is more).
    pub async fn log(&self, dir: &str, req: &GitLogRequest) -> GitResult<GitLogPage> {
        let root = self.root(dir).await?;
        let mut args: Vec<String> = vec![
            "log".into(),
            "--decorate=full".into(),
            "-z".into(),
            format!("--format={}", shared::LOG_FORMAT),
            format!("--max-count={}", u64::from(req.count) + 1),
            format!("--skip={}", req.skip),
        ];
        if req.all {
            args.push("--all".into());
        }
        if let Some(search) = req.search.as_deref().filter(|s| !s.is_empty()) {
            args.extend(["--fixed-strings".into(), "--regexp-ignore-case".into(), format!("--grep={search}")]);
        }
        if let Some(author) = req.author.as_deref().filter(|s| !s.is_empty()) {
            args.extend(["--fixed-strings".into(), "--regexp-ignore-case".into(), format!("--author={author}")]);
        }
        if let Some(path) = req.path.as_deref().filter(|s| !s.is_empty()) {
            args.extend(["--".into(), path.to_string()]);
        }
        let out = match self.run(&root, &args, &self.read_truncatable()).await {
            Ok(out) => out,
            Err(e) => {
                // A repository without commits has no HEAD to walk: that is an empty history, not an error.
                let lower = e.message.to_ascii_lowercase();
                if ["does not have any commits", "unknown revision", "bad default revision"].iter().any(|m| lower.contains(m)) {
                    return Ok(GitLogPage { commits: Vec::new(), has_more: false });
                }
                return Err(e);
            }
        };
        let mut commits = shared::parse_log(&out.stdout);
        let count = req.count as usize;
        let has_more = commits.len() > count;
        commits.truncate(count);
        Ok(GitLogPage { commits, has_more })
    }

    /// The first parent of a commit, None for a root commit or on any failure.
    async fn parent_of(&self, root: &str, hash: &str) -> Option<String> {
        let spec = format!("{hash}^1^{{commit}}");
        let out = self.run(root, &["rev-parse", "--verify", "--quiet", spec.as_str()], &self.read_options()).await.ok()?;
        let parent = js_trim(&out.stdout);
        (!parent.is_empty()).then(|| parent.to_string())
    }

    /// `show(dir, hash)`: the commit, its message (secrets redacted) and its files against the first parent.
    pub async fn show(&self, dir: &str, hash: &str) -> GitResult<GitCommitDetails> {
        let root = self.root(dir).await?;
        let format = format!("--format={}", shared::DETAILS_FORMAT);
        let info = match self
            .run(&root, &["show", "-s", "--decorate=full", format.as_str(), hash, "--"], &self.read_truncatable())
            .await
        {
            Ok(out) => out,
            Err(e) if e.code == GitErrorCode::Failed => return fail(GitErrorCode::Invalid, NO_SUCH_COMMIT),
            Err(e) => return Err(e),
        };
        let Some(mut parsed) = shared::parse_details(&info.stdout) else {
            return fail(GitErrorCode::Failed, COMMIT_UNREADABLE);
        };
        parsed.commit.subject = redact_secrets(&parsed.commit.subject);
        parsed.message = redact_secrets(&parsed.message);
        // A merge is shown against its first parent (diff-tree -m would list the changes against every parent).
        let parent = if parsed.commit.parents.is_empty() { None } else { self.parent_of(&root, hash).await };
        let mut args: Vec<String> = ["diff-tree", "-r", "-z", "-M", "--no-commit-id", "--raw", "--numstat", "--no-ext-diff"]
            .into_iter()
            .map(String::from)
            .collect();
        match parent {
            Some(parent) => args.extend([parent, hash.to_string()]),
            None => args.extend(["--root".to_string(), hash.to_string()]),
        }
        let tree = self.run(&root, &args, &self.read_truncatable()).await?;
        let (files, truncated) = shared::parse_diff_tree(&tree.stdout, GIT_COMMIT_FILE_LIMIT);
        let added: f64 = files.iter().map(|f| f.added.map_or(0.0, |n| n.0)).sum();
        let deleted: f64 = files.iter().map(|f| f.deleted.map_or(0.0, |n| n.0)).sum();
        Ok(GitCommitDetails {
            commit: parsed.commit,
            email: parsed.email,
            message: parsed.message,
            files,
            files_truncated: truncated || tree.truncated,
            added: JsNum(added),
            deleted: JsNum(deleted),
        })
    }

    /// `branches(dir)`: local and remote branches by commit date; a remote branch with a local twin is left out.
    pub async fn branches(&self, dir: &str) -> GitResult<Vec<GitBranch>> {
        let root = self.root(dir).await?;
        let format = format!("--format={}", shared::BRANCH_FORMAT);
        let args = ["for-each-ref", "--count=400", "--sort=-committerdate", format.as_str(), "refs/heads", "refs/remotes"];
        let out = self.run(&root, &args, &self.read_truncatable()).await?;
        let all = shared::parse_branches(&out.stdout);
        let local: Vec<String> = all.iter().filter(|b| !b.remote).map(|b| b.name.clone()).collect();
        // `b.name.slice(b.name.indexOf('/') + 1)`: no '/' keeps the whole name.
        let short = |name: &str| name.find('/').map_or(name.to_string(), |i| name[i + 1..].to_string());
        Ok(all.into_iter().filter(|b| !b.remote || !local.contains(&short(&b.name))).collect())
    }

    // ---------- reads that need trust ----------

    /// `status(dir, scope)`: identical calls share one run (a window focus asks the Files tree and the Git panel at once).
    pub fn status(
        self: &Arc<Self>,
        dir: &str,
        scope: Option<&str>,
    ) -> impl Future<Output = GitResult<GitStatus>> + Send + 'static + use<> {
        let key = format!("status\0{}\0{dir}\0{}", self.generation(), scope.unwrap_or(""));
        let (me, dir, scope) = (self.clone(), dir.to_string(), scope.map(str::to_string));
        self.shared(&key, async move { me.read_status(&dir, scope.as_deref()).await })
    }

    async fn read_status(&self, dir: &str, scope: Option<&str>) -> GitResult<GitStatus> {
        let root = self.root(dir).await?;
        self.require_trust(&root, false).await?;
        let args = ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=normal"];
        let out = self.run(&root, &args, &self.read_truncatable()).await?;
        let parsed = shared::parse_status_v2(&out.stdout, GIT_MAX_FILES);
        let push = match parsed.branch.as_deref() {
            Some(branch) if !branch.is_empty() && !parsed.initial => self.cached_push_target(&root, branch).await,
            _ => None,
        };
        let parent = given(scope).is_some_and(|s| !Self::within_scope(s, &root));
        let has_remote = push.is_some() || !self.cached_remotes(&root).await.is_empty();
        let project_relation = Self::relation(given(scope), &root);
        Ok(GitStatus {
            branch: parsed.branch,
            detached: parsed.detached,
            head: parsed.head,
            initial: parsed.initial,
            upstream: parsed.upstream,
            ahead: parsed.ahead,
            behind: parsed.behind,
            files: parsed.files,
            truncated: parsed.truncated || out.truncated,
            root,
            push,
            parent,
            project_relation,
            has_remote: Some(has_remote),
        })
    }

    /// `relation(scope, root)`: how the project folder and the repository root lie to each other (canonical paths).
    pub fn relation(scope: Option<&str>, root: &str) -> Option<GitProjectRelation> {
        let Some(scope) = scope else {
            return Some(GitProjectRelation { kind: RelationKind::InsideRoot, prefix: String::new() });
        };
        if let Some(prefix) = paths::relative_inside(root, scope) {
            return Some(GitProjectRelation { kind: RelationKind::InsideRoot, prefix });
        }
        paths::relative_inside(scope, root).map(|prefix| GitProjectRelation { kind: RelationKind::ContainsRoot, prefix })
    }

    /// The push target the status shows, remembered for [`PUSH_TARGET_TTL`] while the local configuration file is unchanged.
    async fn cached_push_target(&self, root: &str, branch: &str) -> Option<GitPushTarget> {
        let started = self.generation();
        let stamp = self.config_stamp(root).await;
        let key = format!("{root}\0{branch}");
        let hit = self.push_targets.lock().get(&key).cloned();
        if let Some((target, at, s)) = hit
            && s == stamp
            && at.elapsed() < PUSH_TARGET_TTL
        {
            return target;
        }
        let target = self.push_target(root, branch).await;
        // A write that ran meanwhile dropped the cache: this older answer must not come back into it.
        if self.generation() == started {
            self.push_targets.lock().remember(key, (target.clone(), Instant::now(), stamp));
        }
        target
    }

    /// Changes whenever the repository's local configuration file does (a remote added or removed, a pushurl set).
    async fn config_stamp(&self, root: &str) -> String {
        let Ok(dirs) = self.git_dirs(root).await else { return "none".into() };
        let file = std::path::Path::new(&dirs.common_dir).join("config");
        let meta = tokio::task::spawn_blocking(move || std::fs::metadata(file)).await;
        match meta {
            Ok(Ok(meta)) => {
                let nanos = meta.modified().ok().and_then(|m| m.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_nanos());
                format!("{nanos}:{}", meta.len())
            }
            _ => "none".into(),
        }
    }

    /// `git remote`: the remote names.
    pub async fn remote_names(&self, root: &str) -> GitResult<Vec<String>> {
        Ok(lines(&self.run(root, &["remote"], &self.read_options()).await?.stdout))
    }

    /// The remotes the status reports (does the repository have any: "Publish to GitHub"), remembered like the push target.
    async fn cached_remotes(&self, root: &str) -> Vec<String> {
        let started = self.generation();
        let stamp = self.config_stamp(root).await;
        let hit = self.remote_lists.lock().get(&root.to_string()).cloned();
        if let Some((names, at, s)) = hit
            && s == stamp
            && at.elapsed() < PUSH_TARGET_TTL
        {
            return names;
        }
        let Ok(names) = self.remote_names(root).await else { return Vec::new() };
        if self.generation() == started {
            self.remote_lists.lock().remember(root.to_string(), (names.clone(), Instant::now(), stamp));
        }
        names
    }

    /// `pushTarget(root, branch)`: the upstream, or (without one) the only remote / "origin" with the same branch name and
    /// --set-upstream; with the URL git would really push to (pushurl and insteadOf applied), redacted, and its id.
    pub async fn push_target(&self, root: &str, branch: &str) -> Option<GitPushTarget> {
        if !shared::is_safe_ref_str(branch) {
            return None;
        }
        self.push_target_inner(root, branch).await.ok().flatten()
    }

    async fn push_target_inner(&self, root: &str, branch: &str) -> GitResult<Option<GitPushTarget>> {
        let read = self.read_options();
        let head = format!("refs/heads/{branch}");
        let out = self
            .run(root, &["for-each-ref", "--format=%(upstream:remotename)%1f%(upstream:remoteref)", head.as_str()], &read)
            .await?;
        let trimmed = js_trim(&out.stdout);
        let mut parts = trimmed.split('\x1f');
        let remote = parts.next().unwrap_or("");
        let reference = parts.next().unwrap_or("");
        let upstream = reference.strip_prefix("refs/heads/").filter(|b| shared::is_safe_ref_str(b));
        let (remote, target_branch, set_upstream) = match upstream {
            Some(b) if shared::is_safe_remote_str(remote) => (remote.to_string(), b.to_string(), false),
            _ => {
                let remotes: Vec<String> = lines(&self.run(root, &["remote"], &read).await?.stdout)
                    .into_iter()
                    .filter(|r| shared::is_safe_remote_str(r))
                    .collect();
                let chosen = if remotes.iter().any(|r| r == "origin") {
                    Some("origin".to_string())
                } else if remotes.len() == 1 {
                    Some(remotes[0].clone())
                } else {
                    None
                };
                match chosen {
                    Some(remote) => (remote, branch.to_string(), true),
                    None => return Ok(None),
                }
            }
        };
        let out = self.run(root, &["remote", "get-url", "--push", remote.as_str()], &read).await?;
        let raw = js_trim(&out.stdout);
        if raw.is_empty() {
            return Ok(None);
        }
        Ok(Some(GitPushTarget {
            remote,
            branch: target_branch,
            set_upstream,
            url: redact_secrets(raw),
            url_id: trust::sha256_hex(raw.as_bytes())[..16].to_string(),
        }))
    }

    /// An untracked file may only be shown when git itself lists it as untracked, and when no part of its path is a link or an
    /// alias (a junction, a symlink, an 8.3 short name such as GIT~1) that leads somewhere else than where the path says.
    async fn confine_untracked(&self, root: &str, path: &str) -> GitResult<()> {
        let refuse = || GitFailure::new(GitErrorCode::Invalid, NOT_UNTRACKED);
        let listing =
            self.run(root, &["ls-files", "--others", "--exclude-standard", "-z", "--", path], &self.read_options()).await?;
        if !listing.stdout.split('\0').any(|p| p == path) {
            return Err(refuse());
        }
        let (root, path) = (root.to_string(), path.to_string());
        let confined = tokio::task::spawn_blocking(move || {
            let mut current = paths::realpath_native(&root)?;
            for part in path.split('/') {
                let literal = join(&current, part);
                let real = paths::realpath_native(&literal)?;
                if case_fold(&real) != case_fold(&literal) {
                    return None;
                }
                current = real;
            }
            Some(())
        })
        .await;
        match confined {
            Ok(Some(())) => Ok(()),
            _ => Err(refuse()),
        }
    }

    /// `diff(dir, req)`: working (trust: it runs the clean filters), staged, commit, or an untracked file (trust, confined).
    pub async fn diff(&self, dir: &str, req: &GitDiffRequest) -> GitResult<GitDiffResult> {
        let root = self.root(dir).await?;
        let flags = ["--no-ext-diff", "--no-textconv", "--no-color", "-U3"].map(String::from);
        let mut ok_codes = Vec::new();
        let mut args: Vec<String> = Vec::new();
        match req.source {
            GitDiffSource::Untracked => {
                self.require_trust(&root, false).await?;
                self.confine_untracked(&root, &req.path).await?;
                args.extend(["diff".into(), "--no-index".into()]);
                args.extend(flags);
                args.extend(["--".into(), "/dev/null".into(), req.path.clone()]);
                ok_codes.push(1);
            }
            GitDiffSource::Commit => {
                let hash = req.hash.clone().unwrap_or_default();
                let parent = self.parent_of(&root, &hash).await;
                args.extend(["diff-tree", "-p", "-r", "-M"].map(String::from));
                args.extend(flags);
                match parent {
                    Some(parent) => args.extend([parent, hash]),
                    None => args.extend(["--root".to_string(), hash]),
                }
                args.extend(["--".into(), req.path.clone()]);
                if let Some(old) = req.old_path.as_deref().filter(|p| !p.is_empty()) {
                    args.push(old.to_string());
                }
            }
            GitDiffSource::Working | GitDiffSource::Staged => {
                // Comparing the work tree to the index runs the repository's clean filters; the index to HEAD does not.
                if req.source == GitDiffSource::Working {
                    self.require_trust(&root, false).await?;
                }
                args.push("diff".into());
                if req.source == GitDiffSource::Staged {
                    args.push("--cached".into());
                }
                args.push("-M".into());
                args.extend(flags);
                args.push("--".into());
                if let Some(old) = req.old_path.as_deref().filter(|p| !p.is_empty()) {
                    args.push(old.to_string());
                }
                args.push(req.path.clone());
            }
        }
        let options = RunOptions { max_bytes: Some(DIFF_CAP), ok_codes, allow_truncate: true, ..self.read_options() };
        let out = self.run(&root, &args, &options).await?;
        let text = redact_secrets(&out.stdout);
        let binary = is_binary_diff(&text);
        Ok(GitDiffResult { text, truncated: out.truncated, binary })
    }

    // ---------- changes ----------

    /// `mutate(dir, requestId, scope, work)`: one mutating operation per repository (all its worktrees share the lock) at a
    /// time, one use per request id, never in a repository larger than the project, and only in a trusted one (scanned again).
    pub async fn mutate<T, F, Fut>(&self, dir: &str, request_id: &str, scope: Option<&str>, work: F) -> GitResult<T>
    where
        F: FnOnce(String) -> Fut,
        Fut: Future<Output = GitResult<T>>,
    {
        let root = self.root(dir).await?;
        if let Some(scope) = given(scope)
            && !Self::within_scope(scope, &root)
        {
            return fail(GitErrorCode::Parent, PARENT);
        }
        self.require_trust(&root, true).await?;
        let key = paths::canonical_path(&self.git_dirs(&root).await?.common_dir);
        self.consume(request_id)?;
        if !self.busy.insert(&key) {
            return fail(GitErrorCode::Busy, BUSY);
        }
        // Reads that started before (or during) a write never answer a request made after it.
        self.bump_generation();
        let _guard = WriteGuard { git: self, key, dir: dir.to_string(), root: root.clone() };
        work(root).await
    }

    /// `network(root, args, timeoutMs, withAuth)`: a run that talks to a remote, with the GitHub sign-in of unimux when there
    /// is one (git sends it to https://github.com only). When GitHub refuses it, the same command runs once more without it,
    /// so the user's own credential manager still answers; a refusal of the token as a whole is reported to its owner.
    pub async fn network<S: AsRef<str>>(
        &self,
        cwd: &str,
        args: &[S],
        timeout: Duration,
        with_auth: bool,
    ) -> GitResult<RunOutput> {
        let auth = if with_auth { self.options().remote_auth.clone() } else { None };
        self.network_with(cwd, args, timeout, auth.as_deref()).await
    }

    /// `fetch(dir, requestId, scope)`.
    pub async fn fetch(&self, dir: &str, request_id: &str, scope: Option<&str>) -> GitResult<GitOpResult> {
        let timeout = self.options().network_timeout;
        self.mutate(dir, request_id, scope, |root| async move {
            Ok(op_message(&self.network(&root, &["fetch"], timeout, true).await?, "OK"))
        })
        .await
    }

    /// `pull(dir, requestId, scope)`: fast-forward only; never a merge commit, never a rebase, stops when the branches diverged.
    pub async fn pull(&self, dir: &str, request_id: &str, scope: Option<&str>) -> GitResult<GitOpResult> {
        let timeout = self.options().network_timeout;
        self.mutate(dir, request_id, scope, |root| async move {
            let args = ["pull", "--ff-only", "--no-rebase", "--no-edit"];
            Ok(op_message(&self.network(&root, &args, timeout, true).await?, "OK"))
        })
        .await
    }

    /// `push(dir, req, scope)`: the current branch to the target the status showed; the remote, branch and URL id the user
    /// confirmed must be exactly what this repository would push to now. Never forced, hooks are not skipped.
    pub async fn push(&self, dir: &str, req: &GitPushRequest, scope: Option<&str>) -> GitResult<GitOpResult> {
        let timeout = self.options().network_timeout;
        self.mutate(dir, &req.request_id, scope, |root| async move {
            let args = ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=no"];
            let status = self.run(&root, &args, &self.read_options()).await?;
            let parsed = shared::parse_status_v2(&status.stdout, GIT_MAX_FILES);
            let branch = match parsed.branch {
                Some(b) if !b.is_empty() && !parsed.initial => b,
                _ => return fail(GitErrorCode::Invalid, PUSH_NEEDS_BRANCH),
            };
            let Some(target) = self.push_target(&root, &branch).await else {
                return fail(GitErrorCode::Invalid, NO_PUSH_REMOTE);
            };
            if target.remote != req.remote || target.branch != req.branch || target.url_id != req.url_id {
                return fail(GitErrorCode::Invalid, PUSH_TARGET_CHANGED);
            }
            let mut args: Vec<String> = vec!["push".into()];
            if target.set_upstream {
                args.push("--set-upstream".into());
            }
            args.push(target.remote.clone());
            args.push(format!("refs/heads/{branch}:refs/heads/{}", target.branch));
            Ok(op_message(&self.network(&root, &args, timeout, true).await?, "OK"))
        })
        .await
    }

    /// `stage(dir, req, scope)`: everything, or the chosen paths on stdin (NUL separated).
    pub async fn stage(&self, dir: &str, req: &GitPathsRequest, scope: Option<&str>) -> GitResult<GitOpResult> {
        let timeout = self.options().read_timeout;
        self.mutate(dir, &req.request_id, scope, |root| async move {
            let out = if req.all {
                self.run(&root, &["add", "-A"], &self.write_options(timeout)).await?
            } else {
                let options = RunOptions { input: Some(req.paths.join("\0")), ..self.write_options(timeout) };
                self.run(&root, &["add", "--pathspec-from-file=-", "--pathspec-file-nul"], &options).await?
            };
            Ok(op_message(&out, "OK"))
        })
        .await
    }

    /// `unstage(dir, req, scope)`: `restore --staged`, or without a first commit `rm --cached` (the files only leave the index).
    pub async fn unstage(&self, dir: &str, req: &GitPathsRequest, scope: Option<&str>) -> GitResult<GitOpResult> {
        let timeout = self.options().read_timeout;
        self.mutate(dir, &req.request_id, scope, |root| async move {
            let has_head = self.run(&root, &["rev-parse", "--verify", "--quiet", "HEAD"], &self.read_options()).await.is_ok();
            let mut args: Vec<&str> = if has_head { vec!["restore", "--staged"] } else { vec!["rm", "--cached", "-r", "-q"] };
            let out = if req.all {
                args.extend(["--", "."]);
                self.run(&root, &args, &self.write_options(timeout)).await?
            } else {
                args.extend(["--pathspec-from-file=-", "--pathspec-file-nul"]);
                let options = RunOptions { input: Some(req.paths.join("\0")), ..self.write_options(timeout) };
                self.run(&root, &args, &options).await?
            };
            Ok(op_message(&out, "OK"))
        })
        .await
    }

    /// `commit(dir, req, scope)`: what is staged; the message on stdin; no amend and no way to skip the hooks.
    pub async fn commit(&self, dir: &str, req: &GitCommitRequest, scope: Option<&str>) -> GitResult<GitOpResult> {
        let timeout = self.options().network_timeout;
        self.mutate(dir, &req.request_id, scope, |root| async move {
            let options = RunOptions { ok_codes: vec![1], ..self.read_options() };
            let staged = self.run(&root, &["diff", "--cached", "--quiet", "--no-ext-diff"], &options).await?;
            if staged.code == 0 {
                return fail(GitErrorCode::Invalid, NOTHING_STAGED);
            }
            let options = RunOptions { input: Some(req.message.replace("\r\n", "\n")), ..self.write_options(timeout) };
            Ok(op_message(&self.run(&root, &["commit", "-F", "-"], &options).await?, "OK"))
        })
        .await
    }

    /// `checkout(dir, req, scope)`: switches branch only when nothing tracked is modified; a remote branch gets a local branch
    /// that tracks it.
    pub async fn checkout(&self, dir: &str, req: &GitCheckoutRequest, scope: Option<&str>) -> GitResult<GitOpResult> {
        let timeout = self.options().network_timeout;
        self.mutate(dir, &req.request_id, scope, |root| async move {
            let args = ["status", "--porcelain=v2", "-z", "--untracked-files=no"];
            let status = self.run(&root, &args, &self.read_options()).await?;
            if !shared::parse_status_v2(&status.stdout, GIT_MAX_FILES).files.is_empty() {
                return fail(GitErrorCode::Dirty, DIRTY);
            }
            let full = format!("refs/{}/{}^{{commit}}", if req.remote { "remotes" } else { "heads" }, req.branch);
            if self.run(&root, &["rev-parse", "--verify", "--quiet", full.as_str()], &self.read_options()).await.is_err() {
                return fail(GitErrorCode::Invalid, NO_SUCH_BRANCH);
            }
            let args: Vec<&str> =
                if req.remote { vec!["switch", "--track", req.branch.as_str()] } else { vec!["switch", req.branch.as_str()] };
            Ok(op_message(&self.run(&root, &args, &self.write_options(timeout)).await?, "OK"))
        })
        .await
    }

    // ---------- publishing (src/main/github/publish.ts) ----------

    /// The checked out branch for publishing (None: detached HEAD; an unborn branch has its name); reads HEAD only.
    pub async fn head_branch(&self, root: &str) -> Option<String> {
        let out = self.run(root, &["symbolic-ref", "--quiet", "--short", "HEAD"], &self.read_options()).await.ok()?;
        let branch = js_trim(&out.stdout);
        (!branch.is_empty()).then(|| branch.to_string())
    }

    /// `publishInfo(dir, scope)`: the branch, whether it has a commit, the remotes. Refused like a write in a repository
    /// above the project or in one that is not trusted (the push would run its hooks).
    pub async fn publish_info(&self, dir: &str, scope: Option<&str>) -> GitResult<PublishInfo> {
        let root = self.root(dir).await?;
        if let Some(scope) = given(scope)
            && !Self::within_scope(scope, &root)
        {
            return fail(GitErrorCode::Parent, PARENT);
        }
        self.require_trust(&root, true).await?;
        let initial =
            self.run(&root, &["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], &self.read_options()).await.is_err();
        let branch = self.head_branch(&root).await;
        let remotes = self.remote_names(&root).await?;
        Ok(PublishInfo { branch, initial, remotes })
    }

    /// `publishPush(dir, req, scope)`: inside the repository's write lock, checks again that there is no remote and that
    /// `branch` is still checked out, adds `url` as "origin" and pushes the branch with upstream. `env` carries the
    /// credentials (never the command line). A failed push keeps the remote: `pushed` is false and `message` is git's.
    pub async fn publish_push(
        &self,
        dir: &str,
        request_id: &str,
        url: &str,
        branch: &str,
        env: Vec<(String, String)>,
        scope: Option<&str>,
    ) -> GitResult<PublishPushed> {
        let timeout = self.options().network_timeout;
        let read_timeout = self.options().read_timeout;
        self.mutate(dir, request_id, scope, |root| async move {
            if !shared::is_safe_ref_str(branch) || !is_plain_https(url) {
                return fail(GitErrorCode::Invalid, shared::INVALID_REQUEST);
            }
            if !self.remote_names(&root).await?.is_empty() {
                return fail(GitErrorCode::Invalid, REMOTE_EXISTS);
            }
            if self.head_branch(&root).await.as_deref() != Some(branch) {
                return fail(GitErrorCode::Invalid, PUSH_TARGET_CHANGED);
            }
            self.run(&root, &["remote", "add", "--", "origin", url], &self.write_options(read_timeout)).await?;
            let spec = format!("refs/heads/{branch}:refs/heads/{branch}");
            let options = RunOptions { env, ..self.write_options(timeout) };
            match self.run(&root, &["push", "--set-upstream", "origin", spec.as_str()], &options).await {
                Ok(out) => Ok(PublishPushed { pushed: true, message: op_message(&out, "OK").message }),
                Err(e) => Ok(PublishPushed { pushed: false, message: e.message }),
            }
        })
        .await
    }
}

/// `path.join(current, part)` for one plain path segment.
fn join(current: &str, part: &str) -> String {
    let sep = if cfg!(windows) { '\\' } else { '/' };
    if current.ends_with(['\\', '/']) { format!("{current}{part}") } else { format!("{current}{sep}{part}") }
}

/// `caseFold`: lowercase on Windows.
fn case_fold(value: &str) -> String {
    if cfg!(windows) { value.to_lowercase() } else { value.to_string() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn out(stdout: &str, stderr: &str) -> RunOutput {
        RunOutput { code: 0, stdout: stdout.into(), stderr: stderr.into(), truncated: false }
    }

    #[test]
    fn op_message_keeps_the_last_two_lines_without_hints() {
        assert_eq!(op_message(&out("", ""), "OK").message, "OK");
        assert_eq!(
            op_message(&out("a\nb\n", "hint: x\nWarning: y\nc\n"), "OK").message,
            "b c",
            "hints and warnings (any case) are dropped"
        );
        assert_eq!(op_message(&out("  only  \n", ""), "OK").message, "only");
        assert_eq!(op_message(&out("hint: a\n", "warning: b"), "fallback").message, "fallback");
    }

    #[test]
    fn binary_diffs_are_recognized_per_line() {
        assert!(is_binary_diff("diff --git a/x b/x\nBinary files a/x and b/x differ\n"));
        assert!(is_binary_diff("x\r\nGIT binary patch\r\nliteral 3"));
        assert!(is_binary_diff("Binary files  differ"));
        assert!(!is_binary_diff("+Binary files a and b differ!"));
        assert!(!is_binary_diff(" GIT binary patch"));
        assert!(!is_binary_diff("@@ -1 +1 @@\n-a\n+b\n"));
    }

    #[test]
    fn publish_urls_are_plain_https() {
        assert!(is_plain_https("https://github.com/a/b.git"));
        for bad in ["http://github.com/a", "https://", "https://a b", "https://a\u{a0}b", "https://a\n", "ssh://x", ""] {
            assert!(!is_plain_https(bad), "{bad:?}");
        }
    }

    #[test]
    fn relation_of_the_project_and_the_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = paths::realpath_native(&dir.path().to_string_lossy()).unwrap();
        let sub = format!("{root}{}sub", std::path::MAIN_SEPARATOR);
        std::fs::create_dir(&sub).unwrap();
        assert_eq!(Git::relation(None, &root), Some(GitProjectRelation { kind: RelationKind::InsideRoot, prefix: "".into() }));
        assert_eq!(
            Git::relation(Some(&sub), &root),
            Some(GitProjectRelation { kind: RelationKind::InsideRoot, prefix: "sub".into() })
        );
        assert_eq!(
            Git::relation(Some(&root), &sub),
            Some(GitProjectRelation { kind: RelationKind::ContainsRoot, prefix: "sub".into() })
        );
        let other = tempfile::tempdir().unwrap();
        assert_eq!(Git::relation(Some(&other.path().to_string_lossy()), &root), None);
    }

    #[test]
    fn a_busy_key_is_freed_when_its_guard_goes() {
        let git = Git::default();
        let first = git.try_busy("k").expect("free");
        assert!(git.try_busy("k").is_none());
        drop(first);
        assert!(git.try_busy("k").is_some());
    }
}
