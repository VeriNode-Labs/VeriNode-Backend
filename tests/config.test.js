/**
 * Configuration manager tests (JavaScript version for compatibility)
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

// Import config system
const configPath = path.join(__dirname, '..', 'src', 'config', 'index.ts');
const { initConfig, getConfig, getConfigValue, onConfigChange, offConfigChange, reloadConfig, validateConfig } = require(configPath);

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

async function cleanup() {
  try {
    fs.unlinkSync(TEST_CONFIG_PATH);
  } catch (e) {
    // Ignore
  }
}

async function setupTestConfig() {
  await cleanup();
  fs.writeFileSync(TEST_CONFIG_PATH, JSON.stringify(TEST_CONFIG, null, 2));
}

async function testBasicLoading() {
  console.log('Test: Basic config loading');
  await initConfig();
  const config = getConfig();
  assert.ok(config);
  assert.ok(config.db);
  assert.strictEqual(config.app.environment, 'development');
  console.log('✓ Basic loading works');
}

async function testFileLoading() {
  console.log('Test: Config file loading');
  await setupTestConfig();
  await initConfig({ configFile: TEST_CONFIG_PATH });
  const config = getConfig();

  assert.strictEqual(config.db.host, 'test-host');
  assert.strictEqual(config.db.port, 5433);
  assert.strictEqual(config.app.port, 3001);
  assert.strictEqual(config.mtls.enabled, true);
  console.log('✓ File loading works');
}

async function testValidation() {
  console.log('Test: Config validation');
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
  console.log('✓ Validation works for valid config');
}

async function testInvalidValidation() {
  console.log('Test: Invalid config rejection');
  const invalidConfig = {
    db: {
      host: 'localhost',
    },
  };

  const result = validateConfig(invalidConfig);
  assert.strictEqual(result.valid, false);
  assert.ok(result.errors.length > 0);
  console.log('✓ Invalid config rejected');
}

async function testRuntimeUpdates() {
  console.log('Test: Runtime config updates');
  const manager = require('../src/config/manager').getConfigManager();
  
  const initialPort = manager.getIn('app.port');
  manager.update('app.port', 9999);
  const updatedPort = manager.getIn('app.port');
  
  assert.strictEqual(updatedPort, 9999);
  console.log('✓ Runtime updates work');
}

async function testEnvironmentOverride() {
  console.log('Test: Environment variable override');
  
  process.env.VERINODE_DB_HOST = 'env-db.example.com';
  process.env.VERINODE_APP_LOG_LEVEL = 'error';

  await initConfig();
  const config = getConfig();
  
  assert.strictEqual(config.db.host, 'env-db.example.com');
  assert.strictEqual(config.app.logLevel, 'error');

  // Clean up
  delete process.env.VERINODE_DB_HOST;
  delete process.env.VERINODE_APP_LOG_LEVEL;
  
  console.log('✓ Environment override works');
}

async function testNestedPaths() {
  console.log('Test: Nested path access');
  
  const manager = require('../src/config/manager').getConfigManager();
  await initConfig();

  manager.update('telemetry.otel.endpoint', 'http://new-endpoint:4317');
  const endpoint = manager.getIn('telemetry.otel.endpoint');
  
  assert.strictEqual(endpoint, 'http://new-endpoint:4317');
  console.log('✓ Nested path access works');
}

async function runTests() {
  console.log('=== Configuration Manager Tests ===\n');
  
  try {
    await testBasicLoading();
    await testFileLoading();
    await testValidation();
    await testInvalidValidation();
    await testRuntimeUpdates();
    await testEnvironmentOverride();
    await testNestedPaths();

    console.log('\n=== All Tests Passed ===');
    await cleanup();
    process.exit(0);
  } catch (err) {
    console.error('Test failed:', err.message);
    console.error(err.stack);
    await cleanup();
    process.exit(1);
  }
}

if (require.main === module) {
  runTests();
}
