//! The runner against REAL git in temporary repositories (PLAN G1 acceptance: the runner cases of test/git-ops.test.ts and the
//! git-paths cases that need git). The configuration is the lab's own (GIT_CONFIG_GLOBAL in the lab, GIT_CONFIG_NOSYSTEM=1,
//! HOME in the lab), so no system credential helper can show anything; the remotes are refused at once (127.0.0.1:1).
//! The slow-git cases use a Node stand-in like the TS test and are skipped when Node is missing.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use unimux_git::paths::{canonical_path, realpath_native, same_path};
use unimux_git::runner::{DIFF_CAP, INSTALL_HINT};
use unimux_git::{Git, GitErrorCode, GitOptions, GitProbe, RunOptions};

struct Lab {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    env: HashMap<OsString, OsString>,
}

impl Lab {
    fn new() -> Self {
        let tmp = tempfile::Builder::new().prefix("mc-git-rs-").tempdir().unwrap();
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
            ("GIT_AUTHOR_DATE", "2026-01-02T03:04:05Z".into()),
            ("GIT_COMMITTER_DATE", "2026-01-02T03:04:05Z".into()),
        ] {
            env.retain(|key, _| !key.to_string_lossy().eq_ignore_ascii_case(k));
            env.insert(k.into(), v);
        }
        Lab { _tmp: tmp, dir, env }
    }

    fn git(&self) -> Git {
        Git::new(GitOptions { env: Some(self.env.clone()), ..Default::default() })
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

fn node_available() -> bool {
    Command::new("node").arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success())
}

#[tokio::test]
async fn runs_with_the_global_safety_arguments_and_a_quiet_environment() {
    let lab = Lab::new();
    let dir = lab.repo("quiet", 1);
    let git = lab.git();
    let d = s(&dir);
    let read = git.read_options();
    let get = |args: &'static [&'static str]| {
        let git = &git;
        let d = d.clone();
        let read = read.clone();
        async move { git.run(&d, args, &read).await.map(|o| o.stdout.trim().to_string()) }
    };
    assert_eq!(get(&["config", "--get", "color.ui"]).await.unwrap(), "false");
    assert_eq!(get(&["config", "--get", "core.quotepath"]).await.unwrap(), "false");
    assert_eq!(get(&["config", "--get", "core.fsmonitor"]).await.unwrap(), "false");
    assert_eq!(get(&["config", "--get", "protocol.ext.allow"]).await.unwrap(), "never");
    assert_eq!(get(&["config", "--get", "log.showSignature"]).await.unwrap(), "false");
    assert_eq!(get(&["var", "GIT_PAGER"]).await.unwrap(), "cat");
    assert_eq!(get(&["var", "GIT_EDITOR"]).await.unwrap(), "true");
    assert_eq!(get(&["var", "GIT_SEQUENCE_EDITOR"]).await.unwrap(), "true");

    // core.quotepath=false: a Polish file name comes back as it is
    std::fs::write(dir.join("zażółć.txt"), "z").unwrap();
    let listed = git.run(&d, &["ls-files", "--others", "--exclude-standard"], &read).await.unwrap();
    assert_eq!(listed.stdout.trim(), "zażółć.txt");
}

