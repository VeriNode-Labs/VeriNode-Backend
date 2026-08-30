/**
 * issue #197 — missing-index detector (Gate 2).
 *
 * Pins: the >10K-page sequential-scan threshold fires correctly and not below;
 * pg_stat_statements graceful degradation is exercised explicitly; the
 * predicate heuristic emits DDL only for an unambiguous single-column equality
 * and skips (does not guess) anything more complex.
 */

import { strict as assert } from 'assert';
import {
  MissingIndexDetector,
  extractSingleColumnEqualityPredicate,
} from '../../src/database/index_health/missing_index_detector';
import { FakeAnalyzerDb, MB, makeSeqScanRow } from './index_health_helpers';

let failures = 0;
async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

async function main(): Promise<void> {
  const detector = () => new MissingIndexDetector();

  // ── 14. >10K pages + frequent seq scans → advisory (no column, no DDL) ──

  await test('a >10K-page table with frequent seq scans yields a missing_index advisory', async () => {
    const db = new FakeAnalyzerDb({
      seqScanRows: [makeSeqScanRow({ table_name: 'events', relpages: 12_000, seq_scan: 5_000 })],
      pgStatStatementsAvailable: false,
    });
    const findings = await detector().detect(db as any);
    const adv = findings.find((f) => f.tableName === 'events');
    assert.ok(adv, 'the large seq-scanned table is flagged');
    assert.equal(adv!.findingType, 'missing_index');
    assert.equal(adv!.indexName, null);
    assert.equal(adv!.recommendedDdl, null, 'no DDL without a known column');
    assert.match(adv!.recommendation, /sequentially scanned 5000 times/);
  });

  // ── 15. relpages below threshold → not flagged ────────────────────────

  await test('a table with relpages below the 10K threshold is NOT flagged', async () => {
    const db = new FakeAnalyzerDb({
      seqScanRows: [makeSeqScanRow({ table_name: 'small', relpages: 9_000, seq_scan: 99_999 })],
      pgStatStatementsAvailable: false,
    });
    const findings = await detector().detect(db as any);
    assert.equal(
      findings.some((f) => f.tableName === 'small'),
      false,
    );
    // The threshold is applied at the query boundary: first param is minTablePages.
    const seqCall = db.calls.find((c) => /pg_stat_user_tables/i.test(c.text))!;
    assert.deepEqual(seqCall.params, [10_000, 1_000]);
  });

  // ── 16. seq_scan below the floor → not flagged ───────────────────────

  await test('a large table with seq_scan below the floor is NOT flagged', async () => {
    const db = new FakeAnalyzerDb({
      seqScanRows: [makeSeqScanRow({ table_name: 'cold', relpages: 50_000, seq_scan: 100 })],
      pgStatStatementsAvailable: false,
    });
    const findings = await detector().detect(db as any);
    assert.equal(
      findings.some((f) => f.tableName === 'cold'),
      false,
    );
  });

  // ── 17. pg_stat_statements unavailable → explicit degradation, no throw ──

  await test('pg_stat_statements unavailable → status row emitted, no crash, no fabricated DDL', async () => {
    const db = new FakeAnalyzerDb({
      seqScanRows: [makeSeqScanRow({ table_name: 'events', relpages: 20_000, seq_scan: 3_000 })],
      pgStatStatementsAvailable: false,
    });
    const findings = await detector().detect(db as any);

    const status = findings.find(
      (f) => (f.evidence as { kind?: string }).kind === 'pg_stat_statements_status',
    );
    assert.ok(status, 'an explicit unavailable-status row is present');
    assert.equal((status!.evidence as { available: boolean }).available, false);
    assert.match(status!.recommendation, /not installed/);

    // Seq-scan advisory still produced; still no DDL anywhere.
    assert.ok(findings.some((f) => f.tableName === 'events'));
    assert.equal(
      findings.some((f) => f.recommendedDdl != null),
      false,
      'no CREATE INDEX DDL is fabricated when pg_stat_statements is missing',
    );
  });

  // ── 18. available + parseable single-col equality → heuristic DDL ─────

  await test('available pg_stat_statements + simple equality predicate → labelled heuristic DDL', async () => {
    const db = new FakeAnalyzerDb({
      seqScanRows: [makeSeqScanRow({ table_name: 'events', relpages: 20_000, seq_scan: 8_000 })],
      pgStatStatementsAvailable: true,
      pgStatStatementsRows: [
        { query: 'SELECT id, body FROM events WHERE tenant_id = $1 ORDER BY created_at DESC' },
      ],
    });
    const findings = await detector().detect(db as any);
    const adv = findings.find((f) => f.tableName === 'events')!;
    assert.equal((adv.evidence as { predicateColumn?: string }).predicateColumn, 'tenant_id');
    assert.match(adv.recommendation, /HEURISTIC ONLY/);
    assert.match(adv.recommendation, /EXPLAIN/);
    assert.ok(adv.recommendedDdl);
    assert.match(adv.recommendedDdl!, /^-- REVIEW REQUIRED:/m);
    assert.match(
      adv.recommendedDdl!,
      /CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_events_tenant_id" ON "public"\."events" \("tenant_id"\);/,
    );
  });

  // ── 19. available but complex predicate → skipped, not guessed ───────

  await test('a complex predicate (JOIN / OR / function) is skipped, never guessed', async () => {
    const db = new FakeAnalyzerDb({
      seqScanRows: [makeSeqScanRow({ table_name: 'events', relpages: 20_000, seq_scan: 8_000 })],
      pgStatStatementsAvailable: true,
      pgStatStatementsRows: [
        { query: 'SELECT * FROM events e JOIN users u ON u.id = e.user_id WHERE e.tenant_id = $1' },
        { query: 'SELECT * FROM events WHERE lower(name) = $1 OR status = $2' },
      ],
    });
    const findings = await detector().detect(db as any);
    const adv = findings.find((f) => f.tableName === 'events')!;
    assert.equal(adv.recommendedDdl, null, 'no DDL guessed from complex predicates');
    assert.match(adv.recommendation, /No DDL emitted/);
  });

  // ── predicate-parser unit checks (the heuristic's own boundaries) ────

  await test('extractSingleColumnEqualityPredicate: accepts / rejects the right shapes', () => {
    assert.deepEqual(
      extractSingleColumnEqualityPredicate('SELECT * FROM events WHERE tenant_id = $1'),
      { table: 'events', column: 'tenant_id' },
    );
    assert.equal(
      extractSingleColumnEqualityPredicate('SELECT * FROM a JOIN b ON a.id=b.id WHERE a.x = $1'),
      null,
      'JOIN → ambiguous → null',
    );
    assert.equal(
      extractSingleColumnEqualityPredicate('SELECT * FROM events WHERE a = $1 AND b = $2'),
      null,
      'multi-column equality → composite → null',
    );
    assert.equal(
      extractSingleColumnEqualityPredicate('SELECT * FROM events WHERE lower(name) = $1'),
      null,
      'function-wrapped → null',
    );
    assert.equal(
      extractSingleColumnEqualityPredicate('SELECT * FROM events WHERE id IN ($1, $2)'),
      null,
      'IN list → null',
    );
    assert.equal(
      extractSingleColumnEqualityPredicate('SELECT * FROM events WHERE a = $1 OR b = $2'),
      null,
      'OR → null',
    );
  });

  console.log(
    failures === 0
      ? '\nindex_health_missing: all passed'
      : `\nindex_health_missing: ${failures} FAILED`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
