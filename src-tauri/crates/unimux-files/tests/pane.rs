//! Ports of the local-pane cases of test/sftp-main.test.ts ("local files of the SFTP view": list, roots, mkdir, rename,
//! trash, reveal). The trash removes into a list, Explorer / Finder are recorded: nothing reaches the desktop.

use std::fs;
use std::path::Path;
use std::sync::{Arc, Mutex};

use serde_json::{Value, json};
use unimux_files::fserr::FsError;
use unimux_files::local::LocalPlatform;
use unimux_files::pane::{LocalPane, PaneDeps};

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

struct Pane {
    pane: LocalPane,
    trashed: Arc<Mutex<Vec<String>>>,
    calls: Arc<Mutex<Vec<String>>>,
}

fn pane(platform: LocalPlatform, home: &Path) -> Pane {
    let trashed = Arc::new(Mutex::new(Vec::new()));
    let calls = Arc::new(Mutex::new(Vec::new()));
    let (t, c1, c2) = (trashed.clone(), calls.clone(), calls.clone());
    let home = s(home);
    let pane = LocalPane::new(PaneDeps {
        platform,
        trash: Arc::new(move |p: &str| {
            t.lock().unwrap().push(p.to_string());
            let meta = fs::symlink_metadata(p).map_err(|e| FsError::io(&e, "lstat", p))?;
            let removed = if meta.is_dir() { fs::remove_dir_all(p) } else { fs::remove_file(p) };
            removed.map_err(|e| FsError::io(&e, "rm", p))
        }),
        open_folder: Box::new(move |p: &str| {
            c1.lock().unwrap().push(format!("open {p}"));
            Ok(())
        }),
        show_file: Box::new(move |p: &str| c2.lock().unwrap().push(format!("show {p}"))),
        home: Box::new(move || home.clone()),
    });
    Pane { pane, trashed, calls }
}

fn by_name(listing: &Value) -> serde_json::Map<String, Value> {
    listing["value"]["entries"].as_array().unwrap().iter().map(|e| (e["name"].as_str().unwrap().to_string(), e.clone())).collect()
}

// sftp-main: lists any folder with size, time and kind; makes, renames (never over a file) and trashes
#[test]
fn lists_any_folder_with_size_time_and_kind_makes_renames_and_trashes() {
    let tmp = tempfile::Builder::new().prefix("unimux-local-").tempdir().unwrap();
    let dir = tmp.path();
    let p = pane(LocalPlatform::native(), dir);
    let lf = &p.pane;
    let at = |name: &str| s(&dir.join(name));
    fs::write(dir.join("a.txt"), "abc").unwrap();
    fs::create_dir(dir.join("sub")).unwrap();
    fs::write(dir.join(".hidden"), "").unwrap();
    let r = lf.list(&json!(s(dir)));
    assert_eq!(r["ok"], true);
    assert_eq!(r["value"]["path"], json!(s(dir)));
    assert_eq!(r["value"]["truncated"], false);
    let entries = by_name(&r);
    let a = &entries["a.txt"];
    assert_eq!(
        (a["kind"].clone(), a["size"].clone(), a["hidden"].clone(), a["path"].clone()),
        (json!("file"), json!(3), json!(false), json!(at("a.txt")))
    );
    assert_eq!((entries["sub"]["kind"].clone(), entries["sub"]["size"].clone()), (json!("dir"), json!(0)));
    assert_eq!(entries[".hidden"]["hidden"], true);
    assert!(a["mtime"].as_i64().unwrap() > 0);
    let keys: Vec<&String> = a.as_object().unwrap().keys().collect();
    assert_eq!(keys, ["name", "path", "kind", "size", "mtime", "permissions", "hidden"]);
    if cfg!(windows) {
        assert_eq!(a["permissions"], "");
    } else {
        assert!(a["permissions"].as_str().unwrap().starts_with("-rw"));
    }
    assert_eq!(lf.list(&json!("relative")), json!({ "ok": false, "error": "invalid" }));
    assert_eq!(lf.list(&json!(at("a.txt"))), json!({ "ok": false, "error": "notADirectory" }));
    assert_eq!(lf.list(&json!(at("gone"))), json!({ "ok": false, "error": "notFound" }));
    assert_eq!(lf.mkdir(&json!(at("new"))), json!({ "ok": true, "value": null }));
    assert_eq!(lf.mkdir(&json!(at("new"))), json!({ "ok": false, "error": "exists" }));
    assert_eq!(lf.mkdir(&json!(at("x\0y"))), json!({ "ok": false, "error": "invalid" }));
    assert_eq!(lf.rename(&json!(at("a.txt")), &json!(at("sub"))), json!({ "ok": false, "error": "exists" }));
    assert_eq!(
        lf.rename(&json!(at("a.txt")), &json!(s(&dir.join("sub").join("moved.txt")))),
        json!({ "ok": false, "error": "invalid" })
    );
    assert_eq!(lf.rename(&json!(at("a.txt")), &json!(at("b.txt"))), json!({ "ok": true, "value": null }));
    assert_eq!(lf.trash(&json!([at("b.txt")])), json!({ "ok": true, "value": null }));
    assert!(!dir.join("b.txt").exists());
    assert_eq!(lf.trash(&json!([s(dir)])), json!({ "ok": false, "error": "invalid" })); // the home folder
    let roots = lf.roots();
    assert_eq!(roots["home"], json!(s(dir)));
    if cfg!(windows) {
        assert!(!roots["drives"].as_array().unwrap().is_empty());
        assert!(roots["drives"].as_array().unwrap().iter().all(|d| d.as_str().unwrap().ends_with(":\\")));
    } else {
        assert_eq!(roots["drives"], json!([]));
    }
    assert_eq!(*p.trashed.lock().unwrap(), [at("b.txt")]);
}

