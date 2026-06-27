// VeriNode Backend entrypoint.
//
// Bootstraps the centralized configuration system first, then initializes
// the OpenTelemetry tracer (see ./src/diagnostics/tracer.ts) so every
// downstream module that imports @opentelemetry/api inherits the configured
// global TracerProvider. The tracer module is written in TypeScript; we try
// the compiled CJS output first and fall back to a ts-node runtime compile
// when dist/ is not present (typical of dev).

const express = require('express');

// ---- Module loader for TypeScript sources ----
function loadTsModule(modulePath) {
  const tryPaths = [
    () => require('./dist/' + modulePath),
    () => {
      require('ts-node').register({ transpileOnly: true, project: './tsconfig.json' });
      return require('./src/' + modulePath);
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

// ---- Config ----
const configModule = loadTsModule('config/index');
const { initConfig, getConfig, getConfigValue, onConfigChange, reloadConfig } = configModule || {};

// ---- Express app ----
const app = express();

async function bootstrap() {
  // 1. Initialize centralized configuration
  if (initConfig) {
    await initConfig({
      configFile: process.env.CONFIG_FILE || './config.json',
      watchFiles: [process.env.CONFIG_FILE || './config.json'],
    });
    console.log('[index] Config initialized');

    // Handle SIGHUP for hot reload
    process.on('SIGHUP', async () => {
      if (reloadConfig) {
        console.log('[index] Reloading configuration...');
        await reloadConfig();
        console.log('[index] Configuration reloaded');
      }
    });
  } else {
    console.warn('[index] Config module not loaded; running with env defaults');
  }

  // 1b. Start config drift auditor + expose debug endpoints
  const driftModule = loadTsModule('config-drift/auditor');
  const driftRoutesModule = loadTsModule('config-drift/routes');
  if (driftModule && driftRoutesModule) {
    try {
      const { createConfigDriftAuditorFromEnv } = driftModule;
      const { registerConfigDriftRoutes } = driftRoutesModule;

      const auditor = createConfigDriftAuditorFromEnv({});
      auditor.init().then(() => {
        auditor.start();
        registerConfigDriftRoutes(app, auditor);
        console.log('[config-drift] Auditor started');
      });


      // best-effort shutdown hook
      const shutdownHandler = () => {

        try {
          auditor.stop();
        } catch {
          // noop
        }
      };
      process.once('SIGINT', shutdownHandler);
      process.once('SIGTERM', shutdownHandler);

    } catch (err) {
      console.warn('[config-drift] Failed to start auditor:', (err && err.message) ? err.message : String(err));
    }
  } else {
    console.warn('[config-drift] Drift modules not loaded');
  }

  // 2. Initialize tracing

  const tracing = loadTsModule('diagnostics/tracer');
  if (tracing && typeof tracing.initTracingFromConfig === 'function') {
    const otelCfg = getConfigValue ? getConfigValue('telemetry.otel') : null;
    if (otelCfg && otelCfg.enabled !== false) {
      tracing.initTracingFromConfig(otelCfg);
    } else {
      tracing.initTracing();
    }
  } else if (tracing && typeof tracing.initTracing === 'function') {
    tracing.initTracing();
  } else {
    indexLog.warn('OpenTelemetry tracer not loaded; running without tracing');
  }
  global.__verinode_tracing = tracing;

  // 3. Set up Express middleware
  app.use(express.json());

  // 4. mTLS middleware
  const mtlsModule = loadTsModule('security/mtls');
  const mtlsManager = mtlsModule && typeof mtlsModule.createMtlsManager === 'function'
    ? mtlsModule.createMtlsManager()
    : (mtlsModule && typeof mtlsModule.createMtlsManagerFromEnv === 'function'
      ? mtlsModule.createMtlsManagerFromEnv()
      : null);
  global.__verinode_mtls = mtlsManager;

  if (mtlsManager && mtlsManager.current) {
    console.log('[index] mTLS enabled');
  }

  app.use((req, res, next) => {
    if (!mtlsManager || !mtlsManager.current) return next();
    if (!req.client.authorized) {
      mtlsManager.recordHandshakeFailure();
      return res.status(401).json({ error: 'mTLS client certificate required' });
    }
    const peerCert = req.socket.getPeerCertificate();
    const mtlsConfig = mtlsManager.config || {};
    if (!mtlsModule.validatePeerCertificate(peerCert, {
      trustDomain: mtlsConfig.trustDomain || 'cluster.local',
      allowedSpiffeIds: mtlsConfig.allowedSpiffeIds || [],
    })) {
      mtlsManager.recordInvalidPeerIdentity();
      return res.status(403).json({ error: 'mTLS peer SPIFFE identity is not allowed' });
    }
    return next();
  });

  // 5. Routes
  app.get('/', (req, res) => res.send('VeriNode API is running'));

  // /debug/traces/config — required by issue #15
  app.get('/debug/traces/config', (req, res) => {
    const t = global.__verinode_tracing;
    if (!t || typeof t.getTraceConfig !== 'function') {
      return res.status(503).json({ error: 'tracing not initialised' });
    }
    res.json(t.getTraceConfig());
  });

  // /health/pools — dual-pool connection stats
  app.get('/health/pools', (req, res) => {
    const pools = global.__verinode_pools;
    if (!pools || typeof pools.getPoolHealth !== 'function') {
      return res.status(503).json({ error: 'pool router not initialised' });
    }
    res.json(pools.getPoolHealth());
  });

  // /metrics — Prometheus text-format scrape endpoint
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

  // POST /internal/archival/renew/:contractId — required by issue #20
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

  // 6. Start server
  const port = getConfigValue ? (getConfigValue('app.port') || 3000) : (process.env.PORT || 3000);

  if (mtlsManager && mtlsManager.config && mtlsManager.config.enabled) {
    mtlsManager.startRotationWatch();
    const https = require('https');
    const server = https.createServer(mtlsManager.serverOptions(), app);
    server.on('tlsClientError', () => mtlsManager.recordHandshakeFailure());
    server.listen(port, () => console.log(`mTLS server running on port ${port}`));
  } else {
    const httpServer = app.listen(port, () => console.log(`Server running on port ${port}`));
    await bootstrapTls(httpServer, port);
  }
}

function getDeadLetterQueue() {
  return app.locals.deadLetterQueue || global.__verinode_dlq || null;
}

async function bootstrapTls(httpServer, httpPort) {
  try {
    const tlsBootstrap = loadTsModule('tls/acme_rotation');
    if (tlsBootstrap && typeof tlsBootstrap.bootstrapTlsFromConfig === 'function') {
      await tlsBootstrap.bootstrapTlsFromConfig(app, { httpPort });
    } else if (tlsBootstrap && typeof tlsBootstrap.bootstrapTlsFromEnv === 'function') {
      await tlsBootstrap.bootstrapTlsFromEnv(app, { httpPort });
    }
  } catch (err) {
    httpServer.close();
    indexLog.error('TLS ACME bootstrap failed', { 'error.message': err instanceof Error ? err.message : String(err) });
    process.exitCode = 1;
  }
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error('[index] Bootstrap failed', err);
    process.exit(1);
  });
}

module.exports = app;
