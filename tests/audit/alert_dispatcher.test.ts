/**
 * Unit tests — AlertDispatcher: redaction, idempotency, async hand-off,
 *              failure persistence, non-critical bypass
 */

import * as assert from 'assert';
import { AlertDispatcher } from '../../src/audit/alert_dispatcher';
import { AlertConfig, DriftReport } from '../../src/audit/types';
import { IdempotentWebhookService } from '../../src/notifications/webhookService';
import { IdempotentEmailService } from '../../src/notifications/emailService';
import { createLogger } from '../../src/diagnostics/logger';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeLogger() { return createLogger('test'); }

function makeReport(options: {
  criticalKey?: string;
  nonCriticalKey?: string;
  baselineId?: string;
  detectedAt?: Date;
} = {}): DriftReport {
  const keys = [];
  if (options.criticalKey !== undefined) {
    keys.push({ path: options.criticalKey, baselineValue: 'old', liveValue: 'new', severity: 'critical' as const });
  }
  if (options.nonCriticalKey !== undefined) {
    keys.push({ path: options.nonCriticalKey, baselineValue: 'old', liveValue: 'new', severity: 'non_critical' as const });
  }
  return {
    baselineId: options.baselineId ?? 'test-baseline-id',
    detectedAt: options.detectedAt ?? new Date('2025-01-01T00:00:00Z'),
    driftedKeys: keys,
  };
}

function makeWebhookService(shouldFail = false): { service: IdempotentWebhookService; calls: any[] } {
  const calls: any[] = [];
  const sender = async (n: any) => {
    calls.push(n);
    if (shouldFail) throw new Error('webhook failed');
  };
  return { service: new IdempotentWebhookService(sender), calls };
}

function makeEmailService(shouldFail = false): { service: IdempotentEmailService; calls: any[] } {
  const calls: any[] = [];
  const sender = async (n: any) => {
    calls.push(n);
    if (shouldFail) throw new Error('email failed');
  };
  return { service: new IdempotentEmailService(sender), calls };
}

function makePool() {
  const inserts: any[] = [];
  return {
    inserts,
    query: async (sql: string, params?: any[]) => {
      if (sql.includes('INSERT INTO config_drift_alerts')) {
        inserts.push(params);
      }
      return { rows: [] };
    },
  };
}

function makeConfig(overrides: Partial<AlertConfig> = {}): AlertConfig {
  return {
    webhookUrls: ['https://hooks.example.com/test'],
    emailAddresses: ['oncall@example.com'],
    emailEnabled: true,
    ...overrides,
  };
}

// ── Test runner ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void | Promise<void>) {
  return Promise.resolve().then(() => fn()).then(() => {
    console.log(`  ✓ ${name}`);
    passed++;
  }).catch((err: Error) => {
    console.error(`  ✗ ${name}: ${err.message}`);
    failed++;
  });
}

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

