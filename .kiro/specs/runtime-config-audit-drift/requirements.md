# Requirements Document

## Introduction

VeriNode Backend operates a multi-service architecture (blockchain, staking, mTLS, attestation, reputation, rewards, queue, and gateway services) that depends on runtime configuration loaded from files, environment variables, and remote sources (etcd/consul). Currently, configuration changes take effect through hot-reload and SIGHUP signals, but there is no record of *what* changed, *when*, *who* triggered the change, or whether the live configuration has *drifted* from the known-good baseline stored at deployment time.

This feature introduces a **Runtime Configuration Auditing and Drift Detection** subsystem. It will:
- Record a tamper-evident, append-only audit log for every configuration change.
- Snapshot the baseline configuration at deploy time and after each approved change.
- Continuously compare the live configuration against the current baseline and emit a drift event whenever a discrepancy is detected.
- Expose audit and drift state through an internal API and an OpenTelemetry-compatible metrics/alerts surface.
- Integrate with the existing `ConfigManager` / `configEventBus` without breaking existing behaviour.

The subsystem must meet the system-wide performance target (< 100 ms P99 on critical paths), the 99.99% availability target, and all changes must pass security review before taking effect.

---

## Glossary

- **Audit_Logger**: The component responsible for recording configuration change events to the append-only audit log.
- **Baseline_Store**: The persistent store that holds the most-recently approved configuration snapshot used as the reference for drift detection.
- **Config_Diff_Engine**: The component that computes a structured diff between two configuration objects and classifies each changed field as added, removed, or modified.
- **Drift_Detector**: The component that periodically (or on change) compares the live configuration to the baseline and raises a `DriftEvent` when divergence is detected.
- **Drift_Event**: A structured record describing which configuration paths diverged, the expected value, the observed value, and the severity classification.
- **Audit_Entry**: An immutable, timestamped record of a single configuration change including who triggered it, the source, the diff, and an HMAC integrity tag.
- **ConfigManager**: The existing centralized configuration manager (`src/config/manager.ts`) that loads, merges, validates, and hot-reloads configuration.
- **configEventBus**: The existing event bus (`src/config/eventbus.ts`) that fires `loaded`, `updated`, `reload_initiated`, `reload_complete`, and `error` events.
- **Security_Reviewer**: The automated or manual process that approves a configuration change before it is accepted into the Baseline_Store.
- **Audit_API**: The internal HTTP/REST endpoint that exposes audit log entries and drift status to operators and monitoring systems.
- **Critical_Path**: Any synchronous code executed in the hot-reload or live-request path where latency directly affects P99 response time.
- **HMAC_Tag**: A keyed HMAC-SHA256 tag appended to each Audit_Entry to detect tampering.
- **Severity_Level**: A classification (`info`, `warning`, `critical`) assigned to a Drift_Event based on the sensitivity of the drifted fields.
- **Baseline_Version**: A monotonically increasing integer that identifies each accepted baseline snapshot.
- **Service_Identity**: The identifier of the VeriNode service instance that emitted a configuration change, composed of `service.name` + `host.name`.

---

## Requirements

### Requirement 1: Audit Log Recording

**User Story:** As an operator, I want every configuration change to be recorded in an immutable audit log so that I can review the history of changes during incident investigation.

#### Acceptance Criteria

1. WHEN the `configEventBus` emits an `updated` event, THE Audit_Logger SHALL append an Audit_Entry to the audit log within 50 ms of the event timestamp.
2. THE Audit_Logger SHALL include in each Audit_Entry: the Baseline_Version at time of change, a UTC ISO-8601 timestamp, the Service_Identity, the configuration source name (e.g., `file:/path`, `environment`, `remote:etcd`), the structured diff produced by the Config_Diff_Engine, and an HMAC_Tag computed over the entry content.
3. THE Audit_Logger SHALL write Audit_Entries to an append-only log file and SHALL NOT overwrite or delete existing entries.
4. WHEN the audit log file does not exist at startup, THE Audit_Logger SHALL create it before the first write.
5. IF the audit log file cannot be written due to an I/O error, THEN THE Audit_Logger SHALL emit an `audit_write_error` event on the `configEventBus` and SHALL continue serving configuration changes without blocking the ConfigManager.
6. THE Audit_Logger SHALL compute the HMAC_Tag using HMAC-SHA256 with a key sourced from the `VERINODE_AUDIT_HMAC_KEY` environment variable, which SHALL be at least 32 bytes when base64-decoded.
7. IF `VERINODE_AUDIT_HMAC_KEY` is absent or shorter than 32 bytes when decoded, THEN THE Audit_Logger SHALL refuse to start and SHALL throw a descriptive initialization error.
8. THE Audit_Logger SHALL serialize each Audit_Entry as a single-line JSON object followed by a newline character (NDJSON format).

---

### Requirement 2: Configuration Diff Computation

**User Story:** As an operator, I want each audit entry to contain an exact, human-readable description of what changed so that I can understand the impact of a configuration change at a glance.

