/**
 * VeriNode Backend — DB Index Health Monitoring: missing-index detector (issue #197)
 *
 * Two independent signals, deliberately kept separate:
 *
 *  1. Sequential-scan signal (ALWAYS available). Tables whose page count is
 *     over the threshold and that are being sequentially scanned often are
 *     surfaced as advisories with NO column and NO DDL — page-level stats say
 *     nothing about *which* column is filtered.
 *
 *  2. Predicate-hint signal (ONLY when pg_stat_statements is installed).
 *     A text-based heuristic scan of normalized query text. It emits a
 *     CREATE INDEX *string* only for an unambiguous single-column equality
 *     predicate on a single-table query, and always labels the result a
 *     heuristic to be confirmed with EXPLAIN.
 *
 * Known failure modes of the predicate heuristic (documented, not hidden):
 *   - normalized text uses `$1` placeholders → no selectivity information;
 *   - queries with JOINs are skipped (column attribution is ambiguous);
 *   - `OR`, `IN (subquery)`, and function-wrapped predicates (`lower(col)`)
 *     are skipped rather than guessed;
 *   - multi-column equality → skipped (composite / ordering needs a human);
 *   - pg_stat_statements is size-capped and aggregates, so absence of a
 *     pattern is not absence of the query.
 */

import { StructuredLogger, createLogger } from '../../diagnostics/logger';
import { buildCreateIndexDdl } from './ddl';
import {
  DEFAULT_INDEX_HEALTH_THRESHOLDS,
  IndexHealthFinding,
  IndexHealthThresholds,
  PgStatStatementsRow,
  Queryable,
  SeqScanTableRow,
} from './types';

// ── SQL (SELECT-only; parameterized) ─────────────────────────────────────────

/** Large tables taking frequent sequential scans. relpages/seq_scan thresholds are parameters. */
export const Q_SEQ_SCAN_TABLES = `
  SELECT
    psut.schemaname              AS schema_name,
    psut.relname                 AS table_name,
    psut.seq_scan                AS seq_scan,
    psut.seq_tup_read            AS seq_tup_read,
    psut.idx_scan                AS idx_scan,
    c.relpages                   AS relpages,
    c.reltuples                  AS reltuples,
    pg_relation_size(psut.relid) AS table_bytes
  FROM pg_stat_user_tables psut
  JOIN pg_class c ON c.oid = psut.relid
  WHERE psut.schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
    AND c.relpages > $1
    AND psut.seq_scan > $2
  ORDER BY psut.seq_scan DESC
`;

/** Runtime probe: is the extension actually installed on this database? */
export const Q_PGSS_AVAILABLE = `
  SELECT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'
  ) AS available
`;

/** Sample of the heaviest statements that carry a WHERE clause. */
export const Q_PGSS_PREDICATE_SAMPLE = `
  SELECT query, calls, mean_exec_time, rows
  FROM pg_stat_statements
  WHERE query ILIKE '%where%'
  ORDER BY total_exec_time DESC
  LIMIT $1
`;

// ── Helpers ──────────────────────────────────────────────────────────────────

function toInt(value: string | number | null | undefined): number {
  if (typeof value === 'number') return Math.trunc(value);
  const n = parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : 0;
}

function bytesToMb(value: string | number): number {
  return Math.round((toInt(value) / (1024 * 1024)) * 100) / 100;
}

const SQL_KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'null',
  'is',
  'in',
  'like',
  'ilike',
  'between',
  'exists',
  'true',
  'false',
  'select',
  'from',
  'where',
  'group',
  'order',
  'limit',
  'by',
]);

export interface PredicateHint {
  table: string;
  column: string;
}

/**
 * Extract a single-column equality predicate from one normalized query string,
 * or return null when the query is anything the heuristic cannot safely reason
 * about. Conservative by construction — every uncertain case returns null.
 */