async function run() {
  console.log('\n=== AlertDispatcher unit tests ===\n');

  // ── Redaction ─────────────────────────────────────────────────────────────

  await test('dispatch: redacts values for password key segment', async () => {
    const wh = makeWebhookService();
    const em = makeEmailService();
    const pool = makePool();
    const ad = new AlertDispatcher(wh.service, em.service, pool as any, makeLogger(), makeConfig({ emailEnabled: false }));

    const report = makeReport({ criticalKey: 'db.password' });
    report.driftedKeys[0].liveValue = 'supersecret';
    ad.dispatch(report);
    await sleep(100);

    const payload = wh.calls[0]?.payload as any;
    assert.strictEqual(payload?.currentValues?.['db.password'], '[REDACTED]');
  });

  await test('dispatch: redacts values for token key segment (case-insensitive)', async () => {
    const wh = makeWebhookService();
    const em = makeEmailService();
    const pool = makePool();
    const ad = new AlertDispatcher(wh.service, em.service, pool as any, makeLogger(), makeConfig({ emailEnabled: false }));

    const report = makeReport({ criticalKey: 'db.authToken' });
    report.driftedKeys[0].liveValue = 'tok123';
    ad.dispatch(report);
    await sleep(100);

    const payload = wh.calls[0]?.payload as any;
    assert.strictEqual(payload?.currentValues?.['db.authToken'], '[REDACTED]');
  });

  await test('dispatch: does NOT redact non-sensitive fields', async () => {
    const wh = makeWebhookService();
    const em = makeEmailService();
    const pool = makePool();
    const ad = new AlertDispatcher(wh.service, em.service, pool as any, makeLogger(), makeConfig({ emailEnabled: false }));

    const report = makeReport({ criticalKey: 'db.host' });
    report.driftedKeys[0].liveValue = 'new-host';
    ad.dispatch(report);
    await sleep(100);

    const payload = wh.calls[0]?.payload as any;
    assert.strictEqual(payload?.currentValues?.['db.host'], 'new-host');
  });

  // ── Idempotency key ───────────────────────────────────────────────────────

  await test('dispatch: same baseline + same second → same alertId', async () => {
    const alertIds: string[] = [];
    const wh = makeWebhookService();
    const em = makeEmailService();
    const pool = makePool();
    const sender = async (n: any) => { alertIds.push(n.payload.alertId); };
    const ws = new IdempotentWebhookService(sender);
    const ad = new AlertDispatcher(ws, em.service, pool as any, makeLogger(), makeConfig({ emailEnabled: false, webhookUrls: ['http://x'] }));

    const ts = new Date('2025-06-01T12:00:00.000Z');
    const ts2 = new Date('2025-06-01T12:00:00.500Z'); // same second
    ad.dispatch(makeReport({ criticalKey: 'db.host', detectedAt: ts }));
    // IdempotentWebhookService deduplicates by notificationId, so second call is no-op
    // We create a fresh sender to get both alertIds independently
    const alertIds2: string[] = [];
    const sender2 = async (n: any) => { alertIds2.push(n.payload.alertId); };
    const ws2 = new IdempotentWebhookService(sender2);
    const ad2 = new AlertDispatcher(ws2, em.service, pool as any, makeLogger(), makeConfig({ emailEnabled: false, webhookUrls: ['http://x'] }));
    ad2.dispatch(makeReport({ criticalKey: 'db.host', detectedAt: ts2 }));
    await sleep(100);

    assert.ok(alertIds.length > 0, 'First dispatch should produce alertId');
    assert.ok(alertIds2.length > 0, 'Second dispatch should produce alertId');
    assert.strictEqual(alertIds[0], alertIds2[0], 'Same second → same alertId');
  });

  await test('dispatch: different seconds → different alertIds', async () => {
    const alertIds: string[] = [];
    const pool = makePool();
    const em = makeEmailService();

    for (const t of ['2025-06-01T12:00:00Z', '2025-06-01T12:00:01Z']) {
      const sender = async (n: any) => { alertIds.push(n.payload.alertId); };
      const ws = new IdempotentWebhookService(sender);
      const ad = new AlertDispatcher(ws, em.service, pool as any, makeLogger(), makeConfig({ emailEnabled: false, webhookUrls: ['http://x'] }));
      ad.dispatch(makeReport({ criticalKey: 'db.host', detectedAt: new Date(t) }));
    }
    await sleep(150);

    assert.strictEqual(alertIds.length, 2);
    assert.notStrictEqual(alertIds[0], alertIds[1], 'Different seconds → different alertIds');
  });

  // ── Async hand-off ────────────────────────────────────────────────────────

  await test('dispatch: returns synchronously even when channels are slow', async () => {
    let resolved = false;
    const slowSender = async (_n: any) => { await sleep(2000); };
    const ws = new IdempotentWebhookService(slowSender);
    const em = makeEmailService();
    const pool = makePool();
    const ad = new AlertDispatcher(ws, em.service, pool as any, makeLogger(), makeConfig({ emailEnabled: false }));

    const t0 = Date.now();
    ad.dispatch(makeReport({ criticalKey: 'db.host' }));
    resolved = true;
    const elapsed = Date.now() - t0;

    assert.strictEqual(resolved, true, 'dispatch() must return synchronously');
    assert.ok(elapsed < 100, `dispatch() took ${elapsed}ms — should be < 100ms`);
  });

  // ── Failure persistence ────────────────────────────────────────────────────

  await test('dispatch: persists to config_drift_alerts when all channels fail', async () => {
    const wh = makeWebhookService(true); // fails
    const em = makeEmailService(true);   // fails
    const pool = makePool();
    const ad = new AlertDispatcher(wh.service, em.service, pool as any, makeLogger(), makeConfig());

    ad.dispatch(makeReport({ criticalKey: 'db.host' }));
    await sleep(200);

    assert.strictEqual(pool.inserts.length, 1, 'Failed alert should be persisted');
  });

  // ── Non-critical bypass ───────────────────────────────────────────────────

  await test('dispatch: non-critical-only report triggers NO channels or DB writes', async () => {
    const wh = makeWebhookService();
    const em = makeEmailService();
    const pool = makePool();
    const ad = new AlertDispatcher(wh.service, em.service, pool as any, makeLogger(), makeConfig());

    ad.dispatch(makeReport({ nonCriticalKey: 'app.port' }));
    await sleep(100);

    assert.strictEqual(wh.calls.length, 0, 'No webhook calls for non-critical');
    assert.strictEqual(em.calls.length, 0, 'No email calls for non-critical');
    assert.strictEqual(pool.inserts.length, 0, 'No DB writes for non-critical');
  });

  // ── summary ────────────────────────────────────────────────────────────────

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
