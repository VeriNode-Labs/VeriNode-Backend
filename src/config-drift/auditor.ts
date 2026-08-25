import { Pool } from 'pg';
import { createHash } from 'crypto';
import { getConfig } from '../config';
import {
  loadBaselineSnapshot,
  buildDefaultBaselineSources,
  ExampleConfigBaselineSource,
  BaselineSnapshot,
} from './baseline';
import { computeDriftReport, pickCriticalPrefix, pickWarningPrefix } from './diff';
import { flattenConfig } from './flatten';
import { DriftStorage } from './storage';
import { CriticalDriftPolicy, ConfigDriftAlert, ConfigSnapshot } from './types';
import {
  HttpPagerDutyClient,
  buildAlertIfCritical,
  buildAlertIfWarning,
  PagerDutyOptions,
  PagerDutyClient,
} from './pagerduty';
import { HttpSlackClient, SlackClient, createSlackClientFromEnv } from './slack';
import { AutoRemediationEngine } from './remediation';
import {
  DEFAULT_CRITICAL_PREFIXES,
  DEFAULT_WARNING_PREFIXES,
} from './diff';

export interface ConfigDriftAuditorOptions {
  intervalMs?: number;
  baselineSources?: Array<{ loadBaseline(): Promise<unknown>; name: string }>;
  storage?: DriftStorage;
  pagerDutyClient?: PagerDutyClient;
  slackClient?: SlackClient;
  criticalPolicy: CriticalDriftPolicy;
  driftCategoryFilter?: 'all';
  /** PostgreSQL pool for drift event persistence. */
  pool?: Pool;
  /** Enable auto-remediation of known-safe drifts. Default: false. */
  autoRemediationEnabled?: boolean;
}

export class ConfigDriftAuditor {
  private timer: NodeJS.Timeout | null = null;
  private baseline: BaselineSnapshot | null = null;
  private running = false;
  private readonly remediationEngine: AutoRemediationEngine;

  constructor(private readonly options: ConfigDriftAuditorOptions) {
    this.options.storage = this.options.storage ?? new DriftStorage();
    this.remediationEngine = new AutoRemediationEngine();
  }

  async init(): Promise<void> {
    const sources =
      this.options.baselineSources ??
      buildDefaultBaselineSources();
    this.baseline = await loadBaselineSnapshot(sources as any);
  }

  start(): void {
    const intervalMs = this.options.intervalMs ?? 5 * 60 * 1000;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  history(limit = 100) {
    return this.options.storage!.history(limit);
  }

  latest() {
    return this.options.storage!.latest();
  }

  /**
   * Capture a point-in-time snapshot of the current runtime config.
   * This is what GET /config/snapshot returns.
   */
  captureSnapshot(): ConfigSnapshot {
    const runtimeConfig = getConfig() as Record<string, unknown>;
    const flattened = flattenConfig(runtimeConfig);
    const hash = computeHashFromFlattened(flattened);
    const snapshotId = `cfgsnap:${Date.now()}`;

    return {
      snapshotId,
      capturedAt: new Date().toISOString(),
      config: runtimeConfig,
      flattenedHash: hash,
    };
  }

  private computeHashFromFlattened(flat: Record<string, string>): string {
    const { computeHashFromFlattened: fn } = require('./flatten');
    return fn(flat);
  }

  private async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      if (!this.baseline) return;

      const startedAt = Date.now();
      const snapshotId = `cfgdrift:${startedAt}`;
      const runtimeConfig = getConfig();

      const report = computeDriftReport({
        snapshotId,
        runtimeConfig,
        baselineFlattened: this.baseline.flattened,
        baselineHash: this.baseline.baselineHash,
        baselineConfig: this.baseline.baselineConfig,
        criticalKeyPrefixes: this.options.criticalPolicy.criticalKeyPrefixes,
        warningKeyPrefixes: this.options.criticalPolicy.warningKeyPrefixes,
      });

      const capturedAt = new Date();

      this.options.storage!.add({
        snapshotId,
        capturedAt: Date.now(),
        driftReport: report,
      });

      // Persist to PostgreSQL if pool is available
      await this.options.storage!.persistDriftEvents(report, capturedAt);

      // Auto-remediation for known-safe drifts
      if (this.options.autoRemediationEnabled && report.findings.length > 0) {
        await this.applyAutoRemediation(report);
      }

      // Critical alert → PagerDuty
      const criticalMatchedPrefix = pickCriticalPrefix(
        this.options.criticalPolicy.criticalKeyPrefixes,
        report.findings,
      );

      const criticalAlert = buildAlertIfCritical({
        report,
        policy: this.options.criticalPolicy,
        policyMatchedPrefix: criticalMatchedPrefix,
      });

      if (criticalAlert && this.options.pagerDutyClient) {
        await this.options.pagerDutyClient.triggerAlert(criticalAlert).catch((err: Error) => {
          console.error('[config-drift] PagerDuty alert failed:', err.message);
        });
      }

      // Warning alert → Slack
      const warningMatchedPrefix = pickWarningPrefix(
        this.options.criticalPolicy.warningKeyPrefixes,
        report.findings.filter((f) => f.severity === 'warning'),
      );

      const warningAlert = buildAlertIfWarning({
        report,
        policy: this.options.criticalPolicy,
        policyMatchedPrefix: warningMatchedPrefix,
      });

      if (warningAlert && this.options.slackClient) {
        await this.options.slackClient.sendAlert(warningAlert).catch((err: Error) => {
          console.error('[config-drift] Slack alert failed:', err.message);
        });
      }
    } catch (err) {
      // Auditor errors must not crash the server
      console.error('[config-drift] runOnce error:', err instanceof Error ? err.message : String(err));
    } finally {
      this.running = false;
    }
  }

  private async applyAutoRemediation(
    report: Parameters<typeof computeDriftReport>[0] extends never
      ? never
      : ReturnType<typeof computeDriftReport>,
  ): Promise<void> {
    if (!this.baseline) return;

    const result = this.remediationEngine.evaluate(report);
    if (result.remediated.length === 0) return;

    // Update the in-memory baseline
    this.remediationEngine.applyToBaseline(this.baseline, result.remediated);

    // Annotate DB rows as auto-remediated
    for (const { finding, ruleId, note } of result.remediated) {
      // We don't have the event_id here; mark by key + snapshot_id if pool available
      if (this.options.pool) {
        await this.options.pool
          .query(
            `UPDATE config_drift_events
                SET auto_remediated = true, remediation_note = $1
              WHERE snapshot_id = $2 AND key = $3`,
            [`rule:${ruleId} — ${note}`, report.snapshotId, finding.key],
          )
          .catch((err: Error) => {
            console.error('[config-drift] Failed to annotate remediated event:', err.message);
          });
      }

      console.log(
        `[config-drift] Auto-remediated key "${finding.key}" via rule "${ruleId}": ${note}`,
      );
    }
  }
}

