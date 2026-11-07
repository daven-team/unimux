//! test/search.test.ts of 1.1.4, ported (test/PORTING.md), plus the Rust-only cases (links, cancel, the readers).

use std::cell::Cell;
use std::fs;
use std::path::Path;
use std::sync::atomic::AtomicBool;

use serde_json::{Value, json};
use unimux_files::jsregex::JsRegex;
use unimux_files::project::list_project_directories;
use unimux_files::search::{
    MAX_LINE_LENGTH, Only, SearchOptions, build_pattern, clock, compile_globs, replace_in_project, replace_in_text,
    search_project, search_text,
};

fn u(s: &str) -> Vec<u16> {
    s.encode_utf16().collect()
}

fn regex_of(options: Value) -> JsRegex {
    build_pattern(&SearchOptions::from_json(&options).unwrap()).unwrap()
}

fn texts(text: &str, options: Value) -> Vec<String> {
    search_text(&u(text), &regex_of(options), 5000).0.into_iter().map(|m| m.text).collect()
}

fn columns(text: &str, options: Value) -> Vec<usize> {
    search_text(&u(text), &regex_of(options), 5000).0.into_iter().map(|m| m.column).collect()
}

fn replace(text: &str, re: &JsRegex, replacement: &str, expand: bool, only: Option<Only>) -> (String, usize) {
    let (out, count) = replace_in_text(&u(text), re, &u(replacement), expand, only.as_ref());
    (String::from_utf16(&out).unwrap(), count)
}

#[test]
fn escapes_literal_queries_and_ignores_case_unless_asked() {
    assert_eq!(texts("a.b A.B axb", json!({ "query": "a.b" })), ["a.b", "A.B"]);
    assert_eq!(texts("a.b A.B", json!({ "query": "a.b", "caseSensitive": true })), ["a.b"]);
}

#[test]
fn matches_whole_words_including_letters_outside_ascii() {
    assert_eq!(columns("żółw żółwik mały-żółw", json!({ "query": "żółw", "wholeWord": true })), [0, 17]);
    assert_eq!(columns("cat concat cat_ cat", json!({ "query": "cat", "wholeWord": true })), [0, 16]);
}

#[test]
fn supports_regular_expressions_and_reports_invalid_ones() {
    assert_eq!(texts("id=12 id=7", json!({ "query": "id=(\\d+)", "regex": true })), ["id=12", "id=7"]);
    let bad = build_pattern(&SearchOptions::from_json(&json!({ "query": "(", "regex": true })).unwrap()).unwrap_err();
    assert_eq!(bad.as_deref(), Some("Invalid regular expression: /(/gi: Unterminated group"));
    assert!(build_pattern(&SearchOptions::from_json(&json!({ "query": "" })).unwrap()).unwrap_err().is_none());
}

#[test]
fn reports_line_and_column_of_every_match_and_a_shortened_preview() {
    let long = format!("{}needle{}", "x".repeat(200), "y".repeat(400));
    let (matches, _) =
        search_text(&u(&format!("first\r\nsecond needle\nthird\r{long}")), &regex_of(json!({ "query": "needle" })), 5000);
    assert_eq!(matches.iter().map(|m| (m.line, m.column)).collect::<Vec<_>>(), [(2, 7), (4, 200)]);
    assert_eq!((matches[0].preview.as_str(), matches[0].match_start, matches[0].match_length), ("second needle", 7, 6));
    let shortened = &matches[1];
    assert!(shortened.preview.starts_with('…'));
    let preview = u(&shortened.preview);
    assert_eq!(
        String::from_utf16(&preview[shortened.match_start..shortened.match_start + shortened.match_length]).unwrap(),
        "needle"
    );
    assert!(preview.len() < 260);
}

#[test]
fn skips_empty_matches_and_giant_lines_and_stops_at_the_limit() {
    assert!(texts("abc", json!({ "query": "x*", "regex": true })).is_empty());
    assert!(texts(&"a".repeat(MAX_LINE_LENGTH + 1), json!({ "query": "a" })).is_empty());
    let (limited, truncated) = search_text(&u("a a a a a"), &regex_of(json!({ "query": "a" })), 3);
    assert_eq!(limited.len(), 3);
    assert!(truncated);
}