#### Acceptance Criteria

1. WHEN two configuration objects are provided, THE Config_Diff_Engine SHALL produce a diff that lists every path where a field was added, removed, or modified.
2. THE Config_Diff_Engine SHALL represent each diff item as an object containing: the dot-separated `path`, the `operation` (`added` | `removed` | `modified`), the `from` value (previous), and the `to` value (current); `from` SHALL be `null` for `added` items and `to` SHALL be `null` for `removed` items.
3. THE Config_Diff_Engine SHALL redact the `from` and `to` values of fields whose paths match any entry in the configured `audit.redactedPaths` list, replacing the value with the string `"[REDACTED]"`.
4. THE Config_Diff_Engine SHALL by default include `db.password`, `mtls.certFile`, `tls.certPath`, `tls.keyPath`, and all paths matching the pattern `*.token` and `*.password` in the redacted set.
5. WHEN the two configuration objects are identical, THE Config_Diff_Engine SHALL return an empty diff array.
6. FOR ALL pairs of valid configuration objects A and B: diffing A→B and then diffing B→A SHALL produce diffs where every `operation` is reversed and `from`/`to` values are swapped (inverse diff property).

---

### Requirement 3: Baseline Snapshot Management

**User Story:** As a deployment engineer, I want the system to record a baseline configuration at deployment time so that subsequent changes can be compared against a known-good reference.

#### Acceptance Criteria

1. WHEN the ConfigManager completes its initial `initialize()` call successfully, THE Baseline_Store SHALL save the loaded configuration as Baseline_Version 1 if no prior baseline exists.
2. WHEN a new configuration passes Security_Reviewer approval, THE Baseline_Store SHALL atomically replace the current baseline with the new configuration and increment the Baseline_Version by 1.
3. THE Baseline_Store SHALL persist the current baseline to a file at the path specified by `VERINODE_BASELINE_PATH` environment variable, defaulting to `./data/config-baseline.json`.
4. THE Baseline_Store SHALL store baselines as a JSON object containing `version` (integer), `timestamp` (UTC ISO-8601), `serviceIdentity` (string), and `config` (the full configuration object).
5. IF the baseline file cannot be read at startup due to corruption, THEN THE Baseline_Store SHALL log a warning and re-initialize by saving the current loaded configuration as the new baseline.
6. THE Baseline_Store SHALL expose a `getCurrent()` method that returns the current baseline snapshot synchronously within 5 ms.

---

### Requirement 4: Drift Detection

**User Story:** As a site reliability engineer, I want the system to automatically detect when the live configuration has drifted from the approved baseline so that I can investigate and remediate unauthorized changes.

#### Acceptance Criteria

1. WHEN the ConfigManager emits an `updated` event, THE Drift_Detector SHALL compare the new live configuration against the current baseline and emit a `DriftEvent` if any differences are found.
2. THE Drift_Detector SHALL perform periodic drift checks at the interval specified by `audit.driftCheckIntervalMs`, defaulting to 60000 ms (60 seconds).
3. WHEN drift is detected, THE Drift_Detector SHALL classify each drifted field with a Severity_Level: fields listed in `audit.criticalPaths` SHALL be `critical`; fields listed in `audit.warningPaths` SHALL be `warning`; all other drifted fields SHALL be `info`.
4. THE Drift_Detector SHALL default `audit.criticalPaths` to include `db.host`, `db.port`, `db.user`, `mtls.enabled`, `mtls.trustDomain`, `tls.acme.enabled`, and `app.environment`.
5. WHEN a drift check finds no differences between the live configuration and the baseline, THE Drift_Detector SHALL NOT emit a DriftEvent.
6. THE Drift_Detector SHALL expose a `getLastDriftStatus()` method that returns the most recent drift check result synchronously within 5 ms.
7. WHILE a drift check is in progress, THE Drift_Detector SHALL complete the check within 100 ms regardless of configuration object size.
8. IF the Baseline_Store has no baseline available, THEN THE Drift_Detector SHALL skip drift detection and emit an `audit_no_baseline` event on `configEventBus`.

---

### Requirement 5: Security Review Gate

**User Story:** As a security engineer, I want every configuration change that affects security-sensitive fields to pass an automated security review before it is promoted to the baseline, so that unauthorized changes cannot silently become the new reference.

#### Acceptance Criteria

