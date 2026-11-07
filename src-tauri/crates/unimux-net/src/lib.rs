//! http_fetch (B3): the HTTP client every network call of the app goes through (token renewal, usage, changelog, GitHub,
//! update feed and downloads). 1.1.4 used Electron's `net.fetch` (Chromium networking, system proxy) and, for token renewals,
//! Node's `http(s).request` with exact headers. This crate gives both in one place:
//!
//! - exactly the headers a call sets, plus `Host`, `Content-Length` with a body and `Connection: close` when asked; no
//!   library User-Agent, `Accept` or `Accept-Encoding` (built on hyper's connection API: reqwest always adds `Accept: */*`);
//! - per call: redirect policy (refuse / manual / follow with an address check per hop), timeout, body cap, HTTP/1.1 only,
//!   `Connection: close`, cancellation, and the route (direct, system proxy, direct then system proxy);
//! - TLS through rustls (ring) with the operating system's certificate verifier (like Chromium);
//! - the system proxy per URL, including PAC and WPAD, Chromium's implicit local bypass and its proxy-list fallback
//!   (see `proxy`).
//!
//! Every request opens its own connection and closes it when the answer has been read or dropped (the calls are rare: a pool
//! would gain nothing and would keep sockets open behind a proxy).

pub mod calls;
mod client;
mod connect;
mod error;
pub mod proxy;
mod request;

pub use client::{BodyStream, DEFAULT_MAX_BODY, HttpClient, HttpClientBuilder, StreamResponse};
pub use error::FetchError;
pub use http::Method;
pub use request::{DEFAULT_MAX_REDIRECTS, Headers, Redirect, Request, Response, Route, UrlCheck};
pub use tokio_util::sync::CancellationToken;
pub use url::Url;
