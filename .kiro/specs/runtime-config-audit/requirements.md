# Requirements Document

## Introduction

This feature adds Runtime Configuration Auditing and Drift Detection to VeriNode-Backend. The system captures a tamper-evident baseline snapshot of the runtime configuration across all services, continuously monitors for unauthorized or unexpected drift from that baseline, records every change in an immutable audit log (who, what, when, from where), and alerts operators with sub-100ms P99 detection latency on critical paths. It integrates non-invasively with the existing `ConfigManager`, `ConfigEventBus`, OpenTelemetry pipeline, and notification infrastructure (webhook/email). Audit records are persisted in a new PostgreSQL migration table. The subsystem must not become a single point of failure and must achieve 99.99% availability.

## Glossary

- **AuditLogger**: The component responsible for recording all configuration change events to the tamper-evident PostgreSQL audit log table.
- **BaselineManager**: The component that captures, stores, and controls access to the known-good configuration baseline snapshot.
- **ConfigAuditService**: The top-level orchestrator that wires together the `AuditLogger`, `BaselineManager`, `DriftDetector`, and `AlertDispatcher`.
- **DriftDetector**: The component that computes the diff between the live runtime configuration and the stored baseline and classifies changes by severity.
- **AlertDispatcher**: The component that routes drift alerts to operators through the existing webhook and email notification channels.
- **Baseline**: A cryptographically-hashed, point-in-time snapshot of the full runtime configuration, promoted to "known-good" by an authorized operator.
- **Drift**: Any deviation between the live runtime configuration and the currently active Baseline that has not been explicitly approved.
- **Audit Entry**: A single immutable record in the audit log containing: change identifier, config path, previous value, new value, actor identity, source IP, timestamp, change source (file/env/remote/hot-update/rollback), and an HMAC integrity digest.
- **Critical Path**: Configuration keys listed under `db`, `mtls`, `tls`, and `staking` sections, where changes carry the highest operational risk.
- **Actor**: The identity associated with a configuration change — derived from the API token (authenticated requests), "system" for SIGHUP/file-watch reloads, or "remote" for etcd/consul pushes.
- **Rollback**: The act of reconciling the live runtime configuration back to the active Baseline values.
- **HMAC Digest**: An HMAC-SHA-256 message authentication code computed over the serialized `Audit Entry` fields using a server-side secret key, providing tamper evidence.
- **Reconciliation**: The process of applying Rollback to restore one or more config keys to their Baseline values.
- **ConfigManager**: The existing singleton in `src/config/manager.ts` managing config load, watch, reload, and hot-update.
- **ConfigEventBus**: The existing event emitter in `src/config/eventbus.ts` emitting `loaded`, `updated`, `reload_initiated`, `reload_complete`, and `error` events.
- **OpenTelemetry**: The existing distributed tracing and metrics pipeline initialized in `src/diagnostics/tracer.ts`.

---

## Requirements

### Requirement 1: Baseline Snapshot Capture

**User Story:** As an operator, I want to capture the current runtime configuration as a known-good baseline, so that future changes can be compared against it to detect unauthorized drift.

#### Acceptance Criteria

1. WHEN an authorized operator calls the capture-baseline operation, THE `BaselineManager` SHALL serialize the full runtime configuration using `serializeBaseline()` (lexicographically sorted keys at every nesting level), compute an SHA-256 hash of the resulting JSON string, and return to the caller a success response carrying the new baseline ID.
2. WHEN the serialized snapshot and its SHA-256 hash are ready, THE `BaselineManager` SHALL persist both to the `config_baselines` PostgreSQL table within a single atomic transaction that simultaneously sets the actor identity, timestamp, and status `active` for the new row and status `superseded` for any previously `active` row; the transaction SHALL be all-or-nothing so that exactly one `active` row exists at all times.
3. IF the database write for a new baseline fails, THEN THE `BaselineManager` SHALL leave the previously active baseline unchanged, make no state mutation, and return a structured error object with a machine-readable `code` field and a human-readable `reason` field to the caller.
4. IF the actor triggering baseline capture does not hold the `config:baseline:write` permission, THEN THE `BaselineManager` SHALL reject the request without reading or modifying any configuration state.
5. WHEN a baseline is persisted to the `config_baselines` table, THE `ConfigAuditService` SHALL emit a `baseline_captured` event on the `ConfigEventBus` carrying the new baseline ID and the actor identity.
6. WHEN a baseline row's `created_at` timestamp is more than 90 days in the past and its status is `superseded`, THE `BaselineManager` SHALL transition that row's status to `expired`; rows with status `active` SHALL NOT be expired regardless of age.
7. THE `BaselineManager` SHALL use the `serializeBaseline(config)` method defined in Requirement 10 as the sole serialization path for all baseline snapshot writes, ensuring SHA-256 hashes are reproducible across calls for logically identical configurations.

