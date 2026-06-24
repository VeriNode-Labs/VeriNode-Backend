import * as fs from 'fs';
import * as path from 'path';
import { ConfigLoader } from './loader';
import { ConfigValidator } from './validator';
import { deepClone, getIn, setIn, deleteIn } from './utils';
import { configEventBus } from './eventbus';
import { mainSchema } from './schema';

/**
 * Configuration change callback
 */
export type ConfigChangeCallback = (oldConfig: any, newConfig: any) => void;

/**
 * Watched file information
 */
export interface WatchedFile {
  path: string;
  interval: NodeJS.Timeout | null;
  lastModified: number;
}

/**
 * Centralized configuration manager
 */
export class ConfigManager {
  private loader: ConfigLoader;
  private validator: ConfigValidator;
  private config: any = null;
  private watchedFiles: WatchedFile[] = [];
  private changeCallbacks: Map<string, ConfigChangeCallback> = new Map();
  private reloadInProgress = false;
  private reloadDebounceMs = 100; // 100ms debounce for < 1s propagation
  private sighupRegistered = false;

  constructor(schema: any = mainSchema) {
    this.validator = new ConfigValidator(schema);
    this.loader = new ConfigLoader(schema);
  }

  /**
   * Register SIGHUP signal listener for reload
   */
  private registerSignalHandlers(): void {
    try {
      process.on('SIGHUP', () => {
        console.log('[Config] SIGHUP received, triggering reload');
        this.triggerReload();
      });
    } catch (err) {
      console.warn('[Config] Failed to register SIGHUP handler:', (err as Error).message);
    }
  }

  /**
   * Initialize configuration manager with default sources
   */
  async initialize(options?: {
    configFile?: string;
    watchFiles?: string[];
    loadRemote?: boolean;
  }): Promise<void> {
    // Add default sources
    this.loader.addDefaultsSource({
      db: {
        host: 'localhost',
        port: 5432,
        user: 'verinode',
        password: '',
        database: 'verinode',
        maxConnections: 20,
        idleTimeoutMs: 30000,
        connectionTimeoutMs: 10000,
      },
      mtls: {
        enabled: false,
        trustDomain: 'cluster.local',
        allowedSpiffeIds: [],
        certMaxValidityMs: 86400000,
        minSecondsUntilExpiry: 3600,
        reloadPollMs: 30000,
      },
      tls: {
        acme: {
          enabled: false,
          domains: [],
          email: '',
          directoryUrl: 'https://acme-v02.api.letsencrypt.org/directory',
          termsOfServiceAgreed: false,
          renewBeforeDays: 30,
          emergencyNotifyDays: 7,
          checkIntervalMs: 86400000,
        },
        certPath: '',
        keyPath: '',
        chainPath: '',
        webroot: '/tmp/verinode-acme',
      },
      telemetry: {
        otel: {
          enabled: true,
          endpoint: 'http://localhost:4317',
          serviceName: 'verinode-backend',
          samplingRatio: 1.0,
        },
      },
      app: {
        port: 3000,
        environment: 'development',
        logLevel: 'info',
      },
      staking: {
        maxConcurrentWorkers: 10,
        nonceRangeLimit: '1000',
      },
      remote: {
        etcd: {
          enabled: false,
          endpoints: ['http://localhost:2379'],
          keyPrefix: 'verinode/config',
          watchIntervalMs: 10000,
        },
        consul: {
          enabled: false,
          address: '',
          keyPrefix: 'verinode/config',
          watchIntervalMs: 10000,
        },
      },
    });

    this.loader.addEnvironmentSource();

    if (options?.configFile) {
      this.loader.addFileSource(options.configFile);
    }

    // Set up file watching if specified
    if (options?.watchFiles) {
      for (const filePath of options.watchFiles) {
        this.watchFile(filePath);
      }
    }

    if (!this.sighupRegistered) {
      this.registerSignalHandlers();
      this.sighupRegistered = true;
    }

    // Load initial configuration
    await this.reload();

    // Dynamically load remote configurations if enabled
    if (options?.loadRemote) {
      let remoteAdded = false;
      const remote = this.getIn('remote') || {};
      if (remote.etcd?.enabled) {
        this.loader.addRemoteSource('etcd', remote.etcd);
        remoteAdded = true;
      }
      if (remote.consul?.enabled) {
        this.loader.addRemoteSource('consul', remote.consul);
        remoteAdded = true;
      }
      if (remoteAdded) {
        await this.reload();
      }
    }
  }

  /**
   * Watch a configuration file for changes
   */
  watchFile(filePath: string): void {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
    const lastModified = stat?.mtimeMs ?? Date.now();

    this.watchedFiles.push({
      path: absolutePath,
      interval: null,
      lastModified,
    });

    // Start polling for changes - 250ms for near-instant hot-reload
    const interval = setInterval(() => this.checkFileChanges(), 250);
    interval.unref?.();
    
    const watched = this.watchedFiles.find(f => f.path === absolutePath);
    if (watched) {
      watched.interval = interval;
    }

    console.log(`[Config] Watching ${absolutePath} for changes`);
  }

