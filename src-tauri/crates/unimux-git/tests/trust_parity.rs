//! The rest of test/git-trust.test.ts against REAL git, through the request pipeline (`handler::handle_git`): a hostile
//! repository runs nothing on any channel until it is trusted and never the programs the runner switches off, untracked diffs
//! stay inside the repository, credentials are redacted, the output caps of writes, the stale and foreign index locks, the
//! scrubbed environment, the parent-repository refusals, the shared write lock of worktrees and the confirmed push URL.
//! The marker programs are Node scripts (like the TS test); without Node the checks that need them are skipped with a note.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{Value, json};
use unimux_git::handler::handle_git;
use unimux_git::paths::{canonical_path, realpath_native, same_path};
use unimux_git::{Git, GitErrorCode, GitOptions, GitProbe};

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn id() -> String {
    format!("req-{:06}-tprt", COUNTER.fetch_add(1, Ordering::Relaxed) + 1)
}

fn slash(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn node() -> Option<PathBuf> {
    let out = Command::new("node").args(["-e", "process.stdout.write(process.execPath)"]).stdin(Stdio::null()).output().ok()?;
    out.status.success().then(|| PathBuf::from(String::from_utf8_lossy(&out.stdout).into_owned()))
}

fn write(dir: &Path, name: &str, text: &str) {
    std::fs::write(dir.join(name), text).unwrap();
}

struct Lab {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    env: HashMap<OsString, OsString>,
    marker: PathBuf,
    node: Option<PathBuf>,
}

impl Lab {
    fn new() -> Self {
        let tmp = tempfile::Builder::new().prefix("mc-trust-parity-").tempdir().unwrap();
        let dir = PathBuf::from(realpath_native(&tmp.path().to_string_lossy()).unwrap());
        let marker = dir.join("markers.log");
        std::fs::write(
            dir.join("mark.js"),
            format!(
                "const fs = require('fs');\nfs.appendFileSync({}, process.argv[2] + '\\n');\nif (['clean', 'smudge'].includes(process.argv[2])) process.stdin.pipe(process.stdout);\n",
                json!(slash(&marker))
            ),
        )
        .unwrap();
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
        Lab { _tmp: tmp, dir, env, marker, node: node() }
    }

    fn git(&self) -> Arc<Git> {
        self.git_with(GitOptions::default())
    }

    fn git_with(&self, options: GitOptions) -> Arc<Git> {
        Arc::new(Git::new(GitOptions { env: Some(options.env.clone().unwrap_or_else(|| self.env.clone())), ..options }))
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

    fn program(&self, name: &str) -> String {
        let node = self.node.as_deref().map(slash).unwrap_or_else(|| "/no/node/here".into());
        format!("\"{node}\" \"{}\" {name}", slash(&self.dir.join("mark.js")))
    }

    fn markers(&self) -> Vec<String> {
        std::fs::read_to_string(&self.marker).unwrap_or_default().lines().filter(|l| !l.is_empty()).map(str::to_string).collect()
    }

    fn reset_markers(&self) {
        let _ = std::fs::remove_file(&self.marker);
    }

    fn hostile(&self, name: &str) -> (PathBuf, PathBuf) {
        let bare = self.dir.join(format!("{name}.git"));
        self.sh(&self.dir, &["init", "-q", "--bare", "-b", "main", &s(&bare)]);
        let dir = self.dir.join(name);
        self.sh(&self.dir, &["clone", "-q", &s(&bare), &s(&dir)]);
        write(&dir, "a.txt", "one\n");
        write(&dir, "data.dat", "binary-ish\n");
        write(&dir, ".gitattributes", "*.txt filter=mark\n*.dat diff=mark\n");
        self.sh(&dir, &["add", "."]);
        self.sh(&dir, &["commit", "-q", "-m", "first"]);
        self.sh(&dir, &["push", "-q", "origin", "main"]);
        self.reset_markers();
        for (key, value) in [
            ("core.fsmonitor", self.program("fsmonitor")),
            ("filter.mark.clean", self.program("clean")),
            ("filter.mark.smudge", self.program("smudge")),
            ("diff.mark.textconv", self.program("textconv")),
            ("diff.external", self.program("extdiff")),
            ("core.pager", self.program("pager")),
            ("pager.log", self.program("pager-log")),
            ("remote.origin.uploadpack", self.program("uploadpack")),
            ("remote.origin.receivepack", self.program("receivepack")),
            ("core.sshCommand", self.program("ssh")),
            ("credential.helper", format!("!{}", self.program("credential"))),
            ("alias.boom", format!("!{}", self.program("alias"))),
            ("include.path", "../nowhere.gitconfig".into()),
        ] {
            self.sh(&dir, &["config", key, &value]);
        }
        let hooks = dir.join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        for hook in
            ["pre-commit", "post-commit", "post-checkout", "post-index-change", "reference-transaction", "pre-push", "post-merge"]
        {
            let file = hooks.join(hook);
            std::fs::write(&file, format!("#!/bin/sh\n{}\nexit 0\n", self.program(&format!("hook-{hook}")))).unwrap();
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
            }
        }
        (dir, bare)
    }

    fn quiet(&self, name: &str, commit: bool) -> PathBuf {
        let dir = self.dir.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        self.sh(&dir, &["init", "-q", "-b", "main", "."]);
        if commit {
            write(&dir, "a.txt", "a\n");
            self.sh(&dir, &["add", "."]);
            self.sh(&dir, &["commit", "-q", "-m", "one"]);
        }
        dir
    }
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

const NEVER: [&str; 6] = ["fsmonitor", "textconv", "extdiff", "pager", "pager-log", "alias"];

#[tokio::test(flavor = "multi_thread")]
async fn an_untrusted_repository_runs_nothing_and_a_flag_does_not_trust_it() {
    let lab = Lab::new();
    let git = lab.git();

    // 'runs nothing on any IPC channel: reads that were measured are allowed, everything else refuses'
    let (dir, _) = lab.hostile("zero");
    write(&dir, "untracked.txt", "new\n");
    write(&dir, "a.txt", "two\n");
    let hash = lab.sh(&dir, &["rev-parse", "HEAD"]).trim().to_string();
    let allowed: Vec<(&str, Value)> = vec![
        ("log", json!({"skip": 0, "count": 10})),
        ("log", json!({"skip": 0, "count": 10, "search": "first", "all": true})),
        ("show", json!({"hash": hash})),
        ("branches", json!({})),
        ("diff", json!({"source": "commit", "hash": hash, "path": "a.txt"})),
        ("diff", json!({"source": "staged", "path": "a.txt"})),
        ("trust", json!({})),
    ];
    for (channel, req) in allowed {
        assert!(call(&git, &dir, channel, req.clone()).await.is_ok(), "{channel} {req}");
    }
    let refused: Vec<(&str, Value)> = vec![
        ("status", json!({})),
        ("status", json!({"trusted": true, "trust": true})),
        ("diff", json!({"source": "working", "path": "a.txt"})),
        ("diff", json!({"source": "untracked", "path": "untracked.txt"})),
        ("stage", json!({"requestId": id(), "paths": ["a.txt"]})),
        ("stage", json!({"requestId": id(), "paths": [], "all": true})),
        ("unstage", json!({"requestId": id(), "paths": ["a.txt"]})),
        ("commit", json!({"requestId": id(), "message": "nope"})),
        ("fetch", json!({"requestId": id()})),
        ("pull", json!({"requestId": id()})),
        ("push", json!({"requestId": id(), "remote": "origin", "branch": "main", "urlId": "0123456789abcdef"})),
        ("checkout", json!({"requestId": id(), "branch": "main"})),
    ];
    for (channel, req) in refused {
        assert_eq!(code(&git, &dir, channel, req.clone()).await, GitErrorCode::Untrusted, "{channel} {req}");
    }
    assert_eq!(git.probe(&s(&dir)).await, GitProbe::Repo);
    assert_eq!(git.worktrees(&s(&dir), None, &[], None).await.unwrap().len(), 1);
    assert!(lab.markers().is_empty(), "{:?}", lab.markers());
    assert_eq!(lab.sh(&dir, &["log", "--format=%s"]).trim(), "first");

    // 'cannot be trusted by a flag on an ordinary call, only by the dedicated request' (the status and commit halves)
    let (flag, _) = lab.hostile("flag");
    assert_eq!(code(&git, &flag, "status", json!({"trusted": true})).await, GitErrorCode::Untrusted);
    assert_eq!(
        code(&git, &flag, "commit", json!({"requestId": id(), "message": "x", "trusted": true})).await,
        GitErrorCode::Untrusted
    );

    // 'shape of an error for an untrusted repository carries a message the panel can translate' (through the status channel)
    let (_, message) = call(&git, &flag, "status", json!({})).await.unwrap_err();
    assert!(message.contains("Zaufaj mu"), "{message}");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_trusted_repository_runs_what_git_runs_but_never_the_programs_switched_off() {
    let lab = Lab::new();
    if lab.node.is_none() {
        eprintln!("node is not installed: the marker programs cannot run, skipped");
        return;
    }
    let git = lab.git();
    let (dir, bare) = lab.hostile("trusted");
    write(&dir, "b.txt", "b\n");
    ok(&git, &dir, "trustGrant", json!({"requestId": id()})).await;
    assert!(lab.markers().is_empty());
    assert_eq!(ok(&git, &dir, "status", json!({})).await["branch"], "main");
    ok(&git, &dir, "stage", json!({"requestId": id(), "paths": ["b.txt"]})).await;
    ok(&git, &dir, "commit", json!({"requestId": id(), "message": "add b"})).await;
    assert!(call(&git, &dir, "fetch", json!({"requestId": id()})).await.is_err(), "uploadpack is the marker");
    let seen = lab.markers();
    for wanted in ["clean", "hook-pre-commit", "hook-post-commit", "uploadpack"] {
        assert!(seen.iter().any(|m| m == wanted), "{wanted} in {seen:?}");
    }
    for never in NEVER {
        assert!(!seen.iter().any(|m| m == never), "{never} in {seen:?}");
    }
    lab.reset_markers();
    let hash = lab.sh(&dir, &["rev-parse", "HEAD"]).trim().to_string();
    ok(&git, &dir, "diff", json!({"source": "commit", "hash": hash, "path": "b.txt"})).await;
    ok(&git, &dir, "diff", json!({"source": "working", "path": "a.txt"})).await;
    ok(&git, &dir, "log", json!({"skip": 0, "count": 5})).await;
    let seen = lab.markers();
    for never in NEVER {
        assert!(!seen.iter().any(|m| m == never), "{never} in {seen:?}");
    }
    assert_eq!(lab.sh(&bare, &["log", "--format=%s", "main"]).trim(), "first");
}

#[tokio::test(flavor = "multi_thread")]
async fn untracked_diffs_stay_inside_the_repository_and_credentials_are_redacted() {
    let lab = Lab::new();
    let git = lab.git();

    // 'only shows files git lists as untracked'
    let dir = lab.quiet("confine", false);
    lab.sh(&dir, &["remote", "add", "origin", "https://user:tok3n-secret@example.com/r.git"]);
    write(&dir, "tracked.txt", "t\n");
    lab.sh(&dir, &["add", "."]);
    lab.sh(&dir, &["commit", "-q", "-m", "one"]);
    write(&dir, "new.txt", "visible https://bob:hunter2@host.example/x.git here\n");
    write(&dir, ".gitignore", "ignored.log\n");
    write(&dir, "ignored.log", "ignored\n");
    let d = s(&dir);
    let diff = |path: &str| {
        let git = git.clone();
        let d = d.clone();
        let req = unimux_git::shared::GitDiffRequest {
            worktree: None,
            source: unimux_git::shared::GitDiffSource::Untracked,
            path: path.to_string(),
            old_path: None,
            hash: None,
        };
        async move { git.diff(&d, &req).await }
    };
    let shown = diff("new.txt").await.unwrap();
    assert!(shown.text.contains("+visible https://***@host.example/x.git here"), "{}", shown.text);
    assert!(!shown.text.contains("hunter2"));
    for path in [
        "tracked.txt",
        "ignored.log",
        ".git/config",
        "GIT~1/config",
        "git~1/config",
        "missing.txt",
        "new.txt/../tracked.txt",
        ".",
    ] {
        let result = diff(path).await;
        let wire = unimux_git::result_json(&result);
        assert_eq!(wire["ok"], false, "{path}");
        assert!(!wire.to_string().contains("tok3n-secret"), "{path}");
    }
    assert_eq!(code(&git, &dir, "diff", json!({"source": "untracked", "path": "GIT~1/config"})).await, GitErrorCode::Invalid);

    // 'does not follow a junction or symlink out of the repository'
    let junction_dir = lab.quiet("junction", true);
    let outside = lab.dir.join("outside-secrets");
    std::fs::create_dir(&outside).unwrap();
    write(&outside, "secret.txt", "TOP-SECRET-OUTSIDE\n");
    let link = junction_dir.join("link");
    #[cfg(windows)]
    junction::create(&outside, &link).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &link).unwrap();
    for path in ["link/secret.txt", "link"] {
        let result = call(&git, &junction_dir, "diff", json!({"source": "untracked", "path": path})).await;
        assert!(result.is_err(), "{path}");
        assert!(!format!("{result:?}").contains("TOP-SECRET-OUTSIDE"), "{path}");
    }
    #[cfg(windows)]
    junction::delete(&link).ok();

    // 'redacts credentials in commit messages and commit diffs too'
    let redact = lab.quiet("redact", false);
    write(&redact, "cfg.txt", "url = https://bob:hunter2@host.example/x.git\ntoken ghp_abcdefghijklmnopqrstuvwxyz0123456789\n");
    lab.sh(&redact, &["add", "."]);
    lab.sh(&redact, &["commit", "-q", "-m", "push to https://bob:hunter2@host.example/x.git"]);
    let hash = lab.sh(&redact, &["rev-parse", "HEAD"]).trim().to_string();
    let text = ok(&git, &redact, "diff", json!({"source": "commit", "hash": hash, "path": "cfg.txt"})).await["text"].to_string();
    assert!(!text.contains("hunter2") && !text.contains("ghp_abc"), "{text}");
    let details = ok(&git, &redact, "show", json!({"hash": hash})).await;
    assert!(!details["message"].to_string().contains("hunter2"));
    assert!(!details["commit"]["subject"].to_string().contains("hunter2"));
}

#[tokio::test(flavor = "multi_thread")]
async fn writes_survive_tiny_caps_refuse_cut_reads_and_handle_index_locks() {
    let lab = Lab::new();

    // 'survive a tiny output cap: the excess is discarded, git is never stopped, nothing is left locked'
    let dir = lab.quiet("crlf", false);
    lab.sh(&dir, &["config", "core.autocrlf", "true"]);
    lab.sh(&dir, &["config", "core.safecrlf", "warn"]);
    for i in 0..300 {
        write(&dir, &format!("file-{i}.txt"), &format!("line one\nline two {i}\n"));
    }
    let tiny = lab.git_with(GitOptions {
        max_output_bytes: 200,
        write_output_bytes: 300,
        read_timeout: Duration::from_secs(60),
        ..Default::default()
    });
    ok(&tiny, &dir, "stage", json!({"requestId": id(), "paths": [], "all": true})).await;
    assert_eq!(lab.sh(&dir, &["diff", "--cached", "--name-only"]).trim().lines().count(), 300);
    assert!(!dir.join(".git").join("index.lock").exists());
    ok(&tiny, &dir, "commit", json!({"requestId": id(), "message": "all of them"})).await;
    assert_eq!(lab.sh(&dir, &["log", "--format=%s"]).trim(), "all of them");

    // 'refuses a read that would be cut instead of acting on partial output'
    let cut = lab.quiet("cut", false);
    for i in 0..80 {
        write(&cut, &format!("tracked-file-{i}.txt"), "x");
    }
    lab.sh(&cut, &["add", "."]);
    lab.sh(&cut, &["commit", "-q", "-m", "one"]);
    lab.sh(&cut, &["branch", "other"]);
    for i in 0..80 {
        write(&cut, &format!("tracked-file-{i}.txt"), "changed");
    }
    let small = lab.git_with(GitOptions { max_output_bytes: 400, ..Default::default() });
    assert!(call(&small, &cut, "checkout", json!({"requestId": id(), "branch": "other"})).await.is_err());
    assert_eq!(lab.sh(&cut, &["branch", "--show-current"]).trim(), "main");

    // 'leaves a lock that it did not create alone'
    let foreign = lab.quiet("foreign-lock", false);
    write(&foreign, "a.txt", "a");
    let stale = foreign.join(".git").join("index.lock");
    std::fs::write(&stale, "").unwrap();
    let old = SystemTime::now() - Duration::from_secs(60);
    std::fs::File::options().write(true).open(&stale).unwrap().set_modified(old).unwrap();
    assert!(call(&lab.git(), &foreign, "stage", json!({"requestId": id(), "paths": ["a.txt"]})).await.is_err());
    assert!(stale.exists());

    // 'removes the index.lock of a write it had to kill'
    if lab.node.is_none() {
        eprintln!("node is not installed: the hanging stand-in part is skipped");
        return;
    }
    let locked = lab.quiet("lock", false);
    write(&locked, "a.txt", "a");
    let script = lab.dir.join("lock-git.js");
    std::fs::write(
        &script,
        "const path = require('path'); const fs = require('fs'); const a = process.argv;\n\
         if (a.includes('--show-toplevel')) console.log(process.cwd());\n\
         else if (a.includes('--absolute-git-dir')) { console.log(path.join(process.cwd(), '.git')); console.log('.git'); }\n\
         else if (a.includes('config') || a.includes('worktree')) { /* no configuration */ }\n\
         else { fs.writeFileSync(path.join(process.cwd(), '.git', 'index.lock'), ''); setTimeout(() => {}, 20000); }\n",
    )
    .unwrap();
    let hanging = lab.git_with(GitOptions {
        bin: "node".into(),
        prefix_args: vec![script.into_os_string()],
        read_timeout: Duration::from_millis(400),
        network_timeout: Duration::from_millis(400),
        ..Default::default()
    });
    let started = Instant::now();
    assert_eq!(code(&hanging, &locked, "stage", json!({"requestId": id(), "paths": ["a.txt"]})).await, GitErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(8), "{:?}", started.elapsed());
    assert!(!locked.join(".git").join("index.lock").exists());
    lab.sh(&locked, &["add", "a.txt"]);
    assert_eq!(lab.sh(&locked, &["diff", "--cached", "--name-only"]).trim(), "a.txt");
}

#[tokio::test(flavor = "multi_thread")]
async fn the_environment_is_scrubbed_and_writes_stay_inside_the_project() {
    let lab = Lab::new();
    let git = lab.git();

    // 'ignores variables that point git somewhere else'
    let dir = lab.quiet("envscrub", false);
    let other = lab.quiet("envscrub-other", false);
    write(&dir, "a.txt", "a\n");
    let evil = dir.join("evil.gitconfig");
    std::fs::write(&evil, "[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /does/not/exist\n").unwrap();
    let mut hostile = lab.env.clone();
    for (k, v) in [
        ("GIT_DIR", s(&other.join(".git"))),
        ("GIT_WORK_TREE", s(&other)),
        ("GIT_INDEX_FILE", s(&other.join(".git").join("evil-index"))),
        ("GIT_COMMON_DIR", s(&other.join(".git"))),
        ("GIT_CONFIG_COUNT", "1".into()),
        ("GIT_CONFIG_KEY_0", "core.pager".into()),
        ("GIT_CONFIG_VALUE_0", lab.program("pager")),
        ("GIT_CONFIG_PARAMETERS", "'core.pager'='x'".into()),
        ("GIT_AUTHOR_NAME", "T".into()),
        ("GIT_AUTHOR_EMAIL", "t@example.com".into()),
        ("GIT_COMMITTER_NAME", "T".into()),
        ("GIT_COMMITTER_EMAIL", "t@example.com".into()),
    ] {
        hostile.insert(k.into(), v.into());
    }
    let scrubbed = lab.git_with(GitOptions { env: Some(hostile.clone()), ..Default::default() });
    let status = ok(&scrubbed, &dir, "status", json!({})).await;
    assert!(same_path(status["root"].as_str().unwrap(), &s(&dir)));
    assert!(status["files"].as_array().unwrap().iter().any(|f| f["path"] == "a.txt"));
    for k in ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"] {
        hostile.remove(&OsString::from(k));
    }
    hostile.retain(|k, _| !k.to_string_lossy().eq_ignore_ascii_case("GIT_CONFIG_GLOBAL"));
    hostile.insert("GIT_CONFIG_GLOBAL".into(), evil.into_os_string());
    let inside_global = lab.git_with(GitOptions { env: Some(hostile), ..Default::default() });
    ok(&inside_global, &dir, "stage", json!({"requestId": id(), "paths": ["a.txt"]})).await;
    ok(&inside_global, &dir, "commit", json!({"requestId": id(), "message": "unsigned because the inner config was dropped"}))
        .await;
    assert_eq!(lab.sh(&dir, &["log", "-1", "--format=%s"]).trim(), "unsigned because the inner config was dropped");
    assert!(!lab.markers().iter().any(|m| m == "pager"));

    // 'refuses writes in a repository that is larger than the project and says so' (status and the refused writes)
    let parent = lab.quiet("parentrepo", false);
    let project = parent.join("packages").join("app");
    std::fs::create_dir_all(&project).unwrap();
    write(&parent, "top.txt", "t\n");
    write(&project, "inner.txt", "i\n");
    assert_eq!(ok(&git, &project, "status", json!({})).await["parent"], true);
    let writes: Vec<(&str, Value)> = vec![
        ("stage", json!({"requestId": id(), "paths": [], "all": true})),
        ("stage", json!({"requestId": id(), "paths": ["packages/app/inner.txt"]})),
        ("unstage", json!({"requestId": id(), "paths": ["top.txt"]})),
        ("commit", json!({"requestId": id(), "message": "x"})),
        ("fetch", json!({"requestId": id()})),
        ("pull", json!({"requestId": id()})),
        ("checkout", json!({"requestId": id(), "branch": "main"})),
    ];
    for (channel, req) in writes {
        assert_eq!(code(&git, &project, channel, req).await, GitErrorCode::Parent, "{channel}");
    }
    assert_eq!(lab.sh(&parent, &["diff", "--cached", "--name-only"]).trim(), "");
    assert_eq!(ok(&git, &parent, "status", json!({})).await["parent"], false);
    ok(&git, &parent, "stage", json!({"requestId": id(), "paths": ["top.txt"]})).await;

    // 'serializes writers of two worktrees of one repository'
    let main = lab.quiet("lockwt", true);
    let wt = lab.dir.join("lockwt-wt-b");
    lab.sh(&main, &["worktree", "add", "-q", "-b", "b", &s(&wt)]);
    write(&main, "x.txt", "x");
    write(&wt, "y.txt", "y");
    let key = canonical_path(&s(&main.join(".git")));
    {
        let _held = git.busy().take(&key).expect("free");
        assert_eq!(code(&git, &wt, "stage", json!({"requestId": id(), "paths": ["y.txt"]})).await, GitErrorCode::Busy);
    }
    ok(&git, &wt, "stage", json!({"requestId": id(), "paths": ["y.txt"]})).await;
    ok(&git, &main, "stage", json!({"requestId": id(), "paths": ["x.txt"]})).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn a_push_goes_to_the_confirmed_url_only_and_the_url_is_shown_without_credentials() {
    let lab = Lab::new();
    let git = lab.git();

    // 'refuses a push when the URL it would use is not the one the user confirmed'
    let bare = lab.dir.join("urlcheck.git");
    let other = lab.dir.join("urlcheck-other.git");
    lab.sh(&lab.dir, &["init", "-q", "--bare", "-b", "main", &s(&bare)]);
    lab.sh(&lab.dir, &["init", "-q", "--bare", "-b", "main", &s(&other)]);
    let dir = lab.dir.join("urlcheck");
    lab.sh(&lab.dir, &["clone", "-q", &s(&bare), &s(&dir)]);
    write(&dir, "a.txt", "a\n");
    lab.sh(&dir, &["add", "."]);
    lab.sh(&dir, &["commit", "-q", "-m", "to push"]);
    let confirmed = ok(&git, &dir, "status", json!({})).await["push"].clone();
    assert!(!confirmed["url"].as_str().unwrap().is_empty());
    lab.sh(&dir, &["config", "remote.origin.pushurl", &s(&other)]);
    let push = |target: &Value| json!({"requestId": id(), "remote": target["remote"], "branch": target["branch"], "urlId": target["urlId"]});
    assert_eq!(code(&git, &dir, "push", push(&confirmed)).await, GitErrorCode::Invalid);
    assert_eq!(lab.sh(&other, &["rev-list", "--all", "--count"]).trim(), "0");
    let now = ok(&git, &dir, "status", json!({})).await["push"].clone();
    assert_ne!(now["urlId"], confirmed["urlId"]);
    assert_eq!(now["url"].as_str().unwrap().replace('\\', "/"), slash(&other));
    ok(&git, &dir, "push", push(&now)).await;
    assert_eq!(lab.sh(&other, &["rev-list", "--all", "--count"]).trim(), "1");

    // 'shows the pushing URL without credentials'
    let secret = lab.quiet("urlsecret", true);
    lab.sh(&secret, &["remote", "add", "origin", "https://user:p4ssw0rd@example.com/r.git"]);
    let status = ok(&git, &secret, "status", json!({})).await;
    assert_eq!(status["push"]["url"], "https://***@example.com/r.git");
    assert!(!status.to_string().contains("p4ssw0rd"));
}
