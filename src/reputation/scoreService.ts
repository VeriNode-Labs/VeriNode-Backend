import { Database } from '../config/database';
import { ReputationStore } from './store';
import { createLogger } from '../diagnostics/logger';

export interface ReputationScore {
  nodeId: string;
  score: number;
  slashVersion: number;
  updatedAt: Date;
}

export interface RewardResult {
  nodeId: string;
  previousScore: number;
  newScore: number;
  delta: number;
}

export interface SlashingResult {
  nodeId: string;
  previousScore: number;
  newScore: number;
  delta: number;
  slashVersion: number;
}

/**
 * ReputationScoreService handles reputation score operations for nodes.
 *
 * RACE CONDITION PROTECTION:
 * This service prevents write-skew anomalies where concurrent reward and slashing
 * operations could cause one to overwrite the other. Three strategies are provided:
 *
 * 1. Atomic Operations (RECOMMENDED): applyReward() and applySlashing() use atomic
 *    SQL UPDATE statements that don't require read-then-write cycles. This is the
 *    most efficient and recommended approach.
 *
 * 2. Transactional with Locking: applyRewardTransactional() and applySlashingTransactional()
 *    use explicit transactions with FOR UPDATE row locks. Slashing uses NOWAIT for priority.
 *
 * 3. Slashing Priority Check: applyRewardWithSlashCheck() verifies slash_version before
 *    and after applying a reward to detect concurrent slashing and abort the reward.
 *
 * State Invariants:
 * - Score range: [-1000, 1000]
 * - Reward delta: +10 (configurable)
 * - Slashing delta: -500 (configurable)
 * - Slashing operations MUST always be applied
 * - Invariant: score_after_slash == score_before_slash - 500 (atomic guarantee)
 */
export class ReputationScoreService {
  private readonly store: ReputationStore;
  private readonly log = createLogger('reputation-service');

  // Configuration constants
  public static readonly REWARD_DELTA = 10;
  public static readonly SLASHING_DELTA = 500;
  public static readonly MIN_SCORE = -1000;
  public static readonly MAX_SCORE = 1000;

  constructor(private db: Database) {
    this.store = new ReputationStore(db);
  }

  /**
   * Get the current reputation score for a node.
   * @param nodeId The node identifier
   * @returns ReputationScore or null if node not found
   */
  async getReputationScore(nodeId: string): Promise<ReputationScore | null> {
    const record = await this.store.getReputationScore(nodeId);
    if (!record) {
      return null;
    }

    return {
      nodeId: record.node_id,
      score: record.score,
      slashVersion: record.slash_version,
      updatedAt: record.updated_at,
    };
  }

  /**
   * Initialize a reputation record for a new node.
   * @param nodeId The node identifier
   * @param initialScore Initial score (default 0)
   */
  async initializeNode(nodeId: string, initialScore: number = 0): Promise<void> {
    await this.store.initializeReputation(nodeId, initialScore);
    this.log.info('Node reputation initialized', { node_id: nodeId, initial_score: initialScore });
  }

  /**
   * Apply a reward to a node's reputation score using atomic SQL UPDATE.
   * This is the RECOMMENDED approach as it's race-condition-free and efficient.
   *
   * The operation is atomic and prevents read-modify-write race conditions.
   * Multiple concurrent rewards will be correctly serialized by PostgreSQL.
   *
   * @param nodeId The node identifier
   * @param delta The reward amount (default: REWARD_DELTA = 10)
   * @returns RewardResult with previous and new scores
   */
  async applyReward(
    nodeId: string,
    delta: number = ReputationScoreService.REWARD_DELTA,
  ): Promise<RewardResult> {
    // Get score before the update for reporting
    const before = await this.store.getReputationScore(nodeId);
    if (!before) {
      throw new Error(`Node ${nodeId} not found`);
    }

    // Apply reward atomically
    const newScore = await this.store.applyRewardAtomic(nodeId, delta);

    this.log.info('Reward applied', {
      node_id: nodeId,
      delta,
      previous_score: before.score,
      new_score: newScore,
    });

    return {
      nodeId,
      previousScore: before.score,
      newScore,
      delta,
    };
  }

  /**
   * Apply a slashing penalty to a node's reputation score using atomic SQL UPDATE.
   * This is the RECOMMENDED approach as it's race-condition-free and efficient.
   *
   * The operation is atomic and prevents read-modify-write race conditions.
   * The slash_version is incremented to track slashing events.
   *
   * @param nodeId The node identifier
   * @param delta The slashing penalty (default: SLASHING_DELTA = 500)
   * @returns SlashingResult with previous and new scores
   */
  async applySlashing(
    nodeId: string,
    delta: number = ReputationScoreService.SLASHING_DELTA,
  ): Promise<SlashingResult> {
    // Get score before the update for reporting
    const before = await this.store.getReputationScore(nodeId);
    if (!before) {
      throw new Error(`Node ${nodeId} not found`);
    }

    // Apply slashing atomically with version increment
    const result = await this.store.applySlashingAtomic(nodeId, delta);

    this.log.warn('Slashing applied', {
      node_id: nodeId,
      delta,
      previous_score: before.score,
      new_score: result.score,
      slash_version: result.slash_version,
    });

    return {
      nodeId,
      previousScore: before.score,
      newScore: result.score,
      delta,
      slashVersion: result.slash_version,
    };
  }

