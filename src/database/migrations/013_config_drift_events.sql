-- Migration 013: Config Drift Events
-- Granular per-finding event table.
-- Each row represents one drifted key found during a snapshot comparison.
-- auto_remediated tracks whether the auto-remediation logic has restored the key.

CREATE TABLE IF NOT EXISTS config_drift_events (
  event_id          UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  snapshot_id       TEXT        NOT NULL,
  captured_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  severity          TEXT        NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  category          TEXT        NOT NULL CHECK (category IN ('value_change', 'key_added', 'key_removed', 'type_change')),
  key               TEXT        NOT NULL,
  baseline_value    JSONB,
  runtime_value     JSONB,
  auto_remediated   BOOLEAN     NOT NULL DEFAULT FALSE,
  remediation_note  TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Efficient queries: most recent events per severity
CREATE INDEX IF NOT EXISTS idx_cde_captured_at
  ON config_drift_events (captured_at DESC);

-- Filter by snapshot
CREATE INDEX IF NOT EXISTS idx_cde_snapshot_id
  ON config_drift_events (snapshot_id);

-- Filter by severity for alerting queries
CREATE INDEX IF NOT EXISTS idx_cde_severity
  ON config_drift_events (severity, captured_at DESC);

-- Filter auto-remediated events
CREATE INDEX IF NOT EXISTS idx_cde_auto_remediated
  ON config_drift_events (auto_remediated, captured_at DESC);
