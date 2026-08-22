import { KeyRegistry } from '../keys/key-registry';
import { calculateRotationApprovalThreshold } from '../consensus/commitment-broadcaster';
import {
  ROTATION_GRACE_EPOCHS,
  type EpochSlotClock,
  type RotationRecord,
} from '../keys/rotation-ceremony';

export const DOUBLE_SIGNING_MISBEHAVIOR = 'DOUBLE_SIGNING' as const;

export interface RotationRecordProvider {
  getRotation(rotationId: string): RotationRecord | undefined;
}

export interface KeyOverlapEvidence {
  validatorId: string;
  misbehaviorType: string;
  firstPublicKey: string;
  secondPublicKey: string;
  firstSigningSlot: number;
  secondSigningSlot: number;
  rotationId?: string;
}

export type PenaltyDecisionReason =
  | 'LEGITIMATE_ROTATION_OVERLAP'
  | 'NOT_DOUBLE_SIGNING'
  | 'NO_KNOWN_ROTATION'
  | 'ROTATION_NOT_ACTIVATED'
  | 'VALIDATOR_MISMATCH'
  | 'KEY_PAIR_MISMATCH'
  | 'EVIDENCE_OUTSIDE_ACTIVATION_TRANSITION'
  | 'INVALID_ROTATION_COMMITMENT'
  | 'INVALID_KEY_STATE'
  | 'OUTSIDE_ROTATION_GRACE_PERIOD';

export interface PenaltyDecision {
  penaltyRequired: boolean;
  suppressed: boolean;
  reason: PenaltyDecisionReason;
}

export interface PenaltyCalculatorOptions {
  rotations: RotationRecordProvider;
  registry: KeyRegistry;
  clock: EpochSlotClock;
}

function penalize(reason: Exclude<PenaltyDecisionReason, 'LEGITIMATE_ROTATION_OVERLAP'>): PenaltyDecision {
  return { penaltyRequired: true, suppressed: false, reason };
}

/**
 * Applies the narrowly scoped key-rotation exception to double-sign evidence.
 * The 256-epoch window is half-open: activationEpoch <= epoch < activationEpoch + 256.
 */
export class PenaltyCalculator {
  constructor(private readonly options: PenaltyCalculatorOptions) {}

  calculate(evidence: KeyOverlapEvidence): PenaltyDecision {
    if (evidence.misbehaviorType !== DOUBLE_SIGNING_MISBEHAVIOR) {
      return penalize('NOT_DOUBLE_SIGNING');
    }
    if (!evidence.rotationId) return penalize('NO_KNOWN_ROTATION');

    const rotation = this.options.rotations.getRotation(evidence.rotationId);
    if (!rotation) return penalize('NO_KNOWN_ROTATION');
    if (
      rotation.phase !== 'ACTIVATE'
      || rotation.approvedEpoch === undefined
      || rotation.activatedEpoch === undefined
      || rotation.activationSlot === undefined
    ) {
      return penalize('ROTATION_NOT_ACTIVATED');
    }
    if (rotation.validatorId !== evidence.validatorId) return penalize('VALIDATOR_MISMATCH');

    const exactPair = (
      evidence.firstPublicKey === rotation.oldPublicKey
      && evidence.secondPublicKey === rotation.newPublicKey
    ) || (
      evidence.firstPublicKey === rotation.newPublicKey
      && evidence.secondPublicKey === rotation.oldPublicKey
    );
    if (!exactPair || evidence.firstPublicKey === evidence.secondPublicKey) {
      return penalize('KEY_PAIR_MISMATCH');
    }

    const oldKeySigningSlot = evidence.firstPublicKey === rotation.oldPublicKey
      ? evidence.firstSigningSlot
      : evidence.secondSigningSlot;
    const newKeySigningSlot = evidence.firstPublicKey === rotation.newPublicKey
      ? evidence.firstSigningSlot
      : evidence.secondSigningSlot;
    const currentSlot = this.options.clock.currentSlot();
    const transitionEvidenceValid = Number.isSafeInteger(oldKeySigningSlot)
      && Number.isSafeInteger(newKeySigningSlot)
      && Number.isSafeInteger(currentSlot)
      && oldKeySigningSlot >= 0
      && oldKeySigningSlot < rotation.activationSlot
      && newKeySigningSlot >= rotation.activationSlot
      && newKeySigningSlot <= currentSlot;
    if (!transitionEvidenceValid) return penalize('EVIDENCE_OUTSIDE_ACTIVATION_TRANSITION');

    const uniqueApprovals = new Set(rotation.approvals);
    const eligibleValidators = new Set(rotation.approvalValidatorSet);
    const expectedThreshold = eligibleValidators.size > 0
      ? calculateRotationApprovalThreshold(eligibleValidators.size)
      : undefined;
    const commitmentValid = expectedThreshold !== undefined
      && rotation.approvalThreshold === expectedThreshold
      && uniqueApprovals.size >= expectedThreshold
      && [...uniqueApprovals].every((validatorId) => eligibleValidators.has(validatorId));
    if (!commitmentValid) return penalize('INVALID_ROTATION_COMMITMENT');

    const oldKey = this.options.registry.getKey(rotation.oldPublicKey);
    const newKey = this.options.registry.getKey(rotation.newPublicKey);
    const keyStateValid = oldKey?.validatorId === rotation.validatorId
      && oldKey.state === 'ACTIVE'
      && !oldKey.signingEnabled
      && oldKey.deactivationEpoch === rotation.activatedEpoch
      && oldKey.deactivationSlot === rotation.activationSlot
      && newKey?.validatorId === rotation.validatorId
      && newKey.state === 'ACTIVE'
      && newKey.signingEnabled
      && newKey.activationEpoch === rotation.activatedEpoch
      && newKey.activationSlot === rotation.activationSlot;
    if (!keyStateValid) return penalize('INVALID_KEY_STATE');

    const currentEpoch = this.options.clock.currentEpoch();
    const elapsedEpochs = currentEpoch - rotation.activatedEpoch;
    if (!Number.isSafeInteger(currentEpoch) || elapsedEpochs < 0 || elapsedEpochs >= ROTATION_GRACE_EPOCHS) {
      return penalize('OUTSIDE_ROTATION_GRACE_PERIOD');
    }

    return {
      penaltyRequired: false,
      suppressed: true,
      reason: 'LEGITIMATE_ROTATION_OVERLAP',
    };
  }

  shouldSuppress(evidence: KeyOverlapEvidence): boolean {
    return this.calculate(evidence).suppressed;
  }
}

export function shouldSuppressRotationOverlap(
  calculator: PenaltyCalculator,
  evidence: KeyOverlapEvidence,
): boolean {
  return calculator.shouldSuppress(evidence);
}
