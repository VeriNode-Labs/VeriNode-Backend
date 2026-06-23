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
const https = require('https');
const app = express();

function getDeadLetterQueue() {
  return app.locals.deadLetterQueue || global.__verinode_dlq || null;
}

function getDeadLetterRetryHandler() {
  return app.locals.deadLetterRetryHandler || global.__verinode_dlq_retry_handler || null;
}

function parseListQuery(query) {
  const params = {};
  if (typeof query.messageType === 'string' && query.messageType.trim()) {
    params.messageType = query.messageType.trim();
  }
  if (typeof query.limit === 'string') {
    params.limit = Number.parseInt(query.limit, 10);
  }
  if (typeof query.offset === 'string') {
    params.offset = Number.parseInt(query.offset, 10);
  }
  return params;
}

function loadMtlsModule() {
  const tryPaths = [
    () => require('./dist/security/mtls'),
    () => {
      require('ts-node').register({ transpileOnly: true, project: './tsconfig.json' });
      return require('./src/security/mtls');
    },
  ];
  for (const load of tryPaths) {
    try {
      return load();
    } catch (err) {
      // try next path
    }
  }
  return null;
}

const mtls = loadMtlsModule();
if ((process.env.VERINODE_MTLS_ENABLED === 'true' || process.env.VERINODE_MTLS_ENABLED === '1') && !mtls) {
  throw new Error('VERINODE_MTLS_ENABLED is set but the mTLS module could not be loaded');
}
const mtlsManager = mtls && typeof mtls.createMtlsManagerFromEnv === 'function'
  ? mtls.createMtlsManagerFromEnv()
  : null;
global.__verinode_mtls = mtlsManager;

app.use((req, res, next) => {
  if (!mtlsManager || !mtlsManager.current) return next();
  if (!req.client.authorized) {
    mtlsManager.recordHandshakeFailure();
    return res.status(401).json({ error: 'mTLS client certificate required' });
  }
  const peerCert = req.socket.getPeerCertificate();
  if (!mtls.validatePeerCertificate(peerCert, mtlsManager.config ?? {
    trustDomain: process.env.SPIFFE_TRUST_DOMAIN || 'cluster.local',
    allowedSpiffeIds: (process.env.SPIFFE_ALLOWED_IDS || '').split(',').map((v) => v.trim()).filter(Boolean),
  })) {
    mtlsManager.recordInvalidPeerIdentity();
    return res.status(403).json({ error: 'mTLS peer SPIFFE identity is not allowed' });
  }
  return next();
});

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

// /health/pools — dual-pool connection stats for operational dashboards.
// Returns 503 when the PriorityRouter has not been initialised yet.
app.get('/health/pools', (req, res) => {
  const pools = global.__verinode_pools;
  if (!pools || typeof pools.getPoolHealth !== 'function') {
    return res.status(503).json({ error: 'pool router not initialised' });
  }
  res.json(pools.getPoolHealth());
});

// /metrics — Prometheus text-format scrape endpoint.
app.get('/metrics', async (req, res) => {
  const chunks = [];
  const pools = global.__verinode_pools;
  if (pools && typeof pools.prometheusMetrics === 'function') {
    chunks.push(pools.prometheusMetrics());
  }
  const dlq = getDeadLetterQueue();
  if (dlq && typeof dlq.prometheusMetrics === 'function') {
    chunks.push(await dlq.prometheusMetrics());
  }
  if (mtlsManager && typeof mtlsManager.prometheusMetrics === 'function') {
    chunks.push(mtlsManager.prometheusMetrics());
  }
  if (chunks.length === 0) {
    return res.status(503).type('text/plain').send('# metrics sources not initialised\n');
  }
  res.type('text/plain; version=0.0.4; charset=utf-8').send(chunks.join('\n'));
});

const port = process.env.PORT || 3000;

// POST /internal/archival/renew/:contractId — required by issue #20.
// Triggers an immediate TTL extension for a specific contract's critical
// keys, bypassing the normal 60s poll/threshold logic. Returns the new
// TTL and transaction hash. The listener instance is attached at
// app.locals.archivalListener during server bootstrap (see src/blockchain/state_archival.ts).
app.post('/internal/archival/renew/:contractId', express.json(), async (req, res) => {
  const listener = app.locals.archivalListener;
  if (!listener) {
    return res.status(503).json({ error: 'archival listener not initialised' });
  }
  try {
    const result = await listener.renewNow(req.params.contractId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'renewal failed' });
  }
});

// DLQ management API — list, retry, purge, and TTL cleanup for failed async messages.
app.get('/internal/dlq', async (req, res) => {
  const dlq = getDeadLetterQueue();
  if (!dlq) {
    return res.status(503).json({ error: 'dead letter queue not initialised' });
  }
  try {
    res.json({ entries: await dlq.list(parseListQuery(req.query)) });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'dlq list failed' });
  }
});

app.post('/internal/dlq/:id/retry', express.json(), async (req, res) => {
  const dlq = getDeadLetterQueue();
  const handler = getDeadLetterRetryHandler();
  if (!dlq) {
    return res.status(503).json({ error: 'dead letter queue not initialised' });
  }
  if (typeof handler !== 'function') {
    return res.status(503).json({ error: 'dead letter retry handler not initialised' });
  }
  try {
    const result = await dlq.retry(req.params.id, handler);
    res.json({ retried: true, result });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'dlq retry failed';
    if (message.includes('not found')) {
      return res.status(404).json({ error: message });
    }
    res.status(500).json({ retried: false, error: message });
  }
});

app.delete('/internal/dlq/expired', async (req, res) => {
  const dlq = getDeadLetterQueue();
  if (!dlq) {
    return res.status(503).json({ error: 'dead letter queue not initialised' });
  }
  try {
    res.json({ purged: await dlq.purgeExpired() });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'dlq purge failed' });
  }
});

app.delete('/internal/dlq/:id', async (req, res) => {
  const dlq = getDeadLetterQueue();
  if (!dlq) {
    return res.status(503).json({ error: 'dead letter queue not initialised' });
  }
  try {
    const purged = await dlq.purge(req.params.id);
    if (!purged) {
      return res.status(404).json({ error: 'dead letter entry not found' });
    }
    res.json({ purged: true });
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'dlq purge failed' });
  }
});

if (require.main === module) {
  if (mtlsManager && mtlsManager.config.enabled) {
    mtlsManager.startRotationWatch();
    const server = https.createServer(mtlsManager.serverOptions(), app);
    server.on('tlsClientError', () => mtlsManager.recordHandshakeFailure());
    server.listen(port, () => console.log(`mTLS server running on port ${port}`));
  } else {
    app.listen(port, () => console.log(`Server running on port ${port}`));
  }
}

module.exports = app;
