//! Ports of test/files.test.ts (project file browsing, batches, safe editing) and of the local-file cases of
//! test/editor-source.test.ts. Each test names the TS case it covers (test/PORTING.md).

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};
use unimux_files::local::{FILE_GONE, LocalFiles, LocalPlatform, is_unc_or_device_path};
use unimux_files::preview::{PREVIEW_BYTES, Preview};
use unimux_files::project::{
    BATCH_LIMIT, DIRECTORIES_LIMIT, list_project_directories, list_project_directory, list_project_directory_batch,
    project_file_path, read_project_file, stat_project_file,
};
use unimux_files::save::{SaveResult, write_file_with};

struct Fixture {
    _dir: tempfile::TempDir,
    fixture: PathBuf,
    root: PathBuf,
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn fixture() -> Fixture {
    let dir = tempfile::Builder::new().prefix("mc-files-").tempdir().unwrap();
    let fixture = dir.path().to_path_buf();
    let root = fixture.join("project");
    fs::create_dir_all(root.join("nested")).unwrap();
    fs::write(root.join("nested").join("hello.txt"), "Cześć, świecie!\n").unwrap();
    fs::write(root.join("file10.txt"), "ten").unwrap();
    fs::write(root.join("file2.txt"), "two").unwrap();
    fs::write(fixture.join("outside.txt"), "outside the project").unwrap();
    Fixture { _dir: dir, fixture, root }
}

fn names(listing: &Value) -> Vec<String> {
    listing["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap().to_string()).collect()
}

fn read(root: &Path, path: &str) -> Preview {
    read_project_file(&s(root), Some(path), PREVIEW_BYTES)
}

fn write(root: &Path, path: &str, text: &str, expected: &str) -> SaveResult {
    let r = s(root);
    write_file_with(&|| project_file_path(&r, Some(path), None), Some(text), Some(expected))
}

fn link_dir(target: &Path, link: &Path) {
    #[cfg(windows)]
    junction::create(target, link).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
}

// files: lists folders first and sorts file names naturally
#[test]
fn lists_folders_first_and_sorts_file_names_naturally() {
    let f = fixture();
    let listing = list_project_directory(&s(&f.root), Some(""), None);
    assert_eq!(listing["ok"], true);
    assert_eq!(names(&listing), ["nested", "file2.txt", "file10.txt"]);
    let nested = list_project_directory(&s(&f.root), Some("nested"), None);
    assert_eq!(nested["entries"], json!([{ "name": "hello.txt", "path": "nested/hello.txt", "kind": "file" }]));
    assert_eq!(listing["truncated"], false);
}

// files: reads text without altering the file
#[test]
fn reads_text_without_altering_the_file() {
    let f = fixture();
    let text = "Cześć, świecie!\n";
    assert_eq!(read(&f.root, "nested/hello.txt"), Preview::Text { text: text.into(), size: text.len() as u64, truncated: false });
    assert_eq!(fs::read_to_string(f.root.join("nested/hello.txt")).unwrap(), "Cześć, świecie!\n");
}

// files: blocks traversal and absolute paths
#[test]
fn blocks_traversal_and_absolute_paths() {
    let f = fixture();
    assert!(read(&f.root, "../outside.txt").is_error());
    assert!(read(&f.root, &s(&f.fixture.join("outside.txt"))).is_error());
    assert_eq!(list_project_directory(&s(&f.root), Some(".."), None)["ok"], false);
    assert_eq!(read(&f.root, "../outside.txt"), Preview::Error { message: "Ścieżka jest poza projektem.".into() });
}

// files: blocks directory junctions leading outside the project
#[test]
fn blocks_directory_junctions_leading_outside_the_project() {
    let f = fixture();
    let outside = f.fixture.join("external");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "not in this project").unwrap();
    link_dir(&outside, &f.root.join("external-link"));
    let listing = list_project_directory(&s(&f.root), Some("external-link"), None);
    assert_eq!(listing, json!({ "ok": false, "error": "Ten link prowadzi poza folder projektu." }));
    assert!(read(&f.root, "external-link/secret.txt").is_error());
    // The junction itself is listed as a link (libuv reports any reparse point so) and sorts among the files.
    let root = list_project_directory(&s(&f.root), Some(""), None);
    assert_eq!(names(&root), ["nested", "external-link", "file2.txt", "file10.txt"]);
    assert_eq!(root["entries"][1]["kind"], "symlink");
}

// files: limits large previews and handles a UTF-8 character cut at the limit
#[test]
fn limits_large_previews_and_handles_a_utf8_character_cut_at_the_limit() {
    let f = fixture();
    let content = format!("{}ątail", "a".repeat(PREVIEW_BYTES - 1));
    fs::write(f.root.join("large.txt"), &content).unwrap();
    match read(&f.root, "large.txt") {
        Preview::Text { text, truncated, size } => {
            assert!(truncated);
            assert_eq!(text, "a".repeat(PREVIEW_BYTES - 1));
            assert_eq!(size, content.len() as u64);
        }
        other => panic!("{other:?}"),
    }
}

// files: supports UTF-16 Windows text files and distinguishes binary content
#[test]
fn supports_utf16_windows_text_files_and_distinguishes_binary_content() {
    let f = fixture();
    let mut bytes = vec![0xff, 0xfe];
    for u in "Polskie znaki: ąęć\n".encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    fs::write(f.root.join("utf16.txt"), &bytes).unwrap();
    assert!(matches!(read(&f.root, "utf16.txt"), Preview::Text { text, .. } if text == "Polskie znaki: ąęć\n"));
    fs::write(f.root.join("binary.dat"), [0u8, 1, 2, 255]).unwrap();
    assert_eq!(read(&f.root, "binary.dat"), Preview::Binary { size: 4 });
}

// files: returns useful errors for missing files and prevents previewing directories
#[test]
fn returns_useful_errors_for_missing_files_and_prevents_previewing_directories() {
    let f = fixture();
    assert!(matches!(read(&f.root, "missing.txt"), Preview::Error { message } if message.contains("nie istnieje")));
    assert_eq!(list_project_directory(&s(&f.root), Some("missing"), None)["ok"], false);
    assert_eq!(read(&f.root, "nested"), Preview::Error { message: "Wybierz plik, aby zobaczyć jego treść.".into() });
    // Listing a file: Node's ENOTDIR text (scandir).
    let listing = list_project_directory(&s(&f.root), Some("file2.txt"), None);
    assert!(listing["error"].as_str().unwrap().starts_with("ENOTDIR: not a directory, scandir '"), "{listing}");
}

// files: lists many folders in one call, each like a single listing
#[test]
fn lists_many_folders_in_one_call_each_like_a_single_listing() {
    let f = fixture();
    let result = list_project_directory_batch(&s(&f.root), &json!(["", "nested", "missing", "../", "nested"]));
    let mut keys: Vec<&String> = result.as_object().unwrap().keys().collect();
    keys.sort();
    assert_eq!(keys, ["", "../", "missing", "nested"]);
    assert_eq!(result[""], list_project_directory(&s(&f.root), Some(""), None));
    assert_eq!(result["nested"]["entries"][0]["path"], "nested/hello.txt");
    assert_eq!(result["missing"]["ok"], false);
    assert_eq!(result["../"]["ok"], false);
}

// files: ignores malformed input and caps the number of folders
#[test]
fn ignores_malformed_input_and_caps_the_number_of_folders() {
    let f = fixture();
    assert_eq!(list_project_directory_batch(&s(&f.root), &json!("nested")), json!({}));
    let r = list_project_directory_batch(&s(&f.root), &json!([1, null, "nested"]));
    assert_eq!(r.as_object().unwrap().keys().collect::<Vec<_>>(), ["nested"]);
    let many: Vec<String> = (0..BATCH_LIMIT + 5).map(|i| format!("missing-{i}")).collect();
    assert_eq!(list_project_directory_batch(&s(&f.root), &json!(many)).as_object().unwrap().len(), BATCH_LIMIT);
}

// files: walks every folder breadth first in natural order (read level by level in parallel)
#[test]
fn walks_every_folder_breadth_first_in_natural_order() {
    let f = fixture();
    let walk = f.fixture.join("walk");
    for dir in ["b/x", "a10", "a2/y/z", "node_modules/pkg"] {
        fs::create_dir_all(walk.join(dir)).unwrap();
    }
    assert_eq!(
        list_project_directories(&s(&walk), DIRECTORIES_LIMIT),
        json!({ "ok": true, "paths": ["a2", "a10", "b", "a2/y", "b/x", "a2/y/z"], "truncated": false })
    );
    assert_eq!(list_project_directories(&s(&walk), 2), json!({ "ok": true, "paths": ["a2", "a10"], "truncated": true }));
}

fn encode(encoding: &str, text: &str) -> Vec<u8> {
    match encoding {
        "utf16le" | "utf16be" => {
            let mut out = Vec::new();
            for u in std::iter::once(0xfeffu16).chain(text.encode_utf16()) {
                out.extend_from_slice(&if encoding == "utf16be" { u.to_be_bytes() } else { u.to_le_bytes() });
            }
            out
        }
        "utf8-bom" => [&[0xef, 0xbb, 0xbf][..], text.as_bytes()].concat(),
        _ => text.as_bytes().to_vec(),
    }
}

// files: preserves encoding, BOM and CRLF for %s
#[test]
fn preserves_encoding_bom_and_crlf() {
    let f = fixture();
    for encoding in ["utf8", "utf8-bom", "utf16le", "utf16be"] {
        let path = format!("edit-{encoding}.txt");
        let original = "Cześć\r\nświat\r\n";
        fs::write(f.root.join(&path), encode(encoding, original)).unwrap();
        assert_eq!(write(&f.root, &path, "Cześć\nnowy świat\n", original), SaveResult::Ok, "{encoding}");
        assert_eq!(fs::read(f.root.join(&path)).unwrap(), encode(encoding, "Cześć\r\nnowy świat\r\n"), "{encoding}");
    }
}

// files: preserves mixed line endings and empty files
#[test]
fn preserves_mixed_line_endings_and_empty_files() {
    let f = fixture();
    fs::write(f.root.join("mixed.txt"), "one\r\ntwo\nthree\r").unwrap();
    assert_eq!(write(&f.root, "mixed.txt", "ONE\nTWO\nTHREE\n", "one\r\ntwo\nthree\r"), SaveResult::Ok);
    assert_eq!(fs::read_to_string(f.root.join("mixed.txt")).unwrap(), "ONE\r\nTWO\nTHREE\r");
    fs::write(f.root.join("empty.txt"), "").unwrap();
    assert_eq!(write(&f.root, "empty.txt", "ą\n", ""), SaveResult::Ok);
    assert_eq!(write(&f.root, "empty.txt", "", "ą\n"), SaveResult::Ok);
    assert_eq!(fs::read_to_string(f.root.join("empty.txt")).unwrap(), "");
}

fn staged_files(dir: &Path) -> Vec<String> {
    fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".mc-save-"))
        .collect()
}

