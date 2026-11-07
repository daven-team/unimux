//! TLS of a database connection (`ssl()` in src/dbhost/host.ts), on rustls with the ring provider.
//!
//! - `require` / `prefer`: encrypted, the certificate is not checked (1.1.4: `rejectUnauthorized: false`). The handshake
//!   signatures are still verified, so the session talks to whoever holds the key of the certificate it was shown.
//! - `verify-full`: the chain must end at the connection's CA (the PEM text main read from the CA file; without one, the
//!   operating system's trust store) and the certificate must name the host: a DNS name, or an IP address SAN when the host
//!   is an IP literal (Node's `checkServerIdentity`). The host is the logical one: the database's address as the SSH server
//!   sees it when the session goes through a tunnel.
//! - SNI carries the host name unless it is an IP literal (Node's `servername`).
//!
//! The same configuration serves D7 (MySQL) and D9 (Redis) later.

use std::net::IpAddr;
use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};

use super::error::ConnectError;

/// `DbTlsMode` (src/shared/db.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsMode {
    Disable,
    Prefer,
    Require,
    VerifyFull,
}

impl TlsMode {
    /// The mode of a connection config. 1.1.4 only compares with `disable`, `prefer` and `verify-full`; anything else
    /// (the normalizer never lets it through) behaves like `require`.
    pub fn parse(s: &str) -> Self {
        match s {
            "disable" => TlsMode::Disable,
            "prefer" => TlsMode::Prefer,
            "verify-full" => TlsMode::VerifyFull,
            _ => TlsMode::Require,
        }
    }
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Accepts any certificate (`rejectUnauthorized: false`) but checks the handshake signatures with it.
#[derive(Debug)]
struct NoCertificateCheck {
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for NoCertificateCheck {
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
        verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

/// The certificates of a PEM text (a CA file may hold a bundle).
pub fn parse_ca(pem: &str) -> Result<Vec<CertificateDer<'static>>, ConnectError> {
    let certs: Vec<CertificateDer<'static>> = CertificateDer::pem_slice_iter(pem.as_bytes())
        .collect::<Result<_, _>>()
        .map_err(|e| ConnectError::Tls(format!("the CA file cannot be read: {e}")))?;
    if certs.is_empty() {
        return Err(ConnectError::Tls("the CA file holds no certificate".into()));
    }
    Ok(certs)
}

/// The client configuration of a TLS mode (`ca`: the verify-full CA text).
pub fn client_config(mode: TlsMode, ca: Option<&str>) -> Result<Arc<ClientConfig>, ConnectError> {
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(|e| ConnectError::Tls(e.to_string()))?;
    let config = if mode == TlsMode::VerifyFull {
        match ca.filter(|s| !s.is_empty()) {
            Some(pem) => {
                let mut roots = RootCertStore::empty();
                for cert in parse_ca(pem)? {
                    roots.add(cert).map_err(|e| ConnectError::Tls(format!("the CA certificate cannot be used: {e}")))?;
                }
                let verifier = rustls::client::WebPkiServerVerifier::builder_with_provider(Arc::new(roots), provider)
                    .build()
                    .map_err(|e| ConnectError::Tls(e.to_string()))?;
                builder.with_webpki_verifier(verifier).with_no_client_auth()
            }
            None => {
                let verifier = rustls_platform_verifier::Verifier::new(provider).map_err(|e| ConnectError::Tls(e.to_string()))?;
                builder.dangerous().with_custom_certificate_verifier(Arc::new(verifier)).with_no_client_auth()
            }
        }
    } else {
        let algorithms = provider.signature_verification_algorithms;
        builder.dangerous().with_custom_certificate_verifier(Arc::new(NoCertificateCheck { algorithms })).with_no_client_auth()
    };
    Ok(Arc::new(config))
}

/// The name the handshake uses: an IP literal (no SNI, IP SANs are checked) or a DNS name (SNI, DNS SANs). A host that
/// is neither can only be used without the certificate check.
pub fn server_name(host: &str, verify: bool) -> Result<ServerName<'static>, ConnectError> {
    let bare = host.strip_prefix('[').and_then(|h| h.strip_suffix(']')).unwrap_or(host);
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return Ok(ServerName::IpAddress(ip.into()));
    }
    match ServerName::try_from(host.to_owned()) {
        Ok(name) => Ok(name),
        Err(_) if !verify => Ok(ServerName::IpAddress(IpAddr::from([0, 0, 0, 0]).into())),
        Err(e) => Err(ConnectError::Tls(format!("the host name {host:?} cannot be checked: {e}"))),
    }
}

/// A readable reason for a failed handshake (shown under the session's error).
pub fn handshake_error(e: &std::io::Error) -> ConnectError {
    if let Some(inner) = e.get_ref().and_then(|i| i.downcast_ref::<rustls::Error>()) {
        return ConnectError::Tls(inner.to_string());
    }
    match e.kind() {
        std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::ConnectionAborted => {
            ConnectError::Tls(format!("the server closed the connection during the TLS handshake ({e})"))
        }
        _ => ConnectError::Tls(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modes_like_the_host() {
        assert_eq!(TlsMode::parse("disable"), TlsMode::Disable);
        assert_eq!(TlsMode::parse("prefer"), TlsMode::Prefer);
        assert_eq!(TlsMode::parse("require"), TlsMode::Require);
        assert_eq!(TlsMode::parse("verify-full"), TlsMode::VerifyFull);
        assert_eq!(TlsMode::parse("odd"), TlsMode::Require);
    }

    #[test]
    fn server_names_for_ips_and_hosts() {
        assert!(matches!(server_name("127.0.0.1", true).unwrap(), ServerName::IpAddress(_)));
        assert!(matches!(server_name("::1", true).unwrap(), ServerName::IpAddress(_)));
        assert!(matches!(server_name("[::1]", true).unwrap(), ServerName::IpAddress(_)));
        assert!(matches!(server_name("db.example.com", true).unwrap(), ServerName::DnsName(_)));
        assert!(server_name("bad host", true).is_err());
        assert!(server_name("bad host", false).is_ok());
    }

    #[test]
    fn a_ca_text_without_certificates_is_refused() {
        assert!(matches!(parse_ca("hello"), Err(ConnectError::Tls(_))));
        assert!(client_config(TlsMode::VerifyFull, Some("nothing")).is_err());
        assert!(client_config(TlsMode::Require, None).is_ok());
    }
}
