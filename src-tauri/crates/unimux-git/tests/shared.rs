//! The cases of test/git-shared.test.ts and test/git-trust-shared.test.ts (PLAN G2 acceptance), one Rust test per TS case
//! (the panel helpers of src/shared/gitUi.ts and the translation check stay in TS: they are renderer code).

use serde_json::{Value, json};
use unimux_git::shared::*;
use unimux_git::trust::*;

const NUL: &str = "\0";
const US: &str = "\x1f";
const RID: &str = "req-12345678";

fn ok(channel: &str, input: Value) -> Value {
    serde_json::to_value(validate_git_request(GitChannel::parse(channel).unwrap(), &input, false).unwrap()).unwrap()
}

fn refused(channel: &str, input: Value) -> bool {
    validate_git_request(GitChannel::parse(channel).unwrap(), &input, false).is_err()
}

fn repo_path(value: &str, windows: bool) -> Option<String> {
    normalize_repo_path_str(value, windows)
}

// ---------- git-shared: ref and path validation ----------

#[test]
fn accepts_ordinary_branch_tag_and_remote_names() {
    for good in ["main", "feature/login-form", "release-1.2.3", "mc/cell-2", "v1.0+build.5", "user@work/topic", "origin/main"] {
        assert!(is_safe_ref_str(good), "{good}");
    }
}

#[test]
fn rejects_anything_that_could_act_as_an_option_or_break_the_command_line() {
    let long = "x".repeat(201);
    let bad = [
        "",
        "-x",
        "--upload-pack=calc",
        "--exec=calc",
        "-",
        "a b",
        "a\nb",
        "a\tb",
        "a\0b",
        "..",
        "a..b",
        "a@{1}",
        "@",
        "/a",
        "a/",
        "a//b",
        ".hidden",
        "a/.b",
        "a.lock",
        "a/b.lock/c",
        "a\\b",
        "a:b",
        "a~1",
        "a^",
        "a?",
        "a*",
        "a[b",
        "ref\"quote",
        "ref'quote",
        "a;b",
        "a|b",
        "a$b",
        "a`b",
        &long,
        "a.",
        "\u{202e}a",
        "zażółć",
    ];
    for value in bad {
        assert!(!is_safe_ref_str(value), "{value:?}");
    }
    for value in [Value::Null, json!(5), json!({}), json!([]), json!(true)] {
        assert!(!is_safe_ref(&value));
    }
}

#[test]
fn validates_remotes_and_hashes() {
    assert!(is_safe_remote_str("origin"));
    assert!(is_safe_remote_str("my-fork.2"));
    for bad in ["", "-origin", "--receive-pack=x", "a b", "a/b", "a..b", &"x".repeat(101)] {
        assert!(!is_safe_remote_str(bad), "{bad}");
    }
    assert!(is_commit_hash_str("deadbeef"));
    assert!(is_commit_hash_str(&"a".repeat(40)));
    for bad in ["", "abc", "HEAD", "main", "--all", "deadbeeg", &"a".repeat(65), "dead beef"] {
        assert!(!is_commit_hash_str(bad), "{bad}");
    }
}

#[test]
fn keeps_paths_inside_the_repository() {
    assert_eq!(repo_path("src/a.ts", false).as_deref(), Some("src/a.ts"));
    assert_eq!(repo_path("zażółć gęślą/plik ✓.txt", false).as_deref(), Some("zażółć gęślą/plik ✓.txt"));
    assert_eq!(repo_path("folder/", false).as_deref(), Some("folder/"));
    assert_eq!(repo_path("-rf", false).as_deref(), Some("-rf"));
    assert_eq!(repo_path("src\\a.ts", true).as_deref(), Some("src/a.ts"));
    let long = "x".repeat(1001);
    for bad in [
        "",
        "/etc/passwd",
        "C:/Windows",
        "C:\\Windows",
        "../x",
        "a/../b",
        "a/./b",
        "./a",
        ".git/config",
        "a/.GIT/hooks",
        "a//b",
        "a\nb",
        "a\0b",
        &long,
        "..",
    ] {
        assert_eq!(repo_path(bad, true), None, "{bad:?}");
    }
    assert_eq!(repo_path("src\\a.ts", false).as_deref(), Some("src\\a.ts"));
    for value in [Value::Null, json!(5), json!({})] {
        assert_eq!(normalize_repo_path(&value, false), None);
    }
}

