//! The transfer queue against an in-memory side (1.1.4's test/sftp-queue.test.ts `fakeSource` / `memSide`): names a server
//! may send, links, special entries, depth, the cancel of a walk, one writer per target, a 50,000-file batch; and the
//! queue cases of test/sftp-host.int.test.ts that need a running copy (part files, cancel, the cap of three, a failing
//! write, the end of a queue).

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::Value;

use crate::client::SftpClient;
use crate::error::SftpErrorCode;
use crate::fake_server::{Config, Fake};
use crate::limits::{TransferDirection, posix_basename, posix_contains, posix_join, posix_parent};
use crate::local::LocalSide;
use crate::op::{ConflictChoice, TransferRequest};
use crate::queue::{QueueEvents, TransferQueue};
use crate::remote::RemoteSide;
use crate::sides::{DirEntry, EntryKind, FileReader, FileSide, FileWriter, Meta, SideResult};
use crate::targets::TargetRegistry;

#[derive(Debug, Clone)]
enum MemNode {
    File(Vec<u8>),
    Dir,
    Link(String),
    Other,
}

/// A side in memory: posix paths, links resolved by `stat` / `realpath`, every write counted per target key.
struct MemSide {
    nodes: Mutex<BTreeMap<String, MemNode>>,
    ci: bool,
    slow_write: Duration,
    inflight: TargetRegistry,
    open: Mutex<HashMap<String, usize>>,
    max_same_key: AtomicUsize,
    open_total: AtomicUsize,
    max_open: AtomicUsize,
    /// A folder whose listing waits until this is set (the walk of an enqueue that has not answered yet).
    gate: Mutex<Option<(String, tokio::sync::watch::Receiver<bool>)>>,
    /// Listings given by name (a hostile server's names cannot be keys of the tree).
    names: Mutex<HashMap<String, Vec<String>>>,
}

impl MemSide {
    fn new(ci: bool, slow_write: Duration) -> Arc<MemSide> {
        let fold = move |p: &str| if ci { p.to_lowercase() } else { p.to_string() };
        Arc::new(MemSide {
            nodes: Mutex::new(BTreeMap::from([("/".to_string(), MemNode::Dir)])),
            ci,
            slow_write,
            inflight: TargetRegistry::new(fold),
            open: Mutex::new(HashMap::new()),
            max_same_key: AtomicUsize::new(0),
            open_total: AtomicUsize::new(0),
            max_open: AtomicUsize::new(0),
            gate: Mutex::new(None),
            names: Mutex::new(HashMap::new()),
        })
    }
    fn key(&self, p: &str) -> String {
        if self.ci { p.to_lowercase() } else { p.to_string() }
    }
    fn put(&self, path: &str, node: MemNode) {
        let mut nodes = self.nodes.lock();
        let mut parent = posix_parent(path);
        while parent != "/" && !nodes.contains_key(&parent) {
            nodes.insert(parent.clone(), MemNode::Dir);
            parent = posix_parent(&parent);
        }
        nodes.insert(path.to_string(), node);
    }
    fn find(&self, path: &str) -> Option<(String, MemNode)> {
        let nodes = self.nodes.lock();
        if let Some(n) = nodes.get(path) {
            return Some((path.to_string(), n.clone()));
        }
        if !self.ci {
            return None;
        }
        let key = self.key(path);
        nodes.iter().find(|(p, _)| self.key(p) == key).map(|(p, n)| (p.clone(), n.clone()))
    }
    /// The path with its last component's links followed.
    fn resolve(&self, path: &str) -> Option<(String, MemNode)> {
        let mut p = path.to_string();
        for _ in 0..16 {
            match self.find(&p)? {
                (_, MemNode::Link(to)) => p = to,
                found => return Some(found),
            }
        }
        None
    }
    fn files(&self) -> Vec<(String, Vec<u8>)> {
        self.nodes
            .lock()
            .iter()
            .filter_map(|(p, n)| match n {
                MemNode::File(d) => Some((p.clone(), d.clone())),
                _ => None,
            })
            .collect()
    }
}

