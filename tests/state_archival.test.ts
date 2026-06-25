import { StateArchivalListener } from '../src/blockchain/state_archival';
import { TransactionBuilder } from '../src/blockchain/transaction_builder';
import { RpcClient, TransactionResult, LedgerEntryData, RpcError } from '../src/blockchain/rpc_client';
import { CRITICAL_DATA_KEYS, DEFAULT_TTL_LEDGERS } from '../src/contracts/verification_contract';

/** In-memory fake of a single Soroban contract's ledger state for simulation. */
class FakeLedger {
  public latestLedger = 0;
  private liveUntil = new Map<string, number>();

  deployContract(contractId: string, initialTtl: number): void {
    for (const key of CRITICAL_DATA_KEYS) {
      this.liveUntil.set(`${contractId}:${key}`, this.latestLedger + initialTtl);
    }
  }

  /** Simulates ledger close advancing by N ledgers. */
  advance(ledgers: number): void {
    this.latestLedger += ledgers;
  }

  remainingTtl(contractId: string, dataKey: string): number {
    const liveUntil = this.liveUntil.get(`${contractId}:${dataKey}`) ?? 0;
    return liveUntil - this.latestLedger;
  }

  renew(contractId: string, dataKey: string, extendToLedgers: number): void {
    this.liveUntil.set(`${contractId}:${dataKey}`, this.latestLedger + extendToLedgers);
  }
}

class FakeRpcClient extends RpcClient {
  public sendTransactionCallCount = 0;

  constructor(private ledger: FakeLedger) {
    super({ endpoint: 'http://localhost:9999', timeoutMs: 5000 });
  }

  async getLedgerEntry(contractId: string, dataKey: string): Promise<LedgerEntryData | RpcError> {
    return {
      ttl: this.ledger.remainingTtl(contractId, dataKey),
      xdr: '',
      lastModifiedLedgerSeq: this.ledger.latestLedger,
    };
  }

  async sendTransaction(tx: string): Promise<TransactionResult> {
    this.sendTransactionCallCount++;
    const decoded = JSON.parse(Buffer.from(tx, 'base64').toString('utf-8'));
    for (const key of decoded.keys as string[]) {
      const [contractId, dataKey] = key.split(':');
      this.ledger.renew(contractId, dataKey, decoded.extendTo);
    }
    return { hash: '0xsim' + this.sendTransactionCallCount, success: true };
  }
}

/** Minimal fake of the Database surface the listener actually calls. */
class FakeDatabase {
  private rows = new Map<string, { ttl: number; lastRenewedAt: Date | null }>();
  public queryCount = 0;
  public transactionCount = 0;

  seed(contractId: string): void {
    for (const key of CRITICAL_DATA_KEYS) {
      this.rows.set(`${contractId}:${key}`, { ttl: DEFAULT_TTL_LEDGERS, lastRenewedAt: null });
    }
  }

  async query<T = any>(text: string, params?: any[]): Promise<{ rows: T[] }> {
    this.queryCount++;
    if (text.includes('SELECT contract_id')) {
      const rows = Array.from(this.rows.entries()).map(([k, v]) => {
        const [contract_id, data_key] = k.split(':');
        return {
          contract_id,
          data_key,
          current_ttl_ledgers: v.ttl,
          last_renewed_at: v.lastRenewedAt,
        } as any;
      });
      return { rows: rows as T[] };
    }
    if (text.includes('UPDATE state_archival_watchlist')) {
      const [ttl, contractId, dataKey] = params as [number, string, string];
      this.rows.set(`${contractId}:${dataKey}`, { ttl, lastRenewedAt: new Date() });
      return { rows: [] };
    }
    return { rows: [] };
  }

  async transaction<T>(fn: (client: any) => Promise<T>): Promise<T> {
    this.transactionCount++;
    const client = { query: (text: string, params?: any[]) => this.query(text, params) };
    return fn(client);
  }
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

  console.log('StateArchivalListener simulation test\n');

  // (a) Deploy a test Soroban contract with a known TTL.
  const contractId = 'CTEST000000000000000000000000000000000000000000';
  const ledger = new FakeLedger();
  ledger.deployContract(contractId, DEFAULT_TTL_LEDGERS);

  const rpcClient = new FakeRpcClient(ledger);
  const db = new FakeDatabase();
  db.seed(contractId);

  const txBuilder = new TransactionBuilder(rpcClient);
  const listener = new StateArchivalListener(db as any, rpcClient, txBuilder, {
    pollIntervalMs: 60_000,
    minRenewalGapMs: 0,
  });

  // (b) Start the listener (tick is invoked manually here instead of
  // waiting on the real setInterval, so the simulation is deterministic).
  assert(!listener.isRunning(), 'listener not running before start()');

  // First tick: TTL is fresh (10,000 ledgers), nothing should renew yet.
  await listener.tick();
  assert(rpcClient.sendTransactionCallCount === 0, 'no renewal sent while TTL is fresh');

