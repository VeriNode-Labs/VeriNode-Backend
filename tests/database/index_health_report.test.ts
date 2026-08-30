/**
 * issue #197 — reporting, API and scheduling (Gate 4).
 *
 * Pins: the report shows an excluded PK case AND a genuine candidate with its
 * DDL; the API returns the latest run read-only and 503s when nothing has run;
 * the cron cadence resolves from env (off-peak, configurable — not hard-coded);
 * the monthly email goes out once per recipient with the right subject.
 */

import { strict as assert } from 'assert';
import {
  IndexHealthReporter,
  renderIndexHealthReport,
} from '../../src/database/index_health/report';
import { registerIndexHealthRoutes } from '../../src/database/index_health/routes';
import {
  DEFAULT_INDEX_HEALTH_CRON,
  IndexHealthMonitor,
  createIndexHealthMonitorFromEnv,
} from '../../src/database/index_health/runner';
import {
  getLatestIndexHealthRun,
  persistIndexHealthRun,
} from '../../src/database/index_health/store';
import type { IndexHealthRun } from '../../src/database/index_health/types';
import { FakeAnalyzerDb, makeSeqScanRow, makeUnusedRow } from './index_health_helpers';

let failures = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

const sampleRun = (): IndexHealthRun => ({
  runId: 'run-report',
  runAt: new Date('2026-08-01T03:30:00.000Z'),
  findings: [
    {
      findingType: 'excluded_index',
      schemaName: 'public',
      tableName: 'reputations',
      indexName: 'reputations_pkey',
      scans30d: 0,
      sizeMb: 5,
      recommendation: 'Low scan count (0) but NOT a removal candidate: primary key.',
      recommendedDdl: null,
      exclusionReason: 'primary key',
      statsWindowDays: 60,
      evidence: { kind: 'excluded_index' },
    },
    {
      findingType: 'unused_index',
      schemaName: 'public',
      tableName: 'audit_log',
      indexName: 'idx_audit_log_stale',
      scans30d: 2,
      sizeMb: 42.5,
      recommendation: 'Only 2 scans in the last 30 days and not backing any constraint.',
      recommendedDdl:
        '-- REVIEW REQUIRED: a human must verify this with a DBA before running. This tool never executes DDL.\n' +
        'DROP INDEX CONCURRENTLY IF EXISTS "public"."idx_audit_log_stale";',
      exclusionReason: null,
      statsWindowDays: 60,
      evidence: { kind: 'unused_index' },
    },
  ],
});

