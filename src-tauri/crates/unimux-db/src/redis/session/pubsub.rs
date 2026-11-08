//! Pub/Sub of a Redis session (`PubSub` of src/dbhost/redisSession.ts): a lazily opened subscriber connection on DB 0
//! (its own retry: 3 attempts, then `closed`; the names stay and the next subscribe opens a new connection that subscribes
//! all of them again), messages buffered with caps (entries and bytes; what does not fit is counted as dropped) and sent
//! to the renderer over the DB port in batches every `pubsubFlushMs` (`redisPubSub`), every state change as
//! `redisPubSubState`. Channel names are kept as bytes (binary names stay exact; our own resubscribe after a reconnect).
//!
//! Deviation: subscribe / unsubscribe requests run one at a time (1.1.4 could interleave two of them at their awaits).

use std::collections::VecDeque;
use std::sync::{Arc, Weak};
use std::time::Duration;

use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use tokio::task::JoinHandle;

use super::{OpError, OpResult, OpenConnection, RedisLimits, RedisSessionOptions, RedisSessionOut, bool_of, connect_op_error};
use crate::redis::connect::{ClientEvent, RedisClient};
use crate::redis::data::{blob, data_json, from_data};
use crate::wire::redis::{RETRY_DELAYS_MS, Raw};

struct State {
    client: Option<RedisClient>,
    channels: Vec<Vec<u8>>,
    patterns: Vec<Vec<u8>>,
    state: &'static str,
    reconnect: Option<u32>,
    error: Option<String>,
    /// Messages waiting for the renderer, each with the size added to `buffer_bytes`.
    buffer: VecDeque<(Value, usize)>,
    buffer_bytes: usize,
    dropped_since: u64,
    dropped_total: u64,
    timer: Option<JoinHandle<()>>,
    ended: bool,
}

pub(super) struct PubSub {
    me: Weak<PubSub>,
    session_id: String,
    limits: RedisLimits,
    open_connection: OpenConnection,
    out: Arc<dyn RedisSessionOut>,
    now: Arc<dyn Fn() -> i64 + Send + Sync>,
    st: Mutex<State>,
    /// Subscribe / unsubscribe one at a time.
    ops: tokio::sync::Mutex<()>,
}

fn add_names(list: &mut Vec<Vec<u8>>, names: &[Vec<u8>]) {
    for n in names {
        if !list.contains(n) {
            list.push(n.clone());
        }
    }
}

fn names(op: &Value, k: &str) -> Vec<Vec<u8>> {
    op.get(k).and_then(Value::as_array).map(|a| a.iter().map(from_data).collect()).unwrap_or_default()
}

fn command(name: &[u8], args: &[Vec<u8>]) -> Vec<Vec<u8>> {
    let mut a = vec![name.to_vec()];
    a.extend(args.iter().cloned());
    a
}

impl PubSub {
    pub(super) fn new(opts: &RedisSessionOptions, out: Arc<dyn RedisSessionOut>) -> Arc<PubSub> {
        Arc::new_cyclic(|me| PubSub {
            me: me.clone(),
            session_id: opts.session_id.clone(),
            limits: opts.limits.clone(),
            open_connection: opts.open_connection.clone(),
            out,
            now: opts.now.clone(),
            st: Mutex::new(State {
                client: None,
                channels: Vec::new(),
                patterns: Vec::new(),
                state: "idle",
                reconnect: None,
                error: None,
                buffer: VecDeque::new(),
                buffer_bytes: 0,
                dropped_since: 0,
                dropped_total: 0,
                timer: None,
                ended: false,
            }),
            ops: tokio::sync::Mutex::new(()),
        })
    }

    fn snapshot_of(st: &State) -> Value {
        let mut m = Map::new();
        m.insert("state".into(), json!(st.state));
        m.insert("channels".into(), Value::Array(st.channels.iter().map(|c| data_json(c)).collect()));
        m.insert("patterns".into(), Value::Array(st.patterns.iter().map(|c| data_json(c)).collect()));
        m.insert("dropped".into(), json!(st.dropped_total));
        if let Some(r) = st.reconnect.filter(|r| *r > 0) {
            m.insert("reconnect".into(), json!(r));
        }
        if let Some(e) = st.error.as_ref().filter(|e| !e.is_empty()) {
            m.insert("error".into(), json!(e));
        }
        Value::Object(m)
    }

    fn snapshot(&self) -> Value {
        Self::snapshot_of(&self.st.lock())
    }

    /// Reports the state (under the lock: state messages and message batches reach the port in order).
    fn emit_state_locked(&self, st: &State) {
        self.out.port(json!({ "t": "redisPubSubState", "sessionId": self.session_id, "state": Self::snapshot_of(st) }));
    }

    fn is_current(&self, c: &RedisClient) -> bool {
        self.st.lock().client.as_ref().is_some_and(|x| x.id() == c.id())
    }

