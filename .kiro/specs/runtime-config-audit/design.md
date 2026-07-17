# Technical Design Document
## Runtime Configuration Auditing and Drift Detection

## Overview

This document describes the technical design for the Runtime Configuration Auditing and Drift Detection subsystem in VeriNode-Backend. The feature adds tamper-evident audit logging, continuous drift detection against a known-good baseline, operator alerts, and rollback capabilities — all integrated non-invasively with the existing `ConfigManager`, `ConfigEventBus`, OpenTelemetry pipeline, and notification infrastructure.

---

## Architecture

#### Component Diagram

```
┌──────────────────────────────────────────────────────────────────────┐
│                        ConfigAuditService                            │
│  (orchestrator — wires together all components, registers on bus)    │
│                                                                      │
│  ┌─────────────────┐  ┌──────────────────┐  ┌───────────────────┐  │
│  │ BaselineManager │  │  DriftDetector   │  │   AuditLogger     │  │
│  │                 │  │                  │  │                   │  │
│  │ - capture()     │  │ - detect()       │  │ - write()         │  │
│  │ - getActive()   │  │ - classify()     │  │ - verifyIntegrity │  │
│  │ - serialize()   │  │                  │  │ - verifyChain()   │  │
│  │ - deserialize() │  └──────────────────┘  │ - queryLog()      │  │
│  └─────────────────┘                        └───────────────────┘  │
│                              ┌───────────────────────────────┐      │
│                              │       AlertDispatcher         │      │
│                              │ - dispatch()                  │      │
│                              │ - IdempotentWebhookService    │      │
│                              │ - IdempotentEmailService      │      │
│                              └───────────────────────────────┘      │
└──────────────────────────────────────────────────────────────────────┘
         │  subscribes to                        │  writes to
         ▼                                       ▼
  ConfigEventBus                         PostgreSQL (pg pool)
  (existing)                             config_baselines
                                         config_audit_log
                                         config_drift_alerts
```


#### Event Flow

```
ConfigManager.update() / reload()
        │
        ▼
ConfigEventBus.emit('updated', { configPath, previousValue,
                                  newValue, actor, sourceIp,
                                  changeSource })
        │
        ├──► AuditLogger.write(entry)          [async, bounded queue]
        │         │
        │         └──► INSERT config_audit_log (HMAC-SHA-256)
        │
        └──► DriftDetector.detect(newConfig)   [independent Promise, 5s timeout]
                  │
                  ├── BaselineManager.getActive()  → config_baselines
                  ├── diff(live, baseline)
                  ├── classify(keys)
                  │
                  ├── [no baseline] → log WARN, return
                  └── [drift found]
                            ├── emit OTel metrics
                            └── [critical keys] → AlertDispatcher.dispatch(report)
                                      ├── IdempotentWebhookService (async)
                                      ├── IdempotentEmailService   (async)
                                      └── [all fail] → INSERT config_drift_alerts
```

---

### File & Directory Layout

```
src/audit/
  index.ts                  ← re-exports public surface
  config_audit_service.ts   ← ConfigAuditService (orchestrator)
  baseline_manager.ts       ← BaselineManager
  drift_detector.ts         ← DriftDetector
  audit_logger.ts           ← AuditLogger
  alert_dispatcher.ts       ← AlertDispatcher
  types.ts                  ← shared interfaces & error classes
  metrics.ts                ← OTel meter / instrument initialisation

src/database/migrations/
  008_config_audit_log.sql
  009_config_baselines.sql
  010_config_drift_alerts.sql

tests/audit/
  baseline_manager.test.ts
  drift_detector.test.ts
  audit_logger.test.ts
  alert_dispatcher.test.ts
  config_audit_service.test.ts
  integrity.test.ts
```


---

## Data Models

#### `types.ts` — Shared interfaces and error classes

