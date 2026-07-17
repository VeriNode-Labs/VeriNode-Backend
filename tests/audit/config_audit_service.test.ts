/**
 * Integration-style tests — ConfigAuditService event flow and rollback.
 *
 * These tests use in-memory stubs (no real DB) to exercise the full
 * orchestration logic.  Real-DB integration tests live in
 * tests/audit/integration/ and require POSTGRES_URL to be set.
 */

import * as assert from 'assert';
import { ConfigAuditService } from '../../src/audit/config_audit_service';
import { AuditLogger } from '../../src/audit/audit_logger';
import { BaselineManager } from '../../src/audit/baseline_manager';
import { DriftDetector } from '../../src/audit/drift_detector';
import { AlertDispatcher } from '../../src/audit/alert_dispatcher';
import { ActorContext, DriftReport } from '../../src/audit/types';
import { ConfigEventBus } from '../../src/config/eventbus';
import { ConfigManager } from '../../src/config/manager';
import { IdempotentWebhookService } from '../../src/notifications/webhookService';
import { IdempotentEmailService } from '../../src/notifications/emailService';
import { createLogger } from '../../src/diagnostics/logger';

// ── Helpers ────────────────────────────────────────────────────────────────────

const TEST_SECRET = Buffer.alloc(32, 'b');

function makeLogger() { return createLogger('test'); }
function makeEventBus() { return new ConfigEventBus(); }

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

function makeActor(permissions: string[] = ['config:baseline:write', 'config:rollback:write']): ActorContext {
  return { actorId: 'operator', permissions: permissions as any, sourceIp: '127.0.0.1' };
}

function makeInMemoryPool() {
  const rows: Record<string, any> = {};
  return {
    rows,
    connect: async () => ({
      query: async (sql: string, params?: any[]) => {
        if (sql.includes('ROLLBACK') || sql.includes('BEGIN') || sql.includes('COMMIT')) return { rows: [] };
        if (sql.includes('INSERT INTO config_baselines')) {
          rows['baseline'] = { id: params![0], snapshot_json: params![1], sha256_hash: params![2], actor: params![3], created_at: params![4], status: 'active' };
          return { rows: [] };
        }
        return { rows: [] };
      },
      release: () => {},
    }),
    query: async (sql: string, _params?: any[]) => {
      if (sql.includes('SELECT 1')) return { rows: [] };
      if (sql.includes('SELECT id, snapshot_json') && rows['baseline']) {
        return { rows: [rows['baseline']] };
      }
      if (sql.includes('SELECT id, snapshot_json')) return { rows: [] };
      if (sql.includes('INSERT INTO config_audit_log')) return { rows: [] };
      if (sql.includes('UPDATE config_baselines')) return { rows: [], rowCount: 0 };
      return { rows: [] };
    },
  };
}

