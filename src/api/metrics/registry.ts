/**
 * VeriNode Backend — Prometheus Metrics Registry
 *
 * Maintains a registry of all metric collectors. Each collector
 * exposes a `render(): string` method that returns Prometheus
 * text-format lines. The registry aggregates them on scrape.
 */

export interface MetricCollector {
  /** Return Prometheus text-format lines for this collector. */
  render(): string;
}

export class MetricsRegistry {
  private readonly collectors: MetricCollector[] = [];

  /** Register a metric collector. */
  register(collector: MetricCollector): void {
    this.collectors.push(collector);
  }

  /** Render all registered collectors into a single Prometheus body. */
  renderAll(): string {
    return this.collectors.map((c) => c.render()).join('\n') + '\n';
  }

  /** Remove all collectors (useful for testing). */
  clear(): void {
    this.collectors.length = 0;
  }
}

/** Default singleton registry. */
export const defaultRegistry = new MetricsRegistry();
