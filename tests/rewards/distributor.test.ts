import { RewardDistributor } from '../../src/rewards/distributor';

type QueryResultRow = Record<string, unknown>;

interface QueryResult<T extends QueryResultRow = QueryResultRow> {
  rows: T[];
  rowCount: number;
  command: string;
  oid: number;
  fields: unknown[];
}

class Mutex {
  private tail = Promise.resolve();

  async acquire(): Promise<() => void> {
    let release!: () => void;
    const next = new Promise<void>((resolve) => { release = resolve; });
    const previous = this.tail;
    this.tail = this.tail.then(() => next);
    await previous;
    return release;
  }
}

class MockRewardDatabase {
  readonly pending = new Map<string, bigint>();
  readonly tx = new Map<string, bigint[]>();
  private readonly locks = new Map<string, Mutex>();

  async transaction<T>(fn: (client: MockClient) => Promise<T>): Promise<T> {
    const client = new MockClient(this);
    try {
      return await fn(client);
    } finally {
      client.releaseLocks();
    }
  }

  mutex(name: string): Mutex {
    let mutex = this.locks.get(name);
    if (!mutex) {
      mutex = new Mutex();
      this.locks.set(name, mutex);
    }
    return mutex;
  }
}

class MockClient {
  private readonly releases: Array<() => void> = [];

  constructor(private readonly db: MockRewardDatabase) {}

  async query<T extends QueryResultRow = any>(text: string, params: any[] = []): Promise<QueryResult<T>> {
    if (text.startsWith('SELECT pg_advisory_xact_lock')) {
      const release = await this.db.mutex(String(params[0])).acquire();
      this.releases.push(release);
      return emptyResult<T>();
    }
    if (text.startsWith('SELECT amount FROM reward_pending_amounts')) {
      const nodeId = String(params[0]);
      const amount = this.db.pending.get(nodeId) ?? 0n;
      return result([{ amount: format(amount) } as unknown as T]);
    }
    if (text.startsWith('INSERT INTO reward_tx')) {
      const nodeId = String(params[0]);
      const amount = parse(String(params[1]));
      const rows = this.db.tx.get(nodeId) ?? [];
      rows.push(amount);
      this.db.tx.set(nodeId, rows);
      return emptyResult<T>();
    }
    if (text.startsWith('UPDATE reward_pending_amounts')) {
      const nodeId = String(params[0]);
      const amount = parse(String(params[1]));
      this.db.pending.set(nodeId, (this.db.pending.get(nodeId) ?? 0n) - amount);
      return emptyResult<T>();
    }
    return emptyResult<T>();
  }

  releaseLocks(): void {
    while (this.releases.length) this.releases.pop()?.();
  }
}

async function main(): Promise<void> {
  const db = new MockRewardDatabase();
  const nodes = ['node-a', 'node-b', 'node-c', 'node-d', 'node-e'];
  for (const node of nodes) db.pending.set(node, parse('10.0000000'));

  const distributor = new RewardDistributor(db as any);
  const workers = Array.from({ length: 8 }, () =>
    Promise.all(nodes.map((node) => distributor.computeAndDistributeNodeReward(node))),
  );
  await Promise.all(workers);

  for (const node of nodes) {
    const distributions = db.tx.get(node) ?? [];
    assert(distributions.length === 1, `${node} expected one distribution, got ${distributions.length}`);
    assert(distributions[0] === parse('10.0000000'), `${node} received wrong amount`);
    assert(db.pending.get(node) === 0n, `${node} pending amount was not drained`);
  }

  const metrics = distributor.prometheusMetrics();
  assert(metrics.includes('reward_lock_acquisition_seconds'), 'missing lock histogram');
  assert(metrics.includes('reward_lock_contention_total'), 'missing contention counter');
  assert(metrics.includes('reward_double_spend_prevented_total 5'), 'missing prevention counter');
  console.log('rewards distributor concurrency tests passed');
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

function emptyResult<T extends QueryResultRow>(): QueryResult<T> {
  return result<T>([]);
}

function parse(value: string): bigint {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, '0'));
}

function format(value: bigint): string {
  return `${value / 10_000_000n}.${(value % 10_000_000n).toString().padStart(7, '0')}`;
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
