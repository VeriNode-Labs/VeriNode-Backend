/**
 * Reputation Service Module
 *
 * Provides race-condition-protected reputation scoring for nodes.
 * Uses atomic SQL operations to prevent write-skew anomalies.
 */

export { ReputationScoreService } from './scoreService';
export { ReputationStore } from './store';

export type { ReputationScore, RewardResult, SlashingResult } from './scoreService';

export type { ReputationRecord } from './store';
