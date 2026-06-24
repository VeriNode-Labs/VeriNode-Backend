-- VeriNode: Reputation Score Schema Migration
-- Migration 005: Reputation scoring system with race-condition-safe updates
--
-- This migration creates tables and indexes for tracking node reputation scores
-- with atomic operations to prevent write-skew anomalies when concurrent
-- reward and slashing events occur.

-- =============================================================================
-- 1. Reputation Scores Table
-- =============================================================================
-- Stores the current reputation score for each node with atomic update support.
-- Score range: [-1000, 1000]
-- Reward delta: +10
-- Slashing delta: -500

CREATE TABLE IF NOT EXISTS reputations (
    node_id TEXT PRIMARY KEY,
    score INTEGER NOT NULL DEFAULT 0 CHECK (score >= -1000 AND score <= 1000),
    total_rewards INTEGER NOT NULL DEFAULT 0,
    total_slashings INTEGER NOT NULL DEFAULT 0,
    slash_version BIGINT NOT NULL DEFAULT 0,
    last_reward_at TIMESTAMPTZ,
    last_slash_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying nodes by score range
CREATE INDEX IF NOT EXISTS idx_reputations_score 
    ON reputations (score DESC);

-- Index for finding recently slashed nodes
CREATE INDEX IF NOT EXISTS idx_reputations_last_slash 
    ON reputations (last_slash_at DESC) 
    WHERE last_slash_at IS NOT NULL;

-- =============================================================================
-- 2. Reputation Events Log
-- =============================================================================
-- Immutable audit log of all reputation events (rewards and slashings).
-- Used for debugging race conditions and maintaining event history.

CREATE TABLE IF NOT EXISTS reputation_events (
    id BIGSERIAL PRIMARY KEY,
    node_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('reward', 'slashing')),
    delta INTEGER NOT NULL,
    score_before INTEGER NOT NULL,
    score_after INTEGER NOT NULL,
    slash_version_at_event BIGINT NOT NULL,
    reason TEXT,
    metadata JSONB,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for querying events by node
CREATE INDEX IF NOT EXISTS idx_reputation_events_node 
    ON reputation_events (node_id, applied_at DESC);

-- Index for querying events by type
CREATE INDEX IF NOT EXISTS idx_reputation_events_type 
    ON reputation_events (event_type, applied_at DESC);

-- Index for detecting concurrent events (within same second)
CREATE INDEX IF NOT EXISTS idx_reputation_events_concurrent 
    ON reputation_events (node_id, applied_at);

-- =============================================================================
-- 3. Helper Functions
-- =============================================================================

-- Function to update the updated_at timestamp automatically
CREATE OR REPLACE FUNCTION update_reputation_timestamp()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to auto-update updated_at on reputations table
CREATE TRIGGER trigger_update_reputation_timestamp
    BEFORE UPDATE ON reputations
    FOR EACH ROW
    EXECUTE FUNCTION update_reputation_timestamp();

-- =============================================================================
-- 4. Initial Data
-- =============================================================================
-- No initial data needed - nodes will be inserted on first reputation event
