import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import {
  CommitmentBroadcaster,
  RotationCommitTimeoutError,
  VALIDATOR_KEY_ROTATION_EVENT,
  calculateRotationApprovalThreshold,
  type ApprovalResult,
  type ValidatorKeyRotation,
} from '../../src/consensus/commitment-broadcaster';
import {
  DuplicateKeyError,
  ERR_DUPLICATE_KEY,
  KeyRegistry,
} from '../../src/keys/key-registry';
import {
  MIN_ROTATION_STAKE,
  OLD_KEY_RETIREMENT_SLOTS,
  ROTATION_GRACE_EPOCHS,
  RotationCeremony,
  RotationCeremonyError,
  type EpochSlotClock,
} from '../../src/keys/rotation-ceremony';
import {
  DOUBLE_SIGNING_MISBEHAVIOR,
  PenaltyCalculator,
} from '../../src/slashing/penalty-calculator';

class MutableClock implements EpochSlotClock {
  constructor(
    public epoch = 0,
    public slot = 0,
  ) {}

  currentEpoch(): number {
    return this.epoch;
  }

  currentSlot(): number {
    return this.slot;
  }
}

interface TestSystem {
  clock: MutableClock;
  registry: KeyRegistry;
  broadcaster: CommitmentBroadcaster;
  ceremony: RotationCeremony;
  stakes: Map<string, bigint>;
}

let rotationSequence = 0;

function createSystem(
  validators: readonly string[],
  options: { autoApprove?: boolean; timeoutMs?: number; defaultStake?: bigint } = {},
): TestSystem {
  const clock = new MutableClock(1, 10);
  const registry = new KeyRegistry();
  const stakes = new Map<string, bigint>();
  for (const validatorId of validators) {
    registry.registerActiveKey({
      validatorId,
      publicKey: `${validatorId}-old-key`,
      registeredEpoch: 0,
      activationSlot: 0,
    });
    stakes.set(validatorId, options.defaultStake ?? MIN_ROTATION_STAKE);
  }

  const broadcaster = new CommitmentBroadcaster({
    activeValidators: { getActiveValidatorIds: () => validators },
    timeoutMs: options.timeoutMs ?? 100,
  });
  if (options.autoApprove ?? true) {
    broadcaster.on(VALIDATOR_KEY_ROTATION_EVENT, (event: ValidatorKeyRotation) => {
      const threshold = calculateRotationApprovalThreshold(validators.length);
      for (const validatorId of validators.slice(0, threshold)) {
        broadcaster.approveRotation(event.rotationId, validatorId);
      }
    });
  }

  const ceremony = new RotationCeremony({
    registry,
    stakeProvider: { getValidatorStake: (validatorId) => stakes.get(validatorId) ?? 0n },
    clock,
    committer: broadcaster,
    rotationIdFactory: () => `rotation-${++rotationSequence}`,
  });
  return { clock, registry, broadcaster, ceremony, stakes };
}

function proposal(rotationId: string): ValidatorKeyRotation {
  return {
    type: VALIDATOR_KEY_ROTATION_EVENT,
    rotationId,
    validatorId: 'subject',
    oldPublicKey: 'old-key',
    newPublicKey: 'new-key',
    initiatedEpoch: 1,
    initiatedSlot: 2,
  };
}

