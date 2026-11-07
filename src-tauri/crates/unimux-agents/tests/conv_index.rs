//! Ports of test/conv-search.test.ts ("ConvIndexer", "query sanitizing") and test/conv-export.test.ts over the same fixtures,
//! plus the service (idle stop, cache file, timeouts).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde_json::{Value, json};
use unimux_agents::conv::export::{EXPORT_LIMITS, ExportLimits, locate_session, read_export};
use unimux_agents::conv::indexer::{Indexer, IndexerOptions, mtime_ms, quick_stat};
use unimux_agents::conv::search::{ConvQuery, normalize_folder};
use unimux_agents::conv::service::{ConvSearchService, ExportSource, sanitize_export_source, sanitize_query};
use unimux_agents::conv::{ConvCli, Roots, date};

const ALPHA: &str = "11111111-aaaa-4bbb-8ccc-000000000001";
const THEME: &str = "22222222-aaaa-4bbb-8ccc-000000000002";
const CODEX: &str = "0199aaaa-bbbb-7ccc-8ddd-000000000010";

fn fixtures(name: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../test/fixtures").join(name)
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).unwrap();
    for e in std::fs::read_dir(from).unwrap().flatten() {
        let target = to.join(e.file_name());
        if e.file_type().unwrap().is_dir() {
            copy_dir(&e.path(), &target);
        } else {
            std::fs::copy(e.path(), &target).unwrap();
        }
    }
}

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

fn setup() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    copy_dir(&fixtures("convsearch"), dir.path());
    dir
}

fn roots(dir: &Path) -> Roots {
    Roots { claude: vec![s(&dir.join("claude"))], codex: vec![s(&dir.join("codex"))] }
}

fn make(dir: &Path, cache: Option<PathBuf>) -> Indexer {
    Indexer::new(IndexerOptions { fresh_ms: 0.0, ..IndexerOptions::new(roots(dir), cache) })
}

fn q(text: &str) -> ConvQuery {
    ConvQuery { text: text.into(), ..Default::default() }
}

fn ids(r: &Value) -> Vec<String> {
    r["hits"].as_array().unwrap().iter().map(|h| h["id"].as_str().unwrap().to_string()).collect()
}

fn hit<'a>(r: &'a Value, id: &str) -> &'a Value {
    r["hits"].as_array().unwrap().iter().find(|h| h["id"] == json!(id)).unwrap()
}

// conv-search.test.ts: "indexes both formats and searches across projects"
#[test]
fn indexes_both_formats_and_searches_across_projects() {
    let dir = setup();
    let ix = make(dir.path(), None);
    ix.refresh(true);
    let all = ix.search(&q(""));
    // The session without any prompt is not listed.
    let mut got = ids(&all);
    got.sort();
    let mut want = vec![CODEX.to_string(), ALPHA.to_string(), THEME.to_string()];
    want.sort();
    assert_eq!(got, want);
    let alpha = hit(&all, ALPHA);
    assert_eq!(alpha["cli"], "claude");
    assert_eq!(alpha["cwd"], "D:\\work\\alpha");
    assert_eq!(alpha["title"], "Fix state.json losing tabs");
    assert_eq!(alpha["model"], "claude-opus-5-5");
    assert_eq!(alpha["messages"], 4);
    assert_eq!(hit(&all, THEME)["title"], "Theme toggle");
    let codex = hit(&all, CODEX);
    assert_eq!(codex["cli"], "codex");
    assert_eq!(codex["cwd"], "D:\\work\\beta");
    assert_eq!(codex["title"], "Migrate the Redis client to the new pool API");
    assert_eq!(codex["model"], "gpt-6.1-sol");
    assert_eq!(codex["messages"], 2);

    // Tool output, instructions, thinking and sidechains are not indexed.
    assert_eq!(ix.search(&q("zebracorn"))["total"], 0);
    assert_eq!(ix.search(&q("flamingo"))["total"], 0);
    assert_eq!(ix.search(&q("secret reasoning"))["total"], 0);

    let r = ix.search(&q("zazolc rename"));
    assert_eq!(ids(&r), vec![ALPHA]);
    let idx: Vec<u64> = r["hits"][0]["snippets"].as_array().unwrap().iter().map(|s| s["index"].as_u64().unwrap()).collect();
    assert_eq!(idx, vec![0, 2]);
    assert_eq!(ids(&ix.search(&ConvQuery { cli: Some("codex".into()), ..q("pool") })), vec![CODEX]);
    assert_eq!(ix.search(&ConvQuery { cli: Some("claude".into()), ..q("pool") })["total"], 0);
    assert_eq!(ids(&ix.search(&ConvQuery { project: Some(normalize_folder("D:/work/beta")), ..q("") })), vec![CODEX]);
    let mut keys: Vec<String> =
        all["projects"].as_array().unwrap().iter().map(|p| p["key"].as_str().unwrap().to_string()).collect();
    keys.sort();
    assert_eq!(keys, vec!["d:/work/alpha", "d:/work/beta"]);
    assert_eq!(all["indexing"], Value::Null);
}

