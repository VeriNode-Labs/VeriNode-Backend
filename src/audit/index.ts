/**
 * VeriNode Backend — Runtime Config Audit: Public Surface
 *
 * Re-exports all public classes, types, and instruments for consumers.
 */

// ── Core components ───────────────────────────────────────────────────────────
export { ConfigAuditService } from './config_audit_service';
export { BaselineManager } from './baseline_manager';
export { AuditLogger } from './audit_logger';
export { DriftDetector, deepDiff, classify } from './drift_detector';
export { AlertDispatcher } from './alert_dispatcher';

// ── Types and error classes ───────────────────────────────────────────────────
export type {
  AuditPermission,
  ActorContext,
  ChangeSource,
  DriftSeverity,
  AuditEntry,
  AuditEntryInput,
  BaselineStatus,
  Baseline,
  DriftedKey,
  DriftReport,
  PartialAlertPayload,
  ChainVerificationResult,
  HealthStatus,
  HealthCheckResult,
  AuditQueryFilters,
  AuditQueryResult,
  RollbackResult,
  AlertConfig,
} from './types';

export {
  CRITICAL_SECTIONS,
  BaselineSerializationError,
  BaselineDeserializationError,
  NotFoundError,
  ForbiddenError,
} from './types';

// ── OTel instruments ──────────────────────────────────────────────────────────
export { instruments } from './metrics';

// ── HMAC utility ──────────────────────────────────────────────────────────────
export { computeHmac, loadHmacSecret } from './hmac';
