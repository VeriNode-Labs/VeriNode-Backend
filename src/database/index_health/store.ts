/**
 * VeriNode Backend — DB Index Health Monitoring: persistence (issue #197)
 *
 * INSERT + SELECT only. This module never issues DDL. It writes the analyzer's
 * findings to `index_health_reports` (migration 015) and reads back the most
 * recent run for the API.
 */

import { IndexHealthFinding, IndexHealthFindingType, IndexHealthRun, Queryable } from './types';

const INSERT_COLUMNS =
  '(run_id, run_at, finding_type, schema_name, table_name, index_name, ' +
  'scans_30d, size_mb, recommendation, recommended_ddl, exclusion_reason, ' +
  'stats_window_days, evidence)';

const SELECT_LATEST_RUN_SQL = `
  SELECT run_id, run_at, finding_type, schema_name, table_name, index_name,
         scans_30d, size_mb, recommendation, recommended_ddl, exclusion_reason,
         stats_window_days, evidence
  FROM index_health_reports
  WHERE run_id = (
    SELECT run_id FROM index_health_reports ORDER BY run_at DESC, id DESC LIMIT 1
  )
  ORDER BY
    CASE finding_type
      WHEN 'stats_reset_warning' THEN 0
      WHEN 'unused_index'        THEN 1
      WHEN 'excluded_index'      THEN 2
      WHEN 'missing_index'       THEN 3
      ELSE 4
    END,
    size_mb DESC NULLS LAST,
    id ASC
`;

interface IndexHealthRow {
  run_id: string;
  run_at: string | Date;
  finding_type: IndexHealthFindingType;
  schema_name: string;
  table_name: string;
  index_name: string | null;
  scans_30d: string | number | null;
  size_mb: string | number | null;
  recommendation: string;
  recommended_ddl: string | null;
  exclusion_reason: string | null;
  stats_window_days: number | null;
  evidence: Record<string, unknown> | string | null;
}

/**
 * Persist one analyzer run as one row per finding. A single multi-row INSERT
 * (uptime_queries batch idiom) so the run lands atomically.
 */
export async function persistIndexHealthRun(db: Queryable, run: IndexHealthRun): Promise<void> {
  if (run.findings.length === 0) return;

  const values: any[] = [];
  const rowPlaceholders: string[] = [];
  let i = 1;

  for (const f of run.findings) {
    rowPlaceholders.push(
      `($${i}, $${i + 1}, $${i + 2}, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}, ` +
        `$${i + 7}, $${i + 8}, $${i + 9}, $${i + 10}, $${i + 11}, $${i + 12}::jsonb)`,
    );
    values.push(
      run.runId,
      run.runAt,
      f.findingType,
      f.schemaName,
      f.tableName,
      f.indexName,
      f.scans30d,
      f.sizeMb,
      f.recommendation,
      f.recommendedDdl,
      f.exclusionReason,
      f.statsWindowDays,
      JSON.stringify(f.evidence ?? {}),
    );
    i += 13;
  }

  await db.query(
    `INSERT INTO index_health_reports ${INSERT_COLUMNS} VALUES ${rowPlaceholders.join(', ')}`,
    values,
  );
}

function rowToFinding(row: IndexHealthRow): IndexHealthFinding {
  let evidence: Record<string, unknown> = {};
  if (row.evidence && typeof row.evidence === 'object') {
    evidence = row.evidence as Record<string, unknown>;
  } else if (typeof row.evidence === 'string') {
    try {
      evidence = JSON.parse(row.evidence);
    } catch {
      evidence = {};
    }
  }
  return {
    findingType: row.finding_type,
    schemaName: row.schema_name,
    tableName: row.table_name,
    indexName: row.index_name,
    scans30d: row.scans_30d == null ? null : Number(row.scans_30d),
    sizeMb: row.size_mb == null ? null : Number(row.size_mb),
    recommendation: row.recommendation,
    recommendedDdl: row.recommended_ddl,
    exclusionReason: row.exclusion_reason,
    statsWindowDays: row.stats_window_days,
    evidence,
  };
}

/** The most recent analyzer run, reconstructed from its rows, or null if none. */
export async function getLatestIndexHealthRun(db: Queryable): Promise<IndexHealthRun | null> {
  const rows = (await db.query(SELECT_LATEST_RUN_SQL)).rows as IndexHealthRow[];
  if (rows.length === 0) return null;
  const first = rows[0];
  return {
    runId: first.run_id,
    runAt: first.run_at instanceof Date ? first.run_at : new Date(first.run_at),
    findings: rows.map(rowToFinding),
  };
}