#[test]
fn finds_the_project_relative_path_of_a_repository_file_from_the_relation_main_worked_out() {
    let inside = |prefix: &str| GitProjectRelation { kind: RelationKind::InsideRoot, prefix: prefix.into() };
    let contains = |prefix: &str| GitProjectRelation { kind: RelationKind::ContainsRoot, prefix: prefix.into() };
    assert_eq!(project_relative_path(Some(&inside("")), "src/a.ts", true).as_deref(), Some("src/a.ts"));
    assert_eq!(project_relative_path(Some(&inside("app")), "app/src/a.ts", true).as_deref(), Some("src/a.ts"));
    assert_eq!(project_relative_path(Some(&inside("App")), "app/src/a.ts", true).as_deref(), Some("src/a.ts"));
    assert_eq!(project_relative_path(Some(&inside("app")), "other/a.ts", true), None);
    assert_eq!(project_relative_path(Some(&inside("app")), "app", true), None);
    assert_eq!(project_relative_path(Some(&inside("")), "dir/", true).as_deref(), Some("dir"));
    assert_eq!(project_relative_path(Some(&inside("pkg")), "pkg/a.ts", false).as_deref(), Some("a.ts"));
    assert_eq!(project_relative_path(Some(&inside("Pkg")), "pkg/a.ts", false), None);
    assert_eq!(project_relative_path(Some(&contains("vendor/lib")), "src/a.ts", false).as_deref(), Some("vendor/lib/src/a.ts"));
    assert_eq!(project_relative_path(None, "a.ts", false), None);
}

// ---------- git-shared: request validation ----------

#[test]
fn normalizes_a_good_request_and_drops_unknown_fields() {
    assert_eq!(
        ok("log", json!({ "skip": 50, "count": 50, "search": "fix", "extra": "x", "path": "src/a.ts" })),
        json!({ "skip": 50, "count": 50, "search": "fix", "path": "src/a.ts" })
    );
    assert_eq!(ok("log", json!({})), json!({ "skip": 0, "count": 50 }));
    assert_eq!(ok("status", json!({ "worktree": "D:\\wt" })), json!({ "worktree": "D:\\wt" }));
    assert_eq!(
        ok("diff", json!({ "source": "commit", "hash": "deadbeef", "path": "a.txt", "oldPath": "b.txt" })),
        json!({ "source": "commit", "hash": "deadbeef", "path": "a.txt", "oldPath": "b.txt" })
    );
    assert_eq!(
        ok("stage", json!({ "requestId": RID, "paths": [], "all": true })),
        json!({ "requestId": RID, "paths": [], "all": true })
    );
    ok("push", json!({ "requestId": RID, "remote": "origin", "branch": "main", "urlId": "abcdef0123456789" }));
    ok("commit", json!({ "requestId": RID, "message": "Dodaj ✓\n\nbody" }));
    assert_eq!(
        ok("checkout", json!({ "requestId": RID, "branch": "origin/x", "remote": true })),
        json!({ "requestId": RID, "branch": "origin/x", "remote": true })
    );
}

