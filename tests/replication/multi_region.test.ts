import assert from 'node:assert/strict';
import { MultiRegionRecoveryCoordinator, RegionStatus } from '../../src/replication';

const now = 1_700_000_000_000;

function region(overrides: Partial<RegionStatus>): RegionStatus {
  return {
    name: 'us-east-1',
    role: 'primary',
    health: 'healthy',
    replicationLagMs: 100,
    p99LatencyMs: 40,
    lastHeartbeatAt: now - 1000,
    priority: 10,
    ...overrides,
  };
}

const coordinator = new MultiRegionRecoveryCoordinator({}, () => now);
const topology = [
  region({ name: 'us-east-1', role: 'primary', priority: 1 }),
  region({ name: 'us-west-2', role: 'standby', priority: 2 }),
  region({ name: 'eu-west-1', role: 'standby', priority: 3 }),
];

assert.deepEqual(coordinator.buildReplicationPlan(topology), {
  sourceRegion: 'us-east-1',
  targetRegions: ['us-west-2', 'eu-west-1'],
  mode: 'async',
  quorumRegions: 1,
  maxCommitLatencyMs: 100,
});

assert.deepEqual(coordinator.evaluate(topology), { action: 'none', reasons: [], writeSafe: true });

const degradedPrimary = [
  region({ name: 'us-east-1', role: 'primary', health: 'unhealthy', priority: 1 }),
  region({ name: 'us-west-2', role: 'standby', replicationLagMs: 20, priority: 2 }),
];
assert.equal(coordinator.evaluate(degradedPrimary).action, 'promote_standby');
assert.equal(coordinator.evaluate(degradedPrimary).toRegion, 'us-west-2');

const noStandby = [
  region({ name: 'us-east-1', role: 'primary', health: 'unhealthy', priority: 1 }),
  region({ name: 'us-west-2', role: 'standby', health: 'degraded', priority: 2 }),
];
assert.equal(coordinator.evaluate(noStandby).action, 'halt_writes');
assert.equal(coordinator.evaluate(noStandby).writeSafe, false);

const metrics = coordinator.generatePrometheusMetrics(topology);
assert.match(
  metrics,
  /verinode_region_replication_lag_ms\{region="us-east-1",role="primary",health="healthy"\} 100/,
);
assert.match(metrics, /verinode_region_p99_latency_ms/);

console.log('multi-region replication tests passed');
