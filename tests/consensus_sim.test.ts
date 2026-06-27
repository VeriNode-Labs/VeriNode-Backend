import { Simulation } from '../src/consensus-sim/simulation';
import { SimulationConfig } from '../src/consensus-sim/faults';
import * as fs from 'fs';

type Scenario = { name: string; cfg: SimulationConfig; maxAllowedRounds?: number };

const validators = Array.from({ length: 8 }, (_, i) => `V${i + 1}`);

const scenarios: Scenario[] = [
  { name: 'baseline-no-faults', cfg: { validators, maxRounds: 10 } },
  {
    name: 'network-partition-then-heal',
    cfg: {
      validators,
      maxRounds: 10,
      faultSpec: { partition: { groups: [validators.slice(0, 4), validators.slice(4)], durationRounds: 2 } },
    },
    maxAllowedRounds: 6,
  },
  {
    name: 'equivocation-from-one-node',
    cfg: { validators, maxRounds: 10, faultSpec: { equivocation: { by: [validators[0]] } } },
  },
  {
    name: 'message-delay-high',
    cfg: { validators, maxRounds: 12, faultSpec: { delay: { ms: 20, jitter: 10, probability: 0.9 } } },
  },
  {
    name: 'validator-timeout-partial',
    cfg: { validators, maxRounds: 10, faultSpec: { timeout: { by: [validators[1], validators[2]], durationRounds: 3 } } },
  },
];

async function runAll() {
  const results: { name: string; ok: boolean; rounds: number; durationMs: number }[] = [];
  for (const s of scenarios) {
    const sim = new Simulation(s.cfg);
    const start = Date.now();
    const res = await sim.run();
    const duration = Date.now() - start;
    const ok = res.recovered && (s.maxAllowedRounds ? res.rounds <= s.maxAllowedRounds : true);
    results.push({ name: s.name, ok, rounds: res.rounds, durationMs: duration });
    console.log(`${s.name}: recovered=${res.recovered} rounds=${res.rounds} duration=${duration}ms`);
  }

  // write JUnit XML
  const xmlParts: string[] = [];
  xmlParts.push('<?xml version="1.0" encoding="UTF-8"?>');
  xmlParts.push(`<testsuite name="consensus-sim" tests="${results.length}" failures="${results.filter(r=>!r.ok).length}">`);
  for (const r of results) {
    xmlParts.push(`<testcase classname="consensus-sim" name="${r.name}" time="${(r.durationMs/1000).toFixed(3)}">`);
    if (!r.ok) {
      xmlParts.push(`<failure message="failed">rounds=${r.rounds}</failure>`);
    }
    xmlParts.push('</testcase>');
  }
  xmlParts.push('</testsuite>');

  const out = xmlParts.join('\n');
  const dir = 'tests-results';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
  fs.writeFileSync(`${dir}/consensus-sim-junit.xml`, out, 'utf8');

  // final exit code
  const allOk = results.every((r) => r.ok);
  if (!allOk) {
    console.error('Some consensus simulation scenarios failed. See tests-results/consensus-sim-junit.xml');
    process.exitCode = 2;
  } else {
    console.log('All consensus simulation scenarios passed. JUnit written to tests-results/consensus-sim-junit.xml');
  }
}

runAll().catch((e) => {
  console.error('Simulation runner error', e);
  process.exitCode = 3;
});
