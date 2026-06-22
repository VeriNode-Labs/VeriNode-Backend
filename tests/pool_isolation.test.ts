import { QueryResult, QueryResultRow, PoolConfig } from 'pg';
import {
  PriorityRouter,
  classifyQuery,
  PoolTier,
  PoolFactory,
  PoolStats,
} from '../src/database/pool_isolation';

// =============================================================================
// MockPool — simulates pg.Pool with configurable per-query delay and capacity
// =============================================================================

class MockPool {
  private readonly maxConns: number;
  private readonly queryDelayMs: number;
  private activeConns = 0;
  private _peakTotal = 0;

  constructor(maxConns: number, queryDelayMs: number) {
    this.maxConns = maxConns;
    this.queryDelayMs = queryDelayMs;
  }

  async query<T extends QueryResultRow = any>(
    _text: string,
    _params?: any[],
  ): Promise<QueryResult<T>> {
    this.activeConns++;
    this._peakTotal = Math.max(this._peakTotal, this.activeConns);
    try {
      await sleep(this.queryDelayMs);
      return emptyResult<T>();
    } finally {
      this.activeConns--;
    }
  }

  async connect(): Promise<{ query: any; release: () => void }> {
    // Block until a slot is free (simulates queue)
    while (this.activeConns >= this.maxConns) {
      await sleep(1);
    }
    this.activeConns++;
    this._peakTotal = Math.max(this._peakTotal, this.activeConns);
    return {
      query: async <T extends QueryResultRow = any>(
        _text: string,
        _params?: any[],
      ): Promise<QueryResult<T>> => {
        await sleep(this.queryDelayMs);
        return emptyResult<T>();
      },
      release: () => {
        this.activeConns = Math.max(0, this.activeConns - 1);
      },
    };
  }

  end = async (): Promise<void> => {};
  on = (_event: string, _fn: any): this => this;
  removeListener = (_event: string, _fn: any): this => this;

  get idleCount(): number {
    return Math.max(0, this.maxConns - this.activeConns);
  }
  get totalCount(): number {
    return this._peakTotal;
  }
  get waitingCount(): number {
    return Math.max(0, this.activeConns - this.maxConns);
  }

  peakConnections(): number {
    return this._peakTotal;
  }
}

// =============================================================================
// Helpers
// =============================================================================

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function emptyResult<T extends QueryResultRow = any>(): QueryResult<T> {
  return { rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] } as unknown as QueryResult<T>;
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}

function makeMockFactory(
  oltpPool: MockPool,
  olapPool: MockPool,
): PoolFactory {
  return (_config: PoolConfig, tier: PoolTier) =>
    (tier === 'oltp' ? oltpPool : olapPool) as any;
}

const DUMMY_CONFIG = {
  host: 'localhost',
  port: 5432,
  user: 'test',
  password: 'test',
  database: 'test',
};

