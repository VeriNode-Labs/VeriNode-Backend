export interface BondPool {
  id: string;
  balance: bigint;
  version: bigint;
}

export interface ValidatorStake {
  poolId: string;
  validatorId: string;
  amount: bigint;
}

export interface BondPoolStore {
  getPool(poolId: string): Promise<BondPool | null>;
  getValidatorStake(poolId: string, validatorId: string): Promise<ValidatorStake | null>;
  stake(poolId: string, validatorId: string, amount: bigint): Promise<BondPool>;
  unstake(poolId: string, validatorId: string, amount: bigint): Promise<BondPool>;
  sumValidatorStakes(poolId: string): Promise<bigint>;
  reconcilePool(poolId: string): Promise<BondPool>;
}

interface PoolRow {
  id: string;
  balance: string | number | bigint;
  version: string | number | bigint;
}

interface StakeRow {
  pool_id: string;
  validator_id: string;
  amount: string | number | bigint;
}

interface QueryResult<T = unknown> {
  rows: T[];
}

interface PgClient {
  query<T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  release(): void;
}

interface PgPool {
  query<T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
  connect(): Promise<PgClient>;
}

function toBigInt(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  return typeof value === 'bigint' ? value : BigInt(value);
}

function mapPool(row: PoolRow): BondPool {
  return {
    id: row.id,
    balance: toBigInt(row.balance),
    version: toBigInt(row.version),
  };
}

function mapStake(row: StakeRow): ValidatorStake {
  return {
    poolId: row.pool_id,
    validatorId: row.validator_id,
    amount: toBigInt(row.amount),
  };
}

export class PoolNotFoundError extends Error {
  constructor(poolId: string) {
    super(`Bond pool ${poolId} was not found`);
    this.name = 'PoolNotFoundError';
  }
}

export class InsufficientStakeError extends Error {
  constructor(validatorId: string, poolId: string) {
    super(`Validator ${validatorId} does not have enough stake in pool ${poolId}`);
    this.name = 'InsufficientStakeError';
  }
}

export class InsufficientPoolBalanceError extends Error {
  constructor(poolId: string) {
    super(`Bond pool ${poolId} does not have enough balance`);
    this.name = 'InsufficientPoolBalanceError';
  }
}

export class ValidatorStakeLimitError extends Error {
  constructor(validatorId: string, poolId: string, maxStake: bigint) {
    super(
      `Validator ${validatorId} stake in pool ${poolId} would exceed maximum ${maxStake.toString()}`,
    );
    this.name = 'ValidatorStakeLimitError';
  }
}

export class PgBondPoolStore implements BondPoolStore {
  private readonly maxOptimisticAttempts = 5;

  constructor(
    private readonly pool: PgPool,
    private readonly maxValidatorStake: bigint = 100000n,
  ) {}

  async getPool(poolId: string): Promise<BondPool | null> {
    const result = await this.pool.query<PoolRow>(
      `SELECT p.id,
              COALESCE((
                SELECT SUM(s.amount)
                FROM validator_stakes s
                WHERE s.pool_id = p.id
              ), 0) AS balance,
              p.version
       FROM bond_pools p
       WHERE p.id = $1`,
      [poolId],
    );
    return result.rows[0] ? mapPool(result.rows[0]) : null;
  }

  async getValidatorStake(poolId: string, validatorId: string): Promise<ValidatorStake | null> {
    const result = await this.pool.query<StakeRow>(
      'SELECT pool_id, validator_id, amount FROM validator_stakes WHERE pool_id = $1 AND validator_id = $2',
      [poolId, validatorId],
    );
    return result.rows[0] ? mapStake(result.rows[0]) : null;
  }

