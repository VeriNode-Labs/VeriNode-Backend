import assert from 'assert';
import {
  BackupManifest,
  BackupVerificationService,
  persistBackupVerificationResult,
  Queryable,
} from '../../src/database/backup_verification';

class FakeDb implements Queryable {
  constructor(private readonly responses: Array<{ rows: any[]; rowCount?: number } | Error>) {}
  async query() {
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response ?? { rows: [{ ok: 1 }], rowCount: 1 };
  }
}

const now = new Date('2026-07-25T03:00:00.000Z');
const manifest: BackupManifest = {
  backupId: 'backup-2026-07-25',
  startedAt: new Date('2026-07-25T02:00:00.000Z'),
  completedAt: new Date('2026-07-25T02:10:00.000Z'),
  databaseName: 'verinode',
  schemaVersion: '011',
  objectCount: 42,
  sizeBytes: 1024,
  checksum: 'a'.repeat(64),
};

async function passesFreshRestore() {
  const alerts: any[] = [];
  const service = new BackupVerificationService(
    {
      maxBackupAgeMs: 24 * 60 * 60 * 1000,
      minObjectCount: 1,
      minSizeBytes: 1,
      requiredSchemaVersion: '011',
      restoreChecks: [{ name: 'read probe', sql: 'SELECT 1', expectedRows: 1 }],
    },
    (alert) => alerts.push(alert),
    () => now,
  );

  const result = await service.verify(manifest, new FakeDb([{ rows: [{ ok: 1 }], rowCount: 1 }]));
  assert.equal(result.status, 'passed');
  assert.equal(result.findings.length, 0);
  assert.equal(alerts.length, 0);
  assert.match(service.renderPrometheus(result), /db_backup_verification_last_failed 0/);
}

async function alertsOnStaleBackupAndRestoreFailure() {
  const alerts: any[] = [];
  const service = new BackupVerificationService(
    {
      maxBackupAgeMs: 10,
      minObjectCount: 100,
      minSizeBytes: 2048,
      requiredSchemaVersion: '012',
      restoreChecks: [{ name: 'table probe', sql: 'SELECT * FROM missing', expectedRows: 1 }],
    },
    (alert) => alerts.push(alert),
    () => now,
  );

  const result = await service.verify(manifest, new FakeDb([new Error('relation does not exist')]));
  assert.equal(result.status, 'failed');
  assert.equal(result.severity, 'critical');
  assert.equal(alerts.length, 1);
  assert.ok(result.findings.some((finding) => finding.includes('older than policy')));
  assert.ok(result.findings.some((finding) => finding.includes('relation does not exist')));
}

(async () => {
  await passesFreshRestore();
  await alertsOnStaleBackupAndRestoreFailure();
  const writes: any[] = [];
  await persistBackupVerificationResult(
    {
      query: async (_sql, params) => {
        writes.push(params);
        return { rows: [], rowCount: 1 };
      },
    },
    {
      verificationId: 'v1',
      backupId: 'b1',
      checkedAt: now,
      status: 'passed',
      severity: 'info',
      durationMs: 1,
      findings: [],
    },
  );
  assert.equal(writes.length, 1);
  console.log('backup_verification tests passed');
})();
