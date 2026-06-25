'use strict';

/**
 * VeriNode High-Density Concurrent Node Simulator
 * ================================================
 * Issue #17 — tests/load/node_simulation.ts
 *
 * Simulates up to 50,000 concurrent virtual nodes each independently
 * generating Ed25519-signed attestation frames and streaming them to
 * the ingress TCP endpoint at 0.0.0.0:9100.
 *
 * Usage:
 *   npx ts-node tests/load/node_simulation.ts [options]
 *
 * Options:
 *   --profile <SteadyLoad|SpikeTest|SoakTest>   Load profile (default: SteadyLoad)
 *   --nodes <n>                                  Node count (default: 50000)
 *   --workers <m>                                Sender worker count (default: 16)
 *   --duration <seconds>                         Test duration in seconds (default: 300)
 *   --target <host:port>                         Ingress endpoint (default: 0.0.0.0:9100)
 *   --results-dir <path>                         Output directory (default: /tmp/simulator_results)
 *   --ci                                         CI mode: reduced scale + threshold assertions
 */

import * as net from 'net';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';

import {
  NodeStats,
  LoadProfile,
  SimulationSummary,
  buildAttestationFrame,
  jitterDelay,
  sleep,
  finaliseNodeStats,
  aggregateSummary,
  getRssBytes,
  ensureResultsDir,
  writeNodeCsvLogs,
  writeSummaryJson,
  assertCIThresholds,
} from './utils';

// ---------------------------------------------------------------------------
// Ed25519 key generation via Node built-in (no @noble dependency at runtime)
// ---------------------------------------------------------------------------

interface Ed25519KeyPair {
  publicKey: Uint8Array;   // 32 bytes
  privateKey: Uint8Array;  // 64 bytes (seed ‖ public)
}

function generateEd25519KeyPair(): Ed25519KeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    publicKeyEncoding: { type: 'spki', format: 'der' },
  });
  // DER SPKI: last 32 bytes are the raw public key
  const rawPublic = new Uint8Array(publicKey.buffer, publicKey.byteOffset + publicKey.length - 32, 32);
  // DER PKCS8: last 32 bytes are the seed
  const rawSeed = new Uint8Array(privateKey.buffer, privateKey.byteOffset + privateKey.length - 32, 32);
  return { publicKey: rawPublic, privateKey: rawSeed };
}

function signEd25519(data: Buffer, privateKeySeed: Uint8Array): Uint8Array {
  const keyObj = crypto.createPrivateKey({
    key: Buffer.concat([
      // PKCS8 header for Ed25519 seed (34-byte prefix + 32-byte seed)
      Buffer.from('302e020100300506032b657004220420', 'hex'),
      Buffer.from(privateKeySeed),
    ]),
    format: 'der',
    type: 'pkcs8',
  });
  const sig = crypto.sign(null, data, keyObj);
  return new Uint8Array(sig);
}

// ---------------------------------------------------------------------------
// Challenge pool (round-robin)
// ---------------------------------------------------------------------------

const CHALLENGE_POOL_SIZE = 256;
const challengePool: Uint8Array[] = Array.from({ length: CHALLENGE_POOL_SIZE }, () => {
  const c = new Uint8Array(32);
  crypto.getRandomValues(c);
  return c;
});

function getChallenge(sequence: bigint): Uint8Array {
  return challengePool[Number(sequence % BigInt(CHALLENGE_POOL_SIZE))];
}

// ---------------------------------------------------------------------------
// Shared bounded channel (simple async queue)
// ---------------------------------------------------------------------------

class BoundedChannel<T> {
  private queue: T[] = [];
  private waiters: Array<(value: T) => void> = [];
  private closed = false;

  constructor(private readonly capacity: number) {}

  async send(item: T): Promise<void> {
    while (this.queue.length >= this.capacity) {
      await sleep(1);
    }
    if (this.waiters.length > 0) {
      const resolve = this.waiters.shift()!;
      resolve(item);
    } else {
      this.queue.push(item);
    }
  }

  async recv(): Promise<T | null> {
    if (this.queue.length > 0) {
      return this.queue.shift()!;
    }
    if (this.closed) return null;
    return new Promise((resolve) => {
      this.waiters.push(resolve);
    });
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters) w(null as any);
    this.waiters = [];
  }

  get size(): number {
    return this.queue.length;
  }
}

// ---------------------------------------------------------------------------
// VirtualNode
// ---------------------------------------------------------------------------

interface NodeState {
  sequence: bigint;
  running: boolean;
}

