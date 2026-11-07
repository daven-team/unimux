//! Ports of test/file-ops.test.ts (rename, create, move, copy, delete to the trash, hostile requests, EXDEV) on a scratch
//! project. Each test names the TS case it covers (test/PORTING.md). The trash is a folder of the fixture, as in the TS
//! suite, so nothing reaches the real Recycle Bin.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use serde_json::{Value, json};
use unimux_files::fileops::{
    OpOptions, TrashFn, create_project_entry, delete_project_entries, rename_project_entry, transfer_project_entries,
};
use unimux_files::fserr::FsError;
use unimux_files::fsx::{self, LinkType};
use unimux_files::local::LocalPlatform;

struct Fx {
    _dir: tempfile::TempDir,
    fixture: PathBuf,
    root: PathBuf,
    trash_dir: PathBuf,
    trashed: Arc<Mutex<Vec<String>>>,
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn fixture() -> Fx {
    let dir = tempfile::Builder::new().prefix("mc-fileops-").tempdir().unwrap();
    let fixture = dir.path().to_path_buf();
    let root = fixture.join("project");
    let trash_dir = fixture.join("trash");
    fs::create_dir_all(root.join("src").join("deep")).unwrap();
    fs::create_dir_all(root.join("docs")).unwrap();
    fs::create_dir(&trash_dir).unwrap();
    fs::write(root.join("a.txt"), "A").unwrap();
    fs::write(root.join("src").join("b.txt"), "B").unwrap();
    fs::write(root.join("src").join("deep").join("c.txt"), "C").unwrap();
    fs::write(root.join("docs").join("a.txt"), "other A").unwrap();
    fs::write(fixture.join("outside.txt"), "outside").unwrap();
    Fx { _dir: dir, fixture, root, trash_dir, trashed: Arc::new(Mutex::new(Vec::new())) }
}

impl Fx {
    fn r(&self) -> String {
        s(&self.root)
    }
    fn p(&self, rel: &str) -> PathBuf {
        self.root.join(rel)
    }
    fn read(&self, rel: &str) -> String {
        fs::read_to_string(self.p(rel)).unwrap()
    }
    fn names(&self, rel: &str) -> Vec<String> {
        let mut names: Vec<String> =
            fs::read_dir(self.p(rel)).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        names.sort();
        names
    }
    fn trash(&self) -> Arc<TrashFn> {
        let (list, dir) = (self.trashed.clone(), self.trash_dir.clone());
        Arc::new(move |path: &str| {
            let mut list = list.lock().unwrap();
            list.push(path.to_string());
            let name = Path::new(path).file_name().unwrap().to_string_lossy().into_owned();
            fs::rename(path, dir.join(format!("{}-{name}", list.len()))).map_err(|e| FsError::io(&e, "rename", path))
        })
    }
    fn trashed(&self) -> Vec<String> {
        self.trashed.lock().unwrap().clone()
    }
    fn options(&self) -> OpOptions {
        OpOptions::new(self.trash())
    }
    fn transfer(&self, kind: &str, paths: &[&str], destination: &str, conflict: &str, options: OpOptions) -> Value {
        let request = json!({ "kind": kind, "paths": paths, "destination": destination, "conflict": conflict });
        transfer_project_entries(&self.r(), &request, &options)
    }
    fn mv(&self, paths: &[&str], destination: &str, conflict: &str) -> Value {
        self.transfer("move", paths, destination, conflict, self.options())
    }
    fn cp(&self, paths: &[&str], destination: &str, conflict: &str) -> Value {
        self.transfer("copy", paths, destination, conflict, self.options())
    }
    fn rename(&self, path: &str, name: &str) -> Value {
        rename_project_entry(&self.r(), &json!(path), &json!(name), LocalPlatform::native())
    }
    fn delete(&self, paths: Value) -> Value {
        delete_project_entries(&self.r(), &paths, &*self.trash())
    }
    /// A folder link (a junction on Windows, a symlink elsewhere); false where it cannot be made.
    fn link_dir(&self, target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        {
            junction::create(target, link).is_ok()
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(target, link).is_ok()
        }
    }
}

/// `toMatchObject`: every key of `expected` is in `actual` with a matching value (arrays element by element, same length).
fn matches(actual: &Value, expected: &Value) -> bool {
    match (actual, expected) {
        (Value::Object(a), Value::Object(e)) => e.iter().all(|(k, v)| a.get(k).is_some_and(|x| matches(x, v))),
        (Value::Array(a), Value::Array(e)) => a.len() == e.len() && a.iter().zip(e).all(|(x, y)| matches(x, y)),
        _ => actual == expected,
    }
}

#[track_caller]
fn assert_matches(actual: &Value, expected: Value) {
    assert!(matches(actual, &expected), "\n actual   {actual}\n expected {expected}");
}

// ---------- rename ----------

// file-ops: renames a file and a folder
#[test]
fn renames_a_file_and_a_folder() {
    let fx = fixture();
    assert_eq!(fx.rename("a.txt", "z.txt"), json!({ "ok": true, "from": "a.txt", "to": "z.txt" }));
    assert_eq!(fx.rename("src/deep", "inner"), json!({ "ok": true, "from": "src/deep", "to": "src/inner" }));
    assert_eq!(fx.read("z.txt"), "A");
    assert_eq!(fx.read("src/inner/c.txt"), "C");
}

// file-ops: refuses to overwrite and keeps both files
#[test]
fn refuses_to_overwrite_and_keeps_both_files() {
    let fx = fixture();
    assert_matches(&fx.rename("a.txt", "docs"), json!({ "ok": false, "error": "Element o takiej nazwie już istnieje." }));
    assert_eq!(fx.read("a.txt"), "A");
}

// file-ops: rejects invalid, reserved and path-like names
#[test]
fn rejects_invalid_reserved_and_path_like_names() {
    let fx = fixture();
    for name in ["", "  ", ".", "..", "x/y", "x\0y"] {
        assert_matches(&fx.rename("a.txt", name), json!({ "ok": false }));
    }
    for name in ["CON", "nul.txt", "a.", "a ", "a:b", "a?b", "COM1"] {
        let r = rename_project_entry(&fx.r(), &json!("a.txt"), &json!(name), LocalPlatform::Windows);
        assert_matches(&r, json!({ "ok": false }));
    }
    let r = rename_project_entry(&fx.r(), &json!("a.txt"), &json!("CON"), LocalPlatform::Linux);
    assert_matches(&r, json!({ "ok": true }));
    assert!(fx.names("").contains(&"CON".to_string()));
}

// file-ops: refuses the project root, traversal and absolute paths
#[test]
fn refuses_the_project_root_traversal_and_absolute_paths() {
    let fx = fixture();
    let outside = s(&fx.fixture.join("outside.txt"));
    for path in ["", "../outside.txt", outside.as_str(), "src/../../outside.txt"] {
        assert_matches(&fx.rename(path, "x"), json!({ "ok": false }));
    }
    assert_eq!(fs::read_to_string(fx.fixture.join("outside.txt")).unwrap(), "outside");
}

// file-ops: refuses entries reached through a junction that leaves the project
#[test]
fn refuses_entries_reached_through_a_junction_that_leaves_the_project() {
    let fx = fixture();
    let external = fx.fixture.join("external");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("secret.txt"), "secret").unwrap();
    assert!(fx.link_dir(&external, &fx.p("link")));
    assert_matches(&fx.rename("link/secret.txt", "x.txt"), json!({ "ok": false }));
    assert_matches(&fx.mv(&["link/secret.txt"], "docs", "ask"), json!({ "ok": false }));
    assert_matches(&fx.delete(json!(["link/secret.txt"])), json!({ "ok": false }));
    assert_matches(&fx.mv(&["a.txt"], "link", "ask"), json!({ "ok": false }));
    assert_eq!(fs::read_to_string(external.join("secret.txt")).unwrap(), "secret");
    assert!(fx.trashed().is_empty());
}