```typescript
// ── Permissions ──────────────────────────────────────────────────────────────
export type AuditPermission = 'config:read' | 'config:baseline:write' | 'config:rollback:write';

export interface ActorContext {
  actorId: string;       // token subject or 'system' / 'remote'
  permissions: AuditPermission[];
  sourceIp: string | null;
}

// ── Change source ────────────────────────────────────────────────────────────
export type ChangeSource =
  | 'file' | 'env' | 'remote_etcd' | 'remote_consul'
  | 'hot_update' | 'rollback' | 'rollback_skip' | 'access_denied';

// ── Severity ─────────────────────────────────────────────────────────────────
export type DriftSeverity = 'critical' | 'non_critical';

export const CRITICAL_SECTIONS = new Set(['db', 'mtls', 'tls', 'staking']);

// ── Audit Entry ──────────────────────────────────────────────────────────────
export interface AuditEntry {
  entryId: string;           // UUID v4
  configPath: string;        // dot-separated key path
  previousValue: unknown;
  newValue: unknown;
  actor: string;
  sourceIp: string | null;
  changedAt: Date;
  changeSource: ChangeSource;
  hmacDigest: string;        // 64-char lowercase hex
}

// ── Baseline ─────────────────────────────────────────────────────────────────
export type BaselineStatus = 'active' | 'superseded' | 'expired';

export interface Baseline {
  id: string;                // UUID v4
  snapshotJson: string;      // deterministically serialized config
  sha256Hash: string;        // hex SHA-256 of snapshotJson
  actor: string;
  createdAt: Date;
  status: BaselineStatus;
}

// ── Drift ─────────────────────────────────────────────────────────────────────
export interface DriftedKey {
  path: string;
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

// ── Health ───────────────────────────────────────────────────────────────────
export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export interface HealthCheckResult {
  status: HealthStatus;
  details: Record<string, string>;
}

// ── Errors ───────────────────────────────────────────────────────────────────
export class BaselineSerializationError extends Error {
  constructor(message: string) { super(message); this.name = 'BaselineSerializationError'; }
}
export class BaselineDeserializationError extends Error {
  constructor(message: string) { super(message); this.name = 'BaselineDeserializationError'; }
}
export class NotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'NotFoundError'; }
}
export class ForbiddenError extends Error {
  readonly code = 'forbidden';
  constructor(readonly detail: string) { super(detail); this.name = 'ForbiddenError'; }
}
```


---

### Database Migrations

#### `008_config_audit_log.sql`

```sql
CREATE TABLE IF NOT EXISTS config_audit_log (
  entry_id      UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  config_path   TEXT        NOT NULL,
  previous_value JSONB,
  new_value     JSONB,
  actor         TEXT        NOT NULL,
  source_ip     INET,
  changed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  change_source TEXT        NOT NULL CHECK (change_source IN (
    'file','env','remote_etcd','remote_consul',
    'hot_update','rollback','rollback_skip','access_denied'
  )),
  hmac_digest   TEXT        NOT NULL CHECK (hmac_digest ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_cal_config_path  ON config_audit_log(config_path);
CREATE INDEX IF NOT EXISTS idx_cal_actor        ON config_audit_log(actor);
CREATE INDEX IF NOT EXISTS idx_cal_changed_at   ON config_audit_log(changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_cal_change_source ON config_audit_log(change_source);

-- Application role must NOT have UPDATE or DELETE on this table.
-- REVOKE UPDATE, DELETE ON config_audit_log FROM verinode_app;
```

#### `009_config_baselines.sql`

```sql
CREATE TABLE IF NOT EXISTS config_baselines (
  id            UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  snapshot_json TEXT        NOT NULL,
  sha256_hash   TEXT        NOT NULL,
  actor         TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status        TEXT        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active','superseded','expired')),
  UNIQUE (status, id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_cb_single_active
  ON config_baselines (status)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_cb_created_at ON config_baselines(created_at DESC);
```

#### `010_config_drift_alerts.sql`

```sql
CREATE TABLE IF NOT EXISTS config_drift_alerts (
  alert_id        UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  baseline_id     UUID        NOT NULL,
  detected_at     TIMESTAMPTZ NOT NULL,
  severity        TEXT        NOT NULL CHECK (severity IN ('critical','non_critical')),
  drifted_keys    JSONB       NOT NULL,
  status          TEXT        NOT NULL DEFAULT 'failed'
                    CHECK (status IN ('failed','retrying','delivered')),
  retry_count     INTEGER     NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cda_status ON config_drift_alerts(status);
```


---

## Components and Interfaces

#### `BaselineManager`

```typescript
class BaselineManager {
  constructor(
    private readonly pool: Pool,
    private readonly tokenValidator: TokenValidator,
    private readonly logger: StructuredLogger,
  ) {}

  // Serialize config with lexicographically sorted keys (deterministic)
  serializeBaseline(config: object): string
  deserializeBaseline(json: unknown): object

  // Capture and atomically persist a new active baseline
  async capture(config: object, actor: ActorContext): Promise<Baseline>

  // Read the current active baseline (returns null if none)
  async getActive(): Promise<Baseline | null>

  // Expire superseded rows older than 90 days (called by a periodic job)
  async expireOldBaselines(): Promise<number>
}
```

