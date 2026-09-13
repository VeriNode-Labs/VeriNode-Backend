import { DisasterRecoveryMetricsRegistry } from './metrics';
import { BackupRecord, WalSegment } from './types';

export interface SchedulerConfig {
  fullBackupCron: string; // e.g. "0 2 * * *" (Daily 02:00 UTC)
  walArchiveFrequencySec: number; // 300 seconds (5 min RPO)
  restoreTestCron: string; // e.g. "0 4 * * 0" (Weekly Sunday 04:00 UTC)
  maxRpoLagSec: number; // 300 seconds
  maxBackupAgeSec: number; // 90000 seconds (25 hours)
}

export const DEFAULT_SCHEDULER_CONFIG: SchedulerConfig = {
  fullBackupCron: '0 2 * * *',
  walArchiveFrequencySec: 300,
  restoreTestCron: '0 4 * * 0',
  maxRpoLagSec: 300,
  maxBackupAgeSec: 25 * 3600, // 90,000s
};

export interface HealthEvaluation {
  healthy: boolean;
  backupAgeSeconds: number;
  rpoLagSeconds: number;
  backupStale: boolean;
  rpoBreached: boolean;
  warnings: string[];
}

export class BackupScheduler {
  constructor(
    private readonly config: SchedulerConfig = DEFAULT_SCHEDULER_CONFIG,
    private readonly metricsRegistry?: DisasterRecoveryMetricsRegistry,
    private readonly nowProvider: () => Date = () => new Date(),
  ) {}

  /**
   * Computes the age of the latest full backup in seconds.
   */
  computeBackupAge(latestBackup: BackupRecord, referenceDate: Date = this.nowProvider()): number {
    const ageMs = referenceDate.getTime() - latestBackup.completedAt.getTime();
    return Math.max(0, ageMs / 1000);
  }

  /**
   * Computes the RPO lag in seconds from the latest WAL segment push to S3.
   */
  computeRpoLag(latestWal: WalSegment, referenceDate: Date = this.nowProvider()): number {
    const lagMs = referenceDate.getTime() - latestWal.archivedAt.getTime();
    return Math.max(0, lagMs / 1000);
  }

  /**
   * Checks if backup age exceeds maximum threshold (25h).
   */
  isBackupStale(latestBackup: BackupRecord, referenceDate: Date = this.nowProvider()): boolean {
    return this.computeBackupAge(latestBackup, referenceDate) > this.config.maxBackupAgeSec;
  }

  /**
   * Checks if RPO lag exceeds the 5-minute (300s) bound.
   */
  isRpoBreached(latestWal: WalSegment, referenceDate: Date = this.nowProvider()): boolean {
    return this.computeRpoLag(latestWal, referenceDate) > this.config.maxRpoLagSec;
  }

  /**
   * Evaluates overall disaster recovery health and updates metrics snapshot.
   */
  evaluateHealth(
    latestBackup: BackupRecord,
    latestWal: WalSegment,
    referenceDate: Date = this.nowProvider(),
  ): HealthEvaluation {
    const backupAgeSeconds = this.computeBackupAge(latestBackup, referenceDate);
    const rpoLagSeconds = this.computeRpoLag(latestWal, referenceDate);
    const backupStale = backupAgeSeconds > this.config.maxBackupAgeSec;
    const rpoBreached = rpoLagSeconds > this.config.maxRpoLagSec;

    const warnings: string[] = [];
    if (backupStale) {
      warnings.push(
        `Latest full backup age is ${backupAgeSeconds.toFixed(0)}s, exceeding limit of ${this.config.maxBackupAgeSec}s`,
      );
    }
    if (rpoBreached) {
      warnings.push(
        `RPO WAL archive lag is ${rpoLagSeconds.toFixed(0)}s, exceeding RPO bound of ${this.config.maxRpoLagSec}s`,
      );
    }

    if (this.metricsRegistry) {
      this.metricsRegistry.updateSnapshot({
        backupAgeSeconds,
        backupSizeBytes: latestBackup.sizeBytes,
        rpoLagSeconds,
      });
    }

    return {
      healthy: !backupStale && !rpoBreached,
      backupAgeSeconds,
      rpoLagSeconds,
      backupStale,
      rpoBreached,
      warnings,
    };
  }

  /**
   * Determines if the current time matches the scheduled 02:00 UTC full backup window.
   */
  isDailyBackupWindow(date: Date = this.nowProvider()): boolean {
    return date.getUTCHours() === 2 && date.getUTCMinutes() === 0;
  }

  /**
   * Determines if the current time matches the weekly staging restore window (Sunday 04:00 UTC).
   */
  isWeeklyRestoreTestWindow(date: Date = this.nowProvider()): boolean {
    return date.getUTCDay() === 0 && date.getUTCHours() === 4 && date.getUTCMinutes() === 0;
  }
}