export function extractSingleColumnEqualityPredicate(queryText: string): PredicateHint | null {
  if (!queryText) return null;
  const sql = queryText.toLowerCase().replace(/\s+/g, ' ').trim();

  // JOINs make bare column names ambiguous — do not guess.
  if (/\bjoin\b/.test(sql)) return null;

  // Identify the single target table (FROM ... or UPDATE ...).
  const fromMatch = sql.match(/\bfrom\s+([a-z_][a-z0-9_$]*)\b/);
  const updateMatch = sql.match(/\bupdate\s+([a-z_][a-z0-9_$]*)\b/);
  const table = fromMatch?.[1] ?? updateMatch?.[1];
  if (!table) return null;
  // A second FROM/comma-join table → ambiguous.
  if (/\bfrom\s+[a-z_][a-z0-9_$]*\s*,/.test(sql)) return null;

  // Isolate the WHERE clause.
  const whereMatch = sql.match(
    /\bwhere\b(.*?)(?:\bgroup\b|\border\b|\blimit\b|\breturning\b|\bhaving\b|\bfor\s+update\b|$)/,
  );
  const where = whereMatch?.[1]?.trim();
  if (!where) return null;

  // Bail on constructs the heuristic must not interpret.
  if (/\bor\b/.test(where)) return null;
  if (/[a-z_][a-z0-9_$]*\s*\(/.test(where)) return null; // function call on either side
  if (/\bin\b\s*\(/.test(where)) return null;

  // Collect `col = value` equality predicates.
  const eqRe = /([a-z_][a-z0-9_$.]*)\s*=\s*(\$\d+|\d+(?:\.\d+)?|'[^']*'|true|false)/g;
  const columns = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = eqRe.exec(where)) !== null) {
    let ident = m[1];
    if (ident.includes('.')) {
      const [, col] = ident.split('.');
      ident = col;
    }
    if (SQL_KEYWORDS.has(ident)) continue;
    columns.add(ident);
  }

  if (columns.size !== 1) return null; // zero, or multi-column (composite) → human call
  return { table, column: [...columns][0] };
}

// ── MissingIndexDetector ─────────────────────────────────────────────────────

export class MissingIndexDetector {
  private readonly thresholds: IndexHealthThresholds;
  private readonly log: StructuredLogger;

  constructor(thresholds?: Partial<IndexHealthThresholds>, logger?: StructuredLogger) {
    this.thresholds = { ...DEFAULT_INDEX_HEALTH_THRESHOLDS, ...thresholds };
    this.log = logger ?? createLogger('index-health:missing');
  }