    /// A message from the subscriber connection.
    fn on_push(&self, v: Raw) {
        let Raw::Array(items) = v else { return };
        let bytes = |r: &Raw| match r {
            Raw::Bytes(b) => b.clone(),
            other => crate::redis::data::as_buffer(other),
        };
        match items.len() {
            3 => self.push(bytes(&items[1]), None, bytes(&items[2])),
            4 => self.push(bytes(&items[2]), Some(bytes(&items[1])), bytes(&items[3])),
            _ => {}
        }
    }

    fn push(&self, channel: Vec<u8>, pattern: Option<Vec<u8>>, message: Vec<u8>) {
        let l = &self.limits;
        let mut st = self.st.lock();
        if st.ended {
            return;
        }
        // One size per entry, added here and taken off when it is sent: the byte cap never drifts.
        let size = message.len().min(l.pubsub_payload_bytes) + channel.len() + pattern.as_ref().map_or(0, Vec::len);
        if st.buffer.len() >= l.pubsub_buffer || st.buffer_bytes + size > l.pubsub_buffer_bytes {
            st.dropped_since += 1;
            st.dropped_total += 1;
        } else {
            let mut m = Map::new();
            m.insert("channel".into(), data_json(&channel));
            if let Some(p) = &pattern {
                m.insert("pattern".into(), data_json(p));
            }
            m.insert("time".into(), json!((self.now)()));
            m.insert("payload".into(), blob(&message, l.pubsub_payload_bytes));
            st.buffer.push_back((Value::Object(m), size));
            st.buffer_bytes += size;
        }
        self.schedule(&mut st);
    }