// files: rejects an external edit without changing bytes or leaving temporary files
#[test]
fn rejects_an_external_edit_without_changing_bytes_or_leaving_temporary_files() {
    let f = fixture();
    fs::write(f.root.join("conflict.txt"), "external").unwrap();
    let result = write(&f.root, "conflict.txt", "draft", "original");
    assert_eq!(result, SaveResult::Conflict);
    assert_eq!(
        result.to_json(),
        json!({ "ok": false, "code": "conflict", "error": "Plik zmienił się poza edytorem. Twój szkic został zachowany." })
    );
    assert_eq!(fs::read_to_string(f.root.join("conflict.txt")).unwrap(), "external");
    assert!(staged_files(&f.root).is_empty());
    // "Overwrite (keep mine)": the same draft against the text now on disk is written.
    assert_eq!(write(&f.root, "conflict.txt", "draft", "external"), SaveResult::Ok);
    assert_eq!(fs::read_to_string(f.root.join("conflict.txt")).unwrap(), "draft");
}

// files: other save failures carry no conflict code
#[test]
fn other_save_failures_carry_no_conflict_code() {
    let f = fixture();
    fs::write(f.root.join("bad-text.txt"), "ok").unwrap();
    let result = write(&f.root, "bad-text.txt", "a\u{1}b", "ok");
    assert_eq!(result.to_json(), json!({ "ok": false, "error": "Nieprawidłowa treść pliku." }));
}

