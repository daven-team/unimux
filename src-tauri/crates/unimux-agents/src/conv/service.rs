//! What replaces 1.1.4's eval'd conversation search worker and its main-side client (src/main/convSearchClient.ts,
//! src/convsearch/worker.ts): the index is created on the first request (its folders and cache file are read then), a request
//! answers within 60 s (the export within 120 s) or with "conversation search timed out", and after 10 minutes without a
//! request the index saves itself (unless a pass runs) and is dropped. The calls block: the app runs them off the async
//! runtime.

use std::path::PathBuf;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use parking_lot::{Condvar, Mutex};
use serde_json::{Map, Value, json};

use super::export::{self, EXPORT_LIMITS, is_session_id};
use super::indexer::{Indexer, IndexerOptions};
use super::search::ConvQuery;
use super::text::slice16;
use super::{ConvCli, Roots};

pub const IDLE: Duration = Duration::from_secs(10 * 60);
pub const TIMEOUT: Duration = Duration::from_secs(60);
pub const EXPORT_TIMEOUT: Duration = Duration::from_secs(120);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(20);

/// What to export: an indexed transcript file (a search result) or the conversation of a cell.
#[derive(Debug, Clone, PartialEq)]
pub enum ExportSource {
    File(String),
    Session { cli: ConvCli, id: String },
}

/// A query as it arrives over IPC, reduced to known fields of the right types (`sanitizeQuery`).
pub fn sanitize_query(raw: &Value) -> ConvQuery {
    let get = |k: &str| raw.as_object().and_then(|o| o.get(k));
    let num = |k: &str| get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
    let mut q = ConvQuery {
        text: get("text").and_then(Value::as_str).map(|t| slice16(t, 400)).unwrap_or_default(),
        ..Default::default()
    };
    if let Some(c) = get("cli").and_then(Value::as_str).filter(|c| *c == "claude" || *c == "codex") {
        q.cli = Some(c.to_string());
    }
    if let Some(r) = get("role").and_then(Value::as_str).filter(|r| *r == "user" || *r == "assistant") {
        q.role = Some(r.to_string());
    }
    if let Some(p) = get("project").and_then(Value::as_str).filter(|p| !p.is_empty()) {
        q.project = Some(slice16(p, 2000));
    }
    q.from = num("from");
    q.to = num("to");
    q.limit = num("limit").map(|l| l.floor().clamp(1.0, 500.0));
    q
}

/// An export request as it arrives over IPC: a file path or a session of a known CLI with a plain id; None for anything else.
pub fn sanitize_export_source(raw: &Value) -> Option<ExportSource> {
    let get = |k: &str| raw.as_object().and_then(|o| o.get(k));
    if let Some(file) = get("file").and_then(Value::as_str).filter(|f| !f.is_empty() && super::text::len16(f) <= 4096) {
        return Some(ExportSource::File(file.to_string()));
    }
    let cli = get("cli").and_then(Value::as_str).and_then(ConvCli::parse)?;
    let id = get("id").and_then(Value::as_str).filter(|id| is_session_id(id))?;
    Some(ExportSource::Session { cli, id: id.to_string() })
}

/// The answer to a refused or failed search.
pub fn search_failed(error: Option<&str>) -> Value {
    let mut m = Map::new();
    m.insert("hits".into(), json!([]));
    m.insert("total".into(), json!(0));
    m.insert("conversations".into(), json!(0));
    m.insert("projects".into(), json!([]));
    m.insert("indexing".into(), Value::Null);
    m.insert("tookMs".into(), json!(0));
    if let Some(e) = error {
        m.insert("error".into(), json!(e));
    }
    Value::Object(m)
}

pub fn transcript_failed(error: Option<&str>) -> Value {
    match error {
        Some(e) => json!({"ok": false, "messages": [], "capped": false, "error": e}),
        None => json!({"ok": false, "messages": [], "capped": false}),
    }
}

/// `noExport` of main (a request that is not a valid source).
pub fn no_export() -> Value {
    json!({"ok": false, "cli": "claude", "id": "", "title": "", "cwd": "", "startedAt": 0, "updatedAt": 0, "items": [], "capped": false})
}

/// A 1.1.1 export of `source` with an index that knows `ix`'s files (`exportOf` of the worker).
pub fn export_of(ix: &Indexer, source: &ExportSource) -> Value {
    let (file, cli) = match source {
        ExportSource::File(file) => match ix.cli_of(file) {
            Some(cli) => (file.clone(), cli),
            None => return export::failed("unknown", ConvCli::Claude),
        },
        ExportSource::Session { cli, id } => {
            match ix.file_of(*cli, id).or_else(|| export::locate_session(*cli, id, ix.roots())) {
                Some(file) => (file, *cli),
                None => return export::failed("not-found", *cli),
            }
        }
    };
    export::read_export(&file, cli, EXPORT_LIMITS).unwrap_or_else(|e| export::failed(&e, cli))
}

struct Idle {
    deadline: Mutex<Option<Instant>>,
    wake: Condvar,
}

/// The conversation search of the app.
pub struct ConvSearchService {
    options: Box<dyn Fn() -> IndexerOptions + Send + Sync>,
    current: Mutex<Option<Arc<Indexer>>>,
    idle: Arc<Idle>,
    idle_after: Duration,
    watcher: Mutex<bool>,
}