// ── Factory ────────────────────────────────────────────────────────────────────

export function createConfigDriftAuditorFromEnv(args: {
  storage?: DriftStorage;
  pool?: Pool;
}): ConfigDriftAuditor {
  const enabledPagerDuty =
    process.env.VERINODE_DRIFT_PAGERDUTY_ENABLED === 'true' ||
    process.env.VERINODE_DRIFT_PAGERDUTY_ENABLED === '1';
  const routingKey = process.env.VERINODE_DRIFT_PAGERDUTY_ROUTING_KEY ?? '';

  const criticalKeyPrefixes = (
    process.env.VERINODE_DRIFT_CRITICAL_PREFIXES ?? DEFAULT_CRITICAL_PREFIXES.join(',')
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const warningKeyPrefixes = (
    process.env.VERINODE_DRIFT_WARNING_PREFIXES ?? DEFAULT_WARNING_PREFIXES.join(',')
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const intervalMs = Number(
    process.env.VERINODE_DRIFT_SNAPSHOT_INTERVAL_MS ?? String(5 * 60 * 1000),
  );

  const alertsEnabled =
    process.env.VERINODE_DRIFT_ALERTS_ENABLED === 'true' ||
    process.env.VERINODE_DRIFT_ALERTS_ENABLED === '1';

  const criticalPolicy: CriticalDriftPolicy = {
    enabled: alertsEnabled,
    criticalKeyPrefixes,
    warningKeyPrefixes,
  };

  let pagerDutyClient: PagerDutyClient | undefined = undefined;
  if (enabledPagerDuty && routingKey) {
    const pdOpts: PagerDutyOptions = {
      enabled: enabledPagerDuty,
      routingKey,
      criticalPolicy,
    };
    pagerDutyClient = new HttpPagerDutyClient(pdOpts);
  }

  const slackClient: SlackClient | undefined = createSlackClientFromEnv() ?? undefined;

  const autoRemediationEnabled =
    process.env.VERINODE_DRIFT_AUTO_REMEDIATION === 'true' ||
    process.env.VERINODE_DRIFT_AUTO_REMEDIATION === '1';

  // Wire PostgreSQL pool into storage if provided
  const storage =
    args.storage ??
    new DriftStorage({
      pool: args.pool,
    });

  return new ConfigDriftAuditor({
    intervalMs,
    storage,
    pagerDutyClient,
    slackClient,
    criticalPolicy,
    pool: args.pool,
    autoRemediationEnabled,
  });
}

// Re-export the hash helper so routes.ts can use it without importing flatten
function computeHashFromFlattened(flat: Record<string, string>): string {
  const { computeHashFromFlattened: fn } = require('./flatten');
  return fn(flat);
}
