//! The transfer queue of one session (or of the local copies), port of 1.1.4 src/sftphost/queue.ts: folders expand into
//! one item per file, at most `SFTP_LIMITS.concurrentFiles` move at once, every file is written as "<name>.unimux-part"
//! and renamed into place, an existing target pauses the item in state "conflict" until the renderer answers. Two jobs
//! never write one target at once (the side's [`crate::targets::TargetRegistry`]). Bookkeeping is O(1) per item (a counter
//! of unfinished items and a FIFO of queued ones), so a 50,000-file batch does not stall the host. The two
//! [`FileSide`]s are injected per enqueue.
//!
//! Concurrency: 1.1.4 ran on one JS thread; here every bookkeeping step runs under one lock ([`TransferQueue::with`]),
//! the events it produced go out in order after the lock is released (an emit lock keeps two steps' events from
//! interleaving), and the jobs it starts are spawned afterwards. A job's final update, the end of its abort handle and the
//! release of its targets happen in one step, like the synchronous `catch` / `finally` of the TS code.

use std::collections::{HashMap, HashSet, VecDeque};
use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use indexmap::IndexMap;
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

use crate::error::SftpErrorCode;
use crate::limits::{BATCH_FILES, CONCURRENT_FILES, TransferDirection};
use crate::op::{ConflictAnswer, ConflictChoice, TransferRequest};
use crate::sides::{EntryKind, FileReader, FileSide, FileWriter, Meta, SideError, SideResult};
use crate::throttle::Now;

/// `PART_SUFFIX`.
pub const PART_SUFFIX: &str = ".unimux-part";
/// Folders deeper than this inside a transferred folder become failed items (1.1.4: `depth > 64`).
const MAX_DEPTH: usize = 64;
/// Speed samples older than this (ms) are dropped (at least two stay).
const SPEED_WINDOW_MS: i64 = 3000;

/// `partName`: the temporary name a file is written under until it is complete.
pub fn part_name(name: &str) -> String {
    format!("{name}{PART_SUFFIX}")
}

/// `isPartName`.
pub fn is_part_name(name: &str) -> bool {
    name.len() > PART_SUFFIX.len() && name.ends_with(PART_SUFFIX)
}

/// The stem without a trailing " (n)" (`/ \(\d+\)$/`, ASCII digits).
fn strip_counter(stem: &str) -> &str {
    let Some(body) = stem.strip_suffix(')') else { return stem };
    let Some(open) = body.rfind(" (") else { return stem };
    let digits = &body[open + 2..];
    if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) { &stem[..open] } else { stem }
}

/// `keepBothName`: "report.pdf" -> "report (1).pdf", then "(2)" ... skipping every name in `existing` (and its part
/// file). A trailing " (n)" is replaced, not stacked. Folders and dotfiles without another dot keep their whole name as the
/// stem; "a.tar.gz" keeps ".gz" as the extension.
pub fn keep_both_name<S: AsRef<str>>(name: &str, existing: &[S], directory: bool, case_insensitive: bool) -> String {
    let fold = |s: &str| if case_insensitive { s.to_lowercase() } else { s.to_string() };
    let taken: HashSet<String> = existing.iter().map(|s| fold(s.as_ref())).collect();
    let dot = if directory { None } else { name.rfind('.').filter(|d| *d > 0) };
    let (stem, ext) = match dot {
        Some(d) => (&name[..d], &name[d..]),
        None => (name, ""),
    };
    let stem = strip_counter(stem);
    let mut n: u64 = 1;
    loop {
        let candidate = format!("{stem} ({n}){ext}");
        if !taken.contains(&fold(&candidate)) && !taken.contains(&fold(&part_name(&candidate))) {
            return candidate;
        }
        n += 1;
    }
}

/// `TransferState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TransferState {
    Queued,
    Running,
    Done,
    Failed,
    Cancelled,
    Conflict,
}

impl TransferState {
    pub fn as_str(self) -> &'static str {
        match self {
            TransferState::Queued => "queued",
            TransferState::Running => "running",
            TransferState::Done => "done",
            TransferState::Failed => "failed",
            TransferState::Cancelled => "cancelled",
            TransferState::Conflict => "conflict",
        }
    }

    pub fn parse(s: &str) -> Option<TransferState> {
        Some(match s {
            "queued" => TransferState::Queued,
            "running" => TransferState::Running,
            "done" => TransferState::Done,
            "failed" => TransferState::Failed,
            "cancelled" => TransferState::Cancelled,
            "conflict" => TransferState::Conflict,
            _ => return None,
        })
    }

    /// `isFinished`.
    pub fn is_finished(self) -> bool {
        matches!(self, TransferState::Done | TransferState::Failed | TransferState::Cancelled)
    }
}

/// What a queue reports (the host's throttle, the removed message, the service's idle bookkeeping).
pub trait QueueEvents: Send + Sync {
    /// An item changed (the full object); `force`: a state change (sent at once), otherwise progress (throttled).
    fn changed(&self, item: Value, force: bool);
    fn removed(&self, ids: Vec<String>);
    /// True while anything is queued, running or waiting for a conflict answer.
    fn active_changed(&self, active: bool);
}

