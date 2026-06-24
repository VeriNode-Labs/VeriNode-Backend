import { Pool, PoolClient } from 'pg';

export interface ReputationRecord {
  nodeId: string;
  score: number;
  totalRewards: number;
  totalSlashings: number;
  slashVersion: bigint;
  lastRewardAt: Date | null;
  lastSlashAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReputationEvent {
  id: bigint;
  nodeId: string;
  eventType: 'reward' | 'slashing';
  delta: number;
  scoreBefore: number;
  scoreAfter: number;
  slashVersionAtEvent: bigint;
  reason?: string;
  metadata?: Record<string, any>;
  appliedAt: Date;
}

export interface AtomicUpdateResult {
  success: boolean;
  nodeId: string;
  scoreBefore: number;
  scoreAfter: number;
  slashVersion: bigint;
}

/**
 * ReputationStore provides race-condition-safe database operations for
 * reputation scoring. All update operations use atomic SQL statements
 * with row-level locking to prevent write-skew anomalies.
 */
export class ReputationStore {
  constructor(private readonly pool: Pool) {}

  /**
   * Get current reputation score for a node.
   * Returns null if node doesn't exist.
   */
  async getScore(nodeId: string): Promise<number | null> {
    const result = await this.pool.query<{ score: number }>(
      'SELECT score FROM reputations WHERE node_id = $1',
      [nodeId]
    );
    return result.rows.length > 0 ? result.rows[0].score : null;
  }