#[tokio::test]
async fn variables_that_point_git_elsewhere_are_scrubbed() {
    let lab = Lab::new();
    let dir = lab.repo("scrub", 1);
    let other = lab.repo("other", 1);
    let inside = dir.join("evil.gitconfig");
    std::fs::write(&inside, "[user]\n\tname = Evil\n").unwrap();
    let mut env = lab.env.clone();
    env.insert("GIT_DIR".into(), other.join(".git").into_os_string());
    env.insert("GIT_WORK_TREE".into(), other.clone().into_os_string());
    env.insert("GIT_INDEX_FILE".into(), other.join(".git").join("index").into_os_string());
    env.insert("GIT_CONFIG_COUNT".into(), "1".into());
    env.insert("GIT_CONFIG_KEY_0".into(), "user.name".into());
    env.insert("GIT_CONFIG_VALUE_0".into(), "Injected".into());
    env.insert("GIT_CONFIG_PARAMETERS".into(), "'user.name'='Param'".into());
    env.retain(|k, _| !k.to_string_lossy().eq_ignore_ascii_case("GIT_CONFIG_GLOBAL"));
    env.insert("GIT_CONFIG_GLOBAL".into(), inside.into_os_string());
    let git = Git::new(GitOptions { env: Some(env), ..Default::default() });
    let d = s(&dir);
    let top = git.run(&d, &["rev-parse", "--show-toplevel"], &git.read_options()).await.unwrap();
    assert!(same_path(top.stdout.trim(), &d), "{}", top.stdout);
    // the global configuration inside the repository is dropped; the injected keys are gone too
    let name = git.run(&d, &["config", "--get", "user.name"], &git.read_options()).await;
    assert_eq!(name.unwrap_err().code, GitErrorCode::Failed);
    // a global configuration outside the repository stays
    let lab_git = lab.git();
    assert_eq!(
        lab_git.run(&d, &["config", "--get", "user.name"], &lab_git.read_options()).await.unwrap().stdout.trim(),
        "Tester"
    );
}

#[tokio::test]
async fn reports_a_missing_git_with_an_install_hint() {
    let lab = Lab::new();
    let dir = lab.repo("nogit", 1);
    let missing =
        Git::new(GitOptions { bin: "git-that-does-not-exist-xyz".into(), env: Some(lab.env.clone()), ..Default::default() });
    let err = missing.root(&s(&dir)).await.unwrap_err();
    assert_eq!(err.code, GitErrorCode::NoGit);
    assert!(err.message.contains("Zainstaluj Git"));
    assert_eq!(err.message, INSTALL_HINT);
    assert_eq!(missing.probe(&s(&dir)).await, GitProbe::NoGit);
}

#[tokio::test]
async fn finds_the_root_from_a_subfolder_and_tells_folders_without_a_repository() {
    let lab = Lab::new();
    let dir = lab.repo("rooted", 1);
    let deep = dir.join("a").join("b");
    std::fs::create_dir_all(&deep).unwrap();
    let git = lab.git();
    let root = git.root(&s(&deep)).await.unwrap();
    assert!(same_path(&root, &s(&dir)), "{root}");
    // git's spelling: forward slashes on Windows too
    assert!(!root.contains('\\'), "{root}");
    assert_eq!(git.probe(&s(&dir)).await, GitProbe::Repo);
    let plain = lab.dir.join("plain");
    std::fs::create_dir_all(&plain).unwrap();
    assert_eq!(git.probe(&s(&plain)).await, GitProbe::NoRepo);
    assert_eq!(git.root(&s(&plain)).await.unwrap_err().code, GitErrorCode::NotRepo);
    assert_eq!(git.probe(&s(&lab.dir.join("does-not-exist"))).await, GitProbe::NoRepo);
    assert_eq!(git.root(&s(&lab.dir.join("does-not-exist"))).await.unwrap_err().code, GitErrorCode::Gone);
    // the root is remembered: a repository removed meanwhile still answers from the cache for a few seconds
    std::fs::rename(dir.join(".git"), dir.join("git-moved")).unwrap();
    assert!(same_path(&git.root(&s(&deep)).await.unwrap(), &s(&dir)));
    git.forget_root(&s(&deep));
    assert_eq!(git.root(&s(&deep)).await.unwrap_err().code, GitErrorCode::NotRepo);
}

#[tokio::test]
async fn the_git_dirs_of_a_worktree_name_the_shared_common_dir() {
    let lab = Lab::new();
    let dir = lab.repo("withwt", 1);
    let wt = lab.dir.join("withwt-wt-feature one");
    lab.sh(&dir, &["worktree", "add", "-q", "-b", "mc/feature", &s(&wt)]);
    let git = lab.git();
    let main = git.git_dirs(&s(&dir)).await.unwrap();
    let other = git.git_dirs(&s(&wt)).await.unwrap();
    assert_eq!(canonical_path(&main.common_dir), canonical_path(&s(&dir.join(".git"))));
    assert_eq!(canonical_path(&other.common_dir), canonical_path(&main.common_dir));
    assert_ne!(canonical_path(&other.git_dir), canonical_path(&main.git_dir));
    assert!(canonical_path(&other.git_dir).starts_with(&format!("{}/worktrees/", canonical_path(&main.common_dir))));
}