// conv-search.test.ts: "reads only what a grown transcript gained, and a replaced one again"
#[test]
fn reads_only_what_a_grown_transcript_gained_and_a_replaced_one_again() {
    let dir = setup();
    let ix = make(dir.path(), None);
    ix.refresh(true);
    assert_eq!(ix.stats().full_reads, 4);
    let file = dir.path().join("claude").join("projects").join("D--work-alpha").join(format!("{THEME}.jsonl"));
    let line = json!({"type": "user", "message": {"role": "user", "content": "and a purple accent colour"}, "sessionId": THEME, "timestamp": "2026-10-19T00:00:00Z"});
    let mut text = std::fs::read_to_string(&file).unwrap();
    text.push_str(&format!("{line}\n"));
    std::fs::write(&file, text).unwrap();
    ix.refresh(true);
    assert_eq!((ix.stats().full_reads, ix.stats().append_reads), (4, 1));
    let r = ix.search(&q("purple"));
    assert_eq!(ids(&r), vec![THEME]);
    assert_eq!(r["hits"][0]["messages"], 3);
    // Unchanged files are not read at all.
    ix.refresh(true);
    assert_eq!((ix.stats().full_reads, ix.stats().append_reads), (4, 1));
    // A shorter file (replaced) is read from the start.
    let line = json!({"type": "user", "message": {"role": "user", "content": "brand new"}, "sessionId": THEME});
    std::fs::write(&file, format!("{line}\n")).unwrap();
    ix.refresh(true);
    assert_eq!(ix.stats().full_reads, 5);
    assert_eq!(ix.search(&q("purple"))["total"], 0);
    assert_eq!(ix.search(&q("brand new"))["total"], 1);
}

// conv-search.test.ts: "drops removed files, survives missing folders and keeps the index in its cache file"
#[test]
fn drops_removed_files_survives_missing_folders_and_keeps_the_index_in_its_cache_file() {
    let dir = setup();
    let cache = dir.path().join("data").join("conversation-index-v2.bin");
    let ix = make(dir.path(), Some(cache.clone()));
    ix.refresh(true);
    ix.save();
    let again = make(dir.path(), Some(cache.clone()));
    again.refresh(true);
    assert_eq!(again.stats().full_reads, 0);
    assert_eq!(ids(&again.search(&q("rename"))), vec![ALPHA]);
    // The cached documents are the same as freshly read ones.
    assert_eq!(again.entries(), ix.entries());

    std::fs::remove_dir_all(dir.path().join("codex")).unwrap();
    again.refresh(true);
    let clis: Vec<String> =
        again.search(&q(""))["hits"].as_array().unwrap().iter().map(|h| h["cli"].as_str().unwrap().into()).collect();
    assert_eq!(clis, vec!["claude", "claude"]);

    let missing = Indexer::new(IndexerOptions {
        fresh_ms: 0.0,
        ..IndexerOptions::new(
            Roots { claude: vec![s(&dir.path().join("nope"))], codex: vec![s(&dir.path().join("nope2"))] },
            None,
        )
    });
    missing.refresh(true);
    let r = missing.search(&q("x"));
    assert_eq!((r["total"].clone(), r["conversations"].clone()), (json!(0), json!(0)));

    std::fs::write(&cache, "garbage").unwrap();
    let broken = make(dir.path(), Some(cache));
    broken.refresh(true);
    assert_eq!(broken.search(&q("rename"))["total"], 1);
}

