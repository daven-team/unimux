//! Channel -> handler. Built once at startup from every domain's `register()`, then shared read-only.

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::Arc;

use futures::future::BoxFuture;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::contract::{ChannelKind, Contract};
use crate::error::IpcError;
use crate::guard::{Caller, Guard, is_open};

/// One call: who made it and its positional arguments (as `ipcRenderer.invoke(channel, ...args)` passed them).
#[derive(Debug, Clone)]
pub struct Call {
    pub command: String,
    pub caller: Caller,
    pub args: Vec<Value>,
    /// The raw body of `mc_invoke_raw` (a Uint8Array argument such as notes:image:save), if any.
    pub body: Option<Vec<u8>>,
}

static NULL: Value = Value::Null;

impl Call {
    pub fn new(command: &str, caller: Caller, args: Vec<Value>) -> Self {
        Self { command: command.to_string(), caller, args, body: None }
    }
    /// Argument `i` (`undefined` / missing reads as null).
    pub fn arg(&self, i: usize) -> &Value {
        self.args.get(i).unwrap_or(&NULL)
    }
    /// Argument `i` deserialized; a wrong shape is `MC_BAD_ARGS`.
    pub fn arg_as<T: DeserializeOwned>(&self, i: usize) -> Result<T, IpcError> {
        serde_json::from_value(self.arg(i).clone())
            .map_err(|e| IpcError::BadArgs { command: self.command.clone(), message: format!("argument {i}: {e}") })
    }
    pub fn fail(&self, message: impl Into<String>) -> IpcError {
        IpcError::failed(&self.command, message)
    }
}

/// What a handler answers: JSON, raw bytes (a Uint8Array in JS), or JSON with byte parts inside (`{ data: Uint8Array }`,
/// placeholders from [`crate::binary::part`]). Both binary forms travel as one raw response without base64
/// ([`crate::binary`]).
#[derive(Debug, Clone, PartialEq)]
pub enum Reply {
    Json(Value),
    Bytes(Vec<u8>),
    Binary { value: Value, parts: Vec<Vec<u8>> },
}

impl Reply {
    /// The raw response body of a binary reply; a JSON reply comes back as `Err(value)`.
    pub fn raw_body(self) -> Result<Vec<u8>, Value> {
        match self {
            Reply::Json(v) => Err(v),
            Reply::Bytes(b) => Ok(crate::binary::encode(&crate::binary::part(0), &[b])),
            Reply::Binary { value, parts } => Ok(crate::binary::encode(&value, &parts)),
        }
    }
}

impl From<Value> for Reply {
    fn from(v: Value) -> Self {
        Reply::Json(v)
    }
}

type InvokeFn = Arc<dyn Fn(Call) -> BoxFuture<'static, Result<Reply, IpcError>> + Send + Sync>;
type SendFn = Arc<dyn Fn(Call) -> BoxFuture<'static, ()> + Send + Sync>;

/// How far a channel is implemented (`npm run ipc:report`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Implemented,
    /// A fixed placeholder answer so the real UI boots before the owning package lands (counts as not implemented).
    Fallback,
    NotYet,
}

/// Collects handlers; every registration is checked against the contract (a typo or a kind mismatch panics at startup and in
/// the contract test, never silently at runtime).
pub struct RouterBuilder {
    contract: &'static Contract,
    invokes: HashMap<String, InvokeFn>,
    sends: HashMap<String, SendFn>,
    fallbacks: HashMap<String, Value>,
    errors: Vec<String>,
}

impl RouterBuilder {
    pub fn new(contract: &'static Contract) -> Self {
        Self { contract, invokes: HashMap::new(), sends: HashMap::new(), fallbacks: HashMap::new(), errors: Vec::new() }
    }

    fn check(&mut self, channel: &str, kind: ChannelKind) -> bool {
        match self.contract.channel(channel) {
            None => {
                self.errors.push(format!("{channel}: not in the contract (src-tauri/gen/ipc-contract.json)"));
                false
            }
            Some(info) if info.kind != kind => {
                self.errors.push(format!("{channel}: registered as {kind:?}, the contract says {:?}", info.kind));
                false
            }
            Some(_) if self.invokes.contains_key(channel) || self.sends.contains_key(channel) => {
                self.errors.push(format!("{channel}: registered twice"));
                false
            }
            Some(_) => true,
        }
    }

    /// An `invoke` channel answering JSON.
    pub fn invoke<F, Fut>(&mut self, channel: &str, handler: F) -> &mut Self
    where
        F: Fn(Call) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Value, IpcError>> + Send + 'static,
    {
        if self.check(channel, ChannelKind::Invoke) {
            let h = Arc::new(handler);
            self.invokes.insert(
                channel.to_string(),
                Arc::new(move |call| {
                    let h = h.clone();
                    Box::pin(async move { h(call).await.map(Reply::Json) })
                }),
            );
            self.fallbacks.remove(channel);
        }
        self
    }

