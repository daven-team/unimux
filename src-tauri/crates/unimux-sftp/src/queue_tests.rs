//! The transfer queue on the local disk (temporary folders) and against the in-memory SFTP server.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::Value;

use crate::client::SftpClient;
use crate::error::SftpErrorCode;
use crate::fake_server::{Config, Fake, Node};
use crate::limits::TransferDirection;
use crate::local::LocalSide;
use crate::op::{ConflictAnswer, ConflictChoice, TransferRequest};
use crate::queue::{QueueEvents, TransferQueue};
use crate::remote::RemoteSide;
use crate::sides::FileSide;

#[derive(Default)]
struct Rec {
    changed: Mutex<Vec<(Value, bool)>>,
    removed: Mutex<Vec<String>>,
    active: Mutex<Vec<bool>>,
}

impl QueueEvents for Rec {
    fn changed(&self, item: Value, force: bool) {
        self.changed.lock().push((item, force));
    }
    fn removed(&self, ids: Vec<String>) {
        self.removed.lock().extend(ids);
    }
    fn active_changed(&self, active: bool) {
        self.active.lock().push(active);
    }
}

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("unimux-t3-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn queue(max: Option<usize>) -> (Arc<TransferQueue>, Arc<Rec>) {
    let rec = Arc::new(Rec::default());
    let q = TransferQueue::new("local", rec.clone(), max, Arc::new(unimux_core::time::now_ms));
    (q, rec)
}

fn local() -> Arc<dyn FileSide> {
    Arc::new(LocalSide::default())
}

fn req(direction: TransferDirection, sources: &[String], target: &str, policy: Option<ConflictChoice>) -> TransferRequest {
    TransferRequest { direction, sources: sources.to_vec(), target_dir: target.to_string(), policy, batch_id: None }
}

fn state(item: &Value) -> &str {
    item["state"].as_str().unwrap_or_default()
}

