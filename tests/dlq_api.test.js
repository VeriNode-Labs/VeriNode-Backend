const app = require('../index');

async function main() {
  let passed = 0;
  let failed = 0;

  function assert(condition, name) {
    if (condition) {
      console.log(`  ✓ ${name}`);
      passed++;
    } else {
      console.log(`  ✗ ${name}`);
      failed++;
    }
  }

  console.log('DLQ management API tests\n');

  const calls = [];
  app.locals.deadLetterQueue = {
    async list(params) {
      calls.push(['list', params]);
      return [{ id: 'dlq-1', messageType: 'unit_message', retryCount: 3 }];
    },
    async retry(id, handler) {
      calls.push(['retry', id]);
      return handler({ id: 'original-message' });
    },
    async purge(id) {
      calls.push(['purge', id]);
      return id === 'dlq-1';
    },
    async purgeExpired() {
      calls.push(['purgeExpired']);
      return 2;
    },
    async prometheusMetrics() {
      calls.push(['metrics']);
      return 'verinode_dlq_depth 1\n';
    },
  };
  app.locals.deadLetterRetryHandler = async (message) => ({ recovered: message.id });

  const ready = Promise.withResolvers();
  const server = app.listen(0, () => ready.resolve());
  await ready.promise;
  const address = server.address();
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const list = await fetch(`${base}/internal/dlq?messageType=unit_message&limit=5`);
    const listBody = await list.json();
    assert(list.status === 200, `list status ${list.status}`);
    assert(listBody.entries[0].id === 'dlq-1', 'list returns DLQ entries');

    const retry = await fetch(`${base}/internal/dlq/dlq-1/retry`, { method: 'POST' });
    const retryBody = await retry.json();
    assert(retry.status === 200, `retry status ${retry.status}`);
    assert(retryBody.retried === true && retryBody.result.recovered === 'original-message', 'retry uses configured handler');

    const purge = await fetch(`${base}/internal/dlq/dlq-1`, { method: 'DELETE' });
    const purgeBody = await purge.json();
    assert(purge.status === 200, `purge status ${purge.status}`);
    assert(purgeBody.purged === true, 'purge removes requested entry');

    const purgeExpired = await fetch(`${base}/internal/dlq/expired`, { method: 'DELETE' });
    const purgeExpiredBody = await purgeExpired.json();
    assert(purgeExpired.status === 200, `expired purge status ${purgeExpired.status}`);
    assert(purgeExpiredBody.purged === 2, 'expired purge reports row count');

    const metrics = await fetch(`${base}/metrics`);
    const metricsText = await metrics.text();
    assert(metrics.status === 200, `metrics status ${metrics.status}`);
    assert(metricsText.includes('verinode_dlq_depth 1'), 'metrics includes DLQ gauge');
  } finally {
    const closed = Promise.withResolvers();
    server.close(() => closed.resolve());
    await closed.promise;
  }

  const total = passed + failed;
  console.log(`\n${total} tests: ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
