import * as fs from 'fs';
import * as path from 'path';
import { ConfigValidator, mergeConfigs } from './validator';
import { deepMerge } from './utils';
import { mainSchema } from './schema';

/**
 * Configuration sources with priority (lower index = higher priority)
 */
export interface ConfigSource {
  priority: number;
  load: () => Promise<Record<string, any>>;
  name: string;
}

/**
 * Configuration loader with support for multiple sources
 */
export class ConfigLoader {
  private sources: ConfigSource[] = [];
  private validator: ConfigValidator;
  private cache: Record<string, any> | null = null;

  constructor(schema?: any) {
    this.validator = new ConfigValidator(schema);
  }

  /**
   * Add a configuration source
   */
  addSource(source: ConfigSource): this {
    // Insert in priority order
    const index = this.sources.findIndex(s => s.priority > source.priority);
    if (index === -1) {
      this.sources.push(source);
    } else {
      this.sources.splice(index, 0, source);
    }
    this.cache = null;
    return this;
  }

  /**
   * Add environment source
   */
  addEnvironmentSource(prefix = 'VERINODE'): this {
    return this.addSource({
      priority: 10,
      name: 'environment',
      load: () => this.loadEnvironment(prefix),
    });
  }

  /**
   * Load environment variables into config format
   */
  private loadEnvironment(prefix: string): Promise<Record<string, any>> {
    const result: Record<string, any> = {};

    for (const [key, value] of Object.entries(process.env)) {
      if (key.startsWith(prefix + '_')) {
        const configKey = key.substring(prefix.length + 1).toLowerCase();
        setIn(result, configKey, value);
      }
    }

    return Promise.resolve(result);
  }

  /**
   * Add file source
   */
  addFileSource(filePath: string): this {
    return this.addSource({
      priority: 20,
      name: `file:${filePath}`,
      load: () => this.loadFile(filePath),
    });
  }

  /**
   * Load configuration from JSON file
   */
  private async loadFile(filePath: string): Promise<Record<string, any>> {
    try {
      const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
      const content = fs.readFileSync(absolutePath, 'utf8');
      return JSON.parse(content);
    } catch (err) {
      // File might not exist, which is OK for optional sources
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }
      throw new Error(`Failed to load config file ${filePath}: ${(err as Error).message}`);
    }
  }

  /**
   * Add remote source (placeholder for etcd/consul)
   */
  addRemoteSource(type: 'etcd' | 'consul', options?: any): this {
    return this.addSource({
      priority: 30,
      name: `remote:${type}`,
      load: () => this.loadRemote(type, options),
    });
  }

  /**
   * Load configuration from remote source
   * This is a placeholder - implement actual remote source integration here
   */
  private async loadRemote(type: 'etcd' | 'consul', options?: any): Promise<Record<string, any>> {
    // Placeholder implementation
    // In production, this would connect to etcd or consul and fetch config
    console.log(`[Config] Remote source ${type} not implemented - using defaults`);
    return {};
  }

  /**
   * Add default values source
   */
  addDefaultsSource(defaults: Record<string, any>): this {
    return this.addSource({
      priority: 100,
      name: 'defaults',
      load: () => Promise.resolve(defaults),
    });
  }

  /**
   * Load and merge all configuration sources
   */
  async load(): Promise<Record<string, any>> {
    if (this.cache) {
      return this.cache;
    }

    const configs: Record<string, any>[] = [];
    const errors: Error[] = [];

    // Load all sources in priority order (lowest priority first)
    for (const source of this.sources.sort((a, b) => a.priority - b.priority)) {
      try {
        const config = await source.load();
        if (Object.keys(config).length > 0) {
          configs.push(config);
          console.log(`[Config] Loaded ${source.name} source`);
        }
      } catch (err) {
        errors.push(err as Error);
        console.warn(`[Config] Failed to load ${source.name}: ${(err as Error).message}`);
      }
    }

    // Merge configs with priority (later = higher priority)
    const merged = mergeConfigs(...configs.reverse());

    // Validate
    const result = this.validator.validate(merged);

    if (!result.valid) {
      const errorMessages = result.errors.map(e => `${e.path}: ${e.message}`).join('; ');
      throw new Error(`Configuration validation failed: ${errorMessages}`);
    }

    this.cache = result.data;
    return this.cache!;
  }

  /**
   * Get current configuration (loads if not cached)
   */
  async get(): Promise<Record<string, any>> {
    if (!this.cache) {
      await this.load();
    }
    return this.cache!;
  }

  /**
   * Clear cache to force reload
   */
  clearCache(): void {
    this.cache = null;
  }

  /**
   * Get sources for debugging
   */
  getSources(): ConfigSource[] {
    return [...this.sources];
  }
}

/**
 * Set nested property in object
 */
function setIn(obj: any, path: string | string[], value: any): any {
  const keys = Array.isArray(path) ? path : path.split('.');
  let current: any = obj;

  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (current[key] === undefined || current[key] === null) {
      current[key] = {};
    }
    current = current[key];
  }

  current[keys[keys.length - 1]] = value;
  return obj;
}
