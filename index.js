// VeriNode Backend entrypoint.
//
// Bootstraps the OpenTelemetry tracer (see ./src/diagnostics/tracer.ts)
// so every downstream module that imports @opentelemetry/api inherits
// the configured global TracerProvider. The tracer module is written in
// TypeScript; we try the compiled CJS output first and fall back to a
// ts-node runtime compile when dist/ is not present (typical of dev).

(() => {
  let tracing = null;
  const tryPaths = [
    () => require('./dist/diagnostics/tracer'),
    () => {
      require('ts-node').register({ transpileOnly: true, project: './tsconfig.json' });
      return require('./src/diagnostics/tracer');
    },
  ];
  for (const load of tryPaths) {
    try {
      tracing = load();
      break;
    } catch (err) {
      // try next path
    }
  }
  if (tracing && typeof tracing.initTracing === 'function') {
    tracing.initTracing();
  } else {
    console.warn('[index] OpenTelemetry tracer not loaded; running without tracing');
  }
  // expose globally so legacy CJS modules can opt in via global.__verinode_tracing
  global.__verinode_tracing = tracing;
})();

const express = require('express');
const app = express();

app.get('/', (req, res) => res.send('VeriNode API is running'));

// /debug/traces/config — required by issue #15. Returns current sampler
// configuration, exporter endpoint, and span queue depth so Jaeger / Tempo
// operators can inspect runtime state.
app.get('/debug/traces/config', (req, res) => {
  const t = global.__verinode_tracing;
  if (!t || typeof t.getTraceConfig !== 'function') {
    return res.status(503).json({ error: 'tracing not initialised' });
  }
  res.json(t.getTraceConfig());
});

const port = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(port, () => console.log(`Server running on port ${port}`));
}

module.exports = app;
