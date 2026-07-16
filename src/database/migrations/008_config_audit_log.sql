-- Migration 008: Config Audit Log
-- Immutable tamper-evident record of every configuration change.
-- The application role MUST NOT have UPDATE or DELETE on this table.
-- REVOKE UPDATE, DELETE ON config_audit_log FROM verinode_app;

CREATE TABLE IF NOT EXISTS config_audit_log (
  entry_id       UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  config_path    TEXT        NOT NULL,
  previous_value JSONB,
  new_value      JSONB,
  actor          TEXT        NOT NULL,
  source_ip      INET,
  changed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  change_source  TEXT        NOT NULL CHECK (change_source IN (
    'file', 'env', 'remote_etcd', 'remote_consul',
    'hot_update', 'rollback', 'rollback_skip', 'access_denied'
  )),
  hmac_digest    TEXT        NOT NULL CHECK (hmac_digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_cal_config_path
  ON config_audit_log (config_path);

CREATE INDEX IF NOT EXISTS idx_cal_actor
  ON config_audit_log (actor);

CREATE INDEX IF NOT EXISTS idx_cal_changed_at
  ON config_audit_log (changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_cal_change_source
  ON config_audit_log (change_source);
