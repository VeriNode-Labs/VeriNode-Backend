/**
 * VeriNode Backend — Runtime Config Audit: ConfigAuditService
 *
 * Top-level orchestrator.  Wires AuditLogger, BaselineManager, DriftDetector,
 * and AlertDispatcher together via the ConfigEventBus.  All event listeners
 * are wrapped in try-catch so audit errors can never crash the host process.
 */

import { Pool } from 'pg';
import {
  ActorContext,
  AuditEntryInput,
  Baseline,
  ChangeSource,
  DriftReport,
  ForbiddenError,
  HealthCheckResult,
  HealthStatus,
  RollbackResult,
} from './types';
import { AuditLogger } from './audit_logger';
import { BaselineManager } from './baseline_manager';
import { DriftDetector } from './drift_detector';
import { AlertDispatcher } from './alert_dispatcher';
import { instruments } from './metrics';
import { metrics } from '@opentelemetry/api';
import { ConfigEventBus } from '../config/eventbus';
import { ConfigManager } from '../config/manager';
import { requirePermission } from '../api/auth/token_validator';
import { StructuredLogger } from '../diagnostics/logger';

export class ConfigAuditService {
  private _updatedListener: ((payload: any) => void) | null = null;

  constructor(
    private readonly eventBus: ConfigEventBus,
    private readonly configManager: ConfigManager,
    private readonly auditLogger: AuditLogger,
    private readonly baselineManager: BaselineManager,
    private readonly driftDetector: DriftDetector,
    private readonly alertDispatcher: AlertDispatcher,
    private readonly pool: Pool,
    private readonly logger: StructuredLogger,
  ) {}

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Register all ConfigEventBus listeners.  Call once at startup.
   */
  start(): void {
    this._updatedListener = (payload: any) => {
      try {
        const data = payload?.data ?? {};
        const {
          configPath = '',
          previousValue,
          newValue,
          actor = 'system',
          sourceIp = null,
          changeSource = 'hot_update',
        } = data;

        const entry: AuditEntryInput = {
          configPath,
          previousValue,
          newValue,
          actor,
          sourceIp,
          changedAt: new Date(),
          changeSource: changeSource as ChangeSource,
        };

        // fire-and-forget — errors caught inside write()
        void this.auditLogger.write(entry);

        // independent drift check with 5s timeout — errors caught inside detect()
        void this.driftDetector.detect(this.configManager.get());

        // Update active baseline age gauge
        void this.baselineManager.getActive().then((baseline) => {
          const ageSeconds = baseline
            ? (Date.now() - baseline.createdAt.getTime()) / 1000
            : -1;
          // Observable gauge is updated via the addBatchObservableCallback pattern;
          // we record via a direct add on a regular gauge equivalent here.
          // The gauge value is surfaced through healthCheck and metrics callbacks.
          void ageSeconds; // consumed via healthCheck / OTel observable callback below
        }).catch(() => {});
      } catch (err) {
        this.logger.error('[ConfigAuditService] Unhandled error in updated listener', {
          'error.message': (err as Error).message,
        });
      }
    };

    this.eventBus.on('updated', this._updatedListener);

    // Register the observable gauge callback so OTel can scrape baseline age
    const meter = metrics.getMeter('config_audit', '1.0.0');
    meter.addBatchObservableCallback(
      async (observableResult: any) => {
        try {
          const baseline = await this.baselineManager.getActive();
          const age = baseline
            ? (Date.now() - baseline.createdAt.getTime()) / 1000
            : -1;
          observableResult.observe(instruments.activeBaselineAgeSeconds, age);
        } catch {
          observableResult.observe(instruments.activeBaselineAgeSeconds, -1);
        }
      },
      [instruments.activeBaselineAgeSeconds],
    );

    this.logger.info('[ConfigAuditService] Started');
  }

  /**
   * Remove all registered listeners.  Call during graceful shutdown.
   */
  stop(): void {
    if (this._updatedListener) {
      this.eventBus.removeListener('updated', this._updatedListener);
      this._updatedListener = null;
    }
    this.auditLogger.stop();
    this.logger.info('[ConfigAuditService] Stopped');
  }

  // ── Baseline operations ────────────────────────────────────────────────────