  async detect(db: Queryable): Promise<IndexHealthFinding[]> {
    const seqRows = (
      await db.query(Q_SEQ_SCAN_TABLES, [
        this.thresholds.minTablePagesForSeqScan,
        this.thresholds.minSeqScansToFlag,
      ])
    ).rows as SeqScanTableRow[];

    const available = await this.probePgStatStatements(db);
    const hints = available ? await this.collectPredicateHints(db) : new Map<string, string[]>();
    const samples = available ? this.sampleQueries : new Map<string, string>();

    const findings: IndexHealthFinding[] = [];

    for (const row of seqRows) {
      const seqScan = toInt(row.seq_scan);
      const relpages = toInt(row.relpages);
      const candidateColumns = hints.get(row.table_name) ?? [];
      const evidence: Record<string, unknown> = {
        kind: 'seq_scan',
        seqScan,
        seqTupRead: toInt(row.seq_tup_read),
        idxScan: toInt(row.idx_scan),
        relpages,
        tableBytes: toInt(row.table_bytes),
        pgStatStatements: available ? 'available' : 'unavailable',
      };

      let recommendation: string;
      let recommendedDdl: string | null = null;

      if (available && candidateColumns.length === 1) {
        const column = candidateColumns[0];
        evidence.predicateColumn = column;
        evidence.predicateSource = 'pg_stat_statements_heuristic';
        const sample = samples.get(`${row.table_name}::${column}`);
        if (sample) evidence.sampleQuery = sample;
        recommendation =
          `Table "${row.table_name}" was sequentially scanned ${seqScan} times over ` +
          `${relpages} pages (> ${this.thresholds.minTablePagesForSeqScan}). A heuristic scan of ` +
          `pg_stat_statements associated a single-column equality predicate on "${column}" with ` +
          `this table. HEURISTIC ONLY: normalized query text carries no selectivity information — ` +
          `confirm with EXPLAIN (ANALYZE, BUFFERS) on the real query before creating any index.`;
        recommendedDdl = buildCreateIndexDdl(row.schema_name, row.table_name, column);
      } else {
        let note: string;
        if (!available) {
          note = 'pg_stat_statements is not installed, so no filter column could be identified';
        } else if (candidateColumns.length === 0) {
          note =
            'no unambiguous single-column equality predicate for this table was found in the ' +
            'pg_stat_statements sample (JOINs, OR, IN, and function-wrapped predicates are skipped, ' +
            'not guessed)';
        } else {
          note =
            `multiple candidate predicate columns (${candidateColumns.join(', ')}) — the composite ` +
            `and column-ordering choice needs a human`;
        }
        recommendation =
          `Table "${row.table_name}" was sequentially scanned ${seqScan} times over ${relpages} ` +
          `pages (> ${this.thresholds.minTablePagesForSeqScan}). ${note}. No DDL emitted: ` +
          `investigate the workload against this table and add an index only after confirming the ` +
          `predicate with EXPLAIN.`;
      }

      findings.push({
        findingType: 'missing_index',
        schemaName: row.schema_name,
        tableName: row.table_name,
        indexName: null,
        scans30d: null,
        sizeMb: bytesToMb(row.table_bytes),
        recommendation,
        recommendedDdl,
        exclusionReason: null,
        statsWindowDays: null,
        evidence,
      });
    }

    if (!available) {
      // Graceful degradation: an explicit, unmistakable status row rather than
      // a silent empty result or a fabricated recommendation.
      findings.push({
        findingType: 'missing_index',
        schemaName: '-',
        tableName: '-',
        indexName: null,
        scans30d: null,
        sizeMb: null,
        recommendation:
          'pg_stat_statements is not installed on this database, so query-pattern analysis was ' +
          'skipped entirely. Any sequential-scan findings above are page-level only and name no ' +
          'column. To enable predicate hints, add pg_stat_statements to shared_preload_libraries ' +
          'and restart PostgreSQL.',
        recommendedDdl: null,
        exclusionReason: null,
        statsWindowDays: null,
        evidence: { kind: 'pg_stat_statements_status', available: false },
      });
      this.log.warn(
        'missing-index detector: pg_stat_statements unavailable, query-pattern analysis skipped',
      );
    }

    return findings;
  }

  private async probePgStatStatements(db: Queryable): Promise<boolean> {
    try {
      const rows = (await db.query(Q_PGSS_AVAILABLE)).rows as Array<{ available: boolean }>;
      return rows[0]?.available === true;
    } catch {
      // A restricted role can be denied access to pg_extension in some setups —
      // treat any failure as "unavailable" and degrade, never throw.
      return false;
    }
  }

  /** (table name) → distinct candidate columns. Populates `sampleQueries` as a side effect. */
  private sampleQueries = new Map<string, string>();

  private async collectPredicateHints(db: Queryable): Promise<Map<string, string[]>> {
    this.sampleQueries = new Map<string, string>();
    const byTable = new Map<string, Set<string>>();
    let sampled = 0;
    let skippedComplex = 0;

    try {
      const rows = (
        await db.query(Q_PGSS_PREDICATE_SAMPLE, [this.thresholds.pgStatStatementsSampleSize])
      ).rows as PgStatStatementsRow[];

      for (const row of rows) {
        sampled += 1;
        const hint = extractSingleColumnEqualityPredicate(row.query);
        if (!hint) {
          skippedComplex += 1;
          continue;
        }
        if (!byTable.has(hint.table)) byTable.set(hint.table, new Set());
        byTable.get(hint.table)!.add(hint.column);
        const key = `${hint.table}::${hint.column}`;
        if (!this.sampleQueries.has(key)) this.sampleQueries.set(key, row.query);
      }
    } catch (err) {
      this.log.warn('missing-index detector: pg_stat_statements sample query failed', err as Error);
      return new Map();
    }

    this.log.info('missing-index detector: predicate hint scan complete', {
      sampled,
      skipped_complex: skippedComplex,
      tables_with_hints: byTable.size,
    });

    const out = new Map<string, string[]>();
    for (const [table, cols] of byTable) out.set(table, [...cols].sort());
    return out;
  }
}
