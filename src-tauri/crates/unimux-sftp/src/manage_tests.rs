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

/// T4: the fix-up after the rename never follows a link: lsetstat when offered, else SETSTAT only on a regular file of the
/// size just written.
#[tokio::test]
async fn the_mode_fix_up_after_the_rename_never_follows_a_link() {
    let (fake, side) = connect(Config::default()).await;
    fake.put("/f", Node::File(b"abc".to_vec(), 1));
    fake.put("/d", Node::Dir);
    assert!(!set_mode_no_follow(&side, "/d", 0o600, 3).await, "not a regular file");
    assert!(!set_mode_no_follow(&side, "/f", 0o600, 4).await, "another file than the one written");
    assert!(!set_mode_no_follow(&side, "/gone", 0o600, 3).await);
    assert!(fake.log.lock().is_empty());
    assert!(set_mode_no_follow(&side, "/f", 0o640, 3).await);
    assert_eq!(fake.log.lock().clone(), vec!["SETSTAT /f".to_string()]);
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

fn file_text(fake: &Fake, path: &str) -> Vec<u8> {
    match fake.get(path) {
        Some(Node::File(data, _)) => data,
        other => panic!("{path}: {other:?}"),
    }
}

/// 1.1.4's sftp-host.int "files in editor tabs": an exclusive, private part file (mode 0600, never written through a file
/// planted under its name), the mode and CRLF kept, the new stamp the base of the next save, a change within the same
/// second told by the content hash, BOM and UTF-16 kept, a folder refused by statFile.
#[tokio::test]
async fn editor_saves_through_an_exclusive_private_part_file_and_keep_the_encoding() {
    let (fake, side) = connect(Config { posix_rename: true, ..Config::default() }).await;
    fake.put("/e.txt", Node::File(b"one\r\ntwo\r\n".to_vec(), 7));
    fake.modes.lock().insert("/e.txt".into(), 0o640);
    let read = read_for_editor(&side, "/e.txt").await.unwrap();
    assert_eq!(
        (read["text"].as_str(), read["encoding"].as_str(), read["size"].as_u64()),
        (Some("one\r\ntwo\r\n"), Some("utf-8"), Some(10))
    );
    let hash = read["stamp"]["hash"].as_str().unwrap();
    assert!(hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()));
    let saved = write_from_editor(
        &side,
        "/e.txt",
        &save("one\nTWO\nthree\n", "one\r\ntwo\r\n", Some(stamp_of(&read["stamp"]))),
        "editor:s",
    )
    .await
    .unwrap();
    assert_eq!(saved["kind"], "saved");
    assert_eq!(file_text(&fake, "/e.txt"), b"one\r\nTWO\r\nthree\r\n");
    assert_eq!(fake.fs.lock().keys().cloned().collect::<Vec<_>>(), ["/", "/e.txt"]);
    assert_eq!(mode_of(&fake, "/e.txt"), Some(0o640));
    assert_eq!(*fake.opens.lock(), [("/e.txt.unimux-part".to_string(), true, Some(0o600))]);
    assert_eq!(saved["stamp"]["size"], 17);
    let again = write_from_editor(
        &side,
        "/e.txt",
        &save("again\n", "one\r\nTWO\r\nthree\r\n", Some(stamp_of(&saved["stamp"]))),
        "editor:s",
    )
    .await
    .unwrap();
    assert_eq!(again["kind"], "saved");
    assert_eq!(file_text(&fake, "/e.txt"), b"again\r\n");

    // Same size and the same second, other content: only the hash tells, and nothing is written.
    let read = read_for_editor(&side, "/e.txt").await.unwrap();
    let mtime = match fake.get("/e.txt") {
        Some(Node::File(_, m)) => m,
        _ => unreachable!(),
    };
    fake.put("/e.txt", Node::File(b"AGAIN\r\n".to_vec(), mtime));
    let r = write_from_editor(&side, "/e.txt", &save("mine", "again\r\n", Some(stamp_of(&read["stamp"]))), "editor:s").await;
    assert_eq!(r, Err(SftpErrorCode::Changed));
    assert_eq!(file_text(&fake, "/e.txt"), b"AGAIN\r\n");

    // A file planted under the part name is removed and the part file created exclusively again.
    fake.opens.lock().clear();
    fake.put("/e.txt.unimux-part", Node::File(b"leftover".to_vec(), 1));
    let read = read_for_editor(&side, "/e.txt").await.unwrap();
    let r =
        write_from_editor(&side, "/e.txt", &save("mine", "AGAIN\r\n", Some(stamp_of(&read["stamp"]))), "editor:s").await.unwrap();
    assert_eq!(r["kind"], "saved");
    let opens = fake.opens.lock().clone();
    assert_eq!(opens.len(), 2);
    assert!(opens.iter().all(|(p, excl, _)| p == "/e.txt.unimux-part" && *excl));
    assert!(fake.get("/e.txt.unimux-part").is_none());

    // The BOM and UTF-16 are kept.
    fake.put("/bom.txt", Node::File("\u{feff}zażółć".as_bytes().to_vec(), 1));
    let bom = read_for_editor(&side, "/bom.txt").await.unwrap();
    assert_eq!((bom["text"].as_str(), bom["encoding"].as_str()), (Some("zażółć"), Some("utf-8-bom")));
    let mut s = save("gęś", "zażółć", Some(stamp_of(&bom["stamp"])));
    s.encoding = "utf-8-bom".into();
    assert_eq!(write_from_editor(&side, "/bom.txt", &s, "editor:s").await.unwrap()["kind"], "saved");
    assert_eq!(file_text(&fake, "/bom.txt"), "\u{feff}gęś".as_bytes());
    fake.put("/w.txt", Node::File(vec![0xff, 0xfe, b'h', 0, b'i', 0], 1));
    let w = read_for_editor(&side, "/w.txt").await.unwrap();
    assert_eq!((w["kind"].as_str(), w["text"].as_str(), w["encoding"].as_str()), (Some("text"), Some("hi"), Some("utf-16le")));
    fake.put("/dir", Node::Dir);
    assert_eq!(stat_for_editor(&side, "/dir").await, Err(SftpErrorCode::Invalid));
}

