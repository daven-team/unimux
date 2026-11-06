//! Opening the byte stream to the server: TCP (happy eyeballs through hyper-util's connector), the proxy hop (HTTP CONNECT,
//! TLS to an HTTPS proxy, SOCKS 4 / 5) and TLS to the server. Every failure here is a `FetchError::Connect`: nothing of the
//! request has been sent yet.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use hyper_util::client::legacy::connect::HttpConnector;
use rustls::ClientConfig;
use rustls::pki_types::ServerName;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tower_service::Service;
use url::Url;

use crate::FetchError;
use crate::proxy::{ProxyChoice, ProxyScheme, ProxyServer};

pub(crate) trait Io: AsyncRead + AsyncWrite + Unpin + Send + 'static {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send + 'static> Io for T {}
pub(crate) type BoxIo = Box<dyn Io>;

/// The TLS settings of one client: one config offering h2 + http/1.1, one offering http/1.1 only.
pub(crate) struct Tls {
    pub h2: Arc<ClientConfig>,
    pub h1: Arc<ClientConfig>,
}

pub(crate) struct Connected {
    pub io: BoxIo,
    /// TLS negotiated h2.
    pub h2: bool,
    /// A plain http URL through an HTTP proxy: the request line carries the absolute URL.
    pub absolute_form: bool,
}

/// Longest proxy answer header accepted (CONNECT reply).
const MAX_PROXY_REPLY: usize = 16 * 1024;

fn connect_err(what: &str, error: impl std::fmt::Display) -> FetchError {
    FetchError::Connect(format!("{what}: {error}"))
}

/// The host as it goes into a URI authority or a CONNECT line (`[v6]` for IPv6).
fn authority_host(host: &str) -> String {
    if host.contains(':') && !host.starts_with('[') { format!("[{host}]") } else { host.to_string() }
}

pub(crate) fn url_host(url: &Url) -> Result<String, FetchError> {
    match url.host() {
        Some(url::Host::Domain(d)) => Ok(d.to_string()),
        Some(url::Host::Ipv4(ip)) => Ok(ip.to_string()),
        Some(url::Host::Ipv6(ip)) => Ok(ip.to_string()),
        None => Err(FetchError::InvalidRequest("no host".into())),
    }
}

async fn tcp(host: &str, port: u16) -> Result<TcpStream, FetchError> {
    let mut connector = HttpConnector::new();
    connector.enforce_http(false);
    connector.set_nodelay(true);
    connector.set_happy_eyeballs_timeout(Some(Duration::from_millis(300)));
    let uri: http::Uri = format!("http://{}:{port}/", authority_host(host)).parse().map_err(|e| connect_err("address", e))?;
    let stream = connector.call(uri).await.map_err(|e| connect_err("tcp", e))?;
    Ok(stream.into_inner())
}

async fn tls(io: BoxIo, host: &str, config: Arc<ClientConfig>) -> Result<(BoxIo, bool), FetchError> {
    let name = match host.parse::<IpAddr>() {
        Ok(ip) => ServerName::IpAddress(ip.into()),
        Err(_) => ServerName::try_from(host.to_string()).map_err(|e| connect_err("tls name", e))?,
    };
    let stream = TlsConnector::from(config).connect(name, io).await.map_err(|e| connect_err("tls", e))?;
    let h2 = stream.get_ref().1.alpn_protocol() == Some(b"h2");
    Ok((Box::new(stream), h2))
}

/// Connects to the server of `url` along `choice`. `user_agent` goes into a CONNECT request (proxies filter on it), nothing else.
pub(crate) async fn connect(
    url: &Url,
    choice: &ProxyChoice,
    tls_config: Arc<ClientConfig>,
    proxy_tls: Arc<ClientConfig>,
    user_agent: Option<&str>,
) -> Result<Connected, FetchError> {
    let host = url_host(url)?;
    let port = url.port_or_known_default().ok_or_else(|| FetchError::InvalidRequest("no port".into()))?;
    let secure = url.scheme() == "https";
    let (io, absolute_form): (BoxIo, bool) = match choice {
        ProxyChoice::Direct => (Box::new(tcp(&host, port).await?), false),
        ProxyChoice::Proxy(proxy) => {
            let mut io: BoxIo = Box::new(tcp(&proxy.host, proxy.port).await?);
            match proxy.scheme {
                ProxyScheme::Http | ProxyScheme::Https => {
                    if proxy.scheme == ProxyScheme::Https {
                        io = tls(io, &proxy.host, proxy_tls).await?.0;
                    }
                    if secure {
                        tunnel(&mut io, &host, port, user_agent).await?;
                        (io, false)
                    } else {
                        (io, true)
                    }
                }
                ProxyScheme::Socks5 => {
                    socks5(&mut io, &host, port).await?;
                    (io, false)
                }
                ProxyScheme::Socks4 => {
                    socks4(&mut io, proxy, &host, port).await?;
                    (io, false)
                }
            }
        }
    };
    if secure {
        let (io, h2) = tls(io, &host, tls_config).await?;
        Ok(Connected { io, h2, absolute_form: false })
    } else {
        Ok(Connected { io, h2: false, absolute_form })
    }
}

