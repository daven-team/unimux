//! The trust model against REAL git (PLAN G2 acceptance): the trust cases of test/git-trust.test.ts on a hostile repository
//! whose configuration names marker-writing programs, and the comparison with 1.1.4: the same repositories are scanned and
//! trusted by src/main/git.ts (scripts/git-trust-golden.mjs) and by the Rust port, and the keys, the fingerprint hashes and
//! the git-trust.json bytes must be identical (each side also reads the other's file as trusted).
//!
//! The lab has its own configuration (GIT_CONFIG_GLOBAL in the lab, GIT_CONFIG_NOSYSTEM=1, HOME in the lab). The marker
//! programs are Node scripts (like the TS test); without Node the "nothing was started" checks still run (the programs then
//! cannot start at all) and the TS comparison is skipped with a note. Nothing here opens a window.

use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use serde_json::{Value, json};
use unimux_exec::{ExecOptions, Program};
use unimux_git::handler::handle_git;
use unimux_git::paths::{canonical_path, realpath_native};
use unimux_git::{Git, GitErrorCode, GitOptions, TrustState};

static COUNTER: AtomicU32 = AtomicU32::new(0);

fn id() -> String {
    format!("req-{:06}-trst", COUNTER.fetch_add(1, Ordering::Relaxed) + 1)
}

fn slash(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/")
}

fn repo_root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..")
}