  /**
   * Apply a reward using explicit transaction with row-level locking.
   * This approach uses FOR UPDATE to lock the row during the transaction.
   *
   * Use this when you need to combine the reward with other transactional operations.
   * For simple reward operations, prefer applyReward() which is more efficient.
   *
   * @param nodeId The node identifier
   * @param delta The reward amount (default: REWARD_DELTA = 10)
   * @returns RewardResult with previous and new scores
   */
  async applyRewardTransactional(
    nodeId: string,
    delta: number = ReputationScoreService.REWARD_DELTA,
  ): Promise<RewardResult> {
    return await this.db.transaction(async (client) => {
      // Get score before update
      const beforeResult = await client.query<{ score: number }>(
        'SELECT score FROM reputations WHERE node_id = $1 FOR UPDATE',
        [nodeId],
      );

      if (beforeResult.rows.length === 0) {
        throw new Error(`Node ${nodeId} not found`);
      }

      const previousScore = beforeResult.rows[0].score;

      // Apply reward with lock held
      const newScore = await this.store.applyRewardWithLock(client, nodeId, delta);

      this.log.info('Reward applied (transactional)', {
        node_id: nodeId,
        delta,
        previous_score: previousScore,
        new_score: newScore,
      });

      return {
        nodeId,
        previousScore,
        newScore,
        delta,
      };
    });
  }

  /**
   * Apply a slashing penalty using explicit transaction with row-level locking.
   * This approach uses FOR UPDATE NOWAIT to prioritize slashing operations.
   *
   * Use this when you need to combine the slashing with other transactional operations.
   * For simple slashing operations, prefer applySlashing() which is more efficient.
   *
   * @param nodeId The node identifier
   * @param delta The slashing penalty (default: SLASHING_DELTA = 500)
   * @returns SlashingResult with previous and new scores
   */
  async applySlashingTransactional(
    nodeId: string,
    delta: number = ReputationScoreService.SLASHING_DELTA,
  ): Promise<SlashingResult> {
    return await this.db.transaction(async (client) => {
      // Get score before update
      const beforeResult = await client.query<{ score: number }>(
        'SELECT score FROM reputations WHERE node_id = $1 FOR UPDATE NOWAIT',
        [nodeId],
      );

      if (beforeResult.rows.length === 0) {
        throw new Error(`Node ${nodeId} not found`);
      }

      const previousScore = beforeResult.rows[0].score;

      // Apply slashing with lock held
      const result = await this.store.applySlashingWithLock(client, nodeId, delta);

      this.log.warn('Slashing applied (transactional)', {
        node_id: nodeId,
        delta,
        previous_score: previousScore,
        new_score: result.score,
        slash_version: result.slash_version,
      });

      return {
        nodeId,
        previousScore,
        newScore: result.score,
        delta,
        slashVersion: result.slash_version,
      };
    });
  }

  /**
   * Apply a reward with slash version check to detect concurrent slashing.
   * This approach checks the slash_version before and after applying the reward.
   * If a slashing occurred concurrently, the reward is rolled back.
   *
   * This is an alternative pattern when atomic operations or transactions are not suitable.
   *
   * @param nodeId The node identifier
   * @param delta The reward amount (default: REWARD_DELTA = 10)
   * @returns RewardResult with previous and new scores, or throws if concurrent slashing detected
   */
  async applyRewardWithSlashCheck(
    nodeId: string,
    delta: number = ReputationScoreService.REWARD_DELTA,
  ): Promise<RewardResult> {
    return await this.db.transaction(async (client) => {
      // Read current state
      const beforeResult = await client.query<{ score: number; slash_version: number }>(
        'SELECT score, slash_version FROM reputations WHERE node_id = $1',
        [nodeId],
      );

      if (beforeResult.rows.length === 0) {
        throw new Error(`Node ${nodeId} not found`);
      }

      const previousScore = beforeResult.rows[0].score;
      const slashVersionBefore = beforeResult.rows[0].slash_version;

      // Apply reward
      const newScore = Math.min(
        ReputationScoreService.MAX_SCORE,
        Math.max(ReputationScoreService.MIN_SCORE, previousScore + delta),
      );

      // Update with slash_version check
      const updateResult = await client.query<{ score: number; slash_version: number }>(
        `UPDATE reputations 
         SET score = $2, updated_at = NOW()
         WHERE node_id = $1 AND slash_version = $3
         RETURNING score, slash_version`,
        [nodeId, newScore, slashVersionBefore],
      );

      if (updateResult.rows.length === 0) {
        // Slash version changed, concurrent slashing occurred
        throw new Error(`Concurrent slashing detected for node ${nodeId}, reward aborted`);
      }

      this.log.info('Reward applied (with slash check)', {
        node_id: nodeId,
        delta,
        previous_score: previousScore,
        new_score: newScore,
      });

      return {
        nodeId,
        previousScore,
        newScore,
        delta,
      };
    });
  }

  /**
   * Initialize the database schema for reputation records.
   */
  async initializeSchema(): Promise<void> {
    await this.store.initializeSchema();
    this.log.info('Reputation schema initialized');
  }

  /**
   * Drop the database schema. Used for testing cleanup.
   */
  async dropSchema(): Promise<void> {
    await this.store.dropSchema();
    this.log.info('Reputation schema dropped');
  }
}
