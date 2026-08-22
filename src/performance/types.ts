/**
 * VeriNode Backend — Performance Regression Detection: Types
 *
 * Shared type definitions for benchmark metrics, baseline storage,
 * change-point analysis, and regression reports.
 */

/** Raw benchmark result for a single scenario run. */
export interface BenchmarkMetrics {
  scenario: string;
  timestamp: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
  throughputRps: number;
  errorRate: number;
  gcPauseDurationMs?: number;
}

/** Comparison of a single metric between current and baseline. */
export interface BaselineComparison {
  scenario: string;
  metric: string;
  baselineValue: number;
  currentValue: number;
  /** Positive = regression (worse), negative = improvement (better). */
  regressionPercent: number;
  isRegression: boolean;
  /** Index in the time series where the change point was detected, if any. */
  changePoint?: number;
}

/** Full regression report returned by the detector. */
export interface RegressionReport {
  hasRegression: boolean;
  regressions: BaselineComparison[];
  summary: string;
  changePoints: ChangePoint[];
}

/** A statistically significant change point in a time series. */
export interface ChangePoint {
  /** Index in the series where the split occurs. */
  index: number;
  /** Energy-statistic significance value (higher = more significant). */
  significance: number;
  /** Which metric this change point was found in. */
  metric: string;
}

/** Persisted baseline record stored on disk / S3. */
export interface PerformanceBaseline {
  branch: string;
  scenario: string;
  storedAt: number;
  metrics: BenchmarkMetrics[];
}
