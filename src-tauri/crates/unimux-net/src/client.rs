use std::future::Future;
use std::sync::Arc;

use bytes::{Bytes, BytesMut};
use http::header::{HeaderName, HeaderValue, LOCATION};
use http::{Method, Version};
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper_util::rt::{TokioExecutor, TokioIo};
use rustls::ClientConfig;
use rustls::pki_types::CertificateDer;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use url::{Position, Url};

use crate::FetchError;
use crate::connect::{Connected, Tls, connect};
use crate::proxy::{ProxyChoice, ProxyResolver, SystemProxy, implicitly_bypassed};
use crate::request::{Headers, Redirect, Request, Response, Route, check_url};

/// Body cap of `HttpClient::fetch` when the request sets none (a buffered body lives in memory).
pub const DEFAULT_MAX_BODY: u64 = 32 * 1024 * 1024;

/// The HTTP client of the app: one per process is enough (it holds no connections; every request opens its own, and closes it
/// when the answer is read or dropped).
#[derive(Clone)]
pub struct HttpClient {
    inner: Arc<Inner>,
}

struct Inner {
    resolver: Arc<dyn ProxyResolver>,
    tls: Tls,
}

#[derive(Default)]
pub struct HttpClientBuilder {
    resolver: Option<Arc<dyn ProxyResolver>>,
    extra_roots: Vec<CertificateDer<'static>>,
}

impl HttpClientBuilder {
    /// Who decides the proxy per URL (default: the operating system's settings).
    pub fn proxy_resolver(mut self, resolver: Arc<dyn ProxyResolver>) -> Self {
        self.resolver = Some(resolver);
        self
    }

    /// Certificates trusted in addition to the system store (tests with a local TLS server).
    pub fn extra_root(mut self, der: Vec<u8>) -> Self {
        self.extra_roots.push(CertificateDer::from(der));
        self
    }

    pub fn build(self) -> Result<HttpClient, FetchError> {
        let provider = Arc::new(rustls::crypto::ring::default_provider());
        let verifier = if self.extra_roots.is_empty() {
            rustls_platform_verifier::Verifier::new(provider.clone())
        } else {
            rustls_platform_verifier::Verifier::new_with_extra_roots(self.extra_roots, provider.clone())
        }
        .map_err(|e| FetchError::InvalidRequest(format!("TLS setup: {e}")))?;
        let base = ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map_err(|e| FetchError::InvalidRequest(format!("TLS setup: {e}")))?
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(verifier))
            .with_no_client_auth();
        let mut h2 = base.clone();
        h2.alpn_protocols = vec![b"h2".to_vec(), b"http/1.1".to_vec()];
        let mut h1 = base;
        h1.alpn_protocols = vec![b"http/1.1".to_vec()];
        Ok(HttpClient {
            inner: Arc::new(Inner {
                resolver: self.resolver.unwrap_or_else(|| Arc::new(SystemProxy::new())),
                tls: Tls { h2: Arc::new(h2), h1: Arc::new(h1) },
            }),
        })
    }
}

/// Aborts the connection task when the answer is dropped.
struct ConnTask(tokio::task::AbortHandle);

impl Drop for ConnTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// An answer whose body is read piece by piece (downloads).
pub struct StreamResponse {
    pub status: u16,
    pub headers: Headers,
    pub url: Url,
    pub redirected: bool,
    pub body: BodyStream,
}

impl StreamResponse {
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub fn header(&self, name: &str) -> Option<String> {
        self.headers.get(name)
    }

    /// `Content-Length`, when the server sent a valid one.
    pub fn content_length(&self) -> Option<u64> {
        self.headers.get("content-length").and_then(|v| v.trim().parse().ok())
    }
}

pub struct BodyStream {
    body: Incoming,
    cancel: Option<CancellationToken>,
    max: Option<u64>,
    read: u64,
    _conn: ConnTask,
}