1. WHEN a configuration change contains a diff item affecting a field in `audit.securitySensitivePaths`, THE Security_Reviewer SHALL evaluate the change against registered security rules before promoting the baseline.
2. THE Security_Reviewer SHALL default `audit.securitySensitivePaths` to include `mtls.enabled`, `mtls.trustDomain`, `mtls.allowedSpiffeIds`, `tls.acme.enabled`, `app.environment`, and all paths matching `*.password` and `*.token`.
3. WHEN all security rules pass for a given diff, THE Security_Reviewer SHALL return a `ReviewResult` with `approved: true` and promote the new configuration to the Baseline_Store.
4. WHEN any security rule fails, THE Security_Reviewer SHALL return a `ReviewResult` with `approved: false`, a list of `violations` (each with a `rule` name, `path`, and `reason`), and SHALL NOT promote the baseline.
5. THE Security_Reviewer SHALL include a built-in rule that rejects any change that sets `mtls.enabled` to `false` when the current `app.environment` is `production`.
6. THE Security_Reviewer SHALL include a built-in rule that rejects any change that sets `app.environment` from `production` to any other value.
7. THE Security_Reviewer SHALL allow external rules to be registered via a `registerRule(rule: SecurityRule)` method.
8. WHEN no security-sensitive paths are present in the diff, THE Security_Reviewer SHALL automatically approve and promote the baseline without running security rules.

---

### Requirement 6: Audit API

**User Story:** As an operator, I want a queryable API endpoint for audit history and current drift status so that I can integrate VeriNode with external SIEM and observability tooling.

#### Acceptance Criteria

1. THE Audit_API SHALL expose a `GET /internal/audit/entries` endpoint that returns a JSON array of Audit_Entry objects from the audit log.
2. WHEN a `limit` query parameter is provided, THE Audit_API SHALL return at most `limit` entries from the newest end of the log; the default limit SHALL be 100 and the maximum SHALL be 1000.
3. WHEN a `since` query parameter (UTC ISO-8601 timestamp) is provided, THE Audit_API SHALL return only entries with a timestamp strictly after the given value.
4. THE Audit_API SHALL expose a `GET /internal/audit/drift` endpoint that returns the current drift status as a JSON object containing `hasDrift` (boolean), `baselineVersion` (integer), `lastChecked` (UTC ISO-8601), and `driftItems` (array of Drift_Event items).
5. THE Audit_API SHALL expose a `GET /internal/audit/baseline` endpoint that returns the current baseline snapshot without secret field values (i.e., redacted per the `audit.redactedPaths` list).
6. WHEN an Audit_API request is received, THE Audit_API SHALL respond within 100 ms at P99 under normal operating conditions.
7. THE Audit_API SHALL require a valid `X-Internal-Token` header matching `VERINODE_INTERNAL_API_TOKEN`; IF the header is absent or invalid, THEN THE Audit_API SHALL return HTTP 401.
8. THE Audit_API SHALL include a `X-Baseline-Version` response header on all successful responses.

---

### Requirement 7: Observability Integration

**User Story:** As an SRE, I want drift events and audit activity to be emitted as OpenTelemetry metrics and structured log events so that I can build dashboards and alerts without polling the API.

#### Acceptance Criteria

1. WHEN a DriftEvent is emitted, THE Drift_Detector SHALL increment the OpenTelemetry counter `verinode.config.drift.detected` with attributes `service.name`, `severity` (info/warning/critical), and `drifted_path_count` (number of drifted fields).
2. WHEN an Audit_Entry is written, THE Audit_Logger SHALL increment the OpenTelemetry counter `verinode.config.audit.entries_written` with attribute `source` (the configuration source name).
3. WHEN the Security_Reviewer rejects a change, THE Security_Reviewer SHALL increment the OpenTelemetry counter `verinode.config.security_review.rejected` with attribute `rule` (the failing rule name).
4. THE Drift_Detector SHALL record a gauge metric `verinode.config.drift.field_count` representing the number of currently drifted fields (0 when no drift).
5. WHEN a drift check completes, THE Drift_Detector SHALL emit a structured log line at `warn` level if any drifted fields have Severity_Level `critical` or `warning`, and at `debug` level otherwise.
6. WHEN an audit write error occurs, THE Audit_Logger SHALL emit a structured log line at `error` level including the I/O error message and the number of entries that failed to persist.

---

### Requirement 8: Non-Functional — Performance and Availability

**User Story:** As a platform engineer, I want the audit and drift subsystem to operate without degrading the configuration hot-reload path or causing service unavailability.

#### Acceptance Criteria

1. THE Audit_Logger SHALL write Audit_Entries asynchronously and SHALL NOT block the ConfigManager's `reload()` or `update()` methods.
2. WHILE the audit log file is unavailable, THE ConfigManager SHALL continue serving valid configuration to callers within the existing < 100 ms P99 contract.
3. THE Drift_Detector SHALL run drift checks in a background timer and SHALL NOT execute drift checks synchronously on the Critical_Path.
4. THE Baseline_Store SHALL persist baseline snapshots using atomic file writes (write-to-temp then rename) to prevent partial-write corruption.
5. THE Audit_Logger SHALL buffer up to 500 pending Audit_Entries in memory when the log file is temporarily unavailable, discarding oldest entries beyond that limit and incrementing the `verinode.config.audit.entries_dropped` counter.
6. IF the process restarts, THEN THE Baseline_Store SHALL restore the last persisted baseline from disk during initialization, completing the restore within 200 ms.
7. THE Audit_API SHALL cache the parsed audit log in memory and SHALL invalidate the cache when a new Audit_Entry is written, so repeated reads do not re-parse the log file.
