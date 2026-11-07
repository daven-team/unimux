//! The context tracker of src/main/contextUsage.ts: nothing polls; a hook or notify of the cell (a tool call, a turn end, a
//! compaction) asks for a refresh, which reads only what the transcript gained since the last read. The first read of a
//! conversation goes backwards from the end of the file until it finds a usage line, so a long transcript is never read whole.
//!
//! Timers and the single-flight refresh run on a tokio runtime (the app's); the file reads run on its blocking pool.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::Duration;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use tokio::runtime::Handle;
use tokio::task::JoinHandle;

use super::usage::{ContextCli, ContextScan, ContextUsage, context_usage, same_usage, scan_lines};
use crate::conv::text::{js_less, to_lower_str};
use crate::fsstat::{self, read_at};
use crate::sessions::claude_project_dir_name;

/// What the tracker needs to know about a cell; None when it has no agent conversation (shell, SSH, no session yet).
#[derive(Debug, Clone, PartialEq)]
pub struct ContextTarget {
    pub cli: ContextCli,
    pub session_id: String,
    pub cwd: String,
    /// The cell's model setting (a `[1m]` suffix asks for the long window).
    pub model_hint: Option<String>,
}

pub trait ContextTrackerDeps: Send + Sync + 'static {
    fn target(&self, cell: &str) -> Option<ContextTarget>;
    /// The usage of a cell changed (None: no longer known).
    fn emit(&self, cell: &str, usage: Option<&ContextUsage>);
    /// Claude's config folder (CLAUDE_CONFIG_DIR or ~/.claude).
    fn claude_dir(&self) -> PathBuf;
    /// Codex's home (CODEX_HOME or ~/.codex).
    fn codex_home(&self) -> PathBuf;
}

/// The first backward read; it doubles until a usage line is found.
pub const FIRST_CHUNK: usize = 256 * 1024;
/// Lines can be long (a tool call with a whole file): a chunk without a line end grows up to this.
pub const MAX_CHUNK: usize = 16 * 1024 * 1024;
/// The backward read gives up after this much of a file without any usage line.
pub const MAX_BACKWARD: u64 = 64 * 1024 * 1024;
/// A file that grew by more than this since the last read is read backwards again instead of forwards.
pub const MAX_FORWARD: u64 = 8 * 1024 * 1024;
/// Hooks come in bursts (every tool call): one refresh per cell at most this often.
pub const THROTTLE: Duration = Duration::from_millis(800);
/// A turn end: the last message may land in the file just after the hook, so the file is read once more a bit later.
pub const SETTLE: Duration = Duration::from_millis(2500);
const MAX_CODEX_FILES: usize = 5000;

#[derive(Debug, Clone)]
struct Entry {
    key: String,
    file: PathBuf,
    /// Byte offset of the first line not read yet (always at a line start).
    offset: u64,
    ino: u64,
    birthtime_ms: f64,
    scan: ContextScan,
}

/// The newest model named at or after the usage line, with the scan of the first chunk that set the tokens.
pub struct Backward {
    pub scan: ContextScan,
    pub offset: u64,
}

