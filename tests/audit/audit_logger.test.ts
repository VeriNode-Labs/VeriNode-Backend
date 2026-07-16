/**
 * Unit tests — AuditLogger: HMAC, retry, queue eviction, verifyChain
 */

import * as assert from 'assert';
import { AuditLogger } from '../../src/audit/audit_logger';
import { computeHmac } from '../../src/audit/hmac';
import { AuditEntry, AuditEntryInput } from '../../src/audit/types';
import { ConfigEventBus } from '../../src/config/eventbus';
import { createLogger } from '../../src/diagnostics/logger';

// ── Helpers ────────────────────────────────────────────────────────────────────

const TEST_SECRET = Buffer.alloc(32, 'a'); // 32 bytes, all 0x61

function makeEventBus() {
  const bus = new ConfigEventBus();
  // Prevent uncaught 'error' event from crashing the test process
  bus.on('error', () => {});
  return bus;
}

function makeLogger() {
  return createLogger('test');
}

function makeEntry(overrides: Partial<AuditEntryInput> = {}): AuditEntryInput {
  return {
    configPath: 'db.host',
    previousValue: 'old',
    newValue: 'new',
    actor: 'test-actor',
    sourceIp: '127.0.0.1',
    changedAt: new Date('2025-01-01T00:00:00Z'),
    changeSource: 'hot_update',
    ...overrides,
  };
}

/** Build a pool stub that stores rows in memory */
function makeInMemoryPool() {
  const rows: Record<string, AuditEntry> = {};
  let failCount = 0;
  let callCount = 0;

  return {
    rows,
    setFailCount(n: number) { failCount = n; },
    getCallCount() { return callCount; },
    query: async (sql: string, params?: any[]) => {
      if (sql.includes('SELECT 1')) return { rows: [] };
      if (sql.includes('COUNT(*)')) {
        return { rows: [{ total: String(Object.keys(rows).length) }] };
      }
      if (sql.includes('INSERT INTO config_audit_log')) {
        callCount++;
        if (failCount > 0) {
          failCount--;
          throw new Error('simulated DB failure');
        }
        const entry: AuditEntry = {
          entryId: params![0],
          configPath: params![1],
          previousValue: JSON.parse(params![2]),
          newValue: JSON.parse(params![3]),
          actor: params![4],
          sourceIp: params![5],
          changedAt: new Date(params![6]),
          changeSource: params![7],
          hmacDigest: params![8],
        };
        rows[entry.entryId] = entry;
        return { rows: [] };
      }
      if (sql.includes('SELECT entry_id') && sql.includes('changed_at >=')) {
        // verifyChain range scan
        return { rows: Object.values(rows).map(dbRow) };
      }
      if (sql.includes('SELECT entry_id') && sql.includes('WHERE entry_id = $1')) {
        const id = params![0];
        if (rows[id]) return { rows: [dbRow(rows[id])] };
        return { rows: [] };
      }
      if (sql.includes('SELECT entry_id')) {
        const id = params ? params[0] : null;
        if (id && rows[id]) return { rows: [dbRow(rows[id])] };
        return { rows: [] };
      }
      if (sql.includes('FROM config_audit_log') && sql.includes('ORDER BY changed_at')) {
        return { rows: Object.values(rows).map(dbRow) };
      }
      if (sql.includes('FROM config_audit_log') && sql.includes('ORDER BY changed_at DESC')) {
        return { rows: Object.values(rows).map(dbRow), rowCount: Object.values(rows).length };
      }
      return { rows: [] };
    },
  };
}

