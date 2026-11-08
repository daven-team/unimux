//! The backend of the SFTP host (T2 part): the SFTP client on a session's stream ([`attach_stream`], 1.1.4 `attach` with
//! ssh2's `client.sftp()` handshake under the SFTP timer), the local side shared by every queue, and the remote operations
//! of the view on the [`RemoteSide`]: `list` (at most `SFTP_LIMITS.listEntries`, link targets looked up 16 at a time),
//! `stat`, `realpath`, `mkdir`, `rename` (1.1.4 `SftpHost.op` / `list` / `entryAt` / `linkTarget`).
//!
//! What T3-T5 add plugs in here: the queues (enqueue / cancel / answerConflict / retry / clearFinished, `end_queue`,
//! `items`, `reset`), the manage ops and editor files (deleteCount / delete / chmodCount / chmod / cancelOp / readFile /
//! statFile / writeFile) and SFTP through sudo (`start_sudo`, which can reuse [`attach_stream`] on the exec channel). Until
//! then they answer like `UnportedBackend`.

use std::any::Any;
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use futures::stream::{self, StreamExt};
use parking_lot::Mutex;
use serde_json::{Map, Value, json};
use unimux_ssh::session::SshErrorCode;

use crate::client::SftpClient;
use crate::error::{SftpErrorCode, SftpResult};
use crate::host::{HostChannels, RemoteSession, SftpBackend, SftpStream, SudoStart};
use crate::limits::{LIST_ENTRIES, SftpTimers, posix_normalize, valid_remote_path};
use crate::local::LocalSide;
use crate::op::SftpOp;
use crate::remote::{RemoteSide, remote_entry};
use crate::sides::{EntryKind, FileSide, SideError};

/// Link targets looked up at the same time in one listing.
const LINK_LOOKUPS: usize = 16;

