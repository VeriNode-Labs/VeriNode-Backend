'use strict';

/**
 * Deterministic test sharding for CI.
 *
 * Partitions every test file under tests/ into `--total` shards using
 * longest-processing-time (LPT) bin packing keyed on measured durations from
 * scripts/test-durations.json. Newly added suites default to the median of the
 * measured durations so they still spread evenly across shards.
 *
 * Usage:
 *   node scripts/shard-tests.cjs --all                  run every test file
 *   node scripts/shard-tests.cjs --shard 2 --total 4    run shard 2 of 4 (0-based)
 *   node scripts/shard-tests.cjs --list --shard 2 --total 4
 *   node scripts/shard-tests.cjs --record-durations     re-measure and rewrite durations
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const TESTS_DIR = path.join(ROOT, 'tests');
const DURATIONS_FILE = path.join(__dirname, 'test-durations.json');

const TEST_FILE_RE = /\.test\.(ts|js|cjs)$/;
const DEFAULT_WEIGHT_MS = 500;
// Fixed per-file process startup (tsx/vitest boot) added to measured run time
// so shard packing accounts for the cost of spawning many small suites.
const STARTUP_MS = 400;

function discoverTestFiles() {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (TEST_FILE_RE.test(entry.name)) {
        files.push(path.relative(ROOT, full));
      }
    }
  }
  walk(TESTS_DIR);
  return files.sort();
}

function loadDurations() {
  if (!fs.existsSync(DURATIONS_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DURATIONS_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Longest-processing-time (LPT) bin packing.
 * Files are sorted by descending weight (filename breaks ties so the output is
 * deterministic) and each file lands in the least-loaded shard (ties broken by
 * lowest shard index). LPT keeps the makespan within 4/3 of the optimum, which
 * is better than first-fit in discovery order for skewed suites.
 */
function partition(files, durations, total) {
  const known = Object.values(durations).filter((v) => typeof v === 'number');
  const fallback = known.length > 0 ? median(known) : DEFAULT_WEIGHT_MS;
  const weighted = files
    .map((file) => ({
      file,
      weight:
        (typeof durations[file] === 'number' ? durations[file] : fallback) + STARTUP_MS,
    }))
    .sort((a, b) => b.weight - a.weight || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const bins = Array.from({ length: total }, () => ({ files: [], load: 0 }));
  for (const { file, weight } of weighted) {
    let target = 0;
    for (let b = 1; b < total; b += 1) {
      if (bins[b].load < bins[target].load) target = b;
    }
    bins[target].files.push(file);
    bins[target].load += weight;
  }
  return bins.map((bin) => bin.files);
}

function isVitestFile(file) {
  return fs.readFileSync(path.join(ROOT, file), 'utf8').includes('vitest');
}

function runFile(file) {
  const cwd = ROOT;
  const env = { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true' };
  let result;
  if (file.endsWith('.ts')) {
    if (isVitestFile(file)) {
      result = spawnSync('npx', ['vitest', 'run', file], { cwd, env, stdio: 'inherit' });
    } else {
      result = spawnSync('npx', ['tsx', file], { cwd, env, stdio: 'inherit' });
    }
  } else {
    // Plain Node test scripts (js/cjs) run directly under the current runtime.
    result = spawnSync(process.execPath, [file], { cwd, env, stdio: 'inherit' });
  }
  return result.status === 0 ? 0 : 1;
}

function measureFile(file) {
  const start = process.hrtime.bigint();
  const status = runFile(file);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  return { status, elapsedMs };
}

function parseArgs(argv) {
  const args = { all: false, list: false, recordDurations: false, shard: null, total: 4 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') args.all = true;
    else if (arg === '--list') args.list = true;
    else if (arg === '--record-durations') args.recordDurations = true;
    else if (arg === '--shard') {
      args.shard = Number(argv[i + 1]);
      i += 1;
    } else if (arg === '--total') {
      args.total = Number(argv[i + 1]);
      i += 1;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(2);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.shard !== null && (args.shard < 0 || args.shard >= args.total)) {
    console.error(`Invalid shard index ${args.shard} for total ${args.total}.`);
    process.exit(2);
  }

  const files = discoverTestFiles();
  if (files.length === 0) {
    console.error('No test files found under tests/.');
    process.exit(1);
  }

  if (args.recordDurations) {
    const durations = {};
    for (const file of files) {
      const { status, elapsedMs } = measureFile(file);
      durations[file] = Math.round(elapsedMs);
      if (status !== 0) {
        console.error(`[FAIL] ${file}`);
        process.exit(1);
      }
    }
    fs.writeFileSync(DURATIONS_FILE, `${JSON.stringify(durations, null, 2)}\n`);
    console.log(`Recorded durations for ${files.length} test files -> ${DURATIONS_FILE}`);
    return;
  }

  const durations = loadDurations();
  let toRun;
  let summary;

  if (args.all) {
    toRun = files;
    summary = `All test files (${files.length})`;
  } else {
    const shards = partition(files, durations, args.total);
    toRun = shards[args.shard];
    const loads = shards.map((shard) =>
      shard.reduce(
        (sum, file) => sum + (durations[file] || 0) + STARTUP_MS,
        0,
      ),
    );
    const estimatedMs = Math.round(loads[args.shard]);
    summary =
      `Shard ${args.shard}/${args.total - 1} ` +
      `(${toRun.length} files, ~${estimatedMs / 1000}s est.)`;
  }

  if (args.list) {
    for (const file of toRun) console.log(file);
    return;
  }

  console.error(`[shard-tests] ${summary}`);
  let failed = 0;
  for (const file of toRun) {
    if (runFile(file) !== 0) {
      console.error(`[FAIL] ${file}`);
      failed += 1;
    }
  }
  if (failed > 0) {
    console.error(`[shard-tests] ${failed} file(s) failed.`);
    process.exit(1);
  }
  console.error('[shard-tests] all files passed.');
}

module.exports = {
  discoverTestFiles,
  loadDurations,
  median,
  partition,
  isVitestFile,
  parseArgs,
};

if (require.main === module) {
  main();
}
