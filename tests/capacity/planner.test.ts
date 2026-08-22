import assert from 'node:assert/strict';
import { CapacityPlanner, UsageSample } from '../../src/capacity';

const base = Date.UTC(2026, 0, 1);
const day = 24 * 60 * 60 * 1000;

function sample(dayOffset: number, value: number): UsageSample {
  return {
    service: 'api',
    resource: 'requests',
    value,
    capacity: 1000,
    timestamp: base + dayOffset * day,
  };
}

{
  const planner = new CapacityPlanner({ now: () => base + 4 * day, forecastDays: 30 });
  planner.recordBatch([sample(0, 100), sample(1, 150), sample(2, 200), sample(3, 250)]);

  const forecast = planner.forecast('api', 'requests');
  assert.ok(forecast);
  assert.equal(forecast.growthPerDay, 50);
  assert.equal(forecast.projectedValue, 1750);
  assert.equal(forecast.level, 'critical');
  assert.equal(forecast.daysToExhaustion, 15);
}

{
  const planner = new CapacityPlanner({ now: () => base + 100 * day, retentionDays: 7 });
  planner.record(sample(0, 100));
  planner.record(sample(99, 200));

  const forecast = planner.forecast('api', 'requests', 1);
  assert.ok(forecast);
  assert.equal(forecast.currentUtilizationPercent, 20);
  assert.equal(forecast.confidence, 0);
}

{
  const planner = new CapacityPlanner({ now: () => base + 4 * day });
  planner.recordBatch([sample(0, 100), sample(1, 200), sample(2, 300)]);

  const metrics = planner.prometheusMetrics(1);
  assert.match(
    metrics,
    /capacity_current_utilization_percent\{service="api",resource="requests",level="healthy"\} 30\.00/,
  );
  assert.match(metrics, /capacity_projected_utilization_percent/);
  assert.match(metrics, /capacity_days_to_exhaustion/);
}
