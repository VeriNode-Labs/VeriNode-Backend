/**
 * Configuration manager tests
 */
import * as assert from 'assert';
import * as path from 'path';
import { initConfig, getConfig, getConfigValue, onConfigChange, offConfigChange, onChangePath, reloadConfig, validateConfig } from '../src/config';

const TEST_CONFIG_PATH = path.join(__dirname, 'test-config.json');

const TEST_CONFIG = {
  db: {
    host: 'test-host',
    port: 5433,
    user: 'test-user',
    password: 'test-pass',
    database: 'test-db',
  },
  app: {
    port: 3001,
    environment: 'test',
    logLevel: 'debug',
  },
  mtls: {
    enabled: true,
    certFile: '/test/cert.pem',
    keyFile: '/test/key.pem',
    caFile: '/test/ca.pem',
  },
};

describe('Configuration Manager', () => {
  before(async () => {
    const fs = await import('fs');
    try {
      fs.unlinkSync(TEST_CONFIG_PATH);
    } catch {}
  });

  it('should initialize with default config', async () => {
    await initConfig();
    const config = getConfig();
    assert.ok(config);
    assert.ok(config.db);
    assert.strictEqual(config.app.environment, 'development');
  });

  it('should load from config file', async () => {
    const fs = await import('fs');
    fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(TEST_CONFIG, null, 2));

    await initConfig({ configFile: TEST_CONFIG_PATH });
    const config = getConfig();

    assert.strictEqual(config.db.host, 'test-host');
    assert.strictEqual(config.db.port, 5433);
    assert.strictEqual(config.app.port, 3001);
    assert.strictEqual(config.mtls.enabled, true);
  });

  it('should validate config against schema', async () => {
    const validConfig = {
      db: {
        host: 'localhost',
        port: 5432,
        user: 'test',
        password: 'test',
        database: 'test',
      },
      app: {
        port: 3000,
        environment: 'production',
        logLevel: 'info',
      },
    };

    const result = validateConfig(validConfig);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
  });

  it('should reject invalid config', async () => {
    const invalidConfig = {
      db: {
        host: 'localhost',
      },
    };

    const result = validateConfig(invalidConfig);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it('should allow runtime config updates', () => {
    const manager = require('../src/config/manager').getConfigManager();
    
    const initialPort = manager.getIn('app.port');
    manager.update('app.port', 9999);
    const updatedPort = manager.getIn('app.port');
    assert.strictEqual(updatedPort, 9999);
  });

  it('should emit config change events', async () => {
    let eventCount = 0;
    let lastConfig: any = null;

    const subscriptionId = onConfigChange((oldConfig, newConfig) => {
      eventCount++;
      lastConfig = newConfig;
    });

    await reloadConfig();

    await new Promise(resolve => setTimeout(resolve, 100));

    assert.ok(eventCount > 0, 'Should have received config change events');
    
    offConfigChange(subscriptionId);
  });

  it('should support path-specific subscriptions via onChangePath', async () => {
    let changed: any[] = [];

    const subId = onChangePath('app.logLevel', (value) => {
      changed.push(value);
    });

    const manager = require('../src/config/manager').getConfigManager();
    manager.update('app.logLevel', 'warn');

    await new Promise(resolve => setTimeout(resolve, 100));

    assert.ok(changed.length > 0, 'Should have detected log level change via onChangePath');
    offConfigChange(subId);
  });

  it('should reload configuration', async () => {
    const manager = require('../src/config/manager').getConfigManager();

    const initialPort = manager.getIn('app.port');
    manager.update('app.port', 8888);
    const updatedPort = manager.getIn('app.port');

    assert.notStrictEqual(updatedPort, initialPort);
    assert.strictEqual(updatedPort, 8888);
  });

  it('should handle nested path access', async () => {
    const manager = require('../src/config/manager').getConfigManager();
    await initConfig();

    manager.update('telemetry.otel.endpoint', 'http://new-endpoint:4317');
    const endpoint = manager.getIn('telemetry.otel.endpoint');
    assert.strictEqual(endpoint, 'http://new-endpoint:4317');
  });

  it('should support environment variable override', async () => {
    process.env.VERINODE_DB_HOST = 'env-db.example.com';
    process.env.VERINODE_APP_LOG_LEVEL = 'error';

    await initConfig();

    const config = getConfig();
    assert.strictEqual(config.db.host, 'env-db.example.com');
    assert.strictEqual(config.app.logLevel, 'error');

    delete process.env.VERINODE_DB_HOST;
    delete process.env.VERINODE_APP_LOG_LEVEL;
  });

  it('should produce config from createPool with centralized fallback', () => {
    const { createPool } = require('../src/config/database');
    const dbConfig = createPool();
    assert.ok(dbConfig instanceof require('../src/config/database').Database);
    dbConfig.close();
  });

  it('should get mtls config from centralized config via mtlsConfigFromCentralConfig', async () => {
    const { initConfig } = require('../src/config');
    await initConfig();

    const { mtlsConfigFromCentralConfig } = require('../src/security/mtls');
    const cfg = mtlsConfigFromCentralConfig();
    assert.strictEqual(typeof cfg.enabled, 'boolean');
    assert.strictEqual(typeof cfg.trustDomain, 'string');
  });

  it('should validate otel config via initTracingFromConfig', () => {
    const { initTracingFromConfig, shutdownTracing } = require('../src/diagnostics/tracer');
    shutdownTracing();

    const otelConfig = {
      enabled: true,
      endpoint: 'http://localhost:4317',
      serviceName: 'test-service',
      samplingRatio: 0.5,
    };
    const result = initTracingFromConfig(otelConfig, { silent: true, disabled: true });
    assert.ok(result !== null);
    assert.strictEqual(result.serviceName, 'test-service');
    assert.strictEqual(result.samplerRatio, 0.5);
    shutdownTracing();
  });

  it('should bootstrap TLS from config', () => {
    const { bootstrapTlsFromConfig } = require('../src/tls/acme_rotation');
    assert.strictEqual(typeof bootstrapTlsFromConfig, 'function');
  });

  it('should support hot-reload via SIGHUP pattern', async () => {
    process.env.VERINODE_DB_HOST = 'reload-test.example.com';
    await initConfig();

    const before = getConfigValue('db.host');
    assert.strictEqual(before, 'reload-test.example.com');

    process.env.VERINODE_DB_HOST = 'reloaded.example.com';
    await reloadConfig();

    const after = getConfigValue('db.host');
    assert.strictEqual(after, 'reloaded.example.com');

    delete process.env.VERINODE_DB_HOST;
  });

  after(async () => {
    const fs = await import('fs');
    try {
      fs.unlinkSync(TEST_CONFIG_PATH);
    } catch {}
  });
});