impl ConvSearchService {
    /// The service of the app: the CLI folders from the environment at the first request, the index in
    /// `<data dir>/conversation-index-v2.bin`.
    pub fn for_data_dir(data_dir: PathBuf) -> Arc<Self> {
        Self::new(move || IndexerOptions::new(Roots::from_env(), Some(data_dir.join("conversation-index-v2.bin"))), IDLE)
    }

    pub fn new(options: impl Fn() -> IndexerOptions + Send + Sync + 'static, idle_after: Duration) -> Arc<Self> {
        Arc::new(Self {
            options: Box::new(options),
            current: Mutex::new(None),
            idle: Arc::new(Idle { deadline: Mutex::new(None), wake: Condvar::new() }),
            idle_after,
            watcher: Mutex::new(false),
        })
    }

    fn start(self: &Arc<Self>) -> Arc<Indexer> {
        let mut cur = self.current.lock();
        if let Some(ix) = cur.as_ref() {
            return ix.clone();
        }
        let ix = Arc::new(Indexer::new((self.options)()));
        *cur = Some(ix.clone());
        ix
    }

    /// Whether the index lives (tests).
    pub fn running(&self) -> bool {
        self.current.lock().is_some()
    }

    fn arm_idle(self: &Arc<Self>) {
        *self.idle.deadline.lock() = Some(Instant::now() + self.idle_after);
        self.idle.wake.notify_all();
        let mut started = self.watcher.lock();
        if *started {
            return;
        }
        *started = true;
        let weak = Arc::downgrade(self);
        let idle = self.idle.clone();
        let _ = std::thread::Builder::new().name("conv-idle".into()).spawn(move || {
            loop {
                let mut deadline = idle.deadline.lock();
                match *deadline {
                    None => {
                        // Nothing armed: check now and then whether the service is gone.
                        idle.wake.wait_for(&mut deadline, Duration::from_secs(60));
                    }
                    Some(at) if Instant::now() < at => {
                        idle.wake.wait_until(&mut deadline, at);
                    }
                    Some(_) => {
                        *deadline = None;
                        drop(deadline);
                        match weak.upgrade() {
                            Some(svc) => svc.stop(),
                            None => return,
                        }
                    }
                }
                if weak.strong_count() == 0 {
                    return;
                }
            }
        });
    }

    /// Runs `work` on the index within `timeout`.
    fn call(
        self: &Arc<Self>,
        timeout: Duration,
        work: impl FnOnce(&Arc<Indexer>) -> Value + Send + 'static,
    ) -> Result<Value, String> {
        let ix = self.start();
        self.arm_idle();
        let (tx, rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("conv-request".into())
            .spawn(move || {
                let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(&ix)));
                let _ = tx.send(r.map_err(|p| {
                    p.downcast_ref::<String>()
                        .cloned()
                        .or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string()))
                        .unwrap_or_default()
                }));
            })
            .map_err(|e| e.to_string())?;
        match rx.recv_timeout(timeout) {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(panic)) => Err(format!("conversation search failed: {panic}")),
            Err(mpsc::RecvTimeoutError::Timeout) => Err("conversation search timed out".into()),
            Err(mpsc::RecvTimeoutError::Disconnected) => Err("conversation search thread ended".into()),
        }
    }

    /// conv:search (the query already sanitized). The first search waits for nothing: it answers from what is indexed and
    /// says that a pass is running.
    pub fn search(self: &Arc<Self>, query: ConvQuery) -> Value {
        self.call(TIMEOUT, move |ix| {
            ix.load();
            ix.start_refresh(false);
            ix.search(&query)
        })
        .unwrap_or_else(|e| search_failed(Some(&e)))
    }

    /// conv:transcript.
    pub fn transcript(self: &Arc<Self>, file: String) -> Value {
        self.call(TIMEOUT, move |ix| {
            ix.load();
            ix.transcript(&file)
        })
        .unwrap_or_else(|e| transcript_failed(Some(&e)))
    }

    /// conv:export (1.1.1): a whole conversation for the Markdown export.
    pub fn export_data(self: &Arc<Self>, source: ExportSource) -> Value {
        self.call(EXPORT_TIMEOUT, move |ix| {
            ix.load();
            export_of(ix, &source)
        })
        .unwrap_or_else(|e| {
            json!({"ok": false, "error": e, "cli": "claude", "id": "", "title": "", "cwd": "", "startedAt": 0, "updatedAt": 0, "items": [], "capped": false})
        })
    }

    /// Lets the index save itself (unless a pass runs), then drops it. Called after 10 idle minutes and when the app quits.
    pub fn stop(&self) {
        // The lock is held until the save ended (at most 20 s): a request in the meantime waits and then starts an index that
        // loads the saved file, and `running()` turns false only once the file is written.
        let mut current = self.current.lock();
        let Some(ix) = current.as_ref().cloned() else { return };
        ix.cancel();
        let (tx, rx) = mpsc::channel();
        let saver = ix.clone();
        let spawned = std::thread::Builder::new().name("conv-save".into()).spawn(move || {
            if saver.dirty() && saver.indexing().is_none() {
                saver.save();
            }
            let _ = tx.send(());
        });
        if spawned.is_ok() {
            let _ = rx.recv_timeout(SHUTDOWN_TIMEOUT);
        }
        *current = None;
    }
}
