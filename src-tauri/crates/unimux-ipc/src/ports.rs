//! The three MessagePorts of 1.1.4 (`mc:pty-port`, `mc:sftp-port`, `mc:db-port`) become Tauri channels. The renderer bridge
//! asks to attach (on every page load: a renderer-initiated handshake, never pushed on load); the owning service (P2 for pty,
//! T1 for sftp, D12 for db) registers a [`PortOwner`] here. Until it does, an attach answers not-yet and the bridge posts no
//! port, which is what the renderer saw in 1.1.4 before a host started.

use std::collections::HashMap;
use std::sync::Arc;

use parking_lot::RwLock;
use serde_json::Value;

use crate::error::IpcError;

/// Host -> renderer side of an attached port (a Tauri channel in the app).
pub trait PortSink: Send + Sync {
    fn post_json(&self, message: &Value) -> bool;
    fn post_bytes(&self, bytes: &[u8]) -> bool;
    /// One JSON message already written as text (the DB port, D12: rows are written like `JSON.stringify`, which may hold
    /// a lone `\udXXX` escape that a `serde_json::Value` cannot carry). The default parses it (a lone surrogate fails).
    fn post_json_text(&self, text: String) -> bool {
        serde_json::from_str::<Value>(&text).ok().is_some_and(|v| self.post_json(&v))
    }
    /// One message of binary frames, number `seq` of this attach (the pty data plane, P2). Blocks until the transport took
    /// it (a WebView2 shared buffer posted by the UI thread, a pull answered). Default: [`PortSink::post_bytes`].
    fn post_frames(&self, seq: u64, bytes: Vec<u8>) -> bool {
        let _ = seq;
        self.post_bytes(&bytes)
    }
    /// [`PortSink::post_frames`] with the batcher's hint that the release of this message must not wait (the host is at
    /// its cap); only a transport whose page gets the hint and may otherwise delay the release uses it.
    fn post_frames_hinted(&self, seq: u64, bytes: Vec<u8>, release_now: bool) -> bool {
        let _ = release_now;
        self.post_frames(seq, bytes)
    }
    /// The page answers every frames message with a release ack (`{t:'released', upto}`), so the sender may cap what is
    /// in flight. A pull transport gates itself (one request in flight).
    fn gated(&self) -> bool {
        false
    }
    /// "channel", "sharedBuffer", "pull".
    fn transport(&self) -> &'static str {
        "channel"
    }
    /// The page went away or attached again: a blocked [`PortSink::post_frames`] returns.
    fn close(&self) {}
}

/// The service behind a port.
pub trait PortOwner: Send + Sync {
    /// A window attached (again: a reload replaces its previous sink).
    fn attach(&self, label: &str, sink: Arc<dyn PortSink>);
    /// Renderer -> host message (pty only: write, resize, ack...).
    fn post(&self, label: &str, message: Value);
    fn detach(&self, label: &str);
}

#[derive(Default)]
pub struct Ports {
    owners: RwLock<HashMap<String, Arc<dyn PortOwner>>>,
}

pub const PORT_KINDS: [&str; 3] = ["pty", "sftp", "db"];

impl Ports {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn register(&self, kind: &str, owner: Arc<dyn PortOwner>) {
        assert!(PORT_KINDS.contains(&kind), "unknown port kind {kind}");
        self.owners.write().insert(kind.to_string(), owner);
    }

    fn owner(&self, kind: &str) -> Result<Arc<dyn PortOwner>, IpcError> {
        self.owners.read().get(kind).cloned().ok_or_else(|| IpcError::NotYet { command: format!("port:{kind}") })
    }

    pub fn attach(&self, kind: &str, label: &str, sink: Arc<dyn PortSink>) -> Result<(), IpcError> {
        self.owner(kind)?.attach(label, sink);
        Ok(())
    }

    pub fn post(&self, kind: &str, label: &str, message: Value) -> Result<(), IpcError> {
        self.owner(kind)?.post(label, message);
        Ok(())
    }

    pub fn detach_window(&self, label: &str) {
        for owner in self.owners.read().values() {
            owner.detach(label);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unowned_ports_are_not_yet() {
        struct Nop;
        impl PortSink for Nop {
            fn post_json(&self, _: &Value) -> bool {
                true
            }
            fn post_bytes(&self, _: &[u8]) -> bool {
                true
            }
        }
        let p = Ports::new();
        assert_eq!(p.attach("pty", "main", Arc::new(Nop)).unwrap_err().code(), "MC_NOT_YET");
    }
}
