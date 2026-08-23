import { strict as assert } from 'assert';
import {
  BASE_SLASHING_PENALTY,
  calculatePenalty,
} from '../../src/slashing/penaltyCalculator';
import {
  SlashingExecutor,
  type SlashingDatabaseClient,
  type SlashingDatabasePool,
  type SlashingQueryResult,
} from '../../src/slashing/executor';
import {
  ValidatorRegistry,
  type ValidatorRegistryDatabase,
  type ValidatorRegistryQueryResult,
} from '../../src/staking/validatorRegistry';

class Deferred<T = void> {
  readonly promise: Promise<T>;
  private resolvePromise!: (value: T | PromiseLike<T>) => void;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  resolve(value: T extends void ? undefined : T = undefined as T extends void ? undefined : T): void {
    this.resolvePromise(value as T);
  }
}

class ExclusiveTableLock {
  private owner: object | undefined;
  private readonly waiters: Array<{ owner: object; acquired: Deferred }> = [];

  async acquire(owner: object): Promise<void> {
    if (!this.owner) {
      this.owner = owner;
      return;
    }
    const acquired = new Deferred();
    this.waiters.push({ owner, acquired });
    await acquired.promise;
  }

  release(owner: object): void {
    assert.equal(this.owner, owner, 'only the table-lock owner can release it');
    const next = this.waiters.shift();
    this.owner = next?.owner;
    next?.acquired.resolve();
  }
}

interface StoredEvent {
  event_id: string;
  validator_id: string;
  misbehavior_type: string;
  penalty_amount: number;
  base_penalty: number;
  total_validator_count: number;
  validator_count_at_slashing: number;
  created_at: Date;
}

class LockAwareDatabase implements SlashingDatabasePool, ValidatorRegistryDatabase {
  readonly validators = new Map<string, boolean>();
  readonly events: StoredEvent[] = [];
  readonly queryLog: Array<{ clientId: number | 'registry'; sql: string; params?: unknown[] }> = [];
  readonly lockAcquired = new Deferred();
  readonly secondSlashingLockAttempted = new Deferred();
  readonly continueSlashing = new Deferred();
  readonly membershipMutationAttempted = new Deferred();
  connectCount = 0;
  releaseCount = 0;
  pauseFirstSlashingLock = true;

  private readonly tableLock = new ExclusiveTableLock();
  private nextClientId = 1;
  private slashingLockAttempts = 0;

  async connect(): Promise<SlashingDatabaseClient> {
    this.connectCount += 1;
    return new LockAwareClient(this, this.nextClientId++);
  }

  async query<Row = unknown>(
    sql: string,
    params?: unknown[],
  ): Promise<ValidatorRegistryQueryResult<Row>> {
    this.queryLog.push({ clientId: 'registry', sql, params });
    const normalized = normalize(sql);

    if (normalized.startsWith('UPDATE VALIDATOR_REGISTRY')) {
      this.membershipMutationAttempted.resolve();
      const owner = {};
      await this.tableLock.acquire(owner);
      try {
        const validatorId = String(params?.[0]);
        if (!this.validators.has(validatorId)) return { rows: [] };
        const active = Boolean(params?.[1]);
        this.validators.set(validatorId, active);
        return {
          rows: [membershipRow(validatorId, active) as Row],
        };
      } finally {
        this.tableLock.release(owner);
      }
    }

    if (normalized.startsWith('INSERT INTO VALIDATOR_REGISTRY')) {
      this.membershipMutationAttempted.resolve();
      const owner = {};
      await this.tableLock.acquire(owner);
      try {
        const validatorId = String(params?.[0]);
        const active = Boolean(params?.[1]);
        this.validators.set(validatorId, active);
        return { rows: [membershipRow(validatorId, active) as Row] };
      } finally {
        this.tableLock.release(owner);
      }
    }

    if (normalized.includes('COUNT(*)') && normalized.includes('ACTIVE_VALIDATORS')) {
      return { rows: [{ count: this.activeCount() } as Row] };
    }
    if (normalized.startsWith('SELECT VALIDATOR_ID FROM ACTIVE_VALIDATORS')) {
      return {
        rows: Array.from(this.validators)
          .filter(([, active]) => active)
          .map(([validator_id]) => ({ validator_id }) as Row),
      };
    }
    throw new Error(`Unexpected registry query: ${sql}`);
  }

