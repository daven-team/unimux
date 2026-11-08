//! D5: cursors of the extended protocol as pg-cursor 2.x runs them for 1.1.4's PgSession (unnamed statement, a named
//! portal `C_<n>`, text results, Execute with a row count and Flush, no Sync until the portal ends so it stays open
//! between reads; Close portal + Sync at the end), and the reads of what the server sends on its own while no
//! statement runs (notices, a FATAL error, the end of the stream).
//!
//! An error ends its exchange here (Sync, then everything up to the ReadyForQuery), so the transaction state is known
//! before the caller goes on; 1.1.4 needed its `drain()` marker for that.

use bytes::{BufMut, BytesMut};
use postgres_protocol::message::{backend, frontend};

use super::{COPY_FAIL_TEXT, PgClient, QueryEvents, TxStatus};
use crate::wire::pg::{Frame, PgField, PgServerError, PgWireError, Row, data_row, tag_of};

/// Where a [`PgCursor`] is (pg-cursor's `state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorState {
    /// The portal is open (suspended between reads); nothing else may use the connection until it is closed.
    Open,
    /// The last row was read (CommandComplete) or the cursor was closed: its exchange ended with a ReadyForQuery.
    Done,
    /// The server refused it; its exchange was synced and read up to the ReadyForQuery already.
    Error,
}

/// A named portal read in batches.
#[derive(Debug)]
pub struct PgCursor {
    portal: String,
    state: CursorState,
    /// The result columns (empty when the statement returns none: NoData).
    pub fields: Vec<PgField>,
    /// The command tag once the last row was read.
    pub tag: Option<String>,
}

impl PgCursor {
    pub fn state(&self) -> CursorState {
        self.state
    }

    pub fn portal(&self) -> &str {
        &self.portal
    }
}

/// One read of a cursor: its rows and whether the portal ended (CommandComplete).
#[derive(Debug, Default)]
pub struct CursorRows {
    pub rows: Vec<Row>,
    pub done: bool,
}

/// Something the server sent while no statement ran (read by [`PgClient::idle_message`]).
#[derive(Debug)]
pub enum IdleEvent {
    Notice(PgServerError),
    /// A ReadyForQuery that ended something (its transaction state was taken).
    Ready(TxStatus),
    /// An ErrorResponse outside of any statement (a FATAL before the server closes): the connection is broken.
    Error(PgServerError),
}

fn unexpected(c: &mut PgClient, what: &str, m: Option<&backend::Message>) -> PgWireError {
    c.broken = true;
    match m {
        Some(m) => PgWireError::Protocol(format!("unexpected message {what}: {}", tag_of(m))),
        None => PgWireError::Protocol(format!("unexpected message {what}")),
    }
}

impl PgClient {
    fn bind_text(&mut self, portal: &str, params: &[Option<&str>]) -> Result<(), PgWireError> {
        frontend::bind(
            portal,
            "",
            std::iter::empty::<i16>(),
            params.iter(),
            |p: &Option<&str>, buf: &mut BytesMut| match p {
                Some(v) => {
                    buf.put_slice(v.as_bytes());
                    Ok(postgres_protocol::IsNull::No)
                }
                None => Ok(postgres_protocol::IsNull::Yes),
            },
            std::iter::empty::<i16>(),
            &mut self.out,
        )
        .map_err(|_| PgWireError::Protocol("bind".into()))
    }

    /// Reads up to the ReadyForQuery of an exchange that was synced; notices go to `events`.
    async fn drain_to_ready(&mut self, events: &mut dyn QueryEvents) -> Result<(), PgWireError> {
        loop {
            match self.next().await? {
                Frame::Msg(backend::Message::ReadyForQuery(b)) => {
                    self.tx = TxStatus::from_byte(b.status());
                    return Ok(());
                }
                Frame::Notice(n) => events.notice(n),
                Frame::Param(k, v) => self.params.push((k, v)),
                Frame::Key(_) | Frame::Negotiate { .. } => return Err(unexpected(self, "in a statement", None)),
                // the rest of the refused exchange (the server skips to the Sync)
                _ => {}
            }
        }
    }

    /// Ends the exchange of a refused cursor: Sync, then everything up to its ReadyForQuery.
    async fn sync_after_error(&mut self, events: &mut dyn QueryEvents) -> Result<(), PgWireError> {
        frontend::sync(&mut self.out);
        self.flush().await?;
        self.drain_to_ready(events).await
    }

    /// Opens a cursor: Parse (unnamed statement), Bind (portal `C_<n>`, text parameters), Describe portal, Flush, then
    /// reads up to its RowDescription / NoData. A server error is returned as `PgWireError::Server` once its exchange
    /// ended (no cursor is handed out then).
    pub async fn cursor_open(
        &mut self,
        sql: &str,
        params: &[Option<&str>],
        events: &mut dyn QueryEvents,
    ) -> Result<PgCursor, PgWireError> {
        self.check_usable()?;
        self.portal_seq += 1;
        let portal = format!("C_{}", self.portal_seq);
        frontend::parse("", sql, std::iter::empty(), &mut self.out)?;
        self.bind_text(&portal, params)?;
        frontend::describe(b'P', &portal, &mut self.out)?;
        frontend::flush(&mut self.out);
        self.flush().await?;
        loop {
            match self.next().await? {
                Frame::Msg(backend::Message::ParseComplete | backend::Message::BindComplete) => {}
                Frame::Fields(f) => {
                    events.fields(&f);
                    return Ok(PgCursor { portal, state: CursorState::Open, fields: f, tag: None });
                }
                Frame::Msg(backend::Message::NoData) => {
                    return Ok(PgCursor { portal, state: CursorState::Open, fields: Vec::new(), tag: None });
                }
                Frame::Error(e) => {
                    self.sync_after_error(events).await?;
                    return Err(PgWireError::Server(e));
                }
                Frame::Notice(n) => events.notice(n),
                Frame::Param(k, v) => self.params.push((k, v)),
                Frame::Msg(backend::Message::NotificationResponse(_)) => {}
                Frame::Msg(other) => return Err(unexpected(self, "opening a cursor", Some(&other))),
                _ => return Err(unexpected(self, "opening a cursor", None)),
            }
        }
    }

