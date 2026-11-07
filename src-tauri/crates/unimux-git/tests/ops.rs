//! G3: the reads and mutations of the Git panel against REAL git in temporary repositories, through the request pipeline
//! (`handler::handle_git`, like the IPC does): a subset of test/git-ops.test.ts, test/github-git.test.ts and the write halves of
//! test/git-trust.test.ts. The configuration is the lab's own (GIT_CONFIG_GLOBAL in the lab, GIT_CONFIG_NOSYSTEM=1, HOME in
//! the lab); the remotes are local bare repositories, github.com is never contacted (a global `insteadOf` turns the https
//! address into a local bare repository).

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};
use unimux_git::handler::handle_git;
use unimux_git::paths::realpath_native;
use unimux_git::{Git, GitErrorCode, GitOptions, RemoteAuth};

const GITHUB_URL: &str = "https://github.com/ajzak/demo.git";

struct Lab {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    env: HashMap<OsString, OsString>,
}

static COUNTER: AtomicUsize = AtomicUsize::new(0);

fn id() -> String {
    format!("req-{:06}-ops", COUNTER.fetch_add(1, Ordering::SeqCst))
}

impl Lab {
    fn new() -> Self {
        let tmp = tempfile::Builder::new().prefix("mc-git-ops-").tempdir().unwrap();
        let dir = PathBuf::from(realpath_native(&tmp.path().to_string_lossy()).unwrap());
        let bare = dir.join("demo.git").to_string_lossy().replace('\\', "/");
        let global = dir.join("global.gitconfig");
        std::fs::write(
            &global,
            format!(
                "[user]\n\tname = Tester\n\temail = tester@example.com\n[init]\n\tdefaultBranch = main\n[protocol \"file\"]\n\tallow = always\n[url \"{bare}\"]\n\tinsteadOf = {GITHUB_URL}\n"
            ),
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
        let lab = Lab { _tmp: tmp, dir, env };
        lab.sh(&lab.dir, &["init", "-q", "--bare", "-b", "main", &bare]);
        lab
    }

    fn git(&self) -> Arc<Git> {
        Arc::new(Git::new(GitOptions { env: Some(self.env.clone()), ..Default::default() }))
    }

    fn git_with_auth(&self, auth: Arc<dyn RemoteAuth>) -> Arc<Git> {
        Arc::new(Git::new(GitOptions { env: Some(self.env.clone()), remote_auth: Some(auth), ..Default::default() }))
    }

    fn sh(&self, cwd: &Path, args: &[&str]) -> String {
        let out = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .env_clear()
            .envs(&self.env)
            .stdin(Stdio::null())
            .output()
            .expect("git");
        assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).into_owned()
    }