  activeCount(): number {
    return Array.from(this.validators.values()).filter(Boolean).length;
  }

  async acquireSlashingLock(owner: object): Promise<void> {
    this.slashingLockAttempts += 1;
    if (this.slashingLockAttempts === 2) {
      this.secondSlashingLockAttempted.resolve();
    }
    await this.tableLock.acquire(owner);
    this.lockAcquired.resolve();
    if (this.pauseFirstSlashingLock) {
      this.pauseFirstSlashingLock = false;
      await this.continueSlashing.promise;
    }
  }

  releaseSlashingLock(owner: object): void {
    this.tableLock.release(owner);
  }
}

class LockAwareClient implements SlashingDatabaseClient {
  private inTransaction = false;
  private hasTableLock = false;

  constructor(
    private readonly database: LockAwareDatabase,
    private readonly clientId: number,
  ) {}

  async query<Row = unknown>(sql: string, params?: unknown[]): Promise<SlashingQueryResult<Row>> {
    this.database.queryLog.push({ clientId: this.clientId, sql, params });
    const normalized = normalize(sql);

    if (normalized === 'BEGIN ISOLATION LEVEL SERIALIZABLE') {
      this.inTransaction = true;
      return { rows: [] };
    }
    if (normalized === 'LOCK TABLE VALIDATOR_REGISTRY IN SHARE ROW EXCLUSIVE MODE') {
      assert(this.inTransaction);
      await this.database.acquireSlashingLock(this);
      this.hasTableLock = true;
      return { rows: [] };
    }
    if (normalized.includes('COUNT(*)') && normalized.includes('ACTIVE_VALIDATORS')) {
      assert(this.hasTableLock, 'active membership must not be read before the table lock');
      return { rows: [{ count: this.database.activeCount() } as Row] };
    }
    if (normalized.startsWith('INSERT INTO SLASHING_EVENTS')) {
      assert(this.hasTableLock, 'event insert must remain in the locked transaction');
      const event: StoredEvent = {
        event_id: String(this.database.events.length + 1),
        validator_id: String(params?.[0]),
        misbehavior_type: String(params?.[1]),
        penalty_amount: Number(params?.[2]),
        base_penalty: Number(params?.[3]),
        total_validator_count: Number(params?.[4]),
        validator_count_at_slashing: Number(params?.[5]),
        created_at: new Date(),
      };
      this.database.events.push(event);
      return { rows: [event as Row] };
    }
    if (normalized === 'COMMIT' || normalized === 'ROLLBACK') {
      this.inTransaction = false;
      if (this.hasTableLock) {
        this.hasTableLock = false;
        this.database.releaseSlashingLock(this);
      }
      return { rows: [] };
    }
    throw new Error(`Unexpected slashing query: ${sql}`);
  }

  release(): void {
    assert(!this.inTransaction, 'client released with an open transaction');
    this.database.releaseCount += 1;
  }
}

class ScriptedClient implements SlashingDatabaseClient {
  readonly queries: string[] = [];
  released = false;

  constructor(
    private readonly failAt?: 'count' | 'insert' | 'commit' | 'rollback',
    private readonly activeCount = 3,
  ) {}