function dbRow(e: AuditEntry) {
  return {
    entry_id: e.entryId,
    config_path: e.configPath,
    previous_value: e.previousValue,
    new_value: e.newValue,
    actor: e.actor,
    source_ip: e.sourceIp,
    changed_at: e.changedAt,
    change_source: e.changeSource,
    hmac_digest: e.hmacDigest,
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

async function run() {
  console.log('\n=== AuditLogger unit tests ===\n');

  // ── HMAC round-trip ────────────────────────────────────────────────────────

  await test('computeHmac: produces 64-char hex string', () => {
    const entry: AuditEntry = {
      entryId: 'abc-123',
      configPath: 'db.host',
      previousValue: 'old',
      newValue: 'new',
      actor: 'tester',
      sourceIp: '1.2.3.4',
      changedAt: new Date('2025-01-01T00:00:00Z'),
      changeSource: 'hot_update',
      hmacDigest: '',
    };
    const digest = computeHmac(entry, TEST_SECRET);
    assert.match(digest, /^[0-9a-f]{64}$/, 'Digest must be 64 hex chars');
  });

  await test('computeHmac: same input → same digest', () => {
    const entry: AuditEntry = {
      entryId: 'x', configPath: 'app.port', previousValue: 3000, newValue: 4000,
      actor: 'op', sourceIp: null, changedAt: new Date('2025-01-01T00:00:00Z'),
      changeSource: 'file', hmacDigest: '',
    };
    assert.strictEqual(computeHmac(entry, TEST_SECRET), computeHmac(entry, TEST_SECRET));
  });

  await test('verifyIntegrity: returns true for unmodified entry', async () => {
    const pool = makeInMemoryPool();
    const logger = makeLogger();
    const bus = makeEventBus();
    const al = new AuditLogger(pool as any, TEST_SECRET, bus, logger);

    await al.write(makeEntry());
    al.stop();

    const [id] = Object.keys(pool.rows);
    const valid = await al.verifyIntegrity(id);
    assert.strictEqual(valid, true);
  });

  await test('verifyIntegrity: returns false for tampered hmac_digest', async () => {
    const pool = makeInMemoryPool();
    const al = new AuditLogger(pool as any, TEST_SECRET, makeEventBus(), makeLogger());

    await al.write(makeEntry());
    al.stop();

    const [id] = Object.keys(pool.rows);
    // Tamper
    pool.rows[id].hmacDigest = '0'.repeat(64);
    const valid = await al.verifyIntegrity(id);
    assert.strictEqual(valid, false);
  });

  // ── Retry back-off ─────────────────────────────────────────────────────────

  await test('write: retries up to 3× before succeeding', async () => {
    const pool = makeInMemoryPool();
    pool.setFailCount(2); // fail first 2 attempts
    const al = new AuditLogger(pool as any, TEST_SECRET, makeEventBus(), makeLogger());

    await al.write(makeEntry());
    al.stop();

    assert.strictEqual(pool.getCallCount(), 3, 'Should have made exactly 3 INSERT calls');
    assert.strictEqual(Object.keys(pool.rows).length, 1, 'Entry should be stored after retry');
  });

  await test('write: after all retries exhausted, entry goes to queue', async () => {
    const pool = makeInMemoryPool();
    pool.setFailCount(999); // always fail
    const al = new AuditLogger(pool as any, TEST_SECRET, makeEventBus(), makeLogger());

    await al.write(makeEntry());
    al.stop();

    assert.strictEqual(al.queueDepth, 1, 'Failed entry should be in queue');
    assert.strictEqual(Object.keys(pool.rows).length, 0, 'Nothing should be in DB');
  });

  // ── Queue eviction ─────────────────────────────────────────────────────────

  await test('write: evicts oldest entry when queue at capacity', async () => {
    const pool = makeInMemoryPool();
    pool.setFailCount(999); // keep DB unavailable

    // Prime first failure so dbAvailable flips to false
    const al = new AuditLogger(pool as any, TEST_SECRET, makeEventBus(), makeLogger());
    await al.write(makeEntry({ configPath: 'seed' }));
    al.stop();

    // Manually fill queue to capacity (it already has 1)
    const priv = al as any;
    for (let i = priv.queue.length; i < 1000; i++) {
      priv.queue.push({ ...makeEntry({ configPath: `key.${i}` }), entryId: `id-${i}`, hmacDigest: '0'.repeat(64) });
    }
    assert.strictEqual(al.queueDepth, 1000);

    const firstEntryId = priv.queue[0].entryId;

    // Write one more — should evict oldest
    await al.write(makeEntry({ configPath: 'overflow' }));

    assert.strictEqual(al.queueDepth, 1000, 'Queue should stay at 1000');
    assert.notStrictEqual(priv.queue[0].entryId, firstEntryId, 'Oldest entry should have been evicted');
  });

  // ── verifyChain ────────────────────────────────────────────────────────────

  await test('verifyChain: reports 0 invalid for clean log', async () => {
    const pool = makeInMemoryPool();
    const al = new AuditLogger(pool as any, TEST_SECRET, makeEventBus(), makeLogger());
    await al.write(makeEntry({ configPath: 'a.b' }));
    await al.write(makeEntry({ configPath: 'c.d' }));
    al.stop();

    const result = await al.verifyChain(new Date('2020-01-01'), new Date('2030-01-01'));
    assert.strictEqual(result.totalChecked, 2);
    assert.strictEqual(result.invalidCount, 0);
  });

  await test('verifyChain: emits integrity_violation when digest tampered', async () => {
    const pool = makeInMemoryPool();
    const bus = makeEventBus();
    let violationEmitted = false;
    bus.on('integrity_violation', () => { violationEmitted = true; });

    const al = new AuditLogger(pool as any, TEST_SECRET, bus, makeLogger());
    await al.write(makeEntry());
    al.stop();

    const [id] = Object.keys(pool.rows);
    pool.rows[id].hmacDigest = '0'.repeat(64);

    const result = await al.verifyChain(new Date('2020-01-01'), new Date('2030-01-01'));
    assert.strictEqual(result.invalidCount, 1);
    assert.deepStrictEqual(result.invalidEntryIds, [id]);
    assert.strictEqual(violationEmitted, true, 'integrity_violation must be emitted');
  });

  // ── summary ────────────────────────────────────────────────────────────────

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