    /// An `invoke` channel that may answer raw bytes.
    pub fn invoke_reply<F, Fut>(&mut self, channel: &str, handler: F) -> &mut Self
    where
        F: Fn(Call) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = Result<Reply, IpcError>> + Send + 'static,
    {
        if self.check(channel, ChannelKind::Invoke) {
            let h = Arc::new(handler);
            self.invokes.insert(channel.to_string(), Arc::new(move |call| Box::pin(h(call))));
            self.fallbacks.remove(channel);
        }
        self
    }

    /// A `send` channel (fire-and-forget; runs in order per window).
    pub fn send<F, Fut>(&mut self, channel: &str, handler: F) -> &mut Self
    where
        F: Fn(Call) -> Fut + Send + Sync + 'static,
        Fut: Future<Output = ()> + Send + 'static,
    {
        if self.check(channel, ChannelKind::Send) {
            let h = Arc::new(handler);
            self.sends.insert(channel.to_string(), Arc::new(move |call| Box::pin(h(call))));
        }
        self
    }

    /// A placeholder answer for a boot-critical invoke channel whose package has not landed yet. Ignored when a real handler
    /// is (or later gets) registered.
    pub fn fallback(&mut self, channel: &str, value: Value) -> &mut Self {
        match self.contract.channel(channel) {
            Some(info) if info.kind == ChannelKind::Invoke => {
                if !self.invokes.contains_key(channel) {
                    self.fallbacks.insert(channel.to_string(), value);
                }
            }
            _ => self.errors.push(format!("{channel}: a fallback needs an invoke channel of the contract")),
        }
        self
    }

    /// Registration problems (empty when every channel matched the contract).
    pub fn errors(&self) -> &[String] {
        &self.errors
    }

    pub fn build(self, guard: Arc<dyn Guard>) -> Router {
        Router {
            contract: self.contract,
            invokes: self.invokes,
            sends: self.sends,
            fallbacks: self.fallbacks,
            guard,
            errors: self.errors,
        }
    }
}

/// The built router (shared, read-only).
pub struct Router {
    contract: &'static Contract,
    invokes: HashMap<String, InvokeFn>,
    sends: HashMap<String, SendFn>,
    fallbacks: HashMap<String, Value>,
    guard: Arc<dyn Guard>,
    errors: Vec<String>,
}

