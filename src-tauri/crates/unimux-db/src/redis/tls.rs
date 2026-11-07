//! TLS of a Redis connection the way 1.1.4 set up Node's `tls.connect` (src/dbhost/host.ts `ssl`): `require` / `prefer`
//! encrypt without checking the certificate (`rejectUnauthorized: false`, the handshake signatures are still checked),
//! `verify-full` trusts only the connection's CA and checks the certificate against the host name the user typed (IP
//! addresses against the IP SANs, like Node's `checkServerIdentity`). SNI goes out for names, never for IP addresses.
//! rustls with the ring provider (the same as unimux-net); TLS 1.2 and 1.3 like Node's defaults.

use std::net::IpAddr;
use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, verify_tls12_signature, verify_tls13_signature};
use rustls::pki_types::pem::PemObject;
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};

/// How a connection is encrypted.
#[derive(Clone)]
pub enum TlsSetup {
    /// require / prefer: encrypted, any certificate.
    NoVerify,
    /// verify-full: the CA text (PEM) main read from the file.
    VerifyFull { ca: String },
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// Accepts any certificate but still checks that the server holds its key (Node with `rejectUnauthorized: false`).
#[derive(Debug)]
struct AnyCertificate(Arc<CryptoProvider>);

impl ServerCertVerifier for AnyCertificate {
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

/// The name rustls checks and sends: an IP address (no SNI), a DNS name (SNI), or for a name rustls cannot take (a blank,
/// other characters outside a host name) a placeholder with SNI off; verify-full refuses such a name.
pub(crate) fn server_name(logical_host: &str, verify: bool) -> Result<(ServerName<'static>, bool), String> {
    let bare = logical_host.trim_start_matches('[').trim_end_matches(']');
    if let Ok(ip) = bare.parse::<IpAddr>() {
        return Ok((ServerName::IpAddress(ip.into()), false));
    }
    match ServerName::try_from(logical_host.to_owned()) {
        Ok(n) => Ok((n, true)),
        Err(_) if !verify => Ok((ServerName::try_from("unimux.invalid").expect("a valid name"), false)),
        Err(_) => Err(format!("Hostname/IP does not match certificate's altnames: Host: {logical_host}.")),
    }
}

/// The client configuration and the server name for one connect.
pub fn client_config(setup: &TlsSetup, logical_host: &str) -> Result<(Arc<ClientConfig>, ServerName<'static>), String> {
    let p = provider();
    let builder =
        ClientConfig::builder_with_provider(p.clone()).with_safe_default_protocol_versions().map_err(|e| e.to_string())?;
    let verify = matches!(setup, TlsSetup::VerifyFull { .. });
    let (name, sni) = server_name(logical_host, verify)?;
    let mut config = match setup {
        TlsSetup::NoVerify => {
            builder.dangerous().with_custom_certificate_verifier(Arc::new(AnyCertificate(p))).with_no_client_auth()
        }
        TlsSetup::VerifyFull { ca } => {
            let mut roots = RootCertStore::empty();
            let mut any = false;
            for cert in CertificateDer::pem_slice_iter(ca.as_bytes()) {
                let cert = cert.map_err(|e| format!("bad CA certificate: {e}"))?;
                roots.add(cert).map_err(|e| format!("bad CA certificate: {e}"))?;
                any = true;
            }
            if !any {
                return Err("unable to get local issuer certificate".into());
            }
            builder.with_root_certificates(roots).with_no_client_auth()
        }
    };
    config.enable_sni = sni;
    Ok((Arc::new(config), name))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert!(matches!(server_name("127.0.0.1", true), Ok((ServerName::IpAddress(_), false))));
        assert!(matches!(server_name("::1", true), Ok((ServerName::IpAddress(_), false))));
        assert!(matches!(server_name("redis.example.com", true), Ok((ServerName::DnsName(_), true))));
        assert!(matches!(server_name("bad name", false), Ok((_, false))));
        assert!(server_name("bad name", true).is_err());
    }

    #[test]
    fn configs() {
        assert!(client_config(&TlsSetup::NoVerify, "localhost").is_ok());
        assert!(client_config(&TlsSetup::VerifyFull { ca: "nope".into() }, "localhost").is_err());
    }
}