  async query<Row = unknown>(sql: string): Promise<SlashingQueryResult<Row>> {
    this.queries.push(normalize(sql));
    const normalized = normalize(sql);
    if (normalized.includes('COUNT(*)')) {
      if (this.failAt === 'count') throw new Error('count failed');
      return { rows: [{ count: this.activeCount } as Row] };
    }
    if (normalized.startsWith('INSERT INTO SLASHING_EVENTS')) {
      if (this.failAt === 'insert') throw new Error('insert failed');
      return {
        rows: [
          {
            event_id: '1',
            validator_id: 'validator-a',
            misbehavior_type: 'double-sign',
            penalty_amount: 625,
            base_penalty: 500,
            total_validator_count: 4,
            validator_count_at_slashing: this.activeCount,
            created_at: new Date(),
          } as Row,
        ],
      };
    }
    if (normalized === 'COMMIT' && this.failAt === 'commit') {
      throw new Error('commit failed');
    }
    if (normalized === 'ROLLBACK' && this.failAt === 'rollback') {
      throw new Error('rollback failed');
    }
    return { rows: [] };
  }

  release(): void {
    this.released = true;
  }
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim().toUpperCase();
}

function membershipRow(validatorId: string, active: boolean): object {
  const now = new Date();
  return {
    validator_id: validatorId,
    active,
    created_at: now,
    updated_at: now,
  };
}

function seed(database: LockAwareDatabase, active: number, inactive: number): void {
  for (let index = 1; index <= active; index += 1) {
    database.validators.set(`active-${index}`, true);
  }
  for (let index = 1; index <= inactive; index += 1) {
    database.validators.set(`inactive-${index}`, false);
  }
}

async function testFormulaAndValidation(): Promise<void> {
  assert.equal(BASE_SLASHING_PENALTY, 500);
  assert.deepEqual(calculatePenalty(10, 10), {
    penalty: 500,
    multiplier: 1,
    activeValidators: 10,
    totalValidators: 10,
    basePenalty: 500,
  });
  assert.equal(calculatePenalty(0, 10).multiplier, 2);
  assert.equal(calculatePenalty(0, 10).penalty, 1000);
  assert.equal(calculatePenalty({ activeValidators: 3, totalValidators: 4 }).penalty, 625);

  const invalidInputs: Array<() => unknown> = [
    () => calculatePenalty(0, 0),
    () => calculatePenalty(-1, 4),
    () => calculatePenalty(5, 4),
    () => calculatePenalty(1.5, 4),
    () => calculatePenalty(1, Number.POSITIVE_INFINITY),
    () => calculatePenalty(Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER + 1),
    () => calculatePenalty({ activeValidators: 1, totalValidators: 2, basePenalty: Number.NaN }),
  ];
  invalidInputs.forEach((invoke) => assert.throws(invoke, RangeError));
}

async function testRegistryApi(): Promise<void> {
  const database = new LockAwareDatabase();
  const registry = new ValidatorRegistry(database);
  await registry.addValidator('validator-b', false);
  await registry.registerValidator('validator-a');
  assert.deepEqual(await registry.getActiveValidatorIds(), ['validator-a']);
  assert.equal(await registry.getActiveValidatorCount(), 1);
  await registry.removeValidator('validator-a');
  assert.equal(await registry.getActiveValidatorCount(), 0);
  await assert.rejects(registry.activateValidator('missing'), /is not registered/);
}

