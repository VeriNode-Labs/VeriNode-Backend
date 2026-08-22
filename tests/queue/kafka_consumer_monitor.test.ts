import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KafkaConsumerMonitor } from '../../src/queue/kafka_consumer_monitor';
import type {
  ConsumerGroupMetrics,
  KafkaClusterInfo,
} from '../../src/queue/kafka_consumer_monitor';

function createMockAdminClient() {
  const groups = new Map<string, ConsumerGroupMetrics[]>();

  return {
    groups,
    fetchConsumerGroupMetrics: vi.fn(async (groupId: string) => {
      return groups.get(groupId) ?? [];
    }),
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

describe('KafkaConsumerMonitor', () => {
  let adminClient: ReturnType<typeof createMockAdminClient>;

  beforeEach(() => {
    adminClient = createMockAdminClient();
  });

  it('should report healthy when no lag', async () => {
    addPartition(adminClient.groups, 'group-1', 'topic-a', 0, 5);
    addPartition(adminClient.groups, 'group-1', 'topic-a', 1, 10);

    const monitor = new KafkaConsumerMonitor(adminClient as any);
    const summaries = await monitor.checkAllGroups();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].status).toBe('healthy');
    expect(summaries[0].totalLag).toBe(15);
    expect(summaries[0].maxLag).toBe(10);
    expect(summaries[0].avgLag).toBe(8);
  });

  it('should report warning when lag exceeds threshold', async () => {
    addPartition(adminClient.groups, 'group-1', 'topic-a', 0, 1500);

    const monitor = new KafkaConsumerMonitor(adminClient as any, {
      lagWarningThreshold: 1000,
    });
    const summaries = await monitor.checkAllGroups();
    expect(summaries[0].status).toBe('warning');
  });

  it('should report critical when lag exceeds critical threshold', async () => {
    addPartition(adminClient.groups, 'group-1', 'topic-a', 0, 15000);

    const monitor = new KafkaConsumerMonitor(adminClient as any, {
      lagCriticalThreshold: 10000,
    });
    const summaries = await monitor.checkAllGroups();
    expect(summaries[0].status).toBe('critical');
  });

  it('should report warning when majority of partitions lagging', async () => {
    addPartition(adminClient.groups, 'group-1', 'topic-a', 0, 600);
    addPartition(adminClient.groups, 'group-1', 'topic-a', 1, 5);
    addPartition(adminClient.groups, 'group-1', 'topic-a', 2, 600);

    const monitor = new KafkaConsumerMonitor(adminClient as any, {
      partitionLagWarningThreshold: 500,
    });
    const summaries = await monitor.checkAllGroups();
    expect(summaries[0].status).toBe('warning');
  });

  it('should fire onLagChange callback on status change', async () => {
    addPartition(adminClient.groups, 'group-1', 'topic-a', 0, 5);
    const monitor = new KafkaConsumerMonitor(adminClient as any);
    const callback = vi.fn();
    monitor.onLagChange(callback);
    await monitor.checkAllGroups();
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback.mock.calls[0][0].status).toBe('healthy');
  });

  it('should get stored summary', async () => {
    addPartition(adminClient.groups, 'group-1', 'topic-a', 0, 5);
    const monitor = new KafkaConsumerMonitor(adminClient as any);
    await monitor.checkAllGroups();
    const summary = monitor.getSummary('group-1');
    expect(summary).toBeDefined();
    expect(summary!.totalLag).toBe(5);
  });

  it('should handle missing groups gracefully', async () => {
    const monitor = new KafkaConsumerMonitor(adminClient as any);
    const summaries = await monitor.checkAllGroups();
    expect(summaries).toHaveLength(0);
  });

  it('should start and stop monitoring', async () => {
    vi.useFakeTimers();
    addPartition(adminClient.groups, 'group-1', 'topic-a', 0, 5);
    const monitor = new KafkaConsumerMonitor(adminClient as any, {
      checkIntervalMs: 5000,
    });
    expect(monitor.isRunning).toBe(false);
    await monitor.start();
    expect(monitor.isRunning).toBe(true);
    monitor.stop();
    expect(monitor.isRunning).toBe(false);
    vi.useRealTimers();
  });

  it('should handle admin client errors gracefully', async () => {
    adminClient.listConsumerGroups.mockRejectedValue(new Error('connection refused'));
    const monitor = new KafkaConsumerMonitor(adminClient as any);
    const summaries = await monitor.checkAllGroups();
    expect(summaries).toHaveLength(0);
  });
});
