/**
 * VeriNode Backend — DB Index Health Monitoring: unused-index analyzer (issue #197)
 *
 * The highest-confidence half of the feature. Reads `pg_stat_user_indexes`
 * joined against `pg_index` and applies four correctness guards before any
 * index is surfaced as a removal candidate:
 *
 *  4a. PK / unique / exclusion / replica-identity / INVALID indexes are NEVER
 *      removal candidates, regardless of idx_scan. They back a correctness or
 *      replication guarantee, not query performance. They are reported as
 *      `excluded_index` (with the reason) only when their scan count is low
 *      enough that a naive tool would have flagged them — so the report shows
 *      "we checked and deliberately did not flag this".
 *
 *  4b. Stale-statistics guard. `idx_scan` resets on pg_stat_reset() / major
 *      upgrade / crash recovery. If pg_stat_database.stats_reset is within the
 *      policy window (or NULL), unused-index findings are annotated PREMATURE
 *      and `recommendedDdl` is withheld — the DBA still sees the cluster-wide
 *      "stats were reset" signal but cannot act on a premature DROP.
 *
 *  4c. FK-supporting indexes (leading columns match a FOREIGN KEY's columns)
 *      are flagged with a strong caution and `recommendedDdl` is withheld.
 *      idx_scan does not count the internal lookups PostgreSQL performs to
 *      enforce an FK on parent-row UPDATE/DELETE, so a "0 scans" reading here
 *      is misleading and dropping the index risks parent-table lock contention.
 *
 *      KNOWN GAP (named, not buried): the FK match is a leading-column PREFIX
 *      match of pg_index.indkey against pg_constraint.conkey. A composite index
 *      whose FK columns are NOT leftmost will NOT be detected as FK-supporting
 *      and could be recommended for removal. A reviewer acting on an
 *      `unused_index` finding for a composite index must still check
 *      pg_constraint by hand.
 *
 *  4d. Missing-index detection is delegated to MissingIndexDetector, which is
 *      text-heuristic + graceful-degradation only (see that file).
 *
 * SAFETY BOUNDARY: `analyze()` runs the entire pass inside a single
 * `SET TRANSACTION READ ONLY` transaction. No code path here executes DDL;
 * the read-only barrier makes an accidental one a PostgreSQL error, not a
 * schema mutation.
 */

import { randomUUID } from 'crypto';

import { StructuredLogger, createLogger } from '../../diagnostics/logger';
import { buildDropIndexDdl } from './ddl';
import { MissingIndexDetector } from './missing_index_detector';
import {
  DEFAULT_INDEX_HEALTH_THRESHOLDS,
  IndexHealthFinding,
  IndexHealthRun,
  IndexHealthThresholds,
  Queryable,
  StatsResetRow,
  TransactionCapable,
  UnusedIndexCandidateRow,
} from './types';

// ── SQL (SELECT-only) ────────────────────────────────────────────────────────

/**
 * One row per user index, with the flags the guards need.
 *
 * `supports_fk` is a leading-column PREFIX match: the FK's `conkey` array must
 * equal the first N entries of this index's `indkey`. See the KNOWN GAP note in
 * the file header.
 */
export const Q_UNUSED_INDEX_CANDIDATES = `
  SELECT
    psui.schemaname                   AS schema_name,
    psui.relname                      AS table_name,
    psui.indexrelname                 AS index_name,
    psui.idx_scan                     AS idx_scan,
    psui.last_idx_scan                AS last_idx_scan,
    pg_relation_size(psui.indexrelid) AS index_bytes,
    i.indisprimary                    AS is_primary,
    i.indisunique                     AS is_unique,
    i.indisexclusion                  AS is_exclusion,
    i.indisreplident                  AS is_replica_identity,
    i.indisvalid                      AS is_valid,
    EXISTS (
      SELECT 1
      FROM pg_constraint c
      WHERE c.contype = 'f'
        AND c.conrelid = i.indrelid
        AND (string_to_array(i.indkey::text, ' ')::int2[])[1:array_length(c.conkey, 1)] = c.conkey
    )                                 AS supports_fk
  FROM pg_stat_user_indexes psui
  JOIN pg_index i ON i.indexrelid = psui.indexrelid
  WHERE psui.schemaname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
  ORDER BY pg_relation_size(psui.indexrelid) DESC
`;

