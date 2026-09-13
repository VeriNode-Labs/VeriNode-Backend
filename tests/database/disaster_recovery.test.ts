import assert from 'assert';
import {
  BackupRecord,
  BackupScheduler,
  DEFAULT_RESTORE_HEALTH_CHECKS,
  DisasterRecoveryMetricsRegistry,
  PitrManager,
  Queryable,
  RetentionManager,
  StagingRestoreTester,
  WalSegment,
} from '../../src/database/disaster_recovery';

class MockDatabase implements Queryable {
  constructor(
    private readonly handler?: (sql: string) => { rows: any[]; rowCount?: number } | Error,
  ) {}

  async query<T = any>(sql: string): Promise<{ rows: T[]; rowCount?: number | null }> {
    if (this.handler) {
      const res = this.handler(sql);
      if (res instanceof Error) throw res;
      return res as { rows: T[]; rowCount?: number };
    }
    return { rows: [{ ok: 1 }] as unknown as T[], rowCount: 1 };
  }
}

const mockNow = new Date('2026-09-13T02:00:00.000Z');

function createSampleBackup(overrides: Partial<BackupRecord> = {}): BackupRecord {
  return {
    backupId: 'backup-2026-09-12-0200',
    type: 'full',
    databaseName: 'verinode',
    startedAt: new Date('2026-09-12T01:50:00.000Z'),
    completedAt: new Date('2026-09-12T02:00:00.000Z'),
    sizeBytes: 150 * 1024 * 1024, // 150MB
    checksum: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    lsnStart: '0/1000000',
    lsnEnd: '0/2000000',
    s3Uri: 's3://verinode-backups/backups/verinode/backup-2026-09-12-0200.tar.lz4',
    kmsKeyId: 'arn:aws:kms:us-east-1:123456789012:key/verinode-backup-master-key',
    tags: {},
    ...overrides,
  };
}

function createSampleWal(sequence: number, archivedAt: Date): WalSegment {
  return {
    segmentId: `00000001000000000000000${sequence}`,
    sequence,
    archivedAt,
    sizeBytes: 16 * 1024 * 1024,
    s3Uri: `s3://verinode-backups/archive/00000001000000000000000${sequence}`,
    lsnStart: `0/${sequence}000000`,
    lsnEnd: `0/${sequence + 1}000000`,
  };
}

async function testRetentionManager() {
  const retention = new RetentionManager({
    dailyRetentionDays: 30,
    weeklyRetentionMonths: 6, // 180d
    monthlyRetentionYears: 2, // 730d
    walRetentionDays: 30,
  });

  // 1. Classification
  const dailyBackup = createSampleBackup({
    completedAt: new Date('2026-09-08T02:00:00.000Z'), // Tuesday
  });
  assert.strictEqual(retention.classifyTier(dailyBackup), 'daily');

  const weeklyBackup = createSampleBackup({
    completedAt: new Date('2026-09-06T02:00:00.000Z'), // Sunday
  });
  assert.strictEqual(retention.classifyTier(weeklyBackup), 'weekly');

  const monthlyBackup = createSampleBackup({
    completedAt: new Date('2026-09-01T02:00:00.000Z'), // 1st of month
  });
  assert.strictEqual(retention.classifyTier(monthlyBackup), 'monthly');

  // Tag override
  const taggedMonthly = createSampleBackup({
    completedAt: new Date('2026-09-08T02:00:00.000Z'),
    tags: { tier: 'monthly' },
  });
  assert.strictEqual(retention.classifyTier(taggedMonthly), 'monthly');

  // 2. Expiration Dates
  const expDaily = retention.getExpirationDate(dailyBackup);
  const diffDailyDays = (expDaily.getTime() - dailyBackup.completedAt.getTime()) / (24 * 3600 * 1000);
  assert.strictEqual(diffDailyDays, 30);

  const expWeekly = retention.getExpirationDate(weeklyBackup);
  const diffWeeklyDays = (expWeekly.getTime() - weeklyBackup.completedAt.getTime()) / (24 * 3600 * 1000);
  assert.strictEqual(diffWeeklyDays, 180);

  const expMonthly = retention.getExpirationDate(monthlyBackup);
  const diffMonthlyDays = (expMonthly.getTime() - monthlyBackup.completedAt.getTime()) / (24 * 3600 * 1000);
  assert.strictEqual(diffMonthlyDays, 730);

  // 3. Filter Expired Backups
  const oldDailyBackup33d = createSampleBackup({
    backupId: 'backup-daily-old-33d',
    completedAt: new Date(mockNow.getTime() - 33 * 24 * 3600 * 1000), // 33 days ago (Tuesday, daily)
    tags: { tier: 'daily' },
  });
  const recentBackup5d = createSampleBackup({
    backupId: 'backup-daily-recent-5d',
    completedAt: new Date(mockNow.getTime() - 5 * 24 * 3600 * 1000), // 5 days ago (Tuesday, daily)
    tags: { tier: 'daily' },
  });
  const weeklyBackup60d = createSampleBackup({
    backupId: 'backup-weekly-60d',
    completedAt: new Date('2026-07-12T02:00:00.000Z'), // Sunday, ~60 days ago
    tags: { tier: 'weekly' },
  });

  const { retained, expired } = retention.filterExpiredBackups(
    [oldDailyBackup33d, recentBackup5d, weeklyBackup60d],
    mockNow,
  );
  assert.strictEqual(retained.length, 2);
  assert.strictEqual(expired.length, 1);
  assert.strictEqual(expired[0].backupId, oldDailyBackup33d.backupId);

  // 4. Filter Expired WAL
  const recentWal = createSampleWal(1, new Date(mockNow.getTime() - 2 * 3600 * 1000));
  const oldWal = createSampleWal(2, new Date(mockNow.getTime() - 32 * 24 * 3600 * 1000));
  const walPartition = retention.filterExpiredWal([recentWal, oldWal], recentBackup5d.completedAt, mockNow);
  assert.strictEqual(walPartition.retained.length, 1);
  assert.strictEqual(walPartition.expired.length, 1);
  assert.strictEqual(walPartition.retained[0].sequence, 1);
}