function makeConfigManager(initial: object = { app: { port: 3000 }, db: { host: 'localhost' } }) {
  let cfg = { ...initial } as any;
  return {
    get: () => cfg,
    update: (path: string, value: unknown) => {
      const parts = path.split('.');
      let node = cfg;
      for (let i = 0; i < parts.length - 1; i++) {
        node = node[parts[i]] ??= {};
      }
      node[parts[parts.length - 1]] = value;
    },
  } as unknown as ConfigManager;
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

async function run() {
  console.log('\n=== ConfigAuditService orchestration tests ===\n');

  // ── start/stop lifecycle ──────────────────────────────────────────────────

  await test('start() registers updated listener; stop() removes it', async () => {
    const bus = makeEventBus();
    const pool = makeInMemoryPool() as any;
    const logger = makeLogger();
    const configManager = makeConfigManager();

    const auditLogger = new AuditLogger(pool, TEST_SECRET, bus, logger);
    const baselineManager = new BaselineManager(pool, logger);
    const dispatcher = new AlertDispatcher(
      new IdempotentWebhookService(async () => {}),
      new IdempotentEmailService(async () => {}),
      pool, logger, { webhookUrls: [], emailAddresses: [], emailEnabled: false },
    );
    const driftDetector = new DriftDetector(baselineManager as any, dispatcher, logger);
    const service = new ConfigAuditService(bus, configManager, auditLogger, baselineManager, driftDetector, dispatcher, pool, logger);

    service.start();
    const countBefore = bus.listenerCount('updated');
    assert.ok(countBefore > 0, 'Listener should be registered after start()');

    service.stop();
    const countAfter = bus.listenerCount('updated');
    assert.strictEqual(countAfter, 0, 'Listener should be removed after stop()');
  });

  // ── captureBaseline emits event ────────────────────────────────────────────

  await test('captureBaseline: emits baseline_captured event', async () => {
    const bus = makeEventBus();
    const pool = makeInMemoryPool() as any;
    const logger = makeLogger();
    const configManager = makeConfigManager();

    const auditLogger = new AuditLogger(pool, TEST_SECRET, bus, logger);
    const baselineManager = new BaselineManager(pool, logger);
    const dispatcher = new AlertDispatcher(
      new IdempotentWebhookService(async () => {}),
      new IdempotentEmailService(async () => {}),
      pool, logger, { webhookUrls: [], emailAddresses: [], emailEnabled: false },
    );
    const driftDetector = new DriftDetector(baselineManager as any, dispatcher, logger);
    const service = new ConfigAuditService(bus, configManager, auditLogger, baselineManager, driftDetector, dispatcher, pool, logger);

    let captured = false;
    bus.on('baseline_captured' as any, () => { captured = true; });

    service.start();
    await service.captureBaseline(makeActor());
    service.stop();

    assert.strictEqual(captured, true, 'baseline_captured event must be emitted');
  });

  // ── captureBaseline permission denied ─────────────────────────────────────

  await test('captureBaseline: emits baseline_access_denied for unauthorized actor', async () => {
    const bus = makeEventBus();
    const pool = makeInMemoryPool() as any;
    const logger = makeLogger();
    const configManager = makeConfigManager();

    const auditLogger = new AuditLogger(pool, TEST_SECRET, bus, logger);
    const baselineManager = new BaselineManager(pool, logger);
    const dispatcher = new AlertDispatcher(
      new IdempotentWebhookService(async () => {}),
      new IdempotentEmailService(async () => {}),
      pool, logger, { webhookUrls: [], emailAddresses: [], emailEnabled: false },
    );
    const driftDetector = new DriftDetector(baselineManager as any, dispatcher, logger);
    const service = new ConfigAuditService(bus, configManager, auditLogger, baselineManager, driftDetector, dispatcher, pool, logger);

    let denied = false;
    bus.on('baseline_access_denied' as any, () => { denied = true; });

    service.start();
    await assert.rejects(() => service.captureBaseline(makeActor(['config:read'])));
    service.stop();

    assert.strictEqual(denied, true, 'baseline_access_denied must be emitted on rejection');
  });

  // ── rollback dry-run ──────────────────────────────────────────────────────

  await test('rollback dryRun: returns would-change keys without mutating config', async () => {
    const bus = makeEventBus();
    const pool = makeInMemoryPool() as any;
    const logger = makeLogger();
    const configManager = makeConfigManager({ app: { port: 4000 }, db: { host: 'new' } });

    const auditLogger = new AuditLogger(pool, TEST_SECRET, bus, logger);
    const baselineManager = new BaselineManager(pool, logger);
    const dispatcher = new AlertDispatcher(
      new IdempotentWebhookService(async () => {}),
      new IdempotentEmailService(async () => {}),
      pool, logger, { webhookUrls: [], emailAddresses: [], emailEnabled: false },
    );
    const driftDetector = new DriftDetector(baselineManager as any, dispatcher, logger);
    const service = new ConfigAuditService(bus, configManager, auditLogger, baselineManager, driftDetector, dispatcher, pool, logger);

    service.start();

    const report: DriftReport = {
      baselineId: 'bl-1',
      detectedAt: new Date(),
      driftedKeys: [
        { path: 'db.host', baselineValue: 'old', liveValue: 'new', severity: 'critical' },
      ],
    };

    const result = await service.rollback(report, makeActor(), true);
    service.stop();

    assert.strictEqual(result.dryRun, true);
    assert.deepStrictEqual(result.restored, ['db.host']);
    // Config should NOT have changed
    assert.strictEqual((configManager.get() as any).db.host, 'new', 'dry-run must not mutate config');
  });

  // ── rollback applies changes ───────────────────────────────────────────────

  await test('rollback: restores config to baseline values and emits rollback_complete', async () => {
    const bus = makeEventBus();
    const pool = makeInMemoryPool() as any;
    const logger = makeLogger();
    const configManager = makeConfigManager({ db: { host: 'new-host' } });

    const auditLogger = new AuditLogger(pool, TEST_SECRET, bus, logger);
    const baselineManager = new BaselineManager(pool, logger);
    const dispatcher = new AlertDispatcher(
      new IdempotentWebhookService(async () => {}),
      new IdempotentEmailService(async () => {}),
      pool, logger, { webhookUrls: [], emailAddresses: [], emailEnabled: false },
    );
    const driftDetector = new DriftDetector(baselineManager as any, dispatcher, logger);
    const service = new ConfigAuditService(bus, configManager, auditLogger, baselineManager, driftDetector, dispatcher, pool, logger);

    let rollbackEvent: any = null;
    bus.on('rollback_complete' as any, (payload: any) => { rollbackEvent = payload?.data; });

    service.start();

    const report: DriftReport = {
      baselineId: 'bl-1',
      detectedAt: new Date(),
      driftedKeys: [
        { path: 'db.host', baselineValue: 'old-host', liveValue: 'new-host', severity: 'critical' },
      ],
    };

    const result = await service.rollback(report, makeActor());
    await sleep(50);
    service.stop();

    assert.deepStrictEqual(result.restored, ['db.host']);
    assert.deepStrictEqual(result.skipped, []);
    assert.strictEqual((configManager.get() as any).db.host, 'old-host', 'Config should be rolled back');
    assert.ok(rollbackEvent, 'rollback_complete must be emitted');
    assert.deepStrictEqual(rollbackEvent.restored, ['db.host']);
  });

  // ── rollback permission denied ────────────────────────────────────────────

  await test('rollback: throws ForbiddenError and emits access_denied for unauthorized actor', async () => {
    const bus = makeEventBus();
    const pool = makeInMemoryPool() as any;
    const logger = makeLogger();
    const configManager = makeConfigManager();

    const auditLogger = new AuditLogger(pool, TEST_SECRET, bus, logger);
    const baselineManager = new BaselineManager(pool, logger);
    const dispatcher = new AlertDispatcher(
      new IdempotentWebhookService(async () => {}),
      new IdempotentEmailService(async () => {}),
      pool, logger, { webhookUrls: [], emailAddresses: [], emailEnabled: false },
    );
    const driftDetector = new DriftDetector(baselineManager as any, dispatcher, logger);
    const service = new ConfigAuditService(bus, configManager, auditLogger, baselineManager, driftDetector, dispatcher, pool, logger);

    let denied = false;
    bus.on('baseline_access_denied' as any, () => { denied = true; });

    service.start();

    const report: DriftReport = {
      baselineId: 'bl-1', detectedAt: new Date(),
      driftedKeys: [{ path: 'db.host', baselineValue: 'old', liveValue: 'new', severity: 'critical' }],
    };

    await assert.rejects(() => service.rollback(report, makeActor(['config:read'])));
    service.stop();

    assert.strictEqual(denied, true);
  });

  // ── healthCheck ───────────────────────────────────────────────────────────

  await test('healthCheck: returns healthy when DB reachable and queue empty', async () => {
    const bus = makeEventBus();
    const pool = makeInMemoryPool() as any;
    const logger = makeLogger();
    const configManager = makeConfigManager();

    const auditLogger = new AuditLogger(pool, TEST_SECRET, bus, logger);
    const baselineManager = new BaselineManager(pool, logger);
    const dispatcher = new AlertDispatcher(
      new IdempotentWebhookService(async () => {}),
      new IdempotentEmailService(async () => {}),
      pool, logger, { webhookUrls: [], emailAddresses: [], emailEnabled: false },
    );
    const driftDetector = new DriftDetector(baselineManager as any, dispatcher, logger);
    const service = new ConfigAuditService(bus, configManager, auditLogger, baselineManager, driftDetector, dispatcher, pool, logger);

    service.start();
    const health = await service.healthCheck();
    service.stop();

    assert.strictEqual(health.status, 'healthy');
    assert.strictEqual(health.details['database'], 'reachable');
    assert.strictEqual(health.details['queue_depth'], '0');
  });

  // ── summary ────────────────────────────────────────────────────────────────

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
