//! The SFTP client of one session (the `SFTPWrapper` of ssh2 plus 1.1.4's `RemoteRequests`): requests are pipelined (any
//! number in flight, answered by id), and the session fails them itself when it ends. ssh2 accepted requests on a dead
//! channel and never answered them, so 1.1.4 failed them in `RemoteRequests.kill()`; here [`SftpClient::kill`] and a
//! closed or broken stream fail whatever is pending with `connectionLost`, and every later request at once.
//!
//! No per-request timeout (like ssh2): the operations of the view have the host's `opTimeoutMs`, transfers end with the
//! session.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use parking_lot::Mutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::error::SftpErrorCode;
use crate::host::SftpStream;
use crate::proto::{
    self, Attrs, NameEntry, PROTOCOL_VERSION, ProtoError, Reply, ServerVersion, open_flags, put_bytes, put_str, put_u32, put_u64,
    status,
};

/// Why a request failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClientError {
    /// The server answered with this `SSH_FX_*` status.
    Status(u32),
    /// The session ended (or ended while the request waited).
    Lost,
    /// An answer of the wrong kind.
    Protocol,
}

impl ClientError {
    /// 1.1.4 `remoteError`: the server's status as the UI's code; a numeric status without its own code is `failed`, a
    /// request that never got an answer is `connectionLost`.
    pub fn code(self) -> SftpErrorCode {
        match self {
            ClientError::Status(status::NO_SUCH_FILE) => SftpErrorCode::NotFound,
            ClientError::Status(status::PERMISSION_DENIED) => SftpErrorCode::Permission,
            ClientError::Status(status::OP_UNSUPPORTED) => SftpErrorCode::Unsupported,
            ClientError::Status(_) | ClientError::Protocol => SftpErrorCode::Failed,
            ClientError::Lost => SftpErrorCode::ConnectionLost,
        }
    }
}

impl From<ProtoError> for ClientError {
    fn from(_: ProtoError) -> Self {
        ClientError::Protocol
    }
}

type Answer = oneshot::Sender<Result<Reply, ClientError>>;

struct Inner {
    out: mpsc::UnboundedSender<Vec<u8>>,
    pending: Mutex<HashMap<u32, Answer>>,
    next_id: AtomicU32,
    dead: AtomicBool,
    closed: CancellationToken,
    tasks: Mutex<Vec<tokio::task::AbortHandle>>,
}

impl Inner {
    /// The session ended: pending requests fail with `Lost`, later ones at once.
    fn die(&self) {
        let pending: Vec<Answer> = {
            let mut p = self.pending.lock();
            self.dead.store(true, Ordering::SeqCst);
            p.drain().map(|(_, a)| a).collect()
        };
        for a in pending {
            let _ = a.send(Err(ClientError::Lost));
        }
        self.closed.cancel();
    }

    fn answer(&self, id: u32, reply: Reply) {
        // An answer to a request nobody waits for any more (a dropped read of a cancelled transfer) is ignored.
        if let Some(a) = self.pending.lock().remove(&id) {
            let _ = a.send(Ok(reply));
        }
    }
}

/// One SFTP session on a byte stream (the `sftp` subsystem channel, or a server started through sudo).
pub struct SftpClient {
    inner: Arc<Inner>,
    version: ServerVersion,
}

impl std::fmt::Debug for SftpClient {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SftpClient").field("version", &self.version.version).finish()
    }
}

async fn read_packet<R: tokio::io::AsyncRead + Unpin>(r: &mut R) -> std::io::Result<Vec<u8>> {
    let len = r.read_u32().await? as usize;
    if len == 0 || len > proto::MAX_INCOMING_PACKET {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidData, "sftp packet length"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf).await?;
    Ok(buf)
}

