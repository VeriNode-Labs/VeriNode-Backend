# Implementation Plan

## Task Dependency Graph

```json
{
  "waves": [
    { "wave": 1, "tasks": [1] },
    { "wave": 2, "tasks": [2, 3] },
    { "wave": 3, "tasks": [4, 9] },
    { "wave": 4, "tasks": [5] },
    { "wave": 5, "tasks": [6, 7] },
    { "wave": 6, "tasks": [8, 10] },
    { "wave": 7, "tasks": [11] },
    { "wave": 8, "tasks": [12] },
    { "wave": 9, "tasks": [13] },
    { "wave": 10, "tasks": [14, 15, 16, 17] },
    { "wave": 11, "tasks": [18, 19] },
    { "wave": 12, "tasks": [20] }
  ]
}
```

- [ ] 1. Database migrations (008, 009, 010)
  - Create `src/database/migrations/008_config_audit_log.sql` with the `config_audit_log` table, CHECK constraints on `hmac_digest` and `change_source`, all four indexes, and the REVOKE comment for UPDATE/DELETE
  - Create `src/database/migrations/009_config_baselines.sql` with the `config_baselines` table, partial unique index `idx_cb_single_active` (WHERE status = 'active'), and `idx_cb_created_at`
  - Create `src/database/migrations/010_config_drift_alerts.sql` with the `config_drift_alerts` table, `retry_count` column, and `idx_cda_status` index
  - Verify all three migrations are additive (`CREATE TABLE IF NOT EXISTS`) so partial deploys are safe
  - **Requirements**: 3.8, 9.5
  - **Design ref**: Database Migrations section

- [ ] 2. Shared types and error classes (`src/audit/types.ts`)
  - Define `AuditPermission`, `ActorContext`, `ChangeSource`, `DriftSeverity`, and `CRITICAL_SECTIONS` constant
  - Define `AuditEntry`, `BaselineStatus`, `Baseline`, `DriftedKey`, `DriftReport`, `PartialAlertPayload`, `ChainVerificationResult`, `HealthStatus`, and `HealthCheckResult` interfaces
  - Define `BaselineSerializationError`, `BaselineDeserializationError`, `NotFoundError`, and `ForbiddenError` error classes with correct `name` and `code` properties
  - Define `AuditQueryFilters` and `AuditQueryResult` interfaces for `queryAuditLog`
  - Define `RollbackResult` interface with `restored` and `skipped` string arrays
  - **Requirements**: 1.3, 2.3, 5.7, 8.2, 10.5, 10.6
  - **Design ref**: `types.ts` — Shared interfaces and error classes section

- [ ] 3. OTel metrics instruments (`src/audit/metrics.ts`)
  - Import `metrics` from `@opentelemetry/api` and create meter `config_audit` at version `1.0.0`
  - Create `changesTotal` counter (`config_audit.changes_total`)
  - Create `driftDetectionsTotal` counter (`config_audit.drift_detections_total`)
  - Create `driftLatencyMs` histogram (`config_audit.drift_detection_latency_ms`) with explicit bucket boundaries `[10, 25, 50, 100, 250, 500]`
  - Create `queueDroppedTotal` counter (`config_audit.queue_dropped_total`)
  - Create `activeBaselineAgeSeconds` observable gauge (`config_audit.active_baseline_age_seconds`)
  - Create `healthCheckFailuresTotal` counter (`config_audit.health_check_failures_total`)
  - Export all six instruments as the `instruments` object
  - **Requirements**: 6.1, 6.2, 6.3, 6.5, 7.3, 7.6
  - **Design ref**: OpenTelemetry Instruments (`metrics.ts`) section

- [ ] 4. HMAC utility function and `AuditLogger` construction guard
  - Implement `computeHmac(entry, secret)` using `createHmac('sha256', secret)` over the pipe-delimited canonical payload string
  - Add construction-time validation in `AuditLogger`: read `VERINODE_AUDIT_HMAC_SECRET` from env, decode from base64, throw with a clear message if absent or decoded length < 32
  - Ensure the secret value never appears in any log line, span attribute, or response body
  - Export `computeHmac` as an internal utility for use by both `write` and `verifyIntegrity`
  - **Requirements**: 3.2, 9.3
  - **Design ref**: HMAC Secret Management section and `AuditLogger` — HMAC computation subsection

- [ ] 5. `BaselineManager` — serialization and deserialization
  - Implement `serializeBaseline(config)`: throw `BaselineSerializationError` for null/undefined/non-object input, recursively sort keys lexicographically at every depth, call `JSON.stringify` with no replacer and no indentation
  - Implement `deserializeBaseline(json)`: throw `BaselineDeserializationError` for non-string input or invalid JSON, return the plain parsed object with no post-processing
  - Write the constructor accepting `Pool`, `TokenValidator`, and `StructuredLogger`
  - **Requirements**: 1.7, 10.1, 10.2, 10.3, 10.5, 10.6
  - **Design ref**: `BaselineManager` section, `serializeBaseline` algorithm subsection

