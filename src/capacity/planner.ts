export type CapacityResource = 'cpu' | 'memory' | 'storage' | 'requests' | 'latency';

export interface UsageSample {
  service: string;
  resource: CapacityResource;
  value: number;
  capacity: number;
  timestamp: number;
}

export interface CapacityForecast {
  service: string;
  resource: CapacityResource;
  currentUtilizationPercent: number;
  projectedUtilizationPercent: number;
  projectedValue: number;
  daysToExhaustion: number | null;
  growthPerDay: number;
  confidence: number;
  level: 'healthy' | 'watch' | 'scale' | 'critical';
  recommendation: string;
}

export interface CapacityPlannerOptions {
  retentionDays?: number;
  forecastDays?: number;
  watchUtilizationPercent?: number;
  scaleUtilizationPercent?: number;
  criticalUtilizationPercent?: number;
  minSamplesForTrend?: number;
  now?: () => number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULTS = {
  retentionDays: 90,
  forecastDays: 30,
  watchUtilizationPercent: 70,
  scaleUtilizationPercent: 85,
  criticalUtilizationPercent: 95,
  minSamplesForTrend: 3,
};

export class CapacityPlanner {
  private readonly samples = new Map<string, UsageSample[]>();
  private readonly options: Required<CapacityPlannerOptions>;

  constructor(options: CapacityPlannerOptions = {}) {
    this.options = {
      ...DEFAULTS,
      now: Date.now,
      ...options,
    };
  }

  record(sample: UsageSample): void {
    this.validateSample(sample);
    const key = this.key(sample.service, sample.resource);
    const cutoff = this.options.now() - this.options.retentionDays * DAY_MS;
    const retained = (this.samples.get(key) ?? []).filter((entry) => entry.timestamp >= cutoff);
    retained.push({ ...sample });
    retained.sort((a, b) => a.timestamp - b.timestamp);
    this.samples.set(key, retained);
  }

  recordBatch(samples: UsageSample[]): void {
    for (const sample of samples) this.record(sample);
  }

  forecast(
    service: string,
    resource: CapacityResource,
    forecastDays = this.options.forecastDays,
  ): CapacityForecast | null {
    const history = this.samples.get(this.key(service, resource)) ?? [];
    if (history.length === 0) return null;

    const latest = history[history.length - 1];
    const trend = this.calculateTrend(history);
    const growthPerDay = history.length >= this.options.minSamplesForTrend ? trend.slopePerDay : 0;
    const projectedValue = Math.max(0, latest.value + growthPerDay * forecastDays);
    const currentUtilizationPercent = this.utilization(latest.value, latest.capacity);
    const projectedUtilizationPercent = this.utilization(projectedValue, latest.capacity);
    const daysToExhaustion =
      growthPerDay > 0 ? Math.max(0, (latest.capacity - latest.value) / growthPerDay) : null;
    const level = this.levelFor(
      Math.max(currentUtilizationPercent, projectedUtilizationPercent),
      daysToExhaustion,
    );

    return {
      service,
      resource,
      currentUtilizationPercent,
      projectedUtilizationPercent,
      projectedValue,
      daysToExhaustion,
      growthPerDay,
      confidence: history.length >= this.options.minSamplesForTrend ? trend.confidence : 0,
      level,
      recommendation: this.recommend(level, resource, daysToExhaustion),
    };
  }

  forecastAll(forecastDays = this.options.forecastDays): CapacityForecast[] {
    return Array.from(this.samples.keys())
      .map((key) => {
        const [service, resource] = key.split('|') as [string, CapacityResource];
        return this.forecast(service, resource, forecastDays);
      })
      .filter((forecast): forecast is CapacityForecast => forecast !== null)
      .sort((a, b) => this.rank(b) - this.rank(a));
  }

