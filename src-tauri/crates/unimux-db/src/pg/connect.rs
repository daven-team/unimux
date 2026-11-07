//! Opening a Postgres session (`connectOnce` / `connectTls` / `connectWithPassword` and the Postgres half of `start` in
//! src/dbhost/host.ts): a fresh stream from a [`Connector`] (TCP, or a channel through the SSH tunnel: no local port),
//! SSLRequest and TLS by the connection's mode (prefer falls back to a plain connection when the server has no TLS), the
//! login (asking for the password when the server wants one and none is saved, or the saved one is refused; at most three
//! questions), then the session settings and `SHOW server_version`.
//!
//! Every attempt (stream, TLS, startup) has the 20 s limit of 1.1.4 (`dbConnectMs`). Dropping the returned future stops
//! the attempt (a closed session). Unlike node-postgres, nothing is read from the environment (`PGOPTIONS`, `PGPASSWORD`,
//! `~/.pgpass`): only the connection's own settings reach the server.

use std::time::Duration;

use futures::future::BoxFuture;
use serde_json::Value;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpSocket, lookup_host};
use tokio_rustls::TlsConnector;
use zeroize::Zeroizing;

use super::client::{PgClient, PgStream, StartupParams};
use super::error::{ConnectError, OpenError};
use super::tls::{TlsMode, client_config, handshake_error, server_name};
use crate::wire::pg::PgWireError;
use crate::wire::value::utf16_head;

/// `DB_HOST_TIMERS.dbConnectMs`: one connect attempt (TCP, TLS and the server's startup).
pub const DB_CONNECT_MS: u64 = 20_000;
/// 1.1.4's limit for the protocol CancelRequest connection.
pub const CANCEL_CONNECT_MS: u64 = 5_000;
/// `MAX_PASSWORD_PROMPTS`.
pub const MAX_PASSWORD_PROMPTS: u32 = 3;
/// The SSLRequest code.
const SSL_REQUEST: i32 = 80_877_103;

/// Hands out fresh byte streams to the database server.
pub trait Connector: Send + Sync {
    /// A new stream (TCP to the server, or a channel through the session's SSH tunnel).
    fn open(&self) -> BoxFuture<'_, Result<PgStream, ConnectError>>;
    /// The stream goes through an SSH tunnel (refused / closed read `tunnel`).
    fn via_tunnel(&self) -> bool {
        false
    }
}

/// A direct TCP connection (keep-alive on, Nagle off: node-postgres' socket settings).
#[derive(Debug, Clone)]
pub struct TcpConnector {
    pub host: String,
    pub port: u16,
}

impl TcpConnector {
    pub fn new(host: impl Into<String>, port: u16) -> Self {
        TcpConnector { host: host.into(), port }
    }
}

/// A TCP connection to `host:port`, every resolved address in turn.
pub async fn tcp_connect(host: &str, port: u16) -> Result<tokio::net::TcpStream, ConnectError> {
    let target = if host.is_empty() { "localhost" } else { host };
    let addrs: Vec<_> = lookup_host((target, port))
        .await
        .map_err(|e| ConnectError::Dns(format!("getaddrinfo ENOTFOUND {target}: {e}")))?
        .collect();
    if addrs.is_empty() {
        return Err(ConnectError::Dns(format!("getaddrinfo ENOTFOUND {target}")));
    }
    let mut last = None;
    for addr in addrs {
        let socket = if addr.is_ipv4() { TcpSocket::new_v4() } else { TcpSocket::new_v6() };
        let socket = match socket {
            Ok(s) => s,
            Err(e) => {
                last = Some(e);
                continue;
            }
        };
        let _ = socket.set_keepalive(true);
        match socket.connect(addr).await {
            Ok(stream) => {
                let _ = stream.set_nodelay(true);
                return Ok(stream);
            }
            Err(e) => last = Some(e),
        }
    }
    let e = last.unwrap_or_else(|| std::io::Error::other("no address"));
    Err(ConnectError::from_io(&e))
}