/// A file of another owner is not replaced without consent (the server will not give it back); with consent the save goes
/// through and reports the owner change.
#[tokio::test]
async fn a_file_of_another_owner_is_not_replaced_without_consent() {
    let (fake, side) = connect(Config { posix_rename: true, owners: true, ..Config::default() }).await;
    fake.put("/e.txt", Node::File(b"base".to_vec(), 7));
    fake.owners.lock().insert("/e.txt".into(), (1001, 1001));
    let read = read_for_editor(&side, "/e.txt").await.unwrap();
    let stamp = stamp_of(&read["stamp"]);
    let r = write_from_editor(&side, "/e.txt", &save("mine", "base", Some(stamp.clone())), "editor:s").await.unwrap();
    assert_eq!(r, json!({ "kind": "ownerChange", "from": { "uid": 1001, "gid": 1001 }, "to": { "uid": 1000, "gid": 1000 } }));
    assert_eq!(file_text(&fake, "/e.txt"), b"base");
    for _ in 0..100 {
        if fake.get("/e.txt.unimux-part").is_none() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert!(fake.get("/e.txt.unimux-part").is_none(), "no part file stays");
    let mut s = save("mine", "base", Some(stamp));
    s.allow_owner_change = true;
    let done = write_from_editor(&side, "/e.txt", &s, "editor:s").await.unwrap();
    assert_eq!(done["kind"], "saved");
    assert_eq!(
        done["warnings"],
        json!([{ "kind": "owner", "from": { "uid": 1001, "gid": 1001 }, "to": { "uid": 1000, "gid": 1000 } }])
    );
    assert_eq!(file_text(&fake, "/e.txt"), b"mine");
}

/// A save whose rename fails (no posix-rename, the new file cannot come in) puts the old file back and leaves no part file.
#[tokio::test]
async fn a_save_whose_rename_fails_leaves_the_old_file_and_no_part_file() {
    let (fake, side) = connect(Config::default()).await;
    fake.put("/e.txt", Node::File(b"old".to_vec(), 7));
    let read = read_for_editor(&side, "/e.txt").await.unwrap();
    fake.cfg.fail_rename_to.lock().push("/e.txt.unimux-part>/e.txt".into());
    let r = write_from_editor(&side, "/e.txt", &save("new", "old", Some(stamp_of(&read["stamp"]))), "editor:s").await;
    // A fixed code (the fake server refuses with permission denied; 1.1.4's test server with a generic failure).
    assert!(matches!(r, Err(SftpErrorCode::Permission | SftpErrorCode::Failed)), "{r:?}");
    assert_eq!(file_text(&fake, "/e.txt"), b"old");
    for _ in 0..100 {
        if fake.fs.lock().len() == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(fake.fs.lock().keys().cloned().collect::<Vec<_>>(), ["/", "/e.txt"]);
}

/// Links on the server: a save through a link writes the file it points to and keeps the link; a delete of a folder with a
/// link back to itself counts the link as one entry and removes the link without following it.
#[tokio::test]
async fn links_are_saved_through_and_deleted_without_being_followed() {
    let (fake, side) = connect(Config { posix_rename: true, ..Config::default() }).await;
    fake.put("/real.txt", Node::File(b"real".to_vec(), 5));
    fake.put("/link.txt", Node::Link("/real.txt".into()));
    let read = read_for_editor(&side, "/link.txt").await.unwrap();
    assert_eq!(read["text"], "real");
    let saved = write_from_editor(&side, "/link.txt", &save("changed", "real", Some(stamp_of(&read["stamp"]))), "editor:s")
        .await
        .unwrap();
    assert_eq!(saved["kind"], "saved");
    assert!(matches!(fake.get("/link.txt"), Some(Node::Link(to)) if to == "/real.txt"), "the link stays");
    assert_eq!(file_text(&fake, "/real.txt"), b"changed");
    assert_eq!(stat_for_editor(&side, "/link.txt").await.unwrap()["size"], 7);

    fake.put("/loop", Node::Dir);
    fake.put("/loop/f.txt", Node::File(b"f".to_vec(), 1));
    fake.put("/loop/again", Node::Link("/loop".into()));
    let count = op(&side, SftpOp::DeleteCount { paths: vec!["/loop".into()] }).await.unwrap();
    assert_eq!(count, json!({ "files": 2, "dirs": 1 }));
    let confirmed = DeleteCount { files: 2, dirs: 1 };
    assert_eq!(op(&side, SftpOp::Delete { paths: vec!["/loop".into()], confirmed }).await, Ok(Value::Null));
    assert!(fake.fs.lock().keys().all(|k| !k.starts_with("/loop")));
}

fn chmod(paths: &[&str], set: Option<(u32, u32)>, recursive: Option<(u32, u32)>, op_id: Option<&str>) -> SftpOp {
    let req = ChmodRequest {
        paths: paths.iter().map(|p| p.to_string()).collect(),
        set,
        recursive,
        op_id: op_id.map(str::to_string),
        total: None,
    };
    SftpOp::Chmod { req }
}

fn setstats(fake: &Fake) -> Vec<String> {
    fake.log.lock().iter().filter_map(|l| l.strip_prefix("SETSTAT ").map(str::to_string)).collect()
}

/// 1.1.4's sftp-manage.int permission changes: digits on one entry, the common bits of a mixed selection, an error per path
/// that is gone, links counted and skipped in a tree, the order of a tree change (contents first when the folder value
/// takes the owner's r+x away), and a cancel while counting or while changing.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn permission_changes_like_1_1_4() {
    let (fake, side) = connect(Config::default()).await;
    fake.put("/a.txt", Node::File(b"a".to_vec(), 1));
    fake.put("/b.txt", Node::File(b"b".to_vec(), 1));
    let one = op(&side, chmod(&["/a.txt"], Some((0o644, 0o7777)), None, None)).await.unwrap();
    assert_eq!(one, json!({ "changed": 1, "errors": [] }));
    op(&side, chmod(&["/b.txt"], Some((0o664, 0o7777)), None, None)).await.unwrap();
    // Owner execute on, the differing group-write left out of the mask.
    let r = op(&side, chmod(&["/a.txt", "/b.txt"], Some((0o744, 0o7777 & !0o020)), None, None)).await.unwrap();
    assert_eq!(r["changed"], 2);
    assert_eq!((mode_of(&fake, "/a.txt"), mode_of(&fake, "/b.txt")), (Some(0o744), Some(0o764)));
    let listed = crate::backend::remote_op(&side, &SftpOp::List { path: "/".into() }).await.unwrap().unwrap();
    let b = listed["entries"].as_array().unwrap().iter().find(|e| e["name"] == "b.txt").unwrap().clone();
    assert_eq!(b["permissions"], "-rwxrw-r--");
    let r = op(&side, chmod(&["/gone", "/a.txt"], Some((0o600, 0o7777)), None, None)).await.unwrap();
    assert_eq!(r, json!({ "changed": 1, "errors": [{ "path": "/gone", "error": "notFound" }] }));

    // A tree: counted first, one value for folders and one for files, the link counted and never followed.
    fake.put("/site", Node::Dir);
    fake.put("/site/img", Node::Dir);
    fake.put("/site/index.html", Node::File(b"x".to_vec(), 1));
    fake.put("/site/img/logo.png", Node::File(b"x".to_vec(), 1));
    fake.put("/outside.txt", Node::File(b"x".to_vec(), 1));
    fake.put("/site/link.txt", Node::Link("/outside.txt".into()));
    let count = op(&side, SftpOp::ChmodCount { paths: vec!["/site".into()], recursive: true }).await.unwrap();
    assert_eq!(count, json!({ "files": 2, "dirs": 2, "links": 1, "noFollow": false }));
    let flat = op(&side, SftpOp::ChmodCount { paths: vec!["/site".into()], recursive: false }).await.unwrap();
    assert_eq!(flat, json!({ "files": 0, "dirs": 1, "links": 0, "noFollow": false }));
    fake.log.lock().clear();
    let r = op(&side, chmod(&["/site"], None, Some((0o750, 0o640)), Some("op-1"))).await.unwrap();
    assert_eq!(r, json!({ "changed": 4, "errors": [] }));
    for (p, m) in [("/site", 0o750), ("/site/img", 0o750), ("/site/index.html", 0o640), ("/site/img/logo.png", 0o640)] {
        assert_eq!(mode_of(&fake, p), Some(m), "{p}");
    }
    assert!(!setstats(&fake).iter().any(|p| p.ends_with("outside.txt") || p.ends_with("link.txt")));
    assert_eq!(mode_of(&fake, "/outside.txt"), None, "the link target outside the folder was never touched");
    // Without the owner's r+x on the folders the contents go first, otherwise the folder first.
    fake.fs.lock().remove("/site/link.txt");
    fake.log.lock().clear();
    op(&side, chmod(&["/site"], None, Some((0o600, 0o600)), None)).await.unwrap();
    assert_eq!(setstats(&fake), ["/site/img/logo.png", "/site/img", "/site/index.html", "/site"]);
    fake.log.lock().clear();
    op(&side, chmod(&["/site"], None, Some((0o755, 0o644)), None)).await.unwrap();
    assert_eq!(setstats(&fake).first().map(String::as_str), Some("/site"));
    assert_eq!(setstats(&fake).len(), 4);

    // A cancel while the tree is still counted changes nothing; one after the first changes stops the rest.
    fake.put("/many", Node::Dir);
    for i in 0..300 {
        fake.put(&format!("/many/d{i}"), Node::Dir);
        fake.put(&format!("/many/d{i}/f.txt"), Node::File(b"x".to_vec(), 1));
    }
    let side = Arc::new(side);
    let ops = Arc::new(RunningOps::default());
    let run = |op_id: &'static str| {
        let (side, ops) = (side.clone(), ops.clone());
        tokio::spawn(async move {
            let o = chmod(&["/many"], None, Some((0o700, 0o600)), Some(op_id));
            manage_op(&side, "sftp:s", false, &o, &ops, &HostChannels::unattached()).await.unwrap()
        })
    };
    fake.log.lock().clear();
    let counting = run("op-count");
    while !ops.cancel("op-count") {
        tokio::task::yield_now().await;
    }
    assert_eq!(counting.await.unwrap(), Ok(json!({ "changed": 0, "errors": [], "cancelled": true })));
    assert!(setstats(&fake).is_empty());
    let changing = run("op-change");
    while setstats(&fake).is_empty() {
        tokio::task::yield_now().await;
    }
    assert!(ops.cancel("op-change"));
    let r = changing.await.unwrap().unwrap();
    assert_eq!(r["cancelled"], true);
    assert!(r["changed"].as_u64().unwrap() < 601);
    assert!(!ops.cancel("op-change"), "a finished operation is no longer running");
}