async function withDeadline<T>(promise: Promise<T>, timeoutMs = 500): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Deadlock detector fired after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function testQuorumExamplesAndVoting(): Promise<void> {
  const expected = [1, 2, 2, 3, 4, 4, 5];
  assert.deepEqual(
    expected.map((_value, index) => calculateRotationApprovalThreshold(index + 1)),
    expected,
  );

  const broadcaster = new CommitmentBroadcaster({
    activeValidators: { getActiveValidatorIds: () => ['active-a', 'active-b', 'active-c'] },
    timeoutMs: 100,
  });
  const results: ApprovalResult[] = [];
  let signalSeen!: () => void;
  const seen = new Promise<void>((resolve) => { signalSeen = resolve; });
  broadcaster.on(VALIDATOR_KEY_ROTATION_EVENT, (event: ValidatorKeyRotation) => {
    results.push(broadcaster.approveRotation(event.rotationId, 'inactive-validator'));
    results.push(broadcaster.approveRotation(event.rotationId, 'unknown-validator'));
    results.push(broadcaster.approveRotation(event.rotationId, 'active-a'));
    results.push(broadcaster.approveRotation(event.rotationId, 'active-a'));
    signalSeen();
  });

  let settled = false;
  const commit = broadcaster.commitRotation(proposal('vote-test'));
  commit.then(() => { settled = true; }, () => { settled = true; });
  await seen;
  assert.equal(settled, false, 'below-threshold approval must remain pending');
  assert.deepEqual(results.map((result) => result.status), [
    'INELIGIBLE',
    'INELIGIBLE',
    'COUNTED',
    'DUPLICATE',
  ]);
  assert.equal(results[3].approvalCount, 1);

  const exact = broadcaster.approveRotation('vote-test', 'active-b');
  assert.equal(exact.approvalCount, 2);
  const committed = await commit;
  assert.deepEqual(committed.approvals, ['active-a', 'active-b']);
  assert.equal(committed.approvalThreshold, 2);
  assert.equal(broadcaster.pendingCommitmentCount, 0);
}

async function testConsensusTimeoutAndReplay(): Promise<void> {
  const timeoutBroadcaster = new CommitmentBroadcaster({
    activeValidators: { getActiveValidatorIds: () => ['a', 'b', 'c'] },
    timeoutMs: 20,
  });
  const startedAt = performance.now();
  await assert.rejects(
    timeoutBroadcaster.commitRotation(proposal('timeout-test')),
    (error: unknown) => error instanceof RotationCommitTimeoutError
      && error.code === 'ERR_ROTATION_COMMIT_TIMEOUT',
  );
  assert.ok(performance.now() - startedAt < 500, 'bounded timeout should complete comfortably below 500ms');
  assert.equal(timeoutBroadcaster.pendingCommitmentCount, 0);
  assert.deepEqual(timeoutBroadcaster.eventNames(), []);

  const snapshotTimeoutBroadcaster = new CommitmentBroadcaster({
    activeValidators: { getActiveValidatorIds: () => new Promise<readonly string[]>(() => undefined) },
    timeoutMs: 20,
  });
  await assert.rejects(
    snapshotTimeoutBroadcaster.commitRotation(proposal('snapshot-timeout-test')),
    (error: unknown) => errorCode(error) === 'ERR_ROTATION_COMMIT_TIMEOUT',
  );
  assert.equal(snapshotTimeoutBroadcaster.pendingCommitmentCount, 0);

  const replayBroadcaster = new CommitmentBroadcaster({
    activeValidators: { getActiveValidatorIds: () => ['only'] },
    timeoutMs: 100,
  });
  let emitted = 0;
  replayBroadcaster.on(VALIDATOR_KEY_ROTATION_EVENT, (event: ValidatorKeyRotation) => {
    emitted++;
    replayBroadcaster.approveRotation(event.rotationId, 'only');
  });
  const first = await replayBroadcaster.commitRotation(proposal('replay-test'));
  const replay = await replayBroadcaster.commitRotation(proposal('replay-test'));
  assert.deepEqual(replay, first);
  assert.equal(emitted, 1, 'completed proposal replay must be idempotent');
}

