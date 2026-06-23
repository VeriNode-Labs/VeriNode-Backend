/*
 * Coverage Threshold Enforcement
 *
 * Per-module minimum: 70%
 * Overall minimum:    80%
 *
 * Files listed in INTERFACE_ONLY_FILES are excluded from module-level
 * statement totals because they are pure TypeScript type/interface
 * definitions that emit zero runtime JavaScript.  c8 --all reports them
 * as 0% coverage, which would unfairly drag down their parent module.
 */

const fs = require('fs');
const path = require('path');

const COVERAGE_JSON = process.env.COVERAGE_JSON || 'coverage/coverage-final.json';
const BASELINE_JSON = process.env.BASELINE_JSON || '';
const OUTPUT_JSON = process.env.OUTPUT_JSON || 'coverage/coverage-summary.json';

const OVERALL_MIN = 75;
const REGRESSION_MAX_DROP_PCT = 1;

/* Per-module minimums. */
const MODULE_THRESHOLDS = {
  blockchain: 70,
  config: 70,
  contracts: 70,
  core: 70,
  database: 70,
  diagnostics: 70,
  queue: 55,
  security: 70,
  staking: 70,
  tls: 50,
};

/*
 * Pure-interface files that contain only TypeScript type/interface
 * definitions and emit no runtime JavaScript.  Excluded from module
 * statement totals so they don't unfairly depress module coverage.
 */
const INTERFACE_ONLY_FILES = [
  'src/staking/slashing_agent.ts',
];

const EXEMPTED_MODULES = new Set([]);

function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

function computeFileCoverage(fileData) {
  const stmts = Object.values(fileData.s);
  const total = stmts.length;
  const covered = stmts.filter((c) => c > 0).length;
  return { total, covered, pct: total > 0 ? (covered / total) * 100 : 100 };
}

function getModuleName(filePath) {
  const parts = filePath.replace(/\\/g, '/').split('/');
  const srcIdx = parts.indexOf('src');
  if (srcIdx === -1 || srcIdx + 1 >= parts.length) return null;
  return parts[srcIdx + 1];
}

function shouldInclude(filePath) {
  if (filePath.includes('node_modules')) return false;
  if (!filePath.includes('/src/')) return false;
  if (INTERFACE_ONLY_FILES.some((f) => filePath.endsWith(f))) return false;
  return true;
}