async function main(): Promise<void> {
  // ── 24. Report shows the excluded PK (with reason) and the real candidate ──

  await test('report renders an excluded PK with its reason and a candidate with DDL', () => {
    const text = renderIndexHealthReport(sampleRun());
    assert.match(text, /Excluded — checked, deliberately NOT recommended for removal/);
    assert.match(text, /reputations_pkey.*excluded: primary key/s);
    assert.match(text, /Unused index candidates/);
    assert.match(text, /idx_audit_log_stale/);
    assert.match(text, /DROP INDEX CONCURRENTLY IF EXISTS "public"\."idx_audit_log_stale";/);
    assert.match(text, /never runs CREATE INDEX or DROP\s*\n?\s*INDEX/i);
  });

  // ── 25. Report surfaces the pg_stat_statements unavailable note ──────

  await test('report shows a pg_stat_statements "unavailable" note when present', async () => {
    const db = new FakeAnalyzerDb({
      unusedIndexRows: [],
      statsResetDaysAgo: 90,
      seqScanRows: [makeSeqScanRow({ table_name: 'events', relpages: 20_000, seq_scan: 5_000 })],
      pgStatStatementsAvailable: false,
    });
    const { IndexHealthAnalyzer } = await import('../../src/database/index_health/analyzer');
    const run = await new IndexHealthAnalyzer({ db: db as any }).analyze();
    const text = renderIndexHealthReport(run);
    assert.match(text, /pg_stat_statements/);
    assert.match(text, /not installed/);
  });

  // ── 26. GET /api/v1/db/index-health — read-only, 503 when empty ──────

  await test('the API returns the latest run, and 503 before any run exists', async () => {
    const routes = new Map<string, Function>();
    const app = { get: (p: string, h: Function) => routes.set(p, h) };

    let latest: IndexHealthRun | null = null;
    registerIndexHealthRoutes(app as any, { getLatestRun: async () => latest });

    const handler = routes.get('/api/v1/db/index-health')!;
    assert.ok(handler, 'the exact issue path is registered');

    // Before any run → 503.
    let status = 0;
    let payload: any;
    await handler(
      {},
      {
        status: (c: number) => ((status = c), { json: (b: any) => (payload = b) }),
        json: (b: any) => (payload = b),
      },
    );
    assert.equal(status, 503);

    // After a run → 200 with findings + summary.
    latest = sampleRun();
    status = 200;
    payload = undefined;
    await handler(
      {},
      {
        status: (c: number) => ((status = c), { json: (b: any) => (payload = b) }),
        json: (b: any) => (payload = b),
      },
    );
    assert.equal(status, 200);
    assert.equal(payload.runId, 'run-report');
    assert.equal(payload.summary.excluded, 1);
    assert.equal(payload.summary.unusedCandidatesWithDdl, 1);
    assert.equal(payload.findings.length, 2);
  });

  // ── persistence round-trip via a fake that stores rows ──────────────

  await test('persist + getLatestIndexHealthRun round-trips a run', async () => {
    const stored: any[][] = [];
    const db = {
      async query(text: string, params?: any[]) {
        if (/^INSERT INTO index_health_reports/.test(text)) {
          // Expand the multi-row VALUES back into per-row param groups.
          for (let i = 0; i < (params?.length ?? 0); i += 13) stored.push(params!.slice(i, i + 13));
          return { rows: [] };
        }
        if (/SELECT run_id, run_at/.test(text)) {
          return {
            rows: stored.map((p) => ({
              run_id: p[0],
              run_at: p[1],
              finding_type: p[2],
              schema_name: p[3],
              table_name: p[4],
              index_name: p[5],
              scans_30d: p[6],
              size_mb: p[7],
              recommendation: p[8],
              recommended_ddl: p[9],
              exclusion_reason: p[10],
              stats_window_days: p[11],
              evidence: p[12],
            })),
          };
        }
        return { rows: [] };
      },
    };
    await persistIndexHealthRun(db as any, sampleRun());
    const back = await getLatestIndexHealthRun(db as any);
    assert.ok(back);
    assert.equal(back!.runId, 'run-report');
    assert.equal(back!.findings.length, 2);
    assert.equal(
      back!.findings.find((f) => f.indexName === 'reputations_pkey')!.recommendedDdl,
      null,
    );
  });

  // ── 27. Cron cadence resolves from env; off-peak default; not hard-coded ──

  await test('the daily cadence is env-configurable with an off-peak default', () => {
    assert.equal(DEFAULT_INDEX_HEALTH_CRON, '30 3 * * *', 'off-peak default is 03:30 UTC');

    const prevCron = process.env.VERINODE_INDEX_HEALTH_CRON;
    const prevInterval = process.env.VERINODE_INDEX_HEALTH_INTERVAL_MS;
    try {
      process.env.VERINODE_INDEX_HEALTH_CRON = '15 2 * * *';
      process.env.VERINODE_INDEX_HEALTH_INTERVAL_MS = '3600000';
      const monitor = createIndexHealthMonitorFromEnv(new FakeAnalyzerDb() as any);
      assert.equal((monitor as any).cronExpression, '15 2 * * *');
      assert.equal((monitor as any).intervalMs, 3_600_000);
    } finally {
      if (prevCron === undefined) delete process.env.VERINODE_INDEX_HEALTH_CRON;
      else process.env.VERINODE_INDEX_HEALTH_CRON = prevCron;
      if (prevInterval === undefined) delete process.env.VERINODE_INDEX_HEALTH_INTERVAL_MS;
      else process.env.VERINODE_INDEX_HEALTH_INTERVAL_MS = prevInterval;
    }
  });

  await test("monitor.start() registers an unref'd interval and stop() clears it; runOnce() works standalone", async () => {
    const db = new FakeAnalyzerDb({ unusedIndexRows: [], statsResetDaysAgo: 90 });
    const monitor = new IndexHealthMonitor({ db: db as any, intervalMs: 60_000 });

    const run = await monitor.runOnce();
    assert.ok(run.runId);
    assert.equal(monitor.getLastRun()!.runId, run.runId);

    monitor.start();
    assert.ok((monitor as any).timer, 'an interval timer is set');
    monitor.stop();
    assert.equal((monitor as any).timer, null, 'stop() clears the timer');
  });

  // ── 28. Monthly email: once per recipient, correct subject, idempotent id ──

  await test('IndexHealthReporter emails the plain-text report once per recipient', async () => {
    const sent: Array<{ notificationId: string; to: string; subject: string; body: string }> = [];
    const reporter = new IndexHealthReporter({ sendEmail: async (n) => void sent.push(n) }, [
      'dba@verinode.example',
      'oncall@verinode.example',
    ]);
    await reporter.sendMonthlyReport(sampleRun());

    assert.equal(sent.length, 2);
    assert.deepEqual(
      sent.map((s) => s.to),
      ['dba@verinode.example', 'oncall@verinode.example'],
    );
    for (const s of sent) {
      assert.equal(s.subject, '[VeriNode] Monthly Index Health Report');
      assert.equal(s.notificationId, `index-health:run-report:${s.to}`);
      assert.match(s.body, /Database Index Health Report/);
      assert.match(s.body, /idx_audit_log_stale/);
    }
  });

  console.log(
    failures === 0
      ? '\nindex_health_report: all passed'
      : `\nindex_health_report: ${failures} FAILED`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
