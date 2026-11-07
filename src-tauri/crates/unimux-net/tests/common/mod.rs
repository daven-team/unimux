//! Local servers for the http_fetch tests: a raw HTTP/1.1 server that records exactly what arrived on the wire (header names
//! as sent, in order), an HTTP proxy (absolute-form requests and CONNECT tunnels), a SOCKS5 proxy, TLS (a throwaway CA from
//! rcgen) and an h2 server.
#![allow(dead_code)]

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use parking_lot::Mutex;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

#[derive(Clone, Debug, Default)]
pub struct Seen {
    pub method: String,
    pub target: String,
    pub version: String,
    /// Header names exactly as sent, in order.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
}

impl Seen {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(n, _)| n.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
    /// Lower-cased names, sorted (the TS test's `Object.keys(req.headers).sort()`).
    pub fn names_sorted(&self) -> Vec<String> {
        let mut names: Vec<String> = self.headers.iter().map(|(n, _)| n.to_ascii_lowercase()).collect();
        names.sort();
        names
    }
}

pub enum Reply {
    Bytes(Vec<u8>),
    /// Never answers (keeps the connection open).
    Hang,
    /// Closes the connection without answering.
    Drop,
    /// Answers after a pause.
    Later(Duration, Vec<u8>),
    /// Sends the head, then the body in pieces with pauses (chunked transfer).
    Chunked(Vec<u8>, Vec<Vec<u8>>),
}

pub type Answer = Arc<dyn Fn(&Seen) -> Reply + Send + Sync>;

pub fn answer(f: impl Fn(&Seen) -> Reply + Send + Sync + 'static) -> Answer {
    Arc::new(f)
}

pub fn reply(status: u16, headers: &[(&str, &str)], body: &[u8]) -> Reply {
    let mut out = format!("HTTP/1.1 {status} X\r\n");
    for (n, v) in headers {
        out.push_str(&format!("{n}: {v}\r\n"));
    }
    out.push_str(&format!("content-length: {}\r\nconnection: close\r\n\r\n", body.len()));
    let mut bytes = out.into_bytes();
    bytes.extend_from_slice(body);
    Reply::Bytes(bytes)
}

pub fn json(status: u16, body: &str) -> Reply {
    reply(status, &[("content-type", "application/json")], body.as_bytes())
}

async fn read_head<S: AsyncRead + Unpin>(stream: &mut S) -> Option<Vec<u8>> {
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        if stream.read(&mut byte).await.ok()? == 0 {
            return None;
        }
        head.push(byte[0]);
        if head.len() > 64 * 1024 {
            return None;
        }
    }
    Some(head)
}

fn parse_head(head: &[u8]) -> Seen {
    let text = String::from_utf8_lossy(head);
    let mut lines = text.split("\r\n");
    let first = lines.next().unwrap_or_default();
    let mut parts = first.split(' ');
    let mut seen = Seen {
        method: parts.next().unwrap_or_default().to_string(),
        target: parts.next().unwrap_or_default().to_string(),
        version: parts.next().unwrap_or_default().to_string(),
        ..Default::default()
    };
    for line in lines.filter(|l| !l.is_empty()) {
        if let Some((n, v)) = line.split_once(':') {
            seen.headers.push((n.to_string(), v.trim().to_string()));
        }
    }
    seen
}

/// Reads one request (head + Content-Length body), records it, answers.
pub async fn serve_one<S: AsyncRead + AsyncWrite + Unpin>(mut stream: S, seen: &Mutex<Vec<Seen>>, answer: &Answer) {
    let Some(head) = read_head(&mut stream).await else { return };
    let mut request = parse_head(&head);
    let len = request.header("content-length").and_then(|v| v.parse::<usize>().ok()).unwrap_or(0);
    let mut body = vec![0u8; len];
    if stream.read_exact(&mut body).await.is_err() {
        return;
    }
    request.body = body;
    seen.lock().push(request.clone());
    match answer(&request) {
        Reply::Bytes(bytes) => {
            let _ = stream.write_all(&bytes).await;
            let _ = stream.flush().await;
            let _ = stream.shutdown().await;
        }
        Reply::Later(pause, bytes) => {
            tokio::time::sleep(pause).await;
            let _ = stream.write_all(&bytes).await;
            let _ = stream.shutdown().await;
        }
        Reply::Hang => {
            let mut sink = [0u8; 64];
            while matches!(stream.read(&mut sink).await, Ok(n) if n > 0) {}
        }
        Reply::Drop => {}
        Reply::Chunked(head, pieces) => {
            let _ = stream.write_all(&head).await;
            for piece in pieces {
                let _ = stream.write_all(format!("{:x}\r\n", piece.len()).as_bytes()).await;
                let _ = stream.write_all(&piece).await;
                let _ = stream.write_all(b"\r\n").await;
                let _ = stream.flush().await;
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let _ = stream.write_all(b"0\r\n\r\n").await;
            let _ = stream.shutdown().await;
        }
    }
}

pub struct Server {
    pub addr: SocketAddr,
    pub seen: Arc<Mutex<Vec<Seen>>>,
    pub connections: Arc<Mutex<u32>>,
}

impl Server {
    pub fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.addr)
    }
    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().clone()
    }
}

