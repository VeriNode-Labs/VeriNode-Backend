export type BackupType = 'full' | 'differential' | 'incremental' | 'wal';

export interface Queryable {
  query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface BackupRecord {
  backupId: string;
  type: BackupType;
  databaseName: string;
  startedAt: Date;
  completedAt: Date;
  sizeBytes: number;
  checksum: string;
  lsnStart: string;
  lsnEnd: string;
  s3Uri: string;
  kmsKeyId: string;
  tags: Record<string, string>;
}

export interface WalSegment {
  segmentId: string;
  sequence: number;
  archivedAt: Date;
  sizeBytes: number;
  s3Uri: string;
  lsnStart: string;
  lsnEnd: string;
}

export interface RetentionPolicy {
  dailyRetentionDays: number;
  weeklyRetentionMonths: number;
  monthlyRetentionYears: number;
  walRetentionDays: number;
}

export interface PitrTarget {
  targetTime: Date;
  targetTimeline?: number | 'latest';
  stopInclusive?: boolean;
}

export interface PitrPlan {
  targetTime: Date;
  baseBackup: BackupRecord;
  walSegments: WalSegment[];
  estimatedDurationSec: number;
  recoveryConfig: Record<string, string>;
  recoverySignalRequired: boolean;
}

export interface HealthCheck {
  name: string;
  sql: string;
  expectedRows?: number;
  timeoutMs?: number;
}

export interface RestoreTestConfig {
  stagingDbUri: string;
  maxRtoSeconds: number; // default 3600 (1 hour)
  targetBackupId?: string;
  healthChecks: HealthCheck[];
  timeoutMs?: number;
}

export interface RestoreTestResult {
  testId: string;
  startedAt: Date;
  completedAt: Date;
  durationSeconds: number;
  rtoAchieved: boolean;
  healthChecksPassed: boolean;
  findings: string[];
  stagingDbUri: string;
}

export interface DisasterRecoveryMetricsSnapshot {
  backupAgeSeconds: number;
  backupSizeBytes: number;
  rpoLagSeconds: number;
  rtoDurationSeconds: number;
  restoreTestSuccessTotal: number;
  restoreTestFailureTotal: number;
}