impl Connector for TcpConnector {
    fn open(&self) -> BoxFuture<'_, Result<PgStream, ConnectError>> {
        Box::pin(async move {
            let s = tcp_connect(&self.host, self.port).await?;
            Ok(Box::new(s) as PgStream)
        })
    }
}

/// Where and how one session logs in.
#[derive(Clone)]
pub struct PgTarget {
    pub user: String,
    pub database: String,
    pub tls: TlsMode,
    /// verify-full: the CA certificate text.
    pub ca: Option<String>,
    /// The host the certificate must name (the database's address as the SSH server sees it through a tunnel).
    pub logical_host: String,
    pub connect_timeout: Duration,
}

impl std::fmt::Debug for PgTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgTarget")
            .field("user", &self.user)
            .field("database", &self.database)
            .field("tls", &self.tls)
            .field("logical_host", &self.logical_host)
            .finish_non_exhaustive()
    }
}

/// The Postgres fields of a `DbOpenConfig` (the `dbOpen` config the DB service builds).
#[derive(Clone)]
pub struct PgOpenConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub database: String,
    pub tls: TlsMode,
    pub ca: Option<String>,
    pub password: Option<Zeroizing<String>>,
    pub read_only: bool,
    /// The connection's statement_timeout (ms; None or 0: none).
    pub statement_timeout_ms: Option<f64>,
    /// Through SSH: the database's address as the SSH server sees it.
    pub ssh: Option<(String, u16)>,
}

impl std::fmt::Debug for PgOpenConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PgOpenConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("database", &self.database)
            .field("tls", &self.tls)
            .field("read_only", &self.read_only)
            .field("ssh", &self.ssh)
            .finish_non_exhaustive()
    }
}

fn port_of(v: Option<&Value>) -> u16 {
    v.and_then(Value::as_f64).filter(|p| p.is_finite() && *p >= 0.0 && *p <= 65_535.0).map(|p| p as u16).unwrap_or(0)
}

fn text_of(v: Option<&Value>) -> String {
    v.and_then(Value::as_str).unwrap_or("").to_owned()
}

impl PgOpenConfig {
    /// Reads a `DbOpenConfig`.
    pub fn from_json(config: &Value) -> Self {
        let ssh = config.get("ssh").filter(|v| v.is_object()).map(|s| (text_of(s.get("dbHost")), port_of(s.get("dbPort"))));
        PgOpenConfig {
            host: text_of(config.get("host")),
            port: port_of(config.get("port")),
            user: text_of(config.get("user")),
            database: text_of(config.get("database")),
            tls: TlsMode::parse(config.get("tls").and_then(Value::as_str).unwrap_or("disable")),
            ca: config.get("ca").and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned),
            password: config.get("password").and_then(Value::as_str).map(|p| Zeroizing::new(p.to_owned())),
            read_only: config.get("readOnly").and_then(Value::as_bool).unwrap_or(false),
            statement_timeout_ms: config.get("statementTimeoutMs").and_then(Value::as_f64),
            ssh,
        }
    }

    /// The server address the stream goes to: through SSH, the database's address as the SSH server sees it.
    pub fn endpoint(&self) -> (&str, u16) {
        match &self.ssh {
            Some((host, port)) => (host.as_str(), *port),
            None => (self.host.as_str(), self.port),
        }
    }

    pub fn target(&self, connect_timeout: Duration) -> PgTarget {
        PgTarget {
            user: self.user.clone(),
            database: self.database.clone(),
            tls: self.tls,
            ca: self.ca.clone(),
            logical_host: self.endpoint().0.to_owned(),
            connect_timeout,
        }
    }

    /// `SET statement_timeout = <Math.floor(ms)>` when the connection has one.
    pub fn statement_timeout_sql(&self) -> Option<String> {
        let ms = self.statement_timeout_ms.filter(|ms| *ms != 0.0 && !ms.is_nan())?;
        Some(format!("SET statement_timeout = {}", js_floor_text(ms)))
    }
}

