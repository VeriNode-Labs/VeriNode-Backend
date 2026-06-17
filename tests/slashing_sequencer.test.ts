import { NonceSequencer } from '../src/staking/slashing_sequencer';
import { RpcClient, TransactionResult } from '../src/blockchain/rpc_client';
import { NonceStore } from '../src/database/nonce_store';
import { SlashingTx, SlashingMetrics } from '../src/staking/slashing_agent';
import { mkdtempSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

class FakeRpcClient extends RpcClient {
  private simulateFailure: boolean;

  constructor(fail: boolean = false) {
    super({ endpoint: 'http://localhost:9999', timeoutMs: 5000 });
    this.simulateFailure = fail;
  }

  async sendTransaction(tx: string): Promise<TransactionResult> {
    if (this.simulateFailure) {
      return { hash: '', success: false, error: { code: -32000, message: 'simulated failure' } };
    }
    return { hash: '0x' + Math.random().toString(16).slice(2), success: true };
  }
}

function createTempStore(): NonceStore {
  const dir = mkdtempSync(join(tmpdir(), 'nonce-test-'));
  return new NonceStore(dir);
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
