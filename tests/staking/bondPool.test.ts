import { BondPoolService, MAX_STAKE, MIN_STAKE, StakeAmountError } from '../../src/staking/bondPool';
import {
  InMemoryBondPoolStore,
  InsufficientStakeError,
  ValidatorStakeLimitError,
} from '../../src/staking/poolStore';

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

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('bondPool.test.ts crashed:', err);
  process.exit(1);
});
