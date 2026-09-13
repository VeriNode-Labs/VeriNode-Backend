import { randomUUID } from 'crypto';
import { DisasterRecoveryMetricsRegistry } from './metrics';
import {
  BackupRecord,
  HealthCheck,
  Queryable,
  RestoreTestConfig,
  RestoreTestResult,
} from './types';

export const DEFAULT_RESTORE_HEALTH_CHECKS: HealthCheck[] = [
  {
    name: 'read connectivity probe',
    sql: 'SELECT 1 AS ok',
    expectedRows: 1,
    timeoutMs: 5_000,
  },
  {
    name: 'core node_status table restored',
    sql: "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'node_status'",
    expectedRows: 1,
    timeoutMs: 5_000,
  },
  {
    name: 'core reputations table restored',
    sql: "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'reputations'",
    expectedRows: 1,
    timeoutMs: 5_000,
  },
  {
    name: 'temporary table write isolation check',
    sql: 'CREATE TEMP TABLE _dr_probe (id int); DROP TABLE _dr_probe; SELECT 1 AS write_ok',
    expectedRows: 1,
    timeoutMs: 5_000,
  },
];

export const DEFAULT_RESTORE_TEST_CONFIG: RestoreTestConfig = {
  stagingDbUri: 'postgres://staging_user@localhost:5433/verinode_staging',
  maxRtoSeconds: 3600, // RTO < 1 hour
  healthChecks: DEFAULT_RESTORE_HEALTH_CHECKS,
  timeoutMs: 15_000,
};

export type RestoreAlertSink = (alert: {
  testId: string;
  backupId: string;
  severity: 'warning' | 'critical';
  summary: string;
  findings: string[];
}) => Promise<void> | void;

export class StagingRestoreTester {
  constructor(
    private readonly config: RestoreTestConfig = DEFAULT_RESTORE_TEST_CONFIG,
    private readonly metricsRegistry?: DisasterRecoveryMetricsRegistry,
    private readonly alertSink?: RestoreAlertSink,
    private readonly nowProvider: () => Date = () => new Date(),
  ) {}

  async runRestoreTest(
    stagingDb: Queryable,
    backup: BackupRecord,
    simulatedRestoreDurationSec?: number,
  ): Promise<RestoreTestResult> {
    const startedAt = this.nowProvider();
    const findings: string[] = [];
    const testId = randomUUID();

    // Check backup validity before health checks
    if (!backup.backupId || !backup.checksum) {
      findings.push('Invalid backup record: missing backupId or checksum');
    }

    // Run health check suite against the restored database
    for (const check of this.config.healthChecks) {
      try {
        const queryPromise = stagingDb.query(check.sql);
        const timeoutMs = check.timeoutMs ?? 10_000;

        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Check '${check.name}' timed out after ${timeoutMs}ms`)),
            timeoutMs,
          );
        });

        const result = await Promise.race([queryPromise, timeoutPromise]).finally(() => {
          if (timer) clearTimeout(timer);
        });

        const rowCount = result.rowCount ?? result.rows?.length ?? 0;
        if (typeof check.expectedRows === 'number' && rowCount !== check.expectedRows) {
          findings.push(`${check.name}: expected ${check.expectedRows} rows, received ${rowCount}`);
        }
      } catch (err) {
        findings.push(`${check.name}: ${(err as Error).message}`);
      }
    }

    const completedAt = this.nowProvider();
    const actualDurationSec = (completedAt.getTime() - startedAt.getTime()) / 1000;
    const durationSeconds = simulatedRestoreDurationSec ?? actualDurationSec;

    // Verify RTO threshold (< 1 hour = 3600 seconds)
    const rtoAchieved = durationSeconds <= this.config.maxRtoSeconds;
    if (!rtoAchieved) {
      findings.push(
        `RTO limit breached: recovery took ${durationSeconds.toFixed(1)}s (max allowed: ${this.config.maxRtoSeconds}s)`,
      );
    }

    const healthChecksPassed = findings.length === 0;

    const result: RestoreTestResult = {
      testId,
      startedAt,
      completedAt,
      durationSeconds,
      rtoAchieved,
      healthChecksPassed,
      findings,
      stagingDbUri: this.config.stagingDbUri,
    };

    if (this.metricsRegistry) {
      if (healthChecksPassed && rtoAchieved) {
        this.metricsRegistry.recordRestoreSuccess(durationSeconds);
      } else {
        this.metricsRegistry.recordRestoreFailure(durationSeconds);
      }
    }

    if (!healthChecksPassed || !rtoAchieved) {
      await this.alertSink?.({
        testId,
        backupId: backup.backupId,
        severity: healthChecksPassed ? 'warning' : 'critical',
        summary: `Staging restore verification failed for backup ${backup.backupId}`,
        findings,
      });
    }

    return result;
  }
}