async function testStakeAndDuplicateBoundaries(): Promise<void> {
  const lowStake = createSystem(['low'], { defaultStake: 9_999n });
  await assert.rejects(
    lowStake.ceremony.initiate({ validatorId: 'low', newPublicKey: 'low-new' }),
    (error: unknown) => errorCode(error) === 'ERR_INSUFFICIENT_ROTATION_STAKE',
  );
  assert.equal(lowStake.registry.hasPublicKey('low-new'), false);

  const exactStake = createSystem(['exact']);
  const accepted = await exactStake.ceremony.initiate({ validatorId: 'exact', newPublicKey: 'exact-new' });
  assert.equal(accepted.phase, 'INITIATE');
  assert.equal(exactStake.registry.getKey('exact-new')?.state, 'PENDING');

  const duplicateSystem = createSystem(['one', 'two']);
  await assert.rejects(
    duplicateSystem.ceremony.initiate({ validatorId: 'one', newPublicKey: 'one-old-key' }),
    (error: unknown) => error instanceof DuplicateKeyError && error.code === ERR_DUPLICATE_KEY,
  );
  await assert.rejects(
    duplicateSystem.ceremony.initiate({ validatorId: 'one', newPublicKey: 'two-old-key' }),
    (error: unknown) => errorCode(error) === ERR_DUPLICATE_KEY,
  );

  await duplicateSystem.ceremony.initiate({ validatorId: 'one', newPublicKey: 'pending-key' });
  const duplicateStartedAt = performance.now();
  await assert.rejects(
    duplicateSystem.ceremony.initiate({ validatorId: 'two', newPublicKey: 'pending-key' }),
    (error: unknown) => errorCode(error) === ERR_DUPLICATE_KEY,
  );
  assert.ok(performance.now() - duplicateStartedAt < 500, 'indexed duplicate detection regressed past 500ms');
}

async function testKnownDuplicateSkipsSlowStakeLookup(): Promise<void> {
  const clock = new MutableClock(1, 10);
  const registry = new KeyRegistry();
  registry.registerActiveKey({
    validatorId: 'validator',
    publicKey: 'already-registered-key',
    registeredEpoch: 0,
  });
  let stakeLookups = 0;
  const ceremony = new RotationCeremony({
    registry,
    stakeProvider: {
      getValidatorStake: () => {
        stakeLookups++;
        return new Promise<bigint>((resolve) => {
          setTimeout(() => resolve(MIN_ROTATION_STAKE), 650);
        });
      },
    },
    clock,
    committer: new CommitmentBroadcaster({
      activeValidators: { getActiveValidatorIds: () => ['validator'] },
    }),
  });

  const startedAt = performance.now();
  await assert.rejects(
    ceremony.initiate({ validatorId: 'validator', newPublicKey: 'already-registered-key' }),
    (error: unknown) => errorCode(error) === ERR_DUPLICATE_KEY,
  );
  const elapsedMs = performance.now() - startedAt;
  assert.equal(stakeLookups, 0, 'known duplicates must not invoke external stake lookup');
  assert.ok(elapsedMs < 500, `known duplicate rejection took ${elapsedMs.toFixed(1)}ms`);
}

