//! The cases of test/sessions.test.ts.

use super::*;
use serde_json::json;
use std::fs;

const PROJECT: &str = "D:\\Projekty\\bot-discord";

fn jsonl(rows: &[Value]) -> String {
    rows.iter()
        .map(|r| match r {
            Value::String(s) => format!("{s}\n"),
            other => format!("{}\n", serde_json::to_string(other).unwrap()),
        })
        .collect()
}

fn set_mtime(file: &Path, ms: f64) {
    let f = fs::OpenOptions::new().write(true).open(file).unwrap();
    f.set_modified(system_time_of_ms(ms)).unwrap();
}

fn fake_home() -> tempfile::TempDir {
    let home = tempfile::Builder::new().prefix("mc-home-").tempdir().unwrap();
    let cdir = home.path().join(".claude").join("projects").join(claude_project_dir_name(PROJECT));
    fs::create_dir_all(&cdir).unwrap();
    fs::write(
        cdir.join("aaa.jsonl"),
        jsonl(&[
            json!({ "type": "mode", "sessionId": "aaa" }),
            json!("this is not json"),
            json!({ "type": "user", "isMeta": true, "message": { "content": [{ "type": "text", "text": "meta stuff" }] }, "sessionId": "aaa", "cwd": PROJECT, "timestamp": "2026-10-01T10:00:00Z" }),
            json!({ "type": "user", "message": { "content": "<command-name>/clear</command-name>" }, "sessionId": "aaa" }),
            json!({ "type": "user", "message": { "content": "napraw   logowanie\nw bocie" }, "sessionId": "aaa" }),
        ]),
    )
    .unwrap();
    fs::write(
        cdir.join("bbb.jsonl"),
        jsonl(&[
            json!({ "type": "user", "message": { "content": "pierwszy prompt" }, "sessionId": "bbb", "cwd": PROJECT, "timestamp": "2026-10-02T10:00:00Z" }),
            json!({ "type": "ai-title", "aiTitle": "Refaktor sidebaru", "sessionId": "bbb" }),
        ]),
    )
    .unwrap();
    fs::write(cdir.join("empty.jsonl"), jsonl(&[json!({ "type": "mode", "sessionId": "empty" })])).unwrap();

    let xdir = home.path().join(".codex").join("sessions").join("2026").join("10").join("06");
    fs::create_dir_all(&xdir).unwrap();
    let meta = |id: &str, cwd: &str| json!({ "type": "session_meta", "payload": { "id": id, "cwd": cwd, "timestamp": "2026-10-06T10:00:00Z", "base_instructions": { "text": "x".repeat(90000) } } });
    let user = |text: &str| json!({ "type": "response_item", "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": text }] } });
    fs::write(
        xdir.join("rollout-2026-10-06T10-00-00-c1.jsonl"),
        jsonl(&[meta("c1", PROJECT), user("# AGENTS.md instructions"), user("<environment_context>"), user("dodaj testy")]),
    )
    .unwrap();
    fs::write(xdir.join("rollout-2026-10-06T11-00-00-c2.jsonl"), jsonl(&[meta("c2", "D:\\Other"), user("inny projekt")]))
        .unwrap();
    home
}

fn ids(list: &[SessionInfo]) -> Vec<String> {
    let mut v: Vec<String> = list.iter().map(|s| s.id.as_str().unwrap().to_string()).collect();
    v.sort();
    v
}

fn by_id<'a>(list: &'a [SessionInfo], id: &str) -> &'a SessionInfo {
    list.iter().find(|s| s.id == json!(id)).unwrap()
}

#[test]
fn encodes_claude_project_dir_names() {
    assert_eq!(claude_project_dir_name("C:\\Users\\x\\a.b c"), "C--Users-x-a-b-c");
    // UTF-16 code units: a character outside the BMP is two dashes, a Polish letter one.
    assert_eq!(claude_project_dir_name("D:\\Projekty\\żółw😀"), "D--Projekty----w--");
}

