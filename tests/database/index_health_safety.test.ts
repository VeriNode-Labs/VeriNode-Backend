/**
 * issue #197 — safety boundary (Gate 3): NO code path executes CREATE/DROP INDEX.
 *
 * These tests are meaningful, not decorative:
 *  - every statement the analyzer sends to the DB during a full run is captured
 *    and asserted to be SET/SELECT/WITH only, with no DDL keyword;
 *  - the analyzer's first statement is the READ ONLY barrier;
 *  - every generated `recommendedDdl` string is asserted never to have been
 *    sent to the DB;
 *  - a static scan of the subsystem source asserts no `query(...)` call is
 *    built around a CREATE/DROP INDEX literal, and that DDL builders are the
 *    only source of those strings.
 */

import { strict as assert } from 'assert';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { IndexHealthAnalyzer } from '../../src/database/index_health/analyzer';
import { persistIndexHealthRun } from '../../src/database/index_health/store';
import { MB, makeSeqScanRow, makeUnusedRow, RecordingDb } from './index_health_helpers';

const SRC_DIR = join(__dirname, '../../src/database/index_health');

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

/** Answers the analyzer's catalog queries with rows that maximise finding output. */
function catalogResponder(text: string): { rows: any[] } {
  if (/pg_stat_database/i.test(text)) {
    return {
      rows: [
        { stats_reset: new Date(Date.now() - 90 * 86_400_000).toISOString(), stats_age_days: '90' },
      ],
    };
  }
  if (/pg_stat_user_indexes/i.test(text)) {
    return {
      rows: [
        makeUnusedRow({ index_name: 'pk_x', idx_scan: 0, is_primary: true }),
        makeUnusedRow({
          index_name: 'idx_drop_me',
          table_name: 't',
          idx_scan: 1,
          index_bytes: 9 * MB,
        }),
        makeUnusedRow({ index_name: 'idx_fk', idx_scan: 0, supports_fk: true }),
      ],
    };
  }
  if (/pg_stat_user_tables/i.test(text)) {
    return { rows: [makeSeqScanRow({ table_name: 'events', relpages: 20_000, seq_scan: 9_000 })] };
  }
  if (/pg_extension WHERE extname = 'pg_stat_statements'/i.test(text)) {
    return { rows: [{ available: true }] };
  }
  if (/FROM pg_stat_statements/i.test(text)) {
    return {
      rows: [
        {
          query: 'SELECT * FROM events WHERE tenant_id = $1',
          calls: 1,
          mean_exec_time: 1,
          rows: 1,
        },
      ],
    };
  }
  return { rows: [] };
}

async function main(): Promise<void> {
  // ── 20. Every statement in a full run is read-only; no DDL keyword ────

  await test('no statement issued during analyze() is anything but SET/SELECT/WITH', async () => {
    const db = new RecordingDb(catalogResponder);
    await new IndexHealthAnalyzer({ db: db as any }).analyze('run-safety');

    assert.ok(db.statements.length > 3, 'the analyzer actually issued queries');
    for (const stmt of db.statements) {
      assert.match(
        stmt,
        /^\s*(SET|SELECT|WITH)\b/i,
        `statement is not read-only: ${stmt.slice(0, 60)}`,
      );
      assert.doesNotMatch(
        stmt,
        /\b(CREATE|DROP|ALTER|REINDEX|TRUNCATE|INSERT|UPDATE|DELETE|GRANT|COMMENT)\b/i,
        `statement contains a mutating keyword: ${stmt.slice(0, 80)}`,
      );
    }
  });

  // ── 21. The READ ONLY barrier is the first thing the analyzer does ───

  await test('analyze() opens with SET TRANSACTION READ ONLY', async () => {
    const db = new RecordingDb(catalogResponder);
    await new IndexHealthAnalyzer({ db: db as any }).analyze();
    assert.match(db.statements[0], /^\s*SET TRANSACTION READ ONLY\s*$/i);
  });

  // ── 22. Static source scan: DDL literals never wrapped in query() ────

  await test('no query()/client.query() call in the subsystem is built around a CREATE/DROP INDEX literal', () => {
    const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts'));
    const queryCallRe = /\.query\s*\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g;
    for (const file of files) {
      const src = readFileSync(join(SRC_DIR, file), 'utf8');
      let m: RegExpExecArray | null;
      while ((m = queryCallRe.exec(src)) !== null) {
        assert.doesNotMatch(
          m[1],
          /\b(CREATE|DROP)\s+INDEX\b/i,
          `${file}: a .query() call is built around DDL: ${m[1].slice(0, 60)}`,
        );
      }
    }
  });

  await test('executable CREATE/DROP INDEX statement strings originate only in ddl.ts', () => {
    const files = readdirSync(SRC_DIR).filter((f) => f.endsWith('.ts') && f !== 'ddl.ts');
    // The builders in ddl.ts are the only place an actual DDL *statement* is
    // assembled; its shape is unmistakable (CONCURRENTLY + IF [NOT] EXISTS).
    const ddlStatementRe = /(CREATE|DROP)\s+INDEX\s+CONCURRENTLY\s+IF\s+(NOT\s+)?EXISTS/i;
    for (const file of files) {
      const src = readFileSync(join(SRC_DIR, file), 'utf8');
      for (const lit of src.match(/(`[^`]*`|'[^']*'|"[^"]*")/g) ?? []) {
        assert.doesNotMatch(
          lit,
          ddlStatementRe,
          `${file}: DDL statement literal found outside ddl.ts: ${lit.slice(0, 60)}`,
        );
      }
    }
  });

  // ── 23. Generated DDL strings are never sent to the DB ──────────────

  await test('every recommendedDdl string is absent from the statements sent to the DB', async () => {
    const db = new RecordingDb(catalogResponder);
    const run = await new IndexHealthAnalyzer({ db: db as any }).analyze();
    const ddls = run.findings.map((f) => f.recommendedDdl).filter((s): s is string => !!s);
    assert.ok(ddls.length > 0, 'the run produced at least one DDL recommendation to check');
    for (const ddl of ddls) {
      assert.equal(
        db.statements.includes(ddl),
        false,
        'a recommended DDL string was passed to the database',
      );
      for (const stmt of db.statements) {
        assert.equal(stmt.includes(ddl), false, 'a recommended DDL string was embedded in a query');
      }
    }
  });

  // ── persistIndexHealthRun is INSERT-only ───────────────────────────

  await test('persistIndexHealthRun issues a single INSERT and no DDL', async () => {
    const db = new RecordingDb();
    await persistIndexHealthRun(db as any, {
      runId: 'r1',
      runAt: new Date(),
      findings: [
        {
          findingType: 'unused_index',
          schemaName: 'public',
          tableName: 't',
          indexName: 'i',
          scans30d: 0,
          sizeMb: 1,
          recommendation: 'x',
          recommendedDdl: 'DROP INDEX CONCURRENTLY IF EXISTS "public"."i";',
          exclusionReason: null,
          statsWindowDays: 40,
          evidence: {},
        },
      ],
    });
    assert.equal(db.statements.length, 1);
    assert.match(db.statements[0], /^INSERT INTO index_health_reports/);
    assert.doesNotMatch(db.statements[0], /\b(CREATE|DROP|ALTER)\b/i);
  });

  console.log(
    failures === 0
      ? '\nindex_health_safety: all passed'
      : `\nindex_health_safety: ${failures} FAILED`,
  );
  if (failures > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
