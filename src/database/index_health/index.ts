/**
 * VeriNode Backend — DB Index Health Monitoring (issue #197)
 *
 * Automated, ADVISORY-ONLY index usage analysis. The analyzer runs inside a
 * READ ONLY transaction and never executes CREATE/DROP INDEX — every DDL
 * suggestion is text for a DBA to review and run manually.
 *
 * Usage (see index.js for the live wiring):
 *   const monitor = createIndexHealthMonitorFromEnv(db);
 *   monitor.start();
 *   registerIndexHealthRoutes(app, { getLatestRun: () => getLatestIndexHealthRun(db) });
 */

export { IndexHealthAnalyzer, constraintExclusionReason } from './analyzer';
export {
  MissingIndexDetector,
  extractSingleColumnEqualityPredicate,
} from './missing_index_detector';
export { buildDropIndexDdl, buildCreateIndexDdl, REVIEW_MARKER } from './ddl';
export { persistIndexHealthRun, getLatestIndexHealthRun } from './store';
export {
  renderIndexHealthReport,
  renderIndexHealthReportHtml,
  IndexHealthReporter,
} from './report';
export {
  IndexHealthMonitor,
  createIndexHealthMonitorFromEnv,
  DEFAULT_INDEX_HEALTH_CRON,
} from './runner';
export { registerIndexHealthRoutes } from './routes';

export type {
  Queryable,
  TransactionCapable,
  IndexHealthFinding,
  IndexHealthFindingType,
  IndexHealthRun,
  IndexHealthThresholds,
} from './types';
export { DEFAULT_INDEX_HEALTH_THRESHOLDS } from './types';