**`serializeBaseline` algorithm:**
1. Recursively sort all object keys lexicographically at every nesting depth.
2. Call `JSON.stringify(sorted)` — no custom replacer, no indentation.
3. Throw `BaselineSerializationError` if input is null/undefined/non-object.

**`capture` transaction sequence:**
```sql
BEGIN;
  UPDATE config_baselines SET status = 'superseded'
    WHERE status = 'active';
  INSERT INTO config_baselines
    (snapshot_json, sha256_hash, actor, status)
    VALUES ($1, $2, $3, 'active')
    RETURNING id;
COMMIT;
```
The partial-failure guarantee falls out of the single transaction: if the INSERT fails, the UPDATE rolls back and the previous active row is unchanged.

---

#### `AuditLogger`

```typescript
class AuditLogger {
  private readonly queue: AuditEntry[] = [];   // bounded FIFO, max 1000
  private dbAvailable = true;
  private lastSuccessfulWrite: Date | null = null;

  constructor(
    private readonly pool: Pool,
    private readonly hmacSecret: Buffer,   // from VERINODE_AUDIT_HMAC_SECRET
    private readonly meter: Meter,
    private readonly logger: StructuredLogger,
  ) {}

  async write(entry: Omit<AuditEntry, 'entryId' | 'hmacDigest'>): Promise<void>
  async verifyIntegrity(entryId: string): Promise<boolean>
  async verifyChain(from: Date, to: Date): Promise<ChainVerificationResult>
  async queryAuditLog(filters: AuditQueryFilters): Promise<AuditQueryResult>
}
```

**HMAC computation:**
```typescript
function computeHmac(entry: AuditEntry, secret: Buffer): string {
  const payload = [
    entry.entryId,
    entry.configPath,
    JSON.stringify(entry.previousValue ?? null),
    JSON.stringify(entry.newValue ?? null),
    entry.actor,
    entry.sourceIp ?? '',
    entry.changedAt.toISOString(),
    entry.changeSource,
  ].join('|');
  return createHmac('sha256', secret).update(payload).digest('hex');
}
```

**Write path (with bounded queue fallback):**
```
write(entry):
  1. Assign entry_id (UUID v4), compute HMAC digest
  2. If dbAvailable:
       try INSERT with 500ms deadline + 3-attempt back-off (50/100/200ms)
       on success: update lastSuccessfulWrite, drain queue
       on failure: set dbAvailable=false, enqueue(entry)
  3. If !dbAvailable:
       if queue.length === 1000: evict oldest, increment queue_dropped_total
       queue.push(entry)
```

**Queue drain (background probe every 30s):**
```
probe():
  try SELECT 1  → if ok: dbAvailable=true
  while queue.length > 0 && dbAvailable:
    dequeue oldest entry → INSERT
```


---

#### `DriftDetector`

```typescript
class DriftDetector {
  constructor(
    private readonly baselineManager: BaselineManager,
    private readonly alertDispatcher: AlertDispatcher,
    private readonly meter: Meter,
    private readonly tracer: Tracer,
    private readonly logger: StructuredLogger,
  ) {}

  // Called by ConfigAuditService on every 'updated' event
  async detect(liveConfig: object): Promise<void>
}
```

**`detect` algorithm (wrapped in 5s Promise.race timeout):**
```
1. Start OTel span 'config_audit.detect_drift'  (child of active context)
2. Record t0 = performance.now()
3. baseline = await baselineManager.getActive()
   → if null: log WARN, end span, return
4. diff = deepDiff(baseline.snapshot, liveConfig)
   → if empty: record latency histogram, end span, return
5. classify each differing key → DriftReport
6. record histogram(performance.now() - t0)
7. increment drift_detections_total{severity}
8. if any critical key:
     alertDispatcher.dispatch(report)   ← synchronous initiation
9. end span
```

**`deepDiff` — produces flat list of dot-separated key paths that differ:**
- Uses recursive traversal; array values are compared with `JSON.stringify` for equality.
- A key present in baseline but absent in live is reported with `liveValue: undefined`.
- A key absent in baseline but present in live is reported with `baselineValue: undefined`.

**Critical key classification:**
```typescript
function isCritical(path: string): boolean {
  const section = path.split('.')[0];
  return CRITICAL_SECTIONS.has(section);   // db | mtls | tls | staking
}
```

