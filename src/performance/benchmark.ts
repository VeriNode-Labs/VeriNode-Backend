/**
 * VeriNode Backend — Benchmark Runner
 *
 * Executes benchmark scenarios for a fixed duration, collects
 * latency samples, and produces p50/p95/p99 latency, throughput,
 * and error rate metrics.
 *
 * Usage:
 *   const runner = new BenchmarkRunner({ durationMs: 300_000, scenarios: ['api-request', 'db-query'] });
 *   const results = await runner.run({
 *     'api-request': async () => { await fetch('http://localhost:3000/health'); },
 *     'db-query':    async () => { await pool.query('SELECT 1'); },
 *   });
 */

import type { BenchmarkMetrics } from './types';

export interface BenchmarkConfig {
  /** How long to run each scenario (milliseconds). Default: 300_000 (5 min). */
  durationMs: number;
  /** Ordered list of scenario names to execute. */
  scenarios: string[];
  /** Maximum number of concurrent workers per scenario. Default: 1. */
  concurrency?: number;
}

export class BenchmarkRunner {
  private readonly config: BenchmarkConfig;

  constructor(config: BenchmarkConfig) {
    this.config = {
      concurrency: 1,
      ...config,
    };
  }

  // ── Percentile helper ─────────────────────────────────────────────────

  /**
   * Compute the p-th percentile from a sorted array.
   * @param sorted Array sorted in ascending order.
   * @param p      Percentile in [0, 100].
   */
  computePercentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    if (p <= 0) return sorted[0];
    if (p >= 100) return sorted[sorted.length - 1];

    const rank = (p / 100) * (sorted.length - 1);
    const lower = Math.floor(rank);
    const upper = Math.ceil(rank);
    const frac = rank - lower;

    return sorted[lower] * (1 - frac) + sorted[upper] * frac;
  }

  // ── Single scenario ───────────────────────────────────────────────────

  /**
   * Run a single scenario function repeatedly for `durationMs` milliseconds.
   * Collects per-iteration latency, error count, and throughput.
   */
  async runScenario(
    scenario: string,
    fn: () => Promise<void>,
  ): Promise<BenchmarkMetrics> {
    const latencySamples: number[] = [];
    let errorCount = 0;
    let iterationCount = 0;

    const deadline = Date.now() + this.config.durationMs;
    const concurrency = this.config.concurrency ?? 1;

    /** Worker loop: runs until deadline. */
    const worker = async (): Promise<void> => {
      while (Date.now() < deadline) {
        const start = process.hrtime.bigint();
        try {
          await fn();
        } catch {
          errorCount++;
        } finally {
          const durationNs = process.hrtime.bigint() - start;
          latencySamples.push(Number(durationNs) / 1e6); // → milliseconds
          iterationCount++;
        }
      }
    };

    // Launch workers.
    await Promise.all(
      Array.from({ length: concurrency }, () => worker()),
    );

    const sorted = latencySamples.slice().sort((a, b) => a - b);
    const elapsedS = this.config.durationMs / 1000;

    return {
      scenario,
      timestamp: Date.now(),
      p50LatencyMs: this.computePercentile(sorted, 50),
      p95LatencyMs: this.computePercentile(sorted, 95),
      p99LatencyMs: this.computePercentile(sorted, 99),
      throughputRps: iterationCount / elapsedS,
      errorRate:
        iterationCount > 0 ? errorCount / iterationCount : 0,
    };
  }

  // ── Multiple scenarios ────────────────────────────────────────────────

  /**
   * Run all scenarios sequentially and return the full results array.
   *
   * @param scenarios Map of scenario name → async benchmark function.
   *                  Only entries whose keys appear in `this.config.scenarios`
   *                  will be executed.
   */
  async run(
    scenarios: Record<string, () => Promise<void>>,
  ): Promise<BenchmarkMetrics[]> {
    const results: BenchmarkMetrics[] = [];

    for (const name of this.config.scenarios) {
      const fn = scenarios[name];
      if (!fn) {
        console.warn(`[BenchmarkRunner] No function registered for scenario "${name}" — skipping.`);
        continue;
      }
      console.log(`[BenchmarkRunner] Running scenario "${name}" for ${this.config.durationMs / 1000}s…`);
      const result = await this.runScenario(name, fn);
      results.push(result);
      console.log(
        `[BenchmarkRunner] ${name}: p50=${result.p50LatencyMs.toFixed(2)}ms ` +
          `p99=${result.p99LatencyMs.toFixed(2)}ms ` +
          `rps=${result.throughputRps.toFixed(1)} ` +
          `err=${(result.errorRate * 100).toFixed(2)}%`,
      );
    }

    return results;
  }
}