/// A `TransferItem` with the key order of the JS object (`{...item, ...patch}`: a known key keeps its place, a new one
/// goes last, `undefined` keeps the place but is not serialized).
#[derive(Debug, Clone, Default)]
struct Item(IndexMap<&'static str, Option<Value>>);

type Patch = Vec<(&'static str, Option<Value>)>;

fn v(x: impl Into<Value>) -> Option<Value> {
    Some(x.into())
}

impl Item {
    fn apply(&mut self, patch: Patch) {
        for (k, val) in patch {
            self.0.insert(k, val);
        }
    }
    fn get(&self, k: &str) -> Option<&Value> {
        self.0.get(k).and_then(Option::as_ref)
    }
    fn str(&self, k: &str) -> String {
        self.get(k).and_then(Value::as_str).unwrap_or_default().to_string()
    }
    fn u64(&self, k: &str) -> u64 {
        self.get(k).and_then(Value::as_u64).unwrap_or(0)
    }
    fn state(&self) -> TransferState {
        self.get("state").and_then(Value::as_str).and_then(TransferState::parse).unwrap_or(TransferState::Queued)
    }
    fn error(&self) -> Option<SftpErrorCode> {
        self.get("error").and_then(Value::as_str).and_then(SftpErrorCode::parse)
    }
    fn to_json(&self) -> Value {
        let mut m = Map::new();
        for (k, val) in &self.0 {
            if let Some(val) = val {
                m.insert((*k).to_string(), val.clone());
            }
        }
        Value::Object(m)
    }
}

type DirCheck = Shared<BoxFuture<'static, SideResult<()>>>;

struct Batch {
    id: String,
    direction: TransferDirection,
    src: Arc<dyn FileSide>,
    dst: Arc<dyn FileSide>,
    policy: Mutex<Option<ConflictChoice>>,
    /// The chosen target folder: no target path may leave it.
    root: String,
    /// Folders already made sure of (path -> pending check).
    dirs: Mutex<HashMap<String, DirCheck>>,
    cancelled: AtomicBool,
}

impl Batch {
    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    /// `src === dst`.
    fn one_side(&self) -> bool {
        std::ptr::addr_eq(Arc::as_ptr(&self.src), Arc::as_ptr(&self.dst))
    }
}

struct Job {
    item: Item,
    batch: Arc<Batch>,
    /// The target before a keep-both rename (a retry starts from it again).
    planned_target: String,
    abort: Option<CancellationToken>,
    answer: Option<oneshot::Sender<ConflictAnswer>>,
    /// Speed samples: (time, bytesDone).
    samples: VecDeque<(i64, u64)>,
    /// Answered a conflict and waits for a free slot (shown as queued, but pump() must not start it again).
    resuming: bool,
    /// Waits in the side's registry for another job's target (pump() must not pick it twice).
    blocked: bool,
}

#[derive(Default)]
struct State {
    jobs: IndexMap<String, Job>,
    /// Queued job ids in order.
    fifo: VecDeque<String>,
    /// Jobs whose target became free again: they go before the FIFO.
    ready: VecDeque<String>,
    unfinished: usize,
    running: usize,
    slot_waiters: VecDeque<(u64, oneshot::Sender<()>)>,
    next_waiter: u64,
    walking: HashMap<String, Arc<Batch>>,
    was_active: bool,
    disposed: Option<SftpErrorCode>,
}

enum Ev {
    Changed(Value, bool),
    Removed(Vec<String>),
    Active(bool),
}

/// One bookkeeping step under the queue's lock: the events it produced and the jobs it started.
struct Ctx<'a> {
    q: &'a TransferQueue,
    st: &'a mut State,
    ev: Vec<Ev>,
    start: Vec<(String, CancellationToken)>,
}

impl Ctx<'_> {
    fn update(&mut self, id: &str, patch: Patch, force: bool) {
        let Some(job) = self.st.jobs.get_mut(id) else { return };
        let before = job.item.state();
        job.item.apply(patch);
        let after = job.item.state();
        if before.is_finished() != after.is_finished() {
            if after.is_finished() {
                self.st.unfinished -= 1;
            } else {
                self.st.unfinished += 1;
            }
        }
        if after == TransferState::Queued && before != TransferState::Queued && !job.resuming {
            self.st.fifo.push_back(id.to_string());
        }
        self.ev.push(Ev::Changed(job.item.to_json(), force));
        if force {
            self.check_active();
        }
    }

    fn check_active(&mut self) {
        let active = self.st.unfinished > 0;
        if active != self.st.was_active {
            self.st.was_active = active;
            self.ev.push(Ev::Active(active));
        }
    }

    fn next_queued(&mut self) -> Option<String> {
        while let Some(id) = self.st.ready.pop_front() {
            if self.st.jobs.get(&id).is_some_and(|j| j.item.state() == TransferState::Queued && !j.resuming) {
                return Some(id);
            }
        }
        while let Some(id) = self.st.fifo.pop_front() {
            if self.st.jobs.get(&id).is_some_and(|j| j.item.state() == TransferState::Queued && !j.resuming && !j.blocked) {
                return Some(id);
            }
        }
        None
    }

    fn pump(&mut self) {
        if self.st.disposed.is_some() {
            return;
        }
        let max = self.q.max;
        // Items that answered a conflict come first: they were started before anything still queued.
        while self.st.running < max {
            let Some((_, tx)) = self.st.slot_waiters.pop_front() else { break };
            if tx.send(()).is_ok() {
                self.st.running += 1;
            }
        }
        while self.st.running < max {
            let Some(id) = self.next_queued() else { break };
            let Some(job) = self.st.jobs.get_mut(&id) else { continue };
            let batch = job.batch.clone();
            let target = job.item.str("target");
            let registry = batch.dst.inflight();
            if !registry.hold(&target, &id) {
                // Another job writes this target right now: this one waits and then meets it as an existing file.
                job.blocked = true;
                let (w, rt, jid) = (self.q.me.clone(), self.q.rt.clone(), id.clone());
                registry.when_free(&target, move || {
                    // Never re-enters the lock of whoever released the target.
                    rt.spawn(async move {
                        if let Some(q) = w.upgrade() {
                            q.with(|cx| cx.unblock(&jid));
                        }
                    });
                });
                continue;
            }
            let token = CancellationToken::new();
            job.abort = Some(token.clone());
            self.st.running += 1;
            let now = self.q.now();
            self.update(&id, vec![("state", v("running")), ("startedAt", v(now)), ("bytesDone", v(0)), ("speed", v(0))], true);
            self.start.push((id, token));
        }
        self.check_active();
    }

    fn unblock(&mut self, id: &str) {
        let Some(job) = self.st.jobs.get_mut(id) else { return };
        job.blocked = false;
        if job.item.state() != TransferState::Queued {
            return;
        }
        self.st.ready.push_back(id.to_string());
        self.pump();
    }

    fn end_patch(&self, error: SftpErrorCode) -> Patch {
        let now = self.q.now();
        if error == SftpErrorCode::Cancelled {
            vec![("state", v("cancelled")), ("speed", v(0)), ("conflict", None), ("endedAt", v(now))]
        } else {
            vec![("state", v("failed")), ("error", v(error.as_str())), ("speed", v(0)), ("conflict", None), ("endedAt", v(now))]
        }
    }
}

/// One file (or a rejected entry) of an enqueue.
struct FileSpec {
    source: String,
    target: String,
    name: String,
    size: u64,
    error: Option<SftpErrorCode>,
}

/// How a job ended without an error.
enum Outcome {
    /// Copied (`Some(bytes)`) or moved (`None`: the item's total counts as done).
    Done(Option<u64>),
    Skipped,
}

struct Walk<'a> {
    batch: &'a Batch,
    target_dir: &'a str,
    files: Vec<FileSpec>,
    empty_dirs: Vec<String>,
}

impl Walk<'_> {
    fn reject(&mut self, source: &str, label: &str, error: SftpErrorCode) {
        self.files.push(FileSpec {
            source: source.to_string(),
            target: self.target_dir.to_string(),
            name: label.to_string(),
            size: 0,
            error: Some(error),
        });
    }
}

fn err(code: SftpErrorCode) -> SideError {
    code.into()
}

pub struct TransferQueue {
    me: Weak<TransferQueue>,
    session_id: String,
    events: Arc<dyn QueueEvents>,
    max: usize,
    now: Now,
    rt: tokio::runtime::Handle,
    st: Mutex<State>,
    emit: Mutex<()>,
    disposed: AtomicBool,
    /// The host crashed: nothing is reported any more (the renderer fails its unfinished items itself).
    muted: AtomicBool,
}

impl std::fmt::Debug for TransferQueue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TransferQueue").field("session", &self.session_id).field("jobs", &self.st.lock().jobs.len()).finish()
    }
}