impl SftpClient {
    /// `INIT` / `VERSION` on the stream, then the reader and writer tasks (on the current tokio runtime). Err: the server
    /// did not answer like an SFTP server (the caller ends the session with `sftpDenied`).
    pub async fn start(mut stream: SftpStream) -> Result<Arc<SftpClient>, ClientError> {
        let mut init = Vec::new();
        put_u32(&mut init, PROTOCOL_VERSION);
        stream.write_all(&proto::frame(proto::INIT, None, &init)).await.map_err(|_| ClientError::Lost)?;
        stream.flush().await.map_err(|_| ClientError::Lost)?;
        let packet = read_packet(&mut stream).await.map_err(|_| ClientError::Lost)?;
        if packet.first() != Some(&proto::VERSION) {
            return Err(ClientError::Protocol);
        }
        let version = ServerVersion::decode(&packet[1..])?;
        let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
        let inner = Arc::new(Inner {
            out: tx,
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU32::new(1),
            dead: AtomicBool::new(false),
            closed: CancellationToken::new(),
            tasks: Mutex::new(Vec::new()),
        });
        let (mut reader, mut writer) = tokio::io::split(stream);
        let w = Arc::downgrade(&inner);
        let write_task = tokio::spawn(async move {
            while let Some(packet) = rx.recv().await {
                if packet.is_empty() || writer.write_all(&packet).await.is_err() || writer.flush().await.is_err() {
                    break;
                }
            }
            let _ = writer.shutdown().await;
            if let Some(i) = w.upgrade() {
                i.die();
            }
        });
        let r = Arc::downgrade(&inner);
        let read_task = tokio::spawn(async move {
            loop {
                let Ok(packet) = read_packet(&mut reader).await else { break };
                let Some(i) = r.upgrade() else { return };
                match proto::parse_reply(&packet) {
                    Ok(Some((id, reply))) => i.answer(id, reply),
                    Ok(None) => {}
                    // A packet that does not parse: the stream is out of step, nothing after it can be trusted.
                    Err(ProtoError) => break,
                }
            }
            if let Some(i) = r.upgrade() {
                i.die();
            }
        });
        inner.tasks.lock().extend([write_task.abort_handle(), read_task.abort_handle()]);
        Ok(Arc::new(SftpClient { inner, version }))
    }

    pub fn version(&self) -> &ServerVersion {
        &self.version
    }

    /// The server offers `posix-rename@openssh.com` (version "1"): a rename that replaces the target atomically.
    pub fn has_posix_rename(&self) -> bool {
        self.version.extension("posix-rename@openssh.com") == Some(b"1")
    }

    /// The server offers `lsetstat@openssh.com` (a SETSTAT that never follows a symlink, OpenSSH 8.x and later).
    pub fn has_lsetstat(&self) -> bool {
        self.version.extension("lsetstat@openssh.com").is_some()
    }

    pub fn alive(&self) -> bool {
        !self.inner.dead.load(Ordering::SeqCst)
    }

    /// Resolves when the session ended (the stream closed or broke, or [`SftpClient::kill`]).
    pub fn closed(&self) -> tokio_util::sync::WaitForCancellationFutureOwned {
        self.inner.closed.clone().cancelled_owned()
    }

    /// The session ends: pending requests fail with `Lost`, later ones at once, and the stream is dropped.
    pub fn kill(&self) {
        self.inner.die();
        for t in self.inner.tasks.lock().drain(..) {
            t.abort();
        }
    }