// conv-search.test.ts: "reads the transcript preview of indexed files only, with message indexes that match the snippets"
#[test]
fn reads_the_transcript_preview_of_indexed_files_only_with_message_indexes_that_match_the_snippets() {
    let dir = setup();
    let ix = make(dir.path(), None);
    ix.refresh(true);
    let r = ix.search(&q("regresji"));
    let h = &r["hits"][0];
    let t = ix.transcript(h["file"].as_str().unwrap());
    assert_eq!(t["ok"], true);
    let roles: Vec<&str> = t["messages"].as_array().unwrap().iter().map(|m| m["role"].as_str().unwrap()).collect();
    assert_eq!(roles, vec!["user", "assistant", "assistant", "user"]);
    let i = h["snippets"][0]["index"].as_u64().unwrap() as usize;
    assert!(t["messages"][i]["text"].as_str().unwrap().contains("regresji"));
    assert_eq!(ix.transcript(&s(&dir.path().join("elsewhere.jsonl")))["ok"], false);
}

// conv-search.test.ts: "caps the text of a huge conversation"
#[test]
fn caps_the_text_of_a_huge_conversation() {
    let dir = setup();
    let big = dir.path().join("claude").join("projects").join("D--big");
    std::fs::create_dir_all(&big).unwrap();
    let lines: Vec<String> = (0..400)
        .map(|i| json!({"type": "user", "message": {"role": "user", "content": format!("{i} {}", "word ".repeat(2000))}, "sessionId": "big", "cwd": "D:\\big"}).to_string())
        .collect();
    std::fs::write(big.join("big.jsonl"), lines.join("\n") + "\n").unwrap();
    let ix = make(dir.path(), None);
    ix.refresh(true);
    let r = ix.search(&ConvQuery { project: Some(normalize_folder("D:\\big")), ..q("") });
    let messages = r["hits"][0]["messages"].as_u64().unwrap();
    assert!(messages < 400 && messages > 100, "{messages}");
}

// conv-search.test.ts: "keeps only known query fields"
#[test]
fn keeps_only_known_query_fields() {
    let got = sanitize_query(
        &json!({"text": "x".repeat(1000), "cli": "bash", "role": "user", "from": "yesterday", "to": 5, "limit": 99999, "evil": 1}),
    );
    assert_eq!(
        got,
        ConvQuery { text: "x".repeat(400), role: Some("user".into()), to: Some(5.0), limit: Some(500.0), ..Default::default() }
    );
    assert_eq!(sanitize_query(&Value::Null), ConvQuery::default());
}

// ── conv-export.test.ts ──────────────────────────────────────────────────────

const CODEX_ID: &str = "0199bbbb-cccc-7ddd-8eee-000000000020";

fn export_file(name: &str) -> String {
    s(&fixtures("convexport").join(name))
}

fn items(v: &Value) -> Vec<String> {
    v["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            if i["kind"] == "tool" {
                format!("tool:{}:{}", i["name"].as_str().unwrap(), i["detail"].as_str().unwrap())
            } else {
                format!("{}:{}", i["role"].as_str().unwrap(), i["text"].as_str().unwrap())
            }
        })
        .collect()
}

// conv-export.test.ts: "reads a Claude transcript: texts and tool calls, never tool output, thinking, injected or sidechain messages"
#[test]
fn reads_a_claude_transcript_texts_and_tool_calls_never_tool_output_thinking_injected_or_sidechain_messages() {
    let data = read_export(&export_file("claude.jsonl"), ConvCli::Claude, EXPORT_LIMITS).unwrap();
    assert_eq!(data["ok"], true);
    assert_eq!(data["id"], "44444444-aaaa-4bbb-8ccc-000000000004");
    assert_eq!(data["title"], "Fix the failing tests");
    assert_eq!(data["cwd"], "D:\\work\\alpha");
    assert_eq!(data["model"], "claude-opus-5-5");
    assert_eq!(data["startedAt"].as_f64().unwrap(), date::parse("2026-10-20T08:00:00.500Z"));
    let t = |s: &str| date::parse(s) as i64;
    assert_eq!(
        data["items"],
        json!([
            {"kind": "msg", "role": "user", "text": "Napraw testy w `src/a.ts`, proszę.", "ts": t("2026-10-20T08:00:01.000Z")},
            {"kind": "msg", "role": "assistant", "text": "Uruchomię najpierw testy.", "ts": t("2026-10-20T08:00:03.000Z")},
            {"kind": "tool", "name": "Bash", "detail": "npm test", "ts": t("2026-10-20T08:00:04.000Z")},
            {"kind": "tool", "name": "Edit", "detail": "src/a.ts", "ts": t("2026-10-20T08:00:06.000Z")},
            {"kind": "msg", "role": "assistant", "text": "Poprawione:\n\n- `a` zamienione na `b`\n- testy przechodzą", "ts": t("2026-10-20T08:00:09.000Z")},
            {"kind": "msg", "role": "user", "text": "Dzięki!", "ts": t("2026-10-20T08:01:00.000Z")},
        ])
    );
    let all = data.to_string();
    for hidden in ["secret reasoning", "secret tool output", "sidechain prompt", "command-name"] {
        assert!(!all.contains(hidden), "{hidden}");
    }
}

