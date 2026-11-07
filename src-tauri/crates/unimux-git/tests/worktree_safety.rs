//! Safe worktree removal against a real temporary repository (port of test/worktree-safety.test.ts, PLAN G4): what would be
//! lost is counted, an unforced removal refuses (and removes nothing), a forced one removes the worktree and the unmerged
//! branch. The lab has its own git configuration (GIT_CONFIG_GLOBAL in the lab, no system configuration).

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use unimux_git::paths::realpath_native;
use unimux_git::{Git, GitOptions, Worktree, WorktreeInspection, WorktreeRemoveResult};

struct Lab {
    _tmp: tempfile::TempDir,
    dir: PathBuf,
    env: HashMap<OsString, OsString>,
}

impl Lab {
    fn new() -> Self {
        let tmp = tempfile::Builder::new().prefix("mc-wt-safety-").tempdir().unwrap();
        let dir = PathBuf::from(realpath_native(&tmp.path().to_string_lossy()).unwrap());
        let global = dir.join("global.gitconfig");
        std::fs::write(&global, "[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n").unwrap();
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

    fn git(&self) -> Git {
        Git::new(GitOptions { env: Some(self.env.clone()), ..Default::default() })
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

    fn repo(&self) -> PathBuf {
        let repo = self.dir.join("proj");
        std::fs::create_dir_all(&repo).unwrap();
        self.sh(&repo, &["init", "-q", "-b", "main", "."]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        self.sh(&repo, &["add", "."]);
        self.sh(&repo, &["commit", "-q", "-m", "first"]);
        repo
    }

    fn branch_exists(&self, repo: &Path, name: &str) -> bool {
        self.try_sh(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{name}")]).is_ok()
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap()
}

fn unsafe_inspection(r: WorktreeRemoveResult) -> WorktreeInspection {
    match r {
        WorktreeRemoveResult::Unsafe(i) => i,
        other => panic!("expected unsafe, got {other:?}"),
    }
}

#[test]
fn a_fresh_worktree_is_clean_removed_without_force_its_branch_deleted_with_d() {
    let lab = Lab::new();
    let repo = lab.repo();
    let git = lab.git();
    rt().block_on(async {
        let wt = git.create_worktree(&s(&repo), "clean").await.unwrap();
        assert_eq!(wt.path, s(&lab.dir.join("proj-wt-clean")));
        assert_eq!(wt.branch, "mc/clean");
        assert_eq!(git.current_branch(&wt.path).await.as_deref(), Some("mc/clean"));
        let i = git.inspect_worktree(&s(&repo), &wt).await.unwrap();
        assert!(i.exists);
        assert_eq!((i.dirty, i.unmerged, i.detached, i.base.as_str()), (0, 0, 0, "main"));
        assert_eq!(git.remove_worktree(&s(&repo), &wt, true, None).await, WorktreeRemoveResult::Ok);
        assert!(!Path::new(&wt.path).exists());
        assert!(!lab.branch_exists(&repo, "mc/clean"));
        assert!(git.is_git_repo(&s(&repo)).await);
        assert!(!git.is_git_repo(&s(&lab.dir.join("home"))).await);
        assert!(!git.is_git_repo(&s(&lab.dir.join("missing"))).await);
    });
}

#[test]
fn collisions_with_a_folder_or_a_branch_get_a_number() {
    let lab = Lab::new();
    let repo = lab.repo();
    let git = lab.git();
    std::fs::create_dir_all(lab.dir.join("proj-wt-taken")).unwrap();
    lab.sh(&repo, &["branch", "mc/taken-2"]);
    rt().block_on(async {
        let wt = git.create_worktree(&s(&repo), "Taken").await.unwrap();
        assert_eq!(wt.path, s(&lab.dir.join("proj-wt-taken-3")));
        assert_eq!(wt.branch, "mc/taken-3");
    });
}

#[test]
fn counts_uncommitted_files_and_commits_the_project_branch_lacks_unforced_removal_refuses_and_keeps_everything() {
    let lab = Lab::new();
    let repo = lab.repo();
    let git = lab.git();
    rt().block_on(async {
        let wt = git.create_worktree(&s(&repo), "busy").await.unwrap();
        let p = PathBuf::from(&wt.path);
        std::fs::write(p.join("b.txt"), "two\n").unwrap();
        lab.sh(&p, &["add", "b.txt"]);
        lab.sh(&p, &["commit", "-q", "-m", "unmerged work"]);
        std::fs::write(p.join("a.txt"), "changed\n").unwrap(); // unstaged
        std::fs::write(p.join("c.txt"), "staged\n").unwrap();
        lab.sh(&p, &["add", "c.txt"]); // staged
        std::fs::write(p.join("d.txt"), "untracked\n").unwrap();
        std::fs::write(p.join("e.txt"), "untracked\n").unwrap();
        let info = git.inspect_worktree(&s(&repo), &wt).await.unwrap();
        assert_eq!((info.exists, info.dirty, info.unmerged, info.detached, info.base.as_str()), (true, 4, 1, 0, "main"));

        let refused = unsafe_inspection(git.remove_worktree(&s(&repo), &wt, true, None).await);
        assert_eq!(refused, info);
        assert!(p.join("d.txt").exists());
        assert!(lab.branch_exists(&repo, "mc/busy"));

        // Committed and merged into main: nothing is lost any more.
        lab.sh(&p, &["add", "-A"]);
        lab.sh(&p, &["commit", "-q", "-m", "rest"]);
        let i = git.inspect_worktree(&s(&repo), &wt).await.unwrap();
        assert_eq!((i.dirty, i.unmerged), (0, 2));
        lab.sh(&repo, &["merge", "-q", "--ff-only", "mc/busy"]);
        let i = git.inspect_worktree(&s(&repo), &wt).await.unwrap();
        assert_eq!((i.dirty, i.unmerged), (0, 0));
        assert_eq!(git.remove_worktree(&s(&repo), &wt, true, None).await, WorktreeRemoveResult::Ok);
        assert!(!lab.branch_exists(&repo, "mc/busy"));
    });
}

#[test]
fn a_forced_removal_drops_the_dirty_worktree_and_the_unmerged_branch() {
    let lab = Lab::new();
    let repo = lab.repo();
    let git = lab.git();
    rt().block_on(async {
        let wt = git.create_worktree(&s(&repo), "lost").await.unwrap();
        let p = PathBuf::from(&wt.path);
        std::fs::write(p.join("x.txt"), "x\n").unwrap();
        lab.sh(&p, &["add", "x.txt"]);
        lab.sh(&p, &["commit", "-q", "-m", "only here"]);
        std::fs::write(p.join("y.txt"), "y\n").unwrap();
        let confirmed = git.inspect_worktree(&s(&repo), &wt).await.unwrap();
        assert_eq!((confirmed.dirty, confirmed.unmerged), (1, 1));
        assert_eq!(git.remove_worktree(&s(&repo), &wt, true, Some(&confirmed)).await, WorktreeRemoveResult::Ok);
        assert!(!p.exists());
        assert!(!lab.branch_exists(&repo, "mc/lost"));
    });
}

#[test]
fn work_that_grew_after_the_confirmation_refuses_the_forced_removal_with_the_new_numbers() {
    let lab = Lab::new();
    let repo = lab.repo();
    let git = lab.git();
    rt().block_on(async {
        let wt = git.create_worktree(&s(&repo), "grow").await.unwrap();
        let p = PathBuf::from(&wt.path);
        std::fs::write(p.join("one.txt"), "1\n").unwrap();
        let confirmed = git.inspect_worktree(&s(&repo), &wt).await.unwrap();
        assert_eq!((confirmed.dirty, confirmed.unmerged), (1, 0));
        std::fs::write(p.join("two.txt"), "2\n").unwrap(); // the agent kept writing while the dialog was open
        let more = unsafe_inspection(git.remove_worktree(&s(&repo), &wt, true, Some(&confirmed)).await);
        assert_eq!((more.dirty, more.unmerged), (2, 0));
        assert!(p.join("two.txt").exists());

        // Same counts but a new commit: the branch tip moved, so it asks again too.
        lab.sh(&p, &["add", "one.txt"]);
        lab.sh(&p, &["commit", "-q", "-m", "agent commit"]);
        std::fs::write(p.join("three.txt"), "3\n").unwrap();
        let moved = unsafe_inspection(git.remove_worktree(&s(&repo), &wt, true, Some(&more)).await);
        assert_eq!((moved.dirty, moved.unmerged), (2, 1));
        assert!(lab.branch_exists(&repo, "mc/grow"));

        // Accepting exactly what is there now removes it.
        assert_eq!(git.remove_worktree(&s(&repo), &wt, true, Some(&moved)).await, WorktreeRemoveResult::Ok);
        assert!(!p.exists());
        assert!(!lab.branch_exists(&repo, "mc/grow"));
    });
}

#[test]
fn commits_on_a_detached_head_count_as_lost_work_the_unforced_removal_refuses() {
    let lab = Lab::new();
    let repo = lab.repo();
    let git = lab.git();
    rt().block_on(async {
        let wt = git.create_worktree(&s(&repo), "detached").await.unwrap();
        let p = PathBuf::from(&wt.path);
        lab.sh(&p, &["checkout", "-q", "--detach"]);
        std::fs::write(p.join("det.txt"), "detached\n").unwrap();
        lab.sh(&p, &["add", "det.txt"]);
        lab.sh(&p, &["commit", "-q", "-m", "on no branch"]);
        let lost_head = lab.sh(&p, &["rev-parse", "HEAD"]).trim().to_string();
        let info = git.inspect_worktree(&s(&repo), &wt).await.unwrap();
        assert_eq!((info.dirty, info.unmerged, info.detached), (0, 0, 1));
        assert_eq!(info.head, lost_head);
        assert_eq!(unsafe_inspection(git.remove_worktree(&s(&repo), &wt, true, None).await).detached, 1);
        assert!(p.exists());
        assert_eq!(git.remove_worktree(&s(&repo), &wt, true, Some(&info)).await, WorktreeRemoveResult::Ok);
        assert!(!p.exists());
    });
}

#[test]
fn never_deletes_a_branch_unimux_did_not_create_an_adopted_worktree_or_a_branch_outside_mc() {
    let lab = Lab::new();
    let repo = lab.repo();
    let git = lab.git();
    rt().block_on(async {
        let adopted = lab.dir.join("proj-wt-feature");
        lab.sh(&repo, &["worktree", "add", "-q", "-b", "feature-x", &s(&adopted), "HEAD"]);
        lab.sh(&adopted, &["commit", "-q", "--allow-empty", "-m", "user work"]);
        // Its commit is on feature-x, which stays: nothing is lost, so no confirmation is needed.
        let wt = Worktree { path: s(&adopted), branch: "feature-x".into(), adopted: Some(true) };
        assert_eq!(git.remove_worktree(&s(&repo), &wt, true, None).await, WorktreeRemoveResult::Ok);
        assert!(!adopted.exists());
        assert!(lab.branch_exists(&repo, "feature-x"));

        let cell = git.create_worktree(&s(&repo), "joined").await.unwrap();
        let joined = Worktree { adopted: Some(true), ..cell };
        assert_eq!(git.remove_worktree(&s(&repo), &joined, true, None).await, WorktreeRemoveResult::Ok);
        assert!(lab.branch_exists(&repo, "mc/joined"));
        let plain = lab.dir.join("proj-wt-plain");
        lab.sh(&repo, &["worktree", "add", "-q", "-b", "plain", &s(&plain), "HEAD"]);
        let wt = Worktree { path: s(&plain), branch: "plain".into(), adopted: None };
        assert_eq!(git.remove_worktree(&s(&repo), &wt, true, None).await, WorktreeRemoveResult::Ok);
        assert!(lab.branch_exists(&repo, "plain"));
    });
}

#[test]
fn keeping_the_branch_only_refuses_for_uncommitted_files_a_folder_deleted_by_hand_drops_only_its_own_registration() {
    let lab = Lab::new();
    let repo = lab.repo();
    let git = lab.git();
    rt().block_on(async {
        let wt = git.create_worktree(&s(&repo), "keep").await.unwrap();
        lab.sh(Path::new(&wt.path), &["commit", "-q", "--allow-empty", "-m", "kept commit"]);
        assert_eq!(git.remove_worktree(&s(&repo), &wt, false, None).await, WorktreeRemoveResult::Ok);
        assert!(lab.branch_exists(&repo, "mc/keep"));

        let gone = git.create_worktree(&s(&repo), "gone").await.unwrap();
        let other = git.create_worktree(&s(&repo), "unplugged").await.unwrap(); // a folder only temporarily away
        std::fs::remove_dir_all(&gone.path).unwrap();
        std::fs::remove_dir_all(&other.path).unwrap();
        let i = git.inspect_worktree(&s(&repo), &gone).await.unwrap();
        assert_eq!((i.exists, i.dirty, i.unmerged, i.detached), (false, 0, 0, 0));
        assert_eq!(git.remove_worktree(&s(&repo), &gone, true, None).await, WorktreeRemoveResult::Ok);
        assert!(!lab.branch_exists(&repo, "mc/gone"));
        let list = lab.sh(&repo, &["worktree", "list"]);
        assert!(!list.contains("proj-wt-gone"), "{list}");
        assert!(list.contains("proj-wt-unplugged"), "{list}");
    });
}

#[test]
fn a_failed_inspection_is_failed_and_a_failed_creation_says_why() {
    let lab = Lab::new();
    let git = lab.git();
    let not_repo = lab.dir.join("home");
    rt().block_on(async {
        let wt = Worktree { path: s(&not_repo), branch: "mc/x".into(), adopted: None };
        assert!(matches!(git.remove_worktree(&s(&not_repo), &wt, true, None).await, WorktreeRemoveResult::Failed(_)));
        let err = git.create_worktree(&s(&not_repo), "x").await.unwrap_err();
        assert!(!err.is_empty() && !err.contains('\u{2014}'), "{err}");
    });
}

#[test]
fn init_makes_a_repository_on_main() {
    let lab = Lab::new();
    let git = lab.git();
    let folder = lab.dir.join("fresh");
    std::fs::create_dir_all(&folder).unwrap();
    rt().block_on(async {
        assert_eq!(git.probe(&s(&folder)).await, unimux_git::GitProbe::NoRepo);
        let message = git.init_repo(&s(&folder)).await.unwrap();
        assert!(message.contains("Initialized"), "{message}");
        assert_eq!(git.probe(&s(&folder)).await, unimux_git::GitProbe::Repo);
        assert_eq!(lab.sh(&folder, &["symbolic-ref", "--short", "HEAD"]).trim(), "main");
    });
}

/// Windows: a project reached through a short (8.3) path. git lists its worktrees under the long name, so a folder deleted
/// by hand must still be found and only its registration dropped.
#[cfg(windows)]
#[test]
fn finds_a_removed_folder_under_its_long_name_when_the_project_path_is_a_short_8_3_path() {
    let lab = Lab::new();
    let long_lab = lab.dir.join("mc wt long name folder");
    std::fs::create_dir_all(&long_lab).unwrap();
    let Some(short) = short_path(&long_lab) else { return };
    if short.eq_ignore_ascii_case(&s(&long_lab)) {
        return; // 8.3 names are off on this volume
    }
    let long_repo = long_lab.join("proj");
    std::fs::create_dir_all(&long_repo).unwrap();
    lab.sh(&long_repo, &["init", "-q", "-b", "main", "."]);
    std::fs::write(long_repo.join("a.txt"), "one\n").unwrap();
    lab.sh(&long_repo, &["add", "."]);
    lab.sh(&long_repo, &["commit", "-q", "-m", "first"]);
    let short_repo = format!("{short}\\proj");
    let git = lab.git();
    rt().block_on(async {
        let wt = git.create_worktree(&short_repo, "gone").await.unwrap();
        std::fs::remove_dir_all(&wt.path).unwrap();
        assert_eq!(git.remove_worktree(&short_repo, &wt, true, None).await, WorktreeRemoveResult::Ok);
        assert!(!lab.sh(&long_repo, &["worktree", "list"]).contains("proj-wt-gone"));
    });
}

#[cfg(windows)]
fn short_path(path: &Path) -> Option<String> {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetShortPathNameW(long: *const u16, short: *mut u16, len: u32) -> u32;
    }
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
    let mut buf = vec![0u16; 1024];
    // SAFETY: `wide` is NUL-terminated, `buf` holds `buf.len()` units.
    let n = unsafe { GetShortPathNameW(wide.as_ptr(), buf.as_mut_ptr(), buf.len() as u32) } as usize;
    (n > 0 && n < buf.len()).then(|| OsString::from_wide(&buf[..n]).to_string_lossy().into_owned())
}
