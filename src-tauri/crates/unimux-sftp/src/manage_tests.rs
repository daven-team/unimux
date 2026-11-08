//! T4: the manage ops and editor files against the in-memory server ([`crate::fake_server`]).

use std::sync::Arc;

use serde_json::{Value, json};

use crate::backend::manage_op;
use crate::client::SftpClient;
use crate::edit_file::{read_for_editor, set_mode_no_follow, stat_for_editor, write_from_editor};
use crate::error::SftpErrorCode;
use crate::fake_server::{Config, Fake, Node};
use crate::host::HostChannels;
use crate::manage::RunningOps;
use crate::op::{ChmodRequest, DeleteCount, EditorSave, RemoteStamp, SftpOp};
use crate::remote::RemoteSide;
use crate::sides::FileSide;

async fn connect(cfg: Config) -> (Arc<Fake>, RemoteSide) {
    let fake = Fake::new(cfg);
    let (a, b) = tokio::io::duplex(1 << 20);
    tokio::spawn(fake.clone().serve(b));
    let client = SftpClient::start(Box::new(a)).await.unwrap();
    (fake, RemoteSide::new(client))
}

async fn op(side: &RemoteSide, op: SftpOp) -> Result<Value, SftpErrorCode> {
    manage_op(side, "sftp:s", false, &op, &RunningOps::default(), &HostChannels::unattached()).await.expect("a T4 op")
}

fn tree(fake: &Fake) {
    fake.put("/d", Node::Dir);
    fake.put("/d/a", Node::File(b"a".to_vec(), 1));
    fake.put("/d/b", Node::Dir);
    fake.put("/d/b/c", Node::File(b"c".to_vec(), 1));
    fake.put("/e", Node::File(b"e".to_vec(), 1));
}

#[tokio::test]
async fn delete_counts_first_and_refuses_a_changed_selection() {
    let (fake, side) = connect(Config::default()).await;
    tree(&fake);
    let paths = vec!["/d".to_string(), "/d/b/".to_string(), "/e".to_string()];
    let count = op(&side, SftpOp::DeleteCount { paths: paths.clone() }).await.unwrap();
    assert_eq!(count, json!({ "files": 3, "dirs": 2 }));
    let wrong = DeleteCount { files: 2, dirs: 2 };
    assert_eq!(op(&side, SftpOp::Delete { paths: paths.clone(), confirmed: wrong }).await, Err(SftpErrorCode::Changed));
    assert!(fake.get("/d/b/c").is_some(), "nothing removed after a changed count");
    let right = DeleteCount { files: 3, dirs: 2 };
    assert_eq!(op(&side, SftpOp::Delete { paths, confirmed: right }).await, Ok(Value::Null));
    assert_eq!(fake.fs.lock().keys().cloned().collect::<Vec<_>>(), vec!["/".to_string()]);
    assert_eq!(op(&side, SftpOp::DeleteCount { paths: vec!["/".into()] }).await, Err(SftpErrorCode::Invalid));
    assert_eq!(op(&side, SftpOp::DeleteCount { paths: vec!["/gone".into()] }).await, Err(SftpErrorCode::NotFound));
}

#[tokio::test]
async fn chmod_counts_and_changes_through_lsetstat() {
    let (fake, side) = connect(Config { lsetstat: true, ..Config::default() }).await;
    tree(&fake);
    let count = op(&side, SftpOp::ChmodCount { paths: vec!["/d".into()], recursive: true }).await.unwrap();
    assert_eq!(count, json!({ "files": 2, "dirs": 2, "links": 0, "noFollow": true }));
    let flat = op(&side, SftpOp::ChmodCount { paths: vec!["/d".into(), "/e".into()], recursive: false }).await.unwrap();
    assert_eq!(flat, json!({ "files": 1, "dirs": 1, "links": 0, "noFollow": true }));
    let req = ChmodRequest {
        paths: vec!["/d".into()],
        set: None,
        recursive: Some((0o700, 0o600)),
        op_id: Some("op-1".into()),
        total: None,
    };
    assert_eq!(op(&side, SftpOp::Chmod { req }).await.unwrap(), json!({ "changed": 4, "errors": [] }));
    let set = ChmodRequest { paths: vec!["/e".into()], set: Some((0o755, 0o777)), recursive: None, op_id: None, total: None };
    assert_eq!(op(&side, SftpOp::Chmod { req: set }).await.unwrap(), json!({ "changed": 1, "errors": [] }));
    let neither = ChmodRequest { paths: vec!["/e".into()], set: None, recursive: None, op_id: None, total: None };
    assert_eq!(op(&side, SftpOp::Chmod { req: neither }).await, Err(SftpErrorCode::Invalid));
    let root = ChmodRequest { paths: vec!["/".into()], set: None, recursive: Some((0o755, 0o644)), op_id: None, total: None };
    assert_eq!(op(&side, SftpOp::Chmod { req: root }).await, Err(SftpErrorCode::Invalid));
}

