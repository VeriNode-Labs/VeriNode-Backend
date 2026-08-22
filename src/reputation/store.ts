import { PoolClient } from 'pg';
import { Database } from '../config/database';

export interface ReputationRecord {
  node_id: string;
  score: number;
  slash_version: number;
  updated_at: Date;
}

export class ReputationStore {
  constructor(private db: Database) {}

  /**
   * Get current reputation score for a node.
   * @param nodeId The node identifier
   * @returns ReputationRecord or null if node not found
   */
  async getReputationScore(nodeId: string): Promise<ReputationRecord | null> {
    const result = await this.db.query<ReputationRecord>(
      'SELECT node_id, score, slash_version, updated_at FROM reputations WHERE node_id = $1',
      [nodeId],
    );
    return result.rows[0] ?? null;
  }

  /**
   * Initialize a reputation record for a new node.
   * @param nodeId The node identifier
   * @param initialScore Initial score (default 0)
   */
  async initializeReputation(nodeId: string, initialScore: number = 0): Promise<void> {
    await this.db.query(
      `INSERT INTO reputations (node_id, score, slash_version, updated_at)
       VALUES ($1, $2, 0, NOW())
       ON CONFLICT (node_id) DO NOTHING`,
      [nodeId, initialScore],
    );
  }

  /**
   * Apply a reward delta to a node's reputation score atomically.
   * Uses atomic UPDATE with GREATEST/LEAST to enforce bounds [-1000, 1000].
   * This operation is atomic and does not suffer from read-modify-write races.
   *
   * @param nodeId The node identifier
   * @param delta The reward amount (positive value)
   * @returns The new score after applying the reward
   */
  async applyRewardAtomic(nodeId: string, delta: number): Promise<number> {
    const result = await this.db.query<{ score: number }>(
      `UPDATE reputations 
       SET score = LEAST(1000, GREATEST(-1000, score + $2)),
           updated_at = NOW()
       WHERE node_id = $1
       RETURNING score`,
      [nodeId, delta],
    );

    if (result.rows.length === 0) {
      throw new Error(`Node ${nodeId} not found in reputations table`);
    }

    return result.rows[0].score;
  }

  /**
   * Apply a slashing penalty to a node's reputation score atomically.
   * Uses atomic UPDATE with GREATEST/LEAST to enforce bounds [-1000, 1000].
   * Increments slash_version to track slashing events.
   * This operation is atomic and does not suffer from read-modify-write races.
   *
   * @param nodeId The node identifier
   * @param delta The slashing penalty (positive value, will be subtracted)
   * @returns The new score and slash_version after applying the penalty
   */
  async applySlashingAtomic(
    nodeId: string,
    delta: number,
  ): Promise<{ score: number; slash_version: number }> {
    const result = await this.db.query<{ score: number; slash_version: number }>(
      `UPDATE reputations 
       SET score = LEAST(1000, GREATEST(-1000, score - $2)),
           slash_version = slash_version + 1,
           updated_at = NOW()
       WHERE node_id = $1
       RETURNING score, slash_version`,
      [nodeId, delta],
    );

    if (result.rows.length === 0) {
      throw new Error(`Node ${nodeId} not found in reputations table`);
    }

    return result.rows[0];
  }

  /**
   * Apply a reward with row-level locking (FOR UPDATE) to prevent concurrent modifications.
   * This method MUST be called within a transaction context.
   * Should be used when you need transactional guarantees with other operations.
   *
   * @param client The database client (within a transaction)
   * @param nodeId The node identifier
   * @param delta The reward amount (positive value)
   * @returns The new score after applying the reward
   */
  async applyRewardWithLock(client: PoolClient, nodeId: string, delta: number): Promise<number> {
    // Acquire row-level lock
    const selectResult = await client.query<{ score: number; slash_version: number }>(
      'SELECT score, slash_version FROM reputations WHERE node_id = $1 FOR UPDATE',
      [nodeId],
    );

    if (selectResult.rows.length === 0) {
      throw new Error(`Node ${nodeId} not found in reputations table`);
    }

    const currentScore = selectResult.rows[0].score;
    const newScore = Math.min(1000, Math.max(-1000, currentScore + delta));

    // Update with new score
    const updateResult = await client.query<{ score: number }>(
      `UPDATE reputations 
       SET score = $2, updated_at = NOW()
       WHERE node_id = $1
       RETURNING score`,
      [nodeId, newScore],
    );

    return updateResult.rows[0].score;
  }

  /**
   * Apply a slashing penalty with row-level locking (FOR UPDATE) and NOWAIT.
   * This method MUST be called within a transaction context.
   * Uses NOWAIT to ensure slashing operations are prioritized and fail fast if blocked.
   *
   * @param client The database client (within a transaction)
   * @param nodeId The node identifier
   * @param delta The slashing penalty (positive value, will be subtracted)
   * @returns The new score and slash_version after applying the penalty
   */
  async applySlashingWithLock(
    client: PoolClient,
    nodeId: string,
    delta: number,
  ): Promise<{ score: number; slash_version: number }> {
    // Acquire row-level lock with NOWAIT for priority
    const selectResult = await client.query<{ score: number; slash_version: number }>(
      'SELECT score, slash_version FROM reputations WHERE node_id = $1 FOR UPDATE NOWAIT',
      [nodeId],
    );

    if (selectResult.rows.length === 0) {
      throw new Error(`Node ${nodeId} not found in reputations table`);
    }

    const currentScore = selectResult.rows[0].score;
    const currentSlashVersion = selectResult.rows[0].slash_version;
    const newScore = Math.min(1000, Math.max(-1000, currentScore - delta));

    // Update with new score and increment slash_version
    const updateResult = await client.query<{ score: number; slash_version: number }>(
      `UPDATE reputations 
       SET score = $2, slash_version = $3, updated_at = NOW()
       WHERE node_id = $1
       RETURNING score, slash_version`,
      [nodeId, newScore, currentSlashVersion + 1],
    );

    return updateResult.rows[0];
  }

  /**
   * Create the reputations table if it doesn't exist.
   * Should be called during application initialization.
   */
  async initializeSchema(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS reputations (
        node_id VARCHAR(255) PRIMARY KEY,
        score INTEGER NOT NULL DEFAULT 0 CHECK (score >= -1000 AND score <= 1000),
        slash_version INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);

    // Create index on slash_version for monitoring
    await this.db.query(`
      CREATE INDEX IF NOT EXISTS idx_reputations_slash_version 
      ON reputations(slash_version)
    `);
  }

  /**
   * Drop the reputations table. Used for testing cleanup.
   */
  async dropSchema(): Promise<void> {
    await this.db.query('DROP TABLE IF EXISTS reputations CASCADE');
  }
}
