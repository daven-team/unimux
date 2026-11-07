//! The conversation index (port of src/convsearch/indexer.ts): every Claude Code transcript
//! (`<claude dir>/projects/<folder>/<session>.jsonl`) and every Codex rollout (`<codex home>/sessions/YYYY/MM/DD/rollout-*.jsonl`),
//! reduced to their user and assistant texts. A pass lists the folders and stats the files (24 at a time); only new and
//! changed files are read (6 at a time, newest first), and a file that only grew (transcripts are append-only) is read from
//! where the last pass stopped. Searches answer from what is indexed while a pass runs. The index is kept in
//! `conversation-index-v2.bin` between runs.

use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use indexmap::IndexMap;
use parking_lot::{Condvar, Mutex, RwLock};
use rayon_core::{ThreadPool, ThreadPoolBuilder};
use serde_json::{Map, Value, json};
use unimux_state::normalize::timsort;

use super::parse::{self, ConvMeta, ReadAt, Sink};
use super::paths::join;
use super::search::{ConvDoc, ConvQuery, MESSAGE_SEP, search_docs};
use super::text::{U16s, fold, utf16};
use super::{ConvCli, ConvRole, INDEX_LIMITS, Limits, Roots, TRANSCRIPT_LIMITS, clip_title, node_error, num};

pub struct IndexerOptions {
    pub roots: Roots,
    pub cache_file: Option<PathBuf>,
    /// A pass started within this long after the last one is not repeated (a search per keystroke must not stat every file).
    pub fresh_ms: f64,
    pub now: fn() -> f64,
    /// Threads of the pass workers: None shares the workers of the process (`workers()`); Some(n) gives this index its own
    /// n threads (the tests force a small machine with it).
    pub pass_threads: Option<usize>,
}

impl IndexerOptions {
    pub fn new(roots: Roots, cache_file: Option<PathBuf>) -> Self {
        Self { roots, cache_file, fresh_ms: 4000.0, now: now_ms, pass_threads: None }
    }
}

pub fn now_ms() -> f64 {
    unimux_core::time::now_ms() as f64
}

/// A document with what the reader needs to extend it.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DocState {
    pub doc: ConvDoc,
    pub meta: ConvMeta,
    /// doc.text length as the reader counts it (the next message starts at len + 1).
    pub len: usize,
    pub visible: bool,
}