#[test]
fn lists_claude_sessions_with_titles_skipping_meta_command_lines_junk_and_empty_sessions() {
    let home = fake_home();
    let list = SessionIndex::new().list_claude_sessions(home.path(), PROJECT);
    assert_eq!(ids(&list), ["aaa", "bbb"]);
    assert_eq!(by_id(&list, "aaa").title, "napraw logowanie w bocie");
    assert_eq!(by_id(&list, "bbb").title, "Refaktor sidebaru");
}

#[test]
fn encodes_worktree_paths_like_the_project_dir() {
    assert_eq!(claude_project_dir_name("D:\\Projekty\\bot\\.claude\\worktrees\\x_1"), "D--Projekty-bot--claude-worktrees-x-1");
    assert_eq!(claude_project_dir_name("/Users/a/proj/.worktrees/feat"), "-Users-a-proj--worktrees-feat");
}

#[test]
fn caches_claude_sessions_by_mtime_size_re_parses_changes_and_prunes_deleted_files() {
    let index = SessionIndex::new();
    let home = fake_home();
    let cdir = home.path().join(".claude").join("projects").join(claude_project_dir_name(PROJECT));
    let first = index.list_claude_sessions(home.path(), PROJECT);
    let parsed = index.claude_cache_stats().parses;
    assert_eq!(parsed, 3);
    assert_eq!(index.list_claude_sessions(home.path(), PROJECT), first);
    assert_eq!(index.claude_cache_stats().parses, parsed); // cache hits: no rereads

    let file = cdir.join("bbb.jsonl");
    fs::write(&file, jsonl(&[json!({ "type": "user", "message": { "content": "nowy" }, "sessionId": "bbb", "cwd": PROJECT })]))
        .unwrap();
    set_mtime(&file, now_ms() + 10_000.0);
    let after = index.list_claude_sessions(home.path(), PROJECT);
    assert_eq!(index.claude_cache_stats().parses, parsed + 1);
    assert_eq!(by_id(&after, "bbb").title, "nowy");

    fs::remove_file(cdir.join("aaa.jsonl")).unwrap();
    assert_eq!(ids(&index.list_claude_sessions(home.path(), PROJECT)), ["bbb"]);
    assert_eq!(index.claude_cache_stats().cached, 2); // bbb + empty
    fs::remove_dir_all(&cdir).unwrap();
    assert_eq!(index.list_claude_sessions(home.path(), PROJECT), []);
    assert_eq!(index.claude_cache_stats().cached, 0);
}

#[test]
fn async_listing_equals_the_sync_listing_on_a_cold_cache() {
    // 1.1.4 had a sync and an async reader over one cache; here there is one reader: a cold and a warm listing agree.
    let home = fake_home();
    let index = SessionIndex::new();
    let cold = index.list_claude_sessions(home.path(), PROJECT);
    assert_eq!(index.list_claude_sessions(home.path(), PROJECT), cold);
    index.clear_claude_cache();
    assert_eq!(index.list_claude_sessions(home.path(), PROJECT), cold);
}

#[test]
fn lists_codex_sessions_for_the_project_only_skipping_injected_context() {
    let home = fake_home();
    let list = SessionIndex::new().list_codex_sessions(home.path(), &(PROJECT.to_lowercase() + "\\")).unwrap();
    assert_eq!(list.len(), 1);
    assert_eq!((list[0].cli, list[0].id.clone(), list[0].title.as_str()), ("codex", json!("c1"), "dodaj testy"));
}

#[test]
fn finds_a_recently_written_codex_session_not_bound_elsewhere() {
    let home = fake_home();
    let index = SessionIndex::new();
    let minute = Duration::from_secs(60);
    assert_eq!(index.find_recent_codex_session(home.path(), PROJECT, minute, &HashSet::new()).unwrap(), Some(json!("c1")));
    let bound: HashSet<String> = ["c1".to_string()].into();
    assert_eq!(index.find_recent_codex_session(home.path(), PROJECT, minute, &bound).unwrap(), None);
    assert_eq!(index.find_recent_codex_session(home.path(), "D:Nowhere", minute, &HashSet::new()).unwrap(), None);
}

