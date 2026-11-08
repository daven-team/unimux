//! T4: the manage ops and editor files against the in-memory server ([`crate::fake_server`]).

use std::sync::Arc;

use serde_json::{Value, json};

use crate::backend::manage_op;
use crate::client::SftpClient;
use crate::edit_file::{read_for_editor, stat_for_editor, write_from_editor};
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