    fn schedule(&self, st: &mut State) {
        if st.timer.is_some() || st.ended {
            return;
        }
        let weak = self.me.clone();
        let ms = self.limits.pubsub_flush_ms;
        st.timer = Some(tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(ms)).await;
            if let Some(me) = weak.upgrade() {
                me.flush();
            }
        }));
    }

    fn flush(&self) {
        let mut st = self.st.lock();
        st.timer = None;
        if st.ended || (st.buffer.is_empty() && st.dropped_since == 0) {
            return;
        }
        let n = self.limits.pubsub_batch.min(st.buffer.len());
        let sent: Vec<(Value, usize)> = st.buffer.drain(..n).collect();
        for (_, size) in &sent {
            st.buffer_bytes -= size;
        }
        let dropped = std::mem::take(&mut st.dropped_since);
        let messages: Vec<Value> = sent.into_iter().map(|(m, _)| m).collect();
        self.out.port(json!({ "t": "redisPubSub", "sessionId": self.session_id, "messages": messages, "dropped": dropped }));
        if !st.buffer.is_empty() {
            self.schedule(&mut st);
        }
    }

    async fn resubscribe(&self, c: &RedisClient) -> OpResult<()> {
        let (channels, patterns) = {
            let st = self.st.lock();
            (st.channels.clone(), st.patterns.clone())
        };
        if !channels.is_empty() {
            c.call_n(&as_refs(&command(b"subscribe", &channels)), channels.len()).await?;
        }
        if !patterns.is_empty() {
            c.call_n(&as_refs(&command(b"psubscribe", &patterns)), patterns.len()).await?;
        }
        Ok(())
    }

    async fn ensure(&self) -> OpResult<RedisClient> {
        {
            let mut st = self.st.lock();
            if let Some(c) = &st.client {
                return Ok(c.clone());
            }
            st.state = "connecting";
            st.error = None;
            self.emit_state_locked(&st);
        }
        let c = match (self.open_connection)(0).await {
            Ok(c) => c,
            Err(e) => {
                let mut st = self.st.lock();
                st.state = "closed";
                st.error = Some(e.code.to_owned());
                self.emit_state_locked(&st);
                return Err(connect_op_error(&e));
            }
        };
        if self.st.lock().ended {
            c.disconnect(false);
            return Err(OpError::Code("noSession", None));
        }
        let weak = self.me.clone();
        c.set_push(Some(Arc::new(move |v| {
            if let Some(me) = weak.upgrade() {
                me.on_push(v);
            }
        })));
        // the listeners hold the client's id only (the client keeps its listeners: no cycle)
        let weak = self.me.clone();
        let mine = c.id();
        c.on_event(Arc::new(move |ev| {
            let Some(me) = weak.upgrade() else { return };
            match ev {
                ClientEvent::Ready => {
                    let c = {
                        let mut st = me.st.lock();
                        let Some(c) = st.client.clone().filter(|x| x.id() == mine) else { return };
                        if st.reconnect.is_none() {
                            return;
                        }
                        st.reconnect = None;
                        c
                    };
                    // Our own resubscribe keeps binary channel names exact.
                    tokio::spawn(async move {
                        if me.resubscribe(&c).await.is_ok() && me.is_current(&c) {
                            let mut st = me.st.lock();
                            st.state = "ready";
                            me.emit_state_locked(&st);
                        }
                    });
                }
                ClientEvent::End => {
                    let mut st = me.st.lock();
                    let Some(c) = st.client.take_if(|x| x.id() == mine) else { return };
                    // The names stay: the next subscribe opens a new connection and subscribes all of them again.
                    st.state = "closed";
                    st.reconnect = None;
                    st.error = Some(c.last_error().map_or("dbClosed", |e| e.code).to_owned());
                    if !st.ended {
                        me.emit_state_locked(&st);
                    }
                }
            }
        }));
        // A connection opened after an earlier one ended takes over every name still listed.
        if let Err(e) = self.resubscribe(&c).await {
            c.disconnect(false);
            let mut st = self.st.lock();
            st.state = "closed";
            self.emit_state_locked(&st);
            return Err(e);
        }
        let weak = self.me.clone();
        let mine = c.id();
        let attempts = self.limits.reconnect_attempts;
        c.set_retry(Some(Arc::new(move |attempt| {
            let me = weak.upgrade()?;
            let mut st = me.st.lock();
            if st.ended || !st.client.as_ref().is_some_and(|x| x.id() == mine) || attempt > attempts {
                return None;
            }
            st.state = "connecting";
            st.reconnect = Some(attempt);
            me.emit_state_locked(&st);
            Some(RETRY_DELAYS_MS[(attempt as usize - 1).min(RETRY_DELAYS_MS.len() - 1)])
        })));
        let mut st = self.st.lock();
        st.client = Some(c.clone());
        st.state = "ready";
        self.emit_state_locked(&st);
        Ok(c)
    }

    pub(super) async fn handle(&self, kind: &str, op: &Value) -> OpResult<Value> {
        if kind == "pubsubState" {
            return Ok(self.snapshot());
        }
        let _turn = self.ops.lock().await;
        if self.st.lock().ended {
            return Err(OpError::Code("noSession", None));
        }
        if kind == "subscribe" {
            let channels = names(op, "channels");
            let patterns = names(op, "patterns");
            {
                let st = self.st.lock();
                if st.channels.len() + st.patterns.len() + channels.len() + patterns.len() > self.limits.pubsub_channels {
                    return Err(OpError::Code("invalid", None));
                }
                if channels.is_empty() && patterns.is_empty() && st.client.is_some() {
                    return Ok(Self::snapshot_of(&st));
                }
            }
            let c = self.ensure().await?;
            if !channels.is_empty() {
                c.call_n(&as_refs(&command(b"subscribe", &channels)), channels.len()).await?;
            }
            if !patterns.is_empty() {
                c.call_n(&as_refs(&command(b"psubscribe", &patterns)), patterns.len()).await?;
            }
            let mut st = self.st.lock();
            add_names(&mut st.channels, &channels);
            add_names(&mut st.patterns, &patterns);
            self.emit_state_locked(&st);
            return Ok(Self::snapshot_of(&st));
        }
        if kind != "unsubscribe" {
            return Err(OpError::Code("invalid", None));
        }
        let all = bool_of(op, "all");
        let (c, channels, patterns) = {
            let st = self.st.lock();
            let channels = if all { st.channels.clone() } else { names(op, "channels") };
            let patterns = if all { st.patterns.clone() } else { names(op, "patterns") };
            (st.client.clone(), channels, patterns)
        };
        if let Some(c) = &c {
            if !channels.is_empty() {
                c.call_n(&as_refs(&command(b"unsubscribe", &channels)), channels.len()).await?;
            }
            if !patterns.is_empty() {
                c.call_n(&as_refs(&command(b"punsubscribe", &patterns)), patterns.len()).await?;
            }
        }
        let (closing, snapshot) = {
            let mut st = self.st.lock();
            st.channels.retain(|x| !channels.contains(x));
            st.patterns.retain(|x| !patterns.contains(x));
            let mut closing = None;
            if st.channels.is_empty() && st.patterns.is_empty() {
                // Nothing left to listen to: the subscriber connection closes.
                closing = st.client.take();
                st.state = "idle";
                st.reconnect = None;
                st.error = None;
            }
            self.emit_state_locked(&st);
            (closing, Self::snapshot_of(&st))
        };
        if let Some(c) = closing {
            c.set_retry(None);
            c.disconnect(false);
        }
        Ok(snapshot)
    }

    /// The session ended: the subscriber connection closes, nothing more is sent.
    pub(super) fn end(&self) {
        let c = {
            let mut st = self.st.lock();
            st.ended = true;
            if let Some(t) = st.timer.take() {
                t.abort();
            }
            st.buffer.clear();
            st.buffer_bytes = 0;
            st.client.take()
        };
        if let Some(c) = c {
            c.set_retry(None);
            c.disconnect(false);
        }
    }
}

fn as_refs(a: &[Vec<u8>]) -> Vec<&[u8]> {
    a.iter().map(Vec::as_slice).collect()
}