async function testLifecycleBoundariesAndSlashingSafety(): Promise<void> {
  const system = createSystem(['validator', 'voter-b', 'voter-c']);
  system.clock.epoch = 10;
  system.clock.slot = 100;
  const initiated = await system.ceremony.initiate({ validatorId: 'validator', newPublicKey: 'validator-new-key' });
  assert.equal(initiated.phase, 'INITIATE');
  assert.equal(system.registry.getKey('validator-new-key')?.registeredEpoch, 10);
  assert.equal(system.registry.getKey('validator-new-key')?.state, 'PENDING');

  system.clock.epoch = 11;
  const approved = await system.ceremony.approve(initiated.rotationId);
  assert.equal(approved.phase, 'APPROVE');
  assert.equal(approved.approvedEpoch, 11);
  assert.equal(approved.approvals.length, 2);
  assert.deepEqual(await system.ceremony.approve(initiated.rotationId), approved);

  system.clock.epoch = 20;
  system.clock.slot = 200;
  const activated = system.ceremony.activate(initiated.rotationId);
  assert.equal(activated.phase, 'ACTIVATE');
  assert.equal(activated.activatedEpoch, 20);
  assert.equal(activated.activationSlot, 200);
  assert.equal(system.registry.getKey('validator-new-key')?.state, 'ACTIVE');
  assert.equal(system.registry.getKey('validator-new-key')?.signingEnabled, true);
  assert.equal(system.registry.getKey('validator-old-key')?.state, 'ACTIVE');
  assert.equal(system.registry.getKey('validator-old-key')?.signingEnabled, false);
  assert.equal(system.registry.getKey('validator-old-key')?.deactivationSlot, 200);
  assert.deepEqual(system.ceremony.activate(initiated.rotationId), activated);

  const calculator = new PenaltyCalculator({
    rotations: system.ceremony,
    registry: system.registry,
    clock: system.clock,
  });
  const legitimateEvidence = {
    validatorId: 'validator',
    misbehaviorType: DOUBLE_SIGNING_MISBEHAVIOR,
    firstPublicKey: 'validator-old-key',
    secondPublicKey: 'validator-new-key',
    firstSigningSlot: 199,
    secondSigningSlot: 200,
    rotationId: initiated.rotationId,
  };

  system.clock.epoch = 20 + ROTATION_GRACE_EPOCHS - 1;
  assert.deepEqual(calculator.calculate(legitimateEvidence), {
    penaltyRequired: false,
    suppressed: true,
    reason: 'LEGITIMATE_ROTATION_OVERLAP',
  });
  assert.equal(calculator.shouldSuppress({ ...legitimateEvidence, validatorId: 'voter-b' }), false);
  assert.equal(calculator.shouldSuppress({ ...legitimateEvidence, secondPublicKey: 'unrelated-key' }), false);
  assert.equal(calculator.shouldSuppress({ ...legitimateEvidence, misbehaviorType: 'SURROUND_VOTE' }), false);
  assert.equal(calculator.calculate({ ...legitimateEvidence, firstSigningSlot: 201 }).reason, 'EVIDENCE_OUTSIDE_ACTIVATION_TRANSITION');
  const forgedThresholdCalculator = new PenaltyCalculator({
    rotations: {
      getRotation: (rotationId) => {
        const record = system.ceremony.getRotation(rotationId);
        return record ? { ...record, approvals: ['validator'], approvalThreshold: 1 } : undefined;
      },
    },
    registry: system.registry,
    clock: system.clock,
  });
  assert.equal(
    forgedThresholdCalculator.calculate(legitimateEvidence).reason,
    'INVALID_ROTATION_COMMITMENT',
  );

  system.clock.epoch = 20 + ROTATION_GRACE_EPOCHS;
  assert.equal(calculator.calculate(legitimateEvidence).reason, 'OUTSIDE_ROTATION_GRACE_PERIOD');
  assert.equal(calculator.shouldSuppress(legitimateEvidence), false);

  system.clock.slot = 200 + OLD_KEY_RETIREMENT_SLOTS - 1;
  assert.throws(
    () => system.ceremony.retire(initiated.rotationId),
    (error: unknown) => errorCode(error) === 'ERR_RETIREMENT_DELAY',
  );
  system.clock.slot = 200 + OLD_KEY_RETIREMENT_SLOTS;
  system.clock.epoch = 300;
  const retired = system.ceremony.retire(initiated.rotationId);
  assert.equal(retired.phase, 'RETIRE');
  assert.equal(retired.retiredEpoch, 300);
  assert.equal(system.registry.getKey('validator-old-key')?.state, 'RETIRED');
  assert.deepEqual(system.ceremony.retire(initiated.rotationId), retired);
  assert.deepEqual(system.ceremony.activate(initiated.rotationId), retired);
  assert.equal(calculator.calculate(legitimateEvidence).reason, 'ROTATION_NOT_ACTIVATED');
  system.registry.assertConsistent();
}

async function testIllegalTransitionsAndPendingKeyCannotBypassSlashing(): Promise<void> {
  const system = createSystem(['validator']);
  assert.throws(
    () => system.ceremony.approve('not-initiated'),
    (error: unknown) => errorCode(error) === 'ERR_UNKNOWN_ROTATION',
  );

  const initiated = await system.ceremony.initiate({ validatorId: 'validator', newPublicKey: 'new-key' });
  assert.throws(
    () => system.ceremony.activate(initiated.rotationId),
    (error: unknown) => errorCode(error) === 'ERR_ILLEGAL_ROTATION_TRANSITION',
  );
  assert.throws(
    () => system.ceremony.retire(initiated.rotationId),
    (error: unknown) => errorCode(error) === 'ERR_ILLEGAL_ROTATION_TRANSITION',
  );

  const calculator = new PenaltyCalculator({ rotations: system.ceremony, registry: system.registry, clock: system.clock });
  assert.equal(calculator.shouldSuppress({
    validatorId: 'validator',
    misbehaviorType: DOUBLE_SIGNING_MISBEHAVIOR,
    firstPublicKey: 'validator-old-key',
    secondPublicKey: 'new-key',
    firstSigningSlot: 9,
    secondSigningSlot: 10,
    rotationId: initiated.rotationId,
  }), false);

  await system.ceremony.approve(initiated.rotationId);
  assert.throws(
    () => system.ceremony.retire(initiated.rotationId),
    (error: unknown) => errorCode(error) === 'ERR_ILLEGAL_ROTATION_TRANSITION',
  );
}