fn node() -> Option<PathBuf> {
    let out = Command::new("node").args(["-e", "process.stdout.write(process.execPath)"]).stdin(Stdio::null()).output().ok()?;
    out.status.success().then(|| PathBuf::from(String::from_utf8_lossy(&out.stdout).into_owned()))
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
        let tmp = tempfile::Builder::new().prefix("mc-trust-rs-").tempdir().unwrap();
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

    fn git(&self, trust_file: Option<PathBuf>) -> Arc<Git> {
        Arc::new(Git::new(GitOptions { env: Some(self.env.clone()), trust_file, ..Default::default() }))
    }

    fn git_with(&self, env: HashMap<OsString, OsString>) -> Arc<Git> {
        Arc::new(Git::new(GitOptions { env: Some(env), ..Default::default() }))
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

    /// The command a configuration key runs: node writes its name into the marker file.
    fn program(&self, name: &str) -> String {
        let node = self.node.as_deref().map(slash).unwrap_or_else(|| "/no/node/here".into());
        format!("\"{node}\" \"{}\" {name}", slash(&self.dir.join("mark.js")))
    }

    fn markers(&self) -> Vec<String> {
        std::fs::read_to_string(&self.marker).unwrap_or_default().lines().filter(|l| !l.is_empty()).map(str::to_string).collect()
    }

    fn write_hook(&self, dir: &Path, hook: &str, body: &str) {
        let hooks = dir.join(".git").join("hooks");
        std::fs::create_dir_all(&hooks).unwrap();
        let file = hooks.join(hook);
        std::fs::write(&file, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
    }

    /// A repository with a bare remote and a first commit, then every dangerous thing a hostile repository can carry.
    fn hostile(&self, name: &str) -> PathBuf {
        let bare = self.dir.join(format!("{name}.git"));
        self.sh(&self.dir, &["init", "-q", "--bare", "-b", "main", &bare.to_string_lossy()]);
        let dir = self.dir.join(name);
        self.sh(&self.dir, &["clone", "-q", &bare.to_string_lossy(), &dir.to_string_lossy()]);
        std::fs::write(dir.join("a.txt"), "one\n").unwrap();
        std::fs::write(dir.join("data.dat"), "binary-ish\n").unwrap();
        std::fs::write(dir.join(".gitattributes"), "*.txt filter=mark\n*.dat diff=mark\n").unwrap();
        self.sh(&dir, &["add", "."]);
        self.sh(&dir, &["commit", "-q", "-m", "first"]);
        self.sh(&dir, &["push", "-q", "origin", "main"]);
        let _ = std::fs::remove_file(&self.marker);
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
        for hook in
            ["pre-commit", "post-commit", "post-checkout", "post-index-change", "reference-transaction", "pre-push", "post-merge"]
        {
            self.write_hook(&dir, hook, &format!("#!/bin/sh\n{}\nexit 0\n", self.program(&format!("hook-{hook}"))));
        }
        dir
    }

    fn quiet(&self, name: &str) -> PathBuf {
        let dir = self.dir.join(name);
        std::fs::create_dir_all(&dir).unwrap();
        self.sh(&dir, &["init", "-q", "-b", "main", "."]);
        dir
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn lists_what_can_start_a_program_without_starting_any_of_it() {
    let lab = Lab::new();
    let dir = lab.hostile("listing");
    let git = lab.git(None);
    let info = git.trust_info(&s(&dir), None, false).await.unwrap();
    assert_eq!(info.state, TrustState::Untrusted);
    let lower: Vec<String> = info.keys.iter().map(|k| k.to_lowercase()).collect();
    for key in [
        "core.fsmonitor",
        "filter.mark.clean",
        "filter.mark.smudge",
        "diff.mark.textconv",
        "diff.external",
        "core.pager",
        "pager.log",
        "remote.origin.uploadpack",
        "remote.origin.receivepack",
        "core.sshCommand",
        "credential.helper",
        "include.path",
        "hooks/pre-commit",
        "hooks/post-commit",
        "hooks/pre-push",
        "hooks/reference-transaction",
    ] {
        assert!(lower.contains(&key.to_lowercase()), "{key} in {:?}", info.keys);
    }
    assert!(!info.keys.contains(&"alias.boom".to_string()), "git never runs an alias on its own");
    assert!(!serde_json::to_string(&info).unwrap().contains("mark.js"), "values are not shown");
    assert!(lab.markers().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn cannot_be_trusted_by_a_flag_on_an_ordinary_call_only_by_the_dedicated_request() {
    let lab = Lab::new();
    let dir = lab.hostile("flag");
    let git = lab.git(None);
    let call = |channel: &'static str, input: Value| {
        let git = git.clone();
        let dir = s(&dir);
        async move { handle_git(&git, Some(&dir), channel, &input, cfg!(windows), &[]).await }
    };
    // the status / commit refusals of the TS case are G3's channels; the trust channels with a flag:
    assert_eq!(call("trust", json!({ "trusted": true })).await.unwrap()["state"], "untrusted");
    assert_eq!(call("trustGrant", json!({})).await.unwrap_err().code, GitErrorCode::Invalid);
    assert_eq!(call("trustGrant", json!({ "requestId": "short" })).await.unwrap_err().code, GitErrorCode::Invalid);
    assert_eq!(call("trust", json!({})).await.unwrap()["state"], "untrusted");
    let rid = id();
    assert_eq!(call("trustGrant", json!({ "requestId": rid })).await.unwrap()["state"], "trusted");
    let again = call("trustGrant", json!({ "requestId": rid })).await.unwrap_err();
    assert_eq!((again.code, again.message.as_str()), (GitErrorCode::Invalid, unimux_git::ALREADY_DONE), "one use per id");
    assert!(lab.markers().is_empty(), "granting trust starts nothing by itself");
    assert_eq!(call("nonsense", json!({})).await.unwrap_err().code, GitErrorCode::Invalid);
    let gone = handle_git(&git, None, "trust", &json!({}), false, &[]).await.unwrap_err();
    assert_eq!((gone.code, gone.message.as_str()), (GitErrorCode::Gone, unimux_git::handler::GONE));
}

#[tokio::test(flavor = "multi_thread")]
async fn asks_again_when_the_configuration_or_a_hook_changes_and_remembers_the_answer_across_restarts() {
    let lab = Lab::new();
    let dir = lab.hostile("changes");
    let d = s(&dir);
    let trust_file = lab.dir.join("trust-store").join("git-trust.json");
    let first = lab.git(Some(trust_file.clone()));
    assert_eq!(first.grant_trust(&d, &id(), None).await.unwrap().state, TrustState::Trusted);
    let again = lab.git(Some(trust_file.clone()));
    assert_eq!(again.trust_info(&d, None, false).await.unwrap().state, TrustState::Trusted);
    lab.sh(&dir, &["config", "core.sshCommand", &lab.program("ssh-changed")]);
    assert_eq!(again.trust_info(&d, None, false).await.unwrap().state, TrustState::Untrusted);
    let root = again.root(&d).await.unwrap();
    let refused = again.require_trust(&root, true).await.unwrap_err();
    assert_eq!(refused.code, GitErrorCode::Untrusted);
    again.grant_trust(&d, &id(), None).await.unwrap();
    assert_eq!(again.trust_info(&d, None, false).await.unwrap().state, TrustState::Trusted);
    std::fs::write(
        dir.join(".git").join("hooks").join("pre-commit"),
        format!("#!/bin/sh\n{}\nexit 0\n", lab.program("hook-changed")),
    )
    .unwrap();
    assert_eq!(again.trust_info(&d, None, false).await.unwrap().state, TrustState::Untrusted);
    again.grant_trust(&d, &id(), None).await.unwrap();
    again.revoke_trust(&d, &id(), None).await.unwrap();
    assert_eq!(again.trust_info(&d, None, false).await.unwrap().state, TrustState::Untrusted);
    assert_eq!(lab.git(Some(trust_file.clone())).trust_info(&d, None, false).await.unwrap().state, TrustState::Untrusted);
    // the file is keyed by the canonical root and holds nothing after the revoke
    assert_eq!(std::fs::read_to_string(&trust_file).unwrap(), "{}");
    assert!(lab.markers().is_empty());
}

#[tokio::test(flavor = "multi_thread")]
async fn treats_a_repository_without_risky_configuration_as_safe() {
    let lab = Lab::new();
    let dir = lab.quiet("quiet");
    std::fs::write(dir.join("a.txt"), "a\n").unwrap();
    lab.sh(&dir, &["add", "."]);
    lab.sh(&dir, &["commit", "-q", "-m", "one"]);
    let git = lab.git(None);
    let info = git.trust_info(&s(&dir), Some(&s(&dir)), false).await.unwrap();
    assert_eq!((info.state, info.keys.len(), info.parent), (TrustState::Safe, 0, false));
    let root = git.root(&s(&dir)).await.unwrap();
    git.require_trust(&root, true).await.unwrap(); // the status call itself is G3
    // granting a safe repository stores nothing
    let file = lab.dir.join("safe-trust.json");
    let store = lab.git(Some(file.clone()));
    assert_eq!(store.grant_trust(&s(&dir), &id(), None).await.unwrap().state, TrustState::Safe);
    assert!(!file.exists());
}

#[tokio::test(flavor = "multi_thread")]
async fn picks_up_a_hostile_gitattributes_that_names_a_driver_defined_outside_the_repository() {
    let lab = Lab::new();
    let dir = lab.quiet("attributes");
    std::fs::write(dir.join(".gitattributes"), "*.png filter=lfs\n").unwrap();
    let global = lab.dir.join("driver.gitconfig");
    std::fs::write(&global, "[user]\n\tname = T\n\temail = t@example.com\n[filter \"lfs\"]\n\tclean = git-lfs clean -- %f\n")
        .unwrap();
    let mut env = lab.env.clone();
    env.retain(|k, _| !k.to_string_lossy().eq_ignore_ascii_case("GIT_CONFIG_GLOBAL"));
    env.insert("GIT_CONFIG_GLOBAL".into(), global.into_os_string());
    let with_driver = lab.git_with(env);
    let info = with_driver.trust_info(&s(&dir), None, false).await.unwrap();
    assert_eq!(info.state, TrustState::Untrusted);
    assert_eq!(info.keys, [".gitattributes: filter=lfs"]);
    assert_eq!(
        lab.git(None).trust_info(&s(&dir), None, false).await.unwrap().state,
        TrustState::Safe,
        "no such driver for this user"
    );
}

#[tokio::test(flavor = "multi_thread")]
async fn refuses_writes_in_a_repository_that_is_larger_than_the_project_and_says_so() {
    let lab = Lab::new();
    let dir = lab.quiet("parentrepo");
    let project = dir.join("packages").join("app");
    std::fs::create_dir_all(&project).unwrap();
    let git = lab.git(None);
    // the trust part of the TS case (status and the refused writes are G3)
    let info = handle_git(&git, Some(&s(&project)), "trust", &json!({}), cfg!(windows), &[]).await.unwrap();
    assert_eq!(info["parent"], true);
    let at_root = handle_git(&git, Some(&s(&dir)), "trust", &json!({}), cfg!(windows), &[]).await.unwrap();
    assert_eq!(at_root["parent"], false);
}

#[tokio::test(flavor = "multi_thread")]
async fn shape_of_an_error_for_an_untrusted_repository_carries_a_message_the_panel_can_translate() {
    let lab = Lab::new();
    let dir = lab.hostile("message");
    let git = lab.git(None);
    let root = git.root(&s(&dir)).await.unwrap();
    let e = git.require_trust(&root, false).await.unwrap_err();
    let wire = unimux_git::result_json::<()>(&Err(e));
    assert_eq!(wire["ok"], false);
    assert_eq!(wire["code"], "untrusted");
    assert!(wire["error"].as_str().unwrap().contains("Zaufaj mu"));
}

#[tokio::test(flavor = "multi_thread")]
async fn a_worktree_must_be_one_the_project_may_use() {
    let lab = Lab::new();
    let dir = lab.quiet("wtproj");
    std::fs::write(dir.join("a.txt"), "a\n").unwrap();
    lab.sh(&dir, &["add", "."]);
    lab.sh(&dir, &["commit", "-q", "-m", "one"]);
    let sibling = lab.dir.join("wtproj-wt-b");
    let elsewhere = lab.dir.join("elsewhere").join("wt");
    lab.sh(&dir, &["worktree", "add", "-q", "-b", "b", &s(&sibling)]);
    lab.sh(&dir, &["worktree", "add", "-q", "-b", "c", &s(&elsewhere)]);
    let git = lab.git(None);
    let list = git.worktrees(&s(&dir), Some(&s(&dir)), &[], Some(&s(&sibling))).await.unwrap();
    assert_eq!(list.len(), 3);
    assert!(list[0].main && list[0].is_project && list[0].allowed);
    let find = |p: &Path| list.iter().find(|w| unimux_git::paths::same_path(&w.path, &s(p))).unwrap().clone();
    let (b, c) = (find(&sibling), find(&elsewhere));
    assert!(b.allowed && b.preferred && !b.is_project && !b.main);
    assert!(!c.allowed && !c.preferred);
    assert_eq!(git.resolve_dir(&s(&dir), Some(&s(&sibling)), &[]).await.unwrap(), b.path);
    assert_eq!(git.resolve_dir(&s(&dir), Some(&s(&elsewhere)), &[]).await.unwrap_err().code, GitErrorCode::Invalid);
    assert_eq!(git.resolve_dir(&s(&dir), Some(&s(&elsewhere)), &[s(&elsewhere)]).await.unwrap(), c.path);
    // through the pipeline the scope is the worktree
    let info = handle_git(&git, Some(&s(&dir)), "trust", &json!({ "worktree": s(&sibling) }), cfg!(windows), &[]).await.unwrap();
    assert_eq!((info["state"].as_str(), info["parent"].as_bool()), (Some("safe"), Some(false)));
    let refused =
        handle_git(&git, Some(&s(&dir)), "trust", &json!({ "worktree": s(&elsewhere) }), cfg!(windows), &[]).await.unwrap_err();
    assert_eq!(refused.message, unimux_git::NOT_A_WORKTREE);
}

// ---------- the comparison with 1.1.4 ----------

/// Runs 1.1.4's Git class on the steps; None when Node or the project's node_modules (Vite) are missing.
fn ts_steps(lab: &Lab, steps: Value) -> Option<Value> {
    lab.node.as_ref()?;
    if !repo_root().join("node_modules").join("vite").exists() {
        eprintln!("node_modules/vite is missing: the TS comparison is skipped");
        return None;
    }
    let env: serde_json::Map<String, Value> = lab
        .env
        .iter()
        .map(|(k, v)| (k.to_string_lossy().into_owned(), Value::String(v.to_string_lossy().into_owned())))
        .collect();
    let input = lab.dir.join("trust-steps.json");
    std::fs::write(&input, json!({ "env": env, "steps": steps }).to_string()).unwrap();
    let script = repo_root().join("scripts/git-trust-golden.mjs");
    let program = Program::Args { program: "node".into(), args: vec![script.into(), input.into()] };
    let out = unimux_exec::run(
        &program,
        &ExecOptions {
            timeout: Duration::from_secs(180),
            max_output: 16 * 1024 * 1024,
            cwd: Some(repo_root()),
            ..Default::default()
        },
    )
    .expect("node");
    assert!(out.ok(), "node failed: {}", String::from_utf8_lossy(&out.stderr));
    Some(serde_json::from_slice(&out.stdout).expect("node answer"))
}

#[tokio::test(flavor = "multi_thread")]
async fn trust_hash_keys_and_file_equal_the_ones_1_1_4_writes() {
    let lab = Lab::new();
    // 1. the hostile repository of the TS test
    let hostile = lab.hostile("cmp-hostile");
    // 2. extras: a big hook (hashed by its size), a sample, a folder, a non-ASCII value, a secret in a key, a per-worktree
    //    configuration, info/attributes naming a merge driver, duplicate and odd-case keys
    let extras = lab.hostile("cmp-extras");
    lab.write_hook(&extras, "pre-rebase", &"x".repeat(1024 * 1024 + 7));
    lab.write_hook(&extras, "update.sample", "#!/bin/sh\n");
    std::fs::create_dir_all(extras.join(".git").join("hooks").join("a-folder")).unwrap();
    lab.write_hook(&extras, "commit-msg", "#!/bin/sh\n# zażółć ✓ 😀\n");
    lab.sh(&extras, &["config", "core.editor", "edytor zażółć ✓ \"q\" \\ 😀"]);
    lab.sh(&extras, &["config", "url.https://user:s3cr3t@evil.example/.insteadOf", "https://good/"]);
    lab.sh(&extras, &["config", "--add", "core.fsmonitor", "false"]);
    lab.sh(&extras, &["config", "merge.mine.driver", "x %O"]);
    lab.sh(&extras, &["config", "extensions.worktreeConfig", "true"]);
    lab.sh(&extras, &["config", "--worktree", "core.pager", "less -R"]);
    std::fs::create_dir_all(extras.join(".git").join("info")).unwrap();
    std::fs::write(extras.join(".git").join("info").join("attributes"), "*.x merge=mine\r\n# merge=nope\n").unwrap();
    // 3. only attributes + a global driver would need another env; here a local filter used only by attributes
    let attrs = lab.quiet("cmp-attrs");
    std::fs::write(attrs.join(".gitattributes"), "*.png filter=Lfs diff=hex\n").unwrap();
    lab.sh(&attrs, &["config", "filter.lfs.smudge", "x"]);
    // 4. a safe one
    let safe = lab.quiet("cmp-safe");
    let repos = [("hostile", &hostile), ("extras", &extras), ("attrs", &attrs), ("safe", &safe)];

    let ts_file = lab.dir.join("ts").join("git-trust.json");
    let rust_file = lab.dir.join("rust").join("git-trust.json");
    let mut steps = Vec::new();
    for (name, dir) in &repos {
        steps.push(json!({ "name": format!("scan-{name}"), "op": "scan", "dir": s(dir) }));
    }
    for (name, dir) in &repos {
        steps.push(
            json!({ "name": format!("grant-{name}"), "op": "grant", "dir": s(dir), "trustFile": s(&ts_file), "requestId": id() }),
        );
    }
    let rust = lab.git(Some(rust_file.clone()));
    for (_, dir) in &repos {
        rust.grant_trust(&s(dir), &id(), None).await.unwrap();
    }
    for (name, dir) in &repos {
        steps.push(json!({ "name": format!("reads-rust-{name}"), "op": "info", "dir": s(dir), "trustFile": s(&rust_file) }));
    }
    let Some(ts) = ts_steps(&lab, Value::Array(steps)) else {
        eprintln!("node is not installed: the TS comparison is skipped");
        return;
    };

    for (name, dir) in &repos {
        let git = lab.git(None);
        let root = git.root(&s(dir)).await.unwrap();
        let scan = git.scan(&root, true).await.unwrap();
        let theirs = &ts[format!("scan-{name}")];
        assert_eq!(theirs["root"], root, "{name} root");
        assert_eq!(theirs["keys"], json!(scan.keys), "{name} keys");
        assert_eq!(theirs["hash"], scan.hash, "{name} fingerprint hash");
        let expected = if *name == "safe" { "safe" } else { "trusted" };
        assert_eq!(ts[format!("grant-{name}")]["data"]["state"], expected, "{name}: 1.1.4 grant");
        assert_eq!(ts[format!("reads-rust-{name}")]["data"]["state"], expected, "{name}: 1.1.4 reads the Rust file");
        // Rust reads the file 1.1.4 wrote
        let reader = lab.git(Some(ts_file.clone()));
        assert_eq!(
            serde_json::to_value(reader.trust_info(&s(dir), None, false).await.unwrap().state).unwrap(),
            expected,
            "{name}: Rust reads the 1.1.4 file"
        );
        assert_eq!(reader.trust_store().get(&root), (*name != "safe").then(|| scan.hash.clone()));
        let _ = canonical_path(&root);
    }
    let ts_bytes = std::fs::read(&ts_file).unwrap();
    let rust_bytes = std::fs::read(&rust_file).unwrap();
    assert_eq!(String::from_utf8_lossy(&rust_bytes), String::from_utf8_lossy(&ts_bytes), "git-trust.json bytes");
    assert_eq!(rust_bytes, ts_bytes);
    // the extras repository really exercised the odd parts
    let extras_keys = &ts["scan-extras"]["keys"];
    for key in [
        "hooks/pre-rebase",
        "hooks/commit-msg",
        "core.editor",
        "core.pager",
        "url.https://***@evil.example/.insteadof",
        "merge.mine.driver",
        ".gitattributes: merge=mine",
    ] {
        assert!(extras_keys.as_array().unwrap().contains(&json!(key)), "{key} in {extras_keys}");
    }
    assert!(!extras_keys.to_string().contains("update.sample") && !extras_keys.to_string().contains("a-folder"));
    assert_eq!(ts["scan-attrs"]["keys"], json!([".gitattributes: filter=Lfs", "filter.lfs.smudge"]));
    assert!(lab.markers().is_empty());
}
