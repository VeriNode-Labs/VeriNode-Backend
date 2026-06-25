import { createHash } from 'crypto';
import { EmailService } from './emailService';
import {
  NotificationChannel,
  NotificationDeliveryStore,
} from './deliveryStore';
import { WebhookService } from './webhookService';

export interface SlashingEvent {
  id: string;
  validatorId: string;
  operatorEmail: string;
  webhookUrl: string;
  reason: string;
  amount: bigint;
  occurredAt: Date;
}

export interface SlashingNotifierOptions {
  maxRetries?: number;
  backoffMs?: readonly number[];
  webhookTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SlashingNotificationResult {
  email: 'delivered' | 'skipped';
  webhook: 'delivered' | 'skipped';
}

interface ChannelConfig {
  channel: NotificationChannel;
  send: (notificationId: string) => Promise<void>;
}

export class SlashingNotificationError extends Error {
  constructor(readonly failures: Partial<Record<NotificationChannel, unknown>>) {
    super(`Slashing notification failed for channels: ${Object.keys(failures).join(', ')}`);
    this.name = 'SlashingNotificationError';
  }
}

export class SlashingNotifier {
  private readonly maxRetries: number;
  private readonly backoffMs: readonly number[];
  private readonly webhookTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly deliveryStore: NotificationDeliveryStore,
    private readonly emailService: EmailService,
    private readonly webhookService: WebhookService,
    options: SlashingNotifierOptions = {},
  ) {
    this.maxRetries = options.maxRetries ?? 3;
    this.backoffMs = options.backoffMs ?? [1_000, 2_000, 4_000];
    this.webhookTimeoutMs = options.webhookTimeoutMs ?? 5_000;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async notifySlashing(event: SlashingEvent): Promise<SlashingNotificationResult> {
    const channelResults = await Promise.allSettled([
      this.deliverChannel(event, {
        channel: 'email',
        send: (notificationId) => this.emailService.sendEmail({
          notificationId,
          to: event.operatorEmail,
          subject: `Validator ${event.validatorId} slashed`,
          body: this.emailBody(event),
        }),
      }),
      this.deliverChannel(event, {
        channel: 'webhook',
        send: (notificationId) => this.webhookService.postWebhook({
          notificationId,
          url: event.webhookUrl,
          timeoutMs: this.webhookTimeoutMs,
          payload: this.webhookPayload(event, notificationId),
        }),
      }),
    ]);

    const failures: Partial<Record<NotificationChannel, unknown>> = {};
    const result: SlashingNotificationResult = {
      email: 'skipped',
      webhook: 'skipped',
    };

    for (const settled of channelResults) {
      if (settled.status === 'fulfilled') {
        result[settled.value.channel] = settled.value.status;
      } else if (settled.reason instanceof ChannelDeliveryError) {
        failures[settled.reason.channel] = settled.reason.causeValue;
      } else {
        failures.email = settled.reason;
        failures.webhook = settled.reason;
      }
    }

    if (Object.keys(failures).length > 0) {
      throw new SlashingNotificationError(failures);
    }

    return result;
  }

  private async deliverChannel(
    event: SlashingEvent,
    config: ChannelConfig,
  ): Promise<{ channel: NotificationChannel; status: 'delivered' | 'skipped' }> {
    const notificationId = notificationIdFor(event.id, config.channel);
    const existing = await this.deliveryStore.getDelivery(event.id, config.channel);
    if (existing?.status === 'delivered') {
      return { channel: config.channel, status: 'skipped' };
    }

    let lastError: unknown = null;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const claimed = await this.deliveryStore.claimDelivery(event.id, config.channel, notificationId);
      if (!claimed) {
        return { channel: config.channel, status: 'skipped' };
      }

      try {
        await config.send(claimed.notificationId);
        await this.deliveryStore.markDelivered(event.id, config.channel);
        return { channel: config.channel, status: 'delivered' };
      } catch (errorValue) {
        lastError = errorValue;
        await this.deliveryStore.markFailed(event.id, config.channel, errorValue);
        if (attempt === this.maxRetries) {
          throw new ChannelDeliveryError(config.channel, errorValue);
        }
        await this.sleep(this.backoffMs[attempt] ?? this.backoffMs[this.backoffMs.length - 1] ?? 0);
      }
    }

    throw new ChannelDeliveryError(config.channel, lastError);
  }

  private emailBody(event: SlashingEvent): string {
    return [
      `Validator: ${event.validatorId}`,
      `Reason: ${event.reason}`,
      `Amount: ${event.amount.toString()}`,
      `Occurred At: ${event.occurredAt.toISOString()}`,
    ].join('\n');
  }

  private webhookPayload(event: SlashingEvent, notificationId: string): Record<string, unknown> {
    return {
      notificationId,
      slashingEventId: event.id,
      validatorId: event.validatorId,
      reason: event.reason,
      amount: event.amount.toString(),
      occurredAt: event.occurredAt.toISOString(),
    };
  }
}

class ChannelDeliveryError extends Error {
  constructor(
    readonly channel: NotificationChannel,
    readonly causeValue: unknown,
  ) {
    super(causeValue instanceof Error ? causeValue.message : String(causeValue));
    this.name = 'ChannelDeliveryError';
  }
}

export function notificationIdFor(slashingEventId: string, channel: NotificationChannel): string {
  const digest = createHash('sha256')
    .update(`${slashingEventId}:${channel}`)
    .digest('hex')
    .slice(0, 32);
  return `${slashingEventId}:${channel}:${digest}`;
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
