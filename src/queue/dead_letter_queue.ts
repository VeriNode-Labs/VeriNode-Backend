type QueryResultRow = Record<string, unknown>;

export const DLQ_MAX_RETRIES = 3;
export const DLQ_BACKOFF_MS = [30_000, 120_000, 600_000] as const;
export const DLQ_TTL_DAYS = 7;

export type DeadLetterStatus = 'failed' | 'retrying';

export interface DeadLetterEntry<TMessage = unknown> {
  id: string;
  messageType: string;
  originalMessage: TMessage;
  errorType: string;
  errorMessage: string;
  stackTrace: string | null;
  retryCount: number;
  status: DeadLetterStatus;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
}

export interface ListDeadLettersParams {
  messageType?: string;
  limit?: number;
  offset?: number;
}

export interface DeadLetterWrite<TMessage> {
  messageType: string;
  originalMessage: TMessage;
  error: unknown;
  retryCount: number;
}

export interface DeadLetterRepository {
  insert<TMessage>(entry: DeadLetterWrite<TMessage>): Promise<DeadLetterEntry<TMessage>>;
  list(params?: ListDeadLettersParams): Promise<DeadLetterEntry[]>;
  get(id: string): Promise<DeadLetterEntry | null>;
  markRetrying(id: string): Promise<void>;
  markFailed(id: string, error: unknown, retryCount: number): Promise<void>;
  delete(id: string): Promise<boolean>;
  purgeExpired(now?: Date): Promise<number>;
  depth(): Promise<number>;
}

interface DatabaseLike {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount: number | null }>;
}

interface DeadLetterRow extends QueryResultRow {
  id: string;
  message_type: string;
  original_message: unknown;
  error_type: string;
  error_message: string;
  stack_trace: string | null;
  retry_count: number;
  status: DeadLetterStatus;
  created_at: Date | string;
  updated_at: Date | string;
  expires_at: Date | string;
}

export class MessageProcessingError extends Error {
  readonly causeValue: unknown;

  constructor(message: string, causeValue: unknown) {
    super(message);
    this.name = 'MessageProcessingError';
    this.causeValue = causeValue;
  }
}

export class PgDeadLetterRepository implements DeadLetterRepository {
  constructor(private readonly db: DatabaseLike) {}

  async insert<TMessage>(entry: DeadLetterWrite<TMessage>): Promise<DeadLetterEntry<TMessage>> {
    const error = serializeError(entry.error);
    const result = await this.db.query<DeadLetterRow>(
      `INSERT INTO dead_letter_queue (
         message_type, original_message, error_type, error_message,
         stack_trace, retry_count, status, expires_at
       ) VALUES ($1, $2::jsonb, $3, $4, $5, $6, 'failed', NOW() + INTERVAL '7 days')
       RETURNING *`,
      [
        entry.messageType,
        JSON.stringify(entry.originalMessage),
        error.type,
        error.message,
        error.stackTrace,
        entry.retryCount,
      ],
    );
    return mapRow<TMessage>(result.rows[0]);
  }