  /**
   * Capture the current runtime config as a new active baseline.
   * Emits baseline_captured or baseline_access_denied on the event bus.
   */
  async captureBaseline(actor: ActorContext): Promise<Baseline> {
    try {
      const baseline = await this.baselineManager.capture(
        this.configManager.get(),
        actor,
      );
      this.eventBus.emitEvent('baseline_captured' as any, {
        baselineId: baseline.id,
        actor: actor.actorId,
      });
      return baseline;
    } catch (err) {
      if (err instanceof ForbiddenError) {
        this.eventBus.emitEvent('baseline_access_denied' as any, {
          actor: actor.actorId,
          sourceIp: actor.sourceIp,
        });
      }
      throw err;
    }
  }

  // ── Rollback ───────────────────────────────────────────────────────────────

  /**
   * Roll back the live config to the baseline values in the DriftReport.
   * Pass dryRun: true to preview changes without applying them.
   */
  async rollback(
    report: DriftReport,
    actor: ActorContext,
    dryRun = false,
  ): Promise<RollbackResult> {
    // Auth check FIRST — before any state read or mutation
    try {
      requirePermission(actor, 'config:rollback:write');
    } catch (err) {
      this.eventBus.emitEvent('baseline_access_denied' as any, {
        actor: actor.actorId,
        sourceIp: actor.sourceIp,
      });
      throw err;
    }

    if (dryRun) {
      return {
        baselineId: report.baselineId,
        restored: report.driftedKeys.map((k) => k.path),
        skipped: [],
        dryRun: true,
      };
    }

    const restored: string[] = [];
    const skipped: string[] = [];

    for (const dk of report.driftedKeys) {
      try {
        this.configManager.update(dk.path, dk.baselineValue);

        await this.auditLogger.write({
          configPath: dk.path,
          previousValue: dk.liveValue,
          newValue: dk.baselineValue,
          actor: actor.actorId,
          sourceIp: actor.sourceIp,
          changedAt: new Date(),
          changeSource: 'rollback',
        });

        restored.push(dk.path);
      } catch (err) {
        this.logger.warn('[ConfigAuditService] Rollback skipped key', {
          config_path: dk.path,
          'error.message': (err as Error).message,
        });

        await this.auditLogger.write({
          configPath: dk.path,
          previousValue: dk.liveValue,
          newValue: dk.baselineValue,
          actor: actor.actorId,
          sourceIp: actor.sourceIp,
          changedAt: new Date(),
          changeSource: 'rollback_skip',
        }).catch(() => {});

        skipped.push(dk.path);
      }
    }

    this.eventBus.emitEvent('rollback_complete' as any, {
      baselineId: report.baselineId,
      restored,
      skipped,
    });

    return { baselineId: report.baselineId, restored, skipped, dryRun: false };
  }

  // ── Health check ───────────────────────────────────────────────────────────

  async healthCheck(): Promise<HealthCheckResult> {
    const details: Record<string, string> = {};

    // DB connectivity
    let dbOk = false;
    try {
      await this.pool.query('SELECT 1');
      dbOk = true;
      details['database'] = 'reachable';
    } catch {
      details['database'] = 'unreachable';
    }

    // Queue depth
    const depth = this.auditLogger.queueDepth;
    details['queue_depth'] = String(depth);

    // Last write
    const lastWrite = this.auditLogger.lastWrite;
    details['last_successful_write'] = lastWrite
      ? lastWrite.toISOString()
      : 'never';

    const secondsSinceWrite = lastWrite
      ? (Date.now() - lastWrite.getTime()) / 1000
      : Infinity;

    // Determine status
    let status: HealthStatus;
    if (depth >= 1000 || (!dbOk && secondsSinceWrite > 60)) {
      status = 'unhealthy';
    } else if (depth > 0 || !dbOk) {
      status = 'degraded';
    } else {
      status = 'healthy';
    }

    // Emit OTel counters for non-healthy states
    if (status !== 'healthy') {
      if (!dbOk) {
        instruments.healthCheckFailuresTotal.add(1, { component: 'database' });
      }
      if (depth >= 1000) {
        instruments.healthCheckFailuresTotal.add(1, { component: 'queue' });
      }
    }

    return { status, details };
  }
}
