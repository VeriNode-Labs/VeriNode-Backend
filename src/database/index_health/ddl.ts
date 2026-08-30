/**
 * VeriNode Backend — DB Index Health Monitoring: DDL string builders (issue #197)
 *
 * SAFETY BOUNDARY. These functions return DDL as *text* only, for a DBA to
 * review and run by hand. Nothing in this file — or anywhere in the
 * index_health subsystem — passes these strings to a database client. The
 * analyzer additionally runs inside a READ ONLY transaction, so an accidental
 * execution path would be rejected by PostgreSQL rather than mutating schema.
 *
 * Every builder prefixes its output with REVIEW_MARKER; tests assert that
 * marker is present and that these strings never reach `query()`.
 */

export const REVIEW_MARKER =
  '-- REVIEW REQUIRED: a human must verify this with a DBA before running. ' +
  'This tool never executes DDL.';

/** Double-quote a SQL identifier, escaping embedded quotes. */
function quoteIdent(ident: string): string {
  return `"${String(ident).replace(/"/g, '""')}"`;
}

/**
 * Suggested statement to drop an index that appears genuinely unused.
 * `CONCURRENTLY` + `IF EXISTS` so a DBA can paste it with minimal risk.
 */
export function buildDropIndexDdl(schemaName: string, indexName: string): string {
  return (
    `${REVIEW_MARKER}\n` +
    `DROP INDEX CONCURRENTLY IF EXISTS ${quoteIdent(schemaName)}.${quoteIdent(indexName)};`
  );
}

/**
 * Suggested statement to create an index for a column that a heuristic
 * predicate scan associated with a frequently sequentially-scanned table.
 * Only ever emitted for an unambiguous single-column equality predicate.
 */
export function buildCreateIndexDdl(
  schemaName: string,
  tableName: string,
  columnName: string,
): string {
  const indexName = `idx_${tableName}_${columnName}`.slice(0, 63);
  return (
    `${REVIEW_MARKER}\n` +
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS ${quoteIdent(indexName)} ` +
    `ON ${quoteIdent(schemaName)}.${quoteIdent(tableName)} (${quoteIdent(columnName)});`
  );
}
