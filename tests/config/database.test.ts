import { Database, DatabaseConfig, QueryMetrics, QueryHandler } from '../../src/config/database';

function makeMockPool() {
  let queryCallCount = 0;
  let connectCallCount = 0;
  let endCallCount = 0;
  let lastQueryText = '';
  let lastQueryParams: any[] | undefined;
  let failNext = false;

  return {
    query: async (text: string, params?: any[]) => {
      queryCallCount++;
      lastQueryText = text;
      lastQueryParams = params;
      if (failNext && text !== 'SELECT 1') {
        failNext = false;
        throw new Error('simulated pool error');
      }
      return { rows: [], rowCount: text === 'SELECT 1' ? 1 : 0, command: '', oid: 0, fields: [] };
    },
    connect: async () => {
      connectCallCount++;
      return {
        query: async (text: string, params?: any[]) => {
          lastQueryText = text;
          lastQueryParams = params;
          return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] };
        },
        release: () => {},
      };
    },
    end: async () => { endCallCount++; },
    on: () => {},
    idleCount: 5,
    totalCount: 10,
    waitingCount: 0,
    _queryCallCount: () => queryCallCount,
    _connectCallCount: () => connectCallCount,
    _endCallCount: () => endCallCount,
    _lastQueryText: () => lastQueryText,
    _lastQueryParams: () => lastQueryParams,
    _setFailNext: () => { failNext = true; },
  };
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

  console.log('\nDatabase Config Tests\n');

  // ── query: successful execution ───────────────────────────────────
  {
    const mockPool = makeMockPool();
    const db = new Database({ host: 'localhost', port: 5432, user: 'u', password: 'p', database: 'd' });
    (db as any).pool = mockPool;

    const result = await db.query('SELECT 1');
    assert(result.rowCount === 1, 'query returns result');
    assert(mockPool._queryCallCount() >= 1, 'pool.query was called');
  }

  // ── query: onQueryComplete handler is called ──────────────────────
  {
    const mockPool = makeMockPool();
    const db = new Database({ host: 'localhost', port: 5432, user: 'u', password: 'p', database: 'd' });
    (db as any).pool = mockPool;

    let capturedMetric: QueryMetrics | null = null;
    db.setQueryHandler((metric) => { capturedMetric = metric; });

    await db.query('SELECT NOW()');
    assert(capturedMetric !== null, 'query handler was called');
    assert(capturedMetric!.success === true, 'handler records success');
    assert(capturedMetric!.query === 'SELECT NOW()', 'handler records query text');
    assert(typeof capturedMetric!.durationMs === 'number', 'handler records duration');
  }

  // ── query: error path increments totalErrors ──────────────────────
  {
    const mockPool = makeMockPool();
    const db = new Database({ host: 'localhost', port: 5432, user: 'u', password: 'p', database: 'd' });
    (db as any).pool = mockPool;
    mockPool._setFailNext();

    try {
      await db.query('SELECT * FROM nonexistent');
      assert(false, 'should throw on pool error');
    } catch (err) {
      assert((err as Error).message === 'simulated pool error', 'propagates pool error');
      const metrics = db.getMetrics();
      assert(metrics.totalErrors === 1, 'error increments totalErrors');
    }
  }

  // ── query: handler called on error ────────────────────────────────
  {
    const mockPool = makeMockPool();
    const db = new Database({ host: 'localhost', port: 5432, user: 'u', password: 'p', database: 'd' });
    (db as any).pool = mockPool;

    let capturedMetric: QueryMetrics | null = null;
    db.setQueryHandler((metric) => { capturedMetric = metric; });
    mockPool._setFailNext();

    try {
      await db.query('SELECT * FROM bad');
    } catch {}
    assert(capturedMetric !== null, 'handler called even on error');
    assert(capturedMetric!.success === false, 'handler records failure');
  }

  // ── healthCheck: returns true when pool responds ──────────────────
  {
    const mockPool = makeMockPool();
    const db = new Database({ host: 'localhost', port: 5432, user: 'u', password: 'p', database: 'd' });
    (db as any).pool = mockPool;

    const healthy = await db.healthCheck();
    assert(healthy === true, 'healthCheck returns true');
    assert(mockPool._lastQueryText().includes('SELECT 1'), 'healthCheck runs SELECT 1');
  }

  // ── healthCheck: returns false on error ───────────────────────────
  {
    const mockPool = makeMockPool();
    const db = new Database({ host: 'localhost', port: 5432, user: 'u', password: 'p', database: 'd' });
    (db as any).pool = {
      ...mockPool,
      query: async () => { throw new Error('db down'); },
    };

    const healthy = await db.healthCheck();
    assert(healthy === false, 'healthCheck returns false on error');
  }

  // ── close: calls pool.end ─────────────────────────────────────────
  {
    const mockPool = makeMockPool();
    const db = new Database({ host: 'localhost', port: 5432, user: 'u', password: 'p', database: 'd' });
    (db as any).pool = mockPool;

    await db.close();
    assert(mockPool._endCallCount() >= 1, 'close calls pool.end');
  }

  // ── transaction: commits on success ──────────────────────────────
  {
    const mockPool = makeMockPool();
    const db = new Database({ host: 'localhost', port: 5432, user: 'u', password: 'p', database: 'd' });
    (db as any).pool = mockPool;

    const result = await db.transaction(async (client) => {
      await client.query('INSERT INTO test VALUES (1)');
      return 'done';
    });
    assert(result === 'done', 'transaction returns handler result');
    assert(mockPool._connectCallCount() >= 1, 'transaction connects');
  }

  // ── getMetrics: returns pool stats ────────────────────────────────
  {
    const mockPool = makeMockPool();
    const db = new Database({ host: 'localhost', port: 5432, user: 'u', password: 'p', database: 'd' });
    (db as any).pool = mockPool;

    const metrics = db.getMetrics();
    assert(metrics.totalQueries >= 0, 'getMetrics returns totalQueries');
    assert(metrics.idleCount === 5, 'getMetrics returns idleCount from pool');
    assert(metrics.totalCount === 10, 'getMetrics returns totalCount from pool');
    assert(metrics.waitingCount === 0, 'getMetrics returns waitingCount from pool');
  }

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('database.test.ts crashed:', err);
  process.exit(1);
});
