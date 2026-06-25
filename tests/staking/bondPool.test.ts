import { BondPoolService, MAX_STAKE, MIN_STAKE, StakeAmountError } from '../../src/staking/bondPool';
import {
  PgBondPoolStore,
  InMemoryBondPoolStore,
  InsufficientPoolBalanceError,
  InsufficientStakeError,
  PoolNotFoundError,
  ValidatorStakeLimitError,
} from '../../src/staking/poolStore';

interface FakePoolRow {
  id: string;
  balance: bigint;
  version: bigint;
}

interface FakeStakeRow {
  pool_id: string;
  validator_id: string;
  amount: bigint;
}

class FakePgPool {
  readonly pools = new Map<string, FakePoolRow>();
  readonly stakes = new Map<string, FakeStakeRow>();
  readonly queries: string[] = [];
  rollbackFails = false;
  conflictNextIncrement = false;

  async query<T = unknown>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    return this.runQuery<T>(text, params);
  }

  async connect(): Promise<FakePgClient> {
    return new FakePgClient(this);
  }

  runQuery<T = unknown>(text: string, params: unknown[] = []): { rows: T[] } {
    this.queries.push(text);
    const normalized = text.replace(/\s+/g, ' ').trim();

    if (normalized === 'BEGIN' || normalized === 'COMMIT') {
      return { rows: [] };
    }

    if (normalized === 'ROLLBACK') {
      if (this.rollbackFails) {
        throw new Error('rollback failed');
      }
      return { rows: [] };
    }

    if (normalized.startsWith('SELECT p.id,')) {
      const pool = this.pools.get(String(params[0]));
      return { rows: pool ? [{ ...pool, balance: this.sumStakes(pool.id) } as T] : [] };
    }

    if (normalized === 'SELECT id FROM bond_pools WHERE id = $1') {
      const pool = this.pools.get(String(params[0]));
      return { rows: pool ? [{ id: pool.id } as T] : [] };
    }

    if (normalized === 'SELECT id, balance, version FROM bond_pools WHERE id = $1') {
      const pool = this.pools.get(String(params[0]));
      return { rows: pool ? [{ ...pool } as T] : [] };
    }

    if (normalized.startsWith('SELECT pool_id, validator_id, amount FROM validator_stakes')) {
      const stake = this.stakes.get(this.stakeKey(String(params[0]), String(params[1])));
      return { rows: stake ? [{ ...stake } as T] : [] };
    }

    if (normalized.startsWith('SELECT COALESCE(SUM(amount), 0) AS total FROM validator_stakes')) {
      return { rows: [{ total: this.sumStakes(String(params[0])) } as T] };
    }

    if (normalized.startsWith('INSERT INTO validator_stakes')) {
      const poolId = String(params[0]);
      const validatorId = String(params[1]);
      const amount = BigInt(String(params[2]));
      const maxStake = BigInt(String(params[3]));
      const key = this.stakeKey(poolId, validatorId);
      const existing = this.stakes.get(key);
      const nextAmount = (existing?.amount ?? 0n) + amount;

      if (nextAmount > maxStake) {
        return { rows: [] };
      }

      const stake = { pool_id: poolId, validator_id: validatorId, amount: nextAmount };
      this.stakes.set(key, stake);
      return { rows: [{ ...stake } as T] };
    }

    if (normalized.startsWith('UPDATE validator_stakes SET amount = amount - $1')) {
      const key = this.stakeKey(String(params[1]), String(params[2]));
      const stake = this.stakes.get(key);
      if (stake) {
        stake.amount -= BigInt(String(params[0]));
      }
      return { rows: [] };
    }

    if (normalized.startsWith('DELETE FROM validator_stakes')) {
      const key = this.stakeKey(String(params[0]), String(params[1]));
      if (this.stakes.get(key)?.amount === 0n) {
        this.stakes.delete(key);
      }
      return { rows: [] };
    }

    if (normalized.startsWith('UPDATE bond_pools SET balance = (')) {
      const pool = this.pools.get(String(params[0]));
      if (!pool) return { rows: [] };
      pool.balance = this.sumStakes(pool.id);
      pool.version += 1n;
      return { rows: [{ ...pool } as T] };
    }

    if (normalized.startsWith('UPDATE bond_pools SET balance = balance + $1')) {
      if (this.conflictNextIncrement) {
        this.conflictNextIncrement = false;
        return { rows: [] };
      }
      const pool = this.pools.get(String(params[1]));
      if (!pool || pool.version !== BigInt(String(params[2]))) return { rows: [] };
      pool.balance += BigInt(String(params[0]));
      pool.version += 1n;
      return { rows: [{ ...pool } as T] };
    }

    if (normalized.startsWith('UPDATE bond_pools SET balance = balance - $1')) {
      const pool = this.pools.get(String(params[1]));
      const amount = BigInt(String(params[0]));
      if (!pool || pool.version !== BigInt(String(params[2])) || pool.balance < amount) return { rows: [] };
      pool.balance -= amount;
      pool.version += 1n;
      return { rows: [{ ...pool } as T] };
    }

    throw new Error(`Unhandled fake query: ${normalized}`);
  }

  private sumStakes(poolId: string): bigint {
    let total = 0n;
    for (const stake of this.stakes.values()) {
      if (stake.pool_id === poolId) {
        total += stake.amount;
      }
    }
    return total;
  }

  private stakeKey(poolId: string, validatorId: string): string {
    return `${poolId}:${validatorId}`;
  }
}

