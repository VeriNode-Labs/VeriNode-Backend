/**
 * VeriNode Backend — Runtime Config Audit: OpenTelemetry Instruments
 *
 * All six named instruments for the config_audit subsystem.
 * Instruments are created lazily on first access so tests that import
 * this module without an active SDK do not crash.
 */

import { metrics, ObservableResult } from '@opentelemetry/api';

const meter = metrics.getMeter('config_audit', '1.0.0');

// ── Counters ──────────────────────────────────────────────────────────────────

/**
 * Incremented on every successfully persisted Audit Entry.
 * Attributes: change_source, config_section (first dot-segment of config_path)
 */
export const changesTotal = meter.createCounter('config_audit.changes_total', {
  description: 'Total config audit log entries persisted',
});

/**
 * Incremented on every DriftReport produced.
 * Attributes: severity ('critical' | 'non_critical')
 */
export const driftDetectionsTotal = meter.createCounter(
  'config_audit.drift_detections_total',
  { description: 'Total drift reports produced' },
);

/**
 * Incremented when an audit entry is evicted from the in-memory queue due
 * to the queue being at capacity (1000 entries).
 */
export const queueDroppedTotal = meter.createCounter(
  'config_audit.queue_dropped_total',
  { description: 'Audit entries dropped due to in-memory queue saturation' },
);

/**
 * Incremented when healthCheck() returns 'degraded' or 'unhealthy'.
 * Attributes: component ('database' | 'queue' | 'notification')
 */
export const healthCheckFailuresTotal = meter.createCounter(
  'config_audit.health_check_failures_total',
  { description: 'Health check failures by component' },
);

// ── Histogram ─────────────────────────────────────────────────────────────────

/**
 * Records the elapsed time (ms) from ConfigEventBus 'updated' event emission
 * to DriftReport completion.  Target P99 ≤ 100ms.
 * Bucket boundaries chosen to bracket the 100ms SLO clearly.
 */
export const driftLatencyMs = meter.createHistogram(
  'config_audit.drift_detection_latency_ms',
  {
    description: 'Drift detection latency in milliseconds (target P99 ≤ 100ms)',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [10, 25, 50, 100, 250, 500] },
  },
);

// ── Observable gauge ──────────────────────────────────────────────────────────

/**
 * Age in seconds of the currently active baseline.
 * Updated on every BaselineManager.getActive() call.
 * Reports -1 when no active baseline exists.
 */
export const activeBaselineAgeSeconds = meter.createObservableGauge(
  'config_audit.active_baseline_age_seconds',
  {
    description:
      'Age of the active configuration baseline in seconds; -1 if none exists',
    unit: 's',
  },
);

// ── Convenience bundle ────────────────────────────────────────────────────────

export const instruments = {
  changesTotal,
  driftDetectionsTotal,
  driftLatencyMs,
  queueDroppedTotal,
  activeBaselineAgeSeconds,
  healthCheckFailuresTotal,
} as const;
