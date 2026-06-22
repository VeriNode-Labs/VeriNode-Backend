import { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';

// ── Types ─────────────────────────────────────────────────────────────────────

export type PoolTier = 'oltp' | 'olap';

export interface DualPoolConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Default 70. Must not exceed DB max_connections minus olapMaxConnections. */
  oltpMaxConnections?: number;
  /** Default 30. */
  olapMaxConnections?: number;
  idleTimeoutMs?: number;
  /** How long to wait for an OLTP connection before spilling to OLAP (ms). Default 100. */
  spilloverWaitMs?: number;
}

export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

export interface PoolHealthSnapshot {
  oltp: PoolStats;
  olap: PoolStats;
}

// ── Classifier ────────────────────────────────────────────────────────────────

const ROUTE_RULES: ReadonlyArray<{ prefix: string; tier: PoolTier }> = [
  { prefix: '/api/v1/attestation', tier: 'oltp' },
  { prefix: '/api/v1/analytics', tier: 'olap' },
];

const QUERY_RULES: ReadonlyArray<{ pattern: RegExp; tier: PoolTier }> = [
  {
    // Short-window recent-heartbeat queries → OLTP
    pattern:
      /FROM\s+uptime_heartbeat\s+WHERE\s+time\s*>\s*NOW\s*\(\s*\)\s*-\s*INTERVAL\s*'1\s+hour'/i,
    tier: 'oltp',
  },
  {
    // Day-level aggregate scans → OLAP
    pattern: /GROUP\s+BY\s+node_id\s*,\s*date_trunc\s*\(\s*'day'/i,
    tier: 'olap',
  },
];

// Heuristic OLAP signals (applied only when no explicit rule matches)
const OLAP_HEURISTICS: ReadonlyArray<RegExp> = [
  /\buptime_hourly_agg\b/i,
  /\bGROUP\s+BY\b/i,
  /\bdate_trunc\s*\(/i,
];

/**
 * Classify a query as OLTP or OLAP.
 * Priority: route-prefix rules → query-text rules → heuristics → default OLTP.
 */
export function classifyQuery(route: string, queryText: string): PoolTier {
  for (const { prefix, tier } of ROUTE_RULES) {
    if (route.startsWith(prefix)) return tier;
  }
  for (const { pattern, tier } of QUERY_RULES) {
    if (pattern.test(queryText)) return tier;
  }
  for (const pattern of OLAP_HEURISTICS) {
    if (pattern.test(queryText)) return 'olap';
  }
  return 'oltp';
}

// ── Pool factory (injectable for tests) ───────────────────────────────────────

export type PoolFactory = (config: PoolConfig, tier: PoolTier) => Pool;

const defaultPoolFactory: PoolFactory = (config) => new Pool(config);

// ── Internal metrics ──────────────────────────────────────────────────────────

interface MetricsState {
  queryTimeoutTotal: Record<PoolTier, number>;
  /** Rolling window of query durations (connection wait + exec) in ms. */
  durationSamplesMs: Record<PoolTier, number[]>;
  spilloverTotal: number;
}

const SAMPLE_WINDOW = 200;

// ── PriorityRouter ────────────────────────────────────────────────────────────

export class PriorityRouter {
  readonly oltpPool: Pool;
  readonly olapPool: Pool;
  private readonly spilloverWaitMs: number;
  private readonly metrics: MetricsState = {
    queryTimeoutTotal: { oltp: 0, olap: 0 },
    durationSamplesMs: { oltp: [], olap: [] },
    spilloverTotal: 0,
  };

  constructor(
    config: DualPoolConfig,
    poolFactory: PoolFactory = defaultPoolFactory,
  ) {
    this.spilloverWaitMs = config.spilloverWaitMs ?? 100;

    const base: PoolConfig = {
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      idleTimeoutMillis: config.idleTimeoutMs ?? 30_000,
      application_name: 'verinode_backend',
    };

    this.oltpPool = poolFactory(
      { ...base, max: config.oltpMaxConnections ?? 70, statement_timeout: 500 },
      'oltp',
    );
    this.olapPool = poolFactory(
      { ...base, max: config.olapMaxConnections ?? 30, statement_timeout: 300_000 },
      'olap',
    );

    this.oltpPool.on('error', (err) =>
      console.error('[PriorityRouter] OLTP pool error:', err.message),
    );
    this.olapPool.on('error', (err) =>
      console.error('[PriorityRouter] OLAP pool error:', err.message),
    );
  }

  /**
   * Execute a query on the appropriate pool.
   * Pass `opts.route` or `opts.tier` to override auto-classification.
   * OLTP queries fall back to the OLAP pool if the OLTP pool is saturated
   * and the connection wait exceeds `spilloverWaitMs`.
   */
  async query<T extends QueryResultRow = any>(
    text: string,
    params?: any[],
    opts?: { route?: string; tier?: PoolTier },
  ): Promise<QueryResult<T>> {
    const tier = opts?.tier ?? classifyQuery(opts?.route ?? '', text);
    if (tier === 'olap') {
      return this._exec(this.olapPool, 'olap', text, params);
    }
    return this._execOltpWithSpillover(text, params);
  }

  /** Execute a transaction, always pinned to the OLTP pool. */
  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.oltpPool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /** Pool stats for the GET /health/pools response. */
  getPoolHealth(): PoolHealthSnapshot {
    return {
      oltp: snapshotPool(this.oltpPool),
      olap: snapshotPool(this.olapPool),
    };
  }

  /** Prometheus text-format metrics string for scraping. */
  prometheusMetrics(): string {
    const h = this.getPoolHealth();

    const avgWaitSec = (tier: PoolTier): string => {
      const samples = this.metrics.durationSamplesMs[tier];
      if (!samples.length) return '0';
      const avg = samples.reduce((a, b) => a + b, 0) / samples.length / 1_000;
      return avg.toFixed(6);
    };

    return [
      '# HELP pool_connections_used Number of active (non-idle) pool connections',
      '# TYPE pool_connections_used gauge',
      `pool_connections_used{pool="oltp"} ${h.oltp.total - h.oltp.idle}`,
      `pool_connections_used{pool="olap"} ${h.olap.total - h.olap.idle}`,
      '',
      '# HELP pool_wait_duration_seconds Rolling-average query duration in seconds (last 200 samples)',
      '# TYPE pool_wait_duration_seconds gauge',
      `pool_wait_duration_seconds{pool="oltp"} ${avgWaitSec('oltp')}`,
      `pool_wait_duration_seconds{pool="olap"} ${avgWaitSec('olap')}`,
      '',
      '# HELP pool_query_timeout_total Total statement timeout errors per pool',
      '# TYPE pool_query_timeout_total counter',
      `pool_query_timeout_total{pool="oltp"} ${this.metrics.queryTimeoutTotal.oltp}`,
      `pool_query_timeout_total{pool="olap"} ${this.metrics.queryTimeoutTotal.olap}`,
      '',
      '# HELP pool_spillover_total Total OLTP→OLAP spillover events',
      '# TYPE pool_spillover_total counter',
      `pool_spillover_total ${this.metrics.spilloverTotal}`,
    ].join('\n');
  }

  async close(): Promise<void> {
    await Promise.all([this.oltpPool.end(), this.olapPool.end()]);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async _exec<T extends QueryResultRow = any>(
    pool: Pool,
    tier: PoolTier,
    text: string,
    params?: any[],
  ): Promise<QueryResult<T>> {
    const t0 = performance.now();
    try {
      return await pool.query<T>(text, params);
    } catch (err) {
      if (isTimeoutError(err)) this.metrics.queryTimeoutTotal[tier]++;
      throw err;
    } finally {
      this._recordSample(tier, performance.now() - t0);
    }
  }

  /**
   * Try the OLTP pool; if no connection is available within `spilloverWaitMs`,
   * route to the OLAP pool and emit a warning.
   */
  private async _execOltpWithSpillover<T extends QueryResultRow = any>(
    text: string,
    params?: any[],
  ): Promise<QueryResult<T>> {
    // Fast path: idle connections are immediately available
    if (this.oltpPool.idleCount > 0) {
      return this._exec(this.oltpPool, 'oltp', text, params);
    }

    // Slow path: race connection acquisition against the spillover threshold
    const clientPromise = this.oltpPool.connect();
    const spillTimer = delay(this.spilloverWaitMs).then(() => null as null);

    const winner = await Promise.race([clientPromise, spillTimer]);

    if (winner === null) {
      // Spillover: release the pending OLTP client when it eventually arrives
      clientPromise.then((c) => c.release()).catch(() => {});
      this.metrics.spilloverTotal++;
      console.warn(
        `[PriorityRouter] OLTP connection wait exceeded ${this.spilloverWaitMs}ms; spilling to OLAP pool`,
      );
      return this._exec(this.olapPool, 'olap', text, params);
    }

    // Got a client in time — execute on OLTP
    const client = winner;
    const t0 = performance.now();
    try {
      return await client.query<T>(text, params);
    } catch (err) {
      if (isTimeoutError(err)) this.metrics.queryTimeoutTotal.oltp++;
      throw err;
    } finally {
      client.release();
      this._recordSample('oltp', performance.now() - t0);
    }
  }

  private _recordSample(tier: PoolTier, ms: number): void {
    const samples = this.metrics.durationSamplesMs[tier];
    samples.push(ms);
    if (samples.length > SAMPLE_WINDOW) samples.shift();
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function snapshotPool(pool: Pool): PoolStats {
  return {
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}

function isTimeoutError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /statement timeout|canceling statement due to statement timeout|query_timeout/i.test(msg);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Global singleton (mirrors the tracer bootstrap pattern in index.js) ───────

/**
 * Register a PriorityRouter so the /health/pools and /metrics Express routes
 * can reference it without direct module coupling.
 */
export function registerGlobalRouter(router: PriorityRouter): void {
  (global as any).__verinode_pools = router;
}

export function getGlobalRouter(): PriorityRouter | null {
  return (global as any).__verinode_pools ?? null;
}
