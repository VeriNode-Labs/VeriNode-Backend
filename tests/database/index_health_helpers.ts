/**
 * Shared fakes for the index-health test suite (issue #197).
 *
 * Not a *.test.ts file, so the shard runner does not execute it directly — it
 * is imported by the four index_health_*.test.ts files. CI runs with no
 * PostgreSQL, so every catalog query is answered from canned rows here.
 */

import type {
  SeqScanTableRow,
  UnusedIndexCandidateRow,
} from '../../src/database/index_health/types';

export const MB = 1024 * 1024;

export function makeUnusedRow(
  overrides: Partial<UnusedIndexCandidateRow> = {},
): UnusedIndexCandidateRow {
  return {
    schema_name: 'public',
    table_name: 'widgets',
    index_name: 'idx_widgets_something',
    idx_scan: 0,
    last_idx_scan: null,
    index_bytes: 4 * MB,
    is_primary: false,
    is_unique: false,
    is_exclusion: false,
    is_replica_identity: false,
    is_valid: true,
    supports_fk: false,
    ...overrides,
  };
}

export function makeSeqScanRow(overrides: Partial<SeqScanTableRow> = {}): SeqScanTableRow {
  return {
    schema_name: 'public',
    table_name: 'events',
    seq_scan: 5000,
    seq_tup_read: 50_000_000,
    idx_scan: 10,
    relpages: 12_000,
    reltuples: 4_000_000,
    table_bytes: 120 * MB,
    ...overrides,
  };
}

export interface FakeAnalyzerDbConfig {
  unusedIndexRows?: UnusedIndexCandidateRow[];
  /** Days since pg_stat_reset; null models a NULL stats_reset. */
  statsResetDaysAgo?: number | null;
  seqScanRows?: SeqScanTableRow[];
  pgStatStatementsAvailable?: boolean;
  pgStatStatementsRows?: Array<{
    query: string;
    calls?: number;
    mean_exec_time?: number;
    rows?: number;
  }>;
}

/**
 * Minimal TransactionCapable fake. Dispatches on SQL text. Simulates the
 * server-side WHERE of the sequential-scan query using the params it is
 * handed, so tests can prove the analyzer passes the thresholds correctly.
 */
export class FakeAnalyzerDb {
  readonly statements: string[] = [];
  readonly calls: Array<{ text: string; params?: any[] }> = [];

  constructor(private readonly cfg: FakeAnalyzerDbConfig = {}) {}

  async transaction<T>(fn: (client: FakeAnalyzerDb) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }> {
    this.statements.push(text);
    this.calls.push({ text, params });

    if (/SET TRANSACTION READ ONLY/i.test(text)) return { rows: [] };

    if (/pg_stat_database/i.test(text)) {
      const days = this.cfg.statsResetDaysAgo;
      if (days == null) return { rows: [{ stats_reset: null, stats_age_days: null }] };
      const resetAt = new Date(Date.now() - days * 86_400_000);
      return { rows: [{ stats_reset: resetAt.toISOString(), stats_age_days: String(days) }] };
    }

    if (/pg_stat_user_indexes/i.test(text)) {
      return { rows: [...(this.cfg.unusedIndexRows ?? [])] };
    }

    if (/pg_stat_user_tables/i.test(text)) {
      const minPages = Number(params?.[0] ?? 0);
      const minSeq = Number(params?.[1] ?? 0);
      const rows = (this.cfg.seqScanRows ?? []).filter(
        (r) => Number(r.relpages) > minPages && Number(r.seq_scan) > minSeq,
      );
      return { rows };
    }

    if (/pg_extension WHERE extname = 'pg_stat_statements'/i.test(text)) {
      return { rows: [{ available: this.cfg.pgStatStatementsAvailable === true }] };
    }

    if (/FROM pg_stat_statements/i.test(text)) {
      return {
        rows: (this.cfg.pgStatStatementsRows ?? []).map((r) => ({
          query: r.query,
          calls: r.calls ?? 1,
          mean_exec_time: r.mean_exec_time ?? 1,
          rows: r.rows ?? 1,
        })),
      };
    }

    // Persistence path — accept the analyzer's own writes/reads so the monitor
    // can be exercised end to end. These are not catalog queries.
    if (/^\s*INSERT INTO index_health_reports/i.test(text)) return { rows: [], rowCount: 0 };
    if (/SELECT run_id, run_at/i.test(text)) return { rows: [] };

    throw new Error(`FakeAnalyzerDb: unexpected query: ${text.slice(0, 80)}`);
  }
}

/**
 * Records every SQL string it is asked to run. `responder` supplies rows for
 * SELECTs; SET/other statements return empty. Used by the safety-boundary tests.
 */
export class RecordingDb {
  readonly statements: string[] = [];

  constructor(
    private readonly responder: (text: string, params?: any[]) => { rows: any[] } = () => ({
      rows: [],
    }),
  ) {}

  async transaction<T>(fn: (client: RecordingDb) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async query(text: string, params?: any[]): Promise<{ rows: any[]; rowCount?: number | null }> {
    this.statements.push(text);
    if (/^\s*SET\b/i.test(text)) return { rows: [] };
    return this.responder(text, params);
  }
}