  async list(params: ListDeadLettersParams = {}): Promise<DeadLetterEntry[]> {
    const limit = clampInt(params.limit ?? 100, 1, 500);
    const offset = Math.max(0, Math.trunc(params.offset ?? 0));
    const values: unknown[] = [];
    let where = 'WHERE expires_at > NOW()';
    if (params.messageType) {
      values.push(params.messageType);
      where += ` AND message_type = $${values.length}`;
    }
    values.push(limit, offset);
    const result = await this.db.query<DeadLetterRow>(
      `SELECT * FROM dead_letter_queue
       ${where}
       ORDER BY created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    );
    return result.rows.map((row) => mapRow(row));
  }

  async get(id: string): Promise<DeadLetterEntry | null> {
    const result = await this.db.query<DeadLetterRow>(
      `SELECT * FROM dead_letter_queue WHERE id = $1 AND expires_at > NOW()`,
      [id],
    );
    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async markRetrying(id: string): Promise<void> {
    await this.db.query(
      `UPDATE dead_letter_queue SET status = 'retrying', updated_at = NOW() WHERE id = $1`,
      [id],
    );
  }

  async markFailed(id: string, errorValue: unknown, retryCount: number): Promise<void> {
    const error = serializeError(errorValue);
    await this.db.query(
      `UPDATE dead_letter_queue
       SET status = 'failed', error_type = $2, error_message = $3,
           stack_trace = $4, retry_count = $5, updated_at = NOW()
       WHERE id = $1`,
      [id, error.type, error.message, error.stackTrace, retryCount],
    );
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.db.query(`DELETE FROM dead_letter_queue WHERE id = $1`, [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async purgeExpired(now: Date = new Date()): Promise<number> {
    const result = await this.db.query(
      `DELETE FROM dead_letter_queue WHERE expires_at <= $1`,
      [now.toISOString()],
    );
    return result.rowCount ?? 0;
  }

  async depth(): Promise<number> {
    const result = await this.db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM dead_letter_queue WHERE expires_at > NOW()`,
    );
    return Number(result.rows[0]?.count ?? '0');
  }
}

export interface RetryHistogramSnapshot {
  buckets: readonly number[];
  counts: readonly number[];
  sum: number;
  total: number;
}

export class DeadLetterQueueMetrics {
  private readonly buckets = [0, 1, 2, 3] as const;
  private readonly counts = [0, 0, 0, 0];
  private retrySum = 0;
  private retryTotal = 0;
  private retrySuccessTotal = 0;
  private retryFailureTotal = 0;

  observeRetryCount(count: number): void {
    this.retrySum += count;
    this.retryTotal++;
    for (let i = 0; i < this.buckets.length; i++) {
      if (count <= this.buckets[i]) {
        this.counts[i]++;
      }
    }
  }

  recordRetryOutcome(success: boolean): void {
    if (success) {
      this.retrySuccessTotal++;
    } else {
      this.retryFailureTotal++;
    }
  }

  snapshot(): RetryHistogramSnapshot {
    return {
      buckets: this.buckets,
      counts: this.counts,
      sum: this.retrySum,
      total: this.retryTotal,
    };
  }

  renderPrometheus(depth: number): string {
    const hist = this.snapshot();
    const lines = [
      '# HELP verinode_dlq_depth Number of unexpired dead letter queue entries.',
      '# TYPE verinode_dlq_depth gauge',
      `verinode_dlq_depth ${depth}`,
      '# HELP verinode_dlq_retry_count Failed-message retry count before DLQ or manual retry completion.',
      '# TYPE verinode_dlq_retry_count histogram',
    ];
    for (let i = 0; i < hist.buckets.length; i++) {
      lines.push(`verinode_dlq_retry_count_bucket{le="${hist.buckets[i]}"} ${hist.counts[i]}`);
    }
    lines.push(`verinode_dlq_retry_count_bucket{le="+Inf"} ${hist.total}`);
    lines.push(`verinode_dlq_retry_count_sum ${hist.sum}`);
    lines.push(`verinode_dlq_retry_count_count ${hist.total}`);
    lines.push('# HELP verinode_dlq_manual_retry_total Manual DLQ retry outcomes.');
    lines.push('# TYPE verinode_dlq_manual_retry_total counter');
    lines.push(`verinode_dlq_manual_retry_total{outcome="success"} ${this.retrySuccessTotal}`);
    lines.push(`verinode_dlq_manual_retry_total{outcome="failure"} ${this.retryFailureTotal}`);
    return `${lines.join('\n')}\n`;
  }
}

export interface ProcessOptions {
  maxRetries?: number;
  backoffMs?: readonly number[];
}

export type MessageHandler<TMessage, TResult> = (message: TMessage) => Promise<TResult>;
export type SleepFn = (ms: number) => Promise<void>;

