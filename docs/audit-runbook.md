# Runtime Config Audit — Operations Runbook

## Overview

The Runtime Configuration Auditing and Drift Detection subsystem continuously monitors the live configuration for unauthorized changes, maintains an immutable audit log with HMAC-SHA-256 integrity protection, and alerts operators on critical drift.

This runbook covers: monitoring signals, alert response procedures, deployment strategy, and secret management.

---

## Monitoring Signals

| Signal | OTel Metric | Threshold | Action |
|--------|-------------|-----------|--------|
| Drift P99 > 100ms | `config_audit.drift_detection_latency_ms` (p99) | > 100ms | Check DB query latency; inspect pool health at `/health/pools`; consider adding a read replica for baseline lookups |
| Queue entries dropped | `config_audit.queue_dropped_total` | > 0 | DB connectivity issue; check `config_audit.health_check_failures_total{component="database"}`; review pool stats |
| Service health degraded | `config_audit.health_check_failures_total` | any increment | Check `component` attribute: `database` → DB probe failed; `queue` → queue at 1000-entry capacity; `notification` → all alert channels unreachable |
| Audit log tampered | `integrity_violation` event on ConfigEventBus | any | **Immediate security incident** — isolate affected services, preserve DB state, escalate to security team |
| Baseline age > 7 days | `config_audit.active_baseline_age_seconds` | > 604800s | Remind operator to re-capture a baseline after verifying the current config is known-good |

### healthCheck() status transitions

| Condition | Status |
|-----------|--------|
| DB reachable AND queue depth = 0 | `healthy` |
| DB unreachable OR queue depth 1–999 | `degraded` |
| queue depth = 1000 OR no successful write in last 60s | `unhealthy` |

Expose `ConfigAuditService.healthCheck()` result at your `/health` endpoint.

---

## Canary Mode

Set the environment variable or config key `AUDIT_CANARY_MODE=true` in the `AlertConfig` to enable canary mode:

```
alertConfig.canaryMode = true
```

**Behavior in canary mode:**
- All drift detection, audit logging, and HMAC computation run normally.
- Alert **dispatch is suppressed** — no webhooks or emails are sent.
- A structured `INFO`-level log entry is emitted for every alert that would have been dispatched (includes `alertId`, `baselineId`, `severity`).
- Use this during the canary window to validate the subsystem without noisy alerts.

---

## Canary Gate Criteria (24-hour window)

Before promoting green (new) to 100% traffic, verify all five gates pass:

| Gate | Metric / Check | Pass Criteria |
|------|---------------|---------------|
| Drift detection latency | `config_audit.drift_detection_latency_ms` p99 | ≤ 100ms |
| Queue saturation | `config_audit.queue_dropped_total` | = 0 (no drops in 24h) |
| Service health | `ConfigAuditService.healthCheck()` | Returns `healthy` for ≥ 99.9% of polls |
| Unhandled exceptions | Process crash logs / uncaughtException count | = 0 |
| Integrity violations | `integrity_violation` events | = 0 |

If any gate fails, roll back to blue immediately (see below).

---

## Blue-Green Rollback Procedure

1. Shift 100% traffic back to the blue (previous) deployment.
2. The `config_audit_log`, `config_baselines`, and `config_drift_alerts` tables are **append-only** — no migration rollback is required. Data written by the green deployment remains intact and does not need to be removed.
3. Re-enable the blue deployment's `ConfigAuditService` if it was stopped.
4. Investigate the failed gate before re-attempting the green promotion.

---

## `VERINODE_AUDIT_HMAC_SECRET` — Secret Management

### Requirements

- **Format**: base64-encoded string
- **Minimum decoded length**: 32 bytes (256 bits)
- **Generation example**:
  ```bash
  openssl rand -base64 32
  ```

### Startup behavior

The `loadHmacSecret()` helper is called at `AuditLogger` construction time. If the variable is:

- **Missing**: throws immediately with message:
  > `[ConfigAudit] VERINODE_AUDIT_HMAC_SECRET environment variable is required but was not set.`

- **Too short** (< 32 bytes decoded): throws with message:
  > `[ConfigAudit] VERINODE_AUDIT_HMAC_SECRET decoded to only N byte(s). A minimum of 32 bytes is required.`

The application will **not start** if the secret is absent or too short. This is intentional: running without a valid HMAC secret would produce audit entries with no integrity protection.

### Rotation

When rotating the HMAC secret:
1. Generate a new secret.
2. Deploy with the new secret. New entries will use the new secret.
3. Existing entries retain their old HMAC digest. `verifyChain()` for historical ranges will report failures for entries hashed with the old secret — this is expected. Document the rotation timestamp so auditors can account for the HMAC key change.

---

## Integrity Violation Response

If `verifyChain()` detects one or more entries with invalid HMAC digests:

1. An `integrity_violation` event is emitted on `ConfigEventBus`.
2. A critical alert is dispatched via `AlertDispatcher`.
3. **Immediate actions**:
   - Preserve a snapshot of the `config_audit_log` table (pg_dump or equivalent).
   - Identify which `entry_id`s failed (`ChainVerificationResult.invalidEntryIds`).
   - Cross-reference with application deployment logs for the same timestamp range.
   - Escalate to the security team — treat as a potential breach until proven otherwise.
4. **Do not** delete or modify rows in `config_audit_log` during the investigation.

---

## Failed Alert Retry

Alerts that failed all delivery channels are persisted in `config_drift_alerts` with `status = 'failed'`. A background worker (or manual operator action) can retry them:

```sql
-- Find failed alerts
SELECT alert_id, baseline_id, detected_at, severity, retry_count
FROM config_drift_alerts
WHERE status = 'failed'
ORDER BY created_at DESC
LIMIT 20;

-- Mark as retrying before sending
UPDATE config_drift_alerts SET status = 'retrying', retry_count = retry_count + 1
WHERE alert_id = '<id>';
```

After successful re-delivery, update to `delivered`:
```sql
UPDATE config_drift_alerts SET status = 'delivered' WHERE alert_id = '<id>';
```