#[tokio::test]
async fn a_recursive_change_as_root_needs_lsetstat() {
    let (fake, side) = connect(Config::default()).await;
    tree(&fake);
    let req = ChmodRequest { paths: vec!["/d".into()], set: None, recursive: Some((0o755, 0o644)), op_id: None, total: None };
    let r = manage_op(&side, "s", true, &SftpOp::Chmod { req }, &RunningOps::default(), &HostChannels::unattached()).await;
    assert_eq!(r, Some(Err(SftpErrorCode::UnsafeChmod)));
}

fn save(text: &str, baseline: &str, expected: Option<RemoteStamp>) -> EditorSave {
    EditorSave { text: text.into(), baseline: baseline.into(), encoding: "utf-8".into(), expected, allow_owner_change: false }
}

fn stamp_of(v: &Value) -> RemoteStamp {
    RemoteStamp {
        size: v["size"].as_f64().unwrap(),
        mtime_ms: v["mtimeMs"].as_f64().unwrap(),
        hash: v["hash"].as_str().map(String::from),
        read_at: v["readAt"].as_f64(),
    }
}

#[tokio::test]
async fn editor_reads_and_saves_through_a_part_file() {
    let (fake, side) = connect(Config { posix_rename: true, ..Config::default() }).await;
    fake.put("/f.txt", Node::File(b"one\r\ntwo".to_vec(), 7));
    let read = read_for_editor(&side, "/f.txt").await.unwrap();
    assert_eq!(read["kind"], "text");
    assert_eq!(read["text"], "one\r\ntwo");
    assert_eq!(read["encoding"], "utf-8");
    assert_eq!(read["stamp"]["size"], 8);
    assert_eq!(read["stamp"]["mtimeMs"], 7000);
    assert_eq!(stat_for_editor(&side, "/f.txt").await.unwrap(), json!({ "size": 8, "mtimeMs": 7000 }));
    // A leftover part file is replaced, never written through.
    fake.put("/f.txt.unimux-part", Node::File(b"old".to_vec(), 1));
    let stamp = stamp_of(&read["stamp"]);
    let saved = write_from_editor(&side, "/f.txt", &save("ONE\nTWO\nthree", "one\r\ntwo", Some(stamp.clone())), "editor:s")
        .await
        .unwrap();
    assert_eq!(saved["kind"], "saved");
    assert_eq!(saved["warnings"], json!([]));
    assert!(saved["stamp"]["hash"].is_string());
    match fake.get("/f.txt") {
        Some(Node::File(data, _)) => assert_eq!(data, b"ONE\r\nTWO\r\nthree"),
        other => panic!("{other:?}"),
    }
    assert!(fake.get("/f.txt.unimux-part").is_none());
    assert!(!side.inflight().is_held("/f.txt"));
    // The old stamp no longer fits the file.
    let stale = write_from_editor(&side, "/f.txt", &save("x", "", Some(stamp)), "editor:s").await;
    assert_eq!(stale, Err(SftpErrorCode::Changed));
    // A draft without a stamp compares the text.
    let draft = write_from_editor(&side, "/f.txt", &save("x", "not the server text", None), "editor:s").await;
    assert_eq!(draft, Err(SftpErrorCode::Changed));
    let ok = write_from_editor(&side, "/f.txt", &save("x", "ONE\r\nTWO\r\nthree", None), "editor:s").await.unwrap();
    assert_eq!(ok["kind"], "saved");
    // A transfer holding the target: the file is changing under the tab.
    assert!(side.inflight().hold("/f.txt", "queue"));
    let held = write_from_editor(&side, "/f.txt", &save("y", "x", None), "editor:s").await;
    assert_eq!(held, Err(SftpErrorCode::Changed));
    side.inflight().release("/f.txt", "queue");
    assert_eq!(read_for_editor(&side, "/").await, Err(SftpErrorCode::IsADirectory));
    assert_eq!(read_for_editor(&side, "/nope").await, Err(SftpErrorCode::NotFound));
    let control = write_from_editor(&side, "/f.txt", &save("a\u{1}", "x", None), "editor:s").await;
    assert_eq!(control, Err(SftpErrorCode::Invalid));
}

