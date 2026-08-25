import { ConfigDriftAuditor } from './auditor';

// Express types kept minimal to avoid coupling to @types/express in this module.
type Req = { query: Record<string, unknown>; params?: Record<string, string> };
type Res = {
  json(data: unknown): void;
  status(code: number): Res;
  type(mime: string): Res;
  send(body: string): void;
};

export function registerConfigDriftRoutes(app: any, auditor: ConfigDriftAuditor): void {

  // ── GET /config/snapshot ───────────────────────────────────────────────────
  // Returns the current full runtime config as a snapshot.
  // Used by external monitoring to verify the runtime state.
  app.get('/config/snapshot', (_req: Req, res: Res) => {
    try {
      const snapshot = auditor.captureSnapshot();
      res.json(snapshot);
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'snapshot failed' });
    }
  });

  // ── GET /config/drift-events ───────────────────────────────────────────────
  // Query drift events persisted in PostgreSQL (or empty array when no pool).
  app.get('/config/drift-events', async (req: Req, res: Res) => {
    try {
      const limit = Math.min(Number(req.query.limit ?? 100), 1000);
      const severity = req.query.severity as string | undefined;
      const sinceRaw = req.query.since as string | undefined;
      const since = sinceRaw ? new Date(sinceRaw) : undefined;

      const events = await (auditor as any).options.storage.queryEvents({
        limit,
        severity,
        since,
      });
      res.json({ events });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'query failed' });
    }
  });

  // ── GET /debug/config-drift ────────────────────────────────────────────────
  app.get('/debug/config-drift', (_req: Req, res: Res) => {
    res.json({
      latest: auditor.latest(),
      history: auditor.history(100),
    });
  });

  // ── GET /debug/config-drift/history ───────────────────────────────────────
  app.get('/debug/config-drift/history', (req: Req, res: Res) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    res.json({
      history: auditor.history(limit),
    });
  });

  // ── GET /debug/config-drift/ui ─────────────────────────────────────────────
  app.get('/debug/config-drift/ui', (_req: Req, res: Res) => {
    res
      .type('text/html')
      .send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Config Drift Dashboard</title>
  <style>
    body { font-family: sans-serif; margin: 24px; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; }
    th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
    th { background: #f4f4f4; }
    .critical { color: #c00; font-weight: bold; }
    .warning  { color: #e60; font-weight: bold; }
    .info     { color: #090; }
    .summary  { margin-bottom: 16px; }
  </style>
</head>
<body>
  <h1>Config Drift Dashboard</h1>
  <div id="content">Loading…</div>
  <script>
    async function load() {
      const res  = await fetch('/debug/config-drift');
      const data = await res.json();
      const latest  = data.latest;
      const history = data.history || [];
      const el = document.getElementById('content');
      if (!el) return;

      if (!latest) {
        el.innerHTML = '<p>No drift snapshots yet.</p>';
        return;
      }

      function sev(f) {
        return '<span class="' + f.severity + '">' + f.severity + '</span>';
      }

      const findingRows = latest.driftReport.findings.map(function(f) {
        return '<tr>' +
          '<td>' + f.category + '</td>' +
          '<td>' + f.key + '</td>' +
          '<td>' + sev(f) + '</td>' +
          '<td>' + String(f.baselineValue ?? '') + '</td>' +
          '<td>' + String(f.runtimeValue ?? '') + '</td>' +
          '</tr>';
      }).join('');

      const historyRows = history.map(function(item) {
        return '<tr>' +
          '<td>' + item.snapshotId + '</td>' +
          '<td>' + new Date(item.capturedAt).toLocaleString() + '</td>' +
          '<td>' + item.driftReport.summary.total + '</td>' +
          '<td>' + item.driftReport.summary.criticalCount + '</td>' +
          '<td>' + item.driftReport.summary.warningCount + '</td>' +
          '<td>' + item.driftReport.summary.typeChanges + '</td>' +
          '</tr>';
      }).join('');

      el.innerHTML =
        '<h2>Latest Snapshot: ' + latest.snapshotId + '</h2>' +
        '<p>Captured: ' + new Date(latest.capturedAt).toLocaleString() + '</p>' +
        '<p>Total findings: <strong>' + latest.driftReport.summary.total + '</strong> ' +
        '(critical: ' + latest.driftReport.summary.criticalCount +
        ', warning: ' + latest.driftReport.summary.warningCount + ')</p>' +
        '<table>' +
        '<thead><tr><th>Category</th><th>Key</th><th>Severity</th><th>Baseline</th><th>Runtime</th></tr></thead>' +
        '<tbody>' + findingRows + '</tbody>' +
        '</table>' +
        '<h2>History</h2>' +
        '<table>' +
        '<thead><tr><th>Snapshot ID</th><th>Captured</th><th>Total</th><th>Critical</th><th>Warning</th><th>Type Changes</th></tr></thead>' +
        '<tbody>' + historyRows + '</tbody>' +
        '</table>';
    }
    load().catch(function(err) {
      var el = document.getElementById('content');
      if (el) el.innerHTML = '<p>Error loading dashboard.</p>';
      console.error(err);
    });
  </script>
</body>
</html>`);
  });
}
