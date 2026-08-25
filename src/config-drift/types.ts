/**
 * Config-Drift — shared types
 *
 * Drift categories:
 *   value_change  — a key exists in both baseline and runtime but the value differs.
 *   key_added     — a key exists in runtime but NOT in baseline.
 *   key_removed   — a key exists in baseline but NOT in runtime.
 *   type_change   — a key exists in both but the typeof value changed (e.g. string → number).
 *
 * Severity:
 *   critical      — key path starts with a security prefix (TLS, auth, DB, mTLS …).
 *   warning       — key path starts with a performance prefix.
 *   info          — everything else.
 */

export type DriftCategory = 'value_change' | 'key_added' | 'key_removed' | 'type_change';

export type DriftSeverity = 'critical' | 'warning' | 'info';

export interface DriftFinding {
  category: DriftCategory;
  severity: DriftSeverity;
  key: string;
  baselineValue?: unknown;
  runtimeValue?: unknown;
  /** Set when category === 'type_change'. */
  baselineType?: string;
  runtimeType?: string;
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
    typeChanges: number;
    criticalCount: number;
    warningCount: number;
  };
}

export interface CriticalDriftPolicy {
  enabled: boolean;
  /**
   * Dot-prefix paths that classify a finding as CRITICAL.
   * Default: db, mtls, tls, auth, staking.
   */
  criticalKeyPrefixes: string[];
  /**
   * Dot-prefix paths that classify a finding as WARNING.
   * Default: capacity_shedding, performance, telemetry.
   */
  warningKeyPrefixes: string[];
}

export interface ConfigDriftAlert {
  alertId: string;
  snapshotId: string;
  policyMatchedPrefix?: string;
  severity: DriftSeverity;
  driftReport: DriftReport;
}

/**
 * A lightweight point-in-time config snapshot returned by GET /config/snapshot.
 */
export interface ConfigSnapshot {
  snapshotId: string;
  capturedAt: string; // ISO-8601
  config: Record<string, unknown>;
  flattenedHash: string;
}

/**
 * A persisted drift event row in config_drift_events.
 */
export interface DriftEvent {
  eventId: string;
  snapshotId: string;
  capturedAt: Date;
  severity: DriftSeverity;
  category: DriftCategory;
  key: string;
  baselineValue: unknown;
  runtimeValue: unknown;
  autoRemediated: boolean;
  remediationNote?: string;
}