fn meta_of(n: &MemNode) -> Meta {
    let (kind, size) = match n {
        MemNode::File(d) => (EntryKind::File, d.len() as u64),
        MemNode::Dir => (EntryKind::Dir, 0),
        MemNode::Link(_) => (EntryKind::Symlink, 0),
        MemNode::Other => (EntryKind::Other, 0),
    };
    Meta { kind, size, mtime: 0, mode: None }
}

struct MemReader(Option<Vec<u8>>, u64);

impl FileReader for MemReader {
    fn size(&self) -> u64 {
        self.1
    }
    fn next_chunk(&mut self) -> BoxFuture<'_, SideResult<Option<Vec<u8>>>> {
        let chunk = self.0.take();
        Box::pin(async move { Ok(chunk) })
    }
    fn close(self: Box<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }
}

struct MemWriter {
    side: Arc<MemSide>,
    path: String,
    data: Vec<u8>,
}

impl MemWriter {
    fn done(&self) {
        let key = self.side.key(&self.path);
        let mut open = self.side.open.lock();
        if let Some(n) = open.get_mut(&key) {
            *n -= 1;
        }
        self.side.open_total.fetch_sub(1, Ordering::SeqCst);
    }
}

impl FileWriter for MemWriter {
    fn write(&mut self, data: Vec<u8>) -> BoxFuture<'_, SideResult<()>> {
        Box::pin(async move {
            if !self.side.slow_write.is_zero() {
                tokio::time::sleep(self.side.slow_write).await;
            }
            self.data.extend_from_slice(&data);
            Ok(())
        })
    }
    fn finish(self: Box<Self>) -> BoxFuture<'static, SideResult<()>> {
        Box::pin(async move {
            if !self.side.slow_write.is_zero() {
                tokio::time::sleep(self.side.slow_write).await;
            }
            self.side.put(&self.path, MemNode::File(self.data.clone()));
            self.done();
            Ok(())
        })
    }
    fn abort(self: Box<Self>) -> BoxFuture<'static, ()> {
        Box::pin(async move { self.done() })
    }
}

/// `MemSide` behind an `Arc` (the writers keep a handle on it).
struct Mem(Arc<MemSide>);

