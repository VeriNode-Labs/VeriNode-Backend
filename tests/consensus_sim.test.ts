import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// Executes the comprehensive validator consensus failure modes regression suite
const suitePath = path.resolve(__dirname, 'consensus', 'validator_failure_modes.test.cjs');
const output = execFileSync(process.execPath, [suitePath], { encoding: 'utf8' });

assert.match(output, /All 7 Validator Consensus Failure Mode Regression Tests PASSED!/);
console.log(output);
console.log('tests/consensus_sim.test.ts passed successfully');
