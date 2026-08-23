-- @up
CREATE TABLE validator_registry (
  validator_id TEXT PRIMARY KEY,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE VIEW active_validators AS
SELECT validator_id, created_at, updated_at
FROM validator_registry
WHERE active = TRUE;

CREATE TABLE slashing_events (
  event_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  validator_id TEXT NOT NULL CHECK (validator_id <> ''),
  misbehavior_type TEXT NOT NULL CHECK (misbehavior_type <> ''),
  penalty_amount NUMERIC NOT NULL CHECK (penalty_amount > 0),
  base_penalty NUMERIC NOT NULL CHECK (base_penalty > 0),
  total_validator_count BIGINT NOT NULL CHECK (total_validator_count > 0),
  validator_count_at_slashing BIGINT NOT NULL CHECK (
    validator_count_at_slashing >= 0
    AND validator_count_at_slashing <= total_validator_count
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX slashing_events_validator_created_idx
  ON slashing_events (validator_id, created_at DESC);

-- @down
DROP TABLE IF EXISTS slashing_events;
DROP VIEW IF EXISTS active_validators;
DROP TABLE IF EXISTS validator_registry;