fn filler(n: usize, id: &str, ch: &str) -> Vec<Value> {
    (0..n)
        .map(|i| json!({ "type": "assistant", "sessionId": id, "message": { "content": format!("{}{i}", ch.repeat(900)) } }))
        .collect()
}

#[test]
fn keeps_the_head_of_a_growing_claude_transcript_and_re_reads_only_its_tail() {
    let index = SessionIndex::new();
    let h = tempfile::Builder::new().prefix("mc-inc-").tempdir().unwrap();
    let cdir = h.path().join(".claude").join("projects").join(claude_project_dir_name(PROJECT));
    fs::create_dir_all(&cdir).unwrap();
    let file = cdir.join("big.jsonl");
    let mut rows = vec![
        json!({ "type": "user", "message": { "content": "pierwszy prompt" }, "sessionId": "big", "cwd": PROJECT, "timestamp": "2026-10-03T10:00:00Z" }),
        json!({ "type": "ai-title", "aiTitle": "Tytul z glowy", "sessionId": "big" }),
    ];
    rows.extend(filler(400, "big", "x")); // well over the 256 KB head
    fs::write(&file, jsonl(&rows)).unwrap();
    let first = index.list_claude_sessions(h.path(), PROJECT);
    assert_eq!(
        (first[0].id.clone(), first[0].title.as_str(), first[0].cwd.clone(), first[0].started_at),
        (json!("big"), "Tytul z glowy", json!(PROJECT), date::parse("2026-10-03T10:00:00Z"))
    );
    assert_eq!((index.claude_cache_stats().parses, index.claude_cache_stats().tail_reads), (1, 0));

    let append = |rows: &[Value], later: f64| {
        let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
        std::io::Write::write_all(&mut f, jsonl(rows).as_bytes()).unwrap();
        drop(f);
        set_mtime(&file, now_ms() + later);
    };
    let mut more = filler(5, "big", "x");
    more.push(json!({ "type": "ai-title", "aiTitle": "Nowy tytul", "sessionId": "big" }));
    append(&more, 5000.0);
    let second = index.list_claude_sessions(h.path(), PROJECT);
    assert_eq!((second[0].title.as_str(), second[0].cwd.clone()), ("Nowy tytul", json!(PROJECT)));
    assert_eq!((index.claude_cache_stats().parses, index.claude_cache_stats().tail_reads), (1, 1));

    append(&[json!({ "type": "custom-title", "customTitle": "Moja nazwa", "sessionId": "big" })], 10_000.0);
    assert_eq!(index.list_claude_sessions(h.path(), PROJECT)[0].title, "Moja nazwa");
    assert_eq!((index.claude_cache_stats().parses, index.claude_cache_stats().tail_reads), (1, 2));

    // A cold read gives the same answer as the incremental one.
    let warm = index.list_claude_sessions(h.path(), PROJECT);
    index.clear_claude_cache();
    assert_eq!(index.list_claude_sessions(h.path(), PROJECT), warm);

    // A rewritten (shorter) file is parsed in full again.
    fs::write(
        &file,
        jsonl(&[json!({ "type": "user", "message": { "content": "od nowa" }, "sessionId": "big", "cwd": PROJECT })]),
    )
    .unwrap();
    assert_eq!(index.list_claude_sessions(h.path(), PROJECT)[0].title, "od nowa");
    assert_eq!(index.claude_cache_stats().parses, 2);
}

#[test]
fn reads_the_head_again_when_a_large_transcript_was_replaced_by_a_new_file_that_is_not_shorter() {
    let index = SessionIndex::new();
    let h = tempfile::tempdir().unwrap();
    let cdir = h.path().join(".claude").join("projects").join(claude_project_dir_name(PROJECT));
    fs::create_dir_all(&cdir).unwrap();
    let file = cdir.join("swap.jsonl");
    let big = |prompt: &str, extra: usize| {
        let mut rows = vec![json!({ "type": "user", "message": { "content": prompt }, "sessionId": "swap", "cwd": PROJECT })];
        rows.extend(filler(400 + extra, "swap", "y"));
        jsonl(&rows)
    };
    fs::write(&file, big("stary prompt", 0)).unwrap();
    assert_eq!(index.list_claude_sessions(h.path(), PROJECT)[0].title, "stary prompt");
    fs::remove_file(&file).unwrap();
    std::thread::sleep(Duration::from_millis(20));
    fs::write(&file, big("nowy prompt", 10)).unwrap();
    set_mtime(&file, now_ms() + 5000.0);
    assert_eq!(index.list_claude_sessions(h.path(), PROJECT)[0].title, "nowy prompt");
    assert_eq!((index.claude_cache_stats().parses, index.claude_cache_stats().tail_reads), (2, 0));
}