/// `scanBackwards(fh, size, cli)`: reads the file backwards from `size` in growing chunks of whole lines until one of them
/// sets the tokens. Returns that state and the offset just after the last complete line of the file (a line being written
/// stays for the next read).
pub fn scan_backwards(f: &File, size: u64, cli: ContextCli) -> std::io::Result<Backward> {
    let mut end = size;
    let mut want = FIRST_CHUNK;
    let mut offset: Option<u64> = None;
    // The newest model named at or after the usage line (Codex names it once per turn, in the turn context).
    let mut model: Option<String> = None;
    let mut found: Option<ContextScan> = None;
    while end > 0 && size - end < MAX_BACKWARD {
        let start = end.saturating_sub(want as u64);
        let buf = read_at(f, start, (end - start) as usize)?;
        let mut from = 0;
        if start > 0 {
            match memchr::memchr(b'\n', &buf) {
                None => {
                    // one line longer than the chunk
                    if want >= MAX_CHUNK {
                        break;
                    }
                    want *= 2;
                    continue;
                }
                Some(nl) => from = nl + 1,
            }
        }
        let mut to = buf.len();
        if offset.is_none() {
            to = match memchr::memrchr(b'\n', &buf) {
                Some(last) if last >= from => last + 1,
                _ => from,
            };
            offset = Some(start + to as u64);
        }
        let text = String::from_utf8_lossy(&buf[from..to.max(from)]);
        let scan = scan_lines(cli, &ContextScan::default(), &text);
        if model.is_none() {
            model = scan.model.clone();
        }
        if found.is_none() && scan.seen {
            found = Some(scan);
        }
        // Claude names the model on the usage line itself; a Codex usage line may need an earlier turn context for it.
        if found.is_some() && (model.is_some() || cli == ContextCli::Claude) {
            break;
        }
        // A complete line of MAX_CHUNK or more: the chunk ends with its line end and holds no other, so the read cannot move
        // back. 1.1.4 read that same chunk forever (a hang); here the read stops with what it found, as for an unfinished
        // line that long. A shorter chunk doubles, as in 1.1.4.
        if start + (from as u64) == end && want >= MAX_CHUNK {
            break;
        }
        end = start + from as u64;
        want = (want * 2).min(MAX_CHUNK);
    }
    let mut scan = found.unwrap_or_default();
    if model.is_some() {
        scan.model = model;
    }
    Ok(Backward { scan, offset: offset.unwrap_or(0) })
}

/// `findCodexRollout(root, id)`: the rollout file of a Codex thread, sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl,
/// searched newest first (names in descending order; at most 5000 files looked at).
pub fn find_codex_rollout(root: &Path, id: &str) -> Option<PathBuf> {
    let suffix = format!("-{}.jsonl", to_lower_str(id));
    let mut seen = 0usize;
    fn walk(dir: &Path, suffix: &str, seen: &mut usize) -> Option<PathBuf> {
        let Ok(read) = std::fs::read_dir(dir) else { return None };
        let mut items: Vec<(String, bool, bool)> = read
            .filter_map(Result::ok)
            .map(|e| {
                let kind = e.file_type().ok();
                (
                    e.file_name().to_string_lossy().into_owned(),
                    kind.is_some_and(|k| k.is_file()),
                    kind.is_some_and(|k| k.is_dir()),
                )
            })
            .collect();
        items.sort_by(|a, b| {
            if js_less(&a.0, &b.0) {
                std::cmp::Ordering::Greater
            } else if js_less(&b.0, &a.0) {
                std::cmp::Ordering::Less
            } else {
                std::cmp::Ordering::Equal
            }
        });
        for (name, is_file, _) in &items {
            if *is_file && to_lower_str(name).ends_with(suffix) {
                return Some(dir.join(name));
            }
            if *is_file {
                *seen += 1;
                if *seen > MAX_CODEX_FILES {
                    return None;
                }
            }
        }
        for (name, _, is_dir) in &items {
            if !is_dir {
                continue;
            }
            let hit = walk(&dir.join(name), suffix, seen);
            if hit.is_some() || *seen > MAX_CODEX_FILES {
                return hit;
            }
        }
        None
    }
    walk(root, &suffix, &mut seen)
}

/// `isAbsolute(path)` of Node's path module for this OS.
fn is_absolute(path: &str) -> bool {
    if cfg!(windows) {
        let b = path.as_bytes();
        let sep = |c: u8| c == b'/' || c == b'\\';
        b.first().is_some_and(|&c| sep(c)) || (b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && sep(b[2]))
    } else {
        path.starts_with('/')
    }
}

/// `basename(path)` of Node's path module for this OS (trailing separators ignored; on Windows after a drive's colon too).
fn basename(path: &str) -> &str {
    let sep = |c: char| c == '/' || (cfg!(windows) && c == '\\');
    let mut p = path;
    if cfg!(windows) {
        let b = p.as_bytes();
        if b.len() >= 2 && b[0].is_ascii_alphabetic() && b[1] == b':' {
            p = &p[2..];
        }
    }
    let trimmed = p.trim_end_matches(sep);
    match trimmed.rfind(sep) {
        Some(i) => &trimmed[i + 1..],
        None => trimmed,
    }
}

