import { EventEmitter } from 'events';
import { performance } from 'perf_hooks';

export const VALIDATOR_KEY_ROTATION_EVENT = 'ValidatorKeyRotation' as const;
export const DEFAULT_ROTATION_COMMIT_TIMEOUT_MS = 5_000;

export interface ValidatorKeyRotation {
  type: typeof VALIDATOR_KEY_ROTATION_EVENT;
  rotationId: string;
  validatorId: string;
  oldPublicKey: string;
  newPublicKey: string;
  initiatedEpoch: number;
  initiatedSlot: number;
}

export interface ActiveValidatorSetProvider {
  getActiveValidatorIds(): readonly string[] | Promise<readonly string[]>;
}

export interface RotationCommitResult {
  rotationId: string;
  approvals: readonly string[];
  approvalThreshold: number;
  activeValidatorIds: readonly string[];
}

export interface RotationCommitter {
  commitRotation(proposal: ValidatorKeyRotation): Promise<RotationCommitResult>;
}

export interface CommitmentBroadcasterOptions {
  activeValidators: ActiveValidatorSetProvider;
  timeoutMs?: number;
  maxCompletedCommitments?: number;
}

export type ApprovalStatus = 'COUNTED' | 'DUPLICATE' | 'INELIGIBLE' | 'UNKNOWN_ROTATION';

export interface ApprovalResult {
  status: ApprovalStatus;
  approvalCount: number;
  approvalThreshold?: number;
}

export class RotationCommitTimeoutError extends Error {
  readonly code = 'ERR_ROTATION_COMMIT_TIMEOUT';

  constructor(rotationId: string, timeoutMs: number) {
    super(`Rotation ${rotationId} did not reach quorum within ${timeoutMs}ms`);
    this.name = 'RotationCommitTimeoutError';
  }
}

export class RotationCommitError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = 'RotationCommitError';
  }
}

interface PendingCommitment {
  proposal: ValidatorKeyRotation;
  activeValidatorIds: readonly string[];
  eligibleValidators: ReadonlySet<string>;
  approvalThreshold: number;
  approvals: Set<string>;
  timer: ReturnType<typeof setTimeout>;
  promise: Promise<RotationCommitResult>;
  resolve: (result: RotationCommitResult) => void;
  reject: (error: Error) => void;
}

interface StartingCommitment {
  proposal: ValidatorKeyRotation;
  promise: Promise<RotationCommitResult>;
}

export function calculateRotationApprovalThreshold(activeValidatorCount: number): number {
  if (!Number.isSafeInteger(activeValidatorCount) || activeValidatorCount <= 0) {
    throw new RotationCommitError(
      'Rotation approval requires at least one active validator',
      'ERR_EMPTY_ACTIVE_VALIDATOR_SET',
    );
  }
  return Math.ceil((2 * activeValidatorCount) / 3);
}

function copyProposal(proposal: ValidatorKeyRotation): ValidatorKeyRotation {
  return { ...proposal };
}

function copyResult(result: RotationCommitResult): RotationCommitResult {
  return {
    rotationId: result.rotationId,
    approvals: [...result.approvals],
    approvalThreshold: result.approvalThreshold,
    activeValidatorIds: [...result.activeValidatorIds],
  };
}

function proposalsMatch(left: ValidatorKeyRotation, right: ValidatorKeyRotation): boolean {
  return left.type === right.type
    && left.rotationId === right.rotationId
    && left.validatorId === right.validatorId
    && left.oldPublicKey === right.oldPublicKey
    && left.newPublicKey === right.newPublicKey
    && left.initiatedEpoch === right.initiatedEpoch
    && left.initiatedSlot === right.initiatedSlot;
}

/** Dedicated event bus and quorum collector for validator-key rotations. */
export class CommitmentBroadcaster extends EventEmitter implements RotationCommitter {
  private readonly activeValidators: ActiveValidatorSetProvider;
  private readonly timeoutMs: number;
  private readonly maxCompletedCommitments: number;
  private readonly pending = new Map<string, PendingCommitment>();
  private readonly starting = new Map<string, StartingCommitment>();
  private readonly completed = new Map<string, { proposal: ValidatorKeyRotation; result: RotationCommitResult }>();

