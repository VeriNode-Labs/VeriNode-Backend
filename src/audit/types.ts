/**
 * VeriNode Backend — Runtime Config Audit: Shared Types
 *
 * All interfaces, enums, and error classes shared across the audit subsystem.
 */

// ── Permissions ───────────────────────────────────────────────────────────────

export type AuditPermission =
  | 'config:read'
  | 'config:baseline:write'
  | 'config:rollback:write';

export interface ActorContext {
  /** Token subject, or 'system' for SIGHUP/file-watch, or 'remote' for etcd/consul. */
  actorId: string;
  permissions: AuditPermission[];
  /** IPv4/IPv6 address of the request origin, or null for system-initiated changes. */
  sourceIp: string | null;
}

// ── Change source ─────────────────────────────────────────────────────────────

export type ChangeSource =
  | 'file'
  | 'env'
  | 'remote_etcd'
  | 'remote_consul'
  | 'hot_update'
  | 'rollback'
  | 'rollback_skip'
  | 'access_denied';

// ── Severity ──────────────────────────────────────────────────────────────────

export type DriftSeverity = 'critical' | 'non_critical';

/** Top-level config sections whose keys are classified as critical drift. */
export const CRITICAL_SECTIONS = new Set<string>(['db', 'mtls', 'tls', 'staking']);

// ── Audit Entry ───────────────────────────────────────────────────────────────

export interface AuditEntry {
  entryId: string;             // UUID v4
  configPath: string;          // dot-separated key path, e.g. 'db.host'
  previousValue: unknown;
  newValue: unknown;
  actor: string;
  sourceIp: string | null;     // IPv4/IPv6 string or null
  changedAt: Date;
  changeSource: ChangeSource;
  hmacDigest: string;          // 64-char lowercase hex SHA-256 HMAC
}

/** Partial audit entry before HMAC is computed (input to AuditLogger.write). */
export type AuditEntryInput = Omit<AuditEntry, 'entryId' | 'hmacDigest'>;

// ── Baseline ──────────────────────────────────────────────────────────────────

export type BaselineStatus = 'active' | 'superseded' | 'expired';

export interface Baseline {
  id: string;
  snapshotJson: string;   // deterministically serialized (lexicographic keys)
  sha256Hash: string;     // hex SHA-256 of snapshotJson
  actor: string;
  createdAt: Date;
  status: BaselineStatus;
}

// ── Drift ─────────────────────────────────────────────────────────────────────

export interface DriftedKey {
  path: string;              // full dot-separated key path
  baselineValue: unknown;
  liveValue: unknown;
  severity: DriftSeverity;
}

export interface DriftReport {
  baselineId: string;
  detectedAt: Date;
  driftedKeys: DriftedKey[];
}

export interface PartialAlertPayload {
  severity: 'critical';
  partialReport: true;
  error: string;
}

// ── Chain verification ────────────────────────────────────────────────────────

export interface ChainVerificationResult {
  totalChecked: number;
  validCount: number;
  invalidCount: number;
  invalidEntryIds: string[];
}

// ── Health ────────────────────────────────────────────────────────────────────

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthCheckResult {
  status: HealthStatus;
  details: Record<string, string>;
}

// ── Query / pagination ────────────────────────────────────────────────────────

export interface AuditQueryFilters {
  configPath?: string;
  actor?: string;
  changeSource?: ChangeSource;
  fromTimestamp?: Date;
  toTimestamp?: Date;
  page: number;     // 1-based
  pageSize: number; // clamped to [1, 200]
}

export interface AuditQueryResult {
  entries: AuditEntry[];
  totalCount: number;
  page: number;
  pageSize: number;
}

// ── Rollback ──────────────────────────────────────────────────────────────────

export interface RollbackResult {
  baselineId: string;
  restored: string[];  // key paths successfully rolled back
  skipped: string[];   // key paths that failed and were skipped
  dryRun: boolean;
}

// ── Alert config ──────────────────────────────────────────────────────────────

export interface AlertConfig {
  webhookUrls: string[];
  emailAddresses: string[];
  emailEnabled: boolean;
  /** When true, alerts are logged only — no webhooks or emails dispatched (canary mode). */
  canaryMode?: boolean;
}

// ── Error classes ─────────────────────────────────────────────────────────────

export class BaselineSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineSerializationError';
  }
}

export class BaselineDeserializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BaselineDeserializationError';
  }
}

export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotFoundError';
  }
}

export class ForbiddenError extends Error {
  readonly code = 'forbidden' as const;
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'ForbiddenError';
  }
}
