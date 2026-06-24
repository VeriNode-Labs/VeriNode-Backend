const fs = require('fs');
const path = require('path');

const coveragePath = '/home/kimani/grantfox/VeriNode-Backend/coverage/coverage-final.json';
const srcRoot = '/home/kimani/grantfox/VeriNode-Backend/src';

const raw = JSON.parse(fs.readFileSync(coveragePath, 'utf-8'));

// Map of module -> files we care about
const modules = {
  'src/core': ['core/attestation/engine.js', 'core/crypto/aggregate_sig.js', 'core/crypto/signature.js'],
  'src/config': ['config/database.ts'],
  'src/staking': ['staking/slashing_agent.ts', 'staking/slashing_sequencer.ts'],
  'src/blockchain': ['blockchain/rpc_client.ts', 'blockchain/state_archival.ts', 'blockchain/transaction_builder.ts'],
};

for (const [modName, relFiles] of Object.entries(modules)) {
  console.log('='.repeat(100));
  console.log(`MODULE: ${modName}`);
  console.log('='.repeat(100));

  for (const relFile of relFiles) {
    const absPath = path.join(srcRoot, relFile);
    const key = absPath;

    const entry = raw[key];
    if (!entry) {
      console.log(`\n  [File not found in coverage data] ${relFile}`);
      continue;
    }

    const sourceLines = fs.readFileSync(absPath, 'utf-8').split('\n');
    const sm = entry.statementMap;
    const s = entry.s;
    const fnMap = entry.fnMap || {};
    const f = entry.f;

    console.log(`\n  FILE: ${relFile}`);

    // --- Uncovered functions ---
    const uncoveredFns = [];
    for (const [fnId, fnInfo] of Object.entries(fnMap)) {
      if (f[fnId] === 0) {
        const fnName = fnInfo.name || '(anonymous)';
        const line = fnInfo.line || fnInfo.loc?.start?.line || fnMap[fnId]?.loc?.start?.line || '?';
        uncoveredFns.push({ name: fnName, line: fnInfo.loc?.start?.line || '?' });
      }
    }

    if (uncoveredFns.length > 0) {
      console.log(`  FUNCTIONS UNCOVERED (0% hit):`);
      for (const fn of uncoveredFns) {
        console.log(`    - ${fn.name} (line ${fn.line})`);
      }
    } else {
      console.log(`  FUNCTIONS UNCOVERED: (none)`);
    }

    // --- Total fn stats ---
    const totalFns = Object.keys(fnMap).length;
    const coveredFns = Object.values(f).filter(v => v > 0).length;
    console.log(`  FUNCTION COVERAGE: ${coveredFns}/${totalFns} (${totalFns > 0 ? Math.round(coveredFns/totalFns*100) : 0}%)`);

    // Gather uncovered statements
    const uncoveredStatements = [];
    for (const [stmtId, stmtInfo] of Object.entries(sm)) {
      if (s[stmtId] === 0) {
        const line = stmtInfo.start.line;
        const srcLine = sourceLines[line - 1] || '';
        uncoveredStatements.push({ line, code: srcLine });
      }
    }

    // Deduplicate by line (multiple statements can map to same line)
    const seenLines = new Set();
    const deduped = [];
    for (const us of uncoveredStatements.sort((a, b) => a.line - b.line)) {
      if (!seenLines.has(us.line)) {
        seenLines.add(us.line);
        deduped.push(us);
      }
    }

    const totalStmts = Object.keys(s).length;
    const coveredStmts = Object.values(s).filter(v => v > 0).length;

    console.log(`  STATEMENT COVERAGE: ${coveredStmts}/${totalStmts} (${totalStmts > 0 ? Math.round(coveredStmts/totalStmts*100) : 0}%)`);

    if (deduped.length > 0) {
      console.log(`  UNCOVERED STATEMENTS (${deduped.length} unique lines):`);
      for (const { line, code } of deduped) {
        console.log(`    L${line}: ${code}`);
      }
    } else {
      console.log(`  UNCOVERED STATEMENTS: (none)`);
    }

    console.log();
  }
}

// Summary stats
console.log('='.repeat(100));
console.log('OVERALL SUMMARY');
console.log('='.repeat(100));
let totalStmts = 0, totalCoveredStmts = 0;
let totalFns = 0, totalCoveredFns = 0;

for (const [relFile, entry] of Object.entries(raw)) {
  if (relFile.startsWith(srcRoot)) {
    const s = entry.s;
    const f = entry.f;
    if (s) {
      totalStmts += Object.keys(s).length;
      totalCoveredStmts += Object.values(s).filter(v => v > 0).length;
    }
    if (f) {
      totalFns += Object.keys(f).length;
      totalCoveredFns += Object.values(f).filter(v => v > 0).length;
    }
  }
}

console.log(`Total statement coverage: ${totalCoveredStmts}/${totalStmts} (${totalStmts > 0 ? Math.round(totalCoveredStmts/totalStmts*100) : 0}%)`);
console.log(`Total function coverage:  ${totalCoveredFns}/${totalFns} (${totalFns > 0 ? Math.round(totalCoveredFns/totalFns*100) : 0}%)`);
