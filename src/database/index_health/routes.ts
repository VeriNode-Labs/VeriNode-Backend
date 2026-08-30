/**
 * VeriNode Backend — DB Index Health Monitoring: read-only API (issue #197)
 *
 * GET /api/v1/db/index-health — current recommendations from the latest run.
 * Matches the free-function route convention of registerCertManagementRoutes /
 * registerConfigDriftRoutes: try/catch → res.status(n).json({ error }).
 */

import { IndexHealthFinding, IndexHealthRun } from './types';

export interface IndexHealthRouteDeps {
  /** Returns the latest persisted run, or null when none exists yet. */
  getLatestRun: () => Promise<IndexHealthRun | null>;
}

function summarize(findings: IndexHealthFinding[]) {
  return {
    unusedCandidatesWithDdl: findings.filter(
      (f) => f.findingType === 'unused_index' && f.recommendedDdl,
    ).length,
    unusedWithheld: findings.filter((f) => f.findingType === 'unused_index' && !f.recommendedDdl)
      .length,
    excluded: findings.filter((f) => f.findingType === 'excluded_index').length,
    missingIndexAdvisories: findings.filter(
      (f) =>
        f.findingType === 'missing_index' &&
        (f.evidence as { kind?: string }).kind !== 'pg_stat_statements_status',
    ).length,
    statsResetWarnings: findings.filter((f) => f.findingType === 'stats_reset_warning').length,
  };
}

export function registerIndexHealthRoutes(
  app: { get: Function },
  deps: IndexHealthRouteDeps,
): void {
  (app as any).get('/api/v1/db/index-health', async (_req: unknown, res: any) => {
    try {
      const run = await deps.getLatestRun();
      if (!run) {
        return res
          .status(503)
          .json({ error: 'no index health report available yet — analyzer has not run' });
      }
      res.json({
        runId: run.runId,
        runAt: run.runAt instanceof Date ? run.runAt.toISOString() : run.runAt,
        summary: summarize(run.findings),
        findings: run.findings,
      });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'index health query failed' });
    }
  });
}
