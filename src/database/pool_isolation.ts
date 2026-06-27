import { Pool, PoolClient, PoolConfig, QueryResult, QueryResultRow } from 'pg';
import { createLogger } from '../diagnostics/logger';

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
  adaptiveScaling?: AdaptivePoolConfig;
}

export interface PoolStats {
  total: number;
  idle: number;
  waiting: number;
}

export interface AdaptivePoolConfig {
  enabled?: boolean;
  probeIntervalMs?: number;
  minConnections?: number;
  maxConnections?: number;
  adjustmentStep?: number;
  latencyThresholdMs?: number;
  waitThresholdMs?: number;
  cooldownMs?: number;
  kp?: number;
  ki?: number;
  kd?: number;
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
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}

function average(values: number[]): number {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function getPoolMax(pool: Pool): number {
  const optionsMax = (pool as any)?.options?.max;
  if (typeof optionsMax === 'number' && !Number.isNaN(optionsMax)) return optionsMax;
  return 1;
}

function setPoolMax(pool: Pool, maxConnections: number): void {
  if ((pool as any)?.options) {
    (pool as any).options.max = maxConnections;
  }
  if (typeof (pool as any).setMaxConnections === 'function') {
    (pool as any).setMaxConnections(maxConnections);
  }
}

class AdaptivePoolProbe {
  private readonly pool: Pool;
  private readonly tier: PoolTier;
  private readonly config: Required<AdaptivePoolConfig>;
  private readonly durationSamplesMs: number[] = [];
  private readonly waitSamplesMs: number[] = [];
  private readonly utilizationSamples: number[] = [];
  private interval: NodeJS.Timeout | null = null;
  private lastAdjustmentDirection: number | null = null;
  private lastAdjustmentAt = 0;
  private integral = 0;
  private previousError = 0;
  private targetConnections: number;

  constructor(pool: Pool, tier: PoolTier, config?: AdaptivePoolConfig) {
    this.pool = pool;
    this.tier = tier;
    this.config = {
      enabled: true,
      probeIntervalMs: 10_000,
      minConnections: 5,
      maxConnections: 200,
      adjustmentStep: 5,
      latencyThresholdMs: 100,
      waitThresholdMs: 50,
      cooldownMs: 60_000,
      kp: 1.0,
      ki: 0.1,
      kd: 0.05,
      ...config,
    };
    this.targetConnections = this.clamp(getPoolMax(pool));
  }

  start(): void {
    if (!this.config.enabled) return;
    if (this.interval) return;
    this.interval = setInterval(() => this.evaluate(), this.config.probeIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  recordSample(durationMs: number, waitMs: number, utilization: number): void {
    this.durationSamplesMs.push(durationMs);
    if (this.durationSamplesMs.length > SAMPLE_WINDOW) this.durationSamplesMs.shift();

    this.waitSamplesMs.push(waitMs);
    if (this.waitSamplesMs.length > SAMPLE_WINDOW) this.waitSamplesMs.shift();

    this.utilizationSamples.push(utilization);
    if (this.utilizationSamples.length > SAMPLE_WINDOW) this.utilizationSamples.shift();
  }

  prometheusMetrics(): string {
    return [
      `# HELP pool_max_connections Current configured maximum connections for the pool`,
      '# TYPE pool_max_connections gauge',
      `pool_max_connections{pool="${this.tier}"} ${getPoolMax(this.pool)}`,
      '',
      `# HELP pool_target_connections Adaptive target max-connections computed by the health probe`,
      '# TYPE pool_target_connections gauge',
      `pool_target_connections{pool="${this.tier}"} ${this.targetConnections}`,
      '',
    ].join('\n');
  }

  private evaluate(): void {
    if (!this.durationSamplesMs.length || !this.utilizationSamples.length) return;

    const durationP95 = percentile([...this.durationSamplesMs].sort((a, b) => a - b), 0.95);
    const waitP90 = percentile([...this.waitSamplesMs].sort((a, b) => a - b), 0.9);
    const utilization = average(this.utilizationSamples);

    const latencyError = (durationP95 - this.config.latencyThresholdMs) / this.config.latencyThresholdMs;
    const waitError = (waitP90 - this.config.waitThresholdMs) / this.config.waitThresholdMs;
    const error = Math.max(latencyError, waitError);

    const dt = this.config.probeIntervalMs / 1000;
    this.integral += error * dt;
    const derivative = (error - this.previousError) / dt;
    this.previousError = error;
    const pid = this.config.kp * error + this.config.ki * this.integral + this.config.kd * derivative;

    const now = Date.now();
    const desiredStep = Math.sign(pid) * this.config.adjustmentStep;
    const currentMax = getPoolMax(this.pool);
    let nextMax = currentMax;
    let nextDirection = 0;

    if (pid > 0.2) {
      nextDirection = 1;
      if (this.canAdjust(1, now)) {
        nextMax = this.clamp(currentMax + this.config.adjustmentStep);
      }
    } else if (pid < -0.2 && durationP95 < this.config.latencyThresholdMs && waitP90 < this.config.waitThresholdMs && utilization < 0.6) {
      nextDirection = -1;
      if (this.canAdjust(-1, now)) {
        nextMax = this.clamp(currentMax - this.config.adjustmentStep);
      }
    }

    if (nextMax !== currentMax) {
      this.targetConnections = nextMax;
      setPoolMax(this.pool, nextMax);
      this.lastAdjustmentDirection = nextDirection;
      this.lastAdjustmentAt = now;
    }
  }

  private canAdjust(direction: number, now: number): boolean {
    if (this.lastAdjustmentDirection !== direction) return true;
    return now - this.lastAdjustmentAt >= this.config.cooldownMs;
  }

  private clamp(maxConnections: number): number {
    return Math.min(this.config.maxConnections, Math.max(this.config.minConnections, maxConnections));
  }
}
// ── PriorityRouter ────────────────────────────────────────────────────────────

export class PriorityRouter {
  readonly oltpPool: Pool;
  readonly olapPool: Pool;
  private readonly spilloverWaitMs: number;
  private readonly oltpProbe: AdaptivePoolProbe;
  private readonly olapProbe: AdaptivePoolProbe;
  private log = createLogger('pool_isolation', { 'db.system': 'postgresql' });
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

    this.oltpProbe = new AdaptivePoolProbe(this.oltpPool, 'oltp', config.adaptiveScaling);
    this.olapProbe = new AdaptivePoolProbe(this.olapPool, 'olap', config.adaptiveScaling);
    this.oltpProbe.start();
    this.olapProbe.start();

    this.oltpPool.on('error', (err) =>
      this.log.error('OLTP pool error', { 'pool.tier': 'oltp', 'error.message': err.message }),
    );
    this.olapPool.on('error', (err) =>
      this.log.error('OLAP pool error', { 'pool.tier': 'olap', 'error.message': err.message }),
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
      '',
      this.oltpProbe.prometheusMetrics(),
      this.olapProbe.prometheusMetrics(),
    ].join('\n');
  }

  async close(): Promise<void> {
    this.oltpProbe.stop();
    this.olapProbe.stop();
    await Promise.all([this.oltpPool.end(), this.olapPool.end()]);
  }

  // ── Private ──────────────────────────────────────────────────────────────

  private async _exec<T extends QueryResultRow = any>(
    pool: Pool,
    tier: PoolTier,
    text: string,
    params?: any[],
  ): Promise<QueryResult<T>> {
    const waitStart = performance.now();
    const client = await pool.connect();
    const waitMs = performance.now() - waitStart;
    const execStart = performance.now();

    try {
      const result = await client.query<T>(text, params);
      return result;
    } catch (err) {
      if (isTimeoutError(err)) this.metrics.queryTimeoutTotal[tier]++;
      throw err;
    } finally {
      const durationMs = performance.now() - execStart;
      const utilization = this.calculateUtilization(pool);
      this._recordSample(tier, durationMs, waitMs, utilization);
      client.release();
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
    const waitStart = performance.now();
    const clientPromise = this.oltpPool.connect();
    const spillTimer = delay(this.spilloverWaitMs).then(() => null as null);

    const winner = await Promise.race([clientPromise, spillTimer]);

    if (winner === null) {
      // Spillover: release the pending OLTP client when it eventually arrives
      clientPromise.then((c) => c.release()).catch(() => {});
      this.metrics.spilloverTotal++;
      this.log.warn('OLTP connection wait exceeded threshold; spilling to OLAP pool', {
        'pool.tier': 'oltp',
        'pool.spillover_wait_ms': this.spilloverWaitMs,
      });
      return this._exec(this.olapPool, 'olap', text, params);
    }

    // Got a client in time — execute on OLTP
    const client = winner;
    const waitMs = performance.now() - waitStart;
    const execStart = performance.now();
    try {
      return await client.query<T>(text, params);
    } catch (err) {
      if (isTimeoutError(err)) this.metrics.queryTimeoutTotal.oltp++;
      throw err;
    } finally {
      const durationMs = performance.now() - execStart;
      const utilization = this.calculateUtilization(this.oltpPool);
      this._recordSample('oltp', durationMs, waitMs, utilization);
      client.release();
    }
  }

  private calculateUtilization(pool: Pool): number {
    const max = getPoolMax(pool);
    if (!max) return 0;
    return (pool.totalCount - pool.idleCount) / max;
  }

  private _recordSample(tier: PoolTier, ms: number, waitMs: number, utilization: number): void {
    const samples = this.metrics.durationSamplesMs[tier];
    samples.push(ms);
    if (samples.length > SAMPLE_WINDOW) samples.shift();

    const probe = tier === 'oltp' ? this.oltpProbe : this.olapProbe;
    probe.recordSample(ms, waitMs, utilization);
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
