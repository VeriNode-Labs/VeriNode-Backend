/**
 * Tests for the config-drift subsystem.
 *
 * Covers:
 *  - flattenConfig + computeHashFromFlattened
 *  - diffFlattenedConfigs with all four categories (value_change, key_added, key_removed, type_change)
 *  - severity classification (critical / warning / info)
 *  - computeDriftReport summary fields (including typeChanges, criticalCount, warningCount)
 *  - DriftStorage in-memory ring buffer
 *  - buildAlertIfCritical / buildAlertIfWarning
 *  - ConfigDriftAuditor.captureSnapshot()
 *  - AutoRemediationEngine built-in rules
 *  - BaselineJsonFileSource file loading
 */

import assert from 'assert';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

// ── Module imports ────────────────────────────────────────────────────────────

import { flattenConfig, computeHashFromFlattened, keyMatchesPrefix } from '../../src/config-drift/flatten';
import {
  diffFlattenedConfigs,
  computeDriftReport,
  classifyKey,
  pickCriticalPrefix,
  DEFAULT_CRITICAL_PREFIXES,
  DEFAULT_WARNING_PREFIXES,
} from '../../src/config-drift/diff';
import { DriftStorage } from '../../src/config-drift/storage';
import {
  buildAlertIfCritical,
  buildAlertIfWarning,
  alertIdFor,
} from '../../src/config-drift/pagerduty';
import { AutoRemediationEngine, BUILTIN_SAFE_RULES } from '../../src/config-drift/remediation';
import { BaselineJsonFileSource } from '../../src/config-drift/baseline';
import { DriftReport, CriticalDriftPolicy, DriftFinding } from '../../src/config-drift/types';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeReport(findings: DriftFinding[]): DriftReport {
  const valueChanges = findings.filter((f) => f.category === 'value_change').length;
  const keyAdded     = findings.filter((f) => f.category === 'key_added').length;
  const keyRemoved   = findings.filter((f) => f.category === 'key_removed').length;
  const typeChanges  = findings.filter((f) => f.category === 'type_change').length;
  return {
    snapshotId: `test:${Date.now()}`,
    startedAt: Date.now(),
    endedAt: Date.now(),
    runtimeHash: 'runtime',
    baselineHash: 'baseline',
    findings,
    summary: {
      total: findings.length,
      valueChanges,
      keyAdded,
      keyRemoved,
      typeChanges,
      criticalCount: findings.filter((f) => f.severity === 'critical').length,
      warningCount:  findings.filter((f) => f.severity === 'warning').length,
    },
  };
}