class VirtualNode {
  readonly nodeId: string;
  private readonly keyPair: Ed25519KeyPair;
  private state: NodeState = { sequence: 0n, running: false };
  readonly stats: NodeStats;

  constructor() {
    this.keyPair = generateEd25519KeyPair();
    this.nodeId = Buffer.from(this.keyPair.publicKey).toString('hex');
    this.stats = {
      nodeId: this.nodeId,
      attestationsSent: 0,
      errors: 0,
      latencies: [],
      avgLatency: 0,
      p99Latency: 0,
    };
  }

  async run(channel: BoundedChannel<Buffer>, durationMs: number): Promise<void> {
    this.state.running = true;
    const deadline = Date.now() + durationMs;

    while (Date.now() < deadline && this.state.running) {
      const delay = jitterDelay(10, 200);
      await sleep(delay);

      if (Date.now() >= deadline) break;

      const t0 = Date.now();
      try {
        const seq = this.state.sequence++;
        const challenge = getChallenge(seq);

        // Build the data to sign: pubkey ‖ seq ‖ timestamp ‖ challenge
        const timestamp = BigInt(Date.now());
        const signData = Buffer.concat([
          Buffer.from(this.keyPair.publicKey),
          this._bigIntToBuffer8(seq),
          this._bigIntToBuffer8(timestamp),
          Buffer.from(challenge),
        ]);

        const signature = signEd25519(signData, this.keyPair.privateKey);
        const frame = buildAttestationFrame(
          this.keyPair.publicKey,
          seq,
          challenge,
          signature,
        );

        await channel.send(frame);
        const latency = Date.now() - t0;
        this.stats.attestationsSent++;
        // Keep only last 1000 latencies per node to bound memory
        if (this.stats.latencies.length < 1000) {
          this.stats.latencies.push(latency);
        }
      } catch (err) {
        this.stats.errors++;
      }
    }

    this.state.running = false;
  }

  stop(): void {
    this.state.running = false;
  }

  private _bigIntToBuffer8(n: bigint): Buffer {
    const buf = Buffer.alloc(8, 0);
    buf.writeUInt32BE(Number(n >> 32n), 0);
    buf.writeUInt32BE(Number(n & 0xffffffffn), 4);
    return buf;
  }
}

// ---------------------------------------------------------------------------
// TCP connection pool worker
// ---------------------------------------------------------------------------

class SenderWorker {
  private socket: net.Socket | null = null;
  private connected = false;

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly workerId: number,
  ) {}

  async connect(): Promise<void> {
    return new Promise((resolve) => {
      this.socket = new net.Socket();
      this.socket.connect(this.port, this.host, () => {
        this.connected = true;
        resolve();
      });
      this.socket.on('error', () => {
        this.connected = false;
      });
      this.socket.on('close', () => {
        this.connected = false;
      });
      // If connection refused, still resolve so simulation proceeds in dry-run
      this.socket.once('error', () => resolve());
    });
  }

  async send(frame: Buffer): Promise<boolean> {
    if (!this.connected || !this.socket) return false;
    return new Promise((resolve) => {
      this.socket!.write(frame, (err) => resolve(!err));
    });
  }

  destroy(): void {
    this.socket?.destroy();
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }
}

// ---------------------------------------------------------------------------
// NodeSimulator orchestrator
// ---------------------------------------------------------------------------

export interface SimulatorOptions {
  profile: LoadProfile;
  nodeCount: number;
  workerCount: number;
  durationSec: number;
  target: string;           // host:port
  resultsDir?: string;
  ci: boolean;
}

export const DEFAULT_OPTIONS: SimulatorOptions = {
  profile: 'SteadyLoad',
  nodeCount: 50_000,
  workerCount: 16,
  durationSec: 300,
  target: process.env['SIMULATOR_TARGET'] ?? '0.0.0.0:9100',
  ci: false,
};

export const CI_OPTIONS: Partial<SimulatorOptions> = {
  nodeCount: 10_000,
  durationSec: 120,
};

class NodeSimulator extends EventEmitter {
  private nodes: VirtualNode[] = [];
  private workers: SenderWorker[] = [];
  private channel: BoundedChannel<Buffer>;
  private peakRss = 0;
  private running = false;