  constructor(options: CommitmentBroadcasterOptions) {
    super();
    this.activeValidators = options.activeValidators;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ROTATION_COMMIT_TIMEOUT_MS;
    this.maxCompletedCommitments = options.maxCompletedCommitments ?? 1_024;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new RotationCommitError('timeoutMs must be positive', 'ERR_INVALID_COMMIT_TIMEOUT');
    }
    if (!Number.isSafeInteger(this.maxCompletedCommitments) || this.maxCompletedCommitments < 0) {
      throw new RotationCommitError('maxCompletedCommitments must be a non-negative integer', 'ERR_INVALID_COMMIT_CACHE');
    }
  }

  commitRotation(proposal: ValidatorKeyRotation): Promise<RotationCommitResult> {
    this.validateProposal(proposal);
    const completed = this.completed.get(proposal.rotationId);
    if (completed) {
      this.assertSameProposal(completed.proposal, proposal);
      return Promise.resolve(copyResult(completed.result));
    }

    const pending = this.pending.get(proposal.rotationId);
    if (pending) {
      this.assertSameProposal(pending.proposal, proposal);
      return pending.promise.then(copyResult);
    }

    const starting = this.starting.get(proposal.rotationId);
    if (starting) {
      this.assertSameProposal(starting.proposal, proposal);
      return starting.promise.then(copyResult);
    }

    const stableProposal = copyProposal(proposal);
    const promise = this.startCommit(stableProposal);
    const entry: StartingCommitment = { proposal: stableProposal, promise };
    this.starting.set(proposal.rotationId, entry);
    const cleanup = (): void => {
      if (this.starting.get(proposal.rotationId) === entry) this.starting.delete(proposal.rotationId);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  approveRotation(rotationId: string, validatorId: string): ApprovalResult {
    const pending = this.pending.get(rotationId);
    if (!pending) return { status: 'UNKNOWN_ROTATION', approvalCount: 0 };
    if (!pending.eligibleValidators.has(validatorId)) {
      return {
        status: 'INELIGIBLE',
        approvalCount: pending.approvals.size,
        approvalThreshold: pending.approvalThreshold,
      };
    }
    if (pending.approvals.has(validatorId)) {
      return {
        status: 'DUPLICATE',
        approvalCount: pending.approvals.size,
        approvalThreshold: pending.approvalThreshold,
      };
    }

    pending.approvals.add(validatorId);
    const result: ApprovalResult = {
      status: 'COUNTED',
      approvalCount: pending.approvals.size,
      approvalThreshold: pending.approvalThreshold,
    };
    if (pending.approvals.size >= pending.approvalThreshold) this.completeCommitment(pending);
    return result;
  }

  get pendingCommitmentCount(): number {
    return this.pending.size;
  }

  private async startCommit(proposal: ValidatorKeyRotation): Promise<RotationCommitResult> {
    const startedAt = performance.now();
    const suppliedIds = await this.getActiveValidatorSnapshot(proposal.rotationId);
    const activeValidatorIds = [...new Set(suppliedIds.filter((id) => id.length > 0))];
    const approvalThreshold = calculateRotationApprovalThreshold(activeValidatorIds.length);

    let resolvePromise!: (result: RotationCommitResult) => void;
    let rejectPromise!: (error: Error) => void;
    const promise = new Promise<RotationCommitResult>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });

    const remainingTimeoutMs = Math.max(1, this.timeoutMs - (performance.now() - startedAt));
    const timer = setTimeout(() => {
      const current = this.pending.get(proposal.rotationId);
      if (!current) return;
      this.failCommitment(current, new RotationCommitTimeoutError(proposal.rotationId, this.timeoutMs));
    }, remainingTimeoutMs);

    const pending: PendingCommitment = {
      proposal,
      activeValidatorIds,
      eligibleValidators: new Set(activeValidatorIds),
      approvalThreshold,
      approvals: new Set<string>(),
      timer,
      promise,
      resolve: resolvePromise,
      reject: rejectPromise,
    };
    this.pending.set(proposal.rotationId, pending);

    try {
      this.emit(VALIDATOR_KEY_ROTATION_EVENT, copyProposal(proposal));
    } catch (error) {
      this.failCommitment(
        pending,
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    return promise;
  }

  private completeCommitment(pending: PendingCommitment): void {
    if (this.pending.get(pending.proposal.rotationId) !== pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(pending.proposal.rotationId);
    const result: RotationCommitResult = {
      rotationId: pending.proposal.rotationId,
      approvals: [...pending.approvals].sort(),
      approvalThreshold: pending.approvalThreshold,
      activeValidatorIds: [...pending.activeValidatorIds],
    };
    this.rememberCompleted(pending.proposal, result);
    pending.resolve(copyResult(result));
  }

  private failCommitment(pending: PendingCommitment, error: Error): void {
    if (this.pending.get(pending.proposal.rotationId) !== pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(pending.proposal.rotationId);
    pending.reject(error);
  }

  private async getActiveValidatorSnapshot(rotationId: string): Promise<readonly string[]> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new RotationCommitTimeoutError(rotationId, this.timeoutMs)),
        this.timeoutMs,
      );
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.activeValidators.getActiveValidatorIds()),
        timeout,
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private rememberCompleted(proposal: ValidatorKeyRotation, result: RotationCommitResult): void {
    if (this.maxCompletedCommitments === 0) return;
    this.completed.set(proposal.rotationId, { proposal: copyProposal(proposal), result: copyResult(result) });
    while (this.completed.size > this.maxCompletedCommitments) {
      const oldest = this.completed.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.completed.delete(oldest);
    }
  }

  private validateProposal(proposal: ValidatorKeyRotation): void {
    if (proposal.type !== VALIDATOR_KEY_ROTATION_EVENT || !proposal.rotationId || !proposal.validatorId) {
      throw new RotationCommitError('Invalid validator-key rotation proposal', 'ERR_INVALID_ROTATION_PROPOSAL');
    }
    if (!proposal.oldPublicKey || !proposal.newPublicKey || proposal.oldPublicKey === proposal.newPublicKey) {
      throw new RotationCommitError('Rotation proposal must contain distinct keys', 'ERR_INVALID_ROTATION_PROPOSAL');
    }
  }

  private assertSameProposal(expected: ValidatorKeyRotation, received: ValidatorKeyRotation): void {
    if (!proposalsMatch(expected, received)) {
      throw new RotationCommitError(
        `Rotation id ${received.rotationId} was reused with different metadata`,
        'ERR_ROTATION_ID_CONFLICT',
      );
    }
  }

}

export function commitRotation(
  broadcaster: RotationCommitter,
  proposal: ValidatorKeyRotation,
): Promise<RotationCommitResult> {
  return broadcaster.commitRotation(proposal);
}
