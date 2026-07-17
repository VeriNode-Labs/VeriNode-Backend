import { getConfig } from '../config';
import { loadBaselineSnapshot, ExampleConfigBaselineSource } from './baseline';
import { computeDriftReport, pickCriticalPrefix } from './diff';
import { DriftStorage } from './storage';
import { CriticalDriftPolicy, ConfigDriftAlert } from './types';
import { HttpPagerDutyClient, buildAlertIfCritical, PagerDutyOptions, PagerDutyClient } from './pagerduty';

export interface ConfigDriftAuditorOptions {
  intervalMs?: number;
  baselineSources?: Array<{ loadBaseline(): Promise<unknown>; name: string }>;
  storage?: DriftStorage;
  pagerDutyClient?: PagerDutyClient;
  criticalPolicy: CriticalDriftPolicy;
  driftCategoryFilter?: 'all';
}

export class ConfigDriftAuditor {
  private timer: NodeJS.Timeout | null = null;
  private baseline: Awaited<ReturnType<typeof loadBaselineSnapshot>> | null = null;
  private running = false;

  constructor(private readonly options: ConfigDriftAuditorOptions) {
    this.options.storage = this.options.storage ?? new DriftStorage();
  }

  async init(): Promise<void> {
    const baselineSources = this.options.baselineSources ?? [new ExampleConfigBaselineSource()];
    this.baseline = await loadBaselineSnapshot(baselineSources as any);
  }

  start(): void {
    const intervalMs = this.options.intervalMs ?? 5 * 60 * 1000;
    // immediate run
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
      });

      this.options.storage!.add({
        snapshotId,
        capturedAt: Date.now(),
        driftReport: report,
      });

      const policyMatchedPrefix = pickCriticalPrefix(
        this.options.criticalPolicy.criticalKeyPrefixes,
        report.findings,
      );

      const alert = buildAlertIfCritical({
        report,
        policy: this.options.criticalPolicy,
        policyMatchedPrefix,
      });

      if (alert && this.options.pagerDutyClient) {
        await this.options.pagerDutyClient.triggerAlert(alert as ConfigDriftAlert);
      }
    } catch {
      // Auditor errors should not crash the server.
      // (Logger module not used here to avoid adding dependencies; can be wired later.)
    } finally {
      this.running = false;
    }
  }
}

export function createConfigDriftAuditorFromEnv(args: {
  storage?: DriftStorage;
}): ConfigDriftAuditor {
  const enabledPagerDuty = process.env.VERINODE_DRIFT_PAGERDUTY_ENABLED === 'true' || process.env.VERINODE_DRIFT_PAGERDUTY_ENABLED === '1';
  const routingKey = process.env.VERINODE_DRIFT_PAGERDUTY_ROUTING_KEY ?? '';

  const criticalKeyPrefixes = (process.env.VERINODE_DRIFT_CRITICAL_PREFIXES ?? 'db,mtls,tls,app,remote')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const intervalMs = Number(process.env.VERINODE_DRIFT_SNAPSHOT_INTERVAL_MS ?? String(5 * 60 * 1000));

  let pagerDutyClient: PagerDutyClient | undefined = undefined;
  const criticalPolicy: CriticalDriftPolicy = {
    enabled: process.env.VERINODE_DRIFT_ALERTS_ENABLED === 'true' || process.env.VERINODE_DRIFT_ALERTS_ENABLED === '1',
    criticalKeyPrefixes,
  };

  if (enabledPagerDuty && routingKey) {
    const pdOpts: PagerDutyOptions = {
      enabled: enabledPagerDuty,
      routingKey,
      criticalPolicy,
    };
    pagerDutyClient = new HttpPagerDutyClient(pdOpts);
  }

  return new ConfigDriftAuditor({
    intervalMs,
    storage: args.storage,
    pagerDutyClient,
    criticalPolicy,
  });
}