---

#### `AlertDispatcher`

```typescript
class AlertDispatcher {
  constructor(
    private readonly webhookService: IdempotentWebhookService,
    private readonly emailService: IdempotentEmailService,
    private readonly pool: Pool,
    private readonly logger: StructuredLogger,
    private readonly config: AlertConfig,  // webhook URLs, email addresses, email enabled flag
  ) {}

  // Synchronously initiates dispatch; hands off persistence/retry to async worker
  dispatch(report: DriftReport | PartialAlertPayload): void
}
```

**`dispatch` flow:**
```
1. If report is PartialAlertPayload or has only non-critical keys → return immediately
2. Build alertId = UUIDv5(SHA-256(baselineId + ':' + floor(detectedAt/1000)))
3. Build payload:
     - redact values where path segment matches /password|secret|key|token/i
4. Initiate (non-awaited) async worker:
     results = await Promise.allSettled([
       webhookService.postWebhook(...)  ← for each URL
       emailService.sendEmail(...)      ← if email enabled
     ])
     if all rejected: INSERT config_drift_alerts (status='failed')
5. Return immediately (synchronous boundary met)
```

---

#### `ConfigAuditService`

```typescript
class ConfigAuditService {
  constructor(
    private readonly eventBus: ConfigEventBus,
    private readonly configManager: ConfigManager,
    private readonly auditLogger: AuditLogger,
    private readonly baselineManager: BaselineManager,
    private readonly driftDetector: DriftDetector,
    private readonly alertDispatcher: AlertDispatcher,
    private readonly meter: Meter,
    private readonly logger: StructuredLogger,
  ) {}

  // Wires all listeners — call once at startup
  start(): void

  // Operator actions
  async captureBaseline(actor: ActorContext): Promise<Baseline>
  async rollback(report: DriftReport, actor: ActorContext, dryRun?: boolean): Promise<RollbackResult>

  // Observability
  async healthCheck(): Promise<HealthCheckResult>

  // Cleanup
  stop(): void
}
```

**`start()` registers on `ConfigEventBus`:**
```typescript
eventBus.on('updated', (payload) => {
  try {
    const { configPath, previousValue, newValue, actor,
            sourceIp, changeSource } = payload.data;
    // fire-and-forget, both wrapped in catch
    auditLogger.write({ configPath, previousValue, newValue,
                        actor, sourceIp, changedAt: new Date(),
                        changeSource });
    // independent Promise with 5s timeout (see DriftDetector)
    void driftDetector.detect(configManager.get());
  } catch (err) {
    logger.error('ConfigAuditService: unhandled error in updated listener', err);
  }
});
```

**`rollback` algorithm:**
```
1. Check actor has config:rollback:write → throw ForbiddenError if not
2. If dryRun: return { wouldChange: driftedKeys } — no mutations
3. For each key in report.driftedKeys (in order):
     try:
       configManager.update(key.path, key.baselineValue)
       auditLogger.write({ changeSource: 'rollback', ... })
       restored.push(key.path)
     catch:
       auditLogger.write({ changeSource: 'rollback_skip', reason: err.message })
       logger.warn(...)
       skipped.push(key.path)
4. eventBus.emitEvent('rollback_complete', { baselineId, restored, skipped })
5. return { restored, skipped }
```


---

### OpenTelemetry Instruments (`metrics.ts`)

```typescript
import { metrics } from '@opentelemetry/api';

const meter = metrics.getMeter('config_audit', '1.0.0');

export const instruments = {
  changesTotal: meter.createCounter('config_audit.changes_total', {
    description: 'Total config audit log entries persisted',
  }),
  driftDetectionsTotal: meter.createCounter('config_audit.drift_detections_total', {
    description: 'Total drift reports produced',
  }),
  driftLatencyMs: meter.createHistogram('config_audit.drift_detection_latency_ms', {
    description: 'Drift detection latency in ms',
    unit: 'ms',
    advice: { explicitBucketBoundaries: [10, 25, 50, 100, 250, 500] },
  }),
  queueDroppedTotal: meter.createCounter('config_audit.queue_dropped_total', {
    description: 'Audit entries dropped due to queue saturation',
  }),
  activeBaselineAgeSeconds: meter.createObservableGauge(
    'config_audit.active_baseline_age_seconds',
    { description: 'Age of the active baseline in seconds; -1 if none exists' },
  ),
  healthCheckFailuresTotal: meter.createCounter('config_audit.health_check_failures_total', {
    description: 'Health check failures by component',
  }),
};
```