#[test]
fn replaces_literally_unless_the_search_is_a_regular_expression() {
    let cost = regex_of(json!({ "query": "cost" }));
    assert_eq!(replace("cost $5, cost $6", &cost, "$&!", false, None), ("$&! $5, $&! $6".into(), 2));
    let re = regex_of(json!({ "query": "(\\w+)@(?<host>\\w+)", "regex": true }));
    assert_eq!(
        replace("ann@home bob@work", &re, "$2:$1 [$<host>] $$ $&", true, None),
        ("home:ann [home] $ ann@home work:bob [work] $ bob@work".into(), 2)
    );
}

#[test]
fn replaces_one_occurrence_and_keeps_every_kind_of_line_ending() {
    let text = "one\r\ntwo two\ntwo\rend";
    let re = regex_of(json!({ "query": "two" }));
    assert_eq!(replace(text, &re, "2", false, None), ("one\r\n2 2\n2\rend".into(), 3));
    let only = |column: f64| Only { line: Some(2.0), column: Some(column), text: Some("two".into()) };
    assert_eq!(replace(text, &re, "2", false, Some(only(4.0))), ("one\r\ntwo 2\ntwo\rend".into(), 1));
    assert_eq!(replace(text, &re, "2", false, Some(only(5.0))).1, 0);
}

#[test]
fn expands_replacement_tokens_like_string_replace() {
    // `/(a)(b)?/.exec('a')`: group 2 did not take part, group 3 does not exist.
    let re = regex_of(json!({ "query": "(a)(b)?", "regex": true, "caseSensitive": true }));
    assert_eq!(replace("a", &re, "[$1|$2|$3|$$|$&]", true, None).0, "[a||$3|$|a]");
}

#[test]
fn compiles_file_globs() {
    let ts = compile_globs(Some("*.ts, src/**")).unwrap();
    assert!(ts.matches("a/b/c.ts"));
    assert!(ts.matches("src/deep/readme.md"));
    assert!(!ts.matches("docs/readme.md"));
    assert!(compile_globs(Some("docs/")).unwrap().matches("docs/a/b.md"));
    assert!(!compile_globs(Some("src/*.js")).unwrap().matches("src/sub/x.js"));
    assert!(compile_globs(Some("  ")).is_none());
}

/// The project of the TS suite.
struct Project {
    dir: tempfile::TempDir,
}

impl Project {
    fn new() -> Self {
        let p = Self { dir: tempfile::tempdir().unwrap() };
        p.put("src/a.ts", b"const TOKEN = 1;\nconsole.log(TOKEN);\n");
        p.put("src/deep/b.ts", b"token here\r\nand token there\r\n");
        p.put("notes.md", b"Token in notes");
        p.put("node_modules/pkg/index.js", b"token inside dependencies");
        p.put(".git/config", b"token in git");
        p.put("image.bin", &[0x74, 0x6f, 0x6b, 0x65, 0x6e, 0x00, 0x01]);
        p
    }
    fn root(&self) -> String {
        self.dir.path().to_string_lossy().into_owned()
    }
    fn put(&self, path: &str, body: &[u8]) {
        let full = self.dir.path().join(path);
        fs::create_dir_all(full.parent().unwrap()).unwrap();
        fs::write(full, body).unwrap();
    }
    fn read(&self, path: &str) -> String {
        fs::read_to_string(self.dir.path().join(path)).unwrap()
    }
    fn search(&self, options: Value) -> Value {
        search_project(&self.root(), &options, &clock(), None).unwrap()
    }
    fn replace(&self, request: Value) -> Value {
        replace_in_project(&self.root(), &request).unwrap()
    }
}

fn paths(result: &Value) -> Vec<String> {
    result["files"].as_array().unwrap().iter().map(|f| f["path"].as_str().unwrap().to_string()).collect()
}