impl BodyStream {
    /// The next piece of the body; None at its end. Fails with `TooLarge` past the request's cap and `Aborted` when the
    /// request's token fires.
    pub async fn chunk(&mut self) -> Result<Option<Bytes>, FetchError> {
        loop {
            let cancel = self.cancel.clone();
            let frame = guarded(None, cancel.as_ref(), async { Ok(self.body.frame().await) }).await?;
            match frame {
                None => return Ok(None),
                Some(Err(e)) => return Err(FetchError::Network(format!("body: {e}"))),
                Some(Ok(frame)) => {
                    let Ok(data) = frame.into_data() else { continue };
                    if data.is_empty() {
                        continue;
                    }
                    self.read += data.len() as u64;
                    if self.max.is_some_and(|max| self.read > max) {
                        return Err(FetchError::TooLarge);
                    }
                    return Ok(Some(data));
                }
            }
        }
    }

    /// Bytes read so far.
    pub fn read(&self) -> u64 {
        self.read
    }

    async fn read_all(mut self) -> Result<Bytes, FetchError> {
        let mut out = BytesMut::new();
        while let Some(chunk) = self.chunk().await? {
            out.extend_from_slice(&chunk);
        }
        Ok(out.freeze())
    }
}

/// Runs `fut` until the deadline or the token, whichever comes first.
async fn guarded<T>(
    deadline: Option<Instant>,
    cancel: Option<&CancellationToken>,
    fut: impl Future<Output = Result<T, FetchError>>,
) -> Result<T, FetchError> {
    let timeout = async {
        match deadline {
            Some(at) => tokio::time::sleep_until(at).await,
            None => std::future::pending().await,
        }
    };
    let cancelled = async {
        match cancel {
            Some(token) => token.cancelled().await,
            None => std::future::pending().await,
        }
    };
    tokio::select! {
        biased;
        _ = cancelled => Err(FetchError::Aborted),
        _ = timeout => Err(FetchError::Timeout),
        result = fut => result,
    }
}

fn latin1(value: &[u8]) -> String {
    value.iter().map(|b| char::from(*b)).collect()
}

/// Headers a request body brings along; dropped when a redirect turns the request into a GET.
const BODY_HEADERS: [&str; 4] = ["content-type", "content-encoding", "content-language", "content-location"];
/// Credentials that never cross to another origin on a redirect.
const ORIGIN_HEADERS: [&str; 3] = ["authorization", "cookie", "proxy-authorization"];
/// Connection-specific headers HTTP/2 forbids.
const H1_ONLY: [&str; 6] = ["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "host"];

/// One hop of a request (the method, headers and body change on redirects).
struct Hop<'a> {
    method: Method,
    url: Url,
    headers: Vec<(String, String)>,
    body: Option<Bytes>,
    req: &'a Request,
}

impl HttpClient {
    pub fn new() -> Result<Self, FetchError> {
        Self::builder().build()
    }

    pub fn builder() -> HttpClientBuilder {
        HttpClientBuilder::default()
    }

    /// Sends the request and reads the whole body (capped by `max_body`, `DEFAULT_MAX_BODY` by default) within the timeout.
    pub async fn fetch(&self, req: Request) -> Result<Response, FetchError> {
        let deadline = req.timeout.map(|t| Instant::now() + t);
        let cancel = req.cancel.clone();
        let cap = req.max_body.unwrap_or(DEFAULT_MAX_BODY);
        guarded(deadline, cancel.as_ref(), async move {
            let mut stream = self.open(req).await?;
            if stream.content_length().is_some_and(|len| len > cap) {
                return Err(FetchError::TooLarge);
            }
            stream.body.max = Some(cap);
            let body = stream.body.read_all().await?;
            Ok(Response { status: stream.status, headers: stream.headers, url: stream.url, redirected: stream.redirected, body })
        })
        .await
    }

    /// Sends the request and returns once the answer's headers are in (the timeout covers only that far); the body is read
    /// through `StreamResponse::body`, which honours the request's cancellation token and `max_body`.
    pub async fn fetch_stream(&self, req: Request) -> Result<StreamResponse, FetchError> {
        let deadline = req.timeout.map(|t| Instant::now() + t);
        let cancel = req.cancel.clone();
        guarded(deadline, cancel.as_ref(), self.open(req)).await
    }