async function testSlashWinsActivationRace(): Promise<void> {
  const database = new LockAwareDatabase();
  seed(database, 3, 1);
  const executor = new SlashingExecutor(database);
  const registry = new ValidatorRegistry(database);

  const slashPromise = executor.execute({
    validatorId: 'active-1',
    misbehaviorType: 'double-sign',
    totalValidators: 4,
  });
  await database.lockAcquired.promise;

  let activationFinished = false;
  const activationPromise = registry.activateValidator('inactive-1').then(() => {
    activationFinished = true;
  });
  await database.membershipMutationAttempted.promise;
  assert.equal(activationFinished, false);
  assert.equal(database.activeCount(), 3);

  database.continueSlashing.resolve();
  const event = await slashPromise;
  await activationPromise;

  assert.equal(event.validatorCountAtSlashing, 3);
  assert.equal(event.penalty, 625);
  assert.equal(database.events[0].validator_count_at_slashing, 3);
  assert.equal(database.activeCount(), 4);
  assert.equal(database.connectCount, 1);
  assert.equal(database.releaseCount, 1);

  const slashingQueries = database.queryLog.filter((entry) => entry.clientId === 1);
  assert.deepEqual(
    slashingQueries.map((entry) => normalize(entry.sql).split(' ')[0]),
    ['BEGIN', 'LOCK', 'SELECT', 'INSERT', 'COMMIT'],
  );
  assert(slashingQueries[0].sql.includes('SERIALIZABLE'));
  assert.equal(
    normalize(slashingQueries[1].sql),
    'LOCK TABLE VALIDATOR_REGISTRY IN SHARE ROW EXCLUSIVE MODE',
  );
  assert(normalize(slashingQueries[2].sql).includes('FROM ACTIVE_VALIDATORS'));
  assert(normalize(slashingQueries[3].sql).includes('VALIDATOR_COUNT_AT_SLASHING'));
  assert.equal(slashingQueries[3].params?.[5], 3);

  await registry.deactivateValidator('active-2');
  assert.equal(database.activeCount(), 3);
  assert.equal(database.events[0].validator_count_at_slashing, 3);
  assert.equal(database.events[0].penalty_amount, 625);
}

async function testSlashWinsNewValidatorJoinRace(): Promise<void> {
  const database = new LockAwareDatabase();
  seed(database, 3, 0);
  const executor = new SlashingExecutor(database);
  const registry = new ValidatorRegistry(database);

  const slashPromise = executor.execute({
    validatorId: 'active-1',
    misbehaviorType: 'double-sign',
    totalValidators: 4,
  });
  await database.lockAcquired.promise;

  let registrationFinished = false;
  const registrationPromise = registry.registerValidator('joining-validator', true).then(() => {
    registrationFinished = true;
  });
  await database.membershipMutationAttempted.promise;

  const registrationQuery = database.queryLog.find(
    (entry) =>
      entry.clientId === 'registry' &&
      normalize(entry.sql).startsWith('INSERT INTO VALIDATOR_REGISTRY'),
  );
  assert(registrationQuery, 'concurrent join must use INSERT INTO validator_registry');
  assert.equal(registrationFinished, false);
  assert.equal(database.validators.has('joining-validator'), false);
  assert.equal(database.activeCount(), 3);

  database.continueSlashing.resolve();
  const event = await slashPromise;

  assert.equal(event.validatorCountAtSlashing, 3);
  assert.equal(event.penalty, 625);
  assert.equal(event.basePenalty, BASE_SLASHING_PENALTY);
  assert.equal(database.events[0].base_penalty, BASE_SLASHING_PENALTY);
  assert.equal(database.events[0].validator_count_at_slashing, 3);

  await registrationPromise;
  assert.equal(database.activeCount(), 4);
  assert.equal(database.events[0].validator_count_at_slashing, 3);
  assert.equal(database.events[0].penalty_amount, 625);
}

async function testMembershipWinsRace(): Promise<void> {
  const database = new LockAwareDatabase();
  seed(database, 3, 1);
  database.pauseFirstSlashingLock = false;
  const registry = new ValidatorRegistry(database);
  await registry.activateValidator('inactive-1');

  const event = await new SlashingExecutor(database).slash({
    validatorId: 'active-1',
    misbehaviorType: 'equivocation',
    totalValidators: 4,
  });
  assert.equal(event.validatorCountAtSlashing, 4);
  assert.equal(event.penalty, 500);
}