  prometheusMetrics(forecastDays = this.options.forecastDays): string {
    const lines = [
      '# HELP capacity_current_utilization_percent Current service resource utilization.',
      '# TYPE capacity_current_utilization_percent gauge',
      '# HELP capacity_projected_utilization_percent Projected service resource utilization.',
      '# TYPE capacity_projected_utilization_percent gauge',
      '# HELP capacity_days_to_exhaustion Days until resource reaches provisioned capacity; -1 means not trending toward exhaustion.',
      '# TYPE capacity_days_to_exhaustion gauge',
    ];
    for (const forecast of this.forecastAll(forecastDays)) {
      const labels = `service="${this.escape(forecast.service)}",resource="${forecast.resource}",level="${forecast.level}"`;
      lines.push(
        `capacity_current_utilization_percent{${labels}} ${forecast.currentUtilizationPercent.toFixed(2)}`,
      );
      lines.push(
        `capacity_projected_utilization_percent{${labels}} ${forecast.projectedUtilizationPercent.toFixed(2)}`,
      );
      lines.push(
        `capacity_days_to_exhaustion{${labels}} ${forecast.daysToExhaustion === null ? -1 : forecast.daysToExhaustion.toFixed(2)}`,
      );
    }
    return `${lines.join('\n')}\n`;
  }

  private validateSample(sample: UsageSample): void {
    if (!sample.service.trim()) throw new Error('service is required');
    if (!Number.isFinite(sample.value) || sample.value < 0)
      throw new Error('value must be a non-negative number');
    if (!Number.isFinite(sample.capacity) || sample.capacity <= 0)
      throw new Error('capacity must be greater than zero');
    if (!Number.isFinite(sample.timestamp)) throw new Error('timestamp must be finite');
  }

  private calculateTrend(history: UsageSample[]): { slopePerDay: number; confidence: number } {
    if (history.length < 2) return { slopePerDay: 0, confidence: 0 };
    const firstTs = history[0].timestamp;
    const xs = history.map((sample) => (sample.timestamp - firstTs) / DAY_MS);
    const ys = history.map((sample) => sample.value);
    const xMean = xs.reduce((sum, x) => sum + x, 0) / xs.length;
    const yMean = ys.reduce((sum, y) => sum + y, 0) / ys.length;
    const variance = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
    if (variance === 0) return { slopePerDay: 0, confidence: 0 };
    const covariance = xs.reduce((sum, x, index) => sum + (x - xMean) * (ys[index] - yMean), 0);
    const slopePerDay = covariance / variance;
    const total = ys.reduce((sum, y) => sum + (y - yMean) ** 2, 0);
    const residual = ys.reduce(
      (sum, y, index) => sum + (y - (yMean + slopePerDay * (xs[index] - xMean))) ** 2,
      0,
    );
    const confidence = total === 0 ? 1 : Math.max(0, Math.min(1, 1 - residual / total));
    return { slopePerDay, confidence };
  }

  private utilization(value: number, capacity: number): number {
    return (value / capacity) * 100;
  }

  private levelFor(
    utilizationPercent: number,
    daysToExhaustion: number | null,
  ): CapacityForecast['level'] {
    if (
      utilizationPercent >= this.options.criticalUtilizationPercent ||
      (daysToExhaustion !== null && daysToExhaustion <= 7)
    )
      return 'critical';
    if (
      utilizationPercent >= this.options.scaleUtilizationPercent ||
      (daysToExhaustion !== null && daysToExhaustion <= 30)
    )
      return 'scale';
    if (utilizationPercent >= this.options.watchUtilizationPercent) return 'watch';
    return 'healthy';
  }

  private recommend(
    level: CapacityForecast['level'],
    resource: CapacityResource,
    daysToExhaustion: number | null,
  ): string {
    if (level === 'critical')
      return `Urgently add ${resource} capacity or shed load; projected exhaustion in ${daysToExhaustion?.toFixed(1) ?? 'unknown'} days.`;
    if (level === 'scale')
      return `Schedule blue-green capacity expansion for ${resource} and validate with canary analysis.`;
    if (level === 'watch')
      return `Monitor ${resource} growth and prepare scaling runbook if trend continues.`;
    return `${resource} capacity is within target bounds.`;
  }

  private rank(forecast: CapacityForecast): number {
    const levels = { healthy: 0, watch: 1, scale: 2, critical: 3 };
    return levels[forecast.level] * 1000 + forecast.projectedUtilizationPercent;
  }

  private key(service: string, resource: CapacityResource): string {
    return `${service}|${resource}`;
  }

  private escape(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }
}
