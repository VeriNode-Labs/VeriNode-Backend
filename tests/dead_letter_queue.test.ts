import {
  DeadLetterEntry,
  DeadLetterRepository,
  DeadLetterQueueManager,
  DeadLetterWrite,
  ListDeadLettersParams,
} from '../src/queue/dead_letter_queue';

class MemoryDeadLetterRepository implements DeadLetterRepository {
  readonly entries = new Map<string, DeadLetterEntry>();

  async insert<TMessage>(entry: DeadLetterWrite<TMessage>): Promise<DeadLetterEntry<TMessage>> {
    const now = new Date();
    const stored: DeadLetterEntry<TMessage> = {
      id: `dlq-${this.entries.size + 1}`,
      messageType: entry.messageType,
      originalMessage: entry.originalMessage,
      errorType: entry.error instanceof Error ? entry.error.name : typeof entry.error,
      errorMessage: entry.error instanceof Error ? entry.error.message : String(entry.error),
      stackTrace: entry.error instanceof Error ? entry.error.stack ?? null : null,
      retryCount: entry.retryCount,
      status: 'failed',
      createdAt: now,
      updatedAt: now,
      expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    };
    this.entries.set(stored.id, stored);
    return stored;
  }

  async list(params: ListDeadLettersParams = {}): Promise<DeadLetterEntry[]> {
    const rows = Array.from(this.entries.values()).filter((entry) => {
      return !params.messageType || entry.messageType === params.messageType;
    });
    return rows.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? rows.length));
  }

  async get(id: string): Promise<DeadLetterEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async markRetrying(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) {
      entry.status = 'retrying';
      entry.updatedAt = new Date();
    }
  }

  async markFailed(id: string, error: unknown, retryCount: number): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) {
      entry.status = 'failed';
      entry.errorType = error instanceof Error ? error.name : typeof error;
      entry.errorMessage = error instanceof Error ? error.message : String(error);
      entry.stackTrace = error instanceof Error ? error.stack ?? null : null;
      entry.retryCount = retryCount;
      entry.updatedAt = new Date();
    }
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  async purgeExpired(now: Date = new Date()): Promise<number> {
    let purged = 0;
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt <= now) {
        this.entries.delete(id);
        purged++;
      }
    }
    return purged;
  }

  async depth(): Promise<number> {
    return this.entries.size;
  }
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string): void {
    if (condition) {
      console.log(`  ✓ ${name}`);
      passed++;
    } else {
      console.log(`  ✗ ${name}`);
      failed++;
    }
  }

  console.log('DeadLetterQueueManager tests\n');

  {
    const repo = new MemoryDeadLetterRepository();
    const sleeps: number[] = [];
    const manager = new DeadLetterQueueManager(repo, undefined, async (ms) => {
      sleeps.push(ms);
    });
    let attempts = 0;
    const result = await manager.process(
      'unit_message',
      { id: 'msg-1' },
      async () => {
        attempts++;
        if (attempts < 3) throw new Error('transient');
        return 'ok';
      },
      { backoffMs: [30_000, 120_000, 600_000] },
    );

    assert(result === 'ok', 'transient failure eventually succeeds');
    assert(attempts === 3, `handler called until success (${attempts})`);
    assert(sleeps.join(',') === '30000,120000', `exponential backoff sequence ${sleeps.join(',')}`);
    assert(repo.entries.size === 0, 'successful retry is not written to DLQ');
  }

  {
    const repo = new MemoryDeadLetterRepository();
    const manager = new DeadLetterQueueManager(repo, undefined, async () => undefined);
    let thrown = false;
    try {
      await manager.process('unit_message', { id: 'msg-2' }, async () => {
        throw new TypeError('permanent');
      });
    } catch {
      thrown = true;
    }
    const [entry] = Array.from(repo.entries.values());
    assert(thrown, 'permanent failure is rethrown after retries');
    assert(repo.entries.size === 1, 'permanent failure is stored in DLQ');
    assert(entry.retryCount === 3, `retry count stored as ${entry.retryCount}`);
    assert(entry.errorType === 'TypeError', `error type stored as ${entry.errorType}`);
    assert(entry.stackTrace !== null, 'stack trace stored');
    assert(entry.expiresAt.getTime() - entry.createdAt.getTime() === 7 * 24 * 60 * 60 * 1000, '7-day TTL stored');
  }

  {
    const repo = new MemoryDeadLetterRepository();
    const manager = new DeadLetterQueueManager(repo, undefined, async () => undefined);
    const entry = await repo.insert({
      messageType: 'unit_message',
      originalMessage: { id: 'msg-3' },
      error: new Error('first failure'),
      retryCount: 3,
    });
    const result = await manager.retry<{ id: string }, string>(entry.id, async (message) => `retried:${message.id}`);
    assert(result === 'retried:msg-3', 'manual retry receives original message');
    assert(repo.entries.size === 0, 'successful manual retry removes DLQ entry');
  }

  {
    const repo = new MemoryDeadLetterRepository();
    const manager = new DeadLetterQueueManager(repo, undefined, async () => undefined);
    const entry = await repo.insert({
      messageType: 'unit_message',
      originalMessage: { id: 'msg-4' },
      error: new Error('first failure'),
      retryCount: 3,
    });
    let thrown = false;
    try {
      await manager.retry<{ id: string }, string>(entry.id, async () => {
        throw new RangeError('retry still failing');
      });
    } catch {
      thrown = true;
    }
    const stored = await repo.get(entry.id);
    assert(thrown, 'failed manual retry reports failure');
    assert(stored?.status === 'failed', `failed manual retry restores status ${stored?.status}`);
    assert(stored?.retryCount === 3, `failed manual retry stores retry count ${stored?.retryCount}`);
    assert(stored?.errorType === 'RangeError', `failed manual retry updates error type ${stored?.errorType}`);
  }

  {
    const repo = new MemoryDeadLetterRepository();
    const manager = new DeadLetterQueueManager(repo, undefined, async () => undefined);
    await repo.insert({
      messageType: 'unit_message',
      originalMessage: { id: 'msg-5' },
      error: new Error('depth'),
      retryCount: 3,
    });
    const metrics = await manager.prometheusMetrics();
    assert(metrics.includes('verinode_dlq_depth 1'), 'Prometheus depth gauge rendered');
    assert(metrics.includes('verinode_dlq_retry_count_bucket{le="3"}'), 'Prometheus retry histogram rendered');
  }

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