impl TransferQueue {
    /// A queue on the current tokio runtime. `max`: files moving at once (`SFTP_LIMITS.concurrentFiles` by default).
    pub fn new(session_id: &str, events: Arc<dyn QueueEvents>, max: Option<usize>, now: Now) -> Arc<TransferQueue> {
        Self::with_runtime(session_id, events, max, now, tokio::runtime::Handle::current())
    }

    pub fn with_runtime(
        session_id: &str,
        events: Arc<dyn QueueEvents>,
        max: Option<usize>,
        now: Now,
        rt: tokio::runtime::Handle,
    ) -> Arc<TransferQueue> {
        Arc::new_cyclic(|me| TransferQueue {
            me: me.clone(),
            session_id: session_id.to_string(),
            events,
            max: max.unwrap_or(CONCURRENT_FILES).max(1),
            now,
            rt,
            st: Mutex::new(State::default()),
            emit: Mutex::new(()),
            disposed: AtomicBool::new(false),
            muted: AtomicBool::new(false),
        })
    }

    fn now(&self) -> i64 {
        (self.now)()
    }

    /// One bookkeeping step: `f` under the lock, then its events in order, then the jobs it started.
    fn with<R>(&self, f: impl FnOnce(&mut Ctx<'_>) -> R) -> R {
        let mut st = self.st.lock();
        let mut cx = Ctx { q: self, st: &mut st, ev: Vec::new(), start: Vec::new() };
        let r = f(&mut cx);
        let (ev, start) = (std::mem::take(&mut cx.ev), std::mem::take(&mut cx.start));
        let emit = self.emit.lock();
        drop(st);
        if !self.muted.load(Ordering::SeqCst) {
            for e in ev {
                match e {
                    Ev::Changed(item, force) => self.events.changed(item, force),
                    Ev::Removed(ids) => self.events.removed(ids),
                    Ev::Active(a) => self.events.active_changed(a),
                }
            }
        }
        drop(emit);
        for (id, token) in start {
            self.spawn_run(id, token);
        }
        r
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    /// Every item, in enqueue order.
    pub fn items(&self) -> Vec<Value> {
        self.st.lock().jobs.values().map(|j| j.item.to_json()).collect()
    }

    pub fn running_count(&self) -> usize {
        self.st.lock().running
    }

    pub fn active(&self) -> bool {
        self.st.lock().unfinished > 0
    }

    fn stopped(&self, batch: &Batch) -> bool {
        batch.cancelled() || self.disposed.load(Ordering::SeqCst)
    }

    /// `enqueue`: expands the sources (folders recursively) into one item per file and starts the queue. `sides`: the
    /// source and target side of the direction (None: the session is not connected).
    pub async fn enqueue(
        &self,
        req: TransferRequest,
        sides: Option<(Arc<dyn FileSide>, Arc<dyn FileSide>)>,
    ) -> Result<String, SftpErrorCode> {
        if self.disposed.load(Ordering::SeqCst) {
            return Err(SftpErrorCode::NoSession);
        }
        let (src, dst) = sides.ok_or(SftpErrorCode::NotConnected)?;
        let batch = self.with(|cx| {
            let id = match &req.batch_id {
                Some(b) if !cx.st.walking.contains_key(b) && !cx.st.jobs.values().any(|j| j.batch.id == *b) => b.clone(),
                _ => uuid::Uuid::new_v4().to_string(),
            };
            let batch = Arc::new(Batch {
                id: id.clone(),
                direction: req.direction,
                src,
                dst,
                policy: Mutex::new(req.policy),
                root: req.target_dir.clone(),
                dirs: Mutex::new(HashMap::new()),
                cancelled: AtomicBool::new(false),
            });
            cx.st.walking.insert(id, batch.clone());
            batch
        });
        let expanded = if req.direction.is_move() {
            self.expand_move(&batch, &req).await.map(|files| (files, Vec::new()))
        } else {
            self.expand(&batch, &req).await
        };
        let result = self.with(|cx| {
            cx.st.walking.remove(&batch.id);
            let (files, empty_dirs) = expanded.map_err(|e| e.code)?;
            if batch.cancelled() || cx.st.disposed.is_some() {
                return Err(SftpErrorCode::Cancelled);
            }
            let now = cx.q.now();
            for f in files {
                let id = uuid::Uuid::new_v4().to_string();
                let mut item = Item::default();
                item.apply(vec![
                    ("id", v(id.clone())),
                    ("batchId", v(batch.id.clone())),
                    ("sessionId", v(cx.q.session_id.clone())),
                    ("direction", v(req.direction.as_str())),
                    ("source", v(f.source)),
                    ("target", v(f.target.clone())),
                    ("name", v(f.name)),
                    ("bytesDone", v(0)),
                    ("bytesTotal", v(f.size)),
                    ("speed", v(0)),
                    ("state", v("queued")),
                ]);
                if let Some(e) = f.error {
                    item.apply(vec![("state", v("failed")), ("error", v(e.as_str())), ("endedAt", v(now))]);
                } else {
                    cx.st.unfinished += 1;
                    cx.st.fifo.push_back(id.clone());
                }
                cx.ev.push(Ev::Changed(item.to_json(), true));
                cx.st.jobs.insert(
                    id,
                    Job {
                        item,
                        batch: batch.clone(),
                        planned_target: f.target,
                        abort: None,
                        answer: None,
                        samples: VecDeque::new(),
                        resuming: false,
                        blocked: false,
                    },
                );
            }
            cx.pump();
            Ok(empty_dirs)
        })?;
        // Empty folders are made too (best effort, they have no item of their own).
        for dir in result {
            let check = ensure_dir(batch.clone(), dir);
            self.rt.spawn(async move {
                let _ = check.await;
            });
        }
        Ok(batch.id.clone())
    }

    async fn expand(&self, batch: &Arc<Batch>, req: &TransferRequest) -> SideResult<(Vec<FileSpec>, Vec<String>)> {
        let (src, dst) = (&batch.src, &batch.dst);
        // A name read from the source side (a server for downloads) is never trusted: one that is not a single safe segment
        // on both sides ("..", "a/b", "c:d", "NUL" on Windows) becomes a failed item and is never joined onto a path.
        // Whatever is left out (too deep, a fifo or device, a link out of the folder) shows up as a failed item too.
        let mut walk = Walk { batch: batch.as_ref(), target_dir: &req.target_dir, files: Vec::new(), empty_dirs: Vec::new() };
        for source in &req.sources {
            let name = src.basename(source);
            if name.is_empty() {
                return Err(err(SftpErrorCode::Invalid));
            }
            if !src.valid_name(&name) || !dst.valid_name(&name) {
                walk.reject(&src.dirname(source), &name, SftpErrorCode::InvalidName);
                continue;
            }
            let target = dst.join(&req.target_dir, &name);
            // Copying a folder into itself would never end.
            if req.direction == TransferDirection::LocalCopy && dst.contains(source, &req.target_dir) {
                return Err(err(SftpErrorCode::Invalid));
            }
            // The user picked this source: a link here is followed, and the folder it resolves to bounds every link inside.
            let root_real = src.realpath(source).await.ok().flatten();
            self.walk(&mut walk, source.clone(), target, name, 0, root_real.as_deref()).await?;
        }
        Ok((walk.files, walk.empty_dirs))
    }

    fn walk<'a>(
        &'a self,
        w: &'a mut Walk<'_>,
        source: String,
        target: String,
        label: String,
        depth: usize,
        root_real: Option<&'a str>,
    ) -> BoxFuture<'a, SideResult<()>> {
        Box::pin(async move {
            let batch = w.batch;
            let (src, dst) = (&batch.src, &batch.dst);
            if self.stopped(batch) {
                return Err(err(SftpErrorCode::Cancelled));
            }
            if depth > MAX_DEPTH {
                w.reject(&source, &label, SftpErrorCode::TooMany);
                return Ok(());
            }
            let Some(meta) = src.lstat(&source).await? else {
                if depth == 0 {
                    return Err(err(SftpErrorCode::NotFound));
                }
                w.reject(&source, &label, SftpErrorCode::NotFound);
                return Ok(());
            };
            let (mut kind, mut size) = (meta.kind, meta.size);
            if kind == EntryKind::Symlink {
                let Some(real) = src.stat(&source).await.ok().flatten() else {
                    w.reject(&source, &label, SftpErrorCode::NotFound);
                    return Ok(());
                };
                if depth > 0 {
                    // Inside a folder a link is followed only when it stays inside the folder the user picked.
                    let resolved = src.realpath(&source).await.ok().flatten();
                    let inside = match (root_real, resolved.as_deref()) {
                        (Some(root), Some(r)) => src.contains(root, r),
                        _ => false,
                    };
                    if !inside {
                        w.reject(&source, &label, SftpErrorCode::LinkOutside);
                        return Ok(());
                    }
                    if real.kind != EntryKind::File {
                        w.reject(&source, &label, SftpErrorCode::LinkFolder);
                        return Ok(());
                    }
                }
                kind = real.kind;
                size = real.size;
            }
            if !dst.contains(&batch.root, &target) || target == batch.root {
                w.reject(&source, &label, SftpErrorCode::Invalid);
                return Ok(());
            }
            if kind == EntryKind::File {
                w.files.push(FileSpec { source, target, name: label, size, error: None });
                if w.files.len() > BATCH_FILES {
                    return Err(err(SftpErrorCode::TooMany));
                }
                return Ok(());
            }
            if kind != EntryKind::Dir {
                w.reject(&source, &label, SftpErrorCode::Unsupported);
                return Ok(());
            }
            let children = src.readdir(&source).await?;
            if children.is_empty() {
                w.empty_dirs.push(target.clone());
            }
            for child in children {
                let child_label = format!("{label}/{}", child.name);
                if !src.valid_name(&child.name) || !dst.valid_name(&child.name) {
                    w.reject(&source, &child_label, SftpErrorCode::InvalidName);
                    continue;
                }
                let (s, t) = (src.join(&source, &child.name), dst.join(&target, &child.name));
                self.walk(w, s, t, child_label, depth + 1, root_real).await?;
            }
            Ok(())
        })
    }

