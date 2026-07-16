-- Migration 009: Config Baselines
-- Stores point-in-time known-good snapshots of the runtime configuration.
-- The partial unique index ensures exactly one 'active' baseline at any time.

CREATE TABLE IF NOT EXISTS config_baselines (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  snapshot_json TEXT        NOT NULL,
  sha256_hash   TEXT        NOT NULL,
  actor         TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status        TEXT        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'superseded', 'expired'))
);

-- Enforces at-most-one active row at the DB level
CREATE UNIQUE INDEX IF NOT EXISTS idx_cb_single_active
  ON config_baselines (status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_cb_created_at
  ON config_baselines (created_at DESC);
