//! TLS for MySQL / MariaDB connections (rustls with the ring provider, like unimux-net), as 1.1.4 configured mysql2:
//!
//! - `prefer` / `require`: encrypted, no certificate check at all (`rejectUnauthorized: false`).
//! - `verify-full`: the chain against the connection's CA file (the CA alone, as Node's `ca` option replaces the default
//!   roots) and the certificate against the host name the user typed, IP addresses included (1.1.4 ran
//!   `checkServerIdentity(logicalHost, cert)` itself because mysql2 skips the name for IPs). An empty CA text falls back to
//!   the system store (rustls-platform-verifier).
//!
//! SNI: the host name, none for an IP address (mysql2 sets `servername` only for names).
//! Differences to Node's TLS (open, PROGRESS.md D7): no CN fallback when a certificate has no subjectAltName, TLS 1.2 / 1.3
//! only (Node's default minimum is 1.2 as well), and the error texts are rustls' (shown for `dbTls`).

use std::net::IpAddr;
use std::sync::Arc;

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, DnsName, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

use super::error::MyError;

/// How the server's certificate is checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MyTlsVerify {
    /// `prefer` / `require`: no check.
    Off,
    /// `verify-full`: chain and host name; the CA file's text (PEM), None or empty for the system store.
    Full { ca_pem: Option<String> },
}

/// TLS for one connection: the host name the user typed (`logicalHost`, the name to check even through a tunnel).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MyTlsParams {
    pub host: String,
    pub verify: MyTlsVerify,
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Accepts any certificate (`rejectUnauthorized: false`) but still checks the handshake signatures, so the session keys
/// belong to the certificate the server showed.
#[derive(Debug)]
struct NoVerify(Arc<CryptoProvider>);

impl ServerCertVerifier for NoVerify {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls12_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.0.signature_verification_algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.0.signature_verification_algorithms.supported_schemes()
    }
}

/// The certificates of a PEM text (a CA file may hold several).
pub fn ca_certificates(pem: &str) -> Vec<CertificateDer<'static>> {
    CertificateDer::pem_slice_iter(pem.as_bytes()).filter_map(Result::ok).collect()
}

/// The rustls configuration for one way of checking.
pub fn client_config(verify: &MyTlsVerify) -> Result<Arc<ClientConfig>, MyError> {
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| MyError::Tls(e.to_string()))?;
    let config = match verify {
        MyTlsVerify::Off => {
            builder.dangerous().with_custom_certificate_verifier(Arc::new(NoVerify(provider))).with_no_client_auth()
        }
        MyTlsVerify::Full { ca_pem } => match ca_pem.as_deref().filter(|p| !p.trim().is_empty()) {
            Some(pem) => {
                let mut roots = RootCertStore::empty();
                for cert in ca_certificates(pem) {
                    // a certificate webpki cannot use as an anchor is skipped, like OpenSSL ignores what it cannot load
                    let _ = roots.add(cert);
                }
                if roots.is_empty() {
                    return Err(MyError::Tls(
                        "unable to get local issuer certificate (no usable certificate in the CA file)".into(),
                    ));
                }
                let verifier = WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider)
                    .build()
                    .map_err(|e| MyError::Tls(e.to_string()))?;
                builder.with_webpki_verifier(verifier).with_no_client_auth()
            }
            None => {
                let verifier =
                    rustls_platform_verifier::Verifier::new(provider).map_err(|e| MyError::Tls(format!("TLS setup: {e}")))?;
                builder.dangerous().with_custom_certificate_verifier(Arc::new(verifier)).with_no_client_auth()
            }
        },
    };
    Ok(Arc::new(config))
}

/// The name rustls checks and sends: an IP address (no SNI) or a DNS name. A host that is neither cannot be verified;
/// without verification it is sent as no name at all.
pub fn server_name(host: &str, verify: &MyTlsVerify) -> Result<(ServerName<'static>, bool), MyError> {
    let bare = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return Ok((ServerName::IpAddress(ip.into()), false));
    }
    match DnsName::try_from(host.trim_end_matches('.').to_owned()) {
        Ok(name) => Ok((ServerName::DnsName(name), true)),
        Err(_) if *verify == MyTlsVerify::Off => Ok((ServerName::IpAddress(IpAddr::from([0u8, 0, 0, 0]).into()), false)),
        Err(_) => Err(MyError::Tls(format!("Hostname/IP does not match certificate's altnames: Host: {host}."))),
    }
}

/// The TLS handshake over the connection's stream (after the SSL request).
pub async fn upgrade<S: AsyncRead + AsyncWrite + Unpin>(stream: S, params: &MyTlsParams) -> Result<TlsStream<S>, MyError> {
    let config = client_config(&params.verify)?;
    let (name, _sni) = server_name(&params.host, &params.verify)?;
    TlsConnector::from(config).connect(name, stream).await.map_err(|e| MyError::Tls(e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_addresses() {
        let off = MyTlsVerify::Off;
        assert!(matches!(server_name("127.0.0.1", &off).unwrap(), (ServerName::IpAddress(_), false)));
        assert!(matches!(server_name("[::1]", &off).unwrap(), (ServerName::IpAddress(_), false)));
        assert!(matches!(server_name("db.example.com", &off).unwrap(), (ServerName::DnsName(_), true)));
        let full = MyTlsVerify::Full { ca_pem: None };
        assert!(server_name("bad host!", &full).is_err());
        assert!(server_name("bad host!", &off).is_ok());
    }

    #[test]
    fn a_ca_without_certificates_is_a_tls_error() {
        let e = client_config(&MyTlsVerify::Full { ca_pem: Some("not a pem".into()) }).unwrap_err();
        assert!(matches!(e, MyError::Tls(_)));
        assert!(client_config(&MyTlsVerify::Off).is_ok());
    }
}