// file-ops: can rename the link itself (the link is inside the project)
#[test]
fn can_rename_the_link_itself() {
    let fx = fixture();
    let external = fx.fixture.join("external");
    fs::create_dir(&external).unwrap();
    assert!(fx.link_dir(&external, &fx.p("link")));
    assert_matches(&fx.rename("link", "link2"), json!({ "ok": true }));
    assert!(fx.names("").contains(&"link2".to_string()));
    assert!(fx.names("..").contains(&"external".to_string()));
}

// file-ops: renames case-only, also when the filesystem is case-insensitive
#[test]
fn renames_case_only_also_when_the_filesystem_is_case_insensitive() {
    let fx = fixture();
    assert_eq!(fx.rename("a.txt", "A.txt"), json!({ "ok": true, "from": "a.txt", "to": "A.txt" }));
    assert!(fx.names("").contains(&"A.txt".to_string()));
    assert!(!fx.names("").contains(&"a.txt".to_string()));
    assert_eq!(fx.read("A.txt"), "A");
    fs::create_dir(fx.p("Folder")).unwrap();
    assert_matches(&fx.rename("Folder", "folder"), json!({ "ok": true }));
    assert!(fx.names("").contains(&"folder".to_string()));
    // Nothing of the temporary name is left.
    assert!(!fx.names("").iter().any(|n| n.starts_with(".mc-rename-")));
}

