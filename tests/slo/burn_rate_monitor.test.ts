import assert from 'assert/strict';
import { BurnRateMonitor, SYSTEM_SLO_OBJECTIVES, SloEvaluation } from '../../src/slo';

async function run() {
  const objective = SYSTEM_SLO_OBJECTIVES[0];
  const alerts: SloEvaluation[] = [];
  const monitor = new BurnRateMonitor({
    alertSink: {
      notify: (evaluation) => {
        alerts.push(evaluation);
      },
    },
    now: () => new Date('2026-07-25T00:00:00.000Z'),
  });

  const healthy = monitor.evaluate(objective, [
    { window: '5m', goodEvents: 100_000, totalEvents: 100_000 },
    { window: '1h', goodEvents: 1_000_000, totalEvents: 1_000_000 },
  ]);
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.errorBudgetRemaining, 1);
  assert.equal(alerts.length, 0);

  const critical = monitor.evaluate(objective, [
    { window: '5m', goodEvents: 99_800, totalEvents: 100_000 },
    { window: '1h', goodEvents: 999_990, totalEvents: 1_000_000 },
  ]);
  assert.equal(critical.status, 'critical');
  assert.equal(critical.violatedThresholds[0].window, '5m');
  assert.equal(critical.violatedThresholds[0].severity, 'critical');
  assert.equal(alerts.length, 1);
  assert.ok(critical.windows[0].burnRate > 14.4);

  const warning = monitor.evaluate(objective, [
    { window: '6h', goodEvents: 999_960, totalEvents: 1_000_000 },
  ]);
  assert.equal(warning.status, 'warning');
  assert.equal(warning.violatedThresholds[0].severity, 'warning');

  assert.throws(
    () =>
      monitor.evaluate({ ...objective, target: 1 }, [
        { window: '5m', goodEvents: 1, totalEvents: 1 },
      ]),
    /target/,
  );
  assert.throws(
    () => monitor.evaluate(objective, [{ window: '5m', goodEvents: 2, totalEvents: 1 }]),
    /goodEvents/,
  );
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