// =============================================================================
// Test runner
// =============================================================================

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

  console.log('\nPool Isolation Tests\n');

  // ---------------------------------------------------------------------------
  // Section 1: classifyQuery — route-prefix rules
  // ---------------------------------------------------------------------------
  console.log('  classifyQuery — route rules');

  assert(
    classifyQuery('/api/v1/attestation/submit', 'INSERT INTO x') === 'oltp',
    'attestation route → OLTP',
  );
  assert(
    classifyQuery('/api/v1/analytics/report', 'SELECT * FROM y') === 'olap',
    'analytics route → OLAP',
  );
  assert(
    classifyQuery('/api/v1/attestation/status', 'SELECT COUNT(*) GROUP BY date_trunc(\'day\', time)') === 'oltp',
    'attestation route overrides OLAP query heuristic',
  );

  // ---------------------------------------------------------------------------
  // Section 2: classifyQuery — query-text rules
  // ---------------------------------------------------------------------------
  console.log('  classifyQuery — query-text rules');

  assert(
    classifyQuery(
      '',
      "SELECT time, node_id FROM uptime_heartbeat WHERE time > NOW() - INTERVAL '1 hour'",
    ) === 'oltp',
    'recent-heartbeat query → OLTP',
  );
  assert(
    classifyQuery(
      '',
      "SELECT node_id, date_trunc('day', time) FROM uptime_heartbeat GROUP BY node_id, date_trunc('day', time)",
    ) === 'olap',
    'day-level aggregate → OLAP',
  );

  // ---------------------------------------------------------------------------
  // Section 3: classifyQuery — heuristics and default
  // ---------------------------------------------------------------------------
  console.log('  classifyQuery — heuristics & default');

  assert(
    classifyQuery('', 'SELECT * FROM uptime_hourly_agg WHERE bucket >= $1') === 'olap',
    'uptime_hourly_agg → OLAP (heuristic)',
  );
  assert(
    classifyQuery('', 'SELECT node_id, COUNT(*) FROM events GROUP BY node_id') === 'olap',
    'GROUP BY → OLAP (heuristic)',
  );
  assert(
    classifyQuery('', "SELECT date_trunc('hour', time) FROM uptime_heartbeat") === 'olap',
    'date_trunc → OLAP (heuristic)',
  );
  assert(
    classifyQuery('', 'INSERT INTO uptime_heartbeat VALUES ($1, $2, $3)') === 'oltp',
    'bare INSERT → default OLTP',
  );
  assert(
    classifyQuery('', 'UPDATE slashing_events SET status = $1 WHERE id = $2') === 'oltp',
    'UPDATE → default OLTP',
  );

  // ---------------------------------------------------------------------------
  // Section 4: PriorityRouter — query routing
  // ---------------------------------------------------------------------------
  console.log('  PriorityRouter — routing');

  {
    const oltpPool = new MockPool(70, 1);
    const olapPool = new MockPool(30, 1);
    const router = new PriorityRouter(DUMMY_CONFIG, makeMockFactory(oltpPool, olapPool));

    // OLTP query uses oltpPool
    await router.query('INSERT INTO uptime_heartbeat VALUES ($1)', ['now']);
    assert(oltpPool.peakConnections() > 0, 'OLTP query routed to OLTP pool');
    assert(olapPool.peakConnections() === 0, 'OLTP query does not touch OLAP pool');

    await router.close();
  }

  {
    const oltpPool = new MockPool(70, 1);
    const olapPool = new MockPool(30, 1);
    const router = new PriorityRouter(DUMMY_CONFIG, makeMockFactory(oltpPool, olapPool));

    // OLAP query uses olapPool
    await router.query(
      "SELECT node_id, date_trunc('day', time) FROM uptime_hourly_agg GROUP BY node_id, date_trunc('day', time)",
    );
    assert(olapPool.peakConnections() > 0, 'OLAP query routed to OLAP pool');
    assert(oltpPool.peakConnections() === 0, 'OLAP query does not touch OLTP pool');

    await router.close();
  }

  {
    const oltpPool = new MockPool(70, 1);
    const olapPool = new MockPool(30, 1);
    const router = new PriorityRouter(DUMMY_CONFIG, makeMockFactory(oltpPool, olapPool));

    // Explicit tier override: force OLAP classification on an INSERT
    await router.query('INSERT INTO big_table SELECT * FROM source', [], { tier: 'olap' });
    assert(olapPool.peakConnections() > 0, 'explicit tier=olap override respected');
    assert(oltpPool.peakConnections() === 0, 'explicit tier=olap override avoids OLTP pool');

    await router.close();
  }

  // ---------------------------------------------------------------------------
  // Section 5: PriorityRouter — transaction always goes to OLTP
  // ---------------------------------------------------------------------------
  console.log('  PriorityRouter — transaction isolation');

  {
    const oltpPool = new MockPool(70, 1);
    const olapPool = new MockPool(30, 1);
    const router = new PriorityRouter(DUMMY_CONFIG, makeMockFactory(oltpPool, olapPool));

    await router.transaction(async (client) => {
      await client.query('INSERT INTO uptime_heartbeat VALUES ($1)', ['now']);
    });

    assert(oltpPool.peakConnections() > 0, 'transaction uses OLTP pool');
    assert(olapPool.peakConnections() === 0, 'transaction does not use OLAP pool');

    await router.close();
  }

  // ---------------------------------------------------------------------------
  // Section 6: PriorityRouter — health snapshot
  // ---------------------------------------------------------------------------
  console.log('  PriorityRouter — pool health snapshot');

  {
    const oltpPool = new MockPool(70, 5);
    const olapPool = new MockPool(30, 5);
    const router = new PriorityRouter(DUMMY_CONFIG, makeMockFactory(oltpPool, olapPool));

    // Fire a query but don't await it so the pool is still active
    const pendingOltp = router.query('INSERT INTO uptime_heartbeat VALUES ($1)', ['now']);
    const pendingOlap = router.query(
      'SELECT node_id FROM uptime_hourly_agg GROUP BY node_id',
    );

    await sleep(1); // let them start

    const health = router.getPoolHealth();
    assert(typeof health.oltp.total === 'number', 'health.oltp.total is a number');
    assert(typeof health.oltp.idle === 'number', 'health.oltp.idle is a number');
    assert(typeof health.oltp.waiting === 'number', 'health.oltp.waiting is a number');
    assert(typeof health.olap.total === 'number', 'health.olap.total is a number');

    await Promise.all([pendingOltp, pendingOlap]);
    await router.close();
  }

  // ---------------------------------------------------------------------------
  // Section 7: PriorityRouter — Prometheus metrics format
  // ---------------------------------------------------------------------------
  console.log('  PriorityRouter — Prometheus metrics');

  {
    const router = new PriorityRouter(
      DUMMY_CONFIG,
      makeMockFactory(new MockPool(70, 1), new MockPool(30, 1)),
    );

    await router.query('INSERT INTO uptime_heartbeat VALUES ($1)', ['now']);
    await router.query('SELECT node_id FROM uptime_hourly_agg GROUP BY node_id');

    const metrics = router.prometheusMetrics();
    assert(metrics.includes('pool_connections_used{pool="oltp"}'), 'metrics include oltp connections_used');
    assert(metrics.includes('pool_connections_used{pool="olap"}'), 'metrics include olap connections_used');
    assert(metrics.includes('pool_wait_duration_seconds{pool="oltp"}'), 'metrics include oltp wait_duration');
    assert(metrics.includes('pool_wait_duration_seconds{pool="olap"}'), 'metrics include olap wait_duration');
    assert(metrics.includes('pool_query_timeout_total{pool="oltp"}'), 'metrics include oltp timeout_total');
    assert(metrics.includes('pool_query_timeout_total{pool="olap"}'), 'metrics include olap timeout_total');
    assert(metrics.includes('pool_spillover_total'), 'metrics include spillover_total');

    await router.close();
  }

  // ---------------------------------------------------------------------------
  // Section 8: PriorityRouter — spillover when OLTP saturated
  // ---------------------------------------------------------------------------
  console.log('  PriorityRouter — OLTP→OLAP spillover');

  {
    // OLTP pool: 1 connection, 200ms delay (guaranteed saturation)
    // OLAP pool: 10 connections, 1ms delay
    // Spillover threshold: 50ms
    const oltpPool = new MockPool(1, 200);
    const olapPool = new MockPool(10, 1);
    const router = new PriorityRouter(
      { ...DUMMY_CONFIG, spilloverWaitMs: 50 },
      makeMockFactory(oltpPool, olapPool),
    );

    // Saturate the OLTP pool
    const saturator = router.query('INSERT INTO uptime_heartbeat VALUES ($1)', ['saturate']);

    // Wait briefly so the saturation query is holding the only OLTP connection
    await sleep(10);

    // This OLTP query should spill to OLAP since OLTP is saturated and wait >50ms
    const t0 = performance.now();
    await router.query('INSERT INTO uptime_heartbeat VALUES ($1)', ['spilled']);
    const elapsed = performance.now() - t0;

    await saturator;

    const health = router.getPoolHealth();
    // After spillover, olapPool must have been used
    assert(olapPool.peakConnections() > 0, 'spillover query hit OLAP pool');
    // The spilled query should complete quickly (OLAP pool is fast)
    assert(elapsed < 150, `spilled query resolved quickly (${elapsed.toFixed(1)}ms)`);

    await router.close();
  }

  // ---------------------------------------------------------------------------
  // Section 9: Load test — dual-pool isolation under concurrent OLAP load
  //
  // Simulates the scenario from the issue:
  //   10 concurrent heavy OLAP scans + high-throughput OLTP writes.
  // With dual pools, OLTP P99 must stay under 50ms and zero writes must fail.
  // ---------------------------------------------------------------------------
  console.log('  Load test — dual-pool isolation');

  {
    const OLAP_QUERY_DELAY_MS = 80;  // heavy scan simulation
    const OLTP_QUERY_DELAY_MS = 1;   // fast write simulation
    const CONCURRENT_OLAP = 10;
    const OLTP_WRITE_COUNT = 200;    // drive 200 OLTP writes concurrently

    const oltpPool = new MockPool(70, OLTP_QUERY_DELAY_MS);
    const olapPool = new MockPool(30, OLAP_QUERY_DELAY_MS);
    const router = new PriorityRouter(DUMMY_CONFIG, makeMockFactory(oltpPool, olapPool));

    // Start heavy OLAP scans (hold connections for 80ms each)
    const olapTasks = Array.from({ length: CONCURRENT_OLAP }, () =>
      router.query(
        "SELECT node_id, date_trunc('day', time), COUNT(*) FROM uptime_hourly_agg GROUP BY node_id, date_trunc('day', time)",
        [],
        { tier: 'olap' },
      ),
    );

    // Give OLAP tasks a moment to acquire connections
    await sleep(5);

    // Drive OLTP writes concurrently while OLAP is active
    const oltpLatencies: number[] = [];
    const oltpErrors: string[] = [];

    const oltpTasks = Array.from({ length: OLTP_WRITE_COUNT }, async () => {
      const t0 = performance.now();
      try {
        await router.query(
          'INSERT INTO uptime_heartbeat (time, node_id, latency_ms, status, uptime_pct) VALUES ($1, $2, $3, $4, $5)',
          [new Date().toISOString(), 'load-test-node', 5, 'up', 100],
          { tier: 'oltp' },
        );
        oltpLatencies.push(performance.now() - t0);
      } catch (err) {
        oltpErrors.push((err as Error).message);
      }
    });

    await Promise.all([...olapTasks, ...oltpTasks]);
    await router.close();

    const sortedLatencies = [...oltpLatencies].sort((a, b) => a - b);
    const p50 = percentile(sortedLatencies, 0.5);
    const p99 = percentile(sortedLatencies, 0.99);

    assert(oltpErrors.length === 0, `zero OLTP write failures (got ${oltpErrors.length})`);
    assert(
      p99 < 50,
      `OLTP P99 latency < 50ms under OLAP load (actual: ${p99.toFixed(2)}ms)`,
    );
    assert(
      olapPool.peakConnections() > 0,
      `OLAP pool was used for heavy scans (peak: ${olapPool.peakConnections()} conns)`,
    );
    assert(
      oltpPool.peakConnections() > 0,
      `OLTP pool served writes independently (peak: ${oltpPool.peakConnections()} conns)`,
    );

    console.log(
      `    → OLTP P50: ${p50.toFixed(2)}ms  P99: ${p99.toFixed(2)}ms` +
      `  OLAP peak conns: ${olapPool.peakConnections()}` +
      `  OLTP peak conns: ${oltpPool.peakConnections()}`,
    );
  }

  // ---------------------------------------------------------------------------
  // Results
  // ---------------------------------------------------------------------------

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