/// `CONNECT host:port` through an HTTP proxy; only a 2xx opens the tunnel.
async fn tunnel(io: &mut BoxIo, host: &str, port: u16, user_agent: Option<&str>) -> Result<(), FetchError> {
    let target = format!("{}:{port}", authority_host(host));
    let mut head = format!("CONNECT {target} HTTP/1.1\r\nHost: {target}\r\n");
    if let Some(agent) = user_agent.filter(|a| !a.contains(['\r', '\n'])) {
        head.push_str(&format!("User-Agent: {agent}\r\n"));
    }
    head.push_str("\r\n");
    io.write_all(head.as_bytes()).await.map_err(|e| connect_err("proxy", e))?;
    io.flush().await.map_err(|e| connect_err("proxy", e))?;
    // Byte by byte up to the empty line, so no byte of the TLS stream behind it is consumed.
    let mut reply = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    while !reply.ends_with(b"\r\n\r\n") {
        if reply.len() >= MAX_PROXY_REPLY {
            return Err(FetchError::Connect("proxy: reply too long".into()));
        }
        let n = io.read(&mut byte).await.map_err(|e| connect_err("proxy", e))?;
        if n == 0 {
            return Err(FetchError::Connect("proxy closed the connection".into()));
        }
        reply.push(byte[0]);
    }
    let line = reply.split(|b| *b == b'\n').next().unwrap_or_default();
    let line = String::from_utf8_lossy(line);
    let status = line.split_whitespace().nth(1).and_then(|s| s.parse::<u16>().ok());
    match status {
        Some(code) if (200..300).contains(&code) && line.starts_with("HTTP/1.") => Ok(()),
        Some(407) => Err(FetchError::Connect("proxy: authentication required (407)".into())),
        Some(code) => Err(FetchError::Connect(format!("proxy refused the tunnel ({code})"))),
        None => Err(FetchError::Connect("proxy: bad reply".into())),
    }
}

/// SOCKS v5, no authentication, the proxy resolves the name (Chromium's SOCKS5 client does the same).
async fn socks5(io: &mut BoxIo, host: &str, port: u16) -> Result<(), FetchError> {
    let err = |e: std::io::Error| connect_err("socks5", e);
    io.write_all(&[5, 1, 0]).await.map_err(err)?;
    let mut answer = [0u8; 2];
    io.read_exact(&mut answer).await.map_err(err)?;
    if answer != [5, 0] {
        return Err(FetchError::Connect("socks5: no acceptable authentication method".into()));
    }
    let mut request = vec![5, 1, 0];
    match host.parse::<IpAddr>() {
        Ok(IpAddr::V4(ip)) => {
            request.push(1);
            request.extend_from_slice(&ip.octets());
        }
        Ok(IpAddr::V6(ip)) => {
            request.push(4);
            request.extend_from_slice(&ip.octets());
        }
        Err(_) => {
            let name = host.as_bytes();
            let len = u8::try_from(name.len()).map_err(|_| FetchError::Connect("socks5: host name too long".into()))?;
            request.push(3);
            request.push(len);
            request.extend_from_slice(name);
        }
    }
    request.extend_from_slice(&port.to_be_bytes());
    io.write_all(&request).await.map_err(err)?;
    let mut head = [0u8; 4];
    io.read_exact(&mut head).await.map_err(err)?;
    if head[0] != 5 || head[1] != 0 {
        return Err(FetchError::Connect(format!("socks5: connect refused ({})", head[1])));
    }
    let skip = match head[3] {
        1 => 4,
        4 => 16,
        3 => {
            let mut len = [0u8; 1];
            io.read_exact(&mut len).await.map_err(err)?;
            usize::from(len[0])
        }
        _ => return Err(FetchError::Connect("socks5: bad reply".into())),
    };
    let mut rest = vec![0u8; skip + 2];
    io.read_exact(&mut rest).await.map_err(err)?;
    Ok(())
}

