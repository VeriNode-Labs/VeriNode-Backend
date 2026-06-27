import { createHash } from 'crypto';
import { DriftReport, CriticalDriftPolicy, ConfigDriftAlert } from './types';

export interface PagerDutyOptions {
  enabled: boolean;
  routingKey: string;
  /**
   * Service integration key. In many PD setups, the routing key is enough.
   */
  integrationKey?: string;
  /**
   * Limit alerting to deployment-scoped drift.
   */
  criticalPolicy: CriticalDriftPolicy;
}

export interface PagerDutyClient {
  triggerAlert(alert: ConfigDriftAlert): Promise<void>;
}

export class HttpPagerDutyClient implements PagerDutyClient {
  constructor(private readonly opts: PagerDutyOptions) {}

  async triggerAlert(alert: ConfigDriftAlert): Promise<void> {
    if (!this.opts.enabled) return;

    const payload = {
      routing_key: this.opts.routingKey,
      event_action: 'trigger',
      dedup_key: alert.alertId,
      payload: {
        summary: `Config drift detected: ${alert.severity.toUpperCase()}`,
        source: this.opts.integrationKey ? 'verinode-config-drift' : 'verinode-config-drift',
        severity: alert.severity,
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

    // Prefer global fetch (Node 18+). If missing, require.
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
    .update(`${report.snapshotId}|${report.runtimeHash}|${report.baselineHash}|${report.summary.total}`)
    .digest('hex')
    .slice(0, 32);
  return `config-drift:${digest}`;
}

export function buildAlertIfCritical(args: {
  report: DriftReport;
  policy: CriticalDriftPolicy;
  policyMatchedPrefix?: string;
}): ConfigDriftAlert | null {
  const { report, policy, policyMatchedPrefix } = args;
  if (!policy.enabled) return null;
  if (report.findings.length === 0) return null;
  if (!policyMatchedPrefix) return null;

  return {
    alertId: alertIdFor(report),
    snapshotId: report.snapshotId,
    policyMatchedPrefix,
    severity: 'critical',
    driftReport: report,
  };
}

