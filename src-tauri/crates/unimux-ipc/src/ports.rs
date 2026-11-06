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