async function testSlashWinsDeactivationRace(): Promise<void> {
  const database = new LockAwareDatabase();
  seed(database, 4, 0);
  const registry = new ValidatorRegistry(database);
  const slashPromise = new SlashingExecutor(database).execute({
    validatorId: 'active-1',
    misbehaviorType: 'invalid-vote',
    totalValidators: 4,
  });
  await database.lockAcquired.promise;
  let deactivationFinished = false;
  const deactivationPromise = registry.deactivateValidator('active-4').then(() => {
    deactivationFinished = true;
  });
  await database.membershipMutationAttempted.promise;
  assert.equal(deactivationFinished, false);
  database.continueSlashing.resolve();
  const event = await slashPromise;
  await deactivationPromise;
  assert.equal(event.validatorCountAtSlashing, 4);
  assert.equal(event.penalty, 500);
  assert.equal(database.activeCount(), 3);
}

async function testTwoSlashesSerialize(): Promise<void> {
  const database = new LockAwareDatabase();
  seed(database, 3, 1);
  const executor = new SlashingExecutor(database);
  const first = executor.execute({
    validatorId: 'active-1',
    misbehaviorType: 'first',
    totalValidators: 4,
  });
  await database.lockAcquired.promise;
  const second = executor.execute({
    validatorId: 'active-2',
    misbehaviorType: 'second',
    totalValidators: 4,
  });
  await database.secondSlashingLockAttempted.promise;
  assert.equal(database.events.length, 0);
  database.continueSlashing.resolve();
  const events = await Promise.all([first, second]);
  assert.deepEqual(events.map((event) => event.validatorCountAtSlashing), [3, 3]);
  assert.equal(database.releaseCount, 2);
}

async function testRollbackAndReleaseFailures(): Promise<void> {
  for (const failAt of ['count', 'insert', 'commit'] as const) {
    const client = new ScriptedClient(failAt);
    const executor = new SlashingExecutor({ connect: async () => client });
    await assert.rejects(
      executor.execute({
        validatorId: 'validator-a',
        misbehaviorType: 'double-sign',
        totalValidators: 4,
      }),
      new RegExp(`${failAt} failed`),
    );
    assert.equal(client.queries.at(-1), 'ROLLBACK');
    assert.equal(client.released, true);
  }

  const invalidCalculationClient = new ScriptedClient(undefined, 5);
  await assert.rejects(
    new SlashingExecutor({ connect: async () => invalidCalculationClient }).execute({
      validatorId: 'validator-a',
      misbehaviorType: 'double-sign',
      totalValidators: 4,
    }),
    /must not exceed/,
  );
  assert.equal(invalidCalculationClient.queries.at(-1), 'ROLLBACK');
  assert(!invalidCalculationClient.queries.some((query) => query.startsWith('INSERT')));
  assert.equal(invalidCalculationClient.released, true);

  const rollbackFailureClient = new ScriptedClient('rollback');
  const rollbackFailureExecutor = new SlashingExecutor({ connect: async () => rollbackFailureClient });
  await assert.rejects(
    rollbackFailureExecutor.execute({
      validatorId: 'validator-a',
      misbehaviorType: 'double-sign',
      totalValidators: 2,
    }),
    /must not exceed/,
  );
  assert.equal(rollbackFailureClient.queries.at(-1), 'ROLLBACK');
  assert.equal(rollbackFailureClient.released, true);
}

async function main(): Promise<void> {
  await testFormulaAndValidation();
  await testRegistryApi();
  await testSlashWinsActivationRace();
  await testSlashWinsNewValidatorJoinRace();
  await testMembershipWinsRace();
  await testSlashWinsDeactivationRace();
  await testTwoSlashesSerialize();
  await testRollbackAndReleaseFailures();
  console.log('slashing penalty consistency tests passed');
}

const deadlockTimeout = new Promise<never>((_, reject) => {
  setTimeout(() => reject(new Error('slashing race test deadlock timeout')), 5_000).unref();
});

Promise.race([main(), deadlockTimeout]).catch((error) => {
  console.error(error);
  process.exit(1);
});