// sftp-main: reveals a macOS bundle (Foo.app) selected in Finder instead of opening it, and opens plain folders
#[test]
fn reveals_a_macos_bundle_selected_in_finder_and_opens_plain_folders() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    fs::create_dir_all(dir.join("Foo.app").join("Contents")).unwrap();
    fs::create_dir(dir.join("Plain")).unwrap();
    fs::write(dir.join("f.txt"), "").unwrap();
    let at = |name: &str| s(&dir.join(name));
    let mac = pane(LocalPlatform::Mac, dir);
    let contents = s(&dir.join("Foo.app").join("Contents"));
    for path in [at("Foo.app"), contents.clone(), at("Plain"), at("f.txt")] {
        assert_eq!(mac.pane.reveal(&json!(path)), json!({ "ok": true, "value": null }));
    }
    assert_eq!(
        *mac.calls.lock().unwrap(),
        [
            format!("show {}", at("Foo.app")),
            format!("open {contents}"),
            format!("open {}", at("Plain")),
            format!("show {}", at("f.txt"))
        ]
    );
    let win = pane(LocalPlatform::Windows, dir);
    win.pane.reveal(&json!(at("Foo.app")));
    assert_eq!(*win.calls.lock().unwrap(), [format!("open {}", at("Foo.app"))]);
    assert_eq!(win.pane.reveal(&json!(at("missing"))), json!({ "ok": false, "error": "notFound" }));
    assert_eq!(win.pane.reveal(&json!(5)), json!({ "ok": false, "error": "invalid" }));
}

/// The trash refuses lists that are not lists, too long (`tooMany`), drive roots; a failing trash stops at its first
/// error with the code of the failure.
#[test]
fn trash_refuses_roots_and_long_lists_and_reports_the_first_failure() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    let home = tmp.path().join("home");
    fs::create_dir(&home).unwrap();
    let p = pane(LocalPlatform::native(), &home);
    let root = if cfg!(windows) { "C:\\".to_string() } else { "/".to_string() };
    assert_eq!(p.pane.trash(&json!([root])), json!({ "ok": false, "error": "invalid" }));
    assert_eq!(p.pane.trash(&json!([])), json!({ "ok": false, "error": "invalid" }));
    assert_eq!(p.pane.trash(&json!("x")), json!({ "ok": false, "error": "invalid" }));
    let many: Vec<String> = (0..1001).map(|i| s(&dir.join(format!("f{i}")))).collect();
    assert_eq!(p.pane.trash(&json!(many)), json!({ "ok": false, "error": "tooMany" }));
    fs::write(dir.join("one"), "").unwrap();
    let result = p.pane.trash(&json!([s(&dir.join("one")), s(&dir.join("missing")), s(&dir.join("never"))]));
    assert_eq!(result, json!({ "ok": false, "error": "notFound" }));
    assert_eq!(p.trashed.lock().unwrap().len(), 2);
}

/// A case-only rename in the local pane is allowed where both names are the same file (NTFS, APFS).
#[test]
fn rename_case_only_where_both_names_are_one_file() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    fs::write(dir.join("Readme.md"), "x").unwrap();
    let p = pane(LocalPlatform::native(), dir);
    let r = p.pane.rename(&json!(s(&dir.join("Readme.md"))), &json!(s(&dir.join("README.md"))));
    let same = unimux_files::fsx::same_file(&s(&dir.join("Readme.md")), &s(&dir.join("README.md")));
    if cfg!(any(windows, target_os = "macos")) || same {
        assert_eq!(r, json!({ "ok": true, "value": null }));
        let names: Vec<String> =
            fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["README.md"]);
    }
    // A Windows name that is not safe (a device, a trailing dot) is refused before the disk is asked.
    let win = pane(LocalPlatform::Windows, dir);
    assert_eq!(win.pane.mkdir(&json!(s(&dir.join("NUL")))), json!({ "ok": false, "error": "invalid" }));
    assert_eq!(win.pane.mkdir(&json!(s(&dir.join("clock$.txt")))), json!({ "ok": false, "error": "invalid" }));
    assert_eq!(win.pane.mkdir(&json!(s(&dir.join("dot.")))), json!({ "ok": false, "error": "invalid" }));
}

/// A link is listed as a link with what it points to; a link to a file carries that file's size.
#[test]
fn links_are_listed_with_their_target() {
    let tmp = tempfile::tempdir().unwrap();
    let dir = tmp.path();
    fs::create_dir(dir.join("real")).unwrap();
    #[cfg(windows)]
    let made = junction::create(dir.join("real"), dir.join("link")).is_ok();
    #[cfg(unix)]
    let made = std::os::unix::fs::symlink(dir.join("real"), dir.join("link")).is_ok();
    if !made {
        return;
    }
    let p = pane(LocalPlatform::native(), dir);
    let entries = by_name(&p.pane.list(&json!(s(dir))));
    assert_eq!(entries["link"]["kind"], "symlink");
    assert_eq!(entries["link"]["target"], "dir");
    assert_eq!(entries["link"]["size"], 0);
}
