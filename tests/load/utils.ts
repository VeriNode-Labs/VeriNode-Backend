'use strict';

/**
 * VeriNode Load Test Utilities
 * Shared helpers for the node simulation benchmark.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NodeStats {
  nodeId: string;
  attestationsSent: number;
  errors: number;
  latencies: number[]; // ms
  avgLatency: number;
  p99Latency: number;
}

export interface SimulationSummary {
  profile: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  totalNodes: number;
  totalAttestations: number;
  totalErrors: number;
  errorRate: number;        // fraction 0–1
  avgLatencyMs: number;
  p99LatencyMs: number;
  peakMemoryRssBytes: number;
  throughputPerSec: number;
}

export type LoadProfile = 'SteadyLoad' | 'SpikeTest' | 'SoakTest';

// ---------------------------------------------------------------------------
// Jitter / timing helpers
// ---------------------------------------------------------------------------

/**
 * Returns a random delay in ms drawn from a uniform distribution [minMs, maxMs].
 */
export function jitterDelay(minMs = 10, maxMs = 200): number {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/**
 * Sleep for `ms` milliseconds.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Frame builder
// ---------------------------------------------------------------------------

/**
 * Builds a 256-byte length-prefixed attestation frame per frame_spec.md.
 *
 *  [4B length=256][32B pubkey][8B sequence][8B timestamp][32B challenge][64B signature][112B payload]
 *
 * In simulation mode the Ed25519 signature field is filled with zeroed bytes
 * (the ingress endpoint does not verify signatures in bench mode).
 */
export function buildAttestationFrame(
  pubKey: Uint8Array,       // 32 bytes
  sequence: bigint,
  challenge: Uint8Array,    // 32 bytes
  signature: Uint8Array,    // 64 bytes
): Buffer {
  const FRAME_BODY = 256; // bytes after the length prefix
  const buf = Buffer.alloc(4 + FRAME_BODY, 0);

  let offset = 0;

  // Length prefix
  buf.writeUInt32BE(FRAME_BODY, offset);
  offset += 4;

  // Node ID (public key — 32 bytes)
  Buffer.from(pubKey).copy(buf, offset);
  offset += 32;

  // Sequence (8 bytes, BigInt → UInt64BE simulated with two UInt32BE)
  const seqHi = Number(sequence >> 32n);
  const seqLo = Number(sequence & 0xffffffffn);
  buf.writeUInt32BE(seqHi, offset);
  buf.writeUInt32BE(seqLo, offset + 4);
  offset += 8;

  // Timestamp (8 bytes)
  const now = BigInt(Date.now());
  const tsHi = Number(now >> 32n);
  const tsLo = Number(now & 0xffffffffn);
  buf.writeUInt32BE(tsHi, offset);
  buf.writeUInt32BE(tsLo, offset + 4);
  offset += 8;

  // Challenge (32 bytes)
  Buffer.from(challenge).copy(buf, offset);
  offset += 32;

  // Signature (64 bytes)
  Buffer.from(signature).copy(buf, offset);
  offset += 64;

  // Payload (112 bytes — zeroed)
  offset += 112;

  return buf;
}

// ---------------------------------------------------------------------------
// Statistics helpers
// ---------------------------------------------------------------------------

export function computePercentile(sortedArr: number[], p: number): number {
  if (sortedArr.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sortedArr.length) - 1;
  return sortedArr[Math.max(0, idx)];
}

export function finaliseNodeStats(stats: NodeStats): NodeStats {
  const sorted = [...stats.latencies].sort((a, b) => a - b);
  stats.avgLatency =
    sorted.length > 0 ? sorted.reduce((s, v) => s + v, 0) / sorted.length : 0;
  stats.p99Latency = computePercentile(sorted, 99);
  return stats;
}

export function aggregateSummary(
  profile: LoadProfile,
  startTime: number,
  nodeStats: NodeStats[],
  peakMemoryRssBytes: number,
): SimulationSummary {
  const endTime = Date.now();
  const durationMs = endTime - startTime;

  const totalAttestations = nodeStats.reduce((s, n) => s + n.attestationsSent, 0);
  const totalErrors = nodeStats.reduce((s, n) => s + n.errors, 0);
  const allLatencies = nodeStats.flatMap((n) => n.latencies).sort((a, b) => a - b);

  const avgLatencyMs =
    allLatencies.length > 0
      ? allLatencies.reduce((s, v) => s + v, 0) / allLatencies.length
      : 0;
  const p99LatencyMs = computePercentile(allLatencies, 99);
  const errorRate = totalAttestations + totalErrors > 0
    ? totalErrors / (totalAttestations + totalErrors)
    : 0;

  return {
    profile,
    startTime,
    endTime,
    durationMs,
    totalNodes: nodeStats.length,
    totalAttestations,
    totalErrors,
    errorRate,
    avgLatencyMs,
    p99LatencyMs,
    peakMemoryRssBytes,
    throughputPerSec: durationMs > 0 ? (totalAttestations / durationMs) * 1000 : 0,
  };
}

// ---------------------------------------------------------------------------
// Memory helpers
// ---------------------------------------------------------------------------

/** Returns current RSS in bytes from process.memoryUsage() */
export function getRssBytes(): number {
  return process.memoryUsage().rss;
}

// ---------------------------------------------------------------------------
// Output / reporting helpers
// ---------------------------------------------------------------------------

export function ensureResultsDir(dir?: string): string {
  const resultsDir = dir ?? process.env['SIMULATOR_RESULTS_DIR'] ?? '/tmp/simulator_results';
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }
  return resultsDir;
}

