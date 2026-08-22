import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KafkaConsumerMonitor } from '../../src/queue/kafka_consumer_monitor';
import { KafkaAutoScaler } from '../../src/queue/kafka_auto_scaler';
import type {
  ConsumerGroupMetrics,
  KafkaClusterInfo,
  ConsumerGroupSummary,
} from '../../src/queue/kafka_consumer_monitor';

function createMockAdminClient() {
  const groups = new Map<string, ConsumerGroupMetrics[]>();
  return {
    groups,
    fetchConsumerGroupMetrics: vi.fn(async (groupId: string) => groups.get(groupId) ?? []),
    listConsumerGroups: vi.fn(async () => Array.from(groups.keys())),
    fetchGroupSummary: vi.fn(async (groupId: string): Promise<KafkaClusterInfo> => ({
      groupId,
      brokers: ['broker-1:9092'],
      members: [`consumer-${groupId}-1`, `consumer-${groupId}-2`],
    })),
  };
}

function addPartition(
  groups: Map<string, ConsumerGroupMetrics[]>,
  groupId: string,
  topic: string,
  partition: number,
  lag: number,
) {
  const existing = groups.get(groupId) ?? [];
  existing.push({
    groupId,
    topic,
    partition,
    currentOffset: '100',
    logEndOffset: String(100 + lag),
    lag,
    clientId: `client-${partition}`,
    host: `host-${partition}`,
    memberId: `member-${partition}`,
    status: lag > 1000 ? 'critical' : lag > 100 ? 'warning' : 'healthy',
  });
  groups.set(groupId, existing);
}

describe('KafkaAutoScaler', () => {
  let adminClient: ReturnType<typeof createMockAdminClient>;

  beforeEach(() => {
    adminClient = createMockAdminClient();
  });

  function createScaler(config?: Record<string, number>) {
    const monitor = new KafkaConsumerMonitor(adminClient as any, {
      lagWarningThreshold: 1000,
      lagCriticalThreshold: 10000,
      partitionLagWarningThreshold: 500,
      partitionLagCriticalThreshold: 5000,
    });
    const mockScaler = {
      getCurrentConsumerCount: vi.fn().mockResolvedValue(4),
      scaleConsumerGroup: vi.fn().mockResolvedValue(undefined),
    };
    const autoScaler = new KafkaAutoScaler(monitor, mockScaler, {
      minConsumers: 1,
      maxConsumers: 10,
      scaleUpThreshold: 1000,
      scaleDownThreshold: 100,
      scaleUpBy: 2,
      scaleDownBy: 1,
      cooldownPeriodMs: 100,
      maxConsecutiveScaleDowns: 3,
      ...config,
    });
    return { monitor, autoScaler, mockScaler };
  }

  it('should scale up when lag exceeds threshold', async () => {
    addPartition(adminClient.groups, 'group-1', 'topic-a', 0, 5000);
    const { monitor, autoScaler, mockScaler } = createScaler();
    autoScaler.start();
    const summaries = await monitor.checkAllGroups();
    const summary = summaries[0];
    // directly trigger evaluation
    await (autoScaler as any).evaluate(summary, null);
    expect(mockScaler.scaleConsumerGroup).toHaveBeenCalledWith('group-1', 6);
  });

  it('should not scale up when at max consumers', async () => {
    addPartition(adminClient.groups, 'group-1', 'topic-a', 0, 5000);
    const { monitor, autoScaler, mockScaler } = createScaler({ maxConsumers: 4 });
    autoScaler.start();
    const summaries = await monitor.checkAllGroups();
    // mock that we're already at max
    mockScaler.getCurrentConsumerCount.mockResolvedValue(4);
    await (autoScaler as any).evaluate(summaries[0], null);
    expect(mockScaler.scaleConsumerGroup).not.toHaveBeenCalled();
  });

  it('should scale down when lag is low', async () => {
    addPartition(adminClient.groups, 'group-1', 'topic-a', 0, 10);
    const { monitor, autoScaler, mockScaler } = createScaler();
    autoScaler.start();
    const summaries = await monitor.checkAllGroups();
    mockScaler.getCurrentConsumerCount.mockResolvedValue(4);
    await (autoScaler as any).evaluate(summaries[0], null);
    expect(mockScaler.scaleConsumerGroup).toHaveBeenCalledWith('group-1', 3);
  });

  it('should not scale down below min consumers', async () => {
    addPartition(adminClient.groups, 'group-1', 'topic-a', 0, 10);
    const { monitor, autoScaler, mockScaler } = createScaler({ minConsumers: 4 });
    autoScaler.start();
    const summaries = await monitor.checkAllGroups();
    mockScaler.getCurrentConsumerCount.mockResolvedValue(4);
    await (autoScaler as any).evaluate(summaries[0], null);
    expect(mockScaler.scaleConsumerGroup).not.toHaveBeenCalled();
  });

  it('should respect cooldown period', async () => {
    addPartition(adminClient.groups, 'group-1', 'topic-a', 0, 5000);
    const { monitor, autoScaler, mockScaler } = createScaler({ cooldownPeriodMs: 10000 });
    autoScaler.start();
    const summaries = await monitor.checkAllGroups();
    mockScaler.getCurrentConsumerCount.mockResolvedValue(4);
    // first scale should succeed
    await (autoScaler as any).evaluate(summaries[0], null);
    expect(mockScaler.scaleConsumerGroup).toHaveBeenCalledTimes(1);
    // second immediate attempt should be blocked by cooldown
    await (autoScaler as any).evaluate(summaries[0], summaries[0]);
    expect(mockScaler.scaleConsumerGroup).toHaveBeenCalledTimes(1);
  });

  it('should fire onScale callback', async () => {
    addPartition(adminClient.groups, 'group-1', 'topic-a', 0, 5000);
    const { monitor, autoScaler, mockScaler } = createScaler();
    const callback = vi.fn();
    autoScaler.onScale(callback);
    autoScaler.start();
    const summaries = await monitor.checkAllGroups();
    mockScaler.getCurrentConsumerCount.mockResolvedValue(4);
    await (autoScaler as any).evaluate(summaries[0], null);
    expect(callback).toHaveBeenCalledTimes(1);
    const event = callback.mock.calls[0][0];
    expect(event.direction).toBe('up');
    expect(event.from).toBe(4);
    expect(event.to).toBe(6);
  });

  it('should limit consecutive scale downs', async () => {
    vi.useFakeTimers();
    addPartition(adminClient.groups, 'group-1', 'topic-a', 0, 10);
    const { monitor, autoScaler, mockScaler } = createScaler({
      maxConsecutiveScaleDowns: 2,
      cooldownPeriodMs: 1,
    });
    autoScaler.start();
    const summaries = await monitor.checkAllGroups();
    mockScaler.getCurrentConsumerCount.mockResolvedValue(10);
    // scale down 3 times - 3rd should be blocked
    await (autoScaler as any).evaluate(summaries[0], null);
    vi.advanceTimersByTime(10);
    await (autoScaler as any).evaluate(summaries[0], summaries[0]);
    vi.advanceTimersByTime(10);
    await (autoScaler as any).evaluate(summaries[0], summaries[0]);
    expect(mockScaler.scaleConsumerGroup).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