#[test]
fn walks_codex_day_folders_newest_first_stops_early_and_lists_an_unchanged_folder_only_once() {
    let index = SessionIndex::new();
    let h = tempfile::tempdir().unwrap();
    let write = |day: &str, count: usize, prefix: &str| {
        let mut dir = h.path().join(".codex").join("sessions");
        for part in day.split('/') {
            dir = dir.join(part);
        }
        fs::create_dir_all(&dir).unwrap();
        for i in 0..count {
            let id = format!("{prefix}{i:02}");
            let meta =
                json!({ "type": "session_meta", "payload": { "id": id, "cwd": PROJECT, "timestamp": "2026-10-06T10:00:00Z" } });
            let user = json!({ "type": "event_msg", "payload": { "type": "user_message", "message": format!("zadanie {id}") } });
            fs::write(dir.join(format!("rollout-{}T10-00-{i:02}-{id}.jsonl", day.replace('/', "-"))), jsonl(&[meta, user]))
                .unwrap();
        }
    };
    write("2025/12/31", 2, "old");
    write("2026/09/30", 3, "sep");
    write("2026/10/02", 3, "oct");
    let list = index.list_codex_sessions(h.path(), PROJECT).unwrap();
    assert_eq!(ids(&list), ["oct00", "oct01", "oct02", "old00", "old01", "sep00", "sep01", "sep02"]);
    let reads = index.codex_cache_stats().dir_reads;
    assert_eq!(reads, 1 + 2 + 3 + 3); // sessions, two years, three months, three days

    // Within the shared window every worktree path reuses the same index (no folder is listed again).
    index.list_sessions(h.path(), &format!("{PROJECT}\\wt"), &[], None).unwrap();
    assert_eq!(index.codex_cache_stats().dir_reads, reads);

    // The bind lookup needs only the 80 newest files: once the newest day has them, older folders are never listed.
    index.clear_codex_cache();
    write("2026/10/02", 80, "new");
    let id = index.find_recent_codex_session(h.path(), PROJECT, Duration::from_secs(60), &HashSet::new()).unwrap().unwrap();
    assert!(id.as_str().unwrap().starts_with("new") || id.as_str().unwrap().starts_with("oct"), "{id}");
    assert_eq!(index.codex_cache_stats().dir_reads, 4); // sessions, 2026, 10, 02
}