export class DeadLetterQueueManager {
  constructor(
    private readonly repository: DeadLetterRepository,
    private readonly metrics = new DeadLetterQueueMetrics(),
    private readonly sleep: SleepFn = defaultSleep,
  ) {}

  async process<TMessage, TResult>(
    messageType: string,
    message: TMessage,
    handler: MessageHandler<TMessage, TResult>,
    options: ProcessOptions = {},
  ): Promise<TResult> {
    const maxRetries = options.maxRetries ?? DLQ_MAX_RETRIES;
    const backoffMs = options.backoffMs ?? DLQ_BACKOFF_MS;
    let lastError: unknown = null;

    for (let retryCount = 0; retryCount <= maxRetries; retryCount++) {
      try {
        return await handler(message);
      } catch (errorValue) {
        lastError = errorValue;
        if (retryCount === maxRetries) {
          this.metrics.observeRetryCount(retryCount);
          await this.repository.insert({
            messageType,
            originalMessage: message,
            error: errorValue,
            retryCount,
          });
          throw errorValue;
        }
        await this.sleep(backoffMs[retryCount] ?? backoffMs[backoffMs.length - 1] ?? 0);
      }
    }

    throw new MessageProcessingError('message processing failed without captured error', lastError);
  }

  async list(params?: ListDeadLettersParams): Promise<DeadLetterEntry[]> {
    return this.repository.list(params);
  }

  async retry<TMessage, TResult>(
    id: string,
    handler: MessageHandler<TMessage, TResult>,
    options: ProcessOptions = {},
  ): Promise<TResult> {
    const entry = await this.repository.get(id);
    if (!entry) {
      throw new Error(`dead letter entry not found: ${id}`);
    }
    await this.repository.markRetrying(id);

    const maxRetries = options.maxRetries ?? DLQ_MAX_RETRIES;
    const backoffMs = options.backoffMs ?? DLQ_BACKOFF_MS;
    let lastError: unknown = null;

    for (let retryCount = 0; retryCount <= maxRetries; retryCount++) {
      try {
        const result = await handler(entry.originalMessage as TMessage);
        await this.repository.delete(id);
        this.metrics.observeRetryCount(retryCount);
        this.metrics.recordRetryOutcome(true);
        return result;
      } catch (errorValue) {
        lastError = errorValue;
        if (retryCount === maxRetries) {
          await this.repository.markFailed(id, errorValue, retryCount);
          this.metrics.observeRetryCount(retryCount);
          this.metrics.recordRetryOutcome(false);
          throw errorValue;
        }
        await this.sleep(backoffMs[retryCount] ?? backoffMs[backoffMs.length - 1] ?? 0);
      }
    }

    throw new MessageProcessingError('dead letter retry failed without captured error', lastError);
  }

  async purge(id: string): Promise<boolean> {
    return this.repository.delete(id);
  }

  async purgeExpired(now?: Date): Promise<number> {
    return this.repository.purgeExpired(now);
  }

  async prometheusMetrics(): Promise<string> {
    return this.metrics.renderPrometheus(await this.repository.depth());
  }
}

function serializeError(errorValue: unknown): { type: string; message: string; stackTrace: string | null } {
  if (errorValue instanceof Error) {
    return {
      type: errorValue.name || 'Error',
      message: errorValue.message,
      stackTrace: errorValue.stack ?? null,
    };
  }
  return {
    type: typeof errorValue,
    message: String(errorValue),
    stackTrace: null,
  };
}

function mapRow<TMessage = unknown>(row: DeadLetterRow): DeadLetterEntry<TMessage> {
  return {
    id: row.id,
    messageType: row.message_type,
    originalMessage: row.original_message as TMessage,
    errorType: row.error_type,
    errorMessage: row.error_message,
    stackTrace: row.stack_trace,
    retryCount: Number(row.retry_count),
    status: row.status,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    expiresAt: new Date(row.expires_at),
  };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}
