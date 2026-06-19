-- VeriNode: Uptime Heartbeat Schema Migration
-- Migration 002: TimescaleDB hypertable for high-density node heartbeat metrics
--
-- This migration is designed to be run via a migration runner (e.g., pg-migrate)
-- or manually against a TimescaleDB-enabled PostgreSQL instance.
--
-- Prerequisites:
--   - PostgreSQL 14+ with TimescaleDB 2.x extension installed
--   - pg_cron extension (optional, for automated REINDEX jobs)

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;

-- pg_cron is optional; failure to create does not block schema setup.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron CASCADE;
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'pg_cron requires superuser; skipping.';
END
$$;

-- =============================================================================
-- 1. Uptime Heartbeat Table
-- =============================================================================
-- Stores sub-second heartbeats from decentralized validation nodes.
-- Each row represents a single heartbeat event with latency and status metadata.
--
-- Expected ingestion rate: up to 50,000 heartbeats/second at peak.
-- Chunk interval: 6 hours → ~1B rows per chunk at peak throughput.

CREATE TABLE IF NOT EXISTS uptime_heartbeat (
    time           TIMESTAMPTZ NOT NULL,
    node_id        TEXT NOT NULL,
    source_ip      INET,
    latency_ms     DOUBLE PRECISION NOT NULL,
    status         TEXT NOT NULL DEFAULT 'up',   -- 'up', 'degraded', 'down'
    uptime_pct     DOUBLE PRECISION NOT NULL DEFAULT 100.0,
    block_height   BIGINT,
    extra          JSONB
);

-- Add a composite index for common dashboard queries: last N hours per node.
CREATE INDEX IF NOT EXISTS idx_uptime_heartbeat_node_time
    ON uptime_heartbeat (node_id, time DESC);

-- Partial index for degraded/down heartbeat lookups.
CREATE INDEX IF NOT EXISTS idx_uptime_heartbeat_unhealthy
    ON uptime_heartbeat (time DESC)
    WHERE status IN ('degraded', 'down');
