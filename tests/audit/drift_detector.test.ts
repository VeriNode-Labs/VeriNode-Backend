/**
 * Unit tests — DriftDetector: deepDiff, classify, detect() paths
 */

import * as assert from 'assert';
import { deepDiff, classify, DriftDetector } from '../../src/audit/drift_detector';
import { DriftReport, PartialAlertPayload } from '../../src/audit/types';
import { createLogger } from '../../src/diagnostics/logger';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeLogger() { return createLogger('test'); }

function makeBaselineManager(snapshot: object | null) {
  return {
    getActive: async () =>
      snapshot === null
        ? null
        : {
            id: 'bl-1',
            snapshotJson: JSON.stringify(snapshot),
            sha256Hash: 'abc',
            actor: 'op',
            createdAt: new Date(),
            status: 'active' as const,
          },
    deserializeBaseline: (json: string) => JSON.parse(json),
  };
}

function makeAlertDispatcher() {
  const calls: (DriftReport | PartialAlertPayload)[] = [];
  return {
    calls,
    dispatch(report: DriftReport | PartialAlertPayload) { calls.push(report); },
  };
}

// ── Test runner ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(() => fn()).then(() => {
    console.log(`  ✓ ${name}`);
    passed++;
  }).catch((err: Error) => {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  });
}

async function run() {
  console.log('\n=== DriftDetector unit tests ===\n');

  // ── deepDiff ───────────────────────────────────────────────────────────────

  await test('deepDiff: empty when objects are identical', () => {
    const diffs = deepDiff({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } });
    assert.strictEqual(diffs.length, 0);
  });

  await test('deepDiff: detects primitive change at top level', () => {
    const diffs = deepDiff({ port: 3000 }, { port: 4000 });
    assert.strictEqual(diffs.length, 1);
    assert.strictEqual(diffs[0].path, 'port');
    assert.strictEqual(diffs[0].baselineValue, 3000);
    assert.strictEqual(diffs[0].liveValue, 4000);
  });

  await test('deepDiff: detects nested change with dot-separated path', () => {
    const diffs = deepDiff({ db: { host: 'old' } }, { db: { host: 'new' } });
    assert.strictEqual(diffs[0].path, 'db.host');
  });

  await test('deepDiff: reports missing-in-live as liveValue=undefined', () => {
    const diffs = deepDiff({ a: 1 }, {});
    assert.strictEqual(diffs[0].liveValue, undefined);
  });

  await test('deepDiff: reports new-in-live as baselineValue=undefined', () => {
    const diffs = deepDiff({}, { a: 1 });
    assert.strictEqual(diffs[0].baselineValue, undefined);
  });

  await test('deepDiff: compares arrays by JSON stringify', () => {
    const diffs = deepDiff({ ids: [1, 2] }, { ids: [1, 3] });
    assert.strictEqual(diffs.length, 1);
    assert.strictEqual(diffs[0].path, 'ids');
  });

  // ── classify ──────────────────────────────────────────────────────────────

  await test('classify: db.* is critical', () => {
    assert.strictEqual(classify('db.host'), 'critical');
  });

  await test('classify: mtls.enabled is critical', () => {
    assert.strictEqual(classify('mtls.enabled'), 'critical');
  });

  await test('classify: tls.acme.domains is critical', () => {
    assert.strictEqual(classify('tls.acme.domains'), 'critical');
  });

  await test('classify: staking.maxConcurrentWorkers is critical', () => {
    assert.strictEqual(classify('staking.maxConcurrentWorkers'), 'critical');
  });

  await test('classify: app.port is non_critical', () => {
    assert.strictEqual(classify('app.port'), 'non_critical');
  });

  await test('classify: telemetry.otel.endpoint is non_critical', () => {
    assert.strictEqual(classify('telemetry.otel.endpoint'), 'non_critical');
  });

  // ── detect(): no baseline ──────────────────────────────────────────────────

  await test('detect: no baseline → resolves without calling AlertDispatcher', async () => {
    const bm = makeBaselineManager(null);
    const ad = makeAlertDispatcher();
    const dd = new DriftDetector(bm as any, ad as any, makeLogger());
    await dd.detect({ app: { port: 3000 } });
    assert.strictEqual(ad.calls.length, 0, 'AlertDispatcher should not be called');
  });

  // ── detect(): non-critical drift ──────────────────────────────────────────

  await test('detect: non-critical drift → no alert dispatched', async () => {
    const bm = makeBaselineManager({ app: { port: 3000 } });
    const ad = makeAlertDispatcher();
    const dd = new DriftDetector(bm as any, ad as any, makeLogger());
    await dd.detect({ app: { port: 4000 } }); // app.port is non-critical
    assert.strictEqual(ad.calls.length, 0, 'Non-critical drift should not trigger alert');
  });

  // ── detect(): critical drift ──────────────────────────────────────────────

  await test('detect: critical drift (db.host changed) → alert dispatched', async () => {
    const bm = makeBaselineManager({ db: { host: 'old.db' } });
    const ad = makeAlertDispatcher();
    const dd = new DriftDetector(bm as any, ad as any, makeLogger());
    await dd.detect({ db: { host: 'new.db' } });
    assert.strictEqual(ad.calls.length, 1, 'Alert should be dispatched for critical drift');
    const report = ad.calls[0] as DriftReport;
    assert.ok('driftedKeys' in report, 'Should be a DriftReport');
    assert.strictEqual(report.driftedKeys[0].severity, 'critical');
  });

  // ── detect(): baseline lookup throws ──────────────────────────────────────

  await test('detect: baseline lookup throws → resolves without re-throwing', async () => {
    const bm = { getActive: async () => { throw new Error('DB down'); }, deserializeBaseline: JSON.parse };
    const ad = makeAlertDispatcher();
    const dd = new DriftDetector(bm as any, ad as any, makeLogger());
    await assert.doesNotReject(() => dd.detect({ app: { port: 3000 } }));
  });

  // ── detect(): diff error → partial alert ─────────────────────────────────

  await test('detect: diff error → PartialAlertPayload dispatched, no re-throw', async () => {
    const bm = {
      getActive: async () => ({ id: 'bl-1', snapshotJson: '{}', sha256Hash: '', actor: 'op', createdAt: new Date(), status: 'active' }),
      deserializeBaseline: () => { throw new Error('parse exploded'); },
    };
    const ad = makeAlertDispatcher();
    const dd = new DriftDetector(bm as any, ad as any, makeLogger());
    await assert.doesNotReject(() => dd.detect({ app: {} }));
    assert.strictEqual(ad.calls.length, 1);
    assert.ok('partialReport' in ad.calls[0], 'Should be a PartialAlertPayload');
  });

  // ── summary ────────────────────────────────────────────────────────────────

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
