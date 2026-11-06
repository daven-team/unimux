//! A stream wrapper that records what the client writes and reports when the peer's side ends (EOF or a read error).
//! SP9 uses it to compare connect bytes with the 1.1.4 drivers and to see a dropped Redis connection without a pending
//! command (the redis crate's push-based disconnect notice needs RESP3, 1.1.4 speaks RESP2).

use std::io;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll};

use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::watch;

pub struct Tap<S> {
    inner: S,
    written: Arc<Mutex<Vec<u8>>>,
    ended: watch::Sender<bool>,
}

/// The other half: the bytes written so far and the end signal.
#[derive(Clone)]
pub struct TapView {
    written: Arc<Mutex<Vec<u8>>>,
    pub ended: watch::Receiver<bool>,
}

impl TapView {
    pub fn written(&self) -> Vec<u8> {
        self.written.lock().map(|w| w.clone()).unwrap_or_default()
    }
}

pub fn tap<S>(inner: S) -> (Tap<S>, TapView) {
    let written = Arc::new(Mutex::new(Vec::new()));
    let (ended, rx) = watch::channel(false);
    (Tap { inner, written: written.clone(), ended }, TapView { written, ended: rx })
}

impl<S: AsyncRead + Unpin> AsyncRead for Tap<S> {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        let before = buf.filled().len();
        let r = Pin::new(&mut self.inner).poll_read(cx, buf);
        match &r {
            Poll::Ready(Ok(())) if buf.filled().len() == before && buf.remaining() > 0 => {
                let _ = self.ended.send(true);
            }
            Poll::Ready(Err(_)) => {
                let _ = self.ended.send(true);
            }
            _ => {}
        }
        r
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for Tap<S> {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        let r = Pin::new(&mut self.inner).poll_write(cx, buf);
        if let Poll::Ready(Ok(n)) = &r
            && let Ok(mut w) = self.written.lock()
        {
            w.extend_from_slice(&buf[..*n]);
        }
        r
    }
    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }
    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}
