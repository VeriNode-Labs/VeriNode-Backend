export type NotificationChannel = 'email' | 'webhook';
export type NotificationDeliveryStatus = 'pending' | 'delivering' | 'delivered' | 'failed';

export interface NotificationDeliveryRecord {
  slashingEventId: string;
  channel: NotificationChannel;
  notificationId: string;
  status: NotificationDeliveryStatus;
  attempts: number;
  lastError: string | null;
  updatedAt: Date;
}

export interface NotificationDeliveryStore {
  claimDelivery(
    slashingEventId: string,
    channel: NotificationChannel,
    notificationId: string,
  ): Promise<NotificationDeliveryRecord | null>;
  markDelivered(slashingEventId: string, channel: NotificationChannel): Promise<void>;
  markFailed(slashingEventId: string, channel: NotificationChannel, error: unknown): Promise<void>;
  getDelivery(slashingEventId: string, channel: NotificationChannel): Promise<NotificationDeliveryRecord | null>;
}

interface QueryResult<T> {
  rows: T[];
}

interface DatabaseLike {
  query<T = unknown>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
}

interface DeliveryRow {
  slashing_event_id: string;
  channel: NotificationChannel;
  notification_id: string;
  status: NotificationDeliveryStatus;
  attempts: number | string;
  last_error: string | null;
  updated_at: Date | string;
}

export class PgNotificationDeliveryStore implements NotificationDeliveryStore {
  constructor(private readonly db: DatabaseLike) {}

  async claimDelivery(
    slashingEventId: string,
    channel: NotificationChannel,
    notificationId: string,
  ): Promise<NotificationDeliveryRecord | null> {
    const result = await this.db.query<DeliveryRow>(
      `INSERT INTO notification_delivery (
         slashing_event_id, channel, notification_id, status, attempts, updated_at
       ) VALUES ($1, $2, $3, 'delivering', 1, NOW())
       ON CONFLICT (slashing_event_id, channel)
       DO UPDATE SET
         status = 'delivering',
         attempts = notification_delivery.attempts + 1,
         updated_at = NOW(),
         last_error = NULL
       WHERE notification_delivery.status IN ('pending', 'failed')
       RETURNING *`,
      [slashingEventId, channel, notificationId],
    );
    return result.rows[0] ? mapDeliveryRow(result.rows[0]) : null;
  }

  async markDelivered(slashingEventId: string, channel: NotificationChannel): Promise<void> {
    await this.db.query(
      `UPDATE notification_delivery
       SET status = 'delivered', updated_at = NOW(), last_error = NULL
       WHERE slashing_event_id = $1 AND channel = $2`,
      [slashingEventId, channel],
    );
  }

  async markFailed(slashingEventId: string, channel: NotificationChannel, error: unknown): Promise<void> {
    await this.db.query(
      `UPDATE notification_delivery
       SET status = 'failed', updated_at = NOW(), last_error = $3
       WHERE slashing_event_id = $1 AND channel = $2`,
      [slashingEventId, channel, errorMessage(error)],
    );
  }

  async getDelivery(slashingEventId: string, channel: NotificationChannel): Promise<NotificationDeliveryRecord | null> {
    const result = await this.db.query<DeliveryRow>(
      `SELECT *
       FROM notification_delivery
       WHERE slashing_event_id = $1 AND channel = $2`,
      [slashingEventId, channel],
    );
    return result.rows[0] ? mapDeliveryRow(result.rows[0]) : null;
  }
}

export class InMemoryNotificationDeliveryStore implements NotificationDeliveryStore {
  private readonly records = new Map<string, NotificationDeliveryRecord>();

  async claimDelivery(
    slashingEventId: string,
    channel: NotificationChannel,
    notificationId: string,
  ): Promise<NotificationDeliveryRecord | null> {
    const key = this.key(slashingEventId, channel);
    const existing = this.records.get(key);
    if (existing?.status === 'delivered' || existing?.status === 'delivering') {
      return null;
    }

    const record: NotificationDeliveryRecord = {
      slashingEventId,
      channel,
      notificationId: existing?.notificationId ?? notificationId,
      status: 'delivering',
      attempts: (existing?.attempts ?? 0) + 1,
      lastError: null,
      updatedAt: new Date(),
    };
    this.records.set(key, record);
    return { ...record };
  }

  async markDelivered(slashingEventId: string, channel: NotificationChannel): Promise<void> {
    const record = this.records.get(this.key(slashingEventId, channel));
    if (record) {
      record.status = 'delivered';
      record.lastError = null;
      record.updatedAt = new Date();
    }
  }

  async markFailed(slashingEventId: string, channel: NotificationChannel, error: unknown): Promise<void> {
    const record = this.records.get(this.key(slashingEventId, channel));
    if (record) {
      record.status = 'failed';
      record.lastError = errorMessage(error);
      record.updatedAt = new Date();
    }
  }

  async getDelivery(slashingEventId: string, channel: NotificationChannel): Promise<NotificationDeliveryRecord | null> {
    const record = this.records.get(this.key(slashingEventId, channel));
    return record ? { ...record } : null;
  }

  private key(slashingEventId: string, channel: NotificationChannel): string {
    return `${slashingEventId}:${channel}`;
  }
}

function mapDeliveryRow(row: DeliveryRow): NotificationDeliveryRecord {
  return {
    slashingEventId: row.slashing_event_id,
    channel: row.channel,
    notificationId: row.notification_id,
    status: row.status,
    attempts: Number(row.attempts),
    lastError: row.last_error,
    updatedAt: new Date(row.updated_at),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