/// `String(Math.floor(x))` for the numbers a timeout can be.
fn js_floor_text(x: f64) -> String {
    let f = x.floor();
    if f.is_finite() && f.abs() < 1e21 {
        if f == 0.0 { "0".to_owned() } else { format!("{f:.0}") }
    } else {
        let mut b = ryu_js::Buffer::new();
        b.format(f).to_owned()
    }
}

async fn ssl_request(stream: &mut PgStream) -> Result<u8, ConnectError> {
    let mut req = [0u8; 8];
    req[..4].copy_from_slice(&8i32.to_be_bytes());
    req[4..].copy_from_slice(&SSL_REQUEST.to_be_bytes());
    stream.write_all(&req).await.map_err(|e| ConnectError::from_io(&e))?;
    stream.flush().await.map_err(|e| ConnectError::from_io(&e))?;
    let mut answer = [0u8; 1];
    stream.read_exact(&mut answer).await.map_err(|e| ConnectError::from_io(&e))?;
    Ok(answer[0])
}

/// One connection with the target's TLS on or off; `password` None: a server that asks for one fails with
/// `NeedPassword`.
pub async fn connect_once(
    connector: &dyn Connector,
    target: &PgTarget,
    password: Option<&Zeroizing<String>>,
    tls_on: bool,
) -> Result<PgClient, ConnectError> {
    let attempt = async {
        // checked before the stream is opened: a bad CA or host name never reaches the server
        let tls = if tls_on {
            let verify = target.tls == TlsMode::VerifyFull;
            Some((client_config(target.tls, target.ca.as_deref())?, server_name(&target.logical_host, verify)?))
        } else {
            None
        };
        let mut stream = connector.open().await?;
        if let Some((config, name)) = tls {
            match ssl_request(&mut stream).await? {
                b'S' => {}
                b'N' => return Err(ConnectError::TlsUnsupported),
                _ => return Err(ConnectError::Tls("There was an error establishing an SSL connection".into())),
            }
            let tls_stream = TlsConnector::from(config).connect(name, stream).await.map_err(|e| handshake_error(&e))?;
            stream = Box::new(tls_stream);
        }
        let login = StartupParams { user: target.user.clone(), database: target.database.clone(), password: password.cloned() };
        PgClient::startup(stream, tls_on, &login).await.map_err(ConnectError::from_wire)
    };
    match tokio::time::timeout(target.connect_timeout, attempt).await {
        Ok(r) => r,
        Err(_) => Err(ConnectError::Timeout),
    }
}

/// `connectTls`: disable connects plain; prefer tries TLS first and connects again without it when the server has none;
/// require and verify-full need TLS.
pub async fn connect_tls(
    connector: &dyn Connector,
    target: &PgTarget,
    password: Option<&Zeroizing<String>>,
) -> Result<PgClient, ConnectError> {
    if target.tls == TlsMode::Disable {
        return connect_once(connector, target, password, false).await;
    }
    match connect_once(connector, target, password, true).await {
        Err(ConnectError::TlsUnsupported) if target.tls == TlsMode::Prefer => {
            connect_once(connector, target, password, false).await
        }
        r => r,
    }
}

/// Asks the user for the database password (`dbPasswordPrompt`); None: cancelled (or the session ended).
pub trait PasswordPrompt: Send {
    fn ask(&mut self, retry: bool) -> BoxFuture<'_, Option<Zeroizing<String>>>;
}

/// `connectWithPassword`: the client and the password it logged in with.
pub async fn connect_with_password(
    connector: &dyn Connector,
    target: &PgTarget,
    password: Option<Zeroizing<String>>,
    prompt: &mut dyn PasswordPrompt,
) -> Result<(PgClient, Option<Zeroizing<String>>), OpenError> {
    let mut password = password;
    let mut prompts = 0;
    loop {
        match connect_tls(connector, target, password.as_ref()).await {
            Ok(client) => return Ok((client, password)),
            Err(error) => {
                let needs = matches!(error, ConnectError::NeedPassword) || (password.is_some() && error.wrong_password());
                if !needs {
                    return Err(OpenError::from_connect(&error, connector.via_tunnel()));
                }
                if prompts >= MAX_PASSWORD_PROMPTS {
                    return Err(OpenError { code: "dbAuth", message: error.message() });
                }
                let typed = prompt.ask(password.is_some()).await;
                prompts += 1;
                match typed {
                    Some(p) => password = Some(p),
                    None => return Err(OpenError::new("cancelled")),
                }
            }
        }
    }
}

