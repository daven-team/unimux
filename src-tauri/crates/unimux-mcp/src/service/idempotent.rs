//! automation.ts `idempotent`: a retried team call (same agent, operation and arguments) must not start a second team. While
//! the first one runs, the retry shares it (the work is cancelled only when every caller left); when a caller left before the
//! answer, the finished result is returned to an identical call within IDEMPOTENT_MS. A call whose answer was received is
//! never replayed. The work runs as its own task, so a caller that goes away never cuts a grid creation in half (its
//! rollback runs either way).

use std::sync::Arc;

use futures::FutureExt;
use futures::future::Shared;
use parking_lot::Mutex;
use serde_json::Value;
use tokio_util::sync::CancellationToken;

use super::{AutomationService, IDEMPOTENT_MS};
use crate::automation::OpError;
use crate::tools::BoxFuture;

type Answer = Shared<BoxFuture<'static, Result<Value, OpError>>>;

pub(super) struct Entry {
    at: i64,
    cancel: CancellationToken,
    callers: usize,
    running: bool,
    abandoned: bool,
    result: Answer,
}

pub(super) type EntryRef = Arc<Mutex<Entry>>;

fn leave(entry: &EntryRef) {
    let mut e = entry.lock();
    if !e.running {
        return;
    }
    e.abandoned = true;
    e.callers = e.callers.saturating_sub(1);
    if e.callers == 0 {
        e.cancel.cancel();
    }
}

impl AutomationService {
    pub(super) async fn idempotent(
        self: &Arc<Self>,
        op: &str,
        args: &Value,
        actor: Option<&str>,
        signal: Option<CancellationToken>,
        work: impl FnOnce(CancellationToken) -> BoxFuture<'static, Result<Value, OpError>>,
    ) -> Result<Value, OpError> {
        let now = self.now();
        let key = actor.map(|a| format!("{a}\0{op}\0{}", serde_json::to_string(args).unwrap_or_default()));
        let entry = {
            let mut book = self.book.lock();
            book.recent.retain(|_, e| now - e.lock().at <= IDEMPOTENT_MS);
            let reusable = key.as_ref().and_then(|k| book.recent.get(k)).filter(|e| {
                let e = e.lock();
                !(e.running && e.cancel.is_cancelled())
            });
            match reusable {
                Some(e) => e.clone(),
                None => {
                    let token = CancellationToken::new();
                    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Value, OpError>>();
                    let answer: Answer = async move {
                        rx.await.unwrap_or_else(|_| Err(OpError::message("The operation ended before it answered.")))
                    }
                    .boxed()
                    .shared();
                    let entry = Arc::new(Mutex::new(Entry {
                        at: now,
                        cancel: token.clone(),
                        callers: 0,
                        running: true,
                        abandoned: false,
                        result: answer,
                    }));
                    if let Some(k) = &key {
                        book.recent.insert(k.clone(), entry.clone());
                    }
                    let job = work(token);
                    let (weak, e, k) = (Arc::downgrade(self), entry.clone(), key.clone());
                    (self.spawn)(Box::pin(async move {
                        let result = job.await;
                        let abandoned = {
                            let mut ent = e.lock();
                            ent.running = false;
                            ent.abandoned
                        };
                        // A finished call is remembered only when a caller left before its answer (a client that timed out
                        // and retries); a failed one never.
                        if let (Some(service), Some(k)) = (weak.upgrade(), k) {
                            let mut book = service.book.lock();
                            if book.recent.get(&k).is_some_and(|x| Arc::ptr_eq(x, &e)) && (!abandoned || result.is_err()) {
                                book.recent.remove(&k);
                            }
                        }
                        let _ = tx.send(result);
                    }));
                    entry
                }
            }
        };
        let (running, answer) = {
            let e = entry.lock();
            (e.running, e.result.clone())
        };
        if running {
            entry.lock().callers += 1;
            match signal {
                // A caller without a signal never leaves.
                None => entry.lock().callers += 1,
                Some(s) if s.is_cancelled() => leave(&entry),
                Some(s) => {
                    let (e, done) = (entry.clone(), answer.clone());
                    (self.spawn)(Box::pin(async move {
                        tokio::select! {
                            _ = s.cancelled() => leave(&e),
                            _ = done => {}
                        }
                    }));
                }
            }
        }
        answer.await
    }
}