  /**
   * Check all watched files for modifications
   */
  private checkFileChanges(): void {
    for (const watched of this.watchedFiles) {
      try {
        const stat = fs.statSync(watched.path, { throwIfNoEntry: false });
        if (stat && stat.mtimeMs > watched.lastModified) {
          console.log(`[Config] File changed: ${watched.path}`);
          watched.lastModified = stat.mtimeMs;
          this.triggerReload();
        }
      } catch {
        // File might have been deleted
      }
    }
  }

  /**
   * Trigger configuration reload with debounce
   */
  triggerReload(): void {
    if (this.reloadInProgress) {
      return;
    }

    this.reloadInProgress = true;
    configEventBus.emitEvent('reload_initiated');

    // Debounce reloads
    setTimeout(async () => {
      try {
        await this.reload();
        configEventBus.emitEvent('reload_complete', this.config);
      } catch (err) {
        configEventBus.emitEvent('error', null, err as Error);
        console.error('[Config] Reload failed:', (err as Error).message);
      } finally {
        this.reloadInProgress = false;
      }
    }, this.reloadDebounceMs);
  }

  /**
   * Reload configuration from all sources
   */
  async reload(): Promise<void> {
    const oldConfig = deepClone(this.config);
    
    this.loader.clearCache();
    const newConfig = await this.loader.load();
    
    this.config = newConfig;
    
    configEventBus.emitEvent('updated', this.config);
    configEventBus.emitEvent('loaded', this.config);

    // Notify change listeners
    for (const [id, callback] of this.changeCallbacks) {
      try {
        callback(oldConfig, this.config);
      } catch (err) {
        console.error(`[Config] Error in change callback ${id}:`, (err as Error).message);
      }
    }

    console.log('[Config] Configuration reloaded successfully');
  }

  /**
   * Get current configuration
   */
  get(): any {
    if (!this.config) {
      throw new Error('Config not initialized. Call initialize() first.');
    }
    return this.config;
  }

  /**
   * Get nested configuration value
   */
  getIn(path: string | string[]): any {
    return getIn(this.config, path);
  }

  /**
   * Update a configuration value (hot update)
   */
  update(path: string | string[], value: any): void {
    const oldConfig = deepClone(this.config);
    const newConfig = deepClone(this.config);
    setIn(newConfig, path, value);

    const validationResult = this.validator.validate(newConfig);
    if (!validationResult.valid) {
      const errorMessages = validationResult.errors.map(e => `${e.path}: ${e.message}`).join('; ');
      throw new Error(`Configuration validation failed: ${errorMessages}`);
    }

    this.config = validationResult.data;
    configEventBus.emitEvent('updated', this.config);
    
    // Notify change listeners
    for (const [id, callback] of this.changeCallbacks) {
      try {
        callback(oldConfig, this.config);
      } catch (err) {
        console.error(`[Config] Error in change callback ${id}:`, (err as Error).message);
      }
    }
  }

  /**
   * Delete a configuration value
   */
  delete(path: string | string[]): boolean {
    const oldConfig = deepClone(this.config);
    const newConfig = deepClone(this.config);
    const result = deleteIn(newConfig, path);
    if (!result) {
      return false;
    }

    const validationResult = this.validator.validate(newConfig);
    if (!validationResult.valid) {
      const errorMessages = validationResult.errors.map(e => `${e.path}: ${e.message}`).join('; ');
      throw new Error(`Configuration validation failed: ${errorMessages}`);
    }

    this.config = validationResult.data;
    configEventBus.emitEvent('updated', this.config);

    // Notify change listeners
    for (const [id, callback] of this.changeCallbacks) {
      try {
        callback(oldConfig, this.config);
      } catch (err) {
        console.error(`[Config] Error in change callback ${id}:`, (err as Error).message);
      }
    }
    return true;
  }

  /**
   * Subscribe to configuration changes
   */
  onChange(callback: ConfigChangeCallback, id?: string): string {
    const changeId = id || `cb_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    this.changeCallbacks.set(changeId, callback);
    return changeId;
  }

  /**
   * Unsubscribe from configuration changes
   */
  offChange(id: string): void {
    this.changeCallbacks.delete(id);
  }

  /**
   * Subscribe to specific path changes
   */
  onChangePath(path: string, callback: (value: any) => void, id?: string): string {
    const fullId = this.onChange((oldConfig, newConfig) => {
      const oldValue = getIn(oldConfig, path);
      const newValue = getIn(newConfig, path);
      
      if (oldValue !== newValue) {
        callback(newValue);
      }
    }, id);
    return fullId;
  }

  /**
   * Get configuration validator for external use
   */
  getValidator(): ConfigValidator {
    return this.validator;
  }

  /**
   * Get watched files for debugging
   */
  getWatchedFiles(): WatchedFile[] {
    return [...this.watchedFiles];
  }

  /**
   * Cleanup resources
   */
  cleanup(): void {
    for (const watched of this.watchedFiles) {
      if (watched.interval) {
        clearInterval(watched.interval);
      }
    }
    this.watchedFiles = [];
  }
}

/**
 * Create singleton config manager
 */
let singleton: ConfigManager | null = null;

export function getConfigManager(schema?: any): ConfigManager {
  if (!singleton) {
    singleton = new ConfigManager(schema);
  }
  return singleton;
}