/// A connected Postgres session, before PgSession takes it over.
#[derive(Debug)]
pub struct PgOpened {
    pub client: PgClient,
    /// The password the connection used (side connections for cancel need it); dropped with the session.
    pub password: Option<Zeroizing<String>>,
    /// `SHOW server_version`, cut to 200 UTF-16 units.
    pub server_version: Option<String>,
    pub tls: bool,
}

fn after_connect_error(e: PgWireError) -> OpenError {
    // 1.1.4 maps these without the tunnel flag
    OpenError::from_connect(&ConnectError::from_wire(e), false)
}

/// Opens a Postgres session: the login (with prompts), then the connection's statement_timeout, a read-only default
/// for read-only connections and the server version. A failed setting ends the open (a read-only connection that cannot
/// be made read-only is never used).
pub async fn open(
    connector: &dyn Connector,
    config: &PgOpenConfig,
    connect_timeout: Duration,
    prompt: &mut dyn PasswordPrompt,
) -> Result<PgOpened, OpenError> {
    let target = config.target(connect_timeout);
    let (mut client, password) = connect_with_password(connector, &target, config.password.clone(), prompt).await?;
    let settled = async {
        if let Some(sql) = config.statement_timeout_sql() {
            client.execute(&sql).await?;
        }
        if config.read_only {
            client.execute("SET default_transaction_read_only = on").await?;
        }
        client.query_value("SHOW server_version", &[]).await
    }
    .await;
    match settled {
        Ok(version) => {
            let server_version = version.map(|v| utf16_head(&v, 200).text).filter(|v| !v.is_empty());
            let tls = client.tls();
            Ok(PgOpened { client, password, server_version, tls })
        }
        Err(e) => {
            client.end().await;
            Err(after_connect_error(e))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn open_config_from_the_service_json() {
        let c = PgOpenConfig::from_json(&json!({
            "kind": "postgres", "host": "db", "port": 5433, "user": "u", "database": "d", "tls": "verify-full", "ca": "PEM",
            "password": "pw", "readOnly": true, "statementTimeoutMs": 1500.7,
            "ssh": { "dbHost": "10.0.0.5", "dbPort": 5432, "tunnelKey": "k", "owner": true }
        }));
        assert_eq!(c.endpoint(), ("10.0.0.5", 5432));
        assert_eq!(c.tls, TlsMode::VerifyFull);
        assert_eq!(c.ca.as_deref(), Some("PEM"));
        assert_eq!(c.password.as_deref().map(|s| s.as_str()), Some("pw"));
        assert!(c.read_only);
        assert_eq!(c.statement_timeout_sql().as_deref(), Some("SET statement_timeout = 1500"));
        assert_eq!(c.target(Duration::from_secs(1)).logical_host, "10.0.0.5");
        let d = PgOpenConfig::from_json(
            &json!({ "host": "h", "port": 5432, "ssh": null, "tls": "disable", "statementTimeoutMs": 0 }),
        );
        assert_eq!(d.endpoint(), ("h", 5432));
        assert_eq!(d.statement_timeout_sql(), None);
        assert!(d.password.is_none() && !d.read_only);
        assert!(!format!("{c:?}").contains("pw"), "the password is never printed");
    }

    #[test]
    fn floors_like_js() {
        assert_eq!(js_floor_text(1500.7), "1500");
        assert_eq!(js_floor_text(30_000.0), "30000");
        assert_eq!(js_floor_text(-0.5), "-1");
        assert_eq!(js_floor_text(1e21), "1e+21");
    }
}
