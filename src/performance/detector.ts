/**
 * VeriNode Backend — Performance Regression Detector
 *
 * Compares a current benchmark run against a stored baseline and
 * uses the EDM change point detector to identify time-series shifts.
 *
 * A regression is any metric that has degraded by more than
 * `regressionThresholdPercent` from the baseline value.
 *
 * Higher values are "worse" for latency and error rate;
 * lower values are "worse" for throughput.
 */

import { findChangePoints } from './edm';
import type {
  BenchmarkMetrics,
  BaselineComparison,
  RegressionReport,
  ChangePoint,
} from './types';

/** Metrics where a larger value means worse performance. */
const HIGHER_IS_WORSE: ReadonlySet<string> = new Set([
  'p50LatencyMs',
  'p95LatencyMs',
  'p99LatencyMs',
  'errorRate',
  'gcPauseDurationMs',
]);

/** Metrics where a smaller value means worse performance. */
const LOWER_IS_WORSE: ReadonlySet<string> = new Set(['throughputRps']);

/** All numeric metric keys we track. */
const TRACKED_METRICS: ReadonlyArray<keyof BenchmarkMetrics> = [
  'p50LatencyMs',
  'p95LatencyMs',
  'p99LatencyMs',
  'throughputRps',
  'errorRate',
  'gcPauseDurationMs',
];

export interface RegressionDetectorConfig {
  /** Percentage threshold above which a change is flagged as a regression. */
  regressionThresholdPercent: number;
  /** Minimum number of samples required before EDM analysis runs. */
  minSamples: number;
}

export class RegressionDetector {
  private readonly config: RegressionDetectorConfig;

  constructor(config: RegressionDetectorConfig) {
    this.config = config;
  }

  // ── Core comparison ───────────────────────────────────────────────────

  /**
   * Compare all numeric metrics between a current measurement and a
   * baseline.  Returns one `BaselineComparison` per tracked metric.
   */
  compare(
    current: BenchmarkMetrics,
    baseline: BenchmarkMetrics,
  ): BaselineComparison[] {
    const comparisons: BaselineComparison[] = [];

    for (const key of TRACKED_METRICS) {
      const baselineValue = baseline[key] as number | undefined;
      const currentValue = current[key] as number | undefined;

      // Skip optional metrics that are missing in either measurement.
      if (baselineValue === undefined || currentValue === undefined) continue;
      if (baselineValue === null || currentValue === null) continue;

      const regressionPercent = computeRegressionPercent(
        key,
        baselineValue,
        currentValue,
      );

      comparisons.push({
        scenario: current.scenario,
        metric: key,
        baselineValue,
        currentValue,
        regressionPercent,
        isRegression:
          regressionPercent > this.config.regressionThresholdPercent,
      });
    }

    return comparisons;
  }

  // ── Time-series analysis ──────────────────────────────────────────────

  /**
   * Run EDM change point detection on a historical series of benchmark
   * records for the given metric.
   */
  analyzeTimeSeries(
    series: BenchmarkMetrics[],
    metric: keyof BenchmarkMetrics,
  ): ChangePoint[] {
    if (series.length < this.config.minSamples) return [];

    const values = series.map((m) => {
      const v = m[metric];
      return typeof v === 'number' ? v : 0;
    });

    const indices = findChangePoints(values);

    return indices.map((idx) => ({
      index: idx,
      significance: computeSignificance(values, idx),
      metric: metric as string,
    }));
  }

  // ── Report generation ─────────────────────────────────────────────────

  /** Combine comparisons and change points into a structured report. */
  generateReport(
    comparisons: BaselineComparison[],
    changePoints: ChangePoint[],
  ): RegressionReport {
    const regressions = comparisons.filter((c) => c.isRegression);

    const summary =
      regressions.length === 0
        ? `No regressions detected across ${comparisons.length} metrics.`
        : `⚠️  ${regressions.length} regression(s) detected: ` +
          regressions
            .map(
              (r) =>
                `${r.metric} +${r.regressionPercent.toFixed(1)}%`,
            )
            .join(', ');

    return {
      hasRegression: regressions.length > 0,
      regressions,
      summary,
      changePoints,
    };
  }

  // ── Markdown formatting ───────────────────────────────────────────────

  /**
   * Format the report as a Markdown table suitable for posting as a
   * GitHub PR comment.
   */
  formatMarkdownTable(report: RegressionReport): string {
    const lines: string[] = [];

    lines.push('## Performance Regression Report');
    lines.push('');

    if (!report.hasRegression) {
      lines.push('✅ **No regressions detected.**');
    } else {
      lines.push('🚨 **Regression(s) detected — CI blocked.**');
    }

    lines.push('');
    lines.push(
      '| Metric | Baseline | Current | Change | Status |',
    );
    lines.push(
      '|--------|----------|---------|--------|--------|',
    );

    for (const c of report.regressions.concat(
      // include non-regressions after
      report.regressions.length > 0
        ? []
        : [],
    )) {
      const changeStr =
        c.regressionPercent >= 0
          ? `+${c.regressionPercent.toFixed(2)}%`
          : `${c.regressionPercent.toFixed(2)}%`;
      const status = c.isRegression ? '❌ REGRESSION' : '✅ OK';
      lines.push(
        `| ${c.metric} | ${c.baselineValue.toFixed(3)} | ${c.currentValue.toFixed(3)} | ${changeStr} | ${status} |`,
      );
    }

    // If no comparisons in regressions, include all
    if (report.regressions.length === 0) {
      lines.pop(); // remove empty separator
      lines.pop(); // remove header row
      lines.pop(); // remove separator
      lines.pop(); // remove header
      lines.pop(); // blank
      lines.push('_All metrics within acceptable thresholds._');
    }

    if (report.changePoints.length > 0) {
      lines.push('');
      lines.push('### Detected Change Points');
      lines.push('');
      lines.push('| Metric | Series Index | Significance |');
      lines.push('|--------|-------------|--------------|');
      for (const cp of report.changePoints) {
        lines.push(`| ${cp.metric} | ${cp.index} | ${cp.significance.toFixed(4)} |`);
      }
    }

    lines.push('');
    lines.push(`> Analysis threshold: >${this.config.regressionThresholdPercent}% degradation triggers CI block.`);

    return lines.join('\n');
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/**
 * Compute regression percentage for a metric.
 * Returns a positive number when the current value is "worse"
 * than the baseline, negative when it is "better".
 */
function computeRegressionPercent(
  metric: keyof BenchmarkMetrics,
  baseline: number,
  current: number,
): number {
  if (baseline === 0) return 0;

  if (HIGHER_IS_WORSE.has(metric as string)) {
    // e.g. latency: current > baseline → regression
    return ((current - baseline) / baseline) * 100;
  }

  if (LOWER_IS_WORSE.has(metric as string)) {
    // e.g. throughput: current < baseline → regression
    return ((baseline - current) / baseline) * 100;
  }

  return 0;
}

/**
 * Estimate the significance of a detected change point by computing
 * the energy statistic at that split.
 */
function computeSignificance(series: number[], splitIndex: number): number {
  const left = series.slice(0, splitIndex);
  const right = series.slice(splitIndex);
  if (left.length === 0 || right.length === 0) return 0;

  const meanLeft = left.reduce((s, v) => s + v, 0) / left.length;
  const meanRight = right.reduce((s, v) => s + v, 0) / right.length;
  return Math.abs(meanLeft - meanRight);
}
