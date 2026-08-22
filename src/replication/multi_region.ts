export type RegionRole = 'primary' | 'standby';
export type RegionHealth = 'healthy' | 'degraded' | 'unhealthy';
export type ReplicationMode = 'sync' | 'async';

export interface RegionStatus {
  name: string;
  role: RegionRole;
  health: RegionHealth;
  replicationLagMs: number;
  p99LatencyMs: number;
  lastHeartbeatAt: number;
  priority: number;
}

export interface DisasterRecoveryPolicy {
  maxReplicationLagMs: number;
  maxCriticalPathP99Ms: number;
  heartbeatTimeoutMs: number;
  minHealthyStandbyRegions: number;
  availabilityTarget: number;
}

export interface FailoverDecision {
  action: 'none' | 'promote_standby' | 'halt_writes';
  fromRegion?: string;
  toRegion?: string;
  reasons: string[];
  writeSafe: boolean;
}

export interface ReplicationPlan {
  sourceRegion: string;
  targetRegions: string[];
  mode: ReplicationMode;
  quorumRegions: number;
  maxCommitLatencyMs: number;
}

export const DEFAULT_DR_POLICY: DisasterRecoveryPolicy = {
  maxReplicationLagMs: 5000,
  maxCriticalPathP99Ms: 100,
  heartbeatTimeoutMs: 15000,
  minHealthyStandbyRegions: 1,
  availabilityTarget: 0.9999,
};

export class MultiRegionRecoveryCoordinator {
  private readonly policy: DisasterRecoveryPolicy;
  private readonly now: () => number;

  constructor(policy: Partial<DisasterRecoveryPolicy> = {}, now: () => number = Date.now) {
    this.policy = { ...DEFAULT_DR_POLICY, ...policy };
    this.now = now;
  }

  buildReplicationPlan(regions: RegionStatus[]): ReplicationPlan {
    const primary = this.requireSinglePrimary(regions);
    const targets = regions
      .filter((region) => region.name !== primary.name)
      .sort((a, b) => a.priority - b.priority)
      .map((region) => region.name);

    return {
      sourceRegion: primary.name,
      targetRegions: targets,
      mode: 'async',
      quorumRegions: Math.min(targets.length, this.policy.minHealthyStandbyRegions),
      maxCommitLatencyMs: this.policy.maxCriticalPathP99Ms,
    };
  }

  evaluate(regions: RegionStatus[]): FailoverDecision {
    const primary = this.requireSinglePrimary(regions);
    const standbyRegions = regions.filter((region) => region.role === 'standby');
    const unhealthyReasons = this.findRegionRisks(primary);
    const healthyStandbyRegions = standbyRegions
      .filter((region) => this.isPromotionCandidate(region))
      .sort((a, b) => a.priority - b.priority || a.replicationLagMs - b.replicationLagMs);

    if (healthyStandbyRegions.length < this.policy.minHealthyStandbyRegions) {
      return {
        action: 'halt_writes',
        fromRegion: primary.name,
        reasons: [
          `healthy standby count ${healthyStandbyRegions.length} below required ${this.policy.minHealthyStandbyRegions}`,
          ...unhealthyReasons,
        ],
        writeSafe: false,
      };
    }

    if (unhealthyReasons.length > 0) {
      return {
        action: 'promote_standby',
        fromRegion: primary.name,
        toRegion: healthyStandbyRegions[0].name,
        reasons: unhealthyReasons,
        writeSafe: true,
      };
    }

    return { action: 'none', reasons: [], writeSafe: true };
  }

  generatePrometheusMetrics(regions: RegionStatus[]): string {
    const lines = [
      '# HELP verinode_region_replication_lag_ms Region replication lag in milliseconds.',
      '# TYPE verinode_region_replication_lag_ms gauge',
      '# HELP verinode_region_p99_latency_ms Critical path p99 latency by region.',
      '# TYPE verinode_region_p99_latency_ms gauge',
      '# HELP verinode_region_heartbeat_age_ms Age of the last regional heartbeat.',
      '# TYPE verinode_region_heartbeat_age_ms gauge',
    ];

    for (const region of regions) {
      const label = `{region="${this.escapeLabel(region.name)}",role="${region.role}",health="${region.health}"}`;
      lines.push(`verinode_region_replication_lag_ms${label} ${region.replicationLagMs}`);
      lines.push(`verinode_region_p99_latency_ms${label} ${region.p99LatencyMs}`);
      lines.push(
        `verinode_region_heartbeat_age_ms${label} ${Math.max(0, this.now() - region.lastHeartbeatAt)}`,
      );
    }

    return `${lines.join('\n')}\n`;
  }

  private requireSinglePrimary(regions: RegionStatus[]): RegionStatus {
    const primaries = regions.filter((region) => region.role === 'primary');
    if (primaries.length !== 1) {
      throw new Error(`expected exactly one primary region, found ${primaries.length}`);
    }
    return primaries[0];
  }

  private findRegionRisks(region: RegionStatus): string[] {
    const reasons: string[] = [];
    if (region.health !== 'healthy') reasons.push(`primary health is ${region.health}`);
    if (region.replicationLagMs > this.policy.maxReplicationLagMs)
      reasons.push(
        `replication lag ${region.replicationLagMs}ms exceeds ${this.policy.maxReplicationLagMs}ms`,
      );
    if (region.p99LatencyMs > this.policy.maxCriticalPathP99Ms)
      reasons.push(
        `p99 latency ${region.p99LatencyMs}ms exceeds ${this.policy.maxCriticalPathP99Ms}ms`,
      );
    if (this.now() - region.lastHeartbeatAt > this.policy.heartbeatTimeoutMs)
      reasons.push('primary heartbeat timed out');
    return reasons;
  }

  private isPromotionCandidate(region: RegionStatus): boolean {
    return (
      region.health === 'healthy' &&
      region.replicationLagMs <= this.policy.maxReplicationLagMs &&
      region.p99LatencyMs <= this.policy.maxCriticalPathP99Ms &&
      this.now() - region.lastHeartbeatAt <= this.policy.heartbeatTimeoutMs
    );
  }

  private escapeLabel(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
}
