import { createHash } from 'crypto';
import { metrics } from '@opentelemetry/api';

export type BackupVerificationStatus = 'passed' | 'failed';
export type BackupVerificationSeverity = 'info' | 'warning' | 'critical';

export interface Queryable {
  query<T = any>(text: string, params?: any[]): Promise<{ rows: T[]; rowCount?: number | null }>;
}

export interface BackupManifest {
  backupId: string;
  startedAt: Date;
  completedAt: Date;
  databaseName: string;
  schemaVersion: string;
  objectCount: number;
  sizeBytes: number;
  checksum: string;
}

export interface RestoreValidationCheck {
  name: string;
  sql: string;
  expectedRows?: number;
  timeoutMs?: number;
}

export interface BackupVerificationPolicy {
  maxBackupAgeMs: number;
  minObjectCount: number;
  minSizeBytes: number;
  requiredSchemaVersion: string;
  restoreChecks: RestoreValidationCheck[];
}

export interface BackupVerificationResult {
  verificationId: string;
  backupId: string;
  status: BackupVerificationStatus;
  severity: BackupVerificationSeverity;
  durationMs: number;
  findings: string[];
  checkedAt: Date;
}

export interface BackupVerificationAlert {
  verificationId: string;
  backupId: string;
  severity: BackupVerificationSeverity;
  summary: string;
  findings: string[];
}

export type AlertSink = (alert: BackupVerificationAlert) => Promise<void> | void;

export async function persistBackupVerificationResult(
  database: Queryable,
  result: BackupVerificationResult,
): Promise<void> {
  await database.query(
    `INSERT INTO database_backup_verifications
       (verification_id, backup_id, checked_at, status, severity, duration_ms, findings)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (verification_id) DO NOTHING`,
    [
      result.verificationId,
      result.backupId,
      result.checkedAt,
      result.status,
      result.severity,
      result.durationMs,
      JSON.stringify(result.findings),
    ],
  );
}

const meter = metrics.getMeter('database_backup_verification', '1.0.0');
const runsTotal = meter.createCounter('db_backup_verification_runs_total');
const failuresTotal = meter.createCounter('db_backup_verification_failures_total');
const durationMs = meter.createHistogram('db_backup_verification_duration_ms', { unit: 'ms' });

export const DEFAULT_BACKUP_VERIFICATION_POLICY: BackupVerificationPolicy = {
  maxBackupAgeMs: 26 * 60 * 60 * 1000,
  minObjectCount: 1,
  minSizeBytes: 1,
  requiredSchemaVersion: 'latest',
  restoreChecks: [
    { name: 'database accepts reads', sql: 'SELECT 1 AS ok', expectedRows: 1, timeoutMs: 5_000 },
    {
      name: 'core reputation table restored',
      sql: "SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'reputations'",
      expectedRows: 1,
      timeoutMs: 5_000,
    },
  ],
};

export function createVerificationId(manifest: BackupManifest, checkedAt: Date): string {
  return createHash('sha256')
    .update(`${manifest.backupId}:${manifest.checksum}:${checkedAt.toISOString()}`)
    .digest('hex')
    .slice(0, 32);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, checkName: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`restore check timed out: ${checkName}`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

export class BackupVerificationService {
  constructor(
    private readonly policy: BackupVerificationPolicy = DEFAULT_BACKUP_VERIFICATION_POLICY,
    private readonly alertSink?: AlertSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async verify(
    manifest: BackupManifest,
    restoredDatabase: Queryable,
  ): Promise<BackupVerificationResult> {
    const started = performance.now();
    const checkedAt = this.now();
    const findings: string[] = [];

    this.validateManifest(manifest, checkedAt, findings);
    await this.runRestoreChecks(restoredDatabase, findings);

    const status: BackupVerificationStatus = findings.length === 0 ? 'passed' : 'failed';
    const severity: BackupVerificationSeverity = status === 'passed' ? 'info' : 'critical';
    const result: BackupVerificationResult = {
      verificationId: createVerificationId(manifest, checkedAt),
      backupId: manifest.backupId,
      status,
      severity,
      durationMs: performance.now() - started,
      findings,
      checkedAt,
    };

    runsTotal.add(1, { status });
    durationMs.record(result.durationMs, { status });

    if (status === 'failed') {
      failuresTotal.add(1, { severity });
      await this.alertSink?.({
        verificationId: result.verificationId,
        backupId: result.backupId,
        severity,
        summary: `Backup restore verification failed for ${result.backupId}`,
        findings,
      });
    }

    return result;
  }

  renderPrometheus(result: BackupVerificationResult): string {
    const failed = result.status === 'failed' ? 1 : 0;
    return [
      '# HELP db_backup_verification_last_success Unix timestamp of the latest successful restore verification.',
      '# TYPE db_backup_verification_last_success gauge',
      `db_backup_verification_last_success ${result.status === 'passed' ? Math.floor(result.checkedAt.getTime() / 1000) : 0}`,
      '# HELP db_backup_verification_last_failed Whether the latest restore verification failed.',
      '# TYPE db_backup_verification_last_failed gauge',
      `db_backup_verification_last_failed ${failed}`,
      '# HELP db_backup_verification_duration_ms Duration of the latest restore verification in milliseconds.',
      '# TYPE db_backup_verification_duration_ms gauge',
      `db_backup_verification_duration_ms ${result.durationMs.toFixed(3)}`,
    ].join('\n');
  }

  private validateManifest(manifest: BackupManifest, checkedAt: Date, findings: string[]): void {
    if (!manifest.backupId.trim()) findings.push('backup id is empty');
    if (manifest.completedAt.getTime() > checkedAt.getTime())
      findings.push('backup completion time is in the future');
    if (checkedAt.getTime() - manifest.completedAt.getTime() > this.policy.maxBackupAgeMs)
      findings.push('backup is older than policy allows');
    if (manifest.objectCount < this.policy.minObjectCount)
      findings.push('backup object count is below policy minimum');
    if (manifest.sizeBytes < this.policy.minSizeBytes)
      findings.push('backup size is below policy minimum');
    if (
      this.policy.requiredSchemaVersion !== 'latest' &&
      manifest.schemaVersion !== this.policy.requiredSchemaVersion
    )
      findings.push('backup schema version does not match required version');
    if (!/^[a-f0-9]{32,128}$/i.test(manifest.checksum))
      findings.push('backup checksum is missing or invalid');
  }

  private async runRestoreChecks(restoredDatabase: Queryable, findings: string[]): Promise<void> {
    for (const check of this.policy.restoreChecks) {
      try {
        const result = await withTimeout(
          restoredDatabase.query(check.sql),
          check.timeoutMs ?? 10_000,
          check.name,
        );
        if (
          typeof check.expectedRows === 'number' &&
          (result.rowCount ?? result.rows.length) !== check.expectedRows
        ) {
          findings.push(`${check.name}: expected ${check.expectedRows} rows`);
        }
      } catch (err) {
        findings.push(`${check.name}: ${(err as Error).message}`);
      }
    }
  }
}
