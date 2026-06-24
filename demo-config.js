/**
 * Demo: Centralized Configuration Manager
 * 
 * This demonstrates the new config system with:
 * - Layered loading (env → file → defaults)
 * - Schema validation
 * - Hot-reload via file watch
 * - Event subscriptions
 */

const path = require('path');
const fs = require('fs');

// Setup ts-node for TypeScript support
require('ts-node').register({ transpileOnly: true, project: './tsconfig.json' });

const { initConfig, getConfig, getConfigValue, onConfigChange, offConfigChange, reloadConfig } = require('./src/config');

// Create demo config file
const DEMO_CONFIG_PATH = path.join(__dirname, 'demo-config.json');

const demoConfig = {
  db: {
    host: 'demo-db.example.com',
    port: 5432,
    user: 'demo_user',
    password: 'demo_pass',
    database: 'verinode_demo',
    maxConnections: 25,
  },
  app: {
    port: 8080,
    environment: 'development',
    logLevel: 'debug',
  },
};

// Write demo config
fs.writeFileSync(DEMO_CONFIG_PATH, JSON.stringify(demoConfig, null, 2));
console.log('[Demo] Created demo config file\n');

async function runDemo() {
  console.log('=== Centralized Configuration Demo ===\n');

  // 1. Initialize with config file
  console.log('1. Initializing config with file...');
  await initConfig({
    configFile: DEMO_CONFIG_PATH,
    watchFiles: [DEMO_CONFIG_PATH],
  });

  const config = getConfig();
  console.log('[OK] Config initialized');
  console.log(`   DB Host: ${config.db.host}`);
  console.log(`   App Port: ${config.app.port}`);
  console.log(`   Log Level: ${config.app.logLevel}`);
  console.log();

  // 2. Access nested values
  console.log('2. Accessing nested config values:');
  console.log(`   db.port = ${getConfigValue('db.port')}`);
  console.log(`   db.maxConnections = ${getConfigValue('db.maxConnections')}`);
  console.log(`   app.environment = ${getConfigValue('app.environment')}`);
  console.log();

  // 3. Subscribe to config changes
  console.log('3. Subscribing to config changes...');
  
  const subscriptionId = onConfigChange((oldConfig, newConfig) => {
    console.log('[EVENT] Config changed!');
    console.log(`   Old port: ${oldConfig?.app?.port}`);
    console.log(`   New port: ${newConfig?.app?.port}`);
  }, 'demo-subscription');

  console.log('[OK] Subscribed with ID:', subscriptionId);
  console.log();

  // 4. Demonstrate file-based hot reload
  console.log('4. Demonstrating file-based hot-reload...');
  console.log('   Waiting 2 seconds for file watch trigger...');
  
  setTimeout(async () => {
    // Modify the config file
    const updatedConfig = {
      ...demoConfig,
      app: {
        ...demoConfig.app,
        port: 9999,
        logLevel: 'info',
      },
    };
    fs.writeFileSync(DEMO_CONFIG_PATH, JSON.stringify(updatedConfig, null, 2));
    console.log('   Updated config file: app.port = 9999');
    
    // Wait for debounce (1s)
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    const newConfig = getConfig();
    console.log(`   Current port: ${newConfig.app.port}`);
    console.log();
  }, 2000);

  // 5. Demonstrate runtime update
  console.log('5. Runtime config update...');
  const manager = require('./src/config/manager').getConfigManager();
  manager.update('app.logLevel', 'warn');
  console.log(`   Updated app.logLevel to: ${getConfigValue('app.logLevel')}`);
  console.log();

  // 6. Trigger hot reload manually
  console.log('6. Manual config reload...');
  await reloadConfig();
  console.log('[OK] Config reloaded via reloadConfig()');
  console.log();

  // 7. Cleanup
  console.log('7. Cleaning up...');
  offConfigChange(subscriptionId);
  fs.unlinkSync(DEMO_CONFIG_PATH);
  console.log('[OK] Cleanup complete');
  console.log();

  console.log('=== Demo Complete ===');
}

runDemo().catch(err => {
  console.error('Demo failed:', err.message);
  process.exit(1);
});