#[tokio::test]
async fn caps_the_output_of_reads_and_writes() {
    let lab = Lab::new();
    let dir = lab.repo("big", 1);
    // about 2 MB and 5 MB
    std::fs::write(dir.join("two.txt"), "a long line of text that repeats\n".repeat(60_000)).unwrap();
    std::fs::write(dir.join("five.txt"), "a long line of text that repeats\n".repeat(160_000)).unwrap();
    lab.sh(&dir, &["add", "."]);
    lab.sh(&dir, &["commit", "-q", "-m", "big"]);
    let git = lab.git();
    let d = s(&dir);
    // a diff-sized read keeps 1 MiB and says it is cut
    let diff = RunOptions { max_bytes: Some(DIFF_CAP), allow_truncate: true, ..git.read_options() };
    let out = git.run(&d, &["show", "HEAD:two.txt"], &diff).await.unwrap();
    assert!(out.truncated);
    assert_eq!(out.stdout.len(), DIFF_CAP);
    assert_eq!(out.code, 0);
    // without allowTruncate it is an error
    let strict = RunOptions { max_bytes: Some(DIFF_CAP), ..git.read_options() };
    let err = git.run(&d, &["show", "HEAD:two.txt"], &strict).await.unwrap_err();
    assert_eq!(err.code, GitErrorCode::TooLarge);
    assert_eq!(err.message, "Wynik polecenia git jest zbyt duży.");
    // the default read cap is 4 MiB
    let all = git.run(&d, &["show", "HEAD:two.txt"], &git.read_options()).await.unwrap();
    assert!(!all.truncated);
    assert_eq!(all.stdout.len(), 33 * 60_000);
    let err = git.run(&d, &["show", "HEAD:five.txt"], &git.read_options()).await.unwrap_err();
    assert_eq!(err.code, GitErrorCode::TooLarge);
    // a write is never stopped for its output: the excess is dropped and the exit code counts
    let small = Git::new(GitOptions { env: Some(lab.env.clone()), write_output_bytes: 1000, ..Default::default() });
    let out = small.run(&d, &["show", "HEAD:five.txt"], &RunOptions::write(Duration::from_secs(60))).await.unwrap();
    assert!(out.truncated);
    assert_eq!(out.stdout.len(), 1000);
    assert_eq!(out.code, 0);
}