fn is_file(path: &Path) -> bool {
    fsstat::stat(path).is_ok_and(|st| st.is_file)
}

type Run = Shared<BoxFuture<'static, Option<ContextUsage>>>;

#[derive(Default)]
struct Inner {
    entries: HashMap<String, Entry>,
    timers: HashMap<String, JoinHandle<()>>,
    settle: HashMap<String, JoinHandle<()>>,
    running: HashMap<String, Run>,
    again: HashSet<String>,
    shown: HashMap<String, Option<ContextUsage>>,
    /// Transcript paths the hooks reported, by session id (Claude writes them where its config folder is, per account).
    transcripts: HashMap<String, PathBuf>,
    codex_files: HashMap<String, PathBuf>,
}

pub struct ContextTracker {
    deps: Box<dyn ContextTrackerDeps>,
    rt: Handle,
    inner: Mutex<Inner>,
    /// How many files were opened for a read (the tests' `reads`).
    pub reads: AtomicUsize,
}

impl ContextTracker {
    pub fn new(deps: impl ContextTrackerDeps, rt: Handle) -> Arc<Self> {
        Arc::new(Self { deps: Box::new(deps), rt, inner: Mutex::new(Inner::default()), reads: AtomicUsize::new(0) })
    }

    pub fn reads(&self) -> usize {
        self.reads.load(Ordering::SeqCst)
    }

    /// A Claude hook payload named the session's transcript. Accepted only as `<session id>.jsonl` at an absolute path.
    pub fn note_transcript(&self, session_id: &str, path: &str) {
        if !is_absolute(path) || to_lower_str(basename(path)) != format!("{}.jsonl", to_lower_str(session_id)) {
            return;
        }
        self.inner.lock().transcripts.insert(to_lower_str(session_id), PathBuf::from(path));
    }