async function testPitrManager() {
  const pitr = new PitrManager(30, () => mockNow);

  const baseBackup = createSampleBackup({
    startedAt: new Date('2026-09-12T01:55:00.000Z'),
    completedAt: new Date('2026-09-12T02:00:00.000Z'),
  });

  // 1. Validation Failures
  const futureTarget = { targetTime: new Date('2026-09-14T00:00:00.000Z') };
  const futureVal = pitr.validateTargetTime(futureTarget, [baseBackup], mockNow);
  assert.strictEqual(futureVal.valid, false);
  assert.match(futureVal.reason!, /cannot be in the future/i);

  const staleTarget = { targetTime: new Date(mockNow.getTime() - 35 * 24 * 3600 * 1000) };
  const staleVal = pitr.validateTargetTime(staleTarget, [baseBackup], mockNow);
  assert.strictEqual(staleVal.valid, false);
  assert.match(staleVal.reason!, /older than the 30-day retention window/i);

  const noBaseTarget = { targetTime: new Date('2026-09-11T00:00:00.000Z') };
  const noBaseVal = pitr.validateTargetTime(noBaseTarget, [baseBackup], mockNow);
  assert.strictEqual(noBaseVal.valid, false);
  assert.match(noBaseVal.reason!, /no completed base backup found/i);

  // 2. Planning Success
  const validTarget = {
    targetTime: new Date('2026-09-12T02:15:00.000Z'),
    targetTimeline: 'latest',
  };
  const wal1 = createSampleWal(1, new Date('2026-09-12T01:58:00.000Z'));
  const wal2 = createSampleWal(2, new Date('2026-09-12T02:05:00.000Z'));
  const wal3 = createSampleWal(3, new Date('2026-09-12T02:12:00.000Z'));

  const plan = pitr.createPlan(validTarget, [baseBackup], [wal1, wal2, wal3], mockNow);
  assert.strictEqual(plan.baseBackup.backupId, baseBackup.backupId);
  assert.strictEqual(plan.walSegments.length, 3);
  assert.strictEqual(plan.recoverySignalRequired, true);
  assert.strictEqual(plan.recoveryConfig.recovery_target_action, "'promote'");
  assert.strictEqual(plan.recoveryConfig.recovery_target_timeline, "'latest'");
  assert.match(plan.recoveryConfig.recovery_target_time, /2026-09-12 02:15:00/);

  // Recovery conf serialization
  const confText = pitr.renderPostgresRecoveryConf(plan.recoveryConfig);
  assert.match(confText, /restore_command = pgbackrest/);
  assert.match(confText, /recovery_target_time = '2026-09-12 02:15:00(?:\.000)?\+00'/);

  // 3. Continuity Error Detection
  const walGap = createSampleWal(5, new Date('2026-09-12T02:10:00.000Z')); // sequence jump 1 -> 5
  assert.throws(
    () => pitr.createPlan(validTarget, [baseBackup], [wal1, walGap], mockNow),
    /discontinuity detected/i,
  );
}