// conv-export.test.ts: "reads a Codex rollout: shell commands without the shell wrapper, apply_patch as its files, no reasoning or output"
#[test]
fn reads_a_codex_rollout_shell_commands_without_the_shell_wrapper_apply_patch_as_its_files_no_reasoning_or_output() {
    let data = read_export(&export_file(&format!("rollout-2026-10-21T10-00-00-{CODEX_ID}.jsonl")), ConvCli::Codex, EXPORT_LIMITS)
        .unwrap();
    assert_eq!(data["id"], CODEX_ID);
    assert_eq!(data["model"], "gpt-6.1-sol");
    assert_eq!(data["cwd"], "D:\\work\\beta");
    assert_eq!(data["title"], "Migrate the Redis client to the new pool API");
    assert_eq!(
        items(&data),
        vec![
            "user:Migrate the Redis client to the new pool API",
            "tool:shell:rg createPool src",
            "tool:apply_patch:src/redis.ts",
            "assistant:The pool now comes from createPool() and every command borrows a connection.",
        ]
    );
    let all = data.to_string();
    for hidden in ["hidden reasoning", "secret output", "developer text", "AGENTS.md"] {
        assert!(!all.contains(hidden), "{hidden}");
    }
}

// conv-export.test.ts: "stops at the limits and says so"
#[test]
fn stops_at_the_limits_and_says_so() {
    let data =
        read_export(&export_file("claude.jsonl"), ConvCli::Claude, ExportLimits { doc_chars: 60, message_chars: 10, items: 100 })
            .unwrap();
    assert_eq!(data["capped"], true);
    let first = &data["items"][0];
    assert_eq!(first["cut"], true);
    assert_eq!(first["text"].as_str().unwrap().encode_utf16().count(), 10);
    let total: usize = data["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|i| {
            let n = |k: &str| i[k].as_str().unwrap().encode_utf16().count();
            if i["kind"] == "msg" { n("text") } else { n("name") + n("detail") }
        })
        .sum();
    assert!(total <= 60);
}

// conv-export.test.ts: "finds Claude and Codex sessions by id and refuses ids that could be paths"
#[test]
fn finds_claude_and_codex_sessions_by_id_and_refuses_ids_that_could_be_paths() {
    let root = tempfile::tempdir().unwrap();
    let claude_dir = root.path().join("claude").join("projects").join("D--work-alpha");
    let codex_dir = root.path().join("codex").join("sessions").join("2026").join("10").join("21");
    std::fs::create_dir_all(&claude_dir).unwrap();
    std::fs::create_dir_all(&codex_dir).unwrap();
    std::fs::write(claude_dir.join("abc-1.jsonl"), "{}\n").unwrap();
    let rollout = codex_dir.join(format!("rollout-2026-10-21T10-00-00-{CODEX_ID}.jsonl"));
    std::fs::write(&rollout, "{}\n").unwrap();
    let roots = roots(root.path());
    assert_eq!(locate_session(ConvCli::Claude, "abc-1", &roots), Some(s(&claude_dir.join("abc-1.jsonl"))));
    assert_eq!(locate_session(ConvCli::Codex, CODEX_ID, &roots), Some(s(&rollout)));
    assert_eq!(locate_session(ConvCli::Claude, "missing", &roots), None);
    assert_eq!(locate_session(ConvCli::Claude, "../abc-1", &roots), None);
    assert_eq!(sanitize_export_source(&json!({"cli": "claude", "id": "..\\x"})), None);
    assert_eq!(sanitize_export_source(&json!({"cli": "shell", "id": "x"})), None);
    assert_eq!(
        sanitize_export_source(&json!({"cli": "codex", "id": CODEX_ID})),
        Some(ExportSource::Session { cli: ConvCli::Codex, id: CODEX_ID.into() })
    );
    assert_eq!(
        sanitize_export_source(&json!({"file": "D:\\a.jsonl", "extra": 1})),
        Some(ExportSource::File("D:\\a.jsonl".into()))
    );
}

