/**
 * Unit tests — BaselineManager serialization, deserialization, and capture
 */

import * as assert from 'assert';
import { BaselineManager } from '../../src/audit/baseline_manager';
import {
  ActorContext,
  BaselineDeserializationError,
  BaselineSerializationError,
  ForbiddenError,
} from '../../src/audit/types';
import { createLogger } from '../../src/diagnostics/logger';

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeLogger() {
  return createLogger('test');
}

function makeActor(permissions: string[] = ['config:baseline:write']): ActorContext {
  return { actorId: 'test-operator', permissions: permissions as any, sourceIp: '127.0.0.1' };
}

/** Minimal stub pool that records calls */
function makePool(options: { insertShouldFail?: boolean } = {}) {
  const calls: string[] = [];
  let inTx = false;
  const rows: any[] = [];

  const client = {
    query: async (sql: string, _params?: any[]) => {
      calls.push(sql.trim().slice(0, 40));
      if (sql.includes('BEGIN')) inTx = true;
      if (sql.includes('COMMIT')) inTx = false;
      if (sql.includes('ROLLBACK')) inTx = false;
      if (options.insertShouldFail && sql.includes('INSERT INTO config_baselines')) {
        throw new Error('simulated insert failure');
      }
      if (sql.includes('SELECT') && sql.includes('config_baselines')) {
        return { rows };
      }
      return { rows: [{ id: 'new-id' }] };
    },
    release: () => {},
  };

  const pool = {
    connect: async () => client,
    query: async (sql: string, params?: any[]) => client.query(sql, params),
    _calls: calls,
    _rows: rows,
  };

  return pool;
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
  console.log('\n=== BaselineManager unit tests ===\n');

  const mgr = new BaselineManager(makePool() as any, makeLogger());

  // ── serializeBaseline ──────────────────────────────────────────────────────

  await test('serializeBaseline: deterministic key order', () => {
    const a = mgr.serializeBaseline({ z: 1, a: 2, m: { z: 3, a: 4 } });
    const b = mgr.serializeBaseline({ m: { a: 4, z: 3 }, a: 2, z: 1 });
    assert.strictEqual(a, b, 'Different insertion order should produce same JSON');
    assert.ok(a.indexOf('"a"') < a.indexOf('"m"') && a.indexOf('"m"') < a.indexOf('"z"'),
      'Top-level keys should be sorted');
  });

  await test('serializeBaseline: throws for null', () => {
    assert.throws(
      () => mgr.serializeBaseline(null as any),
      BaselineSerializationError,
    );
  });

  await test('serializeBaseline: throws for undefined', () => {
    assert.throws(
      () => mgr.serializeBaseline(undefined as any),
      BaselineSerializationError,
    );
  });

  await test('serializeBaseline: throws for array', () => {
    assert.throws(
      () => mgr.serializeBaseline([] as any),
      BaselineSerializationError,
    );
  });

  await test('serializeBaseline: throws for primitive', () => {
    assert.throws(
      () => mgr.serializeBaseline('string' as any),
      BaselineSerializationError,
    );
  });

  // ── deserializeBaseline ────────────────────────────────────────────────────

  await test('deserializeBaseline: round-trip deep-equal', () => {
    const original = { db: { host: 'localhost', port: 5432 }, app: { port: 3000 } };
    const json = mgr.serializeBaseline(original);
    const restored = mgr.deserializeBaseline(json);
    assert.deepStrictEqual(restored, original);
  });

  await test('deserializeBaseline: throws for non-string (number)', () => {
    assert.throws(
      () => mgr.deserializeBaseline(42 as any),
      BaselineDeserializationError,
    );
  });

  await test('deserializeBaseline: throws for non-string (null)', () => {
    assert.throws(
      () => mgr.deserializeBaseline(null as any),
      BaselineDeserializationError,
    );
  });

  await test('deserializeBaseline: throws for invalid JSON', () => {
    assert.throws(
      () => mgr.deserializeBaseline('{not valid json'),
      BaselineDeserializationError,
    );
  });

  await test('deserializeBaseline: error message includes parse failure cause', () => {
    try {
      mgr.deserializeBaseline('{bad}');
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(
        err instanceof BaselineDeserializationError,
        'Should be BaselineDeserializationError',
      );
      assert.ok(
        err.message.length > 0,
        'Error message should be non-empty',
      );
    }
  });

  // ── capture permissions ────────────────────────────────────────────────────

  await test('capture: throws ForbiddenError for actor without config:baseline:write', async () => {
    const pool = makePool() as any;
    const m = new BaselineManager(pool, makeLogger());
    const actor = makeActor(['config:read']);
    await assert.rejects(
      () => m.capture({ app: { port: 3000 } }, actor),
      ForbiddenError,
    );
  });

  await test('capture: succeeds for actor with config:baseline:write', async () => {
    const pool = makePool() as any;
    const m = new BaselineManager(pool, makeLogger());
    const actor = makeActor(['config:baseline:write']);
    const baseline = await m.capture({ app: { port: 3000 } }, actor);
    assert.ok(baseline.id, 'Baseline should have an id');
    assert.strictEqual(baseline.status, 'active');
    assert.strictEqual(baseline.actor, 'test-operator');
  });

  await test('capture: on INSERT failure does not commit supersede', async () => {
    const pool = makePool({ insertShouldFail: true }) as any;
    const m = new BaselineManager(pool, makeLogger());
    const actor = makeActor(['config:baseline:write']);
    await assert.rejects(() => m.capture({ app: { port: 3000 } }, actor));
    // ROLLBACK should have been called
    const hasRollback = pool._calls.some((c: string) => c.includes('ROLLBACK'));
    assert.ok(hasRollback, 'ROLLBACK must be called on INSERT failure');
  });

  // ── summary ────────────────────────────────────────────────────────────────

  console.log(`\n  ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => { console.error(err); process.exit(1); });