pub async fn http_server(answer: Answer) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let connections = Arc::new(Mutex::new(0));
    let (s, c) = (seen.clone(), connections.clone());
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            *c.lock() += 1;
            let (s, answer) = (s.clone(), answer.clone());
            tokio::spawn(async move { serve_one(stream, &s, &answer).await });
        }
    });
    Server { addr, seen, connections }
}

/// A port nothing listens on.
pub async fn closed_port() -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    listener.local_addr().unwrap().port()
}

/// An HTTP proxy: CONNECT opens a tunnel to `tunnel_to` (whatever host was asked for); any other request is answered by
/// `answer` itself (absolute-form). Records every request head.
pub async fn http_proxy(tunnel_to: Option<SocketAddr>, answer: Answer) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let connections = Arc::new(Mutex::new(0));
    let (s, c) = (seen.clone(), connections.clone());
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            *c.lock() += 1;
            let (s, answer) = (s.clone(), answer.clone());
            tokio::spawn(async move {
                let mut peek = [0u8; 8];
                let n = stream.peek(&mut peek).await.unwrap_or(0);
                if &peek[..n.min(8)] == b"CONNECT " {
                    let Some(head) = read_head(&mut stream).await else { return };
                    s.lock().push(parse_head(&head));
                    let Some(to) = tunnel_to else {
                        let _ = stream.write_all(b"HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n").await;
                        return;
                    };
                    let Ok(mut upstream) = TcpStream::connect(to).await else { return };
                    let _ = stream.write_all(b"HTTP/1.1 200 Connection established\r\n\r\n").await;
                    let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
                } else {
                    serve_one(stream, &s, &answer).await;
                }
            });
        }
    });
    Server { addr, seen, connections }
}

/// A SOCKS5 proxy (no auth) that records the requested `host:port` and tunnels to `tunnel_to`.
pub async fn socks5_proxy(tunnel_to: SocketAddr) -> (SocketAddr, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let a = asked.clone();
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let a = a.clone();
            tokio::spawn(async move {
                let mut greeting = [0u8; 3];
                if stream.read_exact(&mut greeting).await.is_err() || greeting != [5, 1, 0] {
                    return;
                }
                let _ = stream.write_all(&[5, 0]).await;
                let mut head = [0u8; 4];
                if stream.read_exact(&mut head).await.is_err() {
                    return;
                }
                let host = match head[3] {
                    3 => {
                        let mut len = [0u8; 1];
                        let _ = stream.read_exact(&mut len).await;
                        let mut name = vec![0u8; usize::from(len[0])];
                        let _ = stream.read_exact(&mut name).await;
                        String::from_utf8_lossy(&name).into_owned()
                    }
                    1 => {
                        let mut ip = [0u8; 4];
                        let _ = stream.read_exact(&mut ip).await;
                        std::net::Ipv4Addr::from(ip).to_string()
                    }
                    _ => return,
                };
                let mut port = [0u8; 2];
                let _ = stream.read_exact(&mut port).await;
                a.lock().push(format!("{host}:{}", u16::from_be_bytes(port)));
                let Ok(mut upstream) = TcpStream::connect(tunnel_to).await else { return };
                let _ = stream.write_all(&[5, 0, 0, 1, 127, 0, 0, 1, 0, 0]).await;
                let _ = tokio::io::copy_bidirectional(&mut stream, &mut upstream).await;
            });
        }
    });
    (addr, asked)
}

pub struct TestCa {
    pub ca_der: Vec<u8>,
    pub leaf_der: Vec<u8>,
    pub leaf_key: Vec<u8>,
}