// files: serializes concurrent saves to the same baseline
#[test]
fn serializes_concurrent_saves_to_the_same_baseline() {
    let f = fixture();
    for round in 0..20 {
        fs::write(f.root.join("concurrent.txt"), "initial").unwrap();
        let root = s(&f.root);
        let results: Vec<SaveResult> = std::thread::scope(|scope| {
            let handles: Vec<_> = ["first", "second"]
                .into_iter()
                .map(|text| {
                    let root = root.clone();
                    scope.spawn(move || {
                        write_file_with(&|| project_file_path(&root, Some("concurrent.txt"), None), Some(text), Some("initial"))
                    })
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        assert_eq!(results.iter().filter(|r| **r == SaveResult::Ok).count(), 1, "round {round}: {results:?}");
        let now = fs::read_to_string(f.root.join("concurrent.txt")).unwrap();
        assert!(now == "first" || now == "second");
        assert!(staged_files(&f.root).is_empty());
    }
}

// files: rejects binary, truncated, oversized output and invalid text without damage
#[test]
fn rejects_binary_truncated_oversized_output_and_invalid_text_without_damage() {
    let f = fixture();
    let cases: [(&str, Vec<u8>); 3] = [
        ("edit-binary.dat", vec![0, 1, 2, 255]),
        ("edit-large.txt", vec![b'a'; PREVIEW_BYTES + 1]),
        ("edit-invalid.txt", vec![0xc3, 0x28]),
    ];
    for (path, original) in cases {
        fs::write(f.root.join(path), &original).unwrap();
        assert!(matches!(write(&f.root, path, "replacement", ""), SaveResult::Failed(_)), "{path}");
        assert_eq!(fs::read(f.root.join(path)).unwrap(), original);
    }
    fs::write(f.root.join("edit-output.txt"), "original").unwrap();
    for text in ["a".repeat(PREVIEW_BYTES + 1), "null\0byte".to_string()] {
        assert!(matches!(write(&f.root, "edit-output.txt", &text, "original"), SaveResult::Failed(_)));
        assert_eq!(fs::read_to_string(f.root.join("edit-output.txt")).unwrap(), "original");
    }
    // The lone surrogate ('\ud800') never reaches Rust: the bridge answers that save itself (test/tauri-bridge.test.ts).
    assert!(staged_files(&f.root).is_empty());
}

// files: rejects missing files, directories, traversal, absolute paths and external junctions
#[test]
fn rejects_missing_files_directories_traversal_absolute_paths_and_external_junctions() {
    let f = fixture();
    let outside = f.fixture.join("external");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("secret.txt"), "not in this project").unwrap();
    link_dir(&outside, &f.root.join("external-link"));
    let absolute = s(&f.fixture.join("outside.txt"));
    for path in ["missing-edit.txt", "nested", "../outside.txt", absolute.as_str(), "external-link/secret.txt"] {
        assert!(matches!(write(&f.root, path, "overwrite", ""), SaveResult::Failed(_)), "{path}");
    }
    assert_eq!(fs::read_to_string(f.fixture.join("outside.txt")).unwrap(), "outside the project");
    assert_eq!(fs::read_to_string(outside.join("secret.txt")).unwrap(), "not in this project");
}

#[test]
fn a_read_only_file_is_refused_and_stays_unchanged() {
    let f = fixture();
    let path = f.root.join("ro.txt");
    fs::write(&path, "keep").unwrap();
    let mut perms = fs::metadata(&path).unwrap().permissions();
    perms.set_readonly(true);
    fs::set_permissions(&path, perms.clone()).unwrap();
    let result = write(&f.root, "ro.txt", "new", "keep");
    #[cfg(windows)]
    assert_eq!(result, SaveResult::Failed("Brak uprawnień do odczytu tego pliku lub folderu.".into()));
    #[cfg(unix)]
    let _ = result; // a rename replaces a read-only file on Unix (the folder decides), as in 1.1.4
    #[cfg(windows)]
    assert_eq!(fs::read_to_string(&path).unwrap(), "keep");
    assert!(staged_files(&f.root).is_empty());
    #[allow(clippy::permissions_set_readonly_false)]
    perms.set_readonly(false);
    fs::set_permissions(&path, perms).unwrap();
}

#[test]
fn stat_tells_files_gone_and_unknown() {
    let f = fixture();
    let st = stat_project_file(&s(&f.root), Some("file2.txt"));
    assert_eq!(st["size"], 3);
    assert!(st["mtimeMs"].as_f64().unwrap() > 1.0e12);
    assert_eq!(stat_project_file(&s(&f.root), Some("moved.txt")), json!("gone"));
    assert_eq!(stat_project_file(&s(&f.root), Some("nested")), Value::Null);
    assert_eq!(stat_project_file(&s(&f.root), Some("../outside.txt")), Value::Null);
    assert_eq!(stat_project_file(&s(&f.root), None), Value::Null);
}

#[test]
fn images_and_the_large_view() {
    let f = fixture();
    let png = [0x89, b'P', b'N', b'G', 0, 1, 2];
    fs::write(f.root.join("pic.PNG"), png).unwrap();
    // The small preview keeps calling it binary; the editor's large view gets the bytes.
    assert_eq!(read(&f.root, "pic.PNG"), Preview::Binary { size: 7 });
    let large = read_project_file(&s(&f.root), Some("pic.PNG"), unimux_files::project::read_limit(true));
    assert_eq!(large, Preview::Image { mime: "image/png", bytes: png.to_vec(), size: 7 });
    let (value, parts) = large.into_reply();
    assert_eq!(value, json!({ "kind": "image", "mime": "image/png", "dataUrl": { "$mcBytes": 0 }, "size": 7 }));
    assert_eq!(parts, vec![png.to_vec()]);
    // 8 MiB for the editor.
    let big = "b".repeat(PREVIEW_BYTES * 2);
    fs::write(f.root.join("big.txt"), &big).unwrap();
    assert!(matches!(read_project_file(&s(&f.root), Some("big.txt"), unimux_files::project::read_limit(true)),
        Preview::Text { text, truncated: false, .. } if text.len() == PREVIEW_BYTES * 2));
}

fn local(dir: &Path, forbidden: Vec<String>) -> LocalFiles {
    let _ = dir;
    LocalFiles::new(LocalPlatform::native(), forbidden)
}

// editor-source: reads, stats and saves like a project file (refuses when the file changed, keeps line endings)
#[test]
fn local_reads_stats_and_saves_like_a_project_file() {
    let dir = tempfile::Builder::new().prefix("unimux-edit-").tempdir().unwrap();
    let path = s(&dir.path().join("notes.txt"));
    fs::write(&path, "one\r\ntwo\r\n").unwrap();
    let f = local(dir.path(), vec![]);
    assert_eq!(f.read_file(Some(&path)), Preview::Text { text: "one\r\ntwo\r\n".into(), size: 10, truncated: false });
    assert_eq!(f.stat_file(Some(&path))["size"], 10);
    assert_eq!(f.write_file(Some(&path), Some("one\nTWO\n"), Some("one\r\ntwo\r\n")), SaveResult::Ok);
    assert_eq!(fs::read_to_string(&path).unwrap(), "one\r\nTWO\r\n");
    assert_eq!(f.write_file(Some(&path), Some("mine"), Some("one\r\ntwo\r\n")), SaveResult::Conflict);
    assert_eq!(fs::read_to_string(&path).unwrap(), "one\r\nTWO\r\n");
}

// editor-source: refuses relative paths and non-strings
#[test]
fn local_refuses_relative_paths_and_non_strings() {
    let dir = tempfile::tempdir().unwrap();
    let f = local(dir.path(), vec![]);
    assert!(f.read_file(Some("notes.txt")).is_error());
    assert!(f.read_file(None).is_error());
    assert_eq!(f.stat_file(Some("rel")), Value::Null);
    assert!(matches!(f.write_file(Some("rel.txt"), Some("a"), Some("b")), SaveResult::Failed(_)));
    let x = s(&dir.path().join("x.txt"));
    fs::write(&x, "b").unwrap();
    f.read_file(Some(&x));
    assert_eq!(f.write_file(Some(&x), None, Some("b")), SaveResult::Failed("Nieprawidłowa treść pliku.".into()));
}

// editor-source: writes only a file this window read first; a reload forgets them (a restored draft reads again)
#[test]
fn local_writes_only_a_file_read_first_and_a_reload_forgets() {
    let dir = tempfile::tempdir().unwrap();
    let path = s(&dir.path().join("a.txt"));
    fs::write(&path, "a").unwrap();
    let f = local(dir.path(), vec![]);
    assert_eq!(
        f.write_file(Some(&path), Some("b"), Some("a")),
        SaveResult::Failed("Ten plik nie został otwarty w edytorze.".into())
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "a");
    f.read_file(Some(&path));
    assert_eq!(f.write_file(Some(&path), Some("b"), Some("a")), SaveResult::Ok);
    f.renderer_gone();
    assert_eq!(
        f.write_file(Some(&path), Some("c"), Some("b")),
        SaveResult::Failed("Ten plik nie został otwarty w edytorze.".into())
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), "b");
}

#[test]
fn local_opened_set_keeps_the_last_500() {
    let dir = tempfile::tempdir().unwrap();
    let f = local(dir.path(), vec![]);
    let paths: Vec<String> = (0..501).map(|i| s(&dir.path().join(format!("f{i}.txt")))).collect();
    for p in &paths {
        fs::write(p, "x").unwrap();
        f.read_file(Some(p));
    }
    assert_eq!(
        f.write_file(Some(&paths[0]), Some("y"), Some("x")),
        SaveResult::Failed("Ten plik nie został otwarty w edytorze.".into())
    );
    assert_eq!(f.write_file(Some(&paths[500]), Some("y"), Some("x")), SaveResult::Ok);
}

// editor-source: never reads or writes the app data dir or the install dir, nor UNC and device paths
#[test]
fn local_never_touches_the_app_folders_nor_unc_and_device_paths() {
    let dir = tempfile::Builder::new().prefix("unimux-edit-").tempdir().unwrap();
    let data = dir.path().join("data");
    fs::create_dir(&data).unwrap();
    let state = s(&data.join("state.json"));
    fs::write(&state, "{}").unwrap();
    let f = local(dir.path(), vec![s(&data)]);
    assert_eq!(f.read_file(Some(&state)), Preview::Error { message: "Tego miejsca nie można edytować w aplikacji.".into() });
    assert_eq!(f.stat_file(Some(&state)), Value::Null);
    assert_eq!(
        f.write_file(Some(&state), Some("x"), Some("{}")),
        SaveResult::Failed("Tego miejsca nie można edytować w aplikacji.".into())
    );
    assert_eq!(fs::read_to_string(&state).unwrap(), "{}");
    // The same folder spelled through "..", and in another case on a case-insensitive disk.
    let dotted = s(&dir.path().join("x").join("..").join("data").join("state.json"));
    assert!(f.read_file(Some(&dotted)).is_error());
    #[cfg(windows)]
    assert!(f.read_file(Some(&state.to_uppercase())).is_error());
    // Through a link into the forbidden folder.
    link_dir(&data, &dir.path().join("door"));
    assert!(f.read_file(Some(&s(&dir.path().join("door").join("state.json")))).is_error());
    assert!(is_unc_or_device_path("\\\\server\\share\\a.txt"));
    assert!(!is_unc_or_device_path("C:\\a.txt"));
    let win = LocalFiles::new(LocalPlatform::Windows, vec![]);
    assert_eq!(
        win.read_file(Some("\\\\server\\share\\a.txt")),
        Preview::Error { message: "Tego miejsca nie można edytować w aplikacji.".into() }
    );
}

// editor-source: a local file that is gone has its own text, not "cannot be edited here"
#[test]
fn local_a_file_that_is_gone_has_its_own_text() {
    let dir = tempfile::Builder::new().prefix("unimux-gone-").tempdir().unwrap();
    let f = local(dir.path(), vec![]);
    let path = s(&dir.path().join("moved.txt"));
    assert_eq!(f.read_file(Some(&path)), Preview::Error { message: FILE_GONE.into() });
    assert_eq!(f.stat_file(Some(&path)), json!("gone"));
    assert_eq!(f.write_file(Some(&path), Some("x"), Some("")), SaveResult::Failed(FILE_GONE.into()));
    fs::write(&path, "hi").unwrap();
    assert_eq!(f.stat_file(Some(&path))["size"], 2);
}

#[test]
fn the_listing_stops_at_2000_entries() {
    let f = fixture();
    let many = f.fixture.join("many");
    fs::create_dir(&many).unwrap();
    for i in 0..2003 {
        fs::write(many.join(format!("n{i}")), "").unwrap();
    }
    let listing = list_project_directory(&s(&many), Some(""), None);
    assert_eq!(listing["truncated"], true);
    assert_eq!(listing["entries"].as_array().unwrap().len(), 2000);
    assert_eq!(listing["entries"][0]["name"], "n0");
    assert_eq!(listing["entries"][1]["name"], "n1");
    assert_eq!(listing["entries"][2]["name"], "n2");
}
