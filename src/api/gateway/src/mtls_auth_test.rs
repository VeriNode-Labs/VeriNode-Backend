use rcgen::{CertificateParams, KeyPair, DistinguishedName, DnType};
use rustls::client::danger::ClientCertVerifier;
use rustls::Certificate;
use std::sync::Arc;
use tokio::sync::RwLock;
use std::collections::HashSet;
use crate::mtls_auth::{NodeCertVerifier, WhitelistCache};

#[tokio::test]
async fn test_whitelisted_cert_passes() {
    let mut params = CertificateParams::new(vec![]);
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    params.distinguished_name = dn;

    let cert = rcgen::Certificate::from_params(params).unwrap();
    let der = cert.serialize_der().unwrap();
    let rustls_cert = Certificate(der);

    let cache = WhitelistCache::new();
    cache.whitelisted_nodes.write().await.insert("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef".to_string());

    let verifier = NodeCertVerifier::new(cache);
    let result = verifier.verify_client_cert(&rustls_cert, &[], std::time::SystemTime::now());
    assert!(result.is_ok());
}

#[tokio::test]
async fn test_non_whitelisted_cert_rejected() {
    let mut params = CertificateParams::new(vec![]);
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, "1111111111111111111111111111111111111111111111111111111111111111");
    params.distinguished_name = dn;

    let cert = rcgen::Certificate::from_params(params).unwrap();
    let der = cert.serialize_der().unwrap();
    let rustls_cert = Certificate(der);

    let cache = WhitelistCache::new();
    cache.whitelisted_nodes.write().await.insert("deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef".to_string());

    let verifier = NodeCertVerifier::new(cache);
    let result = verifier.verify_client_cert(&rustls_cert, &[], std::time::SystemTime::now());
    assert!(result.is_err());
}