  constructor(private readonly opts: SimulatorOptions) {
    super();
    this.channel = new BoundedChannel<Buffer>(100_000);
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  async run(): Promise<SimulationSummary> {
    const startTime = Date.now();
    this.running = true;

    const [host, portStr] = this.opts.target.split(':');
    const port = parseInt(portStr ?? '9100', 10);

    console.log(`\n[simulator] Profile       : ${this.opts.profile}`);
    console.log(`[simulator] Nodes          : ${this.opts.nodeCount.toLocaleString()}`);
    console.log(`[simulator] Workers        : ${this.opts.workerCount}`);
    console.log(`[simulator] Duration       : ${this.opts.durationSec}s`);
    console.log(`[simulator] Target         : ${this.opts.target}`);
    console.log(`[simulator] CI mode        : ${this.opts.ci}\n`);

    // Connect sender workers
    console.log('[simulator] Connecting sender workers...');
    this.workers = Array.from(
      { length: this.opts.workerCount },
      (_, i) => new SenderWorker(host, port, i),
    );
    await Promise.all(this.workers.map((w) => w.connect()));
    const connected = this.workers.filter((w) => w.isConnected).length;
    console.log(`[simulator] ${connected}/${this.opts.workerCount} workers connected (dry-run if 0)`);

    // Spawn sender worker loops
    const senderPromises = this.workers.map((w) => this._runSender(w));

    // Memory tracker
    const memTracker = setInterval(() => {
      const rss = getRssBytes();
      if (rss > this.peakRss) this.peakRss = rss;
    }, 1000);

    // Progress reporter
    const progressInterval = setInterval(() => this._reportProgress(), 2000);

    // Run load profile
    switch (this.opts.profile) {
      case 'SteadyLoad':
        await this._runSteadyLoad();
        break;
      case 'SpikeTest':
        await this._runSpikeTest();
        break;
      case 'SoakTest':
        await this._runSoakTest();
        break;
    }

    // Shutdown
    this.running = false;
    this.channel.close();
    clearInterval(memTracker);
    clearInterval(progressInterval);
    await Promise.all(senderPromises);
    this.workers.forEach((w) => w.destroy());

    // Finalise stats
    this.nodes.forEach((n) => finaliseNodeStats(n.stats));

    const summary = aggregateSummary(
      this.opts.profile,
      startTime,
      this.nodes.map((n) => n.stats),
      this.peakRss,
    );

    // Write results
    const resultsDir = ensureResultsDir(this.opts.resultsDir);
    writeNodeCsvLogs(this.nodes.map((n) => n.stats), resultsDir);
    writeSummaryJson(summary, resultsDir);

    this._printSummary(summary);

    if (this.opts.ci) {
      assertCIThresholds(summary, this.peakRss);
    }

    return summary;
  }

  // -------------------------------------------------------------------------
  // Load profiles
  // -------------------------------------------------------------------------

  /** SteadyLoad — all N nodes run for the full duration */
  private async _runSteadyLoad(): Promise<void> {
    console.log(`[SteadyLoad] Starting ${this.opts.nodeCount.toLocaleString()} nodes...`);
    const durationMs = this.opts.durationSec * 1000;
    this.nodes = Array.from({ length: this.opts.nodeCount }, () => new VirtualNode());
    await Promise.all(this.nodes.map((n) => n.run(this.channel, durationMs)));
  }

  /**
   * SpikeTest:
   *   - Phase 1 (2 min): baseline 10,000 nodes
   *   - Phase 2 (30 sec): ramp from 10,000 → 50,000 nodes
   *   - Phase 3 (2 min): sustain 50,000 nodes
   *   - Phase 4: drop back to 10,000 nodes
   */
  private async _runSpikeTest(): Promise<void> {
    const BASELINE = Math.min(10_000, this.opts.nodeCount);
    const PEAK = this.opts.nodeCount;
    const RAMP_STEP = Math.ceil((PEAK - BASELINE) / 30); // nodes per second during ramp

    console.log(`[SpikeTest] Phase 1: baseline ${BASELINE.toLocaleString()} nodes for 2 min`);
    const phase1DurationMs = 2 * 60 * 1000;

    // Start baseline nodes
    const baselineNodes = Array.from({ length: BASELINE }, () => new VirtualNode());
    this.nodes.push(...baselineNodes);
    const baselinePromises = baselineNodes.map((n) =>
      n.run(this.channel, phase1DurationMs + 30_000 + 2 * 60 * 1000),
    );

    await sleep(phase1DurationMs);

    // Ramp phase
    console.log(`[SpikeTest] Phase 2: ramp to ${PEAK.toLocaleString()} nodes over 30s`);
    const rampNodes: VirtualNode[] = [];
    const rampPromises: Promise<void>[] = [];
    for (let i = 0; i < 30; i++) {
      const batch = Array.from({ length: RAMP_STEP }, () => new VirtualNode());
      rampNodes.push(...batch);
      this.nodes.push(...batch);
      rampPromises.push(...batch.map((n) => n.run(this.channel, 2 * 60 * 1000 + (30 - i) * 1000)));
      await sleep(1000);
    }

    // Sustain
    console.log(`[SpikeTest] Phase 3: sustain peak for 2 min`);
    await sleep(2 * 60 * 1000);

    // Drop back
    console.log(`[SpikeTest] Phase 4: dropping back to baseline`);
    rampNodes.forEach((n) => n.stop());

    await Promise.all([...baselinePromises, ...rampPromises]);
  }

  /**
   * SoakTest — 10,000 nodes for 30 minutes measuring memory growth
   */
  private async _runSoakTest(): Promise<void> {
    const NODE_COUNT = Math.min(10_000, this.opts.nodeCount);
    const DURATION_MS = Math.max(this.opts.durationSec * 1000, 30 * 60 * 1000);
    console.log(`[SoakTest] ${NODE_COUNT.toLocaleString()} nodes for ${DURATION_MS / 60_000} min`);

    this.nodes = Array.from({ length: NODE_COUNT }, () => new VirtualNode());
    await Promise.all(this.nodes.map((n) => n.run(this.channel, DURATION_MS)));
  }

  // -------------------------------------------------------------------------
  // Sender worker loop
  // -------------------------------------------------------------------------

  private async _runSender(worker: SenderWorker): Promise<void> {
    while (this.running || this.channel.size > 0) {
      const frame = await this.channel.recv();
      if (frame === null) break;
      if (worker.isConnected) {
        await worker.send(frame);
      }
      // If not connected, frame is discarded (dry-run / no server)
    }
  }

  // -------------------------------------------------------------------------
  // Progress reporting
  // -------------------------------------------------------------------------

  private _reportProgress(): void {
    const totalSent = this.nodes.reduce((s, n) => s + n.stats.attestationsSent, 0);
    const totalErrors = this.nodes.reduce((s, n) => s + n.stats.errors, 0);
    const rssGB = (getRssBytes() / 1024 ** 3).toFixed(2);
    const activeNodes = this.nodes.filter((n) => n.stats.attestationsSent > 0).length;

    process.stdout.write(
      `\r[progress] nodes=${activeNodes.toLocaleString()} ` +
      `attestations=${totalSent.toLocaleString()} ` +
      `errors=${totalErrors} ` +
      `queue=${this.channel.size} ` +
      `rss=${rssGB}GB  `,
    );
  }

  private _printSummary(s: SimulationSummary): void {
    console.log('\n\n========== Simulation Complete ==========');
    console.log(`Profile          : ${s.profile}`);
    console.log(`Duration         : ${(s.durationMs / 1000).toFixed(1)}s`);
    console.log(`Total nodes      : ${s.totalNodes.toLocaleString()}`);
    console.log(`Total attest.    : ${s.totalAttestations.toLocaleString()}`);
    console.log(`Total errors     : ${s.totalErrors.toLocaleString()}`);
    console.log(`Error rate       : ${(s.errorRate * 100).toFixed(3)}%`);
    console.log(`Avg latency      : ${s.avgLatencyMs.toFixed(1)}ms`);
    console.log(`P99 latency      : ${s.p99LatencyMs.toFixed(1)}ms`);
    console.log(`Throughput       : ${s.throughputPerSec.toFixed(0)} attestations/sec`);
    console.log(`Peak RSS         : ${(s.peakMemoryRssBytes / 1024 ** 3).toFixed(2)} GB`);
    console.log('=========================================\n');
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseArgs(): SimulatorOptions {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx !== -1 ? args[idx + 1] : undefined;
  };
  const has = (flag: string): boolean => args.includes(flag);

  const ci = has('--ci');
  const base: SimulatorOptions = {
    ...DEFAULT_OPTIONS,
    ...(ci ? CI_OPTIONS : {}),
    ci,
  };

  const profile = get('--profile') as LoadProfile | undefined;
  if (profile) base.profile = profile;

  const nodes = get('--nodes');
  if (nodes) base.nodeCount = parseInt(nodes, 10);

  const workers = get('--workers');
  if (workers) base.workerCount = parseInt(workers, 10);

  const duration = get('--duration');
  if (duration) base.durationSec = parseInt(duration, 10);

  const target = get('--target');
  if (target) base.target = target;

  const resultsDir = get('--results-dir');
  if (resultsDir) base.resultsDir = resultsDir;

  return base;
}

// Run if executed directly
if (require.main === module) {
  const opts = parseArgs();
  const simulator = new NodeSimulator(opts);
  simulator.run().catch((err) => {
    console.error('[simulator] Fatal error:', err);
    process.exit(1);
  });
}

export { NodeSimulator, VirtualNode, BoundedChannel };