impl FileSide for Mem {
    fn remote(&self) -> bool {
        true
    }
    fn case_insensitive(&self) -> bool {
        self.0.ci
    }
    fn inflight(&self) -> &TargetRegistry {
        &self.0.inflight
    }
    fn realpath<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Option<String>>> {
        Box::pin(async move {
            let mut p = path.to_string();
            for _ in 0..16 {
                match self.0.find(&p) {
                    Some((_, MemNode::Link(to))) => p = to,
                    Some((real, _)) => return Ok(Some(real)),
                    None => return Ok(None),
                }
            }
            Ok(None)
        })
    }
    fn join(&self, dir: &str, name: &str) -> String {
        posix_join(&[dir, name])
    }
    fn valid_name(&self, name: &str) -> bool {
        unimux_files::pane::safe_entry_name(name, false)
    }
    fn contains(&self, parent: &str, child: &str) -> bool {
        posix_contains(parent, child)
    }
    fn basename(&self, path: &str) -> String {
        posix_basename(path)
    }
    fn dirname(&self, path: &str) -> String {
        posix_parent(path)
    }
    fn stat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Option<Meta>>> {
        Box::pin(async move { Ok(self.0.resolve(path).map(|(_, n)| meta_of(&n))) })
    }
    fn lstat<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Option<Meta>>> {
        Box::pin(async move { Ok(self.0.find(path).map(|(_, n)| meta_of(&n))) })
    }
    fn readdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Vec<DirEntry>>> {
        Box::pin(async move {
            let gate = self.0.gate.lock().clone();
            if let Some((dir, mut rx)) = gate
                && dir == path
            {
                let _ = rx.wait_for(|open| *open).await;
            }
            let Some((real, MemNode::Dir)) = self.0.resolve(path) else { return Err(SftpErrorCode::NotADirectory.into()) };
            let prefix = if real == "/" { "/".to_string() } else { format!("{real}/") };
            let entries = self.0.names.lock().get(&real).cloned().unwrap_or_else(|| {
                self.0
                    .nodes
                    .lock()
                    .keys()
                    .filter(|k| k.len() > prefix.len() && k.starts_with(&prefix) && !k[prefix.len()..].contains('/'))
                    .map(|k| k[prefix.len()..].to_string())
                    .collect()
            });
            Ok(entries
                .into_iter()
                .map(|name| {
                    let meta = self.0.find(&format!("{prefix}{name}")).map(|(_, n)| meta_of(&n)).unwrap_or(Meta {
                        kind: EntryKind::File,
                        size: 0,
                        mtime: 0,
                        mode: None,
                    });
                    DirEntry { name, longname: None, meta }
                })
                .collect())
        })
    }
    fn mkdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<()>> {
        Box::pin(async move {
            if self.0.find(path).is_some() {
                return Err(SftpErrorCode::Exists.into());
            }
            self.0.put(path, MemNode::Dir);
            Ok(())
        })
    }
    fn unlink<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<()>> {
        Box::pin(async move {
            let Some((real, _)) = self.0.find(path) else { return Err(SftpErrorCode::NotFound.into()) };
            self.0.nodes.lock().remove(&real);
            Ok(())
        })
    }
    fn rmdir<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<()>> {
        self.unlink(path)
    }
    fn rename<'a>(&'a self, from: &'a str, to: &'a str, overwrite: bool) -> BoxFuture<'a, SideResult<()>> {
        Box::pin(async move {
            let Some((real, node)) = self.0.find(from) else { return Err(SftpErrorCode::NotFound.into()) };
            if let Some((existing, _)) = self.0.find(to) {
                if !overwrite && existing != real {
                    return Err(SftpErrorCode::Exists.into());
                }
                self.0.nodes.lock().remove(&existing);
            }
            self.0.nodes.lock().remove(&real);
            self.0.put(to, node);
            Ok(())
        })
    }
    fn set_mtime<'a>(&'a self, _path: &'a str, _mtime: i64) -> BoxFuture<'a, SideResult<()>> {
        Box::pin(async { Ok(()) })
    }
    fn open_read<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Box<dyn FileReader>>> {
        Box::pin(async move {
            match self.0.resolve(path) {
                Some((_, MemNode::File(d))) => {
                    let n = d.len() as u64;
                    Ok(Box::new(MemReader(Some(d), n)) as Box<dyn FileReader>)
                }
                Some(_) => Err(SftpErrorCode::IsADirectory.into()),
                None => Err(SftpErrorCode::NotFound.into()),
            }
        })
    }
    fn open_write<'a>(&'a self, path: &'a str) -> BoxFuture<'a, SideResult<Box<dyn FileWriter>>> {
        Box::pin(async move {
            // The final name of a part file: what one target key may have open at once.
            let target = path.strip_suffix(".unimux-part").unwrap_or(path);
            let key = self.0.key(target);
            {
                let mut open = self.0.open.lock();
                let n = open.entry(key).or_insert(0);
                *n += 1;
                self.0.max_same_key.fetch_max(*n, Ordering::SeqCst);
            }
            let total = self.0.open_total.fetch_add(1, Ordering::SeqCst) + 1;
            self.0.max_open.fetch_max(total, Ordering::SeqCst);
            self.0.put(path, MemNode::File(Vec::new()));
            Ok(Box::new(MemWriter { side: self.0.clone(), path: path.to_string(), data: Vec::new() }) as Box<dyn FileWriter>)
        })
    }
}

impl MemSide {
    /// Listings in a fixed order with names a hostile server may send (they are never joined onto a path).
    fn listing(&self, dir: &str, names: &[&str]) {
        self.put(dir, MemNode::Dir);
        self.names.lock().insert(dir.to_string(), names.iter().map(|s| s.to_string()).collect());
    }

