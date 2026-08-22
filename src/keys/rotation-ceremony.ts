import { randomUUID } from 'crypto';
import {
  VALIDATOR_KEY_ROTATION_EVENT,
  calculateRotationApprovalThreshold,
  type RotationCommitResult,
  type RotationCommitter,
  type ValidatorKeyRotation,
} from '../consensus/commitment-broadcaster';
import { DuplicateKeyError, KeyRegistry, type KeyRecord } from './key-registry';

export const ROTATION_GRACE_EPOCHS = 256;
export const MIN_ROTATION_STAKE = 10_000n;
export const OLD_KEY_RETIREMENT_SLOTS = 4_096;

export type RotationPhase = 'INITIATE' | 'APPROVE' | 'ACTIVATE' | 'RETIRE';

export interface RotationRecord {
  rotationId: string;
  validatorId: string;
  oldPublicKey: string;
  newPublicKey: string;
  phase: RotationPhase;
  initiatedEpoch: number;
  initiatedSlot: number;
  approvedEpoch?: number;
  activatedEpoch?: number;
  activationSlot?: number;
  retiredEpoch?: number;
  approvals: readonly string[];
  approvalThreshold?: number;
  approvalValidatorSet: readonly string[];
}

export interface ValidatorStakeProvider {
  getValidatorStake(validatorId: string): bigint | Promise<bigint>;
}

export interface EpochSlotClock {
  currentEpoch(): number;
  currentSlot(): number;
}

export interface RotationCeremonyOptions {
  registry: KeyRegistry;
  stakeProvider: ValidatorStakeProvider;
  clock: EpochSlotClock;
  committer: RotationCommitter;
  rotationIdFactory?: () => string;
}

export interface InitiateRotationInput {
  validatorId: string;
  newPublicKey: string;
  rotationId?: string;
}

export class RotationCeremonyError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'RotationCeremonyError';
  }
}

export class InsufficientRotationStakeError extends RotationCeremonyError {
  constructor(validatorId: string, actualStake: bigint) {
    super(
      `Validator ${validatorId} has ${actualStake.toString()} VERI; ${MIN_ROTATION_STAKE.toString()} required`,
      'ERR_INSUFFICIENT_ROTATION_STAKE',
    );
    this.name = 'InsufficientRotationStakeError';
  }
}

function copyRecord(record: RotationRecord): RotationRecord {
  return {
    ...record,
    approvals: [...record.approvals],
    approvalValidatorSet: [...record.approvalValidatorSet],
  };
}

function assertProtocolNumber(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RotationCeremonyError(`${field} must be a non-negative safe integer`, 'ERR_INVALID_PROTOCOL_CLOCK');
  }
}

export class RotationCeremony {
  private readonly registry: KeyRegistry;
  private readonly stakeProvider: ValidatorStakeProvider;
  private readonly clock: EpochSlotClock;
  private readonly committer: RotationCommitter;
  private readonly rotationIdFactory: () => string;
  private readonly rotations = new Map<string, RotationRecord>();
  private readonly activeRotationByValidator = new Map<string, string>();
  private readonly approvalAttempts = new Map<string, Promise<RotationRecord>>();

  constructor(options: RotationCeremonyOptions) {
    this.registry = options.registry;
    this.stakeProvider = options.stakeProvider;
    this.clock = options.clock;
    this.committer = options.committer;
    this.rotationIdFactory = options.rotationIdFactory ?? randomUUID;
  }

