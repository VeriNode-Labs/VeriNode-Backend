CREATE TABLE IF NOT EXISTS bond_pools (
  id TEXT PRIMARY KEY,
  balance BIGINT NOT NULL DEFAULT 0 CHECK (balance >= 0),
  version BIGINT NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS validator_stakes (
  pool_id TEXT NOT NULL REFERENCES bond_pools(id) ON DELETE CASCADE,
  validator_id TEXT NOT NULL,
  amount BIGINT NOT NULL CHECK (amount >= 0),
  PRIMARY KEY (pool_id, validator_id)
);

CREATE INDEX IF NOT EXISTS idx_validator_stakes_pool_id
  ON validator_stakes(pool_id);