impl DocState {
    pub fn empty(cli: ConvCli, file: &str) -> Self {
        Self { doc: ConvDoc { cli, file: file.to_string(), ..Default::default() }, ..Default::default() }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Entry {
    pub file: String,
    pub cli: ConvCli,
    pub size: u64,
    pub mtime_ms: f64,
    pub birthtime_ms: f64,
    pub ino: u64,
    pub offset: u64,
    pub doc: Arc<DocState>,
}

#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Stats {
    pub passes: u64,
    pub full_reads: u64,
    pub append_reads: u64,
    pub bytes_read: u64,
    pub last_pass_ms: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct FileStat {
    pub size: u64,
    pub mtime_ms: f64,
    pub birthtime_ms: f64,
    pub ino: u64,
}

/// `stat.mtimeMs` as Node computes it (seconds * 1e3 + nanoseconds / 1e6, fractions kept).
pub fn ms_of(t: SystemTime) -> f64 {
    match t.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_secs() as f64 * 1e3 + f64::from(d.subsec_nanos()) / 1e6,
        Err(e) => {
            let d = e.duration();
            -(d.as_secs() as f64 * 1e3 + f64::from(d.subsec_nanos()) / 1e6)
        }
    }
}

pub fn mtime_ms(st: &fs::Metadata) -> f64 {
    st.modified().map(ms_of).unwrap_or(0.0)
}

fn birthtime_ms(st: &fs::Metadata) -> f64 {
    st.created().map(ms_of).unwrap_or(0.0)
}

/// Size, `mtimeMs` and `birthtimeMs` of a file (what a pass compares). On Windows read by path with GetFileAttributesExW:
/// `fs::metadata` opens a handle for every file, which made a pass over an unchanged index slower than 1.1.4's. A link,
/// a long path or any error goes through `fs::metadata` (follows links like Node's stat; its error is the one reported).
pub fn quick_stat(file: &str) -> std::io::Result<(u64, f64, f64)> {
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::Win32::Storage::FileSystem::{
            FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, GetFileAttributesExW, GetFileExInfoStandard,
            WIN32_FILE_ATTRIBUTE_DATA,
        };
        use windows::core::PCWSTR;
        let wide: Vec<u16> = std::ffi::OsStr::new(file).encode_wide().chain(std::iter::once(0)).collect();
        let mut data = WIN32_FILE_ATTRIBUTE_DATA::default();
        // SAFETY: `wide` is a NUL-terminated UTF-16 path alive for the call; `data` is a valid out struct of the asked level.
        let ok = unsafe { GetFileAttributesExW(PCWSTR(wide.as_ptr()), GetFileExInfoStandard, (&raw mut data).cast()) }.is_ok();
        let special = FILE_ATTRIBUTE_REPARSE_POINT.0 | FILE_ATTRIBUTE_DIRECTORY.0;
        if ok && data.dwFileAttributes & special == 0 {
            let time = |ft: windows::Win32::Foundation::FILETIME| {
                let intervals =
                    ((u64::from(ft.dwHighDateTime) << 32) | u64::from(ft.dwLowDateTime)) as i64 - 116_444_736_000_000_000;
                let d = std::time::Duration::new(
                    intervals.unsigned_abs() / 10_000_000,
                    (intervals.unsigned_abs() % 10_000_000) as u32 * 100,
                );
                ms_of(if intervals >= 0 { UNIX_EPOCH + d } else { UNIX_EPOCH - d })
            };
            let size = (u64::from(data.nFileSizeHigh) << 32) | u64::from(data.nFileSizeLow);
            return Ok((size, time(data.ftLastWriteTime), time(data.ftCreationTime)));
        }
    }
    let st = fs::metadata(file)?;
    Ok((st.len(), mtime_ms(&st), birthtime_ms(&st)))
}

/// The file's identity (`stat.ino`): the NTFS file index on Windows. Taken from the handle the file is read through (one
/// open per changed file).
#[cfg(windows)]
fn ino_of(f: &fs::File) -> u64 {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::Storage::FileSystem::{BY_HANDLE_FILE_INFORMATION, GetFileInformationByHandle};
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    // SAFETY: the handle is open for the duration of the call; info is a valid out pointer.
    match unsafe { GetFileInformationByHandle(HANDLE(f.as_raw_handle()), &mut info) } {
        Ok(()) => (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
        Err(_) => 0,
    }
}

#[cfg(unix)]
fn ino_of(f: &fs::File) -> u64 {
    f.metadata().map_or(0, |st| std::os::unix::fs::MetadataExt::ino(&st))
}

#[cfg(not(any(windows, unix)))]
fn ino_of(_f: &fs::File) -> u64 {
    0
}

/// Runs `f` over `items` with at most `n` at a time; the results keep the order of the items. The work runs on `workers`
/// (threads kept between passes) or, without them, on threads started for this call; fewer than 8 items run one after the
/// other on the calling thread.
pub fn pool<T: Sync, R: Send>(workers: Option<&ThreadPool>, items: &[T], n: usize, f: impl Fn(&T) -> R + Sync) -> Vec<R> {
    let next = AtomicUsize::new(0);
    let out: Mutex<Vec<Option<R>>> = Mutex::new((0..items.len()).map(|_| None).collect());
    let count = n.min(items.len());
    let work = || {
        loop {
            let i = next.fetch_add(1, Ordering::SeqCst);
            if i >= items.len() {
                break;
            }
            let r = f(&items[i]);
            out.lock()[i] = Some(r);
        }
    };
    if items.len() < INLINE_BELOW {
        // A handful of items: waking the workers costs more than the work.
        work();
        return out.into_inner().into_iter().flatten().collect();
    }
    match workers {
        Some(tp) => tp.scope(|s| {
            for _ in 0..count {
                s.spawn(|_| work());
            }
        }),
        None => std::thread::scope(|s| {
            for _ in 0..count {
                s.spawn(work);
            }
        }),
    }
    out.into_inner().into_iter().flatten().collect()
}

fn pool_threads() -> usize {
    std::thread::available_parallelism().map_or(4, |n| n.get()).clamp(4, 8)
}

/// The pass workers of the process: started with the first use and kept (idle, they sleep), because starting threads for
/// every pass cost more than the stats of an unchanged index. Their number caps the parallelism only; the 24 / 6 limits
/// of 1.1.4 stay the limits of what is in flight (1.1.4 ran them on libuv's 4 threads). None: they could not be started, and
/// every pass starts its own threads. Pass jobs take the entries lock, so nothing may wait on these workers while it
/// holds that lock (searches match on `search_workers()`).
pub(crate) fn workers() -> Option<&'static ThreadPool> {
    static WORKERS: std::sync::OnceLock<Option<ThreadPool>> = std::sync::OnceLock::new();
    WORKERS
        .get_or_init(|| {
            ThreadPoolBuilder::new().num_threads(pool_threads()).thread_name(|i| format!("conv-pass-{i}")).build().ok()
        })
        .as_ref()
}

