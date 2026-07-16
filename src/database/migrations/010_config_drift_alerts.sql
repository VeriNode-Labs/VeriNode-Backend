-- Migration 010: Config Drift Alerts
-- Persists failed alert dispatches for background retry.

CREATE TABLE IF NOT EXISTS config_drift_alerts (
  alert_id     UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  baseline_id  UUID        NOT NULL,
  detected_at  TIMESTAMPTZ NOT NULL,
  severity     TEXT        NOT NULL CHECK (severity IN ('critical', 'non_critical')),
  drifted_keys JSONB       NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'failed'
                 CHECK (status IN ('failed', 'retrying', 'delivered')),
  retry_count  INTEGER     NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cda_status
  ON config_drift_alerts (status);
