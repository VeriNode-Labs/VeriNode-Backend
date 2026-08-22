import { createLogger } from '../diagnostics/logger';
import { KafkaConsumerMonitor } from './kafka_consumer_monitor';
import type { ConsumerGroupSummary, ConsumerGroupStatus } from './kafka_consumer_monitor';

export interface KafkaAutoScalerConfig {
  minConsumers: number;
  maxConsumers: number;
  scaleUpThreshold: number;
  scaleDownThreshold: number;
  scaleUpBy: number;
  scaleDownBy: number;
  cooldownPeriodMs: number;
  maxConsecutiveScaleDowns: number;
}

export interface ConsumerGroupScaler {
  getCurrentConsumerCount(groupId: string): Promise<number>;
  scaleConsumerGroup(groupId: string, targetCount: number): Promise<void>;
}

export type ScaleEvent = {
  groupId: string;
  direction: 'up' | 'down';
  from: number;
  to: number;
  reason: string;
  timestamp: number;
};

export type ScaleEventCallback = (event: ScaleEvent) => void;

const log = createLogger('kafka_auto_scaler', { 'messaging.system': 'kafka' });

const DEFAULT_CONFIG: KafkaAutoScalerConfig = {
  minConsumers: 1,
  maxConsumers: 20,
  scaleUpThreshold: 1000,
  scaleDownThreshold: 100,
  scaleUpBy: 2,
  scaleDownBy: 1,
  cooldownPeriodMs: 60000,
  maxConsecutiveScaleDowns: 3,
};

export class KafkaAutoScaler {
  private readonly monitor: KafkaConsumerMonitor;
  private readonly scaler: ConsumerGroupScaler;
  private readonly config: KafkaAutoScalerConfig;
  private readonly scaleCallbacks: ScaleEventCallback[] = [];
  private lastScaleTimes = new Map<string, number>();
  private consecutiveScaleDowns = new Map<string, number>();
  private currentConsumerCounts = new Map<string, number>();
  private _isRunning = false;

  constructor(
    monitor: KafkaConsumerMonitor,
    scaler: ConsumerGroupScaler,
    config?: Partial<KafkaAutoScalerConfig>,
  ) {
    this.monitor = monitor;
    this.scaler = scaler;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  start(): void {
    if (this._isRunning) return;
    this._isRunning = true;
    log.info('Starting auto-scaler');
    this.monitor.onLagChange((summary, previous) => {
      void this.evaluate(summary, previous);
    });
  }

  stop(): void {
    this._isRunning = false;
  }

  onScale(callback: ScaleEventCallback): () => void {
    this.scaleCallbacks.push(callback);
    return () => {
      const idx = this.scaleCallbacks.indexOf(callback);
      if (idx >= 0) this.scaleCallbacks.splice(idx, 1);
    };
  }

  getScaleHistory(): ScaleEvent[] {
    return this._scaleHistory;
  }

  private _scaleHistory: ScaleEvent[] = [];

  private async evaluate(
    summary: ConsumerGroupSummary,
    previous: ConsumerGroupSummary | null,
  ): Promise<void> {
    if (!this._isRunning) return;
    const { groupId, totalLag } = summary;

    const currentConsumers = await this.getConsumerCount(groupId);
    if (currentConsumers === 0) return;

    const now = Date.now();
    const lastScale = this.lastScaleTimes.get(groupId) ?? 0;
    if (now - lastScale < this.config.cooldownPeriodMs) return;

    let direction: 'up' | 'down' | null = null;
    let reason = '';

    if (totalLag >= this.config.scaleUpThreshold && currentConsumers < this.config.maxConsumers) {
      direction = 'up';
      reason = `totalLag ${totalLag} >= scaleUpThreshold ${this.config.scaleUpThreshold}`;
    } else if (
      totalLag <= this.config.scaleDownThreshold &&
      currentConsumers > this.config.minConsumers
    ) {
      const consecutiveDown = this.consecutiveScaleDowns.get(groupId) ?? 0;
      if (consecutiveDown < this.config.maxConsecutiveScaleDowns) {
        direction = 'down';
        reason = `totalLag ${totalLag} <= scaleDownThreshold ${this.config.scaleDownThreshold}`;
        this.consecutiveScaleDowns.set(groupId, consecutiveDown + 1);
      }
    } else {
      this.consecutiveScaleDowns.set(groupId, 0);
    }

    if (direction) {
      const from = currentConsumers;
      const step = direction === 'up' ? this.config.scaleUpBy : this.config.scaleDownBy;
      const to =
        direction === 'up'
          ? Math.min(from + step, this.config.maxConsumers)
          : Math.max(from - step, this.config.minConsumers);
      if (to !== from) {
        try {
          await this.scaler.scaleConsumerGroup(groupId, to);
          this.currentConsumerCounts.set(groupId, to);
          this.lastScaleTimes.set(groupId, now);
          const event: ScaleEvent = {
            groupId,
            direction,
            from,
            to,
            reason,
            timestamp: now,
          };
          this._scaleHistory.push(event);
          if (this._scaleHistory.length > 100) {
            this._scaleHistory.shift();
          }
          log.info('Scaled consumer group', {
            'messaging.kafka.consumer.group': groupId,
            'autoscaler.direction': direction,
            'autoscaler.from': from,
            'autoscaler.to': to,
            'autoscaler.reason': reason,
          });
          for (const cb of this.scaleCallbacks) {
            try {
              cb(event);
            } catch {
              // isolate listener failures
            }
          }
        } catch (err) {
          log.error('Failed to scale consumer group', {
            'messaging.kafka.consumer.group': groupId,
            'error.message': err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  private async getConsumerCount(groupId: string): Promise<number> {
    const cached = this.currentConsumerCounts.get(groupId);
    if (cached !== undefined) return cached;
    try {
      const count = await this.scaler.getCurrentConsumerCount(groupId);
      this.currentConsumerCounts.set(groupId, count);
      return count;
    } catch {
      return 0;
    }
  }

  getCurrentConsumerCount(groupId: string): number {
    return this.currentConsumerCounts.get(groupId) ?? 0;
  }

  resetScaleHistory(): void {
    this._scaleHistory = [];
  }
}