#[test]
fn lists_conversations_of_known_and_removed_repo_wt_worktrees_labelled_and_never_of_unrelated_folders() {
    let index = SessionIndex::new();
    let home = tempfile::Builder::new().prefix("mc-home-wt-").tempdir().unwrap();
    let parent = tempfile::Builder::new().prefix("mc-parent-").tempdir().unwrap();
    let p = |name: &str| parent.path().join(name).to_string_lossy().into_owned();
    let project = p("app");
    let live = p("app-wt-grid-1"); // open cell, branch known from state
    let loose = p("app-wt-left"); // still on disk, no cell knows it: branch asked from git
    let removed = p("app-wt-old"); // folder gone
    let unrelated = parent.path().join("app-wt-x").join("nested").to_string_lossy().into_owned(); // deeper than a worktree
    let other = p("apple-wt-1"); // another project's worktree
    for dir in [&project, &live, &loose] {
        fs::create_dir_all(dir).unwrap();
    }
    let claude = |cwd: &str, id: &str, text: &str| {
        let dir = home.path().join(".claude").join("projects").join(claude_project_dir_name(cwd));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("{id}.jsonl")),
            jsonl(&[json!({ "type": "user", "message": { "content": text }, "sessionId": id, "cwd": cwd, "timestamp": "2026-10-01T10:00:00Z" })]),
        )
        .unwrap();
    };
    claude(&project, "main", "main project");
    claude(&live, "live", "in the live worktree");
    claude(&removed, "gone", "in a removed worktree");
    claude(&unrelated, "nested", "nested folder");
    claude(&other, "apple", "other project");
    let xdir = home.path().join(".codex").join("sessions").join("2026").join("10").join("06");
    fs::create_dir_all(&xdir).unwrap();
    let codex = |id: &str, cwd: &str, text: &str| {
        fs::write(
            xdir.join(format!("rollout-2026-10-06T10-00-00-{id}.jsonl")),
            jsonl(&[
                json!({ "type": "session_meta", "payload": { "id": id, "cwd": cwd, "timestamp": "2026-10-06T10:00:00Z" } }),
                json!({ "type": "response_item", "payload": { "type": "message", "role": "user", "content": [{ "type": "input_text", "text": text }] } }),
            ]),
        )
        .unwrap();
    };
    codex("cx-loose", &loose, "codex in the loose worktree");
    codex("cx-other", &other, "codex elsewhere");

    let loose_path = loose.clone();
    let branch_of = move |path: &str| (path == loose_path).then(|| "mc/left".to_string());
    let hints = [WorktreeHint { path: live.clone(), branch: "mc/grid-1".into() }];
    let list = index.list_sessions(home.path(), &project, &hints, Some(&branch_of)).unwrap();
    assert_eq!(ids(&list), ["cx-loose", "gone", "live", "main"]);
    assert_eq!(by_id(&list, "main").worktree, None);
    let label = |path: &str, label: &str, branch: Option<&str>, exists: bool| {
        Some(WorktreeLabel { path: path.into(), label: label.into(), exists, branch: branch.map(str::to_string) })
    };
    assert_eq!(by_id(&list, "live").worktree, label(&live, "mc/grid-1", Some("mc/grid-1"), true));
    assert_eq!(by_id(&list, "cx-loose").worktree, label(&loose, "mc/left", Some("mc/left"), true));
    assert_eq!(by_id(&list, "gone").worktree, label(&removed, "app-wt-old", None, false));
    assert_eq!(
        by_id(&list, "live").to_json()["worktree"],
        json!({ "path": live, "label": "mc/grid-1", "exists": true, "branch": "mc/grid-1" })
    );
    assert_eq!(by_id(&list, "gone").to_json()["worktree"], json!({ "path": removed, "label": "app-wt-old", "exists": false }));

    // Without worktree hints the pattern still finds them; the project's own listing is unchanged.
    assert_eq!(ids(&index.list_sessions(home.path(), &project, &[], None).unwrap()), ["cx-loose", "gone", "live", "main"]);
    assert_eq!(ids(&index.list_claude_sessions(home.path(), &project)), ["main"]);
}

#[test]
fn a_non_string_cwd_fails_the_listing_like_the_type_error_of_1_1_4() {
    let index = SessionIndex::new();
    let home = tempfile::tempdir().unwrap();
    let xdir = home.path().join(".codex").join("sessions").join("2026").join("10").join("06");
    fs::create_dir_all(&xdir).unwrap();
    fs::write(
        xdir.join("rollout-2026-10-06T10-00-00-n1.jsonl"),
        jsonl(&[json!({ "type": "session_meta", "payload": { "id": 7, "cwd": 5 } })]),
    )
    .unwrap();
    assert!(index.list_sessions(home.path(), PROJECT, &[], None).is_err());
    assert!(index.find_recent_codex_session(home.path(), PROJECT, Duration::from_secs(60), &HashSet::new()).is_err());
}

#[test]
fn normalizes_project_paths_like_the_shared_helper() {
    assert_eq!(normalize_project_path("D:\\Projekty\\Bot\\\\"), "d:/projekty/bot");
    assert_eq!(normalize_project_path("\\\\Srv\\Share\\"), "//srv/share");
    assert_eq!(normalize_project_path("/Users/A/"), "/Users/A");
    assert_eq!(normalize_project_path("C:\\İ"), "c:/i\u{307}");
}