#[test]
fn refuses_malformed_requests() {
    let many: Vec<&str> = vec!["a"; 2001];
    let cases: Vec<(&str, Value)> = vec![
        ("status", Value::Null),
        ("status", json!("x")),
        ("status", json!([])),
        ("status", json!({ "worktree": 5 })),
        ("status", json!({ "worktree": "a\0b" })),
        ("log", json!({ "skip": -1 })),
        ("log", json!({ "skip": 1.5 })),
        ("log", json!({ "skip": 2_000_000 })),
        ("log", json!({ "count": 0 })),
        ("log", json!({ "count": 201 })),
        ("log", json!({ "search": 5 })),
        ("log", json!({ "search": "x".repeat(201) })),
        ("log", json!({ "author": "a\0" })),
        ("log", json!({ "path": "../x" })),
        ("log", json!({ "all": "yes" })),
        ("show", json!({ "hash": "HEAD" })),
        ("show", json!({ "hash": "--stat" })),
        ("show", json!({})),
        ("diff", json!({ "source": "other", "path": "a" })),
        ("diff", json!({ "source": "working", "path": "/abs" })),
        ("diff", json!({ "source": "commit", "path": "a" })),
        ("diff", json!({ "source": "working", "path": "a", "oldPath": "../b" })),
        ("fetch", json!({})),
        ("fetch", json!({ "requestId": "short" })),
        ("fetch", json!({ "requestId": "has space 12345" })),
        ("pull", json!({ "requestId": 5 })),
        ("push", json!({ "requestId": RID, "remote": "--receive-pack=x", "branch": "main" })),
        ("push", json!({ "requestId": RID, "remote": "origin", "branch": "-f" })),
        ("push", json!({ "requestId": RID, "remote": "origin" })),
        ("push", json!({ "requestId": RID, "remote": "origin", "branch": "main" })),
        ("push", json!({ "requestId": RID, "remote": "origin", "branch": "main", "urlId": "xyz" })),
        ("push", json!({ "requestId": RID, "remote": "origin", "branch": "main", "urlId": "ABCDEF0123456789" })),
        ("stage", json!({ "requestId": RID, "paths": [] })),
        ("stage", json!({ "requestId": RID, "paths": ["../a"] })),
        ("stage", json!({ "requestId": RID, "paths": "a" })),
        ("stage", json!({ "requestId": RID, "paths": [5] })),
        ("stage", json!({ "requestId": RID, "paths": many })),
        ("unstage", json!({ "requestId": RID, "paths": ["a"], "all": "x" })),
        ("commit", json!({ "requestId": RID, "message": "   " })),
        ("commit", json!({ "requestId": RID, "message": "a".repeat(20_001) })),
        ("commit", json!({ "requestId": RID, "message": "a\0b" })),
        ("commit", json!({ "message": "x" })),
        ("checkout", json!({ "requestId": RID, "branch": "--orphan" })),
        ("checkout", json!({ "requestId": RID, "branch": "a b" })),
        ("checkout", json!({ "requestId": RID, "branch": "a", "remote": "yes" })),
    ];
    for (channel, request) in cases {
        assert!(refused(channel, request.clone()), "{channel} {request}");
    }
}

// ---------- git-shared: output text ----------

#[test]
fn removes_credentials_and_control_sequences() {
    use unimux_git::text::{redact_secrets, trim_git_text, trim_git_text_default};
    assert_eq!(
        redact_secrets("fatal: unable to access https://user:s3cr3t@example.com/repo.git/"),
        "fatal: unable to access https://***@example.com/repo.git/"
    );
    assert_eq!(redact_secrets("ssh://git:pw@host:22/x"), "ssh://***@host:22/x");
    assert_eq!(redact_secrets("token ghp_abcdefghijklmnopqrstuvwxyz0123456789 leaked"), "token *** leaked");
    assert_eq!(trim_git_text_default("\x1b[31mred\x1b[0m\r\n\n\n\nafter\n"), "red\n\nafter");
    assert_eq!(
        trim_git_text_default(
            "hint: Diverging branches can't be fast-forwarded\nhint:\nfatal: Not possible to fast-forward, aborting.\n"
        ),
        "fatal: Not possible to fast-forward, aborting."
    );
    assert_eq!(trim_git_text_default("hint: only advice"), "hint: only advice");
    let long = trim_git_text(&"x".repeat(2000), 100);
    assert!(long.encode_utf16().count() <= 101);
    assert!(long.starts_with('…'));
}

// ---------- git-shared: status parser ----------

#[test]
fn reads_branch_headers_and_every_kind_of_record() {
    let out = [
        "# branch.oid 0123456789abcdef0123456789abcdef01234567",
        "# branch.head main",
        "# branch.upstream origin/main",
        "# branch.ab +2 -1",
        "1 .M N... 100644 100644 100644 aaaa bbbb src/some file.ts",
        "1 A. N... 000000 100644 100644 0000 bbbb zażółć.txt",
        "2 R. N... 100644 100644 100644 aaaa aaaa R100 new name.txt",
        "old name.txt",
        "u UU N... 100644 100644 100644 100644 aaaa bbbb cccc conflicted.txt",
        "? untracked ✓.txt",
        "? folder/",
        "",
    ]
    .join(NUL);
    let p = parse_status_v2(&out, GIT_MAX_FILES);
    assert_eq!(p.branch.as_deref(), Some("main"));
    assert!(!p.detached && !p.initial && !p.truncated);
    assert_eq!(p.head, "0123456");
    assert_eq!(p.upstream.as_deref(), Some("origin/main"));
    assert_eq!((p.ahead.0, p.behind.0), (2.0, 1.0));
    let got: Vec<_> = p
        .files
        .iter()
        .map(|f| {
            (
                f.path.as_str(),
                f.x.as_deref().unwrap(),
                f.y.as_deref().unwrap(),
                f.staged,
                f.unstaged,
                f.untracked,
                f.conflict,
                f.orig_path.as_deref(),
            )
        })
        .collect();
    assert_eq!(
        got,
        [
            ("src/some file.ts", " ", "M", false, true, false, false, None),
            ("zażółć.txt", "A", " ", true, false, false, false, None),
            ("new name.txt", "R", " ", true, false, false, false, Some("old name.txt")),
            ("conflicted.txt", "U", "U", false, false, false, true, None),
            ("untracked ✓.txt", "?", "?", false, false, true, false, None),
            ("folder/", "?", "?", false, false, true, false, None),
        ]
    );
}