class FakePgClient {
  released = false;

  constructor(private readonly pool: FakePgPool) {}

  async query<T = unknown>(text: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    return this.pool.runQuery<T>(text, params);
  }

  release(): void {
    this.released = true;
  }
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string): void {
    if (condition) {
      console.log(`  ok ${name}`);
      passed++;
    } else {
      console.log(`  fail ${name}`);
      failed++;
    }
  }

  console.log('\nBond Pool Tests\n');

  {
    const store = new InMemoryBondPoolStore();
    store.createPool({ id: 'pool-a', balance: 10000n, version: 0n });
    store.createStake({ poolId: 'pool-a', validatorId: 'anchor', amount: 10000n });
    const service = new BondPoolService(store);

    const operations: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      operations.push(service.stake('pool-a', `validator-${i}`, 1000n));
      operations.push(service.unstake('pool-a', 'anchor', 500n));
    }

    await Promise.all(operations);

    const pool = await service.getPool('pool-a');
    const derivedBalance = await service.getDerivedBalance('pool-a');

    assert(pool?.balance === 15000n, '20 concurrent stake/unstake operations preserve expected pool balance');
    assert(derivedBalance === 15000n, 'pool balance equals sum of validator stakes after concurrent operations');
    assert(pool?.balance === derivedBalance, 'stored balance remains synchronized with derived balance');
  }

  {
    const store = new InMemoryBondPoolStore();
    store.createPool({ id: 'pool-b', balance: 0n, version: 0n });
    const service = new BondPoolService(store);

    let minRejected = false;
    let maxRejected = false;

    try {
      await service.stake('pool-b', 'validator-a', MIN_STAKE - 1n);
    } catch (err) {
      minRejected = err instanceof StakeAmountError;
    }

    try {
      await service.stake('pool-b', 'validator-a', MAX_STAKE + 1n);
    } catch (err) {
      maxRejected = err instanceof StakeAmountError;
    }

    assert(minRejected, 'stake below minimum is rejected');
    assert(maxRejected, 'stake above maximum is rejected');
  }

  {
    const store = new InMemoryBondPoolStore();
    store.createPool({ id: 'pool-c', balance: 1000n, version: 0n });
    store.createStake({ poolId: 'pool-c', validatorId: 'validator-a', amount: 1000n });
    const service = new BondPoolService(store);

    let rejected = false;
    try {
      await service.unstake('pool-c', 'validator-a', 1100n);
    } catch (err) {
      rejected = err instanceof InsufficientStakeError;
    }

    const pool = await service.getPool('pool-c');
    assert(rejected, 'unstake above validator stake is rejected');
    assert(pool?.balance === 1000n, 'failed unstake leaves pool balance unchanged');
  }

  {
    const store = new InMemoryBondPoolStore();
    store.createPool({ id: 'pool-limit', balance: MAX_STAKE, version: 0n });
    store.createStake({ poolId: 'pool-limit', validatorId: 'validator-a', amount: MAX_STAKE });
    const service = new BondPoolService(store);

    let rejected = false;
    try {
      await service.stake('pool-limit', 'validator-a', MIN_STAKE);
    } catch (err) {
      rejected = err instanceof ValidatorStakeLimitError;
    }

    const pool = await service.getPool('pool-limit');
    const stake = await service.getValidatorStake('pool-limit', 'validator-a');
    assert(rejected, 'cumulative validator stake above maximum is rejected');
    assert(pool?.balance === MAX_STAKE, 'failed cumulative stake leaves pool balance unchanged');
    assert(stake?.amount === MAX_STAKE, 'failed cumulative stake leaves validator stake unchanged');
  }

  {
    const store = new InMemoryBondPoolStore();
    store.createPool({ id: 'pool-d', balance: 1n, version: 0n });
    store.createStake({ poolId: 'pool-d', validatorId: 'validator-a', amount: 700n });
    store.createStake({ poolId: 'pool-d', validatorId: 'validator-b', amount: 300n });
    const service = new BondPoolService(store);

    const reconciled = await service.reconcile('pool-d');
    assert(reconciled.balance === 1000n, 'reconciliation restores balance from validator stake sum');
  }

  {
    const pg = new FakePgPool();
    pg.pools.set('pool-pg', { id: 'pool-pg', balance: 1000n, version: 0n });
    pg.stakes.set('pool-pg:validator-a', {
      pool_id: 'pool-pg',
      validator_id: 'validator-a',
      amount: 1000n,
    });
    const store = new PgBondPoolStore(pg);
    const service = new BondPoolService(store);

    pg.conflictNextIncrement = true;
    const staked = await service.stake('pool-pg', 'validator-b', 500n);
    const unstaked = await service.unstake('pool-pg', 'validator-a', 200n);
    const pool = await service.getPool('pool-pg');
    const stake = await service.getValidatorStake('pool-pg', 'validator-b');
    const derivedBalance = await service.getDerivedBalance('pool-pg');

    assert(staked.balance === 1500n, 'pg stake uses atomic increment after optimistic retry');
    assert(unstaked.balance === 1300n, 'pg unstake uses atomic decrement');
    assert(pool?.balance === 1300n, 'pg getPool returns derived validator stake balance');
    assert(stake?.amount === 500n, 'pg getValidatorStake maps stake rows');
    assert(derivedBalance === 1300n, 'pg sumValidatorStakes returns validator stake total');
    assert(
      pg.queries.some((query) => query.includes('SET balance = balance + $1, version = version + 1')),
      'pg stake issues atomic balance increment SQL',
    );
    assert(
      pg.queries.some((query) => query.includes('SET balance = balance - $1, version = version + 1')),
      'pg unstake issues atomic balance decrement SQL',
    );
  }

  {
    const pg = new FakePgPool();
    pg.pools.set('pool-reconcile', { id: 'pool-reconcile', balance: 1n, version: 0n });
    pg.stakes.set('pool-reconcile:validator-a', {
      pool_id: 'pool-reconcile',
      validator_id: 'validator-a',
      amount: 900n,
    });
    const store = new PgBondPoolStore(pg);

    const reconciled = await store.reconcilePool('pool-reconcile');
    assert(reconciled.balance === 900n, 'pg reconciliation restores balance from validator stakes');
  }

  {
    const pg = new FakePgPool();
    pg.rollbackFails = true;
    const store = new PgBondPoolStore(pg);

    let missingPoolRejected = false;
    try {
      await store.stake('missing-pool', 'validator-a', 100n);
    } catch (err) {
      missingPoolRejected = err instanceof PoolNotFoundError;
    }

    assert(missingPoolRejected, 'pg stake rejects missing pool');
  }

  {
    const pg = new FakePgPool();
    pg.pools.set('pool-pg-limit', { id: 'pool-pg-limit', balance: MAX_STAKE, version: 0n });
    pg.stakes.set('pool-pg-limit:validator-a', {
      pool_id: 'pool-pg-limit',
      validator_id: 'validator-a',
      amount: MAX_STAKE,
    });
    const store = new PgBondPoolStore(pg);

    let limitRejected = false;
    try {
      await store.stake('pool-pg-limit', 'validator-a', 100n);
    } catch (err) {
      limitRejected = err instanceof ValidatorStakeLimitError;
    }

    assert(limitRejected, 'pg stake rejects cumulative validator stake above maximum');
  }

  {
    const pg = new FakePgPool();
    pg.pools.set('pool-pg-unstake', { id: 'pool-pg-unstake', balance: 50n, version: 0n });
    pg.stakes.set('pool-pg-unstake:validator-a', {
      pool_id: 'pool-pg-unstake',
      validator_id: 'validator-a',
      amount: 500n,
    });
    const store = new PgBondPoolStore(pg);

    let poolBalanceRejected = false;
    try {
      await store.unstake('pool-pg-unstake', 'validator-a', 100n);
    } catch (err) {
      poolBalanceRejected = err instanceof InsufficientPoolBalanceError;
    }

    let stakeRejected = false;
    try {
      await store.unstake('pool-pg-unstake', 'validator-a', 900n);
    } catch (err) {
      stakeRejected = err instanceof InsufficientStakeError;
    }

    assert(poolBalanceRejected, 'pg unstake rejects insufficient pool balance');
    assert(stakeRejected, 'pg unstake rejects insufficient validator stake');
  }

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('bondPool.test.ts crashed:', err);
  process.exit(1);
});