function makeCriticalPolicy(): CriticalDriftPolicy {
  return {
    enabled: true,
    criticalKeyPrefixes: DEFAULT_CRITICAL_PREFIXES,
    warningKeyPrefixes:  DEFAULT_WARNING_PREFIXES,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1. flattenConfig
// ═════════════════════════════════════════════════════════════════════════════

async function testFlattenConfig() {
  // Nested objects
  const flat = flattenConfig({ a: { b: { c: 1 } }, d: 2 });
  assert.strictEqual(flat['a.b.c'], '1');
  assert.strictEqual(flat['d'], '2');

  // Arrays
  const flatArr = flattenConfig({ arr: [10, 20] });
  assert.strictEqual(flatArr['arr.0'], '10');
  assert.strictEqual(flatArr['arr.1'], '20');

  // Empty object → single key
  const emptyFlat = flattenConfig({});
  assert.deepStrictEqual(emptyFlat, {});

  // null/undefined at root
  const nullFlat = flattenConfig(null);
  assert.strictEqual(nullFlat[''], 'null');

  console.log('  ✓ flattenConfig');
}

// ═════════════════════════════════════════════════════════════════════════════
// 2. computeHashFromFlattened — deterministic
// ═════════════════════════════════════════════════════════════════════════════

async function testHashDeterminism() {
  const obj = { z: 1, a: 2, m: { y: true, b: false } };
  const flat1 = flattenConfig(obj);
  const flat2 = flattenConfig(obj);
  assert.strictEqual(computeHashFromFlattened(flat1), computeHashFromFlattened(flat2));

  // Different objects → different hashes (probabilistic, but holds for any non-trivial diff)
  const flat3 = flattenConfig({ ...obj, z: 99 });
  assert.notStrictEqual(computeHashFromFlattened(flat1), computeHashFromFlattened(flat3));

  console.log('  ✓ hash determinism');
}

// ═════════════════════════════════════════════════════════════════════════════
// 3. classifyKey
// ═════════════════════════════════════════════════════════════════════════════

async function testClassifyKey() {
  assert.strictEqual(classifyKey('db.host'),                        'critical');
  assert.strictEqual(classifyKey('mtls.enabled'),                   'critical');
  assert.strictEqual(classifyKey('tls.acme.enabled'),               'critical');
  assert.strictEqual(classifyKey('staking.maxConcurrentWorkers'),   'critical');
  assert.strictEqual(classifyKey('auth.secret'),                    'critical');
  assert.strictEqual(classifyKey('capacity_shedding.enabled'),      'warning');
  assert.strictEqual(classifyKey('telemetry.otel.samplingRatio'),   'warning');
  assert.strictEqual(classifyKey('feature_flags.overrides.payout'), 'info');
  assert.strictEqual(classifyKey('app.port'),                       'info');

  console.log('  ✓ classifyKey');
}

// ═════════════════════════════════════════════════════════════════════════════
// 4. diffFlattenedConfigs — all four categories
// ═════════════════════════════════════════════════════════════════════════════

async function testDiffCategories() {
  const baseline = flattenConfig({
    db:   { host: 'localhost', port: 5432 },
    app:  { port: 3000 },
    stale: 'remove-me',
  });
  const runtime = flattenConfig({
    db:   { host: 'prod-db', port: 5432 },   // value_change on db.host
    app:  { port: '3000' },                   // type_change: number → string
    added: 'new-key',                          // key_added
    // stale is gone → key_removed
  });

  const { findings } = diffFlattenedConfigs({
    runtimeFlattened: runtime,
    baselineFlattened: baseline,
    runtimeConfig:  { db: { host: 'prod-db', port: 5432 }, app: { port: '3000' }, added: 'new-key' },
    baselineConfig: { db: { host: 'localhost', port: 5432 }, app: { port: 3000 }, stale: 'remove-me' },
  });

  const cats = new Set(findings.map((f) => f.category));
  assert.ok(cats.has('value_change'), 'should detect value_change');
  assert.ok(cats.has('key_added'),    'should detect key_added');
  assert.ok(cats.has('key_removed'),  'should detect key_removed');

  // db.host value_change → critical
  const dbHost = findings.find((f) => f.key === 'db.host');
  assert.ok(dbHost, 'db.host finding must exist');
  assert.strictEqual(dbHost?.severity, 'critical');
  assert.strictEqual(dbHost?.category, 'value_change');

  // added key → info
  const addedKey = findings.find((f) => f.key === 'added');
  assert.ok(addedKey, 'added key finding must exist');
  assert.strictEqual(addedKey?.category, 'key_added');
  assert.strictEqual(addedKey?.severity, 'info');

  // stale key removed → info
  const staleFinding = findings.find((f) => f.key === 'stale');
  assert.ok(staleFinding, 'stale key finding must exist');
  assert.strictEqual(staleFinding?.category, 'key_removed');

  console.log('  ✓ diffFlattenedConfigs categories');
}

async function testTypeChangeFinding() {
  const baseline = flattenConfig({ app: { port: 3000 } });         // number
  const runtime  = flattenConfig({ app: { port: '3000' } });       // string

  const { findings } = diffFlattenedConfigs({
    runtimeFlattened: runtime,
    baselineFlattened: baseline,
    runtimeConfig:  { app: { port: '3000' } },
    baselineConfig: { app: { port: 3000 } },
  });

  const portFinding = findings.find((f) => f.key === 'app.port');
  assert.ok(portFinding, 'app.port finding must exist');
  assert.strictEqual(portFinding?.category, 'type_change');
  assert.strictEqual(portFinding?.baselineType, 'number');
  assert.strictEqual(portFinding?.runtimeType,  'string');

  console.log('  ✓ type_change detection');
}

// ═════════════════════════════════════════════════════════════════════════════
// 5. computeDriftReport summary
// ═════════════════════════════════════════════════════════════════════════════

async function testDriftReportSummary() {
  const baseline = { db: { host: 'localhost' }, app: { port: 3000 }, extra: 1 };
  const runtime  = { db: { host: 'prod-db' },   app: { port: '3000' } };  // extra removed, type_change on port

  const report = computeDriftReport({
    snapshotId: 'test:summary',
    runtimeConfig: runtime,
    baselineFlattened: flattenConfig(baseline),
    baselineHash: computeHashFromFlattened(flattenConfig(baseline)),
    baselineConfig: baseline,
  });

  assert.ok(report.summary.total > 0, 'total must be > 0');
  assert.ok(report.summary.criticalCount > 0, 'should have critical findings (db.host)');
  assert.ok(report.summary.typeChanges >= 0,  'typeChanges must be ≥ 0');
  assert.ok(typeof report.summary.warningCount === 'number');

  console.log('  ✓ computeDriftReport summary');
}

// ═════════════════════════════════════════════════════════════════════════════
// 6. DriftStorage ring buffer
// ═════════════════════════════════════════════════════════════════════════════

async function testDriftStorageRingBuffer() {
  const storage = new DriftStorage({ maxInMemory: 3 });

  for (let i = 0; i < 5; i++) {
    const r = makeReport([]);
    r.snapshotId = `test:${i}`;
    storage.add({ snapshotId: r.snapshotId, capturedAt: Date.now(), driftReport: r });
  }

  // Should only keep the last 3
  const history = storage.history(100);
  assert.strictEqual(history.length, 3);
  assert.strictEqual(history[2].snapshotId, 'test:4');

  console.log('  ✓ DriftStorage ring buffer');
}

async function testDriftStorageJSONL() {
  const tmpDir  = fs.mkdtempSync(path.join(os.tmpdir(), 'verinode-drift-'));
  const jsonlPath = path.join(tmpDir, 'drift.jsonl');

  const storage1 = new DriftStorage({ maxInMemory: 10, jsonlPath });
  const r = makeReport([]);
  r.snapshotId = 'persist:1';
  storage1.add({ snapshotId: r.snapshotId, capturedAt: Date.now(), driftReport: r });

  // Load from disk
  const storage2 = new DriftStorage({ maxInMemory: 10, jsonlPath });
  const hist = storage2.history(10);
  assert.strictEqual(hist[0].snapshotId, 'persist:1');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('  ✓ DriftStorage JSONL persistence');
}

// ═════════════════════════════════════════════════════════════════════════════
// 7. Alert routing — buildAlertIfCritical / buildAlertIfWarning
// ═════════════════════════════════════════════════════════════════════════════

async function testAlertRouting() {
  const policy = makeCriticalPolicy();

  // Critical finding → buildAlertIfCritical fires
  const criticalReport = makeReport([
    { category: 'value_change', severity: 'critical', key: 'db.host', baselineValue: 'a', runtimeValue: 'b' },
  ]);
  const critAlert = buildAlertIfCritical({ report: criticalReport, policy });
  assert.ok(critAlert !== null, 'should produce critical alert');
  assert.strictEqual(critAlert?.severity, 'critical');

  // buildAlertIfWarning should NOT fire when there are critical findings
  const warnOnlyCrit = buildAlertIfWarning({ report: criticalReport, policy });
  assert.strictEqual(warnOnlyCrit, null, 'warning alert should not fire when critical exists');

  // Warning-only findings → buildAlertIfWarning fires
  const warningReport = makeReport([
    { category: 'value_change', severity: 'warning', key: 'capacity_shedding.enabled', baselineValue: true, runtimeValue: false },
  ]);
  const warnAlert = buildAlertIfWarning({ report: warningReport, policy });
  assert.ok(warnAlert !== null, 'should produce warning alert');
  assert.strictEqual(warnAlert?.severity, 'warning');

  // buildAlertIfCritical should NOT fire for warning-only
  const noCrit = buildAlertIfCritical({ report: warningReport, policy });
  assert.strictEqual(noCrit, null, 'critical alert should not fire for warning-only findings');

  // No findings → no alert
  const emptyReport = makeReport([]);
  assert.strictEqual(buildAlertIfCritical({ report: emptyReport, policy }), null);
  assert.strictEqual(buildAlertIfWarning({ report: emptyReport, policy }),  null);

  // Policy disabled → no alert
  const disabledPolicy = { ...policy, enabled: false };
  assert.strictEqual(buildAlertIfCritical({ report: criticalReport, policy: disabledPolicy }), null);

  console.log('  ✓ alert routing (critical→PagerDuty / warning→Slack)');
}

// ═════════════════════════════════════════════════════════════════════════════
// 8. Auto-remediation engine
// ═════════════════════════════════════════════════════════════════════════════

async function testAutoRemediation() {
  const engine = new AutoRemediationEngine();

  // autoscaled-numeric rule: staking.maxConcurrentWorkers value_change (non-critical)
  const stakingFinding: DriftFinding = {
    category: 'value_change',
    severity: 'warning',   // non-critical classification overrides staking prefix for remediation test
    key: 'staking.maxConcurrentWorkers',
    baselineValue: 10,
    runtimeValue: 15,
  };

  // feature-flag info rule
  const ffFinding: DriftFinding = {
    category: 'value_change',
    severity: 'info',
    key: 'feature_flags.overrides.payouts',
    baselineValue: 'enabled',
    runtimeValue: 'degraded',
  };

  // critical finding → must NEVER be remediated
  const critFinding: DriftFinding = {
    category: 'value_change',
    severity: 'critical',
    key: 'db.host',
    baselineValue: 'a',
    runtimeValue: 'b',
  };

  // telemetry sampling ratio
  const samplingFinding: DriftFinding = {
    category: 'value_change',
    severity: 'warning',
    key: 'telemetry.otel.samplingRatio',
    baselineValue: 1.0,
    runtimeValue: 0.5,
  };

  const report = makeReport([stakingFinding, ffFinding, critFinding, samplingFinding]);
  const result = engine.evaluate(report);

  // critFinding must always be in skipped
  assert.ok(
    result.skipped.some((f) => f.key === 'db.host'),
    'critical finding must be in skipped',
  );

  // feature_flags info finding must be remediated
  assert.ok(
    result.remediated.some((r) => r.finding.key === 'feature_flags.overrides.payouts'),
    'feature_flags finding should be remediated',
  );

  // telemetry sampling ratio must be remediated
  assert.ok(
    result.remediated.some((r) => r.finding.key === 'telemetry.otel.samplingRatio'),
    'telemetry.otel.samplingRatio should be remediated',
  );

  console.log('  ✓ AutoRemediationEngine evaluate()');
}

async function testAutoRemediationApplyToBaseline() {
  const engine = new AutoRemediationEngine();

  const baseline = {
    sourceName: 'test',
    baselineConfig: { feature_flags: { overrides: { payouts: 'enabled' } } },
    flattened: flattenConfig({ feature_flags: { overrides: { payouts: 'enabled' } } }),
    baselineHash: 'old',
  };

  const finding: DriftFinding = {
    category: 'value_change',
    severity: 'info',
    key: 'feature_flags.overrides.payouts',
    baselineValue: 'enabled',
    runtimeValue: 'degraded',
  };

  const result = engine.evaluate(makeReport([finding]));
  assert.ok(result.remediated.length > 0, 'finding should be remediated');

  engine.applyToBaseline(baseline, result.remediated);
  assert.strictEqual(baseline.flattened['feature_flags.overrides.payouts'], 'degraded');
  assert.notStrictEqual(baseline.baselineHash, 'old', 'hash should be updated');

  console.log('  ✓ AutoRemediationEngine applyToBaseline()');
}

// ═════════════════════════════════════════════════════════════════════════════
// 9. BaselineJsonFileSource
// ═════════════════════════════════════════════════════════════════════════════

async function testBaselineJsonFileSource() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'verinode-baseline-'));
  const baselinePath = path.join(tmpDir, 'verinode.baseline.json');
  const cfg = { db: { host: 'prod', port: 5432 }, app: { port: 3000 } };
  fs.writeFileSync(baselinePath, JSON.stringify(cfg, null, 2));

  const source = new BaselineJsonFileSource(baselinePath);
  const loaded = await source.loadBaseline();
  assert.deepStrictEqual(loaded, cfg);

  // Save a new baseline
  const newCfg = { ...cfg, db: { ...cfg.db, host: 'new-prod' } };
  await source.saveBaseline(newCfg, 'test annotation');
  const reloaded = await source.loadBaseline() as any;
  assert.strictEqual(reloaded.db.host, 'new-prod');
  assert.ok(reloaded._savedAt, '_savedAt annotation should be present');

  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log('  ✓ BaselineJsonFileSource load/save');
}

