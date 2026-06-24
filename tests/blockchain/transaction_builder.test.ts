import { TransactionBuilder } from '../../src/blockchain/transaction_builder';
import { RpcClient, TransactionResult } from '../../src/blockchain/rpc_client';
import { ContractDataPointer, MAX_BATCH_TTL_ENTRIES } from '../../src/contracts/verification_contract';

class FakeRpc extends RpcClient {
  private failCount: number;
  private callCount = 0;

  constructor(failCount = 0) {
    super({ endpoint: 'http://fake:8000', timeoutMs: 5000 });
    this.failCount = failCount;
  }

  async sendTransaction(_tx: string): Promise<TransactionResult> {
    this.callCount++;
    if (this.callCount <= this.failCount) {
      return { hash: '', success: false, error: { code: -32000, message: 'retryable' } };
    }
    return { hash: '0xtx', success: true };
  }

  getCallCount(): number { return this.callCount; }
}

function mockFastTimeout() {
  const orig = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void) => { fn(); return 0 as any; }) as any;
  return () => { globalThis.setTimeout = orig; };
}

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;

  function assert(condition: boolean, name: string): void {
    if (condition) {
      console.log(`  \u2713 ${name}`);
      passed++;
    } else {
      console.log(`  \u2717 ${name}`);
      failed++;
    }
  }

  console.log('\nTransaction Builder Tests\n');

  // ── chunk: empty input ───────────────────────────────────────────
  {
    const chunks = TransactionBuilder.chunk([]);
    assert(Array.isArray(chunks), 'chunk returns array');
    assert(chunks.length === 0, 'empty input yields empty chunks');
  }

  // ── chunk: fewer than max ────────────────────────────────────────
  {
    const pointers: ContractDataPointer[] = [
      { contractId: 'C1', dataKey: 'attestation_root' },
      { contractId: 'C2', dataKey: 'governance_weight' },
    ];
    const chunks = TransactionBuilder.chunk(pointers);
    assert(chunks.length === 1, 'chunk count is 1 for <max entries');
    assert(chunks[0].length === 2, 'chunk has 2 items');
  }

  // ── chunk: exactly at max boundry ────────────────────────────────
  {
    const pointers: ContractDataPointer[] = Array.from({ length: MAX_BATCH_TTL_ENTRIES }, (_, i) => ({
      contractId: `C${i}`,
      dataKey: 'attestation_root' as const,
    }));
    const chunks = TransactionBuilder.chunk(pointers);
    assert(chunks.length === 1, 'exactly max entries -> 1 chunk');
  }

  // ── chunk: over max splits ───────────────────────────────────────
  {
    const pointers: ContractDataPointer[] = Array.from({ length: MAX_BATCH_TTL_ENTRIES + 1 }, (_, i) => ({
      contractId: `C${i}`,
      dataKey: 'attestation_root' as const,
    }));
    const chunks = TransactionBuilder.chunk(pointers);
    assert(chunks.length === 2, 'over max entries -> 2 chunks');
    assert(chunks[0].length === MAX_BATCH_TTL_ENTRIES, 'first chunk is full');
    assert(chunks[1].length === 1, 'second chunk gets remainder');
  }

  // ── submitBatchRenewal: empty pointers ───────────────────────────
  {
    const rpc = new FakeRpc();
    const builder = new TransactionBuilder(rpc);
    const result = await builder.submitBatchRenewal({ pointers: [], extendToLedgers: 10000 });
    assert(result.txResult.success === true, 'empty pointers succeeds');
    assert(result.renewedPointers.length === 0, 'no pointers renewed');
    assert(result.attempts === 0, 'zero attempts for empty input');
  }

  // ── submitBatchRenewal: exceeds max batch size throws ────────────
  {
    const rpc = new FakeRpc();
    const builder = new TransactionBuilder(rpc);
    const pointers: ContractDataPointer[] = Array.from({ length: MAX_BATCH_TTL_ENTRIES + 1 }, (_, i) => ({
      contractId: `C${i}`,
      dataKey: 'attestation_root' as const,
    }));
    try {
      await builder.submitBatchRenewal({ pointers, extendToLedgers: 10000 });
      assert(false, 'should throw on oversized batch');
    } catch (err) {
      assert((err as Error).message.includes('exceeds maximum'), 'oversized batch error message');
    }
  }

  // ── submitBatchRenewal: first attempt succeeds ───────────────────
  {
    const rpc = new FakeRpc();
    const builder = new TransactionBuilder(rpc);
    const pointers: ContractDataPointer[] = [{ contractId: 'C1', dataKey: 'attestation_root' }];
    const result = await builder.submitBatchRenewal({ pointers, extendToLedgers: 10000 });
    assert(result.txResult.success === true, 'first attempt succeeds');
    assert(result.renewedPointers.length === 1, 'renewed pointer returned');
    assert(result.attempts === 1, 'one attempt made');
    assert(rpc.getCallCount() === 1, 'sendTransaction called once');
  }

  // ── submitBatchRenewal: retries on failure ───────────────────────
  {
    const restore = mockFastTimeout();
    try {
      const rpc = new FakeRpc(1);
      const builder = new TransactionBuilder(rpc);
      const pointers: ContractDataPointer[] = [{ contractId: 'C1', dataKey: 'attestation_root' }];
      const result = await builder.submitBatchRenewal({ pointers, extendToLedgers: 10000 });
      assert(result.txResult.success === true, 'retries succeed');
      assert(result.attempts === 2, 'two attempts (1 failure + 1 success)');
      assert(rpc.getCallCount() === 2, 'sendTransaction called 2 times');
    } finally {
      restore();
    }
  }

  // ── submitBatchRenewal: all retries exhausted ────────────────────
  {
    const restore = mockFastTimeout();
    try {
      const rpc = new FakeRpc(99);
      const builder = new TransactionBuilder(rpc);
      const pointers: ContractDataPointer[] = [{ contractId: 'C1', dataKey: 'attestation_root' }];
      const result = await builder.submitBatchRenewal({ pointers, extendToLedgers: 10000 });
      assert(result.txResult.success === false, 'exhausted retries returns failure');
      assert(result.attempts === 4, '4 attempts (3 retries + initial)');
      assert(result.renewedPointers.length === 0, 'no pointers renewed on failure');
      assert(rpc.getCallCount() === 4, 'sendTransaction called 4 times');
    } finally {
      restore();
    }
  }

  // ── submitBatchRenewal: with preflight ───────────────────────────
  {
    const rpc = new FakeRpc();
    const builder = new TransactionBuilder(rpc);
    const pointers: ContractDataPointer[] = [{ contractId: 'C1', dataKey: 'attestation_root' }];
    const preflight = {
      instructions: 100,
      writeBytes: 200,
      estimatedGas: 150,
      simulationDurationMs: 10,
      storageKeysAccessed: [],
    };
    const result = await builder.submitBatchRenewal({ pointers, extendToLedgers: 10000, preflight });
    assert(result.txResult.success === true, 'preflight renewal succeeds');
    assert(rpc.getCallCount() === 1, 'sendTransaction called once');
  }

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('transaction_builder.test.ts crashed:', err);
  process.exit(1);
});
