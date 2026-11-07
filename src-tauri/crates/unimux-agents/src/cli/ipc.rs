//! IPC surface of the CLI detection (port of `createCliHandlers` in src/main/cliIpc.ts): validated, allow-listed. The renderer
//! only ever names a CliId; documentation addresses come from [`docs_url`], never from the renderer.

use std::collections::HashMap;
use std::sync::Arc;

use futures::FutureExt;
use futures::future::{BoxFuture, Shared};
use parking_lot::Mutex;
use serde_json::Value;

use super::detector::CliDetector;
use super::status::{CliId, CliStatusMap, docs_url};

/// What a recheck needs of the detector (the detector itself, or a fake in tests).
pub trait RecheckSource: Send + Sync + 'static {
    fn snapshot(&self) -> CliStatusMap;
    fn recheck(&self, cli: Option<CliId>) -> BoxFuture<'static, CliStatusMap>;
}

impl RecheckSource for Arc<CliDetector> {
    fn snapshot(&self) -> CliStatusMap {
        CliDetector::snapshot(self)
    }
    fn recheck(&self, cli: Option<CliId>) -> BoxFuture<'static, CliStatusMap> {
        let d = self.clone();
        async move { d.recheck(cli).await }.boxed()
    }
}

type Running = Shared<BoxFuture<'static, CliStatusMap>>;

pub struct CliHandlers<S: RecheckSource> {
    detector: S,
    open_external: Arc<dyn Fn(&str) + Send + Sync>,
    /// Several "check again" clicks (or focus events) while one check runs share it; key `claude`, `codex` or `*`.
    running: Arc<Mutex<HashMap<&'static str, (u64, Running)>>>,
    next: Mutex<u64>,
}

/// `Unknown CLI.` (the text the renderer sees when a recheck names something else).
pub const UNKNOWN_CLI: &str = "Unknown CLI.";

impl<S: RecheckSource> CliHandlers<S> {
    pub fn new(detector: S, open_external: impl Fn(&str) + Send + Sync + 'static) -> Self {
        Self { detector, open_external: Arc::new(open_external), running: Arc::default(), next: Mutex::new(0) }
    }

    /// `cli:status`: the detector snapshot.
    pub fn status(&self) -> CliStatusMap {
        self.detector.snapshot()
    }

    /// `cli:recheck(id?)`: undefined / null = both; anything else that is not a CliId is refused.
    pub fn recheck(&self, id: &Value) -> Result<Running, &'static str> {
        let cli = if id.is_null() { None } else { Some(CliId::from_value(id).ok_or(UNKNOWN_CLI)?) };
        let key = cli.map(CliId::as_str).unwrap_or("*");
        let mut running = self.running.lock();
        if let Some((_, run)) = running.get(key) {
            return Ok(run.clone());
        }
        let n = {
            let mut next = self.next.lock();
            *next += 1;
            *next
        };
        let table = self.running.clone();
        let inner = self.detector.recheck(cli);
        let run = async move {
            let map = inner.await;
            let mut t = table.lock();
            if t.get(key).is_some_and(|(i, _)| *i == n) {
                t.remove(key);
            }
            map
        }
        .boxed()
        .shared();
        running.insert(key, (n, run.clone()));
        Ok(run)
    }

    /// `cli:openDocs(id)`: opens the allow-listed documentation; false for anything that is not a CliId.
    pub fn open_docs(&self, id: &Value) -> bool {
        let Some(cli) = CliId::from_value(id) else { return false };
        (self.open_external)(docs_url(cli));
        true
    }
}

#[cfg(test)]
mod tests {
    //! test/cli-ipc.test.ts "cli IPC handlers" ported.
    use super::*;
    use crate::cli::status::{CliState, CliStatus};
    use serde_json::json;

    struct FakeDetector {
        map: CliStatusMap,
        calls: Arc<Mutex<Vec<Option<CliId>>>>,
        gate: Arc<tokio::sync::Semaphore>,
        block: bool,
    }

    impl RecheckSource for Arc<FakeDetector> {
        fn snapshot(&self) -> CliStatusMap {
            self.map.clone()
        }
        fn recheck(&self, cli: Option<CliId>) -> BoxFuture<'static, CliStatusMap> {
            self.calls.lock().push(cli);
            let map = self.map.clone();
            let gate = self.gate.clone();
            let block = self.block;
            async move {
                if block {
                    let _ = gate.acquire().await;
                }
                map
            }
            .boxed()
        }
    }

    fn map() -> CliStatusMap {
        [(CliId::Claude, CliStatus::new(CliId::Claude, CliState::Missing, None, 1))].into()
    }

    type Opened = Arc<Mutex<Vec<String>>>;

    fn make(block: bool) -> (Arc<FakeDetector>, Opened, CliHandlers<Arc<FakeDetector>>) {
        let d =
            Arc::new(FakeDetector { map: map(), calls: Arc::default(), gate: Arc::new(tokio::sync::Semaphore::new(0)), block });
        let opened: Arc<Mutex<Vec<String>>> = Arc::default();
        let o = opened.clone();
        let h = CliHandlers::new(d.clone(), move |url: &str| o.lock().push(url.to_string()));
        (d, opened, h)
    }

    #[test]
    fn answers_the_status_from_the_detector_snapshot() {
        let (_, _, h) = make(false);
        assert_eq!(h.status(), map());
    }

    #[tokio::test]
    async fn validates_the_cli_id_of_a_recheck() {
        let (d, _, h) = make(false);
        h.recheck(&Value::Null).unwrap().await;
        h.recheck(&json!("codex")).unwrap().await;
        assert_eq!(*d.calls.lock(), vec![None, Some(CliId::Codex)]);
        for bad in [json!("shell"), json!("claude;calc"), json!(42), json!({}), json!(["claude"])] {
            assert_eq!(h.recheck(&bad).err(), Some(UNKNOWN_CLI), "{bad}");
        }
        assert_eq!(d.calls.lock().len(), 2);
    }

    #[tokio::test]
    async fn shares_a_running_recheck_between_repeated_requests() {
        let (d, _, h) = make(true);
        let a = h.recheck(&json!("claude")).unwrap();
        let b = h.recheck(&json!("claude")).unwrap();
        assert!(a.ptr_eq(&b));
        assert_eq!(d.calls.lock().len(), 1);
        d.gate.add_permits(1);
        assert_eq!(a.await, map());
        assert_eq!(b.await, map());
        // a finished recheck is forgotten: the next one runs again
        let _c = h.recheck(&json!("claude")).unwrap();
        assert_eq!(d.calls.lock().len(), 2);
    }

    #[test]
    fn opens_only_allow_listed_documentation_never_an_address_from_the_renderer() {
        let (_, opened, h) = make(false);
        assert!(h.open_docs(&json!("claude")));
        assert!(h.open_docs(&json!("codex")));
        assert_eq!(*opened.lock(), vec!["https://code.claude.com/docs/en/setup", "https://github.com/openai/codex"]);
        for bad in [json!("https://evil.example"), json!("shell"), Value::Null, json!(7), json!({"toString": "claude"})] {
            assert!(!h.open_docs(&bad), "{bad}");
        }
        assert_eq!(opened.lock().len(), 2);
    }
}