async fn until(what: &str, f: impl Fn() -> bool) {
    for _ in 0..1000 {
        if f() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("timed out waiting for {what}");
}

fn all_finished(q: &TransferQueue) -> bool {
    q.items().iter().all(|i| matches!(state(i), "done" | "failed" | "cancelled"))
}

fn by_name<'a>(items: &'a [Value], name: &str) -> &'a Value {
    items.iter().find(|i| i["name"] == name).unwrap_or_else(|| panic!("no item {name}"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn copies_a_folder_tree_through_part_files() {
    let root = scratch("tree");
    let (src, dst) = (root.join("src"), root.join("dst"));
    std::fs::create_dir_all(src.join("sub")).unwrap();
    std::fs::create_dir_all(src.join("empty")).unwrap();
    std::fs::create_dir_all(&dst).unwrap();
    std::fs::write(src.join("a.txt"), b"alpha").unwrap();
    std::fs::write(src.join("sub").join("b.bin"), vec![7u8; 600_000]).unwrap();
    let (q, rec) = queue(None);
    let side = local();
    let batch =
        q.enqueue(req(TransferDirection::LocalCopy, &[s(&src)], &s(&dst), None), Some((side.clone(), side))).await.unwrap();
    until("the copies", || all_finished(&q) && !q.items().is_empty()).await;
    let items = q.items();
    assert_eq!(items.len(), 2);
    for i in &items {
        assert_eq!(state(i), "done", "{i}");
        assert_eq!(i["batchId"], batch.as_str());
        assert_eq!(i["sessionId"], "local");
    }
    assert_eq!(by_name(&items, "src/sub/b.bin")["bytesDone"], 600_000);
    assert_eq!(std::fs::read(dst.join("src").join("a.txt")).unwrap(), b"alpha");
    assert_eq!(std::fs::read(dst.join("src").join("sub").join("b.bin")).unwrap().len(), 600_000);
    until("the empty folder", || dst.join("src").join("empty").is_dir()).await;
    let leftovers: Vec<_> = std::fs::read_dir(dst.join("src"))
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".unimux-part"))
        .collect();
    assert!(leftovers.is_empty());
    until("inactive", || rec.active.lock().last() == Some(&false)).await;
    assert_eq!(rec.active.lock().first(), Some(&true));
    // Keys in 1.1.4's order.
    let keys: Vec<&String> = items[0].as_object().unwrap().keys().collect();
    assert_eq!(
        &keys[..11],
        ["id", "batchId", "sessionId", "direction", "source", "target", "name", "bytesDone", "bytesTotal", "speed", "state"]
    );
    let cleared = q.clear_finished();
    assert_eq!(cleared.len(), 2);
    assert_eq!(rec.removed.lock().len(), 2);
    assert!(q.items().is_empty());
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn conflicts_wait_for_an_answer_and_apply_to_rest_answers_the_batch() {
    let root = scratch("conflict");
    let (src, dst) = (root.join("src"), root.join("dst"));
    std::fs::create_dir_all(&src).unwrap();
    std::fs::create_dir_all(&dst).unwrap();
    for n in ["a.txt", "b.txt"] {
        std::fs::write(src.join(n), b"new").unwrap();
        std::fs::write(dst.join(n), b"old").unwrap();
    }
    std::fs::write(src.join("c.txt"), b"free").unwrap();
    let (q, _rec) = queue(Some(1));
    let side = local();
    let sources = [s(&src.join("a.txt")), s(&src.join("b.txt")), s(&src.join("c.txt"))];
    q.enqueue(req(TransferDirection::LocalCopy, &sources, &s(&dst), None), Some((side.clone(), side))).await.unwrap();
    // With one slot, a conflict frees it: the others go on (c.txt finishes, b.txt meets its own conflict).
    until("two conflicts", || q.items().iter().filter(|i| state(i) == "conflict").count() == 2).await;
    until("c done", || state(by_name(&q.items(), "c.txt")) == "done").await;
    let items = q.items();
    let a = by_name(&items, "a.txt");
    assert_eq!(a["conflict"]["existing"]["size"], 3);
    assert_eq!(a["conflict"]["incoming"]["kind"], "file");
    let id = a["id"].as_str().unwrap().to_string();
    assert!(q.answer_conflict(&id, ConflictAnswer { choice: ConflictChoice::KeepBoth, apply_to_rest: true }));
    assert!(!q.answer_conflict(&id, ConflictAnswer { choice: ConflictChoice::Skip, apply_to_rest: false }));
    until("all done", || all_finished(&q)).await;
    assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"old");
    assert_eq!(std::fs::read(dst.join("a (1).txt")).unwrap(), b"new");
    assert_eq!(std::fs::read(dst.join("b (1).txt")).unwrap(), b"new");
    assert!(by_name(&q.items(), "a.txt")["target"].as_str().unwrap().ends_with("a (1).txt"));
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn policies_skip_and_overwrite_and_cancel_then_retry() {
    let root = scratch("policy");
    let (src, dst) = (root.join("src"), root.join("dst"));
    std::fs::create_dir_all(&src).unwrap();
    std::fs::create_dir_all(&dst).unwrap();
    std::fs::write(src.join("a.txt"), b"new").unwrap();
    std::fs::write(dst.join("a.txt"), b"old").unwrap();
    let (q, _rec) = queue(None);
    let side = local();
    let one = [s(&src.join("a.txt"))];
    q.enqueue(req(TransferDirection::LocalCopy, &one, &s(&dst), Some(ConflictChoice::Skip)), Some((side.clone(), side.clone())))
        .await
        .unwrap();
    until("skipped", || all_finished(&q)).await;
    assert_eq!(q.items()[0]["skipped"], true);
    assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"old");
    q.enqueue(
        req(TransferDirection::LocalCopy, &one, &s(&dst), Some(ConflictChoice::Overwrite)),
        Some((side.clone(), side.clone())),
    )
    .await
    .unwrap();
    until("overwritten", || all_finished(&q)).await;
    assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"new");
    // Cancel while it waits for an answer; a retry asks again.
    std::fs::write(src.join("a.txt"), b"newer").unwrap();
    q.clear_finished();
    q.enqueue(req(TransferDirection::LocalCopy, &one, &s(&dst), None), Some((side.clone(), side))).await.unwrap();
    until("conflict", || q.items().first().is_some_and(|i| state(i) == "conflict")).await;
    let id = q.items()[0]["id"].as_str().unwrap().to_string();
    assert!(q.cancel(Some(std::slice::from_ref(&id)), None));
    until("cancelled", || state(&q.items()[0]) == "cancelled").await;
    assert!(!q.active());
    assert!(q.retry(std::slice::from_ref(&id)));
    until("conflict again", || state(&q.items()[0]) == "conflict").await;
    assert!(q.answer_conflict(&id, ConflictAnswer { choice: ConflictChoice::Overwrite, apply_to_rest: false }));
    until("done", || all_finished(&q)).await;
    assert_eq!(std::fs::read(dst.join("a.txt")).unwrap(), b"newer");
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn copying_a_file_onto_itself_keeps_both_and_a_folder_into_itself_is_refused() {
    let root = scratch("self");
    std::fs::write(root.join("x.txt"), b"x").unwrap();
    let (q, _rec) = queue(None);
    let side = local();
    q.enqueue(req(TransferDirection::LocalCopy, &[s(&root.join("x.txt"))], &s(&root), None), Some((side.clone(), side.clone())))
        .await
        .unwrap();
    until("done", || all_finished(&q)).await;
    assert_eq!(std::fs::read(root.join("x (1).txt")).unwrap(), b"x");
    std::fs::create_dir_all(root.join("f").join("g")).unwrap();
    let r = q
        .enqueue(
            req(TransferDirection::LocalCopy, &[s(&root.join("f"))], &s(&root.join("f").join("g")), None),
            Some((side.clone(), side.clone())),
        )
        .await;
    assert_eq!(r, Err(SftpErrorCode::Invalid));
    let r = q
        .enqueue(
            req(TransferDirection::LocalMove, &[s(&root.join("f"))], &s(&root.join("f").join("g")), None),
            Some((side.clone(), side)),
        )
        .await;
    assert_eq!(r, Err(SftpErrorCode::IntoItself));
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_moves_rename_and_skip_entries_already_there() {
    let root = scratch("move");
    std::fs::create_dir_all(root.join("dir").join("inner")).unwrap();
    std::fs::create_dir_all(root.join("to")).unwrap();
    std::fs::write(root.join("dir").join("inner").join("f"), b"f").unwrap();
    std::fs::write(root.join("to").join("stay"), b"s").unwrap();
    let (q, _rec) = queue(None);
    let side = local();
    let sources = [s(&root.join("dir")), s(&root.join("to").join("stay"))];
    q.enqueue(req(TransferDirection::LocalMove, &sources, &s(&root.join("to")), None), Some((side.clone(), side))).await.unwrap();
    until("moved", || all_finished(&q)).await;
    // "stay" is already in the target folder: no item.
    assert_eq!(q.items().len(), 1);
    assert_eq!(state(&q.items()[0]), "done");
    assert!(!root.join("dir").exists());
    assert_eq!(std::fs::read(root.join("to").join("dir").join("inner").join("f")).unwrap(), b"f");
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn dispose_ends_what_waits_and_refuses_new_batches() {
    let root = scratch("dispose");
    let (src, dst) = (root.join("src"), root.join("dst"));
    std::fs::create_dir_all(&src).unwrap();
    std::fs::create_dir_all(&dst).unwrap();
    std::fs::write(src.join("a"), b"1").unwrap();
    std::fs::write(dst.join("a"), b"2").unwrap();
    let (q, rec) = queue(None);
    let side = local();
    q.enqueue(req(TransferDirection::LocalCopy, &[s(&src.join("a"))], &s(&dst), None), Some((side.clone(), side.clone())))
        .await
        .unwrap();
    until("conflict", || q.items().first().is_some_and(|i| state(i) == "conflict")).await;
    q.dispose(SftpErrorCode::ConnectionLost);
    until("failed", || q.items().first().is_some_and(|i| state(i) == "failed")).await;
    assert_eq!(q.items()[0]["error"], "connectionLost");
    q.when_idle(Duration::from_secs(2)).await;
    assert_eq!(q.running_count(), 0);
    let r = q.enqueue(req(TransferDirection::LocalCopy, &[s(&src.join("a"))], &s(&dst), None), Some((side.clone(), side))).await;
    assert_eq!(r, Err(SftpErrorCode::NoSession));
    assert_eq!(rec.active.lock().last(), Some(&false));
    let _ = std::fs::remove_dir_all(&root);
}

async fn remote(cfg: Config) -> (Arc<Fake>, Arc<dyn FileSide>) {
    let fake = Fake::new(cfg);
    let (a, b) = tokio::io::duplex(1 << 20);
    tokio::spawn(fake.clone().serve(b));
    let client = SftpClient::start(Box::new(a)).await.unwrap();
    (fake, Arc::new(RemoteSide::new(client)))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn uploads_and_downloads_against_the_server_keeping_the_time() {
    let (fake, server) = remote(Config::default()).await;
    let root = scratch("remote");
    let up = root.join("up");
    std::fs::create_dir_all(up.join("deep")).unwrap();
    std::fs::write(up.join("deep").join("one.bin"), vec![3u8; 100_000]).unwrap();
    fake.put("/home", Node::Dir);
    let (q, _rec) = queue(None);
    q.enqueue(req(TransferDirection::Upload, &[s(&up)], "/home", None), Some((local(), server.clone()))).await.unwrap();
    until("uploaded", || all_finished(&q) && !q.items().is_empty()).await;
    assert_eq!(state(&q.items()[0]), "done", "{}", q.items()[0]);
    match fake.get("/home/up/deep/one.bin") {
        Some(Node::File(data, _)) => assert_eq!(data.len(), 100_000),
        other => panic!("not uploaded: {other:?}"),
    }
    assert!(fake.get("/home/up/deep/one.bin.unimux-part").is_none());
    q.clear_finished();
    fake.put("/srv", Node::Dir);
    fake.put("/srv/ok.txt", Node::File(b"ok".to_vec(), 1_700_000_000));
    let down = root.join("down");
    std::fs::create_dir_all(&down).unwrap();
    q.enqueue(req(TransferDirection::Download, &["/srv".to_string()], &s(&down), None), Some((server, local()))).await.unwrap();
    until("downloaded", || all_finished(&q) && !q.items().is_empty()).await;
    let items = q.items();
    assert_eq!(state(by_name(&items, "srv/ok.txt")), "done");
    assert_eq!(std::fs::read(down.join("srv").join("ok.txt")).unwrap(), b"ok");
    let modified = std::fs::metadata(down.join("srv").join("ok.txt")).unwrap().modified().unwrap();
    assert_eq!(modified.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(), 1_700_000_000);
    let _ = std::fs::remove_dir_all(&root);
}
