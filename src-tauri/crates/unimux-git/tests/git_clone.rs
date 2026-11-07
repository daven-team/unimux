//! "Clone a repository" (port of test/git-clone.test.ts, PLAN G4): the address check, the folder name it suggests, the request
//! check, and `Git::clone_repo` with a stand-in git (a Node script, no network) that records what it was started with. The
//! stand-in cases are skipped when Node is missing.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};

use serde_json::{Value, json};
use unimux_git::clone::{NOT_EMPTY, RemoteAuth};
use unimux_git::paths::realpath_native;
use unimux_git::shared::{
    GitCloneRequest, clone_folder_name, is_clone_url, is_safe_folder_name, is_safe_folder_name_str, validate_clone_request,
};
use unimux_git::{Git, GitErrorCode, GitOptions};

#[test]
fn accepts_https_ssh_and_the_scp_form() {
    for ok in [
        "https://github.com/octocat/Hello-World.git",
        "https://gitlab.example.com/group/sub/repo",
        "https://host:8443/a/b.git",
        "ssh://git@github.com/owner/repo.git",
        "ssh://host:2222/srv/repo.git",
        "git@github.com:owner/repo.git",
        "me@my-host.local:/srv/git/x.git",
    ] {
        assert!(is_clone_url(&json!(ok)), "{ok}");
    }
}

#[test]
fn refuses_other_transports_options_local_paths_credentials_and_odd_characters() {
    let long = format!("https://github.com/{}", "a".repeat(2001));
    for bad in [
        "ext::sh -c touch% /tmp/pwned",
        "file:///etc/repo",
        "http://example.com/repo.git",
        "-uhttps://github.com/a/b",
        "--upload-pack=x",
        "C:\\repos\\a",
        "/srv/git/a.git",
        "../a",
        "https://user:pass@github.com/a/b.git",
        "https://tok@github.com/a/b.git",
        "https://github.com/a b",
        "https://github.com/a\nb",
        "https://github.com/a\tb",
        "https://github.com/a\0b",
        "https://github.com/",
        "git@host:-oProxyCommand=x",
        "git@-host:a",
        "ssh://-oProxyCommand=x/a",
        "ssh://user:pw@host/a",
        "fd::17",
        "github.com:a/b",
        "",
        long.as_str(),
    ] {
        assert!(!is_clone_url(&json!(bad)), "{bad:?}");
    }
    for bad in [json!(42), Value::Null] {
        assert!(!is_clone_url(&bad));
    }
}

#[test]
fn suggests_the_folder_name_git_would_use() {
    assert_eq!(clone_folder_name("https://github.com/octocat/Hello-World.git"), "Hello-World");
    assert_eq!(clone_folder_name("https://gitlab.com/group/sub/repo/"), "repo");
    assert_eq!(clone_folder_name("git@github.com:owner/tool.GIT"), "tool");
    assert_eq!(clone_folder_name("git@host:project.git"), "project");
    assert_eq!(clone_folder_name("ssh://host/srv/con.git"), "con-repo");
    assert_eq!(clone_folder_name("https://host/a/.git"), "repo");
    assert_eq!(clone_folder_name("https://host/a/b.c.."), "b.c");
    for url in ["https://github.com/octocat/Hello-World.git", "git@h:x/y z.git", "https://h/a/con"] {
        assert!(is_safe_folder_name_str(&clone_folder_name(url)), "{url}");
    }
}

#[test]
fn checks_a_single_folder_name() {
    for ok in ["repo", "Hello-World", "my.repo", "a b"] {
        assert!(is_safe_folder_name_str(ok), "{ok}");
    }
    let long = "a".repeat(101);
    for bad in ["", ".", "..", "a/b", "a\\b", "a:b", "nul", "COM1", "aux.txt", "x.", "x ", "-x", "a*b", long.as_str()] {
        assert!(!is_safe_folder_name_str(bad), "{bad}");
    }
    assert!(!is_safe_folder_name(&json!(1)));
}

#[test]
fn validates_a_request_for_a_project_folder_or_a_new_folder() {
    let url = "https://github.com/octocat/Hello-World.git";
    assert_eq!(
        validate_clone_request(&json!({ "url": url, "projectId": "p1", "extra": 1 })),
        Ok(GitCloneRequest::Project { url: url.into(), project_id: "p1".into() })
    );
    assert_eq!(
        validate_clone_request(&json!({ "url": url, "parent": "C:\\code", "name": "Hello-World" })),
        Ok(GitCloneRequest::Folder { url: url.into(), parent: "C:\\code".into(), name: "Hello-World".into() })
    );
    assert!(validate_clone_request(&json!({ "url": url, "parent": "/home/me/code", "name": "x" })).is_ok());
    assert_eq!(
        validate_clone_request(&json!({ "url": "ext::x", "projectId": "p1" })),
        Err("Podaj adres repozytorium: https://…, ssh://… albo git@host:ścieżka.".into())
    );
    for bad in [
        Value::Null,
        json!("x"),
        json!({ "url": url }),
        json!({ "url": url, "parent": "relative", "name": "x" }),
        json!({ "url": url, "parent": "/a", "name": "../x" }),
        json!({ "url": url, "parent": "/a\nb", "name": "x" }),
        json!({ "url": url, "parent": "/a", "name": "" }),
    ] {
        assert!(validate_clone_request(&bad).is_err(), "{bad}");
    }
}

// ---------- Git::clone_repo with a stand-in git ----------

