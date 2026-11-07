//! Cancelling a running statement (`cancel` in src/dbhost/pgSession.ts, `sideConnection` / `cancelRequest` in host.ts):
//! `SELECT pg_cancel_backend($1)` on a side connection to the same server and database (same TLS mode, the password the
//! session logged in with, no questions); when that cannot log in or does not answer `t`, the protocol CancelRequest with
//! the backend's key over a new plain stream (through the tunnel when there is one).

use std::time::Duration;

use tokio::io::AsyncWriteExt;
use zeroize::Zeroizing;

use super::connect::{CANCEL_CONNECT_MS, Connector, PgTarget, connect_tls};
use crate::wire::pg::{BackendKey, cancel_bytes};

/// Asks the server to cancel the statement of the backend `key`; true when a cancel went out (`pg_cancel_backend`
/// answered `t`, or the CancelRequest was delivered).
pub async fn cancel_backend(
    connector: &dyn Connector,
    target: &PgTarget,
    password: Option<&Zeroizing<String>>,
    key: &BackendKey,
) -> bool {
    if let Ok(mut side) = connect_tls(connector, target, password).await {
        let pid = key.process_id.to_string();
        let answer = side.query_value("SELECT pg_cancel_backend($1)", &[Some(pid.as_str())]).await;
        side.end().await;
        if matches!(answer, Ok(Some(ref v)) if v == "t") {
            return true;
        }
    }
    cancel_request(connector, key).await
}

/// The protocol CancelRequest on a fresh stream (no answer comes; the server closes it). 5 s to connect.
pub async fn cancel_request(connector: &dyn Connector, key: &BackendKey) -> bool {
    let send = async {
        let mut stream = connector.open().await.ok()?;
        stream.write_all(&cancel_bytes(key)).await.ok()?;
        let _ = stream.flush().await;
        let _ = stream.shutdown().await;
        Some(())
    };
    matches!(tokio::time::timeout(Duration::from_millis(CANCEL_CONNECT_MS), send).await, Ok(Some(())))
}
