/**
 * VeriNode Backend — Metrics Module
 *
 * Re-exports the Prometheus metrics singleton, the registry, and
 * the MetricsMiddleware from a single entry point.
 */

export { PrometheusMetrics, prometheusMetrics } from './prometheus';
export type { PoolStats, HttpRecord, ThreadState } from './prometheus';
export { MetricsRegistry, defaultRegistry } from './registry';
export type { MetricCollector } from './registry';