    fn source() -> Arc<MemSide> {
        MemSide::new(false, Duration::ZERO)
    }
}

#[derive(Default)]
struct Quiet {
    active: Mutex<Vec<bool>>,
}

impl QueueEvents for Quiet {
    fn changed(&self, _item: Value, _force: bool) {}
    fn removed(&self, _ids: Vec<String>) {}
    fn active_changed(&self, active: bool) {
        self.active.lock().push(active);
    }
}

fn queue(max: Option<usize>) -> (Arc<TransferQueue>, Arc<Quiet>) {
    let rec = Arc::new(Quiet::default());
    (TransferQueue::new("sftp:x", rec.clone(), max, Arc::new(unimux_core::time::now_ms)), rec)
}

fn req(direction: TransferDirection, sources: &[&str], target: &str, policy: Option<ConflictChoice>) -> TransferRequest {
    TransferRequest {
        direction,
        sources: sources.iter().map(|s| s.to_string()).collect(),
        target_dir: target.to_string(),
        policy,
        batch_id: None,
    }
}

fn sides(src: &Arc<MemSide>, dst: Arc<dyn FileSide>) -> Option<(Arc<dyn FileSide>, Arc<dyn FileSide>)> {
    Some((Arc::new(Mem(src.clone())) as Arc<dyn FileSide>, dst))
}

fn state(i: &Value) -> &str {
    i["state"].as_str().unwrap_or_default()
}

