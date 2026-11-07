//! MySQL packet framing over any stream (plain or TLS after the SSL request): a 3-byte length and a sequence id per frame,
//! a logical packet of 16 MiB - 1 or more continued in the next frames. Reading is cancel-safe: bytes stay in the buffer
//! until a whole logical packet is there, so a `select!` (an idle watch, a drain deadline) never loses half a packet.

use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};

use bytes::{Buf, Bytes, BytesMut};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio_rustls::client::TlsStream;

use super::error::MyError;

/// The largest frame payload; a payload of exactly this size is continued in the next frame.
pub const MAX_FRAME: usize = 0xff_ffff;
/// The largest logical packet accepted from a server (MySQL's own max_allowed_packet limit is 1 GiB).
pub const MAX_PACKET: usize = 1024 * 1024 * 1024;

/// The connection's stream: plain until the SSL request, then TLS over the same stream.
pub enum MaybeTls<S> {
    Plain(S),
    Tls(Box<TlsStream<S>>),
    /// Only while the TLS handshake runs (the stream is moved into the connector).
    Upgrading,
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncRead for MaybeTls<S> {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            MaybeTls::Plain(s) => Pin::new(s).poll_read(cx, buf),
            MaybeTls::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
            MaybeTls::Upgrading => Poll::Ready(Err(io::Error::new(io::ErrorKind::NotConnected, "TLS upgrade in progress"))),
        }
    }
}

impl<S: AsyncRead + AsyncWrite + Unpin> AsyncWrite for MaybeTls<S> {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            MaybeTls::Plain(s) => Pin::new(s).poll_write(cx, buf),
            MaybeTls::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
            MaybeTls::Upgrading => Poll::Ready(Err(io::Error::new(io::ErrorKind::NotConnected, "TLS upgrade in progress"))),
        }
    }

    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            MaybeTls::Plain(s) => Pin::new(s).poll_flush(cx),
            MaybeTls::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
            MaybeTls::Upgrading => Poll::Ready(Ok(())),
        }
    }

    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            MaybeTls::Plain(s) => Pin::new(s).poll_shutdown(cx),
            MaybeTls::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
            MaybeTls::Upgrading => Poll::Ready(Ok(())),
        }
    }
}

/// The framed connection: the stream, what was read but not yet taken, and the sequence id of the next frame.
pub struct PacketIo<S> {
    pub stream: MaybeTls<S>,
    buf: BytesMut,
    seq: u8,
}

impl<S: AsyncRead + AsyncWrite + Unpin> PacketIo<S> {
    pub fn new(stream: S) -> Self {
        PacketIo { stream: MaybeTls::Plain(stream), buf: BytesMut::with_capacity(16 * 1024), seq: 0 }
    }

    /// A new command starts a new sequence.
    pub fn reset_seq(&mut self) {
        self.seq = 0;
    }

    /// Bytes read from the server that no packet took yet (must be none before a TLS upgrade).
    pub fn buffered(&self) -> usize {
        self.buf.len()
    }

    /// A whole logical packet out of the buffer, if one is there (its frames' sequence ids are not checked, like mysql2,
    /// which only warns about them).
    fn take_packet(&mut self) -> Result<Option<Bytes>, MyError> {
        let mut at = 0usize;
        let mut total = 0usize;
        let mut frames = 0usize;
        let last_seq;
        loop {
            if self.buf.len() < at + 4 {
                return Ok(None);
            }
            let len = usize::from(self.buf[at]) | usize::from(self.buf[at + 1]) << 8 | usize::from(self.buf[at + 2]) << 16;
            total += len;
            if total > MAX_PACKET {
                return Err(MyError::Protocol("packet larger than 1 GiB".into()));
            }
            if self.buf.len() < at + 4 + len {
                return Ok(None);
            }
            frames += 1;
            let seq = self.buf[at + 3];
            at += 4 + len;
            if len < MAX_FRAME {
                last_seq = seq;
                break;
            }
        }
        self.seq = last_seq.wrapping_add(1);
        if frames == 1 {
            let mut frame = self.buf.split_to(at);
            frame.advance(4);
            return Ok(Some(frame.freeze()));
        }
        let mut whole = self.buf.split_to(at);
        let mut out = BytesMut::with_capacity(total);
        while !whole.is_empty() {
            let len = usize::from(whole[0]) | usize::from(whole[1]) << 8 | usize::from(whole[2]) << 16;
            whole.advance(4);
            out.extend_from_slice(&whole.split_to(len));
        }
        Ok(Some(out.freeze()))
    }

