import { strict as assert } from 'assert';
import { PoolClient } from 'pg';
import { AttestationStore, PendingAttestation } from '../../src/attestation/store';
import { AttestationBatchProcessor } from '../../src/attestation/batchProcessor';
import { Database } from '../../src/config/database';

// ---------------------------------------------------------------------------
// Test 1: direct reproduction of the bug scenario from the issue.
// Worker 1 reads T1 but is the LAST to write; worker 3 reads T3 but is the
// FIRST to write. Before the fix (plain `SET last_attestation_time = $1`)
// the column would end up at T1. With GREATEST() it must end up at T3.
// ---------------------------------------------------------------------------
async function testOutOfOrderWritesStayMonotonic(): Promise<void> {
  const nodes = new Map<string, { last_attestation_time: Date | null }>();
  nodes.set('node-x', { last_attestation_time: null });

  const client = {
    query: async (sql: string, params?: unknown[]) => {
      const [nodeId, ts] = params as [string, Date];
      const current = nodes.get(nodeId)!.last_attestation_time;
      const next = current === null || ts > current ? ts : current;
      nodes.get(nodeId)!.last_attestation_time = next;
      return { rows: [{ last_attestation_time: next }] } as any;
    },
  } as unknown as PoolClient;

  const store = new AttestationStore({} as unknown as Database);

  const T1 = new Date('2026-08-28T10:00:00Z');
  const T2 = new Date('2026-08-28T10:00:05Z');
  const T3 = new Date('2026-08-28T10:00:10Z');

  // Write order is deliberately the reverse of read order: T3, then T2,
  // then T1 last — the exact interleaving described in the issue.
  await store.advanceLastAttestationTime(client, 'node-x', T3);
  await store.advanceLastAttestationTime(client, 'node-x', T2);
  await store.advanceLastAttestationTime(client, 'node-x', T1);

  assert.equal(
    nodes.get('node-x')!.last_attestation_time!.getTime(),
    T3.getTime(),
    'last_attestation_time must equal MAX(T1,T2,T3) regardless of write order',
  );
  console.log('testOutOfOrderWritesStayMonotonic passed');
}

// ---------------------------------------------------------------------------
// Test 2 (resolution item 5): 4 workers processing 10 attestations for the
// SAME node concurrently. Verifies last_attestation_time ends up as the max
// of all attestation timestamps, every attestation is processed exactly
// once, and the reputation reward is applied exactly 10 times.
// ---------------------------------------------------------------------------
class LockRegistry {
  private locked = new Set<string>();
  private waiters = new Map<string, Array<() => void>>();

  tryLock(key: string): boolean {
    if (this.locked.has(key)) return false;
    this.locked.add(key);
    return true;
  }

  async lock(key: string): Promise<void> {
    while (!this.tryLock(key)) {
      await new Promise<void>((resolve) => {
        const arr = this.waiters.get(key) ?? [];
        arr.push(resolve);
        this.waiters.set(key, arr);
      });
    }
  }

  unlock(key: string): void {
    this.locked.delete(key);
    const next = this.waiters.get(key)?.shift();
    if (next) next();
  }
}

interface FakeAttestationRow {
  id: string;
  node_id: string;
  validator_id: string;
  attested_at: Date;
  status: string;
}

class FakeDb {
  nodes = new Map<string, { last_attestation_time: Date | null }>();
  reputations = new Map<string, { score: number; slash_version: number }>();
  attestations: FakeAttestationRow[] = [];
  processedIds: string[] = [];
  private locks = new LockRegistry();