// file-ops: renaming to the same name is a no-op
#[test]
fn renaming_to_the_same_name_is_a_no_op() {
    let fx = fixture();
    assert_eq!(fx.rename("a.txt", "a.txt"), json!({ "ok": true, "from": "a.txt", "to": "a.txt" }));
}

// ---------- create ----------

// file-ops: creates files and folders without overwriting
#[test]
fn creates_files_and_folders_without_overwriting() {
    let fx = fixture();
    let create = |dir: &str, name: &str, folder: bool| {
        create_project_entry(&fx.r(), &json!(dir), &json!(name), folder, LocalPlatform::native())
    };
    assert_eq!(create("src", "new.txt", false), json!({ "ok": true, "path": "src/new.txt" }));
    assert_eq!(create("", "dir", true), json!({ "ok": true, "path": "dir" }));
    assert_matches(&create("src", "b.txt", false), json!({ "ok": false }));
    assert_eq!(fx.read("src/b.txt"), "B");
    assert!(fx.p("dir").is_dir());
    assert_matches(&create("..", "x.txt", false), json!({ "ok": false }));
    assert_matches(&create("a.txt", "x.txt", false), json!({ "ok": false, "error": "Miejsce docelowe nie jest folderem." }));
    assert_eq!(fs::read(fx.p("src/new.txt")).unwrap(), b"");
}

// ---------- move ----------

// file-ops: moves a file and a folder with content into another folder
#[test]
fn moves_a_file_and_a_folder_with_content_into_another_folder() {
    let fx = fixture();
    let result = fx.mv(&["a.txt", "src"], "docs", "replace");
    assert_eq!(result["ok"], true);
    assert_eq!(fx.names("docs"), ["a.txt", "src"]);
    assert_eq!(fx.read("docs/a.txt"), "A");
    assert_eq!(fx.read("docs/src/deep/c.txt"), "C");
    assert_eq!(fx.names(""), ["docs"]);
}

// file-ops: moves to the project root
#[test]
fn moves_to_the_project_root() {
    let fx = fixture();
    assert_matches(&fx.mv(&["src/deep"], "", "ask"), json!({ "ok": true, "done": [{ "from": "src/deep", "to": "deep" }] }));
    assert_eq!(fx.read("deep/c.txt"), "C");
}

// file-ops: reports conflicts first and changes nothing
#[test]
fn reports_conflicts_first_and_changes_nothing() {
    let fx = fixture();
    assert_eq!(
        fx.mv(&["a.txt"], "docs", "ask"),
        json!({ "ok": false, "code": "conflict", "error": "Element o takiej nazwie już istnieje.",
                "conflicts": [{ "path": "docs/a.txt", "name": "a.txt", "directory": false }] })
    );
    assert_eq!(fx.read("a.txt"), "A");
    assert_eq!(fx.read("docs/a.txt"), "other A");
}

// file-ops: replace sends the old item to the trash, never deleting it
#[test]
fn replace_sends_the_old_item_to_the_trash_never_deleting_it() {
    let fx = fixture();
    fx.mv(&["a.txt"], "docs", "replace");
    let real_root = fsx::realpath(&fx.r()).unwrap();
    assert_eq!(fx.trashed(), [s(&Path::new(&real_root).join("docs").join("a.txt"))]);
    assert_eq!(fs::read_to_string(fx.trash_dir.join("1-a.txt")).unwrap(), "other A");
    assert_eq!(fx.read("docs/a.txt"), "A");
}

// file-ops: keep both numbers the moved item
#[test]
fn keep_both_numbers_the_moved_item() {
    let fx = fixture();
    fx.mv(&["a.txt"], "docs", "keepBoth");
    assert_eq!(fx.names("docs"), ["a copy.txt", "a.txt"]);
    fs::write(fx.p("a.txt"), "A2").unwrap();
    fx.mv(&["a.txt"], "docs", "keepBoth");
    assert_eq!(fx.names("docs"), ["a copy 2.txt", "a copy.txt", "a.txt"]);
    assert_eq!(fx.read("docs/a copy 2.txt"), "A2");
}