  async initiate(input: InitiateRotationInput): Promise<RotationRecord> {
    if (!input.validatorId || !input.newPublicKey) {
      throw new RotationCeremonyError('validatorId and newPublicKey are required', 'ERR_INVALID_ROTATION');
    }

    // Reject keys already known at call time before waiting on external stake
    // state. reservePendingKey() repeats this check after the await to close the
    // race with another concurrent registration.
    if (this.registry.hasPublicKey(input.newPublicKey)) {
      throw new DuplicateKeyError(input.newPublicKey);
    }

    const stake = await this.stakeProvider.getValidatorStake(input.validatorId);
    if (stake < MIN_ROTATION_STAKE) {
      throw new InsufficientRotationStakeError(input.validatorId, stake);
    }

    const initiatedEpoch = this.clock.currentEpoch();
    const initiatedSlot = this.clock.currentSlot();
    assertProtocolNumber(initiatedEpoch, 'currentEpoch');
    assertProtocolNumber(initiatedSlot, 'currentSlot');

    // No await occurs from this check through reservation and record creation.
    // JavaScript's run-to-completion semantics make the check-and-act atomic.
    const conflictingRotationId = this.activeRotationByValidator.get(input.validatorId);
    if (conflictingRotationId) {
      throw new RotationCeremonyError(
        `Validator ${input.validatorId} already has rotation ${conflictingRotationId} in progress`,
        'ERR_ROTATION_IN_PROGRESS',
      );
    }

    const oldKey = this.registry.getCurrentSigningKey(input.validatorId);
    if (!oldKey || oldKey.state !== 'ACTIVE' || !oldKey.signingEnabled) {
      throw new RotationCeremonyError(
        `Validator ${input.validatorId} has no active signing key`,
        'ERR_NO_ACTIVE_SIGNING_KEY',
      );
    }

    const rotationId = input.rotationId ?? this.rotationIdFactory();
    if (!rotationId || this.rotations.has(rotationId)) {
      throw new RotationCeremonyError(`Rotation id is already in use: ${rotationId}`, 'ERR_ROTATION_ID_CONFLICT');
    }

    let reserved = false;
    try {
      this.registry.reservePendingKey({
        validatorId: input.validatorId,
        publicKey: input.newPublicKey,
        registeredEpoch: initiatedEpoch,
      });
      reserved = true;

      const record: RotationRecord = {
        rotationId,
        validatorId: input.validatorId,
        oldPublicKey: oldKey.publicKey,
        newPublicKey: input.newPublicKey,
        phase: 'INITIATE',
        initiatedEpoch,
        initiatedSlot,
        approvals: [],
        approvalValidatorSet: [],
      };
      this.rotations.set(rotationId, record);
      this.activeRotationByValidator.set(input.validatorId, rotationId);
      return copyRecord(record);
    } catch (error) {
      if (reserved) this.registry.releasePendingKey(input.validatorId, input.newPublicKey);
      this.rotations.delete(rotationId);
      if (this.activeRotationByValidator.get(input.validatorId) === rotationId) {
        this.activeRotationByValidator.delete(input.validatorId);
      }
      throw error;
    }
  }

  approve(rotationId: string): Promise<RotationRecord> {
    const record = this.requireRotation(rotationId);
    if (record.phase !== 'INITIATE') return Promise.resolve(copyRecord(record));

    const existingAttempt = this.approvalAttempts.get(rotationId);
    if (existingAttempt) return existingAttempt.then(copyRecord);

    const attempt = this.performApproval(record);
    this.approvalAttempts.set(rotationId, attempt);
    const cleanup = (): void => {
      if (this.approvalAttempts.get(rotationId) === attempt) this.approvalAttempts.delete(rotationId);
    };
    attempt.then(cleanup, cleanup);
    return attempt;
  }

  activate(rotationId: string): RotationRecord {
    const record = this.requireRotation(rotationId);
    if (record.phase === 'ACTIVATE' || record.phase === 'RETIRE') return copyRecord(record);
    if (record.phase !== 'APPROVE') {
      throw new RotationCeremonyError(
        `Rotation ${rotationId} cannot activate from ${record.phase}`,
        'ERR_ILLEGAL_ROTATION_TRANSITION',
      );
    }

    const activatedEpoch = this.clock.currentEpoch();
    const activationSlot = this.clock.currentSlot();
    assertProtocolNumber(activatedEpoch, 'currentEpoch');
    assertProtocolNumber(activationSlot, 'currentSlot');

    this.registry.activateRotation({
      validatorId: record.validatorId,
      oldPublicKey: record.oldPublicKey,
      newPublicKey: record.newPublicKey,
      activationEpoch: activatedEpoch,
      activationSlot,
    });

    // Map replacement cannot fail after the atomic registry transition.
    const activated: RotationRecord = {
      ...record,
      phase: 'ACTIVATE',
      activatedEpoch,
      activationSlot,
    };
    this.rotations.set(rotationId, activated);
    return copyRecord(activated);
  }