const FAKE_GIT: &str = r#"const fs = require('fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify({ args, cwd: process.cwd(), header: process.env.GIT_CONFIG_KEY_0 || null }));
if (args.some((a) => a.includes('fail'))) { process.stderr.write('fatal: repository not found'); process.exit(128); }
fs.mkdirSync('.git'); process.stderr.write("Cloning into '.'...\n");
"#;

struct CloneLab {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    log: PathBuf,
    script: PathBuf,
}

impl CloneLab {
    fn new() -> Option<Self> {
        let node = Command::new("node").arg("--version").stdin(Stdio::null()).output();
        if !node.is_ok_and(|o| o.status.success()) {
            eprintln!("Node is missing: the stand-in git cases are skipped");
            return None;
        }
        let tmp = tempfile::Builder::new().prefix("mc-clone-").tempdir().unwrap();
        let dir = PathBuf::from(realpath_native(&tmp.path().to_string_lossy()).unwrap());
        let script = dir.join("fake-git.cjs");
        std::fs::write(&script, FAKE_GIT).unwrap();
        Some(CloneLab { log: dir.join("log.json"), _tmp: tmp, dir, script })
    }

    fn git(&self) -> Git {
        let mut env: HashMap<OsString, OsString> = std::env::vars_os().collect();
        env.insert("FAKE_LOG".into(), self.log.as_os_str().to_owned());
        Git::new(GitOptions {
            bin: PathBuf::from("node"),
            prefix_args: vec![self.script.as_os_str().to_owned()],
            env: Some(env),
            ..Default::default()
        })
    }

    fn last(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(&self.log).unwrap()).unwrap()
    }
}

struct FakeAuth {
    env: Vec<(String, String)>,
    refused: AtomicUsize,
}

impl FakeAuth {
    fn new(key: &str) -> Self {
        let env = vec![
            ("GIT_CONFIG_COUNT".to_string(), "1".to_string()),
            ("GIT_CONFIG_KEY_0".to_string(), key.to_string()),
            ("GIT_CONFIG_VALUE_0".to_string(), "x".to_string()),
        ];
        FakeAuth { env, refused: AtomicUsize::new(0) }
    }
}

impl RemoteAuth for FakeAuth {
    fn env(&self) -> Option<Vec<(String, String)>> {
        Some(self.env.clone())
    }
    fn auth_refused(&self, message: &str) -> bool {
        message.contains("not found")
    }
    fn token_refused(&self, _message: &str) -> bool {
        false
    }
    fn refused(&self) {
        self.refused.fetch_add(1, Ordering::SeqCst);
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[tokio::test]
async fn clones_into_a_new_folder_with_dashdash_before_the_address_and_ext_off_the_github_sign_in_for_github_com_only() {
    let Some(lab) = CloneLab::new() else { return };
    let target = lab.dir.join("one");
    let auth = FakeAuth::new("http.https://github.com/.extraheader");
    let result = lab.git().clone_repo(&s(&target), "https://github.com/octocat/Hello-World.git", Some(&auth)).await;
    assert!(result.is_ok(), "{result:?}");
    let run = lab.last();
    let args: Vec<String> = run["args"].as_array().unwrap().iter().map(|a| a.as_str().unwrap().to_string()).collect();
    assert_eq!(args[args.len() - 4..], ["clone", "--", "https://github.com/octocat/Hello-World.git", "."]);
    assert!(args.join(" ").contains("protocol.ext.allow=never"));
    assert_eq!(realpath_native(run["cwd"].as_str().unwrap()), realpath_native(&s(&target)));
    assert_eq!(run["header"], "http.https://github.com/.extraheader");
    assert!(target.join(".git").exists());

    let other = lab.dir.join("two");
    let auth = FakeAuth::new("h");
    assert!(lab.git().clone_repo(&s(&other), "https://gitlab.com/a/b.git", Some(&auth)).await.is_ok());
    assert_eq!(lab.last()["header"], Value::Null);
}

#[tokio::test]
async fn clones_into_an_existing_empty_folder_and_refuses_one_that_has_files() {
    let Some(lab) = CloneLab::new() else { return };
    let empty = lab.dir.join("empty");
    std::fs::create_dir(&empty).unwrap();
    assert!(lab.git().clone_repo(&s(&empty), "git@github.com:a/b.git", None).await.is_ok());
    let full = lab.dir.join("full");
    std::fs::create_dir(&full).unwrap();
    std::fs::write(full.join("note.txt"), "x").unwrap();
    let refused = lab.git().clone_repo(&s(&full), "git@github.com:a/b.git", None).await.unwrap_err();
    assert_eq!(refused.code, GitErrorCode::Invalid);
    assert_eq!(refused.message, NOT_EMPTY);
}

#[tokio::test]
async fn removes_the_folder_it_made_when_the_clone_fails_and_refuses_a_bad_address_before_git_runs() {
    let Some(lab) = CloneLab::new() else { return };
    let target = lab.dir.join("failed");
    let auth = FakeAuth::new("http.https://github.com/.extraheader");
    // GitHub "refuses" the sign-in: the clone runs a second time without it, then fails for real.
    let failed = lab.git().clone_repo(&s(&target), "https://github.com/a/fail.git", Some(&auth)).await;
    assert!(failed.is_err());
    assert_eq!(lab.last()["header"], Value::Null, "the second run goes without the sign-in");
    assert!(!target.exists());
    std::fs::remove_file(&lab.log).unwrap();
    let bad = lab.git().clone_repo(&s(&lab.dir.join("bad")), "ext::sh -c x", None).await.unwrap_err();
    assert_eq!(bad.code, GitErrorCode::Invalid);
    assert!(!lab.log.exists());
    assert!(!lab.dir.join("bad").exists());
}