    /// Reads more bytes into the buffer (cancel-safe). EOF is `Closed`.
    pub async fn fill(&mut self) -> Result<(), MyError> {
        if self.buf.capacity() - self.buf.len() < 8 * 1024 {
            self.buf.reserve(64 * 1024);
        }
        let n = self.stream.read_buf(&mut self.buf).await.map_err(MyError::from)?;
        if n == 0 {
            return Err(MyError::Closed);
        }
        Ok(())
    }

    /// The next logical packet (cancel-safe).
    pub async fn read_packet(&mut self) -> Result<Bytes, MyError> {
        loop {
            if let Some(p) = self.take_packet()? {
                return Ok(p);
            }
            self.fill().await?;
        }
    }

    /// The whole packet at the front of the buffer, without reading (for the last words of a server that closed).
    pub fn try_packet(&mut self) -> Option<Bytes> {
        self.take_packet().ok().flatten()
    }

    /// One logical packet, split into frames as needed (an exact multiple of the frame size ends with an empty frame).
    pub async fn write_packet(&mut self, payload: &[u8]) -> Result<(), MyError> {
        let mut out = Vec::with_capacity(payload.len() + 8);
        let mut rest = payload;
        loop {
            let n = rest.len().min(MAX_FRAME);
            out.extend_from_slice(&[(n & 0xff) as u8, (n >> 8 & 0xff) as u8, (n >> 16) as u8, self.seq]);
            self.seq = self.seq.wrapping_add(1);
            out.extend_from_slice(&rest[..n]);
            rest = &rest[n..];
            if n < MAX_FRAME {
                break;
            }
        }
        self.stream.write_all(&out).await.map_err(MyError::from)?;
        self.stream.flush().await.map_err(MyError::from)
    }

    pub async fn shutdown(&mut self) {
        let _ = self.stream.shutdown().await;
    }
}

/// A length-encoded integer; None for the NULL marker 0xfb.
pub fn lenenc(b: &mut &[u8]) -> Result<Option<u64>, MyError> {
    let bad = || MyError::Protocol("short length-encoded integer".into());
    let first = *b.first().ok_or_else(bad)?;
    let (n, v) = match first {
        0xfb => (1, None),
        0xfc => (3, b.get(1..3).map(|s| u64::from(u16::from_le_bytes([s[0], s[1]])))),
        0xfd => (4, b.get(1..4).map(|s| u64::from(s[0]) | u64::from(s[1]) << 8 | u64::from(s[2]) << 16)),
        0xfe => (9, b.get(1..9).map(|s| u64::from_le_bytes(s.try_into().expect("8 bytes")))),
        x => (1, Some(u64::from(x))),
    };
    if b.len() < n || (first != 0xfb && v.is_none()) {
        return Err(bad());
    }
    *b = &b[n..];
    Ok(v)
}

/// One text-protocol row: the packet and where each cell is (None: NULL). Cells are slices of the packet, not copies.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawRow {
    data: Bytes,
    cells: Vec<Option<(u32, u32)>>,
}

