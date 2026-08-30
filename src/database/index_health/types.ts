/**
 * VeriNode Backend — DB Index Health Monitoring: shared types (issue #197)
 *
 * Every value the analyzer produces is an ADVISORY finding for human review.
 * `recommendedDdl` is a plain string generated for a DBA to read and run
 * manually — no code path in this subsystem executes CREATE/DROP INDEX.
 */

// ── Minimal DB handles (DI convention — see src/database/backup_verification.ts) ──

export interface Queryable {
  query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }>;
}

/**
 * A DB handle that can open a transaction. Structurally satisfied by
 * `src/config/database.ts::Database` (its `transaction` is a method, so the
 * `PoolClient` → `Queryable` parameter check is bivariant and passes).
 */
export interface TransactionCapable extends Queryable {
  transaction<T>(fn: (client: Queryable) => Promise<T>): Promise<T>;
}

// ── Findings ─────────────────────────────────────────────────────────────────

export type IndexHealthFindingType =
  'unused_index' | 'excluded_index' | 'missing_index' | 'stats_reset_warning';

export interface IndexHealthFinding {
  findingType: IndexHealthFindingType;
  schemaName: string;
  tableName: string;
  /** null for missing-index advisories and the stats-reset warning. */
  indexName: string | null;
  /** idx_scan count over the available statistics window. */
  scans30d: number | null;
  sizeMb: number | null;
  /** Human-readable explanation. Always present. */
  recommendation: string;
  /**
   * Suggested DDL for a DBA to review and run by hand. TEXT ONLY — never
   * executed. Null whenever emitting an actionable statement would be unsafe
   * (constraint-backing index, FK-supporting index, premature statistics
   * window, or an advisory with no unambiguous column).
   */
  recommendedDdl: string | null;
  /**
   * Why a low-usage index was deliberately NOT recommended for removal.
   * Surfaced in the report on purpose — "we looked and did not flag this"
   * is useful signal for a reviewer, not noise.
   */
  exclusionReason: string | null;
  /** Actual statistics window in days (from pg_stat_database.stats_reset). */
  statsWindowDays: number | null;
  evidence: Record<string, unknown>;
}

export interface IndexHealthRun {
  runId: string;
  runAt: Date;
  findings: IndexHealthFinding[];
}

// ── Thresholds / policy ──────────────────────────────────────────────────────

export interface IndexHealthThresholds {
  /** idx_scan strictly below this over the window → unused-index candidate. */
  maxScansForUnused: number;
  /**
   * Days of statistics history required before an unused-index finding is
   * given actionable DROP DDL. Below this the finding is annotated as
   * premature and `recommendedDdl` is withheld.
   */
  statsWindowDays: number;
  /** Table page count (relpages) above which sequential scans are a signal. */
  minTablePagesForSeqScan: number;
  /** Minimum seq_scan count before a large table is flagged. */
  minSeqScansToFlag: number;
  /** How many pg_stat_statements rows to sample for predicate hints. */
  pgStatStatementsSampleSize: number;
}

export const DEFAULT_INDEX_HEALTH_THRESHOLDS: IndexHealthThresholds = {
  maxScansForUnused: 10,
  statsWindowDays: 30,
  minTablePagesForSeqScan: 10_000,
  minSeqScansToFlag: 1_000,
  pgStatStatementsSampleSize: 200,
};

// ── Raw catalog row shapes (bigint columns arrive as strings from `pg`) ───────

export interface UnusedIndexCandidateRow {
  schema_name: string;
  table_name: string;
  index_name: string;
  idx_scan: string | number;
  last_idx_scan: string | Date | null;
  index_bytes: string | number;
  is_primary: boolean;
  is_unique: boolean;
  is_exclusion: boolean;
  is_replica_identity: boolean;
  is_valid: boolean;
  supports_fk: boolean;
}

export interface StatsResetRow {
  stats_reset: string | Date | null;
  stats_age_days: string | number | null;
}

export interface SeqScanTableRow {
  schema_name: string;
  table_name: string;
  seq_scan: string | number;
  seq_tup_read: string | number;
  idx_scan: string | number;
  relpages: number;
  reltuples: string | number;
  table_bytes: string | number;
}

export interface PgStatStatementsRow {
  query: string;
  calls: string | number;
  mean_exec_time: string | number;
  rows: string | number;
}
