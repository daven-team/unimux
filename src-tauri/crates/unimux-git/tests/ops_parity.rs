//! The rest of test/git-ops.test.ts against REAL git in temporary repositories, through the request pipeline
//! (`handler::handle_git`, like the IPC does): status details, history paging and filters, commit details, diffs, branches,
//! fetch / pull / push, stage / unstage / commit, the failures and the request validation. The configuration is the lab's own
//! (GIT_CONFIG_GLOBAL in the lab, GIT_CONFIG_NOSYSTEM=1, HOME in the lab); the remotes are local bare repositories. The slow-git
//! case uses a Node stand-in like the TS test and is skipped when Node is missing.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use serde_json::{Value, json};
use unimux_git::handler::handle_git;
use unimux_git::paths::{canonical_path, realpath_native, same_path};
use unimux_git::{Git, GitErrorCode, GitOptions, GitProbe};

struct Lab {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    env: HashMap<OsString, OsString>,
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn id() -> String {
    format!("req-{:06}-oprt", COUNTER.fetch_add(1, Ordering::SeqCst))
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn node_available() -> bool {
    Command::new("node").arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

impl Lab {
    fn new() -> Self {
        let tmp = tempfile::Builder::new().prefix("mc-git-parity-").tempdir().unwrap();
        let dir = PathBuf::from(realpath_native(&tmp.path().to_string_lossy()).unwrap());
        let global = dir.join("global.gitconfig");
        std::fs::write(
            &global,
            "[user]\n\tname = Tester\n\temail = tester@example.com\n[init]\n\tdefaultBranch = main\n[protocol \"file\"]\n\tallow = always\n",
        )
        .unwrap();
        let home = dir.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let mut env: HashMap<OsString, OsString> = std::env::vars_os().collect();
        for (k, v) in [
            ("GIT_CONFIG_GLOBAL", global.as_os_str().to_owned()),
            ("GIT_CONFIG_NOSYSTEM", "1".into()),
            ("HOME", home.as_os_str().to_owned()),
            ("USERPROFILE", home.as_os_str().to_owned()),
            ("XDG_CONFIG_HOME", home.as_os_str().to_owned()),
        ] {
            env.retain(|key, _| !key.to_string_lossy().eq_ignore_ascii_case(k));
            env.insert(k.into(), v);
        }
        Lab { _tmp: tmp, dir, env }
    }

    fn git(&self) -> Arc<Git> {
        self.git_with(GitOptions::default())
    }

    fn git_with(&self, options: GitOptions) -> Arc<Git> {
        Arc::new(Git::new(GitOptions { env: Some(self.env.clone()), ..options }))
    }

    fn try_sh(&self, cwd: &Path, args: &[&str]) -> Result<String, String> {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(&self.env)
            .stdin(Stdio::null())
            .output()
            .expect("git");
        if out.status.success() {
            Ok(String::from_utf8_lossy(&out.stdout).into_owned())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).into_owned())
        }
    }

    fn sh(&self, cwd: &Path, args: &[&str]) -> String {
        self.try_sh(cwd, args).unwrap_or_else(|e| panic!("git {args:?}: {e}"))
    }

    fn repo(&self, name: &str, commits: usize) -> PathBuf {
        let dir = self.dir.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        self.sh(&dir, &["init", "-q", "-b", "main", "."]);
        for i in 1..=commits {
            write(&dir, "file.txt", &format!("line {i}\n"));
            self.sh(&dir, &["add", "."]);
            self.sh(&dir, &["commit", "-q", "-m", &format!("commit {i}")]);
        }
        dir
    }

    /// A bare remote plus two clones of it (the first commit pushed from the first one).
    fn remote_pair(&self, name: &str) -> (PathBuf, PathBuf, PathBuf) {
        let bare = self.dir.join(format!("{name}.git"));
        self.sh(&self.dir, &["init", "-q", "--bare", "-b", "main", &s(&bare)]);
        let clone = self.dir.join(format!("{name}-a"));
        self.sh(&self.dir, &["clone", "-q", &s(&bare), &s(&clone)]);
        write(&clone, "a.txt", "one\n");
        self.sh(&clone, &["add", "."]);
        self.sh(&clone, &["commit", "-q", "-m", "first"]);
        self.sh(&clone, &["push", "-q", "origin", "main"]);
        let other = self.dir.join(format!("{name}-b"));
        self.sh(&self.dir, &["clone", "-q", &s(&bare), &s(&other)]);
        (bare, clone, other)
    }

    fn commit_file(&self, dir: &Path, name: &str, text: &str, message: &str) {
        write(dir, name, text);
        self.sh(dir, &["add", "."]);
        self.sh(dir, &["commit", "-q", "-m", message]);
    }
}

fn write(dir: &Path, name: &str, text: &str) {
    std::fs::write(dir.join(name), text).unwrap();
}

async fn call(git: &Arc<Git>, project: &Path, channel: &str, req: Value) -> Result<Value, (GitErrorCode, String)> {
    handle_git(git, Some(&s(project)), channel, &req, cfg!(windows), &[]).await.map_err(|e| (e.code, e.message))
}

async fn ok(git: &Arc<Git>, project: &Path, channel: &str, req: Value) -> Value {
    match call(git, project, channel, req).await {
        Ok(v) => v,
        Err(e) => panic!("git:{channel} failed: {e:?}"),
    }
}

async fn code(git: &Arc<Git>, project: &Path, channel: &str, req: Value) -> GitErrorCode {
    match call(git, project, channel, req).await {
        Ok(v) => panic!("git:{channel} should fail: {v}"),
        Err(e) => e.0,
    }
}

fn subjects(page: &Value) -> Vec<String> {
    page["commits"].as_array().unwrap().iter().map(|c| c["subject"].as_str().unwrap().to_string()).collect()
}

fn is_short_hash(v: &Value) -> bool {
    v.as_str().is_some_and(|h| h.len() == 7 && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// The push request the panel would confirm now (remote, branch and URL id from the status).
async fn push_now(git: &Arc<Git>, dir: &Path, branch: Option<&str>) -> Result<Value, (GitErrorCode, String)> {
    let status = ok(git, dir, "status", json!({})).await;
    let push = &status["push"];
    let req = json!({
        "requestId": id(),
        "remote": push["remote"].as_str().unwrap_or("origin"),
        "branch": branch.or(push["branch"].as_str()).unwrap_or("main"),
        "urlId": push["urlId"].as_str().unwrap_or("0000000000000000"),
    });
    call(git, dir, "push", req).await
}

#[tokio::test]
async fn status_parses_every_kind_of_change_conflicts_detached_heads_and_empty_repositories() {
    let lab = Lab::new();
    let git = lab.git();

    // 'parses modified, staged, untracked, deleted, renamed and unicode paths'
    let dir = lab.repo("mixed", 3);
    write(&dir, "zażółć gęślą.txt", "x\n");
    write(&dir, "old name.txt", &"some content that stays the same for rename detection\n".repeat(5));
    write(&dir, "gone.txt", "bye\n");
    lab.sh(&dir, &["add", "."]);
    lab.sh(&dir, &["commit", "-q", "-m", "more files"]);
    write(&dir, "file.txt", "changed\n");
    lab.sh(&dir, &["mv", "old name.txt", "new name.txt"]);
    std::fs::remove_file(dir.join("gone.txt")).unwrap();
    write(&dir, "zażółć gęślą.txt", "edited\n");
    lab.sh(&dir, &["add", "zażółć gęślą.txt"]);
    write(&dir, "untracked ✓.txt", "u\n");
    std::fs::create_dir(dir.join("folder")).unwrap();
    write(&dir.join("folder"), "inside.txt", "i\n");
    let status = ok(&git, &dir, "status", json!({})).await;
    let by: HashMap<String, Value> =
        status["files"].as_array().unwrap().iter().map(|f| (f["path"].as_str().unwrap().to_string(), f.clone())).collect();
    let mut keys: Vec<&String> = by.keys().collect();
    keys.sort();
    assert_eq!(keys, ["file.txt", "folder/", "gone.txt", "new name.txt", "untracked ✓.txt", "zażółć gęślą.txt"]);
    assert_eq!((by["file.txt"]["x"].as_str(), by["file.txt"]["y"].as_str()), (Some(" "), Some("M")));
    assert_eq!((by["file.txt"]["staged"].as_bool(), by["file.txt"]["unstaged"].as_bool()), (Some(false), Some(true)));
    assert_eq!(by["new name.txt"]["x"], "R");
    assert_eq!(by["new name.txt"]["origPath"], "old name.txt");
    assert_eq!(by["new name.txt"]["staged"], true);
    assert_eq!((by["gone.txt"]["y"].as_str(), by["gone.txt"]["unstaged"].as_bool()), (Some("D"), Some(true)));
    assert_eq!((by["zażółć gęślą.txt"]["x"].as_str(), by["zażółć gęślą.txt"]["staged"].as_bool()), (Some("M"), Some(true)));
    assert_eq!((by["untracked ✓.txt"]["x"].as_str(), by["untracked ✓.txt"]["untracked"].as_bool()), (Some("?"), Some(true)));
    assert_eq!(by["folder/"]["untracked"], true);

    // 'flags merge conflicts'
    let dir = lab.repo("conflict", 1);
    lab.sh(&dir, &["checkout", "-q", "-b", "side"]);
    write(&dir, "file.txt", "side\n");
    lab.sh(&dir, &["commit", "-qam", "side change"]);
    lab.sh(&dir, &["checkout", "-q", "main"]);
    write(&dir, "file.txt", "main\n");
    lab.sh(&dir, &["commit", "-qam", "main change"]);
    assert!(lab.try_sh(&dir, &["merge", "side"]).is_err());
    let status = ok(&git, &dir, "status", json!({})).await;
    let files = status["files"].as_array().unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!((files[0]["path"].as_str(), files[0]["conflict"].as_bool()), (Some("file.txt"), Some(true)));

    // 'handles a detached HEAD and a repository without commits'
    let dir = lab.repo("detached", 2);
    lab.sh(&dir, &["checkout", "-q", "--detach", "HEAD~1"]);
    let detached = ok(&git, &dir, "status", json!({})).await;
    assert_eq!(
        (detached["branch"].clone(), detached["detached"].clone(), detached["push"].clone()),
        (Value::Null, json!(true), Value::Null)
    );
    assert!(is_short_hash(&detached["head"]), "{}", detached["head"]);
    let empty = lab.repo("empty", 0);
    let initial = ok(&git, &empty, "status", json!({})).await;
    assert_eq!(
        (initial["branch"].as_str(), initial["initial"].as_bool(), initial["head"].as_str()),
        (Some("main"), Some(true), Some(""))
    );
    assert_eq!(ok(&git, &empty, "log", json!({"skip": 0, "count": 50})).await, json!({"commits": [], "hasMore": false}));
    let clean = ok(&git, &lab.repo("clean", 3), "status", json!({})).await;
    assert!(is_short_hash(&clean["head"]));
    assert_eq!((clean["detached"].as_bool(), clean["ahead"].as_i64(), clean["behind"].as_i64()), (Some(false), Some(0), Some(0)));
}

#[tokio::test]
async fn status_reports_ahead_behind_works_from_a_subfolder_and_caps_the_list() {
    let lab = Lab::new();
    let git = lab.git();

    // 'reports ahead and behind of the upstream and the push target'
    let (_, clone, other) = lab.remote_pair("ab");
    lab.commit_file(&other, "b.txt", "b\n", "from other");
    lab.sh(&other, &["push", "-q", "origin", "main"]);
    lab.commit_file(&clone, "c.txt", "c\n", "local only");
    lab.sh(&clone, &["fetch", "-q"]);
    let status = ok(&git, &clone, "status", json!({})).await;
    assert_eq!(
        (status["upstream"].as_str(), status["ahead"].as_i64(), status["behind"].as_i64()),
        (Some("origin/main"), Some(1), Some(1))
    );
    assert_eq!(
        (status["push"]["remote"].as_str(), status["push"]["branch"].as_str(), status["push"]["setUpstream"].as_bool()),
        (Some("origin"), Some("main"), Some(false))
    );

    // 'works from a subfolder and from a non-repository'
    let dir = lab.repo("sub", 1);
    let deep = dir.join("a").join("b");
    std::fs::create_dir_all(&deep).unwrap();
    let status = ok(&git, &deep, "status", json!({})).await;
    assert!(same_path(status["root"].as_str().unwrap(), &s(&dir)), "git reports its own spelling of the folder");
    let plain = lab.dir.join("plain");
    std::fs::create_dir(&plain).unwrap();
    assert_eq!(code(&git, &plain, "status", json!({})).await, GitErrorCode::NotRepo);
    assert_eq!(git.probe(&s(&plain)).await, GitProbe::NoRepo);
    assert_eq!(git.probe(&s(&dir)).await, GitProbe::Repo);
    assert_eq!(git.probe(&s(&lab.dir.join("does-not-exist"))).await, GitProbe::NoRepo);

    // 'caps the number of listed changes'
    let many = lab.repo("many", 1);
    for i in 0..40 {
        write(&many, &format!("f{i}.txt"), "x");
    }
    assert_eq!(ok(&git, &many, "status", json!({})).await["files"].as_array().unwrap().len(), 40);
    let tiny = lab.git_with(GitOptions { max_output_bytes: 300, ..Default::default() });
    let cut = ok(&tiny, &many, "status", json!({})).await;
    assert_eq!(cut["truncated"], true);
    assert!(cut["files"].as_array().unwrap().len() < 40);
}

#[tokio::test]
async fn history_pages_filters_shows_details_and_merges_against_the_first_parent() {
    let lab = Lab::new();
    let git = lab.git();

    // 'pages the log with skip and reports whether there is more'
    let dir = lab.repo("paging", 7);
    let first = ok(&git, &dir, "log", json!({"skip": 0, "count": 3})).await;
    assert_eq!(subjects(&first), ["commit 7", "commit 6", "commit 5"]);
    assert_eq!(first["hasMore"], true);
    let last = ok(&git, &dir, "log", json!({"skip": 6, "count": 3})).await;
    assert_eq!(subjects(&last), ["commit 1"]);
    assert_eq!(last["hasMore"], false);
    let top = &first["commits"][0];
    assert_eq!(top["author"], "Tester");
    assert!(top["short"].as_str().unwrap().len() >= 7);
    assert_eq!(top["parents"], json!([first["commits"][1]["hash"]]));
    assert!(top["refs"].as_array().unwrap().iter().any(|r| r["kind"] == "branch" && r["name"] == "main" && r["current"] == true));

    // 'filters by text, author and path, and shows tags'
    let dir = lab.repo("filters", 3);
    write(&dir, "other.txt", "o\n");
    lab.sh(&dir, &["add", "."]);
    lab.sh(&dir, &["commit", "-q", "--author", "Zażółć Gęsia <zg@example.com>", "-m", "Add [other] file (100%)"]);
    lab.sh(&dir, &["tag", "v1.0"]);
    let by_text = ok(&git, &dir, "log", json!({"skip": 0, "count": 50, "search": "[other]"})).await;
    assert_eq!(subjects(&by_text), ["Add [other] file (100%)"]);
    assert!(by_text["commits"][0]["refs"].as_array().unwrap().iter().any(|r| r["kind"] == "tag" && r["name"] == "v1.0"));
    let by_case = ok(&git, &dir, "log", json!({"skip": 0, "count": 50, "search": "COMMIT 2"})).await;
    assert_eq!(by_case["commits"].as_array().unwrap().len(), 1);
    let by_author = ok(&git, &dir, "log", json!({"skip": 0, "count": 50, "author": "zażółć"})).await;
    let authors: Vec<&str> = by_author["commits"].as_array().unwrap().iter().map(|c| c["author"].as_str().unwrap()).collect();
    assert_eq!(authors, ["Zażółć Gęsia"]);
    let by_path = ok(&git, &dir, "log", json!({"skip": 0, "count": 50, "path": "other.txt"})).await;
    assert_eq!(by_path["commits"].as_array().unwrap().len(), 1);
    let regex = ok(&git, &dir, "log", json!({"skip": 0, "count": 50, "search": ".*"})).await;
    assert_eq!(regex["commits"], json!([]), "regular expression characters are plain text");

    // 'includes other branches with all, and shows commit details with the files of a rename'
    let dir = lab.repo("details", 1);
    write(&dir, "big.txt", &"content for similarity\n".repeat(20));
    lab.sh(&dir, &["add", "."]);
    lab.sh(&dir, &["commit", "-q", "-m", "add big"]);
    lab.sh(&dir, &["mv", "big.txt", "renamed.txt"]);
    write(&dir, "second.txt", "a\nb\n");
    lab.sh(&dir, &["add", "."]);
    lab.sh(&dir, &["commit", "-q", "-m", "rename and add\n\nBody line one.\nBody line two."]);
    let head = ok(&git, &dir, "log", json!({"skip": 0, "count": 1})).await;
    let details = ok(&git, &dir, "show", json!({"hash": head["commits"][0]["hash"]})).await;
    assert_eq!(details["message"], "rename and add\n\nBody line one.\nBody line two.");
    assert_eq!(details["email"], "tester@example.com");
    assert_eq!(
        details["files"],
        json!([
            {"status": "R", "origPath": "big.txt", "path": "renamed.txt", "added": 0, "deleted": 0},
            {"status": "A", "path": "second.txt", "added": 2, "deleted": 0},
        ])
    );
    assert_eq!((details["added"].as_i64(), details["filesTruncated"].as_bool()), (Some(2), Some(false)));
    let root = ok(&git, &dir, "log", json!({"skip": 2, "count": 1})).await;
    let root_details = ok(&git, &dir, "show", json!({"hash": root["commits"][0]["hash"]})).await;
    assert_eq!(root_details["files"].as_array().unwrap().iter().map(|f| f["path"].clone()).collect::<Vec<_>>(), ["file.txt"]);

    // 'shows a merge commit against its first parent only'
    let dir = lab.repo("merge", 1);
    lab.sh(&dir, &["checkout", "-q", "-b", "feature"]);
    lab.commit_file(&dir, "feature.txt", "f\n", "feature work");
    lab.sh(&dir, &["checkout", "-q", "main"]);
    lab.commit_file(&dir, "main.txt", "m\n", "main work");
    lab.sh(&dir, &["merge", "-q", "--no-ff", "feature", "-m", "merge feature"]);
    lab.sh(&dir, &["branch", "side-only", "HEAD~1"]);
    let log = ok(&git, &dir, "log", json!({"skip": 0, "count": 10})).await;
    assert_eq!(log["commits"][0]["parents"].as_array().unwrap().len(), 2);
    let merge = ok(&git, &dir, "show", json!({"hash": log["commits"][0]["hash"]})).await;
    assert_eq!(merge["files"].as_array().unwrap().iter().map(|f| f["path"].clone()).collect::<Vec<_>>(), ["feature.txt"]);
    let all = ok(&git, &dir, "log", json!({"skip": 0, "count": 10, "all": true})).await;
    assert_eq!(all["commits"].as_array().unwrap().len(), log["commits"].as_array().unwrap().len());
    // a branch that is not merged shows up with all only
    lab.sh(&dir, &["checkout", "-q", "-b", "unmerged"]);
    lab.commit_file(&dir, "u.txt", "u\n", "unmerged work");
    lab.sh(&dir, &["checkout", "-q", "main"]);
    let main_only = ok(&git, &dir, "log", json!({"skip": 0, "count": 10})).await;
    let everything = ok(&git, &dir, "log", json!({"skip": 0, "count": 10, "all": true})).await;
    assert!(!subjects(&main_only).contains(&"unmerged work".to_string()));
    assert!(subjects(&everything).contains(&"unmerged work".to_string()));
}

#[tokio::test]
async fn diffs_mark_binary_files_and_cap_huge_ones() {
    let lab = Lab::new();
    let git = lab.git();
    let dir = lab.repo("bigdiff", 1);
    std::fs::write(dir.join("blob.bin"), [0u8, 1, 2, 3, 0, 255, 0, 7]).unwrap();
    let bin = ok(&git, &dir, "diff", json!({"source": "untracked", "path": "blob.bin"})).await;
    assert_eq!(bin["binary"], true);
    write(&dir, "huge.txt", &"a long line of text that repeats\n".repeat(60_000));
    let huge = ok(&git, &dir, "diff", json!({"source": "untracked", "path": "huge.txt"})).await;
    assert_eq!(huge["truncated"], true);
    let len = huge["text"].as_str().unwrap().encode_utf16().count();
    assert!(len <= 1024 * 1024 && len > 1000, "{len}");
}

#[tokio::test]
async fn branches_list_local_and_remote_and_checkout_tracks_a_remote_branch() {
    let lab = Lab::new();
    let git = lab.git();
    let (_, clone, other) = lab.remote_pair("br");
    lab.sh(&other, &["checkout", "-q", "-b", "remote-only"]);
    lab.commit_file(&other, "r.txt", "r\n", "remote branch");
    lab.sh(&other, &["push", "-q", "origin", "remote-only"]);
    lab.sh(&clone, &["branch", "local-two"]);
    lab.sh(&clone, &["fetch", "-q"]);
    let branches = ok(&git, &clone, "branches", json!({})).await;
    let mut names: Vec<String> = branches
        .as_array()
        .unwrap()
        .iter()
        .map(|b| {
            format!(
                "{}{}{}",
                if b["remote"] == true { "r:" } else { "" },
                b["name"].as_str().unwrap(),
                if b["current"] == true { "*" } else { "" }
            )
        })
        .collect();
    names.sort();
    assert_eq!(names, ["local-two", "main*", "r:origin/remote-only"]);

    write(&clone, "a.txt", "dirty\n");
    assert_eq!(code(&git, &clone, "checkout", json!({"requestId": id(), "branch": "local-two"})).await, GitErrorCode::Dirty);
    assert_eq!(lab.sh(&clone, &["branch", "--show-current"]).trim(), "main");
    lab.sh(&clone, &["checkout", "--", "a.txt"]);
    assert_eq!(code(&git, &clone, "checkout", json!({"requestId": id(), "branch": "nope"})).await, GitErrorCode::Invalid);
    ok(&git, &clone, "checkout", json!({"requestId": id(), "branch": "local-two"})).await;
    assert_eq!(lab.sh(&clone, &["branch", "--show-current"]).trim(), "local-two");
    ok(&git, &clone, "checkout", json!({"requestId": id(), "branch": "origin/remote-only", "remote": true})).await;
    assert_eq!(lab.sh(&clone, &["branch", "--show-current"]).trim(), "remote-only");
    assert_eq!(lab.sh(&clone, &["rev-parse", "--abbrev-ref", "@{upstream}"]).trim(), "origin/remote-only");
}

#[tokio::test]
async fn pull_refuses_diverged_branches_and_push_never_forces_or_runs_without_a_remote() {
    let lab = Lab::new();
    let git = lab.git();

    // 'refuses to pull when the branches diverged and leaves the history alone'
    let (_, clone, other) = lab.remote_pair("diverged");
    lab.commit_file(&other, "o.txt", "o\n", "theirs");
    lab.sh(&other, &["push", "-q", "origin", "main"]);
    lab.commit_file(&clone, "c.txt", "c\n", "ours");
    let before = lab.sh(&clone, &["rev-parse", "HEAD"]);
    let (failed, message) = call(&git, &clone, "pull", json!({"requestId": id()})).await.unwrap_err();
    assert_eq!(failed, GitErrorCode::Failed);
    let lower = message.to_lowercase();
    assert!(lower.contains("fast-forward") || lower.contains("diverg"), "{message}");
    assert_eq!(lab.sh(&clone, &["rev-parse", "HEAD"]), before);
    assert_eq!(lab.sh(&clone, &["status", "--porcelain"]).trim(), "");

    // 'pushes to the confirmed target only and never forces'
    let (bare, clone, other) = lab.remote_pair("push");
    lab.commit_file(&clone, "p.txt", "p\n", "to push");
    assert_eq!(push_now(&git, &clone, Some("elsewhere")).await.unwrap_err().0, GitErrorCode::Invalid);
    assert_eq!(lab.sh(&bare, &["log", "-1", "--format=%s", "main"]).trim(), "first");
    push_now(&git, &clone, None).await.unwrap();
    assert_eq!(lab.sh(&bare, &["log", "-1", "--format=%s", "main"]).trim(), "to push");
    lab.commit_file(&other, "x.txt", "x\n", "other work");
    assert!(push_now(&git, &other, None).await.is_err(), "a rejected (non fast-forward) push stays rejected");
    assert_eq!(lab.sh(&bare, &["log", "-1", "--format=%s", "main"]).trim(), "to push");

    // 'has no push target without a remote'
    let dir = lab.repo("noremote", 1);
    assert_eq!(ok(&git, &dir, "status", json!({})).await["push"], Value::Null);
    assert_eq!(push_now(&git, &dir, None).await.unwrap_err().0, GitErrorCode::Invalid);
}

#[tokio::test]
async fn stage_unstage_and_commit_chosen_paths_everything_and_with_hooks() {
    let lab = Lab::new();
    let git = lab.git();
    let cached = |dir: &Path| {
        let mut names: Vec<String> = lab
            .sh(dir, &["diff", "--cached", "--name-only", "-z"])
            .split('\0')
            .filter(|n| !n.is_empty())
            .map(str::to_string)
            .collect();
        names.sort();
        names
    };

    // 'stages and unstages chosen paths (spaces, unicode, folders) and commits'
    let dir = lab.repo("commit", 1);
    write(&dir, "with space.txt", "s\n");
    write(&dir, "zażółć.txt", "z\n");
    write(&dir, "[a].txt", "m\n");
    write(&dir, "a.txt", "must stay untracked\n");
    std::fs::create_dir(dir.join("fold")).unwrap();
    write(&dir.join("fold"), "in.txt", "i\n");
    ok(&git, &dir, "stage", json!({"requestId": id(), "paths": ["with space.txt", "zażółć.txt", "[a].txt", "fold/"]})).await;
    assert_eq!(cached(&dir), ["[a].txt", "fold/in.txt", "with space.txt", "zażółć.txt"]);
    ok(&git, &dir, "unstage", json!({"requestId": id(), "paths": ["with space.txt", "fold/"]})).await;
    assert_eq!(cached(&dir), ["[a].txt", "zażółć.txt"]);
    let message = "Dodaj pliki ✓\n\nDrugi akapit z \"cudzysłowem\" i --option";
    let committed = ok(&git, &dir, "commit", json!({"requestId": id(), "message": message})).await;
    assert!(!committed["message"].as_str().unwrap().is_empty());
    assert_eq!(lab.sh(&dir, &["log", "-1", "--format=%B"]).trim(), message);
    let mut left: Vec<String> = lab
        .sh(&dir, &["status", "--porcelain=v1", "-z", "--untracked-files=all"])
        .split('\0')
        .filter(|n| !n.is_empty())
        .map(str::to_string)
        .collect();
    left.sort();
    assert_eq!(left, ["?? a.txt", "?? fold/in.txt", "?? with space.txt"]);

    // 'stages and unstages everything'
    let dir = lab.repo("all", 1);
    write(&dir, "a.txt", "a");
    write(&dir, "file.txt", "changed");
    ok(&git, &dir, "stage", json!({"requestId": id(), "paths": [], "all": true})).await;
    assert_eq!(cached(&dir), ["a.txt", "file.txt"]);
    ok(&git, &dir, "unstage", json!({"requestId": id(), "paths": [], "all": true})).await;
    assert!(cached(&dir).is_empty());

    // 'refuses an empty commit and runs the hooks (they cannot be skipped)'
    let dir = lab.repo("hooks", 1);
    assert_eq!(code(&git, &dir, "commit", json!({"requestId": id(), "message": "nothing"})).await, GitErrorCode::Invalid);
    let hooks = dir.join(".git").join("hooks");
    std::fs::create_dir_all(&hooks).unwrap();
    let hook = hooks.join("pre-commit");
    std::fs::write(&hook, "#!/bin/sh\necho \"hook says no\" >&2\nexit 1\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&hook, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    write(&dir, "x.txt", "x");
    lab.sh(&dir, &["add", "."]);
    assert_eq!(code(&git, &dir, "commit", json!({"requestId": id(), "message": "refused"})).await, GitErrorCode::Untrusted);
    ok(&git, &dir, "trustGrant", json!({"requestId": id()})).await;
    let (_, blocked) = call(&git, &dir, "commit", json!({"requestId": id(), "message": "should be blocked"})).await.unwrap_err();
    assert!(blocked.contains("hook says no"), "{blocked}");
    assert_eq!(lab.sh(&dir, &["log", "--format=%s"]).trim(), "commit 1");
}

#[tokio::test]
async fn a_request_id_runs_once_and_writers_of_one_repository_take_turns() {
    let lab = Lab::new();
    let git = lab.git();
    let dir = lab.repo("replay", 1);
    write(&dir, "r.txt", "r");
    let rid = id();
    ok(&git, &dir, "stage", json!({"requestId": rid, "paths": ["r.txt"]})).await;
    assert_eq!(code(&git, &dir, "stage", json!({"requestId": rid, "paths": ["r.txt"]})).await, GitErrorCode::Invalid);
    // the lock key a writer takes (the canonical common git directory) is held while a second writer runs
    let key = canonical_path(&s(&dir.join(".git")));
    {
        let _held = git.busy().take(&key).expect("free");
        assert_eq!(code(&git, &dir, "stage", json!({"requestId": id(), "paths": ["r.txt"]})).await, GitErrorCode::Busy);
    }
    ok(&git, &dir, "stage", json!({"requestId": id(), "paths": ["r.txt"]})).await;
    assert!(!git.busy().holds(&key), "a finished writer leaves the repository free");
}

/// A git stand-in that answers the questions about places at once and hangs on everything else (git behind a dead network).
const SLOW_GIT: &str = r#"const a = process.argv; const path = require('path');
if (a.includes('--show-toplevel')) console.log(process.cwd());
else if (a.includes('--absolute-git-dir')) { console.log(path.join(process.cwd(), '.git')); console.log('.git'); }
else if (a.includes('config') || a.includes('worktree') || a.includes('rev-parse')) { /* nothing to say */ }
else setTimeout(() => process.stdout.write('late'), 20000);
"#;

#[tokio::test]
async fn failures_name_a_missing_git_stop_a_slow_one_and_never_leak_credentials() {
    let lab = Lab::new();
    let dir = lab.repo("nogit", 1);

    // 'reports a missing git with an install hint'
    let missing = lab.git_with(GitOptions { bin: "git-that-does-not-exist-xyz".into(), ..Default::default() });
    let (no_git, hint) = call(&missing, &dir, "status", json!({})).await.unwrap_err();
    assert_eq!(no_git, GitErrorCode::NoGit);
    assert!(hint.contains("Zainstaluj Git"), "{hint}");
    assert_eq!(missing.probe(&s(&dir)).await, GitProbe::NoGit);

    // 'never prints credentials of a remote URL' and 'does not wait for a credential prompt'
    let git = lab.git();
    let secrets = lab.repo("secrets", 1);
    lab.sh(&secrets, &["remote", "add", "origin", "https://user:s3cr3t-token@127.0.0.1:1/nope.git"]);
    let failed = handle_git(&git, Some(&s(&secrets)), "fetch", &json!({"requestId": id()}), cfg!(windows), &[]).await;
    let wire = unimux_git::result_json(&failed);
    assert_eq!(wire["ok"], false);
    assert!(!wire.to_string().contains("s3cr3t-token"), "{wire}");
    let prompt = lab.repo("prompt", 1);
    lab.sh(&prompt, &["remote", "add", "origin", "https://127.0.0.1:1/never.git"]);
    let started = Instant::now();
    assert!(call(&git, &prompt, "fetch", json!({"requestId": id()})).await.is_err());
    assert!(started.elapsed() < Duration::from_secs(15), "{:?}", started.elapsed());

    // 'stops a slow git at the timeout' (status and fetch through the engine)
    if !node_available() {
        eprintln!("node is not installed: the slow-git part is skipped");
        return;
    }
    let script = lab.dir.join("slow-git.js");
    std::fs::write(&script, SLOW_GIT).unwrap();
    let stand_in = |read_ms: u64, network_ms: u64| {
        lab.git_with(GitOptions {
            bin: "node".into(),
            prefix_args: vec![script.clone().into_os_string()],
            read_timeout: Duration::from_millis(read_ms),
            network_timeout: Duration::from_millis(network_ms),
            ..Default::default()
        })
    };
    let slow = lab.repo("slow", 1);
    let started = Instant::now();
    assert_eq!(code(&stand_in(400, 60_000), &slow, "status", json!({})).await, GitErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    assert_eq!(code(&stand_in(5000, 300), &slow, "fetch", json!({"requestId": id()})).await, GitErrorCode::Timeout);
}

#[tokio::test]
async fn worktrees_are_listed_and_only_the_ones_git_lists_are_accepted() {
    let lab = Lab::new();
    let git = lab.git();
    let dir = lab.repo("wt", 1);
    let wt = lab.dir.join("wt-wt-linked");
    lab.sh(&dir, &["worktree", "add", "-q", "-b", "mc/linked", &s(&wt)]);
    let elsewhere = lab.dir.join("elsewhere-checkout");
    lab.sh(&dir, &["worktree", "add", "-q", "-b", "mc/elsewhere", &s(&elsewhere)]);
    let d = s(&dir);
    let list = git.worktrees(&d, Some(&d), &[], None).await.unwrap();
    assert_eq!(list.len(), 3);
    let mut seen: Vec<String> = list.iter().map(|w| format!("{}:{}", w.branch.as_deref().unwrap_or(""), w.allowed)).collect();
    seen.sort();
    assert_eq!(seen, ["main:true", "mc/elsewhere:false", "mc/linked:true"]);
    assert!(list[0].main);
    assert_eq!(git.resolve_dir(&d, Some(&s(&elsewhere)), &[]).await.unwrap_err().code, GitErrorCode::Invalid);
    assert!(git.resolve_dir(&d, Some(&s(&elsewhere)), &[s(&elsewhere)]).await.is_ok());
    assert!(git.resolve_dir(&d, Some(&s(&wt)), &[]).await.is_ok());
    assert_eq!(git.resolve_dir(&d, Some(&s(&lab.dir)), &[]).await.unwrap_err().code, GitErrorCode::Invalid);
    let dotted = format!("{}{}..", s(&wt), std::path::MAIN_SEPARATOR);
    assert_eq!(git.resolve_dir(&d, Some(&dotted), &[]).await.unwrap_err().code, GitErrorCode::Invalid);
    let status = ok(&git, &dir, "status", json!({"worktree": s(&wt)})).await;
    assert_eq!(status["branch"], "mc/linked");
}

#[tokio::test]
async fn every_request_is_validated_before_anything_runs() {
    let lab = Lab::new();
    let git = lab.git();
    let dir = lab.repo("ipc", 2);
    let gone = handle_git(&git, None, "status", &json!({}), cfg!(windows), &[]).await.unwrap_err();
    assert_eq!(gone.code, GitErrorCode::Gone);
    let invalid: Vec<(&str, Value)> = vec![
        ("config", json!({})),
        ("status", Value::Null),
        ("show", json!({"hash": "--upload-pack=calc"})),
        ("show", json!({"hash": "HEAD"})),
        ("checkout", json!({"requestId": id(), "branch": "--orphan"})),
        ("checkout", json!({"requestId": id(), "branch": "a b"})),
        ("checkout", json!({"branch": "main"})),
        ("push", json!({"requestId": id(), "remote": "--receive-pack=x", "branch": "main"})),
        ("stage", json!({"requestId": id(), "paths": ["../outside"]})),
        ("diff", json!({"source": "working", "path": "/etc/passwd"})),
        ("log", json!({"skip": -1, "count": 10})),
        ("log", json!({"skip": 0, "count": 100000})),
        ("status", json!({"worktree": "C:\\Windows"})),
    ];
    for (channel, req) in invalid {
        assert_eq!(code(&git, &dir, channel, req.clone()).await, GitErrorCode::Invalid, "{channel} {req}");
    }
    let page = ok(&git, &dir, "log", json!({"skip": 0, "count": 5})).await;
    assert_eq!(page["commits"].as_array().unwrap().len(), 2, "a valid log request still works after all of that");
}