#[test]
fn handles_detached_head_initial_commit_and_the_file_limit() {
    let d = parse_status_v2(&["# branch.oid abcdef0123456789", "# branch.head (detached)", ""].join(NUL), GIT_MAX_FILES);
    assert_eq!((d.branch, d.detached, d.head.as_str()), (None, true, "abcdef0"));
    let i = parse_status_v2(&["# branch.oid (initial)", "# branch.head main", "? a", ""].join(NUL), GIT_MAX_FILES);
    assert_eq!((i.branch.as_deref(), i.initial, i.head.as_str()), (Some("main"), true, ""));
    let many: Vec<String> = (0..10).map(|i| format!("? f{i}")).collect();
    let limited = parse_status_v2(&many.join(NUL), 4);
    assert_eq!(limited.files.len(), 4);
    assert!(limited.truncated);
    assert!(parse_status_v2("", GIT_MAX_FILES).files.is_empty());
    assert!(parse_status_v2(&["garbage", "9 something", "1 short", ""].join(NUL), GIT_MAX_FILES).files.is_empty());
}

// ---------- git-shared: log and details parsers ----------

fn hash(c: char) -> String {
    c.to_string().repeat(40)
}

#[test]
fn parses_z_records_with_refs_parents_and_unicode() {
    let record = |h: &str, parents: &str, subject: &str, refs: &str| {
        [h, &h[..7], parents, "Zażółć G.", "1767323045", refs, subject].join(US)
    };
    let out = [
        record(
            &hash('a'),
            &format!("{} {}", hash('b'), hash('c')),
            "Merge ✓ \"x\"",
            "HEAD -> refs/heads/main, tag: refs/tags/v1.0, refs/remotes/origin/main, refs/remotes/origin/HEAD",
        ),
        record(&hash('b'), &hash('d'), "subject with\u{1f}unit separator", ""),
        record(&hash('d'), "", "root", ""),
        String::new(),
    ]
    .join(NUL);
    let commits = parse_log(&out);
    assert_eq!(commits.len(), 3);
    assert_eq!((commits[0].short.as_str(), commits[0].author.as_str(), commits[0].at.0), ("aaaaaaa", "Zażółć G.", 1767323045.0));
    assert_eq!(commits[0].subject, "Merge ✓ \"x\"");
    assert_eq!(commits[0].parents, [hash('b'), hash('c')]);
    assert_eq!(
        serde_json::to_value(&commits[0].refs).unwrap(),
        json!([{ "name": "main", "kind": "branch", "current": true }, { "name": "v1.0", "kind": "tag" }, { "name": "origin/main", "kind": "remote" }])
    );
    assert_eq!(commits[1].subject, "subject with\u{1f}unit separator");
    assert!(commits[2].parents.is_empty());
    assert!(parse_log("").is_empty());
    assert!(parse_log(&format!("not a commit{NUL}")).is_empty());
}

#[test]
fn parses_refs() {
    assert_eq!(serde_json::to_value(parse_refs("HEAD")).unwrap(), json!([{ "name": "HEAD", "kind": "head", "current": true }]));
    assert_eq!(
        serde_json::to_value(parse_refs("HEAD -> refs/heads/feature/x, refs/stash")).unwrap(),
        json!([{ "name": "feature/x", "kind": "branch", "current": true }])
    );
    assert!(parse_refs("").is_empty());
}

#[test]
fn keeps_the_format_strings_in_sync_with_the_parsers() {
    assert_eq!(LOG_FORMAT.split("%x1f").count(), 7);
    assert!(DETAILS_FORMAT.starts_with(LOG_FORMAT));
    let info = [
        &hash('a'),
        "aaaaaaa",
        &hash('b'),
        "Ann",
        "1767323045",
        "",
        "subject",
        "ann@example.com",
        "subject\n\nbody: with\u{1f}control\r\nline\n\n",
    ]
    .join(US);
    let details = parse_details(&info).unwrap();
    assert_eq!(details.email, "ann@example.com");
    assert_eq!(details.message, "subject\n\nbody: with\u{1f}control\nline");
    assert!(parse_details("x").is_none());
}

