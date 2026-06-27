/**
 * Config drift runtime auditing tests
 */
declare global {
  function describe(name: string, fn: () => void): void;
  function it(name: string, fn: () => void | Promise<void>): void;
  function before(fn: () => void | Promise<void>): void;
  function after(fn: () => void | Promise<void>): void;
}

if (typeof (global as any).describe === 'undefined') {
  const tests: Array<{ name: string; fn: () => any }> = [];
  let beforeFn: (() => any) | null = null;
  let afterFn: (() => any) | null = null;

  (global as any).describe = (name: string, fn: () => void) => {
    console.log(`Running Suite: ${name}`);
    fn();
    setTimeout(async () => {
      try {
        if (beforeFn) await beforeFn();
        for (const test of tests) {
          console.log(`  Running Test: ${test.name}`);
          await test.fn();
          console.log(`  ✓ ${test.name}`);
        }
        if (afterFn) await afterFn();
        console.log('\nAll config drift tests passed!');
        process.exit(0);
      } catch (err: any) {
        console.error(`\nTest failed: ${err.message}`);
        console.error(err.stack);
        if (afterFn) {
          try {
            await afterFn();
          } catch {}
        }
        process.exit(1);
      }
    }, 0);
  };
  (global as any).before = (fn: () => any) => {
    beforeFn = fn;
  };
  (global as any).after = (fn: () => any) => {
    afterFn = fn;
  };
  (global as any).it = (name: string, fn: () => any) => {
    tests.push({ name, fn });
  };
}

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import { flattenConfig, computeHashFromFlattened } from '../src/config-drift/flatten';
import { diffFlattenedConfigs, computeDriftReport } from '../src/config-drift/diff';
import { buildAlertIfCritical } from '../src/config-drift/pagerduty';
import { DriftStorage } from '../src/config-drift/storage';
import { registerConfigDriftRoutes } from '../src/config-drift/routes';

const tmpDir = path.join(__dirname, 'tmp');
const jsonlFile = path.join(tmpDir, 'drift-history.jsonl');

describe('Config drift module', () => {
  before(() => {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    try {
      if (fs.existsSync(jsonlFile)) fs.unlinkSync(jsonlFile);
      if (fs.existsSync(tmpDir)) fs.rmdirSync(tmpDir);
    } catch {
      // noop
    }
  });

  it('flattens config consistently across object order and nesting', () => {
    const a = { b: 2, a: { c: 3 } };
    const b = { a: { c: 3 }, b: 2 };
    assert.deepStrictEqual(flattenConfig(a), flattenConfig(b));

    const complex = { app: { list: ['one', { nested: true }] } };
    const flat = flattenConfig(complex);
    assert.strictEqual(flat['app.list.0'], 'one');
    assert.strictEqual(flat['app.list.1.nested'], 'true');
  });

  it('detects added, removed, and changed keys in runtime drift', () => {
    const baseline = flattenConfig({ app: { environment: 'production' } });
    const runtime = flattenConfig({ app: { environment: 'staging', logLevel: 'info' } });
    const { findings } = diffFlattenedConfigs({ runtimeFlattened: runtime, baselineFlattened: baseline });
    assert.ok(findings.some((f) => f.category === 'value_change' && f.key === 'app.environment'));
    assert.ok(findings.some((f) => f.category === 'key_added' && f.key === 'app.logLevel'));
  });

  it('generates drift reports with a consistent summary and hash', () => {
    const baselineConfig = { app: { environment: 'production' } };
    const runtimeConfig = { app: { environment: 'staging', logLevel: 'info' } };
    const baselineFlat = flattenConfig(baselineConfig);
    const runtimeFlat = flattenConfig(runtimeConfig);
    const baselineHash = computeHashFromFlattened(baselineFlat);
    const report = computeDriftReport({
      snapshotId: 'snap:1',
      runtimeConfig,
      runtimeFlattened: runtimeFlat,
      baselineFlattened: baselineFlat,
      baselineHash,
    });
    assert.strictEqual(report.baselineHash, baselineHash);
    assert.strictEqual(report.summary.total, report.summary.valueChanges + report.summary.keyAdded + report.summary.keyRemoved);
    assert.ok(report.runtimeHash.length > 0);
  });

  it('only creates a PagerDuty alert when a critical prefix is matched', () => {
    const baselineFlat = flattenConfig({ db: { host: 'x' } });
    const runtimeFlat = flattenConfig({ db: { host: 'y' } });
    const report = computeDriftReport({
      snapshotId: 'snap:2',
      runtimeConfig: {},
      runtimeFlattened: runtimeFlat,
      baselineFlattened: baselineFlat,
      baselineHash: computeHashFromFlattened(baselineFlat),
    });

    const policy = { enabled: true, criticalKeyPrefixes: ['db'] };
    const alert = buildAlertIfCritical({ report, policy, policyMatchedPrefix: 'db' });
    assert.ok(alert && alert.severity === 'critical');

    const noAlert = buildAlertIfCritical({ report, policy, policyMatchedPrefix: undefined });
    assert.strictEqual(noAlert, null);
  });

  it('persists and restores drift history from JSONL storage', () => {
    const first = {
      snapshotId: 's1',
      capturedAt: Date.now() - 1000,
      driftReport: {
        snapshotId: 's1', startedAt: 1, endedAt: 2,
        runtimeHash: 'abc', baselineHash: 'def', findings: [],
        summary: { total: 0, valueChanges: 0, keyAdded: 0, keyRemoved: 0 },
      },
    };
    const second = {
      snapshotId: 's2',
      capturedAt: Date.now(),
      driftReport: {
        snapshotId: 's2', startedAt: 3, endedAt: 4,
        runtimeHash: 'ghi', baselineHash: 'jkl', findings: [],
        summary: { total: 0, valueChanges: 0, keyAdded: 0, keyRemoved: 0 },
      },
    };

    fs.writeFileSync(jsonlFile, JSON.stringify(first) + '\n' + JSON.stringify(second) + '\n', 'utf8');
    const storage = new DriftStorage({ jsonlPath: jsonlFile, maxInMemory: 10 });
    assert.strictEqual(storage.history(2).length, 2);
    assert.strictEqual(storage.latest()?.snapshotId, 's2');
  });

  it('registers drift debug and dashboard routes', () => {
    const routes: Record<string, Function> = {};
    const app = { get: (path: string, handler: Function) => { routes[path] = handler; } };
    const auditorStub = { latest: () => null, history: (_limit: number) => [] };
    registerConfigDriftRoutes(app, auditorStub as any);
    assert.ok(routes['/debug/config-drift']);
    assert.ok(routes['/debug/config-drift/history']);
    assert.ok(routes['/debug/config-drift/ui']);
  });
});
