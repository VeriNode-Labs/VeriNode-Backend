export type SloStatus = 'healthy' | 'warning' | 'critical';
export type SloSignalType = 'availability' | 'latency';

export interface SloObjective {
  /** Stable SLO identifier used in metrics, alerts, and dashboards. */
  id: string;
  service: string;
  description?: string;
  /** SLO target as a ratio, e.g. 0.9999 for 99.99%. */
  target: number;
  /** Compliance window in days. */
  windowDays: number;
  /** Optional latency target for critical-path latency SLOs. */
  latencyP99TargetMs?: number;
}

export interface SloWindowSample {
  window: string;
  goodEvents: number;
  totalEvents: number;
}

export interface BurnRateThreshold {
  window: string;
  burnRate: number;
  severity: Exclude<SloStatus, 'healthy'>;
}

export interface SloEvaluation {
  objective: SloObjective;
  status: SloStatus;
  errorBudgetRemaining: number;
  errorBudgetSpent: number;
  windows: Array<
    SloWindowSample & {
      errorRate: number;
      burnRate: number;
      exhaustedInHours: number | null;
      severity: SloStatus;
    }
  >;
  violatedThresholds: BurnRateThreshold[];
  evaluatedAt: Date;
}

export interface SloAlertSink {
  notify(evaluation: SloEvaluation): Promise<void> | void;
}

export interface SloLogger {
  warn(message: string, attributes?: Record<string, string | number | boolean>): void;
  error(message: string, attributes?: Record<string, string | number | boolean>): void;
}

export interface BurnRateMonitorOptions {
  thresholds?: BurnRateThreshold[];
  alertSink?: SloAlertSink;
  logger?: SloLogger;
  now?: () => Date;
}

const DEFAULT_LOGGER: SloLogger = {
  warn: () => undefined,
  error: () => undefined,
};

const DEFAULT_THRESHOLDS: BurnRateThreshold[] = [
  { window: '5m', burnRate: 14.4, severity: 'critical' },
  { window: '1h', burnRate: 6, severity: 'critical' },
  { window: '6h', burnRate: 3, severity: 'warning' },
  { window: '3d', burnRate: 1, severity: 'warning' },
];

function assertObjective(objective: SloObjective): void {
  if (!objective.id.trim()) throw new Error('SLO objective id is required');
  if (!objective.service.trim()) throw new Error('SLO service is required');
  if (objective.target <= 0 || objective.target >= 1) {
    throw new Error('SLO target must be a ratio greater than 0 and less than 1');
  }
  if (objective.windowDays <= 0) throw new Error('SLO windowDays must be positive');
}

function assertSample(sample: SloWindowSample): void {
  if (!sample.window.trim()) throw new Error('SLO sample window is required');
  if (!Number.isFinite(sample.goodEvents) || !Number.isFinite(sample.totalEvents)) {
    throw new Error('SLO sample events must be finite numbers');
  }
  if (sample.goodEvents < 0 || sample.totalEvents < 0) {
    throw new Error('SLO sample events cannot be negative');
  }
  if (sample.goodEvents > sample.totalEvents) {
    throw new Error('SLO goodEvents cannot exceed totalEvents');
  }
}

export class BurnRateMonitor {
  private readonly thresholds: BurnRateThreshold[];
  private readonly logger: SloLogger;
  private readonly now: () => Date;

  constructor(private readonly options: BurnRateMonitorOptions = {}) {
    this.thresholds = [...(options.thresholds ?? DEFAULT_THRESHOLDS)];
    this.logger = options.logger ?? DEFAULT_LOGGER;
    this.now = options.now ?? (() => new Date());
  }

  evaluate(objective: SloObjective, samples: SloWindowSample[]): SloEvaluation {
    assertObjective(objective);
    if (samples.length === 0) throw new Error('At least one SLO window sample is required');

    const allowedErrorRate = 1 - objective.target;
    const evaluatedWindows = samples.map((sample) => {
      assertSample(sample);
      const errorEvents = sample.totalEvents - sample.goodEvents;
      const errorRate = sample.totalEvents === 0 ? 0 : errorEvents / sample.totalEvents;
      const burnRate = allowedErrorRate === 0 ? 0 : errorRate / allowedErrorRate;
      const threshold = this.thresholds
        .filter((candidate) => candidate.window === sample.window && burnRate >= candidate.burnRate)
        .sort((a, b) => this.rankSeverity(b.severity) - this.rankSeverity(a.severity))[0];

      return {
        ...sample,
        errorRate,
        burnRate,
        exhaustedInHours: burnRate > 0 ? (objective.windowDays * 24) / burnRate : null,
        severity: threshold?.severity ?? 'healthy',
      };
    });

    const totalEvents = samples.reduce((sum, sample) => sum + sample.totalEvents, 0);
    const totalGoodEvents = samples.reduce((sum, sample) => sum + sample.goodEvents, 0);
    const aggregateErrorRate =
      totalEvents === 0 ? 0 : (totalEvents - totalGoodEvents) / totalEvents;
    const errorBudgetSpent = allowedErrorRate === 0 ? 0 : aggregateErrorRate / allowedErrorRate;
    const errorBudgetRemaining = Math.max(0, 1 - errorBudgetSpent);
    const status = evaluatedWindows.reduce<SloStatus>(
      (highest, window) =>
        this.rankSeverity(window.severity) > this.rankSeverity(highest) ? window.severity : highest,
      'healthy',
    );
    const violatedThresholds: BurnRateThreshold[] = [];
    for (const window of evaluatedWindows) {
      if (window.severity === 'warning' || window.severity === 'critical') {
        violatedThresholds.push({
          window: window.window,
          burnRate: window.burnRate,
          severity: window.severity,
        });
      }
    }

    const evaluation: SloEvaluation = {
      objective,
      status,
      errorBudgetRemaining,
      errorBudgetSpent,
      windows: evaluatedWindows,
      violatedThresholds,
      evaluatedAt: this.now(),
    };

    if (status !== 'healthy') {
      this.emitAlert(evaluation);
    }

    return evaluation;
  }

  private emitAlert(evaluation: SloEvaluation): void {
    this.logger.warn('SLO burn-rate threshold violated', {
      slo_id: evaluation.objective.id,
      service: evaluation.objective.service,
      status: evaluation.status,
      error_budget_remaining: evaluation.errorBudgetRemaining,
    });
    void Promise.resolve(this.options.alertSink?.notify(evaluation)).catch((error: Error) => {
      this.logger.error('Failed to dispatch SLO burn-rate alert', {
        slo_id: evaluation.objective.id,
        'error.message': error.message,
      });
    });
  }

  private rankSeverity(status: SloStatus): number {
    return status === 'critical' ? 2 : status === 'warning' ? 1 : 0;
  }
}

export const SYSTEM_SLO_OBJECTIVES: SloObjective[] = [
  {
    id: 'verinode-availability-99-99',
    service: 'verinode-backend',
    description: 'System-wide successful request availability over 30 days',
    target: 0.9999,
    windowDays: 30,
  },
  {
    id: 'critical-path-p99-latency-100ms',
    service: 'verinode-backend',
    description: 'Critical path requests complete under the 100ms P99 target',
    target: 0.999,
    windowDays: 30,
    latencyP99TargetMs: 100,
  },
];