/// The workers that match the documents of a big index. Kept apart from the pass workers: a pass job runs until no
/// file is left, so a search queued behind the pass jobs would wait for the whole pass.
pub(crate) fn search_workers() -> Option<&'static ThreadPool> {
    static WORKERS: std::sync::OnceLock<Option<ThreadPool>> = std::sync::OnceLock::new();
    WORKERS
        .get_or_init(|| {
            ThreadPoolBuilder::new().num_threads(pool_threads()).thread_name(|i| format!("conv-search-{i}")).build().ok()
        })
        .as_ref()
}

/// Fewer items than this run on the calling thread.
const INLINE_BELOW: usize = 8;

const STAT_CONCURRENCY: usize = 24;
const READ_CONCURRENCY: usize = 6;
/// The cache is written after a pass that read at least this many files in full (and when the service stops).
const SAVE_AFTER_PARSES: usize = 8;

struct IndexSink<'a> {
    starts: &'a mut Vec<u32>,
    roles: &'a mut Vec<u8>,
    times: &'a mut Vec<f64>,
    len: &'a mut usize,
    capped: &'a mut bool,
    limits: Limits,
    texts: Vec<U16s>,
}

impl Sink for IndexSink<'_> {
    fn message(&mut self, role: ConvRole, text: &str, ts: f64) {
        if *self.capped {
            return;
        }
        let mut units = utf16(text);
        units.truncate(self.limits.message_chars);
        let start = if self.starts.is_empty() { 0 } else { *self.len + 1 };
        if start + units.len() > self.limits.doc_chars {
            *self.capped = true;
            return;
        }
        self.starts.push(start as u32);
        self.roles.push(if role == ConvRole::User { b'u' } else { b'a' });
        self.times.push(ts);
        *self.len = start + units.len();
        self.texts.push(units);
    }
}

/// Reads a transcript from `from` into `doc`, adding its messages under the index limits. Returns the new offset.
pub fn read_into(file: &str, from: u64, doc: &mut DocState, limits: Limits, size_hint: Option<u64>) -> std::io::Result<u64> {
    read_into_file(&mut fs::File::open(file)?, from, doc, limits, size_hint)
}

/// [`read_into`] over an open file.
pub fn read_into_file(
    fh: &mut fs::File,
    from: u64,
    doc: &mut DocState,
    limits: Limits,
    size_hint: Option<u64>,
) -> std::io::Result<u64> {
    let cli = doc.doc.cli;
    let DocState { doc: d, meta, len, .. } = doc;
    let mut sink = IndexSink {
        starts: &mut d.starts,
        roles: &mut d.roles,
        times: &mut d.times,
        len,
        capped: &mut d.capped,
        limits,
        texts: Vec::new(),
    };
    let offset = parse::read_lines(
        fh as &mut dyn ReadAt,
        from,
        &mut |line| parse::feed_line(cli, meta, line, &mut sink),
        parse::MAX_LINE,
        size_hint,
    )?;
    let texts = std::mem::take(&mut sink.texts);
    if !texts.is_empty() {
        let mut added: U16s = Vec::with_capacity(texts.iter().map(|t| t.len() + 1).sum());
        for (i, t) in texts.iter().enumerate() {
            if i > 0 {
                added.push(MESSAGE_SEP);
            }
            added.extend_from_slice(t);
        }
        let folded = fold(&added);
        if !d.text.is_empty() {
            d.text.push(MESSAGE_SEP);
            d.folded.push(MESSAGE_SEP);
        }
        d.text.extend_from_slice(&added);
        d.folded.extend_from_slice(&folded);
    }
    Ok(offset)
}

