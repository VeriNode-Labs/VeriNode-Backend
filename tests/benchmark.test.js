'use strict';

const { BatchValidator } = require('../src/core/attestation/engine');
const { verifyProofOfPossession } = require('../src/core/crypto/aggregate_sig');
const { execSync } = require('node:child_process');
const { writeFileSync, existsSync, readFileSync } = require('node:fs');
const os = require('node:os');

function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];
}

async function kgen(n) {
  const ed = (await import('@noble/curves/ed25519.js')).ed25519;
  const keys = [];
  for (let i = 0; i < n; i++) {
    const priv = ed.utils.randomSecretKey();
    keys.push({ priv, pub: ed.getPublicKey(priv) });
  }
  return keys;
}

async function main() {
  let commit = '';
  try { commit = execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim(); } catch {}

  const validator = new BatchValidator({ maxBatchSize: 2048, parallelism: os.cpus().length });
  const msg = Buffer.from('benchmark-attestation');

  const keys100 = await kgen(100);
  const ed100 = await import('@noble/curves/ed25519.js');
  const sigs100 = keys100.map(k => ed100.ed25519.sign(msg, k.priv));
  const batch100 = keys100.map((k, i) => ({ message: msg, signature: sigs100[i], publicKey: k.pub }));
  const t0 = performance.now();
  await validator.validateBatch(batch100, 'Ed25519');
  const normOps = 100 / ((performance.now() - t0) / 1000);

  const keys1k = await kgen(1000);
  const ed1k = await import('@noble/curves/ed25519.js');
  const sigs1k = keys1k.map(k => ed1k.ed25519.sign(msg, k.priv));
  const batch1k = keys1k.map((k, i) => ({ message: msg, signature: sigs1k[i], publicKey: k.pub }));
  const t1 = performance.now();
  await validator.validateBatch(batch1k, 'Ed25519');
  const peakOps = 1000 / ((performance.now() - t1) / 1000);

  const blockTimes = [];
  for (const size of [10, 20, 50, 100, 200, 500]) {
    const keys = await kgen(size);
    const edMod = await import('@noble/curves/ed25519.js');
    const sigs = keys.map(k => edMod.ed25519.sign(msg, k.priv));
    const batch = keys.map((k, i) => ({ message: msg, signature: sigs[i], publicKey: k.pub }));
    for (let r = 0; r < 3; r++) {
      const ts = performance.now();
      await validator.validateBatch(batch, 'Ed25519');
      blockTimes.push(performance.now() - ts);
    }
  }
  blockTimes.sort((a, b) => a - b);

  const popDom = Buffer.from('VERINODE_POP_V1');
  const reconfigResults = {};
  for (const size of [100, 1000]) {
    const s = performance.now();
    const keys = await kgen(size);
    const edMod = await import('@noble/curves/ed25519.js');
    const proofs = keys.map(k => edMod.ed25519.sign(Buffer.concat([popDom, k.pub]), k.priv));
    await Promise.all(proofs.map((p, i) => verifyProofOfPossession(keys[i].pub, p)));
    reconfigResults[size] = performance.now() - s;
  }

  const results = {
    attestation_throughput_normal_ops_per_sec: Math.round(normOps * 100) / 100,
    attestation_throughput_peak_ops_per_sec: Math.round(peakOps * 100) / 100,
    block_time_p50_ms: Math.round(pct(blockTimes, 0.5) * 100) / 100,
    block_time_p95_ms: Math.round(pct(blockTimes, 0.95) * 100) / 100,
    block_time_p99_ms: Math.round(pct(blockTimes, 0.99) * 100) / 100,
    committee_reconfiguration_100_ms: Math.round(reconfigResults[100] * 100) / 100,
    committee_reconfiguration_1000_ms: Math.round(reconfigResults[1000] * 100) / 100,
  };

  const report = {
    commit,
    timestamp: new Date().toISOString(),
    env: {
      node: process.version,
      os: `${os.platform()} ${os.release()}`,
      cpus: os.cpus().length,
      memory: `${Math.round(os.totalmem() / 1024 / 1024 / 1024)}GB`,
    },
    results,
  };

  writeFileSync('benchmark-report.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  if (existsSync('baseline-report.json')) {
    let baseline;
    try { baseline = JSON.parse(readFileSync('baseline-report.json', 'utf-8')); } catch {}
    if (baseline && baseline.results) {
      const failures = [];
      for (const [key, val] of Object.entries(results)) {
        const bv = baseline.results[key];
        if (bv === undefined || val === 0) continue;
        const deg = key.includes('ops_per_sec') ? (bv - val) / bv : (val - bv) / bv;
        if (deg > 0.05) failures.push(`${key}: ${(deg * 100).toFixed(1)}% degradation`);
      }
      if (failures.length) {
        console.log('\nTHRESHOLD EXCEEDED:');
        failures.forEach(f => console.log(`  - ${f}`));
        process.exit(1);
      }
      console.log('\nAll metrics within 5% threshold');
    }
  } else {
    console.log('\nNo baseline found - this run will serve as baseline');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