#[tokio::test]
async fn answers_with_ok_codes_stdin_and_trimmed_failures() {
    let lab = Lab::new();
    let dir = lab.repo("codes", 1);
    let git = lab.git();
    let d = s(&dir);
    std::fs::write(dir.join("a.txt"), "a\n").unwrap();
    std::fs::write(dir.join("b.txt"), "b\n").unwrap();
    let no_index = ["diff", "--no-index", "--no-color", "--", "a.txt", "b.txt"];
    let out = git.run(&d, &no_index, &RunOptions { ok_codes: vec![1], ..git.read_options() }).await.unwrap();
    assert_eq!(out.code, 1);
    assert!(out.stdout.contains("+b"));
    // without the ok code the diff is a failure whose message is git's (trimmed) output
    let err = git.run(&d, &no_index, &git.read_options()).await.unwrap_err();
    assert_eq!(err.code, GitErrorCode::Failed);
    assert!(err.message.starts_with("diff --git"), "{}", err.message);
    // stdin
    let out = git
        .run(&d, &["hash-object", "--stdin"], &RunOptions { input: Some("hello\n".into()), ..git.read_options() })
        .await
        .unwrap();
    assert_eq!(out.stdout.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
    // an empty stdin, never a terminal
    let out = git.run(&d, &["hash-object", "--stdin"], &git.read_options()).await.unwrap();
    assert_eq!(out.stdout.trim(), "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
    // a failure keeps git's message without hint lines
    let err = git.run(&d, &["rev-parse", "--verify", "no-such-ref"], &git.read_options()).await.unwrap_err();
    assert_eq!(err.code, GitErrorCode::Failed);
    assert_eq!(err.message, "fatal: Needed a single revision");
}

#[tokio::test]
async fn never_prints_credentials_and_does_not_wait_for_a_prompt() {
    let lab = Lab::new();
    let dir = lab.repo("secrets", 1);
    lab.sh(&dir, &["remote", "add", "origin", "https://user:s3cr3t-token@127.0.0.1:1/nope.git"]);
    let git = lab.git();
    let started = Instant::now();
    let err = git.run(&s(&dir), &["fetch"], &RunOptions::write(git.options().network_timeout)).await.unwrap_err();
    assert_eq!(err.code, GitErrorCode::Failed);
    assert!(!err.message.contains("s3cr3t-token"), "{}", err.message);
    assert!(started.elapsed() < Duration::from_secs(15), "{:?}", started.elapsed());

    let dir = lab.repo("prompt", 1);
    lab.sh(&dir, &["remote", "add", "origin", "https://127.0.0.1:1/never.git"]);
    let started = Instant::now();
    assert!(git.run(&s(&dir), &["fetch"], &RunOptions::write(git.options().network_timeout)).await.is_err());
    assert!(started.elapsed() < Duration::from_secs(15), "{:?}", started.elapsed());
}

/// A git stand-in that answers the questions about places at once and hangs on everything else (git behind a dead network);
/// a `commit` leaves an `index.lock` behind first, like a write killed half way.
const SLOW_GIT: &str = r#"const a = process.argv; const path = require('path'); const fs = require('fs');
if (a.includes('--show-toplevel')) console.log(process.cwd());
else if (a.includes('--absolute-git-dir')) { console.log(path.join(process.cwd(), '.git')); console.log('.git'); }
else if (a.includes('config') || a.includes('worktree') || a.includes('rev-parse')) { /* nothing to say */ }
else { if (a.includes('commit')) fs.writeFileSync(path.join(process.cwd(), '.git', 'index.lock'), ''); setTimeout(() => process.stdout.write('late'), 20000); }
"#;

#[tokio::test]
async fn stops_a_slow_git_at_the_timeout_and_releases_the_lock_it_left() {
    if !node_available() {
        eprintln!("node is not installed: skipped");
        return;
    }
    let lab = Lab::new();
    let script = lab.dir.join("slow-git.js");
    std::fs::write(&script, SLOW_GIT).unwrap();
    let dir = lab.repo("slow", 1);
    let d = s(&dir);
    let stand_in = |read_ms: u64, network_ms: u64| {
        Git::new(GitOptions {
            bin: "node".into(),
            prefix_args: vec![script.clone().into_os_string()],
            env: Some(lab.env.clone()),
            read_timeout: Duration::from_millis(read_ms),
            network_timeout: Duration::from_millis(network_ms),
            ..Default::default()
        })
    };
    let slow = stand_in(400, 60_000);
    let started = Instant::now();
    let err = slow.run(&d, &["status", "--porcelain=v2"], &slow.read_options()).await.unwrap_err();
    assert_eq!(err.code, GitErrorCode::Timeout);
    assert_eq!(err.message, "Git nie odpowiedział w wyznaczonym czasie.");
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());

    let network = stand_in(5000, 300);
    let started = Instant::now();
    let err = network.run(&d, &["fetch"], &RunOptions::write(network.options().network_timeout)).await.unwrap_err();
    assert_eq!(err.code, GitErrorCode::Timeout);
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());

    // the places answer through the stand-in; a killed write releases the index.lock it left behind (the git directory is
    // known from the cache)
    assert!(same_path(&network.root(&d).await.unwrap(), &d));
    network.git_dirs(&d).await.unwrap();
    let lock = dir.join(".git").join("index.lock");
    let err = network.run(&d, &["commit", "-F", "-"], &RunOptions::write(Duration::from_millis(1500))).await.unwrap_err();
    assert_eq!(err.code, GitErrorCode::Timeout);
    assert!(!lock.exists(), "the stale lock is gone");
    // a killed read leaves any lock alone (it never takes one)
    std::fs::write(&lock, "").unwrap();
    let err = network.run(&d, &["commit"], &RunOptions::read(Duration::from_millis(1500))).await.unwrap_err();
    assert_eq!(err.code, GitErrorCode::Timeout);
    assert!(lock.exists());
}