/// `finish(doc, mtimeMs, birthtimeMs)`: the document's header from its meta and the file times.
pub fn finish(state: &mut DocState, mtime_ms: f64, birthtime_ms: f64) {
    let m = &state.meta;
    let d = &mut state.doc;
    d.id = m.id.clone().unwrap_or_default();
    d.cwd = m.cwd.clone();
    d.title = clip_title(m);
    let truthy = |v: f64| v != 0.0 && !v.is_nan();
    d.started_at = if truthy(m.first_ts) {
        m.first_ts
    } else if truthy(birthtime_ms) {
        birthtime_ms
    } else {
        mtime_ms
    };
    d.updated_at = if mtime_ms.is_nan() || m.last_ts.is_nan() { f64::NAN } else { mtime_ms.max(m.last_ts) };
    if let Some(model) = m.model.as_deref().filter(|s| !s.is_empty()) {
        d.model = Some(model.to_string());
    }
    // Sessions without an id or any prompt (a CLI opened and closed) are noise, as in the History list.
    state.visible = !d.id.is_empty() && !d.title.is_empty() && !d.starts.is_empty();
}

#[derive(Default)]
struct PassState {
    running: bool,
    progress: Option<(usize, usize)>,
    last_pass_at: f64,
}

pub struct Indexer {
    opts: IndexerOptions,
    entries: RwLock<IndexMap<String, Entry>>,
    loaded: Mutex<bool>,
    pass: Mutex<PassState>,
    pass_done: Condvar,
    parses_since_save: AtomicUsize,
    stats: Mutex<Stats>,
    /// Set when the service stops: a running pass ends after the files in flight.
    cancelled: AtomicBool,
    /// The own pass workers (IndexerOptions::pass_threads).
    own_workers: Option<ThreadPool>,
}

struct Listed {
    file: String,
    cli: ConvCli,
}

fn list_dir(dir: &str) -> Vec<(String, fs::FileType)> {
    let Ok(items) = fs::read_dir(dir) else { return vec![] };
    items.flatten().filter_map(|d| Some((d.file_name().to_string_lossy().to_string(), d.file_type().ok()?))).collect()
}

fn list_claude(workers: Option<&ThreadPool>, root: &str) -> Vec<Listed> {
    let base = join(root, &["projects"]);
    if fs::read_dir(&base).is_err() {
        return vec![];
    }
    let dirs: Vec<String> = list_dir(&base).into_iter().filter(|(_, t)| t.is_dir()).map(|(n, _)| n).collect();
    pool(workers, &dirs, 8, |name| {
        let dir = join(&base, &[name]);
        // Only the conversations themselves: subagent transcripts live in subfolders and cannot be resumed.
        list_dir(&dir)
            .into_iter()
            .filter(|(n, t)| t.is_file() && n.ends_with(".jsonl"))
            .map(|(n, _)| Listed { file: join(&base, &[name, &n]), cli: ConvCli::Claude })
            .collect::<Vec<_>>()
    })
    .into_iter()
    .flatten()
    .collect()
}

/// The rollouts under `<codex home>/sessions` (YYYY/MM/DD, up to 4 levels), in the order of 1.1.4's depth-first walk; the
/// folders of a level are read 8 at a time.
fn list_codex(workers: Option<&ThreadPool>, root: &str) -> Vec<Listed> {
    fn walk(workers: Option<&ThreadPool>, dir: &str, depth: u32) -> Vec<Listed> {
        let items = list_dir(dir);
        pool(workers, &items, 8, |(name, t)| {
            if t.is_dir() && depth < 4 {
                walk(workers, &join(dir, &[name]), depth + 1)
            } else if t.is_file() && name.starts_with("rollout-") && name.ends_with(".jsonl") {
                vec![Listed { file: join(dir, &[name]), cli: ConvCli::Codex }]
            } else {
                vec![]
            }
        })
        .into_iter()
        .flatten()
        .collect()
    }
    walk(workers, &join(root, &["sessions"]), 0)
}