// file-ops: skip leaves the conflicting item where it was
#[test]
fn skip_leaves_the_conflicting_item_where_it_was() {
    let fx = fixture();
    assert_matches(
        &fx.mv(&["a.txt", "src/b.txt"], "docs", "skip"),
        json!({ "ok": true, "skipped": ["a.txt"], "done": [{ "from": "src/b.txt", "to": "docs/b.txt" }] }),
    );
    assert!(fx.names("").contains(&"a.txt".to_string()));
}

// file-ops: refuses to move a folder into itself or a descendant
#[test]
fn refuses_to_move_a_folder_into_itself_or_a_descendant() {
    let fx = fixture();
    assert_eq!(
        fx.mv(&["src"], "src", "ask"),
        json!({ "ok": false, "error": "Nie można przenieść folderu do niego samego ani do jego podfolderu." })
    );
    assert_matches(&fx.mv(&["src"], "src/deep", "ask"), json!({ "ok": false }));
    assert_matches(&fx.cp(&["src"], "src/deep", "ask"), json!({ "ok": false }));
    assert_eq!(fx.names("src"), ["b.txt", "deep"]);
}

// file-ops: refuses a replace that would trash the source itself
#[test]
fn refuses_a_replace_that_would_trash_the_source_itself() {
    let fx = fixture();
    fs::create_dir_all(fx.p("x/x")).unwrap();
    fs::write(fx.p("x/x/f.txt"), "f").unwrap();
    assert_matches(&fx.mv(&["x/x"], "x", "replace"), json!({ "ok": true, "done": [], "skipped": ["x/x"] }));
    fs::create_dir_all(fx.p("x/y/y")).unwrap();
    assert_matches(
        &fx.mv(&["x/y/y"], "x", "replace"),
        json!({ "ok": true, "failed": [{ "path": "x/y/y", "error": "Nie można zastąpić folderu, który zawiera przenoszony element." }] }),
    );
    assert!(fx.trashed().is_empty());
    assert!(fx.p("x/y/y").is_dir());
}

// file-ops: moving into the folder it is already in is a no-op
#[test]
fn moving_into_the_folder_it_is_already_in_is_a_no_op() {
    let fx = fixture();
    assert_matches(&fx.mv(&["src/b.txt"], "src", "ask"), json!({ "ok": true, "done": [], "skipped": ["src/b.txt"] }));
}

// file-ops: refuses a destination that is not a folder or does not exist
#[test]
fn refuses_a_destination_that_is_not_a_folder_or_does_not_exist() {
    let fx = fixture();
    assert_eq!(fx.mv(&["a.txt"], "src/b.txt", "ask"), json!({ "ok": false, "error": "Miejsce docelowe nie jest folderem." }));
    assert_eq!(
        fx.mv(&["a.txt"], "nope", "ask"),
        json!({ "ok": false, "error": "Plik lub folder już nie istnieje. Odśwież listę." })
    );
}

// file-ops: drops entries that are inside another selected folder
#[test]
fn drops_entries_that_are_inside_another_selected_folder() {
    let fx = fixture();
    assert_matches(
        &fx.mv(&["src", "src/deep/c.txt"], "docs", "ask"),
        json!({ "ok": true, "done": [{ "from": "src", "to": "docs/src" }] }),
    );
}

// file-ops: refuses a missing source
#[test]
fn refuses_a_missing_source() {
    let fx = fixture();
    assert_eq!(
        fx.mv(&["ghost.txt"], "docs", "ask"),
        json!({ "ok": false, "error": "Plik lub folder już nie istnieje. Odśwież listę." })
    );
}

// ---------- copy ----------

fn mtime_ms(path: &Path) -> u128 {
    fs::metadata(path).unwrap().modified().unwrap().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis()
}

