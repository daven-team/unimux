use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use http::Method;
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::FetchError;

/// Checks an address before it is requested (the initial URL and every redirect hop).
pub type UrlCheck = Arc<dyn Fn(&Url) -> bool + Send + Sync>;

/// What a 3xx answer does.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Redirect {
    /// fetch()'s `redirect: 'error'` (Electron net.fetch, 1.1.4's usage reads): fail with `FetchError::RedirectRefused` on a
    /// 301, 302, 303, 307 or 308 that carries a Location header (Chromium's redirect set); any other 3xx (300, 304, 305, 306,
    /// a redirect status without Location) comes back as an ordinary answer. A bearer token never follows a redirect.
    Error,
    /// 1.1.4's Node token transport (tokenTransport.ts directFetch): fail with `FetchError::RedirectRefused` on every status
    /// from 300 to 399, 304 and a missing Location included.
    ErrorAny3xx,
    /// Hand the 3xx back as the response.
    Manual,
    /// Follow up to `max` hops (fetch's 20 by default); each hop is checked with the request's address check, if any.
    Follow { max: u32 },
}

/// Which network path the request takes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Route {
    /// Always a direct connection.
    Direct,
    /// The system proxy for this URL (Internet Options / PAC / WPAD on Windows, CFNetwork on macOS), like Electron's net.fetch.
    System,
    /// Direct first; only when no connection could be made at all, the system proxy path (1.1.4's token renewal).
    DirectThenSystem,
}

/// One HTTP request. Only the headers given here are sent, plus `Host`, `Content-Length` (when there is a body) and
/// `Connection: close` (when asked): no User-Agent, Accept or Accept-Encoding of the library's own.
#[derive(Clone)]
pub struct Request {
    pub method: Method,
    pub url: Url,
    pub headers: Vec<(String, String)>,
    pub body: Option<Bytes>,
    /// Covers connecting, the answer's headers and, for `HttpClient::fetch`, the whole body. None = no limit.
    pub timeout: Option<Duration>,
    pub redirect: Redirect,
    /// Longest accepted body in bytes; `HttpClient::fetch` uses `DEFAULT_MAX_BODY` when None.
    pub max_body: Option<u64>,
    /// Speak HTTP/1.1 only (no h2 in the TLS ALPN offer).
    pub http1_only: bool,
    /// Send `Connection: close` (implies HTTP/1.1).
    pub connection_close: bool,
    pub route: Route,
    pub cancel: Option<CancellationToken>,
    pub url_check: Option<UrlCheck>,
}

impl fmt::Debug for Request {
    /// Header values and the body are left out: they may hold tokens.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Request")
            .field("method", &self.method)
            .field("url", &self.url.as_str())
            .field("headers", &self.headers.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>())
            .field("body", &self.body.as_ref().map(Bytes::len))
            .field("timeout", &self.timeout)
            .field("redirect", &self.redirect)
            .field("max_body", &self.max_body)
            .field("http1_only", &self.http1_only)
            .field("connection_close", &self.connection_close)
            .field("route", &self.route)
            .finish_non_exhaustive()
    }
}

/// fetch()'s redirect limit.
pub const DEFAULT_MAX_REDIRECTS: u32 = 20;

impl Request {
    pub fn new(method: Method, url: &str) -> Result<Self, FetchError> {
        let url = Url::parse(url).map_err(|e| FetchError::InvalidRequest(format!("bad URL: {e}")))?;
        check_url(&url)?;
        Ok(Request {
            method,
            url,
            headers: Vec::new(),
            body: None,
            timeout: None,
            redirect: Redirect::Follow { max: DEFAULT_MAX_REDIRECTS },
            max_body: None,
            http1_only: false,
            connection_close: false,
            route: Route::System,
            cancel: None,
            url_check: None,
        })
    }

    pub fn get(url: &str) -> Result<Self, FetchError> {
        Self::new(Method::GET, url)
    }

    pub fn post(url: &str) -> Result<Self, FetchError> {
        Self::new(Method::POST, url)
    }

    pub fn header(mut self, name: &str, value: &str) -> Self {
        self.headers.push((name.to_string(), value.to_string()));
        self
    }

    pub fn body(mut self, body: impl Into<Bytes>) -> Self {
        self.body = Some(body.into());
        self
    }

    pub fn timeout(mut self, timeout: Duration) -> Self {
        self.timeout = Some(timeout);
        self
    }

    pub fn redirect(mut self, redirect: Redirect) -> Self {
        self.redirect = redirect;
        self
    }

    pub fn max_body(mut self, bytes: u64) -> Self {
        self.max_body = Some(bytes);
        self
    }

    pub fn http1_only(mut self) -> Self {
        self.http1_only = true;
        self
    }

    pub fn connection_close(mut self) -> Self {
        self.connection_close = true;
        self
    }

    pub fn route(mut self, route: Route) -> Self {
        self.route = route;
        self
    }

    pub fn cancel(mut self, token: CancellationToken) -> Self {
        self.cancel = Some(token);
        self
    }

    pub fn url_check(mut self, check: UrlCheck) -> Self {
        self.url_check = Some(check);
        self
    }
}

/// http and https only, no credentials in the address (fetch() refuses those too).
pub(crate) fn check_url(url: &Url) -> Result<(), FetchError> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err(FetchError::InvalidRequest(format!("unsupported scheme {}", url.scheme())));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(FetchError::InvalidRequest("credentials in the URL".into()));
    }
    if url.host().is_none() {
        return Err(FetchError::InvalidRequest("no host".into()));
    }
    Ok(())
}

/// Response headers as received: lower-case names, in order, repeated names kept; values read as Latin-1 like fetch's Headers.
#[derive(Clone, Debug, Default)]
pub struct Headers(pub Vec<(String, String)>);

impl Headers {
    /// fetch's `headers.get`: every value of the name joined with ", ", None when absent.
    pub fn get(&self, name: &str) -> Option<String> {
        let mut values = self.0.iter().filter(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()).peekable();
        values.peek()?;
        Some(values.collect::<Vec<_>>().join(", "))
    }

    pub fn get_all(&self, name: &str) -> Vec<&str> {
        self.0.iter().filter(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str()).collect()
    }
}

/// A buffered answer.
#[derive(Clone)]
pub struct Response {
    pub status: u16,
    pub headers: Headers,
    /// The address that answered (after redirects).
    pub url: Url,
    pub redirected: bool,
    pub body: Bytes,
}

impl fmt::Debug for Response {
    /// Header values and the body are left out: a token renewal answer carries the new tokens.
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Response")
            .field("status", &self.status)
            .field("url", &self.url.as_str())
            .field("redirected", &self.redirected)
            .field("headers", &self.headers.0.iter().map(|(n, _)| n.as_str()).collect::<Vec<_>>())
            .field("body", &self.body.len())
            .finish()
    }
}

impl Response {
    /// 200 to 299, like fetch's `response.ok`.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn header(&self, name: &str) -> Option<String> {
        self.headers.get(name)
    }

    /// The body as text (UTF-8, invalid sequences replaced, a leading BOM dropped, like `response.text()`).
    pub fn text(&self) -> String {
        let text = String::from_utf8_lossy(&self.body);
        text.strip_prefix('\u{feff}').map(str::to_string).unwrap_or_else(|| text.into_owned())
    }

    /// The body as JSON (`response.json()`); Err for a body that is not JSON.
    pub fn json(&self) -> Result<serde_json::Value, serde_json::Error> {
        serde_json::from_str(&self.text())
    }
}
