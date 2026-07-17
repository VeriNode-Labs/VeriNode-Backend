import flattenPkg from '../flatten.ts';
import diffPkg from '../diff.ts';

const { flattenConfig, computeHashFromFlattened } = flattenPkg;
const { diffFlattenedConfigs, computeDriftReport } = diffPkg;


function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

// Test 1: flatten stability
{
  const cfg1 = { b: 2, a: { c: 3 } };
  const cfg2 = { a: { c: 3 }, b: 2 };
  const f1 = flattenConfig(cfg1);
  const f2 = flattenConfig(cfg2);
  const k1 = Object.keys(f1).sort().join('|');
  const k2 = Object.keys(f2).sort().join('|');
  assert(k1 === k2, 'flatten keys mismatch');
}

// Test 2: value changes
{
  const baseline = flattenConfig({ db: { host: 'x', port: 1 } });
  const runtime = flattenConfig({ db: { host: 'y', port: 1 } });
  const { findings } = diffFlattenedConfigs({ runtimeFlattened: runtime, baselineFlattened: baseline });
  assert(findings.some((f) => f.category === 'value_change' && f.key === 'db.host'), 'value change not detected');
}

// Test 3: added/removed keys
{
  const baseline = flattenConfig({ app: { environment: 'production' } });
  const runtime = flattenConfig({ app: { logLevel: 'info' } });
  const { findings } = diffFlattenedConfigs({ runtimeFlattened: runtime, baselineFlattened: baseline });
  assert(findings.some((f) => f.category === 'key_added' && f.key === 'app.logLevel'), 'key added not detected');
  assert(findings.some((f) => f.category === 'key_removed' && f.key === 'app.environment'), 'key removed not detected');
}

// Test 4: computeDriftReport summary
{
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

  assert(report.summary.total >= 2, 'summary seems too small');
}

console.log('config-drift tests passed');