  /**
   * Get full reputation record for a node.
   */
  async getReputation(nodeId: string): Promise<ReputationRecord | null> {
    const result = await this.pool.query<{
      node_id: string;
      score: number;
      total_rewards: number;
      total_slashings: number;
      slash_version: string;
      last_reward_at: Date | null;
      last_slash_at: Date | null;
      created_at: Date;
      updated_at: Date;
    }>(
      `SELECT node_id, score, total_rewards, total_slashings, slash_version,
              last_reward_at, last_slash_at, created_at, updated_at
       FROM reputations WHERE node_id = $1`,
      [nodeId]
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      nodeId: row.node_id,
      score: row.score,
      totalRewards: row.total_rewards,
      totalSlashings: row.total_slashings,
      slashVersion: BigInt(row.slash_version),
      lastRewardAt: row.last_reward_at,
      lastSlashAt: row.last_slash_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Apply a reward atomically using UPDATE with arithmetic.
   * This is race-condition safe and doesn't require SELECT FOR UPDATE.
   * 
   * Ensures score stays within [-1000, 1000] range.
   */
  async applyReward(
    nodeId: string,
    delta: number,
    reason?: string,
    metadata?: Record<string, any>
  ): Promise<AtomicUpdateResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Insert node if doesn't exist
      await client.query(
        `INSERT INTO reputations (node_id, score)
         VALUES ($1, 0)
         ON CONFLICT (node_id) DO NOTHING`,
        [nodeId]
      );

      // Get score before update
      const beforeResult = await client.query<{ score: number; slash_version: string }>(
        `SELECT score, slash_version FROM reputations WHERE node_id = $1`,
        [nodeId]
      );

      if (beforeResult.rows.length === 0) {
        throw new Error(`Node ${nodeId} not found after insert`);
      }

      const { score: scoreBefore, slash_version } = beforeResult.rows[0];

      // Atomic update with score clamping
      const updateResult = await client.query<{
        score: number;
      }>(
        `UPDATE reputations
         SET score = LEAST(1000, GREATEST(-1000, score + $2)),
             total_rewards = total_rewards + 1,
             last_reward_at = NOW()
         WHERE node_id = $1
         RETURNING score`,
        [nodeId, delta]
      );

      const { score: scoreAfter } = updateResult.rows[0];

      // Log the event
      await client.query(
        `INSERT INTO reputation_events 
         (node_id, event_type, delta, score_before, score_after, slash_version_at_event, reason, metadata)
         VALUES ($1, 'reward', $2, $3, $4, $5, $6, $7)`,
        [nodeId, delta, scoreBefore, scoreAfter, slash_version, reason, metadata ? JSON.stringify(metadata) : null]
      );

      await client.query('COMMIT');

      return {
        success: true,
        nodeId,
        scoreBefore,
        scoreAfter,
        slashVersion: BigInt(slash_version),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Apply a slashing atomically using SELECT FOR UPDATE with priority locking.
   * Increments slash_version to detect concurrent slashings.
   * 
   * Uses NOWAIT to fail fast if another slashing is in progress,
   * ensuring slashing events are serialized.
   */
  async applySlashing(
    nodeId: string,
    delta: number,
    reason?: string,
    metadata?: Record<string, any>
  ): Promise<AtomicUpdateResult> {
    const client = await this.pool.connect();
    try {
      // Set lock timeout for priority access (slashing has priority)
      await client.query('SET LOCAL lock_timeout = 100');
      await client.query('BEGIN');

      // Insert node if doesn't exist
      await client.query(
        `INSERT INTO reputations (node_id, score)
         VALUES ($1, 0)
         ON CONFLICT (node_id) DO NOTHING`,
        [nodeId]
      );

      // Lock the row with NOWAIT for fast failure
      const lockResult = await client.query<{
        score: number;
        slash_version: string;
      }>(
        `SELECT score, slash_version
         FROM reputations
         WHERE node_id = $1
         FOR UPDATE NOWAIT`,
        [nodeId]
      );

      if (lockResult.rows.length === 0) {
        throw new Error(`Node ${nodeId} not found after insert`);
      }

      const { score: scoreBefore, slash_version } = lockResult.rows[0];

      // Apply slashing with score clamping and increment slash_version
      const updateResult = await client.query<{
        score: number;
        slash_version: string;
      }>(
        `UPDATE reputations
         SET score = LEAST(1000, GREATEST(-1000, score + $2)),
             total_slashings = total_slashings + 1,
             slash_version = slash_version + 1,
             last_slash_at = NOW()
         WHERE node_id = $1
         RETURNING score, slash_version`,
        [nodeId, delta]
      );

      const { score: scoreAfter, slash_version: newSlashVersion } = updateResult.rows[0];

      // Log the event
      await client.query(
        `INSERT INTO reputation_events 
         (node_id, event_type, delta, score_before, score_after, slash_version_at_event, reason, metadata)
         VALUES ($1, 'slashing', $2, $3, $4, $5, $6, $7)`,
        [nodeId, delta, scoreBefore, scoreAfter, newSlashVersion, reason, metadata ? JSON.stringify(metadata) : null]
      );

      await client.query('COMMIT');

      return {
        success: true,
        nodeId,
        scoreBefore,
        scoreAfter,
        slashVersion: BigInt(newSlashVersion),
      };
    } catch (err) {
      await client.query('ROLLBACK');
      
      // Handle lock timeout or NOWAIT failures
      if (err instanceof Error && 
          (err.message.includes('lock_timeout') || 
           err.message.includes('could not obtain lock'))) {
        throw new Error(`Slashing already in progress for node ${nodeId}`);
      }
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Get reputation event history for a node.
   */
  async getEvents(
    nodeId: string,
    limit: number = 100
  ): Promise<ReputationEvent[]> {
    const result = await this.pool.query<{
      id: string;
      node_id: string;
      event_type: 'reward' | 'slashing';
      delta: number;
      score_before: number;
      score_after: number;
      slash_version_at_event: string;
      reason: string | null;
      metadata: any;
      applied_at: Date;
    }>(
      `SELECT id, node_id, event_type, delta, score_before, score_after,
              slash_version_at_event, reason, metadata, applied_at
       FROM reputation_events
       WHERE node_id = $1
       ORDER BY applied_at DESC
       LIMIT $2`,
      [nodeId, limit]
    );

    return result.rows.map(row => ({
      id: BigInt(row.id),
      nodeId: row.node_id,
      eventType: row.event_type,
      delta: row.delta,
      scoreBefore: row.score_before,
      scoreAfter: row.score_after,
      slashVersionAtEvent: BigInt(row.slash_version_at_event),
      reason: row.reason ?? undefined,
      metadata: row.metadata ?? undefined,
      appliedAt: row.applied_at,
    }));
  }

  /**
   * Detect concurrent events (within 1 second window) for testing.
   */
  async findConcurrentEvents(
    nodeId: string,
    windowSeconds: number = 1
  ): Promise<ReputationEvent[][]> {
    const result = await this.pool.query<{
      id: string;
      node_id: string;
      event_type: 'reward' | 'slashing';
      delta: number;
      score_before: number;
      score_after: number;
      slash_version_at_event: string;
      reason: string | null;
      metadata: any;
      applied_at: Date;
    }>(
      `SELECT e1.*, e2.id as concurrent_id
       FROM reputation_events e1
       JOIN reputation_events e2 ON e1.node_id = e2.node_id
       WHERE e1.node_id = $1
         AND e1.id < e2.id
         AND ABS(EXTRACT(EPOCH FROM (e1.applied_at - e2.applied_at))) < $2
       ORDER BY e1.applied_at`,
      [nodeId, windowSeconds]
    );

    const groups: Map<string, ReputationEvent[]> = new Map();
    
    for (const row of result.rows) {
      const key = row.applied_at.toISOString();
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push({
        id: BigInt(row.id),
        nodeId: row.node_id,
        eventType: row.event_type,
        delta: row.delta,
        scoreBefore: row.score_before,
        scoreAfter: row.score_after,
        slashVersionAtEvent: BigInt(row.slash_version_at_event),
        reason: row.reason ?? undefined,
        metadata: row.metadata ?? undefined,
        appliedAt: row.applied_at,
      });
    }

    return Array.from(groups.values());
  }
}