  retire(rotationId: string): RotationRecord {
    const record = this.requireRotation(rotationId);
    if (record.phase === 'RETIRE') return copyRecord(record);
    if (record.phase !== 'ACTIVATE' || record.activationSlot === undefined) {
      throw new RotationCeremonyError(
        `Rotation ${rotationId} cannot retire from ${record.phase}`,
        'ERR_ILLEGAL_ROTATION_TRANSITION',
      );
    }

    const currentSlot = this.clock.currentSlot();
    const retiredEpoch = this.clock.currentEpoch();
    assertProtocolNumber(currentSlot, 'currentSlot');
    assertProtocolNumber(retiredEpoch, 'currentEpoch');
    const inactiveSlots = currentSlot - record.activationSlot;
    if (inactiveSlots < OLD_KEY_RETIREMENT_SLOTS) {
      throw new RotationCeremonyError(
        `Old key has been inactive for ${Math.max(0, inactiveSlots)} slots; ${OLD_KEY_RETIREMENT_SLOTS} required`,
        'ERR_RETIREMENT_DELAY',
      );
    }

    this.registry.retireKey(record.validatorId, record.oldPublicKey, retiredEpoch);
    const retired: RotationRecord = { ...record, phase: 'RETIRE', retiredEpoch };
    this.rotations.set(rotationId, retired);
    if (this.activeRotationByValidator.get(record.validatorId) === rotationId) {
      this.activeRotationByValidator.delete(record.validatorId);
    }
    return copyRecord(retired);
  }

  getRotation(rotationId: string): RotationRecord | undefined {
    const record = this.rotations.get(rotationId);
    return record ? copyRecord(record) : undefined;
  }

  listRotations(): RotationRecord[] {
    return [...this.rotations.values()].map(copyRecord);
  }

  getKey(publicKey: string): KeyRecord | undefined {
    return this.registry.getKey(publicKey);
  }

  private async performApproval(record: RotationRecord): Promise<RotationRecord> {
    const proposal: ValidatorKeyRotation = {
      type: VALIDATOR_KEY_ROTATION_EVENT,
      rotationId: record.rotationId,
      validatorId: record.validatorId,
      oldPublicKey: record.oldPublicKey,
      newPublicKey: record.newPublicKey,
      initiatedEpoch: record.initiatedEpoch,
      initiatedSlot: record.initiatedSlot,
    };
    const commitment = await this.committer.commitRotation(proposal);
    return this.persistApproval(record.rotationId, commitment);
  }

  private persistApproval(rotationId: string, commitment: RotationCommitResult): RotationRecord {
    const current = this.requireRotation(rotationId);
    if (current.phase !== 'INITIATE') return copyRecord(current);
    const activeValidatorIds = [...new Set(commitment.activeValidatorIds)];
    const approvals = [...new Set(commitment.approvals)];
    const expectedThreshold = calculateRotationApprovalThreshold(activeValidatorIds.length);
    const commitmentValid = commitment.rotationId === rotationId
      && commitment.approvalThreshold === expectedThreshold
      && approvals.length >= expectedThreshold
      && approvals.every((validatorId) => activeValidatorIds.includes(validatorId));
    if (!commitmentValid) {
      throw new RotationCeremonyError('Commitment did not prove rotation quorum', 'ERR_INVALID_ROTATION_COMMITMENT');
    }

    const approvedEpoch = this.clock.currentEpoch();
    assertProtocolNumber(approvedEpoch, 'currentEpoch');
    const approved: RotationRecord = {
      ...current,
      phase: 'APPROVE',
      approvedEpoch,
      approvals,
      approvalThreshold: expectedThreshold,
      approvalValidatorSet: activeValidatorIds,
    };
    this.rotations.set(rotationId, approved);
    return copyRecord(approved);
  }

  private requireRotation(rotationId: string): RotationRecord {
    const record = this.rotations.get(rotationId);
    if (!record) {
      throw new RotationCeremonyError(`Unknown rotation: ${rotationId}`, 'ERR_UNKNOWN_ROTATION');
    }
    return record;
  }
}
