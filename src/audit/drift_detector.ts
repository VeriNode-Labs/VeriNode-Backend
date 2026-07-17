/**
 * VeriNode Backend — Runtime Config Audit: DriftDetector
 *
 * Stateless component that diffs the live config against the active baseline
 * on every ConfigEventBus 'updated' event.  Each detect() call runs in an
 * independent Promise with a 5s hard timeout so the event loop is never blocked.
 */

import { trace, SpanStatusCode, context } from '@opentelemetry/api';
import {
  CRITICAL_SECTIONS,
  DriftedKey,
  DriftReport,
  DriftSeverity,
  PartialAlertPayload,
} from './types';
import { instruments } from './metrics';
import { BaselineManager } from './baseline_manager';
import { AlertDispatcher } from './alert_dispatcher';
import { StructuredLogger } from '../diagnostics/logger';

const DETECT_TIMEOUT_MS = 5000;
const TRACER_NAME = 'config_audit';

// ── DriftDetector ─────────────────────────────────────────────────────────────

export class DriftDetector {
  constructor(
    private readonly baselineManager: BaselineManager,
    private readonly alertDispatcher: AlertDispatcher,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Detect drift between liveConfig and the active baseline.
   * Runs inside a 5s-timeout Promise so callers are never blocked.
   * Catches and logs all errors without re-throwing.
   */
  async detect(liveConfig: object): Promise<void> {
    const detectPromise = this._detectInternal(liveConfig);
    const timeoutPromise = _sleep(DETECT_TIMEOUT_MS).then(() => {
      throw new Error(`DriftDetector.detect exceeded ${DETECT_TIMEOUT_MS}ms timeout`);
    });

    try {
      await Promise.race([detectPromise, timeoutPromise]);
    } catch (err) {
      this.logger.error('[DriftDetector] detect() timed out or failed', {
        'error.message': (err as Error).message,
      });
    }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async _detectInternal(liveConfig: object): Promise<void> {
    const tracer = trace.getTracer(TRACER_NAME);
    const span = tracer.startSpan(
      'config_audit.detect_drift',
      {},
      context.active(),
    );
    const t0 = performance.now();

    try {
      // 1. Load active baseline
      let baseline;
      try {
        baseline = await this.baselineManager.getActive();
      } catch (err) {
        this.logger.error('[DriftDetector] Failed to load active baseline', {
          'error.message': (err as Error).message,
        });
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        span.recordException(err as Error);
        return;
      }

      if (!baseline) {
        this.logger.warn('[DriftDetector] No active baseline — drift detection skipped');
        return;
      }

      // 2. Diff
      let diffs: DriftedKey[];
      try {
        const baselineObj = this.baselineManager.deserializeBaseline(baseline.snapshotJson);
        const rawDiffs = deepDiff(baselineObj as Record<string, unknown>, liveConfig as Record<string, unknown>);
        diffs = rawDiffs.map((d) => ({ ...d, severity: classify(d.path) }));
      } catch (err) {
        // Unexpected error during diff — send partial alert for critical keys
        const partialAlert: PartialAlertPayload = {
          severity: 'critical',
          partialReport: true,
          error: (err as Error).message,
        };
        try {
          this.alertDispatcher.dispatch(partialAlert);
        } catch {
          // AlertDispatcher must never crash the detector
        }
        span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        span.recordException(err as Error);
        return;
      }

      if (diffs.length === 0) {
        // No drift — record latency and return
        instruments.driftLatencyMs.record(performance.now() - t0);
        return;
      }

      // 3. Build DriftReport
      const report: DriftReport = {
        baselineId: baseline.id,
        detectedAt: new Date(),
        driftedKeys: diffs,
      };

      // 4. OTel metrics
      const hasCritical = diffs.some((d) => d.severity === 'critical');
      instruments.driftDetectionsTotal.add(1, {
        severity: hasCritical ? 'critical' : 'non_critical',
      });
      instruments.driftLatencyMs.record(performance.now() - t0);

      // 5. Dispatch alert for critical drift
      if (hasCritical) {
        try {
          this.alertDispatcher.dispatch(report);
        } catch {
          // AlertDispatcher errors must not propagate
        }
      }
    } finally {
      span.end();
    }
  }
}

// ── deepDiff ──────────────────────────────────────────────────────────────────

interface RawDiff {
  path: string;
  baselineValue: unknown;
  liveValue: unknown;
}

/**
 * Compute a flat list of dot-separated key paths that differ between
 * baseline and live objects.  Arrays are compared by JSON serialization.
 */
export function deepDiff(
  baseline: Record<string, unknown>,
  live: Record<string, unknown>,
  prefix = '',
): RawDiff[] {
  const diffs: RawDiff[] = [];
  const allKeys = new Set([...Object.keys(baseline), ...Object.keys(live)]);

  for (const key of allKeys) {
    const fullPath = prefix ? `${prefix}.${key}` : key;
    const bVal = baseline[key];
    const lVal = live[key];

    const bMissing = !(key in baseline);
    const lMissing = !(key in live);

    if (bMissing) {
      diffs.push({ path: fullPath, baselineValue: undefined, liveValue: lVal });
      continue;
    }
    if (lMissing) {
      diffs.push({ path: fullPath, baselineValue: bVal, liveValue: undefined });
      continue;
    }

    // Both present — recurse for plain objects, stringify-compare arrays/primitives
    if (
      bVal !== null &&
      lVal !== null &&
      typeof bVal === 'object' &&
      typeof lVal === 'object' &&
      !Array.isArray(bVal) &&
      !Array.isArray(lVal)
    ) {
      diffs.push(
        ...deepDiff(
          bVal as Record<string, unknown>,
          lVal as Record<string, unknown>,
          fullPath,
        ),
      );
    } else if (JSON.stringify(bVal) !== JSON.stringify(lVal)) {
      diffs.push({ path: fullPath, baselineValue: bVal, liveValue: lVal });
    }
  }

  return diffs;
}

// ── classify ──────────────────────────────────────────────────────────────────

export function classify(path: string): DriftSeverity {
  const section = path.split('.')[0];
  return CRITICAL_SECTIONS.has(section) ? 'critical' : 'non_critical';
}

// ── helpers ───────────────────────────────────────────────────────────────────

function _sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
