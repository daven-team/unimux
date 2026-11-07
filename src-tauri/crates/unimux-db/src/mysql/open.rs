//! Opening a connection the way 1.1.4's `openMysqlOnce` / `openMysqlTls` (src/dbhost/host.ts) did: one attempt per
//! stream with the connect timeout around the whole login (mysql2 `connectTimeout`), the TLS mode of the connection
//! (`disable`; `prefer`: TLS first, plain again on a new stream when the server has no TLS; `require`; `verify-full`),
//! and the stream from the caller: a TCP connection ([`connect_tcp`]) or, through SSH, a forwarded channel (D2; no local
//! port).

use std::future::Future;
use std::time::Duration;

use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;

use super::conn::{MyConn, MyLogin};
use super::error::MyError;
use super::tls::{MyTlsParams, MyTlsVerify};

/// The `tls` setting of a connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MyTlsMode {
    Disable,
    Prefer,
    Require,
    VerifyFull,
}

impl MyTlsMode {
    /// As host.ts reads it: anything but `disable` asks for TLS; only `prefer` falls back; only `verify-full` checks.
    pub fn parse(s: &str) -> MyTlsMode {
        match s {
            "disable" => MyTlsMode::Disable,
            "prefer" => MyTlsMode::Prefer,
            "verify-full" => MyTlsMode::VerifyFull,
            _ => MyTlsMode::Require,
        }
    }
}

/// Everything one login needs besides the stream.
#[derive(Debug, Clone)]
pub struct MyOpenParams {
    /// The host name the user typed (`logicalHost`): checked against the certificate and sent as SNI.
    pub host: String,
    pub tls: MyTlsMode,
    /// The CA file's text for `verify-full`.
    pub ca: Option<String>,
    pub login: MyLogin,
    /// DB_HOST_TIMERS.dbConnectMs.
    pub connect_timeout: Duration,
}

/// One login on a new stream, with or without TLS, inside the connect timeout.
pub async fn open_once<S, F, Fut>(params: &MyOpenParams, tls: bool, stream: &mut F) -> Result<MyConn<S>, MyError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<S, MyError>>,
{
    let tls_params = tls.then(|| MyTlsParams {
        host: params.host.clone(),
        verify: if params.tls == MyTlsMode::VerifyFull {
            MyTlsVerify::Full { ca_pem: params.ca.clone() }
        } else {
            MyTlsVerify::Off
        },
    });
    let attempt = async {
        let s = stream().await?;
        MyConn::connect(s, &params.login, tls_params.as_ref()).await
    };
    match tokio::time::timeout(params.connect_timeout, attempt).await {
        Ok(r) => r,
        Err(_) => Err(MyError::Timeout),
    }
}

/// `openMysqlTls`: the connection and whether it runs over TLS.
pub async fn open<S, F, Fut>(params: &MyOpenParams, mut stream: F) -> Result<(MyConn<S>, bool), MyError>
where
    S: AsyncRead + AsyncWrite + Unpin + Send,
    F: FnMut() -> Fut,
    Fut: Future<Output = Result<S, MyError>>,
{
    if params.tls == MyTlsMode::Disable {
        return Ok((open_once(params, false, &mut stream).await?, false));
    }
    match open_once(params, true, &mut stream).await {
        Ok(c) => Ok((c, true)),
        Err(MyError::TlsUnsupported) if params.tls == MyTlsMode::Prefer => {
            Ok((open_once(params, false, &mut stream).await?, false))
        }
        Err(e) => Err(e),
    }
}

/// A direct TCP connection: the name resolved (a failure is `Dns`), the addresses tried in order, TCP keep-alive on
/// (mysql2 `enableKeepAlive`) and Nagle off.
pub async fn connect_tcp(host: &str, port: u16) -> Result<TcpStream, MyError> {
    let addrs: Vec<_> = tokio::net::lookup_host((host, port)).await.map_err(|_| MyError::Dns(host.to_owned()))?.collect();
    if addrs.is_empty() {
        return Err(MyError::Dns(host.to_owned()));
    }
    let mut last = MyError::Dns(host.to_owned());
    for addr in addrs {
        match TcpStream::connect(addr).await {
            Ok(s) => {
                let _ = s.set_nodelay(true);
                let _ = socket2::SockRef::from(&s).set_keepalive(true);
                return Ok(s);
            }
            Err(e) => last = MyError::from(e),
        }
    }
    Err(last)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_as_host_ts_reads_them() {
        assert_eq!(MyTlsMode::parse("disable"), MyTlsMode::Disable);
        assert_eq!(MyTlsMode::parse("prefer"), MyTlsMode::Prefer);
        assert_eq!(MyTlsMode::parse("verify-full"), MyTlsMode::VerifyFull);
        assert_eq!(MyTlsMode::parse("require"), MyTlsMode::Require);
        assert_eq!(MyTlsMode::parse("odd"), MyTlsMode::Require);
    }

    #[tokio::test]
    async fn a_closed_port_is_refused() {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = l.local_addr().unwrap().port();
        drop(l);
        let e = connect_tcp("127.0.0.1", port).await.unwrap_err();
        assert_eq!(super::super::error::map_connect_error(&e, false), "dbRefused");
    }
}