#[test]
fn parses_diff_tree_output_with_renames_binary_files_and_the_file_limit() {
    let out = [
        ":100644 100644 aaaa bbbb M",
        "src/a.ts",
        ":000000 100644 0000 cccc A",
        "new file.txt",
        ":100644 100644 dddd eeee R087",
        "old.txt",
        "new.txt",
        ":100644 000000 ffff 0000 D",
        "gone.bin",
        "3\t1\tsrc/a.ts",
        "10\t0\tnew file.txt",
        "2\t2\t",
        "old.txt",
        "new.txt",
        "-\t-\tgone.bin",
        "",
    ]
    .join(NUL);
    let (files, truncated) = parse_diff_tree(&out, GIT_COMMIT_FILE_LIMIT);
    assert!(!truncated);
    assert_eq!(
        serde_json::to_value(&files).unwrap(),
        json!([
            { "status": "M", "path": "src/a.ts", "added": 3, "deleted": 1 },
            { "status": "A", "path": "new file.txt", "added": 10, "deleted": 0 },
            { "status": "R", "origPath": "old.txt", "path": "new.txt", "added": 2, "deleted": 2 },
            { "status": "D", "path": "gone.bin", "added": null, "deleted": null },
        ])
    );
    let (cut, truncated) = parse_diff_tree(&out, 2);
    assert!(truncated);
    assert_eq!(cut.len(), 2);
    assert!(parse_diff_tree("", GIT_COMMIT_FILE_LIMIT).0.is_empty());
}

#[test]
fn parses_branches_and_worktrees() {
    let f = |cols: &[&str]| cols.join(US);
    let branches = parse_branches(
        &[
            f(&["refs/heads/main", "main", "abc1234", "origin/main", "ahead 1", "*"]),
            f(&["refs/heads/feature/x", "feature/x", "def5678", "", "", " "]),
            f(&["refs/remotes/origin/main", "origin/main", "abc1234", "", "", " "]),
            f(&["refs/remotes/origin/HEAD", "origin/HEAD", "abc1234", "", "", " "]),
            f(&["refs/remotes/origin/HEAD", "origin", "abc1234", "", "", " "]),
            f(&["refs/tags/v1", "v1", "abc1234", "", "", " "]),
            "garbage".into(),
            String::new(),
        ]
        .join("\n"),
    );
    let got: Vec<_> =
        branches.iter().map(|b| (b.name.as_str(), b.remote, b.current, b.upstream.as_deref(), b.track.as_str())).collect();
    assert_eq!(
        got,
        [
            ("main", false, true, Some("origin/main"), "ahead 1"),
            ("feature/x", false, false, None, ""),
            ("origin/main", true, false, None, "")
        ]
    );
    let list = parse_worktrees(
        &[
            "worktree D:/p/app",
            "HEAD 0123456789abcdef",
            "branch refs/heads/main",
            "",
            "worktree D:/p/app-wt-a",
            "HEAD fedcba9876543210",
            "detached",
            "",
        ]
        .join("\n"),
    );
    assert_eq!(
        serde_json::to_value(&list).unwrap(),
        json!([
            { "path": "D:/p/app", "branch": "main", "head": "0123456", "main": true, "detached": false, "allowed": true, "isProject": false, "preferred": false },
            { "path": "D:/p/app-wt-a", "branch": null, "head": "fedcba9", "main": false, "detached": true, "allowed": true, "isProject": false, "preferred": false },
        ])
    );
}

// ---------- git-shared: unified diff parser ----------

fn kinds(diff: &ParsedDiff) -> Vec<(String, String, Option<f64>, Option<f64>)> {
    diff.lines
        .iter()
        .map(|l| {
            let kind = serde_json::to_value(l.kind).unwrap().as_str().unwrap().to_string();
            (kind, l.text.clone(), l.old_no.map(|n| n.0), l.new_no.map(|n| n.0))
        })
        .collect()
}

