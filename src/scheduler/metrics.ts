/**
 * VeriNode Backend — Distributed Job Scheduler: Metrics
 *
 * Prometheus-compatible metrics for job execution, lease management,
 * and worker health monitoring. Follows the same pattern as the
 * existing DLQ, kafka, and reward metrics.
 */

export interface JobExecutionRecord {
  jobType: string;
  durationMs: number;
  success: boolean;
  retryCount: number;
}

const DURATION_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

export class JobSchedulerMetrics {
  // Execution tracking
  private executionRecords: JobExecutionRecord[] = [];
  private leaseTimeoutTotal = 0;
  private jobsCompletedTotal = 0;
  private jobsFailedTotal = 0;

  // Lease tracking
  private leaseRenewalFailures = 0;
  private leaseExpiredTotal = 0;

  // Queue snapshots
  private queueDepth = 0;
  private queueDepthByType = new Map<string, number>();

  // ── Record methods ───────────────────────────────────────────────────────

  recordExecution(record: JobExecutionRecord): void {
    this.executionRecords.push(record);
    if (this.executionRecords.length > 1000) {
      this.executionRecords.shift();
    }
    if (record.success) {
      this.jobsCompletedTotal++;
    } else {
      this.jobsFailedTotal++;
    }
  }

  recordLeaseTimeout(): void {
    this.leaseTimeoutTotal++;
  }

  recordLeaseExpired(): void {
    this.leaseExpiredTotal++;
  }

  recordLeaseRenewalFailure(): void {
    this.leaseRenewalFailures++;
  }

  setQueueDepth(depth: number, jobType?: string): void {
    this.queueDepth = depth;
    if (jobType) {
      this.queueDepthByType.set(jobType, depth);
    }
  }

  // ── Snapshot ─────────────────────────────────────────────────────────────

  getSnapshot() {
    return {
      jobsCompleted: this.jobsCompletedTotal,
      jobsFailed: this.jobsFailedTotal,
      leaseTimeouts: this.leaseTimeoutTotal,
      leaseExpired: this.leaseExpiredTotal,
      leaseRenewalFailures: this.leaseRenewalFailures,
      queueDepth: this.queueDepth,
    };
  }

  // ── Prometheus Rendering ─────────────────────────────────────────────────

  renderPrometheus(): string {
    const lines: string[] = [];

    // ── Queue Depth ──
    lines.push('# HELP verinode_job_queue_depth Pending distributed jobs ready for execution.');
    lines.push('# TYPE verinode_job_queue_depth gauge');
    lines.push(`verinode_job_queue_depth ${this.queueDepth}`);

    // Per-type depths
    for (const [jobType, depth] of this.queueDepthByType) {
      lines.push(`verinode_job_queue_depth{job_type="${jobType}"} ${depth}`);
    }

    // ── Execution Duration Histogram ──
    lines.push('# HELP verinode_job_duration_seconds Job execution duration.');
    lines.push('# TYPE verinode_job_duration_seconds histogram');
    for (const bucket of DURATION_BUCKETS) {
      const count = this.executionRecords.filter((r) => r.durationMs <= bucket).length;
      lines.push(
        `verinode_job_duration_seconds_bucket{le="${(bucket / 1000).toFixed(3)}"} ${count}`,
      );
    }
    lines.push(`verinode_job_duration_seconds_bucket{le="+Inf"} ${this.executionRecords.length}`);
    const sum = this.executionRecords.reduce((s, r) => s + r.durationMs, 0);
    lines.push(`verinode_job_duration_seconds_sum ${(sum / 1000).toFixed(6)}`);
    lines.push(`verinode_job_duration_seconds_count ${this.executionRecords.length}`);

    // ── Completed/Total ──
    lines.push('# HELP verinode_jobs_completed_total Total jobs completed successfully.');
    lines.push('# TYPE verinode_jobs_completed_total counter');
    lines.push(`verinode_jobs_completed_total ${this.jobsCompletedTotal}`);

    lines.push('# HELP verinode_jobs_failed_total Total jobs that failed after all retries.');
    lines.push('# TYPE verinode_jobs_failed_total counter');
    lines.push(`verinode_jobs_failed_total ${this.jobsFailedTotal}`);

    // ── Lease Timeouts ──
    lines.push(
      '# HELP verinode_job_lease_timeouts_total Jobs that timed out while holding a lease.',
    );
    lines.push('# TYPE verinode_job_lease_timeouts_total counter');
    lines.push(`verinode_job_lease_timeouts_total ${this.leaseTimeoutTotal}`);

    lines.push(
      '# HELP verinode_job_lease_expired_total Job leases that expired (reclaimed by another worker).',
    );
    lines.push('# TYPE verinode_job_lease_expired_total counter');
    lines.push(`verinode_job_lease_expired_total ${this.leaseExpiredTotal}`);

    lines.push('# HELP verinode_job_lease_renewal_failures_total Lease renewal failures.');
    lines.push('# TYPE verinode_job_lease_renewal_failures_total counter');
    lines.push(`verinode_job_lease_renewal_failures_total ${this.leaseRenewalFailures}`);

    return `${lines.join('\n')}\n`;
  }

  // ── Reset ────────────────────────────────────────────────────────────────

  reset(): void {
    this.executionRecords = [];
    this.leaseTimeoutTotal = 0;
    this.jobsCompletedTotal = 0;
    this.jobsFailedTotal = 0;
    this.leaseRenewalFailures = 0;
    this.leaseExpiredTotal = 0;
    this.queueDepth = 0;
    this.queueDepthByType.clear();
  }
}
