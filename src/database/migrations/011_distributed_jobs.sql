-- Migration 011: Distributed Job Scheduler
-- Implements lease-based worker claiming for distributed job execution.
-- Uses SKIP LOCKED for high-concurrency, low-latency job claiming by workers.

CREATE TABLE IF NOT EXISTS distributed_jobs (
  id            UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  job_type      VARCHAR(64)  NOT NULL,
  payload       JSONB        NOT NULL,
  status        VARCHAR(20)  NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  run_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  locked_until  TIMESTAMPTZ,
  locked_by     VARCHAR(128),
  retry_count   INTEGER      NOT NULL DEFAULT 0,
  max_retries   INTEGER      NOT NULL DEFAULT 3,
  error_message TEXT,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Critical partial index for < 100ms P99 lease acquisition.
-- NOTE: the predicate must be IMMUTABLE, so the lock-expiry condition
-- (locked_until <= NOW()) cannot live here — Postgres rejects NOW() in index
-- predicates because index membership is fixed at write time while NOW()
-- changes continuously. The static status filter below still excludes the
-- bulk of the table (completed/failed jobs); lease queries apply the
-- time-dependent locked_until check at query time and can use this index.
CREATE INDEX IF NOT EXISTS idx_distributed_jobs_ready
  ON distributed_jobs (run_at, job_type)
  WHERE status IN ('pending', 'running');

-- Index for monitoring queries
CREATE INDEX IF NOT EXISTS idx_distributed_jobs_status
  ON distributed_jobs (status, job_type);

-- Index for cleanup of old completed/failed jobs
CREATE INDEX IF NOT EXISTS idx_distributed_jobs_created
  ON distributed_jobs (created_at)
  WHERE status IN ('completed', 'failed');