---

### Requirement 2: Continuous Drift Detection

**User Story:** As an operator, I want the system to continuously detect when the live runtime configuration diverges from the active baseline, so that unauthorized or accidental changes are surfaced immediately.

#### Acceptance Criteria

1. WHEN the `ConfigEventBus` emits an `updated` event, THE `DriftDetector` SHALL compute the diff between the updated live configuration and the active Baseline within 100 milliseconds (P99) of the event emission.
2. THE `DriftDetector` SHALL classify each differing key as `critical` if the key's full dot-separated path begins with one of the top-level sections `db`, `mtls`, `tls`, or `staking` (at any nesting depth under those sections), and as `non-critical` for all other keys.
3. WHEN drift is detected, THE `DriftDetector` SHALL produce a `DriftReport` containing: baseline ID, detection timestamp (ISO-8601), an array of drifted keys where each entry carries the full dot-separated key path, the previous value from the baseline, the current live value, and the severity classification (`critical` or `non-critical`) for that key.
4. IF no active baseline exists when the `updated` event fires, THEN THE `DriftDetector` SHALL log a single `WARN`-level structured log entry via the existing `StructuredLogger` and return without performing a diff or throwing an unhandled exception; IF `BaselineManager` throws a runtime exception during the active-baseline lookup, THE `DriftDetector` SHALL catch it, log it at `ERROR` level, and return without re-throwing.
5. THE `DriftDetector` SHALL be stateless with respect to persistence — it reads the active baseline from `BaselineManager` on every check and does not maintain local state between checks.
6. WHEN drift is detected on at least one `critical` key, THE `DriftDetector` SHALL synchronously pass the completed `DriftReport` to the `AlertDispatcher` before returning.
7. IF production of the `DriftReport` itself fails (e.g., an unexpected error during diff computation), THEN THE `DriftDetector` SHALL catch the error, construct a partial alert object carrying at minimum `{ severity: 'critical', partialReport: true, error: <message> }`, pass it synchronously to the `AlertDispatcher`, and then return; THE `DriftDetector` SHALL NOT re-throw the error and SHALL NOT allow the `AlertDispatcher` call to propagate exceptions back to the `ConfigEventBus` event loop.

---

### Requirement 3: Tamper-Evident Audit Logging

**User Story:** As a compliance officer, I want every configuration change to be recorded in an immutable, tamper-evident audit log, so that I can prove the chain of custody for any configuration value.

#### Acceptance Criteria