  async stake(poolId: string, validatorId: string, amount: bigint): Promise<BondPool> {
    return this.withTransaction(async (client) => {
      const poolExists = await client.query<{ id: string }>(
        'SELECT id FROM bond_pools WHERE id = $1',
        [poolId],
      );
      if (!poolExists.rows[0]) {
        throw new PoolNotFoundError(poolId);
      }

      const stake = await client.query<StakeRow>(
        `INSERT INTO validator_stakes (pool_id, validator_id, amount)
         VALUES ($1, $2, $3)
         ON CONFLICT (pool_id, validator_id)
         DO UPDATE SET amount = validator_stakes.amount + EXCLUDED.amount
         WHERE validator_stakes.amount + EXCLUDED.amount <= $4
         RETURNING pool_id, validator_id, amount`,
        [poolId, validatorId, amount.toString(), this.maxValidatorStake.toString()],
      );

      if (!stake.rows[0]) {
        throw new ValidatorStakeLimitError(validatorId, poolId, this.maxValidatorStake);
      }

      const updated = await this.incrementPoolBalance(client, poolId, amount);

      return mapPool(updated.rows[0]);
    });
  }

  async unstake(poolId: string, validatorId: string, amount: bigint): Promise<BondPool> {
    return this.withTransaction(async (client) => {
      const stake = await client.query<StakeRow>(
        `SELECT pool_id, validator_id, amount
         FROM validator_stakes
         WHERE pool_id = $1 AND validator_id = $2
         FOR UPDATE`,
        [poolId, validatorId],
      );

      if (!stake.rows[0] || toBigInt(stake.rows[0].amount) < amount) {
        throw new InsufficientStakeError(validatorId, poolId);
      }

      await client.query(
        `UPDATE validator_stakes
         SET amount = amount - $1
         WHERE pool_id = $2 AND validator_id = $3`,
        [amount.toString(), poolId, validatorId],
      );

      await client.query(
        'DELETE FROM validator_stakes WHERE pool_id = $1 AND validator_id = $2 AND amount = 0',
        [poolId, validatorId],
      );

      const updated = await this.decrementPoolBalance(client, poolId, amount);

      return mapPool(updated.rows[0]);
    });
  }

  async sumValidatorStakes(poolId: string): Promise<bigint> {
    const result = await this.pool.query<{ total: string | number | bigint | null }>(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM validator_stakes WHERE pool_id = $1',
      [poolId],
    );
    return toBigInt(result.rows[0]?.total);
  }

  async reconcilePool(poolId: string): Promise<BondPool> {
    const result = await this.pool.query<PoolRow>(
      `UPDATE bond_pools
       SET balance = (
         SELECT COALESCE(SUM(amount), 0)
         FROM validator_stakes
         WHERE pool_id = $1
       ),
       version = version + 1
       WHERE id = $1
       RETURNING id, balance, version`,
      [poolId],
    );

    if (!result.rows[0]) {
      throw new PoolNotFoundError(poolId);
    }

    return mapPool(result.rows[0]);
  }

  private async withTransaction<T>(fn: (client: PgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await this.rollback(client);
      throw err;
    } finally {
      client.release();
    }
  }

  private async incrementPoolBalance(client: PgClient, poolId: string, amount: bigint): Promise<QueryResult<PoolRow>> {
    for (let attempt = 0; attempt < this.maxOptimisticAttempts; attempt++) {
      const current = await client.query<PoolRow>(
        'SELECT id, balance, version FROM bond_pools WHERE id = $1',
        [poolId],
      );
      if (!current.rows[0]) {
        throw new PoolNotFoundError(poolId);
      }

      const updated = await client.query<PoolRow>(
        `UPDATE bond_pools
         SET balance = balance + $1, version = version + 1
         WHERE id = $2 AND version = $3
         RETURNING id, balance, version`,
        [amount.toString(), poolId, current.rows[0].version.toString()],
      );
      if (updated.rows[0]) {
        return updated;
      }
    }

    throw new Error(`Bond pool ${poolId} balance update conflicted too many times`);
  }

  private async decrementPoolBalance(client: PgClient, poolId: string, amount: bigint): Promise<QueryResult<PoolRow>> {
    for (let attempt = 0; attempt < this.maxOptimisticAttempts; attempt++) {
      const current = await client.query<PoolRow>(
        'SELECT id, balance, version FROM bond_pools WHERE id = $1',
        [poolId],
      );
      if (!current.rows[0]) {
        throw new PoolNotFoundError(poolId);
      }
      if (toBigInt(current.rows[0].balance) < amount) {
        throw new InsufficientPoolBalanceError(poolId);
      }

      const updated = await client.query<PoolRow>(
        `UPDATE bond_pools
         SET balance = balance - $1, version = version + 1
         WHERE id = $2 AND version = $3 AND balance >= $1
         RETURNING id, balance, version`,
        [amount.toString(), poolId, current.rows[0].version.toString()],
      );
      if (updated.rows[0]) {
        return updated;
      }
    }

    throw new Error(`Bond pool ${poolId} balance update conflicted too many times`);
  }