export function writeNodeCsvLogs(nodeStats: NodeStats[], resultsDir: string): void {
  const csvPath = path.join(resultsDir, 'per_node_stats.csv');
  const header = 'nodeId,attestationsSent,errors,avgLatencyMs,p99LatencyMs\n';
  const rows = nodeStats
    .map(
      (n) =>
        `${n.nodeId},${n.attestationsSent},${n.errors},${n.avgLatency.toFixed(2)},${n.p99Latency.toFixed(2)}`,
    )
    .join('\n');
  fs.writeFileSync(csvPath, header + rows + '\n');
  console.log(`[utils] Per-node CSV written to ${csvPath}`);
}

export function writeSummaryJson(summary: SimulationSummary, resultsDir: string): void {
  const jsonPath = path.join(resultsDir, 'summary.json');
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2));
  console.log(`[utils] Summary JSON written to ${jsonPath}`);
}

// ---------------------------------------------------------------------------
// CI assertions
// ---------------------------------------------------------------------------

export interface CIThresholds {
  maxErrorRate: number;      // e.g. 0.001 = 0.1%
  maxP99LatencyMs: number;   // e.g. 500
  maxRssBytes: number;       // e.g. 4 * 1024**3 = 4 GB
}

export const DEFAULT_CI_THRESHOLDS: CIThresholds = {
  maxErrorRate: 0.001,
  maxP99LatencyMs: 500,
  maxRssBytes: 4 * 1024 ** 3,
};

export function assertCIThresholds(
  summary: SimulationSummary,
  peakRss: number,
  thresholds: CIThresholds = DEFAULT_CI_THRESHOLDS,
): void {
  const failures: string[] = [];

  if (summary.errorRate > thresholds.maxErrorRate) {
    failures.push(
      `Error rate ${(summary.errorRate * 100).toFixed(3)}% exceeds limit ${(thresholds.maxErrorRate * 100).toFixed(3)}%`,
    );
  }

  if (summary.p99LatencyMs > thresholds.maxP99LatencyMs) {
    failures.push(
      `P99 latency ${summary.p99LatencyMs.toFixed(1)}ms exceeds limit ${thresholds.maxP99LatencyMs}ms`,
    );
  }

  if (peakRss > thresholds.maxRssBytes) {
    failures.push(
      `Peak RSS ${(peakRss / 1024 ** 3).toFixed(2)} GB exceeds limit ${(thresholds.maxRssBytes / 1024 ** 3).toFixed(0)} GB`,
    );
  }

  if (failures.length > 0) {
    console.error('\n[CI] ❌ Threshold violations:');
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }

  console.log('\n[CI] ✅ All thresholds passed.');
}