//! test/git-paths.test.ts (the Windows cases with REAL short 8.3 and differently cased spellings of a project folder) and
//! test/git-shared-reads.test.ts (identical concurrent reads share one git run), against real git through the request
//! pipeline. The short-name cases end early when the volume has no 8.3 names, like the TS test; the shared-read cases count
//! git's subcommands through a Node wrapper and are skipped without Node.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};

use serde_json::{Value, json};
use unimux_git::handler::handle_git;
use unimux_git::paths::realpath_native;
use unimux_git::{Git, GitErrorCode, GitOptions};

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn id() -> String {
    format!("req-{:06}-path", COUNTER.fetch_add(1, Ordering::Relaxed) + 1)
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

struct Lab {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    env: HashMap<OsString, OsString>,
}

impl Lab {
    fn new(prefix: &str) -> Self {
        let tmp = tempfile::Builder::new().prefix(prefix).tempdir().unwrap();
        let dir = PathBuf::from(realpath_native(&tmp.path().to_string_lossy()).unwrap());
        let global = dir.join("global.gitconfig");
        std::fs::write(&global, "[user]\n\tname = Tester\n\temail = tester@example.com\n[init]\n\tdefaultBranch = main\n")
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

    fn git_with(&self, options: GitOptions) -> Arc<Git> {
        Arc::new(Git::new(GitOptions { env: Some(self.env.clone()), ..options }))
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

    fn project(&self, name: &str) -> PathBuf {
        let dir = self.dir.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        self.sh(&dir, &["init", "-q", "-b", "main", "."]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        self.sh(&dir, &["add", "."]);
        self.sh(&dir, &["commit", "-q", "-m", "one"]);
        dir
    }
}

async fn call(git: &Arc<Git>, project: &str, channel: &str, req: Value, extra: &[String]) -> Result<Value, GitErrorCode> {
    handle_git(git, Some(project), channel, &req, cfg!(windows), extra).await.map_err(|e| e.code)
}

async fn ok(git: &Arc<Git>, project: &str, channel: &str, req: Value) -> Value {
    call(git, project, channel, req, &[]).await.unwrap_or_else(|e| panic!("git:{channel} failed: {e:?}"))
}

#[cfg(windows)]
fn short_spelling(path: &Path) -> Option<String> {
    use unimux_exec::{ExecOptions, Program};
    let mut env: HashMap<OsString, OsString> = unimux_exec::clean_process_env();
    env.insert("MC_SHORT_SOURCE".into(), path.as_os_str().to_owned());
    let program =
        Program::Raw { program: "cmd.exe".into(), raw: r#"/d /s /c "for %I in ("%MC_SHORT_SOURCE%") do @echo %~sI""#.into() };
    let out = unimux_exec::run(&program, &ExecOptions { env: Some(env), ..Default::default() }).ok()?;
    let text = String::from_utf8_lossy(&out.stdout).trim().to_string();
    (!text.is_empty() && !text.eq_ignore_ascii_case(&path.to_string_lossy()) && Path::new(&text).exists()).then_some(text)
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn a_project_reached_through_a_short_8_3_path_is_the_same_folder() {
    let lab = Lab::new("mc-spelling-parity-");
    let git = lab.git_with(GitOptions::default());

    // 'is the repository itself, not a parent repository, and can be written to'
    let dir = lab.project("A Long Project Name");
    let Some(short) = short_spelling(&dir) else {
        eprintln!("8.3 names are disabled on this volume: skipped");
        return;
    };
    let status = ok(&git, &short, "status", json!({})).await;
    assert_eq!(status["parent"], false);
    assert_eq!(status["projectRelation"], json!({"kind": "inside-root", "prefix": ""}));
    assert_eq!(ok(&git, &short, "trust", json!({})).await["parent"], false);
    std::fs::write(dir.join("b.txt"), "b\n").unwrap();
    ok(&git, &short, "stage", json!({"requestId": id(), "paths": ["b.txt"]})).await;
    ok(&git, &short, "commit", json!({"requestId": id(), "message": "through the short name"})).await;
    assert_eq!(lab.sh(&dir, &["log", "-1", "--format=%s"]).trim(), "through the short name");

    // 'knows the worktrees by canonical path (allowed, the project itself, the preferred one)'
    let dir = lab.project("Another Long Project");
    let short = short_spelling(&dir).unwrap();
    let wt = PathBuf::from(format!("{}-wt-feature one", s(&dir)));
    lab.sh(&dir, &["worktree", "add", "-q", "-b", "mc/feature", &s(&wt)]);
    let short_wt = short_spelling(&wt).unwrap_or_else(|| s(&wt));
    let list = git.worktrees(&short, Some(&short), &[], Some(&short_wt)).await.unwrap();
    let mut seen: Vec<String> = list
        .iter()
        .map(|w| format!("{}:{}:{}:{}", w.branch.as_deref().unwrap_or(""), w.allowed, w.is_project, w.preferred))
        .collect();
    seen.sort();
    assert_eq!(seen, ["main:true:true:false", "mc/feature:true:false:true"]);
    assert!(git.resolve_dir(&short, Some(&short_wt), &[]).await.is_ok());
    let status = ok(&git, &short, "status", json!({"worktree": short_wt})).await;
    assert_eq!((status["branch"].as_str(), status["parent"].as_bool()), (Some("mc/feature"), Some(false)));
    let elsewhere = lab.dir.join("Some Elsewhere Checkout");
    lab.sh(&dir, &["worktree", "add", "-q", "-b", "mc/elsewhere", &s(&elsewhere)]);
    let short_elsewhere = short_spelling(&elsewhere).unwrap_or_else(|| s(&elsewhere));
    assert!(git.resolve_dir(&short, Some(&s(&elsewhere)), &[]).await.is_err());
    assert!(git.resolve_dir(&short, Some(&s(&elsewhere)), &[short_elsewhere]).await.is_ok());

    // 'is still a parent repository when the project is a subfolder, with the prefix worked out on real paths'
    let dir = lab.project("Yet Another Long Repository");
    let sub = dir.join("Packages").join("Application Name");
    std::fs::create_dir_all(&sub).unwrap();
    if let Some(short_sub) = short_spelling(&sub) {
        let status = ok(&git, &short_sub, "status", json!({})).await;
        assert_eq!(status["parent"], true);
        assert_eq!(status["projectRelation"], json!({"kind": "inside-root", "prefix": "Packages/Application Name"}));
        let refused = call(&git, &short_sub, "stage", json!({"requestId": id(), "paths": [], "all": true}), &[]).await;
        assert_eq!(refused.unwrap_err(), GitErrorCode::Parent);
    }

    // 'keeps one trust entry and one write lock for every spelling of a folder'
    let dir = lab.project("Trusted Long Project");
    let short = short_spelling(&dir).unwrap();
    std::fs::create_dir_all(dir.join(".git").join("hooks")).unwrap();
    std::fs::write(dir.join(".git").join("hooks").join("pre-commit"), "#!/bin/sh\nexit 0\n").unwrap();
    let trust_file = lab.dir.join("trust").join("git-trust.json");
    let first = lab.git_with(GitOptions { trust_file: Some(trust_file.clone()), ..Default::default() });
    assert_eq!(ok(&first, &short, "trust", json!({})).await["state"], "untrusted");
    ok(&first, &short, "trustGrant", json!({"requestId": id()})).await;
    let second = lab.git_with(GitOptions { trust_file: Some(trust_file), ..Default::default() });
    let long = s(&dir);
    for spelling in [long.clone(), short.clone(), long.to_uppercase(), long.to_lowercase(), long.replace('\\', "/")] {
        assert_eq!(ok(&second, &spelling, "trust", json!({})).await["state"], "trusted", "{spelling}");
    }
    std::fs::write(dir.join("x.txt"), "x").unwrap();
    std::fs::write(dir.join("y.txt"), "y").unwrap();
    let key = unimux_git::paths::canonical_path(&s(&dir.join(".git")));
    {
        let _held = second.busy().take(&key).expect("free");
        let busy = call(&second, &short, "stage", json!({"requestId": id(), "paths": ["x.txt"]}), &[]).await;
        assert_eq!(busy.unwrap_err(), GitErrorCode::Busy);
    }
    ok(&second, &short, "stage", json!({"requestId": id(), "paths": ["x.txt"]})).await;
    ok(&second, &long, "stage", json!({"requestId": id(), "paths": ["y.txt"]})).await;

    // 'still refuses 8.3 aliases and links inside a repository path'
    let dir = lab.project("Confined Long Project");
    let short = short_spelling(&dir).unwrap();
    for path in ["GIT~1/config", "git~1/config", ".git/config"] {
        let req = unimux_git::shared::GitDiffRequest {
            worktree: None,
            source: unimux_git::shared::GitDiffSource::Untracked,
            path: path.into(),
            old_path: None,
            hash: None,
        };
        assert!(git.diff(&short, &req).await.is_err(), "{path}");
    }
    let outside = lab.dir.join("outside folder with secrets");
    std::fs::create_dir(&outside).unwrap();
    std::fs::write(outside.join("secret.txt"), "TOP-SECRET\n").unwrap();
    let link = dir.join("link");
    junction::create(&outside, &link).unwrap();
    let req = unimux_git::shared::GitDiffRequest {
        worktree: None,
        source: unimux_git::shared::GitDiffSource::Untracked,
        path: "link/secret.txt".into(),
        old_path: None,
        hash: None,
    };
    let result = git.diff(&short, &req).await;
    assert!(result.is_err());
    assert!(!format!("{result:?}").contains("TOP-SECRET"));
    junction::delete(&link).ok();
}

#[cfg(windows)]
#[tokio::test(flavor = "multi_thread")]
async fn a_project_reached_with_other_letter_case_behaves_like_the_same_folder() {
    let lab = Lab::new("mc-spelling-case-");
    let git = lab.git_with(GitOptions::default());
    let dir = lab.project("Cased Project Folder");
    let long = s(&dir);
    let mut odd = long.replace("Cased Project", "CASED project");
    odd.replace_range(0..1, &odd[0..1].to_lowercase());
    assert_ne!(odd, long);
    let status = ok(&git, &odd, "status", json!({})).await;
    assert_eq!(status["parent"], false);
    assert_eq!(status["projectRelation"], json!({"kind": "inside-root", "prefix": ""}));
    std::fs::write(dir.join("c.txt"), "c\n").unwrap();
    ok(&git, &odd, "stage", json!({"requestId": id(), "paths": ["c.txt"]})).await;
    let list = git.worktrees(&odd, Some(&odd), &[], None).await.unwrap();
    assert_eq!(list.iter().map(|w| format!("{}:{}", w.allowed, w.is_project)).collect::<Vec<_>>(), ["true:true"]);
}

/// Logs git's subcommand (the first argument after the global options), then runs the real git with the same arguments.
const WRAPPER: &str = r#"const { spawnSync } = require('child_process');
const fs = require('fs');
const args = process.argv.slice(2);
let i = 0;
while (i < args.length && (args[i].startsWith('--') || args[i] === '-c')) i += args[i] === '-c' ? 2 : 1;
fs.appendFileSync(process.env.MC_CALLS_LOG, (args[i] || '') + '\n');
const r = spawnSync('git', args, { stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
"#;

fn node_available() -> bool {
    Command::new("node").arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

#[tokio::test(flavor = "multi_thread")]
async fn identical_concurrent_reads_share_one_git_run_and_a_write_starts_a_new_one() {
    if !node_available() {
        eprintln!("node is not installed: skipped");
        return;
    }
    let mut lab = Lab::new("mc-git-shared-parity-");
    let log = lab.dir.join("calls.log");
    let wrapper = lab.dir.join("git-wrapper.cjs");
    std::fs::write(&wrapper, WRAPPER).unwrap();
    lab.env.insert("MC_CALLS_LOG".into(), log.clone().into_os_string());
    let runs = |name: &str| std::fs::read_to_string(&log).unwrap_or_default().lines().filter(|l| *l == name).count();
    let wrapped = || {
        lab.git_with(GitOptions { bin: "node".into(), prefix_args: vec![wrapper.clone().into_os_string()], ..Default::default() })
    };

    // 'runs one git status for concurrent identical requests and a new one after a write'
    let dir = lab.project("status");
    let d = s(&dir);
    let git = wrapped();
    git.status(&d, None).await.unwrap();
    let _ = std::fs::remove_file(&log);
    let (a, b, c) = tokio::join!(git.status(&d, None), git.status(&d, None), git.status(&d, None));
    let (a, b, c) = (a.unwrap(), b.unwrap(), c.unwrap());
    assert_eq!(a, b);
    assert_eq!(b, c);
    assert_eq!(runs("status"), 1);
    assert_eq!(runs("for-each-ref"), 0, "the push target of the status is remembered");
    std::fs::write(dir.join("b.txt"), "b\n").unwrap();
    ok(&git, &d, "stage", json!({"requestId": "req-stage-1", "paths": ["b.txt"]})).await;
    let after = git.status(&d, None).await.unwrap();
    assert!(after.files.iter().any(|f| f.path == "b.txt"));

    // 'shares concurrent trust reads, and a cached read does not scan again within the window'
    let dir = lab.project("trust");
    let d = s(&dir);
    let git = wrapped();
    git.trust_info(&d, None, false).await.unwrap();
    let _ = std::fs::remove_file(&log);
    let (one, two) = tokio::join!(git.trust_info(&d, None, false), git.trust_info(&d, None, false));
    assert_eq!(one.unwrap(), two.unwrap());
    let fresh = runs("config");
    assert!(fresh > 0);
    git.trust_info(&d, None, true).await.unwrap();
    assert_eq!(runs("config"), fresh, "the scan of a moment ago is reused for display");
    git.trust_info(&d, None, false).await.unwrap();
    assert!(runs("config") > fresh, "the dialog always scans again");
}