/** Age of the current database's cumulative statistics (the 4b guard input). */
export const Q_STATS_RESET = `
  SELECT
    stats_reset,
    EXTRACT(EPOCH FROM (now() - stats_reset)) / 86400.0 AS stats_age_days
  FROM pg_stat_database
  WHERE datname = current_database()
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

function toIso(value: string | Date | null): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function indexFlags(row: UnusedIndexCandidateRow): Record<string, unknown> {
  return {
    isPrimary: row.is_primary,
    isUnique: row.is_unique,
    isExclusion: row.is_exclusion,
    isReplicaIdentity: row.is_replica_identity,
    isValid: row.is_valid,
    supportsFk: row.supports_fk,
  };
}

/**
 * 4a: the hard exclusions. Returns a human-readable reason when the index must
 * NEVER be a removal candidate, or null when it is eligible for usage analysis.
 */
export function constraintExclusionReason(row: UnusedIndexCandidateRow): string | null {
  if (!row.is_valid) {
    return 'invalid / not-yet-built index (INVALID) — finish or drop the build deliberately, do not treat as unused';
  }
  if (row.is_primary) return 'primary key';
  if (row.is_unique) return 'unique constraint / unique index';
  if (row.is_exclusion) return 'exclusion constraint';
  if (row.is_replica_identity) {
    return 'replica identity (used by logical replication to identify updated/deleted rows)';
  }
  return null;
}

interface StatsWindow {
  statsResetAt: Date | null;
  windowDays: number | null;
}

// ── IndexHealthAnalyzer ──────────────────────────────────────────────────────

export interface IndexHealthAnalyzerOptions {
  db: TransactionCapable;
  thresholds?: Partial<IndexHealthThresholds>;
  now?: () => Date;
  logger?: StructuredLogger;
}

export class IndexHealthAnalyzer {
  private readonly db: TransactionCapable;
  private readonly thresholds: IndexHealthThresholds;
  private readonly now: () => Date;
  private readonly log: StructuredLogger;
  private readonly missingDetector: MissingIndexDetector;

  constructor(options: IndexHealthAnalyzerOptions) {
    this.db = options.db;
    this.thresholds = { ...DEFAULT_INDEX_HEALTH_THRESHOLDS, ...options.thresholds };
    this.now = options.now ?? (() => new Date());
    this.log = options.logger ?? createLogger('index-health:analyzer');
    this.missingDetector = new MissingIndexDetector(this.thresholds, this.log);
  }

  async analyze(runId: string = randomUUID()): Promise<IndexHealthRun> {
    const runAt = this.now();

    const findings = await this.db.transaction(async (tx) => {
      // Hard safety barrier for the whole pass. Every statement below is a
      // SELECT against the catalogs; a DDL statement introduced here by a
      // future refactor would raise "cannot execute ... in a read-only
      // transaction" instead of mutating the schema.
      await tx.query('SET TRANSACTION READ ONLY');

      const unused = await this.collectUnusedIndexFindings(tx);
      const missing = await this.missingDetector.detect(tx);
      return [...unused, ...missing];
    });

    this.log.info('index health analysis complete', {
      run_id: runId,
      findings_total: findings.length,
      unused_candidates: findings.filter(
        (f) => f.findingType === 'unused_index' && f.recommendedDdl,
      ).length,
      excluded: findings.filter((f) => f.findingType === 'excluded_index').length,
      missing_index_advisories: findings.filter((f) => f.findingType === 'missing_index').length,
    });

    return { runId, runAt, findings };
  }

  // ── Unused-index analysis (guards 4a–4c) ───────────────────────────────────

  private async collectUnusedIndexFindings(db: Queryable): Promise<IndexHealthFinding[]> {
    const statsWindow = await this.readStatsWindow(db);
    const rows = (await db.query(Q_UNUSED_INDEX_CANDIDATES)).rows as UnusedIndexCandidateRow[];

    const findings: IndexHealthFinding[] = [];

    // 4b: one run-level warning when the statistics window is too short. NULL
    // stats_reset is treated as the unsafe case (window unknown → premature).
    const premature =
      statsWindow.windowDays === null || statsWindow.windowDays < this.thresholds.statsWindowDays;

    if (premature) {
      findings.push(this.buildStatsResetWarning(statsWindow));
    }

    for (const row of rows) {
      const scans = toInt(row.idx_scan);
      const sizeMb = bytesToMb(row.index_bytes);

      // 4a — hard exclusion. Never a removal candidate.
      const hardReason = constraintExclusionReason(row);
      if (hardReason) {
        if (scans < this.thresholds.maxScansForUnused) {
          findings.push({
            findingType: 'excluded_index',
            schemaName: row.schema_name,
            tableName: row.table_name,
            indexName: row.index_name,
            scans30d: scans,
            sizeMb,
            recommendation:
              `Low scan count (${scans}) but NOT a removal candidate: ${hardReason}. ` +
              `This index backs a correctness or replication guarantee, not query performance — ` +
              `removing it would be a data-integrity change, not an optimization.`,
            recommendedDdl: null,
            exclusionReason: hardReason,
            statsWindowDays: statsWindow.windowDays,
            evidence: {
              kind: 'excluded_index',
              idxScan: scans,
              lastIdxScan: toIso(row.last_idx_scan),
              indexBytes: toInt(row.index_bytes),
              ...indexFlags(row),
            },
          });
        }
        continue;
      }

      // Not a constraint index — is it under the usage threshold?
      if (scans >= this.thresholds.maxScansForUnused) continue;

      // 4c — FK-supporting index. Flag with strong caution; withhold DDL.
      if (row.supports_fk) {
        findings.push({
          findingType: 'unused_index',
          schemaName: row.schema_name,
          tableName: row.table_name,
          indexName: row.index_name,
          scans30d: scans,
          sizeMb,
          recommendation:
            `Only ${scans} recorded scans in the window, but this index's leading columns match a ` +
            `FOREIGN KEY on "${row.table_name}". idx_scan does NOT count the internal lookups ` +
            `PostgreSQL performs to enforce the FK when a referenced row is updated or deleted, so ` +
            `"unused" here is misleading. Dropping it can cause full-table scans / lock contention ` +
            `on the parent table. NO DROP DDL is emitted — verify referencing-side write volume and ` +
            `parent-table UPDATE/DELETE patterns before acting.`,
          recommendedDdl: null,
          exclusionReason: 'supports a foreign key constraint (leading-column prefix match)',
          statsWindowDays: statsWindow.windowDays,
          evidence: {
            kind: 'fk_support',
            idxScan: scans,
            lastIdxScan: toIso(row.last_idx_scan),
            indexBytes: toInt(row.index_bytes),
            ...indexFlags(row),
          },
        });
        continue;
      }

      // Genuine unused-index candidate. DDL only when the stats window is sound.
      findings.push({
        findingType: 'unused_index',
        schemaName: row.schema_name,
        tableName: row.table_name,
        indexName: row.index_name,
        scans30d: scans,
        sizeMb,
        recommendation: premature
          ? `Only ${scans} scans over the available (short) statistics window, and not backing any ` +
            `constraint. Potential removal candidate, but the DROP is withheld until the statistics ` +
            `window reaches ${this.thresholds.statsWindowDays} days — see the stats-reset warning above.`
          : `Only ${scans} scans in the last ${this.thresholds.statsWindowDays} days and not backing ` +
            `any primary key, unique/exclusion constraint, replica identity, or (by leading-column ` +
            `match) any foreign key. Removal candidate — review the DDL below with a DBA. For a ` +
            `composite index, still check pg_constraint by hand (see KNOWN GAP in analyzer.ts).`,
        recommendedDdl: premature ? null : buildDropIndexDdl(row.schema_name, row.index_name),
        exclusionReason: premature ? 'statistics window shorter than policy' : null,
        statsWindowDays: statsWindow.windowDays,
        evidence: {
          kind: 'unused_index',
          idxScan: scans,
          lastIdxScan: toIso(row.last_idx_scan),
          indexBytes: toInt(row.index_bytes),
          premature,
          ...indexFlags(row),
        },
      });
    }

    return findings;
  }

  private buildStatsResetWarning(statsWindow: StatsWindow): IndexHealthFinding {
    const policy = this.thresholds.statsWindowDays;
    const recommendation =
      statsWindow.windowDays === null
        ? `pg_stat_database.stats_reset is NULL — the statistics window cannot be established. ` +
          `Every unused-index finding in this run is treated as PREMATURE and no DROP DDL is ` +
          `emitted until a full ${policy}-day window is observable.`
        : `Cumulative statistics were reset ${statsWindow.windowDays.toFixed(1)} days ago ` +
          `(policy requires ${policy}). A recent reset makes healthy indexes look unused: idx_scan ` +
          `counters have not accumulated a representative sample. Unused-index findings below are ` +
          `PREMATURE and carry NO DROP DDL. Re-evaluate after ` +
          `${Math.ceil(policy - statsWindow.windowDays)} more days.`;

    return {
      findingType: 'stats_reset_warning',
      schemaName: '-',
      tableName: '-',
      indexName: null,
      scans30d: null,
      sizeMb: null,
      recommendation,
      recommendedDdl: null,
      exclusionReason: 'statistics window shorter than policy',
      statsWindowDays: statsWindow.windowDays,
      evidence: {
        kind: 'stats_reset_warning',
        statsResetAt: statsWindow.statsResetAt ? statsWindow.statsResetAt.toISOString() : null,
        policyWindowDays: policy,
      },
    };
  }

  private async readStatsWindow(db: Queryable): Promise<StatsWindow> {
    try {
      const rows = (await db.query(Q_STATS_RESET)).rows as StatsResetRow[];
      const row = rows[0];
      if (!row || row.stats_reset == null) return { statsResetAt: null, windowDays: null };
      const statsResetAt =
        row.stats_reset instanceof Date ? row.stats_reset : new Date(row.stats_reset);
      const windowDays =
        row.stats_age_days == null ? null : Number.parseFloat(String(row.stats_age_days));
      return {
        statsResetAt: Number.isNaN(statsResetAt.getTime()) ? null : statsResetAt,
        windowDays: windowDays != null && Number.isFinite(windowDays) ? windowDays : null,
      };
    } catch (err) {
      // Cannot read the window → conservatively treat as premature.
      this.log.warn('index-health analyzer: could not read stats_reset window', err as Error);
      return { statsResetAt: null, windowDays: null };
    }
  }
}