    fn repo(&self, name: &str, commits: usize) -> PathBuf {
        let dir = self.dir.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        self.sh(&dir, &["init", "-q", "-b", "main", "."]);
        for i in 1..=commits {
            std::fs::write(dir.join("file.txt"), format!("line {i}\n")).unwrap();
            self.sh(&dir, &["add", "."]);
            self.sh(&dir, &["commit", "-q", "-m", &format!("commit {i}")]);
        }
        dir
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
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

#[tokio::test]
async fn status_stage_unstage_commit_log_show_and_diff() {
    let lab = Lab::new();
    let work = lab.repo("work", 1);
    let git = lab.git();

    let status = ok(&git, &work, "status", json!({})).await;
    assert_eq!(status["branch"], "main");
    assert_eq!(status["files"], json!([]));
    assert_eq!(status["upstream"], Value::Null);
    assert_eq!(status["push"], Value::Null);
    assert_eq!(status["hasRemote"], false);
    assert_eq!(status["parent"], false);
    assert_eq!(status["projectRelation"], json!({"kind": "inside-root", "prefix": ""}));
    let keys: Vec<&String> = status.as_object().unwrap().keys().collect();
    assert_eq!(keys.first().map(|k| k.as_str()), Some("branch"), "1.1.4's key order");

    std::fs::write(work.join("file.txt"), "changed\n").unwrap();
    std::fs::write(work.join("nowy plik ż.txt"), "new\n").unwrap();
    let status = ok(&git, &work, "status", json!({})).await;
    let files = status["files"].as_array().unwrap();
    assert_eq!(files.len(), 2, "{files:?}");
    assert!(files.iter().any(|f| f["path"] == "nowy plik ż.txt" && f["untracked"] == true));
    assert!(files.iter().any(|f| f["path"] == "file.txt" && f["unstaged"] == true && f["staged"] == false));

    // diffs: working, untracked, then staged
    let working = ok(&git, &work, "diff", json!({"source": "working", "path": "file.txt"})).await;
    assert!(working["text"].as_str().unwrap().contains("+changed"));
    assert_eq!(working["binary"], false);
    let untracked = ok(&git, &work, "diff", json!({"source": "untracked", "path": "nowy plik ż.txt"})).await;
    assert!(untracked["text"].as_str().unwrap().contains("+new"));
    let tracked_as_untracked = call(&git, &work, "diff", json!({"source": "untracked", "path": "file.txt"})).await;
    assert_eq!(tracked_as_untracked.unwrap_err().0, GitErrorCode::Invalid);

    let stage_id = id();
    ok(&git, &work, "stage", json!({"requestId": stage_id, "paths": ["file.txt"]})).await;
    let again = call(&git, &work, "stage", json!({"requestId": stage_id, "paths": ["file.txt"]})).await;
    assert_eq!(again.unwrap_err(), (GitErrorCode::Invalid, unimux_git::ALREADY_DONE.to_string()), "a request id works once");
    let staged = ok(&git, &work, "diff", json!({"source": "staged", "path": "file.txt"})).await;
    assert!(staged["text"].as_str().unwrap().contains("+changed"));

    ok(&git, &work, "unstage", json!({"requestId": id(), "paths": ["file.txt"]})).await;
    let status = ok(&git, &work, "status", json!({})).await;
    assert!(status["files"].as_array().unwrap().iter().all(|f| f["staged"] == false));

    // nothing staged: no empty commit
    let empty = call(&git, &work, "commit", json!({"requestId": id(), "message": "x"})).await;
    assert_eq!(empty.unwrap_err().0, GitErrorCode::Invalid);

    ok(&git, &work, "stage", json!({"requestId": id(), "paths": [], "all": true})).await;
    let committed = ok(&git, &work, "commit", json!({"requestId": id(), "message": "second\r\n\r\nbody"})).await;
    assert!(committed["message"].as_str().is_some_and(|m| !m.is_empty()));
    assert_eq!(ok(&git, &work, "status", json!({})).await["files"], json!([]));

    let page = ok(&git, &work, "log", json!({"count": 1})).await;
    assert_eq!(page["commits"].as_array().unwrap().len(), 1);
    assert_eq!(page["hasMore"], true);
    assert_eq!(page["commits"][0]["subject"], "second");
    let hash = page["commits"][0]["hash"].as_str().unwrap().to_string();
    let details = ok(&git, &work, "show", json!({"hash": hash})).await;
    assert_eq!(details["message"], "second\n\nbody");
    assert_eq!(details["files"].as_array().unwrap().len(), 2);
    assert_eq!(details["added"], 2);
    let commit_diff = ok(&git, &work, "diff", json!({"source": "commit", "hash": hash, "path": "file.txt"})).await;
    assert!(commit_diff["text"].as_str().unwrap().contains("+changed"));
    let unknown = call(&git, &work, "show", json!({"hash": "abcdef1234"})).await;
    assert_eq!(unknown.unwrap_err().0, GitErrorCode::Invalid);

    let filtered = ok(&git, &work, "log", json!({"search": "--all"})).await;
    assert_eq!(filtered["commits"], json!([]), "search text that looks like an option is text");
}

#[tokio::test]
async fn an_empty_repository_has_an_empty_history_and_unstages_without_head() {
    let lab = Lab::new();
    let empty = lab.repo("empty", 0);
    let git = lab.git();
    let page = ok(&git, &empty, "log", json!({})).await;
    assert_eq!(page, json!({"commits": [], "hasMore": false}));
    std::fs::write(empty.join("a.txt"), "a\n").unwrap();
    ok(&git, &empty, "stage", json!({"requestId": id(), "paths": ["a.txt"]})).await;
    ok(&git, &empty, "unstage", json!({"requestId": id(), "paths": ["a.txt"]})).await;
    let status = ok(&git, &empty, "status", json!({})).await;
    assert_eq!(status["initial"], true);
    assert_eq!(status["files"][0]["untracked"], true);
}

#[tokio::test]
async fn branches_and_checkout_only_with_a_clean_tree() {
    let lab = Lab::new();
    let work = lab.repo("branches", 1);
    lab.sh(&work, &["branch", "feature"]);
    let git = lab.git();
    let branches = ok(&git, &work, "branches", json!({})).await;
    let names: Vec<&str> = branches.as_array().unwrap().iter().map(|b| b["name"].as_str().unwrap()).collect();
    assert!(names.contains(&"main") && names.contains(&"feature"), "{names:?}");

    std::fs::write(work.join("file.txt"), "dirty\n").unwrap();
    let dirty = call(&git, &work, "checkout", json!({"requestId": id(), "branch": "feature"})).await;
    assert_eq!(dirty.unwrap_err().0, GitErrorCode::Dirty);
    lab.sh(&work, &["checkout", "--", "file.txt"]);

    // untracked files may stay while switching
    std::fs::write(work.join("loose.txt"), "x\n").unwrap();
    ok(&git, &work, "checkout", json!({"requestId": id(), "branch": "feature"})).await;
    assert_eq!(lab.sh(&work, &["branch", "--show-current"]).trim(), "feature");
    let missing = call(&git, &work, "checkout", json!({"requestId": id(), "branch": "nope"})).await;
    assert_eq!(missing.unwrap_err().0, GitErrorCode::Invalid);
}

#[tokio::test]
async fn writes_are_refused_above_the_project_and_in_an_untrusted_repository() {
    let lab = Lab::new();
    let outer = lab.repo("outer", 1);
    let inner = outer.join("sub");
    std::fs::create_dir(&inner).unwrap();
    let git = lab.git();
    let status = ok(&git, &inner, "status", json!({})).await;
    assert_eq!(status["parent"], true);
    assert_eq!(status["projectRelation"], json!({"kind": "inside-root", "prefix": "sub"}));
    let refused = call(&git, &inner, "stage", json!({"requestId": id(), "paths": [], "all": true})).await;
    assert_eq!(refused.unwrap_err().0, GitErrorCode::Parent);
    let publish = git.publish_info(&s(&inner), Some(&s(&inner))).await;
    assert_eq!(publish.unwrap_err().code, GitErrorCode::Parent);

    let hostile = lab.repo("hostile", 1);
    lab.sh(&hostile, &["config", "core.sshCommand", "calc"]);
    let status = call(&git, &hostile, "status", json!({})).await;
    assert_eq!(status.unwrap_err().0, GitErrorCode::Untrusted);
    let fetch = call(&git, &hostile, "fetch", json!({"requestId": id()})).await;
    assert_eq!(fetch.unwrap_err().0, GitErrorCode::Untrusted);
    // log and branches start nothing: they work without trust
    ok(&git, &hostile, "log", json!({})).await;
    ok(&git, &hostile, "branches", json!({})).await;
    // after the explicit grant the status works
    ok(&git, &hostile, "trustGrant", json!({"requestId": id()})).await;
    ok(&git, &hostile, "status", json!({})).await;
}

#[tokio::test]
async fn fetch_pull_and_push_to_the_confirmed_target_only() {
    let lab = Lab::new();
    let work = lab.repo("pusher", 2);
    let git = lab.git();
    lab.sh(&work, &["remote", "add", "origin", GITHUB_URL]);

    // no upstream yet: origin with the same name and --set-upstream
    let status = ok(&git, &work, "status", json!({})).await;
    assert_eq!(status["hasRemote"], true);
    let push = status["push"].clone();
    assert_eq!(push["remote"], "origin");
    assert_eq!(push["branch"], "main");
    assert_eq!(push["setUpstream"], true);
    assert_eq!(push["url"], lab.dir.join("demo.git").to_string_lossy().replace('\\', "/"), "insteadOf applied");
    let url_id = push["urlId"].as_str().unwrap().to_string();
    assert_eq!(url_id.len(), 16);

    let wrong =
        call(&git, &work, "push", json!({"requestId": id(), "remote": "origin", "branch": "main", "urlId": "0000000000000000"}))
            .await;
    assert_eq!(wrong.unwrap_err().0, GitErrorCode::Invalid, "a target that is not the confirmed one");
    ok(&git, &work, "push", json!({"requestId": id(), "remote": "origin", "branch": "main", "urlId": url_id})).await;
    let status = ok(&git, &work, "status", json!({})).await;
    assert_eq!(status["upstream"], "origin/main");
    assert_eq!(status["push"]["setUpstream"], false);

    // a second clone fetches and fast-forwards
    let clone = lab.dir.join("clone");
    lab.sh(&lab.dir, &["clone", "-q", GITHUB_URL, &s(&clone)]);
    std::fs::write(work.join("file.txt"), "line 3\n").unwrap();
    lab.sh(&work, &["commit", "-q", "-am", "commit 3"]);
    let url_id = ok(&git, &work, "status", json!({})).await["push"]["urlId"].as_str().unwrap().to_string();
    ok(&git, &work, "push", json!({"requestId": id(), "remote": "origin", "branch": "main", "urlId": url_id})).await;
    ok(&git, &clone, "fetch", json!({"requestId": id()})).await;
    assert_eq!(ok(&git, &clone, "status", json!({})).await["behind"], 1);
    ok(&git, &clone, "pull", json!({"requestId": id()})).await;
    assert_eq!(lab.sh(&clone, &["log", "-1", "--format=%s"]).trim(), "commit 3");
}

/// A sign-in whose header makes git fail with a message the fake calls a refusal (the env turns the file transport off).
#[derive(Debug, Default)]
struct RefusedAuth {
    reports: AtomicUsize,
    present: bool,
}

impl RemoteAuth for RefusedAuth {
    fn env(&self) -> Option<Vec<(String, String)>> {
        self.present.then(|| {
            vec![
                ("GIT_CONFIG_COUNT".into(), "1".into()),
                ("GIT_CONFIG_KEY_0".into(), "protocol.file.allow".into()),
                ("GIT_CONFIG_VALUE_0".into(), "never".into()),
            ]
        })
    }
    fn auth_refused(&self, message: &str) -> bool {
        message.contains("not allowed")
    }
    fn token_refused(&self, message: &str) -> bool {
        self.auth_refused(message)
    }
    fn refused(&self) {
        self.reports.fetch_add(1, Ordering::SeqCst);
    }
}

#[tokio::test]
async fn a_refused_sign_in_is_reported_and_the_run_retried_without_it() {
    let lab = Lab::new();
    let work = lab.repo("seed", 1);
    lab.sh(&work, &["push", "-q", GITHUB_URL, "main"]);
    let clone = lab.dir.join("signed");
    lab.sh(&lab.dir, &["clone", "-q", GITHUB_URL, &s(&clone)]);

    let auth = Arc::new(RefusedAuth { present: true, ..Default::default() });
    let git = lab.git_with_auth(auth.clone());
    ok(&git, &clone, "fetch", json!({"requestId": id()})).await;
    assert_eq!(auth.reports.load(Ordering::SeqCst), 1, "the refusal reached the owner of the sign-in");

    let none = Arc::new(RefusedAuth::default());
    let git = lab.git_with_auth(none.clone());
    ok(&git, &clone, "fetch", json!({"requestId": id()})).await;
    assert_eq!(none.reports.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn publishing_adds_origin_and_pushes_the_branch_with_upstream() {
    let lab = Lab::new();
    let work = lab.repo("publish", 2);
    let git = lab.git();
    let w = s(&work);
    let info = git.publish_info(&w, Some(&w)).await.unwrap();
    assert_eq!(info, unimux_git::PublishInfo { branch: Some("main".into()), initial: false, remotes: vec![] });

    let env = vec![("GIT_TRACE".to_string(), "0".to_string())];
    let pushed = git.publish_push(&w, &id(), GITHUB_URL, "main", env.clone(), Some(&w)).await.unwrap();
    assert!(pushed.pushed, "{}", pushed.message);
    let status = ok(&git, &work, "status", json!({})).await;
    assert_eq!(status["hasRemote"], true);
    assert_eq!(status["upstream"], "origin/main");
    assert_eq!(lab.sh(&work, &["config", "--get", "remote.origin.url"]).trim(), GITHUB_URL);
    // a second publish is refused: the repository has a remote now
    let again = git.publish_push(&w, &id(), GITHUB_URL, "main", env.clone(), Some(&w)).await;
    assert_eq!(again.unwrap_err().code, GitErrorCode::Invalid);
    // a URL that is not plain https is refused before anything runs
    let other = lab.repo("other", 1);
    let o = s(&other);
    let bad = git.publish_push(&o, &id(), "file:///x", "main", env.clone(), Some(&o)).await;
    assert_eq!(bad.unwrap_err().code, GitErrorCode::Invalid);

    let empty = lab.repo("empty-pub", 0);
    let e = s(&empty);
    assert_eq!(
        git.publish_info(&e, Some(&e)).await.unwrap(),
        unimux_git::PublishInfo { branch: Some("main".into()), initial: true, remotes: vec![] }
    );
    let detached = lab.repo("detached", 2);
    lab.sh(&detached, &["checkout", "-q", "--detach", "HEAD~1"]);
    let d = s(&detached);
    assert_eq!(git.publish_info(&d, Some(&d)).await.unwrap().branch, None);
    let refused = git.publish_push(&d, &id(), GITHUB_URL, "main", env, Some(&d)).await;
    assert_eq!(refused.unwrap_err().code, GitErrorCode::Invalid);
    assert_eq!(lab.sh(&detached, &["remote"]).trim(), "");
}