#[test]
fn finds_matches_across_the_project_and_skips_dependencies_git_data_and_binary_files() {
    let p = Project::new();
    let result = p.search(json!({ "query": "token" }));
    let counts: Vec<(String, usize)> = result["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| (f["path"].as_str().unwrap().into(), f["matches"].as_array().unwrap().len()))
        .collect();
    assert_eq!(counts, [("notes.md".into(), 1), ("src/a.ts".into(), 2), ("src/deep/b.ts".into(), 2)]);
    assert_eq!(result["matches"], 5);
    assert_eq!(result["skipped"], 1);
    let all = paths(&p.search(json!({ "query": "token", "includeIgnored": true })));
    assert!(all.contains(&"node_modules/pkg/index.js".into()) && all.contains(&".git/config".into()));
}

#[test]
fn honours_case_whole_word_include_and_exclude_filters() {
    let p = Project::new();
    assert_eq!(paths(&p.search(json!({ "query": "Token", "caseSensitive": true }))).len(), 1);
    assert!(paths(&p.search(json!({ "query": "tok", "wholeWord": true }))).is_empty());
    assert_eq!(paths(&p.search(json!({ "query": "token", "include": "*.ts" }))), ["src/a.ts", "src/deep/b.ts"]);
    assert_eq!(paths(&p.search(json!({ "query": "token", "include": "*.ts", "exclude": "src/deep/" }))), ["src/a.ts"]);
}

#[test]
fn reports_a_bad_regular_expression_accepts_an_empty_query_and_skips_large_files() {
    let p = Project::new();
    assert_eq!(p.search(json!({ "query": "(", "regex": true }))["ok"], false);
    let empty = p.search(json!({ "query": "" }));
    assert_eq!((empty["ok"].clone(), empty["files"].clone()), (json!(true), json!([])));
    p.put("big.txt", format!("token{}", "x".repeat(300 * 1024)).as_bytes());
    let result = p.search(json!({ "query": "token" }));
    assert!(!paths(&result).contains(&"big.txt".into()));
    assert_eq!(result["skipped"], 2);
}

#[test]
fn stops_when_the_match_limit_or_the_time_budget_is_reached() {
    let p = Project::new();
    p.put("many.txt", "x\n".repeat(6000).as_bytes());
    let limited = p.search(json!({ "query": "x" }));
    assert_eq!((limited["truncated"].clone(), limited["matches"].clone()), (json!(true), json!(5000)));
    let tick = Cell::new(0.0);
    let slow = search_project(
        &p.root(),
        &json!({ "query": "token" }),
        &|| {
            tick.set(tick.get() + 6000.0);
            tick.get()
        },
        None,
    )
    .unwrap();
    assert_eq!(slow["truncated"], true);
}

#[test]
fn stops_a_search_that_a_newer_one_replaced_and_still_finds_everything_when_reading_files_in_parallel() {
    let p = Project::new();
    for i in 0..40 {
        p.put(
            &format!("bulk/f{i}.txt"),
            if i % 3 != 0 { b"nothing\n".to_vec() } else { format!("token {i}\n").into_bytes() }.as_slice(),
        );
    }
    let full = p.search(json!({ "query": "token" }));
    let bulk: Vec<String> = paths(&full).into_iter().filter(|f| f.starts_with("bulk/")).collect();
    let mut expected: Vec<String> = (0..40).filter(|i| i % 3 == 0).map(|i| format!("bulk/f{i}.txt")).collect();
    expected.sort_by(|a, b| unimux_files::collate::compare_names(a, b));
    assert_eq!(bulk, expected);
    assert!(full["scanned"].as_u64().unwrap() >= 40);

    let before = AtomicBool::new(true);
    assert_eq!(
        search_project(&p.root(), &json!({ "query": "token" }), &clock(), Some(&before)).unwrap(),
        json!({ "ok": true, "files": [], "matches": 0, "scanned": 0, "skipped": 0, "truncated": true })
    );

    // Cancelled while running (the clock is read once per started file): the rest of the project is not read.
    let during = AtomicBool::new(false);
    let calls = Cell::new(0);
    let stopped = search_project(
        &p.root(),
        &json!({ "query": "token" }),
        &|| {
            calls.set(calls.get() + 1);
            if calls.get() == 3 {
                during.store(true, std::sync::atomic::Ordering::SeqCst);
            }
            0.0
        },
        Some(&during),
    )
    .unwrap();
    assert_eq!(
        (stopped["ok"].clone(), stopped["files"].clone(), stopped["truncated"].clone()),
        (json!(true), json!([]), json!(true))
    );
}

#[test]
fn replaces_in_every_matching_file_and_keeps_line_endings() {
    let p = Project::new();
    let result = p.replace(json!({ "options": { "query": "token" }, "replacement": "key", "scope": { "kind": "all" } }));
    assert_eq!((result["ok"].clone(), result["replaced"].clone()), (json!(true), json!(5)));
    assert_eq!(p.read("src/a.ts"), "const key = 1;\nconsole.log(key);\n");
    assert_eq!(p.read("src/deep/b.ts"), "key here\r\nand key there\r\n");
    assert_eq!(p.read("node_modules/pkg/index.js"), "token inside dependencies");
    assert!(fs::read(p.dir.path().join("image.bin")).unwrap().contains(&0));
}

#[test]
fn replaces_only_one_file_or_one_occurrence_when_asked() {
    let p = Project::new();
    let file = p.replace(
        json!({ "options": { "query": "token" }, "replacement": "key", "scope": { "kind": "file", "path": "src/deep/b.ts" } }),
    );
    assert_eq!(file["replaced"], 2);
    assert_eq!(p.read("notes.md"), "Token in notes");
    let one = p.replace(json!({
        "options": { "query": "token" }, "replacement": "key",
        "scope": { "kind": "match", "path": "src/a.ts", "line": 2, "column": 12, "text": "TOKEN" },
    }));
    assert_eq!(one["replaced"], 1);
    assert_eq!(p.read("src/a.ts"), "const TOKEN = 1;\nconsole.log(key);\n");
}

#[test]
fn refuses_a_single_replacement_when_the_file_changed_since_the_search() {
    let p = Project::new();
    let stale = p.replace(json!({
        "options": { "query": "token" }, "replacement": "key",
        "scope": { "kind": "match", "path": "src/a.ts", "line": 1, "column": 99, "text": "TOKEN" },
    }));
    assert_eq!((stale["ok"].clone(), stale["replaced"].clone()), (json!(true), json!(0)));
    assert!(stale["files"][0]["error"].as_str().unwrap().contains("zmienił się"));
    assert_eq!(p.read("src/a.ts"), "const TOKEN = 1;\nconsole.log(TOKEN);\n");
}

#[test]
fn keeps_a_byte_order_mark_and_expands_regular_expression_groups() {
    let p = Project::new();
    p.put("bom.txt", b"\xef\xbb\xbfname: ann\n");
    let result = p.replace(json!({ "options": { "query": "name: (\\w+)", "regex": true }, "replacement": "user=$1", "scope": { "kind": "file", "path": "bom.txt" } }));
    assert_eq!(result["replaced"], 1);
    assert_eq!(fs::read(p.dir.path().join("bom.txt")).unwrap(), b"\xef\xbb\xbfuser=ann\n");
}

#[test]
fn reports_files_that_cannot_be_replaced_and_rejects_invalid_requests() {
    let p = Project::new();
    let binary = p.replace(
        json!({ "options": { "query": "token" }, "replacement": "k", "scope": { "kind": "file", "path": "image.bin" } }),
    );
    assert_eq!((binary["files"][0]["path"].clone(), binary["files"][0]["replaced"].clone()), (json!("image.bin"), json!(0)));
    assert!(binary["files"][0]["error"].as_str().is_some_and(|e| !e.is_empty()));
    assert_eq!(p.replace(json!({ "options": { "query": "" }, "replacement": "k", "scope": { "kind": "all" } }))["ok"], false);
    assert_eq!(
        p.replace(json!({ "options": { "query": "(", "regex": true }, "replacement": "k", "scope": { "kind": "all" } }))["ok"],
        false
    );
    let outside = p.replace(
        json!({ "options": { "query": "a" }, "replacement": "k", "scope": { "kind": "file", "path": "../outside.txt" } }),
    );
    assert!(outside["files"][0]["error"].as_str().is_some_and(|e| !e.is_empty()));
}

#[test]
fn lists_folders_breadth_first_without_dependency_folders_and_honours_the_limit() {
    let p = Project::new();
    fs::create_dir_all(p.dir.path().join("src/deep/deeper")).unwrap();
    assert_eq!(
        list_project_directories(&p.root(), 2500),
        json!({ "ok": true, "paths": ["src", "src/deep", "src/deep/deeper"], "truncated": false })
    );
    assert_eq!(list_project_directories(&p.root(), 2), json!({ "ok": true, "paths": ["src", "src/deep"], "truncated": true }));
}

// ── Rust-only cases ──────────────────────────────────────────────────────────

#[test]
fn never_follows_junctions_or_links() {
    let p = Project::new();
    let outside = tempfile::tempdir().unwrap();
    fs::write(outside.path().join("secret.txt"), "token outside").unwrap();
    link_dir(outside.path(), &p.dir.path().join("linked"));
    let result = p.search(json!({ "query": "token", "includeIgnored": true }));
    assert!(paths(&result).iter().all(|f| !f.starts_with("linked")), "{result}");
}

#[cfg(windows)]
fn link_dir(target: &Path, link: &Path) {
    junction::create(target, link).unwrap();
}

#[cfg(unix)]
fn link_dir(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[test]
fn an_empty_match_before_an_emoji_ends_with_the_u_flag() {
    // 1.1.4 never returned here (lastIndex++ inside a surrogate pair, V8 steps back): 1.2.0 skips the code point.
    let re = regex_of(json!({ "query": "x*|😀", "regex": true }));
    assert!(re.unicode());
    assert!(search_text(&u("😀😀 a"), &re, 5000).0.is_empty());
    let one = regex_of(json!({ "query": "(?:)|a", "regex": true }));
    assert_eq!(replace("😀a", &one, "b", false, None), ("😀a".into(), 0));
}

#[test]
fn utf16_columns_previews_and_replacement_of_polish_text_and_emoji() {
    let text = "😀 Zażółć 👍🏽 gęślą jaźń 😀";
    let (found, _) = search_text(&u(text), &regex_of(json!({ "query": "gęślą" })), 5000);
    assert_eq!((found[0].column, found[0].match_length), (15, 5));
    let re = regex_of(json!({ "query": "(?<w>ż\\p{L}+)", "regex": true }));
    assert_eq!(replace(text, &re, "[$<w>|$1]", true, None).0, "😀 Za[żółć|żółć] 👍🏽 gęślą jaźń 😀");
    // Without `u` (`\-` is refused with it), `.` takes one half of a pair: the preview shows U+FFFD for the cut half.
    let legacy = regex_of(json!({ "query": "\\-.", "regex": true }));
    assert!(!legacy.unicode());
    let (found, _) = search_text(&u("a-😀"), &legacy, 5000);
    assert_eq!((found[0].text.as_str(), found[0].preview.as_str()), ("-\u{fffd}", "a-😀"));
}

#[test]
fn a_replacement_that_would_split_a_surrogate_pair_is_refused_by_the_writer() {
    let p = Project::new();
    p.put("e.txt", "a-😀".as_bytes());
    let result = p.replace(json!({ "options": { "query": "\\-.", "regex": true }, "replacement": "X", "scope": { "kind": "file", "path": "e.txt" } }));
    assert_eq!(result["files"][0], json!({ "path": "e.txt", "replaced": 0, "error": "Nieprawidłowa treść pliku." }));
    assert_eq!(p.read("e.txt"), "a-😀");
}

#[test]
fn malformed_requests_fail_like_a_throw() {
    let p = Project::new();
    assert!(search_project(&p.root(), &Value::Null, &clock(), None).is_err());
    assert!(search_project(&p.root(), &json!({ "query": "a", "include": 5 }), &clock(), None).is_err());
    assert!(replace_in_project(&p.root(), &json!({ "options": { "query": "a" }, "replacement": "b" })).is_err());
    assert_eq!(
        replace_in_project(&p.root(), &json!({ "options": { "query": "a" }, "replacement": 5, "scope": { "kind": "all" } }))
            .unwrap(),
        json!({ "ok": false, "error": "Nieprawidłowy tekst zamiany." })
    );
    // A scope that is no object has no kind and no path (1.1.4 read `undefined` and reported the missing file).
    let odd = replace_in_project(&p.root(), &json!({ "options": { "query": "a" }, "replacement": "b", "scope": "all" })).unwrap();
    assert_eq!(odd["ok"], true);
    assert_eq!(odd["replaced"], 0);
    assert_eq!(odd["files"].as_array().map(Vec::len), Some(1));
    assert!(odd["files"][0]["error"].is_string());
}
