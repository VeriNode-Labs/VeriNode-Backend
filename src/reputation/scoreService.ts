import { ReputationStore, AtomicUpdateResult, ReputationRecord } from './store';
import { createLogger } from '../diagnostics/logger';

/**
 * Reputation score parameters and invariants
 */
export const REPUTATION_CONFIG = {
  REWARD_DELTA: 10,
  SLASHING_DELTA: -500,
  MIN_SCORE: -1000,
  MAX_SCORE: 1000,
} as const;

/**
 * Reason codes for reputation events
 */
export enum RewardReason {
  SUCCESSFUL_ATTESTATION = 'successful_attestation',
  UPTIME_ACHIEVEMENT = 'uptime_achievement',
  VALID_HEARTBEAT = 'valid_heartbeat',
}

export enum SlashingReason {
  PROVEN_FRAUD = 'proven_fraud',
  DOUBLE_SIGNING = 'double_signing',
  EXTENDED_DOWNTIME = 'extended_downtime',
  INVALID_ATTESTATION = 'invalid_attestation',
}

export interface ApplyRewardParams {
  nodeId: string;
  reason: RewardReason;
  metadata?: {
    blockHeight?: number;
    attestationId?: string;
    [key: string]: any;
  };
}

export interface ApplySlashingParams {
  nodeId: string;
  reason: SlashingReason;
  metadata?: {
    evidenceHash?: string;
    blockHeight?: number;
    violationType?: string;
    [key: string]: any;
  };
}

export interface ScoreResult {
  nodeId: string;
  scoreBefore: number;
  scoreAfter: number;
  delta: number;
  appliedAt: Date;
}

/**
 * ReputationScoreService provides high-level business logic for managing
 * node reputation scores. It uses atomic database operations to prevent
 * race conditions when concurrent reward and slashing events occur.
 * 
 * Key Invariants:
 * - Slashing events ALWAYS take priority over rewards
 * - Score range is strictly enforced: [-1000, 1000]
 * - Slashing delta: -500 (always applied atomically)
 * - Reward delta: +10 (may be lost if slashing is concurrent)
 * - All operations are logged to reputation_events for audit
 * 
 * Race Condition Prevention:
 * - applySlashing() uses SELECT FOR UPDATE NOWAIT for serialized access
 * - applyReward() uses atomic UPDATE with arithmetic operations
 * - Concurrent events are detected and logged
 */
export class ReputationScoreService {
  private log = createLogger('reputation_score_service', { 
    'service.name': 'reputation',
    'service.version': '1.0.0'
  });

  constructor(private readonly store: ReputationStore) {}

  /**
   * Get current reputation score for a node.
   * Returns 0 if node has no reputation record yet.
   */
  async getReputationScore(nodeId: string): Promise<number> {
    const score = await this.store.getScore(nodeId);
    return score ?? 0;
  }

  /**
   * Get full reputation record for a node.
   */
  async getReputation(nodeId: string): Promise<ReputationRecord | null> {
    return this.store.getReputation(nodeId);
  }