- [ ] 6. `BaselineManager` — capture, getActive, and expireOldBaselines
  - Implement `capture(config, actor)`: call `requirePermission(actor, 'config:baseline:write')` first, then `serializeBaseline`, compute SHA-256 hash, execute the atomic transaction (UPDATE superseded, INSERT active) using `pool.transaction()`, return the new `Baseline`; on DB failure leave previous active row unchanged and return a structured error
  - Implement `getActive()`: SELECT the single row WHERE status = 'active'; return null if none exists
  - Implement `expireOldBaselines()`: UPDATE rows WHERE status = 'superseded' AND created_at < NOW() - INTERVAL '90 days' SET status = 'expired'; return count of updated rows
  - On permission rejection write an `access_denied` audit entry via a lightweight inline INSERT (not via `AuditLogger` to avoid circular dependency)
  - **Requirements**: 1.1, 1.2, 1.3, 1.4, 1.6, 8.1, 8.3, 8.6
  - **Design ref**: `BaselineManager` section, `capture` transaction sequence subsection

- [ ] 7. `AuditLogger` — write with bounded queue and retry
  - Create the class with `private queue: AuditEntry[]` (max 1000), `dbAvailable: boolean`, and `lastSuccessfulWrite: Date | null`
  - Implement `write(entry)`: assign UUID v4 `entryId`, compute HMAC, attempt INSERT with 500ms deadline and 3-attempt exponential back-off (50/100/200ms); on success update `lastSuccessfulWrite` and drain queue; on all retries exhausted set `dbAvailable=false`, enqueue, and emit `error` on `ConfigEventBus`
  - If `dbAvailable` is false, enqueue directly; if queue is at 1000 entries evict oldest, increment `queueDroppedTotal`, log WARN
  - Implement background probe (every 30s): `SELECT 1`; on success set `dbAvailable=true` and drain queue in FIFO order
  - **Requirements**: 3.1, 3.3, 3.4, 3.5, 7.1, 7.3
  - **Design ref**: `AuditLogger` section, Write path subsection and Queue drain subsection

- [ ] 8. `AuditLogger` — verifyIntegrity, verifyChain, and queryAuditLog
  - Implement `verifyIntegrity(entryId)`: fetch row by `entry_id`, recompute HMAC with `computeHmac`, return `true`/`false`, throw `NotFoundError` if row not found
  - Implement `verifyChain(from, to)`: SELECT all entries in `[from, to]` ORDER BY `changed_at ASC`; recompute HMAC for each; build `ChainVerificationResult`; if `invalidCount > 0` emit `integrity_violation` on `ConfigEventBus` and dispatch a critical alert
  - Implement `queryAuditLog(filters)`: build dynamic WHERE clause for `configPath`, `actor`, `changeSource`, `fromTimestamp`, `toTimestamp`; clamp `pageSize` to `[1, 200]`; return results in descending `changed_at` order with total count
  - **Requirements**: 3.6, 3.7, 9.1, 9.2, 9.4
  - **Design ref**: `AuditLogger` section, interface definitions

- [ ] 9. `TokenValidator` extension — `ActorContext` and `requirePermission`
  - Add `ActorContext` import/re-export to `src/api/auth/token_validator.ts`
  - Add `requirePermission(actor: ActorContext, permission: AuditPermission): void` method that throws `ForbiddenError` if the actor's permissions array does not include the required permission
  - Ensure the method is pure (no DB or network I/O) so it can be the first call in `BaselineManager` and `ConfigAuditService` mutating operations
  - **Requirements**: 8.1, 8.2, 8.4, 8.6
  - **Design ref**: Access Control section

- [ ] 10. `AlertDispatcher`
  - Implement constructor accepting `IdempotentWebhookService`, `IdempotentEmailService`, `Pool`, `StructuredLogger`, and `AlertConfig` (webhook URLs, email addresses, email enabled flag)
  - Implement `dispatch(report)`: return immediately for non-critical-only reports; derive `alertId` as UUID v5 from `SHA-256(baselineId + ":" + floor(detectedAt/1000))`; redact values for key-path segments matching `/password|secret|key|token/i`; initiate non-awaited async worker calling `Promise.allSettled` over all webhook and email calls; if all channels reject persist a `failed` row to `config_drift_alerts`
  - Ensure the synchronous `dispatch()` call returns within the 100ms P99 budget by handing off async delivery immediately
  - **Requirements**: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
  - **Design ref**: `AlertDispatcher` section, `dispatch` flow subsection

