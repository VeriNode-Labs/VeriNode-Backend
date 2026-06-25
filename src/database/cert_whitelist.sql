-- /src/database/cert_whitelist.sql

CREATE TABLE IF NOT EXISTS node_certificates (
    node_id VARCHAR(64) PRIMARY KEY,
    hardware_fingerprint VARCHAR(255) NOT NULL,
    certificate_fingerprint VARCHAR(255) NOT NULL,
    revoked BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_node_id ON node_certificates(node_id);
CREATE INDEX idx_cert_fingerprint ON node_certificates(certificate_fingerprint);