    /// The current usage of a cell (read now).
    pub fn get(self: &Arc<Self>, cell: &str) -> impl Future<Output = Option<ContextUsage>> + Send + 'static {
        self.refresh(cell)
    }

    /// Something happened in the cell: read its file soon (throttled). `turn_end` reads once more after the file settled.
    pub fn poke(self: &Arc<Self>, cell: &str, turn_end: bool) {
        let mut inner = self.inner.lock();
        if !inner.timers.contains_key(cell) {
            let me = Arc::downgrade(self);
            let id = cell.to_string();
            let task = self.rt.spawn(async move {
                tokio::time::sleep(THROTTLE).await;
                if let Some(me) = me.upgrade() {
                    me.inner.lock().timers.remove(&id);
                    drop(me.refresh(&id));
                }
            });
            inner.timers.insert(cell.to_string(), task);
        }
        if turn_end {
            if let Some(old) = inner.settle.remove(cell) {
                old.abort();
            }
            let me = Arc::downgrade(self);
            let id = cell.to_string();
            let task = self.rt.spawn(async move {
                tokio::time::sleep(SETTLE).await;
                if let Some(me) = me.upgrade() {
                    me.inner.lock().settle.remove(&id);
                    drop(me.refresh(&id));
                }
            });
            inner.settle.insert(cell.to_string(), task);
        }
    }

    pub fn forget(&self, cell: &str) {
        let mut inner = self.inner.lock();
        if let Some(t) = inner.timers.remove(cell) {
            t.abort();
        }
        if let Some(t) = inner.settle.remove(cell) {
            t.abort();
        }
        inner.entries.remove(cell);
        inner.shown.remove(cell);
    }

    /// The last usage sent for a cell (automation's list_agents).
    pub fn current(&self, cell: &str) -> Option<ContextUsage> {
        self.inner.lock().shown.get(cell).cloned().flatten()
    }

    /// Single flight per cell: a refresh asked while one runs gets the running one's answer and makes it run once more.
    fn refresh(self: &Arc<Self>, cell: &str) -> Run {
        let mut inner = self.inner.lock();
        if let Some(busy) = inner.running.get(cell).cloned() {
            inner.again.insert(cell.to_string());
            return busy;
        }
        let (tx, rx) = futures::channel::oneshot::channel::<Option<ContextUsage>>();
        let run: Run = rx.map(|r| r.unwrap_or(None)).boxed().shared();
        inner.running.insert(cell.to_string(), run.clone());
        drop(inner);
        let me = self.clone();
        let id = cell.to_string();
        self.rt.spawn(async move {
            let reader = me.clone();
            let rid = id.clone();
            let usage = tokio::task::spawn_blocking(move || reader.read(&rid).ok().flatten()).await.ok().flatten();
            let (changed, again) = {
                let mut inner = me.inner.lock();
                inner.running.remove(&id);
                let changed = !same_usage(inner.shown.get(&id).and_then(Option::as_ref), usage.as_ref());
                if changed {
                    inner.shown.insert(id.clone(), usage.clone());
                }
                (changed, inner.again.remove(&id))
            };
            if changed {
                me.deps.emit(&id, usage.as_ref());
            }
            if again {
                drop(me.refresh(&id));
            }
            let _ = tx.send(usage);
        });
        run
    }

    /// The blocking read of one cell's file (errors answer None, as the TS `.catch(() => null)`).
    fn read(&self, cell: &str) -> std::io::Result<Option<ContextUsage>> {
        let Some(target) = self.deps.target(cell) else {
            self.inner.lock().entries.remove(cell);
            return Ok(None);
        };
        let id = to_lower_str(&target.session_id);
        let key = format!("{}:{id}", target.cli.as_str());
        let mut entry = self.inner.lock().entries.get(cell).cloned().filter(|e| e.key == key);
        let file = match &entry {
            Some(e) => Some(e.file.clone()),
            None => self.locate(&target),
        };
        let Some(file) = file else {
            self.inner.lock().entries.remove(cell);
            return Ok(None);
        };
        let st = match fsstat::stat(&file) {
            Ok(st) => st,
            Err(_) => {
                let mut inner = self.inner.lock();
                inner.entries.remove(cell);
                if target.cli == ContextCli::Codex {
                    inner.codex_files.remove(&id);
                }
                return Ok(None);
            }
        };
        let hint = target.model_hint.as_deref();
        // A replaced or truncated file is read again from its end.
        if entry.as_ref().is_some_and(|e| st.size < e.offset || st.ino != e.ino || st.birthtime_ms != e.birthtime_ms) {
            entry = None;
        }
        if let Some(e) = &entry
            && st.size == e.offset
        {
            return Ok(context_usage(target.cli, &e.scan, hint));
        }
        let f = File::open(&file)?;
        self.reads.fetch_add(1, Ordering::SeqCst);
        let entry = match entry {
            Some(mut e) if st.size - e.offset <= MAX_FORWARD => {
                let buf = read_at(&f, e.offset, (st.size - e.offset) as usize)?;
                if let Some(last) = memchr::memrchr(b'\n', &buf) {
                    e.scan = scan_lines(target.cli, &e.scan, &String::from_utf8_lossy(&buf[..=last]));
                    e.offset += last as u64 + 1;
                }
                e
            }
            old => {
                let Backward { mut scan, offset } = scan_backwards(&f, st.size, target.cli)?;
                // Codex names its model in the turn context, which may sit before the usage line the backward read stopped at.
                if scan.model.is_none()
                    && let Some(model) = old.and_then(|o| o.scan.model)
                {
                    scan.model = Some(model);
                }
                Entry { key, file, offset, ino: st.ino, birthtime_ms: st.birthtime_ms, scan }
            }
        };
        drop(f);
        let usage = context_usage(target.cli, &entry.scan, hint);
        self.inner.lock().entries.insert(cell.to_string(), entry);
        Ok(usage)
    }

    fn locate(&self, target: &ContextTarget) -> Option<PathBuf> {
        let id = to_lower_str(&target.session_id);
        match target.cli {
            ContextCli::Claude => {
                if let Some(reported) = self.inner.lock().transcripts.get(&id) {
                    return Some(reported.clone());
                }
                let projects = self.deps.claude_dir().join("projects");
                let name = format!("{}.jsonl", target.session_id);
                let direct = projects.join(claude_project_dir_name(&target.cwd)).join(&name);
                if is_file(&direct) {
                    return Some(direct);
                }
                // Long paths are shortened (with a hash) by newer versions: look for the session in every project folder.
                let dirs = std::fs::read_dir(&projects).ok()?;
                dirs.filter_map(Result::ok).map(|d| projects.join(d.file_name()).join(&name)).find(|c| is_file(c))
            }
            ContextCli::Codex => {
                if let Some(cached) = self.inner.lock().codex_files.get(&id) {
                    return Some(cached.clone());
                }
                let found = find_codex_rollout(&self.deps.codex_home().join("sessions"), &id)?;
                self.inner.lock().codex_files.insert(id, found.clone());
                Some(found)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    //! The ContextTracker cases of test/context-usage.test.ts.
    use super::*;
    use crate::context::usage::tests::{
        CODEX_ID, SESSION, claude_assistant, claude_user, codex_meta, compact_boundary, jsonl, token_count, turn_context, usage,
    };
    use std::fs;
    use std::io::Write;

    type Emitted = Arc<Mutex<Vec<(String, Option<f64>)>>>;

    #[derive(Clone)]
    struct Deps {
        targets: HashMap<String, ContextTarget>,
        emitted: Emitted,
        dir: PathBuf,
    }

    impl ContextTrackerDeps for Deps {
        fn target(&self, cell: &str) -> Option<ContextTarget> {
            self.targets.get(cell).cloned()
        }
        fn emit(&self, cell: &str, usage: Option<&ContextUsage>) {
            self.emitted.lock().push((cell.to_string(), usage.map(|u| u.tokens)));
        }
        fn claude_dir(&self) -> PathBuf {
            self.dir.join(".claude")
        }
        fn codex_home(&self) -> PathBuf {
            self.dir.join(".codex")
        }
    }

    fn target(cli: ContextCli, session: &str, cwd: &str) -> ContextTarget {
        ContextTarget { cli, session_id: session.into(), cwd: cwd.into(), model_hint: None }
    }

    fn setup(dir: &Path, targets: &[(&str, ContextTarget)]) -> (Arc<ContextTracker>, Emitted) {
        let emitted = Arc::new(Mutex::new(Vec::new()));
        let deps = Deps {
            targets: targets.iter().map(|(k, v)| (k.to_string(), v.clone())).collect(),
            emitted: emitted.clone(),
            dir: dir.to_path_buf(),
        };
        (ContextTracker::new(deps, Handle::current()), emitted)
    }

    fn tokens(u: Option<ContextUsage>) -> Option<f64> {
        u.map(|u| u.tokens)
    }

    #[tokio::test]
    async fn reads_a_claude_transcript_from_the_project_folder_and_then_only_what_was_appended() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = "D:\\Projekty\\demo";
        let (tracker, emitted) = setup(dir.path(), &[("c1", target(ContextCli::Claude, SESSION, cwd))]);
        let folder = dir.path().join(".claude").join("projects").join(claude_project_dir_name(cwd));
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join(format!("{SESSION}.jsonl"));
        fs::write(&file, jsonl(&[claude_user("hi"), claude_assistant(usage(10, 2000, 30_000, 500), None, false)])).unwrap();
        assert_eq!(tokens(tracker.get("c1").await), Some(32_510.0));
        // A line still being written is not read yet.
        let mut f = fs::OpenOptions::new().append(true).open(&file).unwrap();
        f.write_all(serde_json::to_string(&claude_assistant(usage(4, 1200, 62_808, 300), None, false)).unwrap().as_bytes())
            .unwrap();
        assert_eq!(tokens(tracker.get("c1").await), Some(32_510.0));
        f.write_all(b"\n").unwrap();
        assert_eq!(tokens(tracker.get("c1").await), Some(64_312.0));
        assert_eq!(tracker.reads(), 3);
        tracker.get("c1").await; // unchanged size: no read
        assert_eq!(tracker.reads(), 3);
        assert_eq!(*emitted.lock(), vec![("c1".into(), Some(32_510.0)), ("c1".into(), Some(64_312.0))]);
    }

    #[tokio::test]
    async fn prefers_the_transcript_path_a_hook_reported() {
        let dir = tempfile::tempdir().unwrap();
        let (tracker, _) = setup(dir.path(), &[("c1", target(ContextCli::Claude, SESSION, "D:\\nowhere"))]);
        let elsewhere = dir.path().join("account-2").join("projects").join("x");
        fs::create_dir_all(&elsewhere).unwrap();
        fs::write(elsewhere.join(format!("{SESSION}.jsonl")), jsonl(&[claude_assistant(usage(1, 0, 99, 0), None, false)]))
            .unwrap();
        assert_eq!(tracker.get("c1").await, None);
        tracker.note_transcript(SESSION, &elsewhere.join(format!("{SESSION}.jsonl")).to_string_lossy());
        tracker.note_transcript(SESSION, &elsewhere.join("other.jsonl").to_string_lossy()); // refused
        tracker.note_transcript(SESSION, &format!("relative\\{SESSION}.jsonl")); // refused
        assert_eq!(tokens(tracker.get("c1").await), Some(100.0));
    }

    #[tokio::test]
    async fn finds_a_codex_rollout_by_its_thread_id() {
        let dir = tempfile::tempdir().unwrap();
        let (tracker, _) =
            setup(dir.path(), &[("x1", target(ContextCli::Codex, &CODEX_ID.to_uppercase(), "D:\\Projekty\\demo"))]);
        let day = dir.path().join(".codex").join("sessions").join("2026").join("10").join("14");
        fs::create_dir_all(&day).unwrap();
        fs::write(day.join("rollout-2026-10-14T01-00-00-01a10000-0000-7000-8000-000000000000.jsonl"), jsonl(&[codex_meta()]))
            .unwrap();
        let file = day.join(format!("rollout-2026-10-14T01-27-36-{CODEX_ID}.jsonl"));
        fs::write(&file, jsonl(&[codex_meta(), turn_context("gpt-6.1-sol"), token_count(47_500, Some(475_000))])).unwrap();
        assert_eq!(find_codex_rollout(&dir.path().join(".codex").join("sessions"), CODEX_ID), Some(file));
        let u = tracker.get("x1").await.unwrap();
        assert_eq!((u.percent, u.model.as_deref()), (10.0, Some("gpt-6.1-sol")));
    }

    #[test]
    fn reads_a_long_file_backwards_only_until_it_finds_a_usage_line() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("long.jsonl");
        let filler = format!("{}\n", serde_json::to_string(&claude_user(&"x".repeat(2000))).unwrap());
        let text = jsonl(&[claude_assistant(usage(1, 0, 10, 0), None, false)])
            + &filler.repeat(400)
            + &jsonl(&[claude_assistant(usage(1, 0, 20_000, 0), None, false), compact_boundary(Some(5000))])
            + &filler.repeat(400)
            + "{\"partial\":";
        fs::write(&file, &text).unwrap();
        let f = File::open(&file).unwrap();
        let size = f.metadata().unwrap().len();
        let back = scan_backwards(&f, size, ContextCli::Claude).unwrap();
        assert_eq!(back.scan.tokens, Some(5000.0));
        assert_eq!(back.offset, size - "{\"partial\":".len() as u64);
    }

    /// A complete line of MAX_CHUNK or more: 1.1.4 read the same chunk forever; the read stops with nothing found and the
    /// offset at the end of the file. A shorter long line is still read past.
    #[test]
    fn a_complete_line_longer_than_max_chunk_stops_the_backward_read() {
        let dir = tempfile::tempdir().unwrap();
        let usage_line = jsonl(&[claude_assistant(usage(1, 0, 61, 0), None, false)]);
        for (width, expected) in [(MAX_CHUNK + 10, None), (MAX_CHUNK - 1024, Some(62.0))] {
            let file = dir.path().join(format!("long-{width}.jsonl"));
            let text = format!("{usage_line}{}\n", "x".repeat(width));
            fs::write(&file, &text).unwrap();
            let f = File::open(&file).unwrap();
            let back = scan_backwards(&f, text.len() as u64, ContextCli::Claude).unwrap();
            assert_eq!(back.scan.tokens, expected, "line of {width}");
            assert_eq!(back.offset, text.len() as u64);
        }
    }

    /// A file that grew by up to MAX_FORWARD is read forwards from the last offset; one that grew by more is read backwards
    /// from its end again. The usage line at the start is rewritten in place (same length, same file), which only a
    /// backward read sees.
    #[tokio::test]
    async fn a_file_that_grew_by_more_than_max_forward_is_read_backwards_again() {
        for (grown, expected) in [(MAX_FORWARD, 11.0), (MAX_FORWARD + 1, 23.0)] {
            let dir = tempfile::tempdir().unwrap();
            let cwd = "D:\\Projekty\\demo";
            let (tracker, _) = setup(dir.path(), &[("c1", target(ContextCli::Claude, SESSION, cwd))]);
            let folder = dir.path().join(".claude").join("projects").join(claude_project_dir_name(cwd));
            fs::create_dir_all(&folder).unwrap();
            let file = folder.join(format!("{SESSION}.jsonl"));
            let first = jsonl(&[claude_assistant(usage(1, 0, 10, 0), None, false)]);
            fs::write(&file, &first).unwrap();
            assert_eq!(tokens(tracker.get("c1").await), Some(11.0));
            let rewritten = jsonl(&[claude_assistant(usage(1, 0, 22, 0), None, false)]);
            assert_eq!(rewritten.len(), first.len());
            let mut f = fs::OpenOptions::new().write(true).open(&file).unwrap();
            f.write_all(rewritten.as_bytes()).unwrap();
            drop(f);
            // `grown` bytes of whole lines without usage: 1 KiB lines, then one shorter line for the rest.
            let line = format!("{}\n", "x".repeat(1023));
            let mut filler = line.repeat((grown / 1024) as usize);
            let rest = (grown % 1024) as usize;
            if rest > 0 {
                filler.push_str(&format!("{}\n", "x".repeat(rest - 1)));
            }
            assert_eq!(filler.len() as u64, grown);
            fs::OpenOptions::new().append(true).open(&file).unwrap().write_all(filler.as_bytes()).unwrap();
            assert_eq!(tokens(tracker.get("c1").await), Some(expected), "grown by {grown}");
            assert_eq!(tracker.reads(), 2);
            // Then forwards again from the new end.
            fs::OpenOptions::new()
                .append(true)
                .open(&file)
                .unwrap()
                .write_all(jsonl(&[claude_assistant(usage(1, 0, 40, 0), None, false)]).as_bytes())
                .unwrap();
            assert_eq!(tokens(tracker.get("c1").await), Some(41.0));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn throttles_hook_bursts_into_one_read() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = "D:\\Projekty\\demo";
        let (tracker, emitted) = setup(dir.path(), &[("c1", target(ContextCli::Claude, SESSION, cwd))]);
        let folder = dir.path().join(".claude").join("projects").join(claude_project_dir_name(cwd));
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join(format!("{SESSION}.jsonl")), jsonl(&[claude_assistant(usage(1, 0, 10, 0), None, false)])).unwrap();
        for _ in 0..20 {
            tracker.poke("c1", false);
        }
        tokio::time::sleep(Duration::from_millis(1000)).await;
        wait_until(|| !emitted.lock().is_empty()).await;
        assert_eq!(tracker.reads(), 1);
        assert_eq!(*emitted.lock(), vec![("c1".into(), Some(11.0))]);
    }

    /// Lets the blocking read finish (it runs on real threads while the clock is paused).
    async fn wait_until(done: impl Fn() -> bool) {
        for _ in 0..500 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(1)).await;
            std::thread::sleep(Duration::from_millis(2));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_turn_end_reads_once_more_after_the_file_settled_and_forget_stops_the_timers() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = "D:\\Projekty\\demo";
        let (tracker, emitted) = setup(dir.path(), &[("c1", target(ContextCli::Claude, SESSION, cwd))]);
        let folder = dir.path().join(".claude").join("projects").join(claude_project_dir_name(cwd));
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join(format!("{SESSION}.jsonl"));
        fs::write(&file, jsonl(&[claude_assistant(usage(1, 0, 10, 0), None, false)])).unwrap();
        tracker.poke("c1", true);
        tokio::time::sleep(Duration::from_millis(900)).await;
        wait_until(|| emitted.lock().len() == 1).await;
        // The last message lands after the hook: the settle read picks it up.
        fs::OpenOptions::new()
            .append(true)
            .open(&file)
            .unwrap()
            .write_all(jsonl(&[claude_assistant(usage(1, 0, 20, 0), None, false)]).as_bytes())
            .unwrap();
        tokio::time::sleep(Duration::from_millis(1700)).await;
        wait_until(|| emitted.lock().len() == 2).await;
        assert_eq!(*emitted.lock(), vec![("c1".into(), Some(11.0)), ("c1".into(), Some(21.0))]);
        assert_eq!(tracker.current("c1").map(|u| u.tokens), Some(21.0));
        // Forgotten: no timer fires, nothing is kept.
        tracker.poke("c1", true);
        tracker.forget("c1");
        tokio::time::sleep(Duration::from_millis(3000)).await;
        std::thread::sleep(Duration::from_millis(50));
        assert_eq!(emitted.lock().len(), 2);
        assert_eq!(tracker.current("c1"), None);
    }

    #[tokio::test]
    async fn a_replaced_or_truncated_file_is_read_again_from_its_end_and_a_lost_target_emits_null() {
        let dir = tempfile::tempdir().unwrap();
        let cwd = "D:\\Projekty\\demo";
        let (tracker, emitted) = setup(dir.path(), &[("c1", target(ContextCli::Claude, SESSION, cwd))]);
        let folder = dir.path().join(".claude").join("projects").join(claude_project_dir_name(cwd));
        fs::create_dir_all(&folder).unwrap();
        let file = folder.join(format!("{SESSION}.jsonl"));
        fs::write(&file, jsonl(&[claude_assistant(usage(1, 0, 10, 0), None, false), claude_user("padding padding")])).unwrap();
        assert_eq!(tokens(tracker.get("c1").await), Some(11.0));
        // Shorter: read from the end again (the old scan would still say 11).
        fs::write(&file, jsonl(&[claude_assistant(usage(1, 0, 4, 0), None, false)])).unwrap();
        assert_eq!(tokens(tracker.get("c1").await), Some(5.0));
        // Gone: unknown.
        fs::remove_file(&file).unwrap();
        assert_eq!(tracker.get("c1").await, None);
        assert_eq!(emitted.lock().last().cloned(), Some(("c1".into(), None)));
        let (none, _) = setup(dir.path(), &[]);
        assert_eq!(none.get("zz").await, None);
    }

    #[test]
    fn transcript_paths_are_checked_like_node_paths() {
        assert_eq!(basename("C:\\a\\b.jsonl"), "b.jsonl");
        assert_eq!(basename("/a/b.jsonl/"), "b.jsonl");
        if cfg!(windows) {
            assert!(is_absolute("C:\\x") && is_absolute("\\\\srv\\x") && is_absolute("/x") && !is_absolute("C:x"));
            assert_eq!(basename("C:b.jsonl"), "b.jsonl");
        } else {
            assert!(is_absolute("/x") && !is_absolute("C:\\x"));
        }
    }
}