1. WHEN the `ConfigEventBus` emits an `updated` event carrying the enriched payload `{ configPath, previousValue, newValue, actor, sourceIp, changeSource }`, THE `AuditLogger` SHALL begin persisting the corresponding `Audit Entry` to `config_audit_log` within a 500ms write deadline; IF the write is not committed within 500ms, THE `AuditLogger` SHALL treat it as a failure and apply the retry policy defined in Criterion 4.
2. THE `AuditLogger` SHALL compute an HMAC-SHA-256 digest over the pipe-delimited concatenation of the canonically stringified fields `entry_id|config_path|previous_value|new_value|actor|source_ip|changed_at|change_source` using the secret from `VERINODE_AUDIT_HMAC_SECRET`, and store the lowercase hex digest in the `hmac_digest` column.
3. THE `AuditLogger` SHALL record all fields in an `Audit Entry`: `entry_id` (UUID v4), `config_path` (dot-separated key path), `previous_value` (JSONB), `new_value` (JSONB), `actor` (non-empty string), `source_ip` (a valid IPv4 or IPv6 address string, or `null` for system-initiated changes with no network origin), `changed_at` (timestamp with time zone), `change_source` (one of: `file`, `env`, `remote_etcd`, `remote_consul`, `hot_update`, `rollback`, `rollback_skip`, `access_denied`), `hmac_digest` (64-character lowercase hex string).
4. IF the database write for an audit entry fails, THEN THE `AuditLogger` SHALL retry the write up to 3 times with exponential back-off starting at 50ms (delays: 50ms, 100ms, 200ms) before emitting an `error` event on the `ConfigEventBus` and logging an `ERROR`-level structured log entry; all 3 retry attempts SHALL be exhausted before the `error` event is emitted.
5. THE `AuditLogger` SHALL never execute `UPDATE` or `DELETE` SQL against `config_audit_log`; the application database role MUST NOT be granted `UPDATE` or `DELETE` privileges on that table.
6. WHEN a caller invokes `verifyIntegrity(entryId)`, THE `AuditLogger` SHALL fetch the row with the matching `entry_id`, recompute the HMAC over the stored fields, and return `true` if the computed digest matches `hmac_digest`, `false` if the digest does not match, and throw a `NotFoundError` if no row with that `entry_id` exists.
7. THE `AuditLogger` SHALL support paginated retrieval of audit entries via `queryAuditLog({ configPath?, actor?, changeSource?, fromTimestamp?, toTimestamp?, page, pageSize })` where `pageSize` is clamped to the range [1, 200], results are returned in descending `changed_at` order, and the response includes the total count of matching entries.
8. THE `config_audit_log` table SHALL be created by database migration `008_config_audit_log.sql` following the existing migration naming convention in `src/database/migrations/`.

---

### Requirement 4: Drift Alert Notifications

**User Story:** As an on-call engineer, I want to receive an alert when critical configuration drift is detected, so that I can investigate and remediate before it causes an incident.

#### Acceptance Criteria

1. WHEN the `AlertDispatcher` receives a `DriftReport` containing at least one `critical`-severity key, THE `AlertDispatcher` SHALL initiate dispatch (defined as: all outbound notification calls submitted to their respective services before the `AlertDispatcher` method returns) to all configured webhook URLs and email addresses within 100 milliseconds (P99) of receiving the report.
2. WHEN the `AlertDispatcher` receives a `DriftReport` containing only `non-critical`-severity keys and no `critical` keys, THE `AlertDispatcher` SHALL NOT dispatch an alert notification and SHALL return without side effects.
3. WHEN constructing an alert, THE `AlertDispatcher` SHALL derive the idempotency key as `SHA-256(baseline_id + ":" + floor(detectionTimestamp / 1000))` and set `alertId` to a UUID v5 derived from that idempotency key; THE `AlertDispatcher` SHALL use this key with the existing `IdempotentWebhookService` and `EmailService` to ensure at-least-once delivery with deduplication.
4. WHEN constructing the alert payload, THE `AlertDispatcher` SHALL set `severity` to `critical` if at least one key in `driftedKeys` is classified as `critical`, and `non_critical` otherwise; the payload SHALL include: `alertId`, `severity`, `driftedKeys` (array of dot-separated key paths), `baselineId`, `detectedAt` (ISO-8601), `currentValues` where the value for any key whose path segment matches `password`, `secret`, `key`, or `token` (case-insensitive) is replaced with the string `"[REDACTED]"`.
5. IF all configured notification channels fail after 3 attempts per channel, THEN THE `AlertDispatcher` SHALL persist the alert to the `config_drift_alerts` table with status `failed`; IF at least one channel succeeds, THE `AlertDispatcher` SHALL NOT write a `failed` record for that alert.
6. WHERE email alerting is enabled in the application configuration, THE `AlertDispatcher` SHALL send email alerts with subject `[VeriNode] Critical Config Drift Detected` and a body containing: `alertId`, `baselineId`, `detectedAt`, total count of drifted keys, and the full list of drifted key paths.
7. THE `AlertDispatcher` SHALL initiate the synchronous dispatch attempt, then immediately hand off persistence and retry logic to an asynchronous worker, ensuring the `AlertDispatcher` method returns without blocking on channel delivery outcomes beyond the 100ms P99 budget.