// file-ops: copies a file and a whole tree and keeps modification times
#[test]
fn copies_a_file_and_a_whole_tree_and_keeps_modification_times() {
    let fx = fixture();
    let when = SystemTime::UNIX_EPOCH + Duration::from_millis(1_577_934_245_000); // 2020-01-02T03:04:05Z
    let file = fs::File::options().write(true).open(fx.p("src/b.txt")).unwrap();
    file.set_times(fs::FileTimes::new().set_accessed(when).set_modified(when)).unwrap();
    drop(file);
    assert_matches(&fx.cp(&["src"], "docs", "ask"), json!({ "ok": true, "done": [{ "from": "src", "to": "docs/src" }] }));
    assert_eq!(fx.read("docs/src/deep/c.txt"), "C");
    assert_eq!(fx.read("src/deep/c.txt"), "C");
    assert_eq!(mtime_ms(&fx.p("docs/src/b.txt")), 1_577_934_245_000);
    // The copied folders keep their times too (set after their content).
    // Like a JS Date: whole milliseconds, rounded.
    let source = fs::metadata(fx.p("src/deep")).unwrap().modified().unwrap().duration_since(SystemTime::UNIX_EPOCH).unwrap();
    assert_eq!(mtime_ms(&fx.p("docs/src/deep")), (source.as_nanos() + 500_000) / 1_000_000);
}

// file-ops: pasting into the same folder duplicates as "copy", "copy 2"
#[test]
fn pasting_into_the_same_folder_duplicates_as_copy_copy_2() {
    let fx = fixture();
    assert_matches(&fx.cp(&["a.txt"], "", "ask"), json!({ "ok": true, "done": [{ "from": "a.txt", "to": "a copy.txt" }] }));
    assert_matches(&fx.cp(&["a.txt"], "", "ask"), json!({ "ok": true, "done": [{ "from": "a.txt", "to": "a copy 2.txt" }] }));
    assert_matches(&fx.cp(&["a copy.txt"], "", "ask"), json!({ "ok": true, "done": [{ "to": "a copy 3.txt" }] }));
    assert_matches(&fx.cp(&["src"], "", "ask"), json!({ "ok": true, "done": [{ "to": "src copy" }] }));
    assert_eq!(fx.read("src copy/deep/c.txt"), "C");
}

// file-ops: asks about conflicts, then replaces (old item to the trash) or keeps both
#[test]
fn asks_about_conflicts_then_replaces_or_keeps_both() {
    let fx = fixture();
    assert_matches(&fx.cp(&["a.txt"], "docs", "ask"), json!({ "ok": false, "code": "conflict" }));
    fx.cp(&["a.txt"], "docs", "keepBoth");
    assert_eq!(fx.names("docs"), ["a copy.txt", "a.txt"]);
    fx.cp(&["a.txt"], "docs", "replace");
    assert_eq!(fx.trashed().len(), 1);
    assert_eq!(fx.read("docs/a.txt"), "A");
    assert_eq!(fx.read("a.txt"), "A");
}

// file-ops: does not follow symlinks: they are copied as links or skipped
#[test]
fn does_not_follow_symlinks_they_are_copied_as_links_or_skipped() {
    let fx = fixture();
    let external = fx.fixture.join("external");
    fs::create_dir(&external).unwrap();
    fs::write(external.join("secret.txt"), "secret").unwrap();
    fs::create_dir(fx.p("tree")).unwrap();
    fs::write(fx.p("tree/ok.txt"), "ok").unwrap();
    let linked = fx.link_dir(&external, &fx.p("tree/link"));
    let result = fx.cp(&["tree"], "docs", "ask");
    assert_eq!(result["ok"], true);
    assert_eq!(fx.read("docs/tree/ok.txt"), "ok");
    if linked {
        let copied = fx.p("docs/tree/link");
        if fx.names("docs/tree").contains(&"link".to_string()) {
            assert!(fs::symlink_metadata(&copied).unwrap().file_type().is_symlink());
            // The link points where the original pointed; its content was not copied.
            assert_eq!(fsx::realpath(&s(&copied)).unwrap(), fsx::realpath(&s(&external)).unwrap());
        } else {
            assert_eq!(result["notes"], json!(["link"]));
        }
    }
    assert_eq!(fs::read_to_string(external.join("secret.txt")).unwrap(), "secret");
}

// file-ops: asks for confirmation above the size/entry limits and goes on once forced
#[test]
fn asks_for_confirmation_above_the_size_entry_limits_and_goes_on_once_forced() {
    let fx = fixture();
    let limited = |bytes: u64, entries: u64| {
        let mut o = fx.options();
        o.limits = (bytes, entries);
        o
    };
    let warned = fx.transfer("copy", &["src"], "docs", "ask", limited(1000, 3));
    assert_eq!(
        warned,
        json!({ "ok": false, "code": "large", "error": "Kopiowanie jest bardzo duże.", "entries": 4, "bytes": 2 })
    );
    assert_eq!(fx.names("docs"), ["a.txt"]);
    let request = json!({ "kind": "copy", "paths": ["src"], "destination": "docs", "conflict": "ask", "force": true });
    let forced = transfer_project_entries(&fx.r(), &request, &limited(1000, 3));
    assert_eq!(forced["ok"], true);
    assert_eq!(fx.read("docs/src/deep/c.txt"), "C");
    assert_matches(&fx.transfer("copy", &["a.txt"], "src", "ask", limited(0, 100)), json!({ "ok": false, "code": "large" }));
}

