-- @up
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  last_attestation_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE attestations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  node_id TEXT NOT NULL REFERENCES nodes(id),
  validator_id TEXT NOT NULL CHECK (validator_id <> ''),
  attested_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'processed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Partial index so SKIP LOCKED workers only scan rows still waiting to be claimed.
CREATE INDEX attestations_pending_idx ON attestations (id) WHERE status = 'pending';
CREATE INDEX attestations_node_id_idx ON attestations (node_id);

COMMENT ON COLUMN nodes.last_attestation_time IS
  'Monotonic watermark: always updated via GREATEST() so out-of-order worker writes cannot move it backwards.';

-- @down
DROP TABLE IF EXISTS attestations;
DROP TABLE IF EXISTS nodes;
