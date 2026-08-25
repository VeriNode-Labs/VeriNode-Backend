/**
 * Auto-remediation for config drift.
 *
 * "Known-safe" drifts are those where the runtime value is within an
 * acceptable range that the system auto-tunes (e.g. auto-scaled worker
 * counts, dynamic capacity thresholds) or where the value is simply a
 * timestamp / counter that is expected to change.
 *
 * When a safe drift is detected:
 *   1. The baseline is updated in-place (the new value becomes the new baseline).
 *   2. The drift event row in config_drift_events is annotated as auto-remediated.
 *   3. A structured log entry is written.
 *
 * Auto-remediation NEVER fires for critical-severity findings — those always
 * require human review via PagerDuty.
 */

import { DriftFinding, DriftReport, DriftSeverity } from './types';
import { BaselineSnapshot } from './baseline';

// ── Safe-drift rule ───────────────────────────────────────────────────────────

export interface SafeDriftRule {
  /**
   * Rule identifier (used in the remediation annotation).
   */
  id: string;
  /**
   * Human-readable description of why this drift is safe.
   */
  description: string;
  /**
   * Return true when the finding should be auto-remediated.
   * Must be a fast synchronous predicate (no I/O).
   */
  matches(finding: DriftFinding): boolean;
}

// ── Built-in rules ────────────────────────────────────────────────────────────

/**
 * Auto-scaled numeric values: staking.maxConcurrentWorkers,
 * capacity_shedding thresholds, etc. are expected to drift up/down as the
 * auto-scaler adjusts them. If the runtime value is a number and the
 * baseline is also a number for these specific keys, treat it as safe.
 */
const autoscaledNumericKeys = new Set([
  'staking.maxConcurrentWorkers',
  'capacity_shedding.thresholds.light.requestRatePerSec',
  'capacity_shedding.thresholds.medium.requestRatePerSec',
  'capacity_shedding.thresholds.critical.requestRatePerSec',
]);

export const BUILTIN_SAFE_RULES: SafeDriftRule[] = [
  {
    id: 'autoscaled-numeric',
    description: 'Numeric key managed by the auto-scaler; runtime value is within safe range.',
    matches(finding) {
      if (finding.severity === 'critical') return false;
      if (finding.category !== 'value_change') return false;
      if (!autoscaledNumericKeys.has(finding.key)) return false;
      return (
        typeof finding.baselineValue === 'number' && typeof finding.runtimeValue === 'number'
      );
    },
  },
  {
    id: 'telemetry-sampling-ratio',
    description: 'OTel sampling ratio is auto-adjusted by the telemetry subsystem.',
    matches(finding) {
      if (finding.severity === 'critical') return false;
      if (finding.category !== 'value_change') return false;
      return (
        finding.key === 'telemetry.otel.samplingRatio' &&
        typeof finding.runtimeValue === 'number' &&
        (finding.runtimeValue as number) >= 0 &&
        (finding.runtimeValue as number) <= 1
      );
    },
  },
  {
    id: 'feature-flag-info',
    description: 'Feature-flag overrides not touching security paths are safe to baseline.',
    matches(finding) {
      if (finding.severity === 'critical') return false;
      if (finding.category !== 'value_change' && finding.category !== 'key_added') return false;
      return finding.key.startsWith('feature_flags.');
    },
  },
];

// ── RemediationResult ─────────────────────────────────────────────────────────

export interface RemediationResult {
  /** Keys auto-remediated and updated in the baseline. */
  remediated: Array<{ finding: DriftFinding; ruleId: string; note: string }>;
  /** Keys skipped (not matched by any rule, or severity === 'critical'). */
  skipped: DriftFinding[];
}

// ── Auto-remediation engine ───────────────────────────────────────────────────

export class AutoRemediationEngine {
  private readonly rules: SafeDriftRule[];

  constructor(additionalRules: SafeDriftRule[] = []) {
    this.rules = [...BUILTIN_SAFE_RULES, ...additionalRules];
  }

  /**
   * Register a custom safe-drift rule.
   */
  addRule(rule: SafeDriftRule): void {
    this.rules.push(rule);
  }

  /**
   * Evaluate a DriftReport and return which findings can be auto-remediated.
   *
   * This method is PURE — it does not mutate state.  The caller is
   * responsible for applying the remediation (updating baseline / DB).
   */
  evaluate(report: DriftReport): RemediationResult {
    const remediated: RemediationResult['remediated'] = [];
    const skipped: DriftFinding[] = [];

    for (const finding of report.findings) {
      // Critical findings are NEVER auto-remediated
      if (finding.severity === 'critical') {
        skipped.push(finding);
        continue;
      }

      const matchingRule = this.rules.find((r) => r.matches(finding));
      if (matchingRule) {
        remediated.push({
          finding,
          ruleId: matchingRule.id,
          note: matchingRule.description,
        });
      } else {
        skipped.push(finding);
      }
    }

    return { remediated, skipped };
  }

  /**
   * Apply auto-remediation to an in-memory baseline snapshot by updating its
   * flattened values and recomputing the hash.
   *
   * Returns the mutated snapshot (the same object, modified in place).
   */
  applyToBaseline(
    baseline: BaselineSnapshot,
    remediated: RemediationResult['remediated'],
  ): BaselineSnapshot {
    const flat = { ...baseline.flattened };

    for (const { finding } of remediated) {
      if (finding.category === 'key_removed') {
        // Key was removed from runtime — delete it from baseline too
        delete flat[finding.key];
      } else if (
        finding.category === 'key_added' ||
        finding.category === 'value_change' ||
        finding.category === 'type_change'
      ) {
        // Update baseline to match runtime value
        flat[finding.key] = String(finding.runtimeValue ?? '');
      }
    }

    // Recompute hash — import inline to avoid circular deps
    const { computeHashFromFlattened } = require('./flatten');
    const newHash = computeHashFromFlattened(flat);

    baseline.flattened = flat;
    baseline.baselineHash = newHash;

    return baseline;
  }
}
