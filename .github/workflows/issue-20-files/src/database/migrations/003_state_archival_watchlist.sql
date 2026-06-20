-- Migration 003: state_archival_watchlist
-- Backs StateArchivalListener (issue #20). Tracks one row per
-- contract/critical-data-key pair so the renewal loop survives process
-- restarts and knows when each entry was last renewed.

CREATE TABLE IF NOT EXISTS state_archival_watchlist (
  contract_id          TEXT NOT NULL,
  data_key             TEXT NOT NULL,
  current_ttl_ledgers  INTEGER NOT NULL DEFAULT 10000,
  last_renewed_at      TIMESTAMPTZ,
  PRIMARY KEY (contract_id, data_key)
);

CREATE INDEX IF NOT EXISTS idx_state_archival_watchlist_ttl
  ON state_archival_watchlist (current_ttl_ledgers);