---

### Requirement 5: Rollback and Reconciliation

**User Story:** As an operator, I want to roll back the live configuration to the active baseline on drift detection, so that unauthorized changes are automatically or manually reversed.

#### Acceptance Criteria

1. WHEN an authorized operator invokes the rollback operation with a `DriftReport`, THE `ConfigAuditService` SHALL call `ConfigManager.update()` for each drifted key with the baseline value, iterating in the order the keys appear in the `DriftReport`.
2. WHEN `ConfigManager.update()` succeeds for a key during rollback, THE `AuditLogger` SHALL record one `Audit Entry` for that key with `change_source` set to `rollback` and `actor` set to the identity of the operator who triggered the rollback; dry-run invocations SHALL NOT produce any `Audit Entry` records.
3. IF `ConfigManager.update()` throws any error (validation or runtime) during rollback for a specific key, THEN THE `ConfigAuditService` SHALL skip that key, record one `Audit Entry` for that key with `change_source` set to `rollback_skip` and a `reason` field describing the error, log the failure at `WARN` level, and continue reconciling the remaining keys.
4. THE `ConfigAuditService` SHALL require that the actor triggering rollback holds the `config:rollback:write` permission.
5. IF the actor triggering rollback does not hold the `config:rollback:write` permission, THEN THE `ConfigAuditService` SHALL reject the operation immediately, make no calls to `ConfigManager.update()`, and return a structured error to the caller.
6. WHEN a rollback completes (whether fully or partially), THE `ConfigAuditService` SHALL emit a `rollback_complete` event on the `ConfigEventBus` carrying the baseline ID, the list of successfully restored keys, and the list of skipped keys.
7. THE `ConfigAuditService` SHALL expose a `dryRun` option on the rollback operation that returns the list of keys that would be changed and their baseline values without calling `ConfigManager.update()` or writing any `Audit Entry` records.

---

### Requirement 6: OpenTelemetry Metrics and Tracing Integration

**User Story:** As an SRE, I want the audit and drift detection subsystem to emit structured metrics and traces, so that I can monitor its health and performance within the existing observability pipeline.

#### Acceptance Criteria

1. WHEN an `Audit Entry` is successfully persisted, THE `ConfigAuditService` SHALL increment the OpenTelemetry counter `config_audit.changes_total` with attributes `change_source` (matching the `change_source` field of the entry) and `config_section` (the first dot-separated segment of `config_path`, e.g., `db`, `mtls`).
2. WHEN a `DriftReport` is produced, THE `ConfigAuditService` SHALL increment the OpenTelemetry counter `config_audit.drift_detections_total` with attribute `severity` set to `critical` if the report contains at least one critical key, otherwise `non_critical`.
3. THE `ConfigAuditService` SHALL record the elapsed time from `updated` event emission to `DriftReport` completion in the OpenTelemetry histogram `config_audit.drift_detection_latency_ms`; the histogram SHALL be configured with explicit bucket boundaries that include 10, 25, 50, 100, 250, and 500 milliseconds to enable P99 ≤ 100ms SLO measurement.
4. THE `ConfigAuditService` SHALL create an OpenTelemetry span named `config_audit.detect_drift` for each drift detection run using the existing tracer from `src/diagnostics/tracer.ts`; WHEN an active trace context is present on the current async context, the span SHALL be created as a child of that context.
5. THE `ConfigAuditService` SHALL update the OpenTelemetry up/down gauge `config_audit.active_baseline_age_seconds` to reflect `(now - baseline.created_at) / 1000` on every successful `BaselineManager` read; IF no active baseline exists, the gauge SHALL be set to `-1`.
6. IF the `ConfigAuditService` encounters a database error during audit log persistence, THE `ConfigAuditService` SHALL call `span.setStatus({ code: SpanStatusCode.ERROR, message: error.message })` and record the exception as a span event via `span.recordException(error)`, compatible with the existing `ErrorLoggingSpanProcessor`.