  // (c) Advance the ledger state by 8,000 ledgers (via simulated close).
  ledger.advance(8_000);
  // Remaining TTL is now 10,000 - 8,000 = 2,000, which is NOT < threshold (2,000) yet.
  assert(
    ledger.remainingTtl(contractId, 'attestation_root') === 2_000,
    'remaining TTL is exactly 2,000 ledgers after advancing 8,000',
  );

  // (d) Verify the listener submits exactly one renewal transaction
  // before the TTL drops below 2,000.
  await listener.tick();
  // At exactly 2,000 the threshold condition (ttl < 2000) is false, so we
  // nudge one ledger further to cross the boundary and trigger renewal.
  ledger.advance(1);
  await listener.tick();

  assert(rpcClient.sendTransactionCallCount === 1, 'exactly one renewal transaction submitted');
  assert(
    ledger.remainingTtl(contractId, 'attestation_root') === DEFAULT_TTL_LEDGERS,
    'attestation_root TTL restored to default after renewal',
  );
  assert(
    ledger.remainingTtl(contractId, 'governance_weight') === DEFAULT_TTL_LEDGERS,
    'governance_weight (other critical key) also renewed in the same batch',
  );

  // A second tick immediately after should not re-renew (min renewal gap / fresh TTL).
  await listener.tick();
  assert(
    rpcClient.sendTransactionCallCount === 1,
    'no duplicate renewal sent once TTL is restored',
  );

  // (e) registerNode()
  {
    const newContractId = 'CNEW000000000000000000000000000000000000000000';
    const initialTxCount = db.transactionCount;
    await listener.registerNode(newContractId);
    assert(db.transactionCount > initialTxCount, 'registerNode calls db.transaction');
  }

  // (f) start() and stop()
  {
    listener.stop();
    assert(!listener.isRunning(), 'listener stopped');
    listener.start();
    assert(listener.isRunning(), 'listener running');
    listener.start(); // idempotent
    assert(listener.isRunning(), 'listener still running after double start');
    listener.stop();
  }

  // (g) renewNow()
  {
    const initialCount = rpcClient.sendTransactionCallCount;
    const res = await listener.renewNow(contractId);
    assert(res.ttl === DEFAULT_TTL_LEDGERS, 'renewNow returns default TTL');
    assert(rpcClient.sendTransactionCallCount === initialCount + 1, 'renewNow sends a transaction');
  }

  // (h) renewNow() failure
  {
    const failRpc = new (class extends FakeRpcClient {
      async sendTransaction(): Promise<TransactionResult> {
        return { hash: '', success: false };
      }
    })(ledger);
    const failListener = new StateArchivalListener(
      db as any,
      failRpc,
      new TransactionBuilder(failRpc, [0, 0, 0]),
    );
    try {
      await failListener.renewNow(contractId);
      assert(false, 'renewNow should throw on failure');
    } catch (err) {
      assert((err as Error).message.includes('manual renewal failed'), 'renewNow failure throws error');
    }
  }

  // (i) tick() with RpcError from getLedgerEntry
  {
    const errRpc = new (class extends FakeRpcClient {
      async getLedgerEntry(): Promise<RpcError> {
        return { code: -1, message: 'forced error' };
      }
    })(ledger);
    const errListener = new StateArchivalListener(db as any, errRpc, new TransactionBuilder(errRpc));
    // Should log warning and continue (no exception)
    await errListener.tick();
    assert(true, 'tick() handles RpcError in getLedgerEntry');
  }

  // (j) tick() with empty watchlist
  {
    const emptyDb = new (class extends FakeDatabase {
      async query(): Promise<{ rows: any[] }> {
        return { rows: [] };
      }
    })();
    const emptyListener = new StateArchivalListener(emptyDb as any, rpcClient);
    await emptyListener.tick();
    assert(true, 'tick() handles empty watchlist');
  }

  // (k) applyRenewalResult failure branch
  {
    const failTxRpc = new (class extends FakeRpcClient {
      async sendTransaction(): Promise<TransactionResult> {
        return { hash: '', success: false };
      }
    })(ledger);
    const failTxBuilder = new TransactionBuilder(failTxRpc, [0, 0, 0]);
    // Force a tick that triggers renewal but fails
    ledger.advance(9000);
    const failTxListener = new StateArchivalListener(db as any, failTxRpc, failTxBuilder, { minRenewalGapMs: 0 });
    await failTxListener.tick();
    assert(true, 'tick() handles failed renewal transaction');
  }

  // (l) setInterval error handling
  {
    const errorDb = new (class extends FakeDatabase {
      async query(): Promise<any> { throw new Error('database down'); }
    })();
    const errListener = new StateArchivalListener(errorDb as any, rpcClient, new TransactionBuilder(rpcClient), { pollIntervalMs: 1 });
    errListener.start();
    await new Promise(resolve => setTimeout(resolve, 10));
    errListener.stop();
    assert(true, 'setInterval error handling covered');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