    /// A move (0.9.9) is one item per selected entry (a folder moves as a whole with one rename). Entries already in the
    /// target folder have nothing to do and get no item; a folder into itself or its child refuses the whole request.
    async fn expand_move(&self, batch: &Arc<Batch>, req: &TransferRequest) -> SideResult<Vec<FileSpec>> {
        let side = &batch.src;
        let mut files = Vec::new();
        for source in &req.sources {
            if into_itself(side, source, &req.target_dir).await {
                return Err(err(SftpErrorCode::IntoItself));
            }
        }
        for source in &req.sources {
            if self.stopped(batch) {
                return Err(err(SftpErrorCode::Cancelled));
            }
            let name = side.basename(source);
            if name.is_empty() {
                return Err(err(SftpErrorCode::Invalid));
            }
            let rejected = |error| FileSpec {
                source: source.clone(),
                target: req.target_dir.clone(),
                name: name.clone(),
                size: 0,
                error: Some(error),
            };
            if !side.valid_name(&name) {
                files.push(rejected(SftpErrorCode::InvalidName));
                continue;
            }
            if side.inflight().key(&side.dirname(source)) == side.inflight().key(&req.target_dir) {
                continue;
            }
            let Some(meta) = side.lstat(source).await? else {
                files.push(rejected(SftpErrorCode::NotFound));
                continue;
            };
            files.push(FileSpec {
                source: source.clone(),
                target: side.join(&req.target_dir, &name),
                name,
                size: if meta.kind == EntryKind::File { meta.size } else { 0 },
                error: None,
            });
            if files.len() > BATCH_FILES {
                return Err(err(SftpErrorCode::TooMany));
            }
        }
        Ok(files)
    }

    fn spawn_run(&self, id: String, token: CancellationToken) {
        let Some(me) = self.me.upgrade() else { return };
        self.rt.spawn(async move {
            let run = AssertUnwindSafe(me.clone().run(id.clone(), token)).catch_unwind().await;
            me.with(|cx| {
                if run.is_err() {
                    // A bug in a job ends only that item (1.1.4: the host process would have died).
                    let unfinished = cx.st.jobs.get(&id).is_some_and(|j| !j.item.state().is_finished());
                    if unfinished {
                        let patch = cx.end_patch(SftpErrorCode::Failed);
                        cx.update(&id, patch, true);
                    }
                    if let Some(job) = cx.st.jobs.get_mut(&id) {
                        job.abort = None;
                        let (batch, planned) = (job.batch.clone(), job.planned_target.clone());
                        batch.dst.inflight().release(&planned, &id);
                    }
                }
                cx.st.running = cx.st.running.saturating_sub(1);
                cx.pump();
            });
        });
    }

    async fn run(self: Arc<Self>, id: String, cancel: CancellationToken) {
        let Some((batch, source, planned)) =
            self.st.lock().jobs.get(&id).map(|j| (j.batch.clone(), j.item.str("source"), j.planned_target.clone()))
        else {
            return;
        };
        let moving = batch.direction.is_move();
        let mut target = planned.clone();
        let mut part: Option<String> = None;
        let result = if moving {
            self.move_body(&id, &batch, &source, &mut target, &cancel).await
        } else {
            self.copy_body(&id, &batch, &source, &mut target, &mut part, &cancel).await
        };
        let failure = match &result {
            Ok(_) => None,
            Err(e) => {
                let code = if cancel.is_cancelled() { SftpErrorCode::Cancelled } else { e.code };
                // A complete part file whose old target could not be put back is the only copy: it stays.
                if let Some(p) = part.take()
                    && !e.keep_part
                {
                    let _ = batch.dst.unlink(&p).await;
                }
                Some(code)
            }
        };
        self.with(|cx| {
            match (result, failure) {
                (Ok(Outcome::Done(bytes)), _) => {
                    let total = cx.st.jobs.get(&id).map(|j| j.item.u64("bytesTotal")).unwrap_or(0);
                    let (done, total) = match bytes {
                        Some(done) => (done, done.max(total)),
                        None => (total, total),
                    };
                    let now = cx.q.now();
                    let patch = vec![
                        ("state", v("done")),
                        ("bytesDone", v(done)),
                        ("bytesTotal", v(total)),
                        ("speed", v(0)),
                        ("endedAt", v(now)),
                    ];
                    cx.update(&id, patch, true);
                }
                (Ok(Outcome::Skipped), _) => {
                    let now = cx.q.now();
                    let patch = vec![
                        ("state", v("done")),
                        ("skipped", v(true)),
                        ("conflict", None),
                        ("speed", v(0)),
                        ("endedAt", v(now)),
                    ];
                    cx.update(&id, patch, true);
                }
                (Err(_), code) => {
                    if cx.st.jobs.contains_key(&id) {
                        let error = cx.st.disposed.unwrap_or(code.unwrap_or(SftpErrorCode::Failed));
                        let patch = cx.end_patch(error);
                        cx.update(&id, patch, true);
                    }
                }
            }
            if let Some(job) = cx.st.jobs.get_mut(&id) {
                job.abort = None;
            }
            batch.dst.inflight().release(&target, &id);
            batch.dst.inflight().release(&planned, &id);
        });
    }

