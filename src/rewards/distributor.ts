import { PoolClient } from 'pg';
import { Database } from '../config/database';
import { createLogger } from '../diagnostics/logger';
import { acquireRewardNodeLock, isLockTimeoutError, RewardLockTimeoutError } from './lock_manager';

export interface RewardAllocation {
  nodeId: string;
  amount: string;
}

export interface RewardDistributionResult {
  nodeId: string;
  allocatedAmount: string;
  status: 'distributed' | 'skipped' | 'requeued';
}

export interface RewardCycleRequeue {
  requeueRewardCycle(nodeId: string): Promise<void>;
}

interface MetricsState {
  acquisitionSeconds: number[];
  contentionTotal: number;
  doubleSpendPreventedTotal: number;
}

const DECIMAL_SCALE = 10_000_000n;
const REWARD_POOL_MIN_UNITS = 1n;
const REWARD_POOL_MAX_UNITS = 1_000_000n * DECIMAL_SCALE;

export class RewardDistributor {
  private readonly log = createLogger('reward-distributor');
  private readonly metrics: MetricsState = {
    acquisitionSeconds: [],
    contentionTotal: 0,
    doubleSpendPreventedTotal: 0,
  };

  constructor(
    private readonly database: Pick<Database, 'transaction'>,
    private readonly requeue?: RewardCycleRequeue,
  ) {}

  computeAllocations(pendingRewards: RewardAllocation[], totalRewardPool: string): RewardAllocation[] {
    const pool = parseUnits(totalRewardPool);
    if (pool < REWARD_POOL_MIN_UNITS || pool > REWARD_POOL_MAX_UNITS) {
      throw new RangeError('totalRewardPool is outside supported reward-cycle bounds');
    }

    const positiveRewards = pendingRewards
      .map((reward) => ({ nodeId: reward.nodeId, amount: parseUnits(reward.amount) }))
      .filter((reward) => reward.amount > 0n);
    const totalPending = positiveRewards.reduce((sum, reward) => sum + reward.amount, 0n);
    if (totalPending === 0n) return [];

    return positiveRewards.map((reward) => ({
      nodeId: reward.nodeId,
      amount: formatUnits((pool * reward.amount) / totalPending),
    })).filter((reward) => parseUnits(reward.amount) > 0n);
  }

  async computeAndDistributeNodeReward(nodeId: string): Promise<RewardDistributionResult> {
    return this.database.transaction(async (client) => {
      const savepoint = savepointName(nodeId);
      await client.query(`SAVEPOINT ${savepoint}`);
      try {
        const lockStart = performance.now();
        await acquireRewardNodeLock(client, nodeId);
        this.metrics.acquisitionSeconds.push((performance.now() - lockStart) / 1000);

        const pending = await client.query<{ amount: string }>(
          'SELECT amount FROM reward_pending_amounts WHERE node_id = $1 FOR UPDATE',
          [nodeId],
        );
        const amount = pending.rows[0]?.amount ?? '0';
        if (parseUnits(amount) <= 0n) {
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return { nodeId, allocatedAmount: '0.0000000', status: 'skipped' };
        }
        const allocation = this.computeAllocations([{ nodeId, amount }], amount)[0];
        if (!allocation) {
          await client.query(`RELEASE SAVEPOINT ${savepoint}`);
          return { nodeId, allocatedAmount: '0.0000000', status: 'skipped' };
        }

        await client.query(
          'INSERT INTO reward_tx (node_id, amount) VALUES ($1, $2)',
          [nodeId, allocation.amount],
        );
        await client.query(
          'UPDATE reward_pending_amounts SET amount = amount - $2::numeric WHERE node_id = $1',
          [nodeId, allocation.amount],
        );
        this.metrics.doubleSpendPreventedTotal++;
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        return { nodeId, allocatedAmount: allocation.amount, status: 'distributed' };
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await client.query(`RELEASE SAVEPOINT ${savepoint}`);
        if (isLockTimeoutError(error)) {
          this.metrics.contentionTotal++;
          this.log.warn('Reward node lock contention; requeueing distribution cycle', { nodeId });
          await this.requeue?.requeueRewardCycle(nodeId);
          return { nodeId, allocatedAmount: '0.0000000', status: 'requeued' };
        }
        throw error;
      }
    });
  }

  prometheusMetrics(): string {
    const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5];
    const lines = [
      '# HELP reward_lock_acquisition_seconds Time spent acquiring per-node reward advisory locks.',
      '# TYPE reward_lock_acquisition_seconds histogram',
    ];
    for (const bucket of buckets) {
      const count = this.metrics.acquisitionSeconds.filter((value) => value <= bucket).length;
      lines.push(`reward_lock_acquisition_seconds_bucket{le="${bucket}"} ${count}`);
    }
    lines.push(`reward_lock_acquisition_seconds_bucket{le="+Inf"} ${this.metrics.acquisitionSeconds.length}`);
    lines.push(`reward_lock_acquisition_seconds_sum ${this.metrics.acquisitionSeconds.reduce((sum, value) => sum + value, 0)}`);
    lines.push(`reward_lock_acquisition_seconds_count ${this.metrics.acquisitionSeconds.length}`);
    lines.push('# HELP reward_lock_contention_total Reward distribution lock acquisition timeouts.');
    lines.push('# TYPE reward_lock_contention_total counter');
    lines.push(`reward_lock_contention_total ${this.metrics.contentionTotal}`);
    lines.push('# HELP reward_double_spend_prevented_total Reward distributions serialized by per-node advisory locks.');
    lines.push('# TYPE reward_double_spend_prevented_total counter');
    lines.push(`reward_double_spend_prevented_total ${this.metrics.doubleSpendPreventedTotal}`);
    return `${lines.join('\n')}\n`;
  }
}

export function computeAllocations(pendingRewards: RewardAllocation[], totalRewardPool: string): RewardAllocation[] {
  const distributor = new RewardDistributor({ transaction: async () => { throw new Error('database is required'); } });
  return distributor.computeAllocations(pendingRewards, totalRewardPool);
}

function savepointName(nodeId: string): string {
  return `reward_node_${nodeId.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 48)}`;
}

function parseUnits(value: string): bigint {
  const match = value.match(/^(\d+)(?:\.(\d{0,7}))?$/);
  if (!match) throw new Error(`Invalid 7-decimal reward amount: ${value}`);
  return BigInt(match[1]) * DECIMAL_SCALE + BigInt((match[2] ?? '').padEnd(7, '0'));
}

function formatUnits(value: bigint): string {
  const whole = value / DECIMAL_SCALE;
  const fraction = value % DECIMAL_SCALE;
  return `${whole}.${fraction.toString().padStart(7, '0')}`;
}