  private async rollback(client: PgClient): Promise<QueryResult | void> {
    try {
      return await client.query('ROLLBACK');
    } catch {
      return undefined;
    }
  }
}

type ReleaseLock = () => void;

export class InMemoryBondPoolStore implements BondPoolStore {
  private readonly pools = new Map<string, BondPool>();
  private readonly stakes = new Map<string, ValidatorStake>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly maxValidatorStake: bigint = 100000n) {}

  createPool(pool: BondPool): void {
    this.pools.set(pool.id, { ...pool });
  }

  createStake(stake: ValidatorStake): void {
    this.stakes.set(this.stakeKey(stake.poolId, stake.validatorId), { ...stake });
  }

  async getPool(poolId: string): Promise<BondPool | null> {
    const pool = this.pools.get(poolId);
    return pool ? { ...pool } : null;
  }

  async getValidatorStake(poolId: string, validatorId: string): Promise<ValidatorStake | null> {
    const stake = this.stakes.get(this.stakeKey(poolId, validatorId));
    return stake ? { ...stake } : null;
  }

  async stake(poolId: string, validatorId: string, amount: bigint): Promise<BondPool> {
    return this.withPoolLock(poolId, async () => {
      const pool = this.requirePool(poolId);
      const key = this.stakeKey(poolId, validatorId);
      const existing = this.stakes.get(key);
      const nextAmount = (existing?.amount ?? 0n) + amount;

      if (nextAmount > this.maxValidatorStake) {
        throw new ValidatorStakeLimitError(validatorId, poolId, this.maxValidatorStake);
      }

      this.stakes.set(key, { poolId, validatorId, amount: nextAmount });
      pool.balance += amount;
      pool.version += 1n;

      return { ...pool };
    });
  }

  async unstake(poolId: string, validatorId: string, amount: bigint): Promise<BondPool> {
    return this.withPoolLock(poolId, async () => {
      const pool = this.requirePool(poolId);
      const key = this.stakeKey(poolId, validatorId);
      const stake = this.stakes.get(key);

      if (!stake || stake.amount < amount) {
        throw new InsufficientStakeError(validatorId, poolId);
      }

      if (pool.balance < amount) {
        throw new InsufficientPoolBalanceError(poolId);
      }

      const nextAmount = stake.amount - amount;
      if (nextAmount === 0n) {
        this.stakes.delete(key);
      } else {
        this.stakes.set(key, { ...stake, amount: nextAmount });
      }

      pool.balance -= amount;
      pool.version += 1n;

      return { ...pool };
    });
  }

  async sumValidatorStakes(poolId: string): Promise<bigint> {
    let total = 0n;
    for (const stake of this.stakes.values()) {
      if (stake.poolId === poolId) {
        total += stake.amount;
      }
    }
    return total;
  }

  async reconcilePool(poolId: string): Promise<BondPool> {
    return this.withPoolLock(poolId, async () => {
      const pool = this.requirePool(poolId);
      pool.balance = await this.sumValidatorStakes(poolId);
      pool.version += 1n;
      return { ...pool };
    });
  }

  private requirePool(poolId: string): BondPool {
    const pool = this.pools.get(poolId);
    if (!pool) {
      throw new PoolNotFoundError(poolId);
    }
    return pool;
  }

  private stakeKey(poolId: string, validatorId: string): string {
    return `${poolId}:${validatorId}`;
  }

  private async withPoolLock<T>(poolId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(poolId) ?? Promise.resolve();
    let release!: ReleaseLock;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => current);

    this.locks.set(poolId, queued);
    await previous;

    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(poolId) === queued) {
        this.locks.delete(poolId);
      }
    }
  }
}