impl RawRow {
    /// A row of `columns` length-encoded strings (0xfb for NULL).
    pub fn parse(data: Bytes, columns: usize) -> Result<RawRow, MyError> {
        let mut cells = Vec::with_capacity(columns);
        let mut b: &[u8] = &data;
        for _ in 0..columns {
            match lenenc(&mut b)? {
                None => cells.push(None),
                Some(n) => {
                    let n = usize::try_from(n).map_err(|_| MyError::Protocol("cell too long".into()))?;
                    if b.len() < n {
                        return Err(MyError::Protocol("short length-encoded string".into()));
                    }
                    let start = data.len() - b.len();
                    cells.push(Some((start as u32, (start + n) as u32)));
                    b = &b[n..];
                }
            }
        }
        Ok(RawRow { data, cells })
    }

    pub fn len(&self) -> usize {
        self.cells.len()
    }

    pub fn is_empty(&self) -> bool {
        self.cells.is_empty()
    }

    /// The raw bytes of cell `i` (None: NULL or no such cell).
    pub fn get(&self, i: usize) -> Option<&[u8]> {
        self.cells.get(i).copied().flatten().map(|(a, b)| &self.data[a as usize..b as usize])
    }

    pub fn cells(&self) -> impl Iterator<Item = Option<&[u8]>> + '_ {
        self.cells.iter().map(|c| c.map(|(a, b)| &self.data[a as usize..b as usize]))
    }

    /// The bytes mysqlSession's MyStream counts for back-pressure (a NULL counts 1).
    pub fn stream_bytes(&self) -> usize {
        self.cells.iter().map(|c| c.map_or(1, |(a, b)| (b - a) as usize)).sum()
    }

    /// What MyCall counts (`rawBytes`: a NULL counts 8).
    pub fn call_bytes(&self) -> usize {
        self.cells.iter().map(|c| c.map_or(8, |(a, b)| (b - a) as usize)).sum()
    }

    pub fn to_vec(&self) -> Vec<Option<Vec<u8>>> {
        self.cells().map(|c| c.map(<[u8]>::to_vec)).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lenenc_forms() {
        let mut b: &[u8] = &[0xfc, 0x01, 0x02, 9];
        assert_eq!(lenenc(&mut b).unwrap(), Some(0x0201));
        assert_eq!(b, &[9]);
        let mut b: &[u8] = &[0xfb];
        assert_eq!(lenenc(&mut b).unwrap(), None);
        let mut b: &[u8] = &[0xfd, 1, 0];
        assert!(lenenc(&mut b).is_err());
        let mut b: &[u8] = &[];
        assert!(lenenc(&mut b).is_err());
    }

    #[test]
    fn rows_point_into_the_packet() {
        let row = RawRow::parse(Bytes::from_static(&[1, b'a', 0xfb, 0, 2, b'x', b'y']), 4).unwrap();
        assert_eq!(row.to_vec(), vec![Some(b"a".to_vec()), None, Some(Vec::new()), Some(b"xy".to_vec())]);
        assert_eq!(row.stream_bytes(), 1 + 1 + 2);
        assert_eq!(row.call_bytes(), 1 + 8 + 2);
        assert!(RawRow::parse(Bytes::from_static(&[3, b'a']), 1).is_err());
    }

    #[tokio::test]
    async fn frames_split_and_join() {
        let (a, b) = tokio::io::duplex(64 * 1024 * 1024);
        let mut w = PacketIo::new(a);
        let mut r = PacketIo::new(b);
        let big = vec![7u8; MAX_FRAME + 10];
        let exact = vec![1u8; MAX_FRAME];
        w.write_packet(&big).await.unwrap();
        w.write_packet(&exact).await.unwrap();
        w.write_packet(b"tail").await.unwrap();
        assert_eq!(r.read_packet().await.unwrap().len(), MAX_FRAME + 10);
        assert_eq!(r.read_packet().await.unwrap().len(), MAX_FRAME);
        assert_eq!(&r.read_packet().await.unwrap()[..], b"tail");
        // seq: 2 frames, 2 frames (one empty), 1 frame
        assert_eq!(r.seq, 5);
    }
}