#[tokio::test]
async fn images_binary_and_large_files() {
    let (fake, side) = connect(Config::default()).await;
    fake.put("/p.png", Node::File(vec![0x89, b'P', b'N', b'G'], 1));
    fake.put("/b.bin", Node::File(vec![0, 1, 2], 1));
    let img = read_for_editor(&side, "/p.png").await.unwrap();
    assert_eq!(img["kind"], "image");
    assert_eq!(img["dataUrl"], "data:image/png;base64,iVBORw==");
    assert_eq!(img["size"], 4);
    assert_eq!(read_for_editor(&side, "/b.bin").await.unwrap(), json!({ "kind": "binary", "size": 3 }));
    fake.put("/big.txt", Node::File(vec![b'a'; 8 * 1024 * 1024 + 1], 1));
    assert_eq!(read_for_editor(&side, "/big.txt").await.unwrap(), json!({ "kind": "tooLarge", "size": 8 * 1024 * 1024 + 1 }));
}

#[tokio::test]
async fn a_failed_rename_without_posix_rename_strands_both_copies() {
    let (fake, side) = connect(Config::default()).await;
    fake.put("/f", Node::File(b"old".to_vec(), 3));
    let read = read_for_editor(&side, "/f").await.unwrap();
    // Every plain rename onto /f fails: the new file cannot come in and the old one cannot go back.
    fake.cfg.fail_rename_to.lock().push("/f".into());
    let r = write_from_editor(&side, "/f", &save("new", "old", Some(stamp_of(&read["stamp"]))), "editor:s").await.unwrap();
    assert_eq!(r, json!({ "kind": "stranded", "part": "/f.unimux-part", "aside": "/f.unimux-old" }));
    match fake.get("/f.unimux-part") {
        Some(Node::File(data, _)) => assert_eq!(data, b"new", "the only copy of the new text stays"),
        other => panic!("{other:?}"),
    }
    assert!(fake.get("/f.unimux-old").is_some());
}

async fn op_sudo(side: &RemoteSide, op: SftpOp) -> Result<Value, SftpErrorCode> {
    manage_op(side, "sftp:s", true, &op, &RunningOps::default(), &HostChannels::unattached()).await.expect("a T4 op")
}

fn mode_of(fake: &Fake, path: &str) -> Option<u32> {
    fake.modes.lock().get(path).copied()
}

fn readdirs(fake: &Fake) -> usize {
    fake.readdirs.load(std::sync::atomic::Ordering::SeqCst)
}

/// T4: the saved file's mode goes on the part file's own handle before it is closed; no path-based SETSTAT is sent.
#[tokio::test]
async fn editor_save_sets_the_mode_on_the_open_part_handle() {
    let (fake, side) = connect(Config { posix_rename: true, ..Config::default() }).await;
    fake.put("/f.sh", Node::File(b"old".to_vec(), 7));
    fake.modes.lock().insert("/f.sh".into(), 0o750);
    let read = read_for_editor(&side, "/f.sh").await.unwrap();
    let saved = write_from_editor(&side, "/f.sh", &save("new", "old", Some(stamp_of(&read["stamp"]))), "editor:s").await.unwrap();
    assert_eq!(saved["kind"], "saved");
    assert_eq!(saved["warnings"], json!([]));
    assert_eq!(fake.log.lock().clone(), vec!["FSETSTAT /f.sh.unimux-part".to_string()]);
    assert_eq!(mode_of(&fake, "/f.sh"), Some(0o750));
}

/// T4: the fix-up after the rename never follows a link: lsetstat when offered, else FSETSTAT on a handle of the file
/// (FSTAT on it shows a regular file of the size just written) and never in a folder others can write to; no path-based
/// SETSTAT is ever sent.
#[tokio::test]
async fn the_mode_fix_up_after_the_rename_never_follows_a_link() {
    let (fake, side) = connect(Config::default()).await;
    fake.put("/f", Node::File(b"abc".to_vec(), 1));
    fake.put("/d", Node::Dir);
    fake.put("/d/g", Node::File(b"abc".to_vec(), 1));
    assert!(!set_mode_no_follow(&side, "/d", 0o600, 3).await, "not a regular file");
    assert!(!set_mode_no_follow(&side, "/f", 0o600, 4).await, "another file than the one written");
    assert!(!set_mode_no_follow(&side, "/gone", 0o600, 3).await);
    for shared in [0o775, 0o757, 0o1777] {
        fake.modes.lock().insert("/d".into(), shared);
        assert!(!set_mode_no_follow(&side, "/d/g", 0o640, 3).await, "{shared:o}: others could swap the name for a link");
    }
    assert!(fake.log.lock().is_empty());
    assert!(fake.open_handles.lock().is_empty());
    assert!(set_mode_no_follow(&side, "/f", 0o640, 3).await);
    assert_eq!(fake.log.lock().clone(), vec!["FSETSTAT /f".to_string()]);
    assert_eq!(mode_of(&fake, "/f"), Some(0o640));
    assert!(fake.open_handles.lock().is_empty(), "the handle is closed");
    let (fake, side) = connect(Config { lsetstat: true, ..Config::default() }).await;
    fake.put("/f", Node::File(b"abc".to_vec(), 1));
    assert!(set_mode_no_follow(&side, "/f", 0o640, 99).await);
    assert_eq!(fake.log.lock().clone(), vec!["LSETSTAT /f".to_string()]);
    assert_eq!(mode_of(&fake, "/f"), Some(0o640));
}

