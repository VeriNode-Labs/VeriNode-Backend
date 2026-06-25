use rustls::client::danger::{ServerCertVerified, ServerCertVerifier};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{CertificateError, Error as RustlsError, Certificate};
use std::sync::Arc;
use std::time::SystemTime;
use tokio::sync::RwLock;
use std::collections::HashSet;
use metrics::{counter, histogram, gauge};
use x509_parser::prelude::*;
use std::time::Duration;

#[derive(Clone)]
pub struct WhitelistCache {
    pub whitelisted_nodes: Arc<RwLock<HashSet<String>>>,
}

impl WhitelistCache {
    pub fn new() -> Self {
        Self {
            whitelisted_nodes: Arc::new(RwLock::new(HashSet::new())),
        }
    }

    pub async fn refresh_from_db(&self) {
        // In a real app, query `cert_whitelist.sql` table using sqlx here
        // SELECT node_id FROM node_certificates WHERE revoked = FALSE
        // and update `self.whitelisted_nodes`.
        
        // Mock update for demonstration
        let mut cache = self.whitelisted_nodes.write().await;
        cache.clear();
        cache.insert("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef".to_string());
    }

    pub fn start_refresh_task(self) {
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            loop {
                interval.tick().await;
                self.refresh_from_db().await;
            }
        });
    }
}

pub struct NodeCertVerifier {
    whitelist_cache: WhitelistCache,
}

impl NodeCertVerifier {
    pub fn new(whitelist_cache: WhitelistCache) -> Self {
        Self { whitelist_cache }
    }
}

impl ClientCertVerifier for NodeCertVerifier {
    fn verify_client_cert(
        &self,
        end_entity: &rustls::Certificate,
        _intermediates: &[rustls::Certificate],
        _now: std::time::SystemTime,
    ) -> Result<ClientCertVerified, RustlsError> {
        let start_time = std::time::Instant::now();
        
        // 1. Extract CN from certificate
        let (_, cert) = X509Certificate::from_der(&end_entity.0).map_err(|_| {
            counter!("mtls_cert_rejected_total", 1);
            RustlsError::General("Failed to parse X509 certificate".into())
        })?;
        
        let subject = cert.subject();
        let mut cn_str = String::new();
        for rdns in subject.iter() {
            for atv in rdns.iter() {
                if atv.attr_type() == oid_registry::OID_X509_COMMON_NAME {
                    if let Ok(s) = atv.attr_value().as_str() {
                        cn_str = s.to_string();
                    }
                }
            }
        }
        
        if cn_str.len() != 64 {
            counter!("mtls_cert_rejected_total", 1);
            return Err(RustlsError::General("Invalid CN length, expected 64-hex-char node_id".into()));
        }

        // 2. Validate against whitelist cache
        // Note: For a synchronous verifier like this in rustls 0.21, we can't await,
        // so we must use try_read or a std::sync::RwLock if we need strict sync access.
        // For demonstration, we'll assume blocking read.
        let is_whitelisted = {
            let cache = futures::executor::block_on(self.whitelist_cache.whitelisted_nodes.read());
            cache.contains(&cn_str)
        };

        if !is_whitelisted {
            counter!("mtls_cert_rejected_total", 1);
            return Err(RustlsError::General("Node ID not whitelisted or revoked".into()));
        }

        // Check OCSP status (mocked here, in reality would parse ocsp responses)
        
        counter!("mtls_cert_valid_total", 1);
        histogram!("mtls_handshake_duration_seconds", start_time.elapsed().as_secs_f64());
        gauge!("mtls_ocsp_staple_age_seconds", 5.0); // Mock staple age
        
        Ok(ClientCertVerified::assertion())
    }

    fn client_auth_root_subjects(&self) -> Option<rustls::client::danger::HandshakeSignatureValid> {
        None
    }
    
    fn root_hint_subjects(&self) -> &[&[u8]] {
        &[]
    }
    
    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &Certificate,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, RustlsError> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &Certificate,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, RustlsError> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }
    
    fn client_auth_roots(&self) -> core::slice::Iter<'_, rustls::DistinguishedName> {
        [].iter()
    }
}