    fn send(&self, kind: u8, body: &[u8]) -> Result<oneshot::Receiver<Result<Reply, ClientError>>, ClientError> {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut pending = self.inner.pending.lock();
            if self.inner.dead.load(Ordering::SeqCst) {
                return Err(ClientError::Lost);
            }
            pending.insert(id, tx);
        }
        if self.inner.out.send(proto::frame(kind, Some(id), body)).is_err() {
            self.inner.pending.lock().remove(&id);
            return Err(ClientError::Lost);
        }
        Ok(rx)
    }

    async fn request(&self, kind: u8, body: Vec<u8>) -> Result<Reply, ClientError> {
        let rx = self.send(kind, &body)?;
        rx.await.unwrap_or(Err(ClientError::Lost))
    }

    async fn status_request(&self, kind: u8, body: Vec<u8>) -> Result<(), ClientError> {
        expect_ok(self.request(kind, body).await?)
    }

    /// A request whose answer nobody waits for (the close of a dropped reader or writer).
    pub fn close_nowait(&self, handle: &[u8]) {
        let mut body = Vec::new();
        put_bytes(&mut body, handle);
        if let Ok(rx) = self.send(proto::CLOSE, &body) {
            drop(rx);
        }
    }

    pub async fn open(&self, path: &str, pflags: u32, attrs: &Attrs) -> Result<Vec<u8>, ClientError> {
        let mut body = Vec::new();
        put_str(&mut body, path);
        put_u32(&mut body, pflags);
        attrs.encode(&mut body);
        match self.request(proto::OPEN, body).await? {
            Reply::Handle(h) => Ok(h),
            other => Err(failure(other)),
        }
    }

    /// ssh2's `open(path, 'r')`.
    pub async fn open_read(&self, path: &str) -> Result<Vec<u8>, ClientError> {
        self.open(path, open_flags::READ, &Attrs::default()).await
    }

    /// ssh2's `open(path, 'w')`: created or truncated.
    pub async fn open_write(&self, path: &str) -> Result<Vec<u8>, ClientError> {
        self.open(path, open_flags::WRITE | open_flags::CREAT | open_flags::TRUNC, &Attrs::default()).await
    }

    pub async fn close(&self, handle: &[u8]) -> Result<(), ClientError> {
        let mut body = Vec::new();
        put_bytes(&mut body, handle);
        self.status_request(proto::CLOSE, body).await
    }

    /// Up to `len` bytes at `offset`; empty at the end of the file (an `EOF` status, as ssh2 reports it).
    pub async fn read(&self, handle: &[u8], offset: u64, len: u32) -> Result<Vec<u8>, ClientError> {
        let mut body = Vec::new();
        put_bytes(&mut body, handle);
        put_u64(&mut body, offset);
        put_u32(&mut body, len);
        match self.request(proto::READ, body).await? {
            Reply::Data(mut d) => {
                d.truncate(len as usize);
                Ok(d)
            }
            Reply::Status { code: status::EOF, .. } => Ok(Vec::new()),
            other => Err(failure(other)),
        }
    }

    pub async fn write(&self, handle: &[u8], offset: u64, data: &[u8]) -> Result<(), ClientError> {
        let mut body = Vec::with_capacity(handle.len() + data.len() + 16);
        put_bytes(&mut body, handle);
        put_u64(&mut body, offset);
        put_bytes(&mut body, data);
        self.status_request(proto::WRITE, body).await
    }

    async fn attrs_request(&self, kind: u8, body: Vec<u8>) -> Result<Attrs, ClientError> {
        match self.request(kind, body).await? {
            Reply::Attrs(a) => Ok(a),
            other => Err(failure(other)),
        }
    }

    pub async fn stat(&self, path: &str) -> Result<Attrs, ClientError> {
        let mut body = Vec::new();
        put_str(&mut body, path);
        self.attrs_request(proto::STAT, body).await
    }

    pub async fn lstat(&self, path: &str) -> Result<Attrs, ClientError> {
        let mut body = Vec::new();
        put_str(&mut body, path);
        self.attrs_request(proto::LSTAT, body).await
    }

    pub async fn fstat(&self, handle: &[u8]) -> Result<Attrs, ClientError> {
        let mut body = Vec::new();
        put_bytes(&mut body, handle);
        self.attrs_request(proto::FSTAT, body).await
    }

    pub async fn setstat(&self, path: &str, attrs: &Attrs) -> Result<(), ClientError> {
        let mut body = Vec::new();
        put_str(&mut body, path);
        attrs.encode(&mut body);
        self.status_request(proto::SETSTAT, body).await
    }

    pub async fn fsetstat(&self, handle: &[u8], attrs: &Attrs) -> Result<(), ClientError> {
        let mut body = Vec::new();
        put_bytes(&mut body, handle);
        attrs.encode(&mut body);
        self.status_request(proto::FSETSTAT, body).await
    }

    /// `lsetstat@openssh.com`: SETSTAT on the entry itself (a symlink is never followed).
    pub async fn lsetstat(&self, path: &str, attrs: &Attrs) -> Result<(), ClientError> {
        let mut data = Vec::new();
        put_str(&mut data, path);
        attrs.encode(&mut data);
        expect_ok(self.extended("lsetstat@openssh.com", &data).await?)
    }

    /// The whole folder (ssh2's `readdir(path)`: OPENDIR, READDIR until `EOF`, CLOSE), "." and ".." left out. `max`: stop
    /// reading once more than this many entries came (the listing cap; the rest is never fetched).
    pub async fn readdir(&self, path: &str, max: Option<usize>) -> Result<Vec<NameEntry>, ClientError> {
        let mut body = Vec::new();
        put_str(&mut body, path);
        let handle = match self.request(proto::OPENDIR, body).await? {
            Reply::Handle(h) => h,
            other => return Err(failure(other)),
        };
        let mut out = Vec::new();
        let result = loop {
            if max.is_some_and(|m| out.len() > m) {
                break Ok(());
            }
            let mut body = Vec::new();
            put_bytes(&mut body, &handle);
            match self.request(proto::READDIR, body).await {
                Ok(Reply::Name(names)) => {
                    out.extend(names.into_iter().filter(|n| n.filename != "." && n.filename != ".."));
                }
                Ok(Reply::Status { code: status::EOF, .. }) => break Ok(()),
                Ok(other) => break Err(failure(other)),
                Err(e) => break Err(e),
            }
        };
        match result {
            Ok(()) => {
                // A folder that was read completely is the answer even if its close fails.
                let _ = self.close(&handle).await;
                Ok(out)
            }
            Err(e) => {
                self.close_nowait(&handle);
                Err(e)
            }
        }
    }

    pub async fn remove(&self, path: &str) -> Result<(), ClientError> {
        let mut body = Vec::new();
        put_str(&mut body, path);
        self.status_request(proto::REMOVE, body).await
    }

    pub async fn mkdir(&self, path: &str, attrs: &Attrs) -> Result<(), ClientError> {
        let mut body = Vec::new();
        put_str(&mut body, path);
        attrs.encode(&mut body);
        self.status_request(proto::MKDIR, body).await
    }

    pub async fn rmdir(&self, path: &str) -> Result<(), ClientError> {
        let mut body = Vec::new();
        put_str(&mut body, path);
        self.status_request(proto::RMDIR, body).await
    }

    /// The first name of the server's answer (ssh2's `realpath`).
    pub async fn realpath(&self, path: &str) -> Result<String, ClientError> {
        let mut body = Vec::new();
        put_str(&mut body, path);
        match self.request(proto::REALPATH, body).await? {
            Reply::Name(names) => names.into_iter().next().map(|n| n.filename).ok_or(ClientError::Protocol),
            other => Err(failure(other)),
        }
    }

    pub async fn readlink(&self, path: &str) -> Result<String, ClientError> {
        let mut body = Vec::new();
        put_str(&mut body, path);
        match self.request(proto::READLINK, body).await? {
            Reply::Name(names) => names.into_iter().next().map(|n| n.filename).ok_or(ClientError::Protocol),
            other => Err(failure(other)),
        }
    }

    /// Plain SFTP v3 rename (servers refuse an existing target).
    pub async fn rename(&self, from: &str, to: &str) -> Result<(), ClientError> {
        let mut body = Vec::new();
        put_str(&mut body, from);
        put_str(&mut body, to);
        self.status_request(proto::RENAME, body).await
    }

    /// `posix-rename@openssh.com`: replaces an existing target atomically.
    pub async fn posix_rename(&self, from: &str, to: &str) -> Result<(), ClientError> {
        let mut data = Vec::new();
        put_str(&mut data, from);
        put_str(&mut data, to);
        expect_ok(self.extended("posix-rename@openssh.com", &data).await?)
    }

    /// `SSH_FXP_EXTENDED` with the request's own data.
    pub async fn extended(&self, name: &str, data: &[u8]) -> Result<Reply, ClientError> {
        let mut body = Vec::with_capacity(name.len() + data.len() + 4);
        put_str(&mut body, name);
        body.extend_from_slice(data);
        self.request(proto::EXTENDED, body).await
    }
}

impl Drop for SftpClient {
    fn drop(&mut self) {
        self.kill();
    }
}

fn expect_ok(reply: Reply) -> Result<(), ClientError> {
    match reply {
        Reply::Status { code: status::OK, .. } => Ok(()),
        other => Err(failure(other)),
    }
}

fn failure(reply: Reply) -> ClientError {
    match reply {
        Reply::Status { code, .. } => ClientError::Status(code),
        _ => ClientError::Protocol,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_follow_remote_error() {
        assert_eq!(ClientError::Status(2).code(), SftpErrorCode::NotFound);
        assert_eq!(ClientError::Status(3).code(), SftpErrorCode::Permission);
        assert_eq!(ClientError::Status(8).code(), SftpErrorCode::Unsupported);
        assert_eq!(ClientError::Status(4).code(), SftpErrorCode::Failed);
        assert_eq!(ClientError::Status(1).code(), SftpErrorCode::Failed);
        assert_eq!(ClientError::Status(7).code(), SftpErrorCode::Failed);
        assert_eq!(ClientError::Lost.code(), SftpErrorCode::ConnectionLost);
        assert_eq!(ClientError::Protocol.code(), SftpErrorCode::Failed);
    }
}
