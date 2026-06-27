import { ConfigDriftAuditor } from './auditor';

// Keep types minimal to avoid coupling to express type packages in this repo.
// index.js injects an Express app instance at runtime.
export function registerConfigDriftRoutes(app: any, auditor: ConfigDriftAuditor): void {
  app.get('/debug/config-drift', (_req: any, res: any) => {
    res.json({
      latest: auditor.latest(),
      history: auditor.history(100),
    });
  });

  app.get('/debug/config-drift/history', (req: any, res: any) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    res.json({
      history: auditor.history(limit),
    });
  });

  app.get('/debug/config-drift/ui', (_req: any, res: any) => {
    res.type('text/html').send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Config Drift Dashboard</title>
  <style>
    body { font-family: sans-serif; margin: 24px; }
    table { border-collapse: collapse; width: 100%; margin-top: 12px; }
    th, td { border: 1px solid #ccc; padding: 8px; text-align: left; }
    th { background: #f4f4f4; }
    .summary { margin-bottom: 16px; }
  </style>
</head>
<body>
  <h1>Config Drift Dashboard</h1>
  <div class="summary"><em>Displaying latest snapshot and history.</em></div>
  <div id="content">Loading...</div>
  <script>
    async function load() {
      const res = await fetch('/debug/config-drift');
      const data = await res.json();
      const latest = data.latest;
      const history = data.history || [];
      const content = document.getElementById('content');
      if (!content) return;
      if (!latest) {
        content.innerHTML = '<p>No drift snapshots available yet.</p>';
        return;
      }
      const findingRows = latest.driftReport.findings.map(function(f) {
        return '<tr>' +
          '<td>' + f.category + '</td>' +
          '<td>' + f.key + '</td>' +
          '<td>' + String(f.baselineValue ?? '') + '</td>' +
          '<td>' + String(f.runtimeValue ?? '') + '</td>' +
          '</tr>';
      }).join('');

      const historyRows = history.map(function(item) {
        return '<tr>' +
          '<td>' + item.snapshotId + '</td>' +
          '<td>' + new Date(item.capturedAt).toLocaleString() + '</td>' +
          '<td>' + item.driftReport.summary.total + '</td>' +
          '<td>' + item.driftReport.summary.valueChanges + '</td>' +
          '<td>' + item.driftReport.summary.keyAdded + '</td>' +
          '<td>' + item.driftReport.summary.keyRemoved + '</td>' +
          '</tr>';
      }).join('');

      content.innerHTML =
        '<h2>Latest Snapshot</h2>' +
        '<p><strong>Snapshot ID:</strong> ' + latest.snapshotId + '</p>' +
        '<p><strong>Captured:</strong> ' + new Date(latest.capturedAt).toLocaleString() + '</p>' +
        '<p><strong>Total findings:</strong> ' + latest.driftReport.summary.total + '</p>' +
        '<table>' +
        '<thead><tr><th>Category</th><th>Key</th><th>Baseline</th><th>Runtime</th></tr></thead>' +
        '<tbody>' + findingRows + '</tbody>' +
        '</table>' +
        '<h2>History</h2>' +
        '<table>' +
        '<thead><tr><th>Snapshot ID</th><th>Captured</th><th>Total</th><th>Value Changes</th><th>Added</th><th>Removed</th></tr></thead>' +
        '<tbody>' + historyRows + '</tbody>' +
        '</table>';
    }
    load().catch(err => {
      const content = document.getElementById('content');
      if (content) content.innerHTML = '<p>Error loading dashboard.</p>';
      console.error(err);
    });
  </script>
</body>
</html>
    `);
  });
}