---

### Requirement 7: High Availability and Fault Isolation

**User Story:** As a platform engineer, I want the audit subsystem to remain operational even when the database or notification channels are unavailable, so that it does not become a single point of failure for the application.

#### Acceptance Criteria

1. IF the PostgreSQL connection is unavailable when an `Audit Entry` write is attempted, THEN THE `AuditLogger` SHALL enqueue the entry in an in-memory bounded FIFO queue (maximum 1000 entries); WHEN the connection is restored (detected by a background probe polling every 30 seconds), THE `AuditLogger` SHALL replay the queue entries in FIFO order.
2. THE `ConfigAuditService` SHALL wrap all listener callbacks registered on `ConfigEventBus` in try-catch blocks so that any unhandled exception thrown by the audit subsystem is caught, logged at `ERROR` level, and does not propagate to `ConfigManager` or crash the host process.
3. WHILE the `AuditLogger` in-memory queue depth equals 1000 (capacity), THE `AuditLogger` SHALL evict the oldest entry (FIFO), increment the OpenTelemetry counter `config_audit.queue_dropped_total`, and log a `WARN`-level structured entry before enqueuing the new entry.
4. THE `DriftDetector` SHALL execute each drift check inside an independent `Promise` that is rejected (not thrown synchronously) if the check takes longer than 5 seconds; the rejection SHALL be caught and logged at `ERROR` level without blocking the `ConfigEventBus` event loop tick.
5. THE `ConfigAuditService` SHALL expose a `healthCheck()` method returning `{ status: 'healthy' | 'degraded' | 'unhealthy', details: Record<string, string> }`; status SHALL be `healthy` when queue depth is 0 and the database is reachable; `degraded` when queue depth is between 1 and 999 inclusive OR the database was unreachable on the last probe but at least one successful write was made within the past 60 seconds; `unhealthy` when queue depth equals 1000 OR no successful write has been made in the past 60 seconds.
6. IF the `ConfigAuditService` `healthCheck()` method returns status `degraded` or `unhealthy`, THEN THE `ConfigAuditService` SHALL increment the OpenTelemetry counter `config_audit.health_check_failures_total` with attribute `component` set to `database` (when the database probe failed), `queue` (when queue depth is at capacity), or `notification` (when all notification channels are unreachable).

---

### Requirement 8: Access Control on Baseline and Rollback Operations

**User Story:** As a security engineer, I want baseline promotion and rollback to require explicit authorization, so that the audit trail cannot be silently overwritten by unauthorized actors.

#### Acceptance Criteria

1. THE `BaselineManager` SHALL invoke `token_validator.ts` to validate the actor's permission token as the first step of baseline capture, promotion, and retrieval operations, before reading or mutating any configuration state.
2. IF a token validation check fails or the token is absent for a baseline capture or promotion request, THEN THE `BaselineManager` SHALL return HTTP 403 with a structured error body `{ "error": "forbidden", "detail": "<permission> permission required" }` and log a `warn`-level entry with the actor identity and source IP; the response body `detail` field SHALL name the missing permission explicitly.
3. WHEN a baseline or rollback operation is rejected due to insufficient permissions, THE `BaselineManager` SHALL record one `Audit Entry` in `config_audit_log` with `change_source` set to `access_denied`, `actor` set to the identity extracted from the token (or `anonymous` if the token is absent), `source_ip` set to the request origin IP, and `new_value` set to `null`.
4. THE `BaselineManager` SHALL enforce at minimum two named permission levels: `config:read` (permits read operations on audit log and baselines, and running drift checks) and `config:baseline:write` (permits capturing or promoting baselines and triggering rollbacks); `config:read` SHALL NOT grant write or rollback access.
5. WHEN any baseline capture, promotion, or rollback operation is rejected due to insufficient permissions, THE `ConfigAuditService` SHALL emit a `baseline_access_denied` event on the `ConfigEventBus` carrying the actor identity and the source IP.
6. THE `BaselineManager` SHALL validate the actor's token and check permissions before reading any configuration state, ensuring that no configuration data is returned or mutated prior to a successful permission check.