    fn set_total(&self, id: &str, total: u64) {
        self.with(|cx| cx.update(id, vec![("bytesTotal", v(total))], false));
    }

    fn reset_samples(&self, id: &str) {
        let now = self.now();
        if let Some(job) = self.st.lock().jobs.get_mut(id) {
            job.samples = VecDeque::from([(now, 0)]);
        }
    }

    fn progress(&self, id: &str, done: u64) {
        let now = self.now();
        self.with(|cx| {
            let Some(job) = cx.st.jobs.get_mut(id) else { return };
            job.samples.push_back((now, done));
            while job.samples.len() > 2 && job.samples.front().is_some_and(|(t, _)| now - t > SPEED_WINDOW_MS) {
                job.samples.pop_front();
            }
            let (t0, b0) = job.samples.front().copied().unwrap_or((now, done));
            let speed = if now > t0 { ((done as f64 - b0 as f64) * 1000.0 / (now - t0) as f64).round() as i64 } else { 0 };
            cx.update(id, vec![("bytesDone", v(done)), ("speed", v(speed))], false);
        });
    }

    async fn decide(
        &self,
        id: &str,
        batch: &Arc<Batch>,
        target: &str,
        existing: Meta,
        incoming: Meta,
        cancel: &CancellationToken,
    ) -> Option<ConflictChoice> {
        if let Some(policy) = *batch.policy.lock() {
            return Some(policy);
        }
        // Paused: it does not hold one of the running slots while the user thinks.
        let (tx, rx) = oneshot::channel();
        self.with(|cx| {
            cx.st.running = cx.st.running.saturating_sub(1);
            if let Some(job) = cx.st.jobs.get_mut(id) {
                job.answer = Some(tx);
            }
            let conflict = json!({
                "target": target,
                "existing": { "kind": existing.kind.as_str(), "size": existing.size, "mtime": existing.mtime },
                "incoming": { "size": incoming.size, "mtime": incoming.mtime, "kind": incoming.kind.as_str() },
            });
            cx.update(id, vec![("state", v("conflict")), ("speed", v(0)), ("conflict", Some(conflict))], true);
            cx.pump();
        });
        let answer = tokio::select! {
            a = rx => a.ok(),
            _ = cancel.cancelled() => None,
        };
        let wait = self.with(|cx| {
            if let Some(job) = cx.st.jobs.get_mut(id) {
                job.answer = None;
            }
            if let Some(a) = answer
                && a.apply_to_rest
            {
                *batch.policy.lock() = Some(a.choice);
                // Every other item of the batch that waits gets the same answer.
                for (oid, other) in cx.st.jobs.iter_mut() {
                    if oid != id
                        && Arc::ptr_eq(&other.batch, batch)
                        && other.item.state() == TransferState::Conflict
                        && let Some(tx) = other.answer.take()
                    {
                        let _ = tx.send(ConflictAnswer { choice: a.choice, apply_to_rest: false });
                    }
                }
            }
            // Back into a running slot (the cap holds: it waits as queued when all slots are busy).
            if answer.is_some() && !cancel.is_cancelled() && cx.st.running >= cx.q.max {
                if let Some(job) = cx.st.jobs.get_mut(id) {
                    job.resuming = true;
                }
                cx.update(id, vec![("state", v("queued")), ("conflict", None), ("speed", v(0))], true);
                let (tx, rx) = oneshot::channel();
                let wid = cx.st.next_waiter;
                cx.st.next_waiter += 1;
                cx.st.slot_waiters.push_back((wid, tx));
                Some((wid, rx))
            } else {
                cx.st.running += 1;
                None
            }
        });
        if let Some((wid, rx)) = wait {
            tokio::select! {
                biased;
                _ = rx => {}
                _ = cancel.cancelled() => {
                    self.with(|cx| {
                        // Still waiting: it takes its slot back itself (a granted one was counted by pump()).
                        if let Some(pos) = cx.st.slot_waiters.iter().position(|(w, _)| *w == wid) {
                            cx.st.slot_waiters.remove(pos);
                            cx.st.running += 1;
                        }
                    });
                }
            }
            if let Some(job) = self.st.lock().jobs.get_mut(id) {
                job.resuming = false;
            }
        }
        if cancel.is_cancelled() { None } else { answer.map(|a| a.choice) }
    }

    /// A free "name (n).ext" next to `target`, held for `owner` before anything else can take it.
    async fn keep_both_target(side: &Arc<dyn FileSide>, target: &str, owner: &str, directory: bool) -> SideResult<String> {
        let dir = side.dirname(target);
        let mut names: Vec<String> = side.readdir(&dir).await?.into_iter().map(|e| e.name).collect();
        let base = side.basename(target);
        let ci = side.case_insensitive();
        let mut name = keep_both_name(&base, &names, directory, ci);
        while side.inflight().is_held(&side.join(&dir, &name)) {
            names.push(name);
            name = keep_both_name(&base, &names, directory, ci);
        }
        let next = side.join(&dir, &name);
        side.inflight().hold(&next, owner);
        side.inflight().release(target, owner);
        Ok(next)
    }