// file-ops: can be cancelled and leaves no partial copy
#[test]
fn can_be_cancelled_and_leaves_no_partial_copy() {
    let fx = fixture();
    let mut options = fx.options();
    options.cancel = Some(Arc::new(AtomicBool::new(true)));
    assert_matches(&fx.transfer("copy", &["src"], "docs", "ask", options), json!({ "ok": true, "done": [], "cancelled": true }));
    assert_eq!(fx.names("docs"), ["a.txt"]);
}

/// A cancel in the middle of a copy (the renderer's Cancel button) removes the half-made tree and stops the rest.
#[test]
fn a_cancel_in_the_middle_removes_the_partial_copy() {
    let fx = fixture();
    let external = fx.fixture.join("external");
    fs::create_dir(&external).unwrap();
    for i in 0..20 {
        fs::write(fx.p(&format!("src/f{i:02}.txt")), "x").unwrap();
    }
    // A link in the middle of the tree: copying it presses Cancel (the next entry sees it).
    if !fx.link_dir(&external, &fx.p("src/deep/link")) {
        return;
    }
    let flag = Arc::new(AtomicBool::new(false));
    let mut options = fx.options();
    options.cancel = Some(flag.clone());
    options.hooks.symlink = Some(Box::new(move |target: &str, path: &str, kind: LinkType| {
        flag.store(true, std::sync::atomic::Ordering::SeqCst);
        fsx::symlink(target, path, kind)
    }));
    let result = fx.transfer("copy", &["src", "a.txt"], "docs", "keepBoth", options);
    // NTFS lists the folder in name order, so the link is never the last entry there (a hashed directory order elsewhere
    // may put it last; then src is complete and only a.txt is cancelled).
    if cfg!(windows) || result["done"] == json!([]) {
        assert_matches(&result, json!({ "ok": true, "done": [], "failed": [], "cancelled": true }));
        // Neither the half-made src nor the later a.txt copy is there.
        assert_eq!(fx.names("docs"), ["a.txt"]);
    } else {
        assert_matches(&result, json!({ "ok": true, "done": [{ "from": "src" }], "failed": [], "cancelled": true }));
        assert_eq!(fx.names("docs"), ["a.txt", "src"]);
    }
    assert_eq!(fx.read("docs/a.txt"), "other A");
    assert!(fx.trashed().is_empty());
}

// file-ops: reports progress
#[test]
fn reports_progress() {
    let fx = fixture();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let mut options = fx.options();
    let s2 = seen.clone();
    options.on_progress = Some(Box::new(move |entries, bytes| s2.lock().unwrap().push((entries, bytes))));
    fx.transfer("copy", &["src"], "docs", "ask", options);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.last(), Some(&(4, 2)));
    // The first tick reports at once (1.1.4: `now - 0 > 120`).
    assert_eq!(seen.first(), Some(&(0, 0)));
}

// ---------- delete ----------

// file-ops: sends files and folders to the trash and never removes them itself
#[test]
fn sends_files_and_folders_to_the_trash_and_never_removes_them_itself() {
    let fx = fixture();
    assert_eq!(fx.delete(json!(["a.txt", "src"])), json!({ "ok": true, "trashed": ["a.txt", "src"], "failed": [] }));
    assert_eq!(fx.trashed().len(), 2);
    assert_eq!(fx.names(""), ["docs"]);
    assert_eq!(fs::read_to_string(fx.trash_dir.join("2-src").join("deep").join("c.txt")).unwrap(), "C");
}

// file-ops: collapses nested selections and reports failures per item
#[test]
fn collapses_nested_selections_and_reports_failures_per_item() {
    let fx = fixture();
    assert_matches(&fx.delete(json!(["src", "src/b.txt"])), json!({ "ok": true, "trashed": ["src"] }));
    assert_eq!(fx.trashed().len(), 1);
    let failing = |_: &str| Err(FsError::plain("no bin"));
    assert_eq!(
        delete_project_entries(&fx.r(), &json!(["a.txt"]), &failing),
        json!({ "ok": true, "trashed": [], "failed": [{ "path": "a.txt", "error": "no bin" }] })
    );
    assert_eq!(fx.read("a.txt"), "A");
}

