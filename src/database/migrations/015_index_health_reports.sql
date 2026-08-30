-- Migration 015: Index Health Reports (issue #197)
-- Append-only output of the automated DB index health analyzer.
--
-- Every row is an ADVISORY finding for human review. `recommended_ddl` is TEXT
-- ONLY: the analyzer runs inside a READ ONLY transaction and never executes
-- CREATE INDEX / DROP INDEX itself.

-- @up
CREATE TABLE IF NOT EXISTS index_health_reports (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id            UUID        NOT NULL,                       -- groups one analyzer run
  run_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),         -- application-supplied run timestamp
  finding_type      TEXT        NOT NULL CHECK (finding_type IN (
                      'unused_index', 'excluded_index', 'missing_index', 'stats_reset_warning'
                    )),
  schema_name       TEXT        NOT NULL DEFAULT 'public',
  table_name        TEXT        NOT NULL,
  index_name        TEXT,                                       -- NULL for missing_index / stats_reset_warning
  scans_30d         BIGINT,                                     -- idx_scan over the available window
  size_mb           NUMERIC(12, 2),
  recommendation    TEXT        NOT NULL,                       -- human-readable, always present
  recommended_ddl   TEXT,                                       -- TEXT ONLY, never executed; NULL when unsafe
  exclusion_reason  TEXT,                                       -- why a low-usage index was NOT recommended
  stats_window_days INTEGER,                                    -- actual stats window (pg_stat_database.stats_reset)
  evidence          JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- supporting metrics / query patterns
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_index_health_reports_run_at
  ON index_health_reports (run_at DESC);

CREATE INDEX IF NOT EXISTS idx_index_health_reports_run_id
  ON index_health_reports (run_id);

COMMENT ON TABLE index_health_reports IS
  'Advisory output of the DB index health analyzer (issue #197). recommended_ddl is text for a DBA to review; the analyzer never executes DDL.';
COMMENT ON COLUMN index_health_reports.recommended_ddl IS
  'Suggested DDL string for manual review only. The analyzer runs READ ONLY and never runs CREATE/DROP INDEX.';
COMMENT ON COLUMN index_health_reports.exclusion_reason IS
  'Set when a low-usage index was deliberately NOT recommended for removal: primary key, unique/exclusion constraint, replica identity, FK-supporting (leading-column prefix match), or a statistics window shorter than policy.';

-- Optional pg_cron cadence marker. Mirrors 011_backup_verification.sql: the
-- analysis runs in the application (READ ONLY); cron only records the intended
-- OFF-PEAK UTC cadence for operators. Override on the app via the
-- VERINODE_INDEX_HEALTH_CRON env var. Safe to skip on restricted DBs.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'verinode_index_health_daily',
      '30 3 * * *',
      $job$SELECT 1$job$
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron index health schedule not installed: %', SQLERRM;
END $cron$;

-- @down
DROP TABLE IF EXISTS index_health_reports;