/// The connected SFTP client of one session.
pub struct SftpSession {
    side: Arc<RemoteSide>,
    /// What else ends with the session (T5: the sudo exec channel).
    on_kill: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl SftpSession {
    pub fn new(side: Arc<RemoteSide>) -> Arc<SftpSession> {
        Arc::new(SftpSession { side, on_kill: Mutex::new(None) })
    }

    /// With something to stop when the session ends.
    pub fn with_on_kill(side: Arc<RemoteSide>, on_kill: impl FnOnce() + Send + 'static) -> Arc<SftpSession> {
        Arc::new(SftpSession { side, on_kill: Mutex::new(Some(Box::new(on_kill))) })
    }

    pub fn side(&self) -> &Arc<RemoteSide> {
        &self.side
    }
}

impl RemoteSession for SftpSession {
    fn closed(&self) -> BoxFuture<'static, ()> {
        Box::pin(self.side.client().closed())
    }
    fn kill(&self) {
        self.side.kill();
        if let Some(f) = self.on_kill.lock().take() {
            f();
        }
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// The remote side of a connected session (None for another backend's session).
pub fn remote_side(remote: &Arc<dyn RemoteSession>) -> Option<Arc<RemoteSide>> {
    remote.as_any().downcast_ref::<SftpSession>().map(|s| s.side.clone())
}

/// The SFTP handshake on `stream` within `timers.sftp` (`timeout`); a stream that does not speak SFTP: `sftpDenied`.
pub async fn attach_stream(stream: SftpStream, timers: SftpTimers) -> Result<Arc<SftpSession>, SshErrorCode> {
    match tokio::time::timeout(timers.sftp, SftpClient::start(stream)).await {
        Err(_) => Err(SshErrorCode::Timeout),
        Ok(Err(_)) => Err(SshErrorCode::SftpDenied),
        Ok(Ok(client)) => Ok(SftpSession::new(Arc::new(RemoteSide::new(client)))),
    }
}

fn code(e: SideError) -> SftpErrorCode {
    e.code
}

/// `linkTarget`: what a symlink points to ('other' when broken or unknown).
pub async fn link_target(side: &RemoteSide, path: &str) -> &'static str {
    match side.stat(path).await {
        Ok(Some(m)) if m.kind == EntryKind::File => "file",
        Ok(Some(m)) if m.kind == EntryKind::Dir => "dir",
        _ => "other",
    }
}

/// `list`: the folder's entries (at most [`LIST_ENTRIES`], `truncated` when there were more), link targets resolved.
pub async fn list(side: &RemoteSide, path: &str) -> SftpResult {
    let dir = posix_normalize(path);
    if !valid_remote_path(&dir) {
        return Err(SftpErrorCode::Invalid);
    }
    let raw = side.readdir_raw(&dir, Some(LIST_ENTRIES)).await.map_err(code)?;
    let truncated = raw.len() > LIST_ENTRIES;
    let mut entries: Vec<Map<String, Value>> = raw.iter().take(LIST_ENTRIES).map(|e| remote_entry(&dir, e)).collect();
    let links: Vec<(usize, String)> = entries
        .iter()
        .enumerate()
        .filter(|(_, e)| e.get("kind").and_then(Value::as_str) == Some("symlink"))
        .map(|(i, e)| (i, e.get("path").and_then(Value::as_str).unwrap_or_default().to_string()))
        .collect();
    let targets: Vec<(usize, &'static str)> = stream::iter(links)
        .map(|(i, p)| async move { (i, link_target(side, &p).await) })
        .buffer_unordered(LINK_LOOKUPS)
        .collect()
        .await;
    for (i, t) in targets {
        entries[i].insert("target".into(), json!(t));
    }
    Ok(json!({ "path": dir, "entries": entries, "truncated": truncated }))
}

/// `entryAt`: one entry as the listing would show it (`stat`).
pub async fn entry_at(side: &RemoteSide, path: &str, kind: EntryKind) -> Result<Map<String, Value>, SftpErrorCode> {
    let (parent, name) = if path == "/" {
        ("/".to_string(), "/".to_string())
    } else {
        let cut = path.rfind('/').unwrap_or(0);
        let parent = if cut == 0 { "/".to_string() } else { path[..cut].to_string() };
        (parent, path[cut + 1..].to_string())
    };
    let raw = if name == "/" {
        None
    } else {
        side.readdir_raw(&parent, None).await.unwrap_or_default().into_iter().find(|e| e.filename == name)
    };
    let lst = side.lstat(path).await.map_err(code)?;
    let mut entry = match raw {
        Some(raw) => remote_entry(&parent, &raw),
        None => {
            let mut m = Map::new();
            m.insert("name".into(), json!(name));
            m.insert("path".into(), json!(path));
            m.insert("kind".into(), json!(lst.map(|l| l.kind).unwrap_or(EntryKind::Other).as_str()));
            m.insert("size".into(), json!(lst.map(|l| l.size).unwrap_or(0)));
            m.insert("mtime".into(), json!(lst.map(|l| l.mtime).unwrap_or(0)));
            m.insert("permissions".into(), json!(""));
            m
        }
    };
    if kind == EntryKind::Symlink {
        entry.insert("target".into(), json!(link_target(side, path).await));
    }
    Ok(entry)
}

/// The remote operations of the view T2 answers (None: not one of them).
pub async fn remote_op(side: &RemoteSide, op: &SftpOp) -> Option<SftpResult> {
    Some(match op {
        SftpOp::List { path } => list(side, path).await,
        SftpOp::Stat { path } => {
            let path = posix_normalize(path);
            match side.lstat(&path).await {
                Err(e) => Err(e.code),
                Ok(None) => Err(SftpErrorCode::NotFound),
                Ok(Some(meta)) => entry_at(side, &path, meta.kind).await.map(Value::Object),
            }
        }
        SftpOp::Realpath { path } => side.resolve_path(path).await.map(Value::String).map_err(code),
        SftpOp::Mkdir { path } => side.mkdir(&posix_normalize(path)).await.map(|()| Value::Null).map_err(code),
        SftpOp::Rename { from, to } => {
            side.rename(&posix_normalize(from), &posix_normalize(to), false).await.map(|()| Value::Null).map_err(code)
        }
        _ => return None,
    })
}

/// The backend with T2's parts (the SFTP client, the local side, the view's remote operations).
pub struct SidesBackend {
    local: Arc<LocalSide>,
    timers: SftpTimers,
    #[allow(dead_code)]
    channels: HostChannels,
}

impl SidesBackend {
    pub fn new(channels: HostChannels, timers: SftpTimers) -> Arc<SidesBackend> {
        Arc::new(SidesBackend { local: Arc::new(LocalSide::default()), timers, channels })
    }

    /// The local disk (one for every queue).
    pub fn local(&self) -> &Arc<LocalSide> {
        &self.local
    }
}

impl SftpBackend for SidesBackend {
    fn attach(&self, _id: &str, stream: SftpStream) -> BoxFuture<'static, Result<Arc<dyn RemoteSession>, SshErrorCode>> {
        let timers = self.timers;
        Box::pin(async move { attach_stream(stream, timers).await.map(|s| s as Arc<dyn RemoteSession>) })
    }

    fn start_sudo(&self, start: SudoStart) -> BoxFuture<'static, Result<Arc<dyn RemoteSession>, SshErrorCode>> {
        // T5: the SFTP server through sudo on exec channels (crate::sudo).
        Box::pin(crate::sudo::start_sudo(start))
    }

    fn op(&self, _id: &str, remote: Option<Arc<dyn RemoteSession>>, _sudo: bool, op: SftpOp) -> BoxFuture<'static, SftpResult> {
        Box::pin(async move {
            match &op {
                // T3 (queues) and T4 (cancelOp).
                SftpOp::Cancel { .. } | SftpOp::AnswerConflict { .. } | SftpOp::Retry { .. } | SftpOp::CancelOp { .. } => {
                    return Ok(json!(false));
                }
                SftpOp::ClearFinished => return Ok(json!(0)),
                SftpOp::Enqueue { .. } => return Err(SftpErrorCode::Unsupported),
                _ => {}
            }
            let remote = remote.ok_or(SftpErrorCode::NotConnected)?;
            let side = remote_side(&remote).ok_or(SftpErrorCode::Unsupported)?;
            match remote_op(&side, &op).await {
                Some(r) => r,
                // T4: deleteCount, delete, chmodCount, chmod, readFile, statFile, writeFile.
                None => Err(SftpErrorCode::Unsupported),
            }
        })
    }

    fn end_queue(&self, _id: &str, _reason: SftpErrorCode, _idle: Duration) -> BoxFuture<'static, ()> {
        Box::pin(async {})
    }

    fn items(&self) -> Vec<Value> {
        Vec::new()
    }

    fn reset(&self) {}
}