#[test]
fn numbers_lines_folds_the_header_and_marks_notes_and_binary_files() {
    let diff = [
        "diff --git a/a.txt b/a.txt",
        "index 111..222 100644",
        "--- a/a.txt",
        "+++ b/a.txt",
        "@@ -1,3 +1,4 @@ function x()",
        " one",
        "-two",
        "+TWO",
        "+three",
        " four",
        "\\ No newline at end of file",
        "@@ -20 +21 @@",
        "-old\r",
        "+new\r",
        "",
    ]
    .join("\n");
    let parsed = parse_unified_diff(&diff, GIT_DIFF_LINES);
    assert_eq!(parsed.header, ["diff --git a/a.txt b/a.txt", "index 111..222 100644", "--- a/a.txt", "+++ b/a.txt"]);
    let l = |k: &str, t: &str, o: Option<f64>, n: Option<f64>| (k.to_string(), t.to_string(), o, n);
    assert_eq!(
        kinds(&parsed),
        [
            l("hunk", "@@ -1,3 +1,4 @@ function x()", None, None),
            l("ctx", "one", Some(1.0), Some(1.0)),
            l("del", "two", Some(2.0), None),
            l("add", "TWO", None, Some(2.0)),
            l("add", "three", None, Some(3.0)),
            l("ctx", "four", Some(3.0), Some(4.0)),
            l("note", "No newline at end of file", None, None),
            l("hunk", "@@ -20 +21 @@", None, None),
            l("del", "old", Some(20.0), None),
            l("add", "new", None, Some(21.0)),
        ]
    );
    assert!(parse_unified_diff("diff --git a/x b/x\nBinary files a/x and b/x differ\n", GIT_DIFF_LINES).binary);
    assert!(parse_unified_diff("", GIT_DIFF_LINES).lines.is_empty());
}

#[test]
fn treats_a_line_starting_with_as_content_and_cuts_very_long_diffs() {
    // the TS case: 'treats a line starting with "--- " inside a hunk as content and cuts very long diffs'
    let inside =
        parse_unified_diff(&["@@ -1,2 +1,2 @@", "--- not a header", "+++ not a header either"].join("\n"), GIT_DIFF_LINES);
    assert_eq!(kinds(&inside).iter().map(|k| k.0.as_str()).collect::<Vec<_>>(), ["hunk", "del", "add"]);
    let mut lines = vec!["@@ -1,5000 +1,5000 @@".to_string()];
    lines.extend((0..5000).map(|i| format!("+line {i}")));
    let cut = parse_unified_diff(&lines.join("\n"), 100);
    assert!(cut.cut);
    assert_eq!(cut.lines.len(), 100);
}

// ---------- git-shared: commit graph ----------

fn graph(commits: &[(&str, &[&str])]) -> Vec<GraphRow> {
    let owned: Vec<(String, Vec<String>)> =
        commits.iter().map(|(h, p)| (h.to_string(), p.iter().map(|s| s.to_string()).collect())).collect();
    layout_graph(owned.iter().map(|(h, p)| (h.as_str(), p.as_slice())))
}

fn lanes(list: &[&str]) -> Vec<Option<String>> {
    list.iter().map(|s| Some(s.to_string())).collect()
}

#[test]
fn keeps_a_linear_history_in_one_lane() {
    let rows = graph(&[("a", &["b"]), ("b", &["c"]), ("c", &[])]);
    assert_eq!(rows.iter().map(|r| r.col).collect::<Vec<_>>(), [0, 0, 0]);
    assert_eq!(rows[0].bottom, lanes(&["b"]));
    assert!(rows[2].bottom.is_empty());
}

#[test]
fn opens_a_lane_for_a_merge_parent_and_closes_it_when_both_lines_meet() {
    let rows = graph(&[("m", &["a", "b"]), ("a", &["base"]), ("b", &["base"]), ("base", &[])]);
    assert_eq!((rows[0].col, rows[0].bottom.clone(), rows[0].from_dot.clone()), (0, lanes(&["a", "b"]), vec![0, 1]));
    assert_eq!((rows[1].col, rows[1].top.clone(), rows[1].bottom.clone()), (0, lanes(&["a", "b"]), lanes(&["base", "b"])));
    assert_eq!(
        (rows[2].col, rows[2].top.clone(), rows[2].bottom.clone(), rows[2].from_dot.clone()),
        (1, lanes(&["base", "b"]), lanes(&["base"]), vec![0])
    );
    assert_eq!((rows[3].col, rows[3].to_dot.clone(), rows[3].bottom.is_empty()), (0, vec![0], true));
}

#[test]
fn survives_a_cut_off_page_unordered_parents_and_a_repeated_parent() {
    assert_eq!(graph(&[("a", &["missing"])])[0].bottom, lanes(&["missing"]));
    graph(&[("x", &["y", "y", "z"]), ("z", &[]), ("y", &[])]);
    assert!(graph(&[]).is_empty());
    let wide: Vec<(String, Vec<String>)> =
        (0..40).map(|i| (format!("h{i}"), vec![format!("h{}", i + 1), format!("side{i}")])).collect();
    assert_eq!(layout_graph(wide.iter().map(|(h, p)| (h.as_str(), p.as_slice()))).len(), 40);
}

