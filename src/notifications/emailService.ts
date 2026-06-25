export interface EmailNotification {
  notificationId: string;
  to: string;
  subject: string;
  body: string;
}

export interface EmailService {
  sendEmail(notification: EmailNotification): Promise<void>;
}

export type EmailSender = (notification: EmailNotification) => Promise<void>;

export class IdempotentEmailService implements EmailService {
  private readonly processed = new Set<string>();

  constructor(private readonly sender: EmailSender) {}

  async sendEmail(notification: EmailNotification): Promise<void> {
    if (this.processed.has(notification.notificationId)) {
      return;
    }
    await this.sender(notification);
    this.processed.add(notification.notificationId);
  }
}