/// SOCKS v4: IPv4 only, the client resolves the name.
async fn socks4(io: &mut BoxIo, proxy: &ProxyServer, host: &str, port: u16) -> Result<(), FetchError> {
    let err = |e: std::io::Error| connect_err("socks4", e);
    let ip = tokio::net::lookup_host((host, port))
        .await
        .map_err(err)?
        .find_map(|addr: SocketAddr| match addr.ip() {
            IpAddr::V4(ip) => Some(ip),
            IpAddr::V6(_) => None,
        })
        .ok_or_else(|| FetchError::Connect(format!("socks4 ({}): no IPv4 address for the host", proxy.host)))?;
    let mut request = vec![4, 1];
    request.extend_from_slice(&port.to_be_bytes());
    request.extend_from_slice(&ip.octets());
    request.push(0);
    io.write_all(&request).await.map_err(err)?;
    let mut answer = [0u8; 8];
    io.read_exact(&mut answer).await.map_err(err)?;
    if answer[1] != 0x5a {
        return Err(FetchError::Connect(format!("socks4: connect refused ({})", answer[1])));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::net::TcpListener;

    /// SOCKS v4 (PAC "SOCKS", Internet Options "socks="): the client resolves the name and sends the IPv4 address.
    #[tokio::test]
    async fn socks4_sends_the_resolved_ipv4_address() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 9];
            stream.read_exact(&mut request).await.unwrap();
            stream.write_all(&[0, 0x5a, 0, 0, 0, 0, 0, 0]).await.unwrap();
            request
        });
        let mut io: BoxIo = Box::new(TcpStream::connect(addr).await.unwrap());
        let proxy = ProxyServer { scheme: ProxyScheme::Socks4, host: "127.0.0.1".into(), port: addr.port() };
        socks4(&mut io, &proxy, "127.0.0.1", 8080).await.unwrap();
        assert_eq!(server.await.unwrap(), [4, 1, 0x1f, 0x90, 127, 0, 0, 1, 0]);

        // A refusal (0x5b) is a connect failure.
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut request = [0u8; 9];
            stream.read_exact(&mut request).await.unwrap();
            stream.write_all(&[0, 0x5b, 0, 0, 0, 0, 0, 0]).await.unwrap();
        });
        let mut io: BoxIo = Box::new(TcpStream::connect(addr).await.unwrap());
        assert!(socks4(&mut io, &proxy, "127.0.0.1", 80).await.unwrap_err().is_connect_failure());
    }

    #[tokio::test]
    async fn connect_replies_other_than_2xx_close_the_tunnel() {
        for (reply, ok) in [
            (&b"HTTP/1.1 200 Connection established\r\n\r\n"[..], true),
            (&b"HTTP/1.0 200 OK\r\nProxy-Agent: x\r\n\r\n"[..], true),
            (&b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"[..], false),
            (&b"HTTP/1.1 502 Bad Gateway\r\n\r\n"[..], false),
            (&b"SSH-2.0-x\r\n\r\n"[..], false),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let addr = listener.local_addr().unwrap();
            let reply = reply.to_vec();
            let server = tokio::spawn(async move {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut head = Vec::new();
                let mut byte = [0u8; 1];
                while !head.ends_with(b"\r\n\r\n") {
                    stream.read_exact(&mut byte).await.unwrap();
                    head.push(byte[0]);
                }
                stream.write_all(&reply).await.unwrap();
                String::from_utf8(head).unwrap()
            });
            let mut io: BoxIo = Box::new(TcpStream::connect(addr).await.unwrap());
            let result = tunnel(&mut io, "::1", 443, Some("unimux/1.2.0")).await;
            assert_eq!(result.is_ok(), ok, "{result:?}");
            if let Err(error) = result {
                assert!(error.is_connect_failure());
            }
            assert_eq!(
                server.await.unwrap(),
                "CONNECT [::1]:443 HTTP/1.1\r\nHost: [::1]:443\r\nUser-Agent: unimux/1.2.0\r\n\r\n"
            );
        }
    }
}
