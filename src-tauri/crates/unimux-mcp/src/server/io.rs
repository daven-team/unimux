//! The connection layer: hyper http1 with Node's timeouts. hyper closes a connection whose request head does not arrive in
//! time without a word; Node (`server.headersTimeout`, `server.requestTimeout`) answers
//! `HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n` first. The socket is shared with a small wrapper so that answer
//! can still be written after hyper gave up on the connection.

use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll, ready};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::net::TcpStream;

/// Node's answer to a request that did not arrive in time (headers 10 s, whole request 30 s).
pub const TIMEOUT_408: &[u8] = b"HTTP/1.1 408 Request Timeout\r\nConnection: close\r\n\r\n";

/// A TcpStream behind an Arc, so the serve loop keeps a handle after hyper owns the connection. Tracks whether request bytes
/// arrived since the last answer was written: a header timeout then means a half-sent request (408), not an idle keep-alive
/// connection (closed silently, as Node's keepAliveTimeout does).
pub struct SharedIo {
    pub stream: Arc<TcpStream>,
    pub mid_request: Arc<AtomicBool>,
}

impl AsyncRead for SharedIo {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        loop {
            ready!(self.stream.poll_read_ready(cx))?;
            match self.stream.try_read(buf.initialize_unfilled()) {
                Ok(n) => {
                    buf.advance(n);
                    if n > 0 {
                        self.mid_request.store(true, Ordering::Relaxed);
                    }
                    return Poll::Ready(Ok(()));
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => continue,
                Err(e) => return Poll::Ready(Err(e)),
            }
        }
    }
}

impl AsyncWrite for SharedIo {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, data: &[u8]) -> Poll<io::Result<usize>> {
        loop {
            ready!(self.stream.poll_write_ready(cx))?;
            match self.stream.try_write(data) {
                Ok(n) => {
                    self.mid_request.store(false, Ordering::Relaxed);
                    return Poll::Ready(Ok(n));
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => continue,
                Err(e) => return Poll::Ready(Err(e)),
            }
        }
    }
    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    /// The socket closes when the connection task ends (both handles dropped).
    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

/// Writes the 408 to a socket hyper stopped serving (best effort; the client may be gone).
pub async fn answer_timeout(stream: &TcpStream) {
    let mut sent = 0;
    while sent < TIMEOUT_408.len() {
        if stream.writable().await.is_err() {
            return;
        }
        match stream.try_write(&TIMEOUT_408[sent..]) {
            Ok(0) => return,
            Ok(n) => sent += n,
            Err(e) if e.kind() == io::ErrorKind::WouldBlock => continue,
            Err(_) => return,
        }
    }
}