- [ ] 11. `DriftDetector`
  - Implement `deepDiff(baseline, live)`: recursive traversal producing a flat list of dot-separated key paths that differ; compare array values with `JSON.stringify`; report absent-in-live as `liveValue: undefined` and absent-in-baseline as `baselineValue: undefined`
  - Implement `classify(path)` using `isCritical` from `types.ts` (`CRITICAL_SECTIONS`)
  - Implement `detect(liveConfig)`: start OTel span `config_audit.detect_drift` as child of active context; call `baselineManager.getActive()`; if null log WARN and return; compute diff; if empty record latency histogram and return; classify keys; build `DriftReport`; increment `driftDetectionsTotal`; record `driftLatencyMs`; if critical key found call `alertDispatcher.dispatch(report)`; end span
  - Wrap the entire detect body in `Promise.race([detectPromise, timeout(5000)])`; on timeout log ERROR, set span status ERROR
  - On unexpected diff error build `PartialAlertPayload` and pass to `alertDispatcher.dispatch`, do not re-throw
  - **Requirements**: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 6.2, 6.3, 6.4, 7.4
  - **Design ref**: `DriftDetector` section, `detect` algorithm and `deepDiff` subsections

- [ ] 12. `ConfigAuditService` — orchestrator, start/stop, captureBaseline, rollback, healthCheck
  - Implement `start()`: register `updated` listener on `ConfigEventBus` wrapped in try-catch; inside listener fire-and-forget `auditLogger.write(...)` and `void driftDetector.detect(configManager.get())`; update `activeBaselineAgeSeconds` gauge on each baseline read
  - Implement `stop()`: remove all registered listeners
  - Implement `captureBaseline(actor)`: delegate to `baselineManager.capture()`; on success emit `baseline_captured` on `ConfigEventBus`; on permission rejection emit `baseline_access_denied`
  - Implement `rollback(report, actor, dryRun?)`: check `config:rollback:write` permission first; if `dryRun` return keys without mutation; iterate drifted keys calling `configManager.update()`; write `rollback` or `rollback_skip` audit entries accordingly; emit `rollback_complete` on `ConfigEventBus`
  - Implement `healthCheck()`: probe DB with `SELECT 1`; evaluate queue depth and `lastSuccessfulWrite` to derive `healthy`/`degraded`/`unhealthy`; increment `healthCheckFailuresTotal` when degraded or unhealthy
  - **Requirements**: 1.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.5, 6.6, 7.2, 7.5, 7.6, 8.5
  - **Design ref**: `ConfigAuditService` section, `start()` and `rollback` algorithm subsections

- [ ] 13. Public module re-export (`src/audit/index.ts`)
  - Re-export `ConfigAuditService`, `BaselineManager`, `AuditLogger`, `DriftDetector`, `AlertDispatcher` from their respective modules
  - Re-export all public types and error classes from `types.ts`
  - Re-export `instruments` from `metrics.ts`
  - **Requirements**: 1.1, 2.1, 3.1, 4.1
  - **Design ref**: File & Directory Layout section

- [ ] 14. Unit tests — `BaselineManager` serialization and capture
  - Test `serializeBaseline` determinism: two deep-equal objects with different insertion-order keys produce identical JSON strings
  - Test `serializeBaseline` throws `BaselineSerializationError` for null, undefined, array, and primitive inputs
  - Test `deserializeBaseline` round-trip: `deserializeBaseline(serializeBaseline(obj))` is deep-equal to `obj` for nested configs conforming to `mainSchema`
  - Test `deserializeBaseline` throws `BaselineDeserializationError` for non-string input and malformed JSON
  - Test `capture` atomicity with a stubbed `Pool`: if INSERT throws the UPDATE is rolled back and `getActive` still returns the previous baseline
  - Test `capture` rejects with `ForbiddenError` when actor lacks `config:baseline:write`
  - **Requirements**: 1.1, 1.2, 1.3, 1.4, 8.1, 10.1, 10.2, 10.3, 10.5, 10.6
  - **Design ref**: Testing Strategy section, Unit layer

- [ ] 15. Unit tests — `AuditLogger` HMAC, retry, queue eviction, verifyChain
  - Test HMAC round-trip: an entry written and then fetched from a stub DB has `verifyIntegrity` return `true`; a mutated field causes `verifyIntegrity` to return `false`
  - Test retry back-off: stub Pool that fails twice then succeeds; assert three total attempts with ≥50ms/100ms/200ms delays using fake timers
  - Test queue eviction: fill queue to 1000 then call `write`; assert `queueDroppedTotal` incremented and oldest entry removed
  - Test queue drain: set `dbAvailable=false`, enqueue 3 entries, restore DB; trigger probe; assert all 3 inserted in FIFO order
  - Test `verifyChain` returns correct counts and emits `integrity_violation` when any digest mismatches
  - **Requirements**: 3.1, 3.2, 3.4, 7.1, 7.3, 9.1, 9.2, 9.4
  - **Design ref**: Testing Strategy section, Unit layer