  /**
   * Apply a reward to a node's reputation score.
   * 
   * This operation is atomic and will not cause a race condition.
   * However, if a slashing occurs concurrently, the reward may be
   * overshadowed by the slashing's larger negative impact.
   * 
   * @param params - Reward parameters including nodeId and reason
   * @returns ScoreResult with before/after scores
   */
  async applyReward(params: ApplyRewardParams): Promise<ScoreResult> {
    const { nodeId, reason, metadata } = params;

    this.log.info('Applying reputation reward', {
      'node.id': nodeId,
      'reward.reason': reason,
      'reward.delta': REPUTATION_CONFIG.REWARD_DELTA,
    });

    try {
      const result = await this.store.applyReward(
        nodeId,
        REPUTATION_CONFIG.REWARD_DELTA,
        reason,
        metadata
      );

      this.log.info('Reward applied successfully', {
        'node.id': nodeId,
        'score.before': result.scoreBefore,
        'score.after': result.scoreAfter,
        'slash.version': result.slashVersion.toString(),
      });

      return {
        nodeId: result.nodeId,
        scoreBefore: result.scoreBefore,
        scoreAfter: result.scoreAfter,
        delta: REPUTATION_CONFIG.REWARD_DELTA,
        appliedAt: new Date(),
      };
    } catch (err) {
      this.log.error('Failed to apply reward', {
        'node.id': nodeId,
        'error.message': err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Apply a slashing penalty to a node's reputation score.
   * 
   * This operation has PRIORITY over concurrent rewards. It uses
   * row-level locking with NOWAIT to ensure serialized execution.
   * If another slashing is in progress, this will fail fast.
   * 
   * Invariant: score_after_slash == score_before_slash - 500 (atomic guarantee)
   * 
   * @param params - Slashing parameters including nodeId and reason
   * @returns ScoreResult with before/after scores
   * @throws Error if slashing already in progress for this node
   */
  async applySlashing(params: ApplySlashingParams): Promise<ScoreResult> {
    const { nodeId, reason, metadata } = params;

    this.log.warn('Applying reputation slashing', {
      'node.id': nodeId,
      'slashing.reason': reason,
      'slashing.delta': REPUTATION_CONFIG.SLASHING_DELTA,
    });

    try {
      const result = await this.store.applySlashing(
        nodeId,
        REPUTATION_CONFIG.SLASHING_DELTA,
        reason,
        metadata
      );

      this.log.warn('Slashing applied successfully', {
        'node.id': nodeId,
        'score.before': result.scoreBefore,
        'score.after': result.scoreAfter,
        'slash.version': result.slashVersion.toString(),
      });

      // Verify invariant: slash was fully applied
      const expectedAfter = Math.max(
        REPUTATION_CONFIG.MIN_SCORE,
        result.scoreBefore + REPUTATION_CONFIG.SLASHING_DELTA
      );

      if (result.scoreAfter !== expectedAfter) {
        this.log.error('Slashing invariant violation detected', {
          'node.id': nodeId,
          'score.before': result.scoreBefore,
          'score.after': result.scoreAfter,
          'expected.after': expectedAfter,
        });
      }

      return {
        nodeId: result.nodeId,
        scoreBefore: result.scoreBefore,
        scoreAfter: result.scoreAfter,
        delta: REPUTATION_CONFIG.SLASHING_DELTA,
        appliedAt: new Date(),
      };
    } catch (err) {
      this.log.error('Failed to apply slashing', {
        'node.id': nodeId,
        'error.message': err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Apply multiple rewards in batch (for testing concurrent operations).
   * Each reward is applied independently and atomically.
   */
  async applyRewardBatch(params: ApplyRewardParams[]): Promise<ScoreResult[]> {
    return Promise.all(params.map(p => this.applyReward(p)));
  }

  /**
   * Apply multiple slashings in batch (for testing concurrent operations).
   * Each slashing is applied independently with row-level locking.
   */
  async applySlashingBatch(params: ApplySlashingParams[]): Promise<ScoreResult[]> {
    const results: ScoreResult[] = [];
    const errors: Error[] = [];

    for (const param of params) {
      try {
        const result = await this.applySlashing(param);
        results.push(result);
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // If all slashings failed, throw the first error
    if (results.length === 0 && errors.length > 0) {
      throw errors[0];
    }

    return results;
  }

  /**
   * Get event history for a node.
   */
  async getEventHistory(nodeId: string, limit: number = 100) {
    return this.store.getEvents(nodeId, limit);
  }

  /**
   * Detect if concurrent events occurred for a node (for testing).
   */
  async detectConcurrentEvents(nodeId: string, windowSeconds: number = 1) {
    const groups = await this.store.findConcurrentEvents(nodeId, windowSeconds);
    return {
      hasConcurrentEvents: groups.length > 0,
      concurrentGroups: groups,
    };
  }
}
