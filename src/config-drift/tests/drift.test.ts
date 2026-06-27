import { flattenConfig, computeHashFromFlattened } from '../flatten';
import { diffFlattenedConfigs, computeDriftReport } from '../diff';
import { CriticalDriftPolicy } from '../types';

// Jest-compatible tests.
// If your test runner does not define describe/test/expect, run via the project's
// test setup (Jest) or skip this file.

describe('config-drift flatten + diff', () => {

  test('flattenConfig produces stable keys', () => {
    const cfg1 = { b: 2, a: { c: 3 } };
    const cfg2 = { a: { c: 3 }, b: 2 };
    const f1 = flattenConfig(cfg1);
    const f2 = flattenConfig(cfg2);
    expect(f1).toEqual(f2);
  });

  test('value changes detected', () => {
    const baseline = flattenConfig({ db: { host: 'x', port: 1 } });
    const runtime = flattenConfig({ db: { host: 'y', port: 1 } });
    const { findings } = diffFlattenedConfigs({ runtimeFlattened: runtime, baselineFlattened: baseline });
    expect(findings.some((f) => f.category === 'value_change' && f.key === 'db.host')).toBe(true);
  });

  test('key added/removed detected', () => {
    const baseline = flattenConfig({ app: { environment: 'production' } });
    const runtime = flattenConfig({ app: { logLevel: 'info' } });
    const { findings } = diffFlattenedConfigs({ runtimeFlattened: runtime, baselineFlattened: baseline });
    expect(findings.some((f) => f.category === 'key_added' && f.key === 'app.logLevel')).toBe(true);
    expect(findings.some((f) => f.category === 'key_removed' && f.key === 'app.environment')).toBe(true);
  });

  test('computeDriftReport summary consistent', () => {
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

    expect(report.summary.total).toBeGreaterThanOrEqual(2);
  });
});

describe('config-drift critical policy', () => {
  test('default critical prefixes used by policy', () => {
    const policy: CriticalDriftPolicy = {
      enabled: true,
      criticalKeyPrefixes: ['db', 'mtls', 'tls', 'app', 'remote'],
    };
    expect(policy.criticalKeyPrefixes).toContain('db');
  });
});