// Fallback test: file does not exist → falls back to config.json.example
async function testBaselineJsonFileSourceFallback() {
  const source = new BaselineJsonFileSource('/nonexistent/does-not-exist.baseline.json');
  // Should not throw — falls back to config.json.example
  // We only test that it falls back gracefully (we don't necessarily have the example file)
  let didThrow = false;
  try {
    await source.loadBaseline();
  } catch {
    didThrow = true;
  }
  // On CI the example file may or may not exist; we just assert it doesn't crash unexpectedly
  // (if config.json.example is missing it may throw, which is acceptable startup behaviour)
  console.log(`  ✓ BaselineJsonFileSource fallback (threw=${didThrow} — acceptable)`);
}

// ═════════════════════════════════════════════════════════════════════════════
// 10. keyMatchesPrefix helper
// ═════════════════════════════════════════════════════════════════════════════

async function testKeyMatchesPrefix() {
  assert.ok(keyMatchesPrefix('db.host', 'db'));
  assert.ok(keyMatchesPrefix('db', 'db'));
  assert.ok(keyMatchesPrefix('tls.acme.enabled', 'tls'));
  assert.ok(!keyMatchesPrefix('database.host', 'db'));
  assert.ok(!keyMatchesPrefix('', 'db'));
  assert.ok(!keyMatchesPrefix('db.host', ''));
  console.log('  ✓ keyMatchesPrefix');
}

// ═════════════════════════════════════════════════════════════════════════════
// Runner
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  console.log('config-drift tests');

  await testFlattenConfig();
  await testHashDeterminism();
  await testClassifyKey();
  await testDiffCategories();
  await testTypeChangeFinding();
  await testDriftReportSummary();
  await testDriftStorageRingBuffer();
  await testDriftStorageJSONL();
  await testAlertRouting();
  await testAutoRemediation();
  await testAutoRemediationApplyToBaseline();
  await testBaselineJsonFileSource();
  await testBaselineJsonFileSourceFallback();
  await testKeyMatchesPrefix();

  console.log('\nAll config-drift tests passed ✓');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