/// T5: a folder swapped for something else between its listing and the unlinks stops the delete; nothing listed in it is
/// removed.
#[tokio::test]
async fn a_recursive_delete_stops_when_a_folder_changes_after_its_listing() {
    let (fake, side) = connect(Config::default()).await;
    tree(&fake);
    // The swap comes after the confirmed count (which reads the folders too).
    *fake.swap_on_opendir.lock() = Some(("/d/b".into(), Node::File(b"link".to_vec(), 1)));
    assert_eq!(crate::manage::remove(&side, "/d", false).await, Err(SftpErrorCode::Changed));
    assert!(fake.get("/d/b/c").is_some(), "nothing listed in the swapped folder is unlinked");
}

/// T5: through sudo (root) a recursive delete is refused in folders other users can write to: the selected folder's parent
/// or any folder inside. The count refuses it already, before anything is confirmed or removed.
#[tokio::test]
async fn under_sudo_recursive_deletes_in_shared_writable_folders_are_refused() {
    let (fake, side) = connect(Config::default()).await;
    tree(&fake);
    let paths = vec!["/d".to_string()];
    let count = DeleteCount { files: 2, dirs: 2 };
    for (path, mode) in [("/d/b", 0o775), ("/d", 0o757), ("/", 0o1777)] {
        fake.modes.lock().clear();
        fake.modes.lock().insert(path.into(), mode);
        let counted = op_sudo(&side, SftpOp::DeleteCount { paths: paths.clone() }).await;
        assert_eq!(counted, Err(SftpErrorCode::UnsafeDelete), "{path}");
        let r = op_sudo(&side, SftpOp::Delete { paths: paths.clone(), confirmed: count }).await;
        assert_eq!(r, Err(SftpErrorCode::UnsafeDelete), "{path}");
        assert!(fake.get("/d/a").is_some() && fake.get("/d/b/c").is_some(), "{path}: nothing removed");
        // Without sudo the same folders are counted (1.1.4).
        assert_eq!(op(&side, SftpOp::DeleteCount { paths: paths.clone() }).await, Ok(json!({ "files": 2, "dirs": 2 })));
    }
    // Every folder above the selected one counts, not only its parent: "/" writable by others.
    fake.modes.lock().clear();
    fake.modes.lock().insert("/".into(), 0o777);
    let inner = vec!["/d/b".to_string()];
    let one_dir = DeleteCount { files: 1, dirs: 1 };
    assert_eq!(op_sudo(&side, SftpOp::DeleteCount { paths: inner.clone() }).await, Err(SftpErrorCode::UnsafeDelete));
    assert_eq!(
        op_sudo(&side, SftpOp::Delete { paths: inner.clone(), confirmed: one_dir }).await,
        Err(SftpErrorCode::UnsafeDelete)
    );
    assert!(fake.get("/d/b/c").is_some(), "nothing removed");
    // A sticky folder owned by root is fine only for an entry root owns too.
    fake.modes.lock().insert("/".into(), 0o1777);
    fake.owners.lock().insert("/".into(), 0);
    fake.owners.lock().insert("/d".into(), 1000);
    assert_eq!(op_sudo(&side, SftpOp::DeleteCount { paths: inner.clone() }).await, Err(SftpErrorCode::UnsafeDelete));
    fake.owners.lock().insert("/d".into(), 0);
    assert_eq!(op_sudo(&side, SftpOp::DeleteCount { paths: inner.clone() }).await, Ok(json!({ "files": 1, "dirs": 1 })));
    fake.owners.lock().clear();
    // A single file in a shared folder is one unlink (which never follows a link): allowed.
    let one = DeleteCount { files: 1, dirs: 0 };
    assert_eq!(op_sudo(&side, SftpOp::Delete { paths: vec!["/e".into()], confirmed: one }).await, Ok(Value::Null));
    fake.modes.lock().clear();
    assert_eq!(op_sudo(&side, SftpOp::Delete { paths, confirmed: count }).await, Ok(Value::Null));
    assert!(fake.get("/d").is_none());
}