// file-ops: refuses the project root, outside paths and empty selections
#[test]
fn refuses_the_project_root_outside_paths_and_empty_selections() {
    let fx = fixture();
    assert_eq!(fx.delete(json!([""])), json!({ "ok": false, "error": "Nie można zmieniać katalogu głównego projektu." }));
    assert_eq!(fx.delete(json!(["../outside.txt"])), json!({ "ok": false, "error": "Ścieżka jest poza projektem." }));
    assert_eq!(fx.delete(json!([])), json!({ "ok": false, "error": "Nie wybrano żadnych elementów." }));
    assert!(fx.trashed().is_empty());
}

// ---------- one operation never replaces what it just produced ----------

fn abc(fx: &Fx) {
    for d in ["a", "b", "c"] {
        fs::create_dir(fx.p(d)).unwrap();
    }
    fs::write(fx.p("a/x.txt"), "from a").unwrap();
    fs::write(fx.p("b/x.txt"), "from b").unwrap();
}

// file-ops: two sources with the same name: Replace gives the second a free name and trashes nothing
#[test]
fn two_sources_with_the_same_name_replace_gives_the_second_a_free_name() {
    let fx = fixture();
    abc(&fx);
    assert_matches(
        &fx.mv(&["a/x.txt", "b/x.txt"], "c", "ask"),
        json!({ "ok": false, "code": "conflict", "conflicts": [{ "name": "x.txt", "internal": true }] }),
    );
    assert_matches(
        &fx.mv(&["a/x.txt", "b/x.txt"], "c", "replace"),
        json!({ "ok": true, "replaced": [], "done": [{ "from": "a/x.txt", "to": "c/x.txt" }, { "from": "b/x.txt", "to": "c/x copy.txt" }] }),
    );
    assert!(fx.trashed().is_empty());
    assert_eq!(fx.read("c/x.txt"), "from a");
    assert_eq!(fx.read("c/x copy.txt"), "from b");
}

// file-ops: an existing target is still replaced once (and reported), the duplicate keeps both
#[test]
fn an_existing_target_is_still_replaced_once_the_duplicate_keeps_both() {
    let fx = fixture();
    abc(&fx);
    fs::write(fx.p("c/x.txt"), "old").unwrap();
    assert_matches(
        &fx.mv(&["a/x.txt", "b/x.txt"], "c", "replace"),
        json!({ "ok": true, "replaced": ["c/x.txt"], "done": [{ "to": "c/x.txt" }, { "to": "c/x copy.txt" }] }),
    );
    assert_eq!(fx.trashed().len(), 1);
    assert_eq!(fx.read("c/x.txt"), "from a");
}

// file-ops: Skip skips the duplicate and copies behave the same
#[test]
fn skip_skips_the_duplicate_and_copies_behave_the_same() {
    let fx = fixture();
    abc(&fx);
    assert_matches(
        &fx.cp(&["a/x.txt", "b/x.txt"], "c", "skip"),
        json!({ "ok": true, "skipped": ["b/x.txt"], "done": [{ "to": "c/x.txt" }] }),
    );
    assert_matches(
        &fx.cp(&["a/x.txt", "b/x.txt"], "c", "replace"),
        json!({ "ok": true, "replaced": ["c/x.txt"], "done": [{ "to": "c/x.txt" }, { "to": "c/x copy.txt" }] }),
    );
}

// ---------- hostile requests ----------

// file-ops: rejects unknown conflict policies instead of replacing
#[test]
fn rejects_unknown_conflict_policies_instead_of_replacing() {
    let fx = fixture();
    for conflict in [json!("bogus"), json!("REPLACE"), json!(""), json!(1), json!({})] {
        let request = json!({ "kind": "move", "paths": ["a.txt"], "destination": "docs", "conflict": conflict });
        assert_eq!(
            transfer_project_entries(&fx.r(), &request, &fx.options()),
            json!({ "ok": false, "error": "Nieznana operacja." })
        );
    }
    assert!(fx.trashed().is_empty());
    assert_eq!(fx.read("docs/a.txt"), "other A");
}

