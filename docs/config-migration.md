# Configuration Migration Guide

This document describes how to migrate existing modules to use the centralized configuration system.

## Overview

The centralized config system provides:
- **Layered loading**: Environment variables → Config file → Remote sources (etcd/consul) → Defaults
- **Schema validation**: JSON Schema validation on load and updates
- **Hot-reload**: SIGHUP signal or file watch triggers reload without restart
- **Event bus**: Subscribe to configuration changes via `onConfigChange()`
- **< 1s propagation**: Debounced update propagation

## API Reference

### Initialization

```typescript
import { initConfig, getConfig } from './src/config';

// Initialize with optional config file and watch files
await initConfig({
  configFile: './config.json',
  watchFiles: ['./config.json', './src/config/'],
  loadRemote: false, // Set to true for etcd/consul integration
});

// Get full configuration
const config = getConfig();

// Get specific value
const port = getConfigValue('app.port');
```

### Change Subscriptions

```typescript
import { onConfigChange, offConfigChange } from './src/config';

const subscriptionId = onConfigChange((oldConfig, newConfig) => {
  console.log('Config changed from', oldConfig, 'to', newConfig);
});

// Unsubscribe when done
offConfigChange(subscriptionId);
```

### Path-based Updates

```typescript
import { onChangePath } from './src/config';

// Subscribe to specific path changes
onChangePath('app.logLevel', (value) => {
  console.log('Log level changed to', value);
});
```

### Hot Reload Trigger

```typescript
import { reloadConfig } from './src/config';

// Trigger reload (e.g., on SIGHUP)
process.on('SIGHUP', async () => {
  await reloadConfig();
});
```

## Module Migration Examples

### Database Module

**Before:**
```typescript
// src/config/database.ts
export function createPool(overrides?: Partial<DatabaseConfig>): Database {
  return new Database({
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    user: process.env.DB_USER ?? 'verinode',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'verinode',
    ...
  });
}
```

**After:**
```typescript
// src/config/database.ts
import { getConfigValue, onConfigChange } from '../config';

const POOL: Database | null = null;

export function getPool(): Database {
  if (!POOL) {
    const config = {
      host: getConfigValue('db.host') ?? 'localhost',
      port: getConfigValue('db.port') ?? 5432,
      user: getConfigValue('db.user') ?? 'verinode',
      password: getConfigValue('db.password') ?? '',
      database: getConfigValue('db.database') ?? 'verinode',
      maxConnections: getConfigValue('db.maxConnections') ?? 20,
      idleTimeoutMs: getConfigValue('db.idleTimeoutMs') ?? 30000,
      connectionTimeoutMs: getConfigValue('db.connectionTimeoutMs') ?? 10000,
    };
    POOL = new Database(config);
  }
  return POOL;
}

// Optional: Reconnect on database config changes
let dbSubscriptionId: string | null = null;

export function initializePool(): Database {
  const pool = getPool();
  
  dbSubscriptionId = onConfigChange((oldConfig, newConfig) => {
    if (
      oldConfig.db?.host !== newConfig.db?.host ||
      oldConfig.db?.port !== newConfig.db?.port
    ) {
      // Database changed - would need to restart pool
      console.log('[Database] Database config changed - restart required');
    }
  });
  
  return pool;
}

export function cleanupPool(): void {
  if (dbSubscriptionId) {
    offConfigChange(dbSubscriptionId);
    dbSubscriptionId = null;
  }
}
```

### mTLS Module

**Before:**
```typescript
// src/security/mtls.ts
export function mtlsConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MtlsConfig {
  return {
    enabled: env.VERINODE_MTLS_ENABLED === 'true' || env.VERINODE_MTLS_ENABLED === '1',
    certFile: env.VERINODE_MTLS_CERT_FILE,
    ...
  };
}
```

**After:**
```typescript
// src/security/mtls.ts
import { getConfigValue, onChangePath } from '../config';

export function getMtlsConfig(): MtlsConfig {
  return {
    enabled: getConfigValue('mtls.enabled') ?? false,
    certFile: getConfigValue('mtls.certFile'),
    keyFile: getConfigValue('mtls.keyFile'),
    caFile: getConfigValue('mtls.caFile'),
    trustDomain: getConfigValue('mtls.trustDomain') ?? 'cluster.local',
    allowedSpiffeIds: getConfigValue('mtls.allowedSpiffeIds') ?? [],
    certMaxValidityMs: getConfigValue('mtls.certMaxValidityMs') ?? 86400000,
    minSecondsUntilExpiry: getConfigValue('mtls.minSecondsUntilExpiry') ?? 3600,
    reloadPollMs: getConfigValue('mtls.reloadPollMs') ?? 30000,
  };
}

export function createMtlsManagerFromConfig(): MtlsCertificateManager {
  return new MtlsCertificateManager(getMtlsConfig());
}

// Listen for certificate path changes
onChangePath('mtls.certFile', (newPath) => {
  console.log('[mTLS] Certificate path changed to', newPath);
  // Trigger reload if needed
});
```

### Application Entry Point

**Updated index.js with config initialization:**
```javascript
// index.js
const { initConfig, getConfig } = require('./dist/config');

async function bootstrap() {
  // Initialize config before other modules
  await initConfig({
    configFile: './config.json',
    watchFiles: ['./config.json'],
  });

  console.log('Config loaded:', JSON.stringify(getConfig(), null, 2));

  // Load tracing after config
  const tracing = require('./dist/diagnostics/tracer');
  tracing.initTracing();

  // Load other modules...
}

// Handle SIGHUP for hot reload
process.on('SIGHUP', async () => {
  const { reloadConfig } = require('./dist/config');
  console.log('[index] Reloading configuration...');
  await reloadConfig();
  console.log('[index] Configuration reloaded');
});

bootstrap().catch(console.error);
```

## Configuration Sources Priority

1. **Environment variables** (highest priority)
   - Format: `VERINODE_DB_HOST` → `db.host`
   - Format: `VERINODE_APP_LOG_LEVEL` → `app.logLevel`

2. **Config file** (`config.json`)
   - JSON file with full configuration structure

3. **Remote sources** (etcd/consul)
   - Disabled by default
   - Enable with `loadRemote: true`

4. **Default values** (lowest priority)
   - Defined in `ConfigManager.initialize()`

## Migration Steps

1. **Initialize config early** in your application startup
2. **Replace direct `process.env` access** with `getConfigValue()`
3. **Add change subscriptions** for runtime config updates
4. **Add SIGHUP handler** for hot reload capability
5. **Update tests** to use the new config system

## Testing

```typescript
// test-config.js
const { initConfig, getConfig, reloadConfig } = require('./src/config');

// Test 1: Basic config loading
async function testBasic() {
  await initConfig({ configFile: './config.json' });
  const config = getConfig();
  console.log('Database host:', config.db.host);
}

// Test 2: Environment override
process.env.VERINODE_DB_HOST = 'test-db.example.com';

// Test 3: Hot reload
await reloadConfig();
console.log('Reloaded successfully');
```

## Troubleshooting

### Config not loading
- Check file path and permissions
- Verify JSON syntax in config file
- Check environment variable prefixes

### Schema validation errors
- Review error messages for specific fields
- Check type constraints (minimum/maximum values)
- Ensure required fields are present

### Hot reload not working
- Verify file watcher is configured
- Check that `triggerReload()` is called
- Review debounce timing (< 1s)
