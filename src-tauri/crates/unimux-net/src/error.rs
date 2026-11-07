use thiserror::Error;

/// Why a request failed. Messages never contain request headers or bodies (tokens travel only there).
#[derive(Debug, Error)]
pub enum FetchError {
    /// The request could not be built (bad URL, scheme, header name or value).
    #[error("invalid request: {0}")]
    InvalidRequest(String),
    /// The initial address was refused by the request's address check.
    #[error("address not allowed: {0}")]
    AddressNotAllowed(String),
    /// No connection to the server (or through any proxy) was established, so nothing was sent: the same request may safely be
    /// tried by another path (1.1.4's `ConnectFailure`). Includes DNS, TCP, proxy handshake and TLS handshake failures.
    #[error("connect failed: {0}")]
    Connect(String),
    /// The request's timeout passed (connect, headers and, for buffered fetches, the body).
    #[error("timed out")]
    Timeout,
    /// The request's cancellation token fired.
    #[error("aborted")]
    Aborted,
    /// A 3xx answer to a request that refuses redirects (`Redirect::Error` like fetch's `redirect: 'error'`, or
    /// `Redirect::ErrorAny3xx` like 1.1.4's token transport).
    #[error("redirect refused")]
    RedirectRefused { status: u16, location: Option<String> },
    #[error("too many redirects")]
    TooManyRedirects,
    /// A redirect to an address the request's address check refuses (update downloads accept GitHub hosts only).
    #[error("redirect to an address that is not allowed: {0}")]
    RedirectNotAllowed(String),
    /// The body is longer than the request's cap (1.1.4: "response too large").
    #[error("response too large")]
    TooLarge,
    /// Anything after the connection was made: reset, protocol error, body cut short.
    #[error("network error: {0}")]
    Network(String),
}

impl FetchError {
    /// Nothing reached the server: a fallback path (the system proxy after a direct attempt) may be tried.
    pub fn is_connect_failure(&self) -> bool {
        matches!(self, FetchError::Connect(_))
    }

    /// The short stable reason the usage fetchers and the token renewal report (`errorKind` in 1.1.4): a timeout or an abort is
    /// `timeout`, everything else `network`. A body that is not JSON (`bad-response`) is decided by the caller.
    pub fn kind(&self) -> &'static str {
        match self {
            FetchError::Timeout | FetchError::Aborted => "timeout",
            _ => "network",
        }
    }
}