/// A CA and a server certificate for the given names (signed by it).
pub fn test_ca(names: &[&str]) -> TestCa {
    let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca_params.distinguished_name.push(rcgen::DnType::CommonName, "unimux B3 test CA");
    ca_params.key_usages = vec![rcgen::KeyUsagePurpose::KeyCertSign, rcgen::KeyUsagePurpose::CrlSign];
    let ca_key = rcgen::KeyPair::generate().unwrap();
    let ca = rcgen::CertifiedIssuer::self_signed(ca_params, ca_key).unwrap();
    let mut leaf_params = rcgen::CertificateParams::new(names.iter().map(|n| n.to_string()).collect::<Vec<_>>()).unwrap();
    leaf_params.distinguished_name.push(rcgen::DnType::CommonName, names[0]);
    leaf_params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
    let leaf_key = rcgen::KeyPair::generate().unwrap();
    let leaf = leaf_params.signed_by(&leaf_key, &ca).unwrap();
    TestCa { ca_der: ca.der().to_vec(), leaf_der: leaf.der().to_vec(), leaf_key: leaf_key.serialize_der() }
}

pub fn server_tls(ca: &TestCa, alpn: &[&[u8]]) -> Arc<rustls::ServerConfig> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ServerConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![CertificateDer::from(ca.leaf_der.clone())],
            PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(ca.leaf_key.clone())),
        )
        .unwrap();
    config.alpn_protocols = alpn.iter().map(|p| p.to_vec()).collect();
    Arc::new(config)
}

/// HTTPS (HTTP/1.1) server with the raw recorder behind TLS.
pub async fn https_server(ca: &TestCa, answer: Answer) -> Server {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let connections = Arc::new(Mutex::new(0));
    let acceptor = tokio_rustls::TlsAcceptor::from(server_tls(ca, &[b"http/1.1"]));
    let (s, c) = (seen.clone(), connections.clone());
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            *c.lock() += 1;
            let (s, answer, acceptor) = (s.clone(), answer.clone(), acceptor.clone());
            tokio::spawn(async move {
                if let Ok(tls) = acceptor.accept(stream).await {
                    serve_one(tls, &s, &answer).await;
                }
            });
        }
    });
    Server { addr, seen, connections }
}

/// HTTPS server offering h2 (and http/1.1); records the protocol version and header names hyper parsed.
pub async fn h2_server(ca: &TestCa) -> Server {
    use http_body_util::Full;
    use hyper::service::service_fn;
    use hyper_util::rt::{TokioExecutor, TokioIo};
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let connections = Arc::new(Mutex::new(0));
    let acceptor = tokio_rustls::TlsAcceptor::from(server_tls(ca, &[b"h2", b"http/1.1"]));
    let (s, c) = (seen.clone(), connections.clone());
    tokio::spawn(async move {
        while let Ok((stream, _)) = listener.accept().await {
            *c.lock() += 1;
            let (s, acceptor) = (s.clone(), acceptor.clone());
            tokio::spawn(async move {
                let Ok(tls) = acceptor.accept(stream).await else { return };
                let h2 = tls.get_ref().1.alpn_protocol() == Some(b"h2");
                let service = service_fn(move |req: hyper::Request<hyper::body::Incoming>| {
                    let s = s.clone();
                    async move {
                        s.lock().push(Seen {
                            method: req.method().to_string(),
                            target: req.uri().to_string(),
                            version: format!("{:?}", req.version()),
                            headers: req
                                .headers()
                                .iter()
                                .map(|(n, v)| (n.to_string(), v.to_str().unwrap_or("").to_string()))
                                .collect(),
                            body: Vec::new(),
                        });
                        Ok::<_, std::convert::Infallible>(hyper::Response::new(Full::new(Bytes::from_static(b"h2 ok"))))
                    }
                });
                if h2 {
                    let _ = hyper::server::conn::http2::Builder::new(TokioExecutor::new())
                        .serve_connection(TokioIo::new(tls), service)
                        .await;
                } else {
                    let _ = hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(tls), service).await;
                }
            });
        }
    });
    Server { addr, seen, connections }
}

/// Serves one fixed body (a PAC script) on every request.
pub async fn file_server(content_type: &'static str, body: String) -> Server {
    http_server(answer(move |_| reply(200, &[("content-type", content_type)], body.as_bytes()))).await
}
