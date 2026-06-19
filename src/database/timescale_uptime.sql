-- =============================================================================
-- VeriNode: TimescaleDB Configuration for High-Density Uptime Metrics
-- =============================================================================
-- This script configures the TimescaleDB hypertable, compression policies,
-- continuous aggregates, retention policies, and scheduled maintenance for
-- the uptime_heartbeat table defined in migration 002_uptime_schema.sql.
--
-- Executed after the migration to enable advanced TimescaleDB features.
-- Safe to run multiple times — uses IF NOT EXISTS guards.

-- =============================================================================
-- 1. Hypertable Creation — Time Partitioning
-- =============================================================================
-- 6-hour chunks keep per-chunk size under ~2 GB at peak ingestion
-- (50k heartbeats/s × 3600 s/hr × 6 hr ≈ 1.08B rows per chunk).
-- Each chunk is a separate PostgreSQL child table, enabling efficient
-- partition pruning during time-range queries.

SELECT create_hypertable(
    'uptime_heartbeat',
    'time',
    chunk_time_interval => INTERVAL '6 hours',
    if_not_exists       => TRUE
);

-- =============================================================================
-- 2. Space Partitioning — Distribute Writes Across Node Shards
-- =============================================================================
-- Adding a space dimension on node_id reduces B-tree index contention by
-- distributing inserts across 16 partitions. This is essential for maintaining
-- write throughput when tens of thousands of nodes heartbeat concurrently.

SELECT add_dimension(
    'uptime_heartbeat',
    'node_id',
    number_partitions => 16,
    if_not_exists     => TRUE
);

-- =============================================================================
-- 3. Native Compression Policy
-- =============================================================================
-- Compress chunks older than 3 days using TimescaleDB's columnar compression.
-- Segmenting by node_id groups related data together; ordering by time DESC
-- optimises decompression for time-range scans.
-- Target compression ratio: 12:1 on data > 3 days old.
-- Compression does not block concurrent INSERTs into active chunks.

ALTER TABLE uptime_heartbeat SET (
    timescaledb.compress,
    timescaledb.compress_segmentby = 'node_id',
    timescaledb.compress_orderby = 'time DESC'
);

SELECT add_compression_policy(
    'uptime_heartbeat',
    INTERVAL '3 days',
    if_not_exists => TRUE
);

-- =============================================================================
-- 4. Continuous Aggregate: Hourly Rollups
-- =============================================================================
-- Materialised view with 1-hour buckets computing:
--   - AVG latency
--   - P50, P95, P99 latency (using percentile_cont)
--   - Uptime percentage per node
--
-- Refreshed every 5 minutes via automatic refresh policy.
-- Queries against this view transparently combine materialized data with
-- the latest raw data from the hypertable (real-time aggregates).

CREATE MATERIALIZED VIEW IF NOT EXISTS uptime_hourly_agg
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 hour', time) AS bucket,
    node_id,
    AVG(latency_ms) AS avg_latency_ms,
    percentile_cont(0.50) WITHIN GROUP (ORDER BY latency_ms) AS p50_latency_ms,
    percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95_latency_ms,
    percentile_cont(0.99) WITHIN GROUP (ORDER BY latency_ms) AS p99_latency_ms,
    AVG(uptime_pct) AS avg_uptime_pct,
    COUNT(*) AS heartbeat_count,
    COUNT(*) FILTER (WHERE status = 'up') AS up_count,
    COUNT(*) FILTER (WHERE status = 'degraded') AS degraded_count,
    COUNT(*) FILTER (WHERE status = 'down') AS down_count
FROM uptime_heartbeat
GROUP BY bucket, node_id
WITH NO DATA;

-- Automatic refresh every 5 minutes, covering the last 2 hours of data.
SELECT add_continuous_aggregate_policy(
    'uptime_hourly_agg',
    start_offset    => INTERVAL '2 hours',
    end_offset      => INTERVAL '1 hour',
    schedule_interval => INTERVAL '5 minutes',
    if_not_exists   => TRUE
);

-- =============================================================================
-- 5. Retention Policies
-- =============================================================================
--   - Raw heartbeat data:    90 days
--   - Hourly aggregates:    365 days
-- Retention drops entire chunks — no DELETE overhead, no VACUUM needed.

SELECT add_retention_policy(
    'uptime_heartbeat',
    INTERVAL '90 days',
    if_not_exists => TRUE
);

SELECT add_retention_policy(
    'uptime_hourly_agg',
    INTERVAL '365 days',
    if_not_exists => TRUE
);

-- =============================================================================
-- 6. Scheduled REINDEX — Weekly Chunk Maintenance
-- =============================================================================
-- pg_cron job that runs REINDEX TABLE CONCURRENTLY every Sunday at 03:00 UTC
-- on chunks approaching the compression boundary (3-4 days old).
-- This prevents index bloat without blocking writes.

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_extension WHERE extname = 'pg_cron'
    ) THEN
        PERFORM cron.schedule(
            'verinode-uptime-reindex',
            '0 3 * * 0',  -- Sunday 03:00 UTC
            $$
            DO $reindex$
            DECLARE
                chunk_rec RECORD;
            BEGIN
                FOR chunk_rec IN
                    SELECT format('%I.%I', chunk_schema, chunk_name) AS chunk_full
                    FROM timescaledb_information.chunks
                    WHERE hypertable_name = 'uptime_heartbeat'
                      AND range_start < now() - INTERVAL '3 days'
                      AND range_end   > now() - INTERVAL '5 days'
                LOOP
                    EXECUTE format('REINDEX TABLE CONCURRENTLY %s', chunk_rec.chunk_full);
                END LOOP;
            END $reindex$;
            $$
        );
    END IF;
END
$$;