// ---------- git-trust-shared ----------

fn entries(pairs: &[(&str, &str)]) -> Vec<ConfigEntry> {
    pairs.iter().map(|(k, v)| ConfigEntry { key: k.to_string(), value: v.to_string() }).collect()
}

#[test]
fn parses_git_config_list_z() {
    assert_eq!(
        parse_config_list("core.bare\nfalse\0user.name\nA B\0core.noValue\0"),
        entries(&[("core.bare", "false"), ("user.name", "A B"), ("core.noValue", "")])
    );
    assert!(parse_config_list("").is_empty());
    assert_eq!(parse_config_list("a.b\nline1\nline2\0"), entries(&[("a.b", "line1\nline2")]));
}

#[test]
fn flags_every_key_that_can_start_a_program() {
    let risky = entries(&[
        ("filter.lfs.clean", "x"),
        ("filter.a.smudge", "x"),
        ("filter.a.process", "x"),
        ("diff.a.textconv", "x"),
        ("diff.a.command", "x"),
        ("diff.external", "x"),
        ("merge.a.driver", "x"),
        ("core.fsmonitor", "/bin/x"),
        ("core.fsmonitor", "true"),
        ("core.hooksPath", ".hooks"),
        ("core.sshCommand", "x"),
        ("core.pager", "x"),
        ("core.editor", "x"),
        ("core.askPass", "x"),
        ("remote.origin.uploadpack", "x"),
        ("remote.origin.receivepack", "x"),
        ("remote.origin.proxy", "x"),
        ("remote.origin.vcs", "x"),
        ("credential.helper", "!x"),
        ("credential.https://h.helper", "/usr/bin/x"),
        ("credential.helper", "C:\\x\\y.exe"),
        ("url.https://evil/.insteadOf", "https://good/"),
        ("url.https://evil/.pushInsteadOf", "https://good/"),
        ("protocol.file.allow", "always"),
        ("protocol.allow", "always"),
        ("include.path", "../x"),
        ("includeIf.gitdir:/x/.path", "../x"),
        ("gpg.program", "x"),
        ("gpg.ssh.program", "x"),
        ("core.worktree", ".."),
        ("pager.log", "x"),
        ("uploadpack.packObjectsHook", "x"),
        ("sequence.editor", "x"),
        ("submodule.s.update", "!x"),
    ]);
    let found = dangerous_config_keys(&risky);
    let unique: std::collections::HashSet<_> = risky.iter().map(|e| e.key.as_str()).collect();
    assert_eq!(found.len(), unique.len());
    for e in &risky {
        assert!(found.contains(&e.key), "{}", e.key);
    }
}

#[test]
fn leaves_ordinary_configuration_alone() {
    let quiet = entries(&[
        ("core.bare", "false"),
        ("core.fsmonitor", "false"),
        ("core.fsmonitor", ""),
        ("core.autocrlf", "true"),
        ("user.name", "x"),
        ("remote.origin.url", "https://h/r.git"),
        ("remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*"),
        ("branch.main.remote", "origin"),
        ("credential.helper", "manager"),
        ("alias.x", "!echo hi"),
        ("submodule.s.update", "checkout"),
        ("filter.x.required", "true"),
        ("diff.a.binary", "true"),
    ]);
    assert!(dangerous_config_keys(&quiet).is_empty());
}

#[test]
fn flags_a_credential_helper_that_is_not_a_known_helper_name() {
    // git runs `git credential-<value>` through the shell (test/git-trust-shared.test.ts, b39025b).
    // Only an ASCII space or tab separates arguments (second security review: a newline starts a new shell command).
    for value in [
        "x; calc",
        "evil",
        "manager $(calc)",
        "store --file=x;calc",
        "cache `calc`",
        "manager\ncalc",
        "../x",
        "manager && calc",
        "cache\n--timeout=1",
        "cache\r--x",
        "cache\u{a0}--x",
        "cache\u{2028}--x",
        "cache\u{b}--x",
    ] {
        assert_eq!(dangerous_config_keys(&entries(&[("credential.helper", value)])), ["credential.helper"], "{value:?}");
    }
    for value in [
        "",
        "manager",
        "manager-core",
        "wincred",
        "osxkeychain",
        "libsecret",
        "cache --timeout=3600",
        "store --file=~/.git-credentials",
    ] {
        assert!(dangerous_config_keys(&entries(&[("credential.helper", value)])).is_empty(), "{value:?}");
    }
    // JS `\w` is ASCII only; a tab separates arguments like a space.
    assert_eq!(dangerous_config_keys(&entries(&[("credential.helper", "cache --tim\u{e9}")])), ["credential.helper"]);
    assert!(dangerous_config_keys(&entries(&[("credential.helper", "cache\t--timeout=1")])).is_empty());
    assert!(dangerous_config_keys(&entries(&[("credential.https://h.helper", "  store  ")])).is_empty());
}