impl Indexer {
    pub fn new(opts: IndexerOptions) -> Self {
        let own_workers = opts.pass_threads.and_then(|n| {
            ThreadPoolBuilder::new().num_threads(n.max(1)).thread_name(|i| format!("conv-pass-own-{i}")).build().ok()
        });
        Self {
            own_workers,
            opts,
            entries: RwLock::new(IndexMap::new()),
            loaded: Mutex::new(false),
            pass: Mutex::new(PassState::default()),
            pass_done: Condvar::new(),
            parses_since_save: AtomicUsize::new(0),
            stats: Mutex::new(Stats::default()),
            cancelled: AtomicBool::new(false),
        }
    }

    pub fn roots(&self) -> &Roots {
        &self.opts.roots
    }

    fn now(&self) -> f64 {
        (self.opts.now)()
    }

    pub fn stats(&self) -> Stats {
        *self.stats.lock()
    }

    /// Loads the saved index once (a missing, old or broken cache file just means a full first pass).
    pub fn load(&self) {
        let mut loaded = self.loaded.lock();
        if *loaded {
            return;
        }
        *loaded = true;
        let Some(file) = &self.opts.cache_file else { return };
        let Ok(bytes) = fs::read(file) else { return };
        if let Some(list) = super::cache::decode(&bytes) {
            let mut entries = self.entries.write();
            for e in list {
                if !e.file.is_empty() {
                    entries.insert(e.file.clone(), e);
                }
            }
        }
    }

    pub fn save(&self) {
        let Some(file) = &self.opts.cache_file else { return };
        self.parses_since_save.store(0, Ordering::SeqCst);
        let bytes = {
            let entries = self.entries.read();
            super::cache::encode(entries.values())
        };
        let write = || -> std::io::Result<()> {
            if let Some(dir) = file.parent() {
                fs::create_dir_all(dir)?;
            }
            let tmp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
            fs::write(&tmp, &bytes)?;
            if let Err(e) = fs::rename(&tmp, file) {
                let _ = fs::remove_file(&tmp);
                return Err(e);
            }
            Ok(())
        };
        // The next pass rebuilds what is missing.
        let _ = write();
    }

    pub fn dirty(&self) -> bool {
        self.parses_since_save.load(Ordering::SeqCst) > 0
    }

    /// `{done, total}` while a pass runs.
    pub fn indexing(&self) -> Option<(usize, usize)> {
        let p = self.pass.lock();
        if p.running { Some(p.progress.unwrap_or((0, 0))) } else { None }
    }

    fn indexing_json(&self) -> Value {
        match self.indexing() {
            Some((done, total)) => json!({"done": done, "total": total}),
            None => Value::Null,
        }
    }

    /// Marks a pass as running unless one runs or the last one is fresh.
    fn begin(&self, force: bool) -> bool {
        let mut p = self.pass.lock();
        if p.running {
            return false;
        }
        if !force && p.last_pass_at != 0.0 && self.now() - p.last_pass_at < self.opts.fresh_ms {
            return false;
        }
        p.running = true;
        p.progress = None;
        true
    }

    fn end(&self) {
        let mut p = self.pass.lock();
        p.running = false;
        p.progress = None;
        p.last_pass_at = self.now();
        self.pass_done.notify_all();
    }

