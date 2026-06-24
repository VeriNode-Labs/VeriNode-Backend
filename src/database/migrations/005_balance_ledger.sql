CREATE TABLE IF NOT EXISTS reward_pending_amounts (
  node_id TEXT PRIMARY KEY,
  amount NUMERIC(30, 7) NOT NULL CHECK (amount >= 0)
);

CREATE TABLE IF NOT EXISTS reward_tx (
  id BIGSERIAL PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES reward_pending_amounts(node_id),
  amount NUMERIC(30, 7) NOT NULL CHECK (amount > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS reward_tx_node_created_idx ON reward_tx(node_id, created_at DESC);