    /// The proxy list for `url` as this client would use it with `Route::System`.
    pub async fn proxies_for(&self, url: &Url) -> Vec<ProxyChoice> {
        if implicitly_bypassed(url) {
            return vec![ProxyChoice::Direct];
        }
        let resolver = self.inner.resolver.clone();
        let url = url.clone();
        let list = tokio::task::spawn_blocking(move || resolver.resolve(&url)).await.unwrap_or_default();
        if list.is_empty() { vec![ProxyChoice::Direct] } else { list }
    }

    async fn open(&self, req: Request) -> Result<StreamResponse, FetchError> {
        check_url(&req.url)?;
        if let Some(check) = &req.url_check
            && !check(&req.url)
        {
            return Err(FetchError::AddressNotAllowed(req.url.to_string()));
        }
        let mut hop = Hop {
            method: req.method.clone(),
            url: req.url.clone(),
            headers: req.headers.clone(),
            body: req.body.clone(),
            req: &req,
        };
        let mut hops = 0u32;
        loop {
            let (response, conn) = self.send(&hop).await?;
            let status = response.status().as_u16();
            let location = response.headers().get(LOCATION).map(|v| latin1(v.as_bytes()));
            match req.redirect {
                Redirect::Error if (300..400).contains(&status) && status != 304 => {
                    return Err(FetchError::RedirectRefused { status, location });
                }
                Redirect::Follow { max } if matches!(status, 301 | 302 | 303 | 307 | 308) && location.is_some() => {
                    let location = location.unwrap_or_default();
                    let next = hop.url.join(&location).map_err(|_| FetchError::Network("bad redirect address".into()))?;
                    if hops >= max {
                        return Err(FetchError::TooManyRedirects);
                    }
                    hops += 1;
                    if check_url(&next).is_err() || req.url_check.as_ref().is_some_and(|check| !check(&next)) {
                        return Err(FetchError::RedirectNotAllowed(next.to_string()));
                    }
                    drop(response);
                    drop(conn);
                    let to_get = (status == 303 && hop.method != Method::HEAD)
                        || (matches!(status, 301 | 302) && hop.method == Method::POST);
                    if to_get {
                        hop.method = Method::GET;
                        hop.body = None;
                        hop.headers.retain(|(n, _)| !BODY_HEADERS.iter().any(|b| n.eq_ignore_ascii_case(b)));
                    }
                    if next.origin() != hop.url.origin() {
                        hop.headers.retain(|(n, _)| !ORIGIN_HEADERS.iter().any(|b| n.eq_ignore_ascii_case(b)));
                    }
                    hop.url = next;
                }
                _ => {
                    let headers =
                        Headers(response.headers().iter().map(|(n, v)| (n.as_str().to_string(), latin1(v.as_bytes()))).collect());
                    return Ok(StreamResponse {
                        status,
                        headers,
                        url: hop.url,
                        redirected: hops > 0,
                        body: BodyStream {
                            body: response.into_body(),
                            cancel: req.cancel.clone(),
                            max: req.max_body,
                            read: 0,
                            _conn: conn,
                        },
                    });
                }
            }
        }
    }

    async fn send(&self, hop: &Hop<'_>) -> Result<(hyper::Response<Incoming>, ConnTask), FetchError> {
        match hop.req.route {
            Route::Direct => self.send_via(hop, &[ProxyChoice::Direct]).await,
            Route::System => {
                let list = self.proxies_for(&hop.url).await;
                self.send_via(hop, &list).await
            }
            Route::DirectThenSystem => match self.send_via(hop, &[ProxyChoice::Direct]).await {
                Err(error) if error.is_connect_failure() && !hop.req.cancel.as_ref().is_some_and(|c| c.is_cancelled()) => {
                    let list = self.proxies_for(&hop.url).await;
                    self.send_via(hop, &list).await
                }
                other => other,
            },
        }
    }

