import { createLogger } from '../diagnostics/logger';
export type ConsumerGroupStatus = 'healthy' | 'warning' | 'critical';

export interface ConsumerGroupMetrics {
  groupId: string;
  topic: string;
  partition: number;
  currentOffset: string;
  logEndOffset: string;
  lag: number;
  clientId: string;
  host: string;
  memberId: string;
  status: ConsumerGroupStatus;
}

export interface ConsumerGroupSummary {
  groupId: string;
  topic: string;
  totalLag: number;
  maxLag: number;
  avgLag: number;
  partitionCount: number;
  laggingPartitions: number;
  status: ConsumerGroupStatus;
  members: number;
  timestamp: number;
}

export interface KafkaConsumerMonitorConfig {
  lagWarningThreshold: number;
  lagCriticalThreshold: number;
  checkIntervalMs: number;
  partitionLagWarningThreshold: number;
  partitionLagCriticalThreshold: number;
}

export interface KafkaClusterInfo {
  groupId: string;
  brokers: string[];
  members: string[];
}

export interface KafkaAdminClient {
  fetchConsumerGroupMetrics(groupId: string): Promise<ConsumerGroupMetrics[]>;
  listConsumerGroups(): Promise<string[]>;
  fetchGroupSummary(groupId: string): Promise<KafkaClusterInfo>;
}

export type LagChangeCallback = (
  summary: ConsumerGroupSummary,
  previousSummary: ConsumerGroupSummary | null,
) => void;

const log = createLogger('kafka_consumer_monitor', { 'messaging.system': 'kafka' });

const DEFAULT_CONFIG: KafkaConsumerMonitorConfig = {
  lagWarningThreshold: 1000,
  lagCriticalThreshold: 10000,
  checkIntervalMs: 15000,
  partitionLagWarningThreshold: 500,
  partitionLagCriticalThreshold: 5000,
};

export class KafkaConsumerMonitor {
  private readonly adminClient: KafkaAdminClient;
  private readonly config: KafkaConsumerMonitorConfig;
  private readonly onChangeCallbacks: LagChangeCallback[] = [];
  private summaries = new Map<string, ConsumerGroupSummary>();
  private monitorTimer: ReturnType<typeof setInterval> | null = null;
  private _isRunning = false;

  constructor(adminClient: KafkaAdminClient, config?: Partial<KafkaConsumerMonitorConfig>) {
    this.adminClient = adminClient;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get checkIntervalMs(): number {
    return this.config.checkIntervalMs;
  }

  async start(): Promise<void> {
    if (this._isRunning) return;
    this._isRunning = true;
    log.info('Starting consumer monitor', { 'monitor.interval_ms': this.config.checkIntervalMs });
    await this.checkAllGroups();
    this.monitorTimer = setInterval(() => {
      void this.checkAllGroups();
    }, this.config.checkIntervalMs);
  }

  stop(): void {
    this._isRunning = false;
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
  }

  onLagChange(callback: LagChangeCallback): () => void {
    this.onChangeCallbacks.push(callback);
    return () => {
      const idx = this.onChangeCallbacks.indexOf(callback);
      if (idx >= 0) this.onChangeCallbacks.splice(idx, 1);
    };
  }

  getSummary(groupId: string): ConsumerGroupSummary | undefined {
    return this.summaries.get(groupId);
  }

  getAllSummaries(): ConsumerGroupSummary[] {
    return Array.from(this.summaries.values());
  }

  async checkAllGroups(): Promise<ConsumerGroupSummary[]> {
    try {
      const groupIds = await this.adminClient.listConsumerGroups();
      const results: ConsumerGroupSummary[] = [];
      for (const groupId of groupIds) {
        try {
          const summary = await this.checkGroup(groupId);
          results.push(summary);
        } catch (err) {
          log.error('Error checking consumer group', {
            'messaging.kafka.consumer.group': groupId,
            'error.message': err instanceof Error ? err.message : String(err),
          });
        }
      }
      return results;
    } catch (err) {
      log.error('Error listing consumer groups', {
        'error.message': err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  private async checkGroup(groupId: string): Promise<ConsumerGroupSummary> {
    const metrics = await this.adminClient.fetchConsumerGroupMetrics(groupId);
    const groupInfo = await this.adminClient.fetchGroupSummary(groupId);

    const topicMap = new Map<string, ConsumerGroupMetrics[]>();
    for (const m of metrics) {
      const existing = topicMap.get(m.topic) ?? [];
      existing.push(m);
      topicMap.set(m.topic, existing);
    }

    let totalLag = 0;
    let maxLag = 0;
    let laggingCount = 0;
    let partitionCount = 0;

    for (const [, partitions] of topicMap) {
      for (const p of partitions) {
        totalLag += p.lag;
        maxLag = Math.max(maxLag, p.lag);
        partitionCount++;
        if (p.lag > this.config.partitionLagWarningThreshold) {
          laggingCount++;
        }
      }
    }

    const avgLag = partitionCount > 0 ? Math.round(totalLag / partitionCount) : 0;

    const status = this.determineStatus(totalLag, maxLag, laggingCount, partitionCount);

    const summary: ConsumerGroupSummary = {
      groupId,
      topic: Array.from(topicMap.keys()).join(','),
      totalLag,
      maxLag,
      avgLag,
      partitionCount,
      laggingPartitions: laggingCount,
      status,
      members: groupInfo.members.length,
      timestamp: Date.now(),
    };

    const previous = this.summaries.get(groupId);
    this.summaries.set(groupId, summary);

    if (
      !previous ||
      previous.status !== summary.status ||
      Math.abs(previous.totalLag - summary.totalLag) > this.config.lagWarningThreshold
    ) {
      this.notifyChange(summary, previous ?? null);
    }

    return summary;
  }

  private determineStatus(
    totalLag: number,
    maxLag: number,
    laggingPartitions: number,
    partitionCount: number,
  ): ConsumerGroupStatus {
    if (
      totalLag >= this.config.lagCriticalThreshold ||
      maxLag >= this.config.partitionLagCriticalThreshold
    ) {
      return 'critical';
    }
    if (
      totalLag >= this.config.lagWarningThreshold ||
      maxLag >= this.config.partitionLagWarningThreshold ||
      (partitionCount > 0 && laggingPartitions / partitionCount > 0.5)
    ) {
      return 'warning';
    }
    return 'healthy';
  }

  private notifyChange(summary: ConsumerGroupSummary, previous: ConsumerGroupSummary | null): void {
    for (const cb of this.onChangeCallbacks) {
      try {
        cb(summary, previous);
      } catch {
        // isolate listener failures
      }
    }
  }
}