    fn run_pass(&self) {
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| self.pass()));
        self.end();
        if let Err(p) = result {
            std::panic::resume_unwind(p);
        }
    }

    /// Starts a pass in the background unless one runs or the last one is fresh (the search answers at once).
    pub fn start_refresh(self: &Arc<Self>, force: bool) {
        if !self.begin(force) {
            return;
        }
        let me = self.clone();
        let spawned = std::thread::Builder::new().name("conv-index".into()).spawn(move || me.run_pass());
        if spawned.is_err() {
            self.end();
        }
    }

    /// `await refresh(force)`: runs a pass here, or waits for the running one to end.
    pub fn refresh(&self, force: bool) {
        if self.begin(force) {
            self.run_pass();
            return;
        }
        let mut p = self.pass.lock();
        while p.running {
            self.pass_done.wait(&mut p);
        }
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
    }

    fn pass(&self) {
        self.load();
        let workers = if self.opts.pass_threads.is_some() { self.own_workers.as_ref() } else { workers() };
        let started = self.now();
        self.stats.lock().passes += 1;
        let mut listed: IndexMap<String, ConvCli> = IndexMap::new();
        for root in &self.opts.roots.claude {
            for l in list_claude(workers, root) {
                listed.insert(l.file, l.cli);
            }
        }
        for root in &self.opts.roots.codex {
            for l in list_codex(workers, root) {
                listed.insert(l.file, l.cli);
            }
        }
        self.entries.write().retain(|k, _| listed.contains_key(k));
        let items: Vec<(String, ConvCli)> = listed.into_iter().collect();
        let stats = pool(workers, &items, STAT_CONCURRENCY, |(file, cli)| -> Option<(String, ConvCli, FileStat)> {
            match quick_stat(file) {
                Ok((size, mtime, birthtime)) => {
                    if let Some(hit) = self.entries.read().get(file)
                        && hit.size == size
                        && hit.mtime_ms == mtime
                    {
                        return None;
                    }
                    let fs = FileStat { size, mtime_ms: mtime, birthtime_ms: birthtime, ino: 0 };
                    Some((file.clone(), *cli, fs))
                }
                Err(_) => {
                    self.entries.write().shift_remove(file);
                    None
                }
            }
        });
        let mut changed: Vec<(String, ConvCli, FileStat)> = stats.into_iter().flatten().collect();
        // Newest first: the conversations the user most likely looks for are searchable first.
        timsort::sort_by(&mut changed, |a, b| b.2.mtime_ms - a.2.mtime_ms);
        self.pass.lock().progress = Some((0, changed.len()));
        pool(workers, &changed, READ_CONCURRENCY, |(file, cli, st)| {
            if self.cancelled.load(Ordering::SeqCst) {
                return;
            }
            // Unreadable now: the next pass tries again.
            let _ = self.read_entry(file, *cli, st);
            if let Some(p) = self.pass.lock().progress.as_mut() {
                p.0 += 1;
            }
        });
        self.stats.lock().last_pass_ms = self.now() - started;
        if !self.cancelled.load(Ordering::SeqCst) && self.parses_since_save.load(Ordering::SeqCst) >= SAVE_AFTER_PARSES {
            self.save();
        }
    }

    fn read_entry(&self, file: &str, cli: ConvCli, st: &FileStat) -> std::io::Result<()> {
        let mut fh = fs::File::open(file)?;
        let st = &FileStat { ino: ino_of(&fh), ..*st };
        let hit = self.entries.read().get(file).cloned();
        // A file that only grew keeps what was read; a replaced or shortened one is read again from the start.
        let append =
            hit.as_ref().filter(|h| st.size >= h.size && h.ino == st.ino && h.birthtime_ms == st.birthtime_ms && h.cli == cli);
        let (mut doc, from) = match append {
            Some(h) => ((*h.doc).clone(), h.offset),
            None => (DocState::empty(cli, file), 0),
        };
        let offset = read_into_file(&mut fh, from, &mut doc, INDEX_LIMITS, Some(st.size))?;
        {
            let mut s = self.stats.lock();
            s.bytes_read += offset.saturating_sub(from);
            if append.is_some() {
                s.append_reads += 1;
            } else {
                s.full_reads += 1;
            }
        }
        if append.is_none() {
            self.parses_since_save.fetch_add(1, Ordering::SeqCst);
        }
        finish(&mut doc, st.mtime_ms, st.birthtime_ms);
        let entry = Entry {
            file: file.to_string(),
            cli,
            size: st.size,
            mtime_ms: st.mtime_ms,
            birthtime_ms: st.birthtime_ms,
            ino: st.ino,
            offset,
            doc: Arc::new(doc),
        };
        self.entries.write().insert(file.to_string(), entry);
        Ok(())
    }

    /// The indexed conversations (a conversation copied to a second file counts once: the newest file), taken under a
    /// short read lock: the search runs on this snapshot, so a pass can go on storing what it reads meanwhile.
    fn docs(&self) -> Vec<Arc<DocState>> {
        let entries = self.entries.read();
        let mut by_id: IndexMap<(ConvCli, &str), &Arc<DocState>> = IndexMap::new();
        for e in entries.values() {
            let d = &e.doc;
            if !d.visible {
                continue;
            }
            let key = (d.doc.cli, d.doc.id.as_str());
            match by_id.get_mut(&key) {
                Some(other) if other.doc.updated_at < d.doc.updated_at => *other = d,
                Some(_) => {}
                None => {
                    by_id.insert(key, d);
                }
            }
        }
        by_id.into_values().cloned().collect()
    }

    pub fn search(&self, query: &ConvQuery) -> Value {
        let started = self.now();
        let out = {
            let docs = self.docs();
            search_docs(docs.iter().map(|d| &d.doc), query)
        };
        let mut m = out.into_map();
        m.insert("indexing".into(), self.indexing_json());
        m.insert("tookMs".into(), num(self.now() - started));
        Value::Object(m)
    }

    /// The whole conversation of an indexed file, read again with the larger preview limits.
    pub fn transcript(&self, file: &str) -> Value {
        let Some(cli) = self.cli_of(file) else {
            return json!({"ok": false, "messages": [], "capped": false, "error": "unknown"});
        };
        struct T {
            messages: Vec<Value>,
            total: usize,
            capped: bool,
        }
        impl Sink for T {
            fn message(&mut self, role: ConvRole, text: &str, ts: f64) {
                if self.capped {
                    return;
                }
                let units = utf16(text);
                let cut = units.len() > TRANSCRIPT_LIMITS.message_chars;
                let kept = if cut { &units[..TRANSCRIPT_LIMITS.message_chars] } else { &units[..] };
                if self.total + kept.len() > TRANSCRIPT_LIMITS.doc_chars {
                    self.capped = true;
                    return;
                }
                self.total += kept.len();
                let mut m = Map::new();
                m.insert("role".into(), json!(role.as_str()));
                m.insert("text".into(), json!(super::text::lossy(kept)));
                m.insert("ts".into(), num(ts));
                m.insert("cut".into(), json!(cut));
                self.messages.push(Value::Object(m));
            }
        }
        let mut t = T { messages: Vec::new(), total: 0, capped: false };
        let mut meta = ConvMeta::default();
        let read = fs::File::open(file).map_err(|e| node_error(&e, "open", file)).and_then(|mut fh| {
            parse::read_lines(
                &mut fh as &mut dyn ReadAt,
                0,
                &mut |line| parse::feed_line(cli, &mut meta, line, &mut t),
                parse::MAX_LINE,
                None,
            )
            .map_err(|e| node_error(&e, "read", file))
        });
        match read {
            Ok(_) => json!({"ok": true, "messages": t.messages, "capped": t.capped}),
            Err(error) => json!({"ok": false, "messages": [], "capped": false, "error": error}),
        }
    }

    /// The CLI of an indexed file (None for a file the index does not know: nothing else is read on request).
    pub fn cli_of(&self, file: &str) -> Option<ConvCli> {
        self.entries.read().get(file).map(|e| e.cli)
    }

    /// The newest indexed file of a session, if the index holds it.
    pub fn file_of(&self, cli: ConvCli, id: &str) -> Option<String> {
        let entries = self.entries.read();
        let mut best: Option<&Entry> = None;
        for e in entries.values() {
            if e.cli == cli && e.doc.doc.id == id && best.is_none_or(|b| e.mtime_ms > b.mtime_ms) {
                best = Some(e);
            }
        }
        best.map(|e| e.file.clone())
    }

    /// Test hook.
    pub fn size(&self) -> usize {
        self.entries.read().len()
    }

    /// Test hook: the entries in their order.
    pub fn entries(&self) -> Vec<Entry> {
        self.entries.read().values().cloned().collect()
    }
}
