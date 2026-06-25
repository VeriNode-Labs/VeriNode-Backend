CREATE TABLE IF NOT EXISTS notification_delivery (
  slashing_event_id TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'webhook')),
  notification_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivering', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (slashing_event_id, channel),
  UNIQUE (notification_id)
);

CREATE INDEX IF NOT EXISTS idx_notification_delivery_status
  ON notification_delivery(status);