// ── the service (convSearchClient + worker) ──────────────────────────────────

fn service(dir: &Path, idle: Duration) -> Arc<ConvSearchService> {
    let roots = roots(dir);
    let cache = dir.join("data").join("conversation-index-v2.bin");
    ConvSearchService::new(move || IndexerOptions::new(roots.clone(), Some(cache.clone())), idle)
}

fn wait_for(what: &str, mut f: impl FnMut() -> bool) {
    let until = std::time::Instant::now() + Duration::from_secs(20);
    while !f() {
        assert!(std::time::Instant::now() < until, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

#[test]
fn the_first_search_answers_at_once_and_says_a_pass_runs() {
    let dir = setup();
    let svc = service(dir.path(), Duration::from_secs(600));
    let first = svc.search(q("rename"));
    // The pass was only started: nothing is indexed yet, or it is still running.
    assert!(first["indexing"].is_object() || first["total"] == 1, "{first}");
    // The hit can be there before the pass has ended (its last file was read): wait for both.
    wait_for("the pass", || {
        let r = svc.search(q("rename"));
        r["total"] == 1 && r["indexing"].is_null()
    });
    let done = svc.search(q("rename"));
    assert_eq!(done["indexing"], Value::Null);
    assert!(done["tookMs"].is_number());
    // A file the index knows is exported; an unknown one is refused; a session is found by id.
    let file = done["hits"][0]["file"].as_str().unwrap().to_string();
    assert_eq!(svc.export_data(ExportSource::File(file.clone()))["ok"], true);
    assert_eq!(svc.export_data(ExportSource::File(s(&dir.path().join("x.jsonl"))))["error"], "unknown");
    assert_eq!(svc.export_data(ExportSource::Session { cli: ConvCli::Claude, id: ALPHA.into() })["id"], ALPHA);
    assert_eq!(svc.export_data(ExportSource::Session { cli: ConvCli::Codex, id: "nope".into() })["error"], "not-found");
    assert_eq!(svc.transcript(file)["ok"], true);
    svc.stop();
}

#[test]
fn idle_stop_saves_the_index_into_the_v2_file_and_leaves_the_old_one_alone() {
    let dir = setup();
    let data = dir.path().join("data");
    std::fs::create_dir_all(&data).unwrap();
    let old = data.join("conversation-index.bin");
    // A v8.serialize file of 1.1.4 (any bytes): never read, never written.
    let old_bytes = b"\xff\x0f\x6f\x22\x07version\x49\x02".to_vec();
    std::fs::write(&old, &old_bytes).unwrap();
    let svc = service(dir.path(), Duration::from_millis(400));
    wait_for("the pass", || svc.search(q("rename"))["total"] == 1);
    // Fewer than 8 files were read, so the pass itself did not save; the idle stop does.
    let v2 = data.join("conversation-index-v2.bin");
    wait_for("the idle stop", || !svc.running());
    assert!(v2.exists());
    assert_eq!(std::fs::read(&old).unwrap(), old_bytes);
    // The next request starts a new index that loads the saved one (no full read again).
    let r = svc.search(q("rename"));
    assert_eq!(r["total"], 1, "{r}");
    svc.stop();
}

#[test]
fn the_quick_stat_of_a_pass_gives_what_fs_metadata_gives() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("a b ł.jsonl");
    std::fs::write(
        &file, b"{}
{}
",
    )
    .unwrap();
    let st = std::fs::metadata(&file).unwrap();
    let birth = st.created().map(unimux_agents::conv::indexer::ms_of).unwrap_or(0.0);
    assert_eq!(quick_stat(&s(&file)).unwrap(), (6, mtime_ms(&st), birth));
    // A folder and a missing file: what fs::metadata answers.
    assert!(quick_stat(&s(dir.path())).is_ok());
    let missing = quick_stat(&s(&dir.path().join("nope.jsonl"))).unwrap_err();
    assert_eq!(missing.kind(), std::io::ErrorKind::NotFound);
}