    async fn copy_body(
        &self,
        id: &str,
        batch: &Arc<Batch>,
        source: &str,
        target: &mut String,
        part: &mut Option<String>,
        cancel: &CancellationToken,
    ) -> SideResult<Outcome> {
        let (src, dst) = (&batch.src, &batch.dst);
        let src_meta = src.stat(source).await?.ok_or(err(SftpErrorCode::NotFound))?;
        if src_meta.kind == EntryKind::Dir {
            return Err(err(SftpErrorCode::IsADirectory));
        }
        self.set_total(id, src_meta.size);
        let dir = dst.dirname(target);
        if *target == batch.root || !dst.contains(&batch.root, target) {
            return Err(err(SftpErrorCode::Invalid));
        }
        ensure_dir(batch.clone(), dir.clone()).await?;
        if cancel.is_cancelled() {
            return Err(err(SftpErrorCode::Cancelled));
        }
        let mut overwrite = false;
        if let Some(existing) = dst.lstat(target).await? {
            let same_file = batch.one_side() && dst.inflight().key(target) == dst.inflight().key(source);
            let choice = if same_file {
                Some(ConflictChoice::KeepBoth)
            } else {
                self.decide(id, batch, target, existing, src_meta, cancel).await
            };
            let choice = choice.filter(|_| !cancel.is_cancelled()).ok_or(err(SftpErrorCode::Cancelled))?;
            match choice {
                ConflictChoice::Skip => return Ok(Outcome::Skipped),
                ConflictChoice::Overwrite => {
                    if existing.kind == EntryKind::Dir {
                        return Err(err(SftpErrorCode::IsADirectory));
                    }
                    overwrite = true;
                }
                ConflictChoice::KeepBoth => *target = Self::keep_both_target(dst, target, id, false).await?,
            }
            let t = target.clone();
            self.with(|cx| cx.update(id, vec![("state", v("running")), ("target", v(t)), ("conflict", None)], true));
        }
        // Defense in depth: whatever the names were, nothing is written outside the chosen folder.
        if *target == batch.root || !dst.contains(&batch.root, target) {
            return Err(err(SftpErrorCode::Invalid));
        }
        let p = dst.join(&dir, &part_name(&dst.basename(target)));
        *part = Some(p.clone());
        // The target is held by this job, so a part file under its name is a leftover of a crash, never another job's.
        let _ = dst.unlink(&p).await;
        let reader = src.open_read(source).await?;
        let writer = match dst.open_write(&p).await {
            Ok(w) => w,
            Err(e) => {
                reader.close().await;
                return Err(e);
            }
        };
        self.reset_samples(id);
        let mut done = 0u64;
        pipe(reader, writer, cancel, &mut |n| {
            done += n;
            self.progress(id, done);
        })
        .await?;
        if cancel.is_cancelled() {
            return Err(err(SftpErrorCode::Cancelled));
        }
        dst.rename(&p, target, overwrite).await?;
        *part = None;
        if src_meta.mtime != 0 {
            let _ = dst.set_mtime(target, src_meta.mtime).await;
        }
        Ok(Outcome::Done(Some(done)))
    }

    /// A move inside one side (0.9.9): one rename (posix-rename, or the aside dance for Overwrite on a server). A local
    /// move across volumes copies through part files and deletes the source only once every copy is complete; a server
    /// that cannot rename (another file system) fails with crossDevice. Nothing is ever deleted while it is the only copy.
    async fn move_body(
        &self,
        id: &str,
        batch: &Arc<Batch>,
        source: &str,
        target: &mut String,
        cancel: &CancellationToken,
    ) -> SideResult<Outcome> {
        let side = &batch.dst;
        let meta = side.lstat(source).await?.ok_or(err(SftpErrorCode::NotFound))?;
        if *target == batch.root || !side.contains(&batch.root, target) {
            return Err(err(SftpErrorCode::Invalid));
        }
        if into_itself(side, source, &batch.root).await {
            return Err(err(SftpErrorCode::IntoItself));
        }
        let mut overwrite = false;
        if let Some(existing) = side.lstat(target).await? {
            let choice = self.decide(id, batch, target, existing, meta, cancel).await;
            let choice = choice.filter(|_| !cancel.is_cancelled()).ok_or(err(SftpErrorCode::Cancelled))?;
            match choice {
                ConflictChoice::Skip => return Ok(Outcome::Skipped),
                ConflictChoice::Overwrite => {
                    // Only a file replaces a file: a folder is never merged or replaced by a move.
                    if existing.kind == EntryKind::Dir || meta.kind == EntryKind::Dir {
                        return Err(err(SftpErrorCode::IsADirectory));
                    }
                    overwrite = true;
                }
                ConflictChoice::KeepBoth => {
                    *target = Self::keep_both_target(side, target, id, meta.kind == EntryKind::Dir).await?
                }
            }
            let t = target.clone();
            self.with(|cx| cx.update(id, vec![("state", v("running")), ("target", v(t)), ("conflict", None)], true));
        }
        if *target == batch.root || !side.contains(&batch.root, target) {
            return Err(err(SftpErrorCode::Invalid));
        }
        if let Err(e) = side.rename(source, target, overwrite).await {
            // SFTP v3 reports every refused rename as a plain failure: the text names another file system only as an example.
            if side.remote() {
                let code = if e.code == SftpErrorCode::Failed { SftpErrorCode::CrossDevice } else { e.code };
                return Err(SideError { code, keep_part: e.keep_part });
            }
            if e.code != SftpErrorCode::CrossDevice {
                return Err(e);
            }
            self.copy_then_delete(id, side, source, target, meta, overwrite, cancel).await?;
        }
        Ok(Outcome::Done(None))
    }

    #[allow(clippy::too_many_arguments)]
    async fn copy_then_delete(
        &self,
        id: &str,
        side: &Arc<dyn FileSide>,
        source: &str,
        target: &str,
        meta: Meta,
        overwrite: bool,
        cancel: &CancellationToken,
    ) -> SideResult<()> {
        let mut done = 0u64;
        self.reset_samples(id);
        let mut on_bytes = |n: u64| {
            done += n;
            self.progress(id, done);
        };
        if meta.kind == EntryKind::File {
            self.set_total(id, meta.size);
            copy_file(side, source, target, overwrite, cancel, &mut on_bytes).await?;
            verify_copy(side, source, target, meta.size, meta.mtime).await?;
            side.unlink(source).await?;
            return Ok(());
        }
        if meta.kind != EntryKind::Dir {
            return Err(err(SftpErrorCode::CrossDevice));
        }
        // The whole tree is read first: a link or an unsafe name inside refuses the move before anything is copied.
        let mut tree = Tree { dirs: vec![(source.to_string(), target.to_string())], files: Vec::new(), total: 0 };
        read_tree(side, &mut tree, source.to_string(), target.to_string(), 0).await?;
        self.set_total(id, tree.total);
        // What this job made in the target: removed again when the copy fails or is cancelled (never anything that was there).
        let mut made_dirs: Vec<String> = Vec::new();
        let mut placed: Vec<String> = Vec::new();
        let copied: SideResult<()> = async {
            for (_, to) in &tree.dirs {
                if cancel.is_cancelled() {
                    return Err(err(SftpErrorCode::Cancelled));
                }
                side.mkdir(to).await?;
                made_dirs.push(to.clone());
            }
            for f in &tree.files {
                if cancel.is_cancelled() {
                    return Err(err(SftpErrorCode::Cancelled));
                }
                copy_file(side, &f.from, &f.to, false, cancel, &mut on_bytes).await?;
                placed.push(f.to.clone());
            }
            Ok(())
        }
        .await;
        if let Err(e) = copied {
            for p in placed.iter().rev() {
                let _ = side.unlink(p).await;
            }
            for d in made_dirs.iter().rev() {
                let _ = side.rmdir(d).await;
            }
            return Err(e);
        }
        // Every copy is checked against its source (a source changed meanwhile keeps both); only then the source goes
        // (files first, then the folders deepest first).
        for f in &tree.files {
            verify_copy(side, &f.from, &f.to, f.size, f.mtime).await?;
        }
        for f in &tree.files {
            side.unlink(&f.from).await?;
        }
        for (from, _) in tree.dirs.iter().rev() {
            side.rmdir(from).await?;
        }
        Ok(())
    }