---

### Access Control

The existing `token_validator.ts` is an Express middleware. For the audit subsystem (which is not an HTTP layer), we extract a lightweight `TokenValidator` class:

```typescript
// src/api/auth/token_validator.ts  (addition — not a replacement)
export interface TokenValidator {
  validate(token: string | undefined): ActorContext;
  // throws ForbiddenError if token is absent or permissions insufficient
  requirePermission(actor: ActorContext, permission: AuditPermission): void;
}
```

`BaselineManager` and `ConfigAuditService` accept `TokenValidator` via constructor injection, keeping them independently testable without an HTTP context.

---

### HMAC Secret Management

- Environment variable: `VERINODE_AUDIT_HMAC_SECRET` — base64-encoded, minimum 32 bytes decoded.
- Read once at `AuditLogger` construction: `Buffer.from(process.env.VERINODE_AUDIT_HMAC_SECRET!, 'base64')`.
- Never logged, never included in span attributes, never returned in API responses.
- Local startup check: if the variable is absent or decoded length < 32, throw at construction time with a clear error message.

---

### `ConfigEventBus` Extension

The existing `ConfigEventBus` only knows the events `loaded | updated | reload_initiated | reload_complete | error`. The audit subsystem adds new event names. Rather than modifying `ConfigEventBus`, we extend its `ConfigEvent` union in `types.ts` and call `eventBus.emitEvent()` with the new names — the EventEmitter base class supports arbitrary event names transparently.

New events emitted by `ConfigAuditService`:
- `baseline_captured` — `{ baselineId, actor }`
- `baseline_access_denied` — `{ actor, sourceIp }`
- `rollback_complete` — `{ baselineId, restored: string[], skipped: string[] }`
- `integrity_violation` — `ChainVerificationResult`

---

### Performance Budget

| Path | Budget | Mechanism |
|------|--------|-----------|
| `updated` → audit log write | ≤ 500ms | 500ms write deadline + retry queue |
| `updated` → DriftReport produced | ≤ 100ms P99 | Histogram SLO; 5s hard timeout |
| `dispatch()` return | ≤ 100ms P99 | Synchronous initiation only; async delivery |
| `healthCheck()` | < 50ms | Single `SELECT 1` probe, cached queue depth |

The `DriftDetector.detect()` runs inside `Promise.race([detectPromise, timeout(5000)])`. If it exceeds 5 seconds the rejection is caught, logged at ERROR, and the span is marked ERROR. The `ConfigEventBus` event loop is never blocked.


---

### Deployment Strategy

#### Blue-Green with Canary Analysis

```
Phase 1 — Blue (current):   ConfigManager with no audit hooks
Phase 2 — Green (new):      ConfigAuditService.start() called at boot,
                             but AlertDispatcher configured with
                             AUDIT_CANARY_MODE=true (logs alerts only,
                             no webhooks/emails dispatched)

Canary gates (24h window):
  - drift_detection_latency_ms P99 ≤ 100ms  (OTel histogram)
  - config_audit.queue_dropped_total == 0
  - healthCheck() returns 'healthy' for ≥ 99.9% of checks
  - Zero unhandled exceptions in audit listeners
  - Zero integrity_violation events

On gate pass:   set AUDIT_CANARY_MODE=false (full alerting live)
On gate fail:   roll back green → blue (no DB migration rollback needed;
                audit tables are append-only, safe to ignore)
```

#### Migration Safety

All three migrations are additive (`CREATE TABLE IF NOT EXISTS`). The application does not fail if the tables already exist from a previous partial deploy. No existing tables are modified.

---

### Monitoring & Alerting Runbook Pointers

| Signal | OTel Metric | Action |
|--------|-------------|--------|
| Drift P99 > 100ms | `config_audit.drift_detection_latency_ms` p99 | Check DB latency, queue depth |
| Queue dropped | `config_audit.queue_dropped_total` > 0 | DB connectivity issue; check pool health |
| Health degraded | `config_audit.health_check_failures_total` | Check `component` attribute |
| Integrity violation | `integrity_violation` event | Immediate security incident |
| Baseline age > 7 days | `config_audit.active_baseline_age_seconds` > 604800 | Remind operator to re-baseline |

---

### Security Considerations

