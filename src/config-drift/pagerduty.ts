import { createHash } from 'crypto';
import { DriftReport, CriticalDriftPolicy, ConfigDriftAlert, DriftSeverity } from './types';

export interface PagerDutyOptions {
  enabled: boolean;
  routingKey: string;
  integrationKey?: string;
  criticalPolicy: CriticalDriftPolicy;
}

export interface PagerDutyClient {
  triggerAlert(alert: ConfigDriftAlert): Promise<void>;
}

export class HttpPagerDutyClient implements PagerDutyClient {
  constructor(private readonly opts: PagerDutyOptions) {}

  async triggerAlert(alert: ConfigDriftAlert): Promise<void> {
    if (!this.opts.enabled) return;

    // PagerDuty only handles critical; warnings go to Slack.
    if (alert.severity !== 'critical') return;

    const payload = {
      routing_key: this.opts.routingKey,
      event_action: 'trigger',
      dedup_key: alert.alertId,
      payload: {
        summary: `Config drift detected: ${alert.severity.toUpperCase()} — ${alert.snapshotId}`,
        source: 'verinode-config-drift',
        severity: 'critical',
        group: alert.policyMatchedPrefix ? `prefix:${alert.policyMatchedPrefix}` : undefined,
        custom_details: {
          snapshotId: alert.snapshotId,
          runtimeHash: alert.driftReport.runtimeHash,
          baselineHash: alert.driftReport.baselineHash,
          summary: alert.driftReport.summary,
          findings: alert.driftReport.findings.slice(0, 50),
        },
        timestamp: new Date().toISOString(),
      },
    };

    const fetchFn: typeof fetch = (global as any).fetch;
    if (!fetchFn) {
      throw new Error('Global fetch is not available in this Node runtime');
    }

    const res = await fetchFn('https://events.pagerduty.com/v2/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    } as any);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`PagerDuty enqueue failed: ${res.status} ${res.statusText} ${text}`);
    }
  }
}

export function alertIdFor(report: DriftReport): string {
  const digest = createHash('sha256')
    .update(
      `${report.snapshotId}|${report.runtimeHash}|${report.baselineHash}|${report.summary.total}`,
    )
    .digest('hex')
    .slice(0, 32);
  return `config-drift:${digest}`;
}

/**
 * Build a ConfigDriftAlert for CRITICAL findings.
 * Returns null when there are no critical findings or policy is disabled.
 */
export function buildAlertIfCritical(args: {
  report: DriftReport;
  policy: CriticalDriftPolicy;
  policyMatchedPrefix?: string;
}): ConfigDriftAlert | null {
  const { report, policy, policyMatchedPrefix } = args;
  if (!policy.enabled) return null;
  if (report.findings.length === 0) return null;
  const hasCritical = report.findings.some((f) => f.severity === 'critical');
  if (!hasCritical) return null;

  return {
    alertId: alertIdFor(report),
    snapshotId: report.snapshotId,
    policyMatchedPrefix,
    severity: 'critical',
    driftReport: report,
  };
}

/**
 * Build a ConfigDriftAlert for WARNING findings.
 * Returns null when there are no warning findings or policy is disabled.
 */
export function buildAlertIfWarning(args: {
  report: DriftReport;
  policy: CriticalDriftPolicy;
  policyMatchedPrefix?: string;
}): ConfigDriftAlert | null {
  const { report, policy, policyMatchedPrefix } = args;
  if (!policy.enabled) return null;
  if (report.findings.length === 0) return null;
  // Only trigger warning alert if there are no critical findings
  // (critical will be handled by PagerDuty) and there are warnings.
  const hasCritical = report.findings.some((f) => f.severity === 'critical');
  if (hasCritical) return null;
  const hasWarning = report.findings.some((f) => f.severity === 'warning');
  if (!hasWarning) return null;

  return {
    alertId: alertIdFor(report),
    snapshotId: report.snapshotId,
    policyMatchedPrefix,
    severity: 'warning',
    driftReport: report,
  };
}
