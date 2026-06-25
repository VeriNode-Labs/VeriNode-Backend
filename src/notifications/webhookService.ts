export interface WebhookNotification {
  notificationId: string;
  url: string;
  payload: Record<string, unknown>;
  timeoutMs: number;
}

export interface WebhookService {
  postWebhook(notification: WebhookNotification): Promise<void>;
}

export type WebhookSender = (notification: WebhookNotification) => Promise<void>;

export class IdempotentWebhookService implements WebhookService {
  private readonly processed = new Set<string>();

  constructor(private readonly sender: WebhookSender) {}

  async postWebhook(notification: WebhookNotification): Promise<void> {
    if (this.processed.has(notification.notificationId)) {
      return;
    }
    await this.sender(notification);
    this.processed.add(notification.notificationId);
  }
}