    /// `answerConflict`.
    pub fn answer_conflict(&self, item_id: &str, answer: ConflictAnswer) -> bool {
        let mut st = self.st.lock();
        let Some(job) = st.jobs.get_mut(item_id) else { return false };
        if job.item.state() != TransferState::Conflict {
            return false;
        }
        match job.answer.take() {
            Some(tx) => tx.send(answer).is_ok(),
            None => false,
        }
    }

    /// `cancel({itemIds, batchId})`.
    pub fn cancel(&self, item_ids: Option<&[String]>, batch_id: Option<&str>) -> bool {
        self.with(|cx| {
            let mut any = false;
            if let Some(b) = batch_id
                && let Some(walking) = cx.st.walking.get(b)
            {
                walking.cancelled.store(true, Ordering::SeqCst);
                any = true;
            }
            let ids: HashSet<&str> = item_ids.unwrap_or_default().iter().map(String::as_str).collect();
            let keys: Vec<String> = cx.st.jobs.keys().cloned().collect();
            for id in keys {
                let Some(job) = cx.st.jobs.get(&id) else { continue };
                let in_batch = batch_id.is_some_and(|b| job.batch.id == b);
                if !ids.contains(id.as_str()) && !in_batch {
                    continue;
                }
                if in_batch {
                    job.batch.cancelled.store(true, Ordering::SeqCst);
                }
                let state = job.item.state();
                if state.is_finished() {
                    continue;
                }
                any = true;
                if state == TransferState::Queued && job.abort.is_none() {
                    let now = cx.q.now();
                    cx.update(&id, vec![("state", v("cancelled")), ("speed", v(0)), ("endedAt", v(now))], true);
                    continue;
                }
                if let Some(t) = &job.abort {
                    t.cancel();
                }
            }
            cx.check_active();
            any
        })
    }

    /// `retry(itemIds)`.
    pub fn retry(&self, item_ids: &[String]) -> bool {
        self.with(|cx| {
            let mut any = false;
            for id in item_ids {
                let Some(job) = cx.st.jobs.get(id) else { continue };
                let state = job.item.state();
                if state != TransferState::Failed && state != TransferState::Cancelled {
                    continue;
                }
                // A retry cannot make a name safe, bring a link inside the folder or a fifo transferable.
                if job.item.error().is_some_and(|e| {
                    matches!(
                        e,
                        SftpErrorCode::InvalidName
                            | SftpErrorCode::Invalid
                            | SftpErrorCode::LinkOutside
                            | SftpErrorCode::LinkFolder
                            | SftpErrorCode::Unsupported
                    )
                }) {
                    continue;
                }
                // A rejected entry, not a file.
                if job.item.u64("bytesTotal") == 0 && job.item.str("target") == job.batch.root {
                    continue;
                }
                any = true;
                job.batch.cancelled.store(false, Ordering::SeqCst);
                let planned = job.planned_target.clone();
                cx.update(
                    id,
                    vec![
                        ("state", v("queued")),
                        ("target", v(planned)),
                        ("bytesDone", v(0)),
                        ("speed", v(0)),
                        ("error", None),
                        ("skipped", None),
                        ("conflict", None),
                        ("startedAt", None),
                        ("endedAt", None),
                    ],
                    true,
                );
            }
            cx.pump();
            any
        })
    }

    /// `clearFinished`: the ids of the finished items it removed.
    pub fn clear_finished(&self) -> Vec<String> {
        self.with(|cx| {
            let gone: Vec<String> =
                cx.st.jobs.iter().filter(|(_, j)| j.item.state().is_finished()).map(|(id, _)| id.clone()).collect();
            if !gone.is_empty() {
                cx.st.jobs.retain(|_, j| !j.item.state().is_finished());
                cx.ev.push(Ev::Removed(gone.clone()));
            }
            gone
        })
    }

    /// `whenIdle(ms)`: resolves once no file is running (or after `limit`).
    pub async fn when_idle(&self, limit: Duration) {
        let until = Instant::now() + limit;
        while self.st.lock().running > 0 && Instant::now() < until {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }

    /// `dispose(error)`: the session ended; whatever is not finished ends with `error` (running files are aborted and their
    /// part files removed). `cancelled` (the user disconnected) makes them cancelled, anything else failed.
    pub fn dispose(&self, error: SftpErrorCode) {
        self.with(|cx| {
            if cx.st.disposed.is_some() {
                return;
            }
            cx.st.disposed = Some(error);
            cx.q.disposed.store(true, Ordering::SeqCst);
            for b in cx.st.walking.values() {
                b.cancelled.store(true, Ordering::SeqCst);
            }
            let keys: Vec<String> = cx.st.jobs.keys().cloned().collect();
            for id in keys {
                let Some(job) = cx.st.jobs.get_mut(&id) else { continue };
                job.batch.cancelled.store(true, Ordering::SeqCst);
                if job.item.state().is_finished() {
                    continue;
                }
                if let Some(t) = &job.abort {
                    t.cancel();
                    continue;
                }
                job.answer = None;
                let patch = cx.end_patch(error);
                cx.update(&id, patch, true);
            }
            cx.check_active();
        });
    }

    /// The host crashed: the queue stops without another report (running files still remove their part files).
    pub fn kill(&self) {
        self.muted.store(true, Ordering::SeqCst);
        self.dispose(SftpErrorCode::SftpHostCrashed);
    }
}

/// `ensureDir`: mkdir -p of `dir` on the target side, once per batch.
fn ensure_dir(batch: Arc<Batch>, dir: String) -> DirCheck {
    let mut dirs = batch.dirs.lock();
    if let Some(known) = dirs.get(&dir) {
        return known.clone();
    }
    let (b, d) = (batch.clone(), dir.clone());
    let check: DirCheck = async move {
        let r: SideResult<()> = async {
            if let Some(meta) = b.dst.stat(&d).await? {
                return if meta.kind == EntryKind::Dir { Ok(()) } else { Err(err(SftpErrorCode::NotADirectory)) };
            }
            let parent = b.dst.dirname(&d);
            if !parent.is_empty() && parent != d {
                ensure_dir(b.clone(), parent).await?;
            }
            if let Err(e) = b.dst.mkdir(&d).await {
                let again = b.dst.stat(&d).await.ok().flatten();
                if again.map(|m| m.kind) != Some(EntryKind::Dir) {
                    return Err(e);
                }
            }
            Ok(())
        }
        .await;
        if r.is_err() {
            b.dirs.lock().remove(&d);
        }
        r
    }
    .boxed()
    .shared();
    dirs.insert(dir, check.clone());
    check
}

/// `source` is `target_dir` or above it: lexically, and by the real paths of both (an 8.3 spelling, a \\?\ or UNC path, a
/// junction or a server symlink to the same folder is caught too).
async fn into_itself(side: &Arc<dyn FileSide>, source: &str, target_dir: &str) -> bool {
    if side.contains(source, target_dir) {
        return true;
    }
    let (rs, rt) = futures::join!(side.realpath(source), side.realpath(target_dir));
    match (rs.ok().flatten(), rt.ok().flatten()) {
        (Some(rs), Some(rt)) => side.contains(&rs, &rt),
        _ => false,
    }
}

/// The bytes of `reader` into `writer` (closed at the end); stops at once when `cancel` fires.
async fn pipe(
    mut reader: Box<dyn FileReader>,
    mut writer: Box<dyn FileWriter>,
    cancel: &CancellationToken,
    on_bytes: &mut (dyn FnMut(u64) + Send),
) -> SideResult<()> {
    let moved: SideResult<()> = async {
        loop {
            let chunk = tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(err(SftpErrorCode::Cancelled)),
                c = reader.next_chunk() => c?,
            };
            let Some(chunk) = chunk else { return Ok(()) };
            on_bytes(chunk.len() as u64);
            tokio::select! {
                biased;
                _ = cancel.cancelled() => return Err(err(SftpErrorCode::Cancelled)),
                r = writer.write(chunk) => r?,
            }
        }
    }
    .await;
    reader.close().await;
    match moved {
        Ok(()) => tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(err(SftpErrorCode::Cancelled)),
            r = writer.finish() => r,
        },
        Err(e) => {
            writer.abort().await;
            Err(e)
        }
    }
}