    /// Tries the choices in order while they cannot be reached (Chromium's proxy fallback); the first connection carries the
    /// request.
    async fn send_via(
        &self,
        hop: &Hop<'_>,
        choices: &[ProxyChoice],
    ) -> Result<(hyper::Response<Incoming>, ConnTask), FetchError> {
        let one_protocol = hop.req.http1_only || hop.req.connection_close;
        let tls = if one_protocol { self.inner.tls.h1.clone() } else { self.inner.tls.h2.clone() };
        let agent = hop.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case("user-agent")).map(|(_, v)| v.as_str());
        let mut last = FetchError::Connect("no route".into());
        for choice in choices {
            match connect(&hop.url, choice, tls.clone(), self.inner.tls.h1.clone(), agent).await {
                Ok(connected) => return exchange(connected, hop).await,
                Err(error) if error.is_connect_failure() => last = error,
                Err(error) => return Err(error),
            }
        }
        Err(last)
    }
}

fn has(headers: &[(String, String)], name: &str) -> bool {
    headers.iter().any(|(n, _)| n.eq_ignore_ascii_case(name))
}

fn header_pair(name: &str, value: &str) -> Result<(HeaderName, HeaderValue), FetchError> {
    let name =
        HeaderName::from_bytes(name.as_bytes()).map_err(|_| FetchError::InvalidRequest(format!("bad header name {name:?}")))?;
    let value = HeaderValue::from_str(value).map_err(|_| FetchError::InvalidRequest(format!("bad value for header {name}")))?;
    Ok((name, value))
}

async fn exchange(connected: Connected, hop: &Hop<'_>) -> Result<(hyper::Response<Incoming>, ConnTask), FetchError> {
    let url = &hop.url;
    let h2 = connected.h2;
    let target = if h2 || connected.absolute_form {
        &url[..Position::AfterQuery]
    } else {
        &url[Position::BeforePath..Position::AfterQuery]
    };
    let mut builder = http::Request::builder().method(hop.method.clone()).uri(target).version(if h2 {
        Version::HTTP_2
    } else {
        Version::HTTP_11
    });
    let headers = builder.headers_mut().ok_or_else(|| FetchError::InvalidRequest("bad request".into()))?;
    for (name, value) in &hop.headers {
        if h2 && H1_ONLY.iter().any(|h| name.eq_ignore_ascii_case(h)) {
            continue;
        }
        let (name, value) = header_pair(name, value)?;
        headers.append(name, value);
    }
    if let Some(body) = &hop.body
        && !has(&hop.headers, "content-length")
    {
        headers.append(http::header::CONTENT_LENGTH, HeaderValue::from(body.len()));
    }
    if !h2 && hop.req.connection_close && !has(&hop.headers, "connection") {
        headers.append(http::header::CONNECTION, HeaderValue::from_static("close"));
    }
    // Host last, after the caller's headers, Content-Length and Connection: the order Node's http.request (1.1.4's token
    // transport) puts on the wire. hyper writes header names in lower case (Node writes "Host"); names are case-insensitive.
    if !h2 && !has(&hop.headers, "host") {
        headers.append(http::header::HOST, header_pair("host", &url[Position::BeforeHost..Position::AfterPort])?.1);
    }
    let request = builder
        .body(Full::new(hop.body.clone().unwrap_or_default()))
        .map_err(|e| FetchError::InvalidRequest(format!("bad request: {e}")))?;
    let io = TokioIo::new(connected.io);
    if h2 {
        let (mut sender, conn) = hyper::client::conn::http2::Builder::new(TokioExecutor::new())
            .handshake::<_, Full<Bytes>>(io)
            .await
            .map_err(|e| FetchError::Network(format!("h2: {e}")))?;
        let task = ConnTask(
            tokio::spawn(async move {
                let _ = conn.await;
            })
            .abort_handle(),
        );
        let response = sender.send_request(request).await.map_err(|e| FetchError::Network(format!("{e}")))?;
        Ok((response, task))
    } else {
        let (mut sender, conn) = hyper::client::conn::http1::Builder::new()
            .handshake::<_, Full<Bytes>>(io)
            .await
            .map_err(|e| FetchError::Network(format!("http1: {e}")))?;
        let task = ConnTask(
            tokio::spawn(async move {
                let _ = conn.await;
            })
            .abort_handle(),
        );
        let response = sender.send_request(request).await.map_err(|e| FetchError::Network(format!("{e}")))?;
        Ok((response, task))
    }
}