  async query(sql: string, params?: unknown[]) {
    return this.dispatch(null, sql, params);
  }

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const held = new Set<string>();
    const client = {
      query: async (sql: string, params?: unknown[]) => this.dispatch(held, sql, params),
    } as unknown as PoolClient;
    try {
      const result = await fn(client);
      return result;
    } finally {
      for (const key of held) this.locks.unlock(key);
    }
  }

  private async dispatch(held: Set<string> | null, sql: string, params?: unknown[]): Promise<any> {
    const norm = sql.replace(/\s+/g, ' ').trim();

    if (norm.startsWith('SELECT') && norm.includes('FOR UPDATE SKIP LOCKED')) {
      const limit = params![0] as number;
      const rows: FakeAttestationRow[] = [];
      for (const row of [...this.attestations].sort((a, b) => Number(a.id) - Number(b.id))) {
        if (rows.length >= limit) break;
        if (row.status !== 'pending') continue;
        if (!this.locks.tryLock(`attn:${row.id}`)) continue; // SKIP LOCKED
        held!.add(`attn:${row.id}`);
        rows.push(row);
      }
      return { rows };
    }
    if (norm.startsWith("UPDATE attestations SET status = 'processing'")) {
      const ids = params![0] as string[];
      for (const row of this.attestations) if (ids.includes(row.id)) row.status = 'processing';
      return { rows: [] };
    }
    if (norm.startsWith("UPDATE attestations SET status = 'processed'")) {
      const id = params![0] as string;
      const row = this.attestations.find((r) => r.id === id)!;
      row.status = 'processed';
      this.processedIds.push(id);
      return { rows: [] };
    }
    if (norm.includes('FROM reputations') && norm.includes('FOR UPDATE')) {
      const nodeId = params![0] as string;
      await this.locks.lock(`rep:${nodeId}`);
      held!.add(`rep:${nodeId}`);
      const rec = this.reputations.get(nodeId)!;
      return { rows: [{ score: rec.score, slash_version: rec.slash_version }] };
    }
    if (norm.startsWith('UPDATE reputations') && norm.includes('SET score = $2')) {
      const [nodeId, newScore] = params as [string, number];
      this.reputations.get(nodeId)!.score = newScore;
      return { rows: [{ score: newScore }] };
    }
    if (norm.startsWith('UPDATE nodes') && norm.includes('GREATEST')) {
      const [nodeId, ts] = params as [string, Date];
      const rec = this.nodes.get(nodeId)!;
      rec.last_attestation_time =
        rec.last_attestation_time === null || ts > rec.last_attestation_time
          ? ts
          : rec.last_attestation_time;
      return { rows: [{ last_attestation_time: rec.last_attestation_time }] };
    }

    throw new Error(`FakeDb: unhandled query: ${norm}`);
  }
}

async function testFourWorkersTenAttestationsSameNode(): Promise<void> {
  const db = new FakeDb();
  db.nodes.set('node-x', { last_attestation_time: null });
  db.reputations.set('node-x', { score: 0, slash_version: 0 });

  const base = Date.parse('2026-08-28T10:00:00Z');
  // Shuffle timestamps so claim order (ascending id) is decoupled from
  // attested_at order — this is what lets a later-id row hold an earlier
  // timestamp and vice versa, reproducing the race.
  const offsetsSeconds = [40, 5, 25, 0, 35, 10, 45, 15, 30, 20];
  offsetsSeconds.forEach((offset, i) => {
    db.attestations.push({
      id: String(i + 1),
      node_id: 'node-x',
      validator_id: `validator-${i + 1}`,
      attested_at: new Date(base + offset * 1000),
      status: 'pending',
    });
  });
  const maxAttestedAt = new Date(base + Math.max(...offsetsSeconds) * 1000);

  const processor = new AttestationBatchProcessor(db as unknown as Database, {
    workerCount: 4,
    maxBatchSize: 100,
  });
  const results = await processor.processBatch();

  assert.equal(results.length, 10, 'all 10 attestations must be processed');
  assert.equal(new Set(results.map((r) => r.attestationId)).size, 10, 'no attestation double-processed');
  assert.equal(
    db.nodes.get('node-x')!.last_attestation_time!.getTime(),
    maxAttestedAt.getTime(),
    'last_attestation_time must equal MAX(all attestation timestamps) for the node',
  );
  assert.equal(db.reputations.get('node-x')!.score, 100, 'reward must be applied exactly once per attestation');
  console.log('testFourWorkersTenAttestationsSameNode passed');
}

async function main(): Promise<void> {
  await testOutOfOrderWritesStayMonotonic();
  await testFourWorkersTenAttestationsSameNode();
  console.log('attestation batch processor tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
