import { NonceSequencer } from '../src/staking/slashing_sequencer';
import { RpcClient, TransactionResult } from '../src/blockchain/rpc_client';
import { NonceStore } from '../src/database/nonce_store';
import { SlashingTx, SlashingMetrics } from '../src/staking/slashing_agent';
import {
  DeadLetterEntry,
  DeadLetterQueueManager,
  DeadLetterRepository,
  DeadLetterWrite,
  ListDeadLettersParams,
} from '../src/queue/dead_letter_queue';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

class FakeRpcClient extends RpcClient {
  public sendCount = 0;

  constructor(
    private readonly alwaysFail: boolean = false,
    private failuresBeforeSuccess: number = 0,
  ) {
    super({ endpoint: 'http://localhost:9999', timeoutMs: 5000 });
  }

  async sendTransaction(tx: string): Promise<TransactionResult> {
    this.sendCount++;
    if (this.alwaysFail || this.failuresBeforeSuccess > 0) {
      this.failuresBeforeSuccess = Math.max(0, this.failuresBeforeSuccess - 1);
      return { hash: '', success: false, error: { code: -32000, message: 'simulated failure' } };
    }
    return { hash: '0x' + Math.random().toString(16).slice(2), success: true };
  }
}

function createTempStore(): NonceStore {
  const dir = mkdtempSync(join(tmpdir(), 'nonce-test-'));
  return new NonceStore(dir);
}

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
    return Array.from(this.entries.values()).filter((entry) => {
      return !params.messageType || entry.messageType === params.messageType;
    });
  }

  async get(id: string): Promise<DeadLetterEntry | null> {
    return this.entries.get(id) ?? null;
  }

  async markRetrying(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) entry.status = 'retrying';
  }

  async markFailed(id: string, error: unknown, retryCount: number): Promise<void> {
    const entry = this.entries.get(id);
    if (entry) {
      entry.status = 'failed';
      entry.errorType = error instanceof Error ? error.name : typeof error;
      entry.errorMessage = error instanceof Error ? error.message : String(error);
      entry.retryCount = retryCount;
    }
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  async purgeExpired(): Promise<number> {
    return 0;
  }

  async depth(): Promise<number> {
    return this.entries.size;
  }
}

function makeSlashingTx(validatorId: string): SlashingTx {
  return {
    validatorId,
    misbehaviorType: 'double_sign',
    evidence: '0xdeadbeef',
    signature: '0xabc123',
  };
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

  console.log('\nNonceSequencer Tests\n');

  // Test 1: Basic submission
  {
    const store = createTempStore();
    const seq = new NonceSequencer(new FakeRpcClient(), store);
    const result = await seq.onSlashingRequest(makeSlashingTx('val-1'));
    assert(result.success === true, 'submits slashing tx successfully');
    assert(result.nonce >= 0n, 'assigns valid nonce');
    assert(result.txHash.startsWith('0x'), 'returns tx hash');
  }

  // Test 2: Monotonically increasing nonces
  {
    const store = createTempStore();
    const seq = new NonceSequencer(new FakeRpcClient(), store);
    const nonces: bigint[] = [];
    for (let i = 0; i < 10; i++) {
      const result = await seq.onSlashingRequest(makeSlashingTx(`val-${i}`));
      nonces.push(result.nonce);
    }
    for (let i = 1; i < nonces.length; i++) {
      assert(nonces[i] > nonces[i - 1], `nonces strictly increasing: ${nonces[i - 1]} < ${nonces[i]}`);
    }
  }

  // Test 3: Error handling
  {
    const store = createTempStore();
    const seq = new NonceSequencer(new FakeRpcClient(true), store);
    const result = await seq.onSlashingRequest(makeSlashingTx('val-fail'));
    assert(result.success === false, 'returns failure on RPC error');
    assert(result.error !== undefined, 'includes error message');
  }

  // Test 3b: DLQ captures exhausted async processing retries
  {
    const store = createTempStore();
    const repo = new MemoryDeadLetterRepository();
    const dlq = new DeadLetterQueueManager(repo, undefined, async () => undefined);
    const rpc = new FakeRpcClient(true);
    const seq = new NonceSequencer(rpc, store, dlq);
    const result = await seq.onSlashingRequest(makeSlashingTx('val-dlq'));
    const [entry] = Array.from(repo.entries.values());
    assert(result.success === false, 'DLQ-enabled sequencer still returns failure');
    assert(rpc.sendCount === 4, `initial attempt plus 3 retries (${rpc.sendCount})`);
    assert(repo.entries.size === 1, 'exhausted retries write one DLQ entry');
    assert(entry.messageType === 'slashing_request', `DLQ message type ${entry.messageType}`);
    assert(entry.retryCount === 3, `DLQ retry count ${entry.retryCount}`);
  }

  // Test 4: Metrics tracking
  {
    const store = createTempStore();
    const seq = new NonceSequencer(new FakeRpcClient(), store);
    await seq.onSlashingRequest(makeSlashingTx('val-1'));
    await seq.onSlashingRequest(makeSlashingTx('val-2'));
    const metrics = seq.getMetrics();
    assert(metrics.totalSubmitted === 2, `totalSubmitted = ${metrics.totalSubmitted}`);
    assert(metrics.totalConfirmed === 2, `totalConfirmed = ${metrics.totalConfirmed}`);
    assert(metrics.totalFailed === 0, `totalFailed = ${metrics.totalFailed}`);
    assert(BigInt(metrics.currentNonce) >= 2n, `currentNonce advances`);
  }

  // Test 5: Watermark persistence
  {
    const store = createTempStore();
    const seq1 = new NonceSequencer(new FakeRpcClient(), store);
    await seq1.onSlashingRequest(makeSlashingTx('val-1'));
    const waterMark1 = store.getWaterMark();

    const seq2 = new NonceSequencer(new FakeRpcClient(), store);
    const waterMark2 = store.getWaterMark();
    assert(waterMark2 >= waterMark1, 'watermark persists across restarts');
  }

  // Test 6: WAL recovery
  {
    const store = createTempStore();
    const seq = new NonceSequencer(new FakeRpcClient(), store);
    await seq.onSlashingRequest(makeSlashingTx('val-1'));
    store.flush();
    const unconfirmed = store.replayUnconfirmed();
    assert(unconfirmed.length === 0, 'confirmed entries not in WAL replay');

    store.advanceWaterMark('1');
    store.purgeConfirmed('1');
    const afterPurge = store.replayUnconfirmed();
    assert(afterPurge.length === 0, 'WAL purged after confirmation');
  }

  // Test 7: Stress test - 256 concurrent submissions
  {
    const store = createTempStore();
    const seq = new NonceSequencer(new FakeRpcClient(), store);
    const tasks: Promise<SlashingTx & { success: boolean }>[] = [];
    for (let i = 0; i < 256; i++) {
      const tx = makeSlashingTx(`val-${i}`);
      tasks.push(seq.onSlashingRequest(tx).then((r) => ({ ...tx, success: r.success })));
    }
    const results = await Promise.all(tasks);
    const successes = results.filter((r) => r.success).length;
    assert(successes === 256, `256/256 concurrent submissions succeed, got ${successes}`);
  }

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
