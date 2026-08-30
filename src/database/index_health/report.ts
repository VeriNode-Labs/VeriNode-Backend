/**
 * VeriNode Backend — DB Index Health Monitoring: report rendering (issue #197)
 *
 * No PDF dependency (none exists in this codebase). The established reporting
 * conventions here are plain-text email bodies (src/audit/alert_dispatcher.ts),
 * Prometheus text, and small HTML debug views (src/config-drift/routes.ts).
 * This module renders the same run as:
 *   - plain text  → the monthly email body,
 *   - HTML        → an optional lightweight view, mirroring /debug/config-drift/ui.
 * The JSON form is served directly by routes.ts.
 */

import { EmailService } from '../../notifications/emailService';
import { IndexHealthFinding, IndexHealthRun } from './types';

function fmtSize(mb: number | null): string {
  return mb == null ? '—' : `${mb.toFixed(2)} MB`;
}

function section(title: string, lines: string[]): string {
  if (lines.length === 0) return '';
  return `\n${title}\n${'-'.repeat(title.length)}\n${lines.join('\n')}\n`;
}

function byType(
  run: IndexHealthRun,
  ...types: IndexHealthFinding['findingType'][]
): IndexHealthFinding[] {
  return run.findings.filter((f) => types.includes(f.findingType));
}

/** Plain-text report — used verbatim as the monthly email body. */
export function renderIndexHealthReport(run: IndexHealthRun): string {
  const runAt = run.runAt instanceof Date ? run.runAt.toISOString() : String(run.runAt);

  const statsWarnings = byType(run, 'stats_reset_warning');
  const unused = byType(run, 'unused_index');
  const excluded = byType(run, 'excluded_index');
  const missing = byType(run, 'missing_index');

  const actionableUnused = unused.filter((f) => f.recommendedDdl);
  const withheldUnused = unused.filter((f) => !f.recommendedDdl);
  const pgssStatus = missing.find(
    (f) => (f.evidence as { kind?: string }).kind === 'pg_stat_statements_status',
  );
  const seqScanAdvisories = missing.filter((f) => f !== pgssStatus);

  const head = [
    'VeriNode — Database Index Health Report',
    '======================================',
    `Run ID:  ${run.runId}`,
    `Run at:  ${runAt}`,
    '',
    'Every item below is ADVISORY. This tool never runs CREATE INDEX or DROP',
    'INDEX; all DDL is text for a DBA to review and run by hand.',
    '',
    `Summary: ${actionableUnused.length} unused-index candidate(s) with DDL, ` +
      `${withheldUnused.length} withheld, ${excluded.length} deliberately excluded, ` +
      `${seqScanAdvisories.length} missing-index advisory(ies).`,
  ].join('\n');

  const statsBlock = section(
    'Statistics window',
    statsWarnings.length === 0
      ? [
          `OK — statistics window satisfies policy ` +
            `(${run.findings.find((f) => f.statsWindowDays != null)?.statsWindowDays?.toFixed?.(1) ?? 'n/a'} days observed).`,
        ]
      : statsWarnings.map((f) => `! ${f.recommendation}`),
  );

  const unusedBlock = section(
    'Unused index candidates',
    unused.length === 0
      ? ['None.']
      : unused.flatMap((f) => {
          const lines = [
            `* ${f.schemaName}.${f.indexName}  (table ${f.tableName}, ${fmtSize(f.sizeMb)}, ` +
              `${f.scans30d} scans)`,
            `    ${f.recommendation}`,
          ];
          if (f.recommendedDdl) {
            lines.push(...f.recommendedDdl.split('\n').map((l) => `    ${l}`));
          } else {
            lines.push(`    (no DDL emitted — ${f.exclusionReason ?? 'withheld'})`);
          }
          return lines;
        }),
  );

  const excludedBlock = section(
    'Excluded — checked, deliberately NOT recommended for removal',
    excluded.length === 0
      ? ['None.']
      : excluded.map(
          (f) =>
            `* ${f.schemaName}.${f.indexName}  (table ${f.tableName}, ${f.scans30d} scans) ` +
            `— excluded: ${f.exclusionReason}`,
        ),
  );

  const missingBlock = section(
    'Missing-index advisories',
    seqScanAdvisories.length === 0
      ? ['None.']
      : seqScanAdvisories.flatMap((f) => {
          const lines = [
            `* table ${f.schemaName}.${f.tableName}  (${fmtSize(f.sizeMb)})`,
            `    ${f.recommendation}`,
          ];
          if (f.recommendedDdl) {
            lines.push(...f.recommendedDdl.split('\n').map((l) => `    ${l}`));
          }
          return lines;
        }),
  );

  const pgssBlock = section(
    'pg_stat_statements',
    pgssStatus
      ? [`! ${pgssStatus.recommendation}`]
      : ['Available — query-pattern predicate hints were evaluated.'],
  );

  return (
    [head, statsBlock, unusedBlock, excludedBlock, missingBlock, pgssBlock].join('\n').trimEnd() +
    '\n'
  );
}

/** Lightweight HTML view (same data), mirroring the config-drift dashboard style. */
export function renderIndexHealthReportHtml(run: IndexHealthRun): string {
  const esc = (s: unknown) =>
    String(s ?? '').replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!,
    );
  const rows = run.findings
    .map(
      (f) =>
        `<tr>` +
        `<td>${esc(f.findingType)}</td>` +
        `<td>${esc(f.schemaName)}.${esc(f.tableName)}</td>` +
        `<td>${esc(f.indexName ?? '')}</td>` +
        `<td>${esc(f.scans30d ?? '')}</td>` +
        `<td>${esc(f.sizeMb ?? '')}</td>` +
        `<td>${esc(f.exclusionReason ?? '')}</td>` +
        `<td><pre>${esc(f.recommendedDdl ?? '')}</pre></td>` +
        `<td>${esc(f.recommendation)}</td>` +
        `</tr>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Index Health Report</title>
<style>
  body { font-family: sans-serif; margin: 24px; }
  table { border-collapse: collapse; width: 100%; margin-top: 12px; }
  th, td { border: 1px solid #ccc; padding: 6px; text-align: left; vertical-align: top; }
  th { background: #f4f4f4; }
  pre { margin: 0; white-space: pre-wrap; }
</style></head>
<body>
  <h1>Database Index Health Report</h1>
  <p>Run <code>${esc(run.runId)}</code> at ${esc(run.runAt instanceof Date ? run.runAt.toISOString() : run.runAt)}.
  All items are advisory; this tool never executes DDL.</p>
  <table>
    <thead><tr><th>Type</th><th>Table</th><th>Index</th><th>Scans</th><th>Size (MB)</th>
      <th>Exclusion reason</th><th>Recommended DDL (review only)</th><th>Detail</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>`;
}

// ── Monthly email delivery ───────────────────────────────────────────────────

/**
 * Composes the plain-text report and delivers it through the injected
 * EmailService (same convention as SlashingNotifier / AlertDispatcher). The
 * transport itself is not implemented in this repo — it is always injected.
 */
export class IndexHealthReporter {
  constructor(
    private readonly emailService: EmailService,
    private readonly recipients: string[],
  ) {}

  async sendMonthlyReport(run: IndexHealthRun): Promise<void> {
    if (this.recipients.length === 0) return;
    const body = renderIndexHealthReport(run);
    for (const to of this.recipients) {
      await this.emailService.sendEmail({
        // Idempotent per run + recipient (IdempotentEmailService dedupes on this).
        notificationId: `index-health:${run.runId}:${to}`,
        to,
        subject: '[VeriNode] Monthly Index Health Report',
        body,
      });
    }
  }
}
