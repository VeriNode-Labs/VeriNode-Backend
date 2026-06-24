import { RpcClient, RpcClientConfig, TransactionResult, LedgerEntryData, RpcError } from '../../src/blockchain/rpc_client';

const __origFetch = globalThis.fetch;

function makeFetchMock(handler: (url: string, opts: any) => Promise<any>): void {
  (globalThis as any).fetch = async (url: string, opts: any) => handler(url, opts);
}

function restoreFetch(): void {
  (globalThis as any).fetch = __origFetch;
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

  console.log('\nRPC Client Tests\n');

  // ── sendTransaction: success path ─────────────────────────────────
  {
    let capturedBody: any = null;
    makeFetchMock(async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        json: async () => ({
          jsonrpc: '2.0',
          id: capturedBody.id,
          result: { hash: '0xabc123' },
        }),
      };
    });

    const client = new RpcClient({ endpoint: 'http://fake:8000', timeoutMs: 5000 });
    const result = await client.sendTransaction('AAAA...');
    assert(result.success === true, 'sendTransaction succeeds');
    assert(result.hash === '0xabc123', 'sendTransaction returns hash');
    assert(capturedBody.method === 'sendTransaction', 'RPC method is sendTransaction');
    assert(capturedBody.params.transaction === 'AAAA...', 'sends transaction param');
  }

  // ── sendTransaction: remote error ────────────────────────────────
  {
    makeFetchMock(async () => ({
      json: async () => ({
        jsonrpc: '2.0',
        id: '1',
        error: { code: -32603, message: 'Internal error' },
      }),
    }));

    const client = new RpcClient({ endpoint: 'http://fake:8000', timeoutMs: 5000 });
    const result = await client.sendTransaction('AAAA...');
    assert(result.success === false, 'sendTransaction fails on remote error');
    assert(result.error?.code === -32603, 'error code propagated');
    assert(result.error?.message === 'Internal error', 'error message propagated');
  }

  // ── sendTransaction: fetch throws ────────────────────────────────
  {
    makeFetchMock(async () => { throw new Error('network failure'); });

    const client = new RpcClient({ endpoint: 'http://fake:8000', timeoutMs: 5000 });
    const result = await client.sendTransaction('AAAA...');
    assert(result.success === false, 'sendTransaction returns error on network failure');
    assert(result.error?.code === -32000, 'network error code is -32000');
    assert(result.error?.message.includes('network failure'), 'network error message propagated');
  }

  // ── sendTransaction: abort (timeout) ─────────────────────────────
  {
    makeFetchMock(async (_url, opts) => {
      await new Promise((_, reject) => {
        opts.signal.addEventListener('abort', () => reject(new Error('Aborted')));
      });
    });

    const client = new RpcClient({ endpoint: 'http://fake:8000', timeoutMs: 1 });
    const result = await client.sendTransaction('AAAA...');
    assert(result.success === false, 'sendTransaction returns error on abort');
    assert(result.error?.code === -32000, 'abort error code is -32000');
  }

  // ── getLedgerEntry: success ──────────────────────────────────────
  {
    makeFetchMock(async () => ({
      json: async () => ({
        jsonrpc: '2.0',
        id: '1',
        result: {
          latestLedger: 50000,
          entries: [{
            liveUntilLedgerSeq: '52000',
            xdr: 'AAAA',
            lastModifiedLedgerSeq: '49000',
          }],
        },
      }),
    }));

    const client = new RpcClient({ endpoint: 'http://fake:8000', timeoutMs: 5000 });
    const entry = await client.getLedgerEntry('CTEST...', 'attestation_root');
    assert(!('code' in entry), 'getLedgerEntry returns LedgerEntryData');
    const data = entry as LedgerEntryData;
    assert(data.ttl === 2000, 'TTL computed correctly (52000 - 50000)');
    assert(data.xdr === 'AAAA', 'XDR value passed through');
    assert(data.lastModifiedLedgerSeq === 49000, 'lastModifiedLedgerSeq correct');
  }

  // ── getLedgerEntry: remote error ─────────────────────────────────
  {
    makeFetchMock(async () => ({
      json: async () => ({
        jsonrpc: '2.0',
        id: '1',
        error: { code: -32602, message: 'Invalid params' },
      }),
    }));

    const client = new RpcClient({ endpoint: 'http://fake:8000', timeoutMs: 5000 });
    const result = await client.getLedgerEntry('CTEST...', 'attestation_root');
    assert('code' in result, 'returns RpcError on remote error');
    assert((result as RpcError).code === -32602, 'error code propagated');
  }

  // ── getLedgerEntry: no entry found ──────────────────────────────
  {
    makeFetchMock(async () => ({
      json: async () => ({
        jsonrpc: '2.0',
        id: '1',
        result: { latestLedger: 100, entries: [] },
      }),
    }));

    const client = new RpcClient({ endpoint: 'http://fake:8000', timeoutMs: 5000 });
    const result = await client.getLedgerEntry('CTEST...', 'nonexistent');
    assert('code' in result, 'returns RpcError when no entry');
    assert((result as RpcError).code === -32001, 'no-entry error code is -32001');
  }

  // ── getLedgerEntry: fetch throws ─────────────────────────────────
  {
    makeFetchMock(async () => { throw new Error('timeout'); });

    const client = new RpcClient({ endpoint: 'http://fake:8000', timeoutMs: 5000 });
    const result = await client.getLedgerEntry('CTEST...', 'attestation_root');
    assert('code' in result, 'returns RpcError on fetch error');
    assert((result as RpcError).code === -32000, 'fetch error code is -32000');
  }

  restoreFetch();

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('rpc_client.test.ts crashed:', err);
  process.exit(1);
});