/// T1/T2/T3: one entry is looked up without reading the rest of its folder, a folder read stops at the total limits even
/// without a cap of its own, and a walk's read refuses a folder past its budget after reading only budget + 1 entries.
#[tokio::test]
async fn folder_reads_stop_at_the_match_and_at_the_total_limits() {
    use crate::client::READDIR_TOTAL_ENTRIES;
    let (fake, side) = connect(Config::default()).await;
    fake.put("/big", Node::Dir);
    for i in 0..1000 {
        fake.put(&format!("/big/f{i:04}"), Node::File(vec![], 1));
    }
    let entry = crate::backend::remote_op(&side, &SftpOp::Stat { path: "/big/f0005".into() }).await.unwrap().unwrap();
    assert_eq!(entry["name"], "f0005");
    assert_eq!(entry["permissions"], "-rw-r--r--");
    assert_eq!(readdirs(&fake), 1, "stopped at the first batch");
    assert_eq!(side.readdir_find("/big", "nope").await.unwrap(), None);
    // A listing with its own cap stops after cap + 1.
    assert_eq!(side.readdir_raw("/big", Some(150)).await.unwrap().len(), 151);
    let before = readdirs(&fake);
    assert_eq!(side.readdir_max("/big", 120).await.map(|v| v.len()), Err(SftpErrorCode::TooMany.into()));
    assert_eq!(readdirs(&fake) - before, 2);
    assert_eq!(side.readdir_max("/big", 1000).await.unwrap().len(), 1000);
    // Past the total limit: tooMany, whatever the caller asked for.
    fake.put("/huge", Node::Dir);
    for i in 0..=READDIR_TOTAL_ENTRIES {
        fake.put(&format!("/huge/{i}"), Node::File(vec![], 1));
    }
    assert_eq!(side.readdir_raw("/huge", None).await.map(|v| v.len()), Err(SftpErrorCode::TooMany.into()));
    assert_eq!(side.readdir("/huge").await.map(|v| v.len()), Err(SftpErrorCode::TooMany.into()));
    assert_eq!(side.readdir_find("/huge", "missing").await, Err(SftpErrorCode::TooMany.into()));
    assert_eq!(side.readdir_raw("/huge", Some(10)).await.unwrap().len(), 11);
}

/// T5: which folder above a selected one lets root trust the name inside it.
#[test]
fn an_ancestor_keeps_the_entry_only_when_nobody_but_root_can_swap_it() {
    use crate::manage::ancestor_keeps_entry;
    use crate::proto::Attrs;
    let at = |mode: Option<u32>, uid: Option<u32>| Attrs { mode, uid, gid: uid, ..Attrs::default() };
    let root_entry = at(Some(0o40755), Some(0));
    let user_entry = at(Some(0o40755), Some(1000));
    // Only the owner writes: fine, whoever owns the entry.
    assert!(ancestor_keeps_entry(&at(Some(0o40755), Some(0)), &user_entry));
    assert!(ancestor_keeps_entry(&at(Some(0o40700), Some(1000)), &user_entry));
    // Group or others write, or nothing is known: refused.
    assert!(!ancestor_keeps_entry(&at(Some(0o40775), Some(0)), &root_entry));
    assert!(!ancestor_keeps_entry(&at(Some(0o40757), Some(0)), &root_entry));
    assert!(!ancestor_keeps_entry(&at(None, Some(0)), &root_entry));
    // Sticky and writable by others: only a root-owned folder with a root-owned entry.
    assert!(ancestor_keeps_entry(&at(Some(0o41777), Some(0)), &root_entry));
    assert!(!ancestor_keeps_entry(&at(Some(0o41777), Some(0)), &user_entry));
    assert!(!ancestor_keeps_entry(&at(Some(0o41777), Some(1000)), &root_entry));
    assert!(!ancestor_keeps_entry(&at(Some(0o41777), None), &root_entry));
    assert!(!ancestor_keeps_entry(&at(Some(0o41777), Some(0)), &at(Some(0o40755), None)));
    // A link (or anything but a folder) on the way: refused.
    assert!(!ancestor_keeps_entry(&at(Some(0o120777), Some(0)), &root_entry));
    assert!(!ancestor_keeps_entry(&at(Some(0o100755), Some(0)), &root_entry));
}