impl Router {
    pub fn contract(&self) -> &'static Contract {
        self.contract
    }

    pub fn errors(&self) -> &[String] {
        &self.errors
    }

    /// The guard and contract check shared by both kinds.
    fn admit(&self, command: &str, kind: ChannelKind, caller: &Caller) -> Result<(), IpcError> {
        match self.contract.channel(command) {
            Some(info) if info.kind == kind => {}
            _ => return Err(IpcError::Unknown { command: command.to_string() }),
        }
        if !is_open(command) && !self.guard.allowed(caller) {
            return Err(IpcError::Refused { command: command.to_string() });
        }
        Ok(())
    }

    /// Runs an invoke channel.
    pub async fn invoke(&self, call: Call) -> Result<Reply, IpcError> {
        self.admit(&call.command, ChannelKind::Invoke, &call.caller)?;
        if let Some(h) = self.invokes.get(&call.command) {
            return h(call).await;
        }
        if let Some(v) = self.fallbacks.get(&call.command) {
            return Ok(Reply::Json(v.clone()));
        }
        Err(IpcError::NotYet { command: call.command })
    }

    /// Checks a send before it is queued: refused, unknown and not-yet sends are answered at once (the bridge logs a not-yet
    /// send once); an admitted send is then run by [`Router::run_send`] in the window's order.
    pub fn admit_send(&self, command: &str, caller: &Caller) -> Result<(), IpcError> {
        self.admit(command, ChannelKind::Send, caller)?;
        if self.sends.contains_key(command) { Ok(()) } else { Err(IpcError::NotYet { command: command.to_string() }) }
    }

    /// Runs an admitted send.
    pub async fn run_send(&self, call: Call) {
        if let Some(h) = self.sends.get(&call.command) {
            h(call).await;
        }
    }

    pub fn status(&self, channel: &str) -> Status {
        if self.invokes.contains_key(channel) || self.sends.contains_key(channel) {
            Status::Implemented
        } else if self.fallbacks.contains_key(channel) {
            Status::Fallback
        } else {
            Status::NotYet
        }
    }

    /// Every contract channel with its status (the `--ipc-routes` output read by `npm run ipc:report`).
    pub fn report(&self) -> BTreeMap<String, Status> {
        self.contract.channels.keys().map(|c| (c.clone(), self.status(c))).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::guard::WindowGuard;
    use serde_json::json;

    fn guard() -> Arc<dyn Guard> {
        Arc::new(WindowGuard::new(vec!["http://tauri.localhost".into()]))
    }
    fn main() -> Caller {
        Caller::new("main", "http://tauri.localhost/index.html")
    }

    #[tokio::test]
    async fn dispatches_with_positional_arguments() {
        let mut b = RouterBuilder::new(Contract::embedded());
        b.invoke(
            "git:status",
            |call| async move { Ok(json!({"project": call.arg(0), "req": call.arg(1), "missing": call.arg(5)})) },
        );
        let r = b.build(guard());
        let reply = r.invoke(Call::new("git:status", main(), vec![json!("p1"), json!({"a": 1})])).await.unwrap();
        assert_eq!(reply, Reply::Json(json!({"project": "p1", "req": {"a": 1}, "missing": null})));
    }

    #[tokio::test]
    async fn a_contract_channel_without_handler_is_not_yet() {
        let r = RouterBuilder::new(Contract::embedded()).build(guard());
        let e = r.invoke(Call::new("db:connect", main(), vec![])).await.unwrap_err();
        assert_eq!(e, IpcError::NotYet { command: "db:connect".into() });
        assert_eq!(serde_json::to_value(&e).unwrap()["code"], "MC_NOT_YET");
        assert_eq!(r.admit_send("cell:kill", &main()).unwrap_err().code(), "MC_NOT_YET");
    }

    #[tokio::test]
    async fn unknown_channels_and_wrong_kinds_are_refused() {
        let r = RouterBuilder::new(Contract::embedded()).build(guard());
        assert_eq!(r.invoke(Call::new("nope:x", main(), vec![])).await.unwrap_err().code(), "MC_UNKNOWN");
        // cell:kill is a send channel.
        assert_eq!(r.invoke(Call::new("cell:kill", main(), vec![])).await.unwrap_err().code(), "MC_UNKNOWN");
        assert_eq!(r.admit_send("state:edit", &main()).unwrap_err().code(), "MC_UNKNOWN");
    }

    #[tokio::test]
    async fn the_guard_runs_for_every_guarded_command_and_never_for_open_ones() {
        let mut b = RouterBuilder::new(Contract::embedded());
        b.invoke("state:edit", |_| async { Ok(json!("edited")) });
        b.invoke("state:snapshot", |_| async { Ok(json!("snap")) });
        b.send("cell:kill", |_| async {});
        let r = b.build(guard());
        let gate = Caller::new("update-gate", "http://tauri.localhost/update-splash/index.html");
        let foreign = Caller::new("main", "https://example.com/");
        for caller in [&gate, &foreign] {
            assert_eq!(r.invoke(Call::new("state:edit", caller.clone(), vec![])).await.unwrap_err().code(), "MC_REFUSED");
            assert_eq!(r.admit_send("cell:kill", caller).unwrap_err().code(), "MC_REFUSED");
            // An open (read-only) command answers any caller that reached the router.
            assert_eq!(r.invoke(Call::new("state:snapshot", caller.clone(), vec![])).await.unwrap(), Reply::Json(json!("snap")));
        }
        assert!(r.admit_send("cell:kill", &main()).is_ok());
        // A not-yet guarded command is refused before it would say not-yet: the guard comes first.
        assert_eq!(r.invoke(Call::new("db:connect", gate.clone(), vec![])).await.unwrap_err().code(), "MC_REFUSED");
    }

    /// test/ipc-guard.test.ts: a foreign send never reaches its handler; the app window's one does.
    #[tokio::test]
    async fn ignores_a_foreign_send_and_delivers_the_app_windows_one() {
        let got = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let mut b = RouterBuilder::new(Contract::embedded());
        let g = got.clone();
        b.send("cell:kill", move |call| {
            let g = g.clone();
            async move { g.lock().push(call.arg(0).clone()) }
        });
        let r = b.build(guard());
        // What the bridge does with a send: admit it, and run it only when admitted.
        let deliver = |caller: Caller, id: &str| {
            let call = Call::new("cell:kill", caller.clone(), vec![json!(id)]);
            let admitted = r.admit_send("cell:kill", &caller).is_ok();
            let r = &r;
            async move {
                if admitted {
                    r.run_send(call).await;
                }
            }
        };
        deliver(Caller::new("main", "https://example.com/"), "cell-1").await;
        assert!(got.lock().is_empty());
        deliver(main(), "cell-2").await;
        assert_eq!(*got.lock(), vec![json!("cell-2")]);
    }

    #[test]
    fn registrations_are_checked_against_the_contract() {
        let mut b = RouterBuilder::new(Contract::embedded());
        b.invoke("no:such", |_| async { Ok(Value::Null) });
        b.invoke("cell:kill", |_| async { Ok(Value::Null) });
        b.send("state:edit", |_| async {});
        b.invoke("state:edit", |_| async { Ok(Value::Null) });
        b.invoke("state:edit", |_| async { Ok(Value::Null) });
        b.fallback("cell:kill", Value::Null);
        assert_eq!(b.errors().len(), 5, "{:?}", b.errors());
    }

    #[tokio::test]
    async fn fallbacks_answer_but_count_as_not_implemented() {
        let mut b = RouterBuilder::new(Contract::embedded());
        b.fallback("cell:alive", json!([]));
        b.invoke("state:snapshot", |_| async { Ok(json!(1)) });
        let r = b.build(guard());
        assert_eq!(r.invoke(Call::new("cell:alive", main(), vec![])).await.unwrap(), Reply::Json(json!([])));
        assert_eq!(r.status("cell:alive"), Status::Fallback);
        assert_eq!(r.status("state:snapshot"), Status::Implemented);
        assert_eq!(r.status("db:connect"), Status::NotYet);
        assert_eq!(r.report().len(), 221);
    }
}