- [ ] 16. Unit tests — `DriftDetector` (no baseline, critical/non-critical, 5s timeout)
  - Test no-baseline path: mock `BaselineManager.getActive()` returns null; assert WARN logged, `detect` resolves without error, `AlertDispatcher` not called
  - Test non-critical drift: mock baseline with one non-`db`/`mtls`/`tls`/`staking` key changed; assert `DriftReport` produced, `driftDetectionsTotal` incremented with `non_critical`, `AlertDispatcher` not called
  - Test critical drift: mock baseline with one `db.*` key changed; assert `AlertDispatcher.dispatch` called with the report
  - Test 5s timeout: mock `BaselineManager.getActive()` to hang; assert detect resolves (not rejects) after 5s, span set to ERROR, event loop not blocked
  - Test diff error recovery: mock `deepDiff` to throw; assert `PartialAlertPayload` passed to `AlertDispatcher`
  - **Requirements**: 2.1, 2.2, 2.4, 2.5, 2.6, 2.7, 7.4
  - **Design ref**: Testing Strategy section, Unit layer

- [ ] 17. Unit tests — `AlertDispatcher` (redaction, idempotency, async hand-off)
  - Test redaction: payload key paths containing `password`, `secret`, `key`, `token` (case-insensitive) have their values replaced with `"[REDACTED]"`; non-sensitive paths are not redacted
  - Test idempotency key derivation: two `DriftReport`s for the same baseline within the same second produce the same `alertId`; reports one second apart produce different `alertId`s
  - Test async hand-off: `dispatch()` returns synchronously even when mock webhook and email calls are delayed 2s; assert `dispatch` returns in < 50ms
  - Test persistence on total failure: mock both webhook and email to reject; assert `config_drift_alerts` INSERT called with `status='failed'`
  - Test non-critical bypass: report with only non-critical keys; assert no webhook, email, or DB calls
  - **Requirements**: 4.1, 4.2, 4.3, 4.4, 4.5, 4.7
  - **Design ref**: Testing Strategy section, Unit layer

- [ ] 18. Integration tests — full `ConfigAuditService` event flow
  - Spin up a real `Pool` against the test database with all three migrations applied
  - Call `ConfigAuditService.start()`, emit an `updated` event on `ConfigEventBus` with a full enriched payload, then await a short delay
  - Assert one row inserted in `config_audit_log` with correct fields and a valid HMAC digest
  - Assert `verifyIntegrity(entryId)` returns `true` for the inserted row
  - Capture a baseline, then emit an `updated` event where a `db.*` key changes; assert `config_drift_alerts` row inserted (mock alert channels to fail)
  - Assert `config_audit.changes_total` and `config_audit.drift_detections_total` incremented in the OTel meter
  - **Requirements**: 3.1, 3.2, 6.1, 6.2, 7.2
  - **Design ref**: Testing Strategy section, Integration layer

- [ ] 19. Integration tests — rollback and verifyChain
  - Set up a test DB with a baseline and two drifted keys; invoke `ConfigAuditService.rollback()` with a real `ConfigManager`
  - Assert `configManager.get()` returns the baseline values for both keys after rollback
  - Assert two `rollback` audit entries written and `rollback_complete` event emitted with correct restored/skipped lists
  - Directly UPDATE a `hmac_digest` value in the test DB to simulate tampering
  - Call `verifyChain(from, to)` covering the tampered row; assert `ChainVerificationResult.invalidCount === 1` and `integrity_violation` event emitted
  - Test rollback with `dryRun: true`; assert no `configManager.update()` calls and no audit entries written
  - **Requirements**: 5.1, 5.2, 5.3, 5.6, 5.7, 9.1, 9.2
  - **Design ref**: Testing Strategy section, Integration layer

- [ ] 20. Monitoring runbook and deployment canary config
  - Add `docs/audit-runbook.md` with the five signal/metric/action rows from the design (drift P99, queue dropped, health degraded, integrity violation, baseline age > 7 days)
  - Document `AUDIT_CANARY_MODE=true` flag behavior: alerts logged only, no webhooks or emails dispatched
  - Document the five canary gate thresholds (latency P99 ≤ 100ms, queue_dropped == 0, healthCheck healthy ≥ 99.9%, zero unhandled exceptions, zero integrity_violation events) and the 24-hour window
  - Document the blue-green rollback procedure and note that audit tables are append-only so no DB migration rollback is required
  - Document the `VERINODE_AUDIT_HMAC_SECRET` environment variable requirements (base64, min 32 bytes decoded) and startup failure behavior
  - **Requirements**: 6.3, 6.6, 7.1, 7.5
  - **Design ref**: Deployment Strategy section and Monitoring & Alerting Runbook Pointers section