async function testStagingRestoreTester() {
  const metricsRegistry = new DisasterRecoveryMetricsRegistry();
  const alerts: any[] = [];
  const alertSink = (alert: any) => {
    alerts.push(alert);
  };

  const tester = new StagingRestoreTester(
    {
      stagingDbUri: 'postgres://staging_user@localhost:5433/verinode_staging',
      maxRtoSeconds: 3600,
      healthChecks: DEFAULT_RESTORE_HEALTH_CHECKS,
    },
    metricsRegistry,
    alertSink,
    () => mockNow,
  );

  const backup = createSampleBackup();

  // 1. Success case
  const dbPass = new MockDatabase(() => ({ rows: [{ ok: 1 }], rowCount: 1 }));
  const passResult = await tester.runRestoreTest(dbPass, backup, 1800); // 30 min simulated duration
  assert.strictEqual(passResult.healthChecksPassed, true);
  assert.strictEqual(passResult.rtoAchieved, true);
  assert.strictEqual(passResult.findings.length, 0);
  assert.strictEqual(metricsRegistry.getSnapshot().restoreTestSuccessTotal, 1);
  assert.strictEqual(metricsRegistry.getSnapshot().rtoDurationSeconds, 1800);
  assert.strictEqual(alerts.length, 0);

  // 2. Health check failure case
  const dbFail = new MockDatabase((sql) => {
    if (sql.includes('reputations')) {
      return new Error('relation "reputations" does not exist');
    }
    return { rows: [{ ok: 1 }], rowCount: 1 };
  });
  const failResult = await tester.runRestoreTest(dbFail, backup, 1200);
  assert.strictEqual(failResult.healthChecksPassed, false);
  assert.strictEqual(metricsRegistry.getSnapshot().restoreTestFailureTotal, 1);
  assert.strictEqual(alerts.length, 1);
  assert.strictEqual(alerts[0].severity, 'critical');
  assert.ok(failResult.findings.some((f) => f.includes('reputations')));

  // 3. RTO Breach case (> 3600 seconds)
  const breachResult = await tester.runRestoreTest(dbPass, backup, 4000); // 4000s > 3600s RTO limit
  assert.strictEqual(breachResult.rtoAchieved, false);
  assert.ok(breachResult.findings.some((f) => f.includes('RTO limit breached')));
  assert.strictEqual(alerts.length, 2);
}

async function testBackupScheduler() {
  const metricsRegistry = new DisasterRecoveryMetricsRegistry();
  const scheduler = new BackupScheduler(
    {
      fullBackupCron: '0 2 * * *',
      walArchiveFrequencySec: 300,
      restoreTestCron: '0 4 * * 0',
      maxRpoLagSec: 300,
      maxBackupAgeSec: 90000,
    },
    metricsRegistry,
    () => mockNow,
  );

  // 1. Window checking
  const backupWindowDate = new Date('2026-09-13T02:00:00.000Z');
  const nonBackupWindowDate = new Date('2026-09-13T03:15:00.000Z');
  assert.strictEqual(scheduler.isDailyBackupWindow(backupWindowDate), true);
  assert.strictEqual(scheduler.isDailyBackupWindow(nonBackupWindowDate), false);

  const sundayRestoreDate = new Date('2026-09-13T04:00:00.000Z'); // Sunday 04:00
  const mondayRestoreDate = new Date('2026-09-14T04:00:00.000Z'); // Monday 04:00
  assert.strictEqual(scheduler.isWeeklyRestoreTestWindow(sundayRestoreDate), true);
  assert.strictEqual(scheduler.isWeeklyRestoreTestWindow(mondayRestoreDate), false);

  // 2. RPO Lag and Staleness calculations
  const freshBackup = createSampleBackup({
    completedAt: new Date(mockNow.getTime() - 3600 * 1000), // 1 hour old
  });
  const freshWal = createSampleWal(10, new Date(mockNow.getTime() - 120 * 1000)); // 2 min lag (< 300s)

  const healthyEval = scheduler.evaluateHealth(freshBackup, freshWal, mockNow);
  assert.strictEqual(healthyEval.healthy, true);
  assert.strictEqual(healthyEval.rpoBreached, false);
  assert.strictEqual(healthyEval.backupStale, false);
  assert.strictEqual(healthyEval.warnings.length, 0);

  // 3. Breached RPO
  const laggyWal = createSampleWal(11, new Date(mockNow.getTime() - 400 * 1000)); // 400s lag (> 300s)
  const rpoBreachedEval = scheduler.evaluateHealth(freshBackup, laggyWal, mockNow);
  assert.strictEqual(rpoBreachedEval.healthy, false);
  assert.strictEqual(rpoBreachedEval.rpoBreached, true);
  assert.ok(rpoBreachedEval.warnings.some((w) => w.includes('RPO WAL archive lag')));

  // 4. Stale backup
  const staleBackup = createSampleBackup({
    completedAt: new Date(mockNow.getTime() - 95000 * 1000), // 95,000s > 90,000s
  });
  const staleEval = scheduler.evaluateHealth(staleBackup, freshWal, mockNow);
  assert.strictEqual(staleEval.healthy, false);
  assert.strictEqual(staleEval.backupStale, true);
  assert.ok(staleEval.warnings.some((w) => w.includes('backup age')));

  // 5. Prometheus Metrics Rendering
  const prometheusText = metricsRegistry.renderPrometheus();
  assert.match(prometheusText, /verinode_backup_age_seconds/);
  assert.match(prometheusText, /verinode_backup_size_bytes/);
  assert.match(prometheusText, /verinode_rpo_lag_seconds/);
  assert.match(prometheusText, /verinode_rto_duration_seconds/);
  assert.match(prometheusText, /verinode_restore_test_success_total/);
  assert.match(prometheusText, /verinode_restore_test_failure_total/);
}

(async () => {
  try {
    await testRetentionManager();
    await testPitrManager();
    await testStagingRestoreTester();
    await testBackupScheduler();
  } catch (err) {
    console.error('Test failure:', err);
    process.exit(1);
  }
})();