#[test]
fn never_reports_a_value_and_removes_credentials_that_sit_inside_a_key() {
    let found = dangerous_config_keys(&entries(&[
        ("url.https://user:s3cr3t@evil.example/.insteadOf", "https://good/"),
        ("core.sshCommand", "secret-command"),
    ]));
    let text = serde_json::to_string(&found).unwrap();
    assert!(!text.contains("s3cr3t"));
    assert!(!text.contains("secret-command"));
}

#[test]
fn finds_attribute_references_to_configured_drivers() {
    let drivers = attribute_drivers("# c\n*.png filter=lfs diff=lfs merge=lfs -text\n*.md text\n\n*.dat   diff=hex\n");
    let d = |kind, name: &str| AttributeDriver { kind, name: name.into() };
    assert_eq!(
        drivers,
        [d(DriverKind::Filter, "lfs"), d(DriverKind::Diff, "lfs"), d(DriverKind::Merge, "lfs"), d(DriverKind::Diff, "hex")]
    );
    let defined = entries(&[("filter.lfs.clean", "git-lfs clean"), ("diff.hex.textconv", "xxd"), ("diff.lfs.binary", "true")]);
    assert_eq!(configured_attribute_drivers(&drivers, &defined), [".gitattributes: diff=hex", ".gitattributes: filter=lfs"]);
    assert!(configured_attribute_drivers(&drivers, &[]).is_empty());
}

#[test]
fn rejects_8_3_aliases_trailing_dots_and_spaces_and_streams_only_on_windows() {
    for bad in [
        "GIT~1/config",
        "a/GIT~1",
        "progra~1/x",
        ".git./config",
        ".git /config",
        "a/.GIT.",
        "file.txt:stream",
        "a./b",
        "a /b",
        "dir/name ",
    ] {
        assert_eq!(repo_path(bad, true), None, "{bad}");
    }
    assert_eq!(repo_path("GIT~1/config", false).as_deref(), Some("GIT~1/config"));
    assert_eq!(repo_path("docs/readme.md", true).as_deref(), Some("docs/readme.md"));
    assert_eq!(repo_path("zażółć gęślą/plik ✓.txt", true).as_deref(), Some("zażółć gęślą/plik ✓.txt"));
}

#[test]
fn allows_the_project_folder_folders_inside_it_app_made_siblings_and_cell_worktrees_only() {
    let project = "D:\\Projekty\\app";
    assert!(worktree_allowed(project, "D:/Projekty/app", &[]));
    assert!(worktree_allowed(project, "D:/Projekty/app/sub/wt", &[]));
    assert!(worktree_allowed(project, "D:/Projekty/app-wt-fix-login", &[]));
    assert!(!worktree_allowed(project, "D:/Projekty/app-wt-fix-login/nested", &[]));
    assert!(!worktree_allowed(project, "D:/Projekty/other", &[]));
    assert!(!worktree_allowed(project, "D:/Projekty/app2", &[]));
    assert!(!worktree_allowed(project, "C:/Users/me", &[]));
    assert!(worktree_allowed(project, "D:/Elsewhere/wt", &["D:\\Elsewhere\\wt".into()]));
}

#[test]
fn needs_a_request_id_for_grant_and_revoke_and_ignores_anything_else_the_renderer_adds() {
    assert_eq!(ok("trustGrant", json!({ "requestId": RID, "trusted": true, "state": "trusted" })), json!({ "requestId": RID }));
    ok("trustRevoke", json!({ "requestId": RID }));
    assert!(refused("trustGrant", json!({})));
    assert_eq!(ok("trust", json!({ "trusted": true })), json!({}));
    assert_eq!(
        ok("commit", json!({ "requestId": RID, "message": "x", "trusted": true })),
        json!({ "requestId": RID, "message": "x" })
    );
    assert_eq!(ok("status", json!({ "trusted": true, "trust": true })), json!({}));
}
