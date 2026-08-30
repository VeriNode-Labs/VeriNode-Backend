/**
 * issue #197 — unused-index analyzer correctness guards (Gate 1).
 *
 * Every test here pins one specific guard. Test 1 (a PK index with idx_scan=0
 * is NEVER a removal candidate) is the single most important test in the PR:
 * a DBA must be able to trust that acting on this tool's output cannot drop an
 * index that backs a constraint.
 */

import { strict as assert } from 'assert';
import { IndexHealthAnalyzer } from '../../src/database/index_health/analyzer';
import { FakeAnalyzerDb, MB, makeUnusedRow } from './index_health_helpers';

let failures = 0;
async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  ✗ ${name}`);
    console.error(err);
  }
}

const analyzer = (db: FakeAnalyzerDb) => new IndexHealthAnalyzer({ db: db as any });

async function main(): Promise<void> {
  // ── 1. THE test: PK index, idx_scan=0, never a flagged removal candidate ──

  await test('a primary-key index with idx_scan=0 is NEVER flagged for removal', async () => {
    const db = new FakeAnalyzerDb({
      unusedIndexRows: [
        makeUnusedRow({
          index_name: 'reputations_pkey',
          table_name: 'reputations',
          idx_scan: 0,
          index_bytes: 5 * MB,
          is_primary: true,
          is_valid: true,
        }),
      ],
      statsResetDaysAgo: 90, // healthy window — the guard is NOT what protects the PK here
      seqScanRows: [],
      pgStatStatementsAvailable: false,
    });

    const run = await analyzer(db).analyze('run-pk-test');

    const pk = run.findings.filter((f) => f.indexName === 'reputations_pkey');
    assert.equal(pk.length, 1, 'the PK index produces exactly one finding');
    assert.equal(
      pk[0].findingType,
      'excluded_index',
      'a primary-key index is reported as excluded, never as a removal candidate',
    );
    assert.equal(pk[0].exclusionReason, 'primary key');
    assert.equal(
      pk[0].recommendedDdl,
      null,
      'no DROP DDL is ever generated for a primary-key index',
    );

    assert.equal(
      run.findings.some(
        (f) => f.findingType === 'unused_index' && f.indexName === 'reputations_pkey',
      ),
      false,
      'the PK index never appears as an unused_index finding',
    );
    assert.equal(
      run.findings.some((f) => (f.recommendedDdl ?? '').includes('reputations_pkey')),
      false,
      'no recommended DDL string anywhere in the run references the PK index',
    );
    assert.equal(
      run.findings.some((f) => /DROP\s+INDEX/i.test(f.recommendedDdl ?? '')),
      false,
      'this run emits no DROP INDEX DDL at all',
    );
  });

  // ── 2–5. Other constraint-backing / invalid indexes: excluded, no DDL ─────

  await test('a UNIQUE index with idx_scan=0 is excluded, not a candidate', async () => {
    const db = new FakeAnalyzerDb({
      unusedIndexRows: [makeUnusedRow({ index_name: 'u_email', idx_scan: 0, is_unique: true })],
      statsResetDaysAgo: 90,
    });
    const run = await analyzer(db).analyze();
    const f = run.findings.find((x) => x.indexName === 'u_email')!;
    assert.equal(f.findingType, 'excluded_index');
    assert.match(f.exclusionReason ?? '', /unique/);
    assert.equal(f.recommendedDdl, null);
  });

  await test('an EXCLUSION-constraint index with idx_scan=0 is excluded, no DDL', async () => {
    const db = new FakeAnalyzerDb({
      unusedIndexRows: [makeUnusedRow({ index_name: 'ex_range', idx_scan: 0, is_exclusion: true })],
      statsResetDaysAgo: 90,
    });
    const run = await analyzer(db).analyze();
    const f = run.findings.find((x) => x.indexName === 'ex_range')!;
    assert.equal(f.findingType, 'excluded_index');
    assert.match(f.exclusionReason ?? '', /exclusion/);
    assert.equal(f.recommendedDdl, null);
  });

  await test('a REPLICA IDENTITY index with idx_scan=0 is excluded, no DDL', async () => {
    const db = new FakeAnalyzerDb({
      unusedIndexRows: [
        makeUnusedRow({ index_name: 'ri_idx', idx_scan: 0, is_replica_identity: true }),
      ],
      statsResetDaysAgo: 90,
    });
    const run = await analyzer(db).analyze();
    const f = run.findings.find((x) => x.indexName === 'ri_idx')!;
    assert.equal(f.findingType, 'excluded_index');
    assert.match(f.exclusionReason ?? '', /replica identity/);
    assert.equal(f.recommendedDdl, null);
  });

  await test('an INVALID index is never surfaced as a plain "unused, drop it" finding', async () => {
    const db = new FakeAnalyzerDb({
      unusedIndexRows: [makeUnusedRow({ index_name: 'half_built', idx_scan: 0, is_valid: false })],
      statsResetDaysAgo: 90,
    });
    const run = await analyzer(db).analyze();
    const f = run.findings.find((x) => x.indexName === 'half_built')!;
    assert.equal(f.findingType, 'excluded_index');
    assert.match(f.exclusionReason ?? '', /invalid|INVALID/);
    assert.equal(f.recommendedDdl, null);
  });

  // ── 6. A genuinely unused non-constraint btree IS flagged, with DDL ───────

  await test('a genuinely unused non-constraint index IS flagged with DROP DDL', async () => {
    const db = new FakeAnalyzerDb({
      unusedIndexRows: [
        makeUnusedRow({
          schema_name: 'public',
          table_name: 'audit_log',
          index_name: 'idx_audit_log_old_col',
          idx_scan: 3,
          index_bytes: 40 * MB,
        }),
      ],
      statsResetDaysAgo: 60,
    });
    const run = await analyzer(db).analyze();
    const f = run.findings.find((x) => x.indexName === 'idx_audit_log_old_col')!;
    assert.equal(f.findingType, 'unused_index');
    assert.equal(f.exclusionReason, null);
    assert.ok(f.recommendedDdl, 'a DROP DDL string is generated');
    assert.match(f.recommendedDdl!, /^-- REVIEW REQUIRED:/m, 'DDL carries the review marker');
    assert.match(
      f.recommendedDdl!,
      /DROP INDEX CONCURRENTLY IF EXISTS "public"\."idx_audit_log_old_col";/,
    );
    assert.equal(f.sizeMb, 40);
    assert.equal(f.scans30d, 3);
  });

  // ── 7. At/above the scan threshold → not flagged at all ─────────────────

  await test('an index with idx_scan >= threshold produces no finding', async () => {
    const db = new FakeAnalyzerDb({
      unusedIndexRows: [makeUnusedRow({ index_name: 'idx_hot', idx_scan: 50 })],
      statsResetDaysAgo: 60,
    });
    const run = await analyzer(db).analyze();
    assert.equal(
      run.findings.some((f) => f.indexName === 'idx_hot'),
      false,
    );
  });

  // ── 8. FK-supporting index: flagged with strong caution, DDL withheld ───

  await test('an unused FK-supporting index is flagged with caution and NO DDL', async () => {
    const db = new FakeAnalyzerDb({
      unusedIndexRows: [
        makeUnusedRow({
          table_name: 'validator_stakes',
          index_name: 'idx_validator_stakes_pool_id',
          idx_scan: 0,
          supports_fk: true,
        }),
      ],
      statsResetDaysAgo: 90,
    });
    const run = await analyzer(db).analyze();
    const f = run.findings.find((x) => x.indexName === 'idx_validator_stakes_pool_id')!;
    assert.equal(f.findingType, 'unused_index');
    assert.equal(f.recommendedDdl, null, 'DDL is withheld for FK-supporting indexes');
    assert.match(f.exclusionReason ?? '', /foreign key/i);
    assert.match(f.recommendation, /lock contention|parent table/i);
  });

  // ── 9–11. Stale-statistics guard (4b) ─────────────────────────────────

  await test('stats reset 5 days ago → candidate visible but DDL withheld + warning row', async () => {
    const db = new FakeAnalyzerDb({
      unusedIndexRows: [
        makeUnusedRow({ table_name: 'audit_log', index_name: 'idx_audit_recent', idx_scan: 2 }),
      ],
      statsResetDaysAgo: 5,
    });
    const run = await analyzer(db).analyze();

    const warning = run.findings.find((f) => f.findingType === 'stats_reset_warning');
    assert.ok(warning, 'a stats_reset_warning row is emitted');
    assert.match(warning!.recommendation, /PREMATURE/);

    const f = run.findings.find((x) => x.indexName === 'idx_audit_recent')!;
    assert.equal(f.findingType, 'unused_index');
    assert.equal(f.recommendedDdl, null, 'no DROP DDL while the stats window is premature');
    assert.equal((f.evidence as { premature?: boolean }).premature, true);
    assert.equal(
      run.findings.some((x) => /DROP\s+INDEX/i.test(x.recommendedDdl ?? '')),
      false,
      'the whole run emits no DROP DDL when statistics are premature',
    );
  });

  await test('stats reset 45 days ago → guard does not fire, DDL emitted normally', async () => {
    const db = new FakeAnalyzerDb({
      unusedIndexRows: [
        makeUnusedRow({ table_name: 'audit_log', index_name: 'idx_audit_old', idx_scan: 1 }),
      ],
      statsResetDaysAgo: 45,
    });
    const run = await analyzer(db).analyze();
    assert.equal(
      run.findings.some((f) => f.findingType === 'stats_reset_warning'),
      false,
    );
    const f = run.findings.find((x) => x.indexName === 'idx_audit_old')!;
    assert.ok(f.recommendedDdl && /DROP INDEX CONCURRENTLY/.test(f.recommendedDdl));
  });

  await test('stats_reset IS NULL → treated as premature (conservative), DDL withheld', async () => {
    const db = new FakeAnalyzerDb({
      unusedIndexRows: [makeUnusedRow({ index_name: 'idx_x', idx_scan: 0 })],
      statsResetDaysAgo: null,
    });
    const run = await analyzer(db).analyze();
    const warning = run.findings.find((f) => f.findingType === 'stats_reset_warning');
    assert.ok(warning);
    assert.match(warning!.recommendation, /NULL/);
    const f = run.findings.find((x) => x.indexName === 'idx_x')!;
    assert.equal(f.recommendedDdl, null);
  });

  // ── 12. size_mb / scans_30d derived correctly on a flagged row ─────────

  await test('size_mb and scans_30d are derived from index_bytes and idx_scan', async () => {
    const db = new FakeAnalyzerDb({
      unusedIndexRows: [
        makeUnusedRow({
          index_name: 'idx_sz',
          idx_scan: 7,
          index_bytes: String(3 * MB + 512 * 1024),
        }),
      ],
      statsResetDaysAgo: 60,
    });
    const run = await analyzer(db).analyze();
    const f = run.findings.find((x) => x.indexName === 'idx_sz')!;
    assert.equal(f.scans30d, 7);
    assert.equal(f.sizeMb, 3.5);
  });

  console.log(
    failures === 0
      ? '\nindex_health_analyzer: all passed'
      : `\nindex_health_analyzer: ${failures} FAILED`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
