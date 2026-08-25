/**
 * Slack Webhook notifier for config drift alerts.
 *
 * Sends warning-severity (and above) drift alerts to a Slack incoming webhook.
 * Uses Block Kit for a rich, structured message layout.
 */

import { ConfigDriftAlert, DriftReport } from './types';

export interface SlackNotifierOptions {
  /** Incoming Webhook URL from Slack app configuration. */
  webhookUrl: string;
  /** Channel override, e.g. '#verinode-alerts'. Leave empty to use the webhook default. */
  channel?: string;
  /** Set to false to disable notifications without removing configuration. Default: true. */
  enabled?: boolean;
}

export interface SlackClient {
  sendAlert(alert: ConfigDriftAlert): Promise<void>;
}

export class HttpSlackClient implements SlackClient {
  private readonly opts: Required<SlackNotifierOptions>;

  constructor(opts: SlackNotifierOptions) {
    this.opts = {
      enabled: opts.enabled !== false,
      channel: opts.channel ?? '',
      webhookUrl: opts.webhookUrl,
    };
  }

  async sendAlert(alert: ConfigDriftAlert): Promise<void> {
    if (!this.opts.enabled) return;

    const message = buildSlackMessage(alert, this.opts.channel);

    const fetchFn: typeof fetch = (global as any).fetch;
    if (!fetchFn) {
      throw new Error('Global fetch is not available in this Node runtime');
    }

    const res = await fetchFn(this.opts.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(5000),
    } as RequestInit);

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Slack webhook failed: ${res.status} ${res.statusText} ${text}`);
    }
  }
}

// ── Message builder ───────────────────────────────────────────────────────────

function buildSlackMessage(alert: ConfigDriftAlert, channel: string): Record<string, unknown> {
  const report = alert.driftReport;
  const emoji = alert.severity === 'critical' ? ':rotating_light:' : ':warning:';
  const severityLabel = alert.severity.toUpperCase();

  const topFindings = report.findings.slice(0, 10);
  const findingLines = topFindings
    .map((f) => `• \`${f.key}\` — ${f.category} (${f.severity})`)
    .join('\n');

  const overflowNote =
    report.findings.length > 10
      ? `\n_…and ${report.findings.length - 10} more finding(s)._`
      : '';

  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `${emoji} Config Drift Detected — ${severityLabel}`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Snapshot ID*\n\`${alert.snapshotId}\`` },
        { type: 'mrkdwn', text: `*Severity*\n${severityLabel}` },
        { type: 'mrkdwn', text: `*Total Findings*\n${report.summary.total}` },
        {
          type: 'mrkdwn',
          text: `*Breakdown*\nvalue_change: ${report.summary.valueChanges}  key_added: ${report.summary.keyAdded}  key_removed: ${report.summary.keyRemoved}  type_change: ${report.summary.typeChanges}`,
        },
      ],
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Drifted Keys*\n${findingLines || '_none_'}${overflowNote}`,
      },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `Alert ID: \`${alert.alertId}\` · Runtime hash: \`${report.runtimeHash}\` · Baseline hash: \`${report.baselineHash}\``,
        },
      ],
    },
  ];

  const payload: Record<string, unknown> = { blocks };
  if (channel) payload.channel = channel;
  return payload;
}

// ── Factory helper ────────────────────────────────────────────────────────────

/**
 * Create an HttpSlackClient from environment variables.
 *
 * VERINODE_DRIFT_SLACK_WEBHOOK_URL  — required for Slack notifications
 * VERINODE_DRIFT_SLACK_CHANNEL      — optional channel override
 * VERINODE_DRIFT_SLACK_ENABLED      — set to 'false' to disable (default: true)
 */
export function createSlackClientFromEnv(): HttpSlackClient | null {
  const webhookUrl = process.env.VERINODE_DRIFT_SLACK_WEBHOOK_URL;
  if (!webhookUrl) return null;

  const enabled = process.env.VERINODE_DRIFT_SLACK_ENABLED !== 'false';
  const channel = process.env.VERINODE_DRIFT_SLACK_CHANNEL ?? '';

  return new HttpSlackClient({ webhookUrl, channel, enabled });
}