---

### Requirement 9: Audit Log Integrity Verification

**User Story:** As a compliance auditor, I want to verify that the audit log has not been tampered with, so that I can trust the chain-of-custody evidence in a security review.

#### Acceptance Criteria

1. THE `AuditLogger` SHALL implement a `verifyChain(fromTimestamp: Date, toTimestamp: Date)` method that fetches all `config_audit_log` entries with `changed_at` in the inclusive range `[fromTimestamp, toTimestamp]` in ascending `changed_at` order, recomputes the HMAC for each entry, and returns a `ChainVerificationResult` object with fields: `totalChecked` (number), `validCount` (number), `invalidCount` (number), and `invalidEntryIds` (array of UUID strings for entries whose digest did not match).
2. WHEN `verifyChain` completes and `invalidCount` is greater than zero, THE `AuditLogger` SHALL emit an `integrity_violation` event on the `ConfigEventBus` carrying the `ChainVerificationResult`, and pass a critical alert to the `AlertDispatcher`.
3. THE `AuditLogger` SHALL read the HMAC secret exclusively from the environment variable `VERINODE_AUDIT_HMAC_SECRET` (minimum 32 bytes when decoded from base64); THE `AuditLogger` MUST NOT include the secret value or any derivative of it in any log entry, trace attribute, span event, or API response body.
4. WHEN an `Audit Entry` is written to `config_audit_log` and then read back, `verifyIntegrity(entryId)` SHALL return `true` for that entry; this round-trip integrity property SHALL hold for every well-formed entry written by the `AuditLogger`.
5. THE `config_audit_log` table SHALL define a PostgreSQL `CHECK` constraint on the `hmac_digest` column enforcing the pattern `hmac_digest ~ '^[0-9a-f]{64}$'`, so that any row with a malformed digest is rejected at the database level before being persisted.

---

### Requirement 10: Parser and Serializer Round-Trip for Baseline Snapshots

**User Story:** As a developer, I want baseline snapshots to serialize and deserialize without loss, so that the drift comparison is always performed against an exact replica of the original configuration.

#### Acceptance Criteria

1. THE `BaselineManager` SHALL implement a `serializeBaseline(config: object)` method that recursively sorts all object keys lexicographically at every nesting level before calling `JSON.stringify`, so that two plain objects that are deep-equal always produce the identical JSON string.
2. THE `BaselineManager` SHALL implement a `deserializeBaseline(json: string)` method that deserializes a stored JSON string back into a plain JavaScript object using `JSON.parse` without any post-processing transformation.
3. WHEN `serializeBaseline(config)` is called followed by `deserializeBaseline(result)` on any valid runtime configuration object conforming to `mainSchema`, THE result SHALL be deep-equal to the original `config` object; this round-trip property SHALL hold for all configuration shapes defined by `mainSchema`.
4. THE `serializeBaseline` and `deserializeBaseline` methods SHALL be the sole serialization interface used by all other components (`BaselineManager`, `DriftDetector`, integrity verification) for baseline snapshot I/O.
5. IF `deserializeBaseline` is called with a value that is not a string, or with a string that is not valid JSON, THEN THE `BaselineManager` SHALL throw a `BaselineDeserializationError` whose `message` property identifies the type of failure (non-string input or JSON parse error including the underlying parse error message); THE method SHALL NOT return a partially constructed object or swallow the error.
6. IF `serializeBaseline` is called with a value that is `null`, `undefined`, or not a plain object, THEN THE `BaselineManager` SHALL throw a `BaselineSerializationError` with a `message` property that identifies the invalid input type.
