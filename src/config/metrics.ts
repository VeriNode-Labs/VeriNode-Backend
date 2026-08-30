/**
 * Config metrics: config_reload_count and config_validation_errors_total.
 *
 * Lightweight Prometheus-style counters exposed in the same text format used
 * by the rest of the codebase (see tentative_cleanup_worker.prometheusMetrics).
 */

export interface ConfigMetricsSnapshot {
  /** Total successful configuration reloads. */
  reloadCount: number;
  /** Total configuration validation failures (startup, update, reload). */
  validationErrors: number;
  /** Total rollback operations performed. */
  rollbacks: number;
  /** Milliseconds of the most recent reload duration. */
  lastReloadDurationMs: number;
}

export class ConfigMetrics {
  private reloadCount = 0;
  private validationErrors = 0;
  private rollbacks = 0;
  private lastReloadDurationMs = 0;

  incrementReload(durationMs = 0): void {
    this.reloadCount++;
    this.lastReloadDurationMs = durationMs;
  }

  incrementValidationErrors(count = 1): void {
    this.validationErrors += count;
  }

  incrementRollbacks(): void {
    this.rollbacks++;
  }

  snapshot(): ConfigMetricsSnapshot {
    return {
      reloadCount: this.reloadCount,
      validationErrors: this.validationErrors,
      rollbacks: this.rollbacks,
      lastReloadDurationMs: this.lastReloadDurationMs,
    };
  }

  /**
   * Prometheus text exposition format.
   */
  prometheusMetrics(): string {
    const lines: string[] = [
      '# HELP config_reload_count Total successful configuration reloads',
      '# TYPE config_reload_count counter',
      `config_reload_count ${this.reloadCount}`,
      '# HELP config_validation_errors_total Total configuration validation failures',
      '# TYPE config_validation_errors_total counter',
      `config_validation_errors_total ${this.validationErrors}`,
      '# HELP config_rollbacks_total Total configuration rollback operations',
      '# TYPE config_rollbacks_total counter',
      `config_rollbacks_total ${this.rollbacks}`,
      '# HELP config_last_reload_duration_ms Duration of the most recent reload in milliseconds',
      '# TYPE config_last_reload_duration_ms gauge',
      `config_last_reload_duration_ms ${this.lastReloadDurationMs}`,
    ];
    return lines.join('\n') + '\n';
  }
}
