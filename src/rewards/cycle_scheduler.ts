import { RewardDistributor, RewardDistributionResult } from './distributor';

export class RewardCycleScheduler {
  private readonly retryQueue: string[] = [];

  constructor(private readonly distributor: Pick<RewardDistributor, 'computeAndDistributeNodeReward'>) {}

  async runCycle(nodeIds: string[]): Promise<RewardDistributionResult[]> {
    return Promise.all(nodeIds.map((nodeId) => this.distributor.computeAndDistributeNodeReward(nodeId)));
  }

  async requeueRewardCycle(nodeId: string): Promise<void> {
    this.retryQueue.push(nodeId);
  }

  drainRetryQueue(): string[] {
    return this.retryQueue.splice(0, this.retryQueue.length);
  }
}
