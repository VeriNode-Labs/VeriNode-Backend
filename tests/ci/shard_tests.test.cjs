'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  discoverTestFiles,
  loadDurations,
  median,
  partition,
  parseArgs,
} = require('../../scripts/shard-tests.cjs');

const ROOT = path.resolve(__dirname, '../..');
const RUNNER = path.join(ROOT, 'scripts', 'shard-tests.cjs');

function runCli(args) {
  return spawnSync(process.execPath, [RUNNER, ...args], { encoding: 'utf8' });
}

// --- discovery --------------------------------------------------------------

const files = discoverTestFiles();
assert(files.length >= 23, `expected at least 23 test files, found ${files.length}`);
assert.strictEqual(files.length, new Set(files).size, 'test file list must not contain duplicates');
assert(files.every((file) => /\.test\.(ts|js|cjs)$/.test(file)), 'only *.test.* files are discovered');
assert.deepStrictEqual(files, [...files].sort(), 'test file list must be sorted deterministically');

// --- partitioning -----------------------------------------------------------

const TOTAL = 4;
const durations = loadDurations();

{
  const shards = partition(files, durations, TOTAL);
  assert.strictEqual(shards.length, TOTAL, 'must produce exactly the requested shard count');
  const union = shards.flat();
  assert.strictEqual(union.length, files.length, 'every file must be assigned exactly once');
  assert.deepStrictEqual([...union].sort(), files, 'shards must cover every discovered file once');
}

{
  // Determinism: identical inputs must yield identical assignments.
  const a = partition(files, durations, TOTAL);
  const b = partition(files, durations, TOTAL);
  assert.deepStrictEqual(a, b, 'partitioning must be deterministic');
}

{
  // Balance: the heaviest shard must stay within 35% of the mean estimated
  // load, where each file weighs measured duration plus fixed process startup.
  const shards = partition(files, durations, TOTAL);
  const loads = shards.map((shard) =>
    shard.reduce((sum, file) => sum + (durations[file] || 0), 0),
  );
  const mean = loads.reduce((a, b) => a + b, 0) / loads.length;
  const max = Math.max(...loads);
  assert(
    max / mean <= 1.35,
    `shard imbalance too high: max ${max}ms vs mean ${Math.round(mean)}ms (ratio ${(max / mean).toFixed(2)})`,
  );
}

{
  // Unknown files (no measured duration) must still be assigned exactly once,
  // using the median of known durations as their weight.
  const subset = ['tests/mtls.test.ts', 'tests/queue/kafka_auto_scaler.test.ts', 'brand/new.test.ts'];
  const shards = partition(subset, durations, TOTAL);
  const union = shards.flat();
  assert.strictEqual(union.length, 3, 'unknown files must be assigned exactly once');
  const single = shards.filter((shard) => shard.includes('brand/new.test.ts'));
  assert.strictEqual(single.length, 1, 'a file must land in exactly one shard');
}

{
  // Fallback weight: median of known durations when the table is empty.
  const known = Object.values(durations).filter((v) => typeof v === 'number');
  assert.strictEqual(median(known), median([...known].sort((a, b) => a - b)));
  const shards = partition(['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts'], {}, 2);
  assert.deepStrictEqual(shards[0].length + shards[1].length, 4);
  assert.ok(Math.abs(shards[0].length - shards[1].length) <= 1, 'equal-weight files spread evenly');
}

// --- CLI --------------------------------------------------------------------

{
  const result = runCli(['--list', '--shard', '0', '--total', String(TOTAL)]);
  assert.strictEqual(result.status, 0, result.stderr);
  const listed = result.stdout.split('\n').filter(Boolean);
  assert.deepStrictEqual(listed, partition(files, durations, TOTAL)[0], '--list must print the shard assignment');
}

{
  // Unknown flags must fail loudly with a non-zero exit code.
  const result = runCli(['--bogus']);
  assert.strictEqual(result.status, 2, `expected exit code 2, got ${result.status}`);
}

{
  // Out-of-range shard indices must be rejected.
  const result = runCli(['--list', '--shard', '9', '--total', '4']);
  assert.strictEqual(result.status, 2, `expected exit code 2, got ${result.status}`);
}

{
  // Parsing: shard/total values are consumed as flag arguments, not re-parsed.
  const args = parseArgs(['--list', '--shard', '2', '--total', '4']);
  assert.strictEqual(args.list, true);
  assert.strictEqual(args.shard, 2);
  assert.strictEqual(args.total, 4);
}

// --- failure propagation ----------------------------------------------------

{
  // A failing test file must surface as a non-zero CLI exit code. The probe is
  // run through --record-durations, which aborts on the first failing file and
  // exercises the same per-file failure propagation used by --all/--shard runs.
  const tmpFile = path.join(ROOT, 'tests', 'ci', '__shard_failure_probe.test.js');
  fs.writeFileSync(tmpFile, 'throw new Error("intentional shard failure probe");\n');
  try {
    const result = runCli(['--record-durations']);
    assert.strictEqual(result.status, 1, `expected exit code 1, got ${result.status}`);
  } finally {
    fs.rmSync(tmpFile, { force: true });
  }
}

console.log('shard-tests tests passed');
