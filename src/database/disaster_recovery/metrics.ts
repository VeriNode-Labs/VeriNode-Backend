import { metrics } from '@opentelemetry/api';
import { DisasterRecoveryMetricsSnapshot } from './types';

const meter = metrics.getMeter('verinode_disaster_recovery', '1.0.0');

export const backupAgeGauge = meter.createObservableGauge('verinode_backup_age_seconds', {
  description: 'Age of latest database full backup in seconds',
  unit: 's',
});

export const backupSizeGauge = meter.createObservableGauge('verinode_backup_size_bytes', {
  description: 'Size of latest database full backup in bytes',
  unit: 'By',
});

export const rpoLagGauge = meter.createObservableGauge('verinode_rpo_lag_seconds', {
  description: 'Current RPO lag between live transactions and archived WAL segments in S3',
  unit: 's',
});

export const rtoDurationGauge = meter.createObservableGauge('verinode_rto_duration_seconds', {
  description: 'Duration taken by latest staging restore test in seconds',
  unit: 's',
});

export const restoreTestSuccessCounter = meter.createCounter('verinode_restore_test_success_total', {
  description: 'Cumulative count of successful automated staging restore tests',
});

export const restoreTestFailureCounter = meter.createCounter('verinode_restore_test_failure_total', {
  description: 'Cumulative count of failed automated staging restore tests',
});

export class DisasterRecoveryMetricsRegistry {
  private snapshot: DisasterRecoveryMetricsSnapshot = {
    backupAgeSeconds: 0,
    backupSizeBytes: 0,
    rpoLagSeconds: 0,
    rtoDurationSeconds: 0,
    restoreTestSuccessTotal: 0,
    restoreTestFailureTotal: 0,
  };

  updateSnapshot(partial: Partial<DisasterRecoveryMetricsSnapshot>): void {
    this.snapshot = {
      ...this.snapshot,
      ...partial,
    };
  }

  getSnapshot(): DisasterRecoveryMetricsSnapshot {
    return { ...this.snapshot };
  }

  recordRestoreSuccess(durationSeconds: number): void {
    this.snapshot.rtoDurationSeconds = durationSeconds;
    this.snapshot.restoreTestSuccessTotal += 1;
    restoreTestSuccessCounter.add(1);
  }

  recordRestoreFailure(durationSeconds: number): void {
    this.snapshot.rtoDurationSeconds = durationSeconds;
    this.snapshot.restoreTestFailureTotal += 1;
    restoreTestFailureCounter.add(1);
  }

  renderPrometheus(): string {
    const s = this.snapshot;
    return [
      '# HELP verinode_backup_age_seconds Age of latest database full backup in seconds.',
      '# TYPE verinode_backup_age_seconds gauge',
      `verinode_backup_age_seconds ${s.backupAgeSeconds.toFixed(2)}`,
      '# HELP verinode_backup_size_bytes Size of latest database full backup in bytes.',
      '# TYPE verinode_backup_size_bytes gauge',
      `verinode_backup_size_bytes ${Math.floor(s.backupSizeBytes)}`,
      '# HELP verinode_rpo_lag_seconds Current RPO lag between live transactions and archived WAL segments in S3.',
      '# TYPE verinode_rpo_lag_seconds gauge',
      `verinode_rpo_lag_seconds ${s.rpoLagSeconds.toFixed(2)}`,
      '# HELP verinode_rto_duration_seconds Duration taken by latest staging restore test in seconds.',
      '# TYPE verinode_rto_duration_seconds gauge',
      `verinode_rto_duration_seconds ${s.rtoDurationSeconds.toFixed(2)}`,
      '# HELP verinode_restore_test_success_total Cumulative count of successful automated staging restore tests.',
      '# TYPE verinode_restore_test_success_total counter',
      `verinode_restore_test_success_total ${s.restoreTestSuccessTotal}`,
      '# HELP verinode_restore_test_failure_total Cumulative count of failed automated staging restore tests.',
      '# TYPE verinode_restore_test_failure_total counter',
      `verinode_restore_test_failure_total ${s.restoreTestFailureTotal}`,
    ].join('\n');
  }
}