    /// Closes the portal and ends the exchange (Close portal + Sync, up to the ReadyForQuery).
    async fn close_portal(&mut self, cursor: &mut PgCursor, events: &mut dyn QueryEvents) -> Result<(), PgWireError> {
        cursor.state = CursorState::Done;
        frontend::close(b'P', &cursor.portal, &mut self.out)?;
        frontend::sync(&mut self.out);
        self.flush().await?;
        loop {
            match self.next().await? {
                Frame::Msg(backend::Message::ReadyForQuery(b)) => {
                    self.tx = TxStatus::from_byte(b.status());
                    return Ok(());
                }
                Frame::Msg(backend::Message::CloseComplete | backend::Message::NotificationResponse(_)) => {}
                Frame::Error(e) => {
                    // the Sync is out already: its ReadyForQuery follows
                    self.drain_to_ready(events).await?;
                    return Err(PgWireError::Server(e));
                }
                Frame::Notice(n) => events.notice(n),
                Frame::Param(k, v) => self.params.push((k, v)),
                Frame::Msg(other) => return Err(unexpected(self, "closing a cursor", Some(&other))),
                _ => return Err(unexpected(self, "closing a cursor", None)),
            }
        }
    }

    /// Reads up to `count` rows (Execute portal, Flush). At CommandComplete the portal is closed and the exchange ended
    /// (`done`); a server error syncs and reads to the ReadyForQuery before it is returned. A cursor that is not open
    /// reads nothing (`done`).
    pub async fn cursor_read(
        &mut self,
        cursor: &mut PgCursor,
        count: i32,
        events: &mut dyn QueryEvents,
    ) -> Result<CursorRows, PgWireError> {
        if cursor.state != CursorState::Open {
            return Ok(CursorRows { rows: Vec::new(), done: true });
        }
        self.check_usable()?;
        frontend::execute(&cursor.portal, count.max(1), &mut self.out)?;
        frontend::flush(&mut self.out);
        self.flush().await?;
        let mut rows = Vec::new();
        loop {
            match self.next().await? {
                Frame::Msg(backend::Message::DataRow(row)) => rows.push(data_row(&row)?),
                Frame::Msg(backend::Message::PortalSuspended) => return Ok(CursorRows { rows, done: false }),
                Frame::Tag(t) => {
                    cursor.tag = Some(t);
                    self.close_portal(cursor, events).await?;
                    return Ok(CursorRows { rows, done: true });
                }
                Frame::Msg(backend::Message::EmptyQueryResponse) => {
                    self.close_portal(cursor, events).await?;
                    return Ok(CursorRows { rows, done: true });
                }
                Frame::Error(e) => {
                    cursor.state = CursorState::Error;
                    self.sync_after_error(events).await?;
                    return Err(PgWireError::Server(e));
                }
                Frame::Notice(n) => events.notice(n),
                Frame::Param(k, v) => self.params.push((k, v)),
                Frame::Msg(backend::Message::CopyInResponse(_)) => {
                    // refused like node-postgres; the server answers with an error, which syncs above
                    frontend::copy_fail(COPY_FAIL_TEXT, &mut self.out)?;
                    frontend::flush(&mut self.out);
                    self.flush().await?;
                }
                Frame::Msg(
                    backend::Message::CopyOutResponse(_)
                    | backend::Message::CopyData(_)
                    | backend::Message::CopyDone
                    | backend::Message::NotificationResponse(_),
                ) => {}
                Frame::Msg(other) => return Err(unexpected(self, "reading a cursor", Some(&other))),
                _ => return Err(unexpected(self, "reading a cursor", None)),
            }
        }
    }

    /// Ends a cursor before the connection is used for anything else (pg-cursor `close`): an open portal is closed and
    /// synced; a done or refused one ended its exchange already.
    pub async fn cursor_close(&mut self, cursor: &mut PgCursor, events: &mut dyn QueryEvents) -> Result<(), PgWireError> {
        if cursor.state != CursorState::Open {
            return Ok(());
        }
        if self.broken {
            cursor.state = CursorState::Done;
            return Ok(());
        }
        self.close_portal(cursor, events).await
    }

    /// Waits for something the server sends on its own while the connection is idle (between statements, or with a
    /// suspended portal): notices, a ReadyForQuery that is not a stray one, a FATAL error; the end of the stream is an
    /// `Err` (the connection is broken then). Cancel-safe: dropping the future loses nothing (the frame reader consumes
    /// whole messages only).
    pub async fn idle_message(&mut self) -> Result<IdleEvent, PgWireError> {
        self.check_usable()?;
        loop {
            match self.next().await? {
                Frame::Notice(n) => return Ok(IdleEvent::Notice(n)),
                Frame::Param(k, v) => self.params.push((k, v)),
                Frame::Msg(backend::Message::NotificationResponse(_)) => {}
                Frame::Msg(backend::Message::ReadyForQuery(b)) => {
                    self.tx = TxStatus::from_byte(b.status());
                    return Ok(IdleEvent::Ready(self.tx));
                }
                Frame::Error(e) => {
                    self.broken = true;
                    return Ok(IdleEvent::Error(e));
                }
                Frame::Msg(other) => return Err(unexpected(self, "while idle", Some(&other))),
                _ => return Err(unexpected(self, "while idle", None)),
            }
        }
    }
}