1. **Immutable audit log**: application role has INSERT-only grants on `config_audit_log`. No `UPDATE`/`DELETE` granted. Enforced in migration `008`.
2. **HMAC secret**: `VERINODE_AUDIT_HMAC_SECRET` never appears in logs, spans, or API responses. Startup check throws on missing/short secret.
3. **Secret redaction in alerts**: `AlertDispatcher` redacts values for any key path segment matching `password|secret|key|token` (case-insensitive) before dispatching.
4. **Permission enforcement before state read**: `BaselineManager` validates tokens before reading any config data. `ConfigAuditService` validates before any `ConfigManager.update()` call.
5. **Access-denial audit trail**: every rejected baseline/rollback attempt writes an `access_denied` `Audit Entry`, ensuring non-repudiation even for failed attempts.
6. **No SSRF risk**: `AlertDispatcher` uses pre-configured webhook URLs from application config, not user-supplied URLs at runtime.

---

## Error Handling

| Failure | Behavior |
|---------|----------|
| DB unavailable on audit write | Enqueue in bounded FIFO (max 1000); drain when DB recovers (30s probe) |
| DB write retry exhausted (3x) | Emit `error` on `ConfigEventBus`; log ERROR; entry in queue |
| Queue at capacity | Evict oldest (FIFO); increment `queue_dropped_total`; log WARN |
| `DriftDetector` exceeds 5s | Promise rejected; log ERROR; span marked ERROR; event loop unblocked |
| HMAC secret missing/short | Throw at `AuditLogger` construction — fail-fast before any write |
| `BaselineManager.getActive()` throws | `DriftDetector` catches; logs ERROR; skips drift check |
| `ConfigManager.update()` throws during rollback | Skip key; write `rollback_skip` entry; log WARN; continue |
| All alert channels fail | Persist to `config_drift_alerts` (status=`failed`) for background retry |
| Token absent or invalid | Return HTTP 403 + `ForbiddenError`; write `access_denied` audit entry |
| `deserializeBaseline` non-JSON | Throw `BaselineDeserializationError` with parse error message |
| `serializeBaseline` non-object | Throw `BaselineSerializationError` with input type |

---

## Correctness Properties

### Property 1: Single active baseline
The partial-unique index `idx_cb_single_active` on `config_baselines(status) WHERE status = 'active'` enforces at-most-one active row at the database level, independent of application logic.

**Validates: Requirements 1.2**

### Property 2: HMAC round-trip
For any well-formed entry written by `AuditLogger`, `verifyIntegrity(entryId)` must return `true`. Enforced by using the same `computeHmac` function for both write and verify paths.

**Validates: Requirements 9.4**

### Property 3: Deterministic serialization
`serializeBaseline` uses lexicographic key sort at every nesting level. Two deep-equal config objects always produce the same JSON string and therefore the same SHA-256 hash, making baseline comparison reproducible.

**Validates: Requirements 10.1, 10.3**

### Property 4: Idempotent alerts
`alertId` is a UUID v5 derived from `SHA-256(baselineId + ":" + floor(detectedAt/1000))`. Duplicate `DriftReport`s for the same baseline within a 1-second window produce the same `alertId`, and `IdempotentWebhookService` / `IdempotentEmailService` deduplicate by `notificationId`.

**Validates: Requirements 4.3**

### Property 5: Fault isolation
All `ConfigEventBus` listeners registered by `ConfigAuditService` are wrapped in try-catch. An unhandled exception in the audit subsystem cannot propagate to `ConfigManager` or crash the process.

**Validates: Requirements 7.2**

### Property 6: No state mutation before auth
`BaselineManager` and `ConfigAuditService` invoke `TokenValidator.requirePermission()` as the first call in any mutating operation, before reading or writing any config or audit data.

**Validates: Requirements 8.1, 8.6**

---

## Testing Strategy

| Layer | What | Tool |
|-------|------|------|
| Unit | `serializeBaseline` determinism, `computeHmac` round-trip, `deepDiff`, `classifyKey` | `ts-node` (existing pattern) |
| Unit | `AuditLogger.write` retry back-off, queue eviction | Stub `Pool`, fake timers |
| Unit | `DriftDetector.detect` with/without baseline, critical/non-critical paths | Mock `BaselineManager` |
| Unit | `AlertDispatcher` idempotency key derivation, redaction, async hand-off | Mock services |
| Integration | Full `ConfigAuditService.start()` → emit `updated` → audit written → drift detected | Real `Pool` (test DB) |
| Integration | `verifyChain` detects tampered row | Direct DB mutation in test |
| Integration | Rollback updates `ConfigManager` values | Full stack with real `ConfigManager` |
