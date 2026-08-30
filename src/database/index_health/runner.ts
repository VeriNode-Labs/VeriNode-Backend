/**
 * VeriNode Backend — DB Index Health Monitoring: scheduled runner (issue #197)
 *
 * Follows the in-process scheduling convention of ConfigDriftAuditor: a
 * `runOnce()` core, plus `start()` / `stop()` that wrap it in an unref'd
 * `setInterval`. The desired off-peak *daily* cadence is also recorded as a
 * guarded pg_cron marker in migration 015 (the backup_verification pattern);
 * "off-peak" is configurable, never hard-coded — see VERINODE_INDEX_HEALTH_CRON.
 */

import { StructuredLogger, createLogger } from '../../diagnostics/logger';
import { IndexHealthAnalyzer } from './analyzer';
import { persistIndexHealthRun } from './store';
import {
  DEFAULT_INDEX_HEALTH_THRESHOLDS,
  IndexHealthRun,
  IndexHealthThresholds,
  TransactionCapable,
} from './types';

/** One day. The analyzer is cheap (catalog reads) so a daily cadence is ample. */
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Off-peak default: 03:30 UTC daily. Matches 011_backup_verification.sql's style. */
export const DEFAULT_INDEX_HEALTH_CRON = '30 3 * * *';

export interface IndexHealthMonitorOptions {
  db: TransactionCapable;
  thresholds?: Partial<IndexHealthThresholds>;
  intervalMs?: number;
  /** Informational: the intended DB-side off-peak cadence, surfaced in logs. */
  cronExpression?: string;
  logger?: StructuredLogger;
  now?: () => Date;
}

export class IndexHealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastRun: IndexHealthRun | null = null;
  private readonly db: TransactionCapable;
  private readonly analyzer: IndexHealthAnalyzer;
  private readonly intervalMs: number;
  private readonly cronExpression: string;
  private readonly log: StructuredLogger;

  constructor(options: IndexHealthMonitorOptions) {
    this.db = options.db;
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.cronExpression = options.cronExpression ?? DEFAULT_INDEX_HEALTH_CRON;
    this.log = options.logger ?? createLogger('index-health');
    this.analyzer = new IndexHealthAnalyzer({
      db: options.db,
      thresholds: options.thresholds,
      now: options.now,
      logger: this.log,
    });
  }

  /** Run the analysis once and persist it. Safe to call directly (tests, cron). */
  async runOnce(): Promise<IndexHealthRun> {
    const run = await this.analyzer.analyze();
    await persistIndexHealthRun(this.db, run);
    this.lastRun = run;
    return run;
  }

  getLastRun(): IndexHealthRun | null {
    return this.lastRun;
  }

  start(): void {
    if (this.timer) return;
    this.log.info('index health monitor starting', {
      interval_ms: this.intervalMs,
      off_peak_cron: this.cronExpression,
    });
    void this.runOnce().catch((err) =>
      this.log.error('initial index health run failed', err as Error),
    );
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) =>
        this.log.error('scheduled index health run failed', err as Error),
      );
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

// ── Env factory (VERINODE_INDEX_HEALTH_* — same style as config-drift) ────────

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export function createIndexHealthMonitorFromEnv(db: TransactionCapable): IndexHealthMonitor {
  const thresholds: Partial<IndexHealthThresholds> = {
    maxScansForUnused: envInt(
      'VERINODE_INDEX_HEALTH_MAX_SCANS',
      DEFAULT_INDEX_HEALTH_THRESHOLDS.maxScansForUnused,
    ),
    statsWindowDays: envInt(
      'VERINODE_INDEX_HEALTH_STATS_WINDOW_DAYS',
      DEFAULT_INDEX_HEALTH_THRESHOLDS.statsWindowDays,
    ),
    minTablePagesForSeqScan: envInt(
      'VERINODE_INDEX_HEALTH_MIN_TABLE_PAGES',
      DEFAULT_INDEX_HEALTH_THRESHOLDS.minTablePagesForSeqScan,
    ),
    minSeqScansToFlag: envInt(
      'VERINODE_INDEX_HEALTH_MIN_SEQ_SCANS',
      DEFAULT_INDEX_HEALTH_THRESHOLDS.minSeqScansToFlag,
    ),
  };

  return new IndexHealthMonitor({
    db,
    thresholds,
    intervalMs: envInt('VERINODE_INDEX_HEALTH_INTERVAL_MS', DEFAULT_INTERVAL_MS),
    cronExpression: process.env.VERINODE_INDEX_HEALTH_CRON || DEFAULT_INDEX_HEALTH_CRON,
  });
}
