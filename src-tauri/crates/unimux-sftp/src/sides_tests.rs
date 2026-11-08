//! The client and the remote side against the in-memory server ([`crate::fake_server`]).

use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;

use serde_json::Value;
use unimux_ssh::session::SshErrorCode;

use crate::backend::{attach_stream, remote_op};
use crate::client::SftpClient;
use crate::error::SftpErrorCode;
use crate::fake_server::{Config, Fake, Node};
use crate::host::RemoteSession;
use crate::limits::{LIST_ENTRIES, SFTP_TIMERS};
use crate::op::SftpOp;
use crate::remote::{CHUNK, DEPTH, RemoteSide};
use crate::sides::{EntryKind, FileSide};

async fn connect(cfg: Config) -> (Arc<Fake>, RemoteSide) {
    let fake = Fake::new(cfg);
    let (a, b) = tokio::io::duplex(1 << 20);
    tokio::spawn(fake.clone().serve(b));
    let client = SftpClient::start(Box::new(a)).await.unwrap();
    (fake, RemoteSide::new(client))
}

fn bytes(n: usize) -> Vec<u8> {
    (0..n).map(|i| (i * 7 % 253) as u8).collect()
}

async fn until(f: impl Fn() -> bool) {
    for _ in 0..200 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn reads_with_many_requests_in_flight_and_binary_handles() {
    let (fake, side) = connect(Config::default()).await;
    let data = bytes(1_000_003);
    fake.put("/f", Node::File(data.clone(), 5));
    let mut r = side.open_read("/f").await.unwrap();
    assert_eq!(r.size(), data.len() as u64);
    let mut back = Vec::new();
    while let Some(c) = r.next_chunk().await.unwrap() {
        assert!(c.len() <= CHUNK);
        back.extend(c);
    }
    r.close().await;
    assert_eq!(back, data);
    assert!(fake.max_inflight_reads.load(Ordering::SeqCst) > 1);
    assert!(fake.open_handles.lock().is_empty(), "the handle (not UTF-8) was closed");
}

#[tokio::test]
async fn short_answers_are_read_on_and_a_dropped_reader_closes_its_handle() {
    let (fake, side) = connect(Config { short_reads: Some(1000), ..Config::default() }).await;
    let data = bytes(100_000);
    fake.put("/f", Node::File(data.clone(), 5));
    let mut r = side.open_read("/f").await.unwrap();
    let mut back = Vec::new();
    while let Some(c) = r.next_chunk().await.unwrap() {
        back.extend(c);
    }
    assert_eq!(back, data);
    let r2 = side.open_read("/f").await.unwrap();
    drop(r);
    drop(r2);
    until(|| fake.open_handles.lock().is_empty()).await;
    assert!(fake.open_handles.lock().is_empty());
}

#[tokio::test]
async fn writes_in_chunks_at_increasing_offsets() {
    let (fake, side) = connect(Config::default()).await;
    let data = bytes(DEPTH * CHUNK * 2 + 17);
    let mut w = side.open_write("/out").await.unwrap();
    for part in data.chunks(256 * 1024) {
        w.write(part.to_vec()).await.unwrap();
    }
    w.finish().await.unwrap();
    let Some(Node::File(got, _)) = fake.get("/out") else { panic!("no file") };
    assert_eq!(got, data);
    assert_eq!(fake.writes.load(Ordering::SeqCst), data.len().div_ceil(CHUNK));
    assert!(fake.open_handles.lock().is_empty());
    assert_eq!(side.open_write("/").await.err().unwrap().code, SftpErrorCode::Failed);
}

#[tokio::test]
async fn rename_without_posix_rename_moves_the_old_file_aside_and_back() {
    let (fake, side) = connect(Config::default()).await;
    fake.put("/new", Node::File(b"new".to_vec(), 1));
    fake.put("/t", Node::File(b"old".to_vec(), 1));
    fake.put("/t.unimux-old", Node::File(b"someone's".to_vec(), 1));
    assert_eq!(side.rename("/new", "/t", false).await.unwrap_err().code, SftpErrorCode::Exists);
    side.rename("/new", "/t", true).await.unwrap();
    assert!(matches!(fake.get("/t"), Some(Node::File(d, _)) if d == b"new"));
    assert!(fake.get("/t.unimux-old1").is_none());
    assert!(fake.get("/t.unimux-old").is_some(), "an existing aside name is kept");
    // The new file cannot come in, and the old one cannot go back either (the same target is refused): keep the part.
    fake.put("/new2", Node::File(b"n2".to_vec(), 1));
    fake.cfg.fail_rename_to.lock().push("/t".into());
    let e = side.rename("/new2", "/t", true).await.unwrap_err();
    assert_eq!(e.code, SftpErrorCode::Permission);
    assert!(e.keep_part);
    assert!(fake.get("/t.unimux-old1").is_some(), "the old file is not deleted");
    // Only the new file is refused: the old one goes back.
    fake.cfg.fail_rename_to.lock().clear();
    fake.put("/u", Node::File(b"old".to_vec(), 1));
    fake.put("/locked", Node::File(b"x".to_vec(), 1));
    fake.cfg.fail_rename_to.lock().push("/locked>/u".into());
    let e = side.rename("/locked", "/u", true).await.unwrap_err();
    assert_eq!(e.code, SftpErrorCode::Permission);
    assert!(!e.keep_part);
    assert!(matches!(fake.get("/u"), Some(Node::File(d, _)) if d == b"old"));
    assert!(fake.get("/u.unimux-old").is_none());
    fake.put("/d", Node::Dir);
    assert_eq!(side.rename("/new2", "/d", true).await.unwrap_err().code, SftpErrorCode::IsADirectory);
}

#[tokio::test]
async fn rename_with_posix_rename_replaces_at_once() {
    let (fake, side) = connect(Config { posix_rename: true, ..Config::default() }).await;
    assert!(side.posix_rename());
    assert!(!side.lsetstat());
    fake.put("/a", Node::File(b"a".to_vec(), 1));
    fake.put("/b", Node::File(b"b".to_vec(), 1));
    side.rename("/a", "/b", true).await.unwrap();
    assert!(matches!(fake.get("/b"), Some(Node::File(d, _)) if d == b"a"));
}

#[tokio::test]
async fn manage_calls_map_their_errors() {
    let (fake, side) = connect(Config { lsetstat: true, ..Config::default() }).await;
    fake.put("/d", Node::Dir);
    fake.put("/d/x", Node::File(vec![1], 1));
    assert_eq!(side.mkdir("/d").await.unwrap_err().code, SftpErrorCode::Exists);
    assert_eq!(side.rmdir("/d").await.unwrap_err().code, SftpErrorCode::NotEmpty);
    assert_eq!(side.unlink("/nope").await.unwrap_err().code, SftpErrorCode::NotFound);
    assert_eq!(side.lstat("/nope").await.unwrap(), None);
    assert_eq!(side.realpath("/nope").await.unwrap(), None);
    assert_eq!(side.resolve_path("/d/../d").await.unwrap(), "/d");
    side.set_mtime("/d/x", 1_234_999).await.unwrap();
    assert_eq!(side.lstat("/d/x").await.unwrap().unwrap().mtime, 1_234_000);
    side.chmod_no_follow("/d/x", 0o100600).await.unwrap();
    let entries = side.readdir("/d").await.unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!((entries[0].name.as_str(), entries[0].meta.kind, entries[0].meta.size), ("x", EntryKind::File, 1));
}

#[tokio::test]
async fn view_operations_answer_like_1_1_4() {
    let (fake, side) = connect(Config::default()).await;
    fake.put("/home", Node::Dir);
    fake.put("/home/a.txt", Node::File(b"abc".to_vec(), 3));
    fake.put("/home/sub", Node::Dir);
    let list = remote_op(&side, &SftpOp::List { path: "/home/./".into() }).await.unwrap().unwrap();
    assert_eq!(list["path"], "/home");
    assert_eq!(list["truncated"], false);
    let names: Vec<&str> = list["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["a.txt", "sub"]);
    assert_eq!(list["entries"][0]["owner"], "user");
    assert_eq!(list["entries"][0]["mtime"], 3000);
    let stat = remote_op(&side, &SftpOp::Stat { path: "/home/a.txt".into() }).await.unwrap().unwrap();
    assert_eq!(stat["permissions"], "-rw-r--r--");
    let root = remote_op(&side, &SftpOp::Stat { path: "/".into() }).await.unwrap().unwrap();
    assert_eq!(root.to_string(), r#"{"name":"/","path":"/","kind":"dir","size":0,"mtime":0,"permissions":""}"#);
    assert_eq!(remote_op(&side, &SftpOp::Stat { path: "/x".into() }).await.unwrap(), Err(SftpErrorCode::NotFound));
    assert_eq!(remote_op(&side, &SftpOp::List { path: "rel".into() }).await.unwrap(), Err(SftpErrorCode::Invalid));
    assert_eq!(remote_op(&side, &SftpOp::Mkdir { path: "/home/n".into() }).await.unwrap(), Ok(Value::Null));
    assert_eq!(
        remote_op(&side, &SftpOp::Rename { from: "/home/n".into(), to: "/home/sub".into() }).await.unwrap(),
        Err(SftpErrorCode::Exists)
    );
    assert_eq!(remote_op(&side, &SftpOp::Realpath { path: "/home/sub/..".into() }).await.unwrap(), Ok("/home".into()));
    assert!(remote_op(&side, &SftpOp::ClearFinished).await.is_none());
}

#[tokio::test]
async fn a_listing_stops_at_the_cap() {
    let (fake, side) = connect(Config::default()).await;
    fake.put("/big", Node::Dir);
    for i in 0..LIST_ENTRIES + 150 {
        fake.put(&format!("/big/f{i:06}"), Node::File(Vec::new(), 0));
    }
    let list = remote_op(&side, &SftpOp::List { path: "/big".into() }).await.unwrap().unwrap();
    assert_eq!(list["truncated"], true);
    assert_eq!(list["entries"].as_array().unwrap().len(), LIST_ENTRIES);
    until(|| fake.open_handles.lock().is_empty()).await;
    assert!(fake.open_handles.lock().is_empty());
}

#[tokio::test]
async fn a_killed_or_closed_session_fails_requests_with_connection_lost() {
    let fake = Fake::new(Config::default());
    let (a, b) = tokio::io::duplex(1 << 16);
    let server = tokio::spawn(fake.clone().serve(b));
    let session = attach_stream(Box::new(a), SFTP_TIMERS).await.unwrap();
    let side = session.side().clone();
    let closed = session.closed();
    server.abort();
    let _ = server.await;
    tokio::time::timeout(Duration::from_secs(5), closed).await.unwrap();
    assert_eq!(side.lstat("/").await.unwrap_err().code, SftpErrorCode::ConnectionLost);

    let (_fake, side) = connect(Config::default()).await;
    side.kill();
    assert_eq!(side.stat("/").await.unwrap_err().code, SftpErrorCode::ConnectionLost);
}

#[tokio::test]
async fn a_stream_that_is_not_sftp_is_denied_and_a_silent_one_times_out() {
    let (a, mut b) = tokio::io::duplex(1024);
    tokio::spawn(async move {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let mut buf = [0u8; 9];
        let _ = b.read_exact(&mut buf).await;
        let _ = b.write_all(b"\0\0\0\x05\x65\0\0\0\0").await;
        let _ = b.read(&mut buf).await;
    });
    assert_eq!(attach_stream(Box::new(a), SFTP_TIMERS).await.err(), Some(SshErrorCode::SftpDenied));
    let (a, _b) = tokio::io::duplex(1024);
    let mut timers = SFTP_TIMERS;
    timers.sftp = Duration::from_millis(50);
    assert_eq!(attach_stream(Box::new(a), timers).await.err(), Some(SshErrorCode::Timeout));
}
