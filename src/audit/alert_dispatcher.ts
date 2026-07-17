/**
 * VeriNode Backend — Runtime Config Audit: AlertDispatcher
 *
 * Routes drift alerts to operators via the existing IdempotentWebhookService
 * and IdempotentEmailService.  dispatch() returns synchronously (initiating
 * delivery), with actual send + persistence handled asynchronously.
 *
 * Sensitive field redaction: values for key-path segments matching
 * /password|secret|key|token/i are replaced with "[REDACTED]".
 */

import { createHash } from 'crypto';
import { Pool } from 'pg';
import { AlertConfig, DriftReport, DriftedKey, PartialAlertPayload } from './types';
import { IdempotentWebhookService } from '../notifications/webhookService';
import { IdempotentEmailService } from '../notifications/emailService';
import { StructuredLogger } from '../diagnostics/logger';

const SENSITIVE_PATTERN = /password|secret|key|token/i;
const EMAIL_SUBJECT = '[VeriNode] Critical Config Drift Detected';

// ── UUID v5 (name-based SHA-1) ────────────────────────────────────────────────
// We implement a lightweight UUID v5 without an external dependency.

function uuidv5FromSha256(sha256hex: string): string {
  // Use first 16 bytes of the SHA-256 hash as UUID bytes, set version bits
  const b = Buffer.from(sha256hex.slice(0, 32), 'hex');
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // variant RFC 4122
  const h = b.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20,32)}`;
}

// ── Alert payload ─────────────────────────────────────────────────────────────

interface AlertPayload {
  alertId: string;
  severity: 'critical' | 'non_critical';
  driftedKeys: string[];
  baselineId: string;
  detectedAt: string;
  currentValues: Record<string, unknown>;
}

// ── AlertDispatcher ───────────────────────────────────────────────────────────

export class AlertDispatcher {
  constructor(
    private readonly webhookService: IdempotentWebhookService,
    private readonly emailService: IdempotentEmailService,
    private readonly pool: Pool,
    private readonly logger: StructuredLogger,
    private readonly config: AlertConfig,
  ) {}

  /**
   * Initiate alert dispatch for a DriftReport or PartialAlertPayload.
   * Returns synchronously after submitting the async delivery worker.
   * Non-critical-only reports are silently ignored.
   */
  dispatch(report: DriftReport | PartialAlertPayload): void {
    // Partial alerts are always critical-path emergencies
    if ('partialReport' in report) {
      this._dispatchAsync(null, report.error).catch(() => {});
      return;
    }

    const hasCritical = report.driftedKeys.some((k) => k.severity === 'critical');
    if (!hasCritical) return; // non-critical only — no alert

    this._dispatchAsync(report, null).catch(() => {});
  }

  // ── Private async delivery ────────────────────────────────────────────────

  private async _dispatchAsync(
    report: DriftReport | null,
    partialError: string | null,
  ): Promise<void> {
    const baselineId = report?.baselineId ?? 'unknown';
    const detectedAt = report?.detectedAt ?? new Date();

    // Derive idempotency key: SHA-256(baselineId + ":" + floor(ts/1000))
    const tsBucket = Math.floor(detectedAt.getTime() / 1000);
    const idempotencyHash = createHash('sha256')
      .update(`${baselineId}:${tsBucket}`)
      .digest('hex');
    const alertId = uuidv5FromSha256(idempotencyHash);

    const payload = this._buildPayload(alertId, report, partialError, detectedAt);

    if (this.config.canaryMode) {
      this.logger.info('[AlertDispatcher] CANARY MODE — alert suppressed (would dispatch)', {
        alert_id: alertId,
        baseline_id: baselineId,
        severity: payload.severity,
      });
      return;
    }

    const results = await Promise.allSettled([
      ...this._webhookCalls(alertId, payload),
      ...this._emailCalls(alertId, payload),
    ]);

    const allFailed = results.every((r) => r.status === 'rejected');
    if (allFailed) {
      await this._persistFailedAlert(alertId, baselineId, detectedAt, payload).catch(
        (err: Error) => {
          this.logger.error('[AlertDispatcher] Failed to persist failed alert', {
            'error.message': err.message,
            alert_id: alertId,
          });
        },
      );
    }
  }

  private _buildPayload(
    alertId: string,
    report: DriftReport | null,
    partialError: string | null,
    detectedAt: Date,
  ): AlertPayload {
    const driftedKeys = report?.driftedKeys.map((k) => k.path) ?? [];
    const hasCritical =
      report?.driftedKeys.some((k) => k.severity === 'critical') ?? true;

    const currentValues: Record<string, unknown> = {};
    for (const dk of report?.driftedKeys ?? []) {
      currentValues[dk.path] = _redact(dk.path, dk.liveValue);
    }

    return {
      alertId,
      severity: hasCritical ? 'critical' : 'non_critical',
      driftedKeys,
      baselineId: report?.baselineId ?? 'unknown',
      detectedAt: detectedAt.toISOString(),
      currentValues,
    };
  }

  private _webhookCalls(alertId: string, payload: AlertPayload): Promise<void>[] {
    return this.config.webhookUrls.map((url) =>
      this.webhookService.postWebhook({
        notificationId: `${alertId}:${url}`,
        url,
        payload: payload as unknown as Record<string, unknown>,
        timeoutMs: 5000,
      }),
    );
  }

  private _emailCalls(alertId: string, payload: AlertPayload): Promise<void>[] {
    if (!this.config.emailEnabled) return [];

    const body = [
      `Alert ID:       ${payload.alertId}`,
      `Baseline ID:    ${payload.baselineId}`,
      `Detected At:    ${payload.detectedAt}`,
      `Drifted Keys:   ${payload.driftedKeys.length}`,
      `Keys:           ${payload.driftedKeys.join(', ')}`,
    ].join('\n');

    return this.config.emailAddresses.map((to) =>
      this.emailService.sendEmail({
        notificationId: `${alertId}:${to}`,
        to,
        subject: EMAIL_SUBJECT,
        body,
      }),
    );
  }

  private async _persistFailedAlert(
    alertId: string,
    baselineId: string,
    detectedAt: Date,
    payload: AlertPayload,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO config_drift_alerts
         (alert_id, baseline_id, detected_at, severity, drifted_keys, status)
       VALUES ($1, $2::uuid, $3, $4, $5, 'failed')
       ON CONFLICT (alert_id) DO NOTHING`,
      [
        alertId,
        baselineId === 'unknown' ? '00000000-0000-0000-0000-000000000000' : baselineId,
        detectedAt,
        payload.severity,
        JSON.stringify(payload.driftedKeys),
      ],
    );
    this.logger.warn('[AlertDispatcher] All channels failed; alert persisted for retry', {
      alert_id: alertId,
    });
  }
}

// ── Redaction helper ──────────────────────────────────────────────────────────

function _redact(path: string, value: unknown): unknown {
  const segments = path.split('.');
  const isSensitive = segments.some((s) => SENSITIVE_PATTERN.test(s));
  return isSensitive ? '[REDACTED]' : value;
}
