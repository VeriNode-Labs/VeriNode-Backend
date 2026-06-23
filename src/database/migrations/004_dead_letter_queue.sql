-- Dead letter queue for failed asynchronous message processing (issue #86).
-- Retains failed messages for seven days so operators can inspect, retry,
-- or purge them without silently losing processing failures.

CREATE TABLE IF NOT EXISTS dead_letter_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_type TEXT NOT NULL,
  original_message JSONB NOT NULL,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  stack_trace TEXT,
  retry_count INTEGER NOT NULL CHECK (retry_count >= 0),
  status TEXT NOT NULL DEFAULT 'failed' CHECK (status IN ('failed', 'retrying')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '7 days'
);

CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_created_at
  ON dead_letter_queue (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_message_type
  ON dead_letter_queue (message_type);

CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_expires_at
  ON dead_letter_queue (expires_at);

CREATE INDEX IF NOT EXISTS idx_dead_letter_queue_status
  ON dead_letter_queue (status);

-- Best-effort TTL cleanup when pg_cron is available; safe to skip in restricted DBs.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.schedule(
      'verinode_dead_letter_queue_ttl_cleanup',
      '0 * * * *',
      'DELETE FROM dead_letter_queue WHERE expires_at <= NOW()'
    );
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron cleanup for dead_letter_queue not scheduled: %', SQLERRM;
END $$;