// file-ops: rejects non-string, oversized and too many paths
#[test]
fn rejects_non_string_oversized_and_too_many_paths() {
    let fx = fixture();
    let run = |paths: Value, destination: Value| {
        let request = json!({ "kind": "copy", "paths": paths, "destination": destination, "conflict": "ask" });
        transfer_project_entries(&fx.r(), &request, &fx.options())
    };
    let too_many: Vec<String> = (0..5001).map(|i| format!("f{i}")).collect();
    assert_matches(&run(json!([{ "toString": "a.txt" }]), json!("docs")), json!({ "ok": false }));
    assert_matches(&run(json!([42]), json!("docs")), json!({ "ok": false }));
    assert_matches(&run(json!(["a".repeat(5000)]), json!("docs")), json!({ "ok": false }));
    assert_eq!(
        run(json!(too_many), json!("docs")),
        json!({ "ok": false, "error": "Zbyt wiele elementów lub zbyt długa ścieżka." })
    );
    assert_matches(&run(json!(["a.txt"]), json!("d".repeat(5000))), json!({ "ok": false }));
    assert_matches(&run(json!(["a.txt"]), json!(5)), json!({ "ok": false }));
    assert_matches(&run(json!("a.txt"), json!("docs")), json!({ "ok": false }));
    assert_matches(&fx.delete(json!(too_many)), json!({ "ok": false }));
    assert_matches(&fx.delete(json!([{ "x": 1 }])), json!({ "ok": false }));
    assert_matches(&fx.rename(&"a".repeat(5000), "x"), json!({ "ok": false }));
    assert_matches(&rename_project_entry(&fx.r(), &json!("a.txt"), &json!(5), LocalPlatform::native()), json!({ "ok": false }));
    assert!(fx.trashed().is_empty());
}

// file-ops: handles a large selection quickly (linear de-duplication)
#[test]
fn handles_a_large_selection_quickly() {
    let fx = fixture();
    let paths: Vec<String> = (0..5000).map(|i| format!("ghost/{i}")).collect();
    let started = Instant::now();
    let request = json!({ "kind": "copy", "paths": paths, "destination": "docs", "conflict": "ask" });
    transfer_project_entries(&fx.r(), &request, &fx.options());
    assert!(started.elapsed() < Duration::from_secs(3));
}

// ---------- cross-device move (EXDEV) ----------

fn exdev(from: &str, _to: &str) -> Result<(), FsError> {
    let mut e = FsError::plain(format!("EXDEV: cross-device link not permitted, rename '{from}'"));
    e.code = Some("EXDEV");
    Err(e)
}

// file-ops: copies and then removes the source when everything could be copied
#[test]
fn exdev_copies_and_then_removes_the_source() {
    let fx = fixture();
    let mut options = fx.options();
    options.hooks.rename = Some(Box::new(exdev));
    assert_matches(
        &fx.transfer("move", &["src"], "docs", "ask", options),
        json!({ "ok": true, "done": [{ "from": "src", "to": "docs/src" }] }),
    );
    assert_eq!(fx.read("docs/src/deep/c.txt"), "C");
    assert!(!fx.names("").contains(&"src".to_string()));
}

// file-ops: keeps the source and leaves no partial copy when a link could not be copied
#[test]
fn exdev_keeps_the_source_when_a_link_could_not_be_copied() {
    let fx = fixture();
    let external = fx.fixture.join("external");
    fs::create_dir(&external).unwrap();
    if !fx.link_dir(&external, &fx.p("src/link")) {
        return;
    }
    let mut options = fx.options();
    options.hooks.rename = Some(Box::new(exdev));
    options.hooks.symlink = Some(Box::new(|_: &str, _: &str, _: LinkType| Err(FsError::plain("EPERM"))));
    assert_matches(
        &fx.transfer("move", &["src"], "docs", "ask", options),
        json!({ "ok": true, "done": [], "failed": [{ "path": "src" }], "notes": [] }),
    );
    assert_eq!(fx.names("src"), ["b.txt", "deep", "link"]);
    assert_eq!(fx.read("src/deep/c.txt"), "C");
    assert_eq!(fx.names("docs"), ["a.txt"]);
}

/// The full answer of a move (the order of the keys is what the renderer gets).
#[test]
fn a_transfer_answers_every_field_in_1_1_4_order() {
    let fx = fixture();
    let result = fx.mv(&["a.txt"], "src", "ask");
    let keys: Vec<&String> = result.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["ok", "done", "skipped", "failed", "notes", "cancelled", "replaced"]);
    assert_eq!(
        result,
        json!({ "ok": true, "done": [{ "from": "a.txt", "to": "src/a.txt" }], "skipped": [], "failed": [], "notes": [], "cancelled": false, "replaced": [] })
    );
}
