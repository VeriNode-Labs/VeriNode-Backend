import { BackupRecord, RetentionPolicy, WalSegment } from './types';

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  dailyRetentionDays: 30,
  weeklyRetentionMonths: 6, // 180 days
  monthlyRetentionYears: 2, // 730 days
  walRetentionDays: 30,
};

export type RetentionTier = 'monthly' | 'weekly' | 'daily';

export class RetentionManager {
  constructor(private readonly policy: RetentionPolicy = DEFAULT_RETENTION_POLICY) {}

  /**
   * Determine the highest retention tier that applies to a given backup.
   * - Monthly tier: Backups completed on the 1st day of the month (or tagged 'monthly').
   * - Weekly tier: Backups completed on Sunday (UTC day 0) (or tagged 'weekly').
   * - Daily tier: All other daily full backups.
   */
  classifyTier(backup: BackupRecord): RetentionTier {
    if (backup.tags?.tier === 'monthly') return 'monthly';
    if (backup.tags?.tier === 'weekly') return 'weekly';

    const date = new Date(backup.completedAt);
    if (date.getUTCDate() === 1) {
      return 'monthly';
    }
    if (date.getUTCDay() === 0) {
      return 'weekly';
    }
    return 'daily';
  }

  /**
   * Computes the exact expiration timestamp for a backup.
   */
  getExpirationDate(backup: BackupRecord): Date {
    const tier = this.classifyTier(backup);
    const completedMs = backup.completedAt.getTime();

    switch (tier) {
      case 'monthly': {
        const days = this.policy.monthlyRetentionYears * 365;
        return new Date(completedMs + days * 24 * 60 * 60 * 1000);
      }
      case 'weekly': {
        const days = this.policy.weeklyRetentionMonths * 30;
        return new Date(completedMs + days * 24 * 60 * 60 * 1000);
      }
      case 'daily':
      default: {
        return new Date(completedMs + this.policy.dailyRetentionDays * 24 * 60 * 60 * 1000);
      }
    }
  }

  /**
   * Partitions backups into retained and expired sets relative to a reference date.
   */
  filterExpiredBackups(
    backups: BackupRecord[],
    referenceDate: Date = new Date(),
  ): { retained: BackupRecord[]; expired: BackupRecord[] } {
    const retained: BackupRecord[] = [];
    const expired: BackupRecord[] = [];

    for (const backup of backups) {
      const expiration = this.getExpirationDate(backup);
      if (referenceDate.getTime() >= expiration.getTime()) {
        expired.push(backup);
      } else {
        retained.push(backup);
      }
    }

    return { retained, expired };
  }

  /**
   * Partitions WAL segments into retained and expired sets.
   * WAL segments are retained if:
   * 1. They are within the WAL retention window (e.g. 30 days).
   * 2. AND they are newer than the oldest retained base backup required for PITR.
   */
  filterExpiredWal(
    walSegments: WalSegment[],
    oldestRetainedBackupTime?: Date,
    referenceDate: Date = new Date(),
  ): { retained: WalSegment[]; expired: WalSegment[] } {
    const walRetentionCutoffMs =
      referenceDate.getTime() - this.policy.walRetentionDays * 24 * 60 * 60 * 1000;
    const oldestBackupMs = oldestRetainedBackupTime?.getTime() ?? walRetentionCutoffMs;

    // A WAL file must be kept if it is needed by any retained backup or within the 30-day window
    const retentionBoundaryMs = Math.min(walRetentionCutoffMs, oldestBackupMs);

    const retained: WalSegment[] = [];
    const expired: WalSegment[] = [];

    for (const wal of walSegments) {
      if (wal.archivedAt.getTime() >= retentionBoundaryMs) {
        retained.push(wal);
      } else {
        expired.push(wal);
      }
    }

    return { retained, expired };
  }
}
