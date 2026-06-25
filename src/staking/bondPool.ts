import { BondPool, BondPoolStore, ValidatorStake } from './poolStore';

export const MIN_STAKE = 100n;
export const MAX_STAKE = 100000n;

export class StakeAmountError extends Error {
  constructor(amount: bigint) {
    super(`Stake amount ${amount.toString()} is outside the allowed range`);
    this.name = 'StakeAmountError';
  }
}

export class BondPoolService {
  constructor(private readonly store: BondPoolStore) {}

  async stake(poolId: string, validatorId: string, amount: bigint): Promise<BondPool> {
    this.assertStakeAmount(amount);
    return this.store.stake(poolId, validatorId, amount);
  }

  async unstake(poolId: string, validatorId: string, amount: bigint): Promise<BondPool> {
    this.assertStakeAmount(amount);
    return this.store.unstake(poolId, validatorId, amount);
  }

  async getPool(poolId: string): Promise<BondPool | null> {
    const pool = await this.store.getPool(poolId);
    if (!pool) return null;
    return {
      ...pool,
      balance: await this.store.sumValidatorStakes(poolId),
    };
  }

  async getValidatorStake(poolId: string, validatorId: string): Promise<ValidatorStake | null> {
    return this.store.getValidatorStake(poolId, validatorId);
  }

  async getDerivedBalance(poolId: string): Promise<bigint> {
    return this.store.sumValidatorStakes(poolId);
  }

  async reconcile(poolId: string): Promise<BondPool> {
    return this.store.reconcilePool(poolId);
  }

  private assertStakeAmount(amount: bigint): void {
    if (amount < MIN_STAKE || amount > MAX_STAKE) {
      throw new StakeAmountError(amount);
    }
  }
}
