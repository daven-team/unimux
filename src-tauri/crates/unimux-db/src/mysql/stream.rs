//! `MyStream` of src/dbhost/mysqlSession.ts: one statement's answer as it streams in. The fields of its first result set,
//! its rows (only that set's; later sets are read and dropped, their OK still counts as the header), the OK packet of a
//! result without rows, and its end or error.
//!
//! Back-pressure: rows are read from the connection only when they are asked for ([`MyStream::take`],
//! [`MyStream::more`]), so a result nobody reads (an open "load more" result) stays in the socket and TCP flow control
//! stops the server, where mysql2 paused its socket at [`HIGH_ROWS`] / [`HIGH_BYTES`]. [`MyStream::read_ahead`] fills the
//! buffer up to the same bounds for a caller that wants rows ready before it asks.

use std::collections::VecDeque;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::time::Instant;

use super::conn::{MyConn, MyEvent, MyOk};
use super::error::MyError;
use super::packet::RawRow;
use crate::wire::mysql::MyColumn;

/// Rows (or bytes) mysqlSession buffered from the server before it paused the connection.
pub const HIGH_ROWS: usize = 2000;
pub const HIGH_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Default)]
pub struct MyStream {
    /// The columns of the first result set (None: no result set yet, or a statement without rows).
    pub fields: Option<Vec<MyColumn>>,
    /// The last OK packet (a statement without rows; the end of a CALL).
    pub header: Option<MyOk>,
    /// The statement ended (all its results read, or the connection failed).
    pub done: bool,
    /// Why it failed (the server's error, LOAD DATA LOCAL refused, or the connection).
    pub error: Option<MyError>,
    rows: VecDeque<RawRow>,
    bytes: usize,
    /// Results seen so far (mysql2's result index: result sets and OK packets alike) and the one whose rows are kept.
    sets: i64,
    row_set: i64,
    discard: bool,
}

impl MyStream {
    /// Sends the statement; the answer is read as the caller asks for rows.
    pub async fn start<S: AsyncRead + AsyncWrite + Unpin + Send>(conn: &mut MyConn<S>, sql: &str) -> Result<MyStream, MyError> {
        conn.start_query(sql).await?;
        Ok(MyStream { sets: -1, row_set: -1, ..Default::default() })
    }

    /// Rows read but not taken yet.
    pub fn buffered(&self) -> (usize, usize) {
        (self.rows.len(), self.bytes)
    }

    /// Reads one event of the statement.
    async fn pump<S: AsyncRead + AsyncWrite + Unpin + Send>(&mut self, conn: &mut MyConn<S>) {
        match conn.next_event().await {
            Ok(None) => self.done = true,
            Ok(Some(ev)) => match ev {
                MyEvent::Fields(f) => {
                    self.sets += 1;
                    if self.fields.is_none() {
                        self.fields = Some(f);
                        self.row_set = self.sets;
                    }
                }
                MyEvent::Ok(ok) => {
                    self.sets += 1;
                    self.header = Some(ok);
                }
                MyEvent::Row(row) => {
                    if !self.discard && self.sets == self.row_set {
                        self.bytes += row.stream_bytes();
                        self.rows.push_back(row);
                    }
                }
                MyEvent::SetEnd { .. } => {}
                MyEvent::Error(e) => {
                    self.error.get_or_insert(MyError::Server(e));
                }
                MyEvent::ClientError(m) => {
                    self.error.get_or_insert(MyError::Client(m));
                }
            },
            Err(e) => {
                self.error.get_or_insert(e);
                self.done = true;
            }
        }
    }

    /// Up to `count` rows (fewer only at the end); the statement's error once its rows are taken.
    pub async fn take<S: AsyncRead + AsyncWrite + Unpin + Send>(
        &mut self,
        conn: &mut MyConn<S>,
        count: usize,
    ) -> Result<Vec<RawRow>, MyError> {
        while self.rows.len() < count && !self.done {
            self.pump(conn).await;
        }
        let n = count.min(self.rows.len());
        let out: Vec<RawRow> = self.rows.drain(..n).collect();
        self.bytes -= out.iter().map(RawRow::stream_bytes).sum::<usize>();
        if out.is_empty()
            && let Some(e) = &self.error
        {
            return Err(e.clone());
        }
        Ok(out)
    }

    /// Waits until a row is buffered or the statement ended: whether more rows follow.
    pub async fn more<S: AsyncRead + AsyncWrite + Unpin + Send>(&mut self, conn: &mut MyConn<S>) -> bool {
        while self.rows.is_empty() && !self.done {
            self.pump(conn).await;
        }
        !self.rows.is_empty()
    }

    /// Reads ahead while fewer than [`HIGH_ROWS`] rows and [`HIGH_BYTES`] bytes are buffered (mysqlSession's pause point).
    pub async fn read_ahead<S: AsyncRead + AsyncWrite + Unpin + Send>(&mut self, conn: &mut MyConn<S>) {
        while !self.done && self.rows.len() < HIGH_ROWS && self.bytes < HIGH_BYTES {
            self.pump(conn).await;
        }
    }

    /// Everything up to the end, rows thrown away; true once the connection is free, false when `wait` ran out first
    /// (the session then ends the connection: it cannot be trusted).
    pub async fn drain<S: AsyncRead + AsyncWrite + Unpin + Send>(&mut self, conn: &mut MyConn<S>, wait: Duration) -> bool {
        self.discard = true;
        self.rows.clear();
        self.bytes = 0;
        let until = Instant::now() + wait;
        while !self.done {
            if tokio::time::timeout_at(until, self.pump(conn)).await.is_err() {
                return false;
            }
        }
        true
    }
}