/// One file through "<name>.unimux-part" on the same side (a local move across volumes); the part file never stays.
async fn copy_file(
    side: &Arc<dyn FileSide>,
    from: &str,
    to: &str,
    overwrite: bool,
    cancel: &CancellationToken,
    on_bytes: &mut (dyn FnMut(u64) + Send),
) -> SideResult<()> {
    let part = side.join(&side.dirname(to), &part_name(&side.basename(to)));
    let _ = side.unlink(&part).await;
    let mut wrote = false;
    let r: SideResult<()> = async {
        let reader = side.open_read(from).await?;
        let writer = match side.open_write(&part).await {
            Ok(w) => w,
            Err(e) => {
                reader.close().await;
                return Err(e);
            }
        };
        wrote = true;
        pipe(reader, writer, cancel, on_bytes).await?;
        if cancel.is_cancelled() {
            return Err(err(SftpErrorCode::Cancelled));
        }
        side.rename(&part, to, overwrite).await?;
        wrote = false;
        if let Ok(Some(meta)) = side.stat(from).await
            && meta.mtime != 0
        {
            let _ = side.set_mtime(to, meta.mtime).await;
        }
        Ok(())
    }
    .await;
    if r.is_err() && wrote {
        let _ = side.unlink(&part).await;
    }
    r
}

/// The copy is complete and the source is still what was read before the copy (else both stay: `changed`).
async fn verify_copy(side: &Arc<dyn FileSide>, from: &str, to: &str, size: u64, mtime: i64) -> SideResult<()> {
    let (a, b) = futures::join!(side.stat(from), side.stat(to));
    match (a?, b?) {
        (Some(a), Some(b)) if a.size == size && b.size == size && a.mtime == mtime => Ok(()),
        _ => Err(err(SftpErrorCode::Changed)),
    }
}

struct TreeFile {
    from: String,
    to: String,
    size: u64,
    mtime: i64,
}

struct Tree {
    dirs: Vec<(String, String)>,
    files: Vec<TreeFile>,
    total: u64,
}

fn read_tree<'a>(
    side: &'a Arc<dyn FileSide>,
    tree: &'a mut Tree,
    from: String,
    to: String,
    depth: usize,
) -> BoxFuture<'a, SideResult<()>> {
    Box::pin(async move {
        if depth > MAX_DEPTH {
            return Err(err(SftpErrorCode::TooMany));
        }
        for child in side.readdir(&from).await? {
            if !side.valid_name(&child.name) {
                return Err(err(SftpErrorCode::InvalidName));
            }
            let (a, b) = (side.join(&from, &child.name), side.join(&to, &child.name));
            if child.meta.kind == EntryKind::Dir {
                tree.dirs.push((a.clone(), b.clone()));
                read_tree(side, tree, a, b, depth + 1).await?;
                continue;
            }
            if child.meta.kind != EntryKind::File {
                return Err(err(SftpErrorCode::LinkSkipped));
            }
            tree.total += child.meta.size;
            tree.files.push(TreeFile { from: a, to: b, size: child.meta.size, mtime: child.meta.mtime });
            if tree.files.len() > BATCH_FILES {
                return Err(err(SftpErrorCode::TooMany));
            }
        }
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keep_both_names_like_the_ts_helper() {
        let none: [&str; 0] = [];
        assert_eq!(keep_both_name("report.pdf", &none, false, false), "report (1).pdf");
        assert_eq!(keep_both_name("report.pdf", &["report (1).pdf"], false, false), "report (2).pdf");
        assert_eq!(keep_both_name("report (3).pdf", &none, false, false), "report (1).pdf");
        assert_eq!(keep_both_name("a.tar.gz", &none, false, false), "a.tar (1).gz");
        assert_eq!(keep_both_name(".bashrc", &none, false, false), ".bashrc (1)");
        assert_eq!(keep_both_name("my.dir", &none, true, false), "my.dir (1)");
        assert_eq!(keep_both_name("a (1) (2)", &none, true, false), "a (1) (1)");
        assert_eq!(keep_both_name("a ((3)", &none, true, false), "a ((3) (1)");
        assert_eq!(keep_both_name("A.txt", &["a (1).TXT"], false, true), "A (2).txt");
        assert_eq!(keep_both_name("A.txt", &["a (1).TXT"], false, false), "A (1).txt");
        assert_eq!(keep_both_name("x", &["x (1).unimux-part"], false, false), "x (2)");
        assert!(is_part_name("a.unimux-part"));
        assert!(!is_part_name(".unimux-part"));
    }

    #[test]
    fn items_keep_the_js_key_order() {
        let mut item = Item::default();
        item.apply(vec![("id", v("i")), ("state", v("queued")), ("speed", v(0))]);
        item.apply(vec![("state", v("failed")), ("error", v("notFound"))]);
        item.apply(vec![("state", v("queued")), ("error", None), ("startedAt", v(5))]);
        assert_eq!(item.to_json().to_string(), r#"{"id":"i","state":"queued","speed":0,"startedAt":5}"#);
        item.apply(vec![("error", v("failed"))]);
        assert_eq!(item.to_json().to_string(), r#"{"id":"i","state":"queued","speed":0,"error":"failed","startedAt":5}"#);
        assert!(TransferState::Cancelled.is_finished());
        assert!(!TransferState::Conflict.is_finished());
    }
}