async function testConcurrentDuplicateReservationRace(): Promise<void> {
  const registry = new KeyRegistry();
  const attempts = await Promise.allSettled([
    Promise.resolve().then(() => registry.reservePendingKey({
      validatorId: 'same-validator',
      publicKey: 'contended-key',
      registeredEpoch: 1,
    })),
    Promise.resolve().then(() => registry.reservePendingKey({
      validatorId: 'same-validator',
      publicKey: 'contended-key',
      registeredEpoch: 1,
    })),
  ]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = attempts.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  assert.equal(errorCode(rejected?.reason), ERR_DUPLICATE_KEY);
  assert.equal(registry.size, 1);
  registry.assertConsistent();
}

async function testConcurrentIndependentRotationsDoNotDeadlock(): Promise<void> {
  const validators = ['alpha', 'beta', 'gamma'];
  const system = createSystem(validators);
  const rotations = await withDeadline(Promise.all(validators.map((validatorId) => system.ceremony.initiate({
    validatorId,
    newPublicKey: `${validatorId}-new-key`,
  }))));
  assert.equal(new Set(rotations.map((record) => record.rotationId)).size, validators.length);

  const approved = await withDeadline(Promise.all(rotations.map((record) => system.ceremony.approve(record.rotationId))));
  assert.ok(approved.every((record) => record.phase === 'APPROVE'));

  system.clock.epoch = 2;
  system.clock.slot = 50;
  const activated = rotations.map((record) => system.ceremony.activate(record.rotationId));
  assert.ok(activated.every((record) => record.phase === 'ACTIVATE'));

  system.clock.epoch = 3;
  system.clock.slot = 50 + OLD_KEY_RETIREMENT_SLOTS;
  const retired = rotations.map((record) => system.ceremony.retire(record.rotationId));
  assert.ok(retired.every((record) => record.phase === 'RETIRE'));
  assert.equal(system.registry.size, validators.length * 2);
  assert.equal(new Set(validators.flatMap((id) => system.registry.getValidatorKeys(id).map((key) => key.publicKey))).size, validators.length * 2);
  system.registry.assertConsistent();
}

async function testInitiateFailureLeavesNoOrphan(): Promise<void> {
  const system = createSystem(['one', 'two']);
  await system.ceremony.initiate({ validatorId: 'one', newPublicKey: 'one-new', rotationId: 'fixed-id' });
  await assert.rejects(
    system.ceremony.initiate({ validatorId: 'two', newPublicKey: 'two-new', rotationId: 'fixed-id' }),
    (error: unknown) => errorCode(error) === 'ERR_ROTATION_ID_CONFLICT',
  );
  assert.equal(system.registry.hasPublicKey('two-new'), false);
  assert.equal(system.ceremony.listRotations().length, 1);
  system.registry.assertConsistent();
}

async function main(): Promise<void> {
  await testQuorumExamplesAndVoting();
  await testConsensusTimeoutAndReplay();
  await testStakeAndDuplicateBoundaries();
  await testKnownDuplicateSkipsSlowStakeLookup();
  await testLifecycleBoundariesAndSlashingSafety();
  await testIllegalTransitionsAndPendingKeyCannotBypassSlashing();
  await testConcurrentDuplicateReservationRace();
  await testConcurrentIndependentRotationsDoNotDeadlock();
  await testInitiateFailureLeavesNoOrphan();
  console.log('validator key rotation ceremony tests passed');
}

main().catch((error: unknown) => {
  if (error instanceof RotationCeremonyError) console.error(error.code, error.message);
  else console.error(error);
  process.exit(1);
});