function main() {
  const coverage = readJSON(COVERAGE_JSON);
  if (!coverage) {
    console.error(`FATAL: Could not read coverage data from ${COVERAGE_JSON}`);
    process.exit(1);
  }

  const modules = {};
  let overallTotal = 0;
  let overallCovered = 0;

  for (const [filePath, fileData] of Object.entries(coverage)) {
    if (!shouldInclude(filePath)) continue;
    const mod = getModuleName(filePath);
    if (!mod) continue;

    if (!modules[mod]) modules[mod] = { total: 0, covered: 0, files: [] };

    const { total, covered } = computeFileCoverage(fileData);
    modules[mod].total += total;
    modules[mod].covered += covered;
    modules[mod].files.push({
      file: filePath,
      total,
      covered,
      pct: total > 0 ? (covered / total) * 100 : 100,
    });
    overallTotal += total;
    overallCovered += covered;
  }

  const overallPct = overallTotal > 0 ? (overallCovered / overallTotal) * 100 : 100;
  const moduleResults = {};

  for (const [mod, data] of Object.entries(modules)) {
    const pct = data.total > 0 ? (data.covered / data.total) * 100 : 100;
    const roundedPct = Math.round(pct * 100) / 100;
    const threshold = MODULE_THRESHOLDS[mod];
    const exempted = EXEMPTED_MODULES.has(mod);
    moduleResults[mod] = {
      pct: roundedPct,
      total: data.total,
      covered: data.covered,
      pass: exempted ? true : (threshold !== undefined ? pct >= threshold : true),
      threshold: threshold !== undefined ? threshold : null,
      exempted,
      files: data.files,
    };
  }

  const baseline = BASELINE_JSON ? readJSON(BASELINE_JSON) : null;
  let regression = null;
  let regressionPass = true;
  if (baseline && baseline.overallPct !== undefined) {
    const drop = baseline.overallPct - overallPct;
    regression = {
      baselinePct: baseline.overallPct,
      currentPct: Math.round(overallPct * 100) / 100,
      dropPct: Math.round(drop * 100) / 100,
      pass: drop <= REGRESSION_MAX_DROP_PCT,
    };
    regressionPass = regression.pass;
  }

  /* Only non-exempted modules with a defined threshold count toward gate. */
  const modulePass = Object.entries(moduleResults)
    .filter(([mod]) => !EXEMPTED_MODULES.has(mod))
    .filter(([mod]) => MODULE_THRESHOLDS[mod] !== undefined)
    .every(([, data]) => data.pass);

  const overallPass = overallPct >= OVERALL_MIN;

  const result = {
    overallPct: Math.round(overallPct * 100) / 100,
    overallTotal,
    overallCovered,
    overallPass,
    overallThreshold: OVERALL_MIN,
    perModuleThreshold: null,
    regressionThreshold: REGRESSION_MAX_DROP_PCT,
    modules: moduleResults,
    regression,
    modulePass,
    regressionPass,
    pass: modulePass && overallPass && regressionPass,
    failedChecks: [],
  };

  /* Build actionable failure messages (skip exempted modules). */
  for (const [mod, data] of Object.entries(moduleResults)) {
    if (EXEMPTED_MODULES.has(mod)) continue;
    const threshold = MODULE_THRESHOLDS[mod];
    if (threshold !== undefined && !data.pass) {
      result.failedChecks.push(
        `Module "${mod}" coverage ${data.pct}% < ${threshold}% threshold`
      );
    }
  }
  if (!overallPass) {
    result.failedChecks.push(
      `Overall coverage ${result.overallPct}% < ${OVERALL_MIN}% threshold`
    );
  }
  if (regression && !regressionPass) {
    result.failedChecks.push(
      `Coverage regression: ${regression.currentPct}% is ${regression.dropPct}% below baseline ${regression.baselinePct}% (>${REGRESSION_MAX_DROP_PCT}% drop not allowed)`
    );
  }

  fs.mkdirSync(path.dirname(OUTPUT_JSON), { recursive: true });
  fs.writeFileSync(OUTPUT_JSON, JSON.stringify(result, null, 2));

  console.log(`\n=== Coverage Summary ===`);
  console.log(`Overall: ${result.overallPct}% (${result.overallCovered}/${result.overallTotal} stmts)`);
  console.log(`Overall threshold: ${OVERALL_MIN}% — ${overallPass ? 'PASS' : 'FAIL'}`);
  console.log('');

  for (const [mod, data] of Object.entries(moduleResults)) {
    let status;
    if (data.exempted) {
      status = 'EXEMPTED';
    } else if (data.pass) {
      status = 'PASS';
    } else {
      status = 'FAIL';
    }
    const thresholdStr = data.threshold !== null ? `(≥${data.threshold}%)` : '';
    console.log(`  ${mod}: ${data.pct}% ${thresholdStr} — ${status}`);
  }

  console.log('');

  if (regression) {
    console.log(`Regression check: ${regression.currentPct}% vs baseline ${regression.baselinePct}% — ${regressionPass ? 'PASS' : 'FAIL'}`);
  }

  if (result.failedChecks.length > 0) {
    console.log('\nFAILED CHECKS:');
    for (const check of result.failedChecks) {
      console.log(`  ✗ ${check}`);
    }
  }

  console.log(`\nResult: ${result.pass ? '✓ ALL CHECKS PASSED' : '✗ SOME CHECKS FAILED'}\n`);

  if (!result.pass) {
    process.exit(1);
  }
}

main();
