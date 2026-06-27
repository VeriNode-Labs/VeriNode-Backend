export type DriftCategory =
  | 'value_change'
  | 'key_added'
  | 'key_removed';

export interface DriftFinding {
  category: DriftCategory;
  key: string;
  baselineValue?: unknown;
  runtimeValue?: unknown;
}

export interface DriftReport {
  snapshotId: string;
  startedAt: number;
  endedAt: number;
  runtimeHash: string;
  baselineHash: string;
  findings: DriftFinding[];
  summary: {
    total: number;
    valueChanges: number;
    keyAdded: number;
    keyRemoved: number;
  };
}

export interface CriticalDriftPolicy {
  enabled: boolean;
  /**
   * If any finding touches one of these dot-prefix paths, the drift is treated as
   * deployment-scoped critical.
   */
  criticalKeyPrefixes: string[];
}

export interface ConfigDriftAlert {
  alertId: string;
  snapshotId: string;
  policyMatchedPrefix?: string;
  severity: 'critical' | 'warning';
  driftReport: DriftReport;
}