async fn settle(q: &TransferQueue, batch: &str) -> Vec<Value> {
    for _ in 0..24_000 {
        let items: Vec<Value> = q.items().into_iter().filter(|i| i["batchId"] == batch).collect();
        if items.iter().all(|i| matches!(state(i), "done" | "failed" | "cancelled")) {
            return items;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    panic!("batch {batch} did not settle");
}

fn by_name(items: &[Value]) -> HashMap<String, Value> {
    items.iter().map(|i| (i["name"].as_str().unwrap().to_string(), i.clone())).collect()
}

fn scratch(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("unimux-t3m-{tag}-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn names_from_the_source_side_are_never_joined_onto_a_path() {
    let src = MemSide::source();
    src.listing("/srv", &["../evil", "a/b", "a\\b", "c:d", "NUL", "..", "ok.txt", "sub"]);
    src.put("/srv/ok.txt", MemNode::File(b"fine".to_vec()));
    src.listing("/srv/sub", &["../../evil2", "deep.txt"]);
    src.put("/srv/sub/deep.txt", MemNode::File(b"deep".to_vec()));
    let root = scratch("names");
    let target = root.join("target");
    std::fs::create_dir_all(&target).unwrap();
    // The local side with Windows name rules on every platform (":" and device names).
    let dst: Arc<dyn FileSide> = Arc::new(LocalSide::new(true, true));
    let (q, _) = queue(None);
    let batch = q.enqueue(req(TransferDirection::Download, &["/srv"], &s(&target), None), sides(&src, dst.clone())).await.unwrap();
    let items = by_name(&settle(&q, &batch).await);
    for bad in ["srv/../evil", "srv/a/b", "srv/a\\b", "srv/c:d", "srv/NUL", "srv/..", "srv/sub/../../evil2"] {
        let i = items.get(bad).unwrap_or_else(|| panic!("{bad}: {items:?}"));
        assert_eq!((state(i), i["error"].as_str()), ("failed", Some("invalidName")), "{bad}");
    }
    assert_eq!(state(&items["srv/ok.txt"]), "done");
    assert_eq!(state(&items["srv/sub/deep.txt"]), "done");
    assert_eq!(std::fs::read(target.join("srv").join("ok.txt")).unwrap(), b"fine");
    let top: Vec<String> = std::fs::read_dir(&root).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(top, ["target"]);
    let mut inner: Vec<String> =
        std::fs::read_dir(target.join("srv")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
    inner.sort();
    assert_eq!(inner, ["ok.txt", "sub"]);
    // A retry cannot make such a name safe.
    assert!(!q.retry(&[items["srv/../evil"]["id"].as_str().unwrap().to_string()]));

    // A hostile top-level name is refused too.
    let t = root.join("t");
    std::fs::create_dir_all(&t).unwrap();
    src.put("/x/CON", MemNode::File(b"x".to_vec()));
    let batch = q.enqueue(req(TransferDirection::Download, &["/x/CON"], &s(&t), None), sides(&src, dst)).await.unwrap();
    let items = settle(&q, &batch).await;
    assert_eq!((state(&items[0]), items[0]["error"].as_str()), ("failed", Some("invalidName")));
    assert_eq!(std::fs::read_dir(&t).unwrap().count(), 0);
    let _ = std::fs::remove_dir_all(&root);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn links_special_entries_depth_and_the_cancel_of_a_walk() {
    let src = MemSide::source();
    src.listing("/srv", &["in.txt", "out", "linkdir", "fifo", "real.txt"]);
    src.put("/srv/real.txt", MemNode::File(b"real".to_vec()));
    src.put("/srv/in.txt", MemNode::Link("/srv/real.txt".into()));
    src.put("/srv/out", MemNode::Link("/home/alice/.ssh/id_ed25519".into()));
    src.put("/home/alice/.ssh/id_ed25519", MemNode::File(b"SECRET".to_vec()));
    src.put("/srv/linkdir", MemNode::Link("/srv".into()));
    src.put("/srv/fifo", MemNode::Other);
    let dst = MemSide::new(false, Duration::ZERO);
    dst.put("/t", MemNode::Dir);
    let (q, _) = queue(None);
    let to = || Arc::new(Mem(dst.clone())) as Arc<dyn FileSide>;
    let batch = q.enqueue(req(TransferDirection::Download, &["/srv"], "/t", None), sides(&src, to())).await.unwrap();
    let items = by_name(&settle(&q, &batch).await);
    assert_eq!(state(&items["srv/in.txt"]), "done");
    for (name, code) in [("srv/out", "linkOutside"), ("srv/linkdir", "linkFolder"), ("srv/fifo", "unsupported")] {
        assert_eq!((state(&items[name]), items[name]["error"].as_str()), ("failed", Some(code)), "{name}");
    }
    assert!(dst.files().iter().all(|(_, d)| d != b"SECRET"));
    assert!(dst.files().iter().any(|(p, d)| p == "/t/srv/in.txt" && d == b"real"));
    // A link the user picked as the source itself is followed.
    let batch = q.enqueue(req(TransferDirection::Download, &["/srv/out"], "/t", None), sides(&src, to())).await.unwrap();
    assert_eq!(state(&settle(&q, &batch).await[0]), "done");

    // A level deeper than 64 is a failed item, not silently left out.
    let deep = MemSide::source();
    let mut p = "/d".to_string();
    for _ in 0..70 {
        p = format!("{p}/x");
    }
    deep.put(&p, MemNode::File(b"leaf".to_vec()));
    let batch = q.enqueue(req(TransferDirection::Download, &["/d"], "/t", None), sides(&deep, to())).await.unwrap();
    let items = settle(&q, &batch).await;
    let states: Vec<(&str, Option<&str>)> = items.iter().map(|i| (state(i), i["error"].as_str())).collect();
    assert_eq!(states, [("failed", Some("tooMany"))]);

    // cancel(batchId) stops the walk of an enqueue that has not answered yet.
    let slow = MemSide::source();
    slow.put("/big/a", MemNode::File(b"A".to_vec()));
    let (open, rx) = tokio::sync::watch::channel(false);
    *slow.gate.lock() = Some(("/big".into(), rx));
    let batch_id = "00000000-0000-4000-8000-0000000000b1".to_string();
    let mut r = req(TransferDirection::Download, &["/big"], "/t", None);
    r.batch_id = Some(batch_id.clone());
    let (q2, _) = queue(None);
    let pending = {
        let (q2, sides) = (q2.clone(), sides(&slow, to()));
        tokio::spawn(async move { q2.enqueue(r, sides).await })
    };
    tokio::time::sleep(Duration::from_millis(30)).await;
    assert!(q2.cancel(None, Some(&batch_id)));
    let _ = open.send(true);
    assert_eq!(pending.await.unwrap(), Err(SftpErrorCode::Cancelled));
    assert!(q2.items().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_writer_per_target_also_across_case_and_a_50000_file_batch() {
    let src = MemSide::source();
    src.put("/s/f.bin", MemNode::File(vec![b'x'; 2000]));
    let dst = MemSide::new(false, Duration::from_millis(2));
    dst.put("/t", MemNode::Dir);
    let (q, _) = queue(None);
    let to = |d: &Arc<MemSide>| Arc::new(Mem(d.clone())) as Arc<dyn FileSide>;
    let a = q.enqueue(req(TransferDirection::Download, &["/s/f.bin"], "/t", None), sides(&src, to(&dst))).await.unwrap();
    let b = q
        .enqueue(req(TransferDirection::Download, &["/s/f.bin"], "/t", Some(ConflictChoice::KeepBoth)), sides(&src, to(&dst)))
        .await
        .unwrap();
    settle(&q, &a).await;
    settle(&q, &b).await;
    assert_eq!(dst.max_same_key.load(Ordering::SeqCst), 1);
    let names: Vec<String> = dst.files().into_iter().map(|(p, d)| {
        assert_eq!(d.len(), 2000);
        p
    }).collect();
    assert_eq!(names, ["/t/f (1).bin", "/t/f.bin"]);

    // "A.txt" and "a.txt" to a case-insensitive side are one target: serialized, then keep both.
    let src = MemSide::source();
    src.put("/s/A.txt", MemNode::File(b"upper".to_vec()));
    src.put("/s/a.txt", MemNode::File(b"lower".to_vec()));
    let ci = MemSide::new(true, Duration::from_millis(2));
    ci.put("/t", MemNode::Dir);
    let batch = q
        .enqueue(
            req(TransferDirection::Download, &["/s/A.txt", "/s/a.txt"], "/t", Some(ConflictChoice::KeepBoth)),
            sides(&src, to(&ci)),
        )
        .await
        .unwrap();
    let items = settle(&q, &batch).await;
    assert!(items.iter().all(|i| state(i) == "done"));
    assert_eq!(ci.max_same_key.load(Ordering::SeqCst), 1);
    let mut got: Vec<(String, String)> =
        ci.files().into_iter().map(|(p, d)| (posix_basename(&p), String::from_utf8(d).unwrap())).collect();
    got.sort();
    assert_eq!(got, [("A.txt".to_string(), "upper".to_string()), ("a (1).txt".to_string(), "lower".to_string())]);

    // 50,000 files: every one done, at most three open at once, active reported twice.
    let many = MemSide::source();
    for i in 0..50_000 {
        many.nodes.lock().insert(format!("/many/f{i}"), MemNode::File(b"x".to_vec()));
    }
    many.put("/many", MemNode::Dir);
    let out = MemSide::new(false, Duration::ZERO);
    out.put("/t", MemNode::Dir);
    let (q, rec) = queue(None);
    let started = std::time::Instant::now();
    let batch = q.enqueue(req(TransferDirection::Download, &["/many"], "/t", None), sides(&many, to(&out))).await.unwrap();
    for _ in 0..24_000 {
        if !q.active() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(!q.active());
    assert_eq!(q.items().iter().filter(|i| i["batchId"] == batch.as_str() && state(i) == "done").count(), 50_000);
    assert!(out.max_open.load(Ordering::SeqCst) <= 3);
    assert_eq!(rec.active.lock().len(), 2);
    assert!(started.elapsed() < Duration::from_secs(90));
}

async fn remote(cfg: Config) -> (Arc<Fake>, Arc<dyn FileSide>) {
    let fake = Fake::new(cfg);
    let (a, b) = tokio::io::duplex(1 << 20);
    tokio::spawn(fake.clone().serve(b));
    let client = SftpClient::start(Box::new(a)).await.unwrap();
    (fake, Arc::new(RemoteSide::new(client)))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn running_copies_use_part_files_three_at_a_time_and_clean_up_when_cancelled_failed_or_ended() {
    let root = scratch("run");
    let (src, dst) = (root.join("src"), root.join("dst"));
    std::fs::create_dir_all(&src).unwrap();
    std::fs::create_dir_all(&dst).unwrap();
    let local = || Arc::new(LocalSide::default()) as Arc<dyn FileSide>;
    // At most three files at the same time.
    let names: Vec<String> = (0..8).map(|i| format!("n{i}.bin")).collect();
    for n in &names {
        std::fs::write(src.join(n), vec![2u8; 8_000_000]).unwrap();
    }
    let (q, _) = queue(None);
    let sources: Vec<String> = names.iter().map(|n| s(&src.join(n))).collect();
    let refs: Vec<&str> = sources.iter().map(String::as_str).collect();
    let batch = q.enqueue(req(TransferDirection::LocalCopy, &refs, &s(&dst), None), Some((local(), local()))).await.unwrap();
    let mut max = 0;
    while q.active() {
        max = max.max(q.running_count());
        tokio::task::yield_now().await;
    }
    assert!(settle(&q, &batch).await.iter().all(|i| state(i) == "done"));
    assert!((1..=3).contains(&max), "{max}");

    // Cancel stops a running copy: neither the part file nor the final name stays; a retry runs it to the end.
    std::fs::write(src.join("huge.bin"), vec![1u8; 200_000_000]).unwrap();
    let out = root.join("out");
    std::fs::create_dir_all(&out).unwrap();
    let batch = q
        .enqueue(req(TransferDirection::LocalCopy, &[&s(&src.join("huge.bin"))], &s(&out), None), Some((local(), local())))
        .await
        .unwrap();
    let part = out.join("huge.bin.unimux-part");
    for _ in 0..2000 {
        if part.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    assert!(!out.join("huge.bin").exists(), "the final name appears only complete");
    let id = q.items().into_iter().find(|i| i["batchId"] == batch.as_str()).unwrap()["id"].as_str().unwrap().to_string();
    assert!(q.cancel(Some(std::slice::from_ref(&id)), None));
    let items = settle(&q, &batch).await;
    assert_eq!(state(&items[0]), "cancelled");
    for _ in 0..400 {
        if !part.exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(!part.exists() && !out.join("huge.bin").exists());
    assert!(q.retry(std::slice::from_ref(&id)));
    for _ in 0..6000 {
        if q.items().iter().any(|i| i["id"] == id.as_str() && state(i) == "done") {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert_eq!(std::fs::metadata(out.join("huge.bin")).unwrap().len(), 200_000_000);

    // The end of the queue (an app shutdown, a Disconnect) cancels what runs and waits for the part files to go.
    let many = root.join("many");
    std::fs::create_dir_all(&many).unwrap();
    for n in 0..20 {
        std::fs::write(many.join(format!("f{n}.bin")), vec![n as u8; 4_000_000]).unwrap();
    }
    let end = root.join("end");
    std::fs::create_dir_all(&end).unwrap();
    let (q, _) = queue(None);
    let batch = q.enqueue(req(TransferDirection::LocalCopy, &[&s(&many)], &s(&end), None), Some((local(), local()))).await.unwrap();
    let parts = || -> usize {
        std::fs::read_dir(end.join("many"))
            .map(|d| d.flatten().filter(|e| e.file_name().to_string_lossy().ends_with(".unimux-part")).count())
            .unwrap_or(0)
    };
    for _ in 0..2000 {
        if parts() > 0 || !q.active() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
    }
    q.dispose(SftpErrorCode::Cancelled);
    q.when_idle(Duration::from_secs(4)).await;
    assert_eq!(parts(), 0);
    let items = settle(&q, &batch).await;
    assert!(items.iter().all(|i| matches!(state(i), "done" | "cancelled")), "a Disconnect cancels, it does not fail");

    // A failing write fails the item with a code and removes the part file.
    let (fake, server) = remote(Config { fail_writes_after: Some(100_000), ..Config::default() }).await;
    fake.put("/home", crate::fake_server::Node::Dir);
    std::fs::write(src.join("full.bin"), vec![3u8; 500_000]).unwrap();
    let (q, _) = queue(None);
    let batch = q.enqueue(req(TransferDirection::Upload, &[&s(&src.join("full.bin"))], "/home", None), Some((local(), server))).await.unwrap();
    let items = settle(&q, &batch).await;
    assert_eq!((state(&items[0]), items[0]["error"].as_str()), ("failed", Some("failed")));
    for _ in 0..400 {
        if fake.get("/home/full.bin.unimux-part").is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(fake.get("/home/full.bin.unimux-part").is_none());
    assert!(fake.get("/home/full.bin").is_none());
    let _ = std::fs::remove_dir_all(&root);
}

/// Links on the local disk: a file link out of the picked folder is not sent, a folder link (a junction loop) is a failed
/// item and never followed. Skipped where the OS will not create the link (symlinks need developer mode on Windows).
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn local_links_out_of_the_folder_and_link_loops_are_failed_items() {
    let root = scratch("links");
    let pick = root.join("pick");
    std::fs::create_dir_all(&pick).unwrap();
    std::fs::write(root.join("secret.txt"), b"SECRET").unwrap();
    std::fs::write(pick.join("ok.txt"), b"ok").unwrap();
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_file(root.join("secret.txt"), pick.join("link.txt")).is_ok();
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(root.join("secret.txt"), pick.join("link.txt")).is_ok();
    let local = || Arc::new(LocalSide::default()) as Arc<dyn FileSide>;
    let (q, _) = queue(None);
    if linked {
        let dst = root.join("dst");
        std::fs::create_dir_all(&dst).unwrap();
        let batch = q.enqueue(req(TransferDirection::LocalCopy, &[&s(&pick)], &s(&dst), None), Some((local(), local()))).await.unwrap();
        let items = by_name(&settle(&q, &batch).await);
        assert_eq!((state(&items["pick/link.txt"]), items["pick/link.txt"]["error"].as_str()), ("failed", Some("linkOutside")));
        let names: Vec<String> =
            std::fs::read_dir(dst.join("pick")).unwrap().flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names, ["ok.txt"]);
    }
    // A folder link back to its own folder.
    let lp = root.join("loop");
    std::fs::create_dir_all(&lp).unwrap();
    std::fs::write(lp.join("f.txt"), b"f").unwrap();
    #[cfg(windows)]
    let looped = {
        use std::os::windows::process::CommandExt;
        std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(lp.join("again"))
            .arg(&lp)
            .creation_flags(0x0800_0000)
            .output()
            .is_ok_and(|o| o.status.success())
    };
    #[cfg(unix)]
    let looped = std::os::unix::fs::symlink(&lp, lp.join("again")).is_ok();
    if looped {
        let dl = root.join("dl");
        std::fs::create_dir_all(&dl).unwrap();
        let batch = q.enqueue(req(TransferDirection::LocalCopy, &[&s(&lp)], &s(&dl), None), Some((local(), local()))).await.unwrap();
        let items = by_name(&settle(&q, &batch).await);
        assert_eq!(state(&items["loop/f.txt"]), "done");
        assert_eq!((state(&items["loop/again"]), items["loop/again"]["error"].as_str()), ("failed", Some("linkFolder")));
        #[cfg(windows)]
        let _ = std::fs::remove_dir(lp.join("again"));
    }
    let _ = std::fs::remove_dir_all(&root);
}
